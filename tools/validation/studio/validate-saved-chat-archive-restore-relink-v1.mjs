#!/usr/bin/env node
// K.2 — Saved-chat archive RESTORE / RELINK validator (static).
//
// K.2 implements the first restore mode only: restore-original-ids. It is
// Desktop-only, verification-gated, absent-only, non-destructive, and explicitly
// confirm-gated. Relink, restore-into-existing-chat, tombstone override, and
// overwrite remain deferred/forbidden.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), '..', '..', '..');

const K0_CONTRACT_REL = 'release-evidence/2026-06-24/saved-chat-archive-phase-k0-restore-relink-contract.md';
const K1_EVIDENCE_REL = 'release-evidence/2026-06-24/saved-chat-archive-phase-k1-restore-relink-validator.md';
const K2_EVIDENCE_REL = 'release-evidence/2026-06-24/saved-chat-archive-phase-k2-restore-original-ids-action.md';
const RESTORE_REL = 'src-surfaces-base/studio/ingestion/saved-chat-archive-restore.studio.js';
const RELINK_REL = 'src-surfaces-base/studio/ingestion/saved-chat-archive-relink.studio.js';
const IMPORTER_REL = 'src-surfaces-base/studio/ingestion/saved-chat-archive-importer.studio.js';
const HARNESS_REL = 'tools/validation/studio/validate-saved-chat-archive-import-recovery-harness-v1.mjs';
const STUDIO_HTML_REL = 'src-surfaces-base/studio/studio.html';
const PACK_REL = 'tools/product/studio/pack-studio.mjs';
const STUDIO_DIR_REL = 'src-surfaces-base/studio';

const RESTORE_ENTRY_NAMES = ['H2O.Studio.archiveRestore', 'dryRunRestorePackage', 'restoreVerifiedPackage'];
/* The restore entry points are CALLER-CONFINED. They were confined to the
 * restore module alone; the Recovery Center is now the one admitted caller,
 * because T05 wires Restore-Original-Identity through exactly these governed
 * entry points rather than acquiring write authority of its own.
 *
 * This is a topology change, not an authority change, so the allowlist is an
 * exact path set with a pinned size — a third caller cannot appear silently —
 * and the admitted caller is additionally pinned to the exact restore symbols
 * it may name. Relink confinement is untouched: it stays module-only. */
const RECOVERY_CENTER_REL = 'src-surfaces-base/studio/ingestion/saved-chat-recovery-center-ui.studio.js';
const RESTORE_ENTRY_CALLERS = new Set([RESTORE_REL, RECOVERY_CENTER_REL]);
/* Everything the Recovery Center may name on the restore module: the two T05
 * entry points and nothing else. */
const RECOVERY_CENTER_RESTORE_SYMBOLS = new Set([
  'dryRunRestorePackage',
  'restoreVerifiedPackage',
]);
const RELINK_FORBIDDEN_NAMES = ['archiveRelink', 'dryRunRelinkPackage', 'relinkVerifiedPackage'];
const FORBIDDEN_RESTORE_MUTATIONS = [
  'libraryIndex',
  'saved_chat_archive_requests',
  'writeSavedChatPackageV1',
  'buildSavedChatPackageV1',
  'materializeSavedChatArchiveRequestV1',
  'scanSavedChatArchiveRequestInboxV1',
  'chrome.runtime',
  'connectNative',
  'sendNativeMessage',
  'webdav',
  'WebDAV',
  'syncNow',
];

const PASS = [];
const FAIL = [];
function check(label, fn) {
  try { fn(); PASS.push(label); console.log(`  ✓ ${label}`); }
  catch (e) { const m = e && e.message ? e.message : String(e); FAIL.push({ label, m }); console.log(`  ✗ ${label}`); console.log(`      ${m}`); }
}
function readRepo(rel) { return fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8'); }
function exists(rel) { return fs.existsSync(path.join(REPO_ROOT, rel)); }
function stripComments(src) { return String(src).replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1'); }
function walkJs(absDir) {
  const out = [];
  for (const e of fs.readdirSync(absDir, { withFileTypes: true })) {
    const p = path.join(absDir, e.name);
    if (e.isDirectory()) out.push(...walkJs(p));
    else if (/\.js$/.test(e.name)) out.push(p);
  }
  return out;
}
function functionBody(src, name) {
  const marker = new RegExp('function\\s+' + name + '\\s*\\(');
  const m = marker.exec(src);
  if (!m) return '';
  return src.slice(m.index, src.indexOf('\n  function ', m.index + 20) > -1
    ? src.indexOf('\n  function ', m.index + 20)
    : src.length);
}

const k0 = exists(K0_CONTRACT_REL) ? readRepo(K0_CONTRACT_REL) : '';
const k1 = exists(K1_EVIDENCE_REL) ? readRepo(K1_EVIDENCE_REL) : '';
const k2 = exists(K2_EVIDENCE_REL) ? readRepo(K2_EVIDENCE_REL) : '';
const restoreSrc = exists(RESTORE_REL) ? readRepo(RESTORE_REL) : '';
const restoreCode = stripComments(restoreSrc);
const importerSrc = exists(IMPORTER_REL) ? readRepo(IMPORTER_REL) : '';
const importerCode = stripComments(importerSrc);
const harnessSrc = exists(HARNESS_REL) ? readRepo(HARNESS_REL) : '';
const studioHtml = exists(STUDIO_HTML_REL) ? readRepo(STUDIO_HTML_REL) : '';
const packSrc = exists(PACK_REL) ? readRepo(PACK_REL) : '';

console.log('[archive-restore-relink] K.2 restore-original-ids checks');

check('[K.0] contract evidence exists and defines restore-original-ids as absent-only / no-overwrite', () => {
  assert.ok(exists(K0_CONTRACT_REL), 'missing K.0 contract');
  assert.match(k0, /PHASE K\.0 CONTRACT[\s\S]*NOT IMPLEMENTED/);
  assert.ok(k0.includes('restore-original-ids'), 'restore-original-ids');
  assert.ok(k0.includes('absent-only'), 'absent-only');
  assert.match(k0, /Overwrite is never allowed|permanently rejected|never overwrite/i);
});

check('[K.1] validator evidence exists and K.2 implementation evidence exists', () => {
  assert.ok(exists(K1_EVIDENCE_REL), 'missing K.1 evidence');
  assert.match(k1, /PHASE K\.1[\s\S]*RESTORE ?\/ ?RELINK VALIDATOR/i);
  assert.ok(exists(K2_EVIDENCE_REL), 'missing K.2 evidence');
  assert.match(k2, /PHASE K\.2[\s\S]*RESTORE ORIGINAL IDS ACTION[\s\S]*IMPLEMENTED/);
});

check('[K.2] restore module exists and registers H2O.Studio.archiveRestore APIs', () => {
  assert.ok(exists(RESTORE_REL), 'restore module missing');
  assert.match(restoreSrc, /H2O\.Studio\.archiveRestore\s*=/);
  for (const name of ['isDesktopCapable', 'dryRunRestorePackage', 'restoreVerifiedPackage']) {
    assert.ok(restoreSrc.includes(name), 'API missing: ' + name);
  }
});

check('[K.2] restore module is Desktop-only and loaded in Studio + pack list', () => {
  assert.match(restoreCode, /function detectTauri\s*\(/);
  assert.match(restoreCode, /__TAURI_INTERNALS__|__TAURI__/);
  assert.match(restoreCode, /function isDesktopCapable\s*\(/);
  assert.ok(studioHtml.includes('ingestion/saved-chat-archive-restore.studio.js'), 'studio.html loader missing');
  assert.ok(packSrc.includes('ingestion/saved-chat-archive-restore.studio.js'), 'pack list missing');
});

check('[K.2] dry-run reuses inspectPackage, reads store state only, and has the required decision vocabulary', () => {
  const body = functionBody(restoreCode, 'dryRunRestorePackage');
  assert.ok(body.includes('inspectPackage'), 'dry-run must verify through inspectPackage');
  assert.ok(body.includes('.get('), 'dry-run must read store get');
  assert.ok(body.includes('findActiveChatTombstone'), 'dry-run must check tombstones');
  for (const banned of ['INSERT INTO', 'UPDATE ', 'DELETE ', '.upsert(', '.create(']) {
    assert.ok(!body.includes(banned), 'dry-run must not write: ' + banned);
  }
  for (const st of ['restore-ready', 'already-present', 'conflict-snapshot-id', 'conflict-chat-id', 'tombstoned', 'corrupted', 'unsupported-version', 'rejected', 'read-error']) {
    assert.ok(restoreCode.includes(st), 'decision missing: ' + st);
  }
});

check('[K.2] restore action is mode-gated, confirm-gated, re-runs dry-run, and re-verifies before writing', () => {
  const body = functionBody(restoreCode, 'restoreVerifiedPackage');
  assert.ok(body.includes('mode !== RESTORE_MODE'), 'must reject unsupported mode');
  assert.ok(body.includes('confirm !== true'), 'must require explicit confirm');
  assert.ok(body.includes('dryRunRestorePackage'), 'must re-run dry-run');
  assert.ok(body.includes('restore-ready'), 'must proceed only from restore-ready');
  assert.ok(body.includes('inspectPackage'), 'must re-verify package at write time');
  assert.ok(body.includes('getSnapshotsStore().get'), 'must re-check snapshot before insert');
});

check('[K.2] restore reuses the importer turn builder and refuses empty/partial restores', () => {
  assert.ok(restoreCode.includes('archiveImporter'), 'must reference archiveImporter');
  assert.ok(restoreCode.includes('buildTurnsFromPackageSnapshot'), 'must reuse importer turn builder');
  assert.match(restoreCode, /no turns to restore|refusing partial restore/i);
});

check('[K.2] writes are insert-only into chats/snapshots/snapshot_turns and no UPDATE/DELETE/overwrite primitive is used', () => {
  assert.match(restoreCode, /INSERT INTO chats/);
  assert.match(restoreCode, /INSERT INTO snapshots/);
  assert.match(restoreCode, /INSERT INTO snapshot_turns/);
  assert.ok(!/UPDATE\s+chats|UPDATE\s+snapshots|UPDATE\s+snapshot_turns/i.test(restoreCode), 'restore must not UPDATE existing state');
  assert.ok(!/DELETE\s+FROM\s+(chats|snapshots|snapshot_turns|sync_tombstones)/i.test(restoreCode), 'restore must not DELETE');
  assert.ok(!/snapStore\.upsert\(|snapshots\.upsert\(|chatStore\.upsert\(|chats\.upsert\(/.test(restoreCode), 'restore must not use upsert overwrite primitives');
});

check('[K.2] tombstoned returns a no-write result; tombstone override/un-delete stays absent', () => {
  assert.ok(restoreCode.includes('sync_tombstones'), 'must read tombstone gate');
  assert.ok(restoreCode.includes('tombstoned'), 'must return tombstoned status');
  for (const banned of ['UPDATE sync_tombstones', 'DELETE FROM sync_tombstones', 'SET restored_at', 'clearTombstone', 'deleteTombstone']) {
    assert.ok(!restoreCode.includes(banned), 'tombstone override must be absent: ' + banned);
  }
});

check('[K.2] forbidden authorities and side effects are absent from restore module', () => {
  for (const banned of FORBIDDEN_RESTORE_MUTATIONS) {
    assert.ok(!restoreCode.includes(banned), 'restore module must not reference: ' + banned);
  }
  for (const banned of ['plugin:fs|write', 'write_file', 'remove_file', 'remove_dir', 'rename', 'setInterval', 'MutationObserver']) {
    assert.ok(!restoreCode.includes(banned), 'restore module must not include side effect: ' + banned);
  }
});

check('[INVARIANT] relink runtime is confined to the separate relink module', () => {
  for (const abs of walkJs(path.join(REPO_ROOT, STUDIO_DIR_REL))) {
    const rel = path.relative(REPO_ROOT, abs);
    if (rel === RELINK_REL) continue;
    const code = stripComments(fs.readFileSync(abs, 'utf8'));
    for (const name of RELINK_FORBIDDEN_NAMES) {
      assert.ok(!code.includes(name), 'relink runtime leaked outside relink module: ' + name + ' in ' + rel);
    }
  }
});

check('[INVARIANT] restore entry points are confined to the restore module and its ONE admitted caller', () => {
  const observedCallers = [];
  for (const abs of walkJs(path.join(REPO_ROOT, STUDIO_DIR_REL))) {
    const rel = path.relative(REPO_ROOT, abs);
    const code = stripComments(fs.readFileSync(abs, 'utf8'));
    const names = RESTORE_ENTRY_NAMES.filter((name) => code.includes(name));
    if (names.length) observedCallers.push(rel);
    if (RESTORE_ENTRY_CALLERS.has(rel)) continue;
    for (const name of names) {
      assert.ok(false, 'restore entry point leaked outside the admitted callers: ' + name + ' in ' + rel);
    }
  }
  /* The allowlist is EXACTLY two paths and cannot grow silently. */
  assert.equal(RESTORE_ENTRY_CALLERS.size, 2, 'the admitted restore-caller set changed size');
  assert.ok(RESTORE_ENTRY_CALLERS.has(RESTORE_REL), 'the restore module itself must remain admitted');
  assert.ok(RESTORE_ENTRY_CALLERS.has(RECOVERY_CENTER_REL), 'the Recovery Center must be the only other admitted caller');
  assert.equal(RESTORE_ENTRY_CALLERS.has('src-surfaces-base/studio/ingestion/saved-chat-archive-relink.studio.js'), false,
    'the relink module must never be an admitted restore caller');
  for (const rel of [RESTORE_REL, RECOVERY_CENTER_REL]) {
    assert.ok(fs.existsSync(path.join(REPO_ROOT, rel)), 'an admitted caller does not exist: ' + rel);
  }
  /* Both admitted callers must actually be observed, so the allowlist can never
   * quietly carry a path that no longer participates. */
  assert.deepEqual(observedCallers.slice().sort(), [RESTORE_REL, RECOVERY_CENTER_REL].slice().sort(),
    'observed restore-entry callers differ from the admitted set: ' + observedCallers.join(', '));

  /* The admitted caller may name ONLY the two governed T05 entry points. A third
   * restore symbol in the Recovery Center would be new reach into that module
   * regardless of what it is called. */
  const rcCode = stripComments(fs.readFileSync(path.join(REPO_ROOT, RECOVERY_CENTER_REL), 'utf8'));
  const rcSymbols = new Set(
    (rcCode.match(/archiveRestore\s*\)?\s*\.\s*([A-Za-z0-9_$]+)/g) || [])
      .map((m) => m.split('.').pop().trim()),
  );
  assert.ok(rcSymbols.size > 0, 'the Recovery Center names no restore symbol at all — the pin would pass vacuously');
  for (const sym of rcSymbols) {
    assert.ok(RECOVERY_CENTER_RESTORE_SYMBOLS.has(sym),
      'Recovery Center names a non-admitted restore symbol: archiveRestore.' + sym);
  }
  assert.equal(RECOVERY_CENTER_RESTORE_SYMBOLS.size, 2, 'the admitted Recovery Center restore symbol set changed size');
  for (const sym of RECOVERY_CENTER_RESTORE_SYMBOLS) {
    assert.ok(rcSymbols.has(sym), 'an admitted restore symbol is not actually used: ' + sym);
  }
});

check('[INVARIANT] importer remains import-as-new only and does not write package original snapshotId', () => {
  assert.ok(importerCode.includes('restore-relink-deferred'), 'importer must still defer restore/relink');
  assert.ok(!/snapStore\.upsert\(|snapshots\.upsert\(/.test(importerCode), 'importer must not call snapshot overwrite-by-id primitive');
  assert.doesNotMatch(importerCode, /create\(\{[^}]*snapshotId/s, 'import-as-new must not write package original snapshotId');
  assert.ok(importerCode.includes('generateRecoveredChatId'), 'importer must still generate fresh recovered chat id');
});

check('[K.3] permanent harness covers restore-ready / confirm gate / already-present / conflicts / tombstoned', () => {
  assert.ok(harnessSrc.includes('saved-chat-archive-restore.studio.js'), 'harness must load restore module');
  for (const phrase of [
    'restore-ready',
    'confirm gate',
    'already-present',
    'conflict-snapshot-id',
    'conflict-chat-id',
    'tombstoned',
    'no-overwrite proof',
    'live Desktop DB untouched',
  ]) {
    assert.ok(harnessSrc.includes(phrase), 'harness coverage missing: ' + phrase);
  }
});

console.log('');
if (FAIL.length) {
  console.error(`[archive-restore-relink] ${FAIL.length} failed, ${PASS.length} passed`);
  process.exitCode = 1;
} else {
  console.log(`[archive-restore-relink] PASS ${PASS.length} checks`);
}
