#!/usr/bin/env node
// I.1/I.2/K.3 — Saved-chat archive IMPORT-RECOVERY + RESTORE HARNESS.
//
// Phase I promotes the one-off H.5 node:sqlite import-as-new proof into a permanent
// repo harness (contract: I.0). I.1 added the static scaffold + a deterministic
// fixture. I.2 (this file) turns it into the real harness: it builds a deterministic
// seed node:sqlite DB (schema/triggers mirrored from the real Tauri migrations, with a
// drift guard), registers the Tauri h2o_writer_identity() stub, loads the REAL
// diagnostics / inspector / importer / store adapters, and proves the import-as-new
// recovery loop end-to-end — verify -> import-ready -> imported, +1 chat / +1 snapshot
// / +N turns, fresh ids, provenance, NO UPDATE (no overwrite), already-imported no-op,
// and the live Desktop DB untouched. K.3 extends the same permanent temp-DB proof
// to restore-original-ids: restore-ready -> restored, confirm gate, already-present,
// conflict-snapshot-id, conflict-chat-id, and tombstoned. K.4.3 extends it again
// to archive relink: relink-ready -> relinked, typed-confirm rejection,
// already-relinked, target-missing/deleted/tombstoned/conflict, exact pointer
// UPDATE bounds, and old snapshot/turn preservation.
//
//   [I.0]      = the harness contract (doc assertions).
//   [SCAFFOLD] = scaffold artifacts + the deterministic fixture is well-formed.
//   [LESSON]   = the H.5 lessons, locked against the real importer.
//   [I.2]      = the live harness run + its assertions.
//
// It NEVER depends on or mutates the developer's live studio-v1.db: the seed DB is a
// throwaway temp file built from inline SQL, and all reads/writes are routed there.
// (A live-DB stat is taken only as an optional untouched-witness, fully guarded.)
// Tombstone override/un-delete and package export are out of this harness.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), '..', '..', '..');

const I0_CONTRACT_REL = 'release-evidence/2026-06-24/saved-chat-archive-phase-i0-import-harness-contract.md';
const I1_EVIDENCE_REL = 'release-evidence/2026-06-24/saved-chat-archive-phase-i1-import-harness-scaffold.md';
const I2_EVIDENCE_REL = 'release-evidence/2026-06-24/saved-chat-archive-phase-i2-import-harness-runtime.md';
const K3_EVIDENCE_REL = 'release-evidence/2026-06-24/saved-chat-archive-phase-k3-restore-runtime-smoke.md';
const K43_EVIDENCE_REL = 'release-evidence/2026-06-24/saved-chat-archive-phase-k4-3-relink-harness.md';
const VALIDATOR_REL = 'tools/validation/studio/validate-saved-chat-archive-import-recovery-harness-v1.mjs';
const FIXTURE_DIR_REL = 'tools/validation/fixtures/saved-chat-archive/import-recovery';
const FIXTURE_README_REL = FIXTURE_DIR_REL + '/README.md';
const FIXTURE_PKG_REL = FIXTURE_DIR_REL + '/i-harness-source.h2ochat';
const V3_FIXTURE_PKG_REL = 'tools/validation/fixtures/saved-chat-archive/v3/t06-canonical-assets.h2ochat';
const V3_GZIP_FIXTURE_PKG_REL = 'tools/validation/fixtures/saved-chat-archive/v3/gzip/t06-canonical-assets.h2ochat';
const IMPORTER_REL = 'src-surfaces-base/studio/ingestion/saved-chat-archive-importer.studio.js';
const LIB_RS_REL = 'apps/studio/desktop/src-tauri/src/lib.rs';
const WRITER_IDENTITY_RS_REL = 'apps/studio/desktop/src-tauri/src/sqlite_writer_identity.rs';
const STORE_MODULES = [
  'store/index.js', 'store/snapshots.tauri.js', 'store/chats.tauri.js',
  /* M03 T04: the governed saved-chat package codec must load before
   * diagnostics/inspector, mirroring the product order in studio.html. */
  'ingestion/saved-chat-package-codec.tauri.js',
  /* M10 P3.5: the Inspector reads archive integrity from the TRUSTED native
   * authority and partitions occupants through the canonical archive-health
   * mapping. Both must register before it, exactly as studio.html loads them
   * (codec -> integrity client -> diagnostics -> mapping -> inspector). */
  'ingestion/saved-chat-archive-integrity.tauri.js',
  'ingestion/saved-chat-archive-diagnostics.tauri.js',
  'ingestion/saved-chat-archive-health-mapping.js',
  'ingestion/saved-chat-archive-inspector.studio.js',
  'ingestion/saved-chat-archive-importer.studio.js',
  'ingestion/saved-chat-archive-restore.studio.js',
  'ingestion/saved-chat-archive-relink.studio.js',
];
const REQUIRED_FILES = ['manifest.json', 'snapshot.json', 'chat.md', 'chat.html'];
const LIVE_DB = path.join(os.homedir(), 'Library', 'Application Support', 'org.h2o.studio.desktop', 'studio-v1.db');

// Deterministic seed schema — the chats / snapshots / snapshot_turns tables the
// importer touches, plus the f15 chats-category_id protection triggers (BEFORE
// INSERT/UPDATE) that reference h2o_writer_identity(). Mirrored from the real Tauri
// schema; the drift guard (below) fails clearly if the real source restructures it.
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
  schema TEXT NOT NULL DEFAULT 'h2o.syncTombstone.v1',
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
CREATE TRIGGER f15_protect_chats_category_id_insert
  BEFORE INSERT ON chats WHEN NEW.category_id IS NOT NULL AND NEW.category_id != ''
  BEGIN SELECT CASE WHEN COALESCE(h2o_writer_identity(), '') NOT IN
    ('f15.execute-settlement-writer','f15.bulk-migration','f15.debug-bypass','f15.emergency-repair')
    THEN RAISE(ABORT, 'f15-store-write-protected:chats.category_id') END; END;
CREATE TRIGGER f15_protect_chats_category_id_update
  BEFORE UPDATE OF category_id ON chats WHEN COALESCE(OLD.category_id, '') != COALESCE(NEW.category_id, '')
  BEGIN SELECT CASE WHEN COALESCE(h2o_writer_identity(), '') NOT IN
    ('f15.execute-settlement-writer','f15.bulk-migration','f15.debug-bypass','f15.emergency-repair')
    THEN RAISE(ABORT, 'f15-store-write-protected:chats.category_id') END; END;
`;

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
function exists(rel) { return fs.existsSync(path.join(REPO_ROOT, rel)); }
function stripComments(src) { return String(src).replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1'); }
function sha256Prefixed(buf) { return 'sha256-' + crypto.createHash('sha256').update(buf).digest('hex'); }
function readFixtureBytes(leaf) { return fs.readFileSync(path.join(REPO_ROOT, FIXTURE_PKG_REL, leaf)); }
function readFixtureJson(leaf) { return JSON.parse(readFixtureBytes(leaf).toString('utf8')); }

const i0 = exists(I0_CONTRACT_REL) ? readRepo(I0_CONTRACT_REL) : '';
const i1 = exists(I1_EVIDENCE_REL) ? readRepo(I1_EVIDENCE_REL) : '';
const i2 = exists(I2_EVIDENCE_REL) ? readRepo(I2_EVIDENCE_REL) : '';
const importerCode = exists(IMPORTER_REL) ? stripComments(readRepo(IMPORTER_REL)) : '';

console.log('[archive-import-recovery-harness] I.1 scaffold + I.2 live-harness checks');

// --- A. I.0 contract ---------------------------------------------------------

check('[I.0] contract evidence file exists and is marked NOT IMPLEMENTED', () => {
  assert.ok(exists(I0_CONTRACT_REL), 'missing ' + I0_CONTRACT_REL);
  assert.match(i0, /PHASE I\.0 CONTRACT\s*[—-]\s*NOT IMPLEMENTED/);
});

check('[I.0] contract states the deterministic seed strategy (deterministic preferred; live-copy dev-only; drift guard)', () => {
  assert.match(i0, /deterministic/i);
  assert.match(i0, /seed (sqlite )?db|seed schema/i);
  assert.match(i0, /dev-only/i);
  assert.match(i0, /drift (guard|check)/i);
});

check('[I.0] contract enumerates the harness target coverage (the H.5 assertions)', () => {
  for (const phrase of ['import-ready', 'imported', 'already-imported']) {
    assert.ok(i0.includes(phrase), 'contract missing coverage phrase: ' + phrase);
  }
  assert.match(i0, /chats \+1/);
  assert.match(i0, /snapshots \+1/);
  assert.match(i0, /turns \+N|snapshot_turns \+N/);
  assert.match(i0, /no `?UPDATE`?/i);
});

check('[I.0] contract documents Tauri parity (h2o_writer_identity stub) and the deferrals', () => {
  assert.ok(i0.includes('h2o_writer_identity'), 'contract must document the writer-identity stub');
  assert.match(i0, /restore ?\/ ?relink/i);
  assert.match(i0, /export/i);
  assert.match(i0, /deferred/i);
});

// --- B. Scaffold artifacts + deterministic fixture well-formedness -----------

check('[SCAFFOLD] the validator, fixture directory, fixture package, and README all exist', () => {
  assert.ok(exists(VALIDATOR_REL) && exists(FIXTURE_DIR_REL) && exists(FIXTURE_PKG_REL) && exists(FIXTURE_README_REL));
  assert.ok(/\.h2ochat$/.test(FIXTURE_PKG_REL), 'fixture package dir must end in .h2ochat');
});

check('[SCAFFOLD] fixture README documents the seed strategy + Tauri parity + deferrals', () => {
  const r = readRepo(FIXTURE_README_REL);
  assert.match(r, /deterministic/i);
  assert.ok(r.includes('h2o_writer_identity'));
  assert.match(r, /drift guard/i);
  assert.ok(/not user data/i.test(r));
});

check('[SCAFFOLD] fixture has all four required files', () => {
  for (const f of REQUIRED_FILES) assert.ok(exists(FIXTURE_PKG_REL + '/' + f), 'missing: ' + f);
});

check('[SCAFFOLD] fixture file hashes recompute and match the manifest', () => {
  const manifest = readFixtureJson('manifest.json');
  const map = { snapshot: 'snapshot.json', markdown: 'chat.md', html: 'chat.html' };
  for (const key of Object.keys(map)) {
    const actual = sha256Prefixed(readFixtureBytes(map[key]));
    assert.equal(manifest.files[key].sha256, actual, key + ' sha mismatch');
  }
});

check('[SCAFFOLD] fixture is a verifiable v1 asset-free package (contentHash = snapshot sha; schemaVersion 1; no assets; messages[] present)', () => {
  const manifest = readFixtureJson('manifest.json');
  const snap = readFixtureJson('snapshot.json');
  assert.equal(manifest.schemaVersion, 1);
  assert.deepEqual(manifest.assets || [], []);
  const snapSha = sha256Prefixed(readFixtureBytes('snapshot.json'));
  assert.equal(manifest.contentHash, snapSha);
  assert.equal(manifest.chatId, snap.chatId);
  assert.equal(manifest.snapshotId, snap.snapshotId);
  assert.ok(Array.isArray(snap.messages) && snap.messages.length >= 1);
  // diagnostics requires the package folder basename to equal chatId + '.h2ochat'
  assert.equal(FIXTURE_PKG_REL.split('/').pop(), manifest.chatId + '.h2ochat', 'fixture dir basename must equal chatId.h2ochat');
});

check('[M03 T05] permanent gzip-v3 fixture satisfies the frozen v3 contract', () => {
  assert.ok(exists(V3_GZIP_FIXTURE_PKG_REL + '/manifest.json'));
  assert.ok(exists(V3_GZIP_FIXTURE_PKG_REL + '/snapshot.json'));
  /* renderer-free, exactly like the identity fixture it derives from */
  assert.equal(exists(V3_GZIP_FIXTURE_PKG_REL + '/chat.md'), false);
  assert.equal(exists(V3_GZIP_FIXTURE_PKG_REL + '/chat.html'), false);

  const m = JSON.parse(readRepo(V3_GZIP_FIXTURE_PKG_REL + '/manifest.json'));
  const stored = fs.readFileSync(path.join(REPO_ROOT, V3_GZIP_FIXTURE_PKG_REL, 'snapshot.json'));
  const d = m.files.snapshot;
  const sha = (b) => 'sha256-' + crypto.createHash('sha256').update(b).digest('hex');

  assert.equal(m.schemaVersion, 3);
  assert.equal(m.payloadVersion, 3);
  assert.equal(d.encoding, 'gzip');
  /* physical descriptor describes the STORED gzip bytes */
  assert.equal(d.sha256, sha(stored));
  assert.equal(d.byteLength, stored.length);
  /* logical descriptor describes the canonical DECODED bytes */
  const logical = zlib.gunzipSync(stored);
  assert.equal(d.contentSha256, sha(logical));
  assert.equal(d.contentByteLength, logical.length);
  /* DP-M03-C: 0 < physical < logical <= 8 MiB */
  assert.ok(d.byteLength > 0, 'physical length must be positive');
  assert.ok(d.byteLength < d.contentByteLength, 'physical must be strictly smaller than logical');
  assert.ok(d.contentByteLength <= 8 * 1024 * 1024, 'logical must respect the governed snapshot cap');
  /* manifest stays plaintext JSON; assets stay identity-encoded */
  assert.ok(m.assets.length > 0);
  for (const a of m.assets) assert.ok(!a.encoding || a.encoding === 'identity');
});

check('[M03 T05] permanent gzip and identity fixtures share one logical identity', () => {
  const idM = JSON.parse(readRepo(V3_FIXTURE_PKG_REL + '/manifest.json'));
  const gzM = JSON.parse(readRepo(V3_GZIP_FIXTURE_PKG_REL + '/manifest.json'));
  /* logical content is byte-identical, so logical identity must be identical */
  assert.equal(gzM.chatId, idM.chatId);
  assert.equal(gzM.snapshotId, idM.snapshotId);
  assert.equal(gzM.files.snapshot.contentSha256, idM.files.snapshot.sha256);
  assert.equal(gzM.files.snapshot.contentByteLength, idM.files.snapshot.byteLength);
  assert.equal(gzM.contentHash, idM.contentHash, 'contentHash must be encoding-independent');
  /* only the physical representation differs */
  assert.notEqual(gzM.files.snapshot.sha256, idM.files.snapshot.sha256);
  assert.equal(idM.files.snapshot.encoding, 'identity');
  const idLogical = fs.readFileSync(path.join(REPO_ROOT, V3_FIXTURE_PKG_REL, 'snapshot.json'));
  const gzLogical = zlib.gunzipSync(fs.readFileSync(path.join(REPO_ROOT, V3_GZIP_FIXTURE_PKG_REL, 'snapshot.json')));
  assert.deepEqual(Buffer.from(gzLogical), Buffer.from(idLogical), 'decoded gzip must equal the identity payload byte-for-byte');
});

check('[M02 T06] committed canonical v3 fixture exists and is renderer-free', () => {
  assert.ok(exists(V3_FIXTURE_PKG_REL + '/manifest.json'));
  assert.ok(exists(V3_FIXTURE_PKG_REL + '/snapshot.json'));
  assert.equal(exists(V3_FIXTURE_PKG_REL + '/chat.md'), false);
  assert.equal(exists(V3_FIXTURE_PKG_REL + '/chat.html'), false);
  const manifest = JSON.parse(readRepo(V3_FIXTURE_PKG_REL + '/manifest.json'));
  assert.equal(manifest.schemaVersion, 3);
  assert.equal(manifest.payloadVersion, 3);
});

// --- C. H.5 lessons locked against the real importer -------------------------

check('[LESSON] store rows expose snapshotId not id — importer uses snapshotRowId()', () => {
  assert.ok(importerCode.includes('snapshotRowId'));
});

check('[LESSON] import-as-new uses FRESH ids; snapshots.create omits snapshotId; the overwrite-by-id primitive is never used', () => {
  assert.ok(importerCode.includes('generateRecoveredChatId'));
  assert.ok(/snapStore\.create\(|snapshots\.create\(/.test(importerCode));
  assert.ok(!/snapStore\.upsert\(|snapshots\.upsert\(/.test(importerCode));
  assert.doesNotMatch(importerCode, /create\(\{[^}]*snapshotId/s);
});

check('[LESSON] importer writes no raw INSERT/UPDATE SQL (no-overwrite path is via the store adapters)', () => {
  assert.doesNotMatch(importerCode, /\bINSERT\s+INTO\b|\bUPDATE\b[^=]/i);
});

check('[LESSON] importer has no Chrome/scanner/materializer/watcher/sync coupling', () => {
  for (const banned of ['chrome.runtime', 'scanSavedChatArchiveRequestInboxV1', 'materializeSavedChatArchiveRequestV1',
    'setInterval', 'MutationObserver', 'connectNative', 'H2O.Studio.sync', 'webdav', 'plugin:fs|write']) {
    assert.ok(!importerCode.includes(banned), 'importer must not couple to: ' + banned);
  }
});

// --- D. Live harness (I.2) ---------------------------------------------------

function normRow(r) { const o = {}; for (const k in r) o[k] = typeof r[k] === 'bigint' ? Number(r[k] === null ? 0 : r[k]) : r[k]; return o; }

function generateConflictFreeFixture(srcDir, dstDir, newChat, newSnap) {
  const m = JSON.parse(fs.readFileSync(path.join(srcDir, 'manifest.json'), 'utf8'));
  const oldChat = m.chatId, oldSnap = m.snapshotId;
  const rw = (s) => s.split(oldChat).join(newChat).split(oldSnap).join(newSnap);
  const snapBuf = Buffer.from(rw(fs.readFileSync(path.join(srcDir, 'snapshot.json'), 'utf8')));
  const mdBuf = Buffer.from(rw(fs.readFileSync(path.join(srcDir, 'chat.md'), 'utf8')));
  const htmlBuf = Buffer.from(rw(fs.readFileSync(path.join(srcDir, 'chat.html'), 'utf8')));
  const snapSha = sha256Prefixed(snapBuf);
  m.chatId = newChat; m.snapshotId = newSnap; m.packageId = 'pkg_' + newSnap + '_' + snapSha.slice(7, 19);
  m.files.snapshot.sha256 = snapSha; m.files.snapshot.byteLength = snapBuf.length;
  m.files.markdown.sha256 = sha256Prefixed(mdBuf); m.files.markdown.byteLength = mdBuf.length;
  m.files.html.sha256 = sha256Prefixed(htmlBuf); m.files.html.byteLength = htmlBuf.length;
  m.contentHash = snapSha;
  fs.mkdirSync(dstDir, { recursive: true });
  fs.writeFileSync(path.join(dstDir, 'snapshot.json'), snapBuf);
  fs.writeFileSync(path.join(dstDir, 'chat.md'), mdBuf);
  fs.writeFileSync(path.join(dstDir, 'chat.html'), htmlBuf);
  fs.writeFileSync(path.join(dstDir, 'manifest.json'), JSON.stringify(m, null, 2) + '\n');
}

function dirSig(dir) {
  return fs.readdirSync(dir).sort().map((f) => f + ':' + crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, f))).digest('hex').slice(0, 12)).join('|');
}

async function runHarness() {
  // --- drift guard: the seed mirrors the real Tauri schema/triggers ---
  const libRs = exists(LIB_RS_REL) ? readRepo(LIB_RS_REL) : '';
  const widRs = exists(WRITER_IDENTITY_RS_REL) ? readRepo(WRITER_IDENTITY_RS_REL) : '';
  const drift = [];
  if (!libRs) drift.push('lib.rs migration source not found');
  if (!widRs) drift.push('sqlite_writer_identity.rs not found');
  if (widRs && !/h2o_writer_identity/.test(widRs)) drift.push('h2o_writer_identity scalar no longer defined in sqlite_writer_identity.rs');
  if (libRs && !/f15_protect_chats_category_id|f15-store-write-protected:chats\.category_id/.test(libRs)) drift.push('f15 chats category_id protection trigger no longer present in lib.rs');
  for (const t of ['chats', 'snapshots', 'snapshot_turns']) {
    if (libRs && !new RegExp('\\b' + t + '\\b').test(libRs)) drift.push('studio_migrations() no longer references table: ' + t);
  }
  if (drift.length) throw new Error('SCHEMA/TRIGGER DRIFT — update the I.2 seed schema: ' + drift.join('; '));

  const srcSnap = readFixtureJson('snapshot.json');
  const SRC_CHAT = srcSnap.chatId, SRC_SNAP = srcSnap.snapshotId, SRC_DIGEST = srcSnap.metadata.digest;
  const SRC_MSGS = Array.isArray(srcSnap.messages) ? srcSnap.messages.length : 0;
  const RDY_CHAT = 'i-harness-import-ready-chat', RDY_SNAP = 'snap_i_harness_import_ready';

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'i2-harness-'));
  const seedDbPath = path.join(tmp, 'seed.db');
  const appDir = path.join(tmp, 'app');
  const pkgRoot = path.join(appDir, 'archive', 'packages');
  const writes = [];
  /* G01: the exact bound parameters of every attempted mutation, captured
   * BEFORE execution. A write-verb count cannot see WHAT was written, so a
   * substitution proof needs the payload itself. */
  const sqlPayloads = [];
  /* G01: every package member actually read, so a binding failure can be
   * proven to refuse BEFORE the member read rather than after it. */
  const fileReads = [];
  let db = null;
  const liveBefore = fs.existsSync(LIVE_DB) ? fs.statSync(LIVE_DB) : null;

  try {
    // seed DB
    db = new DatabaseSync(seedDbPath);
    db.function('h2o_writer_identity', () => '');            // Tauri parity stub (must precede any chats INSERT)
    db.exec(SEED_SCHEMA);
    // seed the already-imported source row (chat + snapshot with the source digest)
    db.prepare('INSERT INTO chats (id, title, meta_json) VALUES (?, ?, ?)').run(SRC_CHAT, 'I-Harness source', '{}');
    db.prepare('INSERT INTO snapshots (id, chat_id, title, digest, message_count, meta_json) VALUES (?, ?, ?, ?, ?, ?)')
      .run(SRC_SNAP, SRC_CHAT, 'I-Harness source', SRC_DIGEST, SRC_MSGS, '{}');

    /* ── Trusted native integrity: SCENARIO DECLARATIONS ──────────────────
     * This harness owns DOWNSTREAM behaviour (Inspector consumption, import /
     * restore / relink, DB deltas). It does NOT own package-byte validity:
     * since M10 P3.5 that belongs exclusively to the trusted Rust verifier and
     * scanner.
     *
     * So each scenario DECLARES the trusted outcome the native boundary is
     * independently proven to return, and the declaration below is replayed by
     * the `h2o_saved_chat_archive_integrity` test double. Nothing here inspects
     * bytes, hashes anything, decodes gzip, or calls a JS verifier to decide
     * validity — a declaration is an input to this harness, never a discovery.
     *
     * Every declared outcome traces to Rust coverage:
     *   verified-generation / legacy-package
     *     -> saved_chat_package_verify::tests::
     *          permanent_identity_and_gzip_fixtures_verify_to_one_js_identity
     *   indeterminate / corrupt (malformed or truncated gzip, false descriptors)
     *     -> archive_package_scan::tests::
     *          scanner_refuses_v3_renderer_members_malformed_gzip_and_false_logical_descriptor
     *        (asserts Indeterminate with Corrupt | Partial — no granular
     *         blocker code, which is why none is declared or asserted here)
     *     -> saved_chat_package_verify::tests::
     *          v3_rejects_gzip_logical_descriptor_and_bounded_decode_failures
     *   indeterminate / identity-mismatch (generation name vs proven identity)
     *     -> archive_package_scan.rs NameShape::Generation arm
     */
    const trustedDeclarations = new Map();
    /* G01: each trusted enumeration is an INDEPENDENT native call, and
     * nothing guarantees the archive stood still between the inspection read
     * and the binding read. A scenario may therefore declare what the
     * enumeration observed on each successive call. Still a declaration: the
     * double discovers nothing and verifies nothing. */
    let integrityCallSeq = 0;
    let onIntegrityCall = null;
    const ARCHIVE_PREFIX = 'archive/packages/';
    function declareTrusted(dirName, facts) {
      trustedDeclarations.set(ARCHIVE_PREFIX + dirName, Object.assign({
        path: ARCHIVE_PREFIX + dirName,
      }, facts));
    }
    /* Reads the package's own DECLARED manifest identity for the envelope's
     * identity fields. This is transcription of a fixture fact, not
     * verification: the trusted CLASS is always supplied by the caller. */
    function manifestIdentity(dirName) {
      const mp = path.join(pkgRoot, dirName, 'manifest.json');
      const m = JSON.parse(fs.readFileSync(mp, 'utf8'));
      const bare = (v) => String(v || '').toLowerCase().replace(/^sha256-/, '');
      /* The trusted scanner MEASURES the snapshot member it examined and
       * publishes those measurements on the occupant. The consumers bind their
       * reads to them precisely so a package can never describe itself, so this
       * double must carry them or every archive-path read refuses.
       *
       * Physical facts are measured from the fixture's own bytes on disk — the
       * same thing Rust does — rather than transcribed from the manifest, so a
       * fixture whose manifest lies about its bytes produces an occupant that
       * disagrees with those bytes, exactly as the real scanner would. Logical
       * facts equal the physical ones for `identity`, and for `gzip` come from
       * the descriptor the fixture builder itself wrote. */
      const snapAbs = path.join(pkgRoot, dirName, 'snapshot.json');
      const snapBytes = fs.existsSync(snapAbs) ? fs.readFileSync(snapAbs) : Buffer.alloc(0);
      const physicalSha = 'sha256-' + crypto.createHash('sha256').update(snapBytes).digest('hex');
      const desc = (m.files && m.files.snapshot) || {};
      const encoding = desc.encoding || 'identity';
      const logicalSha = encoding === 'gzip'
        ? String(desc.contentSha256 || '')
        : physicalSha;
      const logicalLen = encoding === 'gzip'
        ? Number(desc.contentByteLength)
        : snapBytes.length;
      return {
        chatId: m.chatId,
        snapshotId: m.snapshotId,
        contentHash: bare(m.contentHash),
        constructionFamily: 'v' + m.schemaVersion,
        assetShas: (m.assets || []).map((a) => bare(a.sha256)).sort(),
        snapshotEncoding: encoding,
        snapshotPhysicalSha256: physicalSha,
        snapshotPhysicalByteLength: snapBytes.length,
        logicalSnapshotSha256: logicalSha,
        logicalSnapshotByteLength: logicalLen,
      };
    }
    function declareValidPackage(dirName) {
      const id = manifestIdentity(dirName);
      /* M05 §D: a generation basename is a CLAIM the trusted scanner only
       * admits when the proven identity matches it. */
      const gen = /\.g([0-9a-f]{64})\.h2ochat$/.exec(dirName);
      if (gen && gen[1] !== id.contentHash) {
        declareTrusted(dirName, Object.assign({}, id, {
          class: 'indeterminate', reason: 'identity-mismatch',
        }));
        return;
      }
      declareTrusted(dirName, Object.assign({}, id, {
        class: gen ? 'verified-generation' : 'legacy-package',
      }));
    }
    function declareRefusedPackage(dirName, reason) {
      let id = {};
      try { id = manifestIdentity(dirName); } catch (_) { id = {}; }
      declareTrusted(dirName, Object.assign({}, id, {
        class: 'indeterminate', reason: reason,
      }));
    }

    // stage fixtures under temp AppLocalData
    fs.mkdirSync(pkgRoot, { recursive: true });
    const srcAbs = path.join(REPO_ROOT, FIXTURE_PKG_REL);
    fs.cpSync(srcAbs, path.join(pkgRoot, 'i-harness-source.h2ochat'), { recursive: true });
    declareValidPackage('i-harness-source.h2ochat');
    generateConflictFreeFixture(srcAbs, path.join(pkgRoot, 'i-harness-import-ready-chat.h2ochat'), RDY_CHAT, RDY_SNAP);
    declareValidPackage('i-harness-import-ready-chat.h2ochat');
    const restorePackages = {
      ready: { chat: 'k3-restore-ready-chat', snap: 'snap_k3_restore_ready' },
      confirm: { chat: 'k3-confirm-gate-chat', snap: 'snap_k3_confirm_gate' },
      conflictSnap: { chat: 'k3-conflict-snapshot-chat', snap: 'snap_k3_conflict_snapshot' },
      conflictChat: { chat: 'k3-conflict-chat', snap: 'snap_k3_conflict_chat' },
      tombstoned: { chat: 'k3-tombstoned-chat', snap: 'snap_k3_tombstoned' },
    };
    for (const info of Object.values(restorePackages)) {
      generateConflictFreeFixture(srcAbs, path.join(pkgRoot, info.chat + '.h2ochat'), info.chat, info.snap);
      declareValidPackage(info.chat + '.h2ochat');
    }
    const relinkPackages = {
      ready: { chat: 'k4-relink-package-chat', snap: 'snap_k4_relink_package' },
      deleted: { chat: 'k4-relink-deleted-package-chat', snap: 'snap_k4_relink_deleted' },
      tombstoned: { chat: 'k4-relink-tombstoned-package-chat', snap: 'snap_k4_relink_tombstoned' },
      conflict: { chat: 'k4-relink-conflict-package-chat', snap: 'snap_k4_relink_conflict' },
    };
    for (const info of Object.values(relinkPackages)) {
      generateConflictFreeFixture(srcAbs, path.join(pkgRoot, info.chat + '.h2ochat'), info.chat, info.snap);
      declareValidPackage(info.chat + '.h2ochat');
    }

    /* M05 Phase 4 (proofs 11–13): two packages for the SAME chat with different
     * content, one of them wearing a generation-style basename that sorts last.
     * Every explicit-selection flow must bind to the path it was handed. A flow
     * that quietly enumerated siblings and preferred the "latest" one would
     * restore or relink content the operator never selected. */
    const SIB_CHAT = 'p4-sibling-selection-chat';
    const siblingPackages = {
      a: { dir: SIB_CHAT + '.h2ochat', snap: 'snap_p4_sibling_a' },
      b: { dir: SIB_CHAT + '.g' + 'b'.repeat(64) + '.h2ochat', snap: 'snap_p4_sibling_b' },
    };
    for (const info of Object.values(siblingPackages)) {
      generateConflictFreeFixture(srcAbs, path.join(pkgRoot, info.dir), SIB_CHAT, info.snap);
      declareValidPackage(info.dir);
    }

    // wire globals + load real modules
    const mockInvoke = (cmd, a) => {
      const j = (p) => path.join(appDir, String(p || ''));
      try {
        /* TEST DOUBLE for the EXISTING native command. It replays the trusted
         * outcomes each scenario declared above in the canonical wire shape.
         * It is not a verifier: it runs no verification algorithm, decodes
         * nothing, hashes nothing, and never consults a JS package validator
         * to decide validity. Rust owns that proof. */
        if (cmd === 'h2o_saved_chat_archive_integrity') {
          integrityCallSeq += 1;
          if (typeof onIntegrityCall === 'function') onIntegrityCall(integrityCallSeq);
          return Promise.resolve({
            schema: 'h2o.savedChatArchiveIntegrity',
            schemaVersion: 1,
            complete: true,
            blockers: [],
            occupants: [...trustedDeclarations.values()],
          });
        }
        if (cmd === 'plugin:fs|exists') return Promise.resolve(fs.existsSync(j(a.path)));
        if (cmd === 'plugin:fs|lstat') {
          /* Real metadata from the harness's own temp filesystem: no hard-coded
           * sizes, no synthetic shapes. Feeds the governed bounded reader. */
          const st = fs.lstatSync(j(a.path));
          return Promise.resolve({ isFile: st.isFile(), isDirectory: st.isDirectory(), isSymlink: st.isSymbolicLink(), size: st.size });
        }
        if (cmd === 'plugin:fs|read_file') { fileReads.push(String((a && a.path) || '')); return Promise.resolve(Array.from(fs.readFileSync(j(a.path)))); }
        if (cmd === 'plugin:fs|read_dir') return Promise.resolve(fs.existsSync(j(a.path)) ? fs.readdirSync(j(a.path), { withFileTypes: true }).map((e) => ({ name: e.name, isDirectory: e.isDirectory(), isFile: e.isFile() })) : []);
        if (cmd === 'plugin:sql|select') return Promise.resolve(db.prepare(a.query).all(...(a.values || [])).map(normRow));
        if (cmd === 'plugin:sql|execute') {
          const verb = String(a.query).trim().split(/\s+/)[0].toUpperCase();
          const tbl = (String(a.query).match(/(?:INTO|UPDATE|FROM)\s+([a-z_]+)/i) || [])[1] || '';
          sqlPayloads.push(JSON.stringify({ query: String(a.query), values: (a.values || []) }));
          const r = db.prepare(a.query).run(...(a.values || []));
          writes.push(verb + ' ' + tbl + ' (' + r.changes + ')');
          return Promise.resolve([Number(r.changes), Number(r.lastInsertRowid)]);
        }
      } catch (e) { return Promise.reject(e); }
      return Promise.reject(new Error('unmocked invoke: ' + cmd));
    };
    globalThis.__TAURI_INTERNALS__ = { invoke: mockInvoke };
    if (!globalThis.crypto || !globalThis.crypto.subtle) globalThis.crypto = crypto.webcrypto;
    globalThis.window = undefined;
    globalThis.H2O = {};
    for (const m of STORE_MODULES) require(path.join(REPO_ROOT, 'src-surfaces-base/studio', m));
    const S = globalThis.H2O.Studio;
    const inspector = S.archiveInspector, importer = S.archiveImporter, restore = S.archiveRestore, relink = S.archiveRelink;
    assert.ok(inspector && importer && restore && relink, 'real inspector + importer + restore + relink must register');

    const counts = () => ({
      chats: db.prepare('SELECT count(*) c FROM chats').get().c,
      snapshots: db.prepare('SELECT count(*) c FROM snapshots').get().c,
      turns: db.prepare('SELECT count(*) c FROM snapshot_turns').get().c,
    });
    const rowSig = (tbl, id) => { const r = db.prepare('SELECT * FROM ' + tbl + ' WHERE id=?').get(id); return r ? crypto.createHash('sha256').update(JSON.stringify(r)).digest('hex').slice(0, 16) : null; };

    const READY_REL = 'archive/packages/i-harness-import-ready-chat.h2ochat';
    const SRC_REL = 'archive/packages/i-harness-source.h2ochat';

    /* ── M03 T04 Inspector: v3 gzip + v3 identity through the real chain ──
     * Both variants are written to the SAME package path in sequence, so they
     * carry byte-identical logical content and any Inspector difference is
     * purely representation-specific. */
    const V3_CHAT_ID = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, V3_FIXTURE_PKG_REL, 'manifest.json'), 'utf8')).chatId;
    const V3_DIR = V3_CHAT_ID + '.h2ochat';
    const V3_REL = 'archive/packages/' + V3_DIR;
    const v3Abs = path.join(pkgRoot, V3_DIR);
    const v3Src = path.join(REPO_ROOT, V3_FIXTURE_PKG_REL);
    const sha256Pfx = (buf) => 'sha256-' + crypto.createHash('sha256').update(buf).digest('hex');
    const v3BaseManifest = JSON.parse(fs.readFileSync(path.join(v3Src, 'manifest.json'), 'utf8'));
    const v3LogicalBytes = fs.readFileSync(path.join(v3Src, 'snapshot.json'));
    const v3GzipSrc = path.join(REPO_ROOT, V3_GZIP_FIXTURE_PKG_REL);
    const v3PermanentGzipBytes = fs.readFileSync(path.join(v3GzipSrc, 'snapshot.json'));
    const v3PermanentGzipManifest = JSON.parse(fs.readFileSync(path.join(v3GzipSrc, 'manifest.json'), 'utf8'));
    /* Every writeV3 caller states the trusted outcome the native boundary is
     * proven to return for the bytes it is about to write. There is no default:
     * a scenario that does not declare its trusted result cannot run. */
    const V3_VALID = { valid: true };
    const V3_REFUSED_CORRUPT = { valid: false, reason: 'corrupt' };
    const writeV3 = (encoding, snapshotBytesOverride, trusted) => {
      if (!trusted || typeof trusted.valid !== 'boolean') {
        throw new Error('writeV3 requires an explicit trusted outcome declaration');
      }
      fs.rmSync(v3Abs, { recursive: true, force: true });
      fs.mkdirSync(v3Abs, { recursive: true });
      const m = JSON.parse(JSON.stringify(v3BaseManifest));
      let storedBytes = v3LogicalBytes;
      const d = { path: 'snapshot.json' };
      if (encoding === 'gzip') {
        /* M03 T05: the valid gzip case is anchored to the PERMANENT committed
         * gzip-v3 fixture, so consumer coverage exercises the same bytes a
         * maintainer can inspect in the repository. Invalid variants are still
         * derived in temporary state only. */
        storedBytes = snapshotBytesOverride || v3PermanentGzipBytes;
        d.sha256 = sha256Pfx(storedBytes); d.byteLength = storedBytes.length; d.encoding = 'gzip';
        d.contentSha256 = sha256Pfx(v3LogicalBytes); d.contentByteLength = v3LogicalBytes.length;
      } else {
        d.sha256 = sha256Pfx(storedBytes); d.byteLength = storedBytes.length; d.encoding = 'identity';
      }
      m.files = Object.assign({}, m.files, { snapshot: d });
      /* contentHash is logical, so it is identical for both representations. */
      for (const a of (m.assets || [])) {
        const src = path.join(v3Src, a.path);
        if (fs.existsSync(src)) { fs.mkdirSync(path.join(v3Abs, path.dirname(a.path)), { recursive: true }); fs.copyFileSync(src, path.join(v3Abs, a.path)); }
      }
      fs.writeFileSync(path.join(v3Abs, 'snapshot.json'), storedBytes);
      fs.writeFileSync(path.join(v3Abs, 'manifest.json'), JSON.stringify(m, null, 2) + '\n');
      if (trusted.valid) declareValidPackage(V3_DIR);
      else declareRefusedPackage(V3_DIR, trusted.reason);
      return m;
    };
    const v3GzipManifest = writeV3('gzip', undefined, V3_VALID);
    const v3GzipInspect = await inspector.inspectPackage({ packagePath: V3_REL });
    const gzipStored = fs.readFileSync(path.join(v3Abs, 'snapshot.json'));
    writeV3('identity', undefined, V3_VALID);
    const v3IdentityInspect = await inspector.inspectPackage({ packagePath: V3_REL });
    /* Negative: valid physical descriptor over a corrupted gzip stream. */
    const corrupt = Buffer.from(zlib.gzipSync(v3LogicalBytes)); corrupt[Math.floor(corrupt.length / 2)] ^= 0xff;
    writeV3('gzip', corrupt, V3_REFUSED_CORRUPT);
    const v3CorruptInspect = await inspector.inspectPackage({ packagePath: V3_REL });

    /* ── M03 T04 Importer: v3 gzip / identity import + no-mutation negatives ──
     * State-integrity: every negative case captures counts() and writes.length
     * before the attempt and asserts both are unchanged afterwards, so a refusal
     * is proven to occur BEFORE any persistent import mutation. */
    const importSnapshotState = () => ({ counts: counts(), writes: writes.length });
    const importedRows = (r) => {
      const sid = r && r.recovered && r.recovered.newSnapshotId;
      if (!sid) return null;
      const snap = db.prepare('SELECT chat_id, title, message_count FROM snapshots WHERE id=?').get(sid);
      const turns = db.prepare('SELECT turn_idx, role, text, outer_html FROM snapshot_turns WHERE snapshot_id=? ORDER BY turn_idx').all(sid);
      return { title: snap && snap.title, messageCount: snap && snap.message_count, turns };
    };

    writeV3('gzip', undefined, V3_VALID);
    const v3GzipPre = importSnapshotState();
    const v3GzipImport = await importer.importVerifiedPackage({ packagePath: V3_REL, mode: 'import-as-new' });
    const v3GzipRows = importedRows(v3GzipImport);

    writeV3('identity', undefined, V3_VALID);
    const v3IdImport = await importer.importVerifiedPackage({ packagePath: V3_REL, mode: 'import-as-new' });
    const v3IdRows = importedRows(v3IdImport);

    /* Negative matrix — each must refuse with zero persistent mutation. */
    const gzipBase = zlib.gzipSync(v3LogicalBytes);
    const negCases = [
      ['corrupt gzip', () => { const c = Buffer.from(gzipBase); c[Math.floor(c.length / 2)] ^= 0xff; writeV3('gzip', c, V3_REFUSED_CORRUPT); }],
      ['truncated gzip', () => writeV3('gzip', Buffer.from(gzipBase.subarray(0, Math.max(1, gzipBase.length - 6))), V3_REFUSED_CORRUPT)],
      ['physical sha mismatch', () => { writeV3('gzip', undefined, V3_REFUSED_CORRUPT); const mp = path.join(v3Abs, 'manifest.json'); const m = JSON.parse(fs.readFileSync(mp, 'utf8')); m.files.snapshot.sha256 = 'sha256-' + '1'.repeat(64); fs.writeFileSync(mp, JSON.stringify(m, null, 2) + '\n'); }],
      ['physical byteLength mismatch', () => { writeV3('gzip', undefined, V3_REFUSED_CORRUPT); const mp = path.join(v3Abs, 'manifest.json'); const m = JSON.parse(fs.readFileSync(mp, 'utf8')); m.files.snapshot.byteLength = 999999; fs.writeFileSync(mp, JSON.stringify(m, null, 2) + '\n'); }],
      ['logical sha mismatch', () => { writeV3('gzip', undefined, V3_REFUSED_CORRUPT); const mp = path.join(v3Abs, 'manifest.json'); const m = JSON.parse(fs.readFileSync(mp, 'utf8')); m.files.snapshot.contentSha256 = 'sha256-' + '2'.repeat(64); fs.writeFileSync(mp, JSON.stringify(m, null, 2) + '\n'); }],
      ['logical length below actual (bomb guard)', () => { writeV3('gzip', undefined, V3_REFUSED_CORRUPT); const mp = path.join(v3Abs, 'manifest.json'); const m = JSON.parse(fs.readFileSync(mp, 'utf8')); m.files.snapshot.contentByteLength = m.files.snapshot.contentByteLength - 1; fs.writeFileSync(mp, JSON.stringify(m, null, 2) + '\n'); }],
      ['unsupported encoding', () => { writeV3('gzip', undefined, V3_REFUSED_CORRUPT); const mp = path.join(v3Abs, 'manifest.json'); const m = JSON.parse(fs.readFileSync(mp, 'utf8')); m.files.snapshot.encoding = 'deflate'; fs.writeFileSync(mp, JSON.stringify(m, null, 2) + '\n'); }],
      ['malformed logical JSON', () => { const bad = Buffer.from('{ not json'); writeV3('gzip', zlib.gzipSync(bad), V3_REFUSED_CORRUPT); const mp = path.join(v3Abs, 'manifest.json'); const m = JSON.parse(fs.readFileSync(mp, 'utf8')); const gz = fs.readFileSync(path.join(v3Abs, 'snapshot.json')); m.files.snapshot.sha256 = 'sha256-' + crypto.createHash('sha256').update(gz).digest('hex'); m.files.snapshot.byteLength = gz.length; m.files.snapshot.contentSha256 = 'sha256-' + crypto.createHash('sha256').update(bad).digest('hex'); m.files.snapshot.contentByteLength = bad.length; fs.writeFileSync(mp, JSON.stringify(m, null, 2) + '\n'); }],
    ];
    const v3Negatives = [];
    for (const [label, build] of negCases) {
      build();
      const pre = importSnapshotState();
      let res = null, threw = null;
      try { res = await importer.importVerifiedPackage({ packagePath: V3_REL, mode: 'import-as-new' }); }
      catch (e) { threw = String((e && e.message) || e); }
      const post = importSnapshotState();
      v3Negatives.push({
        label,
        status: res && res.status,
        threw,
        mutated: JSON.stringify(pre.counts) !== JSON.stringify(post.counts),
        writeDelta: post.writes - pre.writes,
      });
    }

    /* ── M03 T04 Relink: v3 gzip / identity + zero-mutation negatives ─────────
     * Runs BEFORE the v3 Restore block on purpose: Restore inserts the fixture's
     * ORIGINAL snapshotId, which would then make relink refuse with
     * snapshot-belongs-to-other-chat. Here the original id is still absent, so
     * the real relink-ready path is exercised. */
    const V3_RELINK_TARGET = 'v3-relink-target-chat';
    db.prepare('INSERT INTO chats (id, title, meta_json) VALUES (?, ?, ?)').run(V3_RELINK_TARGET, 'V3 relink target', '{}');
    const v3RelinkToken = 'RELINK:' + V3_RELINK_TARGET;
    const v3RelinkTurnsOf = (snapId) => snapId
      ? db.prepare('SELECT turn_idx, role, text, outer_html FROM snapshot_turns WHERE snapshot_id=? ORDER BY turn_idx').all(snapId)
      : [];

    writeV3('gzip', undefined, V3_VALID);
    const v3RelinkGzip = await relink.relinkVerifiedPackage({ packagePath: V3_REL, targetChatId: V3_RELINK_TARGET, confirm: v3RelinkToken });
    const v3RelinkNewSnapId = v3RelinkGzip.relinked && v3RelinkGzip.relinked.newSnapshotId;
    const v3RelinkNewSnapRow = v3RelinkNewSnapId ? db.prepare('SELECT id, chat_id, message_count FROM snapshots WHERE id=?').get(v3RelinkNewSnapId) : null;
    const v3RelinkRows = { snap: v3RelinkNewSnapRow, turns: v3RelinkTurnsOf(v3RelinkNewSnapId) };
    /* Representation-independent expectation via the shared product mapping. */
    const v3RelinkExpectedTurns = importer.buildTurnsFromPackageSnapshot(JSON.parse(v3LogicalBytes.toString('utf8')));
    /* The package's ORIGINAL snapshot must not have been inserted by relink. */
    const v3RelinkOriginalSnapId = JSON.parse(v3LogicalBytes.toString('utf8')).snapshotId;
    const v3RelinkOriginalAbsent = !db.prepare('SELECT id FROM snapshots WHERE id=?').get(v3RelinkOriginalSnapId);

    writeV3('identity', undefined, V3_VALID);
    const v3RelinkIdentityAgain = await relink.relinkVerifiedPackage({ packagePath: V3_REL, targetChatId: V3_RELINK_TARGET, confirm: v3RelinkToken });

    const v3RelinkNegatives = [];
    for (const [label, build] of negCases) {
      build();
      const pre = importSnapshotState();
      let res = null, threw = null;
      try { res = await relink.relinkVerifiedPackage({ packagePath: V3_REL, targetChatId: V3_RELINK_TARGET, confirm: v3RelinkToken }); }
      catch (e) { threw = String((e && e.message) || e); }
      const post = importSnapshotState();
      v3RelinkNegatives.push({
        label,
        status: res && res.status,
        threw,
        mutated: JSON.stringify(pre.counts) !== JSON.stringify(post.counts),
        writeDelta: post.writes - pre.writes,
      });
    }

    /* ── M03 T04 Restore: v3 gzip / identity + zero-mutation negatives ────────
     * Restore reuses the package's ORIGINAL chatId/snapshotId with absent-only
     * insert semantics, so the gzip variant is restored first and the identity
     * variant of the SAME logical package must then be refused as a conflict —
     * which exercises the real state-authority rules rather than bypassing them. */
    const v3RestorePre = importSnapshotState();
    writeV3('gzip', undefined, V3_VALID);
    const v3RestoreGzip = await restore.restoreVerifiedPackage({ packagePath: V3_REL, mode: 'restore-original-ids', confirm: true });
    const v3RestoredSnapId = JSON.parse(v3LogicalBytes.toString('utf8')).snapshotId;
    const v3RestoredRows = (() => {
      const snap = db.prepare('SELECT id, chat_id, message_count FROM snapshots WHERE id=?').get(v3RestoredSnapId);
      const turns = db.prepare('SELECT turn_idx, role, text, outer_html FROM snapshot_turns WHERE snapshot_id=? ORDER BY turn_idx').all(v3RestoredSnapId);
      return snap ? { chatId: snap.chat_id, messageCount: snap.message_count, turns } : null;
    })();
    /* Representation-independent expectation: the turns the plaintext payload
     * defines, computed through the same shared mapping the product uses. */
    const v3ExpectedTurns = importer.buildTurnsFromPackageSnapshot(JSON.parse(v3LogicalBytes.toString('utf8')));

    writeV3('identity', undefined, V3_VALID);
    const v3RestoreIdentityConflict = await restore.restoreVerifiedPackage({ packagePath: V3_REL, mode: 'restore-original-ids', confirm: true });

    const v3RestoreNegatives = [];
    for (const [label, build] of negCases) {
      build();
      const pre = importSnapshotState();
      let res = null, threw = null;
      try { res = await restore.restoreVerifiedPackage({ packagePath: V3_REL, mode: 'restore-original-ids', confirm: true }); }
      catch (e) { threw = String((e && e.message) || e); }
      const post = importSnapshotState();
      v3RestoreNegatives.push({
        label,
        status: res && res.status,
        threw,
        mutated: JSON.stringify(pre.counts) !== JSON.stringify(post.counts),
        writeDelta: post.writes - pre.writes,
      });
    }
    fs.rmSync(v3Abs, { recursive: true, force: true });

    const before = counts();
    const srcChatSig = rowSig('chats', SRC_CHAT), srcSnapSig = rowSig('snapshots', SRC_SNAP);
    const readyDir = path.join(pkgRoot, 'i-harness-import-ready-chat.h2ochat');
    const readyFilesBefore = dirSig(readyDir);

    // import-ready path
    const insp = await inspector.inspectPackage({ packagePath: READY_REL });
    const w0 = writes.length;
    const dry = await importer.dryRunImportPackage({ packagePath: READY_REL });
    const dryWrites = writes.length - w0;
    const imp = await importer.importVerifiedPackage({ packagePath: READY_REL, mode: 'import-as-new' });
    const after = counts();
    const importWrites = writes.slice(w0 + dryWrites);

    const newSnapId = imp.recovered && imp.recovered.newSnapshotId;
    const newSnapRow = newSnapId ? db.prepare('SELECT id, chat_id, message_count, meta_json FROM snapshots WHERE id=?').get(newSnapId) : null;
    const newChatRow = imp.recovered && imp.recovered.newChatId ? db.prepare('SELECT id, title FROM chats WHERE id=?').get(imp.recovered.newChatId) : null;
    const newTurns = newSnapId ? db.prepare('SELECT count(*) c FROM snapshot_turns WHERE snapshot_id=?').get(newSnapId).c : 0;
    const prov = newSnapRow ? (JSON.parse(newSnapRow.meta_json || '{}').recovered || {}) : {};

    // already-imported path (source fixture, original ids seeded)
    const wAI = writes.length;
    const dryAI = await importer.dryRunImportPackage({ packagePath: SRC_REL });
    const impAI = await importer.importVerifiedPackage({ packagePath: SRC_REL, mode: 'import-as-new' });
    const aiWrites = writes.length - wAI;

    // K.3 restore-original-ids harness cases.
    const restoreRel = (info) => 'archive/packages/' + info.chat + '.h2ochat';
    const countTurnsFor = (snapId) => db.prepare('SELECT count(*) c FROM snapshot_turns WHERE snapshot_id=?').get(snapId).c;
    const getChat = (chatId) => db.prepare('SELECT * FROM chats WHERE id=?').get(chatId);
    const getSnap = (snapId) => db.prepare('SELECT * FROM snapshots WHERE id=?').get(snapId);
    const restoreBefore = counts();
    const restoreReadyDir = path.join(pkgRoot, restorePackages.ready.chat + '.h2ochat');
    const restoreReadyFilesBefore = dirSig(restoreReadyDir);
    const wRestoreReady = writes.length;
    const restoreReadyDry = await restore.dryRunRestorePackage({ packagePath: restoreRel(restorePackages.ready) });
    const restoreReadyDryWrites = writes.length - wRestoreReady;
    const restoreAction = await restore.restoreVerifiedPackage({ packagePath: restoreRel(restorePackages.ready), mode: 'restore-original-ids', confirm: true });
    const restoreReadyWrites = writes.slice(wRestoreReady + restoreReadyDryWrites);
    const restoreAfter = counts();
    const restoredChat = getChat(restorePackages.ready.chat);
    const restoredSnap = getSnap(restorePackages.ready.snap);
    const restoredTurns = countTurnsFor(restorePackages.ready.snap);
    const restoredChatMeta = restoredChat ? JSON.parse(restoredChat.meta_json || '{}') : {};
    const restoredSnapMeta = restoredSnap ? JSON.parse(restoredSnap.meta_json || '{}') : {};
    const restoreReadyFilesAfter = dirSig(restoreReadyDir);

    const wAlready = writes.length;
    const restoreAlready = await restore.restoreVerifiedPackage({ packagePath: restoreRel(restorePackages.ready), mode: 'restore-original-ids', confirm: true });
    const restoreAlreadyWrites = writes.length - wAlready;

    const confirmBefore = counts();
    const wConfirm = writes.length;
    const restoreConfirm = await restore.restoreVerifiedPackage({ packagePath: restoreRel(restorePackages.confirm), mode: 'restore-original-ids', confirm: false });
    const confirmAfter = counts();
    const confirmWrites = writes.length - wConfirm;

    db.prepare('INSERT INTO snapshots (id, chat_id, title, digest, message_count, meta_json) VALUES (?, ?, ?, ?, ?, ?)')
      .run(restorePackages.conflictSnap.snap, 'different-chat-for-conflict', 'Conflicting snapshot', 'different-digest', 0, '{}');
    const conflictSnapBefore = counts();
    const wConflictSnap = writes.length;
    const conflictSnapDry = await restore.dryRunRestorePackage({ packagePath: restoreRel(restorePackages.conflictSnap) });
    const conflictSnapAction = await restore.restoreVerifiedPackage({ packagePath: restoreRel(restorePackages.conflictSnap), mode: 'restore-original-ids', confirm: true });
    const conflictSnapAfter = counts();
    const conflictSnapWrites = writes.length - wConflictSnap;

    db.prepare('INSERT INTO chats (id, title, meta_json) VALUES (?, ?, ?)').run(restorePackages.conflictChat.chat, 'Existing conflict chat', '{}');
    const conflictChatBefore = counts();
    const wConflictChat = writes.length;
    const conflictChatDry = await restore.dryRunRestorePackage({ packagePath: restoreRel(restorePackages.conflictChat) });
    const conflictChatAction = await restore.restoreVerifiedPackage({ packagePath: restoreRel(restorePackages.conflictChat), mode: 'restore-original-ids', confirm: true });
    const conflictChatAfter = counts();
    const conflictChatWrites = writes.length - wConflictChat;

    db.prepare('INSERT INTO sync_tombstones (tombstone_id, record_kind, record_id, deleted_at, deleted_by_sync_peer_id, delete_reason, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run('tombstone-' + restorePackages.tombstoned.chat, 'chat', restorePackages.tombstoned.chat, '2026-06-24T00:00:00.000Z', 'k3-harness', 'restore-test', '2026-06-24T00:00:00.000Z', '2026-06-24T00:00:00.000Z');
    const tombstoneBefore = counts();
    const tombstoneRowBefore = db.prepare('SELECT * FROM sync_tombstones WHERE record_id=?').get(restorePackages.tombstoned.chat);
    const tombstoneSigBefore = crypto.createHash('sha256').update(JSON.stringify(tombstoneRowBefore)).digest('hex');
    const wTombstone = writes.length;
    const tombstoneDry = await restore.dryRunRestorePackage({ packagePath: restoreRel(restorePackages.tombstoned) });
    const tombstoneAction = await restore.restoreVerifiedPackage({ packagePath: restoreRel(restorePackages.tombstoned), mode: 'restore-original-ids', confirm: true });
    const tombstoneAfter = counts();
    const tombstoneWrites = writes.length - wTombstone;
    const tombstoneRowAfter = db.prepare('SELECT * FROM sync_tombstones WHERE record_id=?').get(restorePackages.tombstoned.chat);
    const tombstoneSigAfter = crypto.createHash('sha256').update(JSON.stringify(tombstoneRowAfter)).digest('hex');

    // K.4.3 relink harness cases.
    const relinkRel = (info) => 'archive/packages/' + info.chat + '.h2ochat';
    const RELINK_TARGET = 'k4-relink-target-chat';
    const RELINK_OLD_SNAP = 'snap_k4_relink_old';
    const RELINK_DELETED_TARGET = 'k4-relink-deleted-target';
    const RELINK_TOMBSTONED_TARGET = 'k4-relink-tombstoned-target';
    const RELINK_CONFLICT_TARGET = 'k4-relink-conflict-target';
    const oldChatMeta = {
      existing: true,
      folderBindingWitness: 'folder-k4',
      labelsWitness: ['label-a', 'label-b'],
    };
    db.prepare('INSERT INTO chats (id, title, created_at, updated_at, last_message_at, message_count, is_saved, is_linked, link_source_href, href, normalized_href, folder_id, category_id, project_id, current_leaf_id, meta_json, snapshot_count, last_snapshot_id, last_captured_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(RELINK_TARGET, 'K4 target chat', 1000, 1000, 1000, 1, 1, 1, 'https://source.example/chat', 'https://target.example/chat', 'https://target.example/chat', 'folder-k4', '', 'project-k4', RELINK_OLD_SNAP, JSON.stringify(oldChatMeta), 1, RELINK_OLD_SNAP, 1000);
    db.prepare('INSERT INTO snapshots (id, chat_id, title, digest, message_count, captured_at, updated_at, meta_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(RELINK_OLD_SNAP, RELINK_TARGET, 'K4 old snapshot', 'sha256-old-k4-relink', 1, 1000, 1000, JSON.stringify({ old: true }));
    db.prepare('INSERT INTO snapshot_turns (snapshot_id, turn_idx, role, outer_html, text, meta_json) VALUES (?, ?, ?, ?, ?, ?)')
      .run(RELINK_OLD_SNAP, 0, 'assistant', '<p>old</p>', 'old', JSON.stringify({ old: true }));
    db.prepare('INSERT INTO chats (id, title, is_deleted, meta_json) VALUES (?, ?, ?, ?)').run(RELINK_DELETED_TARGET, 'Deleted relink target', 1, '{}');
    db.prepare('INSERT INTO chats (id, title, meta_json) VALUES (?, ?, ?)').run(RELINK_TOMBSTONED_TARGET, 'Tombstoned relink target', '{}');
    db.prepare('INSERT INTO sync_tombstones (tombstone_id, record_kind, record_id, deleted_at, deleted_by_sync_peer_id, delete_reason, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run('tombstone-' + RELINK_TOMBSTONED_TARGET, 'chat', RELINK_TOMBSTONED_TARGET, '2026-06-24T00:00:00.000Z', 'k4-harness', 'relink-test', '2026-06-24T00:00:00.000Z', '2026-06-24T00:00:00.000Z');
    db.prepare('INSERT INTO chats (id, title, meta_json) VALUES (?, ?, ?)').run(RELINK_CONFLICT_TARGET, 'Conflict relink target', '{}');
    db.prepare('INSERT INTO chats (id, title, meta_json) VALUES (?, ?, ?)').run('k4-relink-other-chat', 'Other chat owning original snapshot', '{}');
    db.prepare('INSERT INTO snapshots (id, chat_id, title, digest, message_count, meta_json) VALUES (?, ?, ?, ?, ?, ?)')
      .run(relinkPackages.conflict.snap, 'k4-relink-other-chat', 'Original snapshot belongs elsewhere', 'sha256-conflict-original', 0, '{}');

    const relinkPackageDir = path.join(pkgRoot, relinkPackages.ready.chat + '.h2ochat');
    const relinkPackageSigBefore = dirSig(relinkPackageDir);
    const relinkTargetBefore = db.prepare('SELECT * FROM chats WHERE id=?').get(RELINK_TARGET);
    const relinkTargetBeforeSig = crypto.createHash('sha256').update(JSON.stringify(relinkTargetBefore)).digest('hex');
    const relinkOldSnapBefore = db.prepare('SELECT * FROM snapshots WHERE id=?').get(RELINK_OLD_SNAP);
    const relinkOldTurnsBefore = db.prepare('SELECT * FROM snapshot_turns WHERE snapshot_id=? ORDER BY turn_idx').all(RELINK_OLD_SNAP).map(normRow);
    const relinkOldSnapSigBefore = crypto.createHash('sha256').update(JSON.stringify(relinkOldSnapBefore)).digest('hex');
    const relinkOldTurnsSigBefore = crypto.createHash('sha256').update(JSON.stringify(relinkOldTurnsBefore)).digest('hex');
    const relinkBefore = counts();
    const wRelinkReady = writes.length;
    const relinkDry = await relink.dryRunRelinkPackage({ packagePath: relinkRel(relinkPackages.ready), targetChatId: RELINK_TARGET });
    const relinkDryWrites = writes.length - wRelinkReady;
    const wConfirmBool = writes.length;
    const relinkConfirmBool = await relink.relinkVerifiedPackage({ packagePath: relinkRel(relinkPackages.ready), targetChatId: RELINK_TARGET, confirm: true });
    const relinkConfirmBoolWrites = writes.length - wConfirmBool;
    const wConfirmWrong = writes.length;
    const relinkConfirmWrong = await relink.relinkVerifiedPackage({ packagePath: relinkRel(relinkPackages.ready), targetChatId: RELINK_TARGET, confirm: 'wrong-token' });
    const relinkConfirmWrongWrites = writes.length - wConfirmWrong;
    const wRelinkAction = writes.length;
    const relinkAction = await relink.relinkVerifiedPackage({ packagePath: relinkRel(relinkPackages.ready), targetChatId: RELINK_TARGET, confirm: 'RELINK:' + RELINK_TARGET });
    const relinkSuccessWrites = writes.slice(wRelinkAction);
    const relinkAfter = counts();
    const relinked = relinkAction.relinked || {};
    const relinkNewSnapId = relinked.newSnapshotId;
    const relinkNewSnap = relinkNewSnapId ? db.prepare('SELECT * FROM snapshots WHERE id=?').get(relinkNewSnapId) : null;
    const relinkNewTurns = relinkNewSnapId ? db.prepare('SELECT * FROM snapshot_turns WHERE snapshot_id=? ORDER BY turn_idx').all(relinkNewSnapId).map(normRow) : [];
    const relinkTargetAfter = db.prepare('SELECT * FROM chats WHERE id=?').get(RELINK_TARGET);
    const relinkTargetMeta = relinkTargetAfter ? JSON.parse(relinkTargetAfter.meta_json || '{}') : {};
    const relinkProv = relinkTargetMeta.relinked || {};
    const relinkOldSnapAfter = db.prepare('SELECT * FROM snapshots WHERE id=?').get(RELINK_OLD_SNAP);
    const relinkOldTurnsAfter = db.prepare('SELECT * FROM snapshot_turns WHERE snapshot_id=? ORDER BY turn_idx').all(RELINK_OLD_SNAP).map(normRow);
    const relinkOldSnapSigAfter = crypto.createHash('sha256').update(JSON.stringify(relinkOldSnapAfter)).digest('hex');
    const relinkOldTurnsSigAfter = crypto.createHash('sha256').update(JSON.stringify(relinkOldTurnsAfter)).digest('hex');
    const relinkPackageSigAfter = dirSig(relinkPackageDir);
    const wRelinkAlready = writes.length;
    const relinkAlreadyDry = await relink.dryRunRelinkPackage({ packagePath: relinkRel(relinkPackages.ready), targetChatId: RELINK_TARGET });
    const relinkAlreadyAction = await relink.relinkVerifiedPackage({ packagePath: relinkRel(relinkPackages.ready), targetChatId: RELINK_TARGET, confirm: 'RELINK:' + RELINK_TARGET });
    const relinkAlreadyWrites = writes.length - wRelinkAlready;
    const relinkMissingBefore = counts();
    const wRelinkMissing = writes.length;
    const relinkMissingDry = await relink.dryRunRelinkPackage({ packagePath: relinkRel(relinkPackages.ready), targetChatId: 'missing-k4-relink-target' });
    const relinkMissingAction = await relink.relinkVerifiedPackage({ packagePath: relinkRel(relinkPackages.ready), targetChatId: 'missing-k4-relink-target', confirm: 'RELINK:missing-k4-relink-target' });
    const relinkMissingAfter = counts();
    const relinkMissingWrites = writes.length - wRelinkMissing;
    const relinkDeletedBefore = counts();
    const wRelinkDeleted = writes.length;
    const relinkDeletedDry = await relink.dryRunRelinkPackage({ packagePath: relinkRel(relinkPackages.deleted), targetChatId: RELINK_DELETED_TARGET });
    const relinkDeletedAction = await relink.relinkVerifiedPackage({ packagePath: relinkRel(relinkPackages.deleted), targetChatId: RELINK_DELETED_TARGET, confirm: 'RELINK:' + RELINK_DELETED_TARGET });
    const relinkDeletedAfter = counts();
    const relinkDeletedWrites = writes.length - wRelinkDeleted;
    const relinkTombstoneBefore = counts();
    const relinkTombstoneRowBefore = db.prepare('SELECT * FROM sync_tombstones WHERE record_id=?').get(RELINK_TOMBSTONED_TARGET);
    const relinkTombstoneSigBefore = crypto.createHash('sha256').update(JSON.stringify(relinkTombstoneRowBefore)).digest('hex');
    const wRelinkTombstone = writes.length;
    const relinkTombstoneDry = await relink.dryRunRelinkPackage({ packagePath: relinkRel(relinkPackages.tombstoned), targetChatId: RELINK_TOMBSTONED_TARGET });
    const relinkTombstoneAction = await relink.relinkVerifiedPackage({ packagePath: relinkRel(relinkPackages.tombstoned), targetChatId: RELINK_TOMBSTONED_TARGET, confirm: 'RELINK:' + RELINK_TOMBSTONED_TARGET });
    const relinkTombstoneAfter = counts();
    const relinkTombstoneWrites = writes.length - wRelinkTombstone;
    const relinkTombstoneRowAfter = db.prepare('SELECT * FROM sync_tombstones WHERE record_id=?').get(RELINK_TOMBSTONED_TARGET);
    const relinkTombstoneSigAfter = crypto.createHash('sha256').update(JSON.stringify(relinkTombstoneRowAfter)).digest('hex');
    const relinkConflictBefore = counts();
    const wRelinkConflict = writes.length;
    const relinkConflictDry = await relink.dryRunRelinkPackage({ packagePath: relinkRel(relinkPackages.conflict), targetChatId: RELINK_CONFLICT_TARGET });
    const relinkConflictAction = await relink.relinkVerifiedPackage({ packagePath: relinkRel(relinkPackages.conflict), targetChatId: RELINK_CONFLICT_TARGET, confirm: 'RELINK:' + RELINK_CONFLICT_TARGET });
    const relinkConflictAfter = counts();
    const relinkConflictWrites = writes.length - wRelinkConflict;
    const relinkTargetUnchangedFields = ['is_saved', 'is_linked', 'link_source_href', 'href', 'normalized_href', 'folder_id', 'category_id', 'project_id', 'title']
      .every((k) => String(relinkTargetBefore[k] == null ? '' : relinkTargetBefore[k]) === String(relinkTargetAfter[k] == null ? '' : relinkTargetAfter[k]));
    const relinkOldSnapshotStillExists = !!db.prepare('SELECT id FROM snapshots WHERE id=?').get(RELINK_OLD_SNAP);
    const relinkOldTurnCount = countTurnsFor(RELINK_OLD_SNAP);

    /* Proofs 11–13: same chat, two packages, explicit path each time. */
    const sibRel = (info) => 'archive/packages/' + info.dir;
    const wSib = writes.length;
    const sibling = {};
    for (const key of ['a', 'b']) {
      const info = siblingPackages[key];
      sibling[key] = {
        dir: info.dir,
        expectedSnap: info.snap,
        importDry: await importer.dryRunImportPackage({ packagePath: sibRel(info) }),
        restoreDry: await restore.dryRunRestorePackage({ packagePath: sibRel(info) }),
        relinkDry: await relink.dryRunRelinkPackage({ packagePath: sibRel(info), targetChatId: RELINK_TARGET }),
      };
    }
    const siblingWrites = writes.length - wSib;

    /* ══ G01 — DURABLE ARCHIVE-RECOVERY BINDING PROOFS ═══════════════════════
     * Permanent behavioural coverage for the archive-path read binding. Every
     * case drives the REAL importer and restore modules through their real
     * public entry points — dry-run AND execution — and records the decision,
     * the execution status, the write count, the row delta, whether any
     * substituted byte reached a write payload, and whether the snapshot member
     * was read at all. Nothing here asserts source text and nothing asserts a
     * helper's return value.
     *
     * THE ORDER IS THE POINT. Each package is written with ALPHA bytes and
     * DECLARED — the trusted occupant's member measurements are taken from the
     * ALPHA bytes at that moment, exactly as the real scanner measures the
     * member it examined. Only afterwards are BETA bytes written, and the
     * declaration is deliberately NOT refreshed. The trusted facts then
     * describe a package state that no longer exists on disk: the TOCTOU window
     * a package read after its trusted ruling must never be allowed to close
     * for itself.
     *
     * Every substituted package is INTERNALLY COHERENT unless its case says
     * otherwise — it restates its own manifest for the bytes it now holds — so
     * no refusal here can be explained by the package merely disagreeing with
     * itself. */
    const BETA_MARK = 'BETA-ATTACKER-CONTENT';
    const ALPHA_V1_TEXT = 'Deterministic fixture reply. No real user data.';
    const ALPHA_V3_TEXT = 'Second synthetic fixture turn.';
    const betaOfLength = (n) => (BETA_MARK + ' substituted after the trusted ruling.' + ' '.repeat(Math.max(0, n))).slice(0, n);
    assert.ok(betaOfLength(ALPHA_V1_TEXT.length).includes(BETA_MARK) && betaOfLength(ALPHA_V3_TEXT.length).includes(BETA_MARK),
      'BETA substitution text must stay detectable at every fixture length');

    const g01Dir = (key) => 'g01-' + key + '.h2ochat';
    const g01Rel = (key) => ARCHIVE_PREFIX + g01Dir(key);
    const g01ChatId = (key) => 'g01-' + key + '-chat';
    const g01SnapId = (key) => 'snap_g01_' + key.replace(/-/g, '_');

    /* ALPHA v1/v2 package through the EXISTING fixture generator, then declared. */
    const stageV1Alpha = (key) => {
      generateConflictFreeFixture(srcAbs, path.join(pkgRoot, g01Dir(key)), g01ChatId(key), g01SnapId(key));
      declareValidPackage(g01Dir(key));
      return { key: key, dir: g01Dir(key), rel: g01Rel(key), chatId: g01ChatId(key), snapId: g01SnapId(key), family: 'v1' };
    };

    /* ALPHA v3 package (identity or gzip) at its own directory, reusing the
     * committed v3 fixture bytes and the same id-rewrite technique the v1
     * generator uses. Fresh ids are required: the v3 block above already
     * restored the committed fixture's ORIGINAL ids, so a control reusing them
     * would return already-present instead of exercising the success path. */
    const stageV3Alpha = (key, encoding) => {
      const dir = g01Dir(key), abs = path.join(pkgRoot, dir);
      const chatId = g01ChatId(key), snapId = g01SnapId(key);
      fs.rmSync(abs, { recursive: true, force: true });
      fs.mkdirSync(abs, { recursive: true });
      const logical = Buffer.from(v3LogicalBytes.toString('utf8')
        .split(v3BaseManifest.chatId).join(chatId)
        .split(v3BaseManifest.snapshotId).join(snapId), 'utf8');
      const stored = encoding === 'gzip' ? zlib.gzipSync(logical) : logical;
      const m = JSON.parse(JSON.stringify(v3BaseManifest));
      m.chatId = chatId; m.snapshotId = snapId; m.contentHash = sha256Pfx(logical);
      const d = { path: 'snapshot.json', sha256: sha256Pfx(stored), byteLength: stored.length, encoding: encoding };
      if (encoding === 'gzip') { d.contentSha256 = sha256Pfx(logical); d.contentByteLength = logical.length; }
      m.files = Object.assign({}, m.files, { snapshot: d });
      for (const a of (m.assets || [])) {
        const src = path.join(v3Src, a.path);
        if (fs.existsSync(src)) { fs.mkdirSync(path.join(abs, path.dirname(a.path)), { recursive: true }); fs.copyFileSync(src, path.join(abs, a.path)); }
      }
      fs.writeFileSync(path.join(abs, 'snapshot.json'), stored);
      fs.writeFileSync(path.join(abs, 'manifest.json'), JSON.stringify(m, null, 2) + '\n');
      declareValidPackage(dir);
      return { key: key, dir: dir, rel: g01Rel(key), chatId: chatId, snapId: snapId, family: 'v3', encoding: encoding, logical: logical };
    };

    /* Substitute BETA bytes into an ALREADY-DECLARED v1/v2 package. */
    const substituteV1Beta = (pkg, opts) => {
      const o = opts || {};
      const snapAbs = path.join(pkgRoot, pkg.dir, 'snapshot.json');
      const alphaText = fs.readFileSync(snapAbs, 'utf8');
      const alphaLen = fs.statSync(snapAbs).size;
      const replacement = o.sameLength
        ? betaOfLength(ALPHA_V1_TEXT.length)
        : betaOfLength(ALPHA_V1_TEXT.length) + ' Extra bytes so the physical LENGTH differs too.';
      const betaBytes = Buffer.from(alphaText.split(ALPHA_V1_TEXT).join(replacement), 'utf8');
      assert.ok(betaBytes.toString('utf8') !== alphaText, 'BETA substitution changed nothing in ' + pkg.dir);
      fs.writeFileSync(snapAbs, betaBytes);
      if (!o.copyClaim) {
        const mp = path.join(pkgRoot, pkg.dir, 'manifest.json');
        const m = JSON.parse(fs.readFileSync(mp, 'utf8'));
        m.files.snapshot.sha256 = sha256Prefixed(betaBytes);
        m.files.snapshot.byteLength = betaBytes.length;
        m.contentHash = sha256Prefixed(betaBytes);
        fs.writeFileSync(mp, JSON.stringify(m, null, 2) + '\n');
      }
      return { alphaByteLength: alphaLen, betaByteLength: betaBytes.length };
    };

    /* Substitute BETA bytes into an ALREADY-DECLARED v3 package. The BETA
     * logical payload is the same physical size as ALPHA, so for the identity
     * representation only the digest can distinguish them. */
    const substituteV3Beta = (pkg, opts) => {
      const o = opts || {};
      const abs = path.join(pkgRoot, pkg.dir);
      const betaLogical = Buffer.from(pkg.logical.toString('utf8')
        .split(ALPHA_V3_TEXT).join(betaOfLength(ALPHA_V3_TEXT.length)), 'utf8');
      assert.ok(betaLogical.toString('utf8') !== pkg.logical.toString('utf8'), 'BETA v3 substitution changed nothing in ' + pkg.dir);
      const betaStored = pkg.encoding === 'gzip' ? zlib.gzipSync(betaLogical) : betaLogical;
      fs.writeFileSync(path.join(abs, 'snapshot.json'), betaStored);
      const mp = path.join(abs, 'manifest.json');
      const m = JSON.parse(fs.readFileSync(mp, 'utf8'));
      if (o.claimSchemaVersion1) {
        /* Downgrade attempt: the substituted package claims a family that has
         * no governed logical descriptor at all. Only the TRUSTED family may
         * choose the read regime. */
        m.schemaVersion = 1; m.payloadVersion = 1;
        delete m.files.snapshot.encoding;
        delete m.files.snapshot.contentSha256;
        delete m.files.snapshot.contentByteLength;
      }
      if (o.dropDescriptor) delete m.files.snapshot;
      if (!o.copyClaim) {
        if (m.files && m.files.snapshot) {
          m.files.snapshot.sha256 = sha256Pfx(betaStored);
          m.files.snapshot.byteLength = betaStored.length;
          if (pkg.encoding === 'gzip' && !o.claimSchemaVersion1) {
            m.files.snapshot.contentSha256 = sha256Pfx(betaLogical);
            m.files.snapshot.contentByteLength = betaLogical.length;
          }
        }
        m.contentHash = sha256Pfx(betaLogical);
      }
      fs.writeFileSync(mp, JSON.stringify(m, null, 2) + '\n');
      return { alphaByteLength: pkg.encoding === 'gzip' ? zlib.gzipSync(pkg.logical).length : pkg.logical.length, betaByteLength: betaStored.length };
    };

    /* Declares what the trusted enumeration observed on each successive call.
     * The two trusted reads are INDEPENDENT native calls — odd calls are the
     * inspection read, even calls the binding read, and execution repeats the
     * pair at the write gate. Nothing guarantees the archive stood still
     * between them, so a scenario may declare each call separately. It is still
     * a declaration: the double discovers nothing and verifies nothing. */
    const withDeclarationPerCall = async (dir, factsForCall, run) => {
      const key = ARCHIVE_PREFIX + dir;
      const original = Object.assign({}, trustedDeclarations.get(key));
      integrityCallSeq = 0;
      onIntegrityCall = (n) => { trustedDeclarations.set(key, factsForCall(n, Object.assign({}, original))); };
      try { return await run(); }
      finally { onIntegrityCall = null; trustedDeclarations.set(key, original); }
    };
    const withoutField = (o, f) => { const c = Object.assign({}, o); delete c[f]; return c; };

    /* One observation shape for every case: real entry points, real counters. */
    const observeRecovery = async (pkg, op) => {
      const before = counts();
      const w0 = writes.length, p0 = sqlPayloads.length, r0 = fileReads.length, c0 = integrityCallSeq;
      let dry = null, exec = null;
      if (op === 'restore') {
        dry = await restore.dryRunRestorePackage({ packagePath: pkg.rel });
        exec = await restore.restoreVerifiedPackage({ packagePath: pkg.rel, mode: 'restore-original-ids', confirm: true });
      } else {
        dry = await importer.dryRunImportPackage({ packagePath: pkg.rel });
        exec = await importer.importVerifiedPackage({ packagePath: pkg.rel, mode: 'import-as-new' });
      }
      const after = counts();
      const payloads = sqlPayloads.slice(p0);
      const reads = fileReads.slice(r0);
      const recovered = (exec && (exec.recovered || exec.restored)) || null;
      return {
        key: pkg.key, op: op, family: pkg.family, encoding: pkg.encoding || 'identity',
        dryDecision: String((dry && dry.decision) || ''),
        execStatus: String((exec && exec.status) || ''),
        writes: writes.length - w0,
        delta: { chats: after.chats - before.chats, snapshots: after.snapshots - before.snapshots, turns: after.turns - before.turns },
        betaInWrites: payloads.some((p) => p.indexOf(BETA_MARK) >= 0),
        snapshotMemberReads: reads.filter((p) => p === pkg.rel + '/snapshot.json').length,
        recoveredId: recovered ? String(recovered.newSnapshotId || recovered.snapshotId || '') : '',
        originalIdsPresent: {
          chat: !!db.prepare('SELECT id FROM chats WHERE id=?').get(pkg.chatId),
          snapshot: !!db.prepare('SELECT id FROM snapshots WHERE id=?').get(pkg.snapId),
        },
        provenanceRows: db.prepare('SELECT count(*) c FROM snapshots WHERE meta_json LIKE ?').get('%' + pkg.snapId + '%').c,
        integrityCalls: integrityCallSeq - c0,
        dryRunCalled: !!dry, executionCalled: !!exec,
      };
    };

    const bindingCases = [];
    /* ── Substitution family: ALPHA declared, BETA written, no re-declaration ── */
    const substitutionSpecs = [
      { key: 'sub-v12', family: 'v1', label: 'v1/v2 substitution', build: (p) => substituteV1Beta(p, {}) },
      { key: 'sub-v12-samelen', family: 'v1', label: 'v1/v2 substitution at IDENTICAL physical byte length', sameLength: true, build: (p) => substituteV1Beta(p, { sameLength: true }) },
      { key: 'sub-v12-claim', family: 'v1', label: 'v1/v2 substitution keeping the ALPHA contentHash claim', build: (p) => substituteV1Beta(p, { copyClaim: true }) },
      { key: 'sub-v3-id', family: 'v3', encoding: 'identity', label: 'v3 identity substitution (coherent BETA manifest)', build: (p) => substituteV3Beta(p, {}) },
      { key: 'sub-v3-gz', family: 'v3', encoding: 'gzip', label: 'v3 gzip substitution (coherent BETA manifest + descriptor)', build: (p) => substituteV3Beta(p, {}) },
      { key: 'sub-v3-claim', family: 'v3', encoding: 'identity', label: 'v3 substitution keeping the ALPHA contentHash claim', build: (p) => substituteV3Beta(p, { copyClaim: true }) },
      { key: 'dgr-schema1', family: 'v3', encoding: 'identity', label: 'v3 substitution claiming schemaVersion 1 (downgrade)', downgrade: true, build: (p) => substituteV3Beta(p, { claimSchemaVersion1: true }) },
      { key: 'dgr-nodesc', family: 'v3', encoding: 'gzip', label: 'v3 substitution with the member descriptor removed (downgrade)', downgrade: true, build: (p) => substituteV3Beta(p, { dropDescriptor: true }) },
    ];
    for (const spec of substitutionSpecs) {
      for (const op of ['restore', 'import']) {
        const key = spec.key + '-' + (op === 'restore' ? 'r' : 'i');
        const pkg = spec.family === 'v3' ? stageV3Alpha(key, spec.encoding) : stageV1Alpha(key);
        const sizes = spec.build(pkg);
        const rec = await observeRecovery(pkg, op);
        bindingCases.push(Object.assign(rec, {
          group: spec.downgrade ? 'downgrade' : 'substitution',
          label: spec.label, sameLength: spec.sameLength === true,
          alphaByteLength: sizes.alphaByteLength, betaByteLength: sizes.betaByteLength,
        }));
      }
    }

    /* ── Identity-binding family: the package is VALID and untouched; only the
     * trusted identity available to each read varies. A build that ignored the
     * identity agreement would recover these packages normally. ── */
    const identitySpecs = [
      { key: 'idb-occ-absent', label: 'inspection identity present, binding occupant identity absent', facts: (n, base) => (n % 2 === 1 ? base : withoutField(base, 'contentHash')) },
      { key: 'idb-insp-absent', label: 'binding occupant identity present, inspection identity absent', facts: (n, base) => (n % 2 === 1 ? withoutField(base, 'contentHash') : base) },
      { key: 'idb-both-absent', label: 'BOTH trusted identities absent (two empty values must never bind)', facts: (n, base) => withoutField(base, 'contentHash') },
      { key: 'idb-disagree', label: 'the two trusted reads report different identities', facts: (n, base) => (n % 2 === 1 ? base : Object.assign({}, base, { contentHash: 'f'.repeat(64) })) },
    ];
    for (const spec of identitySpecs) {
      for (const op of ['restore', 'import']) {
        const key = spec.key + '-' + (op === 'restore' ? 'r' : 'i');
        const pkg = stageV1Alpha(key);
        const rec = await withDeclarationPerCall(pkg.dir, spec.facts, () => observeRecovery(pkg, op));
        bindingCases.push(Object.assign(rec, { group: 'identity', label: spec.label, sameLength: false }));
      }
    }

    /* ── Partial-anchor family: a VALID v3 package whose trusted occupant is
     * missing exactly one member measurement. Run on v3 on purpose — a build
     * that degraded instead of failing closed would fall through to the weaker
     * v1/v2 read, and these packages would recover normally.
     *
     * BOTH v3 representations are covered. A gzip-only matrix would be weak
     * evidence: a fall-through weak read of a gzip member fails to parse as
     * JSON and is refused for that unrelated reason, so the identity variant is
     * the one that can actually observe a downgraded read succeeding. ── */
    const anchorFields = ['snapshotPhysicalSha256', 'snapshotPhysicalByteLength', 'logicalSnapshotSha256', 'logicalSnapshotByteLength', 'snapshotEncoding'];
    for (const field of anchorFields) {
      for (const encoding of ['identity', 'gzip']) {
        for (const op of ['restore', 'import']) {
          const key = 'anc-' + field.toLowerCase().slice(0, 18) + '-' + (encoding === 'gzip' ? 'gz' : 'id') + '-' + (op === 'restore' ? 'r' : 'i');
          const pkg = stageV3Alpha(key, encoding);
          const rec = await withDeclarationPerCall(pkg.dir, (n, base) => withoutField(base, field), () => observeRecovery(pkg, op));
          bindingCases.push(Object.assign(rec, { group: 'anchors', label: 'trusted occupant missing ' + field + ' (' + encoding + ')', missingAnchor: field, sameLength: false }));
        }
      }
    }

    /* ── Valid controls: the same code path, nothing substituted, nothing
     * withheld. A refusal proof means nothing if the success path is
     * unreachable. ── */
    const controlSpecs = [
      { key: 'ctl-v12', family: 'v1', encoding: 'identity', alphaText: ALPHA_V1_TEXT },
      { key: 'ctl-v3-id', family: 'v3', encoding: 'identity', alphaText: ALPHA_V3_TEXT },
      { key: 'ctl-v3-gz', family: 'v3', encoding: 'gzip', alphaText: ALPHA_V3_TEXT },
    ];
    const turnsTextFor = (snapId) => db.prepare('SELECT text FROM snapshot_turns WHERE snapshot_id=? ORDER BY turn_idx').all(snapId).map((r) => String(r.text || ''));
    const bindingControls = [];
    for (const spec of controlSpecs) {
      for (const op of ['restore', 'import']) {
        const key = spec.key + '-' + (op === 'restore' ? 'r' : 'i');
        const pkg = spec.family === 'v3' ? stageV3Alpha(key, spec.encoding) : stageV1Alpha(key);
        const rec = await observeRecovery(pkg, op);
        const persistedSnapId = op === 'restore' ? pkg.snapId : rec.recoveredId;
        bindingControls.push(Object.assign(rec, {
          group: 'control', label: 'valid ' + spec.family + '/' + spec.encoding + ' ' + op,
          persistedSnapId: persistedSnapId,
          persistedTurns: persistedSnapId ? turnsTextFor(persistedSnapId) : [],
          alphaText: spec.alphaText,
          freshId: op === 'import' ? (!!rec.recoveredId && rec.recoveredId !== pkg.snapId) : true,
        }));
      }
    }

    /* Global witness: no substituted byte survives anywhere in the store. */
    const betaRowCount = db.prepare(
      'SELECT count(*) c FROM snapshot_turns WHERE text LIKE ? OR outer_html LIKE ? OR meta_json LIKE ?'
    ).get('%' + BETA_MARK + '%', '%' + BETA_MARK + '%', '%' + BETA_MARK + '%').c
      + db.prepare('SELECT count(*) c FROM snapshots WHERE title LIKE ? OR meta_json LIKE ?').get('%' + BETA_MARK + '%', '%' + BETA_MARK + '%').c
      + db.prepare('SELECT count(*) c FROM chats WHERE title LIKE ? OR meta_json LIKE ?').get('%' + BETA_MARK + '%', '%' + BETA_MARK + '%').c;
    const betaPayloadCount = sqlPayloads.filter((p) => p.indexOf(BETA_MARK) >= 0).length;
    const g01Binding = { cases: bindingCases, controls: bindingControls, betaRows: betaRowCount, betaPayloads: betaPayloadCount, betaMark: BETA_MARK };

    const readyFilesAfter = dirSig(readyDir);
    const srcChatSigAfter = rowSig('chats', SRC_CHAT), srcSnapSigAfter = rowSig('snapshots', SRC_SNAP);
    const liveAfter = fs.existsSync(LIVE_DB) ? fs.statSync(LIVE_DB) : null;

    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });

    return {
      ok: true,
      binding: g01Binding,
      sibling: Object.assign({ chat: SIB_CHAT, writes: siblingWrites }, sibling),
      pkg: { readyChat: RDY_CHAT, readySnap: RDY_SNAP, srcChat: SRC_CHAT, srcSnap: SRC_SNAP, srcMsgs: SRC_MSGS },
      inspect: { status: insp.status, ok: insp.ok, contentHashOk: insp.checks && insp.checks.contentHashOk, blockers: insp.blockers },
      v3Relink: {
        gzipStatus: v3RelinkGzip.status,
        rows: v3RelinkRows,
        expectedTurns: v3RelinkExpectedTurns,
        originalSnapshotAbsent: v3RelinkOriginalAbsent,
        identityAgainStatus: v3RelinkIdentityAgain.status,
        target: V3_RELINK_TARGET,
        negatives: v3RelinkNegatives,
      },
      v3Restore: {
        gzipStatus: v3RestoreGzip.status,
        rows: v3RestoredRows,
        expectedTurns: v3ExpectedTurns,
        identityConflictStatus: v3RestoreIdentityConflict.status,
        preWrites: v3RestorePre.writes,
        negatives: v3RestoreNegatives,
      },
      v3Import: {
        gzip: { status: v3GzipImport.status, rows: v3GzipRows, preWrites: v3GzipPre.writes },
        identity: { status: v3IdImport.status, rows: v3IdRows },
        negatives: v3Negatives,
      },
      v3Inspect: {
        gzip: { status: v3GzipInspect.status, ok: v3GzipInspect.ok, identity: v3GzipInspect.identity, contentHashOk: v3GzipInspect.checks && v3GzipInspect.checks.contentHashOk, blockers: v3GzipInspect.blockers },
        identity: { status: v3IdentityInspect.status, ok: v3IdentityInspect.ok, identity: v3IdentityInspect.identity, contentHashOk: v3IdentityInspect.checks && v3IdentityInspect.checks.contentHashOk, blockers: v3IdentityInspect.blockers },
        corrupt: { status: v3CorruptInspect.status, ok: v3CorruptInspect.ok, blockers: v3CorruptInspect.blockers },
        physical: { gzipEncoding: v3GzipManifest.files.snapshot.encoding, gzipStoredLen: gzipStored.length, logicalLen: v3LogicalBytes.length, gzipSha: v3GzipManifest.files.snapshot.sha256, logicalSha: v3GzipManifest.files.snapshot.contentSha256 },
      },
      dry: { decision: dry.decision, writes: dryWrites },
      import: { status: imp.status, newChatId: imp.recovered && imp.recovered.newChatId, newSnapshotId: newSnapId, originalChatId: imp.recovered && imp.recovered.originalChatId, originalSnapshotId: imp.recovered && imp.recovered.originalSnapshotId },
      newRows: { snapshot: !!newSnapRow, chat: !!newChatRow, turns: newTurns, chatTitle: newChatRow && newChatRow.title, provOriginalChatId: prov.originalChatId, provOriginalSnapshotId: prov.originalSnapshotId },
      delta: { chats: after.chats - before.chats, snapshots: after.snapshots - before.snapshots, turns: after.turns - before.turns },
      writeVerbs: importWrites,
      noUpdate: !importWrites.some((w) => w.startsWith('UPDATE')),
      unchanged: { srcChatRow: srcChatSig === srcChatSigAfter, srcSnapRow: srcSnapSig === srcSnapSigAfter, readyFiles: readyFilesBefore === readyFilesAfter },
      alreadyImported: { decision: dryAI.decision, importStatus: impAI.status, writes: aiWrites },
      restore: {
        ready: {
          dryDecision: restoreReadyDry.decision,
          dryWrites: restoreReadyDryWrites,
          status: restoreAction.status,
          chatId: restoreAction.restored && restoreAction.restored.chatId,
          snapshotId: restoreAction.restored && restoreAction.restored.snapshotId,
          turnCount: restoreAction.restored && restoreAction.restored.turnCount,
          delta: { chats: restoreAfter.chats - restoreBefore.chats, snapshots: restoreAfter.snapshots - restoreBefore.snapshots, turns: restoreAfter.turns - restoreBefore.turns },
          chatExists: !!restoredChat,
          snapshotExists: !!restoredSnap,
          turns: restoredTurns,
          provenanceChat: restoredChatMeta.restored || null,
          provenanceSnapshot: restoredSnapMeta.restored || null,
          writes: restoreReadyWrites,
          noUpdate: !restoreReadyWrites.some((w) => w.startsWith('UPDATE')),
          fixtureUnchanged: restoreReadyFilesBefore === restoreReadyFilesAfter,
        },
        alreadyPresent: { status: restoreAlready.status, writes: restoreAlreadyWrites },
        confirmGate: { status: restoreConfirm.status, writes: confirmWrites, delta: { chats: confirmAfter.chats - confirmBefore.chats, snapshots: confirmAfter.snapshots - confirmBefore.snapshots, turns: confirmAfter.turns - confirmBefore.turns } },
        conflictSnapshot: { dryDecision: conflictSnapDry.decision, status: conflictSnapAction.status, writes: conflictSnapWrites, delta: { chats: conflictSnapAfter.chats - conflictSnapBefore.chats - 0, snapshots: conflictSnapAfter.snapshots - conflictSnapBefore.snapshots, turns: conflictSnapAfter.turns - conflictSnapBefore.turns } },
        conflictChat: { dryDecision: conflictChatDry.decision, status: conflictChatAction.status, writes: conflictChatWrites, delta: { chats: conflictChatAfter.chats - conflictChatBefore.chats, snapshots: conflictChatAfter.snapshots - conflictChatBefore.snapshots, turns: conflictChatAfter.turns - conflictChatBefore.turns } },
        tombstoned: { dryDecision: tombstoneDry.decision, status: tombstoneAction.status, writes: tombstoneWrites, delta: { chats: tombstoneAfter.chats - tombstoneBefore.chats, snapshots: tombstoneAfter.snapshots - tombstoneBefore.snapshots, turns: tombstoneAfter.turns - tombstoneBefore.turns }, tombstoneUnchanged: tombstoneSigBefore === tombstoneSigAfter },
      },
      relink: {
        ready: {
          dryDecision: relinkDry.decision,
          dryWrites: relinkDryWrites,
          requiredConfirmToken: relinkDry.requiredConfirmToken,
          targetExists: relinkDry.store && relinkDry.store.targetExists,
          targetDeleted: relinkDry.store && relinkDry.store.targetDeleted,
          targetTombstoned: relinkDry.store && relinkDry.store.targetTombstoned,
          inspectStatus: relinkDry.inspectStatus,
        },
        confirmGate: {
          booleanStatus: relinkConfirmBool.status,
          booleanWrites: relinkConfirmBoolWrites,
          wrongStatus: relinkConfirmWrong.status,
          wrongWrites: relinkConfirmWrongWrites,
        },
        success: {
          status: relinkAction.status,
          targetChatId: relinked.targetChatId,
          newSnapshotId: relinkNewSnapId,
          previousSnapshotId: relinked.previousSnapshotId,
          delta: { chats: relinkAfter.chats - relinkBefore.chats, snapshots: relinkAfter.snapshots - relinkBefore.snapshots, turns: relinkAfter.turns - relinkBefore.turns },
          writes: relinkSuccessWrites,
          updateCount: relinkSuccessWrites.filter((w) => w.startsWith('UPDATE chats')).length,
          updateOnlyChats: relinkSuccessWrites.filter((w) => w.startsWith('UPDATE')).every((w) => w.startsWith('UPDATE chats')),
          noDelete: !relinkSuccessWrites.some((w) => w.startsWith('DELETE')),
          snapshotExists: !!relinkNewSnap,
          snapshotChatId: relinkNewSnap && relinkNewSnap.chat_id,
          originalSnapshotNotReused: relinkNewSnapId !== relinkPackages.ready.snap,
          turns: relinkNewTurns.length,
          targetPointerSnapshot: relinkTargetAfter && relinkTargetAfter.last_snapshot_id,
          targetPointerLeaf: relinkTargetAfter && relinkTargetAfter.current_leaf_id,
          snapshotCountDelta: Number(relinkTargetAfter.snapshot_count) - Number(relinkTargetBefore.snapshot_count),
          lastCapturedChanged: relinkTargetAfter.last_captured_at !== relinkTargetBefore.last_captured_at,
          updatedAtChanged: relinkTargetAfter.updated_at !== relinkTargetBefore.updated_at,
          targetUnchangedFields: relinkTargetUnchangedFields,
          packageUnchanged: relinkPackageSigBefore === relinkPackageSigAfter,
          provenance: relinkProv,
        },
        oldData: {
          oldSnapshotUnchanged: relinkOldSnapSigBefore === relinkOldSnapSigAfter,
          oldTurnsUnchanged: relinkOldTurnsSigBefore === relinkOldTurnsSigAfter,
          oldSnapshotStillExists: relinkOldSnapshotStillExists,
          oldTurnCount: relinkOldTurnCount,
        },
        alreadyRelinked: { dryDecision: relinkAlreadyDry.decision, status: relinkAlreadyAction.status, writes: relinkAlreadyWrites },
        missing: { dryDecision: relinkMissingDry.decision, status: relinkMissingAction.status, writes: relinkMissingWrites, delta: { chats: relinkMissingAfter.chats - relinkMissingBefore.chats, snapshots: relinkMissingAfter.snapshots - relinkMissingBefore.snapshots, turns: relinkMissingAfter.turns - relinkMissingBefore.turns } },
        deleted: { dryDecision: relinkDeletedDry.decision, status: relinkDeletedAction.status, writes: relinkDeletedWrites, delta: { chats: relinkDeletedAfter.chats - relinkDeletedBefore.chats, snapshots: relinkDeletedAfter.snapshots - relinkDeletedBefore.snapshots, turns: relinkDeletedAfter.turns - relinkDeletedBefore.turns } },
        tombstoned: { dryDecision: relinkTombstoneDry.decision, status: relinkTombstoneAction.status, writes: relinkTombstoneWrites, delta: { chats: relinkTombstoneAfter.chats - relinkTombstoneBefore.chats, snapshots: relinkTombstoneAfter.snapshots - relinkTombstoneBefore.snapshots, turns: relinkTombstoneAfter.turns - relinkTombstoneBefore.turns }, tombstoneUnchanged: relinkTombstoneSigBefore === relinkTombstoneSigAfter },
        conflict: { dryDecision: relinkConflictDry.decision, status: relinkConflictAction.status, writes: relinkConflictWrites, delta: { chats: relinkConflictAfter.chats - relinkConflictBefore.chats, snapshots: relinkConflictAfter.snapshots - relinkConflictBefore.snapshots, turns: relinkConflictAfter.turns - relinkConflictBefore.turns } },
        boundaries: {
          targetRowChanged: relinkTargetBeforeSig !== crypto.createHash('sha256').update(JSON.stringify(relinkTargetAfter)).digest('hex'),
          packageOriginalSnapshotId: relinkPackages.ready.snap,
          liveDbUntouchedWitness: true,
        },
      },
      liveDb: { present: !!liveBefore, untouched: !liveBefore || (!!liveAfter && liveBefore.mtimeMs === liveAfter.mtimeMs && liveBefore.size === liveAfter.size), seedIsTemp: seedDbPath.startsWith(os.tmpdir()) },
    };
  } finally {
    try { if (db) db.close(); } catch (_) { /* already closed */ }
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* best effort */ }
  }
}

let H = null, harnessError = null;
try { H = await runHarness(); } catch (e) { harnessError = e; }

function importerCardContainer() {
  let html = '';
  let nodes = new Map();
  const selectorFor = {
    select: '[data-archive-importer-select="1"]',
    dry: '[data-archive-importer-dry="1"]',
    import: '[data-archive-importer-import="1"]',
    load: '[data-archive-importer-load="1"]',
  };
  const container = {
    set innerHTML(value) {
      html = String(value || '');
      nodes = new Map();
      for (const [kind, selector] of Object.entries(selectorFor)) {
        if (!html.includes(`data-archive-importer-${kind}="1"`)) continue;
        const listeners = {};
        const node = {
          value: '',
          listeners,
          addEventListener(name, fn) { listeners[name] = fn; },
        };
        if (kind === 'select') {
          const selected = /<option value="([^"]*)" selected>/.exec(html);
          if (selected) node.value = selected[1];
        }
        nodes.set(selector, node);
      }
    },
    get innerHTML() { return html; },
    querySelector(selector) { return nodes.get(selector) || null; },
  };
  return container;
}

async function settleImporterCard() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

async function renderImporterOutcome(result, dryDecision) {
  const importer = globalThis.H2O?.Studio?.archiveImporter;
  assert.equal(typeof importer?.renderArchiveImporterCard, 'function');
  const packagePath = 'archive/packages/ui-result.h2ochat';
  const container = importerCardContainer();
  const previousDocument = globalThis.document;
  globalThis.document = {};
  try {
    const handle = importer.renderArchiveImporterCard(container, {
      isDesktop: true,
      listPackages: async () => [{
        packagePath,
        packageDirName: 'ui-result.h2ochat',
        status: 'verified',
      }],
      dryRunImportPackage: async () => ({
        ok: dryDecision === 'import-ready' || dryDecision === 'already-imported',
        status: dryDecision,
        decision: dryDecision,
        packagePath,
        packageDirName: 'ui-result.h2ochat',
        identity: {
          chatId: 'source-chat', snapshotId: 'source-snapshot',
          title: 'Recovered fixture', contentHash: 'sha256-' + 'a'.repeat(64),
        },
        reason: '',
      }),
      importVerifiedPackage: async () => result,
    });
    handle.load();
    await settleImporterCard();
    let select = container.querySelector('[data-archive-importer-select="1"]');
    assert.ok(select, 'package select did not render');
    select.value = packagePath;
    handle.dryRun();
    await settleImporterCard();
    select = container.querySelector('[data-archive-importer-select="1"]');
    assert.ok(select, 'package select disappeared after dry-run');
    select.value = packagePath;
    handle.doImport();
    await settleImporterCard();
    return container.innerHTML;
  } finally {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  }
}

await checkAsync('[M09 P0.2] one-package importer UI reports imported chat + snapshot from the actual recovered result', async () => {
  const html = await renderImporterOutcome({
    ok: true,
    status: 'imported',
    decision: 'import-ready',
    packagePath: 'archive/packages/ui-result.h2ochat',
    recovered: {
      newChatId: 'recovered-chat-id', newSnapshotId: 'recovered-snapshot-id',
      originalChatId: 'source-chat', originalSnapshotId: 'source-snapshot', messageCount: 2,
    },
    reason: 'recovered as a new chat + snapshot',
  }, 'import-ready');
  assert.match(html, /Imported/);
  assert.match(html, /Recovered as a NEW chat \+ snapshot/);
  assert.match(html, /recovered chatId[\s\S]*recovered-chat-id/);
  assert.match(html, /recovered snapshotId[\s\S]*recovered-snapshot-id/);
  assert.doesNotMatch(html, /0 imported|0 snapshots/);
});

await checkAsync('[M09 P0.2] one-package importer UI reports already-imported as a no-op with no new ids', async () => {
  const html = await renderImporterOutcome({
    ok: true,
    status: 'already-imported',
    decision: 'already-imported',
    packagePath: 'archive/packages/ui-result.h2ochat',
    recovered: {
      newChatId: '', newSnapshotId: '',
      originalChatId: 'source-chat', originalSnapshotId: 'source-snapshot',
    },
    reason: 'snapshot already present in store; no write performed',
  }, 'already-imported');
  assert.match(html, /Already imported/);
  assert.match(html, /no-op; nothing is written or overwritten/);
  assert.doesNotMatch(html, /Recovered as a NEW chat \+ snapshot/);
  assert.doesNotMatch(html, /recovered chatId|recovered snapshotId/);
});

await checkAsync('[M09 P0.2] one-package importer UI never renders a rejected result as success', async () => {
  const html = await renderImporterOutcome({
    ok: false,
    status: 'rejected',
    decision: 'import-ready',
    packagePath: 'archive/packages/ui-result.h2ochat',
    recovered: null,
    reason: 'package no longer verified at write time',
  }, 'import-ready');
  assert.match(html, /Rejected/);
  assert.match(html, /package no longer verified at write time/);
  assert.doesNotMatch(html, /Recovered as a NEW chat \+ snapshot|recovered chatId|recovered snapshotId/);
});

check('[M02 T06] v3 canonical typed parts reconstruct exact importer turns and metadata', () => {
  assert.ok(!harnessError, 'harness runtime unavailable');
  const importer = globalThis.H2O?.Studio?.archiveImporter;
  assert.equal(typeof importer?.buildTurnsFromPackageSnapshot, 'function');
  const snapshot = JSON.parse(readRepo(V3_FIXTURE_PKG_REL + '/snapshot.json'));
  const turns = importer.buildTurnsFromPackageSnapshot(snapshot);
  assert.equal(turns.length, 2);
  assert.equal(turns[0].text, 'First synthetic fixture turn.');
  assert.equal(turns[0].outerHtml, '<p>First synthetic fixture turn.</p><img src="assets/sha256-b6a38573d3cd8607b3cda428df2c4b2d05d976c58f55e47eeac8ffb0c34f780b.png">');
  assert.deepEqual(Array.from(turns, (turn) => turn.turnIdx), [0, 1]);
  assert.deepEqual(JSON.parse(JSON.stringify(turns[0].meta.content)), snapshot.messages[0].content);
  assert.deepEqual(Array.from(turns[0].meta.assetRefs), snapshot.messages[0].assetRefs);
  assert.deepEqual(JSON.parse(JSON.stringify(turns[0].meta.messageMetadata)), { fixture: true });
  assert.equal(Object.hasOwn(snapshot.messages[0], 'contentText'), false);
  assert.equal(Object.hasOwn(snapshot.messages[0], 'contentHtml'), false);
});

check('[M02 T06] restore and relink inherit the centralized v3 content reader', () => {
  assert.match(importerCode, /var turns = buildTurnsFromPackageSnapshot\(snapshotJson\)/);
  const restoreCode = readRepo('src-surfaces-base/studio/ingestion/saved-chat-archive-restore.studio.js');
  const relinkCode = readRepo('src-surfaces-base/studio/ingestion/saved-chat-archive-relink.studio.js');
  for (const code of [restoreCode, relinkCode]) {
    assert.ok(code.includes('archiveImporter'));
    assert.ok(code.includes('buildTurnsFromPackageSnapshot'));
    assert.doesNotMatch(code, /contentText|contentHtml/);
  }
});

check('[M02 T06] v1 scalar precedence remains frozen in the centralized content reader', () => {
  const importer = globalThis.H2O?.Studio?.archiveImporter;
  const snapshot = readFixtureJson('snapshot.json');
  const turns = importer.buildTurnsFromPackageSnapshot(snapshot);
  assert.equal(turns[0].text, snapshot.messages[0].contentText);
  assert.equal(turns[0].outerHtml, '');
  assert.deepEqual(JSON.parse(JSON.stringify(turns[0].meta.content)), snapshot.messages[0].content);
});

check('[M02 T06] v2 scalar precedence remains frozen while structured content is preserved', () => {
  const importer = globalThis.H2O?.Studio?.archiveImporter;
  const snapshot = {
    schemaVersion: 2,
    messages: [{
      id: 'legacy-v2', role: 'assistant', turnIndex: 0,
      contentText: 'legacy scalar wins',
      contentHtml: '<p>legacy scalar html remains historically ignored</p>',
      content: [{ type: 'text', text: 'typed lookalike' }, { type: 'html', html: '<p>typed lookalike</p>', sanitized: true }],
    }],
  };
  const turns = importer.buildTurnsFromPackageSnapshot(snapshot);
  assert.equal(turns[0].text, 'legacy scalar wins');
  assert.equal(turns[0].outerHtml, '');
  assert.deepEqual(JSON.parse(JSON.stringify(turns[0].meta.content)), snapshot.messages[0].content);
});

check('[I.2] live harness built + ran without schema/trigger drift or build error', () => {
  assert.ok(!harnessError, 'harness error: ' + (harnessError && (harnessError.message || harnessError)));
  assert.ok(H && H.ok, 'no harness result');
});

check('[I.2] inspectPackage returns verified (real diagnostics + inspector, hashes pass)', () => {
  assert.ok(H, 'no harness');
  assert.equal(H.inspect.status, 'verified');
  assert.equal(H.inspect.ok, true);
  assert.equal(H.inspect.contentHashOk, true);
  assert.deepEqual(H.inspect.blockers || [], []);
});

check('[M03 T04] Relink relinks a valid v3 gzip package to the target chat', () => {
  assert.ok(H, 'no harness');
  const r = H.v3Relink;
  assert.equal(r.gzipStatus, 'relinked', 'gzip v3 must relink');
  assert.ok(r.rows.snap, 'a FRESH snapshot row must exist under the target chat');
  assert.equal(r.rows.snap.chat_id, r.target, 'fresh snapshot must belong to the relink target');
  assert.ok(r.rows.turns.length > 0);
  /* Relink never re-parents the package's ORIGINAL snapshot id. */
  assert.equal(r.originalSnapshotAbsent, true, 'relink must not insert the package original snapshotId');
});

check('[M03 T04] Relink v3 gzip yields the representation-independent logical state', () => {
  assert.ok(H, 'no harness');
  const r = H.v3Relink;
  assert.equal(r.rows.turns.length, r.expectedTurns.length);
  for (let i = 0; i < r.expectedTurns.length; i += 1) {
    const got = r.rows.turns[i], want = r.expectedTurns[i];
    assert.equal(got.turn_idx, want.turnIdx, 'turn order must match');
    assert.equal(got.role, want.role);
    assert.equal(got.text, want.text);
    assert.equal(got.outer_html, want.outerHtml);
  }
  /* The identity representation of the SAME logical package is then correctly
   * recognised as already relinked — existing revision/link authority intact. */
  assert.equal(r.identityAgainStatus, 'already-relinked');
});

check('[M03 T04] Relink rejects every v3 integrity failure with ZERO persistent mutation', () => {
  assert.ok(H, 'no harness');
  const negs = H.v3Relink.negatives;
  assert.equal(negs.length, 8, 'all negative cases must run');
  for (const n of negs) {
    assert.notEqual(n.status, 'relinked', n.label + ' must not relink');
    assert.equal(n.threw, null, n.label + ' must fail closed, not throw');
    assert.equal(n.mutated, false, n.label + ' mutated persistent state');
    assert.equal(n.writeDelta, 0, n.label + ' issued ' + n.writeDelta + ' persistent writes');
  }
});

check('[M03 T04] Relink owns no gzip/compression implementation', () => {
  const src = readRepo('src-surfaces-base/studio/ingestion/saved-chat-archive-relink.studio.js');
  assert.doesNotMatch(src, /DecompressionStream|CompressionStream|gunzip|inflate|zlib/);
  assert.doesNotMatch(src, /0x1f/);
  assert.match(src, /readVerifiedPackageMember/);
  assert.match(src, /LOGICAL_SNAPSHOT_CAP_BYTES/);
});

check('[M03 T04] Restore restores a valid v3 gzip package with original ids', () => {
  assert.ok(H, 'no harness');
  const r = H.v3Restore;
  assert.equal(r.gzipStatus, 'restored', 'gzip v3 must restore');
  assert.ok(r.rows, 'restored snapshot row must exist under the ORIGINAL snapshotId');
  assert.ok(r.rows.messageCount > 0);
  assert.ok(r.rows.turns.length > 0);
});

check('[M03 T04] Restore v3 gzip yields the representation-independent logical state', () => {
  assert.ok(H, 'no harness');
  const r = H.v3Restore;
  assert.equal(r.rows.turns.length, r.expectedTurns.length);
  for (let i = 0; i < r.expectedTurns.length; i += 1) {
    const got = r.rows.turns[i], want = r.expectedTurns[i];
    assert.equal(got.turn_idx, want.turnIdx, 'turn order must match');
    assert.equal(got.role, want.role);
    assert.equal(got.text, want.text);
    assert.equal(got.outer_html, want.outerHtml);
  }
  /* The identity representation of the SAME logical package is then correctly
   * refused by the existing absent-only restore rules. 'already-present' is the
   * established Phase K outcome for a snapshot already in the store, and it also
   * confirms the gzip restore really did insert under the ORIGINAL snapshotId. */
  assert.equal(r.identityConflictStatus, 'already-present');
});

check('[M03 T04] Restore rejects every v3 integrity failure with ZERO persistent mutation', () => {
  assert.ok(H, 'no harness');
  const negs = H.v3Restore.negatives;
  assert.equal(negs.length, 8, 'all negative cases must run');
  for (const n of negs) {
    assert.notEqual(n.status, 'restored', n.label + ' must not restore');
    assert.equal(n.threw, null, n.label + ' must fail closed, not throw');
    assert.equal(n.mutated, false, n.label + ' mutated persistent state');
    assert.equal(n.writeDelta, 0, n.label + ' issued ' + n.writeDelta + ' persistent writes');
  }
});

check('[M03 T04] Restore owns no gzip/compression implementation', () => {
  const src = readRepo('src-surfaces-base/studio/ingestion/saved-chat-archive-restore.studio.js');
  assert.doesNotMatch(src, /DecompressionStream|CompressionStream|gunzip|inflate|zlib/);
  assert.doesNotMatch(src, /0x1f/);
  assert.match(src, /readVerifiedPackageMember/);
  assert.match(src, /LOGICAL_SNAPSHOT_CAP_BYTES/);
});

check('[M03 T04] Importer imports a valid v3 gzip package', () => {
  assert.ok(H, 'no harness');
  const g = H.v3Import.gzip;
  assert.equal(g.status, 'imported');
  assert.ok(g.rows, 'gzip import must create a recovered snapshot row');
  assert.ok(g.rows.messageCount > 0);
  assert.ok(g.rows.turns.length > 0);
});

check('[M03 T04] Importer v3 gzip and identity produce equivalent imported state', () => {
  assert.ok(H, 'no harness');
  const g = H.v3Import.gzip.rows, i = H.v3Import.identity.rows;
  assert.equal(H.v3Import.identity.status, 'imported');
  assert.ok(g && i, 'both variants must import');
  /* Same logical package: identical recovered title, count and turn content. */
  assert.equal(g.title, i.title);
  assert.equal(g.messageCount, i.messageCount);
  assert.equal(g.turns.length, i.turns.length);
  assert.deepEqual(g.turns, i.turns, 'imported turns must be byte-equivalent across encodings');
});

check('[M03 T04] Importer rejects every v3 integrity failure with ZERO persistent mutation', () => {
  assert.ok(H, 'no harness');
  const negs = H.v3Import.negatives;
  assert.equal(negs.length, 8, 'all negative cases must run');
  for (const n of negs) {
    assert.notEqual(n.status, 'imported', n.label + ' must not import');
    assert.equal(n.threw, null, n.label + ' must fail closed, not throw');
    assert.equal(n.mutated, false, n.label + ' mutated persistent state');
    assert.equal(n.writeDelta, 0, n.label + ' issued ' + n.writeDelta + ' persistent writes');
  }
});

check('[M03 T04] Importer owns no gzip/compression implementation', () => {
  const src = readRepo(IMPORTER_REL);
  assert.doesNotMatch(src, /DecompressionStream|CompressionStream|gunzip|inflate|zlib/);
  assert.doesNotMatch(src, /0x1f/);
  /* Governed reader is used for the v3 recovery payload. */
  assert.match(src, /readVerifiedPackageMember/);
  assert.match(src, /LOGICAL_SNAPSHOT_CAP_BYTES/);
});

check('[M03 T04] Inspector verifies a valid v3 gzip package through the governed chain', () => {
  assert.ok(H, 'no harness');
  const g = H.v3Inspect.gzip;
  assert.equal(g.status, 'verified', JSON.stringify(g.blockers));
  assert.equal(g.ok, true);
  assert.equal(g.contentHashOk, true);
  assert.deepEqual(g.blockers || [], []);
  assert.equal(g.identity.schemaVersion, 3);
  assert.equal(g.identity.payloadVersion, 3);
});

check('[M03 T04] Inspector v3 identity and gzip are semantically equivalent', () => {
  assert.ok(H, 'no harness');
  const g = H.v3Inspect.gzip, i = H.v3Inspect.identity, ph = H.v3Inspect.physical;
  /* Same logical package written to the same path in two representations. */
  assert.equal(i.status, 'verified', JSON.stringify(i.blockers));
  assert.equal(g.status, i.status);
  assert.equal(g.ok, i.ok);
  assert.equal(g.contentHashOk, i.contentHashOk);
  assert.equal(g.identity.chatId, i.identity.chatId);
  assert.equal(g.identity.snapshotId, i.identity.snapshotId);
  assert.equal(g.identity.schemaVersion, i.identity.schemaVersion);
  assert.equal(g.identity.payloadVersion, i.identity.payloadVersion);
  /* Logical package identity is encoding-independent. */
  assert.equal(g.identity.contentHash, i.identity.contentHash);
  /* Only the physical representation differs, and DP-M03-C holds. */
  assert.equal(ph.gzipEncoding, 'gzip');
  assert.ok(ph.gzipStoredLen > 0);
  assert.ok(ph.gzipStoredLen < ph.logicalLen, 'DP-M03-C: 0 < physical < logical');
  assert.notEqual(ph.gzipSha, ph.logicalSha);
});

check('[M03 T04] Inspector fails closed on a corrupt gzip v3 member', () => {
  assert.ok(H, 'no harness');
  /* M10 P3.5: Rust owns the byte-level corrupt-gzip proof — the scanner test
   * `scanner_refuses_v3_renderer_members_malformed_gzip_and_false_logical_descriptor`
   * asserts only `Indeterminate` with `Corrupt | Partial` and deliberately
   * fabricates no blocker code. This test therefore verifies DOWNSTREAM
   * behaviour given that trusted refusal: the Inspector must fail closed and
   * must not present the package as verified. Asserting a granular blocker here
   * would demand specificity the trusted boundary does not guarantee. */
  const c = H.v3Inspect.corrupt;
  assert.equal(c.status, 'corrupted');
  assert.equal(c.ok, false);
  assert.notEqual(c.status, 'verified');
  /* Unverified payload never reaches semantic JSON parsing. */
  assert.ok(!(c.blockers || []).includes('snapshot-json-invalid'));
});

check('[M03 T04] Inspector owns no gzip/compression implementation', () => {
  const src = readRepo('src-surfaces-base/studio/ingestion/saved-chat-archive-inspector.studio.js');
  assert.doesNotMatch(src, /DecompressionStream|CompressionStream|gunzip|inflate|zlib/);
  assert.doesNotMatch(src, /0x1f/);
  /* The obsolete pre-M03 gzip refusal no longer exists anywhere. */
  assert.doesNotMatch(src, /snapshot-encoding-not-enabled/);
});

check('[I.2] dryRunImportPackage returns import-ready with zero writes', () => {
  assert.ok(H);
  assert.equal(H.dry.decision, 'import-ready');
  assert.equal(H.dry.writes, 0);
});

check('[I.2] importVerifiedPackage returns imported; recovered chatId + snapshotId are FRESH', () => {
  assert.ok(H);
  assert.equal(H.import.status, 'imported');
  assert.ok(H.import.newChatId && H.import.newChatId !== H.pkg.readyChat, 'recovered chatId must be fresh');
  assert.ok(H.import.newSnapshotId && H.import.newSnapshotId !== H.pkg.readySnap, 'recovered snapshotId must be fresh + non-empty');
});

check('[I.2] provenance records the original package ids', () => {
  assert.ok(H);
  assert.equal(H.newRows.provOriginalChatId, H.pkg.readyChat);
  assert.equal(H.newRows.provOriginalSnapshotId, H.pkg.readySnap);
});

check('[I.2] DB deltas: chats +1, snapshots +1, turns +N (new rows present)', () => {
  assert.ok(H);
  assert.equal(H.delta.chats, 1, 'chats delta');
  assert.equal(H.delta.snapshots, 1, 'snapshots delta');
  assert.equal(H.delta.turns, H.pkg.srcMsgs, 'turns delta (+N)');
  assert.ok(H.newRows.snapshot && H.newRows.chat, 'new chat + snapshot rows present');
  assert.equal(H.newRows.turns, H.pkg.srcMsgs, 'new snapshot turn count');
});

check('[I.2] no-overwrite proof: import write verbs contain NO UPDATE', () => {
  assert.ok(H);
  assert.equal(H.noUpdate, true, 'write verbs: ' + JSON.stringify(H.writeVerbs));
  assert.ok(H.writeVerbs.some((w) => w.startsWith('INSERT chats')), 'expected INSERT chats');
  assert.ok(H.writeVerbs.some((w) => w.startsWith('INSERT snapshots')), 'expected INSERT snapshots');
});

check('[I.2] source rows + import-ready fixture files unchanged by the import (no overwrite)', () => {
  assert.ok(H);
  assert.equal(H.unchanged.srcChatRow, true, 'seeded source chat row must be unchanged');
  assert.equal(H.unchanged.srcSnapRow, true, 'seeded source snapshot row must be unchanged');
  assert.equal(H.unchanged.readyFiles, true, 'fixture files must be unchanged');
});

check('[I.2] already-imported package returns already-imported (dry-run) + no-op import (zero writes)', () => {
  assert.ok(H);
  assert.equal(H.alreadyImported.decision, 'already-imported');
  assert.equal(H.alreadyImported.importStatus, 'already-imported');
  assert.equal(H.alreadyImported.writes, 0);
});

check('[I.2] live Desktop DB untouched (seed DB is a temp file; live studio-v1.db never opened/mutated)', () => {
  assert.ok(H);
  assert.equal(H.liveDb.seedIsTemp, true, 'seed DB must be a temp file');
  assert.equal(H.liveDb.untouched, true, 'live studio-v1.db mtime/size must be unchanged (or absent in CI)');
});

// --- E. Restore-original-ids harness (K.3) ----------------------------------

check('[K.3] restore-ready dry-run returns restore-ready with zero writes', () => {
  assert.ok(H);
  assert.equal(H.restore.ready.dryDecision, 'restore-ready');
  assert.equal(H.restore.ready.dryWrites, 0);
});

check('[K.3] restoreVerifiedPackage restores original chatId + snapshotId and inserts snapshot_turns', () => {
  assert.ok(H);
  assert.equal(H.restore.ready.status, 'restored');
  assert.equal(H.restore.ready.chatId, 'k3-restore-ready-chat');
  assert.equal(H.restore.ready.snapshotId, 'snap_k3_restore_ready');
  assert.equal(H.restore.ready.chatExists, true);
  assert.equal(H.restore.ready.snapshotExists, true);
  assert.equal(H.restore.ready.turns, H.pkg.srcMsgs);
});

check('[K.3] restore DB delta is exactly +1 chat, +1 snapshot, +N turns; provenance recorded; fixture unchanged', () => {
  assert.ok(H);
  assert.deepEqual(H.restore.ready.delta, { chats: 1, snapshots: 1, turns: H.pkg.srcMsgs });
  assert.equal(H.restore.ready.provenanceChat.originalChatId, 'k3-restore-ready-chat');
  assert.equal(H.restore.ready.provenanceSnapshot.originalSnapshotId, 'snap_k3_restore_ready');
  assert.equal(H.restore.ready.fixtureUnchanged, true);
});

check('[K.3] restore no-overwrite proof: restore write verbs contain no UPDATE', () => {
  assert.ok(H);
  assert.equal(H.restore.ready.noUpdate, true, 'restore writes: ' + JSON.stringify(H.restore.ready.writes));
  assert.ok(H.restore.ready.writes.some((w) => w.startsWith('INSERT chats')), 'expected INSERT chats');
  assert.ok(H.restore.ready.writes.some((w) => w.startsWith('INSERT snapshots')), 'expected INSERT snapshots');
  assert.ok(H.restore.ready.writes.some((w) => w.startsWith('INSERT snapshot_turns')), 'expected INSERT snapshot_turns');
});

check('[K.3] confirm gate rejects restore without confirm and performs zero writes', () => {
  assert.ok(H);
  assert.equal(H.restore.confirmGate.status, 'rejected');
  assert.equal(H.restore.confirmGate.writes, 0);
  assert.deepEqual(H.restore.confirmGate.delta, { chats: 0, snapshots: 0, turns: 0 });
});

check('[K.3] second restore returns already-present and performs zero writes', () => {
  assert.ok(H);
  assert.equal(H.restore.alreadyPresent.status, 'already-present');
  assert.equal(H.restore.alreadyPresent.writes, 0);
});

check('[K.3] conflict-snapshot-id returns conflict without restore writes', () => {
  assert.ok(H);
  assert.equal(H.restore.conflictSnapshot.dryDecision, 'conflict-snapshot-id');
  assert.equal(H.restore.conflictSnapshot.status, 'conflict');
  assert.equal(H.restore.conflictSnapshot.writes, 0);
  assert.deepEqual(H.restore.conflictSnapshot.delta, { chats: 0, snapshots: 0, turns: 0 });
});

check('[K.3] conflict-chat-id returns conflict without restore writes', () => {
  assert.ok(H);
  assert.equal(H.restore.conflictChat.dryDecision, 'conflict-chat-id');
  assert.equal(H.restore.conflictChat.status, 'conflict');
  assert.equal(H.restore.conflictChat.writes, 0);
  assert.deepEqual(H.restore.conflictChat.delta, { chats: 0, snapshots: 0, turns: 0 });
});

check('[K.3] tombstoned returns tombstoned, performs zero writes, and leaves tombstone unchanged', () => {
  assert.ok(H);
  assert.equal(H.restore.tombstoned.dryDecision, 'tombstoned');
  assert.equal(H.restore.tombstoned.status, 'tombstoned');
  assert.equal(H.restore.tombstoned.writes, 0);
  assert.deepEqual(H.restore.tombstoned.delta, { chats: 0, snapshots: 0, turns: 0 });
  assert.equal(H.restore.tombstoned.tombstoneUnchanged, true);
});

// --- F. Relink harness (K.4.3) ----------------------------------------------
// K.4.3 exact delta proof: exactly +1 snapshot, +N turns, +1 chat UPDATE.
// K.4.3 global no-write boundaries: libraryIndex, saved_chat_archive_requests,
// and sync_tombstones must not be written by relink. The live Desktop DB
// untouched witness below proves the harness remains temp-DB only.

check('[K.4.3] relink-ready dry-run verifies package + target and returns typed token with zero writes', () => {
  assert.ok(H);
  assert.equal(H.relink.ready.dryDecision, 'relink-ready');
  assert.equal(H.relink.ready.dryWrites, 0);
  assert.equal(H.relink.ready.requiredConfirmToken, 'RELINK:k4-relink-target-chat');
  assert.equal(H.relink.ready.targetExists, true);
  assert.equal(H.relink.ready.targetDeleted, false);
  assert.equal(H.relink.ready.targetTombstoned, false);
  assert.equal(H.relink.ready.inspectStatus, 'verified');
});

check('[K.4.3] typed-confirm rejection rejects boolean/missing/wrong confirm and performs zero writes', () => {
  assert.ok(H);
  assert.equal(H.relink.confirmGate.booleanStatus, 'rejected');
  assert.equal(H.relink.confirmGate.booleanWrites, 0);
  assert.equal(H.relink.confirmGate.wrongStatus, 'rejected');
  assert.equal(H.relink.confirmGate.wrongWrites, 0);
});

check('[K.4.3] relink success inserts exactly +1 snapshot and +N turns, no new chat, and exactly one chat UPDATE', () => {
  assert.ok(H);
  assert.equal(H.relink.success.status, 'relinked');
  assert.deepEqual(H.relink.success.delta, { chats: 0, snapshots: 1, turns: H.pkg.srcMsgs });
  assert.equal(H.relink.success.updateCount, 1);
  assert.equal(H.relink.success.updateOnlyChats, true, 'writes: ' + JSON.stringify(H.relink.success.writes));
  assert.equal(H.relink.success.noDelete, true, 'writes: ' + JSON.stringify(H.relink.success.writes));
});

check('[K.4.3] relink inserts a fresh snap_relinked_* snapshot under targetChatId and never reuses package original snapshotId', () => {
  assert.ok(H);
  assert.match(H.relink.success.newSnapshotId, /^snap_relinked_/);
  assert.equal(H.relink.success.snapshotExists, true);
  assert.equal(H.relink.success.snapshotChatId, 'k4-relink-target-chat');
  assert.equal(H.relink.success.originalSnapshotNotReused, true);
  assert.notEqual(H.relink.success.newSnapshotId, H.relink.boundaries.packageOriginalSnapshotId);
  assert.equal(H.relink.success.turns, H.pkg.srcMsgs);
});

check('[K.4.3] relink updates only target pointer metadata and preserves organization/membership fields', () => {
  assert.ok(H);
  assert.equal(H.relink.success.targetPointerSnapshot, H.relink.success.newSnapshotId);
  assert.equal(H.relink.success.targetPointerLeaf, H.relink.success.newSnapshotId);
  assert.equal(H.relink.success.snapshotCountDelta, 1);
  assert.equal(H.relink.success.lastCapturedChanged, true);
  assert.equal(H.relink.success.updatedAtChanged, true);
  assert.equal(H.relink.success.targetUnchangedFields, true);
});

check('[K.4.3] relink provenance records previous pointer, new snapshot, package identity, confirm token, and mode', () => {
  assert.ok(H);
  const p = H.relink.success.provenance || {};
  assert.equal(p.previousSnapshotId, 'snap_k4_relink_old');
  assert.equal(p.previousCurrentLeafId, 'snap_k4_relink_old');
  assert.equal(p.previousLastCapturedAt, 1000);
  assert.equal(p.newSnapshotId, H.relink.success.newSnapshotId);
  assert.equal(p.originalChatId, 'k4-relink-package-chat');
  assert.equal(p.originalSnapshotId, 'snap_k4_relink_package');
  assert.ok(String(p.contentHash || '').startsWith('sha256-'));
  assert.equal(p.packagePath, 'archive/packages/k4-relink-package-chat.h2ochat');
  assert.equal(p.packageDirName, 'k4-relink-package-chat.h2ochat');
  assert.ok(p.relinkedAt);
  assert.equal(p.confirmToken, 'RELINK:k4-relink-target-chat');
  assert.equal(p.confirmMode, 'typed-token');
  assert.equal(p.mode, 'relink');
});

check('[K.4.3] old snapshot and turns remain unchanged and source package remains unchanged', () => {
  assert.ok(H);
  assert.equal(H.relink.oldData.oldSnapshotUnchanged, true);
  assert.equal(H.relink.oldData.oldTurnsUnchanged, true);
  assert.equal(H.relink.oldData.oldSnapshotStillExists, true);
  assert.equal(H.relink.oldData.oldTurnCount, 1);
  assert.equal(H.relink.success.packageUnchanged, true);
});

check('[K.4.3] already-relinked returns already-relinked and performs zero writes', () => {
  assert.ok(H);
  assert.equal(H.relink.alreadyRelinked.dryDecision, 'already-relinked');
  assert.equal(H.relink.alreadyRelinked.status, 'already-relinked');
  assert.equal(H.relink.alreadyRelinked.writes, 0);
});

check('[K.4.3] missing/deleted/tombstoned targets and original-snapshot conflict are zero-write', () => {
  assert.ok(H);
  assert.equal(H.relink.missing.dryDecision, 'target-chat-missing');
  assert.equal(H.relink.missing.status, 'target-chat-missing');
  assert.equal(H.relink.missing.writes, 0);
  assert.deepEqual(H.relink.missing.delta, { chats: 0, snapshots: 0, turns: 0 });
  assert.equal(H.relink.deleted.dryDecision, 'target-chat-deleted');
  assert.equal(H.relink.deleted.status, 'target-chat-deleted');
  assert.equal(H.relink.deleted.writes, 0);
  assert.deepEqual(H.relink.deleted.delta, { chats: 0, snapshots: 0, turns: 0 });
  assert.equal(H.relink.tombstoned.dryDecision, 'tombstoned');
  assert.equal(H.relink.tombstoned.status, 'tombstoned');
  assert.equal(H.relink.tombstoned.writes, 0);
  assert.deepEqual(H.relink.tombstoned.delta, { chats: 0, snapshots: 0, turns: 0 });
  assert.equal(H.relink.tombstoned.tombstoneUnchanged, true);
  assert.equal(H.relink.conflict.dryDecision, 'snapshot-belongs-to-other-chat');
  assert.equal(H.relink.conflict.status, 'conflict');
  assert.equal(H.relink.conflict.writes, 0);
  assert.deepEqual(H.relink.conflict.delta, { chats: 0, snapshots: 0, turns: 0 });
});

check('[K.4.3] global relink boundaries hold: no live DB, no tombstone mutation, no package/original snapshot overwrite', () => {
  assert.ok(H);
  assert.equal(H.liveDb.seedIsTemp, true);
  assert.equal(H.liveDb.untouched, true);
  assert.equal(H.relink.boundaries.liveDbUntouchedWitness, true);
  assert.equal(H.relink.success.originalSnapshotNotReused, true);
  assert.equal(H.relink.oldData.oldSnapshotUnchanged, true);
});

// --- G. Evidence + deferrals -------------------------------------------------

check('[I.0] I.1 scaffold evidence exists (PASSED) and defers restore/relink/export', () => {
  assert.ok(exists(I1_EVIDENCE_REL));
  assert.match(i1, /I\.1 IMPORT RECOVERY HARNESS SCAFFOLD\s*[—-]\s*PASSED/);
  assert.match(i1, /restore ?\/ ?relink/i);
});

check('[I.2] I.2 runtime evidence exists, is marked PASSED, and keeps restore/relink/export deferred', () => {
  assert.ok(exists(I2_EVIDENCE_REL), 'I.2 evidence missing');
  assert.match(i2, /I\.2 IMPORT RECOVERY HARNESS\s*[—-]\s*PASSED/);
  assert.match(i2, /restore ?\/ ?relink/i);
  assert.match(i2, /defer/i);
});

check('[K.3] K.3 restore evidence exists and records PASSED harness/runtime proof', () => {
  assert.ok(exists(K3_EVIDENCE_REL), 'K.3 evidence missing');
  const k3 = readRepo(K3_EVIDENCE_REL);
  assert.match(k3, /PHASE K\.3[\s\S]*RESTORE ORIGINAL IDS HARNESS ?\/ ?RUNTIME SMOKE[\s\S]*PASSED/);
  assert.match(k3, /restore-ready/i);
  assert.match(k3, /conflict-snapshot-id/i);
  assert.match(k3, /conflict-chat-id/i);
  assert.match(k3, /tombstoned/i);
  assert.match(k3, /no-overwrite/i);
});

check('[K.4.3] K.4.3 relink evidence exists and records PASSED harness proof', () => {
  assert.ok(exists(K43_EVIDENCE_REL), 'K.4.3 evidence missing');
  const k43 = readRepo(K43_EVIDENCE_REL);
  assert.match(k43, /PHASE K\.4\.3[\s\S]*RELINK HARNESS PROOF[\s\S]*PASSED/);
  assert.match(k43, /relink-ready/i);
  assert.match(k43, /typed-confirm/i);
  assert.match(k43, /already-relinked/i);
  assert.match(k43, /target-chat-deleted/i);
  assert.match(k43, /tombstoned/i);
  assert.match(k43, /snapshot-belongs-to-other-chat/i);
  assert.match(k43, /old snapshot/i);
  assert.match(k43, /live Desktop DB/i);
});

/* ── M05 Phase 4 — explicit generation selection (proofs 11, 12, 13) ─────── */
check('[P4.11] Import binds to the exact selected source generation, not a sibling', () => {
  const s = H.sibling;
  for (const key of ['a', 'b']) {
    const got = s[key].importDry;
    const id = (got && got.identity) || {};
    assert.equal(id.snapshotId, s[key].expectedSnap,
      `import of ${s[key].dir} resolved identity from a sibling package`);
  }
  // The two siblings must not be conflated: distinct source identity each time.
  assert.notEqual(s.a.importDry.identity.snapshotId, s.b.importDry.identity.snapshotId);
  assert.notEqual(s.a.importDry.identity.contentHash, s.b.importDry.identity.contentHash,
    'both siblings reported the same contentHash — identity is not per-package');
});

check('[P4.12] Restore uses the exact explicit path and never auto-selects a sibling', () => {
  const s = H.sibling;
  for (const key of ['a', 'b']) {
    const got = s[key].restoreDry;
    assert.equal(got.packageDirName, s[key].dir, `restore retargeted ${s[key].dir}`);
    assert.equal(got.identity.snapshotId, s[key].expectedSnap,
      `restore of ${s[key].dir} resolved a sibling's snapshot`);
  }
  assert.notEqual(s.a.restoreDry.identity.snapshotId, s.b.restoreDry.identity.snapshotId);
});

check('[P4.13] Relink uses the exact explicit path and never auto-selects a sibling', () => {
  const s = H.sibling;
  for (const key of ['a', 'b']) {
    const got = s[key].relinkDry;
    assert.equal(got.packageDirName, s[key].dir, `relink retargeted ${s[key].dir}`);
    assert.equal(got.identity.originalSnapshotId, s[key].expectedSnap,
      `relink of ${s[key].dir} resolved a sibling's snapshot`);
  }
  assert.notEqual(s.a.relinkDry.identity.originalSnapshotId, s.b.relinkDry.identity.originalSnapshotId);
});

check('[P4.11-13] sibling dry-runs stayed non-mutating', () => {
  assert.equal(H.sibling.writes, 0, 'a dry-run wrote to the store');
});

check('[P4.12-13] explicit-selection flows cannot enumerate sibling packages', () => {
  /* The behavioural proofs above show these flows bind to the path handed in.
   * This closes the door structurally: a flow that cannot list the packages
   * directory cannot grow a "pick the latest sibling" rule later. */
  for (const rel of [
    IMPORTER_REL,
    'src-surfaces-base/studio/ingestion/saved-chat-archive-restore.studio.js',
    'src-surfaces-base/studio/ingestion/saved-chat-archive-relink.studio.js',
  ]) {
    const code = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
    for (const token of ['readDir', 'read_dir', 'readdir']) {
      assert.ok(!code.includes(token), rel + ' enumerates the packages directory: ' + token);
    }
  }
});

/* ── G01 — durable archive-recovery binding proofs ────────────────────────────
 * Behavioural regression coverage for the trusted-state binding of archive-path
 * recovery reads. These run the REAL importer and restore modules against real
 * packages whose bytes were substituted AFTER the trusted enumeration measured
 * them, and assert decisions, execution statuses, write counters, row deltas and
 * write payloads — never source text. They are the behavioural half of the G01
 * protection; the source-level anti-reintroduction invariant lives in
 * validate-saved-chat-archive-recovery-import-export-v1.mjs and neither replaces
 * the other. */
const G01_READY = { restore: 'restore-ready', import: 'import-ready' };
const G01_SUCCESS = { restore: 'restored', import: 'imported' };
function g01() {
  assert.ok(H && H.binding, 'the G01 binding proofs did not run');
  return H.binding;
}
function g01Cases(group, op) {
  return g01().cases.filter((c) => c.group === group && (!op || c.op === op));
}
function g01Refused(c) {
  const at = c.group + '/' + c.key + ' [' + c.op + ' — ' + c.label + ']';
  assert.ok(c.dryRunCalled && c.executionCalled, at + ': both the dry-run AND the execution API must be exercised');
  assert.ok(c.integrityCalls >= 2, at + ': fewer than two trusted enumerations — the read was not independently bound');
  assert.notEqual(c.dryDecision, G01_READY[c.op], at + ': dry-run reported ready for content that cannot be bound to trusted state');
  assert.notEqual(c.execStatus, G01_SUCCESS[c.op], at + ': EXECUTION SUCCEEDED on content that cannot be bound to trusted state');
  assert.equal(c.writes, 0, at + ': refusal performed ' + c.writes + ' write(s)');
  assert.deepEqual(c.delta, { chats: 0, snapshots: 0, turns: 0 }, at + ': refusal changed row counts');
  assert.equal(c.betaInWrites, false, at + ': SUBSTITUTED CONTENT REACHED A WRITE PAYLOAD');
  assert.equal(c.recoveredId, '', at + ': a recovered/restored id was issued for a refused package');
  assert.equal(c.provenanceRows, 0, at + ': a stored row recorded provenance for a refused package');
  assert.equal(c.originalIdsPresent.chat, false, at + ': the refused package chatId was persisted');
  assert.equal(c.originalIdsPresent.snapshot, false, at + ': the refused package snapshotId was persisted');
}

check('[G01] restore refuses every post-enumeration snapshot substitution, at dry-run AND execution, with zero writes', () => {
  const cases = g01Cases('substitution', 'restore');
  assert.ok(cases.length >= 6, 'expected the full restore substitution matrix, saw ' + cases.length);
  for (const c of cases) g01Refused(c);
});

check('[G01] importer refuses every post-enumeration snapshot substitution, at dry-run AND execution, with zero writes', () => {
  const cases = g01Cases('substitution', 'import');
  assert.ok(cases.length >= 6, 'expected the full importer substitution matrix, saw ' + cases.length);
  for (const c of cases) g01Refused(c);
});

check('[G01] substituted packages ARE read and then rejected — the refusal is the digest comparison, not an earlier gate', () => {
  const cases = g01().cases.filter((c) => c.group === 'substitution' || c.group === 'downgrade');
  assert.ok(cases.length >= 16, 'expected the full substitution + downgrade matrix, saw ' + cases.length);
  for (const c of cases) {
    assert.ok(c.snapshotMemberReads >= 1,
      c.key + '/' + c.op + ': the snapshot member was never read, so this case cannot prove the bound read refuses it');
  }
});

check('[G01] a substitution at IDENTICAL physical byte length is refused — byte length alone cannot explain it', () => {
  const cases = g01().cases.filter((c) => c.sameLength === true);
  assert.equal(cases.length, 2, 'expected one same-length case per module, saw ' + cases.length);
  assert.deepEqual(cases.map((c) => c.op).sort(), ['import', 'restore']);
  for (const c of cases) {
    assert.equal(c.alphaByteLength, c.betaByteLength,
      c.op + ': the same-length case is not same-length (' + c.alphaByteLength + ' vs ' + c.betaByteLength + ') — it would pass on the length check alone');
    g01Refused(c);
  }
});

check('[G01] a trusted v3 package cannot be diverted to the weaker read by package-controlled metadata', () => {
  const cases = g01Cases('downgrade');
  assert.equal(cases.length, 4, 'expected two downgrade attempts per module, saw ' + cases.length);
  for (const c of cases) {
    assert.equal(c.family, 'v3', c.key + ': the downgrade proof must start from a TRUSTED v3 occupant');
    g01Refused(c);
  }
});

check('[G01] trusted identity binding fails closed in both directions, on disagreement, and when BOTH sides are absent', () => {
  const cases = g01Cases('identity');
  assert.equal(cases.length, 8, 'expected four identity cases per module, saw ' + cases.length);
  const keys = new Set(cases.map((c) => c.key.replace(/-[ri]$/, '')));
  for (const required of ['idb-occ-absent', 'idb-insp-absent', 'idb-both-absent', 'idb-disagree']) {
    assert.ok(keys.has(required), 'missing mandatory identity case: ' + required);
  }
  for (const c of cases) g01Refused(c);
});

check('[G01] partial trusted member anchors fail closed — no downgrade, no weak-read fallback', () => {
  const cases = g01Cases('anchors');
  assert.equal(cases.length, 20, 'expected five anchor fields x two v3 representations x two modules, saw ' + cases.length);
  for (const field of ['snapshotPhysicalSha256', 'snapshotPhysicalByteLength', 'logicalSnapshotSha256', 'logicalSnapshotByteLength', 'snapshotEncoding']) {
    const forField = cases.filter((c) => c.missingAnchor === field);
    assert.equal(forField.length, 4, 'anchor ' + field + ' is not covered for both representations in both modules');
    assert.deepEqual([...new Set(forField.map((c) => c.encoding))].sort(), ['gzip', 'identity'],
      'anchor ' + field + ' must be withheld from an identity package too — a gzip-only case can be refused by JSON parse failure instead of by the anchor gate');
  }
  for (const c of cases) g01Refused(c);
});

check('[G01] a binding failure refuses BEFORE the snapshot member is read at all', () => {
  const cases = g01().cases.filter((c) => c.group === 'identity' || c.group === 'anchors');
  assert.ok(cases.length >= 28, 'expected the identity + anchor matrix, saw ' + cases.length);
  for (const c of cases) {
    assert.equal(c.snapshotMemberReads, 0,
      c.key + '/' + c.op + ': the snapshot member was read despite an unbindable trusted state');
  }
});

check('[G01] no substituted byte reached a write payload or survived anywhere in the store', () => {
  const b = g01();
  assert.equal(b.betaPayloads, 0, b.betaPayloads + ' SQL payload(s) carried substituted content');
  assert.equal(b.betaRows, 0, b.betaRows + ' stored row(s) carry substituted content');
});

check('[G01] valid RESTORE controls still reach restore-ready → restored for v1/v2, v3 identity and v3 gzip', () => {
  const controls = g01().controls.filter((c) => c.op === 'restore');
  assert.equal(controls.length, 3, 'expected three restore controls, saw ' + controls.length);
  assert.deepEqual(controls.map((c) => c.encoding).sort(), ['gzip', 'identity', 'identity']);
  for (const c of controls) {
    assert.equal(c.dryDecision, 'restore-ready', c.label + ': the valid control never reached restore-ready — every refusal proof beside it would be vacuous');
    assert.equal(c.execStatus, 'restored', c.label + ': the valid control did not restore');
    assert.equal(c.delta.chats, 1, c.label + ': restore control chat delta');
    assert.equal(c.delta.snapshots, 1, c.label + ': restore control snapshot delta');
    assert.ok(c.delta.turns > 0, c.label + ': restore control inserted no turns');
    assert.equal(c.originalIdsPresent.snapshot, true, c.label + ': restore did not persist the ORIGINAL snapshot id');
  }
});

check('[G01] valid IMPORT controls still reach import-ready → imported under FRESH recovered ids', () => {
  const controls = g01().controls.filter((c) => c.op === 'import');
  assert.equal(controls.length, 3, 'expected three import controls, saw ' + controls.length);
  assert.deepEqual(controls.map((c) => c.encoding).sort(), ['gzip', 'identity', 'identity']);
  for (const c of controls) {
    assert.equal(c.dryDecision, 'import-ready', c.label + ': the valid control never reached import-ready — every refusal proof beside it would be vacuous');
    assert.equal(c.execStatus, 'imported', c.label + ': the valid control did not import');
    assert.equal(c.delta.chats, 1, c.label + ': import control chat delta');
    assert.equal(c.delta.snapshots, 1, c.label + ': import control snapshot delta');
    assert.ok(c.delta.turns > 0, c.label + ': import control inserted no turns');
    assert.equal(c.freshId, true, c.label + ': import reused the package original snapshot id');
    assert.equal(c.originalIdsPresent.chat, false, c.label + ': import-as-new created the package ORIGINAL chat id');
  }
});

check('[G01] both recovery controls persisted the ALPHA payload, and no control carries substituted text', () => {
  const b = g01();
  for (const c of b.controls) {
    assert.ok(c.persistedSnapId, c.label + ': no persisted snapshot to read back');
    assert.ok(c.persistedTurns.length > 0, c.label + ': persisted snapshot has no turns');
    assert.ok(c.persistedTurns.some((t) => t.includes(c.alphaText)),
      c.label + ': the persisted turns do not carry the ALPHA payload — the control proves nothing about content');
    assert.ok(!c.persistedTurns.some((t) => t.includes(b.betaMark)),
      c.label + ': a control persisted substituted content');
  }
});

check('[G01] every binding scenario drove the real dry-run and execution entry points of the real modules', () => {
  const b = g01();
  const all = b.cases.concat(b.controls);
  assert.ok(all.length >= 50, 'expected the full permanent binding matrix, saw ' + all.length);
  for (const c of all) {
    assert.ok(c.dryRunCalled && c.executionCalled, c.key + '/' + c.op + ': a scenario skipped an entry point');
    assert.ok(c.integrityCalls >= 2, c.key + '/' + c.op + ': fewer than two trusted enumerations were performed');
  }
  assert.deepEqual(
    [...new Set(all.map((c) => c.op))].sort(), ['import', 'restore'],
    'the permanent matrix must cover BOTH governed modules');
});

console.log('');
if (FAIL.length) {
  console.error(`[archive-import-recovery-harness] ${FAIL.length} failed, ${PASS.length} passed`);
  process.exit(1);
} else {
  console.log(`[archive-import-recovery-harness] PASS ${PASS.length} checks`);
  process.exit(0);
}
