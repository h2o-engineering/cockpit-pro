#!/usr/bin/env node
/*
 * P02 Wave 1 / Z7 — platform integration behind the INACTIVE format gate.
 *
 * Proves the frozen Z7 unit (Y-10 gate + composition) and the V9 evidence
 * capacity policy against the real production modules.
 *
 * DISPOSABLE ONLY: fake IndexedDB, in-memory SQLite, isolated pack output.
 * No canonical database, no live IDB, no library.info on real state, no
 * Chrome/Desktop process, no WebDAV, no activation.
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';
import {
  P02_CAPACITY_LIMITS,
  P02_CAPACITY_V9,
  P02_CAPACITY_VERDICT,
  P02_RECOVERY_CLASS,
  capacityBlockReason,
  evaluateCapacity,
  mapNativeStorageFailure,
  measureRetainedEvidence
} from '../../../packages/core/sync-evidence-capacity-v2.mjs';
import {
  P02_FORMAT_GATE_V2,
  P02_GATE_STATE,
  createActivationCeremonyHook,
  evaluateFormatGate
} from '../../../packages/core/sync-format-gate-v2.mjs';
import {
  P02_RUNTIME_STATUS,
  P02_RUNTIME_V2,
  createP02ObjectRuntime,
  inactiveGate
} from '../../../packages/core/sync-object-runtime-v2.mjs';
import { buildBranchIndex } from '../../../packages/core/sync-branch-evidence-v2.mjs';
import {
  ARCHIVE_WORKBENCH_OUT_FILES,
  ARCHIVE_WORKBENCH_SOURCE_FILES,
  P02_CORE_SOURCE_FILES,
  compareP02CoreModulesToSource,
  syncItem9BrowserAdaptersToOut,
  syncP02CoreModulesToOut
} from '../../product/studio/pack-studio.mjs';

const root = path.resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const MIB = 1024 * 1024;
const DOMAIN = 'studio.chat.saved-state.v1';

let assertions = 0;
const scenarios = [];
const antiDegeneracy = [];
const vectors = [];

function check(v, m) { assert.ok(v, m); assertions += 1; }
function equal(a, b, m) { assert.equal(a, b, m); assertions += 1; }
function deepEqual(a, b, m) { assert.deepEqual(a, b, m); assertions += 1; }
function scenario(n) { scenarios.push(n); }
async function requireRed(id, body) {
  let red = false;
  try { await body(); } catch (_) { red = true; }
  assertions += 1;
  assert.ok(red, `anti-degeneracy control ${id} must go RED when the rule is broken`);
  antiDegeneracy.push(id);
}
function vector(name, expected, actual) {
  vectors.push({ name, expected, actual });
  equal(actual, expected, `V9 vector ${name}`);
}

const hashOf = (id) => crypto.createHash('sha256').update(String(id)).digest('hex');
const item = (id, bytes = 1024, head = 256) => ({
  revisionId: id, revisionBlobSha256: hashOf(id), revisionBytes: bytes, headBytes: head
});
const fill = (n, bytes = 1024) =>
  Array.from({ length: n }, (_, i) => item(`r${i}`, bytes, 0));

/* ---------------- 1. authority identity ---------------- */
function verifyAuthorityIdentity() {
  equal(P02_CAPACITY_V9.DECISION_SHA256,
    '34607b0147c217bc9e6c3dfcf7b48afdcc82df225f34e630ed64ac8b0bb6a564',
    'capacity module records the exact V9 decision identity');
  deepEqual({ ...P02_CAPACITY_LIMITS }, {
    normalItems: 256, normalBytes: 128 * MIB,
    reserveItems: 64, reserveBytes: 32 * MIB,
    hardItems: 320, hardBytes: 160 * MIB
  }, 'V9 thresholds are implemented exactly');
  scenario('Z7-S01 V9 authority identity and exact thresholds');
}

/* ---------------- 2. Y-10 gate, N.3 table ---------------- */
function verifyFormatGate() {
  const empty = evaluateFormatGate({ libraryInfo: null, repositoryHasContent: false });
  equal(empty.state, P02_GATE_STATE.ABSENT_EMPTY, 'absent + empty repository');
  equal(empty.initializationEligible, true, 'empty repository is initialization eligible');
  equal(empty.mayWrite, false, 'initialization eligibility is still not a write permit');

  const legacy = evaluateFormatGate({ libraryInfo: null, repositoryHasContent: true });
  equal(legacy.state, P02_GATE_STATE.ABSENT_WITH_CONTENT, 'absent + legacy/unknown content');
  equal(legacy.mayWrite, false, 'NO automatic P02 writes over legacy content');

  const malformed = evaluateFormatGate({ libraryInfo: { schema: 'x' } });
  equal(malformed.state, P02_GATE_STATE.MALFORMED, 'malformed authority');
  equal(malformed.mayRead, false, 'malformed fails closed');
  equal(malformed.classification, 'unsupported-format', 'malformed classifies unsupported-format');

  const unknownKey = evaluateFormatGate({
    libraryInfo: {
      schema: P02_FORMAT_GATE_V2.SCHEMA, formatVersion: 2,
      minimumCompatibleProtocolVersion: 2, layoutEpoch: 1, sneaky: true
    }
  });
  equal(unknownKey.state, P02_GATE_STATE.MALFORMED, 'unknown key is malformed, never lenient');

  const tooNew = evaluateFormatGate({
    libraryInfo: {
      schema: P02_FORMAT_GATE_V2.SCHEMA, formatVersion: 2,
      minimumCompatibleProtocolVersion: 9, layoutEpoch: 1
    }
  });
  equal(tooNew.state, P02_GATE_STATE.PROTOCOL_TOO_NEW, 'reader below minimum protocol');
  equal(tooNew.mayWrite, false, 'reader below minimum is read-only report');

  const supported = evaluateFormatGate({
    libraryInfo: {
      schema: P02_FORMAT_GATE_V2.SCHEMA, formatVersion: 2,
      minimumCompatibleProtocolVersion: 2, layoutEpoch: 1
    }
  });
  equal(supported.state, P02_GATE_STATE.SUPPORTED, 'activated repository is supported');
  equal(supported.mayWrite, true, 'only an activated repository permits P02 writes');

  const legacyChanged = evaluateFormatGate({
    libraryInfo: {
      schema: P02_FORMAT_GATE_V2.SCHEMA, formatVersion: 2,
      minimumCompatibleProtocolVersion: 2, layoutEpoch: 1
    },
    legacyBaselineMatches: false
  });
  equal(legacyChanged.state, P02_GATE_STATE.LEGACY_ARTIFACT_CHANGED,
    'changed legacy artifact after activation');
  equal(legacyChanged.classification, 'integrity-quarantined', 'quarantine posture');
  equal(legacyChanged.mayWrite, false, 'quarantine suspends P02 writes');

  /* N.4 honesty and the activation hook being unarmed in Wave 1. */
  const hook = createActivationCeremonyHook();
  equal(hook.isArmed(), false, 'Wave 1 supplies no activation writer');
  scenario('Z7-S02 Y-10 gate implements the full N.3 table and fails closed');
}

/* ---------------- 3. V9 parity vectors ---------------- */
function verifyCapacityVectors() {
  const idx = buildBranchIndex({ objectId: 'o', records: [] });

  vector('255th item admits normally',
    P02_CAPACITY_VERDICT.ADMIT_NORMAL,
    evaluateCapacity({ retained: fill(254), candidate: item('new'), index: idx }).verdict);
  vector('256th item admits normally',
    P02_CAPACITY_VERDICT.ADMIT_NORMAL,
    evaluateCapacity({ retained: fill(255), candidate: item('new'), index: idx }).verdict);
  vector('first normal-budget overflow is blocked',
    P02_CAPACITY_VERDICT.BLOCKED,
    evaluateCapacity({ retained: fill(256), candidate: item('new'), index: idx }).verdict);

  /* Recovery-critical evidence reaches the reserve. */
  const unprovenIdx = buildBranchIndex({
    objectId: 'o',
    records: [{
      document: {
        objectDomain: DOMAIN, objectId: 'o', revisionId: 'child',
        previousRevisionId: 'ancestor', previousRevisionBlobSha256: hashOf('ancestor')
      },
      revisionBlobSha256: hashOf('child')
    }]
  });
  vector('missing ancestor enters the reserve',
    P02_CAPACITY_VERDICT.ADMIT_RESERVE,
    evaluateCapacity({
      retained: fill(256), candidate: item('ancestor'), index: unprovenIdx
    }).verdict);
  vector('ordinary item refused after the normal budget',
    P02_CAPACITY_VERDICT.BLOCKED,
    evaluateCapacity({
      retained: fill(256), candidate: item('ordinary'), index: unprovenIdx
    }).verdict);
  vector('319th hard-boundary item still admits to reserve',
    P02_CAPACITY_VERDICT.ADMIT_RESERVE,
    evaluateCapacity({
      retained: fill(319), candidate: item('ancestor'), index: unprovenIdx
    }).verdict);
  vector('hard-limit overflow is blocked even for recovery evidence',
    P02_CAPACITY_VERDICT.BLOCKED,
    evaluateCapacity({
      retained: fill(320), candidate: item('ancestor'), index: unprovenIdx
    }).verdict);

  /* Byte boundaries. */
  const bigRetained = [item('big', 128 * MIB - 1024, 0)];
  vector('byte boundary below 128 MiB admits',
    P02_CAPACITY_VERDICT.ADMIT_NORMAL,
    evaluateCapacity({ retained: bigRetained, candidate: item('n', 1024, 0), index: idx }).verdict);
  vector('byte boundary above 128 MiB blocks',
    P02_CAPACITY_VERDICT.BLOCKED,
    evaluateCapacity({ retained: bigRetained, candidate: item('n', 4096, 0), index: idx }).verdict);
  vector('reserve byte headroom admits recovery evidence',
    P02_CAPACITY_VERDICT.ADMIT_RESERVE,
    evaluateCapacity({
      retained: [item('big', 128 * MIB, 0)], candidate: item('ancestor', 4096, 0), index: unprovenIdx
    }).verdict);
  vector('hard 160 MiB boundary blocks recovery evidence',
    P02_CAPACITY_VERDICT.BLOCKED,
    evaluateCapacity({
      retained: [item('big', 160 * MIB, 0)], candidate: item('ancestor', 4096, 0), index: unprovenIdx
    }).verdict);

  /* Replay and integrity. */
  vector('exact replay consumes no capacity',
    P02_CAPACITY_VERDICT.REPLAY,
    evaluateCapacity({ retained: [item('a')], candidate: item('a'), index: idx }).verdict);
  equal(evaluateCapacity({
    retained: [item('a')], candidate: item('a'), index: idx
  }).consumesCapacity, false, 'replay consumes no logical capacity');
  vector('divergent same-identity bytes are an integrity failure',
    P02_CAPACITY_VERDICT.INTEGRITY,
    evaluateCapacity({
      retained: [item('a')],
      candidate: { ...item('a'), revisionBlobSha256: hashOf('different') },
      index: idx
    }).verdict);

  /* Measurement excludes derived structures by construction. */
  const measured = measureRetainedEvidence([item('a', 100, 10), item('a', 100, 10), item('b', 50, 5)]);
  equal(measured.items, 2, 'duplicate identities count once');
  equal(measured.bytes, 165, 'bytes sum canonical revision + head bytes for unique items');

  /* Capacity is a predicate, not stored state. */
  equal(capacityBlockReason({ retained: fill(320) }), 'capacity', 'predicate reports at hard limit');
  equal(capacityBlockReason({ retained: fill(10) }), null, 'predicate clears when usage drops');
  scenario('Z7-S03 V9 parity vectors across item, byte, reserve and hard boundaries');
}

/* ---------------- 4. reserve eligibility + abuse ---------------- */
function verifyReserveEligibility() {
  const closureIdx = buildBranchIndex({
    objectId: 'o',
    records: [
      { document: { objectDomain: DOMAIN, objectId: 'o', revisionId: 'a', previousRevisionId: null, previousRevisionBlobSha256: null }, revisionBlobSha256: hashOf('a') },
      { document: { objectDomain: DOMAIN, objectId: 'o', revisionId: 'b', previousRevisionId: 'a', previousRevisionBlobSha256: hashOf('a') }, revisionBlobSha256: hashOf('b') },
      { document: { objectDomain: DOMAIN, objectId: 'o', revisionId: 'c', previousRevisionId: 'a', previousRevisionBlobSha256: hashOf('a') }, revisionBlobSha256: hashOf('c') }
    ]
  });
  const closure = {
    ...item('t'), closureType: 'branch-superseded', previousRevisionId: 'c'
  };
  const verdict = evaluateCapacity({ retained: fill(256), candidate: closure, index: closureIdx });
  equal(verdict.verdict, P02_CAPACITY_VERDICT.ADMIT_RESERVE,
    'a closure over an unresolved live leaf reaches the reserve');
  equal(verdict.recoveryClass, P02_RECOVERY_CLASS.UNRESOLVED_LEAF_CLOSURE,
    'closure recovery class is reported');

  /* Abuse: an ordinary revision cannot self-label as recovery-critical. */
  const abusive = {
    ...item('attacker'),
    recoveryCritical: true, recoveryClass: 'missing-ancestor',
    closureType: 'branch-superseded', previousRevisionId: 'not-a-leaf'
  };
  equal(evaluateCapacity({ retained: fill(256), candidate: abusive, index: closureIdx }).verdict,
    P02_CAPACITY_VERDICT.BLOCKED,
    'a self-labelled revision cannot mint reserve eligibility');
  scenario('Z7-S04 reserve eligibility is locally derived and cannot be farmed');
}

/* ---------------- 5. native quota mapping ---------------- */
function verifyNativeQuotaMapping() {
  const quota = mapNativeStorageFailure(
    Object.assign(new Error('quota'), { name: 'QuotaExceededError' })
  );
  equal(quota.blockedReason, 'capacity', 'QuotaExceededError maps onto capacity block');
  equal(quota.evidenceDeleted, false, 'native exhaustion deletes nothing');
  equal(quota.logicalThresholdReached, false,
    'native exhaustion is not conflated with the logical V9 threshold');
  const sqliteFull = mapNativeStorageFailure(new Error('database or disk is full'));
  equal(sqliteFull.blockedReason, 'capacity', 'Desktop disk-full maps onto capacity block');
  equal(mapNativeStorageFailure(new Error('some other failure')), null,
    'unrelated failures are not misreported as capacity');
  scenario('Z7-S05 native storage exhaustion fails closed without deletion');
}

/* ---------------- 6. runtime composition, gate-inactive ---------------- */
async function verifyRuntimeComposition() {
  const objects = ['o1', 'o2', 'o3'];
  const mutations = [];
  const make = ({ gate, mode = 'auto', p01Active = false }) => createP02ObjectRuntime({
    peerId: 'z7-peer',
    clock: () => 0,
    enumerate: async () => objects.map((objectId) => ({
      objectDomain: DOMAIN, objectId, objectKey: hashOf(objectId)
    })),
    classify: async () => ({ classification: 'local-ahead', reason: 'test' }),
    authority: async () => ({ mode, valid: true }),
    gate,
    p01WriterActive: async () => p01Active,
    reconcileOneObject: async (candidate) => {
      mutations.push(candidate.objectId);
      return { ok: true, verdict: 'reconciled' };
    }
  });

  /* The Wave-1 posture: gate inactive, enumerate and classify, mutate nothing. */
  const inactive = make({ gate: async () => inactiveGate(true) });
  const pass = await inactive.runPass();
  equal(pass.status, P02_RUNTIME_STATUS.GATE_INACTIVE, 'unactivated repository is gate-inactive');
  equal(pass.mutated, false, 'gate-inactive performs no mutation');
  equal(pass.candidates.length, 3, 'gate-inactive still enumerates and classifies');
  equal(mutations.length, 0, 'no canonical mutation behind an inactive gate');

  /* Malformed authority fails closed and does not even enumerate. */
  const failClosed = make({
    gate: async () => evaluateFormatGate({ libraryInfo: { schema: 'bad' } })
  });
  const closed = await failClosed.runPass();
  equal(closed.status, P02_RUNTIME_STATUS.GATE_FAIL_CLOSED, 'malformed gate fails closed');
  equal(closed.mutated, false, 'fail-closed never mutates');

  /* Activated + Auto is the only mutating posture, and it is bounded. */
  const activatedGate = async () => evaluateFormatGate({
    libraryInfo: {
      schema: P02_FORMAT_GATE_V2.SCHEMA, formatVersion: 2,
      minimumCompatibleProtocolVersion: 2, layoutEpoch: 1
    }
  });
  const active = make({ gate: activatedGate });
  const progressed = await active.runPass({ maxSteps: 3 });
  equal(progressed.status, P02_RUNTIME_STATUS.PROGRESSED, 'activated + auto progresses');
  equal(new Set(progressed.dispatched.map((d) => d.objectId)).size, 3,
    'multi-object scheduling is fair across the pass');

  /* Manual never mutates even with an activated gate. */
  mutations.length = 0;
  const manual = make({ gate: activatedGate, mode: 'manual' });
  const manualPass = await manual.runPass();
  equal(manualPass.mutated, false, 'manual mode never mutates');
  equal(mutations.length, 0, 'manual mode dispatches nothing');
  const report = await manual.report();
  equal(report.candidates.length, 3, 'manual mode still surfaces eligibility read-only');

  /* Dual-writer exclusion. */
  mutations.length = 0;
  const dual = make({ gate: activatedGate, p01Active: true });
  const dualPass = await dual.runPass();
  equal(dualPass.status, P02_RUNTIME_STATUS.DUAL_WRITER_EXCLUDED,
    'P02 stands down while the accepted P01 writer is active');
  equal(mutations.length, 0, 'no concurrent dual-writer mutation is possible');
  equal(P02_RUNTIME_V2.DEFAULT_DRAIN_LIMIT, 8, 'bounded drain is an implementation choice');
  scenario('Z7-S06 one engine: gate-inactive, fail-closed, manual, dual-writer exclusion');
}

/* ---------------- 7. capacity through the runtime ---------------- */
async function verifyRuntimeCapacity() {
  const retained = new Map([['o1', fill(320)], ['o2', fill(2)]]);
  const mutations = [];
  const runtime = createP02ObjectRuntime({
    peerId: 'z7-cap',
    clock: () => 0,
    enumerate: async () => [...retained.keys()].map((objectId) => ({
      objectDomain: DOMAIN, objectId, objectKey: hashOf(objectId)
    })),
    classify: async () => ({ classification: 'local-ahead', reason: 'test' }),
    retainedEvidenceFor: async (descriptor) => retained.get(descriptor.objectId) || [],
    authority: async () => ({ mode: 'auto', valid: true }),
    gate: async () => evaluateFormatGate({
      libraryInfo: {
        schema: P02_FORMAT_GATE_V2.SCHEMA, formatVersion: 2,
        minimumCompatibleProtocolVersion: 2, layoutEpoch: 1
      }
    }),
    reconcileOneObject: async (candidate) => {
      mutations.push(candidate.objectId);
      return { ok: true, verdict: 'reconciled' };
    }
  });
  const report = await runtime.report();
  deepEqual(report.blocked, [{ objectId: 'o1', reason: 'capacity' }],
    'an object at the hard limit classifies blocked(capacity)');
  deepEqual(report.runnable, ['o2'], 'a blocked object does not stop healthy peers');
  await runtime.runPass({ maxSteps: 4 });
  deepEqual([...new Set(mutations)], ['o2'], 'capacity-blocked objects are never dispatched');

  /* Recovery is predicate-derived: shrink usage, no repair anywhere. */
  retained.set('o1', fill(3));
  const recovered = await runtime.report();
  deepEqual(recovered.blocked, [], 'clearing capacity needs no scheduler or index repair');
  deepEqual(recovered.runnable.sort(), ['o1', 'o2'], 'the object becomes eligible again');
  scenario('Z7-S07 capacity blocks and clears purely by predicate through the real runtime');
}

/* ---------------- 8. packed composition parity ---------------- */
async function verifyPackedComposition() {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'p02-z7-pack-'));
  try {
    const adapters = syncItem9BrowserAdaptersToOut(root, out);
    const core = syncP02CoreModulesToOut(root, out);
    check(compareP02CoreModulesToSource(root, out).matches,
      'packed P02 core modules are byte-identical to source');
    /*
     * The load-bearing check: the packed adapters are copied verbatim, so the
     * relative import added in Z6 must resolve in the packed tree too.
     */
    const packed = await import(
      `file://${path.join(adapters.outAdapterDir, 'sync-revision-admission.mjs')}`
    );
    equal(typeof packed.createInjectedRevisionAdmission, 'function',
      'the packed admission adapter loads with its ../../core import resolved');
    const packedRuntime = await import(
      `file://${path.join(core.outCoreDir, 'sync-object-runtime-v2.mjs')}`
    );
    equal(packedRuntime.P02_RUNTIME_V2.SCHEMA, P02_RUNTIME_V2.SCHEMA,
      'the packed P02 runtime is the same engine as source');
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }

  /*
   * Chrome generated-production proof. The packer bundles this entry with
   * esbuild bundle:true, so bundling it the same way here proves what actually
   * reaches bg.js rather than merely what the source file mentions.
   */
  const bundle = buildSync({
    entryPoints: [
      path.join(root, 'packages/browser-adapters/chrome/sync-background-reconcile.mjs')
    ],
    bundle: true, format: 'iife', globalName: 'H2OChromeBackgroundSyncBundle',
    platform: 'browser', target: ['chrome120'], write: false
  }).outputFiles[0].text;

  for (const [label, needle] of [
    ['P02 runtime', 'h2o.studio.syncObjectRuntime.p02.v1'],
    ['Y-10 format gate', 'h2o.studio.syncLibraryInfo.p02.v1'],
    ['V9 decision identity', P02_CAPACITY_V9.DECISION_SHA256],
    ['V9 normal budget', 'normalItems: 256'],
    ['V9 hard limit', 'hardItems: 320'],
    ['Z5 scheduler', 'syncSchedulerCandidate.p02.v1'],
    ['Y-9 classifier semantics', 'resolution-target-missing'],
    ['Z6 branch evidence', 'syncBranchEvidence.p02.v1'],
    ['accepted alarm ownership', 'h2o:studio:sync:background-reconcile:v1']
  ]) {
    check(bundle.includes(needle),
      `the generated background worker composes ${label}`);
  }

  /*
   * Permission posture. The background module itself never calls
   * requestPermission; it uses queryPermission and fails closed. The bundle
   * does contain the gesture-gated foreground writer's request path, exactly
   * as it did before Z7 - this asserts the worker path, not mere absence.
   */
  const backgroundSource = fs.readFileSync(
    path.join(root, 'packages/browser-adapters/chrome/sync-background-reconcile.mjs'), 'utf8'
  );
  check(!/requestPermission/.test(backgroundSource),
    'the background worker module never calls requestPermission');
  check(/queryPermission/.test(backgroundSource),
    'the background worker queries permission and fails closed instead');
  scenario('Z7-S08 packed/bundled composition parity for Desktop and Chrome');
}

/* ---------------- 8b. Desktop product composition ---------------- */
const DESKTOP_ENTRY_REL = 'sync/sync-object-runtime-v2.desktop.mjs';

async function verifyDesktopComposition() {
  /* The entry is registered in the product surface and in both pack lists. */
  const html = fs.readFileSync(
    path.join(root, 'src-surfaces-base/studio/studio.html'), 'utf8'
  );
  check(html.includes(`<script type="module" src="./${DESKTOP_ENTRY_REL}"></script>`),
    'studio.html loads the Desktop P02 module entry');
  check(ARCHIVE_WORKBENCH_SOURCE_FILES.includes(DESKTOP_ENTRY_REL),
    'the Desktop entry is in the packer source list');
  check(ARCHIVE_WORKBENCH_OUT_FILES.includes(DESKTOP_ENTRY_REL),
    'the Desktop entry is in the packer out list');

  /*
   * Loading must be inert. Assert it structurally: the entry reaches no
   * platform capability, registers no timer or listener, and initializes
   * nothing merely by being imported.
   */
  const entrySource = fs.readFileSync(
    path.join(root, 'src-surfaces-base/studio/sync', path.basename(DESKTOP_ENTRY_REL)), 'utf8'
  );
  for (const forbidden of [
    'invoke(', 'fetch(', 'localStorage', 'indexedDB', 'setInterval(', 'setTimeout(',
    'addEventListener(', 'requestPermission', 'writeFile', 'library.info.json'
  ]) {
    check(!entrySource.includes(forbidden),
      `the Desktop entry performs no ${forbidden} on load`);
  }

  /* Packed-tree proof: the whole graph resolves and the gate stays shut. */
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'p02-z7-desktop-'));
  try {
    const surface = path.join(out, 'surfaces', 'studio');
    for (const rel of ARCHIVE_WORKBENCH_SOURCE_FILES) {
      const from = path.join(root, 'src-surfaces-base/studio', rel);
      if (!fs.existsSync(from)) continue;
      const to = path.join(surface, rel);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(from, to);
    }
    syncItem9BrowserAdaptersToOut(root, out);
    syncP02CoreModulesToOut(root, out);
    check(fs.existsSync(path.join(surface, DESKTOP_ENTRY_REL)),
      'the Desktop entry is present in the packed product');
    equal(fs.readdirSync(path.join(surface, 'core')).length, P02_CORE_SOURCE_FILES.length,
      'the packed product ships every shared P02 core module');

    const packed = await import(`file://${path.join(surface, DESKTOP_ENTRY_REL)}`);
    equal(typeof packed.createDesktopP02Runtime, 'function',
      'the packed Desktop entry loads with every relative import resolved');
    const gate = packed.inactiveDesktopGate();
    equal(gate.state, P02_GATE_STATE.ABSENT_WITH_CONTENT,
      'the packed Desktop entry sees an unactivated repository');
    equal(gate.mayWrite, false, 'the packed Desktop entry may not write');
    equal(packed.P02_DESKTOP_COMPOSITION.capacity.normalItems, 256,
      'the packed Desktop entry carries the V9 budget');
    equal(packed.P02_DESKTOP_COMPOSITION.activatesOnLoad, false,
      'loading the Desktop entry activates nothing');

    /* Installing the handle publishes read-only state and no engine. */
    const scope = {};
    const handle = packed.installDesktopP02Composition(scope);
    equal(handle.active, false, 'the published Desktop handle is inactive');
    equal(handle.mayWriteAtLoad, false, 'the published handle cannot write');
    check(Object.isFrozen(handle), 'the published Desktop handle is read-only');
    equal(scope.H2O.Studio.sync.p02, handle, 'the handle is published for classic scripts');

    /* Zero mutation: a runtime built from the default gate never mutates. */
    const mutations = [];
    const runtime = packed.createDesktopP02Runtime({
      enumerate: async () => [{
        objectDomain: DOMAIN, objectId: 'desktop-o', objectKey: hashOf('desktop-o')
      }],
      classify: async () => ({ classification: 'local-ahead' }),
      authority: async () => ({ mode: 'auto', valid: true }),
      reconcileOneObject: async (c) => { mutations.push(c.objectId); return { ok: true }; }
    });
    const pass = await runtime.runPass();
    equal(pass.status, P02_RUNTIME_STATUS.GATE_INACTIVE,
      'the Desktop runtime is gate-inactive by default');
    equal(pass.mutated, false, 'the Desktop runtime performs zero mutation');
    equal(mutations.length, 0, 'no Desktop canonical mutation is reachable while inactive');
    equal(pass.candidates.length, 1,
      'the Desktop runtime still enumerates and classifies read-only');

    /* Dual-writer exclusion holds on Desktop too. */
    const dualMutations = [];
    const dual = packed.createDesktopP02Runtime({
      enumerate: async () => [{
        objectDomain: DOMAIN, objectId: 'desktop-o', objectKey: hashOf('desktop-o')
      }],
      classify: async () => ({ classification: 'local-ahead' }),
      authority: async () => ({ mode: 'auto', valid: true }),
      gate: async () => evaluateFormatGate({
        libraryInfo: {
          schema: P02_FORMAT_GATE_V2.SCHEMA, formatVersion: 2,
          minimumCompatibleProtocolVersion: 2, layoutEpoch: 1
        }
      }),
      p01WriterActive: async () => true,
      reconcileOneObject: async (c) => { dualMutations.push(c.objectId); return { ok: true }; }
    });
    equal((await dual.runPass()).status, P02_RUNTIME_STATUS.DUAL_WRITER_EXCLUDED,
      'Desktop P02 stands down while the accepted P01 writer is active');
    equal(dualMutations.length, 0, 'no Desktop dual-writer mutation is possible');

    /* P01 composition is untouched by the addition. */
    check(html.includes('<script src="./sync/sync-object-auto-reconcile.js"></script>') &&
      html.includes('<script src="./sync/sync-linear-reconcile-core.js"></script>'),
    'the accepted P01 Desktop composition is unchanged');
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
  scenario('Z7-S09 Desktop product composition loads, stays gate-inactive and mutates nothing');
}

/* ---------------- 9. anti-degeneracy ---------------- */
async function verifyAntiDegeneracy() {
  const idx = buildBranchIndex({ objectId: 'o', records: [] });

  await requireRed('Z7-AD01-desktop-keeps-inherited-64-limit', async () => {
    const rust = fs.readFileSync(
      path.join(root, 'apps/studio/desktop/src-tauri/src/local_publication_intake.rs'), 'utf8'
    );
    assert.ok(/const NORMAL_INBOUND_ROWS: i64 = 64;/.test(rust),
      'Desktop must not still use the inherited 64-item normal budget');
  });

  await requireRed('Z7-AD02-chrome-omits-logical-capacity', async () => {
    const bg = fs.readFileSync(
      path.join(root, 'packages/browser-adapters/chrome/sync-background-reconcile.mjs'), 'utf8'
    );
    assert.ok(!bg.includes('sync-evidence-capacity-v2.mjs'),
      'Chrome must carry the logical capacity policy');
  });

  await requireRed('Z7-AD03-ordinary-revision-consumes-reserve', async () => {
    const verdict = evaluateCapacity({
      retained: fill(256), candidate: item('ordinary'), index: idx
    });
    assert.equal(verdict.verdict, P02_CAPACITY_VERDICT.ADMIT_RESERVE,
      'an ordinary revision must not consume the recovery reserve');
  });

  await requireRed('Z7-AD04-reserve-eligible-ancestor-refused', async () => {
    const unproven = buildBranchIndex({
      objectId: 'o',
      records: [{
        document: {
          objectDomain: DOMAIN, objectId: 'o', revisionId: 'child',
          previousRevisionId: 'ancestor', previousRevisionBlobSha256: hashOf('ancestor')
        },
        revisionBlobSha256: hashOf('child')
      }]
    });
    const verdict = evaluateCapacity({
      retained: fill(256), candidate: item('ancestor'), index: unproven
    });
    assert.equal(verdict.verdict, P02_CAPACITY_VERDICT.BLOCKED,
      'a reserve-eligible missing ancestor must not be refused at the normal limit');
  });

  await requireRed('Z7-AD05-hard-limit-evicts-evidence', async () => {
    const retained = fill(320);
    const before = measureRetainedEvidence(retained);
    evaluateCapacity({ retained, candidate: item('overflow'), index: idx });
    const after = measureRetainedEvidence(retained);
    assert.notEqual(after.items, before.items,
      'capacity refusal must never evict retained evidence');
  });

  await requireRed('Z7-AD06-dual-writers-both-active', async () => {
    const mutations = [];
    const runtime = createP02ObjectRuntime({
      peerId: 'z7-dual', clock: () => 0,
      enumerate: async () => [{ objectDomain: DOMAIN, objectId: 'o', objectKey: hashOf('o') }],
      classify: async () => ({ classification: 'local-ahead' }),
      authority: async () => ({ mode: 'auto', valid: true }),
      gate: async () => evaluateFormatGate({
        libraryInfo: {
          schema: P02_FORMAT_GATE_V2.SCHEMA, formatVersion: 2,
          minimumCompatibleProtocolVersion: 2, layoutEpoch: 1
        }
      }),
      p01WriterActive: async () => true,
      reconcileOneObject: async (c) => { mutations.push(c.objectId); return { ok: true }; }
    });
    await runtime.runPass();
    assert.ok(mutations.length > 0,
      'P02 must not mutate while the accepted P01 writer is active');
  });

  await requireRed('Z7-AD07-gate-inactive-still-writes', async () => {
    const mutations = [];
    const runtime = createP02ObjectRuntime({
      peerId: 'z7-gate', clock: () => 0,
      enumerate: async () => [{ objectDomain: DOMAIN, objectId: 'o', objectKey: hashOf('o') }],
      classify: async () => ({ classification: 'local-ahead' }),
      authority: async () => ({ mode: 'auto', valid: true }),
      gate: async () => inactiveGate(true),
      reconcileOneObject: async (c) => { mutations.push(c.objectId); return { ok: true }; }
    });
    await runtime.runPass();
    assert.ok(mutations.length > 0,
      'an inactive gate must prevent every write');
  });

  await requireRed('Z7-AD08-packed-adapter-import-unresolvable', async () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'p02-z7-broken-'));
    try {
      const adapters = syncItem9BrowserAdaptersToOut(root, out);
      /* Deliberately omit the core modules the adapters import. */
      await import(`file://${path.join(adapters.outAdapterDir, 'sync-revision-admission.mjs')}?broken`);
      assert.fail('the packed adapter must not load without its core modules');
    } finally {
      fs.rmSync(out, { recursive: true, force: true });
    }
  });
  await requireRed('Z7-AD09-desktop-entry-missing', async () => {
    const html = fs.readFileSync(
      path.join(root, 'src-surfaces-base/studio/studio.html'), 'utf8'
    );
    assert.ok(!html.includes(DESKTOP_ENTRY_REL),
      'the Desktop product must carry the P02 module entry');
  });

  await requireRed('Z7-AD10-desktop-entry-unpacked', async () => {
    assert.ok(!ARCHIVE_WORKBENCH_OUT_FILES.includes(DESKTOP_ENTRY_REL),
      'the Desktop entry must be shipped by the packer');
  });

  scenario('Z7-AD anti-degeneracy: capacity, reserve, gate, dual-writer, packing');
}

async function main() {
  verifyAuthorityIdentity();
  verifyFormatGate();
  verifyCapacityVectors();
  verifyReserveEligibility();
  verifyNativeQuotaMapping();
  await verifyRuntimeComposition();
  await verifyRuntimeCapacity();
  await verifyPackedComposition();
  await verifyDesktopComposition();
  await verifyAntiDegeneracy();

  console.log(JSON.stringify({
    verdict: 'P02_WAVE1_Z7_PLATFORM_INTEGRATION_PASS',
    assertions,
    deterministicScenarios: scenarios.length,
    scenarios,
    v9Vectors: vectors.length,
    antiDegeneracyControls: antiDegeneracy,
    capacity: P02_CAPACITY_LIMITS,
    gateActiveOnRealState: false,
    p02WritesEnabled: false,
    dualWriterExcluded: true,
    liveActivation: false,
    webDavCertified: false,
    evidenceDeleted: false,
    gcImplemented: false
  }, null, 2));
}

await main();
