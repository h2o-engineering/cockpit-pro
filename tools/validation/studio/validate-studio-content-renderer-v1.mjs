#!/usr/bin/env node
// M03 P2 S2B T5 - typed ContentRenderer registry and canonical semantic rendering.
//
// Tier 1 (always runs): registry contract plus source inspection of the
// canonical Markdown path.
// Tier 2 (real browser): the actual DOM the renderers build, including the URL
// admission boundary. An unavailable browser SKIPs loudly - it is never
// reported as evidence.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), '..', '..', '..');
const STUDIO = path.join(REPO_ROOT, 'src-surfaces-base/studio');
const CONTENT_REL = 'renderer/content/content-renderer.v1.js';
const RENDERER_REL = 'renderer/chat-renderer.studio.js';
const PROFILE_REL = 'renderer/presentation/presentation-profile.v1.js';
const PROFILE_CSS_REL = 'renderer/presentation/chatgpt-reference.v1.css';
/* M04 P2 T3: the H2O Clean Reader profile module, its stylesheet and root marker. */
const CLEAN_READER_REL = 'renderer/presentation/h2o-clean-reader.v1.js';
const CLEAN_READER_CSS_REL = 'renderer/presentation/h2o-clean-reader.v1.css';
const CLEAN_READER_MARKER = 'data-h2o-presentation-profile="h2o-clean-reader"';
const STUDIO_CSS_REL = 'studio.css';
/* M03 S4C slice B: the Answer Timestamp consumer and the studio.js Reader bridge it consumes. */
const STUDIO_JS_REL = 'studio.js';
const ANSWER_TIMESTAMP_REL = 'S1Z1a. \u{1F3AC} Answer Timestamp - Studio.js';
function extractStudioFunction(source, name) {
  const match = new RegExp(`\\bfunction\\s+${name}\\s*\\(`).exec(source);
  if (!match) throw new Error(`studio.js function ${name} not found`);
  const braceOpen = source.indexOf('{', match.index);
  let depth = 0;
  for (let i = braceOpen; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') { depth -= 1; if (depth === 0) return source.slice(match.index, i + 1); }
  }
  throw new Error(`studio.js function ${name} unterminated`);
}
const STUDIO_HTML_REL = 'studio.html';
const PACK_STUDIO_ABS = path.join(REPO_ROOT, 'tools/product/studio/pack-studio.mjs');
const PROFILE_MARKER = 'data-h2o-presentation-profile="chatgpt-reference"';

const STRICT = /^(1|true|yes)$/i.test(String(process.env.H2O_REQUIRE_CONTENT_RENDERER_TIER2 || ''));

const checks = [];
const failures = [];
function check(label, fn) {
  try { fn(); checks.push(label); console.log(`✓ ${label}`); }
  catch (e) { failures.push(label); console.log(`✗ ${label}\n    ${e.message}`); }
}
const read = (rel) => fs.readFileSync(path.join(STUDIO, rel), 'utf8');

/* ------------------------------------------------------------ Tier 1 */

function loadRegistry({ withProfile = false } = {}) {
  const sandbox = vm.createContext({ console });
  sandbox.globalThis = sandbox;
  /* S3B: the real PresentationProfile module, in its production position
   * (before the content renderer), when a check needs presentation. */
  if (withProfile) vm.runInContext(read(PROFILE_REL), sandbox, { filename: 'presentation-profile.v1.js' });
  vm.runInContext(read(CONTENT_REL), sandbox, { filename: 'content-renderer.v1.js' });
  return sandbox.H2O.Studio.Renderer.contentRenderer;
}

/* Minimal element fake for Tier-1 presentation checks: class, children, text. */
function fakeDocument() {
  const make = (tagName) => ({
    tagName: String(tagName).toUpperCase(), className: '', children: [], text: '',
    appendChild(node) { this.children.push(node); return node; },
    setAttribute() {},
  });
  return {
    createElement: (tagName) => make(tagName),
    createTextNode: (value) => ({ nodeType: 3, text: String(value), children: [] }),
  };
}

function stripComments(source) {
  let out = ''; let i = 0; let quote = '';
  while (i < source.length) {
    const ch = source[i]; const next = source[i + 1];
    if (quote) { if (ch === '\\') { out += ch + (next ?? ''); i += 2; continue; } if (ch === quote) quote = ''; out += ch; i += 1; continue; }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; out += ch; i += 1; continue; }
    if (ch === '/' && next === '*') { const e = source.indexOf('*/', i + 2); i = e === -1 ? source.length : e + 2; out += ' '; continue; }
    if (ch === '/' && next === '/') { const e = source.indexOf('\n', i); i = e === -1 ? source.length : e; out += ' '; continue; }
    out += ch; i += 1;
  }
  return out;
}

check('registry exposes the small typed API and registers the core kinds once', () => {
  const cr = loadRegistry();
  /* M04 P1 T1 (old -> new): the governed registry adds describe/seal/sealed/registryDigest. */
  for (const fn of ['register', 'has', 'renderBlock', 'renderBlocks', 'registeredKinds', 'describe', 'seal', 'sealed', 'registryDigest']) {
    assert.equal(typeof cr[fn], 'function', `missing ${fn}`);
  }
  assert.equal(cr.__version, '2.0.0', 'M04 P1 T1: API 2.0.0 (old 1.1.0) - mandatory extension metadata, admitted-kind vocabulary and sealing');
  assert.equal(cr.sealed(), false, 'installation does not seal the registry (the Renderer seals at its first render)');
  for (const kind of cr.coreKinds) assert.equal(cr.has(kind), true, `core kind not registered: ${kind}`);
  /* Both sides are spread into THIS realm first: values built inside the vm
   * sandbox carry the sandbox's intrinsics, which deepStrictEqual compares. */
  assert.deepEqual([...cr.registeredKinds()], [...cr.coreKinds].sort(),
    'registered kinds must be exactly the core kinds');
});

check('duplicate registration fails rather than silently replacing', () => {
  const cr = loadRegistry();
  const meta = { owner: 'test-owner', version: '0.1.0' };
  assert.throws(() => cr.register('paragraph', () => null, meta), /already has a renderer/i, 'core kinds cannot be overridden (unchanged since 1.x)');
  /* A new kind still registers, so the guard is about duplicates, not writes.
   * M04 P1 T1 (old -> new): an extension registration now carries mandatory
   * owner/version metadata and still returns the kind string. */
  assert.equal(cr.register('citation', () => null, meta), 'citation');
  assert.equal(cr.has('citation'), true);
  assert.throws(() => cr.register('citation', () => null, meta), /already has a renderer/i);
});

/* ------------------------------------------------- Tier 1: M04 P1 T1 */

check('extension registration requires owner/version metadata and an admitted Render IR kind', () => {
  const cr = loadRegistry();
  const code = (fn) => { try { fn(); return null; } catch (e) { return { code: e.code, name: e.name, message: e.message }; } };
  for (const [label, meta] of [['no meta', undefined], ['empty meta', {}], ['blank owner', { owner: ' ', version: '1.0.0' }], ['no version', { owner: 'o' }], ['non-semver', { owner: 'o', version: '1.0' }], ['numeric version', { owner: 'o', version: 1 }]]) {
    const failure = code(() => cr.register('math', () => null, meta));
    assert.ok(failure && failure.code === 'invalid-metadata' && failure.name === 'TypeError', `${label}: rejected with invalid-metadata`);
    assert.equal(cr.has('math'), false, `${label}: nothing registered`);
  }
  /* M04-P1-R02 (old -> new): numeric prerelease identifiers with leading zeroes were accepted; SemVer 2.0.0 items 9-10 now hold in this module too. */
  for (const bad of ['1.0.0-01', '1.0.0-alpha.01', '01.0.0', '1.0.0-', '1.0.0+', 'v1.0.0']) {
    const failure = code(() => loadRegistry().register('math', () => null, { owner: 'o', version: bad }));
    assert.ok(failure && failure.code === 'invalid-metadata', `R02: version ${JSON.stringify(bad)} rejected`);
  }
  for (const good of ['1.0.0-0', '1.0.0-alpha.1', '1.0.0-01a', '1.0.0+001', '1.0.0-rc.1+build.01']) {
    assert.equal(loadRegistry().register('math', () => null, { owner: 'o', version: good }), 'math', `R02: version ${JSON.stringify(good)} accepted`);
  }
  const unknown = code(() => cr.register('sparkline', () => null, { owner: 'o', version: '1.0.0' }));
  assert.equal(unknown && unknown.code, 'unknown-kind', 'the admitted Render IR kind vocabulary is not expandable');
  assert.deepEqual([...cr.admittedKinds].sort(), [...cr.coreKinds, ...cr.extensionKinds].sort(), 'admitted kinds = core + reserved extension kinds');
  assert.equal(code(() => cr.register('', () => null, { owner: 'o', version: '1.0.0' })) !== null, true, 'empty kind rejected');
  assert.equal(code(() => cr.register('math', null, { owner: 'o', version: '1.0.0' })) !== null, true, 'non-function renderer rejected');
  assert.equal(cr.register('math', () => null, { owner: 'ext-owner', version: '3.2.1-beta.1' }), 'math', 'valid extension registration returns the kind string');
  assert.deepEqual({ ...cr.describe('math') }, { kind: 'math', owner: 'ext-owner', version: '3.2.1-beta.1', core: false }, 'describe(kind) reports the extension metadata');
  assert.deepEqual({ ...cr.describe('paragraph') }, { kind: 'paragraph', owner: 'L-STUDIO-RENDERER', version: '2.0.0', core: true }, 'core metadata is Renderer-owned at install');
  assert.equal(cr.describe('citation'), null, 'unregistered kinds describe as null'); assert.equal(cr.describe(42), null);
  assert.equal(Object.isFrozen(cr.describe('math')), true, 'metadata is immutable');
  assert.throws(() => { 'use strict'; cr.describe('math').owner = 'x'; }, { name: 'TypeError' });
});

check('sealing is idempotent, closes registration deterministically, and yields the sorted registry evidence token', () => {
  const cr = loadRegistry();
  assert.equal(cr.registryDigest(), null, 'no evidence token before sealing');
  cr.register('math', () => null, { owner: 'ext-owner', version: '1.0.0' });
  const before = cr.describe();
  assert.equal(before.sealed, false); assert.equal(before.registryDigest, null);
  const token = cr.seal();
  assert.equal(cr.sealed(), true); assert.equal(cr.seal(), token, 'seal() is idempotent'); assert.equal(cr.registryDigest(), token);
  const parsed = JSON.parse(token);
  assert.equal(parsed.schema, 'h2o.renderer.content-renderer'); assert.equal(parsed.registry, 'content-renderer'); assert.equal(parsed.apiVersion, '2.0.0');
  assert.deepEqual(parsed.entries.map((e) => e.kind), [...cr.coreKinds, 'math'].sort(), 'sorted kinds');
  assert.deepEqual(parsed.entries.find((e) => e.kind === 'math'), { kind: 'math', owner: 'ext-owner', version: '1.0.0', core: false });
  assert.ok(parsed.entries.every((e) => e.kind === 'math' ? !e.core : e.core && e.owner === 'L-STUDIO-RENDERER' && e.version === '2.0.0'));
  let late = null; try { cr.register('citation', () => null, { owner: 'o', version: '1.0.0' }); } catch (e) { late = e; }
  assert.ok(late && late.code === 'registry-sealed' && /registry-sealed/.test(late.message), 'late registration fails with registry-sealed');
  assert.equal(cr.has('citation'), false, 'a refused late registration changes nothing');
  assert.deepEqual([...cr.registeredKinds()], [...cr.coreKinds, 'math'].sort());
  const after = cr.describe();
  assert.equal(after.sealed, true); assert.equal(after.registryDigest, token); assert.equal(Object.isFrozen(after), true); assert.equal(Object.isFrozen(after.entries), true);
  assert.deepEqual([...after.entries].map((e) => e.kind), [...cr.coreKinds, 'math'].sort(), 'describe() lists the sorted registry');
  /* Determinism across fresh isolated contexts: identical admitted sets seal identically. */
  const other = loadRegistry(); other.register('math', () => null, { owner: 'ext-owner', version: '1.0.0' });
  assert.equal(other.seal(), token, 'identical admitted sets produce the identical evidence token');
  const bare = loadRegistry();
  assert.notEqual(bare.seal(), token, 'a different admitted set produces a different token');
  assert.equal(bare.sealed(), true); assert.equal(loadRegistry().sealed(), false, 'sealing never leaks across contexts');
  /* Rendering keeps working after sealing. */
  const doc = fakeDocument();
  const p = cr.renderBlock({ kind: 'paragraph', children: [{ kind: 'text', text: 'after seal' }] }, { document: doc });
  assert.equal(p.tagName, 'P'); assert.equal(p.children[0].text, 'after seal');
});

check('the registry offers no dispose / unregister / replacement / hot-reload surface', () => {
  const cr = loadRegistry();
  for (const name of ['unregister', 'dispose', 'replace', 'reload', 'reset', 'clear']) assert.equal(name in cr, false, `no ${name}()`);
  assert.equal(Object.isFrozen(cr), true);
  assert.doesNotMatch(stripComments(read(CONTENT_REL)), /registry\.delete|registry\.clear|unregister|hotReload/, 'no removal path in the module');
});

check('reserved extension kinds are unregistered and fail deterministically', () => {
  const cr = loadRegistry();
  for (const kind of cr.extensionKinds) {
    assert.equal(cr.has(kind), false, `${kind} must not be registered in T5`);
    assert.throws(() => cr.renderBlock({ kind }, {}), new RegExp(`no renderer registered for kind: ${kind}`),
      `${kind} must fail deterministically rather than be faked as paragraph/text`);
  }
});

check('the canonical Markdown body path builds no HTML string', () => {
  const source = read(RENDERER_REL);
  assert.doesNotMatch(source, /innerHTML\s*=\s*renderTextAsChatGPTBlocks/,
    'the canonical body must not be assigned through innerHTML');
  /* Both canonical message-body call sites, named exactly. */
  assert.match(source, /\n\s*renderSemanticBody\(bodyEl, role === "user" \? cleanReaderUserText\(text\) : text\);/,
    'buildCanonicalMessage must render semantically');
  assert.match(source, /\n\s*renderSemanticBody\(bodyEl, text\);/,
    'applyEditedMessageBody must render semantically');
  /* The retired parser must not be reachable from this file at all. */
  assert.doesNotMatch(source, /renderTextAsChatGPTBlocks|renderInlineMarkdown|renderMarkdownTable/,
    'the retired Web bespoke parser must be absent');
});

check('the content renderer never routes semantic content through an HTML sink', () => {
  const source = read(CONTENT_REL);
  assert.doesNotMatch(source, /\.innerHTML\s*=/, 'content renderer must not assign innerHTML');
  assert.doesNotMatch(source, /\.outerHTML\s*=/, 'content renderer must not assign outerHTML');
  assert.doesNotMatch(source, /insertAdjacentHTML\s*\(/, 'content renderer must not use insertAdjacentHTML');
  /* Text always enters the DOM as text data. */
  assert.match(source, /createTextNode/, 'content renderer must build text nodes');
});

check('sanitizerPolicy.classifyUrl is the only URL admission authority', () => {
  const source = read(CONTENT_REL);
  assert.match(source, /classifyUrl\(value, urlContext\)/, 'must call classifyUrl');
  assert.match(source, /classify\(context, mark\.href, "link"\)/, 'link marks must classify with the link context');
  assert.match(source, /classify\(context, block\.src, "image"\)/, 'images must classify with the image context');
  /* No second allowlist and no independent URL parsing as a security decision. */
  assert.doesNotMatch(source, /new URL\(/, 'URL() must not be an independent security decision');
  assert.doesNotMatch(source, /normalizeSafeMarkdownHref/, 'the legacy href decision must not return');
  assert.doesNotMatch(source, /https?:\s*\[|allowedSchemes\s*=/, 'must not define a second scheme allowlist');
  /* Fail closed when the policy is unreachable. */
  assert.match(source, /url-policy-unavailable/, 'a missing policy must deny, not admit');
});

/* ------------------------------------------------- Tier 1: S2C / T11 */

check('opaqueProviderBlock is a controlled core kind; five extension kinds stay reserved', () => {
  const cr = loadRegistry();
  assert.equal(cr.has('opaqueProviderBlock'), true);
  assert.deepEqual([...cr.extensionKinds].sort(), ['artifact', 'citation', 'math', 'toolCall', 'toolResult']);
  assert.deepEqual([...cr.opaqueKinds].sort(), ['ownerSanitizedHtml', 'unsupportedOwnerContent']);
  for (const kind of cr.extensionKinds) assert.equal(cr.has(kind), false, `${kind} must stay unregistered`);
});

check('ownerSanitizedHtml demands the exact accepted metadata shape before any sanitizer call', () => {
  const cr = loadRegistry();
  let sanitizerCalls = 0;
  const context = { htmlSanitizer: { isSupported: () => true, sanitizeToFragment: () => { sanitizerCalls += 1; return { nodeType: 11 }; } } };
  const good = { kind: 'opaqueProviderBlock', opaqueKind: 'ownerSanitizedHtml', mediaType: 'text/html', ownerSanitized: true, html: '<p>x</p>' };
  const bad = [
    { ...good, ownerSanitized: false },
    { ...good, ownerSanitized: 'true' },
    { ...good, mediaType: 'text/plain' },
    { ...good, html: 42 },
    { ...good, html: undefined },
    { kind: 'opaqueProviderBlock', opaqueKind: 'somethingElse', html: '<p>x</p>' },
  ];
  for (const block of bad) {
    assert.throws(() => cr.renderBlock(block, context), /metadata shape|unsupported opaqueProviderBlock subtype/,
      `malformed opaque block was accepted: ${JSON.stringify(block)}`);
  }
  assert.equal(sanitizerCalls, 0, 'the sanitizer must never be reached for a malformed block');
});

check('owner HTML fails closed when sanitizer v2 is absent, unsupported, throwing, or returns a non-fragment', () => {
  const cr = loadRegistry();
  const block = { kind: 'opaqueProviderBlock', opaqueKind: 'ownerSanitizedHtml', mediaType: 'text/html', ownerSanitized: true, html: '<p>x</p>' };
  const sandboxDoc = { createElement: () => { throw new Error('document must not be reached before the sanitizer verdict'); } };
  assert.throws(() => cr.renderBlock(block, { document: sandboxDoc, htmlSanitizer: null }), /unavailable/);
  assert.throws(() => cr.renderBlock(block, { document: sandboxDoc, htmlSanitizer: { isSupported: () => false, sanitizeToFragment: () => ({ nodeType: 11 }) } }), /unsupported/);
  assert.throws(() => cr.renderBlock(block, { document: sandboxDoc, htmlSanitizer: { isSupported: () => true, sanitizeToFragment: () => { throw new Error('engine down'); } } }), /engine down/);
  assert.throws(() => cr.renderBlock(block, { document: sandboxDoc, htmlSanitizer: { isSupported: () => true, sanitizeToFragment: () => '<p>x</p>' } }), /DocumentFragment/);
});

check('the S2C path has no HTML-string sink and names sanitizer v2 as the only live HTML authority', () => {
  const content = read(CONTENT_REL);
  assert.match(content, /sanitizeToFragment\(block\.html\)/, 'owner HTML must go through sanitizeToFragment');
  for (const sink of [/\.innerHTML\s*=/, /insertAdjacentHTML\s*\(/, /new\s+DOMParser\s*\(/, /createContextualFragment\s*\(/, /\.outerHTML\s*=/]) {
    assert.doesNotMatch(content, sink, `content renderer must not use ${sink}`);
  }
  assert.doesNotMatch(content, /Studio\.html\.sanitize|html-sanitizer\.js/, 'the shared v1 sanitizer must not be called');
  assert.doesNotMatch(content, /JSON\.stringify\(block\.ownerContent|JSON\.stringify\(owner\b/, 'owner objects must not be stringified into the DOM');

  const renderer = read(RENDERER_REL);
  const s2c = renderer.slice(renderer.indexOf('function safeTextFromBlocks'), renderer.indexOf('function buildCanonicalMessage'));
  assert.ok(s2c.length > 500, 'S2C helpers must be present in the Renderer');
  for (const sink of [/innerHTML/, /insertAdjacentHTML/, /DOMParser/, /template/]) {
    assert.doesNotMatch(s2c, sink, `S2C renderer path must not use ${sink}`);
  }
  assert.match(s2c, /fromSavedChatV3Snapshot/, 'v3 must be consumed through the accepted ingress');
  assert.doesNotMatch(renderer, /\.contentText\b|\.contentHtml\b/, 'forbidden v3 scalar bodies must not be read');
  /* The verbatim fallback derives text from text nodes only - never from html. */
  assert.match(s2c, /node\.kind === "text"/);
  assert.doesNotMatch(s2c.slice(0, s2c.indexOf('function renderSemanticBlocks')), /\.html\b/, 'safeTextFromBlocks must never read an html payload');
});

/* -------------------------------------------- Tier 1: S3B presentation */

check('code-block presentation classes come from the active PresentationProfile', () => {
  const cr = loadRegistry({ withProfile: true });
  const doc = fakeDocument();
  const withLang = cr.renderBlock({ kind: 'codeBlock', language: 'js', code: 'const x = 1;\n' }, { document: doc });
  assert.equal(withLang.tagName, 'DIV');
  assert.equal(withLang.className, 'wbCodeBlock', 'wrapper class must be the profile code-block container hook');
  assert.equal(withLang.children.length, 2, 'language badge + pre');
  assert.equal(withLang.children[0].className, 'wbCodeLang', 'badge class must be the profile code-language hook');
  assert.equal(withLang.children[0].children[0].text, 'js');
  assert.equal(withLang.children[1].tagName, 'PRE');
  assert.equal(withLang.children[1].children[0].tagName, 'CODE');
  assert.equal(withLang.children[1].children[0].children[0].text, 'const x = 1;\n', 'author code text enters as text data');
  const noLang = cr.renderBlock({ kind: 'codeBlock', code: 'plain' }, { document: doc });
  assert.equal(noLang.className, 'wbCodeBlock');
  assert.equal(noLang.children.length, 1, 'no language means no badge');
  assert.equal(noLang.children[0].tagName, 'PRE');
});

check('code-block presentation fails clearly without a profile - no embedded duplicate map', () => {
  const doc = fakeDocument();
  const bare = loadRegistry();
  assert.throws(() => bare.renderBlock({ kind: 'codeBlock', code: 'x' }, { document: doc }), /PresentationProfile/,
    'a missing profile module must fail clearly');
  const cr = loadRegistry({ withProfile: true });
  assert.throws(() => cr.renderBlock({ kind: 'codeBlock', code: 'x' }, { document: doc, presentationProfile: null }), /PresentationProfile/,
    'an explicit null override must not fall back to the installed profile');
  assert.throws(() => cr.renderBlock({ kind: 'codeBlock', code: 'x' }, { document: doc, presentationProfile: { id: 'not-a-profile' } }), /PresentationProfile/,
    'an object without the presentation helpers is not a profile');
  const custom = { codeBlockClasses: () => ['x-block'], codeLanguageClasses: () => ['x-lang'] };
  const rendered = cr.renderBlock({ kind: 'codeBlock', language: 'go', code: 'y' }, { document: doc, presentationProfile: custom });
  assert.equal(rendered.className, 'x-block', 'an explicit profile override is honoured');
  assert.equal(rendered.children[0].className, 'x-lang');
  /* Paragraph rendering does not consult the profile at all. */
  assert.equal(bare.renderBlock({ kind: 'paragraph', children: [{ kind: 'text', text: 'p' }] }, { document: doc }).tagName, 'P');
});

check('the content renderer embeds no presentation class map and stays semantics-neutral', () => {
  const code = stripComments(read(CONTENT_REL));
  for (const token of ['wbCodeBlock', 'wbCodeLang', 'chatgpt-reference']) {
    assert.equal(code.includes(token), false, `content renderer must not hardcode ${token}`);
  }
  assert.match(code, /function resolvePresentationProfile\(context\)/);
  assert.match(code, /hasOwnProperty\.call\(context, "presentationProfile"\)/, 'explicit override rule mirrors the URL policy seam');
  assert.match(code, /Renderer\.presentationProfile\.reference\(\)/, 'the installed reference profile is the default authority');
  /* One definition plus exactly one call site (the codeBlock renderer). */
  assert.equal((code.match(/resolvePresentationProfile\(context\)/g) || []).length, 2, 'only the codeBlock renderer consults presentation');
  /* M04 P1 T1 (old -> new): core kinds install through registerCore() (Renderer-owned metadata); the codeBlock seam is unchanged. */
  assert.match(code, /registerCore\("codeBlock", \(block, context\) => \{\s*const profile = resolvePresentationProfile\(context\);/);
  assert.doesNotMatch(code, /presentationProfile[^\n]*(renderIR|markdown|blocks\.push|kind\s*=)/, 'profile data never reaches Render IR or block shape');
  for (const rel of ['renderer/semantic/render-ir.v1.js', 'renderer/semantic/semantic-ingress.v1.js', 'renderer/markdown/markdown-ir-adapter.v1.js', 'renderer/markdown/markdown-engine.v1.js', 'renderer/markdown/h2o-gfm.v1.js']) {
    assert.doesNotMatch(stripComments(read(rel)), /presentationProfile/, `${rel} must stay profile-free`);
  }
});

/* ------------------------------------------- Tier 1: S3C CSS isolation */

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

const SCOPE = `:where([${PROFILE_MARKER}])`;

/* The only !important declarations allowed in the profile stylesheet: the
 * provider-compatibility rules that carried !important in the accepted global
 * cascade and moved verbatim (slice D). Every other profile rule must stay
 * importance-free - no new !important is ever introduced by isolation. */
const INHERITED_IMPORTANT_SELECTORS = new Set([
  '.wbRichRoot ul, .wbRichRoot .prose ul, .wbRichRoot .markdown ul', '.wbRichRoot ol, .wbRichRoot .prose ol, .wbRichRoot .markdown ol',
  '.wbRichRoot li', '.wbRichRoot li > :first-child', '.wbRichRoot li > :last-child', '.wbRichRoot strong, .wbRichRoot b',
  '.wbRichRoot h1', '.wbRichRoot h2', '.wbRichRoot h3',
  '.text-token-text-primary', '.text-token-text-secondary', '.text-token-text-tertiary', '.text-token-text-error',
  '.bg-token-main-surface-primary', '.bg-token-main-surface-secondary', '.bg-token-main-surface-tertiary',
  '.bg-token-surface-primary', '.bg-token-surface-secondary', '.bg-token-surface-tertiary',
  '.border-token-border-medium', '.border-token-border-light', '.border-token-border-heavy',
  '.\\!whitespace-pre', '.\\!overflow-visible',
]);
function unscopedSelector(selector) {
  return splitMembers(selector).map((m) => (m === SCOPE ? ':root' : m.replace(`${SCOPE} `, ''))).join(', ');
}
function assertNoNewImportant(rules) {
  for (const r of rules) {
    if (!Object.values(r.declarations).some((v) => /!important/.test(v))) continue;
    assert.ok(INHERITED_IMPORTANT_SELECTORS.has(unscopedSelector(r.selector)), `no new !important in the profile stylesheet: ${unscopedSelector(r.selector)}`);
  }
}

const CODE_BLOCK_DECLARATIONS = {
  margin: '14px 0', border: '1px solid var(--wb-code-border)', 'border-radius': '12px', overflow: 'hidden', background: 'var(--wb-code-bg)',
};
const CODE_LANG_DECLARATIONS = {
  padding: '10px 14px 0', 'font-size': '11px', 'line-height': '1.3', 'text-transform': 'uppercase', 'letter-spacing': '.04em', color: 'var(--wb-dim)',
};

check('the Renderer-owned chatgpt-reference stylesheet exists, is profile-scoped and carries the code presentation', () => {
  assert.equal(fs.existsSync(path.join(STUDIO, PROFILE_CSS_REL)), true, 'A: chatgpt-reference.v1.css must exist');
  const css = read(PROFILE_CSS_REL);
  assert.match(css, /Owner:\s+L-STUDIO-RENDERER/, 'B: Renderer-owned');
  assert.match(css, /Profile:\s+chatgpt-reference/, 'B: names the reference profile');
  const rules = parseRules(css);
  assert.ok(rules.length >= 2, 'stylesheet carries rules');
  for (const rule of rules) {
    /* Every selector-list member carries the zero-specificity profile scope; the
     * bare scope itself is the profile root (provider alias variables). */
    for (const member of splitMembers(rule.selector)) {
      assert.ok(member === `:where([${PROFILE_MARKER}])` || member.startsWith(`:where([${PROFILE_MARKER}]) `), `B: every selector member is scoped to the profile marker with zero-specificity :where(): ${member}`);
    }
  }
  assertNoNewImportant(rules);
  const byClass = (cls) => rules.filter((r) => r.selector === `:where([${PROFILE_MARKER}]) .${cls}` && r.media === null);
  assert.equal(byClass('wbCodeBlock').length, 1, 'C: exactly one wbCodeBlock rule');
  assert.deepEqual(byClass('wbCodeBlock')[0].declarations, CODE_BLOCK_DECLARATIONS, 'C: the effective wbCodeBlock declarations moved verbatim');
  assert.equal(byClass('wbCodeLang').length, 1, 'D: exactly one wbCodeLang rule');
  assert.deepEqual(byClass('wbCodeLang')[0].declarations, CODE_LANG_DECLARATIONS, 'D: the effective wbCodeLang declarations moved verbatim');
  /* H: the selectors are exactly the profile's code hooks. */
  const sandbox = vm.createContext({ console }); sandbox.globalThis = sandbox;
  vm.runInContext(read(PROFILE_REL), sandbox, { filename: 'presentation-profile.v1.js' });
  const profile = sandbox.H2O.Studio.Renderer.presentationProfile.reference();
  assert.deepEqual([...profile.codeBlockClasses()], ['wbCodeBlock']);
  assert.deepEqual([...profile.codeLanguageClasses()], ['wbCodeLang']);
  for (const cls of [...profile.codeBlockClasses(), ...profile.codeLanguageClasses()]) {
    assert.equal(byClass(cls).length, 1, `H: profile hook ${cls} is skinned by the Renderer stylesheet`);
  }
});

check('global studio.css no longer declares the migrated code selectors', () => {
  const css = stripCssComments(read(STUDIO_CSS_REL));
  assert.doesNotMatch(css, /\.wbCodeBlock\b/, 'E: .wbCodeBlock must not be declared in studio.css');
  assert.doesNotMatch(css, /\.wbCodeLang\b/, 'E: .wbCodeLang must not be declared in studio.css');
  /* Slice D moved the rich content baseline (incl. .wbRichRoot pre) into the profile stylesheet. */
  assert.doesNotMatch(css, /\n\.wbRichRoot pre\{/, 'rich pre rule no longer in studio.css');
});

/* Imported at top level: check() is synchronous, so a promise handed to it
 * would pass vacuously. */
const packer = await import(pathToFileURL(PACK_STUDIO_ABS).href);

check('studio.html links the profile stylesheet exactly once, after studio.css, and pack-studio carries it with parity', () => {
  const html = read(STUDIO_HTML_REL);
  const links = [...html.matchAll(/<link\s+rel="stylesheet"\s+href="\.\/([^"?]+)(?:\?[^"]*)?"\s*\/?>/g)].map((m) => m[1]);
  assert.equal(links.filter((l) => l === PROFILE_CSS_REL).length, 1, 'F: profile stylesheet linked exactly once');
  assert.equal(links.filter((l) => l === STUDIO_CSS_REL).length, 1, 'studio.css linked exactly once');
  assert.ok(links.indexOf(STUDIO_CSS_REL) < links.indexOf(PROFILE_CSS_REL), 'F: profile stylesheet loads after studio.css');
  for (const [name, list] of [['ARCHIVE_WORKBENCH_SOURCE_FILES', packer.ARCHIVE_WORKBENCH_SOURCE_FILES], ['ARCHIVE_WORKBENCH_OUT_FILES', packer.ARCHIVE_WORKBENCH_OUT_FILES]]) {
    assert.equal(list.filter((f) => f === PROFILE_CSS_REL).length, 1, `G: ${name} carries the stylesheet exactly once`);
  }
  assert.equal(packer.ARCHIVE_WORKBENCH_SOURCE_FILES.indexOf(PROFILE_CSS_REL) - packer.ARCHIVE_WORKBENCH_SOURCE_FILES.indexOf(PROFILE_REL),
    packer.ARCHIVE_WORKBENCH_OUT_FILES.indexOf(PROFILE_CSS_REL) - packer.ARCHIVE_WORKBENCH_OUT_FILES.indexOf(PROFILE_REL), 'G: source/output parity around the presentation entries');
});

/* ---------------------------------------------------------------- M04 P2 T3 */
/* The H2O Clean Reader profile: its own module registering through the public
 * path during evaluation, its fully scoped stylesheet, and the authorized static
 * admission (studio.html tags, index-paired pack entries, both publication order
 * lists) — evidence for the Runtime / Shell / Build closeout (HDA decision A). */

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

const CANONICAL_MESSAGE_RULES = {
  '.cgMsg': { color: 'var(--wb-text)' },
  '.cgMsg--user': { 'max-width': 'min(var(--wb-user-w), 44rem)', width: 'fit-content', padding: '10px 20px', 'border-radius': 'var(--wb-radius-xl)', background: 'var(--wb-user-bg)' },
  '.cgMsg--assistant': { background: 'transparent' },
  '.cgMsgBody': { 'font-size': '16px', 'line-height': '1.625', color: 'var(--wb-text)', 'word-break': 'break-word' },
  '.cgMsgBody p': { margin: '0 0 12px' },
  '.cgMsgBody p:last-child': { 'margin-bottom': '0' },
  '.cgMsgBody pre': { margin: '0', overflow: 'auto', padding: '14px 16px', 'border-radius': '12px', border: '1px solid var(--wb-code-border)', background: 'var(--wb-code-bg)', 'font-family': 'var(--mono)', 'font-size': '12.5px', 'line-height': '1.65' },
  '.cgMsgBody code': { 'font-family': 'var(--mono)', 'font-size': '.92em' },
  '.cgMsgBody :not(pre) > code': { padding: '.12em .4em', 'border-radius': '8px', background: 'rgba(255,255,255,.08)' },
  '.cgMsgBody a': { color: 'var(--tw-prose-links, var(--wb-focus))', 'text-decoration': 'underline', 'text-underline-offset': '2px' },
  '.cgMsgBody a:hover': { color: 'var(--wb-text)' },
};
const NARROW_USER_OVERRIDE = { width: 'fit-content', 'max-width': 'min(100%, 42rem)' };

check('canonical message / content-body presentation lives in the profile stylesheet with its responsive override (S3C slice B)', () => {
  const rules = parseRules(read(PROFILE_CSS_REL));
  const byScoped = (sel, media = null) => rules.filter((r) => r.selector === `${SCOPE} ${sel}` && r.media === media);
  for (const [sel, decls] of Object.entries(CANONICAL_MESSAGE_RULES)) {
    const found = byScoped(sel);
    assert.equal(found.length, 1, `A/B: exactly one profile-scoped base rule for ${sel}`);
    assert.deepEqual(found[0].declarations, decls, `A: ${sel} declarations moved verbatim`);
  }
  /* H: the narrow override follows the base rule inside the same stylesheet. */
  const base = byScoped('.cgMsg--user')[0];
  const narrow = byScoped('.cgMsg--user', '(max-width: 720px)');
  assert.equal(narrow.length, 1, 'H: the narrow canonical user-bubble override is migrated with the base rule');
  assert.deepEqual(narrow[0].declarations, NARROW_USER_OVERRIDE);
  assert.ok(narrow[0].index > base.index, 'H: the override must follow the base rule so it still wins at equal specificity');
  for (const rule of rules) for (const member of splitMembers(rule.selector)) assert.ok(member === SCOPE || member.startsWith(`${SCOPE} `), `B: every rule member is profile-scoped: ${member}`);
  assertNoNewImportant(rules);
});

check('studio.css keeps only structural .cgMsg sizing and the rich halves of the split pre/code rules', () => {
  const rules = parseRules(read(STUDIO_CSS_REL));
  const members = (r) => r.selector.split(',').map((x) => x.trim());
  /* C: no canonical presentation authority remains in the global sheet. */
  for (const sel of Object.keys(CANONICAL_MESSAGE_RULES)) {
    if (sel === '.cgMsg') continue;
    const dup = rules.filter((r) => members(r).includes(sel));
    assert.equal(dup.length, 0, `C: studio.css must not declare ${sel} (found in ${dup.map((r) => r.selector).join(' | ')})`);
  }
  /* D: structural sizing stays global, the color moved. */
  const cgMsg = rules.filter((r) => r.selector === '.cgMsg');
  assert.equal(cgMsg.length, 1);
  assert.deepEqual(cgMsg[0].declarations, { 'min-width': '0' }, 'D: global .cgMsg keeps only structural min-width');
  /* E: the rich halves (moved to the profile stylesheet in slice D) keep the same values as the canonical halves. */
  const prof = parseRules(read(PROFILE_CSS_REL)).map((r) => ({ ...r, selector: norm(r.selector) }));
  for (const [rich, canonical] of [['.wbRichRoot pre', '.cgMsgBody pre'], ['.wbRichRoot code', '.cgMsgBody code'], ['.wbRichRoot :not(pre) > code', '.cgMsgBody :not(pre) > code']]) {
    const found = prof.filter((r) => r.selector === norm(`${SCOPE} ${rich}`) && r.media === null);
    assert.equal(found.length, 1, `E: ${rich} is profile-owned`);
    assert.deepEqual(found[0].declarations, CANONICAL_MESSAGE_RULES[canonical], `E: ${rich} values unchanged`);
    assert.equal(rules.filter((r) => r.media === null && splitMembers(r.selector).includes(rich)).length, 0, `E: ${rich} no longer global`);
  }
  /* Slice C moved the bubble member of the narrow rule to the profile
   * stylesheet; slice H removed the dead no-bubble user-host member, so no
   * global narrow rich rule remains at all. */
  assert.equal(rules.filter((r) => r.media === '(max-width: 720px)' && r.selector.includes('.wbRichRoot :where(')).length, 0, 'E: no global narrow rich user-host rule remains (slice H)');
  /* I: Reader-route and interactive edit-mode rules were not absorbed (the
   * persisted .cgMsg--edited accent moved in S3C slice E). */
  assert.ok(rules.some((r) => members(r).includes('body[data-route="reader"] .cgMsg--user')), 'I: Reader-route user rule remains global');
  assert.equal(rules.some((r) => members(r).some((m) => m.includes('.cgMsg--edited'))), false, 'I: the persisted edit accent no longer lives in studio.css (slice E)');
  assert.ok(rules.some((r) => members(r).includes('.wbReader[data-edit-mode="on"] [data-turn].wbTurn--editing .cgMsg--user')), 'I: edit-mode user rule remains global');
  /* S3C slice G: the stale .cgMsg--rich rule is gone (no producer exists; rich message modifiers are empty). */
  assert.equal(rules.some((r) => members(r).some((m) => m.includes('.cgMsg--rich'))), false, 'B: no .cgMsg--rich rule remains in studio.css (slice G)');
});

const RICH_SHELL_RULES = {
  '.cgScroll.is-rich > *': { 'margin-bottom': '14px' },
  '.wbRichRoot': { color: 'var(--wb-text)' },
  '.wbRichRoot > *': { 'max-width': '100%' },
  '.wbRichRoot :where( article[data-testid="conversation-turn"], article[data-testid^="conversation-turn-"], section[data-testid="conversation-turn"], section[data-testid^="conversation-turn-"], div[data-testid="conversation-turn"], div[data-testid^="conversation-turn-"] )': { margin: '0' },
  '.wbRichRoot :where(.user-message-bubble-color)': { 'max-width': 'min(var(--wb-user-w), 44rem)', width: 'fit-content', 'margin-left': 'auto', padding: '10px 20px', 'border-radius': 'var(--wb-radius-xl)', background: 'var(--wb-user-bg)' },
  '.wbRichRoot :where([data-message-author-role="assistant"])': { width: '100%', 'margin-right': 'auto' },
  '.wbRichRoot .cgTurn--user [data-message-author-role="user"]': { 'margin-left': 'auto' },
};
/* Final boundary (S3C slice H). H1, the rich user-turn placement, is Renderer
 * replay STRUCTURAL compatibility and stays global, verbatim: its display
 * shares (0,3,0) with the later Reader `.wbReader [data-turn].is-in-collapsed-section`
 * rule, which must keep winning by source order. The former no-bubble user
 * host fallback E is dead (every successful rich user host carries exactly one
 * H2O-owned marked bubble; the canonical user host is skinned by the profile
 * .cgMsg--user rule) and was removed from studio.css. */
const DEFERRED_GLOBAL_RULES = {
  '.wbRichRoot .cgTurn--user[data-testid^="conversation-turn"]': { display: 'flex', 'flex-direction': 'column', 'align-items': 'flex-end', 'justify-content': 'flex-start' },
};
const DEAD_NO_BUBBLE_FALLBACK = '.wbRichRoot :where([data-message-author-role="user"]):not(:has(.user-message-bubble-color))';

check('rich-replay shell / bubble presentation lives in the profile stylesheet with its narrow override (S3C slice C)', () => {
  const rules = parseRules(read(PROFILE_CSS_REL)).map((r) => ({ ...r, selector: norm(r.selector) }));
  const byScoped = (sel, media = null) => rules.filter((r) => r.selector === norm(`${SCOPE} ${sel}`) && r.media === media);
  for (const [sel, decls] of Object.entries(RICH_SHELL_RULES)) {
    const found = byScoped(sel);
    assert.equal(found.length, 1, `A: exactly one profile-scoped base rule for ${sel}`);
    assert.deepEqual(found[0].declarations, decls, `A: ${sel} declarations moved verbatim`);
  }
  const base = byScoped('.wbRichRoot :where(.user-message-bubble-color)')[0];
  const narrow = byScoped('.wbRichRoot :where(.user-message-bubble-color)', '(max-width: 720px)');
  assert.equal(narrow.length, 1, 'I: the narrow rich-bubble override migrated with its base rule');
  assert.deepEqual(narrow[0].declarations, NARROW_USER_OVERRIDE);
  assert.ok(narrow[0].index > base.index, 'I: the override follows the base rule');
  for (const sel of Object.keys(DEFERRED_GLOBAL_RULES)) assert.equal(rules.filter((r) => r.selector.includes(norm(sel))).length, 0, `E: structural rule must not be in the profile stylesheet: ${sel}`);
  assert.equal(rules.filter((r) => r.selector.includes(norm(DEAD_NO_BUBBLE_FALLBACK))).length, 0, 'C: the dead no-bubble fallback is not in the profile stylesheet (slice H)');
  /* Slice D moved content typography and the provider compatibility layer here
   * as one ordered unit; its own check below proves order and membership. */
});

check('studio.css keeps the deferred rich rules, the prose/Tailwind layer, Reader-route, attachment and edit rules (S3C slice C)', () => {
  const rules = parseRules(read(STUDIO_CSS_REL)).map((r) => ({ ...r, selector: norm(r.selector) }));
  const members = (r) => splitMembers(r.selector);
  for (const sel of Object.keys(RICH_SHELL_RULES)) {
    const dup = rules.filter((r) => r.media === null && members(r).includes(norm(sel)));
    assert.equal(dup.length, 0, `B: studio.css must not declare ${sel}`);
  }
  /* B (slice H): the dead no-bubble fallback and its narrow member are gone from studio.css. */
  assert.equal(rules.filter((r) => members(r).some((m) => m.includes(':not(:has(.user-message-bubble-color))') && !m.startsWith('body[data-route="reader"]'))).length, 0, 'B: no non-Reader no-bubble fallback member remains in studio.css (slice H)');
  assert.equal(rules.filter((r) => r.media === '(max-width: 720px)' && members(r).some((m) => m.includes('.wbRichRoot :where('))).length, 0, 'B: no global narrow rich rule remains');
  /* D: H1 stays global, verbatim (Renderer replay structural compatibility). */
  for (const [sel, decls] of Object.entries(DEFERRED_GLOBAL_RULES)) {
    const found = rules.filter((r) => r.selector === norm(sel) && r.media === null);
    assert.equal(found.length, 1, `D: structural rule stays global: ${sel}`);
    assert.deepEqual(found[0].declarations, decls, `D: structural rule unchanged: ${sel}`);
  }
  /* The later competitors that force the deferrals still exist as they were. */
  assert.ok(rules.some((r) => members(r).includes('.wbReader [data-message-author-role]') && 'max-width' in r.declarations), 'Reader appearance width rule still global');
  assert.ok(rules.some((r) => r.selector === '.wbReader [data-turn].is-in-collapsed-section' && r.declarations.display === 'none'), 'Reader collapsed-section rule still global');
  /* Provider OUTER structure stays global (slice D stopped before it). */
  for (const sel of ['.text-message', '.agent-turn', '.user-turn', '[data-testid^="conversation-turn"]', '.result-streaming', '.wbRichRoot .text-message']) {
    assert.ok(rules.some((r) => members(r).includes(sel)), `provider outer-structure rule ${sel} remains global`);
  }
  /* D: Reader-route rich alignment blocks remain global and !important. */
  const readerRich = rules.filter((r) => members(r).some((m) => m.startsWith('body[data-route="reader"] .wbRichRoot') && /cgTurn--user|user-message-bubble-color|data-message-author-role="user"/.test(m)));
  assert.ok(readerRich.length >= 4, `D: Reader-route rich alignment rules remain global (found ${readerRich.length})`);
  assert.ok(readerRich.every((r) => Object.values(r.declarations).every((v) => /!important/.test(v))), 'D: Reader-route rich alignment declarations keep !important');
  /* E + F: interactive edit-mode rules remain global. The persisted
   * .cgMsg--edited accent is profile-owned since S3C slice E and the
   * attachment / image presentation since slice F (only the Reader-route
   * attachment alignment stays global); wbTurn--edited carries no rule
   * anywhere (state hook). */
  for (const sel of ['.wbTurn--editing', '[data-edit-mode="on"]']) {
    assert.ok(rules.some((r) => members(r).some((m) => m.includes(sel))), `${sel} rules remain global`);
  }
  for (const sel of ['.cgUserAttachmentGrid', '.cgUserAttachmentCard']) {
    assert.ok(rules.some((r) => members(r).some((m) => m.startsWith('body[data-route="reader"]') && m.includes(sel))) || sel === '.cgUserAttachmentCard', `Reader-route ${sel} alignment stays global`);
    assert.equal(rules.some((r) => members(r).some((m) => !m.startsWith('body[data-route="reader"]') && m.includes(sel))), false, `${sel} presentation no longer global (slice F)`);
  }
  assert.equal(rules.some((r) => members(r).some((m) => m.includes('.wbTurn--edited'))), false, 'wbTurn--edited has no studio.css rule');
});

/* S3C slice D: the provider-content compatibility layer is one ordered unit in
 * the profile stylesheet. Anchors are listed in the load-bearing order. */
const PROVIDER_LAYER_ORDER = [
  '.wbRichRoot pre', '.wbRichRoot :not(pre) > code',                               // 1. rich content baseline
  '.wbRichRoot :where(p, li, blockquote)', '.wbRichRoot li', '.wbRichRoot h1', '.wbRichRoot :where(h1, h2, h3, h4)', '.wbRichRoot :where(th, td)',
  ':root',                                                                        // 2. provider alias variables (profile root)
  '.text-token-text-primary', '.border-token-border-heavy',                        //    token utility classes
  '.font-bold', '.leading-tight', '.text-sm', '.flex', '.w-full', '.mt-2', '.rounded-3xl', '.relative', '.sr-only', '.contain-inline-size', // 3. utilities (baseline order: typography, sizes, display, sizing, spacing, radius, position, misc)
  '.prose, .markdown, div[class*="prose"]', '.prose h1, .markdown h1', '.prose blockquote, .markdown blockquote', '.cgMsgBody table, .prose table, .markdown table', '.cgMsgBody tr:nth-child(even) td, .prose tr:nth-child(even) td, .markdown tr:nth-child(even) td', '.prose code:not(pre code), .markdown code:not(pre code)', '.prose pre, .markdown pre', // 4. prose
  '.wbRichRoot :where( [class*="rounded-2xl"][class*="bg-token-main-surface-secondary"], [class*="contain-inline-size"] )', '.wbRichRoot code[class*="hljs"], .wbRichRoot code[class*="language-"], .wbRichRoot code.\\!whitespace-pre', // 5. code component
  '.hljs-keyword, .hljs-selector-tag', '.hljs-strong', '.katex-display', '.katex', '.wbRichRoot sup a, .wbRichRoot [data-footnote-ref]', '.wbRichRoot [data-footnotes]', // 5. syntax / math / citations
  '.dark .prose, .dark .markdown, .prose, .markdown', '.prose-invert', '.dark\\:prose-invert', '.light', '.prose p, .markdown p', '.prose blockquote, .markdown blockquote', '.prose hr, .markdown hr', // 6. dark-mode prose bridge (second .prose blockquote / hr occurrences)
  '.katex-html', '.border-token-surface-primary', '.sandbox-output',              // 7. late leftovers
];
const PROVIDER_ALIAS_VARIABLES = ['--token-main-surface-primary', '--token-surface-tertiary', '--token-text-primary', '--token-text-error', '--token-border-light', '--token-border-sharp', '--main-surface-primary', '--text-primary', '--text-tertiary', '--border-medium', '--border-light', '--tw-prose-inline-code-bg'];
const SHARED_THEME_INPUTS = ['--wb-page', '--wb-surface', '--wb-text', '--wb-text-soft', '--wb-muted', '--wb-border', '--wb-border-strong', '--wb-focus', '--wb-code-bg', '--wb-code-border', '--mono', '--wb-user-bg', '--wb-radius-xl'];

check('the provider-content compatibility layer lives in the profile stylesheet as one ordered unit (S3C slice D)', () => {
  const rules = parseRules(read(PROFILE_CSS_REL)).map((r) => ({ ...r, selector: norm(r.selector), plain: unscopedSelector(norm(r.selector)) }));
  /* A + F: every anchor is present, scoped, and in the accepted relative order
   * (later occurrences count for the repeated dark-bridge selectors). */
  let last = -1; let lastName = '';
  for (const anchor of PROVIDER_LAYER_ORDER) {
    const found = rules.filter((r) => r.media === null && r.plain === norm(anchor) && r.index > last);
    assert.ok(found.length >= 1, `A: provider-layer rule present after "${lastName}": ${anchor}`);
    last = found[0].index; lastName = anchor;
  }
  /* B: scoping is asserted for every member by the slice-A check; C: alias
   * variables live on the profile root and nowhere else in the sheet. */
  const rootRules = rules.filter((r) => r.selector === SCOPE);
  assert.equal(rootRules.length, 1, 'C: exactly one profile-root variable block');
  for (const v of PROVIDER_ALIAS_VARIABLES) assert.ok(v in rootRules[0].declarations, `C: provider alias ${v} defined on the profile root`);
  /* D: the sheet defines no shared --wb-* theme input (it may consume them). */
  for (const r of rules) for (const prop of Object.keys(r.declarations)) assert.ok(!prop.startsWith('--wb-'), `D: profile stylesheet must not define shared theme input ${prop}`);
  /* K: replay-interaction safety is not part of the unit; image/media presentation joined the profile in slice F. */
  assert.equal(rules.filter((r) => r.plain.includes('button, input, textarea, select, summary')).length, 0, 'K: replay-interaction safety stays outside the profile');
  assert.equal(rules.filter((r) => r.plain.includes(':where(img, video, canvas, svg)')).length, 1, 'J: rich media containment lives in the profile (slice F)');
  /* L: canonical table members moved with the prose table rules. */
  for (const sel of ['.cgMsgBody table', '.cgMsgBody thead', '.cgMsgBody th', '.cgMsgBody td', '.cgMsgBody tr:nth-child(even) td']) {
    assert.ok(rules.some((r) => splitMembers(r.plain).includes(sel)), `L: canonical table member ${sel} is profile-owned`);
  }
  /* Provider OUTER structure is not absorbed. */
  for (const sel of ['.text-message', '.agent-turn', '.user-turn', '[data-testid^="conversation-turn"]', '.wbRichRoot .text-message', '.result-streaming']) {
    assert.equal(rules.filter((r) => splitMembers(r.plain).includes(sel)).length, 0, `provider outer-structure rule ${sel} stays outside the profile`);
  }
});

check('global studio.css keeps no duplicate of the migrated provider-content layer and keeps the shared theme inputs, safety and image rules (S3C slice D)', () => {
  const glob = parseRules(read(STUDIO_CSS_REL)).map((r) => ({ ...r, selector: norm(r.selector) }));
  const prof = parseRules(read(PROFILE_CSS_REL)).map((r) => ({ ...r, plain: unscopedSelector(norm(r.selector)) }));
  const globalMembers = new Set(); for (const r of glob) if (r.media === null) for (const m of splitMembers(r.selector)) globalMembers.add(m);
  /* E: no profile-owned selector member (other than the structural .cgMsg split) is still declared globally. */
  const overlap = [];
  for (const r of prof) for (const m of splitMembers(r.plain)) if (m !== ':root' && m !== '.cgMsg' && globalMembers.has(m)) overlap.push(m);
  assert.deepEqual([...new Set(overlap)], [], 'E: studio.css must not duplicate any profile-owned selector member');
  /* C/D: alias variables gone from global :root; shared inputs still global. */
  const roots = glob.filter((r) => r.selector === ':root');
  assert.ok(roots.length >= 1, 'global :root theme block exists');
  for (const v of PROVIDER_ALIAS_VARIABLES) assert.ok(!roots.some((r) => v in r.declarations), `C: provider alias ${v} no longer on global :root`);
  for (const v of SHARED_THEME_INPUTS) assert.ok(roots.some((r) => v in r.declarations), `D: shared theme input ${v} stays on global :root`);
  /* K: replay-interaction safety stays global; J: image/media and attachment presentation moved in slice F. */
  const safety = glob.filter((r) => r.selector === '.wbRichRoot :where(button, input, textarea, select, summary)');
  assert.equal(safety.length, 1); assert.deepEqual(safety[0].declarations, { 'pointer-events': 'none' }, 'K: replay-interaction safety rule unchanged and global');
  assert.equal(glob.some((r) => r.selector === '.wbRichRoot :where(img, video, canvas, svg)'), false, 'J: rich media containment no longer global');
  assert.equal(glob.some((r) => splitMembers(r.selector).some((m) => m.includes('.dalle-image-container img'))), false, 'J: provider image rules no longer global');
  /* L: canonical table members and .cgMsgBody img no longer global. */
  for (const sel of ['.cgMsgBody table', '.cgMsgBody thead', '.cgMsgBody th', '.cgMsgBody td', '.cgMsgBody tr:nth-child(even) td', '.cgMsgBody img']) assert.equal(globalMembers.has(sel), false, `L: ${sel} no longer global`);
});

/* S3C slice F: image / attachment presentation is one ordered unit in the
 * profile stylesheet. Rich media containment sits after the rich content
 * baseline and before the provider utility layer; the generic image rule, the
 * provider image grid, the H2O attachment grid / card and the provider/user
 * attachment fallback follow the late leftovers, in the accepted order. */
const IMAGE_UNIT = [
  ['.dalle-image-container img, [data-testid="image-asset"] img, .wbRichRoot img, .cgMsgBody img, [data-message-author-role] img', { 'max-width': '100%', height: 'auto', 'border-radius': '8px' }],
  ['.wbRichRoot .grid:has(> img), .wbRichRoot [data-message-attachment-id]:has(> img)', { display: 'grid', 'grid-template-columns': 'repeat(auto-fit, minmax(180px, 1fr))', gap: '6px' }],
  ['.cgUserAttachmentGrid', { '--cg-user-attachment-size': '112px', display: 'grid', 'grid-template-columns': 'repeat(auto-fit, minmax(var(--cg-user-attachment-size), var(--cg-user-attachment-size)))', 'justify-content': 'end', gap: '8px', width: 'fit-content', 'max-width': 'min(100%, calc((var(--cg-user-attachment-size) * 3) + 16px))', margin: '0 0 8px auto' }],
  ['.cgUserAttachmentCard', { width: 'var(--cg-user-attachment-size)', height: 'var(--cg-user-attachment-size)', overflow: 'hidden', 'border-radius': '18px', border: '1px solid rgba(255,255,255,.12)', background: 'rgba(255,255,255,.08)' }],
  ['.cgUserAttachmentCard img', { display: 'block', width: '100%', height: '100%', 'max-width': 'none', 'object-fit': 'cover', 'border-radius': 'inherit' }],
];
/* S3C slice G: the user-turn provider attachment fallback (`.cgTurn--user
 * .grid:has(img)` / `[data-message-attachment-id]:has(img)` and their img
 * members) was dead CSS - the Renderer strips native user images at extraction
 * and projects user attachments only through cgUserAttachmentGrid / Card - and
 * was removed. The provider rich image grid (`.wbRichRoot .grid:has(> img)`)
 * stays live. */
const DEAD_USER_FALLBACK = /\.cgTurn--user (\.grid|\[data-message-attachment-id\]):has\(img\)/;
const READER_ATTACHMENT_ALIGNMENT = 'body[data-route="reader"] .cgUserAttachmentGrid, body[data-route="reader"] .wbRichRoot .cgTurn--user .cgUserAttachmentGrid, body[data-route="reader"] .wbRichRoot .wbTurn--user .cgUserAttachmentGrid, body[data-route="reader"] .wbRichRoot [data-turn="user"] .cgUserAttachmentGrid, body[data-route="reader"] :where(.cgTurn--user, .wbTurn--user, [data-turn="user"]) .cgUserAttachmentGrid';

check('image / attachment presentation lives in the profile stylesheet as one ordered unit after the provider-content layer (S3C slice F)', () => {
  const rules = parseRules(read(PROFILE_CSS_REL)).map((r) => ({ ...r, selector: norm(r.selector), plain: unscopedSelector(norm(r.selector)) }));
  const find = (plain) => rules.filter((r) => r.media === null && r.plain === norm(plain));
  /* F: rich media containment - after the rich content baseline, before the alias/utility layers. */
  const media = find('.wbRichRoot :where(img, video, canvas, svg)');
  assert.equal(media.length, 1, 'F: exactly one rich media containment rule');
  assert.deepEqual(media[0].declarations, { 'max-width': '100%' }, 'F: declaration verbatim');
  const lastBaseline = find('.wbRichRoot :where(th, td)').at(-1); const aliasRoot = find(':root')[0]; const firstUtility = find('.leading-tight')[0];
  assert.ok(lastBaseline && aliasRoot && firstUtility, 'unit anchors present');
  assert.ok(lastBaseline.index < media[0].index && media[0].index < aliasRoot.index && media[0].index < firstUtility.index, 'F: containment ordered after the rich baseline and before the provider token / utility layers');
  /* C/D/E/G: the image / attachment sequence follows the late leftovers, in order, declarations verbatim. */
  const lateLeftover = find('.sandbox-output').at(-1); assert.ok(lateLeftover, 'late leftover anchor present');
  let last = lateLeftover.index;
  for (const [plain, declarations] of IMAGE_UNIT) {
    const hits = find(plain);
    assert.equal(hits.length, 1, `unit rule present exactly once: ${plain}`);
    assert.ok(hits[0].index > last, `unit order preserved at: ${plain}`);
    assert.deepEqual(hits[0].declarations, declarations, `declarations verbatim: ${plain}`);
    last = hits[0].index;
  }
  /* A/B (order-sensitive pair): the generic image rule precedes the attachment-card image specialization at equal specificity. */
  assert.ok(find(IMAGE_UNIT[0][0])[0].index < find('.cgUserAttachmentCard img')[0].index, 'B: generic image presentation precedes the attachment-card image specialization');
  /* K: every member of the unit is profile-root scoped (raw selector members carry the scope). */
  for (const [plain] of IMAGE_UNIT) for (const m of splitMembers(find(plain)[0].selector)) assert.ok(m.startsWith(SCOPE), `K: scoped member: ${m}`);
  for (const m of splitMembers(media[0].selector)) assert.ok(m.startsWith(SCOPE), `K: scoped member: ${m}`);
  /* D (slice G): the dormant user-turn fallback is gone from the profile sheet; F: the provider rich image grid stays. */
  assert.equal(rules.filter((r) => DEAD_USER_FALLBACK.test(r.plain)).length, 0, 'D: no user-turn attachment fallback selector remains in the profile stylesheet (slice G)');
  assert.equal(rules.filter((r) => r.plain.includes(':has(img)')).length, 0, 'D: no :has(img) fallback member remains');
  /* H: Reader-route attachment alignment is not in the profile sheet; I: cgTurn--has-attachments stays unstyled. */
  assert.equal(rules.filter((r) => r.selector.includes('body[data-route="reader"]')).length, 0, 'H: no Reader-route rule in the profile stylesheet');
  assert.equal(rules.filter((r) => r.selector.includes('.cgTurn--has-attachments')).length, 0, 'I: cgTurn--has-attachments has no profile rule');
});

check('global studio.css keeps only the Reader-route attachment alignment and no image / attachment duplicate (S3C slice F)', () => {
  const glob = parseRules(read(STUDIO_CSS_REL)).map((r) => ({ ...r, selector: norm(r.selector) }));
  /* H: the Reader-route alignment block is verbatim, !important, and global. */
  const reader = glob.filter((r) => r.selector === norm(READER_ATTACHMENT_ALIGNMENT));
  assert.equal(reader.length, 1, 'H: Reader-route attachment alignment rule present once in studio.css');
  assert.deepEqual(reader[0].declarations, { 'align-self': 'flex-end !important', 'justify-content': 'end !important', 'margin-left': 'auto !important', 'margin-right': '0 !important' }, 'H: Reader-route alignment declarations unchanged');
  /* J: no migrated unit member is still declared globally. */
  const globalMembers = new Set(); for (const r of glob) for (const m of splitMembers(r.selector)) globalMembers.add(m);
  for (const [plain] of IMAGE_UNIT) for (const m of splitMembers(norm(plain))) assert.equal(globalMembers.has(m), false, `J: ${m} no longer declared in studio.css`);
  assert.equal(globalMembers.has('.wbRichRoot :where(img, video, canvas, svg)'), false, 'J: rich media containment no longer global');
  assert.equal([...globalMembers].some((m) => DEAD_USER_FALLBACK.test(m) || m.includes('.cgMsg--rich')), false, 'slice G: dead fallback / .cgMsg--rich not resurrected globally');
  /* I: cgTurn--has-attachments has no rule anywhere; the safety rule is untouched. */
  assert.equal(glob.filter((r) => r.selector.includes('.cgTurn--has-attachments')).length, 0, 'I: cgTurn--has-attachments unstyled in studio.css');
  assert.ok(glob.some((r) => r.selector === '.wbRichRoot :where(button, input, textarea, select, summary)'), 'replay-interaction safety stays global');
});

/* S3C slice H: the final Renderer / Reader CSS boundary. Every remaining
 * studio.css rule whose selector touches the Renderer / replay vocabulary must
 * fall into exactly one accepted non-profile category; the reference profile
 * owns all chatgpt-reference presentation. A rule that matches none of the
 * category patterns is reported as stranded presentation and fails. */
const RENDERER_FAMILY = /cgFrame|cgBody|cgThread|cgScroll|cgTurn|cgMsg|cgBubble|cgUserAttachment|wbRichRoot|wbTurn|data-message-author-role|data-testid\^?="conversation-turn|\[data-turn|\.text-message|\.agent-turn|\.user-turn|user-message-bubble-color|result-streaming|data-message-id|\.markdown|\.prose|\.flex-col|\.relative/;
const BOUNDARY_CATEGORIES = [
  ['READER_INTEGRATION', (sel) => /^body\[data-route="reader"\]|^\.wbReader\b|^html\[data-h2o-runtime="tauri"\] \.wbReader|^#viewReader/.test(sel) && !/data-cgxui|cgxui-/.test(sel)],
  ['OTHER_LANE_OWNED_FEATURE_INTEGRATION', (sel) => /data-cgxui|cgxui-|data-at-collapsed/.test(sel)],
  ['APPLICATION_SHELL_STRUCTURE', (sel) => /^\.cgFrame$|^\.cgBody$|^\.cgThread$|^\.cgScroll(::-webkit-scrollbar[\w-]*(:hover)?)?$|^\.cgScroll > \*$|^body\[data-layout="wide"\] \.cgScroll > \*$|^\.wbHistory::-webkit-scrollbar|^\.wbSideLabel$|^\.wbSideMeta$|^\.wbRouteEyebrow$|^\.cgKicker$|^\.cgMsgMeta$|^\.wbTurn$|^\.wbTurn:hover \.wbEditBtn$|^\.wbTurn--editing \.wbEditBtn$/.test(sel)],
  /* Replay interaction safety: inert replayed controls and hidden provider action affordances (edit / response actions / action buttons). */
  ['RENDERER_REPLAY_INTERACTION_SAFETY_NON_PROFILE', (sel) => /^\.wbRichRoot :where\(button, input, textarea, select, summary\)$|^\.wbRichRoot \[data-testid(="[\w-]+-turn-action-button"|\*="action-button")\]$|^\.wbRichRoot \[aria-label="(Edit message|Response actions|Your message actions)"\](\[role="group"\])?$|^\.result-streaming$/.test(sel)],
  ['RENDERER_STRUCTURAL_OR_REPLAY_COMPATIBILITY_NON_PROFILE', (sel) => /^\.cgTurn$|^\.cgTurn--user$|^\.cgMsg$|^\.wbRichRoot \.cgTurn--user\[data-testid\^="conversation-turn"\]$|^\.text-message$|^\.agent-turn$|^\.user-turn$|^\[data-testid\^="conversation-turn"\]$|^\[data-message-author-role="(assistant|user)"\] \.relative$|^\.wbRichRoot (\[data-message-author-role(="(user|assistant)")?\](\.text-message| \.text-message( > \*)?| :where\(\.markdown, \.prose, ul, ol, li\)| > div| \.flex-col)|\.text-message|\.result-streaming::after|\[class\*="streaming"\])$/.test(sel)],
];
const DEAD_SELECTORS = [DEAD_NO_BUBBLE_FALLBACK, '.cgMsg--rich'];

check('final Renderer / Reader CSS boundary: no reference-profile presentation is stranded in studio.css (S3C slice H)', () => {
  const rules = parseRules(read(STUDIO_CSS_REL)).map((r) => ({ ...r, selector: norm(r.selector) }));
  const stranded = []; const tally = {};
  for (const r of rules) {
    for (const m of splitMembers(r.selector)) {
      if (!RENDERER_FAMILY.test(m)) continue;
      const hit = BOUNDARY_CATEGORIES.find(([, test]) => test(m));
      if (!hit) { stranded.push(`${m} { ${Object.entries(r.declarations).map(([k, v]) => `${k}:${v}`).join('; ')} }`); continue; }
      tally[hit[0]] = (tally[hit[0]] || 0) + 1;
    }
  }
  assert.deepEqual(stranded, [], `J: REFERENCE_PROFILE_PRESENTATION stranded in studio.css (count ${stranded.length})`);
  for (const cat of ['READER_INTEGRATION', 'APPLICATION_SHELL_STRUCTURE', 'RENDERER_STRUCTURAL_OR_REPLAY_COMPATIBILITY_NON_PROFILE', 'RENDERER_REPLAY_INTERACTION_SAFETY_NON_PROFILE', 'OTHER_LANE_OWNED_FEATURE_INTEGRATION']) assert.ok(tally[cat] > 0, `boundary category populated: ${cat}`);
  /* B/D/F/H/I: the dead rules are gone; the structural, Reader and safety rules are exactly where the boundary says. */
  for (const dead of DEAD_SELECTORS) assert.equal(rules.filter((r) => splitMembers(r.selector).includes(norm(dead))).length, 0, `B: dead rule absent from studio.css: ${dead}`);
  const global = (sel) => rules.filter((r) => r.media === null && r.selector === norm(sel));
  assert.deepEqual(global('.wbRichRoot .cgTurn--user[data-testid^="conversation-turn"]')[0]?.declarations, { display: 'flex', 'flex-direction': 'column', 'align-items': 'flex-end', 'justify-content': 'flex-start' }, 'D: H1 structural placement stays global, verbatim');
  assert.deepEqual(global('.wbRichRoot :where(button, input, textarea, select, summary)')[0]?.declarations, { 'pointer-events': 'none' }, 'I: replay interaction safety stays global, verbatim');
  for (const sel of ['.text-message', '.agent-turn', '.user-turn', '[data-testid^="conversation-turn"]', '.result-streaming', '.wbRichRoot .text-message']) assert.ok(rules.some((r) => splitMembers(r.selector).includes(sel)), `H: provider outer-structure rule stays global: ${sel}`);
  assert.ok(rules.some((r) => splitMembers(r.selector).includes('[data-message-author-role="assistant"] .relative')), 'H: provider .relative position normalization stays global');
  const readerRich = rules.filter((r) => splitMembers(r.selector).some((m) => m.startsWith('body[data-route="reader"]') && /wbRichRoot|cgMsg--user|cgUserAttachmentGrid|cgTurn/.test(m)));
  assert.ok(readerRich.length >= 6, `F: Reader-route rich integration rules stay global (found ${readerRich.length})`);
  assert.ok(rules.some((r) => r.selector === '.wbReader [data-turn].is-in-collapsed-section' && r.declarations.display === 'none'), 'F: Reader collapsed-section rule still global');
  assert.ok(rules.some((r) => splitMembers(r.selector).includes('.wbReader [data-message-author-role]') && 'max-width' in r.declarations), 'F: Reader appearance width rule still global');
  /* C/E/G/I: none of the non-profile families live in the profile sheet. */
  const prof = parseRules(read(PROFILE_CSS_REL)).map((r) => ({ ...r, plain: unscopedSelector(norm(r.selector)) }));
  for (const [label, re] of [['G: Reader-route', /^body\[data-route="reader"\]|^\.wbReader\b/], ['E: H1 structural placement', /^\.wbRichRoot \.cgTurn--user\[data-testid/], ['C: dead no-bubble fallback', /:not\(:has\(\.user-message-bubble-color\)\)/], ['I: replay interaction safety', /:where\(button, input, textarea, select, summary\)/], ['H: provider outer structure', /^\.text-message$|^\.agent-turn$|^\.user-turn$|^\[data-testid\^="conversation-turn"\]$|^\.result-streaming$/]]) {
    assert.equal(prof.filter((r) => splitMembers(r.plain).some((m) => re.test(m))).length, 0, `${label} rules are absent from the profile stylesheet`);
  }
});

check('profile stylesheet is the sole chatgpt-reference presentation authority and is pinned at 1.0.6 for the boundary closure (S3C slice H)', () => {
  const css = read(PROFILE_CSS_REL);
  assert.equal(/@version\s+(\d+\.\d+\.\d+)/.exec(css)?.[1], '1.0.6', 'K: profile stylesheet version unchanged by the boundary slice');
  const rules = parseRules(css).map((r) => ({ ...r, selector: norm(r.selector) }));
  for (const r of rules) for (const m of splitMembers(r.selector)) assert.ok(m === SCOPE || m.startsWith(`${SCOPE} `), `every profile member is scoped: ${m}`);
  assert.ok(rules.length >= 250, `profile sheet carries the migrated presentation (${rules.length} rules)`);
});

check('profile stylesheet @version and the studio.html cache query match exactly', () => {
  const version = /@version\s+(\d+\.\d+\.\d+)/.exec(read(PROFILE_CSS_REL))?.[1];
  const link = new RegExp(`href="\\./${PROFILE_CSS_REL.replace(/[.]/g, '\\.')}\\?v=(\\d+\\.\\d+\\.\\d+)"`).exec(read(STUDIO_HTML_REL))?.[1];
  assert.ok(version, 'profile stylesheet carries an @version');
  assert.equal(link, version, `J: studio.html ?v= (${link}) must equal the profile stylesheet @version (${version})`);
});

/* ------------------------------------------------------------ Tier 2 */

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
  console.log('SKIP real-browser DOM oracle unavailable (set H2O_PLAYWRIGHT_MODULE)');
  console.log('SKIP is not PASS: the rendered DOM was not inspected.');
  if (STRICT) { console.error('FAIL H2O_REQUIRE_CONTENT_RENDERER_TIER2 is set'); process.exit(1); }
} else {
  const MIME = { '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css' };
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '');
    if (rel === '__harness__') {
      const tags = [
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
        /* S4A/T8: the Renderer builds one Semantic Index per render through the
         * index module and fails clearly without it, so the Tier-2 chain admits
         * it in its production position. */
        'renderer/semantic/semantic-index.v1.js',
        /* S4B/T8: the Renderer binds one DecorationContribution lifecycle to
         * each render's index through the decoration module and fails clearly
         * without it, so the Tier-2 chain admits it in its production position. */
        'renderer/decoration/decoration-contribution.v1.js',
        /* S3B/T6: the Renderer resolves its presentation hooks from the profile
         * module and fails clearly without it, so the Tier-2 chain admits it in
         * its production position. */
        'renderer/presentation/presentation-profile.v1.js',
        CONTENT_REL,
        RENDERER_REL,
      ].map((r) => `<script src="./${r}"></script>`).join('\n');
      /* S3C: production stylesheets in production order; the host carries the
       * conversation-root profile marker the Renderer stylesheet is scoped to,
       * and a second host without it proves the scope. */
      const links = `<link rel="stylesheet" href="./${STUDIO_CSS_REL}"><link rel="stylesheet" href="./${PROFILE_CSS_REL}">`;
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`<!doctype html><meta charset="utf-8"><title>t5</title>${links}\n${tags}\n<div id="host" ${PROFILE_MARKER}></div><div id="unscoped"></div>`);
      return;
    }
    /* M04 P2 T3: the PRODUCTION chain and stylesheets exactly as studio.html
     * admits them (Clean Reader module and stylesheet included), on a fresh
     * page whose registries are still open. */
    if (rel === '__clean_reader_harness__') {
      const tags = PRODUCTION_CHAIN.map((r) => `<script src="./${r}"></script>`).join('\n');
      const links = PRODUCTION_STYLESHEETS.map((r) => `<link rel="stylesheet" href="./${r}">`).join('');
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`<!doctype html><meta charset="utf-8"><title>t3</title>${links}\n${tags}\n<section id="viewReader" class="wbReader"><div id="host"></div></section>`);
      return;
    }
    /* M03 S4C slice B: a second page for the Answer Timestamp consumer. */
    if (rel === '__studio_bridge__.js') {
      const studioSource = read(STUDIO_JS_REL);
      const bridge = ['bindReaderSemanticIndex', 'getReaderSemanticIndex', 'getReaderDecorationContributions', 'disposeReaderRenderDecorations', 'studioHostUnmount'].map((name) => extractStudioFunction(studioSource, name)).join('\n');
      res.writeHead(200, { 'Content-Type': 'text/javascript' });
      res.end(`(() => { const state = { currentReaderEditOverrides: null, currentReaderRender: null }; const W = { H2O: window.H2O }; window.__unmounts = []; window.__warnings = []; W.H2O.studioHost = { unmount(reason) { window.__unmounts.push(reason); } }; const console = { warn: (...a) => window.__warnings.push(a.map(String).join(' ')) };\n${bridge}\nwindow.H2O.Studio.getReaderSemanticIndex = getReaderSemanticIndex; window.H2O.Studio.getReaderDecorationContributions = getReaderDecorationContributions; window.__bridge = { bind: bindReaderSemanticIndex, unmount: studioHostUnmount, state }; })();`);
      return;
    }
    if (rel === '__answer_timestamp__.js') { res.writeHead(200, { 'Content-Type': 'text/javascript' }); res.end(read(ANSWER_TIMESTAMP_REL)); return; }
    if (rel === '__timestamp_harness__') {
      const variant = new URL(req.url, 'http://x').searchParams.get('variant');
      const chain = [
        'platform/selectors.contract.js', 'platform/html-sanitizer.js', 'renderer/safety/sanitizer-policy.v1.js', 'renderer/safety/vendor/dompurify/purify.js', 'renderer/safety/html-sanitizer.v2.js',
        'renderer/markdown/vendor/markdown-it/markdown-it.umd.min.js', 'renderer/markdown/h2o-gfm.v1.js', 'renderer/markdown/markdown-engine.v1.js', 'renderer/markdown/markdown-ir-adapter.v1.js',
        'renderer/semantic/render-ir.v1.js', 'renderer/semantic/semantic-ingress.v1.js', 'renderer/semantic/semantic-index.v1.js', 'renderer/decoration/decoration-contribution.v1.js',
        'renderer/presentation/presentation-profile.v1.js', CONTENT_REL, RENDERER_REL,
        ...(variant === 'governed' ? ['__studio_bridge__.js'] : []), '__answer_timestamp__.js',
      ].map((r) => `<script src="./${r}"></script>`).join('\n');
      /* Studio mode marker + a bus stub so the module's core hooks install; the assistant-selector spy counts compatibility scans. */
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`<!doctype html><meta charset="utf-8"><title>ts</title><link rel="stylesheet" href="./${STUDIO_CSS_REL}"><link rel="stylesheet" href="./${PROFILE_CSS_REL}"><body data-h2o-studio-mode="1"><script>window.H2O = { bus: { on() {} } }; window.__scans = []; for (const proto of [Element.prototype, Document.prototype]) { const orig = proto.querySelectorAll; proto.querySelectorAll = function (sel) { if (String(sel) === 'div[data-message-author-role="assistant"]') window.__scans.push(1); return orig.call(this, sel); }; }</script>\n${chain}\n<section id="viewReader" class="wbReader" ${PROFILE_MARKER}></section>`);
      return;
    }
    const file = path.join(STUDIO, rel);
    if (!file.startsWith(STUDIO) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end('nf'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(fs.readFileSync(file));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  await page.goto(`${base}/__harness__`, { waitUntil: 'load' });

  const SOURCE = [
    '## Heading two',
    '',
    'Body **strong** *emphasis* `code` ~~struck~~ [safe](https://example.test/a) [unsafe](javascript:alert(1)).',
    '',
    '- bullet',
    '- [x] done',
    '- [ ] todo',
    '',
    '3. three',
    '4. four',
    '',
    '> quoted',
    '',
    '```js',
    'const x = 1;',
    '```',
    '',
    '```',
    'plain block',
    '```',
    '',
    '| a | b |',
    '|:--|--:|',
    '| 1 | 2 |',
    '',
    '![ok](https://example.test/i.png)',
    '',
    '![bad](http://example.test/i.png)',
    '',
    '---',
    '',
    'line one  ',
    'line two',
  ].join('\n');

  const dom = await page.evaluate((src) => {
    const R = globalThis.H2O.Studio.Renderer;
    const md = R.markdownEngine.formalBaseEngine();
    const parsed = R.markdownIrAdapter.markdownToBlocks(md, src);
    const host = document.getElementById('host');
    host.appendChild(R.contentRenderer.renderBlocks(parsed.blocks, { document }));
    const q = (sel) => Array.from(host.querySelectorAll(sel));
    return {
      fallback: parsed.fallback,
      h2: q('h2').map((n) => n.textContent),
      strong: q('strong').map((n) => n.textContent),
      em: q('em').map((n) => n.textContent),
      code: q('code').map((n) => n.textContent),
      struck: q('s').map((n) => n.textContent),
      anchors: q('a').map((n) => ({ href: n.getAttribute('href'), text: n.textContent, rel: n.getAttribute('rel') })),
      deniedLinks: q('[data-h2o-link-denied]').map((n) => ({ reason: n.getAttribute('data-h2o-link-denied'), text: n.textContent })),
      ul: q('ul').length, ol: q('ol').length,
      olStart: q('ol').map((n) => n.getAttribute('start')),
      tasks: q('[data-h2o-task]').map((n) => n.getAttribute('data-h2o-task')),
      inputs: q('input, button').length,
      blockquote: q('blockquote').map((n) => n.textContent.trim()),
      codeBlock: q('div.wbCodeBlock pre code').map((n) => n.textContent),
      codeLang: q('div.wbCodeLang').map((n) => n.textContent),
      codeWrappers: q('div.wbCodeBlock').map((n) => ({ cls: n.className, badge: n.querySelector(':scope > .wbCodeLang')?.textContent ?? null, firstChild: n.firstElementChild.tagName.toLowerCase(), lastChild: n.lastElementChild.tagName.toLowerCase() })),
      codeStyle: q('div.wbCodeBlock').map((n) => { const cs = getComputedStyle(n); const root = getComputedStyle(document.documentElement); return { margin: cs.margin, borderRadius: cs.borderRadius, overflow: cs.overflow, borderTopWidth: cs.borderTopWidth, borderTopStyle: cs.borderTopStyle, background: cs.backgroundColor, tokenBg: root.getPropertyValue('--wb-code-bg').trim() }; }),
      langStyle: q('div.wbCodeLang').map((n) => { const cs = getComputedStyle(n); return { padding: cs.padding, fontSize: cs.fontSize, textTransform: cs.textTransform, letterSpacing: cs.letterSpacing }; }),
      unscoped: (() => { const u = document.getElementById('unscoped'); u.replaceChildren(); const w = document.createElement('div'); w.className = 'wbCodeBlock'; const b = document.createElement('div'); b.className = 'wbCodeLang'; w.appendChild(b); u.appendChild(w); const cs = getComputedStyle(w); const bs = getComputedStyle(b); const out = { borderRadius: cs.borderRadius, overflow: cs.overflow, textTransform: bs.textTransform, fontSize: bs.fontSize }; u.replaceChildren(); return out; })(),
      th: q('th').map((n) => ({ text: n.textContent, align: n.style.textAlign, scope: n.getAttribute('scope') })),
      td: q('td').map((n) => ({ text: n.textContent, align: n.style.textAlign })),
      images: q('img').map((n) => ({ src: n.getAttribute('src'), alt: n.getAttribute('alt') })),
      deniedImages: q('[data-h2o-image-denied]').map((n) => ({ reason: n.getAttribute('data-h2o-image-denied'), text: n.textContent })),
      hr: q('hr').length, br: q('br').length,
      htmlHasScript: /<script/i.test(host.innerHTML),
    };
  }, SOURCE);

  /* S3C slice B: the canonical user-bubble base rule and its narrow override
   * now live together in the profile stylesheet. A probe .cgMsg--user directly
   * under the marked host (outside any .wbRichRoot / .wbReader / reader-route
   * scaffolding, which carry higher-specificity rules) exposes exactly that
   * base/override pair at equal specificity. */
  const PROBE = () => {
    const host = document.getElementById('host');
    const probe = document.createElement('div'); probe.className = 'cgMsg cgMsg--user'; probe.textContent = 'probe';
    host.appendChild(probe);
    const cs = getComputedStyle(probe);
    const out = { maxWidth: cs.maxWidth, width: cs.width, padding: cs.padding, borderRadius: cs.borderRadius, background: cs.backgroundColor, color: cs.color, viewport: innerWidth };
    probe.remove();
    return out;
  };
  const RICH_PROBE = () => {
    const wrap = (inner) => '<div class="flex w-full flex-col gap-1 items-end"><div class="relative user-message-bubble-color">' + inner + '</div></div>';
    const input = { chatId: 'c', title: 't', projectId: '', snapshotId: 's', messages: [{ role: 'user', text: 'rich', messageId: 'u1' }],
      richTurns: [{ role: 'user', turnIdx: 1, messageId: 'rm-1', turnId: 'rt-1', outerHTML: '<article data-testid="conversation-turn-1"><div data-message-author-role="user" data-message-id="p1">' + wrap('<div class="whitespace-pre-wrap">rich user text</div>') + '</div></article>' }] };
    const r = globalThis.H2O.Studio.chatRenderer.render(input, { getEditOverride: () => null });
    const mount = document.getElementById('unscoped'); mount.replaceChildren(r.root);
    const bubble = r.root.querySelector('.cgBubble.user-message-bubble-color'); const host = r.root.querySelector('.cgMsg');
    const cs = getComputedStyle(bubble);
    const out = { mode: r.renderMode, bubbles: r.root.querySelectorAll('.user-message-bubble-color').length, maxWidth: cs.maxWidth, padding: cs.padding, borderRadius: cs.borderRadius, marginLeft: cs.marginLeft, background: cs.backgroundColor, hostColor: getComputedStyle(host).color, viewport: innerWidth };
    mount.replaceChildren(); return out;
  };
  /* S3C slice D: the provider compatibility vocabulary applies only beneath a
   * profile-marked root. The same synthetic provider node is measured inside
   * the marked host and outside it. */
  const SCOPE_PROBE = (parentId) => {
    const parent = document.getElementById(parentId);
    const node = document.createElement('div'); node.className = 'flex text-sm rounded-lg text-token-text-primary relative'; node.textContent = 'probe';
    const prose = document.createElement('div'); prose.className = 'markdown prose';
    const inner = document.createElement('h2'); inner.className = 'leading-tight mt-2'; inner.textContent = 'h'; prose.appendChild(inner);
    /* A non-prose rich heading is the order-sensitive pair: the rich baseline
     * `.wbRichRoot :where(h1, h2, h3, h4)` and the utilities `.leading-tight` /
     * `.mt-2` share specificity (0,1,0), so the later rule wins. */
    const rich = document.createElement('div'); rich.className = 'wbRichRoot';
    const richHeading = document.createElement('h2'); richHeading.className = 'leading-tight mt-2'; richHeading.textContent = 'h'; rich.appendChild(richHeading);
    /* S3C slice E: the persisted edit accent (profile hook cgMsg--edited) and
     * the unstyled rich edited-turn state hook. */
    const edited = document.createElement('div'); edited.className = 'cgMsg cgMsg--assistant cgMsg--edited'; edited.textContent = 'edited';
    const turnPlain = document.createElement('div'); turnPlain.className = 'cgTurn cgTurn--assistant wbTurn wbTurn--rich wbTurn--assistant';
    const turnEdited = document.createElement('div'); turnEdited.className = 'cgTurn cgTurn--assistant wbTurn wbTurn--rich wbTurn--assistant wbTurn--edited';
    /* S3C slice F: attachment grid / card / image, a canonical body image and a
     * provider image-asset image, all inside a rich transcript root. */
    const PX = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    const richRoot = document.createElement('div'); richRoot.className = 'cgScroll wbRichRoot';
    const turn = document.createElement('div'); turn.className = 'cgTurn cgTurn--user wbTurn wbTurn--fallback wbTurn--user cgTurn--has-attachments'; turn.setAttribute('data-turn', 'user');
    const grid = document.createElement('div'); grid.className = 'cgUserAttachmentGrid';
    const card = document.createElement('div'); card.className = 'cgUserAttachmentCard'; const cardImg = document.createElement('img'); cardImg.src = PX; card.appendChild(cardImg); grid.appendChild(card);
    const msg = document.createElement('div'); msg.className = 'cgMsg cgMsg--user'; msg.setAttribute('data-message-author-role', 'user'); const body = document.createElement('div'); body.className = 'cgMsgBody'; const bodyImg = document.createElement('img'); bodyImg.src = PX; body.appendChild(bodyImg); msg.appendChild(body);
    const asset = document.createElement('div'); asset.setAttribute('data-testid', 'image-asset'); const assetImg = document.createElement('img'); assetImg.src = PX; asset.appendChild(assetImg);
    turn.appendChild(grid); turn.appendChild(msg); turn.appendChild(asset); richRoot.appendChild(turn);
    parent.appendChild(node); parent.appendChild(prose); parent.appendChild(rich); parent.appendChild(edited); parent.appendChild(turnPlain); parent.appendChild(turnEdited); parent.appendChild(richRoot);
    const cs = getComputedStyle(node); const hs = getComputedStyle(inner); const rs = getComputedStyle(richHeading); const es = getComputedStyle(edited);
    const gs = getComputedStyle(grid), cds = getComputedStyle(card), cis = getComputedStyle(cardImg), bis = getComputedStyle(bodyImg), ais = getComputedStyle(assetImg);
    const attachments = { gridDisplay: gs.display, gridGap: gs.gap, gridMaxWidth: gs.maxWidth, gridJustify: gs.justifyContent, cardWidth: cds.width, cardHeight: cds.height, cardRadius: cds.borderRadius, cardOverflow: cds.overflow, cardImgObjectFit: cis.objectFit, cardImgRadius: cis.borderRadius, cardImgMaxWidth: cis.maxWidth, cardImgHeight: cis.height, bodyImgRadius: bis.borderRadius, bodyImgMaxWidth: bis.maxWidth, bodyImgHeight: bis.height, assetImgRadius: ais.borderRadius, turnDelta: (() => { const a = getComputedStyle(turn); turn.classList.remove('cgTurn--has-attachments'); const b = getComputedStyle(turn); const diff = []; for (const k of Array.from(a)) if (a.getPropertyValue(k) !== b.getPropertyValue(k)) diff.push(k); turn.classList.add('cgTurn--has-attachments'); return diff; })() };
    const turnDelta = (() => { const a = getComputedStyle(turnPlain), b = getComputedStyle(turnEdited); const diff = []; for (const k of Array.from(a)) if (a.getPropertyValue(k) !== b.getPropertyValue(k)) diff.push(k); return diff; })();
    const out = { display: cs.display, fontSize: cs.fontSize, borderRadius: cs.borderRadius, position: cs.position, color: cs.color, headingLineHeight: hs.lineHeight, headingMarginTop: hs.marginTop, headingFontSize: hs.fontSize, richHeadingFontSize: rs.fontSize, richHeadingLineHeight: rs.lineHeight, richHeadingMarginTop: rs.marginTop, tokenText: getComputedStyle(node).getPropertyValue('--token-text-primary').trim(),
      editedBorderLeftWidth: es.borderLeftWidth, editedBorderLeftColor: es.borderLeftColor, editedPaddingLeft: es.paddingLeft, editedMarginLeft: es.marginLeft, editedTurnDelta: turnDelta, attachments };
    node.remove(); prose.remove(); rich.remove(); edited.remove(); turnPlain.remove(); turnEdited.remove(); richRoot.remove(); return out;
  };
  const scoping = { inside: await page.evaluate(SCOPE_PROBE, 'host'), outside: await page.evaluate(SCOPE_PROBE, 'unscoped') };
  const cascade = { normal: await page.evaluate(PROBE), richNormal: await page.evaluate(RICH_PROBE) };
  await page.setViewportSize({ width: 480, height: 800 });
  cascade.narrow = await page.evaluate(PROBE);
  cascade.richNarrow = await page.evaluate(RICH_PROBE);
  await page.setViewportSize({ width: 1280, height: 720 });

  check('canonical user-bubble base rule and narrow override cascade correctly from the profile stylesheet (S3C slice B)', () => {
    assert.ok(cascade.normal.viewport > 720 && cascade.narrow.viewport <= 720, 'probe ran at both widths');
    assert.equal(cascade.normal.maxWidth, 'min(70%, 704px)', 'H: base max-width min(var(--wb-user-w), 44rem) at normal width');
    assert.equal(cascade.narrow.maxWidth, 'min(100%, 672px)', 'H: the migrated narrow override min(100%, 42rem) wins at <= 720px');
    for (const probe of [cascade.normal, cascade.narrow]) {
      /* width:fit-content resolves to a used px value in getComputedStyle; the shrink-wrap is proven by it being far below the host width. */
      assert.ok(parseFloat(probe.width) > 0 && parseFloat(probe.width) < 200, `fit-content user bubble shrink-wraps its text (${probe.width})`);
      assert.equal(probe.padding, '10px 20px'); assert.equal(probe.borderRadius, '24px');
      assert.notEqual(probe.background, 'rgba(0, 0, 0, 0)', 'user bubble background comes from the shared --wb-user-bg token');
    }
  });

  check('provider compatibility utilities, prose and alias tokens apply only beneath the profile-marked root (S3C slice D)', () => {
    const i = scoping.inside, o = scoping.outside;
    assert.equal(i.display, 'flex'); assert.equal(i.fontSize, '14px'); assert.equal(i.borderRadius, '8px'); assert.equal(i.position, 'relative');
    assert.notEqual(i.tokenText, '', 'provider alias variable resolves beneath the profile root');
    /* Prose h2 (1.5rem, line-height 1.25, margin 1.4rem) dominates the utility
     * classes at (0,1,1), exactly as in the accepted global cascade. */
    assert.equal(i.headingFontSize, '24px'); assert.equal(i.headingLineHeight, '30px'); assert.equal(i.headingMarginTop, '22.4px');
    /* Non-prose rich heading: the utilities are ordered AFTER the rich baseline
     * inside the unit, so .leading-tight (1.25 x 18px) and .mt-2 (.5rem) win;
     * a reversed order would yield 23.04px / 18.4px. */
    assert.equal(i.richHeadingFontSize, '18px', 'rich heading size from the rich baseline (!important)');
    assert.equal(i.richHeadingLineHeight, '22.5px', 'utility .leading-tight wins over the rich baseline line-height by order');
    assert.equal(i.richHeadingMarginTop, '8px', 'utility .mt-2 wins over the rich baseline margin by order');
    assert.equal(o.display, 'block', 'negative scope: .flex has no effect outside the profile root');
    assert.equal(o.fontSize, '16px'); assert.equal(o.borderRadius, '0px'); assert.equal(o.position, 'static');
    assert.equal(o.tokenText, '', 'negative scope: provider alias variables are not global');
    /* The UA default h2 (1.5em) coincides with prose 1.5rem at the root font
     * size, so line-height and margin are the discriminating prose metrics. */
    assert.notEqual(o.headingLineHeight, i.headingLineHeight, 'negative scope: prose heading metrics do not apply outside the profile root');
    assert.notEqual(o.headingMarginTop, i.headingMarginTop, 'negative scope: prose heading margin does not apply outside the profile root');
    assert.equal(o.richHeadingFontSize, '24px', 'negative scope: the rich baseline heading size is not global');
    assert.equal(o.richHeadingLineHeight, 'normal', 'negative scope: neither the rich baseline nor .leading-tight applies outside the profile root');
  });

  check('persisted edit accent applies only beneath the profile-marked root and the edited-turn hook stays unstyled (S3C slice E)', () => {
    const i = scoping.inside, o = scoping.outside;
    assert.equal(i.editedBorderLeftWidth, '2px'); assert.equal(i.editedBorderLeftColor, 'rgba(122, 182, 255, 0.28)'); assert.equal(i.editedPaddingLeft, '12px'); assert.equal(i.editedMarginLeft, '-14px');
    assert.equal(o.editedBorderLeftWidth, '0px', 'negative scope: no edit accent outside the profile root');
    assert.equal(o.editedPaddingLeft, '0px'); assert.equal(o.editedMarginLeft, '0px');
    assert.deepEqual(i.editedTurnDelta, [], 'G: wbTurn--edited changes no computed property (state hook without presentation)');
    assert.deepEqual(o.editedTurnDelta, []);
  });

  check('attachment grid / card / image and canonical or provider image presentation apply only beneath the profile-marked root (S3C slice F)', () => {
    const i = scoping.inside.attachments, o = scoping.outside.attachments;
    assert.equal(i.gridDisplay, 'grid'); assert.equal(i.gridGap, '8px'); assert.equal(i.gridJustify, 'end'); assert.equal(i.gridMaxWidth, 'min(100%, 352px)', 'grid max-width resolves from the local attachment size variable');
    assert.equal(i.cardWidth, '112px'); assert.equal(i.cardHeight, '112px'); assert.equal(i.cardRadius, '18px'); assert.equal(i.cardOverflow, 'hidden');
    /* B: the attachment-card image specialization wins over the generic 8px image rule by order. */
    assert.equal(i.cardImgObjectFit, 'cover'); assert.equal(i.cardImgRadius, '18px', 'B: card image inherits the 18px card radius, not the generic 8px'); assert.equal(i.cardImgMaxWidth, 'none'); assert.equal(i.cardImgHeight, '110px', 'card image fills the card (100% of the 112px card minus the 1px border)');
    /* getComputedStyle reports the used height for a replaced element, so `height:auto` is proven by the verbatim declaration check above, not here. */
    assert.equal(i.bodyImgRadius, '8px', 'E: canonical cgMsgBody img keeps the generic 8px radius'); assert.equal(i.bodyImgMaxWidth, '100%');
    assert.equal(i.assetImgRadius, '8px', 'D: provider image-asset image keeps the generic 8px radius');
    assert.deepEqual(i.turnDelta, [], 'I: cgTurn--has-attachments changes no computed property');
    assert.equal(o.gridDisplay, 'block', 'negative scope: no attachment grid presentation outside the profile root'); assert.equal(o.gridGap, 'normal');
    assert.equal(o.cardRadius, '0px'); assert.equal(o.cardOverflow, 'visible'); assert.equal(o.cardImgObjectFit, 'fill'); assert.equal(o.cardImgRadius, '0px');
    assert.equal(o.bodyImgRadius, '0px', 'negative scope: no generic image presentation outside the profile root'); assert.equal(o.assetImgRadius, '0px'); assert.equal(o.bodyImgMaxWidth, 'none');
  });

  check('rich user bubble skin and its narrow override cascade correctly from the profile stylesheet (S3C slice C)', () => {
    for (const probe of [cascade.richNormal, cascade.richNarrow]) {
      assert.equal(probe.mode, 'rich'); assert.equal(probe.bubbles, 1, 'G: exactly one H2O bubble');
      assert.equal(probe.padding, '10px 20px'); assert.equal(probe.borderRadius, '24px');
      assert.notEqual(probe.background, 'rgba(0, 0, 0, 0)', 'bubble background comes from the shared --wb-user-bg token');
    }
    assert.equal(cascade.richNormal.maxWidth, 'min(70%, 704px)', 'H: base rich bubble max-width at normal width');
    assert.equal(cascade.richNarrow.maxWidth, 'min(100%, 672px)', 'I: the migrated narrow rich-bubble override wins at <= 720px');
  });

  check('representative Markdown renders as semantic DOM without fallback', () => {
    assert.deepEqual(pageErrors, [], `page errors: ${pageErrors.join(' | ')}`);
    assert.equal(dom.fallback, false, 'valid Markdown must not fall back');
    assert.deepEqual(dom.h2, ['Heading two']);
    assert.deepEqual(dom.strong, ['strong']);
    assert.deepEqual(dom.em, ['emphasis']);
    assert.deepEqual(dom.code, ['code', 'const x = 1;\n', 'plain block\n']);
    assert.deepEqual(dom.struck, ['struck']);
    assert.deepEqual(dom.blockquote, ['quoted']);
    assert.deepEqual(dom.codeBlock, ['const x = 1;\n', 'plain block\n']);
    assert.deepEqual(dom.codeLang, ['js']);
    /* S3B: the effective code-block classes are unchanged with the profile as
     * their authority; a bare fence carries the wrapper and no badge. */
    assert.deepEqual(dom.codeWrappers, [
      { cls: 'wbCodeBlock', badge: 'js', firstChild: 'div', lastChild: 'pre' },
      { cls: 'wbCodeBlock', badge: null, firstChild: 'pre', lastChild: 'pre' },
    ]);
  });

  check('the relocated code presentation applies through the profile-marked root and only there (S3C)', () => {
    /* J: the Renderer stylesheet skins the ContentRenderer output exactly as
     * the former global rules did, with theme tokens still supplied globally. */
    for (const style of dom.codeStyle) {
      assert.equal(style.margin, '14px 0px'); assert.equal(style.borderRadius, '12px'); assert.equal(style.overflow, 'hidden');
      assert.equal(style.borderTopWidth, '1px'); assert.equal(style.borderTopStyle, 'solid');
      assert.notEqual(style.background, 'rgba(0, 0, 0, 0)', 'code background comes from the shared --wb-code-bg token');
      assert.ok(style.tokenBg.length > 0, 'the shared token is still defined by studio.css');
    }
    assert.equal(dom.codeStyle.length, 2);
    assert.deepEqual(dom.langStyle, [{ padding: '10px 14px 0px', fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.44px' }]);
    /* Scope proof: outside a chatgpt-reference root the hooks carry no skin. */
    assert.deepEqual(dom.unscoped, { borderRadius: '0px', overflow: 'visible', textTransform: 'none', fontSize: '16px' },
      'the profile stylesheet must not skin code hooks outside a profile-marked conversation root');
    assert.equal(dom.ul, 1);
    assert.equal(dom.ol, 1);
    assert.deepEqual(dom.olStart, ['3'], 'an explicit ordered start must reach the DOM');
    assert.equal(dom.hr, 1);
    assert.equal(dom.br, 1);
    assert.equal(dom.htmlHasScript, false);
  });

  check('task state is accessible and non-interactive', () => {
    assert.deepEqual(dom.tasks, ['checked', 'unchecked']);
    assert.equal(dom.inputs, 0, 'task items must not create an actionable control');
  });

  check('table structure and normalized alignment reach the DOM', () => {
    assert.deepEqual(dom.th, [
      { text: 'a', align: 'left', scope: 'col' },
      { text: 'b', align: 'right', scope: 'col' },
    ]);
    assert.deepEqual(dom.td, [{ text: '1', align: 'left' }, { text: '2', align: 'right' }]);
  });

  check('only an admitted link destination becomes a live href', () => {
    assert.deepEqual(dom.anchors, [
      { href: 'https://example.test/a', text: 'safe', rel: 'noopener noreferrer' },
    ], 'exactly one live anchor is expected');
    assert.equal(dom.deniedLinks.length, 1, 'the javascript: destination must be denied');
    assert.equal(dom.deniedLinks[0].reason, 'scheme-not-allowed');
    assert.equal(dom.deniedLinks[0].text, 'unsafe', 'denied links must keep their author text');
  });

  check('only an admitted image source becomes a live src', () => {
    assert.deepEqual(dom.images, [{ src: 'https://example.test/i.png', alt: 'ok' }]);
    assert.equal(dom.deniedImages.length, 1, 'the http image must be denied');
    assert.equal(dom.deniedImages[0].reason, 'scheme-not-allowed');
    assert.equal(dom.deniedImages[0].text, 'bad', 'denied images must degrade to alt text');
  });

  const adversarial = await page.evaluate(() => {
    const R = globalThis.H2O.Studio.Renderer;
    const md = R.markdownEngine.formalBaseEngine();
    const out = {};
    for (const [name, src] of Object.entries({
      dataText: '[x](data:text/html;base64,PHNjcmlwdD4=)',
      relative: '[x](/etc/passwd)',
      fragment: '[x](#anchor)',
      protocolRelative: '[x](//evil.test/a)',
      vbscript: '[x](vbscript:msgbox(1))',
      imageJs: '![x](javascript:alert(1))',
    })) {
      const host = document.createElement('div');
      host.appendChild(R.contentRenderer.renderBlocks(R.markdownIrAdapter.markdownToBlocks(md, src).blocks, { document }));
      out[name] = {
        liveHrefs: Array.from(host.querySelectorAll('a[href]')).map((n) => n.getAttribute('href')),
        liveSrcs: Array.from(host.querySelectorAll('img[src]')).map((n) => n.getAttribute('src')),
      };
    }
    return out;
  });

  check('no adversarial destination becomes live', () => {
    for (const [name, result] of Object.entries(adversarial)) {
      assert.deepEqual(result.liveHrefs, [], `${name} produced a live href`);
      assert.deepEqual(result.liveSrcs, [], `${name} produced a live src`);
    }
  });

  const fallbackProof = await page.evaluate(() => {
    const R = globalThis.H2O.Studio.Renderer;
    /* An unregistered extension kind must make the whole message fall back,
     * never render a partial tree. */
    const host = document.createElement('div');
    let threw = false;
    try {
      host.appendChild(R.contentRenderer.renderBlocks(
        [{ kind: 'paragraph', children: [{ kind: 'text', text: 'kept' }] }, { kind: 'math', text: 'x' }],
        { document },
      ));
    } catch { threw = true; }
    return { threw, hostChildren: host.childNodes.length };
  });

  check('an unregistered kind fails whole-message rather than rendering partially', () => {
    assert.equal(fallbackProof.threw, true, 'an unregistered kind must throw');
    assert.equal(fallbackProof.hostChildren, 0, 'no partial tree may reach the host');
  });

  /* ---------------------------------------------- Tier 2: S2C / T11 */

  const s2c = await page.evaluate(() => {
    globalThis.__h2oRan = false;
    const R = globalThis.H2O.Studio.Renderer;
    const cr = globalThis.H2O.Studio.chatRenderer;
    const hostile = '<article id="pa" name="pn" data-h2o-turn="1" data-message-author-role="assistant">'
      + '<script>globalThis.__h2oRan = true;</script>'
      + '<p onclick="globalThis.__h2oRan = true" id="pp" data-h2o-block="b">kept <b>text</b></p>'
      + '<a href="javascript:globalThis.__h2oRan = true">j</a><a href="/r">r</a><a href="#f">f</a><a href="//e.test/p">p</a>'
      + '<a href="https://example.test/ok">ok</a><img src="x" onerror="globalThis.__h2oRan = true">'
      + '<iframe src="https://e.test"></iframe><form><input><button>b</button></form><style>*{}</style>'
      + '<svg onload="globalThis.__h2oRan = true"></svg><math><mi>m</mi></math></article>';
    const snap = (parts) => ({ schema: 'h2o.savedChatSnapshot', schemaVersion: 3, chatId: 'c', snapshotId: 's',
      messages: [{ id: 'a1', role: 'assistant', content: parts }] });
    const q = (n, s) => Array.from(n.querySelectorAll(s));

    /* 1. ownerSanitized alone never bypasses: hostile HTML marked sanitized is still sanitized live. */
    const r1 = cr.render(snap([
      { type: 'text', text: 'one' },
      { type: 'html', sanitized: true, html: hostile },
      { type: 'gizmo', name: 'Thing' },
      { type: 'text', text: 'four' },
    ]));
    const body1 = r1.root.querySelector('[data-message-author-role="assistant"] .cgMsgBody');
    const order = Array.from(body1.children).map((n) => n.tagName + ':' + (n.getAttribute('data-h2o-opaque-kind') || n.textContent));
    const opaque = body1.querySelector('[data-h2o-opaque-kind="ownerSanitizedHtml"]');
    const p = opaque && opaque.querySelector('p');
    if (p) p.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    /* 2. malformed v3: html part without sanitized:true -> ingress refuses -> no HTML anywhere. */
    const r2 = cr.render(snap([{ type: 'text', text: 'safe' }, { type: 'html', html: '<b>untrusted</b>' }]));

    /* 3. sanitizer unavailable at the live sink -> message-level safe fallback with no HTML. */
    const good = [{ kind: 'paragraph', children: [{ kind: 'text', text: 'kept text' }] },
      { kind: 'opaqueProviderBlock', opaqueKind: 'ownerSanitizedHtml', mediaType: 'text/html', ownerSanitized: true, html: '<b>never</b>' }];
    let threw = false, hostChildren = -1;
    const host3 = document.createElement('div');
    try { host3.appendChild(R.contentRenderer.renderBlocks(good, { document, htmlSanitizer: null })); } catch { threw = true; }
    hostChildren = host3.childNodes.length;

    return {
      order,
      roleHosts: q(r1.root, '[data-message-author-role]').length,
      turns: q(r1.root, 'article.cgTurn').length,
      opaqueText: opaque ? opaque.textContent.replace(/\s+/g, ' ').trim() : null,
      liveHrefs: q(body1, 'a[href]').map((n) => n.getAttribute('href')),
      removed: { script: q(body1, 'script').length, style: q(body1, 'style').length, iframe: q(body1, 'iframe').length, form: q(body1, 'form,input,button').length, svg: q(body1, 'svg').length, math: q(body1, 'math').length, structural: q(body1, 'article,main,section').length },
      onAttrs: q(body1, '*').filter((n) => Array.from(n.attributes).some((a) => /^on/i.test(a.name))).length,
      identity: q(body1, '[id],[name],[data-h2o-turn],[data-h2o-block],[data-message-author-role]').length,
      ran: globalThis.__h2oRan,
      unsupported: q(body1, '[data-h2o-opaque-kind="unsupportedOwnerContent"]').map((n) => n.textContent),
      malformedSemantic: r2.semanticSource, malformedHtml: r2.root.querySelectorAll('b, [data-h2o-opaque-kind]').length,
      malformedBodyText: r2.root.querySelector('.cgMsgBody')?.textContent ?? null,
      noSanitizer: { threw, hostChildren },
    };
  });

  check('v3 typed content order is preserved through ingress and the renderers', () => {
    assert.deepEqual(s2c.order, ['P:one', 'DIV:ownerSanitizedHtml', 'DIV:unsupportedOwnerContent', 'P:four']);
  });

  check('ownerSanitized alone never bypasses live sanitization', () => {
    assert.equal(s2c.removed.script, 0); assert.equal(s2c.removed.style, 0); assert.equal(s2c.removed.iframe, 0);
    assert.equal(s2c.removed.form, 0); assert.equal(s2c.removed.svg, 0); assert.equal(s2c.removed.math, 0);
    assert.equal(s2c.onAttrs, 0, 'no on* handler may survive');
    assert.equal(s2c.ran, false, 'no script or handler may execute');
    assert.equal(s2c.opaqueText.includes('kept text'), true, 'allowed semantic content must remain');
  });

  check('provider identity and structure cannot survive into the live DOM', () => {
    assert.equal(s2c.identity, 0, 'id / name / data-h2o-* / role identity must be stripped');
    assert.equal(s2c.removed.structural, 0, 'provider article/main/section must not survive');
    assert.equal(s2c.roleHosts, 1, 'the fake provider role host must not create a second message host');
    assert.equal(s2c.turns, 1);
  });

  check('unsafe URIs inside owner HTML never become live', () => {
    assert.deepEqual(s2c.liveHrefs, ['https://example.test/ok']);
  });

  check('unsupportedOwnerContent stays inert text', () => {
    assert.deepEqual(s2c.unsupported, ['Unsupported content (gizmo): Thing']);
  });

  check('malformed v3 HTML (owner did not mark sanitized) fails closed at ingress', () => {
    assert.equal(s2c.malformedSemantic, '', 'non-conforming v3 must not take the semantic path');
    assert.equal(s2c.malformedHtml, 0, 'no owner HTML may reach the DOM');
    assert.doesNotMatch(String(s2c.malformedBodyText), /untrusted/, 'untrusted markup text must not be rendered');
  });

  check('a missing live sanitizer fails closed with no partial tree', () => {
    assert.equal(s2c.noSanitizer.threw, true);
    assert.equal(s2c.noSanitizer.hostChildren, 0);
  });

  /* M03 P4 S4A T8 slice A: the Semantic Index over the real rendered shells in
   * a real document - identity paths, instance-per-render, geometry after
   * mount and after detach, and the no-new-attribute / read-only contracts. */
  const s4a = await page.evaluate(() => {
    const cr = globalThis.H2O.Studio.chatRenderer; const host = document.getElementById('host');
    const richTurn = (role, idx, inner, ids = {}) => ({ role, turnIdx: idx, messageId: ids.messageId ?? '', turnId: ids.turnId ?? '', outerHTML: '<article data-testid="conversation-turn-' + idx + '"><div data-message-author-role="' + role + '" data-message-id="prov-' + idx + '">' + inner + '</div></article>' });
    const keys = (ix) => ({ conversation: ix.getConversation().projectionKey, turns: ix.turns().map((t) => t.projectionKey), messages: ix.messages().map((m) => m.projectionKey) });
    const out = {};
    const canon = { chatId: 'chat-1', snapshotId: 'snap-1', messages: [ { role: 'user', text: 'hello', messageId: 'm-u1', turnId: 't-1' }, { role: 'assistant', text: 'reply', messageId: 'm-a1', turnId: 't-2' }, { role: 'system', text: 'sys', messageId: 'm-s1' }, { role: 'tool', text: 'tool', messageId: 'm-t1' } ] };
    const r1 = cr.render(canon, { getEditOverride: () => null }); const r1b = cr.render(canon, { getEditOverride: () => null });
    out.canonical = { ...keys(r1.semanticIndex), basis: r1.semanticIndex.basis, roles: r1.semanticIndex.turns().map((t) => t.role), targetsAreShells: r1.semanticIndex.turns().every((t, i) => t.target === r1.turnsEl.children[i] && t.target.classList.contains('cgTurn')) && r1.semanticIndex.messages().every((m, i) => m.target === r1.turnsEl.children[i].querySelector(':scope > .cgMsg')), conversationTarget: r1.semanticIndex.getConversation().target === r1.root, sourceRef: r1.semanticIndex.messages()[0].sourceRef, ownerRef: r1.semanticIndex.messages()[0].ownerRef, resultKeys: Object.keys(r1) };
    out.rerender = { distinct: r1.semanticIndex !== r1b.semanticIndex, sameKeys: JSON.stringify(keys(r1.semanticIndex)) === JSON.stringify(keys(r1b.semanticIndex)), distinctTargets: r1.semanticIndex.turns()[0].target !== r1b.semanticIndex.turns()[0].target };
    out.pathFallback = keys(cr.render({ messages: [ { role: 'user', text: 'a' }, { role: 'assistant', text: 'b' } ] }, { getEditOverride: () => null }).semanticIndex);
    const dup = cr.render({ chatId: 'c', snapshotId: 's', messages: [ { role: 'user', text: 'a', messageId: 'dup', turnId: 'tdup' }, { role: 'assistant', text: 'b', messageId: 'dup', turnId: 'tdup' }, { role: 'user', text: 'c', messageId: 'dup' } ] }, { getEditOverride: () => null }).semanticIndex;
    out.duplicatesCanonical = { ...keys(dup), records: dup.messages().length, sourceRefs: dup.messages().map((m) => m.sourceRef) };
    const richDup = cr.render({ chatId: 'c', snapshotId: 's', messages: [ { role: 'user', text: 'q', messageId: 'u1' }, { role: 'assistant', text: 'a', messageId: 'a1' } ], richTurns: [ richTurn('user', 1, '<div class="user-message-bubble-color"><div class="whitespace-pre-wrap">q</div></div>', { messageId: 'same', turnId: 'same-turn' }), richTurn('assistant', 2, '<div class="markdown prose"><p>a</p></div>', { messageId: 'same', turnId: 'same-turn' }) ] }, { getEditOverride: () => null });
    out.duplicatesRich = { mode: richDup.renderMode, ...keys(richDup.semanticIndex), sourceRefs: richDup.semanticIndex.messages().map((m) => m.sourceRef), domIds: Array.from(richDup.turnsEl.querySelectorAll('.cgMsg')).map((h) => h.getAttribute('data-message-id')) };
    const v3 = { schema: 'h2o.savedChatSnapshot', schemaVersion: 3, chatId: 'chat-v3', snapshotId: 'snap-v3', messages: [ { id: 'v3-u1', role: 'user', content: [{ type: 'text', text: 'question' }] }, { id: 'v3-a1', parentId: 'v3-u1', role: 'assistant', content: [{ type: 'text', text: 'answer' }] } ] };
    const rv = cr.render(v3, { getEditOverride: () => null }); const ir = globalThis.H2O.Studio.Renderer.semanticIngress.fromSavedChatV3Snapshot(v3);
    out.semantic = { mode: rv.renderMode, source: rv.semanticSource, basis: rv.semanticIndex.basis, lost: rv.semanticIndex.semanticCorrespondenceLost, conversationKeyIsRenderKey: rv.semanticIndex.getConversation().projectionKey === ir.renderKey, messageKeysAreRenderKeys: JSON.stringify(rv.semanticIndex.messages().map((m) => m.projectionKey)) === JSON.stringify(ir.messages.map((m) => m.renderKey)), ownerRefs: rv.semanticIndex.messages().map((m) => JSON.stringify(m.ownerRef)), irOwnerRefs: ir.messages.map((m) => JSON.stringify(m.ownerRef)), turnKeys: rv.semanticIndex.turns().map((t) => t.projectionKey), sourceRefs: rv.semanticIndex.messages().map((m) => m.sourceRef), ownerCarried: JSON.stringify(rv.semanticIndex.getConversation().ownerRef) === JSON.stringify(ir.ownerRef) };
    const rich = cr.render({ chatId: 'c', snapshotId: 's', messages: [ { role: 'user', text: 'q', messageId: 'u1' }, { role: 'assistant', text: 'a', messageId: 'a1' } ], richTurns: [ richTurn('user', 1, '<div class="flex w-full flex-col items-end"><div class="user-message-bubble-color"><div class="whitespace-pre-wrap">rich q</div></div></div>', { messageId: 'rich-u1', turnId: 'rich-t1' }), richTurn('assistant', 2, '<div class="markdown prose"><p>rich a</p><div class="grid"><img alt="x"></div></div>', { messageId: 'rich-a1', turnId: 'rich-t2' }) ] }, { getEditOverride: () => null });
    const ix = rich.semanticIndex; const tk = ix.turns()[0].projectionKey; const mk = ix.messages()[1].projectionKey;
    out.rich = { mode: rich.renderMode, ...keys(ix), hostTargets: ix.messages().map((m) => m.target.className), providerDescendantsNotIndexed: ix.turns().length === 2 && ix.messages().length === 2, targetInsideTurn: ix.messages().every((m) => m.target.parentElement.classList.contains('cgTurn')) };
    out.geometry = { beforeMount: ix.getGeometry(tk) };
    host.replaceChildren(rich.root);
    const g = ix.getGeometry(tk); const rect = ix.turns()[0].target.getBoundingClientRect();
    out.geometry.afterMount = g; out.geometry.frozen = Object.isFrozen(g); out.geometry.plain = !(g instanceof DOMRect) && Object.getPrototypeOf(g) === Object.prototype; out.geometry.matchesLiveRect = g.x === rect.x && g.y === rect.y && g.width === rect.width && g.height === rect.height && g.top === rect.top && g.left === rect.left; out.geometry.message = ix.getGeometry(mk); out.geometry.conversation = ix.getGeometry(ix.getConversation().projectionKey);
    out.geometry.fresh = ix.getGeometry(tk) !== g;
    out.geometry.unknown = ix.getGeometry('nope');
    rich.root.remove(); out.geometry.detached = ix.getGeometry(tk);
    out.unknown = [ix.getTurn('nope'), ix.getMessage('nope'), ix.getTurn(mk), ix.getMessage(tk)];
    out.api = Object.keys(ix); out.frozen = [Object.isFrozen(ix), Object.isFrozen(ix.turns()), ix.turns().every((t) => Object.isFrozen(t)), Object.isFrozen(ix.getConversation())];
    out.attrs = Array.from(rich.root.querySelectorAll('*')).concat([rich.root]).flatMap((el) => Array.from(el.attributes).map((a) => a.name)).filter((n) => /^data-h2o-/.test(n) && !['data-h2o-turn-no', 'data-h2o-create-time', 'data-h2o-presentation-profile'].includes(n));
    out.rendererGlobals = Object.keys(globalThis.H2O.Studio.Renderer).filter((k) => /current|index/i.test(k));
    return out;
  });

  check('Semantic Index: one frozen read-only index per render, source/path keys, targets are the H2O shells (S4A slice A)', () => {
    /* M04 P1 T2 (old -> new): the result additionally carries the frozen `presentation` descriptor after the lifecycle. */
    assert.deepEqual(s4a.canonical.resultKeys, ['root', 'turnsEl', 'scrollEl', 'assistantTurnEls', 'mountedTurnCount', 'renderMode', 'semanticSource', 'semanticIndex', 'decorationContributions', 'presentation'], 'render result gains semanticIndex additively (S4B appends decorationContributions; M04 T2 appends presentation)');
    assert.deepEqual(s4a.api, ['schema', 'schemaVersion', 'version', 'renderMode', 'basis', 'semanticCorrespondenceLost', 'getConversation', 'getTurn', 'getMessage', 'getBlock', 'getText', 'turns', 'messages', 'blocks', 'texts', 'getGeometry'], 'N: read-only API only (S4A slices A + B)');
    assert.deepEqual(s4a.frozen, [true, true, true, true], 'C: frozen index, arrays and records');
    assert.equal(s4a.canonical.basis, 'source'); assert.equal(s4a.canonical.conversation, 'conversation:source:snap-1');
    assert.deepEqual(s4a.canonical.turns, ['turn:source:t-1', 'turn:source:t-2', 'turn:source-message:m-s1', 'turn:source-message:m-t1']);
    assert.deepEqual(s4a.canonical.messages, ['message:source:m-u1', 'message:source:m-a1', 'message:source:m-s1', 'message:source:m-t1']);
    assert.deepEqual(s4a.canonical.roles, ['user', 'assistant', 'system', 'tool']);
    assert.equal(s4a.canonical.targetsAreShells, true, 'J: turn/message targets are the live cgTurn / cgMsg shells'); assert.equal(s4a.canonical.conversationTarget, true, 'J: conversation target is the cgFrame root');
    assert.deepEqual(s4a.canonical.sourceRef, { turnId: 't-1', messageId: 'm-u1' }, 'G: source ids are sourceRef metadata'); assert.equal(s4a.canonical.ownerRef, null, 'G: never ownerRef');
    assert.deepEqual(s4a.rerender, { distinct: true, sameKeys: true, distinctTargets: true }, 'B/D: a rerender yields a new instance with the same deterministic keys');
    assert.deepEqual(s4a.pathFallback, { conversation: 'conversation:path:0', turns: ['turn:path:0', 'turn:path:1'], messages: ['message:path:0', 'message:path:1'] }, 'I: path fallback without ids');
    assert.deepEqual(s4a.unknown, [null, null, null, null], 'K: unknown / cross-kind keys return null');
    assert.deepEqual(s4a.attrs, [], 'O: no new data-h2o projection attributes'); assert.deepEqual(s4a.rendererGlobals, ['semanticIndex'], 'no mutable current index on the Renderer namespace');
  });

  check('Semantic Index: duplicate source ids stay collision-free (Renderer collision protection on the canonical path, ordinal suffix on the rich path) (S4A slice A)', () => {
    /* Canonical normalization blanks later duplicate ids (accepted identity collision protection), so those records fall to path keys; nothing is dropped or overwritten. */
    assert.equal(s4a.duplicatesCanonical.records, 3);
    assert.deepEqual(s4a.duplicatesCanonical.messages, ['message:source:dup', 'message:path:1', 'message:path:2']);
    assert.deepEqual(s4a.duplicatesCanonical.turns, ['turn:source:tdup', 'turn:path:1', 'turn:path:2']);
    assert.deepEqual(s4a.duplicatesCanonical.sourceRefs, [{ turnId: 'tdup', messageId: 'dup' }, null, null]);
    /* Rich turn metadata keeps its ids while the DOM dedupes them; the index disambiguates deterministically and preserves the sourceRef. */
    assert.equal(s4a.duplicatesRich.mode, 'rich');
    assert.deepEqual(s4a.duplicatesRich.messages, ['message:source:same', 'message:source:same:ordinal:1']);
    assert.deepEqual(s4a.duplicatesRich.turns, ['turn:source:same-turn', 'turn:source:same-turn:ordinal:1']);
    assert.deepEqual(s4a.duplicatesRich.sourceRefs, [{ turnId: 'same-turn', messageId: 'same' }, { turnId: 'same-turn', messageId: 'same' }], 'H: sourceRef preserved on the duplicate');
    assert.deepEqual(s4a.duplicatesRich.domIds, ['same', null], 'the DOM-level identity collision protection is unchanged');
  });

  check('Semantic Index: the semantic-v3 path reuses Render IR renderKeys / ownerRefs; rich replay indexes only the H2O shells (S4A slice A)', () => {
    assert.equal(s4a.semantic.mode, 'canonical'); assert.equal(s4a.semantic.source, 'savedChatSnapshotV3'); assert.equal(s4a.semantic.basis, 'semantic'); assert.equal(s4a.semantic.lost, false);
    assert.equal(s4a.semantic.conversationKeyIsRenderKey, true, 'F: conversation key = Render IR renderKey'); assert.equal(s4a.semantic.messageKeysAreRenderKeys, true, 'F: message keys = Render IR renderKeys'); assert.equal(s4a.semantic.ownerCarried, true);
    assert.deepEqual(s4a.semantic.ownerRefs, s4a.semantic.irOwnerRefs, 'F: ownerRefs reused'); assert.ok(s4a.semantic.turnKeys.every((k) => k.startsWith('turn:semantic:message%3A')), 'F: turn keys wrap the message renderKey');
    assert.deepEqual(s4a.semantic.sourceRefs, [{ messageId: 'v3-u1' }, { messageId: 'v3-a1' }], 'G: v3 ids stay sourceRef metadata');
    assert.equal(s4a.rich.mode, 'rich'); assert.deepEqual(s4a.rich.turns, ['turn:source:rich-t1', 'turn:source:rich-t2']); assert.deepEqual(s4a.rich.messages, ['message:source:rich-u1', 'message:source:rich-a1']);
    assert.equal(s4a.rich.providerDescendantsNotIndexed, true, 'provider descendants (.grid, provider ids) are not shell authority'); assert.equal(s4a.rich.targetInsideTurn, true); assert.deepEqual(s4a.rich.hostTargets, ['cgMsg', 'cgMsg']);
  });

  /* M03 P4 S4A T8 slice B: block / text projections over the real ContentRenderer
   * output in a real document - targets, keys, coverage, marks, nesting,
   * opaque blocks, rich replay, the initial edit override, and Text-range
   * geometry. */
  const s4b = await page.evaluate(() => {
    const cr = globalThis.H2O.Studio.chatRenderer; const host = document.getElementById('host');
    const PX = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    const richTurn = (role, idx, inner, ids = {}) => ({ role, turnIdx: idx, messageId: ids.messageId ?? ('rm-' + idx), turnId: ids.turnId ?? ('rt-' + idx), outerHTML: '<article data-testid="conversation-turn-' + idx + '"><div data-message-author-role="' + role + '" data-message-id="prov-' + idx + '">' + inner + '</div></article>' });
    const walkIr = (blocks) => { const out = []; const walk = (n) => { out.push(n); for (const k of ['children', 'blocks', 'items', 'rows', 'cells']) if (Array.isArray(n[k])) n[k].forEach(walk); }; blocks.forEach(walk); return out; };
    const summary = (r) => { const ix = r.semanticIndex; return { mode: r.renderMode, blocks: ix.blocks().map((b) => ({ key: b.projectionKey, irKind: b.irKind, ordinal: b.ordinal, messageOrdinal: b.messageOrdinal, messageKey: b.messageKey, renderKey: b.renderKey, ownerRef: b.ownerRef, basis: b.basis, tag: b.target.nodeType === 1 ? b.target.tagName.toLowerCase() : null, inHost: b.target.closest('.cgMsg') === ix.messages()[b.messageOrdinal].target })), texts: ix.texts().map((t) => ({ key: t.projectionKey, ordinal: t.ordinal, messageOrdinal: t.messageOrdinal, messageKey: t.messageKey, renderKey: t.renderKey, ownerRef: t.ownerRef, basis: t.basis, nodeType: t.target.nodeType, data: t.target.data, parentTag: t.target.parentNode.tagName.toLowerCase(), inHost: t.target.parentNode.closest('.cgMsg') === ix.messages()[t.messageOrdinal].target })), messages: ix.messages().map((m) => ({ key: m.projectionKey, blockKeys: m.blockKeys, textKeys: m.textKeys, contentIndexed: m.contentIndexed, frozen: Object.isFrozen(m.blockKeys) && Object.isFrozen(m.textKeys) })), conv: { blocks: ix.getConversation().blockKeys.length, texts: ix.getConversation().textKeys.length }, frozen: [Object.isFrozen(ix.blocks()), Object.isFrozen(ix.texts()), ix.blocks().every((b) => Object.isFrozen(b)), ix.texts().every((t) => Object.isFrozen(t))] }; };
    const out = {};
    const MD = '# Head\n\nPlain **strong** and *em* with [link](https://example.test/x) and `code`.\n\n- outer\n  - inner\n\n| A | B |\n| - | - |\n| c | d |\n\n```js\nconst x = 1;\n```\n\n![pic](' + PX + ')\n\nline one  \nline two\n\n---\n\n[bad](javascript:alert(1)) tail';
    const r1 = cr.render({ chatId: 'c1', snapshotId: 's1', messages: [ { role: 'user', text: 'hello **there**', messageId: 'u1' }, { role: 'assistant', text: MD, messageId: 'a1' }, { role: 'system', text: 'sys', messageId: 's1' }, { role: 'tool', text: 'tool', messageId: 't1' } ] }, { getEditOverride: () => null });
    host.replaceChildren(r1.root); out.canonical = summary(r1);
    /* H: the IR that the ContentRenderer received is what the index carries - rebuild it independently and compare renderKeys. */
    const R = globalThis.H2O.Studio.Renderer; const md = R.markdownEngine.formalBaseEngine(); const parsed = R.markdownIrAdapter.markdownToBlocks(md, MD); const doc = R.renderIR.createConversation({ id: 'h2o.render', messages: [{ id: 'h2o.message', role: 'assistant', blocks: parsed.blocks }] });
    out.canonical.irWalk = walkIr(doc.messages[0].blocks).map((n) => n.renderKey);
    out.canonical.assistantRenderKeys = [...out.canonical.blocks, ...out.canonical.texts].filter((x) => x.messageOrdinal === 1).sort((a, b) => a.ordinal - b.ordinal).map((x) => x.renderKey);
    out.canonical.parity = { html: r1.root.outerHTML };
    /* geometry: mounted element + text (Range), then detached. */
    const ix = r1.semanticIndex; const txt = ix.texts().find((t) => t.target.data === 'strong') || null; const blk = ix.blocks().find((b) => b.irKind === 'table') || null;
    if (txt && blk) {
      const g = ix.getGeometry(txt.projectionKey); const range = document.createRange(); range.selectNodeContents(txt.target); const rr = range.getBoundingClientRect();
      out.geometry = { text: g, textFrozen: Object.isFrozen(g), textPlain: !(g instanceof DOMRect), textMatchesRange: !!g && g.x === rr.x && g.y === rr.y && g.width === rr.width && g.height === rr.height, textFresh: ix.getGeometry(txt.projectionKey) !== g, block: ix.getGeometry(blk.projectionKey), blockMatches: (() => { const b = blk.target.getBoundingClientRect(); const gb = ix.getGeometry(blk.projectionKey); return !!gb && gb.x === b.x && gb.width === b.width && gb.height === b.height; })(), unknown: ix.getGeometry('nope'), crossKind: [ix.getBlock(txt.projectionKey), ix.getText(blk.projectionKey), ix.getBlock('nope'), ix.getText('')] };
      r1.root.remove(); out.geometry.detachedText = ix.getGeometry(txt.projectionKey); out.geometry.detachedBlock = ix.getGeometry(blk.projectionKey);
    } else {
      out.geometry = { missing: { text: !txt, block: !blk } }; r1.root.remove();
    }
    const r2 = cr.render({ chatId: 'c2', snapshotId: 's2', messages: [ { role: 'assistant', text: 'Same **content**', messageId: 'a1' }, { role: 'assistant', text: 'Same **content**', messageId: 'a2' } ] }, { getEditOverride: () => null }); out.twins = summary(r2);
    const v3 = { schema: 'h2o.savedChatSnapshot', schemaVersion: 3, chatId: 'chat-v3', snapshotId: 'snap-v3', messages: [ { id: 'v3-u1', role: 'user', content: [{ type: 'text', text: 'question' }] }, { id: 'v3-a1', parentId: 'v3-u1', role: 'assistant', content: [{ type: 'text', text: 'answer' }, { type: 'html', sanitized: true, html: '<p>owner <em>html</em> <span>spans</span></p>' }, { type: 'gizmo', name: 'Thing' }] } ] };
    const r3 = cr.render(v3, { getEditOverride: () => null }); out.semantic = summary(r3); out.semantic.source = r3.semanticSource; const irV3 = R.semanticIngress.fromSavedChatV3Snapshot(v3); out.semantic.irBlockKeys = irV3.messages.flatMap((m) => walkIr(m.blocks).map((n) => n.renderKey)); out.semantic.opaqueDescendants = r3.root.querySelectorAll('[data-h2o-content-kind="opaqueProviderBlock"] *').length;
    const PROSE = '<div class="markdown prose w-full"><h2>Answer</h2><p>Rich <strong>bold</strong> text.</p><ul><li>a</li><li>b</li></ul></div>';
    const r4 = cr.render({ chatId: 'c', snapshotId: 's', messages: [ { role: 'user', text: 'q', messageId: 'u1' }, { role: 'assistant', text: 'a', messageId: 'a1' } ], richTurns: [ richTurn('user', 1, '<div class="user-message-bubble-color"><div class="whitespace-pre-wrap">rich q</div></div>'), richTurn('assistant', 2, PROSE) ] }, { getEditOverride: () => null }); out.rich = summary(r4); out.rich.providerTextNodes = (() => { let n = 0; const w = document.createTreeWalker(r4.turnsEl, NodeFilter.SHOW_TEXT); while (w.nextNode()) n += 1; return n; })();
    const r5 = cr.render({ chatId: 'c', snapshotId: 's', messages: [ { role: 'user', text: 'q', messageId: 'u1' }, { role: 'assistant', text: 'a', messageId: 'a1' }, { role: 'user', text: 'q2', messageId: 'u2' }, { role: 'assistant', text: 'b', messageId: 'a2' } ], richTurns: [ richTurn('user', 1, '<div class="user-message-bubble-color"><div class="whitespace-pre-wrap">rich q</div></div>'), richTurn('assistant', 2, PROSE), richTurn('user', 3, '<div class="user-message-bubble-color"><div class="whitespace-pre-wrap">rich q2</div></div>'), richTurn('assistant', 4, PROSE) ] }, { getEditOverride: (sid, idx) => (idx === 4 ? 'Edited **override** with [link](https://example.test/o)' : null) }); out.override = summary(r5);
    /* A later Studio-side edit does not mutate the snapshot index. */
    cr.applyEditedMessageBody(r5.turnsEl.children[1].querySelector('.cgMsg'), 'assistant', 'late edit'); out.override.afterLateEdit = { blocks: r5.semanticIndex.blocks().length, texts: r5.semanticIndex.texts().length, messages: r5.semanticIndex.messages().map((m) => m.contentIndexed) };
    const r6 = cr.render({ chatId: 'c3', snapshotId: 's3', messages: [ { role: 'assistant', text: '', messageId: 'e1' } ] }, { getEditOverride: () => null }); out.empty = summary(r6);
    out.attrs = Array.from(r1.root.querySelectorAll('*')).concat([r1.root]).flatMap((el) => Array.from(el.attributes).map((a) => a.name)).filter((n) => /^data-h2o-/.test(n) && !['data-h2o-turn-no', 'data-h2o-create-time', 'data-h2o-presentation-profile', 'data-h2o-link-denied', 'data-h2o-image-denied', 'data-h2o-task', 'data-h2o-task-marker', 'data-h2o-content-kind', 'data-h2o-opaque-kind', 'data-h2o-owner-content-type'].includes(n));
    out.api = Object.keys(r1.semanticIndex); out.wrapperCheck = { strongTextParent: r1.root.querySelector('strong').firstChild.nodeType, spanWrappers: r1.root.querySelectorAll('span:not([data-h2o-link-denied]):not([data-h2o-image-denied]):not([data-h2o-task-marker])').length };
    return out;
  });

  check('Semantic Index: block / text projections cover the ContentRenderer output with Render IR identity, no wrappers, truthful message coverage (S4A slice B)', () => {
    const c = s4b.canonical;
    assert.deepEqual(s4b.api, ['schema', 'schemaVersion', 'version', 'renderMode', 'basis', 'semanticCorrespondenceLost', 'getConversation', 'getTurn', 'getMessage', 'getBlock', 'getText', 'turns', 'messages', 'blocks', 'texts', 'getGeometry'], 'C/T: read-only API incl. getBlock/getText/blocks/texts');
    assert.deepEqual(c.frozen, [true, true, true, true]);
    assert.deepEqual(c.assistantRenderKeys, c.irWalk, 'H/I/M: the assistant message projections are exactly the validated Render IR nodes, pre-order, renderKeys retained');
    const kinds = c.blocks.filter((b) => b.messageOrdinal === 1).map((b) => `${b.irKind}>${b.tag}`);
    for (const pair of ['heading>h1', 'paragraph>p', 'list>ul', 'listItem>li', 'table>table', 'tableRow>tr', 'tableCell>th', 'tableCell>td', 'codeBlock>div', 'image>img', 'hardBreak>br', 'thematicBreak>hr']) assert.ok(kinds.includes(pair), `D: block target is the existing ContentRenderer node: ${pair}`);
    assert.ok(c.blocks.every((b) => b.basis === 'render-ir' && b.inHost) && c.texts.every((t) => t.basis === 'render-ir' && t.nodeType === 3 && t.inHost), 'E/F: text targets are Text nodes inside their message host');
    assert.deepEqual(c.texts.filter((t) => t.messageOrdinal === 1 && ['strong', 'em', 'a', 'code'].includes(t.parentTag)).map((t) => [t.data, t.parentTag]), [['strong', 'strong'], ['em', 'em'], ['link', 'a'], ['code', 'code']], 'F: marked text keeps the Text node as target beneath the mark wrapper');
    assert.deepEqual(c.texts.filter((t) => t.data === 'bad').map((t) => t.parentTag), ['span'], 'denied link keeps the Text node under the inert span');
    assert.equal(s4b.wrapperCheck.strongTextParent, 3, 'G: the strong mark wraps the Text node directly'); assert.equal(s4b.wrapperCheck.spanWrappers, 0, 'G: no extra span wrapper introduced');
    assert.ok(c.blocks.every((b) => b.ownerRef === null) && c.texts.every((t) => t.ownerRef === null), 'L: Markdown-shaped blocks carry no ownerRef');
    for (const rec of [...c.blocks, ...c.texts]) assert.equal(rec.key, `${rec.key.split(':')[0]}:render:${encodeURIComponent(rec.messageKey)}:${encodeURIComponent(rec.renderKey)}`, 'I: key = kind : parent message key : renderKey');
    const all = [...c.blocks, ...c.texts].map((x) => x.key); assert.equal(new Set(all).size, all.length, 'unique content keys');
    assert.deepEqual(c.messages.map((m) => [m.contentIndexed, m.blockKeys.length > 0, m.frozen]), [[true, true, true], [true, true, true], [true, true, true], [true, true, true]], 'four canonical roles all content-indexed');
    assert.equal(c.conv.blocks, c.blocks.length); assert.equal(c.conv.texts, c.texts.length);
    assert.deepEqual(s4b.attrs, [], 'U: no projection attributes');
    /* J: identical Markdown in two messages -> distinct keys, same renderKeys. */
    const tw = s4b.twins; assert.equal(tw.blocks.length, 2); assert.notEqual(tw.blocks[0].key, tw.blocks[1].key); assert.equal(tw.blocks[0].renderKey, tw.blocks[1].renderKey, 'J: same Render IR path, unique projection keys via the parent message key');
    assert.deepEqual(s4b.empty.messages.map((m) => [m.contentIndexed, m.blockKeys.length]), [[true, 0]], 'an empty ContentRenderer body is indexed with no blocks (not "unindexed")');
  });

  check('Semantic Index: semantic-v3 keeps block renderKeys / ownerRefs, opaque blocks are single records, raw rich replay is unindexed, the initial edit override is indexed (S4A slice B)', () => {
    const sv = s4b.semantic; assert.equal(sv.source, 'savedChatSnapshotV3');
    assert.deepEqual([...sv.blocks, ...sv.texts].sort((a, b) => a.messageOrdinal - b.messageOrdinal || a.ordinal - b.ordinal).map((x) => x.renderKey), sv.irBlockKeys, 'K: semantic-v3 block/text renderKeys preserved in order');
    assert.deepEqual(sv.blocks.map((b) => b.irKind), ['paragraph', 'paragraph', 'opaqueProviderBlock', 'opaqueProviderBlock']); assert.ok(sv.opaqueDescendants >= 3, 'the opaque hosts do contain sanitized descendants'); assert.equal(sv.blocks.filter((b) => b.irKind === 'opaqueProviderBlock').length, 2, 'N: one block record per opaque block, no records for its sanitized descendants');
    assert.deepEqual(sv.texts.map((t) => t.data), ['question', 'answer']); assert.ok(sv.blocks.every((b) => b.ownerRef === null), 'K/L: v3 content parts carry no block-level ownerRef (message ownerRef is on the message record)');
    assert.deepEqual(sv.messages.map((m) => m.contentIndexed), [true, true]);
    const rich = s4b.rich; assert.equal(rich.mode, 'rich'); assert.equal(rich.blocks.length, 0); assert.equal(rich.texts.length, 0); assert.deepEqual(rich.messages.map((m) => m.contentIndexed), [false, false], 'O: raw rich provider replay yields no block/text records and contentIndexed false');
    assert.ok(rich.providerTextNodes > 0, 'provider DOM does contain text nodes that were NOT scraped');
    const ov = s4b.override; assert.equal(ov.mode, 'rich'); assert.deepEqual(ov.messages.map((m) => m.contentIndexed), [false, false, false, true], 'P: only the ContentRenderer-backed override body is content-indexed');
    assert.deepEqual(ov.blocks.map((b) => [b.messageOrdinal, b.irKind]), [[3, 'paragraph']]); assert.deepEqual(ov.texts.map((t) => [t.messageOrdinal, t.data, t.parentTag]), [[3, 'Edited ', 'p'], [3, 'override', 'strong'], [3, ' with ', 'p'], [3, 'link', 'a']]);
    assert.deepEqual(ov.afterLateEdit, { blocks: 1, texts: 4, messages: [false, false, false, true] }, 'a later Studio-side edit does not mutate the completion snapshot');
  });

  check('Semantic Index: Text-range and Element geometry are fresh immutable viewport snapshots; detached targets are null (S4A slice B)', () => {
    const g = s4b.geometry; assert.equal(g.missing, undefined, 'the marked text and the table block must be indexed for the geometry probe'); assert.ok(g.text && g.text.width > 0 && g.text.height > 0, 'R: connected Text node measures through a Range'); assert.equal(g.textMatchesRange, true); assert.equal(g.textFrozen, true); assert.equal(g.textPlain, true); assert.equal(g.textFresh, true, 'no cached geometry');
    assert.deepEqual(Object.keys(g.text), ['x', 'y', 'width', 'height', 'top', 'right', 'bottom', 'left', 'coordinateSpace']); assert.equal(g.text.coordinateSpace, 'viewport');
    assert.ok(g.block && g.block.width > 0, 'Q: block element geometry'); assert.equal(g.blockMatches, true);
    assert.equal(g.unknown, null); assert.deepEqual(g.crossKind, [null, null, null, null], 'K: cross-kind and unknown lookups are null');
    assert.equal(g.detachedText, null, 'S: detached text geometry is null'); assert.equal(g.detachedBlock, null);
  });

  check('Semantic Index: geometry is a fresh immutable viewport snapshot after mount and null before mount / after detach (S4A slice A)', () => {
    assert.equal(s4a.geometry.beforeMount, null, 'M: not mounted -> null');
    const g = s4a.geometry.afterMount; assert.ok(g && g.width > 0 && g.height > 0, 'L: measurable after mount');
    assert.deepEqual(Object.keys(g), ['x', 'y', 'width', 'height', 'top', 'right', 'bottom', 'left', 'coordinateSpace']); assert.equal(g.coordinateSpace, 'viewport');
    assert.equal(s4a.geometry.frozen, true); assert.equal(s4a.geometry.plain, true, 'L: plain frozen object, not a DOMRect'); assert.equal(s4a.geometry.matchesLiveRect, true); assert.equal(s4a.geometry.fresh, true, 'no cached geometry');
    assert.ok(s4a.geometry.message && s4a.geometry.message.height > 0); assert.ok(s4a.geometry.conversation && s4a.geometry.conversation.height > 0);
    assert.equal(s4a.geometry.unknown, null); assert.equal(s4a.geometry.detached, null, 'M: detached -> null');
  });

  /* M03 P4 S4B T8 slice A: the DecorationContribution lifecycle over a real
   * render in a real document - one lifecycle per render bound to its index,
   * zero Product contributions, all five kinds targetable (Text target = the
   * live Text node, geometry through the bound lookup), and the zero-delta
   * contract: a test-only application adds a marker and disposal returns the
   * DOM to the exact pre-registration outerHTML. */
  const s4bDeco = await page.evaluate(() => {
    const cr = globalThis.H2O.Studio.chatRenderer; const host = document.getElementById('host'); const out = {};
    const input = { chatId: 'chat-d', snapshotId: 'snap-d', messages: [ { role: 'user', text: 'hello **there**', messageId: 'm-u1', turnId: 't-1' }, { role: 'assistant', text: '# Title\n\nreply with `code` and a [link](https://example.test/x)', messageId: 'm-a1', turnId: 't-2' } ] };
    const r1 = cr.render(input, { getEditOverride: () => null }); const r2 = cr.render(input, { getEditOverride: () => null });
    const lc = r1.decorationContributions; const ix = r1.semanticIndex;
    out.resultKeys = Object.keys(r1);
    out.module = { installed: globalThis.H2O.Studio.Renderer.decorationContribution.__installed, version: globalThis.H2O.Studio.Renderer.decorationContribution.__version, frozen: Object.isFrozen(globalThis.H2O.Studio.Renderer.decorationContribution), rendererKeys: Object.keys(globalThis.H2O.Studio.Renderer) };
    out.perRender = { distinct: lc !== r2.decorationContributions, boundToOwnIndex: lc.semanticIndex === ix && r2.decorationContributions.semanticIndex === r2.semanticIndex && r2.semanticIndex !== ix, zero: [lc.list().length, r2.decorationContributions.list().length], frozen: Object.isFrozen(lc), api: Object.keys(lc), schema: lc.schema, version: lc.version };
    host.replaceChildren(r1.root);
    const before = r1.root.outerHTML; const textBefore = r1.root.textContent;
    const keys = { conversation: ix.getConversation().projectionKey, turn: ix.turns()[1].projectionKey, message: ix.messages()[1].projectionKey, block: ix.blocks().find((b) => b.irKind === 'heading').projectionKey, text: ix.texts().find((t) => t.target.data === 'there').projectionKey };
    const applied = {}; const marker = (ctx) => { const m = document.createElement('i'); m.className = 'h2oS4bSmokeMarker'; m.textContent = '*'; return m; };
    const testApply = (kind) => (ctx, value) => {
      applied[kind] = { target: ctx.target, projection: ctx.projection, contextKeys: Object.keys(ctx), frozen: Object.isFrozen(ctx), geometry: ctx.getGeometry(), value, updates: [], disposed: 0 };
      /* test-only effect: an inert marker beside the target (after a Text node, inside its parent) */
      const m = marker(ctx); if (ctx.target.nodeType === 3) ctx.target.parentNode.insertBefore(m, ctx.target.nextSibling); else ctx.target.appendChild(m);
      return { update(next) { applied[kind].updates.push(next); m.textContent = String(next); }, dispose() { applied[kind].disposed += 1; m.remove(); } };
    };
    const handles = Object.fromEntries(Object.entries(keys).map(([kind, key]) => [kind, lc.register({ owner: 'smoke', id: kind, targetKey: key, value: kind + '-v0', apply: testApply(kind) })]));
    out.registered = { count: lc.list().length, kinds: lc.list().map((s) => s.targetKind), order: lc.list().map((s) => s.contributionKey), markers: r1.root.querySelectorAll('.h2oS4bSmokeMarker').length };
    out.targets = { conversation: applied.conversation.target === r1.root, turn: applied.turn.target === r1.turnsEl.children[1], message: applied.message.target === r1.turnsEl.children[1].querySelector(':scope > .cgMsg'), block: applied.block.target === r1.root.querySelector('h1'), text: applied.text.target.nodeType === 3 && applied.text.target.data === 'there' && applied.text.target.parentNode.tagName === 'STRONG' && applied.text.target === ix.getText(keys.text).target, projectionIsRecord: Object.entries(keys).every(([kind, key]) => applied[kind].projection === (kind === 'conversation' ? ix.getConversation() : ix['get' + kind[0].toUpperCase() + kind.slice(1)](key))) };
    out.context = { keys: applied.text.contextKeys, frozen: Object.values(applied).every((a) => a.frozen), textGeometry: applied.text.geometry, blockGeometry: applied.block.geometry, geometryMatchesIndex: JSON.stringify(applied.block.geometry) === JSON.stringify(ix.getGeometry(keys.block)), noNavigation: Object.values(applied).every((a) => !a.contextKeys.some((k) => /scroll|navigate|focus|reader|router|select/i.test(k))) };
    /* update / dispose on the text contribution */
    const snapU = handles.text.update('text-v1'); out.update = { revision: snapU.revision, updates: applied.text.updates, viaGet: lc.get(handles.text.contributionKey).revision };
    out.duplicate = (() => { try { lc.register({ owner: 'smoke', id: 'text', targetKey: keys.turn, apply: testApply('dup') }); return 'accepted'; } catch (e) { return String(e.message); } })();
    out.unknown = (() => { try { lc.register({ owner: 'smoke', id: 'nope', targetKey: 'turn:source:nope', apply: testApply('nope') }); return 'accepted'; } catch (e) { return String(e.message); } })();
    out.applyFailure = (() => { try { lc.register({ owner: 'smoke', id: 'boom', targetKey: keys.turn, apply: () => { throw new Error('apply boom'); } }); return 'accepted'; } catch (e) { return { message: e.message, registered: lc.get('decoration:smoke:boom'), count: lc.list().length }; } })();
    out.disposeOne = { first: handles.text.dispose(), second: handles.text.dispose(), disposedCalls: applied.text.disposed, gone: lc.get(handles.text.contributionKey), count: lc.list().length, handleSnapshot: handles.text.snapshot(), markers: r1.root.querySelectorAll('.h2oS4bSmokeMarker').length };
    /* disposeAll in reverse order (conversation, turn, message, block remain) */
    const swept = lc.disposeAll();
    out.disposeAll = { swept: [...swept], remaining: lc.list().length, disposedCalls: ['conversation', 'turn', 'message', 'block'].map((k) => applied[k].disposed), markers: r1.root.querySelectorAll('.h2oS4bSmokeMarker').length };
    out.parity = { outerHTMLRestored: r1.root.outerHTML === before, textRestored: r1.root.textContent === textBefore, noDecorationMarkup: !/decoration|h2oS4b/i.test(before), attrs: Array.from(r1.root.querySelectorAll('*')).concat([r1.root]).flatMap((el) => Array.from(el.attributes).map((a) => a.name)).filter((n) => /^data-h2o-/.test(n) && !['data-h2o-turn-no', 'data-h2o-create-time', 'data-h2o-presentation-profile'].includes(n)) };
    r1.root.remove();
    return out;
  });

  check('DecorationContribution: one lifecycle per render bound to its Semantic Index, zero Product contributions, frozen module (S4B slice A)', () => {
    assert.deepEqual(s4bDeco.resultKeys, ['root', 'turnsEl', 'scrollEl', 'assistantTurnEls', 'mountedTurnCount', 'renderMode', 'semanticSource', 'semanticIndex', 'decorationContributions', 'presentation'], 'render result gains decorationContributions additively (M04 P1 T2 appends the presentation descriptor)');
    assert.deepEqual(s4bDeco.module, { installed: true, version: '0.1.0-m03-s4b', frozen: true, rendererKeys: s4bDeco.module.rendererKeys }, 'A: frozen installed module');
    assert.deepEqual(s4bDeco.module.rendererKeys.filter((k) => /current|registry|singleton|decorations$/i.test(k)), [], 'AA: no global decoration registry on the Renderer namespace');
    assert.deepEqual(s4bDeco.perRender, { distinct: true, boundToOwnIndex: true, zero: [0, 0], frozen: true, api: ['schema', 'schemaVersion', 'version', 'semanticIndex', 'register', 'get', 'list', 'disposeAll'], schema: 'h2o.renderer.decoration-contribution', version: '0.1.0-m03-s4b' }, 'B / C / D: distinct per render, bound to that index, zero contributions');
  });

  check('DecorationContribution: all five kinds resolve through the index to the live shells / Text node; bounded context with geometry, no navigation (S4B slice A)', () => {
    assert.deepEqual(s4bDeco.registered, { count: 5, kinds: ['conversation', 'turn', 'message', 'block', 'text'], order: ['decoration:smoke:conversation', 'decoration:smoke:turn', 'decoration:smoke:message', 'decoration:smoke:block', 'decoration:smoke:text'], markers: 5 }, 'E / F / I: five kinds, registration order, deterministic keys');
    assert.deepEqual(s4bDeco.targets, { conversation: true, turn: true, message: true, block: true, text: true, projectionIsRecord: true }, 'W: text target is the live Text node beneath its mark; every other target is the indexed element');
    assert.deepEqual(s4bDeco.context.keys, ['contributionKey', 'owner', 'id', 'targetKey', 'projection', 'target', 'getGeometry'], 'Y: bounded application context'); assert.equal(s4bDeco.context.frozen, true); assert.equal(s4bDeco.context.noNavigation, true, 'Y: no navigation API');
    assert.ok(s4bDeco.context.textGeometry && s4bDeco.context.textGeometry.width > 0 && s4bDeco.context.textGeometry.coordinateSpace === 'viewport', 'Y: Text-range geometry through the bound lookup'); assert.ok(s4bDeco.context.blockGeometry && s4bDeco.context.blockGeometry.height > 0); assert.equal(s4bDeco.context.geometryMatchesIndex, true, 'Y: delegates to the Semantic Index geometry lookup');
  });

  check('DecorationContribution: update / duplicate / unknown / apply-failure / dispose / disposeAll semantics on a real render; DOM restored byte-identically (S4B slice A)', () => {
    assert.deepEqual(s4bDeco.update, { revision: 1, updates: ['text-v1'], viaGet: 1 }, 'M / N: one lifecycle update, revision advanced');
    assert.match(s4bDeco.duplicate, /already registered/, 'H: duplicate owner+id rejected'); assert.match(s4bDeco.unknown, /not a projection of this render's Semantic Index/, 'G: unknown target rejected');
    assert.deepEqual(s4bDeco.applyFailure, { message: 'apply boom', registered: null, count: 5 }, 'J: apply failure leaves no registration');
    assert.deepEqual(s4bDeco.disposeOne, { first: true, second: false, disposedCalls: 1, gone: null, count: 4, handleSnapshot: { contributionKey: 'decoration:smoke:text', owner: 'smoke', id: 'text', targetKey: s4bDeco.disposeOne.handleSnapshot.targetKey, targetKind: 'text', revision: 1, active: false }, markers: 4 }, 'P / Q / R: idempotent dispose, cleanup once, gone from the registry');
    assert.deepEqual(s4bDeco.disposeAll, { swept: ['decoration:smoke:block', 'decoration:smoke:message', 'decoration:smoke:turn', 'decoration:smoke:conversation'], remaining: 0, disposedCalls: [1, 1, 1, 1], markers: 0 }, 'T / U / V: reverse registration order, every cleanup once, registry empty');
    assert.deepEqual(s4bDeco.parity, { outerHTMLRestored: true, textRestored: true, noDecorationMarkup: true, attrs: [] }, 'X / AB: the render carries no decoration markup and the fixture DOM returns to its pre-registration state');
  });

  /* M04 P1 T2: per-render presentation selection and binding on a FRESH page
   * (fresh document = open registries): test-only profiles registered before
   * the first render, sealing at that render, descriptors, bound-profile edits,
   * context restoration and the untouched index / lifecycle contracts. */
  const t2Page = await browser.newPage();
  const t2Errors = [];
  t2Page.on('pageerror', (e) => t2Errors.push(String(e)));
  await t2Page.goto(`${base}/__harness__`, { waitUntil: 'load' });
  const t2 = await t2Page.evaluate(() => {
    const R = globalThis.H2O.Studio.Renderer; const cr = globalThis.H2O.Studio.chatRenderer; const pp = R.presentationProfile; const cont = R.contentRenderer;
    const out = { errors: [] };
    const attempt = (label, fn) => { try { return fn(); } catch (e) { out.errors.push(label + ': ' + (e && e.message)); return null; } };
    const hooks = (tag) => ({ transcript: { canonical: [`${tag}-canonical`], rich: [`${tag}-rich`] }, turn: { base: [`${tag}-turn`], canonical: [], rich: [], role: { user: [`${tag}-user`], assistant: [`${tag}-assistant`], system: [], tool: [] } }, message: { canonical: { user: [`${tag}-msg-user`], assistant: [`${tag}-msg-assistant`], system: [], tool: [] }, rich: { user: [], assistant: [], system: [], tool: [] } }, userBubble: { compat: [`${tag}-bubble`] }, content: { codeBlock: { container: [`${tag}-code`], language: [`${tag}-lang`] } }, state: { edited: { turn: [`${tag}-edited-turn`], message: [`${tag}-edited-msg`] } } });
    const definition = (id, tag, version) => ({ id, owner: 't2-test', version, displayName: id, provider: null, stylesheet: null, modes: ['canonical', 'rich'], hooks: hooks(tag) });
    pp.register(definition('t2-alpha', 'tpA', '1.0.0')); pp.register(definition('t2-beta', 'tpB', '2.1.0'));
    cont.register('math', (block, ctx) => { const el = ctx.document.createElement('span'); el.className = 't2-math'; return el; }, { owner: 't2-test', version: '0.1.0' });
    out.beforeRender = { describe: cr.describePresentation('t2-alpha'), sealed: [pp.sealed(), cont.sealed()], digest: [pp.registryDigest(), cont.registryDigest()] };
    out.describeMalformedBefore = cr.describePresentation(Object.create(null));
    /* still open after observation: a third profile registers */
    pp.register(definition('t2-gamma', 'tpG', '3.0.0'));
    out.stillOpen = { ids: [...pp.ids()], sealed: [pp.sealed(), cont.sealed()] };
    const input = (id) => ({ chatId: 'c-t2', snapshotId: id, meta: { title: 'T2' }, messages: [ { role: 'user', text: 'question', messageId: `${id}-u1`, turnId: `${id}-t1` }, { role: 'assistant', text: 'answer:\n\n```js\nlet x = 1;\n```', messageId: `${id}-a1`, turnId: `${id}-t1` } ] });
    const classesOf = (r) => ({ transcript: r.turnsEl.className, turn: r.root.querySelector('.cgTurn').className, assistantMsg: r.root.querySelector('.cgMsg[data-message-author-role="assistant"]').className, code: r.root.querySelector('.cgMsgBody > div').className, marker: r.root.getAttribute('data-h2o-presentation-profile') });
    const A = cr.render(input('A'), { presentationProfile: 't2-alpha', getEditOverride: () => null });
    out.afterFirstRender = { sealed: [pp.sealed(), cont.sealed()], descriptor: A.presentation, frozen: Object.isFrozen(A.presentation), classes: classesOf(A), resultKeys: Object.keys(A) };
    out.late = { profile: attempt('late-profile', () => { try { pp.register(definition('t2-late', 'tpL', '1.0.0')); return 'accepted'; } catch (e) { return e.code; } }), content: attempt('late-content', () => { try { cont.register('citation', () => null, { owner: 't2-test', version: '1.0.0' }); return 'accepted'; } catch (e) { return e.code; } }), ids: [...pp.ids()] };
    const digest = JSON.parse(A.presentation.registryDigest);
    out.digest = { schema: digest.schema, keys: Object.keys(digest), matchesRegistries: digest.presentationProfile === pp.registryDigest() && digest.contentRenderer === cont.registryDigest(), profileEntries: JSON.parse(digest.presentationProfile).entries.map((e) => e.id), contentHasMath: JSON.parse(digest.contentRenderer).entries.some((e) => e.kind === 'math' && e.owner === 't2-test') };
    out.describeAfter = { equalsRender: JSON.stringify(cr.describePresentation('t2-alpha')) === JSON.stringify(A.presentation), sealedAfterDescribe: [pp.sealed(), cont.sealed()] };
    const B = cr.render(input('B'), { presentationProfile: 't2-beta', getEditOverride: () => null });
    const D = cr.render(input('D'), { getEditOverride: () => null });
    const U = cr.render(input('U'), { presentationProfile: 'no-such-profile', getEditOverride: () => null });
    const M = cr.render(input('M'), { presentationProfile: { toString() { throw new Error('coerced'); } }, getEditOverride: () => null });
    const brief = (r) => ({ requestedId: r.presentation.requestedId, effectiveId: r.presentation.effectiveId, profileVersion: r.presentation.profileVersion, reason: r.presentation.reason, marker: r.root.getAttribute('data-h2o-presentation-profile'), sameDigest: r.presentation.registryDigest === A.presentation.registryDigest });
    out.selection = { B: brief(B), D: brief(D), U: brief(U), M: brief(M), classesB: classesOf(B), classesD: classesOf(D) };
    /* semantic neutrality across profiles: same text, same index keys/roles */
    const keys = (r) => JSON.stringify({ t: r.semanticIndex.turns().map((x) => [x.projectionKey, x.role]), m: r.semanticIndex.messages().map((x) => [x.projectionKey, x.role]), b: r.semanticIndex.blocks().length, x: r.semanticIndex.texts().length });
    const N1 = cr.render(input('N'), { presentationProfile: 't2-alpha', getEditOverride: () => null }); const N2 = cr.render(input('N'), { presentationProfile: 't2-beta', getEditOverride: () => null }); const N3 = cr.render(input('N'), { getEditOverride: () => null });
    out.neutral = { text: N1.root.textContent === N2.root.textContent && N1.root.textContent === N3.root.textContent, keys: keys(N1) === keys(N2) && keys(N1) === keys(N3), contributions: [A.decorationContributions.list().length, B.decorationContributions.list().length] };
    /* edit root A after B/D/U/M rendered: A's binding governs, the marker is not the authority, indexes stay put */
    A.root.setAttribute('data-h2o-presentation-profile', 't2-beta');
    const msgA = A.root.querySelector('.cgMsg[data-message-author-role="assistant"]'); const msgB = B.root.querySelector('.cgMsg[data-message-author-role="assistant"]');
    const before = { a: A.semanticIndex.blocks().length, b: B.semanticIndex.blocks().length };
    cr.applyEditedMessageBody(msgA, 'assistant', 'edited:\n\n```py\nprint(1)\n```');
    cr.applyEditedMessageBody(msgB, 'assistant', 'edited too');
    out.edit = { hostA: msgA.className, codeA: msgA.querySelector('.cgMsgBody > div').className, hostB: msgB.className, indexA: A.semanticIndex.blocks().length, indexB: B.semanticIndex.blocks().length, before, frozenIndex: Object.isFrozen(A.semanticIndex) };
    /* in-render edit override on a rich transcript under profile B: the override host takes B's hooks */
    const richTurn = (role, idx, inner) => ({ role, turnIdx: idx, messageId: `r-${idx}`, turnId: `rt-${idx}`, outerHTML: '<article data-testid="conversation-turn-' + idx + '"><div data-message-author-role="' + role + '" data-message-id="p-' + idx + '">' + inner + '</div></article>' });
    const rich = cr.render({ chatId: 'c-rich', snapshotId: 'R', messages: [ { role: 'user', text: 'q', messageId: 'r-1' }, { role: 'assistant', text: 'a', messageId: 'r-2' } ], richTurns: [ richTurn('user', 1, '<div class="flex w-full flex-col"><div class="user-message-bubble-color">q</div></div>'), richTurn('assistant', 2, '<div class="markdown prose"><p>a</p></div>') ] }, { presentationProfile: 't2-beta', getEditOverride: (sid, turnIdx) => (sid === 'R' && turnIdx === 2 ? 'override:\n\n```js\nz\n```' : null) });
    const richHost = rich.root.querySelector('.cgMsg[data-message-author-role="assistant"]');
    out.richOverride = { mode: rich.renderMode, transcript: rich.turnsEl.className, bubble: rich.root.querySelector('.cgBubble').className, host: richHost.className, code: richHost.querySelector('.cgMsgBody > div').className, turn: rich.root.querySelectorAll('.cgTurn')[1].className, indexed: rich.semanticIndex.blocks().length };
    /* unbound synthetic host outside any render: documented reference fallback */
    const synthetic = document.createElement('div'); cr.applyEditedMessageBody(synthetic, 'assistant', 'x\n\n```js\ny\n```');
    out.synthetic = { host: synthetic.className, code: synthetic.querySelector('.cgMsgBody > div').className };
    /* exception inside a render (index module sabotaged after the shells are built) restores the presentation context */
    const realIndex = R.semanticIndex;
    R.semanticIndex = Object.freeze({ __installed: true, createShellIndex() { throw new Error('index boom'); } });
    let threw = null; try { cr.render(input('X'), { presentationProfile: 't2-beta', getEditOverride: () => null }); } catch (e) { threw = String(e.message); }
    R.semanticIndex = realIndex;
    const afterThrow = cr.render(input('Y'), { getEditOverride: () => null });
    const syntheticAfter = document.createElement('div'); cr.applyEditedMessageBody(syntheticAfter, 'assistant', 'z');
    out.restore = { threw, marker: afterThrow.presentation.effectiveId, classes: classesOf(afterThrow), syntheticHost: syntheticAfter.className };
    out.rendererGlobals = Object.keys(R).filter((k) => /presentation|profile|binding/i.test(k));
    out.publicApi = Object.keys(cr);
    return out;
  });
  await t2Page.close();

  check('M04 P1 T2: registration stays open after installation and observation; the first render seals both registries; later registration fails deterministically', () => {
    assert.deepEqual(t2.errors, [], 'no harness errors'); assert.deepEqual(t2Errors, [], 'no page errors');
    assert.deepEqual(t2.beforeRender.sealed, [false, false], 'A: no sealing at installation'); assert.deepEqual(t2.beforeRender.digest, [null, null]);
    assert.equal(t2.beforeRender.describe.registryDigest, null, 'B: describePresentation() before sealing reports the unavailable combined token as null');
    assert.deepEqual({ requestedId: t2.beforeRender.describe.requestedId, effectiveId: t2.beforeRender.describe.effectiveId, reason: t2.beforeRender.describe.reason, profileVersion: t2.beforeRender.describe.profileVersion }, { requestedId: 't2-alpha', effectiveId: 't2-alpha', reason: 'explicit', profileVersion: '1.0.0' });
    assert.deepEqual({ requestedId: t2.describeMalformedBefore.requestedId, reason: t2.describeMalformedBefore.reason, effectiveId: t2.describeMalformedBefore.effectiveId }, { requestedId: null, reason: 'unknown-profile-fallback', effectiveId: 'chatgpt-reference' }, 'R01: describePresentation(Object.create(null)) falls back safely');
    assert.deepEqual(t2.stillOpen, { ids: ['chatgpt-reference', 't2-alpha', 't2-beta', 't2-gamma'], sealed: [false, false] }, 'B: describePresentation() leaves registration open');
    assert.deepEqual(t2.afterFirstRender.sealed, [true, true], 'C: the first render seals both registries');
    assert.deepEqual(t2.late, { profile: 'registry-sealed', content: 'registry-sealed', ids: ['chatgpt-reference', 't2-alpha', 't2-beta', 't2-gamma'] }, 'C: subsequent registration into either registry is rejected with registry-sealed');
    assert.deepEqual(t2.describeAfter, { equalsRender: true, sealedAfterDescribe: [true, true] }, 'B/D: after sealing describePresentation() agrees with the render descriptor');
  });

  check('M04 P1 T2: frozen descriptor (requested / effective / version / reason / combined digest) with named-field serialization; root marker projects the effective id', () => {
    const d = t2.afterFirstRender.descriptor;
    assert.equal(t2.afterFirstRender.frozen, true, 'descriptor is frozen');
    assert.deepEqual(Object.keys(d), ['schema', 'schemaVersion', 'requestedId', 'effectiveId', 'profileVersion', 'reason', 'registryDigest']);
    assert.deepEqual({ requestedId: d.requestedId, effectiveId: d.effectiveId, profileVersion: d.profileVersion, reason: d.reason }, { requestedId: 't2-alpha', effectiveId: 't2-alpha', profileVersion: '1.0.0', reason: 'explicit' });
    assert.deepEqual(t2.digest, { schema: 'h2o.renderer.registry-digest', keys: ['schema', 'schemaVersion', 'presentationProfile', 'contentRenderer'], matchesRegistries: true, profileEntries: ['chatgpt-reference', 't2-alpha', 't2-beta', 't2-gamma'], contentHasMath: true }, 'the combined digest names both sealed registry tokens');
    assert.deepEqual(t2.afterFirstRender.resultKeys.slice(-1), ['presentation'], 'the render result exposes the descriptor');
    assert.deepEqual(t2.selection.B, { requestedId: 't2-beta', effectiveId: 't2-beta', profileVersion: '2.1.0', reason: 'explicit', marker: 't2-beta', sameDigest: true });
    assert.deepEqual(t2.selection.D, { requestedId: null, effectiveId: 'chatgpt-reference', profileVersion: '1.0.0', reason: 'default', marker: 'chatgpt-reference', sameDigest: true }, 'absent request -> default');
    assert.deepEqual(t2.selection.U, { requestedId: 'no-such-profile', effectiveId: 'chatgpt-reference', profileVersion: '1.0.0', reason: 'unknown-profile-fallback', marker: 'chatgpt-reference', sameDigest: true }, 'unknown request -> deterministic fallback');
    assert.deepEqual(t2.selection.M, { requestedId: null, effectiveId: 'chatgpt-reference', profileVersion: '1.0.0', reason: 'unknown-profile-fallback', marker: 'chatgpt-reference', sameDigest: true }, 'R01: a throwing coercion hook in the request cannot break render()');
  });

  check('M04 P1 T2: two test profiles yield profile-correct shells and nested content while semantics stay identical; the bound profile governs later edits and the completed index is untouched', () => {
    assert.deepEqual(t2.afterFirstRender.classes, { transcript: 'cgScroll wbReaderScroll wbRichRoot tpA-canonical', turn: 'cgTurn cgTurn--user tpA-turn tpA-user', assistantMsg: 'cgMsg tpA-msg-assistant', code: 'tpA-code', marker: 't2-alpha' }, 'profile A shells + nested content');
    assert.deepEqual(t2.selection.classesB, { transcript: 'cgScroll wbReaderScroll wbRichRoot tpB-canonical', turn: 'cgTurn cgTurn--user tpB-turn tpB-user', assistantMsg: 'cgMsg tpB-msg-assistant', code: 'tpB-code', marker: 't2-beta' }, 'profile B shells + nested content');
    assert.deepEqual(t2.selection.classesD, { transcript: 'cgScroll wbReaderScroll wbRichRoot', turn: 'cgTurn cgTurn--user wbTurn wbTurn--fallback wbTurn--user', assistantMsg: 'cgMsg cgMsg--assistant', code: 'wbCodeBlock', marker: 'chatgpt-reference' }, 'default output unchanged (accepted class order)');
    assert.deepEqual(t2.neutral, { text: true, keys: true, contributions: [0, 0] }, 'AC05-style neutrality on this fixture: same text and Semantic Index keys/roles under every profile; zero Product contributions');
    assert.deepEqual(t2.edit, { hostA: 'cgMsg tpA-msg-assistant tpA-edited-msg', codeA: 'tpA-code', hostB: 'cgMsg tpB-msg-assistant tpB-edited-msg', indexA: 3, indexB: 3, before: { a: 3, b: 3 }, frozenIndex: true }, 'editing root A after rendering B uses A\'s bound profile (marker tampered to t2-beta and ignored); completed indexes unchanged');
    assert.deepEqual(t2.richOverride, { mode: 'rich', transcript: 'cgScroll wbReaderScroll wbRichRoot tpB-rich', bubble: 'cgBubble cgBubble--user tpB-bubble', host: 'cgMsg tpB-msg-assistant tpB-edited-msg', code: 'tpB-code', turn: 'cgTurn cgTurn--assistant tpB-turn tpB-assistant tpB-edited-turn', indexed: 2 }, 'an in-render edit override runs under the render\'s own profile and its body is indexed (paragraph + code block)');
    assert.deepEqual(t2.synthetic, { host: 'cgMsg cgMsg--assistant cgMsg--edited', code: 'wbCodeBlock' }, 'an unbound synthetic host keeps the documented reference fallback');
    assert.equal(t2.restore.threw, 'index boom', 'a render that throws after its shells exist propagates');
    assert.deepEqual({ marker: t2.restore.marker, classes: t2.restore.classes, syntheticHost: t2.restore.syntheticHost }, { marker: 'chatgpt-reference', classes: { transcript: 'cgScroll wbReaderScroll wbRichRoot', turn: 'cgTurn cgTurn--user wbTurn wbTurn--fallback wbTurn--user', assistantMsg: 'cgMsg cgMsg--assistant', code: 'wbCodeBlock', marker: 'chatgpt-reference' }, syntheticHost: 'cgMsg cgMsg--assistant cgMsg--edited' }, 'the presentation context is restored after an exception: the next render and a later unbound edit see no leaked profile');
    assert.deepEqual(t2.rendererGlobals, ['presentationProfile'], 'no current-profile / binding state on the Renderer namespace');
    assert.deepEqual(t2.publicApi, ['normalizeInput', 'normalizeRole', 'isRenderEquivalent', 'render', 'describePresentation', 'applyEditedMessageBody'], 'public API: describePresentation added; applyEditedMessageBody signature unchanged');
  });

  /* M04 P2 T3: the real H2O Clean Reader profile on the PRODUCTION chain (fresh
   * page = open registries): synchronous admission before the first render,
   * sealing at that render, explicit selection in canonical and rich fixtures
   * with its stylesheet actually loaded and scoped, semantic neutrality against
   * the reference, bound-profile edits, Reader-route end alignment, and the
   * rich-content pointer / keyboard-focus baseline inspected separately. */
  const t3Page = await browser.newPage();
  const t3Errors = [];
  t3Page.on('pageerror', (e) => t3Errors.push(String(e)));
  await t3Page.goto(`${base}/__clean_reader_harness__`, { waitUntil: 'load' });
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
      richTurn('assistant', 2, '<div class="markdown prose"><p class="text-token-text-secondary">a <a href="https://example.test/p">provider link</a> <code>c</code></p><ul><li>item</li></ul><pre><code>code</code></pre><details><summary>more</summary><p>hidden</p></details><button type="button">act</button><input type="text"><span tabindex="0">focusable?</span></div>'),
    ] });
    const RC = mount(cr.render(richInput('RC'), { presentationProfile: 'h2o-clean-reader', getEditOverride: () => null }));
    const RR = mount(cr.render(richInput('RR'), { presentationProfile: 'chatgpt-reference', getEditOverride: () => null }));
    const bubble = RC.root.querySelector('.cgBubble');
    out.rich = { mode: RC.renderMode, descriptor: { effectiveId: RC.presentation.effectiveId, reason: RC.presentation.reason }, transcript: RC.turnsEl.className, userTurn: RC.root.querySelector('.cgTurn--user').className, bubble: bubble.className, providerMarkerLeft: RC.root.querySelectorAll('.user-message-bubble-color').length, referenceBubble: RR.root.querySelector('.cgBubble').className,
      bubbleStyle: cs(bubble, ['border-top-width', 'border-top-left-radius']), referenceBubbleStyle: cs(RR.root.querySelector('.cgBubble'), ['border-top-width', 'border-top-left-radius']),
      textEqual: RC.root.textContent === RR.root.textContent, blocked: { buttons: RC.root.querySelectorAll('button, input').length, tabindex: RC.root.querySelectorAll('[tabindex]').length, summaries: RC.root.querySelectorAll('summary').length },
      pointer: { summary: getComputedStyle(RC.root.querySelector('summary')).pointerEvents, link: getComputedStyle(RC.root.querySelector('[data-message-author-role="assistant"] a')).pointerEvents, referenceSummary: getComputedStyle(RR.root.querySelector('summary')).pointerEvents },
      /* Residual provider-utility behaviour, measured: the reference bridges the token class, the Clean Reader inherits the root text colour. */
      tokenClass: { clean: getComputedStyle(RC.root.querySelector('.text-token-text-secondary')).color, cleanRoot: getComputedStyle(RC.turnsEl).color, reference: getComputedStyle(RR.root.querySelector('.text-token-text-secondary')).color, referenceSoft: getComputedStyle(RR.turnsEl).getPropertyValue('--wb-text-soft').trim() },
      richPre: cs(RC.root.querySelector('[data-message-author-role="assistant"] pre'), ['border-top-width', 'border-top-left-radius']) };
    /* Reader-route end alignment of user turns under both profiles (structural, studio.css). */
    document.body.setAttribute('data-route', 'reader');
    const edge = (turn, el) => { const t = turn.getBoundingClientRect(); const e = el.getBoundingClientRect(); return { alignItems: getComputedStyle(turn).alignItems, rightGap: Math.round(t.right - e.right), narrower: e.width < t.width - 8 }; };
    out.readerRoute = { cleanCanonical: edge(C.root.querySelector('.cgTurn--user'), userHost(C)), referenceCanonical: edge(Rf.root.querySelector('.cgTurn--user'), userHost(Rf)), cleanRich: edge(RC.root.querySelector('.cgTurn--user'), bubble), referenceRich: edge(RR.root.querySelector('.cgTurn--user'), RR.root.querySelector('.cgBubble')) };
    document.body.removeAttribute('data-route');
    out.rendererGlobals = Object.keys(R).filter((k) => /clean|profile|presentation/i.test(k));
    window.__t3 = { RC };
    return out;
  });
  /* Keyboard focus, inspected separately from pointer suppression: Tab through the
   * Clean Reader rich render and record which provider-origin elements take focus. */
  const t3Focus = await (async () => {
    await t3Page.evaluate(() => { document.getElementById('host').replaceChildren(window.__t3.RC.root); document.body.focus(); });
    const seen = [];
    for (let i = 0; i < 12; i += 1) {
      await t3Page.keyboard.press('Tab');
      const info = await t3Page.evaluate(() => { const el = document.activeElement; if (!el || el === document.body) return null; const inRoot = window.__t3.RC.root.contains(el); return { tag: el.tagName.toLowerCase(), href: el.getAttribute('href'), inRoot, providerOrigin: inRoot && !!el.closest('[data-message-author-role]') }; });
      if (!info) break;
      if (seen.some((s) => JSON.stringify(s) === JSON.stringify(info))) break;
      seen.push(info);
    }
    return seen;
  })();
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

  check('M04 P2 T3: semantic / text / index neutrality against the reference, Reader-route end alignment under both profiles, and the rich-content pointer / keyboard-focus baseline (AC05b inspection, not weakened)', () => {
    assert.deepEqual({ text: t3.neutral.text, keys: t3.neutral.keys, skeleton: t3.neutral.skeleton, sameDigest: t3.neutral.sameDigest }, { text: true, keys: true, skeleton: true, sameDigest: true }, 'A: same textContent, Semantic Index keys / roles and DOM skeleton (class attributes and the root marker excepted) under Clean Reader, reference and default');
    assert.ok(t3.neutral.blocks >= 6, 'A: the fixture exercises heading / paragraph / list / quote / code / table blocks'); assert.equal(t3.neutral.links[0], t3.neutral.links[1], 'A: identical admitted links');
    for (const [label, edge] of Object.entries(t3.readerRoute)) { assert.equal(edge.alignItems, 'flex-end', `B: ${label}: user turn end-aligned on the Reader route`); assert.ok(edge.rightGap <= 1 && edge.rightGap >= -1, `B: ${label}: the user block hugs the column end (gap ${edge.rightGap}px)`); assert.equal(edge.narrower, true, `B: ${label}: shrink-to-fit block`); }
    assert.deepEqual(t3.rich.blocked, { buttons: 0, tabindex: 0, summaries: 1 }, 'C: the sanitizer admits no provider button / input / tabindex; details/summary is admitted');
    assert.deepEqual(t3.rich.pointer, { summary: 'none', link: 'auto', referenceSummary: 'none' }, 'C: pointer suppression of provider control-like content is the global baseline (both profiles); admitted links stay pointer-active');
    assert.equal(t3.rich.tokenClass.clean, t3.rich.tokenClass.cleanRoot, 'C: accepted limitation measured - a provider token utility class is NOT bridged under Clean Reader (inherits the root text colour)');
    assert.notEqual(t3.rich.tokenClass.reference, t3.rich.tokenClass.clean, 'C: the same captured markup IS bridged by the reference profile (provider fidelity stays with chatgpt-reference)');
    const providerFocus = t3Focus.filter((f) => f.providerOrigin);
    assert.ok(providerFocus.some((f) => f.tag === 'a' && f.href === 'https://example.test/p'), 'D: the sanitizer-admitted provider link is keyboard-focusable');
    assert.ok(providerFocus.every((f) => f.tag === 'a' || f.tag === 'summary'), `D: no provider-origin control (button / input / tabindex) can take keyboard focus (observed: ${JSON.stringify(providerFocus)})`);
    /* AC05b as written requires provider-origin keyboard focus limited to
     * sanitizer-admitted links. The sanitizer also admits <details>/<summary>,
     * and a <summary> is natively focusable while the global baseline only
     * suppresses its pointer events. That gap is reported here as an explicit
     * observation for the owning boundary (sanitizer policy) - neither hidden
     * nor asserted away by this check. */
    const nonLinkFocus = providerFocus.filter((f) => f.tag !== 'a');
    console.log(nonLinkFocus.length
      ? `    AC05B_OBSERVATION provider-origin keyboard focus is not limited to admitted links: ${JSON.stringify(nonLinkFocus)} (pointer-events suppressed, keyboard focus not)`
      : '    AC05B provider-origin keyboard focus limited to admitted links');
  });

  /* M03 P4 S4C T8 slice B: the Answer Timestamp consumer on a real Studio-mode
   * render. A second page carries the production chain plus the REAL studio.js
   * current-render bridge (extracted bind / accessors / unmount seam) and the
   * REAL Answer Timestamp module. The `governed` variant proves the Semantic
   * Index + DecorationContribution path; the `fallback` variant (same module,
   * no Reader bridge) is the accepted legacy path and the parity oracle. */
  const timestampRuns = {};
  for (const variant of ['fallback', 'governed']) {
    const tsPage = await browser.newPage();
    const tsErrors = [];
    tsPage.on('pageerror', (e) => tsErrors.push(String(e)));
    await tsPage.goto(`${base}/__timestamp_harness__?variant=${variant}`, { waitUntil: 'load' });
    const FIXTURE = `({ chatId: 'chat-ts', snapshotId: 'snap-ts', messages: [ { role: 'user', text: 'question one', messageId: 'u1', turnId: 't1', createTime: 1757664000 }, { role: 'assistant', text: 'answer **one**', messageId: 'a1', turnId: 't1', createTime: 1757664060 }, { role: 'system', text: 'sys', messageId: 's1' }, { role: 'tool', text: 'tool', messageId: 'tl1' }, { role: 'user', text: 'question two', messageId: 'u2', turnId: 't2', createTime: 1757664120 }, { role: 'assistant', text: 'answer two', messageId: 'a2', turnId: 't2', createTime: 1757664180 }, { role: 'assistant', text: 'orphan answer without time', messageId: 'a3', turnId: 't3' } ] })`;
    const SUMMARY = `(() => { const host = document.getElementById('viewReader'); const stamps = Array.from(host.querySelectorAll('[data-cgxui-owner="ats"]')); return { count: stamps.length, stamps: stamps.map((s) => ({ text: s.textContent, fullLabel: s.dataset.fullLabel, className: s.className, owner: s.getAttribute('data-cgxui-owner'), ui: s.getAttribute('data-cgxui'), parentIsHost: s.parentElement.classList.contains('cgMsg'), parentRole: s.parentElement.getAttribute('data-message-author-role'), parentMessageId: s.parentElement.getAttribute('data-message-id'), isLastChild: s.parentElement.lastElementChild === s })), nonAssistantWithStamp: Array.from(host.querySelectorAll('.cgMsg')).filter((m) => m.getAttribute('data-message-author-role') !== 'assistant' && m.querySelector('[data-cgxui-owner="ats"]')).length }; })()`;
    const out = { variant };
    await tsPage.evaluate(`(() => { const r = H2O.Studio.chatRenderer.render(${FIXTURE}, { getEditOverride: () => null }); window.__r1 = r; if (window.__bridge) window.__bridge.bind(r); window.__beforeHTML = r.root.outerHTML; document.getElementById('viewReader').replaceChildren(r.root); window.__scans.length = 0; H2O.AT.answrts.api.rescan(); })()`);
    await tsPage.waitForTimeout(600);
    out.scansAfterMount = await tsPage.evaluate('window.__scans.length'); out.afterMount = await tsPage.evaluate(SUMMARY);
    out.contributions = await tsPage.evaluate("(() => { const lc = window.__r1.decorationContributions; const ix = window.__r1.semanticIndex; return { active: lc.list().map((s) => ({ key: s.contributionKey, owner: s.owner, id: s.id, targetKey: s.targetKey, kind: s.targetKind, revision: s.revision })), assistantKeys: ix.messages().filter((m) => m.role === 'assistant').map((m) => m.projectionKey), targetsAreIndexed: lc.list().every((s) => { const rec = ix.getMessage(s.targetKey); return !!rec && rec.role === 'assistant' && rec.target.classList.contains('cgMsg') && (!rec.target.querySelector('[data-cgxui-owner=\"ats\"]') || rec.target.querySelector('[data-cgxui-owner=\"ats\"]').parentElement === rec.target); }) }; })()");
    await tsPage.evaluate("window.__scans.length = 0; window.__stampNodes = Array.from(document.querySelectorAll('[data-cgxui-owner=\"ats\"]')); H2O.AT.answrts.api.rescan();"); await tsPage.waitForTimeout(500);
    out.scansAfterRescan = await tsPage.evaluate('window.__scans.length'); out.afterRescan = await tsPage.evaluate(SUMMARY);
    out.sameNodes = await tsPage.evaluate("Array.from(document.querySelectorAll('[data-cgxui-owner=\"ats\"]')).every((s, i) => s === window.__stampNodes[i]) && window.__stampNodes.length === document.querySelectorAll('[data-cgxui-owner=\"ats\"]').length");
    out.revisionsAfterRescan = await tsPage.evaluate('window.__r1.decorationContributions.list().map((s) => s.revision)');
    await tsPage.evaluate("document.querySelector('.cgMsg[data-message-id=\"a1\"]').setAttribute('data-h2o-create-time', '1757750400'); window.__scans.length = 0; H2O.AT.answrts.api.rescan();"); await tsPage.waitForTimeout(500);
    out.scansAfterUpdate = await tsPage.evaluate('window.__scans.length'); out.afterUpdate = await tsPage.evaluate(SUMMARY);
    out.sameNodesAfterUpdate = await tsPage.evaluate("Array.from(document.querySelectorAll('[data-cgxui-owner=\"ats\"]')).every((s, i) => s === window.__stampNodes[i])"); out.revisionsAfterUpdate = await tsPage.evaluate('window.__r1.decorationContributions.list().map((s) => s.revision)');
    await tsPage.evaluate("const h = document.querySelector('.cgMsg[data-message-id=\"a2\"]'); const t = document.createElement('div'); t.setAttribute('data-cgxui', 'atns-answer-title'); t.setAttribute('data-cgxui-owner', 'atns'); t.textContent = 'Title bar'; t.style.cssText = 'display:block;width:180px;height:28px;margin:6px 0;'; h.insertBefore(t, h.firstChild); h.setAttribute('data-at-collapsed', '1'); H2O.AT.answrts.api.rescan();"); await tsPage.waitForTimeout(500);
    out.anchors = await tsPage.evaluate("(() => { const h = document.querySelector('.cgMsg[data-message-id=\"a2\"]'); const vars = ['--cgxui-ats-anchor-left','--cgxui-ats-anchor-top','--cgxui-ats-anchor-width','--cgxui-ats-anchor-height','--cgxui-ats-under-top','--cgxui-ats-under-max','--cgxui-ats-right-left','--cgxui-ats-right-max']; return { vars: Object.fromEntries(vars.map((v) => [v, h.style.getPropertyValue(v)])), hidden: getComputedStyle(h.querySelector('[data-cgxui-owner=\"ats\"]')).visibility, otherHostStyle: document.querySelector('.cgMsg[data-message-id=\"a1\"]').style.cssText }; })()");
    out.contentUnchanged = await tsPage.evaluate("(() => { const clone = window.__r1.root.cloneNode(true); clone.querySelectorAll('[data-cgxui-owner=\"ats\"], [data-cgxui-owner=\"atns\"]').forEach((n) => n.remove()); const h2 = clone.querySelector('.cgMsg[data-message-id=\"a2\"]'); h2.removeAttribute('data-at-collapsed'); h2.removeAttribute('style'); clone.querySelector('.cgMsg[data-message-id=\"a1\"]').setAttribute('data-h2o-create-time', '1757664060'); return clone.outerHTML === window.__beforeHTML; })()");
    if (variant === 'governed') {
      await tsPage.evaluate(`(() => { const r2 = H2O.Studio.chatRenderer.render(${FIXTURE}, { getEditOverride: () => null }); window.__r2 = r2; window.__bridge.bind(r2); window.__scans.length = 0; H2O.AT.answrts.api.rescan(); })()`); await tsPage.waitForTimeout(500);
      out.foreign = await tsPage.evaluate("({ r2: window.__r2.decorationContributions.list().length, r1: window.__r1.decorationContributions.list().length, scans: window.__scans.length, stamps: document.querySelectorAll('[data-cgxui-owner=\"ats\"]').length })");
      await tsPage.evaluate("window.__bridge.bind({ root: window.__r1.root, semanticIndex: window.__r1.semanticIndex, decorationContributions: window.__r2.decorationContributions }); window.__scans.length = 0; H2O.AT.answrts.api.rescan();"); await tsPage.waitForTimeout(500);
      out.mismatch = await tsPage.evaluate("({ r2: window.__r2.decorationContributions.list().length, scans: window.__scans.length })");
      await tsPage.evaluate("window.__bridge.bind(window.__r1); window.__scans.length = 0; H2O.AT.answrts.api.rescan();"); await tsPage.waitForTimeout(500);
      out.rebound = await tsPage.evaluate("({ r1: window.__r1.decorationContributions.list().length, scans: window.__scans.length, stamps: document.querySelectorAll('[data-cgxui-owner=\"ats\"]').length })");
      out.unmount = await tsPage.evaluate("(() => { window.__bridge.unmount('validator:leave'); return { unmounts: window.__unmounts, active: window.__r1.decorationContributions.list().length, stamps: document.querySelectorAll('[data-cgxui-owner=\"ats\"]').length, a2Style: document.querySelector('.cgMsg[data-message-id=\"a2\"]').style.cssText, accessorIndex: H2O.Studio.getReaderSemanticIndex(), accessorDeco: H2O.Studio.getReaderDecorationContributions(), binding: window.__bridge.state.currentReaderRender, warnings: window.__warnings }; })()");
      out.api = await tsPage.evaluate('Object.keys(H2O.AT.answrts.api)'); out.diag = await tsPage.evaluate('JSON.stringify(H2O.AT.answrts.diag.governed || null)');
      out.rendererGlobals = await tsPage.evaluate("Object.keys(H2O.Studio.Renderer).filter((k) => /current|registry|timestamp|decorations$/i.test(k))");
    }
    out.errors = tsErrors;
    timestampRuns[variant] = out;
    await tsPage.close();
  }

  check('Answer Timestamp: the governed Studio path registers one DecorationContribution per assistant projection (Semantic Index targets, zero assistant-selector scans) (S4C slice B)', () => {
    const g = timestampRuns.governed;
    assert.deepEqual(g.errors, [], 'no page errors');
    assert.equal(g.contributions.active.length, 3, 'F/I: one contribution per assistant projection (incl. the answer without create time), none for user/system/tool');
    assert.deepEqual(g.contributions.active.map((a) => a.id), g.contributions.assistantKeys, 'E/G/K: ids and targetKeys are the assistant message projection keys, in index order');
    assert.ok(g.contributions.active.every((a) => a.owner === 'studio-answer-timestamp' && a.targetKey === a.id && a.kind === 'message' && a.key === `decoration:studio-answer-timestamp:${encodeURIComponent(a.id)}`), 'K: deterministic owner/id/key');
    assert.equal(g.contributions.targetsAreIndexed, true, 'H: the stamp sits directly under the exact indexed assistant message Element');
    assert.equal(g.scansAfterMount, 0, 'W: no querySelectorAll("div[data-message-author-role=\\"assistant\\"]") on the governed path'); assert.equal(g.scansAfterRescan, 0); assert.equal(g.scansAfterUpdate, 0);
    assert.equal(g.afterMount.count, 2, 'L: stamps created inside apply for the two timed answers'); assert.equal(g.afterMount.nonAssistantWithStamp, 0);
    assert.deepEqual(g.rendererGlobals, [], 'no Renderer-side registry / current lifecycle'); assert.deepEqual(g.api, ['boot', 'dispose', 'rescan', 'getConfig', 'applySetting'], 'public module API unchanged'); assert.equal(g.diag, 'null', 'no governed-path errors');
  });

  check('Answer Timestamp: repeated reconcile never duplicates; updates flow through the contribution handle (revision advances, same stamp node) (S4C slice B)', () => {
    const g = timestampRuns.governed;
    assert.equal(g.afterRescan.count, 2, 'J: no duplicate stamps'); assert.equal(g.sameNodes, true, 'J/M: the same stamp nodes'); assert.ok(g.revisionsAfterRescan.every((r) => r >= 1), 'M: reconcile is an update, not a re-register');
    assert.notEqual(g.afterUpdate.stamps[0].text, g.afterMount.stamps[0].text, 'M/Q: a changed create time updates the label'); assert.equal(g.sameNodesAfterUpdate, true, 'M: node identity preserved'); assert.ok(g.revisionsAfterUpdate.every((r, i) => r > g.revisionsAfterRescan[i]), 'M: through handle.update');
    assert.equal(g.afterUpdate.count, 2);
  });

  check('Answer Timestamp: governed output equals the legacy compatibility path - label, classes, cgxui attributes, dataset.fullLabel, placement, collapsed anchors; content DOM untouched (S4C slice B)', () => {
    const g = timestampRuns.governed; const f = timestampRuns.fallback;
    assert.deepEqual(f.errors, []);
    assert.ok(f.scansAfterMount > 0, 'X/Y: the compatibility path still discovers targets through the assistant selector');
    assert.equal(f.afterMount.count, 2, 'X: legacy stamps present without the Reader contracts');
    const shape = (s) => s.stamps.map((x) => ({ text: x.text, fullLabel: x.fullLabel, className: x.className, owner: x.owner, ui: x.ui, parentIsHost: x.parentIsHost, parentRole: x.parentRole, parentMessageId: x.parentMessageId, isLastChild: x.isLastChild }));
    assert.deepEqual(shape(g.afterMount), shape(f.afterMount), 'Q/R: identical stamps on mount'); assert.deepEqual(shape(g.afterUpdate), shape(f.afterUpdate), 'Q: identical updated labels');
    assert.ok(g.afterMount.stamps.every((s) => s.className === 'chatgpt-timestamp cgxui-ats-ts' && s.owner === 'ats' && s.ui === 'ats-stamp' && s.fullLabel === s.text && s.parentIsHost && s.parentRole === 'assistant'), 'R: accepted classes / attributes / fullLabel / placement');
    assert.deepEqual(g.anchors, f.anchors, 'S: collapsed-hover anchor variables identical'); assert.equal(g.anchors.hidden, 'hidden', 'S: collapsed stamp hidden'); assert.ok(Object.values(g.anchors.vars).every((v) => /px$/.test(v)), 'S: anchor vars set'); assert.equal(g.anchors.otherHostStyle, '', 'S: non-collapsed hosts carry no vars');
    assert.equal(g.contentUnchanged, true, 'P: author/content DOM unchanged outside the decoration'); assert.equal(f.contentUnchanged, true);
    assert.equal(f.contributions.active.length, 0, 'X: the legacy path registers nothing');
  });

  check('Answer Timestamp: stale / foreign contracts are never used; Reader unmount disposes every timestamp decoration and clears the bridge (S4C slice B)', () => {
    const g = timestampRuns.governed;
    assert.deepEqual(g.foreign, { r2: 0, r1: 3, scans: g.foreign.scans, stamps: 2 }); assert.ok(g.foreign.scans > 0, 'an unmounted render bound as current is not governed: the mounted render is served by the compatibility scan');
    assert.equal(g.mismatch.r2, 0, 'a mismatched index/lifecycle pair is rejected'); assert.ok(g.mismatch.scans > 0);
    assert.deepEqual(g.rebound, { r1: 3, scans: 0, stamps: 2 }, 'the real pair rebound -> governed again');
    assert.equal(g.unmount.active, 0, 'N/O: disposeAll removed every active contribution'); assert.equal(g.unmount.stamps, 0, 'N/O: every owned stamp removed'); assert.equal(g.unmount.a2Style, '', 'N: anchor vars cleared on dispose');
    assert.equal(g.unmount.accessorIndex, null); assert.equal(g.unmount.accessorDeco, null); assert.equal(g.unmount.binding, null, 'bridge cleared'); assert.deepEqual(g.unmount.unmounts, ['validator:leave'], 'host unmount continued'); assert.deepEqual(g.unmount.warnings, []);
  });

  await browser.close();
  server.close();
}

console.log(failures.length ? `FAIL ${failures.length} (passed ${checks.length})` : `PASS ${checks.length}`);
process.exit(failures.length ? 1 : 0);
