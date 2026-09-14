// ==UserScript==
// @h2o-id             s0f3a.folders.studio
// @name               S0F3a. 🎬 Folders - Studio
// @namespace          H2O.Premium.CGX.folders.studio
// @author             HumamDev
// @version            1.1.0
// @revision           001
// @build              260915-000001
// @description        Studio Folders facade plus the STAB-P0 T02A Library-owned logical Folder command contract. Read/catalog behavior remains surface-neutral; business intent enters H2O.Library.FolderCommands while Sync/Host mechanics stay behind existing adapters.
// @match              https://chatgpt.com/*
// @run-at             document-idle
// @grant              none
// ==/UserScript==

(() => {
  'use strict';

  console.log('H2O DEV LOAD ✅ S0F3a Folders (Studio)', Date.now());

  const W = window;
  const H2O = (W.H2O = W.H2O || {});
  H2O.Library = H2O.Library || {};

  const FOLDER_COMMAND_CONTRACT_ID = 'h2o.library.folder-commands.v1';
  const FOLDER_COMMAND_VERSION = '1.0.0';
  const FOLDER_COMMAND_OWNER = 'L-COCKPIT-LIBRARY';
  const FOLDER_COMMAND_AUTHORITY = 'SINGLE_LOGICAL_FOLDER_BUSINESS_COMMAND_AUTHORITY';

  const diag = { t0: performance.now(), steps: [], errors: [], bufMax: 50, errMax: 15 };
  const step = (s, o = '') => {
    try { diag.steps.push({ t: Math.round(performance.now() - diag.t0), s: String(s), o: String(o) }); if (diag.steps.length > diag.bufMax) diag.steps.splice(0, diag.steps.length - diag.bufMax); } catch {}
  };
  const err = (s, e) => {
    try { diag.errors.push({ t: Math.round(performance.now() - diag.t0), s: String(s), e: String(e?.stack || e) }); if (diag.errors.length > diag.errMax) diag.errors.splice(0, diag.errors.length - diag.errMax); } catch {}
  };

  function getCore() { return H2O.LibraryCore || null; }
  function getWorkspace() { return H2O.LibraryWorkspace || null; }
  function getIndex() { return H2O.LibraryIndex || null; }
  function folderCore() {
    try {
      const core = H2O.Library?.FolderProviderCore || null;
      return core && core.__phase === '3B' ? core : null;
    } catch {
      return null;
    }
  }

  let cachedFolders = null;
  let cachedAt = 0;
  let lastFolderDiagnostics = [];
  let lastWrite = null;
  let lastCommand = null;
  const TTL_MS = 30_000;

  function mergeNormalizedFolder(raw, normalized) {
    const src = raw && typeof raw === 'object' ? raw : {};
    const folder = normalized && typeof normalized === 'object' ? normalized : {};
    const id = String(folder.id || src.id || src.folderId || '').trim();
    const name = String(folder.name || src.name || src.title || id).trim() || id;
    return {
      ...src,
      ...folder,
      id,
      folderId: String(src.folderId || id).trim() || id,
      name,
    };
  }

  function normalizeFolderList(rawList) {
    const list = Array.isArray(rawList) ? rawList : [];
    const core = folderCore();
    lastFolderDiagnostics = [];
    if (!core || typeof core.normalizeFolderCatalog !== 'function') return list.slice();
    try {
      const diagnostics = [];
      const normalized = core.normalizeFolderCatalog(list, { diagnostics });
      lastFolderDiagnostics = diagnostics;
      const firstRawById = new Map();
      for (const row of list) {
        const id = String(row?.id || row?.folderId || '').trim();
        if (id && !firstRawById.has(id)) firstRawById.set(id, row);
      }
      return normalized.map((folder) => mergeNormalizedFolder(firstRawById.get(folder.id), folder));
    } catch (e) {
      err('normalizeFolderList', e);
      return list.slice();
    }
  }

  function normalizeFolderId(folderId) {
    return String(folderId || '').trim();
  }

  function normalizeBindingChatId(chatIdOrHref) {
    const raw = String(chatIdOrHref || '').trim();
    if (!raw) return { ok: false, chatId: '', raw: '', status: 'missing-chat-id' };

    const core = folderCore();
    if (core && typeof core.normalizeBindingKey === 'function') {
      const key = core.normalizeBindingKey(raw);
      const chatId = String(key?.chatId || '').trim();
      if (chatId) return { ok: true, chatId, raw, status: 'ok' };
      return { ok: false, chatId: '', raw, status: 'invalid-chat-id' };
    }

    try {
      const path = /^https?:\/\//i.test(raw) ? new URL(raw).pathname : raw;
      const match = String(path || '').match(/(?:^|\/)c\/([^/?#]+)/);
      if (match) return { ok: true, chatId: decodeURIComponent(match[1]), raw, status: 'ok' };
    } catch {}

    if (!raw.startsWith('/') && !/^https?:\/\//i.test(raw)) {
      return { ok: true, chatId: raw, raw, status: 'ok' };
    }
    return { ok: false, chatId: '', raw, status: 'invalid-chat-id' };
  }

  function validateFolderIdForWrite(folderId) {
    const id = normalizeFolderId(folderId);
    if (!id) return { ok: true, folderId: '', status: 'ok' };
    const core = folderCore();
    if (core && typeof core.validateFolderId === 'function') {
      const res = core.validateFolderId(id);
      if (res?.ok) return { ok: true, folderId: String(res.folderId || id), status: 'ok' };
      return { ok: false, folderId: id, status: String(res?.reason || 'invalid-folder-id') };
    }
    if (/[\u0000-\u001f\u007f<>]/.test(id)) return { ok: false, folderId: id, status: 'invalid-folder-id' };
    return { ok: true, folderId: id, status: 'ok' };
  }

  function recordWrite(payload) {
    lastWrite = { ...(payload || {}), t: Date.now() };
    step('setBinding', `${lastWrite.status || ''}:${lastWrite.chatId || ''}:${lastWrite.folderId || ''}`);
  }

  function recordCommand(command, result) {
    lastCommand = {
      command: String(command || ''),
      status: String(result?.status || result?.reason || ''),
      ok: result?.ok === true,
      at: Date.now(),
    };
    step('folder-command', `${lastCommand.command}:${lastCommand.status}`);
  }

  function emitFoldersChanged(detail) {
    try {
      W.dispatchEvent(new CustomEvent('evt:h2o:folders:changed', {
        detail: { ...(detail || {}), surface: 'studio', t: Date.now() },
      }));
    } catch {}
  }

  function validationResult(status, chatId, folderId) {
    const result = {
      ok: false,
      status: String(status || 'invalid-folder-binding'),
      reason: String(status || 'invalid-folder-binding'),
      chatId: String(chatId || ''),
      folderId: String(folderId || ''),
      folderName: '',
    };
    recordWrite(result);
    return result;
  }

  function isBridgeTransportError(error) {
    const msg = String(error?.stack || error?.message || error || '');
    return /Could not establish connection|Receiving end does not exist|folder bridge|open a ChatGPT tab to access folders/i.test(msg);
  }

  async function listFolders({ fresh = false } = {}) {
    const now = Date.now();
    if (!fresh && cachedFolders && (now - cachedAt) < TTL_MS) return cachedFolders;
    const ws = getWorkspace();
    const list = ws ? await ws.getFolders({ fresh }) : [];
    cachedFolders = normalizeFolderList(list);
    cachedAt = now;
    return cachedFolders;
  }

  async function getFolderById(folderId) {
    const id = normalizeFolderId(folderId);
    if (!id) return null;
    const list = await listFolders();
    const core = folderCore();
    if (core && typeof core.getFolderById === 'function') {
      const normalized = core.getFolderById({ folders: list, items: {} }, id);
      if (normalized) {
        return list.find((f) => String(f.id || f.folderId || '') === String(normalized.id || id)) || normalized;
      }
      return null;
    }
    return list.find((f) => String(f.id || f.folderId || '') === id) || null;
  }

  async function getChatsInFolder(folderId) {
    const idx = getIndex();
    if (!idx) return [];
    return idx.query({ folderId: normalizeFolderId(folderId) });
  }

  // Existing surface binding adapter. It owns no Folder business semantics;
  // the T02A command contract invokes it when binding intent needs the current
  // MV3/Tauri workspace bridge and its compatibility behavior.
  async function setBindingViaWorkspace(chatId, folderId, opts = {}) {
    const normalizedChat = normalizeBindingChatId(chatId);
    const normalizedFolder = validateFolderIdForWrite(folderId);

    if (!normalizedChat.ok) {
      return validationResult(normalizedChat.status, normalizedChat.chatId, normalizedFolder.folderId);
    }
    if (!normalizedFolder.ok) {
      return validationResult(normalizedFolder.status, normalizedChat.chatId, normalizedFolder.folderId);
    }

    const ws = getWorkspace();
    if (!ws || typeof ws.setFolderBinding !== 'function') {
      const result = {
        ok: false,
        status: 'folder-bridge-unavailable',
        reason: 'library-workspace unavailable',
        chatId: normalizedChat.chatId,
        folderId: normalizedFolder.folderId,
        folderName: '',
      };
      recordWrite(result);
      return result;
    }

    try {
      const result = await ws.setFolderBinding(normalizedChat.chatId, normalizedFolder.folderId, opts || {});
      if (result?.ok === false) {
        recordWrite({
          ok: false,
          status: String(result.status || result.reason || 'rejected'),
          chatId: normalizedChat.chatId,
          folderId: String(result.folderId || ''),
          folderName: String(result.folderName || ''),
          result,
        });
        return result;
      }
      cachedFolders = null;
      cachedAt = 0;
      try { await listFolders({ fresh: true }); } catch (e) { err('setBinding.refreshFolders', e); }
      try { await getIndex()?.refresh?.('folder-binding-changed'); } catch (e) { err('setBinding.refreshIndex', e); }
      recordWrite({
        ok: result?.ok !== false,
        status: String(result?.status || 'ok'),
        chatId: normalizedChat.chatId,
        folderId: String(result?.folderId || normalizedFolder.folderId || ''),
        folderName: String(result?.folderName || ''),
        result,
      });
      emitFoldersChanged({
        action: normalizedFolder.folderId ? 'set-binding' : 'clear-binding',
        source: String(opts?.source || 'studio-folders-api'),
        chatId: normalizedChat.chatId,
        folderId: String(result?.folderId || normalizedFolder.folderId || ''),
        folderName: String(result?.folderName || ''),
      });
      return result;
    } catch (e) {
      if (isBridgeTransportError(e)) {
        const result = {
          ok: false,
          status: 'folder-bridge-unavailable',
          reason: String(e?.message || e || 'folder bridge unavailable'),
          chatId: normalizedChat.chatId,
          folderId: '',
          folderName: '',
        };
        recordWrite({ ...result, error: String(e?.stack || e) });
        err('setBinding.bridge', e);
        return result;
      }
      recordWrite({
        ok: false,
        status: 'folder-write-failed',
        reason: String(e?.message || e || 'folder-write-failed'),
        chatId: normalizedChat.chatId,
        folderId: normalizedFolder.folderId,
        error: String(e?.stack || e),
      });
      err('setBinding', e);
      return {
        ok: false,
        status: 'folder-write-failed',
        reason: String(e?.message || e || 'folder-write-failed'),
        chatId: normalizedChat.chatId,
        folderId: normalizedFolder.folderId,
        folderName: '',
      };
    }
  }

  function folderActionAdapter() {
    try {
      const actions = H2O.Studio?.actions?.folders || null;
      return actions && typeof actions === 'object' ? actions : null;
    } catch {
      return null;
    }
  }

  function commandResult(command, status, extra = {}) {
    return {
      ok: extra.ok === true,
      contract: FOLDER_COMMAND_CONTRACT_ID,
      contractVersion: FOLDER_COMMAND_VERSION,
      owner: FOLDER_COMMAND_OWNER,
      authority: FOLDER_COMMAND_AUTHORITY,
      command: String(command || ''),
      status: String(status || ''),
      ...extra,
    };
  }

  function normalizeAdapterResult(command, result) {
    const src = result && typeof result === 'object' ? result : {};
    const out = commandResult(command, String(src.status || (src.ok ? 'ok' : 'adapter-result')), {
      ...src,
      ok: src.ok === true,
      adapterResult: src,
    });
    recordCommand(command, out);
    return out;
  }

  async function invokeFolderAction(command, methods, args = []) {
    const adapter = folderActionAdapter();
    const candidates = Array.isArray(methods) ? methods : [methods];
    const method = candidates.find((name) => typeof adapter?.[name] === 'function') || '';
    if (!method) {
      const out = commandResult(command, 'surface-adapter-unavailable', {
        ok: false,
        reason: `No current Folder surface adapter implements ${command}`,
        adapterRole: 'SURFACE_ADAPTER_NOT_BUSINESS_AUTHORITY',
      });
      recordCommand(command, out);
      return out;
    }
    try {
      return normalizeAdapterResult(command, await adapter[method](...args));
    } catch (e) {
      err(`folder-command:${command}`, e);
      const out = commandResult(command, 'surface-adapter-threw', {
        ok: false,
        reason: String(e?.message || e || 'surface adapter failed'),
        adapterMethod: method,
      });
      recordCommand(command, out);
      return out;
    }
  }

  function boundaryOwnedMaintenance(command, owner, reason) {
    const out = commandResult(command, 'boundary-owned', {
      ok: false,
      boundaryOwner: owner,
      reason,
      noBusinessAuthorityTransfer: true,
    });
    recordCommand(command, out);
    return out;
  }

  async function executeFolderMaintenance(input = {}) {
    const intent = String(input.intent || input.operation || '').trim().toLowerCase();
    if (intent === 'delete-empty-folder') {
      return executeFolderCommand('delete', { folderId: input.folderId || input.id });
    }
    if (intent === 'restore-folder') {
      return executeFolderCommand('restore', input);
    }
    if (intent === 'unbind-orphan-chat' || intent === 'remove-orphan-binding') {
      return executeFolderCommand('unbind', { chatId: input.chatId, options: input.options });
    }
    if (['mirror-refresh', 'mirror-reconcile', 'cross-surface-reconcile', 'cross-surface-converge'].includes(intent)) {
      return boundaryOwnedMaintenance(
        `maintenance:${intent}`,
        'L-PLATFORM-SYNC',
        'Propagation, mirror reconciliation, conflict handling, and convergence remain Platform Sync owned.'
      );
    }
    if (['mv3-adapter', 'tauri-adapter', 'native-owner-bridge', 'environment-adapter'].includes(intent)) {
      return boundaryOwnedMaintenance(
        `maintenance:${intent}`,
        'L-STUDIO-HOST-INTEGRATION',
        'MV3/Tauri/native-owner/environment adaptation remains Host Integration owned.'
      );
    }
    if (intent === 'saved-chat-durability') {
      return boundaryOwnedMaintenance(
        `maintenance:${intent}`,
        'L-STORAGE-SAVED-CHATS',
        'Saved Chats Storage is not activated for STAB-P0 under current evidence.'
      );
    }
    if (intent === 'runtime-admission') {
      return boundaryOwnedMaintenance(
        `maintenance:${intent}`,
        'L-RUNTIME-KERNEL-SCOPE-STU',
        'Studio Runtime is not activated for STAB-P0 under current evidence.'
      );
    }
    const out = commandResult(`maintenance:${intent || 'unknown'}`, 'unsupported-maintenance-intent', {
      ok: false,
      reason: 'Maintenance intent is not a Library-owned Folder business command in the T02A contract.',
    });
    recordCommand(out.command, out);
    return out;
  }

  async function executeFolderCommand(command, input = {}) {
    const normalized = String(command || '').trim().toLowerCase();
    const payload = input && typeof input === 'object' ? input : {};

    if (normalized === 'create') {
      return invokeFolderAction('create', 'create', [payload]);
    }
    if (normalized === 'rename') {
      return invokeFolderAction('rename', 'rename', [
        normalizeFolderId(payload.folderId || payload.id),
        String(payload.name || payload.newName || '').trim(),
      ]);
    }
    if (normalized === 'update') {
      const patch = payload.patch && typeof payload.patch === 'object' ? payload.patch : payload;
      return invokeFolderAction('update', 'update', [normalizeFolderId(payload.folderId || payload.id), patch]);
    }
    if (normalized === 'color' || normalized === 'set-color') {
      const color = String(payload.color || payload.iconColor || '').trim();
      return invokeFolderAction('color', 'update', [
        normalizeFolderId(payload.folderId || payload.id),
        { color, iconColor: color },
      ]);
    }
    if (normalized === 'delete' || normalized === 'remove') {
      const folderId = normalizeFolderId(payload.folderId || payload.id);
      const adapter = folderActionAdapter();
      if (typeof adapter?.remove === 'function' || typeof adapter?.delete === 'function') {
        return invokeFolderAction('delete', ['remove', 'delete'], [folderId]);
      }
      // Chrome's current safe delete effect is request-only. Treat it as a
      // surface adapter for the same business intent without granting Chrome
      // permanent-delete authority.
      if (typeof adapter?.requestDelete === 'function') {
        return invokeFolderAction('delete', 'requestDelete', [{ ...payload, folderId }]);
      }
      return invokeFolderAction('delete', ['remove', 'delete'], [folderId]);
    }
    if (normalized === 'restore') {
      const target = payload.tombstoneId || payload.folderId || payload.id || payload.target || '';
      return invokeFolderAction('restore', ['restore', 'restoreTombstonedFolder'], [target]);
    }
    if (normalized === 'bind') {
      const chat = normalizeBindingChatId(payload.chatId || payload.chatIdOrHref || '');
      const folder = validateFolderIdForWrite(payload.folderId || payload.id || '');
      if (!chat.ok) return validationResult(chat.status, chat.chatId, folder.folderId);
      if (!folder.ok || !folder.folderId) return validationResult(folder.ok ? 'folder-id-required' : folder.status, chat.chatId, folder.folderId);
      const out = await setBindingViaWorkspace(chat.chatId, folder.folderId, payload.options || {});
      const result = normalizeAdapterResult('bind', out);
      result.chatId = chat.chatId;
      result.folderId = String(out?.folderId || folder.folderId || '');
      return result;
    }
    if (normalized === 'unbind') {
      const chat = normalizeBindingChatId(payload.chatId || payload.chatIdOrHref || '');
      if (!chat.ok) return validationResult(chat.status, chat.chatId, '');
      const out = await setBindingViaWorkspace(chat.chatId, '', payload.options || {});
      const result = normalizeAdapterResult('unbind', out);
      result.chatId = chat.chatId;
      result.folderId = '';
      return result;
    }
    if (normalized === 'maintenance' || normalized === 'cleanup') {
      return executeFolderMaintenance(payload);
    }

    const out = commandResult(normalized || 'unknown', 'unsupported-folder-command', {
      ok: false,
      reason: 'Unknown Folder business command.',
    });
    recordCommand(out.command, out);
    return out;
  }

  const FolderCommands = Object.freeze({
    contract: FOLDER_COMMAND_CONTRACT_ID,
    version: FOLDER_COMMAND_VERSION,
    owner: FOLDER_COMMAND_OWNER,
    authority: FOLDER_COMMAND_AUTHORITY,
    invariants: Object.freeze([
      'ONE_LOGICAL_FOLDER_BUSINESS_COMMAND_AUTHORITY',
      'SINGLE_FOLDER_PER_CHAT_BINDING',
      'SHELL_STRUCTURAL_HOST_NOT_OWNED',
      'SYNC_CONVERGENCE_NOT_OWNED',
      'HOST_ENVIRONMENT_ADAPTER_NOT_OWNED',
      'SAVED_CHATS_STORAGE_NOT_ACTIVATED',
      'STUDIO_RUNTIME_NOT_ACTIVATED',
    ]),
    execute: executeFolderCommand,
    create: (input = {}) => executeFolderCommand('create', input),
    rename: (input = {}) => executeFolderCommand('rename', input),
    update: (input = {}) => executeFolderCommand('update', input),
    setColor: (input = {}) => executeFolderCommand('color', input),
    delete: (input = {}) => executeFolderCommand('delete', input),
    remove: (input = {}) => executeFolderCommand('delete', input),
    restore: (input = {}) => executeFolderCommand('restore', input),
    bind: (input = {}) => executeFolderCommand('bind', input),
    unbind: (input = {}) => executeFolderCommand('unbind', input),
    cleanup: (input = {}) => executeFolderCommand('cleanup', input),
    maintenance: (input = {}) => executeFolderCommand('maintenance', input),
    diagnose() {
      const adapter = folderActionAdapter();
      return {
        contract: FOLDER_COMMAND_CONTRACT_ID,
        version: FOLDER_COMMAND_VERSION,
        owner: FOLDER_COMMAND_OWNER,
        authority: FOLDER_COMMAND_AUTHORITY,
        surface: 'studio',
        adapterRole: 'SURFACE_ADAPTER_NOT_BUSINESS_AUTHORITY',
        adapterAvailable: !!adapter,
        adapterMethods: adapter ? Object.keys(adapter).filter((key) => typeof adapter[key] === 'function').sort() : [],
        workspaceBindingAdapterAvailable: typeof getWorkspace()?.setFolderBinding === 'function',
        lastCommand,
        boundaries: {
          shell: 'L-STUDIO-APPLICATION-SHELL',
          sync: 'L-PLATFORM-SYNC',
          hostIntegration: 'L-STUDIO-HOST-INTEGRATION',
          savedChatsStorage: 'NOT_ACTIVATED',
          studioRuntime: 'NOT_ACTIVATED',
        },
      };
    },
  });

  // Canonical T02A business-intent entry authority. Existing lower-level
  // H2O.Studio.actions.folders remains a surface/persistence adapter only and
  // is intentionally not absorbed or re-owned by this contract.
  H2O.Library.FolderCommands = FolderCommands;

  // Compatibility facade: existing H2O.folders.setBinding callers now enter
  // the logical command authority before reaching the Workspace/host adapter.
  async function setBinding(chatId, folderId, opts = {}) {
    const folder = normalizeFolderId(folderId);
    return folder
      ? FolderCommands.bind({ chatId, folderId: folder, options: opts })
      : FolderCommands.unbind({ chatId, options: opts });
  }

  function buildRouteHash(folderId) {
    return getCore()?.getService?.('route')?.buildLibraryHash?.('folder', folderId) || '';
  }

  function getFolderParityDiagnostics() {
    const byFolder = getIndex()?.facets?.().byFolder || {};
    const folders = Array.isArray(cachedFolders) ? cachedFolders : [];
    const folderSummaries = folders.map((folder) => {
      const id = String(folder?.id || folder?.folderId || '').trim();
      const chatIds = Array.isArray(byFolder[id]) ? byFolder[id].map((value) => String(value || '').trim()).filter(Boolean) : [];
      return {
        id,
        folderId: id,
        name: String(folder?.name || folder?.label || folder?.title || id).trim() || id,
        kind: String(folder?.kind || 'local').trim() || 'local',
        source: String(folder?.source || (cachedFolders ? 'workspace-cache' : '') || ''),
        color: String(folder?.color || folder?.iconColor || '').trim(),
        iconColor: String(folder?.iconColor || folder?.color || '').trim(),
        icon: String(folder?.icon || '').trim(),
        bindingCount: chatIds.length,
        empty: chatIds.length === 0,
        chatIds,
      };
    });
    const uncatalogedFolderIds = Object.keys(byFolder || {}).filter((folderId) => (
      folderId && !folderSummaries.some((folder) => folder.id === folderId)
    ));
    const bindingCount = Object.values(byFolder || {}).reduce((sum, ids) => sum + (Array.isArray(ids) ? ids.length : 0), 0);
    return {
      phase: 'folder-parity-diagnostic',
      surface: 'studio',
      source: cachedFolders ? 'H2O.LibraryWorkspace.getFolders cached catalog + LibraryIndex facets' : 'LibraryIndex facets only until folder catalog is loaded',
      catalogCached: !!cachedFolders,
      catalogCount: folderSummaries.length,
      bindingCount,
      emptyFolderCount: folderSummaries.filter((folder) => folder.empty).length,
      boundFolderCount: folderSummaries.filter((folder) => !folder.empty).length,
      indexFacetCount: Object.keys(byFolder || {}).length,
      uncatalogedFolderIds,
      folderNames: folderSummaries.map((folder) => folder.name),
      folderIds: folderSummaries.map((folder) => folder.id),
      colorsModeled: folderSummaries.some((folder) => !!(folder.color || folder.iconColor)),
      iconsModeled: folderSummaries.some((folder) => !!folder.icon),
      emptyFoldersRepresented: folderSummaries.some((folder) => folder.empty),
      folders: folderSummaries,
    };
  }

  const Folders = {
    surface: 'studio',
    listFolders,
    getFolderById,
    getChatsInFolder,
    setBinding,
    buildRouteHash,
    async refresh() { return listFolders({ fresh: true }); },
    diagnose() {
      const byFolder = getIndex()?.facets?.().byFolder || {};
      return {
        surface: 'studio',
        cached: !!cachedFolders,
        cachedCount: cachedFolders ? cachedFolders.length : 0,
        cachedAt,
        cacheAgeMs: cachedAt ? Math.max(0, Date.now() - cachedAt) : null,
        hasWorkspace: !!getWorkspace(),
        hasIndex: !!getIndex(),
        hasFolderCore: !!folderCore(),
        folderCorePhase: folderCore()?.__phase || '',
        folderCommandContract: FolderCommands.diagnose(),
        projection: {
          catalogSource: 'LibraryWorkspace.getFolders(chat-list bridge)',
          cachedCount: cachedFolders ? cachedFolders.length : 0,
          indexFacetCount: Object.keys(byFolder || {}).length,
          bridgeAvailable: typeof getWorkspace()?.getFolders === 'function',
          lastWriteStatus: lastWrite ? String(lastWrite.status || '') : '',
        },
        folderParity: getFolderParityDiagnostics(),
        normalizationDiagnostics: lastFolderDiagnostics.slice(-10),
        lastWrite,
        steps: diag.steps.slice(-10),
        errors: diag.errors.slice(-5),
      };
    },
  };

  // Expose to match the native H2O.folders namespace shape.
  H2O.folders = H2O.folders || Folders;
  // Always expose the Studio facade under H2O.Library.Folders so studio.js + Library modules can find it cleanly.
  H2O.Library.Folders = Folders;

  function registerOnCore() {
    const core = getCore();
    if (!core || typeof core.registerOwner !== 'function') return false;
    try {
      core.registerOwner('folders', Folders, { replace: true });
      core.registerService('folders', Folders, { replace: true });
      core.registerOwner('folder-commands', FolderCommands, { replace: true });
      core.registerService('folder-commands', FolderCommands, { replace: true });
      // Register Studio folder route handler
      core.registerRoute('folder', async (route) => {
        const id = String(route?.id || '').trim();
        step('route:folder', id);
        return true;
      }, { replace: true });
      core.registerRoute('folders', async () => { step('route:folders'); return true; }, { replace: true });
      step('register-on-core', 'folders+folder-commands');
      return true;
    } catch (e) { err('register-on-core', e); return false; }
  }

  if (!registerOnCore()) {
    W.addEventListener('h2o.ev:prm:cgx:lib:ready:v1', () => registerOnCore(), { once: true });
  }

  step('boot', 'studio-folders-ready');
})();
