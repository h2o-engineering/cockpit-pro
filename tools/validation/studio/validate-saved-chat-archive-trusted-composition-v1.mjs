#!/usr/bin/env node
// Validator for the M10 P3a trusted Archive Health preparation.
//
// P3a is UNWIRED preparation: the trusted client and the composition exist and
// are proven, but `diagnoseSavedChatArchiveV1` still runs the legacy path. This
// validator pins the client's fail-closed transport contract, the composition's
// separate-observation rules, and the fact that nothing is wired yet.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), '..', '..', '..');
const ING = 'src-surfaces-base/studio/ingestion/';
const CLIENT_REL = `${ING}saved-chat-archive-integrity.tauri.js`;
const COMPOSITION_REL = `${ING}saved-chat-archive-health-composition.js`;
const MAPPER_REL = `${ING}saved-chat-archive-health-mapping.js`;
const DIAGNOSTICS_REL = `${ING}saved-chat-archive-diagnostics.tauri.js`;
const COVERAGE_REL = `${ING}saved-chat-coverage.tauri.js`;
const INSPECTOR_REL = `${ING}saved-chat-archive-inspector.studio.js`;
const PACK_REL = 'tools/product/studio/pack-studio.mjs';
const HEALTH_UI_REL = `${ING}archive-health-ui.studio.js`;

const readRepo = (rel) => fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');

/* Values produced inside the vm realm carry that realm's prototypes, so strict
   deepEqual fails on structurally identical data. Compare by value. */
const sameValue = (actual, expected, message) =>
  assert.equal(JSON.stringify(actual), JSON.stringify(expected), message);

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

/* Load client + composition + mapper into one sandbox with a fake Tauri. */
function load({ invoke } = {}) {
  const sandbox = { globalThis: {}, console };
  sandbox.globalThis.globalThis = sandbox.globalThis;
  if (invoke) sandbox.globalThis.__TAURI_INTERNALS__ = { invoke };
  vm.createContext(sandbox);
  for (const rel of [MAPPER_REL, CLIENT_REL, COMPOSITION_REL]) {
    vm.runInContext(readRepo(rel), sandbox, { filename: rel });
  }
  return sandbox.globalThis.H2O.Studio;
}

let seq = 0;
const verified = (over = {}) => ({
  path: `archive/packages/chat_${seq++}.h2ochat`, name: `chat_${seq}.h2ochat`,
  class: 'verified-generation', chatId: 'chat_a', snapshotId: 's0',
  contentHash: 'a'.repeat(64), constructionFamily: 'v3', snapshotEncoding: 'identity',
  savedAt: '2026-01-01T00:00:00.000Z', orderable: true, assetShas: [], blockers: [], ...over,
});
const envelope = (over = {}) => ({
  schema: 'h2o.savedChatArchiveIntegrity', schemaVersion: 1,
  complete: true, blockers: [],
  observed: { byConstructionFamily: { v1: 0, v2: 0, v3: 1 } },
  liveGenerationFamily: 'v3', occupants: [verified()], ...over,
});

console.log('= saved-chat trusted archive health composition (M10 P3a) =');

/* ---------------- A. trusted client ---------------- */

await checkAsync('the client calls the real command and accepts the exact schema/version', async () => {
  const calls = [];
  const S = load({ invoke: async (cmd, args) => { calls.push([cmd, args]); return envelope(); } });
  const out = await S.ingestion.readSavedChatArchiveIntegrityV1();
  sameValue(calls, [['h2o_saved_chat_archive_integrity', null]], 'exact command, no renderer args');
  assert.equal(out.schema, 'h2o.savedChatArchiveIntegrity');
  assert.equal(out.schemaVersion, 1);
  const contract = S.ingestion.SAVED_CHAT_ARCHIVE_INTEGRITY_CONTRACT;
  assert.equal(contract.command, 'h2o_saved_chat_archive_integrity');
  assert.equal(contract.schema, 'h2o.savedChatArchiveIntegrity');
  assert.equal(contract.schemaVersion, 1);
});

await checkAsync('the client fails closed on every transport/contract failure', async () => {
  const C = load({ invoke: async () => envelope() }).ingestion.SAVED_CHAT_ARCHIVE_INTEGRITY_CODES;
  const cases = [
    ['transport absent', undefined, C.TRANSPORT_UNAVAILABLE],
    ['command Err', async () => { throw new Error('native boom'); }, C.COMMAND_FAILED],
    ['not an object', async () => 'nope', C.ENVELOPE_MALFORMED],
    ['schema mismatch', async () => envelope({ schema: 'h2o.somethingElse' }), C.SCHEMA_MISMATCH],
    ['version unsupported', async () => envelope({ schemaVersion: 2 }), C.SCHEMA_VERSION_UNSUPPORTED],
    ['complete missing', async () => { const e = envelope(); delete e.complete; return e; }, C.ENVELOPE_INCOMPLETE],
    ['complete non-boolean', async () => envelope({ complete: 'yes' }), C.ENVELOPE_INCOMPLETE],
    ['occupants not array', async () => envelope({ occupants: {} }), C.ENVELOPE_MALFORMED],
    ['blockers not array', async () => envelope({ blockers: null }), C.ENVELOPE_MALFORMED],
    ['occupant without class', async () => envelope({ occupants: [{ path: 'p/1' }] }), C.ENVELOPE_MALFORMED],
    ['occupant without path', async () => envelope({ occupants: [{ class: 'verified-generation' }] }), C.ENVELOPE_MALFORMED],
  ];
  for (const [label, invoke, code] of cases) {
    const S = load(invoke ? { invoke } : {});
    await assert.rejects(
      () => S.ingestion.readSavedChatArchiveIntegrityV1(),
      (err) => { assert.equal(err.code, code, `${label}: expected ${code}, got ${err.code}`); return true; },
      label,
    );
  }
});

await checkAsync('complete=false is a VALID trusted envelope, not a client failure', async () => {
  const S = load({ invoke: async () => envelope({ complete: false, blockers: ['package-scan-entry-unrepresentable'] }) });
  const out = await S.ingestion.readSavedChatArchiveIntegrityV1();
  assert.equal(out.complete, false, 'returned, never thrown');
  const composed = await S.ingestion.composeSavedChatArchiveHealthV1({});
  assert.equal(composed.model.aggregateState, 'partial-scan');
});

check('the client holds no verification, package-byte or filesystem authority', () => {
  const src = readRepo(CLIENT_REL);
  const code = src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
  for (const forbidden of [
    'sha256', 'createHash', 'crypto.', 'JSON.parse', 'readFile', 'readDir', 'readBinaryFile',
    'validateSavedChatPackageV1', 'listSavedChatArchivePackagesV1', 'manifest.json', 'snapshot.json',
    'gzip', 'pako', 'inflate', 'DecompressionStream',
  ]) {
    assert.ok(!code.includes(forbidden), `the client must not contain \`${forbidden}\``);
  }
  // Exactly one public read method, no mutation partner.
  assert.ok(code.includes('H2O.Studio.ingestion.readSavedChatArchiveIntegrityV1 ='));
  for (const forbidden of ['write', 'repair', 'delete', 'quarantine', 'reclaim']) {
    assert.ok(!code.toLowerCase().includes(forbidden), `no mutation surface: ${forbidden}`);
  }
});

/* ---------------- B. composition ---------------- */

await checkAsync('the composition consumes the trusted client and the P2 mapper', async () => {
  const S = load({ invoke: async () => envelope() });
  const out = await S.ingestion.composeSavedChatArchiveHealthV1({});
  assert.equal(out.model.aggregateState, 'healthy');
  assert.equal(out.integrity.schema, 'h2o.savedChatArchiveIntegrity');
  assert.equal(out.model.packageRows.length, 1);
});

await checkAsync('DB drift reconciles the TRUSTED identity and only adds warnings', async () => {
  const seen = [];
  const S = load({
    invoke: async () => envelope({
      occupants: [verified({ path: 'p/1', chatId: 'chat_a', snapshotId: 's0', assetShas: ['sha256-aa'] })],
    }),
  });
  const out = await S.ingestion.composeSavedChatArchiveHealthV1({
    dbDrift: async (identity) => {
      seen.push(identity);
      return { dbChecks: { checked: true, chatExists: false }, warnings: [{ code: 'missing-db-chat', message: 'package chatId has no DB chat row' }] };
    },
    casPresence: null,
  });
  sameValue(seen, [{ chatId: 'chat_a', snapshotId: 's0', assetShas: ['sha256-aa'] }],
    'bound to the trusted identity, including trusted assetShas');
  // Drift degrades presentation to warning/drift but never to blocked.
  assert.equal(out.model.packageRows[0].status, 'warning');
  assert.equal(out.model.aggregateState, 'healthy-with-drift');
  assert.equal(out.dbChecksByPath['p/1'].chatExists, false);
});

await checkAsync('live CAS presence uses the trusted assetShas and stays drift-only', async () => {
  const seen = [];
  const S = load({ invoke: async () => envelope({ occupants: [verified({ path: 'p/1', assetShas: ['sha256-aa', 'sha256-bb'] })] }) });
  const out = await S.ingestion.composeSavedChatArchiveHealthV1({
    dbDrift: null,
    casPresence: async (assets) => {
      seen.push(assets);
      return { checked: true, available: true, warnings: [{ issue: { code: 'live-cas-missing-package-portable', message: 'live CAS asset is missing' } }] };
    },
  });
  sameValue(seen, [[{ sha256: 'sha256-aa' }, { sha256: 'sha256-bb' }]], 'trusted SHAs only');
  assert.equal(out.model.packageRows[0].status, 'warning', 'drift, never blocked');
  assert.equal(out.model.aggregateState, 'healthy-with-drift');
});

await checkAsync('the renderer family rule is enforced', async () => {
  const observed = [];
  const rendererDetail = async (row) => { observed.push(row.constructionFamily + ':' + row.packagePath); return { warnings: [] }; };
  const S = load({
    invoke: async () => envelope({
      occupants: [
        verified({ path: 'v3/1', constructionFamily: 'v3' }),
        verified({ path: 'v1/1', constructionFamily: 'v1' }),
        verified({ path: 'v2/1', class: 'legacy-package', constructionFamily: 'v2' }),
        { path: 'bad/1', name: 'bad', class: 'indeterminate', reason: 'corrupt', blockers: [{ code: 'generation-v3-gzip-decode-failed' }] },
      ],
    }),
  });
  await S.ingestion.composeSavedChatArchiveHealthV1({ dbDrift: null, casPresence: null, rendererDetail });
  sameValue(observed.sort(), ['v1:v1/1', 'v2:v2/1'],
    'V3 skipped (persistent renderers forbidden); indeterminate skipped (already refused)');
});

await checkAsync('a renderer read that fails becomes inconclusive DETAIL, never a verdict', async () => {
  const S = load({ invoke: async () => envelope({ occupants: [verified({ path: 'v1/1', constructionFamily: 'v1' })] }) });
  const out = await S.ingestion.composeSavedChatArchiveHealthV1({
    dbDrift: null, casPresence: null,
    rendererDetail: async () => { throw new Error('package vanished mid-observation'); },
  });
  assert.equal(out.detailByPath['v1/1'].renderer.inconclusive, true);
  assert.equal(out.model.aggregateState, 'healthy', 'trusted classification is not downgraded');
  assert.equal(out.model.packageRows[0].status, 'ok');
});

await checkAsync('a trusted failure PROPAGATES — there is no fallback', async () => {
  const S = load({ invoke: async () => { throw new Error('native boom'); } });
  await assert.rejects(() => S.ingestion.composeSavedChatArchiveHealthV1({}), /integrity-client-command-failed/);
  // A mapper contract error propagates too.
  const S2 = load({ invoke: async () => envelope({ occupants: [{ path: 'p/1', class: 'brand-new-class' }] }) });
  await assert.rejects(() => S2.ingestion.composeSavedChatArchiveHealthV1({}), /unrecognised trusted occupant class/);
});

check('the composition contains no fallback and no verification authority', () => {
  const src = readRepo(COMPOSITION_REL);
  const code = src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
  for (const forbidden of [
    'validateSavedChatPackageV1', 'listSavedChatArchivePackagesV1', 'diagnoseSavedChatArchiveV1',
    'createHash', 'crypto.', 'sha256Hex', 'sha256(', 'JSON.parse', 'pako', 'inflate',
    'DecompressionStream', 'readFile', 'readDir', 'readBinaryFile',
    'formatStale', 'FormatStale', 'catch (fallback', '|| legacy', 'legacyResult',
  ]) {
    assert.ok(!code.includes(forbidden), `the composition must not contain \`${forbidden}\``);
  }
});

/* ---------------- C. assetShas wire ---------------- */

check('assetShas is a trusted projection, present only where canonical', () => {
  const rust = readRepo('apps/studio/desktop/src-tauri/src/saved_chat_archive_integrity.rs');
  assert.ok(/pub asset_shas: Option<Vec<String>>,/.test(rust), 'optional trusted projection');
  assert.ok(rust.includes('asset_shas: Some(package.asset_shas.clone())'), 'projected from the verified package');
  assert.ok(rust.includes('asset_shas: None'), 'absent for non-package occupants');
  // No asset path/ext/mime inflation was added to the wire.
  for (const forbidden of ['asset_paths', 'asset_ext', 'asset_mime', 'asset_descriptors']) {
    assert.ok(!rust.includes(forbidden), `no wire inflation: ${forbidden}`);
  }
  // And the scanner was NOT changed to produce it.
  const scan = readRepo('apps/studio/desktop/src-tauri/src/archive_package_scan.rs');
  assert.ok(scan.includes('pub asset_shas: Vec<String>,'), 'the trusted source already existed');
});

/* ---------------- D. P3a remains unwired ---------------- */

check('P3b: the facade is WIRED to the trusted chain, and only to it', () => {
  const diagnostics = readRepo(DIAGNOSTICS_REL);
  assert.ok(
    diagnostics.includes('composeSavedChatArchiveHealthV1'),
    'the facade consumes the composition',
  );
  /* The Health UI itself is deliberately NOT repointed: it still calls the same
     facade entry point, which is what keeps the switch reversible by revert. */
  const healthUi = readRepo(HEALTH_UI_REL);
  assert.ok(healthUi.includes('diagnoseSavedChatArchiveV1'), 'Health still calls the same facade');
  assert.ok(!healthUi.includes('composeSavedChatArchiveHealthV1'), 'Health is not rewired around the facade');
  /* M10 P3.5a: Coverage and the Inspector are now trusted as well, reading the
     envelope directly instead of through this facade. */
  for (const rel of [COVERAGE_REL, INSPECTOR_REL]) {
    const src = readRepo(rel);
    assert.ok(src.includes('readSavedChatArchiveIntegrityV1'), `${rel} reads trusted integrity`);
    assert.ok(!src.includes('validateSavedChatPackageV1'), `${rel} no longer uses the legacy validator`);
    assert.ok(!src.includes('composeSavedChatArchiveHealthV1'), `${rel} must not route through the Health facade`);
  }
});

/* M10 P3.4B: packing a module is not loading it. The Desktop frontend executes
   studio.html, so the trusted chain must be declared there in dependency order —
   otherwise `composeSavedChatArchiveHealthV1` never registers and the trusted
   facade fails at runtime with "the trusted composition is unavailable". */
check('studio.html loads the trusted chain in strict dependency order', () => {
  const html = readRepo('src-surfaces-base/studio/studio.html');
  const ORDER = [
    'saved-chat-archive-integrity.tauri.js',
    'saved-chat-archive-health-mapping.js',
    'saved-chat-archive-health-composition.js',
    'saved-chat-archive-diagnostics.tauri.js',
    'archive-health-ui.studio.js',
  ];
  const positions = ORDER.map((file) => {
    const tag = `<script src="./ingestion/${file}"></script>`;
    const occurrences = html.split(tag).length - 1;
    assert.equal(occurrences, 1, `${file} must be declared exactly once`);
    return { file, at: html.indexOf(tag) };
  });
  for (let i = 1; i < positions.length; i += 1) {
    assert.ok(
      positions[i - 1].at < positions[i].at,
      `${positions[i - 1].file} must load before ${positions[i].file}`,
    );
  }
  /* No loader system, no dynamic import — plain ordered script tags only. */
  for (const forbidden of ['import(', 'System.import', 'requirejs', 'defer', 'async src']) {
    for (const { file } of positions) {
      const line = html.split('\n').find((l) => l.includes(`ingestion/${file}"`)) || '';
      assert.ok(!line.includes(forbidden), `${file} must be a plain ordered script tag`);
    }
  }
  /* Each one is also in the pack manifest, so the tag resolves in the bundle. */
  const pack = readRepo(PACK_REL);
  for (const { file } of positions) {
    assert.ok(pack.includes(`"ingestion/${file}"`), `${file} must be packed`);
  }
  /* And the facade resolves the composition lazily, AFTER registration. */
  const diagnostics = readRepo(DIAGNOSTICS_REL);
  assert.ok(
    diagnostics.includes('H2O.Studio.ingestion.composeSavedChatArchiveHealthV1'),
    'the facade resolves the composition from the namespace at call time',
  );
  /* The legacy validator still EXISTS in this module for coverage/Inspector
     (P3.5 owns their migration), so scope the no-fallback check to the facade
     body itself. */
  const facade = diagnostics.slice(diagnostics.indexOf('async function diagnoseSavedChatArchiveV1'));
  const body = facade.slice(0, facade.indexOf('\n  }\n') + 4);
  for (const forbidden of ['validateSavedChatPackageV1', 'listSavedChatArchivePackagesV1', 'try {']) {
    assert.ok(!body.includes(forbidden), `the facade body must not contain \`${forbidden}\``);
  }
});

check('the extracted observation helpers are shared, not duplicated', () => {
  const diagnostics = readRepo(DIAGNOSTICS_REL);
  assert.ok(diagnostics.includes('async function dbDriftForIdentity('), 'DB drift extracted');
  assert.ok(diagnostics.includes('async function liveCasPresenceForShas('), 'CAS presence extracted');
  assert.ok(diagnostics.includes('H2O.Studio.ingestion.dbDriftForIdentityV1 = dbDriftForIdentity;'));
  assert.ok(diagnostics.includes('H2O.Studio.ingestion.liveCasPresenceForShasV1 = liveCasPresenceForShas;'));
  /* M10 P4 deleted the legacy verifier that used to wrap these, so there is no
     second caller left to delegate. What still matters is that exactly ONE
     implementation of each exists — the extraction must not have left a copy
     behind when the wrapper went. */
  assert.equal((diagnostics.match(/function dbDriftForIdentity\(/g) || []).length, 1,
    'exactly one DB-drift implementation');
  assert.equal((diagnostics.match(/function liveCasPresenceForShas\(/g) || []).length, 1,
    'exactly one live-CAS presence implementation');
});

console.log('');
if (FAIL.length) {
  console.log(`[saved-chat-archive-trusted-composition] ${FAIL.length} failed, ${PASS.length} passed`);
  process.exit(1);
}
console.log(`[saved-chat-archive-trusted-composition] all ${PASS.length} checks passed`);
