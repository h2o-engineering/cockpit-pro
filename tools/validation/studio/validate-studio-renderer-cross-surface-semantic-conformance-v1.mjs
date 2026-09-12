#!/usr/bin/env node
// M03 P5 S5B T9 slice A — cross-surface (Web/Studio ↔ Mobile) semantic conformance.
//
// Proves that the two REAL production integration boundaries interpret identical
// Markdown/text input identically through the one accepted semantic architecture
// (markdown-it 15.0.1 → H2O bounded GFM → H2O semantic adapter → transient
// Render IR), using the accepted 40-case CommonMark/GFM corpus as the formal
// fixture (never a second copy):
//
//   WEB / STUDIO boundary : the chat renderer's own semanticMarkdownEngine /
//                           renderSemanticBody / appendVerbatimBody (extracted
//                           verbatim from chat-renderer.studio.js) driving the
//                           VENDORED markdown-it UMD, the shared GFM closure,
//                           the shared adapter and the real Render IR; only the
//                           downstream ContentRenderer sink is a capturing stub
//                           (presentation is S5A's subject, not semantics).
//   MOBILE boundary       : apps/studio/mobile/src/renderer/semantic-markdown.ts
//                           loaded from source, whose require() resolves the
//                           shared engine/adapter sources in place and the
//                           npm markdown-it the Metro/Node path uses.
//
// Verdicts rest on DEEP semantic equality with a first-differing-path report;
// canonical-JSON SHA-256 digests are diagnostics only. Exclusions from the
// cross-surface payload are documented inline: none at adapter level; at
// Render IR level Mobile blocks are normalized through the same accepted IR
// contract, so deterministic renderKeys are compared too.

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire, stripTypeScriptTypes } from 'node:module';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), '..', '..', '..');
const CORPUS_REL = 'tools/validation/fixtures/studio-renderer-markdown/markdown-conformance.v1.json';
const MD_DIR_REL = 'src-surfaces-base/studio/renderer/markdown';
const VENDOR_UMD_REL = `${MD_DIR_REL}/vendor/markdown-it/markdown-it.umd.min.js`;
const VENDOR_PIN_REL = `${MD_DIR_REL}/vendor/markdown-it/PIN.json`;
const SHARED_MODULES = Object.freeze(['h2o-gfm.v1.js', 'markdown-engine.v1.js', 'markdown-ir-adapter.v1.js']);
const RENDER_IR_REL = 'src-surfaces-base/studio/renderer/semantic/render-ir.v1.js';
const CHAT_RENDERER_REL = 'src-surfaces-base/studio/renderer/chat-renderer.studio.js';
const MOBILE_BRIDGE_REL = 'apps/studio/mobile/src/renderer/semantic-markdown.ts';
const MOBILE_COMPONENT_REL = 'apps/studio/mobile/src/renderer/ChatMarkdownRenderer.tsx';
const MOBILE_PACKAGE_REL = 'apps/studio/mobile/package.json';
const MOBILE_BESPOKE_PARSER_REL = 'apps/studio/mobile/src/renderer/parse.ts';
const EXPECTED_ENGINE_VERSION = '15.0.1';
const EXPECTED_CASE_COUNT = 40;
const ROLES = Object.freeze(['user', 'assistant', 'system', 'tool']);

const abs = (rel) => path.join(REPO_ROOT, rel);
const readText = (rel) => fs.readFileSync(abs(rel), 'utf8');
const sha256 = (input) => crypto.createHash('sha256').update(input).digest('hex');

/* ------------------------------------------------------------ comparator -- */

/* JSON-like canonical form: sorted object keys, arrays in order, undefined dropped. */
function canonicalize(value) {
  const plain = JSON.parse(JSON.stringify(value === undefined ? null : value));
  const sort = (v) => {
    if (Array.isArray(v)) return v.map(sort);
    if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sort(v[k])]));
    return v;
  };
  return sort(plain);
}
const canonicalJson = (value) => JSON.stringify(canonicalize(value));
const digest = (value) => sha256(canonicalJson(value));

/* Deep semantic equality with the FIRST differing path (`$.blocks[0].start`). */
function firstDiff(web, mobile, at = '$') {
  const a = canonicalize(web); const b = canonicalize(mobile);
  const walk = (x, y, p) => {
    if (Array.isArray(x) || Array.isArray(y)) {
      if (!Array.isArray(x) || !Array.isArray(y)) return { path: p, web: x, mobile: y };
      if (x.length !== y.length) return { path: `${p}.length`, web: x.length, mobile: y.length };
      for (let i = 0; i < x.length; i += 1) { const d = walk(x[i], y[i], `${p}[${i}]`); if (d) return d; }
      return null;
    }
    if (x && typeof x === 'object' && y && typeof y === 'object') {
      const keys = [...new Set([...Object.keys(x), ...Object.keys(y)])].sort();
      for (const k of keys) {
        if (!(k in x) || !(k in y)) return { path: `${p}.${k}`, web: x[k], mobile: y[k] };
        const d = walk(x[k], y[k], `${p}.${k}`); if (d) return d;
      }
      return null;
    }
    return x === y ? null : { path: p, web: x, mobile: y };
  };
  return walk(a, b, at);
}

/* ------------------------------------------------------------ reporting -- */

const checks = [];
const failures = [];
function check(label, fn) {
  try { fn(); checks.push(label); console.log(`✓ ${label}`); }
  catch (e) { failures.push(label); console.log(`✗ ${label}\n    ${e.message}`); }
}
const summary = {};

/* ------------------------------------------------------------- corpus -- */

const corpus = JSON.parse(readText(CORPUS_REL));

/* ---------------------------------------------------------- WEB surface -- */

/* Minimal DOM seam for the chat renderer's body functions: createElement /
 * createTextNode / appendChild / removeChild / firstChild. The semantic payload
 * is captured BEFORE any DOM is built; the fake body only lets the real
 * fallback path (appendVerbatimBody) be observed. */
class FakeNode {
  constructor(tagName) { this.tagName = String(tagName).toUpperCase(); this.nodeType = 1; this.childNodes = []; }
  get firstChild() { return this.childNodes[0] || null; }
  appendChild(node) { this.childNodes.push(node); return node; }
  removeChild(node) { const i = this.childNodes.indexOf(node); if (i >= 0) this.childNodes.splice(i, 1); return node; }
  get textContent() { return this.childNodes.map((n) => (n.nodeType === 3 ? n.nodeValue : n.textContent)).join(''); }
}
const fakeDocument = {
  createElement: (tag) => new FakeNode(tag),
  createTextNode: (text) => ({ nodeType: 3, nodeValue: String(text) }),
  createDocumentFragment: () => new FakeNode('#fragment'),
};

function extractFunction(source, name) {
  const match = new RegExp(`\\bfunction\\s+${name}\\s*\\(`).exec(source);
  if (!match) throw new Error(`extractFunction: '${name}' not found`);
  const braceOpen = source.indexOf('{', match.index);
  let depth = 0;
  for (let i = braceOpen; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') { depth -= 1; if (depth === 0) return source.slice(match.index, i + 1); }
  }
  throw new Error(`extractFunction: unterminated '${name}'`);
}

const chatRendererSource = readText(CHAT_RENDERER_REL);

/* The Web/Studio boundary: the vendored UMD (global `markdownit`, exactly as the
 * Studio page provides it) + the shared modules + the real Render IR, then the
 * chat renderer's own semantic body functions extracted verbatim. The adapter
 * and Render IR are wrapped by RECORDING delegates (the real functions run);
 * the ContentRenderer is a capturing sink. */
function loadWebSurface() {
  const sandbox = vm.createContext({ console, atob, btoa });
  sandbox.globalThis = sandbox;
  vm.runInContext(readText(VENDOR_UMD_REL), sandbox, { filename: 'markdown-it.umd.min.js' });
  for (const rel of SHARED_MODULES) vm.runInContext(readText(`${MD_DIR_REL}/${rel}`), sandbox, { filename: rel });
  vm.runInContext(readText(RENDER_IR_REL), sandbox, { filename: 'render-ir.v1.js' });
  const real = sandbox.H2O.Studio.Renderer;
  const record = { parsed: null, doc: null, sinkBlocks: null };
  const Renderer = {
    markdownEngine: real.markdownEngine,
    markdownIrAdapter: { markdownToBlocks(md, text) { const r = real.markdownIrAdapter.markdownToBlocks(md, text); record.parsed = r; return r; } },
    renderIR: { createConversation(input) { const doc = real.renderIR.createConversation(input); record.doc = doc; return doc; }, validate: (doc) => real.renderIR.validate(doc) },
    contentRenderer: { renderBlocks(blocks) { record.sinkBlocks = blocks; return fakeDocument.createDocumentFragment(); } },
  };
  sandbox.Studio = { Renderer };
  sandbox.document = fakeDocument;
  vm.runInContext([
    'let semanticEngineInstance = null;',
    'let ACTIVE_CONTENT_COLLECTOR = null;',
    extractFunction(chatRendererSource, 'semanticMarkdownEngine'),
    extractFunction(chatRendererSource, 'appendVerbatimBody'),
    extractFunction(chatRendererSource, 'contentRenderContext'),
    extractFunction(chatRendererSource, 'markContentBody'),
    extractFunction(chatRendererSource, 'renderSemanticBody'),
    'this.__web = { renderSemanticBody, semanticMarkdownEngine, injectEngine(engine) { semanticEngineInstance = engine; } };',
  ].join('\n'), sandbox, { filename: 'chat-renderer.studio.js#semantic-seam' });
  const web = sandbox.__web;
  return {
    real,
    engineApi: real.markdownEngine,
    engine: () => web.semanticMarkdownEngine(),
    injectEngine: (engine) => web.injectEngine(engine),
    parse(source) {
      record.parsed = null; record.doc = null; record.sinkBlocks = null;
      const bodyEl = fakeDocument.createElement('div');
      const ok = web.renderSemanticBody(bodyEl, source);
      const plain = (v) => JSON.parse(JSON.stringify(v));
      if (ok === true) {
        return { fallback: false, blocks: plain(record.parsed.blocks), irBlocks: plain(record.doc.messages[0].blocks), sinkBlocks: plain(record.sinkBlocks) };
      }
      /* Whole-message verbatim fallback: the real appendVerbatimBody built <p>text</p>. */
      const p = bodyEl.childNodes[0];
      return { fallback: true, blocks: [{ kind: 'paragraph', children: [{ kind: 'text', text: p ? p.textContent : '' }] }], adapterFallback: record.parsed ? record.parsed.fallback : null, bodyChildren: bodyEl.childNodes.length, bodyTag: p ? p.tagName : null };
    },
  };
}

/* ------------------------------------------------------- MOBILE surface -- */

const mobileBridgePath = abs(MOBILE_BRIDGE_REL);
const mobileEnginePath = abs(`${MD_DIR_REL}/markdown-engine.v1.js`);
const mobileAdapterPath = abs(`${MD_DIR_REL}/markdown-ir-adapter.v1.js`);

/* The Mobile boundary: semantic-markdown.ts loaded from source (types stripped),
 * with a require() that resolves exactly what Metro resolves — the shared
 * sources in place. `engineOverride` is a validation-local injection at the
 * bridge's narrowest dependency seam (its engine require) for the failure
 * proof; everything else is the real module graph. The captured engine and the
 * resolved module paths are evidence, not modifications. */
function loadMobileBridge({ engineOverride = null } = {}) {
  const source = readText(MOBILE_BRIDGE_REL);
  let exportsSeen = 0;
  const js = stripTypeScriptTypes(source, { mode: 'strip' })
    .replace(/^export\s+(function|const|let)\s/mg, (_m, kw) => { exportsSeen += 1; return `${kw} `; })
    + '\nmodule.exports.parseMarkdownToRenderBlocks = parseMarkdownToRenderBlocks;\n';
  if (exportsSeen === 0) throw new Error('bridge exposes no exported function');
  const localRequire = createRequire(mobileBridgePath);
  const resolved = [];
  const captured = { engineApi: null, engine: null };
  const shimRequire = (id) => {
    const target = localRequire.resolve(id);
    resolved.push(path.relative(REPO_ROOT, target));
    const mod = localRequire(id);
    if (target === mobileEnginePath) {
      captured.engineApi = mod;
      const api = Object.assign({}, mod, { formalBaseEngine(...args) { const engine = engineOverride ? engineOverride(mod, ...args) : mod.formalBaseEngine(...args); captured.engine = engine; return engine; } });
      return api;
    }
    return mod;
  };
  const sandbox = vm.createContext({ console, atob, btoa, require: shimRequire, module: { exports: {} }, exports: {} });
  sandbox.globalThis = sandbox;
  sandbox.module.exports = sandbox.exports;
  vm.runInContext(js, sandbox, { filename: MOBILE_BRIDGE_REL });
  return {
    source,
    resolved,
    captured,
    parse(sourceText) { return JSON.parse(JSON.stringify(sandbox.module.exports.parseMarkdownToRenderBlocks(sourceText))); },
  };
}

/* ------------------------------------------------------------- run -- */

const web = loadWebSurface();
const mobile = loadMobileBridge();

check('corpus: the accepted shared 40-case CommonMark/GFM fixture is the single formal corpus', () => {
  assert.equal(corpus.schema, 'h2o.renderer.markdown-conformance');
  assert.equal(corpus.cases.length, EXPECTED_CASE_COUNT, `corpus count is ${corpus.cases.length}, expected ${EXPECTED_CASE_COUNT}`);
  assert.equal(new Set(corpus.cases.map((c) => c.id)).size, EXPECTED_CASE_COUNT, 'case ids unique');
  for (const c of corpus.cases) assert.ok(typeof c.source === 'string' && Array.isArray(c.expect.blocks), `${c.id}: source + expected blocks`);
  summary.formalCorpusPath = CORPUS_REL;
  summary.formalCaseCount = corpus.cases.length;
  summary.categories = [...new Set(corpus.cases.map((c) => c.category))];
});

check('Web/Studio boundary: the chat renderer\'s real semantic body path drives the shared engine/adapter/IR (formal base, vendored UMD)', () => {
  const md = web.engine();
  assert.equal(typeof md.parse, 'function');
  assert.deepEqual({ html: md.options.html, typographer: md.options.typographer, breaks: md.options.breaks, linkify: md.options.linkify }, { html: false, typographer: false, breaks: false, linkify: false }, 'formal base options on the Web engine instance');
  assert.equal(md.validateLink('javascript:alert(1)'), true, 'parser destination recognition stays open (admission is sanitizerPolicy.classifyUrl downstream)');
  assert.equal(web.engineApi.engineName, 'markdown-it'); assert.equal(web.engineApi.engineVersion, EXPECTED_ENGINE_VERSION);
  const seam = extractFunction(chatRendererSource, 'semanticMarkdownEngine');
  assert.match(seam, /engineApi\.formalBaseEngine\(\)/, 'Web selects the formal base'); assert.doesNotMatch(seam, /providerProfileEngine|chatgpt-web-dated/, 'no dated profile forced globally');
  assert.match(extractFunction(chatRendererSource, 'renderSemanticBody'), /adapter\.markdownToBlocks\(md, text\)[\s\S]*ir\.createConversation\([\s\S]*ir\.validate\(doc\)[\s\S]*content\.renderBlocks\(doc\.messages\[0\]\.blocks/, 'Web path: adapter -> Render IR -> validate -> ContentRenderer');
  assert.doesNotMatch(chatRendererSource, /function\s+renderTextAsChatGPTBlocks\s*\(|function\s+parseMarkdown\w*\s*\(/, 'no legacy/bespoke Web parser function');
  const probe = web.parse('# t\n\ntext');
  assert.equal(probe.fallback, false); assert.equal(probe.blocks[0].kind, 'heading'); assert.equal(probe.irBlocks[0].kind, 'heading'); assert.equal(typeof probe.irBlocks[0].renderKey, 'string');
  summary.webIntegrationEntry = `${CHAT_RENDERER_REL} (semanticMarkdownEngine -> renderSemanticBody -> Studio.Renderer.markdownIrAdapter/renderIR -> contentRenderer; appendVerbatimBody fallback)`;
});

check('Mobile boundary: the real semantic-markdown.ts bridge resolves the shared sources in place and uses the formal base', () => {
  assert.equal(typeof mobile.parse, 'function');
  assert.match(mobile.source, /require\('\.\.\/\.\.\/\.\.\/\.\.\/\.\.\/src-surfaces-base\/studio\/renderer\/markdown\/markdown-engine\.v1\.js'\)/, 'bridge requires the shared engine source in place');
  assert.match(mobile.source, /require\('\.\.\/\.\.\/\.\.\/\.\.\/\.\.\/src-surfaces-base\/studio\/renderer\/markdown\/markdown-ir-adapter\.v1\.js'\)/, 'bridge requires the shared adapter source in place');
  assert.match(mobile.source, /formalBaseEngine\(\)/, 'Mobile selects the formal base'); assert.doesNotMatch(mobile.source, /providerProfileEngine|chatgpt-web-dated/, 'no dated provider profile on Mobile');
  assert.doesNotMatch(mobile.source, /markdownit\s*\(|new\s+MarkdownIt|require\(['"]markdown-it['"]\)/, 'the bridge constructs no engine of its own');
  const probe = mobile.parse('# t\n\ntext');
  assert.equal(probe.fallback, false); assert.equal(probe.blocks[0].kind, 'heading');
  assert.deepEqual(mobile.resolved.sort(), [`${MD_DIR_REL}/markdown-engine.v1.js`, `${MD_DIR_REL}/markdown-ir-adapter.v1.js`].sort(), 'the bridge\'s own requires are exactly the two shared sources');
  const engine = mobile.captured.engine;
  assert.ok(engine && typeof engine.parse === 'function', 'the engine the bridge actually built was captured');
  assert.deepEqual({ html: engine.options.html, typographer: engine.options.typographer, breaks: engine.options.breaks, linkify: engine.options.linkify }, { html: false, typographer: false, breaks: false, linkify: false }, 'formal base options on the Mobile engine instance');
  assert.equal(engine.validateLink('javascript:alert(1)'), true);
  assert.equal(mobile.captured.engineApi.engineVersion, EXPECTED_ENGINE_VERSION);
  const component = readText(MOBILE_COMPONENT_REL);
  assert.match(component, /import \{ parseMarkdownToRenderBlocks[^}]*\} from '\.\/semantic-markdown';/, 'the Mobile renderer component consumes the bridge');
  assert.doesNotMatch(component, /from '\.\/parse'|require\(['"]\.\/parse['"]\)/, 'the retired bespoke parser is not imported');
  summary.mobileIntegrationEntry = `${MOBILE_BRIDGE_REL} (parseMarkdownToRenderBlocks -> shared markdown-engine.formalBaseEngine + markdown-ir-adapter.markdownToBlocks; consumed by ${MOBILE_COMPONENT_REL})`;
});

/* Formal corpus: both boundaries, deep equality, digests, IR-level parity. */
const perCase = [];
check(`formal corpus: Web and Mobile boundaries interpret all ${corpus.cases.length} cases identically (deep equality + digests)`, () => {
  const mismatches = []; const webFail = []; const mobileFail = []; const irMismatch = []; const irNotAdditive = [];
  for (const c of corpus.cases) {
    const w = web.parse(c.source); const m = mobile.parse(c.source);
    const expected = JSON.parse(JSON.stringify(c.expect.blocks));
    if (w.fallback || firstDiff(w.blocks, expected)) webFail.push(c.id);
    if (m.fallback !== false || firstDiff(m.blocks, expected)) mobileFail.push(c.id);
    const diff = firstDiff(w.blocks, m.blocks);
    const webDigest = digest(w.blocks); const mobileDigest = digest(m.blocks);
    if (diff) mismatches.push({ id: c.id, category: c.category, diff, webDigest, mobileDigest });
    /* Render IR level: Mobile blocks normalized through the same accepted contract must equal the Web path's real IR, renderKeys included. */
    let irDiff = null;
    if (!w.fallback && m.fallback === false) {
      const mobileDoc = web.real.renderIR.createConversation({ id: 'h2o.render', messages: [{ id: 'h2o.message', role: 'assistant', blocks: m.blocks }] });
      const verdict = web.real.renderIR.validate(mobileDoc);
      if (!verdict || verdict.ok !== true) irDiff = { path: '$.validate', web: 'ok', mobile: verdict && verdict.errors };
      else irDiff = firstDiff(w.irBlocks, JSON.parse(JSON.stringify(mobileDoc.messages[0].blocks)));
      if (irDiff) irMismatch.push({ id: c.id, irDiff });
      /* The IR normalization is additive only (renderKey / ownerRef), never a semantic edit. */
      const strip = (node) => { if (Array.isArray(node)) return node.map(strip); if (node && typeof node === 'object') { const out = {}; for (const [k, v] of Object.entries(node)) { if (k === 'renderKey' || k === 'ownerRef') continue; out[k] = strip(v); } return out; } return node; };
      if (firstDiff(strip(w.irBlocks), w.blocks)) irNotAdditive.push(c.id);
    }
    perCase.push({ id: c.id, category: c.category, webDigest, mobileDigest, equal: !diff, irEqual: !irDiff });
  }
  summary.webFormalPass = `${corpus.cases.length - webFail.length}/${corpus.cases.length}`;
  summary.mobileFormalPass = `${corpus.cases.length - mobileFail.length}/${corpus.cases.length}`;
  summary.crossSurfaceFormalParity = `${corpus.cases.length - mismatches.length}/${corpus.cases.length}`;
  summary.crossSurfaceMismatchCount = mismatches.length;
  summary.renderIrParity = `${corpus.cases.length - irMismatch.length}/${corpus.cases.length}`;
  const describe = (m) => `${m.id} [${m.category}] first diff at ${m.diff.path}: web=${JSON.stringify(m.diff.web)} mobile=${JSON.stringify(m.diff.mobile)} (digests ${m.webDigest.slice(0, 12)} / ${m.mobileDigest.slice(0, 12)})`;
  /* The cross-surface verdict comes first (S5B's invariant), then each surface against the corpus. */
  assert.deepEqual(mismatches.map(describe), [], `cross-surface semantic mismatches:\n    ${mismatches.map(describe).join('\n    ')}`);
  assert.deepEqual(webFail, [], `Web boundary diverged from the corpus on: ${webFail.join(', ')}`);
  assert.deepEqual(mobileFail, [], `Mobile boundary diverged from the corpus on: ${mobileFail.join(', ')}`);
  assert.deepEqual(irMismatch.map((m) => `${m.id}: ${m.irDiff.path}`), [], 'Render IR normalization (incl. renderKeys) differs across surfaces');
  assert.deepEqual(irNotAdditive, [], 'Render IR normalization edited semantic payload (must only add renderKey/ownerRef)');
  assert.ok(perCase.every((p) => p.equal && p.webDigest === p.mobileDigest), 'digest diagnostics agree with deep equality');
});

check('formal corpus: every semantic field family is exercised by the parity payload (kinds, marks, levels, list state, code, tables, destinations, breaks)', () => {
  const all = JSON.stringify(corpus.cases.map((c) => c.expect.blocks));
  const kinds = new Set([...all.matchAll(/"kind":"([a-zA-Z]+)"/g)].map((m) => m[1]));
  for (const kind of ['heading', 'paragraph', 'text', 'list', 'listItem', 'blockquote', 'codeBlock', 'table', 'tableRow', 'tableCell', 'image', 'thematicBreak', 'hardBreak', 'link', 'strong', 'emphasis', 'code', 'strikethrough']) assert.ok(kinds.has(kind), `corpus exercises ${kind}`);
  for (const field of ['"level":', '"ordered":true', '"ordered":false', '"start":3', '"checked":true', '"checked":false', '"tight":', '"language":"js"', '"info":', '"code":', '"align":', '"header":true', '"href":', '"title":', '"src":', '"alt":']) assert.ok(all.includes(field), `corpus exercises ${field}`);
  summary.semanticFieldFamilies = [...kinds].sort();
});

/* Role envelope parity: content interpretation is content-driven; role is envelope only. */
check('role envelope: identical content yields identical semantic payload under user / assistant / system / tool on both surfaces (role stays external)', () => {
  const representative = corpus.cases.find((c) => c.id === 'cm-nested-list') || corpus.cases[0];
  const w = web.parse(representative.source); const m = mobile.parse(representative.source);
  assert.equal(w.fallback, false); assert.equal(m.fallback, false); assert.equal(firstDiff(w.blocks, m.blocks), null, 'cross-surface payload equal for the representative case');
  const perRole = ROLES.map((role) => {
    const doc = web.real.renderIR.createConversation({ id: 'h2o.render', messages: [{ id: 'h2o.message', role, blocks: w.blocks }] });
    assert.equal(web.real.renderIR.validate(doc).ok, true);
    assert.equal(doc.messages[0].role, role, 'the accepted contract carries role on the message envelope');
    return { role, blocks: JSON.parse(JSON.stringify(doc.messages[0].blocks)), mobile: mobile.parse(representative.source).blocks };
  });
  for (const entry of perRole.slice(1)) {
    assert.equal(firstDiff(perRole[0].blocks, entry.blocks), null, `Web IR content payload differs between roles ${perRole[0].role} and ${entry.role}`);
    assert.equal(firstDiff(perRole[0].mobile, entry.mobile), null, `Mobile payload differs between roles`);
  }
  assert.equal(firstDiff(perRole[0].mobile, w.blocks), null);
  /* Neither boundary takes a role into the parser: role never enters Markdown parsing. */
  assert.match(extractFunction(chatRendererSource, 'renderSemanticBody'), /^function renderSemanticBody\(bodyEl, source\)/, 'Web body parsing takes no role');
  assert.match(mobile.source, /export function parseMarkdownToRenderBlocks\(source: string\)/, 'Mobile parsing takes no role');
  summary.roleCount = ROLES.length; summary.roleContentParity = 'PASS';
});

/* Raw Markdown HTML stays literal text on both surfaces. */
check('raw Markdown HTML remains literal text on both surfaces (html:false; no trusted Markdown-HTML path; no opaque island)', () => {
  const sources = [...corpus.cases.filter((c) => /raw-html/.test(c.id)).map((c) => c.source), '<script>alert(1)</script>', '<div onclick="x()">y</div>', '<!-- comment -->', '<div>\nmultiline\n</div>'];
  assert.ok(sources.length >= 6, 'corpus raw-html cases + probes');
  for (const src of sources) {
    const w = web.parse(src); const m = mobile.parse(src);
    assert.equal(w.fallback, false); assert.equal(m.fallback, false);
    assert.equal(firstDiff(w.blocks, m.blocks), null, `raw HTML literal parity for ${JSON.stringify(src)}`);
    const text = JSON.stringify(w.blocks);
    assert.doesNotMatch(text, /opaqueProviderBlock|markdownHtml|"kind":"html"/, 'no HTML island / html kind');
    const literal = w.blocks.flatMap((b) => (b.children || [])).filter((n) => n.kind === 'text').map((n) => n.text).join('');
    assert.ok(literal.includes('<') && literal.includes('>'), `${JSON.stringify(src)}: the markup survives as literal text`);
  }
  summary.rawMarkdownHtmlMode = 'LITERAL_TEXT'; summary.rawMarkdownHtmlLiteralParity = 'PASS';
});

/* Parser / adapter failure: whole-message verbatim fallback on both surfaces. */
check('parser/adapter failure yields the identical whole-message verbatim fallback on both surfaces (no legacy parser, no partial parse)', () => {
  const brokenEngine = { parse() { throw new Error('engine exploded'); }, options: { html: false }, validateLink: () => true };
  const failing = '# heading\n\n- item\n\n```js\ncode\n```';
  const webFailing = loadWebSurface(); webFailing.injectEngine(brokenEngine);
  const w = webFailing.parse(failing);
  const mobileFailing = loadMobileBridge({ engineOverride: () => brokenEngine });
  const m = mobileFailing.parse(failing);
  assert.equal(w.fallback, true, 'Web renderSemanticBody returned false -> appendVerbatimBody'); assert.equal(w.adapterFallback, true, 'the shared adapter requested fallback'); assert.equal(w.bodyChildren, 1); assert.equal(w.bodyTag, 'P');
  assert.equal(m.fallback, true, 'Mobile bridge reports fallback'); assert.equal(m.blocks.length, 1);
  assert.equal(firstDiff(w.blocks, m.blocks), null, 'fallback semantic result identical: one verbatim paragraph');
  assert.equal(m.blocks[0].children[0].text, failing, "the author's characters survive verbatim");
  assert.doesNotMatch(JSON.stringify(m.blocks), /"kind":"heading"|codeBlock|"kind":"list"/, 'no partial / hybrid parse');
  /* The healthy surfaces are unaffected by the injected failure (separate instances). */
  assert.equal(web.parse(failing).fallback, false); assert.equal(mobile.parse(failing).fallback, false);
  /* No other Markdown implementation is reachable from the Mobile module graph. */
  const cache = createRequire(import.meta.url).cache || {};
  const loaded = Object.keys(cache).map((p) => path.relative(REPO_ROOT, p)).filter((p) => /markdown|remark|marked|micromark|commonmark|showdown|turndown/i.test(p));
  const foreign = loaded.filter((p) => !p.startsWith(`${MD_DIR_REL}/`) && !p.startsWith('node_modules/markdown-it/'));
  assert.deepEqual(foreign, [], `unexpected Markdown implementation loaded: ${foreign.join(', ')}`);
  assert.ok(loaded.some((p) => p.startsWith('node_modules/markdown-it/')), 'the Mobile path loaded the npm markdown-it');
  summary.wholeMessageFallbackParity = 'PASS'; summary.legacyParserUsed = 'NO';
});

/* Provider profile: explicit, bounded, declared, non-authority-creating. */
check('provider profile: chatgpt-web-dated differs from the formal base only by singleTilde on the declared cases; Mobile stays formal base; no undeclared variance', () => {
  const profiles = web.engineApi.providerProfiles;
  assert.deepEqual(JSON.parse(JSON.stringify(profiles)), { 'formal-base': { singleTilde: true }, 'chatgpt-web-dated': { singleTilde: false } }, 'exactly two profiles; the only varying option is singleTilde');
  const dated = web.engineApi.providerProfileEngine('chatgpt-web-dated');
  const differing = []; const declared = [];
  for (const c of corpus.cases) {
    const formal = web.real.markdownIrAdapter.markdownToBlocks(web.engine(), c.source);
    const profiled = web.real.markdownIrAdapter.markdownToBlocks(dated, c.source);
    const formalHasSingleTildeStrike = /(^|[^~])~[^~]/.test(c.source) && /strikethrough/.test(JSON.stringify(formal.blocks));
    if (formalHasSingleTildeStrike) declared.push(c.id);
    if (firstDiff(formal.blocks, profiled.blocks)) differing.push(c.id);
  }
  assert.deepEqual(differing.sort(), declared.sort(), `dated-profile variance must be exactly the declared single-tilde cases (differing: ${differing.join(', ')}; declared: ${declared.join(', ')})`);
  assert.ok(declared.length >= 1, 'the corpus carries at least one declared single-tilde case');
  for (const id of declared) {
    const c = corpus.cases.find((x) => x.id === id);
    assert.equal(firstDiff(web.parse(c.source).blocks, mobile.parse(c.source).blocks), null, `${id}: Web formal base == Mobile formal base (strikethrough kept)`);
    assert.match(JSON.stringify(mobile.parse(c.source).blocks), /strikethrough/, `${id}: Mobile keeps single-tilde strikethrough`);
  }
  /* Double tilde is strikethrough on every path; the formal engine is untouched by the profile. */
  assert.match(JSON.stringify(web.real.markdownIrAdapter.markdownToBlocks(dated, '~~gone~~').blocks), /strikethrough/);
  assert.match(JSON.stringify(web.parse('~gone~').blocks), /strikethrough/, 'the Web formal-base instance is not mutated by building a profile');
  summary.datedProviderProfileVariance = 'PASS'; summary.declaredProviderVarianceCases = declared; summary.undeclaredProviderVariance = differing.filter((id) => !declared.includes(id)).length;
  summary.providerFixtureClassification = 'SEMANTICS_PRESENTATION_FIXTURE_ONLY';
});

/* Parser version / shared-module proof through repository + import evidence. */
check('one shared parser architecture: markdown-it 15.0.1 on both surfaces, shared GFM/adapter, no bespoke Mobile parser, no second parser', () => {
  const pin = JSON.parse(readText(VENDOR_PIN_REL));
  assert.equal(pin.name, 'markdown-it'); assert.equal(pin.version, EXPECTED_ENGINE_VERSION);
  assert.equal(sha256(fs.readFileSync(abs(VENDOR_UMD_REL))), pin.sha256, 'vendored UMD bytes match the pin');
  assert.equal(web.engineApi.engineVersion, EXPECTED_ENGINE_VERSION, 'Web engine version');
  const mobileRequire = createRequire(mobileEnginePath);
  const mobileMarkdownItPkg = JSON.parse(fs.readFileSync(mobileRequire.resolve('markdown-it/package.json'), 'utf8'));
  assert.equal(mobileMarkdownItPkg.version, EXPECTED_ENGINE_VERSION, 'markdown-it resolved from the shared engine location (Metro/Node path)');
  const mobilePkg = JSON.parse(readText(MOBILE_PACKAGE_REL));
  assert.equal((mobilePkg.dependencies || {})['markdown-it'], EXPECTED_ENGINE_VERSION, 'Mobile declares markdown-it 15.0.1');
  assert.deepEqual(Object.keys({ ...(mobilePkg.dependencies || {}), ...(mobilePkg.devDependencies || {}) }).filter((k) => /markdown|marked|remark|micromark|commonmark|showdown/i.test(k)), ['markdown-it'], 'no other Markdown library on Mobile');
  assert.equal(mobile.captured.engineApi.engineVersion, EXPECTED_ENGINE_VERSION, 'Mobile engine version (captured through the bridge)');
  assert.equal(fs.existsSync(abs(MOBILE_BESPOKE_PARSER_REL)), false, 'retired bespoke parser is absent');
  const mobileSrcDir = abs('apps/studio/mobile/src');
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
  const offenders = walk(mobileSrcDir).filter((f) => /\.(ts|tsx|js|jsx)$/.test(f)).filter((f) => /from '\.\/parse'|require\(['"]\.\/parse['"]\)|react-native-markdown|from 'marked'|from 'remark|micromark|from 'commonmark'/.test(fs.readFileSync(f, 'utf8')));
  assert.deepEqual(offenders.map((f) => path.relative(REPO_ROOT, f)), [], 'no second parser import in Mobile source');
  /* The Web/Mobile shared GFM and adapter are the same bytes: the Web sandbox ran them from MD_DIR and the Mobile bridge required them from MD_DIR. */
  assert.ok(mobile.resolved.includes(`${MD_DIR_REL}/markdown-engine.v1.js`) && mobile.resolved.includes(`${MD_DIR_REL}/markdown-ir-adapter.v1.js`));
  assert.match(readText(`${MD_DIR_REL}/markdown-engine.v1.js`), /require\("\.\/h2o-gfm\.v1\.js"\)/, 'the engine resolves the shared GFM closure on the module path');
  summary.markdownItWebVersion = web.engineApi.engineVersion; summary.markdownItMobileVersion = mobileMarkdownItPkg.version;
  summary.secondParserPresent = 'NO'; summary.mobileBespokeParseTs = 'ABSENT';
  summary.sharedEnginePaths = [VENDOR_UMD_REL, `${MD_DIR_REL}/h2o-gfm.v1.js`, `${MD_DIR_REL}/markdown-engine.v1.js`, `${MD_DIR_REL}/markdown-ir-adapter.v1.js`, RENDER_IR_REL, 'node_modules/markdown-it (Mobile/Node resolution, 15.0.1)'];
});

/* Comparator sensitivity: one in-memory mutation must be detected with its path. */
check('negative semantic control: a single mutated field (ordered-list start) is detected by the same comparator with its exact path', () => {
  const c = corpus.cases.find((x) => x.id === 'cm-ordered-start');
  const w = web.parse(c.source); const m = mobile.parse(c.source);
  assert.equal(firstDiff(w.blocks, m.blocks), null, 'baseline equality before mutation');
  const mutated = JSON.parse(JSON.stringify(m.blocks));
  assert.equal(mutated[0].kind, 'list'); assert.equal(mutated[0].start, 3);
  mutated[0].start = 4;
  const diff = firstDiff(w.blocks, mutated);
  assert.ok(diff, 'comparator must report inequality');
  assert.equal(diff.path, '$[0].start'); assert.equal(diff.web, 3); assert.equal(diff.mobile, 4);
  assert.notEqual(digest(w.blocks), digest(mutated), 'digests diverge too');
  /* A second, nested mutation (code language) for depth sensitivity. */
  const code = corpus.cases.find((x) => x.id === 'cm-fenced-code-info');
  const mutatedCode = JSON.parse(JSON.stringify(mobile.parse(code.source).blocks)); mutatedCode[0].language = 'ts';
  const codeDiff = firstDiff(web.parse(code.source).blocks, mutatedCode);
  assert.equal(codeDiff && codeDiff.path, '$[0].language');
  /* Nothing was written; the shipped comparison stays green. */
  assert.equal(firstDiff(web.parse(c.source).blocks, mobile.parse(c.source).blocks), null);
  summary.negativeSemanticControl = 'PASS'; summary.firstDiffPath = diff.path; summary.negativeControlSecondaryPath = codeDiff.path;
});

summary.deepEqualityUsed = 'YES'; summary.digestDiagnostics = 'YES';
summary.digests = Object.fromEntries(perCase.map((p) => [p.id, p.webDigest]));
console.log(`SUMMARY ${JSON.stringify(summary)}`);
console.log(failures.length ? `FAIL ${failures.length} (passed ${checks.length})` : `PASS ${checks.length}`);
process.exit(failures.length ? 1 : 0);
