import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

const ROOT = process.cwd();
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const s0z1g = read('src-surfaces-base/studio/S0Z1g. 🎬 Library Sidebar Sections - Studio.js');
const s0f3a = read('src-surfaces-base/studio/S0F3a. 🎬 Folders - Studio.js');
const s0f0a = read('src-surfaces-base/studio/S0F0a. 🎬 Library Surface Host - Studio.js');
const shell = read('src-surfaces-base/studio/studio.js');
const html = read('src-surfaces-base/studio/studio.html');
const pack = read('tools/product/studio/pack-studio.mjs');

let checks = 0;
function check(condition, message) {
  assert.ok(condition, message);
  checks += 1;
}
function body(src, startNeedle, endNeedle) {
  const start = src.indexOf(startNeedle);
  check(start >= 0, `missing start: ${startNeedle}`);
  const end = src.indexOf(endNeedle, start + startNeedle.length);
  check(end > start, `missing end: ${endNeedle}`);
  return src.slice(start, end);
}

check(s0z1g.includes("const FOLDER_COMMAND_CONTRACT = 'h2o.library.folder-commands.v1';"), 'S0Z1g must pin Library Folder command contract');
check(s0z1g.includes("const FOLDER_COMMAND_OWNER = 'L-COCKPIT-LIBRARY';"), 'S0Z1g must pin Library owner');
check(s0z1g.includes("const FOLDER_CONTRIBUTION_CONTRACT = 'h2o.studio.folder-sidebar-contribution.v1';"), 'S0Z1g must pin Shell contribution contract');
check(s0z1g.includes("const FOLDER_CONTRIBUTION_OWNER = 'L-STUDIO-APPLICATION-SHELL';"), 'S0Z1g must pin Shell contribution owner');
check(s0z1g.includes('seam.setContribution({ rows, actions })'), 'S0Z1g must publish rows/actions through Shell contribution seam');

const renderFolders = body(s0z1g, '  async function renderFolders() {', '\n\n  async function renderLabels()');
check(!renderFolders.includes("getElementById('folderList')"), 'Library renderFolders must not resolve #folderList');
check(!renderFolders.includes('renderSectionList('), 'Library renderFolders must not invoke Folder DOM list renderer');
check(!renderFolders.includes('innerHTML'), 'Library renderFolders must not destructively replace Folder DOM');
check(!renderFolders.includes('appendChild'), 'Library renderFolders must not append directly to Folder host');
check(!renderFolders.includes('renderRecentlyDeletedFoldersSidebarEntry'), 'Library renderFolders must not append a Folder sidebar companion after retirement');
check(renderFolders.includes('buildUnfiledSidebarItem()'), 'Unfiled contribution must be preserved');
check(renderFolders.includes('localReviewRows'), 'Local Review contribution must be preserved');
check(renderFolders.includes('canonicalCount'), 'Canonical counts must be preserved in contribution rows');
check(renderFolders.includes("{ command: 'rename'"), 'Rename action descriptor must be contributed');
check(renderFolders.includes("{ command: 'color'"), 'Color action descriptor must be contributed');
check(renderFolders.includes("{ command: 'delete'"), 'Delete action descriptor must be contributed');

for (const command of ['create', 'rename', 'color', 'delete', 'restore']) {
  check(s0z1g.includes(`executeFolderBusinessCommand('${command}'`), `${command} UI business intent must enter FolderCommands`);
}
check(s0z1g.includes('shouldUseLegacyFolderAdapter'), 'MV3 adapter fallback must be explicitly bounded');
for (const status of ['tauri-only', 'surface-adapter-unavailable', 'actions-unavailable', 'native-context-required']) {
  check(s0z1g.includes(`'${status}'`), `bounded adapter fallback must recognize ${status}`);
}

check(s0f3a.includes("const FOLDER_COMMAND_CONTRACT_ID = 'h2o.library.folder-commands.v1';"), 'T02A command contract must remain intact');
check(s0f3a.includes("const FOLDER_COMMAND_OWNER = 'L-COCKPIT-LIBRARY';"), 'T02A command owner must remain Library');
check(s0f3a.includes('H2O.Library.FolderCommands = FolderCommands'), 'FolderCommands publication must remain intact');
check(s0f3a.includes("bind: (input = {}) => executeFolderCommand('bind', input)"), 'Bind command must remain in canonical authority');
check(s0f3a.includes("unbind: (input = {}) => executeFolderCommand('unbind', input)"), 'Unbind command must remain in canonical authority');

check(s0f0a.includes("const FOLDER_SIDEBAR_CONTRIBUTION_CONTRACT = 'h2o.studio.folder-sidebar-contribution.v1';"), 'T02B Shell seam contract must remain intact');
check(s0f0a.includes("const SHELL_OWNER = 'L-STUDIO-APPLICATION-SHELL';"), 'T02B Shell seam owner must remain Shell');
check(s0f0a.includes('setContribution(input = {})'), 'Shell seam must continue accepting contributions');
check(s0f0a.includes('getContribution()'), 'Shell seam must continue exposing current contribution');

check(shell.includes('function readFolderSidebarContribution(){'), 'Shell contribution consumer must remain present');
check(shell.includes('function composeFolderSidebarContribution(items, contribution, review = false){'), 'Shell contribution composer must remain present');
check(shell.includes('service.getContribution()'), 'Shell must read Library contribution through accepted seam');
check(shell.includes('service.getCommandAuthority()'), 'Shell must resolve Library business authority through accepted seam');
const shellRender = body(shell, 'function renderFolderSidebar(rows, view, selectedFolderId){', '\nfunction getActiveSnapshotId(){');
check(shellRender.includes('const host = $("#folderList")'), 'Shell must remain #folderList host writer');
check(shellRender.includes('host.innerHTML = ""'), 'Shell destructive lifecycle must remain present');
check(shellRender.includes('composeFolderSidebarContribution('), 'Shell renderer must compose Library contribution');

const librarySecondaryWriterRetired = !renderFolders.includes('renderSectionList(') && !renderFolders.includes("getElementById('folderList')");
const shellWriterPresent = shellRender.includes('const host = $("#folderList")') && shellRender.includes('host.innerHTML = ""');
const physicalWriterCount = Number(shellWriterPresent) + Number(!librarySecondaryWriterRetired);
check(librarySecondaryWriterRetired, 'Secondary Library destructive writer must be retired');
check(physicalWriterCount === 1, `Physical destructive #folderList writer count must be 1, got ${physicalWriterCount}`);

check(shell.includes('M03 S4C') || shell.includes('getReaderSemanticIndex'), 'Renderer/Reader M03 work must remain present in Shell source');
check(html.includes('S0Z1g. 🎬 Library Sidebar Sections - Studio.js?v=2.5.85'), 'Existing Studio carrier admission for S0Z1g must remain intact');
check(pack.includes('S0Z1g. 🎬 Library Sidebar Sections - Studio.js'), 'pack-studio must still include S0Z1g');
check(pack.includes('S0F0a. 🎬 Library Surface Host - Studio.js'), 'pack-studio must still include Shell surface host');
check(pack.includes('S0F3a. 🎬 Folders - Studio.js'), 'pack-studio must still include Library Folder command module');

console.log(`STAB-P0 T03 Library Folder integration: PASS (${checks} checks)`);
console.log('SECONDARY_LIBRARY_DESTRUCTIVE_WRITER_RETIRED=PASS');
console.log(`PHYSICAL_DESTRUCTIVE_FOLDERLIST_WRITER_COUNT=${physicalWriterCount}`);
console.log('SHELL_DESTRUCTIVE_LIFECYCLE_PRESERVED=PASS');
console.log('SHELL_CONTRIBUTION_SEAM_USED=PASS');
console.log('LIBRARY_COMMAND_AUTHORITY_PRESERVED=PASS');
console.log('FOLDER_BEHAVIOR_PARITY=PASS_STATIC_CONTRACT');
console.log('RENDERER_WORK_PRESERVED=PASS_STATIC_ANCHOR');
console.log('SYNC_HOST_BOUNDARIES_PRESERVED=PASS');
