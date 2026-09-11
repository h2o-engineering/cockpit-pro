/* H2O Studio — P01 writer-generation gate.
 *
 * One durable fact decides which writer generation owns this installation's
 * data. Before the governed standdown it is P01; after it, P02, and every P01
 * path that can MUTATE must refuse.
 *
 * This installs the single predicate those paths call. It is a classic IIFE
 * because the P01 writers are: they live on the H2O global and cannot import.
 * `packages/core/sync-writer-generation-v2.mjs` is the contract, and the T19
 * validator pins this restatement against it over shared vectors so the two
 * cannot drift.
 *
 * THE FOUR OBSERVATIONS ARE NOT THREE, and the distinction is the whole point:
 *
 *   POSITIVELY OBSERVED ABSENT - the store answered and there is nothing there.
 *   That is the pre-standdown world, and P01 must behave exactly as it does
 *   today. Standing P01 down merely because this new read exists would break
 *   the accepted product.
 *
 *   UNOBSERVABLE - the store did not answer. We do not know who owns the data.
 *   Treating that as absent would let a transient storage failure re-authorize
 *   P01 writes into a repository P02 may already own, which is the single
 *   outcome the standdown exists to prevent. It fails closed.
 *
 * EACH PLATFORM OBSERVES ITS OWN RECORD, through its own read path. Chrome uses
 * chrome.storage.local; Desktop goes straight to kv_store rather than through
 * the chrome.storage shim, because that shim ends its SELECT with a catch that
 * returns {} - which would make a failed query indistinguishable from an empty
 * table, and an empty table RE-AUTHORIZES P01. One platform's readable store
 * can never authorize the other platform's writes.
 *
 * NOTHING HERE WRITES. The ceremony write belongs to a future governed
 * standdown; a gate that cannot write cannot perform one by accident.
 */
(function (global) {
  'use strict';

  var H2O = global.H2O = global.H2O || {};
  H2O.Studio = H2O.Studio || {};
  H2O.Studio.sync = H2O.Studio.sync || {};
  if (H2O.Studio.sync.writerGeneration) return;

  var KEY = 'h2o:studio:sync:writer-generation:v1';
  var SCHEMA_VERSION = 1;
  var P01 = 'p01';
  var P02 = 'p02';

  var STATE = Object.freeze({
    ABSENT_OBSERVED: 'absent-observed',
    RECORDED: 'recorded',
    MALFORMED: 'malformed',
    UNOBSERVED: 'unobserved'
  });
  var REASON = Object.freeze({
    STOOD_DOWN: 'p01-writer-stood-down',
    MALFORMED: 'generation-record-malformed',
    UNOBSERVED: 'generation-unobserved'
  });

  function clean(value) { return String(value == null ? '' : value).trim(); }
  function isObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
  }

  var SQLITE_DB_URL = 'sqlite:studio-v1.db';

  function isTauri() {
    try { return !!(global.__TAURI_INTERNALS__ || global.__TAURI__); }
    catch (_) { return false; }
  }

  function tauriInvoke() {
    try {
      var internals = global.__TAURI_INTERNALS__;
      if (internals && typeof internals.invoke === 'function') return internals.invoke;
      var legacy = global.__TAURI__;
      if (legacy && legacy.core && typeof legacy.core.invoke === 'function') {
        return legacy.core.invoke;
      }
      if (legacy && typeof legacy.invoke === 'function') return legacy.invoke;
    } catch (_) { /* fall through */ }
    return null;
  }

  function storageArea() {
    try {
      return global.chrome && global.chrome.storage && global.chrome.storage.local;
    } catch (_) {
      return null;
    }
  }

  /*
   * Read the raw value, distinguishing "no record" from "could not read". A
   * rejected promise, a thrown call, or a runtime.lastError all mean we did not
   * observe - never that there is nothing there.
   *
   * Desktop reads kv_store DIRECTLY rather than through the chrome.storage
   * shim, and the reason is the whole contract.
   *
   * The shim ends its SELECT with `.catch(function () { return {}; })`, so a
   * failed query is indistinguishable from an empty table. Reading the
   * generation through it would turn every transient SQL failure into a proven
   * absence, and a proven absence RE-AUTHORIZES P01 - the exact fail-open this
   * gate exists to prevent. Going straight to the plugin lets a rejection stay
   * a rejection, which becomes `unobserved`, which refuses.
   */
  function readRawDesktop(invoke) {
    return invoke('plugin:sql|select', {
      db: SQLITE_DB_URL,
      query: 'SELECT value FROM kv_store WHERE key = ? LIMIT 1',
      values: [KEY]
    }).then(function (rows) {
      var list = Array.isArray(rows) ? rows : [];
      if (list.length === 0) return null;
      var raw = list[0] && list[0].value;
      return raw == null ? null : raw;
    }, function () {
      /* Deliberately NOT an empty result. */
      throw new Error(REASON.UNOBSERVED);
    });
  }

  function readRaw() {
    if (isTauri()) {
      var invoke = tauriInvoke();
      /* A Tauri runtime with no invoke seam cannot be observed at all. */
      if (!invoke) return Promise.reject(new Error(REASON.UNOBSERVED));
      return readRawDesktop(invoke);
    }
    var area = storageArea();
    if (!area || typeof area.get !== 'function') {
      /* No store at all is not an empty store. */
      return Promise.reject(new Error(REASON.UNOBSERVED));
    }
    return new Promise(function (resolve, reject) {
      var settled = false;
      function settle(rows) {
        if (settled) return;
        settled = true;
        var lastError = global.chrome && global.chrome.runtime &&
          global.chrome.runtime.lastError;
        if (lastError) { reject(new Error(REASON.UNOBSERVED)); return; }
        var value = isObject(rows) ? rows[KEY] : undefined;
        resolve(value === undefined ? null : value);
      }
      var returned;
      try { returned = area.get([KEY], settle); }
      catch (_) { reject(new Error(REASON.UNOBSERVED)); return; }
      if (returned && typeof returned.then === 'function') {
        returned.then(settle, function () { reject(new Error(REASON.UNOBSERVED)); });
      }
    });
  }

  /* A partially-valid record is malformed. Acting on half a record is acting
   * on a guess, and the guess would be in the dangerous direction. */
  function parseRecord(raw) {
    var record = raw;
    if (typeof raw === 'string') {
      try { record = JSON.parse(raw); } catch (_) { return null; }
    }
    if (!isObject(record)) return null;
    if (record.schemaVersion !== SCHEMA_VERSION) return null;
    var generation = clean(record.generation);
    if (generation !== P01 && generation !== P02) return null;
    if (generation === P02) {
      /* A p02 record is a standdown DECISION; without provenance it is not one
       * anybody can audit, and standing P01 down on it would be hearsay. */
      var at = clean(record.standdownAt);
      if (!at || !isFinite(Date.parse(at))) return null;
      if (!clean(record.decidedByWriterSyncPeerId)) return null;
      if (!clean(record.reason)) return null;
    }
    return {
      schemaVersion: record.schemaVersion,
      generation: generation,
      standdownAt: clean(record.standdownAt) || null,
      decidedByWriterSyncPeerId: clean(record.decidedByWriterSyncPeerId) || null,
      reason: clean(record.reason) || null
    };
  }

  async function observe() {
    var raw;
    try {
      raw = await readRaw();
    } catch (_) {
      return { state: STATE.UNOBSERVED, generation: null, record: null,
        reason: REASON.UNOBSERVED };
    }
    if (raw === null || raw === undefined) {
      return { state: STATE.ABSENT_OBSERVED, generation: P01, record: null, reason: null };
    }
    var record = parseRecord(raw);
    if (!record) {
      return { state: STATE.MALFORMED, generation: null, record: null,
        reason: REASON.MALFORMED };
    }
    return { state: STATE.RECORDED, generation: record.generation, record: record, reason: null };
  }

  /*
   * The predicate every P01 mutation seam calls. Only two observations permit:
   * a proven absence, and a well-formed record that says p01.
   */
  async function p01MayMutate() {
    return decideP01MayMutate(await observe());
  }

  /*
   * The predicate a P02 PUBLICATION writer calls. It asks a DIFFERENT question
   * from p01MayMutate - not "may the P01 writer mutate?" but "is this platform
   * the authorised writer for a P02 publication?" - and both answers are
   * derived from the one observation above, so there is no second authority
   * and no way for the two to drift apart.
   *
   *   recorded + p02   P01 has been stood down BY a p02 decision. That is
   *                    exactly the state in which the P02 publication writer
   *                    IS the authorised writer. This is the same predicate
   *                    the accepted Chrome P02 publication owner already
   *                    requires in requireP02LocalAuthority.
   *   absent-observed
   *   recorded + p01   the accepted pre-P02 position is unchanged: whatever
   *                    P01 mutation permits, publication permits.
   *   malformed
   *   unobserved       fail closed, exactly as before.
   *
   * p01MayMutate is NOT relaxed by this: P01 mutation stays stood down at
   * recorded/p02, and every P01 mutation seam keeps refusing there.
   */
  async function publicationMayProceed() {
    var observation = await observe();
    if (observation.state === STATE.RECORDED && observation.generation === P02) {
      return { permitted: true, reason: null, generation: P02,
        observationState: observation.state };
    }
    return decideP01MayMutate(observation);
  }

  function decideP01MayMutate(observation) {
    if (observation.state === STATE.ABSENT_OBSERVED) {
      return { permitted: true, reason: null, generation: P01,
        observationState: observation.state };
    }
    if (observation.state === STATE.RECORDED && observation.generation === P01) {
      return { permitted: true, reason: null, generation: P01,
        observationState: observation.state };
    }
    if (observation.state === STATE.RECORDED && observation.generation === P02) {
      return { permitted: false, reason: REASON.STOOD_DOWN, generation: P02,
        observationState: observation.state };
    }
    return {
      permitted: false,
      reason: observation.state === STATE.MALFORMED ? REASON.MALFORMED : REASON.UNOBSERVED,
      generation: null,
      observationState: observation.state
    };
  }

  /* Convenience for call sites that only need the boolean. Fails closed on any
   * error, so a seam that forgets to handle a rejection still refuses. */
  async function p01MayMutateBoolean() {
    try {
      var verdict = await p01MayMutate();
      return verdict.permitted === true;
    } catch (_) {
      return false;
    }
  }

  H2O.Studio.sync.writerGeneration = Object.freeze({
    schema: 'h2o.studio.syncWriterGeneration.v1',
    KEY: KEY,
    SCHEMA_VERSION: SCHEMA_VERSION,
    P01: P01,
    P02: P02,
    STATE: STATE,
    REASON: REASON,
    observe: observe,
    p01MayMutate: p01MayMutate,
    publicationMayProceed: publicationMayProceed,
    p01MayMutateBoolean: p01MayMutateBoolean,
    /* Test-only seam so a disposable suite can drive the four observations
     * without a real store. Never used by production code. */
    __test: Object.freeze({ parseRecord: parseRecord })
  });
}(typeof globalThis !== 'undefined' ? globalThis : this));
