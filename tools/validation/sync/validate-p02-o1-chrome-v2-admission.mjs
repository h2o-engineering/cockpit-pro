#!/usr/bin/env node
/*
 * O1-T11 — Chrome v2 admission and the read-only FSA port.
 *
 * The v2 path runs BESIDE the v1 path, and the first thing checked is that it
 * really is beside: the v1 six-key admission contract must still reject a v2
 * nine-key document, because a boundary that quietly accepts both formats is no
 * boundary at all.
 *
 * CR1 is checked as an attack rather than a bug. A squatted revision id must
 * damage only itself: the honest evidence beside it still indexes, other
 * objects are untouched, and no exception escapes to take a pass down.
 *
 * The FSA port is checked for what it CANNOT do as much as what it can - there
 * is no write surface to find, and permission is queried rather than requested
 * so a background pass can never raise a picker.
 *
 * Real store, real IndexedDB shim, real admission core. Disposable: no live
 * profile, no real repository, no canonical state, no DATABASE_VERSION change,
 * no processes.
 */
import crypto from 'node:crypto';
import {
  P02_CHROME_ADMISSION_ERROR,
  P02_CHROME_ADMISSION_V2,
  createChromeV2BranchAdmission
} from '../../../packages/browser-adapters/chrome/sync-branch-admission-v2.mjs';
import {
  P02_FSA_READ_STATUS,
  P02_FSA_READ_V2,
  createChromeFsaReadTransport
} from '../../../packages/browser-adapters/chrome/sync-fsa-read-transport-v2.mjs';
import {
  P02_ADMISSION_DISPOSITION,
  buildBranchIndex
} from '../../../packages/core/sync-branch-evidence-v2.mjs';
import {
  createInjectedRevisionAdmission
} from '../../../packages/browser-adapters/chrome/sync-revision-admission.mjs';
import {
  ITEM9_1_CONSTANTS,
  createChromeSyncObjectStore
} from '../../../packages/browser-adapters/chrome/sync-object-store.mjs';
import {
  FakeIndexedDBFactory,
  chromeIdentity,
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

const encoder = new TextEncoder();
const DOMAIN = P02_CHROME_ADMISSION_V2.CHAT_OBJECT_DOMAIN;
const WRITER = 'studio-desktop:tauri-desktop:sqlite:t11-peer';
const OBJECT = 'chat-t11-a';
const OBJECT_B = 'chat-t11-b';
const MINT_A = 'p02-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const MINT_B = 'p02-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const MINT_C = 'p02-cccccccccccccccccccccccccccccccc';

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

/* A real v2 envelope: nine keys, parent as a PAIR. */
function v2Revision({ objectId = OBJECT, revisionId, parentId = null, parentBlob = null, text = 'x' }) {
  return {
    schema: P02_CHROME_ADMISSION_V2.REVISION_SCHEMA,
    objectDomain: DOMAIN,
    objectId,
    revisionId,
    writerSyncPeerId: WRITER,
    previousRevisionId: parentId,
    previousRevisionBlobSha256: parentBlob,
    payloadSha256: crypto.createHash('sha256').update(text).digest('hex'),
    payload: { schema: 'h2o.studio.fullBundle.v2', text }
  };
}
const bytesOf = (revision) => encoder.encode(canonicalJson(revision));

/* An in-memory evidence store with exactly the surface the admission uses. */
function evidenceStore() {
  const branch = new Map();
  const observations = new Map();
  return {
    branch, observations,
    listBranchEvidence: async (objectId) =>
      [...branch.values()].filter((r) => r.objectId === objectId),
    recordBranchEvidence: async (record) => {
      const key = `${record.objectId} ${record.revisionId}`;
      const existing = branch.get(key);
      if (existing && existing.revisionBlobSha256Hex !== record.revisionBlobSha256Hex) {
        const error = new Error('conflict');
        error.code = ITEM9_1_CONSTANTS.ERROR_CODE.BRANCH_EVIDENCE_CONFLICT;
        throw error;
      }
      branch.set(key, { ...record, applyState: 'not-applied' });
      return { ok: true };
    },
    listObservations: async (objectId) =>
      [...observations.values()].filter((r) => r.objectId === objectId)
  };
}

/* ===== 1. The v1 contract is untouched and still rejects a v2 document ===== */
{
  const store = createChromeSyncObjectStore({
    identityProvider: identityProvider(chromeIdentity()),
    indexedDBFactory: new FakeIndexedDBFactory(),
    cryptoImplementation: crypto.webcrypto,
    clock: () => '2026-08-26T00:00:00.000Z'
  });
  const v1 = createInjectedRevisionAdmission({
    observationStore: store, cryptoImplementation: crypto.webcrypto
  });
  const revision = v2Revision({ revisionId: MINT_A });
  const bytes = bytesOf(revision);
  const head = {
    schema: 'h2o.studio.syncHead.v1',
    objectId: OBJECT, objectKey: 'a'.repeat(64),
    payloadSha256: revision.payloadSha256,
    previousRevisionId: null,
    revisionBlobSha256: await sha256HexBytes(bytes),
    revisionId: MINT_A,
    sourceUpdatedAtIso: '2026-08-26T00:00:00.000Z',
    writerSyncPeerId: WRITER
  };
  const refused = await v1.admitInjectedRevision({
    headBytes: encoder.encode(canonicalJson(head)), revisionBlobBytes: bytes
  }).then(() => null, (error) => error?.code);
  equal(refused, 'round2-item9-revision-invalid',
    'B1 the v1 six-key contract still rejects a v2 nine-key document');
  check(refused !== null,
    'B2 so the v2 path is genuinely beside the v1 path, not layered over it');
}

/* ===== 2. Valid v2 admission: ROOT, child, and the anchor ===== */
{
  const store = evidenceStore();
  const admission = createChromeV2BranchAdmission({ evidenceStore: store, sha256HexBytes });

  const root = v2Revision({ revisionId: MINT_A });
  const rootBytes = bytesOf(root);
  const rootHash = await sha256HexBytes(rootBytes);
  const admittedRoot = await admission.admitV2Revision({
    revision: root, revisionBlobBytes: rootBytes
  });
  equal(admittedRoot.disposition, P02_ADMISSION_DISPOSITION.ACCEPTED_LINEAR,
    'V1 a v2 ROOT is admitted as linear');
  equal(admittedRoot.persisted, true, 'V2 and persisted to the existing evidence store');
  equal(store.branch.size, 1, 'V3 exactly one record');
  equal([...store.branch.values()][0].applyState, 'not-applied',
    'V4 which is never Apply-eligible by itself');

  const child = v2Revision({ revisionId: MINT_B, parentId: MINT_A, parentBlob: rootHash });
  const admittedChild = await admission.admitV2Revision({
    revision: child, revisionBlobBytes: bytesOf(child)
  });
  equal(admittedChild.disposition, P02_ADMISSION_DISPOSITION.ACCEPTED_LINEAR,
    'V5 a child of retained evidence is linear');

  /* Anchored at a published pair whose parent is not retained. */
  const fresh = evidenceStore();
  const anchored = createChromeV2BranchAdmission({ evidenceStore: fresh, sha256HexBytes });
  const orphanChild = v2Revision({ revisionId: MINT_C, parentId: MINT_A, parentBlob: rootHash });
  const viaAnchor = await anchored.admitV2Revision({
    revision: orphanChild, revisionBlobBytes: bytesOf(orphanChild),
    protocolState: { lastPublished: { revisionId: MINT_A, revisionBlobSha256: rootHash } }
  });
  equal(viaAnchor.disposition, P02_ADMISSION_DISPOSITION.ACCEPTED_LINEAR,
    'V6 T05 anchor semantics apply: a child of the published pair is linear');
  equal(viaAnchor.anchorPairs, 1, 'V7 with one anchor pair assembled');
}

/* ===== 3. Unknown parent waits; no unresolved-hash shortcut exists ===== */
{
  const store = evidenceStore();
  const admission = createChromeV2BranchAdmission({ evidenceStore: store, sha256HexBytes });

  const orphan = v2Revision({ revisionId: MINT_C, parentId: 'p02-absent', parentBlob: 'f'.repeat(64) });
  const waiting = await admission.admitV2Revision({
    revision: orphan, revisionBlobBytes: bytesOf(orphan)
  });
  equal(waiting.disposition, P02_ADMISSION_DISPOSITION.RETAINED_UNPROVEN_PARENT,
    'P1 an unknown parent is retained and waits');
  equal(waiting.applyEligible, false, 'P2 never Apply-eligible while unproven');

  /* A half-pair - parent id without parent bytes - is malformed in v2, not
   * legacy-shaped. The v1 lane tolerates it; this one must not. */
  const halfPair = { ...v2Revision({ revisionId: MINT_B }), previousRevisionId: MINT_A };
  const refused = await admission.admitV2Revision({
    revision: halfPair, revisionBlobBytes: bytesOf(halfPair)
  }).then(() => null, (error) => error?.code);
  equal(refused, P02_CHROME_ADMISSION_ERROR.PARENT_PAIR_REQUIRED,
    'P3 a parent id without parent bytes is refused - no unresolved-hash shortcut');

  const nullBlobOnly = { ...v2Revision({ revisionId: MINT_B }), previousRevisionBlobSha256: 'f'.repeat(64) };
  equal(await admission.admitV2Revision({
    revision: nullBlobOnly, revisionBlobBytes: bytesOf(nullBlobOnly)
  }).then(() => null, (error) => error?.code),
    P02_CHROME_ADMISSION_ERROR.PARENT_PAIR_REQUIRED,
    'P4 and so is the other half of the pair on its own');
}

/* ===== 4. CR1 identity-squat hardening ===== */
{
  const store = evidenceStore();
  const admission = createChromeV2BranchAdmission({ evidenceStore: store, sha256HexBytes });

  const honest = v2Revision({ revisionId: MINT_A, text: 'honest' });
  const honestBytes = bytesOf(honest);
  await admission.admitV2Revision({ revision: honest, revisionBlobBytes: honestBytes });

  /* An observation records the same revisionId with different bytes. Branch
   * evidence and the observation store are two records of one fact; a
   * disagreement between them is a squat whichever one is right. */
  store.observations.set('squat', {
    objectId: OBJECT, revisionId: MINT_B, revisionBlobSha256Hex: 'e'.repeat(64)
  });
  const squat = v2Revision({ revisionId: MINT_B, parentId: MINT_A, parentBlob: await sha256HexBytes(honestBytes) });
  const caught = await admission.admitV2Revision({
    revision: squat, revisionBlobBytes: bytesOf(squat)
  });
  equal(caught.disposition, P02_ADMISSION_DISPOSITION.QUARANTINED,
    'C1 an identity that disagrees with the observation store is quarantined');
  equal(caught.reason, P02_CHROME_ADMISSION_ERROR.OBSERVATION_IDENTITY_CONFLICT,
    'C2 naming the cross-check that caught it');
  equal(caught.persisted, false, 'C3 and is not written into evidence');
  equal(store.branch.size, 1, 'C4 the honest record is still the only one');

  /* The honest record beside it still admits normally afterwards. */
  const sibling = v2Revision({
    revisionId: MINT_C, parentId: MINT_A, parentBlob: await sha256HexBytes(honestBytes), text: 'sibling'
  });
  const stillWorks = await admission.admitV2Revision({
    revision: sibling, revisionBlobBytes: bytesOf(sibling)
  });
  equal(stillWorks.disposition, P02_ADMISSION_DISPOSITION.ACCEPTED_LINEAR,
    'C5 and honest evidence keeps admitting after the squat is refused');
}

/* ===== 5. A squatted id must not collapse the index ===== */
{
  /* Two records claiming one id with different bytes, as a hostile peer could
   * have written before this hardening existed. */
  const records = [
    { revisionBlobSha256: 'a'.repeat(64),
      document: { objectDomain: DOMAIN, objectId: OBJECT, revisionId: MINT_A,
        previousRevisionId: null, previousRevisionBlobSha256: null } },
    { revisionBlobSha256: 'b'.repeat(64),
      document: { objectDomain: DOMAIN, objectId: OBJECT, revisionId: MINT_A,
        previousRevisionId: null, previousRevisionBlobSha256: null } },
    { revisionBlobSha256: 'c'.repeat(64),
      document: { objectDomain: DOMAIN, objectId: OBJECT, revisionId: MINT_B,
        previousRevisionId: null, previousRevisionBlobSha256: null } }
  ];

  /* Default: throws. That is right when the caller controls every record. */
  let threw = null;
  try { buildBranchIndex({ objectDomain: DOMAIN, objectId: OBJECT, records }); }
  catch (error) { threw = error?.code; }
  check(threw !== null,
    'Q1 by default a squatted id still fails the whole index - unchanged behaviour');

  /* Hardened: the squat excludes only itself. */
  const hardened = buildBranchIndex({
    objectDomain: DOMAIN, objectId: OBJECT, records, quarantineIdentityConflicts: true
  });
  check(Array.isArray(hardened.revisionIds), 'Q2 with hardening the index is built at all');
  equal(hardened.identitySquattedRevisionIds.length, 1, 'Q3 one id was squatted');
  equal(hardened.identitySquattedRevisionIds[0], MINT_A, 'Q4 named');
  check(hardened.revisionIds.includes(MINT_A) === false,
    'Q5 and BOTH claimants are excluded - arrival order must not pick a winner');
  check(hardened.revisionIds.includes(MINT_B),
    'Q6 while the honest record beside it survives');
  check(hardened.provenRevisionIds.includes(MINT_B),
    'Q7 and is still proven');
}

/* ===== 6. Object isolation under a squat ===== */
{
  const store = evidenceStore();
  const admission = createChromeV2BranchAdmission({ evidenceStore: store, sha256HexBytes });

  /* Object B is poisoned by an observation conflict. */
  store.observations.set('poison', {
    objectId: OBJECT_B, revisionId: MINT_A, revisionBlobSha256Hex: 'e'.repeat(64)
  });
  const poisoned = await admission.admitV2Revision({
    revision: v2Revision({ objectId: OBJECT_B, revisionId: MINT_A }),
    revisionBlobBytes: bytesOf(v2Revision({ objectId: OBJECT_B, revisionId: MINT_A }))
  });
  equal(poisoned.disposition, P02_ADMISSION_DISPOSITION.QUARANTINED,
    'I1 object B quarantines on its own conflict');

  /* Object A - same revision id! - is completely unaffected. */
  const clean = v2Revision({ objectId: OBJECT, revisionId: MINT_A });
  const unaffected = await admission.admitV2Revision({
    revision: clean, revisionBlobBytes: bytesOf(clean)
  });
  equal(unaffected.disposition, P02_ADMISSION_DISPOSITION.ACCEPTED_LINEAR,
    'I2 object A admits the SAME revision id normally - isolation is per object');
  equal(unaffected.persisted, true, 'I3 and is persisted');

  const aIndex = await admission.indexFor({ objectId: OBJECT });
  const bIndex = await admission.indexFor({ objectId: OBJECT_B });
  equal(aIndex.revisionIds.length, 1, 'I4 object A holds only its own evidence');
  equal(bIndex.revisionIds.length, 0, 'I5 and object B holds none');
}

/* ===== 7. The read-only FSA port ===== */
{
  /* A minimal FSA-shaped directory handle. */
  function fsa({ files = {}, permission = 'granted', throwOnGet = null } = {}) {
    const make = (prefix) => ({
      getDirectoryHandle: async (name) => {
        const next = `${prefix}${name}/`;
        if (throwOnGet) throw throwOnGet;
        if (![...Object.keys(files)].some((p) => p.startsWith(next))) {
          throw Object.assign(new Error('missing'), { name: 'NotFoundError' });
        }
        return make(next);
      },
      getFileHandle: async (name) => {
        if (throwOnGet) throw throwOnGet;
        const full = `${prefix}${name}`;
        if (!(full in files)) {
          throw Object.assign(new Error('missing'), { name: 'NotFoundError' });
        }
        const bytes = files[full];
        return {
          getFile: async () => ({
            size: bytes.byteLength,
            arrayBuffer: async () => bytes.buffer.slice(
              bytes.byteOffset, bytes.byteOffset + bytes.byteLength
            )
          })
        };
      },
      queryPermission: async () => permission
    });
    return make('');
  }

  const OBJECT_KEY = 'd'.repeat(64);
  const document = { schema: 'h2o.studio.syncRevision.v2', revisionId: MINT_A };
  const bytes = encoder.encode(canonicalJson(document));
  const address = await sha256HexBytes(bytes);
  const filePath = P02_FSA_READ_V2.revisionPath(OBJECT_KEY, address).join('/');

  /* Valid bytes. */
  const ok = createChromeFsaReadTransport({
    directoryHandle: fsa({ files: { [filePath]: bytes } }), sha256HexBytes
  });
  const read = await ok.readRevision({ objectKey: OBJECT_KEY, revisionBlobSha256: address });
  equal(read.status, P02_FSA_READ_STATUS.VERIFIED, 'F1 valid bytes verify');
  equal(read.value.revisionId, MINT_A, 'F2 and the document is returned');
  equal(ok.readOnly, true, 'F3 the port states that it is read-only');
  for (const forbidden of ['write', 'writeRevision', 'publish', 'createWritable', 'remove']) {
    equal(ok[forbidden], undefined, `F4 no ${forbidden} surface exists at all`);
  }

  /* Permission absent -> blocked(permission), not an error, not a retry loop. */
  const denied = createChromeFsaReadTransport({
    directoryHandle: fsa({ files: { [filePath]: bytes }, permission: 'prompt' }), sha256HexBytes
  });
  const blocked = await denied.readRevision({ objectKey: OBJECT_KEY, revisionBlobSha256: address });
  equal(blocked.status, P02_FSA_READ_STATUS.BLOCKED_PERMISSION,
    'F5 an ungranted folder is blocked(permission)');
  equal(blocked.blockReason, 'permission',
    'F6 carrying the scheduler block class, so it waits for an operator not a timer');
  equal(typeof denied.permissionState, 'function', 'F7 permission is queryable');
  check(denied.requestPermission === undefined,
    'F8 and never requested - a background pass must not raise a picker');

  /* File missing -> absent, which is a normal state in a folder that syncs. */
  const empty = createChromeFsaReadTransport({
    directoryHandle: fsa({ files: {} }), sha256HexBytes
  });
  equal((await empty.readRevision({ objectKey: OBJECT_KEY, revisionBlobSha256: address })).status,
    P02_FSA_READ_STATUS.ABSENT, 'F9 a revision that is not there yet is absent, not broken');

  /* Bytes present at the wrong address -> integrity, never silently accepted. */
  const wrongAddress = 'e'.repeat(64);
  const wrongPath = P02_FSA_READ_V2.revisionPath(OBJECT_KEY, wrongAddress).join('/');
  const tampered = createChromeFsaReadTransport({
    directoryHandle: fsa({ files: { [wrongPath]: bytes } }), sha256HexBytes
  });
  const integrity = await tampered.readRevision({
    objectKey: OBJECT_KEY, revisionBlobSha256: wrongAddress
  });
  equal(integrity.status, P02_FSA_READ_STATUS.INTEGRITY,
    'F10 bytes that do not hash to their address are an integrity failure');
  equal(integrity.observedSha256Hex, address, 'F11 reporting what was actually there');

  /* Malformed bytes at a correct address. */
  const junk = encoder.encode('not json at all');
  const junkAddress = await sha256HexBytes(junk);
  const junkPath = P02_FSA_READ_V2.revisionPath(OBJECT_KEY, junkAddress).join('/');
  const malformed = createChromeFsaReadTransport({
    directoryHandle: fsa({ files: { [junkPath]: junk } }), sha256HexBytes
  });
  const bad = await malformed.readRevision({
    objectKey: OBJECT_KEY, revisionBlobSha256: junkAddress
  });
  equal(bad.status, P02_FSA_READ_STATUS.MALFORMED, 'F12 unparseable bytes are malformed');
  equal(bad.reason, 'not-canonical-json', 'F13 with a distinct reason from integrity');

  /* Revocation between the query and the read is still permission. */
  const revoked = createChromeFsaReadTransport({
    directoryHandle: fsa({
      files: { [filePath]: bytes },
      throwOnGet: Object.assign(new Error('revoked'), { name: 'NotAllowedError' })
    }),
    sha256HexBytes
  });
  equal((await revoked.readRevision({ objectKey: OBJECT_KEY, revisionBlobSha256: address })).status,
    P02_FSA_READ_STATUS.BLOCKED_PERMISSION,
    'F14 revocation mid-read is permission, not I/O');
}

/* ===== 8. No DATABASE_VERSION bump ===== */
{
  const source = await import('node:fs').then((fs) => fs.readFileSync(
    new URL('../../../packages/browser-adapters/chrome/sync-object-store.mjs', import.meta.url),
    'utf8'
  ));
  const match = source.match(/const DATABASE_VERSION = (\d+);/);
  equal(match?.[1], '4', 'N1 the Chrome DATABASE_VERSION is unchanged at 4');
  check(source.includes("const BRANCH_EVIDENCE_STORE = 'branch-evidence';"),
    'N2 and v2 evidence rides in the EXISTING branch-evidence store');
}

const verdict = failures.length === 0
  ? 'P02_O1_CHROME_V2_ADMISSION_PASS' : 'P02_O1_CHROME_V2_ADMISSION_FAIL';
console.log(JSON.stringify({
  verdict, assertions, failures,
  v1ContractMutated: false,
  databaseVersionBumped: false,
  allowUnresolvedParentHashUsed: false,
  cr1: 'observation cross-check plus index-level squat quarantine; both '
    + 'claimants excluded so arrival order cannot pick a winner',
  fsa: { readOnly: true, permission: 'queried, never requested', writeSurfaces: 0 },
  liveProfileTouched: false, realRepositoryTouched: false,
  canonicalStateTouched: false, processesLaunched: 0
}, null, 2));
process.exit(failures.length === 0 ? 0 : 1);
