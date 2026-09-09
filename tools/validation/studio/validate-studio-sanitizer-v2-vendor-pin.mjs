#!/usr/bin/env node
// Tier 1 vendor-pin validation for the Renderer sanitizer v2 engine.
//
// This pins the SHA-256 of a VENDORED THIRD-PARTY artifact so admitted bytes
// cannot drift. That is the opposite of the shared v1 sanitizer, whose contract
// is behavioral and deliberately not SHA-pinned.

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), '..', '..', '..');
const VENDOR_DIR = 'src-surfaces-base/studio/renderer/safety/vendor/dompurify';
const ADAPTER_REL = 'src-surfaces-base/studio/renderer/safety/html-sanitizer.v2.js';
const POLICY_REL = 'src-surfaces-base/studio/renderer/safety/sanitizer-policy.v1.js';

const EXPECTED = Object.freeze({
  name: 'dompurify',
  version: '3.4.15',
  artifact: 'dist/purify.js',
  sha256: '979b6c28df92881a36009de0bda1e866bee043ad69d36e54509e7210723d9af4',
  npmIntegrity: 'sha512-EUBjM+B+lkDE41iE82DDSCfkoPGfXx8IxFxPMjNzm/Uk4xDet77rTN9wqlxlVg71kK7XGuUMv6wUxJUwwv+Xyw==',
  source: 'https://registry.npmjs.org/dompurify/-/dompurify-3.4.15.tgz',
  license: 'Apache-2.0 (elected from: MPL-2.0 OR Apache-2.0)',
});
const PIN_FIELDS = Object.freeze(['name', 'version', 'artifact', 'sha256', 'npmIntegrity', 'source', 'license', 'reviewedAt']);

function repo(rel) { return path.join(REPO_ROOT, rel); }
function sha256(buffer) { return crypto.createHash('sha256').update(buffer).digest('hex'); }

const pin = JSON.parse(fs.readFileSync(repo(`${VENDOR_DIR}/PIN.json`), 'utf8'));
const engineBytes = fs.readFileSync(repo(`${VENDOR_DIR}/purify.js`));
const licenseText = fs.readFileSync(repo(`${VENDOR_DIR}/LICENSE`), 'utf8');

const checks = [];
function check(label, fn) {
  fn();
  checks.push(label);
  console.log(`✓ ${label}`);
}

check('PIN.json carries exactly the agreed field set', () => {
  assert.deepEqual(Object.keys(pin), [...PIN_FIELDS], 'PIN fields must match the agreed set exactly, in order');
});

check('PIN.json records the accepted engine identity and provenance', () => {
  for (const [key, value] of Object.entries(EXPECTED)) {
    assert.equal(pin[key], value, `PIN.${key} mismatch`);
  }
  assert.match(pin.reviewedAt, /^\d{4}-\d{2}-\d{2}(?:T[\d:.]+Z?)?$/, 'reviewedAt must be an ISO-8601 date');
});

check('vendored purify.js matches the pinned SHA-256 exactly', () => {
  const actual = sha256(engineBytes);
  assert.equal(actual, EXPECTED.sha256, 'vendored engine bytes drifted from the accepted artifact');
  assert.equal(actual, pin.sha256, 'vendored engine bytes do not match PIN.json');
});

check('upstream licence banner is preserved byte-for-byte', () => {
  const head = engineBytes.toString('utf8').split('\n')[0];
  assert.equal(
    head,
    '/*! @license DOMPurify 3.4.15 | (c) Cure53 and other contributors | Released under the Apache license 2.0 and Mozilla Public License 2.0 | github.com/cure53/DOMPurify/blob/3.4.15/LICENSE */',
    'the upstream licence banner must not be altered'
  );
});

check('elected Apache-2.0 licence text is vendored alongside the engine', () => {
  assert.match(licenseText, /Apache License/, 'LICENSE must be the elected Apache-2.0 text');
  assert.match(licenseText, /Version 2\.0, January 2004/);
  assert.doesNotMatch(licenseText.slice(0, 200), /Mozilla Public License/, 'the elected licence is Apache-2.0, not MPL');
  assert.match(pin.license, /^Apache-2\.0 \(elected from: MPL-2\.0 OR Apache-2\.0\)$/);
});

check('the vendored engine reports the pinned version in its own bytes', () => {
  assert.match(engineBytes.toString('utf8'), /version = '3\.4\.15'/, 'engine version constant must be 3.4.15');
});

check('the vendor directory holds only the admitted files', () => {
  const entries = fs.readdirSync(repo(VENDOR_DIR)).sort();
  assert.deepEqual(entries, ['LICENSE', 'PIN.json', 'purify.js'], `unexpected vendor contents: ${entries.join(', ')}`);
});

check('exactly one engine copy exists and only the adapter references it', () => {
  const copies = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (/^purify(?:\.min)?\.js$/.test(entry.name)) copies.push(path.relative(REPO_ROOT, full));
    }
  })(repo('src-surfaces-base'));
  assert.deepEqual(copies, [`${VENDOR_DIR}/purify.js`], `expected exactly one vendored engine, found: ${copies.join(', ')}`);

  /* The pure policy must not know the engine exists. */
  assert.doesNotMatch(fs.readFileSync(repo(POLICY_REL), 'utf8'), /DOMPurify|purify/i);
  /* The adapter is the sole Renderer code that talks to the engine. */
  assert.match(fs.readFileSync(repo(ADAPTER_REL), 'utf8'), /global\.DOMPurify/);
});

check('no package dependency was added for the engine', () => {
  const pkgPath = repo('package.json');
  if (!fs.existsSync(pkgPath)) return;
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    const deps = pkg[field] || {};
    assert.equal(Object.prototype.hasOwnProperty.call(deps, 'dompurify'), false, `dompurify must not appear in ${field}`);
    assert.equal(Object.prototype.hasOwnProperty.call(deps, 'playwright'), false, `playwright must not appear in ${field}`);
  }
});

console.log(`PASS ${checks.length}`);
