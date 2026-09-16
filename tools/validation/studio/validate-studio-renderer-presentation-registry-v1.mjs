#!/usr/bin/env node
// M04 P2 — Renderer presentation registry: the one planned permanent registry
// validator. T4 delivered the consumer coverage (Appearance preference
// contribution, the current New UI Presentation selector and the Reader
// integration through the real seams); T5 consolidated the T3 registry-lifetime
// / stylesheet admission + scoping / N>1 neutrality coverage and the M04-P2-R02
// AC05b (HDA decision F) disclosure-interaction proof here, carrying the
// content-renderer validator's fixtures, helpers and browser harness over
// unchanged so the assertions stay enforceable.
//
// Tier 1 (always): appearance-keys + appearance-store in fresh VM contexts with
// a fake platform storage adapter, coercion spies and controllable timers; the
// Clean Reader module contract and failure modes in fresh VM contexts; static
// stylesheet scoping and the authorized static admission lists.
// Tier 2 (real Chromium): the REAL Appearance panel over the REAL Renderer
// registry (lazy list-derived Presentation row, missing-registry isolation),
// then the REAL Reader seams (extracted verbatim from studio.js, as the
// lifecycle validator does) driving the REAL Renderer through the New UI
// selector: selection, hydration, equivalent reuse, changed-profile rebuild,
// committed and rapid A -> B -> A, unknown preference, route leave; then the
// PRODUCTION chain on a fresh page: registry lifetime around the first render,
// explicit Clean Reader selection through its scoped stylesheet, semantic
// neutrality against the reference, and the AC05b interaction matrix (real
// focus / pointer / keyboard / programmatic operation, the accessibility tree
// and the H2O-owned positive control) under both profiles.
// An unavailable browser SKIPs loudly; SKIP is never reported as evidence.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), '..', '..', '..');
const STUDIO = path.join(REPO_ROOT, 'src-surfaces-base/studio');
const KEYS_REL = 'appearance/appearance-keys.js';
const STORE_REL = 'appearance/appearance-store.studio.js';
const PANEL_REL = 'appearance/appearance-panel.studio.js';
const STUDIO_JS_REL = 'studio.js';
const PROFILE_REL = 'renderer/presentation/presentation-profile.v1.js';
const CLEAN_READER_REL = 'renderer/presentation/h2o-clean-reader.v1.js';
const CLEAN_READER_CSS_REL = 'renderer/presentation/h2o-clean-reader.v1.css';
const CLEAN_READER_MARKER = 'data-h2o-presentation-profile="h2o-clean-reader"';
const PROFILE_CSS_REL = 'renderer/presentation/chatgpt-reference.v1.css';
const CONTENT_REL = 'renderer/content/content-renderer.v1.js';
const RENDERER_REL = 'renderer/chat-renderer.studio.js';
const STUDIO_CSS_REL = 'studio.css';
const STUDIO_HTML_REL = 'studio.html';
const PACK_STUDIO_ABS = path.join(REPO_ROOT, 'tools/product/studio/pack-studio.mjs');
const STORAGE_KEY = 'h2o:studio:appearance:presentationProfile:v1';
const STRICT = /^(1|true|yes)$/i.test(String(process.env.H2O_REQUIRE_PRESENTATION_REGISTRY_TIER2 || ''));
/* Optional visible evidence: a directory receiving PNGs of the real panel row and the Reader before / after selection. */
const SHOTS_DIR = String(process.env.H2O_PRESENTATION_REGISTRY_SHOTS || '').trim();
async function shot(page, name, selector = null) {
  if (!SHOTS_DIR) return;
  fs.mkdirSync(SHOTS_DIR, { recursive: true });
  const target = path.join(SHOTS_DIR, `${name}.png`);
  if (selector) await page.locator(selector).first().screenshot({ path: target }); else await page.screenshot({ path: target });
  console.log(`SHOT_WRITTEN: ${target}`);
}

const checks = [];
const failures = [];
function check(label, fn) {
  try { fn(); checks.push(label); console.log(`✓ ${label}`); }
  catch (e) { failures.push(label); console.log(`✗ ${label}\n    ${e.message}`); }
}
const read = (rel) => fs.readFileSync(path.join(STUDIO, rel), 'utf8');

/* --------------------------------------------------------------- Tier 1 -- */

/* A fresh Appearance store over a fake platform storage. `stored` seeds the
 * hydration values; get()/set() are asynchronous like the real adapters. */
async function loadStore({ stored = {}, adapter = 'fake' } = {}) {
  const storage = { reads: [], writes: [] };
  const attributes = {}; const cssVars = {};
  const timers = [];
  const dispatched = [];
  const sandbox = vm.createContext({
    console,
    queueMicrotask,
    Date,
    CustomEvent: class CustomEvent { constructor(type, init) { this.type = type; this.detail = init && init.detail; } },
    setTimeout(fn, ms) { timers.push({ fn, ms }); return timers.length; },
    clearTimeout() {},
    document: { documentElement: { setAttribute(k, v) { attributes[k] = v; }, style: { setProperty(k, v) { cssVars[k] = v; } } } },
    dispatchEvent(event) { dispatched.push(event); return true; },
  });
  sandbox.window = sandbox; sandbox.globalThis = sandbox;
  sandbox.H2O = { Studio: { platform: {
    env: { adapter },
    storage: {
      get(key) { storage.reads.push(key); return Promise.resolve(Object.prototype.hasOwnProperty.call(stored, key) ? stored[key] : undefined); },
      set(key, value) { storage.writes.push([key, value]); return Promise.resolve(); },
    },
  } } };
  vm.runInContext(read(KEYS_REL), sandbox, { filename: 'appearance-keys.js' });
  vm.runInContext(read(STORE_REL), sandbox, { filename: 'appearance-store.studio.js' });
  /* bootHydrate is a microtask; the adapter promises resolve within a few ticks. */
  for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setImmediate(resolve));
  const appearance = sandbox.H2O.Studio.appearance;
  return { appearance, storage, attributes, cssVars, dispatched, flush() { const pending = timers.splice(0); for (const t of pending) t.fn(); return pending.length; } };
}

/* A value whose every conversion hook throws (and counts). */
function coercionTrap() {
  const calls = { toString: 0, valueOf: 0, toPrimitive: 0 };
  const trap = Object.create(null);
  Object.defineProperty(trap, 'toString', { value() { calls.toString += 1; throw new Error('toString invoked'); } });
  Object.defineProperty(trap, 'valueOf', { value() { calls.valueOf += 1; throw new Error('valueOf invoked'); } });
  Object.defineProperty(trap, Symbol.toPrimitive, { value() { calls.toPrimitive += 1; throw new Error('toPrimitive invoked'); } });
  return { trap, calls };
}

check('M04 P2 T4 (D): appearance-keys carries exactly one new logical key with its storage key and default; every other key, default, bound and event is unchanged', () => {
  const sandbox = vm.createContext({}); sandbox.window = sandbox;
  vm.runInContext(read(KEYS_REL), sandbox, { filename: 'appearance-keys.js' });
  const a = sandbox.H2O.Studio.appearance;
  /* VM-realm objects are copied before strict deepEqual (prototype realms differ). */
  assert.deepEqual({ ...a.keys }, {
    theme: 'h2o:studio:appearance:theme:v1', typography: 'h2o:studio:appearance:typography:v1', fontSize: 'h2o:studio:appearance:fontSize:v1', contentWidth: 'h2o:studio:appearance:contentWidth:v1',
    showFolders: 'h2o:studio:appearance:showFolders:v1', showNotes: 'h2o:studio:appearance:showNotes:v1', plainText: 'h2o:studio:appearance:plainText:v1', alwaysOnTop: 'h2o:studio:appearance:alwaysOnTop:v1',
    presentationProfile: STORAGE_KEY,
  }, 'A: the eight existing storage keys plus presentationProfile');
  assert.deepEqual({ ...a.defaults }, { theme: 'dark', typography: 'sans', fontSize: 16, contentWidth: 48, showFolders: true, showNotes: true, plainText: false, alwaysOnTop: false, presentationProfile: 'chatgpt-reference' }, 'A: default chatgpt-reference');
  assert.deepEqual([[...a.themes], [...a.typographies]], [['dark', 'light', 'sepia'], ['sans', 'serif', 'mono']]);
  assert.deepEqual(JSON.parse(JSON.stringify(a.bounds)), { fontSize: { min: 13, max: 22, step: 1 }, contentWidth: { min: 36, max: 72, step: 4 } });
  assert.deepEqual({ ...a.events }, { changed: 'evt:h2o:studio:appearance:changed', ready: 'evt:h2o:studio:appearance:ready' });
  assert.equal(Object.isFrozen(a.keys) && Object.isFrozen(a.defaults), true);
});

await (async () => {
  const fresh = await loadStore();
  check('M04 P2 T4 (D): the store preserves any string exactly (unknown ids and the empty string), persists it verbatim, and notifies one change per distinct value', () => {
    const { appearance, storage, flush, dispatched } = fresh;
    assert.equal(appearance.get('presentationProfile'), 'chatgpt-reference', 'default before any set');
    const events = []; const unsubscribe = appearance.subscribe((event) => events.push(event));
    appearance.set('presentationProfile', 'h2o-clean-reader');
    assert.equal(appearance.get('presentationProfile'), 'h2o-clean-reader');
    appearance.set('presentationProfile', 'h2o-clean-reader');
    assert.equal(events.length, 1, 'an equal value is a no-op (no second change)');
    appearance.set('presentationProfile', 'no-such-profile');
    assert.equal(appearance.get('presentationProfile'), 'no-such-profile', 'an unknown id is preserved verbatim (no registry validation, no effective fallback)');
    appearance.set('presentationProfile', '');
    assert.equal(appearance.get('presentationProfile'), '', 'the empty string is preserved');
    assert.deepEqual(events.map((e) => [e.type, e.key, e.value]), [['change', 'presentationProfile', 'h2o-clean-reader'], ['change', 'presentationProfile', 'no-such-profile'], ['change', 'presentationProfile', '']]);
    assert.equal(flush(), 1, 'one debounced flush');
    assert.deepEqual(storage.writes.filter(([key]) => key === STORAGE_KEY), [[STORAGE_KEY, '']], 'the latest verbatim value is persisted under the storage key');
    assert.equal(appearance.getAll().presentationProfile, '', 'getAll carries the preference');
    assert.ok(dispatched.some((e) => e.type === 'evt:h2o:studio:appearance:changed' && e.detail.key === 'presentationProfile'), 'window-level changed event still dispatched');
    unsubscribe();
    appearance.set('presentationProfile', 'chatgpt-reference');
    assert.equal(events.length, 3, 'unsubscribed');
    assert.deepEqual([...appearance.selfCheck().errors], [], 'no store errors');
  });
  check('M04 P2 T4 (D): non-string values fall back to the default without invoking any conversion hook; other keys keep their coercion', () => {
    const { appearance } = fresh;
    appearance.set('presentationProfile', 'h2o-clean-reader');
    for (const value of [42, true, null, undefined, ['h2o-clean-reader'], { id: 'h2o-clean-reader' }, Symbol('p'), () => 'h2o-clean-reader']) {
      appearance.set('presentationProfile', 'h2o-clean-reader');
      appearance.set('presentationProfile', value);
      assert.equal(appearance.get('presentationProfile'), 'chatgpt-reference', `non-string ${typeof value} -> default`);
    }
    const { trap, calls } = coercionTrap();
    appearance.set('presentationProfile', 'h2o-clean-reader');
    assert.doesNotThrow(() => appearance.set('presentationProfile', trap), 'a throwing coercion trap cannot break set()');
    assert.equal(appearance.get('presentationProfile'), 'chatgpt-reference');
    assert.deepEqual(calls, { toString: 0, valueOf: 0, toPrimitive: 0 }, 'no toString / valueOf / Symbol.toPrimitive ran');
    const strTrap = new String('h2o-clean-reader'); /* a String object is not a string primitive */
    appearance.set('presentationProfile', strTrap);
    assert.equal(appearance.get('presentationProfile'), 'chatgpt-reference', 'String objects are non-strings');
    appearance.set('theme', 'nope'); assert.equal(appearance.get('theme'), 'dark', 'theme coercion unchanged');
    appearance.set('fontSize', 99); assert.equal(appearance.get('fontSize'), 22, 'fontSize clamp unchanged');
    appearance.set('plainText', 'true'); assert.equal(appearance.get('plainText'), true, 'boolean coercion unchanged');
  });
  check('M04 P2 T4 (D): apply() writes no document attribute or variable for the preference (the Renderer applies the profile per render)', () => {
    const { appearance, attributes, cssVars } = fresh;
    appearance.set('presentationProfile', 'h2o-clean-reader');
    appearance.apply();
    assert.deepEqual(Object.keys(attributes).sort(), ['data-h2o-plain-text', 'data-h2o-show-folders', 'data-h2o-show-notes', 'data-h2o-theme', 'data-h2o-typography'], 'only the existing attributes');
    assert.deepEqual(Object.keys(cssVars).sort(), ['--wb-appearance-content-width', '--wb-appearance-font-size']);
    assert.ok(!JSON.stringify(attributes).includes('clean-reader') && !JSON.stringify(cssVars).includes('clean-reader'));
  });
})();

await (async () => {
  const unknown = await loadStore({ stored: { [STORAGE_KEY]: 'no-such-profile' } });
  const empty = await loadStore({ stored: { [STORAGE_KEY]: '' } });
  const nonString = await loadStore({ stored: { [STORAGE_KEY]: 7 } });
  const absent = await loadStore({ stored: {} });
  const fallback = await loadStore({ stored: { [STORAGE_KEY]: 'h2o-clean-reader' }, adapter: 'fallback' });
  check('M04 P2 T4 (D): hydration round trips — unknown and empty strings survive verbatim, a stored non-string hydrates to the default, absent stays default, ready fires once without change events, nothing is written back', () => {
    for (const [label, harness, expected] of [['unknown', unknown, 'no-such-profile'], ['empty', empty, ''], ['non-string', nonString, 'chatgpt-reference'], ['absent', absent, 'chatgpt-reference']]) {
      assert.equal(harness.appearance.isReady(), true, `${label}: hydrated`);
      assert.equal(harness.appearance.get('presentationProfile'), expected, `${label}: hydrated value`);
      assert.ok(harness.storage.reads.includes(STORAGE_KEY), `${label}: the storage key was read at boot`);
      assert.deepEqual(harness.storage.writes, [], `${label}: hydration persists nothing (no effective fallback written back)`);
      assert.deepEqual(harness.dispatched.filter((e) => e.type === 'evt:h2o:studio:appearance:ready').length, 1, `${label}: one ready`);
      assert.equal(harness.dispatched.some((e) => e.type === 'evt:h2o:studio:appearance:changed' && e.detail.type === 'change'), false, `${label}: hydration emits no change event`);
      assert.deepEqual([...harness.appearance.selfCheck().errors], [], `${label}: no errors`);
    }
    assert.equal(fallback.appearance.get('presentationProfile'), 'chatgpt-reference', 'a fallback adapter (no real storage) keeps defaults');
    assert.deepEqual(fallback.storage.reads, [], 'and never reads');
  });
})();

/* ------------------------------------ Tier 1: M04 P2 T3 (consolidated at T5) -- */
/* The H2O Clean Reader profile: its own module registering through the public
 * path during evaluation, its fully scoped stylesheet, and the authorized static
 * admission (studio.html tags, index-paired pack entries, both publication order
 * lists) — the T3 registry-lifetime / stylesheet coverage the Plan places in this
 * validator. Fixtures and helpers are the content-renderer validator's. */

function stripCssComments(source) { return source.replace(/\/\*[\s\S]*?\*\//g, ' '); }

/* Parse a plain stylesheet into [{ selector, declarations, media, index }],
 * tracking the enclosing @media prelude (one level, which is all the Studio
 * stylesheets use) so responsive overrides are distinguishable from base rules. */
function parseRules(css) {
  const src = stripCssComments(css);
  const rules = [];
  let i = 0; let media = null; let depth = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1) break;
    const prelude = src.slice(i, open).trim();
    if (prelude.startsWith('@media')) { media = prelude.slice(6).trim(); depth += 1; i = open + 1; continue; }
    const close = src.indexOf('}', open);
    if (close === -1) break;
    const declarations = {};
    for (const part of src.slice(open + 1, close).split(';')) {
      const k = part.indexOf(':');
      if (k === -1) continue;
      declarations[part.slice(0, k).trim()] = part.slice(k + 1).trim();
    }
    rules.push({ selector: prelude, declarations, media, index: rules.length });
    i = close + 1;
    /* Leave the @media block when its closing brace is next. */
    while (depth > 0 && /^\s*\}/.test(src.slice(i))) { i = src.indexOf('}', i) + 1; depth -= 1; if (depth === 0) media = null; }
  }
  return rules;
}

const norm = (sel) => sel.replace(/\s+/g, ' ').trim();
/* Split a selector list on top-level commas only (commas inside :where()/:is()/:not() stay). */
function splitMembers(selector) {
  const out = []; let depth = 0; let cur = '';
  for (const ch of selector) {
    if (ch === '(') depth += 1; else if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) { out.push(norm(cur)); cur = ''; } else cur += ch;
  }
  if (cur.trim()) out.push(norm(cur));
  return out;
}

function loadCleanReader({ prelude = null, sealFirst = false } = {}) {
  const sandbox = vm.createContext({ console }); sandbox.globalThis = sandbox;
  if (prelude === null) vm.runInContext(read(PROFILE_REL), sandbox, { filename: 'presentation-profile.v1.js' });
  else vm.runInContext(prelude, sandbox, { filename: 'prelude.js' });
  if (sealFirst) sandbox.H2O.Studio.Renderer.presentationProfile.seal();
  vm.runInContext(read(CLEAN_READER_REL), sandbox, { filename: 'h2o-clean-reader.v1.js' });
  return sandbox;
}

check('M04 P2 T3: h2o-clean-reader registers through public define/register during its synchronous evaluation, before any render, with governed metadata, provider null, both modes, empty shell hooks and profile-local content / edit hooks', () => {
  const sandbox = loadCleanReader();
  const pp = sandbox.H2O.Studio.Renderer.presentationProfile;
  assert.deepEqual([...pp.ids()], ['chatgpt-reference', 'h2o-clean-reader'], 'A: registered after the built-in reference, nothing else');
  assert.deepEqual([pp.sealed(), pp.registryDigest()], [false, null], 'A: registration is still open after the module evaluated (no self-sealing)');
  const profile = pp.get('h2o-clean-reader');
  assert.equal(profile, pp.resolve('h2o-clean-reader').profile); assert.equal(pp.resolve('h2o-clean-reader').reason, 'explicit');
  assert.deepEqual({ id: profile.id, owner: profile.owner, version: profile.version, displayName: profile.displayName, provider: profile.provider, modes: [...profile.modes], stylesheet: { ...profile.stylesheet } },
    { id: 'h2o-clean-reader', owner: 'L-STUDIO-RENDERER', version: '1.0.0', displayName: 'H2O Clean Reader', provider: null, modes: ['canonical', 'rich'], stylesheet: { href: CLEAN_READER_CSS_REL, version: '1.0.1' } }, 'B: governed metadata'); /* stylesheet 1.0.0 -> 1.0.1: M04 P2 T4 attachment-card rules */
  for (const mode of ['canonical', 'rich']) {
    assert.deepEqual([...profile.transcriptClasses(mode)], [], `C: empty transcript hook (${mode})`);
    for (const role of ['user', 'assistant', 'system', 'tool']) {
      assert.deepEqual([...profile.turnClasses(role, mode)], [], `C: empty turn hook (${role}/${mode})`);
      assert.deepEqual([...profile.messageClasses(role, mode)], [], `C: empty message hook (${role}/${mode})`);
    }
  }
  assert.deepEqual([...profile.userBubbleClasses()], [], 'C: empty bubble hook (no provider compatibility class)');
  assert.deepEqual([[...profile.codeBlockClasses()], [...profile.codeLanguageClasses()]], [['h2oCleanCode'], ['h2oCleanCodeLang']], 'D: profile-local content hooks');
  assert.deepEqual([[...profile.editedTurnClasses()], [...profile.editedMessageClasses()]], [['h2oCleanTurn--edited'], ['h2oCleanMsg--edited']], 'D: profile-local edit-state hooks');
  assert.deepEqual([...profile.contentClasses('paragraph', 'container')], [], 'D: undeclared content slots stay []');
  assert.equal(pp.reference().id, 'chatgpt-reference'); assert.equal(pp.resolve().effectiveId, 'chatgpt-reference', 'E: the reference stays the immutable default');
  /* Runtime contract in source: synchronous classic script, no deferred registration, no loader, no sealing. */
  const code = read(CLEAN_READER_REL).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/mg, '');
  assert.doesNotMatch(code, /\basync\b|\bawait\b|Promise|setTimeout|queueMicrotask|requestAnimationFrame|addEventListener|import\(|\.seal\(|createElement|document\./, 'F: registration is synchronous during evaluation; no async, event, loader, DOM or sealing path');
  assert.match(code, /registry\.register\(registry\.define\(/, 'F: registers through the public define/register path');
  assert.match(code, /"use strict"/, 'F: classic strict script');
});

check('M04 P2 T3: a missing, incompatible or sealed registry and a duplicate admission fail visibly and deterministically at evaluation (no silent fallback)', () => {
  const fails = (label, fn, pattern) => { let error = null; try { fn(); } catch (e) { error = e; } assert.ok(error, `${label}: must throw`); assert.match(String(error.message), pattern, `${label}: message`); return error; };
  fails('missing registry', () => loadCleanReader({ prelude: 'globalThis.H2O = {};' }), /registry is not installed/);
  fails('incompatible registry', () => loadCleanReader({ prelude: 'globalThis.H2O = { Studio: { Renderer: { presentationProfile: { __installed: true, schema: "h2o.renderer.presentation-profile", schemaVersion: 2, __version: "9.0.0", define() {}, register() {}, get() {}, sealed() { return false; } } } } };' }), /incompatible PresentationProfile registry API/);
  fails('sealed registry', () => loadCleanReader({ sealFirst: true }), /already sealed/);
  const sandbox = loadCleanReader();
  const duplicate = fails('duplicate admission', () => vm.runInContext(read(CLEAN_READER_REL), sandbox, { filename: 'h2o-clean-reader.v1.js#2' }), /duplicate-id/);
  assert.equal(duplicate.code, 'duplicate-id');
  assert.deepEqual([...sandbox.H2O.Studio.Renderer.presentationProfile.ids()], ['chatgpt-reference', 'h2o-clean-reader'], 'a refused second evaluation changes nothing');
  /* Fallback is observable but is not admission: without the module, an explicit selection resolves to the reference. */
  const bare = vm.createContext({ console }); bare.globalThis = bare; vm.runInContext(read(PROFILE_REL), bare, { filename: 'presentation-profile.v1.js' });
  assert.deepEqual({ ...bare.H2O.Studio.Renderer.presentationProfile.resolve('h2o-clean-reader'), profile: undefined }, { requestedId: 'h2o-clean-reader', effectiveId: 'chatgpt-reference', reason: 'unknown-profile-fallback', profile: undefined }, 'unknown-profile fallback is not admission evidence');
});

const CLEAN_SCOPE = `:where([${CLEAN_READER_MARKER}])`;
const PROVIDER_BRIDGE_SELECTOR = /\.(?:text-|bg-|border-|font-(?:bold|semibold|medium|normal)|italic|underline|uppercase|tracking-|leading-|whitespace-|break-|overflow-|flex|inline|block|hidden|grid|items-|justify-|gap-|w-|h-|min-|max-|p[xytblr]?-|m[xytblr]?-\d|rounded|prose|markdown|katex|hljs|\\!)/;

check('M04 P2 T3: the Clean Reader stylesheet is fully scoped to its root marker, keys on structural selectors and its own hooks, uses shared --wb-* tokens only, and carries no !important or provider utility / token bridge', () => {
  assert.equal(fs.existsSync(path.join(STUDIO, CLEAN_READER_CSS_REL)), true, 'A: h2o-clean-reader.v1.css must exist');
  const css = read(CLEAN_READER_CSS_REL);
  assert.match(css, /Owner:\s+L-STUDIO-RENDERER/, 'B: Renderer-owned'); assert.match(css, /Profile:\s+h2o-clean-reader/, 'B: names the profile');
  const version = /@version\s+(\S+)/.exec(css)[1];
  assert.equal(version, loadCleanReader().H2O.Studio.Renderer.presentationProfile.get('h2o-clean-reader').stylesheet.version, 'B: @version equals the profile stylesheet admission metadata');
  const rules = parseRules(css);
  assert.ok(rules.length >= 20, 'stylesheet carries rules');
  const unscoped = [];
  for (const rule of rules) {
    for (const member of splitMembers(rule.selector)) {
      assert.ok(member.startsWith(`${CLEAN_SCOPE} `), `C: every selector member is scoped beneath the Clean Reader root marker with zero-specificity :where(): ${member}`);
      const rest = member.slice(CLEAN_SCOPE.length + 1);
      assert.doesNotMatch(rest, /data-h2o-presentation-profile/, `C: no other profile root is addressed: ${member}`);
      assert.doesNotMatch(rest, PROVIDER_BRIDGE_SELECTOR, `E: no provider utility / prose / token class is skinned: ${member}`);
      assert.doesNotMatch(rest, /user-message-bubble-color|\.wbTurn|\.wbCodeBlock|\.wbCodeLang|is-rich|\.cgMsg--/, `E: no reference-profile hook or provider marker is addressed: ${member}`);
      unscoped.push(rest);
    }
    for (const [property, value] of Object.entries(rule.declarations)) {
      assert.doesNotMatch(value, /!important/, `D: no !important (${rule.selector} { ${property} })`);
      for (const token of value.matchAll(/var\(\s*(--[a-zA-Z0-9-]+)/g)) assert.match(token[1], /^--wb-/, `F: only shared --wb-* tokens are consumed (${rule.selector} { ${property}: ${value} })`);
      assert.doesNotMatch(property, /^--/, `F: the stylesheet defines no custom properties (no token bridge): ${property}`);
    }
  }
  assert.doesNotMatch(stripCssComments(css), /!important|--token-|--tw-prose|--main-surface|--text-primary|--border-(?:light|medium|heavy)\b/, 'D/F: no !important and no provider design-token alias anywhere');
  /* The profile's own hooks are skinned; structural vocabulary is what the shell rules key on. */
  for (const hook of ['.h2oCleanCode', '.h2oCleanCodeLang', '.h2oCleanMsg--edited']) assert.ok(unscoped.some((s) => s === hook || s.startsWith(`${hook} `) || s.startsWith(`${hook} >`)), `G: ${hook} is skinned by the Clean Reader stylesheet`);
  for (const structural of ['.cgMsg[data-message-author-role="user"]:not(:has(.cgBubble--user))', '.cgMsgBody', '.wbRichRoot .cgBubble--user']) assert.ok(unscoped.includes(structural), `G: structural selector ${structural} is used instead of a presentation class`);
  /* The stylesheet must not be declared in the reference stylesheet or global studio.css (no leakage of Clean Reader hooks). */
  assert.doesNotMatch(stripCssComments(read(PROFILE_CSS_REL)), /h2oClean|h2o-clean-reader/, 'H: the reference stylesheet is untouched by the Clean Reader');
  assert.doesNotMatch(stripCssComments(read(STUDIO_CSS_REL)), /h2oClean|h2o-clean-reader/, 'H: global studio.css carries no Clean Reader rule');
});

/* The accepted Renderer chain in production order (studio.html / both pack lists /
 * publisher and activator STUDIO_REQUIRED_ORDER without studio.js) — explicit,
 * never derived from the lists under test. */
const PRODUCTION_CHAIN = Object.freeze([
  'platform/selectors.contract.js',
  'platform/html-sanitizer.js',
  'renderer/safety/sanitizer-policy.v1.js',
  'renderer/safety/vendor/dompurify/purify.js',
  'renderer/safety/html-sanitizer.v2.js',
  'renderer/markdown/vendor/markdown-it/markdown-it.umd.min.js',
  'renderer/markdown/h2o-gfm.v1.js',
  'renderer/markdown/markdown-engine.v1.js',
  'renderer/markdown/markdown-ir-adapter.v1.js',
  'renderer/semantic/render-ir.v1.js',
  'renderer/semantic/semantic-ingress.v1.js',
  'renderer/semantic/semantic-index.v1.js',
  'renderer/decoration/decoration-contribution.v1.js',
  PROFILE_REL,
  CLEAN_READER_REL,
  CONTENT_REL,
  RENDERER_REL,
]);
const PRODUCTION_STYLESHEETS = Object.freeze([STUDIO_CSS_REL, PROFILE_CSS_REL, CLEAN_READER_CSS_REL]);

/* Imported at top level: check() is synchronous, so a promise handed to it
 * would pass vacuously. */
const packer = await import(pathToFileURL(PACK_STUDIO_ABS).href);

check('M04 P2 T3: studio.html, pack-studio (index-paired) and both publication order lists admit the Clean Reader assets exactly once at the approved positions and agree with each other', () => {
  const html = read(STUDIO_HTML_REL);
  const links = [...html.matchAll(/<link\s+rel="stylesheet"\s+href="\.\/([^"?]+)(?:\?[^"]*)?"\s*\/?>/g)].map((m) => m[1]);
  assert.deepEqual(links, [...PRODUCTION_STYLESHEETS], 'A: exactly studio.css, the reference stylesheet, then the Clean Reader stylesheet');
  assert.match(html, /<link rel="stylesheet" href="\.\/renderer\/presentation\/chatgpt-reference\.v1\.css\?v=1\.0\.6" \/>\n\s*<link rel="stylesheet" href="\.\/renderer\/presentation\/h2o-clean-reader\.v1\.css" \/>\n<\/head>/, 'A: the Clean Reader link sits immediately after the reference stylesheet, before </head>');
  const scriptTags = [...html.matchAll(/<script([^>]*)><\/script>/g)].map((m) => m[1]);
  const cleanTags = scriptTags.filter((attrs) => attrs.includes(CLEAN_READER_REL));
  assert.equal(cleanTags.length, 1, 'B: the Clean Reader script is admitted exactly once');
  assert.equal(cleanTags[0].trim(), `src="./${CLEAN_READER_REL}"`, 'B: a plain classic script tag (no type / async / defer)');
  const refs = [...html.matchAll(/<script\s+src="\.\/([^"?]+)(?:\?[^"]*)?"><\/script>/g)].map((m) => m[1]);
  assert.match(html, /<script src="\.\/renderer\/presentation\/presentation-profile\.v1\.js"><\/script>\n\s*<script src="\.\/renderer\/presentation\/h2o-clean-reader\.v1\.js"><\/script>\n\s*<script src="\.\/renderer\/content\/content-renderer\.v1\.js"><\/script>/, 'B: presentation-profile -> h2o-clean-reader -> content-renderer are adjacent');
  assert.deepEqual(refs.filter((r) => PRODUCTION_CHAIN.includes(r)), [...PRODUCTION_CHAIN], 'B: studio.html loads the production Renderer chain in order');
  for (const [name, list] of [['ARCHIVE_WORKBENCH_SOURCE_FILES', packer.ARCHIVE_WORKBENCH_SOURCE_FILES], ['ARCHIVE_WORKBENCH_OUT_FILES', packer.ARCHIVE_WORKBENCH_OUT_FILES]]) {
    assert.equal(new Set(list).size, list.length, `C: ${name} has no duplicates`);
    for (const rel of [CLEAN_READER_REL, CLEAN_READER_CSS_REL]) assert.equal(list.filter((f) => f === rel).length, 1, `C: ${name} carries ${rel} exactly once`);
    assert.equal(list.indexOf(CLEAN_READER_REL) + 1, list.indexOf(CLEAN_READER_CSS_REL), `C: ${name}: the script precedes its stylesheet`);
    assert.ok(list.indexOf(CLEAN_READER_REL) > list.indexOf(PROFILE_REL) && list.indexOf(CLEAN_READER_CSS_REL) < list.indexOf(CONTENT_REL), `C: ${name}: after the profile registry, before the ContentRenderer`);
  }
  assert.equal(packer.ARCHIVE_WORKBENCH_SOURCE_FILES.length, packer.ARCHIVE_WORKBENCH_OUT_FILES.length, 'C: lists stay index-paired');
  for (const rel of [PROFILE_REL, PROFILE_CSS_REL, CLEAN_READER_REL, CLEAN_READER_CSS_REL, CONTENT_REL]) assert.equal(packer.ARCHIVE_WORKBENCH_SOURCE_FILES.indexOf(rel), packer.ARCHIVE_WORKBENCH_OUT_FILES.indexOf(rel), `C: ${rel} sits at the same index in both lists`);
  const order = (rel) => { const source = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8'); const at = source.indexOf('const STUDIO_REQUIRED_ORDER = Object.freeze(['); assert.notEqual(at, -1, `${rel}: STUDIO_REQUIRED_ORDER`); return [...source.slice(at, source.indexOf(']);', at)).matchAll(/"([^"]+)"/g)].map((m) => m[1]); };
  const publisher = order('tools/publish/lean-publisher.mjs'); const activator = order('tools/publish/lean-activator.mjs');
  assert.deepEqual(publisher, [...PRODUCTION_CHAIN, 'studio.js'], 'D: the publisher required order is the production chain + studio.js (18 entries)');
  assert.deepEqual(activator, publisher, 'D: publisher and activator required orders agree');
  assert.equal(publisher.length, 18); assert.equal(new Set(publisher).size, 18, 'D: no duplicate order entry');
  assert.equal(publisher.indexOf(CLEAN_READER_REL), publisher.indexOf(PROFILE_REL) + 1); assert.equal(publisher.indexOf(CONTENT_REL), publisher.indexOf(CLEAN_READER_REL) + 1, 'D: Runtime-approved position');
});

/* --------------------------------------------------------------- Tier 2 -- */

/* Same source-extraction convention as the lifecycle / Reader validators:
 * only the named seams run; the Studio application is not booted. */
const studioSource = read(STUDIO_JS_REL);
function extract(name, text = studioSource) {
  const match = new RegExp(`\\b(?:async\\s+)?function\\s+${name}\\s*\\(`).exec(text);
  assert.ok(match, `missing source seam: ${name}`);
  const at = match.index;
  const open = text.indexOf('{', text.indexOf(')', at));
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === '{') depth += 1;
    if (text[i] === '}' && --depth === 0) { const fn = text.slice(at, i + 1); new vm.Script(`(${fn})`); return fn; }
  }
  throw new Error(`unterminated source seam: ${name}`);
}
const READER_SEAMS = ['getStudioChatRenderer', 'bindReaderSemanticIndex', 'getReaderSemanticIndex', 'getReaderDecorationContributions', 'disposeReaderRenderDecorations', 'studioHostUnmount', 'studioHostUnmountPreservingRouteHash', 'isCurrentReaderRoot', 'getReusableReaderMount', 'isReusableReaderMountCurrent', 'collectRendererEditOverrides', 'haveEquivalentRendererEditOverrides', 'getReaderPresentationPreference', 'isReaderPresentationCurrent', 'canReuseReaderDOM', 'refreshReaderPresentation', 'subscribeReaderToPresentationPreference', 'rememberPublicationTarget', 'renderReader', 'buildReaderDOM'];
const CHAIN = PRODUCTION_CHAIN;

/* Reader seams + the collaborator stubs renderReader needs (mirrors the
 * lifecycle validator's harness) + a marker-faithful fake Studio host. */
function readerSeamsScript() {
  return `(() => {
    const W = window; const H2O = W.H2O; const $ = (selector) => document.querySelector(selector);
    const STUDIO_BOOT_AUX_TIMEOUT_MS = 1;
    const state = { rowsCache: [], activeRoute: 'list', renderToken: 0, currentReaderSnapshot: null, currentReaderEditOverrides: null, currentReaderRender: null, currentReaderNavigationTarget: null, readerPresentationUnsubscribe: null, publicationTarget: null, selectedSnapshotId: '', selectedChatId: '', lastView: 'saved', lastFolderId: '' };
    const snapshots = new Map(); const renders = []; const lifecycleDisposals = [];
    let hostState = { root: null, turns: null, scroll: null, snapshot: null, mountCount: 0, unmountCount: 0 };
    H2O.studioHost = {
      mount(opts) { hostState.root = opts.readerRoot; hostState.turns = opts.turnsEl; hostState.scroll = opts.scrollEl; hostState.snapshot = opts.snapshot; hostState.mountCount += 1; opts.readerRoot.setAttribute('data-h2o-studio-reader', '1'); opts.scrollEl.setAttribute('data-scroll-root', '1'); return true; },
      unmount() { if (!hostState.root) return false; hostState.root.removeAttribute('data-h2o-studio-reader'); hostState.scroll?.removeAttribute('data-scroll-root'); hostState.root = null; hostState.turns = null; hostState.scroll = null; hostState.snapshot = null; hostState.unmountCount += 1; return true; },
      getReaderRoot: () => (hostState.root?.isConnected ? hostState.root : null),
      getTurnsRoot: () => (hostState.turns?.isConnected ? hostState.turns : null),
      getScrollRoot: () => (hostState.scroll?.isConnected ? hostState.scroll : null),
      updateSnapshot(snapshot) { if (!hostState.root?.isConnected) return false; hostState.snapshot = snapshot; return true; },
    };
    const setStudioRouteScope = (name) => { state.activeRoute = name; };
    const applyDesktopReaderRibbonSession = () => {}; const ensureReaderTopbarActions = () => {}; const setRouteMeta = () => {};
    const callArchive = async (_op, payload) => snapshots.get(String(payload?.snapshotId || '')) || null;
    const fetchWorkbenchRows = async () => []; const enrichRowsWithFolderData = async (rows) => rows; const renderFolderSidebar = () => {}; const refreshSidebarChatList = () => {};
    const promiseWithTimeoutFallback = async (promise, _t, _l, fallback) => { try { return await promise; } catch { return fallback; } };
    const fetchFolderCatalog = async () => ({ canonical: [], review: [] }); const fetchLabelCatalog = async () => []; const fetchCategoryCatalog = async () => [];
    const resolveFolderBindingsForChatIds = async () => new Map(); const normalizeFolderBinding = (v) => v; const resolveFolderName = () => ''; const updateRowFolderBinding = () => {};
    const getEditOverride = () => null; const refreshReaderOverlay = () => {}; const syncReaderTopOffset = () => {}; const renderReaderRouteMeta = () => {}; const setActiveSidebarChat = () => {}; const syncSelectionControls = () => {}; const applyUiState = () => {}; const esc = (v) => String(v || '');
    const publishReaderTurnSelection = () => null; const __mountOverlayEditorOnTurn = () => {};
    ${READER_SEAMS.map((name) => extract(name)).join('\n')}
    const realBuild = buildReaderDOM;
    /* observe every real render through the real seam */
    const observedBuild = (snap, input) => { const root = realBuild(snap, input); renders.push({ snapshotId: String(snap?.snapshotId || ''), effectiveId: state.currentReaderRender?.presentation?.effectiveId || null, requestedId: state.currentReaderRender?.presentation?.requestedId, reason: state.currentReaderRender?.presentation?.reason, marker: root.getAttribute('data-h2o-presentation-profile') }); return root; };
    window.reader = {
      state, renders, hostState, snapshots,
      subscribe: subscribeReaderToPresentationPreference,
      refresh: refreshReaderPresentation,
      isCurrent: isReaderPresentationCurrent,
      render(id) { return renderReader(id); },
      leave(reason) { state.renderToken += 1; state.currentReaderSnapshot = null; studioHostUnmountPreservingRouteHash(reason || 'test:leave'); },
      idle: async () => { for (let i = 0; i < 20; i += 1) await new Promise((r) => setTimeout(r, 0)); },
      addSnapshot(id, snap) { snapshots.set(id, snap); },
      currentRoot: () => document.getElementById('viewReader').firstElementChild,
    };
    /* buildReaderDOM is called by name inside renderReader; rebind the observed wrapper on the same binding. */
    buildReaderDOM = observedBuild;
  })();`;
}

async function resolvePlaywright() {
  const override = process.env.H2O_PLAYWRIGHT_MODULE;
  try {
    if (override) {
      if (!fs.existsSync(override)) return null;
      const entry = fs.statSync(override).isDirectory() ? path.join(override, 'index.js') : override;
      const mod = await import(pathToFileURL(entry).href);
      return mod?.chromium || mod?.default?.chromium || null;
    }
    const mod = await import('playwright');
    return mod?.chromium || mod?.default?.chromium || null;
  } catch { return null; }
}

const chromium = await resolvePlaywright();
if (!chromium) {
  console.log('SKIP real-browser selector / Reader / production-chain profile smoke unavailable (set H2O_PLAYWRIGHT_MODULE)');
  console.log('SKIP is not PASS: the New UI selector, the Reader lifecycle, the production-chain profile lifetime and the AC05b interaction matrix were not inspected.');
  if (STRICT) { console.error('FAIL H2O_REQUIRE_PRESENTATION_REGISTRY_TIER2 is set'); process.exit(1); }
} else {
  const MIME = { '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css' };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    if (rel === '__selector__') {
      const seed = url.searchParams.get('seed'); const deferHydration = url.searchParams.get('defer') === '1'; const withRegistry = url.searchParams.get('registry') !== '0';
      const chain = withRegistry ? CHAIN : [];
      const links = ['studio.css', 'renderer/presentation/chatgpt-reference.v1.css', 'renderer/presentation/h2o-clean-reader.v1.css'].map((r) => `<link rel="stylesheet" href="./${r}">`).join('');
      /* Production order: the Appearance modules evaluate BEFORE the Renderer chain (studio.html). */
      const platform = `<script>window.H2O = { Studio: { platform: { env: { adapter: 'fake' }, storage: (() => { const seed = ${JSON.stringify(seed)}; const store = new Map(seed === null ? [] : [['${STORAGE_KEY}', seed]]); const writes = []; let release = null; const gate = ${deferHydration ? 'new Promise((resolve) => { release = resolve; })' : 'Promise.resolve()'}; window.__storage = { store, writes, release: () => release && release() }; return { get: (key) => gate.then(() => store.get(key)), set(key, value) { writes.push([key, value]); store.set(key, value); return Promise.resolve(); } }; })() } } };</script>`;
      const appearance = [KEYS_REL, STORE_REL, PANEL_REL].map((r) => `<script src="./${r}"></script>`).join('');
      /* minimal Shell: a header slot for the real trigger (laid out at the end like the production top bar) and the Reader pane */
      const shell = '<style>.wbTop{display:flex;justify-content:flex-end;padding:8px 12px}</style><header class="wbTop"></header><main class="wbMain"><div id="viewListPanel" hidden></div><section id="viewReader" class="wbReader" hidden></section></main>';
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`<!doctype html><meta charset="utf-8"><title>selector</title>${links}${platform}${appearance}<body data-route="reader">${shell}${chain.map((r) => `<script src="./${r}"></script>`).join('\n')}${withRegistry ? '<script src="./__reader_seams__.js"></script>' : ''}`);
      return;
    }
    /* M04 P2 T3 (consolidated at T5): the PRODUCTION chain and stylesheets exactly
     * as studio.html admits them (Clean Reader module and stylesheet included), on
     * a fresh page whose registries are still open. */
    if (rel === '__profiles__') {
      const tags = PRODUCTION_CHAIN.map((r) => `<script src="./${r}"></script>`).join('\n');
      const links = PRODUCTION_STYLESHEETS.map((r) => `<link rel="stylesheet" href="./${r}">`).join('');
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`<!doctype html><meta charset="utf-8"><title>profiles</title>${links}\n${tags}\n<section id="viewReader" class="wbReader"><div id="host"></div></section>`);
      return;
    }
    if (rel === '__reader_seams__.js') { res.writeHead(200, { 'Content-Type': 'text/javascript' }); res.end(readerSeamsScript()); return; }
    const file = path.join(STUDIO, rel);
    if (!file.startsWith(STUDIO) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end('nf'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(fs.readFileSync(file));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch();

  async function openPage(query) {
    const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
    const errors = []; page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(`${base}/__selector__${query}`, { waitUntil: 'load' });
    return { page, errors };
  }
  const SNAPSHOT = { snapshotId: 'snap-A', chatId: 'chat-A', meta: { title: 'A' }, messages: [ { role: 'user', text: 'Question `q`', messageId: 'u1', turnId: 't1' }, { role: 'assistant', text: 'Answer\n\n```js\nlet a = 1;\n```', messageId: 'a1', turnId: 't1' } ] };

  /* ── panel: lazy list-derived row, selection, unknown value, isolation ── */
  const { page: panelPage, errors: panelErrors } = await openPage('');
  const panel = await panelPage.evaluate(async () => {
    const a = H2O.Studio.appearance; const pp = H2O.Studio.Renderer.presentationProfile;
    for (let i = 0; i < 20 && !a.isReady(); i += 1) await new Promise((r) => setTimeout(r, 5));
    /* lazy lookup: a profile registered AFTER the panel module installed but BEFORE the first open is enumerated. */
    pp.register({ id: 't4-late-registered', owner: 't4-test', version: '0.1.0', displayName: 'T4 late profile', provider: null, stylesheet: null, modes: ['canonical', 'rich'], hooks: { transcript: { canonical: [], rich: [] }, turn: { base: [], canonical: [], rich: [], role: { user: [], assistant: [], system: [], tool: [] } }, message: { canonical: { user: [], assistant: [], system: [], tool: [] }, rich: { user: [], assistant: [], system: [], tool: [] } }, userBubble: { compat: [] }, content: {}, state: { edited: { turn: [], message: [] } } } });
    const trigger = document.querySelector('.wbAppearanceBtn');
    const out = { ready: a.isReady(), triggerMounted: !!trigger && !!trigger.closest('.wbTop'), panelBeforeOpen: !!document.querySelector('.wbAppearancePanel') };
    a.panel.open();
    const sections = [...document.querySelectorAll('.wbAppearanceSection')].map((s) => s.querySelector('.wbAppearanceSectionTitle').textContent);
    const reading = [...document.querySelectorAll('.wbAppearanceSection')].find((s) => s.querySelector('.wbAppearanceSectionTitle').textContent === 'Reading');
    const rows = [...reading.querySelectorAll('.wbAppearanceSectionBody > *')].map((r) => r.querySelector('.wbAppearanceRowLabel')?.textContent || r.className);
    const group = reading.querySelector('.wbAppearanceSegmented[aria-label="Presentation"]');
    const buttons = () => [...group.querySelectorAll('.wbAppearanceSegmentedBtn')].map((b) => ({ value: b.getAttribute('data-value'), label: b.textContent, on: b.classList.contains('is-on'), pressed: b.getAttribute('aria-pressed') }));
    out.sections = sections; out.readingRows = rows; out.options = buttons(); out.registry = pp.list().map((p) => [p.id, p.displayName]);
    out.hint = group.parentElement.querySelector('.wbAppearanceRowHint')?.textContent;
    /* click the Clean Reader option through the real button */
    const events = []; a.subscribe((e) => events.push([e.type, e.key, e.value]));
    group.querySelector('[data-value="h2o-clean-reader"]').click();
    out.afterClick = { value: a.get('presentationProfile'), options: buttons(), events: events.slice() };
    /* unknown value set programmatically (e.g. hydrated from another install): preserved, no button on */
    a.set('presentationProfile', 'no-such-profile');
    out.unknown = { value: a.get('presentationProfile'), options: buttons() };
    a.set('presentationProfile', 'chatgpt-reference');
    out.back = buttons();
    /* the panel never registers / resolves: registry untouched, sealed state untouched */
    out.registryAfter = { ids: [...pp.ids()], sealed: pp.sealed() };
    await new Promise((r) => setTimeout(r, 300)); /* debounce flush */
    out.persisted = window.__storage.writes.filter(([k]) => k.endsWith('presentationProfile:v1')).map(([, v]) => v);
    window.__panelOut = out;
    return out;
  });
  await shot(panelPage, 't4-appearance-panel-presentation-row', '.wbAppearancePanel');
  panel.closed = await panelPage.evaluate(() => { H2O.Studio.appearance.panel.close(); return document.querySelector('.wbAppearancePanel').hasAttribute('hidden'); });
  await panelPage.close();
  const { page: noRegistryPage, errors: noRegistryErrors } = await openPage('?registry=0');
  const noRegistry = await noRegistryPage.evaluate(async () => {
    const a = H2O.Studio.appearance;
    for (let i = 0; i < 20 && !a.isReady(); i += 1) await new Promise((r) => setTimeout(r, 5));
    a.panel.open();
    const reading = [...document.querySelectorAll('.wbAppearanceSection')].find((s) => s.querySelector('.wbAppearanceSectionTitle').textContent === 'Reading');
    return { renderer: typeof H2O.Studio.Renderer, sections: [...document.querySelectorAll('.wbAppearanceSection')].length, readingRows: [...reading.querySelectorAll('.wbAppearanceSectionBody > *')].map((r) => r.querySelector('.wbAppearanceRowLabel')?.textContent), presentationRow: !!document.querySelector('.wbAppearanceSegmented[aria-label="Presentation"]'), themeButtons: document.querySelectorAll('.wbAppearanceSegmented[aria-label="Theme"] .wbAppearanceSegmentedBtn').length, toggles: document.querySelectorAll('.wbAppearanceRow--toggle').length, value: a.get('presentationProfile'), errors: a.selfCheck().errors };
  });
  await noRegistryPage.close();

  check('M04 P2 T4 (D): the real Appearance panel adds one lazy, list-derived Presentation row to the Reading section (id -> value, displayName -> label, late registrations included); clicking selects through the store', () => {
    assert.deepEqual(panelErrors, [], 'no page errors');
    assert.deepEqual({ ready: panel.ready, triggerMounted: panel.triggerMounted, panelBeforeOpen: panel.panelBeforeOpen }, { ready: true, triggerMounted: true, panelBeforeOpen: false }, 'trigger mounted in .wbTop; the panel is built lazily on first open');
    assert.deepEqual(panel.sections, ['Theme', 'Typography', 'Reading', 'Options'], 'existing sections preserved');
    assert.deepEqual(panel.readingRows, ['Font size', 'Text width', 'Presentation'], 'one Presentation row appended to Reading');
    assert.deepEqual(panel.registry, [['chatgpt-reference', 'ChatGPT reference presentation'], ['h2o-clean-reader', 'H2O Clean Reader'], ['t4-late-registered', 'T4 late profile']]);
    assert.deepEqual(panel.options, [{ value: 'chatgpt-reference', label: 'ChatGPT reference presentation', on: true, pressed: 'true' }, { value: 'h2o-clean-reader', label: 'H2O Clean Reader', on: false, pressed: 'false' }, { value: 't4-late-registered', label: 'T4 late profile', on: false, pressed: 'false' }], 'options are exactly presentationProfile.list() at construction, default pressed');
    assert.equal(panel.hint, 'Reader presentation profile');
    assert.deepEqual(panel.afterClick.value, 'h2o-clean-reader'); assert.deepEqual(panel.afterClick.options.map((o) => o.on), [false, true, false]); assert.deepEqual(panel.afterClick.events, [['change', 'presentationProfile', 'h2o-clean-reader']]);
    assert.deepEqual(panel.unknown, { value: 'no-such-profile', options: panel.unknown.options }, 'unknown value preserved'); assert.deepEqual(panel.unknown.options.map((o) => o.on), [false, false, false], 'no option pressed for an unknown preference');
    assert.deepEqual(panel.back.map((o) => o.on), [true, false, false]);
    assert.deepEqual(panel.registryAfter, { ids: ['chatgpt-reference', 'h2o-clean-reader', 't4-late-registered'], sealed: false }, 'the panel registers and resolves nothing');
    assert.deepEqual(panel.persisted, ['chatgpt-reference'], 'the debounced flush persists the latest verbatim value');
    assert.equal(panel.closed, true);
  });
  check('M04 P2 T4 (D): with the Renderer registry unavailable the Presentation row is omitted and the rest of the panel is intact', () => {
    assert.deepEqual(noRegistryErrors, [], 'no page errors');
    assert.deepEqual(noRegistry, { renderer: 'undefined', sections: 4, readingRows: ['Font size', 'Text width'], presentationRow: false, themeButtons: 3, toggles: 3, value: 'chatgpt-reference', errors: [] });
  });

  /* ── Reader: selector-driven lifecycle through the real seams ── */
  async function readerScenario(query, body, after = null) {
    const { page, errors } = await openPage(query);
    const result = await page.evaluate(body, SNAPSHOT);
    if (after) await after(page, result);
    await page.close();
    return { result, errors };
  }
  const flow = await readerScenario('', async (SNAP) => {
    const a = H2O.Studio.appearance; const r = window.reader; const pp = H2O.Studio.Renderer.presentationProfile;
    for (let i = 0; i < 20 && !a.isReady(); i += 1) await new Promise((r2) => setTimeout(r2, 5));
    r.addSnapshot('snap-A', SNAP);
    r.subscribe(); r.subscribe();
    const out = { subscribed: typeof r.state.readerPresentationUnsubscribe, sealedBefore: pp.sealed() };
    await r.render('snap-A'); await r.idle();
    const root1 = r.currentRoot();
    out.first = { marker: root1.getAttribute('data-h2o-presentation-profile'), renders: r.renders.slice(), sealedAfter: pp.sealed(), userClass: root1.querySelector('.cgMsg[data-message-author-role="user"]').className, bound: r.state.currentReaderRender.root === root1, descriptor: r.state.currentReaderRender.presentation.effectiveId };
    /* same effective configuration: equivalent refresh reuses */
    await r.render('snap-A'); await r.idle();
    out.reuse = { sameRoot: r.currentRoot() === root1, renders: r.renders.length, mounts: r.hostState.mountCount };
    /* New UI selection through the real panel button */
    a.panel.open();
    document.querySelector('.wbAppearanceSegmented[aria-label="Presentation"] [data-value="h2o-clean-reader"]').click();
    a.panel.close();
    await r.idle();
    const root2 = r.currentRoot();
    out.selectClean = { marker: root2.getAttribute('data-h2o-presentation-profile'), newRoot: root2 !== root1, oldDetached: !root1.isConnected, renders: r.renders.slice(1), mounts: r.hostState.mountCount, unmounts: r.hostState.unmountCount, userClass: root2.querySelector('.cgMsg[data-message-author-role="user"]').className, code: root2.querySelector('.cgMsgBody pre').parentElement.className, rootsInReader: document.getElementById('viewReader').children.length, bound: r.state.currentReaderRender.root === root2 && r.state.currentReaderRender.presentation.effectiveId === 'h2o-clean-reader', userBlockRadius: getComputedStyle(root2.querySelector('.cgMsg[data-message-author-role="user"]')).borderTopLeftRadius };
    /* committed A -> B -> A: back to the reference rebuilds again, never the cached first root */
    a.set('presentationProfile', 'chatgpt-reference'); await r.idle();
    const root3 = r.currentRoot();
    out.backToReference = { marker: root3.getAttribute('data-h2o-presentation-profile'), fresh: root3 !== root1 && root3 !== root2, renders: r.renders.length, mounts: r.hostState.mountCount };
    /* rapid A -> B -> A before B commits */
    a.set('presentationProfile', 'h2o-clean-reader'); a.set('presentationProfile', 'chatgpt-reference'); await r.idle();
    out.rapid = { sameRoot: r.currentRoot() === root3, renders: r.renders.length, mounts: r.hostState.mountCount, marker: r.currentRoot().getAttribute('data-h2o-presentation-profile') };
    /* unknown preference resolving to the mounted configuration reuses; requested id is preserved by the store */
    a.set('presentationProfile', 'no-such-profile'); await r.idle();
    out.unknown = { sameRoot: r.currentRoot() === root3, renders: r.renders.length, stored: a.get('presentationProfile'), current: r.isCurrent('no-such-profile') };
    /* route leave: cleanup, then a change renders nothing */
    r.leave('test:leave'); await r.idle();
    a.set('presentationProfile', 'h2o-clean-reader'); await r.idle();
    out.leave = { readerChildren: document.getElementById('viewReader').children.length, binding: r.state.currentReaderRender, renders: r.renders.length, unmounts: r.hostState.unmountCount };
    /* reopen: the preference in force selects the profile of the first render */
    await r.render('snap-A'); await r.idle();
    out.reopen = { marker: r.currentRoot().getAttribute('data-h2o-presentation-profile'), reason: r.renders[r.renders.length - 1].reason, renders: r.renders.length };
    r.state.readerPresentationUnsubscribe();
    a.set('presentationProfile', 'chatgpt-reference'); await r.idle();
    out.unsubscribed = { renders: r.renders.length };
    return out;
  }, async (page) => {
    if (!SHOTS_DIR) return;
    /* the scenario ended by unsubscribing; re-arm the application-lifetime subscription for the visible run */
    await page.evaluate(async () => { const a = H2O.Studio.appearance; const r = window.reader; r.state.readerPresentationUnsubscribe = null; r.subscribe(); a.set('presentationProfile', 'chatgpt-reference'); await r.render('snap-A'); await r.idle(); });
    await shot(page, 't4-reader-reference-selected', '#viewReader');
    await page.evaluate(async () => { const a = H2O.Studio.appearance; const r = window.reader; a.panel.open(); document.querySelector('.wbAppearanceSegmented[aria-label="Presentation"] [data-value="h2o-clean-reader"]').click(); await r.idle(); });
    await shot(page, 't4-reader-clean-reader-selected-panel-open');
    await page.evaluate(() => H2O.Studio.appearance.panel.close());
    await shot(page, 't4-reader-clean-reader-selected', '#viewReader');
  });
  check('M04 P2 T4 (C): the real New UI selector drives the real Reader seams and Renderer — first render sealed under the current preference, equivalent reuse, Clean Reader selection rebuilds, committed A -> B -> A rebuilds twice, rapid bounce keeps A, unknown preference reuses, route leave cleans up', () => {
    assert.deepEqual(flow.errors, [], 'no page errors');
    const f = flow.result;
    assert.deepEqual({ subscribed: f.subscribed, sealedBefore: f.sealedBefore, sealedAfter: f.first.sealedAfter }, { subscribed: 'function', sealedBefore: false, sealedAfter: true }, 'one subscription; the first Reader render seals the registries');
    assert.deepEqual({ marker: f.first.marker, descriptor: f.first.descriptor, bound: f.first.bound, userClass: f.first.userClass, renders: f.first.renders.map((x) => [x.effectiveId, x.reason]) }, { marker: 'chatgpt-reference', descriptor: 'chatgpt-reference', bound: true, userClass: 'cgMsg cgMsg--user', renders: [['chatgpt-reference', 'explicit']] }, 'the default preference renders the reference profile explicitly');
    assert.deepEqual(f.reuse, { sameRoot: true, renders: 1, mounts: 1 }, 'same effective configuration reuses the mounted transcript');
    assert.deepEqual({ marker: f.selectClean.marker, newRoot: f.selectClean.newRoot, oldDetached: f.selectClean.oldDetached, renders: f.selectClean.renders.map((x) => x.effectiveId), mounts: f.selectClean.mounts, unmounts: f.selectClean.unmounts, userClass: f.selectClean.userClass, code: f.selectClean.code, rootsInReader: f.selectClean.rootsInReader, bound: f.selectClean.bound, userBlockRadius: f.selectClean.userBlockRadius }, { marker: 'h2o-clean-reader', newRoot: true, oldDetached: true, renders: ['h2o-clean-reader'], mounts: 2, unmounts: 1, userClass: 'cgMsg', code: 'h2oCleanCode', rootsInReader: 1, bound: true, userBlockRadius: '12px' }, 'selecting H2O Clean Reader in the panel disposes and rebuilds the open Reader under the new profile with its stylesheet applied');
    assert.deepEqual(f.backToReference, { marker: 'chatgpt-reference', fresh: true, renders: 3, mounts: 3 }, 'committed A -> B -> A rebuilds twice; no old-root cache');
    assert.deepEqual(f.rapid, { sameRoot: true, renders: 3, mounts: 3, marker: 'chatgpt-reference' }, 'rapid A -> B -> A before B commits: A stays, B never installs');
    assert.deepEqual(f.unknown, { sameRoot: true, renders: 3, stored: 'no-such-profile', current: true }, 'an unknown preference resolving to the mounted reference reuses; the raw choice is preserved by the store');
    assert.deepEqual(f.leave, { readerChildren: 0, binding: null, renders: 3, unmounts: 3 }, 'route leave disposes; a later change renders nothing');
    assert.deepEqual(f.reopen, { marker: 'h2o-clean-reader', reason: 'explicit', renders: 4 }, 'reopening renders under the preference in force');
    assert.deepEqual(f.unsubscribed, { renders: 4 }, 'the retained handle unsubscribes');
  });

  const hydrationDifferent = await readerScenario('?seed=h2o-clean-reader&defer=1', async (SNAP) => {
    const a = H2O.Studio.appearance; const r = window.reader;
    r.addSnapshot('snap-A', SNAP); r.subscribe();
    await r.render('snap-A'); await r.idle();
    const root1 = r.currentRoot();
    const before = { ready: a.isReady(), marker: root1.getAttribute('data-h2o-presentation-profile'), renders: r.renders.length };
    window.__storage.release(); /* hydration completes now: ready */
    for (let i = 0; i < 40 && !a.isReady(); i += 1) await new Promise((r2) => setTimeout(r2, 5));
    await r.idle();
    return { before, after: { ready: a.isReady(), value: a.get('presentationProfile'), marker: r.currentRoot().getAttribute('data-h2o-presentation-profile'), rebuilt: r.currentRoot() !== root1, renders: r.renders.map((x) => x.effectiveId), mounts: r.hostState.mountCount } };
  });
  const hydrationSame = await readerScenario('?seed=chatgpt-reference&defer=1', async (SNAP) => {
    const a = H2O.Studio.appearance; const r = window.reader;
    r.addSnapshot('snap-A', SNAP); r.subscribe();
    await r.render('snap-A'); await r.idle();
    const root1 = r.currentRoot();
    window.__storage.release();
    for (let i = 0; i < 40 && !a.isReady(); i += 1) await new Promise((r2) => setTimeout(r2, 5));
    await r.idle();
    return { ready: a.isReady(), sameRoot: r.currentRoot() === root1, renders: r.renders.length, mounts: r.hostState.mountCount };
  });
  const hydrationUnknown = await readerScenario('?seed=no-such-profile', async (SNAP) => {
    const a = H2O.Studio.appearance; const r = window.reader;
    for (let i = 0; i < 20 && !a.isReady(); i += 1) await new Promise((r2) => setTimeout(r2, 5));
    r.addSnapshot('snap-A', SNAP); r.subscribe();
    await r.render('snap-A'); await r.idle();
    a.panel.open();
    const pressed = [...document.querySelectorAll('.wbAppearanceSegmented[aria-label="Presentation"] .wbAppearanceSegmentedBtn')].map((b) => b.classList.contains('is-on'));
    await new Promise((r2) => setTimeout(r2, 300));
    return { value: a.get('presentationProfile'), render: r.renders[0], pressed, writes: window.__storage.writes.length };
  });
  check('M04 P2 T4 (C): hydration to a different persisted profile refreshes the open Reader once; hydration to the same profile never rebuilds; an unknown persisted id renders the reference fallback while the raw choice is kept and nothing is written back', () => {
    assert.deepEqual(hydrationDifferent.errors, []); assert.deepEqual(hydrationSame.errors, []); assert.deepEqual(hydrationUnknown.errors, []);
    assert.deepEqual(hydrationDifferent.result.before, { ready: false, marker: 'chatgpt-reference', renders: 1 }, 'rendered before hydration with the default');
    assert.deepEqual(hydrationDifferent.result.after, { ready: true, value: 'h2o-clean-reader', marker: 'h2o-clean-reader', rebuilt: true, renders: ['chatgpt-reference', 'h2o-clean-reader'], mounts: 2 }, 'ready with a different hydrated profile -> guarded refresh');
    assert.deepEqual(hydrationSame.result, { ready: true, sameRoot: true, renders: 1, mounts: 1 }, 'ready with the same effective profile -> no rebuild');
    assert.deepEqual({ value: hydrationUnknown.result.value, effectiveId: hydrationUnknown.result.render.effectiveId, requestedId: hydrationUnknown.result.render.requestedId, reason: hydrationUnknown.result.render.reason, pressed: hydrationUnknown.result.pressed, writes: hydrationUnknown.result.writes }, { value: 'no-such-profile', effectiveId: 'chatgpt-reference', requestedId: 'no-such-profile', reason: 'unknown-profile-fallback', pressed: [false, false], writes: 0 }, 'Renderer fallback, Reader preference preserved, no persisted effective fallback');
  });

  /* M04 P2 T3 (consolidated at T5): the real H2O Clean Reader profile on the
   * PRODUCTION chain (fresh page = open registries): synchronous admission
   * before the first render, sealing at that render, explicit selection in
   * canonical and rich fixtures with its stylesheet actually loaded and scoped,
   * semantic neutrality against the reference, bound-profile edits, Reader-route
   * end alignment, and the AC05b disclosure-interaction matrix below. */
  const t3Page = await browser.newPage();
  const t3Errors = [];
  t3Page.on('pageerror', (e) => t3Errors.push(String(e)));
  await t3Page.goto(`${base}/__profiles__`, { waitUntil: 'load' });
  const t3 = await t3Page.evaluate(() => {
    const R = globalThis.H2O.Studio.Renderer; const cr = globalThis.H2O.Studio.chatRenderer; const pp = R.presentationProfile; const cont = R.contentRenderer;
    const out = { errors: [] };
    const attempt = (label, fn) => { try { return fn(); } catch (e) { out.errors.push(label + ': ' + (e && e.message)); return null; } };
    const host = document.getElementById('host');
    const sheets = [...document.styleSheets].map((s) => ({ href: s.href ? new URL(s.href).pathname.replace(/^\//, '') : null, rules: (() => { try { return s.cssRules.length; } catch { return -1; } })() }));
    out.admission = { ids: [...pp.ids()], sealed: [pp.sealed(), cont.sealed()], digest: [pp.registryDigest(), cont.registryDigest()], sheets, describe: cr.describePresentation('h2o-clean-reader'), profileOwner: pp.get('h2o-clean-reader').owner, scripts: [...document.scripts].map((s) => new URL(s.src).pathname.replace(/^\//, '')) };
    const canonical = (id) => ({ chatId: 'c-t3', snapshotId: id, meta: { title: 'T3' }, messages: [
      { role: 'user', text: 'Question with `inline` and a [link](https://example.test/q)', messageId: `${id}-u1`, turnId: `${id}-t1` },
      { role: 'assistant', text: '## Heading\n\nParagraph **strong** and a [link](https://example.test/a).\n\n- one\n- two\n\n> quoted\n\n```js\nlet x = 1;\n```\n\n| a | b |\n| --- | --- |\n| 1 | 2 |', messageId: `${id}-a1`, turnId: `${id}-t1` },
    ] });
    const mount = (r) => { host.appendChild(r.root); return r; };
    const cs = (el, props) => Object.fromEntries(props.map((p) => [p, getComputedStyle(el).getPropertyValue(p)]));
    const classesOf = (r) => ({ marker: r.root.getAttribute('data-h2o-presentation-profile'), transcript: r.turnsEl.className, userTurn: r.root.querySelector('.cgTurn--user').className, userMsg: r.root.querySelector('.cgMsg[data-message-author-role="user"]').className, assistantMsg: r.root.querySelector('.cgMsg[data-message-author-role="assistant"]').className, code: r.root.querySelector('.cgMsgBody pre').parentElement.className, lang: r.root.querySelector('.cgMsgBody pre').parentElement.firstElementChild.className });
    const C = mount(cr.render(canonical('C'), { presentationProfile: 'h2o-clean-reader', getEditOverride: () => null }));
    out.afterFirstRender = { sealed: [pp.sealed(), cont.sealed()], descriptor: C.presentation, classes: classesOf(C), stillRegistered: pp.get('h2o-clean-reader') !== null && pp.resolve('h2o-clean-reader').reason === 'explicit', profileEntries: JSON.parse(JSON.parse(C.presentation.registryDigest).presentationProfile).entries.map((e) => [e.id, e.owner, e.version]) };
    out.late = attempt('late', () => { try { pp.register({ id: 't3-late', owner: 't3', version: '1.0.0', displayName: 'late', provider: null, stylesheet: null, modes: ['canonical', 'rich'], hooks: { transcript: { canonical: [], rich: [] }, turn: { base: [], canonical: [], rich: [], role: { user: [], assistant: [], system: [], tool: [] } }, message: { canonical: { user: [], assistant: [], system: [], tool: [] }, rich: { user: [], assistant: [], system: [], tool: [] } }, userBubble: { compat: [] }, content: {}, state: { edited: { turn: [], message: [] } } } }); return 'accepted'; } catch (e) { return e.code; } });
    const Rf = mount(cr.render(canonical('R'), { presentationProfile: 'chatgpt-reference', getEditOverride: () => null }));
    const D = mount(cr.render(canonical('D'), { getEditOverride: () => null }));
    out.reference = { classes: classesOf(Rf), descriptor: { effectiveId: Rf.presentation.effectiveId, reason: Rf.presentation.reason }, defaultClasses: classesOf(D), defaultReason: D.presentation.reason };
    /* The Clean Reader stylesheet is applied to its root only: distinguishing declarations on the user host and the code language badge. */
    const userProps = ['border-top-width', 'border-top-left-radius', 'background-color', 'width'];
    const langProps = ['text-transform', 'border-bottom-width', 'letter-spacing'];
    const userHost = (r) => r.root.querySelector('.cgMsg[data-message-author-role="user"]');
    const lang = (r) => r.root.querySelector('.cgMsgBody pre').parentElement.firstElementChild;
    out.styles = { cleanUser: cs(userHost(C), userProps), referenceUser: cs(userHost(Rf), userProps), cleanLang: cs(lang(C), langProps), referenceLang: cs(lang(Rf), langProps), cleanBody: cs(C.root.querySelector('.cgMsgBody'), ['line-height', 'font-size']), referenceBody: cs(Rf.root.querySelector('.cgMsgBody'), ['line-height', 'font-size']), rootFontSize: getComputedStyle(C.root).fontSize };
    /* Semantic neutrality: same input under Clean Reader / reference / default. */
    const skeleton = (r) => r.root.outerHTML.replace(/ class="[^"]*"/g, '').replace(/ data-h2o-presentation-profile="[^"]*"/g, '');
    const keys = (r) => JSON.stringify({ t: r.semanticIndex.turns().map((x) => [x.projectionKey, x.role]), m: r.semanticIndex.messages().map((x) => [x.projectionKey, x.role]), b: r.semanticIndex.blocks().map((x) => x.projectionKey), x: r.semanticIndex.texts().length });
    const N1 = cr.render(canonical('N'), { presentationProfile: 'h2o-clean-reader', getEditOverride: () => null }); const N2 = cr.render(canonical('N'), { presentationProfile: 'chatgpt-reference', getEditOverride: () => null }); const N3 = cr.render(canonical('N'), { getEditOverride: () => null });
    out.neutral = { text: N1.root.textContent === N2.root.textContent && N1.root.textContent === N3.root.textContent, keys: keys(N1) === keys(N2) && keys(N1) === keys(N3), skeleton: skeleton(N1) === skeleton(N2) && skeleton(N1) === skeleton(N3), blocks: N1.semanticIndex.blocks().length, links: [N1, N2].map((r) => [...r.root.querySelectorAll('a[href]')].map((a) => a.getAttribute('href')).join('|')), sameDigest: N1.presentation.registryDigest === N2.presentation.registryDigest };
    /* Bound-profile edit under Clean Reader: host modifiers and nested code hooks. */
    const msgC = C.root.querySelector('.cgMsg[data-message-author-role="assistant"]');
    cr.applyEditedMessageBody(msgC, 'assistant', 'edited:\n\n```py\nprint(1)\n```');
    const editedTurn = C.root.querySelectorAll('.cgTurn')[1];
    out.edit = { host: msgC.className, code: msgC.querySelector('.cgMsgBody pre').parentElement.className, turn: editedTurn.className, editedShadow: getComputedStyle(msgC).boxShadow !== 'none' };
    /* Rich replay under Clean Reader: provider bubble replaced by the plain H2O bubble; captured content gets baseline + element rules. */
    const richTurn = (role, idx, inner) => ({ role, turnIdx: idx, messageId: `r-${idx}`, turnId: `rt-${idx}`, outerHTML: '<article data-testid="conversation-turn-' + idx + '"><div data-message-author-role="' + role + '" data-message-id="p-' + idx + '">' + inner + '</div></article>' });
    const richInput = (id) => ({ chatId: 'c-rich', snapshotId: id, messages: [ { role: 'user', text: 'q', messageId: 'r-1' }, { role: 'assistant', text: 'a', messageId: 'r-2' } ], richTurns: [
      richTurn('user', 1, '<div class="flex w-full flex-col"><div class="user-message-bubble-color">q <span tabindex="0">t</span></div></div>'),
      /* M04-P2-R02 (decision F) interaction matrix: an admitted https link, a
       * javascript: link, an event handler, tabindex, a details with an explicit
       * summary, an authored open details, a details WITHOUT a summary (user-agent
       * default disclosure control), and blocked provider form / controls. */
      richTurn('assistant', 2, '<div class="markdown prose"><p class="text-token-text-secondary">a <a href="https://example.test/p">provider link</a> <a href="javascript:window.__providerJs=1">js link</a> <span tabindex="0" onclick="window.__providerHandler=1">handler</span> <code>c</code></p><ul><li>item</li></ul><pre><code>code</code></pre>'
        + '<details><summary>Explicit summary</summary><p>hidden one</p></details><details open><summary>Authored open</summary><p>visible two</p></details><details><p>no summary content</p></details>'
        + '<form action="https://example.test/submit"><input type="text" name="q"><select><option>o</option></select><textarea>t</textarea><button type="submit">Go</button></form><button type="button" onclick="window.__providerButton=1">provider button</button></div>'),
    ] });
    const RC = mount(cr.render(richInput('RC'), { presentationProfile: 'h2o-clean-reader', getEditOverride: () => null }));
    const RR = mount(cr.render(richInput('RR'), { presentationProfile: 'chatgpt-reference', getEditOverride: () => null }));
    const bubble = RC.root.querySelector('.cgBubble');
    out.rich = { mode: RC.renderMode, descriptor: { effectiveId: RC.presentation.effectiveId, reason: RC.presentation.reason }, transcript: RC.turnsEl.className, userTurn: RC.root.querySelector('.cgTurn--user').className, bubble: bubble.className, providerMarkerLeft: RC.root.querySelectorAll('.user-message-bubble-color').length, referenceBubble: RR.root.querySelector('.cgBubble').className,
      bubbleStyle: cs(bubble, ['border-top-width', 'border-top-left-radius']), referenceBubbleStyle: cs(RR.root.querySelector('.cgBubble'), ['border-top-width', 'border-top-left-radius']),
      textEqual: RC.root.textContent === RR.root.textContent,
      /* Decision F: sanitizer negatives (policyVersion 2) and the admitted native disclosure facts under both profiles. */
      sanitizer: Object.fromEntries([['clean', RC], ['reference', RR]].map(([label, r]) => { const provider = r.root.querySelector('[data-message-author-role="assistant"]'); const q = (sel) => provider.querySelectorAll(sel).length; return [label, { button: q('button'), input: q('input'), form: q('form'), select: q('select'), textarea: q('textarea'), tabindex: q('[tabindex]'), handlers: [...provider.querySelectorAll('*')].filter((el) => [...el.attributes].some((a) => /^on/i.test(a.name))).length, javascriptLinks: [...provider.querySelectorAll('a')].filter((a) => /^\s*javascript:/i.test(a.getAttribute('href') || '')).length, hrefs: [...provider.querySelectorAll('a')].map((a) => a.getAttribute('href')), details: q('details'), summaries: q('summary'), authoredOpen: [...provider.querySelectorAll('details')].map((d) => d.open), summaryPointer: [...provider.querySelectorAll('summary')].map((el) => getComputedStyle(el).pointerEvents), detailsPointer: [...provider.querySelectorAll('details')].map((el) => getComputedStyle(el).pointerEvents), linkPointer: getComputedStyle(provider.querySelector('a[href]')).pointerEvents }]; })),
      /* Residual provider-utility behaviour, measured: the reference bridges the token class, the Clean Reader inherits the root text colour. */
      tokenClass: { clean: getComputedStyle(RC.root.querySelector('.text-token-text-secondary')).color, cleanRoot: getComputedStyle(RC.turnsEl).color, reference: getComputedStyle(RR.root.querySelector('.text-token-text-secondary')).color, referenceSoft: getComputedStyle(RR.turnsEl).getPropertyValue('--wb-text-soft').trim() },
      richPre: cs(RC.root.querySelector('[data-message-author-role="assistant"] pre'), ['border-top-width', 'border-top-left-radius']) };
    /* Reader-route end alignment of user turns under both profiles (structural, studio.css). */
    document.body.setAttribute('data-route', 'reader');
    const edge = (turn, el) => { const t = turn.getBoundingClientRect(); const e = el.getBoundingClientRect(); return { alignItems: getComputedStyle(turn).alignItems, rightGap: Math.round(t.right - e.right), narrower: e.width < t.width - 8 }; };
    out.readerRoute = { cleanCanonical: edge(C.root.querySelector('.cgTurn--user'), userHost(C)), referenceCanonical: edge(Rf.root.querySelector('.cgTurn--user'), userHost(Rf)), cleanRich: edge(RC.root.querySelector('.cgTurn--user'), bubble), referenceRich: edge(RR.root.querySelector('.cgTurn--user'), RR.root.querySelector('.cgBubble')) };
    document.body.removeAttribute('data-route');
    out.rendererGlobals = Object.keys(R).filter((k) => /clean|profile|presentation/i.test(k));
    window.__t3 = { RC, RR };
    return out;
  });
  /* M04-P2-R02 (HDA decision F): the enforceable disclosure-interaction matrix,
   * run for each profile with that render alone mounted. Real sequential focus
   * (Tab), real pointer clicks, Enter / Space, programmatic activation, the
   * authored open state, the user-agent default disclosure control of a
   * summary-less details (the target browser decides the exposed focus target;
   * only the association with that details is asserted), the Chromium
   * accessibility tree (CDP) and an H2O-owned positive-control button placed in
   * the rich root outside the provider-content subtree. */
  const cdp = await t3Page.context().newCDPSession(t3Page);
  async function disclosureMatrix(profileKey) {
    await t3Page.evaluate((key) => {
      const r = window.__t3[key]; const host = document.getElementById('host'); host.replaceChildren(r.root);
      window.__providerJs = 0; window.__providerHandler = 0; window.__providerButton = 0; window.__h2oClicks = 0;
      let control = r.turnsEl.querySelector(':scope > .h2oR02PositiveControl');
      if (!control) { control = document.createElement('button'); control.type = 'button'; control.className = 'h2oR02PositiveControl'; control.textContent = 'H2O control'; control.addEventListener('click', () => { window.__h2oClicks += 1; }); r.turnsEl.appendChild(control); }
      const details = [...r.root.querySelectorAll('[data-message-author-role="assistant"] details')];
      window.__r02 = { root: r.root, details, explicit: details[0], authored: details[1], summaryless: details[2], control };
      document.body.focus();
    }, profileKey);
    const out = {};
    const detailsState = () => t3Page.evaluate(() => window.__r02.details.map((d) => d.open));
    out.initialOpen = await detailsState();
    /* sequential focus: everything Tab reaches inside the render, classified */
    const focus = [];
    for (let i = 0; i < 12; i += 1) {
      await t3Page.keyboard.press('Tab');
      const f = await t3Page.evaluate(() => { const el = document.activeElement; const R = window.__r02; if (!el || el === document.body || !R.root.contains(el)) return null; const owner = R.details.findIndex((d) => d === el || d.contains(el)); return { tag: el.tagName.toLowerCase(), href: el.getAttribute('href'), providerOrigin: !!el.closest('[data-message-author-role]'), h2oControl: el === R.control, details: owner === -1 ? null : ['explicit', 'authored', 'summaryless'][owner], isDetailsHost: el.tagName.toLowerCase() === 'details' }; });
      if (!f || focus.some((x) => JSON.stringify(x) === JSON.stringify(f))) break;
      focus.push(f);
    }
    out.focus = focus;
    /* explicit summary: real pointer click, Enter, Space, programmatic, each from the closed state */
    const summaryPoint = (which) => t3Page.evaluate((w) => { const d = window.__r02[w]; d.open = false; const s = d.querySelector(':scope > summary'); const b = s.getBoundingClientRect(); s.blur(); return { x: b.x + 12, y: b.y + b.height / 2 }; }, which);
    const open = (which) => t3Page.evaluate((w) => window.__r02[w].open, which);
    let pt = await summaryPoint('explicit'); await t3Page.mouse.click(pt.x, pt.y); out.explicitClick = await open('explicit');
    await t3Page.evaluate(() => { const d = window.__r02.explicit; d.open = false; d.querySelector(':scope > summary').focus(); }); await t3Page.keyboard.press('Enter'); out.explicitEnter = await open('explicit');
    await t3Page.evaluate(() => { const d = window.__r02.explicit; d.open = false; d.querySelector(':scope > summary').focus(); }); await t3Page.keyboard.press('Space'); out.explicitSpace = await open('explicit');
    await t3Page.evaluate(() => { const d = window.__r02.explicit; d.open = false; d.querySelector(':scope > summary').click(); }); out.explicitProgrammatic = await open('explicit');
    /* authored open: preserved before interaction, then a real click closes and a second reopens */
    out.authoredPreserved = await t3Page.evaluate(() => window.__r02.authored.open);
    pt = await t3Page.evaluate(() => { const s = window.__r02.authored.querySelector(':scope > summary'); const b = s.getBoundingClientRect(); return { x: b.x + 12, y: b.y + b.height / 2 }; });
    await t3Page.mouse.click(pt.x, pt.y); out.authoredClosedByClick = await open('authored');
    await t3Page.mouse.click(pt.x, pt.y); out.authoredReopened = await open('authored');
    /* summary-less details: the user-agent default disclosure control */
    pt = await t3Page.evaluate(() => { const d = window.__r02.summaryless; d.open = false; const b = d.getBoundingClientRect(); return { x: b.x + 12, y: b.y + Math.min(9, b.height / 2) }; });
    await t3Page.mouse.click(pt.x, pt.y); out.summarylessClick = await open('summaryless');
    await t3Page.evaluate(() => { window.__r02.summaryless.open = false; document.body.focus(); });
    let reached = null;
    for (let i = 0; i < 12 && !reached; i += 1) { await t3Page.keyboard.press('Tab'); reached = await t3Page.evaluate(() => { const el = document.activeElement; const d = window.__r02.summaryless; return el && (el === d || d.contains(el)) ? { tag: el.tagName.toLowerCase(), isHost: el === d } : null; }); }
    out.summarylessFocus = reached;
    await t3Page.keyboard.press('Enter'); out.summarylessEnter = await open('summaryless');
    await t3Page.keyboard.press('Space'); out.summarylessSpace = await open('summaryless');
    /* accessibility tree: disclosure roles, names and expanded state (Chromium CDP) */
    const axOf = async () => { const tree = await cdp.send('Accessibility.getFullAXTree'); return tree.nodes.filter((n) => n.role?.value === 'DisclosureTriangle').map((n) => ({ name: n.name?.value, focusable: (n.properties || []).find((p) => p.name === 'focusable')?.value?.value ?? null, expanded: (n.properties || []).find((p) => p.name === 'expanded')?.value?.value ?? null })); };
    await t3Page.evaluate(() => { window.__r02.explicit.open = false; window.__r02.authored.open = true; window.__r02.summaryless.open = false; });
    out.axBefore = await axOf();
    await t3Page.evaluate(() => { window.__r02.explicit.open = true; window.__r02.summaryless.open = true; });
    out.axAfter = await axOf();
    /* H2O-owned positive control: real pointer click, Enter, Space */
    pt = await t3Page.evaluate(() => { const b = window.__r02.control.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2, pointer: getComputedStyle(window.__r02.control).pointerEvents }; });
    out.controlPointer = pt.pointer;
    await t3Page.mouse.click(pt.x, pt.y); out.controlAfterClick = await t3Page.evaluate(() => window.__h2oClicks);
    await t3Page.evaluate(() => window.__r02.control.focus()); await t3Page.keyboard.press('Enter'); await t3Page.keyboard.press('Space'); out.controlAfterKeys = await t3Page.evaluate(() => window.__h2oClicks);
    out.providerHandlersFired = await t3Page.evaluate(() => [window.__providerJs, window.__providerHandler, window.__providerButton]);
    await t3Page.evaluate(() => { window.__r02.explicit.open = false; window.__r02.authored.open = true; window.__r02.summaryless.open = false; });
    return out;
  }
  await t3Page.evaluate(() => { window.__t3.RR = window.__t3.RR || null; });
  const matrix = { clean: await disclosureMatrix('RC'), reference: await disclosureMatrix('RR') };
  await t3Page.close();

  check('M04 P2 T3: on the production chain the Clean Reader module registers synchronously before the first render while both registries are open; its stylesheet is loaded; the first render seals both, the profile stays admitted and late registration is rejected', () => {
    assert.deepEqual(t3.errors, [], 'no harness errors'); assert.deepEqual(t3Errors, [], 'no page errors (the module evaluated without throwing)');
    assert.deepEqual(t3.admission.scripts.filter((s) => PRODUCTION_CHAIN.includes(s)), [...PRODUCTION_CHAIN], 'A: the page executed the production chain in production order');
    assert.deepEqual(t3.admission.ids, ['chatgpt-reference', 'h2o-clean-reader'], 'A: h2o-clean-reader is registered by its own module, after the reference');
    assert.deepEqual({ sealed: t3.admission.sealed, digest: t3.admission.digest }, { sealed: [false, false], digest: [null, null] }, 'A: both registries are still open after the chain evaluated');
    assert.deepEqual({ requestedId: t3.admission.describe.requestedId, effectiveId: t3.admission.describe.effectiveId, reason: t3.admission.describe.reason, profileVersion: t3.admission.describe.profileVersion, registryDigest: t3.admission.describe.registryDigest }, { requestedId: 'h2o-clean-reader', effectiveId: 'h2o-clean-reader', reason: 'explicit', profileVersion: '1.0.0', registryDigest: null }, 'A: describePresentation resolves it explicitly before sealing');
    assert.equal(t3.admission.profileOwner, 'L-STUDIO-RENDERER');
    assert.deepEqual(t3.admission.sheets.map((s) => s.href), [...PRODUCTION_STYLESHEETS], 'B: studio.css, the reference stylesheet and the Clean Reader stylesheet are the loaded stylesheets, in production order');
    assert.ok(t3.admission.sheets[2].rules > 20, 'B: the Clean Reader stylesheet parsed with its rules');
    assert.deepEqual(t3.afterFirstRender.sealed, [true, true], 'C: the first render seals both registries');
    assert.equal(t3.afterFirstRender.stillRegistered, true, 'C: the profile remains admitted after sealing'); assert.equal(t3.late, 'registry-sealed', 'C: late registration is rejected');
    assert.deepEqual(t3.afterFirstRender.profileEntries, [['chatgpt-reference', 'L-STUDIO-RENDERER', '1.0.0'], ['h2o-clean-reader', 'L-STUDIO-RENDERER', '1.0.0']], 'C: the sealed digest names both admitted profiles');
  });

  check('M04 P2 T3: explicit Clean Reader selection renders profile-correct canonical and rich output through its own stylesheet, scoped to its root; default / reference output is unchanged on the same page', () => {
    const d = t3.afterFirstRender.descriptor;
    assert.deepEqual({ requestedId: d.requestedId, effectiveId: d.effectiveId, profileVersion: d.profileVersion, reason: d.reason }, { requestedId: 'h2o-clean-reader', effectiveId: 'h2o-clean-reader', profileVersion: '1.0.0', reason: 'explicit' });
    assert.deepEqual(t3.afterFirstRender.classes, { marker: 'h2o-clean-reader', transcript: 'cgScroll wbReaderScroll wbRichRoot', userTurn: 'cgTurn cgTurn--user', userMsg: 'cgMsg', assistantMsg: 'cgMsg', code: 'h2oCleanCode', lang: 'h2oCleanCodeLang' }, 'A: empty shell hooks (structural vocabulary + wbRichRoot only), profile-local content hooks');
    assert.deepEqual(t3.reference.classes, { marker: 'chatgpt-reference', transcript: 'cgScroll wbReaderScroll wbRichRoot', userTurn: 'cgTurn cgTurn--user wbTurn wbTurn--fallback wbTurn--user', userMsg: 'cgMsg cgMsg--user', assistantMsg: 'cgMsg cgMsg--assistant', code: 'wbCodeBlock', lang: 'wbCodeLang' }, 'B: the reference output is unchanged by the admission');
    assert.deepEqual(t3.reference.defaultClasses, t3.reference.classes, 'B: the default (absent request) is still the reference'); assert.equal(t3.reference.defaultReason, 'default');
    assert.deepEqual(t3.styles.cleanUser, { 'border-top-width': '1px', 'border-top-left-radius': '12px', 'background-color': t3.styles.cleanUser['background-color'], width: t3.styles.cleanUser.width }, 'C: Clean Reader user host = 1px hairline, 12px radius (h2o-clean-reader.v1.css)');
    assert.deepEqual([t3.styles.referenceUser['border-top-width'], t3.styles.referenceUser['border-top-left-radius']], ['0px', '24px'], 'C: the reference user host keeps its 24px bubble, unaffected by the Clean Reader rules (scope)');
    assert.deepEqual([t3.styles.cleanLang['text-transform'], t3.styles.cleanLang['border-bottom-width']], ['uppercase', '1px'], 'C: Clean Reader language badge rule applied');
    assert.deepEqual([t3.styles.referenceLang['text-transform'], t3.styles.referenceLang['border-bottom-width']], ['uppercase', '0px'], 'C: the reference badge rule is the reference one');
    assert.equal(t3.styles.cleanBody['line-height'], `${Math.round(parseFloat(t3.styles.cleanBody['font-size']) * 1.7 * 100) / 100}px`, 'C: relative body rhythm (1.7 line-height on the em size)');
    assert.equal(t3.styles.referenceBody['font-size'], '16px', 'C: the reference body keeps its absolute size');
    assert.deepEqual(t3.edit, { host: 'cgMsg h2oCleanMsg--edited', code: 'h2oCleanCode', turn: 'cgTurn cgTurn--assistant', editedShadow: true }, 'D: a later edit of a Clean Reader root runs under its bound profile (host edit hook skinned, nested code hook)');
    assert.deepEqual({ mode: t3.rich.mode, descriptor: t3.rich.descriptor, transcript: t3.rich.transcript, userTurn: t3.rich.userTurn, bubble: t3.rich.bubble, providerMarkerLeft: t3.rich.providerMarkerLeft, referenceBubble: t3.rich.referenceBubble }, { mode: 'rich', descriptor: { effectiveId: 'h2o-clean-reader', reason: 'explicit' }, transcript: 'cgScroll wbReaderScroll wbRichRoot', userTurn: 'cgTurn cgTurn--user', bubble: 'cgBubble cgBubble--user', providerMarkerLeft: 0, referenceBubble: 'cgBubble cgBubble--user user-message-bubble-color' }, 'E: rich replay under Clean Reader: no is-rich transcript hook, plain H2O bubble without the provider compatibility class; the reference keeps it');
    assert.deepEqual([t3.rich.bubbleStyle, t3.rich.referenceBubbleStyle], [{ 'border-top-width': '1px', 'border-top-left-radius': '12px' }, { 'border-top-width': '0px', 'border-top-left-radius': '24px' }], 'E: the Clean Reader bubble rule is scoped to its root');
    assert.deepEqual(t3.rich.richPre, { 'border-top-width': '1px', 'border-top-left-radius': '12px' }, 'E: captured content receives the Clean Reader element rules');
    assert.equal(t3.rich.textEqual, true, 'E: identical captured text under both profiles');
    assert.deepEqual(t3.rendererGlobals, ['presentationProfile'], 'no Clean Reader state on the Renderer namespace');
  });

  check('M04 P2 T3: semantic / text / index neutrality against the reference and Reader-route end alignment under both profiles', () => {
    assert.deepEqual({ text: t3.neutral.text, keys: t3.neutral.keys, skeleton: t3.neutral.skeleton, sameDigest: t3.neutral.sameDigest }, { text: true, keys: true, skeleton: true, sameDigest: true }, 'A: same textContent, Semantic Index keys / roles and DOM skeleton (class attributes and the root marker excepted) under Clean Reader, reference and default');
    assert.ok(t3.neutral.blocks >= 6, 'A: the fixture exercises heading / paragraph / list / quote / code / table blocks'); assert.equal(t3.neutral.links[0], t3.neutral.links[1], 'A: identical admitted links');
    for (const [label, edge] of Object.entries(t3.readerRoute)) { assert.equal(edge.alignItems, 'flex-end', `B: ${label}: user turn end-aligned on the Reader route`); assert.ok(edge.rightGap <= 1 && edge.rightGap >= -1, `B: ${label}: the user block hugs the column end (gap ${edge.rightGap}px)`); assert.equal(edge.narrower, true, `B: ${label}: shrink-to-fit block`); }
    assert.equal(t3.rich.tokenClass.clean, t3.rich.tokenClass.cleanRoot, 'C: accepted limitation measured - a provider token utility class is NOT bridged under Clean Reader (inherits the root text colour)');
    assert.notEqual(t3.rich.tokenClass.reference, t3.rich.tokenClass.clean, 'C: the same captured markup IS bridged by the reference profile (provider fidelity stays with chatgpt-reference)');
  });

  /* M04-P2-R02 / AC05b (HDA decision F): enforceable, not observational. The
   * sanitizer policy (policyVersion 2) is the single provider-interaction
   * authority: only admitted links and native disclosure controls survive and
   * they must be consistently operable by pointer, keyboard and assistive
   * technology under both profiles; nothing suppresses them. */
  check('AC05b (decision F): the sanitizer admits only links and native disclosure - provider button / input / form / select / textarea / tabindex / event handler / javascript: link do not survive, under both profiles', () => {
    for (const [label, facts] of Object.entries(t3.rich.sanitizer)) {
      assert.deepEqual({ button: facts.button, input: facts.input, form: facts.form, select: facts.select, textarea: facts.textarea, tabindex: facts.tabindex, handlers: facts.handlers, javascriptLinks: facts.javascriptLinks }, { button: 0, input: 0, form: 0, select: 0, textarea: 0, tabindex: 0, handlers: 0, javascriptLinks: 0 }, `${label}: blocked provider controls and forbidden attributes / URLs do not survive`);
      assert.deepEqual(facts.hrefs, ['https://example.test/p', null], `${label}: the https link keeps its href; the javascript: link keeps none`);
      assert.deepEqual({ details: facts.details, summaries: facts.summaries, authoredOpen: facts.authoredOpen }, { details: 3, summaries: 2, authoredOpen: [false, true, false] }, `${label}: native details / summary and the authored open state are admitted verbatim`);
    }
    for (const profile of ['clean', 'reference']) assert.deepEqual(matrix[profile].providerHandlersFired, [0, 0, 0], `${profile}: no provider script hook ever ran`);
  });

  check('AC05b (decision F): admitted summaries have computed pointer-events auto under both profiles; nothing else in the render suppresses disclosure or the H2O control', () => {
    for (const [label, facts] of Object.entries(t3.rich.sanitizer)) {
      assert.deepEqual(facts.summaryPointer, ['auto', 'auto'], `${label}: explicit summaries are pointer-operable`);
      assert.deepEqual(facts.detailsPointer, ['auto', 'auto', 'auto'], `${label}: details (incl. the summary-less one carrying the user-agent disclosure) are pointer-operable`);
      assert.equal(facts.linkPointer, 'auto', `${label}: the admitted link stays pointer-active`);
    }
    for (const profile of ['clean', 'reference']) assert.equal(matrix[profile].controlPointer, 'auto', `${profile}: the H2O-owned control in the rich root is not pointer-suppressed`);
  });

  check('AC05b (decision F): only sanitizer-admitted links, native disclosure controls and the H2O-owned control take sequential focus; the user-agent default disclosure of a summary-less details is reachable without a fixed host assumption', () => {
    for (const profile of ['clean', 'reference']) {
      const m = matrix[profile];
      const provider = m.focus.filter((f) => f.providerOrigin);
      assert.ok(provider.some((f) => f.tag === 'a' && f.href === 'https://example.test/p'), `${profile}: the admitted link is focusable`);
      assert.ok(provider.every((f) => (f.tag === 'a' && f.href === 'https://example.test/p') || f.details !== null), `${profile}: every provider-origin focus stop is the admitted link or a native disclosure control (observed: ${JSON.stringify(provider)})`);
      assert.deepEqual(provider.filter((f) => f.details !== null).map((f) => f.details), ['explicit', 'authored', 'summaryless'], `${profile}: each of the three disclosures exposes exactly one focus stop, in document order`);
      assert.ok(provider.every((f) => f.tag !== 'button' && f.tag !== 'input' && f.tag !== 'span'), `${profile}: no blocked control takes focus`);
      assert.ok(m.focus.some((f) => f.h2oControl), `${profile}: the H2O-owned positive control is in the sequential focus order`);
      assert.ok(m.summarylessFocus && (m.summarylessFocus.isHost || m.summarylessFocus.tag === 'summary'), `${profile}: sequential focus reaches the summary-less details' user-agent disclosure (host or its default summary; observed ${JSON.stringify(m.summarylessFocus)})`);
    }
  });

  check('AC05b (decision F): real pointer click, Enter, Space and programmatic activation each toggle disclosure from a reset state; the authored open state is preserved before interaction; the user-agent default control toggles too - identically under both profiles', () => {
    for (const profile of ['clean', 'reference']) {
      const m = matrix[profile];
      assert.deepEqual(m.initialOpen, [false, true, false], `${profile}: authored open state preserved before any interaction`);
      assert.deepEqual({ click: m.explicitClick, enter: m.explicitEnter, space: m.explicitSpace, programmatic: m.explicitProgrammatic }, { click: true, enter: true, space: true, programmatic: true }, `${profile}: explicit summary toggles by pointer, Enter, Space and programmatic activation`);
      assert.deepEqual({ preserved: m.authoredPreserved, closedByClick: m.authoredClosedByClick, reopened: m.authoredReopened }, { preserved: true, closedByClick: false, reopened: true }, `${profile}: authored open disclosure closes and reopens by real clicks`);
      assert.deepEqual({ click: m.summarylessClick, enter: m.summarylessEnter, space: m.summarylessSpace }, { click: true, enter: true, space: false }, `${profile}: the user-agent default disclosure toggles by pointer, Enter (open) and Space (close)`);
      assert.deepEqual({ afterClick: m.controlAfterClick, afterKeys: m.controlAfterKeys }, { afterClick: 1, afterKeys: 3 }, `${profile}: the H2O-owned control receives a real click and keyboard activation`);
    }
    const semantics = (m) => JSON.stringify({ focus: m.focus.map((f) => [f.tag, f.details, f.h2oControl, f.providerOrigin]), initialOpen: m.initialOpen, explicit: [m.explicitClick, m.explicitEnter, m.explicitSpace, m.explicitProgrammatic], authored: [m.authoredPreserved, m.authoredClosedByClick, m.authoredReopened], summaryless: [m.summarylessClick, m.summarylessEnter, m.summarylessSpace, m.summarylessFocus?.isHost, m.summarylessFocus?.tag], control: [m.controlAfterClick, m.controlAfterKeys], ax: [m.axBefore, m.axAfter] });
    assert.equal(semantics(matrix.clean), semantics(matrix.reference), 'both presentation profiles produce equivalent interaction semantics');
  });

  check('AC05b (decision F): the accessibility tree exposes disclosure controls with names, focusability and expanded state under both profiles', () => {
    for (const profile of ['clean', 'reference']) {
      const m = matrix[profile];
      const byName = (list, name) => list.find((n) => n.name === name);
      for (const [phase, list, explicitExpanded, summarylessExpanded] of [['before', m.axBefore, false, false], ['after', m.axAfter, true, true]]) {
        assert.ok(byName(list, 'Explicit summary') && byName(list, 'Authored open') && byName(list, 'Details'), `${profile}/${phase}: disclosure nodes for the explicit, authored and user-agent default ("Details") summaries`);
        assert.deepEqual([byName(list, 'Explicit summary').focusable, byName(list, 'Authored open').focusable, byName(list, 'Details').focusable], [true, true, true], `${profile}/${phase}: all three disclosure controls are focusable`);
        assert.equal(byName(list, 'Explicit summary').expanded, explicitExpanded, `${profile}/${phase}: explicit summary expanded state`);
        assert.equal(byName(list, 'Authored open').expanded, true, `${profile}/${phase}: authored open stays expanded`);
        const ua = byName(list, 'Details').expanded;
        if (ua !== null) assert.equal(ua, summarylessExpanded, `${profile}/${phase}: user-agent default disclosure expanded state, where the browser exposes it`);
      }
    }
  });

  await browser.close();
  server.close();
}

console.log(failures.length ? `FAIL ${failures.length} (passed ${checks.length})` : `PASS ${checks.length}`);
process.exit(failures.length ? 1 : 0);
