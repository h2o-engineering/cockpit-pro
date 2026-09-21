#!/usr/bin/env node
/*
 * P02 Folder Relationship Synchronization — T05 focused counterpart validator.
 *
 * Mission p02-folder-relationship-synchronization, Task T05 (bounded source
 * candidate). Deterministic, disposable, in-process: memory File System Access
 * repository, fake IndexedDB, temporary SQLite fixtures, fake Tauri invoke.
 * No live repository, profile, runtime, extension or canonical database is
 * read or written.
 *
 * Proves, with the real modules:
 *   A  D1 exact folder payload (schema/folderId/name), createdAt refused on
 *      both engines' contract surfaces, authoritative timestamps as head
 *      metadata only, receiver-local timestamps never in payload bytes;
 *   B  D3 Chrome IDB: DATABASE_VERSION 4, no new store, legacy chat records
 *      readable/key-compatible beside the relationship regime, same-objectId
 *      chat + binding isolation, domain-qualified branch/apply state,
 *      lockstep Apply commit with the ledger direction, restart durability;
 *   C  Chrome counterpart: Receive/admission through the real receive core,
 *      dependency ordering (folder before binding, blocked(dependency)),
 *      strict H2O Folder owner writes for create / bind / rename / unbind,
 *      already-applied zero-write replay, no echo / no fabricated revision,
 *      fail-closed divergence, writer-unavailable / owner-refused /
 *      non-strict refusals, no archive import, no localStorage, no native
 *      ChatGPT mutation;
 *   D  Chrome-published root + Desktop descendant: the anchor-proven parent
 *      path (Chrome's own ledger tip) classifies remote-ahead and applies;
 *   E  D2 Desktop relationship publication: ROOT only when proof permits,
 *      DESCENDANT of a proven applied anchor, second-root refusal for a
 *      foreign-rooted object, deterministic folder-before-binding ordering,
 *      one object per attempt, no relationship SQL mutation, domain-qualified
 *      bookkeeping, no new Tauri command;
 *   F  background composition: relationship families dispatch to the
 *      counterpart, chat Apply stays on createChromeV2Apply, manual gates
 *      preserved, no autonomous relationship Apply, host lease hunks are
 *      strict-only;
 *   G  pack / dist inventory parity and staged relative imports.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../..');
const rel = (...parts) => path.join(repo, ...parts);
const read = (...parts) => fs.readFileSync(rel(...parts), 'utf8');
const importRepo = (...parts) => import(pathToFileURL(rel(...parts)).href);
const webcrypto = crypto.webcrypto;
const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const CHAT_DOMAIN = 'studio.chat.saved-state.v1';
const FOLDER_DOMAIN = 'studio.folder.v1';
const BINDING_DOMAIN = 'studio.chat-folder-binding.v1';
const FOLDER_SCHEMA = 'h2o.studio.folderCatalogState.v1';
const BINDING_SCHEMA = 'h2o.studio.chatFolderBinding.v1';
const LOCAL = 'studio-chrome:mv3-chrome:idb-archive:t05-chrome';
const REMOTE = 'studio-desktop:tauri-desktop:sqlite:t05-desktop';
const SOURCE_AT = '2026-09-21T10:15:30.123Z';
const SOURCE_MS = Date.parse(SOURCE_AT);
const NUL = '\u0000';
const HEX64 = /^[0-9a-f]{64}$/;

let assertions = 0;
const failures = [];
const sections = [];
function check(condition, label) {
  assertions += 1;
  if (condition !== true) failures.push(label);
}
async function section(name, fn) {
  const before = failures.length;
  try { await fn(); } catch (error) {
    failures.push(`${name}: threw ${error?.code || error?.message || error}`);
    if (process.env.H2O_VALIDATOR_TRACE) console.error(error);
  }
  sections.push({ name, ok: failures.length === before });
}
const codeOf = async (fn) => { try { await fn(); return 'ok'; } catch (e) { return e?.code || e?.message || 'threw'; } };
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const sha256HexBytes = async (bytes) => crypto.createHash('sha256').update(Buffer.from(bytes)).digest('hex');

/* ---------------------------------------------------------------------- */
/* Real modules                                                            */
/* ---------------------------------------------------------------------- */
const domains = await importRepo('packages/core/sync-relationship-domains-v2.mjs');
const adapter = await importRepo('packages/browser-adapters/chrome/sync-revision-domain-relationship-v2.mjs');
const contract = await importRepo('packages/browser-adapters/chrome/sync-contract-v2.mjs');
const production = await importRepo('packages/browser-adapters/chrome/sync-revision-production-v2.mjs');
const storeModule = await importRepo('packages/browser-adapters/chrome/sync-object-store.mjs');
const protocolStateModule = await importRepo('packages/browser-adapters/chrome/sync-p02-domain-protocol-state-chrome-v2.mjs');
const counterpartModule = await importRepo('packages/browser-adapters/chrome/sync-relationship-counterpart-chrome-v2.mjs');
const enumeratorModule = await importRepo('packages/browser-adapters/chrome/sync-relationship-enumerator-chrome-v2.mjs');
const reconcileModule = await importRepo('packages/browser-adapters/chrome/sync-background-reconcile.mjs');
const receiveCore = await importRepo('packages/core/sync-object-reconcile-v2.mjs');
const classifierModule = await importRepo('packages/core/sync-object-classifier-v2.mjs');
const fsaRead = await importRepo('packages/browser-adapters/chrome/sync-fsa-read-transport-v2.mjs');
const fsaWrite = await importRepo('packages/browser-adapters/chrome/sync-fsa-write-transport-v2.mjs');
const readerTransport = await importRepo('packages/browser-adapters/chrome/sync-reader-transport-v2.mjs');
const writerTransport = await importRepo('packages/browser-adapters/chrome/sync-writer-transport-v2.mjs');
const tipMemoModule = await importRepo('packages/browser-adapters/chrome/sync-p02-tip-memo-chrome-v2.mjs');
const chatAdapter = await importRepo('packages/browser-adapters/chrome/sync-revision-domain-chat-v2.mjs');
const pack = await importRepo('tools/product/studio/pack-studio.mjs');
const distGraph = await importRepo('tools/validation/sync/p02-dist-graph.mjs');
const bridgeModule = await importRepo('tools/product/extensions/chatgpt/chrome/chrome-live-folder-bridge.mjs');
const { createMemoryFsa } = await importRepo('tools/validation/sync/helpers/p02-memory-fsa.mjs');
const { FakeIndexedDBFactory, chromeIdentity, identityProvider } = await importRepo('tools/validation/sync/helpers/item9-fake-indexeddb.mjs');
const vectors = JSON.parse(read('tools/validation/sync/fixtures/p02-relationship-contract-vectors.json'));

const { objectKeyHex, writerKeyHex, canonicalJson } = contract;
const { createChromeSyncObjectStore, ITEM9_1_CONSTANTS } = storeModule;
const { createChromeRelationshipCounterpart, partitionTrustedPeerAdvertisements, sortMergedDescriptors,
  P02_CHROME_RELATIONSHIP_COUNTERPART_V2: CP, P02_CHROME_RELATIONSHIP_COUNTERPART_ERROR: CPE } = counterpartModule;
const REPOSITORY = fsaRead.P02_FSA_REPOSITORY_CHILD;
const folderPayload = (folderId, name) => ({ schema: FOLDER_SCHEMA, folderId, name });
/* The accepted content-only chat payload shape (as the T02 validator builds it). */
function chatPayloadFor(objectId, snapshotId, text) {
  return {
    schema: chatAdapter.P02_CHAT_DOMAIN_V2.PAYLOAD_SCHEMA,
    chatArchive: {
      chats: [{
        chatId: objectId, title: 'T05 fixture',
        chatIndex: { title: 'T05 fixture', lastSnapshotId: snapshotId, snapshotCount: 1, messageCount: 1, state: { isSaved: true, isLinked: true }, organization: {} },
        snapshots: [{ snapshotId, chatId: objectId, createdAt: SOURCE_AT, messageCount: 1,
          messages: [{ order: 0, role: 'user', text }],
          meta: { title: 'T05 fixture', richTurns: [{ turnIdx: 0, role: 'user', outerHTML: `<p>${text}</p>`, meta: {} }] } }]
      }],
      catalogs: { categories: [], labels: [], tags: [] }
    },
    chromeStorageLocal: {}, libraryKv: []
  };
}
const bindingPayload = (chatId, folderId) => ({ schema: BINDING_SCHEMA, chatId, folderId });

/* ---------------------------------------------------------------------- */
/* Disposable world: memory repository, a Desktop-style writer, a Chrome    */
/* store, the strict page-world source, the counterpart                    */
/* ---------------------------------------------------------------------- */
function desktopStorageOver(fsa) {
  const p = (name) => `${REPOSITORY}/${name}`;
  return {
    async read(name) { return fsa.read(p(name)); },
    async writeTemporary(name, bytes) { fsa.put(p(name), bytes); },
    async readTemporary(name) { return fsa.read(p(name)); },
    async promoteTemporary(pending, final, { replaceExisting = false } = {}) {
      const bytes = fsa.read(p(pending));
      if (!bytes) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      if (fsa.has(p(final)) && !replaceExisting) throw Object.assign(new Error('exists'), { code: 'EEXIST' });
      fsa.put(p(final), bytes);
      fsa.events.push(`promote:${p(final)}`);
    }
  };
}

function makeStrictPage() {
  const page = { folders: [], bindings: new Map(), calls: [], writeCalls: [], strictTag: true, refuse: null, throwOn: null, localStorageWrites: 0 };
  const tag = (extra) => (page.strictTag ? { source: 'H2O.folders', strict: true, ...extra } : { ...extra });
  const authority = {
    async listFolders() { page.calls.push('listFolders'); return tag({ folders: page.folders.map((f) => ({ ...f })) }); },
    async resolveBindings(ids) {
      page.calls.push(`resolveBindings:${ids.length}`);
      return tag({ bindings: Object.fromEntries(ids.map((id) => [id, { folderId: page.bindings.get(id) ?? '', folderName: '' }])) });
    },
    async applyFolderOperation({ operationType, folderId, name }) {
      page.writeCalls.push(`${operationType}:${folderId}:${name}`);
      if (page.throwOn === operationType) throw new Error('bridge-failed');
      if (page.refuse === operationType) return tag({ writer: 'H2O.folders.applyMetadataOperation', ok: false, applied: false, noMutation: true, writesPerformed: 0, blockers: ['reserved-folder-name'] });
      if (operationType === 'create-folder') {
        if (page.folders.some((f) => f.id === folderId)) return tag({ writer: 'H2O.folders.applyMetadataOperation', ok: false, applied: false, noMutation: true, writesPerformed: 0, blockers: ['folder-exists'] });
        page.folders.push({ id: folderId, name, kind: 'local', createdAt: SOURCE_MS, updatedAt: SOURCE_MS });
      } else if (operationType === 'rename-folder') {
        const folder = page.folders.find((f) => f.id === folderId);
        if (!folder) return tag({ writer: 'H2O.folders.applyMetadataOperation', ok: false, applied: false, noMutation: true, writesPerformed: 0, blockers: ['folder-not-found'] });
        folder.name = name; folder.updatedAt = SOURCE_MS + 60000;
      } else {
        return tag({ writer: 'H2O.folders.applyMetadataOperation', ok: false, applied: false, noMutation: true, writesPerformed: 0, blockers: ['unsupported-operation-type'] });
      }
      return tag({ writer: 'H2O.folders.applyMetadataOperation', ok: true, applied: true, noMutation: false, writesPerformed: 1, operationType, folderId, blockers: [], warnings: [] });
    },
    async setBinding({ chatId, folderId }) {
      page.writeCalls.push(`setBinding:${chatId}:${folderId}`);
      if (page.throwOn === 'setBinding') throw new Error('bridge-failed');
      if (page.refuse === 'setBinding') return tag({ writer: 'H2O.folders.setBinding', ok: false, status: 'chat-not-saved', reason: 'save-chat-before-folder-assignment', chatId, folderId: page.bindings.get(chatId) ?? '' });
      if (folderId) page.bindings.set(chatId, folderId); else page.bindings.delete(chatId);
      return tag({ writer: 'H2O.folders.setBinding', ok: true, status: 'ok', reason: '', chatId, folderId: page.bindings.get(chatId) ?? '', folderName: '' });
    }
  };
  return { page, authority };
}

function makeDesktopWriter(fsa, syncPeerId = REMOTE) {
  const writer = writerTransport.createLocalWriterTransportPrimitives({
    storage: desktopStorageOver(fsa), ownedWriterSyncPeerId: syncPeerId, cryptoImplementation: webcrypto
  });
  const heads = new Map();
  const produced = [];
  async function publish({ objectDomain, objectId, payload, parent = null, mint, keepSiblings = false }) {
    const revisionId = `p02-${mint.padStart(32, '0').slice(-32)}`;
    const record = objectDomain === CHAT_DOMAIN
      ? await chatAdapter.produceChatRevisionV2({ canonicalObject: { objectId, revisionId, payload }, writerSyncPeerId: syncPeerId,
        p02Parent: parent === null ? null : { previousRevisionId: parent.revisionId, previousRevisionBlobSha256: parent.revisionBlobSha256, provenP02Parent: true }, cryptoImplementation: webcrypto })
      : await adapter.produceRelationshipRevisionV2({ objectDomain, canonicalObject: { objectId, revisionId, payload }, writerSyncPeerId: syncPeerId,
        p02Parent: parent === null ? null : { previousRevisionId: parent.revisionId, previousRevisionBlobSha256: parent.revisionBlobSha256, provenP02Parent: true }, cryptoImplementation: webcrypto });
    const key = `${objectDomain}${NUL}${objectId}`;
    const head = { schema: 'h2o.studio.syncHead.v2', objectDomain, objectId, objectKey: record.objectKey, revisionId, payloadSha256: record.payloadSha256,
      revisionBlobSha256: record.revisionBlobSha256, writerSyncPeerId: syncPeerId, previousRevisionId: record.revision.previousRevisionId,
      previousRevisionBlobSha256: record.revision.previousRevisionBlobSha256, sourceUpdatedAtIso: SOURCE_AT };
    const tips = keepSiblings ? (heads.get(key) || []) : [];
    heads.set(key, [...tips.filter((t) => t.revisionId !== revisionId), head]);
    const result = await writer.publishBatch({
      revisions: [{ objectDomain, objectId, objectKey: record.objectKey, revisionBlobSha256: record.revisionBlobSha256, bytes: record.canonicalBytes }],
      heads: [...heads.values()].flat()
    });
    if (result?.ok !== true) throw Object.assign(new Error('fixture-publish-failed'), { code: result?.errorCode || 'fixture-publish-failed' });
    produced.push(record);
    return record;
  }
  return { writer, heads, produced, publish };
}

function storageArea(rows = {}) {
  return {
    get: (keys, cb) => { const out = {}; for (const key of Array.isArray(keys) ? keys : [keys]) if (rows[key] !== undefined) out[key] = structuredClone(rows[key]); cb?.(out); return Promise.resolve(out); },
    set: (patch, cb) => { Object.assign(rows, structuredClone(patch)); cb?.(); return Promise.resolve(); }
  };
}

async function makeChromeWorld({ fsa = createMemoryFsa(), idb = new FakeIndexedDBFactory(), page = makeStrictPage(), chats = ['chat-a'] } = {}) {
  const store = createChromeSyncObjectStore({ identityProvider: identityProvider(chromeIdentity()), indexedDBFactory: idb, cryptoImplementation: webcrypto });
  await store.ensureReady();
  const archiveRows = new Map(chats.map((id) => [id, { chatId: id, snapshotId: `snap-${id}`, createdAt: SOURCE_AT, updatedAt: SOURCE_AT, isDeleted: false }]));
  const archive = { listWorkbenchRows: async () => [...archiveRows.values()].map((row) => ({ ...row, folderId: page.page.bindings.get(row.chatId) ?? '' })) };
  const fsaR = fsaRead.createChromeFsaReadTransport({ containerHandle: fsa.handle, sha256HexBytes });
  const reader = readerTransport.createLocalReaderTransportPrimitives({ storage: fsaR.repositoryStorage(), cryptoImplementation: webcrypto });
  const readCalls = [];
  const counterpart = createChromeRelationshipCounterpart({
    syncStore: store, relationshipAuthority: page.authority, archiveAuthority: archive,
    readRevisionBytes: (input) => { readCalls.push(input.revisionBlobSha256); return fsaR.readRevision(input); },
    sha256HexBytes, cryptoImplementation: webcrypto
  });
  const peerKey = await writerKeyHex(REMOTE, webcrypto);
  const memo = tipMemoModule.createChromeVerifiedTipMemo({ storageArea: storageArea() });
  async function advertisements() {
    const state = await reader.readWriterState({ writerSyncPeerId: REMOTE });
    return state?.status === 'verified' ? [{ syncPeerId: REMOTE, writerKey: peerKey, heads: state.snapshot.heads }] : [];
  }
  async function descriptors() {
    const partitioned = partitionTrustedPeerAdvertisements(await advertisements());
    return sortMergedDescriptors(await counterpart.enumerateRemoteDescriptors({ trustedPeerAdvertisements: partitioned.relationship }));
  }
  async function descriptorFor(scope) {
    return (await descriptors()).find((d) => d.objectDomain === scope.objectDomain && d.objectId === scope.objectId) ?? null;
  }
  /* The receive core wired exactly as the background composition wires it. */
  function receive() {
    return receiveCore.createP02ReceiveComposition({
      configuredPeers: async () => [{ syncPeerId: REMOTE, writerKey: peerKey }],
      readWriterState: (input) => reader.readWriterState({ writerSyncPeerId: input.syncPeerId }),
      readRevisionBytes: ({ objectKey, revisionBlobSha256 }) => fsaR.readRevision({ objectKey, revisionBlobSha256 }),
      fetchAncestry: (input) => reader.fetchAncestry(input),
      readAdmittedEvidence: (scope) => counterpart.readAdmittedEvidence(scope),
      admitRevision: (input) => counterpart.admissionFor(input.objectDomain).admitV2Revision({ revision: input.revision, revisionBlobBytes: input.revisionBlobBytes, protocolState: input.protocolState }),
      classifyObject: async (input) => counterpart.classifyRelationshipDescriptor((await descriptorFor(input)) ?? await counterpart.describeScope(input)),
      anchorSetFor: (scope) => counterpart.anchorSetFor(scope),
      readTipMemo: (input) => memo.read(input), writeTipMemo: (input) => memo.record(input),
      protocolStateFor: (scope) => counterpart.protocolStateFor(scope),
      applyAuthority: null
    }).receivePass();
  }
  /* One manual Apply: the first eligible descriptor in family order. */
  async function applyOnce() {
    for (const descriptor of await descriptors()) {
      const verdict = await counterpart.classifyRelationshipDescriptor(descriptor);
      if (verdict.classification === 'remote-ahead' && verdict.applyEligibleByEvidence === true && verdict.applyCandidateRevisionId) {
        const result = await counterpart.applySelectedRelationshipRevision({ descriptor, classifierVerdict: verdict, configuredPeer: { syncPeerId: REMOTE, writerKey: peerKey } });
        return { descriptor, verdict, result };
      }
    }
    return null;
  }
  async function classifyAll() {
    const out = [];
    for (const descriptor of await descriptors()) {
      const verdict = await counterpart.classifyRelationshipDescriptor(descriptor);
      out.push(`${descriptor.objectDomain}:${descriptor.objectId}:${verdict.classification}${verdict.dependencyDetail ? `/${verdict.dependencyDetail}` : ''}`);
    }
    return out;
  }
  const relationshipEnumerator = () => enumeratorModule.createChromeRelationshipObjectEnumerator({
    relationshipAuthority: page.authority, archiveAuthority: archive, syncStore: store, configuredSyncPeerIds: [LOCAL], cryptoImplementation: webcrypto
  });
  return { fsa, idb, store, page, archive, archiveRows, fsaR, reader, counterpart, peerKey, readCalls, receive, applyOnce, classifyAll, descriptors, descriptorFor, relationshipEnumerator };
}

/* ====================================================================== */
await section('A D1 exact folder payload; timestamps are head metadata only', async () => {
  const F = domains.P02_RELATIONSHIP_DOMAINS_V2.FOLDER;
  check(F.REQUIRED_KEYS.join(',') === 'schema,folderId,name' && F.OPTIONAL_KEYS.length === 0 && F.PROHIBITED_KEYS.includes('createdAt'),
    'core contract: exact keys schema/folderId/name, no optional keys, createdAt prohibited');
  check(vectors.contract.folderCreatedAt === 'PROHIBITED_FROM_CANONICAL_PAYLOAD' && !vectors.folder.positive.some((v) => 'createdAt' in v.payload) &&
    vectors.folder.negative.filter((v) => v.payload && typeof v.payload === 'object' && 'createdAt' in v.payload).every((v) => v.expected === 'p02-rel-folder-payload-key-rejected' && v.rejectedKey === 'createdAt'),
  'shared vectors: no positive folder vector carries createdAt; every createdAt example is an exact-key rejection');
  for (const value of [SOURCE_AT, null, 1, '2026-09-14T10:15:30Z', {}]) {
    check(await codeOf(() => domains.validateFolderCatalogStatePayload({ ...folderPayload('f_a', 'A'), createdAt: value }, 'f_a')) === 'p02-rel-folder-payload-key-rejected',
      `createdAt=${JSON.stringify(value)} is refused as an unknown key`);
  }
  for (const key of ['updatedAt', 'created_at', 'updated_at']) {
    check(await codeOf(() => domains.validateFolderCatalogStatePayload({ ...folderPayload('f_a', 'A'), [key]: SOURCE_AT }, 'f_a')) === 'p02-rel-folder-payload-key-rejected',
      `receiver-local / source timestamp key ${key} never enters the payload`);
  }
  const view = domains.validateFolderCatalogStatePayload(folderPayload('f_a', 'A'), 'f_a');
  check(Object.keys(view).sort().join(',') === 'folderId,name,objectDomain,objectId', 'validated view carries no timestamp');
  /* Chrome projection: createdAt/updatedAt feed the head only. */
  const projected = await adapter.projectFolderCatalogState({ id: 'f_a', name: 'A', kind: 'local', createdAt: SOURCE_MS, updatedAt: SOURCE_MS + 1000 }, { cryptoImplementation: webcrypto });
  check(projected.eligible === true && JSON.stringify(projected.payload) === JSON.stringify({ folderId: 'f_a', name: 'A', schema: FOLDER_SCHEMA }) && projected.sourceUpdatedAtIso === new Date(SOURCE_MS + 1000).toISOString(),
    'Chrome projection: payload exact; updatedAt -> sourceUpdatedAtIso');
  const fallback = await adapter.projectFolderCatalogState({ id: 'f_a', name: 'A', kind: 'local', createdAt: SOURCE_MS }, { cryptoImplementation: webcrypto });
  check(fallback.eligible === true && !('createdAt' in fallback.payload) && fallback.sourceUpdatedAtIso === SOURCE_AT && fallback.payloadSha256Hex === projected.payloadSha256Hex,
    'Chrome projection: createdAt is only the sourceUpdatedAtIso fallback; identical state keeps its digest');
  /* Rust contract mirrors the amendment (static). */
  const rust = read('apps/studio/desktop/src-tauri/src/sync_contract_v2.rs');
  check(rust.includes('&["schema", "folderId", "name"],\n        &[],') && !rust.includes('REL_ERR_FOLDER_CREATED_AT_INVALID') && !/created_at: Option<String>/.test(rust),
    'Rust contract: folder optional-key set is empty; no createdAt acceptance or struct field remains');
  check(rust.includes('assert_eq!(refused.key.as_deref(), Some("createdAt"))'), 'Rust contract test asserts the createdAt exact-key refusal');
  /* Both engines share the SAME positive/negative vector file. */
  check(rust.includes('p02-relationship-contract-vectors.json'), 'Rust tests run the shared vector file');
  check(adapter.P02_RELATIONSHIP_DOMAIN_V2.DIRECTION_COVERAGE === 'RELATIONSHIP_SYNC_DIRECTION_COVERAGE=BIDIRECTIONAL', 'direction coverage is bidirectional since T05');
});

/* ====================================================================== */
await section('B D3 Chrome IDB: version 4, legacy compatibility, cross-domain isolation, lockstep commit, durability', async () => {
  check(ITEM9_1_CONSTANTS.DATABASE_VERSION === 4 && storeModule.MIGRATIONS.length === 4, 'DATABASE_VERSION remains 4');
  const source = read('packages/browser-adapters/chrome/sync-object-store.mjs');
  check((source.match(/createObjectStore\(/g) || []).length === 6 && !source.includes('deleteObjectStore') && !/indexedDB\.open\([^)]*5/.test(source),
    'no new object store, no deletion, no version bump');
  const idb = new FakeIndexedDBFactory();
  const clock = () => '2026-09-21T00:00:00.000Z';
  const store = createChromeSyncObjectStore({ identityProvider: identityProvider(chromeIdentity()), indexedDBFactory: idb, cryptoImplementation: webcrypto, clock });
  check((await store.ensureReady()).databaseSchemaVersion === 4, 'store opens at version 4');
  const OBJECT = 'chat-shared';
  const chatBytes = new TextEncoder().encode('{"chat":"r1"}');
  const chatHash = sha256(chatBytes);
  /* Legacy chat regime, written through the ACCEPTED API. */
  const legacy = await store.recordBranchEvidence({ objectId: OBJECT, revisionId: 'p02-chat-r1', revisionBlobSha256Hex: chatHash, revisionBlobBytes: chatBytes, parentRevisionId: null, parentRevisionBlobSha256Hex: null, disposition: 'accepted-linear' });
  const chatKey = await objectKeyHex(CHAT_DOMAIN, OBJECT, webcrypto);
  const chatReference = { referenceKind: 'branch-evidence-v2', objectDomain: CHAT_DOMAIN, objectKey: chatKey, writerSyncPeerId: REMOTE, writerKey: 'a'.repeat(64), selectedLeafRevisionId: 'p02-chat-r1', selectedLeafRevisionBlobSha256Hex: chatHash, revisionId: 'p02-chat-r1', parentRevisionId: null, parentRevisionBlobSha256Hex: null, branchEvidenceKey: legacy.record.key, revisionBlobSha256Hex: chatHash, payloadSha256Hex: 'c'.repeat(64), sourceRevisionId: 'snap-1', canonicalAnchorRevisionId: null, canonicalAnchorRevisionBlobSha256Hex: null, canonicalPreStateRevisionId: null, canonicalPreStatePayloadSha256Hex: null };
  await store.stageApplyIntent({ objectId: OBJECT, canonicalAnchorRevisionId: null, ...chatReference });
  await store.commitApplyIntent(OBJECT, 'p02-chat-r1', { objectKey: chatKey, applyReference: chatReference });
  const chatBefore = JSON.stringify(await store.readApplySnapshot(OBJECT));
  const legacyKeys = legacy.record.key;
  check(legacyKeys.startsWith('v1:'), 'legacy chat record keeps the v1 key regime');

  /* Relationship regime: a binding with the SAME objectId and a folder. */
  const bindBytes = new TextEncoder().encode('{"binding":"r1"}');
  const bindHash = sha256(bindBytes);
  const bindKey = await objectKeyHex(BINDING_DOMAIN, OBJECT, webcrypto);
  const retained = await store.recordRelationshipBranchEvidence({ objectDomain: BINDING_DOMAIN, objectId: OBJECT, revisionId: 'p02-bind-r1', revisionBlobSha256Hex: bindHash, revisionBlobBytes: bindBytes, parentRevisionId: null, parentRevisionBlobSha256Hex: null, disposition: 'accepted-linear' });
  check(retained.verdict === 'branch-evidence-retained' && retained.record.key.startsWith('p02:') && retained.record.objectKey === bindKey && retained.record.objectDomain === BINDING_DOMAIN,
    'relationship record: p02 key regime, objectKey = SHA-256(domain||0x00||id), domain carried');
  check((await store.recordRelationshipBranchEvidence({ objectDomain: BINDING_DOMAIN, objectId: OBJECT, revisionId: 'p02-bind-r1', revisionBlobSha256Hex: bindHash, revisionBlobBytes: bindBytes, parentRevisionId: null, parentRevisionBlobSha256Hex: null, disposition: 'accepted-linear' })).verdict === 'identical-replay',
    'identical relationship evidence replays (counter only)');
  const other = new TextEncoder().encode('{"binding":"other"}');
  check(await codeOf(() => store.recordRelationshipBranchEvidence({ objectDomain: BINDING_DOMAIN, objectId: OBJECT, revisionId: 'p02-bind-r1', revisionBlobSha256Hex: sha256(other), revisionBlobBytes: other, parentRevisionId: null, parentRevisionBlobSha256Hex: null, disposition: 'accepted-linear' })) === ITEM9_1_CONSTANTS.ERROR_CODE.RELATIONSHIP_STATE_CONFLICT,
    'same relationship identity with divergent bytes fails closed');
  check(await codeOf(() => store.recordRelationshipBranchEvidence({ objectDomain: CHAT_DOMAIN, objectId: OBJECT, revisionId: 'p02-x', revisionBlobSha256Hex: bindHash, revisionBlobBytes: bindBytes, disposition: 'accepted-linear' })) === ITEM9_1_CONSTANTS.ERROR_CODE.RELATIONSHIP_DOMAIN_INVALID,
    'the chat domain is refused by the relationship ports (chat keeps its legacy path)');
  /* Isolation: same objectId, three regimes, none see each other. */
  check((await store.listBranchEvidence(OBJECT)).length === 1 && (await store.listBranchEvidence(OBJECT))[0].revisionId === 'p02-chat-r1', 'legacy listBranchEvidence sees only the chat record');
  check((await store.listRelationshipBranchEvidence({ objectDomain: BINDING_DOMAIN, objectId: OBJECT })).length === 1, 'binding regime sees its own record');
  check((await store.listRelationshipBranchEvidence({ objectDomain: FOLDER_DOMAIN, objectId: OBJECT })).length === 0, 'folder regime with the same objectId sees nothing');
  check(JSON.stringify(await store.readApplySnapshot(OBJECT)) === chatBefore, 'the chat apply snapshot is byte-identical after relationship writes');
  const relState = await store.readRelationshipApplyState({ objectDomain: BINDING_DOMAIN, objectId: OBJECT });
  check(relState.applyState === null && relState.branchEvidence.length === 1 && relState.objectKey === bindKey && relState.peerObjectKey.startsWith('p02:'),
    'binding apply state is its own (empty) and never the chat anchor');
  check(!(await store.listReadOnlyObjectIds()).includes('f_never'), 'relationship-only records never enumerate as chat objects');
  /* Domain-qualified stage/commit, lockstep with the ledger direction. */
  const reference = { referenceKind: 'branch-evidence-v2', objectDomain: BINDING_DOMAIN, objectKey: bindKey, writerSyncPeerId: REMOTE, writerKey: 'a'.repeat(64), selectedLeafRevisionId: 'p02-bind-r1', selectedLeafRevisionBlobSha256Hex: bindHash, revisionId: 'p02-bind-r1', parentRevisionId: null, parentRevisionBlobSha256Hex: null, branchEvidenceKey: retained.record.key, revisionBlobSha256Hex: bindHash, payloadSha256Hex: 'd'.repeat(64), sourceRevisionId: `relstate-${'d'.repeat(64)}`, canonicalAnchorRevisionId: null, canonicalAnchorRevisionBlobSha256Hex: null, canonicalPreStateRevisionId: null, canonicalPreStatePayloadSha256Hex: null };
  check(await codeOf(() => store.stageRelationshipApplyIntent({ objectDomain: FOLDER_DOMAIN, objectId: OBJECT, canonicalAnchorRevisionId: null, ...reference, objectDomain: FOLDER_DOMAIN })) === ITEM9_1_CONSTANTS.ERROR_CODE.RELATIONSHIP_STATE_INVALID,
    'a reference minted for the binding domain cannot be staged under the folder domain (objectKey pinned)');
  const staged = await store.stageRelationshipApplyIntent({ objectDomain: BINDING_DOMAIN, objectId: OBJECT, canonicalAnchorRevisionId: null, ...reference });
  check(staged.verdict === 'intent-staged' && staged.applyState.pending.revisionId === 'p02-bind-r1', 'relationship intent staged');
  check((await store.readLocalPublicationConvergence(bindKey)).convergedDirection === null, 'no direction before commit');
  const committed = await store.commitRelationshipApplyIntent({ objectDomain: BINDING_DOMAIN, objectId: OBJECT, revisionId: 'p02-bind-r1', applyReference: reference });
  const convergence = await store.readLocalPublicationConvergence(bindKey);
  check(committed.verdict === 'committed' && committed.applyState.pending === null && committed.applyState.lastApplied.revisionId === 'p02-bind-r1' && convergence.convergedDirection === 'applied',
    'commit anchors the binding and writes the ledger direction for the BINDING objectKey in the same transaction');
  check((await store.readLocalPublicationConvergence(chatKey)).convergedDirection === 'applied' && JSON.stringify(await store.readApplySnapshot(OBJECT)) === chatBefore,
    'the chat ledger row and chat apply snapshot are untouched by the binding commit');
  check((await store.commitRelationshipApplyIntent({ objectDomain: BINDING_DOMAIN, objectId: OBJECT, revisionId: 'p02-bind-r1', applyReference: reference })).verdict === 'committed-replay', 'replayed commit is a no-op');
  /* Domain-qualified protocol state reads the relationship anchor, not the chat's. */
  const state = await protocolStateModule.readChromeDomainProtocolState({ objectDomain: BINDING_DOMAIN, objectId: OBJECT, syncStore: store, cryptoImplementation: webcrypto });
  check(state.protocolState.lastApplied?.revisionId === 'p02-bind-r1' && state.identity.direction === 'applied' && state.identity.appliedPayloadSha256 === 'd'.repeat(64) && state.applyStateSource === 'relationship-domain-qualified-apply-store',
    'domain protocol state: binding applied anchor with payload identity');
  const chatState = await protocolStateModule.readChromeDomainProtocolState({ objectDomain: CHAT_DOMAIN, objectId: OBJECT, syncStore: store, cryptoImplementation: webcrypto });
  check(chatState.protocolState.lastApplied?.revisionId === 'p02-chat-r1' && chatState.applyStateSource === 'chat-object-id-apply-store', 'chat protocol state still read from the accepted objectId-keyed store');
  /* Restart durability: a fresh store instance over the same database. */
  store.close();
  const reopened = createChromeSyncObjectStore({ identityProvider: identityProvider(chromeIdentity()), indexedDBFactory: idb, cryptoImplementation: webcrypto, clock });
  check((await reopened.ensureReady()).databaseSchemaVersion === 4, 'reopen stays at version 4 (no upgrade)');
  const durable = await reopened.readRelationshipApplyState({ objectDomain: BINDING_DOMAIN, objectId: OBJECT });
  check(durable.applyState?.lastApplied?.revisionId === 'p02-bind-r1' && durable.branchEvidence.length === 1 && (await reopened.listBranchEvidence(OBJECT)).length === 1 && JSON.stringify(await reopened.readApplySnapshot(OBJECT)) === chatBefore,
    'relationship state and legacy chat state both survive a restart, still isolated');
  check((await reopened.listReadOnlyObjectIds()).includes(OBJECT), 'the legacy enumeration still lists the chat object');
  reopened.close();
});

/* ====================================================================== */
await section('C Chrome counterpart: Receive, dependencies, strict owner writes, replay, no echo, refusals', async () => {
  const fsa = createMemoryFsa();
  const desktop = makeDesktopWriter(fsa);
  const t = await makeChromeWorld({ fsa, chats: ['chat-a'] });
  /* Desktop roots: binding FIRST in the repository so dependency ordering is exercised. */
  const B1 = await desktop.publish({ objectDomain: BINDING_DOMAIN, objectId: 'chat-a', payload: bindingPayload('chat-a', 'f_study'), mint: 'b1' });
  const F1 = await desktop.publish({ objectDomain: FOLDER_DOMAIN, objectId: 'f_study', payload: folderPayload('f_study', 'Study'), mint: 'a1' });
  const report = await t.receive();
  const objects = (report.objects ?? []).map((o) => `${o.objectDomain}:${o.objectId}:${o.result.outcome}:${o.result.reason}`);
  check(objects.includes(`${FOLDER_DOMAIN}:f_study:progress:accepted-linear`) && objects.includes(`${BINDING_DOMAIN}:chat-a:progress:accepted-linear`), `receive admits both relationship roots through the real receive core (${objects.join('|')})`);
  check(!report.objects.some((o) => o.result.applyEligible === true) && t.page.page.writeCalls.length === 0 && t.page.page.folders.length === 0, 'receive never applies (no apply authority at the receive stage, zero owner writes)');
  check((await t.store.listRelationshipBranchEvidence({ objectDomain: FOLDER_DOMAIN, objectId: 'f_study' })).length === 1 && (await t.store.listBranchEvidence('chat-a')).length === 0,
    'evidence lands in the domain-qualified regime, never in the chat regime');
  const classified = await t.classifyAll();
  check(classified[0] === `${FOLDER_DOMAIN}:f_study:remote-ahead` && classified[1] === `${BINDING_DOMAIN}:chat-a:blocked(dependency)/folder-missing`,
    `deterministic ordering: folder first; binding blocked(dependency)/folder-missing while its folder is absent (${classified.join('|')})`);
  /* Apply 1: create-with-verbatim-id through the owner. */
  const first = await t.applyOnce();
  check(first?.result.verdict === 'applied' && first.result.kind === 'create-folder' && first.result.materialization === 'created' && first.result.relationshipWrites === 1 && first.result.writerAuthority === 'H2O.folders',
    'folder root materializes through create-folder on the strict owner API');
  check(t.page.page.folders.length === 1 && t.page.page.folders[0].id === 'f_study' && t.page.page.folders[0].name === 'Study' && t.page.page.writeCalls.join('|') === 'create-folder:f_study:Study',
    'the page folder adopts the verbatim id and canonical name; exactly one owner write');
  const folderState = await t.store.readRelationshipApplyState({ objectDomain: FOLDER_DOMAIN, objectId: 'f_study' });
  check(folderState.applyState.lastApplied.revisionId === F1.revisionId && folderState.applyState.lastApplied.payloadSha256Hex === F1.payloadSha256 && (await t.store.readLocalPublicationConvergence(F1.objectKey)).convergedDirection === 'applied',
    'the folder anchor is recorded domain-qualified with the applied payload identity and the ledger direction');
  /* Apply 2: the binding became runnable once its folder exists. */
  check((await t.classifyAll())[1] === `${BINDING_DOMAIN}:chat-a:remote-ahead`, 'binding runnable on the next classification, same runtime');
  const second = await t.applyOnce();
  check(second?.result.verdict === 'applied' && second.result.kind === 'bind-chat' && second.result.materialization === 'bound' && t.page.page.bindings.get('chat-a') === 'f_study',
    'binding root materializes through setBinding (bind)');
  /* Replay: everything converged, zero writes. */
  const writesBefore = t.page.page.writeCalls.length;
  check((await t.applyOnce()) === null && (await t.classifyAll()).every((c) => c.endsWith(':converged')) && t.page.page.writeCalls.length === writesBefore,
    'already-applied: nothing runnable, zero owner writes');
  const replayReport = await t.receive();
  check(replayReport.objects.every((o) => o.result.outcome === 'no-effect'), 'a replayed advertisement admits nothing');
  /* No echo: the publication-side enumerator sees converged page state. */
  const enumerated = await t.relationshipEnumerator().enumerate();
  check(enumerated.descriptors.every((d) => d.dirty === false && d.publishable === false && classifierModule.classifyObjectState(d).classification === 'converged'),
    `no echo: every applied relationship object enumerates converged / not publishable (${enumerated.descriptors.map((d) => `${d.objectId}:${d.dirty}`).join(',')})`);
  /* Descendants: rename, then move, then Unfile. */
  const F2 = await desktop.publish({ objectDomain: FOLDER_DOMAIN, objectId: 'f_study', payload: folderPayload('f_study', 'Study Notes'), parent: F1, mint: 'a2' });
  await t.receive();
  const rename = await t.applyOnce();
  check(rename?.verdict.reason === 'proven-descendant' && rename.result.verdict === 'applied' && rename.result.kind === 'rename-folder' && t.page.page.folders[0].name === 'Study Notes' && t.page.page.folders.length === 1,
    'folder descendant renames in place (same id, no second folder)');
  check((await t.store.readRelationshipApplyState({ objectDomain: FOLDER_DOMAIN, objectId: 'f_study' })).applyState.lastApplied.revisionId === F2.revisionId, 'anchor advanced to the descendant');
  const G1 = await desktop.publish({ objectDomain: FOLDER_DOMAIN, objectId: 'f_code', payload: folderPayload('f_code', 'Code'), mint: 'c1' });
  const B2 = await desktop.publish({ objectDomain: BINDING_DOMAIN, objectId: 'chat-a', payload: bindingPayload('chat-a', 'f_code'), parent: B1, mint: 'b2' });
  await t.receive();
  const order = await t.classifyAll();
  check(order.join('|') === `${FOLDER_DOMAIN}:f_code:remote-ahead|${FOLDER_DOMAIN}:f_study:converged|${BINDING_DOMAIN}:chat-a:blocked(dependency)/folder-missing`,
    `move to a missing folder is blocked(dependency) until the folder lands; folder first (${order.join('|')})`);
  check((await t.applyOnce())?.result.kind === 'create-folder' && (await t.applyOnce())?.result.kind === 'bind-chat' && t.page.page.bindings.get('chat-a') === 'f_code',
    'the move materializes as the target folder create, then bind (one object per attempt)');
  const B3 = await desktop.publish({ objectDomain: BINDING_DOMAIN, objectId: 'chat-a', payload: bindingPayload('chat-a', null), parent: B2, mint: 'b3' });
  await t.receive();
  const unfile = await t.applyOnce();
  check(unfile?.result.kind === 'unbind-chat' && unfile.result.materialization === 'unfiled' && !t.page.page.bindings.has('chat-a') && t.page.page.folders.length === 2,
    'Unfile (folderId null) materializes through setBinding("") - both folders remain, no delete');
  check(t.page.page.writeCalls.every((c) => /^(create-folder|rename-folder|setBinding):/.test(c)) && t.page.page.localStorageWrites === 0,
    'only owner create / rename / setBinding were ever invoked');
  /* Fail-closed refusals. */
  const H1 = await desktop.publish({ objectDomain: FOLDER_DOMAIN, objectId: 'f_refused', payload: folderPayload('f_refused', 'Refused'), mint: 'r1' });
  await t.receive();
  t.page.page.refuse = 'create-folder';
  const refused = await t.applyOnce();
  check(refused?.result.verdict === 'integrity' && refused.result.reason === CPE.WRITER_REFUSED && refused.result.detail === 'reserved-folder-name' && t.page.page.folders.length === 2,
    'owner refusal is a typed fail-closed outcome naming the blocker; nothing materialized');
  check((await t.store.readRelationshipApplyState({ objectDomain: FOLDER_DOMAIN, objectId: 'f_refused' })).applyState.pending?.canonicalPreStatePayloadSha256Hex === null, 'the durable intent records the (absent) pre-state');
  t.page.page.refuse = null;
  t.page.page.strictTag = false;
  const notStrict = await t.applyOnce();
  check(notStrict === null || [CPE.SOURCE_NOT_STRICT, CPE.WRITER_NOT_STRICT].includes(notStrict.result.reason), 'an untagged (non-strict) owner result is refused');
  t.page.page.strictTag = true;
  t.page.page.throwOn = 'create-folder';
  const threw = await t.applyOnce();
  check(threw?.result.verdict === 'integrity' && threw.result.reason === CPE.WRITER_REFUSED && threw.result.pending === true, `a throwing owner write is typed and leaves the intent pending (${threw?.result.verdict}/${threw?.result.reason})`);
  t.page.page.throwOn = null;
  /* Pending intent recovery by read-back: the page still holds the recorded
   * pre-state (nothing was written), so the SAME intent proceeds to one
   * import; it is never blindly re-imported over an unknown state. */
  const recovered = await t.applyOnce();
  check(recovered?.result.verdict === 'applied' && recovered.result.kind === 'create-folder', `a retained pending intent whose pre-state is intact proceeds under the same intent (${recovered?.result.verdict}/${recovered?.result.reason})`);
  check(t.page.page.folders.some((f) => f.id === 'f_refused' && f.name === 'Refused') && (await t.store.readRelationshipApplyState({ objectDomain: FOLDER_DOMAIN, objectId: 'f_refused' })).applyState.lastApplied?.revisionId === H1.revisionId,
    'the refused folder materialized once the owner accepted; anchor committed');
  /* Writer unavailable: no strict write capability composed. */
  const readOnly = await makeChromeWorld({ fsa, chats: ['chat-a'] });
  delete readOnly.page.authority.applyFolderOperation; delete readOnly.page.authority.setBinding;
  const readOnlyCounterpart = createChromeRelationshipCounterpart({ syncStore: readOnly.store, relationshipAuthority: readOnly.page.authority, archiveAuthority: readOnly.archive, readRevisionBytes: (i) => readOnly.fsaR.readRevision(i), sha256HexBytes, cryptoImplementation: webcrypto });
  check(readOnlyCounterpart.diagnose().writerCapabilities.applyFolderOperation === false && readOnlyCounterpart.diagnose().writerCapabilities.setBinding === false, 'a read-only relationship authority composes with no writer capability');
  await readOnly.receive();
  const noWriter = await readOnly.descriptors();
  const folderDescriptor = noWriter.find((d) => d.objectDomain === FOLDER_DOMAIN && d.objectId === 'f_code');
  const verdict = await readOnlyCounterpart.classifyRelationshipDescriptor(folderDescriptor);
  const blocked = await readOnlyCounterpart.applySelectedRelationshipRevision({ descriptor: folderDescriptor, classifierVerdict: verdict, configuredPeer: { syncPeerId: REMOTE, writerKey: readOnly.peerKey } });
  check(blocked.verdict === 'blocked' && blocked.reason === CPE.WRITER_UNAVAILABLE && blocked.blockReason === 'permission' && readOnly.page.page.folders.length === 0,
    'without the strict writer the Apply is blocked(permission) writer-unavailable; no fallback writer exists');
  /* Missing chat: blocked(dependency)/chat-missing. */
  await desktop.publish({ objectDomain: BINDING_DOMAIN, objectId: 'chat-c', payload: bindingPayload('chat-c', 'f_code'), mint: 'bc1' });
  const missingChat = await makeChromeWorld({ fsa, chats: [] });
  await missingChat.receive();
  check((await missingChat.classifyAll()).includes(`${BINDING_DOMAIN}:chat-c:blocked(dependency)/chat-missing`), `a binding whose chat is not in the archive is blocked(dependency)/chat-missing (${(await missingChat.classifyAll()).join('|')})`);
  await t.receive();
  check((await t.classifyAll()).includes(`${BINDING_DOMAIN}:chat-c:blocked(dependency)/chat-missing`), 'the same binding is chat-missing on the main world too (chat-c is not an archive row)');
  /* Divergence: page state moved away from the applied anchor -> fail closed. */
  const F3 = await desktop.publish({ objectDomain: FOLDER_DOMAIN, objectId: 'f_study', payload: folderPayload('f_study', 'Study Archive'), parent: F2, mint: 'a3' });
  t.page.page.folders.find((f) => f.id === 'f_study').name = 'Locally Renamed';
  await t.receive();
  const diverged = await t.applyOnce();
  check(diverged?.result.verdict === 'blocked' && diverged.result.reason === 'p02-apply-anchor-precondition-failed' && diverged.result.divergence === 'page-state-diverged-from-anchor' && t.page.page.folders.find((f) => f.id === 'f_study').name === 'Locally Renamed',
    `local page state diverged from the anchored payload: Apply is blocked, never last-writer-wins (${diverged?.descriptor?.objectId}/${diverged?.result.verdict}/${diverged?.result.reason}/${diverged?.result.divergence})`);
  t.page.page.folders.find((f) => f.id === 'f_study').name = 'Study Notes';
  const converges = await t.applyOnce();
  check(converges?.result.verdict === 'applied' && converges.result.kind === 'rename-folder' && t.page.page.folders.find((f) => f.id === 'f_study').name === 'Study Archive', 'restored page state applies the pending hop');
  /* Static fences on the counterpart. */
  const cp = stripComments(read('packages/browser-adapters/chrome/sync-relationship-counterpart-chrome-v2.mjs'));
  for (const token of ['importFullBundle', 'localStorage', 'chrome.storage', 'moveChatToProject', 'H2O.projects', 'setTimeout', 'setInterval', 'chrome.alarms', 'delete-folder', 'deleteFolder', 'setFolderIconColor', 'stageApplyIntent(', 'commitApplyIntent(', 'recordBranchEvidence(', 'readApplySnapshot(']) {
    check(!cp.includes(token), `counterpart source contains no ${token}`);
  }
  check(cp.includes("createChromeV2BranchAdmission({") && cp.includes('selectApplyHop(') && cp.includes('classifyObjectState('), 'counterpart reuses the existing v2 admission core, hop selection and classifier');
});

/* ====================================================================== */
await section('D anchor-proven parent: Chrome-published root, Desktop descendant', async () => {
  const fsa = createMemoryFsa();
  const t = await makeChromeWorld({ fsa, chats: ['chat-a'] });
  /* Chrome publishes the folder root R1 through the REAL FSA write transport
   * and records it in the REAL ledger exactly as the publication owner does. */
  const fsaW = fsaWrite.createChromeFsaWriteTransport({ containerHandle: fsa.handle, cryptoImplementation: webcrypto });
  const chromeWriter = writerTransport.createLocalWriterTransportPrimitives({ storage: fsaW.storage, ownedWriterSyncPeerId: LOCAL, cryptoImplementation: webcrypto });
  const R1 = await adapter.produceRelationshipRevisionV2({ objectDomain: FOLDER_DOMAIN, canonicalObject: { objectId: 'f_study', revisionId: `p02-${'11'.repeat(16)}`, payload: folderPayload('f_study', 'Study') }, writerSyncPeerId: LOCAL, p02Parent: null, cryptoImplementation: webcrypto });
  const chromeHead = { schema: 'h2o.studio.syncHead.v2', objectDomain: FOLDER_DOMAIN, objectId: 'f_study', objectKey: R1.objectKey, revisionId: R1.revisionId, payloadSha256: R1.payloadSha256, revisionBlobSha256: R1.revisionBlobSha256, writerSyncPeerId: LOCAL, previousRevisionId: null, previousRevisionBlobSha256: null, sourceUpdatedAtIso: SOURCE_AT };
  const headsSnapshot = await writerTransport.buildWriterHeadsSnapshot({ writerSyncPeerId: LOCAL, heads: [chromeHead], cryptoImplementation: webcrypto });
  await t.store.stageLocalPublicationIntent({ objectId: 'f_study', objectKey: R1.objectKey, revisionId: R1.revisionId, previousRevisionId: null, revisionBlobSha256Hex: R1.revisionBlobSha256, payloadSha256Hex: R1.payloadSha256, headSha256Hex: headsSnapshot.headsSnapshotSha256, revisionBlobBytes: R1.canonicalBytes, headBytes: headsSnapshot.bytes, p02Plan: { writerSyncPeerId: LOCAL, expectedCurrentHeadsSnapshotSha256: null, anchorRevisionId: null, anchorRevisionBlobSha256: null, anchorPayloadSha256: null } });
  const batch = await chromeWriter.publishBatch({ revisions: [{ objectDomain: FOLDER_DOMAIN, objectId: 'f_study', objectKey: R1.objectKey, revisionBlobSha256: R1.revisionBlobSha256, bytes: R1.canonicalBytes }], heads: [chromeHead], expectedCurrentHeadsSnapshotSha256: null });
  check(batch?.ok === true, 'Chrome root R1 published to the memory repository');
  await t.store.commitLocalPublicationIntent(R1.objectKey, R1.revisionId);
  t.page.page.folders.push({ id: 'f_study', name: 'Study', kind: 'local', createdAt: SOURCE_MS, updatedAt: SOURCE_MS });
  const published = await protocolStateModule.readChromeDomainProtocolState({ objectDomain: FOLDER_DOMAIN, objectId: 'f_study', syncStore: t.store, cryptoImplementation: webcrypto });
  check(published.identity.direction === 'published' && published.protocolState.lastPublished?.revisionId === R1.revisionId && published.protocolState.lastApplied === null, 'Chrome holds R1 as its PUBLISHED anchor only (no retained evidence)');
  /* Desktop (which applied R1) renames and publishes R2 as a descendant of R1. */
  const desktop = makeDesktopWriter(fsa);
  const R2 = await desktop.publish({ objectDomain: FOLDER_DOMAIN, objectId: 'f_study', payload: folderPayload('f_study', 'Study Notes'), parent: { revisionId: R1.revisionId, revisionBlobSha256: R1.revisionBlobSha256 }, mint: 'd2' });
  const report = await t.receive();
  const entry = report.objects.find((o) => o.objectId === 'f_study');
  check(entry?.result.outcome === 'progress' && entry.result.reason === 'accepted-linear', `R2 is admitted accepted-linear through the anchor hop (${entry?.result.outcome}/${entry?.result.reason})`);
  const descriptor = await t.descriptorFor({ objectDomain: FOLDER_DOMAIN, objectId: 'f_study' });
  check(descriptor.canonicalLocalHead?.revisionId === R1.revisionId && descriptor.p02AnchorSet.pairs.length === 1 && descriptor.retainedEvidence.some((r) => r.anchorProjected === true && r.document.revisionId === R1.revisionId),
    'the descriptor projects the proven published anchor as a validated root beside the retained descendant');
  const verdict = await t.counterpart.classifyRelationshipDescriptor(descriptor);
  check(verdict.classification === 'remote-ahead' && verdict.reason === 'proven-descendant' && verdict.applyCandidateRevisionId === R2.revisionId, `Desktop's descendant of Chrome's own root classifies remote-ahead/proven-descendant (${verdict.classification}/${verdict.reason})`);
  const applied = await t.applyOnce();
  check(applied?.result.verdict === 'applied' && applied.result.kind === 'rename-folder' && t.page.page.folders[0].name === 'Study Notes', 'the descendant applies as a rename on the page');
  const after = await protocolStateModule.readChromeDomainProtocolState({ objectDomain: FOLDER_DOMAIN, objectId: 'f_study', syncStore: t.store, cryptoImplementation: webcrypto });
  check(after.identity.direction === 'applied' && after.protocolState.lastApplied?.revisionId === R2.revisionId && after.protocolState.lastPublished?.revisionId === R1.revisionId, 'direction flips to applied at R2 while the published anchor R1 is kept');
  const enumerated = await t.relationshipEnumerator().enumerate();
  const folder = enumerated.descriptors.find((d) => d.objectId === 'f_study');
  check(folder && folder.dirty === false && classifierModule.classifyObjectState(folder).classification === 'converged', 'round trip converges: Chrome does not re-publish what it applied (no echo, no fabricated revision)');
  const revisionFiles = fsa.listFiles().filter((n) => n.includes(`/objects/${R1.objectKey}/revisions/`) && n.endsWith('.json'));
  check(revisionFiles.length === 2, `exactly two revisions exist for the object: Chrome R1 and Desktop R2 (${revisionFiles.join(',')})`);
});

/* ====================================================================== */
/* D2 Desktop publication: fixture SQLite + fake invoke over the memory FSA */
/* ====================================================================== */
function extractStudioMigrations(source) {
  const start = source.indexOf('fn studio_migrations()');
  const body = source.slice(start);
  const migrations = [];
  const blockRe = /version:\s*(\d+),\s*description:\s*"([^"]*)",\s*sql:\s*(r#"([\s\S]*?)"#|"((?:[^"\\]|\\[\s\S])*)"),\s*kind:\s*MigrationKind::Up/g;
  let match;
  while ((match = blockRe.exec(body))) {
    const sql = match[4] !== undefined ? match[4] : match[5].replace(/\\\n\s*/g, '').replace(/\\"/g, '"');
    migrations.push({ version: Number(match[1]), description: match[2], sql });
  }
  return migrations.sort((a, b) => a.version - b.version);
}
const migrations = extractStudioMigrations(read('apps/studio/desktop/src-tauri/src/lib.rs'));
const scratch = fs.mkdtempSync(path.join(fs.realpathSync(process.env.TMPDIR || os.tmpdir()), 'p02-t05-'));
const STORAGE_SCHEMA = 'h2o.studio.syncWriterStorageLocal.p02.v1';
const packedGraph = distGraph.stagePackedGraph();

async function makeDesktopWorld({ fsa, peers = [], generationState = 'p02', standdown = true } = {}) {
  const db = new DatabaseSync(path.join(scratch, `desktop-${crypto.randomUUID()}.db`));
  let identity = '';
  db.function('h2o_writer_identity', () => identity);
  for (const migration of migrations) db.exec(migration.sql);
  const NOW_MS = SOURCE_MS;
  const libraryInfo = { schema: 'h2o.studio.syncLibraryInfo.p02.v1', formatVersion: 2, minimumCompatibleProtocolVersion: 2, layoutEpoch: 1 };
  const commands = [];
  const sqlWrites = [];
  const leases = [];
  const storage = desktopStorageOver(fsa);
  if (standdown) {
    db.prepare("INSERT INTO kv_store (key, value, updated_at) VALUES (?, ?, ?)").run('h2o:studio:sync:writer-generation:v1', JSON.stringify({ schema: 'h2o.studio.syncWriterGeneration.p02.v1', schemaVersion: 1, generation: 'p02', standdownAt: SOURCE_AT, decidedByWriterSyncPeerId: REMOTE, reason: 'fixture' }), SOURCE_AT);
  }
  const invoke = async (name, args = {}) => {
    commands.push(name);
    switch (name) {
      case 'plugin:sql|select': return db.prepare(args.query).all(...(args.values || []));
      case 'plugin:sql|execute': {
        sqlWrites.push(args.query);
        const result = db.prepare(args.query).run(...(args.values || []));
        return [Number(result.changes), Number(result.lastInsertRowid)];
      }
      case 'h2o_p02_storage_read': {
        const bytes = await storage.read(args.relativePath);
        return bytes === null ? { schema: STORAGE_SCHEMA, present: false } : { schema: STORAGE_SCHEMA, present: true, base64: Buffer.from(bytes).toString('base64'), byteLength: bytes.byteLength };
      }
      case 'h2o_p02_storage_write_temporary': {
        if (!leases.some((l) => l.capability === args.capability && l.open)) throw 'p02-storage-capability-invalid';
        await storage.writeTemporary(args.relativePath, Buffer.from(args.base64, 'base64')); return null;
      }
      case 'h2o_p02_storage_read_temporary': {
        const bytes = await storage.readTemporary(args.relativePath);
        return bytes === null ? { schema: STORAGE_SCHEMA, present: false } : { schema: STORAGE_SCHEMA, present: true, base64: Buffer.from(bytes).toString('base64'), byteLength: bytes.byteLength };
      }
      case 'h2o_p02_storage_promote_temporary': {
        if (!leases.some((l) => l.capability === args.capability && l.open)) throw 'p02-storage-capability-invalid';
        await storage.promoteTemporary(args.pendingPath, args.finalPath, { replaceExisting: args.replaceExisting }); return null;
      }
      case 'h2o_p02_read_library_authority': return { present: true, readable: true, canonicalBytes: JSON.stringify(libraryInfo) };
      case 'h2o_p02_read_writer_generation_authority': return { schema: 'h2o.studio.syncWriterGenerationAuthority.p02.v1', state: generationState, writerKey: args.writerKey };
      case 'h2o_p02_resolve_repository_root': return { repositoryRoot: '/fixture', containerPathSha256Hex: 'f'.repeat(64), authorityPresent: true };
      case 'h2o_sync_object_runtime_session': return { bootId: 'boot-fixture' };
      case 'h2o_p02_steady_begin': {
        /* The native window refuses a first own publication (no CAS base). */
        const request = args.request || {};
        if (request.expectedCurrentHeadsSnapshotSha256 === null || request.expectedCurrentHeadsSnapshotSha256 === undefined) throw 'p02-steady-expected-pointer-required';
        if (request.bootId !== 'boot-fixture' || !request.objectDomain || !request.objectKey) throw 'p02-steady-request-invalid';
        const capability = crypto.randomBytes(32).toString('hex');
        leases.push({ capability, open: true, request });
        return { capability };
      }
      case 'h2o_p02_steady_finish': { const lease = leases.find((l) => l.capability === args.capability); if (lease) { lease.open = false; lease.outcome = args.outcome; } return null; }
      default: throw Object.assign(new Error(`unexpected-command:${name}`), { code: `unexpected-command:${name}` });
    }
  };
  /* The module is written for the PACKED layout; import it from the staged graph. */
  const module = await packedGraph.importPacked('sync/sync-relationship-publication-desktop-v2.tauri.mjs');
  const publication = module.createDesktopRelationshipPublication({
    invoke, configOwner: { getConfig: async () => ({ schemaVersion: 1, mode: 'manual', configuredPeers: peers }) },
    localIdentity: async () => ({ syncPeerId: REMOTE }), cryptoImplementation: webcrypto, clock: () => SOURCE_AT
  });
  const insertChat = (id) => db.prepare('INSERT INTO chats (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)').run(id, `chat ${id}`, NOW_MS, NOW_MS);
  const insertFolder = (id, name, source = 'user') => db.prepare('INSERT INTO folders (id, name, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(id, name, source, NOW_MS, NOW_MS);
  const bind = (chatId, folderId) => { identity = 'p02.relationship-apply'; db.prepare('INSERT OR REPLACE INTO folder_bindings (chat_id, folder_id, assigned_at) VALUES (?, ?, ?)').run(chatId, folderId, NOW_MS); identity = ''; };
  const unbind = (chatId) => { identity = 'p02.relationship-apply'; db.prepare('DELETE FROM folder_bindings WHERE chat_id = ?').run(chatId); identity = ''; };
  const state = (domain, id) => db.prepare('SELECT * FROM sync_object_state WHERE sync_peer_id = ? AND object_domain = ? AND object_id = ?').get(REMOTE, domain, id) || null;
  const anchorApplied = (domain, id, record) => db.prepare('INSERT INTO sync_object_state (sync_peer_id, object_domain, object_id, last_applied_revision_id, last_applied_revision_blob_sha256, last_applied_payload_sha256, last_converged_direction, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(REMOTE, domain, id, record.revisionId, record.revisionBlobSha256, record.payloadSha256, 'applied', SOURCE_AT, SOURCE_AT);
  /* Seed the Desktop writer pointer with a chat root so the steady window has a CAS base. */
  const desktop = makeDesktopWriter(fsa, REMOTE);
  return { db, module, publication, invoke, commands, sqlWrites, leases, insertChat, insertFolder, bind, unbind, state, anchorApplied, desktop, storage };
}

await section('E D2 Desktop relationship publication: ROOT / DESCENDANT / second-root refusal / ordering', async () => {
  const fsa = createMemoryFsa();
  const w = await makeDesktopWorld({ fsa });
  /* An existing writer pointer (chat root) is the steady CAS base. */
  const chatPayload = chatPayloadFor('chat-a', 'snap-a', 'hi');
  await w.desktop.publish({ objectDomain: CHAT_DOMAIN, objectId: 'chat-a', payload: chatPayload, mint: 'chat1' });
  w.insertChat('chat-a');
  w.insertFolder('f_study', 'Study');
  w.insertFolder('f_native', 'Native', 'chatgpt');
  const empty = await w.publication.publishOnce();
  /* Unfiled chat-a with no anchor is NOT a candidate; native-source folder not eligible. */
  check(empty.outcome === 'published' && empty.selectedObjectDomain === FOLDER_DOMAIN && empty.selectedObjectId === 'f_study' && empty.publishedAs === 'root' && empty.eligibleCount === 1,
    `first attempt publishes the folder as ROOT (${empty.outcome}/${empty.selectedObjectId}/${empty.publishedAs}/${empty.eligibleCount})`);
  check(empty.ineligible.some((i) => i.objectId === 'chat-a' && i.eligibility === 'not-eligible(unfiled-unanchored)') && empty.ineligible.some((i) => i.objectId === 'f_native' && i.eligibility === 'not-eligible(folder-source)'),
    'unfiled-unanchored binding and non-user folder are typed ineligible');
  const folderRow = w.state(FOLDER_DOMAIN, 'f_study');
  check(folderRow?.last_published_revision_id === empty.mintedRevisionId && folderRow.last_converged_direction === 'published' && HEX64.test(folderRow.last_published_payload_sha256 || '') && folderRow.pending_operation === null && w.state(CHAT_DOMAIN, 'f_study') === null,
    'bookkeeping: the folder row is domain-qualified (folder domain), anchored published with payload identity, intent cleared; no chat-domain row');
  const reader = readerTransport.createLocalReaderTransportPrimitives({ storage: desktopStorageOver(fsa), cryptoImplementation: webcrypto });
  const state1 = await reader.readWriterState({ writerSyncPeerId: REMOTE });
  const folderHead = state1.snapshot.heads.find((h) => h.objectDomain === FOLDER_DOMAIN);
  check(folderHead?.objectId === 'f_study' && folderHead.previousRevisionId === null && folderHead.revisionId === empty.mintedRevisionId && state1.snapshot.heads.some((h) => h.objectDomain === CHAT_DOMAIN),
    'the repository head is a relationship ROOT beside the carried chat head');
  const revision = JSON.parse(new TextDecoder().decode(fsa.read(`${REPOSITORY}/objects/${folderHead.objectKey}/revisions/${folderHead.revisionBlobSha256}.json`)));
  check(JSON.stringify(revision.payload) === JSON.stringify({ folderId: 'f_study', name: 'Study', schema: FOLDER_SCHEMA }) && revision.writerSyncPeerId === REMOTE && folderHead.sourceUpdatedAtIso === SOURCE_AT,
    'published payload is the D1 exact folder state; the head carries updated_at as sourceUpdatedAtIso');
  check((await w.publication.publishOnce()).outcome === 'no-eligible-local-change', 'second attempt: converged, nothing to publish');
  /* Rename -> DESCENDANT of the published anchor. */
  w.db.prepare('UPDATE folders SET name = ?, updated_at = ? WHERE id = ?').run('Study Notes', SOURCE_MS + 60000, 'f_study');
  const rename = await w.publication.publishOnce();
  check(rename.outcome === 'published' && rename.publishedAs === 'descendant' && rename.selectedObjectId === 'f_study', `rename publishes as DESCENDANT (${rename.outcome}/${rename.publishedAs})`);
  const state2 = await reader.readWriterState({ writerSyncPeerId: REMOTE });
  const head2 = state2.snapshot.heads.find((h) => h.objectDomain === FOLDER_DOMAIN);
  check(head2.previousRevisionId === empty.mintedRevisionId && head2.revisionId === rename.mintedRevisionId && head2.sourceUpdatedAtIso === new Date(SOURCE_MS + 60000).toISOString(),
    'the descendant names the previous root as parent; never a second root');
  /* Binding: bind chat-a -> f_study becomes eligible; unfile later is a descendant. */
  w.bind('chat-a', 'f_study');
  const bound = await w.publication.publishOnce();
  check(bound.outcome === 'published' && bound.selectedObjectDomain === BINDING_DOMAIN && bound.publishedAs === 'root', 'a bound chat publishes its binding root');
  w.unbind('chat-a');
  const unfiled = await w.publication.publishOnce();
  check(unfiled.outcome === 'published' && unfiled.selectedObjectDomain === BINDING_DOMAIN && unfiled.publishedAs === 'descendant', 'Unfile publishes a binding descendant (folderId null), not a second root');
  const state3 = await reader.readWriterState({ writerSyncPeerId: REMOTE });
  const bindHead = state3.snapshot.heads.find((h) => h.objectDomain === BINDING_DOMAIN);
  const bindRevision = JSON.parse(new TextDecoder().decode(fsa.read(`${REPOSITORY}/objects/${bindHead.objectKey}/revisions/${bindHead.revisionBlobSha256}.json`)));
  check(bindRevision.payload.folderId === null && bindRevision.previousRevisionId === bound.mintedRevisionId, 'the Unfile revision carries folderId null and descends from the bind root');
  /* Ordering: two new folders and a new binding pending -> folder first, one per attempt. */
  w.insertChat('chat-b'); w.insertFolder('f_code', 'Code'); w.bind('chat-b', 'f_code'); w.insertFolder('f_art', 'Art');
  const o1 = await w.publication.publishOnce();
  const o2 = await w.publication.publishOnce();
  const o3 = await w.publication.publishOnce();
  check([o1, o2, o3].map((r) => `${r.selectedObjectDomain}:${r.selectedObjectId}`).join('|') === `${FOLDER_DOMAIN}:f_art|${FOLDER_DOMAIN}:f_code|${BINDING_DOMAIN}:chat-b` && o1.deferredCandidates.length === 2,
    `deterministic folder-before-binding ordering, one object per attempt (${[o1, o2, o3].map((r) => r.selectedObjectId).join(',')})`);
  /* DESCENDANT of an APPLIED anchor (Chrome-authored root applied locally). */
  const chrome = makeDesktopWriter(fsa, LOCAL);
  const C1 = await chrome.publish({ objectDomain: FOLDER_DOMAIN, objectId: 'f_chrome', payload: folderPayload('f_chrome', 'Chrome'), mint: 'cc1' });
  w.insertFolder('f_chrome', 'Chrome');
  w.anchorApplied(FOLDER_DOMAIN, 'f_chrome', C1);
  check((await w.publication.publishOnce()).outcome === 'no-eligible-local-change', 'an applied, byte-identical folder is converged (no echo of an applied Chrome root)');
  w.db.prepare('UPDATE folders SET name = ?, updated_at = ? WHERE id = ?').run('Chrome Renamed', SOURCE_MS + 120000, 'f_chrome');
  const fromApplied = await w.publication.publishOnce();
  const state4 = await reader.readWriterState({ writerSyncPeerId: REMOTE });
  const chromeHead = state4.snapshot.heads.find((h) => h.objectId === 'f_chrome');
  check(fromApplied.outcome === 'published' && fromApplied.publishedAs === 'descendant' && chromeHead?.previousRevisionId === C1.revisionId && chromeHead.previousRevisionBlobSha256 === C1.revisionBlobSha256,
    'a local change to an APPLIED object publishes as a descendant of the proven applied anchor (repository-verified)');
  /* Second-root refusal: a configured peer already roots f_foreign; Desktop holds no anchor. */
  const chromeKey = await writerKeyHex(LOCAL, webcrypto);
  const withPeer = await makeDesktopWorld({ fsa, peers: [{ syncPeerId: LOCAL, writerKey: chromeKey }] });
  await withPeer.desktop.publish({ objectDomain: CHAT_DOMAIN, objectId: 'chat-z', payload: chatPayloadFor('chat-z', 'snap-z', 'hello'), mint: 'chatz' });
  await chrome.publish({ objectDomain: FOLDER_DOMAIN, objectId: 'f_foreign', payload: folderPayload('f_foreign', 'Foreign'), mint: 'ff1' });
  withPeer.insertFolder('f_foreign', 'Foreign Local');
  const foreign = await withPeer.publication.publishOnce();
  check(foreign.outcome === 'no-eligible-local-change' && foreign.foreignRootBlocked.some((b) => b.objectId === 'f_foreign' && b.foreignRoots.some((r) => r.syncPeerId === LOCAL)),
    `an object a trusted peer already roots is refused as a ROOT candidate (receive first) (${foreign.outcome})`);
  check(withPeer.state(FOLDER_DOMAIN, 'f_foreign') === null && !(await reader.readWriterState({ writerSyncPeerId: REMOTE })).snapshot.heads.some((h) => h.objectId === 'f_foreign' && h.writerSyncPeerId === REMOTE),
    'no second root was minted and no bookkeeping row was written for it');
  /* Authority: P01 not stood down / repository not p02 -> refused before any write. */
  const noStanddown = await makeDesktopWorld({ fsa: createMemoryFsa(), standdown: false });
  noStanddown.insertFolder('f_x', 'X');
  const refusedAuthority = await noStanddown.publication.publishOnce();
  check(refusedAuthority.ok === false && refusedAuthority.repositoryMutated === false && noStanddown.state(FOLDER_DOMAIN, 'f_x')?.last_published_revision_id == null,
    `without the P01 standdown the publication is refused and nothing is published (${refusedAuthority.outcome})`);
  /* Fences: no relationship SQL mutation, no chat-domain rows, no new command. */
  check(w.sqlWrites.every((q) => /^(INSERT INTO sync_object_state|UPDATE sync_object_state)/.test(q)) && w.sqlWrites.length > 0,
    'the ONLY SQL writes are relationship-domain sync_object_state bookkeeping (no folders / folder_bindings writes)');
  check(w.db.prepare('SELECT COUNT(*) AS n FROM sync_object_state WHERE object_domain NOT IN (?, ?, ?)').get(FOLDER_DOMAIN, BINDING_DOMAIN, CHAT_DOMAIN).n === 0 &&
    w.db.prepare('SELECT COUNT(*) AS n FROM sync_object_state WHERE object_domain = ? AND last_published_revision_id IS NOT NULL').get(CHAT_DOMAIN).n === 0,
  'the module never wrote a chat-domain publication row');
  const KNOWN_COMMANDS = ['plugin:sql|select', 'plugin:sql|execute', 'h2o_p02_storage_read', 'h2o_p02_storage_write_temporary', 'h2o_p02_storage_read_temporary', 'h2o_p02_storage_promote_temporary', 'h2o_p02_read_library_authority', 'h2o_p02_read_writer_generation_authority', 'h2o_p02_resolve_repository_root', 'h2o_sync_object_runtime_session', 'h2o_p02_steady_begin', 'h2o_p02_steady_finish'];
  check([...new Set(w.commands)].every((c) => KNOWN_COMMANDS.includes(c)), `only existing commands are invoked (${[...new Set(w.commands)].join(',')})`);
  check(w.leases.every((l) => l.open === false) && w.leases.every((l) => ['committed', 'stale-base', 'aborted'].includes(l.outcome)), 'every steady lease was closed with a typed outcome');
  const desktopSource = stripComments(read('src-surfaces-base/studio/sync/sync-relationship-publication-desktop-v2.tauri.mjs'));
  for (const token of ['h2o_p02_relationship_apply', 'INSERT INTO folders', 'UPDATE folders', 'INSERT OR REPLACE INTO folder_bindings', 'DELETE FROM folder_bindings', 'importFullBundle', 'setTimeout', 'setInterval', 'addEventListener', 'h2o_p02_publication_begin']) {
    check(!desktopSource.includes(token), `Desktop publication source contains no ${token}`);
  }
  check(desktopSource.includes('produceRelationshipRevisionV2(') && desktopSource.includes('createP02SteadyPublication(') && desktopSource.includes('createDesktopLocalWriterStorage(') && desktopSource.includes('createDesktopP01MutationGate('),
    'Desktop publication reuses the relationship revision adapter, the steady core, the writer storage and the P01 gate');
  w.db.close(); withPeer.db.close(); noStanddown.db.close();
});

/* ====================================================================== */
await section('F background composition, host lease hunks, manual gates', async () => {
  const reconcile = read('packages/browser-adapters/chrome/sync-background-reconcile.mjs');
  check(reconcile.includes("from './sync-relationship-counterpart-chrome-v2.mjs'") && reconcile.includes('counterpart.applySelectedRelationshipRevision({') && reconcile.includes('const applyV2 = createChromeV2Apply({'),
    'relationship Apply dispatches to the counterpart; chat Apply still goes through createChromeV2Apply');
  check(reconcile.includes('partitionTrustedPeerAdvertisements(discovered)') && reconcile.includes('sortMergedDescriptors([...chatDescriptors, ...relationshipDescriptors])'),
    'trusted advertisements are partitioned by family and merged in deterministic family order');
  check(reconcile.includes("if (manualApplyAuthority() === true) {") && reconcile.includes('applyAuthority: null') && !stripComments(reconcile).includes('publishAutomaticRelationship'),
    'trusted-human manual stage gates preserved; the receive stage has no apply authority; no autonomous relationship Apply');
  check(reconcileModule.P02_BACKGROUND_COMPOSITION.nonChatReceive === 'domain-qualified-idb-state' && reconcileModule.P02_BACKGROUND_COMPOSITION.relationshipWriter === 'strict-h2o-folders-owner-api' && reconcileModule.P02_BACKGROUND_COMPOSITION.relationshipApply === 'trusted-human-manual-one-object-per-attempt',
    'composition provenance reports the T05 counterpart posture');
  /* The runtime composes with a write-capable relationship authority and refuses a malformed one. */
  const chromeApi = { storage: { local: storageArea({}), onChanged: { addListener() {}, removeListener() {} } }, alarms: { onAlarm: { addListener() {}, removeListener() {} }, get: (n, cb) => { cb?.(null); return Promise.resolve(null); }, create() {}, clear: (n, cb) => { cb?.(false); return Promise.resolve(false); } }, runtime: { lastError: null, onStartup: { addListener() {}, removeListener() {} }, onInstalled: { addListener() {}, removeListener() {} }, sendMessage: (m, cb) => { cb?.(null); return Promise.resolve(null); } } };
  const archiveAuthority = { listWorkbenchRows: async () => [], listSnapshots: async () => [], loadSnapshot: async () => null, importFullBundle: async () => ({}) };
  const relationshipAuthority = { listFolders: async () => ({ source: 'H2O.folders', strict: true, folders: [] }), resolveBindings: async () => ({ source: 'H2O.folders', strict: true, bindings: {} }), applyFolderOperation: async () => ({}), setBinding: async () => ({}) };
  const runtime = reconcileModule.createChromeBackgroundSyncRuntime({ chromeApi, indexedDBFactory: new FakeIndexedDBFactory(), cryptoImplementation: webcrypto, archiveAuthority, relationshipAuthority, findActiveStudioContexts: async () => [], reconcileCore: { reconcileOneObject: async () => ({}) }, lockManager: { request: async (n, o, cb) => cb() } });
  const diagnosis = runtime.diagnose();
  check(diagnosis.p02RelationshipCounterpart?.composed === true && diagnosis.p02RelationshipCounterpart.writerCapabilities.applyFolderOperation === true && diagnosis.p02RelationshipCounterpart.writerCapabilities.setBinding === true && diagnosis.p02RelationshipCounterpart.writerAuthority === 'H2O.folders',
    'the background runtime composes the counterpart with both strict write capabilities');
  check(await codeOf(() => reconcileModule.createChromeBackgroundSyncRuntime({ chromeApi, indexedDBFactory: new FakeIndexedDBFactory(), cryptoImplementation: webcrypto, archiveAuthority, relationshipAuthority: { ...relationshipAuthority, setBinding: 'nope' }, findActiveStudioContexts: async () => [], reconcileCore: { reconcileOneObject: async () => ({}) } })) === 'background-sync-runtime-unavailable',
    'a malformed write capability refuses runtime construction');
  const without = reconcileModule.createChromeBackgroundSyncRuntime({ chromeApi, indexedDBFactory: new FakeIndexedDBFactory(), cryptoImplementation: webcrypto, archiveAuthority, findActiveStudioContexts: async () => [], reconcileCore: { reconcileOneObject: async () => ({}) }, lockManager: { request: async (n, o, cb) => cb() } });
  check(without.diagnose().p02RelationshipCounterpart.composed === false, 'without a relationship authority the counterpart is not composed (chat-only, as before)');
  /* Host lease hunks: generated worker wires exactly the two strict write capabilities. */
  const background = read('tools/product/extensions/chatgpt/chrome/chrome-live-background.mjs');
  check(background.includes('applyFolderOperation: (operation) => applyFolderMetadataOperationStrict(operation),') && background.includes('setBinding: ({ chatId, folderId } = {}) => setFolderBindingStrict(chatId, folderId),'),
    'the service worker hands the counterpart exactly the two strict write wrappers');
  const writeBlock = stripComments(background.slice(background.indexOf('/* ---- P02 T05 (Host lease'), background.indexOf('async function setFolderBindingBridge(')));
  check(writeBlock.includes('queryFolderBridge("applyFolderMetadataOperation", { strict: true') && writeBlock.includes('queryFolderBridge("setFolderBinding", { strict: true') && !writeBlock.includes('localStorage.') && !writeBlock.includes('chrome.storage') && !writeBlock.includes('normalizeFolderBinding('),
    'strict write wrappers reach the page bridge in strict mode only, with no cache / storage / fallback');
  const bridge = bridgeModule.makeChromeLiveFolderBridgePageJs();
  const bridgeWrites = stripComments(bridge.slice(bridge.indexOf('P02 T05 strict writes'), bridge.indexOf('function setFolderIconColor(')));
  check(bridgeWrites.includes('api.applyMetadataOperation(operation, {})') && bridgeWrites.includes('api.setBinding(chatId, folderId, { source: STRICT_WRITE_SOURCE_TAG') && bridgeWrites.includes('api.getBinding(chatId)') &&
    ['writeJson(', 'readJson(', 'localStorage.', 'keyArchiveFolder', 'archiveBoot', 'upsertLatestSnapshotMeta', 'H2O.projects', 'moveChatToProject', 'delete-folder'].every((t) => !bridgeWrites.includes(t)),
  'page-bridge strict writes: owner API only, strict read-back, no localStorage / archive stamp / native mutation');
  check(bridge.includes('} else if (op === "setFolderBinding" && strict) {') && bridge.includes('} else if (op === "applyFolderMetadataOperation" && strict) {') && bridge.includes('} else if (op === "setFolderBinding") {\n        result = setFolderBinding(payload.chatId, payload.folderId, nsDisk);'),
    'strict write ops are separate message routes; the non-strict setFolderBinding route is unchanged');
  /* The generated worker still compiles with the T05 hunks (esbuild present) or is at least syntactically produced. */
  try {
    const backgroundModule = await importRepo('tools/product/extensions/chatgpt/chrome/chrome-live-background.mjs');
    const js = backgroundModule.makeChromeLiveBackgroundJs({ H2O_BUILD_STAMP: `h2o-runtime-v1:${'0'.repeat(40)}`, DEV_TAG: '[t05]', CHAT_MATCH: 'https://chatgpt.com/*', DEV_HAS_CONTROLS: false, MANIFEST_PROFILE: 'production' });
    new Function(js);
    check(js.includes('createChromeRelationshipCounterpart') && js.includes('recordRelationshipBranchEvidence') && js.includes('applyFolderMetadataOperationStrict'), 'the generated production worker bundles the counterpart and the strict write wrappers');
  } catch (error) {
    check(String(error?.code || error?.message || '').includes('esbuild') || String(error?.message || '').includes("Cannot find package 'esbuild'"), `worker generation skipped only for a missing esbuild toolchain (${error?.message})`);
  }
});

/* ====================================================================== */
await section('G pack / dist inventory parity and staged imports', async () => {
  check(pack.P02_CHROME_ADAPTER_SOURCE_FILES.includes('sync-revision-domain-relationship-v2.mjs'), 'Chrome adapter pack inventory carries the relationship revision adapter');
  const packSource = read('tools/product/studio/pack-studio.mjs');
  check((packSource.match(/"sync\/sync-relationship-publication-desktop-v2\.tauri\.mjs"/g) || []).length === 2, 'Studio source and out inventories both carry the Desktop publication module');
  check(pack.ARCHIVE_WORKBENCH_SOURCE_FILES.includes('sync/sync-relationship-publication-desktop-v2.tauri.mjs') && pack.ARCHIVE_WORKBENCH_OUT_FILES.includes('sync/sync-relationship-publication-desktop-v2.tauri.mjs'),
    'mirrored inventory equality holds for the new module');
  for (const file of pack.P02_CHROME_ADAPTER_SOURCE_FILES) check(fs.existsSync(rel('packages/browser-adapters/chrome', file)), `chrome inventory file exists: ${file}`);
  check(distGraph.P02_PACKED_LAYOUT.sync.includes('src-surfaces-base/studio/sync/sync-relationship-publication-desktop-v2.tauri.mjs') && distGraph.P02_PACKED_LAYOUT['browser-adapters/chrome'].includes('packages/browser-adapters/chrome/sync-revision-domain-relationship-v2.mjs'),
    'the dist graph stages the new module and the relationship adapter');
  const staged = distGraph.stagePackedGraph();
  try {
    const packed = await staged.importPacked('sync/sync-relationship-publication-desktop-v2.tauri.mjs');
    check(typeof packed.createDesktopRelationshipPublication === 'function' && packed.P02_DESKTOP_RELATIONSHIP_PUBLICATION.FOLDER_OBJECT_DOMAIN === FOLDER_DOMAIN, 'the packed Desktop module resolves every relative import (core, browser-adapters/chrome, sync)');
    const packedAdapter = await staged.importPacked('browser-adapters/chrome/sync-revision-domain-relationship-v2.mjs');
    check(packedAdapter.P02_RELATIONSHIP_DOMAIN_V2.FOLDER.OBJECT_DOMAIN === FOLDER_DOMAIN, 'the packed relationship adapter resolves ../../core/');
  } finally { staged.dispose(); }
  /* The counterpart is not a Studio-packed module: it reaches bg.js through the esbuild bundle of the reconcile entry. */
  check(!packSource.includes('sync-relationship-counterpart-chrome-v2.mjs'), 'no Chrome build inventory edit was needed for the counterpart (bundled transitively)');
  check(read('tools/product/extensions/chatgpt/chrome/chrome-live-background.mjs').includes('packages/browser-adapters/chrome/sync-background-reconcile.mjs'), 'bg.js bundles the reconcile entry that imports the counterpart');
});

fs.rmSync(scratch, { recursive: true, force: true });
packedGraph.dispose();

/* ---------------------------------------------------------------------- */
const verdict = failures.length === 0 ? 'RELATIONSHIP_COUNTERPART_T05_PASS' : 'RELATIONSHIP_COUNTERPART_T05_NOT_READY';
console.log(JSON.stringify({
  schema: 'h2o.studio.p02RelationshipCounterpartT05Validation.v1',
  mission: 'p02-folder-relationship-synchronization',
  task: 'T05',
  verdict,
  assertions,
  sections,
  failures,
  directionCoverage: 'RELATIONSHIP_SYNC_DIRECTION_COVERAGE=BIDIRECTIONAL',
  chromeDatabaseVersion: ITEM9_1_CONSTANTS.DATABASE_VERSION,
  liveMutation: 'none (memory repository, fake IndexedDB, temporary SQLite, fake invoke; no live repository, profile, runtime or canonical database touched)'
}, null, 2));
process.exit(failures.length === 0 ? 0 : 1);
