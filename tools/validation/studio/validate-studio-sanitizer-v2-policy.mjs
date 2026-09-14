#!/usr/bin/env node
// Tier 1 (no-DOM) validation for the Renderer sanitizer v2 policy and adapter.
//
// Tier 1 proves policy decisions, API shape and fail-closed behavior. It does
// NOT pretend to prove DOM-parser security: that is the real-browser oracle in
// validate-studio-sanitizer-v2-dom.mjs.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), '..', '..', '..');
const POLICY_REL = 'src-surfaces-base/studio/renderer/safety/sanitizer-policy.v1.js';
const ADAPTER_REL = 'src-surfaces-base/studio/renderer/safety/html-sanitizer.v2.js';
const V1_REL = 'src-surfaces-base/studio/platform/html-sanitizer.js';
const CASES_REL = 'tools/validation/fixtures/studio-renderer-sanitizer/sanitizer-cases.v1.json';

const policySource = fs.readFileSync(path.join(REPO_ROOT, POLICY_REL), 'utf8');
const adapterSource = fs.readFileSync(path.join(REPO_ROOT, ADAPTER_REL), 'utf8');
const corpus = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, CASES_REL), 'utf8'));

/* Bumped from 1 by the pre-wiring URL hardening: schemeless relative,
 * fragment-only and http image sources now fail closed. A policy-semantic
 * change must be explicit, so the version moves with it. */
const EXPECTED_POLICY_VERSION = 2;

/* Source assertions must read code, not prose: both modules discuss the engine
 * and the DOM in comments, so a bare substring search would pass on a
 * disclaimer alone. */
function stripComments(source) {
  let out = '';
  let i = 0;
  let quote = '';
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    if (quote) {
      if (ch === '\\') { out += ch + (next ?? ''); i += 2; continue; }
      if (ch === quote) quote = '';
      out += ch; i += 1; continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; out += ch; i += 1; continue; }
    if (ch === '/' && next === '*') { const e = source.indexOf('*/', i + 2); i = e === -1 ? source.length : e + 2; out += ' '; continue; }
    if (ch === '/' && next === '/') { const e = source.indexOf('\n', i); i = e === -1 ? source.length : e; out += ' '; continue; }
    out += ch; i += 1;
  }
  return out;
}

const policyCode = stripComments(policySource);
const adapterCode = stripComments(adapterSource);

/* No window, no document, no DOMPurify: a DOM-free sandbox on purpose. */
function loadSandbox({ withEngine = false } = {}) {
  const sandbox = vm.createContext({ console });
  sandbox.globalThis = sandbox;
  if (withEngine) sandbox.DOMPurify = { version: '3.4.15', isSupported: true, sanitize: () => '', addHook: () => {} };
  vm.runInContext(policySource, sandbox, { filename: POLICY_REL });
  vm.runInContext(adapterSource, sandbox, { filename: ADAPTER_REL });
  return sandbox;
}

const sandbox = loadSandbox();
const policy = sandbox.H2O?.Studio?.Renderer?.sanitizerPolicy;
const sanitizer = sandbox.H2O?.Studio?.Renderer?.htmlSanitizer;
assert.ok(policy, 'sanitizer policy did not register');
assert.ok(sanitizer, 'sanitizer v2 adapter did not register');

const checks = [];
function check(label, fn) {
  fn();
  checks.push(label);
  console.log(`\u2713 ${label}`);
}

check('policy loads and operates with no window, document or engine present', () => {
  assert.equal(typeof sandbox.window, 'undefined');
  assert.equal(typeof sandbox.document, 'undefined');
  assert.equal(policy.policyId, 'h2o.renderer.html-sanitizer-policy');
  assert.equal(policy.policyVersion, EXPECTED_POLICY_VERSION);
  assert.doesNotMatch(policyCode, /document\.|window\.|querySelector|createElement|DOMPurify|innerHTML|outerHTML/);
});

check('policy is frozen and deterministic', () => {
  assert.equal(Object.isFrozen(policy), true);
  assert.equal(Object.isFrozen(policy.allowedTags), true);
  assert.equal(Object.isFrozen(policy.allowedSchemes.link), true);
  assert.throws(() => { policy.allowedTags.push('script'); });
  const a = policy.describe('content');
  const b = policy.describe('content');
  assert.deepEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)));
  assert.equal(Object.isFrozen(a), true);
  for (const value of ['javascript:alert(1)', 'https://a.test']) {
    assert.deepEqual({ ...policy.classifyUrl(value, 'link') }, { ...policy.classifyUrl(value, 'link') });
  }
});

check('policy version and engine version are not conflated', () => {
  assert.equal(policy.policyVersion, EXPECTED_POLICY_VERSION);
  assert.equal(sanitizer.policyVersion, policy.policyVersion);
  assert.equal(sanitizer.engine, 'dompurify');
  assert.equal(sanitizer.engineVersion, '3.4.15');
  assert.notEqual(String(sanitizer.engineVersion), String(sanitizer.policyVersion));
  const d = sanitizer.diagnose();
  assert.equal(d.policyVersion, EXPECTED_POLICY_VERSION);
  assert.equal(d.engineVersion !== undefined, true);
  assert.notEqual(d.policyId, d.engine);
});

check('tag decisions follow the policy allowlist', () => {
  for (const tag of ['p', 'h1', 'ul', 'li', 'table', 'td', 'a', 'img', 'blockquote', 'pre', 'code', 'figure', 'details']) {
    assert.equal(policy.isAllowedTag(tag, 'content'), true, `${tag} should be allowed`);
  }
  for (const tag of ['script', 'style', 'iframe', 'object', 'embed', 'form', 'input', 'base', 'meta', 'svg', 'math', 'template', 'noscript', 'link']) {
    assert.equal(policy.isAllowedTag(tag, 'content'), false, `${tag} must be rejected`);
  }
  for (const tag of ['my-widget', 'x-foo', 'ion-button']) {
    assert.equal(policy.isCustomElementName(tag), true, `${tag} should read as a custom element`);
    assert.equal(policy.isAllowedTag(tag, 'content'), false, `${tag} must be rejected`);
  }
  assert.throws(() => policy.isAllowedTag('p', 'replayCompat'), /unsupported profile/);
});

check('attribute decisions reject handlers, identity and unsafe surfaces', () => {
  for (const [tag, attr] of [['p', 'class'], ['p', 'dir'], ['p', 'lang'], ['a', 'href'], ['a', 'target'], ['a', 'rel'], ['img', 'src'], ['img', 'alt'], ['td', 'colspan'], ['time', 'datetime']]) {
    assert.equal(policy.isAllowedAttribute(tag, attr, 'content'), true, `${tag}.${attr} should be allowed`);
  }
  for (const [tag, attr] of [['p', 'onclick'], ['p', 'OnMouseOver'], ['img', 'onerror'], ['p', 'id'], ['p', 'name'], ['p', 'style'], ['div', 'srcdoc'], ['p', 'data-h2o-turn-id'], ['p', 'data-anything'], ['form', 'action'], ['button', 'formaction'], ['img', 'srcset'], ['a', 'ping']]) {
    assert.equal(policy.isAllowedAttribute(tag, attr, 'content'), false, `${tag}.${attr} must be rejected`);
  }
  assert.equal(policy.isIdentityAttribute('id'), true);
  assert.equal(policy.isIdentityAttribute('name'), true);
  assert.equal(policy.isIdentityAttribute('data-h2o-message-id'), true);
  assert.equal(policy.isIdentityAttribute('data-provider'), false);
  /* href is a URI attribute only where the policy says so. */
  assert.equal(policy.uriContextFor('a', 'href'), 'link');
  assert.equal(policy.uriContextFor('img', 'src'), 'image');
  assert.equal(policy.uriContextFor('a', 'target'), '');
});

check('URI classifier matches every corpus URL case including digit-bearing schemes', () => {
  assert.ok(corpus.urlCases.length >= 25, `expected a substantive URL corpus, got ${corpus.urlCases.length}`);
  for (const c of corpus.urlCases) {
    const verdict = policy.classifyUrl(c.input, c.context);
    assert.equal(verdict.ok, c.allowed, `${c.id}: expected ok=${c.allowed} for ${JSON.stringify(c.input)}, got ${verdict.reason}`);
    assert.equal(verdict.reason, c.reason, `${c.id}: expected reason ${c.reason}, got ${verdict.reason}`);
  }
  /* The specific engine-default failures this policy exists to close. */
  for (const scheme of ['h2o://x', 'h2oapp://x', 'x2y:z']) {
    assert.equal(policy.classifyUrl(scheme, 'link').ok, false, `${scheme} must not be admitted`);
  }
  for (const denied of policy.deniedSchemes) {
    assert.equal(policy.classifyUrl(`${denied}:payload`, 'link').ok, false, `${denied}: must not be admitted in a link context`);
  }
});

check('pre-wiring hardening: relative, fragment and http image sources fail closed', () => {
  assert.equal(corpus.policyVersion, policy.policyVersion, 'corpus policyVersion drifted from the policy');
  /* A. schemeless relative values gain no same-origin navigation capability. */
  for (const value of ['./some-local-path', '../foo', '/settings', 'foo.html', 'docs/page']) {
    const verdict = policy.classifyUrl(value, 'link');
    assert.equal(verdict.ok, false, `${value} must fail closed`);
    assert.equal(verdict.reason, 'relative-not-allowed');
  }
  /* B. fragment-only values cannot reach Studio hash routing. */
  for (const value of ['#fragment', '#/saved', '#/read/test', '#/library/all']) {
    const verdict = policy.classifyUrl(value, 'link');
    assert.equal(verdict.ok, false, `${value} must fail closed`);
    assert.equal(verdict.reason, 'fragment-not-allowed');
  }
  /* C. image sources are https or constrained raster data: only. */
  assert.equal(policy.allowedSchemes.image.includes('http'), false, 'http must not be an image scheme');
  assert.deepEqual([...policy.allowedSchemes.image], ['https', 'data']);
  assert.equal(policy.classifyUrl('http://example.test/i.png', 'image').ok, false);
  assert.equal(policy.classifyUrl('https://example.test/i.png', 'image').ok, true);
  assert.equal(policy.classifyUrl('data:image/png;base64,iVBORw0KGgo=', 'image').ok, true);
  assert.equal(policy.classifyUrl('data:image/svg+xml,x', 'image').ok, false);
  /* D. protocol-relative rejection is retained. */
  assert.equal(policy.classifyUrl('//evil.example', 'link').reason, 'protocol-relative');
  /* Link href policy was deliberately NOT narrowed alongside images. */
  assert.equal(policy.classifyUrl('http://example.test/a', 'link').ok, true);
  /* No admission path survives that returns a permissive "relative" verdict. */
  for (const context of ['link', 'image']) {
    for (const value of ['/x', './x', '#x']) {
      assert.notEqual(policy.classifyUrl(value, context).reason, 'relative');
    }
  }
});

check('adapter never calls setConfig and exposes no engine config mutation', () => {
  assert.doesNotMatch(adapterCode, /\.setConfig\s*\(/, 'Renderer v2 must never call setConfig');
  assert.doesNotMatch(adapterCode, /setConfig\s*\(/, 'Renderer v2 must never call setConfig');
  assert.equal(sanitizer.diagnose().usesSetConfig, false);
  /* Complete config is passed on every sanitize call. */
  assert.match(adapterCode, /sanitize\(\s*source\s*,\s*STRING_CONFIG\s*\)/);
  assert.match(adapterCode, /sanitize\(\s*source\s*,\s*FRAGMENT_CONFIG\s*\)/);
  for (const forbidden of ['setConfig', 'addHook', 'removeHook', 'removeHooks', 'config', 'engineInstance']) {
    assert.equal(Object.prototype.hasOwnProperty.call(sanitizer, forbidden), false, `adapter must not expose ${forbidden}`);
  }
  assert.equal(Object.isFrozen(sanitizer), true);
  assert.equal(sanitizer.sanitizeHtml.length, 1, 'callers pass content only, never a config');
  assert.equal(sanitizer.sanitizeToFragment.length, 1, 'callers pass content only, never a config');
});

check('adapter fails closed when the engine is absent', () => {
  assert.equal(sanitizer.isSupported(), false);
  assert.equal(sanitizer.diagnose().engineAvailable, false);
  assert.equal(sanitizer.diagnose().engineStatus, 'engine-absent');
  assert.throws(() => sanitizer.sanitizeHtml('<p>x</p>'), /sanitization unavailable/);
  assert.throws(() => sanitizer.sanitizeToFragment('<p>x</p>'), /sanitization unavailable/);
  /* Never returns the input as a "successful" result. */
  let returned;
  try { returned = sanitizer.sanitizeHtml('<script>alert(1)</script>'); } catch (_) { returned = undefined; }
  assert.equal(returned, undefined);
});

check('adapter rejects a mismatched engine version rather than trusting it', () => {
  const box = vm.createContext({ console });
  box.globalThis = box;
  box.DOMPurify = { version: '3.4.14', isSupported: true, sanitize: () => 'x', addHook: () => {} };
  vm.runInContext(policySource, box);
  vm.runInContext(adapterSource, box);
  const wrapper = box.H2O.Studio.Renderer.htmlSanitizer;
  assert.equal(wrapper.isSupported(), false);
  assert.equal(wrapper.diagnose().engineStatus, 'engine-version-mismatch');
  assert.throws(() => wrapper.sanitizeHtml('<p>x</p>'), /sanitization unavailable/);
});

check('adapter captures the engine singleton and clears the global as hygiene', () => {
  const withEngine = loadSandbox({ withEngine: true });
  const wrapper = withEngine.H2O.Studio.Renderer.htmlSanitizer;
  assert.equal(wrapper.isSupported(), true);
  assert.equal(withEngine.DOMPurify, undefined, 'global engine reference should be cleared after capture');
  /* A second private instance is never constructed. */
  assert.doesNotMatch(adapterCode, /DOMPurify\s*\(\s*window\s*\)/);
});

check('input contract: non-string throws, oversized input fails closed', () => {
  /* The module runs in a vm sandbox, so its TypeError comes from that realm:
   * assert on the error identity and message rather than a host constructor. */
  for (const bad of [null, {}, 42, undefined, ['<p>x</p>']]) {
    assert.throws(() => sanitizer.sanitizeHtml(bad), (error) => {
      assert.equal(error.name, 'TypeError');
      assert.match(error.message, /input must be a string/);
      return true;
    }, `non-string input ${JSON.stringify(bad)} must throw a TypeError`);
  }
  assert.equal(policy.isWithinBudget('x'.repeat(policy.maxInputBytes)), true);
  assert.equal(policy.isWithinBudget('x'.repeat(policy.maxInputBytes + 1)), false);
  const withEngine = loadSandbox({ withEngine: true }).H2O.Studio.Renderer.htmlSanitizer;
  assert.throws(() => withEngine.sanitizeHtml('x'.repeat(policy.maxInputBytes + 1)), /exceeds the sanitization guard/);
});

check('sanitizeUrl fails closed with removal, never a placeholder', () => {
  assert.equal(sanitizer.sanitizeUrl('https://example.test/a', 'link'), 'https://example.test/a');
  for (const bad of ['javascript:alert(1)', 'h2o://x', 'file:///etc/passwd', 'data:text/html,x']) {
    assert.equal(sanitizer.sanitizeUrl(bad, 'link'), '', `${bad} must yield empty`);
  }
  assert.notEqual(sanitizer.sanitizeUrl('javascript:alert(1)', 'link'), '#');
  assert.doesNotMatch(adapterCode, /["']#["']/, 'no placeholder URL substitution in the adapter');
});

check('v1 compatibility surface stays separate and untouched by v2', () => {
  const box = vm.createContext({ console });
  box.globalThis = box;
  vm.runInContext(fs.readFileSync(path.join(REPO_ROOT, V1_REL), 'utf8'), box);
  vm.runInContext(policySource, box);
  vm.runInContext(adapterSource, box);
  const v1 = box.H2O.Studio.html.sanitize;
  assert.equal(v1.__version, '0.1.0-phase-c-c3.1', 'v2 must not disturb the frozen v1 surface');
  assert.equal(v1.sanitizeHtml('<p onclick="x">a</p>'), '<p>a</p>');
  assert.notEqual(box.H2O.Studio.Renderer.htmlSanitizer.policyId, v1.__version);
  /* v2 does not reach into the v1 module. */
  assert.doesNotMatch(adapterCode, /H2O\.Studio\.html\.sanitize|sanitizeHtml\s*:\s*H2O/);
  assert.doesNotMatch(policyCode, /H2O\.Studio\.html\.sanitize/);
});

console.log(`PASS ${checks.length}`);
