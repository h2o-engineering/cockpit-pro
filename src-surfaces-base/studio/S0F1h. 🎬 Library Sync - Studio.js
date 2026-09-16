// ==UserScript==
// @h2o-id             s0f1h.library_sync.studio
// @name               S0F1h. 🎬 Library Sync - Studio
// @namespace          H2O.Premium.CGX.library_sync.studio
// @author             HumamDev
// @version            1.0.0
// @revision           001
// @build              260511-000021
// @description        Studio Library Sync: cross-surface live propagation of Library state. Routes through H2O.Studio.platform.broadcast (emitRaw / onAnyChange) which is the required boundary for the future Tauri port. Wire format (BROADCAST_KEY / NATIVE_BROADCAST_KEY in chrome.storage.local) is preserved for native (chatgpt.com tab) interop. Falls back to direct chrome.storage if the platform adapter is unavailable. Library Workspace + Index subscribe and refresh on sync events.
// @match              https://chatgpt.com/*
// @run-at             document-idle
// @grant              none
// ==/UserScript==

(() => {
  'use strict';

  console.log('H2O DEV LOAD ✅ S0F1h Library Sync (Studio)', Date.now());

  const W = window;
  const H2O = (W.H2O = W.H2O || {});
  H2O.Library = H2O.Library || {};

  // ── Diagnostics ────────────────────────────────────────────────────────────
  const diag = { t0: performance.now(), steps: [], errors: [], bufMax: 50, errMax: 20 };
  const step = (s, o = '') => {
    try { diag.steps.push({ t: Math.round(performance.now() - diag.t0), s: String(s), o: String(o) }); if (diag.steps.length > diag.bufMax) diag.steps.splice(0, diag.steps.length - diag.bufMax); } catch {}
  };
  const err = (s, e) => {
    try { diag.errors.push({ t: Math.round(performance.now() - diag.t0), s: String(s), e: String(e?.stack || e) }); if (diag.errors.length > diag.errMax) diag.errors.splice(0, diag.errors.length - diag.errMax); } catch {}
  };

  // ── Constants ──────────────────────────────────────────────────────────────
  // Keys that the archive bridge / native scripts write that we care about for
  // cross-surface invalidation. We watch chrome.storage.local for these and
  // re-emit a single coalesced sync event regardless of which one changed.
  const WATCHED_PREFIXES = [
    'h2o:prm:cgx:fldrs:state:data:',          // folder vault
    'h2o:prm:cgx:fldrs:state:ui:',            // folder UI state
    'h2o:prm:cgx:fldrs:state:projects_cache:',// projects cache
    'h2o:prm:cgx:library:cat-candidate-pool:',// category candidates
    'h2o:prm:cgx:library:category-overrides:',// category overrides
    'h2o:prm:cgx:library:labels:',            // labels catalog/bindings/ui/cfg
    'h2o:prm:cgx:library:tag-auto-pool:',     // tag pools
    'h2o:prm:cgx:library:tag-occ-index:',     // tag occurrence index
    'h2o:library:chat-registry:',             // chat registry (any surface)
    'h2o:prm:cgx:library-index:',             // library index registry
    'h2o:prm:cgx:library:chat-title:state:v1:',// chat title/emoji state
    'h2o:prm:cgx:library:interface-meta:v1:', // native decorator meta/heat/pin mirror
  ];
  const STUDIO_LIBRARY_INDEX_CACHE_KEY = 'h2o:prm:cgx:library-index:studio:registry:v1';
  const FOLDER_STATE_DATA_KEY = 'h2o:prm:cgx:fldrs:state:data:v1';
  const EXTERNAL_NATIVE_FOLDER_MERGE_DIAG_KEY = 'h2o:library:native-folder-state:external-merge:diagnostic:v1';
  const IGNORED_SELF_REFRESH_KEYS = new Set([
    STUDIO_LIBRARY_INDEX_CACHE_KEY,
  ]);
  // Broadcast heartbeat to avoid event storms: at most one sync per 350ms.
  const COALESCE_MS = 350;
  const ARCHIVE_MESSAGE_TYPE = 'h2o-ext-archive:v1';
  // Studio-originated sync key: write here, native picks up via chrome.storage.
  const BROADCAST_KEY = 'h2o:library:cross-surface:broadcast:v1';
  // Native-originated sync key: native (0F1h) writes here when its Library
  // state changes; Studio listens so chatgpt.com tab mutations propagate back.
  // Two separate keys so each side reacts to the OTHER side's broadcast
  // without re-firing its own (avoids self-feedback loops).
  const NATIVE_BROADCAST_KEY = 'h2o:library:cross-surface:broadcast:native:v1';
  const FOLDER_METADATA_OPERATION_REQUEST_SCHEMA = 'h2o.folder-metadata-operation-request.v1';
  const FOLDER_METADATA_OPERATION_SCHEMA = 'h2o.folder-metadata-operation.v1';
  const FOLDER_METADATA_OPERATION_RESULT_SCHEMA = 'h2o.folder-metadata-operation-result.v1';
  const FOLDER_METADATA_REQUEST_DEFAULT_TIMEOUT_MS = 5000;
  const FOLDER_METADATA_REQUEST_MAX_PENDING = 32;
  const DESKTOP_FOLDER_METADATA_SUPPORTED_OPERATION_TYPES = ['rename-folder', 'change-folder-color'];
  const PROTECTED_CANONICAL_FOLDER_NAME_KEYS = new Set(['study', 'case', 'dev', 'code', 'tech', 'english']);
  const RESERVED_FOLDER_METADATA_NAME_KEYS = new Set(['all', 'archive', 'archived', 'link', 'linked', 'links', 'recent', 'recents', 'saved', 'unfiled']);
  const STUDIO_USER_FOLDER_ACTION_SOURCES = new Set(['studio-actions', 'desktop-user-folder-create', 'chrome-user-folder-create']);
  const CHROME_FOLDER_AUTO_EXPORT_OPERATION_TYPES = new Set(['create-folder', 'rename-folder', 'change-folder-color']);
  const SNAPSHOT_PAYLOAD_REQUEST_TIMEOUT_MS = 5000;
  const SNAPSHOT_PAYLOAD_REQUEST_POLL_MS = 250;
  const FOLDER_METADATA_STUDIO_BROADCAST_MESSAGE = 'h2o:library:studio-broadcast:v1';
  const NATIVE_OWNER_EXTENSION_IDS = [
    'bgdapdcjckbiejckpfeinlmcdnijifpg', // prod
    'bkijejgemjjolmdnkgcimoaniocegkij', // dev-controls
    'ceenhihlkfdfjdolchjffpeejblnejdb', // dev-controls-armed
    'ogcjkeaiicglflamhjaaimdhphjlgkbb', // dev-controls-oauth-google
    'eeebgndgehjalflefaldogahaklnlahi', // dev-lean
  ];

  const state = {
    bound: false,
    transport: null,        // 'platform.broadcast' | 'chrome.storage.fallback' | null
    unsub: null,            // teardown for the bound listener, if any
    lastSync: 0,
    lastChangeKeys: [],
    lastWatchedHits: [],
    lastEmittedReasons: [],
    lastNativeBroadcastAt: 0,
    lastNativeBroadcastTs: 0,
    lastNativeBroadcastKeys: [],
    lastNativeBroadcastReasons: [],
    lastNativeBroadcastHasLinkedRecords: false,
    lastNativeBroadcastLinkedRecordsCount: 0,
    lastNativeBroadcastProjectCatalogCount: 0,
    lastNativeBroadcastProjectCatalogSource: '',
    lastNativeBroadcastFolderCount: 0,
    lastNativeBroadcastFolderBindingCount: 0,
    lastNativeBroadcastFolderSource: '',
    lastNativeBroadcastSnapshotPayloadCount: 0,
    lastNativeBroadcastPayload: null,
    lastNativeBroadcastSignature: '',
    lastNativeBroadcastSignatureBefore: '',
    lastNativeBroadcastSignatureAfter: '',
    lastNativeBroadcastChanged: false,
    lastNativeBroadcastSkipReason: '',
    lastNativeBroadcastSkippedCount: 0,
    lastNativeSnapshotPayloadMaterializeAt: 0,
    lastNativeSnapshotPayloadMaterializeStatus: '',
    lastNativeSnapshotPayloadMaterializedCount: 0,
    lastNativeSnapshotPayloadSkippedCount: 0,
    lastNativeSnapshotPayloadError: '',
    lastNativeSnapshotPayloadMaterializePromise: null,
    lastNativeSnapshotPayloadImportResult: null,
    lastNativeSnapshotPayloadVerifyStatus: '',
    lastNativeSnapshotPayloadVerifiedCount: 0,
    lastNativeSnapshotPayloadVerifyError: '',
    lastNativeSnapshotPayloadIdHashes: [],
    lastNativeSnapshotPayloadRequestAt: 0,
    lastNativeSnapshotPayloadRequestCount: 0,
    lastNativeSnapshotPayloadRequestStatus: '',
    lastNativeSnapshotPayloadRequestSent: false,
    lastNativeSnapshotPayloadRequestError: '',
    lastNativeSnapshotPayloadRequestIdHashes: [],
    lastNativeBroadcastReadAt: 0,
    lastNativeBroadcastReadSource: '',
    lastNativeBroadcastReadError: '',
    lastNativeFolderMergeAt: 0,
    lastNativeFolderMergeStatus: '',
    lastNativeFolderMergeError: '',
    lastNativeFolderMergeChecksum: '',
    lastNativeFolderMergeIncomingChecksum: '',
    lastNativeFolderMergeIncomingFolderCount: 0,
    lastNativeFolderMergeIncomingBindingCount: 0,
    lastNativeFolderMergeMergedFolderCount: 0,
    lastNativeFolderMergeMergedBindingCount: 0,
    lastNativeFolderMergeRemovedNativeFolderCount: 0,
    lastNativeFolderMergeRemovedNativeFolderIds: [],
    lastNativeFolderMergePreservedLocalFolderCount: 0,
    lastNativeFolderMergeDuplicateNameDifferentIdCount: 0,
    lastNativeFolderMergeDuplicateNameDifferentIdSample: [],
    lastNativeFolderMergeCaseArrived: false,
    lastNativeFolderMergePath: '',
    lastNativeFolderMergeDiagnosticKey: '',
    lastNativeFolderMergeSourceExtensionId: '',
    lastNativeFolderMergeReadAt: 0,
    lastNativeFolderMergeReadSource: '',
    lastNativeFolderMergeReadError: '',
    lastNativeFolderMergePromise: null,
    lastRefreshOwners: [],
    lastStudioBroadcastAt: 0,
    lastStudioBroadcastReason: '',
    lastStudioBroadcastPayloadKeys: [],
    lastStudioBroadcastTransport: '',
    lastStudioBroadcastExternalAt: 0,
    lastStudioBroadcastExternalStatus: '',
    lastStudioBroadcastExternalAttempts: 0,
    lastStudioBroadcastExternalOkCount: 0,
    lastStudioBroadcastExternalErrors: [],
    lastStudioBroadcastExternalTargetIds: [],
    lastStudioBroadcastExternalResponses: [],
    lastStudioBroadcastExternalResultCount: 0,
    lastStudioBroadcastExternalDirectRelay: null,
    pendingFolderMetadataRequests: new Map(),
    lastFolderMetadataRequestAt: 0,
    lastFolderMetadataRequestId: '',
    lastFolderMetadataRequestMode: '',
    lastFolderMetadataRequestStatus: '',
    lastFolderMetadataRequestEnvelope: null,
    folderMetadataTimeoutCount: 0,
    lastFolderMetadataResultAt: 0,
    lastFolderMetadataResultId: '',
    lastFolderMetadataResultStatus: '',
    lastFolderMetadataResultBlockers: [],
    lastDesktopFolderMetadataStatus: '',
    lastDesktopFolderMetadataError: '',
    lastDesktopRenameFallbackStatus: '',
    lastDesktopRenameResultCount: 0,
    lastDesktopColorFallbackStatus: '',
    lastDesktopColorResultCount: 0,
    lastDesktopFolderAutoExportAt: 0,
    lastDesktopFolderAutoExportReason: '',
    lastDesktopFolderAutoExportStatus: '',
    lastDesktopFolderAutoExportError: '',
    lastDesktopFolderAutoExportResult: null,
    lastChromeFolderMetadataStatus: '',
    lastChromeFolderMetadataError: '',
    lastChromeFolderColorMutationStatus: '',
    lastChromeFolderColorResultCount: 0,
    lastChromeFolderRenameMutationStatus: '',
    lastChromeFolderRenameResultCount: 0,
    lastChromeFolderMutationRoute: '',
    lastChromeFolderMutationBlocker: '',
    lastChromeFolderAutoExportAt: 0,
    lastChromeFolderAutoExportReason: '',
    lastChromeFolderAutoExportStatus: '',
    lastChromeFolderAutoExportError: '',
    lastChromeFolderAutoExportResult: null,
    pendingTimer: null,
    pendingReasons: new Set(),
    subscribers: new Set(),
  };

  // ── Transport seam ────────────────────────────────────────────────────────
  // All cross-surface signaling routes through H2O.Studio.platform.broadcast.
  // emitRaw / onAnyChange preserve the legacy wire format (writes to
  // BROADCAST_KEY / NATIVE_BROADCAST_KEY in chrome.storage.local) so the
  // native counterpart at scripts/0F1h.*.js and the watching feature owners
  // continue to operate unchanged. The platform adapter is the required
  // boundary for the future Tauri port — at port time the MV3 adapter is
  // swapped for a Tauri adapter without touching this file. See
  // surfaces/studio/STUDIO_PLATFORM_ADAPTER_GUIDE.md and
  // STUDIO_PORTABILITY_CONTRACT.md.
  function getPlatformBroadcast() {
    const p = W.H2O && W.H2O.Studio && W.H2O.Studio.platform && W.H2O.Studio.platform.broadcast;
    if (!p) return null;
    if (typeof p.emitRaw !== 'function' || typeof p.onAnyChange !== 'function') return null;
    // Reject the fallback adapter — it would noop/throw and we'd want the
    // direct chrome.storage path to take over for graceful degradation.
    const env = W.H2O && W.H2O.Studio && W.H2O.Studio.platform && W.H2O.Studio.platform.env;
    if (env && env.adapter === 'fallback') return null;
    return p;
  }

  function hasChromeStorage() {
    try {
      return !!(W.chrome && chrome.storage && chrome.storage.local && typeof chrome.storage.local.set === 'function');
    } catch { return false; }
  }

  function hasChromeStorageRead() {
    try {
      return !!(W.chrome && chrome.storage && chrome.storage.local && typeof chrome.storage.local.get === 'function');
    } catch { return false; }
  }

  function chromeStorageGet(key) {
    return new Promise((resolve, reject) => {
      try {
        chrome.storage.local.get(key, (items) => {
          const runtimeError = chrome.runtime && chrome.runtime.lastError;
          if (runtimeError) { reject(new Error(runtimeError.message || String(runtimeError))); return; }
          resolve(items ? items[key] : undefined);
        });
      } catch (e) { reject(e); }
    });
  }

  function chromeStorageSet(items) {
    return new Promise((resolve, reject) => {
      try {
        chrome.storage.local.set(items, () => {
          const runtimeError = chrome.runtime && chrome.runtime.lastError;
          if (runtimeError) { reject(new Error(runtimeError.message || String(runtimeError))); return; }
          resolve(true);
        });
      } catch (e) { reject(e); }
    });
  }

  function hasRuntimeExternalMessaging() {
    try {
      return !!(W.chrome && chrome.runtime && typeof chrome.runtime.sendMessage === 'function');
    } catch { return false; }
  }

  function folderMetadataRequestPayloadPresent(payload) {
    const p = payload && typeof payload === 'object' ? payload : null;
    const requests = p && p.folderMetadataOperationRequests;
    return Array.isArray(requests) ? requests.length > 0 : !!(requests && typeof requests === 'object');
  }

  function snapshotPayloadRequestPayloadPresent(payload) {
    const p = payload && typeof payload === 'object' ? payload : null;
    const requests = p && p.snapshotPayloadRequests;
    return Array.isArray(requests) ? requests.length > 0 : !!(requests && typeof requests === 'object');
  }

  function studioBroadcastExternalPayloadPresent(payload) {
    return folderMetadataRequestPayloadPresent(payload) || snapshotPayloadRequestPayloadPresent(payload);
  }

  function forwardStudioBroadcastToNativeOwners(body) {
    const payload = body && typeof body === 'object' ? body.payload : null;
    if (!studioBroadcastExternalPayloadPresent(payload)) return false;
    state.lastStudioBroadcastExternalAt = Date.now();
    state.lastStudioBroadcastExternalStatus = 'skipped';
    state.lastStudioBroadcastExternalAttempts = 0;
    state.lastStudioBroadcastExternalOkCount = 0;
    state.lastStudioBroadcastExternalErrors = [];
    state.lastStudioBroadcastExternalTargetIds = [];
    state.lastStudioBroadcastExternalResponses = [];
    state.lastStudioBroadcastExternalResultCount = 0;
    state.lastStudioBroadcastExternalDirectRelay = null;
    if (!hasRuntimeExternalMessaging()) {
      state.lastStudioBroadcastExternalStatus = 'unavailable';
      state.lastStudioBroadcastExternalErrors = ['chrome-runtime-sendMessage-unavailable'];
      return false;
    }

    const ownId = String((W.chrome && chrome.runtime && chrome.runtime.id) || '');
    const lastNativeSourceId = String(
      state.lastNativeFolderMergeSourceExtensionId ||
      state.lastNativeBroadcastPayload?.sourceExtensionId ||
      ''
    ).trim();
    const preferredTargets = NATIVE_OWNER_EXTENSION_IDS.includes(lastNativeSourceId)
      ? [lastNativeSourceId]
      : NATIVE_OWNER_EXTENSION_IDS;
    const targets = preferredTargets.filter((id) => id && id !== ownId);
    state.lastStudioBroadcastExternalAttempts = targets.length;
    state.lastStudioBroadcastExternalStatus = targets.length ? 'pending' : 'no-native-targets';
    state.lastStudioBroadcastExternalTargetIds = targets.slice();
    if (!targets.length) return false;

    const message = {
      type: FOLDER_METADATA_STUDIO_BROADCAST_MESSAGE,
      key: BROADCAST_KEY,
      value: body,
      source: 'studio-launcher',
      sourceExtensionId: ownId,
      ts: Date.now(),
    };

    let settled = 0;
    targets.forEach((targetId) => {
      try {
        chrome.runtime.sendMessage(targetId, message, (resp) => {
          settled += 1;
          const runtimeError = chrome.runtime && chrome.runtime.lastError;
          const directRelay = resp && resp.directRelay && typeof resp.directRelay === 'object'
            ? resp.directRelay
            : null;
          const topLevelResults = resp && Array.isArray(resp.folderMetadataOperationResults)
            ? resp.folderMetadataOperationResults
            : [];
          const directRelayResults = directRelay && Array.isArray(directRelay.folderMetadataOperationResults)
            ? directRelay.folderMetadataOperationResults
            : [];
          const directResultKeys = new Set();
          const directResults = topLevelResults.concat(directRelayResults).filter((result) => {
            const requestId = String(result?.requestId || '').trim();
            const requestMode = String(result?.requestMode || '').trim();
            const key = `${requestId}:${requestMode}`;
            if (!requestId || directResultKeys.has(key)) return false;
            directResultKeys.add(key);
            return true;
          });
          const responseSummary = {
            targetId,
            ok: !runtimeError && !!(resp && resp.ok !== false),
            status: runtimeError
              ? String(runtimeError.message || runtimeError)
              : String((resp && (resp.status || resp.error)) || ''),
            directRelay: directRelay
              ? {
                status: String(directRelay.status || ''),
                sent: Number(directRelay.sent || 0) || 0,
                tabCount: Number(directRelay.tabCount || 0) || 0,
                pageReceiverStatus: String(directRelay.pageReceiverStatus || ''),
                receiverInstalled: directRelay.receiverInstalled === true,
                listenerReached: directRelay.listenerReached === true,
                resultCount: Number(directRelay.resultCount || directRelayResults.length || 0) || 0,
                fallbackPreviewStatus: String(directRelay.fallbackPreviewStatus || ''),
                fallbackPreviewResultCount: Number(directRelay.fallbackPreviewResultCount || 0) || 0,
                fallbackPreviewReason: String(directRelay.fallbackPreviewReason || ''),
                applyFallbackStatus: String(directRelay.applyFallbackStatus || ''),
                applyResultCount: Number(directRelay.applyResultCount || 0) || 0,
                applyFallbackReason: String(directRelay.applyFallbackReason || ''),
                renameFallbackStatus: String(directRelay.renameFallbackStatus || ''),
                renameResultCount: Number(directRelay.renameResultCount || 0) || 0,
                renameFallbackReason: String(directRelay.renameFallbackReason || ''),
                folderStateForwardStatus: String(directRelay.folderStateForwardStatus || ''),
                folderStateForwardedToStudio: directRelay.folderStateForwardedToStudio === true,
                snapshotPayloadRequestCount: Number(directRelay.snapshotPayloadRequestCount || 0) || 0,
                snapshotPayloadResponseCount: Number(directRelay.snapshotPayloadResponseCount || 0) || 0,
                snapshotPayloadForwardedCount: Number(directRelay.snapshotPayloadForwardedCount || 0) || 0,
                errors: Array.isArray(directRelay.errors) ? directRelay.errors.slice(0, 8) : [],
              }
              : null,
            resultCount: directResults.length,
            at: Date.now(),
          };
          state.lastStudioBroadcastExternalResponses.push(responseSummary);
          if (state.lastStudioBroadcastExternalResponses.length > 12) {
            state.lastStudioBroadcastExternalResponses.splice(0, state.lastStudioBroadcastExternalResponses.length - 12);
          }
          if (responseSummary.directRelay) state.lastStudioBroadcastExternalDirectRelay = responseSummary.directRelay;
          if (directResults.length) {
            state.lastStudioBroadcastExternalResultCount += directResults.length;
            rememberFolderMetadataOperationResults({ folderMetadataOperationResults: directResults }, 'external-direct-relay');
          }
          if (runtimeError) {
            state.lastStudioBroadcastExternalErrors.push(`${targetId}:${String(runtimeError.message || runtimeError)}`);
          } else if (resp && resp.ok !== false) {
            state.lastStudioBroadcastExternalOkCount += 1;
          } else {
            state.lastStudioBroadcastExternalErrors.push(`${targetId}:${String((resp && (resp.status || resp.error)) || 'no-response')}`);
          }
          if (state.lastStudioBroadcastExternalErrors.length > 8) {
            state.lastStudioBroadcastExternalErrors.splice(0, state.lastStudioBroadcastExternalErrors.length - 8);
          }
          if (settled >= targets.length) {
            state.lastStudioBroadcastExternalStatus = state.lastStudioBroadcastExternalOkCount > 0
              ? 'ok'
              : 'failed';
          }
        });
      } catch (e) {
        settled += 1;
        state.lastStudioBroadcastExternalErrors.push(`${targetId}:${String(e?.message || e || 'send-failed')}`);
        if (settled >= targets.length) {
          state.lastStudioBroadcastExternalStatus = state.lastStudioBroadcastExternalOkCount > 0 ? 'ok' : 'failed';
        }
      }
    });
    return true;
  }

  function stableStringify(value) {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }

  function stableChecksum(value) {
    let text = '';
    try { text = stableStringify(value || null); } catch { text = String(value || ''); }
    let hash = 5381;
    for (let i = 0; i < text.length; i += 1) hash = ((hash << 5) + hash) ^ text.charCodeAt(i);
    return `h2o-folder-${(hash >>> 0).toString(16)}`;
  }

  function isWatchedKey(key) {
    const k = String(key || '');
    if (IGNORED_SELF_REFRESH_KEYS.has(k)) return false;
    return WATCHED_PREFIXES.some((p) => k.startsWith(p));
  }

  function normalizeNativeBroadcastPayload(value) {
    const raw = value && typeof value === 'object' ? value : null;
    if (!raw) return null;
    if (raw.projectCatalog || raw.folderState || Array.isArray(raw.linkedRecords) || raw.surface === 'native' || Array.isArray(raw.reasons)) return raw;
    const payload = raw.payload && typeof raw.payload === 'object' ? raw.payload : null;
    if (payload && (payload.projectCatalog || payload.folderState || Array.isArray(payload.linkedRecords) || payload.surface === 'native' || Array.isArray(payload.reasons))) return payload;
    const nestedValue = raw.value && typeof raw.value === 'object' ? raw.value : null;
    if (nestedValue && (nestedValue.projectCatalog || nestedValue.folderState || Array.isArray(nestedValue.linkedRecords) || nestedValue.surface === 'native' || Array.isArray(nestedValue.reasons))) return nestedValue;
    return raw;
  }

  function nativeBroadcastSignature(payload) {
    const p = normalizeNativeBroadcastPayload(payload);
    if (!p) return '';
    return stableChecksum({
      linkedRecords: Array.isArray(p.linkedRecords) ? p.linkedRecords : [],
      projectCatalog: p.projectCatalog || null,
      folderState: p.folderState || null,
      snapshotPayloads: Array.isArray(p.snapshotPayloads) ? p.snapshotPayloads : [],
      folderMetadataOperationResults: Array.isArray(p.folderMetadataOperationResults)
        ? p.folderMetadataOperationResults
        : [],
    });
  }

  function snapshotPayloadHasContent(payload) {
    if (!payload || typeof payload !== 'object') return false;
    if (Array.isArray(payload.messages) && payload.messages.length > 0) return true;
    const meta = payload.meta && typeof payload.meta === 'object' ? payload.meta : {};
    return Array.isArray(meta.richTurns) && meta.richTurns.length > 0;
  }

  function callArchive(op, payload) {
    return new Promise((resolve, reject) => {
      try {
        const messaging = W.H2O?.Studio?.platform?.messaging || null;
        if (!messaging || typeof messaging.send !== 'function') {
          reject(new Error('platform messaging unavailable'));
          return;
        }
        const message = { type: ARCHIVE_MESSAGE_TYPE, req: { op, payload: payload || {} } };
        Promise.resolve(messaging.send(ARCHIVE_MESSAGE_TYPE, message))
          .then((response) => {
            if (!response || response.ok !== true) reject(new Error(String(response?.error || `archive op failed: ${op}`)));
            else resolve(response.result);
          })
          .catch(reject);
      } catch (e) { reject(e); }
    });
  }

  function normalizeNativeSnapshotPayload(row) {
    const src = row && typeof row === 'object' ? row : {};
    const chatId = String(src.chatId || '').trim();
    const snapshotId = String(src.snapshotId || src.id || '').trim();
    const messages = Array.isArray(src.messages) ? src.messages : [];
    const meta = src.meta && typeof src.meta === 'object' ? { ...src.meta } : {};
    const richTurns = Array.isArray(meta.richTurns) ? meta.richTurns : [];
    if (!chatId || !snapshotId || (!messages.length && !richTurns.length)) return null;
    const title = String(src.title || meta.title || meta.displayTitle || '').trim();
    const href = String(src.href || meta.href || `/c/${chatId}`).trim();
    const folderId = String(src.folderId || meta.folderId || '').trim();
    const messageCount = Number(src.messageCount || messages.length || richTurns.length || 0) || 0;
    const userTurnCount = Number(src.userTurnCount || meta.userTurnCount || 0) || 0;
    const assistantTurnCount = Number(src.assistantTurnCount || meta.assistantTurnCount || 0) || 0;
    const turnCount = Number(src.turnCount || meta.turnCount || messageCount || 0) || 0;
    const answerCount = Number(src.answerCount || meta.answerCount || assistantTurnCount || 0) || 0;
    if (title) {
      meta.title = String(meta.title || title);
      meta.displayTitle = String(meta.displayTitle || title);
      meta.sourceTitle = String(meta.sourceTitle || title);
      meta.pageTitle = String(meta.pageTitle || title);
      meta.chatTitle = String(meta.chatTitle || title);
      meta.originalTitle = String(meta.originalTitle || title);
    }
    if (href) meta.href = String(meta.href || href);
    if (folderId) meta.folderId = String(meta.folderId || folderId);
    meta.messageCount = Number(meta.messageCount || messageCount || 0) || 0;
    meta.turnCount = Number(meta.turnCount || turnCount || 0) || 0;
    meta.userTurnCount = Number(meta.userTurnCount || userTurnCount || 0) || 0;
    meta.assistantTurnCount = Number(meta.assistantTurnCount || assistantTurnCount || 0) || 0;
    meta.answerCount = Number(meta.answerCount || answerCount || 0) || 0;
    return {
      chatId,
      bootMode: 'saved',
      migrated: false,
      chatIndex: {
        id: chatId,
        chatId,
        title,
        displayTitle: title,
        sourceTitle: String(meta.sourceTitle || title),
        pageTitle: String(meta.pageTitle || title),
        chatTitle: String(meta.chatTitle || title),
        originalTitle: String(meta.originalTitle || title),
        href,
        view: 'saved',
        displayView: 'saved',
        badgeKind: 'Saved',
        readerKind: 'reader',
        snapshotId,
        lastSnapshotId: snapshotId,
        latestSnapshotId: snapshotId,
        snapshotCount: 1,
        messageCount,
        turnCount,
        userTurnCount,
        assistantTurnCount,
        answerCount,
        state: {
          isSaved: true,
          isLinked: true,
          isImported: false,
          isDeleted: false,
        },
        organization: folderId ? { folderId } : {},
        linkedFrom: 'save-to-folder',
        linkSourceHref: href,
      },
      snapshots: [{
        snapshotId,
        chatId,
        createdAt: String(src.createdAt || new Date().toISOString()),
        schemaVersion: Number(src.schemaVersion || 1) || 1,
        messageCount,
        digest: String(src.digest || ''),
        meta,
        messages,
      }],
    };
  }

  function redactNativeBroadcastPayload(payload) {
    const src = payload && typeof payload === 'object' ? payload : null;
    if (!src) return null;
    const out = { ...src };
    if (Array.isArray(out.snapshotPayloads)) {
      out.snapshotPayloads = out.snapshotPayloads.map((item) => ({
        schema: String(item?.schema || ''),
        hasChatId: !!String(item?.chatId || '').trim(),
        hasSnapshotId: !!String(item?.snapshotId || item?.id || '').trim(),
        messageCount: Number(item?.messageCount || (Array.isArray(item?.messages) ? item.messages.length : 0)) || 0,
        hasPayload: snapshotPayloadHasContent(item),
      }));
    }
    return out;
  }

  function redactedPayloadId(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    return stableChecksum(raw).replace(/^h2o-folder-/, 'h:');
  }

  function sleep(ms) {
    return new Promise((resolve) => {
      try { W.setTimeout(resolve, ms); } catch { resolve(); }
    });
  }

  function normalizeSnapshotPayloadRequest(row, index) {
    const src = row && typeof row === 'object' ? row : {};
    const chatId = String(src.chatId || src.id || '').trim();
    const snapshotId = String(src.snapshotId || src.lastSnapshotId || src.latestSnapshotId || src.snapshot_id || '').trim();
    if (!chatId && !snapshotId) return null;
    return {
      schema: 'h2o.native.snapshot-payload-request.v1',
      requestId: String(src.requestId || snapshotId || chatId || `native-snapshot-payload-${index || 0}`),
      chatId,
      snapshotId,
      title: String(src.title || src.displayTitle || src.name || ''),
      href: String(src.href || src.url || src.sourceUrl || ''),
      folderId: String(src.folderId || src.folder_id || ''),
      messageCount: Number(src.messageCount || 0) || 0,
      turnCount: Number(src.turnCount || 0) || 0,
      userTurnCount: Number(src.userTurnCount || 0) || 0,
      assistantTurnCount: Number(src.assistantTurnCount || 0) || 0,
      answerCount: Number(src.answerCount || 0) || 0,
    };
  }

  async function verifyNativeSnapshotPayloadImports(chats) {
    const rows = Array.isArray(chats) ? chats : [];
    let verified = 0;
    const hashes = [];
    for (const chat of rows) {
      const snap = Array.isArray(chat?.snapshots) ? chat.snapshots[0] : null;
      const snapshotId = String(snap?.snapshotId || '').trim();
      if (!snapshotId) continue;
      hashes.push(redactedPayloadId(snapshotId));
      const loaded = await callArchive('loadSnapshot', { snapshotId });
      const messages = Array.isArray(loaded?.messages) ? loaded.messages : [];
      const meta = loaded?.meta && typeof loaded.meta === 'object' ? loaded.meta : {};
      const richTurns = Array.isArray(meta.richTurns) ? meta.richTurns : [];
      if (messages.length || richTurns.length) verified += 1;
    }
    state.lastNativeSnapshotPayloadVerifiedCount = verified;
    state.lastNativeSnapshotPayloadIdHashes = hashes.slice(0, 12);
    state.lastNativeSnapshotPayloadVerifyStatus = verified === rows.length ? 'verified' : 'partial';
    state.lastNativeSnapshotPayloadVerifyError = '';
    return { verified, hashes };
  }

  async function requestNativeSnapshotPayloads(requests, options = {}) {
    const rows = Array.isArray(requests) ? requests : [];
    const normalized = rows.map(normalizeSnapshotPayloadRequest).filter(Boolean).slice(0, 12);
    const startedAt = Date.now();
    const reason = String(options?.reason || 'native-snapshot-payload-request');
    state.lastNativeSnapshotPayloadRequestAt = startedAt;
    state.lastNativeSnapshotPayloadRequestCount = normalized.length;
    state.lastNativeSnapshotPayloadRequestStatus = normalized.length ? 'started' : 'none';
    state.lastNativeSnapshotPayloadRequestSent = false;
    state.lastNativeSnapshotPayloadRequestError = '';
    state.lastNativeSnapshotPayloadRequestIdHashes = normalized
      .map((item) => redactedPayloadId(item.snapshotId || item.chatId))
      .filter(Boolean)
      .slice(0, 12);
    if (!normalized.length) {
      return { ok: true, status: 'none', requestedCount: 0 };
    }
    try {
      state.lastNativeSnapshotPayloadRequestSent = broadcastFromStudio(reason, {
        snapshotPayloadRequests: normalized,
      });
      if (!state.lastNativeSnapshotPayloadRequestSent) {
        state.lastNativeSnapshotPayloadRequestStatus = 'broadcast-failed';
        state.lastNativeSnapshotPayloadRequestError = 'native-owner-broadcast-unavailable';
        return { ok: false, status: 'broadcast-failed', requestedCount: normalized.length };
      }
      const deadline = startedAt + Math.max(500, Number(options?.timeoutMs || SNAPSHOT_PAYLOAD_REQUEST_TIMEOUT_MS) || SNAPSHOT_PAYLOAD_REQUEST_TIMEOUT_MS);
      let materialized = null;
      while (Date.now() < deadline) {
        await sleep(Number(options?.pollMs || SNAPSHOT_PAYLOAD_REQUEST_POLL_MS) || SNAPSHOT_PAYLOAD_REQUEST_POLL_MS);
        try { await refreshNativeBroadcast(`${reason}:poll`); } catch {}
        try { materialized = await (state.lastNativeSnapshotPayloadMaterializePromise || Promise.resolve(null)); } catch {}
        if (state.lastNativeSnapshotPayloadMaterializeAt >= startedAt) break;
      }
      if (state.lastNativeSnapshotPayloadMaterializeAt >= startedAt) {
        state.lastNativeSnapshotPayloadRequestStatus = 'completed';
      } else {
        const directRelay = state.lastStudioBroadcastExternalDirectRelay || null;
        const relayed = directRelay && Number(directRelay.sent || 0) > 0;
        const tabCount = directRelay ? Number(directRelay.tabCount || 0) || 0 : 0;
        const requestResponseCount = directRelay ? Number(directRelay.snapshotPayloadResponseCount || 0) || 0 : 0;
        const requestForwardedCount = directRelay ? Number(directRelay.snapshotPayloadForwardedCount || 0) || 0 : 0;
        if (state.lastStudioBroadcastExternalAttempts > 0 && state.lastStudioBroadcastExternalOkCount === 0) {
          state.lastNativeSnapshotPayloadRequestStatus = 'bridge-send-failed';
        } else if (directRelay && tabCount === 0) {
          state.lastNativeSnapshotPayloadRequestStatus = 'no-open-chatgpt-tab';
        } else if (!relayed) {
          state.lastNativeSnapshotPayloadRequestStatus = 'listener-missing';
        } else if (requestResponseCount === 0) {
          state.lastNativeSnapshotPayloadRequestStatus = 'listener-reached-no-payload';
        } else if (requestForwardedCount === 0) {
          state.lastNativeSnapshotPayloadRequestStatus = 'snapshot-not-found';
        } else {
          state.lastNativeSnapshotPayloadRequestStatus = 'import-verify-failed';
        }
      }
      const directRelay = state.lastStudioBroadcastExternalDirectRelay || null;
      return {
        ok: state.lastNativeSnapshotPayloadRequestStatus === 'completed',
        status: state.lastNativeSnapshotPayloadRequestStatus,
        requestedCount: normalized.length,
        materialized,
        materializeStatus: state.lastNativeSnapshotPayloadMaterializeStatus,
        verifiedCount: state.lastNativeSnapshotPayloadVerifiedCount,
        directRelayStatus: String(directRelay?.status || ''),
        listenerReached: Number(directRelay?.sent || 0) > 0,
        responseCount: Number(directRelay?.snapshotPayloadResponseCount || 0) || 0,
        forwardedCount: Number(directRelay?.snapshotPayloadForwardedCount || 0) || 0,
      };
    } catch (e) {
      state.lastNativeSnapshotPayloadRequestStatus = 'error';
      state.lastNativeSnapshotPayloadRequestError = String(e?.message || e || 'native-snapshot-payload-request-error');
      err('native-snapshot-payload.request', e);
      return { ok: false, status: 'error', error: state.lastNativeSnapshotPayloadRequestError, requestedCount: normalized.length };
    }
  }

  async function materializeNativeSnapshotPayloads(payloads, reason = '') {
    const rows = Array.isArray(payloads) ? payloads : [];
    const chats = rows.map(normalizeNativeSnapshotPayload).filter(Boolean);
    state.lastNativeBroadcastSnapshotPayloadCount = rows.length;
    state.lastNativeSnapshotPayloadMaterializeAt = Date.now();
    state.lastNativeSnapshotPayloadMaterializedCount = 0;
    state.lastNativeSnapshotPayloadSkippedCount = rows.length - chats.length;
    state.lastNativeSnapshotPayloadError = '';
    state.lastNativeSnapshotPayloadImportResult = null;
    state.lastNativeSnapshotPayloadVerifyStatus = '';
    state.lastNativeSnapshotPayloadVerifiedCount = 0;
    state.lastNativeSnapshotPayloadVerifyError = '';
    state.lastNativeSnapshotPayloadIdHashes = [];
    if (!rows.length) {
      state.lastNativeSnapshotPayloadMaterializeStatus = 'none';
      return { ok: true, status: 'none', importedSnapshots: 0 };
    }
    if (!chats.length) {
      state.lastNativeSnapshotPayloadMaterializeStatus = 'skipped-empty';
      return { ok: true, status: 'skipped-empty', importedSnapshots: 0 };
    }
    try {
      const bundle = {
        schema: 'h2o.chatArchive.bundle.v1',
        exportedAt: new Date().toISOString(),
        scope: 'native-save-to-folder-snapshot-payloads',
        chatCount: chats.length,
        chats,
        catalogs: {},
      };
      const result = await callArchive('importBundle', { bundle, mode: 'merge' });
      state.lastNativeSnapshotPayloadMaterializedCount = Number(result?.importedSnapshots || chats.length || 0) || 0;
      state.lastNativeSnapshotPayloadImportResult = {
        ok: result?.ok !== false,
        mode: String(result?.mode || ''),
        importedChats: Number(result?.importedChats || 0) || 0,
        importedSnapshots: Number(result?.importedSnapshots || 0) || 0,
      };
      try {
        await verifyNativeSnapshotPayloadImports(chats);
      } catch (verifyErr) {
        state.lastNativeSnapshotPayloadVerifyStatus = 'error';
        state.lastNativeSnapshotPayloadVerifyError = String(verifyErr?.message || verifyErr || 'snapshot-payload-verify-error');
      }
      state.lastNativeSnapshotPayloadMaterializeStatus = 'imported';
      try {
        await W.H2O?.LibraryIndex?.refresh?.(`native-snapshot-payload-materialized:${reason || 'native-broadcast'}`);
      } catch {}
      triggerChromeAutoImport('native-snapshot-payload-materialized');
      return { ok: true, status: 'imported', result };
    } catch (e) {
      state.lastNativeSnapshotPayloadMaterializeStatus = 'error';
      state.lastNativeSnapshotPayloadError = String(e?.message || e || 'snapshot-payload-import-error');
      err('native-snapshot-payload.materialize', e);
      return { ok: false, status: 'error', error: state.lastNativeSnapshotPayloadError };
    }
  }

  function normalizeFolderRow(row, index, fallbackSource = '') {
    const src = row && typeof row === 'object' ? row : {};
    const id = String(src.id || src.folderId || '').trim();
    if (!id) return null;
    const name = String(src.name || src.title || id).trim() || id;
    const iconColor = String(src.iconColor || src.color || '').trim();
    const color = String(src.color || src.iconColor || '').trim();
    const out = {
      id,
      folderId: id,
      name,
      title: name,
      source: String(src.source || fallbackSource || '').trim() || 'folder-state',
      index: Number.isFinite(Number(src.index)) ? Number(src.index) : index,
    };
    const meta = (src.meta && typeof src.meta === 'object' && !Array.isArray(src.meta)) ? src.meta : {};
    if (Object.keys(meta).length) out.meta = { ...meta };
    const sourceKind = String(src.sourceKind || src.kind || meta.sourceKind || meta.kind || '').trim();
    if (sourceKind) {
      out.sourceKind = sourceKind;
      out.kind = sourceKind;
    }
    if (String(src.stateSource || '').trim()) out.stateSource = String(src.stateSource || '').trim();
    if (src.projectRef && typeof src.projectRef === 'object') out.projectRef = src.projectRef;
    if (iconColor) out.iconColor = iconColor;
    if (color) out.color = color;
    if (String(src.icon || '').trim()) out.icon = String(src.icon || '').trim();
    if (String(src.parentId || '').trim()) out.parentId = String(src.parentId || '').trim();
    ['userCreated', 'materializedUserFolder', 'trustedFolderDisplay', 'shownInNormalMode', 'protectedCanonicalFallback', 'isCanonical'].forEach((key) => {
      if (src[key] === true || meta[key] === true) out[key] = true;
    });
    if (src.hidden === true || meta.hidden === true) out.hidden = true;
    if (String(src.reviewBucket || meta.reviewBucket || '').trim()) out.reviewBucket = String(src.reviewBucket || meta.reviewBucket || '').trim();
    if (String(src.colorSource || meta.colorSource || '').trim()) out.colorSource = String(src.colorSource || meta.colorSource || '').trim();
    if (Object.prototype.hasOwnProperty.call(src, 'sortOrder')) out.sortOrder = src.sortOrder;
    if (Object.prototype.hasOwnProperty.call(src, 'createdAt')) out.createdAt = src.createdAt;
    if (Object.prototype.hasOwnProperty.call(src, 'updatedAt')) out.updatedAt = src.updatedAt;
    return out;
  }

  function normalizeFolderState(raw, fallbackSource = '') {
    const src = raw && typeof raw === 'object' ? raw : {};
    const rows = Array.isArray(src.folders) ? src.folders : [];
    const folders = [];
    const seen = new Set();
    rows.forEach((row, index) => {
      const folder = normalizeFolderRow(row, index, fallbackSource || src.source || '');
      if (!folder || seen.has(folder.id)) return;
      seen.add(folder.id);
      folders.push(folder);
    });
    const inputItems = src.items && typeof src.items === 'object' ? src.items : {};
    const items = {};
    folders.forEach((folder) => {
      const values = Array.isArray(inputItems[folder.id]) ? inputItems[folder.id] : [];
      items[folder.id] = Array.from(new Set(values.map((value) => String(value || '').trim()).filter(Boolean)));
    });
    return { folders, items };
  }

  function countFolderBindings(items) {
    if (!items || typeof items !== 'object') return 0;
    return Object.keys(items).reduce((sum, key) => sum + (Array.isArray(items[key]) ? items[key].length : 0), 0);
  }

  function mergeFolderRows(existing, incoming) {
    const out = { ...(existing || {}) };
    out.id = incoming.id;
    out.folderId = incoming.id;
    if (incoming.name) {
      out.name = incoming.name;
      out.title = incoming.title || incoming.name;
    }
    if (incoming.source) out.source = incoming.source;
    const incomingMeta = (incoming.meta && typeof incoming.meta === 'object' && !Array.isArray(incoming.meta)) ? incoming.meta : {};
    const existingMeta = (out.meta && typeof out.meta === 'object' && !Array.isArray(out.meta)) ? out.meta : {};
    if (Object.keys(incomingMeta).length || Object.keys(existingMeta).length) out.meta = { ...existingMeta, ...incomingMeta };
    const incomingSourceKind = String(incoming.sourceKind || incoming.kind || incomingMeta.sourceKind || incomingMeta.kind || '').trim();
    if (incomingSourceKind) {
      out.sourceKind = incomingSourceKind;
      out.kind = incomingSourceKind;
    }
    if (incoming.stateSource) out.stateSource = incoming.stateSource;
    if (incoming.projectRef) out.projectRef = incoming.projectRef;
    if (incoming.iconColor) out.iconColor = incoming.iconColor;
    if (incoming.color) out.color = incoming.color;
    if (!out.color && incoming.iconColor) out.color = incoming.iconColor;
    if (!out.iconColor && incoming.color) out.iconColor = incoming.color;
    if (incoming.icon) out.icon = incoming.icon;
    if (incoming.parentId) out.parentId = incoming.parentId;
    ['userCreated', 'materializedUserFolder', 'trustedFolderDisplay', 'shownInNormalMode', 'protectedCanonicalFallback', 'isCanonical'].forEach((key) => {
      if (incoming[key] === true || incomingMeta[key] === true) out[key] = true;
    });
    if (incoming.hidden === true || incomingMeta.hidden === true) out.hidden = true;
    if (incoming.reviewBucket || incomingMeta.reviewBucket) out.reviewBucket = incoming.reviewBucket || incomingMeta.reviewBucket;
    if (incoming.colorSource || incomingMeta.colorSource) out.colorSource = incoming.colorSource || incomingMeta.colorSource;
    if (Object.prototype.hasOwnProperty.call(incoming, 'sortOrder')) out.sortOrder = incoming.sortOrder;
    if (!Object.prototype.hasOwnProperty.call(out, 'createdAt') && Object.prototype.hasOwnProperty.call(incoming, 'createdAt')) out.createdAt = incoming.createdAt;
    if (Object.prototype.hasOwnProperty.call(incoming, 'updatedAt')) out.updatedAt = incoming.updatedAt;
    if (Object.prototype.hasOwnProperty.call(incoming, 'index')) out.index = incoming.index;
    return out;
  }

  function isNativeOwnedFolderMirrorRow(folder) {
    const source = String(folder?.source || '').trim().toLowerCase();
    const kind = String(folder?.kind || '').trim().toLowerCase();
    if (source === 'native-folder-catalog') return true;
    if (source === 'native-folder-state') return true;
    if (source === 'native-broadcast') return true;
    if (source === 'native-h2o-folder-state') return true;
    if (source.includes('native') && (source.includes('folder') || source.includes('catalog'))) return true;
    if (source === 'canonical-native') return true;
    if (kind === 'native-folder-catalog' || kind === 'native-folder-state') return true;
    if (kind === 'canonical-native') return true;
    return false;
  }

  function chromeFolderMetadataStateHash(folderState) {
    const stateInput = folderState && typeof folderState === 'object' ? folderState : {};
    return stableChecksum({
      folders: comparableDesktopFolderMetadataRows(stateInput.folders || []),
      items: stateInput.items || {},
    });
  }

  function folderMetadataOperationBeforeRow(operation) {
    const op = operation && typeof operation === 'object' ? operation : {};
    const before = op.before && typeof op.before === 'object' && !Array.isArray(op.before) ? op.before : null;
    const target = op.target && typeof op.target === 'object' && !Array.isArray(op.target) ? op.target : null;
    return before || target || null;
  }

  function mergeFolderMetadataVisibleRow(storedRow, visibleRow) {
    const stored = storedRow && typeof storedRow === 'object' ? storedRow : {};
    const visible = visibleRow && typeof visibleRow === 'object' ? visibleRow : {};
    const storedMeta = folderMetadataRowMeta(stored);
    const visibleMeta = folderMetadataRowMeta(visible);
    const merged = {
      ...visible,
      ...stored,
      meta: { ...visibleMeta, ...storedMeta },
    };
    const folderId = folderMetadataRowId(stored) || folderMetadataRowId(visible);
    if (folderId) {
      merged.id = folderId;
      merged.folderId = folderId;
    }
    const name = folderMetadataRowName(stored) || folderMetadataRowName(visible);
    if (name) {
      merged.name = name;
      merged.title = name;
    }
    const source = String(stored.source || storedMeta.source || visible.source || visibleMeta.source || '').trim();
    const sourceKind = String(stored.sourceKind || stored.kind || storedMeta.sourceKind || storedMeta.kind || visible.sourceKind || visible.kind || visibleMeta.sourceKind || visibleMeta.kind || source).trim();
    if (source) {
      merged.source = source;
      merged.meta.source = source;
    }
    if (sourceKind) {
      merged.sourceKind = sourceKind;
      merged.kind = sourceKind;
      merged.meta.sourceKind = sourceKind;
    }
    ['userCreated', 'materializedUserFolder', 'trustedFolderDisplay', 'shownInNormalMode', 'protectedCanonicalFallback', 'isCanonical'].forEach((key) => {
      if (stored[key] === true || storedMeta[key] === true || visible[key] === true || visibleMeta[key] === true) merged[key] = true;
    });
    return merged;
  }

  function isProtectedSystemFolderMetadataRow(row) {
    if (!row || typeof row !== 'object') return false;
    const meta = folderMetadataRowMeta(row);
    const id = folderMetadataRowId(row).toLowerCase();
    const nameKey = folderMetadataNameKey(folderMetadataRowName(row));
    if (id === 'unfiled' || nameKey === 'unfiled') return true;
    if (row.isSystem === true || meta.isSystem === true) return true;
    if (row.protectedCanonicalFallback === true || meta.protectedCanonicalFallback === true) return true;
    return folderMetadataSourceTokens(row).some((token) => token === 'known-canonical-display-fallback');
  }

  function isLocalReviewFolderMetadataRow(row) {
    if (!row || typeof row !== 'object') return false;
    const meta = folderMetadataRowMeta(row);
    const bucket = String(row.reviewBucket || meta.reviewBucket || '').trim().toLowerCase();
    if (bucket) return true;
    if (row.hidden === true || meta.hidden === true) return true;
    if (row.shownInNormalMode === false || meta.shownInNormalMode === false) return true;
    return folderMetadataSourceTokens(row).some((token) => token.includes('local-review') || token.includes('cleanup-review') || token.includes('review-required'));
  }

  function isChromeStudioMutableFolderRow(row) {
    if (!row || typeof row !== 'object') return false;
    const folderId = folderMetadataRowId(row);
    const nameKey = folderMetadataNameKey(folderMetadataRowName(row));
    if (!folderId || !nameKey || nameKey === 'unfiled') return false;
    if (isNativeOwnedFolderMirrorRow(row)) return false;
    if (isProtectedSystemFolderMetadataRow(row)) return false;
    if (isLocalReviewFolderMetadataRow(row)) return false;
    const meta = folderMetadataRowMeta(row);
    if (row.materializedUserFolder === true || meta.materializedUserFolder === true) return true;
    if (row.trustedFolderDisplay === true || meta.trustedFolderDisplay === true) return true;
    if (row.userCreated === true || meta.userCreated === true) return true;
    return folderMetadataSourceTokens(row).some((token) => {
      if (STUDIO_USER_FOLDER_ACTION_SOURCES.has(token)) return true;
      return token.includes('desktop')
        || token.includes('sqlite')
        || token.includes('studio')
        || token.includes('import')
        || token === 'stored-folder-state'
        || token === 'folder-state'
        || token === 'chromestoragelocal'
        || token === 'chrome-storage-local';
    });
  }

  async function readChromeFolderMetadataState() {
    if (!hasChromeStorageRead()) {
      return { raw: {}, state: { folders: [], items: {} }, error: 'chrome-storage-read-unavailable' };
    }
    try {
      const raw = await chromeStorageGet(FOLDER_STATE_DATA_KEY);
      return {
        raw: raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {},
        state: normalizeFolderState(raw, 'stored-folder-state'),
        error: '',
      };
    } catch (e) {
      return {
        raw: {},
        state: { folders: [], items: {} },
        error: 'chrome-folder-state-read-failed',
        detail: String(e?.message || e || ''),
      };
    }
  }

  async function readChromeNativeFolderMetadataState() {
    const memoryPayload = normalizeNativeBroadcastPayload(state.lastNativeBroadcastPayload);
    if (memoryPayload?.folderState) return normalizeFolderState(memoryPayload.folderState, 'native-folder-catalog');
    if (!hasChromeStorageRead()) return { folders: [], items: {} };
    try {
      const raw = await chromeStorageGet(NATIVE_BROADCAST_KEY);
      const payload = normalizeNativeBroadcastPayload(raw);
      return normalizeFolderState(payload?.folderState || null, 'native-folder-catalog');
    } catch {
      return { folders: [], items: {} };
    }
  }

  function chromeFolderColorPatchRow(row, nextColor, updatedAt) {
    const source = String(row.source || folderMetadataRowMeta(row).source || 'stored-folder-state').trim() || 'stored-folder-state';
    const sourceKind = String(row.sourceKind || row.kind || folderMetadataRowMeta(row).sourceKind || folderMetadataRowMeta(row).kind || source).trim() || source;
    const folderId = folderMetadataRowId(row);
    const name = folderMetadataRowName(row) || folderId;
    const meta = {
      ...folderMetadataRowMeta(row),
      color: nextColor,
      iconColor: nextColor,
      source,
      sourceKind,
      updatedAt,
    };
    const out = {
      ...row,
      id: folderId,
      folderId,
      name,
      title: name,
      source,
      stateSource: 'stored-folder-state',
      sourceKind,
      kind: sourceKind,
      color: nextColor,
      iconColor: nextColor,
      updatedAt,
      meta,
    };
    ['userCreated', 'materializedUserFolder', 'trustedFolderDisplay', 'shownInNormalMode'].forEach((key) => {
      if (row[key] === true || meta[key] === true) out[key] = true;
    });
    return out;
  }

  function chromeFolderRenamePatchRow(row, nextName, updatedAt) {
    const source = String(row.source || folderMetadataRowMeta(row).source || 'stored-folder-state').trim() || 'stored-folder-state';
    const sourceKind = String(row.sourceKind || row.kind || folderMetadataRowMeta(row).sourceKind || folderMetadataRowMeta(row).kind || source).trim() || source;
    const folderId = folderMetadataRowId(row);
    const color = folderMetadataRowColor(row);
    const meta = {
      ...folderMetadataRowMeta(row),
      name: nextName,
      title: nextName,
      source,
      sourceKind,
      updatedAt,
    };
    const out = {
      ...row,
      id: folderId,
      folderId,
      name: nextName,
      title: nextName,
      source,
      stateSource: 'stored-folder-state',
      sourceKind,
      kind: sourceKind,
      updatedAt,
      meta,
    };
    if (color) {
      out.color = color;
      out.iconColor = color;
      out.meta.color = color;
      out.meta.iconColor = color;
    }
    ['userCreated', 'materializedUserFolder', 'trustedFolderDisplay', 'shownInNormalMode'].forEach((key) => {
      if (row[key] === true || meta[key] === true) out[key] = true;
    });
    return out;
  }

  function folderDisplayRowsFromModel(model) {
    if (!model || typeof model !== 'object') return [];
    const rows = [];
    [
      model.canonicalRows,
      model.folderDisplayRows,
      model.rows,
      model.folders,
    ].forEach((list) => {
      if (!Array.isArray(list)) return;
      list.forEach((row) => {
        if (row && typeof row === 'object') rows.push(row);
      });
    });
    return rows;
  }

  async function readChromeFolderDisplayRow(folderIdInput, reason = '') {
    const folderId = String(folderIdInput || '').trim();
    if (!folderId) return null;
    const getDisplayModel = W.H2O?.Library?.FolderParity?.getDisplayModel;
    if (typeof getDisplayModel !== 'function') return null;
    try {
      const model = await getDisplayModel.call(W.H2O.Library.FolderParity, {
        fresh: true,
        reason: String(reason || 'chrome-folder-display-row-resolve'),
      });
      return folderDisplayRowsFromModel(model)
        .find((candidate) => folderMetadataRowId(candidate) === folderId) || null;
    } catch (e) {
      err('chrome-folder-display-row.resolve', e);
      return null;
    }
  }

  async function confirmChromeFolderDisplayName(folderIdInput, expectedNameInput, reason = '') {
    const folderId = String(folderIdInput || '').trim();
    const expectedName = cleanFolderMetadataName(expectedNameInput);
    if (!folderId) return { ok: false, status: 'folder-identity-missing', folderId, expectedName };
    if (!expectedName) return { ok: false, status: 'invalid-folder-name', folderId, expectedName };
    const getDisplayModel = W.H2O?.Library?.FolderParity?.getDisplayModel;
    if (typeof getDisplayModel !== 'function') {
      return { ok: false, status: 'display-model-unavailable', folderId, expectedName };
    }
    let lastRow = null;
    let lastError = '';
    for (let attempt = 0; attempt < 4; attempt += 1) {
      if (attempt > 0) {
        await new Promise((resolve) => W.setTimeout(resolve, 125));
      }
      try {
        const model = await getDisplayModel.call(W.H2O.Library.FolderParity, {
          fresh: true,
          reason: String(reason || 'chrome-folder-rename-confirmation'),
        });
        const row = folderDisplayRowsFromModel(model)
          .find((candidate) => folderMetadataRowId(candidate) === folderId) || null;
        lastRow = row;
        if (row && folderMetadataRowName(row) === expectedName) {
          return {
            ok: true,
            status: 'confirmed',
            folderId,
            expectedName,
            actualName: folderMetadataRowName(row),
            canonicalMirrorAvailable: model?.canonicalMirrorAvailable === true,
            displayModelAvailable: model?.displayModelAvailable === true,
          };
        }
      } catch (e) {
        lastError = String(e?.message || e || '');
      }
    }
    return {
      ok: false,
      status: lastError ? 'display-model-confirmation-failed' : (lastRow ? 'display-name-not-confirmed' : 'folder-not-in-display-model'),
      folderId,
      expectedName,
      actualName: folderMetadataRowName(lastRow),
      reason: lastError,
    };
  }

  function findDuplicateNameDifferentIdCandidates(currentFolders, incomingFolders) {
    const byName = new Map();
    const add = (folder, source) => {
      const name = String(folder?.name || folder?.title || '').trim().toLowerCase();
      const id = String(folder?.id || folder?.folderId || '').trim();
      if (!name || !id) return;
      const row = byName.get(name) || { name: folder.name || folder.title || name, ids: new Set(), sources: new Set() };
      row.ids.add(id);
      row.sources.add(source);
      byName.set(name, row);
    };
    currentFolders.forEach((folder) => add(folder, 'existing'));
    incomingFolders.forEach((folder) => add(folder, 'incoming'));
    return Array.from(byName.values())
      .filter((row) => row.ids.size > 1)
      .map((row) => ({
        name: String(row.name || ''),
        ids: Array.from(row.ids).slice(0, 8),
        sources: Array.from(row.sources),
      }));
  }

  async function mergeNativeFolderState(nativeFolderState, reason = '') {
    try {
      const raw = nativeFolderState && typeof nativeFolderState === 'object' ? nativeFolderState : null;
      if (!raw || !Array.isArray(raw.folders)) {
        state.lastNativeFolderMergeAt = Date.now();
        state.lastNativeFolderMergeStatus = 'no-native-folder-state';
        state.lastNativeFolderMergeError = '';
        return { ok: false, status: state.lastNativeFolderMergeStatus };
      }
      if (!hasChromeStorageRead() || !hasChromeStorage()) {
        state.lastNativeFolderMergeAt = Date.now();
        state.lastNativeFolderMergeStatus = 'chrome-storage-unavailable';
        state.lastNativeFolderMergeError = 'chrome.storage.local read/write unavailable';
        return { ok: false, status: state.lastNativeFolderMergeStatus, error: state.lastNativeFolderMergeError };
      }

      const incoming = normalizeFolderState(raw, raw.source || 'native-folder-catalog');
      const currentRaw = await chromeStorageGet(FOLDER_STATE_DATA_KEY);
      const current = normalizeFolderState(currentRaw, 'existing-folder-state');
      const duplicates = findDuplicateNameDifferentIdCandidates(current.folders, incoming.folders);
      const currentById = new Map(current.folders.map((folder) => [folder.id, folder]));
      const incomingById = new Map(incoming.folders.map((folder) => [folder.id, folder]));
      const incomingIds = new Set(incoming.folders.map((folder) => folder.id).filter(Boolean));
      const mergedFolders = [];
      const removedNativeFolderIds = [];
      let preservedLocalFolderCount = 0;
      const seen = new Set();

      current.folders.forEach((folder) => {
        const incomingFolder = incomingById.get(folder.id);
        if (incomingFolder) {
          mergedFolders.push(mergeFolderRows(folder, incomingFolder));
        } else if (isNativeOwnedFolderMirrorRow(folder)) {
          removedNativeFolderIds.push(folder.id);
          return;
        } else {
          preservedLocalFolderCount += 1;
          mergedFolders.push(folder);
        }
        seen.add(folder.id);
      });
      incoming.folders.forEach((folder) => {
        if (seen.has(folder.id)) return;
        mergedFolders.push(mergeFolderRows(currentById.get(folder.id), folder));
        seen.add(folder.id);
      });

      const mergedItems = {};
      mergedFolders.forEach((folder) => {
        const existingItems = Array.isArray(current.items[folder.id]) ? current.items[folder.id] : [];
        const incomingItems = Array.isArray(incoming.items[folder.id]) ? incoming.items[folder.id] : [];
        const values = incomingIds.has(folder.id) ? incomingItems : existingItems;
        mergedItems[folder.id] = Array.from(new Set(values.map((value) => String(value || '').trim()).filter(Boolean)));
      });

      const beforeChecksum = stableChecksum({ folders: current.folders, items: current.items });
      const afterChecksum = stableChecksum({ folders: mergedFolders, items: mergedItems });
      const incomingChecksum = String(raw.checksum || stableChecksum({ folders: incoming.folders, items: incoming.items }));
      const incomingBindingCount = countFolderBindings(incoming.items);
      const mergedBindingCount = countFolderBindings(mergedItems);

      state.lastNativeFolderMergeAt = Date.now();
      state.lastNativeFolderMergeIncomingChecksum = incomingChecksum;
      state.lastNativeFolderMergeIncomingFolderCount = incoming.folders.length;
      state.lastNativeFolderMergeIncomingBindingCount = incomingBindingCount;
      state.lastNativeFolderMergeMergedFolderCount = mergedFolders.length;
      state.lastNativeFolderMergeMergedBindingCount = mergedBindingCount;
      state.lastNativeFolderMergeRemovedNativeFolderCount = removedNativeFolderIds.length;
      state.lastNativeFolderMergeRemovedNativeFolderIds = removedNativeFolderIds.slice(0, 16);
      state.lastNativeFolderMergePreservedLocalFolderCount = preservedLocalFolderCount;
      state.lastNativeFolderMergeDuplicateNameDifferentIdCount = duplicates.length;
      state.lastNativeFolderMergeDuplicateNameDifferentIdSample = duplicates.slice(0, 8);
      state.lastNativeFolderMergeCaseArrived = incoming.folders.some((folder) => String(folder.name || '').trim().toLowerCase() === 'case');

      if (beforeChecksum === afterChecksum) {
        state.lastNativeFolderMergeStatus = 'unchanged';
        state.lastNativeFolderMergeChecksum = afterChecksum;
        state.lastNativeFolderMergeError = '';
        step('folder-state.merge.skip', reason || 'unchanged');
        return { ok: true, status: 'unchanged', checksum: afterChecksum };
      }

      await chromeStorageSet({ [FOLDER_STATE_DATA_KEY]: { folders: mergedFolders, items: mergedItems } });
      state.lastNativeFolderMergeStatus = 'merged';
      state.lastNativeFolderMergeChecksum = afterChecksum;
      state.lastNativeFolderMergeError = '';
      step('folder-state.merge', `${incoming.folders.length}->${mergedFolders.length}`);
      return {
        ok: true,
        status: 'merged',
        checksum: afterChecksum,
        incomingFolderCount: incoming.folders.length,
        incomingBindingCount,
        mergedFolderCount: mergedFolders.length,
        mergedBindingCount,
        removedNativeFolderCount: removedNativeFolderIds.length,
        removedNativeFolderIds: removedNativeFolderIds.slice(0, 16),
        preservedLocalFolderCount,
      };
    } catch (e) {
      state.lastNativeFolderMergeAt = Date.now();
      state.lastNativeFolderMergeStatus = 'error';
      state.lastNativeFolderMergeError = String(e?.message || e || 'folder-state-merge-error');
      err('folder-state.merge', e);
      return { ok: false, status: 'error', error: state.lastNativeFolderMergeError };
    }
  }

  function asFiniteNumber(value, fallback = 0) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }

  function rememberExternalNativeFolderMergeDiagnostic(raw, reason = '') {
    const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null;
    state.lastNativeFolderMergeReadAt = Date.now();
    state.lastNativeFolderMergeReadSource = String(reason || 'external-folder-merge-diagnostic');
    if (!src) {
      state.lastNativeFolderMergeReadError = 'external-folder-merge-diagnostic-empty';
      return false;
    }
    state.lastNativeFolderMergeAt = asFiniteNumber(src.at || src.ts, Date.now());
    state.lastNativeFolderMergeStatus = String(src.status || 'external-background-observed');
    state.lastNativeFolderMergeError = String(src.error || src.diagnosticWriteError || '');
    state.lastNativeFolderMergeIncomingChecksum = String(src.incomingChecksum || '');
    state.lastNativeFolderMergeChecksum = String(src.mergedChecksum || src.checksum || '');
    state.lastNativeFolderMergeIncomingFolderCount = asFiniteNumber(src.incomingFolderCount, 0);
    state.lastNativeFolderMergeIncomingBindingCount = asFiniteNumber(src.incomingBindingCount, 0);
    state.lastNativeFolderMergeMergedFolderCount = asFiniteNumber(src.mergedFolderCount || src.afterFolderCount, 0);
    state.lastNativeFolderMergeMergedBindingCount = asFiniteNumber(src.mergedBindingCount, 0);
    state.lastNativeFolderMergeRemovedNativeFolderCount = asFiniteNumber(src.removedNativeFolderCount, 0);
    state.lastNativeFolderMergeRemovedNativeFolderIds = Array.isArray(src.removedNativeFolderIds)
      ? src.removedNativeFolderIds.map((id) => String(id || '').trim()).filter(Boolean).slice(0, 16)
      : [];
    state.lastNativeFolderMergePreservedLocalFolderCount = asFiniteNumber(src.preservedLocalFolderCount, 0);
    state.lastNativeFolderMergeDuplicateNameDifferentIdCount = asFiniteNumber(src.duplicateNameDifferentIdCount, 0);
    state.lastNativeFolderMergeDuplicateNameDifferentIdSample = Array.isArray(src.duplicateNameDifferentIdSample)
      ? src.duplicateNameDifferentIdSample.slice(0, 8)
      : [];
    state.lastNativeFolderMergeCaseArrived = src.caseArrived === true;
    state.lastNativeFolderMergePath = 'external-background';
    state.lastNativeFolderMergeDiagnosticKey = String(src.diagnosticKey || EXTERNAL_NATIVE_FOLDER_MERGE_DIAG_KEY);
    state.lastNativeFolderMergeSourceExtensionId = String(src.sourceExtensionId || src.senderId || '');
    state.lastNativeFolderMergeReadError = '';
    step('folder-state.merge.external-diagnostic', state.lastNativeFolderMergeStatus);
    return true;
  }

  async function refreshExternalNativeFolderMergeDiagnostic(reason = '') {
    if (!hasChromeStorageRead()) {
      state.lastNativeFolderMergeReadAt = Date.now();
      state.lastNativeFolderMergeReadSource = 'chrome.storage.local-unavailable';
      state.lastNativeFolderMergeReadError = 'chrome.storage.local read unavailable';
      return null;
    }
    try {
      const raw = await chromeStorageGet(EXTERNAL_NATIVE_FOLDER_MERGE_DIAG_KEY);
      state.lastNativeFolderMergeReadAt = Date.now();
      state.lastNativeFolderMergeReadSource = raw ? 'chrome.storage.local' : 'chrome.storage.local-empty';
      if (!raw) return null;
      rememberExternalNativeFolderMergeDiagnostic(raw, reason || 'refresh-external-folder-merge-diagnostic');
      return raw;
    } catch (e) {
      state.lastNativeFolderMergeReadAt = Date.now();
      state.lastNativeFolderMergeReadSource = 'error';
      state.lastNativeFolderMergeReadError = String(e?.message || e || 'external-folder-merge-diagnostic-read-error');
      err('folder-state.merge.external-diagnostic.read', e);
      return null;
    }
  }

  function emitNativeBroadcastUpdated(payload, reason) {
    const detail = {
      key: NATIVE_BROADCAST_KEY,
      payload: payload || null,
      reason: String(reason || 'native-broadcast'),
      t: Date.now(),
    };
    try { W.dispatchEvent(new CustomEvent('evt:h2o:library:native-broadcast-updated', { detail })); } catch {}
    try { W.H2O?.events?.emit?.('library:native-broadcast-updated', detail); } catch {}
  }

  function folderMetadataResultBase(requestId, requestMode, operation, code) {
    const op = operation && typeof operation === 'object' ? operation : {};
    return {
      schema: FOLDER_METADATA_OPERATION_RESULT_SCHEMA,
      requestId: String(requestId || '').trim(),
      requestMode: String(requestMode || '').trim(),
      ok: false,
      applied: false,
      noMutation: true,
      readOnly: true,
      canApply: false,
      operationType: String(op.operationType || '').trim(),
      folderId: String(op.folderId || '').trim(),
      before: null,
      after: null,
      blockers: code ? [{ code: String(code) }] : [],
      warnings: [],
    };
  }

  function normalizeNativeOwnerFolderMetadataResult(result, operation) {
    if (!result || typeof result !== 'object') return result;
    const op = operation && typeof operation === 'object' ? operation : {};
    const sourceSurface = String(op.sourceSurface || '').trim();
    if (sourceSurface !== 'chrome-studio') return result;
    const blockers = Array.isArray(result.blockers) ? result.blockers : [];
    if (!blockers.some((entry) => String(entry?.code || '').trim() === 'folder-not-found')) return result;
    return {
      ...result,
      blockers: blockers.map((entry) => {
        if (String(entry?.code || '').trim() !== 'folder-not-found') return entry;
        return { ...entry, code: 'native-owner-folder-not-found' };
      }),
      nativeOwnerOriginalBlocker: 'folder-not-found',
    };
  }

  function folderMetadataRequestId() {
    return `h2o-folder-op-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }

  function currentPlatformAdapter() {
    try {
      const env = W.H2O && W.H2O.Studio && W.H2O.Studio.platform && W.H2O.Studio.platform.env;
      return String(env?.adapter || '');
    } catch { return ''; }
  }

  function cleanFolderMetadataName(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  function folderMetadataNameKey(value) {
    return cleanFolderMetadataName(value).toLowerCase();
  }

  function folderMetadataRowId(row) {
    return String(row && (row.folderId || row.id) || '').trim();
  }

  function folderMetadataRowName(row) {
    return cleanFolderMetadataName(row && (row.name || row.title || row.label || ''));
  }

  function normalizeFolderMetadataHexColor(value) {
    const raw = String(value || '').trim();
    return /^#[0-9a-f]{6}$/i.test(raw) ? raw.toUpperCase() : '';
  }

  function folderMetadataRowColor(row) {
    const meta = folderMetadataRowMeta(row);
    return normalizeFolderMetadataHexColor(row?.iconColor || row?.color || meta.iconColor || meta.color || '');
  }

  function folderMetadataRowMeta(row) {
    return (row && row.meta && typeof row.meta === 'object' && !Array.isArray(row.meta)) ? row.meta : {};
  }

  function folderMetadataSourceTokens(row) {
    const meta = folderMetadataRowMeta(row);
    return [
      row?.source,
      row?.sourceKind,
      row?.kind,
      meta.source,
      meta.sourceKind,
      meta.kind,
    ].map((value) => String(value || '').trim().toLowerCase()).filter(Boolean);
  }

  function isReservedFolderMetadataName(name) {
    return RESERVED_FOLDER_METADATA_NAME_KEYS.has(folderMetadataNameKey(name));
  }

  function isDesktopRenameSafeFolder(row) {
    if (!row || typeof row !== 'object') return false;
    const nameKey = folderMetadataNameKey(folderMetadataRowName(row));
    if (!folderMetadataRowId(row) || !nameKey || nameKey === 'unfiled') return false;
    if (PROTECTED_CANONICAL_FOLDER_NAME_KEYS.has(nameKey)) return false;
    const meta = folderMetadataRowMeta(row);
    if (row.materializedUserFolder === true || meta.materializedUserFolder === true) return true;
    if (row.trustedFolderDisplay === true || meta.trustedFolderDisplay === true) return true;
    if (row.userCreated === true || meta.userCreated === true) return true;
    return folderMetadataSourceTokens(row).some((source) => STUDIO_USER_FOLDER_ACTION_SOURCES.has(source));
  }

  function isDesktopColorSafeFolder(row) {
    return isDesktopRenameSafeFolder(row);
  }

  function comparableDesktopFolderMetadataRows(rows) {
    return (Array.isArray(rows) ? rows : [])
      .map((row) => {
        const meta = folderMetadataRowMeta(row);
        return {
          folderId: folderMetadataRowId(row),
          name: folderMetadataRowName(row),
          parentId: String(row?.parentId || meta.parentId || ''),
          color: String(row?.iconColor || row?.color || meta.iconColor || meta.color || ''),
          source: String(row?.source || meta.source || ''),
          sourceKind: String(row?.sourceKind || row?.kind || meta.sourceKind || meta.kind || ''),
          userCreated: row?.userCreated === true || meta.userCreated === true,
          materializedUserFolder: row?.materializedUserFolder === true || meta.materializedUserFolder === true,
          trustedFolderDisplay: row?.trustedFolderDisplay === true || meta.trustedFolderDisplay === true,
          shownInNormalMode: row?.shownInNormalMode === true || meta.shownInNormalMode === true,
          sortOrder: Number(row?.sortOrder ?? meta.sortOrder ?? 0) || 0,
          createdAt: String(row?.createdAt || meta.createdAt || ''),
          updatedAt: String(row?.updatedAt || meta.updatedAt || ''),
        };
      })
      .filter((row) => row.folderId)
      .sort((a, b) => a.folderId.localeCompare(b.folderId));
  }

  function desktopFolderMetadataSourceHash(rows) {
    return stableChecksum({ folders: comparableDesktopFolderMetadataRows(rows) });
  }

  function nowIso() {
    try { return new Date().toISOString(); } catch { return ''; }
  }

  function getDesktopFolderStore() {
    try { return W.H2O?.Studio?.store?.folders || null; } catch { return null; }
  }

  function getDesktopFolderActions() {
    try { return W.H2O?.Studio?.actions?.folders || null; } catch { return null; }
  }

  async function readDesktopFolderMetadataRows() {
    const store = getDesktopFolderStore();
    if (!store) return { store: null, rows: [], error: 'desktop-folder-store-unavailable' };
    try {
      if (typeof store.list === 'function') {
        const rows = await store.list();
        return { store, rows: Array.isArray(rows) ? rows : [], error: '' };
      }
      if (typeof store.getAll === 'function') {
        const rows = await store.getAll();
        return { store, rows: Array.isArray(rows) ? rows : [], error: '' };
      }
      return { store, rows: [], error: 'desktop-folder-store-list-unavailable' };
    } catch (e) {
      return { store, rows: [], error: 'desktop-folder-store-read-failed', detail: String(e?.message || e || '') };
    }
  }

  function dispatchDesktopFolderMetadataRefresh(reason) {
    const cleanReason = String(reason || 'desktop-folder-metadata-rename').trim() || 'desktop-folder-metadata-rename';
    try {
      W.dispatchEvent(new CustomEvent('evt:h2o:library-index:refresh-request', {
        detail: { reason: `folder-metadata-operations:${cleanReason}` },
      }));
    } catch {}
    try { coalesceEmit(cleanReason); } catch {}
    try { W.H2O?.Library?.FolderParity?.getDisplayModel?.({ reason: cleanReason, fresh: true }); } catch {}
  }

  function scheduleDesktopFolderAutoExport(operationType, folderId, reason = '') {
    try {
      if (currentPlatformAdapter() !== 'tauri') return false;
      const autoExport = W.H2O?.Studio?.sync?.autoExport;
      const scheduler = autoExport && typeof autoExport.schedule === 'function'
        ? autoExport.schedule
        : null;
      const cleanOperation = String(operationType || 'folder-metadata').trim() || 'folder-metadata';
      const exportReason = String(reason || `folder-metadata:desktop-${cleanOperation}`).trim();
      state.lastDesktopFolderAutoExportAt = Date.now();
      state.lastDesktopFolderAutoExportReason = exportReason;
      state.lastDesktopFolderAutoExportResult = null;
      if (!scheduler) {
        state.lastDesktopFolderAutoExportStatus = 'desktop-folder-auto-export-unavailable';
        state.lastDesktopFolderAutoExportError = 'H2O.Studio.sync.autoExport.schedule unavailable';
        return false;
      }
      state.lastDesktopFolderAutoExportStatus = 'export-pending';
      state.lastDesktopFolderAutoExportError = '';
      const scheduled = scheduler.call(autoExport, exportReason);
      state.lastDesktopFolderAutoExportResult = scheduled && typeof scheduled === 'object'
        ? { ...scheduled, folderId: String(folderId || '') }
        : null;
      state.lastDesktopFolderAutoExportStatus = String(scheduled?.status || state.lastDesktopFolderAutoExportStatus || '');
      state.lastDesktopFolderAutoExportError = String(scheduled?.error || '');
      return scheduled?.scheduled === true || scheduled?.ok === true;
    } catch (e) {
      state.lastDesktopFolderAutoExportStatus = 'desktop-folder-auto-export-schedule-failed';
      state.lastDesktopFolderAutoExportError = String(e?.message || e || 'schedule-failed');
      err('desktop-folder-auto-export.schedule', e);
      return false;
    }
  }

  function rememberImmediateFolderMetadataResult(requestId, result) {
    const id = String(requestId || result?.requestId || '').trim();
    state.lastFolderMetadataResultAt = Date.now();
    state.lastFolderMetadataResultId = id;
    state.lastFolderMetadataResultStatus = result?.ok === true ? 'ok' : 'blocked';
    state.lastFolderMetadataRequestStatus = result?.ok === true ? 'resolved' : 'blocked';
    state.lastFolderMetadataResultBlockers = Array.isArray(result?.blockers)
      ? result.blockers.map((entry) => String(entry?.code || '')).filter(Boolean).slice(0, 8)
      : [];
    return result;
  }

  async function buildDesktopRenameFolderMetadataContext(requestId, mode, operation, expectedMode) {
    const op = operation && typeof operation === 'object' ? operation : {};
    const result = folderMetadataResultBase(requestId, mode, op, '');
    result.desktopBridge = 'tauri-folder-store';
    result.desktopRenameFallbackStatus = 'started';
    if (String(mode || '').trim() !== String(expectedMode || '').trim()) {
      result.blockers.push({ code: `desktop-rename-${String(expectedMode || 'unknown')}-only` });
    }
    if (op.schema !== FOLDER_METADATA_OPERATION_SCHEMA) {
      result.blockers.push({ code: 'invalid-folder-metadata-operation' });
    }
    if (String(op.operationType || '').trim() !== 'rename-folder') {
      result.blockers.push({ code: 'desktop-folder-metadata-operation-unsupported' });
    }

    const folderId = folderMetadataRowId(op);
    const after = op.after && typeof op.after === 'object' ? op.after : {};
    const nextName = cleanFolderMetadataName(after.name || after.title || op.name || op.title || '');
    const staleGuard = op.staleGuard && typeof op.staleGuard === 'object' && !Array.isArray(op.staleGuard)
      ? op.staleGuard
      : {};
    const read = await readDesktopFolderMetadataRows();
    if (read.error) result.blockers.push({ code: read.error });
    const rows = Array.isArray(read.rows) ? read.rows : [];
    const sourceHash = desktopFolderMetadataSourceHash(rows);
    const targetFolder = rows.find((row) => folderMetadataRowId(row) === folderId) || null;
    const previousName = folderMetadataRowName(targetFolder);
    const nextKey = folderMetadataNameKey(nextName);
    const previewHash = stableChecksum({
      operationType: 'rename-folder',
      folderId,
      beforeName: previousName,
      name: nextName,
      sourceHash,
    });

    if (!folderId) result.blockers.push({ code: 'folder-id-required' });
    if (folderId && !targetFolder) result.blockers.push({ code: 'folder-not-found' });
    if (targetFolder && !isDesktopRenameSafeFolder(targetFolder)) {
      result.blockers.push({ code: 'folder-rename-not-allowed' });
    }
    if (!nextName) result.blockers.push({ code: 'invalid-folder-name' });
    if (nextName && isReservedFolderMetadataName(nextName)) result.blockers.push({ code: 'reserved-folder-name' });
    if (nextKey && PROTECTED_CANONICAL_FOLDER_NAME_KEYS.has(nextKey)) {
      result.blockers.push({ code: 'protected-canonical-folder-name' });
    }
    if (nextKey && rows.some((row) => folderMetadataRowId(row) !== folderId && folderMetadataNameKey(folderMetadataRowName(row)) === nextKey)) {
      result.blockers.push({ code: 'same-name-conflict' });
    }
    if (expectedMode === 'apply') {
      const guardSourceHash = String(staleGuard.sourceHash || '').trim();
      const guardPreviewHash = String(staleGuard.previewHash || '').trim();
      if (!guardSourceHash || !guardPreviewHash) {
        result.blockers.push({ code: 'stale-guard-required' });
      } else {
        if (guardSourceHash !== sourceHash) result.blockers.push({ code: 'stale-source-hash' });
        if (guardPreviewHash !== previewHash) result.blockers.push({ code: 'stale-preview-hash' });
      }
    }

    result.folderId = folderId;
    result.before = {
      id: folderId,
      folderId,
      name: previousName,
      sourceHash,
      folderCount: rows.length,
      previewHash,
    };
    result.after = {
      id: folderId,
      folderId,
      name: nextName,
      sourceHash,
    };
    result.staleGuard = { sourceHash, previewHash };
    return { result, store: read.store, rows, targetFolder, folderId, previousName, nextName, sourceHash, previewHash };
  }

  async function previewDesktopRenameFolderMetadataOperation(requestId, mode, operation) {
    const ctx = await buildDesktopRenameFolderMetadataContext(requestId, mode, operation, 'preview');
    const result = ctx.result;
    result.previewSource = 'desktop-tauri-folder-store';
    result.desktopRenameFallbackStatus = result.blockers.length ? 'blocked' : 'preview-ok';
    result.applied = false;
    result.noMutation = true;
    result.readOnly = true;
    result.canApply = result.blockers.length === 0;
    result.ok = result.blockers.length === 0;
    return result;
  }

  async function applyDesktopRenameFolderMetadataOperation(requestId, mode, operation) {
    const ctx = await buildDesktopRenameFolderMetadataContext(requestId, mode, operation, 'apply');
    const result = ctx.result;
    result.applySource = 'desktop-tauri-folder-store';
    result.desktopRenameFallbackStatus = result.blockers.length ? 'blocked' : 'apply-started';
    result.readOnly = false;
    result.noMutation = true;
    if (result.blockers.length) {
      result.ok = false;
      result.readOnly = true;
      result.noMutation = true;
      return result;
    }
    const meta = folderMetadataRowMeta(ctx.targetFolder);
    const now = nowIso();
    const patch = {
      name: ctx.nextName,
      meta: {
        ...meta,
        updatedAt: now,
      },
    };
    let actionResult = null;
    const actions = getDesktopFolderActions();
    if (actions && typeof actions.update === 'function') {
      actionResult = await actions.update(ctx.folderId, patch);
      if (!actionResult || actionResult.ok !== true) {
        result.blockers.push({ code: String(actionResult?.status || 'desktop-folder-action-update-failed') });
      }
    } else if (ctx.store && typeof ctx.store.patch === 'function') {
      const row = await ctx.store.patch(ctx.folderId, patch);
      actionResult = { ok: !!row, row };
      if (!row) result.blockers.push({ code: 'desktop-folder-store-patch-failed' });
      dispatchDesktopFolderMetadataRefresh('desktop-folder-rename-apply');
    } else {
      result.blockers.push({ code: 'desktop-folder-store-patch-unavailable' });
    }
    if (result.blockers.length) {
      result.ok = false;
      result.readOnly = true;
      result.noMutation = true;
      result.desktopRenameFallbackStatus = 'blocked';
      return result;
    }

    const updatedRow = actionResult?.row || await ctx.store?.get?.(ctx.folderId).catch(() => null);
    const afterRows = (await readDesktopFolderMetadataRows()).rows || [];
    result.folderId = ctx.folderId;
    result.before = {
      ...result.before,
      name: ctx.previousName,
    };
    result.after = {
      ...(updatedRow && typeof updatedRow === 'object' ? updatedRow : {}),
      id: ctx.folderId,
      folderId: ctx.folderId,
      name: folderMetadataRowName(updatedRow) || ctx.nextName,
      sourceHash: desktopFolderMetadataSourceHash(afterRows),
    };
    result.applied = true;
    result.noMutation = false;
    result.readOnly = false;
    result.canApply = false;
    result.ok = true;
    result.writesPerformed = 1;
    result.desktopRenameFallbackStatus = 'applied';
    state.lastDesktopRenameResultCount += 1;
    dispatchDesktopFolderMetadataRefresh('desktop-folder-rename-apply');
    scheduleDesktopFolderAutoExport('rename-folder', ctx.folderId, 'folder-metadata:desktop-rename');
    return result;
  }

  async function buildDesktopColorFolderMetadataContext(requestId, mode, operation, expectedMode) {
    const op = operation && typeof operation === 'object' ? operation : {};
    const result = folderMetadataResultBase(requestId, mode, op, '');
    result.desktopBridge = 'tauri-folder-store';
    result.desktopColorFallbackStatus = 'started';
    if (String(mode || '').trim() !== String(expectedMode || '').trim()) {
      result.blockers.push({ code: `desktop-color-${String(expectedMode || 'unknown')}-only` });
    }
    if (op.schema !== FOLDER_METADATA_OPERATION_SCHEMA) {
      result.blockers.push({ code: 'invalid-folder-metadata-operation' });
    }
    if (String(op.operationType || '').trim() !== 'change-folder-color') {
      result.blockers.push({ code: 'desktop-folder-metadata-operation-unsupported' });
    }

    const folderId = folderMetadataRowId(op);
    const after = op.after && typeof op.after === 'object' ? op.after : {};
    const nextColor = normalizeFolderMetadataHexColor(after.color || after.iconColor || op.color || op.iconColor || '');
    const staleGuard = op.staleGuard && typeof op.staleGuard === 'object' && !Array.isArray(op.staleGuard)
      ? op.staleGuard
      : {};
    const read = await readDesktopFolderMetadataRows();
    if (read.error) result.blockers.push({ code: read.error });
    const rows = Array.isArray(read.rows) ? read.rows : [];
    const sourceHash = desktopFolderMetadataSourceHash(rows);
    const targetFolder = rows.find((row) => folderMetadataRowId(row) === folderId) || null;
    const previousColor = folderMetadataRowColor(targetFolder);
    const previewHash = stableChecksum({
      operationType: 'change-folder-color',
      folderId,
      beforeColor: previousColor,
      color: nextColor,
      sourceHash,
    });

    if (!folderId) result.blockers.push({ code: 'folder-id-required' });
    if (folderId && !targetFolder) result.blockers.push({ code: 'folder-not-found' });
    if (targetFolder && !isDesktopColorSafeFolder(targetFolder)) {
      result.blockers.push({ code: 'folder-color-not-allowed' });
    }
    if (!nextColor) result.blockers.push({ code: 'invalid-folder-color' });
    if (expectedMode === 'apply') {
      const guardSourceHash = String(staleGuard.sourceHash || '').trim();
      const guardPreviewHash = String(staleGuard.previewHash || '').trim();
      if (!guardSourceHash || !guardPreviewHash) {
        result.blockers.push({ code: 'stale-guard-required' });
      } else {
        if (guardSourceHash !== sourceHash) result.blockers.push({ code: 'stale-source-hash' });
        if (guardPreviewHash !== previewHash) result.blockers.push({ code: 'stale-preview-hash' });
      }
    }

    result.folderId = folderId;
    result.before = {
      id: folderId,
      folderId,
      color: previousColor,
      iconColor: previousColor,
      sourceHash,
      folderCount: rows.length,
      previewHash,
    };
    result.after = {
      id: folderId,
      folderId,
      color: nextColor,
      iconColor: nextColor,
      sourceHash,
    };
    result.staleGuard = { sourceHash, previewHash };
    return { result, store: read.store, rows, targetFolder, folderId, previousColor, nextColor, sourceHash, previewHash };
  }

  async function previewDesktopColorFolderMetadataOperation(requestId, mode, operation) {
    const ctx = await buildDesktopColorFolderMetadataContext(requestId, mode, operation, 'preview');
    const result = ctx.result;
    result.previewSource = 'desktop-tauri-folder-store';
    result.desktopColorFallbackStatus = result.blockers.length ? 'blocked' : 'preview-ok';
    result.applied = false;
    result.noMutation = true;
    result.readOnly = true;
    result.canApply = result.blockers.length === 0;
    result.ok = result.blockers.length === 0;
    return result;
  }

  async function applyDesktopColorFolderMetadataOperation(requestId, mode, operation) {
    const ctx = await buildDesktopColorFolderMetadataContext(requestId, mode, operation, 'apply');
    const result = ctx.result;
    result.applySource = 'desktop-tauri-folder-store';
    result.desktopColorFallbackStatus = result.blockers.length ? 'blocked' : 'apply-started';
    result.readOnly = false;
    result.noMutation = true;
    if (result.blockers.length) {
      result.ok = false;
      result.readOnly = true;
      result.noMutation = true;
      return result;
    }
    const meta = folderMetadataRowMeta(ctx.targetFolder);
    const now = nowIso();
    const patch = {
      color: ctx.nextColor,
      iconColor: ctx.nextColor,
      meta: {
        ...meta,
        color: ctx.nextColor,
        iconColor: ctx.nextColor,
        updatedAt: now,
      },
    };
    let actionResult = null;
    const actions = getDesktopFolderActions();
    if (actions && typeof actions.update === 'function') {
      actionResult = await actions.update(ctx.folderId, patch);
      if (!actionResult || actionResult.ok !== true) {
        result.blockers.push({ code: String(actionResult?.status || 'desktop-folder-action-update-failed') });
      }
    } else if (ctx.store && typeof ctx.store.patch === 'function') {
      const row = await ctx.store.patch(ctx.folderId, patch);
      actionResult = { ok: !!row, row };
      if (!row) result.blockers.push({ code: 'desktop-folder-store-patch-failed' });
      dispatchDesktopFolderMetadataRefresh('desktop-folder-color-apply');
    } else {
      result.blockers.push({ code: 'desktop-folder-store-patch-unavailable' });
    }
    if (result.blockers.length) {
      result.ok = false;
      result.readOnly = true;
      result.noMutation = true;
      result.desktopColorFallbackStatus = 'blocked';
      return result;
    }

    const updatedRow = actionResult?.row || await ctx.store?.get?.(ctx.folderId).catch(() => null);
    const afterRows = (await readDesktopFolderMetadataRows()).rows || [];
    const color = folderMetadataRowColor(updatedRow) || ctx.nextColor;
    result.folderId = ctx.folderId;
    result.before = {
      ...result.before,
      color: ctx.previousColor,
      iconColor: ctx.previousColor,
    };
    result.after = {
      ...(updatedRow && typeof updatedRow === 'object' ? updatedRow : {}),
      id: ctx.folderId,
      folderId: ctx.folderId,
      color,
      iconColor: color,
      sourceHash: desktopFolderMetadataSourceHash(afterRows),
    };
    result.applied = true;
    result.noMutation = false;
    result.readOnly = false;
    result.canApply = false;
    result.ok = true;
    result.writesPerformed = 1;
    result.desktopColorFallbackStatus = 'applied';
    state.lastDesktopColorResultCount += 1;
    dispatchDesktopFolderMetadataRefresh('desktop-folder-color-apply');
    scheduleDesktopFolderAutoExport('change-folder-color', ctx.folderId, 'folder-metadata:desktop-color');
    return result;
  }

  async function buildChromeColorFolderMetadataContext(requestId, mode, operation, expectedMode) {
    const op = operation && typeof operation === 'object' ? operation : {};
    const result = folderMetadataResultBase(requestId, mode, op, '');
    result.chromeResolver = 'folder-state-mirror';
    result.chromeColorMutationStatus = 'started';
    if (String(mode || '').trim() !== String(expectedMode || '').trim()) {
      result.blockers.push({ code: `chrome-color-${String(expectedMode || 'unknown')}-only` });
    }
    if (op.schema !== FOLDER_METADATA_OPERATION_SCHEMA) {
      result.blockers.push({ code: 'invalid-folder-metadata-operation' });
    }
    if (String(op.operationType || '').trim() !== 'change-folder-color') {
      result.blockers.push({ code: 'folder-not-mutable' });
    }

    const folderId = folderMetadataRowId(op);
    const after = op.after && typeof op.after === 'object' ? op.after : {};
    const nextColor = normalizeFolderMetadataHexColor(after.color || after.iconColor || op.color || op.iconColor || '');
    let visibleRow = folderMetadataOperationBeforeRow(op);
    if (!visibleRow && folderId) {
      visibleRow = await readChromeFolderDisplayRow(folderId, 'chrome-folder-color-resolve');
    }
    const read = await readChromeFolderMetadataState();
    if (read.error) result.blockers.push({ code: read.error });
    const storedState = read.state || { folders: [], items: {} };
    const nativeState = await readChromeNativeFolderMetadataState();
    const rows = Array.isArray(storedState.folders) ? storedState.folders : [];
    const storedFolder = rows.find((row) => folderMetadataRowId(row) === folderId) || null;
    const nativeFolder = (Array.isArray(nativeState.folders) ? nativeState.folders : [])
      .find((row) => folderMetadataRowId(row) === folderId) || null;
    const targetFolder = mergeFolderMetadataVisibleRow(storedFolder, visibleRow);
    const hasTargetFolder = !!folderMetadataRowId(targetFolder);
    const sourceHash = chromeFolderMetadataStateHash(storedState);
    const previousColor = folderMetadataRowColor(targetFolder);
    const previewHash = stableChecksum({
      operationType: 'change-folder-color',
      folderId,
      beforeColor: previousColor,
      color: nextColor,
      sourceHash,
    });
    const staleGuard = op.staleGuard && typeof op.staleGuard === 'object' && !Array.isArray(op.staleGuard)
      ? op.staleGuard
      : {};

    if (!folderId) result.blockers.push({ code: 'folder-identity-missing' });
    if (!nextColor) result.blockers.push({ code: 'invalid-folder-color' });
    if (!result.blockers.length && folderId && nativeFolder && (!storedFolder || isNativeOwnedFolderMirrorRow(storedFolder))) {
      result.chromeMutationRoute = 'native-owner';
      result.chromeColorMutationStatus = 'native-owner-route';
      return {
        result,
        route: 'native-owner',
        folderId,
        targetFolder: nativeFolder,
        previousColor: folderMetadataRowColor(nativeFolder),
        nextColor,
      };
    }
    if (!result.blockers.length && hasTargetFolder && isNativeOwnedFolderMirrorRow(targetFolder)) {
      result.chromeMutationRoute = 'native-owner';
      result.chromeColorMutationStatus = 'native-owner-route';
      return {
        result,
        route: 'native-owner',
        folderId,
        targetFolder,
        previousColor: folderMetadataRowColor(targetFolder),
        nextColor,
      };
    }
    if (hasTargetFolder && isProtectedSystemFolderMetadataRow(targetFolder)) {
      result.blockers.push({ code: 'protected-folder' });
    }
    if (hasTargetFolder && isLocalReviewFolderMetadataRow(targetFolder)) {
      result.blockers.push({ code: 'local-review-folder-not-editable' });
    }
    if (folderId && !hasTargetFolder) {
      result.blockers.push({ code: visibleRow ? 'folder-identity-missing' : 'native-owner-folder-not-found' });
    } else if (!result.blockers.length && hasTargetFolder && !isNativeOwnedFolderMirrorRow(targetFolder) && !isChromeStudioMutableFolderRow(targetFolder)) {
      result.blockers.push({ code: 'folder-not-mutable' });
    }
    if (expectedMode === 'apply') {
      const guardSourceHash = String(staleGuard.sourceHash || '').trim();
      const guardPreviewHash = String(staleGuard.previewHash || '').trim();
      if (!guardSourceHash || !guardPreviewHash) {
        result.blockers.push({ code: 'stale-guard-required' });
      } else {
        if (guardSourceHash !== sourceHash) result.blockers.push({ code: 'stale-source-hash' });
        if (guardPreviewHash !== previewHash) result.blockers.push({ code: 'stale-preview-hash' });
      }
    }

    result.folderId = folderId;
    result.chromeMutationRoute = 'studio-local';
    result.before = {
      id: folderId,
      folderId,
      name: folderMetadataRowName(targetFolder),
      color: previousColor,
      iconColor: previousColor,
      source: String(targetFolder?.source || ''),
      sourceKind: String(targetFolder?.sourceKind || targetFolder?.kind || ''),
      sourceHash,
      folderCount: rows.length,
      previewHash,
    };
    result.after = {
      id: folderId,
      folderId,
      color: nextColor,
      iconColor: nextColor,
      sourceHash,
    };
    result.staleGuard = { sourceHash, previewHash };
    return {
      result,
      route: 'studio-local',
      rawState: read.raw || {},
      storedState,
      rows,
      items: storedState.items || {},
      storedFolder,
      targetFolder,
      folderId,
      previousColor,
      nextColor,
      sourceHash,
      previewHash,
    };
  }

  async function previewChromeColorFolderMetadataOperation(requestId, mode, operation) {
    const ctx = await buildChromeColorFolderMetadataContext(requestId, mode, operation, 'preview');
    const result = ctx.result;
    if (ctx.route === 'native-owner') return null;
    result.previewSource = 'chrome-folder-state-mirror';
    result.chromeColorMutationStatus = result.blockers.length ? 'blocked' : 'preview-ok';
    result.applied = false;
    result.noMutation = true;
    result.readOnly = true;
    result.canApply = result.blockers.length === 0 && ctx.previousColor !== ctx.nextColor;
    result.ok = result.blockers.length === 0;
    if (result.ok && ctx.previousColor === ctx.nextColor) {
      result.warnings.push({ code: 'no-op-color-unchanged' });
    }
    return result;
  }

  async function applyChromeColorFolderMetadataOperation(requestId, mode, operation) {
    const ctx = await buildChromeColorFolderMetadataContext(requestId, mode, operation, 'apply');
    const result = ctx.result;
    if (ctx.route === 'native-owner') return null;
    result.applySource = 'chrome-folder-state-mirror';
    result.chromeColorMutationStatus = result.blockers.length ? 'blocked' : 'apply-started';
    result.readOnly = false;
    result.noMutation = true;
    if (result.blockers.length) {
      result.ok = false;
      result.readOnly = true;
      result.noMutation = true;
      return result;
    }
    if (ctx.previousColor === ctx.nextColor) {
      result.ok = true;
      result.applied = false;
      result.readOnly = true;
      result.noMutation = true;
      result.canApply = false;
      result.warnings.push({ code: 'no-op-color-unchanged' });
      result.chromeColorMutationStatus = 'unchanged';
      return result;
    }

    if (!hasChromeStorage()) {
      result.blockers.push({ code: 'chrome-storage-write-unavailable' });
      result.ok = false;
      result.readOnly = true;
      result.noMutation = true;
      result.chromeColorMutationStatus = 'blocked';
      return result;
    }

    const updatedAt = nowIso();
    const nextRow = chromeFolderColorPatchRow(ctx.targetFolder, ctx.nextColor, updatedAt);
    const nextFolders = ctx.rows.map((row) => ({ ...row }));
    const existingIndex = nextFolders.findIndex((row) => folderMetadataRowId(row) === ctx.folderId);
    if (existingIndex >= 0) nextFolders[existingIndex] = nextRow;
    else nextFolders.push(nextRow);
    const nextItems = { ...(ctx.items || {}) };
    if (!Array.isArray(nextItems[ctx.folderId])) nextItems[ctx.folderId] = [];
    const nextState = {
      ...(ctx.rawState || {}),
      schemaVersion: Number(ctx.rawState?.schemaVersion || ctx.rawState?.version || 1) || 1,
      source: String(ctx.rawState?.source || ctx.rawState?.exportedFrom || 'stored-folder-state').trim() || 'stored-folder-state',
      sourceKind: String(ctx.rawState?.sourceKind || 'chrome-folder-state-local-mutation').trim() || 'chrome-folder-state-local-mutation',
      updatedAt,
      folders: nextFolders,
      items: nextItems,
    };
    await chromeStorageSet({ [FOLDER_STATE_DATA_KEY]: nextState });

    const afterState = normalizeFolderState(nextState, 'stored-folder-state');
    const afterSourceHash = chromeFolderMetadataStateHash(afterState);
    result.folderId = ctx.folderId;
    result.before = {
      ...result.before,
      color: ctx.previousColor,
      iconColor: ctx.previousColor,
    };
    result.after = {
      ...nextRow,
      id: ctx.folderId,
      folderId: ctx.folderId,
      color: ctx.nextColor,
      iconColor: ctx.nextColor,
      sourceHash: afterSourceHash,
    };
    result.applied = true;
    result.noMutation = false;
    result.readOnly = false;
    result.canApply = false;
    result.ok = true;
    result.writesPerformed = 1;
    result.chromeColorMutationStatus = existingIndex >= 0 ? 'updated' : 'inserted';
    state.lastChromeFolderColorResultCount += 1;
    try { coalesceEmit('chrome-folder-color-apply'); } catch {}
    scheduleChromeFolderAutoExport(operation, result, 'folder-metadata:chrome-local-color');
    return result;
  }

  async function buildChromeRenameFolderMetadataContext(requestId, mode, operation, expectedMode) {
    const op = operation && typeof operation === 'object' ? operation : {};
    const result = folderMetadataResultBase(requestId, mode, op, '');
    result.chromeResolver = 'folder-state-mirror';
    result.chromeRenameMutationStatus = 'started';
    if (String(mode || '').trim() !== String(expectedMode || '').trim()) {
      result.blockers.push({ code: `chrome-rename-${String(expectedMode || 'unknown')}-only` });
    }
    if (op.schema !== FOLDER_METADATA_OPERATION_SCHEMA) {
      result.blockers.push({ code: 'invalid-folder-metadata-operation' });
    }
    if (String(op.operationType || '').trim() !== 'rename-folder') {
      result.blockers.push({ code: 'folder-not-mutable' });
    }

    const folderId = folderMetadataRowId(op);
    const after = op.after && typeof op.after === 'object' ? op.after : {};
    const nextName = cleanFolderMetadataName(after.name || after.title || op.name || op.title || '');
    let visibleRow = folderMetadataOperationBeforeRow(op);
    if (!visibleRow && folderId) {
      visibleRow = await readChromeFolderDisplayRow(folderId, 'chrome-folder-rename-resolve');
    }
    const read = await readChromeFolderMetadataState();
    if (read.error) result.blockers.push({ code: read.error });
    const storedState = read.state || { folders: [], items: {} };
    const nativeState = await readChromeNativeFolderMetadataState();
    const rows = Array.isArray(storedState.folders) ? storedState.folders : [];
    const storedFolder = rows.find((row) => folderMetadataRowId(row) === folderId) || null;
    const nativeFolder = (Array.isArray(nativeState.folders) ? nativeState.folders : [])
      .find((row) => folderMetadataRowId(row) === folderId) || null;
    const targetFolder = mergeFolderMetadataVisibleRow(storedFolder, visibleRow);
    const hasTargetFolder = !!folderMetadataRowId(targetFolder);
    const sourceHash = chromeFolderMetadataStateHash(storedState);
    const previousName = folderMetadataRowName(targetFolder);
    const nextKey = folderMetadataNameKey(nextName);
    const previewHash = stableChecksum({
      operationType: 'rename-folder',
      folderId,
      beforeName: previousName,
      name: nextName,
      sourceHash,
    });
    const staleGuard = op.staleGuard && typeof op.staleGuard === 'object' && !Array.isArray(op.staleGuard)
      ? op.staleGuard
      : {};

    if (!folderId) result.blockers.push({ code: 'folder-identity-missing' });
    if (!nextName) result.blockers.push({ code: 'invalid-folder-name' });
    if (nextName && isReservedFolderMetadataName(nextName)) result.blockers.push({ code: 'reserved-folder-name' });
    if (nextKey && PROTECTED_CANONICAL_FOLDER_NAME_KEYS.has(nextKey)) {
      result.blockers.push({ code: 'protected-canonical-folder-name' });
    }
    if (nextKey && rows.some((row) => folderMetadataRowId(row) !== folderId && folderMetadataNameKey(folderMetadataRowName(row)) === nextKey)) {
      result.blockers.push({ code: 'same-name-conflict' });
    }
    if (!result.blockers.length && folderId && nativeFolder && (!storedFolder || isNativeOwnedFolderMirrorRow(storedFolder))) {
      result.chromeMutationRoute = 'native-owner';
      result.chromeRenameMutationStatus = 'native-owner-route';
      return {
        result,
        route: 'native-owner',
        folderId,
        targetFolder: nativeFolder,
        previousName: folderMetadataRowName(nativeFolder),
        nextName,
      };
    }
    if (!result.blockers.length && hasTargetFolder && isNativeOwnedFolderMirrorRow(targetFolder)) {
      result.chromeMutationRoute = 'native-owner';
      result.chromeRenameMutationStatus = 'native-owner-route';
      return {
        result,
        route: 'native-owner',
        folderId,
        targetFolder,
        previousName: folderMetadataRowName(targetFolder),
        nextName,
      };
    }
    if (hasTargetFolder && isProtectedSystemFolderMetadataRow(targetFolder)) {
      result.blockers.push({ code: 'protected-folder' });
    }
    if (hasTargetFolder && isLocalReviewFolderMetadataRow(targetFolder)) {
      result.blockers.push({ code: 'local-review-folder-not-editable' });
    }
    if (folderId && !hasTargetFolder) {
      result.blockers.push({ code: visibleRow ? 'folder-identity-missing' : 'native-owner-folder-not-found' });
    } else if (!result.blockers.length && hasTargetFolder && !isNativeOwnedFolderMirrorRow(targetFolder) && !isChromeStudioMutableFolderRow(targetFolder)) {
      result.blockers.push({ code: 'folder-not-mutable' });
    }
    if (expectedMode === 'apply') {
      const guardSourceHash = String(staleGuard.sourceHash || '').trim();
      const guardPreviewHash = String(staleGuard.previewHash || '').trim();
      if (!guardSourceHash || !guardPreviewHash) {
        result.blockers.push({ code: 'stale-guard-required' });
      } else {
        if (guardSourceHash !== sourceHash) result.blockers.push({ code: 'stale-source-hash' });
        if (guardPreviewHash !== previewHash) result.blockers.push({ code: 'stale-preview-hash' });
      }
    }

    result.folderId = folderId;
    result.chromeMutationRoute = 'studio-local';
    result.before = {
      id: folderId,
      folderId,
      name: previousName,
      source: String(targetFolder?.source || ''),
      sourceKind: String(targetFolder?.sourceKind || targetFolder?.kind || ''),
      sourceHash,
      folderCount: rows.length,
      previewHash,
    };
    result.after = {
      id: folderId,
      folderId,
      name: nextName,
      sourceHash,
    };
    result.staleGuard = { sourceHash, previewHash };
    return {
      result,
      route: 'studio-local',
      rawState: read.raw || {},
      storedState,
      rows,
      items: storedState.items || {},
      storedFolder,
      targetFolder,
      folderId,
      previousName,
      nextName,
      sourceHash,
      previewHash,
    };
  }

  async function previewChromeRenameFolderMetadataOperation(requestId, mode, operation) {
    const ctx = await buildChromeRenameFolderMetadataContext(requestId, mode, operation, 'preview');
    const result = ctx.result;
    if (ctx.route === 'native-owner') return null;
    result.previewSource = 'chrome-folder-state-mirror';
    result.chromeRenameMutationStatus = result.blockers.length ? 'blocked' : 'preview-ok';
    result.applied = false;
    result.noMutation = true;
    result.readOnly = true;
    result.canApply = result.blockers.length === 0 && ctx.previousName !== ctx.nextName;
    result.ok = result.blockers.length === 0;
    if (result.ok && ctx.previousName === ctx.nextName) {
      result.warnings.push({ code: 'no-op-name-unchanged' });
    }
    return result;
  }

  async function applyChromeRenameFolderMetadataOperation(requestId, mode, operation) {
    const ctx = await buildChromeRenameFolderMetadataContext(requestId, mode, operation, 'apply');
    const result = ctx.result;
    if (ctx.route === 'native-owner') return null;
    result.applySource = 'chrome-folder-state-mirror';
    result.chromeRenameMutationStatus = result.blockers.length ? 'blocked' : 'apply-started';
    result.readOnly = false;
    result.noMutation = true;
    if (result.blockers.length) {
      result.ok = false;
      result.readOnly = true;
      result.noMutation = true;
      return result;
    }
    if (ctx.previousName === ctx.nextName) {
      result.ok = true;
      result.applied = false;
      result.readOnly = true;
      result.noMutation = true;
      result.canApply = false;
      result.warnings.push({ code: 'no-op-name-unchanged' });
      result.chromeRenameMutationStatus = 'unchanged';
      return result;
    }

    if (!hasChromeStorage()) {
      result.blockers.push({ code: 'chrome-storage-write-unavailable' });
      result.ok = false;
      result.readOnly = true;
      result.noMutation = true;
      result.chromeRenameMutationStatus = 'blocked';
      return result;
    }

    const updatedAt = nowIso();
    const nextRow = chromeFolderRenamePatchRow(ctx.targetFolder, ctx.nextName, updatedAt);
    const nextFolders = ctx.rows.map((row) => ({ ...row }));
    const existingIndex = nextFolders.findIndex((row) => folderMetadataRowId(row) === ctx.folderId);
    if (existingIndex >= 0) nextFolders[existingIndex] = nextRow;
    else nextFolders.push(nextRow);
    const nextItems = { ...(ctx.items || {}) };
    if (!Array.isArray(nextItems[ctx.folderId])) nextItems[ctx.folderId] = [];
    const nextState = {
      ...(ctx.rawState || {}),
      schemaVersion: Number(ctx.rawState?.schemaVersion || ctx.rawState?.version || 1) || 1,
      source: String(ctx.rawState?.source || ctx.rawState?.exportedFrom || 'stored-folder-state').trim() || 'stored-folder-state',
      sourceKind: String(ctx.rawState?.sourceKind || 'chrome-folder-state-local-mutation').trim() || 'chrome-folder-state-local-mutation',
      updatedAt,
      folders: nextFolders,
      items: nextItems,
    };
    await chromeStorageSet({ [FOLDER_STATE_DATA_KEY]: nextState });

    try { coalesceEmit('chrome-folder-rename-apply'); } catch {}
    const display = await confirmChromeFolderDisplayName(ctx.folderId, ctx.nextName, 'chrome-folder-rename-apply');
    if (!display.ok) {
      result.blockers.push({ code: display.status || 'display-name-not-confirmed' });
      result.ok = false;
      result.applied = true;
      result.noMutation = false;
      result.readOnly = true;
      result.canApply = false;
      result.writesPerformed = 1;
      result.displayConfirmation = display;
      result.chromeRenameMutationStatus = 'display-not-confirmed';
      return result;
    }

    const afterState = normalizeFolderState(nextState, 'stored-folder-state');
    const afterSourceHash = chromeFolderMetadataStateHash(afterState);
    result.folderId = ctx.folderId;
    result.before = {
      ...result.before,
      name: ctx.previousName,
    };
    result.after = {
      ...nextRow,
      id: ctx.folderId,
      folderId: ctx.folderId,
      name: ctx.nextName,
      title: ctx.nextName,
      sourceHash: afterSourceHash,
    };
    result.applied = true;
    result.noMutation = false;
    result.readOnly = false;
    result.canApply = false;
    result.ok = true;
    result.writesPerformed = 1;
    result.displayConfirmation = display;
    result.chromeRenameMutationStatus = existingIndex >= 0 ? 'updated' : 'inserted';
    state.lastChromeFolderRenameResultCount += 1;
    scheduleChromeFolderAutoExport(operation, result, 'folder-metadata:chrome-local-rename');
    return result;
  }

  async function requestChromeFolderMetadataOperationIfLocal(requestId, mode, operation) {
    if (currentPlatformAdapter() === 'tauri') return null;
    const operationType = String(operation?.operationType || '').trim();
    const isColor = operationType === 'change-folder-color';
    const isRename = operationType === 'rename-folder';
    if (!isColor && !isRename) return null;
    state.lastChromeFolderMetadataStatus = 'started';
    state.lastChromeFolderMetadataError = '';
    if (isColor) state.lastChromeFolderColorMutationStatus = '';
    if (isRename) state.lastChromeFolderRenameMutationStatus = '';
    state.lastChromeFolderMutationRoute = '';
    state.lastChromeFolderMutationBlocker = '';
    try {
      const result = mode === 'apply'
        ? (isColor
          ? await applyChromeColorFolderMetadataOperation(requestId, mode, operation)
          : await applyChromeRenameFolderMetadataOperation(requestId, mode, operation))
        : (isColor
          ? await previewChromeColorFolderMetadataOperation(requestId, mode, operation)
          : await previewChromeRenameFolderMetadataOperation(requestId, mode, operation));
      if (!result) {
        state.lastChromeFolderMutationRoute = 'native-owner';
        state.lastChromeFolderMetadataStatus = 'native-owner-route';
        if (isColor) state.lastChromeFolderColorMutationStatus = 'native-owner-route';
        if (isRename) state.lastChromeFolderRenameMutationStatus = 'native-owner-route';
        return null;
      }
      state.lastChromeFolderMutationRoute = String(result.chromeMutationRoute || 'studio-local');
      state.lastChromeFolderMetadataStatus = result?.ok === true ? 'ok' : 'blocked';
      if (isColor) {
        state.lastChromeFolderColorMutationStatus = String(result.chromeColorMutationStatus || state.lastChromeFolderMetadataStatus || '');
      }
      if (isRename) {
        state.lastChromeFolderRenameMutationStatus = String(result.chromeRenameMutationStatus || state.lastChromeFolderMetadataStatus || '');
      }
      state.lastChromeFolderMutationBlocker = result.blockers?.[0]?.code || '';
      return rememberImmediateFolderMetadataResult(requestId, result);
    } catch (e) {
      state.lastChromeFolderMetadataStatus = 'error';
      state.lastChromeFolderMetadataError = String(e?.message || e || 'chrome-folder-metadata-operation-failed');
      if (isColor) state.lastChromeFolderColorMutationStatus = 'error';
      if (isRename) state.lastChromeFolderRenameMutationStatus = 'error';
      const result = folderMetadataResultBase(requestId, mode, operation, 'chrome-folder-metadata-operation-failed');
      result.chromeResolver = 'folder-state-mirror';
      if (isColor) result.chromeColorMutationStatus = 'error';
      if (isRename) result.chromeRenameMutationStatus = 'error';
      result.errorCategory = 'chrome-folder-metadata-operation-failed';
      return rememberImmediateFolderMetadataResult(requestId, result);
    }
  }

  async function requestDesktopFolderMetadataOperation(requestId, mode, operation) {
    state.lastDesktopFolderMetadataStatus = 'started';
    state.lastDesktopFolderMetadataError = '';
    state.lastDesktopRenameFallbackStatus = '';
    state.lastDesktopColorFallbackStatus = '';
    try {
      const operationType = String(operation?.operationType || '').trim();
      let result;
      if (operationType !== 'rename-folder' && operationType !== 'change-folder-color') {
        result = folderMetadataResultBase(requestId, mode, operation, 'desktop-folder-metadata-operation-unsupported');
        result.desktopBridge = 'tauri-folder-store';
      } else if (mode === 'preview') {
        result = operationType === 'change-folder-color'
          ? await previewDesktopColorFolderMetadataOperation(requestId, mode, operation)
          : await previewDesktopRenameFolderMetadataOperation(requestId, mode, operation);
      } else if (mode === 'apply') {
        result = operationType === 'change-folder-color'
          ? await applyDesktopColorFolderMetadataOperation(requestId, mode, operation)
          : await applyDesktopRenameFolderMetadataOperation(requestId, mode, operation);
      } else {
        result = folderMetadataResultBase(requestId, mode, operation, 'invalid-request-mode');
      }
      state.lastDesktopFolderMetadataStatus = result?.ok === true ? 'ok' : 'blocked';
      state.lastDesktopRenameFallbackStatus = String(result?.desktopRenameFallbackStatus || state.lastDesktopFolderMetadataStatus || '');
      state.lastDesktopColorFallbackStatus = String(result?.desktopColorFallbackStatus || state.lastDesktopColorFallbackStatus || '');
      return rememberImmediateFolderMetadataResult(requestId, result);
    } catch (e) {
      state.lastDesktopFolderMetadataStatus = 'error';
      state.lastDesktopFolderMetadataError = String(e?.message || e || 'desktop-folder-metadata-operation-failed');
      state.lastDesktopRenameFallbackStatus = 'error';
      state.lastDesktopColorFallbackStatus = 'error';
      const result = folderMetadataResultBase(requestId, mode, operation, 'desktop-folder-metadata-operation-failed');
      result.desktopBridge = 'tauri-folder-store';
      result.desktopRenameFallbackStatus = 'error';
      result.desktopColorFallbackStatus = 'error';
      result.errorCategory = 'desktop-folder-metadata-operation-failed';
      return rememberImmediateFolderMetadataResult(requestId, result);
    }
  }

  function folderMetadataRequestTransportBlocker(operation) {
    const adapter = currentPlatformAdapter();
    if (adapter === 'tauri') {
      const operationType = String(operation?.operationType || '').trim();
      if (!operationType || DESKTOP_FOLDER_METADATA_SUPPORTED_OPERATION_TYPES.includes(operationType)) return '';
      return 'desktop-folder-metadata-operation-unsupported';
    }
    if (!hasChromeStorage() && !getPlatformBroadcast()) return 'native-owner-broadcast-unavailable';
    return '';
  }

  function settleFolderMetadataRequest(requestId, result) {
    const id = String(requestId || '').trim();
    if (!id) return false;
    const pending = state.pendingFolderMetadataRequests.get(id);
    if (!pending) return false;
    const settledResult = normalizeNativeOwnerFolderMetadataResult(result, pending.operation);
    try { W.clearTimeout(pending.timer); } catch {}
    state.pendingFolderMetadataRequests.delete(id);
    state.lastFolderMetadataResultAt = Date.now();
    state.lastFolderMetadataResultId = id;
    state.lastFolderMetadataResultStatus = settledResult?.ok === true ? 'ok' : 'blocked';
    state.lastFolderMetadataRequestStatus = settledResult?.ok === true ? 'resolved' : 'blocked';
    state.lastFolderMetadataResultBlockers = Array.isArray(settledResult?.blockers)
      ? settledResult.blockers.map((entry) => String(entry?.code || '')).filter(Boolean).slice(0, 8)
      : [];
    scheduleChromeFolderAutoExport(pending.operation, settledResult, 'folder-metadata:native-owner-apply');
    pending.resolve(settledResult);
    return true;
  }

  function rememberFolderMetadataOperationResults(payload, reason = '') {
    const results = Array.isArray(payload?.folderMetadataOperationResults)
      ? payload.folderMetadataOperationResults
      : [];
    if (!results.length) return;
    results.slice(0, 16).forEach((raw) => {
      if (!raw || typeof raw !== 'object') return;
      const result = {
        ...raw,
        schema: String(raw.schema || FOLDER_METADATA_OPERATION_RESULT_SCHEMA),
        requestId: String(raw.requestId || '').trim(),
      };
      try {
        W.dispatchEvent(new CustomEvent('evt:h2o:folder-metadata-operation-result', {
          detail: { result, reason: String(reason || 'native-broadcast'), t: Date.now() },
        }));
      } catch {}
      settleFolderMetadataRequest(result.requestId, result);
    });
    step('folder-metadata.results', String(results.length));
  }

  function triggerChromeAutoImport(reason = '') {
    try {
      const autoImport = H2O.Studio?.sync?.autoImport;
      const eventName = 'evt:h2o:sync:chrome-auto-import:trigger';
      const detail = { reason: String(reason || 'native-broadcast'), t: Date.now(), source: 'studio-library-sync' };
      if (autoImport && typeof autoImport.trigger === 'function') {
        autoImport.trigger({ eventName, reason: detail.reason, detail });
        state.lastAutoImportTriggerAt = detail.t;
        state.lastAutoImportTriggerReason = detail.reason;
        state.lastAutoImportTriggerPath = 'direct-api';
        return true;
      }
      try { W.dispatchEvent(new CustomEvent(eventName, { detail })); } catch {}
      state.lastAutoImportTriggerAt = detail.t;
      state.lastAutoImportTriggerReason = detail.reason;
      state.lastAutoImportTriggerPath = 'window-event';
      return true;
    } catch (e) {
      err('auto-import.trigger', e);
      return false;
    }
  }

  function scheduleChromeFolderAutoExport(operation, result, reason = '') {
    try {
      if (currentPlatformAdapter() !== 'mv3') return false;
      const opType = String(result?.operationType || operation?.operationType || '').trim();
      if (!CHROME_FOLDER_AUTO_EXPORT_OPERATION_TYPES.has(opType)) return false;
      if (result?.ok !== true || result?.applied !== true) return false;
      const folder = H2O.Studio?.sync?.folder;
      const scheduler = folder && typeof folder.scheduleChromeToDesktopExport === 'function'
        ? folder.scheduleChromeToDesktopExport
        : null;
      const exportReason = String(reason || `folder-metadata:${opType}`).trim();
      state.lastChromeFolderAutoExportAt = Date.now();
      state.lastChromeFolderAutoExportReason = exportReason;
      state.lastChromeFolderAutoExportResult = null;
      if (!scheduler) {
        state.lastChromeFolderAutoExportStatus = 'chrome-folder-auto-export-unavailable';
        state.lastChromeFolderAutoExportError = 'H2O.Studio.sync.folder.scheduleChromeToDesktopExport unavailable';
        return false;
      }
      state.lastChromeFolderAutoExportStatus = 'export-pending';
      state.lastChromeFolderAutoExportError = '';
      const scheduled = scheduler.call(folder, {
        reason: exportReason,
        operationType: opType,
        folderId: String(result?.folderId || result?.after?.folderId || result?.after?.id || operation?.folderId || ''),
      });
      if (scheduled && typeof scheduled.then === 'function') {
        scheduled.then((scheduledResult) => {
          state.lastChromeFolderAutoExportResult = scheduledResult && typeof scheduledResult === 'object'
            ? { ...scheduledResult }
            : null;
          state.lastChromeFolderAutoExportStatus = String(scheduledResult?.status || state.lastChromeFolderAutoExportStatus || '');
          state.lastChromeFolderAutoExportError = String(scheduledResult?.error || '');
        }).catch((e) => {
          state.lastChromeFolderAutoExportStatus = 'chrome-folder-auto-export-schedule-failed';
          state.lastChromeFolderAutoExportError = String(e?.message || e || 'schedule-failed');
          err('chrome-folder-auto-export.schedule.async', e);
        });
      } else {
        state.lastChromeFolderAutoExportResult = scheduled && typeof scheduled === 'object' ? { ...scheduled } : null;
        state.lastChromeFolderAutoExportStatus = String(scheduled?.status || state.lastChromeFolderAutoExportStatus || '');
        state.lastChromeFolderAutoExportError = String(scheduled?.error || '');
      }
      return true;
    } catch (e) {
      state.lastChromeFolderAutoExportStatus = 'chrome-folder-auto-export-schedule-failed';
      state.lastChromeFolderAutoExportError = String(e?.message || e || 'schedule-failed');
      err('chrome-folder-auto-export.schedule', e);
      return false;
    }
  }

  function rememberNativeBroadcast(payload, reason = '') {
    try {
      const p = normalizeNativeBroadcastPayload(payload);
      const beforeSignature = state.lastNativeBroadcastSignature || '';
      const afterSignature = nativeBroadcastSignature(p);
      const changed = !!afterSignature && beforeSignature !== afterSignature;
      state.lastNativeBroadcastAt = Date.now();
      state.lastNativeBroadcastTs = Number(p?.ts || 0) || 0;
      state.lastNativeBroadcastKeys = p ? Object.keys(p).slice(0, 24) : [];
      state.lastNativeBroadcastReasons = Array.isArray(p?.reasons) ? p.reasons.slice(0, 24) : [];
      state.lastNativeBroadcastHasLinkedRecords = Array.isArray(p?.linkedRecords);
      state.lastNativeBroadcastLinkedRecordsCount = Array.isArray(p?.linkedRecords) ? p.linkedRecords.length : 0;
      state.lastNativeBroadcastProjectCatalogCount = Array.isArray(p?.projectCatalog?.rows) ? p.projectCatalog.rows.length : 0;
      state.lastNativeBroadcastProjectCatalogSource = String(p?.projectCatalog?.source || '');
      state.lastNativeBroadcastFolderCount = Array.isArray(p?.folderState?.folders) ? p.folderState.folders.length : 0;
      state.lastNativeBroadcastFolderBindingCount = Number(p?.folderState?.counts?.bindingCount || countFolderBindings(p?.folderState?.items)) || 0;
      state.lastNativeBroadcastFolderSource = String(p?.folderState?.source || '');
      state.lastNativeBroadcastSnapshotPayloadCount = Array.isArray(p?.snapshotPayloads) ? p.snapshotPayloads.length : 0;
      state.lastNativeBroadcastSignatureBefore = beforeSignature;
      state.lastNativeBroadcastSignatureAfter = afterSignature;
      state.lastNativeBroadcastChanged = changed;
      if (!changed && beforeSignature && afterSignature) {
        state.lastNativeBroadcastSkipReason = 'unchanged-native-broadcast-signature';
        state.lastNativeBroadcastSkippedCount += 1;
        step('native-broadcast.skip-unchanged', String(reason || 'refresh'));
        return Promise.resolve({ ok: true, status: 'unchanged-native-broadcast-signature', changed: false });
      }
      state.lastNativeBroadcastSignature = afterSignature || beforeSignature;
      state.lastNativeBroadcastSkipReason = '';
      state.lastNativeBroadcastPayload = redactNativeBroadcastPayload(p);
      let materializePromise = Promise.resolve(null);
      if (Array.isArray(p?.snapshotPayloads) && p.snapshotPayloads.length) {
        materializePromise = materializeNativeSnapshotPayloads(p.snapshotPayloads, reason || 'native-broadcast').catch((e) => {
          state.lastNativeSnapshotPayloadMaterializeStatus = 'error';
          state.lastNativeSnapshotPayloadError = String(e?.message || e || 'snapshot-payload-import-error');
          err('native-snapshot-payload.materialize.async', e);
          return { ok: false, status: 'error', error: state.lastNativeSnapshotPayloadError };
        });
        state.lastNativeSnapshotPayloadMaterializePromise = materializePromise;
      }
      let folderMergePromise = Promise.resolve(null);
      if (p?.folderState) {
        folderMergePromise = mergeNativeFolderState(p.folderState, reason || 'native-broadcast')
          .then((result) => {
            coalesceEmit('native-folder-state-merged');
            return result;
          })
          .catch((e) => {
            err('folder-state.merge.async', e);
            return { ok: false, status: 'error', error: String(e?.message || e || 'folder-state-merge-error') };
          });
        state.lastNativeFolderMergePromise = folderMergePromise;
      }
      rememberFolderMetadataOperationResults(p, reason);
      emitNativeBroadcastUpdated(state.lastNativeBroadcastPayload, reason);
      return Promise.all([folderMergePromise, materializePromise]).then((results) => ({
        folderMerge: results[0] || null,
        snapshotPayloadMaterialize: results[1] || null,
      }));
    } catch (e) {
      err('native-broadcast.remember', e);
      return Promise.resolve(null);
    }
  }

  async function refreshNativeBroadcast(reason = '') {
    if (!hasChromeStorageRead()) {
      state.lastNativeBroadcastReadAt = Date.now();
      state.lastNativeBroadcastReadSource = 'none';
      state.lastNativeBroadcastReadError = 'chrome-storage-read-unavailable';
      return null;
    }
    try {
      const raw = await new Promise((resolve) => {
        try {
          chrome.storage.local.get(NATIVE_BROADCAST_KEY, (items) => {
            if (chrome.runtime && chrome.runtime.lastError) { resolve(null); return; }
            resolve(items && items[NATIVE_BROADCAST_KEY]);
          });
        } catch { resolve(null); }
      });
      const payload = normalizeNativeBroadcastPayload(raw);
      state.lastNativeBroadcastReadAt = Date.now();
      state.lastNativeBroadcastReadSource = payload ? 'chrome.storage.local' : 'chrome.storage.local-empty';
      state.lastNativeBroadcastReadError = payload ? '' : state.lastNativeBroadcastReadError;
      if (payload) {
        await rememberNativeBroadcast(payload, reason || 'refresh');
        step('native-broadcast.refresh', String(reason || 'manual'));
      }
      return state.lastNativeBroadcastPayload || redactNativeBroadcastPayload(payload);
    } catch (e) {
      state.lastNativeBroadcastReadAt = Date.now();
      state.lastNativeBroadcastReadSource = 'error';
      state.lastNativeBroadcastReadError = String(e?.message || e || 'native-broadcast-read-error');
      err('native-broadcast.refresh', e);
      return null;
    }
  }

  /* Single change-handler body, shared by the platform-backed and legacy
   * fallback paths so behavior is byte-identical regardless of transport. */
  function handleChanges(changes, area) {
    if (area !== 'local') return;
    const hits = [];
    const changedKeys = Object.keys(changes || {});
    state.lastChangeKeys = changedKeys.slice(-24);
    for (const key of changedKeys) {
      if (key === EXTERNAL_NATIVE_FOLDER_MERGE_DIAG_KEY) {
        rememberExternalNativeFolderMergeDiagnostic(changes[key]?.newValue || null, 'storage.onChanged');
      }
      if (isWatchedKey(key)) hits.push(key);
      if (key === BROADCAST_KEY) {
        // chrome.storage.onChanged fires in the writing context too, so
        // every Studio-originated broadcast would otherwise come back as
        // an inbound event and trigger a wasteful self-refresh. Skip if
        // the payload identifies itself as Studio's own write.
        const newVal = changes[BROADCAST_KEY] && changes[BROADCAST_KEY].newValue;
        if (newVal && newVal.surface === 'studio') continue;
        hits.push('broadcast');
      }
      // Native counterpart (0F1h) writes here on its own state changes.
      // Studio reacts so a folder/category mutation made in a chatgpt.com
      // tab refreshes the open Library page.
      if (key === NATIVE_BROADCAST_KEY) {
        rememberNativeBroadcast(changes[NATIVE_BROADCAST_KEY]?.newValue || null, 'storage.onChanged');
        hits.push('native-broadcast');
      }
    }
    if (hits.length) {
      state.lastWatchedHits = hits.slice(-24);
      coalesceEmit(`${state.transport || 'transport'}:${hits.length}`);
    }
  }

  function emitSync(reasonList) {
    const reasons = Array.from(new Set(reasonList || []));
    const detail = { reasons, t: Date.now(), surface: 'studio' };
    try { W.dispatchEvent(new CustomEvent('evt:h2o:library:cross-surface-sync', { detail })); } catch {}
    try { W.dispatchEvent(new CustomEvent('h2o:library:cross-surface-sync', { detail })); } catch {}
    try { W.H2O?.events?.emit?.('library:cross-surface-sync', detail); } catch {}
    state.subscribers.forEach((fn) => { try { fn(detail); } catch (e) { err('subscriber', e); } });
    state.lastEmittedReasons = reasons.slice(0, 24);
    step('emit-sync', String(reasons.length));
  }

  function coalesceEmit(reason) {
    state.pendingReasons.add(String(reason || 'change'));
    if (state.pendingTimer) return;
    state.pendingTimer = W.setTimeout(() => {
      const reasons = Array.from(state.pendingReasons);
      state.pendingReasons.clear();
      state.pendingTimer = null;
      state.lastSync = Date.now();
      emitSync(reasons);
      // Bust caches on Workspace + refresh Index.
      try {
        const ws = H2O.LibraryWorkspace;
        const idx = H2O.LibraryIndex;
        const owners = [];
        if (idx?.refresh) {
          owners.push('library-index');
          idx.refresh('cross-surface-sync')
            .then(() => { triggerChromeAutoImport('library-index-refreshed:native-broadcast'); })
            .catch(() => { triggerChromeAutoImport('library-index-refresh-error:native-broadcast'); });
        }
        // Workspace caches will bust naturally via the index-updated subscription.
        if (ws?._bustCaches) {
          owners.push('library-workspace');
          ws._bustCaches('cross-surface-sync');
        }
        state.lastRefreshOwners = owners;
        if (!owners.includes('library-index')) triggerChromeAutoImport('cross-surface-sync:no-library-index');
      } catch (e) { err('refresh.bust', e); }
    }, COALESCE_MS);
  }

  function bindTransport() {
    if (state.bound) return true;
    // Prefer the platform adapter (Tauri-portable path).
    const pb = getPlatformBroadcast();
    if (pb) {
      try {
        state.unsub = pb.onAnyChange(handleChanges);
        state.transport = 'platform.broadcast';
        state.bound = true;
        step('bind.platform.broadcast');
        return true;
      } catch (e) { err('bind.platform.broadcast', e); /* fall through to legacy */ }
    }
    // Legacy direct chrome.storage path — preserved for graceful degradation
    // when the platform adapter is the fallback (e.g., chrome.* unavailable).
    if (!hasChromeStorage()) return false;
    if (!chrome.storage.onChanged || typeof chrome.storage.onChanged.addListener !== 'function') return false;
    try {
      const listener = (changes, area) => handleChanges(changes, area);
      chrome.storage.onChanged.addListener(listener);
      state.unsub = () => { try { chrome.storage.onChanged.removeListener(listener); } catch (_) {} };
      state.transport = 'chrome.storage.fallback';
      state.bound = true;
      step('bind.chrome.storage.fallback');
      return true;
    } catch (e) { err('bind.chrome.storage.fallback', e); return false; }
  }

  function broadcastFromStudio(reason, payload) {
    // Write a small ticking sentinel — native's listener (registered by
    // scripts/0F1h native counterpart) picks this up via chrome.storage.
    // The wire format (BROADCAST_KEY, body shape) is part of the legacy
    // cross-surface protocol and is intentionally preserved.
    const body = {
      ts: Date.now(),
      surface: 'studio',
      reason: String(reason || 'studio-change'),
      payload: payload && typeof payload === 'object' ? payload : null,
    };
    state.lastStudioBroadcastAt = body.ts;
    state.lastStudioBroadcastReason = body.reason;
    state.lastStudioBroadcastPayloadKeys = body.payload ? Object.keys(body.payload).slice(0, 24) : [];
    const pb = getPlatformBroadcast();
    if (pb) {
      try {
        state.lastStudioBroadcastTransport = 'platform.broadcast';
        forwardStudioBroadcastToNativeOwners(body);
        // emitRaw is fire-and-forget for callers; preserve sync `return true`
        // semantics by not awaiting. Errors funnel into err() via .catch.
        pb.emitRaw(BROADCAST_KEY, body)
          .then(() => step('broadcast.platform', body.reason))
          .catch((e) => err('broadcast.platform', e));
        return true;
      } catch (e) { err('broadcast.platform', e); /* fall through to legacy */ }
    }
    if (!hasChromeStorage()) {
      state.lastStudioBroadcastTransport = 'drop:no-chrome-storage';
      return false;
    }
    try {
      state.lastStudioBroadcastTransport = 'chrome.storage.fallback';
      forwardStudioBroadcastToNativeOwners(body);
      chrome.storage.local.set({ [BROADCAST_KEY]: body }, () => {
        step('broadcast.fallback', body.reason);
      });
      return true;
    } catch (e) {
      state.lastStudioBroadcastTransport = 'drop:error';
      err('broadcast.fallback', e);
      return false;
    }
  }

  async function requestFolderMetadataOperation(operation, options = {}) {
    const opts = options && typeof options === 'object' ? options : {};
    const mode = String(opts.requestMode || 'preview').trim();
    const op = operation && typeof operation === 'object' ? {
      schema: operation.schema || FOLDER_METADATA_OPERATION_SCHEMA,
      ...operation,
      sourceSurface: operation.sourceSurface || 'chrome-studio',
      createdAt: operation.createdAt || new Date().toISOString(),
    } : null;
    const requestId = String(opts.requestId || folderMetadataRequestId()).trim();
    if (mode !== 'preview' && mode !== 'apply') {
      return Promise.resolve(folderMetadataResultBase(requestId, mode, op, 'invalid-request-mode'));
    }
    if (!op || op.schema !== FOLDER_METADATA_OPERATION_SCHEMA) {
      return Promise.resolve(folderMetadataResultBase(requestId, mode, op, 'invalid-folder-metadata-operation'));
    }
    const reason = String(opts.reason || `folder-metadata-operation-${mode}-request`);
    const waitForResult = opts.waitForResult !== false;
    const timeoutMsRaw = Number(opts.timeoutMs || FOLDER_METADATA_REQUEST_DEFAULT_TIMEOUT_MS);
    const timeoutMs = Math.max(500, Math.min(30000, Number.isFinite(timeoutMsRaw) ? timeoutMsRaw : FOLDER_METADATA_REQUEST_DEFAULT_TIMEOUT_MS));
    const createdAt = new Date().toISOString();
    state.lastFolderMetadataRequestAt = Date.now();
    state.lastFolderMetadataRequestId = requestId;
    state.lastFolderMetadataRequestMode = mode;
    state.lastFolderMetadataRequestStatus = waitForResult ? 'pending' : 'sent';
    state.lastFolderMetadataRequestEnvelope = {
      requestId,
      requestMode: mode,
      operationType: String(op.operationType || ''),
      folderId: String(op.folderId || ''),
      afterName: String(op.after?.name || op.name || ''),
      reason,
      timeoutMs,
      waitForResult,
      createdAt,
      payloadKeys: [],
    };

    const blocker = folderMetadataRequestTransportBlocker(op);
    if (blocker) {
      return Promise.resolve(rememberImmediateFolderMetadataResult(requestId, folderMetadataResultBase(requestId, mode, op, blocker)));
    }
    if (currentPlatformAdapter() === 'tauri') {
      return requestDesktopFolderMetadataOperation(requestId, mode, op);
    }
    const localChromeResult = await requestChromeFolderMetadataOperationIfLocal(requestId, mode, op);
    if (localChromeResult) return localChromeResult;
    if (state.pendingFolderMetadataRequests.size >= FOLDER_METADATA_REQUEST_MAX_PENDING) {
      return Promise.resolve(rememberImmediateFolderMetadataResult(requestId, folderMetadataResultBase(requestId, mode, op, 'too-many-pending-folder-metadata-requests')));
    }

    const request = {
      schema: FOLDER_METADATA_OPERATION_REQUEST_SCHEMA,
      requestId,
      requestMode: mode,
      operation: op,
      createdAt,
    };
    const payload = { folderMetadataOperationRequests: [request] };
    state.lastFolderMetadataRequestEnvelope.payloadKeys = Object.keys(payload);

    if (!waitForResult) {
      const sent = broadcastFromStudio(reason, payload);
      state.lastFolderMetadataRequestStatus = sent ? 'sent' : 'broadcast-failed';
      return Promise.resolve(sent
        ? { schema: FOLDER_METADATA_OPERATION_RESULT_SCHEMA, requestId, requestMode: mode, ok: true, applied: false, noMutation: true, blockers: [], warnings: [], sent: true }
        : folderMetadataResultBase(requestId, mode, op, 'native-owner-broadcast-unavailable'));
    }

    return new Promise((resolve) => {
      const timer = W.setTimeout(() => {
        try {
          refreshNativeBroadcast('folder-metadata-timeout-check').finally(() => {
            if (!state.pendingFolderMetadataRequests.has(requestId)) return;
            const timeoutResult = folderMetadataResultBase(requestId, mode, op, 'native-owner-timeout');
            state.pendingFolderMetadataRequests.delete(requestId);
            state.lastFolderMetadataRequestStatus = 'timeout';
            state.folderMetadataTimeoutCount += 1;
            state.lastFolderMetadataResultAt = Date.now();
            state.lastFolderMetadataResultId = requestId;
            state.lastFolderMetadataResultStatus = 'timeout';
            state.lastFolderMetadataResultBlockers = ['native-owner-timeout'];
            resolve(timeoutResult);
          });
        } catch {
          const timeoutResult = folderMetadataResultBase(requestId, mode, op, 'native-owner-timeout');
          state.pendingFolderMetadataRequests.delete(requestId);
          state.lastFolderMetadataRequestStatus = 'timeout';
          state.folderMetadataTimeoutCount += 1;
          state.lastFolderMetadataResultAt = Date.now();
          state.lastFolderMetadataResultId = requestId;
          state.lastFolderMetadataResultStatus = 'timeout';
          state.lastFolderMetadataResultBlockers = ['native-owner-timeout'];
          resolve(timeoutResult);
        }
      }, timeoutMs);
      state.pendingFolderMetadataRequests.set(requestId, { resolve, timer, operation: op, mode, createdAt: Date.now() });
      const sent = broadcastFromStudio(reason, payload);
      if (!sent) {
        const failed = folderMetadataResultBase(requestId, mode, op, 'native-owner-broadcast-unavailable');
        state.lastFolderMetadataRequestStatus = 'broadcast-failed';
        settleFolderMetadataRequest(requestId, failed);
      }
    });
  }

  const FolderMetadataOperations = {
    request: requestFolderMetadataOperation,
    diagnose() {
      return {
        requestSchema: FOLDER_METADATA_OPERATION_REQUEST_SCHEMA,
        operationSchema: FOLDER_METADATA_OPERATION_SCHEMA,
        resultSchema: FOLDER_METADATA_OPERATION_RESULT_SCHEMA,
        adapter: currentPlatformAdapter(),
        transportBlocker: folderMetadataRequestTransportBlocker(),
        supportedOperationTypes: currentPlatformAdapter() === 'tauri'
          ? DESKTOP_FOLDER_METADATA_SUPPORTED_OPERATION_TYPES.slice()
          : ['create-folder', 'rename-folder', 'change-folder-color'],
        desktopBridge: currentPlatformAdapter() === 'tauri' ? 'tauri-folder-store' : '',
        desktopRenameFallbackStatus: state.lastDesktopRenameFallbackStatus,
        desktopRenameResultCount: state.lastDesktopRenameResultCount,
        desktopColorFallbackStatus: state.lastDesktopColorFallbackStatus,
        desktopColorResultCount: state.lastDesktopColorResultCount,
        desktopFolderAutoExport: {
          at: state.lastDesktopFolderAutoExportAt,
          reason: state.lastDesktopFolderAutoExportReason,
          status: state.lastDesktopFolderAutoExportStatus,
          error: state.lastDesktopFolderAutoExportError,
          result: state.lastDesktopFolderAutoExportResult ? { ...state.lastDesktopFolderAutoExportResult } : null,
        },
        desktopFolderMetadataStatus: state.lastDesktopFolderMetadataStatus,
        desktopFolderMetadataError: state.lastDesktopFolderMetadataError,
        chromeResolver: currentPlatformAdapter() === 'tauri' ? '' : 'folder-state-mirror-or-native-owner',
        chromeFolderMetadataStatus: state.lastChromeFolderMetadataStatus,
        chromeFolderMetadataError: state.lastChromeFolderMetadataError,
        chromeFolderColorMutationStatus: state.lastChromeFolderColorMutationStatus,
        chromeFolderColorResultCount: state.lastChromeFolderColorResultCount,
        chromeFolderRenameMutationStatus: state.lastChromeFolderRenameMutationStatus,
        chromeFolderRenameResultCount: state.lastChromeFolderRenameResultCount,
        chromeFolderMutationRoute: state.lastChromeFolderMutationRoute,
        chromeFolderMutationBlocker: state.lastChromeFolderMutationBlocker,
        chromeFolderAutoExport: {
          at: state.lastChromeFolderAutoExportAt,
          reason: state.lastChromeFolderAutoExportReason,
          status: state.lastChromeFolderAutoExportStatus,
          error: state.lastChromeFolderAutoExportError,
          result: state.lastChromeFolderAutoExportResult ? { ...state.lastChromeFolderAutoExportResult } : null,
        },
        pendingRequests: state.pendingFolderMetadataRequests.size,
        lastRequestAt: state.lastFolderMetadataRequestAt,
        lastRequestId: state.lastFolderMetadataRequestId,
        lastRequestMode: state.lastFolderMetadataRequestMode,
        lastRequestStatus: state.lastFolderMetadataRequestStatus,
        lastRequestEnvelope: state.lastFolderMetadataRequestEnvelope ? { ...state.lastFolderMetadataRequestEnvelope } : null,
        timeoutCount: state.folderMetadataTimeoutCount,
        lastResultAt: state.lastFolderMetadataResultAt,
        lastResultId: state.lastFolderMetadataResultId,
        lastResultStatus: state.lastFolderMetadataResultStatus,
        lastResultBlockers: state.lastFolderMetadataResultBlockers.slice(),
        storageBridge: {
          requestWrittenBackend: state.lastStudioBroadcastTransport || '',
          nativeReadableBackend: state.lastStudioBroadcastExternalAttempts
            ? 'native-extension-chrome.storage.local-via-external-message'
            : '',
          resultReadBackend: state.lastNativeBroadcastReadSource || (state.transport || ''),
          lastRequestVisibleToNative: state.lastStudioBroadcastExternalOkCount > 0,
          lastNativeResultVisibleToStudio: !!state.lastFolderMetadataResultAt && state.lastFolderMetadataResultStatus !== 'timeout',
          externalNativeRequest: {
            at: state.lastStudioBroadcastExternalAt,
            status: state.lastStudioBroadcastExternalStatus,
            attempts: state.lastStudioBroadcastExternalAttempts,
            okCount: state.lastStudioBroadcastExternalOkCount,
            targetIds: state.lastStudioBroadcastExternalTargetIds.slice(),
            errors: state.lastStudioBroadcastExternalErrors.slice(),
            responses: state.lastStudioBroadcastExternalResponses.map((entry) => ({
              ...entry,
              directRelay: entry.directRelay ? { ...entry.directRelay } : null,
            })),
            directResultCount: state.lastStudioBroadcastExternalResultCount,
            lastDirectRelay: state.lastStudioBroadcastExternalDirectRelay
              ? { ...state.lastStudioBroadcastExternalDirectRelay }
              : null,
          },
        },
      };
    },
  };

  // ── Workspace bridge ───────────────────────────────────────────────────────
  // When Studio Library Workspace mutates a folder binding / snapshot category,
  // it emits 'library-workspace:updated' with reason in detail. We listen for
  // mutation reasons and re-broadcast to native via chrome.storage.
  function bindWorkspaceEvents() {
    const ws = H2O.LibraryWorkspace;
    if (!ws || typeof ws.subscribe !== 'function') return false;
    ws.subscribe((evt) => {
      const reason = String(evt?.reason || '');
      if (['folder-binding-changed', 'category-changed', 'setFolderBinding', 'setSnapshotCategory'].includes(reason)) {
        broadcastFromStudio(reason, evt?.detail || null);
      }
    });
    step('bind.workspace');
    return true;
  }

  // ── Public API ─────────────────────────────────────────────────────────────
  const Sync = {
    surface: 'studio',
    subscribe(fn) {
      if (typeof fn !== 'function') return () => {};
      state.subscribers.add(fn);
      return () => state.subscribers.delete(fn);
    },
    broadcast: broadcastFromStudio,
    folderMetadataOperations: FolderMetadataOperations,
    requestFolderMetadataOperation,
    pingNow(reason) { coalesceEmit(reason || 'manual'); },
    getNativeBroadcast() { return state.lastNativeBroadcastPayload || null; },
    refreshNativeBroadcast,
    requestNativeSnapshotPayloads,
    async refreshNativeSnapshotPayloads(reason) {
      return refreshNativeBroadcast(reason || 'native-snapshot-payload-refresh');
    },
    waitForNativeSnapshotPayloadMaterialization() {
      return state.lastNativeSnapshotPayloadMaterializePromise || Promise.resolve(null);
    },
    refreshNativeFolderState(reason) {
      const why = reason || 'manual-folder-state-refresh';
      try { refreshExternalNativeFolderMergeDiagnostic(why).catch(() => {}); } catch {}
      return refreshNativeBroadcast(why);
    },
    diagnose() {
      if (!state.lastNativeBroadcastAt || (!state.lastNativeFolderMergeAt && !state.lastNativeBroadcastFolderCount)) {
        try { refreshNativeBroadcast('diagnose').catch(() => {}); } catch {}
      }
      if (!state.lastNativeFolderMergeAt) {
        try { refreshExternalNativeFolderMergeDiagnostic('diagnose').catch(() => {}); } catch {}
      }
      const pb = getPlatformBroadcast();
      const env = W.H2O && W.H2O.Studio && W.H2O.Studio.platform && W.H2O.Studio.platform.env;
      return {
        surface: 'studio',
        bound: state.bound,
        transport: state.transport,                 // 'platform.broadcast' | 'chrome.storage.fallback' | null
        platformBroadcastAvailable: !!pb,
        platformAdapter: env ? env.adapter : null,  // 'mv3' | 'fallback' | 'tauri' (future)
        legacyKeyCompat: true,                      // BROADCAST_KEY/NATIVE_BROADCAST_KEY preserved for native interop
        hasChromeStorage: hasChromeStorage(),
        lastSync: state.lastSync,
        watchedPrefixes: WATCHED_PREFIXES,
        ignoredSelfRefreshKeys: Array.from(IGNORED_SELF_REFRESH_KEYS),
        broadcastKey: BROADCAST_KEY,
        nativeBroadcastKey: NATIVE_BROADCAST_KEY,
        coalesceMs: COALESCE_MS,
        projection: {
          watchedPrefixesCount: WATCHED_PREFIXES.length,
          lastChangeKeys: state.lastChangeKeys.slice(),
          lastWatchedHits: state.lastWatchedHits.slice(),
          lastEmittedReasons: state.lastEmittedReasons.slice(),
          lastRefreshOwners: state.lastRefreshOwners.slice(),
          nativeBroadcast: {
            observedAt: state.lastNativeBroadcastAt,
            ts: state.lastNativeBroadcastTs,
            payloadKeys: state.lastNativeBroadcastKeys.slice(),
            reasons: state.lastNativeBroadcastReasons.slice(),
            hasLinkedRecords: state.lastNativeBroadcastHasLinkedRecords,
            linkedRecordsCount: state.lastNativeBroadcastLinkedRecordsCount,
            projectCatalogCount: state.lastNativeBroadcastProjectCatalogCount,
            projectCatalogSource: state.lastNativeBroadcastProjectCatalogSource,
            folderCount: state.lastNativeBroadcastFolderCount,
            folderBindingCount: state.lastNativeBroadcastFolderBindingCount,
            folderSource: state.lastNativeBroadcastFolderSource,
            snapshotPayloadCount: state.lastNativeBroadcastSnapshotPayloadCount,
            changed: state.lastNativeBroadcastChanged,
            signature: state.lastNativeBroadcastSignature,
            signatureBefore: state.lastNativeBroadcastSignatureBefore,
            signatureAfter: state.lastNativeBroadcastSignatureAfter,
            skippedCount: state.lastNativeBroadcastSkippedCount,
            skipReason: state.lastNativeBroadcastSkipReason,
            readAt: state.lastNativeBroadcastReadAt,
            readSource: state.lastNativeBroadcastReadSource,
            readError: state.lastNativeBroadcastReadError,
          },
          nativeSnapshotPayloadMaterialize: {
            at: state.lastNativeSnapshotPayloadMaterializeAt,
            status: state.lastNativeSnapshotPayloadMaterializeStatus,
            materializedCount: state.lastNativeSnapshotPayloadMaterializedCount,
            skippedCount: state.lastNativeSnapshotPayloadSkippedCount,
            error: state.lastNativeSnapshotPayloadError,
            importResult: state.lastNativeSnapshotPayloadImportResult ? { ...state.lastNativeSnapshotPayloadImportResult } : null,
            verifyStatus: state.lastNativeSnapshotPayloadVerifyStatus,
            verifiedCount: state.lastNativeSnapshotPayloadVerifiedCount,
            verifyError: state.lastNativeSnapshotPayloadVerifyError,
            snapshotIdHashes: state.lastNativeSnapshotPayloadIdHashes.slice(),
          },
          nativeSnapshotPayloadRequest: {
            at: state.lastNativeSnapshotPayloadRequestAt,
            count: state.lastNativeSnapshotPayloadRequestCount,
            status: state.lastNativeSnapshotPayloadRequestStatus,
            sent: state.lastNativeSnapshotPayloadRequestSent,
            error: state.lastNativeSnapshotPayloadRequestError,
            snapshotIdHashes: state.lastNativeSnapshotPayloadRequestIdHashes.slice(),
          },
          nativeFolderStateMerge: {
            key: FOLDER_STATE_DATA_KEY,
            diagnosticKey: state.lastNativeFolderMergeDiagnosticKey || EXTERNAL_NATIVE_FOLDER_MERGE_DIAG_KEY,
            path: state.lastNativeFolderMergePath || (state.lastNativeFolderMergeAt ? 'same-extension-broadcast' : ''),
            at: state.lastNativeFolderMergeAt,
            status: state.lastNativeFolderMergeStatus,
            error: state.lastNativeFolderMergeError,
            incomingChecksum: state.lastNativeFolderMergeIncomingChecksum,
            mergedChecksum: state.lastNativeFolderMergeChecksum,
            incomingFolderCount: state.lastNativeFolderMergeIncomingFolderCount,
            incomingBindingCount: state.lastNativeFolderMergeIncomingBindingCount,
            mergedFolderCount: state.lastNativeFolderMergeMergedFolderCount,
            mergedBindingCount: state.lastNativeFolderMergeMergedBindingCount,
            removedNativeFolderCount: state.lastNativeFolderMergeRemovedNativeFolderCount,
            removedNativeFolderIds: state.lastNativeFolderMergeRemovedNativeFolderIds.slice(),
            preservedLocalFolderCount: state.lastNativeFolderMergePreservedLocalFolderCount,
            duplicateNameDifferentIdCount: state.lastNativeFolderMergeDuplicateNameDifferentIdCount,
            duplicateNameDifferentIdSample: state.lastNativeFolderMergeDuplicateNameDifferentIdSample.slice(),
            caseArrived: !!state.lastNativeFolderMergeCaseArrived,
            sourceExtensionId: state.lastNativeFolderMergeSourceExtensionId,
            readAt: state.lastNativeFolderMergeReadAt,
            readSource: state.lastNativeFolderMergeReadSource,
            readError: state.lastNativeFolderMergeReadError,
          },
          studioBroadcast: {
            at: state.lastStudioBroadcastAt,
            reason: state.lastStudioBroadcastReason,
            payloadKeys: state.lastStudioBroadcastPayloadKeys.slice(),
            transport: state.lastStudioBroadcastTransport,
          },
          folderMetadataOperations: FolderMetadataOperations.diagnose(),
        },
        subscribers: state.subscribers.size,
        steps: diag.steps.slice(-15),
        errors: diag.errors.slice(-10),
      };
    },
  };

  H2O.Library.Sync = Sync;
  H2O.Studio = H2O.Studio || {};
  H2O.Studio.sync = H2O.Studio.sync || {};
  H2O.Studio.sync.folderMetadataOperations = FolderMetadataOperations;

  function bootBindings() {
    bindTransport();
    refreshNativeBroadcast('boot').catch(() => {});
    refreshExternalNativeFolderMergeDiagnostic('boot').catch(() => {});
    bindWorkspaceEvents() || W.setTimeout(bindWorkspaceEvents, 350);
  }

  function registerOnCore() {
    const core = H2O.LibraryCore;
    if (!core || typeof core.registerOwner !== 'function') return false;
    try {
      core.registerOwner('library-sync', Sync, { replace: true });
      core.registerService('library-sync', Sync, { replace: true });
      step('register-on-core', 'library-sync');
      return true;
    } catch (e) { err('register-on-core', e); return false; }
  }

  if (!registerOnCore()) W.addEventListener('h2o.ev:prm:cgx:lib:ready:v1', () => registerOnCore(), { once: true });
  bootBindings();

  step('boot', 'studio-library-sync-ready');
})();
