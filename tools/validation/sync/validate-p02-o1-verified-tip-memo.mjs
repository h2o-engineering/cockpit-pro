#!/usr/bin/env node
/*
 * O1-T07 — Y-2 verified advertised-tip memo, DURABLE.
 *
 * The memo skips one thing: re-deriving a peer's advertised tip set from a
 * heads snapshot we have already verified. It never decides whether a tip is
 * done - admitted evidence decides that, and the caller supplies it on every
 * decision.
 *
 * Durability is what makes it worth having on a Chrome service worker that is
 * torn down constantly, and it is only SAFE because the memo is not authority.
 * So the tests below are organised around trying to make a durable record
 * suppress work it has no right to suppress: a tip that was never admitted, a
 * tip refused for capacity, a record from another snapshot, a corrupted
 * record, an unreadable store.
 *
 * Both platform ports run against their REAL substrate shape: the Desktop port
 * against the real v1 kv_store table executed by node:sqlite, and the Chrome
 * port against a chrome.storage.local-shaped area including its callback and
 * runtime.lastError conventions. Restart is modelled by discarding every
 * in-memory object and rebuilding the memo over the same durable store.
 *
 * Disposable: an in-memory SQLite database and an in-memory storage area per
 * run. No migration is added, no DATABASE_VERSION changes, no real profile, no
 * repository, no canonical state, no processes.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import {
  P02_TIP_MEMO_V2,
  P02_TIP_MEMO_VERDICT,
  createP02VerifiedTipMemo
} from '../../../packages/core/sync-p02-verified-tip-memo-v2.mjs';
import { stagePackedGraph } from './p02-dist-graph.mjs';
import {
  P02_CHROME_TIP_MEMO,
  createChromeTipMemoStore
} from '../../../packages/browser-adapters/chrome/sync-p02-tip-memo-chrome-v2.mjs';

let assertions = 0;
const failures = [];
const check = (condition, label) => {
  assertions += 1;
  if (condition !== true) failures.push(label);
};
const equal = (actual, expected, label) =>
  check(actual === expected, `${label} (expected ${String(expected)}, got ${String(actual)})`);

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

/*
 * The Desktop port imports its core as `../core/`, which resolves inside the
 * PACKED tree - the packer rewrites no specifiers, so a dist-relative import is
 * the only correct form. Staging the graph therefore also proves the port ships
 * correctly, which importing from source would not.
 */
const packed = stagePackedGraph();
const {
  P02_DESKTOP_TIP_MEMO,
  createDesktopTipMemoStore
} = await packed.importPacked('sync/sync-p02-tip-memo-desktop-v2.tauri.mjs');
const hex = (seed) => crypto.createHash('sha256').update(String(seed)).digest('hex');
const PEER = hex('peer');
const PEER_OTHER = hex('peer-other');
const OBJECT = hex('object');
const SNAP_A = hex('snapshot-a');
const SNAP_B = hex('snapshot-b');

const tip = (objectId, revisionId, blobSeed) => ({
  objectDomain: 'studio.chat.saved-state.v1',
  objectId,
  revisionId,
  revisionBlobSha256: hex(blobSeed)
});
const TIP_1 = tip('chat-1', 'p02-1111111111111111111111111111aaaa', 'b1');
const TIP_2 = tip('chat-1', 'p02-2222222222222222222222222222bbbb', 'b2');
const TIP_3 = tip('chat-1', 'p02-3333333333333333333333333333cccc', 'b3');

/* The real kv_store table, taken from the accepted migration ladder. */
function kvStoreSql() {
  const source = fs.readFileSync(
    path.join(root, 'apps/studio/desktop/src-tauri/src/lib.rs'), 'utf8'
  );
  const match = source.match(/version: 1,[\s\S]*?sql: "([\s\S]*?)",\s*\n\s*kind:/);
  assert.ok(match, 'Desktop migration v1 creates kv_store in the accepted ladder');
  assertions += 1;
  /* Rust string continuations: strip the escaped newlines the literal uses. */
  return match[1].replace(/\\\s*\n\s*/g, '').replace(/\\"/g, '"');
}

/* A durable Desktop substrate that outlives any memo object built over it. */
function desktopSubstrate() {
  const db = new DatabaseSync(':memory:');
  db.exec(kvStoreSql());
  let failReads = false;
  const store = createDesktopTipMemoStore({
    clock: () => 1756166400000,
    sql: {
      select: async (query, values) => {
        if (failReads) throw Object.assign(new Error('io'), { code: 'kv-read-failed' });
        return db.prepare(query).all(...(values ?? []));
      },
      execute: async (query, values) => db.prepare(query).run(...(values ?? []))
    }
  });
  return {
    db, store,
    denyReads: (on) => { failReads = on; },
    /* Restart: every in-memory object is discarded, the substrate is not. */
    remount: () => createP02VerifiedTipMemo({ store }),
    rows: () => db.prepare('SELECT key, value FROM kv_store ORDER BY key').all(),
    corrupt: (key, value) => db.prepare(
      'INSERT INTO kv_store (key, value, updated_at) VALUES (?,?,?) '
      + 'ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    ).run(key, value, 0)
  };
}

/* A chrome.storage.local-shaped area, callback conventions included. */
function chromeSubstrate() {
  const backing = new Map();
  let failReads = false;
  const area = {
    get(keys, callback) {
      const answer = () => {
        if (failReads) {
          globalThis.chrome = { runtime: { lastError: { message: 'quota' } } };
          callback({});
          globalThis.chrome = { runtime: {} };
          return;
        }
        const rows = {};
        for (const key of keys) if (backing.has(key)) rows[key] = backing.get(key);
        callback(rows);
      };
      answer();
    },
    set(items, callback) {
      for (const [key, value] of Object.entries(items)) backing.set(key, value);
      callback();
    }
  };
  globalThis.chrome = { runtime: {} };
  const store = createChromeTipMemoStore({ storageArea: area });
  return {
    backing, store,
    denyReads: (on) => { failReads = on; },
    remount: () => createP02VerifiedTipMemo({ store })
  };
}

const recordVerified = (memo, over = {}) => memo.record({
  peerWriterKey: PEER, objectKey: OBJECT, snapshotSha256: SNAP_A,
  tips: [TIP_1, TIP_2],
  writerStateVerified: true, headsSnapshotVerified: true, admissionBoundaryComplete: true,
  ...over
});
const ask = (memo, over = {}) => memo.decide({
  peerWriterKey: PEER, objectKey: OBJECT, snapshotSha256: SNAP_A, ...over
});

/* ===== 1. Write verified snapshot A -> restart -> memo A remains ===== */
{
  const desktop = desktopSubstrate();
  const first = desktop.remount();
  equal((await recordVerified(first)).recorded, true, 'D1-1 a verified snapshot is recorded');
  equal(desktop.rows().length, 1, 'D1-2 durably, as one kv_store row');
  equal(desktop.rows()[0].key, P02_TIP_MEMO_V2.keyFor(PEER, OBJECT),
    'D1-3 under a key binding both the peer and the object');
  check(desktop.rows()[0].key.startsWith('h2o:studio:sync:p02:y2:v1:'),
    'D1-4 namespaced so it cannot collide with another subsystem');

  /* Restart: the memo object is thrown away entirely. */
  const afterRestart = desktop.remount();
  const decision = await ask(afterRestart, {
    admittedRevisionIds: [TIP_1.revisionId, TIP_2.revisionId]
  });
  equal(decision.reuse, true, 'D1-5 the record survives a restart');
  equal(decision.advertisedTips.length, 2, 'D1-6 with the complete advertised set');
  equal(afterRestart.durable, true, 'D1-7 and the memo declares itself durable');

  /* The same on Chrome. */
  const chrome = chromeSubstrate();
  await recordVerified(chrome.remount());
  equal(chrome.backing.size, 1, 'D1-8 Chrome persists one chrome.storage.local entry');
  equal((await ask(chrome.remount(), {
    admittedRevisionIds: [TIP_1.revisionId, TIP_2.revisionId]
  })).reuse, true, 'D1-9 which also survives a worker teardown');
}

/* ===== 2. Same A, all tips admitted -> fast path permitted ===== */
{
  const desktop = desktopSubstrate();
  await recordVerified(desktop.remount());
  const decision = await ask(desktop.remount(), {
    admittedRevisionIds: [TIP_1.revisionId, TIP_2.revisionId]
  });
  equal(decision.fastPath, true, 'D2-1 with every advertised tip admitted, the fast path opens');
  equal(decision.verdict, P02_TIP_MEMO_VERDICT.REUSE_ADVERTISED_SET,
    'D2-2 named as reuse of the advertised set, not as convergence');
  equal(decision.pendingTips.length, 0, 'D2-3 nothing outstanding');
}

/* ===== 3. Same A, one advertised tip NOT admitted -> still processed ===== */
{
  const desktop = desktopSubstrate();
  await recordVerified(desktop.remount());
  const decision = await ask(desktop.remount(), {
    admittedRevisionIds: [TIP_1.revisionId]
  });
  equal(decision.reuse, true, 'D3-1 the advertised set is still reusable');
  equal(decision.fastPath, false, 'D3-2 but the fast path is NOT open');
  equal(decision.pendingTips.length, 1, 'D3-3 one tip is outstanding');
  equal(decision.pendingTips[0].revisionId, TIP_2.revisionId,
    'D3-4 the one admitted evidence does not cover');

  /* With no admitted evidence at all, everything is pending. */
  const none = await ask(desktop.remount(), { admittedRevisionIds: [] });
  equal(none.pendingTips.length, 2,
    'D3-5 omitting admitted evidence makes EVERY tip pending - the safe direction');
  equal(none.fastPath, false, 'D3-6 and never opens the fast path');
}

/* ===== 4. A capacity-refused tip is retried despite memo presence ===== */
{
  const desktop = desktopSubstrate();
  /* The record holds the COMPLETE advertised set regardless of what each tip's
   * admission decided - including one that V9 refused for capacity. */
  await desktop.remount().record({
    peerWriterKey: PEER, objectKey: OBJECT, snapshotSha256: SNAP_A,
    tips: [TIP_1, TIP_2, TIP_3],
    writerStateVerified: true, headsSnapshotVerified: true, admissionBoundaryComplete: true
  });
  /* TIP_3 was capacity-refused, so it is not in admitted evidence. */
  const decision = await ask(desktop.remount(), {
    admittedRevisionIds: [TIP_1.revisionId, TIP_2.revisionId]
  });
  equal(decision.advertisedTips.length, 3,
    'D4-1 the record holds the complete advertised set, refusals included');
  equal(decision.pendingTips.length, 1, 'D4-2 the capacity-refused tip is outstanding');
  equal(decision.pendingTips[0].revisionId, TIP_3.revisionId, 'D4-3 by name');
  equal(decision.fastPath, false,
    'D4-4 so a capacity refusal is retried rather than memoized away');
}

/* ===== 5. Snapshot B replaces A only after B verified + boundary complete ===== */
{
  const desktop = desktopSubstrate();
  await recordVerified(desktop.remount());
  const memo = desktop.remount();

  const partials = [
    [{ writerStateVerified: false }, 'writer-state-not-verified'],
    [{ headsSnapshotVerified: false }, 'heads-snapshot-not-verified'],
    [{ admissionBoundaryComplete: false }, 'admission-boundary-incomplete']
  ];
  for (const [over, reason] of partials) {
    const attempt = await memo.record({
      peerWriterKey: PEER, objectKey: OBJECT, snapshotSha256: SNAP_B,
      tips: [TIP_3], writerStateVerified: true, headsSnapshotVerified: true,
      admissionBoundaryComplete: true, ...over
    });
    equal(attempt.recorded, false, `D5-1 B is not recorded when ${reason}`);
    equal(attempt.reason, reason, `D5-2 stating ${reason}`);
  }
  /* A still stands, unchanged, after every refused write. */
  equal((await ask(desktop.remount(), { admittedRevisionIds: [] })).reuse, true,
    'D5-3 and A is still the record throughout');
  equal(desktop.rows().length, 1, 'D5-4 with no second row created');

  /* Once B is fully verified and its boundary complete, it replaces A. */
  await memo.record({
    peerWriterKey: PEER, objectKey: OBJECT, snapshotSha256: SNAP_B,
    tips: [TIP_3], writerStateVerified: true, headsSnapshotVerified: true,
    admissionBoundaryComplete: true
  });
  equal((await ask(desktop.remount())).verdict, P02_TIP_MEMO_VERDICT.SNAPSHOT_CHANGED,
    'D5-5 after which A is no longer the record');
  const forB = await desktop.remount().decide({
    peerWriterKey: PEER, objectKey: OBJECT, snapshotSha256: SNAP_B,
    admittedRevisionIds: [TIP_3.revisionId]
  });
  equal(forB.fastPath, true, 'D5-6 and B is');
  equal(desktop.rows().length, 1, 'D5-7 still exactly one row per (peer, object)');
}

/* ===== 6. A malformed record is processed normally ===== */
{
  const key = P02_TIP_MEMO_V2.keyFor(PEER, OBJECT);
  const good = {
    schema: P02_TIP_MEMO_V2.SCHEMA, peerWriterKey: PEER, objectKey: OBJECT,
    lastVerifiedSnapshotSha256: SNAP_A, tips: [TIP_1]
  };
  const corruptions = [
    ['not json at all', 'unparseable'],
    [JSON.stringify({ ...good, schema: 'someone.elses.v1' }), 'a foreign schema'],
    [JSON.stringify({ ...good, peerWriterKey: PEER_OTHER }), 'another peer\'s record at our key'],
    [JSON.stringify({ ...good, objectKey: hex('other') }), 'another object\'s record'],
    [JSON.stringify({ ...good, lastVerifiedSnapshotSha256: 'not-a-hash' }), 'a malformed hash'],
    [JSON.stringify({ ...good, tips: 'nope' }), 'tips that are not a list'],
    [JSON.stringify({ ...good, tips: [{ revisionId: 'p02-x' }] }), 'a tip with no blob']
  ];
  for (const [value, description] of corruptions) {
    const desktop = desktopSubstrate();
    desktop.corrupt(key, value);
    const decision = await ask(desktop.remount(), { admittedRevisionIds: [TIP_1.revisionId] });
    equal(decision.reuse, false, `D6 a record with ${description} is not reused`);
    equal(decision.verdict, P02_TIP_MEMO_VERDICT.RECORD_MALFORMED,
      `D6 and is reported as malformed (${description})`);
    equal(decision.fastPath, false, `D6 never opening the fast path (${description})`);
  }
  /* A partially-parseable tip list must not shrink the advertised set: one bad
   * tip refuses the WHOLE record, because under-reporting loses work. */
  const desktop = desktopSubstrate();
  desktop.corrupt(key, JSON.stringify({ ...good, tips: [TIP_1, { revisionId: 'p02-y' }] }));
  equal((await ask(desktop.remount())).advertisedTips.length, 0,
    'D6-8 a record with one unreadable tip yields NO advertised set, not a subset');
}

/* ===== 7. A missing record is processed normally ===== */
{
  const desktop = desktopSubstrate();
  const decision = await ask(desktop.remount(), { admittedRevisionIds: [TIP_1.revisionId] });
  equal(decision.reuse, false, 'D7-1 no record means no reuse');
  equal(decision.verdict, P02_TIP_MEMO_VERDICT.NO_RECORD, 'D7-2 reported as such');
  equal(decision.advertisedTips.length, 0,
    'D7-3 with no advertised set, so the caller re-derives it');
  equal(decision.fastPath, false, 'D7-4 and no fast path');
}

/* ===== 8. A store read failure is a typed safe fallback ===== */
{
  const desktop = desktopSubstrate();
  await recordVerified(desktop.remount());
  desktop.denyReads(true);
  const decision = await ask(desktop.remount(), {
    admittedRevisionIds: [TIP_1.revisionId, TIP_2.revisionId]
  });
  equal(decision.verdict, P02_TIP_MEMO_VERDICT.STORE_UNREADABLE,
    'D8-1 an unreadable store is typed distinctly');
  equal(decision.reuse, false, 'D8-2 no reuse');
  equal(decision.fastPath, false,
    'D8-3 and crucially NOT a fast path - a broken store never claims convergence');
  desktop.denyReads(false);
  equal((await ask(desktop.remount(), {
    admittedRevisionIds: [TIP_1.revisionId, TIP_2.revisionId]
  })).reuse, true, 'D8-4 and the record is intact once the store recovers');

  /* Chrome: runtime.lastError becomes a rejection, not a silent empty read. */
  const chrome = chromeSubstrate();
  await recordVerified(chrome.remount());
  chrome.denyReads(true);
  equal((await ask(chrome.remount())).verdict, P02_TIP_MEMO_VERDICT.STORE_UNREADABLE,
    'D8-5 a chrome.storage runtime.lastError is an unreadable store, not an absent one');
}

/* ===== 9. A crash before the write reprocesses ===== */
{
  const desktop = desktopSubstrate();
  const memo = desktop.remount();
  /* Verified and admitted, but the process dies before record() is reached. */
  equal(desktop.rows().length, 0, 'D9-1 nothing is written before the boundary');
  const afterCrash = desktop.remount();
  const decision = await ask(afterCrash, {
    admittedRevisionIds: [TIP_1.revisionId, TIP_2.revisionId]
  });
  equal(decision.verdict, P02_TIP_MEMO_VERDICT.NO_RECORD,
    'D9-2 so the next pass finds no record and reprocesses');
  equal(decision.fastPath, false, 'D9-3 costing one re-derivation and nothing else');

  /* A write failure is likewise never allowed to fail the operation. */
  const failing = createP02VerifiedTipMemo({
    store: {
      read: async () => null,
      write: async () => { throw Object.assign(new Error('full'), { code: 'quota-exceeded' }); }
    }
  });
  const attempt = await recordVerified(failing);
  equal(attempt.recorded, false, 'D9-4 a failed memo write reports failure');
  equal(attempt.reason, 'quota-exceeded', 'D9-5 with its typed cause');
  check(memo !== null, 'D9-6 and does not throw out of the publication that produced it');
}

/* ===== 10. Pointer becomes unreadable after A -> last verified A retained ===== */
{
  const desktop = desktopSubstrate();
  const memo = desktop.remount();
  await recordVerified(memo);

  /* The peer's pointer is now unreadable. That is evidence about the READ. */
  const posture = await memo.noteUnverifiedPointer({
    peerWriterKey: PEER, objectKey: OBJECT, reason: 'p02-z4-writer-identity-mismatch'
  });
  equal(posture.retainedLastVerified, true, 'D10-1 the last verified record is retained');
  equal(posture.cleared, false, 'D10-2 and explicitly not cleared');
  equal(posture.reason, 'p02-z4-writer-identity-mismatch',
    'D10-3 carrying the transport/integrity posture the receive contract needs');

  equal(desktop.rows().length, 1, 'D10-4 the durable row is still there');
  equal((await ask(desktop.remount(), {
    admittedRevisionIds: [TIP_1.revisionId, TIP_2.revisionId]
  })).reuse, true, 'D10-5 and still describes snapshot A');

  /* Unverified advertised data can never replace it: every write path demands
   * all three verifications, so there is no route by which a failed pointer
   * read could rewrite what we believe the peer published. */
  const unverified = await memo.record({
    peerWriterKey: PEER, objectKey: OBJECT, snapshotSha256: SNAP_B,
    tips: [TIP_3], writerStateVerified: false,
    headsSnapshotVerified: false, admissionBoundaryComplete: false
  });
  equal(unverified.recorded, false, 'D10-6 unverified advertised data is refused');
  equal((await ask(desktop.remount())).reuse, true,
    'D10-7 leaving the last VERIFIED record in place');
}

/* ===== 11 and 12. No new SQLite table, no Chrome DATABASE_VERSION bump ===== */
{
  const lib = fs.readFileSync(
    path.join(root, 'apps/studio/desktop/src-tauri/src/lib.rs'), 'utf8'
  );
  const versions = [...lib.matchAll(/version:\s*(\d+),/g)].map((m) => Number(m[1]));
  equal(Math.max(...versions), 22, 'D11-1 the migration ladder still tops out at v22');
  equal(P02_DESKTOP_TIP_MEMO.TABLE, 'kv_store',
    'D11-2 Y-2 rides in the generic kv_store created by migration v1');
  check(lib.includes('CREATE TABLE IF NOT EXISTS kv_store'),
    'D11-3 which the accepted ladder really creates');
  check(/y2|tip_memo|advertised_tip/i.test(lib) === false,
    'D11-4 and no Y-2-specific table was added to the ladder');

  const store = fs.readFileSync(
    path.join(root, 'packages/browser-adapters/chrome/sync-object-store.mjs'), 'utf8'
  );
  equal(store.match(/const DATABASE_VERSION = (\d+);/)?.[1], '4',
    'D12-1 the Chrome DATABASE_VERSION is unchanged at 4');
  equal(P02_CHROME_TIP_MEMO.SUBSTRATE, 'chrome.storage.local',
    'D12-2 because Chrome Y-2 rides in chrome.storage.local, not IndexedDB');
  equal((store.match(/database\.createObjectStore\(/g) || []).length, 6,
    'D12-3 and the six accepted object stores are unchanged');
}

/* ===== Not authority: the surface cannot express admission ===== */
{
  const desktop = desktopSubstrate();
  const memo = desktop.remount();
  await recordVerified(memo);
  const decision = await ask(memo, { admittedRevisionIds: [TIP_1.revisionId] });

  equal(Object.keys(decision).sort().join(','),
    'advertisedTips,fastPath,pendingTips,reuse,verdict',
    `A1 a decision offers reuse and pending work only (${Object.keys(decision).sort().join(',')})`);
  check(!('admit' in decision) && !('converged' in decision) && !('proven' in decision),
    'A2 and nothing an admission path could read as evidence');
  for (const forbidden of ['admit', 'ancestry', 'checkpoint', 'merge', 'resolve', 'remove', 'clear']) {
    equal(memo[forbidden], undefined, `A3 no ${forbidden} surface exists on the memo`);
  }
  /* There is deliberately no delete on either store port, so nothing can clear
   * a record - retention on failure is structural, not a rule to remember. */
  equal(desktop.store.remove, undefined, 'A4 the Desktop store port has no remove');
  equal(chromeSubstrate().store.remove, undefined, 'A5 nor does the Chrome port');

  /* A tip identity is the full pair: a squat is never an already-seen tip. */
  const squat = await ask(memo, { admittedRevisionIds: [TIP_1.revisionId, TIP_2.revisionId] });
  equal(squat.fastPath, true, 'A6 the honest pair opens the fast path');
  const wrongBlob = await desktop.remount().decide({
    peerWriterKey: PEER, objectKey: OBJECT, snapshotSha256: SNAP_A,
    admittedRevisionIds: [TIP_1.revisionId, TIP_2.revisionId]
  });
  equal(wrongBlob.advertisedTips[0].revisionBlobSha256, TIP_1.revisionBlobSha256,
    'A7 and the advertised set carries full pairs, not bare ids');
}

/* ===== The advertisedTipReader seam the enumerators already expect ===== */
{
  const desktop = desktopSubstrate();
  const memo = desktop.remount();
  await recordVerified(memo);

  const reader = memo.advertisedTipReader({
    snapshotSha256For: async (scope) => (scope.objectKey === OBJECT ? SNAP_A : null)
  });
  const tips = await reader({ peerWriterKey: PEER, objectKey: OBJECT });
  equal(tips.length, 2, 'S1 the reader seam returns the advertised set for a verified snapshot');
  equal(tips[0].revisionId, TIP_1.revisionId, 'S2 with full pairs');

  /* Unknown snapshot, unknown object, and a different peer all yield nothing -
   * never a guess and never another pair's data. */
  equal((await reader({ peerWriterKey: PEER, objectKey: hex('unknown') })).length, 0,
    'S3 an object with no resolvable snapshot yields nothing');
  const otherPeer = await reader({ peerWriterKey: PEER_OTHER, objectKey: OBJECT });
  equal(otherPeer.length, 0, 'S4 and another peer never sees this peer\'s advertised set');
}

packed.dispose();

const verdict = failures.length === 0
  ? 'P02_O1_VERIFIED_TIP_MEMO_PASS' : 'P02_O1_VERIFIED_TIP_MEMO_FAIL';
console.log(JSON.stringify({
  verdict, assertions, failures,
  storage: {
    durable: true,
    desktop: { substrate: P02_DESKTOP_TIP_MEMO.TABLE, migrationOrigin: 'v1', migrationsAdded: 0 },
    chrome: { substrate: P02_CHROME_TIP_MEMO.SUBSTRATE, databaseVersionBumped: false },
    keyNamespace: P02_TIP_MEMO_V2.KEY_PREFIX,
    rationale: 'the smallest EXISTING per-platform keyspace with no authority '
      + 'semantics, which does not require observation or admission records to exist'
  },
  authorityModel: 'admitted evidence decides what needs processing; the memo '
    + 'only replays the advertised set of an already-verified snapshot',
  requiredTests: [
    '1 write A, restart, memo A remains',
    '2 same A with all tips admitted permits the fast path',
    '3 same A with one tip unadmitted still processes it',
    '4 capacity-refused tip is retried despite memo presence',
    '5 B replaces A only after verification and boundary completion',
    '6 malformed record processes normally',
    '7 missing record processes normally',
    '8 store read failure is typed and never claims convergence',
    '9 crash before write reprocesses',
    '10 unreadable pointer retains the last verified record',
    '11 no new SQLite table',
    '12 no Chrome DATABASE_VERSION bump'
  ],
  realRepositoryTouched: false, canonicalStateTouched: false, processesLaunched: 0
}, null, 2));
process.exit(failures.length === 0 ? 0 : 1);
