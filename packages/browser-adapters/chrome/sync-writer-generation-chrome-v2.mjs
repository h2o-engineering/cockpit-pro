/*
 * O1-T19 — Chrome writer-generation store port.
 *
 * chrome.storage.local, for the same reason Y-2 uses it: it already exists, it
 * survives service-worker teardown, and it carries no authority semantics of
 * its own. The six P02 IndexedDB stores are all authority records and adding a
 * seventh would need a DATABASE_VERSION bump, which is not authorized.
 *
 * THE THREE OUTCOMES ARE DISTINGUISHED HERE, and nowhere else. `read` resolves
 * to the value, resolves to null for a proven absence, and REJECTS when the
 * store did not answer. A port that collapsed a failed read into null would
 * hand the gate an absence it never observed, and the gate would then
 * re-authorize P01 writes into a repository P02 may already own.
 *
 * The ordinary store port remains read-only. The one write capability in this
 * module belongs to the fixed-purpose standdown owner below; callers cannot
 * obtain a generic store writer or select a key/value to persist.
 */
import {
  P02_GENERATION_ERROR,
  P02_GENERATION_STATE,
  P02_WRITER_GENERATION,
  createP01MutationGate,
  p01MutationPermitted,
  readWriterGeneration
}
  from '../../core/sync-writer-generation-v2.mjs';
import { strictSyncIdentifier, writerKeyHex }
  from './sync-contract-v2.mjs';

export const P02_CHROME_GENERATION = Object.freeze({
  SCHEMA: 'h2o.studio.syncWriterGenerationChrome.v1',
  SUBSTRATE: 'chrome.storage.local',
  CONFIG_KEY: 'h2o:studio:sync:config:v1',
  IDENTITY_KEY: 'h2o:sync:peer-identity:v1',
  WRITE_LOCK_NAME: 'h2o:studio:sync:writer-generation:v1:write',
  STANDDOWN_REASON: 'human-authorized-p01-writer-standdown'
});

export const P02_CHROME_STANDDOWN = Object.freeze({
  SCHEMA: 'h2o.studio.syncP01WriterStanddown.v1',
  RESULT_SCHEMA: 'h2o.studio.syncP01WriterStanddownResult.v1',
  OUTCOME: Object.freeze({
    STOOD_DOWN: 'stood-down',
    ALREADY_STOOD_DOWN: 'already-stood-down',
    P01_NOT_QUIESCENT: 'p01-not-quiescent',
    CONFIGURED_PEER_AUTHORITY_INVALID: 'configured-peer-authority-invalid',
    GENERATION_STATE_INVALID: 'generation-state-invalid',
    SERIALIZATION_UNAVAILABLE: 'serialization-unavailable',
    PERSISTENCE_FAILED: 'persistence-failed',
    READBACK_MISMATCH: 'readback-mismatch'
  })
});

const isPlainObject = (value) =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/*
 * Exactly one invocation per call. MV3 honours the callback form alongside the
 * promise form, so passing a callback covers both; probing for a promise by
 * calling first without one would invoke a callback-only API with no callback.
 */
function promisify(area, method, args) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (value) => {
      if (settled) return;
      settled = true;
      const lastError = globalThis.chrome?.runtime?.lastError;
      if (lastError) {
        const error = new Error(lastError.message || 'chrome-storage-failed');
        error.code = 'generation-unobserved';
        reject(error);
        return;
      }
      resolve(value);
    };
    let returned;
    try { returned = area[method](...args, settle); }
    catch (error) { reject(error); return; }
    if (returned && typeof returned.then === 'function') returned.then(settle, reject);
  });
}

export function createChromeGenerationStore({ storageArea } = {}) {
  const area = storageArea ?? globalThis.chrome?.storage?.local ?? null;
  if (!isPlainObject(area) || typeof area.get !== 'function') {
    /* No store is not an empty store: refuse to construct rather than return a
     * port whose reads would look like proven absences. */
    throw new TypeError('p02-chrome-generation-store-invalid');
  }
  return Object.freeze({
    schema: P02_CHROME_GENERATION.SCHEMA,
    substrate: P02_CHROME_GENERATION.SUBSTRATE,
    async read(key) {
      const rows = await promisify(area, 'get', [[key]]);
      const value = isPlainObject(rows) ? rows[key] : undefined;
      return value === undefined ? null : value;
    }
  });
}

/* The gate a Chrome P01 mutation seam calls. Chrome observes CHROME's record;
 * one platform's readable store must never authorize the other's writes. */
export function createChromeP01MutationGate({ storageArea, seamName } = {}) {
  return createP01MutationGate({
    store: createChromeGenerationStore({ storageArea }), seamName
  });
}

const LOWER_HEX_64 = /^[0-9a-f]{64}$/;

function sameJsonValue(left, right) {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) ||
        left.length !== right.length) return false;
    return left.every((value, index) => sameJsonValue(value, right[index]));
  }
  if (!isPlainObject(left) || !isPlainObject(right)) return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  if (leftKeys.join(',') !== rightKeys.join(',')) return false;
  return leftKeys.every((key) => sameJsonValue(left[key], right[key]));
}

function fixedResult(outcome, details = {}) {
  const success = outcome === P02_CHROME_STANDDOWN.OUTCOME.STOOD_DOWN ||
    outcome === P02_CHROME_STANDDOWN.OUTCOME.ALREADY_STOOD_DOWN;
  return Object.freeze({
    schema: P02_CHROME_STANDDOWN.RESULT_SCHEMA,
    ok: success,
    outcome,
    storageWrites: 0,
    verified: false,
    ...details
  });
}

function storageAreaOrNull(storageArea) {
  return storageArea ?? globalThis.chrome?.storage?.local ?? null;
}

function lockManagerOrNull(lockManager) {
  return lockManager ?? globalThis.navigator?.locks ?? null;
}

async function readConfiguredDesktopAuthority({ area, cryptoImplementation }) {
  let rows;
  try {
    rows = await promisify(area, 'get', [[
      P02_CHROME_GENERATION.CONFIG_KEY,
      P02_CHROME_GENERATION.IDENTITY_KEY
    ]]);
  } catch (_) {
    throw new Error(
      P02_CHROME_STANDDOWN.OUTCOME.CONFIGURED_PEER_AUTHORITY_INVALID
    );
  }
  const config = isPlainObject(rows)
    ? rows[P02_CHROME_GENERATION.CONFIG_KEY] : null;
  const identity = isPlainObject(rows)
    ? rows[P02_CHROME_GENERATION.IDENTITY_KEY] : null;
  if (!isPlainObject(config) || config.schemaVersion !== 1 ||
      !['manual', 'notify'].includes(config.mode) ||
      !Array.isArray(config.configuredPeers) ||
      config.configuredPeers.length !== 1 ||
      !isPlainObject(identity) ||
      !strictSyncIdentifier(identity.syncPeerId)) {
    throw new Error(
      P02_CHROME_STANDDOWN.OUTCOME.CONFIGURED_PEER_AUTHORITY_INVALID
    );
  }
  const peer = config.configuredPeers[0];
  if (!isPlainObject(peer) ||
      Object.keys(peer).sort().join(',') !== 'syncPeerId,writerKey' ||
      !strictSyncIdentifier(peer.syncPeerId) ||
      peer.syncPeerId === identity.syncPeerId ||
      typeof peer.writerKey !== 'string' ||
      !LOWER_HEX_64.test(peer.writerKey)) {
    throw new Error(
      P02_CHROME_STANDDOWN.OUTCOME.CONFIGURED_PEER_AUTHORITY_INVALID
    );
  }
  let derived;
  try {
    derived = await writerKeyHex(peer.syncPeerId, cryptoImplementation);
  } catch (_) {
    throw new Error(
      P02_CHROME_STANDDOWN.OUTCOME.CONFIGURED_PEER_AUTHORITY_INVALID
    );
  }
  if (derived !== peer.writerKey) {
    throw new Error(
      P02_CHROME_STANDDOWN.OUTCOME.CONFIGURED_PEER_AUTHORITY_INVALID
    );
  }
  return Object.freeze({
    syncPeerId: peer.syncPeerId,
    writerKey: peer.writerKey
  });
}

function canonicalTimestamp(clock) {
  let value;
  try { value = clock(); } catch (_) { return null; }
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  const iso = date.toISOString();
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(iso)
    ? iso : null;
}

/*
 * The one canonical Chrome writer-generation mutation owner.
 *
 * It has no generic write API. A caller can request only the frozen
 * absent/effective-p01 -> recorded/p02 transition. Decision authority is read
 * from canonical config/identity storage inside the mutation boundary, and the
 * accepted cross-context admission owner supplies the preceding hold/drain.
 */
export function createChromeP01WriterStanddown({
  storageArea,
  lockManager,
  p01MutationAdmission,
  cryptoImplementation = globalThis.crypto,
  clock = () => new Date()
} = {}) {
  const area = storageAreaOrNull(storageArea);
  const locks = lockManagerOrNull(lockManager);
  const admission = p01MutationAdmission;
  const store = (() => {
    try { return createChromeGenerationStore({ storageArea: area }); }
    catch (_) { return null; }
  })();

  async function underGenerationWriteLock(callback) {
    if (!locks || typeof locks.request !== 'function') {
      return fixedResult(
        P02_CHROME_STANDDOWN.OUTCOME.SERIALIZATION_UNAVAILABLE
      );
    }
    try {
      return await locks.request(
        P02_CHROME_GENERATION.WRITE_LOCK_NAME,
        { mode: 'exclusive' },
        callback
      );
    } catch (_) {
      return fixedResult(
        P02_CHROME_STANDDOWN.OUTCOME.SERIALIZATION_UNAVAILABLE
      );
    }
  }

  async function mutateAfterDrain() {
    if (!store || !isPlainObject(area) ||
        typeof area.get !== 'function' || typeof area.set !== 'function') {
      return fixedResult(P02_CHROME_STANDDOWN.OUTCOME.PERSISTENCE_FAILED);
    }
    return underGenerationWriteLock(async () => {
      const before = await readWriterGeneration({ store });
      if (before.state === P02_GENERATION_STATE.RECORDED &&
          before.generation === P02_WRITER_GENERATION.P02) {
        const readback = await readWriterGeneration({ store });
        const verdict = p01MutationPermitted(readback);
        if (!sameJsonValue(readback.record, before.record) ||
            verdict.permitted !== false ||
            verdict.reason !== P02_GENERATION_ERROR.STOOD_DOWN) {
          return fixedResult(
            P02_CHROME_STANDDOWN.OUTCOME.READBACK_MISMATCH
          );
        }
        return fixedResult(
          P02_CHROME_STANDDOWN.OUTCOME.ALREADY_STOOD_DOWN,
          { verified: true, generation: P02_WRITER_GENERATION.P02,
            p01MayMutate: false }
        );
      }
      if (before.state !== P02_GENERATION_STATE.ABSENT_OBSERVED ||
          before.generation !== P02_WRITER_GENERATION.P01) {
        return fixedResult(
          P02_CHROME_STANDDOWN.OUTCOME.GENERATION_STATE_INVALID
        );
      }

      let authority;
      try {
        authority = await readConfiguredDesktopAuthority({
          area, cryptoImplementation
        });
      } catch (_) {
        return fixedResult(
          P02_CHROME_STANDDOWN.OUTCOME.CONFIGURED_PEER_AUTHORITY_INVALID
        );
      }
      const standdownAt = canonicalTimestamp(clock);
      if (!standdownAt) {
        return fixedResult(
          P02_CHROME_STANDDOWN.OUTCOME.GENERATION_STATE_INVALID
        );
      }
      const record = Object.freeze({
        schemaVersion: P02_WRITER_GENERATION.SCHEMA_VERSION,
        generation: P02_WRITER_GENERATION.P02,
        standdownAt,
        decidedByWriterSyncPeerId: authority.syncPeerId,
        reason: P02_CHROME_GENERATION.STANDDOWN_REASON
      });
      const candidate = await readWriterGeneration({
        store: { read: async () => record }
      });
      if (candidate.state !== P02_GENERATION_STATE.RECORDED ||
          candidate.generation !== P02_WRITER_GENERATION.P02 ||
          !sameJsonValue(candidate.record, record)) {
        return fixedResult(
          P02_CHROME_STANDDOWN.OUTCOME.GENERATION_STATE_INVALID
        );
      }

      const item = { [P02_WRITER_GENERATION.KEY]: record };
      try {
        await promisify(area, 'set', [item]);
      } catch (_) {
        return fixedResult(
          P02_CHROME_STANDDOWN.OUTCOME.PERSISTENCE_FAILED,
          { storageWrites: 1 }
        );
      }
      const readback = await readWriterGeneration({ store });
      const verdict = p01MutationPermitted(readback);
      if (!sameJsonValue(readback.record, record) ||
          readback.state !== P02_GENERATION_STATE.RECORDED ||
          readback.generation !== P02_WRITER_GENERATION.P02 ||
          verdict.permitted !== false ||
          verdict.reason !== P02_GENERATION_ERROR.STOOD_DOWN) {
        return fixedResult(
          P02_CHROME_STANDDOWN.OUTCOME.READBACK_MISMATCH,
          { storageWrites: 1 }
        );
      }
      return fixedResult(P02_CHROME_STANDDOWN.OUTCOME.STOOD_DOWN, {
        storageWrites: 1,
        verified: true,
        generation: P02_WRITER_GENERATION.P02,
        p01MayMutate: false
      });
    });
  }

  async function standDownP01Writer() {
    if (!admission || typeof admission.beginStanddownHold !== 'function') {
      return fixedResult(
        P02_CHROME_STANDDOWN.OUTCOME.P01_NOT_QUIESCENT
      );
    }
    let hold = null;
    try {
      hold = admission.beginStanddownHold();
      if (hold && typeof hold.then === 'function') hold = await hold;
      if (!hold || typeof hold.awaitDrained !== 'function' ||
          typeof hold.releaseStanddownHold !== 'function') {
        return fixedResult(
          P02_CHROME_STANDDOWN.OUTCOME.P01_NOT_QUIESCENT
        );
      }
      await hold.awaitDrained();
      return await mutateAfterDrain();
    } catch (error) {
      const code = String(error?.code || error?.message || '');
      return fixedResult(code.includes('serialization-unavailable')
        ? P02_CHROME_STANDDOWN.OUTCOME.SERIALIZATION_UNAVAILABLE
        : P02_CHROME_STANDDOWN.OUTCOME.P01_NOT_QUIESCENT);
    } finally {
      try { hold?.releaseStanddownHold?.(); } catch (_) { /* fail closed */ }
    }
  }

  return Object.freeze({
    schema: P02_CHROME_STANDDOWN.SCHEMA,
    standDownP01Writer
  });
}

export { P02_WRITER_GENERATION };
