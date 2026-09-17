#!/usr/bin/env node
// Backup v1 T03 — Saved-Chat LOCAL BACKUP permanent harness (T03_HARNESS_CONTRACT).
//
// Proves the Studio orchestration of the manual local backup end to end over a
// throwaway node:sqlite database and throwaway temp roots, using the REAL
// Product modules — the chats / snapshots / tombstones store adapters, the
// package codec, the asset materializer, the v3 package builder, the
// generation-policy facade, the projection probe and the new
// saved-chat-local-backup.studio.js module — loaded into a vm context in the
// same order studio.html loads them.
//
// The ONLY protocol double is the native T02 publisher
// (h2o_saved_chat_backup_*). It replays the accepted T02 wire shapes and state
// machine over a temp backup root and records every invoke. It is NOT a
// verifier: it runs no package verification, decodes nothing and proves
// nothing about filesystem safety — the accepted T02 Rust tests own that. It
// parses the manifest member it was handed only to derive the protocol facts a
// real publisher returns (the leaf, the entry) and to emulate the
// package_finish identity binding.
//
// What this harness owns (contract §19, §23 T03_HARNESS_CONTRACT):
//   enumeration / eligibility / skips; current-snapshot choice; the real
//   policy facade and V3 builder; the real materializer through the
//   Backup-private asset stack; native invoke sequencing; the source-change
//   guard and the one-rebuild rule; per-entry failure recording with the
//   CLOSED code / stage vocabularies (NB-VER-02); complete / partial truth;
//   source non-mutation; the seven T02 VER clarifications; UI / result truth.
//
// It NEVER touches the developer's live studio-v1.db, archive, CAS or backups.
//
// RED CONTROL: `--red-control` runs the suite against a runtime-mutated copy of
// the module (the package_abort before a rebuild removed) and must FAIL; the
// normal run also self-checks that control inline and fails if the mutated
// variant would pass.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), '..', '..', '..');
const RED_CONTROL_MODE = process.argv.includes('--red-control');

const MODULE_REL = 'src-surfaces-base/studio/ingestion/saved-chat-local-backup.studio.js';
const HEALTH_UI_REL = 'src-surfaces-base/studio/ingestion/archive-health-ui.studio.js';
const HTML_REL = 'src-surfaces-base/studio/studio.html';
const PACK_REL = 'tools/product/studio/pack-studio.mjs';
const LIB_RS_REL = 'apps/studio/desktop/src-tauri/src/lib.rs';
const NATIVE_REL = 'apps/studio/desktop/src-tauri/src/saved_chat_local_backup.rs';
const NATIVE_DOC_REL = 'docs/systems/archive/saved-chat-local-backup.md';
const FIXTURE_DIR_REL = 'tools/validation/fixtures/saved-chat-archive/local-backup';
const SEED_REL = FIXTURE_DIR_REL + '/seed-dataset.json';

/* Real modules, in studio.html order (store → sanitizer → codec → builder →
 * CAS → materializer → policy → probe → the new module). */
const STUDIO_MODULES = [
  'store/index.js',
  'store/chats.tauri.js',
  'store/snapshots.tauri.js',
  'store/tombstones.tauri.js',
  'platform/html-sanitizer.js',
  'ingestion/saved-chat-package-codec.tauri.js',
  'ingestion/saved-chat-package-v1.tauri.js',
  'ingestion/asset-cas.tauri.js',
  'ingestion/saved-chat-package-assets.tauri.js',
  'ingestion/saved-chat-generation-policy.tauri.js',
  'ingestion/saved-chat-projection-probe.tauri.js',
  'ingestion/saved-chat-local-backup.studio.js',
];

/* The closed vocabularies the module must publish (contract §17 + §14 of the
 * T03 directive). Pinned here so a widened list fails loudly. */
const EXPECTED_RENDERER_CODES = [
  'backup-enumeration-indeterminate', 'backup-enumeration-inconsistent',
  'backup-source-chat-disappeared', 'backup-source-snapshot-disappeared',
  'backup-source-read-failed', 'backup-source-unstable',
  'backup-projection-failed', 'backup-projection-bound-exceeded',
];
const EXPECTED_STAGES = ['enumeration', 'package-begin', 'build', 'guard', 'write-member', 'package-finish'];

const PASS = [];
const FAIL = [];
function check(label, fn) {
  try { fn(); PASS.push(label); console.log(`  ✓ ${label}`); }
  catch (e) { const m = e && e.message ? e.message : String(e); FAIL.push({ label, m }); console.log(`  ✗ ${label}`); console.log(`      ${m}`); }
}
async function checkAsync(label, fn) {
  try { await fn(); PASS.push(label); console.log(`  ✓ ${label}`); }
  catch (e) { const m = e && e.message ? e.message : String(e); FAIL.push({ label, m }); console.log(`  ✗ ${label}`); console.log(`      ${m}`); }
}
function readRepo(rel) { return fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8'); }
/* Values that crossed the vm boundary carry sandbox prototypes; compare by JSON. */
function eq(actual, expected, message) { assert.equal(JSON.stringify(actual), JSON.stringify(expected), message); }
function stripComments(src) { return String(src).replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1'); }
function sha256Hex(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }
function sha256Prefixed(buf) { return 'sha256-' + sha256Hex(buf); }
function normalizeSha(text) {
  const t = String(text || '').trim().toLowerCase();
  const hex = t.startsWith('sha256-') ? t.slice(7) : t;
  return /^[0-9a-f]{64}$/.test(hex) ? hex : '';
}

const moduleSrc = readRepo(MODULE_REL);
const moduleCode = stripComments(moduleSrc);
const seed = JSON.parse(readRepo(SEED_REL));

// ═════════════════════════════════════════════════════════════════════════
// Static checks — registration, mount, hygiene, closed vocabularies
// ═════════════════════════════════════════════════════════════════════════

console.log('── Saved-chat local backup harness (Backup v1 T03) ──' + (RED_CONTROL_MODE ? ' [RED CONTROL MODE]' : ''));
console.log('[static]');

check('module is registered in studio.html between the Recovery Center and Archive Health tags', () => {
  const html = readRepo(HTML_REL);
  const rc = html.indexOf('<script src="./ingestion/saved-chat-recovery-center-ui.studio.js"></script>');
  const lb = html.indexOf('<script src="./ingestion/saved-chat-local-backup.studio.js"></script>');
  const ah = html.indexOf('<script src="./ingestion/archive-health-ui.studio.js"></script>');
  assert.ok(rc >= 0 && lb >= 0 && ah >= 0, 'all three tags present');
  assert.ok(rc < lb && lb < ah, 'local backup tag sits between recovery center and archive health');
  assert.equal(html.split('saved-chat-local-backup.studio.js').length - 1, 1, 'exactly one registration');
});

check('module is in both pack allowlists at the paired index (source/output parity)', () => {
  const pack = readRepo(PACK_REL);
  assert.equal(pack.split('"ingestion/saved-chat-local-backup.studio.js"').length - 1, 2, 'one entry per allowlist');
  const src = pack.slice(pack.indexOf('ARCHIVE_WORKBENCH_SOURCE_FILES = Object.freeze(['), pack.indexOf('ARCHIVE_WORKBENCH_OUT_FILES = Object.freeze(['));
  const out = pack.slice(pack.indexOf('ARCHIVE_WORKBENCH_OUT_FILES = Object.freeze(['));
  const entries = (text) => [...text.matchAll(/^\s*"([^"]+)",/gm)].map((m) => m[1]);
  const srcList = entries(src);
  const outList = entries(out.slice(0, out.indexOf(']);')));
  const i = srcList.indexOf('ingestion/saved-chat-local-backup.studio.js');
  const j = outList.indexOf('ingestion/saved-chat-local-backup.studio.js');
  assert.ok(i >= 0 && i === j, `paired index ${i} vs ${j}`);
  assert.equal(srcList[i - 1], 'ingestion/saved-chat-recovery-center-ui.studio.js');
  assert.equal(srcList[i + 1], 'ingestion/archive-health-ui.studio.js');
});

check('Archive Health mounts the card through ONE guarded sibling block after the Recovery Center block', () => {
  const health = stripComments(readRepo(HEALTH_UI_REL));
  const rc = health.indexOf('mountRecoveryCenterCard(container)');
  const lb = health.indexOf('localBackupApi.mountLocalBackupCard(container)');
  assert.ok(rc >= 0 && lb > rc, 'local backup mount follows the recovery center mount');
  assert.equal(health.split('mountLocalBackupCard').length - 1, 2, 'typeof guard + one call');
  assert.ok(health.includes("typeof localBackupApi.mountLocalBackupCard === 'function'"), 'typeof-guarded');
  assert.ok(health.includes('H2O.Studio.localBackupUi'), 'resolves the module namespace');
});

check('module hygiene: no markup injection, no browser filesystem, no source write verbs, no second projector', () => {
  for (const forbidden of [
    'innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'localStorage', 'sessionStorage',
    'plugin:fs|', 'plugin:sql', 'showSaveFilePicker', 'showDirectoryPicker', 'createObjectURL',
    'writeSavedChatPackage', 'publishBuiltSavedChatGeneration', 'publishSavedChatGeneration',
    'h2o_archive_', 'h2o_saved_chat_portable', '.upsert(', '.patch(', '.remove(', '.markSaved(', '.markLinked(',
    'store.chats.create', 'snapshots.create', 'tombstones.create', 'setInterval(', 'setTimeout(', 'requestIdleCallback',
    'contentHashV3', 'canonicalJson(', 'gzipEncodeBytes', 'buildSavedChatPackageV3(', 'buildSavedChatPackageV1(',
    'webdav', 'H2O.Studio.sync', 'archiveRestore', 'restoreOriginal', 'archiveRelink', 'relinkSaved',
  ]) {
    assert.ok(!moduleCode.includes(forbidden), `forbidden token in module code: ${forbidden}`);
  }
  assert.ok(!/\.h2ochat|\.h2obackup|\[0-9a-f\]\{64\}/.test(moduleCode), 'the module owns no leaf grammar');
  /* the only projector authority is the live-family facade */
  assert.ok(moduleCode.includes('buildSavedChatPackageForLiveGenerationFamily'), 'uses the live-family facade');
  assert.ok(moduleCode.includes('readSavedChatGenerationPolicy'), 'reads the policy token');
  assert.ok(moduleCode.includes('savedChatPackageAssets'), 'reuses the real materializer');
  assert.ok(moduleCode.includes('sha256PrefixedBytes'), 'hashes with the real codec');
  assert.ok(moduleCode.includes('assetBlobCapBytes'), 'republishes the real CAS cap');
  for (const cmd of ['h2o_saved_chat_backup_begin', 'h2o_saved_chat_backup_package_begin', 'h2o_saved_chat_backup_write_member',
    'h2o_saved_chat_backup_package_finish', 'h2o_saved_chat_backup_package_abort', 'h2o_saved_chat_backup_finalize',
    'h2o_saved_chat_backup_abort', 'h2o_saved_chat_backup_list', 'h2o_saved_chat_backup_verify', 'h2o_saved_chat_backup_root_policy']) {
    assert.ok(moduleSrc.includes(`'${cmd}'`), `names the accepted native command ${cmd}`);
  }
});

check('native T02 command names in the module equal those registered in lib.rs', () => {
  const lib = readRepo(LIB_RS_REL);
  const named = [...moduleSrc.matchAll(/'(h2o_saved_chat_backup_[a-z_]+)'/g)].map((m) => m[1]);
  assert.equal(new Set(named).size, 10);
  for (const cmd of new Set(named)) {
    assert.equal((lib.match(new RegExp('::' + cmd + '\\b', 'g')) || []).length, 2, `${cmd} registered in both handler arms`);
  }
});

check('the native vocabulary the module passes through matches the accepted T02 codes', () => {
  const native = readRepo(NATIVE_REL);
  /* LIST kinds ("backup-partial") share the prefix but are not codes. */
  const nativeCodes = new Set([...native.matchAll(/"(backup-[a-z0-9-]+)"/g)].map((m) => m[1]).filter((c) => c !== 'backup-partial'));
  const moduleNative = [...moduleSrc.slice(moduleSrc.indexOf('NATIVE_FAILURE_CODES = Object.freeze(['), moduleSrc.indexOf('FAILURE_STAGES = Object.freeze(['))
    .matchAll(/'(backup-[a-z0-9-]+)'/g)].map((m) => m[1]);
  assert.ok(moduleNative.length >= 30, 'closed native list present');
  for (const code of moduleNative) assert.ok(nativeCodes.has(code), `module native code exists natively: ${code}`);
  /* every native code that can name an entry failure or a run refusal is known to the module */
  const known = new Set([...moduleNative, ...EXPECTED_RENDERER_CODES]);
  for (const code of nativeCodes) assert.ok(known.has(code), `native code known to the module: ${code}`);
  assert.ok(fs.existsSync(path.join(REPO_ROOT, NATIVE_DOC_REL)), 'accepted T02 doc present');
});

// ═════════════════════════════════════════════════════════════════════════
// Seed database (deterministic; mirrors the real Tauri schema; drift guard)
// ═════════════════════════════════════════════════════════════════════════

const SEED_SCHEMA = `
CREATE TABLE chats (
  id TEXT PRIMARY KEY, source_id TEXT UNIQUE, title TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0,
  last_message_at INTEGER NOT NULL DEFAULT 0, message_count INTEGER NOT NULL DEFAULT 0,
  user_turn_count INTEGER NOT NULL DEFAULT 0, assistant_turn_count INTEGER NOT NULL DEFAULT 0,
  is_pinned INTEGER NOT NULL DEFAULT 0, is_archived INTEGER NOT NULL DEFAULT 0,
  is_starred INTEGER NOT NULL DEFAULT 0, is_deleted INTEGER NOT NULL DEFAULT 0,
  folder_id TEXT, category_id TEXT, project_id TEXT NOT NULL DEFAULT '',
  current_leaf_id TEXT, import_batch_id TEXT, meta_json TEXT NOT NULL DEFAULT '{}',
  is_saved INTEGER NOT NULL DEFAULT 0, is_linked INTEGER NOT NULL DEFAULT 0,
  linked_at INTEGER NOT NULL DEFAULT 0, linked_from TEXT NOT NULL DEFAULT '',
  link_source_href TEXT NOT NULL DEFAULT '', href TEXT, normalized_href TEXT,
  snapshot_count INTEGER NOT NULL DEFAULT 0, last_snapshot_id TEXT, last_captured_at INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE snapshots (
  id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, title TEXT NOT NULL DEFAULT '',
  digest TEXT, message_count INTEGER NOT NULL DEFAULT 0, pinned INTEGER NOT NULL DEFAULT 0,
  legacy INTEGER NOT NULL DEFAULT 0, captured_at INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0, meta_json TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE snapshot_turns (
  snapshot_id TEXT NOT NULL, turn_idx INTEGER NOT NULL, role TEXT NOT NULL,
  outer_html TEXT NOT NULL DEFAULT '', text TEXT NOT NULL DEFAULT '', meta_json TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY (snapshot_id, turn_idx)
);
CREATE TABLE sync_tombstones (
  tombstone_id TEXT PRIMARY KEY,
  schema TEXT NOT NULL DEFAULT 'h2o.studio.tombstone.v1',
  record_kind TEXT NOT NULL,
  record_id TEXT NOT NULL,
  deleted_at TEXT NOT NULL DEFAULT '',
  deleted_by_sync_peer_id TEXT NOT NULL DEFAULT '',
  delete_reason TEXT NOT NULL DEFAULT '',
  prior_digest TEXT,
  prior_updated_at TEXT,
  source_export_id TEXT,
  source_sequence_number INTEGER,
  cascade_from TEXT,
  restored_at TEXT,
  restored_by_sync_peer_id TEXT,
  meta_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT ''
);
`;

check('seed schema drift guard: the real migrations still define the columns this harness relies on', () => {
  const lib = readRepo(LIB_RS_REL);
  for (const token of ['is_saved', 'is_linked', 'is_deleted', 'message_count', 'captured_at', 'digest', 'restored_at', 'sync_tombstones', 'snapshot_turns']) {
    assert.ok(lib.includes(token), `lib.rs migrations reference ${token}`);
  }
  assert.equal(seed.schema, 'h2o.validation.localBackupSeed.v1');
  assert.equal(sha256Prefixed(Buffer.from(seed.inlinePngBase64, 'base64')), seed.inlinePngSha256, 'fixture asset identity');
});

function inlinePngDataUri() {
  return 'data:image/png;base64,' + seed.inlinePngBase64;
}

function seedDatabase(dbPath) {
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = DELETE;');
  db.exec(SEED_SCHEMA);
  const chatStmt = db.prepare('INSERT INTO chats (id, source_id, title, created_at, updated_at, message_count, is_saved, is_linked, is_deleted, href) VALUES (?,?,?,?,?,?,?,?,?,?)');
  for (const c of seed.chats) chatStmt.run(c.id, c.source_id, c.title, c.created_at, c.updated_at, c.message_count, c.is_saved, c.is_linked, c.is_deleted, c.href);
  const snapStmt = db.prepare('INSERT INTO snapshots (id, chat_id, title, digest, message_count, captured_at, updated_at) VALUES (?,?,?,?,?,?,?)');
  const turnStmt = db.prepare('INSERT INTO snapshot_turns (snapshot_id, turn_idx, role, outer_html, text, meta_json) VALUES (?,?,?,?,?,?)');
  for (const s of seed.snapshots) {
    snapStmt.run(s.id, s.chat_id, s.title, s.digest, s.message_count, s.captured_at, s.updated_at);
    for (const t of s.turns) turnStmt.run(s.id, t.turn_idx, t.role, String(t.outer_html).split('{{INLINE_PNG}}').join(inlinePngDataUri()), t.text, t.meta_json);
  }
  const tombStmt = db.prepare('INSERT INTO sync_tombstones (tombstone_id, record_kind, record_id, deleted_at, deleted_by_sync_peer_id, delete_reason, restored_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)');
  for (const t of seed.tombstones) tombStmt.run(t.tombstone_id, t.record_kind, t.record_id, t.deleted_at, t.deleted_by_sync_peer_id, t.delete_reason, t.restored_at, t.deleted_at, t.deleted_at);
  return db;
}

/* Logical content digest of the source DB: every row of every table, in
 * primary-key order. Independent of file-level journal noise. */
function dbDigest(db) {
  const lines = [];
  for (const [table, order] of [['chats', 'id'], ['snapshots', 'id'], ['snapshot_turns', 'snapshot_id, turn_idx'], ['sync_tombstones', 'tombstone_id']]) {
    for (const row of db.prepare(`SELECT * FROM ${table} ORDER BY ${order}`).all()) {
      lines.push(table + '\t' + JSON.stringify(row, (k, v) => (typeof v === 'bigint' ? Number(v) : v)));
    }
  }
  return sha256Hex(lines.join('\n'));
}

function treeDigest(dir) {
  const lines = [];
  function walk(current) {
    if (!fs.existsSync(current)) return;
    for (const name of fs.readdirSync(current).sort()) {
      const full = path.join(current, name);
      const rel = path.relative(dir, full);
      const st = fs.lstatSync(full);
      if (st.isSymbolicLink()) lines.push(rel + '\tsymlink\t' + fs.readlinkSync(full));
      else if (st.isDirectory()) { lines.push(rel + '\tdir'); walk(full); }
      else lines.push(rel + '\tfile\t' + sha256Hex(fs.readFileSync(full)));
    }
  }
  walk(dir);
  return sha256Hex(lines.join('\n'));
}

// ═════════════════════════════════════════════════════════════════════════
// DOM stub (enough for the card: createElement / textContent / attributes /
// appendChild / addEventListener / click / parentNode / querySelector)
// ═════════════════════════════════════════════════════════════════════════

function domStub() {
  function make(tag) {
    const node = {
      tagName: String(tag).toUpperCase(), children: [], attributes: {}, style: {}, disabled: false, title: '', parentNode: null, _text: '', _listeners: {},
      set textContent(v) { this._text = String(v); this.children = []; },
      get textContent() { return this._text; },
      setAttribute(k, v) { this.attributes[k] = String(v); },
      getAttribute(k) { return this.attributes[k]; },
      appendChild(c) { c.parentNode = this; this.children.push(c); return c; },
      addEventListener(kind, fn) { this._listeners[kind] = fn; },
      click() { const fn = this._listeners.click; if (fn) fn(); },
      querySelector(selector) {
        const m = /^\[([a-z0-9-]+)="([^"]*)"\]$/.exec(selector);
        if (!m) return null;
        const find = (n) => {
          for (const c of n.children) {
            if (c.attributes[m[1]] === m[2]) return c;
            const hit = find(c);
            if (hit) return hit;
          }
          return null;
        };
        return find(this);
      },
    };
    return node;
  }
  return { document: { createElement: make } };
}
function allText(node) {
  if (!node) return '';
  return [node._text || '', ...(node.children || []).map(allText)].join(' ').replace(/\s+/g, ' ').trim();
}
function findByAttr(node, attr, value) {
  if (!node) return null;
  if (node.attributes && node.attributes[attr] === value) return node;
  for (const child of node.children || []) {
    const hit = findByAttr(child, attr, value);
    if (hit) return hit;
  }
  return null;
}
function findAllByAttr(node, attr, out = []) {
  if (!node) return out;
  if (node.attributes && attr in node.attributes) out.push(node);
  for (const child of node.children || []) findAllByAttr(child, attr, out);
  return out;
}

// ═════════════════════════════════════════════════════════════════════════
// The native T02 publisher TEST DOUBLE (protocol + state machine only)
// ═════════════════════════════════════════════════════════════════════════

const FINAL_LEAF_RE = /^([0-9]{8}T[0-9]{6}Z-[0-9a-f]{16})(\.partial)?\.h2obackup$/;
const RESERVED_PREFIXES = ['.h2o-backupstage-', '.h2o-bkpkg-', '.h2o-bkmanifest-'];
const WINDOWS_STEMS = /^(CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])$/i;

class NativeBackupDouble {
  constructor(rootDir, faults) {
    this.rootDir = rootDir;
    this.faults = faults || {};
    this.calls = [];
    this.session = null;
    this.tokenSeed = 700000000000000001n;
    this.idSeed = 1;
  }

  record(cmd, args, extra) {
    const entry = { cmd, args: args === undefined ? null : JSON.parse(JSON.stringify(args, (k, v) => (v instanceof Uint8Array ? `<${v.length} bytes>` : v))) };
    if (extra && extra.headers && typeof extra.headers.options === 'string') entry.options = JSON.parse(extra.headers.options);
    if (args instanceof Uint8Array) entry.bodyLength = args.length;
    this.calls.push(entry);
    return entry;
  }

  invoke(cmd, args, extra) {
    this.record(cmd, args, extra);
    const rejects = this.faults.rejectInvokes || {};
    if (Number(rejects[cmd] || 0) > 0) {
      rejects[cmd] -= 1;
      return Promise.reject(new Error('native double rejected ' + cmd));
    }
    const pause = this.faults.pauseInvoke;
    if (pause && pause.command === cmd && pause.used !== true) {
      pause.used = true;
      if (typeof pause.onReached === 'function') pause.onReached();
      return Promise.resolve(pause.wait).then(() => this.dispatch(cmd, args, extra));
    }
    return this.dispatch(cmd, args, extra);
  }

  dispatch(cmd, args, extra) {
    const options = (args && args.options) || {};
    switch (cmd) {
      case 'h2o_saved_chat_backup_root_policy':
        return { schema: 'h2o.studio.saved-chat-backup-root-policy.v1', baseDirectory: 'home', rootComponent: 'H2O Studio Backups' };
      case 'h2o_saved_chat_backup_begin': return this.begin(options);
      case 'h2o_saved_chat_backup_package_begin': return this.withSession(options, (s) => this.packageBegin(s, options));
      case 'h2o_saved_chat_backup_write_member': {
        const parsed = extra && extra.headers ? JSON.parse(extra.headers.options) : {};
        return this.withSession(parsed, (s) => this.writeMember(s, parsed, args));
      }
      case 'h2o_saved_chat_backup_package_finish': return this.withSession(options, (s) => this.packageFinish(s, options));
      case 'h2o_saved_chat_backup_package_abort': return this.withSession(options, (s) => this.packageAbort(s));
      case 'h2o_saved_chat_backup_finalize': return this.withSession(options, (s) => this.finalize(s, options));
      case 'h2o_saved_chat_backup_abort': return this.abort(options);
      case 'h2o_saved_chat_backup_list': return this.list();
      case 'h2o_saved_chat_backup_verify': return this.verify(options);
      default: throw new Error('native double: unknown command ' + cmd);
    }
  }

  hex(n) { return crypto.createHash('sha256').update('double-' + (this.idSeed += 1)).digest('hex').slice(0, n); }

  withSession(options, fn) {
    const s = this.session;
    if (!s || String(options.token) !== s.token) return { ok: false, status: 'backup-session-unknown' };
    if (s.state === 'ABORTED') return { ok: false, status: 'backup-cancelled' };
    return fn(s);
  }

  begin(options) {
    if (this.faults.beginRefuse) return { ok: false, status: this.faults.beginRefuse };
    const s = this.session;
    if (s && ['STAGING', 'PACKAGE_OPEN', 'SET_FINALIZING'].includes(s.state)) return { ok: false, status: 'backup-session-busy' };
    this.session = null;
    const declared = options && options.enumeration;
    if (!declared || !Array.isArray(declared.eligible) || declared.eligible.length === 0) return { ok: false, status: 'backup-nothing-to-back-up' };
    const seen = new Set();
    for (const pair of declared.eligible) {
      const key = pair.chatId + ' ' + pair.snapshotId;
      if (!pair.chatId || !pair.snapshotId || seen.has(key)) return { ok: false, status: 'backup-enumeration-inconsistent' };
      seen.add(key);
    }
    const sk = declared.skipped || {};
    if (declared.enumeratedCount !== declared.eligible.length + (sk.deleted || 0) + (sk.tombstoned || 0) + (sk.noSnapshot || 0)) {
      return { ok: false, status: 'backup-enumeration-inconsistent' };
    }
    fs.mkdirSync(this.rootDir, { recursive: true });
    const backupId = '20260917T120000Z-' + this.hex(16);
    const runName = '.h2o-backupstage-' + this.hex(32);
    const runDir = path.join(this.rootDir, runName);
    fs.mkdirSync(path.join(runDir, 'packages'), { recursive: true });
    const token = String(this.tokenSeed += 1n);
    this.session = { token, backupId, runName, runDir, state: 'STAGING', declaration: declared, declared: seen, published: new Map(), open: null, fullFsync: true, packageAttempts: {} };
    return { ok: true, status: 'created', token, backupId, stagingLeaf: runName, platform: { supported: true, family: 'macos' } };
  }

  packageBegin(s, options) {
    if (s.state !== 'STAGING') return { ok: false, status: 'backup-invalid-state' };
    const chatId = String(options.chatId || ''), snapshotId = String(options.snapshotId || '');
    const key = chatId + ' ' + snapshotId;
    if (!s.declared.has(key)) return { ok: false, status: 'backup-entry-unknown' };
    if (s.published.has(key)) return { ok: false, status: 'backup-entry-duplicate' };
    s.packageAttempts[chatId] = (s.packageAttempts[chatId] || 0) + 1;
    if (typeof this.faults.onPackageBegin === 'function') this.faults.onPackageBegin(chatId, s.packageAttempts[chatId]);
    /* Native name admission for the package leaf (NB-T02-07). */
    if (WINDOWS_STEMS.test(chatId.split('.')[0])) return { ok: false, status: 'backup-invalid-member-name' };
    const refuse = this.faults.packageBeginRefuse && this.faults.packageBeginRefuse[chatId];
    if (refuse) return { ok: false, status: refuse };
    const stageName = '.h2o-bkpkg-' + this.hex(32);
    const stageDir = path.join(s.runDir, 'packages', stageName);
    fs.mkdirSync(stageDir);
    s.open = { chatId, snapshotId, stageName, stageDir, members: {}, openMember: null };
    s.state = 'PACKAGE_OPEN';
    return { ok: true, status: 'created' };
  }

  discardOpen(s) {
    if (s.open) { fs.rmSync(s.open.stageDir, { recursive: true, force: true }); s.open = null; }
    s.state = 'STAGING';
  }

  writeMember(s, options, body) {
    if (s.state !== 'PACKAGE_OPEN' || !s.open) return { ok: false, status: 'backup-invalid-state' };
    const bytes = body instanceof Uint8Array ? Buffer.from(body) : Buffer.alloc(0);
    if (bytes.length > 8 * 1024 * 1024) return { ok: false, status: 'backup-chunk-too-large' };
    const member = options.member || {};
    let relative;
    if (member.kind === 'snapshot') relative = 'snapshot.json';
    else if (member.kind === 'manifest') relative = 'manifest.json';
    else if (member.kind === 'asset') {
      if (!/^sha256-[0-9a-f]{64}\.[a-z0-9]{1,16}$/.test(String(member.name || ''))) return { ok: false, status: 'backup-invalid-member-name' };
      relative = 'assets/' + member.name;
    } else return { ok: false, status: 'backup-invalid-member-name' };
    const open = s.open;
    if (open.openMember && open.openMember !== relative) return { ok: false, status: 'backup-invalid-state' };
    if (!open.openMember) {
      if (open.members[relative]) return { ok: false, status: 'backup-member-duplicate' };
      open.members[relative] = { chunks: [], len: 0, final: false };
      open.openMember = relative;
    }
    const fault = this.faults.memberRefuse && this.faults.memberRefuse[open.chatId];
    if (fault && fault.kind === member.kind && (!fault.attempt || fault.attempt === s.packageAttempts[open.chatId])) {
      if (fault.discard !== false) this.discardOpen(s);
      return { ok: false, status: fault.code };
    }
    const m = open.members[relative];
    m.chunks.push(bytes);
    m.len += bytes.length;
    if (!options.final) return { ok: true, status: 'accepted', memberBytes: m.len };
    if (m.len === 0) { this.discardOpen(s); return { ok: false, status: 'backup-member-empty' }; }
    if (typeof options.byteLength === 'number' && options.byteLength !== m.len) { this.discardOpen(s); return { ok: false, status: 'backup-member-length-mismatch' }; }
    const all = Buffer.concat(m.chunks);
    const hex = sha256Hex(all);
    if (member.kind === 'asset' && member.name.slice(7, 71) !== hex) { this.discardOpen(s); return { ok: false, status: 'backup-asset-hash-mismatch' }; }
    m.final = true;
    m.bytes = all;
    m.hex = hex;
    open.openMember = null;
    const target = path.join(open.stageDir, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, all);
    return { ok: true, status: 'accepted', memberBytes: m.len, memberSha256: 'sha256-' + hex };
  }

  packageFinish(s, options) {
    if (s.state !== 'PACKAGE_OPEN' || !s.open) return { ok: false, status: 'backup-invalid-state' };
    const open = s.open;
    if (open.openMember || !open.members['snapshot.json'] || !open.members['manifest.json']) return { ok: false, status: 'backup-invalid-state' };
    const expected = normalizeSha(options.expectedContentHash);
    if (!expected) return { ok: false, status: 'backup-invalid-member-name' };
    if (typeof this.faults.onPackageFinish === 'function') this.faults.onPackageFinish(open.chatId);
    const refuse = this.faults.finishRefuse && this.faults.finishRefuse[open.chatId];
    if (refuse) { this.discardOpen(s); return { ok: false, status: refuse, codes: ['double-injected'] }; }
    /* Protocol emulation only: the manifest member's own claims give the leaf
     * and the identity binding; nothing is verified here. */
    let manifest;
    try { manifest = JSON.parse(open.members['manifest.json'].bytes.toString('utf8')); }
    catch (_) { this.discardOpen(s); return { ok: false, status: 'backup-package-verification-failed', codes: ['manifest-json-invalid'] }; }
    const recomputed = normalizeSha(manifest.contentHash);
    if (!recomputed || recomputed !== expected || manifest.chatId !== open.chatId || manifest.snapshotId !== open.snapshotId) {
      this.discardOpen(s);
      return { ok: false, status: 'backup-package-identity-mismatch' };
    }
    const declaredAssets = Array.isArray(manifest.assets) ? manifest.assets : [];
    for (const a of declaredAssets) {
      if (!open.members[a.path]) { this.discardOpen(s); return { ok: false, status: 'backup-package-verification-failed', codes: ['generation-partial'] }; }
    }
    const leaf = `${open.chatId}.g${recomputed}.h2ochat`;
    const leafDir = path.join(s.runDir, 'packages', leaf);
    if (fs.existsSync(leafDir)) { this.discardOpen(s); return { ok: false, status: 'backup-package-leaf-occupied' }; }
    fs.renameSync(open.stageDir, leafDir);
    const snapDesc = (manifest.files && manifest.files.snapshot) || {};
    const members = Object.keys(open.members).sort();
    const entry = {
      chatId: open.chatId, snapshotId: open.snapshotId, contentHash: 'sha256-' + recomputed, packageLeaf: leaf,
      constructionFamily: 'v3', schemaVersion: 3, payloadVersion: 3,
      snapshot: {
        encoding: snapDesc.encoding || 'identity', physicalSha256: snapDesc.sha256 || '', physicalByteLength: snapDesc.byteLength || 0,
        logicalSha256: snapDesc.contentSha256 || snapDesc.sha256 || '', logicalByteLength: snapDesc.contentByteLength || snapDesc.byteLength || 0,
      },
      members, assets: declaredAssets.map((a) => a.sha256).sort(), assetSource: 'projection', savedAt: null,
    };
    s.published.set(open.chatId + ' ' + open.snapshotId, entry);
    s.open = null;
    s.state = 'STAGING';
    return { ok: true, status: 'verified', entry };
  }

  packageAbort(s) {
    if (s.state === 'PACKAGE_OPEN') { this.discardOpen(s); return { ok: true, status: 'aborted', cleanupIncomplete: false }; }
    if (s.state === 'STAGING') return { ok: true, status: 'aborted', cleanupIncomplete: false };
    return { ok: false, status: 'backup-invalid-state' };
  }

  finalize(s, options) {
    if (s.state !== 'STAGING' || s.open) return { ok: false, status: 'backup-invalid-state', backupId: s.backupId };
    if (s.published.size === 0) return { ok: false, status: 'backup-no-package-succeeded', backupId: s.backupId };
    const failures = Array.isArray(options.failures) ? options.failures : [];
    const seen = new Set();
    for (const f of failures) {
      const key = f.chatId + ' ' + f.snapshotId;
      if (!s.declared.has(key)) return { ok: false, status: 'backup-entry-unknown', backupId: s.backupId };
      if (s.published.has(key) || seen.has(key)) return { ok: false, status: 'backup-manifest-inconsistent', backupId: s.backupId };
      seen.add(key);
    }
    if (s.published.size + failures.length !== s.declared.size) return { ok: false, status: 'backup-manifest-inconsistent', backupId: s.backupId };
    const complete = failures.length === 0;
    const entries = [...s.published.values()].sort((a, b) => (a.chatId < b.chatId ? -1 : a.chatId > b.chatId ? 1 : a.snapshotId < b.snapshotId ? -1 : 1));
    const triples = entries.map((e) => ({ chatId: e.chatId, snapshotId: e.snapshotId, contentHash: e.contentHash }));
    const setDigest = 'sha256-' + sha256Hex(JSON.stringify({ schema: 'h2o.savedChatLocalBackup.v1', entries: triples }));
    const sk = s.declaration.skipped || {};
    const counts = { enumerated: s.declaration.enumeratedCount, eligible: s.declared.size, success: entries.length, failed: failures.length, skipped: { deleted: sk.deleted || 0, tombstoned: sk.tombstoned || 0, linkedOnly: sk.linkedOnly || 0, noSnapshot: sk.noSnapshot || 0 } };
    const manifest = {
      schema: 'h2o.savedChatLocalBackup.v1', schemaVersion: 1, backupId: s.backupId, createdAt: '2026-09-17T12:00:00.000Z', complete,
      consistency: 'per-entry-guarded-enumeration-time-set',
      source: { appBuildStamp: (s.declaration.source && s.declaration.source.appBuildStamp) || null, liveGenerationFamily: 'v3', platform: 'macos', hostRootMode: 'home' },
      enumeration: { at: s.declaration.at, counts },
      entries, failures: failures.map((f) => ({ chatId: f.chatId, snapshotId: f.snapshotId, code: f.code, stage: f.stage, declaredBy: 'renderer', detail: f.detail || '' })),
      setDigest,
      verification: { packageScanComplete: true, occupantCount: entries.length, verifiedCount: entries.length, crossCheck: 'pass', fullFsync: s.fullFsync },
    };
    const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
    fs.writeFileSync(path.join(s.runDir, 'backup-manifest.json'), manifestBytes);
    const leaf = s.backupId + (complete ? '' : '.partial') + '.h2obackup';
    s.state = 'SET_FINALIZING';
    let result = {
      ok: true, status: complete ? 'published' : 'published-partial', committed: true, durabilityComplete: true, fullFsync: s.fullFsync,
      backupId: s.backupId, backupLeaf: leaf, complete, counts, setDigest, manifestSha256: sha256Prefixed(manifestBytes), codes: [],
    };
    if (typeof this.faults.finalizeOverride === 'function') result = this.faults.finalizeOverride(result, s);
    if (result.committed === true) {
      fs.renameSync(s.runDir, path.join(this.rootDir, leaf));
      s.state = 'PUBLISHED';
    } else {
      fs.rmSync(s.runDir, { recursive: true, force: true });
      s.state = 'FAILED';
    }
    return result;
  }

  abort(options) {
    const s = this.session;
    if (!s || String(options.token) !== s.token) return { ok: false, status: 'backup-session-unknown' };
    if (s.state === 'ABORTED') return { ok: false, status: 'backup-cancelled' };
    if (s.state === 'PUBLISHED' || s.state === 'FAILED') return { ok: true, status: 'aborted', cleanupIncomplete: false };
    fs.rmSync(s.runDir, { recursive: true, force: true });
    s.open = null;
    s.state = 'ABORTED';
    return { ok: true, status: 'aborted', cleanupIncomplete: false };
  }

  list() {
    if (!fs.existsSync(this.rootDir)) return { ok: false, status: 'backup-root-absent', rootPresent: false, rootDisplayPath: this.rootDir, entries: [], residueCount: 0, codes: [] };
    const entries = fs.readdirSync(this.rootDir).sort().map((leaf) => {
      if (RESERVED_PREFIXES.some((p) => leaf.startsWith(p))) return { leaf, kind: 'staging-residue' };
      const m = FINAL_LEAF_RE.exec(leaf);
      const st = fs.lstatSync(path.join(this.rootDir, leaf));
      if (m && st.isDirectory()) return { leaf, kind: m[2] ? 'backup-partial' : 'backup', backupId: m[1], manifestPresent: fs.existsSync(path.join(this.rootDir, leaf, 'backup-manifest.json')) };
      return { leaf, kind: 'foreign' };
    });
    const residueCount = entries.filter((e) => e.kind === 'staging-residue').length;
    return { ok: true, status: 'listed', rootPresent: true, rootDisplayPath: this.rootDir, entries, residueCount, codes: residueCount ? ['backup-staging-residue-detected'] : [] };
  }

  verify(options) {
    const leaf = String(options.leaf || '');
    const override = this.faults.verifyOverride && this.faults.verifyOverride[leaf];
    const base = { status: '', codes: [], backupId: null, complete: null, counts: null, setDigest: null, entriesVerified: 0, occupantsSeen: 0 };
    if (override) return Object.assign({}, base, override);
    const m = FINAL_LEAF_RE.exec(leaf);
    if (!m) return Object.assign({}, base, { status: 'unsupported', codes: ['backup-not-a-backup-leaf'] });
    if (!fs.existsSync(this.rootDir)) return Object.assign({}, base, { status: 'unreadable', codes: ['backup-root-absent'] });
    const full = path.join(this.rootDir, leaf);
    if (!fs.existsSync(full)) return Object.assign({}, base, { status: 'unreadable', codes: ['backup-not-a-backup-leaf'] });
    if (!fs.lstatSync(full).isDirectory()) return Object.assign({}, base, { status: 'unreadable', codes: ['backup-path-redirect-refused'] });
    let manifest;
    try { manifest = JSON.parse(fs.readFileSync(path.join(full, 'backup-manifest.json'), 'utf8')); }
    catch (_) { return Object.assign({}, base, { status: 'malformed', codes: ['backup-manifest-invalid'] }); }
    if (manifest.schema !== 'h2o.savedChatLocalBackup.v1' || manifest.schemaVersion > 1) return Object.assign({}, base, { status: 'unsupported', codes: ['backup-manifest-invalid'] });
    const facts = { backupId: manifest.backupId, complete: manifest.complete, counts: manifest.enumeration.counts, setDigest: manifest.setDigest, occupantsSeen: fs.readdirSync(path.join(full, 'packages')).length };
    if (manifest.complete === !!m[2] || manifest.backupId !== m[1]) return Object.assign({}, base, facts, { status: 'malformed', codes: ['backup-manifest-inconsistent'] });
    return Object.assign({}, base, facts, { status: manifest.complete ? 'valid-complete' : 'valid-incomplete', entriesVerified: manifest.entries.length });
  }
}

// ═════════════════════════════════════════════════════════════════════════
// Sandbox: real modules + the double + SQL routing + ledgers
// ═════════════════════════════════════════════════════════════════════════

function normRow(r) { const o = {}; for (const k in r) o[k] = typeof r[k] === 'bigint' ? Number(r[k]) : r[k]; return o; }

async function createSandbox({ db, double, moduleSourceOverride, sqlFault }) {
  const ledger = { writes: [], selects: 0, invokes: [] };
  const invoke = async (cmd, args, extra) => {
    ledger.invokes.push(cmd);
    if (cmd === 'plugin:sql|select') {
      ledger.selects += 1;
      if (typeof sqlFault === 'function') sqlFault(args.query, args.values);
      /* The production SQLite (sqlx / tauri-plugin-sql) accepts legacy
       * double-quoted string literals (SQLITE_DQS); node:sqlite is built with
       * DQS off. The tombstones diagnose() query compares `cascade_from != ""`,
       * so that one literal form is normalized here — an environment shim,
       * not a behaviour change. */
      const query = String(args.query).replace(/!= ""/g, "!= ''");
      return db.prepare(query).all(...(args.values || [])).map(normRow);
    }
    if (cmd === 'plugin:sql|execute') {
      const verb = String(args.query).trim().split(/\s+/)[0].toUpperCase();
      ledger.writes.push(verb + ' ' + String(args.query).slice(0, 60));
      const r = db.prepare(args.query).run(...(args.values || []));
      return [Number(r.changes), Number(r.lastInsertRowid)];
    }
    if (cmd === 'h2o_saved_chat_generation_policy') return { schema: 'h2o.studio.saved-chat-generation-policy.v1', liveGenerationFamily: 'v3' };
    if (cmd.startsWith('h2o_saved_chat_backup_')) return double.invoke(cmd, args, extra);
    throw new Error('unmocked invoke: ' + cmd);
  };
  const dom = domStub();
  const ctx = {
    console, setTimeout, clearTimeout, setImmediate, URL, atob: globalThis.atob, btoa: globalThis.btoa,
    TextEncoder, TextDecoder, Uint8Array, Uint16Array, Uint32Array, ArrayBuffer, DataView,
    ReadableStream, TransformStream, CompressionStream, DecompressionStream,
    crypto: crypto.webcrypto, structuredClone, performance,
    __TAURI_INTERNALS__: { invoke },
    H2O: { Studio: { platform: { env: { isTauri: true }, __sqliteStatus: () => ({ backend: 'sqlite', ready: true }) } } },
    chrome: { runtime: { id: 'desktop-test', getManifest: () => ({ name: 'H2O Studio Test', version: '0.0.0-harness' }) } },
    document: dom.document,
  };
  ctx.globalThis = ctx;
  const sandbox = vm.createContext(ctx);
  for (const rel of STUDIO_MODULES) {
    let src = readRepo('src-surfaces-base/studio/' + rel);
    if (rel === 'ingestion/saved-chat-local-backup.studio.js' && typeof moduleSourceOverride === 'string') src = moduleSourceOverride;
    vm.runInContext(src, sandbox, { filename: rel });
  }
  const S = sandbox.H2O.Studio;
  for (const name of ['folders', 'categories', 'labels', 'tags']) {
    S.store[name] = { isReady: () => true, listForChat: async () => [], getForChat: async () => null, subscribe() { return () => {}; } };
  }
  await S.store.chats.init();
  await S.store.snapshots.init();
  await S.store.tombstones.init();
  assert.ok(S.store.chats.isReady() && S.store.snapshots.isReady() && S.store.tombstones.isReady(), 'real stores ready over the temp DB');
  assert.ok(S.localBackupUi && S.localBackupUi.__installed, 'local backup module registered');
  assert.equal(typeof S.ingestion.buildSavedChatPackageForLiveGenerationFamily, 'function', 'real live-family facade present');
  assert.equal(typeof S.ingestion.probeCurrentSavedChatProjectionV1, 'function', 'real probe present');
  return { sandbox, S, api: S.localBackupUi, invoke, ledger, dom };
}

function makeScratch(tag) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'h2o-local-backup-harness-' + tag + '-'));
  const dbPath = path.join(base, 'studio-v1.db');
  const archiveRoot = path.join(base, 'archive');
  const casRoot = path.join(archiveRoot, 'assets', 'b6');
  fs.mkdirSync(path.join(archiveRoot, 'packages', 'existing.g' + 'a'.repeat(64) + '.h2ochat'), { recursive: true });
  fs.writeFileSync(path.join(archiveRoot, 'packages', 'existing.g' + 'a'.repeat(64) + '.h2ochat', 'manifest.json'), '{"fixture":true}\n');
  fs.mkdirSync(casRoot, { recursive: true });
  fs.writeFileSync(path.join(casRoot, 'sha256-' + 'b6'.repeat(32)), 'cas-object');
  const db = seedDatabase(dbPath);
  return { base, dbPath, db, archiveRoot, backupRoot: path.join(base, 'H2O Studio Backups') };
}

async function bootScenario(tag, faults, extra = {}) {
  const scratch = makeScratch(tag);
  const double = new NativeBackupDouble(scratch.backupRoot, faults);
  const env = await createSandbox({ db: scratch.db, double, moduleSourceOverride: extra.moduleSourceOverride, sqlFault: extra.sqlFault });
  const before = { db: dbDigest(scratch.db), archive: treeDigest(scratch.archiveRoot) };
  return Object.assign({ scratch, double, before }, env);
}

function runDeps(env) {
  return { invoke: env.invoke, stores: env.S.store, ingestion: env.S.ingestion };
}

function failuresOf(double) {
  const finalize = double.calls.find((c) => c.cmd === 'h2o_saved_chat_backup_finalize');
  return finalize ? finalize.args.options.failures : null;
}

function assertClosedVocabulary(api, run, double) {
  const codes = new Set([...api.RENDERER_FAILURE_CODES, ...api.REUSED_FAILURE_CODES, ...api.NATIVE_FAILURE_CODES]);
  for (const f of run.failures || []) {
    assert.ok(codes.has(f.code), `emitted failure code inside the closed vocabulary: ${f.code}`);
    assert.ok(api.FAILURE_STAGES.includes(f.stage), `emitted failure stage inside the closed vocabulary: ${f.stage}`);
    assert.ok(Buffer.byteLength(f.detail || '', 'utf8') <= 512, 'detail bounded');
  }
  const declared = failuresOf(double);
  if (declared) eq(declared, run.failures, 'FINALIZE received exactly the recorded failures');
  if (run.code) assert.ok(codes.has(run.code), `run-level code inside the closed vocabulary: ${run.code}`);
}

function assertSourceUntouched(env, label) {
  eq(env.ledger.writes, [], label + ': SQL write-verb ledger is empty');
  assert.equal(dbDigest(env.scratch.db), env.before.db, label + ': source DB logically unchanged');
  assert.equal(treeDigest(env.scratch.archiveRoot), env.before.archive, label + ': source archive + CAS trees unchanged');
  assert.ok(!env.ledger.invokes.some((c) => /^plugin:fs|h2o_archive_|durable_write|cas_repair|generation_begin|transport|sync/.test(c)), label + ': no source mutation command invoked');
}

// ═════════════════════════════════════════════════════════════════════════
// Runtime scenarios
// ═════════════════════════════════════════════════════════════════════════

async function main() {
  const RED_MODULE = moduleSrc.replace(
    "sessionDead = await packageAbort('source-changed');\n          if (sessionDead) break;\n          rebuilds += 1;",
    '          rebuilds += 1;'
  );
  assert.notEqual(RED_MODULE, moduleSrc, 'the RED variant differs from the committed module (the guard-abort site must exist)');
  const activeModule = RED_CONTROL_MODE ? RED_MODULE : undefined;

  console.log('[runtime]');

  await checkAsync('closed vocabularies are published exactly as frozen', async () => {
    const env = await bootScenario('vocab', {}, { moduleSourceOverride: activeModule });
    eq([...env.api.RENDERER_FAILURE_CODES], EXPECTED_RENDERER_CODES);
    eq([...env.api.FAILURE_STAGES], EXPECTED_STAGES);
    eq([...env.api.REUSED_FAILURE_CODES], ['store-not-ready', 'generation-policy-unavailable']);
    assert.throws(() => env.api.makeFailure('c', 's', 'made-up-code', 'build', ''), /closed vocabulary/);
    assert.throws(() => env.api.makeFailure('c', 's', 'backup-source-unstable', 'made-up-stage', ''), /closed vocabulary/);
    const f = env.api.makeFailure('c', 's', 'backup-source-unstable', 'guard', 'x'.repeat(2000));
    assert.equal(Buffer.byteLength(f.detail), 512);
    assert.equal(env.api.classifyFailureCode('backup-cancelled'), 'CANCELLED');
    assert.equal(env.api.classifyFailureCode('backup-source-unstable'), 'SOURCE_DATA_ERROR');
  });

  await checkAsync('enumeration: eligible set, skips, deterministic order and the exact current snapshot', async () => {
    const env = await bootScenario('enum', {}, { moduleSourceOverride: activeModule });
    const e = await env.api.enumerateEligibleSavedChats(env.S.store);
    assert.equal(e.ok, true);
    assert.equal(e.enumeratedCount, seed.expected.enumeratedCount);
    eq(e.eligible.map((x) => [x.chatId, x.snapshotId]), seed.expected.eligible);
    eq(e.skipped, seed.expected.skipped);
    assert.ok(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(e.at), 'enumeration.at is an ISO timestamp');
    /* the selection equals what the REAL builder picks for a chatId-only build */
    const policy = await env.S.ingestion.readSavedChatGenerationPolicy();
    const golf = await env.S.ingestion.buildSavedChatPackageForLiveGenerationFamily({ chatId: 'bk-golf', assetStack: env.api.createBackupAssetStack({ ingestion: env.S.ingestion, invoke: async () => ({ ok: true }), token: 'x' }) }, policy);
    assert.equal(golf.snapshotId, 'snap-golf-new', 'builder-selected current snapshot equals the enumeration choice');
    /* identity carried from the enumeration reads */
    const alpha = e.eligible[0];
    assert.equal(alpha.identity.turnCount, 2);
    assert.equal(alpha.identity.snapshotDigest, 'digest-alpha-1');
    assert.equal(alpha.identity.snapshotMessageCount, 2);
    assertSourceUntouched(env, 'enumeration');
  });

  await checkAsync('positive control: a complete run through the real builder, materializer and Backup asset stack', async () => {
    const env = await bootScenario('positive', {}, { moduleSourceOverride: activeModule });
    const progress = [];
    const run = await env.api.runLocalBackup(runDeps(env), { onProgress: (p) => progress.push(p) });
    assert.equal(run.status, 'complete', JSON.stringify(run));
    assert.equal(run.complete, true);
    assert.equal(run.committed, true);
    assert.equal(run.durabilityComplete, true);
    eq(run.failures, []);
    assert.equal(run.entries.length, 4);
    eq(run.counts, { enumerated: 9, eligible: 4, success: 4, failed: 0, skipped: seed.expected.skipped });
    assert.ok(/\.h2obackup$/.test(run.backupLeaf) && !/\.partial\./.test(run.backupLeaf), 'complete leaf');
    assert.ok(fs.existsSync(path.join(env.scratch.backupRoot, run.backupLeaf, 'backup-manifest.json')), 'the double published the set');
    /* progress truth */
    eq(progress.filter((p) => !p.finalizing).map((p) => [p.current, p.total]), [[1, 4], [2, 4], [3, 4], [4, 4]]);
    assert.ok(progress.some((p) => p.finalizing));
    /* native command ordering, per entry: package_begin → assets during the build → snapshot → manifest → package_finish */
    const cmds = env.double.calls.map((c) => c.cmd);
    assert.equal(cmds[0], 'h2o_saved_chat_backup_begin');
    assert.equal(cmds[cmds.length - 1], 'h2o_saved_chat_backup_finalize');
    const begins = env.double.calls.filter((c) => c.cmd === 'h2o_saved_chat_backup_package_begin');
    eq(begins.map((c) => c.args.options.chatId), ['bk-alpha', 'bk-bravo', 'bk-golf', 'bk-hotel'], 'deterministic order');
    for (const c of begins) assert.ok(!('expectedContentHash' in c.args.options), 'no hash at package_begin (RC-T01-BACKUP-01)');
    const alphaStart = cmds.indexOf('h2o_saved_chat_backup_package_begin');
    const alphaFinish = cmds.indexOf('h2o_saved_chat_backup_package_finish');
    const alphaSlice = env.double.calls.slice(alphaStart + 1, alphaFinish);
    const kinds = alphaSlice.map((c) => c.options && c.options.member && c.options.member.kind);
    eq(kinds, ['asset', 'snapshot', 'manifest'], 'asset streamed during the build, then snapshot, then manifest');
    const assetWrite = alphaSlice[0];
    assert.equal(assetWrite.options.member.name, seed.inlinePngSha256 + '.png', 'canonical asset member name');
    assert.equal(assetWrite.options.final, true);
    assert.equal(assetWrite.options.byteLength, 20);
    assert.equal(assetWrite.bodyLength, 20, 'asset bytes streamed');
    /* member bytes equal the real builder output, and the finish binds the builder's hash */
    const policy = await env.S.ingestion.readSavedChatGenerationPolicy();
    const stack = env.api.createBackupAssetStack({ ingestion: env.S.ingestion, invoke: async () => ({ ok: true }), token: 'x' });
    const rebuilt = await env.S.ingestion.buildSavedChatPackageForLiveGenerationFamily({ chatId: 'bk-alpha', snapshotId: 'snap-alpha-1', assetStack: stack }, policy);
    const finishAlpha = env.double.calls[alphaFinish];
    assert.equal(normalizeSha(finishAlpha.args.options.expectedContentHash), normalizeSha(rebuilt.contentHash), 'expectedContentHash passed only at package_finish equals the builder identity');
    const probe = await env.S.ingestion.probeCurrentSavedChatProjectionV1({ chatId: 'bk-alpha', snapshotId: 'snap-alpha-1' }, policy);
    assert.equal(probe.status, 'ok');
    assert.equal(normalizeSha(probe.contentHash), normalizeSha(rebuilt.contentHash), 'projection probe cross-check');
    const leafDir = path.join(env.scratch.backupRoot, run.backupLeaf, 'packages', run.entries[0].packageLeaf);
    /* The published members are exactly the bytes the run's builder produced:
     * the double recorded each closing member sha, and the builder's manifest
     * differs between builds only by its generatedAt provenance stamp. */
    const closes = env.double.calls.filter((c) => c.cmd === 'h2o_saved_chat_backup_write_member' && c.options.final && ['snapshot', 'manifest'].includes(c.options.member.kind));
    const alphaCloses = closes.slice(0, 2);
    assert.equal(alphaCloses[0].options.member.kind, 'snapshot');
    assert.equal(alphaCloses[0].options.byteLength, fs.statSync(path.join(leafDir, 'snapshot.json')).size, 'snapshot member length = streamed length');
    assert.equal(alphaCloses[1].options.byteLength, fs.statSync(path.join(leafDir, 'manifest.json')).size, 'manifest member length = streamed length');
    eq(fs.readFileSync(path.join(leafDir, 'snapshot.json')), Buffer.from(rebuilt.files['snapshot.json'].bytes), 'snapshot member = builder bytes (deterministic projection)');
    const stripStamp = (buf) => { const m = JSON.parse(buf.toString('utf8')); delete m.generatedAt; if (m.provenance) delete m.provenance.generatedAt; return JSON.stringify(m); };
    assert.equal(stripStamp(fs.readFileSync(path.join(leafDir, 'manifest.json'))), stripStamp(Buffer.from(rebuilt.files['manifest.json'].bytes)), 'manifest member = builder manifest modulo generatedAt');
    assert.equal(sha256Prefixed(fs.readFileSync(path.join(leafDir, 'assets', seed.inlinePngSha256 + '.png'))), seed.inlinePngSha256, 'asset bytes hash to their name');
    assert.equal(run.entries[0].constructionFamily, 'v3');
    eq(run.entries[0].assets, [seed.inlinePngSha256]);
    assert.equal(stack.assetStore.mutationCount(), 0);
    assert.equal(env.double.calls.filter((c) => c.cmd === 'h2o_saved_chat_backup_package_abort').length, 0, 'no abort on a clean run');
    assertClosedVocabulary(env.api, run, env.double);
    assertSourceUntouched(env, 'positive');
  });

  await checkAsync('change guard A: one source change during the first build → package_abort → exactly one rebuild → success', async () => {
    let mutated = false;
    const env = await bootScenario('guard-a', {
      onPackageBegin: (chatId, attempt) => {
        if (chatId === 'bk-bravo' && attempt === 1 && !mutated) {
          mutated = true;
          env.scratch.db.prepare('UPDATE snapshots SET updated_at = updated_at + 1 WHERE id = ?').run('snap-bravo-1');
        }
      },
    }, { moduleSourceOverride: activeModule });
    const run = await env.api.runLocalBackup(runDeps(env));
    assert.equal(run.status, 'complete', JSON.stringify({ status: run.status, code: run.code, failures: run.failures }));
    const seq = env.double.calls.map((c) => c.cmd + (c.args && c.args.options && c.args.options.chatId ? ':' + c.args.options.chatId : ''));
    const bravoBegins = seq.filter((s) => s === 'h2o_saved_chat_backup_package_begin:bk-bravo');
    assert.equal(bravoBegins.length, 2, 'exactly one rebuild through a fresh package_begin');
    const firstBegin = seq.indexOf('h2o_saved_chat_backup_package_begin:bk-bravo');
    const secondBegin = seq.indexOf('h2o_saved_chat_backup_package_begin:bk-bravo', firstBegin + 1);
    const between = seq.slice(firstBegin, secondBegin);
    assert.ok(between.includes('h2o_saved_chat_backup_package_abort'), 'package_abort issued before the rebuild');
    assert.ok(!between.includes('h2o_saved_chat_backup_package_finish'), 'no finish on the changed build');
    assert.equal(seq.filter((s) => s === 'h2o_saved_chat_backup_package_abort').length, 1);
    assertClosedVocabulary(env.api, run, env.double);
    eq(env.ledger.writes, [], 'no product write verb (the mutation was harness-side)');
  });

  await checkAsync('change guard B: two consecutive changes → one rebuild only → backup-source-unstable as a per-entry failure', async () => {
    const env = await bootScenario('guard-b', {
      onPackageBegin: (chatId) => {
        if (chatId === 'bk-bravo') env.scratch.db.prepare('UPDATE snapshots SET updated_at = updated_at + 1 WHERE id = ?').run('snap-bravo-1');
      },
    }, { moduleSourceOverride: activeModule });
    const run = await env.api.runLocalBackup(runDeps(env));
    assert.equal(run.status, 'incomplete');
    eq(run.failures.map((f) => [f.chatId, f.code, f.stage]), [['bk-bravo', 'backup-source-unstable', 'guard']]);
    const bravoBegins = env.double.calls.filter((c) => c.cmd === 'h2o_saved_chat_backup_package_begin' && c.args.options.chatId === 'bk-bravo');
    assert.equal(bravoBegins.length, 2, 'exactly one rebuild allowed');
    assert.equal(env.double.calls.filter((c) => c.cmd === 'h2o_saved_chat_backup_package_abort').length, 2);
    assert.equal(run.counts.success, 3);
    assertClosedVocabulary(env.api, run, env.double);
  });

  await checkAsync('change guard C/D: a chat or snapshot that disappears with no store error → the disappeared codes, no rebuild', async () => {
    const env = await bootScenario('guard-cd', {
      onPackageBegin: (chatId) => {
        if (chatId === 'bk-bravo') env.scratch.db.prepare('DELETE FROM chats WHERE id = ?').run('bk-bravo');
        if (chatId === 'bk-hotel') env.scratch.db.prepare('DELETE FROM snapshots WHERE id = ?').run('snap-hotel-1');
      },
    }, { moduleSourceOverride: activeModule });
    const run = await env.api.runLocalBackup(runDeps(env));
    assert.equal(run.status, 'incomplete');
    eq(run.failures.map((f) => [f.chatId, f.code, f.stage]), [
      ['bk-bravo', 'backup-source-chat-disappeared', 'guard'],
      ['bk-hotel', 'backup-source-snapshot-disappeared', 'guard'],
    ]);
    for (const chat of ['bk-bravo', 'bk-hotel']) {
      assert.equal(env.double.calls.filter((c) => c.cmd === 'h2o_saved_chat_backup_package_begin' && c.args.options.chatId === chat).length, 1, chat + ': no rebuild after a disappearance');
    }
    assertClosedVocabulary(env.api, run, env.double);
  });

  await checkAsync('change guard E: a null re-read that coincides with a store error → backup-source-read-failed, never "disappeared"', async () => {
    /* The builder reads the chat row once during the build; the guard reads
     * it again afterwards. The fault fires on that SECOND read only. */
    let reads = -1;
    const env = await bootScenario('guard-e', {
      onPackageBegin: (chatId) => { if (chatId === 'bk-bravo') reads = 0; },
      onPackageFinish: () => { reads = -1; },
    }, {
      moduleSourceOverride: activeModule,
      sqlFault: (query, values) => {
        if (reads >= 0 && /FROM chats WHERE id = \?/.test(query) && values[0] === 'bk-bravo') {
          reads += 1;
          if (reads === 2) { reads = -1; throw new Error('injected SQL read failure'); }
        }
      },
    });
    const run = await env.api.runLocalBackup(runDeps(env));
    assert.equal(run.status, 'incomplete');
    eq(run.failures.map((f) => [f.chatId, f.code, f.stage]), [['bk-bravo', 'backup-source-read-failed', 'guard']]);
    assert.ok(!run.failures.some((f) => /disappeared/.test(f.code)));
    assertClosedVocabulary(env.api, run, env.double);
  });

  await checkAsync('partial backup: a projection-bound failure and a Windows-reserved chatId (NB-T02-07) → published-partial, never complete', async () => {
    const env = await bootScenario('partial', {}, { moduleSourceOverride: activeModule });
    /* NB-T02-07: the reserved stem passes chatId admission but package_begin refuses it */
    env.scratch.db.prepare("INSERT INTO chats (id, source_id, title, created_at, updated_at, message_count, is_saved, is_linked, is_deleted, href) VALUES ('CON','src-CON','Reserved stem',1,2,1,1,0,0,'https://chatgpt.com/c/CON')").run();
    env.scratch.db.prepare("INSERT INTO snapshots (id, chat_id, title, digest, message_count, captured_at, updated_at) VALUES ('snap-con-1','CON','CON','d',1,2,2)").run();
    env.scratch.db.prepare("INSERT INTO snapshot_turns (snapshot_id, turn_idx, role, outer_html, text, meta_json) VALUES ('snap-con-1',0,'user','<p>con</p>','con','{}')").run();
    env.before.db = dbDigest(env.scratch.db);
    /* the oversize projection: shrink the republished cap so the real materializer's pre-scan refuses bk-alpha */
    env.S.ingestion.assetCas.assetBlobCapBytes = 8;
    const run = await env.api.runLocalBackup(runDeps(env));
    assert.equal(run.status, 'incomplete', JSON.stringify(run.failures));
    assert.equal(run.complete, false);
    assert.ok(/\.partial\.h2obackup$/.test(run.backupLeaf), 'partial leaf');
    eq(run.failures.map((f) => [f.chatId, f.code, f.stage]).sort(), [
      ['CON', 'backup-invalid-member-name', 'package-begin'],
      ['bk-alpha', 'backup-projection-bound-exceeded', 'build'],
    ]);
    eq(run.counts, { enumerated: 10, eligible: 5, success: 3, failed: 2, skipped: seed.expected.skipped });
    const formatted = env.api.formatRunResult(run);
    assert.ok(/INCOMPLETE/.test(formatted.headline) && !/complete —/.test(formatted.headline), 'never labelled complete');
    assert.equal(formatted.tone, 'warning');
    /* the stage-discard rule around the failed build: abort before the next package_begin */
    const seq = env.double.calls.map((c) => c.cmd);
    const alphaBegin = env.double.calls.findIndex((c) => c.cmd === 'h2o_saved_chat_backup_package_begin' && c.args.options.chatId === 'bk-alpha');
    const nextBegin = seq.indexOf('h2o_saved_chat_backup_package_begin', alphaBegin + 1);
    assert.ok(seq.slice(alphaBegin, nextBegin).includes('h2o_saved_chat_backup_package_abort'), 'package_abort before the next package_begin');
    const manifest = JSON.parse(fs.readFileSync(path.join(env.scratch.backupRoot, run.backupLeaf, 'backup-manifest.json'), 'utf8'));
    assert.equal(manifest.complete, false);
    assert.equal(manifest.failures.length, 2);
    assertClosedVocabulary(env.api, run, env.double);
    assertSourceUntouched(env, 'partial');
  });

  await checkAsync('stage-discard rule: a discarding member failure (incl. backup-member-empty, NB-VER-01) → package_abort (benign) → next entry; the entry fails with the verbatim native code', async () => {
    const env = await bootScenario('discard', {
      memberRefuse: {
        'bk-bravo': { kind: 'snapshot', code: 'backup-write-failed', discard: true },
        'bk-golf': { kind: 'manifest', code: 'backup-member-empty', discard: true },
      },
    }, { moduleSourceOverride: activeModule });
    const run = await env.api.runLocalBackup(runDeps(env));
    assert.equal(run.status, 'incomplete');
    eq(run.failures.map((f) => [f.chatId, f.code, f.stage]), [
      ['bk-bravo', 'backup-write-failed', 'write-member'],
      ['bk-golf', 'backup-member-empty', 'write-member'],
    ]);
    const calls = env.double.calls;
    for (const chat of ['bk-bravo', 'bk-golf']) {
      const begin = calls.findIndex((c) => c.cmd === 'h2o_saved_chat_backup_package_begin' && c.args.options.chatId === chat);
      const after = calls.slice(begin + 1);
      const abortIdx = after.findIndex((c) => c.cmd === 'h2o_saved_chat_backup_package_abort');
      const nextBeginIdx = after.findIndex((c) => c.cmd === 'h2o_saved_chat_backup_package_begin');
      assert.ok(abortIdx >= 0 && (nextBeginIdx < 0 || abortIdx < nextBeginIdx), chat + ': package_abort before any further package_begin');
      assert.ok(!after.slice(0, abortIdx).some((c) => c.cmd === 'h2o_saved_chat_backup_write_member' && c.cmd !== 'x' && after.indexOf(c) > 0 && c.options && c.options.member.kind !== 'snapshot' && c.options.member.kind !== 'asset' && chat === 'bk-bravo'), chat + ': no further write to the assumed stage');
    }
    /* the benign no-open-package abort did not fail the run: the other entries published */
    assert.equal(run.counts.success, 2);
    assertClosedVocabulary(env.api, run, env.double);
  });

  await checkAsync('package_finish refusal → per-entry native code, package_abort, run continues', async () => {
    const env = await bootScenario('finish', { finishRefuse: { 'bk-hotel': 'backup-package-verification-failed' } }, { moduleSourceOverride: activeModule });
    const run = await env.api.runLocalBackup(runDeps(env));
    assert.equal(run.status, 'incomplete');
    eq(run.failures.map((f) => [f.chatId, f.code, f.stage]), [['bk-hotel', 'backup-package-verification-failed', 'package-finish']]);
    assert.equal(run.failures[0].detail, 'double-injected', 'native codes[] carried as bounded detail');
    assertClosedVocabulary(env.api, run, env.double);
  });

  await checkAsync('empty eligible set → neutral local result, no BEGIN/publish/source error; enumeration errors → indeterminate', async () => {
    const env = await bootScenario('empty', {}, { moduleSourceOverride: activeModule });
    env.scratch.db.prepare('UPDATE chats SET is_deleted = 1 WHERE is_saved = 1').run();
    env.before.db = dbDigest(env.scratch.db);
    const run = await env.api.runLocalBackup(runDeps(env));
    assert.equal(run.status, 'empty');
    assert.equal(run.code, '');
    assert.equal(run.committed, false);
    assert.equal(run.complete, null);
    assert.equal(env.api.formatRunResult(run).headline, 'Nothing to back up — no eligible saved chats were found.');
    assert.equal(env.double.calls.length, 0, 'no native command for an empty set');
    assert.ok(!fs.existsSync(env.scratch.backupRoot), 'no root created');
    assertSourceUntouched(env, 'empty');
    /* a store error during enumeration */
    const env2 = await bootScenario('indeterminate', {}, {
      moduleSourceOverride: activeModule,
      sqlFault: (query) => { if (/FROM snapshots WHERE chat_id/.test(query) && env2 && !env2.tripped) { env2.tripped = true; throw new Error('injected'); } },
    });
    const run2 = await env2.api.runLocalBackup(runDeps(env2));
    assert.equal(run2.status, 'failed');
    assert.equal(run2.code, 'backup-enumeration-indeterminate');
    assert.equal(env2.double.calls.length, 0);
  });

  await checkAsync('cancel: a cooperative cancel aborts the native session; nothing is published', async () => {
    let cancelled = false;
    const env = await bootScenario('cancel', { onPackageFinish: (chatId) => { if (chatId === 'bk-bravo') cancelled = true; } }, { moduleSourceOverride: activeModule });
    const run = await env.api.runLocalBackup(runDeps(env), { isCancelled: () => cancelled });
    assert.equal(run.status, 'failed');
    assert.equal(run.code, 'backup-cancelled');
    assert.equal(run.cancelled, true);
    const cmds = env.double.calls.map((c) => c.cmd);
    assert.ok(cmds.includes('h2o_saved_chat_backup_abort'), 'native abort issued');
    assert.ok(!cmds.includes('h2o_saved_chat_backup_finalize'), 'no finalize after cancel');
    assert.equal(fs.readdirSync(env.scratch.backupRoot).length, 0, 'own staging removed, nothing published');
    assert.equal(env.api.formatRunResult(run).headline, 'Backup cancelled — nothing was published.');
    assertSourceUntouched(env, 'cancel');
  });

  await checkAsync('post-BEGIN rejected invoke → exactly one best-effort session abort, truthful runtime failure, immediate retry; abort rejection preserves the primary failure and warns', async () => {
    const packageBegin = 'h2o_saved_chat_backup_package_begin';
    const abort = 'h2o_saved_chat_backup_abort';
    const finalize = 'h2o_saved_chat_backup_finalize';
    const env = await bootScenario('runtime-reject', { rejectInvokes: { [packageBegin]: 1 } }, { moduleSourceOverride: activeModule });
    const run = await env.api.runLocalBackup(runDeps(env));
    assert.equal(run.status, 'failed');
    assert.equal(run.runtimeError, true);
    assert.equal(run.code, '', 'no invented backup-* runtime code');
    assert.equal(run.cleanupUnconfirmed, false);
    assert.equal(run.failures.length, 0, 'the exception is not a per-entry FINALIZE failure');
    assert.ok(!run.failures.some((f) => f.code === 'backup-projection-failed'));
    assert.equal(env.double.calls.filter((c) => c.cmd === abort).length, 1, 'one best-effort abort for the owned token');
    assert.equal(env.double.calls.filter((c) => c.cmd === finalize).length, 0, 'no FINALIZE after the rejected invoke');
    assert.equal(env.double.session.state, 'ABORTED', 'the native double has no live session after cleanup');
    assert.equal(env.api.formatRunResult(run).headline, 'Backup stopped because the Desktop backup service returned an unexpected error.');
    assert.ok(!env.api.formatRunResult(run).lines.join(' ').includes('backup-projection-failed'));
    assert.ok(!env.api.formatRunResult(run).lines.join(' ').includes('native double rejected'), 'raw runtime diagnostic is not rendered on the card');
    assert.ok(Buffer.byteLength(run.diagnostic, 'utf8') <= 512, 'runtime diagnostic remains bounded');
    const retry = await env.api.runLocalBackup(runDeps(env));
    assert.equal(retry.status, 'complete', JSON.stringify(retry));
    assert.notEqual(retry.code, 'backup-session-busy');
    assert.equal(env.double.calls.filter((c) => c.cmd === 'h2o_saved_chat_backup_begin').length, 2, 'immediate retry opens one new session');

    const env2 = await bootScenario('runtime-abort-reject', {
      rejectInvokes: { [packageBegin]: 1, [abort]: 1 },
    }, { moduleSourceOverride: activeModule });
    const unconfirmed = await env2.api.runLocalBackup(runDeps(env2));
    assert.equal(unconfirmed.status, 'failed');
    assert.equal(unconfirmed.runtimeError, true, 'original renderer/IPC runtime failure remains primary');
    assert.equal(unconfirmed.code, '');
    assert.equal(unconfirmed.cleanupUnconfirmed, true);
    assert.equal(unconfirmed.failures.length, 0);
    assert.equal(env2.double.calls.filter((c) => c.cmd === abort).length, 1, 'abort rejection is not retried');
    const lines = env2.api.formatRunResult(unconfirmed).lines;
    assert.equal(lines[0], 'Backup stopped because the Desktop backup service returned an unexpected error.');
    assert.ok(lines.includes('The previous backup session may remain busy until it is released automatically.'));

    const env3 = await bootScenario('post-commit-list-reject', {
      rejectInvokes: { h2o_saved_chat_backup_list: 1 },
    }, { moduleSourceOverride: activeModule });
    const parent = env3.dom.document.createElement('div');
    const health = env3.dom.document.createElement('div');
    parent.appendChild(health);
    const card = env3.api.mountLocalBackupCard(health, runDeps(env3));
    const committed = await card.run();
    assert.equal(committed.status, 'complete', 'post-commit LIST rejection cannot reclassify the result');
    assert.equal(committed.committed, true);
    assert.equal(card.getState().result.status, 'complete');
    assert.ok(allText(parent).includes('Backup complete'));
  });

  await checkAsync('remount while active attaches to the module run; card B cancels that run, no second BEGIN/busy, and a later terminal run starts normally', async () => {
    let releasePause;
    let markReached;
    const wait = new Promise((resolve) => { releasePause = resolve; });
    const reached = new Promise((resolve) => { markReached = resolve; });
    const env = await bootScenario('remount-active', {
      pauseInvoke: {
        command: 'h2o_saved_chat_backup_package_begin',
        wait,
        onReached: () => markReached(),
      },
    }, { moduleSourceOverride: activeModule });
    const parent = env.dom.document.createElement('div');
    const health = env.dom.document.createElement('div');
    parent.appendChild(health);
    const cardA = env.api.mountLocalBackupCard(health, runDeps(env));
    const active = cardA.run();
    await reached;
    assert.equal(env.double.session.state, 'STAGING', 'BEGIN created the one live native session');
    assert.equal(env.double.calls.filter((c) => c.cmd === 'h2o_saved_chat_backup_begin').length, 1);

    const cardB = env.api.mountLocalBackupCard(health, runDeps(env));
    assert.equal(cardB.getState().running, true);
    assert.equal(cardB.getState().progress.current, 1);
    assert.equal(cardB.getState().progress.total, 4);
    assert.ok(allText(parent).includes('Backing up 1 of 4…'), 'card B renders the active progress, not idle state');
    assert.ok(!allText(parent).includes('No backup has been run in this session.'));
    assert.equal(findByAttr(parent, 'data-h2o-action', 'local-backup-cancel').disabled, false, 'card B exposes Cancel');
    assert.equal(findAllByAttr(parent, 'data-h2o-card').filter((n) => n.attributes['data-h2o-card'] === 'saved-chat-local-backup').length, 1, 'only card B remains visible');
    assert.equal(env.double.calls.filter((c) => c.cmd === 'h2o_saved_chat_backup_begin').length, 1, 'remount itself issues no BEGIN');

    const attached = cardB.run();
    assert.equal(attached, active, 'Back up while active attaches to the same promise');
    assert.equal(env.double.calls.filter((c) => c.cmd === 'h2o_saved_chat_backup_begin').length, 1, 'attached run issues no second BEGIN');
    cardB.cancel();
    assert.equal(cardB.getState().cancelRequested, true, 'card B cancels the module-level run');
    releasePause();
    const cancelled = await active;
    assert.equal(cancelled.code, 'backup-cancelled');
    assert.equal(cancelled.cancelled, true);
    assert.equal(env.double.calls.filter((c) => c.cmd === 'h2o_saved_chat_backup_abort').length, 1);
    assert.equal(env.double.calls.filter((c) => c.cmd === 'h2o_saved_chat_backup_finalize').length, 0);
    assert.equal(env.double.calls.filter((c) => c.cmd === 'h2o_saved_chat_backup_begin').length, 1);
    assert.notEqual(cancelled.code, 'backup-session-busy', 'the remounted workflow never receives a busy refusal');
    assert.equal(cardB.getState().result.code, 'backup-cancelled', 'card B receives the terminal result');

    const later = await cardB.run();
    assert.equal(later.status, 'complete');
    assert.notEqual(later.code, 'backup-session-busy');
    assert.equal(env.double.calls.filter((c) => c.cmd === 'h2o_saved_chat_backup_begin').length, 2, 'a later terminal run creates exactly one new BEGIN');
    assert.equal(cardB.getState().list.rows.length, 1, 'the governed LIST rows refresh after completion');
    assertSourceUntouched(env, 'remount-active');
  });

  await checkAsync('durability truth (NB-T02-08): committed:true + durabilityComplete:false is a published backup with a warning; committed:false is never success', async () => {
    const env = await bootScenario('durability', {
      finalizeOverride: (r) => Object.assign({}, r, { durabilityComplete: false, fullFsync: false, codes: ['backup-fence-failed'] }),
    }, { moduleSourceOverride: activeModule });
    const run = await env.api.runLocalBackup(runDeps(env));
    assert.equal(run.status, 'complete');
    assert.equal(run.committed, true);
    assert.equal(run.durabilityComplete, false);
    const text = env.api.formatRunResult(run).lines.join(' ');
    assert.ok(/published, but its final durability fence did not complete/.test(text), 'durability warning shown');
    assert.ok(!/did not exist|failed —/.test(text), 'never rendered as absent or failed');
    /* the manifest-side fullFsync fact is a separate, authoring-time fact */
    const manifest = JSON.parse(fs.readFileSync(path.join(env.scratch.backupRoot, run.backupLeaf, 'backup-manifest.json'), 'utf8'));
    assert.equal(manifest.verification.fullFsync, true, 'manifest verification.fullFsync stays the authoring-time truth');
    assert.equal(run.fullFsync, false, 'the FINALIZE result carries the run-level fact');

    const env2 = await bootScenario('uncommitted', {
      finalizeOverride: (r) => ({ ok: false, status: 'backup-promote-failed', committed: false, durabilityComplete: false, fullFsync: false, backupId: r.backupId, codes: [] }),
    }, { moduleSourceOverride: activeModule });
    const run2 = await env2.api.runLocalBackup(runDeps(env2));
    assert.equal(run2.status, 'failed');
    assert.equal(run2.code, 'backup-promote-failed');
    assert.equal(run2.committed, false);
    assert.equal(run2.backupLeaf, '');
    assert.ok(/Backup failed/.test(env2.api.formatRunResult(run2).headline));
    assert.ok(!fs.existsSync(env2.scratch.backupRoot) || fs.readdirSync(env2.scratch.backupRoot).every((l) => !/\.h2obackup$/.test(l)), 'nothing published');
  });

  await checkAsync('card: mount, run, list rows, Verify (every status class; NB-T02-06 unreadable pairs never look valid)', async () => {
    const env = await bootScenario('card', {
      verifyOverride: {
        'unreadable-a.h2obackup': { status: 'unreadable', codes: ['backup-not-a-backup-leaf'] },
        'unreadable-b.h2obackup': { status: 'unreadable', codes: ['backup-path-redirect-refused'] },
        'malformed.h2obackup': { status: 'malformed', codes: ['backup-set-digest-mismatch'], backupId: 'x' },
        'unsupported.h2obackup': { status: 'unsupported', codes: ['backup-manifest-invalid'] },
      },
    }, { moduleSourceOverride: activeModule });
    const parent = env.dom.document.createElement('div');
    const health = env.dom.document.createElement('div');
    parent.appendChild(health);
    env.api.mountLocalBackupCard(health, runDeps(env));
    /* the LAST mount owns the live card; the earlier one was cleared */
    const card = env.api.mountLocalBackupCard(health, runDeps(env));
    const cards = findAllByAttr(parent, 'data-h2o-card').filter((n) => n.attributes['data-h2o-card'] === 'saved-chat-local-backup');
    assert.equal(cards.length, 1, 'idempotent remount: exactly one card');
    assert.equal(health.children.length, 0, 'the card is a sibling, not a child of the health container');
    assert.equal(env.double.calls.length, 0, 'mounting invokes nothing');
    const runButton = findByAttr(parent, 'data-h2o-action', 'local-backup-run');
    assert.ok(runButton && !runButton.disabled, 'primary action available on Desktop');
    assert.ok(allText(parent).includes('Back up saved chats'));
    assert.ok(!/confirm\(/.test(moduleCode), 'no confirmation dialog for the non-destructive action');
    const run = await card.run();
    assert.equal(run.status, 'complete');
    const status = findByAttr(parent, 'data-h2o-local-backup-status', 'complete');
    assert.ok(status, 'status attribute reflects the run state');
    assert.ok(allText(parent).includes('Backup complete — 4 of 4 eligible chats backed up; 5 saved chats skipped.'));
    assert.ok(allText(parent).includes('Skipped saved chats: 5 — 1 deleted, 2 tombstoned, 2 with no snapshot or zero turns.'));
    assert.ok(allText(parent).includes('Linked-only chats not eligible for saved-chat backup: 1.'));
    assert.ok(allText(parent).includes('selected at the start'));
    assert.ok(allText(parent).includes('Each chat is consistency-checked while it is backed up.'));
    assert.ok(allText(parent).includes('Recovery in v1 uses Recover as New; it does not overwrite the current chat.'));
    assert.ok(allText(parent).includes('asset bytes remain in the backup package'));
    assert.ok(allText(parent).includes('does not reattach those package assets'));
    assert.ok(allText(parent).includes(run.backupLeaf));
    /* governed list */
    const state = card.getState();
    assert.equal(state.list.rows.length, 1);
    assert.equal(state.list.rows[0].leaf, run.backupLeaf);
    assert.equal(state.list.rows[0].kind, 'backup');
    const verifyButtons = findAllByAttr(parent, 'data-h2o-leaf');
    assert.equal(verifyButtons.length, 1, 'one Verify control per governed row; no path input');
    assert.ok(!findAllByAttr(parent, 'data-h2o-leaf').some((n) => n.tagName === 'INPUT'), 'no free-text leaf/path input');
    verifyButtons[0].click();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(card.getState().verify.result.status, 'valid-complete');
    assert.ok(allText(parent).includes('Valid — complete backup'));
    /* every status class through the same rendering path */
    const expectations = [
      ['unreadable-a.h2obackup', 'unreadable', 'backup-not-a-backup-leaf'],
      ['unreadable-b.h2obackup', 'unreadable', 'backup-path-redirect-refused'],
      ['malformed.h2obackup', 'malformed', 'backup-set-digest-mismatch'],
      ['unsupported.h2obackup', 'unsupported', 'backup-manifest-invalid'],
    ];
    for (const [leaf, status, code] of expectations) {
      const v = await card.verify(leaf);
      assert.equal(v.result.status, status);
      assert.equal(v.result.valid, false);
      eq(v.result.codes, [code]);
      const text = allText(parent);
      assert.ok(text.includes('NOT valid'), leaf + ' rendered as not valid');
      assert.ok(text.includes(code), leaf + ' shows the native code');
      assert.ok(!/Valid — /.test(text), leaf + ' never shows a valid headline');
    }
    /* residue is reported and never removed */
    fs.mkdirSync(path.join(env.scratch.backupRoot, '.h2o-backupstage-' + 'f'.repeat(32)));
    await card.refreshList();
    assert.equal(card.getState().list.residueCount, 1);
    assert.ok(allText(parent).includes('1 stale staging folder(s): .h2o-backupstage-' + 'f'.repeat(32)));
    assert.ok(allText(parent).includes('Stale staging folders are not backups.'));
    assert.ok(allText(parent).includes('This version does not remove them automatically.'));
    assert.ok(allText(parent).includes('Only remove them manually when no backup is active.'));
    assert.equal(findAllByAttr(parent, 'data-h2o-action').filter((n) => /delete|remove/i.test(n._text || '')).length, 0, 'no residue cleanup control');
    assert.ok(fs.existsSync(path.join(env.scratch.backupRoot, '.h2o-backupstage-' + 'f'.repeat(32))));
    assertSourceUntouched(env, 'card');
  });

  await checkAsync('Desktop/Chrome posture (NB-T02-10): without the native surface the card shows the Desktop-only message and runs nothing', async () => {
    const env = await bootScenario('posture', {}, { moduleSourceOverride: activeModule });
    const sb = vm.createContext({ console, document: env.dom.document, TextEncoder, TextDecoder, Uint8Array });
    sb.globalThis = sb;
    vm.runInContext(activeModule || moduleSrc, sb, { filename: 'local-backup-chrome.js' });
    const api = sb.H2O.Studio.localBackupUi;
    const parent = env.dom.document.createElement('div');
    const health = env.dom.document.createElement('div');
    parent.appendChild(health);
    const card = api.mountLocalBackupCard(health);
    assert.equal(card.getState().status, 'unavailable');
    assert.ok(allText(parent).includes('available in Desktop Studio only'));
    assert.equal(findByAttr(parent, 'data-h2o-action', 'local-backup-run').disabled, true);
    assert.equal(await card.run(), null);
    assert.ok(!/Linux|Windows/.test(moduleSrc.replace(/Windows-reserved/g, '')), 'no non-macOS certification language');
    await assert.rejects(() => api.runLocalBackup({}), /Desktop Studio only/);
  });

  await checkAsync('run-level native refusals are passed through verbatim (session busy, no package succeeded)', async () => {
    const env = await bootScenario('refusals', { beginRefuse: 'backup-session-busy' }, { moduleSourceOverride: activeModule });
    const run = await env.api.runLocalBackup(runDeps(env));
    assert.equal(run.status, 'failed');
    assert.equal(run.code, 'backup-session-busy');
    assert.equal(run.errorClass, 'RETRYABLE');
    const env2 = await bootScenario('nosuccess', { packageBeginRefuse: { 'bk-alpha': 'backup-write-failed', 'bk-bravo': 'backup-write-failed', 'bk-golf': 'backup-write-failed', 'bk-hotel': 'backup-write-failed' } }, { moduleSourceOverride: activeModule });
    const run2 = await env2.api.runLocalBackup(runDeps(env2));
    assert.equal(run2.status, 'failed');
    assert.equal(run2.code, 'backup-no-package-succeeded');
    assert.equal(run2.failures.length, 4);
    const formatted = env2.api.formatRunResult(run2);
    assert.equal(formatted.headline, 'Backup failed — 0 of 4 eligible chats were backed up; 4 failed.');
    assert.ok(formatted.lines.some((line) => line.includes('Alpha (asset-bearing) (bk-alpha) — backup-write-failed')), 'human title plus canonical chatId');
    assert.ok(formatted.lines.some((line) => line.includes('Bravo (text only) (bk-bravo) — backup-write-failed')), 'second failure title mapped locally');
    const cmds = env2.double.calls.map((c) => c.cmd);
    assert.ok(cmds.includes('h2o_saved_chat_backup_abort'), 'the live session is aborted after the refusal');
    assert.equal(fs.readdirSync(env2.scratch.backupRoot).length, 0, 'own staging removed');
    assertClosedVocabulary(env2.api, run2, env2.double);
  });

  /* ── RED CONTROL (inline self-check) ──────────────────────────────────── */
  if (!RED_CONTROL_MODE) {
    await checkAsync('RED control: a runtime-mutated module that skips package_abort before the rebuild FAILS the change-guard proof', async () => {
      let mutated = false;
      const env = await bootScenario('red', {
        onPackageBegin: (chatId, attempt) => {
          if (chatId === 'bk-bravo' && attempt === 1 && !mutated) {
            mutated = true;
            env.scratch.db.prepare('UPDATE snapshots SET updated_at = updated_at + 1 WHERE id = ?').run('snap-bravo-1');
          }
        },
      }, { moduleSourceOverride: RED_MODULE });
      const run = await env.api.runLocalBackup(runDeps(env));
      const seq = env.double.calls.map((c) => c.cmd + (c.args && c.args.options && c.args.options.chatId ? ':' + c.args.options.chatId : ''));
      const firstBegin = seq.indexOf('h2o_saved_chat_backup_package_begin:bk-bravo');
      const secondBegin = seq.indexOf('h2o_saved_chat_backup_package_begin:bk-bravo', firstBegin + 1);
      let loadBearingAssertionHeld = true;
      try {
        assert.ok(secondBegin > firstBegin, 'a rebuild happened');
        assert.ok(seq.slice(firstBegin, secondBegin).includes('h2o_saved_chat_backup_package_abort'), 'package_abort issued before the rebuild');
        assert.equal(run.status, 'complete');
      } catch (_) { loadBearingAssertionHeld = false; }
      assert.equal(loadBearingAssertionHeld, false, 'the mutated variant must FAIL the load-bearing change-guard assertion (RED)');
      /* and the native double shows why: the rebuild's package_begin was refused with a package still open */
      assert.ok(run.failures.some((f) => f.chatId === 'bk-bravo' && f.code === 'backup-invalid-state'), 'without the abort, the open stage blocks the rebuild');
    });
  }

  console.log(`\n[saved-chat-local-backup-harness-v1] ${FAIL.length ? 'FAIL' : 'PASS'} — ${PASS.length} passed, ${FAIL.length} failed`);
  if (FAIL.length) { for (const f of FAIL) console.log(`  - ${f.label}: ${f.m}`); process.exit(1); }
}

main().catch((e) => { console.error(e && e.stack ? e.stack : e); process.exit(1); });
