#!/usr/bin/env node
/*
 * P02 imported-chat timestamp authority: Created / Added to Studio / Last turn.
 *
 * Live proof on b5bdb9b1 after the metadata self-heal: the sidebar read
 * "Unfiled · 1 answer · Created unknown · Added to Studio · Last turn unknown"
 * while SQLite held chats.created_at = 1789220817769 (the canonical snapshot
 * time), meta.importedAt = 1789236742130 (the import moment) and
 * chats.last_message_at = 0, with the imported turns carrying ChatGPT-origin
 * meta.createTime seconds. Three defects composed:
 *   1. S0F1c projectChatToCompactRow never carried chat.createdAt /
 *      chat.lastMessageAt / meta.importedAt into the Library Index row;
 *   2. the shared LibraryIndexCore string-normalizes the epoch values it does
 *      carry, and studio.js projectLibraryIndexRowToWorkbenchInput.toIso
 *      accepted numbers only - numeric epoch strings were discarded;
 *   3. the importer never derived last_message_at from the canonical per-turn
 *      time meta it persists, so no last-turn authority existed at all.
 *
 * This proof drives the REAL importer + runtime (already-applied self-heal),
 * the REAL Library Index module and the REAL studio.js seam functions on the
 * live row's exact authorities, and asserts each label resolves from its own
 * authority - never from updatedAt.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const sources = {
  chats: read('src-surfaces-base/studio/store/chats.tauri.js'),
  snapshots: read('src-surfaces-base/studio/store/snapshots.tauri.js'),
  importer: read('src-surfaces-base/studio/ingestion/import-bundle.tauri.js'),
  projection: read('src-surfaces-base/studio/sync/sync-object-projection.tauri.js'),
  localSource: read('src-surfaces-base/studio/sync/sync-object-local-source.tauri.js'),
  runtime: read('src-surfaces-base/studio/sync/sync-object-runtime.tauri.js'),
  libraryIndexCore: read('shared/library/library-index-core.js'),
  libraryIndex: read('src-surfaces-base/studio/S0F1c. 🎬 Library Index - Studio.js'),
  studio: read('src-surfaces-base/studio/studio.js'),
};

const failures = [];
let assertions = 0;
const check = (condition, label) => { assertions += 1; if (!condition) failures.push(label); };
const equal = (actual, expected, label) =>
  check(actual === expected, `${label} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);

/* ── the live row's authorities ─────────────────────────────────────────── */
const OBJECT_ID = '6aa5578d-993c-83eb-b8de-5547574db413';
const SNAPSHOT_ID = 'snap_1789220817769_82mb267m';
const REVISION_ID = 'p02-40dd5602757178f62d67f2a130588e57';
const WRITER = 'studio-chrome:mv3-chrome:idb-archive:12345678-1234-4abc-8def-1234567890ab';
const CREATED_AT_MS = 1789220817769;                 /* chats.created_at (canonical snapshot createdAt) */
const CREATED_AT_ISO = '2026-09-12T13:46:57.769Z';
const IMPORTED_AT_MS = 1789236742130;                /* meta.importedAt */
const IMPORTED_AT_ISO = '2026-09-12T18:12:22.130Z';
const USER_CREATE_TIME_S = 1789220763.324;           /* snapshot_turns[0].meta.createTime (seconds) */
const ASSISTANT_CREATE_TIME_S = 1789220764.914179;   /* snapshot_turns[1].meta.createTime (seconds) */
const LAST_TURN_MS = Math.round(ASSISTANT_CREATE_TIME_S * 1000); /* 1789220764914 */
const LAST_TURN_ISO = '2026-09-12T13:46:04.914Z';
const LIVE_UPDATED_AT_MS = 1789236742145;            /* chats.updated_at of the live row before the self-heal */

/* ── schema + profile (the apply-idempotency / self-heal harness) ───────── */
function installSchema(db) {
  db.exec(`
    CREATE TABLE chats (
      id TEXT PRIMARY KEY, source_id TEXT UNIQUE, title TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL DEFAULT 0, last_message_at INTEGER NOT NULL DEFAULT 0, message_count INTEGER NOT NULL DEFAULT 0,
      user_turn_count INTEGER NOT NULL DEFAULT 0, assistant_turn_count INTEGER NOT NULL DEFAULT 0, is_pinned INTEGER NOT NULL DEFAULT 0,
      is_archived INTEGER NOT NULL DEFAULT 0, is_starred INTEGER NOT NULL DEFAULT 0, is_deleted INTEGER NOT NULL DEFAULT 0,
      folder_id TEXT, category_id TEXT, project_id TEXT NOT NULL DEFAULT '', current_leaf_id TEXT, import_batch_id TEXT,
      meta_json TEXT NOT NULL DEFAULT '{}', is_saved INTEGER NOT NULL DEFAULT 0, is_linked INTEGER NOT NULL DEFAULT 0,
      linked_at INTEGER NOT NULL DEFAULT 0, linked_from TEXT NOT NULL DEFAULT '', link_source_href TEXT NOT NULL DEFAULT '',
      href TEXT, normalized_href TEXT, snapshot_count INTEGER NOT NULL DEFAULT 0, last_snapshot_id TEXT,
      last_captured_at INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE snapshots (
      id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, title TEXT NOT NULL DEFAULT '', digest TEXT, message_count INTEGER NOT NULL DEFAULT 0,
      pinned INTEGER NOT NULL DEFAULT 0, legacy INTEGER NOT NULL DEFAULT 0, captured_at INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL DEFAULT 0, meta_json TEXT NOT NULL DEFAULT '{}'
    );
    CREATE INDEX idx_snapshots_chat_id ON snapshots(chat_id);
    CREATE TABLE snapshot_turns (
      snapshot_id TEXT NOT NULL, turn_idx INTEGER NOT NULL, role TEXT NOT NULL, outer_html TEXT NOT NULL DEFAULT '',
      text TEXT NOT NULL DEFAULT '', meta_json TEXT NOT NULL DEFAULT '{}', PRIMARY KEY(snapshot_id, turn_idx)
    );
    CREATE TABLE sync_object_state (
      sync_peer_id TEXT NOT NULL, object_domain TEXT NOT NULL CHECK (object_domain <> ''), object_id TEXT NOT NULL,
      last_published_revision_id TEXT, last_published_revision_blob_sha256 TEXT,
      last_applied_revision_id TEXT, last_applied_revision_blob_sha256 TEXT,
      remote_head_strong_etag TEXT, remote_head_revision_blob_sha256 TEXT,
      pending_operation TEXT, operation_phase TEXT, operation_token TEXT,
      owner_boot_id TEXT, owner_context_id TEXT, owner_token TEXT,
      intended_object_key TEXT, intended_revision_id TEXT, intended_payload_sha256 TEXT, intended_revision_blob_sha256 TEXT,
      convergence_watermark_sha256 TEXT, consumed_revision_blob_sha256 TEXT,
      last_conflict_class TEXT, last_error_code TEXT,
      last_published_payload_sha256 TEXT, last_applied_payload_sha256 TEXT,
      last_converged_direction TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY(sync_peer_id, object_domain, object_id)
    );
    CREATE TABLE sync_inbound_revision_observations (
      key TEXT PRIMARY KEY, schema TEXT NOT NULL, peer_object_key TEXT NOT NULL,
      object_id TEXT NOT NULL, object_key_sha256_hex TEXT NOT NULL,
      revision_id TEXT NOT NULL, revision_key_sha256_hex TEXT NOT NULL,
      parent_revision_id TEXT, parent_key TEXT NOT NULL,
      admission_disposition TEXT NOT NULL, admission_reason TEXT NOT NULL,
      canonical_head_bytes BLOB NOT NULL, canonical_revision_bytes BLOB NOT NULL,
      head_sha256_hex TEXT NOT NULL, revision_blob_sha256_hex TEXT NOT NULL,
      payload_sha256_hex TEXT NOT NULL, writer_sync_peer_id_sha256_hex TEXT NOT NULL,
      observed_state TEXT NOT NULL, apply_state TEXT NOT NULL,
      first_observed_at TEXT NOT NULL, last_observed_at TEXT NOT NULL,
      observation_count INTEGER NOT NULL, admitted_at TEXT NOT NULL
    );
  `);
}

function makeProfile(dbPath, syncPeerId) {
  const db = new DatabaseSync(dbPath);
  installSchema(db);
  const sql = {
    async execute(query, values = []) { const r = db.prepare(query).run(...values); return [Number(r.changes), Number(r.lastInsertRowid || 0)]; },
    async select(query, values = []) { return db.prepare(query).all(...values); },
  };
  const listeners = new Map();
  const sandbox = {
    console, crypto: crypto.webcrypto, TextEncoder, TextDecoder, structuredClone, setTimeout, clearTimeout, Date, performance,
    CustomEvent: class CustomEvent { constructor(type, init) { this.type = type; this.detail = init && init.detail; } },
    chrome: { runtime: {}, storage: { local: { get(_k, cb) { cb({}); }, set(_v, cb) { if (cb) cb(); } } } },
    document: { querySelectorAll() { return []; } },
    addEventListener(type, fn) { listeners.set(type, fn); },
    dispatchEvent() { return true; },
    H2O: { Studio: { platform: { env: { isTauri: true }, __sqliteStatus: () => ({ backend: 'sqlite', ready: true }) }, store: {} }, Library: {} },
  };
  sandbox.__TAURI_INTERNALS__ = { invoke: async (command, args) => {
    if (command === 'plugin:sql|execute') return sql.execute(args.query, args.values);
    if (command === 'plugin:sql|select') return sql.select(args.query, args.values);
    throw new Error(`unexpected command: ${command}`);
  } };
  sandbox.globalThis = sandbox;
  sandbox.window = sandbox;
  sandbox.H2O.Studio.store.__registerEntity = function (name, api) { sandbox.H2O.Studio.store[name] = api; };
  vm.createContext(sandbox);
  vm.runInContext(sources.chats, sandbox, { filename: 'chats.tauri.js' });
  vm.runInContext(sources.snapshots, sandbox, { filename: 'snapshots.tauri.js' });
  vm.runInContext(sources.importer, sandbox, { filename: 'import-bundle.tauri.js' });
  vm.runInContext(sources.projection, sandbox, { filename: 'sync-object-projection.tauri.js' });
  vm.runInContext(sources.localSource, sandbox, { filename: 'sync-object-local-source.tauri.js' });
  vm.runInContext(sources.runtime, sandbox, { filename: 'sync-object-runtime.tauri.js' });
  const authorizedWrites = [];
  sandbox.H2O.Desktop.Sync = { executeAuthorizedSqlite: async ({ statements, reason }) => {
    let rowsAffected = 0;
    for (const statement of statements) { const r = await sql.execute(statement.query, statement.values); rowsAffected += Number(r[0]) || 0; }
    authorizedWrites.push({ reason, rowsAffected, query: statements.map((s) => s.query).join(';') });
    return { ok: true, executed: true, rowsAffected };
  } };
  return { db, sql, sandbox, stores: sandbox.H2O.Studio.store, syncPeerId, authorizedWrites };
}

/* The REAL Library Index module, booted on the profile's stores in Desktop mode. */
async function bootLibraryIndex(profile) {
  const sb = profile.sandbox;
  vm.runInContext(sources.libraryIndexCore, sb, { filename: 'library-index-core.js' });
  check(!!sb.H2O.Library.LibraryIndexCore, 'harness: shared LibraryIndexCore loaded');
  for (const name of ['folders', 'labels', 'tags', 'categories']) {
    if (!sb.H2O.Studio.store[name]) sb.H2O.Studio.store[name] = { isReady: () => true, subscribe() { return () => {}; } };
  }
  sb.H2O.LibraryCore = { registerOwner() {}, registerService() {}, getService() { return null; } };
  vm.runInContext(sources.libraryIndex, sb, { filename: 'S0F1c-library-index.js' });
  check(!!sb.H2O.LibraryIndex && typeof sb.H2O.LibraryIndex.refresh === 'function', 'harness: real Library Index module booted');
  await sb.H2O.LibraryIndex.ready;
  return sb.H2O.LibraryIndex;
}

/* The REAL studio.js seam functions, sliced by name from the shell source.
 * The slicer walks the source with a small lexer (quotes, template literals
 * with ${} expressions, line/block comments) so a template in a default
 * parameter (pluralize) or a label template (rowMetaParts) cannot unbalance
 * the brace count. A mis-slice would surface as a SyntaxError below. */
function sliceFunction(source, name) {
  const marker = `\nfunction ${name}(`;
  const start = source.indexOf(marker);
  if (start < 0) throw new Error(`studio.js: function ${name} not found`);
  let i = start + marker.length;
  const stack = [];           /* 'sq' | 'dq' | 'tpl' | 'expr' */
  let paren = 1;              /* inside the parameter list */
  let depth = 0;              /* body braces */
  let inBody = false;
  for (; i < source.length; i += 1) {
    const ch = source[i];
    const next = source[i + 1];
    const top = stack[stack.length - 1];
    if (top === 'sq') { if (ch === '\\') i += 1; else if (ch === "'") stack.pop(); continue; }
    if (top === 'dq') { if (ch === '\\') i += 1; else if (ch === '"') stack.pop(); continue; }
    if (top === 'tpl') {
      if (ch === '\\') i += 1;
      else if (ch === '`') stack.pop();
      else if (ch === '$' && next === '{') { stack.push('expr'); stack.push(0); i += 1; }
      continue;
    }
    /* code, possibly nested inside a template expression */
    if (ch === "'") { stack.push('sq'); continue; }
    if (ch === '"') { stack.push('dq'); continue; }
    if (ch === '`') { stack.push('tpl'); continue; }
    if (ch === '/' && next === '/') { i = source.indexOf('\n', i); if (i < 0) break; continue; }
    if (ch === '/' && next === '*') { i = source.indexOf('*/', i) + 1; continue; }
    if (typeof top === 'number') {
      /* inside ${ ... }: balance braces until the expression closes */
      if (ch === '{') stack[stack.length - 1] = top + 1;
      else if (ch === '}') { if (top === 0) { stack.pop(); stack.pop(); } else stack[stack.length - 1] = top - 1; }
      continue;
    }
    if (!inBody) {
      if (ch === '(') paren += 1;
      else if (ch === ')') paren -= 1;
      else if (ch === '{' && paren === 0) { inBody = true; depth = 1; }
      continue;
    }
    if (ch === '{') depth += 1;
    else if (ch === '}') { depth -= 1; if (depth === 0) return source.slice(start + 1, i + 1); }
  }
  throw new Error(`studio.js: function ${name} unterminated`);
}
function loadStudioSeam() {
  const names = ['toTimestampMs', 'timestampToIso', 'firstTimestamp', 'messageTimestamp', 'earliestMessageTimestamp',
    'latestMessageTimestamp', 'resolveOriginalChatCreatedAt', 'resolveLastTurnAt', 'resolveStudioAddedAt',
    'projectLibraryIndexRowToWorkbenchInput', 'normalizeWorkbenchRow', 'rowMetaParts', 'fmtDateMeta', 'pluralize', 'toWholeCount'];
  const stubs = `
    function buildExcerptFromMessages(){ return ''; }
    function countAssistantTurns(list){ return (Array.isArray(list) ? list : []).filter((m) => String(m && m.role).toLowerCase() === 'assistant').length; }
    function normalizeSidebarIconColor(v){ return String(v || ''); }
    function normalizeTags(v){ return Array.isArray(v) ? v.slice() : []; }
    function normalizeOriginSource(v){ return v || null; }
    function normalizeProjectRef(v){ return v || null; }
    function normalizeCategoryAssignment(v){ return v || null; }
    function normalizeLabelAssignments(v){ return Array.isArray(v) ? v.slice() : []; }
    function normalizeKeywords(v){ return Array.isArray(v) ? v.slice() : []; }
  `;
  const code = stubs + names.map((n) => sliceFunction(sources.studio, n)).join('\n') +
    '\nglobalThis.__seam = { ' + names.join(', ') + ' };';
  const ctx = { console, Date, Intl };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(code, ctx, { filename: 'studio-seam.js' });
  return ctx.__seam;
}

const strictEmptyRelationships = async () => ({ assets: [], folders: [], labels: [], tags: [] });
const forbidWebDav = {
  async h2o_sync_object_publish_transport() { throw new Error('unexpected WebDAV publish'); },
  async h2o_sync_object_pull_transport() { throw new Error('unexpected WebDAV pull'); },
};
function wire(profile, bootId, extra = {}) {
  profile.sandbox.H2O.Desktop.SyncObjectProjection.__test.setDependencies({ stores: profile.stores, strictRelationshipProbe: strictEmptyRelationships });
  profile.sandbox.H2O.Desktop.SyncObjectRuntime.__test.setDependencies({
    sql: profile.sql, transport: forbidWebDav, stores: profile.stores, syncPeerId: profile.syncPeerId,
    importBundle: profile.sandbox.H2O.Studio.ingestion.importBundle, strictOwnerSchema: true, bootId, ...extra,
  });
}
function countingImporter(profile) {
  const real = profile.sandbox.H2O.Studio.ingestion.importBundle;
  const counter = { calls: 0 };
  return { wrapped: async (...a) => { counter.calls += 1; return real(...a); }, counter };
}

/* The live object: P02 content-only chat whose two turns carry ChatGPT-origin
 * createTime seconds (the exact keep-list the importer persists as turn meta). */
function payload() {
  const turns = [
    { turnIdx: 0, role: 'user', text: 'How do I keep my Mac screen on?', html: '<p>How do I keep my Mac screen on?</p>',
      meta: { userMessageId: 'u-1', createTime: USER_CREATE_TIME_S, userCreateTime: USER_CREATE_TIME_S, messageTimes: { user: USER_CREATE_TIME_S, 'u-1': USER_CREATE_TIME_S } } },
    { turnIdx: 1, role: 'assistant', text: 'Use caffeinate or the Energy settings.', html: '<p>Use caffeinate or the Energy settings.</p>',
      meta: { assistantMessageId: 'a-1', createTime: ASSISTANT_CREATE_TIME_S, assistantCreateTime: ASSISTANT_CREATE_TIME_S, messageTimes: { assistant: ASSISTANT_CREATE_TIME_S, 'a-1': ASSISTANT_CREATE_TIME_S } } },
  ];
  return {
    schema: 'h2o.studio.fullBundle.v2',
    chatArchive: {
      chats: [{
        chatId: OBJECT_ID, title: 'Sync Testing Chat',
        chatIndex: { title: 'Sync Testing Chat', lastSnapshotId: SNAPSHOT_ID, snapshotCount: 1, messageCount: 2, state: { isSaved: true, isLinked: true }, organization: {} },
        snapshots: [{
          snapshotId: SNAPSHOT_ID, chatId: OBJECT_ID, createdAt: CREATED_AT_ISO, messageCount: 2,
          messages: turns.map((t) => ({ order: t.turnIdx, role: t.role, text: t.text })),
          meta: { title: 'Sync Testing Chat', richTurns: turns.map((t) => ({ turnIdx: t.turnIdx, role: t.role, outerHTML: t.html, meta: t.meta })) },
        }],
      }],
      catalogs: { categories: [], labels: [], tags: [] },
    },
    chromeStorageLocal: {}, libraryKv: [],
  };
}
function admittedSource(profile) {
  const canonicalJson = profile.sandbox.H2O.Desktop.SyncObjectProjection.canonicalJson;
  const body = payload();
  const payloadSha = crypto.createHash('sha256').update(canonicalJson(body)).digest('hex');
  const revisionValue = { schema: 'h2o.studio.syncRevision.v2', objectDomain: 'studio.chat.saved-state.v1', objectId: OBJECT_ID, revisionId: REVISION_ID,
    writerSyncPeerId: WRITER, previousRevisionId: null, previousRevisionBlobSha256: null, payloadSha256: payloadSha, payload: body };
  const revisionBlobSha = crypto.createHash('sha256').update(canonicalJson(revisionValue)).digest('hex');
  const source = { readCandidate: async () => {
    const key = await profile.sandbox.H2O.Desktop.SyncObjectProjection.objectKeyHex(OBJECT_ID);
    return { ok: true, headPresent: true, sourceKind: 'p02-admitted-local', sourceVerified: true, sourceStrongVersion: `p02-admission:revision:${revisionBlobSha}`, revisionValue,
      head: { schema: 'h2o.studio.syncHead.v2', objectId: OBJECT_ID, objectKey: key, revisionId: REVISION_ID, payloadSha256: payloadSha, revisionBlobSha256: revisionBlobSha,
        writerSyncPeerId: WRITER, previousRevisionId: null, previousRevisionBlobSha256: null, sourceUpdatedAtIso: CREATED_AT_ISO } };
  } };
  return { source, payloadSha, revisionBlobSha };
}
const apply = (profile) => profile.sandbox.H2O.Desktop.SyncObjectRuntime.applyNextAdmittedP02Revision(OBJECT_ID);
const chatRow = (profile) => { const r = profile.db.prepare('SELECT * FROM chats WHERE id = ?').get(OBJECT_ID); return r ? { ...r, meta: JSON.parse(r.meta_json || '{}') } : null; };
const canonicalRows = (profile) => JSON.stringify({
  snapshots: profile.db.prepare('SELECT * FROM snapshots ORDER BY id').all(),
  turns: profile.db.prepare('SELECT * FROM snapshot_turns ORDER BY snapshot_id, turn_idx').all(),
  pointer: profile.db.prepare('SELECT last_snapshot_id, snapshot_count, is_saved, is_linked, folder_id, category_id, title FROM chats WHERE id = ?').get(OBJECT_ID),
});
const anchors = (profile) => JSON.stringify(profile.db.prepare(
  'SELECT last_applied_revision_id, last_applied_revision_blob_sha256, last_applied_payload_sha256, last_converged_direction, convergence_watermark_sha256, consumed_revision_blob_sha256, remote_head_revision_blob_sha256, pending_operation, last_error_code FROM sync_object_state WHERE object_id = ?'
).get(OBJECT_ID));

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'h2o-p02-timestamp-authority-'));
try {
  /* ── A. source contract ─────────────────────────────────────────────── */
  {
    const imp = sources.importer, li = sources.libraryIndex, st = sources.studio;
    check(imp.includes('function deriveTranscriptLastMessageAt(snapshot)') && imp.includes('function turnTimeToEpochMs(value)'),
      'A1 the importer derives the last-turn time from the persisted per-turn time meta with the seconds-vs-ms rule');
    check(imp.includes("lastMessageAt: effectiveLastMessageAt || undefined,") && imp.includes("lastMessageAtSource: lastMessageAtSource,"),
      'A2 the chat patch carries lastMessageAt with provenance');
    check(imp.includes("maybeSetMax('lastMessageAt');") && imp.includes("setColumn('last_message_at'"),
      'A3 existing rows populate / advance last_message_at through the identity-gated evidence writer, never lower it');
    check(imp.includes("'createdAt', 'lastMessageAt'];"), 'A4 the already-applied self-heal whitelist includes lastMessageAt');
    check(imp.includes('if (numericCount(existingMeta.importedAt)) next.meta.importedAt = numericCount(existingMeta.importedAt);'),
      'A5 a replay merge keeps the established importedAt (Studio-add authority)');
    check(li.includes('createdAt: numericCount(chat?.createdAt),') && li.includes('lastMessageAt: numericCount(chat?.lastMessageAt),') &&
      li.includes("studioAddedAt: cleanString(meta.importedFrom) ? numericCount(meta.importedAt) : 0,"),
      'A6 the Desktop Library Index projection carries the three authorities (importedAt only for importer-created rows)');
    check(li.includes('row.createdAt = numericCount(row.createdAt || raw.createdAt);') && li.includes('createdAt: numericCount(r.createdAt),'),
      'A7 ...through normalizeRow and the change signature');
    check(!sources.libraryIndexCore.includes('studioAddedAt') && !sources.libraryIndexCore.includes('lastMessageAt: ensureString'),
      'A8 the shared LibraryIndexCore timestamp representation is untouched');
    check(st.includes('originalCreatedAt: originalCreatedAtIso,') && st.includes('studioAddedAt: studioAddedAtIso,') && st.includes('lastTurnAt: lastTurnAtIso,'),
      'A9 the LI -> Workbench seam projects each authority onto the field its resolver reads first');
    check(st.includes("const numericString = typeof epoch === 'string' && /^\\s*\\d+(?:\\.\\d+)?\\s*$/.test(epoch);") &&
      st.includes('if (!Number.isFinite(value) || value <= 0) return \'\';') && st.includes('const ms = toTimestampMs(value);'),
      'A10 toIso accepts finite positive epoch numbers and numeric epoch strings via toTimestampMs, nothing else (no Date.parse fallback)');
  }

  /* ── B. DB / importer semantics on the real upgrade path ────────────── */
  const profile = makeProfile(path.join(temporary, 'live.db'), 'studio-desktop:live');
  await profile.stores.chats.init(); await profile.stores.snapshots.init();
  const admitted = admittedSource(profile);
  wire(profile, 'studio-desktop:live:boot-1', { p02LocalSource: admitted.source });
  const first = await apply(profile);
  equal(first?.applied, true, 'B1 first import applies the canonical revision');
  const fresh = chatRow(profile);
  equal(fresh.created_at, CREATED_AT_MS, 'B2 first import: createdAt = canonical snapshot time');
  equal(fresh.last_message_at, LAST_TURN_MS, 'B3 first import: last_message_at populated from the latest actual turn time (seconds -> ms)');
  equal(fresh.meta.lastMessageAtSource, 'transcript-turns', 'B4 first import: last-turn provenance');
  check(Number.isInteger(fresh.meta.importedAt) && fresh.meta.importedAt > 0, 'B5 first import: importedAt stamped');
  /* the live row as it stood on b5bdb9b1 after the metadata self-heal: counts
   * and createdAt repaired, last_message_at still 0, importedAt = 18:12:22.130Z */
  profile.db.prepare("UPDATE chats SET last_message_at = 0, updated_at = ?, meta_json = json_remove(json_set(meta_json, '$.importedAt', ?), '$.lastMessageAtSource') WHERE id = ?")
    .run(LIVE_UPDATED_AT_MS, IMPORTED_AT_MS, OBJECT_ID);
  const live = chatRow(profile);
  check(live.last_message_at === 0 && live.meta.importedAt === IMPORTED_AT_MS && live.created_at === CREATED_AT_MS && live.user_turn_count === 1 && live.meta.answerCount === 1,
    'B6 fixture: the live row shape (createdAt canonical, counts 1/1, last_message_at 0, importedAt 18:12:22.130Z)');
  const canonicalBefore = canonicalRows(profile);
  const anchorsBefore = anchors(profile);
  const counting = countingImporter(profile);
  wire(profile, 'studio-desktop:live:boot-2', { p02LocalSource: admitted.source, importBundle: counting.wrapped });
  const replay = await apply(profile);
  equal(replay?.unchangedNoOp, true, 'B7 replay stays already-applied');
  equal(counting.counter.calls, 0, 'B8 canonical importer calls = 0');
  equal(replay?.metadataReconciled, true, 'B9 the self-heal reconciled the row');
  equal(JSON.stringify(replay?.metadataReconciliation?.chats?.[0]?.fields), JSON.stringify(['lastMessageAt']), 'B10 ...exactly lastMessageAt');
  equal(replay?.metadataReconciliation?.chats?.[0]?.lastMessageAt?.previous, 0, 'B11 provenance: previous 0');
  equal(replay?.metadataReconciliation?.chats?.[0]?.lastMessageAt?.next, LAST_TURN_MS, 'B12 provenance: next = latest actual turn');
  equal(replay?.metadataReconciliation?.chats?.[0]?.lastMessageAt?.source, 'transcript-turns', 'B13 provenance: source');
  const healed = chatRow(profile);
  equal(healed.created_at, CREATED_AT_MS, 'B14 createdAt authority = 2026-09-12T13:46:57.769Z');
  equal(new Date(healed.created_at).toISOString(), CREATED_AT_ISO, 'B14b ...as ISO');
  equal(healed.meta.importedAt, IMPORTED_AT_MS, 'B15 Studio-add authority (meta.importedAt) preserved = 2026-09-12T18:12:22.130Z');
  equal(new Date(healed.meta.importedAt).toISOString(), IMPORTED_AT_ISO, 'B15b ...as ISO');
  equal(healed.last_message_at, LAST_TURN_MS, 'B16 last-turn authority = latest actual turn = 2026-09-12T13:46:04.914Z');
  equal(new Date(healed.last_message_at).toISOString(), LAST_TURN_ISO, 'B16b ...as ISO');
  check(healed.last_message_at !== healed.updated_at && healed.last_message_at !== LIVE_UPDATED_AT_MS, 'B17 last_message_at is NOT updatedAt');
  equal(healed.meta.lastMessageAtSource, 'transcript-turns', 'B18 provenance persisted');
  equal(healed.folder_id || '', '', 'B19 folder stays Unfiled');
  equal(canonicalRows(profile), canonicalBefore, 'B20 transcript / snapshot / turns / pointer unchanged');
  equal(anchors(profile), anchorsBefore, 'B21 Sync anchors unchanged');
  const writes = profile.authorizedWrites.filter((w) => w.reason === 'f19.chrome-desktop-existing-evidence');
  equal(writes.length, 1, 'B22 one identity-gated write');
  check(/last_message_at = \?/.test(writes[0]?.query) && !/created_at = \?/.test(writes[0]?.query) && !/user_turn_count = \?/.test(writes[0]?.query) && !/folder_id/.test(writes[0]?.query),
    'B23 ...naming only last_message_at (+ updated_at, meta_json)');
  const rowAfterHeal = JSON.stringify(profile.db.prepare('SELECT * FROM chats WHERE id = ?').get(OBJECT_ID));
  const second = await apply(profile);
  equal(second?.metadataReconciled, false, 'B24 second self-heal is a no-op');
  equal(second?.metadataReconciliation?.chats?.[0]?.status, 'noop', 'B24b ...reported noop');
  equal(JSON.stringify(profile.db.prepare('SELECT * FROM chats WHERE id = ?').get(OBJECT_ID)), rowAfterHeal, 'B25 row byte-identical after the second replay');
  equal(anchors(profile), anchorsBefore, 'B26 anchors still unchanged');
  equal(counting.counter.calls, 0, 'B27 importer calls still 0 (repository writes 0: the local source was only read)');

  /* ── C. Library Index carries all three authorities ─────────────────── */
  const libraryIndex = await bootLibraryIndex(profile);
  await libraryIndex.refresh('validator');
  const liRow = libraryIndex.getAll().find((r) => r.chatId === OBJECT_ID);
  check(!!liRow, 'C1 the Library Index projects the chat');
  equal(liRow?.createdAt, CREATED_AT_MS, 'C2 LI row carries createdAt (epoch ms)');
  equal(liRow?.studioAddedAt, IMPORTED_AT_MS, 'C3 LI row carries studioAddedAt = meta.importedAt (importer-created row)');
  equal(liRow?.lastMessageAt, LAST_TURN_MS, 'C4 LI row carries lastMessageAt = latest actual turn');
  equal(typeof liRow?.updatedAt, 'string', 'C5 the shared core still string-normalizes updatedAt (representation untouched)');
  check(String(liRow?.updatedAt) !== String(LAST_TURN_MS), 'C6 LI updatedAt is a different value from the last-turn authority');
  equal(liRow?.answerCount, 1, 'C7 counts still carried');
  equal(liRow?.folderId, '', 'C8 folder still Unfiled');
  equal(liRow?.view, 'saved', 'C9 saved row');

  /* ── D. Workbench receives and the renderer resolves each authority ─── */
  const seam = loadStudioSeam();
  const input = seam.projectLibraryIndexRowToWorkbenchInput(liRow);
  check(!!input, 'D1 the LI row projects to a Workbench input');
  equal(input?.originalCreatedAt, CREATED_AT_ISO, 'D2 Workbench input originalCreatedAt = createdAt authority');
  equal(input?.studioAddedAt, IMPORTED_AT_ISO, 'D3 Workbench input studioAddedAt = importedAt authority');
  equal(input?.lastTurnAt, LAST_TURN_ISO, 'D4 Workbench input lastTurnAt = latest-turn authority');
  check(input?.updatedAt && input.updatedAt !== input.lastTurnAt, 'D5 updatedAt (numeric string survived) is a distinct, later value');
  const wb = seam.normalizeWorkbenchRow(input);
  equal(wb?.originalCreatedAt, CREATED_AT_ISO, 'D6 normalizeWorkbenchRow keeps Created from createdAt authority');
  equal(wb?.studioAddedAt, IMPORTED_AT_ISO, 'D7 ...Added to Studio from importedAt authority');
  equal(wb?.lastTurnAt, LAST_TURN_ISO, 'D8 ...Last turn from the latest-turn authority, NOT updatedAt');
  check(wb?.lastTurnAt !== wb?.updatedAt, 'D9 lastTurnAt !== updatedAt');
  const parts = seam.rowMetaParts(wb);
  equal(parts[0], 'Unfiled', 'D10 renderer: folder Unfiled');
  equal(parts[1], '1 answer', 'D11 renderer: 1 answer');
  equal(parts[2], `Created ${seam.fmtDateMeta(CREATED_AT_ISO)}`, 'D12 renderer: Created from the createdAt authority');
  equal(parts[3], `Added ${seam.fmtDateMeta(IMPORTED_AT_ISO)}`, 'D13 renderer: Added from the importedAt authority');
  equal(parts[4], `Last turn ${seam.fmtDateMeta(LAST_TURN_ISO)}`, 'D14 renderer: Last turn from the latest-turn authority');
  check(!parts.some((p) => /unknown/i.test(p)) && parts[3] !== 'Added to Studio', 'D15 no label is unknown / dateless');
  /* the resolvers must not fall back onto updatedAt even when it is much later */
  const laterUpdated = { ...liRow, updatedAt: String(LAST_TURN_MS + 30 * 86400000) };
  const wbLater = seam.normalizeWorkbenchRow(seam.projectLibraryIndexRowToWorkbenchInput(laterUpdated));
  equal(wbLater?.lastTurnAt, LAST_TURN_ISO, 'D16 a later updatedAt does not move Last turn');
  equal(wbLater?.originalCreatedAt, CREATED_AT_ISO, 'D17 ...nor Created');
  equal(wbLater?.studioAddedAt, IMPORTED_AT_ISO, 'D18 ...nor Added to Studio');
  check(seam.fmtDateMeta(CREATED_AT_ISO) === seam.fmtDateMeta(LAST_TURN_ISO) && seam.fmtDateMeta(IMPORTED_AT_ISO) === seam.fmtDateMeta(CREATED_AT_ISO),
    'D19 day granularity shows the same date for all three - which is why the ISO authorities are asserted separately above');

  /* ── E. toIso coercion at the seam ──────────────────────────────────── */
  const probe = (value) => seam.projectLibraryIndexRowToWorkbenchInput({ chatId: 'c', snapshotId: 's', createdAt: value, studioAddedAt: value, lastMessageAt: value, updatedAt: value })?.lastTurnAt;
  equal(probe(String(LAST_TURN_MS)), LAST_TURN_ISO, 'E1 numeric epoch string survives LI -> Workbench coercion');
  equal(probe(LAST_TURN_MS), LAST_TURN_ISO, 'E2 finite epoch number still works');
  equal(probe(String(ASSISTANT_CREATE_TIME_S)), LAST_TURN_ISO, 'E3 a numeric seconds string follows the canonical toTimestampMs rule');
  equal(probe('12 Sep 2026'), '', 'E4 free text is rejected');
  equal(probe('2026-09-12T13:46:04.914Z'), '', 'E5 an ISO string is not an epoch string at this seam (no Date.parse leak)');
  equal(probe(''), '', 'E6 empty is rejected');
  equal(probe('0'), '', 'E7 zero is rejected');
  equal(probe('-5'), '', 'E8 negative is rejected');
  equal(probe(NaN), '', 'E9 NaN is rejected');
  equal(probe(null), '', 'E10 null is rejected');

  /* ── F. an existing correct non-zero lastMessageAt is never degraded ── */
  {
    const p = makeProfile(path.join(temporary, 'stronger.db'), 'studio-desktop:stronger');
    await p.stores.chats.init(); await p.stores.snapshots.init();
    const a = admittedSource(p);
    wire(p, 'studio-desktop:stronger:boot-1', { p02LocalSource: a.source });
    await apply(p);
    const later = LAST_TURN_MS + 3600000;
    p.db.prepare('UPDATE chats SET last_message_at = ? WHERE id = ?').run(later, OBJECT_ID);
    const before = JSON.stringify(p.db.prepare('SELECT * FROM chats WHERE id = ?').get(OBJECT_ID));
    const r = await apply(p);
    equal(r?.unchangedNoOp, true, 'F1 replay already-applied');
    equal(r?.metadataReconciled, false, 'F2 nothing reconciled');
    equal(p.db.prepare('SELECT last_message_at FROM chats WHERE id = ?').get(OBJECT_ID).last_message_at, later, 'F3 a later existing last_message_at is not lowered');
    equal(JSON.stringify(p.db.prepare('SELECT * FROM chats WHERE id = ?').get(OBJECT_ID)), before, 'F4 row byte-identical');
    /* and the direct importer replay (evidence merge) honours the same rule */
    const merged = await p.sandbox.H2O.Studio.ingestion.importBundle(payload(), 'merge', { round2aContentOnly: true });
    equal(merged?.ok, true, 'F5 importer replay ok');
    equal(p.db.prepare('SELECT last_message_at FROM chats WHERE id = ?').get(OBJECT_ID).last_message_at, later, 'F6 importer replay does not lower it either');
    equal(JSON.parse(p.db.prepare('SELECT meta_json FROM chats WHERE id = ?').get(OBJECT_ID).meta_json).importedAt,
      JSON.parse(before).meta_json ? JSON.parse(JSON.parse(before).meta_json).importedAt : undefined, 'F7 importer replay keeps the established importedAt');
  }

  /* ── G. a native / non-imported row is untouched, and never gets a Studio-add time from capture ── */
  {
    const p = makeProfile(path.join(temporary, 'captured.db'), 'studio-desktop:captured');
    await p.stores.chats.init(); await p.stores.snapshots.init();
    const a = admittedSource(p);
    const capturedAt = CREATED_AT_MS - 86400000;
    await p.stores.chats.upsert({ chatId: OBJECT_ID, title: 'Captured locally', lastSnapshotId: SNAPSHOT_ID, snapshotCount: 1, isSaved: true, isLinked: true, createdAt: capturedAt, meta: { capturedBy: 'native' } });
    const body = payload().chatArchive.chats[0].snapshots[0];
    await p.stores.snapshots.create({ snapshotId: SNAPSHOT_ID, chatId: OBJECT_ID, title: body.meta.title, capturedAt: CREATED_AT_MS, updatedAt: CREATED_AT_MS, messageCount: 2, meta: {},
      turns: body.meta.richTurns.map((rich, i) => ({ turnIdx: rich.turnIdx, role: rich.role, text: body.messages[i].text, outerHtml: rich.outerHTML, meta: rich.meta })) });
    const now = new Date().toISOString();
    p.db.prepare('INSERT INTO sync_object_state (sync_peer_id, object_domain, object_id, last_applied_revision_id, last_applied_revision_blob_sha256, last_applied_payload_sha256, last_converged_direction, convergence_watermark_sha256, consumed_revision_blob_sha256, remote_head_strong_etag, remote_head_revision_blob_sha256, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(p.syncPeerId, 'studio.chat.saved-state.v1', OBJECT_ID, REVISION_ID, a.revisionBlobSha, a.payloadSha, 'applied', a.revisionBlobSha, a.revisionBlobSha, `p02-admission:revision:${a.revisionBlobSha}`, a.revisionBlobSha, now, now);
    const seed = JSON.stringify(p.db.prepare('SELECT * FROM chats WHERE id = ?').get(OBJECT_ID));
    const counting2 = countingImporter(p);
    wire(p, 'studio-desktop:captured:boot-1', { p02LocalSource: a.source, importBundle: counting2.wrapped });
    const r = await apply(p);
    equal(r?.unchangedNoOp, true, 'G1 replay already-applied');
    equal(r?.metadataReconciliation?.chats?.[0]?.code, 'not-importer-created', 'G2 captured row refused by provenance');
    equal(JSON.stringify(p.db.prepare('SELECT * FROM chats WHERE id = ?').get(OBJECT_ID)), seed, 'G3 captured row byte-identical (last_message_at stays 0, createdAt untouched)');
    equal(counting2.counter.calls, 0, 'G4 importer calls 0');
    const li = await bootLibraryIndex(p);
    await li.refresh('validator');
    const row = li.getAll().find((x) => x.chatId === OBJECT_ID);
    equal(row?.createdAt, capturedAt, 'G5 LI carries the captured row\'s own createdAt');
    equal(row?.studioAddedAt, 0, 'G6 no Studio-add authority is invented from capture time');
    equal(row?.lastMessageAt, 0, 'G7 no last-turn authority is invented');
    const wbc = seam.normalizeWorkbenchRow(seam.projectLibraryIndexRowToWorkbenchInput(row));
    equal(wbc?.originalCreatedAt, new Date(capturedAt).toISOString(), 'G8 Created resolves from the captured row\'s createdAt');
    equal(wbc?.studioAddedAt, wbc?.createdAt, 'G9 Added keeps the pre-existing capture-time fallback for native rows (unchanged behaviour)');
  }
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}

if (failures.length) {
  console.error(JSON.stringify({ verdict: 'P02_IMPORTED_CHAT_TIMESTAMP_AUTHORITY_FAIL', assertions, failures }, null, 2));
  process.exit(1);
}
console.log(JSON.stringify({
  verdict: 'P02_IMPORTED_CHAT_TIMESTAMP_AUTHORITY_PASS',
  assertions,
  proves: 'Created (chats.createdAt), Added to Studio (meta.importedAt) and Last turn (latest actual turn time) are three distinct authorities: derived/persisted by the importer and the already-applied self-heal, carried by the Desktop Library Index, coerced (numbers and numeric strings) at the LI -> Workbench seam and rendered without collapsing onto updatedAt; captured rows untouched; anchors and canonical content unchanged',
}, null, 2));
