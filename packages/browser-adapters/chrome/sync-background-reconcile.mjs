/* H2O Studio Sync — MV3 background one-object reconciliation composition.
 *
 * The service worker composes the same admission, Apply, projection, writer,
 * and pure transition authorities as the active Studio page. It owns only
 * lifecycle wakeups, permission-safe folder-handle recovery, and foreground /
 * background arbitration. No DOM, visible tab, WebDAV, latest.json, or second
 * recovery ledger.
 */

import { P02_GENERATION_STATE, P02_WRITER_GENERATION }
  from '../../core/sync-writer-generation-v2.mjs';
import { createChromeSyncObjectStore } from './sync-object-store.mjs';
import { createInjectedRevisionAdmission } from './sync-revision-admission.mjs';
import { createBrowserDeliveryRuntime } from './sync-delivery-runtime.mjs';
import { createChromeRevisionApply } from './sync-revision-apply.mjs';
import {
  createChromeArchiveProjectionAdapter,
  createChromeLocalPublicationProjection
} from './local-publication-projection.mjs';
import { createChromeLocalPublicationWriter } from './local-publication-writer.mjs';
import { createChromeP01MutationAdmission } from './sync-p01-mutation-admission-chrome.mjs';
/*
 * P02 Wave 1 / Z7 composition. These imports are what carry the P02 engine
 * into the generated production worker: the packer esbuild-bundles this module
 * with bundle:true, so the gate, capacity policy, scheduler, classifier and
 * branch-evidence path all reach bg.js from here.
 */
import {
  createP02ObjectRuntime,
  P02_RUNTIME_STATUS,
  P02_RUNTIME_V2
} from '../../core/sync-object-runtime-v2.mjs';
import {
  P02_FORMAT_GATE_V2,
  evaluateFormatGate
} from '../../core/sync-format-gate-v2.mjs';
import {
  P02_CAPACITY_LIMITS,
  evaluateCapacity,
  mapNativeStorageFailure
} from '../../core/sync-evidence-capacity-v2.mjs';
import { classifyObjectState } from '../../core/sync-object-classifier-v2.mjs';
import {
  branchIndexToClassifierInput,
  buildBranchIndex
} from '../../core/sync-branch-evidence-v2.mjs';
/*
 * Unit W. These carry the real receive path into the generated worker: the
 * packer bundles this module, so the shared reader, the confined FSA surfaces,
 * the format observation, the full enumerator and the receive core all reach
 * bg.js from here. NOTHING on the repository-write side is imported - the
 * writer transport, the steady publication and the steady driver's write half
 * are absent by construction, not by convention.
 */
import {
  P02_RECEIVE_V2,
  createP02ReceiveComposition
} from '../../core/sync-object-reconcile-v2.mjs';
import {
  createLocalReaderTransportPrimitives,
  strictIdentifier
} from './sync-reader-transport-v2.mjs';
import { objectKeyHex, writerKeyHex } from './sync-contract-v2.mjs';
import { createChromeFsaReadTransport } from './sync-fsa-read-transport-v2.mjs';
import { createChromeFormatObservation } from './sync-format-observation-chrome-v2.mjs';
import { createChromeReadOnlyObjectEnumerator } from './sync-object-enumerator-v2.mjs';
import { createChromeV2BranchAdmission } from './sync-branch-admission-v2.mjs';
import { createChromeV2Apply } from './sync-revision-apply-v2.mjs';
import { createChromeVerifiedTipMemo } from './sync-p02-tip-memo-chrome-v2.mjs';
import { createP02AnchorSet } from '../../core/sync-p02-anchor-set-v2.mjs';
import { createChromeP02PublicationOwner }
  from './sync-p02-publication-chrome-v2.mjs';

/*
 * Z7 composition provenance, asserted by the generated-production validator so
 * a packed worker that silently dropped the P02 engine is detectable.
 */
export const P02_BACKGROUND_COMPOSITION = Object.freeze({
  schema: 'h2o.studio.syncBackgroundComposition.p02.v1',
  runtime: P02_RUNTIME_V2.SCHEMA,
  gate: P02_FORMAT_GATE_V2.SCHEMA,
  capacity: {
    normalItems: P02_CAPACITY_LIMITS.normalItems,
    normalBytes: P02_CAPACITY_LIMITS.normalBytes,
    reserveItems: P02_CAPACITY_LIMITS.reserveItems,
    reserveBytes: P02_CAPACITY_LIMITS.reserveBytes,
    hardItems: P02_CAPACITY_LIMITS.hardItems,
    hardBytes: P02_CAPACITY_LIMITS.hardBytes
  },
  drainLimit: P02_RUNTIME_V2.DEFAULT_DRAIN_LIMIT,
  singleEngine: true,
  requestsPermission: false,
  /*
   * Unit W staged role. W-2 is Receive + admission only: `applyAuthority` is
   * null, so the receive core's handoff answers `no-apply-authority` and no
   * canonical Apply can occur. W-3 injects the existing Chrome Apply adapter
   * under its own authorization; it is not enabled here and is not a flag.
   * There is no publication stage at any W level.
   */
  stage: 'P02-bidirectional',
  receive: P02_RECEIVE_V2.SCHEMA,
  candidateDiscovery: 'configured-peer-advertisements-before-selection',
  applyEnabled: false,
  manualApply: 'trusted-human-ephemeral-only',
  publicationReachable: true,
  publicationOwner: 'chrome-p02-publication-owner',
  firstPublication: 'trusted-human-manual-only',
  automaticPublication: 'auto-mode-descendants-only',
  webdavReachable: false
});

export const BACKGROUND_SYNC_CONSTANTS = Object.freeze({
  ALARM_NAME: 'h2o:studio:sync:background-reconcile:v1',
  ALARM_PERIOD_MINUTES: 5,
  CONFIG_KEY: 'h2o:studio:sync:config:v1',
  FOLDER_DATABASE_NAME: 'h2o.studio.sync.folder.mv3',
  FOLDER_DATABASE_VERSION: 1,
  FOLDER_STORE: 'handles',
  FOLDER_KEY: 'sync-folder',
  DELIVERY_FILE: 'round2-item9-delivery.json',
  IDENTITY_KEY: 'h2o:sync:peer-identity:v1',
  TARGET_KEY: 'h2o:studio:sync:browser-delivery:target:v1',
  TARGET_SCHEMA: 'h2o.studio.browser-delivery.target.v1',
  MUTATION_LOCK_NAME: 'h2o:studio:sync:object-protocol:p01',
  FOREGROUND_MESSAGE: 'h2o:studio:sync:background-reconcile-request:v1'
});

const MAX_DELIVERY_FILE_BYTES = 8 * 1024 * 1024;
const LOWER_HEX_64 = /^[0-9a-f]{64}$/;

export const P02_W2C_PEER_ROSTER_ERROR = Object.freeze({
  CONFIG_INVALID: 'p02-w2c-peer-roster-config-invalid',
  /* MODE_VOCABULARY_ALIGNMENT: an explicit `off` mode is named as such; it is
   * still a refusal, never a roster. */
  CONFIG_MODE_OFF: 'p02-w2c-peer-roster-config-mode-off',
  ROW_INVALID: 'p02-w2c-peer-roster-row-invalid',
  SELF_TARGET: 'p02-w2c-peer-roster-self-target',
  DUPLICATE: 'p02-w2c-peer-roster-duplicate',
  AMBIGUOUS: 'p02-w2c-peer-roster-ambiguous',
  WRITER_KEY_MISMATCH: 'p02-w2c-peer-roster-writer-key-mismatch'
});

function clean(value) {
  return String(value == null ? '' : value).trim();
}

function codeError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function plainRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export async function parseW2cConfiguredPeers({
  config,
  localSyncPeerId,
  cryptoImplementation = globalThis.crypto
} = {}) {
  if (config == null) return Object.freeze([]);
  if (plainRecord(config) && config.schemaVersion === 1 && config.mode === 'off') {
    throw codeError(P02_W2C_PEER_ROSTER_ERROR.CONFIG_MODE_OFF);
  }
  if (!plainRecord(config) || config.schemaVersion !== 1 ||
      !['manual', 'notify', 'auto'].includes(config.mode)) {
    throw codeError(P02_W2C_PEER_ROSTER_ERROR.CONFIG_INVALID);
  }
  if (!Object.prototype.hasOwnProperty.call(config, 'configuredPeers')) {
    return Object.freeze([]);
  }
  if (!Array.isArray(config.configuredPeers)) {
    throw codeError(P02_W2C_PEER_ROSTER_ERROR.CONFIG_INVALID);
  }
  if (!strictIdentifier(localSyncPeerId)) {
    throw codeError(P02_W2C_PEER_ROSTER_ERROR.CONFIG_INVALID);
  }
  const local = localSyncPeerId;
  const peerToWriter = new Map();
  const writerToPeer = new Map();
  const accepted = [];
  for (const raw of config.configuredPeers) {
    if (!plainRecord(raw) ||
        Object.keys(raw).sort().join(',') !== 'syncPeerId,writerKey') {
      throw codeError(P02_W2C_PEER_ROSTER_ERROR.ROW_INVALID);
    }
    if (!strictIdentifier(raw.syncPeerId)) {
      throw codeError(P02_W2C_PEER_ROSTER_ERROR.ROW_INVALID);
    }
    const syncPeerId = raw.syncPeerId;
    const writerKey = clean(raw.writerKey);
    if (!LOWER_HEX_64.test(writerKey)) {
      throw codeError(P02_W2C_PEER_ROSTER_ERROR.ROW_INVALID);
    }
    if (syncPeerId === local) {
      throw codeError(P02_W2C_PEER_ROSTER_ERROR.SELF_TARGET);
    }
    if (peerToWriter.has(syncPeerId) || writerToPeer.has(writerKey)) {
      const exactDuplicate = peerToWriter.get(syncPeerId) === writerKey &&
        writerToPeer.get(writerKey) === syncPeerId;
      throw codeError(exactDuplicate
        ? P02_W2C_PEER_ROSTER_ERROR.DUPLICATE
        : P02_W2C_PEER_ROSTER_ERROR.AMBIGUOUS);
    }
    const derived = await writerKeyHex(syncPeerId, cryptoImplementation);
    if (writerKey !== derived) {
      throw codeError(P02_W2C_PEER_ROSTER_ERROR.WRITER_KEY_MISMATCH);
    }
    peerToWriter.set(syncPeerId, writerKey);
    writerToPeer.set(writerKey, syncPeerId);
    accepted.push(Object.freeze({ syncPeerId, writerKey }));
  }
  accepted.sort((left, right) =>
    left.syncPeerId.localeCompare(right.syncPeerId) ||
    left.writerKey.localeCompare(right.writerKey));
  return Object.freeze(accepted);
}

function safeErrorCode(error, fallback = 'background-sync-reconcile-failed') {
  return clean(error?.code || error?.message) || fallback;
}

function storageGet(chromeApi, key) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (value, error = null) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve(value || {});
    };
    try {
      const returned = chromeApi.storage.local.get([key], (rows) => {
        const failure = chromeApi.runtime?.lastError;
        done(rows, failure ? new Error(clean(failure.message) || 'storage-read-failed') : null);
      });
      if (returned && typeof returned.then === 'function') {
        returned.then((rows) => done(rows), (error) => done(null, error));
      }
    } catch (error) {
      done(null, error);
    }
  });
}

function alarmGet(chromeApi, name) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      resolve(value || null);
    };
    try {
      const returned = chromeApi.alarms.get(name, done);
      if (returned && typeof returned.then === 'function') {
        returned.then(done, () => done(null));
      }
    } catch (_) {
      done(null);
    }
  });
}

function alarmClear(chromeApi, name) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      resolve(value === true);
    };
    try {
      const returned = chromeApi.alarms.clear(name, done);
      if (returned && typeof returned.then === 'function') {
        returned.then(done, () => done(false));
      }
    } catch (_) {
      done(false);
    }
  });
}

function sendRuntimeMessage(chromeApi, message) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      resolve(value || null);
    };
    try {
      const returned = chromeApi.runtime.sendMessage(message, (response) => {
        void chromeApi.runtime?.lastError;
        done(response);
      });
      if (returned && typeof returned.then === 'function') {
        returned.then(done, () => done(null));
      }
    } catch (_) {
      done(null);
    }
  });
}

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(
      request.error || codeError('background-folder-database-read-failed')
    );
  });
}

function transactionResult(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(
      transaction.error || codeError('background-folder-database-read-failed')
    );
    transaction.onabort = () => reject(
      transaction.error || codeError('background-folder-database-read-failed')
    );
  });
}

function openExistingFolderDatabase(indexedDBFactory) {
  return new Promise((resolve, reject) => {
    let request;
    try {
      request = indexedDBFactory.open(
        BACKGROUND_SYNC_CONSTANTS.FOLDER_DATABASE_NAME,
        BACKGROUND_SYNC_CONSTANTS.FOLDER_DATABASE_VERSION
      );
    } catch (_) {
      reject(codeError('background-folder-handle-unavailable'));
      return;
    }
    request.onupgradeneeded = () => {
      try { request.transaction?.abort(); } catch (_) { /* fail closed */ }
    };
    request.onsuccess = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(
        BACKGROUND_SYNC_CONSTANTS.FOLDER_STORE
      )) {
        try { database.close(); } catch (_) { /* read-only cleanup */ }
        reject(codeError('background-folder-handle-unavailable'));
        return;
      }
      resolve(database);
    };
    request.onerror = () => reject(
      codeError('background-folder-handle-unavailable')
    );
    request.onblocked = () => reject(
      codeError('background-folder-handle-unavailable')
    );
  });
}

async function readPersistedDirectoryHandle(indexedDBFactory) {
  const database = await openExistingFolderDatabase(indexedDBFactory);
  try {
    const transaction = database.transaction(
      [BACKGROUND_SYNC_CONSTANTS.FOLDER_STORE],
      'readonly'
    );
    const completion = transactionResult(transaction);
    const row = await requestResult(
      transaction.objectStore(BACKGROUND_SYNC_CONSTANTS.FOLDER_STORE).get(
        BACKGROUND_SYNC_CONSTANTS.FOLDER_KEY
      )
    );
    await completion;
    const handle = row?.handle || null;
    if (!handle || (handle.kind && handle.kind !== 'directory') ||
        typeof handle.queryPermission !== 'function' ||
        typeof handle.getFileHandle !== 'function' ||
        (typeof handle.values !== 'function' &&
          typeof handle.entries !== 'function')) {
      throw codeError('background-folder-handle-unavailable');
    }
    return handle;
  } finally {
    try { database.close(); } catch (_) { /* read-only cleanup */ }
  }
}

async function requireGrantedPermission(handle) {
  let permission;
  try {
    permission = await handle.queryPermission({ mode: 'readwrite' });
  } catch (_) {
    throw codeError('reauthorization-required');
  }
  if (permission !== 'granted') {
    throw codeError('reauthorization-required');
  }
  return 'granted';
}

async function readDeliveryFile(handle) {
  let fileHandle;
  try {
    fileHandle = await handle.getFileHandle(
      BACKGROUND_SYNC_CONSTANTS.DELIVERY_FILE,
      { create: false }
    );
  } catch (error) {
    if (error?.name === 'NotFoundError' || error?.code === 'ENOENT') {
      throw codeError('round2-item9-delivery-file-missing');
    }
    throw codeError('round2-item9-delivery-file-read-failed');
  }
  try {
    const file = await fileHandle.getFile();
    if (!Number.isSafeInteger(file.size) || file.size <= 0 ||
        file.size > MAX_DELIVERY_FILE_BYTES) {
      throw codeError('round2-item9-delivery-file-too-large');
    }
    return file.text();
  } catch (error) {
    if (error?.code === 'round2-item9-delivery-file-too-large') throw error;
    throw codeError('round2-item9-delivery-file-read-failed');
  }
}

function targetCandidates(rows) {
  const candidates = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const objectId = clean(row?.chatId);
    const revisionId = clean(row?.lastSnapshotId);
    const savedAt = clean(row?.lastCapturedAt);
    if (!objectId || !revisionId || !savedAt) continue;
    candidates.push({ objectId, revisionId, savedAt });
  }
  candidates.sort((left, right) =>
    right.savedAt.localeCompare(left.savedAt) ||
      left.revisionId.localeCompare(right.revisionId));
  return candidates;
}

function normalizedTargetPreference(raw) {
  if (!raw || typeof raw !== 'object' ||
      raw.schema !== BACKGROUND_SYNC_CONSTANTS.TARGET_SCHEMA ||
      raw.mode !== 'explicit' || !clean(raw.explicitObjectId)) {
    return Object.freeze({ mode: 'auto-latest', objectId: null });
  }
  return Object.freeze({
    mode: 'explicit',
    objectId: clean(raw.explicitObjectId)
  });
}

import {
  createChromeGenerationStore,
  createChromeP01MutationGate,
  createChromeP01WriterStanddown
} from './sync-writer-generation-chrome-v2.mjs';

export function createChromeBackgroundSyncRuntime({
  chromeApi = globalThis.chrome,
  indexedDBFactory = globalThis.indexedDB,
  cryptoImplementation = globalThis.crypto,
  archiveAuthority,
  findActiveStudioContexts,
  reconcileCore = globalThis.H2OSyncLinearReconcileCore,
  lockManager = globalThis.navigator?.locks,
  manualReceiveAuthority = () => false,
  manualApplyAuthority = () => false,
  p01MutationAdmission = null,
  /*
   * O1-T19. The writer-generation gate, injected so a caller must decide what
   * it observes. The default builds one over this runtime's own
   * chrome.storage.local - Chrome observes CHROME's record, so one platform's
   * readable store can never authorize the other platform's writes.
   */
  writerGenerationGate = createChromeP01MutationGate({
    storageArea: chromeApi?.storage?.local,
    seamName: 'chrome-background-p01-writer'
  })
} = {}) {
  if (!chromeApi?.storage?.local || !chromeApi?.alarms ||
      !indexedDBFactory || !cryptoImplementation ||
      !archiveAuthority ||
      typeof archiveAuthority.listWorkbenchRows !== 'function' ||
      typeof archiveAuthority.listSnapshots !== 'function' ||
      typeof archiveAuthority.loadSnapshot !== 'function' ||
      typeof archiveAuthority.importFullBundle !== 'function' ||
      typeof findActiveStudioContexts !== 'function' ||
      typeof manualReceiveAuthority !== 'function' ||
      typeof manualApplyAuthority !== 'function' ||
      !reconcileCore || typeof reconcileCore.reconcileOneObject !== 'function') {
    throw codeError('background-sync-runtime-unavailable');
  }

  let generation = 0;
  let inFlight = null;
  let queued = false;
  let installed = false;
  let currentDirectoryHandle = null;
  let repositoryHandleScopeDepth = 0;
  let lastResult = null;
  let lastWriterDiscovery = Object.freeze({
    configuredCount: 0,
    knownWriterCount: 0,
    unknownWriterCount: 0,
    unknownWriterKeys: Object.freeze([]),
    configuredWriters: Object.freeze([]),
    trustedAdvertisementCount: 0,
    outcome: 'not-run'
  });
  let lastReceiveReport = null;
  let lastManualApplyResult = null;
  let manualApplyEligibility = null;
  const removers = [];
  const mutationAdmission = p01MutationAdmission ||
    createChromeP01MutationAdmission({ lockManager });
  const writerStanddown = createChromeP01WriterStanddown({
    storageArea: chromeApi?.storage?.local,
    lockManager,
    p01MutationAdmission: mutationAdmission,
    cryptoImplementation
  });

  const identityProvider = Object.freeze({
    async whenSyncReady() {
      const rows = await storageGet(
        chromeApi,
        BACKGROUND_SYNC_CONSTANTS.IDENTITY_KEY
      );
      const identity = rows[BACKGROUND_SYNC_CONSTANTS.IDENTITY_KEY];
      if (!identity) throw codeError('round2-item9-identity-unavailable');
      return identity;
    }
  });

  const syncStore = createChromeSyncObjectStore({
    identityProvider,
    indexedDBFactory,
    cryptoImplementation
  });
  const archiveAdapter = createChromeArchiveProjectionAdapter({
    archiveAuthority
  });
  const projection = createChromeLocalPublicationProjection({
    stores: archiveAdapter.stores,
    relationshipProbe: archiveAdapter.relationshipProbe,
    identityProvider,
    cryptoImplementation
  });

  const p02Publication = createChromeP02PublicationOwner({
    loadContainerHandle: () => readPersistedDirectoryHandle(indexedDBFactory),
    identityProvider,
    configProvider: async () => {
      const rows = await storageGet(chromeApi, BACKGROUND_SYNC_CONSTANTS.CONFIG_KEY);
      return rows[BACKGROUND_SYNC_CONSTANTS.CONFIG_KEY] ?? null;
    },
    writerGenerationGate,
    archiveAuthority,
    projection,
    syncStore,
    lockManager,
    cryptoImplementation,
    /* Both branches build through the one canonical constructor below. The
     * branch is only about whether a repository handle scope has to be opened
     * first; it is not a second observation authority. Two independently
     * configured constructions here is exactly how the gate the runtime
     * enforces and the observation W-2b reports could drift apart. */
    observeFormat: ({ writer, allowWriterGenerationAbsent = false }) => {
      const options = {
        writerKey: writer.writerKey,
        requireRepositoryGenerationP02: !allowWriterGenerationAbsent
      };
      if (!currentDirectoryHandle) {
        return withRepositoryHandleScope(
          () => buildRepositoryObservation(options).observe());
      }
      return buildRepositoryObservation(options).observe();
    }
  });

  async function resolveCanonicalAnchor(objectId) {
    const rows = await archiveAuthority.listWorkbenchRows();
    const matching = (Array.isArray(rows) ? rows : []).filter((row) =>
      clean(row?.chatId) === clean(objectId));
    if (matching.length === 0) return null;
    if (matching.length !== 1) {
      throw codeError('canonical-state-contradiction');
    }
    return projection.resolveCanonicalAnchor({ objectId, ledger: syncStore });
  }

  async function readCanonicalState(objectId) {
    const rows = await archiveAuthority.listWorkbenchRows();
    const matching = (Array.isArray(rows) ? rows : []).filter((row) =>
      clean(row?.chatId) === clean(objectId));
    if (matching.length === 0) return null;
    if (matching.length !== 1) throw codeError('canonical-state-contradiction');
    return projection.projectCurrent(objectId);
  }

  async function readMode() {
    const rows = await storageGet(chromeApi, BACKGROUND_SYNC_CONSTANTS.CONFIG_KEY);
    const config = rows[BACKGROUND_SYNC_CONSTANTS.CONFIG_KEY];
    if (!config || config.schemaVersion !== 1) return 'manual';
    /* MODE_VOCABULARY_ALIGNMENT: an explicit `off` is reported as `off`, not
     * silently rewritten to `manual`. Every automatic gate below tests for
     * `auto` alone, so `off` remains ineligible and the alarm stays cleared. */
    if (config.mode === 'off') return 'off';
    return ['manual', 'notify', 'auto'].includes(config.mode)
      ? config.mode
      : 'manual';
  }

  async function automaticAuthority() {
    return await readMode() === 'auto';
  }

  const writer = createChromeLocalPublicationWriter({
    projection,
    ledger: syncStore,
    folderAuthority: Object.freeze({
      getConnectedDirectoryHandle() {
        return currentDirectoryHandle;
      }
    }),
    cryptoImplementation,
    userActivation: () => false,
    automaticAuthority,
    /*
     * O1-B2.1. The gate must be INJECTED here, not merely constructed above.
     * The writer's own default is a permissive stub - the compatibility
     * position for a pre-T19 caller - so a composition that builds a gate and
     * then forgets to hand it over publishes through the stub and is not gated
     * at all. This is the background lane's every automatic publication.
     */
    writerGenerationGate,
    p01MutationAdmission: mutationAdmission
  });
  const admission = createInjectedRevisionAdmission({
    observationStore: syncStore,
    canonicalAnchorProvider: resolveCanonicalAnchor,
    cryptoImplementation
  });
  const delivery = createBrowserDeliveryRuntime({
    observationStore: syncStore,
    admission,
    cryptoImplementation
  });
  const apply = createChromeRevisionApply({
    syncStore,
    archiveAuthority,
    canonicalAnchorProvider: resolveCanonicalAnchor,
    cryptoImplementation
  });

  async function generationMayMutate(expectedGeneration) {
    return expectedGeneration === generation &&
      await automaticAuthority() === true &&
      expectedGeneration === generation;
  }

  async function resolveDurableObjectId() {
    const recovery = await syncStore.listLocalPublicationRecoveryObjects();
    if (recovery.length > 1) {
      throw codeError('background-sync-multiple-publication-intents');
    }
    if (recovery.length === 1) {
      if (recovery[0].state === 'terminal-unresolved') {
        throw codeError('local-publication-pending-unresolved');
      }
      return recovery[0].objectId;
    }
    const [targetRows, archiveRows] = await Promise.all([
      storageGet(chromeApi, BACKGROUND_SYNC_CONSTANTS.TARGET_KEY),
      archiveAuthority.listWorkbenchRows()
    ]);
    const preference = normalizedTargetPreference(
      targetRows[BACKGROUND_SYNC_CONSTANTS.TARGET_KEY]
    );
    const candidates = targetCandidates(archiveRows);
    if (preference.mode === 'explicit') {
      const selected = candidates.find((candidate) =>
        candidate.objectId === preference.objectId);
      if (!selected) throw codeError('background-sync-target-unavailable');
      return selected.objectId;
    }
    return candidates[0]?.objectId || null;
  }

  async function receive() {
    try {
      const deliveryJsonText = await readDeliveryFile(currentDirectoryHandle);
      return await delivery.admitDeliveryPackage({ deliveryJsonText });
    } catch (error) {
      return Object.freeze({
        ok: false,
        verdict: 'blocked',
        errorCode: safeErrorCode(error)
      });
    }
  }

  async function directReconcile(expectedGeneration, admissionLease) {
    currentDirectoryHandle = await readPersistedDirectoryHandle(indexedDBFactory);
    try {
      await requireGrantedPermission(currentDirectoryHandle);
      const objectId = await resolveDurableObjectId();
      return await reconcileCore.reconcileOneObject({
        objectId,
        mayMutate: () => generationMayMutate(expectedGeneration),
        allowedReceiveAbsentCodes: new Set([
          'round2-item9-delivery-file-missing'
        ]),
        receive,
        apply: (selectedObjectId) =>
          apply.applyNextAdmittedRevision(selectedObjectId),
        resolveAnchor: resolveCanonicalAnchor,
        publish: (selectedObjectId, revisionId) =>
          writer.publishLocalRevisionAutomatically(
            selectedObjectId,
            revisionId,
            admissionLease
          )
      });
    } finally {
      currentDirectoryHandle = null;
    }
  }

  async function delegateToForeground(reason) {
    const response = await sendRuntimeMessage(chromeApi, {
      type: BACKGROUND_SYNC_CONSTANTS.FOREGROUND_MESSAGE,
      reason: clean(reason) || 'background-wake'
    });
    return response?.ok === true && response?.accepted === true;
  }

  async function contextsOrBlock() {
    const contexts = await findActiveStudioContexts();
    if (!Array.isArray(contexts)) {
      throw codeError('background-sync-context-ownership-unavailable');
    }
    return contexts;
  }

  async function executeWake(reason, expectedGeneration) {
    if (!await generationMayMutate(expectedGeneration)) {
      return Object.freeze({ ok: true, verdict: 'automatic-disabled' });
    }
    /* P02 automatic publication is N+1 only. The owner independently re-reads
     * mode, generation, P01 refusal, folder permission, repository generation,
     * candidate eligibility and CAS authority. Manual/notify therefore execute
     * zero P02 publication from an alarm or lifecycle wake. */
    let generationObservation;
    try { generationObservation = await writerGenerationGate.observe(); }
    catch (_) { return Object.freeze({ ok: false, verdict: 'generation-unreadable' }); }
    /* The canonical observer emits `recorded`; it has never emitted `present`.
     * Testing a token the producer cannot produce made this branch dead and
     * automatic publication unreachable behind a fail-closed verdict. Use the
     * exported constant so the two cannot drift apart again. */
    if (generationObservation?.state === P02_GENERATION_STATE.RECORDED &&
        generationObservation?.generation === P02_WRITER_GENERATION.P02) {
      return p02Publication.publishAutomaticDescendant();
    }
    if (generationObservation?.state !== 'absent-observed' &&
        generationObservation?.generation !== 'p01') {
      return Object.freeze({ ok: false, verdict: 'generation-unreadable' });
    }
    const firstContexts = await contextsOrBlock();
    if (firstContexts.length > 0) {
      if (await delegateToForeground(reason)) {
        return Object.freeze({
          ok: true,
          verdict: 'delegated-to-active-surface'
        });
      }
      throw codeError('background-sync-foreground-delegation-unavailable');
    }
    if (!lockManager || typeof lockManager.request !== 'function') {
      throw codeError('background-sync-cross-context-ownership-unavailable');
    }
    /* Lock order is always admission(shared) -> object-protocol(exclusive).
     * A standdown hold takes only admission(exclusive), so no inverse edge
     * exists and the drain cannot deadlock on the P01 object lock. */
    return mutationAdmission.run({
      label: 'chrome-background-auto-reconcile',
      generationCheck: () => writerGenerationGate.p01MayMutate(),
      operation: (admissionLease) => lockManager.request(
        BACKGROUND_SYNC_CONSTANTS.MUTATION_LOCK_NAME,
        { mode: 'exclusive' },
        async () => {
          if (!await generationMayMutate(expectedGeneration)) {
            return Object.freeze({ ok: true, verdict: 'automatic-disabled' });
          }
          const currentContexts = await contextsOrBlock();
          if (currentContexts.length > 0) {
            if (await delegateToForeground(reason)) {
              return Object.freeze({
                ok: true,
                verdict: 'delegated-to-active-surface'
              });
            }
            throw codeError('background-sync-foreground-delegation-unavailable');
          }
          const result = await directReconcile(
            expectedGeneration,
            admissionLease
          );
          return Object.freeze({ ok: true, reason: clean(reason), ...result });
        }
      )
    });
  }

  function wake(reason = 'unspecified') {
    if (inFlight) {
      queued = true;
      return inFlight;
    }
    const expectedGeneration = generation;
    inFlight = executeWake(reason, expectedGeneration)
      .catch((error) => Object.freeze({
        ok: false,
        verdict: 'blocked',
        errorCode: safeErrorCode(error)
      }))
      .then((result) => {
        lastResult = result;
        return result;
      })
      .finally(() => {
        inFlight = null;
        if (queued && expectedGeneration === generation) {
          queued = false;
          void wake('coalesced');
        }
      });
    return inFlight;
  }

  async function ensureAlarmForMode({ reconcileNow = false } = {}) {
    const mode = await readMode();
    if (mode !== 'auto') {
      await alarmClear(chromeApi, BACKGROUND_SYNC_CONSTANTS.ALARM_NAME);
      return Object.freeze({ mode, alarm: 'absent' });
    }
    const existing = await alarmGet(
      chromeApi,
      BACKGROUND_SYNC_CONSTANTS.ALARM_NAME
    );
    if (!existing || existing.periodInMinutes !==
        BACKGROUND_SYNC_CONSTANTS.ALARM_PERIOD_MINUTES) {
      chromeApi.alarms.create(BACKGROUND_SYNC_CONSTANTS.ALARM_NAME, {
        delayInMinutes: 1,
        periodInMinutes: BACKGROUND_SYNC_CONSTANTS.ALARM_PERIOD_MINUTES
      });
    }
    if (reconcileNow) void wake('mode-auto');
    return Object.freeze({ mode, alarm: 'enabled' });
  }

  function listen(event, listener) {
    if (!event || typeof event.addListener !== 'function') return;
    event.addListener(listener);
    removers.push(() => {
      try { event.removeListener(listener); } catch (_) { /* teardown only */ }
    });
  }

  function install() {
    if (installed) return false;
    installed = true;
    listen(chromeApi.alarms.onAlarm, (alarm) => {
      if (alarm?.name !== BACKGROUND_SYNC_CONSTANTS.ALARM_NAME) return;
      return wake('alarm');
    });
    listen(chromeApi.storage.onChanged, (changes, areaName) => {
      if (areaName !== 'local' || !changes ||
          !Object.prototype.hasOwnProperty.call(
            changes,
            BACKGROUND_SYNC_CONSTANTS.CONFIG_KEY
          )) return;
      generation += 1;
      queued = false;
      void ensureAlarmForMode({ reconcileNow: true });
    });
    listen(chromeApi.runtime.onStartup, () => {
      return ensureAlarmForMode({ reconcileNow: true });
    });
    listen(chromeApi.runtime.onInstalled, () => {
      return ensureAlarmForMode({ reconcileNow: true });
    });
    void ensureAlarmForMode({ reconcileNow: true });
    return true;
  }

  function teardown() {
    const draining = inFlight;
    generation += 1;
    queued = false;
    installed = false;
    removers.splice(0).forEach((remove) => remove());
    /* Teardown stops admission of future scheduled work and resolves only
     * after the currently admitted operation has settled and released its
     * shared admission lease. */
    return draining
      ? Promise.resolve(draining).then(() => undefined, () => undefined)
      : Promise.resolve();
  }

  /*
   * P02 Wave 1 / Z7: the single canonical P02 engine, composed here and shared
   * with the foreground through the same module. It is INACTIVE on real state
   * by construction: no repository has been through the governed V7/V8
   * activation campaign, so the Y-10 gate reports mayWrite=false and this
   * runtime enumerates and classifies without mutating anything. The accepted
   * P01 path above continues to own automatic publication until that campaign
   * quiesces it (frozen O.1).
   */
  /*
   * Unit W. The Chrome realm's repository capability, built once per pass from
   * the granted container handle. Every surface here is read-only: the FSA port
   * exposes read only, the shared reader requires only `read`, and the writer
   * transport is not imported at all - so there is no object in this file that
   * could publish even if something tried to call one.
   */
  /* One hasher, from the injected crypto implementation. */
  async function sha256HexBytes(bytes) {
    const digest = await cryptoImplementation.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, '0')).join('');
  }

  /*
   * W-2 pass scope.
   *
   * `currentDirectoryHandle` was bound only inside P01's directReconcile, so a
   * persisted and granted handle could exist while every explicit P02 pass
   * called repositoryReadSurfaces(), got null, and answered handle-absent. The
   * repository was unreachable because the pass never loaded it, not because
   * anything was missing. This binds the SAME persisted handle through the SAME
   * accepted reader, for the duration of ONE explicit pass, and clears it on
   * every outcome.
   *
   * Absence is not an error here. A pass with no usable handle runs exactly as
   * before and the gate fails closed on its own; repairing or demanding a
   * handle is not this seam's business.
   *
   * Permission is deliberately NOT consulted to decide whether to bind.
   * `requireGrantedPermission` throws, and refusing to bind on that throw would
   * report a revoked grant as `handle-absent` - permission loss disguised as
   * file absence, which is exactly the confusion the read transport exists to
   * prevent. The confined FSA surface already queries permission on every
   * acquisition and raises the typed p02-fsa-read-permission-blocked, which the
   * observation reports as `permission-absent`. So the handle is bound whenever
   * one is persisted, and the accepted surface decides. Nothing here requests
   * permission, and nothing here starts a pass.
   */
  async function loadRepositoryHandleForPass() {
    try {
      return await readPersistedDirectoryHandle(indexedDBFactory);
    } catch (_) {
      /* No row, or a handle the store can no longer vouch for. */
      return null;
    }
  }

  async function withRepositoryHandleScope(operation) {
    /*
     * An outer owner already holds the binding - a coalesced P02 caller handed
     * the in-flight promise, or P01's directReconcile. Reuse it and let that
     * owner clear it, so an inner scope can never unbind a running pass.
     */
    if (currentDirectoryHandle !== null || repositoryHandleScopeDepth > 0) {
      return operation();
    }
    repositoryHandleScopeDepth += 1;
    try {
      currentDirectoryHandle = await loadRepositoryHandleForPass();
      return await operation();
    } finally {
      currentDirectoryHandle = null;
      repositoryHandleScopeDepth -= 1;
    }
  }

  /*
   * W-2b. ONE construction of the accepted repository observation, used two
   * ways: the P02 runtime's `gate` takes `observation.gate`, and the read-only
   * accessor below returns the whole frozen record. Building it once is the
   * point - an accessor with its own construction could drift from the gate the
   * runtime actually enforces, and then W-2b would be observing something the
   * runtime does not use.
   *
   * It reaches only the confined FSA read surfaces and the chrome.storage
   * generation store, whose port exposes `read` and nothing else. No P02 object
   * store is constructed, opened or migrated on this path.
   */
  /* The single construction site. `writerKey` and `requireRepositoryGenerationP02`
   * are optional: omitted they fall to the constructor's own defaults (null and
   * false), which is precisely the shape the read-only W-2b accessor used before
   * the reverse-direction work needed a writer-scoped gate. So one builder now
   * serves both, and neither can be configured independently of the other. */
  function buildRepositoryObservation({
    writerKey,
    requireRepositoryGenerationP02
  } = {}) {
    const surfaces = repositoryReadSurfaces();
    return createChromeFormatObservation({
      repositoryStorage: surfaces?.repositoryStorage ?? null,
      legacyArtifactStorage: surfaces?.legacyArtifactStorage ?? null,
      generationStore: createChromeGenerationStore({
        storageArea: chromeApi?.storage?.local
      }),
      writerKey,
      requireRepositoryGenerationP02,
      sha256HexBytes
    });
  }

  function repositoryReadSurfaces() {
    if (!currentDirectoryHandle) return null;
    const fsa = createChromeFsaReadTransport({
      containerHandle: currentDirectoryHandle,
      sha256HexBytes
    });
    const repositoryStorage = fsa.repositoryStorage();
    return Object.freeze({
      fsa,
      repositoryStorage,
      legacyArtifactStorage: fsa.legacyArtifactStorage(),
      reader: createLocalReaderTransportPrimitives({
        storage: repositoryStorage, cryptoImplementation
      })
    });
  }

  async function configuredPeerRows() {
    const [identity, rows] = await Promise.all([
      identityProvider.whenSyncReady(),
      storageGet(chromeApi, BACKGROUND_SYNC_CONSTANTS.CONFIG_KEY)
    ]);
    return parseW2cConfiguredPeers({
      config: rows[BACKGROUND_SYNC_CONSTANTS.CONFIG_KEY] ?? null,
      localSyncPeerId: identity?.syncPeerId,
      cryptoImplementation
    });
  }

  async function discoverTrustedPeerAdvertisements(surfaces, peers) {
    const roots = await surfaces.fsa.listWriterRoots();
    const configured = new Set(peers.map((peer) => peer.writerKey));
    const unknown = roots.filter((writerKey) => !configured.has(writerKey));
    const rootSet = new Set(roots);
    const advertisements = [];
    const configuredWriters = [];
    for (const peer of peers) {
      if (!rootSet.has(peer.writerKey)) {
        configuredWriters.push(Object.freeze({
          syncPeerId: peer.syncPeerId,
          writerKey: peer.writerKey,
          status: 'writer-root-absent',
          advertisedHeadCount: 0
        }));
        continue;
      }
      let state;
      try {
        state = await surfaces.reader.readWriterState({
          writerSyncPeerId: peer.syncPeerId
        });
      } catch (error) {
        configuredWriters.push(Object.freeze({
          syncPeerId: peer.syncPeerId,
          writerKey: peer.writerKey,
          status: 'quarantined',
          reason: safeErrorCode(error, 'trusted-writer-advertisement-invalid'),
          advertisedHeadCount: 0
        }));
        continue;
      }
      if (state?.writerKey !== peer.writerKey || state?.status !== 'verified' ||
          !Array.isArray(state?.snapshot?.heads)) {
        configuredWriters.push(Object.freeze({
          syncPeerId: peer.syncPeerId,
          writerKey: peer.writerKey,
          status: state?.writerKey !== peer.writerKey
            ? 'writer-key-mismatch'
            : clean(state?.status) || 'unobservable',
          reason: clean(state?.reason) || null,
          advertisedHeadCount: 0
        }));
        continue;
      }
      let valid = true;
      for (const head of state.snapshot.heads) {
        if (head?.writerSyncPeerId !== peer.syncPeerId ||
            head?.objectKey !== await objectKeyHex(
              head?.objectDomain, head?.objectId, cryptoImplementation
            )) {
          valid = false;
          break;
        }
      }
      if (!valid) {
        configuredWriters.push(Object.freeze({
          syncPeerId: peer.syncPeerId,
          writerKey: peer.writerKey,
          status: 'quarantined',
          reason: 'trusted-writer-head-identity-mismatch',
          advertisedHeadCount: 0
        }));
        continue;
      }
      advertisements.push(Object.freeze({
        syncPeerId: peer.syncPeerId,
        writerKey: peer.writerKey,
        heads: Object.freeze(state.snapshot.heads.map((head) =>
          Object.freeze({ ...head })))
      }));
      configuredWriters.push(Object.freeze({
        syncPeerId: peer.syncPeerId,
        writerKey: peer.writerKey,
        status: 'verified',
        advertisedHeadCount: state.snapshot.heads.length
      }));
    }
    lastWriterDiscovery = Object.freeze({
      configuredCount: peers.length,
      knownWriterCount: roots.length - unknown.length,
      unknownWriterCount: unknown.length,
      unknownWriterKeys: Object.freeze([...unknown]),
      configuredWriters: Object.freeze(configuredWriters),
      trustedAdvertisementCount: advertisements.reduce(
        (sum, advertisement) => sum + advertisement.heads.length, 0
      ),
      outcome: configuredWriters.some((writer) => writer.status !== 'verified')
        ? 'configured-writer-advertisement-incomplete'
        : unknown.length > 0 ? 'unknown-writers-present' : 'complete'
    });
    return Object.freeze(advertisements);
  }

  /*
   * Built on first receive, not at construction. The worker is created in
   * contexts that never receive - install, alarm bookkeeping, diagnostics - and
   * a factory that demanded a writable storage area up front would refuse to
   * exist in all of them.
   */
  let receiveDependencies = null;
  function receiveParts() {
    if (receiveDependencies === null) {
      receiveDependencies = Object.freeze({
        tipMemo: createChromeVerifiedTipMemo({ storageArea: chromeApi?.storage?.local }),
        branchAdmission: createChromeV2BranchAdmission({
          evidenceStore: syncStore, sha256HexBytes
        })
      });
    }
    return receiveDependencies;
  }

  /*
   * The full read-only descriptor enumerator, replacing the ids-only seam. It
   * owns realm translation and nothing else: the classifier and the ancestry
   * model stay in the shared cores.
   */
  async function enumerateDescriptors() {
    const peers = await configuredPeerRows();
    if (peers.length === 0) {
      lastWriterDiscovery = Object.freeze({
        configuredCount: 0,
        knownWriterCount: 0,
        unknownWriterCount: 0,
        unknownWriterKeys: Object.freeze([]),
        configuredWriters: Object.freeze([]),
        trustedAdvertisementCount: 0,
        outcome: 'no-configured-peers'
      });
      return [];
    }
    const surfaces = repositoryReadSurfaces();
    const trustedPeerAdvertisements = surfaces === null
      ? []
      : await discoverTrustedPeerAdvertisements(surfaces, peers);
    const branchEvidenceReader = async ({ objectDomain, objectId }) => {
      const rows = typeof syncStore.listBranchEvidence === 'function'
        ? await syncStore.listBranchEvidence(objectId)
        : [];
      return branchIndexToClassifierInput({
        index: buildBranchIndex({
          objectId,
          records: (rows || []).map((record) => ({
            document: {
              objectDomain,
              objectId: record.objectId,
              revisionId: record.revisionId,
              previousRevisionId: record.parentRevisionId ?? null,
              previousRevisionBlobSha256:
                record.parentRevisionBlobSha256Hex ?? null,
              ...(record.closureType ? { closureType: record.closureType } : {})
            },
            revisionBlobSha256: record.revisionBlobSha256Hex
          })),
          allowUnresolvedParentHash: true
        })
      }).retainedEvidence;
    };
    const enumeration = await createChromeReadOnlyObjectEnumerator({
      archiveAuthority,
      canonicalProjection: projection,
      syncStore,
      configuredSyncPeerIds: peers.map((peer) => peer.syncPeerId),
      trustedPeerAdvertisements,
      branchEvidenceReader,
      cryptoImplementation
    }).enumerate();
    return enumeration?.descriptors ?? [];
  }

  async function descriptorFor(scope) {
    const descriptors = await enumerateDescriptors();
    return descriptors.find((entry) =>
      entry.objectId === scope.objectId && entry.objectDomain === scope.objectDomain) ?? null;
  }

  /*
   * The scheduler's load-bearing pre-dispatch revalidation intentionally
   * supplies only stable object scope, never a stale descriptor snapshot.
   * Rehydrate that scope through the canonical enumerator before classifying;
   * otherwise the final safety check sees an incomplete object and suppresses
   * every real runnable candidate.
   */
  async function classifyCurrentDescriptor(descriptorOrScope) {
    const descriptor = plainRecord(descriptorOrScope) &&
      Object.prototype.hasOwnProperty.call(descriptorOrScope, 'protocolState')
      ? descriptorOrScope
      : await descriptorFor(descriptorOrScope);
    const current = descriptor ?? descriptorOrScope;
    return Object.freeze({
      ...classifyObjectState(current),
      descriptor: current
    });
  }

  async function enumerateRuntimeDescriptors() {
    const descriptors = await enumerateDescriptors();
    if (manualApplyAuthority() !== true) {
      manualApplyEligibility = null;
      return descriptors;
    }
    const eligible = descriptors.filter((descriptor) => {
      const verdict = classifyObjectState(descriptor);
      return verdict.classification === 'remote-ahead' &&
        verdict.applyEligibleByEvidence === true &&
        clean(verdict.applyCandidateRevisionId) !== '';
    });
    manualApplyEligibility = eligible.length === 1
      ? Object.freeze({ status: 'selected', count: 1 })
      : Object.freeze({
        status: eligible.length === 0
          ? 'no-eligible-apply'
          : 'multiple-eligible-apply',
        count: eligible.length
      });
    return eligible.length === 1 ? eligible : [];
  }

  /*
   * W-2 receive. Every port is an existing accepted module; this function is
   * wiring, and deliberately holds no protocol logic of its own.
   *
   * `applyAuthority` is null. That is the stage control: the receive core
   * answers `no-apply-authority` at the handoff, so admission can complete
   * while canonical Apply structurally cannot.
   */
  function buildReceive(surfaces) {
    const { tipMemo, branchAdmission } = receiveParts();
    return createP02ReceiveComposition({
      configuredPeers: configuredPeerRows,
      readWriterState: (input) => surfaces.reader.readWriterState({
        writerSyncPeerId: input.syncPeerId
      }),
      readRevisionBytes: ({ objectKey, revisionBlobSha256 }) =>
        surfaces.fsa.readRevision({ objectKey, revisionBlobSha256 }),
      fetchAncestry: (input) => surfaces.reader.fetchAncestry(input),
      readAdmittedEvidence: async ({ objectId }) => {
        const rows = typeof syncStore.listBranchEvidence === 'function'
          ? await syncStore.listBranchEvidence(objectId)
          : [];
        return (rows || []).map((record) => ({
          revisionId: record.revisionId,
          revisionBlobSha256: record.revisionBlobSha256Hex,
          disposition: record.disposition
        }));
      },
      admitRevision: (input) => branchAdmission.admitV2Revision({
        revision: input.revision,
        revisionBlobBytes: input.revisionBlobBytes,
        protocolState: input.protocolState
      }),
      classifyObject: async (input) => {
        const descriptor = await descriptorFor(input);
        if (descriptor) return classifyObjectState(descriptor);
        const retained = typeof syncStore.listBranchEvidence === 'function'
          ? await syncStore.listBranchEvidence(input.objectId)
          : [];
        return classifyObjectState(branchIndexToClassifierInput({
          index: buildBranchIndex({
            objectId: input.objectId,
            records: (retained || []).map((record) => ({
              document: {
                objectDomain: input.objectDomain,
                objectId: record.objectId,
                revisionId: record.revisionId,
                previousRevisionId: record.parentRevisionId ?? null,
                previousRevisionBlobSha256: record.parentRevisionBlobSha256Hex ?? null,
                ...(record.closureType ? { closureType: record.closureType } : {})
              },
              revisionBlobSha256: record.revisionBlobSha256Hex
            })),
            allowUnresolvedParentHash: true
          })
        }));
      },
      anchorSetFor: async (scope) => {
        const descriptor = await descriptorFor(scope);
        return descriptor?.p02AnchorSet ?? createP02AnchorSet({ pairs: [] });
      },
      readTipMemo: (input) => tipMemo.read(input),
      writeTipMemo: (input) => tipMemo.record(input),
      protocolStateFor: async (scope) => {
        const descriptor = await descriptorFor(scope);
        return descriptor?.protocolState ?? {};
      },
      /* W-2: Apply structurally unavailable. W-3 injects the Chrome adapter. */
      applyAuthority: null
    });
  }

  const p02Runtime = createP02ObjectRuntime({
    peerId: BACKGROUND_SYNC_CONSTANTS.ALARM_NAME,
    clock: () => 0,
    enumerate: enumerateRuntimeDescriptors,
    classify: classifyCurrentDescriptor,
    retainedEvidenceFor: async (descriptor) => {
      if (typeof syncStore.listBranchEvidence !== 'function') return [];
      const rows = await syncStore.listBranchEvidence(descriptor.objectId);
      return (rows || []).map((record) => ({
        revisionId: record.revisionId,
        revisionBlobSha256: record.revisionBlobSha256Hex,
        revisionBytes: record.revisionBlobByteLength ?? 0,
        headBytes: 0
      }));
    },
    /*
     * Unit W: the real repository observation, fresh every pass. It replaces
     * `libraryInfo: null`, which could only ever answer mayWrite:false and so
     * described the reader rather than the repository.
     */
    gate: async () => (await buildRepositoryObservation().observe()).gate,
    /*
     * O1-T19. This reports MUTATION CAPABILITY, not presence.
     *
     * It used to be `installed === true`, which equates "the P01 writer exists
     * in this process" with "the P01 writer can write". Those come apart at
     * exactly the moment that matters: after the governed standdown P01 is
     * still installed and still loaded, but the generation record says p02 and
     * every P01 mutation path refuses. Reporting active there would keep P02
     * permanently blocked by a writer that cannot write - a deadlock caused by
     * measuring the wrong thing.
     *
     * An unobservable generation reports NOT active for the same reason: P01
     * fails closed under it, so P01 genuinely cannot mutate. Both lanes then
     * refuse, which is the correct fail-closed posture rather than a claim
     * that one of them is running.
     */
    p01WriterActive: async () => {
      if (installed !== true) return false;
      try {
        const verdict = await writerGenerationGate.p01MayMutate();
        return verdict?.permitted === true;
      } catch (_) {
        /* The gate itself failed. P01 fails closed under that, so it is not
         * mutation-capable, and reporting active would be a false claim. */
        return false;
      }
    },
    authority: async () => ({
      mode: await readMode(),
      valid: true,
      manualReceiveAdmission: manualReceiveAuthority() === true,
      manualApply: manualApplyAuthority() === true
    }),
    /*
     * Unit W: the real receive path, replacing the structural refusal. It
     * reads the peer's pointer, its heads snapshot and the advertised
     * revisions, proves ancestry, admits branch evidence and classifies - and
     * stops there, because W-2 supplies no apply authority.
     */
    reconcileOneObject: async (candidate, freshVerdict) => {
      const surfaces = repositoryReadSurfaces();
      if (surfaces === null) {
        return Object.freeze({
          ok: false, verdict: 'blocked', errorCode: 'repository-handle-absent',
          blockReason: 'transport'
        });
      }
      if (manualApplyAuthority() === true) {
        try {
          const peers = await configuredPeerRows();
          const descriptor = freshVerdict?.descriptor;
          const configuredPeer = peers.find((peer) =>
            peer.syncPeerId === descriptor?.syncPeerId);
          if (peers.length !== 1 || !configuredPeer) {
            throw codeError('p02-chrome-apply-v2-peer-authority-invalid');
          }
          const applyV2 = createChromeV2Apply({
            evidenceStore: syncStore,
            archiveAuthority,
            canonicalStateProvider: readCanonicalState,
            sha256HexBytes,
            readRevisionBytes: ({ objectKey, revisionBlobSha256 }) =>
              surfaces.fsa.readRevision({ objectKey, revisionBlobSha256 })
          });
          lastManualApplyResult = await applyV2.applySelectedAdmittedV2Revision({
            descriptor,
            classifierVerdict: freshVerdict,
            configuredPeer
          });
          return lastManualApplyResult;
        } catch (error) {
          lastManualApplyResult = Object.freeze({
            verdict: 'blocked',
            reason: safeErrorCode(error, 'p02-w3-apply-failed'),
            applied: false,
            canonicalMutated: false,
            outcome: 'blocked'
          });
          return lastManualApplyResult;
        }
      }
      const report = await buildReceive(surfaces).receivePass();
      lastReceiveReport = report;
      const match = (report?.objects ?? []).find((entry) =>
        entry.objectId === candidate?.objectId);
      if (report?.globalFailure) return report.globalFailure;
      return match?.result ?? Object.freeze({
        outcome: 'no-effect',
        stage: 'advertised-tips',
        reason: 'configured-object-not-advertised',
        blockReason: null
      });
    }
  });

  function diagnose() {
    return Object.freeze({
      ok: true,
      verdict: 'background-sync-reconcile-diagnostic',
      installed,
      generation,
      inFlight: !!inFlight,
      queued,
      lastResult,
      canonicalAuthorityKey: BACKGROUND_SYNC_CONSTANTS.CONFIG_KEY,
      alarmName: BACKGROUND_SYNC_CONSTANTS.ALARM_NAME,
      alarmPeriodMinutes: BACKGROUND_SYNC_CONSTANTS.ALARM_PERIOD_MINUTES,
      mutationLockName: BACKGROUND_SYNC_CONSTANTS.MUTATION_LOCK_NAME,
      permissionEscalation: false,
      latestJsonUsed: false,
      webdavRequired: false,
      p02: P02_BACKGROUND_COMPOSITION,
      p02GateState: p02Runtime.gateDecision()?.state ?? 'not-yet-read',
      p02Active: false,
      p02WriterDiscovery: lastWriterDiscovery
    });
  }

  /*
   * The P02 surface, with the repository bound for the duration of the two
   * entry points that actually reach it. Everything else - wake, gateDecision,
   * driverState, noteTransportRestored, scheduler - is passed through
   * untouched, because none of them reads the repository.
   */
  const p02PassScoped = Object.freeze({
    ...p02Runtime,
    runPass: (options = {}) => withRepositoryHandleScope(async () => {
      const manualApply = manualApplyAuthority() === true;
      if (manualApply) {
        lastManualApplyResult = null;
        /* A separately authorized Human retry must be able to inspect a
         * durable pending intent even if the prior attempt parked the
         * rebuildable operational retry memo at Infinity. Canonical pending
         * state and the fresh classifier remain the work authority. */
        p02Runtime.scheduler.dropRetryIndex();
      }
      const report = await p02Runtime.runPass(options);
      if (!manualApply) return report;
      const noSelection = manualApplyEligibility?.status;
      return Object.freeze({
        ...report,
        manualApplyResult: lastManualApplyResult ?? Object.freeze({
          verdict: noSelection || 'no-eligible-apply',
          reason: noSelection || 'no-eligible-apply',
          applied: false,
          canonicalMutated: false
        })
      });
    }),
    report: () => withRepositoryHandleScope(() => p02Runtime.report()),
    /*
     * W-2b: observe the repository and the generation authorities, and nothing
     * else.
     *
     * `report()` cannot serve this. Once a real gate answers mayRead, report()
     * continues into scheduler.buildCandidates() -> enumerate ->
     * listReadOnlyObjectIds() -> activeDatabase(), and that first store touch
     * migrates the P02 database v1 -> v4 and runs ensureAuthority in a
     * READWRITE transaction. From today's live v1 state that is a persistent
     * mutation, which is exactly what a W-2b observation must not perform.
     *
     * This accessor stops at the observation. It binds the persisted handle for
     * the call through the same accepted scope, hands back the frozen record the
     * gate itself is derived from, and clears the handle on every outcome. It
     * runs only when a caller invokes it: no timer, alarm or listener reaches
     * it, and it neither reads nor writes any P02 object store.
     */
    observeRepository: () =>
      withRepositoryHandleScope(() => buildRepositoryObservation().observe())
  });

  return Object.freeze({
    install,
    wake,
    ensureAlarmForMode,
    teardown,
    diagnose,
    standDownP01Writer: () => writerStanddown.standDownP01Writer(),
    publishLocalP02Revision: () => p02Publication.publishManual(),
    /*
     * Retire ONE exactly-named foreign-lane intent left behind by the retired
     * local-publication slot lane. Every binding value comes from the caller and
     * is checked against the stored row by the ledger owner, so this exposes no
     * discovery, no wildcard and no generic ledger mutation - only that one
     * typed transition.
     */
    retireLocalPublicationForeignIntent: (objectKey, revisionId, expectedStagedAt) =>
      syncStore.retireLocalPublicationForeignIntent(
        objectKey,
        revisionId,
        expectedStagedAt
      ),
    p02: p02PassScoped,
    p02Composition: P02_BACKGROUND_COMPOSITION,
    mapNativeStorageFailure,
    evaluateCapacity,
    __test: Object.freeze({
      readMode,
      readPersistedDirectoryHandle: () =>
        readPersistedDirectoryHandle(indexedDBFactory),
      requireGrantedPermission,
      resolveDurableObjectId,
      currentRepositoryHandle: () => currentDirectoryHandle,
      withRepositoryHandleScope,
      configuredPeerRows,
      lastWriterDiscovery: () => lastWriterDiscovery,
      lastReceiveReport: () => lastReceiveReport,
      lastManualApplyResult: () => lastManualApplyResult
    })
  });
}
