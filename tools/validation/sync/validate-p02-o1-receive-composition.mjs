#!/usr/bin/env node
/*
 * O1-T13 — generic receive composition core.
 *
 * Two properties are load-bearing here, and both are checked adversarially
 * rather than demonstrated.
 *
 * ISOLATION. One peer's failure must not stop another peer, and one object's
 * contradiction must not poison another object. Every isolation test therefore
 * breaks something deliberately and then proves the neighbour still made
 * progress - not merely that no exception escaped.
 *
 * THE TWO AUTHORITIES. Y-2 says what a snapshot ADVERTISED; admitted evidence
 * says what has been PROCESSED. The tests try to make the memo suppress work
 * it has no right to suppress: a tip that was never admitted, one refused for
 * capacity, one from a matching snapshot hash. If any of those were skipped the
 * memo would have become an authority, which is the failure the whole design
 * exists to prevent.
 *
 * The domain boundary is proven statically, because "this module is
 * platform-neutral" is a property of its imports, not of its behaviour, and
 * behaviour tests cannot catch a convenient import added later.
 *
 * Injected ports throughout, real taxonomies. Disposable: no repository, no
 * canonical state, no platform, no processes.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  P02_RECEIVE_PEER_STATE,
  P02_RECEIVE_STAGE,
  P02_RECEIVE_V2,
  createP02ReceiveComposition
} from '../../../packages/core/sync-object-reconcile-v2.mjs';
import { P02_ATTEMPT_OUTCOME } from '../../../packages/core/sync-object-scheduler-v2.mjs';
import { P02_CLASSIFICATION } from '../../../packages/core/sync-object-classifier-v2.mjs';
import { P02_ADMISSION_DISPOSITION } from '../../../packages/core/sync-branch-evidence-v2.mjs';
import { createP02AnchorSet } from '../../../packages/core/sync-p02-anchor-set-v2.mjs';

let assertions = 0;
const failures = [];
const check = (condition, label) => {
  assertions += 1;
  if (condition !== true) failures.push(label);
};
const equal = (actual, expected, label) =>
  check(actual === expected, `${label} (expected ${String(expected)}, got ${String(actual)})`);

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const MODULE = path.join(root, 'packages/core/sync-object-reconcile-v2.mjs');
const DOMAIN = 'studio.chat.saved-state.v1';
const hex = (seed) => crypto.createHash('sha256').update(String(seed)).digest('hex');

const PEER_A = 'studio-desktop:tauri-desktop:sqlite:peer-a';
const PEER_B = 'studio-chrome:mv3:idb:peer-b';
const OBJ_X = 'chat-x';
const OBJ_Y = 'chat-y';

const tip = (objectId, revisionId, blobSeed, parent = null) => ({
  objectDomain: DOMAIN,
  objectId,
  objectKey: hex(`key-${objectId}`),
  revisionId,
  revisionBlobSha256: hex(blobSeed),
  payloadSha256: hex(`payload-${revisionId}`),
  previousRevisionId: parent?.revisionId ?? null,
  previousRevisionBlobSha256: parent?.blobSeed ? hex(parent.blobSeed) : null
});

/*
 * A rig whose every port is programmable, so a test can break exactly one thing
 * and prove the rest still works.
 */
function rig(over = {}) {
  const admittedByObject = new Map();
  const memoWrites = [];
  const reads = [];
  const state = {
    peers: [
      { syncPeerId: PEER_A, writerKey: hex('wk-a') },
      { syncPeerId: PEER_B, writerKey: hex('wk-b') }
    ],
    writerState: {
      [PEER_A]: { status: 'verified', snapshot: { headsSnapshotSha256: hex('snap-a'), heads: [] } },
      [PEER_B]: { status: 'absent' }
    },
    revisionStatus: () => ({ status: 'verified', bytes: new Uint8Array([1]), value: {} }),
    ancestry: () => ({ outcome: 'proven-chain' }),
    admission: () => ({ admitted: true, disposition: P02_ADMISSION_DISPOSITION.ACCEPTED_LINEAR }),
    classification: () => ({ classification: P02_CLASSIFICATION.REMOTE_AHEAD }),
    memo: () => ({ reuse: false }),
    applyPermitted: () => ({ permitted: true }),
    ...over
  };

  const key = (scope) => `${scope.syncPeerId} ${scope.objectKey}`;
  const composition = createP02ReceiveComposition({
    configuredPeers: async () => {
      if (state.rosterFails) throw Object.assign(new Error('x'), { code: 'roster-down' });
      return state.peers;
    },
    readWriterState: async ({ syncPeerId }) => {
      const value = state.writerState[syncPeerId];
      if (value instanceof Error) throw value;
      return value;
    },
    readRevisionBytes: async (input) => {
      reads.push(input.revisionId);
      return state.revisionStatus(input);
    },
    fetchAncestry: async (input) => state.ancestry(input),
    readAdmittedEvidence: async (scope) => {
      if (state.evidenceFails?.(scope)) {
        throw Object.assign(new Error('x'), { code: 'evidence-down' });
      }
      return admittedByObject.get(key(scope)) ?? [];
    },
    admitRevision: async (input) => {
      const verdict = state.admission(input);
      if (verdict?.admitted === true) {
        const list = admittedByObject.get(key(input)) ?? [];
        list.push({ revisionId: input.revisionId, revisionBlobSha256: input.revisionBlobSha256 });
        admittedByObject.set(key(input), list);
      }
      return verdict;
    },
    classifyObject: async (input) => state.classification(input),
    anchorSetFor: async (scope) => createP02AnchorSet({
      objectDomain: scope.objectDomain, objectId: scope.objectId, protocolState: {}
    }),
    readTipMemo: async (input) => state.memo(input),
    writeTipMemo: async (input) => {
      memoWrites.push(input);
      if (state.memoWriteFails) throw Object.assign(new Error('x'), { code: 'memo-down' });
    },
    protocolStateFor: async () => ({}),
    applyAuthority: async (input) => state.applyPermitted(input)
  });
  return { composition, state, admittedByObject, memoWrites, reads };
}

const advertise = (rigged, peer, tips) => {
  rigged.state.writerState[peer] = {
    status: 'verified',
    snapshot: { headsSnapshotSha256: hex(`snap-${peer}`), heads: tips }
  };
};
const objectOf = (report, objectId) =>
  report.objects.find((item) => item.objectId === objectId);

/* ===== A. The domain boundary, proven statically ===== */
{
  const source = fs.readFileSync(MODULE, 'utf8');
  const imports = [...source.matchAll(/^import[\s\S]*?from '([^']+)';/gm)].map((m) => m[1]);
  check(imports.length > 0, 'A1 the module has imports to inspect');
  check(imports.every((spec) => spec.startsWith('./')),
    `A2 every import is a sibling core module (${imports.join(', ')})`);

  for (const [pattern, label] of [
    [/from '\.\.\/browser-adapters/, 'a Chrome adapter'],
    [/from 'node:/, 'a Node builtin'],
    [/@tauri-apps|tauri/i, 'Tauri'],
    [/\bchrome\./, 'a chrome.* API'],
    [/indexedDB|IDBKeyRange/, 'IndexedDB'],
    [/\bfs\.|readFileSync|writeFileSync/, 'a filesystem API'],
    [/SELECT |INSERT |UPDATE |CREATE TABLE/i, 'SQL'],
    [/kv_store|sync_object_state|sync_branch_evidence_state|chats|snapshots/, 'a table name'],
    [/setTimeout|setInterval|Date\.now\(|new Date\(/, 'a timer or clock'],
    [/webdav|WebDAV|If-Match|If-None-Match/, 'WebDAV'],
    [/writers\/|objects\/|state\.json|\.pending-/, 'a repository path'],
    [/chatArchive|snapshotId|chatIndex|richTurns/, 'chat schema knowledge']
  ]) {
    check(pattern.test(source) === false, `A3 the module contains no ${label}`);
  }

  /* objectDomain may flow as DATA. It is carried and compared, never branched
   * on - a domain-specific branch here would be the boundary breaking. */
  check(source.includes('objectDomain'), 'A4 objectDomain flows through as data');
  check(/objectDomain === '|objectDomain\.startsWith|switch \(objectDomain/.test(source) === false,
    'A5 and is never interpreted or branched on');
}

/* ===== B. The frozen receive order and peer states ===== */
{
  /* 1. ABSENT is a no-op, not a failure. */
  const absent = rig();
  const report = await absent.composition.receivePass();
  const peerB = report.peers.find((p) => p.syncPeerId === PEER_B);
  equal(peerB.state, P02_RECEIVE_PEER_STATE.ABSENT, 'B1 a peer that never published is absent');
  equal(peerB.result.outcome, P02_ATTEMPT_OUTCOME.NO_EFFECT, 'B2 which is a no-op');
  equal(peerB.retainedLastVerifiedMemo, true, 'B3 and retains its last verified memo');

  /* An unreadable pointer is blocked(transport) and RETAINS the memo. */
  const unreadable = rig();
  unreadable.state.writerState[PEER_A] = Object.assign(new Error('io'), { code: 'pointer-io' });
  const blocked = (await unreadable.composition.receivePass())
    .peers.find((p) => p.syncPeerId === PEER_A);
  equal(blocked.result.outcome, P02_ATTEMPT_OUTCOME.BLOCKED, 'B4 an unreadable pointer is blocked');
  equal(blocked.result.blockReason, 'transport', 'B5 as transport');
  equal(blocked.retainedLastVerifiedMemo, true,
    'B6 and RETAINS the prior verified memo rather than inventing an empty remote state');
  equal(unreadable.memoWrites.length, 0, 'B7 writing no memo at all');

  /* A quarantined pointer is integrity, and no Apply follows. */
  const quarantined = rig();
  quarantined.state.writerState[PEER_A] = { status: 'quarantined', reason: 'identity-mismatch' };
  const bad = (await quarantined.composition.receivePass())
    .peers.find((p) => p.syncPeerId === PEER_A);
  equal(bad.state, P02_RECEIVE_PEER_STATE.INTEGRITY, 'B8 a quarantined pointer is integrity');
  equal(bad.result.reason, 'identity-mismatch', 'B9 preserving the cause');

  /* A verified pointer whose snapshot is unusable is transport, not empty. */
  const noSnapshot = rig();
  noSnapshot.state.writerState[PEER_A] = { status: 'verified', snapshot: null };
  const promised = (await noSnapshot.composition.receivePass())
    .peers.find((p) => p.syncPeerId === PEER_A);
  equal(promised.result.stage, P02_RECEIVE_STAGE.HEADS_SNAPSHOT,
    'B10 a verified pointer with no readable snapshot fails at the snapshot stage');
  equal(promised.result.blockReason, 'transport',
    'B11 as transport - the pointer promised what the repository did not deliver');
}

/* ===== C. Y-2 never suppresses unadmitted work ===== */
{
  /* 8. Same verified snapshot, everything admitted -> safe fast path. */
  const settled = rig();
  const t1 = tip(OBJ_X, 'p02-x1', 'bx1');
  advertise(settled, PEER_A, [t1]);
  await settled.composition.receivePass();
  const readsAfterFirst = settled.reads.length;
  settled.state.memo = () => ({ reuse: true, advertisedTips: [t1] });
  await settled.composition.receivePass();
  equal(settled.reads.length, readsAfterFirst,
    'C1 an identical snapshot with everything admitted re-reads nothing');

  /* 9. Same snapshot, ONE unadmitted tip -> that tip is processed anyway. */
  const partial = rig();
  const t2 = tip(OBJ_X, 'p02-x2', 'bx2');
  advertise(partial, PEER_A, [t1, t2]);
  /* The memo claims both, but evidence only ever covered the first. */
  partial.state.memo = () => ({ reuse: true, advertisedTips: [t1, t2] });
  partial.admittedByObject.set(`${PEER_A} ${hex(`key-${OBJ_X}`)}`, [
    { revisionId: t1.revisionId, revisionBlobSha256: t1.revisionBlobSha256 }
  ]);
  await partial.composition.receivePass();
  check(partial.reads.includes('p02-x2'),
    'C2 a matching memo NEVER suppresses a tip admitted evidence does not cover');
  check(partial.reads.includes('p02-x1') === false,
    'C3 while the already-admitted tip is not re-read');

  /* Capacity-refused tips must retry despite memo presence. */
  const refused = rig({
    admission: () => ({ admitted: false, blockedReason: 'capacity' })
  });
  advertise(refused, PEER_A, [t1]);
  const first = await refused.composition.receivePass();
  equal(objectOf(first, OBJ_X).result.blockReason, 'capacity',
    'C4 a capacity refusal is blocked(capacity)');
  refused.state.memo = () => ({ reuse: true, advertisedTips: [t1] });
  const before = refused.reads.length;
  await refused.composition.receivePass();
  check(refused.reads.length > before,
    'C5 and is retried on the next pass despite the memo');

  /* 11. A dropped memo write costs a re-derivation and nothing else. */
  const dropped = rig({ memoWriteFails: true });
  advertise(dropped, PEER_A, [t1]);
  const survived = await dropped.composition.receivePass();
  equal(objectOf(survived, OBJ_X).result.outcome, P02_ATTEMPT_OUTCOME.PROGRESS,
    'C6 a failed memo write never fails the pass that produced it');
  equal(dropped.memoWrites.length, 1, 'C7 the write was attempted');

  /* 10. Restart with durable evidence reconstructs the same safe state. */
  const restarted = rig();
  advertise(restarted, PEER_A, [t1]);
  const before1 = await restarted.composition.receivePass();
  const after = await restarted.composition.receivePass();
  equal(objectOf(after, OBJ_X).result.outcome, P02_ATTEMPT_OUTCOME.NO_EFFECT,
    'C8 with evidence already admitted, the next pass has nothing outstanding');
  equal(objectOf(before1, OBJ_X).classification, objectOf(after, OBJ_X).classification,
    'C9 and reconstructs the same classification');
}

/* ===== D. Stage failures map into the ONE result language ===== */
{
  const cases = [
    [{ revisionStatus: () => ({ status: 'missing' }) },
      P02_ATTEMPT_OUTCOME.BLOCKED, 'transport', 'D1 a missing revision'],
    [{ revisionStatus: () => ({ status: 'blocked(permission)' }) },
      P02_ATTEMPT_OUTCOME.BLOCKED, 'permission', 'D2 an ungranted folder'],
    [{ revisionStatus: () => ({ status: 'integrity', reason: 'blob-hash-mismatch' }) },
      P02_ATTEMPT_OUTCOME.INTEGRITY, null, 'D3 a canonical/hash mismatch'],
    [{ ancestry: () => ({ outcome: 'retained-unproven-parent' }) },
      P02_ATTEMPT_OUTCOME.BLOCKED, 'transport', 'D4 incomplete ancestry'],
    [{ ancestry: () => ({ outcome: 'quarantined', reason: 'ancestry-cycle' }) },
      P02_ATTEMPT_OUTCOME.INTEGRITY, null, 'D5 a cycle'],
    [{ admission: () => ({ admitted: false, blockedReason: 'capacity' }) },
      P02_ATTEMPT_OUTCOME.BLOCKED, 'capacity', 'D6 capacity exhaustion'],
    [{ admission: () => ({ admitted: true, disposition: P02_ADMISSION_DISPOSITION.QUARANTINED, reason: 'identity-conflict' }) },
      P02_ATTEMPT_OUTCOME.INTEGRITY, null, 'D7 an identity conflict'],
    [{ admission: () => ({ admitted: true, disposition: P02_ADMISSION_DISPOSITION.RETAINED_UNPROVEN_PARENT }) },
      P02_ATTEMPT_OUTCOME.BLOCKED, 'transport', 'D8 a retained-unproven parent']
  ];
  for (const [over, expectedOutcome, expectedBlock, label] of cases) {
    const rigged = rig(over);
    advertise(rigged, PEER_A, [tip(OBJ_X, 'p02-x1', 'bx1')]);
    const result = objectOf(await rigged.composition.receivePass(), OBJ_X).result;
    equal(result.outcome, expectedOutcome, `${label} maps to ${expectedOutcome}`);
    if (expectedBlock !== null) {
      equal(result.blockReason, expectedBlock, `${label} carries blockReason ${expectedBlock}`);
    }
    /* Every result speaks the one language: no ad-hoc shapes. */
    check(Object.values(P02_ATTEMPT_OUTCOME).includes(result.outcome),
      `${label} uses the accepted T03 taxonomy`);
    check(typeof result.stage === 'string' && result.stage.length > 0,
      `${label} names the stage it failed at`);
  }
}

/* ===== E. CR1 object and peer isolation ===== */
{
  /* 2 + 6 + 7. One object blocked/quarantined; another progresses. */
  const mixed = rig({
    revisionStatus: (input) => (input.objectId === OBJ_Y
      ? { status: 'missing' }
      : { status: 'verified', bytes: new Uint8Array([1]), value: {} })
  });
  advertise(mixed, PEER_A, [tip(OBJ_X, 'p02-x1', 'bx1'), tip(OBJ_Y, 'p02-y1', 'by1')]);
  const report = await mixed.composition.receivePass();
  equal(objectOf(report, OBJ_Y).result.outcome, P02_ATTEMPT_OUTCOME.BLOCKED,
    'E1 object Y is blocked on transport');
  equal(objectOf(report, OBJ_X).result.outcome, P02_ATTEMPT_OUTCOME.PROGRESS,
    'E2 while object X progresses in the same pass');

  const poisoned = rig({
    admission: (input) => (input.objectId === OBJ_Y
      ? { admitted: true, disposition: P02_ADMISSION_DISPOSITION.QUARANTINED, reason: 'identity-conflict' }
      : { admitted: true, disposition: P02_ADMISSION_DISPOSITION.ACCEPTED_LINEAR })
  });
  advertise(poisoned, PEER_A, [tip(OBJ_X, 'p02-x1', 'bx1'), tip(OBJ_Y, 'p02-y1', 'by1')]);
  const poisonReport = await poisoned.composition.receivePass();
  equal(objectOf(poisonReport, OBJ_Y).result.outcome, P02_ATTEMPT_OUTCOME.INTEGRITY,
    'E3 object Y is integrity-quarantined');
  equal(objectOf(poisonReport, OBJ_X).result.outcome, P02_ATTEMPT_OUTCOME.PROGRESS,
    'E4 and X is completely unaffected - a hostile Y cannot poison X');
  equal(objectOf(poisonReport, OBJ_X).applyEligible, true,
    'E5 X remains Apply-eligible while Y is quarantined');

  /* An object whose processing throws outright is still isolated. */
  const throwing = rig({
    classification: (input) => {
      if (input.objectId === OBJ_Y) throw Object.assign(new Error('x'), { code: 'boom' });
      return { classification: P02_CLASSIFICATION.REMOTE_AHEAD };
    }
  });
  advertise(throwing, PEER_A, [tip(OBJ_X, 'p02-x1', 'bx1'), tip(OBJ_Y, 'p02-y1', 'by1')]);
  const thrown = await throwing.composition.receivePass();
  equal(objectOf(thrown, OBJ_Y).result.outcome, P02_ATTEMPT_OUTCOME.INTEGRITY,
    'E6 an object whose processing throws yields ITS OWN result');
  equal(objectOf(thrown, OBJ_X).result.outcome, P02_ATTEMPT_OUTCOME.PROGRESS,
    'E7 without aborting the pass for its neighbours');

  /* 3 + 5. Peer isolation: one peer malformed, the other still processed. */
  const twoPeers = rig();
  twoPeers.state.writerState[PEER_A] = { status: 'quarantined', reason: 'malformed' };
  advertise(twoPeers, PEER_B, [tip(OBJ_Y, 'p02-y1', 'by1')]);
  const peerReport = await twoPeers.composition.receivePass();
  equal(peerReport.peers.find((p) => p.syncPeerId === PEER_A).state,
    P02_RECEIVE_PEER_STATE.INTEGRITY, 'E8 peer A is integrity');
  equal(peerReport.peers.find((p) => p.syncPeerId === PEER_B).state,
    P02_RECEIVE_PEER_STATE.PROCESSED, 'E9 while peer B is fully processed');
  equal(objectOf(peerReport, OBJ_Y).result.outcome, P02_ATTEMPT_OUTCOME.PROGRESS,
    'E10 and its object progresses');

  /* Only a genuine GLOBAL authority failure stops the pass. */
  const rosterDown = rig({ rosterFails: true });
  const global = await rosterDown.composition.receivePass();
  equal(global.globalFailure?.blockReason, 'transport',
    'E11 an unavailable peer roster IS a global failure');
  equal(global.peers.length, 0, 'E12 and no peer is claimed to have been processed');
}

/* ===== F. Multi-peer tips for one object coexist ===== */
{
  /* 4. Two peers advertise the same object. Their lanes stay separate. */
  const shared = rig();
  advertise(shared, PEER_A, [tip(OBJ_X, 'p02-a1', 'ba1')]);
  advertise(shared, PEER_B, [tip(OBJ_X, 'p02-b1', 'bb1')]);
  const report = await shared.composition.receivePass();
  const forObject = report.objects.filter((item) => item.objectId === OBJ_X);
  equal(forObject.length, 2, 'F1 one object advertised by two peers yields two lanes');
  equal(new Set(forObject.map((item) => item.syncPeerId)).size, 2,
    'F2 attributed to distinct peers');
  check(forObject.every((item) => item.result.outcome === P02_ATTEMPT_OUTCOME.PROGRESS),
    'F3 and both progress - writers are never flattened into one authority');

  /* Their admitted evidence is separate too. */
  equal(shared.admittedByObject.size, 2,
    'F4 with separate admitted evidence per (peer, object)');
}

/* ===== G. Apply eligibility: admission alone is never enough ===== */
{
  const base = () => {
    const rigged = rig();
    advertise(rigged, PEER_A, [tip(OBJ_X, 'p02-x1', 'bx1')]);
    return rigged;
  };
  const eligible = await base().composition.receivePass();
  equal(objectOf(eligible, OBJ_X).applyEligible, true,
    'G1 a fully admitted remote-ahead object is Apply-eligible');
  equal(eligible.applyCandidates.length, 1, 'G2 and appears in the handoff');

  for (const [over, reason, label] of [
    [{ classification: () => ({ classification: P02_CLASSIFICATION.CONVERGED }) },
      'converged', 'G3 a converged object'],
    [{ classification: () => ({ classification: P02_CLASSIFICATION.DIVERGED_UNRESOLVED }) },
      'diverged-unresolved', 'G4 an unresolved fork'],
    [{ classification: () => ({ classification: P02_CLASSIFICATION.REMOTE_AHEAD, integrityQuarantined: true }) },
      'integrity-quarantined', 'G5 an integrity-quarantined object'],
    [{ applyPermitted: () => ({ permitted: false, reason: 'gate-inactive' }) },
      'gate-inactive', 'G6 a platform authority refusal']
  ]) {
    const rigged = rig(over);
    advertise(rigged, PEER_A, [tip(OBJ_X, 'p02-x1', 'bx1')]);
    const result = objectOf(await rigged.composition.receivePass(), OBJ_X);
    equal(result.applyEligible, false, `${label} is not Apply-eligible`);
    equal(result.applyRefusedBecause, reason, `${label} says why (${reason})`);
  }

  /* An outstanding tip means unproven ancestry somewhere: no Apply. */
  const outstanding = rig({ revisionStatus: () => ({ status: 'missing' }) });
  advertise(outstanding, PEER_A, [tip(OBJ_X, 'p02-x1', 'bx1')]);
  const notReady = objectOf(await outstanding.composition.receivePass(), OBJ_X);
  equal(notReady.applyEligible, false, 'G7 an object with outstanding tips is not Apply-eligible');
  equal(notReady.applyRefusedBecause, 'advertised-tip-not-admitted', 'G8 by name');

  /* An ambiguous fork is never applied arbitrarily. */
  const forked = rig({
    classification: () => ({
      classification: P02_CLASSIFICATION.REMOTE_AHEAD,
      applyCandidates: [tip(OBJ_X, 'p02-x1', 'bx1'), tip(OBJ_X, 'p02-x2', 'bx2')]
    })
  });
  advertise(forked, PEER_A, [tip(OBJ_X, 'p02-x1', 'bx1'), tip(OBJ_X, 'p02-x2', 'bx2')]);
  const ambiguous = objectOf(await forked.composition.receivePass(), OBJ_X);
  equal(ambiguous.applyEligible, false, 'G9 two live leaves are never applied arbitrarily');
  equal(ambiguous.applyRefusedBecause, 'ambiguous-apply-candidate', 'G10 by name');

  /* The core mutates nothing itself: it has no canonical write port at all. */
  const source = fs.readFileSync(MODULE, 'utf8');
  check(/importFullBundle|commitApplied|writeCanonical|upsert/.test(source) === false,
    'G11 the receive core has NO canonical mutation port - Apply is a handoff');
}

const verdict = failures.length === 0
  ? 'P02_O1_RECEIVE_COMPOSITION_PASS' : 'P02_O1_RECEIVE_COMPOSITION_FAIL';
console.log(JSON.stringify({
  verdict, assertions, failures,
  module: 'packages/core/sync-object-reconcile-v2.mjs',
  boundaries: {
    imports: 'sibling core modules only',
    desktop: 0, chrome: 0, filesystem: 0, sql: 0, tauri: 0, timers: 0,
    chatSchema: 0, webdav: 0, repositoryPaths: 0,
    objectDomain: 'flows as data; never interpreted'
  },
  authorityModel: 'Y-2 replays what a verified snapshot ADVERTISED; admitted '
    + 'evidence alone decides what still needs work',
  resultLanguage: 'every stage maps into the accepted T03 taxonomy',
  applyModel: 'handoff only - the core holds no canonical mutation port',
  realRepositoryTouched: false, canonicalStateTouched: false, processesLaunched: 0
}, null, 2));
process.exit(failures.length === 0 ? 0 : 1);
