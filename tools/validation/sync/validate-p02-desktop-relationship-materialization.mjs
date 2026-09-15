#!/usr/bin/env node
/*
 * P02 Folder Relationship Synchronization — T03 Desktop dispatch, dependency
 * and materialization validator.
 *
 * Mission p02-folder-relationship-synchronization, Task T03 (exit token
 * DESKTOP_RELATIONSHIP_MATERIALIZATION_PASS). Deterministic, disposable,
 * in-process: a v1..v23 SQLite fixture in a temporary directory, an in-memory
 * Chrome-authored P02 repository, a fake Tauri invoke that refuses every
 * command it does not model, and a JS double of the ratified fixed-statement
 * command running the same SQL under the same writer identity. No live
 * database, repository, Chrome runtime or transport is touched.
 *
 * Drives the REAL Desktop reverse composition, the REAL receive core, the
 * REAL branch admission adapter, the REAL classifier and scheduler, and the
 * REAL relationship materializer, and proves (prompt §18):
 *   A  domain dispatch: chat -> chat runtime, folder/binding -> materializer;
 *   B  chat + folder + binding coexist without an ambiguous fatal state;
 *   C  deterministic one-object-per-attempt sequencing, reproducible;
 *   D  folder root Apply creates a verbatim-id user folder;
 *   E  folder descendant renames only;
 *   F  binding root binds; G binding move replaces atomically; H Unfile;
 *   I  missing folder -> blocked(dependency)/folder-missing, no write;
 *   J  missing chat   -> blocked(dependency)/chat-missing, no write;
 *   K  dependency appears -> runnable on the next pass, same runtime instance;
 *   L  apply-time dependency recheck fails closed;
 *   M  the missing-folder path can never silently Unfile;
 *   N  already-applied replay: zero relationship writes, zero repository
 *      writes, no command invocation;
 *   O  duplicate/replayed advertisement idempotency;
 *   P  concurrent binding moves (Study vs Code) -> diverged-unresolved, both
 *      leaves retained, no materialization;
 *   Q  folder deletion is not materializable and a deleted folder blocks a
 *      binding without cascade, tombstone or Unfile;
 *   R  a relationship object never reaches the chat importer;
 *   S  a chat object never reaches the relationship command;
 *   T  the Library refresh request is exactly the Library-owned port;
 *   V  no live mutation: every write lands in the disposable fixture and the
 *      static writer-authority audit holds.
 * (U, the accepted chat regressions, is a separate run of their own validators.)
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../..');
const rel = (...parts) => path.join(repo, ...parts);
const read = (...parts) => fs.readFileSync(rel(...parts), 'utf8');
const importRepo = (...parts) => import(pathToFileURL(rel(...parts)).href);

const NUL = String.fromCharCode(0);
const CHAT_DOMAIN = 'studio.chat.saved-state.v1';
const FOLDER_DOMAIN = 'studio.folder.v1';
const BINDING_DOMAIN = 'studio.chat-folder-binding.v1';
const REMOTE = 'studio-chrome:mv3-chrome:idb-archive:t03-chrome-peer';
const LOCAL = 'studio-desktop:tauri-desktop:sqlite:t03-desktop-peer';
const SOURCE_AT = '2026-09-15T08:30:00.000Z';
const NOW_MS = Date.parse(SOURCE_AT);
const LIBRARY_REFRESH_EVENT = 'evt:h2o:library-index:refresh-request';
const COMMAND = 'h2o_p02_relationship_apply';
const IDENTITY = 'p02.relationship-apply';
const STORAGE_SCHEMA = 'h2o.studio.syncWriterStorageLocal.p02.v1';
const webcrypto = crypto.webcrypto;

let assertions = 0;
const failures = [];
const sections = [];
function check(condition, label) {
  assertions += 1;
  if (condition !== true) failures.push(label);
}
async function section(name, fn) {
  const before = failures.length;
  try {
    await fn();
  } catch (error) {
    failures.push(`${name}: threw ${error?.code || error?.message || error}`);
    if (process.env.H2O_VALIDATOR_TRACE) console.error(error);
  }
  sections.push({ name, ok: failures.length === before });
}
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const codeOf = async (fn) => { try { await fn(); return 'ok'; } catch (e) { return e?.code || 'threw'; } };
const stripComments = (text) => text
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

/* ---------------------------------------------------------------------- */
/* Migration fixture (mirrors the T01 substrate validator)                */
/* ---------------------------------------------------------------------- */
function extractStudioMigrations(libText) {
  const start = libText.indexOf('fn studio_migrations() -> Vec<Migration>');
  const end = libText.indexOf('\nasync fn ', start);
  const body = libText.slice(start, end);
  const migrations = [];
  const blockRe = /version:\s*(\d+),\s*description:\s*"([^"]*)",\s*sql:\s*(r#"([\s\S]*?)"#|"((?:[^"\\]|\\[\s\S])*)"),\s*kind:\s*MigrationKind::Up/g;
  let match;
  while ((match = blockRe.exec(body))) {
    const sql = match[4] !== undefined
      ? match[4]
      : match[5].replace(/\\\n\s*/g, '').replace(/\\"/g, '"');
    migrations.push({ version: Number(match[1]), description: match[2], sql });
  }
  return migrations.sort((a, b) => a.version - b.version);
}
const migrations = extractStudioMigrations(read('apps/studio/desktop/src-tauri/src/lib.rs'));
check(migrations.length > 0 && migrations[migrations.length - 1].version === 23, 'fixture ladder tops out at v23');

const scratch = fs.mkdtempSync(path.join(fs.realpathSync(process.env.TMPDIR || os.tmpdir()), 'p02-t03-desktop-'));
function openFixtureDb(name) {
  const file = path.join(scratch, `${name}.db`);
  const db = new DatabaseSync(file);
  let identity = '';
  db.function('h2o_writer_identity', () => identity);
  for (const migration of migrations) db.exec(migration.sql);
  /* The F16 guard is ON: a folder_bindings write without an admitted writer
   * identity is aborted by the v23 triggers, exactly as in production. */
  db.exec('UPDATE f16_folder_bindings_trigger_guard SET enabled = 1 WHERE id = 1');
  return { db, file, setIdentity: (value) => { identity = value; }, identity: () => identity };
}

/* ---------------------------------------------------------------------- */
/* Real modules                                                            */
/* ---------------------------------------------------------------------- */
const distGraph = await importRepo('tools/validation/sync/p02-dist-graph.mjs');
const packed = distGraph.stagePackedGraph();
const facade = await packed.importPacked('sync/sync-reverse-desktop-v2.tauri.mjs');
const relationship = await packed.importPacked('sync/sync-relationship-materialization-desktop-v2.tauri.mjs');
const classifier = await importRepo('packages/core/sync-object-classifier-v2.mjs');
const scheduler = await importRepo('packages/core/sync-object-scheduler-v2.mjs');
const contract = await importRepo('packages/browser-adapters/chrome/sync-contract-v2.mjs');
const production = await importRepo('packages/browser-adapters/chrome/sync-revision-production-v2.mjs');
const chatAdapter = await importRepo('packages/browser-adapters/chrome/sync-revision-domain-chat-v2.mjs');
const writerTransport = await importRepo('packages/browser-adapters/chrome/sync-writer-transport-v2.mjs');
const { objectKeyHex, writerKeyHex } = contract;
const { P02_DESKTOP_REVERSE_V2 } = facade;
const { P02_DESKTOP_RELATIONSHIP_V2: REL } = relationship;

/* ---------------------------------------------------------------------- */
/* Chrome-authored repository (memory), written by the REAL v2 writer      */
/* ---------------------------------------------------------------------- */
function makeRepository() {
  const files = new Map();
  const events = [];
  const storage = {
    async read(p) { return files.has(p) ? new Uint8Array(files.get(p)) : null; },
    async writeTemporary(p, bytes) { files.set(p, new Uint8Array(bytes)); events.push(`write:${p}`); },
    async readTemporary(p) { return files.has(p) ? new Uint8Array(files.get(p)) : null; },
    async promoteTemporary(pending, final, { replaceExisting = false } = {}) {
      if (!files.has(pending)) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      if (files.has(final) && !replaceExisting) throw Object.assign(new Error('exists'), { code: 'EEXIST' });
      files.set(final, files.get(pending));
      files.delete(pending);
      events.push(`promote:${final}`);
    }
  };
  const writer = writerTransport.createLocalWriterTransportPrimitives({
    storage, ownedWriterSyncPeerId: REMOTE, cryptoImplementation: webcrypto
  });
  /* The complete advertisement of the Chrome writer: (domain, id) -> tips. */
  const heads = new Map();
  const produced = new Map();
  async function produce({ objectDomain, objectId, payload, parent = null, mint }) {
    const revisionId = `p02-${mint.padStart(32, '0').slice(-32)}`;
    const record = objectDomain === CHAT_DOMAIN
      ? await chatAdapter.produceChatRevisionV2({
        canonicalObject: { objectId, revisionId, payload },
        writerSyncPeerId: REMOTE,
        p02Parent: parent === null ? null : {
          previousRevisionId: parent.revisionId, previousRevisionBlobSha256: parent.revisionBlobSha256,
          provenP02Parent: true
        },
        cryptoImplementation: webcrypto
      })
      : await production.produceRevisionV2({
        objectDomain, objectId, revisionId, writerSyncPeerId: REMOTE, payload,
        parent: parent === null ? production.rootParent() : production.descendantParent({
          previousRevisionId: parent.revisionId, previousRevisionBlobSha256: parent.revisionBlobSha256,
          provenP02Parent: true
        }),
        cryptoImplementation: webcrypto
      });
    produced.set(revisionId, record);
    return record;
  }
  function headOf(record) {
    return {
      schema: 'h2o.studio.syncHead.v2',
      objectDomain: record.objectDomain, objectId: record.objectId, objectKey: record.objectKey,
      revisionId: record.revisionId, payloadSha256: record.payloadSha256,
      revisionBlobSha256: record.revisionBlobSha256, writerSyncPeerId: REMOTE,
      previousRevisionId: record.revision.previousRevisionId,
      previousRevisionBlobSha256: record.revision.previousRevisionBlobSha256,
      sourceUpdatedAtIso: SOURCE_AT
    };
  }
  /* Publish a set of records: each replaces its object's tips unless
   * `keepSiblings` asks for a fork (two live tips for one object). */
  async function publish(records, { keepSiblings = false } = {}) {
    for (const record of records) {
      const key = `${record.objectDomain}${NUL}${record.objectId}`;
      const tips = keepSiblings ? (heads.get(key) || []) : [];
      heads.set(key, [...tips.filter((t) => t.revisionId !== record.revisionId), headOf(record)]);
    }
    const allHeads = [...heads.values()].flat();
    return writer.publishBatch({
      revisions: records.map((record) => ({
        objectDomain: record.objectDomain, objectId: record.objectId, objectKey: record.objectKey,
        revisionBlobSha256: record.revisionBlobSha256, bytes: record.canonicalBytes
      })),
      heads: allHeads
    });
  }
  return { files, events, writer, heads, produced, produce, publish };
}

function chatPayload(objectId, snapshotId, text) {
  return {
    schema: chatAdapter.P02_CHAT_DOMAIN_V2.PAYLOAD_SCHEMA,
    chatArchive: {
      chats: [{
        chatId: objectId, title: 'T03 fixture',
        chatIndex: { title: 'T03 fixture', lastSnapshotId: snapshotId, snapshotCount: 1, messageCount: 1,
          state: { isSaved: true, isLinked: true }, organization: {} },
        snapshots: [{ snapshotId, chatId: objectId, createdAt: SOURCE_AT, messageCount: 1,
          messages: [{ order: 0, role: 'user', text }],
          meta: { title: 'T03 fixture', richTurns: [{ turnIdx: 0, role: 'user', outerHTML: `<p>${text}</p>`, meta: {} }] } }]
      }],
      catalogs: { categories: [], labels: [], tags: [] }
    },
    chromeStorageLocal: {}, libraryKv: []
  };
}
const folderPayload = (folderId, name) => ({ schema: 'h2o.studio.folderCatalogState.v1', folderId, name, createdAt: SOURCE_AT });
const bindingPayload = (chatId, folderId) => ({ schema: 'h2o.studio.chatFolderBinding.v1', chatId, folderId });

/* ---------------------------------------------------------------------- */
/* JS double of the ratified fixed-statement Tauri command                 */
/* ---------------------------------------------------------------------- */
function makeCommandDouble(fixture, log) {
  const { db, setIdentity } = fixture;
  const REQUEST_SCHEMA = 'h2o.studio.p02RelationshipApplyRequest.v1';
  const RESULT_SCHEMA = 'h2o.studio.p02RelationshipApplyResult.v1';
  const FOLDER_ID_RE = /^[A-Za-z0-9_.:-]{1,160}$/;
  const refused = (kind, code) => ({ schema: RESULT_SCHEMA, ok: false, applied: false, kind, outcome: 'refused',
    writerIdentity: IDENTITY, rowsAffected: 0, errorCode: code });
  const applied = (kind, outcome, rowsAffected) => ({ schema: RESULT_SCHEMA, ok: true, applied: true, kind, outcome,
    writerIdentity: IDENTITY, rowsAffected, errorCode: null });
  return async (request) => {
    log.push({ request: JSON.parse(JSON.stringify(request)) });
    /* serde deny_unknown_fields: an unknown field is a deserialization failure. */
    for (const key of Object.keys(request || {})) {
      if (!['schema', 'kind', 'folderId', 'name', 'chatId'].includes(key)) throw new Error(`invoke-deserialize:${key}`);
    }
    const kind = String(request?.kind ?? '');
    if (request?.schema !== REQUEST_SCHEMA) return refused(kind, 'p02-relationship-apply-request-schema-invalid');
    const folderId = () => {
      if (request.folderId == null) throw 'p02-relationship-apply-request-shape-invalid';
      if (!FOLDER_ID_RE.test(request.folderId)) throw 'p02-relationship-apply-folder-id-invalid';
      return request.folderId;
    };
    const name = () => {
      if (request.name == null) throw 'p02-relationship-apply-request-shape-invalid';
      const v = request.name;
      if (typeof v !== 'string' || !v.length || v.trim() !== v || [...v].length > 200 || /\p{Cc}/u.test(v)) throw 'p02-relationship-apply-folder-name-invalid';
      return v;
    };
    const chatId = () => {
      if (request.chatId == null) throw 'p02-relationship-apply-request-shape-invalid';
      const v = request.chatId;
      if (typeof v !== 'string' || !v.length || v.length > 512 || v.trim() !== v || /\p{Cc}/u.test(v)) throw 'p02-relationship-apply-chat-id-invalid';
      return v;
    };
    const absent = (value) => { if (value != null) throw 'p02-relationship-apply-request-shape-invalid'; };
    let operation;
    try {
      switch (kind) {
        case 'create-folder': absent(request.chatId); operation = { folderId: folderId(), name: name() }; break;
        case 'rename-folder': absent(request.chatId); operation = { folderId: folderId(), name: name() }; break;
        case 'bind-chat': absent(request.name); operation = { chatId: chatId(), folderId: folderId() }; break;
        case 'unbind-chat': absent(request.name); absent(request.folderId); operation = { chatId: chatId() }; break;
        default: throw 'p02-relationship-apply-kind-invalid';
      }
    } catch (code) { return refused(kind, String(code)); }

    const requireUserFolder = (id) => {
      const row = db.prepare('SELECT source FROM folders WHERE id = ? LIMIT 1').get(id);
      if (!row) throw 'p02-relationship-apply-folder-missing';
      if (row.source !== 'user') throw 'p02-relationship-apply-folder-not-eligible';
    };
    const requireLiveChat = (id) => {
      const row = db.prepare('SELECT is_deleted FROM chats WHERE id = ? LIMIT 1').get(id);
      if (!row || Number(row.is_deleted) !== 0) throw 'p02-relationship-apply-chat-missing';
    };
    setIdentity(IDENTITY);
    db.exec('BEGIN IMMEDIATE');
    try {
      let outcome; let rows;
      switch (kind) {
        case 'create-folder': {
          if (db.prepare('SELECT 1 FROM folders WHERE id = ? LIMIT 1').get(operation.folderId)) throw 'p02-relationship-apply-folder-exists';
          rows = db.prepare('INSERT INTO folders (id, name, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
            .run(operation.folderId, operation.name, 'user', NOW_MS, NOW_MS).changes;
          if (rows !== 1) throw 'p02-relationship-apply-affected-rows-mismatch';
          outcome = 'created'; break;
        }
        case 'rename-folder': {
          requireUserFolder(operation.folderId);
          rows = db.prepare('UPDATE folders SET name = ?, updated_at = ? WHERE id = ?').run(operation.name, NOW_MS, operation.folderId).changes;
          if (rows !== 1) throw 'p02-relationship-apply-affected-rows-mismatch';
          outcome = 'renamed'; break;
        }
        case 'bind-chat': {
          requireLiveChat(operation.chatId);
          requireUserFolder(operation.folderId);
          rows = db.prepare('INSERT OR REPLACE INTO folder_bindings (chat_id, folder_id, assigned_at) VALUES (?, ?, ?)')
            .run(operation.chatId, operation.folderId, NOW_MS).changes;
          if (rows !== 1) throw 'p02-relationship-apply-affected-rows-mismatch';
          outcome = 'bound'; break;
        }
        case 'unbind-chat': {
          requireLiveChat(operation.chatId);
          rows = db.prepare('DELETE FROM folder_bindings WHERE chat_id = ?').run(operation.chatId).changes;
          if (rows > 1) throw 'p02-relationship-apply-affected-rows-mismatch';
          outcome = rows === 1 ? 'unfiled' : 'already-unfiled'; break;
        }
        default: throw 'p02-relationship-apply-kind-invalid';
      }
      setIdentity('');
      db.exec('COMMIT');
      const result = applied(kind, outcome, Number(rows));
      log[log.length - 1].result = result;
      return result;
    } catch (code) {
      setIdentity('');
      db.exec('ROLLBACK');
      const result = refused(kind, typeof code === 'string' ? code : 'p02-relationship-apply-statement-failed');
      log[log.length - 1].result = result;
      return result;
    }
  };
}

/* ---------------------------------------------------------------------- */
/* Synthetic Desktop: fixture DB + repository + fake invoke + chat double  */
/* ---------------------------------------------------------------------- */
async function makeDesktop({ libraryRefresh = 'record', dependencyReader = null } = {}) {
  const fixture = openFixtureDb(`fixture-${crypto.randomUUID()}`);
  const { db } = fixture;
  const repository = makeRepository();
  const writerKey = await writerKeyHex(REMOTE, webcrypto);
  const commandLog = [];
  const command = makeCommandDouble(fixture, commandLog);
  const sqlExecutes = [];
  const sqlSelects = [];
  const commands = [];
  const refreshCalls = [];
  const libraryInfo = { schema: 'h2o.studio.syncLibraryInfo.p02.v1', formatVersion: 2,
    minimumCompatibleProtocolVersion: 2, layoutEpoch: 1 };

  const invoke = async (name, args = {}) => {
    commands.push(name);
    switch (name) {
      case 'plugin:sql|select': {
        sqlSelects.push(args.query);
        return db.prepare(args.query).all(...(args.values || []));
      }
      case 'plugin:sql|execute': {
        sqlExecutes.push(args.query);
        const result = db.prepare(args.query).run(...(args.values || []));
        return [Number(result.changes), Number(result.lastInsertRowid)];
      }
      case 'h2o_p02_storage_read': {
        const bytes = repository.files.get(args.relativePath) || null;
        return bytes === null
          ? { schema: STORAGE_SCHEMA, present: false }
          : { schema: STORAGE_SCHEMA, present: true, base64: Buffer.from(bytes).toString('base64'), byteLength: bytes.byteLength };
      }
      case 'h2o_p02_read_library_authority':
        return { present: true, readable: true, canonicalBytes: JSON.stringify(libraryInfo) };
      case 'h2o_p02_read_writer_generation_authority':
        return { schema: 'h2o.studio.syncWriterGenerationAuthority.p02.v1', state: 'p02',
          documentWriterKey: args.writerKey, writerKey: args.writerKey };
      case COMMAND:
        return command(args.request);
      default:
        throw Object.assign(new Error(`unexpected-command:${name}`), { code: `unexpected-command:${name}` });
    }
  };

  /* The accepted canonical chat runtime, as a recording double: it anchors
   * the chat's domain-qualified protocol row exactly like commitApplied and
   * exposes a v1-style projection anchor, so the chat classifies through the
   * same post-apply bridge production uses. It never sees relationship data. */
  const chatCalls = [];
  const chatAnchors = new Map();
  const canonicalApply = {
    resolveCanonicalAnchor: async (objectId) => chatAnchors.get(objectId) || null,
    applyNextAdmittedP02Revision: async (objectId) => {
      chatCalls.push(objectId);
      const tips = repository.heads.get(`${CHAT_DOMAIN}${NUL}${objectId}`) || [];
      if (tips.length !== 1) return { ok: false, verdict: 'blocked', errorCode: 'p02-desktop-no-admitted-chrome-leaf' };
      const tip = tips[0];
      const row = db.prepare('SELECT last_applied_revision_id, last_applied_revision_blob_sha256, last_applied_payload_sha256 FROM sync_object_state WHERE sync_peer_id = ? AND object_domain = ? AND object_id = ?').get(LOCAL, CHAT_DOMAIN, objectId);
      if (row && row.last_applied_revision_id === tip.revisionId && row.last_applied_revision_blob_sha256 === tip.revisionBlobSha256 &&
          row.last_applied_payload_sha256 === tip.payloadSha256) {
        return { ok: true, convergenceVerified: true, unchangedNoOp: true, importerInvoked: false,
          metadataReconciled: true, metadataReconciliation: { reconciled: true, chats: [{ chatId: objectId, fields: ['lastMessageAt'] }] } };
      }
      db.prepare('INSERT INTO sync_object_state (sync_peer_id, object_domain, object_id, last_applied_revision_id, last_applied_revision_blob_sha256, last_applied_payload_sha256, last_converged_direction, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(sync_peer_id, object_domain, object_id) DO UPDATE SET last_applied_revision_id = excluded.last_applied_revision_id, last_applied_revision_blob_sha256 = excluded.last_applied_revision_blob_sha256, last_applied_payload_sha256 = excluded.last_applied_payload_sha256, last_converged_direction = excluded.last_converged_direction, updated_at = excluded.updated_at')
        .run(LOCAL, CHAT_DOMAIN, objectId, tip.revisionId, tip.revisionBlobSha256, tip.payloadSha256, 'applied', SOURCE_AT, SOURCE_AT);
      chatAnchors.set(objectId, { revisionId: `snap-${objectId}`, revisionBlobSha256Hex: sha256(`v1:${tip.payloadSha256}`), payloadSha256Hex: tip.payloadSha256 });
      return { ok: true, convergenceVerified: true, applied: true, importerInvoked: true };
    }
  };

  const refreshPort = libraryRefresh === 'record'
    ? async (input) => { refreshCalls.push(input); return { requested: true }; }
    : libraryRefresh;
  const runtime = facade.createDesktopP02ReverseRuntime({
    invoke,
    configOwner: {
      getConfig: async () => ({ schemaVersion: 1, mode: 'manual', configuredPeers: [{ syncPeerId: REMOTE, writerKey }] }),
      setConfig: async () => {},
      mutateCanonicalConfig: async () => ({ write: false, outcome: 'no-effect' })
    },
    localIdentity: async () => ({ syncPeerId: LOCAL }),
    canonicalApply,
    cryptoImplementation: webcrypto,
    clock: () => SOURCE_AT,
    libraryRefresh: refreshPort,
    dependencyReader
  });

  const q = {
    folder: (id) => db.prepare('SELECT id, name, source, color FROM folders WHERE id = ?').get(id) || null,
    folders: () => db.prepare('SELECT id, name, source FROM folders ORDER BY id').all(),
    binding: (chatId) => db.prepare('SELECT chat_id, folder_id FROM folder_bindings WHERE chat_id = ?').get(chatId) || null,
    bindings: () => db.prepare('SELECT chat_id, folder_id FROM folder_bindings ORDER BY chat_id').all(),
    state: (domain, id) => db.prepare('SELECT * FROM sync_object_state WHERE sync_peer_id = ? AND object_domain = ? AND object_id = ?').get(LOCAL, domain, id) || null,
    states: () => db.prepare('SELECT object_domain, object_id, last_applied_revision_id FROM sync_object_state ORDER BY object_domain, object_id').all(),
    evidence: () => db.prepare('SELECT peer_object_key, object_id, revision_id, branch_disposition, proven FROM sync_branch_evidence_state ORDER BY peer_object_key, revision_id').all(),
    tombstones: () => db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'sync_tombstone%'").all()
      .flatMap((table) => db.prepare(`SELECT COUNT(*) AS n FROM ${table.name}`).all().map((r) => Number(r.n))),
    insertChat: (id) => db.prepare('INSERT INTO chats (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)').run(id, `chat ${id}`, NOW_MS, NOW_MS)
  };
  const counters = () => ({ executes: sqlExecutes.length, commands: commandLog.length, chat: chatCalls.length,
    refresh: refreshCalls.length, repositoryWrites: repository.events.filter((e) => e.startsWith('write:') || e.startsWith('promote:')).length,
    storageWrites: commands.filter((c) => c.startsWith('h2o_p02_storage_write') || c.startsWith('h2o_p02_storage_promote')).length });
  return { fixture, db, repository, invoke, runtime, commandLog, sqlExecutes, sqlSelects, commands, refreshCalls, chatCalls, chatAnchors, q, counters, writerKey };
}

/* Relationship writes executed by anything OTHER than the command double. */
const RELATIONSHIP_WRITE_RE = /\b(INSERT\s+(OR\s+REPLACE\s+)?INTO|UPDATE|DELETE\s+FROM)\s+(folders|folder_bindings)\b/i;
const relationshipWritesFromSyncJs = (world) => world.sqlExecutes.filter((sql) => RELATIONSHIP_WRITE_RE.test(sql));

/* ====================================================================== */
/* The world: chat-a live locally; Chrome publishes folder, chat, binding  */
/* ====================================================================== */
const world = await makeDesktop();
world.q.insertChat('chat-a');
world.q.insertChat('chat-b');
const R = world.repository;
const studyRoot = await R.produce({ objectDomain: FOLDER_DOMAIN, objectId: 'f_study', payload: folderPayload('f_study', 'Study'), mint: 'a1' });
const chatRoot = await R.produce({ objectDomain: CHAT_DOMAIN, objectId: 'chat-a', payload: chatPayload('chat-a', 'snap-a-1', 'hello'), mint: 'b1' });
const bindingRoot = await R.produce({ objectDomain: BINDING_DOMAIN, objectId: 'chat-a', payload: bindingPayload('chat-a', 'f_study'), mint: 'c1' });
await R.publish([studyRoot, chatRoot, bindingRoot]);

const receive = () => world.runtime.receiveFromChrome();
const apply = () => world.runtime.applyAdmittedFromChrome();
const applied = [];

/* ---------------------------------------------------------------------- */
await section('B multi-object Receive: chat + folder + binding coexist', async () => {
  const before = world.counters();
  const result = await receive();
  check(result.ok === true && result.outcome === 'completed', `Receive completes over three families (${result.outcome}/${result.detail})`);
  check(result.admittedCount === 3, `three objects admitted (${result.admittedCount})`);
  check(JSON.stringify(result.receivedObjectDomains) === JSON.stringify([BINDING_DOMAIN, CHAT_DOMAIN, FOLDER_DOMAIN]),
    'every received object keeps its own objectDomain');
  const objects = result.report.objects;
  const byDomain = Object.fromEntries(objects.map((o) => [o.objectDomain, o]));
  check(byDomain[FOLDER_DOMAIN]?.classification === 'remote-ahead' && byDomain[FOLDER_DOMAIN].applyEligible === true,
    'folder root classifies remote-ahead and is apply-eligible');
  check(byDomain[CHAT_DOMAIN]?.classification === 'remote-ahead' && byDomain[CHAT_DOMAIN].applyEligible === true,
    'chat root classifies remote-ahead and is apply-eligible (receive apply authority)');
  check(byDomain[BINDING_DOMAIN]?.classification === 'blocked(dependency)' && byDomain[BINDING_DOMAIN].applyEligible === false,
    `binding root is blocked(dependency) while its folder is not materialized (${byDomain[BINDING_DOMAIN]?.classification})`);
  check(result.report.applyCandidates.length === 3 && result.report.applyCandidates.every((c) => c.proven && c.leafCount === 1),
    `three proven candidates reported, one leaf each, no ambiguous-leaf failure (${result.report.applyCandidates.length})`);
  check(result.applyExecuted === false && world.counters().commands === before.commands && world.counters().chat === before.chat,
    'Receive applied nothing: no command, no chat import');
  const evidence = world.q.evidence();
  check(evidence.length === 3 && new Set(evidence.map((r) => r.peer_object_key)).size === 3 &&
    evidence.every((r) => r.branch_disposition === 'accepted-linear' && r.proven === 1),
    'three admitted leaves under three distinct peer-object keys');
  const chatKey = await objectKeyHex(CHAT_DOMAIN, 'chat-a', webcrypto);
  const bindingKey = await objectKeyHex(BINDING_DOMAIN, 'chat-a', webcrypto);
  check(chatKey !== bindingKey && evidence.filter((r) => r.object_id === 'chat-a').length === 2,
    'chat and binding share the objectId string but never the object key');
  check(relationshipWritesFromSyncJs(world).length === 0, 'no folders/folder_bindings SQL was sent by Sync JS during Receive');
});

/* ---------------------------------------------------------------------- */
await section('A+C+D+F+I+K domain dispatch, deterministic sequencing, folder root, binding root', async () => {
  const before = world.counters();
  const first = await apply();
  applied.push(first);
  check(first.ok === true && first.outcome === 'applied' && first.objectDomain === CHAT_DOMAIN && first.objectId === 'chat-a',
    `attempt 1 applies exactly the first runnable object in deterministic order: the chat (${first.objectDomain}/${first.outcome})`);
  check(first.canonicalImportAttempts === 1 && first.importerInvoked === true && first.convergedDirection === 'applied' && first.revisionId === chatRoot.revisionId,
    'chat result shape is the accepted one (import attempts, importer flag, direction, revision)');
  check(world.counters().chat === before.chat + 1 && world.counters().commands === before.commands,
    'the chat went to the chat runtime and never to the relationship command');
  const seq = first.applySequencing;
  check(seq?.sequencing === 'deterministic-one-object-per-attempt' && seq.sequencer === 'p02-object-scheduler' && seq.candidateCount === 3 && seq.runnableCount === 2 && seq.blockedCount === 1,
    `sequencing summary: 3 candidates, 2 runnable, 1 blocked (${JSON.stringify(seq && { c: seq.candidateCount, r: seq.runnableCount, b: seq.blockedCount })})`);
  check(seq.candidates.map((c) => `${c.objectDomain}:${c.classification}`).join('|') ===
    `${BINDING_DOMAIN}:blocked(dependency)|${CHAT_DOMAIN}:remote-ahead|${FOLDER_DOMAIN}:remote-ahead`,
    `candidates are ordered deterministically by domain then id (${seq.candidates.map((c) => `${c.objectDomain}:${c.classification}`).join('|')})`);
  check(seq.candidates[0].blockClass === 'dependency' && seq.candidates[0].dependencyDetail === 'folder-missing',
    'the blocked binding carries the typed detail folder-missing beside the class');

  const second = await apply();
  applied.push(second);
  check(second.ok === true && second.outcome === 'applied' && second.objectDomain === FOLDER_DOMAIN && second.objectId === 'f_study',
    `attempt 2 applies the folder root (${second.objectDomain}/${second.outcome}/${second.detail})`);
  check(second.kind === 'create-folder' && second.materialization === 'created' && second.commandInvoked === true && second.relationshipCommand === COMMAND,
    'folder root materializes through create-folder on the ratified command');
  const folder = world.q.folder('f_study');
  check(folder?.id === 'f_study' && folder.name === 'Study' && folder.source === 'user' && folder.color === null,
    'the folder row adopts the verbatim id, the canonical name, source user and no colour');
  check(second.canonicalImportAttempts === 0 && second.importerInvoked === false && world.counters().chat === before.chat + 1,
    'the folder never reached the chat importer');
  check(world.commandLog.length === before.commands + 1 && world.commandLog.at(-1).request.kind === 'create-folder' &&
    world.commandLog.at(-1).request.schema === 'h2o.studio.p02RelationshipApplyRequest.v1' &&
    Object.keys(world.commandLog.at(-1).request).sort().join(',') === 'folderId,kind,name,schema',
    'exactly one bounded command request was sent for the folder');
  const folderState = world.q.state(FOLDER_DOMAIN, 'f_study');
  check(folderState?.last_applied_revision_id === studyRoot.revisionId && folderState.last_applied_revision_blob_sha256 === studyRoot.revisionBlobSha256 &&
    folderState.last_applied_payload_sha256 === studyRoot.payloadSha256 && folderState.last_converged_direction === 'applied',
    'the folder anchor is recorded in its own domain-qualified sync_object_state row');
  check(world.q.state(CHAT_DOMAIN, 'f_study') === null && world.q.state(BINDING_DOMAIN, 'f_study') === null,
    'no other domain row was touched for the folder id');
  check(second.libraryRefresh?.requested === true && second.libraryRefresh.port === LIBRARY_REFRESH_EVENT,
    'a Library refresh was requested through the owner port after the folder materialized');

  /* K: the binding was blocked(dependency); its folder now exists. Same runtime instance, next pass. */
  const third = await apply();
  applied.push(third);
  check(third.ok === true && third.outcome === 'applied' && third.objectDomain === BINDING_DOMAIN && third.objectId === 'chat-a',
    `attempt 3: the binding became runnable without a runtime restart once its folder appeared (${third.objectDomain}/${third.outcome}/${third.detail})`);
  check(third.kind === 'bind-chat' && third.materialization === 'bound' && third.commandInvoked === true,
    'binding root materializes through bind-chat');
  check(world.q.binding('chat-a')?.folder_id === 'f_study', 'chat-a is bound to f_study');
  const bindingState = world.q.state(BINDING_DOMAIN, 'chat-a');
  check(bindingState?.last_applied_revision_id === bindingRoot.revisionId && bindingState.last_converged_direction === 'applied',
    'the binding anchor is recorded in the binding-domain row');
  check(world.q.state(CHAT_DOMAIN, 'chat-a')?.last_applied_revision_id === chatRoot.revisionId,
    'the chat-domain row for the same objectId keeps the chat anchor');
  check(third.applySequencing.candidateCount === 3 && third.applySequencing.runnableCount === 1 && third.applySequencing.blockedCount === 0,
    'by attempt 3 only the binding was runnable; chat and folder had converged');
  check(applied.map((a) => `${a.objectDomain}:${a.objectId}`).join('|') === `${CHAT_DOMAIN}:chat-a|${FOLDER_DOMAIN}:f_study|${BINDING_DOMAIN}:chat-a`,
    'one object per attempt, three attempts, deterministic order');
  check(relationshipWritesFromSyncJs(world).length === 0, 'Sync JS sent no folders/folder_bindings SQL; every relationship write came from the command');
  check(world.commandLog.every((entry) => entry.result?.ok === true), 'every command invocation so far was admitted by the fixed command under the F16 guard');
});

/* ---------------------------------------------------------------------- */
await section('N+O already-applied replay: zero relationship writes, zero repository writes, no command', async () => {
  const beforeReceive = world.counters();
  const again = await receive();
  check(again.ok === true && again.admittedCount === 0 && again.report.objects.every((o) => o.classification === 'converged'),
    `a replayed advertisement admits nothing and classifies every object converged (${again.report.objects.map((o) => o.classification).join(',')})`);
  check(world.q.evidence().length === 3, 'duplicate advertisement retains no duplicate evidence');
  check(world.sqlExecutes.slice(beforeReceive.executes).every((sql) => /kv_store/.test(sql)) && world.counters().commands === beforeReceive.commands,
    'a replayed Receive writes only its verified-tip memo (kv_store), never evidence, anchors or relationship rows');
  const before = world.counters();
  const replay = await apply();
  check(replay.ok === true && replay.outcome === 'already-applied',
    `Apply on a converged repository reports already-applied (${replay.outcome}/${replay.detail})`);
  check(replay.objectDomain === BINDING_DOMAIN && replay.commandInvoked === false && replay.relationshipSqliteWrites === 0 && replay.bookkeepingWrites === 0,
    'the deterministic first object (binding) replays with no command, no relationship write, no bookkeeping write');
  const after = world.counters();
  check(after.executes === before.executes && after.commands === before.commands && after.chat === before.chat,
    `replay issued zero SQL executes, zero command invocations and zero chat imports (${after.executes - before.executes}/${after.commands - before.commands}/${after.chat - before.chat})`);
  check(after.repositoryWrites === before.repositoryWrites && after.storageWrites === 0 && replay.repositoryWrites === 0,
    'replay wrote nothing to the repository');
  check(after.refresh === before.refresh, 'replay requested no Library refresh');
  check(JSON.stringify(world.q.states()) === JSON.stringify([
    { object_domain: BINDING_DOMAIN, object_id: 'chat-a', last_applied_revision_id: bindingRoot.revisionId },
    { object_domain: CHAT_DOMAIN, object_id: 'chat-a', last_applied_revision_id: chatRoot.revisionId },
    { object_domain: FOLDER_DOMAIN, object_id: 'f_study', last_applied_revision_id: studyRoot.revisionId }
  ]), 'sync anchors are stable across the replay');
});

/* ---------------------------------------------------------------------- */
await section('E folder descendant: rename only', async () => {
  const before = world.counters();
  const rename = await R.produce({ objectDomain: FOLDER_DOMAIN, objectId: 'f_study', payload: folderPayload('f_study', 'Study Notes'), parent: studyRoot, mint: 'a2' });
  await R.publish([rename]);
  const rx = await receive();
  check(rx.ok === true && rx.admittedCount === 1, 'the folder descendant is admitted');
  const result = await apply();
  check(result.ok === true && result.outcome === 'applied' && result.objectDomain === FOLDER_DOMAIN && result.kind === 'rename-folder' && result.materialization === 'renamed',
    `folder descendant renames only (${result.outcome}/${result.kind}/${result.detail})`);
  const folder = world.q.folder('f_study');
  check(folder?.name === 'Study Notes' && folder.source === 'user' && world.q.folders().length === 1,
    'same id, new name, no second folder, no delete');
  check(world.commandLog.at(-1).request.kind === 'rename-folder' && world.counters().commands === before.commands + 1,
    'exactly one rename-folder command');
  check(world.q.state(FOLDER_DOMAIN, 'f_study')?.last_applied_revision_id === rename.revisionId, 'the folder anchor advanced to the descendant');
  check(world.q.binding('chat-a')?.folder_id === 'f_study', 'the existing binding is untouched by a folder rename');
});

/* ---------------------------------------------------------------------- */
await section('G binding move: atomic target replacement', async () => {
  const codeRoot = await R.produce({ objectDomain: FOLDER_DOMAIN, objectId: 'f_code', payload: folderPayload('f_code', 'Code'), mint: 'a3' });
  const move = await R.produce({ objectDomain: BINDING_DOMAIN, objectId: 'chat-a', payload: bindingPayload('chat-a', 'f_code'), parent: bindingRoot, mint: 'c2' });
  await R.publish([codeRoot, move]);
  const rx = await receive();
  check(rx.ok === true && rx.admittedCount === 2, 'the new folder and the binding move are admitted');
  const one = await apply();
  check(one.ok === true && one.outcome === 'applied' && one.objectDomain === FOLDER_DOMAIN && one.objectId === 'f_code' && one.kind === 'create-folder',
    `the missing target folder is created first; the move was blocked(dependency) until then (${one.objectDomain}/${one.objectId}/${one.outcome})`);
  check(one.applySequencing.candidates.find((c) => c.objectDomain === BINDING_DOMAIN)?.classification === 'blocked(dependency)' &&
    one.applySequencing.candidates.find((c) => c.objectDomain === BINDING_DOMAIN)?.dependencyDetail === 'folder-missing',
    'the move classified blocked(dependency)/folder-missing while f_code did not exist');
  const bindingsBefore = world.q.bindings();
  const two = await apply();
  check(two.ok === true && two.outcome === 'applied' && two.objectDomain === BINDING_DOMAIN && two.kind === 'bind-chat' && two.materialization === 'bound',
    `the move materializes through bind-chat (${two.outcome}/${two.kind})`);
  check(world.q.binding('chat-a')?.folder_id === 'f_code' && world.q.bindings().length === 1 && bindingsBefore.length === 1,
    'the chat\'s single binding row was replaced atomically (one row before, one row after, new target)');
  check(world.commandLog.at(-1).request.kind === 'bind-chat' && world.commandLog.at(-1).request.folderId === 'f_code' && world.commandLog.at(-1).result.outcome === 'bound',
    'one INSERT OR REPLACE bind-chat command, no unbind step');
  check(world.commandLog.every((e) => e.request.kind !== 'unbind-chat'), 'no unbind was ever issued for a move');
  check(world.q.state(BINDING_DOMAIN, 'chat-a')?.last_applied_revision_id === move.revisionId, 'the binding anchor advanced to the move');
  world.movedBinding = move;
  world.codeRoot = codeRoot;
});

/* ---------------------------------------------------------------------- */
await section('H Unfile: null folderId -> unbind-chat', async () => {
  const unfile = await R.produce({ objectDomain: BINDING_DOMAIN, objectId: 'chat-a', payload: bindingPayload('chat-a', null), parent: world.movedBinding, mint: 'c3' });
  await R.publish([unfile]);
  const rx = await receive();
  check(rx.ok === true && rx.admittedCount === 1, 'the unfile descendant is admitted');
  check(rx.report.objects.find((o) => o.objectDomain === BINDING_DOMAIN)?.classification === 'remote-ahead',
    'an unfile has no folder dependency and classifies remote-ahead');
  const result = await apply();
  check(result.ok === true && result.outcome === 'applied' && result.kind === 'unbind-chat' && result.materialization === 'unfiled',
    `unfile materializes through unbind-chat (${result.outcome}/${result.kind}/${result.materialization})`);
  check(world.q.binding('chat-a') === null && world.q.folders().length === 2,
    'the binding row is gone; both folders remain (no folder delete, no tombstone)');
  check(world.commandLog.at(-1).request.kind === 'unbind-chat' && Object.keys(world.commandLog.at(-1).request).sort().join(',') === 'chatId,kind,schema',
    'the unbind request carries only chatId');
  check(world.q.tombstones().every((n) => n === 0), 'no sync_tombstones row was written');
  world.unfiled = unfile;
});

/* ---------------------------------------------------------------------- */
await section('P concurrent binding moves (Study vs Code): diverged-unresolved, retained, no Apply', async () => {
  const before = world.counters();
  const toStudy = await R.produce({ objectDomain: BINDING_DOMAIN, objectId: 'chat-a', payload: bindingPayload('chat-a', 'f_study'), parent: world.unfiled, mint: 'c4' });
  const toCode = await R.produce({ objectDomain: BINDING_DOMAIN, objectId: 'chat-a', payload: bindingPayload('chat-a', 'f_code'), parent: world.unfiled, mint: 'c5' });
  await R.publish([toStudy, toCode], { keepSiblings: true });
  const rx = await receive();
  const object = rx.report.objects.find((o) => o.objectDomain === BINDING_DOMAIN);
  check(object?.classification === 'diverged-unresolved' && object.applyEligible === false,
    `two live leaves classify diverged-unresolved (${object?.classification}/${object?.applyRefusedBecause})`);
  const rows = world.q.evidence().filter((r) => [toStudy.revisionId, toCode.revisionId].includes(r.revision_id));
  check(rows.length === 2 && rows.some((r) => r.branch_disposition === 'accepted-linear') && rows.some((r) => r.branch_disposition === 'retained-divergent'),
    `both leaves are retained as evidence (${rows.map((r) => r.branch_disposition).join(',')})`);
  const result = await apply();
  check(result.ok === false && result.outcome === 'diverged-unresolved' && result.objectDomain === BINDING_DOMAIN,
    `Apply refuses the diverged binding (${result.outcome})`);
  check(world.counters().commands === before.commands && world.q.binding('chat-a') === null && relationshipWritesFromSyncJs(world).length === 0,
    'no materialization: no command, no binding write, no LWW, no timestamp winner');
  check(world.q.state(BINDING_DOMAIN, 'chat-a')?.last_applied_revision_id === world.unfiled.revisionId,
    'the binding anchor stays at the last applied revision (unfile)');
  check(world.counters().refresh === before.refresh, 'no Library refresh on a refused Apply');
  check(result.applySequencing.indeterminateCount === 1 && result.applySequencing.runnableCount === 0,
    'the sequencing summary reports the indeterminate object and nothing runnable');
});

/* ====================================================================== */
/* A fresh world for the dependency, recheck, missing-chat and delete cases */
/* ====================================================================== */
const w2 = await makeDesktop();
w2.q.insertChat('chat-a');
const R2 = w2.repository;

await section('I+M missing folder: blocked(dependency)/folder-missing, no write, no silent Unfile', async () => {
  /* Local state: chat-a already bound to a locally created folder. */
  w2.fixture.setIdentity('f16.folder-legacy-fallback');
  w2.db.prepare('INSERT INTO folders (id, name, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run('f_local', 'Local', 'user', NOW_MS, NOW_MS);
  w2.db.prepare('INSERT INTO folder_bindings (chat_id, folder_id, assigned_at) VALUES (?, ?, ?)').run('chat-a', 'f_local', NOW_MS);
  w2.fixture.setIdentity('');
  const toMissing = await R2.produce({ objectDomain: BINDING_DOMAIN, objectId: 'chat-a', payload: bindingPayload('chat-a', 'f_missing'), mint: 'd1' });
  await R2.publish([toMissing]);
  const rx = await w2.runtime.receiveFromChrome();
  const object = rx.report.objects[0];
  check(object?.classification === 'blocked(dependency)' && object.applyEligible === false && object.applyRefusedBecause === 'blocked(dependency)',
    `missing folder: blocked(dependency) at classification, so the receive handoff is refused before any authority (${object?.classification}/${object?.applyRefusedBecause})`);
  const before = w2.counters();
  const result = await w2.runtime.applyAdmittedFromChrome();
  check(result.ok === false && result.outcome === 'blocked(dependency)' && result.dependencyDetail === 'folder-missing' && result.blockReason === 'dependency',
    `Apply reports blocked(dependency) with detail folder-missing (${result.outcome}/${result.dependencyDetail})`);
  check(w2.counters().commands === before.commands && w2.counters().executes === before.executes,
    'no materializer call, no bookkeeping write');
  check(w2.q.binding('chat-a')?.folder_id === 'f_local' && w2.q.folders().length === 1,
    'the existing binding is untouched: no placeholder folder, no silent Unfile');
  check(w2.commandLog.every((e) => e.request.kind !== 'unbind-chat'), 'the missing-folder path never issued unbind-chat');
  check(w2.q.state(BINDING_DOMAIN, 'chat-a') === null, 'no anchor was recorded for the blocked binding');
  check(result.applySequencing.candidates[0].classification === 'blocked(dependency)' && scheduler.classificationRunnability('blocked(dependency)') === scheduler.P02_RUNNABILITY.BLOCKED,
    'the scheduler-visible class is exactly blocked(dependency) and is never runnable');
  check(scheduler.blockReasonOf('blocked(dependency)') === 'dependency' && classifier.P02_BLOCK_REASONS.includes('dependency') &&
    !classifier.P02_BLOCK_REASONS.includes('folder-missing') && !classifier.P02_BLOCK_REASONS.includes('chat-missing'),
    'dependency is a block reason; folder-missing and chat-missing are details, never classes');
  w2.toMissing = toMissing;
});

await section('K dependency appears: runnable on the next pass, same runtime', async () => {
  const missingRoot = await R2.produce({ objectDomain: FOLDER_DOMAIN, objectId: 'f_missing', payload: folderPayload('f_missing', 'Missing No More'), mint: 'd2' });
  await R2.publish([missingRoot]);
  await w2.runtime.receiveFromChrome();
  const one = await w2.runtime.applyAdmittedFromChrome();
  check(one.ok === true && one.objectDomain === FOLDER_DOMAIN && one.kind === 'create-folder', `the folder materializes (${one.outcome}/${one.objectDomain})`);
  const two = await w2.runtime.applyAdmittedFromChrome();
  check(two.ok === true && two.objectDomain === BINDING_DOMAIN && two.kind === 'bind-chat' && two.materialization === 'bound',
    `the previously blocked binding is runnable on the next pass without restart (${two.outcome}/${two.kind})`);
  check(w2.q.binding('chat-a')?.folder_id === 'f_missing', 'chat-a moved to the newly materialized folder');
});

await section('J missing chat: blocked(dependency)/chat-missing', async () => {
  const before = w2.counters();
  const ghost = await R2.produce({ objectDomain: BINDING_DOMAIN, objectId: 'chat-ghost', payload: bindingPayload('chat-ghost', 'f_missing'), mint: 'd3' });
  await R2.publish([ghost]);
  const rx = await w2.runtime.receiveFromChrome();
  const object = rx.report.objects.find((o) => o.objectId === 'chat-ghost');
  check(object?.classification === 'blocked(dependency)' && object.applyRefusedBecause === 'blocked(dependency)',
    `a binding for an absent chat is blocked(dependency) (${object?.classification}/${object?.applyRefusedBecause})`);
  const result = await w2.runtime.applyAdmittedFromChrome();
  check(result.ok === false && result.outcome === 'blocked(dependency)' && result.dependencyDetail === 'chat-missing' && result.objectId === 'chat-ghost',
    `Apply reports chat-missing (${result.outcome}/${result.dependencyDetail})`);
  check(w2.counters().commands === before.commands && w2.q.bindings().length === 1, 'no command, no binding row for the absent chat');
  /* A soft-deleted chat is not live either. */
  w2.q.insertChat('chat-ghost');
  w2.db.prepare('UPDATE chats SET is_deleted = 1 WHERE id = ?').run('chat-ghost');
  const deleted = await w2.runtime.applyAdmittedFromChrome();
  check(deleted.ok === false && deleted.dependencyDetail === 'chat-missing', 'a soft-deleted chat still counts as chat-missing');
  w2.db.prepare('UPDATE chats SET is_deleted = 0 WHERE id = ?').run('chat-ghost');
  const live = await w2.runtime.applyAdmittedFromChrome();
  check(live.ok === true && live.objectId === 'chat-ghost' && live.kind === 'bind-chat', 'once the chat is live the binding materializes');
});

await section('Q folder delete boundary: fail closed, no cascade, no tombstone, no Unfile', async () => {
  const before = w2.counters();
  /* The user deletes f_missing locally (hard delete, as the Desktop store does). */
  w2.db.prepare('DELETE FROM folders WHERE id = ?').run('f_missing');
  const bindingsBefore = w2.q.bindings();
  const rename = await R2.produce({ objectDomain: BINDING_DOMAIN, objectId: 'chat-ghost', payload: bindingPayload('chat-ghost', 'f_missing'), parent: R2.produced.get(`p02-${'d3'.padStart(32, '0')}`), mint: 'd4' });
  await R2.publish([rename]);
  await w2.runtime.receiveFromChrome();
  const result = await w2.runtime.applyAdmittedFromChrome();
  check(result.ok === false && result.outcome === 'blocked(dependency)' && result.dependencyDetail === 'folder-missing',
    `a binding to a locally deleted folder is blocked(dependency)/folder-missing (${result.outcome}/${result.dependencyDetail})`);
  check(JSON.stringify(w2.q.bindings()) === JSON.stringify(bindingsBefore), 'no cascade and no automatic Unfile of the orphaned bindings');
  check(w2.q.tombstones().every((n) => n === 0) && w2.counters().commands === before.commands, 'no tombstone, no command');
  check(!Object.values(REL.KIND).some((kind) => /delete|restore|color|sort|parent/i.test(kind)) && Object.values(REL.KIND).length === 4,
    'the materializer knows exactly create-folder, rename-folder, bind-chat, unbind-chat');
  /* The fixed command double refuses anything else, exactly like the Rust adapter. */
  const refused = await w2.invoke(COMMAND, { request: { schema: 'h2o.studio.p02RelationshipApplyRequest.v1', kind: 'delete-folder', folderId: 'f_code' } });
  check(refused.ok === false && refused.errorCode === 'p02-relationship-apply-kind-invalid', 'a delete-folder request is refused by the command');
});

/* ---------------------------------------------------------------------- */
await section('I-bis receive apply authority seam: dependency vanishing between classification and handoff', async () => {
  /* The same reader answers ready for the classification read and blocked for
   * the handoff read, so the receive core's applyAuthority seam is reached. */
  let calls = 0;
  const flipFlop = {
    readDependencyState: async ({ objectDomain, objectId }) => {
      calls += 1;
      return calls % 2 === 1
        ? { schema: REL.DEPENDENCY_SCHEMA, ready: true, blockReason: null, detail: null, objectDomain, objectId }
        : { schema: REL.DEPENDENCY_SCHEMA, ready: false, blockReason: 'dependency', detail: 'folder-missing', objectDomain, objectId };
    },
    readFolder: async () => null,
    readLiveChat: async () => null
  };
  const wf = await makeDesktop({ dependencyReader: flipFlop });
  wf.q.insertChat('chat-a');
  const binding = await wf.repository.produce({ objectDomain: BINDING_DOMAIN, objectId: 'chat-a', payload: bindingPayload('chat-a', 'f_nowhere'), mint: 'g1' });
  await wf.repository.publish([binding]);
  const rx = await wf.runtime.receiveFromChrome();
  const object = rx.report.objects[0];
  check(object?.classification === 'remote-ahead' && object.applyEligible === false && object.applyRefusedBecause === 'dependency-folder-missing',
    `classified remote-ahead, then refused by the receive apply authority with the typed dependency reason (${object?.classification}/${object?.applyRefusedBecause})`);
  check(rx.report.applyCandidates.length === 1 && rx.ok === true, 'the object is admitted and reported as a proven leaf; Receive itself stays non-mutating');
  check(calls === 2, `the dependency reader was consulted at classification and again at handoff (${calls})`);
});

/* ---------------------------------------------------------------------- */
await section('L apply-time dependency recheck', async () => {
  /* A dependency reader whose classification-time answer is ready, and which
   * removes the folder right before the materializer's own recheck. */
  const w3 = await makeDesktop();
  w3.q.insertChat('chat-a');
  const R3 = w3.repository;
  const folderRoot = await R3.produce({ objectDomain: FOLDER_DOMAIN, objectId: 'f_race', payload: folderPayload('f_race', 'Race'), mint: 'e1' });
  const binding = await R3.produce({ objectDomain: BINDING_DOMAIN, objectId: 'chat-a', payload: bindingPayload('chat-a', 'f_race'), mint: 'e2' });
  await R3.publish([folderRoot, binding]);
  await w3.runtime.receiveFromChrome();
  check((await w3.runtime.applyAdmittedFromChrome()).kind === 'create-folder', 'the folder materializes first');
  /* Now race the recheck: the reader is the real one; the fixture deletes
   * the folder between classification and the materializer's recheck by
   * observing the classification-time folder read. */
  let reads = 0;
  const racing = relationship.createDesktopRelationshipDependencyReader({
    sql: {
      select: async (query, values) => {
        if (query === relationship.P02_DESKTOP_RELATIONSHIP_READ_QUERIES.FOLDER) {
          reads += 1;
          /* First read = classification (ready). Delete before the second. */
          if (reads === 2) w3.db.prepare('DELETE FROM folders WHERE id = ?').run(values[0]);
        }
        return w3.db.prepare(query).all(...values);
      }
    }
  });
  const materializer = relationship.createDesktopRelationshipMaterializer({
    invoke: w3.invoke,
    sql: { select: (q, v = []) => w3.invoke('plugin:sql|select', { query: q, values: v }), execute: (q, v = []) => w3.invoke('plugin:sql|execute', { query: q, values: v }) },
    localPeerId: async () => LOCAL,
    dependencyReader: racing,
    libraryRefresh: async (input) => { w3.refreshCalls.push(input); return { requested: true }; },
    clock: () => SOURCE_AT
  });
  const pre = await racing.readDependencyState({ objectDomain: BINDING_DOMAIN, objectId: 'chat-a', canonical: { objectId: 'chat-a', chatId: 'chat-a', folderId: 'f_race', unfiled: false } });
  check(pre.ready === true, 'classification-time dependency: ready');
  const before = w3.counters();
  const result = await materializer.applyRelationshipRevision({
    objectDomain: BINDING_DOMAIN, objectId: 'chat-a', objectKey: binding.objectKey,
    leaf: { revisionId: binding.revisionId, revisionBlobSha256: binding.revisionBlobSha256, payloadSha256: binding.payloadSha256 },
    revision: binding.revision
  });
  check(result.ok === false && result.outcome === 'blocked(dependency)' && result.dependencyDetail === 'folder-missing' && result.commandInvoked === false,
    `the recheck immediately before materialization fails closed (${result.outcome}/${result.dependencyDetail}/invoked=${result.commandInvoked})`);
  check(result.attempt.outcome === 'blocked' && result.attempt.blockReason === 'dependency', 'the scheduler-facing attempt is blocked/dependency');
  check(w3.counters().commands === before.commands && w3.q.binding('chat-a') === null && w3.refreshCalls.length === before.refresh,
    'no command, no binding write, no Library refresh on the recheck failure');
  /* The command double itself also refuses a race that slipped past both reads. */
  w3.db.prepare('INSERT INTO folders (id, name, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run('f_race', 'Race', 'user', NOW_MS, NOW_MS);
  const raceInvoke = async (name, args) => {
    if (name === COMMAND) w3.db.prepare('DELETE FROM folders WHERE id = ?').run('f_race');
    return w3.invoke(name, args);
  };
  const slipped = relationship.createDesktopRelationshipMaterializer({
    invoke: raceInvoke,
    sql: { select: (q, v = []) => w3.invoke('plugin:sql|select', { query: q, values: v }), execute: (q, v = []) => w3.invoke('plugin:sql|execute', { query: q, values: v }) },
    localPeerId: async () => LOCAL, libraryRefresh: async () => ({ requested: true }), clock: () => SOURCE_AT
  });
  const late = await slipped.applyRelationshipRevision({
    objectDomain: BINDING_DOMAIN, objectId: 'chat-a', objectKey: binding.objectKey,
    leaf: { revisionId: binding.revisionId, revisionBlobSha256: binding.revisionBlobSha256, payloadSha256: binding.payloadSha256 },
    revision: binding.revision
  });
  check(late.ok === false && late.outcome === 'blocked(dependency)' && late.dependencyDetail === 'folder-missing' && late.commandInvoked === true && late.commandResult?.errorCode === 'p02-relationship-apply-folder-missing',
    'a race the command itself detects maps to the same canonical dependency block, and nothing was written');
  check(w3.q.binding('chat-a') === null && w3.q.state(BINDING_DOMAIN, 'chat-a') === null, 'no binding row and no anchor after the command-level refusal');
});

/* ---------------------------------------------------------------------- */
await section('R+S negative routing: relationship objects never reach the chat importer; chat never reaches the command', async () => {
  const relationshipAttempts = applied.filter((a) => a.objectDomain !== CHAT_DOMAIN);
  check(relationshipAttempts.length >= 2 && relationshipAttempts.every((a) => a.canonicalImportAttempts === 0 && a.importerInvoked === false),
    'every folder/binding Apply reports zero canonical import attempts');
  check(world.chatCalls.every((id) => id === 'chat-a') && world.chatCalls.length === 1,
    `the chat runtime was called only for the chat object, exactly once (${world.chatCalls.length})`);
  check(world.commandLog.every((e) => ['create-folder', 'rename-folder', 'bind-chat', 'unbind-chat'].includes(e.request.kind)),
    'every command request is one of the four relationship kinds');
  check(world.commandLog.every((e) => !('chatArchive' in e.request) && !('payload' in e.request)), 'no chat content ever entered a command request');
  const direct = relationship.createDesktopRelationshipMaterializer({
    invoke: async () => { throw new Error('must-not-invoke'); },
    sql: { select: async () => [], execute: async () => [0, 0] },
    localPeerId: async () => LOCAL
  });
  check(await codeOf(() => direct.applyRelationshipRevision({
    objectDomain: CHAT_DOMAIN, objectId: 'chat-a', leaf: { revisionId: chatRoot.revisionId, revisionBlobSha256: chatRoot.revisionBlobSha256, payloadSha256: chatRoot.payloadSha256 }, revision: chatRoot.revision
  })) === 'p02-desktop-relationship-domain-unsupported', 'the materializer refuses a chat object before any read or invoke');
  check(await codeOf(() => direct.dependencyReader.readDependencyState({ objectDomain: CHAT_DOMAIN, objectId: 'chat-a', canonical: { objectId: 'chat-a' } })) === 'p02-desktop-relationship-domain-unsupported',
    'the dependency reader refuses a chat object');
  /* An unsupported domain advertised by the peer is refused per object. */
  const wx = await makeDesktop();
  wx.q.insertChat('chat-a');
  const alien = await wx.repository.produce({ objectDomain: 'studio.label.v1', objectId: 'label-1', payload: { schema: 'x', name: 'n' }, mint: 'f1' });
  const chat = await wx.repository.produce({ objectDomain: CHAT_DOMAIN, objectId: 'chat-a', payload: chatPayload('chat-a', 'snap-a-1', 'hi'), mint: 'f2' });
  await wx.repository.publish([alien, chat]);
  const rx = await wx.runtime.receiveFromChrome();
  const alienReport = rx.report.objects.find((o) => o.objectDomain === 'studio.label.v1');
  const chatReport = rx.report.objects.find((o) => o.objectDomain === CHAT_DOMAIN);
  check(alienReport?.result?.outcome === 'blocked' && String(alienReport.result.reason).includes('p02-desktop-object-domain-unsupported'),
    `an unsupported domain is refused as its own typed outcome (${alienReport?.result?.reason})`);
  check(chatReport?.result?.outcome === 'progress' && chatReport.classification === 'remote-ahead', 'the chat beside it is unaffected');
  check(wx.q.evidence().every((r) => r.object_id !== 'label-1'), 'no evidence row was written for the unsupported domain');
  const ax = await wx.runtime.applyAdmittedFromChrome();
  check(ax.ok === true && ax.objectDomain === CHAT_DOMAIN && ax.applySequencing.unsupported.length === 1 && ax.applySequencing.unsupported[0].objectDomain === 'studio.label.v1',
    'Apply sequences the chat and reports the unsupported object without dispatching it');
});

/* ---------------------------------------------------------------------- */
await section('T Library refresh through the owner port only', async () => {
  const calls = world.refreshCalls;
  check(calls.length >= 5 && calls.every((c) => c.port === LIBRARY_REFRESH_EVENT && c.reason.startsWith('p02-relationship-apply:')),
    `every refresh request names the Library Index refresh-request port with a bounded reason (${calls.length})`);
  const reasons = calls.map((c) => c.reason);
  check(reasons.includes('p02-relationship-apply:folder:create-folder') && reasons.includes('p02-relationship-apply:folder:rename-folder') &&
    reasons.includes('p02-relationship-apply:chat-folder-binding:bind-chat') && reasons.includes('p02-relationship-apply:chat-folder-binding:unbind-chat'),
    'create, rename, bind and unfile each requested a refresh');
  const successfulMaterializations = world.commandLog.filter((e) => e.result?.ok === true).length;
  check(calls.length === successfulMaterializations, `exactly one refresh per successful materialization (${calls.length}/${successfulMaterializations})`);
  /* The default port on a Studio-like scope dispatches exactly that event. */
  const dispatched = [];
  const scope = {
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init?.detail; } },
    dispatchEvent(event) { dispatched.push(event); return true; }
  };
  const port = relationship.createLibraryRefreshRequestPort(scope);
  const outcome = await port({ reason: 'p02-relationship-apply:folder:create-folder' });
  check(outcome.requested === true && dispatched.length === 1 && dispatched[0].type === LIBRARY_REFRESH_EVENT &&
    dispatched[0].detail.reason === 'p02-relationship-apply:folder:create-folder' && dispatched[0].detail.source === 'p02-relationship-apply',
    'the default port dispatches one evt:h2o:library-index:refresh-request with the reason the Library Index reads');
  const headless = await relationship.createLibraryRefreshRequestPort({})({ reason: 'x' });
  check(headless.requested === false && headless.unavailable === true, 'without a window the port reports unavailable instead of inventing a refresh');
  /* The Library owns that listener. */
  const index = read('src-surfaces-base/studio/S0F1c. 🎬 Library Index - Studio.js');
  check(index.includes("W.addEventListener('evt:h2o:library-index:refresh-request'"), 'the Library Index listens for explicit refresh requests on that event');
  const actions = read('src-surfaces-base/studio/S0F3b. 🎬 Folders Actions - Studio.js');
  check(actions.includes("var REFRESH_EVENT  = 'evt:h2o:library-index:refresh-request';"), 'it is the same canonical refresh event the Library\'s own Desktop folder writes dispatch');
  const facadeSrc = stripComments(read('src-surfaces-base/studio/sync/sync-reverse-desktop-v2.tauri.mjs'));
  const relSrc = stripComments(read('src-surfaces-base/studio/sync/sync-relationship-materialization-desktop-v2.tauri.mjs'));
  for (const forbidden of ['SidebarSections', 'renderAllSections', 'evt:h2o:folders:changed', 'pingNow', 'H2O.Studio.actions', 'store.folders', 'H2O.Library.Folders', 'LibraryWorkspace', '_bustCaches', 'cross-surface-sync', 'FolderCommands', 'document.getElementById', 'innerHTML']) {
    check(!facadeSrc.includes(forbidden) && !relSrc.includes(forbidden), `Sync never touches ${forbidden}`);
  }
  const eventNames = [...relSrc.matchAll(/'evt:[a-z0-9:-]+'/g)].map((m) => m[0]);
  check(eventNames.length === 1 && eventNames[0] === `'${LIBRARY_REFRESH_EVENT}'`, `exactly one event name in the materializer (${eventNames.join(',')})`);
});

/* ---------------------------------------------------------------------- */
await section('V writer-authority boundary and no live mutation (static + runtime)', async () => {
  const relSrc = stripComments(read('src-surfaces-base/studio/sync/sync-relationship-materialization-desktop-v2.tauri.mjs'));
  const facadeSrc = stripComments(read('src-surfaces-base/studio/sync/sync-reverse-desktop-v2.tauri.mjs'));
  for (const [name, src] of [['materializer', relSrc], ['facade', facadeSrc]]) {
    check(!RELATIONSHIP_WRITE_RE.test(src), `${name}: no folders/folder_bindings mutation statement in Sync JS`);
    for (const forbidden of ['f15_authorized_sqlite_execute', 'h2o_sqlite_execute', 'executeAuthorized', 'sync_tombstones', 'DELETE FROM folders', 'FolderProviderCore', 'folder-sync.tauri', 'folder-import', 'auto-import', 'reconcileAlreadyAppliedMetadata', 'metadataReconciler', 'chrome.storage']) {
      check(!src.includes(forbidden), `${name}: never references ${forbidden}`);
    }
  }
  const commandNames = [...relSrc.matchAll(/'h2o_[a-z0-9_]+'/g)].map((m) => m[0]);
  check(commandNames.length === 1 && commandNames[0] === `'${COMMAND}'`, `the materializer names exactly one Tauri command (${commandNames.join(',')})`);
  const statements = [...relSrc.matchAll(/\b(SELECT|INSERT|UPDATE|DELETE)\b[^'`]*(FROM|INTO)\s+([a-z_]+)/g)].map((m) => `${m[1]}:${m[3]}`);
  check(statements.every((s) => s.startsWith('SELECT:') || s === 'INSERT:sync_object_state'),
    `Sync JS statements are reads plus the relationship bookkeeping upsert only (${[...new Set(statements)].join(',')})`);
  check(relSrc.includes("last_conflict_class = NULL, last_error_code = NULL") && relSrc.includes('ON CONFLICT(sync_peer_id, object_domain, object_id)'),
    'the bookkeeping upsert is keyed by the v23 domain-qualified primary key');
  /* Runtime: every write of every world landed in the disposable fixture. */
  for (const w of [world, w2]) {
    check(w.fixture.file.startsWith(scratch), 'fixture database lives in the disposable scratch directory');
    check(w.commands.every((c) => ['plugin:sql|select', 'plugin:sql|execute', 'h2o_p02_storage_read', 'h2o_p02_read_library_authority', 'h2o_p02_read_writer_generation_authority', COMMAND].includes(c)),
      `only reads, protocol bookkeeping and the relationship command were ever invoked (${[...new Set(w.commands)].join(',')})`);
    check(w.sqlExecutes.every((sql) => /sync_object_state|kv_store|sync_branch_evidence_state/.test(sql)),
      `Sync JS executes touched only protocol tables (${[...new Set(w.sqlExecutes.map((s) => s.slice(0, 40)))].join(' | ')})`);
    check(w.sqlExecutes.filter((sql) => /sync_object_state/.test(sql)).every((sql) => /object_domain/.test(sql)),
      'every sync_object_state statement is domain-qualified');
  }
  check(typeof globalThis.chrome === 'undefined' && typeof globalThis.__TAURI_INTERNALS__ === 'undefined', 'no Chrome or Tauri runtime is present in-process');
  /* The F16 guard really was on: a Sync-side direct write is aborted. */
  check(await codeOf(async () => world.db.prepare('INSERT INTO folder_bindings (chat_id, folder_id, assigned_at) VALUES (?, ?, ?)').run('chat-b', 'f_code', NOW_MS)) !== 'ok',
    'a direct folder_bindings write without the writer identity is aborted by the v23 triggers');
  check(world.q.binding('chat-b') === null, 'the aborted write left no row');
  /* Pack and dist inventories carry the new module. */
  const pack = read('tools/product/studio/pack-studio.mjs');
  check((pack.match(/"sync\/sync-relationship-materialization-desktop-v2\.tauri\.mjs"/g) || []).length === 2, 'pack inventory lists the materializer in both surface lists');
  check(distGraph.P02_PACKED_LAYOUT.sync.includes('src-surfaces-base/studio/sync/sync-relationship-materialization-desktop-v2.tauri.mjs'), 'the packed dist graph stages the materializer');
  check(P02_DESKTOP_REVERSE_V2.SUPPORTED_OBJECT_DOMAINS.join('|') === `${CHAT_DOMAIN}|${FOLDER_DOMAIN}|${BINDING_DOMAIN}` &&
    P02_DESKTOP_REVERSE_V2.RELATIONSHIP_COMMAND === COMMAND && P02_DESKTOP_REVERSE_V2.LIBRARY_REFRESH_PORT === LIBRARY_REFRESH_EVENT,
    'the facade publishes its domain coverage, command and refresh port');
});

/* ---------------------------------------------------------------------- */
await section('C determinism: an identical world reproduces the identical Apply sequence', async () => {
  const replayWorld = await makeDesktop();
  replayWorld.q.insertChat('chat-a');
  replayWorld.q.insertChat('chat-b');
  const RR = replayWorld.repository;
  const a = await RR.produce({ objectDomain: FOLDER_DOMAIN, objectId: 'f_study', payload: folderPayload('f_study', 'Study'), mint: 'a1' });
  const b = await RR.produce({ objectDomain: CHAT_DOMAIN, objectId: 'chat-a', payload: chatPayload('chat-a', 'snap-a-1', 'hello'), mint: 'b1' });
  const c = await RR.produce({ objectDomain: BINDING_DOMAIN, objectId: 'chat-a', payload: bindingPayload('chat-a', 'f_study'), mint: 'c1' });
  await RR.publish([a, b, c]);
  await replayWorld.runtime.receiveFromChrome();
  const sequence = [];
  for (let i = 0; i < 4; i += 1) {
    const r = await replayWorld.runtime.applyAdmittedFromChrome();
    sequence.push(`${r.objectDomain}:${r.objectId}:${r.outcome}`);
  }
  const original = [...applied.slice(0, 3).map((r) => `${r.objectDomain}:${r.objectId}:${r.outcome}`), `${BINDING_DOMAIN}:chat-a:already-applied`];
  check(JSON.stringify(sequence) === JSON.stringify(original), `same inputs, same order, same outcomes (${sequence.join(' > ')})`);
  check(JSON.stringify(replayWorld.commandLog.map((e) => e.request)) === JSON.stringify(world.commandLog.slice(0, 2).map((e) => e.request)),
    'the same command requests in the same order');
});

/* ---------------------------------------------------------------------- */
packed.dispose();
fs.rmSync(scratch, { recursive: true, force: true });

const verdict = failures.length === 0
  ? 'P02_DESKTOP_RELATIONSHIP_MATERIALIZATION_PASS'
  : 'P02_DESKTOP_RELATIONSHIP_MATERIALIZATION_FAIL';
const output = { verdict, assertions, sections, failures };
if (failures.length) {
  console.error(JSON.stringify(output, null, 2));
  process.exit(1);
}
console.log(JSON.stringify({
  ...output,
  proves: 'Desktop P02 Receive/Apply is domain-dispatched over chat, folder and binding; one object per Apply attempt through the existing scheduler; blocked(dependency) with typed detail at classification, receive authority and Apply-time recheck; folder create/rename and bind/move/unfile through h2o_p02_relationship_apply only; already-applied replay writes nothing; divergence stays diverged-unresolved; Library refresh only through evt:h2o:library-index:refresh-request; no live mutation'
}, null, 2));
