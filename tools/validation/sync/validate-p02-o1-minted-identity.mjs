#!/usr/bin/env node
/*
 * O1-T05b — engine-minted envelope identity and the closure-seam decoupling.
 *
 * The envelope used to borrow its revisionId from the domain: for saved chats,
 * the canonical snapshot id. That single coupling caused everything below.
 *
 * A snapshot id names canonical STATE, and an in-place edit rewrites that state
 * without changing the id, so two envelopes with different bytes could carry
 * one identity - the exact conflict every downstream contract exists to refuse.
 * An A -> B -> A cycle could re-mint an id that already named a different
 * revision, making self-parenthood and cycles reachable for an honest writer.
 * And every future domain would have had to issue sync identity itself.
 *
 * Minting the envelope id fixes the identity, and then FORCES a second change:
 * every seam that used the envelope id to reach canonical state has to key on
 * the payload's own source id instead, or it will look up an address canonical
 * state has never heard of. Those are the call-site rules (A1 §4/§6/§7):
 *
 *   CHT  payload validation                     -> payload source id
 *   DRT  convergence() lookups AND equations    -> payload source id
 *   DRT  canonical content pointer advance      -> payload source id
 *   APL  readCanonical + expectedSnapshot       -> payload source id
 *   everything protocol-side (ledger, intent)   -> stays the ENVELOPE id
 *
 * In the v1 lane the two ids are the same value, so every rule below is
 * byte-identical there; the tests prove that explicitly rather than assuming.
 *
 * Real modules throughout - the real store, the real admission path, the real
 * apply engine, the real projection core. In-memory and disposable: no
 * repository, no canonical app data, no transport, no processes.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  P02_REVISION_MINT,
  P02_REVISION_MINT_ERROR,
  isMintedP02RevisionId,
  mintP02RevisionId,
  payloadSourceRevisionId
} from '../../../packages/core/sync-p02-revision-mint-v2.mjs';
import {
  createCanonicalSyncObjectProjectionCore
} from '../../../packages/core/sync-object-projection.mjs';
import {
  P02_CHAT_DOMAIN_ERROR,
  P02_CHAT_DOMAIN_V2,
  produceChatRevisionV2
} from '../../../packages/browser-adapters/chrome/sync-revision-domain-chat-v2.mjs';
import {
  P02_ADMISSION_DISPOSITION,
  buildBranchIndex,
  classifyAdmission
} from '../../../packages/core/sync-branch-evidence-v2.mjs';
import {
  createP02AnchorSet
} from '../../../packages/core/sync-p02-anchor-set-v2.mjs';
import {
  createChromeSyncObjectStore
} from '../../../packages/browser-adapters/chrome/sync-object-store.mjs';
import {
  createInjectedRevisionAdmission
} from '../../../packages/browser-adapters/chrome/sync-revision-admission.mjs';
import {
  createChromeRevisionApply
} from '../../../packages/browser-adapters/chrome/sync-revision-apply.mjs';
import {
  FakeIndexedDBFactory,
  chromeIdentity,
  hashBytes,
  identityProvider
} from './helpers/item9-fake-indexeddb.mjs';

let assertions = 0;
const failures = [];
const check = (condition, label) => {
  assertions += 1;
  if (condition !== true) failures.push(label);
};
const equal = (actual, expected, label) =>
  check(actual === expected, `${label} (expected ${String(expected)}, got ${String(actual)})`);

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const encoder = new TextEncoder();
const WRITER = 'studio-desktop:tauri-desktop:sqlite:11111111-2222-4333-8444-555555555555';
const OBJECT = 'chat-t05b-0001';

const attempt = (run) => {
  try { return { ok: true, value: run() }; }
  catch (error) { return { ok: false, code: error?.code ?? error?.message ?? 'unknown' }; }
};
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
const sha256Text = async (text) => hashBytes(encoder.encode(text));

function chatPayload(objectId, sourceRevisionId, text = 'hello') {
  return {
    schema: P02_CHAT_DOMAIN_V2.PAYLOAD_SCHEMA,
    chatArchive: {
      chats: [{
        chatId: objectId,
        title: 'T05b',
        chatIndex: {
          title: 'T05b',
          lastSnapshotId: sourceRevisionId,
          snapshotCount: 1,
          messageCount: 1,
          state: { isSaved: true, isLinked: true },
          organization: {}
        },
        snapshots: [{
          snapshotId: sourceRevisionId,
          chatId: objectId,
          createdAt: '2026-08-25T00:00:00.000Z',
          messageCount: 1,
          messages: [{ order: 0, role: 'user', text }],
          meta: {
            title: 'T05b',
            richTurns: [{ turnIdx: 0, role: 'user', outerHTML: `<p>${text}</p>`, meta: {} }]
          }
        }]
      }],
      catalogs: { categories: [], labels: [], tags: [] }
    },
    chromeStorageLocal: {},
    libraryKv: []
  };
}

/* ===== M. The mint itself ===== */
{
  const minted = mintP02RevisionId(crypto.webcrypto);
  check(P02_REVISION_MINT.PATTERN.test(minted),
    `M1 a mint is p02- plus 32 lowercase hex (${minted})`);
  check(isMintedP02RevisionId(minted), 'M2 and is recognised as minted');
  check(minted.startsWith('p02-'),
    'M3 the prefix makes a minted id recognisable on sight in a row or a log');

  const many = new Set(Array.from({ length: 512 }, () => mintP02RevisionId(crypto.webcrypto)));
  equal(many.size, 512, 'M4 512 mints are 512 distinct ids');

  /* No weak fallback: a predictable id would let one writer guess another's
   * next revision address, which is worse than failing loudly. */
  equal(attempt(() => mintP02RevisionId({})).code,
    P02_REVISION_MINT_ERROR.CRYPTO_UNAVAILABLE,
    'M5 an absent CSPRNG fails closed rather than falling back');
  equal(attempt(() => mintP02RevisionId({ getRandomValues: null })).code,
    P02_REVISION_MINT_ERROR.CRYPTO_UNAVAILABLE,
    'M6 and so does an unusable one');

  check(isMintedP02RevisionId('snapshot-2026-08-25T20:02:31.477Z') === false,
    'M7 a v1 snapshot id is not a mint');
  check(isMintedP02RevisionId('p02-NOTHEX0000000000000000000000000') === false,
    'M8 nor is a lookalike');
}

/* ===== S. The payload's own identity, read rather than assumed ===== */
{
  equal(payloadSourceRevisionId(chatPayload(OBJECT, 'snap-1')), 'snap-1',
    'S1 a self-consistent payload reports its source id');

  /* Two independent statements of one fact; if they disagree, neither is
   * trustworthy and picking one would silently validate against the wrong id. */
  const split = chatPayload(OBJECT, 'snap-1');
  split.chatArchive.chats[0].snapshots[0].snapshotId = 'snap-2';
  equal(payloadSourceRevisionId(split), null,
    'S2 a payload whose two identity statements disagree reports nothing');
  equal(payloadSourceRevisionId({}), null, 'S3 a malformed payload reports nothing');
  equal(payloadSourceRevisionId(null), null, 'S4 and so does no payload at all');
}

/* ===== P. The Desktop runtime restates the predicate; pin them together ===== */
{
  /*
   * sync-object-runtime.tauri.js is a classic IIFE and cannot import, so it
   * restates payloadSourceRevisionId locally. Two copies of one rule drift, so
   * the local copy is extracted from the real file and run against the core
   * export over the same vectors.
   */
  const source = fs.readFileSync(
    path.join(repo, 'src-surfaces-base/studio/sync/sync-object-runtime.tauri.js'), 'utf8'
  );
  const start = source.indexOf('  function payloadSourceRevisionId(payload) {');
  check(start > 0, 'P1 the Desktop runtime carries its own copy of the predicate');
  const end = source.indexOf('\n  }\n', start);
  const body = source.slice(start, end + 4);
  const clean = (value) => String(value == null ? '' : value).trim();
  // eslint-disable-next-line no-new-func
  const local = new Function('clean', `${body}\n  return payloadSourceRevisionId;`)(clean);

  const vectors = [
    chatPayload(OBJECT, 'snap-1'),
    (() => { const p = chatPayload(OBJECT, 'snap-1'); p.chatArchive.chats[0].snapshots[0].snapshotId = 'snap-2'; return p; })(),
    (() => { const p = chatPayload(OBJECT, 'snap-1'); p.chatArchive.chats[0].chatIndex.lastSnapshotId = ''; return p; })(),
    (() => { const p = chatPayload(OBJECT, 'snap-1'); delete p.chatArchive.chats[0].snapshots; return p; })(),
    {}, null, { chatArchive: { chats: [] } }
  ];
  const agree = vectors.every((vector) => local(vector) === payloadSourceRevisionId(vector));
  check(agree, 'P2 the Desktop copy agrees with the core contract on every vector');
  equal(local(chatPayload(OBJECT, 'snap-9')), 'snap-9',
    'P3 including the ordinary self-consistent case');
}

/* ===== C. The CHT call-site rule ===== */
{
  const sourceRevisionId = 'snapshot-2026-08-25T20:02:31.477Z';
  const minted = mintP02RevisionId(crypto.webcrypto);
  const payload = chatPayload(OBJECT, sourceRevisionId);

  const produced = await produceChatRevisionV2({
    canonicalObject: { objectId: OBJECT, revisionId: minted, payload },
    writerSyncPeerId: WRITER,
    cryptoImplementation: crypto.webcrypto
  });
  equal(produced.revision.revisionId, minted,
    'C1 the ENVELOPE carries the mint, not the snapshot id');
  equal(produced.revision.payload.chatArchive.chats[0].chatIndex.lastSnapshotId,
    sourceRevisionId,
    'C2 while the PAYLOAD keeps its own source identity untouched');
  check(isMintedP02RevisionId(produced.revisionId),
    'C3 and the produced identity is the mint');
  equal(produced.revision.payloadSha256, produced.payloadSha256,
    'C3b with the payload hash carried in the envelope');

  /* The v1 lane, where the two ids coincide, still produces. */
  const legacy = await produceChatRevisionV2({
    canonicalObject: {
      objectId: OBJECT, revisionId: sourceRevisionId,
      payload: chatPayload(OBJECT, sourceRevisionId)
    },
    writerSyncPeerId: WRITER,
    cryptoImplementation: crypto.webcrypto
  });
  equal(legacy.revision.revisionId, sourceRevisionId,
    'C4 the v1 lane, where the ids coincide, is unaffected');

  /* A payload that disagrees with itself is refused rather than validated
   * against whichever statement happened to be read. */
  const split = chatPayload(OBJECT, sourceRevisionId);
  split.chatArchive.chats[0].snapshots[0].snapshotId = 'a-different-snapshot';
  const refused = await produceChatRevisionV2({
    canonicalObject: { objectId: OBJECT, revisionId: mintP02RevisionId(crypto.webcrypto), payload: split },
    writerSyncPeerId: WRITER, cryptoImplementation: crypto.webcrypto
  }).then(() => null, (error) => error?.code ?? 'unknown');
  equal(refused, P02_CHAT_DOMAIN_ERROR.PAYLOAD_NOT_CANONICAL,
    `C5 a self-contradicting payload is refused (${refused})`);
}

/* ===== H. Payload-hash stability across mints ===== */
{
  const sourceRevisionId = 'snapshot-stable';
  const payload = chatPayload(OBJECT, sourceRevisionId);
  const first = await produceChatRevisionV2({
    canonicalObject: { objectId: OBJECT, revisionId: mintP02RevisionId(crypto.webcrypto), payload },
    writerSyncPeerId: WRITER, cryptoImplementation: crypto.webcrypto
  });
  const second = await produceChatRevisionV2({
    canonicalObject: { objectId: OBJECT, revisionId: mintP02RevisionId(crypto.webcrypto), payload },
    writerSyncPeerId: WRITER, cryptoImplementation: crypto.webcrypto
  });

  check(first.revision.revisionId !== second.revision.revisionId,
    'H1 two publications of the same content mint different envelope ids');
  equal(first.payloadSha256, second.payloadSha256,
    'H2 yet the PAYLOAD hash is identical - the content did not change');
  check(first.revisionBlobSha256 !== second.revisionBlobSha256,
    'H3 while the envelope bytes differ, because the identity differs');
  equal(first.objectKey, second.objectKey, 'H4 and the object key is unchanged');

  /*
   * This is the property the whole identity amendment rests on: content
   * equivalence is decided by the payload hash, so a re-mint of unchanged
   * content is still recognisably unchanged. Under the old scheme the two
   * would have been the same envelope, and a genuine edit would have been
   * indistinguishable from a re-publication.
   */
  const edited = chatPayload(OBJECT, sourceRevisionId, 'goodbye');
  const third = await produceChatRevisionV2({
    canonicalObject: { objectId: OBJECT, revisionId: mintP02RevisionId(crypto.webcrypto), payload: edited },
    writerSyncPeerId: WRITER, cryptoImplementation: crypto.webcrypto
  });
  check(third.payloadSha256 !== first.payloadSha256,
    'H5 an actual content edit changes the payload hash');
  equal(payloadSourceRevisionId(edited), sourceRevisionId,
    'H6 even though the canonical snapshot id did NOT change - which is exactly '
    + 'the in-place edit that made the old id-borrowing scheme unsound');
}

/* ===== L. A -> B -> A at depth: self-parent and cycles unreachable ===== */
{
  const sourceRevisionId = 'snapshot-abA';
  const contentA = chatPayload(OBJECT, sourceRevisionId, 'A');
  const contentB = chatPayload(OBJECT, sourceRevisionId, 'B');

  const mint = () => mintP02RevisionId(crypto.webcrypto);
  const revA = await produceChatRevisionV2({
    canonicalObject: { objectId: OBJECT, revisionId: mint(), payload: contentA },
    writerSyncPeerId: WRITER, cryptoImplementation: crypto.webcrypto
  });
  const revB = await produceChatRevisionV2({
    canonicalObject: { objectId: OBJECT, revisionId: mint(), payload: contentB },
    writerSyncPeerId: WRITER, cryptoImplementation: crypto.webcrypto,
    p02Parent: {
      previousRevisionId: revA.revision.revisionId,
      previousRevisionBlobSha256: revA.revisionBlobSha256,
      provenP02Parent: true
    }
  });
  /* Reverted to A's content, parenting on the current tip B. */
  const revA2 = await produceChatRevisionV2({
    canonicalObject: { objectId: OBJECT, revisionId: mint(), payload: contentA },
    writerSyncPeerId: WRITER, cryptoImplementation: crypto.webcrypto,
    p02Parent: {
      previousRevisionId: revB.revision.revisionId,
      previousRevisionBlobSha256: revB.revisionBlobSha256,
      provenP02Parent: true
    }
  });

  const ids = new Set([revA, revB, revA2].map((r) => r.revision.revisionId));
  equal(ids.size, 3,
    'L1 A -> B -> A produces THREE distinct envelope identities');
  equal(revA2.payloadSha256, revA.payloadSha256,
    'L2 while the revert really is the same content as A');
  check(revA2.revision.revisionId !== revA.revision.revisionId,
    'L3 and the revert does NOT collide with the revision it restores - which is '
    + 'the cycle the old snapshot-id scheme made reachable');

  /* The produced revision document is already the Z6 evidence shape. */
  const record = (produced) => ({
    revisionBlobSha256: produced.revisionBlobSha256,
    document: produced.revision
  });
  const index = buildBranchIndex({
    objectDomain: P02_CHAT_DOMAIN_V2.OBJECT_DOMAIN, objectId: OBJECT,
    records: [record(revA), record(revB), record(revA2)]
  });
  equal(index.provenRevisionIds.length, 3,
    'L4 the whole chain is proven by Z6, root to revert');
  equal(index.liveLeafRevisionIds.length, 1, 'L5 with exactly one live leaf');
  equal(index.liveLeafRevisionIds[0], revA2.revision.revisionId,
    'L6 and that leaf is the revert, not the revision it restored');
  equal(index.identityConflictRevisionIds.length, 0,
    'L7 with no identity conflict anywhere in the chain');

  /* A self-parent is now unreachable for an honest writer: the mint cannot
   * equal a parent it did not exist to name. */
  const selfParent = classifyAdmission({
    index: buildBranchIndex({
      objectDomain: P02_CHAT_DOMAIN_V2.OBJECT_DOMAIN, objectId: OBJECT, records: []
    }),
    candidate: {
      revisionBlobSha256: revA.revisionBlobSha256,
      document: {
        ...revA.revision,
        previousRevisionId: revA.revision.revisionId,
        previousRevisionBlobSha256: revA.revisionBlobSha256
      }
    }
  });
  equal(selfParent.disposition, P02_ADMISSION_DISPOSITION.QUARANTINED,
    'L8 a hand-forged self-parent is still quarantined');
  equal(selfParent.reason, 'self-parent', 'L9 by name');

  /* The revert descends from an anchor just as well. */
  const viaAnchor = classifyAdmission({
    index: buildBranchIndex({
      objectDomain: P02_CHAT_DOMAIN_V2.OBJECT_DOMAIN, objectId: OBJECT, records: []
    }),
    candidate: record(revA2),
    p02AnchorSet: createP02AnchorSet({
      protocolState: {
        lastPublished: {
          revisionId: revB.revision.revisionId,
          revisionBlobSha256: revB.revisionBlobSha256
        }
      }
    })
  });
  equal(viaAnchor.disposition, P02_ADMISSION_DISPOSITION.ACCEPTED_LINEAR,
    'L10 and the revert admits linearly against the published anchor');
}

/* ===== A. The APL call-site rule ===== */
{
  /*
   * The v2 envelope is a nine-key document; the v1 Chrome admission path
   * accepts exactly six keys, so a minted v2 revision cannot traverse it at
   * all - by design, since the v2 admission lane is O1-T11 and the v2 apply
   * adapter is O1-T14. What CAN be proven today is the half that is live:
   * that the seam reads the PAYLOAD's identity, and that doing so leaves the
   * v1 lane - where the two ids coincide - exactly as it was.
   *
   * The fully-divergent end-to-end case (minted envelope, different payload
   * source id, all the way through apply) becomes reachable at T14, and is
   * deliberately NOT simulated here with a hand-built candidate: a fixture
   * that skips admission would prove the fixture, not the engine.
   */
  const sourceRevisionId = 'snapshot-apply-source';
  const payload = chatPayload(OBJECT, sourceRevisionId);
  const objectKey = await sha256Text(`studio.chat.saved-state.v1\u0000${OBJECT}`);
  const payloadSha256 = await sha256Text(canonicalJson(payload));
  /* A v1-shaped revision: six keys, envelope id == payload source id. */
  const revision = {
    schema: 'h2o.studio.syncRevision.v1',
    objectId: OBJECT, objectKey, payloadSha256,
    revisionId: sourceRevisionId, payload
  };
  const revisionBlobBytes = encoder.encode(canonicalJson(revision));
  const head = {
    schema: 'h2o.studio.syncHead.v1',
    objectId: OBJECT, objectKey, payloadSha256,
    previousRevisionId: null,
    revisionBlobSha256: await hashBytes(revisionBlobBytes),
    revisionId: sourceRevisionId,
    sourceUpdatedAtIso: '2026-08-25T00:00:00.000Z',
    writerSyncPeerId: WRITER
  };
  const headBytes = encoder.encode(canonicalJson(head));

  const store = createChromeSyncObjectStore({
    identityProvider: identityProvider(chromeIdentity()),
    indexedDBFactory: new FakeIndexedDBFactory(),
    cryptoImplementation: crypto.webcrypto,
    clock: () => '2026-08-25T00:00:00.000Z'
  });
  const admission = createInjectedRevisionAdmission({
    observationStore: store, cryptoImplementation: crypto.webcrypto
  });
  const admitted = await admission.admitInjectedRevision({ headBytes, revisionBlobBytes });
  check(admitted?.ok === true,
    `A0 the real admission path still admits a v1 revision (${admitted?.errorCode ?? 'ok'})`);

  const asked = [];
  const canonicalSnapshots = new Map();
  const apply = createChromeRevisionApply({
    syncStore: store,
    cryptoImplementation: crypto.webcrypto,
    archiveAuthority: {
      async importFullBundle({ bundle }) {
        const snapshot = bundle.chatArchive.chats[0].snapshots[0];
        canonicalSnapshots.set(snapshot.snapshotId, structuredClone(snapshot));
        return { ok: true };
      },
      async loadSnapshot(snapshotId) {
        asked.push(snapshotId);
        return canonicalSnapshots.has(snapshotId)
          ? structuredClone(canonicalSnapshots.get(snapshotId))
          : null;
      }
    }
  });

  const result = await apply.applyNextAdmittedRevision(OBJECT);
  equal(result.ok, true, `A1 apply still succeeds after the seam change (${result.verdict})`);
  check(asked.length > 0, 'A2 the canonical archive was read back');
  check(asked.every((key) => key === sourceRevisionId),
    `A3 read back by the payload source id (${asked.join(',')})`);
  equal(result.revisionId, sourceRevisionId,
    'A4 while the protocol result still reports the envelope identity');
  check(canonicalSnapshots.has(sourceRevisionId),
    'A5 canonical state stays keyed by the source id it has always used');

  /*
   * The rule itself, where the ids DO diverge: the seam asks the payload, and
   * the payload answers with its own id rather than the envelope's. This is
   * the value readCanonical now passes to loadSnapshot and expectedSnapshot.
   */
  const mintedEnvelope = mintP02RevisionId(crypto.webcrypto);
  const divergent = chatPayload(OBJECT, sourceRevisionId);
  equal(payloadSourceRevisionId(divergent), sourceRevisionId,
    'A6 with a minted envelope the seam still resolves the canonical source id');
  check(payloadSourceRevisionId(divergent) !== mintedEnvelope,
    'A7 which is NOT the envelope id, so the old code would have missed');

  /* An apply-side refusal must not degrade to guessing an address. */
  const contradictory = chatPayload(OBJECT, sourceRevisionId);
  contradictory.chatArchive.chats[0].snapshots[0].snapshotId = 'other-snapshot';
  equal(payloadSourceRevisionId(contradictory), null,
    'A8 and a self-contradicting payload yields no address at all');
}

/* ===== T. createdAt alignment: the projection agrees with convergence ===== */
{
  /*
   * Desktop snapshots carry BOTH captured_at and updated_at. The projection
   * wrote whichever it preferred into the payload's `createdAt`, and apply-side
   * convergence compares that field against the local snapshot's capturedAt -
   * and only capturedAt. Whenever the two differed, a perfectly converged
   * object failed its own convergence proof.
   */
  const CAPTURED = '2026-08-01T10:00:00.000Z';
  const UPDATED = '2026-08-20T18:30:00.000Z';
  const REVISION = 'snapshot-timestamps';
  const snapshot = {
    snapshotId: REVISION, chatId: OBJECT, title: 'T05b',
    capturedAt: CAPTURED, updatedAt: UPDATED, messageCount: 1,
    turns: [{ turnIdx: 0, role: 'user', text: 'hello', outerHtml: '<p>hello</p>', meta: {} }]
  };
  const projection = createCanonicalSyncObjectProjectionCore({
    cryptoImplementation: crypto.webcrypto
  });
  /* Content-only: the object carries no relationships of any kind. */
  const relationshipProbe = async () => ({
    assets: [], categories: [], folders: [], labels: [],
    organizations: [], projects: [], tags: []
  });
  const projected = await projection.projectObject({
    objectId: OBJECT,
    writerSyncPeerId: WRITER,
    relationshipProbe,
    stores: {
      chats: { async get() { return { id: OBJECT, chatId: OBJECT, title: 'T05b', lastSnapshotId: REVISION }; } },
      snapshots: {
        async get() { return { snapshot, turns: snapshot.turns }; },
        async listByChat() { return [{ snapshotId: REVISION }]; }
      }
    }
  });
  const projectedCreatedAt =
    projected.payload.chatArchive.chats[0].snapshots[0].createdAt;
  equal(projectedCreatedAt, CAPTURED,
    'T1 the projection writes capturedAt, which is the field convergence compares');
  check(projectedCreatedAt !== UPDATED,
    'T2 and no longer writes updatedAt, which convergence would have rejected');
  equal(projected.sourceUpdatedAtIso, CAPTURED,
    'T3 the head timestamp comes from the same aligned source');

  /* With only one timestamp present nothing changes at all. */
  const single = await projection.projectObject({
    objectId: OBJECT, writerSyncPeerId: WRITER,
    relationshipProbe,
    stores: {
      chats: { async get() { return { id: OBJECT, chatId: OBJECT, title: 'T05b', lastSnapshotId: REVISION }; } },
      snapshots: {
        async get() {
          return { snapshot: { ...snapshot, capturedAt: undefined }, turns: snapshot.turns };
        },
        async listByChat() { return [{ snapshotId: REVISION }]; }
      }
    }
  });
  equal(single.payload.chatArchive.chats[0].snapshots[0].createdAt, UPDATED,
    'T4 a snapshot with no capturedAt still falls back to updatedAt');
}

const verdict = failures.length === 0
  ? 'P02_O1_MINTED_IDENTITY_PASS' : 'P02_O1_MINTED_IDENTITY_FAIL';
console.log(JSON.stringify({
  verdict, assertions, failures,
  contract: [
    'M engine mint is p02- plus 32 CSPRNG hex, no weak fallback',
    'S the payload states its own identity twice and must agree',
    'P the Desktop restatement is pinned against the core contract',
    'C CHT validates the payload against the payload source id',
    'H payload hash is stable across mints; edits still move it',
    'L A->B->A yields three identities; self-parent and cycles unreachable',
    'A APL reads canonical by source id, ledgers the envelope id',
    'T projection createdAt aligns with what convergence compares'
  ],
  realRepositoryTouched: false, canonicalStateTouched: false, processesLaunched: 0
}, null, 2));
process.exit(failures.length === 0 ? 0 : 1);
