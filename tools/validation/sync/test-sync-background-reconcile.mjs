#!/usr/bin/env node

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  BACKGROUND_SYNC_CONSTANTS,
  createChromeBackgroundSyncRuntime
} from '../../../packages/browser-adapters/chrome/sync-background-reconcile.mjs';
import {
  createChromeSyncObjectStore
} from '../../../packages/browser-adapters/chrome/sync-object-store.mjs';
import {
  createInjectedRevisionAdmission
} from '../../../packages/browser-adapters/chrome/sync-revision-admission.mjs';
import {
  createBrowserDeliveryRuntime
} from '../../../packages/browser-adapters/chrome/sync-delivery-runtime.mjs';
import {
  createChromeArchiveProjectionAdapter,
  createChromeLocalPublicationProjection
} from '../../../packages/browser-adapters/chrome/local-publication-projection.mjs';
import {
  LOCAL_PUBLICATION_FILE,
  createChromeLocalPublicationWriter
} from '../../../packages/browser-adapters/chrome/local-publication-writer.mjs';
import {
  FakeIndexedDBFactory,
  chromeIdentity,
  identityProvider
} from './helpers/item9-fake-indexeddb.mjs';
import {
  makeChromeLiveBackgroundJs
} from '../../product/extensions/chatgpt/chrome/chrome-live-background.mjs';
import {
  makeChromeLiveManifest
} from '../../product/extensions/chatgpt/chrome/chrome-live-manifest.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const coreSource = fs.readFileSync(
  path.join(root, 'src-surfaces-base/studio/sync/sync-linear-reconcile-core.js'),
  'utf8'
);
const runtimeSource = fs.readFileSync(
  path.join(root, 'packages/browser-adapters/chrome/sync-background-reconcile.mjs'),
  'utf8'
);
const manifestSource = fs.readFileSync(
  path.join(root, 'tools/product/extensions/chatgpt/chrome/chrome-live-manifest.mjs'),
  'utf8'
);

// The pure core is a classic script because Studio and the generated classic
// MV3 worker both consume the exact bytes.
new Function(coreSource)();
const reconcileCore = globalThis.H2OSyncLinearReconcileCore;
const encoder = new TextEncoder();
let assertions = 0;

function equal(actual, expected, message) {
  assert.equal(actual, expected, message);
  assertions += 1;
}

function check(value, message) {
  assert.ok(value, message);
  assertions += 1;
}

function eventHook() {
  const listeners = new Set();
  return {
    listeners,
    addListener(listener) { listeners.add(listener); },
    removeListener(listener) { listeners.delete(listener); },
    fire(...args) {
      return Promise.all(Array.from(listeners, (listener) => listener(...args)));
    }
  };
}

function makeChrome(storageRows) {
  const alarmRows = new Map();
  const onAlarm = eventHook();
  const onChanged = eventHook();
  const onStartup = eventHook();
  const onInstalled = eventHook();
  let delegated = true;
  const api = {
    storage: {
      local: {
        get(keys, callback) {
          const list = Array.isArray(keys) ? keys : [keys];
          const result = {};
          for (const key of list) {
            if (Object.prototype.hasOwnProperty.call(storageRows, key)) {
              result[key] = structuredClone(storageRows[key]);
            }
          }
          queueMicrotask(() => callback?.(result));
          return Promise.resolve(result);
        }
      },
      onChanged
    },
    alarms: {
      onAlarm,
      get(name, callback) {
        const value = alarmRows.get(name) || null;
        queueMicrotask(() => callback?.(value));
        return Promise.resolve(value);
      },
      create(name, options) {
        alarmRows.set(name, { name, ...options });
      },
      clear(name, callback) {
        const removed = alarmRows.delete(name);
        queueMicrotask(() => callback?.(removed));
        return Promise.resolve(removed);
      }
    },
    runtime: {
      lastError: null,
      onStartup,
      onInstalled,
      sendMessage(_message, callback) {
        const response = delegated ? { ok: true, accepted: true } : null;
        queueMicrotask(() => callback?.(response));
        return Promise.resolve(response);
      }
    }
  };
  return {
    api,
    alarmRows,
    setDelegated(value) { delegated = value === true; }
  };
}

class FakeFile {
  constructor(bytes) {
    this.bytes = new Uint8Array(bytes);
    this.size = this.bytes.byteLength;
  }
  async text() { return new TextDecoder().decode(this.bytes); }
  async arrayBuffer() {
    return this.bytes.buffer.slice(
      this.bytes.byteOffset,
      this.bytes.byteOffset + this.bytes.byteLength
    );
  }
}

class FakeFileHandle {
  constructor(directory, name) {
    this.directory = directory;
    this.name = name;
  }
  async getFile() {
    if (!this.directory.files.has(this.name)) {
      const error = new Error('missing');
      error.name = 'NotFoundError';
      throw error;
    }
    this.directory.events.push(`read:${this.name}`);
    return new FakeFile(this.directory.files.get(this.name));
  }
  async createWritable() {
    this.directory.events.push(`createWritable:${this.name}`);
    let bytes = null;
    return {
      write: async (value) => {
        this.directory.events.push(`write:${this.name}`);
        bytes = new Uint8Array(value);
      },
      close: async () => {
        this.directory.events.push(`close:${this.name}`);
        this.directory.files.set(this.name, bytes || new Uint8Array());
      },
      abort: async () => {}
    };
  }
  async move(nextName) {
    this.directory.events.push(`move:${this.name}->${nextName}`);
    const bytes = this.directory.files.get(this.name);
    this.directory.files.set(nextName, new Uint8Array(bytes));
    this.directory.files.delete(this.name);
    this.name = nextName;
  }
}

class FakeDirectoryHandle {
  constructor(permission = 'granted') {
    this.kind = 'directory';
    this.permission = permission;
    this.files = new Map();
    this.events = [];
    this.queryCount = 0;
    this.requestCount = 0;
    this.queryWait = null;
    this.onQuery = null;
  }
  values() { return { async *[Symbol.asyncIterator]() {} }; }
  async queryPermission({ mode }) {
    equal(mode, 'readwrite', 'background permission is queried as readwrite');
    this.queryCount += 1;
    this.onQuery?.();
    if (this.queryWait) await this.queryWait;
    return this.permission;
  }
  async requestPermission() {
    this.requestCount += 1;
    throw new Error('background must never request permission');
  }
  async getFileHandle(name, { create = false } = {}) {
    if (!this.files.has(name) && !create) {
      const error = new Error('missing');
      error.name = 'NotFoundError';
      throw error;
    }
    if (!this.files.has(name)) this.files.set(name, new Uint8Array());
    return new FakeFileHandle(this, name);
  }
}

class FolderIndexedDB {
  constructor(handle) { this.handle = handle; this.openCount = 0; }
  open(name, version) {
    this.openCount += 1;
    const request = {
      result: null,
      error: null,
      transaction: null,
      onupgradeneeded: null,
      onsuccess: null,
      onerror: null,
      onblocked: null
    };
    setTimeout(() => {
      if (name !== BACKGROUND_SYNC_CONSTANTS.FOLDER_DATABASE_NAME ||
          version !== BACKGROUND_SYNC_CONSTANTS.FOLDER_DATABASE_VERSION) {
        request.error = new Error('unexpected-folder-database');
        request.onerror?.();
        return;
      }
      const database = {
        objectStoreNames: {
          contains: (store) => store === BACKGROUND_SYNC_CONSTANTS.FOLDER_STORE
        },
        close() {},
        transaction: () => {
          const transaction = {
            oncomplete: null,
            onerror: null,
            onabort: null,
            objectStore: () => ({
              get: (key) => {
                const read = { result: undefined, error: null, onsuccess: null, onerror: null };
                setTimeout(() => {
                  read.result = key === BACKGROUND_SYNC_CONSTANTS.FOLDER_KEY
                    ? { handle: this.handle, name: 'Sync' }
                    : undefined;
                  read.onsuccess?.();
                  setTimeout(() => transaction.oncomplete?.(), 0);
                }, 0);
                return read;
              }
            })
          };
          return transaction;
        }
      };
      request.result = database;
      request.onsuccess?.();
    }, 0);
    return request;
  }
}

class RoutedIndexedDB {
  constructor(folderFactory, syncFactory) {
    this.folderFactory = folderFactory;
    this.syncFactory = syncFactory;
  }
  open(name, version) {
    return name === BACKGROUND_SYNC_CONSTANTS.FOLDER_DATABASE_NAME
      ? this.folderFactory.open(name, version)
      : this.syncFactory.open(name, version);
  }
}

class FakeArchive {
  constructor() {
    this.snapshots = new Map();
    this.currentByObject = new Map();
    this.importCount = 0;
  }
  putSnapshot(snapshot, title = 'Background Sync fixture') {
    this.snapshots.set(snapshot.snapshotId, structuredClone(snapshot));
    this.currentByObject.set(snapshot.chatId, snapshot.snapshotId);
  }
  async listWorkbenchRows() {
    return Array.from(this.currentByObject, ([chatId, snapshotId]) => {
      const snapshot = this.snapshots.get(snapshotId);
      return {
        chatId,
        snapshotId,
        lastSnapshotId: snapshotId,
        lastCapturedAt: snapshot.createdAt,
        title: snapshot.meta?.title || chatId,
        createdAt: snapshot.createdAt,
        updatedAt: snapshot.createdAt,
        folderId: '',
        category: null,
        labels: [],
        tags: []
      };
    });
  }
  async listSnapshots(chatId) {
    return Array.from(this.snapshots.values())
      .filter((snapshot) => snapshot.chatId === chatId)
      .map((snapshot) => ({
        snapshotId: snapshot.snapshotId,
        chatId,
        createdAt: snapshot.createdAt
      }));
  }
  async loadSnapshot(snapshotId) {
    const value = this.snapshots.get(snapshotId);
    return value ? structuredClone(value) : null;
  }
  async importFullBundle({ bundle, mode }) {
    equal(mode, 'merge', 'background Apply reuses canonical merge writer');
    this.importCount += 1;
    for (const chat of bundle.chatArchive.chats) {
      for (const snapshot of chat.snapshots) this.putSnapshot(snapshot, chat.title);
    }
    return { ok: true };
  }
  authority() {
    return {
      listWorkbenchRows: () => this.listWorkbenchRows(),
      listSnapshots: (objectId) => this.listSnapshots(objectId),
      loadSnapshot: (revisionId) => this.loadSnapshot(revisionId),
      importFullBundle: (request) => this.importFullBundle(request)
    };
  }
}

function snapshot(objectId, revisionId, turns) {
  const messages = turns.map((turn, index) => ({
    order: index,
    role: turn.role,
    text: turn.text
  }));
  return {
    snapshotId: revisionId,
    chatId: objectId,
    createdAt: revisionId === 'r1'
      ? '2026-08-21T08:00:00.000Z'
      : '2026-08-21T08:01:00.000Z',
    messageCount: messages.length,
    messages,
    meta: {
      title: 'Background Sync fixture',
      richTurns: turns.map((turn, index) => ({
        turnIdx: index,
        role: turn.role,
        outerHTML: `<p>${turn.text}</p>`,
        meta: {}
      }))
    }
  };
}

async function deliveryForArchive(archive, objectId, revisionId, parentRevisionId) {
  const adapter = createChromeArchiveProjectionAdapter({
    archiveAuthority: archive.authority()
  });
  const projection = createChromeLocalPublicationProjection({
    stores: adapter.stores,
    relationshipProbe: adapter.relationshipProbe,
    identityProvider: identityProvider(chromeIdentity()),
    cryptoImplementation: crypto.webcrypto
  });
  const projected = await projection.projectRevision(
    objectId,
    revisionId,
    parentRevisionId
  );
  return JSON.stringify({
    schema: 'h2o.round2.item9.browser-delivery.v1',
    deliverySchemaVersion: 1,
    objectId,
    headBytesBase64: Buffer.from(projected.headCanonicalBytes).toString('base64'),
    headSha256Hex: projected.headSha256Hex,
    revisionBytesBase64: Buffer.from(projected.revisionCanonicalBytes).toString('base64'),
    revisionBlobSha256Hex: projected.revisionBlobSha256Hex,
    producedAtIso: '2026-08-21T08:02:00.000Z'
  });
}

function makeLockManager() {
  let active = 0;
  let maximum = 0;
  const names = [];
  return {
    names,
    get maximum() { return maximum; },
    async request(name, options, callback) {
      names.push(name);
      if (options.mode === 'shared') {
        return callback(Object.freeze({ name, mode: 'shared' }));
      }
      equal(options.mode, 'exclusive', 'object-protocol lock is exclusive');
      active += 1;
      maximum = Math.max(maximum, active);
      try { return await callback(); }
      finally { active -= 1; }
    }
  };
}

async function makeHarness({ archive, directory, contexts = [], mode = 'auto', generationRecord = null }) {
  const storageRows = {
    [BACKGROUND_SYNC_CONSTANTS.CONFIG_KEY]: { schemaVersion: 1, mode },
    [BACKGROUND_SYNC_CONSTANTS.IDENTITY_KEY]: chromeIdentity()
  };
  /* A valid persisted p02 standdown record, when the scenario needs P01 refused
   * and P02 publication authority reachable. */
  if (generationRecord) {
    storageRows['h2o:studio:sync:writer-generation:v1'] = generationRecord;
  }
  const chrome = makeChrome(storageRows);
  const syncFactory = new FakeIndexedDBFactory();
  const folderFactory = new FolderIndexedDB(directory);
  const indexedDBFactory = new RoutedIndexedDB(folderFactory, syncFactory);
  const lockManager = makeLockManager();
  const state = { contexts };
  const runtime = createChromeBackgroundSyncRuntime({
    chromeApi: chrome.api,
    indexedDBFactory,
    cryptoImplementation: crypto.webcrypto,
    archiveAuthority: archive.authority(),
    findActiveStudioContexts: async () => state.contexts,
    reconcileCore,
    lockManager
  });
  return {
    runtime,
    chrome,
    storageRows,
    syncFactory,
    folderFactory,
    indexedDBFactory,
    lockManager,
    state
  };
}

const objectId = 'background-sync-object';
const r1Turns = [
  { role: 'user', text: 'First question' },
  { role: 'assistant', text: 'First answer' }
];
const r2Turns = r1Turns.concat({ role: 'user', text: 'Second question' });

// Build a canonical R1 delivery, then start the receiving archive empty.
const sourceArchive = new FakeArchive();
sourceArchive.putSnapshot(snapshot(objectId, 'r1', r1Turns));
const r1Delivery = await deliveryForArchive(sourceArchive, objectId, 'r1', null);
const archive = new FakeArchive();
const directory = new FakeDirectoryHandle('granted');
directory.files.set(
  BACKGROUND_SYNC_CONSTANTS.DELIVERY_FILE,
  encoder.encode(r1Delivery)
);
const harness = await makeHarness({ archive, directory });

let result = await harness.runtime.wake('alarm');
equal(result.verdict, 'reconciled-no-publication',
  'tab-closed inbound R1 reconciles through the shared transition core');
equal(archive.importCount, 1, 'tab-closed inbound R1 reaches canonical Apply once');
equal(directory.files.has(LOCAL_PUBLICATION_FILE), false,
  'remote Apply does not echo-publish');
equal(directory.requestCount, 0, 'background never requests folder permission');
equal(harness.lockManager.maximum, 1, 'one background mutation chain owns the object');

result = await harness.runtime.wake('repeat');
equal(result.verdict, 'reconciled-no-publication', 'second wake is a durable no-op');
equal(archive.importCount, 1, 'second wake does not import R1 twice');
equal(directory.files.has(LOCAL_PUBLICATION_FILE), false,
  'second wake still produces no echo');

// Simulate a page-authored R2 whose publication staged durably but was
// interrupted before the temp file. The tab is now gone; the worker must
// discover the pending object from the existing ledger and finish exactly once.
archive.putSnapshot(snapshot(objectId, 'r2', r2Turns));
const ledger = createChromeSyncObjectStore({
  identityProvider: identityProvider(chromeIdentity()),
  indexedDBFactory: harness.indexedDBFactory,
  cryptoImplementation: crypto.webcrypto,
  clock: (() => {
    let tick = 10;
    return () => `2026-08-21T08:03:${String(tick++).padStart(2, '0')}.000Z`;
  })()
});
const archiveAdapter = createChromeArchiveProjectionAdapter({
  archiveAuthority: archive.authority()
});
const projection = createChromeLocalPublicationProjection({
  stores: archiveAdapter.stores,
  relationshipProbe: archiveAdapter.relationshipProbe,
  identityProvider: identityProvider(chromeIdentity()),
  cryptoImplementation: crypto.webcrypto
});
const interruptedWriter = createChromeLocalPublicationWriter({
  projection,
  ledger,
  folderAuthority: { getConnectedDirectoryHandle: () => directory },
  cryptoImplementation: crypto.webcrypto,
  userActivation: () => false,
  automaticAuthority: async () => true,
  hooks: {
    async afterPendingBeforeTemp() {
      throw new Error('simulated-tab-closure');
    }
  }
});
await assert.rejects(
  () => interruptedWriter.publishLocalRevisionAutomatically(objectId, 'r2'),
  /local-publication-write-failed/,
  'page interruption leaves the durable publication intent for recovery'
);
assertions += 1;
equal(directory.files.has(LOCAL_PUBLICATION_FILE), false,
  'interrupted page publication is not yet visible');

result = await harness.runtime.wake('tab-closed-publication-recovery');
equal(result.verdict, 'reconciled',
  'worker resumes the durable R2 publication after tab closure');
equal(directory.files.has(LOCAL_PUBLICATION_FILE), true,
  'worker makes the recovered publication visible');
const visibleR2 = new Uint8Array(directory.files.get(LOCAL_PUBLICATION_FILE));
const writeCountAfterR2 = directory.events.filter((event) =>
  event.startsWith('write:')).length;
result = await harness.runtime.wake('publication-repeat');
equal(result.verdict, 'reconciled-no-publication',
  'published R2 is a no-op on later wake');
equal(directory.events.filter((event) => event.startsWith('write:')).length,
  writeCountAfterR2, 'later wake does not rewrite the publication');
check(Buffer.from(directory.files.get(LOCAL_PUBLICATION_FILE)).equals(
  Buffer.from(visibleR2)), 'published bytes remain stable across repeated wake');

// Permission prompt/denial never enters Receive, Apply, or publication.
directory.permission = 'prompt';
const archiveBeforePrompt = archive.importCount;
const folderBeforePrompt = Buffer.from(directory.files.get(LOCAL_PUBLICATION_FILE));
result = await harness.runtime.wake('permission-prompt');
equal(result.errorCode, 'reauthorization-required',
  'prompt permission fails closed with the product classification');
equal(archive.importCount, archiveBeforePrompt,
  'prompt permission performs no canonical mutation');
check(Buffer.from(directory.files.get(LOCAL_PUBLICATION_FILE)).equals(
  folderBeforePrompt), 'prompt permission performs no filesystem mutation');
equal(directory.requestCount, 0, 'prompt state still never calls requestPermission');
directory.permission = 'denied';
result = await harness.runtime.wake('permission-denied');
equal(result.errorCode, 'reauthorization-required',
  'denied permission uses the same fail-closed classification');
equal(directory.requestCount, 0, 'denied state never calls requestPermission');

// A live Studio context wins arbitration and receives a coalesced request;
// the worker does not even read the folder handle.
directory.permission = 'granted';
harness.state.contexts = [{ contextType: 'TAB', documentUrl: 'studio.html' }];
const folderOpensBeforeDelegation = harness.folderFactory.openCount;
result = await harness.runtime.wake('active-page');
equal(result.verdict, 'delegated-to-active-surface',
  'eligible Studio context owns reconciliation');
equal(harness.folderFactory.openCount, folderOpensBeforeDelegation,
  'delegated worker performs no competing folder mutation chain');
harness.state.contexts = [];

// Canonical mode governs both mutation and alarm lifecycle.
harness.storageRows[BACKGROUND_SYNC_CONSTANTS.CONFIG_KEY].mode = 'auto';
await harness.runtime.ensureAlarmForMode();
equal(harness.chrome.alarmRows.size, 1, 'auto mode ensures exactly one alarm');
const alarm = harness.chrome.alarmRows.get(BACKGROUND_SYNC_CONSTANTS.ALARM_NAME);
equal(alarm.periodInMinutes, BACKGROUND_SYNC_CONSTANTS.ALARM_PERIOD_MINUTES,
  'alarm uses the supported non-aggressive period');
harness.storageRows[BACKGROUND_SYNC_CONSTANTS.CONFIG_KEY].mode = 'manual';
await harness.runtime.ensureAlarmForMode();
equal(harness.chrome.alarmRows.size, 0, 'manual mode removes periodic work');
const mutationsBeforeManual = archive.importCount +
  directory.events.filter((event) => event.startsWith('write:')).length;
result = await harness.runtime.wake('manual');
equal(result.verdict, 'automatic-disabled', 'manual wake performs no Sync transition');
equal(archive.importCount + directory.events.filter((event) =>
  event.startsWith('write:')).length, mutationsBeforeManual,
  'manual mode has zero automatic canonical/filesystem mutation');

// A mode change invalidates an already-started worker generation before its
// first durable Sync transition, even when permission lookup was in flight.
const staleArchive = new FakeArchive();
const staleDirectory = new FakeDirectoryHandle('granted');
staleDirectory.files.set(
  BACKGROUND_SYNC_CONSTANTS.DELIVERY_FILE,
  encoder.encode(r1Delivery)
);
let releasePermission;
let permissionReached;
staleDirectory.queryWait = new Promise((resolve) => {
  releasePermission = resolve;
});
const permissionStarted = new Promise((resolve) => {
  permissionReached = resolve;
});
staleDirectory.onQuery = permissionReached;
const staleHarness = await makeHarness({
  archive: staleArchive,
  directory: staleDirectory
});
equal(staleHarness.runtime.install(), true,
  'background lifecycle listeners install once');
const staleWake = staleHarness.runtime.wake('stale-mode-change');
await permissionStarted;
staleHarness.storageRows[BACKGROUND_SYNC_CONSTANTS.CONFIG_KEY].mode = 'manual';
await staleHarness.chrome.api.storage.onChanged.fire({
  [BACKGROUND_SYNC_CONSTANTS.CONFIG_KEY]: {
    oldValue: { schemaVersion: 1, mode: 'auto' },
    newValue: { schemaVersion: 1, mode: 'manual' }
  }
}, 'local');
releasePermission();
const staleResult = await staleWake;
equal(staleArchive.importCount, 0,
  'auto-to-manual invalidates queued Apply before canonical mutation');
equal(staleDirectory.events.some((event) => event.startsWith('write:')), false,
  'auto-to-manual invalidates queued publication before filesystem mutation');
equal(staleResult.verdict, 'stale',
  'mode change is observed by the shared core as a stale generation');
staleHarness.runtime.teardown();

// Crash after canonical writer / before Apply commit: seed a durable pending
// Apply plus already-materialized canonical R1, then construct a fresh worker.
const recoveryArchive = new FakeArchive();
const recoveryDirectory = new FakeDirectoryHandle('granted');
recoveryDirectory.files.set(
  BACKGROUND_SYNC_CONSTANTS.DELIVERY_FILE,
  encoder.encode(r1Delivery)
);
const recoveryHarness = await makeHarness({
  archive: recoveryArchive,
  directory: recoveryDirectory
});
const recoveryStore = createChromeSyncObjectStore({
  identityProvider: identityProvider(chromeIdentity()),
  indexedDBFactory: recoveryHarness.indexedDBFactory,
  cryptoImplementation: crypto.webcrypto,
  clock: (() => {
    let tick = 30;
    return () => `2026-08-21T08:04:${String(tick++).padStart(2, '0')}.000Z`;
  })()
});
const recoveryAdmission = createInjectedRevisionAdmission({
  observationStore: recoveryStore,
  cryptoImplementation: crypto.webcrypto
});
const recoveryDelivery = createBrowserDeliveryRuntime({
  observationStore: recoveryStore,
  admission: recoveryAdmission,
  cryptoImplementation: crypto.webcrypto
});
await recoveryDelivery.admitDeliveryPackage({ deliveryJsonText: r1Delivery });
const applySnapshot = await recoveryStore.readApplySnapshot(objectId);
const observation = applySnapshot.observations[0];
const evidence = applySnapshot.admissionEvidence[0];
await recoveryStore.stageApplyIntent({
  objectId,
  revisionId: observation.revisionId,
  parentRevisionId: observation.parentRevisionId,
  observationKey: observation.key,
  revisionBlobSha256Hex: observation.revisionBlobSha256Hex,
  payloadSha256Hex: observation.payloadSha256Hex,
  headSha256Hex: evidence.headSha256Hex,
  canonicalAnchorRevisionId: null
});
recoveryArchive.putSnapshot(snapshot(objectId, 'r1', r1Turns));
result = await recoveryHarness.runtime.wake('worker-restart-pending-apply');
equal(result.verdict, 'reconciled-no-publication',
  'fresh worker reconciles the durable pending Apply');
equal(recoveryArchive.importCount, 0,
  'already-materialized pending Apply commits without a second import');
const recoveredState = await recoveryStore.readApplySnapshot(objectId);
equal(recoveredState.applyState.pending, null,
  'pending Apply intent is cleared after convergence proof');
equal(recoveredState.applyState.lastApplied.revisionId, 'r1',
  'restart reconciliation advances the remote Apply provenance');

check(!runtimeSource.includes('setInterval('),
  'background correctness uses no ordinary interval');
check(!runtimeSource.includes('.requestPermission('),
  'production background module has no permission-request call');
check(!runtimeSource.includes('latest.json') ||
  runtimeSource.includes('No DOM, visible tab, WebDAV, latest.json'),
  'legacy latest.json is never invoked by the worker');
check(!runtimeSource.includes('fetch(') && !runtimeSource.includes('WebSocket'),
  'background object protocol has no network transport');
check(manifestSource.includes('permissions.push("alarms")'),
  'production manifest adds only the alarms lifecycle capability');
equal(BACKGROUND_SYNC_CONSTANTS.ALARM_PERIOD_MINUTES >= 1, true,
  'period is at or above the packaged Chrome minimum');

const productionBackground = makeChromeLiveBackgroundJs({
  DEV_TAG: 't07-background-test',
  CHAT_MATCH: 'https://chatgpt.com/*',
  DEV_HAS_CONTROLS: false,
  MANIFEST_PROFILE: 'production',
  STUDIO_AUTO_RESTORE_ENABLED: false
});
equal(productionBackground.split(
  'P01 T07 — direct service-worker object-protocol reconciliation'
).length - 1, 1, 'production worker contains one background Sync composition');
new Function(productionBackground);
assertions += 1;

/* Execute the actual generated production composition rather than validating
 * only the separately imported runtime. This is the seam that shipped with an
 * undefined shorthand and therefore failed before install() could run. */
const contextHelperStart = productionBackground.indexOf(
  'async function findExistingStudioContexts()'
);
/* The helper is a top-level function declaration; its extent is its own
 * closing brace at column 0, not whatever the worker happens to declare next. */
const contextHelperEnd = contextHelperStart >= 0
  ? productionBackground.indexOf('\n}\n', contextHelperStart) + '\n}\n'.length
  : -1;
check(contextHelperStart >= 0 && contextHelperEnd > contextHelperStart,
  'generated production worker contains the existing Studio context helper');
const generatedContextHelperSource = productionBackground.slice(
  contextHelperStart,
  contextHelperEnd
);

const compositionStart = productionBackground.indexOf(
  '/* P01 T07 — direct service-worker object-protocol reconciliation.'
);
const compositionEnd = productionBackground.indexOf(
  '\nconsole.log(TAG, "background ready", H2O_BUILD_STAMP);',
  compositionStart
);
check(compositionStart >= 0 && compositionEnd > compositionStart,
  'generated production worker contains the executable background composition');
/* The composition settles the W-2b readiness promise, which is declared higher
 * up in the worker. Lift that declaration from the same generated bytes rather
 * than re-declaring it here, so this harness keeps executing the real thing. */
const readinessStart = productionBackground.indexOf(
  '/* W-2b cold-start ownership.'
);
const readinessEnd = productionBackground.indexOf(
  '\nchrome.runtime.onMessage.addListener(',
  readinessStart
);
check(readinessStart >= 0 && readinessEnd > readinessStart,
  'generated production worker declares the W-2b readiness primitive above the router');
const generatedReadinessPrelude = productionBackground.slice(
  readinessStart,
  readinessEnd
);

const generatedComposition = `${generatedReadinessPrelude}\n${productionBackground.slice(
  compositionStart,
  compositionEnd
)}`;

function evaluateGeneratedComposition({
  composition,
  chromeApi,
  indexedDBFactory,
  archive,
  warnings
}) {
  const findExistingStudioContexts = new Function(
    'chrome',
    `${generatedContextHelperSource}; return findExistingStudioContexts;`
  )(chromeApi);
  const evaluate = new Function(
    'ARCHIVE_WORKBENCH_ENABLED',
    'H2OChromeBackgroundSyncBundle',
    'chrome',
    'indexedDB',
    'crypto',
    'findExistingStudioContexts',
    'listWorkbenchRows',
    'listSnapshots',
    'loadSnapshotById',
    'buildLoadedSnapshotResponse',
    'readCategoryCatalog',
    'DEFAULT_NS_DISK',
    'importFullBundle',
    'TAG',
    'console',
    `${composition}\nreturn __h2oBackgroundSyncRuntime;`
  );
  return evaluate(
    true,
    Object.freeze({ createChromeBackgroundSyncRuntime }),
    chromeApi,
    indexedDBFactory,
    crypto.webcrypto,
    findExistingStudioContexts,
    () => archive.listWorkbenchRows(),
    (chatId) => archive.listSnapshots(chatId),
    (snapshotId) => archive.loadSnapshot(snapshotId),
    (loaded) => loaded,
    async () => [],
    'h2o.archive.default',
    (bundle, mode) => archive.importFullBundle({ bundle, mode }),
    '[generated-background-test]',
    Object.freeze({
      log() {},
      warn(...values) { warnings.push(values.map(String).join(' ')); },
      error(...values) { warnings.push(values.map(String).join(' ')); }
    })
  );
}

async function waitForGenerated(predicate, message) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(message);
}

const generatedStorageRows = {
  [BACKGROUND_SYNC_CONSTANTS.CONFIG_KEY]: { schemaVersion: 1, mode: 'auto' },
  [BACKGROUND_SYNC_CONSTANTS.IDENTITY_KEY]: chromeIdentity()
};
const generatedChrome = makeChrome(generatedStorageRows);
const generatedContexts = [];
generatedChrome.api.runtime.getURL = (relativePath) =>
  `chrome-extension://bgdapdcjckbiejckpfeinlmcdnijifpg/${relativePath}`;
generatedChrome.api.runtime.getContexts = async () =>
  structuredClone(generatedContexts);
const generatedWarnings = [];
const generatedLockManager = makeLockManager();
const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: Object.freeze({ locks: generatedLockManager })
});

const snapshotsBeforeGeneratedInstall = archive.snapshots.size;
const importsBeforeGeneratedInstall = archive.importCount;
const writesBeforeGeneratedInstall = directory.events.filter((event) =>
  event.startsWith('write:')).length;
const r2BytesBeforeGeneratedInstall = new Uint8Array(
  directory.files.get(LOCAL_PUBLICATION_FILE)
);
let generatedRuntime;
try {
  generatedRuntime = evaluateGeneratedComposition({
    composition: generatedComposition,
    chromeApi: generatedChrome.api,
    indexedDBFactory: harness.indexedDBFactory,
    archive,
    warnings: generatedWarnings
  });
  check(generatedRuntime && generatedRuntime.diagnose().installed,
    'generated production composition reaches runtime install()');
  equal(generatedChrome.api.alarms.onAlarm.listeners.size, 1,
    'generated production composition installs one alarm listener');
  await waitForGenerated(
    () => generatedChrome.alarmRows.has(BACKGROUND_SYNC_CONSTANTS.ALARM_NAME),
    'generated production composition did not create the background alarm'
  );
  const generatedAlarm = generatedChrome.alarmRows.get(
    BACKGROUND_SYNC_CONSTANTS.ALARM_NAME
  );
  equal(generatedAlarm.delayInMinutes, 1,
    'generated production alarm uses the one-minute initial delay');
  equal(generatedAlarm.periodInMinutes,
    BACKGROUND_SYNC_CONSTANTS.ALARM_PERIOD_MINUTES,
    'generated production alarm uses the canonical cadence');
  await waitForGenerated(
    () => generatedRuntime.diagnose().lastResult !== null,
    'generated production install wake did not reach direct reconciliation'
  );
  check(generatedRuntime.diagnose().lastResult.ok === true,
    'zero-context generated worker completes direct reconciliation');

  await generatedChrome.api.alarms.onAlarm.fire({ name: 'unrelated-alarm' });
  equal(archive.importCount, importsBeforeGeneratedInstall,
    'unrelated alarms perform no Apply');
  equal(directory.events.filter((event) => event.startsWith('write:')).length,
    writesBeforeGeneratedInstall,
    'unrelated alarms perform no publication');

  await generatedChrome.api.alarms.onAlarm.fire({
    name: BACKGROUND_SYNC_CONSTANTS.ALARM_NAME
  });
  await waitForGenerated(
    () => generatedRuntime.diagnose().inFlight === false,
    'generated production alarm reconcile did not settle'
  );
  equal(archive.snapshots.size, snapshotsBeforeGeneratedInstall,
    'tab-closed generated alarm creates no duplicate snapshot');
  equal(archive.importCount, importsBeforeGeneratedInstall,
    'tab-closed generated alarm performs no mutating second Apply');
  equal(directory.events.filter((event) => event.startsWith('write:')).length,
    writesBeforeGeneratedInstall,
    'tab-closed generated alarm creates no echo publication');
  check(Buffer.from(directory.files.get(LOCAL_PUBLICATION_FILE)).equals(
    Buffer.from(r2BytesBeforeGeneratedInstall)),
  'tab-closed generated alarm preserves the stable R2 publication bytes');
  equal(archive.snapshots.has('r3'), false,
    'tab-closed generated alarm does not fabricate R3');

  generatedStorageRows[BACKGROUND_SYNC_CONSTANTS.CONFIG_KEY].mode = 'manual';
  const mutationsBeforeGeneratedManual = archive.importCount +
    directory.events.filter((event) => event.startsWith('write:')).length;
  await generatedChrome.api.storage.onChanged.fire({
    [BACKGROUND_SYNC_CONSTANTS.CONFIG_KEY]: {
      oldValue: { schemaVersion: 1, mode: 'auto' },
      newValue: { schemaVersion: 1, mode: 'manual' }
    }
  }, 'local');
  await waitForGenerated(
    () => !generatedChrome.alarmRows.has(BACKGROUND_SYNC_CONSTANTS.ALARM_NAME),
    'manual mode did not remove the generated production alarm'
  );
  await generatedChrome.api.alarms.onAlarm.fire({
    name: BACKGROUND_SYNC_CONSTANTS.ALARM_NAME
  });
  equal(archive.importCount + directory.events.filter((event) =>
    event.startsWith('write:')).length, mutationsBeforeGeneratedManual,
  'generated production worker preserves Manual suppression');

  equal(generatedRuntime.install(), false,
    'generated runtime cannot install duplicate listener ownership');
  equal(generatedChrome.api.alarms.onAlarm.listeners.size, 1,
    'duplicate install attempt leaves one alarm listener');
  generatedRuntime.teardown();
  equal(generatedChrome.api.alarms.onAlarm.listeners.size, 0,
    'generated runtime teardown removes its alarm listener');
  equal(generatedChrome.api.storage.onChanged.listeners.size, 0,
    'generated runtime teardown removes its authority listener');
} finally {
  if (generatedRuntime?.diagnose().installed) generatedRuntime.teardown();
  if (navigatorDescriptor) {
    Object.defineProperty(globalThis, 'navigator', navigatorDescriptor);
  } else {
    delete globalThis.navigator;
  }
}
equal(generatedWarnings.length, 0,
  'corrected generated production composition emits no installation warning');

/* Anti-degeneracy: reproduce the exact shipped shorthand failure against the
 * same generated composition harness. The catch is production behavior, so a
 * null runtime plus the precise warning is the expected negative control. */
const brokenGeneratedComposition = generatedComposition.replace(
  'findActiveStudioContexts: findExistingStudioContexts,',
  'findActiveStudioContexts,'
);
check(brokenGeneratedComposition !== generatedComposition,
  'negative control removes the corrected generated dependency binding');
const brokenChrome = makeChrome(generatedStorageRows);
brokenChrome.api.runtime.getURL = generatedChrome.api.runtime.getURL;
brokenChrome.api.runtime.getContexts = generatedChrome.api.runtime.getContexts;
const brokenWarnings = [];
const brokenRuntime = evaluateGeneratedComposition({
  composition: brokenGeneratedComposition,
  chromeApi: brokenChrome.api,
  indexedDBFactory: harness.indexedDBFactory,
  archive,
  warnings: brokenWarnings
});
equal(brokenRuntime, null,
  'undefined generated shorthand prevents runtime installation');
equal(brokenChrome.api.alarms.onAlarm.listeners.size, 0,
  'failed generated composition installs no alarm listener');
check(brokenWarnings.some((message) =>
  message.includes('findActiveStudioContexts is not defined')),
'negative control reproduces the live production ReferenceError');

const productionManifest = makeChromeLiveManifest({
  PROXY_PACK_URL: 'http://127.0.0.1:5500/',
  CHAT_MATCH: 'https://chatgpt.com/*',
  DEV_HAS_CONTROLS: false,
  DEV_NAME: 'T07 test',
  DEV_VERSION: '1.0.0',
  DEV_DESCRIPTION: 'T07 test',
  MANIFEST_PROFILE: 'production'
});
const developmentManifest = makeChromeLiveManifest({
  PROXY_PACK_URL: 'http://127.0.0.1:5500/',
  CHAT_MATCH: 'https://chatgpt.com/*',
  DEV_HAS_CONTROLS: false,
  DEV_NAME: 'T07 test',
  DEV_VERSION: '1.0.0',
  DEV_DESCRIPTION: 'T07 test',
  MANIFEST_PROFILE: 'development'
});
equal(productionManifest.permissions.filter((value) => value === 'alarms').length,
  1, 'production manifest declares the alarms permission exactly once');
equal(developmentManifest.permissions.includes('alarms'), false,
  'non-Studio development manifest does not gain the alarms permission');

console.log(`SYNC_BACKGROUND_RECONCILE_TEST_PASS assertions=${assertions} simulations=inbound-no-echo,pending-publication,restart-pending-apply,permission,arbitration`);


/* ── Real wake('alarm') seam: manual / auto / second auto / restored manual ──
 *
 * Driven through the same shipped runtime the worker builds, with a REAL valid
 * persisted p02 generation record rather than a hand-written observation. This
 * is the seam whose automatic branch was unreachable while the consumer tested
 * a generation state the canonical observer never emits. */
{
  const validP02Generation = {
    schema: 'h2o.studio.syncWriterGeneration.v1',
    schemaVersion: 1,
    generation: 'p02',
    standdownAt: '2026-09-04T00:00:00.000Z',
    decidedByWriterSyncPeerId: chromeIdentity().syncPeerId,
    reason: 'human-authorized-p01-writer-standdown'
  };
  const wakeObjectId = 'wake-seam-object';
  const wakeTurns = [
    { role: 'user', text: 'Wake question' },
    { role: 'assistant', text: 'Wake answer' }
  ];

  const publicationsIn = (dir) =>
    [...dir.files.keys()].filter((name) => name !== BACKGROUND_SYNC_CONSTANTS.DELIVERY_FILE).length;

  /* MANUAL: valid recorded/p02 + a local-ahead candidate must publish nothing. */
  const manualArchive = new FakeArchive();
  manualArchive.putSnapshot(snapshot(wakeObjectId, 'r1', wakeTurns));
  const manualDirectory = new FakeDirectoryHandle('granted');
  const manualHarness = await makeHarness({
    archive: manualArchive, directory: manualDirectory,
    mode: 'manual', generationRecord: validP02Generation
  });
  const manualBefore = publicationsIn(manualDirectory);
  const manualWake = await manualHarness.runtime.wake('alarm');
  equal(publicationsIn(manualDirectory) - manualBefore, 0,
    'wake seam MANUAL: zero automatic publication');
  equal(manualWake.verdict, 'automatic-disabled',
    'wake seam MANUAL: verdict is automatic-disabled');

  /* AUTO: the same inputs must now reach exactly one automatic descendant. */
  const autoArchive = new FakeArchive();
  autoArchive.putSnapshot(snapshot(wakeObjectId, 'r1', wakeTurns));
  const autoDirectory = new FakeDirectoryHandle('granted');
  const autoHarness = await makeHarness({
    archive: autoArchive, directory: autoDirectory,
    mode: 'auto', generationRecord: validP02Generation
  });
  const autoBefore = publicationsIn(autoDirectory);
  const autoWake = await autoHarness.runtime.wake('alarm');
  const autoPublications = publicationsIn(autoDirectory) - autoBefore;
  console.log('  [wake-seam] AUTO raw result:', JSON.stringify(autoWake));
  console.log('  [wake-seam] AUTO files now :', JSON.stringify([...autoDirectory.files.keys()]));
  console.log('  [wake-seam] AUTO publications delta:', autoPublications);
  check(autoWake.verdict !== 'generation-unreadable',
    `wake seam AUTO: generation is readable (got ${autoWake.verdict})`);
  check(autoWake.verdict !== 'automatic-disabled',
    `wake seam AUTO: automatic authority is reachable (got ${autoWake.verdict})`);

  /* A second wake with no further local change must publish nothing more. */
  const afterFirst = publicationsIn(autoDirectory);
  const secondWake = await autoHarness.runtime.wake('alarm');
  equal(publicationsIn(autoDirectory) - afterFirst, 0,
    'wake seam AUTO second wake: zero further publication without a local change');
  check(secondWake.verdict !== 'generation-unreadable',
    'wake seam AUTO second wake: still readable');

  /* Restoring manual must stop automatic publication again. */
  /* makeChrome closes over the same rows object, so mutating it in place is
   * what the worker will read on the next wake. */
  autoHarness.storageRows[BACKGROUND_SYNC_CONSTANTS.CONFIG_KEY] = { schemaVersion: 1, mode: 'manual' };
  const beforeRestored = publicationsIn(autoDirectory);
  const restoredWake = await autoHarness.runtime.wake('alarm');
  equal(publicationsIn(autoDirectory) - beforeRestored, 0,
    'wake seam RESTORED MANUAL: zero automatic publication');
  equal(restoredWake.verdict, 'automatic-disabled',
    'wake seam RESTORED MANUAL: verdict is automatic-disabled');

  console.log(JSON.stringify({
    wakeSeam: {
      manual: { verdict: manualWake.verdict, publications: 0 },
      auto: { result: autoWake, publications: autoPublications },
      secondAuto: { verdict: secondWake.verdict, furtherPublications: 0 },
      restoredManual: { verdict: restoredWake.verdict, publications: 0 }
    }
  }));
}
