#!/usr/bin/env node
/*
 * O1-T10 — Desktop v2 admission and branch-evidence writer.
 *
 * Every row below runs against the REAL v21 table, extracted from the accepted
 * migration ladder in lib.rs and executed by node:sqlite. A hand-written CREATE
 * TABLE would let a CHECK constraint drift out from under the writer without
 * anything noticing, which is precisely the class of bug this table's
 * constraints exist to catch.
 *
 * The format gate is consulted before anything else, so most rows below could
 * not even be reached in an unactivated repository - and one row proves exactly
 * that, because a derived cache is still a write into a repository we may have
 * no right to write into.
 *
 * DISPOSABLE: an in-memory SQLite database created and discarded per run. No
 * real profile, no real repository, no canonical state, no migration is added
 * or executed against anything durable, no processes.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { stagePackedGraph } from './p02-dist-graph.mjs';
import {
  P02_ADMISSION_DISPOSITION,
  P02_BRANCH_EVIDENCE_ERROR
} from '../../../packages/core/sync-branch-evidence-v2.mjs';
import { P02_CAPACITY_VERDICT } from '../../../packages/core/sync-evidence-capacity-v2.mjs';
import { P02_FORMAT_GATE_V2 } from '../../../packages/core/sync-format-gate-v2.mjs';

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
 * The Desktop surface imports its engine as `../core/`, which resolves inside
 * the PACKED tree - the packer performs no specifier rewriting, so a
 * dist-relative import is the correct and only form. Staging the packed graph
 * therefore also proves the module is packed correctly, which importing it from
 * source would not.
 */
const packed = stagePackedGraph();
const {
  P02_DESKTOP_ADMISSION_ERROR,
  P02_DESKTOP_ADMISSION_V2,
  createDesktopBranchEvidenceAdmission
} = await packed.importPacked('sync/sync-branch-evidence-desktop-v2.tauri.mjs');
const DOMAIN = P02_DESKTOP_ADMISSION_V2.CHAT_OBJECT_DOMAIN;
const WRITER = 'studio-desktop:tauri-desktop:sqlite:t10-peer';
const WRITER_OTHER = 'studio-desktop:tauri-desktop:sqlite:t10-other';
const OBJECT = 'chat-t10-a';
const OBJECT_B = 'chat-t10-b';

const sha = (text) => crypto.createHash('sha256').update(String(text)).digest('hex');
const objectKeyOf = (objectId) => sha(`${DOMAIN}\u0000${objectId}`);

/* The real v21 table, taken from the accepted migration ladder. */
function v21Sql() {
  const source = fs.readFileSync(
    path.join(root, 'apps/studio/desktop/src-tauri/src/lib.rs'), 'utf8'
  );
  const match = source.match(/version: 21,[\s\S]*?sql: r#"([\s\S]*?)"#,/);
  assert.ok(match, 'Desktop migration v21 is registered in the accepted ladder');
  assertions += 1;
  return match[1];
}

const ACTIVATED_LIBRARY_INFO = Object.freeze({
  schema: P02_FORMAT_GATE_V2.SCHEMA,
  formatVersion: 2,
  minimumCompatibleProtocolVersion: 2,
  layoutEpoch: 1
});

function rig() {
  const db = new DatabaseSync(':memory:');
  db.exec(v21Sql());
  const statements = [];
  const admission = createDesktopBranchEvidenceAdmission({
    clock: () => '2026-08-26T00:00:00.000Z',
    peerObjectKeyFor: async (writerSyncPeerId, objectKey) =>
      sha(`${sha(writerSyncPeerId)}\u0000${objectKey}`),
    sql: {
      select: async (query, values) => {
        statements.push(query);
        return db.prepare(query).all(...(values ?? []));
      },
      execute: async (query, values) => {
        statements.push(query);
        return db.prepare(query).run(...(values ?? []));
      }
    }
  });
  return { db, admission, statements };
}

const revision = ({
  revisionId, blobSeed, parentId = null, parentBlobSeed = null, closureType = null,
  selected = null
}) => ({
  revision: {
    schema: 'h2o.studio.syncRevision.v2',
    revisionId,
    previousRevisionId: parentId,
    previousRevisionBlobSha256: parentBlobSeed === null ? null : sha(parentBlobSeed),
    ...(closureType === null ? {} : { closureType }),
    ...(selected === null ? {} : { selectedRevision: selected })
  },
  revisionBlobSha256: sha(blobSeed)
});

const admit = (admission, spec, over = {}) => admission.admitRevision({
  objectId: OBJECT,
  objectKey: objectKeyOf(OBJECT),
  writerSyncPeerId: WRITER,
  libraryInfo: ACTIVATED_LIBRARY_INFO,
  ...revision(spec),
  ...over
});

const rows = (db) => db.prepare(
  `SELECT * FROM ${P02_DESKTOP_ADMISSION_V2.TABLE} ORDER BY revision_id`
).all();

const MINT_A = 'p02-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const MINT_B = 'p02-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const MINT_C = 'p02-cccccccccccccccccccccccccccccccc';
const MINT_D = 'p02-dddddddddddddddddddddddddddddddd';

/* ===== Gate: nothing is admitted into an unactivated repository ===== */
{
  const { admission, db } = rig();
  const unactivated = await admit(admission, { revisionId: MINT_A, blobSeed: 'a' },
    { libraryInfo: null }).then(() => null, (error) => error?.code);
  equal(unactivated, P02_DESKTOP_ADMISSION_ERROR.GATE_NOT_ACTIVATED,
    'G1 an unactivated repository refuses admission entirely');
  equal(rows(db).length, 0,
    'G2 and nothing is written - a derived cache is still a write');

  const quarantined = await admit(admission, { revisionId: MINT_A, blobSeed: 'a' },
    { legacyBaselineMatches: false }).then(() => null, (error) => error?.code);
  equal(quarantined, P02_DESKTOP_ADMISSION_ERROR.GATE_NOT_ACTIVATED,
    'G3 an N.3 legacy-artifact quarantine also refuses admission');

  const malformed = await admit(admission, { revisionId: MINT_A, blobSeed: 'a' },
    { libraryInfo: { schema: 'nope' } }).then(() => null, (error) => error?.code);
  equal(malformed, P02_DESKTOP_ADMISSION_ERROR.GATE_NOT_ACTIVATED,
    'G4 as does a malformed format authority');
}

/* ===== The superseded anchor rule is refused, not ignored ===== */
{
  const { admission } = rig();
  const refused = await admit(admission, { revisionId: MINT_A, blobSeed: 'a' },
    { canonicalAnchorRevisionId: 'snapshot-2026-08-25' }).then(() => null, (error) => error?.code);
  equal(refused, P02_DESKTOP_ADMISSION_ERROR.ANCHOR_SOURCE_REFUSED,
    'S1 a v1 canonical anchor is refused outright, never accepted and ignored');
}

/* ===== Row 1. A valid ROOT ===== */
{
  const { admission, db } = rig();
  const result = await admit(admission, { revisionId: MINT_A, blobSeed: 'a' });
  equal(result.disposition, P02_ADMISSION_DISPOSITION.ACCEPTED_LINEAR,
    'R1-1 a v2 ROOT is accepted');
  equal(result.persisted, true, 'R1-2 and persisted');
  const [row] = rows(db);
  equal(row.revision_id, MINT_A, 'R1-3 under its minted identity');
  equal(row.parent_revision_id, null, 'R1-4 with a null parent pair');
  equal(row.parent_revision_blob_sha256_hex, null, 'R1-5 on both halves');
  equal(row.proven, 1, 'R1-6 proven');
  equal(row.apply_state, 'not-applied',
    'R1-7 and NOT apply-eligible - admission never authorizes Apply');
}

/* ===== Row 2. A valid linear child ===== */
{
  const { admission, db } = rig();
  await admit(admission, { revisionId: MINT_A, blobSeed: 'a' });
  const child = await admit(admission, {
    revisionId: MINT_B, blobSeed: 'b', parentId: MINT_A, parentBlobSeed: 'a'
  });
  equal(child.disposition, P02_ADMISSION_DISPOSITION.ACCEPTED_LINEAR,
    'R2-1 a child of retained evidence is linear');
  equal(rows(db).length, 2, 'R2-2 both rows retained');
  const persisted = rows(db).find((r) => r.revision_id === MINT_B);
  equal(persisted.parent_revision_id, MINT_A, 'R2-3 recording the paired parent id');
  equal(persisted.parent_revision_blob_sha256_hex, sha('a'),
    'R2-4 and the paired parent blob - both halves, never one');
}

/* ===== Rows 3 and 4. Anchored at the published and applied pairs ===== */
{
  const { admission } = rig();
  /* The parent is NOT retained: it was published and pruned. This is the
   * steady case and the entire reason an anchor exists. */
  const viaPublished = await admit(admission, {
    revisionId: MINT_B, blobSeed: 'b', parentId: MINT_A, parentBlobSeed: 'a'
  }, {
    protocolState: { lastPublished: { revisionId: MINT_A, revisionBlobSha256: sha('a') } }
  });
  equal(viaPublished.disposition, P02_ADMISSION_DISPOSITION.ACCEPTED_LINEAR,
    'R3-1 a child anchored at the PUBLISHED pair is linear');
  equal(viaPublished.anchorPairs, 1, 'R3-2 one anchor pair was assembled from columns');

  const other = rig();
  const viaApplied = await admit(other.admission, {
    revisionId: MINT_C, blobSeed: 'c', parentId: MINT_D, parentBlobSeed: 'd'
  }, {
    protocolState: { lastApplied: { revisionId: MINT_D, revisionBlobSha256: sha('d') } }
  });
  equal(viaApplied.disposition, P02_ADMISSION_DISPOSITION.ACCEPTED_LINEAR,
    'R4-1 a child anchored at the APPLIED pair is linear too');

  /* Without the anchor the very same evidence is honestly unproven. */
  const bare = rig();
  const unanchored = await admit(bare.admission, {
    revisionId: MINT_B, blobSeed: 'b', parentId: MINT_A, parentBlobSeed: 'a'
  });
  equal(unanchored.disposition, P02_ADMISSION_DISPOSITION.RETAINED_UNPROVEN_PARENT,
    'R4-2 and without an anchor it is unproven, not proven by default');
}

/* ===== Row 5. Same id, wrong blob -> identity quarantine ===== */
{
  const { admission, db } = rig();
  await admit(admission, { revisionId: MINT_A, blobSeed: 'a' });
  const squat = await admit(admission, { revisionId: MINT_A, blobSeed: 'DIFFERENT' });
  equal(squat.disposition, P02_ADMISSION_DISPOSITION.QUARANTINED,
    'R5-1 the same identity with different bytes is quarantined');
  equal(squat.reason, P02_BRANCH_EVIDENCE_ERROR.IDENTITY_CONFLICT, 'R5-2 by name');
  equal(squat.applyEligible, false, 'R5-3 never Apply-eligible');
  equal(squat.capacity, P02_CAPACITY_VERDICT.INTEGRITY,
    'R5-4 and V9 classifies it as an integrity conflict, not a capacity event');

  /* An anchor claim with the wrong blob quarantines for the same reason. */
  const anchored = rig();
  const liar = await admit(anchored.admission, {
    revisionId: MINT_B, blobSeed: 'b', parentId: MINT_A, parentBlobSeed: 'WRONG'
  }, {
    protocolState: { lastPublished: { revisionId: MINT_A, revisionBlobSha256: sha('a') } }
  });
  equal(liar.disposition, P02_ADMISSION_DISPOSITION.QUARANTINED,
    'R5-5 naming the anchor id while recording other parent bytes quarantines');
  equal(liar.anchorConflict, true, 'R5-6 flagged as an anchor conflict');
}

/* ===== Row 6. Missing parent -> retained, waiting ===== */
{
  const { admission, db } = rig();
  const orphan = await admit(admission, {
    revisionId: MINT_C, blobSeed: 'c', parentId: 'p02-not-here-yet', parentBlobSeed: 'x'
  });
  equal(orphan.disposition, P02_ADMISSION_DISPOSITION.RETAINED_UNPROVEN_PARENT,
    'R6-1 a genuinely absent parent is retained, not quarantined');
  equal(orphan.applyEligible, false, 'R6-2 and not Apply-eligible while unproven');
  equal(rows(db).length, 1, 'R6-3 the evidence is kept durably');
  equal(rows(db)[0].proven, 0, 'R6-4 recorded as unproven');

  /* It heals with no operator action once the parent arrives. */
  await admit(admission, { revisionId: 'p02-not-here-yet', blobSeed: 'x' });
  const index = await admission.rebuildIndex({
    writerSyncPeerId: WRITER, objectId: OBJECT, objectKey: objectKeyOf(OBJECT)
  });
  check(index.provenRevisionIds.includes(MINT_C),
    'R6-5 and is promoted automatically once the parent arrives');
}

/* ===== Rows 7 and 8. Cycle and self-parent ===== */
{
  const { admission } = rig();
  const self = await admit(admission, {
    revisionId: MINT_A, blobSeed: 'a', parentId: MINT_A, parentBlobSeed: 'a'
  });
  equal(self.disposition, P02_ADMISSION_DISPOSITION.QUARANTINED,
    'R7-1 a self-parent is quarantined');
  equal(self.reason, 'self-parent', 'R7-2 by name');

  /* A cycle: A parents on B while B parents on A. The second arrival cannot
   * chain to a root, so it is unproven rather than silently accepted. */
  const cyclic = rig();
  await cyclic.admission.admitRevision({
    objectId: OBJECT, objectKey: objectKeyOf(OBJECT), writerSyncPeerId: WRITER,
    libraryInfo: ACTIVATED_LIBRARY_INFO,
    ...revision({ revisionId: MINT_A, blobSeed: 'a', parentId: MINT_B, parentBlobSeed: 'b' })
  });
  const closing = await cyclic.admission.admitRevision({
    objectId: OBJECT, objectKey: objectKeyOf(OBJECT), writerSyncPeerId: WRITER,
    libraryInfo: ACTIVATED_LIBRARY_INFO,
    ...revision({ revisionId: MINT_B, blobSeed: 'b', parentId: MINT_A, parentBlobSeed: 'a' })
  });
  check(closing.disposition !== P02_ADMISSION_DISPOSITION.ACCEPTED_LINEAR,
    'R8-1 a cycle is never accepted as linear');
  const cycleIndex = await cyclic.admission.rebuildIndex({
    writerSyncPeerId: WRITER, objectId: OBJECT, objectKey: objectKeyOf(OBJECT)
  });
  equal(cycleIndex.provenRevisionIds.length, 0,
    'R8-2 and neither member of a cycle is ever proven');
}

/* ===== Row 9. Excessive depth ===== */
{
  const { admission, db } = rig();
  /* Build a chain right up to the bound, then one past it. */
  let parentId = null;
  let parentSeed = null;
  for (let i = 0; i < P02_DESKTOP_ADMISSION_V2.MAX_EVIDENCE_DEPTH; i += 1) {
    const revisionId = `p02-${String(i).padStart(32, '0')}`;
    await admit(admission, { revisionId, blobSeed: `d${i}`, parentId, parentBlobSeed: parentSeed });
    parentId = revisionId;
    parentSeed = `d${i}`;
  }
  const atBound = rows(db).length;
  equal(atBound, P02_DESKTOP_ADMISSION_V2.MAX_EVIDENCE_DEPTH,
    'R9-1 a chain up to the bound is admitted');

  const tooDeep = await admit(admission, {
    revisionId: 'p02-toodeep000000000000000000000000',
    blobSeed: 'deep', parentId, parentBlobSeed: parentSeed
  });
  equal(tooDeep.disposition, P02_ADMISSION_DISPOSITION.QUARANTINED,
    'R9-2 one hop past the bound is refused');
  equal(tooDeep.reason, P02_DESKTOP_ADMISSION_ERROR.DEPTH_EXCEEDED, 'R9-3 by name');
  equal(tooDeep.persisted, false, 'R9-4 without writing anything');
  equal(rows(db).length, atBound, 'R9-5 and the retained chain is untouched');
}

/* ===== Row 10. A fork is retained, not resolved ===== */
{
  const { admission, db } = rig();
  await admit(admission, { revisionId: MINT_A, blobSeed: 'a' });
  const left = await admit(admission, {
    revisionId: MINT_B, blobSeed: 'b', parentId: MINT_A, parentBlobSeed: 'a'
  });
  const right = await admit(admission, {
    revisionId: MINT_C, blobSeed: 'c', parentId: MINT_A, parentBlobSeed: 'a'
  });
  equal(left.disposition, P02_ADMISSION_DISPOSITION.ACCEPTED_LINEAR,
    'R10-1 the first sibling is linear');
  /* The second sibling is RETAINED-DIVERGENT: it is structurally valid and
   * kept, but it is not linear - a fork has appeared, and calling it linear
   * would assert an ordering that admission has no authority to choose. */
  equal(right.disposition, P02_ADMISSION_DISPOSITION.RETAINED_DIVERGENT,
    'R10-2 the second sibling is retained as divergent, not declared linear');
  equal(right.applyEligible, false,
    'R10-2b and divergent evidence is never Apply-eligible');
  equal(rows(db).length, 3, 'R10-3 all three revisions retained');
  const index = await admission.rebuildIndex({
    writerSyncPeerId: WRITER, objectId: OBJECT, objectKey: objectKeyOf(OBJECT)
  });
  equal(index.liveLeafRevisionIds.length, 2,
    'R10-4 the fork is visible as two live leaves for Y-9 to classify');
}

/* ===== Row 11. Evidence capacity exhausted ===== */
{
  const { admission, db } = rig();
  const limited = createDesktopBranchEvidenceAdmission({
    clock: () => '2026-08-26T00:00:00.000Z',
    peerObjectKeyFor: async (peer, key) => sha(`${sha(peer)}\u0000${key}`),
    limits: { normalItems: 2, normalBytes: 1024, reserveItems: 1, reserveBytes: 512,
      hardItems: 3, hardBytes: 1536 },
    sql: {
      select: async (q, v) => db.prepare(q).all(...(v ?? [])),
      execute: async (q, v) => db.prepare(q).run(...(v ?? []))
    }
  });
  const one = { objectId: OBJECT, objectKey: objectKeyOf(OBJECT), writerSyncPeerId: WRITER,
    libraryInfo: ACTIVATED_LIBRARY_INFO };

  await limited.admitRevision({ ...one, ...revision({ revisionId: MINT_A, blobSeed: 'a' }) });
  await limited.admitRevision({ ...one,
    ...revision({ revisionId: MINT_B, blobSeed: 'b', parentId: MINT_A, parentBlobSeed: 'a' }) });
  const before = rows(db).length;

  /* Not recovery-critical, and the normal band is full. */
  const blocked = await limited.admitRevision({ ...one,
    ...revision({ revisionId: MINT_C, blobSeed: 'c', parentId: MINT_B, parentBlobSeed: 'b' }) });
  equal(blocked.admitted, false, 'R11-1 capacity refuses the admission');
  equal(blocked.blockedReason, 'capacity', 'R11-2 as a capacity block');
  equal(blocked.persisted, false, 'R11-3 nothing is written');
  equal(rows(db).length, before,
    'R11-4 and nothing already retained is evicted - the refusal is recoverable');
}

/* ===== Row 12. The recovery reserve is preserved ===== */
{
  const db = new DatabaseSync(':memory:');
  db.exec(v21Sql());
  const limited = createDesktopBranchEvidenceAdmission({
    clock: () => '2026-08-26T00:00:00.000Z',
    peerObjectKeyFor: async (peer, key) => sha(`${sha(peer)} ${key}`),
    limits: { normalItems: 1, normalBytes: 1024, reserveItems: 2, reserveBytes: 512,
      hardItems: 3, hardBytes: 4096 },
    sql: {
      select: async (q, v) => db.prepare(q).all(...(v ?? [])),
      execute: async (q, v) => db.prepare(q).run(...(v ?? []))
    }
  });
  const one = { objectId: OBJECT, objectKey: objectKeyOf(OBJECT), writerSyncPeerId: WRITER,
    libraryInfo: ACTIVATED_LIBRARY_INFO };

  /*
   * V9 "recovery-critical" is a property of the CANDIDATE relative to what is
   * already retained: the reserve exists for a revision that retained-but-
   * unproven evidence is waiting for. So the orphan comes first, and the
   * ancestor it needs is the thing the reserve must let through - refusing
   * that ancestor would strand the chain permanently.
   */
  const orphan = await limited.admitRevision({ ...one,
    ...revision({ revisionId: MINT_C, blobSeed: 'c', parentId: MINT_A, parentBlobSeed: 'a' }) });
  equal(orphan.disposition, P02_ADMISSION_DISPOSITION.RETAINED_UNPROVEN_PARENT,
    'R12-1 an orphan is retained while its ancestor is missing');

  /* The normal band is now full (normalItems: 1). An ORDINARY revision is
   * refused at exactly this point. */
  const ordinary = await limited.admitRevision({ ...one,
    ...revision({ revisionId: MINT_D, blobSeed: 'd' }) });
  equal(ordinary.admitted, false,
    'R12-2 with the normal band full, an ordinary revision is refused');
  equal(ordinary.blockedReason, 'capacity', 'R12-3 as a capacity block');

  /* The awaited ancestor, offered under identical pressure, reaches the
   * reserve instead - which is the whole point of holding one back. */
  const ancestor = await limited.admitRevision({ ...one,
    ...revision({ revisionId: MINT_A, blobSeed: 'a' }) });
  equal(ancestor.admitted, true,
    'R12-4 while the awaited ancestor is admitted under the same pressure');
  equal(ancestor.capacity, P02_CAPACITY_VERDICT.ADMIT_RESERVE, 'R12-5 through the reserve');
  equal(ancestor.recoveryCritical, true, 'R12-6 flagged as recovery-critical');
  equal(ancestor.recoveryClass, 'missing-ancestor', 'R12-7 with its V9 class');

  /* And admitting it heals the orphan, which is why the reserve was worth it. */
  const healed = await limited.rebuildIndex({
    writerSyncPeerId: WRITER, objectId: OBJECT, objectKey: objectKeyOf(OBJECT)
  });
  check(healed.provenRevisionIds.includes(MINT_C),
    'R12-8 and the stranded orphan is proven once its ancestor arrives');
}

/* ===== Row 13. Idempotent replay ===== */
{
  const { admission, db } = rig();
  const first = await admit(admission, { revisionId: MINT_A, blobSeed: 'a' });
  const replay = await admit(admission, { revisionId: MINT_A, blobSeed: 'a' });
  equal(replay.disposition, P02_ADMISSION_DISPOSITION.ACCEPTED_LINEAR,
    'R13-1 an identical replay keeps its disposition');
  equal(replay.replay, true, 'R13-2 and is reported as a replay');
  equal(replay.capacity, P02_CAPACITY_VERDICT.REPLAY,
    'R13-3 consuming no capacity');
  equal(rows(db).length, 1, 'R13-4 with no duplicate row');
  equal(first.disposition, replay.disposition, 'R13-5 and the same verdict as the first time');
}

/* ===== Row 14. Multiple objects are isolated ===== */
{
  const { admission, db } = rig();
  const a = { objectId: OBJECT, objectKey: objectKeyOf(OBJECT), writerSyncPeerId: WRITER,
    libraryInfo: ACTIVATED_LIBRARY_INFO };
  const b = { objectId: OBJECT_B, objectKey: objectKeyOf(OBJECT_B), writerSyncPeerId: WRITER,
    libraryInfo: ACTIVATED_LIBRARY_INFO };

  await admission.admitRevision({ ...a, ...revision({ revisionId: MINT_A, blobSeed: 'a' }) });
  /* Object B quarantines on a self-parent. */
  const poisoned = await admission.admitRevision({ ...b,
    ...revision({ revisionId: MINT_B, blobSeed: 'b', parentId: MINT_B, parentBlobSeed: 'b' }) });
  equal(poisoned.disposition, P02_ADMISSION_DISPOSITION.QUARANTINED,
    'R14-1 object B quarantines');

  /* Object A is entirely unaffected, and can still take a child. */
  const stillFine = await admission.admitRevision({ ...a,
    ...revision({ revisionId: MINT_C, blobSeed: 'c', parentId: MINT_A, parentBlobSeed: 'a' }) });
  equal(stillFine.disposition, P02_ADMISSION_DISPOSITION.ACCEPTED_LINEAR,
    'R14-2 while object A continues to admit normally');

  const aRows = await admission.retainedFor({ writerSyncPeerId: WRITER, objectKey: objectKeyOf(OBJECT) });
  equal(aRows.length, 2, 'R14-3 object A holds only its own evidence');
  check(aRows.every((r) => r.document.revisionId !== MINT_B),
    'R14-4 and never sees object B\'s');

  /* Isolation across WRITERS too: the same object from another peer is a
   * different evidence subtree. */
  const otherPeer = await admission.admitRevision({
    objectId: OBJECT, objectKey: objectKeyOf(OBJECT), writerSyncPeerId: WRITER_OTHER,
    libraryInfo: ACTIVATED_LIBRARY_INFO,
    ...revision({ revisionId: MINT_D, blobSeed: 'd' })
  });
  equal(otherPeer.disposition, P02_ADMISSION_DISPOSITION.ACCEPTED_LINEAR,
    'R14-5 another writer of the same object admits independently');
  const stillTwo = await admission.retainedFor({
    writerSyncPeerId: WRITER, objectKey: objectKeyOf(OBJECT)
  });
  equal(stillTwo.length, 2, 'R14-6 without appearing in the first writer\'s evidence');
  equal(rows(db).length, 4, 'R14-7 all four rows coexist under distinct peer-object keys');
}

/* ===== The cache really is derived ===== */
{
  const { admission, db } = rig();
  await admit(admission, { revisionId: MINT_A, blobSeed: 'a' });
  await admit(admission, {
    revisionId: MINT_B, blobSeed: 'b', parentId: MINT_A, parentBlobSeed: 'a'
  });
  const before = await admission.rebuildIndex({
    writerSyncPeerId: WRITER, objectId: OBJECT, objectKey: objectKeyOf(OBJECT)
  });

  /* Destroy the cache entirely and re-admit from the same evidence. */
  db.exec(`DELETE FROM ${P02_DESKTOP_ADMISSION_V2.TABLE}`);
  equal(rows(db).length, 0, 'D1 the derived cache can be dropped wholesale');
  await admit(admission, { revisionId: MINT_A, blobSeed: 'a' });
  await admit(admission, {
    revisionId: MINT_B, blobSeed: 'b', parentId: MINT_A, parentBlobSeed: 'a'
  });
  const after = await admission.rebuildIndex({
    writerSyncPeerId: WRITER, objectId: OBJECT, objectKey: objectKeyOf(OBJECT)
  });
  equal(JSON.stringify(after.provenRevisionIds), JSON.stringify(before.provenRevisionIds),
    'D2 and rebuilds to the same index - it is a cache, not authority');
  equal(after.liveLeafRevisionIds.join(','), before.liveLeafRevisionIds.join(','),
    'D3 including the same live leaves');
}

/* ===== No migration was added or executed ===== */
{
  const source = fs.readFileSync(
    path.join(root, 'apps/studio/desktop/src-tauri/src/lib.rs'), 'utf8'
  );
  const versions = [...source.matchAll(/version:\s*(\d+),/g)].map((m) => Number(m[1]));
  equal(Math.max(...versions), 22,
    'M1 the migration ladder still tops out at v22 - T10 added none');
  check(source.includes('sync_branch_evidence_state'),
    'M2 and the evidence table is still the one v21 created');
}

packed.dispose();

const verdict = failures.length === 0
  ? 'P02_O1_DESKTOP_V2_ADMISSION_PASS' : 'P02_O1_DESKTOP_V2_ADMISSION_FAIL';
console.log(JSON.stringify({
  verdict, assertions, failures,
  table: P02_DESKTOP_ADMISSION_V2.TABLE,
  schemaVersionUsed: 21,
  migrationsAdded: 0,
  anchorRule: 'T05 p02AnchorSet only; canonicalAnchorRevisionId refused',
  rows: [
    '1 valid ROOT', '2 valid linear child', '3 anchored at published pair',
    '4 anchored at applied pair', '5 same id wrong blob -> identity quarantine',
    '6 missing parent -> retained-unproven, heals', '7 self-parent', '8 cycle',
    '9 excessive depth', '10 fork retained not resolved',
    '11 capacity exhausted', '12 recovery reserve preserved',
    '13 idempotent replay', '14 multiple objects and writers isolated'
  ],
  realProfileTouched: false, realRepositoryTouched: false,
  canonicalStateTouched: false, processesLaunched: 0
}, null, 2));
process.exit(failures.length === 0 ? 0 : 1);
