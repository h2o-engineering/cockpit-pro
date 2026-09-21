#!/usr/bin/env node
/*
 * P02 Folder Relationship Synchronization — T01 substrate validator.
 *
 * Mission p02-folder-relationship-synchronization, Task T01 (exit token
 * RELATIONSHIP_SUBSTRATE_PASS). Deterministic, disposable, in-process:
 * no repository, no canonical app data, no Chrome runtime, no transport.
 *
 * Proves, with the real modules:
 *   A  domain registration: studio.folder.v1 / studio.chat-folder-binding.v1
 *      constants and payload schema tags, chat family unchanged;
 *   B  folder strict contract vectors (shared JSON, also run by Rust);
 *   C  binding strict contract vectors;
 *   D  objectKey domain separation (same objectId, three objectKeys) and the
 *      frozen Z1 chat objectKey unchanged;
 *   E  existing chat contract regression: Z1 envelope vectors, the content-only
 *      chat payload contract, and "no relationship field enters the chat
 *      payload";
 *   F  migration v23 on a disposable fixture (v1..v22 -> v23): lossless,
 *      backfilled, domain-qualified key, F16 successor allowlist; and a fresh
 *      v1..v23 install;
 *   H  static audit: every production sync_object_state statement that
 *      resolves object identity is domain-qualified;
 *   I  runtime collision regression: same peer, same objectId, chat + binding
 *      rows; the chat runtime and the Desktop enumerator select only the chat
 *      row and never touch the binding row;
 *   J  Chrome domain-qualified protocol state: a binding descriptor never
 *      inherits the chat object's apply/protocol state; since T05 the
 *      relationship families read their OWN domain-qualified apply state
 *      (D3) while the chat family keeps its accepted read path, and the
 *      Chrome IDB DATABASE_VERSION remains 4;
 *   K  pack / dist inventory carries the new modules and the packed layout
 *      resolves their imports;
 *   L  writer identity: the generic allowlist does not name
 *      p02.relationship-apply, the command module is its single home, and
 *      the F17 ceiling is 23.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../..');
const rel = (...parts) => path.join(repo, ...parts);
const read = (...parts) => fs.readFileSync(rel(...parts), 'utf8');
const importRepo = (...parts) => import(pathToFileURL(rel(...parts)).href);

const CHAT_DOMAIN = 'studio.chat.saved-state.v1';
const FOLDER_DOMAIN = 'studio.folder.v1';
const BINDING_DOMAIN = 'studio.chat-folder-binding.v1';
const CHAT_PAYLOAD_SCHEMA = 'h2o.studio.fullBundle.v2';
const HEX64 = /^[0-9a-f]{64}$/;

let assertions = 0;
const failures = [];
const sections = [];
function check(condition, label) {
  assertions += 1;
  if (condition !== true) failures.push(label);
}
function section(name, fn) {
  return (async () => {
    const before = failures.length;
    try {
      await fn();
    } catch (error) {
      failures.push(`${name}: threw ${error?.code || error?.message || error}`);
      if (process.env.H2O_VALIDATOR_TRACE) console.error(error);
    }
    sections.push({ name, ok: failures.length === before });
  })();
}
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const codeOf = async (fn) => { try { await fn(); return 'ok'; } catch (e) { return e?.code || 'threw'; } };
const throws = (fn) => { try { fn(); return false; } catch (_) { return true; } };
const keyOf = async (fn) => { try { await fn(); return null; } catch (e) { return e?.key ?? null; } };

/* ---------------------------------------------------------------------- */
/* Migration extraction (mirrors the F17 validators; v1 is a plain literal) */
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

function openMigrated(migrations, maxVersion, file = ':memory:') {
  const db = new DatabaseSync(file);
  /* The Desktop process registers h2o_writer_identity() on every connection
   * (auto-extension). Trigger bodies reference it, so a fixture needs it too. */
  let identity = '';
  db.function('h2o_writer_identity', () => identity);
  for (const migration of migrations) {
    if (migration.version > maxVersion) break;
    db.exec(migration.sql);
  }
  return { db, setIdentity: (value) => { identity = value; } };
}

const PRE_V23_COLUMNS = [
  'sync_peer_id', 'object_id', 'last_published_revision_id',
  'last_published_revision_blob_sha256', 'last_applied_revision_id',
  'last_applied_revision_blob_sha256', 'remote_head_strong_etag',
  'remote_head_revision_blob_sha256', 'pending_operation', 'operation_phase',
  'operation_token', 'owner_boot_id', 'owner_context_id', 'owner_token',
  'intended_object_key', 'intended_revision_id', 'intended_payload_sha256',
  'intended_revision_blob_sha256', 'convergence_watermark_sha256',
  'consumed_revision_blob_sha256', 'last_conflict_class', 'last_error_code',
  'created_at', 'updated_at', 'last_published_payload_sha256',
  'last_applied_payload_sha256', 'last_converged_direction'
];

const vectors = JSON.parse(read('tools/validation/sync/fixtures/p02-relationship-contract-vectors.json'));
const z1 = JSON.parse(read('tools/validation/sync/fixtures/p02-z1-contract-vectors.json'));
const domains = await importRepo('packages/core/sync-relationship-domains-v2.mjs');
const contract = await importRepo('packages/browser-adapters/chrome/sync-contract-v2.mjs');
const projection = await importRepo('packages/core/sync-object-projection.mjs');
const chromeState = await importRepo('packages/browser-adapters/chrome/sync-p02-domain-protocol-state-chrome-v2.mjs');
const pack = await importRepo('tools/product/studio/pack-studio.mjs');
const distGraph = await importRepo('tools/validation/sync/p02-dist-graph.mjs');
const webcrypto = crypto.webcrypto;

/* ---------------------------------------------------------------------- */
await section('A domain registration', async () => {
  const R = domains.P02_RELATIONSHIP_DOMAINS_V2;
  check(R.CHAT_OBJECT_DOMAIN === CHAT_DOMAIN &&
    R.CHAT_OBJECT_DOMAIN === projection.CANONICAL_SYNC_OBJECT_PROJECTION_CONSTANTS.OBJECT_DOMAIN,
  'chat domain constant unchanged and shared');
  check(projection.CANONICAL_SYNC_OBJECT_PROJECTION_CONSTANTS.PAYLOAD_SCHEMA === CHAT_PAYLOAD_SCHEMA,
    'chat payload schema h2o.studio.fullBundle.v2 unchanged');
  check(R.FOLDER.OBJECT_DOMAIN === FOLDER_DOMAIN && R.FOLDER.PAYLOAD_SCHEMA === 'h2o.studio.folderCatalogState.v1',
    'folder family registered with the ratified schema tag');
  check(R.BINDING.OBJECT_DOMAIN === BINDING_DOMAIN && R.BINDING.PAYLOAD_SCHEMA === 'h2o.studio.chatFolderBinding.v1',
    'binding family registered with the ratified schema tag');
  /* T05 D1 (RC-P02-T05-D1-01): the exact key set IS the required set. */
  check(R.FOLDER.REQUIRED_KEYS.join(',') === 'schema,folderId,name' && R.FOLDER.OPTIONAL_KEYS.length === 0,
    'folder exact-key set: schema, folderId, name (no optional keys)');
  check(Array.isArray(R.FOLDER.PROHIBITED_KEYS) && R.FOLDER.PROHIBITED_KEYS.includes('createdAt') &&
    vectors.contract.folderCreatedAt === 'PROHIBITED_FROM_CANONICAL_PAYLOAD' &&
    vectors.contract.folderCanonicalPayloadKeys.join(',') === 'schema,folderId,name',
  'D1: createdAt is prohibited from canonical folder payload bytes (contract + shared vectors)');
  check(!('FOLDER_CREATED_AT_INVALID' in domains.P02_RELATIONSHIP_DOMAIN_ERROR),
    'D1: no createdAt acceptance semantics remain in the core contract');
  check(R.BINDING.REQUIRED_KEYS.join(',') === 'schema,chatId,folderId' && R.BINDING.OPTIONAL_KEYS.length === 0,
    'binding exact-key set: schema, chatId, folderId');
  check(R.FOLDER.ID_GRAMMAR === '^[A-Za-z0-9_.:-]{1,160}$' && R.FOLDER.NAME_MAX_CODE_POINTS === 200,
    'folder id grammar and 200-code-point name bound');
  check(R.COLOR_ADMISSION === 'DEFERRED_PENDING_SHARED_COLOR_VOCABULARY', 'colour admission deferred');
  check(vectors.contract.folderObjectDomain === FOLDER_DOMAIN &&
    vectors.contract.bindingObjectDomain === BINDING_DOMAIN &&
    vectors.contract.folderPayloadSchema === R.FOLDER.PAYLOAD_SCHEMA &&
    vectors.contract.bindingPayloadSchema === R.BINDING.PAYLOAD_SCHEMA &&
    vectors.contract.chatObjectDomainUnchanged === CHAT_DOMAIN,
  'shared vector fixture pins the same constants the Rust tests read');
  check(domains.isRelationshipObjectDomain(FOLDER_DOMAIN) && domains.isRelationshipObjectDomain(BINDING_DOMAIN) &&
    !domains.isRelationshipObjectDomain(CHAT_DOMAIN) && !domains.isRelationshipObjectDomain('studio.other.v1'),
  'relationship-domain predicate covers exactly the two new families');
  check(domains.relationshipDomainDescriptor(CHAT_DOMAIN).validatePayload === null &&
    domains.relationshipDomainDescriptor(FOLDER_DOMAIN).family === 'folder' &&
    domains.relationshipDomainDescriptor(BINDING_DOMAIN).family === 'chat-folder-binding' &&
    await codeOf(() => domains.relationshipDomainDescriptor('studio.other.v1')) === 'p02-rel-domain-unregistered',
  'registry dispatch: chat has no relationship validator, unknown domain is typed');
  /* The Rust mirror declares the same constants (executable proof lives in
   * cargo test sync_contract_v2). */
  const rust = read('apps/studio/desktop/src-tauri/src/sync_contract_v2.rs');
  check(rust.includes(`"${FOLDER_DOMAIN}"`) && rust.includes(`"${BINDING_DOMAIN}"`) &&
    rust.includes('"h2o.studio.folderCatalogState.v1"') && rust.includes('"h2o.studio.chatFolderBinding.v1"') &&
    rust.includes('FOLDER_ID_MAX_LENGTH: usize = 160') && rust.includes('FOLDER_NAME_MAX_CODE_POINTS: usize = 200'),
  'Rust contract module mirrors the registration constants');
});

/* ---------------------------------------------------------------------- */
async function runVectors(family, validate) {
  const positive = vectors[family].positive;
  const negative = vectors[family].negative;
  for (const v of positive) {
    const code = await codeOf(() => validate(v.payload, v.objectId));
    check(code === 'ok', `${family} positive ${v.id}: ${code}`);
  }
  for (const v of negative) {
    const code = await codeOf(() => validate(v.payload, v.objectId));
    check(code === v.expected, `${family} negative ${v.id}: expected ${v.expected}, got ${code}`);
    if (v.rejectedKey) {
      const key = await keyOf(() => validate(v.payload, v.objectId));
      check(key === v.rejectedKey, `${family} negative ${v.id}: rejected key ${key}`);
    }
  }
  return { positive: positive.length, negative: negative.length };
}

await section('B folder strict contract vectors', async () => {
  const counts = await runVectors('folder', domains.validateFolderCatalogStatePayload);
  check(counts.positive >= 8 && counts.negative >= 40, `folder vector coverage ${JSON.stringify(counts)}`);
  const ids = vectors.folder.negative.map((v) => v.id);
  for (const required of [
    'folder-id-object-id-mismatch', 'folder-id-bad-grammar-space', 'folder-id-over-160', 'folder-name-empty',
    'folder-name-control-char', 'folder-name-201-code-points', 'folder-created-at-null',
    'folder-created-at-no-millis', 'folder-color-present', 'folder-updated-at-present',
    'folder-project-ref-present', 'folder-parent-id-camel-present', 'folder-parent-id-snake-present',
    'folder-sort-order-camel-present', 'folder-sort-order-snake-present', 'folder-arbitrary-unknown-key'
  ]) check(ids.includes(required), `folder negative vector present: ${required}`);
  const admitted = vectors.folder.positive.map((v) => v.objectId);
  check(admitted.some((id) => id.startsWith('f_')) && admitted.some((id) => id.startsWith('fold_chrome_')) &&
    admitted.some((id) => /^fold_[0-9a-f-]{36}$/.test(id)), 'every admitted folder id form is a positive vector');
  /* Strictness: the validator returns the frozen canonical view and never
   * repairs; the projector helper is what emits the canonical name. */
  check(domains.canonicalFolderName('  Study \t  Notes\n') === 'Study Notes' &&
    domains.isCanonicalFolderName('Study Notes') && !domains.isCanonicalFolderName('Study  Notes'),
  'canonicalFolderName collapses whitespace for projectors; validator refuses uncollapsed');
  const view = domains.validateFolderCatalogStatePayload(vectors.folder.positive[0].payload, vectors.folder.positive[0].objectId);
  check(Object.isFrozen(view) && view.objectDomain === FOLDER_DOMAIN && !('createdAt' in view) &&
    Object.keys(view).sort().join(',') === 'folderId,name,objectDomain,objectId', 'folder validator returns a frozen typed view without createdAt');
  /* D1 negative control independent of the vector file: any createdAt value
   * shape is the exact-key refusal naming the key. */
  for (const value of ['2026-09-14T10:15:30.123Z', null, 1757844930123]) {
    check(await codeOf(() => domains.validateFolderCatalogStatePayload({ schema: 'h2o.studio.folderCatalogState.v1', folderId: 'f_abc123', name: 'Study', createdAt: value }, 'f_abc123')) === 'p02-rel-folder-payload-key-rejected',
      `D1: createdAt (${JSON.stringify(value)}) is refused as an unknown key`);
  }
});

await section('C binding strict contract vectors', async () => {
  const counts = await runVectors('binding', domains.validateChatFolderBindingPayload);
  check(counts.positive >= 6 && counts.negative >= 20, `binding vector coverage ${JSON.stringify(counts)}`);
  const ids = vectors.binding.negative.map((v) => v.id);
  for (const required of [
    'binding-missing-folder-id-key', 'binding-folder-id-invalid-grammar', 'binding-chat-id-object-id-mismatch',
    'binding-bound-at-present', 'binding-folder-name-present', 'binding-href-present', 'binding-arbitrary-unknown-key'
  ]) check(ids.includes(required), `binding negative vector present: ${required}`);
  const unfiled = domains.validateChatFolderBindingPayload({ schema: 'h2o.studio.chatFolderBinding.v1', chatId: 'chat-a', folderId: null }, 'chat-a');
  check(unfiled.unfiled === true && unfiled.folderId === null, 'folderId null is the Unfile LIVE state');
  /* The binding chatId rule IS the v2 envelope objectId rule. */
  for (const sample of ['chat-a', ' chat', '', 'a'.repeat(512), 'a'.repeat(513), 'chat' + String.fromCharCode(1), 'chat', 'chat x']) {
    check(domains.isChatObjectId(sample) === contract.strictSyncIdentifier(sample), `binding chatId rule matches the envelope strict identifier for ${JSON.stringify(sample)}`);
  }
});

/* ---------------------------------------------------------------------- */
await section('D objectKey domain separation', async () => {
  const S = vectors.objectKeySeparation;
  const chat = await contract.objectKeyHex(CHAT_DOMAIN, S.objectId, webcrypto);
  const binding = await contract.objectKeyHex(BINDING_DOMAIN, S.objectId, webcrypto);
  const folder = await contract.objectKeyHex(FOLDER_DOMAIN, S.objectId, webcrypto);
  check(chat === S.chat && binding === S.binding && folder === S.folder, 'contract objectKeyHex reproduces the pinned per-domain keys');
  check(new Set([chat, binding, folder]).size === 3, 'same objectId -> three distinct objectKeys');
  check(chat === sha256(Buffer.concat([Buffer.from(CHAT_DOMAIN), Buffer.from([0]), Buffer.from(S.objectId)])),
    'objectKey = SHA-256(objectDomain || 0x00 || objectId)');
  const core = projection.createCanonicalSyncObjectProjectionCore({ cryptoImplementation: webcrypto });
  check(await core.objectKeyHex(S.objectId) === chat, 'chat projection core derives the chat objectKey unchanged');
  const z1Head = z1.positive.find((v) => v.kind === 'head');
  const z1Key = JSON.parse(z1Head.canonicalBytes).objectKey;
  check(z1Key === S.z1ChatObjectKey && await contract.objectKeyHex(CHAT_DOMAIN, S.z1ChatObjectId, webcrypto) === z1Key,
    'frozen Z1 chat objectKey is reproduced byte-for-byte (no chat objectKey change)');
});

/* ---------------------------------------------------------------------- */
await section('E existing chat contract regression', async () => {
  for (const v of z1.positive) {
    const bytes = new TextEncoder().encode(v.canonicalBytes);
    const code = await codeOf(() => contract.validateContractDocument({ kind: v.kind, bytes, expectedBlobSha256: v.sha256, cryptoImplementation: webcrypto }));
    check(code === 'ok', `Z1 positive ${v.id}: ${code}`);
  }
  for (const v of z1.negative) {
    const bytes = v.generator === 'over-limit-revision'
      ? new Uint8Array(contract.P02_SYNC_CONTRACT_V2.LIMITS.MAX_REVISION_BYTES + 1).fill(120)
      : new TextEncoder().encode(v.canonicalBytes);
    const code = await codeOf(() => contract.validateContractDocument({ kind: v.kind, bytes, expectedBlobSha256: v.expectedBlobSha256 ?? null, cryptoImplementation: webcrypto }));
    check(code === v.expectedClass, `Z1 negative ${v.id}: expected ${v.expectedClass}, got ${code}`);
  }
  check(contract.P02_SYNC_CONTRACT_V2.SUPPORTED.formatVersion === 2 &&
    contract.P02_SYNC_CONTRACT_V2.SUPPORTED.protocolVersion === 2 &&
    contract.P02_SYNC_CONTRACT_V2.SUPPORTED.layoutEpoch === 1, 'formatVersion 2 / protocolVersion 2 / layoutEpoch 1 unchanged');
  /* Content-only chat payload: valid as before, and no relationship field may
   * enter it at any level. */
  const chatPayload = () => ({
    schema: CHAT_PAYLOAD_SCHEMA,
    chatArchive: {
      chats: [{
        chatId: 'chat-a', title: 'T',
        chatIndex: { title: 'T', lastSnapshotId: 'snap-1', snapshotCount: 1, messageCount: 1, state: { isSaved: true, isLinked: true }, organization: {} },
        snapshots: [{ snapshotId: 'snap-1', chatId: 'chat-a', createdAt: '2026-09-14T10:15:30.123Z', messageCount: 1,
          messages: [{ order: 0, role: 'user', text: 'hi' }],
          meta: { title: 'T', richTurns: [{ turnIdx: 0, role: 'user', outerHTML: '<p>hi</p>', meta: {} }] } }]
      }],
      catalogs: { categories: [], labels: [], tags: [] }
    },
    chromeStorageLocal: {}, libraryKv: []
  });
  check(projection.validateContentOnlyPayload(chatPayload(), 'chat-a', 'snap-1') === true, 'content-only chat payload still validates');
  for (const [label, mutate] of [
    ['top-level folderId', (p) => { p.folderId = 'f_a'; }],
    ['chat-level folderId', (p) => { p.chatArchive.chats[0].folderId = 'f_a'; }],
    ['chatIndex organization.folders', (p) => { p.chatArchive.chats[0].chatIndex.organization = { folders: ['f_a'] }; }],
    ['turn meta folderBinding', (p) => { p.chatArchive.chats[0].snapshots[0].meta.richTurns[0].meta.folderBinding = { folderId: 'f_a' }; }],
    ['catalog folders', (p) => { p.chatArchive.catalogs.folders = [{ id: 'f_a' }]; }]
  ]) {
    const payload = chatPayload();
    mutate(payload);
    const code = await codeOf(() => projection.validateContentOnlyPayload(payload, 'chat-a', 'snap-1'));
    check(code === 'local-publication-unsupported-object-shape', `relationship field refused in chat payload: ${label} (${code})`);
  }
  check(domains.validateRelationshipPayload.length === 3 &&
    await codeOf(() => domains.validateRelationshipPayload(CHAT_DOMAIN, chatPayload(), 'chat-a')) === 'p02-rel-domain-unregistered',
  'relationship validators never claim the chat payload');
});

/* ---------------------------------------------------------------------- */
const libText = read('apps/studio/desktop/src-tauri/src/lib.rs');
const migrations = extractStudioMigrations(libText);

await section('F migration v23 on a disposable fixture', async () => {
  check(migrations.map((m) => m.version).join(',') === Array.from({ length: 23 }, (_, i) => i + 1).join(','),
    `migrations v1..v23 extracted (${migrations.length})`);
  const v23 = migrations.find((m) => m.version === 23);
  check(/CREATE TABLE sync_object_state_v23/.test(v23.sql) && /DROP TABLE sync_object_state;/.test(v23.sql) &&
    /ALTER TABLE sync_object_state_v23 RENAME TO sync_object_state/.test(v23.sql), 'v23 uses the table-rebuild pattern');
  check(!/object_domain\s+TEXT\s+NOT NULL\s+DEFAULT/.test(v23.sql) && /object_domain\s+TEXT NOT NULL CHECK \(object_domain <> ''\)/.test(v23.sql),
    'object_domain is NOT NULL with no DEFAULT');
  check(!/^\s*object_key\s+TEXT/m.test(v23.sql) && /intended_object_key\s+TEXT/.test(v23.sql), 'object_key is not persisted (stays derived); intended_object_key preserved');
  check(!/f15\.bulk-migration|f15\.debug-bypass|f15\.emergency-repair/.test(v23.sql), 'v23 trigger allowlist admits no bypass identity');
  const v13 = migrations.find((m) => m.version === 13);
  check(!v13.sql.includes('p02.relationship-apply') && v13.sql.includes("VALUES (1, 0, NULL, 'f16.4.c-default-off')"),
    'v13 historical text is not rewritten');

  const { db, setIdentity } = openMigrated(migrations, 22);
  check(db.prepare('PRAGMA table_info(sync_object_state)').all().map((c) => c.name).join(',') === PRE_V23_COLUMNS.join(','),
    'v22 fixture has the pre-v23 column set');
  const peers = ['studio-desktop:tauri-desktop:sqlite:peer-a', 'studio-chrome:mv3-chrome:idb-archive:peer-b'];
  const seeded = [];
  for (const [pi, peer] of peers.entries()) {
    for (const [oi, object] of ['chat-1', 'chat-2'].entries()) {
      const sparse = pi === 1 && oi === 1;
      const row = {};
      for (const column of PRE_V23_COLUMNS) {
        if (column === 'sync_peer_id') row[column] = peer;
        else if (column === 'object_id') row[column] = object;
        else if (column === 'created_at' || column === 'updated_at') row[column] = `2026-09-14T00:00:00.${pi}${oi}0Z`;
        else row[column] = sparse ? null : `${column}-${pi}${oi}`;
      }
      db.prepare(`INSERT INTO sync_object_state (${PRE_V23_COLUMNS.join(', ')}) VALUES (${PRE_V23_COLUMNS.map(() => '?').join(', ')})`)
        .run(...PRE_V23_COLUMNS.map((c) => row[c]));
      seeded.push(row);
    }
  }
  db.exec("UPDATE f16_folder_bindings_trigger_guard SET enabled = 1, reason = 'proof-on' WHERE id = 1");
  db.exec(migrations.find((m) => m.version === 23).sql);

  const columns = db.prepare('PRAGMA table_info(sync_object_state)').all();
  check(columns.map((c) => c.name).join(',') === ['sync_peer_id', 'object_domain', ...PRE_V23_COLUMNS.slice(1)].join(','),
    'v23 column set = object_domain inserted after sync_peer_id, every pre-v23 column preserved in order');
  const domainColumn = columns.find((c) => c.name === 'object_domain');
  check(domainColumn.notnull === 1 && domainColumn.dflt_value === null, 'object_domain NOT NULL without DEFAULT in the live schema');
  check(columns.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name).join(',') === 'sync_peer_id,object_domain,object_id',
    'primary key is (sync_peer_id, object_domain, object_id)');
  const migrated = db.prepare('SELECT * FROM sync_object_state ORDER BY sync_peer_id, object_id').all();
  check(migrated.length === seeded.length, 'row count preserved');
  for (const expected of seeded) {
    const actual = migrated.find((r) => r.sync_peer_id === expected.sync_peer_id && r.object_id === expected.object_id);
    check(actual?.object_domain === CHAT_DOMAIN, `backfilled to chat domain: ${expected.object_id}@${expected.sync_peer_id}`);
    check(actual && PRE_V23_COLUMNS.every((c) => actual[c] === expected[c]), `every pre-v23 column preserved: ${expected.object_id}@${expected.sync_peer_id}`);
  }
  db.prepare("INSERT INTO sync_object_state (sync_peer_id, object_domain, object_id, created_at, updated_at) VALUES (?, ?, ?, 'now', 'now')")
    .run(peers[0], BINDING_DOMAIN, 'chat-1');
  check(db.prepare('SELECT COUNT(*) AS n FROM sync_object_state WHERE sync_peer_id = ? AND object_id = ?').get(peers[0], 'chat-1').n === 2,
    'same peer + same objectId + different domain coexist');
  check(throws(() => db.prepare("INSERT INTO sync_object_state (sync_peer_id, object_domain, object_id, created_at, updated_at) VALUES (?, ?, ?, 'now', 'now')").run(peers[0], CHAT_DOMAIN, 'chat-1')),
    'duplicate (peer, chat domain, objectId) still refused');
  check(throws(() => db.prepare("INSERT INTO sync_object_state (sync_peer_id, object_id, created_at, updated_at) VALUES (?, ?, 'now', 'now')").run(peers[0], 'chat-9')),
    'domain-unaware insert refused (never silently chat)');
  check(throws(() => db.prepare("INSERT INTO sync_object_state (sync_peer_id, object_domain, object_id, created_at, updated_at) VALUES (?, '', ?, 'now', 'now')").run(peers[0], 'chat-9')),
    'empty domain refused by CHECK');
  for (const trigger of ['f16_protect_folder_bindings_insert', 'f16_protect_folder_bindings_update', 'f16_protect_folder_bindings_delete']) {
    const sql = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?").get(trigger)?.sql || '';
    check(sql.includes("'f15.execute-settlement-writer'") && sql.includes("'f16.folder-legacy-fallback'") && sql.includes("'p02.relationship-apply'") &&
      sql.includes('f16_folder_bindings_trigger_guard'), `successor allowlist on ${trigger}`);
  }
  check(db.prepare('SELECT enabled, reason FROM f16_folder_bindings_trigger_guard WHERE id = 1').get().reason === 'proof-on', 'guard row state preserved');
  check(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name LIKE 'sync_object_state_v23%'").get().n === 0, 'no rebuild residue');
  /* Guard behaviour with the fixture identity function: unauthorized refused,
   * p02.relationship-apply admitted, legacy identities still admitted. */
  db.exec("INSERT INTO chats (id, title) VALUES ('chat-g', 'g')");
  db.exec("INSERT INTO folders (id, name, created_at, updated_at) VALUES ('f_g', 'G', 1, 1)");
  const bind = () => db.prepare("INSERT OR REPLACE INTO folder_bindings (chat_id, folder_id, assigned_at) VALUES ('chat-g', 'f_g', 1)").run();
  check(throws(bind), 'guard on: empty identity refused');
  setIdentity('p02.relationship-apply-lookalike');
  check(throws(bind), 'guard on: look-alike identity refused');
  setIdentity('p02.relationship-apply');
  check(!throws(bind), 'guard on: p02.relationship-apply admitted');
  check(!throws(() => db.prepare("DELETE FROM folder_bindings WHERE chat_id = 'chat-g'").run()), 'guard on: p02.relationship-apply unfile admitted');
  setIdentity('f16.folder-legacy-fallback');
  check(!throws(bind), 'guard on: f16.folder-legacy-fallback still admitted');
  setIdentity('f15.execute-settlement-writer');
  check(!throws(() => db.prepare("DELETE FROM folder_bindings WHERE chat_id = 'chat-g'").run()), 'guard on: f15.execute-settlement-writer still admitted');
  setIdentity('');
  db.close();

  const fresh = openMigrated(migrations, 23);
  const freshColumns = fresh.db.prepare('PRAGMA table_info(sync_object_state)').all();
  check(freshColumns.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name).join(',') === 'sync_peer_id,object_domain,object_id' &&
    fresh.db.prepare('SELECT COUNT(*) AS n FROM sync_object_state').get().n === 0, 'fresh install v1..v23 yields the domain-qualified empty table');
  fresh.db.close();
});

/* ---------------------------------------------------------------------- */
await section('H static audit: domain-qualified sync_object_state access', async () => {
  const scopes = [
    'src-surfaces-base/studio/sync', 'src-surfaces-base/studio/platform', 'src-surfaces-base/studio/store',
    'packages/core', 'packages/browser-adapters/chrome', 'apps/studio/desktop/src-tauri/src'
  ];
  const files = [];
  for (const scope of scopes) {
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { if (entry.name !== 'target' && entry.name !== 'node_modules') walk(full); }
        else if (/\.(mjs|js|rs)$/.test(entry.name)) files.push(full);
      }
    };
    walk(rel(scope));
  }
  const statements = [];
  let audited = 0;
  for (const file of files) {
    let text = fs.readFileSync(file, 'utf8');
    if (!text.includes('sync_object_state')) continue;
    if (file.endsWith('lib.rs')) {
      /* The migration list is proven by section F; the audit is about
       * statements that RESOLVE object identity at runtime. */
      const start = text.indexOf('fn studio_migrations() -> Vec<Migration>');
      const end = text.indexOf('\nasync fn ', start);
      text = text.slice(0, start) + text.slice(end);
    }
    if (file.endsWith('.rs') && text.includes('#[cfg(test)]')) {
      /* Rust unit-test fixtures (including the deliberate negative probes
       * that prove a domain-less insert is refused) are not production
       * statements; cargo test proves them. */
      text = text.slice(0, text.indexOf('#[cfg(test)]'));
    }
    /* Only occurrences in SQL statement position count as statements: a
     * table name after FROM / INTO / UPDATE / JOIN / TABLE. Prose mentions in
     * comments and string constants used as labels are not statements. */
    const re = /\b(FROM|INTO|UPDATE|JOIN|TABLE)\s+sync_object_state\b/g;
    const hits = [];
    let match;
    while ((match = re.exec(text))) hits.push(match.index + match[0].indexOf('sync_object_state'));
    for (const [index, hit] of hits.entries()) {
      const previous = index > 0 ? hits[index - 1] : -Infinity;
      const next = index + 1 < hits.length ? hits[index + 1] : Infinity;
      const from = Math.max(0, hit - 400, Math.ceil((previous + hit) / 2));
      const to = Math.min(text.length, hit + 700, Math.floor((hit + next) / 2));
      const window = text.slice(from, to);
      const resolvesIdentity = /\bobject_id\b/.test(window);
      const qualified = /\bobject_domain\b/.test(window);
      audited += 1;
      statements.push({ file: path.relative(repo, file), line: text.slice(0, hit).split('\n').length, resolvesIdentity, qualified });
      if (resolvesIdentity) check(qualified, `unqualified sync_object_state access at ${path.relative(repo, file)}:${text.slice(0, hit).split('\n').length}`);
    }
  }
  /* At the T01 baseline the production scope holds 18 statements: 17 resolve
   * object identity (all domain-qualified) and one is peer-scoped
   * (round2a orphan remediation count). Growth is allowed; shrinkage means
   * the audit lost sight of a file. */
  check(audited >= 18, `audit covered ${audited} sync_object_state statements`);
  const identityResolving = statements.filter((s) => s.resolvesIdentity);
  check(identityResolving.length >= 17, `identity-resolving statements audited: ${identityResolving.length}`);
  for (const required of [
    'src-surfaces-base/studio/sync/sync-object-runtime.tauri.js',
    'src-surfaces-base/studio/sync/sync-object-enumerator-v2.tauri.mjs',
    'src-surfaces-base/studio/sync/sync-reverse-desktop-v2.tauri.mjs',
    'src-surfaces-base/studio/sync/sync-steady-activation-desktop-v2.tauri.mjs',
    'apps/studio/desktop/src-tauri/src/local_publication_intake.rs',
    'apps/studio/desktop/src-tauri/src/item11_delivery_destination.rs',
    'apps/studio/desktop/src-tauri/src/round2a_identity_recovery.rs'
  ]) check(identityResolving.some((s) => s.file === required), `audit reached ${required}`);
  /* Negative control: an unqualified statement is caught by the same rule. */
  const probe = "sqlSelect('SELECT * FROM sync_object_state WHERE sync_peer_id = ? AND object_id = ?', [peer, id])";
  check(/\bobject_id\b/.test(probe) && !/\bobject_domain\b/.test(probe), 'negative control: the rule flags an unqualified statement');
});

/* ---------------------------------------------------------------------- */
await section('I runtime collision regression (same peer, same objectId, two domains)', async () => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(process.env.TMPDIR || '/tmp'), 'p02-rel-substrate-'));
  const { db } = openMigrated(migrations, 23, path.join(dir, 'studio-v1.db'));
  const PEER = 'studio-desktop:tauri-desktop:sqlite:peer-a';
  const OBJECT = 'chat-shared';
  const bindingRow = {
    sync_peer_id: PEER, object_domain: BINDING_DOMAIN, object_id: OBJECT,
    last_published_revision_id: 'binding-published-r1', last_published_revision_blob_sha256: 'b'.repeat(64),
    last_applied_revision_id: 'binding-applied-r1', last_applied_revision_blob_sha256: 'c'.repeat(64),
    pending_operation: 'publish', operation_phase: 'transport', owner_boot_id: 'binding-boot', owner_context_id: 'binding-ctx', owner_token: 'binding-token',
    intended_revision_id: 'binding-intended', intended_revision_blob_sha256: 'd'.repeat(64),
    convergence_watermark_sha256: 'e'.repeat(64), consumed_revision_blob_sha256: 'e'.repeat(64),
    last_conflict_class: 'binding-conflict', last_error_code: 'binding-error',
    created_at: '2026-09-14T00:00:00.000Z', updated_at: '2026-09-14T00:00:00.000Z',
    last_published_payload_sha256: 'f'.repeat(64), last_applied_payload_sha256: '1'.repeat(64), last_converged_direction: 'applied'
  };
  const bindingColumns = Object.keys(bindingRow);
  db.prepare(`INSERT INTO sync_object_state (${bindingColumns.join(', ')}) VALUES (${bindingColumns.map(() => '?').join(', ')})`).run(...bindingColumns.map((c) => bindingRow[c]));
  const readBinding = () => db.prepare('SELECT * FROM sync_object_state WHERE sync_peer_id = ? AND object_domain = ? AND object_id = ?').get(PEER, BINDING_DOMAIN, OBJECT);
  const readChat = () => db.prepare('SELECT * FROM sync_object_state WHERE sync_peer_id = ? AND object_domain = ? AND object_id = ?').get(PEER, CHAT_DOMAIN, OBJECT);
  const bindingBefore = JSON.stringify(readBinding());

  /* The real chat runtime over the migrated database. */
  const sql = {
    async execute(query, values = []) { const r = db.prepare(query).run(...values); return [Number(r.changes), Number(r.lastInsertRowid || 0)]; },
    async select(query, values = []) { return db.prepare(query).all(...values); }
  };
  const sandbox = {
    console, crypto: webcrypto, TextEncoder, TextDecoder, structuredClone, setTimeout, clearTimeout,
    chrome: { runtime: {}, storage: { local: { get(_k, cb) { cb({}); }, set(_v, cb) { if (cb) cb(); } } } },
    H2O: { Studio: { platform: { __sqliteStatus: () => ({ backend: 'sqlite', ready: true }) }, store: {} } },
    __TAURI_INTERNALS__: { invoke: async (command, args) => {
      if (command === 'plugin:sql|execute') return sql.execute(args.query, args.values);
      if (command === 'plugin:sql|select') return sql.select(args.query, args.values);
      throw new Error(`unexpected command: ${command}`);
    } }
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(read('src-surfaces-base/studio/sync/sync-object-projection.tauri.js'), sandbox, { filename: 'sync-object-projection.tauri.js' });
  vm.runInContext(read('src-surfaces-base/studio/sync/sync-object-runtime.tauri.js'), sandbox, { filename: 'sync-object-runtime.tauri.js' });
  const runtime = sandbox.H2O.Desktop.SyncObjectRuntime;
  runtime.__test.setDependencies({ sql, stores: {}, syncPeerId: PEER, strictOwnerSchema: true, bootId: 'chat-boot-1' });
  check(runtime.objectDomain === CHAT_DOMAIN, 'chat runtime declares its object domain');

  /* state read: no chat row yet, and the binding row is NOT returned as it */
  check(await runtime.__test.stateRow(PEER, OBJECT) === null, 'state read: binding row is invisible to the chat runtime');
  check(await runtime.publicationEvidence.readState(PEER, OBJECT) === null, 'publication evidence readState: binding row invisible');

  /* acquire / ownership: the binding row's pending publish does not make the
   * chat object busy, and the chat row is created beside it */
  const acquisition = await runtime.__test.acquire(PEER, OBJECT, 'publish', 'chat-boot-1');
  check(acquisition.resumed === false && acquisition.legacy === false, 'acquire: fresh chat acquisition despite the pending binding row');
  const chatAfterAcquire = readChat();
  check(chatAfterAcquire?.pending_operation === 'publish' && chatAfterAcquire?.owner_boot_id === 'chat-boot-1', 'acquire: chat row owned');
  check(JSON.stringify(readBinding()) === bindingBefore, 'acquire: binding row untouched');
  check(db.prepare('SELECT COUNT(*) AS n FROM sync_object_state WHERE sync_peer_id = ? AND object_id = ?').get(PEER, OBJECT).n === 2, 'two rows share the objectId');

  /* apply-state write path (updateOwned is the seam commitApplied uses) */
  await runtime.__test.updateOwned(acquisition, PEER, OBJECT,
    'last_applied_revision_id = ?, last_applied_revision_blob_sha256 = ?, last_applied_payload_sha256 = ?, last_converged_direction = ?, consumed_revision_blob_sha256 = ?, convergence_watermark_sha256 = ?',
    ['chat-applied-r1', '2'.repeat(64), '3'.repeat(64), 'applied', '2'.repeat(64), '2'.repeat(64)]);
  check(readChat().last_applied_revision_id === 'chat-applied-r1', 'apply state: chat row updated');
  check(JSON.stringify(readBinding()) === bindingBefore, 'apply state: binding row untouched');

  /* publication state through the production publication-evidence API */
  await runtime.publicationEvidence.completePublication(acquisition, {
    syncPeerId: PEER, objectId: OBJECT, revisionId: 'chat-published-r1', revisionBlobSha256: '4'.repeat(64), payloadSha256: '5'.repeat(64)
  });
  const chatPublished = readChat();
  check(chatPublished.last_published_revision_id === 'chat-published-r1' && chatPublished.pending_operation === null && chatPublished.owner_token === null,
    'publication state: chat row completed and released');
  check(JSON.stringify(readBinding()) === bindingBefore, 'publication state: binding row untouched (still pending publish)');

  /* recordIntent / abandonIntent (durable intent protocol) */
  const intent = await runtime.publicationEvidence.recordIntent({ syncPeerId: PEER, objectId: OBJECT, revisionId: 'chat-r2', revisionBlobSha256: '6'.repeat(64), objectKey: '7'.repeat(64), payloadSha256: '8'.repeat(64) });
  check(readChat().intended_revision_id === 'chat-r2' && readBinding().intended_revision_id === 'binding-intended', 'recordIntent: only the chat row carries the chat intent');
  await runtime.publicationEvidence.abandonIntent(intent, { syncPeerId: PEER, objectId: OBJECT, errorCode: 'proof-abandon' });
  check(readChat().intended_revision_id === null && readChat().last_error_code === 'proof-abandon', 'abandonIntent: chat row cleared');
  check(JSON.stringify(readBinding()) === bindingBefore, 'abandonIntent: binding row untouched');

  /* heal-on-proof: the chat anchor without payload identity is healed; the
   * binding row (which already has one) is untouched */
  db.prepare('UPDATE sync_object_state SET last_published_payload_sha256 = NULL, last_converged_direction = NULL, last_error_code = NULL WHERE sync_peer_id = ? AND object_domain = ? AND object_id = ?').run(PEER, CHAT_DOMAIN, OBJECT);
  const healed = await runtime.publicationEvidence.healPublishedPayloadIdentity({ syncPeerId: PEER, objectId: OBJECT, revisionId: 'chat-published-r1', revisionBlobSha256: '4'.repeat(64), payloadSha256: '5'.repeat(64) });
  check(healed.healed === true && readChat().last_published_payload_sha256 === '5'.repeat(64), 'heal: chat identity backfilled');
  check(JSON.stringify(readBinding()) === bindingBefore, 'heal: binding row untouched');

  /* Desktop enumerator (packed layout) selects the chat row only */
  db.prepare("INSERT INTO chats (id, title, last_snapshot_id, updated_at) VALUES (?, 'shared', 'snap-1', 5)").run(OBJECT);
  const staged = distGraph.stagePackedGraph();
  try {
    const enumeratorModule = await staged.importPacked('sync/sync-object-enumerator-v2.tauri.mjs');
    const objectKey = await contract.objectKeyHex(CHAT_DOMAIN, OBJECT, webcrypto);
    const enumerator = enumeratorModule.createDesktopReadOnlyObjectEnumerator({
      sql,
      projection: {
        projectObject: async (objectId) => ({ objectId, revisionId: 'snap-1', revisionBlobSha256Hex: '9'.repeat(64), payloadSha256Hex: 'a'.repeat(64), objectKeyHex: objectKey }),
        objectKeyHex: async () => objectKey
      },
      configuredSyncPeerIds: [PEER]
    });
    const enumerated = await enumerator.enumerate();
    check(enumerated.descriptors.length === 1 && enumerated.descriptors[0].objectDomain === CHAT_DOMAIN, 'enumerator: exactly one chat descriptor');
    const protocol = enumerated.descriptors[0].protocolState;
    check(protocol.lastPublished?.revisionId === 'chat-published-r1' && protocol.lastApplied?.revisionId === 'chat-applied-r1',
      'enumerator: chat descriptor carries the chat anchors');
    check(protocol.lastApplied?.revisionId !== 'binding-applied-r1' && protocol.pendingOperation === null,
      'enumerator: binding anchors and the binding pending operation never leak into the chat descriptor');
    check(enumeratorModule.P02_DESKTOP_READ_QUERIES.PROTOCOL.includes('WHERE object_domain = ?'), 'enumerator protocol read is domain-bound');
  } finally {
    staged.dispose();
  }
  /* Steady / reverse compositions: the protocol row reads are domain-bound. */
  check(read('src-surfaces-base/studio/sync/sync-steady-activation-desktop-v2.tauri.mjs').includes('WHERE sync_peer_id = ? AND object_domain = ? AND object_id = ? LIMIT 1'),
    'steady activation protocol row is domain-bound');
  check(read('src-surfaces-base/studio/sync/sync-reverse-desktop-v2.tauri.mjs').includes("'WHERE sync_peer_id = ? AND object_domain = ? AND object_id = ? LIMIT 1'"),
    'reverse composition protocol state is domain-bound');
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

/* ---------------------------------------------------------------------- */
await section('J Chrome publication-side domain-qualified protocol state', async () => {
  const OBJECT = 'chat-shared';
  const chatKey = await contract.objectKeyHex(CHAT_DOMAIN, OBJECT, webcrypto);
  const bindingKey = await contract.objectKeyHex(BINDING_DOMAIN, OBJECT, webcrypto);
  const folderKey = await contract.objectKeyHex(FOLDER_DOMAIN, 'f_study', webcrypto);
  const calls = [];
  const ledger = new Map([
    [chatKey, { tip: { revisionId: 'chat-pub-r1', revisionBlobSha256Hex: '1'.repeat(64), payloadSha256Hex: '2'.repeat(64) }, convergedDirection: 'published', pending: 'Clean' }],
    [bindingKey, { tip: { revisionId: 'binding-pub-r1', revisionBlobSha256Hex: '3'.repeat(64), payloadSha256Hex: '4'.repeat(64) }, convergedDirection: 'published', pending: 'Clean' }]
  ]);
  const syncStore = {
    async readApplySnapshot(objectId) {
      calls.push(['readApplySnapshot', objectId]);
      return {
        observations: [{ revisionId: 'chat-observed-r0' }, { revisionId: 'chat-observed-r1' }],
        applyState: {
          lastApplied: { revisionId: 'chat-applied-r1', revisionBlobSha256Hex: '5'.repeat(64), payloadSha256Hex: '6'.repeat(64) },
          pending: { referenceKind: 'branch-evidence-v2', revisionId: 'chat-pending-r2', revisionBlobSha256Hex: '7'.repeat(64), selectedLeafRevisionId: 'chat-pending-r2', selectedLeafRevisionBlobSha256Hex: '7'.repeat(64) }
        }
      };
    },
    async readLocalPublicationTip(objectKey) { calls.push(['readLocalPublicationTip', objectKey]); return ledger.get(objectKey)?.tip ?? null; },
    async readLocalPublicationConvergence(objectKey) { calls.push(['readLocalPublicationConvergence', objectKey]); const e = ledger.get(objectKey); return e ? { tip: e.tip, convergedDirection: e.convergedDirection } : { tip: null, convergedDirection: null }; },
    async resolveLocalPublicationPending(objectKey) { calls.push(['resolveLocalPublicationPending', objectKey]); return { state: ledger.get(objectKey)?.pending ?? 'Clean' }; },
    /* T05 / D3: the domain-qualified relationship apply state, keyed by
     * (objectDomain, objectId). The binding row shares the chat objectId and
     * carries its OWN applied anchor; the folder has none. */
    async readRelationshipApplyState({ objectDomain, objectId }) {
      calls.push(['readRelationshipApplyState', objectDomain, objectId]);
      const objectKey = await contract.objectKeyHex(objectDomain, objectId, webcrypto);
      if (objectDomain === BINDING_DOMAIN && objectId === OBJECT) {
        return { ok: true, objectDomain, objectId, objectKey, branchEvidence: [{ revisionId: 'binding-applied-r1' }],
          applyState: { lastApplied: { referenceKind: 'branch-evidence-v2', revisionId: 'binding-applied-r1', revisionBlobSha256Hex: '8'.repeat(64), payloadSha256Hex: '9'.repeat(64) }, pending: null } };
      }
      return { ok: true, objectDomain, objectId, objectKey, branchEvidence: [], applyState: null };
    }
  };
  const chat = await chromeState.readChromeDomainProtocolState({ objectDomain: CHAT_DOMAIN, objectId: OBJECT, syncStore, cryptoImplementation: webcrypto });
  check(chat.objectKey === chatKey && chat.applyStateSource === 'chat-object-id-apply-store' && chat.nonChatReceive === null, 'chat: objectKey and apply source as accepted');
  check(chat.protocolState.lastApplied?.revisionId === 'chat-applied-r1' && chat.protocolState.pendingApply?.revisionId === 'chat-pending-r2' &&
    chat.protocolState.retainedObservationRevisionIds.length === 2 && chat.protocolState.pendingOperation === 'apply' && chat.pending === true,
  'chat: apply state read exactly as the chat enumerator reads it');
  check(chat.protocolState.lastPublished?.revisionId === 'chat-pub-r1' && chat.identity.direction === 'published' && chat.identity.publishedPayloadSha256 === '2'.repeat(64) && chat.identity.appliedPayloadSha256 === '6'.repeat(64),
    'chat: publication ledger read by the chat objectKey');
  check(calls.filter((c) => c[0] === 'readApplySnapshot').length === 1 && calls.some((c) => c[0] === 'readLocalPublicationConvergence' && c[1] === chatKey), 'chat: one apply-store read, ledger read by chat key');

  calls.length = 0;
  const binding = await chromeState.readChromeDomainProtocolState({ objectDomain: BINDING_DOMAIN, objectId: OBJECT, syncStore, cryptoImplementation: webcrypto });
  check(binding.objectKey === bindingKey && binding.objectKey !== chat.objectKey, 'binding: distinct objectKey for the same objectId');
  check(calls.every((c) => c[0] !== 'readApplySnapshot'), 'binding: the objectId-keyed apply store is NEVER read');
  check(calls.every((c) => c[0] === 'readApplySnapshot' || c[0] === 'readRelationshipApplyState' || c[1] === bindingKey), 'binding: every ledger read uses the binding objectKey');
  check(binding.applyStateSource === 'relationship-domain-qualified-apply-store' && binding.nonChatReceive === 'domain-qualified-idb-state',
    'binding: apply source is the T05 domain-qualified relationship store; receive posture domain-qualified');
  check(calls.some((c) => c[0] === 'readRelationshipApplyState' && c[1] === BINDING_DOMAIN && c[2] === OBJECT),
    'binding: apply state read through the domain-qualified port for (binding domain, objectId)');
  check(binding.protocolState.lastApplied?.revisionId === 'binding-applied-r1' && binding.protocolState.lastApplied?.payloadSha256 === '9'.repeat(64) &&
    binding.protocolState.lastApplied?.revisionId !== 'chat-applied-r1' && binding.protocolState.pendingApply === null &&
    binding.protocolState.consumedRevisionBlobSha256 === '8'.repeat(64) &&
    binding.protocolState.retainedObservationRevisionIds.join(',') === 'binding-applied-r1' && binding.identity.appliedPayloadSha256 === '9'.repeat(64),
  'binding: carries its OWN applied anchor and inherits none of the chat object\'s applied anchor, pending apply or observations');
  check(binding.protocolState.lastPublished?.revisionId === 'binding-pub-r1' && binding.identity.publishedPayloadSha256 === '4'.repeat(64) && binding.protocolState.pendingOperation === null && binding.pending === false,
    'binding: its own publication tip only');

  calls.length = 0;
  const folder = await chromeState.readChromeDomainProtocolState({ objectDomain: FOLDER_DOMAIN, objectId: 'f_study', syncStore, cryptoImplementation: webcrypto });
  check(folder.objectKey === folderKey && folder.protocolState.lastPublished === null && folder.protocolState.lastApplied === null && calls.every((c) => c[0] !== 'readApplySnapshot'),
    'folder: unpublished, no apply-store read');
  check(await codeOf(() => chromeState.readChromeDomainProtocolState({ objectDomain: BINDING_DOMAIN, objectId: OBJECT, syncStore: { ...syncStore, readRelationshipApplyState: undefined }, cryptoImplementation: webcrypto })) === 'p02-chrome-domain-protocol-state-store-invalid',
    'relationship family without the domain-qualified port is a typed refusal (never an empty read)');
  check(chromeState.P02_CHROME_DOMAIN_PROTOCOL_STATE_V2.DIRECTION_COVERAGE === 'RELATIONSHIP_SYNC_DIRECTION_COVERAGE=BIDIRECTIONAL',
    'T05 direction coverage is bidirectional');
  /* D3: the real store keeps DATABASE_VERSION 4 and its migration ladder;
   * the relationship regime is additive in the existing stores. */
  const storeModule = await importRepo('packages/browser-adapters/chrome/sync-object-store.mjs');
  check(storeModule.ITEM9_1_CONSTANTS.DATABASE_VERSION === 4 && storeModule.MIGRATIONS.length === 4 &&
    storeModule.validateMigrationRegistry(storeModule.MIGRATIONS, 4) === true, 'Chrome IDB DATABASE_VERSION remains 4 with the four accepted migrations');
  const storeSource = read('packages/browser-adapters/chrome/sync-object-store.mjs');
  check(!/createObjectStore\((?!AUTHORITY_STORE|OBSERVATION_STORE|LOCAL_PUBLICATION_LEDGER_STORE|ADMISSION_EVIDENCE_STORE|APPLY_STATE_STORE|BRANCH_EVIDENCE_STORE)/.test(storeSource) &&
    (storeSource.match(/createObjectStore\(/g) || []).length === 6 && !storeSource.includes('deleteObjectStore'),
  'no new object store and no store deletion');
  check(storeSource.includes("const RELATIONSHIP_KEY_PREFIX = 'p02'") && storeSource.includes('p02-relationship.v1'),
    'relationship regime uses a distinct key prefix and schema tags in the existing stores');
  check(await codeOf(() => chromeState.readChromeDomainProtocolState({ objectDomain: 'studio.other.v1', objectId: OBJECT, syncStore, cryptoImplementation: webcrypto })) === 'p02-chrome-domain-protocol-state-domain-unregistered',
    'unregistered domain is a typed refusal');
  check(await codeOf(() => chromeState.readChromeDomainProtocolState({ objectDomain: BINDING_DOMAIN, objectId: ' bad', syncStore, cryptoImplementation: webcrypto })) === 'p02-chrome-domain-protocol-state-object-id-invalid',
    'invalid objectId is a typed refusal');
  check(await codeOf(() => chromeState.readChromeDomainProtocolState({ objectDomain: BINDING_DOMAIN, objectId: OBJECT, syncStore: {}, cryptoImplementation: webcrypto })) === 'p02-chrome-domain-protocol-state-store-invalid',
    'store without the required ports is a typed refusal');
  /* The module itself never opens, migrates or writes the IDB store. */
  const source = read('packages/browser-adapters/chrome/sync-p02-domain-protocol-state-chrome-v2.mjs');
  check(!/indexedDB|createObjectStore|stageApplyIntent|commitApplyIntent|stageLocalPublicationIntent|recordObservation|DATABASE_VERSION|stageRelationshipApplyIntent|commitRelationshipApplyIntent|recordRelationshipBranchEvidence/.test(source),
    'helper performs no IDB migration and no store write');
  check(source.includes("import { objectKeyHex } from './sync-contract-v2.mjs'"), 'helper derives objectKey from the frozen contract');
});

/* ---------------------------------------------------------------------- */
await section('K pack / dist inventory', async () => {
  check(pack.P02_CORE_SOURCE_FILES.includes('sync-relationship-domains-v2.mjs'), 'core inventory carries sync-relationship-domains-v2.mjs');
  check(pack.P02_CHROME_ADAPTER_SOURCE_FILES.includes('sync-p02-domain-protocol-state-chrome-v2.mjs'), 'chrome adapter inventory carries the domain protocol-state helper');
  for (const file of pack.P02_CORE_SOURCE_FILES) check(fs.existsSync(rel('packages/core', file)), `core inventory file exists: ${file}`);
  for (const file of pack.P02_CHROME_ADAPTER_SOURCE_FILES) check(fs.existsSync(rel('packages/browser-adapters/chrome', file)), `chrome inventory file exists: ${file}`);
  check(distGraph.P02_PACKED_LAYOUT.core.includes('packages/core/sync-relationship-domains-v2.mjs') &&
    distGraph.P02_PACKED_LAYOUT['browser-adapters/chrome'].includes('packages/browser-adapters/chrome/sync-p02-domain-protocol-state-chrome-v2.mjs'),
  'dist-graph packed layout mirrors the inventory');
  const staged = distGraph.stagePackedGraph();
  try {
    const packedHelper = await staged.importPacked('browser-adapters/chrome/sync-p02-domain-protocol-state-chrome-v2.mjs');
    const packedDomains = await staged.importPacked('core/sync-relationship-domains-v2.mjs');
    check(packedHelper.P02_CHROME_DOMAIN_PROTOCOL_STATE_V2.CHAT_OBJECT_DOMAIN === CHAT_DOMAIN && packedDomains.P02_RELATIONSHIP_DOMAINS_V2.FOLDER.OBJECT_DOMAIN === FOLDER_DOMAIN,
      'packed layout resolves the new modules and their relative imports verbatim');
  } finally {
    staged.dispose();
  }
});

/* ---------------------------------------------------------------------- */
await section('L writer identity, command home and F17 ceiling', async () => {
  const writer = read('apps/studio/desktop/src-tauri/src/sqlite_writer_identity.rs');
  const validateStart = writer.indexOf('fn validate_identity(');
  const validateEnd = writer.indexOf('\nasync fn execute_statement', validateStart);
  const validateBody = writer.slice(validateStart, validateEnd);
  check(validateStart > 0 && validateEnd > validateStart && !validateBody.includes('relationship'), 'generic validate_identity allowlist does not name p02.relationship-apply');
  check(!/const [A-Z_]+: &str = "p02\.relationship-apply"/.test(writer), 'writer-identity module declares no relationship identity constant');
  check(writer.includes("'p02.relationship-apply'") && writer.includes('p02_relationship_apply_identity_bind_passed'), 'F16 installer/proof carry the successor allowlist assertions');
  const command = read('apps/studio/desktop/src-tauri/src/p02_relationship_apply.rs');
  check(command.includes('pub(crate) const P02_RELATIONSHIP_APPLY_IDENTITY: &str = "p02.relationship-apply";'), 'the identity constant lives in the command module');
  check((command.match(/install_writer_identity_function\(conn, P02_RELATIONSHIP_APPLY_IDENTITY\)/g) || []).length === 1, 'exactly one identity installation site');
  check(command.includes('#[serde(deny_unknown_fields)]') && command.includes('BEGIN IMMEDIATE') && command.includes('ROLLBACK') && command.includes('COMMIT'), 'bounded DTO and the BEGIN IMMEDIATE / ROLLBACK / COMMIT model');
  const lib = read('apps/studio/desktop/src-tauri/src/lib.rs');
  check(lib.includes('pub mod p02_relationship_apply;') && (lib.match(/p02_relationship_apply::h2o_p02_relationship_apply,/g) || []).length === 2, 'one mod declaration, registered in both handler variants');
  const rustSources = fs.readdirSync(rel('apps/studio/desktop/src-tauri/src')).filter((f) => f.endsWith('.rs'));
  const installers = rustSources.filter((f) => read('apps/studio/desktop/src-tauri/src', f).includes('P02_RELATIONSHIP_APPLY_IDENTITY)'));
  check(installers.join(',') === 'p02_relationship_apply.rs', `identity installed only by the command module (${installers.join(',')})`);
  check(read('tools/validation/release/validate-f17-build-package.mjs').includes('const EXPECTED_STUDIO_MIGRATION_MAX = 23;') &&
    read('tools/validation/release/validate-f17-migration-rollback.mjs').includes('const EXPECTED_STUDIO_MIGRATION_MAX = 23;'), 'F17 ceilings are 23');
  check(!fs.existsSync(rel('apps/studio/desktop/src-tauri/capabilities')) || fs.readdirSync(rel('apps/studio/desktop/src-tauri/capabilities')).every((f) => !read('apps/studio/desktop/src-tauri/capabilities', f).includes('relationship')),
    'no capability file expansion');
});

/* ---------------------------------------------------------------------- */
const verdict = failures.length === 0 ? 'RELATIONSHIP_SUBSTRATE_PASS' : 'RELATIONSHIP_SUBSTRATE_NOT_READY';
console.log(JSON.stringify({
  schema: 'h2o.studio.p02RelationshipSubstrateValidation.v1',
  mission: 'p02-folder-relationship-synchronization',
  task: 'T01',
  verdict,
  assertions,
  sections,
  failures,
  directionCoverage: 'RELATIONSHIP_SYNC_DIRECTION_COVERAGE=BIDIRECTIONAL',
  liveMutation: 'none (in-memory / temporary fixtures only; no repository, IDB, runtime or canonical database touched)'
}, null, 2));
process.exit(failures.length === 0 ? 0 : 1);
