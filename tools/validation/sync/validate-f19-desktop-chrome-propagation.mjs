#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import vm from 'node:vm';
import { TextEncoder } from 'node:util';
import { webcrypto } from 'node:crypto';

const root = process.cwd();
const failures = [];

const folderImportFile = 'src-surfaces-base/studio/sync/folder-import.mv3.js';
const folderSyncFile = 'src-surfaces-base/studio/sync/folder-sync.tauri.js';
const autoExportFile = 'src-surfaces-base/studio/sync/auto-export.tauri.js';
const folderActionsFile = 'src-surfaces-base/studio/S0F3b. 🎬 Folders Actions - Studio.js';
const libraryIndexFile = 'src-surfaces-base/studio/S0F1c. 🎬 Library Index - Studio.js';
const librarySyncFile = 'src-surfaces-base/studio/S0F1h. 🎬 Library Sync - Studio.js';
const sidebarSectionsFile = 'src-surfaces-base/studio/S0Z1g. 🎬 Library Sidebar Sections - Studio.js';
const chromeLiveBackgroundFile = 'tools/product/extensions/chatgpt/chrome/chrome-live-background.mjs';
const contractFile = 'docs/systems/cross-platform/f19.2-chrome-desktop-automatic-propagation-contract.md';

function read(file) {
  return fs.readFileSync(path.join(root, file), 'utf8');
}

function exists(file) {
  return fs.existsSync(path.join(root, file));
}

function assert(condition, message) {
  if (!condition) failures.push(message);
}

function assertExists(file) {
  assert(exists(file), `${file}: missing`);
}

function assertContains(file, needle, label = needle) {
  const text = read(file);
  assert(text.includes(needle), `${file}: missing ${label}`);
}

function assertNotContains(file, needle, label = needle) {
  const text = read(file);
  assert(!text.includes(needle), `${file}: unexpectedly contains ${label}`);
}

function makeStorage(initial = {}) {
  const values = new Map(Object.entries(initial || {}));
  return {
    __values: values,
    local: {
      get(keys, callback) {
        const out = {};
        for (const key of Array.isArray(keys) ? keys : [keys]) {
          if (values.has(key)) out[key] = values.get(key);
        }
        callback(out);
      },
      set(items, callback) {
        for (const [key, value] of Object.entries(items || {})) values.set(key, value);
        if (callback) callback();
      }
    }
  };
}

function buildDesktopBundle() {
  return {
    schema: 'h2o.studio.fullBundle.v2',
    exportedAt: '2026-06-14T12:00:00.000Z',
    exportId: 'desktop-export-fixture',
    sequenceNumber: 8,
    previousExportId: 'desktop-export-prev',
    contentSha256: 'desktop-hash-fixture',
    exportedFromSurface: 'desktop-tauri',
    sourcePeerEnvelope: { peerIdHash: 'desktop-peer-hash', installIdHash: 'desktop-install-hash' },
    chatArchive: {
      schema: 'h2o.chatArchive.bundle.v1',
      exportedAt: '2026-06-14T12:00:00.000Z',
      catalogs: {
        categories: [{ id: 'desktop-category-id', name: 'Private Desktop Category', color: '#654321' }],
        labels: [{ id: 'desktop-label-id', name: 'Private Desktop Label' }],
        tags: [{ id: 'desktop-tag-id', name: 'Private Desktop Tag' }]
      },
      chats: [
        {
          chatId: 'desktop-chat-id-1',
          chatIndex: {
            title: 'Private Desktop Saved Title',
            state: { isSaved: true, isPinned: true },
            organization: {
              categoryId: 'desktop-category-id',
              folderId: 'desktop-folder-id',
              folderName: 'Private Desktop Folder',
              labelIds: ['desktop-label-id'],
              tagIds: ['desktop-tag-id'],
              projectId: 'desktop-project-id'
            }
          },
          snapshots: [{ snapshotId: 'desktop-snapshot-id-1', messages: [{ text: 'Private desktop message' }] }]
        },
        {
          chatId: 'desktop-chat-id-2',
          chatIndex: {
            title: 'Private Desktop Linked Title',
            state: { isLinked: true },
            organization: {}
          },
          snapshots: []
        },
        {
          chatId: 'desktop-chat-id-3',
          chatIndex: {
            title: 'Private Desktop Imported Shell Title',
            href: 'https://chatgpt.com/c/desktop-chat-id-3',
            organization: {}
          },
          snapshots: []
        }
      ]
    },
    chromeStorageLocal: {
      'h2o:prm:cgx:fldrs:state:data:v1': {
        schemaVersion: 1,
        exportedFrom: 'desktop-studio',
        folders: [{ id: 'desktop-folder-id', name: 'Private Desktop Folder', color: '#abcdef', source: 'studio-actions' }],
        items: { 'desktop-folder-id': ['desktop-chat-id-1'] }
      },
      'unsupported-private-key': { value: 'private unsupported value' }
    },
    libraryKv: [{ key: 'h2o:prm:cgx:library:labels', value: { bindings: { 'desktop-chat-id-1': ['desktop-label-id'] } } }],
    tombstones: [{ id: 'desktop-tombstone-id', chatId: 'desktop-chat-id-3' }],
    syncApplyEvents: { total: 1, events: [{ chatId: 'desktop-chat-id-1' }] },
    projects: [{ id: 'desktop-project-id', name: 'Private Desktop Project' }]
  };
}

function buildContext(options = {}) {
  const archiveCalls = [];
  const refreshReasons = [];
  const registryRecords = new Map();
  const parityCounts = options.parityCounts || { total: 3, saved: 1, linked: 1, pinned: 1, archived: 0, folders: 1, categories: 1 };
  const context = {
    console,
    TextEncoder,
    crypto: webcrypto,
    Date,
    setTimeout(callback) {
      if (typeof callback === 'function') callback();
      return 1;
    },
    clearTimeout() {},
    addEventListener() {},
    removeEventListener() {},
    CustomEvent: class CustomEvent {
      constructor(type, init) {
        this.type = type;
        this.detail = init && init.detail;
      }
    },
    H2O: {
      Studio: {
        platform: {
          env: { adapter: 'mv3' },
          messaging: {
            async send(channel, message) {
              archiveCalls.push({ channel, message });
              const op = message && message.req && message.req.op;
              const payload = message && message.req && message.req.payload;
              if (op === 'dryRunImportFullBundle') {
                return {
                  ok: true,
                  result: {
                    schema: 'h2o.studio.fullBundle.v2',
                    mode: 'dry-run',
                    plan: {
                      chats: { incoming: payload.bundle.chatArchive.chats.length, incomingSnapshots: 1, willImport: 2, willSkipDuplicates: 0 },
                      chromeStorageLocal: { incoming: Object.keys(payload.bundle.chromeStorageLocal).length, willImport: 1, deniedByPolicy: 0 },
                      libraryKv: { incoming: payload.bundle.libraryKv.length, willImport: 0, deniedByPolicy: 0 }
                    },
                    sample: {
                      newChatIds: ['should-not-leak']
                    }
                  }
                };
              }
              if (op === 'importFullBundle') {
                return {
                  ok: true,
                  result: {
                    schema: 'h2o.studio.fullBundle.v2',
                    mode: payload.mode,
                    chats: { importedChats: payload.bundle.chatArchive.chats.length, importedSnapshots: 1 },
                    chromeStorageLocal: {
                      written: 1,
                      skipped: 0,
                      folderStateMergeStats: {
                        'h2o:prm:cgx:fldrs:state:data:v1': {
                          incoming: 1,
                          created: 0,
                          refreshed: 1,
                          skippedStale: 0,
                          missingIncomingUpdatedAt: 0,
                          missingExistingUpdatedAt: 0
                        }
                      }
                    },
                    libraryKv: { written: 0, skipped: 0 }
                  }
                };
              }
              return { ok: false, error: `unexpected op ${op}` };
            }
          }
        },
        sync: {}
      },
      LibraryIndex: {
        async refresh(reason) {
          refreshReasons.push(reason);
          return { ok: true };
        },
        getAll() {
          return [{ id: 'row-1' }, { id: 'row-2' }];
        }
      }
    },
    chrome: {
      runtime: { id: 'chrome-extension-fixture', lastError: null },
      storage: makeStorage(options.chromeStorageLocal || {})
    },
    __archiveCalls: archiveCalls,
    __refreshReasons: refreshReasons,
    dispatchEvent() {}
  };
  context.H2O.ChatRegistry = {
    ready: Promise.resolve(),
    getRecord(chatId) {
      return registryRecords.get(String(chatId || '')) || null;
    },
    upsertRecord(record) {
      if (!record || !record.chatId) return null;
      const next = JSON.parse(JSON.stringify(record));
      registryRecords.set(String(record.chatId), next);
      return next;
    },
    listRecords() {
      return Array.from(registryRecords.values());
    }
  };
  context.H2O.Library = { ChatRegistry: context.H2O.ChatRegistry };
  context.__registryRecords = registryRecords;
  context.H2O.Studio.sync.libraryParity = {
    async captureSnapshot() {
      return {
        schema: 'h2o.studio.sync.library-parity-snapshot.v1',
        surface: 'chrome-studio',
        counts: parityCounts,
        fingerprints: { chats: 'hash-only-fixture' }
      };
    }
  };
  context.window = context;
  context.globalThis = context;
  return vm.createContext(context);
}

function buildLibrarySyncContext(initialStorage = {}) {
  const storage = makeStorage();
  storage.local.set(initialStorage);
  const context = {
    console,
    Date,
    performance: { now: () => 0 },
    setTimeout(callback) {
      if (typeof callback === 'function') callback();
      return 1;
    },
    clearTimeout() {},
    setInterval() { return 1; },
    clearInterval() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {},
    CustomEvent: class CustomEvent {
      constructor(type, init) {
        this.type = type;
        this.detail = init && init.detail;
      }
    },
    chrome: {
      runtime: { id: 'chrome-extension-fixture', lastError: null },
      storage: {
        ...storage,
        onChanged: {
          addListener() {},
          removeListener() {}
        }
      }
    },
    H2O: {
      Studio: {
        platform: { env: { adapter: 'mv3' } },
        sync: {}
      },
      Library: {},
      LibraryIndex: {
        async refresh() {
          return { ok: true };
        }
      },
      events: { emit() {} }
    }
  };
  context.window = context;
  context.globalThis = context;
  return vm.createContext(context);
}

async function runFolderMutationResolverVmProof() {
  const folderStateKey = 'h2o:prm:cgx:fldrs:state:data:v1';
  const importedFolderState = {
    schemaVersion: 1,
    source: 'stored-folder-state',
    sourceKind: 'chromeStorageLocal',
    folders: [
      {
        id: 'sport-folder-id',
        folderId: 'sport-folder-id',
        name: 'Sport',
        title: 'Sport',
        color: '#111111',
        iconColor: '#111111',
        source: 'desktop-sqlite',
        sourceKind: 'desktop-sqlite',
        kind: 'desktop-sqlite',
        materializedUserFolder: true,
        trustedFolderDisplay: true,
        shownInNormalMode: true,
        meta: {
          source: 'desktop-sqlite',
          sourceKind: 'desktop-sqlite',
          materializedUserFolder: true,
          trustedFolderDisplay: true,
          shownInNormalMode: true
        }
      },
      {
        id: 'unfiled',
        folderId: 'unfiled',
        name: 'Unfiled',
        title: 'Unfiled',
        source: 'stored-folder-state',
        sourceKind: 'known-canonical-display-fallback',
        kind: 'known-canonical-display-fallback',
        protectedCanonicalFallback: true,
        trustedFolderDisplay: true,
        meta: {
          protectedCanonicalFallback: true,
          trustedFolderDisplay: true,
          sourceKind: 'known-canonical-display-fallback'
        }
      }
    ],
    items: {
      'sport-folder-id': []
    }
  };
  const context = buildLibrarySyncContext({ [folderStateKey]: importedFolderState });
  vm.runInContext(read(librarySyncFile), context, { filename: librarySyncFile });
  const api = context.H2O.Studio.sync.folderMetadataOperations;
  assert(api && typeof api.request === 'function', 'folder metadata operations API missing');

  const operation = {
    schema: 'h2o.folder-metadata-operation.v1',
    operationType: 'change-folder-color',
    folderId: 'sport-folder-id',
    before: {
      id: 'sport-folder-id',
      folderId: 'sport-folder-id',
      name: 'Sport',
      color: '#111111',
      iconColor: '#111111',
      source: 'desktop-sqlite',
      sourceKind: 'desktop-sqlite',
      materializedUserFolder: true,
      trustedFolderDisplay: true,
      shownInNormalMode: true,
      isCanonical: true
    },
    after: { iconColor: '#00AA00' },
    sourceSurface: 'chrome-studio'
  };
  const preview = await api.request(operation, {
    requestMode: 'preview',
    requestId: 'chrome-local-color-preview-proof'
  });
  assert(preview.ok === true, 'Chrome imported folder color preview should pass');
  assert(preview.canApply === true, 'Chrome imported folder color preview should be applyable');
  assert(preview.chromeMutationRoute === 'studio-local', 'Chrome imported folder should resolve to studio-local route');
  assert(!preview.blockers.some((entry) => entry.code === 'folder-not-found'), 'Chrome imported folder preview must not emit folder-not-found');

  const applied = await api.request({ ...operation, staleGuard: preview.staleGuard }, {
    requestMode: 'apply',
    requestId: 'chrome-local-color-apply-proof'
  });
  assert(applied.ok === true, 'Chrome imported folder color apply should pass');
  assert(applied.applied === true, 'Chrome imported folder color apply should mutate');
  assert(applied.chromeMutationRoute === 'studio-local', 'Chrome imported folder apply should stay local');
  assert(applied.writesPerformed === 1, 'Chrome imported folder color apply should write one mirror update');
  assert(!applied.blockers.some((entry) => entry.code === 'folder-not-found'), 'Chrome imported folder apply must not emit folder-not-found');

  const stored = context.chrome.storage.__values.get(folderStateKey);
  const sport = stored.folders.find((row) => row.id === 'sport-folder-id');
  assert(sport && sport.iconColor === '#00AA00', 'Chrome folder-state mirror iconColor was not updated');
  assert(sport && sport.color === '#00AA00', 'Chrome folder-state mirror color was not updated');
  assert(sport && sport.meta && sport.meta.iconColor === '#00AA00', 'Chrome folder-state mirror meta iconColor was not updated');

  const protectedPreview = await api.request({
    schema: 'h2o.folder-metadata-operation.v1',
    operationType: 'change-folder-color',
    folderId: 'unfiled',
    before: {
      id: 'unfiled',
      folderId: 'unfiled',
      name: 'Unfiled',
      source: 'stored-folder-state',
      sourceKind: 'known-canonical-display-fallback',
      protectedCanonicalFallback: true,
      isCanonical: true
    },
    after: { iconColor: '#00AA00' },
    sourceSurface: 'chrome-studio'
  }, {
    requestMode: 'preview',
    requestId: 'chrome-protected-color-preview-proof'
  });
  const protectedCodes = protectedPreview.blockers.map((entry) => entry.code);
  assert(protectedPreview.ok === false, 'Protected folder color preview should be blocked');
  assert(protectedCodes.includes('protected-folder'), 'Protected folder should use protected-folder blocker');
  assert(!protectedCodes.includes('folder-not-found'), 'Protected folder must not emit folder-not-found');
}

async function runVmProof() {
  const source = read(folderImportFile);
  const context = buildContext();
  vm.runInContext(source, context, { filename: folderImportFile });
  const api = context.H2O.Studio.sync.folder;

  assert(api, 'Chrome folder sync API missing');
  assert(api.desktopChromePropagationSchema === 'h2o.studio.sync.chrome-desktop-propagation.v1', 'propagation schema marker mismatch');
  assert(api.desktopChromePropagationVersion === '0.1.0-f19.2.c', 'propagation version marker mismatch');
  assert(typeof api.importLatestBundle === 'function', 'importLatestBundle missing');

  const result = await api.importLatestBundle(buildDesktopBundle(), { fileFingerprint: 'sha256:test-fixture' });
  assert(result.schema === 'h2o.studio.sync.chrome-desktop-propagation.v1', 'result schema mismatch');
  assert(result.version === '0.1.0-f19.2.c', 'result version mismatch');
  assert(result.direction === 'desktop-to-chrome', 'direction mismatch');
  assert(result.transport === 'latest.json', 'transport mismatch');
  assert(result.ok === true, 'propagation proof should pass');
  assert(result.status === 'imported', 'propagation status should be imported');
  assert(result.sourceSummary.chatCount === 3, 'source chat count mismatch');
  assert(result.sourceSummary.savedCount === 1, 'source saved count mismatch');
  assert(result.sourceSummary.linkedCount === 1, 'source linked count mismatch');
  assert(result.sourceSummary.pinnedCount === 1, 'source pinned count mismatch');
  assert(result.sourceSummary.shellRowCount === 2, 'source shell row count mismatch');
  assert(result.sourceSummary.linkedOnlyCount === 1, 'source linked-only shell count mismatch');
  assert(result.sourceSummary.importedShellCount === 1, 'source imported shell count mismatch');
  assert(result.importSummary.shellRowsIncoming === 2, 'shell row incoming count mismatch');
  assert(result.importSummary.shellRowsMaterialized === 2, 'shell row materialized count mismatch');
  assert(result.importSummary.shellRowsFailed === 0, 'shell row failure count mismatch');
  assert(result.importSummary.folderMetadataFreshness.refreshed === 1, 'Desktop->Chrome newer folder metadata refresh summary missing');
  assert(result.importSummary.folderMetadataFreshness.skippedStale === 0, 'Desktop->Chrome folder metadata should not be stale in fixture');
  assert(result.convergence && result.convergence.ok === true, 'desktop-to-chrome convergence should be proven');
  assert(Array.isArray(result.redactedErrorCategories), 'redacted error categories missing');
  assert(result.redactedErrorCategories.length === 0, 'redacted error categories should be empty on success');
  assert(result.supportedFields.includes('saved-chat-records'), 'saved chats not marked supported');
  assert(result.supportedFields.includes('linked-chat-records'), 'linked chats not marked supported');
  assert(result.supportedFields.includes('folder-metadata'), 'folder metadata not marked supported');
  assert(result.supportedFields.includes('category-metadata'), 'category metadata not marked supported');
  for (const code of [
    'library-propagation-labels-deferred',
    'library-propagation-tags-deferred',
    'library-propagation-projects-deferred',
    'library-propagation-chat-folder-bindings-deferred',
    'library-propagation-tombstones-deferred',
    'library-propagation-apply-events-deferred',
    'library-propagation-unsupported-storage-deferred'
  ]) {
    assert(result.warnings.includes(code), `result missing warning ${code}`);
  }
  assert(result.privacy.rawIdsReturned === false, 'raw ID privacy flag should remain false');
  assert(result.privacy.rawTitlesReturned === false, 'raw title privacy flag should remain false');
  assert(result.privacy.rawContentReturned === false, 'raw content privacy flag should remain false');
  assert(result.sideEffects.desktopSqliteWritten === false, 'Desktop SQLite should not be written by Chrome import');
  assert(result.sideEffects.nativeCalled === false, 'Native should not be called by propagation proof');
  assert(result.parity.snapshotCaptured === true, 'parity snapshot should be captured');
  assert(context.__registryRecords.has('desktop-chat-id-2'), 'Desktop shell row was not materialized into ChatRegistry');
  assert(context.__registryRecords.has('desktop-chat-id-3'), 'Desktop imported shell row was not materialized into ChatRegistry');

  const approved = await api.importLatestBundle(buildDesktopBundle(), {
    fileFingerprint: 'sha256:test-fixture-approval',
    conflictDecision: 'approve-merge',
    conflictApproved: true,
    approvedConflictBlockers: ['library-propagation-simultaneous-update-conflict']
  });
  assert(approved.ok === true, 'operator-approved merge fixture should still pass');
  assert(approved.conflictDecision === 'approve-merge', 'approved merge conflictDecision missing');
  assert(approved.conflictApproved === true, 'approved merge conflictApproved missing');
  assert(approved.conflictApproval?.staleTransportStillBlocks === true, 'approved merge must preserve stale blocking');
  assert(approved.conflictApproval?.duplicateIdempotencyPreserved === true, 'approved merge must preserve duplicate idempotency');
  assert(approved.warnings.includes('library-propagation-simultaneous-conflict-approved'), 'approved merge warning missing');

  const folderOnlyContext = buildContext({
    parityCounts: { total: 17, saved: 7, linked: 10, pinned: 0, archived: 3, folders: 0, categories: 0 }
  });
  vm.runInContext(source, folderOnlyContext, { filename: folderImportFile });
  const folderOnly = await folderOnlyContext.H2O.Studio.sync.folder.importLatestBundle(buildDesktopBundle(), {
    fileFingerprint: 'sha256:test-folder-metadata-convergence',
    conflictDecision: 'approve-merge'
  });
  assert(folderOnly.ok === true, 'folder metadata import should not be blocked by active row/facet parity mismatches');
  assert(folderOnly.blockers.length === 0, 'folder metadata import should not emit convergence blockers');
  assert(folderOnly.folderMetadataCount === 1, 'top-level folder metadata count missing');
  assert(folderOnly.folderStateSource === 'chromeStorageLocal', 'top-level folder state source missing');
  assert(folderOnly.convergence?.folderMetadata?.ok === true, 'folder metadata convergence lane should pass');
  assert(folderOnly.convergence?.activeRowConvergenceDeferred === true, 'active row mismatch should be deferred after folder metadata convergence');
  assert(Number(folderOnly.convergence?.nonBlockingMismatchCount || 0) > 0, 'non-blocking mismatch diagnostics should be present');
  assert(!folderOnly.blockers.includes('desktop-to-chrome-convergence-not-proven'), 'folder metadata import should not keep the row convergence blocker');

  const noFolderBundle = JSON.parse(JSON.stringify(buildDesktopBundle()));
  delete noFolderBundle.chromeStorageLocal['h2o:prm:cgx:fldrs:state:data:v1'];
  const noFolderContext = buildContext({
    parityCounts: { total: 17, saved: 7, linked: 10, pinned: 0, archived: 3, folders: 0, categories: 0 }
  });
  vm.runInContext(source, noFolderContext, { filename: folderImportFile });
  const noFolderResult = await noFolderContext.H2O.Studio.sync.folder.importLatestBundle(noFolderBundle, {
    fileFingerprint: 'sha256:test-no-folder-metadata-convergence',
    conflictDecision: 'approve-merge'
  });
  assert(noFolderResult.ok === false, 'row parity mismatches must still block when no folder metadata lane applies');
  assert(noFolderResult.blockers.includes('desktop-to-chrome-convergence-not-proven'), 'no-folder import should keep the row convergence blocker');
  assert(noFolderResult.convergence?.activeRowConvergenceDeferred === false, 'no-folder import must not defer active row convergence');

  const importCall = context.__archiveCalls.find((entry) => entry.message.req.op === 'importFullBundle');
  assert(importCall, 'importFullBundle was not called');
  const payload = importCall.message.req.payload;
  assert(payload.mode === 'merge', 'import mode must be merge');
  assert(payload.bundle.chatArchive.chats.length === 3, 'chat count should be preserved');
  assert(payload.bundle.chatArchive.catalogs.categories.length === 1, 'category count should be preserved');
  assert(payload.bundle.chatArchive.catalogs.labels.length === 0, 'labels must be stripped');
  assert(payload.bundle.libraryKv.length === 0, 'libraryKv must be stripped');
  assert(Object.keys(payload.bundle.chromeStorageLocal).length === 1, 'unsupported chromeStorageLocal keys must be stripped');
  const folderState = payload.bundle.chromeStorageLocal['h2o:prm:cgx:fldrs:state:data:v1'];
  assert(folderState.folders.length === 1, 'folder metadata should be preserved');
  assert(folderState.folders[0].userCreated === true, 'Studio-created folder metadata should be user-created');
  assert(folderState.folders[0].materializedUserFolder === true, 'Studio-created folder metadata should be materialized');
  assert(folderState.folders[0].trustedFolderDisplay === true, 'Studio-created folder metadata should be trusted for display');
  assert(folderState.folders[0].shownInNormalMode === true, 'Studio-created folder metadata should be normal-mode visible');
  assert(Object.keys(folderState.items).length === 0, 'chat-folder bindings must be deferred');
  const org = payload.bundle.chatArchive.chats[0].chatIndex.organization;
  assert(org.categoryId === 'desktop-category-id', 'chat category binding should be preserved for importer');
  assert(!Object.prototype.hasOwnProperty.call(org, 'folderId'), 'folderId must be stripped from chat organization');
  assert(!Object.prototype.hasOwnProperty.call(org, 'folderName'), 'folderName must be stripped from chat organization');
  assert(!Object.prototype.hasOwnProperty.call(org, 'labelIds'), 'labels must be stripped from chat organization');
  assert(!Object.prototype.hasOwnProperty.call(org, 'tagIds'), 'tags must be stripped from chat organization');
  assert(!Object.prototype.hasOwnProperty.call(org, 'projectId'), 'project must be stripped from chat organization');
  assert(context.__refreshReasons.includes('desktop-chrome-propagation-import'), 'LibraryIndex refresh was not requested');

  const noChangeContext = buildContext({
    chromeStorageLocal: {
      'h2o:prm:cgx:fldrs:state:data:v1': {
        schemaVersion: 1,
        exportedFrom: 'desktop-studio',
        folders: [{ id: 'desktop-folder-id', name: 'Private Desktop Folder', color: '#abcdef', source: 'studio-actions' }],
        items: {}
      }
    }
  });
  vm.runInContext(source, noChangeContext, { filename: folderImportFile });
  const noChangeResult = await noChangeContext.H2O.Studio.sync.folder.importLatestBundle(buildDesktopBundle(), {
    fileFingerprint: 'sha256:test-no-folder-refresh-suppression'
  });
  assert(noChangeResult.ok === true, 'no-change folder import should still complete');
  assert(noChangeResult.postImportRefresh?.mode === 'no-folder-metadata-change', 'no-change folder import should use no-folder-metadata-change mode');
  assert(noChangeResult.postImportRefresh?.changedFolderCount === 0, 'no-change folder import should report zero changed folders');
  assert(noChangeResult.postImportRefresh?.renderRefreshCount === 0, 'no-change folder import should not render refresh');
  assert(noChangeResult.postImportRefresh?.refreshSuppressed === true, 'no-change folder import should report refresh suppression');
  assert(!noChangeContext.__refreshReasons.includes('desktop-chrome-propagation-import'), 'no-change folder import must not refresh LibraryIndex');

  const latestJsonReadResult = await api.importLatestBundle({ reason: 'chrome-import-desktop-latest-folder-sport-proof' });
  assert(latestJsonReadResult.status === 'sync-folder-not-connected', 'options-only importLatestBundle should read latest.json via syncNow when no folder is connected');
  assert(!String(latestJsonReadResult.blockers || '').includes('library-propagation-schema-invalid'), 'options-only importLatestBundle must not treat options as a bundle payload');
  assert(!String(latestJsonReadResult.blockers || '').includes('transport-schema-unsupported'), 'options-only importLatestBundle must not report schema unsupported before reading latest.json');

  const publicResult = JSON.stringify(result);
  for (const forbidden of [
    'desktop-chat-id-1',
    'desktop-snapshot-id-1',
    'desktop-folder-id',
    'desktop-category-id',
    'Private Desktop Saved Title',
    'Private desktop message',
    'Private Desktop Folder',
    'Private Desktop Label',
    'Private Desktop Category',
    'Private Desktop Project',
    'chat_id',
    'folder_id',
    'category_id',
    'should-not-leak'
  ]) {
    assert(!publicResult.includes(forbidden), `public result leaked ${forbidden}`);
  }
}

for (const file of [folderImportFile, folderSyncFile, autoExportFile, folderActionsFile, libraryIndexFile, librarySyncFile, sidebarSectionsFile, chromeLiveBackgroundFile, contractFile]) assertExists(file);

if (failures.length === 0) {
  assertContains(folderImportFile, 'h2o.studio.sync.chrome-desktop-propagation.v1', 'propagation schema');
  assertContains(folderImportFile, '0.1.0-f19.2.c', 'propagation version');
  assertContains(folderImportFile, 'importLatestBundle', 'bundle API');
  assertContains(folderImportFile, 'shouldTreatAsLatestJsonImportOptions', 'options-only latest.json import wrapper');
  assertContains(folderImportFile, 'importDesktopBundlePayload', 'low-level bundle payload importer');
  assertContains(folderImportFile, 'folderMetadataCount', 'folder metadata source summary');
  assertContains(folderImportFile, 'folderFacetConvergenceRequired', 'folder metadata separated from active row facet convergence');
  assertContains(folderImportFile, 'evaluateFolderMetadataConvergence', 'folder metadata convergence lane');
  assertContains(folderImportFile, 'activeRowConvergenceDeferred', 'non-blocking active row mismatch diagnostics');
  assertContains(folderImportFile, 'nonBlockingMismatches', 'redacted non-blocking mismatch diagnostics');
  assertContains(folderImportFile, 'desktop-to-chrome-folder-metadata-convergence-not-proven', 'folder metadata convergence blocker');
  assertContains(folderImportFile, 'materializedUserFolder = true', 'Studio-created folder materialization stamping');
  assertContains(folderImportFile, 'dryRunImportFullBundle', 'dry run archive API');
  assertContains(folderImportFile, 'importFullBundle', 'import archive API');
  assertContains(folderImportFile, "mode: 'merge'", 'merge import mode');
  assertContains(folderImportFile, 'folderMetadataFreshness', 'redacted folder metadata freshness summary');
  assertContains(folderImportFile, 'library-propagation-labels-deferred', 'label deferred taxonomy');
  assertContains(folderImportFile, 'library-propagation-chat-folder-bindings-deferred', 'folder binding deferred taxonomy');
  assertContains(folderImportFile, 'library-propagation-tombstones-deferred', 'tombstone deferred taxonomy');
  assertContains(folderImportFile, 'library-propagation-apply-events-deferred', 'apply events deferred taxonomy');
  assertContains(folderImportFile, 'chromeStorageMayWriteSupportedRows', 'Chrome side-effect marker');
  assertContains(folderImportFile, 'autoSyncEnabled: true', 'Chrome latest.json auto-import defaults enabled for connected sync folder');
  assertContains(folderImportFile, 'chromeAutoImport', 'Chrome auto-import diagnostic object');
  assertContains(folderImportFile, 'desktop-shell-row-import-unsupported', 'Desktop shell row blocker');
  assertContains(folderImportFile, 'desktop-to-chrome-convergence-not-proven', 'Desktop to Chrome convergence blocker');
  assertContains(folderImportFile, 'conflictDecision', 'operator conflict decision');
  assertContains(folderImportFile, 'approve-merge', 'operator-approved merge decision');
  assertContains(folderImportFile, 'library-propagation-simultaneous-conflict-approved', 'operator-approved merge warning');
  assertContains(folderImportFile, 'redactedErrorCategories', 'redacted import error categories');
  assertContains(libraryIndexFile, 'readDurableBundleShellRows', 'durable shell row reload reader');
  assertContains(libraryIndexFile, 'desktop-sync-folder-rehydrate', 'Desktop shell row rehydration source');
  assertContains(libraryIndexFile, 'durableBundleShellRowsRehydrated', 'durable rehydration diagnostic');
  assertContains(autoExportFile, 'exportLatestSyncBundle', 'Desktop latest.json exporter');
  assertContains(autoExportFile, 'folderMutationAutoSyncEnabled: true', 'Desktop folder mutation auto-export lane defaults enabled');
  assertContains(autoExportFile, 'autoRunOnFolderMutation', 'Desktop folder mutation auto-export diagnostic');
  assertContains(autoExportFile, "source: 'folder-metadata-operation'", 'explicit Desktop folder mutation schedules record lastChange');
  assertContains(autoExportFile, "status: missing.length ? 'auto-export-subscriptions-partially-wired' : 'auto-export-subscriptions-wired'", 'auto-export retryable partial subscription wiring');
  assertContains(folderSyncFile, 'exportDesktopLatestForChrome', 'Desktop folder.syncNow desktop-to-chrome export branch');
  /* The default (absent) config is deliberately unconfigured: a fresh Desktop
   * identity with no persisted 'h2o:studio:sync:config:v1' must not auto-start
   * the watcher or auto-import from the shared HOME-relative sync folder.
   * Automatic import remains fully available to an explicitly persisted auto
   * mode, which still resolves the default sync folder. Behavioral proof lives
   * in validate-folder-sync-fresh-desktop-bootstrap-isolation.mjs. */
  assertContains(folderSyncFile, "if (merged.mode === 'auto' && !merged.folderPath) merged.folderPath = SYNC_FOLDER_NAME;", 'Desktop explicit auto import mode resolves the default sync folder');
  assertContains(folderSyncFile, "if ((cfg.mode === 'notify' || cfg.mode === 'auto') && cfg.folderPath) {", 'Desktop boot auto-starts the watcher for a configured notify/auto mode');
  assertContains(folderSyncFile, "supportedDirections: ['chrome-to-desktop', 'desktop-to-chrome']", 'Desktop folder syncNow bidirectional direction marker');
  assertContains(folderSyncFile, 'desktopWritesLatestJson: true', 'Desktop folder facade latest.json write marker');
  assertContains(folderActionsFile, 'scheduleDesktopLatestExport', 'folder metadata action auto-export scheduling hook');
  assertContains(folderActionsFile, "scheduleDesktopLatestExport('update', folderId)", 'folder color/update schedules Desktop latest.json export');
  assertContains(folderActionsFile, "updatedAt: renamedAt", 'Desktop rename stamps fresh folder metadata updatedAt');
  assertContains(folderActionsFile, "scheduleDesktopLatestExport('rename', folderId)", 'folder rename schedules Desktop latest.json export');
  assertContains(sidebarSectionsFile, 'scheduleDesktopFolderEditorAutoExport', 'Desktop sidebar folder editor schedules latest.json export after confirmed mutation');
  assertContains(sidebarSectionsFile, 'folder-metadata:desktop-sidebar-', 'Desktop sidebar folder editor uses folder-metadata auto-export lane');
  assertContains(librarySyncFile, 'requestDesktopFolderMetadataOperation', 'Desktop folder metadata operation bridge');
  assertContains(librarySyncFile, 'previewDesktopRenameFolderMetadataOperation', 'Desktop rename-folder preview bridge');
  assertContains(librarySyncFile, 'applyDesktopRenameFolderMetadataOperation', 'Desktop rename-folder apply bridge');
  assertContains(librarySyncFile, 'previewDesktopColorFolderMetadataOperation', 'Desktop change-folder-color preview bridge');
  assertContains(librarySyncFile, 'applyDesktopColorFolderMetadataOperation', 'Desktop change-folder-color apply bridge');
  assertContains(librarySyncFile, "DESKTOP_FOLDER_METADATA_SUPPORTED_OPERATION_TYPES = ['rename-folder', 'change-folder-color']", 'Desktop bridge supports only rename and color operations');
  assertContains(librarySyncFile, 'stale-guard-required', 'Desktop rename apply stale guard');
  assertContains(librarySyncFile, 'protected-canonical-folder-name', 'Desktop rename protected canonical name guard');
  assertContains(librarySyncFile, 'invalid-folder-color', 'Desktop color hex guard');
  assertContains(librarySyncFile, 'desktopRenameFallbackStatus', 'Desktop rename diagnostic status');
  assertContains(librarySyncFile, 'desktopRenameResultCount', 'Desktop rename diagnostic count');
  assertContains(librarySyncFile, 'desktopColorFallbackStatus', 'Desktop color diagnostic status');
  assertContains(librarySyncFile, 'desktopColorResultCount', 'Desktop color diagnostic count');
  assertContains(librarySyncFile, 'requestChromeFolderMetadataOperationIfLocal', 'Chrome local folder metadata mutation resolver');
  assertContains(librarySyncFile, 'scheduleChromeFolderAutoExport', 'Chrome confirmed folder mutations schedule chrome-latest export');
  assertContains(librarySyncFile, 'previewChromeColorFolderMetadataOperation', 'Chrome local color preview bridge');
  assertContains(librarySyncFile, 'applyChromeColorFolderMetadataOperation', 'Chrome local color apply bridge');
  assertContains(librarySyncFile, 'previewChromeRenameFolderMetadataOperation', 'Chrome local rename preview bridge');
  assertContains(librarySyncFile, 'applyChromeRenameFolderMetadataOperation', 'Chrome local rename apply bridge');
  assertContains(librarySyncFile, 'chromeFolderRenamePatchRow', 'Chrome local rename writes folder-state mirror row');
  assertContains(librarySyncFile, 'chrome-folder-rename-resolve', 'Chrome rename resolver recovers visible display row identity');
  assertContains(librarySyncFile, 'confirmChromeFolderDisplayName', 'Chrome rename success is gated on fresh display model confirmation');
  assertContains(librarySyncFile, 'folder-metadata:chrome-local-rename', 'Chrome confirmed local rename schedules chrome-latest export');
  assertContains(librarySyncFile, 'chromeFolderRenameMutationStatus', 'Chrome rename diagnostic status');
  assertContains(librarySyncFile, 'chromeFolderRenameResultCount', 'Chrome rename diagnostic count');
  assertContains(librarySyncFile, 'isChromeStudioMutableFolderRow', 'Chrome mutable imported/studio folder classifier');
  assertContains(librarySyncFile, 'chrome-folder-state-mirror', 'Chrome local color writes target folder-state mirror');
  assertContains(librarySyncFile, 'folder-identity-missing', 'Chrome visible row missing identity blocker');
  assertContains(librarySyncFile, 'protected-folder', 'Chrome protected/system folder blocker');
  assertContains(librarySyncFile, 'local-review-folder-not-editable', 'Chrome local review folder blocker');
  assertContains(librarySyncFile, 'folder-not-mutable', 'Chrome non-mutable folder blocker');
  assertContains(librarySyncFile, 'native-owner-folder-not-found', 'Chrome native owner miss blocker');
  assertContains(sidebarSectionsFile, 'buildFolderMutationTargetSnapshot', 'Sidebar passes visible folder target provenance');
  assertContains(sidebarSectionsFile, 'display-color-not-confirmed', 'Sidebar gates color success on display confirmation');
  assertContains(sidebarSectionsFile, 'data-h2o-folder-source-kind', 'Sidebar renders folder source-kind provenance');
  assertContains(folderImportFile, 'DESKTOP_LATEST_POLL_INTERVAL_MS = 5000', 'Chrome polls connected latest.json for Desktop-origin changes');
  assertContains(folderImportFile, 'desktop-latest-poll-changed', 'Chrome Desktop latest poll schedules fast import on file change');
  assertContains(folderImportFile, 'isFastDesktopLatestChangeReason', 'Desktop latest file changes bypass generic 30s auto-sync throttle');
  assertContains(folderImportFile, 'refreshChromeFolderUiAfterDesktopImport', 'Chrome imports refresh folder UI after Desktop-origin metadata changes');
  assertContains(folderImportFile, 'targeted-folder-refresh', 'Chrome uses targeted folder row refresh for color/name imports');
  assertContains(folderImportFile, 'redactedPostImportRefreshSummary(f.postImportRefresh)', 'Chrome propagation preserves redacted post-import refresh mode for rerender suppression');
  assertContains(folderImportFile, 'CHROME_TARGETED_REFRESH_RETRY_MS = 250', 'Chrome retries targeted folder row refresh instead of escalating immediately');
  assertContains(folderImportFile, 'targeted-folder-refresh-deferred', 'Chrome defers missed color/name row refresh to a targeted retry');
  assertContains(folderImportFile, 'duplicate-suppressed', 'Chrome duplicate auto-import suppresses repaint work');
  assertContains(folderImportFile, 'no-folder-metadata-change', 'Chrome no-op folder imports are classified separately');
  assertContains(folderImportFile, 'noOpRefreshSuppressed', 'Chrome no-op folder imports suppress visible refresh events');
  assertContains(folderImportFile, 'refreshSuppressed: refreshSuppressed', 'Chrome no-op import diagnostics report refresh suppression');
  assertContains(folderImportFile, 'lastChromePostImportRenderRefreshCount', 'Chrome diagnostics report last import render refresh count');
  assertContains(folderImportFile, 'folderMetadataChangeSummary.changedFolderCount) > 0', 'Chrome skips LibraryIndex refresh when folder metadata is unchanged');
  assertContains(folderImportFile, 'currentLibraryIndexRowCount()', 'Chrome targeted imports avoid redundant library index refresh');
  assertContains(folderImportFile, 'renderRefreshCount', 'Chrome diagnostics expose post-import render refresh count');
  assertContains(folderImportFile, 'loopSuppressed', 'Chrome diagnostics expose suppressed import loop count');
  assertContains(folderImportFile, 'duplicateSkipped', 'Chrome diagnostics expose duplicate auto-import skip count');
  assertContains(folderImportFile, 'desktopToChromeLatency', 'Chrome diagnostics expose Desktop-to-Chrome propagation latency trace');
  assertContains(chromeLiveBackgroundFile, 'function folderCatalogRowTimestampMs', 'Chrome folder row timestamp helper');
  assertContains(chromeLiveBackgroundFile, 'function mergeFolderCatalogRowByFreshness', 'Chrome folder metadata freshness merge');
  assertContains(chromeLiveBackgroundFile, 'function folderStateMetadataMergeStats', 'Chrome folder metadata merge stats');
  assertContains(chromeLiveBackgroundFile, 'function comparableFolderStateData', 'Chrome folder state idempotent comparison');
  assertContains(contractFile, 'F19.2.c Minimal Desktop -> Chrome Scope', 'F19.2.c doc section');
  assertContains(contractFile, 'Premium Sync remains open', 'premium sync warning');
  assertNotContains(folderImportFile, 'SKIP_STALENESS_CHECK', 'staleness bypass');
}

if (failures.length === 0) {
  await runVmProof();
}

if (failures.length === 0) {
  await runFolderMutationResolverVmProof();
}

if (failures.length) {
  console.error('F19 Desktop/Chrome propagation validation failed');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('F19 Desktop/Chrome propagation validation passed');
