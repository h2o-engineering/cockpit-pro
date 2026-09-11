#!/usr/bin/env node
import assert from 'node:assert/strict';
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
].map(name => [name, fs.readFileSync(path.join(root, ({
  chats: 'src-surfaces-base/studio/store/chats.tauri.js',
  snapshots: 'src-surfaces-base/studio/store/snapshots.tauri.js',
  importer: 'src-surfaces-base/studio/ingestion/import-bundle.tauri.js',
  projection: 'src-surfaces-base/studio/sync/sync-object-projection.tauri.js',
  localSource: 'src-surfaces-base/studio/sync/sync-object-local-source.tauri.js',
  runtime: 'src-surfaces-base/studio/sync/sync-object-runtime.tauri.js',
})[name]), 'utf8')]));
let assertions = 0;
const clean0 = (value) => String(value == null ? '' : value).trim();
const check = (condition, message) => { assertions += 1; assert.ok(condition, message); };

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
    async execute(query, values = []) {
      const result = db.prepare(query).run(...values);
      return [Number(result.changes), Number(result.lastInsertRowid || 0)];
    },
    async select(query, values = []) { return db.prepare(query).all(...values); },
  };
}

function makeProfile(dbPath, syncPeerId, options = {}) {
  const db = new DatabaseSync(dbPath);
  installSchema(db);
  const sql = sqlAdapter(db);
  const scriptLoads = [];
  const sandbox = {
    console, crypto: crypto.webcrypto, TextEncoder, TextDecoder, structuredClone,
    setTimeout, clearTimeout,
    chrome: { runtime: {}, storage: { local: { get(_keys, callback) { callback({}); }, set(_value, callback) { if (callback) callback(); } } } },
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
  if (options.lazyLocalSource) {
    const readerUrl = 'tauri://localhost/c/round2-item9-live-canary-3c1-v1';
    sandbox.location = { href: readerUrl, pathname: '/c/round2-item9-live-canary-3c1-v1' };
    sandbox.document = {
      createElement(tag) { return { tagName: tag, async: true, src: '', onload: null, onerror: null }; },
      head: { appendChild(script) {
        const resolved = new URL(script.src, readerUrl);
        scriptLoads.push(resolved.href);
        if (options.failLocalSourceLoad || resolved.pathname !== '/sync/sync-object-local-source.tauri.js') {
          queueMicrotask(() => script.onerror && script.onerror(new Error('asset-not-found')));
          return script;
        }
        try {
          vm.runInContext(sources.localSource, sandbox, { filename: 'sync-object-local-source.tauri.js' });
          if (typeof sandbox.__configureLocalSource === 'function') {
            sandbox.__configureLocalSource(sandbox.H2O.Desktop.SyncObjectLocalSource);
          }
          queueMicrotask(() => script.onload && script.onload());
        } catch (error) {
          queueMicrotask(() => script.onerror && script.onerror(error));
        }
        return script;
      } },
      documentElement: { appendChild(script) { return sandbox.document.head.appendChild(script); } },
    };
  }
  vm.runInContext(sources.chats, sandbox, { filename: 'chats.tauri.js' });
  vm.runInContext(sources.snapshots, sandbox, { filename: 'snapshots.tauri.js' });
  vm.runInContext(sources.importer, sandbox, { filename: 'import-bundle.tauri.js' });
  vm.runInContext(sources.projection, sandbox, { filename: 'sync-object-projection.tauri.js' });
  if (!options.lazyLocalSource) {
    vm.runInContext(sources.localSource, sandbox, { filename: 'sync-object-local-source.tauri.js' });
  }
  vm.runInContext(sources.runtime, sandbox, { filename: 'sync-object-runtime.tauri.js' });
  return { db, sql, sandbox, stores: sandbox.H2O.Studio.store, syncPeerId, scriptLoads };
}

class SharedWebDav {
  constructor() { this.revisions = new Map(); this.head = null; this.etag = 0; this.publishMutations = 0; this.pullReads = 0; }
  async h2o_sync_object_publish_transport(request) {
    const hash = crypto.createHash('sha256').update(request.revisionBlobText).digest('hex');
    if (hash !== request.revisionBlobSha256Hex) return { ok: false, errorCode: 'round2a-revision-blob-hash-mismatch' };
    if (this.head && this.head.revisionBlobSha256 === hash) {
      if (this.revisions.get(hash) !== request.revisionBlobText) return { ok: false, errorCode: 'round2a-revision-blob-divergent' };
      return { ok: true, verdict: 'unchanged-no-op', unchangedNoOp: true, revisionReadbackVerified: true, remoteRevisionId: request.revisionId, remoteRevisionBlobSha256Hex: hash };
    }
    if (this.head) {
      const expected = request.expectedHead;
      if (!expected || expected.strongEtag !== this.head.strongEtag || expected.revisionBlobSha256Hex !== this.head.revisionBlobSha256) {
        return { ok: false, conflictClass: 'stale-head-etag', errorCode: 'stale-head-etag' };
      }
    }
    const previousRevisionId = this.head && this.head.revisionId || null;
    const strongEtag = `"head-${++this.etag}"`;
    this.revisions.set(hash, request.revisionBlobText);
    this.head = { schema: 'h2o.studio.syncHead.v1', objectId: request.objectId, objectKey: request.objectKeyHex, revisionId: request.revisionId, payloadSha256: request.payloadSha256Hex, revisionBlobSha256: hash, writerSyncPeerId: request.writerSyncPeerId, previousRevisionId, sourceUpdatedAtIso: request.sourceUpdatedAtIso, strongEtag };
    this.publishMutations += 2;
    return { ok: true, verdict: 'published', createdRevision: true, revisionAlreadyPresentVerified: false, headCreated: previousRevisionId === null, headUpdated: previousRevisionId !== null, revisionReadbackVerified: true, headReadbackVerified: true, newHeadStrongEtag: strongEtag, newHeadStrongEtagSha256Hex: crypto.createHash('sha256').update(strongEtag).digest('hex'), remoteRevisionId: request.revisionId, remoteRevisionBlobSha256Hex: hash };
  }
  async h2o_sync_object_pull_transport() {
    this.pullReads += 2;
    if (!this.head) return { ok: true, verdict: 'head-absent', headPresent: false };
    const { strongEtag, ...head } = this.head;
    return { ok: true, verdict: 'transport-verified', headPresent: true, head, headStrongEtag: strongEtag, revisionBlobText: this.revisions.get(head.revisionBlobSha256), transportVerified: true };
  }
}

const strictEmptyRelationships = async () => ({ assets: [], folders: [], labels: [], tags: [] });

function wire(profile, transport, importOverride, bootId = `${profile.syncPeerId}:boot-1`, extra = {}) {
  profile.sandbox.H2O.Desktop.SyncObjectProjection.__test.setDependencies({
    stores: profile.stores,
    strictRelationshipProbe: strictEmptyRelationships,
  });
  profile.sandbox.H2O.Desktop.SyncObjectRuntime.__test.setDependencies({
    sql: profile.sql,
    transport,
    stores: profile.stores,
    syncPeerId: profile.syncPeerId,
    importBundle: importOverride || profile.sandbox.H2O.Studio.ingestion.importBundle,
    strictOwnerSchema: true,
    bootId,
    ...extra,
  });
}

function makeSiblingContext(profile) {
  const sandbox = {
    console, crypto: crypto.webcrypto, TextEncoder, TextDecoder, structuredClone,
    setTimeout, clearTimeout, __TAURI_INTERNALS__: { invoke: async () => { throw new Error('unexpected invoke'); } },
    H2O: { Studio: { store: profile.stores, ingestion: { importBundle: profile.sandbox.H2O.Studio.ingestion.importBundle } } },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(sources.projection, sandbox, { filename: 'sync-object-projection.tauri.js' });
  vm.runInContext(sources.runtime, sandbox, { filename: 'sync-object-runtime.tauri.js' });
  return { sandbox, db: profile.db, sql: profile.sql, stores: profile.stores, syncPeerId: profile.syncPeerId };
}

async function seedSnapshot(profile, snapshotId, answer, capturedAt) {
  const chatId = 'synthetic-chat-1';
  await profile.stores.chats.upsert({ chatId, title: 'Synthetic Round 2A', lastSnapshotId: snapshotId, snapshotCount: Number(snapshotId.endsWith('2') ? 2 : 1), isSaved: true, isLinked: true, updatedAt: capturedAt });
  await profile.stores.snapshots.create({
    snapshotId, chatId, title: 'Synthetic Round 2A', capturedAt, updatedAt: capturedAt,
    turns: [
      { turnIdx: 0, role: 'user', text: 'Synthetic question', outerHtml: '<p>Synthetic question</p>', meta: {} },
      { turnIdx: 1, role: 'assistant', text: answer, outerHtml: `<p>${answer}</p>`, meta: {} },
    ],
    messageCount: 2, meta: {},
  });
}

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'h2o-round2a-profiles-'));
let profileA;
let profileB;
const extraProfiles = [];
try {
  profileA = makeProfile(path.join(temporary, 'profile-a.db'), 'studio-desktop:profile-a');
  profileB = makeProfile(path.join(temporary, 'profile-b.db'), 'studio-desktop:profile-b');
  await profileA.stores.chats.init(); await profileA.stores.snapshots.init();
  await profileB.stores.chats.init(); await profileB.stores.snapshots.init();
  check(profileA.db !== profileB.db && profileA.syncPeerId !== profileB.syncPeerId, 'profiles have independent databases and syncPeerIds');

  await seedSnapshot(profileA, 'snapshot-1', 'Synthetic answer one', 1784628000000);
  await profileB.stores.chats.upsert({ chatId: 'unrelated-chat', title: 'Unrelated', isLinked: true, href: 'https://example.test/unrelated' });
  const unrelatedBefore = await profileB.stores.chats.get('unrelated-chat');
  const remote = new SharedWebDav();
  wire(profileA, remote); wire(profileB, remote);

  const published1 = await profileA.sandbox.H2O.Desktop.SyncObjectRuntime.publishObject('synthetic-chat-1');
  check(published1.ok && published1.headReadbackVerified, 'first source publish succeeds');
  const pulled1 = await profileB.sandbox.H2O.Desktop.SyncObjectRuntime.pullObject('synthetic-chat-1');
  check(pulled1.ok && pulled1.applied && pulled1.convergenceVerified, 'first destination pull/apply proves convergence');
  const destination1 = await profileB.stores.snapshots.get('snapshot-1');
  check(destination1 && destination1.turns.length === 2, 'destination contains exact first revision turns');

  const repeat1 = await profileB.sandbox.H2O.Desktop.SyncObjectRuntime.pullObject('synthetic-chat-1');
  check(repeat1.ok && repeat1.unchangedNoOp && repeat1.convergenceVerified, 'repeated first pull is store-verified no-op');

  await seedSnapshot(profileA, 'snapshot-2', 'Synthetic answer two', 1784628060000);
  const published2 = await profileA.sandbox.H2O.Desktop.SyncObjectRuntime.publishObject('synthetic-chat-1');
  check(published2.ok && published2.headUpdated, 'second source snapshot advances guarded head');

  let interruptOnce = true;
  let interruptedImporterCalls = 0;
  const realImport = profileB.sandbox.H2O.Studio.ingestion.importBundle;
  wire(profileB, remote, async (...args) => {
    interruptedImporterCalls += 1;
    const result = await realImport(...args);
    if (interruptOnce) { interruptOnce = false; throw new Error('simulated-apply-interruption'); }
    return result;
  });
  await assert.rejects(profileB.sandbox.H2O.Desktop.SyncObjectRuntime.pullObject('synthetic-chat-1'), /simulated-apply-interruption/); assertions += 1;
  const pending = profileB.db.prepare("SELECT pending_operation, operation_phase FROM sync_object_state WHERE object_id = 'synthetic-chat-1'").get();
  check(pending.pending_operation === 'pull' && pending.operation_phase === 'apply', 'interrupted apply remains durably pending');

  const sibling = makeSiblingContext(profileB);
  let siblingImporterCalls = 0;
  wire(sibling, remote, async (...args) => { siblingImporterCalls += 1; return realImport(...args); }, `${profileB.syncPeerId}:boot-1`);
  await assert.rejects(sibling.sandbox.H2O.Desktop.SyncObjectRuntime.pullObject('synthetic-chat-1'), /round2a-local-operation-busy/); assertions += 1;
  check(siblingImporterCalls === 0 && interruptedImporterCalls === 1, 'same-boot second VM context cannot steal apply or invoke importer');

  wire(profileB, remote, undefined, `${profileB.syncPeerId}:boot-2`);
  const resumed = await profileB.sandbox.H2O.Desktop.SyncObjectRuntime.pullObject('synthetic-chat-1');
  check(resumed.ok && resumed.applied && resumed.convergenceVerified, 'different-boot adoption idempotently resumes second revision');
  const destination2 = await profileB.stores.snapshots.get('snapshot-2');
  const destinationChat = await profileB.stores.chats.get('synthetic-chat-1');
  check(destination2 && destination2.turns[1].text === 'Synthetic answer two' && destinationChat.lastSnapshotId === 'snapshot-2', 'destination pointer and turn content match second revision');

  const repeat2 = await profileB.sandbox.H2O.Desktop.SyncObjectRuntime.pullObject('synthetic-chat-1');
  check(repeat2.ok && repeat2.unchangedNoOp, 'repeated second-revision apply is a no-op');
  const state = profileB.db.prepare("SELECT * FROM sync_object_state WHERE object_id = 'synthetic-chat-1'").get();
  check(state.pending_operation === null && state.last_applied_revision_id === 'snapshot-2' && state.convergence_watermark_sha256 === state.last_applied_revision_blob_sha256 && state.consumed_revision_blob_sha256 === state.last_applied_revision_blob_sha256, 'ledger, watermark, and durable state commit only after convergence');

  const unrelatedAfter = await profileB.stores.chats.get('unrelated-chat');
  check(JSON.stringify(unrelatedAfter) === JSON.stringify(unrelatedBefore), 'unrelated destination object is unchanged');
  check(profileA.db.prepare('SELECT COUNT(*) AS n FROM sync_object_state').get().n === 1 && profileB.db.prepare('SELECT COUNT(*) AS n FROM sync_object_state').get().n === 1, 'profiles share no state or ledger rows');
  check(remote.revisions.size === 2, 'shared fake WebDAV contains exactly two immutable revisions');

  const terminalFailure = makeProfile(path.join(temporary, 'terminal-pull-failure.db'), 'studio-desktop:terminal-pull-failure');
  extraProfiles.push(terminalFailure);
  await terminalFailure.stores.chats.init(); await terminalFailure.stores.snapshots.init();
  let terminalPullCalls = 0;
  const terminalTransport = {
    async h2o_sync_object_pull_transport() {
      terminalPullCalls += 1;
      if (terminalPullCalls === 1) {
        return {
          ok: false,
          verdict: 'blocked',
          errorCode: 'round2a-get-server-error',
          httpStatus: 503,
        };
      }
      return { ok: true, verdict: 'head-absent', headPresent: false, transportVerified: false };
    },
  };
  wire(terminalFailure, terminalTransport);
  const terminalResult = await terminalFailure.sandbox.H2O.Desktop.SyncObjectRuntime.pullObject('synthetic-chat-1');
  check(!terminalResult.ok && terminalResult.errorCode === 'round2a-get-server-error' && terminalResult.httpStatus === 503, 'safe GET status failure is returned without losing its numeric status');
  const terminalRow = terminalFailure.db.prepare("SELECT pending_operation, operation_phase, owner_boot_id, owner_context_id, owner_token, last_error_code FROM sync_object_state WHERE object_id = 'synthetic-chat-1'").get();
  check(terminalRow.pending_operation === null && terminalRow.operation_phase === null &&
    terminalRow.owner_boot_id === null && terminalRow.owner_context_id === null &&
    terminalRow.owner_token === null && terminalRow.last_error_code === 'round2a-get-server-error',
  'terminal GET failure clears durable ownership while preserving the safe error code');
  const terminalRetry = await terminalFailure.sandbox.H2O.Desktop.SyncObjectRuntime.pullObject('synthetic-chat-1');
  check(terminalRetry.ok && terminalRetry.verdict === 'head-absent' && terminalPullCalls === 2, 'terminal error row is automatically reacquired and retried without manual repair');
  const terminalRetryRow = terminalFailure.db.prepare("SELECT pending_operation, operation_phase, last_error_code FROM sync_object_state WHERE object_id = 'synthetic-chat-1'").get();
  check(terminalRetryRow.pending_operation === null && terminalRetryRow.operation_phase === null && terminalRetryRow.last_error_code === null, 'successful retry leaves an inspectable idle row');

  const conflictSource = makeProfile(path.join(temporary, 'conflict-source.db'), 'studio-desktop:conflict-source');
  extraProfiles.push(conflictSource);
  await conflictSource.stores.chats.init(); await conflictSource.stores.snapshots.init();
  await seedSnapshot(conflictSource, 'remote-1', 'Remote answer', 1784629000000);
  const conflictRemote = new SharedWebDav();
  wire(conflictSource, conflictRemote);
  await conflictSource.sandbox.H2O.Desktop.SyncObjectRuntime.publishObject('synthetic-chat-1');

  const firstConflict = makeProfile(path.join(temporary, 'first-conflict.db'), 'studio-desktop:first-conflict');
  extraProfiles.push(firstConflict);
  await firstConflict.stores.chats.init(); await firstConflict.stores.snapshots.init();
  await seedSnapshot(firstConflict, 'local-1', 'Local unsynced answer', 1784629100000);
  await firstConflict.stores.chats.upsert({ chatId: 'unrelated-chat', title: 'Untouched', lastSnapshotId: null, isSaved: true, isLinked: true });
  const firstConflictBefore = {
    chat: firstConflict.db.prepare("SELECT * FROM chats WHERE id = 'synthetic-chat-1'").get(),
    snapshots: firstConflict.db.prepare("SELECT * FROM snapshots WHERE chat_id = 'synthetic-chat-1' ORDER BY id").all(),
    turns: firstConflict.db.prepare("SELECT * FROM snapshot_turns ORDER BY snapshot_id, turn_idx").all(),
    unrelated: firstConflict.db.prepare("SELECT * FROM chats WHERE id = 'unrelated-chat'").get(),
  };
  let conflictImporterCalls = 0;
  const conflictImport = firstConflict.sandbox.H2O.Studio.ingestion.importBundle;
  wire(firstConflict, conflictRemote, async (...args) => { conflictImporterCalls += 1; return conflictImport(...args); });
  const firstBlocked = await firstConflict.sandbox.H2O.Desktop.SyncObjectRuntime.pullObject('synthetic-chat-1');
  check(!firstBlocked.ok && firstBlocked.conflictClass === 'local-unexported-change', 'first pull blocks a different pre-existing unsynced destination pointer');
  check(conflictImporterCalls === 0, 'first-pull conflict occurs before importer invocation');
  const firstConflictAfter = {
    chat: firstConflict.db.prepare("SELECT * FROM chats WHERE id = 'synthetic-chat-1'").get(),
    snapshots: firstConflict.db.prepare("SELECT * FROM snapshots WHERE chat_id = 'synthetic-chat-1' ORDER BY id").all(),
    turns: firstConflict.db.prepare("SELECT * FROM snapshot_turns ORDER BY snapshot_id, turn_idx").all(),
    unrelated: firstConflict.db.prepare("SELECT * FROM chats WHERE id = 'unrelated-chat'").get(),
  };
  check(JSON.stringify(firstConflictAfter) === JSON.stringify(firstConflictBefore), 'first-pull conflict preserves chat pointer, snapshots, turns, and unrelated chat exactly');

  const foreignOwned = makeProfile(path.join(temporary, 'foreign-owned.db'), 'studio-desktop:foreign-owned');
  extraProfiles.push(foreignOwned);
  await foreignOwned.stores.chats.init(); await foreignOwned.stores.snapshots.init();
  await seedSnapshot(foreignOwned, 'remote-1', 'Remote answer', 1784629000000);
  await foreignOwned.stores.chats.upsert({ chatId: 'foreign-chat-y', title: 'Foreign owner Y', lastSnapshotId: null, isSaved: true, isLinked: true });
  foreignOwned.db.prepare("UPDATE snapshots SET chat_id = 'foreign-chat-y' WHERE id = 'remote-1'").run();
  const foreignBefore = {
    x: foreignOwned.db.prepare("SELECT * FROM chats WHERE id = 'synthetic-chat-1'").get(),
    y: foreignOwned.db.prepare("SELECT * FROM chats WHERE id = 'foreign-chat-y'").get(),
    snapshot: foreignOwned.db.prepare("SELECT * FROM snapshots WHERE id = 'remote-1'").get(),
    turns: foreignOwned.db.prepare("SELECT * FROM snapshot_turns WHERE snapshot_id = 'remote-1' ORDER BY turn_idx").all(),
  };
  let foreignImporterCalls = 0;
  wire(foreignOwned, conflictRemote, async () => { foreignImporterCalls += 1; return { ok: true }; });
  const foreignBlocked = await foreignOwned.sandbox.H2O.Desktop.SyncObjectRuntime.pullObject('synthetic-chat-1');
  check(!foreignBlocked.ok && foreignBlocked.conflictClass === 'local-unexported-change' && foreignImporterCalls === 0, 'foreign-owned matching snapshot cannot satisfy verified adoption');
  const foreignAfter = {
    x: foreignOwned.db.prepare("SELECT * FROM chats WHERE id = 'synthetic-chat-1'").get(),
    y: foreignOwned.db.prepare("SELECT * FROM chats WHERE id = 'foreign-chat-y'").get(),
    snapshot: foreignOwned.db.prepare("SELECT * FROM snapshots WHERE id = 'remote-1'").get(),
    turns: foreignOwned.db.prepare("SELECT * FROM snapshot_turns WHERE snapshot_id = 'remote-1' ORDER BY turn_idx").all(),
  };
  check(JSON.stringify(foreignAfter) === JSON.stringify(foreignBefore), 'foreign-owned rejection preserves X, Y, snapshot, turns, and X pointer');
  const foreignState = foreignOwned.db.prepare("SELECT * FROM sync_object_state WHERE object_id = 'synthetic-chat-1'").get();
  check(foreignState.last_applied_revision_id === null && foreignState.last_applied_revision_blob_sha256 === null && foreignState.consumed_revision_blob_sha256 === null && foreignState.convergence_watermark_sha256 === null, 'foreign-owned rejection records no applied revision, consumed operation, or watermark');

  const divergentSnapshot = makeProfile(path.join(temporary, 'divergent-snapshot.db'), 'studio-desktop:divergent-snapshot');
  extraProfiles.push(divergentSnapshot);
  await divergentSnapshot.stores.chats.init(); await divergentSnapshot.stores.snapshots.init();
  await seedSnapshot(divergentSnapshot, 'remote-1', 'Remote answer', 1784629000000);
  divergentSnapshot.db.prepare("UPDATE snapshots SET title = 'Divergent transported title' WHERE id = 'remote-1'").run();
  const divergentBefore = {
    chat: divergentSnapshot.db.prepare("SELECT * FROM chats WHERE id = 'synthetic-chat-1'").get(),
    snapshot: divergentSnapshot.db.prepare("SELECT * FROM snapshots WHERE id = 'remote-1'").get(),
    turns: divergentSnapshot.db.prepare("SELECT * FROM snapshot_turns WHERE snapshot_id = 'remote-1' ORDER BY turn_idx").all(),
  };
  let divergentImporterCalls = 0;
  wire(divergentSnapshot, conflictRemote, async () => { divergentImporterCalls += 1; return { ok: true }; });
  const divergentBlocked = await divergentSnapshot.sandbox.H2O.Desktop.SyncObjectRuntime.pullObject('synthetic-chat-1');
  check(!divergentBlocked.ok && divergentBlocked.conflictClass === 'local-unexported-change' && divergentImporterCalls === 0, 'same-chat divergent normalized snapshot cannot satisfy verified adoption');
  const divergentAfter = {
    chat: divergentSnapshot.db.prepare("SELECT * FROM chats WHERE id = 'synthetic-chat-1'").get(),
    snapshot: divergentSnapshot.db.prepare("SELECT * FROM snapshots WHERE id = 'remote-1'").get(),
    turns: divergentSnapshot.db.prepare("SELECT * FROM snapshot_turns WHERE snapshot_id = 'remote-1' ORDER BY turn_idx").all(),
  };
  check(JSON.stringify(divergentAfter) === JSON.stringify(divergentBefore), 'divergent snapshot rejection preserves chat, snapshot, turns, and pointer');
  const divergentState = divergentSnapshot.db.prepare("SELECT * FROM sync_object_state WHERE object_id = 'synthetic-chat-1'").get();
  check(divergentState.last_applied_revision_id === null && divergentState.consumed_revision_blob_sha256 === null && divergentState.convergence_watermark_sha256 === null, 'divergent snapshot rejection records no applied revision, consumed operation, or watermark');

  const adoptProfile = makeProfile(path.join(temporary, 'adopt.db'), 'studio-desktop:adopt');
  extraProfiles.push(adoptProfile);
  await adoptProfile.stores.chats.init(); await adoptProfile.stores.snapshots.init();
  await seedSnapshot(adoptProfile, 'remote-1', 'Remote answer', 1784629000000);
  let adoptionImporterCalls = 0;
  wire(adoptProfile, conflictRemote, async () => { adoptionImporterCalls += 1; return { ok: true }; });
  const adopted = await adoptProfile.sandbox.H2O.Desktop.SyncObjectRuntime.pullObject('synthetic-chat-1');
  check(adopted.ok && adopted.adoptedExisting && adopted.unchangedNoOp && adoptionImporterCalls === 0, 'exact pre-existing incoming snapshot is verified and adopted without importer');
  check(adoptProfile.db.prepare("SELECT COUNT(*) AS n FROM snapshots WHERE id = 'remote-1'").get().n === 1 && adoptProfile.db.prepare("SELECT COUNT(*) AS n FROM snapshot_turns WHERE snapshot_id = 'remote-1'").get().n === 2, 'adoption creates no duplicate snapshot or turns');

  const postImportDivergent = makeProfile(path.join(temporary, 'post-import-divergent.db'), 'studio-desktop:post-import-divergent');
  extraProfiles.push(postImportDivergent);
  await postImportDivergent.stores.chats.init(); await postImportDivergent.stores.snapshots.init();
  const postImportReal = postImportDivergent.sandbox.H2O.Studio.ingestion.importBundle;
  let postImportCalls = 0;
  wire(postImportDivergent, conflictRemote, async (...args) => {
    postImportCalls += 1;
    const result = await postImportReal(...args);
    postImportDivergent.db.prepare("UPDATE snapshots SET title = 'Corrupted after import' WHERE id = 'remote-1'").run();
    return result;
  });
  await assert.rejects(postImportDivergent.sandbox.H2O.Desktop.SyncObjectRuntime.pullObject('synthetic-chat-1'), /round2a-store-convergence-failed/); assertions += 1;
  const postImportState = postImportDivergent.db.prepare("SELECT * FROM sync_object_state WHERE object_id = 'synthetic-chat-1'").get();
  check(postImportCalls === 1 && postImportState.pending_operation === 'pull' && postImportState.operation_phase === 'apply' && postImportState.last_applied_revision_id === null && postImportState.consumed_revision_blob_sha256 === null && postImportState.convergence_watermark_sha256 === null, 'post-import divergence remains apply-pending and cannot commit applied state or watermark');

  const advancedProfile = makeProfile(path.join(temporary, 'advanced.db'), 'studio-desktop:advanced');
  extraProfiles.push(advancedProfile);
  await advancedProfile.stores.chats.init(); await advancedProfile.stores.snapshots.init();
  await seedSnapshot(advancedProfile, 'local-advanced', 'Advanced local answer', 1784629200000);
  advancedProfile.db.prepare('INSERT INTO sync_object_state (sync_peer_id, object_id, last_applied_revision_id, last_applied_revision_blob_sha256, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(advancedProfile.syncPeerId, 'synthetic-chat-1', 'remote-old', 'f'.repeat(64), new Date().toISOString(), new Date().toISOString());
  let advancedImporterCalls = 0;
  wire(advancedProfile, conflictRemote, async () => { advancedImporterCalls += 1; return { ok: true }; });
  const advancedBlocked = await advancedProfile.sandbox.H2O.Desktop.SyncObjectRuntime.pullObject('synthetic-chat-1');
  check(!advancedBlocked.ok && advancedBlocked.conflictClass === 'local-unexported-change' && advancedImporterCalls === 0, 'independently advanced pointer conflicts before importer when prior applied revision exists');

  const projectionFailure = makeProfile(path.join(temporary, 'projection-failure.db'), 'studio-desktop:projection-failure');
  extraProfiles.push(projectionFailure);
  await projectionFailure.stores.chats.init(); await projectionFailure.stores.snapshots.init();
  wire(projectionFailure, new SharedWebDav());
  await assert.rejects(projectionFailure.sandbox.H2O.Desktop.SyncObjectRuntime.publishObject('missing-chat'), /round2a-unsupported-object-shape/); assertions += 1;
  check(projectionFailure.db.prepare('SELECT COUNT(*) AS n FROM sync_object_state').get().n === 0, 'projection failure creates no pending operation row');

  const preTransportFailure = makeProfile(path.join(temporary, 'pre-transport-failure.db'), 'studio-desktop:pre-transport-failure');
  extraProfiles.push(preTransportFailure);
  await preTransportFailure.stores.chats.init(); await preTransportFailure.stores.snapshots.init();
  await seedSnapshot(preTransportFailure, 'preflight-1', 'Preflight answer', 1784629300000);
  wire(preTransportFailure, new SharedWebDav(), undefined, `${preTransportFailure.syncPeerId}:boot-1`, {
    beforePublishTransport: async () => { throw new Error('round2a-pretransport-test-failure'); },
  });
  await assert.rejects(preTransportFailure.sandbox.H2O.Desktop.SyncObjectRuntime.publishObject('synthetic-chat-1'), /round2a-pretransport-test-failure/); assertions += 1;
  const preflightRow = preTransportFailure.db.prepare("SELECT pending_operation, owner_token, last_error_code FROM sync_object_state WHERE object_id = 'synthetic-chat-1'").get();
  check(preflightRow.pending_operation === null && preflightRow.owner_token === null && preflightRow.last_error_code === 'round2a-pretransport-test-failure', 'known pre-transport failure clears ownership by token CAS and records safe error');

  const terminalLayoutFailure = makeProfile(path.join(temporary, 'terminal-layout-failure.db'), 'studio-desktop:terminal-layout-failure');
  extraProfiles.push(terminalLayoutFailure);
  await terminalLayoutFailure.stores.chats.init(); await terminalLayoutFailure.stores.snapshots.init();
  await seedSnapshot(terminalLayoutFailure, 'layout-1', 'Layout answer', 1784629350000);
  const terminalLayoutRemote = new SharedWebDav();
  let terminalLayoutCalls = 0;
  const terminalLayoutResults = [
    {
      ok: false,
      verdict: 'blocked',
      conflictClass: null,
      errorCode: 'round2a-layout-propfind-failed',
    },
    {
      ok: false,
      verdict: 'blocked',
      conflictClass: null,
      errorCode: 'round2a-layout-server-error',
      httpStatus: 503,
    },
    ...[
      'round2a-layout-connect-failed',
      'round2a-layout-timeout',
      'round2a-layout-request-failed',
      'round2a-layout-response-read-failed',
    ].map(errorCode => ({
      ok: false,
      verdict: 'blocked',
      conflictClass: null,
      errorCode,
      remoteSideEffectUncertain: false,
    })),
  ];
  const terminalLayoutTransport = {
    async h2o_sync_object_publish_transport(request) {
      terminalLayoutCalls += 1;
      if (terminalLayoutCalls <= terminalLayoutResults.length) {
        return terminalLayoutResults[terminalLayoutCalls - 1];
      }
      return terminalLayoutRemote.h2o_sync_object_publish_transport(request);
    },
    async h2o_sync_object_pull_transport(request) {
      return terminalLayoutRemote.h2o_sync_object_pull_transport(request);
    },
  };
  wire(terminalLayoutFailure, terminalLayoutTransport);
  const layoutFailure = await terminalLayoutFailure.sandbox.H2O.Desktop.SyncObjectRuntime.publishObject('synthetic-chat-1');
  check(!layoutFailure.ok && layoutFailure.errorCode === 'round2a-layout-propfind-failed' &&
    !layoutFailure.localRecoveryPending,
  'legacy generic PROPFIND failure is terminal rather than uncertain');
  const layoutFailureRow = terminalLayoutFailure.db.prepare("SELECT pending_operation, operation_phase, owner_boot_id, owner_context_id, owner_token, last_error_code, last_conflict_class FROM sync_object_state WHERE object_id = 'synthetic-chat-1'").get();
  check(layoutFailureRow.pending_operation === null && layoutFailureRow.operation_phase === null &&
    layoutFailureRow.owner_boot_id === null && layoutFailureRow.owner_context_id === null &&
    layoutFailureRow.owner_token === null &&
    layoutFailureRow.last_error_code === 'round2a-layout-propfind-failed' &&
    layoutFailureRow.last_conflict_class === null,
  'terminal PROPFIND failure clears durable ownership and is not misreported as a conflict');
  const classifiedLayoutFailure = await terminalLayoutFailure.sandbox.H2O.Desktop.SyncObjectRuntime.publishObject('synthetic-chat-1');
  check(!classifiedLayoutFailure.ok &&
    classifiedLayoutFailure.errorCode === 'round2a-layout-server-error' &&
    classifiedLayoutFailure.httpStatus === 503 &&
    !classifiedLayoutFailure.localRecoveryPending,
  'classified PROPFIND failure preserves safe status and remains terminal');
  const classifiedLayoutRow = terminalLayoutFailure.db.prepare("SELECT pending_operation, operation_phase, last_error_code FROM sync_object_state WHERE object_id = 'synthetic-chat-1'").get();
  check(classifiedLayoutRow.pending_operation === null &&
    classifiedLayoutRow.operation_phase === null &&
    classifiedLayoutRow.last_error_code === 'round2a-layout-server-error',
  'classified PROPFIND failure remains immediately retryable');
  for (const errorCode of [
    'round2a-layout-connect-failed',
    'round2a-layout-timeout',
    'round2a-layout-request-failed',
    'round2a-layout-response-read-failed',
  ]) {
    const dispatchFailure = await terminalLayoutFailure.sandbox.H2O.Desktop.SyncObjectRuntime.publishObject('synthetic-chat-1');
    const dispatchRow = terminalLayoutFailure.db.prepare("SELECT pending_operation, operation_phase, last_error_code, last_conflict_class FROM sync_object_state WHERE object_id = 'synthetic-chat-1'").get();
    check(!dispatchFailure.ok && dispatchFailure.errorCode === errorCode &&
      !dispatchFailure.localRecoveryPending &&
      dispatchRow.pending_operation === null && dispatchRow.operation_phase === null &&
      dispatchRow.last_error_code === errorCode && dispatchRow.last_conflict_class === null,
    `structured ${errorCode} failure clears ownership, remains inspectable, and is immediately reacquirable`);
  }
  const layoutRetry = await terminalLayoutFailure.sandbox.H2O.Desktop.SyncObjectRuntime.publishObject('synthetic-chat-1');
  check(layoutRetry.ok && layoutRetry.localStateCommitted &&
    terminalLayoutCalls === terminalLayoutResults.length + 1,
    'same-boot retry reacquires terminal layout rows without manual repair');
  const layoutRetryRow = terminalLayoutFailure.db.prepare("SELECT pending_operation, operation_phase, last_error_code FROM sync_object_state WHERE object_id = 'synthetic-chat-1'").get();
  check(layoutRetryRow.pending_operation === null && layoutRetryRow.operation_phase === null &&
    layoutRetryRow.last_error_code === null,
  'successful layout retry leaves an inspectable committed row');

  const nativeDisposition = makeProfile(path.join(temporary, 'native-disposition.db'), 'studio-desktop:native-disposition');
  extraProfiles.push(nativeDisposition);
  await nativeDisposition.stores.chats.init(); await nativeDisposition.stores.snapshots.init();
  await seedSnapshot(nativeDisposition, 'disposition-1', 'Disposition answer', 1784629360000);
  let nativeDispositionCalls = 0;
  wire(nativeDisposition, {
    async h2o_sync_object_publish_transport() {
      nativeDispositionCalls += 1;
      return nativeDispositionCalls === 1
        ? {
            ok: false,
            verdict: 'blocked',
            conflictClass: null,
            errorCode: 'round2a-head-put-failed',
            httpStatus: 400,
            remoteSideEffectUncertain: false,
          }
        : {
            ok: false,
            verdict: 'blocked',
            conflictClass: null,
            errorCode: 'round2a-revision-put-server-error',
            httpStatus: 503,
            remoteSideEffectUncertain: true,
          };
    },
    async h2o_sync_object_pull_transport() {
      throw new Error('unexpected pull');
    },
  });
  const nativeTerminal = await nativeDisposition.sandbox.H2O.Desktop.SyncObjectRuntime.publishObject('synthetic-chat-1');
  check(!nativeTerminal.ok && nativeTerminal.remoteSideEffectUncertain === false &&
    !nativeTerminal.localRecoveryPending,
  'native terminal disposition overrides the legacy code fallback');
  const nativeTerminalRow = nativeDisposition.db.prepare(
    "SELECT pending_operation, operation_phase, owner_token, last_error_code FROM sync_object_state WHERE object_id = 'synthetic-chat-1'"
  ).get();
  check(nativeTerminalRow.pending_operation === null && nativeTerminalRow.operation_phase === null &&
    nativeTerminalRow.owner_token === null && nativeTerminalRow.last_error_code === 'round2a-head-put-failed',
  'native terminal disposition clears durable ownership');
  const nativeUncertain = await nativeDisposition.sandbox.H2O.Desktop.SyncObjectRuntime.publishObject('synthetic-chat-1');
  check(!nativeUncertain.ok && nativeUncertain.remoteSideEffectUncertain === true &&
    nativeUncertain.localRecoveryPending === true,
  'native uncertain disposition preserves recovery even for a newly classified code');
  const nativeUncertainRow = nativeDisposition.db.prepare(
    "SELECT pending_operation, operation_phase, owner_token, last_error_code FROM sync_object_state WHERE object_id = 'synthetic-chat-1'"
  ).get();
  check(nativeUncertainRow.pending_operation === 'publish' &&
    nativeUncertainRow.operation_phase === 'transport' &&
    typeof nativeUncertainRow.owner_token === 'string' &&
    nativeUncertainRow.last_error_code === 'round2a-revision-put-server-error',
  'native uncertain disposition retains exact transport recovery state');

  const recoveryProfile = makeProfile(path.join(temporary, 'publish-recovery.db'), 'studio-desktop:publish-recovery');
  extraProfiles.push(recoveryProfile);
  await recoveryProfile.stores.chats.init(); await recoveryProfile.stores.snapshots.init();
  await seedSnapshot(recoveryProfile, 'recovery-1', 'Recovery answer', 1784629400000);
  const recoveryRemote = new SharedWebDav();
  let failCommitOnce = true;
  const failingSql = {
    select: recoveryProfile.sql.select,
    execute: async (query, values) => {
      if (failCommitOnce && query.includes('last_published_revision_id = ?')) {
        failCommitOnce = false;
        throw new Error('simulated-process-loss-before-local-commit');
      }
      return recoveryProfile.sql.execute(query, values);
    },
  };
  wire(recoveryProfile, recoveryRemote, undefined, `${recoveryProfile.syncPeerId}:boot-1`, { sql: failingSql });
  await assert.rejects(recoveryProfile.sandbox.H2O.Desktop.SyncObjectRuntime.publishObject('synthetic-chat-1'), /simulated-process-loss-before-local-commit/); assertions += 1;
  const recoveryPending = recoveryProfile.db.prepare("SELECT * FROM sync_object_state WHERE object_id = 'synthetic-chat-1'").get();
  check(recoveryPending.pending_operation === 'publish' && recoveryPending.operation_phase === 'transport' && recoveryPending.intended_revision_id === 'recovery-1' && recoveryPending.intended_object_key && recoveryPending.intended_payload_sha256 && recoveryPending.intended_revision_blob_sha256, 'possibly committed publish preserves exact intended identity and owner state');
  const mutationCountAfterLoss = recoveryRemote.publishMutations;
  wire(recoveryProfile, recoveryRemote, undefined, `${recoveryProfile.syncPeerId}:boot-2`);
  const reconciled = await recoveryProfile.sandbox.H2O.Desktop.SyncObjectRuntime.publishObject('synthetic-chat-1');
  check(reconciled.ok && reconciled.unchangedNoOp && reconciled.localStateCommitted && recoveryRemote.publishMutations === mutationCountAfterLoss, 'new boot adopts exact publish intent and reconciles remote success without duplicate mutation');

  const localTarget = makeProfile(
    path.join(temporary, 'admitted-local-target.db'),
    'studio-desktop:admitted-local-target',
    { lazyLocalSource: true }
  );
  extraProfiles.push(localTarget);
  await localTarget.stores.chats.init(); await localTarget.stores.snapshots.init();
  const chromeWriter = 'studio-chrome:mv3-chrome:idb-archive:12345678-1234-4abc-8def-1234567890ab';
  const { strongEtag: _webDavEtag, ...transportHead } = conflictRemote.head;
  const localHead = { ...transportHead, writerSyncPeerId: chromeWriter };
  const localHeadText = localTarget.sandbox.H2O.Desktop.SyncObjectProjection.canonicalJson(localHead);
  const localRevisionText = conflictRemote.revisions.get(localHead.revisionBlobSha256);
  const localHeadHash = crypto.createHash('sha256').update(localHeadText).digest('hex');
  const localWriterHash = crypto.createHash('sha256').update(chromeWriter).digest('hex');
  const localPeerObjectKey = crypto.createHash('sha256').update(`${localWriterHash}\0${localHead.objectKey}`).digest('hex');
  const localRevisionKey = crypto.createHash('sha256').update(`${localPeerObjectKey}\0${localHead.revisionId}`).digest('hex');
  const admittedAt = '2026-08-21T12:00:00.000Z';
  localTarget.db.prepare(`
    INSERT INTO sync_inbound_revision_observations (
      key, schema, peer_object_key, object_id, object_key_sha256_hex,
      revision_id, revision_key_sha256_hex, parent_revision_id, parent_key,
      admission_disposition, admission_reason, canonical_head_bytes,
      canonical_revision_bytes, head_sha256_hex, revision_blob_sha256_hex,
      payload_sha256_hex, writer_sync_peer_id_sha256_hex, observed_state,
      apply_state, first_observed_at, last_observed_at, observation_count, admitted_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    localRevisionKey, 'h2o.studio.inbound-revision-observation.v1', localPeerObjectKey,
    localHead.objectId, localHead.objectKey, localHead.revisionId, localRevisionKey,
    localHead.previousRevisionId, 'root', 'accepted-linear', 'fast-forward',
    Buffer.from(localHeadText), Buffer.from(localRevisionText), localHeadHash,
    localHead.revisionBlobSha256, localHead.payloadSha256, localWriterHash,
    'observed', 'not-applied', admittedAt, admittedAt, 1, admittedAt
  );
  const localObservationSnapshot = () => localTarget.db.prepare(`
    SELECT key, schema, peer_object_key, object_id, object_key_sha256_hex,
      revision_id, revision_key_sha256_hex, parent_revision_id, parent_key,
      admission_disposition, admission_reason,
      hex(canonical_head_bytes) AS head_bytes,
      hex(canonical_revision_bytes) AS revision_bytes,
      head_sha256_hex, revision_blob_sha256_hex, payload_sha256_hex,
      writer_sync_peer_id_sha256_hex, observed_state, apply_state,
      first_observed_at, last_observed_at, observation_count, admitted_at
    FROM sync_inbound_revision_observations ORDER BY key
  `).all();
  const observationBefore = localObservationSnapshot();
  const localBranchView = () => {
    const state = localTarget.db.prepare(
      'SELECT last_applied_revision_id FROM sync_object_state WHERE object_id = ?'
    ).get(localHead.objectId);
    const anchor = state && state.last_applied_revision_id || null;
    const replay = anchor === localHead.revisionId;
    return {
      schema: 'h2o.studio.local-publication-branches.v1', ok: true,
      objectId: localHead.objectId, anchor, unavailableReason: null,
      pendingChain: replay ? [] : [localHead.revisionId],
      branches: [{
        revisionId: localHead.revisionId,
        parentRevisionId: localHead.previousRevisionId,
        historicalAdmission: 'accepted-linear', admissionReason: 'fast-forward',
        currentRelationship: replay ? 'orphaned-by-baseline-move' : 'pending-from-current-anchor',
        revisionBlobSha256Hex: localHead.revisionBlobSha256,
        payloadSha256Hex: localHead.payloadSha256, headSha256Hex: localHeadHash,
        writerSyncPeerIdSha256Hex: localWriterHash, applyState: 'not-applied',
        firstObservedAt: admittedAt, lastObservedAt: admittedAt, observationCount: 1,
      }],
      noApply: true, noNetwork: true,
    };
  };
  localTarget.sandbox.__configureLocalSource = localSourceApi => {
    localSourceApi.__test.setDependencies({
      sql: localTarget.sql,
      readBranches: async objectId => {
        assert.equal(objectId, localHead.objectId);
        return localBranchView();
      },
    });
  };
  let forbiddenWebDavCalls = 0;
  let localImporterCalls = 0;
  const localImporterInvocations = [];
  const localImport = localTarget.sandbox.H2O.Studio.ingestion.importBundle;
  wire(localTarget, {
    async h2o_sync_object_publish_transport() { forbiddenWebDavCalls += 1; throw new Error('unexpected WebDAV publish'); },
    async h2o_sync_object_pull_transport() { forbiddenWebDavCalls += 1; throw new Error('unexpected WebDAV pull'); },
  }, async (...args) => {
    localImporterCalls += 1;
    localImporterInvocations.push(args);
    return localImport(...args);
  });
  const localRuntime = localTarget.sandbox.H2O.Desktop.SyncObjectRuntime;
  check(typeof localRuntime.applyNextAdmittedLocalRevision === 'function',
    'runtime exposes one explicit admitted-local Apply entry');
  const localApplied = await localRuntime.applyNextAdmittedLocalRevision(localHead.objectId);
  check(localTarget.scriptLoads.join(',') ===
    'tauri://localhost/sync/sync-object-local-source.tauri.js' &&
    typeof localTarget.sandbox.H2O.Desktop.SyncObjectLocalSource.readCandidate === 'function',
  'reader-route runtime root-loads and registers the packaged admitted-local source');
  const localSourceApi = localTarget.sandbox.H2O.Desktop.SyncObjectLocalSource;
  const expectedLocalStrongVersion = `local-admission:head-sha256:${localHeadHash}`;
  check(localApplied.ok && localApplied.applied && localApplied.convergenceVerified &&
    localApplied.sourceKind === 'admitted-local' && localApplied.sourceVerified === true &&
    localApplied.sourceStrongVersion === expectedLocalStrongVersion &&
    localApplied.headStrongEtag === undefined && forbiddenWebDavCalls === 0,
  'accepted-linear admitted local evidence reaches the existing Apply engine without WebDAV or a fabricated ETag');
  check(localImporterCalls === 1 && localImporterInvocations[0][1] === 'merge' &&
    localImporterInvocations[0][2] && localImporterInvocations[0][2].round2aContentOnly === true,
  'explicit local Apply delegates to the existing canonical content-only importer authority exactly once');
  check(localApplied.head.objectId === localHead.objectId &&
    localApplied.head.revisionId === localHead.revisionId &&
    localApplied.head.previousRevisionId === localHead.previousRevisionId &&
    localApplied.head.writerSyncPeerId === chromeWriter &&
    localApplied.head.revisionBlobSha256 === localHead.revisionBlobSha256 &&
    localApplied.head.payloadSha256 === localHead.payloadSha256 &&
    localApplied.headCanonicalText === localHeadText &&
    localApplied.revisionBlobText === localRevisionText &&
    localApplied.localEvidence.writerSyncPeerIdSha256Hex === localWriterHash,
  'local projection preserves object, revision, parent, writer, canonical bytes, and all immutable hashes exactly');
  const localAppliedState = localTarget.db.prepare(
    'SELECT * FROM sync_object_state WHERE object_id = ?'
  ).get(localHead.objectId);
  check(localAppliedState.last_applied_revision_id === localHead.revisionId &&
    localAppliedState.last_applied_revision_blob_sha256 === localHead.revisionBlobSha256 &&
    localAppliedState.consumed_revision_blob_sha256 === localHead.revisionBlobSha256 &&
    localAppliedState.remote_head_strong_etag === expectedLocalStrongVersion &&
    localAppliedState.remote_head_revision_blob_sha256 === localHead.revisionBlobSha256 &&
    localAppliedState.convergence_watermark_sha256 === localHead.revisionBlobSha256 &&
    localAppliedState.pending_operation === null && localAppliedState.operation_phase === null,
  'commitApplied advances the applied, consumed, remote-head, and convergence state consistently');
  const branchAfterApply = localBranchView();
  check(branchAfterApply.anchor === localHead.revisionId &&
    branchAfterApply.pendingChain.length === 0 &&
    branchAfterApply.branches[0].currentRelationship === 'orphaned-by-baseline-move',
  'advancing last_applied_revision_id naturally removes the applied revision from the pending chain without cleanup');

  const localReplay = await localRuntime.applyNextAdmittedLocalRevision(localHead.objectId);
  check(localReplay.ok && localReplay.unchangedNoOp && localReplay.convergenceVerified &&
    localReplay.verdict === 'local-admission-replay-verified' && localImporterCalls === 1 &&
    localTarget.db.prepare('SELECT COUNT(*) AS n FROM snapshots WHERE id = ?').get(localHead.revisionId).n === 1,
  'repeated local exposure is a store-verified replay and creates no second semantic revision');
  const replayState = localTarget.db.prepare(
    'SELECT last_applied_revision_id, last_applied_revision_blob_sha256, consumed_revision_blob_sha256, convergence_watermark_sha256 FROM sync_object_state WHERE object_id = ?'
  ).get(localHead.objectId);
  check(replayState.last_applied_revision_id === localHead.revisionId &&
    replayState.last_applied_revision_blob_sha256 === localHead.revisionBlobSha256 &&
    replayState.consumed_revision_blob_sha256 === localHead.revisionBlobSha256 &&
    replayState.convergence_watermark_sha256 === localHead.revisionBlobSha256,
  'replay preserves the exact durable applied revision, consumed hash, and convergence watermark');

  const unavailableLocalSource = makeProfile(
    path.join(temporary, 'unavailable-local-source.db'),
    'studio-desktop:unavailable-local-source',
    { lazyLocalSource: true, failLocalSourceLoad: true }
  );
  extraProfiles.push(unavailableLocalSource);
  await unavailableLocalSource.stores.chats.init();
  await unavailableLocalSource.stores.snapshots.init();
  wire(unavailableLocalSource, new SharedWebDav());
  await assert.rejects(
    unavailableLocalSource.sandbox.H2O.Desktop.SyncObjectRuntime
      .applyNextAdmittedLocalRevision('missing-local-object'),
    /local-revision-source-unavailable/
  ); assertions += 1;
  check(unavailableLocalSource.scriptLoads.join(',') ===
    'tauri://localhost/sync/sync-object-local-source.tauri.js' &&
    !unavailableLocalSource.sandbox.H2O.Desktop.SyncObjectLocalSource,
  'genuinely unavailable root-anchored local source remains explicit and fail closed');

  for (const divergentReason of ['unknown-parent', 'sibling-fork']) {
    localSourceApi.__test.setDependencies({
      sql: { async select() { throw new Error('divergence must not read candidate bytes'); } },
      readBranches: async () => ({
        schema: 'h2o.studio.local-publication-branches.v1', ok: true,
        objectId: localHead.objectId, anchor: localHead.revisionId, unavailableReason: null,
        pendingChain: [],
        branches: [{
          revisionId: `${divergentReason}-child`, parentRevisionId: divergentReason === 'unknown-parent' ? 'unknown-parent' : localHead.revisionId,
          historicalAdmission: 'divergent-staged', admissionReason: divergentReason,
          currentRelationship: 'divergent-staged',
          revisionBlobSha256Hex: localHead.revisionBlobSha256,
          payloadSha256Hex: localHead.payloadSha256, headSha256Hex: localHeadHash,
          writerSyncPeerIdSha256Hex: localWriterHash, applyState: 'not-applied',
          firstObservedAt: admittedAt, lastObservedAt: admittedAt, observationCount: 1,
        }],
        noApply: true, noNetwork: true,
      }),
    });
    const divergentLocal = await localRuntime.applyNextAdmittedLocalRevision(localHead.objectId);
    check(!divergentLocal.ok && divergentLocal.conflictClass === 'local-revision-divergence' &&
      divergentLocal.headPresent === false && localImporterCalls === 1,
    `${divergentReason} evidence is surfaced as blocked and cannot reach canonical Apply`);
  }

  localSourceApi.__test.setDependencies({
    sql: { async select() { throw new Error('unavailable baseline must not read candidate bytes'); } },
    readBranches: async () => ({ ...localBranchView(), unavailableReason: 'local-baseline-unavailable' }),
  });
  const unavailableLocal = await localRuntime.applyNextAdmittedLocalRevision(localHead.objectId);
  check(!unavailableLocal.ok && unavailableLocal.conflictClass === 'local-revision-baseline-unavailable' &&
    localImporterCalls === 1,
  'unavailable baseline is surfaced as blocked and cannot reach canonical Apply');

  /* Desktop-authored objects have no inbound admission row: `branches` is
   * sourced from the admission ledger, so replaying a locally materialized
   * anchor legitimately matches nothing. That must be a benign no-op, or Apply
   * blocks the reconcile before publish and no Desktop object can ever be
   * published automatically. */
  localSourceApi.__test.setDependencies({
    sql: { async select() { throw new Error('desktop-authored anchor must not read candidate bytes'); } },
    readBranches: async () => ({
      ...localBranchView(), anchor: localHead.revisionId, pendingChain: [], branches: [],
    }),
  });
  const desktopAuthored = await localRuntime.applyNextAdmittedLocalRevision(localHead.objectId);
  check(desktopAuthored.ok === true && desktopAuthored.headPresent === false &&
    desktopAuthored.unchangedNoOp === true && !desktopAuthored.conflictClass &&
    localImporterCalls === 1,
  'desktop-authored anchor with no admission row is a benign no-op, not an identity conflict');

  /* Fail-closed counterpart: a pending-chain entry with no matching branch is a
   * genuine identity conflict and must still block. */
  localSourceApi.__test.setDependencies({
    sql: { async select() { throw new Error('identity conflict must not read candidate bytes'); } },
    readBranches: async () => ({
      ...localBranchView(), anchor: null, pendingChain: [localHead.revisionId], branches: [],
    }),
  });
  await assert.rejects(
    () => localRuntime.applyNextAdmittedLocalRevision(localHead.objectId),
    /local-revision-identity-conflict/
  ); assertions += 1;
  check(localImporterCalls === 1,
  'pending revision with no matching admission branch remains a fail-closed identity conflict');

  const storedLocalRow = localTarget.db.prepare(
    'SELECT * FROM sync_inbound_revision_observations WHERE revision_id = ?'
  ).get(localHead.revisionId);
  const conflictingBytes = Uint8Array.from(storedLocalRow.canonical_revision_bytes);
  conflictingBytes[conflictingBytes.length - 1] ^= 1;
  localSourceApi.__test.setDependencies({
    sql: { async select() { return [{ ...storedLocalRow, canonical_revision_bytes: conflictingBytes }]; } },
    readBranches: async () => localBranchView(),
  });
  await assert.rejects(localRuntime.applyNextAdmittedLocalRevision(localHead.objectId),
    /local-revision-evidence-invalid/); assertions += 1;
  check(localImporterCalls === 1,
    'same revision identity with conflicting immutable bytes fails before canonical importer invocation');

  const invalidWriter = 'studio-desktop:tauri-desktop:sqlite:12345678-1234-4abc-8def-1234567890ab';
  const invalidWriterHead = { ...localHead, writerSyncPeerId: invalidWriter };
  const invalidWriterHeadText = localTarget.sandbox.H2O.Desktop.SyncObjectProjection.canonicalJson(invalidWriterHead);
  const invalidWriterHash = crypto.createHash('sha256').update(invalidWriter).digest('hex');
  const invalidWriterHeadHash = crypto.createHash('sha256').update(invalidWriterHeadText).digest('hex');
  const invalidWriterPeerObjectKey = crypto.createHash('sha256').update(`${invalidWriterHash}\0${localHead.objectKey}`).digest('hex');
  const invalidWriterRevisionKey = crypto.createHash('sha256').update(`${invalidWriterPeerObjectKey}\0${localHead.revisionId}`).digest('hex');
  const invalidWriterRow = {
    ...storedLocalRow,
    key: invalidWriterRevisionKey,
    revision_key_sha256_hex: invalidWriterRevisionKey,
    peer_object_key: invalidWriterPeerObjectKey,
    canonical_head_bytes: Buffer.from(invalidWriterHeadText),
    head_sha256_hex: invalidWriterHeadHash,
    writer_sync_peer_id_sha256_hex: invalidWriterHash,
  };
  localSourceApi.__test.setDependencies({
    sql: { async select() { return [invalidWriterRow]; } },
    readBranches: async () => {
      const view = localBranchView();
      view.branches[0] = {
        ...view.branches[0],
        headSha256Hex: invalidWriterHeadHash,
        writerSyncPeerIdSha256Hex: invalidWriterHash,
      };
      return view;
    },
  });
  await assert.rejects(localRuntime.applyNextAdmittedLocalRevision(localHead.objectId),
    /local-revision-evidence-invalid/); assertions += 1;
  check(localImporterCalls === 1,
    'cryptographically self-consistent but invalid writer-role evidence fails before canonical importer invocation');
  check(JSON.stringify(localObservationSnapshot()) === JSON.stringify(observationBefore) &&
    localTarget.db.prepare("SELECT COUNT(*) AS n FROM sync_inbound_revision_observations WHERE apply_state = 'not-applied'").get().n === 1,
  'conflicting immutable bytes fail closed and every observation remains byte-identical and permanently not-applied');
  check(!/(?:INSERT|UPDATE|DELETE)\s+sync_inbound_revision_observations/i.test(sources.localSource),
    'local source contains no observation mutation statement');
  const packSource = fs.readFileSync(path.join(root, 'tools/product/studio/pack-studio.mjs'), 'utf8');
  check(packSource.split('sync/sync-object-local-source.tauri.js').length - 1 === 2,
    'the dormant local source is present in both aligned Studio pack manifests');
  const webDavState = profileB.db.prepare(
    'SELECT remote_head_strong_etag FROM sync_object_state WHERE object_id = ?'
  ).get('synthetic-chat-1');
  check(remote.pullReads > 0 && webDavState.remote_head_strong_etag === remote.head.strongEtag,
    'default WebDAV pulls retain their exact strong ETag behavior');

  const alternatingA = makeProfile(path.join(temporary, 'alternating-a.db'), 'studio-desktop:alternating-a');
  const alternatingB = makeProfile(path.join(temporary, 'alternating-b.db'), 'studio-desktop:alternating-b');
  extraProfiles.push(alternatingA, alternatingB);
  await alternatingA.stores.chats.init(); await alternatingA.stores.snapshots.init();
  await alternatingB.stores.chats.init(); await alternatingB.stores.snapshots.init();
  const alternatingRemote = new SharedWebDav();
  alternatingA.sandbox.H2O.Desktop.Sync = {
    executeAuthorizedSqlite: async ({ statements }) => {
      let rowsAffected = 0;
      for (const statement of statements) {
        const result = await alternatingA.sql.execute(
          statement.query,
          statement.values
        );
        rowsAffected += Number(result[0]) || 0;
      }
      return { ok: true, executed: true, rowsAffected };
    }
  };
  wire(alternatingA, alternatingRemote);
  wire(alternatingB, alternatingRemote);
  await seedSnapshot(alternatingA, 'snapshot-1', 'Alternating R1', 1784628100000);
  await alternatingA.sandbox.H2O.Desktop.SyncObjectRuntime.publishObject('synthetic-chat-1');
  await alternatingB.sandbox.H2O.Desktop.SyncObjectRuntime.pullObject('synthetic-chat-1');
  await seedSnapshot(alternatingB, 'snapshot-2', 'Alternating R2', 1784628200000);
  const authoredR2 = await alternatingB.sandbox.H2O.Desktop.SyncObjectProjection
    .projectObject('synthetic-chat-1');
  const authoredR2Publish = await alternatingRemote.h2o_sync_object_publish_transport({
    objectId: authoredR2.objectId,
    objectKeyHex: authoredR2.objectKeyHex,
    revisionId: authoredR2.revisionId,
    payloadSha256Hex: authoredR2.payloadSha256Hex,
    revisionBlobText: authoredR2.revisionBlobText,
    revisionBlobSha256Hex: authoredR2.revisionBlobSha256Hex,
    writerSyncPeerId: alternatingB.syncPeerId,
    sourceUpdatedAtIso: authoredR2.sourceUpdatedAtIso,
    expectedHead: {
      revisionId: alternatingRemote.head.revisionId,
      revisionBlobSha256Hex: alternatingRemote.head.revisionBlobSha256,
      strongEtag: alternatingRemote.head.strongEtag
    }
  });
  check(authoredR2Publish.ok && alternatingRemote.head.previousRevisionId === 'snapshot-1',
    'alternating author publishes R2 as a direct child of R1');
  const alternatingApplied = await alternatingA.sandbox.H2O.Desktop.SyncObjectRuntime
    .pullObject('synthetic-chat-1');
  const alternatingState = alternatingA.db.prepare(
    "SELECT last_published_revision_id, last_applied_revision_id FROM sync_object_state WHERE object_id = 'synthetic-chat-1'"
  ).get();
  check(alternatingApplied.ok && alternatingApplied.applied &&
    alternatingState.last_published_revision_id === 'snapshot-1' &&
    alternatingState.last_applied_revision_id === 'snapshot-2',
  'incoming child of locally authored R1 applies without pretending R1 was remotely applied');

  const staleOwner = makeProfile(path.join(temporary, 'stale-owner.db'), 'studio-desktop:stale-owner');
  extraProfiles.push(staleOwner);
  await staleOwner.stores.chats.init(); await staleOwner.stores.snapshots.init();
  wire(staleOwner, new SharedWebDav());
  const staleAcquisition = await staleOwner.sandbox.H2O.Desktop.SyncObjectRuntime.__test.acquire(staleOwner.syncPeerId, 'owned-object', 'pull', `${staleOwner.syncPeerId}:boot-1`);
  staleOwner.db.prepare("UPDATE sync_object_state SET owner_token = 'winner-token' WHERE object_id = 'owned-object'").run();
  await assert.rejects(staleOwner.sandbox.H2O.Desktop.SyncObjectRuntime.__test.updateOwned(staleAcquisition, staleOwner.syncPeerId, 'owned-object', 'operation_phase = ?', ['apply']), /round2a-local-operation-lost/); assertions += 1;
  check(staleOwner.db.prepare("SELECT owner_token, operation_phase FROM sync_object_state WHERE object_id = 'owned-object'").get().owner_token === 'winner-token', 'stale owner token cannot transition or clear winner state');
  staleOwner.sandbox.H2O.Desktop.SyncObjectRuntime.__test.clearDependencies();

  /* ---------------------------------------------------------------------- *
   * Interrupted P02 apply: nested richTurn metadata, then resume.
   *
   * A P02 revision carries a minted `p02-...` identity while its payload names
   * its own snapshot id, so a completed import leaves the canonical pointer at
   * the SNAPSHOT while last_applied_* names the REVISION. Two defects met here:
   *
   *   1. the importer read per-turn metadata only from the flat rt.<key> form,
   *      but a genuine payload nests it under richTurns[i].meta - the very
   *      representation convergence() compares against - so it persisted
   *      meta_json '{}' and convergence correctly refused AFTER the canonical
   *      rows were written;
   *   2. on the next boot the lineage gate saw localLast (the snapshot) !==
   *      incoming (the revision) and read that as a local unexported change, so
   *      the interrupted operation could never be completed or retried.
   *
   * Both halves run through the real runtime and the real importer.
   * ---------------------------------------------------------------------- */
  const nestedMeta = [
    { createTime: 1784628111, messageTimes: { 'msg-user-1': 1784628111 } },
    { assistantCreateTime: 1784628222, assistantMessageId: 'msg-assistant-1' },
  ];
  const rmObject = 'synthetic-chat-1';
  const rmSnapshotId = 'snap-nested-1';
  const rmRevisionId = 'p02-1234567890abcdef1234567890abcdef';
  const rmWriter = 'studio-chrome:mv3-chrome:idb-archive:12345678-1234-4abc-8def-1234567890ab';
  const rmPayload = {
    schema: 'h2o.studio.fullBundle.v2',
    chatArchive: {
      chats: [{
        chatId: rmObject, title: 'Nested meta',
        chatIndex: {
          title: 'Nested meta', lastSnapshotId: rmSnapshotId, snapshotCount: 1,
          messageCount: 2, state: { isSaved: true, isLinked: true }, organization: {},
        },
        snapshots: [{
          snapshotId: rmSnapshotId, chatId: rmObject,
          createdAt: '2026-08-26T00:00:00.000Z', messageCount: 2,
          messages: [
            { order: 0, role: 'user', text: 'Nested question' },
            { order: 1, role: 'assistant', text: 'Nested answer' },
          ],
          meta: {
            title: 'Nested meta',
            richTurns: [
              { turnIdx: 0, role: 'user', outerHTML: '<p>Nested question</p>', meta: nestedMeta[0] },
              { turnIdx: 1, role: 'assistant', outerHTML: '<p>Nested answer</p>', meta: nestedMeta[1] },
            ],
          },
        }],
      }],
      catalogs: { categories: [], labels: [], tags: [] },
    },
    chromeStorageLocal: {}, libraryKv: [],
  };
  const rmDest = makeProfile(path.join(temporary, 'p02-resume.db'), 'studio-desktop:p02-resume');
  extraProfiles.push(rmDest);
  await rmDest.stores.chats.init(); await rmDest.stores.snapshots.init();
  const rmCanonicalJson = rmDest.sandbox.H2O.Desktop.SyncObjectProjection.canonicalJson;
  const rmPayloadSha = crypto.createHash('sha256').update(rmCanonicalJson(rmPayload)).digest('hex');
  const rmObjectKey = await rmDest.sandbox.H2O.Desktop.SyncObjectProjection.objectKeyHex(rmObject);
  const rmRevisionValue = {
    schema: 'h2o.studio.syncRevision.v2', objectDomain: 'studio.chat.saved-state.v1',
    objectId: rmObject, revisionId: rmRevisionId, writerSyncPeerId: rmWriter,
    previousRevisionId: null, previousRevisionBlobSha256: null,
    payloadSha256: rmPayloadSha, payload: rmPayload,
  };
  const rmRevisionBlobSha = crypto.createHash('sha256').update(rmCanonicalJson(rmRevisionValue)).digest('hex');
  const rmCandidate = () => ({
    ok: true, headPresent: true, sourceKind: 'p02-admitted-local', sourceVerified: true,
    sourceStrongVersion: `p02-admission:revision:${rmRevisionBlobSha}`,
    revisionValue: rmRevisionValue,
    head: {
      schema: 'h2o.studio.syncHead.v2', objectId: rmObject, objectKey: rmObjectKey,
      revisionId: rmRevisionId, payloadSha256: rmPayloadSha,
      revisionBlobSha256: rmRevisionBlobSha, writerSyncPeerId: rmWriter,
      previousRevisionId: null, previousRevisionBlobSha256: null,
      sourceUpdatedAtIso: '2026-08-26T00:00:00.000Z',
    },
  });
  const rmP02Source = { readCandidate: async () => rmCandidate() };
  const rmRealImport = rmDest.sandbox.H2O.Studio.ingestion.importBundle;
  /* The pre-fix importer: same rows, but nested metadata dropped - exactly what
   * reading only the flat rt.<key> form produced. */
  const rmFlatOnlyImport = async (bundle, mode, options) => {
    const patched = structuredClone(bundle);
    for (const chat of patched.chatArchive.chats) {
      for (const snapshot of chat.snapshots) {
        for (const rich of snapshot.meta.richTurns) rich.meta = {};
      }
    }
    return rmRealImport(patched, mode, options);
  };
  const rmForbid = {
    async h2o_sync_object_publish_transport() { throw new Error('unexpected WebDAV publish'); },
    async h2o_sync_object_pull_transport() { throw new Error('unexpected WebDAV pull'); },
  };

  wire(rmDest, rmForbid, rmFlatOnlyImport, 'studio-desktop:p02-resume:boot-1', { p02LocalSource: rmP02Source });
  let rmInterrupted = null;
  try { rmInterrupted = await rmDest.sandbox.H2O.Desktop.SyncObjectRuntime.applyNextAdmittedP02Revision(rmObject); }
  catch (error) { rmInterrupted = { ok: false, errorCode: clean0(error && (error.code || error.message)) }; }
  check(rmInterrupted.ok !== true && clean0(rmInterrupted.errorCode) === 'round2a-store-convergence-failed',
    'the first P02 apply writes canonical rows and then fails convergence on empty turn metadata');
  const rmPartial = rmDest.db.prepare(
    "SELECT pending_operation, operation_phase, intended_revision_id, last_applied_revision_id, owner_boot_id FROM sync_object_state WHERE object_id = ?"
  ).get(rmObject);
  check(rmPartial.pending_operation === 'pull' && rmPartial.operation_phase === 'apply' &&
    rmPartial.intended_revision_id === rmRevisionId && rmPartial.last_applied_revision_id === null,
  'the interrupted state is a pending pull in its apply phase, bound to the intended revision, with nothing applied');
  const rmCounts = () => rmDest.db.prepare(
    "SELECT (SELECT COUNT(*) FROM chats) AS chats, (SELECT COUNT(*) FROM snapshots) AS snapshots, (SELECT COUNT(*) FROM snapshot_turns) AS turns"
  ).get();
  const rmPartialCounts = rmCounts();
  check(rmPartialCounts.chats === 1 && rmPartialCounts.snapshots === 1 && rmPartialCounts.turns === 2,
    'the interrupted apply already imported 1 chat, 1 snapshot and 2 turns');
  check(rmDest.db.prepare('SELECT meta_json FROM snapshot_turns WHERE turn_idx = 0').get().meta_json === '{}',
    'the interrupted apply persisted empty turn metadata');
  check(rmDest.db.prepare('SELECT last_snapshot_id FROM chats').get().last_snapshot_id === rmSnapshotId &&
    rmSnapshotId !== rmRevisionId,
  'the canonical pointer is the payload snapshot id, which is NOT the incoming revision id');

  /* A NEW boot with the real importer: it must adopt the stale operation and be
   * allowed to resume this exact partial apply. */
  wire(rmDest, rmForbid, null, 'studio-desktop:p02-resume:boot-2', { p02LocalSource: rmP02Source });
  let rmResumedPull = null;
  try { rmResumedPull = await rmDest.sandbox.H2O.Desktop.SyncObjectRuntime.applyNextAdmittedP02Revision(rmObject); }
  catch (error) { rmResumedPull = { ok: false, errorCode: clean0(error && (error.code || error.message)) }; }
  check(rmResumedPull.ok === true && rmResumedPull.applied === true && rmResumedPull.convergenceVerified === true,
    'the new boot adopts the stale pull, resumes the same revision and converges');
  const rmResumedCounts = rmCounts();
  check(rmResumedCounts.chats === 1 && rmResumedCounts.snapshots === 1 && rmResumedCounts.turns === 2,
    'the resumed import updates the existing rows in place and creates no duplicates');
  check(JSON.stringify(JSON.parse(rmDest.db.prepare('SELECT meta_json FROM snapshot_turns WHERE turn_idx = 0').get().meta_json)) === JSON.stringify(nestedMeta[0]) &&
    JSON.stringify(JSON.parse(rmDest.db.prepare('SELECT meta_json FROM snapshot_turns WHERE turn_idx = 1').get().meta_json)) === JSON.stringify(nestedMeta[1]),
  'the nested per-turn metadata is now persisted exactly as the payload declared it');
  const rmFinalState = rmDest.db.prepare(
    'SELECT pending_operation, operation_phase, owner_boot_id, owner_token, last_error_code, last_applied_revision_id, last_applied_revision_blob_sha256, last_applied_payload_sha256, last_converged_direction FROM sync_object_state WHERE object_id = ?'
  ).get(rmObject);
  check(rmFinalState.pending_operation === null && rmFinalState.operation_phase === null &&
    rmFinalState.owner_boot_id === null && rmFinalState.owner_token === null && rmFinalState.last_error_code === null,
  'a successful resume clears the pending operation, phase, owner claim and error');
  check(rmFinalState.last_applied_revision_id === rmRevisionId &&
    rmFinalState.last_applied_revision_blob_sha256 === rmRevisionBlobSha &&
    rmFinalState.last_applied_payload_sha256 === rmPayloadSha &&
    rmFinalState.last_converged_direction === 'applied',
  'the final applied identity binds the exact revision, blob, payload and direction');

  /* The safety side: the seam is bound to THIS adopted operation. A fresh boot
   * with an unrelated local snapshot and no pending apply must still be
   * protected by normal lineage handling. */
  const rmGuarded = makeProfile(path.join(temporary, 'p02-resume-guard.db'), 'studio-desktop:p02-guard');
  extraProfiles.push(rmGuarded);
  await rmGuarded.stores.chats.init(); await rmGuarded.stores.snapshots.init();
  await seedSnapshot(rmGuarded, 'unrelated-local-snapshot', 'Divergent local answer', 1784628999000);
  wire(rmGuarded, rmForbid, null, 'studio-desktop:p02-guard:boot-1', { p02LocalSource: rmP02Source });
  let rmBlocked = null;
  try { rmBlocked = await rmGuarded.sandbox.H2O.Desktop.SyncObjectRuntime.applyNextAdmittedP02Revision(rmObject); }
  catch (error) { rmBlocked = { ok: false, errorCode: clean0(error && (error.code || error.message)) }; }
  check(rmBlocked.ok !== true && clean0(rmBlocked.errorCode) === 'local-unexported-change',
    'an unrelated local snapshot with no adopted pending apply still hits local-unexported-change');

} finally {
  if (profileA) profileA.db.close();
  if (profileB) profileB.db.close();
  for (const profile of extraProfiles) profile.db.close();
  fs.rmSync(temporary, { recursive: true, force: true });
}

console.log(`ROUND2A_APPLY_IDEMPOTENCY_PASS assertions=${assertions}`);
