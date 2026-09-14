import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const sourcePath = process.argv[2] || path.resolve('src-surfaces-base/studio/S0F3a. 🎬 Folders - Studio.js');
const src = fs.readFileSync(sourcePath, 'utf8');

const mustContain = [
  "FOLDER_COMMAND_CONTRACT_ID = 'h2o.library.folder-commands.v1'",
  "FOLDER_COMMAND_OWNER = 'L-COCKPIT-LIBRARY'",
  "FOLDER_COMMAND_AUTHORITY = 'SINGLE_LOGICAL_FOLDER_BUSINESS_COMMAND_AUTHORITY'",
  'const FolderCommands = Object.freeze({',
  'execute: executeFolderCommand',
  "create: (input = {}) => executeFolderCommand('create', input)",
  "rename: (input = {}) => executeFolderCommand('rename', input)",
  "update: (input = {}) => executeFolderCommand('update', input)",
  "delete: (input = {}) => executeFolderCommand('delete', input)",
  "restore: (input = {}) => executeFolderCommand('restore', input)",
  "bind: (input = {}) => executeFolderCommand('bind', input)",
  "unbind: (input = {}) => executeFolderCommand('unbind', input)",
  "cleanup: (input = {}) => executeFolderCommand('cleanup', input)",
  "maintenance: (input = {}) => executeFolderCommand('maintenance', input)",
  'H2O.Library.FolderCommands = FolderCommands',
  "core.registerOwner('folder-commands', FolderCommands, { replace: true })",
  "core.registerService('folder-commands', FolderCommands, { replace: true })",
  "'L-PLATFORM-SYNC'",
  "'L-STUDIO-HOST-INTEGRATION'",
  "savedChatsStorage: 'NOT_ACTIVATED'",
  "studioRuntime: 'NOT_ACTIVATED'",
];
for (const needle of mustContain) assert(src.includes(needle), `missing contract token: ${needle}`);
assert(!src.includes('#folderList'), 'T02A must not touch the Shell-owned #folderList host');
assert(!src.includes('renderFolderSidebar'), 'T02A must not implement the Shell destructive renderer');

const context = {
  console: { log() {}, warn() {}, error() {} },
  performance: { now: () => 0 },
  URL,
  CustomEvent: class CustomEvent { constructor(type, init = {}) { this.type = type; this.detail = init.detail; } },
  setTimeout,
  clearTimeout,
};
context.window = {
  H2O: {
    Library: {},
    Studio: { actions: { folders: {
      async create(input) { return { ok: true, status: 'ok', folderId: 'f1', name: input.name }; },
      async rename(folderId, name) { return { ok: true, status: 'ok', folderId, name }; },
      async update(folderId, patch) { return { ok: true, status: 'ok', folderId, patch }; },
      async remove(folderId) { return { ok: true, status: 'ok', folderId }; },
      async restore(target) { return { ok: true, status: 'ok', target }; },
    } } },
    LibraryWorkspace: {
      async getFolders() { return []; },
      async setFolderBinding(chatId, folderId) { return { ok: true, status: 'ok', chatId, folderId }; },
    },
    LibraryIndex: { query() { return []; }, facets() { return { byFolder: {} }; }, async refresh() {} },
  },
  addEventListener() {},
  dispatchEvent() {},
};
context.globalThis = context;
vm.createContext(context);
vm.runInContext(src, context, { filename: sourcePath });

const commands = context.window.H2O.Library.FolderCommands;
assert(commands, 'FolderCommands not published');
assert.equal(commands.contract, 'h2o.library.folder-commands.v1');
assert.equal(commands.owner, 'L-COCKPIT-LIBRARY');
assert.equal(commands.authority, 'SINGLE_LOGICAL_FOLDER_BUSINESS_COMMAND_AUTHORITY');

const created = await commands.create({ name: 'Alpha' });
assert.equal(created.ok, true);
assert.equal(created.folderId, 'f1');
const renamed = await commands.rename({ folderId: 'f1', name: 'Beta' });
assert.equal(renamed.ok, true);
const colored = await commands.setColor({ folderId: 'f1', color: '#123456' });
assert.equal(colored.ok, true);
const removed = await commands.delete({ folderId: 'f1' });
assert.equal(removed.ok, true);
const restored = await commands.restore({ folderId: 'f1' });
assert.equal(restored.ok, true);
const bound = await commands.bind({ chatId: 'c1', folderId: 'f1' });
assert.equal(bound.ok, true);
assert.equal(bound.folderId, 'f1');
const unbound = await commands.unbind({ chatId: 'c1' });
assert.equal(unbound.ok, true);
assert.equal(unbound.folderId, '');
const cleanup = await commands.cleanup({ intent: 'unbind-orphan-chat', chatId: 'c2' });
assert.equal(cleanup.ok, true);
const syncBoundary = await commands.maintenance({ intent: 'mirror-reconcile' });
assert.equal(syncBoundary.status, 'boundary-owned');
assert.equal(syncBoundary.boundaryOwner, 'L-PLATFORM-SYNC');
const hostBoundary = await commands.maintenance({ intent: 'native-owner-bridge' });
assert.equal(hostBoundary.boundaryOwner, 'L-STUDIO-HOST-INTEGRATION');

console.log('STAB-P0 T02A Folder command contract: PASS');
