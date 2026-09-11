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
const STUDIO_CSS_REL = 'studio.css';
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
  for (const fn of ['register', 'has', 'renderBlock', 'renderBlocks', 'registeredKinds']) {
    assert.equal(typeof cr[fn], 'function', `missing ${fn}`);
  }
  for (const kind of cr.coreKinds) assert.equal(cr.has(kind), true, `core kind not registered: ${kind}`);
  /* Both sides are spread into THIS realm first: values built inside the vm
   * sandbox carry the sandbox's intrinsics, which deepStrictEqual compares. */
  assert.deepEqual([...cr.registeredKinds()], [...cr.coreKinds].sort(),
    'registered kinds must be exactly the core kinds');
});

check('duplicate registration fails rather than silently replacing', () => {
  const cr = loadRegistry();
  assert.throws(() => cr.register('paragraph', () => null), /already has a renderer/i);
  /* A new kind still registers, so the guard is about duplicates, not writes. */
  assert.equal(cr.register('citation', () => null), 'citation');
  assert.equal(cr.has('citation'), true);
  assert.throws(() => cr.register('citation', () => null), /already has a renderer/i);
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
  assert.match(code, /register\("codeBlock", \(block, context\) => \{\s*const profile = resolvePresentationProfile\(context\);/);
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
   * stylesheet; the deferred user-host member stays global. */
  const narrowRich = rules.filter((r) => r.media === '(max-width: 720px)' && r.selector.includes('.wbRichRoot :where('));
  assert.equal(narrowRich.length, 1, 'E: the narrow rich user-host rule stays global');
  assert.deepEqual(narrowRich[0].declarations, NARROW_USER_OVERRIDE);
  assert.equal(narrowRich[0].selector.includes('.cgMsg--user'), false, 'C: the canonical member left the global narrow rule');
  /* I: Reader-route, edit-state and rich rules were not absorbed. */
  assert.ok(rules.some((r) => members(r).includes('body[data-route="reader"] .cgMsg--user')), 'I: Reader-route user rule remains global');
  assert.ok(rules.some((r) => r.selector === '.cgMsg--edited'), 'I: edit-state rule remains global');
  assert.ok(rules.some((r) => members(r).includes('.wbReader[data-edit-mode="on"] [data-turn].wbTurn--editing .cgMsg--user')), 'I: edit-mode user rule remains global');
  assert.ok(rules.some((r) => r.selector === '.cgMsg--rich'), 'stale .cgMsg--rich left untouched in this slice');
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
/* Deferred for cascade coupling (stay global, verbatim): the no-bubble user
 * host fallback shares specificity (0,2,0) with the later Reader appearance
 * rule `.wbReader [data-message-author-role]`, and the user-turn flex
 * placement shares (0,3,0) with the later `.wbReader [data-turn].is-in-collapsed-section`. */
const DEFERRED_GLOBAL_RULES = {
  '.wbRichRoot :where([data-message-author-role="user"]):not(:has(.user-message-bubble-color))': { 'max-width': 'min(var(--wb-user-w), 44rem)', width: 'fit-content', 'margin-left': 'auto', padding: '10px 20px', 'border-radius': 'var(--wb-radius-xl)', background: 'var(--wb-user-bg)' },
  '.wbRichRoot .cgTurn--user[data-testid^="conversation-turn"]': { display: 'flex', 'flex-direction': 'column', 'align-items': 'flex-end', 'justify-content': 'flex-start' },
};

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
  for (const sel of Object.keys(DEFERRED_GLOBAL_RULES)) assert.equal(rules.filter((r) => r.selector.includes(norm(sel))).length, 0, `deferred rule must not be in the profile stylesheet: ${sel}`);
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
  const narrowRich = rules.filter((r) => r.media === '(max-width: 720px)' && members(r).some((m) => m.includes('.wbRichRoot :where(')));
  assert.equal(narrowRich.length, 1, 'the narrow rich rule remains for the deferred user-host member only');
  assert.deepEqual(members(narrowRich[0]), [norm('.wbRichRoot :where([data-message-author-role="user"]):not(:has(.user-message-bubble-color))')]);
  assert.deepEqual(narrowRich[0].declarations, NARROW_USER_OVERRIDE);
  for (const [sel, decls] of Object.entries(DEFERRED_GLOBAL_RULES)) {
    const found = rules.filter((r) => r.selector === norm(sel) && r.media === null);
    assert.equal(found.length, 1, `deferred rule stays global: ${sel}`);
    assert.deepEqual(found[0].declarations, decls, `deferred rule unchanged: ${sel}`);
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
  /* E + F: attachment and edit-state rules remain global. */
  /* wbTurn--edited carries no rule in studio.css; the edit cluster's global
   * rules are .cgMsg--edited and the edit-mode .wbTurn--editing block. */
  for (const sel of ['.cgUserAttachmentGrid', '.cgUserAttachmentCard', '.cgMsg--edited', '.wbTurn--editing', '[data-edit-mode="on"]']) {
    assert.ok(rules.some((r) => members(r).some((m) => m.includes(sel))), `${sel} rules remain global`);
  }
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
  /* K: replay-interaction safety and image/media presentation are not part of the unit. */
  assert.equal(rules.filter((r) => r.plain.includes('button, input, textarea, select, summary')).length, 0, 'K: replay-interaction safety stays outside the profile');
  assert.equal(rules.filter((r) => r.plain.includes(':where(img, video, canvas, svg)') || r.plain.includes('.cgMsgBody img') || r.plain.includes('.dalle-image-container')).length, 0, 'J: image/media presentation stays outside the profile');
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
  /* K: replay-interaction safety; J: image/media and attachment rules stay global. */
  const safety = glob.filter((r) => r.selector === '.wbRichRoot :where(button, input, textarea, select, summary)');
  assert.equal(safety.length, 1); assert.deepEqual(safety[0].declarations, { 'pointer-events': 'none' }, 'K: replay-interaction safety rule unchanged and global');
  assert.ok(glob.some((r) => r.selector === '.wbRichRoot :where(img, video, canvas, svg)'), 'J: rich media containment stays global');
  assert.ok(glob.some((r) => splitMembers(r.selector).includes('.cgMsgBody img')), 'J: canonical image presentation stays global');
  assert.ok(glob.some((r) => splitMembers(r.selector).some((m) => m.includes('.dalle-image-container img'))), 'J: provider image rules stay global');
  /* L: canonical table members no longer global; .cgMsgBody img still is. */
  for (const sel of ['.cgMsgBody table', '.cgMsgBody thead', '.cgMsgBody th', '.cgMsgBody td', '.cgMsgBody tr:nth-child(even) td']) assert.equal(globalMembers.has(sel), false, `L: ${sel} no longer global`);
  assert.equal(globalMembers.has('.cgMsgBody img'), true);
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
    parent.appendChild(node); parent.appendChild(prose); parent.appendChild(rich);
    const cs = getComputedStyle(node); const hs = getComputedStyle(inner); const rs = getComputedStyle(richHeading);
    const out = { display: cs.display, fontSize: cs.fontSize, borderRadius: cs.borderRadius, position: cs.position, color: cs.color, headingLineHeight: hs.lineHeight, headingMarginTop: hs.marginTop, headingFontSize: hs.fontSize, richHeadingFontSize: rs.fontSize, richHeadingLineHeight: rs.lineHeight, richHeadingMarginTop: rs.marginTop, tokenText: getComputedStyle(node).getPropertyValue('--token-text-primary').trim() };
    node.remove(); prose.remove(); rich.remove(); return out;
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

  await browser.close();
  server.close();
}

console.log(failures.length ? `FAIL ${failures.length} (passed ${checks.length})` : `PASS ${checks.length}`);
process.exit(failures.length ? 1 : 0);
