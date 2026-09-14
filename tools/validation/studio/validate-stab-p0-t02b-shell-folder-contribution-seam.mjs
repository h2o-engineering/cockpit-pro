#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '../../..');

const files = {
  surfaceHost: path.join(root, 'src-surfaces-base/studio/S0F0a. 🎬 Library Surface Host - Studio.js'),
  shell: path.join(root, 'src-surfaces-base/studio/studio.js'),
  shellHtml: path.join(root, 'src-surfaces-base/studio/studio.html'),
  libraryFolder: path.join(root, 'src-surfaces-base/studio/S0F3a. 🎬 Folders - Studio.js'),
  secondaryWriter: path.join(root, 'src-surfaces-base/studio/S0Z1g. 🎬 Library Sidebar Sections - Studio.js'),
};

const read = (p) => fs.readFileSync(p, 'utf8');
const src = Object.fromEntries(Object.entries(files).map(([key, value]) => [key, read(value)]));
let checks = 0;

function assert(condition, message) {
  checks += 1;
  if (!condition) throw new Error(`FAIL ${checks}: ${message}`);
}

function count(text, needle) {
  return String(text).split(String(needle)).length - 1;
}

new vm.Script(src.surfaceHost, { filename: files.surfaceHost });

for (const needle of [
  "'h2o.studio.folder-sidebar-contribution.v1'",
  "'h2o.library.folder-commands.v1'",
  "'L-STUDIO-APPLICATION-SHELL'",
  "'L-COCKPIT-LIBRARY'",
  "'studio.js::renderFolderSidebar'",
  "'ONE_SHELL_DESTRUCTIVE_FOLDER_HOST_LIFECYCLE'",
  "'LIBRARY_ROWS_ARE_CONTRIBUTIONS_NOT_HOST_WRITERS'",
  "'LIBRARY_ACTIONS_USE_LIBRARY_FOLDER_COMMAND_AUTHORITY'",
  "'NO_FOLDER_BUSINESS_AUTHORITY_IN_SHELL'",
  "'T03_SECONDARY_WRITER_RETIREMENT_NOT_EXECUTED'",
  "'NO_GENERIC_PLUGIN_FRAMEWORK'",
  "'folder-sidebar-contribution': folderSidebarContributionService",
  'H2O.Studio.FolderSidebarContribution = folderSidebarContributionService',
]) {
  assert(src.surfaceHost.includes(needle), `missing T02B seam token: ${needle}`);
}

const seamStart = src.surfaceHost.indexOf('// ── Service: Folder/sidebar contribution seam (STAB-P0 T02B)');
const seamEnd = src.surfaceHost.indexOf('// ── Service: route (Studio hash router)', seamStart);
assert(seamStart >= 0 && seamEnd > seamStart, 'bounded Folder/sidebar contribution block must exist');
const seam = src.surfaceHost.slice(seamStart, seamEnd);

for (const forbidden of [
  '.innerHTML',
  '.replaceChildren(',
  '.appendChild(',
  '.prepend(',
  '.insertBefore(',
  '.removeChild(',
  'renderFolderSidebar(',
  'registerPlugin',
  'registerProvider',
]) {
  assert(!seam.includes(forbidden), `T02B seam must not become a destructive/generic writer: ${forbidden}`);
}

assert(seam.includes('commands.contract !== LIBRARY_FOLDER_COMMAND_CONTRACT'), 'Shell seam must verify the frozen Library command contract');
assert(seam.includes('commands.owner !== LIBRARY_FOLDER_OWNER'), 'Shell seam must verify the Library business owner');
assert(seam.includes("typeof commands.execute !== 'function'"), 'Shell seam must require the Library dispatch authority');
assert(!seam.includes('FolderCommands.create('), 'Shell seam must not encode create business semantics');
assert(!seam.includes('FolderCommands.rename('), 'Shell seam must not encode rename business semantics');
assert(!seam.includes('FolderCommands.delete('), 'Shell seam must not encode delete business semantics');

assert(src.libraryFolder.includes("const FOLDER_COMMAND_CONTRACT_ID = 'h2o.library.folder-commands.v1'"), 'T02A Library command contract must remain present');
assert(src.libraryFolder.includes("const FOLDER_COMMAND_OWNER = 'L-COCKPIT-LIBRARY'"), 'Library must remain Folder business owner');
assert(src.libraryFolder.includes('H2O.Library.FolderCommands = FolderCommands'), 'Library FolderCommands authority must remain published');

assert(src.shell.includes('function renderFolderSidebar(rows, view, selectedFolderId)'), 'Shell destructive Folder renderer must remain present');
assert(src.shell.includes('const host = $("#folderList")'), 'Shell renderer must still resolve #folderList');
assert(src.shell.includes('host.innerHTML = ""'), 'Shell renderer must retain its destructive host lifecycle');

assert(src.secondaryWriter.includes("getElementById('folderList')"), 'Library secondary writer must remain present until T03');
assert(src.secondaryWriter.includes('renderFolders()'), 'Library secondary Folder renderer must not be retired in T02B');

assert(count(src.shellHtml, 'id="folderList"') === 1, 'studio.html must retain exactly one #folderList host');

class HTMLElementMock {}
const folderHost = new HTMLElementMock();
let destructiveWrites = 0;
Object.defineProperty(folderHost, 'innerHTML', {
  get() { return ''; },
  set() { destructiveWrites += 1; },
});

const registered = new Map();
const commandAuthority = {
  contract: 'h2o.library.folder-commands.v1',
  owner: 'L-COCKPIT-LIBRARY',
  execute() { throw new Error('T02B validator must not execute Folder business commands'); },
};

const H2O = {
  Library: { FolderCommands: commandAuthority },
  Studio: {},
};

const documentMock = {
  documentElement: { getAttribute() { return null; } },
  body: { getAttribute(name) { return name === 'data-h2o-studio-mode' ? '1' : null; } },
  querySelector(selector) {
    if (selector === '#folderList') return folderHost;
    return null;
  },
  createElement() { return new HTMLElementMock(); },
};

const context = vm.createContext({
  window: {
    H2O,
    location: { hash: '#/saved' },
    history: { state: null },
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {},
  },
  document: documentMock,
  HTMLElement: HTMLElementMock,
  MutationObserver: class { observe() {} disconnect() {} },
  CustomEvent: class { constructor(type, init = {}) { this.type = type; this.detail = init.detail; } },
  URL,
  URLSearchParams,
  performance: { now: () => 0 },
  console: { log() {}, warn() {}, error() {} },
  chrome: { runtime: { sendMessage: async () => ({ ok: true, result: null }) } },
  setTimeout,
  clearTimeout,
});
context.window.window = context.window;

vm.runInContext(src.surfaceHost, context, { filename: files.surfaceHost });

const service = H2O.Studio.FolderSidebarContribution;
assert(service?.contract === 'h2o.studio.folder-sidebar-contribution.v1', 'Shell contribution service must publish the exact contract');
assert(service?.owner === 'L-STUDIO-APPLICATION-SHELL', 'Shell must own the contribution slot');
assert(service?.contributor === 'L-COCKPIT-LIBRARY', 'Library must be the bounded contributor');
assert(service?.libraryCommandContract === 'h2o.library.folder-commands.v1', 'Shell seam must consume the frozen Library contract');
assert(service?.getCommandAuthority?.() === commandAuthority, 'Shell seam must delegate action authority to the exact Library command service');
assert(service?.getSlot?.().selector === '#folderList', 'Shell seam must expose the existing #folderList slot');
assert(service?.getSlot?.().destructiveHostLifecycleSymbol === 'studio.js::renderFolderSidebar', 'Shell seam must identify the existing destructive lifecycle symbol');
assert(registered.size === 0, 'LibraryCore is absent in the harness; no synthetic core registration should occur');

const accepted = service.setContribution({
  rows: [{ folderId: 'f1', name: 'One' }],
  actions: [{ command: 'rename', input: { folderId: 'f1', name: 'Two' } }],
});
assert(accepted?.ok === true, 'valid Library contribution must be accepted');
assert(service.getContribution()?.rows?.length === 1, 'row contribution must be retained without DOM mutation');
assert(service.getContribution()?.actions?.[0]?.command === 'rename', 'action descriptor must be retained as Library command intent');
assert(destructiveWrites === 0, 'T02B contribution seam must perform zero destructive #folderList writes');

const savedCommands = H2O.Library.FolderCommands;
H2O.Library.FolderCommands = { contract: 'wrong', owner: 'L-COCKPIT-LIBRARY', execute() {} };
const rejected = service.setContribution({ rows: [] });
assert(rejected?.ok === false && rejected?.status === 'library-folder-command-contract-unavailable', 'wrong Library contract must fail closed');
H2O.Library.FolderCommands = savedCommands;

assert(src.surfaceHost.includes("'folder-sidebar-contribution': folderSidebarContributionService"), 'contribution seam must be registered as the one bounded Studio surface service');
assert(!src.surfaceHost.includes('h2o.studio.plugin'), 'T02B must not introduce a generic plugin framework');

console.log(`STAB-P0 T02B Shell Folder/sidebar contribution seam: PASS (${checks} checks)`);
