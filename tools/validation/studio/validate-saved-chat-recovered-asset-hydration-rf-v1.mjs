#!/usr/bin/env node
// Saved-Chat asset restoration (T02) — PERMANENT R-F guard.
//
// R-F (Reader residual, rendering-seam routing ruling §10.5 G): the hydrated
// output of the Desktop load-path adapter `loadSnapshotFromStoresDesktop` is a
// Reader-only runtime projection. It must never become persistent
// publication / Sync / export / backup state and must never alter the
// edit-overlay source identity. This validator FAILS when:
//   - the hydration hook moves out of loadSnapshotFromStoresDesktop (into
//     projectSqliteSnapshotToCanonical, renderReader, buildReaderDOM, …);
//   - a new Desktop-capable consumer of the loadSnapshot façades appears;
//   - hydration changes DB, package or CAS bytes, the Sync projection, the
//     package builder output, the DOCX / transcript output or the edit-overlay
//     base digest;
//   - the G-a / G-b / G-c gate weakens, hydration stops being deterministic, or
//     a CAS failure / out-of-envelope asset collapses the load.
//
// The real modules (importer, CAS, stores, codec, verifier client, inspector,
// sanitizer policy, overlay applier, DOCX writer, Sync projection, package
// builder) plus the REAL studio.js seam functions (sliced from source) run in
// a vm realm over a throwaway node:sqlite DB and AppLocalData directory.

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
const STUDIO_JS_REL = 'src-surfaces-base/studio/studio.js';
const IMPORTER_REL = 'src-surfaces-base/studio/ingestion/saved-chat-archive-importer.studio.js';
const PLATFORM_TAURI_REL = 'src-surfaces-base/studio/platform/platform.tauri.js';
const FIXTURE_PKG_REL = 'tools/validation/fixtures/saved-chat-archive/asset-restoration/ar-v3-assistant-raster.h2ochat';
const HOOK = 'hydrateRecoveredSnapshotProjectionV1';
const RECOVERY_COMMAND = 'h2o_saved_chat_asset_recovery_commit';

const MODULES = [
  'store/index.js', 'store/snapshots.tauri.js', 'store/chats.tauri.js', 'store/assets.tauri.js',
  'renderer/safety/sanitizer-policy.v1.js',
  'overlay/overlay-applier.studio.js',
  'overlay/overlay-docx-writer.studio.js',
  'platform/html-sanitizer.js',
  'ingestion/saved-chat-package-codec.tauri.js',
  'ingestion/asset-cas.tauri.js',
  'ingestion/saved-chat-archive-integrity.tauri.js',
  'ingestion/saved-chat-archive-diagnostics.tauri.js',
  'ingestion/saved-chat-archive-health-mapping.js',
  'ingestion/saved-chat-archive-inspector.studio.js',
  'ingestion/saved-chat-archive-importer.studio.js',
  'ingestion/saved-chat-package-v1.tauri.js',
  'sync/sync-object-projection.tauri.js',
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
const stripComments = (src) => String(src).replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');
const sha256Hex = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const sha256Pfx = (buf) => 'sha256-' + sha256Hex(buf);
const bare = (v) => String(v || '').toLowerCase().replace(/^sha256-/, '');
const plain = (v) => JSON.parse(JSON.stringify(v === undefined ? null : v));
const countOccurrences = (hay, needle) => hay.split(needle).length - 1;

function walkFiles(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') out.push(...walkFiles(abs)); }
    else if (/\.(js|mjs)$/.test(e.name)) out.push(abs);
  }
  return out;
}

/* Slice a top-level `function name(` / `async function name(` from studio.js. */
function sliceFunction(source, name) {
  const markers = [`\nasync function ${name}(`, `\nfunction ${name}(`];
  let start = -1; let marker = '';
  for (const m of markers) { const i = source.indexOf(m); if (i >= 0 && (start < 0 || i < start)) { start = i; marker = m; } }
  if (start < 0) throw new Error(`studio.js: function ${name} not found`);
  let i = start + marker.length;
  const stack = [];
  let paren = 1; let depth = 0; let inBody = false;
  for (; i < source.length; i += 1) {
    const ch = source[i]; const next = source[i + 1]; const top = stack[stack.length - 1];
    if (top === 'sq') { if (ch === '\\') i += 1; else if (ch === "'") stack.pop(); continue; }
    if (top === 'dq') { if (ch === '\\') i += 1; else if (ch === '"') stack.pop(); continue; }
    if (top === 'tpl') { if (ch === '\\') i += 1; else if (ch === '`') stack.pop(); else if (ch === '$' && next === '{') { stack.push('expr'); stack.push(0); i += 1; } continue; }
    if (ch === "'") { stack.push('sq'); continue; }
    if (ch === '"') { stack.push('dq'); continue; }
    if (ch === '`') { stack.push('tpl'); continue; }
    if (ch === '/' && next === '/') { i = source.indexOf('\n', i); if (i < 0) break; continue; }
    if (ch === '/' && next === '*') { i = source.indexOf('*/', i) + 1; continue; }
    if (typeof top === 'number') { if (ch === '{') stack[stack.length - 1] = top + 1; else if (ch === '}') { if (top === 0) { stack.pop(); stack.pop(); } else stack[stack.length - 1] = top - 1; } continue; }
    if (!inBody) { if (ch === '(') paren += 1; else if (ch === ')') paren -= 1; else if (ch === '{' && paren === 0) { inBody = true; depth = 1; } continue; }
    if (ch === '{') depth += 1;
    else if (ch === '}') { depth -= 1; if (depth === 0) return source.slice(start + 1, i + 1); }
  }
  throw new Error(`studio.js: function ${name} unterminated`);
}
function sliceBlock(source, startMarker, endMarker) {
  const s = source.indexOf(startMarker);
  if (s < 0) throw new Error('block start not found: ' + startMarker);
  const e = source.indexOf(endMarker, s);
  if (e < 0) throw new Error('block end not found: ' + endMarker);
  return source.slice(s, e + endMarker.length);
}

// ── fixture ────────────────────────────────────────────────────────────────
const FIX = (() => {
  const dir = path.join(REPO_ROOT, FIXTURE_PKG_REL);
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  const snapshotBytes = fs.readFileSync(path.join(dir, 'snapshot.json'));
  const assets = manifest.assets.map((a) => ({ ...a, bytes: fs.readFileSync(path.join(dir, a.path)) }));
  const byExt = Object.fromEntries(assets.map((a) => [a.ext, a]));
  return { dir, manifest, snapshotBytes, assets, png: byExt.png, gif: byExt.gif, chatId: manifest.chatId, snapshotId: manifest.snapshotId };
})();
const PNG_URI = 'data:image/png;base64,' + FIX.png.bytes.toString('base64');
const GIF_URI = 'data:image/gif;base64,' + FIX.gif.bytes.toString('base64');

// ═══════════════════════════════════════════════════════════════════════════
// RF-12 — static consumer / seam-preservation guard (fails closed on drift)
// ═══════════════════════════════════════════════════════════════════════════
console.log('[recovered-asset-hydration-rf] static');
const studioSrc = readRepo(STUDIO_JS_REL);
const studioCode = stripComments(studioSrc);

check('[RF-12] the hydration hook lives ONLY inside loadSnapshotFromStoresDesktop', () => {
  const total = countOccurrences(studioCode, HOOK);
  const inLoader = countOccurrences(stripComments(sliceFunction(studioSrc, 'loadSnapshotFromStoresDesktop')), HOOK);
  assert.equal(total, 1, `studio.js must reference ${HOOK} exactly once (found ${total})`);
  assert.equal(inLoader, 1, 'the single reference must be inside loadSnapshotFromStoresDesktop');
  for (const fn of ['projectSqliteSnapshotToCanonical', 'renderReader', 'buildReaderDOM', 'canReuseReaderDOM', 'callArchive']) {
    const code = stripComments(sliceFunction(studioSrc, fn));
    assert.ok(!code.includes(HOOK) && !/hydrateRecovered|readVerifiedAssetBytes|listBySnapshot\(/.test(code), `${fn} must not hydrate recovered assets (seam preservation)`);
  }
  const loader = stripComments(sliceFunction(studioSrc, 'loadSnapshotFromStoresDesktop'));
  assert.ok(/const canonical = projectSqliteSnapshotToCanonical\(raw\);/.test(loader), 'projection still comes from projectSqliteSnapshotToCanonical');
  assert.ok(/typeof hydrate !== 'function'\) return canonical;/.test(loader), 'absent helper → canonical unchanged');
  assert.ok(/try \{ return \(await hydrate\(canonical\)\) \|\| canonical; \} catch \{ return canonical; \}/.test(loader), 'failure → canonical unchanged; valid result returned');
  assert.ok(/projectSqliteSnapshotToCanonical\(raw\)/.test(loader) && !/snapStore\.(create|upsert|patch)/.test(loader), 'the loader stays read-only');
});

check('[RF-12] loadSnapshot op call sites in studio.js are exactly renderReader + the two Shell façades', () => {
  const total = countOccurrences(studioCode, 'callArchive("loadSnapshot"') + countOccurrences(studioCode, "callArchive('loadSnapshot'");
  const renderReader = stripComments(sliceFunction(studioSrc, 'renderReader'));
  const facadeA = stripComments(sliceBlock(studioSrc, 'W.H2O.Studio.archiveAuthority = Object.freeze({', '\n});'));
  const facadeB = stripComments(sliceBlock(studioSrc, 'W.H2O.Studio.syncApplyArchiveAuthority = Object.freeze({', '\n});'));
  const inRender = countOccurrences(renderReader, 'callArchive("loadSnapshot"');
  const inA = countOccurrences(facadeA, 'callArchive("loadSnapshot"');
  const inB = countOccurrences(facadeB, 'callArchive("loadSnapshot"');
  assert.equal(inRender, 1, 'renderReader consumes the op once');
  assert.equal(inA, 1, 'archiveAuthority façade exposes loadSnapshot once');
  assert.equal(inB, 1, 'syncApplyArchiveAuthority façade exposes loadSnapshot once');
  assert.equal(total, 3, `a NEW loadSnapshot consumer appeared in studio.js (${total} call sites; expected 3) — classify it before it can reach the hydrated projection`);
  assert.equal(countOccurrences(studioCode, "tryArchiveOp('loadSnapshot'") + countOccurrences(studioCode, 'tryArchiveOp("loadSnapshot"'), 0, 'no tryArchiveOp loadSnapshot consumer');
  /* the Tauri route is the only path to the loader */
  const callArchive = stripComments(sliceFunction(studioSrc, 'callArchive'));
  assert.ok(/if \(op === 'loadSnapshot'\) return loadSnapshotFromStoresDesktop\(payload && payload\.snapshotId\);/.test(callArchive), 'callArchive routes the op to the loader unchanged');
  assert.equal(countOccurrences(studioCode, 'loadSnapshotFromStoresDesktop('), 2, 'loader is defined once and called once (from callArchive)');
});

check('[RF-12] every non-Reader consumer of the loadSnapshot façades is Chrome-gated; Tauri platform messaging cannot reach the seam', () => {
  const offenders = [];
  for (const abs of walkFiles(STUDIO_ROOT)) {
    const rel = path.relative(REPO_ROOT, abs).split(path.sep).join('/');
    if (rel === STUDIO_JS_REL) continue;
    const code = stripComments(fs.readFileSync(abs, 'utf8'));
    const usesFacade = /\barchiveAuthority\b/.test(code) || /\bsyncApplyArchiveAuthority\b/.test(code);
    const mentionsLoad = /\bloadSnapshot\b/.test(code);
    if (!usesFacade || !mentionsLoad) continue;
    const chromeGated = code.includes('if (!isChromeStudio()) return;') || /if \(isTauri\(\)\) return;/.test(code);
    if (!chromeGated) offenders.push(rel);
  }
  assert.deepEqual(offenders, [], 'Desktop-capable façade loadSnapshot consumer(s) appeared: ' + offenders.join(', '));
  /* Chrome adapter modules that consume archiveAuthority.loadSnapshot may only be wired from Chrome-gated Studio entries */
  const adapterOffenders = [];
  for (const abs of walkFiles(STUDIO_ROOT)) {
    const rel = path.relative(REPO_ROOT, abs).split(path.sep).join('/');
    const code = stripComments(fs.readFileSync(abs, 'utf8'));
    if (!/local-publication-projection\.mjs|sync-revision-apply-v2\.mjs|sync-background-reconcile\.mjs/.test(code)) continue;
    const chromeGated = code.includes('if (!isChromeStudio()) return;');
    if (!chromeGated) adapterOffenders.push(rel);
  }
  assert.deepEqual(adapterOffenders, [], 'Chrome adapter consumers of the façade wired from a non-Chrome-gated module: ' + adapterOffenders.join(', '));
  /* MV3-style callArchive users (S0F1h Library Sync, auto-import.mv3) go through platform messaging, which rejects on Tauri */
  const platform = stripComments(readRepo(PLATFORM_TAURI_REL));
  assert.ok(platform.includes("'platform.messaging.send: not available on Tauri"), 'Tauri platform.messaging.send must keep rejecting (no MV3 archive bridge on Desktop)');
});

check('[RF-12] Desktop publication / Sync / export / backup writers are store-backed (source pins)', () => {
  const pins = [
    ['src-surfaces-base/studio/ingestion/export-bundle.tauri.js', /stores\.snapshots\.get\(/],
    ['src-surfaces-base/studio/sync/sync-object-projection.tauri.js', /stores\.snapshots\.get\(/],
    ['src-surfaces-base/studio/sync/sync-object-runtime.tauri.js', /currentStores\.snapshots\.get\(/],
    ['src-surfaces-base/studio/ingestion/saved-chat-package-v1.tauri.js', /snapshots/],
    ['src-surfaces-base/studio/ingestion/saved-chat-local-backup.studio.js', /buildSavedChatPackageForLiveGenerationFamily|savedChatPackage/],
  ];
  for (const [rel, mustMatch] of pins) {
    const code = stripComments(readRepo(rel));
    assert.ok(mustMatch.test(code), `${rel}: expected store-backed read`);
    assert.ok(!code.includes(HOOK), `${rel}: must not call the hydration helper`);
    assert.ok(!/callArchive\((["'])loadSnapshot\1/.test(code) || rel.endsWith('.mv3.js'), `${rel}: must not consume the Desktop loadSnapshot op`);
    assert.ok(!/archiveAuthority\.loadSnapshot|syncApplyArchiveAuthority\.loadSnapshot/.test(code), `${rel}: must not consume the loadSnapshot façades`);
  }
  /* the edit-overlay base digest covers messages[] (never richTurns / outerHTML) */
  const applier = stripComments(readRepo('src-surfaces-base/studio/overlay/overlay-applier.studio.js'));
  const digestFn = applier.slice(applier.indexOf('function computeBaseDigest('), applier.indexOf('function createEmpty('));
  assert.ok(digestFn.length > 0 && !/richTurns|outerHTML/.test(digestFn), 'computeBaseDigest must not depend on richTurns/outerHTML');
  /* transcript + DOCX read messages[].text */
  const transcript = stripComments(sliceFunction(studioSrc, '__ribbonBridge_getCleanTranscript'));
  assert.ok(!/richTurns|outerHTML/.test(transcript), 'clean transcript must not read richTurns/outerHTML');
  const docx = stripComments(readRepo('src-surfaces-base/studio/overlay/overlay-docx-writer.studio.js'));
  assert.ok(!/richTurns|outerHTML/.test(docx), 'DOCX writer must not read richTurns/outerHTML');
});

check('[RF-12] importer hydration helper: gate, envelope and non-persistence rules are present in source', () => {
  const code = stripComments(readRepo(IMPORTER_REL));
  const start = code.indexOf(`async function ${HOOK}(`);
  assert.ok(start > 0, 'helper defined');
  const end = code.indexOf('\n  function importCandidate(', start);
  assert.ok(end > start, 'helper is followed by importCandidate');
  const body = code.slice(start, end);
  assert.ok(/recoveredFromPackage !== true\) return canonical;/.test(body), 'G-a gate');
  assert.ok(/listBySnapshot\(snapshotId\)/.test(body), 'G-b gate reads persisted links');
  assert.ok(/refs\.indexOf\(link\.sha256\) >= 0/.test(body), 'G-c gate closes over the turn assetRefs');
  assert.ok(/readVerifiedAssetBytes\(link\.sha256\)/.test(body), 'bytes only from the verified CAS read');
  assert.ok(/classifyUrl\(candidate, 'image'\)/.test(body) && /isWithinBudget\(next\)/.test(body), 'Renderer policy oracle + budget');
  assert.ok(/src="assets\/' \+ link\.sha256 \+ '\.' \+ link\.ext \+ '"'/.test(body), 'exact src="assets/sha256-<hex>.<ext>" reference only');
  for (const banned of ['fetch(', 'file:', 'blob:', 'tauri:', 'asset:', 'plugin:sql|', 'plugin:fs|write', 'upsert(', 'linkToTurn(', 'putAssetBytes(']) {
    assert.ok(!body.includes(banned), 'hydration helper must not contain: ' + banned);
  }
  assert.ok(/HYDRATION_RASTER_MIME = \{ 'image\/png': true, 'image\/jpeg': true, 'image\/jpg': true, 'image\/gif': true, 'image\/webp': true \};/.test(code), 'raster families only');
  assert.ok(/HYDRATION_RASTER_MIME\[link\.mimeType\]/.test(body), 'the helper consults the raster family map');
});

// ═══════════════════════════════════════════════════════════════════════════
// Behavioral guards RF-01 … RF-11 over the REAL modules + REAL seam functions
// ═══════════════════════════════════════════════════════════════════════════
console.log('[recovered-asset-hydration-rf] live');

const SCHEMA_SQL = `
CREATE TABLE chats (id TEXT PRIMARY KEY, source_id TEXT UNIQUE, title TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0, last_message_at INTEGER NOT NULL DEFAULT 0, message_count INTEGER NOT NULL DEFAULT 0, user_turn_count INTEGER NOT NULL DEFAULT 0, assistant_turn_count INTEGER NOT NULL DEFAULT 0, is_pinned INTEGER NOT NULL DEFAULT 0, is_archived INTEGER NOT NULL DEFAULT 0, is_starred INTEGER NOT NULL DEFAULT 0, is_deleted INTEGER NOT NULL DEFAULT 0, folder_id TEXT, category_id TEXT, project_id TEXT NOT NULL DEFAULT '', current_leaf_id TEXT, import_batch_id TEXT, meta_json TEXT NOT NULL DEFAULT '{}', is_saved INTEGER NOT NULL DEFAULT 0, is_linked INTEGER NOT NULL DEFAULT 0, linked_at INTEGER NOT NULL DEFAULT 0, linked_from TEXT NOT NULL DEFAULT '', link_source_href TEXT NOT NULL DEFAULT '', href TEXT, normalized_href TEXT, snapshot_count INTEGER NOT NULL DEFAULT 0, last_snapshot_id TEXT, last_captured_at INTEGER NOT NULL DEFAULT 0);
CREATE TABLE snapshots (id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, title TEXT NOT NULL DEFAULT '', digest TEXT, message_count INTEGER NOT NULL DEFAULT 0, pinned INTEGER NOT NULL DEFAULT 0, legacy INTEGER NOT NULL DEFAULT 0, captured_at INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0, meta_json TEXT NOT NULL DEFAULT '{}');
CREATE TABLE snapshot_turns (snapshot_id TEXT NOT NULL, turn_idx INTEGER NOT NULL, role TEXT NOT NULL, outer_html TEXT NOT NULL DEFAULT '', text TEXT NOT NULL DEFAULT '', meta_json TEXT NOT NULL DEFAULT '{}', PRIMARY KEY (snapshot_id, turn_idx));
CREATE TABLE assets (sha256 TEXT PRIMARY KEY, mime_type TEXT NOT NULL DEFAULT '', ext TEXT NOT NULL DEFAULT '', byte_size INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL DEFAULT '', refcount INTEGER NOT NULL DEFAULT 0, meta_json TEXT NOT NULL DEFAULT '{}');
CREATE TABLE snapshot_turn_assets (snapshot_id TEXT NOT NULL, turn_idx INTEGER NOT NULL, sha256 TEXT NOT NULL, relation TEXT NOT NULL DEFAULT 'inline', created_at TEXT NOT NULL DEFAULT '', meta_json TEXT NOT NULL DEFAULT '{}', PRIMARY KEY (snapshot_id, turn_idx, sha256));
CREATE TABLE folder_bindings (chat_id TEXT PRIMARY KEY, folder_id TEXT NOT NULL, assigned_at INTEGER NOT NULL DEFAULT 0);
CREATE TABLE label_bindings (chat_id TEXT NOT NULL, label_id TEXT NOT NULL, PRIMARY KEY (chat_id, label_id));
CREATE TABLE tag_bindings (chat_id TEXT NOT NULL, tag_id TEXT NOT NULL, PRIMARY KEY (chat_id, tag_id));
`;

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'h2o-ar-rf-'));
const appDir = path.join(root, 'AppLocalData');
fs.mkdirSync(path.join(appDir, 'archive/packages'), { recursive: true });
fs.mkdirSync(path.join(appDir, 'archive/assets'), { recursive: true });
const db = new DatabaseSync(path.join(root, 'studio-v1.db'));
db.exec(SCHEMA_SQL);
const j = (p) => path.join(appDir, String(p || ''));
const casPath = (hex) => `archive/assets/${hex.slice(0, 2)}/sha256-${hex}`;
const ledger = [];
const sqlWrites = [];
const trusted = new Map();
const hooks = { readFileFail: null };

function invoke(cmd, a, b) {
  ledger.push({ cmd, path: a && typeof a === 'object' && !ArrayBuffer.isView(a) ? a.path : undefined });
  try {
    if (cmd === 'h2o_saved_chat_archive_integrity') return Promise.resolve({ schema: 'h2o.savedChatArchiveIntegrity', schemaVersion: 1, complete: true, blockers: [], occupants: [...trusted.values()] });
    if (cmd === 'plugin:fs|exists') return Promise.resolve(fs.existsSync(j(a.path)));
    if (cmd === 'plugin:fs|lstat') { const st = fs.lstatSync(j(a.path)); return Promise.resolve({ isFile: st.isFile(), isDirectory: st.isDirectory(), isSymlink: st.isSymbolicLink(), size: st.size }); }
    if (cmd === 'plugin:fs|read_file') {
      if (hooks.readFileFail && String(a.path) === hooks.readFileFail) return Promise.reject(new Error('EIO injected'));
      return Promise.resolve(Array.from(fs.readFileSync(j(a.path))));
    }
    if (cmd === 'plugin:fs|read_dir') { const p = j(a.path); return Promise.resolve(fs.existsSync(p) ? fs.readdirSync(p, { withFileTypes: true }).map((e) => ({ name: e.name, isDirectory: e.isDirectory(), isFile: e.isFile() })) : []); }
    if (cmd === 'plugin:sql|select') return Promise.resolve(db.prepare(a.query).all(...(a.values || [])));
    if (cmd === 'plugin:sql|execute') {
      const verb = String(a.query).trim().split(/\s+/)[0].toUpperCase();
      const r = db.prepare(a.query).run(...(a.values || []));
      sqlWrites.push(verb);
      return Promise.resolve([Number(r.changes), Number(r.lastInsertRowid)]);
    }
    if (cmd === 'h2o_archive_durable_write') {
      const opts = JSON.parse(decodeURIComponent(b.headers.options));
      const p = 'archive/' + opts.path;
      const bytes = Array.from(new Uint8Array(a.buffer, a.byteOffset || 0, a.byteLength));
      if (fs.existsSync(j(p))) return Promise.resolve({ ok: false, committed: false, blockers: [{ code: 'durable-write-destination-exists' }] });
      fs.mkdirSync(path.dirname(j(p)), { recursive: true });
      fs.writeFileSync(j(p), Buffer.from(bytes));
      ledger.push({ cmd: 'cas-write', path: p });
      return Promise.resolve({ ok: true, committed: true, durabilityComplete: true, replaced: false, byteLength: bytes.length, blockers: [] });
    }
    if (cmd === 'h2o_archive_cas_repair_write') { ledger.push({ cmd: 'cas-repair' }); return Promise.reject(new Error('repair must never be reached in this validator')); }
    if (cmd === RECOVERY_COMMAND) return Promise.resolve(mockRecoveryCommit(a && a.payload));
  } catch (e) { return Promise.reject(e); }
  return Promise.reject(new Error('unmocked invoke: ' + cmd));
}

/* Minimal mirror of the native transaction (atomicity is proven natively). */
function mockRecoveryCommit(payload) {
  const nowMs = Date.now(); const nowIso = new Date(nowMs).toISOString();
  db.exec('BEGIN IMMEDIATE');
  try {
    const snapshotId = 'snap_' + crypto.randomUUID();
    let assetsInserted = 0;
    for (const asset of payload.assets) {
      if (!db.prepare('SELECT 1 FROM assets WHERE sha256 = ?').get(asset.sha256)) {
        db.prepare('INSERT INTO assets (sha256, mime_type, ext, byte_size, created_at, updated_at, refcount, meta_json) VALUES (?, ?, ?, ?, ?, ?, 0, ?)').run(asset.sha256, asset.mimeType, asset.ext, asset.byteSize, nowIso, nowIso, asset.metaJson);
        assetsInserted += 1;
      }
    }
    db.prepare('INSERT INTO chats (id, title, is_saved, is_linked, message_count, user_turn_count, assistant_turn_count, last_message_at, created_at, updated_at, meta_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(payload.recoveredChatId, payload.chat.title, payload.chat.isSaved ? 1 : 0, payload.chat.isLinked ? 1 : 0, payload.chat.messageCount, payload.chat.userTurnCount, payload.chat.assistantTurnCount, payload.chat.lastMessageAt || 0, nowMs, nowMs, payload.chat.metaJson);
    db.prepare('INSERT INTO snapshots (id, chat_id, title, message_count, captured_at, updated_at, meta_json) VALUES (?, ?, ?, ?, ?, ?, ?)').run(snapshotId, payload.recoveredChatId, payload.snapshot.title, payload.snapshot.messageCount, nowMs, nowMs, payload.snapshot.metaJson);
    for (const t of payload.turns) db.prepare('INSERT INTO snapshot_turns (snapshot_id, turn_idx, role, outer_html, text, meta_json) VALUES (?, ?, ?, ?, ?, ?)').run(snapshotId, t.turnIdx, t.role, t.outerHtml, t.text, t.metaJson);
    const linked = new Set();
    for (const l of payload.links) { db.prepare('INSERT INTO snapshot_turn_assets (snapshot_id, turn_idx, sha256, relation, created_at, meta_json) VALUES (?, ?, ?, ?, ?, ?)').run(snapshotId, l.turnIdx, l.sha256, l.relation, nowIso, l.metaJson); linked.add(l.sha256); }
    for (const sha of linked) db.prepare('UPDATE assets SET refcount = (SELECT COUNT(*) FROM snapshot_turn_assets WHERE sha256 = ?), updated_at = ? WHERE sha256 = ?').run(sha, nowIso, sha);
    db.exec('COMMIT');
    return { schema: payload.schema, ok: true, committed: true, recoveredChatId: payload.recoveredChatId, recoveredSnapshotId: snapshotId, counts: { turns: payload.turns.length, assetsInserted, assetsExisting: payload.assets.length - assetsInserted, links: payload.links.length, refcountsRecomputed: linked.size } };
  } catch (e) { db.exec('ROLLBACK'); return { ok: false, committed: false, stage: 'sql', code: 'sql-error' }; }
}

/* realm with the real modules + the REAL studio.js seam functions */
const sb = {
  console, crypto: crypto.webcrypto, TextEncoder, TextDecoder, setTimeout, clearTimeout, Date, Math, JSON, Promise, btoa: globalThis.btoa, atob: globalThis.atob,
  Blob: globalThis.Blob, structuredClone, performance, document: undefined,
  H2O: { Studio: { platform: { env: { isTauri: true }, __sqliteStatus: () => ({ backend: 'sqlite', ready: true }) } } },
};
sb.__TAURI_INTERNALS__ = { invoke };
sb.globalThis = sb; sb.window = sb;
vm.createContext(sb);
for (const rel of MODULES) vm.runInContext(fs.readFileSync(path.join(STUDIO_ROOT, rel), 'utf8'), sb, { filename: rel });
const S = sb.H2O.Studio;
assert.ok(S.archiveImporter && S.ingestion.assetCas && S.store.assets && S.overlay && S.overlayDocxWriter && sb.H2O.Desktop && sb.H2O.Desktop.SyncObjectProjection && S.ingestion.buildSavedChatPackageV1, 'real modules registered');
/* the REAL seam: sliced verbatim from studio.js */
vm.runInContext(
  'const W = globalThis;\n' + sliceFunction(studioSrc, 'projectSqliteSnapshotToCanonical') + '\n' + sliceFunction(studioSrc, 'loadSnapshotFromStoresDesktop')
  + '\nglobalThis.__seam = { projectSqliteSnapshotToCanonical, loadSnapshotFromStoresDesktop };',
  sb, { filename: 'studio-seam.js' }
);
const seam = sb.__seam;

/* stage + recover the fixture through the REAL importer */
const dirName = 'ar-v3-assistant-raster.h2ochat';
const dst = j('archive/packages/' + dirName);
fs.mkdirSync(path.join(dst, 'assets'), { recursive: true });
for (const leaf of ['manifest.json', 'snapshot.json']) fs.copyFileSync(path.join(FIX.dir, leaf), path.join(dst, leaf));
for (const a of FIX.assets) fs.copyFileSync(path.join(FIX.dir, a.path), path.join(dst, a.path));
const physicalSha = sha256Pfx(FIX.snapshotBytes);
trusted.set(dirName, {
  path: 'archive/packages/' + dirName, name: dirName, class: 'legacy-package', chatId: FIX.chatId, snapshotId: FIX.snapshotId,
  contentHash: bare(FIX.manifest.contentHash), constructionFamily: 'v3', snapshotEncoding: 'identity',
  snapshotPhysicalSha256: physicalSha, snapshotPhysicalByteLength: FIX.snapshotBytes.length,
  logicalSnapshotSha256: physicalSha, logicalSnapshotByteLength: FIX.snapshotBytes.length,
  assetShas: FIX.assets.map((a) => bare(a.sha256)).sort(), savedAt: '2026-09-18T00:00:00.000Z', orderable: false, blockers: [],
});
const imported = await S.archiveImporter.importVerifiedPackage({ packagePath: 'archive/packages/' + dirName, mode: 'import-as-new' });
assert.equal(imported.status, 'imported', 'fixture must recover: ' + JSON.stringify(imported));
const SNAP = imported.recovered.newSnapshotId;
const CHAT = imported.recovered.newChatId;
const dbDigest = () => ['chats', 'snapshots', 'snapshot_turns', 'assets', 'snapshot_turn_assets'].map((t) => sha256Hex(JSON.stringify(db.prepare(`SELECT * FROM ${t}`).all()))).join('|');
const dirDigest = (dir) => {
  const out = [];
  const walk = (d, rel) => { for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((x, y) => x.name.localeCompare(y.name))) { const abs = path.join(d, e.name); const r = rel ? rel + '/' + e.name : e.name; if (e.isDirectory()) walk(abs, r); else out.push(r + '=' + sha256Hex(fs.readFileSync(abs))); } };
  walk(dir, ''); return out.join('\n');
};
const rawProjection = async (id) => seam.projectSqliteSnapshotToCanonical(await S.store.snapshots.get(id));

let hydrated = null;

await checkAsync('[RF-01] the REAL loadSnapshotFromStoresDesktop returns hydrated content for the recovered snapshot (G-a ∧ G-b ∧ G-c)', async () => {
  const raw = await rawProjection(SNAP);
  hydrated = await seam.loadSnapshotFromStoresDesktop(SNAP);
  assert.ok(hydrated && hydrated.snapshotId === SNAP);
  assert.equal(hydrated.meta.recovered.recoveredFromPackage, true);
  assert.equal(raw.meta.richTurns.length, 3);
  assert.ok(raw.meta.richTurns[1].outerHTML.includes(`src="assets/${FIX.png.sha256}.png"`), 'raw projection carries the canonical reference');
  assert.ok(hydrated.meta.richTurns[1].outerHTML.includes(`src="${PNG_URI}"`), 'hydrated projection carries the raster data URI');
  assert.ok(hydrated.meta.richTurns[2].outerHTML.includes(`src="${PNG_URI}"`) && hydrated.meta.richTurns[2].outerHTML.includes(`src="${GIF_URI}"`));
  assert.equal(hydrated.meta.richTurns[0].outerHTML, raw.meta.richTurns[0].outerHTML, 'turn without links untouched');
  assert.deepEqual(plain(hydrated.messages), plain(raw.messages), 'messages[] untouched');
  assert.equal(hydrated.meta.richTurns.length, hydrated.messages.length, 'complete rich coverage preserved');
});

await checkAsync('[RF-02] DB state is byte-identical before vs after hydration; hydration issues no write', async () => {
  const before = dbDigest();
  const writesBefore = sqlWrites.length;
  const ledgerStart = ledger.length;
  await seam.loadSnapshotFromStoresDesktop(SNAP);
  assert.equal(dbDigest(), before);
  assert.equal(sqlWrites.length, writesBefore, 'no plugin:sql|execute');
  const during = ledger.slice(ledgerStart);
  assert.ok(during.every((e) => ['plugin:sql|select', 'plugin:fs|exists', 'plugin:fs|read_file'].includes(e.cmd)), 'hydration performs only selects and CAS reads: ' + JSON.stringify(during.map((e) => e.cmd)));
  assert.ok(during.filter((e) => e.cmd === 'plugin:fs|read_file').every((e) => /^archive\/assets\//.test(String(e.path))), 'only CAS objects are read');
  const rawRow = db.prepare('SELECT outer_html FROM snapshot_turns WHERE snapshot_id = ? AND turn_idx = 1').get(SNAP);
  assert.ok(rawRow.outer_html.includes(`assets/${FIX.png.sha256}.png`) && !rawRow.outer_html.includes('data:image'), 'stored row keeps the canonical reference');
});

await checkAsync('[RF-03] package members and CAS objects are byte-identical before vs after hydration', async () => {
  const pkgBefore = dirDigest(dst);
  const casBefore = dirDigest(j('archive/assets'));
  await seam.loadSnapshotFromStoresDesktop(SNAP);
  assert.equal(dirDigest(dst), pkgBefore);
  assert.equal(dirDigest(j('archive/assets')), casBefore);
  assert.ok(!ledger.some((e) => e.cmd === 'cas-repair' || e.cmd === 'plugin:fs|write_file'));
});

await checkAsync('[RF-04] the Desktop Sync projection of the recovered chat stays canonical (store-backed, unhydrated)', async () => {
  await seam.loadSnapshotFromStoresDesktop(SNAP);
  const projection = await sb.H2O.Desktop.SyncObjectProjection.projectObject(CHAT);
  const text = JSON.stringify(plain(projection));
  assert.ok(text.includes(`assets/${FIX.png.sha256}.png`), 'Sync payload carries the canonical reference');
  assert.ok(!text.includes('data:image'), 'Sync payload contains no hydrated data URI');
  const payload = JSON.parse(projection.payloadText || JSON.stringify(projection.payload || {}));
  const snap = payload.chatArchive.chats[0].snapshots[0];
  const stored = db.prepare('SELECT outer_html FROM snapshot_turns WHERE snapshot_id = ? ORDER BY turn_idx').all(SNAP).map((r) => r.outer_html);
  assert.deepEqual(plain(snap.meta.richTurns.map((t) => t.outerHTML)), stored, 'projected richTurns equal the stored rows exactly');
});

await checkAsync('[RF-05] DOCX and clean-transcript output are identical for the hydrated and the raw projection (messages[].text only)', async () => {
  const raw = await rawProjection(SNAP);
  const hyd = await seam.loadSnapshotFromStoresDesktop(SNAP);
  const headerMeta = { title: 'RF', capturedDate: '2026-09-18', chatId: CHAT };
  const docxRaw = S.overlayDocxWriter.build({ snap: raw, overlay: null, headerMeta, opts: { includeOverlay: false } });
  const docxHyd = S.overlayDocxWriter.build({ snap: hyd, overlay: null, headerMeta, opts: { includeOverlay: false } });
  assert.ok(docxRaw.bytes && docxHyd.bytes, 'DOCX built');
  assert.equal(Buffer.compare(Buffer.from(docxRaw.bytes), Buffer.from(docxHyd.bytes)), 0, 'DOCX bytes identical');
  assert.ok(!Buffer.from(docxHyd.bytes).includes(Buffer.from(FIX.png.bytes.toString('base64'))), 'DOCX carries no hydrated payload');
  /* the REAL transcript function, raw mode, over the hydrated Reader snapshot */
  const tsb = { console, Promise, String, Array, Object, JSON, W: { H2O: { Studio: {} } }, state: { currentReaderSnapshot: hyd } };
  tsb.globalThis = tsb;
  vm.createContext(tsb);
  vm.runInContext(sliceFunction(studioSrc, '__ribbonBridge_getCleanTranscript') + '\nglobalThis.__t = __ribbonBridge_getCleanTranscript;', tsb);
  const hydText = (await tsb.__t({ includeOverlay: false })).text;
  tsb.state.currentReaderSnapshot = raw;
  const rawText = (await tsb.__t({ includeOverlay: false })).text;
  assert.equal(hydText, rawText, 'transcript identical');
  assert.ok(hydText.includes('Here is the diagram.') && !hydText.includes('data:image'));
});

await checkAsync('[RF-06] the package builder (backup / export source) stays store-backed and canonical after hydration', async () => {
  await seam.loadSnapshotFromStoresDesktop(SNAP);
  const built = await S.ingestion.buildSavedChatPackageV1({ chatId: CHAT, snapshotId: SNAP, skipAssetMaterialization: true });
  assert.ok(built && built.files && built.files['snapshot.json'], 'package built');
  const snapshotText = Buffer.from(built.files['snapshot.json'].bytes || built.files['snapshot.json'].text || '').toString('utf8');
  assert.ok(snapshotText.length > 0, 'snapshot.json produced');
  assert.ok(snapshotText.includes(`assets/${FIX.png.sha256}.png`), 'built snapshot keeps the canonical reference');
  assert.ok(!snapshotText.includes('data:image'), 'built snapshot contains no hydrated data URI');
});

await checkAsync('[RF-07] the edit-overlay base digest is unchanged by hydration', async () => {
  const raw = await rawProjection(SNAP);
  const hyd = await seam.loadSnapshotFromStoresDesktop(SNAP);
  assert.equal(S.overlay.computeBaseDigest(hyd), S.overlay.computeBaseDigest(raw));
  assert.notEqual(JSON.stringify(plain(hyd.meta.richTurns)), JSON.stringify(plain(raw.meta.richTurns)), 'control: the projections differ in richTurns');
});

await checkAsync('[RF-08] a non-recovered snapshot with a literal assets/sha256-… reference does NOT hydrate; recovered-without-links and link-outside-assetRefs do NOT hydrate', async () => {
  /* (a) non-recovered snapshot, same HTML, even with links present */
  const html = db.prepare('SELECT outer_html, text, meta_json FROM snapshot_turns WHERE snapshot_id = ? AND turn_idx = 1').get(SNAP);
  db.prepare("INSERT INTO chats (id, title) VALUES ('rf-plain-chat', 'plain')").run();
  db.prepare("INSERT INTO snapshots (id, chat_id, title, message_count, meta_json) VALUES ('snap_rf_plain', 'rf-plain-chat', 'plain', 1, '{}')").run();
  db.prepare('INSERT INTO snapshot_turns (snapshot_id, turn_idx, role, outer_html, text, meta_json) VALUES (?, 1, ?, ?, ?, ?)').run('snap_rf_plain', 'assistant', html.outer_html, html.text, html.meta_json);
  db.prepare("INSERT INTO snapshot_turn_assets (snapshot_id, turn_idx, sha256, relation) VALUES ('snap_rf_plain', 1, ?, 'inline')").run(FIX.png.sha256);
  const plainLoad = await seam.loadSnapshotFromStoresDesktop('snap_rf_plain');
  assert.ok(plainLoad && plainLoad.meta.richTurns[0].outerHTML.includes(`assets/${FIX.png.sha256}.png`) && !plainLoad.meta.richTurns[0].outerHTML.includes('data:image'), 'G-a: HTML alone never triggers hydration');
  /* (b) recovered provenance but no persisted links */
  db.prepare("INSERT INTO snapshots (id, chat_id, title, message_count, meta_json) VALUES ('snap_rf_nolinks', 'rf-plain-chat', 'nolinks', 1, ?)").run(JSON.stringify({ recovered: { recoveredFromPackage: true } }));
  db.prepare('INSERT INTO snapshot_turns (snapshot_id, turn_idx, role, outer_html, text, meta_json) VALUES (?, 1, ?, ?, ?, ?)').run('snap_rf_nolinks', 'assistant', html.outer_html, html.text, html.meta_json);
  const noLinks = await seam.loadSnapshotFromStoresDesktop('snap_rf_nolinks');
  assert.ok(!noLinks.meta.richTurns[0].outerHTML.includes('data:image'), 'G-b: no persisted links → no hydration');
  /* (c) recovered + link, but the turn's own assetRefs do not contain the link SHA */
  db.prepare("INSERT INTO snapshots (id, chat_id, title, message_count, meta_json) VALUES ('snap_rf_norefs', 'rf-plain-chat', 'norefs', 1, ?)").run(JSON.stringify({ recovered: { recoveredFromPackage: true } }));
  db.prepare('INSERT INTO snapshot_turns (snapshot_id, turn_idx, role, outer_html, text, meta_json) VALUES (?, 1, ?, ?, ?, ?)').run('snap_rf_norefs', 'assistant', html.outer_html, html.text, JSON.stringify({ sourceMessageId: 'm1', assetRefs: [FIX.gif.sha256] }));
  db.prepare("INSERT INTO snapshot_turn_assets (snapshot_id, turn_idx, sha256, relation) VALUES ('snap_rf_norefs', 1, ?, 'inline')").run(FIX.png.sha256);
  const noRefs = await seam.loadSnapshotFromStoresDesktop('snap_rf_norefs');
  assert.ok(!noRefs.meta.richTurns[0].outerHTML.includes('data:image'), 'G-c: link outside the turn assetRefs → no hydration');
});

await checkAsync('[RF-09] identical row + links + verified bytes → byte-identical richTurns across repeated hydration', async () => {
  const a = await seam.loadSnapshotFromStoresDesktop(SNAP);
  const b = await seam.loadSnapshotFromStoresDesktop(SNAP);
  assert.equal(JSON.stringify(plain(a.meta.richTurns)), JSON.stringify(plain(b.meta.richTurns)));
  assert.equal(JSON.stringify(plain(a)), JSON.stringify(plain(b)), 'whole projection deterministic');
  assert.equal(S.overlay.computeBaseDigest(a), S.overlay.computeBaseDigest(b));
});

await checkAsync('[RF-10] CAS null / read failure / hash contradiction → the turn stays canonical and the snapshot still loads', async () => {
  const pngHex = bare(FIX.png.sha256);
  const objectPath = casPath(pngHex);
  const original = fs.readFileSync(j(objectPath));
  /* read failure */
  hooks.readFileFail = objectPath;
  const onFail = await seam.loadSnapshotFromStoresDesktop(SNAP);
  hooks.readFileFail = null;
  assert.ok(onFail && onFail.snapshotId === SNAP, 'snapshot still loads');
  assert.ok(onFail.meta.richTurns[1].outerHTML.includes(`assets/${FIX.png.sha256}.png`), 'turn 1 keeps the canonical reference');
  assert.ok(onFail.meta.richTurns[2].outerHTML.includes(`src="${GIF_URI}"`), 'the unaffected asset in turn 2 still hydrates');
  /* hash contradiction (corrupt object) */
  fs.writeFileSync(j(objectPath), Buffer.from('corrupt'));
  const onCorrupt = await seam.loadSnapshotFromStoresDesktop(SNAP);
  assert.ok(onCorrupt && onCorrupt.meta.richTurns[1].outerHTML.includes(`assets/${FIX.png.sha256}.png`), 'corrupt object → unhydrated turn, no throw');
  /* absent object */
  fs.rmSync(j(objectPath));
  const onMissing = await seam.loadSnapshotFromStoresDesktop(SNAP);
  assert.ok(onMissing && onMissing.meta.richTurns[1].outerHTML.includes(`assets/${FIX.png.sha256}.png`), 'missing object → unhydrated turn, no throw');
  fs.writeFileSync(j(objectPath), original);
  const restored = await seam.loadSnapshotFromStoresDesktop(SNAP);
  assert.ok(restored.meta.richTurns[1].outerHTML.includes(`src="${PNG_URI}"`), 'hydrates again once the object verifies');
  assert.ok(!ledger.some((e) => e.cmd === 'cas-repair'), 'the Reader path never repairs');
});

await checkAsync('[RF-11] unsupported MIME and over-budget assets stay canonical while the other turns remain rich and within budget', async () => {
  const policy = S.Renderer.sanitizerPolicy;
  db.prepare("UPDATE assets SET mime_type = 'application/pdf' WHERE sha256 = ?").run(FIX.gif.sha256);
  const nonRaster = await seam.loadSnapshotFromStoresDesktop(SNAP);
  db.prepare("UPDATE assets SET mime_type = 'image/gif' WHERE sha256 = ?").run(FIX.gif.sha256);
  assert.ok(nonRaster.meta.richTurns[2].outerHTML.includes(`src="assets/${FIX.gif.sha256}.gif"`), 'non-raster MIME → canonical reference kept');
  assert.ok(nonRaster.meta.richTurns[2].outerHTML.includes(`src="${PNG_URI}"`), 'the admissible asset in the same turn still hydrates');
  assert.ok(nonRaster.meta.richTurns[1].outerHTML.includes(`src="${PNG_URI}"`), 'other turns remain rich');
  assert.equal(nonRaster.meta.richTurns.length, nonRaster.messages.length, 'coverage intact (no transcript collapse precondition)');
  /* over budget: pad the stored turn so any hydration would exceed the Renderer guard */
  const row = db.prepare('SELECT outer_html FROM snapshot_turns WHERE snapshot_id = ? AND turn_idx = 1').get(SNAP);
  const pad = '<!--' + 'x'.repeat(policy.maxInputBytes - row.outer_html.length - 16) + '-->';
  db.prepare('UPDATE snapshot_turns SET outer_html = ? WHERE snapshot_id = ? AND turn_idx = 1').run(row.outer_html + pad, SNAP);
  const over = await seam.loadSnapshotFromStoresDesktop(SNAP);
  db.prepare('UPDATE snapshot_turns SET outer_html = ? WHERE snapshot_id = ? AND turn_idx = 1').run(row.outer_html, SNAP);
  assert.ok(over.meta.richTurns[1].outerHTML.includes(`assets/${FIX.png.sha256}.png`) && !over.meta.richTurns[1].outerHTML.includes('data:image'), 'over-budget turn stays canonical');
  assert.ok(over.meta.richTurns[2].outerHTML.includes(`src="${PNG_URI}"`), 'other turns still hydrate');
  assert.ok(over.meta.richTurns.every((t) => policy.isWithinBudget(t.outerHTML)), 'every returned turn is within the Renderer input guard');
  for (const t of over.meta.richTurns) {
    for (const m of t.outerHTML.matchAll(/src="(data:[^"]+)"/g)) assert.equal(policy.classifyUrl(m[1], 'image').ok, true, 'every hydrated URI is admitted by the policy oracle');
  }
});

await checkAsync('[RF-01b] absent helper / helper failure → canonical projection unchanged, never reader-missing', async () => {
  const realHelper = S.archiveImporter.hydrateRecoveredSnapshotProjectionV1;
  const raw = await rawProjection(SNAP);
  S.archiveImporter = Object.assign({}, S.archiveImporter, { hydrateRecoveredSnapshotProjectionV1: undefined });
  const absent = await seam.loadSnapshotFromStoresDesktop(SNAP);
  assert.equal(JSON.stringify(plain(absent)), JSON.stringify(plain(raw)), 'absent helper → canonical');
  S.archiveImporter = Object.assign({}, S.archiveImporter, { hydrateRecoveredSnapshotProjectionV1: async () => { throw new Error('boom'); } });
  const threw = await seam.loadSnapshotFromStoresDesktop(SNAP);
  assert.equal(JSON.stringify(plain(threw)), JSON.stringify(plain(raw)), 'throwing helper → canonical');
  S.archiveImporter = Object.assign({}, S.archiveImporter, { hydrateRecoveredSnapshotProjectionV1: async () => null });
  const nul = await seam.loadSnapshotFromStoresDesktop(SNAP);
  assert.equal(JSON.stringify(plain(nul)), JSON.stringify(plain(raw)), 'null result → canonical');
  S.archiveImporter = Object.assign({}, S.archiveImporter, { hydrateRecoveredSnapshotProjectionV1: realHelper });
  const missing = await seam.loadSnapshotFromStoresDesktop('snap_does_not_exist');
  assert.equal(missing, null, 'a genuinely missing snapshot is still null (unchanged semantics)');
});

try { db.close(); } catch (_) { /* ignore */ }
fs.rmSync(root, { recursive: true, force: true });
if (FAIL.length) {
  console.log(`\n[recovered-asset-hydration-rf] ${FAIL.length} failed, ${PASS.length} passed`);
  process.exit(1);
}
console.log(`\n[recovered-asset-hydration-rf] PASS ${PASS.length} checks`);
process.exit(0);
