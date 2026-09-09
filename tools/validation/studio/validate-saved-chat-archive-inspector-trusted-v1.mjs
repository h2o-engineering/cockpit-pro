#!/usr/bin/env node
// Validator for the M10 P3.5a trusted Package Inspector.
//
// The Inspector's package verdict now comes from trusted Rust. This pins the
// final HDA-approved taxonomy, the exact-code-only gates (no `/sha|hash/i`
// heuristic), the two retired labels, and the fail-closed behaviour — plus the
// rule that its direct package reads are PREVIEW ONLY and never decide validity.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), '..', '..', '..');
const ING = 'src-surfaces-base/studio/ingestion/';
const MODULE_REL = `${ING}saved-chat-archive-inspector.studio.js`;
const MAPPER_REL = `${ING}saved-chat-archive-health-mapping.js`;
const readRepo = (rel) => fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');

/* Source slice for ONE named function, so trust-domain assertions can be made
   per mapper instead of over the whole module. */
function bodyOf(src, name) {
  const start = src.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `function ${name} not found`);
  const end = src.indexOf('\n  }\n', start);
  assert.ok(end > start, `end of ${name} not found`);
  return src.slice(start, end);
}

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

function load({ occupants = [], complete = true, integrityThrows = false } = {}) {
  const context = {
    console, setTimeout, TextDecoder,
    __TAURI_INTERNALS__: { invoke: async () => { throw new Error('no fs in this harness'); } },
    H2O: { Studio: { ingestion: {} } },
  };
  context.globalThis = context;
  const sandbox = vm.createContext(context);
  vm.runInContext(readRepo(MAPPER_REL), sandbox, { filename: MAPPER_REL });
  sandbox.H2O.Studio.ingestion.readSavedChatArchiveIntegrityV1 = async () => {
    if (integrityThrows) throw new Error('trusted archive integrity unavailable');
    return {
      schema: 'h2o.savedChatArchiveIntegrity', schemaVersion: 1,
      complete, blockers: [],
      observed: { byConstructionFamily: { v1: 0, v2: 0, v3: 0 } },
      liveGenerationFamily: 'v3', occupants,
    };
  };
  vm.runInContext(readRepo(MODULE_REL), sandbox, { filename: MODULE_REL });
  return sandbox.H2O.Studio.archiveInspector;
}

const verified = (over = {}) => ({
  path: 'archive/packages/chat_a.g1.h2ochat', name: 'chat_a.g1.h2ochat',
  class: 'verified-generation', chatId: 'chat_a', snapshotId: 's0',
  contentHash: 'a'.repeat(64), constructionFamily: 'v3', snapshotEncoding: 'identity',
  savedAt: '2026-01-01T00:00:00.000Z', orderable: true, assetShas: [], blockers: [], ...over,
});
const bad = (reason, codes = [], over = {}) => ({
  path: 'archive/packages/chat_b.g2.h2ochat', name: 'chat_b.g2.h2ochat',
  class: 'indeterminate', reason, blockers: codes.map((code) => ({ code })), ...over,
});

console.log('= saved-chat archive Inspector (M10 P3.5a trusted) =');

check('the final taxonomy is exactly the approved set', () => {
  const src = readRepo(MODULE_REL);
  for (const kept of ['verified', 'read-error', 'hash-mismatch', 'unsupported-encoding', 'corrupted']) {
    assert.ok(src.includes(`'${kept}':`), `kept label missing: ${kept}`);
  }
  for (const added of ['incomplete', 'unreadable', 'identity-mismatch']) {
    assert.ok(src.includes(`'${added}':`), `added label missing: ${added}`);
  }
  /* RETIRED, now with no exception. P3.5.6B kept these labels alive inside a
     temporary legacy mapper for the M08 portable carveout; P3.6b migrated
     portable import to trusted native verification and deleted that bridge, so
     the whole module must be free of them. Comment-stripped: the module's own
     prose names them to explain WHY they were retired. */
  const strip = (text) => text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
  const code = strip(src);
  for (const retired of ['missing-files', 'unsupported-version']) {
    assert.ok(!code.includes(retired), `retired label still present: ${retired}`);
  }
  /* And no regex-derived causal classification survives (code, not prose). */
  assert.ok(!/\/sha\|hash\/i/.test(code), 'no /sha|hash/i heuristic');
  assert.ok(!/manifest\|snapshot\|markdown\|html\)-missing/.test(code), 'no member-missing heuristic');
});

check('every trusted-refusal label renders as a problem, never benign', () => {
  const src = readRepo(MODULE_REL);
  const table = src.slice(src.indexOf('var STATUS_PRESENTATION'), src.indexOf('var PILL_TONES'));
  for (const label of ['corrupted', 'incomplete', 'unreadable', 'identity-mismatch', 'hash-mismatch', 'unsupported-encoding']) {
    const row = table.split('\n').find((l) => l.includes(`'${label}':`)) || '';
    assert.match(row, /tone: 'block'/, `${label} must render as a problem`);
  }
  assert.match(table.split('\n').find((l) => l.includes("'verified':")), /tone: 'ok'/);
  assert.match(table.split('\n').find((l) => l.includes("'read-error':")), /tone: 'neutral'/);
});

/* P3.5.6B: the trusted mapper is internal, so the contract is exercised through
   the PUBLIC trusted entry point rather than by exporting an internal symbol.
   `inspectPackage` resolves the occupant through the real trusted client and the
   real canonical partition; its direct file reads fail in this harness, which is
   exactly right — they are PREVIEW ONLY and never decide the status. */
await checkAsync('the deterministic trusted status contract', async () => {
  const map = async (occupant) => {
    const api = load({ occupants: [occupant] });
    const out = await api.inspectPackage({ packagePath: occupant.path });
    return out.status;
  };

  // A. verified classes
  assert.equal(await map(verified({ constructionFamily: 'v1' })), 'verified');
  assert.equal(await map(verified({ constructionFamily: 'v2' })), 'verified');
  assert.equal(await map(verified({ constructionFamily: 'v3' })), 'verified');
  assert.equal(await map(verified({ class: 'legacy-package', constructionFamily: 'v1' })), 'verified');

  // B/C/D. broad canonical reasons
  assert.equal(await map(bad('partial')), 'incomplete', 'Partial means missing OR unreadable members');
  assert.equal(await map(bad('unreadable')), 'unreadable');
  assert.equal(await map(bad('identity-mismatch')), 'identity-mismatch');

  // E. EXACT hash-blocker membership only
  for (const code of [
    'generation-content-hash-mismatch',
    'generation-member-sha-mismatch',
    'generation-asset-sha-mismatch',
    'generation-v3-gzip-decoded-sha-mismatch',
    'generation-v3-identity-logical-sha-mismatch',
  ]) {
    assert.equal(await map(bad('corrupt', [code])), 'hash-mismatch', code);
  }
  // A code that merely MENTIONS a hash is not a hash mismatch.
  assert.equal(await map(bad('corrupt', ['generation-manifest-content-hash-invalid'])), 'corrupted',
    'exact membership only — no substring inference');

  // F. exact encoding gate
  assert.equal(await map(bad('corrupt', ['generation-v3-snapshot-encoding-invalid'])), 'unsupported-encoding');

  // G. everything else the trusted authority refused
  assert.equal(await map(bad('corrupt', [])), 'corrupted', 'corrupt without a granular blocker');
  assert.equal(await map(bad('unexpected-outcome', [])), 'corrupted');
  assert.equal(await map(bad('corrupt', ['generation-manifest-version-triple-incoherent'])), 'corrupted',
    'a version-triple refusal is a trusted refusal, never unsupported-version');
  assert.equal(await map(bad('corrupt', ['generation-v3-persistent-renderer-forbidden'])), 'corrupted',
    'an admission-adapter refusal without a granular hash/encoding code');

  /* Read error wins over an otherwise-verified occupant. Through the public
     path the read error is the real one — the trusted read failing — rather than
     an argument handed straight to the mapper. */
  const unavailable = load({ occupants: [verified()], integrityThrows: true });
  const out = await unavailable.inspectPackage({ packagePath: verified().path });
  assert.equal(out.status, 'read-error', 'a failed trusted read outranks a verified occupant');
  assert.equal(out.ok, false);
});

await checkAsync('listPackages enumerates trusted package occupants only', async () => {
  const api = load({
    occupants: [
      verified(),
      bad('corrupt', ['generation-content-hash-mismatch']),
      { path: 'archive/packages/.h2o-archive.lock', name: '.h2o-archive.lock', class: 'reserved-infrastructure', blockers: [] },
      { path: 'archive/packages/notes.txt', name: 'notes.txt', class: 'indeterminate', reason: 'not-a-package-name', blockers: [] },
    ],
  });
  const rows = await api.listPackages();
  assert.equal(rows.length, 2, 'infrastructure and strays are not packages');
  assert.equal(rows[0].status, 'verified');
  assert.equal(rows[1].status, 'hash-mismatch');
});

await checkAsync('a trusted-integrity failure fails closed, never verified', async () => {
  const api = load({ integrityThrows: true });
  assert.equal((await api.listPackages()).length, 0);
  const r = await api.inspectPackage({ packagePath: 'archive/packages/chat_a.g1.h2ochat' });
  assert.equal(r.status, 'read-error');
  assert.equal(r.ok, false);
});

await checkAsync('an occupant absent from the trusted enumeration is read-error', async () => {
  const api = load({ occupants: [verified()] });
  const r = await api.inspectPackage({ packagePath: 'archive/packages/chat_zzz.g9.h2ochat' });
  assert.equal(r.status, 'read-error');
  assert.equal(r.ok, false);
});

await checkAsync('enumeration completeness is carried, not implied', async () => {
  const api = load({ occupants: [verified()], complete: false });
  const r = await api.inspectPackage({ packagePath: 'archive/packages/chat_a.g1.h2ochat' });
  assert.equal(r.checks.archiveEnumerationComplete, false, 'the card must not imply exhaustive enumeration');
});

check('the Inspector holds no verification authority and no destructive action', () => {
  const src = readRepo(MODULE_REL);
  const code = src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
  for (const forbidden of [
    'listSavedChatArchivePackagesV1', 'validateSavedChatPackageV1', 'validateSavedChatPackageBytesV1',
    'createHash', 'sha256Hex', 'canonicalJson',
  ]) {
    assert.ok(!code.includes(forbidden), `the Inspector must not use ${forbidden}`);
  }
  assert.ok(code.includes('readSavedChatArchiveIntegrityV1'), 'consumes the trusted client');
  assert.ok(code.includes('partitionOccupants'), 'reuses the canonical partition');
  /* Read-only actions only. */
  for (const forbidden of ['repair', 'delete', 'restore', 'quarantine', 'rewrite', 'rebuild']) {
    assert.ok(!code.toLowerCase().includes(forbidden), `no destructive action: ${forbidden}`);
  }
});

/* ── P3.5.6B: two mappers, two trust domains ────────────────────────────── */

check('the trusted mapper stays INTERNAL', () => {
  const api = load();
  assert.equal(api.mapTrustedInspectStatus, undefined,
    'mapTrustedInspectStatus must not be exported, not even for tests');
  const src = readRepo(MODULE_REL);
  assert.ok(!/mapTrustedInspectStatus\s*:/.test(src),
    'mapTrustedInspectStatus must not appear on any exported object literal');
});

check('the temporary M08 legacy mapper is retired', () => {
  /* P3.6b removed the last production consumer, so the bridge itself goes. The
     Inspector now has exactly one mapper, and it speaks one trust domain. */
  const api = load();
  assert.equal(api.mapInspectStatus, undefined, 'the legacy symbol is no longer exported');
  const src = readRepo(MODULE_REL);
  assert.ok(!/function mapInspectStatus\(/.test(src), 'and its definition is gone');
  assert.ok(!/mapInspectStatus\s*:/.test(src), 'and it is on no exported object literal');
  /* The trusted mapper survives, still internal. */
  assert.ok(/function mapTrustedInspectStatus\(/.test(src));
  assert.equal(api.mapTrustedInspectStatus, undefined);
});

await checkAsync('public identity.contentHash is sha256-prefixed, and nothing is hashed', async () => {
  const occupant = verified({ contentHash: 'b'.repeat(64) });
  const api = load({ occupants: [occupant] });
  const out = await api.inspectPackage({ packagePath: occupant.path });
  assert.match(out.identity.contentHash, /^sha256-[0-9a-f]{64}$/,
    'exporter and relink expectedDigest read the prefixed form');
  assert.equal(out.identity.contentHash, `sha256-${'b'.repeat(64)}`,
    'the trusted value is formatted, never recomputed');
  /* §10: trusted validity authority is unchanged by the representation repair. */
  assert.equal(out.identity.contentHashVerified, true);

  /* An already-prefixed trusted value is not double-prefixed. */
  const pre = verified({ contentHash: `sha256-${'c'.repeat(64)}` });
  const out2 = await load({ occupants: [pre] }).inspectPackage({ packagePath: pre.path });
  assert.equal(out2.identity.contentHash, `sha256-${'c'.repeat(64)}`);

  /* No hashing authority anywhere in the module. */
  const code = readRepo(MODULE_REL).replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
  for (const banned of ['subtle', 'digest(', 'createHash', 'canonicalJson', 'sha256(']) {
    assert.ok(!code.includes(banned), `the Inspector must not hash: ${banned}`);
  }
});

console.log('');
if (FAIL.length) {
  console.log(`[saved-chat-archive-inspector-trusted] ${FAIL.length} failed, ${PASS.length} passed`);
  process.exit(1);
}
console.log(`[saved-chat-archive-inspector-trusted] all ${PASS.length} checks passed`);
