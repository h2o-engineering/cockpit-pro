import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const indexPath = path.join(root, 'src-surfaces-base/studio/S0F1c. 🎬 Library Index - Studio.js');
let src = fs.readFileSync(indexPath, 'utf8');

function replaceOnce(before, after, label) {
  const first = src.indexOf(before);
  if (first === -1) throw new Error(`AC04 transform missing anchor: ${label}`);
  if (src.indexOf(before, first + before.length) !== -1) throw new Error(`AC04 transform ambiguous anchor: ${label}`);
  src = src.slice(0, first) + after + src.slice(first + before.length);
}

replaceOnce(
  "    lastRowsSignature: '',\n    lastRowsSignatureBefore: '',",
  "    lastRowsSignature: '',\n    // STAB-P0 AC04: semantic signature for the Desktop Folder catalog. This is\n    // intentionally separate from the chat-row signature so an empty-folder\n    // create/rename can wake the existing Library fan-out without pretending\n    // that chat rows changed.\n    lastFolderCatalogSignature: '',\n    lastRowsSignatureBefore: '',",
  'state.lastFolderCatalogSignature'
);

const rowsSignatureAnchor = `  function rowsSignature(rows) {
    const list = (Array.isArray(rows) ? rows : [])
      .map(canonicalRowForSignature)
      .sort((a, b) => String(a.chatId || '').localeCompare(String(b.chatId || ''))
        || String(a.snapshotId || '').localeCompare(String(b.snapshotId || '')));
    return JSON.stringify(list);
  }

`;
const folderSignatureHelpers = `  function canonicalFolderForSignature(row) {
    const r = row && typeof row === 'object' ? row : {};
    const meta = r.meta && typeof r.meta === 'object' && !Array.isArray(r.meta) ? r.meta : {};
    const sortOrderRaw = r.sortOrder ?? meta.sortOrder;
    const sortOrder = Number(sortOrderRaw);
    return {
      folderId: cleanString(r.folderId || r.id),
      name: cleanString(r.name || r.title),
      source: cleanString(r.source || meta.source),
      sourceKind: cleanString(r.sourceKind || r.kind || meta.sourceKind || meta.kind),
      parentId: cleanString(r.parentId || meta.parentId),
      color: cleanString(r.color || r.iconColor || meta.iconColor || meta.color).toUpperCase(),
      sortOrder: Number.isFinite(sortOrder) ? sortOrder : 0,
      userCreated: r.userCreated === true || meta.userCreated === true,
      materializedUserFolder: r.materializedUserFolder === true || meta.materializedUserFolder === true,
      trustedFolderDisplay: r.trustedFolderDisplay === true || meta.trustedFolderDisplay === true,
      shownInNormalMode: r.shownInNormalMode === true || meta.shownInNormalMode === true,
    };
  }

  function folderCatalogSignature(rows) {
    const list = (Array.isArray(rows) ? rows : [])
      .map(canonicalFolderForSignature)
      .filter((row) => row.folderId)
      .sort((a, b) => String(a.folderId).localeCompare(String(b.folderId)));
    return JSON.stringify(list);
  }

`;
replaceOnce(rowsSignatureAnchor, rowsSignatureAnchor + folderSignatureHelpers, 'folder catalog signature helpers');

replaceOnce(
  "    const changed = before !== after;\n    state.lastRowsSignatureBefore = before;",
  "    const rowsChanged = before !== after;\n    const folderCatalogChanged = refreshSources?.folderCatalogChanged === true;\n    const changed = rowsChanged || folderCatalogChanged;\n    state.lastRowsSignatureBefore = before;",
  'applyRowsIfChanged semantic change decision'
);

replaceOnce(
  "      changed,\n      dataHashBefore: before,",
  "      changed,\n      rowsChanged,\n      folderCatalogChanged,\n      dataHashBefore: before,",
  'applyRowsIfChanged refresh diagnostics'
);

replaceOnce(
  "    state.rows = rows;\n    state.byChatId = Object.create(null);\n    for (const r of state.rows) state.byChatId[r.chatId] = r;\n    rebuildFacets();\n    state.lastRowsSignature = after;\n    return true;",
  "    if (rowsChanged) {\n      state.rows = rows;\n      state.byChatId = Object.create(null);\n      for (const r of state.rows) state.byChatId[r.chatId] = r;\n      rebuildFacets();\n    }\n    state.lastRowsSignature = after;\n    return true;",
  'applyRowsIfChanged preserve unchanged-row dedupe'
);

replaceOnce(
  "    const chatsStore = W.H2O?.Studio?.store?.chats;\n    if (!chatsStore || typeof chatsStore.list !== 'function') {",
  "    const stores = W.H2O?.Studio?.store || {};\n    const chatsStore = stores.chats;\n    const foldersStore = stores.folders;\n    if (!chatsStore || typeof chatsStore.list !== 'function') {",
  'refreshFromStores store handles'
);

replaceOnce(
  "        const chatRows = await chatsStore.list();\n        const list = Array.isArray(chatRows) ? chatRows : [];\n        const joins = await loadDesktopJoinsForChats(list);",
  "        const chatRows = await chatsStore.list();\n        const list = Array.isArray(chatRows) ? chatRows : [];\n\n        // STAB-P0 AC04: the chat-row model cannot see an empty Folder catalog\n        // create/rename. Read the active Desktop Folder catalog independently\n        // and compare a semantic signature that ignores timestamp-only churn.\n        let folderCatalogRows = [];\n        let folderCatalogAvailable = false;\n        try {\n          if (foldersStore && typeof foldersStore.list === 'function') {\n            const listedFolders = await foldersStore.list();\n            folderCatalogRows = Array.isArray(listedFolders) ? listedFolders : [];\n            folderCatalogAvailable = true;\n          }\n        } catch (e) {\n          err('refreshFromStores.folderCatalog', e);\n        }\n        const folderCatalogHashBefore = state.lastFolderCatalogSignature;\n        const folderCatalogHashAfter = folderCatalogAvailable\n          ? folderCatalogSignature(folderCatalogRows)\n          : folderCatalogHashBefore;\n        const folderCatalogChanged = folderCatalogAvailable\n          && folderCatalogHashBefore !== folderCatalogHashAfter;\n        if (folderCatalogAvailable) state.lastFolderCatalogSignature = folderCatalogHashAfter;\n\n        const joins = await loadDesktopJoinsForChats(list);",
  'refreshFromStores folder catalog read/signature'
);

replaceOnce(
  "        const refreshSources = {\n          reason: String(reason),\n          sqliteChats: list.length,\n          normalizedRows: normalized.length,\n        };",
  "        const refreshSources = {\n          reason: String(reason),\n          sqliteChats: list.length,\n          normalizedRows: normalized.length,\n          folderCatalogAvailable,\n          folderCatalogRows: folderCatalogRows.length,\n          folderCatalogChanged,\n          folderCatalogHashBefore,\n          folderCatalogHashAfter,\n        };",
  'refreshFromStores folder catalog diagnostics'
);

replaceOnce(
  "        step('refreshFromStores.ok', `${list.length}->${normalized.length}:${reason}`);",
  "        step('refreshFromStores.ok', `${list.length}->${normalized.length}:${reason}:folderCatalog=${folderCatalogChanged ? 'changed' : 'same'}`);",
  'refreshFromStores step marker'
);

replaceOnce(
  "        dataHash: state.lastRowsSignature,\n        dataHashBefore: state.lastRowsSignatureBefore,",
  "        dataHash: state.lastRowsSignature,\n        folderCatalogHash: state.lastFolderCatalogSignature,\n        dataHashBefore: state.lastRowsSignatureBefore,",
  'diagnose folder catalog hash'
);

fs.writeFileSync(indexPath, src);
console.log(`AC04 transform wrote ${path.relative(root, indexPath)}`);
