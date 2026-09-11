#!/usr/bin/env node
// Validator for the M05 Phase 2.2 per-chat coverage/freshness engine.
//
// Loads saved-chat-coverage.tauri.js into a Node VM with INJECTED stand-ins for
// the three authorities it composes (archive discovery, governed package
// validation, current projection probe). That isolation is the point: this
// validator proves the composition rules — what may and may not be concluded —
// not the authorities themselves, which have their own suites.
//
// The rules under test are the frozen ones (§D §E §F §G): freshness is
// recomputed-hash equality and nothing else; a negative absence conclusion
// requires a complete scan and an authoritative projection; BEST-HISTORICAL is
// presentation only.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), '..', '..', '..');
const MODULE_REL = 'src-surfaces-base/studio/ingestion/saved-chat-coverage.tauri.js';

const PASS = [];
const FAIL = [];
function check(label, fn) {
  try { fn(); PASS.push(label); console.log(`  ✓ ${label}`); }
  catch (e) { const m = e?.message ?? String(e); FAIL.push({ label, m }); console.log(`  ✗ ${label}`); console.log(`      ${m}`); }
}
async function checkAsync(label, fn) {
  try { await fn(); PASS.push(label); console.log(`  ✓ ${label}`); }
  catch (e) { const m = e?.message ?? String(e); FAIL.push({ label, m }); console.log(`  ✗ ${label}`); console.log(`      ${m}`); }
}
function readRepo(rel) { return fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8'); }

const CHAT = 'chat_cov';
const HASH_A = 'sha256-' + 'a'.repeat(64);
const HASH_B = 'sha256-' + 'b'.repeat(64);

/* M10 P3.5a: a TRUSTED OCCUPANT fixture. Package validity is decided by Rust,
 * so the fixture states the trusted class/reason directly rather than a legacy
 * diagnostic. `contentHash` is what the trusted verifier RECOMPUTED. */
const FAMILY_BY_SCHEMA = { 1: 'v1', 2: 'v2', 3: 'v3' };
function pkg({
  dir, classification = 'generation', contentHash = HASH_A, status = 'ok',
  savedAt = '2026-01-01T00:00:00.000Z', schemaVersion = 2, chatId = CHAT,
  blockers = [], reason = 'corrupt',
}) {
  const klass = status !== 'ok'
    ? 'indeterminate'
    : (classification === 'legacy' ? 'legacy-package' : 'verified-generation');
  const occupant = {
    path: `archive/packages/${dir}`,
    name: dir,
    class: klass,
    blockers: blockers.map((code) => ({ code })),
  };
  if (klass === 'indeterminate') {
    occupant.reason = reason;
    return occupant;
  }
  occupant.chatId = chatId;
  occupant.snapshotId = 'snap1';
  occupant.contentHash = contentHash;
  occupant.constructionFamily = FAMILY_BY_SCHEMA[schemaVersion] || 'v2';
  occupant.snapshotEncoding = 'identity';
  occupant.savedAt = savedAt;
  occupant.orderable = true;
  occupant.assetShas = [];
  return occupant;
}

/* Non-package occupants the canonical partition must exclude entirely. */
const reservedOccupant = () => ({ path: 'archive/packages/.h2o-archive.lock', name: '.h2o-archive.lock', class: 'reserved-infrastructure', blockers: [] });
const strayOccupant = () => ({ path: 'archive/packages/notes.txt', name: 'notes.txt', class: 'indeterminate', reason: 'not-a-package-name', blockers: [] });

const MAPPER_REL = 'src-surfaces-base/studio/ingestion/saved-chat-archive-health-mapping.js';

function load({ packages = [], complete = true, projection, integrityThrows = false, extraOccupants = [] }) {
  const context = { console, setTimeout, __TAURI_INTERNALS__: {}, H2O: { Studio: { ingestion: {} } } };
  context.globalThis = context;
  const sandbox = vm.createContext(context);
  /* The REAL canonical partition — Coverage must never re-implement it. */
  vm.runInContext(readRepo(MAPPER_REL), sandbox, { filename: MAPPER_REL });
  const ing = sandbox.H2O.Studio.ingestion;
  ing.readSavedChatArchiveIntegrityV1 = async () => {
    if (integrityThrows) throw new Error('trusted archive integrity unavailable');
    return {
      schema: 'h2o.savedChatArchiveIntegrity', schemaVersion: 1,
      complete, blockers: [],
      observed: { byConstructionFamily: { v1: 0, v2: 0, v3: 0 } },
      liveGenerationFamily: 'v3',
      occupants: packages.concat(extraOccupants),
    };
  };
  if (projection) ing.probeCurrentSavedChatProjectionV1 = async () => projection;
  vm.runInContext(readRepo(MODULE_REL), sandbox, { filename: MODULE_REL });
  const fn = sandbox.H2O?.Studio?.ingestion?.describeSavedChatCoverageV1;
  if (typeof fn !== 'function') throw new Error('coverage engine did not register');
  return fn;
}

const okProjection = (contentHash = HASH_A, schemaVersion = 2) => ({
  status: 'ok', reason: '', contentHash, snapshotId: 'snap1', schemaVersion,
  payloadVersion: schemaVersion === 2 ? 2 : null, assetShas: [],
});

async function main() {
  console.log('── Studio saved-chat coverage engine validator (M05 P2.2) ──────');

  const CODE = readRepo(MODULE_REL);
  check('composes existing authorities: no index, no pointer, no second hash impl', () => {
    assert.doesNotMatch(CODE, /archive_package_index|current\.json|latestPointer/i);
    assert.doesNotMatch(CODE, /sha256\s*\(|createHash|canonicalJson/i, 'must not implement a second contentHash');
    assert.doesNotMatch(CODE, /plugin:fs\||plugin:sql\|/, 'must not touch fs/sql directly');
  });

  await checkAsync('1. current projection equal to a valid generation ⇒ FRESH + COVERED', async () => {
    const describe = load({ packages: [pkg({ dir: 'g1.h2ochat', contentHash: HASH_A })], projection: okProjection(HASH_A) });
    const r = await describe({ chatId: CHAT });
    assert.equal(r.covered, true);
    assert.equal(r.preserved, true);
    assert.equal(r.fresh.length, 1);
    assert.equal(r.stale.length, 0);
    assert.equal(r.selected.packagePath, 'archive/packages/g1.h2ochat');
    assert.equal(r.complete, true);
  });

  await checkAsync('1b. v3 identity/gzip representations cover by shared logical contentHash', async () => {
    const identity = pkg({ dir: 'identity.h2ochat', contentHash: HASH_A, schemaVersion: 3 });
    identity.payloadVersion = 3;
    identity.snapshotEncoding = 'identity';
    identity.snapshotPhysicalSha256 = 'sha256-' + '1'.repeat(64);
    const gzip = pkg({ dir: 'gzip.h2ochat', contentHash: HASH_A, schemaVersion: 3 });
    gzip.payloadVersion = 3;
    gzip.snapshotEncoding = 'gzip';
    gzip.snapshotPhysicalSha256 = 'sha256-' + '2'.repeat(64);
    const describe = load({ packages: [identity, gzip], projection: okProjection(HASH_A, 3) });
    const r = await describe({ chatId: CHAT });
    assert.equal(r.covered, true);
    assert.equal(r.fresh.length, 2, 'physical representation differences must not alter logical coverage');
    assert.notEqual(identity.snapshotPhysicalSha256, gzip.snapshotPhysicalSha256);
    assert.equal(identity.contentHash, gzip.contentHash, 'both representations share one logical contentHash');
  });

  await checkAsync('2. complete scan + authoritative projection + no equal package ⇒ not covered', async () => {
    const describe = load({ packages: [pkg({ dir: 'g1.h2ochat', contentHash: HASH_B })], projection: okProjection(HASH_A) });
    const r = await describe({ chatId: CHAT });
    assert.equal(r.covered, false, 'a complete scan MAY establish absence');
    assert.equal(r.preserved, true, 'the chat is still preserved');
    assert.equal(r.stale.length, 1);
    assert.equal(r.stale[0].staleKind, 'content-stale');
  });

  await checkAsync('3. timestamps can NEVER manufacture freshness', async () => {
    // Newest possible mtime and a far-future manifest generatedAt, but the
    // recomputed hash differs — so it is stale, full stop.
    const describe = load({
      packages: [pkg({ dir: 'g1.h2ochat', contentHash: HASH_B, mtime: 9e12, generatedAt: '2099-12-31T23:59:59.000Z' })],
      projection: okProjection(HASH_A),
    });
    const r = await describe({ chatId: CHAT });
    assert.equal(r.covered, false);
    assert.equal(r.fresh.length, 0, 'no timestamp may make a differing hash fresh');
  });

  await checkAsync('4. multiple valid historical generations remain visible', async () => {
    const describe = load({
      packages: [
        pkg({ dir: 'g1.h2ochat', contentHash: HASH_B, savedAt: '2026-01-01T00:00:00.000Z' }),
        pkg({ dir: 'g2.h2ochat', contentHash: 'sha256-' + 'c'.repeat(64), savedAt: '2026-02-01T00:00:00.000Z' }),
      ],
      projection: okProjection(HASH_A),
    });
    const r = await describe({ chatId: CHAT });
    assert.equal(r.generations.length, 2, 'both remain preserved and visible');
    assert.equal(r.stale.length, 2);
  });

  await checkAsync('5. a corrupt sibling does not erase a valid FRESH sibling', async () => {
    const describe = load({
      packages: [
        pkg({ dir: `${CHAT}.gbad.h2ochat`, status: 'blocked', blockers: ['generation-content-hash-mismatch'], contentHash: HASH_B }),
        pkg({ dir: 'good.h2ochat', contentHash: HASH_A }),
      ],
      projection: okProjection(HASH_A),
    });
    const r = await describe({ chatId: CHAT });
    assert.equal(r.covered, true, 'the corrupt sibling must not remove coverage');
    assert.equal(r.fresh.length, 1);
    assert.equal(r.unusable.length, 1, 'and the corrupt one is surfaced, not hidden');
    assert.equal(r.unusable[0].packageDirName, `${CHAT}.gbad.h2ochat`);
  });

  await checkAsync('6. manifest contentHash tampering cannot manufacture freshness', async () => {
    // The manifest CLAIMS the current hash; the recomputed value disagrees.
    const describe = load({
      packages: [pkg({ dir: 'liar.h2ochat', contentHash: HASH_B, manifestContentHash: HASH_A })],
      projection: okProjection(HASH_A),
    });
    const r = await describe({ chatId: CHAT });
    assert.equal(r.fresh.length, 0, 'comparison must use the RECOMPUTED hash');
    assert.equal(r.covered, false);
  });

  await checkAsync('7. a valid legacy package is eligible for freshness and coverage', async () => {
    const describe = load({
      packages: [pkg({ dir: `${CHAT}.h2ochat`, classification: 'legacy', contentHash: HASH_A, schemaVersion: 1 })],
      projection: okProjection(HASH_A, 1),
    });
    const r = await describe({ chatId: CHAT });
    assert.equal(r.legacy.length, 1);
    assert.equal(r.covered, true, 'legacy participates in freshness exactly like a generation');
    assert.equal(r.selected.classification, 'legacy');
  });

  await checkAsync('7b. a FRESH generation is preferred over a FRESH legacy', async () => {
    const describe = load({
      packages: [
        pkg({ dir: `${CHAT}.h2ochat`, classification: 'legacy', contentHash: HASH_A }),
        pkg({ dir: 'g1.h2ochat', classification: 'generation', contentHash: HASH_A }),
      ],
      projection: okProjection(HASH_A),
    });
    const r = await describe({ chatId: CHAT });
    assert.equal(r.selected.classification, 'generation');
  });

  await checkAsync('8. incomplete/truncated discovery cannot establish absence', async () => {
    const describe = load({
      packages: [pkg({ dir: 'g1.h2ochat', contentHash: HASH_B })],
      complete: false, truncated: true, blockers: ['archive-package-inventory-truncated'],
      projection: okProjection(HASH_A),
    });
    const r = await describe({ chatId: CHAT });
    assert.equal(r.covered, null, 'null, never false: a truncated scan is not evidence of absence');
    assert.equal(r.complete, false);
    assert.equal(r.reason, 'discovery-incomplete');
    // A positive fact from an already-verified package is still safe.
    assert.equal(r.preserved, true);
  });

  await checkAsync('8b. truncated discovery may still establish a POSITIVE fresh result', async () => {
    const describe = load({
      packages: [pkg({ dir: 'g1.h2ochat', contentHash: HASH_A })],
      complete: false, truncated: true,
      projection: okProjection(HASH_A),
    });
    const r = await describe({ chatId: CHAT });
    assert.equal(r.covered, true, 'a verified equal package is a safe positive under a partial scan');
  });

  await checkAsync('9. indeterminate projection asserts neither fresh nor stale', async () => {
    const describe = load({
      packages: [pkg({ dir: 'g1.h2ochat', contentHash: HASH_B })],
      projection: { status: 'indeterminate', reason: 'store-not-ready', contentHash: '' },
    });
    const r = await describe({ chatId: CHAT });
    assert.equal(r.covered, null, 'never false from a partial current state');
    assert.equal(r.fresh.length, 0);
    assert.equal(r.stale.length, 0, 'and never stale either');
    assert.equal(r.preserved, true, 'packages remain preserved');
    assert.equal(r.projection.contentHash, '', 'no hash may leak from a non-ok projection');
  });

  await checkAsync('10. no-current-snapshot does not mislabel historical packages stale', async () => {
    const describe = load({
      packages: [pkg({ dir: 'g1.h2ochat', contentHash: HASH_B })],
      projection: { status: 'undefined-no-snapshot', reason: 'no-current-snapshot', contentHash: '' },
    });
    const r = await describe({ chatId: CHAT });
    assert.equal(r.stale.length, 0);
    assert.equal(r.covered, null);
    assert.equal(r.preserved, true);
    assert.equal(r.reason, 'no-current-snapshot');
  });

  await checkAsync('11. BEST-HISTORICAL appears only without a fresh package and is never authority', async () => {
    const fresh = load({ packages: [pkg({ dir: 'g1.h2ochat', contentHash: HASH_A })], projection: okProjection(HASH_A) });
    const rf = await fresh({ chatId: CHAT });
    assert.equal(rf.bestHistorical, null, 'a covered chat needs no historical candidate');

    const stale = load({
      packages: [
        pkg({ dir: 'g1.h2ochat', contentHash: HASH_B, savedAt: '2026-01-01T00:00:00.000Z' }),
        pkg({ dir: 'g2.h2ochat', contentHash: 'sha256-' + 'c'.repeat(64), savedAt: '2026-03-01T00:00:00.000Z' }),
      ],
      projection: okProjection(HASH_A),
    });
    const rs = await stale({ chatId: CHAT });
    assert.equal(rs.bestHistorical.packageDirName, 'g2.h2ochat', 'highest verified savedAt');
    assert.equal(rs.covered, false, 'BEST-HISTORICAL must not imply coverage');
    assert.equal(rs.fresh.length, 0, 'nor freshness');
    assert.equal(rs.selected, null, 'nor automatic selection');
  });

  await checkAsync('12. ties are preserved as ties, deterministically ordered', async () => {
    const describe = load({
      packages: [
        pkg({ dir: 'gz.h2ochat', contentHash: 'sha256-' + 'd'.repeat(64), savedAt: '2026-05-01T00:00:00.000Z' }),
        pkg({ dir: 'ga.h2ochat', contentHash: 'sha256-' + 'c'.repeat(64), savedAt: '2026-05-01T00:00:00.000Z' }),
      ],
      projection: okProjection(HASH_A),
    });
    const r = await describe({ chatId: CHAT });
    assert.equal(r.bestHistoricalTies.length, 2, 'a tie must be reported as a tie');
    // Deterministic: equal savedAt ⇒ contentHash hex ascending.
    // Cross-realm: compare contents, not prototypes.
    assert.deepEqual([...r.bestHistoricalTies.map((e) => e.packageDirName)], ['ga.h2ochat', 'gz.h2ochat']);
  });

  await checkAsync('a mismatched name is unusable even when its manifest claims the current hash', async () => {
    const describe = load({
      packages: [pkg({ dir: `${CHAT}.gweird.h2ochat`, status: 'blocked', reason: 'identity-mismatch', contentHash: HASH_A, blockers: [] })],
      projection: okProjection(HASH_A),
    });
    const r = await describe({ chatId: CHAT });
    assert.equal(r.covered, false, 'a mismatched package may not provide coverage');
    assert.equal(r.unusable.length, 1);
    assert.equal(r.fresh.length, 0);
  });

  await checkAsync('M10 P3.5a: reserved infrastructure and strays are excluded by the canonical partition', async () => {
    const describe = load({
      packages: [pkg({ dir: `${CHAT}.g1.h2ochat`, contentHash: HASH_A })],
      extraOccupants: [reservedOccupant(), strayOccupant()],
      projection: okProjection(HASH_A),
    });
    const r = await describe({ chatId: CHAT });
    assert.equal(r.covered, true);
    assert.equal(r.fresh.length, 1);
    assert.equal(r.unusable.length, 0, 'neither infrastructure nor a stray is a package');
    assert.equal(r.legacy.length + r.generations.length, 1);
  });

  await checkAsync('M10 P3.5a: an incomplete trusted scan never concludes absence', async () => {
    const empty = load({ packages: [], complete: false, projection: okProjection(HASH_A) });
    const r = await empty({ chatId: CHAT });
    assert.equal(r.complete, false);
    assert.equal(r.preserved, null, 'incomplete discovery may not prove absence');
    assert.equal(r.covered, null);
    assert.equal(r.reason, 'discovery-incomplete');

    /* A positive stays valid even under an incomplete scan. */
    const found = load({ packages: [pkg({ dir: `${CHAT}.g1.h2ochat`, contentHash: HASH_A })], complete: false, projection: okProjection(HASH_A) });
    const r2 = await found({ chatId: CHAT });
    assert.equal(r2.complete, false);
    assert.equal(r2.preserved, true, 'a verified package in hand is a positive fact');
    assert.equal(r2.covered, true);
  });

  await checkAsync('M10 P3.5a: a trusted-path failure fails CLOSED with no legacy fallback', async () => {
    const describe = load({ integrityThrows: true, projection: okProjection(HASH_A) });
    const r = await describe({ chatId: CHAT });
    assert.equal(r.reason, 'archive-integrity-unavailable');
    assert.equal(r.complete, false);
    assert.equal(r.preserved, null);
    assert.equal(r.covered, null);
    /* And the engine no longer references the legacy archive verifier at all. */
    const src = readRepo(MODULE_REL);
    for (const forbidden of ['listSavedChatArchivePackagesV1', 'validateSavedChatPackageV1']) {
      assert.ok(!src.includes(forbidden), `Coverage must not reference ${forbidden}`);
    }
    assert.ok(src.includes('readSavedChatArchiveIntegrityV1'), 'Coverage consumes the trusted client');
    assert.ok(src.includes('partitionOccupants'), 'Coverage reuses the canonical partition');
  });

  await checkAsync('a package belonging to another verified chatId is ignored', async () => {
    const describe = load({
      packages: [pkg({ dir: 'g1.h2ochat', contentHash: HASH_A, chatId: 'someone_else' })],
      projection: okProjection(HASH_A),
    });
    const r = await describe({ chatId: CHAT });
    assert.equal(r.generations.length, 0);
    assert.equal(r.covered, false, 'verified identity decides ownership, not the basename');
  });

  await checkAsync('a differing construction family is FORMAT-stale, not content-stale', async () => {
    const describe = load({
      packages: [pkg({ dir: 'g3.h2ochat', contentHash: HASH_B, schemaVersion: 3 })],
      projection: okProjection(HASH_A, 2),
    });
    const r = await describe({ chatId: CHAT });
    assert.equal(r.stale.length, 1);
    assert.equal(r.stale[0].staleKind, 'format-stale');
  });

  await checkAsync('v1 vs v2 is ordinary content drift, NOT a format transition', async () => {
    const describe = load({
      packages: [pkg({ dir: 'g1.h2ochat', contentHash: HASH_B, schemaVersion: 1 })],
      projection: okProjection(HASH_A, 2),
    });
    const r = await describe({ chatId: CHAT });
    assert.equal(r.stale[0].staleKind, 'content-stale',
      'the live writer picks v1/v2 per content; that is not a format change');
  });

  console.log('');
  if (FAIL.length) {
    console.log(`PASS ${PASS.length}`);
    console.log(`FAIL ${FAIL.length}`);
    for (const f of FAIL) console.log(`- ${f.label}: ${f.m}`);
    process.exit(1);
  }
  console.log(`PASS ${PASS.length}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
