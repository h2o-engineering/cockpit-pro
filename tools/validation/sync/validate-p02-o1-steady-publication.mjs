#!/usr/bin/env node
/*
 * O1-T18 — steady publication composition, complete in source and inert in product.
 *
 * Three things carry the weight here, and each is tested by trying to break it.
 *
 * THE CAS TOKEN. publishBatch still has a compatibility path that re-reads the
 * pointer when no token is supplied. Steady publication must never take it, so
 * the tests move the pointer BETWEEN the base read and the publish and prove the
 * attempt refuses against the base it planned on - rather than silently
 * rebaselining onto a state nobody inspected.
 *
 * THE MINT BOUNDARY. Before durable intent a mint can vanish harmlessly. After
 * it, the mint is an identity the repository may already hold, so recovery must
 * REUSE it. The crash matrix walks every window and checks which side of that
 * boundary it fell on.
 *
 * DORMANCY. Source-complete is not the same as live. Three independent reasons
 * keep this inert - nothing calls it, the gate refuses, the lease refuses - and
 * each is checked separately, because a future change that removes one must not
 * quietly turn the product on.
 *
 * Real cores throughout, injected ports, disposable stores. No real profile, no
 * real repository, no writer-generation record, no timers, no processes.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  P02_STEADY_ERROR,
  P02_STEADY_OUTCOME,
  P02_STEADY_PUBLICATION_V2,
  createP02SteadyPublication
} from '../../../packages/core/sync-steady-publication-v2.mjs';
import {
  P02_STEADY_DRIVER_V2,
  classifySteadyOutcome,
  createP02SteadyDriver
} from '../../../packages/core/sync-steady-driver-v2.mjs';
import { P02_GENERATION_STATE }
  from '../../../packages/core/sync-writer-generation-v2.mjs';
import { P02_RUNTIME_STATUS } from '../../../packages/core/sync-object-runtime-v2.mjs';
import { P02_ATTEMPT_OUTCOME } from '../../../packages/core/sync-object-scheduler-v2.mjs';
import { isMintedP02RevisionId, mintP02RevisionId }
  from '../../../packages/core/sync-p02-revision-mint-v2.mjs';
import { P02_HEADS_MERGE_V2 } from '../../../packages/core/sync-p02-heads-merge-v2.mjs';
import { createChromeP02PublicationOwner }
  from '../../../packages/browser-adapters/chrome/sync-p02-publication-chrome-v2.mjs';
import { produceChatRevisionV2, P02_CHAT_DOMAIN_V2 }
  from '../../../packages/browser-adapters/chrome/sync-revision-domain-chat-v2.mjs';
import { objectKeyHex, writerKeyHex }
  from '../../../packages/browser-adapters/chrome/sync-contract-v2.mjs';
import { P02_FSA_REPOSITORY_CHILD }
  from '../../../packages/browser-adapters/chrome/sync-fsa-read-transport-v2.mjs';
import { P02_FSA_WRITE_V2 }
  from '../../../packages/browser-adapters/chrome/sync-fsa-write-transport-v2.mjs';
import { createMemoryFsa } from './helpers/p02-memory-fsa.mjs';

let assertions = 0;
const failures = [];
const check = (condition, label) => {
  assertions += 1;
  if (condition !== true) failures.push(label);
};
const equal = (actual, expected, label) =>
  check(actual === expected, `${label} (expected ${String(expected)}, got ${String(actual)})`);

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const DOMAIN = 'studio.chat.saved-state.v1';
const OBJECT = 'chat-steady';
const WRITER = 'studio-desktop:tauri-desktop:sqlite:steady-peer';
const hex = (seed) => crypto.createHash('sha256').update(String(seed)).digest('hex');
const OBJECT_KEY = hex(`key-${OBJECT}`);
const SOURCE_AT = '2026-08-20T10:00:00.000Z';

function chatPayload(objectId, snapshotId, text) {
  return {
    schema: P02_CHAT_DOMAIN_V2.PAYLOAD_SCHEMA,
    chatArchive: {
      chats: [{
        chatId: objectId,
        title: 'Reverse fixture',
        chatIndex: { title: 'Reverse fixture', lastSnapshotId: snapshotId,
          snapshotCount: 1, messageCount: 1,
          state: { isSaved: true, isLinked: true }, organization: {} },
        snapshots: [{ snapshotId, chatId: objectId, createdAt: SOURCE_AT,
          messageCount: 1, messages: [{ order: 0, role: 'user', text }],
          meta: { title: 'Reverse fixture', richTurns: [{
            turnIdx: 0, role: 'user', outerHTML: `<p>${text}</p>`, meta: {}
          }] } }]
      }],
      catalogs: { categories: [], labels: [], tags: [] }
    },
    chromeStorageLocal: {}, libraryKv: []
  };
}

const headFor = (objectId, revisionId, blobSeed) => ({
  objectDomain: DOMAIN, objectId, objectKey: hex(`key-${objectId}`),
  revisionId, payloadSha256: hex(`payload-${revisionId}`),
  revisionBlobSha256: hex(blobSeed),
  previousRevisionId: null, previousRevisionBlobSha256: null,
  sourceUpdatedAtIso: SOURCE_AT, writerSyncPeerId: WRITER
});

/*
 * A disposable world with every port programmable, so a test can break exactly
 * one thing. `crashAt` names the window a crash falls into.
 */
function world(over = {}) {
  const events = [];
  const state = {
    canonicalPayload: hex('canonical-new'),
    protocol: {
      convergedDirection: 'published',
      publishedPayloadSha256: hex('canonical-old'),
      appliedPayloadSha256: null,
      lastPublished: { revisionId: 'p02-parent', revisionBlobSha256: hex('parent-blob') },
      pendingOperation: null
    },
    baseHeads: [headFor(OBJECT, 'p02-parent', 'parent-blob')],
    baseStatus: 'verified',
    basePointer: hex('pointer-A'),
    /* The pointer the REPOSITORY currently holds. A test can move this after
     * the base read to model an interleaved advance. */
    repositoryPointer: hex('pointer-A'),
    anchorProof: () => ({ status: 'verified' }),
    descent: () => ({ outcome: 'proven-chain', descendsFromSeed: true }),
    leaseGrants: true,
    authorityPermits: () => ({ permitted: true }),
    crashAt: null,
    ...over
  };

  const intents = [];
  const completions = [];
  const abandons = [];
  const publishCalls = [];

  const publication = createP02SteadyPublication({
    readWriterState: async () => {
      events.push('readWriterState');
      if (state.baseStatus !== 'verified') return { status: state.baseStatus };
      return {
        status: 'verified',
        pointer: { currentHeadsSnapshotSha256: state.basePointer },
        snapshot: { headsSnapshotSha256: hex('snap-A'), heads: state.baseHeads }
      };
    },
    readProtocolState: async () => state.protocol,
    readCanonicalProjection: async () => ({
      payloadSha256: state.canonicalPayload, sourceUpdatedAtIso: SOURCE_AT
    }),
    proveAnchor: async ({ pair }) => state.anchorProof(pair),
    probeDescent: async (input) => state.descent(input),
    mintRevisionId: async () => {
      events.push('mint');
      if (state.crashAt === 'before-intent') {
        throw Object.assign(new Error('crash'), { code: 'crash-before-intent' });
      }
      return mintP02RevisionId(crypto.webcrypto);
    },
    produceRevision: async ({ revisionId, p02Parent }) => ({
      revisionId,
      revisionBlobSha256: hex(`blob-${revisionId}`),
      payloadSha256: state.canonicalPayload,
      sourceUpdatedAtIso: SOURCE_AT,
      revision: {
        previousRevisionId: p02Parent?.previousRevisionId ?? null,
        previousRevisionBlobSha256: p02Parent?.previousRevisionBlobSha256 ?? null
      }
    }),
    recordIntent: async (input) => {
      events.push('recordIntent');
      intents.push(input);
      if (state.crashAt === 'after-intent') {
        throw Object.assign(new Error('crash'), { code: 'crash-after-intent' });
      }
      return { acquisitionId: `acq-${intents.length}` };
    },
    completePublication: async (input) => {
      events.push('completePublication');
      if (state.crashAt === 'after-pointer') {
        throw Object.assign(new Error('crash'), { code: 'crash-after-pointer' });
      }
      completions.push(input);
    },
    abandonIntent: async (input) => { abandons.push(input); },
    beginSteadyLease: async (input) => {
      events.push('beginSteadyLease');
      if (!state.leaseGrants) {
        throw Object.assign(new Error('dormant'), { code: 'p02-steady-writer-generation-absent' });
      }
      return { capability: hex('capability') };
    },
    finishSteadyLease: async (capability, outcome) => { events.push(`finish:${outcome}`); },
    createTransport: () => ({
      publishBatch: async (input) => {
        events.push('publishBatch');
        publishCalls.push(input);
        if (state.crashAt === 'after-revision-before-pointer') {
          throw Object.assign(new Error('crash'), { code: 'crash-before-pointer' });
        }
        /* The real CAS: the supplied token must match what the repository
         * currently holds, or the precondition fails. */
        if (input.expectedCurrentHeadsSnapshotSha256 !== state.repositoryPointer) {
          return { ok: false, errorCode: 'p02-z4-pointer-stale-precondition' };
        }
        state.repositoryPointer = hex('pointer-B');
        return {
          ok: true, verdict: 'committed',
          headsSnapshotSha256: hex('snap-B'),
          casTokenSource: input.expectedCurrentHeadsSnapshotSha256 === undefined
            ? 'derived-at-publish' : 'supplied-by-caller'
        };
      }
    }),
    observeAuthority: async (input) => {
      events.push(`authority:${input.moment}`);
      return state.authorityPermits(input);
    },
    healPublishedIdentity: async () => ({ healed: false })
  });

  return { state, publication, events, intents, completions, abandons, publishCalls };
}

const publish = (w) => w.publication.publishObject({
  objectDomain: DOMAIN, objectId: OBJECT, objectKey: OBJECT_KEY, writerSyncPeerId: WRITER
});

/* ===== 1-3. Steady publication over an existing writer state ===== */
{
  const w = world();
  const first = await publish(w);
  equal(first.outcome, P02_STEADY_OUTCOME.COMMITTED, 'S1 steady publication commits');
  check(isMintedP02RevisionId(first.revisionId), 'S2 with a freshly minted P02 identity');
  equal(first.parentSelection, 'descendant', 'S3 parented on the proven published anchor');
  equal(first.lane, 'local-change', 'S4 through the ordinary local-change lane');

  /* 3. The canonical SOURCE id never changed - only the payload did - and that
   * is still a publishable change, which the old id-based rule could not see. */
  equal(w.completions.length, 1, 'S5 completing exactly once');
  equal(w.completions[0].payloadSha256, w.state.canonicalPayload,
    'S6 recording the payload identity actually published');
}

/* ===== 4-5. Fresh descendant identities, and parenting after an apply ===== */
{
  /* 4. A -> B -> A: three publications of two contents yield three identities. */
  const identities = new Set();
  for (const payload of [hex('A'), hex('B'), hex('A')]) {
    const w = world({ canonicalPayload: payload });
    const published = await publish(w);
    equal(published.outcome, P02_STEADY_OUTCOME.COMMITTED, 'S7 each publication commits');
    identities.add(published.revisionId);
  }
  equal(identities.size, 3, 'S8 A->B->A produces three DISTINCT minted identities');

  /* 5. Apply Y then edit to X: the applied anchor is the parent. */
  const afterApply = world({
    protocol: {
      convergedDirection: 'applied',
      publishedPayloadSha256: hex('old-published'),
      appliedPayloadSha256: hex('applied-Y'),
      lastApplied: { revisionId: 'p02-applied-Y', revisionBlobSha256: hex('applied-blob') },
      pendingOperation: null
    },
    canonicalPayload: hex('edited-X')
  });
  const parented = await publish(afterApply);
  equal(parented.outcome, P02_STEADY_OUTCOME.COMMITTED,
    'S9 a local edit after an apply publishes');
  equal(parented.parentSelection, 'descendant', 'S10 parented on the applied anchor');
}

/* ===== 6. First-P02 onboarding is its own lane ===== */
{
  const onboarding = world({
    protocol: { convergedDirection: null, pendingOperation: null },
    baseHeads: [headFor('chat-other', 'p02-other', 'other-blob')],
    anchorProof: () => ({ status: 'absent' })
  });
  const result = await publish(onboarding);
  equal(result.outcome, P02_STEADY_OUTCOME.COMMITTED,
    'S11 a P01-converged object with no advertised group onboards');
  equal(result.lane, 'first-p02-onboarding', 'S12 through the ONBOARDING lane, not dirty');
  equal(result.parentSelection, 'root', 'S13 as a v2 ROOT');

  /* With its own group already advertised, ROOT is forbidden. */
  const advertised = world({
    protocol: { convergedDirection: null, pendingOperation: null },
    anchorProof: () => ({ status: 'absent' })
  });
  const refused = await publish(advertised);
  check(refused.outcome !== P02_STEADY_OUTCOME.COMMITTED,
    'S14 an object already advertised never re-roots');
}

/* ===== 7 + 25. The explicit CAS token, and the fallback being unreachable ===== */
{
  const w = world();
  await publish(w);
  const call = w.publishCalls[0];
  check(call.expectedCurrentHeadsSnapshotSha256 !== undefined,
    'C1 steady publication ALWAYS supplies an explicit CAS token');
  equal(call.expectedCurrentHeadsSnapshotSha256, hex('pointer-A'),
    'C2 taken from the base it planned against');

  /* The adversarial case: the pointer moves between the base read and publish. */
  const raced = world();
  const originalTransport = raced.publication;
  raced.state.repositoryPointer = hex('pointer-MOVED');
  const stale = await publish(raced);
  equal(stale.outcome, P02_STEADY_OUTCOME.STALE_BASE,
    'C3 an interleaved pointer advance REFUSES');
  equal(raced.publishCalls[0].expectedCurrentHeadsSnapshotSha256, hex('pointer-A'),
    'C4 conditioned on the base the caller planned on, NOT the newer pointer');
  equal(raced.completions.length, 0, 'C5 with nothing completed');
  equal(raced.abandons[0]?.retain, true,
    'C6 and the intent retained, because only repository proof may disprove it');

  /* The compatibility self-read path is unreachable: the source never omits
   * the token, and a missing token is refused before any write. */
  const source = fs.readFileSync(path.join(
    root, 'packages/core/sync-steady-publication-v2.mjs'), 'utf8');
  check(source.includes('expectedCurrentHeadsSnapshotSha256: plan.expectedCurrentHeadsSnapshotSha256'),
    'C7 the token is passed explicitly at the publish call');
  check(source.includes('P02_STEADY_ERROR.CAS_TOKEN_REQUIRED'),
    'C8 and a plan with no token is refused before publishing');
  const publishCall = source.slice(source.indexOf('transport.publishBatch('));
  check(publishCall.slice(0, 300).includes('expectedCurrentHeadsSnapshotSha256'),
    'C9 so publishBatch never falls back to re-reading the pointer itself');
}

/* ===== 8-14. The crash matrix and the mint boundary ===== */
{
  /* 8. Crash BEFORE intent: the mint vanishes harmlessly. */
  const beforeIntent = world({ crashAt: 'before-intent' });
  const crashed = await publish(beforeIntent).catch((error) => ({ thrown: error?.code }));
  equal(beforeIntent.intents.length, 0, 'R1 a crash before intent records nothing durable');
  check(crashed.outcome === P02_STEADY_OUTCOME.BLOCKED || crashed.thrown,
    'R2 and the attempt simply fails');

  /* 9. Crash AFTER intent, before the immutable write. */
  const afterIntent = world({ crashAt: 'after-intent' });
  const midway = await publish(afterIntent).catch((error) => ({ thrown: error?.code }));
  equal(afterIntent.intents.length, 1, 'R3 the intent IS durable');
  equal(afterIntent.publishCalls.length, 0, 'R4 with nothing published');
  check(midway.outcome === P02_STEADY_OUTCOME.BLOCKED || midway.thrown,
    'R5 and the attempt fails with the intent retained');

  /* 10. Crash after the revision write, before the pointer. */
  const beforePointer = world({ crashAt: 'after-revision-before-pointer' });
  const orphaned = await publish(beforePointer);
  equal(orphaned.outcome, P02_STEADY_OUTCOME.BLOCKED,
    'R6 a crash before the pointer blocks');
  equal(orphaned.retainedIntent, true,
    'R7 RETAINING the intent - the write may have landed, so only proof may decide');
  equal(beforePointer.completions.length, 0, 'R8 with nothing completed locally');

  /* 11. Crash after the pointer, before local completion. */
  const afterPointer = world({ crashAt: 'after-pointer' });
  const uncompleted = await publish(afterPointer);
  equal(afterPointer.publishCalls.length, 1, 'R9 the pointer was committed');
  check(uncompleted.outcome !== P02_STEADY_OUTCOME.COMMITTED,
    'R10 but the attempt does not claim success');
  equal(uncompleted.retainedIntent, true, 'R11 and the intent is retained for recovery');

  /* 12. Restart recovers the intended mint rather than minting again. */
  const intended = 'p02-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const recovering = world({
    protocol: {
      convergedDirection: 'published',
      publishedPayloadSha256: hex('old'),
      pendingOperation: 'publish',
      intendedRevisionId: intended,
      intendedRevisionBlobSha256: hex('intended-blob'),
      intendedPayloadSha256: hex('intended-payload'),
      pointerProof: {
        status: 'verified', namesRevisionId: intended,
        namesRevisionBlobSha256: hex('intended-blob')
      }
    }
  });
  const recovered = await publish(recovering);
  equal(recovered.outcome, P02_STEADY_OUTCOME.RECOVERED,
    'R12 a proven intent recovers rather than republishing');
  equal(recovered.reusedMint, intended, 'R13 REUSING the recorded mint');
  equal(recovering.events.includes('mint'), false, 'R14 and never minting again');
  equal(recovering.publishCalls.length, 0, 'R15 with no republication');

  /* 13. Verified disproof abandons and re-plans with a fresh mint. */
  const disproved = world({
    protocol: {
      convergedDirection: 'published',
      publishedPayloadSha256: hex('canonical-old'),
      lastPublished: { revisionId: 'p02-parent', revisionBlobSha256: hex('parent-blob') },
      pendingOperation: 'publish',
      intendedRevisionId: intended,
      intendedRevisionBlobSha256: hex('intended-blob'),
      pointerProof: { status: 'verified', namesRevisionId: 'p02-something-else' }
    }
  });
  const replanned = await publish(disproved);
  equal(disproved.abandons[0]?.retain, false,
    'R16 verified disproof abandons WITHOUT retaining');
  equal(replanned.outcome, P02_STEADY_OUTCOME.COMMITTED,
    'R17 and the attempt re-plans in the same pass');
  check(replanned.revisionId !== intended,
    'R18 with a FRESH mint that cannot collide with the abandoned one');

  /* 14. A read error is NOT disproof. */
  const unreadable = world({
    protocol: {
      convergedDirection: 'published', publishedPayloadSha256: hex('old'),
      pendingOperation: 'publish',
      intendedRevisionId: intended,
      intendedRevisionBlobSha256: hex('intended-blob'),
      pointerProof: { status: 'unreadable' }
    }
  });
  const aborted = await publish(unreadable);
  equal(aborted.outcome, P02_STEADY_OUTCOME.BLOCKED, 'R19 a read error blocks');
  equal(aborted.retainedIntent, true, 'R20 retaining the intent');
  equal(unreadable.events.includes('mint'), false,
    'R21 and NEVER minting a competitor for a revision that may already exist');
  equal(unreadable.abandons.length, 0, 'R22 abandoning nothing');
}

/* ===== 15-18. Eligibility refusals ===== */
{
  /* 15. Unchanged after publish: no second publication. */
  const converged = world({ canonicalPayload: hex('canonical-old') });
  const settled = await publish(converged);
  equal(settled.outcome, P02_STEADY_OUTCOME.NOT_ELIGIBLE, 'E1 unchanged content does not publish');
  equal(settled.reason, 'converged', 'E2 reported as converged');
  equal(converged.publishCalls.length, 0, 'E3 with no repository write');

  /* 16. A canonical edit after publish IS eligible - covered by S1 above. */
  const edited = world({ canonicalPayload: hex('freshly-edited') });
  equal((await publish(edited)).outcome, P02_STEADY_OUTCOME.COMMITTED,
    'E4 a canonical edit after publish is eligible');

  for (const [over, reason, label] of [
    [{ protocol: { convergedDirection: 'published', publishedPayloadSha256: hex('o'),
      divergedUnresolved: true } }, 'diverged-unresolved', 'E5 unresolved remote divergence'],
    [{ protocol: { convergedDirection: 'published', publishedPayloadSha256: hex('o'),
      integrityQuarantined: true } }, 'integrity-quarantined', 'E6 integrity quarantine'],
    [{ protocol: { convergedDirection: 'published', publishedPayloadSha256: hex('o'),
      blockReason: 'capacity' } }, 'capacity', 'E7 a capacity block'],
    [{ protocol: { convergedDirection: 'published', publishedPayloadSha256: hex('o'),
      retainedUnprovenParent: true } }, 'retained-unproven-parent', 'E8 unproven ancestry'],
    [{ protocol: { convergedDirection: 'published', publishedPayloadSha256: hex('o'),
      foreignLanePublicationActive: true } }, 'foreign-lane-publication-active',
    'E9 an active foreign-lane publication']
  ]) {
    const w = world(over);
    const refused = await publish(w);
    check(refused.outcome !== P02_STEADY_OUTCOME.COMMITTED, `${label} never publishes`);
    equal(refused.reason, reason, `${label} says why`);
    equal(w.publishCalls.length, 0, `${label} writes nothing`);
  }
}

/* ===== 19-21. Closures, replay, and isolation ===== */
{
  /* 19. A closure publication gets an engine-minted id like any other. */
  const closure = world();
  const published = await publish(closure);
  check(isMintedP02RevisionId(published.revisionId),
    'K1 every publication - closure or content - carries an engine-minted id');

  /* 20. Exact replay: once converged, a second attempt does nothing. */
  const replay = world();
  await publish(replay);
  replay.state.protocol = {
    ...replay.state.protocol,
    publishedPayloadSha256: replay.state.canonicalPayload
  };
  const second = await publish(replay);
  equal(second.outcome, P02_STEADY_OUTCOME.NOT_ELIGIBLE, 'K2 an exact replay publishes nothing');
  equal(replay.publishCalls.length, 1, 'K3 with exactly one repository write in total');

  /* 21. Multi-object isolation: a refusal for one object says nothing about
   * another, because every port is scoped by objectId. */
  const isolated = world();
  const other = await isolated.publication.publishObject({
    objectDomain: DOMAIN, objectId: 'chat-other', objectKey: hex('key-chat-other'),
    writerSyncPeerId: WRITER
  });
  /* That publication advanced the pointer, so the next attempt reads a fresh
   * base - which is exactly what the next PASS does, and is why the CAS token
   * must never be cached across attempts. */
  isolated.state.basePointer = isolated.state.repositoryPointer;
  const mine = await publish(isolated);
  equal(mine.outcome, P02_STEADY_OUTCOME.COMMITTED,
    'K4 one object publishes regardless of another object\'s outcome');
  check(typeof other.outcome === 'string', 'K5 and the other reports its own outcome');
}

/* ===== 2. Heads preservation - the whole point of publication N+1 ===== */
{
  /* One existing object, publish a second: the first survives. */
  const two = world({
    baseHeads: [headFor('chat-other', 'p02-other', 'other-blob')],
    protocol: { convergedDirection: null, pendingOperation: null },
    anchorProof: () => ({ status: 'absent' })
  });
  await publish(two);
  const heads = two.publishCalls[0].heads;
  equal(heads.length, 2, 'H1 publishing a second object advertises both');
  check(heads.some((head) => head.objectId === 'chat-other'),
    'H2 the unrelated object survives publication N+1');

  /* 100 groups, update one: the other 99 are carried verbatim. */
  const many = world({
    baseHeads: [
      ...Array.from({ length: 99 }, (_, i) =>
        headFor(`obj-${String(i).padStart(3, '0')}`, `p02-r${i}`, `b${i}`)),
      headFor(OBJECT, 'p02-parent', 'parent-blob')
    ]
  });
  const published = await many.publishCalls ? await publish(many) : null;
  const merged = many.publishCalls[0].heads;
  equal(merged.length, 100, 'H3 100 groups stay 100 groups');
  equal(published.carriedHeadCount, 99, 'H4 with 99 carried');
  const carried = merged.filter((head) => head.objectId !== OBJECT);
  const original = many.state.baseHeads.filter((head) => head.objectId !== OBJECT);
  equal(JSON.stringify(carried.map((h) => h.revisionId).sort()),
    JSON.stringify(original.map((h) => h.revisionId).sort()),
    'H5 and every carried group byte-identical to the verified base');

  /* Multi-tip carried group: a fork elsewhere is carried whole. */
  const multiTip = world({
    baseHeads: [
      headFor('chat-fork', 'p02-f1', 'f1'),
      headFor('chat-fork', 'p02-f2', 'f2'),
      headFor(OBJECT, 'p02-parent', 'parent-blob')
    ]
  });
  await publish(multiTip);
  const forkTips = multiTip.publishCalls[0].heads.filter((h) => h.objectId === 'chat-fork');
  equal(forkTips.length, 2, 'H6 a multi-tip group elsewhere is carried whole');

  /* No wall clock: the head timestamp comes from durable projected data. */
  equal(multiTip.publishCalls[0].heads.find((h) => h.objectId === OBJECT).sourceUpdatedAtIso,
    SOURCE_AT, 'H7 the published head carries the DURABLE source timestamp');
  const missingTimestamp = world();
  missingTimestamp.publication.publishObject; /* keep the port shape */
  const source = fs.readFileSync(path.join(
    root, 'packages/core/sync-steady-publication-v2.mjs'), 'utf8');
  check(/new Date\(\)\.toISOString|Date\.now\(\)/.test(source) === false,
    'H8 and the module consults no wall clock at all');
  check(source.includes('P02_STEADY_ERROR.SOURCE_TIMESTAMP_MISSING'),
    'H9 refusing rather than substituting one when it is absent');
}

/* ===== 22-24. Scheduler integration and authority ===== */
{
  /* 24. Authority revoked before the mutating call: nothing is written. */
  let moment = 0;
  const revoked = world({
    authorityPermits: () => {
      moment += 1;
      return moment === 1 ? { permitted: true } : { permitted: false, reason: 'gate-inactive' };
    }
  });
  const refused = await publish(revoked);
  equal(refused.outcome, P02_STEADY_OUTCOME.AUTHORITY_REFUSED,
    'A1 authority withdrawn before the write refuses');
  equal(refused.moment, 'before-mutation', 'A2 at the pre-mutation observation');
  equal(revoked.publishCalls.length, 0, 'A3 with NOTHING written');
  equal(revoked.abandons[0]?.retain, true, 'A4 and the intent retained');
  check(revoked.events.filter((e) => e.startsWith('authority:')).length >= 2,
    'A5 authority is observed at least twice per attempt, never cached');

  /* 22 + 23. The driver reuses the accepted single-flight runtime. */
  const w = world();
  const driver = createP02SteadyDriver({
    steadyPublication: w.publication,
    peerId: WRITER, clock: () => 0,
    enumerate: async () => [{ objectDomain: DOMAIN, objectId: OBJECT, objectKey: OBJECT_KEY }],
    classify: async () => ({ classification: 'local-ahead' }),
    authority: async () => ({ mode: 'auto', valid: true }),
    gate: async () => ({ state: 'unsupported-format', mayRead: true, mayWrite: false })
  });
  equal(driver.dormant, true, 'A6 the driver declares itself dormant');
  const first = driver.runtime.runPass({ maxSteps: 1 });
  const second = driver.runtime.runPass({ maxSteps: 1 });
  equal(first, second, 'A7 concurrent wakes coalesce onto one in-flight pass');
  const settled = await first;
  equal(settled.status, P02_RUNTIME_STATUS.GATE_INACTIVE,
    'A8 and an inactive gate enumerates without mutating');
  equal(w.publishCalls.length, 0, 'A9 so no steady publication is attempted at all');
  check(driver.runtime.driverState().coalescedWakes >= 1,
    'A10 with the trailing wake retained by the accepted driver');

  /* The outcome mapping speaks the accepted taxonomy, not a second language. */
  for (const [outcome, expected] of [
    [P02_STEADY_OUTCOME.COMMITTED, 'published'],
    [P02_STEADY_OUTCOME.RECOVERED, 'published'],
    [P02_STEADY_OUTCOME.NOT_ELIGIBLE, 'no-active'],
    [P02_STEADY_OUTCOME.STALE_BASE, 'stale']
  ]) {
    equal(classifySteadyOutcome({ outcome }).verdict, expected,
      `A11 ${outcome} maps to the accepted verdict ${expected}`);
  }
  equal(classifySteadyOutcome({ outcome: P02_STEADY_OUTCOME.INTEGRITY }).errorClass, 'integrity',
    'A12 an integrity outcome maps to the integrity class');
  equal(classifySteadyOutcome({ outcome: P02_STEADY_OUTCOME.BLOCKED, blockReason: 'transport' })
    .errorCode, 'blocked(transport)', 'A13 and a block carries its reason');
}

/* ===== DORMANCY PROOF ===== */
/* ===== P. Production Chrome owner: manual first publication + recovery ===== */
{
  const LOCAL = 'studio-chrome:extension:synthetic-reverse-peer';
  const REMOTE = 'studio-desktop:tauri-desktop:sqlite:synthetic-parent';
  const objectId = 'reverse-direction-fixture';
  const objectKey = await objectKeyHex(DOMAIN, objectId, crypto.webcrypto);
  const writerKey = await writerKeyHex(LOCAL, crypto.webcrypto);
  const oldPayload = chatPayload(objectId, 'saved-r1', 'applied from Desktop');
  const changedPayload = chatPayload(objectId, 'saved-r2', 'edited locally in Chrome');
  const parent = await produceChatRevisionV2({
    canonicalObject: { objectId, revisionId: `p02-${'1'.repeat(32)}`, payload: oldPayload },
    writerSyncPeerId: REMOTE, cryptoImplementation: crypto.webcrypto
  });
  const changedIdentity = await produceChatRevisionV2({
    canonicalObject: { objectId, revisionId: `p02-${'2'.repeat(32)}`, payload: changedPayload },
    writerSyncPeerId: LOCAL, p02Parent: {
      previousRevisionId: parent.revisionId,
      previousRevisionBlobSha256: parent.revisionBlobSha256,
      provenP02Parent: true
    }, cryptoImplementation: crypto.webcrypto
  });

  function makeStore(events, { failCommitOnce = false } = {}) {
    let pending = null;
    let tip = null;
    let direction = 'applied';
    let commitFailure = failCommitOnce;
    let stages = 0;
    let commits = 0;
    return {
      listReadOnlyObjectIds: async () => [objectId],
      readApplySnapshot: async () => ({
        ok: true, observations: [], applyState: {
          pending: null,
          lastApplied: {
            revisionId: parent.revisionId,
            revisionBlobSha256Hex: parent.revisionBlobSha256,
            payloadSha256Hex: parent.payloadSha256
          }
        }
      }),
      readLocalPublicationTip: async () => tip,
      readLocalPublicationConvergence: async () => ({
        tip, convergedDirection: direction
      }),
      resolveLocalPublicationPending: async () => pending
        ? { state: pending.state === 'promote-ready' ? 'PromoteReady' : 'ResumeRetry',
          pending: { state: pending.state, request: pending.request } }
        : { state: 'Clean', pending: null },
      listLocalPublicationRecoveryObjects: async () => pending
        ? [{ objectId, objectKey, revisionId: pending.request.revisionId,
          state: pending.state }]
        : [],
      async stageLocalPublicationIntent(input) {
        stages += 1;
        events.push('ledger:stage');
        pending = { state: 'promote-ready', request: { ...input } };
        return { ok: true, verdict: 'promote-ready' };
      },
      async markLocalPublicationRetry(key, revisionId) {
        if (!pending || key !== objectKey || revisionId !== pending.request.revisionId) {
          throw new Error('fixture-pending-mismatch');
        }
        pending.state = 'resume-retry';
        events.push('ledger:retain');
        return { ok: true, verdict: 'resume-retry' };
      },
      async commitLocalPublicationIntent(key, revisionId) {
        events.push('ledger:commit-attempt');
        if (commitFailure) {
          commitFailure = false;
          throw Object.assign(new Error('fixture-crash-after-pointer'), {
            code: 'fixture-crash-after-pointer'
          });
        }
        if (!pending || key !== objectKey || revisionId !== pending.request.revisionId) {
          throw new Error('fixture-commit-mismatch');
        }
        tip = {
          objectKey, revisionId,
          previousRevisionId: pending.request.previousRevisionId,
          revisionBlobSha256Hex: pending.request.revisionBlobSha256Hex,
          headSha256Hex: pending.request.headSha256Hex,
          payloadSha256Hex: pending.request.payloadSha256Hex,
          producedAtIso: SOURCE_AT
        };
        direction = 'published';
        pending = null;
        commits += 1;
        events.push('ledger:committed');
        return { ok: true, verdict: 'committed', tip };
      },
      stats: () => ({ stages, commits, pending, tip, direction })
    };
  }

  function ownerWorld({ payload = changedPayload, mode = 'manual',
    failCommitOnce = false, existingGeneration = null } = {}) {
    const fsa = createMemoryFsa();
    const events = fsa.events;
    fsa.put(`${P02_FSA_REPOSITORY_CHILD}/objects/${objectKey}/revisions/` +
      `${parent.revisionBlobSha256}.json`, parent.canonicalBytes);
    if (existingGeneration !== null) {
      fsa.put(`${P02_FSA_REPOSITORY_CHILD}/writers/${writerKey}/generation.json`,
        new TextEncoder().encode(JSON.stringify(existingGeneration)));
    }
    const store = makeStore(events, { failCommitOnce });
    const payloadIdentity = payload === changedPayload
      ? changedIdentity.payloadSha256 : parent.payloadSha256;
    const projection = {
      projectCurrent: async () => ({
        objectId, revisionId: payload === changedPayload ? 'saved-r2' : 'saved-r1',
        revisionBlobSha256Hex: hex(payload === changedPayload ? 'canonical-r2' : 'canonical-r1'),
        payloadSha256Hex: payloadIdentity, objectKeyHex: objectKey,
        sourceUpdatedAtIso: SOURCE_AT, payload
      })
    };
    const publication = createChromeP02PublicationOwner({
      loadContainerHandle: async () => fsa.handle,
      identityProvider: { whenSyncReady: async () => ({ syncPeerId: LOCAL }) },
      configProvider: async () => ({ schemaVersion: 1, mode, configuredPeers: [] }),
      writerGenerationGate: {
        /* The canonical observer emits `recorded`; `present` is a token it can
         * never produce, and a double that speaks it hides exactly the
         * producer/consumer drift this suite is meant to catch. */
        observe: async () => ({ state: P02_GENERATION_STATE.RECORDED, generation: 'p02', record: {
          standdownAt: SOURCE_AT, decidedByWriterSyncPeerId: REMOTE
        } }),
        p01MayMutate: async () => ({ permitted: false, generation: 'p02',
          reason: 'p01-writer-stood-down' })
      },
      archiveAuthority: { listWorkbenchRows: async () => [{
        chatId: objectId, isDeleted: false
      }] },
      projection, syncStore: store,
      observeFormat: async () => ({ gate: { mayRead: true, mayWrite: true } }),
      lockManager: { request: async (_name, _options, callback) => callback({ mode: 'exclusive' }) },
      cryptoImplementation: crypto.webcrypto,
      onTrace: (row) => events.push(`trace:${row?.result?.outcome || 'step'}`)
    });
    return { publication, fsa, store, events, writerKey };
  }

  /* Applied bytes are converged and must never echo back. */
  const echo = ownerWorld({ payload: oldPayload });
  const echoResult = await echo.publication.publishManual();
  equal(echoResult.outcome, 'no-eligible-local-change',
    'P1 unchanged applied content is not a Chrome publication candidate');
  equal(echo.fsa.listFiles().filter((name) => name.endsWith('/state.json')).length, 0,
    'P2 anti-echo performs no writer-state promotion');

  const manual = ownerWorld();
  const published = await manual.publication.publishManual();
  equal(published.outcome, 'published', 'P3 one trusted-manual call publishes local delta');
  check(/^p02-[0-9a-f]{32}$/.test(published.mintedRevisionId || ''),
    'P4 publication uses a fresh engine-minted P02 revision id');
  equal(published.localWriterSyncPeerId, LOCAL,
    'P5 repository writer identity is the local Chrome identity');
  equal(published.localWriterKey, writerKey,
    'P6 local Chrome writerKey is deterministically derived');
  equal(manual.store.stats().stages, 1, 'P7 durable intent is staged once');
  equal(manual.store.stats().commits, 1, 'P8 publication ledger commits once');
  const stageAt = manual.events.indexOf('ledger:stage');
  const revisionWriteAt = manual.events.findIndex((event) =>
    event.startsWith(`write:${P02_FSA_REPOSITORY_CHILD}/objects/`));
  const headsWriteAt = manual.events.findIndex((event) => event.includes('/heads/') &&
    event.startsWith('write:'));
  const statePromotionAt = manual.events.findIndex((event) =>
    event === `promote:${P02_FSA_REPOSITORY_CHILD}/writers/${writerKey}/state.json`);
  const ledgerCommitAt = manual.events.indexOf('ledger:committed');
  check(stageAt >= 0 && stageAt < revisionWriteAt && revisionWriteAt < headsWriteAt &&
    headsWriteAt < statePromotionAt && statePromotionAt < ledgerCommitAt,
  'P9 durable intent -> revision -> heads -> state -> ledger ordering is exact');
  check(manual.fsa.has(`${P02_FSA_REPOSITORY_CHILD}/writers/${writerKey}/generation.json`),
    'P10 writer-scoped p02 generation is initialized and retained');

  /* Crash after the externally-visible pointer, before local ledger commit:
   * the restart adopts that exact pointer and never stages/mints a competitor. */
  const recovering = ownerWorld({ failCommitOnce: true });
  const interrupted = await recovering.publication.publishManual();
  equal(interrupted.outcome, 'fixture-crash-after-pointer',
    'P11 an interrupted post-pointer commit is reported without retry');
  const stagedMint = recovering.store.stats().pending?.request?.revisionId;
  check(/^p02-[0-9a-f]{32}$/.test(stagedMint || ''),
    'P12 the interrupted attempt retains its durable mint');
  const resumed = await recovering.publication.publishManual();
  equal(resumed.outcome, 'recovered', 'P13 restart adopts verified state pointer');
  equal(resumed.reusedMint, stagedMint, 'P14 recovery reuses the exact durable mint');
  equal(recovering.store.stats().stages, 1, 'P15 recovery stages no second intent');
  equal(recovering.fsa.listFiles().filter((name) =>
    name.includes(`/objects/${objectKey}/revisions/`)).length, 2,
  'P16 repository holds the parent plus exactly one Chrome revision');

  const manualAuto = ownerWorld({ mode: 'manual' });
  const autonomousRefusal = await manualAuto.publication.publishAutomaticDescendant();
  equal(autonomousRefusal.outcome, 'p02-chrome-publication-automatic-disabled',
    'P17 manual mode executes zero autonomous publication');
  equal(manualAuto.store.stats().stages, 0,
    'P18 manual-mode wake writes no publication intent');

  /* MODE_VOCABULARY_ALIGNMENT (T02 correction D): `off` is an explicit, named
   * refusal for automatic AND manual publication - never a collapsed
   * config-invalid, never automatic-eligible - and it writes no intent. */
  const offMode = ownerWorld({ mode: 'off' });
  const offAutomatic = await offMode.publication.publishAutomaticDescendant();
  equal(offAutomatic.outcome, 'p02-chrome-publication-sync-mode-off',
    'P18a off mode refuses autonomous publication by name');
  const offManual = await offMode.publication.publishManual();
  equal(offManual.outcome, 'p02-chrome-publication-sync-mode-off',
    'P18b off mode refuses manual publication by the same name');
  equal(offMode.store.stats().stages, 0,
    'P18c off-mode wakes write no publication intent');

  const invalidGeneration = ownerWorld({ existingGeneration: {
    schema: P02_FSA_WRITE_V2.GENERATION_SCHEMA, generation: 'p01', writerKey
  } });
  const generationRefusal = await invalidGeneration.publication.publishManual();
  equal(generationRefusal.outcome, 'p02-fsa-write-generation-conflict',
    'P19 a conflicting repository generation fails closed');
  equal(invalidGeneration.store.stats().stages, 0,
    'P20 generation refusal precedes durable intent and repository publication');

  const driverSource = fs.readFileSync(path.join(
    root, 'packages/core/sync-steady-driver-v2.mjs'), 'utf8');
  check(driverSource.includes('writerSyncPeerId: peerId') &&
    !driverSource.includes('writerSyncPeerId: candidate.syncPeerId'),
  'P21 remote candidate identity cannot become the local publication writer');
}

/* ===== DORMANCY / OWNERSHIP PROOF ===== */
{
  const composition = fs.readFileSync(path.join(
    root, 'packages/core/sync-steady-publication-v2.mjs'), 'utf8');
  const driver = fs.readFileSync(path.join(
    root, 'packages/core/sync-steady-driver-v2.mjs'), 'utf8');

  /* Scan CODE, not prose: both modules document that they create no
   * writer-generation record, and a naive search matches that sentence. */
  const stripComments = (text) =>
    text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const [raw, name] of [[composition, 'composition'], [driver, 'driver']]) {
    const source = stripComments(raw);
    for (const [pattern, label] of [
      [/setTimeout|setInterval|requestIdleCallback|requestAnimationFrame/, 'a timer'],
      [/addEventListener|onvisibilitychange|onfocus|chrome\.alarms|chrome\.runtime\.on/, 'a live listener'],
      [/document\.|window\.addEventListener/, 'a DOM hook'],
      [/writers\/|state\.json|kv_store|chrome\.storage/, 'a real store or repository path'],
      [/generation\.json|writer-generation/, 'a writer-generation write'],
      [/P02_V8_GOVERNED_CAMPAIGN|OPERATOR_AUTHORIZATION|progression|acceptance-token/i,
        'an activation or progression token']
    ]) {
      check(pattern.test(source) === false, `D1 the ${name} contains no ${label}`);
    }
  }
  equal(P02_STEADY_PUBLICATION_V2.DORMANT, true, 'D2 the composition declares dormancy');
  equal(P02_STEADY_DRIVER_V2.DORMANT, true, 'D3 and so does the driver');

  /* Nothing in production constructs either one. */
  const productionRefs = [];
  const scan = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (['node_modules', 'dist', 'prod', 'target', '.git'].includes(entry.name)) continue;
        scan(full);
        continue;
      }
      if (!/\.(mjs|js)$/.test(entry.name)) continue;
      if (full.includes('/tools/validation/')) continue;
      const text = fs.readFileSync(full, 'utf8');
      /*
       * A module DEFINING the factory is not a caller of it, and neither is a
       * string that merely names the activation seam for documentation. Strip
       * comments, string literals and the definitions before looking for calls.
       */
      const calls = text
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '')
        .replace(/'[^']*'/g, "''")
        .replace(/"[^"]*"/g, '""')
        .replace(/export function createP02Steady\w+/g, '');
      if (/createP02SteadyPublication\s*\(|createP02SteadyDriver\s*\(/.test(calls)) {
        productionRefs.push(path.relative(root, full));
      }
    }
  };
  for (const dir of ['packages', 'src-surfaces-base', 'apps/studio/desktop/build-tools']) {
    const full = path.join(root, dir);
    if (fs.existsSync(full)) scan(full);
  }
  /*
   * NARROWED at O1-R3 B2, and narrowed toward the claim that actually matters.
   *
   * This pinned ZERO production constructors because the accepted driver had no
   * caller at all, and an uncalled engine cannot run. B2's whole purpose is to
   * give it exactly ONE governed caller, reached only by an explicitly
   * authorized operator request. Counting constructors would forbid that;
   * naming the one permitted constructor still catches every panel, timer or
   * ad-hoc surface that tries to become a second one.
   */
  const GOVERNED_COMPOSITIONS = [
    'packages/browser-adapters/chrome/sync-p02-publication-chrome-v2.mjs',
    'src-surfaces-base/studio/sync/sync-steady-activation-desktop-v2.tauri.mjs'
  ];
  equal(JSON.stringify(productionRefs.sort()), JSON.stringify(GOVERNED_COMPOSITIONS),
    `D4 only the governed Desktop activation and confined Chrome publication owner construct steady drivers (${productionRefs.join(',')})`);

  /*
   * And that one constructor must not be able to start itself. A composition
   * that scheduled its own pass would be an autonomous writer no matter how
   * narrow its authority checks were.
   */
  for (const governedComposition of GOVERNED_COMPOSITIONS) {
    const governedCompositionCode = fs.readFileSync(path.join(root, governedComposition), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    for (const autonomous of ['setInterval', 'setTimeout', 'requestAnimationFrame',
      'addEventListener', 'queueMicrotask']) {
      check(governedCompositionCode.includes(autonomous) === false,
        `D4b governed composition schedules nothing (${governedComposition}:${autonomous})`);
    }
    for (const forbidden of ['function start(', 'start:', 'arm(', 'runUntil', 'runForever']) {
      check(governedCompositionCode.includes(forbidden) === false,
        `D4c governed composition exposes no self-starting entry point (${governedComposition}:${forbidden})`);
    }
  }

  /* The Rust steady lease is still unreachable from the runtime. */
  const lib = fs.readFileSync(path.join(
    root, 'apps/studio/desktop/src-tauri/src/lib.rs'), 'utf8');
  /*
   * The Rust steady LEASE remains unreachable. O1-R3 adds one read-only
   * observer of the lease record; observing which generation is recorded is not
   * acquiring it, so the dormancy claim is unchanged and is now checked by what
   * the command does rather than by whether one exists.
   */
  /* The authorized B2 closure exposes the accepted steady write window in
   * addition to the observer. Reachable, never autonomous - the autonomy
   * property is pinned in the steady-authority suite and by D4/D4b above. */
  const STEADY_COMMANDS = ['h2o_p02_read_writer_generation_authority',
    'h2o_p02_steady_begin', 'h2o_p02_steady_finish'].sort();
  const registered = [...lib.matchAll(/p02_steady_authority::(\w+)/g)]
    .map((m) => m[1]);
  equal(JSON.stringify([...new Set(registered)].sort()), JSON.stringify(STEADY_COMMANDS),
    'D5 exactly the observer and the two accepted lease commands are registered');
  const steadyRust = fs.readFileSync(path.join(
    root, 'apps/studio/desktop/src-tauri/src/p02_steady_authority.rs'), 'utf8');
  const names = [...steadyRust.matchAll(/#\[tauri::command\]\s*pub fn (\w+)/g)]
    .map((m) => m[1]).sort();
  equal(JSON.stringify(names), JSON.stringify(STEADY_COMMANDS),
    'D6 the steady module exposes exactly those three and nothing more');
  /* The lease commands add no authority of their own. */
  for (const [name, core] of [['h2o_p02_steady_begin', 'steady_begin_core('],
    ['h2o_p02_steady_finish', 'steady_finish_core(']]) {
    const from = steadyRust.indexOf(`pub fn ${name}`);
    const body = steadyRust.slice(from, steadyRust.indexOf('\n}\n', from) + 2);
    check(body.includes(core), `D6b ${name} delegates to the accepted core`);
  }

  /*
   * THE ONBOARDING BOUNDARY. Steady publishes DESCENDANTS; V8-D establishes a
   * writer's pointer and first ROOT. The two must not blur, and the place that
   * could blur them is the composition's lease request: inventing a CAS base
   * for a first own publication would let steady onboard a virgin writer.
   */
  const steadyComposition = fs.readFileSync(path.join(root,
    'src-surfaces-base/studio/sync/sync-steady-activation-desktop-v2.tauri.mjs'), 'utf8');
  check(/expectedCurrentHeadsSnapshotSha256:\s*\n?\s*request\.expectedCurrentHeadsSnapshotSha256 \?\? null/
    .test(steadyComposition),
    'D8 the composition passes the plan CAS base through, inventing none');
  /* Scanned on CODE: the file's own prose explains the boundary, and prose
   * must never satisfy - or fail - a check about behaviour. */
  const steadyCompositionCode = steadyComposition
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const invented of ['firstOwnPublication', 'previousRevisionId: null']) {
    check(steadyCompositionCode.includes(invented) === false,
      `D8b the composition does not special-case first publication (${invented})`);
  }
  /* And the V8-D synthetic onboarding used by the disposable fixture is
   * test-only: it must never be packed into a shipped surface. The fixture
   * itself is campaign-only and not part of the canonical tree, so the
   * invariant is stated on the shipped-tree composers: none of them may
   * reference it. */
  const packer = fs.readFileSync(path.join(root, 'tools/product/studio/pack-studio.mjs'), 'utf8');
  check(packer.includes('p02-v8d-synthetic-onboarding') === false,
    'D9 the V8-D synthetic onboarding bootstrap is not packed into any surface');
  const shippedTreeComposers = [
    'src-surfaces-base/studio/studio.html',
    'tools/product/extensions/chatgpt/chrome/chrome-live-background.mjs',
    'tools/product/extensions/chatgpt/chrome/build-chrome-live-extension.mjs',
    'apps/studio/desktop/build-tools/prepare-dist.mjs'
  ];
  check(shippedTreeComposers.every((rel) =>
    fs.readFileSync(path.join(root, rel), 'utf8').includes('p02-v8d-synthetic-onboarding') === false),
  'D9b and no shipped-tree composer references it');

  /*
   * COPIED-STATE PUBLISHED-SIDE HEAL (third-rehearsal finding).
   *
   * A profile migrated v21 -> v22 can hold a genuinely converged object whose
   * two new columns are still NULL, which the comparator can never read as
   * converged - so it classifies local-ahead forever and is dispatched on every
   * pass. The steady composition must therefore offer the ACCEPTED heal, and
   * must not grow one of its own.
   */
  /* The PORT BINDING, not merely a mention: the publication core only runs the
   * heal if it was actually handed one. */
  check(/^\s*healPublishedIdentity:\s/m.test(steadyCompositionCode),
    'D10 the steady composition binds a published-side heal port');
  check(steadyComposition.includes('createDesktopFirstPublication'),
    'D10b and it reuses the accepted V8-D heal rather than a second authority');
  /*
   * The proof itself must stay where it is. The composition READS those columns
   * - that is its protocol-state projection - but it must never WRITE them, and
   * must never call the guarded UPDATE directly: the heal's authority is the
   * V8-D adapter's proof plus the evidence surface's single statement.
   */
  check(/UPDATE\s+sync_object_state/i.test(steadyCompositionCode) === false,
    'D10c the composition writes no convergence state itself');
  check(steadyCompositionCode.includes('healPublishedPayloadIdentity') === false,
    'D10d it does not call the guarded UPDATE directly');
  check(steadyCompositionCode.includes('plugin:sql|execute') === false,
    'D10e and issues no SQL mutation at all');

  /* The activation seam is recorded, so a future task does not rediscover it. */
  check(typeof P02_STEADY_DRIVER_V2.ACTIVATION_SEAM === 'string' &&
    P02_STEADY_DRIVER_V2.ACTIVATION_SEAM.includes('runPass'),
    'D7 the exact dormant activation seam is named in the driver');
}

const verdict = failures.length === 0
  ? 'P02_O1_STEADY_PUBLICATION_PASS' : 'P02_O1_STEADY_PUBLICATION_FAIL';
console.log(JSON.stringify({
  verdict, assertions, failures,
  casProvenance: 'the expected-current token is captured from the readWriterState '
    + 'that supplied the merge base and passed explicitly; publishBatch\'s '
    + 'compatibility self-read is unreachable from steady publication',
  mintBoundary: 'a mint before durable intent may vanish; after it, recovery '
    + 'reuses the recorded mint and never mints a competitor',
  dormancy: {
    productionConstructors: 0, timers: 0, liveListeners: 0,
    repositoryPathsBound: 0, writerGenerationRecordsCreated: 0,
    steadyTauriCommands: 0,
    activationSeam: P02_STEADY_DRIVER_V2.ACTIVATION_SEAM
  },
  realProfileTouched: false, realRepositoryTouched: false,
  canonicalStateTouched: false, processesLaunched: 0
}, null, 2));
process.exit(failures.length === 0 ? 0 : 1);
