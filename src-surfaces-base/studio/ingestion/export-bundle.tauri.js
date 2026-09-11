/* H2O Studio Export - Full Bundle Exporter (Desktop / Tauri)
 *
 * Desktop-only exporter for moving SQLite-backed Studio Library data into a
 * Chrome-compatible "h2o.studio.fullBundle.v2" file. It reads through public
 * H2O.Studio.store adapters only. It never writes SQLite, chrome.storage, or
 * archive data.
 *
 * Chrome already imports this full-bundle shape through the existing
 * #/migrate/import flow; this file intentionally does not change Chrome import
 * logic or the archive IndexedDB schema.
 */
(function (global) {
  'use strict';

  function detectTauri() {
    try {
      if (typeof global.__TAURI_INTERNALS__ !== 'undefined') return true;
      if (typeof global.__TAURI__ !== 'undefined') return true;
    } catch (_) { /* swallow */ }
    return false;
  }
  if (!detectTauri()) return;

  var H2O = global.H2O = global.H2O || {};
  H2O.Studio = H2O.Studio || {};
  H2O.Studio.ingestion = H2O.Studio.ingestion || {};

  var FULL_BUNDLE_SCHEMA = 'h2o.studio.fullBundle.v2';
  var CHAT_ARCHIVE_SCHEMA = 'h2o.chatArchive.bundle.v1';
  var FOLDER_STATE_KEY = 'h2o:prm:cgx:fldrs:state:data:v1';
  var LABEL_BINDINGS_KEY = 'h2o:prm:cgx:library:labels:bindings:v1';
  var DEFAULT_KEEP_LATEST = 30;
  var EXPORTER_VERSION = '0.2.0-f3';
  /* F3: opt-in identity-aware envelope stamping. Bundle schema stays
   * 'h2o.studio.fullBundle.v2'; this string marks the stamping convention. */
  var EXPORT_SCHEMA_VERSION = 'h2o.studio.export-envelope.v1';
  var PEER_TRANSPORT_VERSION = 'h2o.studio.sync.peer-transport.v1';
  var PEER_STATE_SCHEMA = 'h2o.studio.sync.peer-state.v1';
  var TOMBSTONE_SCHEMA_VERSION = 'h2o.studio.tombstone.v1';
  var TOMBSTONE_EXPORT_LIMIT = 5000;
  var FOLDER_DELETE_RECEIPT_SCHEMA = 'h2o.studio.folder-delete-receipt.v1';
  var FOLDER_DELETE_RECEIPT_LIMIT = 1000;
  var FOLDER_RESTORE_RECEIPT_SCHEMA = 'h2o.studio.folder-restore-receipt.v1';
  var FOLDER_RESTORE_RECEIPT_LIMIT = 1000;
  var CHAT_FOLDER_BINDING_RECEIPT_SCHEMA = 'h2o.studio.chat-folder-binding-receipt.v1';
  var CHAT_FOLDER_BINDING_RECEIPT_LIMIT = 1000;
  var LIBRARY_METADATA_MUTATION_RECEIPT_SCHEMA = 'h2o.studio.library-metadata-mutation-receipt.v1';
  var LIBRARY_METADATA_MUTATION_RECEIPT_LIMIT = 1000;
  var LIBRARY_METADATA_MUTATION_RECEIPT_EXPORT_KEY = 'h2o:studio:library-metadata-mutation-receipts:export:v1';
  var LIBRARY_METADATA_MUTATION_RECEIPT_EXPORT_MIRROR_SCHEMA = 'h2o.studio.library-metadata-mutation-receipt.export-mirror.v1';
  var DESKTOP_CANONICAL_RECENTLY_DELETED_SCHEMA = 'h2o.studio.folder-recently-deleted.desktop-canonical.v1';
  var DESKTOP_PURGED_FOLDER_SUPPRESSION_SCHEMA = 'h2o.studio.folder-purge-suppression.desktop.v1';
  var DESKTOP_CANONICAL_CHAT_FOLDER_BINDING_SCHEMA = 'h2o.studio.chat-folder-bindings.desktop-canonical.v1';
  var DESKTOP_CANONICAL_LIBRARY_METADATA_SCHEMA = 'h2o.studio.library-metadata.desktop-canonical.v1';
  var DB_URL = 'sqlite:studio-v1.db';
  var APPLY_EVENTS_SCHEMA_VERSION = 'h2o.studio.sync.apply-events.v0';
  var APPLY_EVENT_SCHEMA_VERSION = 'h2o.studio.sync.apply-event.v0';
  var APPLY_EVENT_OPERATION = 'folder-metadata-color-apply';
  var APPLY_EVENT_POLICY_VERSION = 'h2o.studio.sync.folder-metadata-apply.v0';
  var APPLY_EVENT_LIMIT = 50;
  var SYNC_FOLDER_NAME = 'H2O Studio Sync';
  var SYNC_LATEST_FILE = 'latest.json';
  var SYNC_TMP_FILE = '.latest.json.tmp';

  var state = {
    installedAt: Date.now(),
    lastExportAt: null,
    lastSyncExport: null,
    lastSummary: null,
    lastFolderParity: null,
    lastWarnings: [],
    lastError: null,
  };

  function nowIso() {
    try { return new Date().toISOString(); }
    catch (_) { return String(Date.now()); }
  }

  function asArray(value) {
    return Array.isArray(value) ? value : [];
  }

  function safeObject(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  }

  function cleanString(value) {
    return String(value == null ? '' : value).trim();
  }

  function joinSyncPath(name) {
    return SYNC_FOLDER_NAME + '/' + String(name || '').replace(/^\/+/, '');
  }

  function syncDisplayPath(name) {
    return '~/' + joinSyncPath(name);
  }

  function getTauriInvoke() {
    try {
      var internals = global.__TAURI_INTERNALS__;
      if (internals && typeof internals.invoke === 'function') return internals.invoke.bind(internals);
    } catch (_) { /* ignore */ }
    try {
      var tauri = global.__TAURI__;
      if (tauri && tauri.core && typeof tauri.core.invoke === 'function') return tauri.core.invoke.bind(tauri.core);
      if (tauri && typeof tauri.invoke === 'function') return tauri.invoke.bind(tauri);
    } catch (_) { /* ignore */ }
    return null;
  }

  function getHomeBaseDir() {
    return 21;
  }

  function getTauriFsFacade() {
    try {
      var tauri = global.__TAURI__;
      if (tauri && tauri.fs) return tauri.fs;
    } catch (_) { /* ignore */ }
    return null;
  }

  async function fsMkdir(path, options) {
    var fs = getTauriFsFacade();
    if (fs && typeof fs.mkdir === 'function') return fs.mkdir(path, options);
    var invoke = getTauriInvoke();
    if (!invoke) throw new Error('tauri invoke unavailable for fs mkdir');
    return invoke('plugin:fs|mkdir', { path: path, options: options });
  }

  async function fsWriteTextFile(path, text, options) {
    var fs = getTauriFsFacade();
    if (fs && typeof fs.writeTextFile === 'function') return fs.writeTextFile(path, text, options);
    var invoke = getTauriInvoke();
    if (!invoke) throw new Error('tauri invoke unavailable for fs write_text_file');
    var bytes = new TextEncoder().encode(String(text || ''));
    return invoke('plugin:fs|write_text_file', bytes, {
      headers: {
        path: encodeURIComponent(path),
        options: JSON.stringify(options || {}),
      },
    });
  }

  async function fsRename(oldPath, newPath, options) {
    var fs = getTauriFsFacade();
    if (fs && typeof fs.rename === 'function') return fs.rename(oldPath, newPath, options);
    var invoke = getTauriInvoke();
    if (!invoke) throw new Error('tauri invoke unavailable for fs rename');
    return invoke('plugin:fs|rename', {
      oldPath: oldPath,
      newPath: newPath,
      options: options,
    });
  }

  async function sha256Hex(text) {
    try {
      if (!global.crypto || !global.crypto.subtle || typeof TextEncoder === 'undefined') return '';
      var bytes = new TextEncoder().encode(String(text || ''));
      var digest = await global.crypto.subtle.digest('SHA-256', bytes);
      return Array.prototype.map.call(new Uint8Array(digest), function (byte) {
        return byte.toString(16).padStart(2, '0');
      }).join('');
    } catch (_) {
      return '';
    }
  }

  function stableProjectionStringify(value) {
    if (Array.isArray(value)) return '[' + value.map(stableProjectionStringify).join(',') + ']';
    if (value && typeof value === 'object') {
      return '{' + Object.keys(value).sort().map(function (key) {
        return JSON.stringify(key) + ':' + stableProjectionStringify(value[key]);
      }).join(',') + '}';
    }
    return JSON.stringify(value);
  }

  async function projectionSha256(value) {
    var hex = await sha256Hex(stableProjectionStringify(value));
    return hex ? ('sha256:' + hex) : '';
  }

  function sqlSelect(query, values) {
    var invoke = getTauriInvoke();
    if (!invoke) return Promise.reject(new Error('tauri invoke unavailable'));
    return invoke('plugin:sql|select', { db: DB_URL, query: query, values: values || [] });
  }

  function byteLengthOf(text) {
    try {
      if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(String(text || '')).byteLength;
    } catch (_) { /* ignore */ }
    return String(text || '').length;
  }

  /* F3: read F2 peer identity defensively. Returns null if the identity
   * module is unavailable or its whenReady() fails. Never throws. */
  async function readIdentitySafely() {
    try {
      var api = H2O && H2O.Studio && H2O.Studio.identity;
      if (api && typeof api.whenReady === 'function') {
        var id = await api.whenReady();
        if (id && typeof id === 'object') return id;
      }
    } catch (_) { /* swallow */ }
    return null;
  }

  /* F3: ask the producer-side export log to mint a new export event.
   * Returns { exportId, sequenceNumber, previousExportId, exportedAt } on
   * success or null if the log module is unavailable / fails. Caller
   * stamps the bundle on success and falls back to pre-F3 envelope on null. */
  async function recordExportEventSafely(syncPeerId, outboundPath) {
    try {
      var api = H2O && H2O.Studio && H2O.Studio.exportLog;
      if (api && typeof api.recordExport === 'function') {
        var event = await api.recordExport({
          syncPeerId: cleanString(syncPeerId),
          outboundPath: cleanString(outboundPath)
        });
        if (event && typeof event === 'object') return event;
      }
    } catch (_) { /* swallow */ }
    return null;
  }

  function uniqStrings(values) {
    var out = [];
    var seen = Object.create(null);
    asArray(values).forEach(function (item) {
      var value = cleanString(item && typeof item === 'object' ? (item.id || item.labelId || item.tagId || item.categoryId || item.name) : item);
      if (!value || seen[value]) return;
      seen[value] = true;
      out.push(value);
    });
    return out;
  }

  function numberOrZero(value) {
    var n = Number(value);
    return Number.isFinite(n) ? n : 0;
  }

  function epochToIso(value) {
    if (typeof value === 'string' && value.trim()) {
      var parsed = Date.parse(value);
      if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
      return value.trim();
    }
    var n = numberOrZero(value);
    if (n > 0) {
      try { return new Date(n).toISOString(); }
      catch (_) { return ''; }
    }
    return '';
  }

  function getStores() {
    return (H2O.Studio && H2O.Studio.store) || {};
  }

  async function listFromStore(store, opts) {
    if (!store) return [];
    try {
      if (typeof store.list === 'function') {
        var rows = await store.list(opts || {});
        return asArray(rows);
      }
      if (typeof store.getAll === 'function') {
        var all = await store.getAll();
        return asArray(all);
      }
    } catch (_) { /* caller records availability separately */ }
    return [];
  }

  async function listForChat(store, chatId) {
    if (!store || typeof store.listForChat !== 'function') return [];
    try { return asArray(await store.listForChat(chatId)); }
    catch (_) { return []; }
  }

  async function getStoreRow(store, id) {
    if (!store || typeof store.get !== 'function' || !id) return null;
    try { return await store.get(id); }
    catch (_) { return null; }
  }

  function makeLabelAssignments(labels) {
    var assignments = {
      workflowStatusLabelId: '',
      priorityLabelId: '',
      actionLabelIds: [],
      contextLabelIds: [],
      customLabelIds: [],
    };
    asArray(labels).forEach(function (label) {
      var id = cleanString(label && (label.labelId || label.id));
      if (!id) return;
      var meta = safeObject(label && label.meta);
      var type = cleanString((label && label.type) || meta.type || 'custom');
      if (type === 'workflow_status' && !assignments.workflowStatusLabelId) assignments.workflowStatusLabelId = id;
      else if (type === 'priority' && !assignments.priorityLabelId) assignments.priorityLabelId = id;
      else if (type === 'action') assignments.actionLabelIds.push(id);
      else if (type === 'context') assignments.contextLabelIds.push(id);
      else assignments.customLabelIds.push(id);
    });
    assignments.actionLabelIds = uniqStrings(assignments.actionLabelIds);
    assignments.contextLabelIds = uniqStrings(assignments.contextLabelIds);
    assignments.customLabelIds = uniqStrings(assignments.customLabelIds);
    return assignments;
  }

  function projectCategoryCatalog(row) {
    var id = cleanString(row && (row.categoryId || row.id));
    if (!id) return null;
    var meta = safeObject(row && row.meta);
    return {
      id: id,
      name: cleanString((row && row.name) || meta.name || id) || id,
      description: cleanString(meta.description || ''),
      color: cleanString(meta.color || ''),
      sortOrder: Math.floor(numberOrZero(meta.sortOrder)),
      createdAt: epochToIso((row && row.createdAt) || meta.createdAt) || nowIso(),
      updatedAt: epochToIso((row && row.updatedAt) || meta.updatedAt) || '',
      status: cleanString(meta.status || 'active') || 'active',
      replacementCategoryId: meta.replacementCategoryId || null,
      aliases: uniqStrings(meta.aliases),
    };
  }

  function projectLabelCatalog(row) {
    var id = cleanString(row && (row.labelId || row.id));
    if (!id) return null;
    var meta = safeObject(row && row.meta);
    return {
      id: id,
      name: cleanString((row && row.name) || meta.name || id) || id,
      type: cleanString((row && row.type) || meta.type || 'custom') || 'custom',
      color: cleanString((row && row.color) || meta.color || ''),
      sortOrder: Math.floor(numberOrZero(meta.sortOrder)),
      createdAt: epochToIso((row && row.createdAt) || meta.createdAt) || nowIso(),
    };
  }

  function projectFolder(row) {
    var id = cleanString(row && (row.folderId || row.id));
    if (!id) return null;
    var meta = safeObject(row && row.meta);
    var color = cleanString((row && (row.iconColor || row.color)) || meta.iconColor || meta.color || '');
    var icon = cleanString((row && row.icon) || meta.icon || meta.iconKey || '');
    var out = {
      id: id,
      name: cleanString((row && row.name) || meta.name || id) || id,
      kind: cleanString((row && row.kind) || meta.kind || 'local') || 'local',
      parentId: cleanString((row && row.parentId) || meta.parentId || ''),
      source: cleanString((row && row.source) || meta.source || 'desktop-sqlite') || 'desktop-sqlite',
      sortOrder: Math.floor(numberOrZero((row && row.sortOrder) || meta.sortOrder)),
      createdAt: epochToIso((row && row.createdAt) || meta.createdAt) || '',
      updatedAt: epochToIso((row && row.updatedAt) || meta.updatedAt) || '',
      meta: meta,
    };
    if (color) {
      out.color = color;
      out.iconColor = color;
    }
    if (icon) out.icon = icon;
    return out;
  }

  function normalizeFolderItems(rawItems) {
    var out = Object.create(null);
    var src = rawItems && typeof rawItems === 'object' && !Array.isArray(rawItems) ? rawItems : {};
    Object.keys(src).forEach(function (folderIdRaw) {
      var folderId = cleanString(folderIdRaw);
      if (!folderId) return;
      out[folderId] = uniqStrings(asArray(src[folderId]));
    });
    return out;
  }

  function normalizeFolderState(raw, fallbackSource) {
    var src = safeObject(raw);
    var source = cleanString(src.exportedFrom || src.source || fallbackSource || 'folder-state-cache') || 'folder-state-cache';
    var seen = Object.create(null);
    var folders = [];
    asArray(src.folders).forEach(function (row) {
      var projected = projectFolder(Object.assign({}, safeObject(row), {
        source: cleanString(row && row.source) || source,
      }));
      if (!projected || seen[projected.id]) return;
      seen[projected.id] = true;
      folders.push(projected);
    });
    var items = normalizeFolderItems(src.items);
    folders.forEach(function (folder) {
      var id = cleanString(folder && folder.id);
      if (id && !Object.prototype.hasOwnProperty.call(items, id)) items[id] = [];
    });
    return {
      schemaVersion: Number(src.schemaVersion || src.version || 1) || 1,
      exportedFrom: source,
      exportedAt: cleanString(src.exportedAt || src.updatedAt || '') || nowIso(),
      folders: folders,
      items: items,
    };
  }

  function countFolderBindings(items) {
    return Object.keys(items || {}).reduce(function (sum, folderId) {
      return sum + asArray(items[folderId]).length;
    }, 0);
  }

  function mergeFolderRows(primary, fallback) {
    var p = safeObject(primary);
    var f = safeObject(fallback);
    var id = cleanString(p.id || p.folderId || f.id || f.folderId);
    if (!id) return null;
    var pMeta = safeObject(p.meta);
    var fMeta = safeObject(f.meta);
    var color = cleanString(p.color || p.iconColor || pMeta.color || pMeta.iconColor || f.color || f.iconColor || fMeta.color || fMeta.iconColor);
    var icon = cleanString(p.icon || pMeta.icon || pMeta.iconKey || f.icon || fMeta.icon || fMeta.iconKey);
    var out = {
      id: id,
      name: cleanString(p.name || p.title || pMeta.name || f.name || f.title || fMeta.name || id) || id,
      kind: cleanString(p.kind || pMeta.kind || f.kind || fMeta.kind || 'local') || 'local',
      parentId: cleanString(p.parentId || pMeta.parentId || f.parentId || fMeta.parentId),
      source: cleanString(p.source || pMeta.source || f.source || fMeta.source || 'desktop-sqlite') || 'desktop-sqlite',
      sortOrder: Math.floor(numberOrZero(
        p.sortOrder != null ? p.sortOrder
          : pMeta.sortOrder != null ? pMeta.sortOrder
          : f.sortOrder != null ? f.sortOrder
          : fMeta.sortOrder
      )),
      createdAt: cleanString(p.createdAt || pMeta.createdAt || f.createdAt || fMeta.createdAt),
      updatedAt: cleanString(p.updatedAt || pMeta.updatedAt || f.updatedAt || fMeta.updatedAt),
      meta: Object.assign({}, fMeta, pMeta),
    };
    if (color) {
      out.color = color;
      out.iconColor = color;
    }
    if (icon) out.icon = icon;
    return out;
  }

  function mergeFolderStates(primaryStateRaw, fallbackStateRaw) {
    var primary = normalizeFolderState(primaryStateRaw, 'desktop-sqlite');
    var fallback = normalizeFolderState(fallbackStateRaw, 'folder-state-cache');
    var byId = Object.create(null);
    var order = [];
    primary.folders.forEach(function (folder) {
      var id = cleanString(folder && folder.id);
      if (!id || byId[id]) return;
      byId[id] = folder;
      order.push(id);
    });
    var skippedFallbackVisibleFolderCount = 0;
    var filledVisualMetadataCount = 0;
    fallback.folders.forEach(function (folder) {
      var id = cleanString(folder && folder.id);
      if (!id) return;
      if (!byId[id]) {
        skippedFallbackVisibleFolderCount += 1;
        return;
      }
      var before = byId[id];
      var merged = mergeFolderRows(before, folder);
      if (merged && (!cleanString(before.color || before.iconColor) && cleanString(merged.color || merged.iconColor))) {
        filledVisualMetadataCount += 1;
      }
      byId[id] = merged || before;
    });
    var items = Object.create(null);
    var skippedPrimaryOrphanItemBindingCount = 0;
    var skippedPrimaryOrphanItemBindings = [];
    var addItems = function (rawItems, allowedFolderIds, options) {
      var normalized = normalizeFolderItems(rawItems);
      Object.keys(normalized).forEach(function (folderId) {
        var chatIds = uniqStrings(normalized[folderId]);
        if (allowedFolderIds instanceof Set && !allowedFolderIds.has(folderId)) {
          if (options && options.recordPrimaryOrphan) {
            skippedPrimaryOrphanItemBindingCount += chatIds.length;
            skippedPrimaryOrphanItemBindings.push({
              folderId: folderId,
              chatIds: chatIds,
              chatCount: chatIds.length,
              source: 'primary-folder-items',
              skipped: true,
              reason: 'folder-id-absent-from-exported-folder-catalog',
            });
          }
          return;
        }
        items[folderId] = uniqStrings((items[folderId] || []).concat(chatIds));
      });
    };
    var primaryAllowedFolderIds = new Set(order);
    addItems(primary.items, primaryAllowedFolderIds, { recordPrimaryOrphan: true });
    order.forEach(function (folderId) {
      if (!Object.prototype.hasOwnProperty.call(items, folderId)) items[folderId] = [];
    });
    var folders = order.map(function (folderId) { return byId[folderId]; }).filter(Boolean);
    var primaryBindingCount = countFolderBindings(primary.items);
    var fallbackBindingCount = countFolderBindings(fallback.items);
    var mergedBindingCount = countFolderBindings(items);
    var skippedFallbackBindingCount = fallbackBindingCount;
    var fallbackAvailable = fallback.folders.length > 0 || fallbackBindingCount > 0;
    var fallbackUsed = fallbackAvailable && filledVisualMetadataCount > 0;
    var exportedFrom = fallbackUsed
      ? (primary.folders.length ? 'desktop-sqlite+folder-state-cache-visuals' : fallback.exportedFrom)
      : 'desktop-sqlite';
    return {
      state: {
        schemaVersion: 1,
        exportedFrom: exportedFrom,
        exportedAt: nowIso(),
        folders: folders,
        items: items,
        sources: {
          primary: 'desktop-sqlite',
          fallback: fallback.folders.length ? fallback.exportedFrom : '',
          fallbackUsed: fallbackUsed,
          sourceOrder: ['desktop-sqlite', 'studio-folder-state-cache'],
        },
      },
      diagnostics: {
        primaryFolderCount: primary.folders.length,
        primaryBindingCount: primaryBindingCount,
        fallbackAvailable: fallbackAvailable,
        fallbackSource: fallbackAvailable ? fallback.exportedFrom : '',
        fallbackFolderCount: fallback.folders.length,
        fallbackBindingCount: fallbackBindingCount,
        skippedFallbackBindingCount: skippedFallbackBindingCount,
        skippedPrimaryOrphanItemBindingCount: skippedPrimaryOrphanItemBindingCount,
        skippedPrimaryOrphanItemBindings: skippedPrimaryOrphanItemBindings,
        primaryOrphanItemBindingAuthority: false,
        fallbackBindingAuthority: false,
        fallbackItemsMerged: false,
        canonicalBindingAuthority: 'desktop-sqlite',
        fallbackUsed: fallbackUsed,
        addedFolderCount: 0,
        skippedFallbackVisibleFolderCount: skippedFallbackVisibleFolderCount,
        fallbackVisibleAuthority: false,
        filledVisualMetadataCount: filledVisualMetadataCount,
        mergedFolderCount: folders.length,
        mergedBindingCount: mergedBindingCount,
      },
    };
  }

  function projectTag(row) {
    var id = cleanString(row && (row.tagId || row.id));
    if (!id) return null;
    var meta = safeObject(row && row.meta);
    return {
      id: id,
      name: cleanString((row && row.name) || meta.name || id) || id,
      autoDerived: !!(row && row.autoDerived),
      createdAt: epochToIso((row && row.createdAt) || meta.createdAt) || '',
      meta: meta,
    };
  }

  function projectTurnMessage(turn, index, capturedAt) {
    var order = (typeof turn.turnIdx === 'number' && Number.isFinite(turn.turnIdx))
      ? Math.floor(turn.turnIdx) : index;
    var meta = safeObject(turn.meta);
    var attachments = Array.isArray(meta.attachments) ? meta.attachments : (Array.isArray(turn.attachments) ? turn.attachments : []);
    return {
      role: cleanString(turn.role || 'assistant') || 'assistant',
      text: typeof turn.text === 'string' ? turn.text : '',
      order: order,
      createdAt: numberOrZero(capturedAt) || null,
      attachments: attachments,
    };
  }

  function projectRichTurn(turn, index) {
    var outer = typeof turn.outerHtml === 'string' ? turn.outerHtml : '';
    if (!outer) return null;
    var meta = safeObject(turn.meta);
    var out = Object.assign({}, meta);
    out.turnIdx = (typeof turn.turnIdx === 'number' && Number.isFinite(turn.turnIdx)) ? Math.floor(turn.turnIdx) : index;
    out.role = cleanString(turn.role || 'assistant') || 'assistant';
    out.outerHTML = outer;
    return out;
  }

  function makeCategoryRecord(categoryRow) {
    if (!categoryRow) return null;
    var id = cleanString(categoryRow.categoryId || categoryRow.id);
    if (!id) return null;
    return {
      primaryCategoryId: id,
      secondaryCategoryId: null,
      source: 'user',
      algorithmVersion: null,
      classifiedAt: null,
      overriddenAt: epochToIso(categoryRow.updatedAt) || null,
      confidence: null,
    };
  }

  function makeSnapshotMeta(chat, snapshot, turns, related) {
    var meta = Object.assign({}, safeObject(snapshot && snapshot.meta));
    var chatMeta = safeObject(chat && chat.meta);
    var folder = related.folder || null;
    var category = related.category || null;
    var labels = related.labels || [];
    var tags = related.tags || [];
    var title = cleanString((snapshot && snapshot.title) || meta.title || (chat && chat.title) || chat && chat.chatId);
    var href = cleanString((chat && (chat.href || chat.normalizedHref || chat.linkSourceHref)) || meta.href || meta.sourceUrl || '');
    var richTurns = turns.map(projectRichTurn).filter(function (row) { return !!row; });

    if (title) meta.title = title;
    if (href) {
      meta.href = href;
      meta.sourceUrl = meta.sourceUrl || href;
    }
    if (chat && chat.chatId && !meta.chatgptId) meta.chatgptId = cleanString(chat.chatId);
    meta.source = meta.source || 'desktop';
    meta.sourceType = meta.sourceType || 'desktop-sqlite-export';
    meta.originSource = meta.originSource || 'desktop-sqlite';
    meta.capturedAt = meta.capturedAt || epochToIso(snapshot && snapshot.capturedAt) || '';
    meta.updatedAt = meta.updatedAt || epochToIso((snapshot && snapshot.updatedAt) || (chat && chat.updatedAt)) || '';
    meta.messageCount = Number((snapshot && snapshot.messageCount) || turns.length || 0);
    if (typeof chatMeta.answerCount === 'number') meta.answerCount = chatMeta.answerCount;
    if (folder) {
      meta.folderId = cleanString(folder.folderId || folder.id);
      meta.folderName = cleanString(folder.name || meta.folderName || '');
    }
    if (category) meta.category = makeCategoryRecord(category);
    meta.labels = makeLabelAssignments(labels);
    meta.tags = tags.map(function (tag) { return cleanString(tag && (tag.tagId || tag.id)); }).filter(Boolean);
    if (richTurns.length > 0) meta.richTurns = richTurns;
    return meta;
  }

  async function readChromeStorageLocalValue(key) {
    return new Promise(function (resolve) {
      try {
        if (!global.chrome || !global.chrome.storage || !global.chrome.storage.local || typeof global.chrome.storage.local.get !== 'function') {
          resolve(null); return;
        }
        global.chrome.storage.local.get([key], function (items) {
          resolve(items && Object.prototype.hasOwnProperty.call(items, key) ? items[key] : null);
        });
      } catch (_) { resolve(null); }
    });
  }

  async function readLibraryStoreValue(key) {
    try {
      var store = H2O.Library && H2O.Library.Store;
      if (!store || typeof store.get !== 'function') return null;
      return await store.get(key);
    } catch (_) {
      return null;
    }
  }

  function readLocalStorageValue(key) {
    try {
      if (!global.localStorage || typeof global.localStorage.getItem !== 'function') return null;
      var raw = global.localStorage.getItem(key);
      if (raw == null) return null;
      try { return JSON.parse(raw); }
      catch (_) { return raw; }
    } catch (_) {
      return null;
    }
  }

  async function readAvailableFolderStateFallback() {
    var candidates = [
      { source: 'chrome.storage.local', value: await readChromeStorageLocalValue(FOLDER_STATE_KEY) },
      { source: 'H2O.Library.Store', value: await readLibraryStoreValue(FOLDER_STATE_KEY) },
      { source: 'localStorage', value: readLocalStorageValue(FOLDER_STATE_KEY) },
    ];
    for (var i = 0; i < candidates.length; i += 1) {
      var candidate = candidates[i];
      var normalized = normalizeFolderState(candidate.value, candidate.source);
      var bindingCount = countFolderBindings(normalized.items);
      if (normalized.folders.length || bindingCount) {
        normalized.exportedFrom = candidate.source;
        return {
          source: candidate.source,
          state: normalized,
          folderCount: normalized.folders.length,
          bindingCount: bindingCount,
        };
      }
    }
    return {
      source: '',
      state: null,
      folderCount: 0,
      bindingCount: 0,
    };
  }

  function findFolderForChat(folderStateRaw, chatIdRaw) {
    var chatId = cleanString(chatIdRaw);
    if (!chatId) return null;
    var stateObj = normalizeFolderState(folderStateRaw, 'folder-state-cache');
    var folderById = Object.create(null);
    stateObj.folders.forEach(function (folder) {
      var id = cleanString(folder && folder.id);
      if (id) folderById[id] = folder;
    });
    var folderIds = Object.keys(stateObj.items || {});
    for (var i = 0; i < folderIds.length; i += 1) {
      var folderId = folderIds[i];
      var chatIds = uniqStrings(stateObj.items[folderId]);
      if (chatIds.indexOf(chatId) >= 0) {
        return folderById[folderId] || projectFolder({ id: folderId, name: folderId, source: stateObj.exportedFrom });
      }
    }
    return null;
  }

  function hasDesktopFolderStoreAuthority(store) {
    return !!(store && (
      typeof store.getCanonicalChatFolderBindingForChat === 'function' ||
      typeof store.listCanonicalChatFolderBindingsForChat === 'function' ||
      typeof store.listCanonicalChatFolderBindings === 'function' ||
      typeof store.listChats === 'function' ||
      typeof store.list === 'function' ||
      typeof store.getAll === 'function' ||
      typeof store.get === 'function'
    ));
  }

  async function getCanonicalFolderForChat(store, chatIdRaw) {
    var chatId = cleanString(chatIdRaw);
    if (!store || !chatId || typeof store.getCanonicalChatFolderBindingForChat !== 'function') return null;
    try {
      var binding = await store.getCanonicalChatFolderBindingForChat(chatId);
      var folderId = cleanString(binding && (binding.folderId || binding.folder_id || binding.id));
      if (!folderId) return null;
      var folder = await getStoreRow(store, folderId);
      if (folder) return folder;
      return {
        id: folderId,
        folderId: folderId,
        name: cleanString(binding && (binding.folderName || binding.folder_name || binding.name)) || folderId,
        source: 'desktop-canonical-chat-folder-bindings',
      };
    } catch (_) {
      return null;
    }
  }

  function peerTransportFailure(input, error, status) {
    var inp = safeObject(input);
    var syncPeerId = cleanString(inp.syncPeerId);
    var safePeerDir = '';
    try { if (syncPeerId) safePeerDir = encodeURIComponent(syncPeerId); }
    catch (_) { safePeerDir = ''; }
    return {
      ok: false,
      phase: 'F4',
      mode: 'per-peer-local-transport-mirror',
      transportVersion: PEER_TRANSPORT_VERSION,
      stateSchema: PEER_STATE_SCHEMA,
      syncPeerId: syncPeerId,
      safePeerDir: safePeerDir,
      path: safePeerDir ? syncDisplayPath('devices/' + safePeerDir + '/' + SYNC_LATEST_FILE) : '',
      error: String(error && (error.message || error)),
      status: status || 'peer-transport-mirror-write-failed',
      atomicWrite: true,
      manifestCreated: false,
      historyCreated: false,
    };
  }

  async function writePeerTransportMirrorSafely(input) {
    try {
      var api = H2O && H2O.Studio && H2O.Studio.sync && H2O.Studio.sync.peerTransport;
      if (api && typeof api.writeLatestMirror === 'function') {
        var result = await api.writeLatestMirror(input);
        if (result && typeof result === 'object') return result;
        return peerTransportFailure(input, 'peer transport returned no result', 'peer-transport-mirror-no-result');
      }
      return peerTransportFailure(input, 'H2O.Studio.sync.peerTransport.writeLatestMirror unavailable', 'peer-transport-unavailable');
    } catch (error) {
      return peerTransportFailure(input, error, 'peer-transport-mirror-write-failed');
    }
  }

  function peerTransportWarning(result) {
    var r = safeObject(result);
    if (r.ok) return null;
    return {
      kind: 'peer-transport',
      warning: 'per-peer local transport mirror failed after root latest.json commit',
      status: cleanString(r.status),
      error: cleanString(r.error),
      syncPeerId: cleanString(r.syncPeerId),
      safePeerDir: cleanString(r.safePeerDir),
      transportVersion: cleanString(r.transportVersion || PEER_TRANSPORT_VERSION),
    };
  }

  function sortSnapshotsAscending(a, b) {
    var av = numberOrZero(a && a.snapshot && a.snapshot.capturedAt);
    var bv = numberOrZero(b && b.snapshot && b.snapshot.capturedAt);
    if (av !== bv) return av - bv;
    return cleanString(a && a.snapshot && a.snapshot.snapshotId).localeCompare(cleanString(b && b.snapshot && b.snapshot.snapshotId));
  }

  function makeChatIndex(chat, snapshots, related) {
    var latest = snapshots.length ? snapshots[snapshots.length - 1] : null;
    var latestSnap = latest && latest.snapshot;
    var pinnedIds = snapshots
      .filter(function (item) { return !!(item && item.snapshot && item.snapshot.pinned); })
      .map(function (item) { return cleanString(item.snapshot.snapshotId); })
      .filter(Boolean);
    var folder = related.folder || null;
    var category = related.category || null;
    var tags = related.tags || [];
    var labels = related.labels || [];
    return {
      lastSnapshotId: cleanString((chat && chat.lastSnapshotId) || (latestSnap && latestSnap.snapshotId) || ''),
      lastCapturedAt: epochToIso((chat && chat.lastCapturedAt) || (latestSnap && latestSnap.capturedAt)) || '',
      pinnedSnapshotIds: uniqStrings(pinnedIds),
      retentionPolicy: { keepLatest: DEFAULT_KEEP_LATEST },
      lastDigest: cleanString(latestSnap && latestSnap.digest),
      title: cleanString(chat && chat.title),
      href: cleanString(chat && (chat.href || chat.normalizedHref || chat.linkSourceHref)),
      state: {
        isSaved: !!(chat && chat.isSaved),
        isLinked: !!(chat && chat.isLinked),
        isPinned: !!(chat && chat.isPinned),
        isArchived: !!(chat && chat.isArchived),
        isDeleted: !!(chat && chat.isDeleted),
      },
      organization: {
        folderId: folder ? cleanString(folder.folderId || folder.id) : cleanString(chat && chat.folderId),
        folderName: folder ? cleanString(folder.name) : '',
        categoryId: category ? cleanString(category.categoryId || category.id) : cleanString(chat && chat.categoryId),
        tagIds: uniqStrings(tags.map(function (tag) { return tag && (tag.tagId || tag.id); })),
        tags: tags.map(projectTag).filter(Boolean),
        labelIds: uniqStrings(labels.map(function (label) { return label && (label.labelId || label.id); })),
      },
      linkSourceHref: cleanString(chat && chat.linkSourceHref),
      linkedFrom: cleanString(chat && chat.linkedFrom),
      linkedAt: epochToIso(chat && chat.linkedAt) || '',
    };
  }

  async function collectRelated(stores, chat, folderStateFallback) {
    var chatId = cleanString(chat && chat.chatId);
    var folderStore = stores && stores.folders;
    var hasCanonicalFolderStore = hasDesktopFolderStoreAuthority(folderStore);
    var folderRows = await listForChat(stores.folders, chatId);
    var folder = folderRows[0] || null;
    if (!folder) folder = await getCanonicalFolderForChat(folderStore, chatId);
    if (!folder && chat && chat.folderId) folder = await getStoreRow(stores.folders, chat.folderId);
    if (!folder && !hasCanonicalFolderStore) folder = findFolderForChat(folderStateFallback, chatId);
    if (!folder && !hasCanonicalFolderStore && chat && chat.folderId) {
      var fallbackState = normalizeFolderState(folderStateFallback, 'folder-state-cache');
      var fallbackFolders = asArray(fallbackState.folders);
      var wantedId = cleanString(chat.folderId);
      for (var fi = 0; fi < fallbackFolders.length; fi += 1) {
        if (cleanString(fallbackFolders[fi] && fallbackFolders[fi].id) === wantedId) {
          folder = fallbackFolders[fi];
          break;
        }
      }
    }
    var category = null;
    if (stores.categories && typeof stores.categories.getForChat === 'function') {
      try { category = await stores.categories.getForChat(chatId); }
      catch (_) { category = null; }
    }
    if (!category && chat && chat.categoryId) category = await getStoreRow(stores.categories, chat.categoryId);
    return {
      folder: folder,
      category: category,
      labels: await listForChat(stores.labels, chatId),
      tags: await listForChat(stores.tags, chatId),
    };
  }

  async function collectSnapshotRecords(stores, chatId) {
    var headers = [];
    if (stores.snapshots && typeof stores.snapshots.listByChat === 'function') {
      try { headers = asArray(await stores.snapshots.listByChat(chatId)); }
      catch (_) { headers = []; }
    }
    var out = [];
    for (var i = 0; i < headers.length; i += 1) {
      var header = headers[i] || {};
      var snapshotId = cleanString(header.snapshotId || header.id);
      if (!snapshotId) continue;
      var combined = null;
      if (stores.snapshots && typeof stores.snapshots.get === 'function') {
        try { combined = await stores.snapshots.get(snapshotId); }
        catch (_) { combined = null; }
      }
      if (combined && combined.snapshot) out.push(combined);
      else out.push({ snapshot: header, turns: [] });
    }
    out.sort(sortSnapshotsAscending);
    return out;
  }

  function projectBundleSnapshot(chat, combined, related) {
    var snapshot = combined && combined.snapshot ? combined.snapshot : {};
    var turns = asArray(combined && combined.turns);
    var createdAt = epochToIso(snapshot.capturedAt) || epochToIso(snapshot.updatedAt) || nowIso();
    var messages = turns.map(function (turn, index) {
      return projectTurnMessage(turn || {}, index, snapshot.capturedAt);
    });
    var meta = makeSnapshotMeta(chat, snapshot, turns, related);
    return {
      snapshotId: cleanString(snapshot.snapshotId || snapshot.id),
      chatId: cleanString(snapshot.chatId || chat.chatId),
      title: cleanString(snapshot.title || meta.title || chat.title || chat.chatId),
      createdAt: createdAt,
      schemaVersion: 1,
      messageCount: Number(snapshot.messageCount || messages.length || 0),
      digest: cleanString(snapshot.digest || ''),
      meta: meta,
      messages: messages,
    };
  }

  async function buildChatArchive(stores, warnings, folderStateFallback) {
    var chats = await listFromStore(stores.chats, { sort: { field: 'updatedAt', dir: 'DESC' } });
    var categories = (await listFromStore(stores.categories)).map(projectCategoryCatalog).filter(Boolean);
    var labels = (await listFromStore(stores.labels)).map(projectLabelCatalog).filter(Boolean);
    var archiveChats = [];
    var folderItems = Object.create(null);
    var labelBindings = Object.create(null);
    var snapshotCount = 0;
    var turnCount = 0;
    var linkedOnlyCount = 0;
    var noMessageSnapshotCount = 0;

    for (var i = 0; i < chats.length; i += 1) {
      var chat = chats[i] || {};
      var chatId = cleanString(chat.chatId || chat.id);
      if (!chatId) {
        warnings.push({ kind: 'chat', warning: 'skipped chat without chatId', index: i });
        continue;
      }
      var related = await collectRelated(stores, chat, folderStateFallback);
      var snapshotsCombined = await collectSnapshotRecords(stores, chatId);
      var bundleSnapshots = [];
      for (var si = 0; si < snapshotsCombined.length; si += 1) {
        var projected = projectBundleSnapshot(chat, snapshotsCombined[si], related);
        if (!projected.snapshotId) {
          warnings.push({ kind: 'snapshot', chatId: chatId, warning: 'skipped snapshot without snapshotId' });
          continue;
        }
        if (!projected.messages.length) {
          noMessageSnapshotCount += 1;
          warnings.push({ kind: 'snapshot-empty-messages', chatId: chatId, snapshotId: projected.snapshotId });
        }
        turnCount += projected.messages.length;
        bundleSnapshots.push(projected);
      }
      if (!bundleSnapshots.length) {
        linkedOnlyCount += 1;
        warnings.push({
          kind: 'linked-only-chat',
          chatId: chatId,
          warning: 'chat has no snapshots/messages; export keeps chat record but Chrome Saved Chats requires snapshots',
        });
      }
      snapshotCount += bundleSnapshots.length;
      if (related.folder) {
        var folderId = cleanString(related.folder.folderId || related.folder.id);
        if (folderId) {
          folderItems[folderId] = folderItems[folderId] || [];
          folderItems[folderId].push(chatId);
        }
      }
      var labelIds = uniqStrings(asArray(related.labels).map(function (label) { return label && (label.labelId || label.id); }));
      if (labelIds.length) labelBindings[chatId] = labelIds;
      archiveChats.push({
        chatId: chatId,
        bootMode: 'live_first',
        chatIndex: makeChatIndex(chat, snapshotsCombined, related),
        migrated: !!safeObject(chat.meta).migrated,
        snapshots: bundleSnapshots,
      });
    }

    return {
      archive: {
        schema: CHAT_ARCHIVE_SCHEMA,
        exportedAt: nowIso(),
        scope: 'all',
        chatCount: archiveChats.length,
        chats: archiveChats,
        catalogs: {
          categories: categories,
          labels: labels,
        },
      },
      diagnostics: {
        snapshotCount: snapshotCount,
        turnCount: turnCount,
        linkedOnlyCount: linkedOnlyCount,
        noMessageSnapshotCount: noMessageSnapshotCount,
      },
      folderItems: folderItems,
      labelBindings: labelBindings,
    };
  }

  async function buildFolderState(stores, folderItems, folderStateFallback) {
    var folders = (await listFromStore(stores.folders)).map(projectFolder).filter(Boolean);
    var items = Object.create(null);
    Object.keys(folderItems || {}).forEach(function (folderId) {
      items[folderId] = uniqStrings(folderItems[folderId]);
    });
    var folderStore = stores && stores.folders;
    if (folderStore && typeof folderStore.listChats === 'function') {
      for (var i = 0; i < folders.length; i += 1) {
        var folder = folders[i] || {};
        var folderId = cleanString(folder.id || folder.folderId);
        if (!folderId) continue;
        try {
          var rows = await folderStore.listChats(folderId);
          var chatIds = asArray(rows).map(function (row) {
            return cleanString(row && (row.chatId || row.id));
          }).filter(Boolean);
          items[folderId] = uniqStrings(chatIds.length ? chatIds : items[folderId]);
        } catch (e) {
          items[folderId] = uniqStrings(items[folderId]);
        }
      }
    }
    var primaryState = {
      schemaVersion: 1,
      exportedFrom: 'desktop-sqlite',
      exportedAt: nowIso(),
      folders: folders,
      items: items,
    };
    return mergeFolderStates(primaryState, folderStateFallback || null);
  }

  function buildFolderParityDiagnostics(folderState, chatArchive) {
    var stateObj = folderState && typeof folderState === 'object' ? folderState : {};
    var folders = asArray(stateObj.folders);
    var items = stateObj.items && typeof stateObj.items === 'object' ? stateObj.items : {};
    var folderSummaries = folders.map(function (folder) {
      var id = cleanString(folder && (folder.id || folder.folderId));
      var chatIds = uniqStrings(asArray(items[id]));
      return {
        id: id,
        folderId: id,
        name: cleanString((folder && folder.name) || id) || id,
        kind: cleanString((folder && folder.kind) || 'local') || 'local',
        source: cleanString((folder && folder.source) || stateObj.exportedFrom || 'desktop-sqlite') || 'desktop-sqlite',
        color: cleanString(folder && (folder.color || folder.iconColor)),
        iconColor: cleanString(folder && (folder.iconColor || folder.color)),
        icon: cleanString(folder && folder.icon),
        parentId: cleanString(folder && folder.parentId),
        sortOrder: Math.floor(numberOrZero(folder && folder.sortOrder)),
        createdAt: cleanString(folder && folder.createdAt),
        updatedAt: cleanString(folder && folder.updatedAt),
        bindingCount: chatIds.length,
        empty: chatIds.length === 0,
        chatIds: chatIds,
      };
    });
    var chatFolderRows = [];
    var snapshotFolderRows = [];
    asArray(chatArchive && chatArchive.chats).forEach(function (chat) {
      var org = safeObject(chat && chat.chatIndex && chat.chatIndex.organization);
      var folderId = cleanString(org.folderId);
      var folderName = cleanString(org.folderName);
      var chatId = cleanString(chat && chat.chatId);
      if (folderId || folderName) {
        chatFolderRows.push({
          chatId: chatId,
          folderId: folderId,
          folderName: folderName,
          snapshots: asArray(chat && chat.snapshots).length,
        });
      }
      asArray(chat && chat.snapshots).forEach(function (snapshot) {
        var meta = safeObject(snapshot && snapshot.meta);
        var snapFolderId = cleanString(meta.folderId);
        var snapFolderName = cleanString(meta.folderName);
        if (!snapFolderId && !snapFolderName) return;
        snapshotFolderRows.push({
          chatId: chatId,
          snapshotId: cleanString(snapshot && (snapshot.snapshotId || snapshot.id)),
          folderId: snapFolderId,
          folderName: snapFolderName,
          source: cleanString(meta.source),
        });
      });
    });
    var combinedFolderRows = chatFolderRows.concat(snapshotFolderRows.map(function (row) {
      return {
        chatId: row.chatId,
        folderId: row.folderId,
        folderName: row.folderName,
        snapshots: 1,
      };
    }));
    var bindingCount = folderSummaries.reduce(function (sum, folder) { return sum + folder.bindingCount; }, 0);
    var visualFields = [];
    folderSummaries.forEach(function (folder) {
      if (folder.color && visualFields.indexOf('color') < 0) visualFields.push('color');
      if (folder.iconColor && visualFields.indexOf('iconColor') < 0) visualFields.push('iconColor');
      if (folder.icon && visualFields.indexOf('icon') < 0) visualFields.push('icon');
    });
    return {
      phase: 'folder-parity-diagnostic',
      surface: 'desktop-export',
      source: cleanString(stateObj.exportedFrom || 'H2O.Studio.store.folders + folder_bindings'),
      sources: safeObject(stateObj.sources),
      folderStateKey: FOLDER_STATE_KEY,
      catalogCount: folderSummaries.length,
      bindingCount: bindingCount,
      emptyFolderCount: folderSummaries.filter(function (folder) { return folder.empty; }).length,
      boundFolderCount: folderSummaries.filter(function (folder) { return !folder.empty; }).length,
      folderNames: folderSummaries.map(function (folder) { return folder.name; }),
      folderIds: folderSummaries.map(function (folder) { return folder.id; }),
      visualMetadataFields: visualFields,
      colorsModeled: visualFields.indexOf('color') >= 0 || visualFields.indexOf('iconColor') >= 0,
      iconsModeled: visualFields.indexOf('icon') >= 0,
      emptyFoldersRepresented: folderSummaries.some(function (folder) { return folder.empty; }),
      chatIndexFolderReferenceCount: chatFolderRows.length,
      chatIndexFolderReferences: chatFolderRows,
      snapshotFolderReferenceCount: snapshotFolderRows.length,
      snapshotFolderReferences: snapshotFolderRows,
      chatArchiveFolderReferenceCount: combinedFolderRows.length,
      chatArchiveFolderReferences: combinedFolderRows,
      folders: folderSummaries,
    };
  }

  async function buildDesktopCanonicalChatFolderBindingProjection(stores, chatCount) {
    var exportedAt = nowIso();
    var warnings = [];
    var api = stores && stores.folders;
    var tombstones = stores && stores.tombstones;
    var baseDiagnostics = {
      schema: DESKTOP_CANONICAL_CHAT_FOLDER_BINDING_SCHEMA + '.diagnostics',
      exported: false,
      bindingCount: 0,
      folderBindingCounts: {},
      unfiledCount: null,
      missingFolderBindingCount: 0,
      deletedFolderBindingCount: 0,
      fallbackUnfiledBindingCount: 0,
      activeDanglingFolderBindingCount: 0,
      restoredFolderBindingCount: 0,
      source: 'desktop-store-folder-bindings',
      desktopAuthority: true,
      chromeAuthority: false,
      readOnlyProjection: true,
      noChromeDestructiveBindingApply: true,
      noHardDelete: true,
      noPurge: true,
      noChatDelete: true,
      noSnapshotDelete: true,
      noAssetDelete: true,
      blockers: [],
      warnings: warnings,
    };
    if (!api || typeof api.listChats !== 'function') {
      warnings.push({
        code: 'desktop-chat-folder-binding-store-unavailable',
        warning: 'store.folders.listChats unavailable; exporting empty canonical chat-folder binding projection',
      });
      return {
        schema: DESKTOP_CANONICAL_CHAT_FOLDER_BINDING_SCHEMA,
        source: 'desktop-canonical-chat-folder-bindings',
        status: 'exported',
        exportedAt: exportedAt,
        bindingCount: 0,
        folderBindingCounts: {},
        unfiledCount: null,
        missingFolderBindingCount: 0,
        deletedFolderBindingCount: 0,
        fallbackUnfiledBindingCount: 0,
        activeDanglingFolderBindingCount: 0,
        activeDeletedFolderBindingExportedAsActive: false,
        deletedFolderBindingsExcludedFromActiveProjection: true,
        restoredFolderBindingCount: 0,
        bindings: [],
        rows: [],
        diagnostics: baseDiagnostics,
        desktopAuthority: true,
        chromeAuthority: false,
        readOnlyProjection: true,
        noChromeDestructiveBindingApply: true,
        noHardDelete: true,
        noPurge: true,
        noChatDelete: true,
        noSnapshotDelete: true,
        noAssetDelete: true,
      };
    }
    var folderRows = [];
    try {
      folderRows = (await listFromStore(api)).map(projectFolder).filter(Boolean);
    } catch (e) {
      warnings.push({
        code: 'desktop-chat-folder-binding-folder-list-failed',
        warning: 'store.folders.list failed; exporting empty canonical chat-folder binding projection',
        error: String((e && e.message) || e),
      });
      return {
        schema: DESKTOP_CANONICAL_CHAT_FOLDER_BINDING_SCHEMA,
        source: 'desktop-canonical-chat-folder-bindings',
        status: 'exported',
        exportedAt: exportedAt,
        bindingCount: 0,
        folderBindingCounts: {},
        unfiledCount: null,
        missingFolderBindingCount: 0,
        deletedFolderBindingCount: 0,
        fallbackUnfiledBindingCount: 0,
        activeDanglingFolderBindingCount: 0,
        activeDeletedFolderBindingExportedAsActive: false,
        deletedFolderBindingsExcludedFromActiveProjection: true,
        restoredFolderBindingCount: 0,
        bindings: [],
        rows: [],
        diagnostics: baseDiagnostics,
        desktopAuthority: true,
        chromeAuthority: false,
        readOnlyProjection: true,
        noChromeDestructiveBindingApply: true,
        noHardDelete: true,
        noPurge: true,
        noChatDelete: true,
        noSnapshotDelete: true,
        noAssetDelete: true,
      };
    }
    var folderNames = {};
    var folderIds = [];
    folderRows.forEach(function (folder) {
      var folderId = cleanString(folder && (folder.folderId || folder.id));
      if (!folderId || folderIds.indexOf(folderId) >= 0) return;
      folderIds.push(folderId);
      folderNames[folderId] = cleanString(folder && (folder.name || folder.title)) || folderId;
    });
    folderIds.sort();
    var folderBindingCounts = {};
    var bindings = [];
    var seenChats = Object.create(null);
    var missingFolderBindingCount = 0;
    var deletedFolderBindingCount = 0;
    var fallbackUnfiledBindingCount = 0;
    var activeDanglingFolderBindingCount = 0;
    folderIds.forEach(function (folderId) { folderBindingCounts[folderId] = 0; });
    var activeDeletedFolderIds = Object.create(null);
    if (tombstones && typeof tombstones.list === 'function') {
      try {
        asArray(await tombstones.list({ recordKind: 'folder', activeOnly: true, limit: 1000 })).forEach(function (row) {
          var recordId = cleanString(row && (row.recordId || row.record_id));
          var meta = parseJsonObject(row && (row.meta || row.metaJson || row.meta_json));
          var folderId = cleanString(meta && meta.folderId) || (recordId.indexOf('folder:') === 0 ? decodeURIComponent(recordId.slice('folder:'.length)) : '');
          if (folderId) activeDeletedFolderIds[folderId] = true;
        });
      } catch (eDeleted) {
        warnings.push({
          code: 'desktop-chat-folder-binding-active-deleted-scan-failed',
          warning: 'active folder tombstone scan failed; deleted-folder binding fallback diagnostics may be incomplete',
          error: String((eDeleted && eDeleted.message) || eDeleted),
        });
      }
    }
    var canonicalRows = null;
    if (typeof api.listCanonicalChatFolderBindings === 'function') {
      try {
        canonicalRows = asArray(await api.listCanonicalChatFolderBindings());
      } catch (e2) {
        warnings.push({
          code: 'desktop-chat-folder-binding-canonical-list-read-failed',
          warning: 'store.folders.listCanonicalChatFolderBindings failed; falling back to per-folder listChats',
          error: String((e2 && e2.message) || e2),
        });
        canonicalRows = null;
      }
    }
    if (canonicalRows) {
      canonicalRows.forEach(function (row) {
        var chatId = cleanString(row && (row.chatId || row.conversationId || row.chat_id || row.id));
        var folderId = cleanString(row && (row.folderId || row.folder_id));
        if (!chatId || !folderId) return;
        if (folderIds.indexOf(folderId) < 0) {
          missingFolderBindingCount += 1;
          fallbackUnfiledBindingCount += 1;
          activeDanglingFolderBindingCount += 1;
          return;
        }
        if (activeDeletedFolderIds[folderId]) {
          deletedFolderBindingCount += 1;
          fallbackUnfiledBindingCount += 1;
          folderBindingCounts[folderId] = 0;
          return;
        }
        folderBindingCounts[folderId] = (Number(folderBindingCounts[folderId]) || 0) + 1;
        seenChats[chatId] = true;
        bindings.push({
          schema: DESKTOP_CANONICAL_CHAT_FOLDER_BINDING_SCHEMA + '.row',
          chatId: chatId,
          conversationId: chatId,
          folderId: folderId,
          folderName: cleanString(row && row.folderName) || folderNames[folderId] || folderId,
          source: 'desktop-canonical-chat-folder-bindings',
          sourceSurface: 'desktop-studio',
          authority: 'desktop',
          status: 'active',
          state: 'active',
          observedAt: exportedAt,
          updatedAt: '',
          noChromeDestructiveBindingApply: true,
          noChatDelete: true,
          noSnapshotDelete: true,
          noHardDelete: true,
          noPurge: true,
        });
      });
    } else {
      for (var i = 0; i < folderIds.length; i += 1) {
        var folderId = folderIds[i];
        var chatRows = [];
        try {
          chatRows = asArray(await api.listChats(folderId));
        } catch (e3) {
          warnings.push({
            code: 'desktop-chat-folder-binding-list-read-failed',
            folderId: folderId,
            warning: 'store.folders.listChats failed for folder; exporting known folders and continuing',
            error: String((e3 && e3.message) || e3),
          });
          chatRows = [];
        }
        var chatIds = uniqStrings(chatRows.map(function (row) {
          return cleanString(row && (row.chatId || row.id));
        }).filter(Boolean));
        folderBindingCounts[folderId] = chatIds.length;
        if (activeDeletedFolderIds[folderId]) {
          deletedFolderBindingCount += chatIds.length;
          fallbackUnfiledBindingCount += chatIds.length;
          folderBindingCounts[folderId] = 0;
          continue;
        }
        chatIds.forEach(function (chatId) {
          seenChats[chatId] = true;
          bindings.push({
            schema: DESKTOP_CANONICAL_CHAT_FOLDER_BINDING_SCHEMA + '.row',
            chatId: chatId,
            conversationId: chatId,
            folderId: folderId,
            folderName: folderNames[folderId] || folderId,
            source: 'desktop-canonical-chat-folder-bindings',
            sourceSurface: 'desktop-studio',
            authority: 'desktop',
            status: 'active',
            state: 'active',
            observedAt: exportedAt,
            updatedAt: '',
            noChromeDestructiveBindingApply: true,
            noChatDelete: true,
            noSnapshotDelete: true,
            noHardDelete: true,
            noPurge: true,
          });
        });
      }
    }
    bindings.sort(function (a, b) {
      return cleanString(a.folderId).localeCompare(cleanString(b.folderId)) ||
        cleanString(a.chatId).localeCompare(cleanString(b.chatId));
    });
    var knownChatCount = Number(chatCount);
    var unfiledCount = Number.isFinite(knownChatCount)
      ? Math.max(0, Math.floor(knownChatCount) - Object.keys(seenChats).length)
      : null;
    baseDiagnostics.exported = true;
    baseDiagnostics.bindingCount = bindings.length;
    baseDiagnostics.folderBindingCounts = folderBindingCounts;
    baseDiagnostics.unfiledCount = unfiledCount;
    baseDiagnostics.canonicalBindingReadPath = canonicalRows
      ? 'store.folders.listCanonicalChatFolderBindings'
      : 'store.folders.listChats';
    baseDiagnostics.missingFolderBindingCount = missingFolderBindingCount;
    baseDiagnostics.deletedFolderBindingCount = deletedFolderBindingCount;
    baseDiagnostics.fallbackUnfiledBindingCount = fallbackUnfiledBindingCount;
    baseDiagnostics.activeDanglingFolderBindingCount = activeDanglingFolderBindingCount;
    return {
      schema: DESKTOP_CANONICAL_CHAT_FOLDER_BINDING_SCHEMA,
      source: 'desktop-canonical-chat-folder-bindings',
      status: 'exported',
      exportedAt: exportedAt,
      bindingCount: bindings.length,
      folderBindingCounts: folderBindingCounts,
      unfiledCount: unfiledCount,
      missingFolderBindingCount: missingFolderBindingCount,
      deletedFolderBindingCount: deletedFolderBindingCount,
      fallbackUnfiledBindingCount: fallbackUnfiledBindingCount,
      activeDanglingFolderBindingCount: activeDanglingFolderBindingCount,
      activeDeletedFolderBindingExportedAsActive: false,
      deletedFolderBindingsExcludedFromActiveProjection: true,
      restoredFolderBindingCount: 0,
      bindings: bindings,
      rows: bindings,
      canonicalBindingReadPath: baseDiagnostics.canonicalBindingReadPath,
      diagnostics: baseDiagnostics,
      desktopAuthority: true,
      chromeAuthority: false,
      readOnlyProjection: true,
      noChromeDestructiveBindingApply: true,
      noHardDelete: true,
      noPurge: true,
      noChatDelete: true,
      noSnapshotDelete: true,
      noAssetDelete: true,
    };
  }

  function buildLibraryKv(labelBindings) {
    var keys = Object.keys(labelBindings || {});
    if (!keys.length) return [];
    var bindings = {};
    keys.sort().forEach(function (chatId) {
      var ids = uniqStrings(labelBindings[chatId]);
      if (ids.length) bindings[chatId] = ids;
    });
    if (!Object.keys(bindings).length) return [];
    return [{
      key: LABEL_BINDINGS_KEY,
      value: {
        schemaVersion: 1,
        exportedFrom: 'desktop-sqlite',
        exportedAt: nowIso(),
        bindings: bindings,
      },
    }];
  }

  function getManifestInfo() {
    try {
      if (global.chrome && global.chrome.runtime && typeof global.chrome.runtime.getManifest === 'function') {
        var m = global.chrome.runtime.getManifest() || {};
        return {
          id: cleanString(global.chrome.runtime.id || 'desktop-tauri'),
          name: cleanString(m.name || 'H2O Studio Desktop'),
          version: cleanString(m.version || ''),
        };
      }
    } catch (_) { /* ignore */ }
    return { id: 'desktop-tauri', name: 'H2O Studio Desktop', version: '' };
  }

  function storeAvailability(stores) {
    return {
      chats: !!(stores.chats && (typeof stores.chats.list === 'function' || typeof stores.chats.getAll === 'function')),
      snapshots: !!(stores.snapshots && typeof stores.snapshots.listByChat === 'function' && typeof stores.snapshots.get === 'function'),
      folders: !!(stores.folders && (typeof stores.folders.list === 'function' || typeof stores.folders.getAll === 'function')),
      categories: !!(stores.categories && (typeof stores.categories.list === 'function' || typeof stores.categories.getAll === 'function')),
      labels: !!(stores.labels && (typeof stores.labels.list === 'function' || typeof stores.labels.getAll === 'function')),
      tags: !!(stores.tags && (typeof stores.tags.list === 'function' || typeof stores.tags.getAll === 'function')),
      tombstoneReviews: !!(stores.tombstoneReviews && typeof stores.tombstoneReviews.listFolderDeleteReceipts === 'function'),
    };
  }

  function emptyTombstoneExportDiagnostics(warnings) {
    return {
      supported: true,
      exported: false,
      schema: TOMBSTONE_SCHEMA_VERSION,
      total: 0,
      active: 0,
      restored: 0,
      skipped: 0,
      byKind: [],
      warnings: asArray(warnings),
    };
  }

  function emptyApplyEventsPayload(extra) {
    var safeExtra = safeObject(extra);
    return {
      schema: APPLY_EVENTS_SCHEMA_VERSION,
      redacted: true,
      available: safeExtra.available === true,
      total: Number(safeExtra.total) || 0,
      byOperation: safeObject(safeExtra.byOperation),
      capped: safeExtra.capped === true,
      limit: Number(safeExtra.limit) || APPLY_EVENT_LIMIT,
      skippedMalformed: Number(safeExtra.skippedMalformed) || 0,
      events: asArray(safeExtra.events),
      warnings: asArray(safeExtra.warnings),
    };
  }

  function emptyFolderDeleteReceiptDiagnostics(warnings) {
    return {
      supported: true,
      exported: false,
      schema: FOLDER_DELETE_RECEIPT_SCHEMA,
      total: 0,
      exportedCount: 0,
      statusOnly: true,
      noTombstoneApply: true,
      tombstonePropagation: 'deferred',
      chromeHideDeferred: true,
      warnings: asArray(warnings),
    };
  }

  function emptyFolderRestoreReceiptDiagnostics(warnings) {
    return {
      supported: true,
      exported: false,
      schema: FOLDER_RESTORE_RECEIPT_SCHEMA,
      total: 0,
      exportedCount: 0,
      statusOnly: true,
      noTombstoneApply: true,
      tombstonePropagation: 'deferred',
      chromeReShowDeferred: true,
      warnings: asArray(warnings),
    };
  }

  function emptyChatFolderBindingReceiptDiagnostics(warnings) {
    return {
      supported: true,
      exported: false,
      schema: CHAT_FOLDER_BINDING_RECEIPT_SCHEMA,
      total: 0,
      exportedCount: 0,
      statusOnly: true,
      noChromeBindingAuthority: true,
      noChromeDestructiveBindingApply: true,
      noHardDelete: true,
      noPurge: true,
      noChatDelete: true,
      noSnapshotDelete: true,
      noAssetDelete: true,
      warnings: asArray(warnings),
    };
  }

  function emptyLibraryMetadataMutationReceiptDiagnostics(warnings) {
    return {
      supported: true,
      exported: false,
      schema: LIBRARY_METADATA_MUTATION_RECEIPT_SCHEMA,
      total: 0,
      exportedCount: 0,
      statusOnly: true,
      desktopAuthority: true,
      chromeAuthority: false,
      noChromeCanonicalMutation: true,
      noDesktopCanonicalMutationFromChrome: true,
      noHardDelete: true,
      noPurge: true,
      noChatDelete: true,
      noSnapshotDelete: true,
      noAssetDelete: true,
      noLabelDelete: true,
      noTagDelete: true,
      noCategoryDelete: true,
      noMetadataDelete: true,
      productSyncReady: false,
      warnings: asArray(warnings),
    };
  }

  function warningCode(code) {
    return { code: cleanString(code) || 'warning' };
  }

  function addBucket(map, key) {
    var safeKey = cleanString(key) || 'unknown';
    map[safeKey] = (Number(map[safeKey]) || 0) + 1;
  }

  function parseJsonObject(text) {
    try {
      if (!cleanString(text)) return null;
      var parsed = JSON.parse(String(text));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
      return parsed;
    } catch (_) {
      return null;
    }
  }

  function fieldsAreColorOnly(fields) {
    var values = asArray(fields).map(function (field) {
      return cleanString(field);
    }).filter(Boolean);
    return values.length === 1 && values[0] === 'color';
  }

  function successfulApplyAuditResult(row, parsed) {
    if (!parsed) return false;
    if (cleanString(row && row.operation) !== APPLY_EVENT_OPERATION) return false;
    if (cleanString(row && row.policy_version) !== APPLY_EVENT_POLICY_VERSION) return false;
    if (Number(row && row.dry_run) !== 0) return false;
    if (cleanString(parsed.operation || APPLY_EVENT_OPERATION) !== APPLY_EVENT_OPERATION) return false;
    if (cleanString(parsed.policyVersion || APPLY_EVENT_POLICY_VERSION) !== APPLY_EVENT_POLICY_VERSION) return false;
    if (cleanString(parsed.entityKind) !== 'folder.metadata') return false;
    if (!fieldsAreColorOnly(parsed.fieldsUpdated)) return false;
    if (Number(parsed.rowsUpdated) !== 1) return false;
    if (parsed.localOnly !== true) return false;
    if (parsed.syncPropagated !== false) return false;
    return true;
  }

  async function makeApplyEventDigest(row, parsed) {
    var peerId = cleanString(row && row.requested_by_sync_peer_id);
    var peerHash = peerId ? await sha256Hex(peerId) : '';
    var material = JSON.stringify({
      schema: APPLY_EVENT_SCHEMA_VERSION,
      operation: APPLY_EVENT_OPERATION,
      policyVersion: APPLY_EVENT_POLICY_VERSION,
      maintenanceId: cleanString(row && row.maintenance_id),
      requestedAt: cleanString(row && row.requested_at),
      sourcePeerHash: peerHash,
      fieldsUpdated: ['color'],
      rowsUpdated: Number(parsed && parsed.rowsUpdated) || 0,
      localOnly: parsed && parsed.localOnly === true,
      syncPropagated: parsed && parsed.syncPropagated === true,
    });
    var digest = await sha256Hex(material);
    return digest ? ('sha256:' + digest) : '';
  }

  async function projectApplyEvent(row, parsed) {
    return {
      schema: APPLY_EVENT_SCHEMA_VERSION,
      operation: APPLY_EVENT_OPERATION,
      entityKind: 'folder.metadata',
      fieldsUpdated: ['color'],
      policyVersion: APPLY_EVENT_POLICY_VERSION,
      sourcePeerPresent: !!cleanString(row && row.requested_by_sync_peer_id),
      appliedAtPresent: !!cleanString(row && row.requested_at),
      beforeHashPresent: parsed && (parsed.baselineHashPresent === true || parsed.beforeHashPresent === true),
      afterHashPresent: parsed && (parsed.targetHashPresent === true || parsed.afterHashPresent === true),
      auditRecorded: true,
      redacted: true,
      eventDigest: await makeApplyEventDigest(row, parsed),
    };
  }

  async function applyEventsAuditTableAvailable() {
    try {
      var rows = await sqlSelect(
        'SELECT name FROM sqlite_master WHERE type = ? AND name = ? LIMIT 1',
        ['table', 'sync_maintenance_log']
      );
      return Array.isArray(rows) && rows.length > 0;
    } catch (_) {
      return false;
    }
  }

  async function buildApplyEventsPayloadSafely() {
    var warnings = [];
    var tableAvailable = await applyEventsAuditTableAvailable();
    if (!tableAvailable) {
      return emptyApplyEventsPayload({
        available: false,
        warnings: [warningCode('apply-event-audit-log-unavailable')],
      });
    }

    try {
      var rows = await sqlSelect(
        [
          'SELECT maintenance_id, operation, policy_version, requested_at,',
          '       requested_by_sync_peer_id, dry_run, result_json',
          '  FROM sync_maintenance_log',
          ' WHERE operation = ?',
          '   AND policy_version = ?',
          '   AND dry_run = 0',
          ' ORDER BY requested_at DESC, created_at DESC, maintenance_id DESC',
        ].join('\n'),
        [APPLY_EVENT_OPERATION, APPLY_EVENT_POLICY_VERSION]
      );
      var byOperation = {};
      var total = 0;
      var skippedMalformed = 0;
      var events = [];

      for (var i = 0; i < asArray(rows).length; i += 1) {
        var row = rows[i] || {};
        var parsed = parseJsonObject(row.result_json);
        if (!parsed) {
          skippedMalformed += 1;
          continue;
        }
        if (!successfulApplyAuditResult(row, parsed)) continue;
        total += 1;
        addBucket(byOperation, APPLY_EVENT_OPERATION);
        if (events.length < APPLY_EVENT_LIMIT) {
          var projected = await projectApplyEvent(row, parsed);
          if (cleanString(projected.eventDigest)) events.push(projected);
          else skippedMalformed += 1;
        }
      }

      if (skippedMalformed > 0) warnings.push(warningCode('apply-event-audit-json-malformed'));

      return {
        schema: APPLY_EVENTS_SCHEMA_VERSION,
        redacted: true,
        available: true,
        total: total,
        byOperation: byOperation,
        capped: total > APPLY_EVENT_LIMIT,
        limit: APPLY_EVENT_LIMIT,
        skippedMalformed: skippedMalformed,
        events: events,
        warnings: warnings,
      };
    } catch (_) {
      return emptyApplyEventsPayload({
        available: false,
        warnings: [warningCode('apply-event-audit-log-unavailable')],
      });
    }
  }

  async function buildTombstoneExportPayloadSafely(stores) {
    var api = stores && stores.tombstones;
    if (!api || typeof api.previewExport !== 'function') {
      return {
        tombstones: [],
        diagnostics: emptyTombstoneExportDiagnostics([{
          code: 'tombstone-preview-unavailable',
          warning: 'store.tombstones.previewExport unavailable; exporting empty tombstones array',
        }]),
      };
    }
    try {
      var preview = await api.previewExport({
        includeRestored: true,
        includeSensitive: true,
        limit: TOMBSTONE_EXPORT_LIMIT,
      });
      if (!preview || typeof preview !== 'object' || !Array.isArray(preview.tombstones)) {
        return {
          tombstones: [],
          diagnostics: emptyTombstoneExportDiagnostics([{
            code: 'tombstone-preview-malformed',
            warning: 'store.tombstones.previewExport returned malformed payload; exporting empty tombstones array',
          }]),
        };
      }
      return {
        tombstones: preview.tombstones,
        diagnostics: {
          supported: true,
          exported: true,
          schema: cleanString(preview.tombstoneSchemaVersion) || TOMBSTONE_SCHEMA_VERSION,
          total: Number(preview.total) || preview.tombstones.length,
          active: Number(preview.active) || 0,
          restored: Number(preview.restored) || 0,
          skipped: Number(preview.skipped) || 0,
          byKind: asArray(preview.byKind),
          warnings: asArray(preview.warnings),
        },
      };
    } catch (e) {
      return {
        tombstones: [],
        diagnostics: emptyTombstoneExportDiagnostics([{
          code: 'tombstone-preview-failed',
          warning: 'store.tombstones.previewExport failed; exporting empty tombstones array',
          error: String((e && e.message) || e),
        }]),
      };
    }
  }

  async function buildFolderDeleteReceiptPayloadSafely(stores) {
    var api = stores && stores.tombstoneReviews;
    if (!api || typeof api.listFolderDeleteReceipts !== 'function') {
      return {
        receipts: [],
        diagnostics: emptyFolderDeleteReceiptDiagnostics([{
          code: 'folder-delete-receipt-store-unavailable',
          warning: 'store.tombstoneReviews.listFolderDeleteReceipts unavailable; exporting empty folderDeleteReceipts array',
        }]),
      };
    }
    try {
      var receipts = await api.listFolderDeleteReceipts({
        decision: 'applied-folder-delete-request',
        limit: FOLDER_DELETE_RECEIPT_LIMIT,
      });
      if (!Array.isArray(receipts)) {
        return {
          receipts: [],
          diagnostics: emptyFolderDeleteReceiptDiagnostics([{
            code: 'folder-delete-receipt-list-malformed',
            warning: 'store.tombstoneReviews.listFolderDeleteReceipts returned a non-array payload',
          }]),
        };
      }
      var projected = receipts.filter(function (receipt) {
        return receipt && typeof receipt === 'object' &&
          cleanString(receipt.schema) === FOLDER_DELETE_RECEIPT_SCHEMA &&
          receipt.statusOnly === true &&
          receipt.noTombstoneApply === true;
      });
      return {
        receipts: projected,
        diagnostics: {
          supported: true,
          exported: true,
          schema: FOLDER_DELETE_RECEIPT_SCHEMA,
          total: receipts.length,
          exportedCount: projected.length,
          skippedMalformed: Math.max(0, receipts.length - projected.length),
          statusOnly: true,
          noTombstoneApply: true,
          tombstonePropagation: 'deferred',
          chromeHideDeferred: true,
          warnings: [],
        },
      };
    } catch (e) {
      return {
        receipts: [],
        diagnostics: emptyFolderDeleteReceiptDiagnostics([{
          code: 'folder-delete-receipt-export-failed',
          warning: 'folder delete receipt projection failed; exporting empty folderDeleteReceipts array',
          error: String((e && e.message) || e),
        }]),
      };
    }
  }

  async function buildChatFolderBindingReceiptPayloadSafely(stores) {
    var api = stores && stores.tombstoneReviews;
    if (!api || typeof api.listChatFolderBindingReceipts !== 'function') {
      return {
        receipts: [],
        diagnostics: emptyChatFolderBindingReceiptDiagnostics([{
          code: 'chat-folder-binding-receipt-store-unavailable',
          warning: 'store.tombstoneReviews.listChatFolderBindingReceipts unavailable; exporting empty chatFolderBindingReceipts array',
        }]),
      };
    }
    try {
      var receipts = await api.listChatFolderBindingReceipts({
        limit: CHAT_FOLDER_BINDING_RECEIPT_LIMIT,
      });
      if (!Array.isArray(receipts)) {
        return {
          receipts: [],
          diagnostics: emptyChatFolderBindingReceiptDiagnostics([{
            code: 'chat-folder-binding-receipt-list-malformed',
            warning: 'store.tombstoneReviews.listChatFolderBindingReceipts returned a non-array payload',
          }]),
        };
      }
      var projected = receipts.filter(function (receipt) {
        return receipt && typeof receipt === 'object' &&
          cleanString(receipt.schema) === CHAT_FOLDER_BINDING_RECEIPT_SCHEMA &&
          receipt.statusOnly === true &&
          receipt.noChromeBindingAuthority === true &&
          receipt.noChromeDestructiveBindingApply === true;
      });
      return {
        receipts: projected,
        diagnostics: {
          supported: true,
          exported: true,
          schema: CHAT_FOLDER_BINDING_RECEIPT_SCHEMA,
          total: receipts.length,
          receiptCount: projected.length,
          exportedCount: projected.length,
          skippedMalformed: Math.max(0, receipts.length - projected.length),
          statusOnly: true,
          noChromeBindingAuthority: true,
          noChromeDestructiveBindingApply: true,
          noHardDelete: true,
          noPurge: true,
          noChatDelete: true,
          noSnapshotDelete: true,
          noAssetDelete: true,
          warnings: [],
        },
      };
    } catch (e) {
      return {
        receipts: [],
        diagnostics: emptyChatFolderBindingReceiptDiagnostics([{
          code: 'chat-folder-binding-receipt-export-failed',
          warning: 'chat-folder binding receipt projection failed; exporting empty chatFolderBindingReceipts array',
          error: String((e && e.message) || e),
        }]),
      };
    }
  }

  async function buildLibraryMetadataMutationReceiptPayloadSafely() {
    try {
      var mirror = await readChromeStorageLocalValue(LIBRARY_METADATA_MUTATION_RECEIPT_EXPORT_KEY);
      if (!mirror || typeof mirror !== 'object' || Array.isArray(mirror)) {
        return {
          receipts: [],
          diagnostics: emptyLibraryMetadataMutationReceiptDiagnostics([{
            code: 'library-metadata-mutation-receipt-export-mirror-missing',
            warning: 'no Desktop library metadata mutation receipt mirror exists yet; exporting empty libraryMetadataMutationReceipts array',
          }]),
        };
      }
      if (cleanString(mirror.schema) !== LIBRARY_METADATA_MUTATION_RECEIPT_EXPORT_MIRROR_SCHEMA) {
        return {
          receipts: [],
          diagnostics: emptyLibraryMetadataMutationReceiptDiagnostics([{
            code: 'library-metadata-mutation-receipt-export-mirror-schema-invalid',
            warning: 'Desktop library metadata mutation receipt mirror schema was not recognized; exporting empty libraryMetadataMutationReceipts array',
          }]),
        };
      }
      var receipts = Array.isArray(mirror.receipts) ? mirror.receipts.slice(0, LIBRARY_METADATA_MUTATION_RECEIPT_LIMIT) : [];
      var projected = receipts.filter(function (receipt) {
        return receipt && typeof receipt === 'object' &&
          cleanString(receipt.schema) === LIBRARY_METADATA_MUTATION_RECEIPT_SCHEMA &&
          cleanString(receipt.receiptId) &&
          receipt.separateFromDesktopCanonicalLibraryMetadata === true &&
          receipt.productSyncReady === false &&
          receipt.privacy && receipt.privacy.redacted === true &&
          receipt.privacy.hashOnly === true &&
          receipt.safety && receipt.safety.desktopAuthority === true &&
          receipt.safety.chromeAuthority === false &&
          receipt.safety.noChromeCanonicalMutation === true &&
          receipt.safety.noHardDelete === true &&
          receipt.safety.noPurge === true &&
          receipt.safety.noChatDelete === true &&
          receipt.safety.noSnapshotDelete === true &&
          receipt.safety.noAssetDelete === true &&
          receipt.safety.noLabelDelete === true &&
          receipt.safety.noTagDelete === true &&
          receipt.safety.noCategoryDelete === true &&
          receipt.safety.noMetadataDelete === true;
      });
      return {
        receipts: projected,
        diagnostics: {
          supported: true,
          exported: true,
          schema: LIBRARY_METADATA_MUTATION_RECEIPT_SCHEMA,
          mirrorSchema: LIBRARY_METADATA_MUTATION_RECEIPT_EXPORT_MIRROR_SCHEMA,
          total: receipts.length,
          exportedCount: projected.length,
          skippedMalformed: Math.max(0, receipts.length - projected.length),
          statusOnly: true,
          desktopAuthority: true,
          chromeAuthority: false,
          noChromeCanonicalMutation: true,
          noDesktopCanonicalMutationFromChrome: true,
          noHardDelete: true,
          noPurge: true,
          noChatDelete: true,
          noSnapshotDelete: true,
          noAssetDelete: true,
          noLabelDelete: true,
          noTagDelete: true,
          noCategoryDelete: true,
          noMetadataDelete: true,
          productSyncReady: false,
          warnings: [],
        },
      };
    } catch (e) {
      return {
        receipts: [],
        diagnostics: emptyLibraryMetadataMutationReceiptDiagnostics([{
          code: 'library-metadata-mutation-receipt-export-failed',
          warning: 'library metadata mutation receipt projection failed; exporting empty libraryMetadataMutationReceipts array',
          error: String((e && e.message) || e),
        }]),
      };
    }
  }

  async function buildDesktopCanonicalLibraryMetadataProjectionSafely() {
    var fallback = {
      schema: DESKTOP_CANONICAL_LIBRARY_METADATA_SCHEMA,
      version: '0.1.0-phase2',
      phase: 'phase2-desktop-canonical-export',
      source: {
        surface: 'desktop-studio',
        platformAdapter: 'tauri',
        authority: 'desktop',
        projection: 'desktop-canonical-library-metadata',
        requestedBy: 'desktop-export-bundle',
      },
      privacy: {
        redacted: true,
        hashOnly: true,
        rawChatIds: false,
        rawChatTitles: false,
        rawChatContent: false,
        rawLabelNames: false,
        rawTagNames: false,
        rawCategoryNames: false,
        rawColors: false,
        accountLinkedMetadata: false,
      },
      sideEffectSummary: {
        readOnly: true,
        storageWrites: false,
        sqliteWrites: false,
        chromeStorageWrites: false,
        importInvoked: false,
        exportInvoked: false,
        syncNowInvoked: false,
        applyExecuted: false,
        desktopApply: false,
        chromeRequestExport: false,
        canonicalMutation: false,
        deletes: false,
      },
      counts: {
        labelCatalogCount: 0,
        tagCatalogCount: 0,
        categoryCatalogCount: 0,
        chatStoreRowCount: 0,
        chatLabelBindingCount: 0,
        chatTagBindingCount: 0,
        chatCategoryAssignmentCount: 0,
        classificationSignalCount: 0,
      },
      hashes: {},
      catalogs: { labels: [], tags: [], categories: [] },
      bindings: { chatLabels: [], chatTags: [], chatCategories: [] },
      diagnostics: {
        ok: false,
        warnings: [{ code: 'library-metadata-export-projection-unavailable' }],
        blockers: [],
        productSyncReady: false,
        phase2DesktopExportReady: false,
        chromeImportDisplayParityImplemented: false,
        chromeRequestExportImplemented: false,
        desktopApplyImplemented: false,
      },
      safety: {
        noHardDelete: true,
        noPurge: true,
        noChatDelete: true,
        noSnapshotDelete: true,
        noAssetDelete: true,
        noLabelDelete: true,
        noTagDelete: true,
        noCategoryDelete: true,
        noMetadataDelete: true,
      },
    };
    try {
      var sync = safeObject(H2O.Studio && H2O.Studio.sync);
      var api = safeObject(sync.libraryMetadataExportProjection);
      if (typeof api.buildDesktopCanonicalMetadataExport !== 'function') return fallback;
      var projection = await api.buildDesktopCanonicalMetadataExport({
        requestedBy: 'desktop-export-bundle',
      });
      return safeObject(projection);
    } catch (e) {
      fallback.diagnostics = Object.assign({}, fallback.diagnostics, {
        warnings: asArray(fallback.diagnostics && fallback.diagnostics.warnings).concat([{
          code: 'library-metadata-export-projection-failed',
          error: String((e && e.message) || e),
        }]),
      });
      return fallback;
    }
  }

  function folderIdFromTombstoneRecordId(recordIdInput) {
    var recordId = cleanString(recordIdInput);
    if (recordId.indexOf('folder:') === 0) return cleanString(recordId.slice('folder:'.length));
    return recordId;
  }

  function canonicalRecentlyDeletedFolderName(tombstone) {
    var meta = safeObject(tombstone && tombstone.meta);
    var recovery = safeObject(meta.recoverySnapshot);
    var folder = safeObject(recovery.folder);
    return cleanString(folder.name || folder.title || meta.folderName || tombstone && tombstone.folderName);
  }

  function canonicalRecentlyDeletedRequestId(tombstone) {
    var meta = safeObject(tombstone && tombstone.meta);
    var requestId = cleanString(meta.requestId || meta.reviewId || meta.deleteRequestId || meta.folderDeleteRequestId);
    if (requestId) return requestId;
    var recovery = safeObject(meta.recoverySnapshot);
    return cleanString(recovery.requestId || recovery.reviewId || recovery.deleteRequestId || recovery.folderDeleteRequestId);
  }

  function canonicalRecentlyDeletedRowFromTombstone(tombstone) {
    if (!tombstone || typeof tombstone !== 'object') return null;
    if (cleanString(tombstone.schema) !== TOMBSTONE_SCHEMA_VERSION) return null;
    if (cleanString(tombstone.recordKind) !== 'folder') return null;
    if (cleanString(tombstone.restoredAt)) return null;
    var folderId = folderIdFromTombstoneRecordId(tombstone.recordId);
    if (!folderId) return null;
    var meta = safeObject(tombstone.meta);
    var requestId = canonicalRecentlyDeletedRequestId(tombstone);
    var folderName = canonicalRecentlyDeletedFolderName(tombstone) || folderId;
    return {
      schema: DESKTOP_CANONICAL_RECENTLY_DELETED_SCHEMA + '.row',
      tombstoneId: cleanString(tombstone.tombstoneId),
      recordId: cleanString(tombstone.recordId),
      folderId: folderId,
      folderName: folderName,
      name: folderName,
      deletedAt: cleanString(tombstone.deletedAt),
      deletedBy: cleanString(tombstone.deletedBySyncPeerId),
      deletedBySurface: cleanString(meta.deletedBySurface || meta.sourceSurface || tombstone.deletedBySurface || 'desktop-studio'),
      deleteReason: cleanString(tombstone.deleteReason || meta.deleteReason || meta.reason),
      requestId: requestId,
      reviewId: requestId,
      source: 'desktop-canonical-recently-deleted',
      sourceKind: 'desktop-canonical-recently-deleted',
      status: 'deleted',
      restoreEligible: true,
      restoreAvailable: true,
      purgeEligible: true,
      purgeBlocked: false,
      hardDeleteBlocked: true,
      noChromeAuthority: true,
      noChromeTombstoneApply: true,
      noChromeTombstoneCreate: true,
      noHardDelete: true,
      noChatDelete: true,
      noSnapshotDelete: true,
      noAssetDelete: true,
    };
  }

  function buildDesktopCanonicalRecentlyDeletedPayloadFromTombstones(tombstones) {
    var rows = asArray(tombstones)
      .map(canonicalRecentlyDeletedRowFromTombstone)
      .filter(function (row) { return row && row.folderId; })
      .sort(function (a, b) {
        return cleanString(b.deletedAt).localeCompare(cleanString(a.deletedAt)) ||
          cleanString(a.folderName).localeCompare(cleanString(b.folderName));
      });
    return {
      schema: DESKTOP_CANONICAL_RECENTLY_DELETED_SCHEMA,
      source: 'desktop-canonical-recently-deleted',
      status: 'exported',
      exportedAt: nowIso(),
      count: rows.length,
      rows: rows,
      folderIds: rows.map(function (row) { return row.folderId; }),
      diagnostics: {
        schema: DESKTOP_CANONICAL_RECENTLY_DELETED_SCHEMA + '.diagnostics',
        exported: true,
        activeDeletedCount: rows.length,
        restoredExcluded: asArray(tombstones).filter(function (row) {
          return cleanString(row && row.recordKind) === 'folder' && !!cleanString(row && row.restoredAt);
        }).length,
        source: 'sync_tombstones-active-folder-rows',
        desktopAuthority: true,
        chromeAuthority: false,
        noChromeTombstoneApply: true,
        noChromeTombstoneCreate: true,
        noHardDelete: true,
        noChatDelete: true,
        noSnapshotDelete: true,
        noAssetDelete: true,
      },
    };
  }

  function desktopPurgedFolderSuppressionRowFromFolder(folder) {
    if (!folder || typeof folder !== 'object') return null;
    var meta = safeObject(folder.meta);
    if (meta.phase6aPermanentlyPurged !== true) return null;
    var folderId = cleanString(folder.folderId || folder.id);
    if (!folderId) return null;
    var folderName = cleanString(folder.name || folder.title || meta.name || meta.folderName || folderId);
    return {
      schema: DESKTOP_PURGED_FOLDER_SUPPRESSION_SCHEMA + '.row',
      folderId: folderId,
      id: folderId,
      folderName: folderName,
      name: folderName,
      purgedAt: cleanString(meta.phase6aPurgedAt || meta.purgedAt),
      purgeReason: cleanString(meta.phase6aPurgeReason || meta.purgeReason),
      purgeSource: cleanString(meta.phase6aPurgeSource || meta.purgeSource || 'desktop-recently-deleted-purge'),
      purgeTombstoneId: cleanString(meta.phase6aPurgeTombstoneId || meta.purgeTombstoneId),
      phase6aPermanentlyPurged: true,
      permanentlySuppressed: true,
      source: 'desktop-purged-folder-suppression',
      sourceKind: 'desktop-purged-folder-suppression',
      status: 'purged',
      desktopAuthority: true,
      chromeAuthority: false,
      noChromePurgeAuthority: true,
      noChromeTombstoneApply: true,
      noChromeTombstoneCreate: true,
      noHardDelete: true,
      noChatDelete: true,
      noSnapshotDelete: true,
      noAssetDelete: true,
    };
  }

  async function buildDesktopPurgedFolderSuppressionPayloadSafely(stores) {
    var api = stores && stores.folders;
    var base = {
      schema: DESKTOP_PURGED_FOLDER_SUPPRESSION_SCHEMA,
      source: 'desktop-purged-folder-suppression',
      status: 'exported',
      exportedAt: nowIso(),
      count: 0,
      folderIds: [],
      rows: [],
      diagnostics: {
        schema: DESKTOP_PURGED_FOLDER_SUPPRESSION_SCHEMA + '.diagnostics',
        exported: false,
        purgedSuppressedCount: 0,
        source: 'folders.phase6aPermanentlyPurged',
        desktopAuthority: true,
        chromeAuthority: false,
        noChromePurgeAuthority: true,
        noChromeTombstoneApply: true,
        noChromeTombstoneCreate: true,
        noHardDelete: true,
        noChatDelete: true,
        noSnapshotDelete: true,
        noAssetDelete: true,
        warnings: [],
      },
    };
    if (!api || typeof api.list !== 'function') {
      base.diagnostics.warnings.push({
        code: 'folder-purge-suppression-store-unavailable',
        warning: 'store.folders.list unavailable; exporting empty purge suppression projection',
      });
      return base;
    }
    try {
      var rows = (await listFromStore(api, {
        includeTombstoned: true,
        includeDeleted: true,
        includePurged: true,
        includePermanentlyPurged: true,
        limit: 5000,
      }))
        .map(desktopPurgedFolderSuppressionRowFromFolder)
        .filter(function (row) { return row && row.folderId; })
        .sort(function (a, b) {
          return cleanString(b.purgedAt).localeCompare(cleanString(a.purgedAt)) ||
            cleanString(a.folderName).localeCompare(cleanString(b.folderName));
        });
      base.rows = rows;
      base.count = rows.length;
      base.folderIds = rows.map(function (row) { return row.folderId; }).sort();
      base.diagnostics.exported = true;
      base.diagnostics.purgedSuppressedCount = rows.length;
      return base;
    } catch (e) {
      base.diagnostics.warnings.push({
        code: 'folder-purge-suppression-export-failed',
        warning: 'permanent folder suppression projection failed; exporting empty purge suppression projection',
        error: String((e && e.message) || e),
      });
      return base;
    }
  }

  function nonNegativeIntegerOrNull(value) {
    var number = Number(value);
    if (!Number.isFinite(number) || number < 0) return null;
    return Math.floor(number);
  }

  function readRestoreCount(meta, recoverySnapshot, keys, fallback) {
    var candidates = asArray(keys);
    for (var i = 0; i < candidates.length; i += 1) {
      var key = candidates[i];
      if (Object.prototype.hasOwnProperty.call(meta, key)) {
        var count = nonNegativeIntegerOrNull(meta[key]);
        if (count != null) return count;
      }
      if (Object.prototype.hasOwnProperty.call(recoverySnapshot, key)) {
        var recoveryCount = nonNegativeIntegerOrNull(recoverySnapshot[key]);
        if (recoveryCount != null) return recoveryCount;
      }
    }
    var fallbackCount = nonNegativeIntegerOrNull(fallback);
    return fallbackCount == null ? null : fallbackCount;
  }

  function folderRestoreReceiptId(tombstoneId) {
    return 'folder-restore-receipt:' + encodeURIComponent(cleanString(tombstoneId));
  }

  function folderRestoreReceiptFromTombstone(tombstone) {
    if (!tombstone || typeof tombstone !== 'object') return null;
    if (cleanString(tombstone.schema) !== TOMBSTONE_SCHEMA_VERSION) return null;
    if (cleanString(tombstone.recordKind) !== 'folder') return null;
    if (!cleanString(tombstone.restoredAt)) return null;

    var meta = safeObject(tombstone.meta);
    var recoverySnapshot = safeObject(meta.recoverySnapshot);
    var recoveryFolder = safeObject(recoverySnapshot.folder);
    var folderId = cleanString(recoveryFolder.folderId || recoveryFolder.id || folderIdFromTombstoneRecordId(tombstone.recordId));
    var tombstoneId = cleanString(tombstone.tombstoneId);
    if (!folderId || !tombstoneId) return null;

    var bindings = asArray(recoverySnapshot.bindings);
    var attemptedCount = readRestoreCount(meta, recoverySnapshot, [
      'bindingRestoreAttemptedCount',
      'lastBindingRestoreAttemptedCount',
    ], bindings.length);
    var restoredCount = readRestoreCount(meta, recoverySnapshot, [
      'bindingRestoredCount',
      'lastBindingRestoredCount',
    ], null);
    var skippedCount = readRestoreCount(meta, recoverySnapshot, [
      'bindingSkippedCount',
      'lastBindingSkippedCount',
    ], null);
    var restoreWarnings = asArray(meta.restoreWarnings).concat(asArray(meta.lastRestoreWarnings));

    return {
      schema: FOLDER_RESTORE_RECEIPT_SCHEMA,
      receiptId: folderRestoreReceiptId(tombstoneId),
      tombstoneId: tombstoneId,
      folderId: folderId,
      folderName: cleanString(recoveryFolder.name || recoveryFolder.title || meta.folderName),
      recordKind: 'folder',
      status: 'restored',
      decision: 'desktop-folder-restored',
      restoredAt: cleanString(tombstone.restoredAt),
      restoredBy: 'desktop-studio',
      restoredBySurface: 'desktop-studio',
      restoredBySyncPeerIdPresent: !!cleanString(tombstone.restoredBySyncPeerId),
      sourcePeerId: null,
      statusOnly: true,
      noTombstoneApply: true,
      noHardDelete: true,
      noChatDelete: true,
      bindingRestoreAttemptedCount: attemptedCount,
      bindingRestoredCount: restoredCount,
      bindingSkippedCount: skippedCount,
      restoreWarnings: restoreWarnings,
      chromeReShowDeferred: true,
      tombstonePropagation: 'deferred',
    };
  }

  function buildFolderRestoreReceiptPayloadFromTombstones(tombstones) {
    var rows = asArray(tombstones);
    var receipts = rows.map(folderRestoreReceiptFromTombstone).filter(function (receipt) {
      return receipt && typeof receipt === 'object' &&
        cleanString(receipt.schema) === FOLDER_RESTORE_RECEIPT_SCHEMA &&
        receipt.statusOnly === true &&
        receipt.noTombstoneApply === true;
    }).slice(0, FOLDER_RESTORE_RECEIPT_LIMIT);
    return {
      receipts: receipts,
      diagnostics: {
        supported: true,
        exported: true,
        schema: FOLDER_RESTORE_RECEIPT_SCHEMA,
        total: rows.filter(function (row) {
          return row && cleanString(row.recordKind) === 'folder' && !!cleanString(row.restoredAt);
        }).length,
        exportedCount: receipts.length,
        skippedMalformed: Math.max(0, rows.filter(function (row) {
          return row && cleanString(row.recordKind) === 'folder' && !!cleanString(row.restoredAt);
        }).length - receipts.length),
        statusOnly: true,
        noTombstoneApply: true,
        tombstonePropagation: 'deferred',
        chromeReShowDeferred: true,
        warnings: [],
      },
    };
  }

  function folderRestoreReceiptExportKey(receipt) {
    var r = safeObject(receipt);
    var requestId = cleanString(r.requestId || r.reviewId);
    if (requestId) return 'request:' + requestId;
    var folderId = cleanString(r.folderId);
    var tombstoneId = cleanString(r.tombstoneId);
    if (folderId && tombstoneId) return 'folder-tombstone:' + folderId + ':' + tombstoneId;
    if (folderId) return 'folder:' + folderId;
    return cleanString(r.receiptId);
  }

  function mergeFolderRestoreReceiptPayloads(primary, fallback) {
    var primaryRows = asArray(primary && primary.receipts);
    var fallbackRows = asArray(fallback && fallback.receipts);
    var seen = Object.create(null);
    var receipts = [];
    primaryRows.concat(fallbackRows).forEach(function (receipt) {
      if (!receipt || typeof receipt !== 'object') return;
      if (cleanString(receipt.schema) !== FOLDER_RESTORE_RECEIPT_SCHEMA) return;
      if (receipt.statusOnly !== true || receipt.noTombstoneApply !== true) return;
      var key = folderRestoreReceiptExportKey(receipt);
      if (!key || seen[key]) return;
      seen[key] = true;
      receipts.push(receipt);
    });
    return receipts.slice(0, FOLDER_RESTORE_RECEIPT_LIMIT);
  }

  async function buildFolderRestoreReceiptPayloadSafely(stores, tombstones) {
    var fallback = buildFolderRestoreReceiptPayloadFromTombstones(tombstones);
    var api = stores && stores.tombstoneReviews;
    if (!api || typeof api.listFolderRestoreReceipts !== 'function') {
      fallback.diagnostics = Object.assign({}, fallback.diagnostics || emptyFolderRestoreReceiptDiagnostics(), {
        requestReceiptSourceAvailable: false,
        requestReceiptCount: 0,
        tombstoneFallbackCount: asArray(fallback.receipts).length,
        warnings: asArray(fallback.diagnostics && fallback.diagnostics.warnings).concat([{
          code: 'folder-restore-receipt-review-store-unavailable',
          warning: 'store.tombstoneReviews.listFolderRestoreReceipts unavailable; using tombstone-derived folderRestoreReceipts fallback',
        }]),
      });
      return fallback;
    }
    try {
      var requestReceipts = await api.listFolderRestoreReceipts({
        limit: FOLDER_RESTORE_RECEIPT_LIMIT,
      });
      if (!Array.isArray(requestReceipts)) {
        fallback.diagnostics = Object.assign({}, fallback.diagnostics || emptyFolderRestoreReceiptDiagnostics(), {
          requestReceiptSourceAvailable: true,
          requestReceiptCount: 0,
          tombstoneFallbackCount: asArray(fallback.receipts).length,
          warnings: asArray(fallback.diagnostics && fallback.diagnostics.warnings).concat([{
            code: 'folder-restore-receipt-list-malformed',
            warning: 'store.tombstoneReviews.listFolderRestoreReceipts returned a non-array payload; using tombstone fallback',
          }]),
        });
        return fallback;
      }
      var projected = requestReceipts.filter(function (receipt) {
        return receipt && typeof receipt === 'object' &&
          cleanString(receipt.schema) === FOLDER_RESTORE_RECEIPT_SCHEMA &&
          receipt.statusOnly === true &&
          receipt.noTombstoneApply === true &&
          receipt.noChromeRestoreAuthority === true;
      });
      var merged = mergeFolderRestoreReceiptPayloads({ receipts: projected }, fallback);
      return {
        receipts: merged,
        diagnostics: {
          supported: true,
          exported: true,
          schema: FOLDER_RESTORE_RECEIPT_SCHEMA,
          total: requestReceipts.length + Number(fallback.diagnostics && fallback.diagnostics.total || 0),
          exportedCount: merged.length,
          requestReceiptSourceAvailable: true,
          requestReceiptCount: projected.length,
          tombstoneFallbackCount: asArray(fallback.receipts).length,
          skippedMalformed: Math.max(0, requestReceipts.length - projected.length),
          statusOnly: true,
          noTombstoneApply: true,
          noChromeRestoreAuthority: true,
          tombstonePropagation: 'deferred',
          chromeReShowDeferred: true,
          warnings: asArray(fallback.diagnostics && fallback.diagnostics.warnings),
        },
      };
    } catch (e) {
      fallback.diagnostics = Object.assign({}, fallback.diagnostics || emptyFolderRestoreReceiptDiagnostics(), {
        requestReceiptSourceAvailable: true,
        requestReceiptCount: 0,
        tombstoneFallbackCount: asArray(fallback.receipts).length,
        warnings: asArray(fallback.diagnostics && fallback.diagnostics.warnings).concat([{
          code: 'folder-restore-receipt-export-failed',
          warning: 'folder restore request receipt projection failed; using tombstone fallback',
          error: String((e && e.message) || e),
        }]),
      });
      return fallback;
    }
  }

  async function diagnoseFullBundleV2ReadonlyProjection() {
    var startedAt = Date.now();
    var warnings = [];
    var stores = getStores();
    var availability = storeAvailability(stores);
    var folderFallback = await readAvailableFolderStateFallback();
    var chatRows = [];
    try {
      chatRows = await listFromStore(stores.chats);
    } catch (eChats) {
      warnings.push({
        code: 'fullbundle-v2-readonly-chat-count-failed',
        warning: 'store.chats read failed while building read-only fullBundle.v2 projection diagnostic',
        error: String((eChats && eChats.message) || eChats),
      });
      chatRows = [];
    }
    var folderStateBuild = await buildFolderState(stores, {}, folderFallback.state);
    var folderState = folderStateBuild.state;
    var desktopCanonicalChatFolderBindings = await buildDesktopCanonicalChatFolderBindingProjection(stores, chatRows.length);
    var chatFolderBindingReceiptExport = await buildChatFolderBindingReceiptPayloadSafely(stores);

    var folderRows = asArray(folderState && folderState.folders).map(function (row) {
      return {
        id: cleanString(row && (row.id || row.folderId)),
        sortOrder: Math.floor(numberOrZero(row && row.sortOrder)),
        kind: cleanString(row && row.kind),
        source: cleanString(row && row.source),
        hasColor: !!cleanString(row && (row.color || row.iconColor)),
        hasIcon: !!cleanString(row && row.icon),
      };
    }).filter(function (row) { return !!row.id; }).sort(function (a, b) {
      return cleanString(a.id).localeCompare(cleanString(b.id));
    });

    var folderStateBindingRows = [];
    Object.keys(safeObject(folderState && folderState.items)).sort().forEach(function (folderId) {
      uniqStrings(folderState.items[folderId]).forEach(function (chatId) {
        folderStateBindingRows.push({
          chatId: cleanString(chatId),
          folderId: cleanString(folderId),
        });
      });
    });
    folderStateBindingRows.sort(function (a, b) {
      return cleanString(a.folderId).localeCompare(cleanString(b.folderId)) ||
        cleanString(a.chatId).localeCompare(cleanString(b.chatId));
    });

    var canonicalBindingRows = asArray(desktopCanonicalChatFolderBindings && desktopCanonicalChatFolderBindings.bindings).map(function (row) {
      return {
        chatId: cleanString(row && (row.chatId || row.conversationId)),
        folderId: cleanString(row && row.folderId),
        status: cleanString(row && (row.status || row.state || 'active')) || 'active',
      };
    }).filter(function (row) { return row.chatId && row.folderId; }).sort(function (a, b) {
      return cleanString(a.folderId).localeCompare(cleanString(b.folderId)) ||
        cleanString(a.chatId).localeCompare(cleanString(b.chatId));
    });
    var activeCanonicalBindingRows = canonicalBindingRows.filter(function (row) {
      return row.status === 'active' || row.status === 'bound';
    });

    var receiptRows = asArray(chatFolderBindingReceiptExport && chatFolderBindingReceiptExport.receipts).map(function (receipt) {
      return {
        schema: cleanString(receipt && receipt.schema),
        status: cleanString(receipt && receipt.status),
        reason: cleanString(receipt && receipt.reason),
        receiptHash: cleanString(receipt && (receipt.receiptHash || receipt.hash || receipt.requestHash || receipt.operationHash)),
        statusOnly: receipt && receipt.statusOnly === true,
      };
    }).sort(function (a, b) {
      return stableProjectionStringify(a).localeCompare(stableProjectionStringify(b));
    });

    return {
      schema: 'h2o.studio.fullBundle.v2.readonly-projection-diagnostic.v1',
      fullBundleSchema: FULL_BUNDLE_SCHEMA,
      surface: 'desktop-tauri',
      status: 'read-only-projection-ready',
      ok: true,
      readOnlyProjection: true,
      writesData: false,
      writesFiles: false,
      writesTransport: false,
      mutatesExportState: false,
      noExportFullBundleCall: true,
      noExportLatestSyncBundleCall: true,
      noSequenceMutation: true,
      noExportIdMutation: true,
      noWebdavWrite: true,
      noCloudWrite: true,
      noRelayWrite: true,
      noCasWrite: true,
      productSyncReady: false,
      storeAvailability: availability,
      folderProjection: {
        schema: FOLDER_STATE_KEY,
        count: folderRows.length,
        hash: await projectionSha256(folderRows),
        readOnlyProjection: true,
      },
      folderStateBindingProjection: {
        schema: FOLDER_STATE_KEY + '.items',
        count: folderStateBindingRows.length,
        hash: await projectionSha256(folderStateBindingRows),
        readOnlyProjection: true,
      },
      canonicalChatFolderBindingProjection: {
        schema: DESKTOP_CANONICAL_CHAT_FOLDER_BINDING_SCHEMA,
        count: canonicalBindingRows.length,
        hash: await projectionSha256(canonicalBindingRows),
        activeCount: activeCanonicalBindingRows.length,
        activeHash: await projectionSha256(activeCanonicalBindingRows),
        readOnlyProjection: true,
        diagnostics: safeObject(desktopCanonicalChatFolderBindings && desktopCanonicalChatFolderBindings.diagnostics),
      },
      chatFolderBindingReceiptProjection: {
        schema: CHAT_FOLDER_BINDING_RECEIPT_SCHEMA,
        count: receiptRows.length,
        hash: await projectionSha256(receiptRows),
        readOnlyProjection: true,
        diagnostics: safeObject(chatFolderBindingReceiptExport && chatFolderBindingReceiptExport.diagnostics),
      },
      folderFallback: {
        available: !!(folderFallback && (folderFallback.folderCount || folderFallback.bindingCount)),
        source: cleanString(folderFallback && folderFallback.source),
        folderCount: Number(folderFallback && folderFallback.folderCount) || 0,
        bindingCount: Number(folderFallback && folderFallback.bindingCount) || 0,
      },
      diagnostics: {
        durationMs: Date.now() - startedAt,
        folderSource: safeObject(folderStateBuild && folderStateBuild.diagnostics),
        warnings: warnings,
      },
    };
  }

  async function exportFullBundle(options) {
    var startedAt = Date.now();
    var warnings = [];
    var stores = getStores();
    var availability = storeAvailability(stores);
    if (!availability.chats) throw new Error('Desktop export unavailable: store.chats missing');
    if (!availability.snapshots) warnings.push({ kind: 'store', warning: 'store.snapshots unavailable; exporting chat records without snapshots' });

    var folderFallback = await readAvailableFolderStateFallback();
    var collected = await buildChatArchive(stores, warnings, folderFallback.state);
    var folderStateBuild = await buildFolderState(stores, collected.folderItems, folderFallback.state);
    var folderState = folderStateBuild.state;
    var desktopCanonicalChatFolderBindings = await buildDesktopCanonicalChatFolderBindingProjection(stores, collected.archive.chatCount);
    var desktopCanonicalLibraryMetadata = await buildDesktopCanonicalLibraryMetadataProjectionSafely();
    folderState.desktopCanonicalChatFolderBindings = desktopCanonicalChatFolderBindings;
    var folderParity = buildFolderParityDiagnostics(folderState, collected.archive);
    var chromeStorageLocal = {};
    chromeStorageLocal[FOLDER_STATE_KEY] = folderState;
    var libraryKv = buildLibraryKv(collected.labelBindings);
    var manifest = getManifestInfo();
    var chatArchive = collected.archive;
    var snapshotCount = collected.diagnostics.snapshotCount;
    var tombstoneExport = await buildTombstoneExportPayloadSafely(stores);
    var tombstoneDiagnostics = tombstoneExport.diagnostics || emptyTombstoneExportDiagnostics();
    var folderDeleteReceiptExport = await buildFolderDeleteReceiptPayloadSafely(stores);
    var folderDeleteReceiptDiagnostics = folderDeleteReceiptExport.diagnostics || emptyFolderDeleteReceiptDiagnostics();
    var folderRestoreReceiptExport = await buildFolderRestoreReceiptPayloadSafely(stores, tombstoneExport.tombstones);
    var folderRestoreReceiptDiagnostics = folderRestoreReceiptExport.diagnostics || emptyFolderRestoreReceiptDiagnostics();
    var chatFolderBindingReceiptExport = await buildChatFolderBindingReceiptPayloadSafely(stores);
    var chatFolderBindingReceiptDiagnostics = chatFolderBindingReceiptExport.diagnostics || emptyChatFolderBindingReceiptDiagnostics();
    var libraryMetadataMutationReceiptExport = await buildLibraryMetadataMutationReceiptPayloadSafely();
    var libraryMetadataMutationReceiptDiagnostics = libraryMetadataMutationReceiptExport.diagnostics || emptyLibraryMetadataMutationReceiptDiagnostics();
    var desktopCanonicalRecentlyDeleted = buildDesktopCanonicalRecentlyDeletedPayloadFromTombstones(tombstoneExport.tombstones);
    var desktopPurgedFolderSuppression = await buildDesktopPurgedFolderSuppressionPayloadSafely(stores);
    var syncApplyEvents = await buildApplyEventsPayloadSafely();
    var summary = {
      chatCount: chatArchive.chatCount,
      snapshotCount: snapshotCount,
      turnCount: collected.diagnostics.turnCount,
      categoryCount: asArray(chatArchive.catalogs && chatArchive.catalogs.categories).length,
      labelCount: asArray(chatArchive.catalogs && chatArchive.catalogs.labels).length,
      folderCount: asArray(folderState.folders).length,
      folderBindingCount: Object.keys(folderState.items || {}).reduce(function (sum, folderId) {
        return sum + asArray(folderState.items[folderId]).length;
      }, 0),
      labelBindingChatCount: Object.keys(collected.labelBindings || {}).length,
      chromeStorageKeyCount: Object.keys(chromeStorageLocal).length,
      libraryKvKeyCount: libraryKv.length,
      linkedOnlyCount: collected.diagnostics.linkedOnlyCount,
      noMessageSnapshotCount: collected.diagnostics.noMessageSnapshotCount,
      tombstoneCount: Number(tombstoneDiagnostics.total) || 0,
      activeTombstoneCount: Number(tombstoneDiagnostics.active) || 0,
      restoredTombstoneCount: Number(tombstoneDiagnostics.restored) || 0,
      folderDeleteReceiptCount: asArray(folderDeleteReceiptExport.receipts).length,
      folderRestoreReceiptCount: asArray(folderRestoreReceiptExport.receipts).length,
      chatFolderBindingReceiptCount: asArray(chatFolderBindingReceiptExport.receipts).length,
      libraryMetadataMutationReceiptCount: asArray(libraryMetadataMutationReceiptExport.receipts).length,
      desktopCanonicalRecentlyDeletedCount: Number(desktopCanonicalRecentlyDeleted.count) || 0,
      desktopPurgedFolderSuppressionCount: Number(desktopPurgedFolderSuppression.count) || 0,
      desktopCanonicalChatFolderBindingCount: Number(desktopCanonicalChatFolderBindings.bindingCount) || 0,
      desktopCanonicalMetadataLabelCount: Number(desktopCanonicalLibraryMetadata && desktopCanonicalLibraryMetadata.counts && desktopCanonicalLibraryMetadata.counts.labelCatalogCount) || 0,
      desktopCanonicalMetadataTagCount: Number(desktopCanonicalLibraryMetadata && desktopCanonicalLibraryMetadata.counts && desktopCanonicalLibraryMetadata.counts.tagCatalogCount) || 0,
      desktopCanonicalMetadataCategoryCount: Number(desktopCanonicalLibraryMetadata && desktopCanonicalLibraryMetadata.counts && desktopCanonicalLibraryMetadata.counts.categoryCatalogCount) || 0,
      desktopCanonicalMetadataChatCategoryAssignmentCount: Number(desktopCanonicalLibraryMetadata && desktopCanonicalLibraryMetadata.counts && desktopCanonicalLibraryMetadata.counts.chatCategoryAssignmentCount) || 0,
      applyEventCount: Number(syncApplyEvents.total) || 0,
    };
    var bundle = {
      schema: FULL_BUNDLE_SCHEMA,
      exportedAt: nowIso(),
      exportedFromExtensionId: manifest.id,
      exportedFromExtensionName: manifest.name,
      exportedFromVersion: manifest.version,
      exportedFromSurface: 'desktop-tauri',
      chatArchive: chatArchive,
      chromeStorageLocal: chromeStorageLocal,
      libraryKv: libraryKv,
      tombstoneSchemaVersion: TOMBSTONE_SCHEMA_VERSION,
      tombstones: asArray(tombstoneExport.tombstones),
      desktopCanonicalRecentlyDeletedFolders: asArray(desktopCanonicalRecentlyDeleted.rows),
      desktopCanonicalRecentlyDeleted: desktopCanonicalRecentlyDeleted,
      desktopPurgedFolderSuppressions: asArray(desktopPurgedFolderSuppression.rows),
      desktopPurgedFolderSuppression: desktopPurgedFolderSuppression,
      chatFolderBindings: asArray(desktopCanonicalChatFolderBindings.bindings),
      desktopCanonicalChatFolderBindings: desktopCanonicalChatFolderBindings,
      desktopCanonicalLibraryMetadata: desktopCanonicalLibraryMetadata,
      folderDeleteReceipts: asArray(folderDeleteReceiptExport.receipts),
      folderRestoreReceipts: asArray(folderRestoreReceiptExport.receipts),
      chatFolderBindingReceipts: asArray(chatFolderBindingReceiptExport.receipts),
      libraryMetadataMutationReceipts: asArray(libraryMetadataMutationReceiptExport.receipts),
      syncApplyEvents: syncApplyEvents,
      diagnostics: {
        desktopExport: {
          ok: true,
          exporterVersion: EXPORTER_VERSION,
          durationMs: Date.now() - startedAt,
          storeAvailability: availability,
          folderParity: folderParity,
          folderSource: folderStateBuild.diagnostics,
          folderFallback: {
            available: !!(folderFallback && (folderFallback.folderCount || folderFallback.bindingCount)),
            source: cleanString(folderFallback && folderFallback.source),
            folderCount: Number(folderFallback && folderFallback.folderCount) || 0,
            bindingCount: Number(folderFallback && folderFallback.bindingCount) || 0,
          },
          tombstones: tombstoneDiagnostics,
          desktopCanonicalRecentlyDeleted: desktopCanonicalRecentlyDeleted.diagnostics,
          desktopPurgedFolderSuppression: desktopPurgedFolderSuppression.diagnostics,
          chatFolderBindings: desktopCanonicalChatFolderBindings.diagnostics,
          libraryMetadata: safeObject(desktopCanonicalLibraryMetadata && desktopCanonicalLibraryMetadata.diagnostics),
          folderDeleteReceipts: folderDeleteReceiptDiagnostics,
          folderRestoreReceipts: folderRestoreReceiptDiagnostics,
          chatFolderBindingReceipts: chatFolderBindingReceiptDiagnostics,
          libraryMetadataMutationReceipts: libraryMetadataMutationReceiptDiagnostics,
          applyEvents: {
            schema: cleanString(syncApplyEvents.schema) || APPLY_EVENTS_SCHEMA_VERSION,
            available: syncApplyEvents.available === true,
            total: Number(syncApplyEvents.total) || 0,
            capped: syncApplyEvents.capped === true,
            limit: Number(syncApplyEvents.limit) || APPLY_EVENT_LIMIT,
            skippedMalformed: Number(syncApplyEvents.skippedMalformed) || 0,
            exported: asArray(syncApplyEvents.events).length,
            warnings: asArray(syncApplyEvents.warnings),
          },
          warnings: warnings,
          options: safeObject(options),
        },
        chromeStorageError: null,
        libraryKvError: null,
      },
      summary: summary,
    };
    /* F3 (identity-only stamps). Pulled from F2's H2O.Studio.identity if
     * available. Does NOT mint exportId / sequenceNumber / previousExportId /
     * contentSha256 — those are reserved for exportLatestSyncBundle (the
     * disk-writing path). exportFullBundle must not look like a real export
     * event. */
    bundle.exportSchemaVersion = EXPORT_SCHEMA_VERSION;
    var identity = await readIdentitySafely();
    if (identity) {
      bundle.sourceSyncPeerId  = cleanString(identity.syncPeerId);
      bundle.sourceSurfaceKind = cleanString(identity.surfaceKind);
      bundle.sourceAppKind     = cleanString(identity.appKind);
      bundle.sourceStoreKind   = cleanString(identity.storeKind);

      /* F10.3d — F2 redacted peer envelope for the F10.2 cross-platform
       * envelope contract. The bundle carries sha256 hashes only; the
       * raw `identity.installId` and `identity.physicalDeviceId` UUIDs
       * are NEVER written to latest.json.
       *
       * `bundle.sourceSyncPeerId` above is preserved unchanged as a
       * legacy-compatibility field for existing consumers; it is NOT a
       * newly approved privacy architecture, and new consumers should
       * prefer `bundle.sourcePeerEnvelope` instead.
       *
       * The envelope is omitted (not partially populated) when any
       * sha256 computation fails — keeping the format-gate semantics
       * crisp on the consumer side ("absent" vs "malformed"). */
      var sourcePhysicalDeviceIdHash = await sha256Hex(cleanString(identity.physicalDeviceId));
      var sourceInstallIdHash        = await sha256Hex(cleanString(identity.installId));
      var sourceSyncPeerIdHash       = await sha256Hex(cleanString(identity.syncPeerId));
      if (sourcePhysicalDeviceIdHash && sourceInstallIdHash && sourceSyncPeerIdHash) {
        bundle.sourcePeerEnvelope = {
          physicalDeviceIdHash: sourcePhysicalDeviceIdHash,
          installIdHash:        sourceInstallIdHash,
          syncPeerIdHash:       sourceSyncPeerIdHash,
          surfaceKind:          cleanString(identity.surfaceKind),
        };
      }
    }
    state.lastExportAt = Date.now();
    state.lastSummary = summary;
    state.lastFolderParity = folderParity;
    state.lastWarnings = warnings.slice();
    state.lastError = null;
    return bundle;
  }

  /*
   * O1-T19. The legacy/manual sync-bundle exporter writes P01 publication bytes
   * to the sync folder, so it is a P01 mutation seam like any other - and being
   * user-initiated is precisely why it needs the check rather than exempting it
   * from one. A gesture does not change which generation owns the data.
   */
  async function generationPermitsP01Mutation() {
    var root = (typeof globalThis !== 'undefined' ? globalThis : this);
    var gate = root.H2O && root.H2O.Studio && root.H2O.Studio.sync &&
      root.H2O.Studio.sync.writerGeneration;
    if (!gate || typeof gate.p01MayMutate !== 'function') {
      /*
       * No gate surface at all: a pre-T19 runtime, and the compatibility
       * position is that P01 behaves exactly as it did before. This is a
       * statement about the BUILD, not the store - once a gate is installed
       * its observation governs, and an unreadable STORE still refuses.
       */
      return { permitted: true, reason: null };
    }
    try { return await gate.p01MayMutate(); }
    catch (_) { return { permitted: false, reason: 'generation-unobserved' }; }
  }

  async function exportLatestSyncBundle(options) {
    var startedAt = Date.now();
    var generation = await generationPermitsP01Mutation();
    if (generation.permitted !== true) {
      return {
        ok: false,
        reason: generation.reason || 'p01-writer-stood-down',
        generation: generation.generation || null,
        startedAt: startedAt
      };
    }
    try {
      var baseDir = getHomeBaseDir();
      var bundle = await exportFullBundle(Object.assign({}, safeObject(options), {
        syncLatest: true,
        syncFolderName: SYNC_FOLDER_NAME,
      }));
      var exportedAt = cleanString(bundle && bundle.exportedAt) || nowIso();

      /* F3 — disk-writing exporter mints the per-export event tuple and
       * stamps it on the envelope. Order is:
       *   1. recordExport() persists the log (sequence consumed BEFORE file
       *      write; if the file write later fails the sequence is "burned"
       *      and gaps are tolerated).
       *   2. Patch bundle with exportId / sequenceNumber / previousExportId.
       *   3. Compute contentSha256 over the bundle WITHOUT the contentSha256
       *      field (so consumers can verify by stripping it back out).
       *   4. Patch bundle.contentSha256.
       * If H2O.Studio.exportLog is unavailable, F3 stamping is skipped
       * cleanly and the existing pre-F3 envelope shape is written. */
      var syncPeerIdForEvent = cleanString(bundle && bundle.sourceSyncPeerId);
      var outboundDisplayPath = syncDisplayPath(SYNC_LATEST_FILE);
      var exportEvent = await recordExportEventSafely(syncPeerIdForEvent, outboundDisplayPath);
      if (exportEvent) {
        bundle.exportId         = exportEvent.exportId;
        bundle.sequenceNumber   = exportEvent.sequenceNumber;
        bundle.previousExportId = exportEvent.previousExportId;
        /* contentSha256 = SHA-256 of canonical bundle JSON minus the
         * contentSha256 field itself. Consumers verify by stripping the
         * field, serializing with JSON.stringify(bundle, null, 2) + '\n',
         * hashing, and comparing. */
        var preimageText = JSON.stringify(bundle, null, 2) + '\n';
        var contentHex   = await sha256Hex(preimageText);
        bundle.contentSha256 = contentHex ? ('sha256:' + contentHex) : '';
      }

      var text = JSON.stringify(bundle, null, 2) + '\n';
      var checksumHex = await sha256Hex(text);
      var checksum = checksumHex ? ('sha256:' + checksumHex) : '';
      var tmpPath = joinSyncPath(SYNC_TMP_FILE);
      var latestPath = joinSyncPath(SYNC_LATEST_FILE);
      var folderOptions = { baseDir: baseDir, recursive: true };
      var fileOptions = { baseDir: baseDir, create: true, truncate: true };
      var renameOptions = { oldPathBaseDir: baseDir, newPathBaseDir: baseDir };

      await fsMkdir(SYNC_FOLDER_NAME, folderOptions);
      await fsWriteTextFile(tmpPath, text, fileOptions);
      await fsRename(tmpPath, latestPath, renameOptions);

      var peerTransport = await writePeerTransportMirrorSafely({
        syncPeerId: cleanString(bundle && bundle.sourceSyncPeerId),
        latestText: text,
        bundle: bundle,
        exporterVersion: EXPORTER_VERSION,
        exportSchemaVersion: cleanString(bundle && bundle.exportSchemaVersion),
        exportedAt: exportedAt,
        exportId: cleanString(bundle && bundle.exportId),
        sequenceNumber: (bundle && typeof bundle.sequenceNumber === 'number') ? bundle.sequenceNumber : null,
        previousExportId: bundle && bundle.previousExportId ? cleanString(bundle.previousExportId) : null,
        contentSha256: cleanString(bundle && bundle.contentSha256),
        surfaceKind: cleanString(bundle && bundle.sourceSurfaceKind),
        appKind: cleanString(bundle && bundle.sourceAppKind),
        storeKind: cleanString(bundle && bundle.sourceStoreKind),
      });
      var peerWarning = peerTransportWarning(peerTransport);
      if (peerWarning) state.lastWarnings = state.lastWarnings.concat([peerWarning]);

      var result = {
        ok: true,
        phase: 'R2A-1',
        mode: 'manual-stable-sync-folder-export',
        path: syncDisplayPath(SYNC_LATEST_FILE),
        tmpPath: syncDisplayPath(SYNC_TMP_FILE),
        tempPath: syncDisplayPath(SYNC_TMP_FILE),
        bytes: byteLengthOf(text),
        exportedAt: exportedAt,
        chatCount: Number(bundle && bundle.summary && bundle.summary.chatCount) || 0,
        snapshotCount: Number(bundle && bundle.summary && bundle.summary.snapshotCount) || 0,
        turnCount: Number(bundle && bundle.summary && bundle.summary.turnCount) || 0,
        linkedOnlyCount: Number(bundle && bundle.summary && bundle.summary.linkedOnlyCount) || 0,
        folderDeleteReceiptCount: Number(bundle && bundle.summary && bundle.summary.folderDeleteReceiptCount) || 0,
        folderRestoreReceiptCount: Number(bundle && bundle.summary && bundle.summary.folderRestoreReceiptCount) || 0,
        chatFolderBindingReceiptCount: Number(bundle && bundle.summary && bundle.summary.chatFolderBindingReceiptCount) || 0,
        libraryMetadataMutationReceiptCount: Number(bundle && bundle.summary && bundle.summary.libraryMetadataMutationReceiptCount) || 0,
        chatFolderBindingExport: {
          schema: DESKTOP_CANONICAL_CHAT_FOLDER_BINDING_SCHEMA,
          bindingCount: Number(bundle && bundle.summary && bundle.summary.desktopCanonicalChatFolderBindingCount) || 0,
          folderBindingCounts: safeObject(bundle && bundle.desktopCanonicalChatFolderBindings && bundle.desktopCanonicalChatFolderBindings.folderBindingCounts),
          unfiledCount: Object.prototype.hasOwnProperty.call(safeObject(bundle && bundle.desktopCanonicalChatFolderBindings), 'unfiledCount')
            ? bundle.desktopCanonicalChatFolderBindings.unfiledCount
            : null,
          missingFolderBindingCount: Number(bundle && bundle.desktopCanonicalChatFolderBindings && bundle.desktopCanonicalChatFolderBindings.missingFolderBindingCount) || 0,
          deletedFolderBindingCount: Number(bundle && bundle.desktopCanonicalChatFolderBindings && bundle.desktopCanonicalChatFolderBindings.deletedFolderBindingCount) || 0,
          fallbackUnfiledBindingCount: Number(bundle && bundle.desktopCanonicalChatFolderBindings && bundle.desktopCanonicalChatFolderBindings.fallbackUnfiledBindingCount) || 0,
          activeDanglingFolderBindingCount: Number(bundle && bundle.desktopCanonicalChatFolderBindings && bundle.desktopCanonicalChatFolderBindings.activeDanglingFolderBindingCount) || 0,
          activeDeletedFolderBindingExportedAsActive: bundle && bundle.desktopCanonicalChatFolderBindings
            ? bundle.desktopCanonicalChatFolderBindings.activeDeletedFolderBindingExportedAsActive === true
            : false,
          deletedFolderBindingsExcludedFromActiveProjection: bundle && bundle.desktopCanonicalChatFolderBindings
            ? bundle.desktopCanonicalChatFolderBindings.deletedFolderBindingsExcludedFromActiveProjection !== false
            : true,
          restoredFolderBindingCount: Number(bundle && bundle.desktopCanonicalChatFolderBindings && bundle.desktopCanonicalChatFolderBindings.restoredFolderBindingCount) || 0,
          blockers: asArray(bundle && bundle.desktopCanonicalChatFolderBindings && bundle.desktopCanonicalChatFolderBindings.diagnostics && bundle.desktopCanonicalChatFolderBindings.diagnostics.blockers),
          warnings: asArray(bundle && bundle.desktopCanonicalChatFolderBindings && bundle.desktopCanonicalChatFolderBindings.diagnostics && bundle.desktopCanonicalChatFolderBindings.diagnostics.warnings),
          desktopAuthority: true,
          chromeAuthority: false,
          readOnlyProjection: true,
          noChromeDestructiveBindingApply: true,
          noHardDelete: true,
          noPurge: true,
          noChatDelete: true,
          noSnapshotDelete: true,
          noAssetDelete: true,
        },
        libraryMetadataExport: {
          schema: DESKTOP_CANONICAL_LIBRARY_METADATA_SCHEMA,
          labelCatalogCount: Number(bundle && bundle.summary && bundle.summary.desktopCanonicalMetadataLabelCount) || 0,
          tagCatalogCount: Number(bundle && bundle.summary && bundle.summary.desktopCanonicalMetadataTagCount) || 0,
          categoryCatalogCount: Number(bundle && bundle.summary && bundle.summary.desktopCanonicalMetadataCategoryCount) || 0,
          chatCategoryAssignmentCount: Number(bundle && bundle.summary && bundle.summary.desktopCanonicalMetadataChatCategoryAssignmentCount) || 0,
          hashes: safeObject(bundle && bundle.desktopCanonicalLibraryMetadata && bundle.desktopCanonicalLibraryMetadata.hashes),
          warnings: asArray(bundle && bundle.desktopCanonicalLibraryMetadata &&
            bundle.desktopCanonicalLibraryMetadata.diagnostics &&
            bundle.desktopCanonicalLibraryMetadata.diagnostics.warnings),
          productSyncReady: false,
          desktopAuthority: true,
          chromeAuthority: false,
          readOnlyProjection: true,
          chromeImportDisplayParityImplemented: false,
          chromeRequestExportImplemented: false,
          desktopApplyImplemented: false,
          noHardDelete: true,
          noPurge: true,
          noChatDelete: true,
          noSnapshotDelete: true,
          noAssetDelete: true,
        },
        chatFolderBindingReceiptExport: {
          schema: CHAT_FOLDER_BINDING_RECEIPT_SCHEMA,
          receiptCount: asArray(bundle && bundle.chatFolderBindingReceipts).length,
          exportedCount: Number(bundle && bundle.diagnostics && bundle.diagnostics.desktopExport &&
            bundle.diagnostics.desktopExport.chatFolderBindingReceipts &&
            bundle.diagnostics.desktopExport.chatFolderBindingReceipts.exportedCount) || 0,
          noChromeBindingAuthority: true,
          noChromeDestructiveBindingApply: true,
          noHardDelete: true,
          noPurge: true,
          noChatDelete: true,
          noSnapshotDelete: true,
          noAssetDelete: true,
        },
        libraryMetadataMutationReceiptExport: {
          schema: LIBRARY_METADATA_MUTATION_RECEIPT_SCHEMA,
          receiptCount: asArray(bundle && bundle.libraryMetadataMutationReceipts).length,
          exportedCount: Number(bundle && bundle.diagnostics && bundle.diagnostics.desktopExport &&
            bundle.diagnostics.desktopExport.libraryMetadataMutationReceipts &&
            bundle.diagnostics.desktopExport.libraryMetadataMutationReceipts.exportedCount) || 0,
          desktopAuthority: true,
          chromeAuthority: false,
          noChromeCanonicalMutation: true,
          noDesktopCanonicalMutationFromChrome: true,
          noHardDelete: true,
          noPurge: true,
          noChatDelete: true,
          noSnapshotDelete: true,
          noAssetDelete: true,
          noLabelDelete: true,
          noTagDelete: true,
          noCategoryDelete: true,
          noMetadataDelete: true,
          productSyncReady: false,
        },
        folderRestoreReceiptExport: {
          schema: FOLDER_RESTORE_RECEIPT_SCHEMA,
          receiptCount: asArray(bundle && bundle.folderRestoreReceipts).length,
          requestReceiptCount: Number(bundle && bundle.diagnostics && bundle.diagnostics.desktopExport &&
            bundle.diagnostics.desktopExport.folderRestoreReceipts &&
            bundle.diagnostics.desktopExport.folderRestoreReceipts.requestReceiptCount) || 0,
          tombstoneFallbackCount: Number(bundle && bundle.diagnostics && bundle.diagnostics.desktopExport &&
            bundle.diagnostics.desktopExport.folderRestoreReceipts &&
            bundle.diagnostics.desktopExport.folderRestoreReceipts.tombstoneFallbackCount) || 0,
          noChromeRestoreAuthority: true,
          noTombstoneApply: true,
          noHardDelete: true,
          noChatDelete: true,
          noSnapshotDelete: true,
          noAssetDelete: true,
        },
        applyEventCount: Number(bundle && bundle.summary && bundle.summary.applyEventCount) || 0,
        applyEventExportedCount: asArray(bundle && bundle.syncApplyEvents && bundle.syncApplyEvents.events).length,
        checksum: checksum,
        peerTransport: peerTransport,
        peerTransportWarning: peerWarning,
        sourceDeviceId: cleanString(bundle && bundle.exportedFromExtensionId) || 'desktop-tauri',
        schema: FULL_BUNDLE_SCHEMA,
        chatArchiveSchema: CHAT_ARCHIVE_SCHEMA,
        /* F3 — additive diagnostic fields. Null/'' when the export-log was
         * unavailable and stamping was skipped. */
        exportSchemaVersion: cleanString(bundle && bundle.exportSchemaVersion),
        exportId: cleanString(bundle && bundle.exportId),
        sequenceNumber: (bundle && typeof bundle.sequenceNumber === 'number') ? bundle.sequenceNumber : null,
        previousExportId: bundle && bundle.previousExportId ? cleanString(bundle.previousExportId) : null,
        contentSha256: cleanString(bundle && bundle.contentSha256),
        sourceSyncPeerId: cleanString(bundle && bundle.sourceSyncPeerId),
        sourceSurfaceKind: cleanString(bundle && bundle.sourceSurfaceKind),
        sourceAppKind: cleanString(bundle && bundle.sourceAppKind),
        sourceStoreKind: cleanString(bundle && bundle.sourceStoreKind),
        atomicWrite: true,
        pathResolution: 'tauri-base-directory-home',
        autoRunOnBoot: false,
        autoRunOnDataChange: false,
        chromeAutoImport: false,
        durationMs: Date.now() - startedAt,
        status: 'latest-sync-bundle-written',
      };
      state.lastSyncExport = result;
      state.lastError = null;
      return result;
    } catch (error) {
      var failure = {
        ok: false,
        phase: 'R2A-1',
        mode: 'manual-stable-sync-folder-export',
        path: syncDisplayPath(SYNC_LATEST_FILE),
        tmpPath: syncDisplayPath(SYNC_TMP_FILE),
        tempPath: syncDisplayPath(SYNC_TMP_FILE),
        error: String(error && (error.message || error)),
        status: 'latest-sync-bundle-write-failed',
        atomicWrite: true,
        pathResolution: 'tauri-base-directory-home',
        autoRunOnBoot: false,
        autoRunOnDataChange: false,
        chromeAutoImport: false,
        durationMs: Date.now() - startedAt,
      };
      state.lastSyncExport = failure;
      state.lastError = failure.error;
      return failure;
    }
  }

  function diagnose() {
    var stores = getStores();
    return {
      installed: true,
      surface: 'desktop-tauri',
      schema: FULL_BUNDLE_SCHEMA,
      chatArchiveSchema: CHAT_ARCHIVE_SCHEMA,
      exporterVersion: EXPORTER_VERSION,
      readOnly: true,
      writesData: false,
      syncLatest: {
        api: 'H2O.Studio.ingestion.exportLatestSyncBundle',
        folderName: SYNC_FOLDER_NAME,
        fileName: SYNC_LATEST_FILE,
        path: syncDisplayPath(SYNC_LATEST_FILE),
        atomicWrite: true,
        autoRunOnBoot: false,
        autoRunOnDataChange: false,
        chromeAutoImport: false,
        writesSyncFile: true,
        peerTransport: {
          api: 'H2O.Studio.sync.peerTransport.writeLatestMirror',
          transportVersion: PEER_TRANSPORT_VERSION,
          stateSchema: PEER_STATE_SCHEMA,
          safePeerDirRule: 'encodeURIComponent(syncPeerId)',
          pathTemplate: syncDisplayPath('devices/<safePeerDir>/' + SYNC_LATEST_FILE),
          rootLatestRemainsCanonical: true,
          writesDevicesOnlyAfterRootCommit: true,
          lastResult: state.lastSyncExport && state.lastSyncExport.peerTransport ? state.lastSyncExport.peerTransport : null,
        },
        lastResult: state.lastSyncExport,
      },
      storeAvailability: storeAvailability(stores),
      lastExportAt: state.lastExportAt,
      lastSyncExport: state.lastSyncExport,
      lastSummary: state.lastSummary,
      lastFolderParity: state.lastFolderParity,
      lastWarnings: state.lastWarnings.slice(),
      lastError: state.lastError,
    };
  }

  var previous = H2O.Studio.ingestion;
  H2O.Studio.ingestion = Object.assign({}, previous, {
    __installed: true,
    exportFullBundle: function (options) {
      return exportFullBundle(options).catch(function (error) {
        state.lastError = String(error && (error.stack || error.message || error));
        throw error;
      });
    },
    exportLatestSyncBundle: exportLatestSyncBundle,
    diagnoseExportBundle: diagnose,
    diagnoseFullBundleV2ReadonlyProjection: function () {
      return diagnoseFullBundleV2ReadonlyProjection().catch(function (error) {
        return {
          schema: 'h2o.studio.fullBundle.v2.readonly-projection-diagnostic.v1',
          fullBundleSchema: FULL_BUNDLE_SCHEMA,
          surface: 'desktop-tauri',
          status: 'read-only-projection-failed',
          ok: false,
          readOnlyProjection: true,
          writesData: false,
          writesFiles: false,
          writesTransport: false,
          mutatesExportState: false,
          noExportFullBundleCall: true,
          noExportLatestSyncBundleCall: true,
          productSyncReady: false,
          error: String(error && (error.stack || error.message || error)),
        };
      });
    },
    diagnose: function () {
      var base = {};
      if (previous && typeof previous.diagnose === 'function') {
        try { base = previous.diagnose() || {}; }
        catch (_) { base = {}; }
      }
      base.exporter = diagnose();
      return base;
    },
  });
})(typeof window !== 'undefined' ? window : globalThis);
