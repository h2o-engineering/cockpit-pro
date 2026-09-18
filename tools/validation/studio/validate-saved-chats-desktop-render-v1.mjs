#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import vm from 'node:vm';

const root = process.cwd();
const failures = [];

const sharedCoreFile = 'shared/library/library-index-core.js';
const runtimeCoreFile = 'src-runtime-base/0F0d.⬛️🧬 Library Index Core 🧬.js';
const studioCoreFile = 'src-surfaces-base/studio/S0F0d. 🎬 Library Index Core - Studio.js';
const studioShellFile = 'src-surfaces-base/studio/studio.js';
const libraryWorkspaceFile = 'src-surfaces-base/studio/S0F1b. 🎬 Library Workspace - Studio.js';

function read(file) {
  return fs.readFileSync(path.join(root, file), 'utf8');
}

function assert(condition, message) {
  if (!condition) failures.push(message);
}

function coreBody(file) {
  const text = read(file);
  const start = text.indexOf('(() => {');
  assert(start !== -1, `${file}: core IIFE missing`);
  return start === -1 ? '' : text.slice(start).trim();
}

function loadCore() {
  const context = { console, Date, H2O: { Library: {} } };
  context.globalThis = context;
  vm.runInContext(read(sharedCoreFile), vm.createContext(context), { filename: sharedCoreFile });
  return context.H2O?.Library?.LibraryIndexCore || null;
}

function runCoreProof() {
  const core = loadCore();
  assert(core && typeof core === 'object', 'LibraryIndexCore failed to load');
  assert(typeof core.canonicalRowsForView === 'function', 'canonicalRowsForView missing');
  assert(typeof core.canonicalSavedRecentRows === 'function', 'canonicalSavedRecentRows missing');
  assert(typeof core.canonicalHeadlineCounts === 'function', 'canonicalHeadlineCounts missing');
  assert(typeof core.canonicalActiveRows === 'function', 'canonicalActiveRows missing');
  assert(typeof core.canonicalArchivedRows === 'function', 'canonicalArchivedRows missing');

  const rows = [
    {
      chatId: 'saved-archived',
      snapshotId: 'snap-saved-archived',
      title: 'Saved Archived',
      view: 'archived',
      displayView: 'archived',
      archived: true,
      isSaved: true,
      messageCount: 4,
      state: { isSaved: true, isArchived: true, isDeleted: false },
    },
    {
      chatId: 'link-only',
      title: 'Link Only',
      view: 'link',
      href: '/c/link-only',
      isSaved: false,
      messageCount: 4,
      state: { isSaved: false, isLinked: true, isDeleted: false },
    },
    {
      chatId: 'deleted-saved',
      snapshotId: 'snap-deleted-saved',
      title: 'Deleted Saved',
      view: 'saved',
      isSaved: true,
      isDeleted: true,
      messageCount: 4,
      state: { isSaved: true, isDeleted: true },
    },
    {
      chatId: 'archive-only',
      snapshotId: 'snap-archive-only',
      title: 'Archive Only',
      view: 'archived',
      displayView: 'archived',
      archived: true,
      isSaved: false,
      messageCount: 4,
      state: { isSaved: false, isArchived: true, isDeleted: false },
    },
  ];

  const savedRows = core.canonicalRowsForView(rows, 'saved');
  assert(savedRows.length === 1, `saved view expected 1 row, got ${savedRows.length}`);
  assert(savedRows[0]?.chatId === 'saved-archived', 'saved view must include saved archive-displayed row');

  const activeRows = core.canonicalActiveRows(rows);
  assert(activeRows.map((row) => row.chatId).join(',') === 'saved-archived,link-only', 'active rows must include saved archived and link-only rows only');

  const archiveRows = core.canonicalArchivedRows(rows);
  assert(archiveRows.map((row) => row.chatId).join(',') === 'saved-archived,archive-only', 'archive view must keep archived rows');

  const savedRecentRows = core.canonicalSavedRecentRows(rows, 10);
  assert(savedRecentRows.length === 1, `saved recents expected 1 row, got ${savedRecentRows.length}`);
  assert(savedRecentRows[0]?.chatId === 'saved-archived', 'saved recents must include saved archive-displayed row');

  const counts = core.canonicalHeadlineCounts(rows);
  assert(counts.total === 2, `active total expected 2, got ${counts.total}`);
  assert(counts.saved === 1, `saved count expected 1, got ${counts.saved}`);
  assert(counts.link === 1, `link count expected 1, got ${counts.link}`);
  assert(counts.archived === 2, `archived side count expected 2, got ${counts.archived}`);
}

function runTriplicateProof() {
  const sharedBody = coreBody(sharedCoreFile);
  assert(coreBody(runtimeCoreFile) === sharedBody, 'runtime LibraryIndexCore body differs from shared core');
  assert(coreBody(studioCoreFile) === sharedBody, 'Studio LibraryIndexCore body differs from shared core');
}

function runStudioShellStaticProof() {
  const shell = read(studioShellFile);
  const workspace = read(libraryWorkspaceFile);
  assert(workspace.includes('function workbenchMatchesView(row, view)'), 'S0F1b must own Saved/Linked view membership semantics');
  assert(workspace.includes('if (archived && !saved) return false;'), 'S0F1b Saved route must not drop saved rows solely because archived is true');
  assert(workspace.includes('if (next === "linked") return rowView === "linked" && !saved;'), 'S0F1b Linked route must remain linked-only');
  assert(workspace.includes('if (next === "saved") return saved;'), 'S0F1b Saved route must key off saved membership');
  assert(workspace.includes('const Workbench = Object.freeze({'), 'S0F1b must publish the frozen workbench read-model namespace');
  assert(shell.includes('return getLibraryWorkbench().matchesView(row, view);'), 'studio.js matchesView must delegate to Library Workspace');
  assert(shell.includes('return getLibraryWorkbench().filterRows(rows, view, query, folderId, tagFilter);'), 'studio.js filterRows must delegate to Library Workspace');
  assert(!shell.includes('if (next === "linked") return rowView === "linked" && !saved;'), 'Saved/Linked membership semantics must not remain duplicated in studio.js');
}

runTriplicateProof();
runCoreProof();
runStudioShellStaticProof();

if (failures.length) {
  console.error('Saved chats Desktop render validation failed');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('Saved chats Desktop render validation passed');
