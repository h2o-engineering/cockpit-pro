#!/usr/bin/env node
/*
 * P02 imported-chat sidebar metadata — answer/turn counts and createdAt.
 *
 * Live proof on canonical main 8599d8f4: Chrome P02 publication, Desktop
 * Receive and Desktop Apply all passed and the transcript rendered, but the
 * imported chat's sidebar read "0 answers · Created unknown". The canonical
 * content-only P02 projection emits chatIndex.messageCount, snapshot.createdAt
 * and the messages with their roles, but no answerCount / turnCount /
 * userTurnCount / assistantTurnCount and no chat createdAt. The Desktop
 * importer derived those fields from the index only, so the row imported
 * with zero counts and the chats store stamped the import moment as
 * createdAt.
 *
 * This proof drives the REAL importer against a REAL SQLite-backed chats /
 * snapshots store with a P02-shaped content-only payload and asserts the
 * repaired row. It never touches folders, relationships or any repository:
 * the content-only contract is unchanged and "Unfiled" stays by design.
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const sources = {
  chats: read('src-surfaces-base/studio/store/chats.tauri.js'),
  snapshots: read('src-surfaces-base/studio/store/snapshots.tauri.js'),
  importer: read('src-surfaces-base/studio/ingestion/import-bundle.tauri.js'),
};

const failures = [];
let assertions = 0;
const check = (condition, label) => { assertions += 1; if (!condition) failures.push(label); };
const equal = (actual, expected, label) =>
  check(actual === expected, `${label} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);

/* Same canonical DDL the apply-idempotency proof installs (lib.rs migrations,
 * content tables only). */
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
  `);
}

function makeDesktop() {
  const db = new DatabaseSync(':memory:');
  installSchema(db);
  const sql = {
    async execute(query, values = []) { const r = db.prepare(query).run(...values); return [Number(r.changes), Number(r.lastInsertRowid || 0)]; },
    async select(query, values = []) { return db.prepare(query).all(...values); },
  };
  const sandbox = {
    console, crypto: crypto.webcrypto, TextEncoder, TextDecoder, structuredClone, setTimeout, clearTimeout,
    chrome: { runtime: {}, storage: { local: { get(_k, cb) { cb({}); }, set(_v, cb) { if (cb) cb(); } } } },
    H2O: { Studio: { platform: { __sqliteStatus: () => ({ backend: 'sqlite', ready: true }) }, store: {} } },
  };
  sandbox.__TAURI_INTERNALS__ = { invoke: async (command, args) => {
    if (command === 'plugin:sql|execute') return sql.execute(args.query, args.values);
    if (command === 'plugin:sql|select') return sql.select(args.query, args.values);
    throw new Error(`unexpected command: ${command}`);
  } };
  sandbox.globalThis = sandbox;
  sandbox.H2O.Studio.store.__registerEntity = function (name, api) { sandbox.H2O.Studio.store[name] = api; };
  /* Existing-row evidence is written through the Desktop authorized SQLite
   * writer (identity-gated in the real app); the apply-idempotency proof
   * stubs it the same way - execute the statements, report rowsAffected. */
  const authorizedWrites = [];
  sandbox.H2O.Desktop = { Sync: { executeAuthorizedSqlite: async ({ statements, reason }) => {
    let rowsAffected = 0;
    for (const statement of statements) { const r = await sql.execute(statement.query, statement.values); rowsAffected += Number(r[0]) || 0; }
    authorizedWrites.push({ reason, rowsAffected });
    return { ok: true, executed: true, rowsAffected };
  } } };
  vm.createContext(sandbox);
  vm.runInContext(sources.chats, sandbox, { filename: 'chats.tauri.js' });
  vm.runInContext(sources.snapshots, sandbox, { filename: 'snapshots.tauri.js' });
  vm.runInContext(sources.importer, sandbox, { filename: 'import-bundle.tauri.js' });
  const row = (chatId) => {
    const r = db.prepare('SELECT * FROM chats WHERE id = ?').get(chatId);
    if (!r) return null;
    return { ...r, meta: JSON.parse(r.meta_json || '{}') };
  };
  return { db, sandbox, authorizedWrites, importBundle: (...a) => sandbox.H2O.Studio.ingestion.importBundle(...a), row,
    turns: (chatId) => db.prepare('SELECT t.turn_idx, t.role, t.text FROM snapshot_turns t JOIN snapshots s ON s.id = t.snapshot_id WHERE s.chat_id = ? ORDER BY t.turn_idx').all(chatId),
    snapshots: (chatId) => db.prepare('SELECT id, captured_at, message_count FROM snapshots WHERE chat_id = ?').all(chatId) };
}

/* The exact shape the canonical projection emits (validateContentOnlyPayload):
 * chatIndex carries title / lastSnapshotId / snapshotCount / messageCount /
 * state / organization only; the snapshot carries createdAt, messageCount,
 * messages[{order, role, text}] and meta.{title, richTurns}. No counts, no
 * chat createdAt, no folder relationship fields. */
const CHAT_ID = '6aa5578d-993c-83eb-b8de-5547574db413';
const SNAPSHOT_ID = 'snap_1789220817769_82mb267m';
const CANONICAL_CREATED_AT_ISO = '2026-09-12T13:46:57.769Z';
const CANONICAL_CREATED_AT_MS = Date.parse(CANONICAL_CREATED_AT_ISO);
function p02Payload(overrides = {}) {
  const turns = [
    { turnIdx: 0, role: 'user', text: 'How do I keep my Mac screen on?', outerHtml: '<p>How do I keep my Mac screen on?</p>', meta: { userMessageId: 'u-1', createTime: 1789220800 } },
    { turnIdx: 1, role: 'assistant', text: 'Use caffeinate or the Energy settings.', outerHtml: '<p>Use caffeinate or the Energy settings.</p>', meta: { assistantMessageId: 'a-1', createTime: 1789220810 } },
  ];
  return {
    schema: 'h2o.studio.sync-object.payload.content-only.v1',
    chatArchive: {
      chats: [{
        chatId: CHAT_ID,
        title: 'Sync Testing Chat',
        chatIndex: Object.assign({
          title: 'Sync Testing Chat', lastSnapshotId: SNAPSHOT_ID, snapshotCount: 1, messageCount: turns.length,
          state: { isSaved: true, isLinked: true }, organization: {},
        }, overrides.chatIndex || {}),
        snapshots: [{
          snapshotId: SNAPSHOT_ID, chatId: CHAT_ID, createdAt: CANONICAL_CREATED_AT_ISO, messageCount: turns.length,
          messages: turns.map((t) => ({ order: t.turnIdx, role: t.role, text: t.text })),
          meta: { title: 'Sync Testing Chat', richTurns: turns.map((t) => ({ turnIdx: t.turnIdx, role: t.role, outerHTML: t.outerHtml, meta: t.meta })) },
        }],
      }],
      catalogs: { categories: [], labels: [], tags: [] },
    },
    chromeStorageLocal: {},
    libraryKv: [],
  };
}

/* ── A. source contract ─────────────────────────────────────────────── */
{
  const src = sources.importer;
  check(src.includes('function deriveTranscriptCounts(snapshot)'),
    'A1 the importer derives transcript counts from the persisted turn rows');
  check(src.includes("var transcriptCounts = latest ? deriveTranscriptCounts(latest) : null;"),
    'A2 counts are derived only from a real payload snapshot');
  check(src.includes('effectiveAssistantTurnCount + effectiveUserTurnCount'),
    'A3 turnCount reuses the capture-side max(messageCount, assistant+user, assistant, user) rule');
  check(src.includes("createdAt: effectiveCreatedAt || undefined,"),
    'A4 the chat patch initializes createdAt only when a timestamp exists');
  check(src.includes("if (hasPatchField('createdAt') && numericCount(patch && patch.createdAt)) setColumn('created_at'"),
    'A5 the existing-row evidence writer can lower an import-default createdAt');
  check(src.includes("existingCreatedAtSource !== 'chat-index'"),
    'A6 an index-sourced createdAt is never lowered by a later payload');
}

/* ── B. fresh import of a P02 content-only chat ─────────────────────── */
{
  const desktop = makeDesktop();
  const result = await desktop.importBundle(p02Payload(), 'merge', { round2aContentOnly: true });
  equal(result?.ok, true, 'B1 the content-only payload imports');
  equal(desktop.turns(CHAT_ID).map((t) => t.role).join(','), 'user,assistant', 'B2 the transcript still imports (2 turns)');
  const row = desktop.row(CHAT_ID);
  check(!!row, 'B3 the chat row exists');
  equal(row.message_count, 2, 'B4 messageCount = messages.length');
  equal(row.user_turn_count, 1, 'B5 userTurnCount = 1 (role=user)');
  equal(row.assistant_turn_count, 1, 'B6 assistantTurnCount = 1 (role=assistant)');
  equal(row.meta.answerCount, 1, 'B7 answerCount = 1 (the assistant-turn count)');
  equal(row.meta.turnCount, 2, 'B8 turnCount = max(2, 1+1, 1, 1) = 2');
  equal(row.meta.messageCount, 2, 'B9 meta.messageCount mirrors the column');
  equal(row.meta.userTurnCount, 1, 'B10 meta.userTurnCount mirrors the column');
  equal(row.meta.assistantTurnCount, 1, 'B11 meta.assistantTurnCount mirrors the column');
  equal(row.meta.countsDerivedFromTranscript, true, 'B12 provenance: counts came from the transcript');
  equal(row.created_at, CANONICAL_CREATED_AT_MS, 'B13 createdAt is initialized from the canonical snapshot createdAt');
  equal(row.meta.createdAtSource, 'canonical-snapshot', 'B14 provenance: createdAt came from the canonical snapshot');
  equal(row.last_captured_at, CANONICAL_CREATED_AT_MS, 'B15 lastCapturedAt keeps its existing semantics');
  equal(row.folder_id || '', '', 'B16 folder stays Unfiled - the content-only contract carries no relationship');
  equal(row.category_id || null, null, 'B17 no category is invented');
  equal(row.meta.sourceAnswerCount, 0, 'B18 the index provenance still records that no answerCount was supplied');
  equal(desktop.snapshots(CHAT_ID).length, 1, 'B19 exactly one snapshot row');

  /* idempotent replay: same payload again */
  const again = await desktop.importBundle(p02Payload(), 'merge', { round2aContentOnly: true });
  equal(again?.ok, true, 'B20 re-import succeeds');
  const replay = desktop.row(CHAT_ID);
  equal(replay.message_count, 2, 'B21 replay keeps messageCount');
  equal(replay.user_turn_count, 1, 'B22 replay keeps userTurnCount');
  equal(replay.assistant_turn_count, 1, 'B23 replay keeps assistantTurnCount');
  equal(replay.meta.answerCount, 1, 'B24 replay keeps answerCount');
  equal(replay.meta.turnCount, 2, 'B25 replay keeps turnCount');
  equal(replay.created_at, CANONICAL_CREATED_AT_MS, 'B26 replay does not move createdAt');
  equal(desktop.snapshots(CHAT_ID).length, 1, 'B27 replay creates no duplicate snapshot');
  equal(desktop.turns(CHAT_ID).length, 2, 'B28 replay creates no duplicate turns');
  equal(replay.folder_id || '', '', 'B29 replay leaves the folder untouched');
}

/* ── C. explicit index counts remain authoritative ──────────────────── */
{
  const desktop = makeDesktop();
  await desktop.importBundle(p02Payload({ chatIndex: { answerCount: 5, turnCount: 7, userTurnCount: 4, assistantTurnCount: 5 } }), 'merge', {});
  const row = desktop.row(CHAT_ID);
  equal(row.meta.answerCount, 5, 'C1 an explicit answerCount wins over the transcript');
  equal(row.meta.turnCount, 7, 'C2 an explicit turnCount wins');
  equal(row.user_turn_count, 4, 'C3 an explicit userTurnCount wins');
  equal(row.assistant_turn_count, 5, 'C4 an explicit assistantTurnCount wins');
  equal(row.meta.countsDerivedFromTranscript, false, 'C5 provenance: nothing was derived');
}

/* ── D. an authoritative incoming createdAt wins; import-default createdAt is repaired,
 *       an earlier / captured createdAt is never overwritten ───────────── */
{
  const desktop = makeDesktop();
  const explicitIso = '2026-09-01T09:00:00.000Z';
  await desktop.importBundle(p02Payload({ chatIndex: { createdAt: explicitIso } }), 'merge', {});
  equal(desktop.row(CHAT_ID).created_at, Date.parse(explicitIso), 'D1 an authoritative chat createdAt in the index wins over the snapshot');
  equal(desktop.row(CHAT_ID).meta.createdAtSource, 'chat-index', 'D2 provenance: createdAt came from the index');
  /* a later payload without the index createdAt (the P02 projection never emits one)
   * must not lower an authoritative index-sourced createdAt, and must not rewrite its provenance */
  desktop.db.prepare("UPDATE chats SET user_turn_count = 0, meta_json = json_set(meta_json, '$.userTurnCount', 0) WHERE id = ?").run(CHAT_ID); /* force an evidence merge */
  const writesBefore = desktop.authorizedWrites.length;
  await desktop.importBundle(p02Payload(), 'merge', { round2aContentOnly: true });
  equal(desktop.authorizedWrites.length, writesBefore + 1, 'D2a the later payload really went through the existing-evidence merge');
  equal(desktop.row(CHAT_ID).created_at, Date.parse(explicitIso), 'D2b an index-sourced createdAt survives a later payload that lacks one');
  equal(desktop.row(CHAT_ID).meta.createdAtSource, 'chat-index', 'D2c ...and keeps its provenance through the evidence merge');
  equal(desktop.row(CHAT_ID).user_turn_count, 1, 'D2d ...while the count evidence is still merged');

  /* a row this importer created before the repair: import-moment createdAt (later than canonical) */
  const legacy = makeDesktop();
  await legacy.importBundle(p02Payload(), 'merge', {});
  const importMoment = CANONICAL_CREATED_AT_MS + 4 * 3600 * 1000;
  /* exactly the live pre-repair row shape (main 8599d8f4): zero count columns,
   * zero meta counts, no provenance keys, createdAt = import moment */
  legacy.db.prepare("UPDATE chats SET created_at = ?, user_turn_count = 0, assistant_turn_count = 0, meta_json = json_remove(json_set(meta_json, '$.answerCount', 0, '$.turnCount', 0, '$.userTurnCount', 0, '$.assistantTurnCount', 0), '$.countsDerivedFromTranscript', '$.createdAtSource') WHERE id = ?").run(importMoment, CHAT_ID);
  const preRepair = legacy.row(CHAT_ID);
  check(preRepair.created_at === importMoment && preRepair.user_turn_count === 0 && preRepair.meta.answerCount === 0
    && preRepair.meta.userTurnCount === 0 && preRepair.meta.countsDerivedFromTranscript === undefined,
    'D3 fixture: pre-repair row with an import-moment createdAt and zero counts');
  const repaired = await legacy.importBundle(p02Payload(), 'merge', { round2aContentOnly: true });
  equal(repaired?.ok, true, 'D4 re-import of the pre-repair row succeeds');
  equal(legacy.row(CHAT_ID).created_at, CANONICAL_CREATED_AT_MS, 'D5 the import-default createdAt is lowered to the canonical snapshot timestamp');
  equal(legacy.row(CHAT_ID).user_turn_count, 1, 'D6 zero counts on the existing row are repaired on replay');
  equal(legacy.row(CHAT_ID).assistant_turn_count, 1, 'D7 assistantTurnCount repaired on replay');
  equal(legacy.row(CHAT_ID).meta.answerCount, 1, 'D8 answerCount repaired on replay');
  equal(legacy.row(CHAT_ID).meta.turnCount, 2, 'D9 turnCount repaired on replay');
  equal(legacy.snapshots(CHAT_ID).length, 1, 'D10 no duplicate snapshot on replay');
  const evidenceWrites = legacy.authorizedWrites.filter((w) => w.reason === 'f19.chrome-desktop-existing-evidence');
  equal(evidenceWrites.length, 1, 'D10a the repair went through the identity-gated existing-evidence writer exactly once');
  equal(evidenceWrites[0] && evidenceWrites[0].rowsAffected, 1, 'D10b ...and updated exactly the one existing row');

  /* a captured (non-imported) row with an earlier createdAt: never touched */
  const captured = makeDesktop();
  const earlier = CANONICAL_CREATED_AT_MS - 86400000;
  await captured.sandbox.H2O.Studio.store.chats.upsert({ chatId: CHAT_ID, title: 'Captured locally', createdAt: earlier, isSaved: true, isLinked: true, lastSnapshotId: SNAPSHOT_ID, snapshotCount: 1 });
  await captured.importBundle(p02Payload(), 'merge', { round2aContentOnly: true });
  equal(captured.row(CHAT_ID).created_at, earlier, 'D11 an established earlier createdAt on a captured row is not overwritten');
  /* a captured row whose createdAt is later than the canonical snapshot is also left alone (no importedFrom provenance) */
  const capturedLater = makeDesktop();
  const later = CANONICAL_CREATED_AT_MS + 86400000;
  await capturedLater.sandbox.H2O.Studio.store.chats.upsert({ chatId: CHAT_ID, title: 'Captured locally', createdAt: later, isSaved: true, isLinked: true, lastSnapshotId: SNAPSHOT_ID, snapshotCount: 1 });
  await capturedLater.importBundle(p02Payload(), 'merge', { round2aContentOnly: true });
  equal(capturedLater.row(CHAT_ID).created_at, later, 'D12 an authoritative captured createdAt is never lowered by an import');
}

/* ── E. index-only chats (no snapshot payload) behave as before ─────── */
{
  const desktop = makeDesktop();
  const payload = p02Payload();
  payload.chatArchive.chats[0].snapshots = [];
  payload.chatArchive.chats[0].chatIndex.messageCount = 0;
  payload.chatArchive.chats[0].chatIndex.lastSnapshotId = '';
  payload.chatArchive.chats[0].chatIndex.snapshotCount = 0;
  await desktop.importBundle(payload, 'merge', {});
  const row = desktop.row(CHAT_ID);
  check(!row || (row.message_count === 0 && row.user_turn_count === 0 && row.assistant_turn_count === 0),
    'E1 without a transcript nothing is derived');
  if (row) check(row.meta.createdAtSource === '' || row.meta.createdAtSource === undefined, 'E2 no canonical createdAt is claimed without a payload snapshot');
}

if (failures.length) {
  console.error(JSON.stringify({ verdict: 'P02_IMPORTED_CHAT_METADATA_FAIL', assertions, failures }, null, 2));
  process.exit(1);
}
console.log(JSON.stringify({
  verdict: 'P02_IMPORTED_CHAT_METADATA_PASS',
  assertions,
  proves: 'P02 content-only imports derive answer/turn counts from the transcript and initialize createdAt from the canonical snapshot; explicit index values win; replay is idempotent; captured rows untouched; folder stays Unfiled by design',
}, null, 2));
