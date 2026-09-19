#!/usr/bin/env node
// Saved-Chat asset restoration (T02) — PERMANENT harness.
//
// Mission complete-saved-chat-recovery-asset-restoration, accepted T01 contract
// §20 vectors AR-01..AR-27 plus the Rev 4 Reader/Renderer invariant (AR-RD-01)
// and the RED/mutant control (AR-RED-01). The Reader-side hydration guards
// (AR-RF-01..12) live in validate-saved-chat-recovered-asset-hydration-rf-v1.mjs.
//
// What is REAL here: the Saved-Chat importer, the codec, the asset CAS module,
// the store adapters (chats / snapshots / assets), the trusted-integrity
// client, diagnostics, health mapping, the inspector, the portable-ZIP module
// and the portable verification client — loaded as source into a vm context in
// studio.html order over a throwaway node:sqlite database and a throwaway
// AppLocalData directory.
//
// What is a TEST DOUBLE here, and why:
//   - h2o_saved_chat_archive_integrity / the portable verifier: each scenario
//     DECLARES the trusted outcome the Rust verifier is independently proven to
//     return (assetShas included). Nothing here hashes or verifies a package.
//   - h2o_archive_durable_write / h2o_archive_cas_repair_write: the app-owned
//     durable writer, mirrored create-only over the temp directory, with
//     scenario hooks for write failure and destination races.
//   - h2o_saved_chat_asset_recovery_commit: the purpose-bounded native
//     transaction, mirrored statement-for-statement over node:sqlite inside
//     BEGIN IMMEDIATE / COMMIT. Its ATOMICITY and rollback are proven natively
//     (saved_chat_asset_recovery/tests.rs); this double only lets the JS
//     orchestration be exercised end to end, and injects the rollback stages
//     the contract's failure matrix names.
//
// It never touches the developer's live studio-v1.db or archive.

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), '..', '..', '..');
const STUDIO_ROOT = path.join(REPO_ROOT, 'src-surfaces-base/studio');
const FIXTURE_DIR_REL = 'tools/validation/fixtures/saved-chat-archive/asset-restoration';
const FIXTURE_PKG_DIR = 'ar-v3-assistant-raster.h2ochat';
const FIXTURE_PKG_REL = `${FIXTURE_DIR_REL}/${FIXTURE_PKG_DIR}`;
const IMPORTER_REL = 'src-surfaces-base/studio/ingestion/saved-chat-archive-importer.studio.js';
const NATIVE_REL = 'apps/studio/desktop/src-tauri/src/saved_chat_asset_recovery.rs';
const LIB_RS_REL = 'apps/studio/desktop/src-tauri/src/lib.rs';
const DOC_REL = 'docs/systems/archive/saved-chat-asset-restoration.md';
const RECOVERY_COMMAND = 'h2o_saved_chat_asset_recovery_commit';
const RECOVERY_SCHEMA = 'h2o.savedChatAssetRecoveryCommit.v1';

/* Real modules, in the order studio.html loads them. */
const MODULES = [
  'store/index.js',
  'store/snapshots.tauri.js',
  'store/chats.tauri.js',
  'store/assets.tauri.js',
  'renderer/safety/sanitizer-policy.v1.js',
  'ingestion/saved-chat-package-codec.tauri.js',
  'ingestion/asset-cas.tauri.js',
  'ingestion/saved-chat-archive-integrity.tauri.js',
  'ingestion/saved-chat-archive-diagnostics.tauri.js',
  'ingestion/saved-chat-archive-health-mapping.js',
  'ingestion/saved-chat-archive-inspector.studio.js',
  'ingestion/saved-chat-portable-zip.studio.js',
  'ingestion/saved-chat-portable-package-verification.tauri.js',
  'ingestion/saved-chat-archive-importer.studio.js',
];

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
const readRepo = (rel) => fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
const exists = (rel) => fs.existsSync(path.join(REPO_ROOT, rel));
const stripComments = (src) => String(src).replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');
const sha256Hex = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const sha256Pfx = (buf) => 'sha256-' + sha256Hex(buf);
const bare = (v) => String(v || '').toLowerCase().replace(/^sha256-/, '');
const toArrayBytes = (a) => {
  if (Array.isArray(a)) return a.slice();
  if (a && ArrayBuffer.isView(a)) return Array.from(new Uint8Array(a.buffer, a.byteOffset || 0, a.byteLength));
  if (a instanceof ArrayBuffer) return Array.from(new Uint8Array(a));
  throw new Error('bytes body expected');
};
/* vm-realm values have foreign prototypes; compare them as plain data. */
const plain = (v) => JSON.parse(JSON.stringify(v === undefined ? null : v));
const canonicalJson = (value) => {
  const norm = (v) => {
    if (Array.isArray(v)) return v.map(norm);
    if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, norm(v[k])]));
    return v;
  };
  return JSON.stringify(norm(value));
};
const readOptionsHeader = (b) => {
  const headers = (b && b.headers) || {};
  if (!headers.options) return {};
  try { return JSON.parse(decodeURIComponent(headers.options)); } catch (_) { return JSON.parse(headers.options); }
};

// ── fixture facts ──────────────────────────────────────────────────────────
const FIX = (() => {
  const dir = path.join(REPO_ROOT, FIXTURE_PKG_REL);
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  const snapshotBytes = fs.readFileSync(path.join(dir, 'snapshot.json'));
  const snapshot = JSON.parse(snapshotBytes.toString('utf8'));
  const assets = manifest.assets.map((a) => ({ ...a, bytes: fs.readFileSync(path.join(dir, a.path)) }));
  const byExt = Object.fromEntries(assets.map((a) => [a.ext, a]));
  return { dir, manifest, snapshotBytes, snapshot, assets, png: byExt.png, gif: byExt.gif, chatId: manifest.chatId, snapshotId: manifest.snapshotId };
})();

// ── schema (mirrors the Tauri migrations for the touched tables) ───────────
const SCHEMA_SQL = `
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
  outer_html TEXT NOT NULL DEFAULT '', text TEXT NOT NULL DEFAULT '',
  meta_json TEXT NOT NULL DEFAULT '{}', PRIMARY KEY (snapshot_id, turn_idx)
);
CREATE TABLE assets (
  sha256 TEXT PRIMARY KEY, mime_type TEXT NOT NULL DEFAULT '', ext TEXT NOT NULL DEFAULT '',
  byte_size INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT '', refcount INTEGER NOT NULL DEFAULT 0,
  meta_json TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE snapshot_turn_assets (
  snapshot_id TEXT NOT NULL, turn_idx INTEGER NOT NULL, sha256 TEXT NOT NULL,
  relation TEXT NOT NULL DEFAULT 'inline', created_at TEXT NOT NULL DEFAULT '',
  meta_json TEXT NOT NULL DEFAULT '{}', PRIMARY KEY (snapshot_id, turn_idx, sha256)
);
CREATE INDEX idx_snapshot_turn_assets_sha256 ON snapshot_turn_assets(sha256);
CREATE TABLE folder_bindings (chat_id TEXT PRIMARY KEY, folder_id TEXT NOT NULL, assigned_at INTEGER NOT NULL DEFAULT 0);
CREATE TABLE label_bindings (chat_id TEXT NOT NULL, label_id TEXT NOT NULL, PRIMARY KEY (chat_id, label_id));
CREATE TABLE tag_bindings (chat_id TEXT NOT NULL, tag_id TEXT NOT NULL, PRIMARY KEY (chat_id, tag_id));
`;

// ── environment: temp AppLocalData + temp DB + declared trust + hooks ──────
let current = null;
const environments = [];

function createEnv(label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'h2o-ar-t02-'));
  const appDir = path.join(root, 'AppLocalData');
  fs.mkdirSync(path.join(appDir, 'archive/packages'), { recursive: true });
  fs.mkdirSync(path.join(appDir, 'archive/assets'), { recursive: true });
  const db = new DatabaseSync(path.join(root, 'studio-v1.db'));
  db.exec(SCHEMA_SQL);
  const env = {
    label, root, appDir, db,
    trusted: new Map(),           // packageDirName -> occupant
    portableVerdicts: new Map(),  // packageDirName -> verdict
    portableSessions: new Map(),
    portableToken: 1,
    ledger: [],                   // every invoke: { cmd, path?, verb? }
    sqlWrites: [],                // plugin:sql|execute verbs
    nativeCalls: [],              // recovery command payloads
    hooks: {
      durableWriteFail: null,     // sha hex -> blocker code
      raceCorruptOnPut: null,     // sha hex -> { mode: 'repaired' | 'already-valid' }
      nativeFailStage: null,      // stage name -> ROLLBACK there
      nativeThrow: false,
      afterCommit: null,          // fn(env, result) — e.g. remove a CAS object before proof
      readFileFail: null,         // AppLocalData-relative path -> throw on read
    },
  };
  environments.push(env);
  return env;
}
const j = (env, p) => path.join(env.appDir, String(p || ''));
const casPath = (hex) => `archive/assets/${hex.slice(0, 2)}/sha256-${hex}`;

function counts(env) {
  const c = (t) => env.db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;
  return { chats: c('chats'), snapshots: c('snapshots'), turns: c('snapshot_turns'), assets: c('assets'), links: c('snapshot_turn_assets') };
}
function tableDigest(env, table, order) {
  const rows = env.db.prepare(`SELECT * FROM ${table} ORDER BY ${order}`).all();
  return sha256Hex(JSON.stringify(rows));
}
function dbDigest(env) {
  return [
    tableDigest(env, 'chats', 'id'), tableDigest(env, 'snapshots', 'id'), tableDigest(env, 'snapshot_turns', 'snapshot_id, turn_idx'),
    tableDigest(env, 'assets', 'sha256'), tableDigest(env, 'snapshot_turn_assets', 'snapshot_id, turn_idx, sha256'),
  ].join('|');
}
function dirDigest(dir) {
  const out = [];
  const walk = (d, rel) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const abs = path.join(d, e.name);
      const r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) walk(abs, r);
      else out.push(r + '=' + sha256Hex(fs.readFileSync(abs)));
    }
  };
  if (fs.existsSync(dir)) walk(dir, '');
  return out.join('\n');
}
const casDigest = (env) => dirDigest(j(env, 'archive/assets'));
const casObjectExists = (env, hex) => fs.existsSync(j(env, casPath(hex)));
const casObjectBytes = (env, hex) => fs.readFileSync(j(env, casPath(hex)));

/* Trusted occupant DECLARATION for a staged archive package. Physical facts
 * are measured from the staged snapshot bytes (as the scanner would); the
 * required asset set defaults to the ORIGINAL fixture's trusted set so that
 * staged tampering is caught by the plan, exactly as it would be against the
 * real enumeration taken before the tamper. */
function declareArchiveTrusted(env, dirName, { manifest, trustedShas, klass = 'legacy-package' } = {}) {
  const abs = j(env, 'archive/packages/' + dirName);
  const m = manifest || JSON.parse(fs.readFileSync(path.join(abs, 'manifest.json'), 'utf8'));
  const snapBytes = fs.readFileSync(path.join(abs, 'snapshot.json'));
  const physicalSha = sha256Pfx(snapBytes);
  env.trusted.set(dirName, {
    path: 'archive/packages/' + dirName,
    name: dirName,
    class: klass,
    chatId: m.chatId,
    snapshotId: m.snapshotId,
    contentHash: bare(m.contentHash),
    constructionFamily: 'v' + m.schemaVersion,
    snapshotEncoding: 'identity',
    snapshotPhysicalSha256: physicalSha,
    snapshotPhysicalByteLength: snapBytes.length,
    logicalSnapshotSha256: physicalSha,
    logicalSnapshotByteLength: snapBytes.length,
    assetShas: (trustedShas || FIX.manifest.assets.map((a) => bare(a.sha256))).slice().sort(),
    savedAt: '2026-09-18T00:00:00.000Z',
    orderable: false,
    blockers: [],
  });
}

/* Stage the fixture (optionally mutated) under the env's archive/packages. */
function stageArchive(env, { dirName = FIXTURE_PKG_DIR, mutate = null, trustedShas = null } = {}) {
  const dst = j(env, 'archive/packages/' + dirName);
  fs.rmSync(dst, { recursive: true, force: true });
  fs.mkdirSync(path.join(dst, 'assets'), { recursive: true });
  fs.copyFileSync(path.join(FIX.dir, 'manifest.json'), path.join(dst, 'manifest.json'));
  fs.copyFileSync(path.join(FIX.dir, 'snapshot.json'), path.join(dst, 'snapshot.json'));
  for (const a of FIX.assets) fs.copyFileSync(path.join(FIX.dir, a.path), path.join(dst, a.path));
  if (typeof mutate === 'function') mutate(dst);
  declareArchiveTrusted(env, dirName, { trustedShas });
  return 'archive/packages/' + dirName;
}
const readStagedManifest = (dst) => JSON.parse(fs.readFileSync(path.join(dst, 'manifest.json'), 'utf8'));
const writeStagedManifest = (dst, m) => fs.writeFileSync(path.join(dst, 'manifest.json'), JSON.stringify(m, null, 2) + '\n');

// ── the native recovery transaction, mirrored over node:sqlite ────────────
function mockRecoveryCommit(env, payload) {
  env.nativeCalls.push(JSON.parse(JSON.stringify(payload)));
  const refuse = (stage, code) => ({ schema: RECOVERY_SCHEMA, ok: false, committed: false, counts: { turns: 0, assetsInserted: 0, assetsExisting: 0, links: 0, refcountsRecomputed: 0 }, stage, code });
  if (!payload || payload.schema !== RECOVERY_SCHEMA) return refuse('validate', 'schema-mismatch');
  const keys = new Set();
  for (const l of payload.links) {
    const k = l.turnIdx + ':' + l.sha256;
    if (keys.has(k)) return refuse('validate', 'duplicate-logical-link');
    keys.add(k);
  }
  const db = env.db;
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const fail = env.hooks.nativeFailStage;
  db.exec('BEGIN IMMEDIATE');
  const rollback = (stage, code) => { db.exec('ROLLBACK'); return refuse(stage, code); };
  try {
    if (db.prepare('SELECT 1 FROM chats WHERE id = ?').get(payload.recoveredChatId)) return rollback('assert-fresh', 'recovered-chat-id-exists');
    let snapshotId = null;
    for (let i = 0; i < 5 && !snapshotId; i += 1) {
      const candidate = 'snap_' + crypto.randomUUID();
      if (candidate !== payload.originalSnapshotId && !db.prepare('SELECT 1 FROM snapshots WHERE id = ?').get(candidate)) snapshotId = candidate;
    }
    if (!snapshotId) return rollback('assert-fresh', 'snapshot-id-collision');
    const c = { turns: 0, assetsInserted: 0, assetsExisting: 0, links: 0, refcountsRecomputed: 0 };
    if (fail === 'registry-ensure') return rollback('registry-ensure', 'injected-failure');
    for (const asset of [...payload.assets].sort((a, b) => a.sha256.localeCompare(b.sha256))) {
      const row = db.prepare('SELECT byte_size FROM assets WHERE sha256 = ?').get(asset.sha256);
      if (row) {
        if (row.byte_size !== 0 && row.byte_size !== asset.byteSize) return rollback('registry-ensure', 'registry-byte-size-contradiction');
        c.assetsExisting += 1;
      } else {
        db.prepare('INSERT INTO assets (sha256, mime_type, ext, byte_size, created_at, updated_at, refcount, meta_json) VALUES (?, ?, ?, ?, ?, ?, 0, ?)')
          .run(asset.sha256, asset.mimeType, asset.ext, asset.byteSize, nowIso, nowIso, asset.metaJson);
        c.assetsInserted += 1;
      }
    }
    if (fail === 'chat-insert') return rollback('chat-insert', 'injected-failure');
    db.prepare('INSERT INTO chats (id, title, is_saved, is_linked, message_count, user_turn_count, assistant_turn_count, last_message_at, created_at, updated_at, meta_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(payload.recoveredChatId, payload.chat.title, payload.chat.isSaved ? 1 : 0, payload.chat.isLinked ? 1 : 0, payload.chat.messageCount, payload.chat.userTurnCount, payload.chat.assistantTurnCount, payload.chat.lastMessageAt || 0, nowMs, nowMs, payload.chat.metaJson);
    if (fail === 'snapshot-insert') return rollback('snapshot-insert', 'injected-failure');
    db.prepare('INSERT INTO snapshots (id, chat_id, title, message_count, captured_at, updated_at, meta_json) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(snapshotId, payload.recoveredChatId, payload.snapshot.title, payload.snapshot.messageCount, nowMs, nowMs, payload.snapshot.metaJson);
    for (const t of payload.turns) {
      if (fail === 'turn-insert') return rollback('turn-insert', 'injected-failure');
      db.prepare('INSERT INTO snapshot_turns (snapshot_id, turn_idx, role, outer_html, text, meta_json) VALUES (?, ?, ?, ?, ?, ?)')
        .run(snapshotId, t.turnIdx, t.role, t.outerHtml, t.text, t.metaJson);
      c.turns += 1;
    }
    const linked = new Set();
    for (const l of payload.links) {
      if (fail === 'link-insert') return rollback('link-insert', 'injected-failure');
      db.prepare('INSERT INTO snapshot_turn_assets (snapshot_id, turn_idx, sha256, relation, created_at, meta_json) VALUES (?, ?, ?, ?, ?, ?)')
        .run(snapshotId, l.turnIdx, l.sha256, l.relation, nowIso, l.metaJson);
      c.links += 1;
      linked.add(l.sha256);
    }
    for (const sha of [...linked].sort()) {
      if (fail === 'refcount') return rollback('refcount', 'injected-failure');
      db.prepare('UPDATE assets SET refcount = (SELECT COUNT(*) FROM snapshot_turn_assets WHERE sha256 = ?), updated_at = ? WHERE sha256 = ?').run(sha, nowIso, sha);
      c.refcountsRecomputed += 1;
    }
    if (fail === 'commit') return rollback('commit', 'injected-failure');
    db.exec('COMMIT');
    const result = { schema: RECOVERY_SCHEMA, ok: true, committed: true, recoveredChatId: payload.recoveredChatId, recoveredSnapshotId: snapshotId, counts: c };
    if (typeof env.hooks.afterCommit === 'function') env.hooks.afterCommit(env, result);
    return result;
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (_) { /* already rolled back */ }
    return refuse('sql', 'sql-error');
  }
}

// ── the portable verifier double ───────────────────────────────────────────
function portableVerdictFor(env, session) {
  const declared = env.portableVerdicts.get(session.basename);
  if (!declared) return { schema: 'h2o.savedChatPortablePackageVerification', schemaVersion: 1, verified: false, refusal: { stage: 'adapter', code: 'portable-session-unknown' } };
  if (session.unexpected.length) return { schema: 'h2o.savedChatPortablePackageVerification', schemaVersion: 1, verified: false, refusal: { stage: 'members', code: 'generation-package-unexpected-member' } };
  for (const [key, member] of session.members) {
    if (member.received !== member.expected) return { schema: 'h2o.savedChatPortablePackageVerification', schemaVersion: 1, verified: false, refusal: { stage: 'members', code: 'portable-member-underrun:' + key } };
  }
  return declared;
}

// ── invoke router (all realms share this) ─────────────────────────────────
function invoke(cmd, a, b) {
  const env = current;
  if (!env) return Promise.reject(new Error('no current environment'));
  env.ledger.push({ cmd, path: a && typeof a === 'object' && !ArrayBuffer.isView(a) ? a.path : undefined });
  try {
    if (cmd === 'h2o_saved_chat_archive_integrity') {
      return Promise.resolve({ schema: 'h2o.savedChatArchiveIntegrity', schemaVersion: 1, complete: true, blockers: [], occupants: [...env.trusted.values()] });
    }
    if (cmd === 'plugin:fs|exists') return Promise.resolve(fs.existsSync(j(env, a.path)));
    if (cmd === 'plugin:fs|lstat') {
      const st = fs.lstatSync(j(env, a.path));
      return Promise.resolve({ isFile: st.isFile(), isDirectory: st.isDirectory(), isSymlink: st.isSymbolicLink(), size: st.size });
    }
    if (cmd === 'plugin:fs|read_file') {
      if (env.hooks.readFileFail && String(a.path) === env.hooks.readFileFail) return Promise.reject(new Error('EIO injected'));
      return Promise.resolve(Array.from(fs.readFileSync(j(env, a.path))));
    }
    if (cmd === 'plugin:fs|read_dir') {
      const p = j(env, a.path);
      return Promise.resolve(fs.existsSync(p) ? fs.readdirSync(p, { withFileTypes: true }).map((e) => ({ name: e.name, isDirectory: e.isDirectory(), isFile: e.isFile() })) : []);
    }
    if (cmd === 'plugin:sql|select') return Promise.resolve(env.db.prepare(a.query).all(...(a.values || [])));
    if (cmd === 'plugin:sql|execute') {
      const verb = String(a.query).trim().split(/\s+/)[0].toUpperCase();
      const tbl = (String(a.query).match(/(?:INTO|UPDATE|FROM)\s+([a-z_]+)/i) || [])[1] || '';
      const r = env.db.prepare(a.query).run(...(a.values || []));
      env.sqlWrites.push(verb + ' ' + tbl);
      return Promise.resolve([Number(r.changes), Number(r.lastInsertRowid)]);
    }
    if (cmd === 'h2o_archive_durable_write') {
      const opts = readOptionsHeader(b);
      const rel = String(opts.path || '');
      const shape = rel.match(/^assets\/([0-9a-f]{2})\/sha256-([0-9a-f]{64})$/);
      if (!shape || shape[2].slice(0, 2) !== shape[1]) throw new Error('durable_write refused non-CAS destination: ' + rel);
      const hex = shape[2];
      const p = 'archive/' + rel;
      const bytes = toArrayBytes(a);
      const race = env.hooks.raceCorruptOnPut;
      if (race && race.hex === hex && !race.fired) {
        /* A concurrent writer lands first — with CORRUPT bytes — between the
         * existence probe and the durable write. */
        race.fired = true;
        fs.mkdirSync(path.dirname(j(env, p)), { recursive: true });
        fs.writeFileSync(j(env, p), Buffer.from([0xde, 0xad]));
        return Promise.resolve({ schema: 'h2o.studio.archive.durable-write.v1', ok: false, committed: false, durabilityComplete: false, replaced: false, blockers: [{ code: 'durable-write-destination-exists' }] });
      }
      if (env.hooks.durableWriteFail && env.hooks.durableWriteFail.hex === hex) {
        return Promise.resolve({ schema: 'h2o.studio.archive.durable-write.v1', ok: false, committed: false, durabilityComplete: false, replaced: false, blockers: [{ code: env.hooks.durableWriteFail.code }] });
      }
      if (fs.existsSync(j(env, p))) {
        return Promise.resolve({ schema: 'h2o.studio.archive.durable-write.v1', ok: false, committed: false, durabilityComplete: false, replaced: false, blockers: [{ code: 'durable-write-destination-exists' }] });
      }
      fs.mkdirSync(path.dirname(j(env, p)), { recursive: true });
      fs.writeFileSync(j(env, p), Buffer.from(bytes));
      env.ledger.push({ cmd: 'cas-write', path: p });
      return Promise.resolve({ schema: 'h2o.studio.archive.durable-write.v1', ok: true, committed: true, durabilityComplete: true, replaced: false, byteLength: bytes.length, fullFsync: true, blockers: [] });
    }
    if (cmd === 'h2o_archive_cas_repair_write') {
      const bytes = toArrayBytes(a);
      const hex = sha256Hex(Buffer.from(bytes));
      const p = casPath(hex);
      const race = env.hooks.raceCorruptOnPut;
      env.ledger.push({ cmd: 'cas-repair', path: p });
      if (race && race.hex === hex && race.mode === 'already-valid') {
        /* The trusted side found the canonical object already valid (someone
         * else repaired it) and wrote nothing. */
        fs.writeFileSync(j(env, p), Buffer.from(bytes));
        return Promise.resolve({ schema: 'h2o.studio.archive.cas-repair-write.v1', ok: true, alreadyValid: true, repaired: false, committed: false, durabilityComplete: false, sha256: 'sha256-' + hex, blockers: [] });
      }
      fs.mkdirSync(path.dirname(j(env, p)), { recursive: true });
      const existed = fs.existsSync(j(env, p));
      fs.writeFileSync(j(env, p), Buffer.from(bytes));
      return Promise.resolve({ schema: 'h2o.studio.archive.cas-repair-write.v1', ok: true, alreadyValid: false, repaired: existed, committed: true, durabilityComplete: true, sha256: 'sha256-' + hex, blockers: [] });
    }
    if (cmd === RECOVERY_COMMAND) {
      if (env.hooks.nativeThrow) return Promise.reject(new Error('ipc transport failed (injected)'));
      return Promise.resolve(mockRecoveryCommit(env, a && a.payload));
    }
    if (cmd === 'h2o_saved_chat_portable_verify_begin') {
      const req = (a && a.options) || {};
      const token = env.portableToken++;
      env.portableSessions.set(token, { basename: String(req.packageDirName || ''), unexpected: Array.isArray(req.unexpectedMembers) ? req.unexpectedMembers : [], members: new Map() });
      return Promise.resolve({ schema: 'h2o.savedChatPortablePackageVerification', schemaVersion: 1, ok: true, token });
    }
    if (cmd === 'h2o_saved_chat_portable_verify_declare') {
      const req = (a && a.options) || {};
      const s = env.portableSessions.get(req.token);
      if (!s) return Promise.resolve({ ok: false, code: 'portable-session-unknown' });
      s.members.set(req.member, { expected: req.expectedLength, received: 0 });
      return Promise.resolve({ ok: true });
    }
    if (cmd === 'h2o_saved_chat_portable_verify_write') {
      const opts = JSON.parse((b && b.headers && b.headers.options) || '{}');
      const s = env.portableSessions.get(opts.token);
      const m = s && s.members.get(opts.member);
      if (!m) return Promise.resolve({ ok: false, code: 'portable-member-undeclared' });
      m.received += toArrayBytes(a).length;
      return Promise.resolve({ ok: true });
    }
    if (cmd === 'h2o_saved_chat_portable_verify_finish') {
      const token = a && a.options && a.options.token;
      const s = env.portableSessions.get(token);
      env.portableSessions.delete(token);
      if (!s) return Promise.resolve({ schema: 'h2o.savedChatPortablePackageVerification', schemaVersion: 1, verified: false, refusal: { stage: 'adapter', code: 'portable-session-unknown' } });
      return Promise.resolve(portableVerdictFor(env, s));
    }
    if (cmd === 'h2o_saved_chat_portable_verify_abort') { env.portableSessions.delete(a && a.options && a.options.token); return Promise.resolve({ ok: true }); }
  } catch (e) { return Promise.reject(e); }
  return Promise.reject(new Error('unmocked invoke: ' + cmd));
}

// ── realm: the real modules booted as source ───────────────────────────────
function bootRealm({ importerSource } = {}) {
  const sb = {
    console, crypto: crypto.webcrypto, TextEncoder, TextDecoder, setTimeout, clearTimeout, Date, Math, JSON, Promise,
    btoa: globalThis.btoa, atob: globalThis.atob, CompressionStream: globalThis.CompressionStream, DecompressionStream: globalThis.DecompressionStream,
    Response: globalThis.Response, Blob: globalThis.Blob, structuredClone,
    performance,
    document: undefined,
    H2O: { Studio: { platform: { env: { isTauri: true }, __sqliteStatus: () => ({ backend: 'sqlite', ready: true }) } } },
  };
  sb.__TAURI_INTERNALS__ = { invoke };
  sb.globalThis = sb;
  sb.window = sb;
  vm.createContext(sb);
  for (const rel of MODULES) {
    let src = fs.readFileSync(path.join(STUDIO_ROOT, rel), 'utf8');
    if (rel.endsWith('saved-chat-archive-importer.studio.js') && typeof importerSource === 'string') src = importerSource;
    vm.runInContext(src, sb, { filename: rel });
  }
  const S = sb.H2O.Studio;
  assert.ok(S.archiveImporter && S.archiveInspector && S.ingestion.assetCas && S.store.assets && S.store.snapshots && S.store.chats, 'real modules must register');
  assert.ok(S.ingestion.savedChatPortableZip && typeof S.ingestion.verifySavedChatPortablePackageV1 === 'function', 'portable modules must register');
  return sb;
}

// ── scenario runner ────────────────────────────────────────────────────────
async function importArchive(realm, env, packagePath) {
  current = env;
  const importer = realm.H2O.Studio.archiveImporter;
  const dry = await importer.dryRunImportPackage({ packagePath });
  const result = await importer.importVerifiedPackage({ packagePath, mode: 'import-as-new' });
  return { dry, result };
}
function recoveredRows(env, result) {
  const rec = result && result.recovered ? result.recovered : {};
  const snap = rec.newSnapshotId ? env.db.prepare('SELECT * FROM snapshots WHERE id = ?').get(rec.newSnapshotId) : null;
  const chat = rec.newChatId ? env.db.prepare('SELECT * FROM chats WHERE id = ?').get(rec.newChatId) : null;
  const turns = rec.newSnapshotId ? env.db.prepare('SELECT turn_idx, role, outer_html, text, meta_json FROM snapshot_turns WHERE snapshot_id = ? ORDER BY turn_idx').all(rec.newSnapshotId) : [];
  const links = rec.newSnapshotId ? env.db.prepare('SELECT turn_idx, sha256, relation FROM snapshot_turn_assets WHERE snapshot_id = ? ORDER BY turn_idx, sha256').all(rec.newSnapshotId) : [];
  return { chat, snap, turns, links };
}
const linkKeys = (links) => links.map((l) => `${l.turn_idx}:${l.sha256}`);
const EXPECTED_LINKS = [`1:${FIX.png.sha256}`, `2:${FIX.png.sha256}`, `2:${FIX.gif.sha256}`].sort();

// ── static facts ───────────────────────────────────────────────────────────
console.log('[asset-restoration-harness] static');
check('[AR-STATIC] fixture, importer, native module, registration and doc exist', () => {
  for (const rel of [FIXTURE_PKG_REL + '/manifest.json', FIXTURE_PKG_REL + '/snapshot.json', FIXTURE_DIR_REL + '/README.md', IMPORTER_REL, NATIVE_REL, LIB_RS_REL, DOC_REL]) {
    assert.ok(exists(rel), 'missing: ' + rel);
  }
  assert.equal(FIX.assets.length, 2);
  assert.equal(FIX.png.mimeType, 'image/png');
  assert.equal(FIX.gif.mimeType, 'image/gif');
  assert.ok(FIX.png.bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), 'asset A is a real PNG');
  assert.ok(FIX.gif.bytes.subarray(0, 6).equals(Buffer.from('GIF89a')), 'asset B is a real GIF');
  for (const a of FIX.assets) {
    assert.equal(sha256Pfx(a.bytes), a.sha256, 'asset bytes hash to their identity');
    assert.equal(a.bytes.length, a.byteLength);
    assert.equal(a.path, `assets/${a.sha256}.${a.ext}`);
  }
  assert.equal(sha256Pfx(FIX.snapshotBytes), FIX.manifest.files.snapshot.sha256);
  const pre = `{"assets":[${FIX.assets.map((a) => a.sha256).sort().map((s) => `"${s}"`).join(',')}],"payloadVersion":3,"snapshot":"${FIX.manifest.files.snapshot.sha256}"}`;
  assert.equal(sha256Pfx(Buffer.from(pre)), FIX.manifest.contentHash, 'v3 contentHash reproduces from the exact pre-image');
  const messages = FIX.snapshot.messages;
  assert.ok(messages.every((m) => m.content.some((p) => p.type === 'html' && p.html)), 'every message has an html part (rich coverage)');
  assert.deepEqual(messages[1].assetRefs, [FIX.png.sha256]);
  assert.deepEqual(messages[2].assetRefs, [FIX.png.sha256, FIX.gif.sha256]);
  assert.equal(messages[1].role, 'assistant');
});

check('[AR-STATIC] importer keeps the asset-free legacy path and adds the bounded asset-bearing branch', () => {
  const code = stripComments(readRepo(IMPORTER_REL));
  assert.ok(code.includes('buildAssetRecoveryPlan('), 'plan builder');
  assert.ok(code.includes('ensureDestinationCas('), 'CAS ensure');
  assert.ok(code.includes(`'${RECOVERY_COMMAND}'`), 'native recovery command');
  assert.ok(code.includes('proveAssetRecoveryCommit('), 'post-commit proof');
  assert.ok(code.includes('reloadRecoveryStoreViews('), 'store reload');
  assert.ok(code.includes('hydrateRecoveredSnapshotProjectionV1'), 'hydration helper exported');
  /* the asset-free branch still uses the legacy adapters and never the native command */
  assert.ok(/chatStore\.upsert\(chatPatch\)/.test(code) && /snapStore\.create\(snapPatch\)/.test(code), 'legacy write path intact');
  assert.ok(code.includes('if (plan.assetBearing)'), 'the native path is reached only on a trusted non-empty asset set');
  /* no second CAS authority, no raw SQL, no plugin fs write */
  for (const banned of ['plugin:sql|', 'plugin:fs|write', 'INSERT INTO', 'createHash', 'subtle.digest', 'sha256PrefixedBytes(']) {
    assert.ok(!code.includes(banned), 'importer must not contain: ' + banned);
  }
  assert.ok(code.includes('readBoundedPackageMemberBytes({') && code.includes('physicalByteCap: cap'), 'asset members are read through the bounded codec with the CAS cap');
  assert.ok(!/readVerifiedPackageMember\(\{[^}]*memberPath: descriptor/.test(code), 'assets never go through the snapshot-capped verified-member read');
});

check('[AR-STATIC] native command is registered once per invoke-handler list and the module is closed-schema, insert-only', () => {
  const lib = readRepo(LIB_RS_REL);
  assert.equal((lib.match(/^pub mod saved_chat_asset_recovery;/gm) || []).length, 1);
  assert.equal((lib.match(/^\s+h2o_saved_chat_asset_recovery_commit,\s*$/gm) || []).length, 2, 'registered in both handler lists');
  assert.ok(/async fn h2o_saved_chat_asset_recovery_commit\(/.test(lib));
  assert.ok(/instances\.get\(F5G4_DB_URL\)/.test(lib.slice(lib.indexOf('async fn h2o_saved_chat_asset_recovery_commit'))), 'wrapper resolves the Desktop pool');
  const rs = readRepo(NATIVE_REL);
  assert.ok((rs.match(/deny_unknown_fields/g) || []).length >= 6, 'closed input schema at every level');
  assert.ok(rs.includes('conn.begin().await') && rs.includes('tx.commit().await') && rs.includes('tx.rollback().await'), 'one transaction, commit once, rollback on failure');
  const code = rs.replace(/\/\/.*$/gm, '');
  assert.ok(!/\bDELETE\s+FROM\b/i.test(code), 'no DELETE');
  assert.ok(!/UPDATE\s+(chats|snapshots|snapshot_turns|snapshot_turn_assets)\b/i.test(code), 'no UPDATE of chat / snapshot / turn / link rows');
  assert.ok(/UPDATE assets SET refcount = \(SELECT COUNT\(\*\) FROM snapshot_turn_assets WHERE sha256 = \?\)/.test(code), 'refcount is the authoritative join recompute');
  assert.ok(code.includes('recovered-chat-id-exists') && code.includes('snapshot-id-collision') && code.includes('registry-byte-size-contradiction'), 'fresh-identity and no-clobber refusals');
  assert.ok(code.includes('mint_snapshot_id()'), 'snapshot identity is minted natively');
});

// ── live scenarios ─────────────────────────────────────────────────────────
console.log('[asset-restoration-harness] live');
const realm = bootRealm();
const S = realm.H2O.Studio;

await checkAsync('[AR-02][AR-17][AR-03] archive asset-bearing package: plan → CAS ensure → ONE native commit → proof → imported-asset-complete', async () => {
  const env = createEnv('AR-02');
  const pkg = stageArchive(env);
  const before = counts(env);
  const { dry, result } = await importArchive(realm, env, pkg);
  assert.equal(dry.decision, 'import-ready', JSON.stringify(dry));
  assert.equal(dry.assets.requiredAssetCount, 2, 'dry-run reports the trusted asset count');
  assert.equal(result.status, 'imported', JSON.stringify(result));
  assert.equal(result.ok, true);
  assert.equal(result.assets.result, 'imported-asset-complete');
  assert.equal(result.assets.requiredCount, 2);
  assert.equal(result.assets.referencedCount, 2);
  assert.equal(result.assets.linkCount, 3);
  assert.deepEqual(plain(result.assets.materialized).sort(), FIX.assets.map((a) => a.sha256).sort());
  assert.deepEqual(plain(result.assets.reused), []);
  assert.deepEqual(plain(result.assets.proofProblems), []);
  const after = counts(env);
  assert.deepEqual(after, { chats: before.chats + 1, snapshots: before.snapshots + 1, turns: before.turns + 3, assets: before.assets + 2, links: before.links + 3 });
  /* ordering: every CAS write precedes the single native commit; the legacy
   * adapters issued NO write on this branch. */
  const idx = (pred) => env.ledger.findIndex(pred);
  const casWrites = env.ledger.map((e, i) => ({ e, i })).filter(({ e }) => e.cmd === 'cas-write');
  const nativeAt = idx((e) => e.cmd === RECOVERY_COMMAND);
  assert.equal(casWrites.length, 2);
  assert.ok(casWrites.every(({ i }) => i < nativeAt), 'CAS first, then the transaction');
  assert.equal(env.ledger.filter((e) => e.cmd === RECOVERY_COMMAND).length, 1, 'exactly one native commit');
  assert.deepEqual(env.sqlWrites, [], 'no renderer-side SQL write on the asset-bearing branch');
  /* rows */
  const rows = recoveredRows(env, result);
  assert.ok(rows.chat && rows.snap);
  assert.equal(rows.chat.is_saved, 1);
  assert.equal(rows.chat.message_count, 3);
  assert.equal(rows.chat.assistant_turn_count, 2);
  assert.equal(JSON.parse(rows.chat.meta_json).recovered.recoveredFromPackage, true);
  assert.equal(JSON.parse(rows.chat.meta_json).answerCount, 2);
  assert.equal(JSON.parse(rows.snap.meta_json).recovered.recoveredFromPackage, true);
  assert.equal(JSON.parse(rows.snap.meta_json).recovered.originalSnapshotId, FIX.snapshotId);
  assert.notEqual(rows.snap.id, FIX.snapshotId);
  assert.notEqual(rows.chat.id, FIX.chatId);
  assert.ok(String(rows.chat.id).startsWith('recovered_'));
  assert.equal(rows.turns.length, 3);
  assert.ok(rows.turns[1].outer_html.includes(`src="assets/${FIX.png.sha256}.png"`), 'persisted turn html keeps the canonical package reference');
  assert.deepEqual(linkKeys(rows.links).sort(), EXPECTED_LINKS);
  /* AR-03: one asset in two turns → one CAS object, one registry row, two links, refcount 2 */
  assert.equal(env.db.prepare('SELECT refcount FROM assets WHERE sha256 = ?').get(FIX.png.sha256).refcount, 2);
  assert.equal(env.db.prepare('SELECT refcount FROM assets WHERE sha256 = ?').get(FIX.gif.sha256).refcount, 1);
  assert.ok(casObjectExists(env, bare(FIX.png.sha256)) && casObjectExists(env, bare(FIX.gif.sha256)));
  assert.ok(casObjectBytes(env, bare(FIX.png.sha256)).equals(FIX.png.bytes), 'destination CAS holds the exact trusted bytes');
  /* the native payload shape */
  const payload = env.nativeCalls[0];
  assert.equal(payload.schema, RECOVERY_SCHEMA);
  assert.equal(payload.originalChatId, FIX.chatId);
  assert.equal(payload.originalSnapshotId, FIX.snapshotId);
  assert.equal(payload.turns.length, 3);
  assert.equal(payload.assets.length, 2);
  assert.equal(payload.links.length, 3);
  assert.ok(payload.assets.every((a) => typeof a.metaJson === 'string' && a.byteSize > 0));
  /* store views reloaded after commit */
  assert.deepEqual(plain(result.assets.storeReloads).map((r) => r.store + ':' + r.reloaded).sort(), ['assets:true', 'chats:true', 'snapshots:true']);
});

await checkAsync('[AR-01][AR-23] asset-free package keeps the legacy write path byte-for-byte (no CAS, no native command)', async () => {
  const env = createEnv('AR-01');
  const pkg = stageArchive(env, {
    dirName: 'ar-asset-free.h2ochat',
    mutate: (dst) => {
      const m = readStagedManifest(dst);
      const snap = JSON.parse(fs.readFileSync(path.join(dst, 'snapshot.json'), 'utf8'));
      snap.chatId = 'ar-asset-free'; snap.snapshotId = 'snap_ar_asset_free';
      for (const msg of snap.messages) { msg.assetRefs = []; }
      const snapBytes = Buffer.from(canonicalJson(snap) + '\n');
      fs.writeFileSync(path.join(dst, 'snapshot.json'), snapBytes);
      fs.rmSync(path.join(dst, 'assets'), { recursive: true, force: true });
      m.chatId = 'ar-asset-free'; m.snapshotId = 'snap_ar_asset_free'; m.assets = [];
      m.files.snapshot.sha256 = sha256Pfx(snapBytes); m.files.snapshot.byteLength = snapBytes.length;
      m.contentHash = sha256Pfx(Buffer.from(`{"assets":[],"payloadVersion":3,"snapshot":"${m.files.snapshot.sha256}"}`));
      writeStagedManifest(dst, m);
    },
    trustedShas: [],
  });
  const { dry, result } = await importArchive(realm, env, pkg);
  assert.equal(dry.decision, 'import-ready');
  assert.equal(dry.assets.requiredAssetCount, 0);
  assert.equal(result.status, 'imported', JSON.stringify(result));
  assert.equal(result.assets, undefined, 'no asset block on the legacy path');
  assert.equal(env.ledger.filter((e) => e.cmd === RECOVERY_COMMAND).length, 0, 'native command never invoked');
  assert.equal(env.ledger.filter((e) => e.cmd === 'cas-write' || e.cmd === 'h2o_archive_durable_write').length, 0, 'no CAS write');
  /* the legacy adapters' exact write ledger (snapshots.create = INSERT + DELETE/INSERT turn batch) */
  assert.deepEqual(env.sqlWrites, ['INSERT chats', 'INSERT snapshots', 'DELETE snapshot_turns', 'INSERT snapshot_turns'], 'legacy adapter ledger unchanged');
  const rows = recoveredRows(env, result);
  assert.equal(rows.turns.length, 3);
  assert.equal(rows.links.length, 0);
  assert.equal(counts(env).assets, 0);
});

await checkAsync('[AR-24] portable ZIP asset-bearing control: same verified in-memory entry set, same outcome', async () => {
  const env = createEnv('AR-24');
  current = env;
  const zip = S.ingestion.savedChatPortableZip;
  const rootName = FIX.chatId + '.h2ochat';
  const entries = [
    { name: `${rootName}/manifest.json`, bytes: fs.readFileSync(path.join(FIX.dir, 'manifest.json')) },
    { name: `${rootName}/snapshot.json`, bytes: FIX.snapshotBytes },
    { name: `${rootName}/chat.md`, bytes: Buffer.from('# companion\n') },
    { name: `${rootName}/chat.html`, bytes: Buffer.from('<!doctype html><p>companion</p>') },
    ...FIX.assets.map((a) => ({ name: `${rootName}/${a.path}`, bytes: a.bytes })),
  ];
  const zipBytes = await zip.buildPortableZip(entries, { method: zip.METHOD_STORED });
  const zipDigestBefore = sha256Hex(Buffer.from(zipBytes));
  env.portableVerdicts.set(rootName, {
    schema: 'h2o.savedChatPortablePackageVerification', schemaVersion: 1, verified: true,
    packageDirName: rootName, chatId: FIX.chatId, snapshotId: FIX.snapshotId, contentHash: bare(FIX.manifest.contentHash),
    constructionFamily: 'v3', nameClassification: 'legacy', savedAt: '2026-09-18T00:00:00.000Z',
    assetShas: FIX.assets.map((a) => bare(a.sha256)).sort(), logicalSnapshotByteLength: FIX.snapshotBytes.length,
  });
  const importer = S.archiveImporter;
  const dry = await importer.dryRunImportZip({ zipBytes, sourceName: 'portable.h2ochat.zip' });
  assert.equal(dry.decision, 'import-ready', JSON.stringify(dry));
  assert.equal(dry.assets.requiredAssetCount, 2);
  const result = await importer.importVerifiedZip({ zipBytes, sourceName: 'portable.h2ochat.zip', mode: 'import-as-new' });
  assert.equal(result.status, 'imported', JSON.stringify(result));
  assert.equal(result.assets.result, 'imported-asset-complete');
  assert.equal(sha256Hex(Buffer.from(zipBytes)), zipDigestBefore, 'the in-memory ZIP bytes are untouched');
  const rows = recoveredRows(env, result);
  assert.deepEqual(linkKeys(rows.links).sort(), EXPECTED_LINKS);
  assert.equal(JSON.parse(rows.snap.meta_json).recovered.source, 'h2ochat-zip-recovery');
  assert.ok(casObjectBytes(env, bare(FIX.gif.sha256)).equals(FIX.gif.bytes));
  assert.equal(env.ledger.filter((e) => e.cmd === 'plugin:fs|read_file' && /archive\/packages/.test(String(e.path))).length, 0, 'portable path performs no second package read');
  assert.deepEqual(env.sqlWrites, []);
});

await checkAsync('[AR-04] duplicate same-turn refs collapse to ONE logical link (plan-level dedupe; native refuses duplicates)', async () => {
  const env = createEnv('AR-04');
  const pkg = stageArchive(env, {
    mutate: (dst) => {
      const snap = JSON.parse(fs.readFileSync(path.join(dst, 'snapshot.json'), 'utf8'));
      snap.messages[1].assetRefs = [FIX.png.sha256, FIX.png.sha256, FIX.png.sha256];
      const snapBytes = Buffer.from(canonicalJson(snap) + '\n');
      fs.writeFileSync(path.join(dst, 'snapshot.json'), snapBytes);
      const m = readStagedManifest(dst);
      m.files.snapshot.sha256 = sha256Pfx(snapBytes); m.files.snapshot.byteLength = snapBytes.length;
      writeStagedManifest(dst, m);
    },
  });
  const { result } = await importArchive(realm, env, pkg);
  assert.equal(result.status, 'imported', JSON.stringify(result));
  const payload = env.nativeCalls[0];
  assert.equal(payload.links.filter((l) => l.turnIdx === 1).length, 1, 'plan carries one logical link for the duplicated ref');
  assert.deepEqual(linkKeys(recoveredRows(env, result).links).sort(), EXPECTED_LINKS);
  /* the native double (like the Rust command) refuses a non-deduped plan */
  const dup = JSON.parse(JSON.stringify(payload));
  dup.recoveredChatId = 'recovered_dup-control';
  dup.links.push({ ...dup.links[0] });
  const refused = mockRecoveryCommit(env, dup);
  assert.equal(refused.code, 'duplicate-logical-link');
});

/* Refusal matrix — each must write NOTHING (no CAS object, no DB row). */
const refusalCases = [
  ['[AR-05] declared asset missing from members', (dst) => fs.rmSync(path.join(dst, FIX.gif.path)), 'asset-member-missing-or-unreadable', {}],
  ['[AR-06] undeclared / unexpected asset member (manifest lists an asset outside the trusted set)', (dst) => {
    const m = readStagedManifest(dst);
    const extra = Buffer.from('not-trusted');
    const sha = sha256Pfx(extra);
    fs.writeFileSync(path.join(dst, `assets/${sha}.png`), extra);
    m.assets.push({ sha256: sha, path: `assets/${sha}.png`, mimeType: 'image/png', ext: 'png', byteLength: extra.length, source: 'x' });
    writeStagedManifest(dst, m);
  }, 'asset-set-mismatch', {}],
  ['[AR-07][AR-25] member substitution: bytes replaced after the trusted ruling (hash mismatch)', (dst) => {
    fs.writeFileSync(path.join(dst, FIX.png.path), Buffer.concat([FIX.png.bytes.subarray(0, 60), Buffer.from([0, 0, 0, 0, 0, 0, 0, 0, 0, 0])]));
  }, 'asset-sha-mismatch', {}],
  ['[AR-08] byte-length contradiction between the constrained descriptor and the member', (dst) => {
    const m = readStagedManifest(dst);
    m.assets.find((a) => a.ext === 'png').byteLength = FIX.png.byteLength + 1;
    writeStagedManifest(dst, m);
  }, 'asset-byte-length-mismatch', {}],
  ['[AR-25] unbound descriptor: manifest path/ext does not bind to the trusted SHA', (dst) => {
    const m = readStagedManifest(dst);
    const a = m.assets.find((x) => x.ext === 'gif');
    a.path = `assets/${a.sha256}.png`;
    writeStagedManifest(dst, m);
  }, 'asset-descriptor-path-unbound', {}],
  ['[AR-25] trusted-set mismatch: trusted verifier requires an asset the manifest no longer declares', (dst) => {
    const m = readStagedManifest(dst);
    m.assets = m.assets.filter((x) => x.ext !== 'gif');
    writeStagedManifest(dst, m);
  }, 'asset-set-mismatch', {}],
  ['[AR-06] assetRef outside the trusted required set', (dst) => {
    const snap = JSON.parse(fs.readFileSync(path.join(dst, 'snapshot.json'), 'utf8'));
    snap.messages[0].assetRefs = ['sha256-' + 'c'.repeat(64)];
    const snapBytes = Buffer.from(canonicalJson(snap) + '\n');
    fs.writeFileSync(path.join(dst, 'snapshot.json'), snapBytes);
    const m = readStagedManifest(dst);
    m.files.snapshot.sha256 = sha256Pfx(snapBytes); m.files.snapshot.byteLength = snapBytes.length;
    writeStagedManifest(dst, m);
  }, 'asset-ref-outside-trusted-set', {}],
];
for (const [label, mutate, expectedCode] of refusalCases) {
  await checkAsync(`${label} → refused before any mutation`, async () => {
    const env = createEnv(label);
    const pkg = stageArchive(env, { mutate });
    const dbBefore = dbDigest(env);
    const { result } = await importArchive(realm, env, pkg);
    assert.equal(result.status, 'rejected', JSON.stringify(result));
    assert.equal(result.ok, false);
    assert.equal(result.assets && result.assets.result, expectedCode, JSON.stringify(result.assets));
    assert.equal(dbDigest(env), dbBefore, 'DB unchanged');
    assert.equal(casDigest(env), '', 'no CAS object written');
    assert.equal(env.ledger.filter((e) => e.cmd === RECOVERY_COMMAND).length, 0);
    assert.deepEqual(env.sqlWrites, []);
  });
}

await checkAsync('[AR-09] asset over the current CAS ingest bound and absent from CAS → coded bound refusal, no put', async () => {
  const env = createEnv('AR-09');
  const cap = S.ingestion.assetCas.assetBlobCapBytes;
  /* Do not allocate 32 MiB on disk: shrink the module-published cap for this
   * scenario through the SAME authority value the plan reads. */
  const realCas = S.ingestion.assetCas;
  const smallCas = Object.assign({}, realCas, { assetBlobCapBytes: 40 });
  S.ingestion.assetCas = smallCas;
  try {
    const pkg = stageArchive(env);
    const { result } = await importArchive(realm, env, pkg);
    assert.equal(result.status, 'rejected', JSON.stringify(result));
    assert.equal(result.assets.result, 'asset-restoration-bound-refusal');
    assert.equal(casDigest(env), '');
    assert.equal(env.ledger.filter((e) => e.cmd === 'h2o_archive_durable_write').length, 0, 'no put attempted');
    assert.equal(counts(env).chats, 0);
    assert.ok(cap === 33554432, 'the real module cap is the governed 32 MiB');
  } finally {
    S.ingestion.assetCas = realCas;
  }
});

await checkAsync('[AR-10] pre-existing valid CAS object → CAS_REUSED_VERIFIED, no write', async () => {
  const env = createEnv('AR-10');
  fs.mkdirSync(path.dirname(j(env, casPath(bare(FIX.png.sha256)))), { recursive: true });
  fs.writeFileSync(j(env, casPath(bare(FIX.png.sha256))), FIX.png.bytes);
  const pkg = stageArchive(env);
  const { result } = await importArchive(realm, env, pkg);
  assert.equal(result.status, 'imported', JSON.stringify(result));
  assert.deepEqual(plain(result.assets.reused), [FIX.png.sha256]);
  assert.deepEqual(plain(result.assets.materialized), [FIX.gif.sha256]);
  assert.equal(env.ledger.filter((e) => e.cmd === 'cas-write').length, 1, 'only the absent object was written');
});

await checkAsync('[AR-11] pre-existing CORRUPT CAS object → DESTINATION_CAS_CORRUPT, no repair, no DB write', async () => {
  const env = createEnv('AR-11');
  fs.mkdirSync(path.dirname(j(env, casPath(bare(FIX.png.sha256)))), { recursive: true });
  fs.writeFileSync(j(env, casPath(bare(FIX.png.sha256))), Buffer.from('corrupt-bytes'));
  const pkg = stageArchive(env);
  const dbBefore = dbDigest(env);
  const casBefore = casDigest(env);
  const { result } = await importArchive(realm, env, pkg);
  assert.equal(result.status, 'rejected', JSON.stringify(result));
  assert.equal(result.assets.result, 'DESTINATION_CAS_CORRUPT');
  assert.equal(result.assets.failedSha256, FIX.png.sha256);
  assert.equal(env.ledger.filter((e) => e.cmd === 'cas-repair' || e.cmd === 'h2o_archive_cas_repair_write').length, 0, 'recovery performed no repair');
  assert.equal(env.ledger.filter((e) => e.cmd === RECOVERY_COMMAND).length, 0);
  assert.equal(dbDigest(env), dbBefore);
  /* the gif sorts before the png: it was materialized first and remains as classified residue */
  assert.ok(casObjectExists(env, bare(FIX.gif.sha256)), 'earlier verified object remains');
  assert.deepEqual(plain(result.assets.residue), [FIX.gif.sha256]);
  assert.equal(result.assets.residueClass, 'VERIFIED_UNREFERENCED_CAS_RESIDUE');
  assert.ok(fs.readFileSync(j(env, casPath(bare(FIX.png.sha256)))).equals(Buffer.from('corrupt-bytes')), 'the corrupt object was not touched');
  assert.notEqual(casDigest(env), casBefore, 'only the gif materialization changed the CAS');
});

await checkAsync('[AR-26] putAssetBytes repaired:true (destination race with corrupt bytes) → DESTINATION_CAS_CORRUPT before the transaction', async () => {
  const env = createEnv('AR-26');
  env.hooks.raceCorruptOnPut = { hex: bare(FIX.png.sha256), mode: 'repaired' };
  const pkg = stageArchive(env);
  const { result } = await importArchive(realm, env, pkg);
  assert.equal(result.status, 'rejected', JSON.stringify(result));
  assert.equal(result.assets.result, 'DESTINATION_CAS_CORRUPT');
  assert.ok(env.ledger.some((e) => e.cmd === 'cas-repair'), 'the CAS module repaired internally (that fact is recorded as corruption evidence)');
  assert.equal(env.ledger.filter((e) => e.cmd === RECOVERY_COMMAND).length, 0, 'no DB transaction');
  assert.equal(counts(env).chats, 0);
});

await checkAsync('[AR-26] hidden already-valid repair path (dedupe-shaped result after a repair ran) → DESTINATION_CAS_CORRUPT', async () => {
  const env = createEnv('AR-26b');
  env.hooks.raceCorruptOnPut = { hex: bare(FIX.png.sha256), mode: 'already-valid' };
  const pkg = stageArchive(env);
  const { result } = await importArchive(realm, env, pkg);
  assert.equal(result.status, 'rejected', JSON.stringify(result));
  assert.equal(result.assets.result, 'DESTINATION_CAS_CORRUPT');
  assert.equal(env.ledger.filter((e) => e.cmd === RECOVERY_COMMAND).length, 0);
});

await checkAsync('[AR-12] CAS write failure after an earlier materialization → failed, residue only, zero DB rows', async () => {
  const env = createEnv('AR-12');
  env.hooks.durableWriteFail = { hex: bare(FIX.png.sha256), code: 'durable-write-io-error' };
  const pkg = stageArchive(env);
  const { result } = await importArchive(realm, env, pkg);
  assert.equal(result.status, 'rejected', JSON.stringify(result));
  assert.equal(result.assets.result, 'CAS_WRITE_FAILED');
  assert.deepEqual(plain(result.assets.residue), [FIX.gif.sha256]);
  assert.equal(result.assets.residueClass, 'VERIFIED_UNREFERENCED_CAS_RESIDUE');
  assert.ok(casObjectExists(env, bare(FIX.gif.sha256)) && !casObjectExists(env, bare(FIX.png.sha256)));
  assert.equal(env.ledger.filter((e) => e.cmd === RECOVERY_COMMAND).length, 0);
  assert.deepEqual(counts(env), { chats: 0, snapshots: 0, turns: 0, assets: 0, links: 0 });
  /* a later explicit retry deduplicates the residue and completes */
  env.hooks.durableWriteFail = null;
  const retry = await importArchive(realm, env, pkg);
  assert.equal(retry.result.status, 'imported', JSON.stringify(retry.result));
  assert.deepEqual(plain(retry.result.assets.reused), [FIX.gif.sha256]);
});

for (const [label, stage] of [
  ['[AR-13] registry ensure failure', 'registry-ensure'],
  ['[AR-14] chat insert failure', 'chat-insert'],
  ['[AR-15] snapshot/turn insert failure', 'turn-insert'],
  ['[AR-16] link/refcount failure', 'refcount'],
]) {
  await checkAsync(`${label} → transaction rolled back; CAS residue only; truthful result`, async () => {
    const env = createEnv(label);
    env.hooks.nativeFailStage = stage;
    const pkg = stageArchive(env);
    const dbBefore = dbDigest(env);
    const { result } = await importArchive(realm, env, pkg);
    assert.equal(result.status, 'rejected', JSON.stringify(result));
    assert.equal(result.assets.result, 'recovery-transaction-rolled-back');
    assert.equal(result.assets.commit.stage, stage);
    assert.equal(result.assets.commit.committed, false);
    assert.equal(dbDigest(env), dbBefore, 'no DB row survives the rollback');
    assert.deepEqual(plain(result.assets.residue).sort(), FIX.assets.map((a) => a.sha256).sort(), 'verified unreferenced residue is classified, not deleted');
    assert.equal(result.assets.residueClass, 'VERIFIED_UNREFERENCED_CAS_RESIDUE');
    assert.ok(casObjectExists(env, bare(FIX.png.sha256)));
    assert.equal(result.recovered, null, 'no recovered identity is reported');
  });
}

await checkAsync('[AR-18] commit succeeded but post-commit proof fails → committed-verification-failed with committed identities, no second recovery', async () => {
  const env = createEnv('AR-18');
  env.hooks.afterCommit = (e) => { fs.rmSync(j(e, casPath(bare(FIX.gif.sha256)))); };
  const pkg = stageArchive(env);
  const { result } = await importArchive(realm, env, pkg);
  assert.equal(result.status, 'committed-verification-failed', JSON.stringify(result));
  assert.equal(result.ok, false);
  assert.equal(result.assets.result, 'committed-verification-failed');
  assert.ok(result.assets.proofProblems.some((p) => p.startsWith('cas-object-unverified:')), JSON.stringify(result.assets.proofProblems));
  assert.ok(result.recovered && result.recovered.newChatId && result.recovered.newSnapshotId, 'committed identities are surfaced');
  assert.equal(env.ledger.filter((e) => e.cmd === RECOVERY_COMMAND).length, 1, 'no automatic second recovery');
  assert.equal(counts(env).chats, 1);
});

await checkAsync('[AR-18b] ambiguous transport failure after the request left the renderer → reported, never retried', async () => {
  const env = createEnv('AR-18b');
  env.hooks.nativeThrow = true;
  const pkg = stageArchive(env);
  const { result } = await importArchive(realm, env, pkg);
  assert.equal(result.status, 'rejected');
  assert.equal(result.assets.result, 'recovery-transaction-transport-failed');
  assert.equal(result.assets.ambiguousCommit, true);
  assert.equal(env.ledger.filter((e) => e.cmd === RECOVERY_COMMAND).length, 1);
});

await checkAsync('[AR-19][AR-21][AR-22] repeated explicit Recover as New → fresh identities, deduped CAS, refcounts from the join; original rows and registry metadata untouched', async () => {
  const env = createEnv('AR-19');
  /* pre-existing "original" rows under the package's own ids, plus a registry
   * row for the gif with its own presentation metadata */
  env.db.prepare("INSERT INTO chats (id, title, meta_json) VALUES (?, 'Original', '{\"origin\":true}')").run(FIX.chatId + '-other');
  env.db.prepare("INSERT INTO assets (sha256, mime_type, ext, byte_size, created_at, updated_at, refcount, meta_json) VALUES (?, 'image/webp', 'webp', ?, 'seed', 'seed', 0, '{\"seed\":1}')").run(FIX.gif.sha256, FIX.gif.byteLength);
  const originalDigest = () => sha256Hex(JSON.stringify([env.db.prepare('SELECT * FROM chats WHERE id = ?').get(FIX.chatId + '-other')]));
  const seedDigest = originalDigest();
  const pkg = stageArchive(env);
  const first = await importArchive(realm, env, pkg);
  assert.equal(first.result.status, 'imported', JSON.stringify(first.result));
  const second = await importArchive(realm, env, pkg);
  assert.equal(second.result.status, 'imported', JSON.stringify(second.result));
  assert.notEqual(first.result.recovered.newChatId, second.result.recovered.newChatId);
  assert.notEqual(first.result.recovered.newSnapshotId, second.result.recovered.newSnapshotId);
  assert.deepEqual(plain(second.result.assets.reused).sort(), FIX.assets.map((a) => a.sha256).sort(), 'second recovery reuses both CAS objects');
  assert.deepEqual(plain(second.result.assets.materialized), []);
  assert.equal(env.db.prepare('SELECT refcount FROM assets WHERE sha256 = ?').get(FIX.png.sha256).refcount, 4);
  assert.equal(env.db.prepare('SELECT refcount FROM assets WHERE sha256 = ?').get(FIX.gif.sha256).refcount, 2);
  const gifRow = env.db.prepare('SELECT mime_type, ext, meta_json, created_at FROM assets WHERE sha256 = ?').get(FIX.gif.sha256);
  assert.deepEqual(plain(gifRow), { mime_type: 'image/webp', ext: 'webp', meta_json: '{"seed":1}', created_at: 'seed' }, 'existing registry metadata is never clobbered');
  assert.equal(originalDigest(), seedDigest, 'original rows unchanged');
  assert.equal(counts(env).chats, 3);
});

await checkAsync('[AR-22] registry byte-size contradiction with the verified CAS object → rollback, refusal (no repair)', async () => {
  const env = createEnv('AR-22');
  env.db.prepare("INSERT INTO assets (sha256, mime_type, ext, byte_size) VALUES (?, 'image/png', 'png', ?)").run(FIX.png.sha256, FIX.png.byteLength + 5);
  const pkg = stageArchive(env);
  const dbBefore = dbDigest(env);
  const { result } = await importArchive(realm, env, pkg);
  assert.equal(result.status, 'rejected', JSON.stringify(result));
  assert.equal(result.assets.result, 'recovery-transaction-rolled-back');
  assert.equal(result.assets.commit.code, 'registry-byte-size-contradiction');
  assert.equal(dbDigest(env), dbBefore);
});

await checkAsync('[AR-20] source package bytes unchanged across a successful recovery and across every refusal', async () => {
  const env = createEnv('AR-20');
  const pkg = stageArchive(env);
  const pkgAbs = j(env, pkg);
  const before = dirDigest(pkgAbs);
  const { result } = await importArchive(realm, env, pkg);
  assert.equal(result.status, 'imported');
  assert.equal(dirDigest(pkgAbs), before, 'package members are byte-identical after recovery');
  assert.ok(!env.ledger.some((e) => e.cmd === 'plugin:fs|write_file' || (e.path && /archive\/packages/.test(String(e.path)) && /write|remove|rename/.test(e.cmd))), 'no write under archive/packages');
});

await checkAsync('[AR-27] rendering envelope: bounded raster hydration for an admissible asset; refusal (not weakening) outside the envelope', async () => {
  const env = createEnv('AR-27');
  const pkg = stageArchive(env);
  const { result } = await importArchive(realm, env, pkg);
  assert.equal(result.status, 'imported');
  current = env;
  const snapId = result.recovered.newSnapshotId;
  const raw = await S.store.snapshots.get(snapId);
  /* the projection the Reader would receive (shape of projectSqliteSnapshotToCanonical) */
  const canonical = {
    snapshotId: snapId, chatId: result.recovered.newChatId, title: raw.snapshot.title, createdAt: '', schemaVersion: 1,
    messageCount: raw.turns.length, digest: '',
    messages: raw.turns.map((t) => ({ role: t.role, text: t.text, order: t.turnIdx, createdAt: 0, attachments: [] })),
    meta: Object.assign({}, raw.snapshot.meta, { richTurns: raw.turns.map((t) => Object.assign({ turnIdx: t.turnIdx, role: t.role, outerHTML: t.outerHtml }, t.meta)) }),
  };
  const hydrated = await S.archiveImporter.hydrateRecoveredSnapshotProjectionV1(canonical);
  assert.notEqual(hydrated, canonical);
  const policy = S.Renderer.sanitizerPolicy;
  const t1 = hydrated.meta.richTurns[1].outerHTML;
  const pngUri = 'data:image/png;base64,' + FIX.png.bytes.toString('base64');
  assert.ok(t1.includes(`src="${pngUri}"`), 'assistant turn 1 carries the standard-base64 raster data URI');
  assert.ok(!t1.includes(`assets/${FIX.png.sha256}`), 'the canonical reference was replaced exactly');
  assert.equal(policy.classifyUrl(pngUri, 'image').ok, true, 'the Renderer policy oracle admits the hydrated URI');
  assert.ok(policy.isWithinBudget(t1), 'hydrated turn is within the Renderer input budget');
  const t2 = hydrated.meta.richTurns[2].outerHTML;
  assert.ok(t2.includes('data:image/png;base64,') && t2.includes('data:image/gif;base64,' + FIX.gif.bytes.toString('base64')), 'both raster families hydrate');
  assert.equal(hydrated.meta.richTurns[0].outerHTML, canonical.meta.richTurns[0].outerHTML, 'user turn without links untouched');
  /* out-of-envelope: a non-raster registry MIME leaves the reference in place */
  env.db.prepare("UPDATE assets SET mime_type = 'image/svg+xml' WHERE sha256 = ?").run(FIX.gif.sha256);
  const h2 = await S.archiveImporter.hydrateRecoveredSnapshotProjectionV1(canonical);
  assert.ok(h2.meta.richTurns[2].outerHTML.includes(`src="assets/${FIX.gif.sha256}.gif"`), 'svg MIME is refused: canonical reference kept');
  assert.ok(h2.meta.richTurns[2].outerHTML.includes(pngUri), 'the admissible sibling asset in the same turn still hydrates');
  env.db.prepare("UPDATE assets SET mime_type = 'image/gif' WHERE sha256 = ?").run(FIX.gif.sha256);
  /* over budget: the sanitizer budget is enforced BEFORE returning */
  const budget = policy.maxInputBytes;
  const bigCanonical = JSON.parse(JSON.stringify(canonical));
  bigCanonical.meta.richTurns[1].outerHTML = bigCanonical.meta.richTurns[1].outerHTML + '<!--' + 'x'.repeat(budget - bigCanonical.meta.richTurns[1].outerHTML.length - 20) + '-->';
  const h3 = await S.archiveImporter.hydrateRecoveredSnapshotProjectionV1(bigCanonical);
  assert.equal(h3.meta.richTurns[1].outerHTML, bigCanonical.meta.richTurns[1].outerHTML, 'a turn that would exceed the budget stays unhydrated');
  assert.ok(h3.meta.richTurns[2].outerHTML.includes(pngUri), 'other turns still hydrate');
  assert.ok(h3.meta.richTurns.every((t) => policy.isWithinBudget(t.outerHTML)), 'no returned turn exceeds the Renderer budget');
});

await checkAsync('[AR-RD-01] hydration preserves messages[], ids, order, roles, digest and recovery provenance; never mutates its input', async () => {
  const env = createEnv('AR-RD-01');
  const pkg = stageArchive(env);
  const { result } = await importArchive(realm, env, pkg);
  current = env;
  const raw = await S.store.snapshots.get(result.recovered.newSnapshotId);
  const canonical = {
    snapshotId: result.recovered.newSnapshotId, chatId: result.recovered.newChatId, title: raw.snapshot.title, createdAt: '', schemaVersion: 1,
    messageCount: raw.turns.length, digest: 'digest-x',
    messages: raw.turns.map((t) => ({ role: t.role, text: t.text, order: t.turnIdx, createdAt: 0, attachments: [] })),
    meta: Object.assign({}, raw.snapshot.meta, { richTurns: raw.turns.map((t) => Object.assign({ turnIdx: t.turnIdx, role: t.role, outerHTML: t.outerHtml }, t.meta)) }),
  };
  const frozenInput = JSON.stringify(canonical);
  const hydrated = await S.archiveImporter.hydrateRecoveredSnapshotProjectionV1(canonical);
  assert.equal(JSON.stringify(canonical), frozenInput, 'input object not mutated');
  assert.deepEqual(plain(hydrated.messages), plain(canonical.messages));
  assert.equal(hydrated.snapshotId, canonical.snapshotId);
  assert.equal(hydrated.chatId, canonical.chatId);
  assert.equal(hydrated.digest, canonical.digest);
  assert.deepEqual(plain(hydrated.meta.recovered), plain(canonical.meta.recovered));
  assert.deepEqual(plain(hydrated.meta.richTurns.map((t) => [t.turnIdx, t.role])), plain(canonical.meta.richTurns.map((t) => [t.turnIdx, t.role])));
  assert.deepEqual(plain(hydrated.meta.richTurns.map((t) => t.assetRefs)), plain(canonical.meta.richTurns.map((t) => t.assetRefs)));
  assert.equal(hydrated.meta.richTurns.length, hydrated.messages.length, 'complete rich coverage retained');
  const again = await S.archiveImporter.hydrateRecoveredSnapshotProjectionV1(canonical);
  assert.equal(JSON.stringify(again.meta.richTurns), JSON.stringify(hydrated.meta.richTurns), 'deterministic across repeated hydration');
});

await checkAsync('[AR-RED-01] RED / mutant control: a guard-less importer is caught by this harness', async () => {
  const source = readRepo(IMPORTER_REL);
  /* Mutant A — the CAS ensure STOP is removed (DB transaction runs after a corrupt destination). */
  const mutantA = source.replace('    if (!ensure.ok) {\n', '    if (false && !ensure.ok) {\n');
  assert.notEqual(mutantA, source, 'mutant A must apply');
  const realmA = bootRealm({ importerSource: mutantA });
  const envA = createEnv('RED-A');
  fs.mkdirSync(path.dirname(j(envA, casPath(bare(FIX.png.sha256)))), { recursive: true });
  fs.writeFileSync(j(envA, casPath(bare(FIX.png.sha256))), Buffer.from('corrupt-bytes'));
  const pkgA = stageArchive(envA);
  const a = await importArchive(realmA, envA, pkgA);
  assert.notEqual(a.result.status, 'rejected', 'mutant A does not refuse');
  assert.ok(envA.ledger.some((e) => e.cmd === RECOVERY_COMMAND), 'mutant A reaches the DB transaction despite the corrupt destination — the AR-11 assertions would FAIL against it');
  /* Mutant B — the trusted-set equality check is removed (an undeclared asset passes the plan). */
  const marker = "    if (uniqueManifest.length !== trusted.length || uniqueManifest.some(function (h, i) { return h !== trusted[i]; })) {\n";
  assert.ok(source.includes(marker), 'mutant B anchor present');
  const mutantB = source.replace(marker, "    if (false) {\n");
  const realmB = bootRealm({ importerSource: mutantB });
  const envB = createEnv('RED-B');
  const pkgB = stageArchive(envB, { mutate: refusalCases[1][1] });
  const b = await importArchive(realmB, envB, pkgB);
  assert.notEqual(b.result.assets && b.result.assets.result, 'asset-set-mismatch', 'mutant B no longer detects the undeclared asset — the AR-06 assertion would FAIL against it');
});

// ── cleanup + report ───────────────────────────────────────────────────────
for (const env of environments) {
  try { env.db.close(); } catch (_) { /* ignore */ }
  fs.rmSync(env.root, { recursive: true, force: true });
}
if (FAIL.length) {
  console.log(`\n[asset-restoration-harness] ${FAIL.length} failed, ${PASS.length} passed`);
  process.exit(1);
}
console.log(`\n[asset-restoration-harness] PASS ${PASS.length} checks`);
process.exit(0);
