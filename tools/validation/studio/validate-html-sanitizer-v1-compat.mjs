#!/usr/bin/env node
// Renderer-side v1 compatibility evidence for the sanitizer v1/v2 boundary
// (M03 P1 S1A T1).
//
// The frozen obligation is BEHAVIORAL, not source-byte identity: while Storage
// keeps consuming H2O.Studio.html.sanitize for Saved-Chat projection, the
// projector-observable output bytes of sanitizeHtml, escapeHtml and
// extractTextFromHtml must not move, because they feed snapshot/projector
// content and therefore projection contentHash and archive freshness.
//
// Deliberately NOT asserted here:
//   - the SHA256 or internal bytes of html-sanitizer.js;
//   - its physical path as an eternal authority rule;
//   - sanitizeUrl / isSafeUrl / diagnose(), including diagnose().mode.
//
// SCOPE LIMITATION: this is compatibility EVIDENCE over a representative
// projector-relevant corpus. It is not a proof of exhaustive equivalence for
// every possible input string.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), '..', '..', '..');
const SANITIZER_REL = 'src-surfaces-base/studio/platform/html-sanitizer.js';
const STORAGE_PROJECTOR_REL = 'src-surfaces-base/studio/ingestion/saved-chat-package-v1.tauri.js';
const FIXTURE_REL = 'tools/validation/fixtures/studio-renderer-sanitizer/v1-compatibility-cases.json';

const sanitizerPath = process.argv[2] || path.join(REPO_ROOT, SANITIZER_REL);
const fixturePath = process.argv[3] || path.join(REPO_ROOT, FIXTURE_REL);

const sanitizerSource = fs.readFileSync(sanitizerPath, 'utf8');
const fixtures = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));

const sandbox = vm.createContext({ console });
sandbox.globalThis = sandbox;
vm.runInContext(sanitizerSource, sandbox, { filename: sanitizerPath });
const v1 = sandbox.H2O?.Studio?.html?.sanitize;
assert.ok(v1, 'v1 sanitizer API did not register on H2O.Studio.html.sanitize');

/* The three projector-observable functions under the compatibility obligation. */
const FROZEN_FUNCTIONS = ['sanitizeHtml', 'escapeHtml', 'extractTextFromHtml'];

const checks = [];
function check(label, fn) {
  fn();
  checks.push(label);
  console.log(`✓ ${label}`);
}

/*
 * Wiring assertions must read code, not prose: both files document the seam in
 * comments, so a bare substring search would pass on a disclaimer alone. Strip
 * comments (string-literal aware) and assert against the code-only view.
 */
function stripComments(source) {
  let out = '';
  let i = 0;
  let quote = '';
  while (i < source.length) {
    const c = source[i];
    const next = source[i + 1];
    if (quote) {
      if (c === '\\') { out += c + (next ?? ''); i += 2; continue; }
      if (c === quote) quote = '';
      out += c; i += 1; continue;
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; out += c; i += 1; continue; }
    if (c === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2);
      i = end === -1 ? source.length : end + 2;
      out += ' ';
      continue;
    }
    if (c === '/' && next === '/') {
      const end = source.indexOf('\n', i);
      i = end === -1 ? source.length : end;
      out += ' ';
      continue;
    }
    out += c; i += 1;
  }
  return out;
}

const storageCode = stripComments(fs.readFileSync(path.join(REPO_ROOT, STORAGE_PROJECTOR_REL), 'utf8'));

check('exposes the v1 compatibility surface at the recorded version', () => {
  assert.equal(v1.__installed, true);
  assert.equal(v1.__version, '0.1.0-phase-c-c3.1');
  assert.equal(fixtures.capturedFromVersion, v1.__version, 'fixture corpus was captured from a different v1 version');
  for (const fn of FROZEN_FUNCTIONS) assert.equal(typeof v1[fn], 'function', `${fn} must remain callable`);
});

check('fixture corpus is a materially useful projector-relevant set', () => {
  assert.equal(fixtures.schema, 'h2o.studio.html-sanitizer-v1-compatibility');
  assert.equal(fixtures.schemaVersion, 1);
  assert.ok(fixtures.cases.length >= 25, `expected a substantive corpus, got ${fixtures.cases.length}`);
  const ids = fixtures.cases.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length, 'fixture case ids must be unique');
  for (const required of [
    'plain-text', 'safe-basic-markup', 'safe-nested-markup', 'dangerous-script',
    'dangerous-c31-tags', 'event-attr-onclick', 'uri-javascript', 'uri-vbscript',
    'uri-data-text-html', 'entities-named-and-numeric', 'malformed-unclosed',
    'extract-multiline-blocks', 'empty-string',
  ]) {
    assert.ok(ids.includes(required), `corpus is missing required case: ${required}`);
  }
});

check('sanitizeHtml output bytes are unchanged for every corpus case', () => {
  for (const c of fixtures.cases) {
    assert.equal(v1.sanitizeHtml(c.input), c.expect.sanitizeHtml, `sanitizeHtml drifted for case ${c.id}`);
  }
});

check('escapeHtml output bytes are unchanged for every corpus case', () => {
  for (const c of fixtures.cases) {
    assert.equal(v1.escapeHtml(c.input), c.expect.escapeHtml, `escapeHtml drifted for case ${c.id}`);
  }
});

check('extractTextFromHtml output bytes are unchanged for every corpus case', () => {
  for (const c of fixtures.cases) {
    assert.equal(v1.extractTextFromHtml(c.input), c.expect.extractTextFromHtml, `extractTextFromHtml drifted for case ${c.id}`);
  }
});

check('the frozen functions are deterministic across repeated calls', () => {
  for (const c of fixtures.cases) {
    for (const fn of FROZEN_FUNCTIONS) {
      const first = v1[fn](c.input);
      assert.equal(v1[fn](c.input), first, `${fn} is non-deterministic for case ${c.id}`);
      assert.equal(v1[fn](c.input), first, `${fn} is non-deterministic for case ${c.id}`);
    }
  }
});

check('Saved-Chat projection still reaches v1 through H2O.Studio.html.sanitize', () => {
  assert.match(storageCode, /H2O\.Studio\s*&&\s*H2O\.Studio\.html\s*&&\s*H2O\.Studio\.html\.sanitize/,
    'Storage projector no longer resolves the v1 sanitizer surface in code');
  assert.match(storageCode, /function\s+escapeHtml\s*\([^)]*\)\s*\{\s*return\s+htmlSanitizer\(\)\.escapeHtml\(/,
    'Storage escapeHtml no longer delegates to v1');
  assert.match(storageCode, /function\s+sanitizeHtmlV1\s*\([^)]*\)\s*\{\s*return\s+htmlSanitizer\(\)\.sanitizeHtml\(/,
    'Storage sanitizeHtmlV1 no longer delegates to v1');
  assert.match(storageCode, /function\s+extractTextFromHtml\s*\([^)]*\)\s*\{\s*return\s+htmlSanitizer\(\)\.extractTextFromHtml\(/,
    'Storage extractTextFromHtml no longer delegates to v1');
});

check('Saved-Chat projection has not silently migrated to a Renderer v2 boundary', () => {
  assert.doesNotMatch(storageCode, /Renderer\.htmlSanitizer|renderer\/safety|DOMPurify/,
    'Storage projector references a Renderer-owned v2 sanitizer; migration must be an explicit governed act');
});

check('no Renderer sanitizer v2 engine has been vendored yet', () => {
  const safetyDir = path.join(REPO_ROOT, 'src-surfaces-base/studio/renderer/safety');
  if (fs.existsSync(safetyDir)) {
    for (const entry of fs.readdirSync(safetyDir)) {
      assert.doesNotMatch(entry, /purify/i, `unexpected vendored sanitizer engine: ${entry}`);
    }
  }
  assert.doesNotMatch(stripComments(sanitizerSource), /DOMPurify/, 'v1 must not depend on a v2 engine');
});

console.log(`PASS ${checks.length}`);
