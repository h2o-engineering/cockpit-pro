#!/usr/bin/env node
// Validator for the M10 P2 trusted-to-operator health mapping.
//
// P2 adds PRESENTATION logic only. This validator pins that boundary: exactly
// six operator states, completeness first, the package/stray/infrastructure
// partition, deterministic precedence, an unknown blocker that stays visible
// and non-healthy, and — critically — no path by which an unrecognised input
// can borrow healthy copy.
//
// It does NOT re-test the Rust trusted wire (that is the P1 contract
// validator's job) and it does NOT test production Health behaviour, which P2
// deliberately leaves untouched.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), '..', '..', '..');

const ING = 'src-surfaces-base/studio/ingestion/';
const MAPPER_REL = 'src-surfaces-base/studio/ingestion/saved-chat-archive-health-mapping.js';
const PACK_REL = 'tools/product/studio/pack-studio.mjs';
const HEALTH_UI_REL = 'src-surfaces-base/studio/ingestion/archive-health-ui.studio.js';
const DIAGNOSTICS_REL = 'src-surfaces-base/studio/ingestion/saved-chat-archive-diagnostics.tauri.js';
const STUDIO_JS_REL = 'src-surfaces-base/studio/studio.js';

const readRepo = (rel) => fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');

const PASS = [];
const FAIL = [];
function check(label, fn) {
  try { fn(); PASS.push(label); console.log(`  ✓ ${label}`); }
  catch (e) { const m = e && e.message ? e.message : String(e); FAIL.push({ label, m }); console.log(`  ✗ ${label}`); console.log(`      ${m}`); }
}

/* Load the module the way the runtime does: an IIFE onto a global. */
const source = readRepo(MAPPER_REL);
const sandbox = { globalThis: {} };
sandbox.globalThis.globalThis = sandbox.globalThis;
vm.createContext(sandbox);
vm.runInContext(source, sandbox, { filename: MAPPER_REL });
const M = sandbox.globalThis.H2O.Studio.archiveHealthMapping;
const S = M.AGGREGATE_STATES;

/* Source with comments removed. The module's own prose deliberately NAMES the
   concepts it refuses (`stale`, `unknown`, gzip handling, …) in order to
   disclaim them, so an authority check must read the code, not the commentary. */
const CODE_ONLY = source
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/^\s*\/\/.*$/gm, ' ');

/* ---------- fixture helpers ---------- */
let seq = 0;
const verified = (over = {}) => ({
  path: `archive/packages/chat_${seq}.g${'a'.repeat(64)}.h2ochat`,
  name: `chat_${seq++}.g.h2ochat`,
  class: 'verified-generation',
  chatId: 'chat_a', snapshotId: 's0', contentHash: 'a'.repeat(64),
  constructionFamily: 'v3', snapshotEncoding: 'identity',
  savedAt: '2026-01-01T00:00:00.000Z', orderable: true, blockers: [],
  ...over,
});
const legacy = (over = {}) => verified({ class: 'legacy-package', constructionFamily: 'v1', ...over });
const indeterminate = (reason, blockers = [], over = {}) => ({
  path: `archive/packages/broken_${seq}.h2ochat`,
  name: `broken_${seq++}.h2ochat`,
  class: 'indeterminate',
  reason,
  blockers: blockers.map((code) => ({ code })),
  ...over,
});
const reserved = (over = {}) => ({
  path: 'archive/packages/.h2o-archive.lock', name: '.h2o-archive.lock',
  class: 'reserved-infrastructure', blockers: [], ...over,
});
const envelope = (complete, occupants, blockers = []) => ({
  schema: 'h2o.savedChatArchiveIntegrity', schemaVersion: 1,
  complete, blockers,
  observed: { byConstructionFamily: { v1: 0, v2: 0, v3: 0 } },
  liveGenerationFamily: 'v3',
  occupants,
});
const mapState = (integrity, presentation) =>
  M.mapArchiveHealth({ integrity, presentation }).aggregateState;

console.log('= saved-chat archive health mapping (M10 P2) =');

check('exactly six aggregate states exist, and no seventh', () => {
  assert.deepEqual([...M.ALL_STATES].sort(), [
    'empty', 'healthy', 'healthy-with-drift', 'integrity-problems', 'mixed', 'partial-scan',
  ]);
  assert.equal(M.ALL_STATES.length, 6);
  for (const forbidden of ['unknown', 'degraded', 'warning', 'critical', 'repair-needed', 'ok']) {
    assert.ok(!M.ALL_STATES.includes(forbidden), `no ${forbidden} state`);
  }
  // And no seventh key hides in the source.
  const keys = [...source.matchAll(/^\s*([A-Z_]+): '([a-z-]+)',$/gm)].map((m) => m[2]);
  assert.deepEqual([...new Set(keys)].sort(), [...M.ALL_STATES].sort());
});

check('completeness comes FIRST and overrides every other signal', () => {
  // 1. incomplete + observed occupants -> partial-scan
  assert.equal(mapState(envelope(false, [verified()])), S.PARTIAL_SCAN);
  // 16. an archive blocker with complete=false is partial-scan, never integrity-problems
  assert.equal(
    mapState(envelope(false, [indeterminate('corrupt', ['generation-v3-gzip-decode-failed'])],
      ['package-scan-entry-unrepresentable'])),
    S.PARTIAL_SCAN,
  );
  // Even an otherwise-empty incomplete scan is partial, never "empty".
  assert.equal(mapState(envelope(false, [])), S.PARTIAL_SCAN);
  // And the notice says OBSERVED, never a whole-archive total.
  const model = M.mapArchiveHealth({ integrity: envelope(false, [verified(), verified()]) });
  assert.equal(model.partialScanNotice.observedPackages, 2);
  assert.match(model.partialScanNotice.text, /Scan incomplete — 2 packages observed\./);
  assert.equal(model.complete, false);
});

check('the package partition follows the trusted class and reason', () => {
  const parts = M.partitionOccupants([
    verified(), legacy(),
    indeterminate('corrupt', ['generation-v3-gzip-decode-failed']),
    indeterminate('identity-mismatch'),
    indeterminate('not-a-package-name'),
    reserved(),
  ]);
  assert.equal(parts.packageOccupants.length, 4, 'verified + legacy + 2 indeterminate packages');
  assert.equal(parts.strays.length, 1, 'not-a-package-name is a stray, never a package row');
  assert.equal(parts.infrastructure.length, 1);
  // An unknown class fails closed rather than being silently dropped.
  assert.throws(() => M.partitionOccupants([{ class: 'brand-new-class' }]), /unrecognised trusted occupant class/);
});

check('ReservedInfrastructure is hidden and contributes nothing', () => {
  // 3. reserved-only -> empty, zero warnings, zero counts
  const model = M.mapArchiveHealth({ integrity: envelope(true, [reserved(), reserved({ name: '.h2o-reclaim' })]) });
  assert.equal(model.aggregateState, S.EMPTY);
  assert.equal(model.packageRows.length, 0);
  assert.equal(model.archiveWarnings.length, 0, 'infrastructure raises no warning');
  assert.equal(model.observed.packagesTotal, 0);
  // 15. adding infrastructure never alters observed package counts
  const without = M.mapArchiveHealth({ integrity: envelope(true, [verified()]) }).observed;
  const with_ = M.mapArchiveHealth({ integrity: envelope(true, [verified(), reserved()]) }).observed;
  assert.deepEqual(without, with_);
});

check('empty precedence is preserved exactly as production has it', () => {
  // 2. complete + no package occupants -> empty
  assert.equal(mapState(envelope(true, [])), S.EMPTY);
  // 12. NotAPackageName only -> still empty (Empty wins over stray drift)
  assert.equal(mapState(envelope(true, [indeterminate('not-a-package-name')])), S.EMPTY);
  // Empty also wins over separate DB drift.
  assert.equal(
    mapState(envelope(true, []), { archiveWarnings: ['db drift'] }),
    S.EMPTY,
  );
});

check('healthy and healthy-with-drift follow the binding precedence', () => {
  // 4. valid V3 only -> healthy ; 5. legacy only -> healthy
  assert.equal(mapState(envelope(true, [verified()])), S.HEALTHY);
  assert.equal(mapState(envelope(true, [legacy()])), S.HEALTHY);
  // 6. all valid + drift on ALL -> healthy-with-drift
  const two = [verified({ path: 'p/1' }), verified({ path: 'p/2' })];
  assert.equal(
    mapState(envelope(true, two), { packageWarnings: { 'p/1': ['db drift'], 'p/2': ['db drift'] } }),
    S.HEALTHY_WITH_DRIFT,
  );
  // 12b. a real package plus a stray -> healthy-with-drift
  assert.equal(
    mapState(envelope(true, [verified(), indeterminate('not-a-package-name')])),
    S.HEALTHY_WITH_DRIFT,
  );
  // Archive-level drift alone also reaches drift, never healthy.
  assert.equal(
    mapState(envelope(true, [verified()]), { archiveWarnings: ['cas drift'] }),
    S.HEALTHY_WITH_DRIFT,
  );
});

check('mixed covers both the blocked mix and the preserved warning-only mix', () => {
  // 8. valid + one corrupt -> mixed
  assert.equal(
    mapState(envelope(true, [verified(), indeterminate('corrupt', ['generation-v3-gzip-decode-failed'])])),
    S.MIXED,
  );
  // 7. valid packages + drift on SOME -> mixed (the deliberately preserved quirk)
  const two = [verified({ path: 'p/1' }), verified({ path: 'p/2' })];
  assert.equal(
    mapState(envelope(true, two), { packageWarnings: { 'p/1': ['db drift'] } }),
    S.MIXED,
  );
});

check('integrity-problems requires every package blocked', () => {
  // 9. all corrupt ; 10. partial only ; 11. unreadable only
  for (const reason of ['corrupt', 'partial', 'unreadable', 'identity-mismatch', 'unexpected-outcome']) {
    assert.equal(mapState(envelope(true, [indeterminate(reason)])), S.INTEGRITY_PROBLEMS, reason);
  }
  assert.equal(
    mapState(envelope(true, [indeterminate('corrupt'), indeterminate('partial')])),
    S.INTEGRITY_PROBLEMS,
  );
});

check('blocker codes are humanized without ever being hidden or reclassified', () => {
  // exact overrides
  assert.match(M.explainBlockerCode('generation-v3-gzip-decode-failed').text, /compressed snapshot could not be decoded/i);
  assert.match(M.explainBlockerCode('generation-content-hash-mismatch').text, /do not match the identity/i);
  assert.match(M.explainBlockerCode('generation-v3-persistent-renderer-forbidden').text, /rendered copy/i);
  // family prefixes, most-specific first
  assert.match(M.explainBlockerCode('generation-v3-snapshot-messages-invalid').text, /snapshot/i);
  assert.match(M.explainBlockerCode('generation-v3-manifest-file-inventory-invalid').text, /manifest/i);
  assert.match(M.explainBlockerCode('generation-manifest-chat-id-missing').text, /manifest/i);
  assert.match(M.explainBlockerCode('generation-package-unexpected-member').text, /package structure/i);
  assert.match(M.explainBlockerCode('generation-asset-sha-mismatch').text, /attachment/i);
  // 13. an unknown future code keeps its EXACT text and stays non-healthy
  const unknown = M.explainBlockerCode('generation-future-rule-nobody-has-written-yet');
  assert.equal(unknown.code, 'generation-future-rule-nobody-has-written-yet', 'code shown verbatim');
  assert.match(unknown.text, /Trusted verification refused this package/i);
  assert.equal(
    mapState(envelope(true, [indeterminate('corrupt', ['generation-future-rule-nobody-has-written-yet'])])),
    S.INTEGRITY_PROBLEMS,
    'an unknown code never softens the trusted reason',
  );
  // No blocker text implies a root cause the code cannot support.
  for (const scare of ['disk', 'hardware', 'virus', 'ransomware', 'permanently lost', 'unrecoverable']) {
    assert.ok(!source.toLowerCase().includes(scare), `blocker copy must not claim "${scare}"`);
  }
});

check('the eight false-healthy divergence families are never healthy', () => {
  const families = [
    ['v3 persistent renderer forbidden', 'corrupt', 'generation-v3-persistent-renderer-forbidden'],
    ['v1 non-empty assets', 'corrupt', 'generation-manifest-assets-invalid'],
    ['v3 invalid manifest file inventory', 'corrupt', 'generation-v3-manifest-file-inventory-invalid'],
    ['absent chatId', 'corrupt', 'generation-manifest-chat-id-missing'],
    ['v3 legacy content forbidden', 'corrupt', 'generation-v3-snapshot-legacy-content-forbidden'],
    ['v3 messages non-array', 'corrupt', 'generation-v3-snapshot-messages-invalid'],
    ['unexpected persistent member', 'corrupt', 'generation-package-unexpected-member'],
    ['duplicate asset sha / padded snapshotId', 'identity-mismatch', 'generation-manifest-asset-duplicate-sha'],
  ];
  for (const [label, reason, code] of families) {
    const alone = mapState(envelope(true, [indeterminate(reason, [code])]));
    assert.equal(alone, S.INTEGRITY_PROBLEMS, `${label}: alone`);
    const mixed = mapState(envelope(true, [verified(), indeterminate(reason, [code])]));
    assert.equal(mixed, S.MIXED, `${label}: mixed with a valid package`);
    for (const state of [alone, mixed]) {
      assert.notEqual(state, S.HEALTHY, `${label} must never be healthy`);
      assert.notEqual(state, S.HEALTHY_WITH_DRIFT, `${label} must never be drift-only`);
    }
    // The explanation stays visible.
    const model = M.mapArchiveHealth({ integrity: envelope(true, [indeterminate(reason, [code])]) });
    assert.equal(model.packageRows[0].blockerExplanations[0].code, code, `${label}: code visible`);
    assert.ok(model.packageRows[0].blockerExplanations[0].text.length > 0);
  }
});

check('17. an unrecognised or malformed input can never fall through to healthy', () => {
  for (const bad of [null, undefined, 42, 'healthy', [], { }]) {
    assert.throws(() => M.selectAggregateState(bad), /ArchiveHealthMappingContractError|must be/);
  }
  // A missing/unknown completeness state is refused, not assumed complete.
  assert.throws(() => M.selectAggregateState({ packagesTotal: 1 }), /`complete` must be a boolean/);
  assert.throws(() => M.selectAggregateState({ complete: 'yes' }), /`complete` must be a boolean/);
  assert.throws(() => M.mapArchiveHealth({ integrity: { occupants: [] } }), /must state `complete`/);
  // Incoherent sub-counts fail closed rather than resolving to healthy.
  assert.throws(
    () => M.selectAggregateState({ complete: true, packagesTotal: 1, packagesBlocked: 2 }),
    /cannot exceed packagesTotal/,
  );
  // Every valid input yields one of the six.
  for (const total of [0, 1, 2, 3]) {
    for (let blocked = 0; blocked <= total; blocked += 1) {
      for (let warning = 0; warning <= total - blocked; warning += 1) {
        for (const archiveWarnings of [0, 1]) {
          const state = M.selectAggregateState({
            complete: true, packagesTotal: total, packagesBlocked: blocked, packagesWarning: warning, archiveWarnings,
          });
          assert.ok(M.ALL_STATES.includes(state), `total=${total} blocked=${blocked} warning=${warning}`);
        }
      }
    }
  }
  // And there is no `unknown` STATE, and no branch that returns healthy after
  // failing to recognise something: the healthy return is the final fallthrough
  // of an exhaustive chain, reached only when nothing was observed.
  assert.ok(!Object.values(S).includes('unknown'), 'no unknown state value');
  assert.ok(!/['"]unknown['"]/.test(CODE_ONLY), 'no unknown status literal in code');
  const healthyReturns = [...CODE_ONLY.matchAll(/return AGGREGATE_STATES\.HEALTHY;/g)];
  assert.equal(healthyReturns.length, 1, 'healthy is returned from exactly one place');
});

check('compatibility fields are synthesized from trusted facts only', () => {
  const model = M.mapArchiveHealth({
    integrity: envelope(true, [
      verified({ path: 'p/1', chatId: 'chat_a', snapshotId: 's0', contentHash: 'abc' }),
      legacy({ path: 'p/2', constructionFamily: 'v2' }),
      indeterminate('identity-mismatch', [], { path: 'p/3' }),
      indeterminate('corrupt', ['generation-v3-gzip-decode-failed'], { path: 'p/4' }),
    ]),
    presentation: { packageWarnings: { 'p/1': ['db drift'] } },
  });
  const byPath = Object.fromEntries(model.packageRows.map((r) => [r.packagePath, r]));
  assert.equal(byPath['p/1'].nameClassification, 'generation');
  assert.equal(byPath['p/2'].nameClassification, 'legacy');
  assert.equal(byPath['p/3'].nameClassification, 'mismatch');
  assert.equal(byPath['p/4'].nameClassification, 'unclassified');
  assert.equal(byPath['p/2'].schemaVersion, 2);
  assert.equal(byPath['p/1'].schemaVersion, 3);
  assert.equal(byPath['p/3'].schemaVersion, null, 'an unverified occupant has no proven family');
  // Status comes from the trusted class plus separate drift, never from parsing.
  assert.equal(byPath['p/1'].status, 'warning', 'valid package + separate drift');
  assert.equal(byPath['p/2'].status, 'ok');
  assert.equal(byPath['p/3'].status, 'blocked');
  // Legacy is VALID: never stale/outdated/migration-needed.
  assert.equal(byPath['p/2'].trustedClass, 'legacy-package');
  assert.equal(byPath['p/2'].formatLabel, 'Format v2');
  // The prohibition is on what the mapper SAYS. Check every string it can emit:
  // the model itself, plus each blocker explanation it is able to produce.
  const emitted = [
    JSON.stringify(model),
    ...['generation-v3-gzip-decode-failed', 'generation-content-hash-mismatch',
      'generation-v3-persistent-renderer-forbidden', 'generation-manifest-chat-id-missing',
      'generation-v3-snapshot-messages-invalid', 'generation-package-unexpected-member',
      'generation-asset-sha-mismatch', 'generation-member-sha-mismatch',
      'generation-snapshot-id-mismatch', 'generation-chat-id-mismatch',
      'generation-v3-identity-logical-sha-mismatch', 'generation-v3-content-hash-input-invalid',
      'generation-totally-unknown-future-code'].map((c) => M.explainBlockerCode(c).text),
    ...model.packageRows.map((r) => r.formatLabel),
  ].join(' ').toLowerCase();
  for (const forbidden of ['stale', 'outdated', 'needs migration', 'needs upgrade', 'obsolete', 'reclaimable']) {
    assert.ok(!emitted.includes(forbidden), `no derived claim: ${forbidden}`);
  }
  // Trusted identity facts pass through verbatim.
  assert.equal(byPath['p/1'].chatId, 'chat_a');
  assert.equal(byPath['p/1'].snapshotId, 's0');
  assert.equal(byPath['p/1'].contentHash, 'abc');
  assert.equal(model.liveGenerationFamily, 'v3');
});

check('18. the mapper emits no destructive, action or repair concepts', () => {
  const model = M.mapArchiveHealth({
    integrity: envelope(true, [verified(), indeterminate('corrupt', ['generation-v3-gzip-decode-failed'])]),
  });
  const raw = JSON.stringify(model).toLowerCase();
  for (const forbidden of [
    'repair', 'recover', 'delete', 'quarantine', 'reclaim', 'purge', 'restore',
    'action', 'button', 'confirm', 'formatstale',
  ]) {
    assert.ok(!raw.includes(forbidden), `the model must not emit ${forbidden}`);
  }
});

check('the mapper implements no verification, hash, filesystem or invoke authority', () => {
  // Real APIs, against the code-only view. Naming `generation-v3-gzip-*` as a
  // blocker FAMILY is required humanization; performing gzip work is not.
  for (const forbidden of [
    'sha256(', 'createHash', 'crypto.', 'JSON.parse', 'JSON.stringify',
    'pako', 'inflate', 'gunzip', 'DecompressionStream', 'zlib',
    'readFile', 'writeFile', 'readdir', 'existsSync',
    'require(', 'invoke(', '__TAURI__', 'fetch(', 'XMLHttpRequest',
    'localStorage', 'sessionStorage', 'indexedDB', 'document.', 'window.',
  ]) {
    assert.ok(!CODE_ONLY.includes(forbidden), `the mapper must not contain \`${forbidden}\``);
  }
  // It derives no identity of its own: contentHash/snapshotId are passed through.
  assert.ok(!/contentHash\s*=[^=]/.test(CODE_ONLY), 'contentHash is never computed here');
  // Decoding APIs, not the canonical code NAME `generation-v3-gzip-decode-failed`,
  // which the humanization table must be able to reference.
  for (const forbidden of ['TextDecoder', 'atob(', '.decode(', 'Buffer.from', 'parseInt(', 'parseFloat(']) {
    assert.ok(!CODE_ONLY.includes(forbidden), `no decoding/parsing API: ${forbidden}`);
  }
  // It holds no state between calls.
  assert.ok(!/\bvar\s+cache\b|\blet\s+cache\b/.test(source), 'no cache');
});

check('the mapper is packaged and, since P3b, consumed through the trusted chain', () => {
  const pack = readRepo(PACK_REL);
  const entries = [...pack.matchAll(/"ingestion\/saved-chat-archive-health-mapping\.js"/g)];
  assert.equal(entries.length, 2, 'exactly the source/output manifest pair');
  /* M10 P3b: the mapper reached production through the COMPOSITION, which is
     the only intended consumer. The Health UI is deliberately unchanged in its
     wiring — it still calls the same facade, which is now trusted-sourced. */
  const composition = readRepo(`${ING}saved-chat-archive-health-composition.js`);
  assert.ok(composition.includes('mapArchiveHealth'), 'the composition consumes the mapper');
  assert.ok(
    !readRepo(HEALTH_UI_REL).includes('archiveHealthMapping'),
    'the Health UI still consumes the facade, not the mapper directly',
  );
  assert.ok(
    readRepo(HEALTH_UI_REL).includes('diagnoseSavedChatArchiveV1'),
    'production Health still calls the same facade entry point',
  );
});

console.log('');
if (FAIL.length) {
  console.log(`[saved-chat-archive-health-mapping] ${FAIL.length} failed, ${PASS.length} passed`);
  process.exit(1);
}
console.log(`[saved-chat-archive-health-mapping] all ${PASS.length} checks passed`);
