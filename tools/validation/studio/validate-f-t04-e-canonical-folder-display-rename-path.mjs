#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const ROOT = process.cwd();
const WORKSPACE_PATH = 'src-surfaces-base/studio/S0F1b. 🎬 Library Workspace - Studio.js';
const STUDIO_PATH = 'src-surfaces-base/studio/studio.js';
const COMMANDS_PATH = 'src-surfaces-base/studio/S0F3a. 🎬 Folders - Studio.js';

const FIXTURE_ID = 'f_dc0107f1974f881a0b4746035';
const FIXTURE_NAME = 'T04 Rename Fixture';

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const workspace = read(WORKSPACE_PATH);
const studio = read(STUDIO_PATH);
const commands = read(COMMANDS_PATH);

let checks = 0;
function check(condition, message) {
  checks += 1;
  assert.equal(!!condition, true, message);
}

function extractFunction(source, name) {
  const match = new RegExp('(?:async\\s+)?function\\s+' + name + '\\s*\\(').exec(source);
  assert.ok(match, 'missing function ' + name);
  const start = match.index;
  const open = source.indexOf('{', start);
  assert.ok(open >= 0, 'missing function body for ' + name);

  let depth = 0;
  let quote = '';
  let escaped = false;
  let lineComment = false;
  let blockComment = false;

  for (let i = open; i < source.length; i += 1) {
    const ch = source[i];
    const next = source[i + 1];

    if (lineComment) {
      if (ch === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (ch === '*' && next === '/') {
        blockComment = false;
        i += 1;
      }
      continue;
    }
    if (quote) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        escaped = true;
        continue;
      }
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '/' && next === '/') {
      lineComment = true;
      i += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      blockComment = true;
      i += 1;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === '{') depth += 1;
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error('unterminated function ' + name);
}

console.log('= F-T04-E canonical Folder display / rename-path validator =');

// A. Static source contract: source precedence and authority boundary.
check(
  workspace.includes("const desktopStoreVisibleAuthoritative = false;"),
  'A1 Desktop SQLite visible-state is diagnostics/metadata only, never canonical identity authority',
);
check(
  workspace.includes("const canonicalSelection = selectCanonicalFolderStateForNormalDisplay(nativeState, storedState);") &&
  workspace.includes("const mergedTrustedCanonical = canonicalSelection.state;"),
  'A2 diagnoseFolderParity delegates canonical identity selection to the explicit source selector',
);
check(
  workspace.includes("canonicalSource: canonicalSelection.source,"),
  'A3 diagnostics report the exact selected canonical source',
);
check(
  workspace.includes("const desktopVisibleSetAdoptionRows = [];"),
  'A4 Desktop visible-set adoption cannot add a second canonical identity source',
);
check(
  workspace.includes("return isPrimaryCanonicalFolder(folder)") &&
  workspace.includes("|| isNativeOwnedFolderMirrorRow(folder)") &&
  workspace.includes("|| (includeStoredDynamic && isStoredFolderStateRow(folder));"),
  'A5 normal-display filtering admits current dynamic native IDs and stored-mirror dynamic IDs',
);
check(
  workspace.includes("|| isNativeOwnedFolderMirrorRow(row)") &&
  workspace.includes("|| isStoredFolderStateRow(row)"),
  'A6 final canonical display classification recognizes live native and stored-mirror rows',
);

// B. Execute the exact source selection/filter functions against deterministic states.
const sandbox = {
  Set,
  Map,
  Object,
  Array,
  String,
  Number,
  Boolean,
  Math,
  JSON,
  console,
  PRIMARY_CANONICAL_FOLDER_IDS: new Set([
    'f_7050f49d3f341819dba53d547',
    'f_5d9431084707f19dba53d548',
    'f_0606ea698948f19dba53d548',
  ]),
  isProtectedCanonicalFallbackFolder() { return false; },
  isMaterializedUserFolder() { return false; },
};
vm.createContext(sandbox);

const executableNames = [
  'folderIdOf',
  'folderMetaOf',
  'isHiddenFolderDisplayRow',
  'isPrimaryCanonicalFolder',
  'isNativeOwnedFolderMirrorRow',
  'isStoredFolderStateRow',
  'filterFolderStateForNormalDisplay',
  'selectCanonicalFolderStateForNormalDisplay',
  'isCanonicalDisplayFolder',
];
const executableSource = executableNames
  .map((name) => extractFunction(workspace, name))
  .join('\n\n');

vm.runInContext(
  executableSource +
  '\n;globalThis.__fT04e = {' + executableNames.join(',') + '};',
  sandbox,
  { filename: WORKSPACE_PATH },
);
const api = sandbox.__fT04e;

const nativeRows = [
  {
    id: FIXTURE_ID,
    folderId: FIXTURE_ID,
    name: FIXTURE_NAME,
    source: 'runtime-folder-row',
    stateSource: 'native-broadcast',
  },
  {
    id: 'f_live_study_current',
    folderId: 'f_live_study_current',
    name: 'Study',
    source: 'runtime-folder-row',
    stateSource: 'native-broadcast',
  },
  {
    id: 'f_live_case_current',
    folderId: 'f_live_case_current',
    name: 'Case',
    source: 'runtime-folder-row',
    stateSource: 'native-broadcast',
  },
  {
    id: 'f_live_dev_current',
    folderId: 'f_live_dev_current',
    name: 'Dev',
    source: 'runtime-folder-row',
    stateSource: 'native-broadcast',
  },
];
const nativeItems = Object.fromEntries(nativeRows.map((row) => [row.id, ['chat-' + row.id]]));
const nativeState = {
  folders: nativeRows,
  items: nativeItems,
  hiddenByDesktopVisibleSetIds: new Set(),
};
const storedState = {
  folders: [{
    id: 'f_stored_stale',
    folderId: 'f_stored_stale',
    name: 'Stale Desktop Mirror',
    source: 'stored-folder-state',
    stateSource: 'stored-folder-state',
  }],
  items: { f_stored_stale: ['chat-stale'] },
  hiddenByDesktopVisibleSetIds: new Set(),
};

const filteredNative = api.filterFolderStateForNormalDisplay(nativeState, false);
check(
  filteredNative.folders.some((row) => row.id === FIXTURE_ID && row.name === FIXTURE_NAME),
  'B1 exact preserved fixture survives live native normal-display filtering without ID/name substitution',
);
check(
  api.isCanonicalDisplayFolder(nativeRows[0]) === true,
  'B2 dynamic native fixture is admitted by the final canonical display classifier',
);

const selectedLive = api.selectCanonicalFolderStateForNormalDisplay(nativeState, storedState);
const selectedLiveIds = selectedLive.state.folders.map((row) => row.id);
check(selectedLive.source === 'native-broadcast', 'B3 live native canonical state has first precedence');
check(
  JSON.stringify(selectedLiveIds) === JSON.stringify(nativeRows.map((row) => row.id)),
  'B4 live native exact IDs survive as the selected canonical identity set',
);
check(
  !selectedLiveIds.includes('f_stored_stale'),
  'B5 populated stored/Desktop mirror cannot replace or merge into live native canonical identity',
);
check(
  selectedLive.state.folders.find((row) => row.id === FIXTURE_ID)?.name === FIXTURE_NAME,
  'B6 fixture name remains unchanged while entering the canonical visible model',
);

const selectedStored = api.selectCanonicalFolderStateForNormalDisplay(
  { folders: [], items: {}, hiddenByDesktopVisibleSetIds: new Set() },
  storedState,
);
check(selectedStored.source === 'stored-folder-state', 'B7 stored native mirror is secondary when live native state is unavailable');
check(
  selectedStored.state.folders.map((row) => row.id).includes('f_stored_stale'),
  'B8 dynamic stored-mirror IDs survive secondary-source filtering',
);

const selectedFallback = api.selectCanonicalFolderStateForNormalDisplay(
  { folders: [], items: {}, hiddenByDesktopVisibleSetIds: new Set() },
  { folders: [], items: {}, hiddenByDesktopVisibleSetIds: new Set() },
);
check(
  selectedFallback.source === 'known-current-canonical-fallback' &&
  selectedFallback.state.folders.length === 0,
  'B9 KNOWN_NATIVE_CANONICAL_FOLDERS remains fallback-only after live and stored sources are unavailable',
);

const hiddenNative = {
  folders: [{
    id: 'f_hidden_native',
    folderId: 'f_hidden_native',
    name: 'Hidden Native',
    stateSource: 'native-broadcast',
    hidden: true,
  }],
  items: { f_hidden_native: ['chat-hidden'] },
  hiddenByDesktopVisibleSetIds: new Set(),
};
check(
  api.filterFolderStateForNormalDisplay(hiddenNative, false).folders.length === 0,
  'B10 normal hidden/tombstone safety filtering remains intact for native dynamic IDs',
);

// C. Existing Folder business-command authority is unchanged.
check(
  commands.includes("const FOLDER_COMMAND_CONTRACT_ID = 'h2o.library.folder-commands.v1';"),
  'C1 Folder command contract remains h2o.library.folder-commands.v1',
);
check(
  commands.includes("const FOLDER_COMMAND_OWNER = 'L-COCKPIT-LIBRARY';"),
  'C2 Folder command owner remains L-COCKPIT-LIBRARY',
);
check(
  commands.includes("rename: (input = {}) => executeFolderCommand('rename', input)"),
  'C3 Rename continues through the existing governed Folder command authority',
);

// D. Candidate-4 Workbench ownership/delegation is preserved.
check(
  workspace.includes('const Workbench = Object.freeze({') &&
  workspace.includes('workbench: Workbench,') &&
  workspace.includes('H2O.LibraryWorkspace = Workspace;') &&
  workspace.includes('H2O.Library.Workspace = Workspace;'),
  'D1 Candidate-4 S0F1b Workbench owner API remains published',
);
for (const [label, token] of [
  ['normalize', 'return getLibraryWorkbench().normalizeRow(raw);'],
  ['project', 'return getLibraryWorkbench().projectIndexRow(liRow);'],
  ['linked', 'return getLibraryWorkbench().readLinkedRows();'],
  ['saved', 'return getLibraryWorkbench().isSavedTranscript(row);'],
  ['merge', 'return getLibraryWorkbench().mergeLinkedRows(baseRows);'],
  ['view', 'return getLibraryWorkbench().matchesView(row, view);'],
  ['folder', 'return getLibraryWorkbench().matchesFolder(row, folderId);'],
  ['filter', 'return getLibraryWorkbench().filterRows(rows, view, query, folderId, tagFilter);'],
]) {
  check(studio.includes(token), 'D2.' + label + ' Candidate-4 studio.js delegation remains intact');
}

console.log(`F-T04-E canonical Folder display / rename-path: PASS (${checks} checks)`);
console.log('EXACT_FIXTURE_CAN_ENTER_CANONICAL_VISIBLE_MODEL=PASS');
console.log('DYNAMIC_NATIVE_FOLDER_IDS_SURVIVE=PASS');
console.log('LIVE_NATIVE_OUTRANKS_DESKTOP_AND_STORED=PASS');
console.log('STORED_NATIVE_MIRROR_SECONDARY=PASS');
console.log('KNOWN_NATIVE_CANONICAL_FOLDERS_FALLBACK_ONLY=PASS');
console.log('FOLDER_COMMAND_AUTHORITY_PRESERVED=PASS');
console.log('CANDIDATE4_WORKBENCH_PRESERVED=PASS');
