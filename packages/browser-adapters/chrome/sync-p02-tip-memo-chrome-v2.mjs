/*
 * O1-T07 — Chrome durable store port for the Y-2 memo.
 *
 * WHY chrome.storage.local AND NOT THE SYNC IndexedDB.
 *
 * The P02 IndexedDB has six object stores at DATABASE_VERSION 4, and every one
 * of them is authority: authority, observations, local-publication-ledger,
 * admission-evidence, apply-state, branch-evidence. There is no generic
 * keyspace among them, and adding one would require a DATABASE_VERSION bump,
 * which is explicitly not authorized.
 *
 * Putting the memo inside an authority store would be worse than the bump
 * anyway. Every one of those stores is keyed by, or scoped to, records that
 * must EXIST - an observation, an admission, an apply state. The memo has to
 * be writable for a (peer, object) pair we hold no records for at all, because
 * it describes what a peer advertised, not what we admitted. A store that
 * requires admission records to exist cannot hold a memo about advertisements
 * we have not admitted, which is precisely the case the memo is for.
 *
 * chrome.storage.local is already used by this codebase's sync surfaces, is
 * durable across restarts and service-worker teardown, is a flat namespaced
 * keyspace with no semantics of its own, and requires no schema change. It is
 * the smallest existing substrate that satisfies every requirement.
 *
 * The MV3 caveat that matters: chrome.storage.local survives the service
 * worker being torn down, which an in-memory memo does not. That is the whole
 * reason durability was required here - a worker that is evicted every thirty
 * seconds would otherwise re-derive every advertised set on every wake.
 *
 * READ AND WRITE ONLY. No remove: a memo is superseded by the next verified
 * snapshot, and no failed read may clear one.
 */
import { P02_TIP_MEMO_V2, createP02VerifiedTipMemo }
  from '../../core/sync-p02-verified-tip-memo-v2.mjs';

export const P02_CHROME_TIP_MEMO = Object.freeze({
  SCHEMA: 'h2o.studio.syncP02TipMemoChrome.v1',
  SUBSTRATE: 'chrome.storage.local'
});

const isPlainObject = (value) =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/*
 * chrome.storage exposes both a callback form and, in MV3, a promise form.
 * Both are supported because a background worker and a page can reach this
 * module, and a runtime.lastError must become a rejection rather than a
 * silently-undefined result.
 */
function promisify(area, method, args) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (value) => {
      if (settled) return;
      settled = true;
      /* runtime.lastError must become a rejection. A callback that fires with
       * an empty result and a lastError set is a FAILED read, and reading it as
       * "absent" would turn a broken store into a claim about the repository. */
      const lastError = globalThis.chrome?.runtime?.lastError;
      if (lastError) {
        const error = new Error(lastError.message || 'chrome-storage-failed');
        error.code = 'p02-chrome-tip-memo-store-failed';
        reject(error);
        return;
      }
      resolve(value);
    };
    /*
     * Exactly ONE invocation. MV3 supports the promise form and still honours
     * the callback form, so passing a callback covers both - whereas probing
     * for a promise by calling first without one would invoke a callback-only
     * API with no callback, and would double-invoke a mutating method.
     */
    let returned;
    try {
      returned = area[method](...args, settle);
    } catch (error) {
      reject(error);
      return;
    }
    if (returned && typeof returned.then === 'function') {
      returned.then(settle, reject);
    }
  });
}

export function createChromeTipMemoStore({ storageArea } = {}) {
  const area = storageArea ?? globalThis.chrome?.storage?.local ?? null;
  if (!isPlainObject(area) || typeof area.get !== 'function' ||
      typeof area.set !== 'function') {
    throw new TypeError('p02-chrome-tip-memo-dependency-invalid');
  }
  return Object.freeze({
    schema: P02_CHROME_TIP_MEMO.SCHEMA,
    substrate: P02_CHROME_TIP_MEMO.SUBSTRATE,
    async read(key) {
      const rows = await promisify(area, 'get', [[key]]);
      const value = isPlainObject(rows) ? rows[key] : undefined;
      /* Absent is null, not an error. */
      return value === undefined ? null : value;
    },
    async write(key, value) {
      await promisify(area, 'set', [{ [key]: value }]);
    }
  });
}

export function createChromeVerifiedTipMemo({ storageArea } = {}) {
  return createP02VerifiedTipMemo({
    store: createChromeTipMemoStore({ storageArea })
  });
}

export { P02_TIP_MEMO_V2 };
