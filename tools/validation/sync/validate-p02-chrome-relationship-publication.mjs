#!/usr/bin/env node
/*
 * P02 Folder Relationship Synchronization — T02 Chrome relationship
 * enumeration & publication validator.
 *
 * Mission p02-folder-relationship-synchronization, Task T02 (exit token
 * CHROME_RELATIONSHIP_PUBLICATION_PASS). Deterministic, disposable, in-process:
 * memory File System Access repository, in-memory ledger doubles, a vm-hosted
 * copy of the REAL page-world folder bridge. No Chrome, no IDB, no repository,
 * no Desktop, no transport.
 *
 * Proves, with the real modules (domain adapters, relationship enumerator,
 * publication owner, steady core, heads merge, writer transport, contract):
 *   A  folder authoritative-source projection (deterministic, exact-key, verbatim id)
 *   B  binding authoritative-source projection (null = Unfile)
 *   C  legacy mirror / cache can never become the P02 publication source
 *   D  page authority unavailable -> typed source-unavailable, no fallback
 *   E  project_backed / system / reserved folders are typed-ineligible
 *   F  folder payload exact-key strictness reused from T01
 *   G  binding payload exact-key strictness reused from T01
 *   H  archive source disagreement fails closed
 *   I  folder root composition
 *   J  binding root composition
 *   K  folder rename descendant
 *   L  binding move descendant (Study -> Code, Code -> Study)
 *   M  Unfile descendant with folderId null
 *   N  identical relationship state -> no new revision
 *   O  same-name / different-id folders stay distinct
 *   P  same chat objectId across chat / binding domains stays separate
 *   Q  multi-candidate deterministic one-object-per-attempt sequencing
 *   R  existing chat publication remains green (bytes identical)
 *   S  no native ChatGPT mutation path in the P02 publication modules
 *   T  no live repository mutation by these tests
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../..');
const rel = (...parts) => path.join(repo, ...parts);
const read = (...parts) => fs.readFileSync(rel(...parts), 'utf8');
const importRepo = (...parts) => import(pathToFileURL(rel(...parts)).href);
const webcrypto = crypto.webcrypto;

const CHAT_DOMAIN = 'studio.chat.saved-state.v1';
const FOLDER_DOMAIN = 'studio.folder.v1';
const BINDING_DOMAIN = 'studio.chat-folder-binding.v1';
const HEX64 = /^[0-9a-f]{64}$/;
const MINT_RE = /^p02-[0-9a-f]{32}$/;
const LOCAL = 'studio-chrome:mv3-chrome:idb-archive:t02-local-peer';
const REMOTE = 'studio-desktop:tauri-desktop:sqlite:t02-remote-peer';
const SOURCE_AT = '2026-09-14T10:15:30.123Z';
const SOURCE_MS = Date.parse(SOURCE_AT);
const RENAME_AT = '2026-09-14T10:16:30.123Z';
const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

let assertions = 0;
const failures = [];
const sections = [];
function check(condition, label) {
  assertions += 1;
  if (condition !== true) failures.push(label);
}
async function section(name, fn) {
  const before = failures.length;
  try {
    await fn();
  } catch (error) {
    failures.push(`${name}: threw ${error?.code || error?.message || error}`);
    if (process.env.H2O_VALIDATOR_TRACE) console.error(error);
  }
  sections.push({ name, ok: failures.length === before });
}
const codeOf = async (fn) => { try { await fn(); return 'ok'; } catch (e) { return e?.code || e?.message || 'threw'; } };
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

const contract = await importRepo('packages/browser-adapters/chrome/sync-contract-v2.mjs');
const domains = await importRepo('packages/core/sync-relationship-domains-v2.mjs');
const adapter = await importRepo('packages/browser-adapters/chrome/sync-revision-domain-relationship-v2.mjs');
const enumeratorModule = await importRepo('packages/browser-adapters/chrome/sync-relationship-enumerator-chrome-v2.mjs');
const publicationModule = await importRepo('packages/browser-adapters/chrome/sync-p02-publication-chrome-v2.mjs');
const chatAdapter = await importRepo('packages/browser-adapters/chrome/sync-revision-domain-chat-v2.mjs');
const generationModule = await importRepo('packages/core/sync-writer-generation-v2.mjs');
const fsaRead = await importRepo('packages/browser-adapters/chrome/sync-fsa-read-transport-v2.mjs');
const fsaWrite = await importRepo('packages/browser-adapters/chrome/sync-fsa-write-transport-v2.mjs');
const { createMemoryFsa } = await importRepo('tools/validation/sync/helpers/p02-memory-fsa.mjs');
const bridgeModule = await importRepo('tools/product/extensions/chatgpt/chrome/chrome-live-folder-bridge.mjs');

const { objectKeyHex, writerKeyHex, canonicalJson } = contract;
const { P02_RELATIONSHIP_ELIGIBILITY: ELIG, projectFolderCatalogState, projectChatFolderBinding, produceRelationshipRevisionV2 } = adapter;
const { createChromeRelationshipObjectEnumerator } = enumeratorModule;
const { createChromeP02PublicationOwner, compareCandidateDescriptors, P02_CHROME_PUBLICATION_V2 } = publicationModule;
const REPOSITORY = fsaRead.P02_FSA_REPOSITORY_CHILD;

const sha256HexText = async (text) => Array.from(new Uint8Array(await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(text))), (b) => b.toString(16).padStart(2, '0')).join('');

/* ------------------------------------------------------------------ */
/* Disposable world: strict relationship source, archive rows, ledger  */
/* ------------------------------------------------------------------ */
function chatPayload(objectId, snapshotId, text) {
  return {
    schema: chatAdapter.P02_CHAT_DOMAIN_V2.PAYLOAD_SCHEMA,
    chatArchive: {
      chats: [{
        chatId: objectId, title: 'T02 fixture',
        chatIndex: { title: 'T02 fixture', lastSnapshotId: snapshotId, snapshotCount: 1, messageCount: 1,
          state: { isSaved: true, isLinked: true }, organization: {} },
        snapshots: [{ snapshotId, chatId: objectId, createdAt: SOURCE_AT, messageCount: 1,
          messages: [{ order: 0, role: 'user', text }],
          meta: { title: 'T02 fixture', richTurns: [{ turnIdx: 0, role: 'user', outerHTML: `<p>${text}</p>`, meta: {} }] } }]
      }],
      catalogs: { categories: [], labels: [], tags: [] }
    },
    chromeStorageLocal: {}, libraryKv: []
  };
}

/* The authoritative page-world state, mutable by the test (the "user"). */
function makeSource() {
  const state = {
    folders: [],            // records as H2O.folders.list() returns them
    bindings: new Map(),    // chatId -> folderId ('' = unfiled)
    listFailure: null,      // Error to throw from listFolders
    bindingFailure: null,
    strictTag: true,
    calls: []
  };
  const authority = {
    async listFolders() {
      state.calls.push('listFolders');
      if (state.listFailure) throw state.listFailure;
      const folders = state.folders.map((record) => ({ ...record }));
      return state.strictTag ? { source: 'H2O.folders', strict: true, folders } : { folders };
    },
    async resolveBindings(chatIds) {
      state.calls.push(`resolveBindings:${chatIds.length}`);
      if (state.bindingFailure) throw state.bindingFailure;
      const bindings = {};
      for (const chatId of chatIds) {
        const folderId = state.bindings.get(chatId) ?? '';
        const folder = state.folders.find((record) => record.id === folderId);
        bindings[chatId] = { folderId, folderName: folder ? folder.name : '' };
      }
      return state.strictTag ? { source: 'H2O.folders', strict: true, bindings } : { bindings };
    }
  };
  return { state, authority };
}

/* Accepted archive rows: the subject set plus the stamped folderId cross-check. */
function makeArchive(source) {
  const chats = new Map(); // chatId -> { text, snapshotId, stampedFolderId }
  return {
    chats,
    stamp(chatId, folderId) { chats.get(chatId).stampedFolderId = folderId; },
    authority: {
      async listWorkbenchRows() {
        return [...chats.entries()].map(([chatId, chat]) => ({
          chatId, snapshotId: chat.snapshotId, title: 'T02 fixture',
          createdAt: SOURCE_AT, updatedAt: chat.updatedAt ?? SOURCE_AT,
          folderId: chat.stampedFolderId ?? (source.state.bindings.get(chatId) ?? ''),
          folderName: ''
        }));
      }
    }
  };
}

/* Multi-object in-memory local-publication ledger keyed by objectKey, with
 * the exact port shape the owner and the T01 protocol-state helper use. */
function makeLedger(events, { chatApplyState = null } = {}) {
  const rows = new Map(); // objectKey -> { pending, tip, direction }
  const row = (objectKey) => {
    if (!rows.has(objectKey)) rows.set(objectKey, { pending: null, tip: null, direction: null });
    return rows.get(objectKey);
  };
  const applyReads = [];
  return {
    rows, applyReads,
    listReadOnlyObjectIds: async () => [],
    async readApplySnapshot(objectId) {
      applyReads.push(objectId);
      return { ok: true, observations: [], applyState: chatApplyState };
    },
    readLocalPublicationTip: async (objectKey) => row(objectKey).tip,
    readLocalPublicationConvergence: async (objectKey) => ({ tip: row(objectKey).tip, convergedDirection: row(objectKey).direction }),
    resolveLocalPublicationPending: async (objectKey) => {
      const r = row(objectKey);
      return r.pending
        ? { state: r.pending.state === 'promote-ready' ? 'PromoteReady' : 'ResumeRetry', pending: { state: r.pending.state, request: r.pending.request } }
        : { state: 'Clean', pending: null };
    },
    listLocalPublicationRecoveryObjects: async () => [...rows.entries()]
      .filter(([, r]) => r.pending)
      .map(([objectKey, r]) => ({ objectId: r.pending.request.objectId, objectKey, revisionId: r.pending.request.revisionId, state: r.pending.state }))
      .sort((a, b) => a.objectId.localeCompare(b.objectId) || a.revisionId.localeCompare(b.revisionId)),
    async stageLocalPublicationIntent(input) {
      events.push(`ledger:stage:${input.objectKey.slice(0, 8)}`);
      row(input.objectKey).pending = { state: 'promote-ready', request: { ...input } };
      return { ok: true, verdict: 'promote-ready' };
    },
    async markLocalPublicationRetry(objectKey, revisionId) {
      const r = row(objectKey);
      if (!r.pending || r.pending.request.revisionId !== revisionId) throw new Error('fixture-pending-mismatch');
      r.pending.state = 'resume-retry';
      events.push('ledger:retain');
      return { ok: true, verdict: 'resume-retry' };
    },
    async commitLocalPublicationIntent(objectKey, revisionId) {
      const r = row(objectKey);
      if (!r.pending || r.pending.request.revisionId !== revisionId) throw new Error('fixture-commit-mismatch');
      r.tip = {
        objectKey, revisionId,
        previousRevisionId: r.pending.request.previousRevisionId,
        revisionBlobSha256Hex: r.pending.request.revisionBlobSha256Hex,
        headSha256Hex: r.pending.request.headSha256Hex,
        payloadSha256Hex: r.pending.request.payloadSha256Hex,
        producedAtIso: SOURCE_AT
      };
      r.direction = 'published';
      r.pending = null;
      events.push(`ledger:commit:${objectKey.slice(0, 8)}`);
      return { ok: true, verdict: 'committed', tip: r.tip };
    }
  };
}

async function makeWorld({ withRelationship = true, chatApplyState = null, mode = 'manual' } = {}) {
  const source = makeSource();
  const archive = makeArchive(source);
  const fsa = createMemoryFsa();
  const events = fsa.events;
  const ledger = makeLedger(events, { chatApplyState });
  const writerKey = await writerKeyHex(LOCAL, webcrypto);
  /* Real content-only chat projection over the archive rows. */
  const projection = {
    async projectCurrent(objectId) {
      const chat = archive.chats.get(objectId);
      if (!chat) return null;
      const payload = chatPayload(objectId, chat.snapshotId, chat.text);
      const payloadText = canonicalJson(payload);
      return {
        objectId, revisionId: chat.snapshotId,
        revisionBlobSha256Hex: await sha256HexText(`v1-projection:${payloadText}`),
        payloadSha256Hex: await sha256HexText(payloadText),
        objectKeyHex: await objectKeyHex(CHAT_DOMAIN, objectId, webcrypto),
        sourceUpdatedAtIso: SOURCE_AT, payload
      };
    }
  };
  const publication = createChromeP02PublicationOwner({
    loadContainerHandle: async () => fsa.handle,
    identityProvider: { whenSyncReady: async () => ({ syncPeerId: LOCAL }) },
    configProvider: async () => ({ schemaVersion: 1, mode, configuredPeers: [] }),
    writerGenerationGate: {
      observe: async () => ({ state: generationModule.P02_GENERATION_STATE.RECORDED, generation: 'p02',
        record: { standdownAt: SOURCE_AT, decidedByWriterSyncPeerId: REMOTE } }),
      p01MayMutate: async () => ({ permitted: false, generation: 'p02', reason: 'p01-writer-stood-down' })
    },
    archiveAuthority: archive.authority,
    projection,
    syncStore: ledger,
    relationshipAuthority: withRelationship ? source.authority : null,
    observeFormat: async () => ({ gate: { mayRead: true, mayWrite: true } }),
    lockManager: { request: async (_name, _options, callback) => callback({ mode: 'exclusive' }) },
    cryptoImplementation: webcrypto,
    onTrace: (row) => events.push(`trace:${row?.result?.outcome || 'step'}`)
  });
  const enumerator = () => createChromeRelationshipObjectEnumerator({
    relationshipAuthority: source.authority, archiveAuthority: archive.authority,
    syncStore: ledger, configuredSyncPeerIds: [LOCAL], cryptoImplementation: webcrypto
  });
  const revisionFiles = () => fsa.listFiles().filter((name) => /\/objects\/[0-9a-f]{64}\/revisions\//.test(name));
  const revisionsFor = (objectKey) => fsa.listFiles().filter((name) => name.includes(`/objects/${objectKey}/revisions/`));
  const readRevision = (objectKey, blob) => JSON.parse(new TextDecoder().decode(fsa.read(`${REPOSITORY}/objects/${objectKey}/revisions/${blob}.json`)));
  const currentHeads = () => {
    const state = fsa.read(`${REPOSITORY}/writers/${writerKey}/state.json`);
    if (!state) return null;
    const pointer = JSON.parse(new TextDecoder().decode(state));
    const snapshot = JSON.parse(new TextDecoder().decode(fsa.read(`${REPOSITORY}/writers/${writerKey}/heads/${pointer.currentHeadsSnapshotSha256}.json`)));
    const heads = [];
    for (const group of snapshot.objects) {
      for (const tip of group.tips) heads.push({ objectDomain: group.objectDomain, objectId: group.objectId, objectKey: group.objectKey, ...tip });
    }
    return { writerSyncPeerId: snapshot.writerSyncPeerId, heads };
  };
  return { source, archive, fsa, events, ledger, writerKey, publication, enumerator, revisionFiles, revisionsFor, readRevision, currentHeads };
}

const folderRecord = (id, name, over = {}) => ({ id, name, kind: 'local', projectRef: null, createdAt: SOURCE_MS, updatedAt: SOURCE_MS, ...over });

/* ================================================================== */
await section('A folder authoritative-source projection', async () => {
  const one = await projectFolderCatalogState(folderRecord('f_study', 'Study'), { cryptoImplementation: webcrypto });
  check(one.eligible === true && one.eligibility === ELIG.ELIGIBLE, 'local user folder is eligible');
  check(one.objectDomain === FOLDER_DOMAIN && one.objectId === 'f_study', 'folder objectId is the verbatim H2O id');
  check(JSON.stringify(one.payload) === JSON.stringify({ createdAt: SOURCE_AT, folderId: 'f_study', name: 'Study', schema: 'h2o.studio.folderCatalogState.v1' }),
    'canonical payload = exact-key set {schema, folderId, name, createdAt} in canonical JSON key order');
  check(one.payloadText === canonicalJson(one.payload) && one.payloadSha256Hex === await sha256HexText(one.payloadText), 'payload bytes are canonical JSON and hashed exactly');
  check(one.revisionId === `relstate-${one.payloadSha256Hex}` && one.revisionBlobSha256Hex === one.payloadSha256Hex, 'deterministic local-source identity derives from the canonical state');
  check(one.sourceUpdatedAtIso === SOURCE_AT, 'sourceUpdatedAtIso from the authoritative updatedAt epoch');
  check(one.objectKeyHex === await objectKeyHex(FOLDER_DOMAIN, 'f_study', webcrypto), 'objectKey = SHA-256(folder domain || 0x00 || id)');
  const again = await projectFolderCatalogState(folderRecord('f_study', 'Study'), { cryptoImplementation: webcrypto });
  check(again.payloadText === one.payloadText && again.payloadSha256Hex === one.payloadSha256Hex, 'same source state -> byte-identical payload');
  const coloured = await projectFolderCatalogState(folderRecord('f_study', 'Study', { iconColor: '#FF0000', color: '#FF0000', sortOrder: 3, parent_id: '' }), { cryptoImplementation: webcrypto });
  check(coloured.eligible === true && coloured.payloadText === one.payloadText, 'colour / sortOrder / empty hierarchy never enter the payload (colour deferred)');
  const noCreated = await projectFolderCatalogState({ id: 'fold_chrome_ab12', name: '  Code   Review ', updatedAt: '2026-09-14T11:00:00.000Z' }, { cryptoImplementation: webcrypto });
  check(noCreated.eligible === true && !('createdAt' in noCreated.payload) && noCreated.payload.name === 'Code Review', 'createdAt optional-absent; name projected in canonical (collapsed, trimmed) form');
  check(noCreated.sourceUpdatedAtIso === '2026-09-14T11:00:00.000Z', 'ISO source timestamps are normalized, not invented');
  const idOnly = await projectFolderCatalogState({ id: 'fold_3f2504e0-4f89-41d3-9a0c-0305e82c3301', name: 'x', createdAt: SOURCE_MS }, { cryptoImplementation: webcrypto });
  check(idOnly.eligible === true && idOnly.payload.folderId === 'fold_3f2504e0-4f89-41d3-9a0c-0305e82c3301', 'fold_<uuid> ids are adopted verbatim (never minted, never slugified)');
  check((await projectFolderCatalogState({ id: 'f_nostamp', name: 'No stamp' }, { cryptoImplementation: webcrypto })).eligibility === ELIG.INVALID_SOURCE_RECORD,
    'a record without any authoritative timestamp is invalid-source-record (no wall clock)');
  check((await projectFolderCatalogState(null, { cryptoImplementation: webcrypto })).eligibility === ELIG.INVALID_SOURCE_RECORD, 'non-object record is invalid-source-record');
  check((await projectFolderCatalogState({ name: 'no id', updatedAt: 1 }, { cryptoImplementation: webcrypto })).eligibility === ELIG.INVALID_SOURCE_RECORD, 'missing id is invalid-source-record');
});

/* ================================================================== */
await section('B binding authoritative-source projection', async () => {
  const catalog = [folderRecord('f_study', 'Study'), folderRecord('fold_chrome_code', 'Code')];
  const row = { chatId: 'chat-a', folderId: 'f_study', updatedAt: SOURCE_AT };
  const bound = await projectChatFolderBinding({ chatId: 'chat-a', authoritativeBinding: { folderId: 'f_study', folderName: 'Study' }, archiveRow: row, folderCatalog: catalog, cryptoImplementation: webcrypto });
  check(bound.eligible === true && bound.objectDomain === BINDING_DOMAIN && bound.objectId === 'chat-a', 'binding objectId = canonical chatId');
  check(JSON.stringify(bound.payload) === JSON.stringify({ chatId: 'chat-a', folderId: 'f_study', schema: 'h2o.studio.chatFolderBinding.v1' }),
    'canonical binding payload = exact-key set {schema, chatId, folderId}');
  check(bound.objectKeyHex === await objectKeyHex(BINDING_DOMAIN, 'chat-a', webcrypto), 'binding objectKey uses the binding domain');
  const unfiled = await projectChatFolderBinding({ chatId: 'chat-a', authoritativeBinding: { folderId: '', folderName: '' }, archiveRow: { chatId: 'chat-a', folderId: '', updatedAt: SOURCE_AT }, folderCatalog: catalog, cryptoImplementation: webcrypto });
  check(unfiled.eligible === true && unfiled.payload.folderId === null, 'authoritative unfiled state projects folderId: null (live Unfile state)');
  check(!('folderName' in bound.payload) && !('boundAt' in bound.payload) && !('href' in bound.payload), 'folderName / boundAt / href never enter the payload');
  check(bound.sourceUpdatedAtIso === SOURCE_AT, 'head provenance from the accepted archive row, not a wall clock');
  check((await projectChatFolderBinding({ chatId: 'chat-a', authoritativeBinding: { folderId: 'f_missing' }, archiveRow: { chatId: 'chat-a', folderId: 'f_missing', updatedAt: SOURCE_AT }, folderCatalog: catalog, cryptoImplementation: webcrypto })).detail === 'referenced-folder-unknown',
    'a binding to a folder the authority does not list is invalid-source-record (never published dangling)');
  check((await projectChatFolderBinding({ chatId: ' bad', authoritativeBinding: { folderId: '' }, archiveRow: row, cryptoImplementation: webcrypto })).eligibility === ELIG.INVALID_SOURCE_RECORD, 'invalid chatId is invalid-source-record');
  check((await projectChatFolderBinding({ chatId: 'chat-a', authoritativeBinding: { error: 'relationship-source-record-threw' }, archiveRow: row, cryptoImplementation: webcrypto })).eligibility === ELIG.INVALID_SOURCE_RECORD, 'a per-chat authority failure is bounded to that chat');
});

/* ================================================================== */
await section('C legacy mirror / cache cannot become the P02 publication source', async () => {
  const world = await makeWorld();
  world.source.state.folders.push(folderRecord('f_study', 'Study'));
  world.source.state.strictTag = false; // a merged / cached / fallback-shaped result
  const listed = await world.enumerator().enumerate();
  check(listed.source.folders.status === 'source-unavailable' && listed.source.folders.code === 'relationship-source-not-strict', 'an untagged (merged/cached/fallback) result is refused as not-strict');
  check(listed.descriptors.length === 0, 'no relationship descriptor is fabricated from a non-strict result');
  /* Static: the background strict helpers read the bridge only, never the
   * cache / imported / archive-derived catalogs or the merge helper. */
  const background = read('tools/product/extensions/chatgpt/chrome/chrome-live-background.mjs');
  const strictBlock = background.slice(background.indexOf('const P02_RELATIONSHIP_SOURCE_UNAVAILABLE'), background.indexOf('async function setFolderBindingBridge('));
  check(strictBlock.includes('queryFolderBridge("getFoldersList", { strict: true }') && strictBlock.includes('queryFolderBridge("resolveFolderBindings", { chatIds: ids, strict: true }'),
    'background strict helpers call the two approved bridge read operations in strict mode');
  for (const forbidden of ['readFolderCatalogCache', 'readImportedFolderStateCatalog', 'deriveFolderCatalogFromArchiveRows', 'mergeFolderCatalogLists', 'readFolderBindingCache', 'writeFolderCatalogCache', 'writeFolderBindingCache', 'FOLDER_STATE_DATA_KEY', 'getFoldersListBridge', 'resolveFolderBindingsBridge', 'storageGet', 'storageSet']) {
    check(!strictBlock.includes(forbidden), `background strict helpers never touch ${forbidden}`);
  }
  const composition = background.slice(background.indexOf('createChromeBackgroundSyncRuntime({'), background.indexOf('__h2oBackgroundSyncRuntime.install();'));
  check(composition.includes('listFolders: () => getFoldersListStrict()') && composition.includes('resolveBindings: (chatIds) => resolveFolderBindingsStrict(chatIds)'),
    'the Sync runtime is composed with the strict helpers only');
  check(!composition.includes('getFoldersListBridge') && !composition.includes('resolveFolderBindingsBridge'), 'the merged/fallback bridge helpers are not composed into Sync');
  /* Static: the P02 modules never read chrome.storage / localStorage / legacy keys. */
  for (const file of ['packages/browser-adapters/chrome/sync-revision-domain-relationship-v2.mjs', 'packages/browser-adapters/chrome/sync-relationship-enumerator-chrome-v2.mjs', 'packages/browser-adapters/chrome/sync-p02-publication-chrome-v2.mjs']) {
    const source = stripComments(read(file));
    for (const forbidden of ['chrome.storage', 'localStorage', 'fldrs:state', 'folderCatalogCache', 'folderBindingCache', 'archiveFolder', 'folder-import', 'auto-import']) {
      check(!source.includes(forbidden), `${path.basename(file)} never references ${forbidden}`);
    }
  }
});

/* ================================================================== */
await section('D page authority unavailable -> typed source-unavailable, no fallback', async () => {
  /* The REAL page-world bridge script, hosted in a vm window with legacy
   * localStorage mirrors seeded. Strict reads must refuse them. */
  function hostBridge({ foldersApi = null, localStorageRows = {} }) {
    const listeners = [];
    const posted = [];
    const storage = new Map(Object.entries(localStorageRows));
    const window = {
      addEventListener: (type, fn) => { if (type === 'message') listeners.push(fn); },
      dispatchEvent: () => true,
      postMessage: (data) => posted.push(data),
      localStorage: { getItem: (k) => storage.has(k) ? storage.get(k) : null, setItem: (k, v) => storage.set(k, v), removeItem: (k) => storage.delete(k) },
      H2O: foldersApi ? { folders: foldersApi } : {}
    };
    window.window = window;
    const sandbox = { window, localStorage: window.localStorage, CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init?.detail; } }, console };
    vm.createContext(sandbox);
    vm.runInContext(bridgeModule.makeChromeLiveFolderBridgePageJs(), sandbox, { filename: 'folder-bridge-page.js' });
    let counter = 0;
    return {
      request(op, payload) {
        const id = `req-${counter += 1}`;
        for (const fn of listeners) fn({ source: window, data: { type: 'h2o-ext-folders:v1:req', id, req: { op, payload, nsDisk: 'h2o:prm:cgx:h2odata' } } });
        return posted.find((message) => message.id === id);
      },
      storage
    };
  }
  const legacy = { 'h2o:prm:cgx:fldrs:state:data:v1': JSON.stringify({ folders: [{ id: 'f_legacy', name: 'Legacy mirror' }] }), 'h2o:prm:cgx:h2odata:archiveFolder:chat-a:v1': JSON.stringify({ folderId: 'f_legacy', folderName: 'Legacy mirror' }) };
  const absent = hostBridge({ foldersApi: null, localStorageRows: legacy });
  const nonStrict = absent.request('getFoldersList', {});
  check(nonStrict.ok === true && nonStrict.result[0]?.id === 'f_legacy', 'control: the non-strict read still serves legacy consumers from the mirror');
  const strictAbsent = absent.request('getFoldersList', { strict: true });
  check(strictAbsent.ok === false && String(strictAbsent.error).includes('relationship-source-unavailable:h2o-folders-api-missing'), 'strict read with no H2O.folders authority is a typed source-unavailable (mirror ignored)');
  const strictBindingsAbsent = absent.request('resolveFolderBindings', { chatIds: ['chat-a'], strict: true });
  check(strictBindingsAbsent.ok === false && String(strictBindingsAbsent.error).includes('relationship-source-unavailable'), 'strict binding read with no authority is typed unavailable (archiveFolder mirror ignored)');
  const api = {
    list: () => [{ id: 'f_study', name: 'Study', kind: 'local', projectRef: null, createdAt: 1757844930123, updatedAt: 1757844930123, iconColor: '#FF0000' }, { id: 'f_proj', name: 'Proj', kind: 'project_backed', projectRef: 'g-p-1', createdAt: 1, updatedAt: 1 }],
    getBinding: (chatId) => chatId === 'chat-a' ? { folderId: 'f_study', folderName: 'Study' } : { folderId: '', folderName: '' }
  };
  const present = hostBridge({ foldersApi: api, localStorageRows: legacy });
  const strictList = present.request('getFoldersList', { strict: true });
  check(strictList.ok === true && strictList.result.source === 'H2O.folders' && strictList.result.strict === true, 'strict list is tagged as the H2O.folders authority');
  check(strictList.result.folders.length === 2 && strictList.result.folders[0].id === 'f_study' && strictList.result.folders[0].kind === 'local' && strictList.result.folders[0].updatedAt === 1757844930123 && strictList.result.folders[1].projectRef === 'g-p-1',
    'strict list carries the verbatim authority fields (id, name, kind, projectRef, createdAt, updatedAt)');
  check(!('iconColor' in strictList.result.folders[0]) && !strictList.result.folders.some((f) => f.id === 'f_legacy'), 'strict list carries no colour and nothing from the mirror');
  const strictBindings = present.request('resolveFolderBindings', { chatIds: ['chat-a', 'chat-b'], strict: true });
  check(strictBindings.ok === true && strictBindings.result.strict === true && strictBindings.result.bindings['chat-a'].folderId === 'f_study' && strictBindings.result.bindings['chat-b'].folderId === '',
    'strict bindings come from H2O.folders.getBinding only ("" = unfiled)');
  const legacyOnlyBinding = hostBridge({ foldersApi: { list: () => [], getBinding: () => ({ folderId: '', folderName: '' }) }, localStorageRows: legacy });
  check(legacyOnlyBinding.request('resolveFolderBindings', { chatIds: ['chat-a'], strict: true }).result.bindings['chat-a'].folderId === '', 'strict binding read ignores the archiveFolder mirror even when the authority says unfiled');
  const partial = hostBridge({ foldersApi: { list: () => [] }, localStorageRows: {} });
  check(String(partial.request('resolveFolderBindings', { chatIds: ['chat-a'], strict: true }).error).includes('relationship-source-unavailable:h2o-folders-get-binding-missing'), 'authority without getBinding is typed unavailable');
  /* Enumerator + owner: a source failure yields typed status, zero relationship
   * descriptors, and the chat family stays publishable. */
  const world = await makeWorld();
  world.archive.chats.set('chat-a', { text: 'hello', snapshotId: 'snap-a-1' });
  world.source.state.listFailure = Object.assign(new Error('relationship-source-unavailable:no-chatgpt-tab'), { code: 'relationship-source-unavailable' });
  const listed = await world.enumerator().enumerate();
  check(listed.source.folders.status === 'source-unavailable' && listed.source.folders.code === 'relationship-source-unavailable' && listed.descriptors.length === 0 && listed.ineligible.length === 0, 'enumerator: unavailable source -> typed status, nothing fabricated');
  const published = await world.publication.publishManual();
  check(published.outcome === 'published' && published.selectedObjectDomain === CHAT_DOMAIN && published.relationshipSource?.folders?.status === 'source-unavailable',
    'owner: a relationship source failure does not break saved-chat publication');
  world.source.state.listFailure = null;
  world.source.state.bindingFailure = Object.assign(new Error('relationship-source-unavailable:bridge-timeout'), { code: 'relationship-source-unavailable' });
  world.source.state.folders.push(folderRecord('f_study', 'Study'));
  const partialList = await world.enumerator().enumerate();
  check(partialList.source.folders.status === 'available' && partialList.source.bindings.status === 'source-unavailable' && partialList.descriptors.length === 1 && partialList.descriptors[0].objectDomain === FOLDER_DOMAIN,
    'per-family failure is bounded: folders enumerate while bindings are typed unavailable');
});

/* ================================================================== */
await section('E project_backed / system / reserved folders are ineligible', async () => {
  const cases = [
    [folderRecord('f_proj', 'Proj', { kind: 'project_backed', projectRef: 'g-p-1' }), ELIG.NOT_ELIGIBLE_PROJECT_BACKED],
    [folderRecord('f_ref', 'Ref', { projectRef: 'g-p-2' }), ELIG.NOT_ELIGIBLE_PROJECT_BACKED],
    [folderRecord('f_sys', 'Sys', { kind: 'system' }), ELIG.NOT_ELIGIBLE_SYSTEM],
    [folderRecord('f_virt', 'Virtual', { virtual: true }), ELIG.NOT_ELIGIBLE_SYSTEM],
    [folderRecord('f_view', 'View', { kind: 'view' }), ELIG.NOT_ELIGIBLE_SYSTEM],
    [folderRecord('f_child', 'Child', { parentId: 'f_root' }), ELIG.NOT_ELIGIBLE_SYSTEM],
    [folderRecord('f_child2', 'Child', { parent_id: 'f_root' }), ELIG.NOT_ELIGIBLE_SYSTEM],
    [folderRecord('f_other', 'Other', { kind: 'shared' }), ELIG.NOT_ELIGIBLE_SYSTEM],
    [folderRecord('unfiled', 'Unfiled'), ELIG.NOT_ELIGIBLE_RESERVED],
    [folderRecord('f_pinned', 'Pinned'), ELIG.NOT_ELIGIBLE_RESERVED],
    [folderRecord('f_archive', 'ARCHIVE'), ELIG.NOT_ELIGIBLE_RESERVED],
    [folderRecord('f_unfiled_name', 'unfiled'), ELIG.NOT_ELIGIBLE_RESERVED],
    [folderRecord('f/bad', 'Bad id'), ELIG.CONTRACT_INVALID],
    [folderRecord('f_' + 'a'.repeat(159), 'Too long id'), ELIG.CONTRACT_INVALID],
    [folderRecord('f_empty', '   '), ELIG.CONTRACT_INVALID],
    [folderRecord('f_long', '\u{1F600}'.repeat(201)), ELIG.CONTRACT_INVALID]
  ];
  for (const [record, expected] of cases) {
    const result = await projectFolderCatalogState(record, { cryptoImplementation: webcrypto });
    check(result.eligible === false && result.eligibility === expected, `${record.id}: ${expected} (got ${result.eligibility}:${result.detail})`);
  }
  /* A binding into an ineligible or unknown folder never publishes either. */
  const catalog = [folderRecord('f_proj', 'Proj', { kind: 'project_backed', projectRef: 'g-p-1' })];
  const intoProject = await projectChatFolderBinding({ chatId: 'chat-a', authoritativeBinding: { folderId: 'f_proj' }, archiveRow: { folderId: 'f_proj', updatedAt: SOURCE_AT }, folderCatalog: catalog, cryptoImplementation: webcrypto });
  check(intoProject.eligibility === ELIG.NOT_ELIGIBLE_PROJECT_BACKED, 'binding into a project-backed folder inherits the typed ineligibility');
  /* Enumerator: typed entries, never exceptions, chat subjects untouched. */
  const world = await makeWorld();
  world.source.state.folders.push(folderRecord('f_study', 'Study'), folderRecord('f_proj', 'Proj', { kind: 'project_backed', projectRef: 'g-p-1' }), folderRecord('unfiled', 'Unfiled'), { name: 'no-id', updatedAt: 1 });
  const listed = await world.enumerator().enumerate();
  check(listed.descriptors.length === 1 && listed.descriptors[0].objectId === 'f_study', 'enumerator emits only the eligible folder');
  check(listed.ineligible.map((e) => `${e.objectId}:${e.eligibility}`).join('|') === 'f_proj:not-eligible(project-backed)|null:invalid-source-record|unfiled:not-eligible(reserved)',
    `enumerator lists typed ineligibility (${listed.ineligible.map((e) => `${e.objectId}:${e.eligibility}`).join('|')})`);
});

/* ================================================================== */
await section('F/G payload strictness reused from T01', async () => {
  const adapterSource = read('packages/browser-adapters/chrome/sync-revision-domain-relationship-v2.mjs');
  check(adapterSource.includes("from '../../core/sync-relationship-domains-v2.mjs'") && adapterSource.includes('validateFolderCatalogStatePayload(payload, objectId)') && adapterSource.includes('validateChatFolderBindingPayload(payload, objectId)'),
    'adapters validate every projected payload with the T01 strict validators');
  const vectors = JSON.parse(read('tools/validation/sync/fixtures/p02-relationship-contract-vectors.json'));
  /* Production refuses any payload the T01 validator refuses. */
  for (const v of vectors.folder.negative.slice(0, 12)) {
    const code = await codeOf(() => produceRelationshipRevisionV2({ objectDomain: FOLDER_DOMAIN, canonicalObject: { objectId: v.objectId || 'f_x', revisionId: `p02-${'a'.repeat(32)}`, payload: v.payload }, writerSyncPeerId: LOCAL, cryptoImplementation: webcrypto }));
    check(code === 'p02-t02-relationship-payload-not-canonical', `folder negative vector refused at production: ${v.id} (${code})`);
  }
  for (const v of vectors.binding.negative.slice(0, 10)) {
    const code = await codeOf(() => produceRelationshipRevisionV2({ objectDomain: BINDING_DOMAIN, canonicalObject: { objectId: v.objectId || 'chat-x', revisionId: `p02-${'a'.repeat(32)}`, payload: v.payload }, writerSyncPeerId: LOCAL, cryptoImplementation: webcrypto }));
    check(code === 'p02-t02-relationship-payload-not-canonical', `binding negative vector refused at production: ${v.id} (${code})`);
  }
  for (const v of vectors.folder.positive.slice(0, 3)) {
    const produced = await produceRelationshipRevisionV2({ objectDomain: FOLDER_DOMAIN, canonicalObject: { objectId: v.objectId, revisionId: `p02-${'b'.repeat(32)}`, payload: v.payload }, writerSyncPeerId: LOCAL, cryptoImplementation: webcrypto });
    check(produced.ok === true && produced.isRoot === true && produced.objectDomain === FOLDER_DOMAIN && produced.revision.previousRevisionId === null && produced.adapterSchema === adapter.P02_RELATIONSHIP_DOMAIN_V2.FOLDER.ADAPTER_SCHEMA,
      `folder positive vector produces a v2 root revision: ${v.id}`);
    const validated = await contract.validateContractDocument({ kind: 'revision', bytes: produced.canonicalBytes, expectedBlobSha256: produced.revisionBlobSha256, cryptoImplementation: webcrypto });
    check(validated.ok === true && validated.value.objectDomain === FOLDER_DOMAIN, `produced folder revision validates against the frozen v2 contract: ${v.id}`);
  }
  check(await codeOf(() => produceRelationshipRevisionV2({ objectDomain: CHAT_DOMAIN, canonicalObject: { objectId: 'c', revisionId: 'p02-x', payload: {} }, writerSyncPeerId: LOCAL, cryptoImplementation: webcrypto })) === 'p02-t02-relationship-domain-unregistered',
    'the relationship adapter never produces a chat revision');
  const withColour = await codeOf(() => produceRelationshipRevisionV2({ objectDomain: FOLDER_DOMAIN, canonicalObject: { objectId: 'f_c', revisionId: `p02-${'c'.repeat(32)}`, payload: { schema: 'h2o.studio.folderCatalogState.v1', folderId: 'f_c', name: 'C', color: '#ff0000' } }, writerSyncPeerId: LOCAL, cryptoImplementation: webcrypto }));
  check(withColour === 'p02-t02-relationship-payload-not-canonical', 'colour is refused at production (COLOR_ADMISSION deferred)');
});

/* ================================================================== */
await section('H archive source disagreement fails closed', async () => {
  const catalog = [folderRecord('f_study', 'Study'), folderRecord('fold_chrome_code', 'Code')];
  const disagree = await projectChatFolderBinding({ chatId: 'chat-a', authoritativeBinding: { folderId: 'f_study' }, archiveRow: { chatId: 'chat-a', folderId: 'fold_chrome_code', updatedAt: SOURCE_AT }, folderCatalog: catalog, cryptoImplementation: webcrypto });
  check(disagree.eligible === false && disagree.eligibility === ELIG.NOT_ELIGIBLE_BINDING_SOURCE_DISAGREEMENT, 'authority Study vs archive Code -> typed disagreement, no winner guessed');
  const staleStamp = await projectChatFolderBinding({ chatId: 'chat-a', authoritativeBinding: { folderId: '' }, archiveRow: { chatId: 'chat-a', folderId: 'f_study', updatedAt: SOURCE_AT }, folderCatalog: catalog, cryptoImplementation: webcrypto });
  check(staleStamp.eligibility === ELIG.NOT_ELIGIBLE_BINDING_SOURCE_DISAGREEMENT, 'authority unfiled vs stale archive stamp -> typed disagreement');
  const noStamp = await projectChatFolderBinding({ chatId: 'chat-a', authoritativeBinding: { folderId: 'f_study' }, archiveRow: { chatId: 'chat-a', updatedAt: SOURCE_AT }, folderCatalog: catalog, cryptoImplementation: webcrypto });
  check(noStamp.eligible === true, 'a row without a stamp offers no cross-check and does not block');
  const nameDrift = await projectChatFolderBinding({ chatId: 'chat-a', authoritativeBinding: { folderId: 'f_study', folderName: 'Study renamed' }, archiveRow: { chatId: 'chat-a', folderId: 'f_study', folderName: 'Study', updatedAt: SOURCE_AT }, folderCatalog: catalog, cryptoImplementation: webcrypto });
  check(nameDrift.eligible === true, 'folderName drift after a rename is not a disagreement (id is the cross-check)');
  /* Through the owner: a disagreeing binding never reaches the repository. */
  const world = await makeWorld();
  world.source.state.folders.push(folderRecord('f_study', 'Study'));
  world.archive.chats.set('chat-a', { text: 'hello', snapshotId: 'snap-a-1' });
  world.source.state.bindings.set('chat-a', 'f_study');
  world.archive.stamp('chat-a', 'fold_chrome_code');
  const listed = await world.enumerator().enumerate();
  check(listed.ineligible.some((e) => e.objectDomain === BINDING_DOMAIN && e.objectId === 'chat-a' && e.eligibility === ELIG.NOT_ELIGIBLE_BINDING_SOURCE_DISAGREEMENT), 'enumerator reports the disagreement');
  let outcomes = [];
  for (let attempt = 0; attempt < 4; attempt += 1) outcomes.push((await world.publication.publishManual()).selectedObjectDomain);
  check(outcomes.filter(Boolean).join(',') === `${FOLDER_DOMAIN},${CHAT_DOMAIN}`, `only the folder and the chat publish; the disagreeing binding never does (${outcomes.join(',')})`);
  check(world.revisionsFor(await objectKeyHex(BINDING_DOMAIN, 'chat-a', webcrypto)).length === 0, 'no binding revision exists in the repository');
});

/* ================================================================== */
/* I..N, O, P, Q, R: the real owner over a memory repository            */
/* ================================================================== */
/* The chat object already carries an APPLIED P02 anchor authored by the remote
 * Desktop peer (its bytes sit in the repository), exactly like a chat that was
 * received before being edited locally. The binding shares its objectId and
 * must never inherit that anchor. */
const appliedChatRoot = await chatAdapter.produceChatRevisionV2({
  canonicalObject: { objectId: 'chat-a', revisionId: `p02-${'0'.repeat(32)}`, payload: chatPayload('chat-a', 'snap-a-0', 'received from Desktop') },
  writerSyncPeerId: REMOTE, cryptoImplementation: webcrypto
});
const t = await makeWorld({ chatApplyState: { pending: null, lastApplied: { revisionId: appliedChatRoot.revisionId, revisionBlobSha256Hex: appliedChatRoot.revisionBlobSha256, payloadSha256Hex: appliedChatRoot.payloadSha256 } } });
const studyKey = await objectKeyHex(FOLDER_DOMAIN, 'f_study', webcrypto);
const codeKey = await objectKeyHex(FOLDER_DOMAIN, 'fold_chrome_code', webcrypto);
const chatKey = await objectKeyHex(CHAT_DOMAIN, 'chat-a', webcrypto);
const bindingKey = await objectKeyHex(BINDING_DOMAIN, 'chat-a', webcrypto);
t.fsa.put(`${REPOSITORY}/objects/${chatKey}/revisions/${appliedChatRoot.revisionBlobSha256}.json`, appliedChatRoot.canonicalBytes);
const results = [];
const publish = async () => { const r = await t.publication.publishManual(); results.push(r); return r; };

await section('Q multi-candidate deterministic one-object-per-attempt sequencing', async () => {
  t.source.state.folders.push(folderRecord('fold_chrome_code', 'Code'), folderRecord('f_study', 'Study'));
  t.archive.chats.set('chat-a', { text: 'hello', snapshotId: 'snap-a-1' });
  t.source.state.bindings.set('chat-a', 'f_study');
  const listed = await t.enumerator().enumerate();
  check(listed.descriptors.length === 3 && listed.descriptors.every((d) => d.dirty && d.publishable), 'two folders and one binding enumerate dirty and publishable');
  check(t.ledger.applyReads.length === 0, 'relationship enumeration never read the objectId-keyed apply store');
  const order = [...listed.descriptors, { objectDomain: CHAT_DOMAIN, objectId: 'chat-a', objectKey: chatKey }].sort(compareCandidateDescriptors).map((d) => `${d.objectDomain}:${d.objectId}`);
  check(order.join('|') === `${FOLDER_DOMAIN}:f_study|${FOLDER_DOMAIN}:fold_chrome_code|${CHAT_DOMAIN}:chat-a|${BINDING_DOMAIN}:chat-a`,
    `deterministic order: folders (by id) -> chat -> binding (${order.join('|')})`);
  check(P02_CHROME_PUBLICATION_V2.CANDIDATE_SEQUENCING === 'deterministic-one-object-per-attempt', 'sequencing posture is named');

  const first = await publish();
  check(first.outcome === 'published' && first.selectedObjectDomain === FOLDER_DOMAIN && first.selectedObjectId === 'f_study' && first.eligibleCount === 4,
    `attempt 1 publishes exactly the first candidate with 3 deferred (${first.outcome}/${first.selectedObjectId}/${first.eligibleCount})`);
  check(first.deferredCandidates.length === 3 && first.deferredCandidates[0].objectId === 'fold_chrome_code', 'deferred candidates are reported, not treated as ambiguous');
  check(t.revisionFiles().length === 2 && t.revisionsFor(studyKey).length === 1, 'one new repository revision after one attempt (plus the pre-existing applied chat root)');
  const second = await publish();
  check(second.outcome === 'published' && second.selectedObjectId === 'fold_chrome_code' && second.eligibleCount === 3, 'attempt 2 takes the next due candidate');
  const third = await publish();
  check(third.outcome === 'published' && third.selectedObjectDomain === CHAT_DOMAIN && third.eligibleCount === 2, 'attempt 3 publishes the chat');
  const fourth = await publish();
  check(fourth.outcome === 'published' && fourth.selectedObjectDomain === BINDING_DOMAIN && fourth.selectedObjectId === 'chat-a' && fourth.eligibleCount === 1, 'attempt 4 publishes the binding');
  const fifth = await publish();
  check(fifth.outcome === 'no-eligible-local-change' && fifth.eligibleCount === 0, 'attempt 5 finds everything converged');
  check(t.revisionFiles().length === 5, 'four new revisions, one per object, no concurrent or duplicate publication');
  check(results.slice(0, 4).every((r) => MINT_RE.test(r.mintedRevisionId)) && new Set(results.slice(0, 4).map((r) => r.mintedRevisionId)).size === 4, 'each publication used a fresh engine mint');
  const heads = t.currentHeads();
  check(heads.heads.length === 4 && heads.writerSyncPeerId === LOCAL, 'the writer heads snapshot advertises all four objects');
  check(t.ledger.applyReads.every((id) => id === 'chat-a') && t.ledger.applyReads.length > 0, 'only the chat object ever read the apply store');
});

await section('I folder root composition', async () => {
  const [blob] = t.revisionsFor(studyKey).map((name) => path.basename(name, '.json'));
  const revision = t.readRevision(studyKey, blob);
  check(revision.schema === 'h2o.studio.syncRevision.v2' && revision.objectDomain === FOLDER_DOMAIN && revision.objectId === 'f_study' && revision.writerSyncPeerId === LOCAL, 'folder root is a v2 envelope of the folder domain');
  check(revision.previousRevisionId === null && revision.previousRevisionBlobSha256 === null, 'folder root has a null parent pair');
  check(JSON.stringify(revision.payload) === JSON.stringify({ createdAt: SOURCE_AT, folderId: 'f_study', name: 'Study', schema: 'h2o.studio.folderCatalogState.v1' }), 'folder root payload is the canonical folder state');
  check(revision.payloadSha256 === await sha256HexText(canonicalJson(revision.payload)), 'payload hash matches canonical bytes');
  const head = t.currentHeads().heads.find((h) => h.objectKey === studyKey);
  check(head?.objectDomain === FOLDER_DOMAIN && head.revisionId === revision.revisionId && head.previousRevisionId === null && head.sourceUpdatedAtIso === SOURCE_AT, 'folder head names the root with the source timestamp');
  check((await contract.validateContractDocument({ kind: 'revision', bytes: t.fsa.read(`${REPOSITORY}/objects/${studyKey}/revisions/${blob}.json`), expectedBlobSha256: blob, cryptoImplementation: webcrypto })).ok === true, 'root bytes validate against the frozen contract at their address');
});

await section('J binding root composition', async () => {
  const [blob] = t.revisionsFor(bindingKey).map((name) => path.basename(name, '.json'));
  const revision = t.readRevision(bindingKey, blob);
  check(revision.objectDomain === BINDING_DOMAIN && revision.objectId === 'chat-a' && revision.previousRevisionId === null, 'binding root is a v2 root of the binding domain with the chat objectId');
  check(JSON.stringify(revision.payload) === JSON.stringify({ chatId: 'chat-a', folderId: 'f_study', schema: 'h2o.studio.chatFolderBinding.v1' }), 'binding root payload is the canonical binding state');
  check(revision.previousRevisionId === null && revision.previousRevisionBlobSha256 !== appliedChatRoot.revisionBlobSha256, 'binding root did not descend from the chat object\'s applied anchor');
  const chatRevision = t.readRevision(chatKey, path.basename(t.revisionsFor(chatKey).find((n) => !n.endsWith(`${appliedChatRoot.revisionBlobSha256}.json`)), '.json'));
  check(chatRevision.previousRevisionId === appliedChatRoot.revisionId && chatRevision.previousRevisionBlobSha256 === appliedChatRoot.revisionBlobSha256, 'control: the chat object itself DID descend from its applied anchor');
});

await section('K folder rename descendant', async () => {
  t.source.state.folders.find((f) => f.id === 'f_study').name = 'Study Notes';
  t.source.state.folders.find((f) => f.id === 'f_study').updatedAt = Date.parse(RENAME_AT);
  const renamed = await publish();
  check(renamed.outcome === 'published' && renamed.selectedObjectId === 'f_study' && renamed.eligibleCount === 1, 'rename makes only the folder eligible again');
  const blobs = t.revisionsFor(studyKey).map((name) => path.basename(name, '.json'));
  check(blobs.length === 2, 'the folder now has root + descendant');
  const revisions = blobs.map((blob) => t.readRevision(studyKey, blob));
  const root = revisions.find((r) => r.previousRevisionId === null);
  const child = revisions.find((r) => r.previousRevisionId !== null);
  check(child.previousRevisionId === root.revisionId && child.previousRevisionBlobSha256 === sha256(t.fsa.read(`${REPOSITORY}/objects/${studyKey}/revisions/${blobs.find((b) => t.readRevision(studyKey, b).previousRevisionId === null)}.json`)),
    'descendant names the root by id and blob address');
  check(child.objectId === 'f_study' && child.payload.name === 'Study Notes' && child.payload.folderId === 'f_study' && child.payload.createdAt === SOURCE_AT, 'rename keeps identity and createdAt; only name changes');
  const head = t.currentHeads().heads.find((h) => h.objectKey === studyKey);
  check(head.revisionId === child.revisionId && head.previousRevisionId === root.revisionId && head.sourceUpdatedAtIso === RENAME_AT, 'head advanced to the descendant with the new source timestamp');
});

await section('L binding move descendant (Study -> Code, Code -> Study)', async () => {
  t.source.state.bindings.set('chat-a', 'fold_chrome_code');
  const moved = await publish();
  check(moved.outcome === 'published' && moved.selectedObjectDomain === BINDING_DOMAIN && moved.eligibleCount === 1, 'move makes only the binding eligible');
  const afterMove = t.revisionsFor(bindingKey).map((b) => t.readRevision(bindingKey, path.basename(b, '.json')));
  const moveRevision = afterMove.find((r) => r.payload.folderId === 'fold_chrome_code');
  const bindingRoot = afterMove.find((r) => r.previousRevisionId === null);
  check(afterMove.length === 2 && moveRevision.previousRevisionId === bindingRoot.revisionId && moveRevision.objectId === 'chat-a', 'Study -> Code is a descendant of the binding root with the same chat objectId');
  t.source.state.bindings.set('chat-a', 'f_study');
  const back = await publish();
  check(back.outcome === 'published' && back.selectedObjectDomain === BINDING_DOMAIN, 'Code -> Study publishes again');
  const afterBack = t.revisionsFor(bindingKey).map((b) => t.readRevision(bindingKey, path.basename(b, '.json')));
  const backRevision = afterBack.find((r) => r.previousRevisionId === moveRevision.revisionId);
  check(afterBack.length === 3 && backRevision?.payload.folderId === 'f_study', 'Code -> Study descends from the move revision (lineage preserved, no root re-mint)');
  check(t.revisionsFor(chatKey).length === 2, 'moving the binding never re-published the chat object (applied root + one local descendant)');
});

await section('M Unfile descendant with folderId null', async () => {
  t.source.state.bindings.set('chat-a', '');
  const unfiled = await publish();
  check(unfiled.outcome === 'published' && unfiled.selectedObjectDomain === BINDING_DOMAIN, 'Unfile publishes a binding revision');
  const revisions = t.revisionsFor(bindingKey).map((b) => t.readRevision(bindingKey, path.basename(b, '.json')));
  const unfile = revisions.find((r) => r.payload.folderId === null);
  check(!!unfile && unfile.previousRevisionId !== null && Object.keys(unfile.payload).sort().join(',') === 'chatId,folderId,schema' && !('closureType' in unfile), 'Unfile is a LIVE descendant with folderId: null, not a closure and not object-deleted');
  check(revisions.every((r) => !('closureType' in r)), 'no closure revision was ever produced');
});

await section('N identical relationship state -> no new revision', async () => {
  const before = t.revisionFiles().length;
  const listed = await t.enumerator().enumerate();
  check(listed.descriptors.every((d) => d.dirty === false && d.publishable === false), 'converged relationship descriptors are not dirty');
  const again = await publish();
  check(again.outcome === 'no-eligible-local-change' && t.revisionFiles().length === before, 'repeated identical state publishes nothing (not local-ahead)');
  t.source.state.folders.find((f) => f.id === 'f_study').updatedAt = Date.parse('2026-09-14T10:33:10.123Z'); // touched timestamp, same state
  const touched = await publish();
  check(touched.outcome === 'no-eligible-local-change' && t.revisionFiles().length === before, 'a timestamp-only change with identical canonical state is not a new revision');
});

await section('O same-name / different-id folders stay distinct', async () => {
  t.source.state.folders.push(folderRecord('f_study_2', 'Study Notes'));
  const listed = await t.enumerator().enumerate();
  const sameName = listed.descriptors.filter((d) => d.objectDomain === FOLDER_DOMAIN);
  check(sameName.length === 3 && new Set(sameName.map((d) => d.objectKey)).size === 3, 'three folder objects, three objectKeys');
  const dup = await publish();
  check(dup.outcome === 'published' && dup.selectedObjectId === 'f_study_2', 'the second "Study Notes" folder publishes as its own object');
  const dupKey = await objectKeyHex(FOLDER_DOMAIN, 'f_study_2', webcrypto);
  const dupRevision = t.readRevision(dupKey, path.basename(t.revisionsFor(dupKey)[0], '.json'));
  check(dupRevision.payload.folderId === 'f_study_2' && dupRevision.payload.name === 'Study Notes' && dupRevision.previousRevisionId === null, 'same name, different id, separate root; never merged by name');
});

await section('P same chat objectId across chat / binding domains stays separate', async () => {
  check(chatKey !== bindingKey, 'chat and binding objectKeys differ for objectId chat-a');
  const heads = t.currentHeads().heads;
  check(heads.filter((h) => h.objectId === 'chat-a').length === 2 && heads.some((h) => h.objectId === 'chat-a' && h.objectDomain === CHAT_DOMAIN) && heads.some((h) => h.objectId === 'chat-a' && h.objectDomain === BINDING_DOMAIN),
    'the heads snapshot carries chat-a twice, once per domain');
  check(t.ledger.rows.get(chatKey).tip.revisionId !== t.ledger.rows.get(bindingKey).tip.revisionId, 'the ledger keeps separate tips per objectKey');
  const bindingRevisions = t.revisionsFor(bindingKey).map((b) => t.readRevision(bindingKey, path.basename(b, '.json')));
  check(bindingRevisions.every((r) => r.objectDomain === BINDING_DOMAIN && r.previousRevisionId !== appliedChatRoot.revisionId && r.previousRevisionBlobSha256 !== appliedChatRoot.revisionBlobSha256), 'no binding revision descends from the chat object\'s applied anchor');
  /* Pending-recovery domain derivation: the same objectId resolves to the
   * right family from the objectKey alone. */
  const pubSource = read('packages/browser-adapters/chrome/sync-p02-publication-chrome-v2.mjs');
  check(pubSource.includes('async function domainForPending(objectId, objectKey)') && pubSource.includes('const pendingDomain = await domainForPending(request.objectId, request.objectKey);'), 'pending recovery derives the family from objectKey, never assumes chat');
});

await section('R existing chat publication remains green (bytes identical)', async () => {
  const chatBlob = t.revisionsFor(chatKey).map((name) => path.basename(name, '.json')).find((blob) => blob !== appliedChatRoot.revisionBlobSha256);
  const chatRevision = t.readRevision(chatKey, chatBlob);
  const expectedPayload = chatPayload('chat-a', 'snap-a-1', 'hello');
  check(chatRevision.objectDomain === CHAT_DOMAIN && canonicalJson(chatRevision.payload) === canonicalJson(expectedPayload), 'the chat revision payload is the content-only fullBundle.v2, byte-identical to the projection');
  check(chatRevision.payload.schema === 'h2o.studio.fullBundle.v2' && JSON.stringify(chatRevision.payload.chatArchive.chats[0].chatIndex.organization) === '{}', 'organization stays empty; schema unchanged');
  check(!JSON.stringify(chatRevision.payload).includes('folderId') && !JSON.stringify(chatRevision.payload).includes('folderBinding') && !JSON.stringify(chatRevision.payload).includes('chatFolderBinding'), 'no folderId / folderBinding / relationship metadata in the chat payload or turns');
  /* The chat adapter alone produces byte-identical output for the same payload. */
  const reproduced = await chatAdapter.produceChatRevisionV2({ canonicalObject: { objectId: 'chat-a', revisionId: chatRevision.revisionId, payload: expectedPayload }, writerSyncPeerId: LOCAL, p02Parent: { previousRevisionId: appliedChatRoot.revisionId, previousRevisionBlobSha256: appliedChatRoot.revisionBlobSha256, provenP02Parent: true }, cryptoImplementation: webcrypto });
  check(reproduced.revisionBlobSha256 === chatBlob && reproduced.payloadSha256 === chatRevision.payloadSha256, 'chat revision bytes/hash unchanged by relationship publication');
  check(t.revisionsFor(chatKey).length === 2, 'exactly one locally authored chat revision after six relationship publications');
  /* Domain constants unchanged. */
  check(chatAdapter.P02_CHAT_DOMAIN_V2.OBJECT_DOMAIN === CHAT_DOMAIN && chatAdapter.P02_CHAT_DOMAIN_V2.PAYLOAD_SCHEMA === 'h2o.studio.fullBundle.v2', 'chat domain constants unchanged');
  /* Without a relationship authority the owner is the accepted chat-only owner. */
  const chatOnly = await makeWorld({ withRelationship: false });
  chatOnly.archive.chats.set('chat-z', { text: 'zeta', snapshotId: 'snap-z-1' });
  const published = await chatOnly.publication.publishManual();
  check(published.outcome === 'published' && published.selectedObjectDomain === CHAT_DOMAIN && published.relationshipSource === null && chatOnly.publication.diagnose().relationshipSource === 'not-composed',
    'without a relationship authority the owner publishes the chat family exactly as before');
  const chatOnlyAgain = await chatOnly.publication.publishManual();
  check(chatOnlyAgain.outcome === 'no-eligible-local-change', 'chat-only owner converges');
});

/* ================================================================== */
await section('S no native ChatGPT mutation path', async () => {
  const files = [
    'packages/browser-adapters/chrome/sync-revision-domain-relationship-v2.mjs',
    'packages/browser-adapters/chrome/sync-relationship-enumerator-chrome-v2.mjs',
    'packages/browser-adapters/chrome/sync-p02-publication-chrome-v2.mjs',
    'packages/browser-adapters/chrome/sync-p02-domain-protocol-state-chrome-v2.mjs',
    'packages/core/sync-relationship-domains-v2.mjs'
  ];
  const forbidden = ['moveChatToProject', 'PROJECTS_executeNativeMove', 'setFolderBinding', 'setFolderIconColor', 'setBinding(', 'H2O.projects', 'backend-api', 'fetch(', 'XMLHttpRequest', 'chrome.tabs', 'chrome.runtime', 'FolderCommands', 'upsertLatestSnapshotMeta', 'importFullBundle', 'stageApplyIntent', 'commitApplyIntent', 'recordObservation'];
  for (const file of files) {
    const source = read(file);
    for (const token of forbidden) check(!source.includes(token), `${path.basename(file)} contains no ${token}`);
  }
  const background = read('tools/product/extensions/chatgpt/chrome/chrome-live-background.mjs');
  const strictBlock = background.slice(background.indexOf('const P02_RELATIONSHIP_SOURCE_UNAVAILABLE'), background.indexOf('async function setFolderBindingBridge('));
  for (const token of ['setFolderBinding', 'setFolderIconColor', 'moveChatToProject', 'PROJECTS_executeNativeMove', 'importFullBundle', 'storageSet']) {
    check(!strictBlock.includes(token), `background strict helpers contain no ${token}`);
  }
  const bridge = bridgeModule.makeChromeLiveFolderBridgePageJs();
  const strictBridge = bridge.slice(bridge.indexOf('P02 T02 strict reads'), bridge.indexOf('function setFolderIconColor('));
  for (const token of ['setBinding(', 'setFolderIconColor', 'writeJson(', 'localStorage.setItem', 'removeItem', 'dispatchEvent', 'archiveBoot', 'upsertLatestSnapshotMeta', 'tryLoadFoldersFallback', 'keyArchiveFolder']) {
    check(!strictBridge.includes(token), `page-bridge strict reads contain no ${token}`);
  }
  check(t.source.state.calls.every((call) => call === 'listFolders' || call.startsWith('resolveBindings:')), 'the owner only ever called the two read operations on the relationship source');
  check(P02_CHROME_PUBLICATION_V2.NON_CHAT_RECEIVE === 'disabled-until-domain-qualified-idb-state', 'non-chat receive stays disabled');
  const reconcile = read('packages/browser-adapters/chrome/sync-background-reconcile.mjs');
  check(!reconcile.includes('relationshipAuthority.listFolders(') && !reconcile.includes('relationshipAuthority.resolveBindings('), 'the background runtime hands the relationship authority to the owner and never reads it itself');
  check(reconcile.includes('relationshipAuthority = null') && reconcile.includes('relationshipAuthority,\n    lockManager,'), 'runtime composes the optional relationship authority into the publication owner');
});

/* ================================================================== */
await section('T no live repository mutation by these tests', async () => {
  check(t.fsa.listFiles().every((name) => name.startsWith(`${REPOSITORY}/`)), 'every write landed in the memory repository fixture');
  check(!fs.existsSync(path.join(process.env.HOME || '/nonexistent', 'H2O Studio Sync', 'h2o-object-sync', 'writers', t.writerKey)), 'no writer directory for the fixture peer exists in the live Sync folder');
  const pubSource = read('packages/browser-adapters/chrome/sync-p02-publication-chrome-v2.mjs');
  check(!pubSource.includes('setTimeout') && !pubSource.includes('setInterval') && !pubSource.includes('chrome.alarms'), 'the owner arms no automatic loop of its own');
  check(pubSource.includes("FIRST_PUBLICATION: 'trusted-human-manual-only'") && pubSource.includes("if (!manual && !descriptor.protocolState?.lastPublished) continue;"), 'first publications of every family remain trusted-human-manual; automatic wakes advance committed chains only');
});

/* ------------------------------------------------------------------ */
const verdict = failures.length === 0 ? 'CHROME_RELATIONSHIP_PUBLICATION_PASS' : 'CHROME_RELATIONSHIP_PUBLICATION_NOT_READY';
console.log(JSON.stringify({
  schema: 'h2o.studio.p02ChromeRelationshipPublicationValidation.v1',
  mission: 'p02-folder-relationship-synchronization',
  task: 'T02',
  verdict,
  assertions,
  sections,
  failures,
  publications: results.map((r) => ({ outcome: r.outcome, objectDomain: r.selectedObjectDomain ?? null, objectId: r.selectedObjectId ?? null, eligibleCount: r.eligibleCount })),
  directionCoverage: 'RELATIONSHIP_SYNC_DIRECTION_COVERAGE=CHROME_TO_DESKTOP_ONLY',
  liveMutation: 'none (memory repository, in-memory ledger doubles, vm-hosted page bridge)'
}, null, 2));
process.exit(failures.length === 0 ? 0 : 1);
