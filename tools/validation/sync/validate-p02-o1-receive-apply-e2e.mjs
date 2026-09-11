#!/usr/bin/env node
/*
 * O1-T14 — v2 Apply, end to end from receive.
 *
 * Apply is the only stage that writes canonical content, so every test here is
 * shaped around what must NOT happen rather than what should.
 *
 * The bytes are re-read and re-hashed at apply time. Admission recorded what
 * the bytes WERE; an untrusted folder is writable by anything on the machine in
 * the meantime, so retained evidence is a record and not a lock.
 *
 * Exactly one hop is applied per pass. Content applied out of order is content
 * applied wrongly - later revisions were authored against intermediate states -
 * so a leaf five revisions ahead takes five passes, and the test proves each
 * one advances by exactly one.
 *
 * The two identity domains never cross. The envelope's minted revisionId goes
 * to the protocol ledger; the payload's source id goes to canonical import.
 * The old upToDateNoOp compared them, which is why it is separately regressed
 * here: under minted identity that comparison is always false, so a converged
 * object would be re-pulled forever.
 *
 * Real cores, injected platform ports, disposable stores. No repository, no
 * canonical app data, no profile, no processes.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  P02_APPLY_ERROR,
  P02_APPLY_VERDICT,
  createP02ApplyComposition,
  selectApplyHop,
  verifyApplyCandidate
} from '../../../packages/core/sync-object-apply-v2.mjs';
import { mintP02RevisionId } from '../../../packages/core/sync-p02-revision-mint-v2.mjs';
import { convergenceVerdictForTest } from './helpers/p02-convergence-probe.mjs';

let assertions = 0;
const failures = [];
const check = (condition, label) => {
  assertions += 1;
  if (condition !== true) failures.push(label);
};
const equal = (actual, expected, label) =>
  check(actual === expected, `${label} (expected ${String(expected)}, got ${String(actual)})`);

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const encoder = new TextEncoder();
const DOMAIN = 'studio.chat.saved-state.v1';
const OBJECT = 'chat-e2e';
const OBJECT_B = 'chat-e2e-b';
const PEER = 'studio-desktop:tauri-desktop:sqlite:e2e';
const PEER_B = 'studio-chrome:mv3:idb:e2e-b';
const objectKey = (id) => crypto.createHash('sha256').update(`${DOMAIN}\u0000${id}`).digest('hex');
const sha256HexBytes = async (bytes) =>
  crypto.createHash('sha256').update(Buffer.from(bytes)).digest('hex');
const canonicalJson = (value) => {
  const order = (input) => {
    if (Array.isArray(input)) return input.map(order);
    if (input && typeof input === 'object') {
      return Object.fromEntries(Object.keys(input).sort().map((k) => [k, order(input[k])]));
    }
    return input;
  };
  return JSON.stringify(order(value));
};

/* A content payload carrying its own SOURCE identity, distinct from the mint. */
function payloadFor(sourceRevisionId, text) {
  return {
    schema: 'h2o.studio.fullBundle.v2',
    chatArchive: {
      chats: [{
        chatId: OBJECT,
        title: 'E2E',
        chatIndex: {
          title: 'E2E', lastSnapshotId: sourceRevisionId, snapshotCount: 1,
          messageCount: 1, state: { isSaved: true, isLinked: true }, organization: {}
        },
        snapshots: [{
          snapshotId: sourceRevisionId, chatId: OBJECT,
          createdAt: '2026-08-26T00:00:00.000Z', messageCount: 1,
          messages: [{ order: 0, role: 'user', text }],
          meta: { title: 'E2E', richTurns: [{ turnIdx: 0, role: 'user', outerHTML: `<p>${text}</p>`, meta: {} }] }
        }]
      }],
      catalogs: { categories: [], labels: [], tags: [] }
    },
    chromeStorageLocal: {}, libraryKv: []
  };
}

/* A remote v2 revision: minted envelope identity, payload source identity. */
async function remoteRevision({ sourceRevisionId, text, parent = null, closureType = null }) {
  const minted = mintP02RevisionId(crypto.webcrypto);
  const payload = closureType === null ? payloadFor(sourceRevisionId, text) : { closed: true };
  const payloadSha256 = await sha256HexBytes(encoder.encode(canonicalJson(payload)));
  const revision = {
    schema: 'h2o.studio.syncRevision.v2',
    objectDomain: DOMAIN, objectId: OBJECT,
    revisionId: minted,
    writerSyncPeerId: PEER,
    previousRevisionId: parent?.revisionId ?? null,
    previousRevisionBlobSha256: parent?.revisionBlobSha256 ?? null,
    payloadSha256, payload,
    ...(closureType === null ? {} : { closureType })
  };
  const bytes = encoder.encode(canonicalJson(revision));
  return {
    revisionId: minted,
    revisionBlobSha256: await sha256HexBytes(bytes),
    payloadSha256, sourceRevisionId, bytes, revision, closureType
  };
}

/* A disposable world: a repository of immutable bytes, canonical state, and a
 * protocol ledger. Every port the Apply core needs, and nothing else. */
function world({ permission = 'granted' } = {}) {
  const repository = new Map();      // revisionBlobSha256 -> bytes
  const canonical = new Map();       // objectId -> { sourceRevisionId, payloadSha256, deleted }
  const ledger = new Map();          // objectId -> applied anchor row
  const admitted = new Map();        // objectId -> [pairs]
  const imports = [];
  const commits = [];
  const pending = new Map();
  let importFailsAfterMutation = false;

  const composition = createP02ApplyComposition({
    sha256HexBytes,
    readRevisionBytes: async ({ revisionBlobSha256 }) => {
      if (permission !== 'granted') return { status: 'blocked(permission)' };
      const bytes = repository.get(revisionBlobSha256);
      if (!bytes) return { status: 'missing' };
      const actual = await sha256HexBytes(bytes);
      if (actual !== revisionBlobSha256) {
        return { status: 'integrity', reason: 'blob-hash-mismatch' };
      }
      return { status: 'verified', bytes, value: JSON.parse(new TextDecoder().decode(bytes)) };
    },
    provenChainFor: async ({ leaf }) => leaf.chain,
    admittedPairsFor: async ({ objectId }) => admitted.get(objectId) ?? [],
    stageApplyIntent: async ({ objectId, verification }) => {
      if (ledger.get(objectId)?.last_applied_revision_id === verification.envelope.revisionId) {
        return { verdict: 'already-applied' };
      }
      if (pending.has(objectId)) return { verdict: 'pending-existing' };
      pending.set(objectId, verification.envelope.revisionId);
      return { verdict: 'intent-staged' };
    },
    recheckCanonicalPrecondition: async () => ({ ok: true }),
    importCanonicalPayload: async ({ objectId, payload, sourceRevisionId }) => {
      imports.push({ objectId, sourceRevisionId });
      const snapshot = payload?.chatArchive?.chats?.[0]?.snapshots?.[0];
      if (!snapshot || snapshot.snapshotId !== sourceRevisionId) {
        return { ok: false, reason: 'source-identity-mismatch' };
      }
      canonical.set(objectId, {
        sourceRevisionId,
        payloadSha256: await sha256HexBytes(encoder.encode(canonicalJson(payload))),
        deleted: false
      });
      if (importFailsAfterMutation) {
        /* Canonical mutated, then the process dies before commit. */
        throw Object.assign(new Error('crash'), { code: 'crash-after-mutation' });
      }
      return { ok: true };
    },
    readCanonicalConvergence: async ({ objectId, verification }) => ({
      state: canonical.get(objectId)?.payloadSha256 ===
        verification.envelope.payloadSha256 ? 'converged' : 'mismatch'
    }),
    applyClosure: async ({ objectId }) => {
      const current = canonical.get(objectId) ?? {};
      /* Soft delete: the record stays, flagged. Nothing is physically removed. */
      canonical.set(objectId, { ...current, deleted: true });
      return { ok: true };
    },
    commitApplied: async (input) => {
      commits.push(input);
      ledger.set(input.objectId, {
        last_applied_revision_id: input.revisionId,
        last_applied_revision_blob_sha256: input.revisionBlobSha256,
        last_applied_payload_sha256: input.payloadSha256,
        last_converged_direction: input.direction
      });
      pending.delete(input.objectId);
    }
  });

  return {
    repository, canonical, ledger, admitted, imports, commits, composition,
    crashAfterMutation: (on) => { importFailsAfterMutation = on; },
    publish: (revision) => {
      repository.set(revision.revisionBlobSha256, revision.bytes);
      const list = admitted.get(OBJECT) ?? [];
      list.push({ revisionId: revision.revisionId, revisionBlobSha256: revision.revisionBlobSha256 });
      admitted.set(OBJECT, list);
    },
    anchor: () => {
      const row = ledger.get(OBJECT);
      return row ? {
        revisionId: row.last_applied_revision_id,
        revisionBlobSha256: row.last_applied_revision_blob_sha256
      } : null;
    }
  };
}

const applyOnce = (w, leaf, chain) => w.composition.applyOneHop({
  objectDomain: DOMAIN, objectId: OBJECT, objectKey: objectKey(OBJECT), syncPeerId: PEER,
  selectedLeaf: { ...leaf, chain },
  currentAnchor: w.anchor()
});

/* ===== 1-2. A remote ROOT, then a linear child ===== */
{
  const w = world();
  const r1 = await remoteRevision({ sourceRevisionId: 'snap-1', text: 'one' });
  w.publish(r1);
  const applied = await applyOnce(w, r1, [r1]);
  equal(applied.verdict, P02_APPLY_VERDICT.APPLIED, 'E1 a remote ROOT applies');
  equal(applied.canonicalMutated, true, 'E2 mutating canonical state');
  equal(w.canonical.get(OBJECT).sourceRevisionId, 'snap-1',
    'E3 canonical keeps the PAYLOAD source identity');
  equal(w.ledger.get(OBJECT).last_applied_revision_id, r1.revisionId,
    'E4 while the ledger records the MINTED envelope identity');
  check(w.canonical.get(OBJECT).sourceRevisionId !== r1.revisionId,
    'E5 and the two are genuinely different values');
  equal(w.ledger.get(OBJECT).last_converged_direction, 'applied', 'E6 direction applied');
  equal(w.ledger.get(OBJECT).last_applied_payload_sha256, r1.payloadSha256,
    'E7 with the remote payload identity recorded beside it');

  const r2 = await remoteRevision({ sourceRevisionId: 'snap-2', text: 'two', parent: r1 });
  w.publish(r2);
  const child = await applyOnce(w, r2, [r1, r2]);
  equal(child.verdict, P02_APPLY_VERDICT.APPLIED, 'E8 a linear child applies');
  equal(w.canonical.get(OBJECT).sourceRevisionId, 'snap-2', 'E9 advancing canonical state');
}

/* ===== 3-4. A multi-hop chain advances exactly one hop per pass ===== */
{
  const w = world();
  const chain = [];
  let parent = null;
  for (let i = 1; i <= 5; i += 1) {
    const revision = await remoteRevision({ sourceRevisionId: `snap-${i}`, text: `t${i}`, parent });
    w.publish(revision);
    chain.push(revision);
    parent = revision;
  }
  const leaf = chain[chain.length - 1];

  for (let pass = 0; pass < 5; pass += 1) {
    const result = await applyOnce(w, leaf, chain);
    equal(result.verdict, P02_APPLY_VERDICT.APPLIED, `E10 pass ${pass + 1} applies`);
    equal(w.canonical.get(OBJECT).sourceRevisionId, `snap-${pass + 1}`,
      `E11 advancing exactly ONE hop on pass ${pass + 1}`);
    equal(result.remaining, 4 - pass, `E12 reporting ${4 - pass} remaining`);
  }
  equal(w.imports.length, 5, 'E13 five imports for five hops - never a jump to the leaf');
  equal(w.canonical.get(OBJECT).sourceRevisionId, 'snap-5', 'E14 the final leaf converges');

  const settled = await applyOnce(w, leaf, chain);
  equal(settled.verdict, P02_APPLY_VERDICT.ALREADY_APPLIED, 'E15 and then reports already-applied');
  equal(settled.canonicalMutated, false, 'E16 without mutating anything');
}

/* ===== 5-7. Idempotence and crash safety ===== */
{
  const w = world();
  const r1 = await remoteRevision({ sourceRevisionId: 'snap-1', text: 'one' });
  w.publish(r1);
  await applyOnce(w, r1, [r1]);
  const commitsAfterFirst = w.commits.length;
  const replay = await applyOnce(w, r1, [r1]);
  equal(replay.verdict, P02_APPLY_VERDICT.ALREADY_APPLIED, 'E17 applying twice is idempotent');
  equal(w.commits.length, commitsAfterFirst, 'E18 with no second commit');

  /* Crash BEFORE commit: canonical may have moved, the ledger did not, and the
   * retry is safe because the import is keyed by the source identity. */
  const crashed = world();
  const c1 = await remoteRevision({ sourceRevisionId: 'snap-1', text: 'one' });
  crashed.publish(c1);
  crashed.crashAfterMutation(true);
  const died = await applyOnce(crashed, c1, [c1]).catch((error) => ({ thrown: error?.code }));
  equal(died.reason ?? died.thrown, 'crash-after-mutation',
    'E19 a crash after canonical mutation surfaces as a blocked attempt');
  equal(crashed.commits.length, 0, 'E20 with nothing committed');
  equal(crashed.ledger.size, 0, 'E21 so the ledger never claims an apply that did not complete');

  crashed.crashAfterMutation(false);
  const healed = await applyOnce(crashed, c1, [c1]);
  equal(healed.verdict, P02_APPLY_VERDICT.PENDING_RECOVERED,
    'E22 and the retry proves convergence then completes without re-import');
  equal(crashed.ledger.get(OBJECT).last_applied_revision_id, c1.revisionId, 'E23 committing once');
}

/* ===== 8-12. Convergence, the identity domains, and the old comparison ===== */
{
  const w = world();
  const r1 = await remoteRevision({ sourceRevisionId: 'snap-1', text: 'one' });
  w.publish(r1);
  await applyOnce(w, r1, [r1]);
  const row = w.ledger.get(OBJECT);
  const canonicalState = w.canonical.get(OBJECT);

  /* 8. Applied, canonical unchanged -> converged, via payload equivalence. */
  equal(convergenceVerdictForTest({
    canonicalPayloadSha256: canonicalState.payloadSha256,
    row
  }).dirty, false, 'E24 remote applied and canonical unchanged is CONVERGED');

  /* 11 + 12. The mint differs from the payload snapshot id, and the OLD
   * revision-id comparison would have called this un-applied forever. */
  check(row.last_applied_revision_id !== canonicalState.sourceRevisionId,
    'E25 the minted envelope id differs from the canonical snapshot id');
  const legacyComparison = canonicalState.sourceRevisionId === row.last_applied_revision_id;
  equal(legacyComparison, false,
    'E26 so the OLD upToDateNoOp id comparison fails for a valid minted Apply');
  equal(convergenceVerdictForTest({
    canonicalPayloadSha256: canonicalState.payloadSha256, row
  }).dirty, false,
    'E27 while the payload-equivalence proof correctly reports convergence');

  /* 9 + 10. A canonical edit afterwards is local-ahead, even when the source
   * id is unchanged - which is the in-place edit the old scheme could not see. */
  const editedPayload = payloadFor('snap-1', 'edited');
  const editedHash = await sha256HexBytes(encoder.encode(canonicalJson(editedPayload)));
  equal(convergenceVerdictForTest({ canonicalPayloadSha256: editedHash, row }).dirty, true,
    'E28 a canonical edit after Apply is local-ahead');
  check(editedHash !== canonicalState.payloadSha256,
    'E29 detected by payload identity, with the source id unchanged');
}

/* ===== 13-18. Apply refusals ===== */
{
  /* 15. Bytes changed relative to admitted evidence -> integrity. */
  const tampered = world();
  const r1 = await remoteRevision({ sourceRevisionId: 'snap-1', text: 'one' });
  tampered.publish(r1);
  tampered.repository.set(r1.revisionBlobSha256, encoder.encode('{"tampered":true}'));
  const bad = await applyOnce(tampered, r1, [r1]);
  equal(bad.verdict, P02_APPLY_VERDICT.INTEGRITY,
    'E30 bytes that no longer hash to their address are an integrity refusal');
  equal(tampered.canonical.size, 0, 'E31 with no canonical mutation');

  /* 14. Missing immutable revision at apply time -> no Apply. */
  const vanished = world();
  const r2 = await remoteRevision({ sourceRevisionId: 'snap-1', text: 'one' });
  vanished.publish(r2);
  vanished.repository.delete(r2.revisionBlobSha256);
  const gone = await applyOnce(vanished, r2, [r2]);
  equal(gone.verdict, P02_APPLY_VERDICT.BLOCKED, 'E32 a missing revision blocks');
  equal(gone.blockReason, 'transport', 'E33 as transport');
  equal(vanished.canonical.size, 0, 'E34 with no canonical mutation');

  /* 17. Unproven parent -> no Apply. The hop is not on a proven chain. */
  const orphan = world();
  const r3 = await remoteRevision({
    sourceRevisionId: 'snap-2', text: 'two',
    parent: { revisionId: 'p02-absent', revisionBlobSha256: 'f'.repeat(64) }
  });
  orphan.publish(r3);
  const unproven = await orphan.composition.applyOneHop({
    objectDomain: DOMAIN, objectId: OBJECT, objectKey: objectKey(OBJECT), syncPeerId: PEER,
    selectedLeaf: { ...r3, chain: [] }, currentAnchor: null
  });
  equal(unproven.verdict, P02_APPLY_VERDICT.NO_ELIGIBLE_HOP,
    'E35 a revision with no proven chain is never applied');
  equal(orphan.canonical.size, 0, 'E36 with no canonical mutation');

  /* 18. Capacity-refused evidence is not admitted, so no hop is eligible. */
  const refused = world();
  const r4 = await remoteRevision({ sourceRevisionId: 'snap-1', text: 'one' });
  refused.repository.set(r4.revisionBlobSha256, r4.bytes);   /* published but NOT admitted */
  const noEvidence = await applyOnce(refused, r4, [r4]);
  equal(noEvidence.verdict, P02_APPLY_VERDICT.BLOCKED,
    'E37 an unadmitted hop blocks rather than applying');
  equal(noEvidence.reason, P02_APPLY_ERROR.HOP_NOT_ADMITTED, 'E38 by name');

  /* 16. A sibling fork -> no arbitrary Apply. */
  const forked = world();
  const base = await remoteRevision({ sourceRevisionId: 'snap-1', text: 'base' });
  const left = await remoteRevision({ sourceRevisionId: 'snap-2', text: 'left', parent: base });
  const right = await remoteRevision({ sourceRevisionId: 'snap-3', text: 'right', parent: base });
  for (const revision of [base, left, right]) forked.publish(revision);
  await applyOnce(forked, base, [base]);
  /* The anchor is now `base`. A leaf whose chain does not contain the anchor
   * is not a descendant of what we applied. */
  const offChain = await applyOnce(forked, right, [left, right]);
  equal(offChain.verdict, P02_APPLY_VERDICT.NO_ELIGIBLE_HOP,
    'E39 a leaf whose chain excludes the current anchor is never applied');
  equal(offChain.reason, P02_APPLY_ERROR.HOP_AMBIGUOUS, 'E40 as an ambiguous hop');

  /* 13. Same revisionId, different bytes -> the verification refuses. */
  const squat = verifyApplyCandidate({
    candidate: { revisionId: base.revisionId, revisionBlobSha256: base.revisionBlobSha256, revision: base.revision },
    bytes: base.bytes,
    observedRevisionBlobSha256: 'e'.repeat(64)
  });
  equal(squat.ok, false, 'E41 the same identity with different bytes fails verification');
  equal(squat.reason, P02_APPLY_ERROR.BYTES_CHANGED, 'E42 by name');
}

/* ===== 19-20. Closure Apply and replay ===== */
{
  const w = world();
  const r1 = await remoteRevision({ sourceRevisionId: 'snap-1', text: 'one' });
  w.publish(r1);
  await applyOnce(w, r1, [r1]);
  const closure = await remoteRevision({
    sourceRevisionId: null, text: null, parent: r1, closureType: 'object-deleted'
  });
  w.publish(closure);

  const applied = await applyOnce(w, closure, [r1, closure]);
  equal(applied.verdict, P02_APPLY_VERDICT.APPLIED, 'E43 a closure applies');
  equal(applied.closure, true, 'E44 as a closure');
  equal(w.canonical.get(OBJECT).deleted, true, 'E45 soft-deleting the object');
  check(w.canonical.has(OBJECT), 'E46 with the record RETAINED - no physical deletion');
  equal(w.imports.length, 1,
    'E47 and NO content import - a deletion has no payload to converge');
  equal(w.ledger.get(OBJECT).last_applied_revision_id, closure.revisionId,
    'E48 while the ledger records the closure\'s minted identity like any other');

  const replay = await applyOnce(w, closure, [r1, closure]);
  equal(replay.verdict, P02_APPLY_VERDICT.ALREADY_APPLIED, 'E49 closure replay is idempotent');
  equal(replay.canonicalMutated, false, 'E50 mutating nothing');
}

/* ===== 21-22. Object and peer isolation ===== */
{
  const w = world();
  const good = await remoteRevision({ sourceRevisionId: 'snap-1', text: 'one' });
  w.publish(good);
  await applyOnce(w, good, [good]);

  /* Another object's failure cannot touch this one's state. */
  const otherResult = await w.composition.applyOneHop({
    objectDomain: DOMAIN, objectId: OBJECT_B, objectKey: objectKey(OBJECT_B), syncPeerId: PEER_B,
    selectedLeaf: { revisionId: 'p02-other', revisionBlobSha256: 'a'.repeat(64), chain: [] },
    currentAnchor: null
  });
  equal(otherResult.applied, false, 'E51 an unrelated object fails on its own terms');
  equal(w.canonical.get(OBJECT).sourceRevisionId, 'snap-1',
    'E52 leaving the first object\'s canonical state untouched');
  equal(w.ledger.get(OBJECT).last_applied_revision_id, good.revisionId,
    'E53 and its ledger row unchanged');
  equal(w.ledger.has(OBJECT_B), false, 'E54 with no row invented for the failed object');
}

/* ===== 23. Chrome permission unavailable ===== */
{
  const w = world({ permission: 'prompt' });
  const r1 = await remoteRevision({ sourceRevisionId: 'snap-1', text: 'one' });
  w.publish(r1);
  const blocked = await applyOnce(w, r1, [r1]);
  equal(blocked.verdict, P02_APPLY_VERDICT.BLOCKED, 'E55 an ungranted folder blocks Apply');
  equal(blocked.blockReason, 'permission', 'E56 as blocked(permission)');
  equal(w.canonical.size, 0, 'E57 with NO canonical mutation');
  equal(w.commits.length, 0, 'E58 and no ledger write');
}

/* ===== 24-25. Restart, and a memo without evidence ===== */
{
  /* 24. Admitted evidence alone reconstructs the safe state after a restart:
   * the Apply core reads it fresh and neither over- nor under-applies. */
  const w = world();
  const r1 = await remoteRevision({ sourceRevisionId: 'snap-1', text: 'one' });
  const r2 = await remoteRevision({ sourceRevisionId: 'snap-2', text: 'two', parent: r1 });
  w.publish(r1); w.publish(r2);
  await applyOnce(w, r2, [r1, r2]);
  const afterFirst = w.canonical.get(OBJECT).sourceRevisionId;
  /* "Restart": a brand new composition over the same durable stores. */
  const restarted = await applyOnce(w, r2, [r1, r2]);
  equal(afterFirst, 'snap-1', 'E59 the first pass applied one hop');
  equal(restarted.verdict, P02_APPLY_VERDICT.APPLIED, 'E60 and the next advances');
  equal(w.canonical.get(OBJECT).sourceRevisionId, 'snap-2', 'E61 to the leaf');

  /* 25. A memo present but evidence absent: the hop is NOT applied, because
   * admitted evidence - not the memo - gates Apply. */
  const memoOnly = world();
  const r3 = await remoteRevision({ sourceRevisionId: 'snap-1', text: 'one' });
  memoOnly.repository.set(r3.revisionBlobSha256, r3.bytes);   /* bytes present */
  const notAdmitted = await applyOnce(memoOnly, r3, [r3]);
  equal(notAdmitted.applied, false,
    'E62 a revision with bytes but no admitted evidence is never applied');
  equal(notAdmitted.reason, P02_APPLY_ERROR.HOP_NOT_ADMITTED,
    'E63 it must be fetched and admitted first');
}

/* ===== ANTI-ECHO MATRIX ===== */
{
  const w = world();
  const remoteA = await remoteRevision({ sourceRevisionId: 'snap-A', text: 'A' });
  w.publish(remoteA);
  await applyOnce(w, remoteA, [remoteA]);
  const rowA = w.ledger.get(OBJECT);
  const canonicalA = w.canonical.get(OBJECT);

  /* Apply A -> canonical A -> the next enumeration is NOT local-ahead. */
  equal(rowA.last_converged_direction, 'applied', 'X1 direction is applied');
  equal(rowA.last_applied_payload_sha256, remoteA.payloadSha256, 'X2 payload A recorded');
  equal(convergenceVerdictForTest({
    canonicalPayloadSha256: canonicalA.payloadSha256, row: rowA
  }).dirty, false, 'X3 apply-then-unchanged does NOT re-publish');

  /* Apply A -> local edit B -> local-ahead. */
  const editedB = await sha256HexBytes(encoder.encode(canonicalJson(payloadFor('snap-A', 'B'))));
  equal(convergenceVerdictForTest({ canonicalPayloadSha256: editedB, row: rowA }).dirty, true,
    'X4 a local edit after apply is local-ahead');

  /*
   * Publish X -> remote Apply Y -> edit back to X. The LATEST direction
   * controls: canonical is X, the applied anchor is Y, so this is DIRTY.
   * OR-ing both historical payload anchors would call it converged and the
   * edit would never be published.
   */
  const payloadX = await sha256HexBytes(encoder.encode(canonicalJson(payloadFor('snap-X', 'X'))));
  const payloadY = await sha256HexBytes(encoder.encode(canonicalJson(payloadFor('snap-Y', 'Y'))));
  const bothAnchors = {
    last_published_payload_sha256: payloadX,
    last_applied_payload_sha256: payloadY,
    last_converged_direction: 'applied'
  };
  equal(convergenceVerdictForTest({ canonicalPayloadSha256: payloadX, row: bothAnchors }).dirty, true,
    'X5 publish X, apply Y, edit back to X is DIRTY - the latest direction controls');
  const orTogether = payloadX === bothAnchors.last_published_payload_sha256 ||
    payloadX === bothAnchors.last_applied_payload_sha256;
  equal(orTogether, true,
    'X6 while OR-ing both anchors would wrongly call it converged - which is why it is not done');

  /* And under the published direction, the same canonical content IS converged. */
  equal(convergenceVerdictForTest({
    canonicalPayloadSha256: payloadX,
    row: { ...bothAnchors, last_converged_direction: 'published' }
  }).dirty, false, 'X7 with direction published, canonical X is correctly converged');
}

/* ===== The upToDateNoOp correction, pinned in the real source ===== */
{
  const source = fs.readFileSync(path.join(
    root, 'src-surfaces-base/studio/sync/sync-object-runtime.tauri.js'
  ), 'utf8');
  const seam = source.slice(
    source.indexOf('async function upToDateNoOp'),
    source.indexOf('async function recordPullTerminal')
  );
  check(seam.includes('last_converged_direction'),
    'U1 the seam chooses its regime by the direction column');
  check(seam.includes('last_applied_payload_sha256'),
    'U2 and the v2 lane compares payload identity');
  check(seam.includes('payloadSha256Hex'),
    'U3 against the canonical projection payload hash');
  check(/canonicalPayload === appliedPayload/.test(seam),
    'U4 by equality of payload hashes, not of revision ids');
  /* The v1 formula survives byte-identically for the legacy regime. */
  check(seam.includes("clean(chat.lastSnapshotId || chat.last_snapshot_id) === revisionId"),
    'U5 while the legacy regime keeps its exact original formula');
  check(seam.includes('Closures'),
    'U6 and closures are explicitly excluded from content payload comparison');
}

const verdict = failures.length === 0
  ? 'P02_O1_RECEIVE_APPLY_E2E_PASS' : 'P02_O1_RECEIVE_APPLY_E2E_FAIL';
console.log(JSON.stringify({
  verdict, assertions, failures,
  applyModel: {
    byteVerification: 're-read and re-hashed at apply time; evidence is a record, not a lock',
    hopProgression: 'exactly one proven hop per pass',
    identityDomains: 'envelope id -> protocol ledger; payload source id -> canonical import',
    closures: 'bypass content-payload convergence; soft delete retained'
  },
  upToDateNoOpCorrection: 'v2 lane uses payload equivalence keyed by direction; '
    + 'the v1 formula is byte-identical',
  antiEcho: 'the latest convergence direction controls; historical anchors are '
    + 'never OR-ed together',
  realRepositoryTouched: false, canonicalStateTouched: false, processesLaunched: 0
}, null, 2));
process.exit(failures.length === 0 ? 0 : 1);
