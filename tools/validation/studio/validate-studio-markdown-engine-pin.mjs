#!/usr/bin/env node
// M03 P2 S2A T4 S1 - Markdown engine pin, notice and version-parity validator.
//
// Proves the vendored markdown-it admission stays exactly what governance
// admitted: byte-verbatim artifact, a nine-field PIN, one deterministic notice
// artifact covering exactly the six physically incorporated projects, and
// engine-level version parity across Studio and Mobile.
//
// Deliberately NOT asserted (GOV Prompt 70 section 8): equality between the
// transitive versions frozen inside the upstream browser UMD and the transitive
// versions Mobile resolves under the root lockfile. markdown-it declares ranges;
// Mobile may legitimately resolve a different compatible patch. Behavioural
// drift is caught by the semantic parity check in the conformance validator,
// not by forcing false version equality here.

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), '..', '..', '..');
const MD_DIR = path.join(REPO_ROOT, 'src-surfaces-base/studio/renderer/markdown');
const VENDOR_DIR = path.join(MD_DIR, 'vendor/markdown-it');
const PIN_PATH = path.join(VENDOR_DIR, 'PIN.json');
const NOTICE_PATH = path.join(VENDOR_DIR, 'THIRD_PARTY_NOTICES');
const ARTIFACT_PATH = path.join(VENDOR_DIR, 'markdown-it.umd.min.js');

const EXPECTED_PIN_FIELDS = [
  'name', 'version', 'artifact', 'sha256',
  'npmIntegrity', 'source', 'license', 'incorporatedProjects', 'reviewedAt',
];
const EXPECTED_ARTIFACT_SHA256 =
  'f9f377ca892291fbe32904e77a00c6e27e8f95c14f435a54c8cb6859b3d97692';
const EXPECTED_NPM_INTEGRITY =
  'sha512-9/7gE95FNPkfUWrjJIoHZza2iLmuJlPD0UNMxPi7bxUrbCR525YZY0r+zyfes0dZI5ZZ/uNIXUJca0pJvtw41g==';
const EXPECTED_SOURCE =
  'https://registry.npmjs.org/markdown-it/-/markdown-it-15.0.1.tgz';
const ENGINE_VERSION = '15.0.1';
const EXPECTED_INCORPORATED = [
  { name: 'entities', version: '8.1.0', license: 'BSD-2-Clause' },
  { name: 'linkify-it', version: '6.1.0', license: 'MIT' },
  { name: 'markdown-it', version: '15.0.1', license: 'MIT' },
  { name: 'mdurl', version: '2.1.0', license: 'MIT' },
  { name: 'punycode.js', version: '2.3.1', license: 'MIT' },
  { name: 'uc.micro', version: '3.0.0', license: 'MIT' },
];
const EXPECTED_VENDOR_FILES = ['PIN.json', 'THIRD_PARTY_NOTICES', 'markdown-it.umd.min.js'];

const pinRaw = fs.readFileSync(PIN_PATH, 'utf8');
const pin = JSON.parse(pinRaw);
const noticeText = fs.readFileSync(NOTICE_PATH, 'utf8');

const checks = [];
const failures = [];
function check(label, fn) {
  try { fn(); checks.push(label); console.log(`✓ ${label}`); }
  catch (e) { failures.push(label); console.log(`✗ ${label}\n    ${e.message}`); }
}
/* A RED control proves the corresponding assertion is not vacuous: the same
 * predicate must REJECT a deliberately broken input. */
function mustReject(what, fn) {
  let threw = false;
  try { fn(); } catch { threw = true; }
  assert.ok(threw, `non-vacuity control failed: ${what} was accepted`);
}

/* Parse the notice artifact into entries. Entry headers are delimited by a rule
 * line, then Project/Version/License/Source, then the verbatim body. */
function parseNotice(text) {
  const entries = [];
  const re = /^Project:\s*(.+)$\n^Version:\s*(.+)$\n^License:\s*(.+)$\n^Source:\s*(.+)$/gm;
  let m;
  const marks = [];
  while ((m = re.exec(text)) !== null) {
    marks.push({ name: m[1].trim(), version: m[2].trim(), license: m[3].trim(), source: m[4].trim(), at: m.index + m[0].length });
  }
  for (let i = 0; i < marks.length; i += 1) {
    const start = marks[i].at;
    const end = i + 1 < marks.length ? text.lastIndexOf('\nProject:', marks[i + 1].at) : text.length;
    const body = text.slice(start, end).replace(/^[=\s]+/, '').replace(/[=\s]+$/, '');
    entries.push({ ...marks[i], body });
  }
  return entries;
}
const noticeEntries = parseNotice(noticeText);

// ---------------------------------------------------------------- PIN schema

check('PIN declares exactly the nine governed fields in the governed order', () => {
  assert.deepEqual(Object.keys(pin), EXPECTED_PIN_FIELDS);
  mustReject('a reordered PIN', () => {
    const swapped = ['version', 'name', ...EXPECTED_PIN_FIELDS.slice(2)];
    assert.deepEqual(swapped, EXPECTED_PIN_FIELDS);
  });
  mustReject('a PIN missing a field', () => {
    assert.deepEqual(EXPECTED_PIN_FIELDS.slice(0, 8), EXPECTED_PIN_FIELDS);
  });
});

check('PIN records the admitted engine identity, artifact and provenance', () => {
  assert.equal(pin.name, 'markdown-it');
  assert.equal(pin.version, ENGINE_VERSION);
  assert.equal(pin.artifact, 'dist/browser/markdown-it.umd.min.js');
  assert.equal(pin.npmIntegrity, EXPECTED_NPM_INTEGRITY);
  assert.equal(pin.source, EXPECTED_SOURCE);
  assert.equal(pin.reviewedAt, '2026-09-10');
});

check('vendored artifact is byte-verbatim at the pinned SHA-256', () => {
  const bytes = fs.readFileSync(ARTIFACT_PATH);
  assert.ok(bytes.length > 0, 'artifact is empty');
  const digest = crypto.createHash('sha256').update(bytes).digest('hex');
  assert.equal(digest, EXPECTED_ARTIFACT_SHA256, 'artifact bytes changed');
  assert.equal(pin.sha256, EXPECTED_ARTIFACT_SHA256, 'PIN sha256 drifted');
  mustReject('a mutated artifact', () => {
    const mutated = crypto.createHash('sha256').update(Buffer.concat([bytes, Buffer.from(' ')])).digest('hex');
    assert.equal(mutated, EXPECTED_ARTIFACT_SHA256);
  });
});

check('PIN top-level licence is the markdown-it PACKAGE licence, not an artifact-wide claim', () => {
  assert.equal(pin.license, 'MIT');
  /* The artifact is not MIT-only, and the documentation must say so. */
  const readme = fs.readFileSync(path.join(MD_DIR, 'README.md'), 'utf8');
  assert.match(readme, /not\s+MIT-only/i, 'README must state the artifact is not MIT-only');
  assert.match(readme, /BSD-2-Clause/, 'README must name the BSD-2-Clause component');
});

// ------------------------------------------------- incorporated project set

check('PIN incorporates exactly the six proven projects, ASCII-ordered', () => {
  assert.equal(pin.incorporatedProjects.length, 6);
  assert.deepEqual(pin.incorporatedProjects, EXPECTED_INCORPORATED);
  const names = pin.incorporatedProjects.map((p) => p.name);
  assert.deepEqual(names, [...names].sort(), 'incorporatedProjects must be ASCII ascending');
  for (const p of pin.incorporatedProjects) {
    assert.deepEqual(Object.keys(p), ['name', 'version', 'license']);
  }
  mustReject('an out-of-order project list', () => {
    const bad = ['mdurl', 'entities'];
    assert.deepEqual(bad, [...bad].sort());
  });
});

check('entities is recorded BSD-2-Clause and the other five MIT', () => {
  const byName = Object.fromEntries(pin.incorporatedProjects.map((p) => [p.name, p.license]));
  assert.equal(byName.entities, 'BSD-2-Clause');
  for (const n of ['linkify-it', 'markdown-it', 'mdurl', 'punycode.js', 'uc.micro']) {
    assert.equal(byName[n], 'MIT', `${n} licence drifted`);
  }
});

check('argparse appears in neither the PIN nor the delivered notice', () => {
  const names = pin.incorporatedProjects.map((p) => p.name);
  assert.ok(!names.includes('argparse'), 'argparse must not be an incorporated project');
  assert.ok(!/argparse/i.test(pinRaw), 'PIN must not mention argparse');
  assert.ok(!/argparse/i.test(noticeText), 'delivered notice must not mention argparse');
  mustReject('a notice containing argparse', () => {
    assert.ok(!/argparse/i.test('Project: argparse'), 'should reject');
  });
});

// --------------------------------------------------------- vendor directory

check('vendor directory holds exactly the three governed files and no LICENSE', () => {
  const actual = fs.readdirSync(VENDOR_DIR).sort();
  assert.deepEqual(actual, EXPECTED_VENDOR_FILES);
  assert.ok(!actual.some((f) => /^LICEN[SC]E/i.test(f)), 'no standalone LICENSE may exist here');
  assert.ok(!actual.some((f) => /\.map$/.test(f)), 'no source map may be vendored');
});

check('the H2O first-party sources live OUTSIDE the vendor directory', () => {
  for (const f of ['h2o-gfm.v1.js', 'markdown-engine.v1.js', 'markdown-ir-adapter.v1.js']) {
    assert.ok(fs.existsSync(path.join(MD_DIR, f)), `${f} must exist as first-party source`);
    assert.ok(!fs.existsSync(path.join(VENDOR_DIR, f)), `${f} must not be inside vendor/`);
  }
});

// ------------------------------------------------------------------- notice

check('notice covers exactly the PIN incorporated-project set', () => {
  assert.equal(noticeEntries.length, 6, `parsed ${noticeEntries.length} notice entries, expected 6`);
  const noticeNames = noticeEntries.map((e) => e.name);
  const pinNames = pin.incorporatedProjects.map((p) => p.name);
  assert.deepEqual(noticeNames, pinNames, 'notice project set/order must equal the PIN set');
  mustReject('a notice missing a project', () => {
    assert.deepEqual(['linkify-it', 'markdown-it', 'mdurl', 'punycode.js', 'uc.micro'], pinNames);
  });
  mustReject('a notice with an extra project', () => {
    assert.deepEqual([...pinNames, 'argparse'], pinNames);
  });
});

check('notice versions and SPDX identifiers agree with the PIN', () => {
  for (const p of pin.incorporatedProjects) {
    const e = noticeEntries.find((x) => x.name === p.name);
    assert.ok(e, `missing notice entry for ${p.name}`);
    assert.equal(e.version, p.version, `${p.name} version disagrees`);
    assert.equal(e.license, p.license, `${p.name} SPDX identifier disagrees`);
  }
});

check('every notice entry carries non-empty verbatim licence material', () => {
  for (const e of noticeEntries) {
    assert.ok(e.body.length > 200, `${e.name} licence body is too short to be verbatim text (${e.body.length} chars)`);
    assert.match(e.body, /copyright/i, `${e.name} body must retain its upstream copyright notice`);
    assert.match(e.body, /WARRANT|AS IS/i, `${e.name} body must retain its warranty disclaimer`);
    assert.match(e.source, new RegExp(`${e.name.replace('.', '\\.')}@${e.version.replace(/\./g, '\\.')}`),
      `${e.name} must cite its OWN package at the incorporated version`);
  }
});

// ----------------------------------------------------------- version parity

check('Studio PIN and Mobile package declare the same exact engine version', () => {
  const mobile = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'apps/studio/mobile/package.json'), 'utf8'));
  const spec = mobile.dependencies['markdown-it'];
  assert.equal(spec, ENGINE_VERSION, 'Mobile must pin markdown-it exactly');
  assert.ok(!/[\^~><=|*\s]/.test(spec), `Mobile spec must carry no range operator, got ${spec}`);
  assert.equal(pin.version, ENGINE_VERSION);
});

check('root package.json declares no markdown-it dependency in any field', () => {
  const root = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    assert.ok(!(root[field] && root[field]['markdown-it']),
      `markdown-it must not appear in root ${field}`);
  }
});

check('root lockfile resolves markdown-it 15.0.1 at the pinned npm integrity', () => {
  const lock = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package-lock.json'), 'utf8'));
  const entry = lock.packages['node_modules/markdown-it'];
  assert.ok(entry, 'lockfile has no markdown-it entry');
  assert.equal(entry.version, ENGINE_VERSION);
  assert.equal(entry.integrity, EXPECTED_NPM_INTEGRITY, 'lockfile integrity must match the pinned engine package');
  const mobileDeps = lock.packages['apps/studio/mobile'].dependencies;
  assert.equal(mobileDeps['markdown-it'], ENGINE_VERSION, 'lockfile must record the Mobile exact spec');
});

// ------------------------------------------------- no production admission

check('no Stage-A carrier or Stage-B loader references the vendored engine', () => {
  const guarded = [
    'tools/product/studio/pack-studio.mjs',
    'src-surfaces-base/studio/studio.html',
    'tools/publish/lean-publisher.mjs',
    'tools/publish/lean-activator.mjs',
  ];
  let scanned = 0;
  for (const rel of guarded) {
    const abs = path.join(REPO_ROOT, rel);
    if (!fs.existsSync(abs)) continue;
    scanned += 1;
    const text = fs.readFileSync(abs, 'utf8');
    assert.ok(!/markdown-it|markdown-engine\.v1|markdown-ir-adapter\.v1|h2o-gfm\.v1/.test(text),
      `${rel} must not reference the unwired markdown engine (Stage A/B are forbidden in S1)`);
  }
  assert.equal(scanned, guarded.length,
    `non-vacuity: expected to scan all ${guarded.length} carrier/loader files, scanned ${scanned}`);
  console.log(`    (scanned ${scanned} production carrier/loader files)`);
});

console.log(failures.length ? `FAIL ${failures.length} (passed ${checks.length})` : `PASS ${checks.length}`);
process.exit(failures.length ? 1 : 0);
