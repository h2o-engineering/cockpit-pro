#!/usr/bin/env node
// Validator for the M10 P3b production switch.
//
// It drives the REAL production chain end to end —
//   trusted envelope -> client -> composition -> P2 mapper -> facade ->
//   the UNCHANGED Health formatter
// — and pins the two properties the switch exists to guarantee: the eight
// historical false-healthy divergences can no longer read as healthy, and a
// trusted-path failure fails CLOSED with no fallback to the weaker JS verifier.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), '..', '..', '..');
const ING = 'src-surfaces-base/studio/ingestion/';
const MODULES = [
  `${ING}saved-chat-archive-health-mapping.js`,
  `${ING}saved-chat-archive-integrity.tauri.js`,
  `${ING}saved-chat-archive-health-composition.js`,
  `${ING}saved-chat-archive-diagnostics.tauri.js`,
  `${ING}archive-health-ui.studio.js`,
];
const readRepo = (rel) => fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');

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

/* The production chain, with a fake Tauri and a legacy-verifier tripwire. */
function boot({ invoke, store } = {}) {
  const legacyCalls = [];
  const sandbox = { globalThis: {}, console, setTimeout, TextEncoder, TextDecoder };
  sandbox.globalThis.globalThis = sandbox.globalThis;
  sandbox.globalThis.__TAURI_INTERNALS__ = { invoke: invoke || (async () => { throw new Error('no command'); }) };
  vm.createContext(sandbox);
  for (const rel of MODULES) vm.runInContext(readRepo(rel), sandbox, { filename: rel });
  const S = sandbox.globalThis.H2O.Studio;
  if (store) S.store = store;
  /* Tripwire: any fallback to the legacy verifier is recorded, then refused. */
  for (const name of ['validateSavedChatPackageV1', 'listSavedChatArchivePackagesV1']) {
    const original = S.ingestion[name];
    S.ingestion[name] = function (...args) {
      legacyCalls.push(name);
      return original.apply(this, args);
    };
  }
  return { S, legacyCalls };
}

let seq = 0;
const pkg = (over = {}) => ({
  path: `archive/packages/chat_${seq}.h2ochat`, name: `chat_${seq++}.h2ochat`,
  class: 'verified-generation', chatId: 'chat_a', snapshotId: 's0',
  contentHash: 'a'.repeat(64), constructionFamily: 'v3', snapshotEncoding: 'identity',
  savedAt: '2026-01-01T00:00:00.000Z', orderable: true, assetShas: [], blockers: [], ...over,
});
const broken = (reason, code, over = {}) => ({
  path: `archive/packages/broken_${seq}.h2ochat`, name: `broken_${seq++}.h2ochat`,
  class: 'indeterminate', reason, blockers: code ? [{ code }] : [], ...over,
});
const reserved = () => ({ path: 'archive/packages/.h2o-archive.lock', name: '.h2o-archive.lock', class: 'reserved-infrastructure', blockers: [] });
const stray = () => ({ path: 'archive/packages/notes.txt', name: 'notes.txt', class: 'indeterminate', reason: 'not-a-package-name', blockers: [] });
const env = (occupants, over = {}) => ({
  schema: 'h2o.savedChatArchiveIntegrity', schemaVersion: 1, complete: true, blockers: [],
  observed: { byConstructionFamily: { v1: 0, v2: 0, v3: 0 } },
  liveGenerationFamily: 'v3', occupants, ...over,
});

/* A store in which every trusted identity reconciles cleanly, so the baseline
   is genuinely Healthy. Omitting it makes the shared DB helper warn
   `db-api-missing` — exactly as the legacy path does — which is drift, not a
   defect, and is exercised separately below. */
const HEALTHY_STORE = {
  chats: { get: async (id) => ({ id }) },
  snapshots: { get: async () => ({ id: 's0' }), listByChat: async () => [{ snapshotId: 's0' }] },
  assets: { listBySnapshot: async () => [] },
};

/* Run the whole chain and report what the operator would actually see. */
async function operatorView(occupants, over = {}, store = HEALTHY_STORE) {
  const { S, legacyCalls } = boot({ invoke: async () => env(occupants, over), store });
  const result = await S.ingestion.diagnoseSavedChatArchiveV1({});
  const summary = S.archiveHealthUi.formatArchiveHealthSummary(result);
  return { result, summary, pill: summary.pill.label, legacyCalls };
}

console.log('= saved-chat archive health trusted switch (M10 P3b) =');

/* ---------------- §30 end-to-end acceptance ---------------- */

await checkAsync('1-4,13. valid V1/V2/V3-identity/V3-gzip and legacy all read Healthy', async () => {
  const cases = [
    ['V1', pkg({ constructionFamily: 'v1' })],
    ['V2', pkg({ constructionFamily: 'v2' })],
    ['V3 identity', pkg({ constructionFamily: 'v3', snapshotEncoding: 'identity' })],
    ['V3 gzip', pkg({ constructionFamily: 'v3', snapshotEncoding: 'gzip' })],
    ['legacy package', pkg({ class: 'legacy-package', constructionFamily: 'v1' })],
  ];
  for (const [label, occupant] of cases) {
    const view = await operatorView([occupant]);
    assert.equal(view.pill, 'Healthy', label);
    assert.equal(view.result.status, 'ok', label);
    assert.equal(view.result.packages[0].status, 'ok', label);
    assert.deepEqual(view.legacyCalls, [], `${label}: no legacy verifier call`);
  }
});

await checkAsync('5. all eight false-healthy divergence families are non-healthy', async () => {
  const families = [
    ['v3 persistent renderer forbidden', 'corrupt', 'generation-v3-persistent-renderer-forbidden'],
    ['v1 non-empty assets', 'corrupt', 'generation-manifest-assets-invalid'],
    ['v3 invalid manifest file inventory', 'corrupt', 'generation-v3-manifest-file-inventory-invalid'],
    ['absent chatId', 'corrupt', 'generation-manifest-chat-id-missing'],
    ['v3 legacy content forbidden', 'corrupt', 'generation-v3-snapshot-legacy-content-forbidden'],
    ['v3 messages non-array', 'corrupt', 'generation-v3-snapshot-messages-invalid'],
    ['unexpected persistent member', 'corrupt', 'generation-package-unexpected-member'],
    ['duplicate asset sha', 'identity-mismatch', 'generation-manifest-asset-duplicate-sha'],
  ];
  for (const [label, reason, code] of families) {
    const alone = await operatorView([broken(reason, code)]);
    assert.equal(alone.pill, 'Integrity problems', `${label}: alone`);
    assert.equal(alone.result.status, 'blocked', label);
    assert.equal(alone.result.packages[0].blockers[0].code, code, `${label}: exact code surfaces`);
    assert.ok(alone.result.packages[0].blockers[0].message.length > 0, `${label}: explained`);

    const mixed = await operatorView([pkg(), broken(reason, code)]);
    assert.equal(mixed.pill, 'Mixed', `${label}: mixed with a valid package`);
    assert.equal(mixed.result.status, 'partial', label);

    for (const view of [alone, mixed]) {
      assert.notEqual(view.pill, 'Healthy', `${label} must never read Healthy`);
      assert.notEqual(view.pill, 'Healthy with drift', `${label} must never read drift-only`);
      assert.deepEqual(view.legacyCalls, [], `${label}: no legacy verifier call`);
    }
  }
});

await checkAsync('6. complete=false reads Partial scan, never Empty', async () => {
  const view = await operatorView([pkg()], { complete: false, blockers: ['package-scan-entry-unrepresentable'] });
  assert.equal(view.pill, 'Partial scan');
  assert.equal(view.result.complete, false);
  assert.equal(view.result.blockers[0].code, 'package-scan-entry-unrepresentable');
  // Even an incomplete EMPTY scan must not claim absence.
  const emptyish = await operatorView([], { complete: false });
  assert.equal(emptyish.pill, 'Partial scan');
});

await checkAsync('7,8. ReservedInfrastructure is hidden — Empty alone, no extra warning beside a package', async () => {
  const only = await operatorView([reserved()]);
  assert.equal(only.pill, 'Empty');
  assert.equal(only.result.packages.length, 0, 'infrastructure is never a package row');
  assert.equal(only.result.warnings.length, 0, 'and raises no warning');

  const beside = await operatorView([pkg(), reserved()]);
  assert.equal(beside.pill, 'Healthy', 'infrastructure adds no drift');
  assert.equal(beside.result.counts.packagesTotal, 1);
});

await checkAsync('9,10. a stray non-package is archive drift, and Empty still wins alone', async () => {
  assert.equal((await operatorView([stray()])).pill, 'Empty');
  const withPackage = await operatorView([pkg(), stray()]);
  assert.equal(withPackage.pill, 'Healthy with drift');
  assert.equal(withPackage.result.warnings.length, 1);
});

await checkAsync('11,12. DB drift on all reads drift; on some reads Mixed', async () => {
  const two = [pkg({ path: 'p/1', chatId: 'chat_a' }), pkg({ path: 'p/2', chatId: 'chat_b' })];
  const storeMissingAll = { chats: { get: async () => null }, snapshots: { get: async () => ({ id: 's0' }), listByChat: async () => [] }, assets: { listBySnapshot: async () => [] } };
  const all = await operatorView(two, {}, storeMissingAll);
  assert.equal(all.pill, 'Healthy with drift');
  assert.equal(all.result.counts.packagesWarning, 2);

  const storeMissingOne = {
    chats: { get: async (id) => (id === 'chat_a' ? null : { id }) },
    snapshots: { get: async () => ({ id: 's0' }), listByChat: async () => [] },
    assets: { listBySnapshot: async () => [] },
  };
  const some = await operatorView(two, {}, storeMissingOne);
  assert.equal(some.pill, 'Mixed');
  assert.equal(some.result.counts.packagesWarning, 1);
  // Drift is never corruption.
  assert.equal(some.result.counts.packagesBlocked, 0);
});

await checkAsync('an unavailable store is DRIFT, exactly as the legacy path reported it', async () => {
  const view = await operatorView([pkg()], {}, null);
  assert.equal(view.pill, 'Healthy with drift', 'db-api-missing is drift, never corruption');
  assert.equal(view.result.counts.packagesBlocked, 0);
  assert.deepEqual(view.legacyCalls, []);
});

await checkAsync('14. an unknown future blocker stays non-healthy, explained, code intact', async () => {
  const view = await operatorView([broken('corrupt', 'generation-future-rule-nobody-wrote-yet')]);
  assert.equal(view.pill, 'Integrity problems');
  const blocker = view.result.packages[0].blockers[0];
  assert.equal(blocker.code, 'generation-future-rule-nobody-wrote-yet', 'verbatim');
  assert.match(blocker.message, /Trusted verification refused this package/i);
});

/* ---------------- §29 failure injection ---------------- */

await checkAsync('A-D. every trusted-path failure fails CLOSED with no legacy fallback', async () => {
  const cases = [
    ['A. transport unavailable', { invoke: null, strip: true }],
    ['B. native command Err', { invoke: async () => { throw new Error('native boom'); } }],
    ['C. schema mismatch', { invoke: async () => env([pkg()], { schema: 'h2o.other' }) }],
    ['C. version unsupported', { invoke: async () => env([pkg()], { schemaVersion: 9 }) }],
    ['D. mapper contract error', { invoke: async () => env([{ path: 'p/1', class: 'brand-new-class' }]) }],
    ['D. malformed envelope', { invoke: async () => env([{ class: 'verified-generation' }]) }],
  ];
  for (const [label, spec] of cases) {
    const booted = boot({ invoke: spec.invoke || undefined });
    if (spec.strip) delete booted.S.ingestion.readSavedChatArchiveIntegrityV1;
    await assert.rejects(
      () => booted.S.ingestion.diagnoseSavedChatArchiveV1({}),
      label,
    );
    assert.deepEqual(booted.legacyCalls, [], `${label}: the legacy verifier must NOT be invoked`);
  }
});

await checkAsync('a rejected facade reaches the EXISTING Health error lifecycle', async () => {
  const { S } = boot({ invoke: async () => { throw new Error('native boom'); } });
  let caught = null;
  try { await S.ingestion.diagnoseSavedChatArchiveV1({}); } catch (err) { caught = err; }
  assert.ok(caught, 'the facade rejects');
  // The unchanged UI catches a rejection and shows its existing error copy.
  const ui = readRepo(`${ING}archive-health-ui.studio.js`);
  assert.ok(ui.includes('Could not run archive diagnostics.'), 'existing error copy is unchanged');
  assert.ok(/catch\s*\(/.test(ui), 'the UI still catches diagnostic rejection');
  // And no seventh state was introduced.
  assert.ok(!ui.includes('trusted-unavailable'), 'no new archive-health state');
});

await checkAsync('E. complete=false is a SUCCESSFUL result, not a lifecycle error', async () => {
  const { S } = boot({ invoke: async () => env([pkg()], { complete: false }) });
  const result = await S.ingestion.diagnoseSavedChatArchiveV1({});
  assert.equal(result.complete, false);
  assert.equal(S.archiveHealthUi.formatArchiveHealthSummary(result).pill.label, 'Partial scan');
});

/* ---------------- §14 metric correction ---------------- */

await checkAsync('19-21. retired metrics are absent, and unavailable is never zero', async () => {
  const view = await operatorView([pkg(), broken('corrupt', 'generation-v3-gzip-decode-failed')]);
  const counts = view.result.counts;

  /* A/B. The two approximate integrity metrics are RETIRED — not zeroed. The
     canonical verifier is fail-fast, so no exact broken-asset total exists, and
     the old mismatch count conflated integrity with renderer hygiene. */
  for (const retired of ['brokenPackageAssets', 'assetRefMismatches']) {
    assert.ok(!(retired in counts), `${retired} must not be emitted at all`);
    assert.notEqual(counts[retired], 0, `${retired} must never appear as a measured zero`);
  }
  /* C. Renderer hygiene is PERFORMED as of P3.5b, but this harness installs no
     observer, so it must still state unobserved rather than a clean 0 — the
     same absent-is-not-zero rule, now expressed by its own availability fields
     instead of the retired P3.5 deferral marker. */
  assert.ok(!('dataImageResidue' in counts), 'dataImageResidue must not be emitted as a count');
  assert.equal(view.result.rendererHygiene.observed, false, 'availability is explicit');
  assert.equal(view.result.rendererHygiene.attempted, false, 'no observer installed here');
  assert.equal(view.result.rendererHygiene.deferredTo, undefined, 'the P3.5 deferral is retired');
  assert.ok(!('dataImageResidue' in view.result.rendererHygiene),
    'an unobserved hygiene run publishes no finding count');
  /* And the per-package buckets are absent, not empty. */
  for (const p of view.result.packages) {
    for (const field of ['dataImageResidue', 'assetRefMismatches', 'rendererAssetRefMismatches']) {
      assert.ok(!(field in p.assetChecks), `package.assetChecks.${field} must be absent, not zero`);
    }
  }
  /* What SURVIVES: the trusted blocked count and the per-package rule. */
  assert.equal(counts.packagesBlocked, 1);
  const blockedRow = view.result.packages.find((p) => p.status === 'blocked');
  assert.equal(blockedRow.blockers[0].code, 'generation-v3-gzip-decode-failed');
  assert.ok(blockedRow.blockers[0].message.length > 0, 'F. explanation remains visible');
});

await checkAsync('C/D. unobserved renderer hygiene has ZERO aggregate-state effect', async () => {
  /* Unobserved is not drift, and it is not healthy evidence either — it simply
     does not participate. A trusted-valid package stays exactly Healthy. */
  const valid = await operatorView([pkg()]);
  assert.equal(valid.pill, 'Healthy', 'hygiene absence cannot create drift');
  assert.equal(valid.result.packages[0].status, 'ok', 'nor make a valid package blocked');
  assert.equal(valid.result.rendererHygiene.observed, false);

  /* E. A trusted-invalid package is blocked purely by trusted class/reason. */
  const invalid = await operatorView([broken('corrupt', 'generation-v3-snapshot-messages-invalid')]);
  assert.equal(invalid.pill, 'Integrity problems');
  assert.equal(invalid.result.packages[0].status, 'blocked');
  assert.equal(invalid.result.counts.packagesBlocked, 1);

  /* And the aggregate is identical whether or not hygiene would have had
     something to say — because nothing measured it. */
  assert.equal(
    (await operatorView([pkg(), pkg()])).pill,
    'Healthy',
    'two valid packages remain Healthy with hygiene unobserved',
  );
});

/* ---------------- §35 no dual authority ---------------- */

check('§35 the production Health path contains no dual-authority pattern', () => {
  const diagnostics = readRepo(`${ING}saved-chat-archive-diagnostics.tauri.js`);
  const facade = diagnostics.slice(diagnostics.indexOf('async function diagnoseSavedChatArchiveV1'));
  const body = facade.slice(0, facade.indexOf('\n  }\n') + 4);
  // The legacy AUTHORITY must be unreachable from the facade. `||` is excluded
  // deliberately: it appears only as a default for a missing count/map, which is
  // not a second opinion about package validity.
  for (const forbidden of [
    'validateSavedChatPackageV1', 'listSavedChatArchivePackagesV1', 'validateSavedChatPackageBytesV1',
    'shallowPackageEntry', 'verifyV3SnapshotDescriptor', 'verifyLegacyRendererDescriptors',
  ]) {
    assert.ok(!body.includes(forbidden), `the facade body must not contain \`${forbidden}\``);
  }
  // No try/catch that could swallow a trusted failure into a legacy verdict.
  assert.ok(!/\btry\s*\{/.test(body), 'the facade body must not catch its own trusted failure');
  for (const pattern of [/trusted\w*\s*\|\|\s*legacy/i, /catch[\s\S]{0,120}legacy/i, /fallback/i]) {
    assert.ok(!pattern.test(body), `no dual-authority pattern: ${pattern}`);
  }
  const composition = readRepo(`${ING}saved-chat-archive-health-composition.js`);
  for (const forbidden of ['validateSavedChatPackageV1', 'listSavedChatArchivePackagesV1']) {
    assert.ok(!composition.includes(forbidden), `the composition must not reach the legacy verifier`);
  }
});

/* M10 P3.5a superseded this: Coverage and the Inspector are now trusted too.
   They still read the trusted envelope DIRECTLY rather than through the Health
   facade, which is what keeps Health's aggregation out of their answers. */
check('P3.5a: coverage and the Inspector are trusted, and bypass the Health facade', () => {
  for (const rel of [`${ING}saved-chat-coverage.tauri.js`, `${ING}saved-chat-archive-inspector.studio.js`]) {
    const src = readRepo(rel);
    assert.ok(src.includes('readSavedChatArchiveIntegrityV1'), `${rel} reads trusted integrity`);
    assert.ok(!src.includes('validateSavedChatPackageV1'), `${rel} no longer uses the legacy validator`);
    assert.ok(!src.includes('composeSavedChatArchiveHealthV1'), `${rel} must not route through the Health facade`);
    assert.ok(!src.includes('diagnoseSavedChatArchiveV1'), `${rel} must not route through the Health facade`);
  }
});

console.log('');
if (FAIL.length) {
  console.log(`[saved-chat-archive-health-trusted-switch] ${FAIL.length} failed, ${PASS.length} passed`);
  process.exit(1);
}
console.log(`[saved-chat-archive-health-trusted-switch] all ${PASS.length} checks passed`);
