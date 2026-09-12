#!/usr/bin/env node
/*
 * P02 already-applied metadata self-heal.
 *
 * Live proof after activating 35cde3a0: "Apply admitted Chrome revision
 * (P02 v2)" on the chat the OLDER importer had materialized returned
 * already-applied / 0 canonical import attempts / 0 repository writes, and
 * the sidebar kept "Unfiled · 0 answers · Created unknown". The runtime's
 * `localLast === incoming || p02AlreadyApplied` branch proves canonical
 * convergence from content alone and returns before the importer, so a
 * pre-35cde3a row can never reach the repaired count / createdAt derivation
 * by replaying Apply.
 *
 * This proof drives the REAL runtime (pullObject through
 * applyNextAdmittedP02Revision), the REAL ingestion module and REAL
 * SQLite-backed stores through the exact upgrade path:
 *   1. a row imported by the pre-35cde3a importer (zero counts, import-moment
 *      createdAt, no provenance) whose canonical snapshot + turns exist and
 *      whose P02 revision is already recorded as applied;
 *   2. Apply of the SAME admitted revision;
 *   3. outcome stays already-applied, the importer is never called, canonical
 *      rows and anchors are byte-identical, the metadata is repaired, a second
 *      replay mutates nothing more, folder stays Unfiled;
 *   4. an already-correct row is a true no-op;
 *   5. an authoritative / non-imported row is never modified;
 *   6. fail-closed: no authorized writer, no local chat, no local snapshot.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const sources = Object.fromEntries([
  'chats', 'snapshots', 'importer', 'projection', 'localSource', 'runtime',
].map((name) => [name, fs.readFileSync(path.join(root, ({
  chats: 'src-surfaces-base/studio/store/chats.tauri.js',
  snapshots: 'src-surfaces-base/studio/store/snapshots.tauri.js',
  importer: 'src-surfaces-base/studio/ingestion/import-bundle.tauri.js',
  projection: 'src-surfaces-base/studio/sync/sync-object-projection.tauri.js',
  localSource: 'src-surfaces-base/studio/sync/sync-object-local-source.tauri.js',
  runtime: 'src-surfaces-base/studio/sync/sync-object-runtime.tauri.js',
})[name]), 'utf8')]));

const failures = [];
let assertions = 0;
const check = (condition, label) => { assertions += 1; if (!condition) failures.push(label); };
const equal = (actual, expected, label) =>
  check(actual === expected, `${label} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
const clean0 = (value) => String(value == null ? '' : value).trim();

/* Same canonical DDL the apply-idempotency proof installs. */
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
      sync_peer_id TEXT NOT NULL, object_id TEXT NOT NULL,
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
      PRIMARY KEY(sync_peer_id, object_id)
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

function sqlAdapter(db) {
  return {
    async execute(query, values = []) { const r = db.prepare(query).run(...values); return [Number(r.changes), Number(r.lastInsertRowid || 0)]; },
    async select(query, values = []) { return db.prepare(query).all(...values); },
  };
}

function makeProfile(dbPath, syncPeerId) {
  const db = new DatabaseSync(dbPath);
  installSchema(db);
  const sql = sqlAdapter(db);
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
  vm.createContext(sandbox);
  vm.runInContext(sources.chats, sandbox, { filename: 'chats.tauri.js' });
  vm.runInContext(sources.snapshots, sandbox, { filename: 'snapshots.tauri.js' });
  vm.runInContext(sources.importer, sandbox, { filename: 'import-bundle.tauri.js' });
  vm.runInContext(sources.projection, sandbox, { filename: 'sync-object-projection.tauri.js' });
  vm.runInContext(sources.localSource, sandbox, { filename: 'sync-object-local-source.tauri.js' });
  vm.runInContext(sources.runtime, sandbox, { filename: 'sync-object-runtime.tauri.js' });
  /* The identity-gated writer the existing-evidence path uses in the Desktop
   * (sqlite-writer-identity-sentinel); stubbed exactly as the apply-idempotency
   * proof stubs it, with a ledger of every authorized statement. */
  const authorizedWrites = [];
  sandbox.H2O.Desktop.Sync = { executeAuthorizedSqlite: async ({ statements, reason }) => {
    let rowsAffected = 0;
    for (const statement of statements) { const r = await sql.execute(statement.query, statement.values); rowsAffected += Number(r[0]) || 0; }
    authorizedWrites.push({ reason, rowsAffected, query: statements.map((s) => s.query).join(';') });
    return { ok: true, executed: true, rowsAffected };
  } };
  return { db, sql, sandbox, stores: sandbox.H2O.Studio.store, syncPeerId, authorizedWrites };
}

const strictEmptyRelationships = async () => ({ assets: [], folders: [], labels: [], tags: [] });
const forbidWebDav = {
  async h2o_sync_object_publish_transport() { throw new Error('unexpected WebDAV publish'); },
  async h2o_sync_object_pull_transport() { throw new Error('unexpected WebDAV pull'); },
};

function wire(profile, bootId, extra = {}) {
  profile.sandbox.H2O.Desktop.SyncObjectProjection.__test.setDependencies({
    stores: profile.stores, strictRelationshipProbe: strictEmptyRelationships,
  });
  profile.sandbox.H2O.Desktop.SyncObjectRuntime.__test.setDependencies({
    sql: profile.sql, transport: forbidWebDav, stores: profile.stores, syncPeerId: profile.syncPeerId,
    importBundle: profile.sandbox.H2O.Studio.ingestion.importBundle, strictOwnerSchema: true, bootId, ...extra,
  });
}

/* Counting wrapper around the REAL importer: canonical import attempts must
 * stay 0 on an already-applied replay. */
function countingImporter(profile) {
  const real = profile.sandbox.H2O.Studio.ingestion.importBundle;
  const counter = { calls: 0 };
  const wrapped = async (...args) => { counter.calls += 1; return real(...args); };
  return { wrapped, counter };
}

/* The exact live object: a P02-shaped content-only chat (1 user + 1 assistant,
 * valid snapshot createdAt, no counts, no folder fields). */
const OBJECT_ID = '6aa5578d-993c-83eb-b8de-5547574db413';
const SNAPSHOT_ID = 'snap_1789220817769_82mb267m';
const REVISION_ID = 'p02-40dd5602757178f62d67f2a130588e57';
const WRITER = 'studio-chrome:mv3-chrome:idb-archive:12345678-1234-4abc-8def-1234567890ab';
const CANONICAL_ISO = '2026-09-12T13:46:57.769Z';
const CANONICAL_MS = Date.parse(CANONICAL_ISO);
const IMPORT_MOMENT_MS = 1789236742132; /* the live row's created_at: the import moment, ~4.4 h later */
function payload() {
  return {
    schema: 'h2o.studio.fullBundle.v2',
    chatArchive: {
      chats: [{
        chatId: OBJECT_ID, title: 'Sync Testing Chat',
        chatIndex: { title: 'Sync Testing Chat', lastSnapshotId: SNAPSHOT_ID, snapshotCount: 1, messageCount: 2, state: { isSaved: true, isLinked: true }, organization: {} },
        snapshots: [{
          snapshotId: SNAPSHOT_ID, chatId: OBJECT_ID, createdAt: CANONICAL_ISO, messageCount: 2,
          messages: [{ order: 0, role: 'user', text: 'How do I keep my Mac screen on?' }, { order: 1, role: 'assistant', text: 'Use caffeinate or the Energy settings.' }],
          meta: { title: 'Sync Testing Chat', richTurns: [
            { turnIdx: 0, role: 'user', outerHTML: '<p>How do I keep my Mac screen on?</p>', meta: { userMessageId: 'u-1', createTime: 1789220800 } },
            { turnIdx: 1, role: 'assistant', outerHTML: '<p>Use caffeinate or the Energy settings.</p>', meta: { assistantMessageId: 'a-1', createTime: 1789220810 } },
          ] },
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
  const revisionValue = {
    schema: 'h2o.studio.syncRevision.v2', objectDomain: 'studio.chat.saved-state.v1',
    objectId: OBJECT_ID, revisionId: REVISION_ID, writerSyncPeerId: WRITER,
    previousRevisionId: null, previousRevisionBlobSha256: null, payloadSha256: payloadSha, payload: body,
  };
  const revisionBlobSha = crypto.createHash('sha256').update(canonicalJson(revisionValue)).digest('hex');
  const reads = { count: 0 };
  const source = { readCandidate: async () => {
    reads.count += 1;
    const key = await profile.sandbox.H2O.Desktop.SyncObjectProjection.objectKeyHex(OBJECT_ID);
    return {
      ok: true, headPresent: true, sourceKind: 'p02-admitted-local', sourceVerified: true,
      sourceStrongVersion: `p02-admission:revision:${revisionBlobSha}`, revisionValue,
      head: { schema: 'h2o.studio.syncHead.v2', objectId: OBJECT_ID, objectKey: key, revisionId: REVISION_ID, payloadSha256: payloadSha,
        revisionBlobSha256: revisionBlobSha, writerSyncPeerId: WRITER, previousRevisionId: null, previousRevisionBlobSha256: null,
        sourceUpdatedAtIso: CANONICAL_ISO },
    };
  } };
  return { source, payloadSha, revisionBlobSha, reads };
}

const apply = (profile) => profile.sandbox.H2O.Desktop.SyncObjectRuntime.applyNextAdmittedP02Revision(OBJECT_ID);
const chatRow = (profile) => { const r = profile.db.prepare('SELECT * FROM chats WHERE id = ?').get(OBJECT_ID); return r ? { ...r, meta: JSON.parse(r.meta_json || '{}') } : null; };
const canonicalRows = (profile) => JSON.stringify({
  snapshots: profile.db.prepare('SELECT * FROM snapshots ORDER BY id').all(),
  turns: profile.db.prepare('SELECT * FROM snapshot_turns ORDER BY snapshot_id, turn_idx').all(),
  pointer: profile.db.prepare('SELECT last_snapshot_id, snapshot_count, is_saved, is_linked, folder_id, category_id, title, href FROM chats WHERE id = ?').get(OBJECT_ID),
});
const anchors = (profile) => profile.db.prepare(
  'SELECT last_applied_revision_id, last_applied_revision_blob_sha256, last_applied_payload_sha256, last_converged_direction, convergence_watermark_sha256, consumed_revision_blob_sha256, remote_head_strong_etag, remote_head_revision_blob_sha256, last_published_revision_id, pending_operation, operation_phase, owner_boot_id, owner_token, last_conflict_class, last_error_code FROM sync_object_state WHERE object_id = ?'
).get(OBJECT_ID);
const stateCount = (profile) => profile.db.prepare('SELECT COUNT(*) AS n FROM sync_object_state').get().n;

/* Pre-35cde3a row shape, exactly as the live row read on 8599d8f4: zero count
 * columns and meta counts, no provenance keys, createdAt = import moment. */
function downgradeToPreRepairRow(profile) {
  profile.db.prepare(
    "UPDATE chats SET created_at = ?, user_turn_count = 0, assistant_turn_count = 0, meta_json = json_remove(json_set(meta_json, '$.answerCount', 0, '$.turnCount', 0, '$.userTurnCount', 0, '$.assistantTurnCount', 0), '$.countsDerivedFromTranscript', '$.createdAtSource', '$.f19ChromeDesktopEvidenceMerged', '$.f19ChromeDesktopEvidenceMergedAt') WHERE id = ?"
  ).run(IMPORT_MOMENT_MS, OBJECT_ID);
}

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'h2o-p02-metadata-self-heal-'));
try {
  /* ── A. source contract ──────────────────────────────────────────────── */
  {
    const runtime = sources.runtime;
    const importer = sources.importer;
    check(importer.includes('async function reconcileImportedChatMetadata(bundleInput, options)'),
      'A1 the ingestion module owns a bounded metadata reconciliation entry point');
    check(importer.includes('reconcileImportedChatMetadata: reconcileImportedChatMetadata,'),
      'A2 ...exported on H2O.Studio.ingestion');
    check(importer.includes("if (!sync || typeof sync.executeAuthorizedSqlite !== 'function') return finish(false, 'authorized-writer-unavailable');"),
      'A3 reconciliation fails closed without the identity-gated writer (no upsert fallback)');
    check(importer.includes("if (!cleanString(existingMeta.importedFrom)) { entries.push(metadataReconciliationEntry(chatId, 'untouched', { code: 'not-importer-created' })); continue; }"),
      'A4 a row without importer provenance is never touched');
    check(importer.includes("var METADATA_RECONCILIATION_FIELDS = ['messageCount', 'turnCount', 'userTurnCount', 'assistantTurnCount', 'answerCount', 'createdAt'];"),
      'A5 the reconciliation is bounded to the six importer-owned metadata fields');
    check(runtime.includes("var metadataReconciliation = p02AlreadyApplied\n          ? await reconcileAlreadyAppliedMetadata(objectId, envelope.payload) : null;"),
      'A6 the runtime self-heals only the exact already-applied P02 revision, after the convergence proof and commit');
    check(runtime.includes('var applied = await apply(envelope.payload, \'merge\', { round2aContentOnly: true });') &&
      (runtime.match(/importerInvoked = true;/g) || []).length === 1,
      'A7 the canonical importer is still invoked on exactly one path (the real apply), never on the already-applied branch');
    check(runtime.includes("source: 'p02-already-applied'"), 'A8 the reconciliation is stamped with its P02 already-applied origin');
  }

  /* ── B. the real upgrade path ────────────────────────────────────────── */
  {
    const profile = makeProfile(path.join(temporary, 'upgrade.db'), 'studio-desktop:upgrade');
    await profile.stores.chats.init(); await profile.stores.snapshots.init();
    const admitted = admittedSource(profile);
    /* step 0: the original import by the older build - the real importer applies the revision */
    wire(profile, 'studio-desktop:upgrade:boot-1', { p02LocalSource: admitted.source });
    const first = await apply(profile);
    equal(first?.ok, true, 'B0a the original Apply succeeds');
    equal(first?.applied, true, 'B0b ...and imports canonical content');
    equal(first?.importerInvoked, true, 'B0c ...through the canonical importer');
    equal(first?.metadataReconciled, undefined, 'B0d a real apply carries no self-heal');
    const anchorsBefore = anchors(profile);
    equal(anchorsBefore?.last_applied_revision_id, REVISION_ID, 'B0e the P02 revision is recorded as applied');
    equal(anchorsBefore?.last_applied_revision_blob_sha256, admitted.revisionBlobSha, 'B0f ...with its blob');
    equal(anchorsBefore?.last_applied_payload_sha256, admitted.payloadSha, 'B0g ...and payload');
    equal(anchorsBefore?.last_converged_direction, 'applied', 'B0h direction applied');

    /* step 1: seed the pre-35cde3a row shape (the live row on 8599d8f4) */
    downgradeToPreRepairRow(profile);
    const seeded = chatRow(profile);
    check(seeded && seeded.user_turn_count === 0 && seeded.assistant_turn_count === 0 && seeded.meta.answerCount === 0 &&
      seeded.meta.turnCount === 0 && seeded.meta.userTurnCount === 0 && seeded.meta.assistantTurnCount === 0 &&
      seeded.created_at === IMPORT_MOMENT_MS && seeded.meta.countsDerivedFromTranscript === undefined &&
      seeded.meta.createdAtSource === undefined && clean0(seeded.meta.importedFrom) === 'h2o.studio.fullBundle.v2' &&
      seeded.last_snapshot_id === SNAPSHOT_ID && (seeded.folder_id || '') === '',
    'B1 fixture: canonical chat + snapshot + turns exist, revision applied, zero counts, import-moment createdAt, importer provenance, Unfiled');
    const canonicalBefore = canonicalRows(profile);
    const authorizedBefore = profile.authorizedWrites.length;
    const stateRowsBefore = stateCount(profile);

    /* step 2: Apply the SAME already-applied admitted revision on a new boot */
    const counting = countingImporter(profile);
    wire(profile, 'studio-desktop:upgrade:boot-2', { p02LocalSource: admitted.source, importBundle: counting.wrapped });
    const replay = await apply(profile);
    equal(replay?.ok, true, 'B2a the replay completes');
    equal(replay?.unchangedNoOp, true, 'B2b outcome stays already-applied (canonical no-op)');
    equal(replay?.convergenceVerified, true, 'B2c canonical convergence is proven');
    equal(replay?.adoptedExisting, false, 'B2d it is the recorded already-applied revision, not an adoption');
    equal(replay?.importerInvoked, false, 'B2e importerInvoked stays false');
    equal(counting.counter.calls, 0, 'B2f canonical importer calls = 0');
    equal(replay?.metadataReconciled, true, 'B2g the bounded metadata self-heal ran');
    equal(replay?.metadataReconciliation?.ok, true, 'B2h ...and reports ok');
    equal(replay?.metadataReconciliation?.code, '', 'B2i ...with no refusal code');
    const entry = replay?.metadataReconciliation?.chats?.[0];
    equal(entry?.status, 'reconciled', 'B2j the chat entry is reconciled');
    equal(entry?.chatId, OBJECT_ID, 'B2k ...for the applied object');
    equal(JSON.stringify(entry?.fields), JSON.stringify(['turnCount', 'userTurnCount', 'assistantTurnCount', 'answerCount', 'createdAt']),
      'B2l exactly the stale fields were repaired (messageCount was already 2)');
    equal(entry?.createdAt?.previous, IMPORT_MOMENT_MS, 'B2m createdAt provenance: previous = import moment');
    equal(entry?.createdAt?.next, CANONICAL_MS, 'B2n createdAt provenance: next = canonical snapshot timestamp');
    equal(entry?.createdAt?.source, 'canonical-snapshot', 'B2o createdAt provenance: source');

    /* step 3: prove the row and everything around it */
    equal(canonicalRows(profile), canonicalBefore, 'B3a transcript / snapshot / turns / pointer / flags / folder are byte-identical');
    equal(JSON.stringify(anchors(profile)), JSON.stringify(anchorsBefore), 'B3b last_applied revision / blob / payload / direction / watermark anchors unchanged');
    equal(stateCount(profile), stateRowsBefore, 'B3c no new ledger rows');
    equal(admitted.reads.count, 2, 'B3d the admitted local source was only read (one read per Apply), never written');
    const healed = chatRow(profile);
    equal(healed.message_count, 2, 'B3e messageCount stays 2');
    equal(healed.user_turn_count, 1, 'B3f userTurnCount = 1');
    equal(healed.assistant_turn_count, 1, 'B3g assistantTurnCount = 1');
    equal(healed.meta.answerCount, 1, 'B3h answerCount = 1');
    equal(healed.meta.turnCount, 2, 'B3i turnCount = max(2, 1+1, 1, 1) = 2');
    equal(healed.meta.userTurnCount, 1, 'B3j meta.userTurnCount mirrors the column');
    equal(healed.meta.assistantTurnCount, 1, 'B3k meta.assistantTurnCount mirrors the column');
    equal(healed.meta.countsDerivedFromTranscript, true, 'B3l provenance: counts derived from the transcript');
    equal(healed.created_at, CANONICAL_MS, 'B3m createdAt repaired to the canonical snapshot timestamp');
    equal(healed.meta.createdAtSource, 'canonical-snapshot', 'B3n provenance: createdAt source');
    equal(healed.meta.metadataReconciledFrom, 'p02-already-applied', 'B3o provenance: reconciled by the already-applied self-heal');
    check(Number.isInteger(healed.meta.metadataReconciledAt) && healed.meta.metadataReconciledAt > 0, 'B3p provenance: reconciliation stamp');
    equal(healed.meta.importedFrom, 'h2o.studio.fullBundle.v2', 'B3q importer provenance preserved');
    equal(healed.meta.displayTitle, 'Sync Testing Chat', 'B3r unrelated meta keys preserved');
    equal(healed.folder_id || '', '', 'B3s folder remains Unfiled');
    equal(healed.title, 'Sync Testing Chat', 'B3t title untouched');
    equal(healed.last_snapshot_id, SNAPSHOT_ID, 'B3u canonical pointer untouched');
    const evidenceWrites = profile.authorizedWrites.slice(authorizedBefore);
    equal(evidenceWrites.length, 1, 'B3v exactly one identity-gated write');
    equal(evidenceWrites[0]?.reason, 'f19.chrome-desktop-existing-evidence', 'B3w ...through the existing-evidence writer');
    equal(evidenceWrites[0]?.rowsAffected, 1, 'B3x ...updating exactly one row');
    check(/^UPDATE chats SET /.test(evidenceWrites[0]?.query) && /WHERE id = \?$/.test(evidenceWrites[0]?.query), 'B3y ...as a single UPDATE of the chats row');
    check(!/folder_id|last_snapshot_id|snapshot_count|is_saved|is_linked|category_id|title =/.test(evidenceWrites[0]?.query),
      'B3z ...that names no folder / pointer / flag / title column');
    check(/user_turn_count = \?/.test(evidenceWrites[0]?.query) && /assistant_turn_count = \?/.test(evidenceWrites[0]?.query) &&
      /created_at = \?/.test(evidenceWrites[0]?.query) && /meta_json = \?/.test(evidenceWrites[0]?.query) && !/message_count = \?/.test(evidenceWrites[0]?.query),
      'B3aa ...naming only the stale count columns, created_at and meta_json');

    /* step 4: a second replay performs zero further metadata mutation */
    const rowAfterHeal = JSON.stringify(profile.db.prepare('SELECT * FROM chats WHERE id = ?').get(OBJECT_ID));
    const writesAfterHeal = profile.authorizedWrites.length;
    const anchorsAfterHeal = JSON.stringify(anchors(profile));
    const second = await apply(profile);
    equal(second?.ok, true, 'B4a second replay completes');
    equal(second?.unchangedNoOp, true, 'B4b ...already-applied');
    equal(second?.importerInvoked, false, 'B4c ...importer not invoked');
    equal(counting.counter.calls, 0, 'B4d canonical importer calls still 0');
    equal(second?.metadataReconciled, false, 'B4e no further metadata mutation');
    equal(second?.metadataReconciliation?.ok, true, 'B4f ...the reconciliation ran and reports ok');
    equal(second?.metadataReconciliation?.chats?.[0]?.status, 'noop', 'B4g ...as a noop');
    equal(JSON.stringify(profile.db.prepare('SELECT * FROM chats WHERE id = ?').get(OBJECT_ID)), rowAfterHeal, 'B4h the chats row is byte-identical (updated_at included)');
    equal(profile.authorizedWrites.length, writesAfterHeal, 'B4i no identity-gated write happened');
    equal(canonicalRows(profile), canonicalBefore, 'B4j canonical rows still byte-identical');
    equal(JSON.stringify(anchors(profile)), anchorsAfterHeal, 'B4k anchors still identical');
  }

  /* ── C. an already-correct row stays a true no-op ────────────────────── */
  {
    const profile = makeProfile(path.join(temporary, 'correct.db'), 'studio-desktop:correct');
    await profile.stores.chats.init(); await profile.stores.snapshots.init();
    const admitted = admittedSource(profile);
    wire(profile, 'studio-desktop:correct:boot-1', { p02LocalSource: admitted.source });
    const first = await apply(profile);
    equal(first?.applied, true, 'C1 the 35cde3a0 importer applies the revision');
    const row = chatRow(profile);
    check(row.user_turn_count === 1 && row.assistant_turn_count === 1 && row.meta.answerCount === 1 && row.meta.turnCount === 2 && row.created_at === CANONICAL_MS,
      'C2 ...with correct metadata from the start');
    const rowBefore = JSON.stringify(profile.db.prepare('SELECT * FROM chats WHERE id = ?').get(OBJECT_ID));
    const canonicalBefore = canonicalRows(profile);
    const anchorsBefore = JSON.stringify(anchors(profile));
    const writesBefore = profile.authorizedWrites.length;
    const counting = countingImporter(profile);
    wire(profile, 'studio-desktop:correct:boot-2', { p02LocalSource: admitted.source, importBundle: counting.wrapped });
    const replay = await apply(profile);
    equal(replay?.unchangedNoOp, true, 'C3 replay is already-applied');
    equal(counting.counter.calls, 0, 'C4 canonical importer calls = 0');
    equal(replay?.metadataReconciled, false, 'C5 nothing to reconcile');
    equal(replay?.metadataReconciliation?.chats?.[0]?.status, 'noop', 'C6 ...reported as noop');
    equal(JSON.stringify(profile.db.prepare('SELECT * FROM chats WHERE id = ?').get(OBJECT_ID)), rowBefore, 'C7 the chats row is byte-identical');
    equal(profile.authorizedWrites.length, writesBefore, 'C8 no identity-gated write');
    equal(canonicalRows(profile), canonicalBefore, 'C9 canonical rows identical');
    equal(JSON.stringify(anchors(profile)), anchorsBefore, 'C10 anchors identical');
  }

  /* ── D. an authoritative / non-imported row is never modified ────────── */
  {
    const profile = makeProfile(path.join(temporary, 'captured.db'), 'studio-desktop:captured');
    await profile.stores.chats.init(); await profile.stores.snapshots.init();
    const admitted = admittedSource(profile);
    /* a natively captured row: the same canonical snapshot + turns, no importer
     * provenance, deliberately zero counts and a later createdAt */
    const later = CANONICAL_MS + 86400000;
    await profile.stores.chats.upsert({ chatId: OBJECT_ID, title: 'Captured locally', lastSnapshotId: SNAPSHOT_ID, snapshotCount: 1, isSaved: true, isLinked: true, createdAt: later, meta: { capturedBy: 'native' } });
    const body = payload().chatArchive.chats[0].snapshots[0];
    await profile.stores.snapshots.create({
      snapshotId: SNAPSHOT_ID, chatId: OBJECT_ID, title: body.meta.title, capturedAt: CANONICAL_MS, updatedAt: CANONICAL_MS, messageCount: 2, meta: {},
      turns: body.meta.richTurns.map((rich, index) => ({ turnIdx: rich.turnIdx, role: rich.role, text: body.messages[index].text, outerHtml: rich.outerHTML, meta: rich.meta })),
    });
    const rowSeed = JSON.stringify(profile.db.prepare('SELECT * FROM chats WHERE id = ?').get(OBJECT_ID));
    const counting = countingImporter(profile);
    wire(profile, 'studio-desktop:captured:boot-1', { p02LocalSource: admitted.source, importBundle: counting.wrapped });
    /* D0: with no applied anchor a local snapshot is a local unexported change in
     * the v2 lane - the self-heal is unreachable from here (existing invariant). */
    let unanchored = null;
    try { unanchored = await apply(profile); } catch (error) { unanchored = { ok: false, errorCode: clean0(error && (error.code || error.message)) }; }
    equal(unanchored?.ok, false, 'D0a an unanchored captured row is not applied over');
    equal(clean0(unanchored?.errorCode), 'local-unexported-change', 'D0b ...it is the lineage block');
    equal(unanchored?.metadataReconciled, undefined, 'D0c ...and no self-heal is attempted');
    equal(JSON.stringify(profile.db.prepare('SELECT * FROM chats WHERE id = ?').get(OBJECT_ID)), rowSeed, 'D0d the captured row is untouched');
    /* the ledger as it stands after this exact revision was applied over the
     * captured row (a reverse one-hop history): anchors bound to revision, blob
     * and payload, direction applied */
    const now = new Date().toISOString();
    profile.db.prepare(
      'UPDATE sync_object_state SET last_applied_revision_id = ?, last_applied_revision_blob_sha256 = ?, last_applied_payload_sha256 = ?, last_converged_direction = ?, convergence_watermark_sha256 = ?, consumed_revision_blob_sha256 = ?, remote_head_strong_etag = ?, remote_head_revision_blob_sha256 = ?, last_conflict_class = NULL, last_error_code = NULL, updated_at = ? WHERE sync_peer_id = ? AND object_id = ?'
    ).run(REVISION_ID, admitted.revisionBlobSha, admitted.payloadSha, 'applied', admitted.revisionBlobSha, admitted.revisionBlobSha,
      `p02-admission:revision:${admitted.revisionBlobSha}`, admitted.revisionBlobSha, now, profile.syncPeerId, OBJECT_ID);
    const anchorsBefore = JSON.stringify(anchors(profile));
    const canonicalBefore = canonicalRows(profile);
    wire(profile, 'studio-desktop:captured:boot-2', { p02LocalSource: admitted.source, importBundle: counting.wrapped });
    const replay = await apply(profile);
    equal(replay?.ok, true, 'D1 the anchored revision replays');
    equal(replay?.unchangedNoOp, true, 'D2 ...as already-applied');
    equal(replay?.adoptedExisting, false, 'D3 ...from the recorded anchor, not an adoption');
    equal(counting.counter.calls, 0, 'D4 canonical importer calls = 0');
    equal(replay?.metadataReconciled, false, 'D5 the captured row is not reconciled');
    equal(replay?.metadataReconciliation?.ok, true, 'D6 ...the reconciliation ran and reports ok');
    equal(replay?.metadataReconciliation?.chats?.[0]?.status, 'untouched', 'D7 ...status untouched');
    equal(replay?.metadataReconciliation?.chats?.[0]?.code, 'not-importer-created', 'D8 ...because the row is not importer-created');
    equal(JSON.stringify(profile.db.prepare('SELECT * FROM chats WHERE id = ?').get(OBJECT_ID)), rowSeed, 'D9 the captured row stays byte-identical (createdAt not lowered, counts not written)');
    equal(profile.authorizedWrites.length, 0, 'D10 no identity-gated write ever happened');
    equal(canonicalRows(profile), canonicalBefore, 'D11 canonical rows identical');
    equal(JSON.stringify(anchors(profile)), anchorsBefore, 'D12 anchors identical');
  }

  /* ── E. fail-closed ──────────────────────────────────────────────────── */
  {
    /* E1-E5: no authorized writer -> nothing attempted, Apply still already-applied */
    const profile = makeProfile(path.join(temporary, 'no-writer.db'), 'studio-desktop:no-writer');
    await profile.stores.chats.init(); await profile.stores.snapshots.init();
    const admitted = admittedSource(profile);
    wire(profile, 'studio-desktop:no-writer:boot-1', { p02LocalSource: admitted.source });
    await apply(profile);
    downgradeToPreRepairRow(profile);
    const rowBefore = JSON.stringify(profile.db.prepare('SELECT * FROM chats WHERE id = ?').get(OBJECT_ID));
    delete profile.sandbox.H2O.Desktop.Sync;
    const counting = countingImporter(profile);
    wire(profile, 'studio-desktop:no-writer:boot-2', { p02LocalSource: admitted.source, importBundle: counting.wrapped });
    const replay = await apply(profile);
    equal(replay?.ok, true, 'E1 without the authorized writer the Apply still completes as already-applied');
    equal(replay?.unchangedNoOp, true, 'E2 ...canonical no-op');
    equal(replay?.metadataReconciled, false, 'E3 ...and no self-heal is claimed');
    equal(replay?.metadataReconciliation?.code, 'authorized-writer-unavailable', 'E4 ...with the fail-closed code');
    equal(JSON.stringify(profile.db.prepare('SELECT * FROM chats WHERE id = ?').get(OBJECT_ID)), rowBefore, 'E5 the row is untouched');
    equal(counting.counter.calls, 0, 'E6 canonical importer calls = 0');

    /* E7-E10: the entry point itself refuses a missing chat / missing snapshot */
    const bare = makeProfile(path.join(temporary, 'bare.db'), 'studio-desktop:bare');
    await bare.stores.chats.init(); await bare.stores.snapshots.init();
    const exported = bare.sandbox.H2O.Studio.ingestion.reconcileImportedChatMetadata;
    equal(typeof exported, 'function', 'E0 H2O.Studio.ingestion.reconcileImportedChatMetadata is exported');
    const reconcile = typeof exported === 'function' ? exported : async () => ({ ok: false, code: 'entry-point-missing', chats: [] });
    const missingChat = await reconcile(payload(), { chatId: OBJECT_ID, source: 'p02-already-applied' });
    equal(missingChat?.ok, false, 'E7 no local chat -> refused');
    equal(missingChat?.chats?.[0]?.code, 'chat-missing', 'E8 ...chat-missing');
    await bare.stores.chats.upsert({ chatId: OBJECT_ID, title: 'Shell', lastSnapshotId: SNAPSHOT_ID, snapshotCount: 1, isSaved: true, isLinked: true, meta: { importedFrom: 'h2o.studio.fullBundle.v2' } });
    const missingSnapshot = await reconcile(payload(), { chatId: OBJECT_ID, source: 'p02-already-applied' });
    equal(missingSnapshot?.ok, false, 'E9 no local canonical snapshot -> refused');
    equal(missingSnapshot?.chats?.[0]?.code, 'snapshot-missing', 'E10 ...snapshot-missing');
    equal(bare.authorizedWrites.length, 0, 'E11 refusals write nothing');
    const wrongObject = await reconcile(payload(), { chatId: 'some-other-object', source: 'p02-already-applied' });
    equal(wrongObject?.chats?.[0]?.code, 'chat-id-mismatch', 'E12 a payload for another object is refused');
    const badBundle = await reconcile({ schema: 'nope' }, { chatId: OBJECT_ID });
    equal(badBundle?.code, 'bundle-invalid', 'E13 an unrecognized bundle is refused');
  }
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}

if (failures.length) {
  console.error(JSON.stringify({ verdict: 'P02_ALREADY_APPLIED_METADATA_SELF_HEAL_FAIL', assertions, failures }, null, 2));
  process.exit(1);
}
console.log(JSON.stringify({
  verdict: 'P02_ALREADY_APPLIED_METADATA_SELF_HEAL_PASS',
  assertions,
  proves: 'an already-applied P02 revision stays a canonical no-op (0 importer calls, anchors and canonical rows byte-identical) while a pre-35cde3a imported row gets its answer/turn counts and imported createdAt repaired once through the bounded ingestion reconciliation; correct rows are true no-ops; captured rows are never modified; fail-closed without writer, chat or snapshot',
}, null, 2));
