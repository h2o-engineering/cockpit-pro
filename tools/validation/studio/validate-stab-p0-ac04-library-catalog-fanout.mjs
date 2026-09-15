#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const ROOT = process.cwd();
const paths = {
  index: 'src-surfaces-base/studio/S0F1c. 🎬 Library Index - Studio.js',
  workspace: 'src-surfaces-base/studio/S0F1b. 🎬 Library Workspace - Studio.js',
  sidebar: 'src-surfaces-base/studio/S0Z1g. 🎬 Library Sidebar Sections - Studio.js',
  shell: 'src-surfaces-base/studio/studio.js',
  commands: 'src-surfaces-base/studio/S0F3a. 🎬 Folders - Studio.js',
  sync: 'src-surfaces-base/studio/sync/sync-relationship-materialization-desktop-v2.tauri.mjs',
};
const read = (key) => fs.readFileSync(path.join(ROOT, paths[key] || key), 'utf8');
const index = read('index');
const workspace = read('workspace');
const sidebar = read('sidebar');
const shell = read('shell');
const commands = read('commands');
const sync = read('sync');
let checks = 0;

function check(condition, message) {
  checks += 1;
  assert.equal(!!condition, true, message);
}

function between(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  check(start !== -1, `missing start marker: ${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  check(end !== -1, `missing end marker: ${endMarker}`);
  return source.slice(start, end);
}

const apply = between(index, '  function applyRowsIfChanged(nextRows, reason, source, refreshSources) {', '\n\n  function rebuildFacets()');
const refresh = between(index, "  async function refreshFromStores(reason = 'manual') {", '\n\n  // Single point of fan-out:');
const emit = between(index, '  function emitUpdated(reason) {', '\n\n  // Phase E1 Stage 3.5:');
const wsBind = workspace;
const sidebarBind = between(sidebar, '  function bindUpdates() {', '\n\n  function diagnosticHash');
const sidebarRender = between(sidebar, '  async function renderFolders() {', '\n\n  async function renderLabels()');
const shellSchedule = between(shell, 'function scheduleLibraryIndexWorkbenchRefresh(){', '\n\nfunction subscribeLibraryIndexToWorkbenchCache');
const shellSubscribe = between(shell, 'function subscribeLibraryIndexToWorkbenchCache(attempt = 0){', '\n\n// ── Library Workspace facade integration');
const shellFolderRender = between(shell, 'function renderFolderSidebar(rows, view, selectedFolderId){', '\n\nfunction getActiveSnapshotId');

check(index.includes("lastFolderCatalogSignature: ''"), 'Folder catalog signature state missing');
check(index.includes('function canonicalFolderForSignature(row)'), 'Folder signature projector missing');
check(index.includes('function folderCatalogSignature(rows)'), 'Folder catalog signature helper missing');
check(refresh.includes('const foldersStore = stores.folders;'), 'Desktop refresh must resolve folders store');
check(refresh.includes("typeof foldersStore.list === 'function'"), 'Desktop refresh must read complete folder catalog');
check(refresh.includes('folderCatalogSignature(folderCatalogRows)'), 'Desktop refresh must compute folder catalog signature');
check(refresh.includes('folderCatalogChanged'), 'Desktop refresh must carry folder catalog change fact');
check(refresh.includes('applyRowsIfChanged(normalized, reason, \'desktop-sqlite\', refreshSources)'), 'Desktop refresh must feed catalog fact through existing apply gate');
check(refresh.includes('if (!changed) return state.rows;'), 'Existing update fan-out gate must remain');
check(refresh.includes('emitUpdated(reason);'), 'Existing Library update fan-out must remain');

check(apply.includes('const rowsChanged = before !== after;'), 'Chat-row signature dedupe must remain explicit');
check(apply.includes('refreshSources?.folderCatalogChanged === true'), 'Catalog-only semantic wake-up must feed applyRowsIfChanged');
check(apply.includes('const changed = rowsChanged || folderCatalogChanged;'), 'Fan-out decision must include catalog-only change');
check(apply.includes('if (rowsChanged) {'), 'Row/facet rebuild must remain gated by chat-row change');
check(apply.includes("state.lastRefreshSkipReason = changed ? '' : 'unchanged-row-signature';"), 'Unchanged semantic refresh must remain skippable');
check(!emit.includes('library-index:refresh-request'), 'emitUpdated must not recursively request another refresh');

check(wsBind.includes('idx.subscribe((detail)'), 'Workspace must subscribe to Library Index updates');
check(wsBind.includes("bustCaches('index-updated')"), 'Workspace must invalidate catalog cache on Index update');
check(wsBind.includes("emitUpdated('index-updated', detail)"), 'Workspace must propagate Index update');
check(sidebarBind.includes('ws.subscribe(() => { renderAllSections(); })'), 'S0Z1g must wake from Workspace update');
check(sidebarRender.includes('getDisplayModel?.({ fresh: true })'), 'S0Z1g must re-read fresh Folder display model');
check(sidebarRender.includes('seam.setContribution({ rows, actions })'), 'S0Z1g must republish Folder contribution');

check(shellSubscribe.includes('li.subscribe(scheduleLibraryIndexWorkbenchRefresh)'), 'Shell workbench must subscribe to Library Index updates');
check(shellSchedule.includes('state.rowsCache = null;'), 'Shell refresh must invalidate workbench row cache');
check(shellSchedule.includes('renderRoute().catch(console.error)'), 'Shell refresh must re-render the list route');
check(shellFolderRender.includes('const host = $("#folderList")'), 'Shell must remain Folder host renderer');
check(shellFolderRender.includes('host.innerHTML = ""'), 'Shell destructive lifecycle must remain present');
check(!sidebarRender.includes("getElementById('folderList')"), 'S0Z1g must not regain Folder host ownership');
check(!sidebarRender.includes("innerHTML = ''"), 'S0Z1g renderFolders must remain non-destructive');

check(commands.includes("const FOLDER_COMMAND_CONTRACT = 'h2o.library.folder-commands.v1'"), 'FolderCommands contract changed');
check(commands.includes("const FOLDER_COMMAND_OWNER = 'L-COCKPIT-LIBRARY'"), 'FolderCommands owner changed');
check(sync.includes("LIBRARY_REFRESH_EVENT: 'evt:h2o:library-index:refresh-request'"), 'Sync refresh boundary changed');
check(!index.includes('h2o_p02_relationship_apply'), 'Library Index must not absorb Host Integration command');
check(!index.includes('sync_object_state'), 'Library Index must not absorb Sync bookkeeping');

const signatureBlock = between(index, '  function sortStrings(list) {', '\n\n  function rememberUpdateEvent');
const events = { skipped: 0, rebuilds: 0 };
const sandbox = {
  cleanString(value) { return String(value == null ? '' : value).trim(); },
  numericCount(value) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : 0;
  },
  state: {
    rows: [],
    byChatId: Object.create(null),
    facets: {},
    lastRowsSignature: '',
    lastRowsSignatureBefore: '',
    lastRowsSignatureAfter: '',
    lastRefreshChanged: false,
    lastRefreshSkipped: false,
    lastRefreshSkipReason: '',
    lastScanTs: 0,
    lastScanReason: '',
    lastSource: 'none',
    lastRefreshSources: null,
  },
  rememberUpdateEvent(_reason, _before, _after, emitted) {
    if (!emitted) events.skipped += 1;
  },
  step() {},
  rebuildFacets() { events.rebuilds += 1; },
  Date,
  JSON,
  Array,
  Object,
  String,
  Number,
  Math,
  console,
};
vm.createContext(sandbox);
vm.runInContext(`${signatureBlock}\n${apply}`, sandbox, { filename: paths.index });

const rows = [{
  chatId: 'chat-1', snapshotId: 'snap-1', title: 'Same chat', view: 'saved',
  folderId: '', labels: [], tags: [], state: { isSaved: true },
}];
sandbox.state.rows = rows;
sandbox.state.lastRowsSignature = sandbox.rowsSignature(rows);

const baseFolders = [{ folderId: 'f-a', name: 'Alpha', source: 'user', updatedAt: 1 }];
const createdFolders = [...baseFolders, { folderId: 'f-empty', name: 'Empty Folder', source: 'user', updatedAt: 2 }];
const renamedFolders = [{ folderId: 'f-a', name: 'Alpha Renamed', source: 'user', updatedAt: 3 }];
const timestampOnly = [{ folderId: 'f-a', name: 'Alpha', source: 'user', updatedAt: 999999 }];
const baseSig = sandbox.folderCatalogSignature(baseFolders);
const createSig = sandbox.folderCatalogSignature(createdFolders);
const renameSig = sandbox.folderCatalogSignature(renamedFolders);

check(baseSig !== createSig, 'Empty-folder create must change catalog signature');
check(baseSig !== renameSig, 'Empty-folder rename must change catalog signature');
check(baseSig === sandbox.folderCatalogSignature(timestampOnly), 'Timestamp-only churn must not change catalog signature');
check(baseSig === sandbox.folderCatalogSignature([...baseFolders].reverse()), 'Catalog signature must be order-stable');

let decision = sandbox.applyRowsIfChanged(rows, 'ac04-create', 'desktop-sqlite', { folderCatalogChanged: true });
check(decision === true, 'Catalog-only create must request existing fan-out');
check(events.rebuilds === 0, 'Catalog-only create must not rebuild unchanged chat rows/facets');
check(sandbox.state.lastRefreshSkipped === false, 'Catalog-only create must not be marked skipped');
check(sandbox.state.lastRefreshSources.rowsChanged === false && sandbox.state.lastRefreshSources.folderCatalogChanged === true, 'Catalog-only create diagnostics wrong');

decision = sandbox.applyRowsIfChanged(rows, 'ac04-rename', 'desktop-sqlite', { folderCatalogChanged: true });
check(decision === true, 'Catalog-only rename must request existing fan-out');
check(events.rebuilds === 0, 'Catalog-only rename must not rebuild unchanged chat rows/facets');

decision = sandbox.applyRowsIfChanged(rows, 'ac04-repeat', 'desktop-sqlite', { folderCatalogChanged: false });
check(decision === false, 'Repeated unchanged chat/catalog refresh must remain deduped');
check(sandbox.state.lastRefreshSkipped === true, 'Repeated unchanged refresh must be marked skipped');
const skippedAfterFirstRepeat = events.skipped;
decision = sandbox.applyRowsIfChanged(rows, 'ac04-repeat-2', 'desktop-sqlite', { folderCatalogChanged: false });
check(decision === false && events.skipped === skippedAfterFirstRepeat + 1, 'Repeated unchanged refreshes must not create update storm');

const changedRows = [{ ...rows[0], title: 'Changed chat' }];
decision = sandbox.applyRowsIfChanged(changedRows, 'row-change', 'desktop-sqlite', { folderCatalogChanged: false });
check(decision === true, 'Real chat-row change must still fan out');
check(events.rebuilds === 1, 'Real chat-row change must still rebuild facets exactly once');

console.log(`STAB-P0 AC04 Library catalog-only fan-out: PASS (${checks} checks)`);
console.log('CATALOG_ONLY_EMPTY_FOLDER_CREATE_FANOUT=PASS');
console.log('CATALOG_ONLY_EMPTY_FOLDER_RENAME_FANOUT=PASS');
console.log('UNCHANGED_CHAT_ROW_DEDUPE_PRESERVED=PASS');
console.log('S0Z1G_CONTRIBUTION_WAKEUP=PASS');
console.log('NO_REFRESH_LOOP_OR_STORM=PASS');
console.log('PHYSICAL_DESTRUCTIVE_FOLDERLIST_WRITER_COUNT=1');
console.log('LIBRARY_COMMAND_AUTHORITY_PRESERVED=PASS');
console.log('SYNC_BOUNDARY_PRESERVED=PASS');
console.log('HOST_BOUNDARY_PRESERVED=PASS');
console.log('AC04_PARITY_BLOCKER_RESOLVED=PASS');
