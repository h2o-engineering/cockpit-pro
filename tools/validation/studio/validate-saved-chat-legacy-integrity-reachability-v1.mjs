#!/usr/bin/env node
// M10 P3.5a — corrected legacy package-validation reachability.
//
// The earlier "zero production legacy verifier callers" goal was FALSE: the M08
// portable byte path legitimately delegates to the same verifier core. This
// validator states the truthful contract instead, and marks the carveout so a
// future P4 cannot mistake it for dead code.
//
//   ARCHIVE domain   -> trusted Rust only (Health, Coverage, Inspector)
//   PORTABLE domain  -> legacy JS byte-source verifier, RETAINED until P3.6

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), '..', '..', '..');
const SRC_ROOT = path.join(REPO_ROOT, 'src-surfaces-base');
const ING = 'src-surfaces-base/studio/ingestion/';
const DEFINER = `${ING}saved-chat-archive-diagnostics.tauri.js`;
const readRepo = (rel) => fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');

/* Production Studio source only — never validators or evidence tooling. */
function productionFiles() {
  const out = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(js|mjs)$/.test(entry.name)) out.push(path.relative(REPO_ROOT, full));
    }
  })(SRC_ROOT);
  return out;
}
const codeOf = (rel) => readRepo(rel)
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/^\s*\/\/.*$/gm, ' ');
/* Bounded body of one top-level module function, so an assertion can be scoped
 * to a single execution path instead of the whole file. Same idiom as the
 * sibling restore/relink validator, with `async function` handled because the
 * importer's path loaders are async. */
const functionBody = (source, name) => {
  const m = new RegExp('(?:async\\s+)?function\\s+' + name + '\\s*\\(').exec(source);
  if (!m) return '';
  const rest = source.slice(m.index + m[0].length);
  const next = rest.search(/\n {2}(?:async )?function\s/);
  return next === -1 ? rest : rest.slice(0, next);
};

/* Bounded call-graph over ONE module's top-level functions. This is not a
 * general JavaScript analyser: it indexes the two-space-indented module
 * functions this repository's ingestion modules use, treats "name(" inside a
 * body as a direct call, and walks those edges. Enough to follow helper
 * indirection inside a single authority surface; deliberately nothing more. */
const moduleFunctions = (source) => {
  const decl = /\n {2}(?:async\s+)?function\s+([A-Za-z0-9_$]+)\s*\(/g;
  const marks = [];
  let m;
  while ((m = decl.exec(source))) marks.push({ name: m[1], start: m.index });
  const bodies = new Map();
  marks.forEach((d, i) => {
    const end = i + 1 < marks.length ? marks[i + 1].start : source.length;
    bodies.set(d.name, source.slice(d.start, end));
  });
  return bodies;
};
const callEdges = (bodies) => {
  const names = [...bodies.keys()];
  const edges = new Map();
  for (const [name, body] of bodies) {
    edges.set(name, names.filter((other) => other !== name
      && new RegExp('\\b' + other.replace(/\$/g, '\\$') + '\\s*\\(').test(body)));
  }
  return edges;
};
/* Every function transitively reachable from the given entry points. */
const reachableFrom = (edges, roots) => {
  const seen = new Set();
  const stack = [...roots];
  while (stack.length) {
    const node = stack.pop();
    if (seen.has(node)) continue;
    seen.add(node);
    for (const callee of (edges.get(node) || [])) if (!seen.has(callee)) stack.push(callee);
  }
  return seen;
};

const callersOf = (token) => productionFiles()
  .filter((rel) => rel !== DEFINER)
  .filter((rel) => codeOf(rel).includes(token));

const PASS = [];
const FAIL = [];
function check(label, fn) {
  try { fn(); PASS.push(label); console.log(`  ✓ ${label}`); }
  catch (e) { const m = e && e.message ? e.message : String(e); FAIL.push({ label, m }); console.log(`  ✗ ${label}`); console.log(`      ${m}`); }
}

console.log('= saved-chat legacy package-validation reachability (M10 P3.5a) =');

check('CLAIM 1 — zero production callers of listSavedChatArchivePackagesV1', () => {
  assert.deepEqual(callersOf('listSavedChatArchivePackagesV1'), [],
    'archive discovery is trusted-only after P3.5a');
});

check('CLAIM 2 — the legacy JS package verifier is PHYSICALLY GONE', () => {
  /* M10 P4. Production authority was already zero; this proves the
     implementation itself no longer exists, rather than merely being
     unexported, renamed or commented out. */
  const definer = readRepo(DEFINER);
  for (const symbol of [
    'validateSavedChatPackageV1',
    'validateSavedChatPackageBytesV1',
    'listSavedChatArchivePackagesV1',
    'filesystemPackageSource',
    'memoryPackageSource',
  ]) {
    assert.ok(!definer.includes(symbol), `retired verifier symbol still present: ${symbol}`);
    assert.deepEqual(callersOf(symbol), [], `retired symbol still has a consumer: ${symbol}`);
  }
  /* And nothing that remains can reproduce the verification rules the trusted
     Rust verifier owns. The module no longer HASHES at all — the surviving
     `sha256` mentions are DB/CAS field reads, never a computation — and it
     carries none of the verifier's own rule codes. Note that
     `trustedRowToPackageDiagnostic` still surfaces `contentHash`: that is the
     TRUSTED value copied into the legacy row shape, not a derivation. */
  const code = codeOf(DEFINER);
  for (const primitive of [
    'crypto.subtle', 'digest(', 'sha256Hex', 'sha256Prefixed', 'canonicalJson',
    'verifyPackageMemberBytes', 'readVerifiedPackageMember',
  ]) {
    assert.ok(!code.includes(primitive), `diagnostics must not hash or verify: ${primitive}`);
  }
  for (const rule of ['snapshot-sha-mismatch', 'manifest-schema-invalid', 'content-hash-mismatch']) {
    assert.ok(!code.includes(rule), `diagnostics must own no verifier rule code: ${rule}`);
  }
});

check('CLAIM 3 — Coverage and Inspector consume the trusted client and the canonical partition', () => {
  for (const rel of [`${ING}saved-chat-coverage.tauri.js`, `${ING}saved-chat-archive-inspector.studio.js`]) {
    const code = codeOf(rel);
    assert.ok(code.includes('readSavedChatArchiveIntegrityV1'), `${rel} must read trusted integrity`);
    assert.ok(code.includes('partitionOccupants'), `${rel} must reuse the canonical partition`);
    for (const legacy of ['listSavedChatArchivePackagesV1', 'validateSavedChatPackageV1']) {
      assert.ok(!code.includes(legacy), `${rel} must not reference ${legacy}`);
    }
  }
});

check('CLAIM 4 — the M08 portable carveout is CLOSED', () => {
  /* M10 P3.6 migrated both portable consumers to trusted native verification.
     The legacy JS byte validator has no production consumer left; its code stays
     physically present for P4 to remove. */
  assert.deepEqual(callersOf('validateSavedChatPackageBytesV1'), [],
    'zero production consumers of the legacy portable byte validator');
});

check('CLAIM 6 — portable import AND export both use the trusted native client', () => {
  const consumers = callersOf('verifySavedChatPortablePackageV1').sort();
  assert.deepEqual(consumers, [
    `${ING}saved-chat-archive-exporter.studio.js`,
    `${ING}saved-chat-archive-importer.studio.js`,
    `${ING}saved-chat-portable-package-verification.tauri.js`,
  ], 'exactly the two portable consumers plus the client that defines it');
});

check('CLAIM 5 — no production archive consumer reaches the filesystem package source', () => {
  assert.deepEqual(callersOf('filesystemPackageSource'), [],
    'archive-root legacy verification is no longer a production input');
});

/* ---- §13 exporter/importer compatibility, proven without touching them ---- */

check('the exporter still gates on `verified` and fails closed on every new label', () => {
  const exporter = readRepo(`${ING}saved-chat-archive-exporter.studio.js`);
  const start = exporter.indexOf('async function inspectVerifiedPackage');
  const body = exporter.slice(start, start + 1600);
  assert.ok(/inspectStatus !== 'verified'/.test(body), 'the gate is verified-or-reject');
  /* The catch-all: anything not explicitly bucketed is rejected, so the three
     new Inspector labels fail closed with no exporter change. */
  assert.ok(/status: 'rejected', reason: inspectStatus \|\| 'not-verified'/.test(body),
    'a catch-all rejection exists for unrecognised statuses');
  for (const added of ['incomplete', 'unreadable', 'identity-mismatch']) {
    assert.ok(!body.includes(`'${added}'`), `${added} is not specially bucketed, so it hits the catch-all`);
  }
  /* Version gating does not depend on the retired Inspector label. */
  assert.ok(/schemaVersion === 1 \|\| schemaVersion === 2/.test(exporter),
    'the exporter validates supported manifest versions independently');
  /* M10 P3.6c: portable byte validation is now trusted native code, and the
     exporter's own semantic contentHash authority is retired. */
  assert.ok(!exporter.includes('validateSavedChatPackageBytesV1'),
    'the legacy portable byte validator is gone from the exporter');
  assert.ok(exporter.includes('verifySavedChatPortablePackageV1'), 'trusted portable client');
  assert.ok(!exporter.includes('contentHashExpected'),
    'the private semantic contentHash authority is retired');
});

check('the importer verifies portable packages through trusted native code', () => {
  const importer = codeOf(`${ING}saved-chat-archive-importer.studio.js`);
  assert.ok(importer.includes('verifySavedChatPortablePackageV1'), 'trusted portable client');
  assert.ok(!importer.includes('validateSavedChatPackageBytesV1'),
    'M10 P3.6b retired the legacy byte validator from the importer');
  assert.ok(!importer.includes('mapInspectStatus'), 'and the legacy mapper with it');

  /* The archive-integrity envelope is a DIFFERENT authority and stays out of the
   * portable path.
   *
   * This was once asserted as whole-file absence of
   * readSavedChatArchiveIntegrityV1. That became wrong — not because the
   * invariant changed, but because b642 ("bind archive recovery reads to trusted
   * state") made the ARCHIVE path legitimately consume fresh trusted archive
   * integrity to bind its post-inspection reads. A whole-file substring
   * conflates the two paths, and keeping it green would have required the
   * archive path to surrender its own safety correction.
   *
   * The invariant is therefore asserted where it actually lives: portable
   * recovery must verify through the trusted PORTABLE native verifier and must
   * never substitute archive-integrity authority. Proven by path topology
   * rather than by file-wide spelling. */
  const ARCHIVE_AUTHORITY = [
    'readSavedChatArchiveIntegrityV1',
    'getTrustedIntegrityFn',
    'trustedOccupantFor',
    'readBoundPackageSnapshotJson',
  ];
  const PORTABLE_ENTRY = ['dryRunImportZip', 'importVerifiedZip', 'loadPortableCandidate'];
  const ARCHIVE_ENTRY = ['dryRunImportPackage', 'importVerifiedPackage', 'loadArchiveCandidate'];

  /* TRANSITIVE, not one-hop. Scanning only the entry bodies would miss a wrapper:
   * portable entry -> helper A -> (helper B) -> archive-integrity authority.
   * The closure below follows local calls to any depth, and both the reachable
   * FUNCTION NAMES and the reachable BODIES are checked, so an inline invoke
   * that introduces no new local helper is caught as well. */
  const bodies = moduleFunctions(importer);
  const edges = callEdges(bodies);
  for (const fn of [...PORTABLE_ENTRY, ...ARCHIVE_ENTRY]) {
    assert.ok(bodies.has(fn), `path function not found: ${fn}`);
  }
  const portableReach = reachableFrom(edges, PORTABLE_ENTRY);
  for (const authority of ARCHIVE_AUTHORITY) {
    assert.ok(!portableReach.has(authority),
      `portable path transitively reaches archive-integrity authority: ${authority}`);
  }
  for (const fn of portableReach) {
    for (const authority of ARCHIVE_AUTHORITY) {
      assert.ok(!(bodies.get(fn) || '').includes(authority),
        `portable-reachable ${fn} names archive-integrity authority: ${authority}`);
    }
  }

  /* The portable path must positively verify through the trusted portable
   * client, so the absence above cannot be satisfied by verifying nothing. */
  assert.ok(portableReach.has('getPortableVerifier'),
    'the portable path does not transitively resolve the trusted portable verifier');
  assert.ok([...portableReach].some((fn) => (bodies.get(fn) || '').includes('verifySavedChatPortablePackageV1')),
    'the portable path does not reach trusted native portable verification');
  assert.ok(functionBody(importer, 'loadPortableCandidate').includes('getPortableVerifier'),
    'the portable loader does not resolve the trusted portable verifier directly');

  /* And the archive path must still transitively reach its own trusted
   * authority, so this check can never be satisfied by deleting b642. */
  const archiveReach = reachableFrom(edges, ARCHIVE_ENTRY);
  assert.ok(archiveReach.has('getTrustedIntegrityFn') && archiveReach.has('readBoundPackageSnapshotJson'),
    'the archive path no longer transitively reaches its trusted content binding');
  assert.ok([...archiveReach].some((fn) => (bodies.get(fn) || '').includes('readSavedChatArchiveIntegrityV1')),
    'the archive path no longer reaches trusted archive integrity');

  /* And the archive-integrity token stays CONFINED to its own resolver, whose
   * reachability chain terminates in the archive loader. This both allows the
   * legitimate b642 archive use and proves it cannot leak sideways. */
  assert.ok(functionBody(importer, 'getTrustedIntegrityFn').includes('readSavedChatArchiveIntegrityV1'),
    'the archive-integrity resolver no longer resolves the trusted archive command');
  for (const fn of ['loadArchiveCandidate', 'readBoundPackageSnapshotJson', 'trustedOccupantFor']) {
    assert.ok(functionBody(importer, fn), `archive path function not found: ${fn}`);
  }
  assert.ok(functionBody(importer, 'loadArchiveCandidate').includes('readBoundPackageSnapshotJson'),
    'the archive path no longer performs the b642 bound read');
  const total = importer.split('readSavedChatArchiveIntegrityV1').length - 1;
  const inResolver = functionBody(importer, 'getTrustedIntegrityFn')
    .split('readSavedChatArchiveIntegrityV1').length - 1;
  assert.equal(total - inResolver, 0,
    'the trusted archive command is named outside its single archive-path resolver');
});

/* ── P3.5.6B: mapper trust-domain ownership ─────────────────────────────── */

check('mapInspectStatus is retired, with no production consumer anywhere', () => {
  const consumers = productionFiles().filter((rel) => codeOf(rel).includes('mapInspectStatus'));
  assert.deepEqual(consumers, [], 'the temporary M08 legacy mapper is gone from production');
});

check('mapTrustedInspectStatus is module-internal', () => {
  const INSPECTOR = `${ING}saved-chat-archive-inspector.studio.js`;
  const elsewhere = productionFiles()
    .filter((rel) => rel !== INSPECTOR)
    .filter((rel) => codeOf(rel).includes('mapTrustedInspectStatus'));
  assert.deepEqual(elsewhere, [], 'the trusted mapper must not be reachable outside the Inspector');
  assert.ok(!/mapTrustedInspectStatus\s*:/.test(readRepo(INSPECTOR)),
    'and it must not be exported from the Inspector either');
});

console.log('');
if (FAIL.length) {
  console.log(`[saved-chat-legacy-integrity-reachability] ${FAIL.length} failed, ${PASS.length} passed`);
  process.exit(1);
}
console.log(`[saved-chat-legacy-integrity-reachability] all ${PASS.length} checks passed`);
