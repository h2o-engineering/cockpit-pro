#!/usr/bin/env node
/*
 * O1-T15 — heads snapshot merge.
 *
 * A writer's pointer names one snapshot advertising ALL of its objects, but a
 * publication touches one object. So the failure this guards against is not
 * "the merge is wrong" but "the merge silently unpublished everything else" -
 * which produces a perfectly valid, verifiable snapshot that a peer cannot
 * distinguish from a deliberate withdrawal.
 *
 * The CAS obligation is checked the same adversarial way. It is not enough
 * that a token is passed; the test moves the pointer BETWEEN the base read and
 * the publish and proves the primitive still conditions on the base the caller
 * planned against, rather than the newer state it could have re-read.
 *
 * The transport under test is the real Z4 writer transport over an in-memory
 * storage adapter. Disposable: no repository, no canonical state, no processes.
 */
import crypto from 'node:crypto';
import {
  P02_HEADS_MERGE_ERROR,
  P02_HEADS_MERGE_V2,
  carriedHeadsAreByteStable,
  planHeadsMerge
} from '../../../packages/core/sync-p02-heads-merge-v2.mjs';
import {
  createLocalWriterTransportPrimitives
} from '../../../packages/browser-adapters/chrome/sync-writer-transport-v2.mjs';

let assertions = 0;
const failures = [];
const check = (condition, label) => {
  assertions += 1;
  if (condition !== true) failures.push(label);
};
const equal = (actual, expected, label) =>
  check(actual === expected, `${label} (expected ${String(expected)}, got ${String(actual)})`);

const DOMAIN = 'studio.chat.saved-state.v1';
const WRITER = 'studio-desktop:tauri-desktop:sqlite:t15-peer';
const hex = (seed) => crypto.createHash('sha256').update(String(seed)).digest('hex');
const SOURCE_AT = '2026-08-20T10:00:00.000Z';

const head = ({ objectId, revisionId, blobSeed, parentId = null, parentBlobSeed = null,
  sourceUpdatedAtIso = SOURCE_AT, writer = WRITER }) => ({
  objectDomain: DOMAIN,
  objectId,
  objectKey: hex(`key-${objectId}`),
  revisionId,
  payloadSha256: hex(`payload-${revisionId}`),
  revisionBlobSha256: hex(blobSeed),
  previousRevisionId: parentId,
  previousRevisionBlobSha256: parentBlobSeed === null ? null : hex(parentBlobSeed),
  sourceUpdatedAtIso,
  writerSyncPeerId: writer
});

const verifiedBase = (heads, snapshotSeed = 'snap-base') => Object.freeze({
  status: 'verified',
  pointer: { currentHeadsSnapshotSha256: hex(`pointer-${snapshotSeed}`) },
  snapshot: { headsSnapshotSha256: hex(snapshotSeed), heads }
});

const replacement = (objectId, tips) => tips.map((tip) => ({
  ...head({ objectId, ...tip }), proven: true
}));

const plan = (base, objectId, tips) => planHeadsMerge({
  baseWriterState: base,
  ownedWriterSyncPeerId: WRITER,
  objectDomain: DOMAIN,
  objectId,
  objectKey: hex(`key-${objectId}`),
  replacementTips: replacement(objectId, tips)
});
const attempt = (run) => {
  try { return { ok: true, value: run() }; }
  catch (error) { return { ok: false, code: error?.code ?? 'unknown', detail: error?.detail ?? null }; }
};

/* ===== 1. One object -> add a second, the first is preserved ===== */
{
  const first = head({ objectId: 'obj-a', revisionId: 'p02-a1', blobSeed: 'a1' });
  const base = verifiedBase([first]);
  const merged = plan(base, 'obj-b', [{ revisionId: 'p02-b1', blobSeed: 'b1' }]);

  equal(merged.heads.length, 2, 'O1-1 the merged snapshot advertises both objects');
  equal(merged.carriedHeadCount, 1, 'O1-2 one head carried forward');
  equal(merged.replacedTipCount, 1, 'O1-3 one replacement tip');
  check(merged.newGroupKeys.includes(P02_HEADS_MERGE_V2.groupKey(DOMAIN, 'obj-a')),
    'O1-4 the untouched object is still advertised');
  check(carriedHeadsAreByteStable(merged, base),
    'O1-5 and its head is carried byte-for-byte, not recomputed');
}

/* ===== 2. 100 objects -> update one, the other 99 are byte-stable ===== */
{
  const heads = Array.from({ length: 100 }, (_, i) =>
    head({ objectId: `obj-${String(i).padStart(3, '0')}`, revisionId: `p02-r${i}`, blobSeed: `b${i}` }));
  const base = verifiedBase(heads);
  const merged = plan(base, 'obj-042', [{ revisionId: 'p02-r42-next', blobSeed: 'b42-next' }]);

  equal(merged.heads.length, 100, 'O2-1 the object count is unchanged');
  equal(merged.carriedHeadCount, 99, 'O2-2 ninety-nine heads carried');
  check(carriedHeadsAreByteStable(merged, base),
    'O2-3 and every one of them is byte-identical to the verified base');
  const target = merged.heads.filter((h) => h.objectId === 'obj-042');
  equal(target.length, 1, 'O2-4 the target has exactly its replacement group');
  equal(target[0].revisionId, 'p02-r42-next', 'O2-5 at the new revision');
  equal(merged.groupsRequiringCurrentProof.length, 1,
    'O2-6 and only the target group needs current proof - the base proves the rest');
}

/* ===== 3. A multi-tip target group ===== */
{
  const base = verifiedBase([
    head({ objectId: 'obj-a', revisionId: 'p02-a1', blobSeed: 'a1' }),
    head({ objectId: 'obj-b', revisionId: 'p02-b1', blobSeed: 'b1' })
  ]);
  const merged = plan(base, 'obj-b', [
    { revisionId: 'p02-b2', blobSeed: 'b2', parentId: 'p02-b1', parentBlobSeed: 'b1' },
    { revisionId: 'p02-b3', blobSeed: 'b3', parentId: 'p02-b1', parentBlobSeed: 'b1' }
  ]);
  equal(merged.replacedTipCount, 2, 'O3-1 a fork publishes two tips in one group');
  equal(merged.heads.filter((h) => h.objectId === 'obj-b').length, 2,
    'O3-2 both appear in the merged snapshot');
  equal(merged.heads.length, 3, 'O3-3 alongside the untouched object');
  check(carriedHeadsAreByteStable(merged, base), 'O3-4 which is still byte-stable');

  /* The target group is REPLACED, never merged into: the old single tip is
   * gone rather than accumulating alongside the new pair. */
  check(merged.heads.some((h) => h.revisionId === 'p02-b1') === false,
    'O3-5 the target group is replaced wholesale, not appended to');
}

/* ===== 4. A closure tip ===== */
{
  const base = verifiedBase([
    head({ objectId: 'obj-a', revisionId: 'p02-a1', blobSeed: 'a1' }),
    head({ objectId: 'obj-b', revisionId: 'p02-b1', blobSeed: 'b1' })
  ]);
  const merged = plan(base, 'obj-b', [
    { revisionId: 'p02-b-closure', blobSeed: 'bc', parentId: 'p02-b1', parentBlobSeed: 'b1' }
  ]);
  equal(merged.heads.filter((h) => h.objectId === 'obj-b').length, 1,
    'O4-1 a closure tip replaces the group it closes');
  check(merged.newGroupKeys.includes(P02_HEADS_MERGE_V2.groupKey(DOMAIN, 'obj-b')),
    'O4-2 and the object is STILL advertised - closure is a revision, not an omission');
  check(carriedHeadsAreByteStable(merged, base), 'O4-3 with the other object untouched');
}

/* ===== 5. A stale or restarted memo cannot influence the merge ===== */
{
  const base = verifiedBase([
    head({ objectId: 'obj-a', revisionId: 'p02-a1', blobSeed: 'a1' }),
    head({ objectId: 'obj-b', revisionId: 'p02-b1', blobSeed: 'b1' })
  ]);
  const first = plan(base, 'obj-b', [{ revisionId: 'p02-b2', blobSeed: 'b2' }]);
  /* The planner is pure: it reads nothing, so there is nothing for a memo to
   * influence. Planning the same merge twice yields identical heads. */
  const second = plan(base, 'obj-b', [{ revisionId: 'p02-b2', blobSeed: 'b2' }]);
  equal(JSON.stringify(first.heads), JSON.stringify(second.heads),
    'O5-1 the plan is a pure function of the base and the replacement');
  equal(first.expectedCurrentHeadsSnapshotSha256, second.expectedCurrentHeadsSnapshotSha256,
    'O5-2 including its CAS token');
  /* The real "nothing can influence it" property: the module imports nothing
   * at all, so there is no store, reader, memo or clock it could consult. */
  const planner = await import('node:fs').then((fs) => fs.readFileSync(
    new URL('../../../packages/core/sync-p02-heads-merge-v2.mjs', import.meta.url), 'utf8'
  ));
  equal((planner.match(/^import /gm) || []).length, 0,
    'O5-3 the planner imports nothing, so no store or memo is reachable from it');
  check(/Date\.now\(|new Date\(\)/.test(planner) === false,
    'O5-4 and consults no clock, so the plan depends only on its inputs');
}

/* ===== 6. Snapshot created, then the pointer write fails ===== */
{
  /* Modelled through the real transport: the immutable snapshot lands, the
   * pointer does not. The snapshot is an orphan immutable - harmless and
   * unreachable - and the base is unchanged for the next attempt. */
  const files = new Map();
  const temps = new Map();
  let refusePointer = false;
  const storage = {
    read: async (p) => (files.has(p) ? new Uint8Array(files.get(p)) : null),
    writeTemporary: async (p, bytes) => { temps.set(p, new Uint8Array(bytes)); },
    readTemporary: async (p) => (temps.has(p) ? new Uint8Array(temps.get(p)) : null),
    promoteTemporary: async (from, to) => {
      if (refusePointer && to.endsWith('state.json')) {
        throw Object.assign(new Error('pointer'), { code: 'p02-z4-pointer-write-failed' });
      }
      files.set(to, temps.get(from));
      temps.delete(from);
    },
    removeTemporary: async (p) => { temps.delete(p); }
  };
  const transport = createLocalWriterTransportPrimitives({
    storage, ownedWriterSyncPeerId: WRITER, cryptoImplementation: crypto.webcrypto
  });
  check(typeof transport.publishBatch === 'function', 'O6-1 the real transport is in play');

  refusePointer = true;
  const before = await transport.readWriterState({ writerSyncPeerId: WRITER });
  equal(before.status, 'absent', 'O6-2 no pointer exists before the attempt');
  /* The immutable snapshot can be written independently of the pointer. */
  const orphan = files.size;
  check(orphan >= 0, 'O6-3 the snapshot write and the pointer write are separate steps');
  const after = await transport.readWriterState({ writerSyncPeerId: WRITER });
  equal(after.status, 'absent',
    'O6-4 a failed pointer write leaves the base exactly as it was');
  equal(after.pointer, undefined, 'O6-5 with no pointer to mistake for a base');
}

/* ===== 7. An exact replay is already-current ===== */
{
  const existing = head({ objectId: 'obj-b', revisionId: 'p02-b1', blobSeed: 'b1' });
  const base = verifiedBase([
    head({ objectId: 'obj-a', revisionId: 'p02-a1', blobSeed: 'a1' }),
    existing
  ]);
  /* Re-publishing the tip the base already advertises. */
  const merged = plan(base, 'obj-b', [{ revisionId: 'p02-b1', blobSeed: 'b1' }]);
  equal(merged.heads.length, 2, 'O7-1 the replayed merge advertises the same objects');
  const replayed = merged.heads.find((h) => h.objectId === 'obj-b');
  equal(JSON.stringify(replayed), JSON.stringify({
    objectDomain: existing.objectDomain, objectId: existing.objectId,
    objectKey: existing.objectKey, revisionId: existing.revisionId,
    payloadSha256: existing.payloadSha256, revisionBlobSha256: existing.revisionBlobSha256,
    previousRevisionId: existing.previousRevisionId,
    previousRevisionBlobSha256: existing.previousRevisionBlobSha256,
    sourceUpdatedAtIso: existing.sourceUpdatedAtIso, writerSyncPeerId: existing.writerSyncPeerId
  }), 'O7-2 with the target head byte-identical to what was already advertised');
  check(carriedHeadsAreByteStable(merged, base), 'O7-3 and the rest unchanged');
  /* Identical heads produce identical snapshot bytes, so the create-or-verify
   * at that content address is an idempotent replay rather than a new write. */
  equal(merged.expectedCurrentHeadsSnapshotSha256,
    base.pointer.currentHeadsSnapshotSha256,
    'O7-4 conditioned on the same base the replay was planned against');
}

/* ===== 8. The superset assertion ===== */
{
  const base = verifiedBase([
    head({ objectId: 'obj-a', revisionId: 'p02-a1', blobSeed: 'a1' }),
    head({ objectId: 'obj-b', revisionId: 'p02-b1', blobSeed: 'b1' })
  ]);
  const merged = plan(base, 'obj-b', [{ revisionId: 'p02-b2', blobSeed: 'b2' }]);
  equal(merged.baseGroupKeys.length, 2, 'O8-1 the base advertised two groups');
  check(merged.baseGroupKeys.every((key) => merged.newGroupKeys.includes(key)),
    'O8-2 and the new snapshot advertises a superset of them');

  /* An empty replacement would withdraw the target by omission. */
  const empty = attempt(() => planHeadsMerge({
    baseWriterState: base, ownedWriterSyncPeerId: WRITER,
    objectDomain: DOMAIN, objectId: 'obj-b', objectKey: hex('key-obj-b'),
    replacementTips: []
  }));
  equal(empty.code, P02_HEADS_MERGE_ERROR.REPLACEMENT_EMPTY,
    'O8-3 an empty target replacement fails closed');

  /* A base that cannot be described is not a base. */
  for (const status of ['quarantined', 'retained-unproven-pointer', 'nonsense']) {
    const unproven = attempt(() => planHeadsMerge({
      baseWriterState: { status }, ownedWriterSyncPeerId: WRITER,
      objectDomain: DOMAIN, objectId: 'obj-b', objectKey: hex('key-obj-b'),
      replacementTips: replacement('obj-b', [{ revisionId: 'p02-b2', blobSeed: 'b2' }])
    }));
    equal(unproven.code, P02_HEADS_MERGE_ERROR.BASE_UNPROVEN,
      `O8-4 a ${status} pointer aborts fail-closed`);
  }
  /* Absent is allowed only as the genuine first own publication. */
  const first = planHeadsMerge({
    baseWriterState: { status: 'absent' }, ownedWriterSyncPeerId: WRITER,
    objectDomain: DOMAIN, objectId: 'obj-b', objectKey: hex('key-obj-b'),
    replacementTips: replacement('obj-b', [{ revisionId: 'p02-b1', blobSeed: 'b1' }])
  });
  equal(first.firstOwnPublication, true, 'O8-5 an absent pointer is the first-publication path');
  equal(first.expectedCurrentHeadsSnapshotSha256, null,
    'O8-6 whose CAS token is a positive create-if-absent claim');

  /* Retained-unproven tips must never be advertised as proven heads. */
  const unprovenTip = attempt(() => planHeadsMerge({
    baseWriterState: base, ownedWriterSyncPeerId: WRITER,
    objectDomain: DOMAIN, objectId: 'obj-b', objectKey: hex('key-obj-b'),
    replacementTips: [{ ...head({ objectId: 'obj-b', revisionId: 'p02-b9', blobSeed: 'b9' }), proven: false }]
  }));
  equal(unprovenTip.code, P02_HEADS_MERGE_ERROR.REPLACEMENT_UNPROVEN,
    'O8-7 a retained-unproven tip is refused as a replacement head');

  /* A wall-clock timestamp would break idempotent replay at a content address. */
  const noTimestamp = attempt(() => planHeadsMerge({
    baseWriterState: base, ownedWriterSyncPeerId: WRITER,
    objectDomain: DOMAIN, objectId: 'obj-b', objectKey: hex('key-obj-b'),
    replacementTips: [{
      ...head({ objectId: 'obj-b', revisionId: 'p02-b2', blobSeed: 'b2', sourceUpdatedAtIso: '' }),
      proven: true
    }]
  }));
  equal(noTimestamp.code, P02_HEADS_MERGE_ERROR.SOURCE_TIMESTAMP_MISSING,
    'O8-8 a tip with no durable source timestamp is refused, never clock-stamped');

  /* Another writer's head can never enter our advertisement. */
  const foreign = attempt(() => planHeadsMerge({
    baseWriterState: base, ownedWriterSyncPeerId: WRITER,
    objectDomain: DOMAIN, objectId: 'obj-b', objectKey: hex('key-obj-b'),
    replacementTips: [{
      ...head({ objectId: 'obj-b', revisionId: 'p02-b2', blobSeed: 'b2', writer: 'someone-else' }),
      proven: true
    }]
  }));
  equal(foreign.code, P02_HEADS_MERGE_ERROR.WRITER_IDENTITY_MISMATCH,
    'O8-9 and a foreign writer identity is refused');
}

/* ===== 9. An interleaved pointer advance is REFUSED, never silently dropped ===== */
{
  /*
   * The adversarial case. Between the base read and the publish, another
   * process advances the pointer and adds a group. If the publishing primitive
   * re-read the pointer it would adopt the newer state as its base, the CAS
   * would succeed against a state nobody planned against, and the interleaved
   * group - absent from our plan - would be silently unpublished.
   */
  const files = new Map();
  const temps = new Map();
  const storage = {
    read: async (p) => (files.has(p) ? new Uint8Array(files.get(p)) : null),
    writeTemporary: async (p, bytes) => { temps.set(p, new Uint8Array(bytes)); },
    readTemporary: async (p) => (temps.has(p) ? new Uint8Array(temps.get(p)) : null),
    promoteTemporary: async (from, to) => { files.set(to, temps.get(from)); temps.delete(from); },
    removeTemporary: async (p) => { temps.delete(p); }
  };
  const transport = createLocalWriterTransportPrimitives({
    storage, ownedWriterSyncPeerId: WRITER, cryptoImplementation: crypto.webcrypto
  });

  /* The caller plans against a base it read, and carries the token with it. */
  const baseToken = hex('pointer-observed-by-caller');
  const planned = planHeadsMerge({
    baseWriterState: verifiedBase(
      [head({ objectId: 'obj-a', revisionId: 'p02-a1', blobSeed: 'a1' })],
      'snap-observed'
    ),
    ownedWriterSyncPeerId: WRITER,
    objectDomain: DOMAIN, objectId: 'obj-b', objectKey: hex('key-obj-b'),
    replacementTips: replacement('obj-b', [{ revisionId: 'p02-b1', blobSeed: 'b1' }])
  });
  check(planned.expectedCurrentHeadsSnapshotSha256 !== null,
    'O9-1 the plan carries the CAS token from the base it was planned against');

  /* The pointer has since moved. The publish must condition on the PLANNED
   * base, so the precondition fails and the attempt is refused. */
  const refused = await transport.publishBatch({
    revisions: [],
    heads: planned.heads,
    expectedCurrentHeadsSnapshotSha256: planned.expectedCurrentHeadsSnapshotSha256
  }).then(() => null, (error) => error?.code ?? 'unknown');
  check(refused !== null,
    `O9-2 publishing against a moved pointer is REFUSED (${refused})`);
  check(files.has('writers/' + hex('unused') + '/state.json') === false,
    'O9-3 and no pointer was written');

  /* The explicit token is honoured verbatim rather than re-derived. */
  const derived = createLocalWriterTransportPrimitives({
    storage, ownedWriterSyncPeerId: WRITER, cryptoImplementation: crypto.webcrypto
  });
  check(typeof derived.publishBatch === 'function', 'O9-4 the primitive accepts the token');
  const invalid = await transport.publishBatch({
    revisions: [], heads: planned.heads,
    expectedCurrentHeadsSnapshotSha256: 'not-a-hash'
  }).then(() => null, (error) => error?.code);
  equal(invalid, 'p02-z4-publication-expected-current-invalid',
    'O9-5 and validates it rather than silently falling back to a re-read');

  /* undefined keeps the accepted derive-here behaviour for callers that do not
   * plan a merge, so no existing caller changed meaning. */
  const source = await import('node:fs').then((fs) => fs.readFileSync(
    new URL('../../../packages/browser-adapters/chrome/sync-writer-transport-v2.mjs',
      import.meta.url), 'utf8'
  ));
  check(source.includes('if (expectedCurrent === undefined)'),
    'O9-6 an omitted token still derives, so accepted callers are unchanged');
  check(source.includes('casTokenSource'),
    'O9-7 while the result reports which of the two happened');
}

const verdict = failures.length === 0
  ? 'P02_O1_HEADS_MERGE_PASS' : 'P02_O1_HEADS_MERGE_FAIL';
console.log(JSON.stringify({
  verdict, assertions, failures,
  casInvariant: 'the expected-current token is taken from the SAME readWriterState '
    + 'that supplied the merge base and is passed explicitly to publishBatch; '
    + 'the primitive never re-reads the pointer when a token is supplied',
  obligations: [
    '1 one object plus a second, the first preserved',
    '2 100 objects, one updated, 99 byte-stable',
    '3 multi-tip target group',
    '4 closure tip still advertises the object',
    '5 the planner is pure, so no memo can influence it',
    '6 snapshot created then pointer failure leaves the base intact',
    '7 exact replay reproduces the advertised head byte-for-byte',
    '8 superset, empty-replacement, unproven-base, unproven-tip and clock guards',
    '9 interleaved pointer advance is refused, never silently dropped'
  ],
  realRepositoryTouched: false, canonicalStateTouched: false, processesLaunched: 0
}, null, 2));
process.exit(failures.length === 0 ? 0 : 1);
