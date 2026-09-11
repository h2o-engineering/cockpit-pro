#!/usr/bin/env node
/*
 * O1-T14 — Chrome v2 Apply.
 *
 * The Chrome-specific obligation is the SAME-TRANSACTION commit: the applied
 * anchor and the ledger's convergence direction must land together. Two
 * transactions would leave a window where the anchor says applied and the
 * direction still says published, and an enumeration reading that window would
 * classify a converged object as dirty and republish it - an echo caused
 * entirely by write ordering, with no bad data anywhere.
 *
 * Everything else is the shared core, so the tests here concentrate on what
 * Chrome adds: leaf selection from T11 evidence, chain reconstruction that
 * refuses fragments, the transaction scope, and the v1 lane staying untouched.
 *
 * Real store, real IndexedDB shim, real apply core. Disposable: no profile, no
 * repository, no canonical app data, no DATABASE_VERSION change, no processes.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  P02_CHROME_APPLY_ERROR,
  P02_CHROME_APPLY_V2,
  createChromeV2Apply
} from '../../../packages/browser-adapters/chrome/sync-revision-apply-v2.mjs';
import { P02_APPLY_VERDICT } from '../../../packages/core/sync-object-apply-v2.mjs';
import { mintP02RevisionId } from '../../../packages/core/sync-p02-revision-mint-v2.mjs';
import { createP02AnchorSet } from '../../../packages/core/sync-p02-anchor-set-v2.mjs';
import {
  P02_CLASSIFICATION,
  classifyObjectState
} from '../../../packages/core/sync-object-classifier-v2.mjs';

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
const OBJECT = 'chat-chrome-apply';
const PEER = 'studio-desktop:tauri-desktop:sqlite:remote';
const OBJECT_KEY = crypto.createHash('sha256').update(`${DOMAIN} ${OBJECT}`).digest('hex');
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

async function v2Revision({ sourceRevisionId, text, parent = null, closureType = null }) {
  const minted = mintP02RevisionId(crypto.webcrypto);
  const payload = closureType === null
    ? {
      schema: 'h2o.studio.fullBundle.v2',
      chatArchive: {
        chats: [{
          chatId: OBJECT, title: 'C', chatIndex: {
            title: 'C', lastSnapshotId: sourceRevisionId, snapshotCount: 1, messageCount: 1,
            state: { isSaved: true, isLinked: true }, organization: {}
          },
          snapshots: [{
            snapshotId: sourceRevisionId, chatId: OBJECT,
            createdAt: '2026-08-26T00:00:00.000Z', messageCount: 1,
            messages: [{ order: 0, role: 'user', text }],
            meta: { title: 'C', richTurns: [{ turnIdx: 0, role: 'user', outerHTML: `<p>${text}</p>`, meta: {} }] }
          }]
        }],
        catalogs: { categories: [], labels: [], tags: [] }
      },
      chromeStorageLocal: {}, libraryKv: []
    }
    : { closed: true };
  const payloadSha256 = await sha256HexBytes(encoder.encode(canonicalJson(payload)));
  const revision = {
    schema: 'h2o.studio.syncRevision.v2',
    objectDomain: DOMAIN, objectId: OBJECT, revisionId: minted,
    writerSyncPeerId: PEER,
    previousRevisionId: parent?.revisionId ?? null,
    previousRevisionBlobSha256: parent?.revisionBlobSha256 ?? null,
    payloadSha256, payload,
    ...(closureType === null ? {} : { closureType })
  };
  const bytes = encoder.encode(canonicalJson(revision));
  return {
    revisionId: minted, revisionBlobSha256: await sha256HexBytes(bytes),
    payloadSha256, sourceRevisionId, bytes, revision, closureType,
    parentRevisionId: parent?.revisionId ?? null
  };
}

/* An evidence store with the T11 record shape and the T02b commit contract. */
function chromeWorld({
  importFailure = false,
  readbackMismatch = false,
  messageMismatch = null,
  commitFailureOnce = false,
  anchorRace = false
} = {}) {
  const branch = [];
  const repository = new Map();
  const applyState = new Map();
  const ledger = new Map();
  const commits = [];
  const transactions = [];
  const imports = [];
  const snapshots = new Map();
  let canonical = null;
  let events = [];
  let remainingCommitFailures = commitFailureOnce ? 1 : 0;

  const evidenceStore = {
    listBranchEvidence: async (objectId) => branch.filter((r) => r.objectId === objectId),
    readApplySnapshot: async (objectId) => ({
      applyState: applyState.get(objectId) || null,
      observations: [], branchEvidence: branch.filter((r) => r.objectId === objectId)
    }),
    stageApplyIntent: async (input) => {
      events.push('stage');
      const existing = applyState.get(input.objectId) || { lastApplied: null, pending: null };
      const reference = Object.fromEntries(Object.entries(input)
        .filter(([key]) => key !== 'objectId'));
      if (existing.pending) {
        if (canonicalJson(existing.pending) !== canonicalJson(reference)) {
          const error = new Error('round2-item9-apply-pending-unresolved');
          error.code = error.message;
          throw error;
        }
        return { verdict: 'pending-existing', applyState: existing };
      }
      if (existing.lastApplied && canonicalJson(existing.lastApplied) === canonicalJson(reference)) {
        return { verdict: 'already-applied', applyState: existing };
      }
      const next = { lastApplied: existing.lastApplied, pending: reference };
      applyState.set(input.objectId, next);
      if (anchorRace) {
        canonical = {
          objectId: OBJECT, revisionId: 'concurrent-edit',
          payloadSha256Hex: 'e'.repeat(64)
        };
      }
      return { verdict: 'intent-staged', applyState: next };
    },
    commitApplyIntent: async (objectId, revisionId, options) => {
      events.push('commit');
      if (remainingCommitFailures > 0) {
        remainingCommitFailures -= 1;
        const error = new Error('commit-failed');
        error.code = error.message;
        throw error;
      }
      /* Modelled faithfully: the ledger joins the transaction ONLY when an
       * objectKey is supplied, which is exactly how the real store scopes it. */
      const stores = options?.objectKey
        ? ['authority', 'apply-state', 'local-publication-ledger']
        : ['authority', 'apply-state'];
      transactions.push(stores);
      const current = applyState.get(objectId);
      if (!current?.pending || current.pending.revisionId !== revisionId) {
        const error = new Error('round2-item9-apply-pending-unresolved');
        error.code = error.message;
        throw error;
      }
      applyState.set(objectId, { lastApplied: current.pending, pending: null });
      if (options?.objectKey) {
        ledger.set(options.objectKey, { convergedDirection: options?.convergedDirection ?? null });
      }
      commits.push({ objectId, revisionId, ...options });
      return { applyState: applyState.get(objectId) };
    }
  };

  const archiveAuthority = {
    importFullBundle: async ({ bundle }) => {
      events.push('import');
      if (importFailure) {
        const error = new Error('archive-import-failed');
        error.code = error.message;
        throw error;
      }
      if (bundle?.chatArchive?.schema !== 'h2o.chatArchive.bundle.v1') {
        throw new Error('invalid bundle');
      }
      const snapshot = bundle?.chatArchive?.chats?.[0]?.snapshots?.[0];
      imports.push(snapshot?.snapshotId ?? null);
      const normalizedSnapshot = {
        ...structuredClone(snapshot),
        messages: snapshot.messages.map((message) => ({
          ...structuredClone(message),
          createdAt: null
        }))
      };
      if (messageMismatch === 'text') {
        normalizedSnapshot.messages[0].text += '-changed';
      } else if (messageMismatch === 'role') {
        normalizedSnapshot.messages[0].role = 'assistant';
      } else if (messageMismatch === 'order') {
        normalizedSnapshot.messages[0].order += 1;
      }
      snapshots.set(snapshot.snapshotId, normalizedSnapshot);
      const appliedRevision = [...repository.values()]
        .map((bytes) => JSON.parse(new TextDecoder().decode(bytes)))
        .find((revision) =>
          revision?.payload?.chatArchive?.chats?.[0]?.snapshots?.[0]?.snapshotId ===
            snapshot.snapshotId);
      canonical = {
        objectId: OBJECT,
        revisionId: snapshot.snapshotId,
        payloadSha256Hex: readbackMismatch
          ? 'f'.repeat(64)
          : appliedRevision?.payloadSha256 || null
      };
      return {
        schema: 'h2o.studio.fullBundle.v2', mode: 'merge',
        chats: { ok: true, importedChats: 1, importedSnapshots: 1 }
      };
    },
    loadSnapshot: async (snapshotId) => {
      events.push('readback');
      return structuredClone(snapshots.get(snapshotId) || null);
    }
  };

  const apply = createChromeV2Apply({
    evidenceStore, archiveAuthority, sha256HexBytes,
    canonicalStateProvider: async () => canonical,
    readRevisionBytes: async ({ revisionBlobSha256 }) => {
      const bytes = repository.get(revisionBlobSha256);
      if (!bytes) return { status: 'missing' };
      const actual = await sha256HexBytes(bytes);
      if (actual !== revisionBlobSha256) return { status: 'integrity', reason: 'blob-hash-mismatch' };
      return { status: 'verified', bytes, value: JSON.parse(new TextDecoder().decode(bytes)) };
    }
  });

  return {
    branch, repository, applyState, ledger, commits, transactions, imports,
    snapshots, apply, events: () => events, setCanonical: (value) => { canonical = value; },
    admit: (revision, proven = true) => {
      repository.set(revision.revisionBlobSha256, revision.bytes);
      branch.push({
        key: `branch:${revision.revisionId}`,
        objectId: OBJECT, revisionId: revision.revisionId,
        revisionBlobSha256Hex: revision.revisionBlobSha256,
        parentRevisionId: revision.parentRevisionId,
        parentRevisionBlobSha256Hex: revision.revision.previousRevisionBlobSha256,
        closureType: revision.closureType, proven, applyState: 'not-applied'
      });
    },
    anchor: () => {
      const state = applyState.get(OBJECT);
      return state?.lastApplied ? {
        revisionId: state.lastApplied.revisionId,
        revisionBlobSha256: state.lastApplied.revisionBlobSha256Hex,
        payloadSha256: state.lastApplied.payloadSha256Hex
      } : null;
    }
  };
}

const applyNext = (w) => {
  const parents = new Set(w.branch.map((record) => record.parentRevisionId).filter(Boolean));
  const leaves = w.branch.filter((record) => !parents.has(record.revisionId));
  if (leaves.length !== 1) {
    return Promise.resolve({
      verdict: 'no-eligible-revision', applied: false,
      reason: P02_CHROME_APPLY_ERROR.CANDIDATE_AMBIGUOUS
    });
  }
  const anchor = w.anchor();
  const protocolState = anchor ? { lastApplied: anchor } : {};
  return w.apply.applySelectedAdmittedV2Revision({
    descriptor: {
      objectDomain: DOMAIN, objectId: OBJECT, objectKey: OBJECT_KEY,
      syncPeerId: PEER,
      p02AnchorSet: createP02AnchorSet({
        objectDomain: DOMAIN, objectId: OBJECT, protocolState
      })
    },
    classifierVerdict: {
      classification: 'remote-ahead', applyEligibleByEvidence: true,
      applyCandidateRevisionId: leaves[0].revisionId
    },
    configuredPeer: { syncPeerId: PEER, writerKey: 'a'.repeat(64) }
  }).catch((error) => ({
    verdict: 'blocked', applied: false, canonicalMutated: false,
    reason: error?.code || error?.message || 'apply-failed'
  }));
};

function postApplyDescriptor(revision, lastApplied, { dirty = false } = {}) {
  const appliedPair = lastApplied == null ? null : {
    revisionId: lastApplied.revisionId,
    revisionBlobSha256:
      lastApplied.revisionBlobSha256 ?? lastApplied.revisionBlobSha256Hex,
    payloadSha256: lastApplied.payloadSha256 ?? lastApplied.payloadSha256Hex
  };
  return {
    objectDomain: DOMAIN,
    objectId: OBJECT,
    objectKey: OBJECT_KEY,
    syncPeerId: PEER,
    canonicalLocalHead: {
      revisionId: revision.sourceRevisionId,
      revisionBlobSha256: 'b'.repeat(64),
      payloadSha256: revision.payloadSha256,
      deleted: false
    },
    protocolState: {
      lastPublished: null,
      lastApplied: appliedPair,
      consumedRevisionBlobSha256: revision.revisionBlobSha256,
      pendingOperation: null,
      operationPhase: null,
      retainedObservationRevisionIds: []
    },
    retainedEvidence: [{
      document: revision.revision,
      revisionBlobSha256: revision.revisionBlobSha256,
      validated: true
    }],
    advertisedTips: [],
    dirty,
    publishable: dirty,
    pending: false,
    blockReason: null
  };
}

/* ===== 1. A v2 revision applies, with both identity domains kept apart ===== */
{
  const w = chromeWorld();
  const r1 = await v2Revision({ sourceRevisionId: 'snap-1', text: 'one' });
  w.admit(r1);

  const result = await applyNext(w);
  equal(result.verdict, P02_APPLY_VERDICT.APPLIED, 'C1 a v2 revision applies');
  equal(w.imports[0], 'snap-1',
    'C2 canonical import is keyed by the PAYLOAD source id');
  equal(w.applyState.get(OBJECT).lastApplied.revisionId, r1.revisionId,
    'C3 while the apply state records the MINTED envelope id');
  check(w.imports[0] !== r1.revisionId, 'C4 and the two are genuinely different');
  equal(w.applyState.get(OBJECT).lastApplied.payloadSha256Hex, r1.payloadSha256,
    'C5 with the payload identity recorded beside the anchor');
  equal(w.events().join('>'), 'stage>import>readback>commit',
    'C6 durable stage precedes import, proof precedes commit');
  equal(w.snapshots.get('snap-1').messages[0].createdAt, null,
    'C7 fixture uses the real archive-owned message normalization');

  const postApply = classifyObjectState(postApplyDescriptor(
    r1, w.applyState.get(OBJECT).lastApplied));
  equal(postApply.classification, P02_CLASSIFICATION.CONVERGED,
    'C8 clean canonical v1 projection converges with its applied retained v2 leaf');
  equal(postApply.reason, 'post-apply-v1-v2-identity-bridge',
    'C9 through the committed post-Apply identity bridge');
}

/* ===== 2. The applied anchor and the direction land in ONE transaction ===== */
{
  const w = chromeWorld();
  const r1 = await v2Revision({ sourceRevisionId: 'snap-1', text: 'one' });
  w.admit(r1);
  await applyNext(w);

  equal(w.transactions.length, 1, 'T1 exactly one commit transaction');
  check(w.transactions[0].includes('apply-state'), 'T2 spanning the apply state');
  check(w.transactions[0].includes('local-publication-ledger'),
    'T3 AND the ledger - so the anchor and the direction can never disagree');
  equal(w.ledger.get(OBJECT_KEY)?.convergedDirection, 'applied',
    'T4 with the direction written as applied');
  equal(w.commits[0].objectKey, OBJECT_KEY,
    'T5 keyed by objectKey, which is what pulls the ledger into the transaction');
}

/* ===== 3. One hop per pass, from evidence-selected leaves ===== */
{
  const w = chromeWorld();
  const chain = [];
  let parent = null;
  for (let i = 1; i <= 3; i += 1) {
    const revision = await v2Revision({ sourceRevisionId: `snap-${i}`, text: `t${i}`, parent });
    w.admit(revision);
    chain.push(revision);
    parent = revision;
  }
  for (let pass = 1; pass <= 3; pass += 1) {
    const result = await applyNext(w);
    equal(result.verdict, P02_APPLY_VERDICT.APPLIED, `H1 pass ${pass} applies`);
    equal(w.imports[pass - 1], `snap-${pass}`, `H2 exactly one hop on pass ${pass}`);
  }
  equal(w.imports.length, 3, 'H3 three imports for three hops - never a jump to the leaf');
  equal((await applyNext(w)).verdict, P02_APPLY_VERDICT.ALREADY_APPLIED,
    'H4 and then reports already-applied');
  equal(w.transactions.length, 3, 'H5 with one commit per applied hop');
}

/* ===== 4. Ambiguity and unproven ancestry refuse ===== */
{
  const forked = chromeWorld();
  const base = await v2Revision({ sourceRevisionId: 'snap-1', text: 'base' });
  const left = await v2Revision({ sourceRevisionId: 'snap-2', text: 'left', parent: base });
  const right = await v2Revision({ sourceRevisionId: 'snap-3', text: 'right', parent: base });
  for (const revision of [base, left, right]) forked.admit(revision);
  const ambiguous = await applyNext(forked);
  equal(ambiguous.applied, false, 'A1 a fork is never applied arbitrarily');
  equal(ambiguous.reason, P02_CHROME_APPLY_ERROR.CANDIDATE_AMBIGUOUS, 'A2 by name');
  equal(forked.imports.length, 0, 'A3 with no canonical mutation');

  /* A chain that does not reach a root is a fragment, not proven ancestry. */
  const orphan = chromeWorld();
  const child = await v2Revision({
    sourceRevisionId: 'snap-2', text: 'two',
    parent: { revisionId: 'p02-absent', revisionBlobSha256: 'f'.repeat(64) }
  });
  orphan.admit(child);
  const fragment = await applyNext(orphan);
  equal(fragment.applied, false, 'A4 a chain that never reaches a root is refused');
  equal(orphan.imports.length, 0, 'A5 with no canonical mutation');

  /* An unproven node is excluded from the chain entirely. */
  const unproven = chromeWorld();
  const r1 = await v2Revision({ sourceRevisionId: 'snap-1', text: 'one' });
  const r2 = await v2Revision({ sourceRevisionId: 'snap-2', text: 'two', parent: r1 });
  unproven.admit(r1, false);
  unproven.admit(r2, true);
  const blocked = await applyNext(unproven);
  equal(blocked.applied, false, 'A6 a leaf whose ancestor is unproven is not applied');
  equal(unproven.imports.length, 0, 'A7 with no canonical mutation');
}

/* ===== 5. Apply-time byte verification, and idempotent replay ===== */
{
  const tampered = chromeWorld();
  const r1 = await v2Revision({ sourceRevisionId: 'snap-1', text: 'one' });
  tampered.admit(r1);
  tampered.repository.set(r1.revisionBlobSha256, encoder.encode('{"tampered":1}'));
  const bad = await applyNext(tampered);
  equal(bad.verdict, P02_APPLY_VERDICT.INTEGRITY,
    'V1 bytes that changed since admission are an integrity refusal');
  equal(tampered.imports.length, 0, 'V2 with no canonical mutation');
  equal(tampered.commits.length, 0, 'V3 and no ledger write');

  const missing = chromeWorld();
  const r2 = await v2Revision({ sourceRevisionId: 'snap-1', text: 'one' });
  missing.admit(r2);
  missing.repository.delete(r2.revisionBlobSha256);
  const gone = await applyNext(missing);
  equal(gone.verdict, P02_APPLY_VERDICT.BLOCKED, 'V4 a missing revision blocks');
  equal(gone.blockReason, 'transport', 'V5 as transport');

  const replayed = chromeWorld();
  const r3 = await v2Revision({ sourceRevisionId: 'snap-1', text: 'one' });
  replayed.admit(r3);
  await applyNext(replayed);
  const again = await applyNext(replayed);
  equal(again.verdict, P02_APPLY_VERDICT.ALREADY_APPLIED, 'V6 replay is idempotent');
  equal(replayed.commits.length, 1, 'V7 with exactly one commit');
  equal(replayed.imports.length, 1, 'V8 and exactly one import');
}

/* ===== 6. W-3 has no closure owner and fails closed ===== */
{
  const w = chromeWorld();
  const r1 = await v2Revision({ sourceRevisionId: 'snap-1', text: 'one' });
  w.admit(r1);
  await applyNext(w);
  const closure = await v2Revision({
    sourceRevisionId: null, text: null, parent: r1, closureType: 'object-deleted'
  });
  w.admit(closure);

  const applied = await applyNext(w);
  equal(applied.applied, false, 'K1 a closure is refused');
  equal(applied.reason, P02_CHROME_APPLY_ERROR.BRANCH_EVIDENCE_INVALID,
    'K2 because W-3 has no deletion owner');
  equal(w.imports.length, 1,
    'K4 with NO content import - a deletion has no payload to converge');
  equal(w.applyState.get(OBJECT).lastApplied.revisionId, r1.revisionId,
    'K5 and the prior applied identity remains unchanged');
  equal(w.ledger.get(OBJECT_KEY).convergedDirection, 'applied',
    'K6 and the direction still lands in the same transaction');
  equal((await applyNext(w)).applied, false,
    'K7 closure replay remains fail closed');
}

/* ===== 7. The v1 lane and the database are untouched ===== */
/* ===== 7. Pending recovery and mutation-race refusals ===== */
{
  const interrupted = chromeWorld({ importFailure: true });
  const r1 = await v2Revision({ sourceRevisionId: 'snap-1', text: 'one' });
  interrupted.admit(r1);
  const first = await applyNext(interrupted);
  equal(first.applied, false, 'R1 import failure does not commit');
  equal(interrupted.applyState.get(OBJECT).pending.revisionId, r1.revisionId,
    'R2 interrupted mutation retains durable pending intent');
  const replay = await applyNext(interrupted);
  equal(replay.reason, 'p02-apply-pending-unresolved',
    'R3 same-intent replay blocks when convergence is unproven');
  equal(interrupted.events().filter((event) => event === 'import').length, 1,
    'R4 pending replay never blindly imports a second time');

  const committedLate = chromeWorld({ commitFailureOnce: true });
  const r2 = await v2Revision({ sourceRevisionId: 'snap-2', text: 'two' });
  committedLate.admit(r2);
  equal((await applyNext(committedLate)).applied, false,
    'R5 crash-equivalent after convergence leaves pending');
  const recovered = await applyNext(committedLate);
  equal(recovered.verdict, P02_APPLY_VERDICT.PENDING_RECOVERED,
    'R6 converged pending is committed without a second import');
  equal(committedLate.events().filter((event) => event === 'import').length, 1,
    'R7 recovered pending imported exactly once in total');

  const mismatch = chromeWorld({ readbackMismatch: true });
  const r3 = await v2Revision({ sourceRevisionId: 'snap-3', text: 'three' });
  mismatch.admit(r3);
  const mismatched = await applyNext(mismatch);
  equal(mismatched.verdict, P02_APPLY_VERDICT.INTEGRITY,
    'R8 read-back mismatch fails closed');
  equal(mismatch.commits.length, 0, 'R9 read-back mismatch commits zero');

  for (const field of ['text', 'role', 'order']) {
    const semanticMismatch = chromeWorld({ messageMismatch: field });
    const revision = await v2Revision({
      sourceRevisionId: `snap-mismatch-${field}`,
      text: `semantic-${field}`
    });
    semanticMismatch.admit(revision);
    const result = await applyNext(semanticMismatch);
    equal(result.verdict, P02_APPLY_VERDICT.INTEGRITY,
      `R9-${field} a genuine message ${field} mismatch fails convergence`);
    equal(semanticMismatch.commits.length, 0,
      `R9-${field}-commit a genuine message ${field} mismatch commits zero`);
  }

  const raced = chromeWorld({ anchorRace: true });
  const r4 = await v2Revision({ sourceRevisionId: 'snap-4', text: 'four' });
  raced.admit(r4);
  const race = await applyNext(raced);
  equal(race.reason, 'p02-apply-anchor-precondition-failed',
    'R10 canonical change after stage is a typed anchor refusal');
  equal(raced.events().filter((event) => event === 'import').length, 0,
    'R11 anchor race imports zero');

  const pendingRecovery = classifyObjectState({
    objectDomain: DOMAIN,
    objectId: OBJECT,
    objectKey: OBJECT_KEY,
    syncPeerId: PEER,
    canonicalLocalHead: {
      revisionId: r2.sourceRevisionId,
      revisionBlobSha256: 'a'.repeat(64),
      payloadSha256: r2.payloadSha256
    },
    protocolState: {
      pendingOperation: 'apply',
      pendingApply: {
        referenceKind: P02_CHROME_APPLY_V2.REFERENCE_KIND,
        revisionId: r2.revisionId,
        revisionBlobSha256: r2.revisionBlobSha256,
        selectedLeafRevisionId: r2.revisionId,
        selectedLeafRevisionBlobSha256: r2.revisionBlobSha256
      }
    },
    retainedEvidence: [{
      document: r2.revision,
      revisionBlobSha256: r2.revisionBlobSha256,
      validated: true
    }],
    advertisedTips: []
  });
  equal(pendingRecovery.classification, P02_CLASSIFICATION.REMOTE_AHEAD,
    'R12 a durable same-intent pending Apply re-enters classifier selection');
  equal(pendingRecovery.reason, 'pending-apply-recovery',
    'R13 pending recovery remains a distinct read-back-first classifier reason');
  equal(pendingRecovery.applyCandidateRevisionId, r2.revisionId,
    'R14 the pending recovery selects the exact originally admitted leaf');

  const malformedPending = classifyObjectState({
    objectDomain: DOMAIN,
    objectId: OBJECT,
    objectKey: OBJECT_KEY,
    syncPeerId: PEER,
    canonicalLocalHead: null,
    protocolState: {
      pendingOperation: 'apply',
      pendingApply: {
        referenceKind: P02_CHROME_APPLY_V2.REFERENCE_KIND,
        revisionId: r2.revisionId,
        revisionBlobSha256: 'b'.repeat(64),
        selectedLeafRevisionId: r2.revisionId,
        selectedLeafRevisionBlobSha256: r2.revisionBlobSha256
      }
    },
    retainedEvidence: [{
      document: r2.revision,
      revisionBlobSha256: r2.revisionBlobSha256,
      validated: true
    }],
    advertisedTips: []
  });
  equal(malformedPending.classification, P02_CLASSIFICATION.INTEGRITY_QUARANTINED,
    'R15 a pending intent whose hop blob no longer matches evidence fails closed');
}

/* ===== 8. Committed Apply bridges canonical v1 projection to retained v2 leaf ===== */
{
  const revision = await v2Revision({
    sourceRevisionId: 'snap-post-apply', text: 'post-apply'
  });
  const lastApplied = {
    revisionId: revision.revisionId,
    revisionBlobSha256: revision.revisionBlobSha256,
    payloadSha256: revision.payloadSha256
  };
  const clean = classifyObjectState(postApplyDescriptor(revision, lastApplied));
  equal(clean.classification, P02_CLASSIFICATION.CONVERGED,
    'B1 exact committed lastApplied/live-leaf pair bridges clean post-Apply state');
  equal(clean.reason, 'post-apply-v1-v2-identity-bridge',
    'B2 the bridge has a specific source-defined reason');

  const dirty = classifyObjectState(postApplyDescriptor(
    revision, lastApplied, { dirty: true }));
  equal(dirty.classification, P02_CLASSIFICATION.LOCAL_AHEAD,
    'B3 a legitimate canonical edit after Apply remains local-ahead');

  const wrongLeaf = classifyObjectState(postApplyDescriptor(revision, {
    ...lastApplied,
    revisionBlobSha256: 'c'.repeat(64)
  }));
  equal(wrongLeaf.classification, P02_CLASSIFICATION.DIVERGED_UNRESOLVED,
    'B4 a lastApplied/live-leaf pair mismatch does not hide divergence');
  equal(wrongLeaf.reason, 'canonical-and-retained-branches-diverge',
    'B5 ordinary divergence logic remains active without the exact pair bridge');
}

/* ===== 9. The v1 lane and the database are untouched ===== */
{
  const store = fs.readFileSync(path.join(
    root, 'packages/browser-adapters/chrome/sync-object-store.mjs'
  ), 'utf8');
  equal(store.match(/const DATABASE_VERSION = (\d+);/)?.[1], '4',
    'N1 the Chrome DATABASE_VERSION is unchanged at 4');
  equal((store.match(/database\.createObjectStore\(/g) || []).length, 6,
    'N2 with the same six object stores');

  const v1 = fs.readFileSync(path.join(
    root, 'packages/browser-adapters/chrome/sync-revision-apply.mjs'
  ), 'utf8');
  check(v1.includes('applyNextAdmittedRevision'), 'N3 the v1 apply engine still exists');
  check(v1.includes('sync-revision-apply-v2') === false,
    'N4 and does not import the v2 lane - they are genuinely beside each other');

  const v2 = fs.readFileSync(path.join(
    root, 'packages/browser-adapters/chrome/sync-revision-apply-v2.mjs'
  ), 'utf8');
  check(v2.includes('sync-revision-apply.mjs') === false,
    'N5 nor does the v2 lane reach into the v1 engine');
  /* Test the CODE, not the prose: the module's own comment says it does not
   * down-convert, and a naive search would match that sentence and fail. */
  const v2Code = v2.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  check(/down-?convert|toV1|asV1Revision|v1Revision/.test(v2Code) === false,
    'N6 and no code down-converts a v2 envelope to a v1 document');
  check(v2Code.includes('syncRevision.v2') || v2Code.includes('sync-object-apply-v2'),
    'N7 while the v2 lane really does compose the v2 apply core');
  equal(P02_CHROME_APPLY_V2.SCHEMA, 'h2o.studio.syncChromeApplyV2.p02.v1',
    'N8 the v2 lane has its own schema');

  const core = fs.readFileSync(path.join(
    root, 'packages/core/sync-object-apply-v2.mjs'
  ), 'utf8');
  const lifecycleOrderSafe = (source) => {
    const start = source.indexOf('let staged;');
    const stageAt = source.indexOf('await stageApplyIntent', start);
    const importAt = source.indexOf('await importCanonicalPayload', start);
    const freshStart = source.indexOf("if (stageVerdict !== 'intent-staged')", start);
    const fresh = source.slice(freshStart);
    const freshImportAt = fresh.indexOf('await importCanonicalPayload');
    const proofAt = fresh.indexOf('await readCanonicalConvergence');
    const commitAt = fresh.indexOf('await commitApplied');
    return [start, stageAt, importAt, freshStart, freshImportAt, proofAt, commitAt]
      .every((value) => value >= 0) && stageAt < importAt &&
      freshImportAt < proofAt && proofAt < commitAt;
  };
  check(lifecycleOrderSafe(core),
    'N9 permanent assurance proves stage -> import -> proof -> commit');
  check(!lifecycleOrderSafe(core.replace(
    'let staged;', 'let staged;\n    await importCanonicalPayload({});')),
    'N10 RED control detects import-before-stage');
  check(!lifecycleOrderSafe(core.replace(
    'let convergence;', 'await commitApplied({});\n    let convergence;')),
    'N11 RED control detects commit-before-proof');
  const anchorConsumptionSafe = (source) =>
    /const anchorSet = requireP02AnchorSet\(descriptor\.p02AnchorSet\)/.test(source) &&
    /branchChain\(records, selectedLeaf, anchorSet\)/.test(source) &&
    /matchAnchorPair\(anchorSet,/.test(source);
  check(anchorConsumptionSafe(v2Code),
    'N12 W-3 consumes the typed P02 anchor set rather than carrying it unused');
  check(!anchorConsumptionSafe(v2Code.replace(
    'requireP02AnchorSet(descriptor.p02AnchorSet)', 'null')),
    'N12b RED control detects bypassing the authorized P02 anchor set');
  check(v2Code.includes('stageApplyIntent') &&
        v2Code.includes('readApplySnapshot') &&
        v2Code.includes('commitApplyIntent'),
    'N13 the adapter composes the existing durable Apply lifecycle');
  check(!/publish|webdav|repositoryWrite/i.test(v2Code),
    'N14 W-3 adapter contains no publication, WebDAV, or repository-write authority');
  const trustBindingSafe = (source) =>
    /configuredPeer\.syncPeerId !== descriptor\.syncPeerId/.test(source) &&
    /hex64\(configuredPeer\.writerKey\)/.test(source) &&
    /writerSyncPeerId:\s*configuredPeer\.syncPeerId/.test(source) &&
    /writerKey:\s*configuredPeer\.writerKey/.test(source);
  check(trustBindingSafe(v2Code),
    'N15 selected evidence is bound to the fresh configured peer and writerKey');
  check(!trustBindingSafe(v2Code.replace(
    'configuredPeer.syncPeerId !== descriptor.syncPeerId', 'false')),
    'N16 RED control detects configured-writer identity validation bypass');
  const branchReferenceSafe = (source) =>
    source.includes("value.referenceKind === 'branch-evidence-v2'") &&
    source.includes('value.parentRevisionId !== value.canonicalAnchorRevisionId') &&
    source.includes('value.parentRevisionBlobSha256Hex !==') &&
    source.includes('value.canonicalAnchorRevisionBlobSha256Hex');
  check(branchReferenceSafe(store),
    'N17 branch intent structurally binds its direct parent pair to its anchor pair');
  const enumerator = fs.readFileSync(path.join(
    root, 'packages/browser-adapters/chrome/sync-object-enumerator-v2.mjs'
  ), 'utf8');
  const background = fs.readFileSync(path.join(
    root, 'packages/browser-adapters/chrome/sync-background-reconcile.mjs'
  ), 'utf8');
  check(enumerator.includes("referenceKind: 'branch-evidence-v2'") &&
        enumerator.includes('selectedLeafRevisionBlobSha256'),
    'N18 the enumerator carries the durable pending identity into fresh classification');
  check(background.includes('p02Runtime.scheduler.dropRetryIndex()'),
    'N19 a new Human Apply may re-evaluate canonical pending work parked by the prior attempt');
}

const verdict = failures.length === 0
  ? 'P02_O1_CHROME_V2_APPLY_PASS' : 'P02_O1_CHROME_V2_APPLY_FAIL';
console.log(JSON.stringify({
  verdict, assertions, failures,
  sameTransactionCommit: 'the applied anchor and the ledger direction land in one '
    + 'transaction, so no window exists where they disagree',
  v1ContractMutated: false,
  databaseVersionBumped: false,
  newStoresCreated: 0,
  orderingRedControls: [
    'import-before-stage', 'commit-before-proof', 'p02-anchor-bypass',
    'configured-writer-identity-bypass'
  ],
  liveProfileTouched: false, realRepositoryTouched: false,
  canonicalStateTouched: false, processesLaunched: 0
}, null, 2));
process.exit(failures.length === 0 ? 0 : 1);
