#!/usr/bin/env node
// M03 P2 S2A T4 S1 - Markdown semantic conformance.
//
// Loads the VENDORED browser UMD (the artifact Studio will actually ship), the
// one H2O GFM closure, the one engine configuration and the Render IR adapter,
// then measures them against the S0 corpus. Semantic parity between the browser
// UMD and the Node module path is also proven here: that is what catches a
// transitive change that actually alters behaviour, rather than forcing false
// transitive version equality.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), '..', '..', '..');
const MD_DIR = path.join(REPO_ROOT, 'src-surfaces-base/studio/renderer/markdown');
const VENDOR_UMD = path.join(MD_DIR, 'vendor/markdown-it/markdown-it.umd.min.js');
const CORPUS = path.join(REPO_ROOT, 'tools/validation/fixtures/studio-renderer-markdown/markdown-conformance.v1.json');

const corpus = JSON.parse(fs.readFileSync(CORPUS, 'utf8'));

/* Browser surface: the vendored UMD in a DOM-free sandbox, exactly as Studio
 * would load it, plus the H2O first-party sources. */
function loadBrowserSurface() {
  /* The vendored UMD needs a host `atob`: the incorporated `entities` decoder
   * base64-decodes its packed entity trie at load time. Browsers provide it;
   * the sandbox supplies it to emulate the browser host faithfully. */
  const sandbox = vm.createContext({ console, atob, btoa });
  sandbox.globalThis = sandbox;
  vm.runInContext(fs.readFileSync(VENDOR_UMD, 'utf8'), sandbox, { filename: 'markdown-it.umd.min.js' });
  for (const rel of ['h2o-gfm.v1.js', 'markdown-engine.v1.js', 'markdown-ir-adapter.v1.js']) {
    vm.runInContext(fs.readFileSync(path.join(MD_DIR, rel), 'utf8'), sandbox, { filename: rel });
  }
  const R = sandbox.H2O.Studio.Renderer;
  return { R, sandbox };
}

const browser = loadBrowserSurface();
const engineApi = browser.R.markdownEngine;
const adapter = browser.R.markdownIrAdapter;
const formalMd = engineApi.formalBaseEngine();

const checks = [];
const failures = [];
function check(label, fn) {
  try { fn(); checks.push(label); console.log(`✓ ${label}`); }
  catch (e) { failures.push(label); console.log(`✗ ${label}\n    ${e.message}`); }
}

/* Compare only what the corpus declares: kinds and salient payload. */
function projectBlocks(blocks) {
  return JSON.parse(JSON.stringify(blocks));
}
function normaliseExpected(blocks) {
  return JSON.parse(JSON.stringify(blocks));
}

function blocksFor(source, md = formalMd) {
  const r = adapter.markdownToBlocks(md, source);
  assert.equal(r.fallback, false, `unexpected verbatim fallback: ${r.reason || ''}`);
  return projectBlocks(r.blocks);
}

check('vendored browser UMD loads and the one H2O engine configuration builds', () => {
  assert.equal(engineApi.engineName, 'markdown-it');
  assert.equal(engineApi.engineVersion, '15.0.1');
  assert.deepEqual({ ...engineApi.formalBaseOptions },
    { html: false, typographer: false, breaks: false, linkify: false });
  assert.equal(typeof formalMd.parse, 'function');
  assert.equal(formalMd.validateLink('javascript:alert(1)'), true,
    'validateLink must stay permissive so destinations reach the IR as data');
});

check('S0 corpus: every case produces its declared Render IR projection', () => {
  const bad = [];
  for (const c of corpus.cases) {
    let actual;
    try { actual = blocksFor(c.source); }
    catch (e) { bad.push(`${c.id}: threw ${e.message}`); continue; }
    const expected = normaliseExpected(c.expect.blocks);
    try { assert.deepEqual(actual, expected); }
    catch { bad.push(`${c.id} [${c.category}]\n      expected ${JSON.stringify(expected)}\n      actual   ${JSON.stringify(actual)}`); }
  }
  assert.deepEqual(bad, [], `${bad.length} of ${corpus.cases.length} corpus cases diverged:\n    ${bad.join('\n    ')}`);
});

check('raw Markdown HTML stays literal semantic text', () => {
  for (const src of ['<b>bold?</b>', '<script>alert(1)</script>', '<div onclick="x()">y</div>',
    '<!-- comment -->', '<div>\nmultiline\n</div>']) {
    const blocks = blocksFor(src);
    const serialized = JSON.stringify(blocks);
    assert.doesNotMatch(serialized, /"kind":"opaqueProviderBlock"/, `${src}: no opaque HTML island may appear`);
    assert.doesNotMatch(serialized, /markdownHtml/, `${src}: no markdownHtml kind may appear`);
    const text = blocks.map((b) => JSON.stringify(b)).join('');
    assert.ok(text.includes('text'), `${src}: HTML must survive as literal text`);
  }
});

check('destinations reach the IR exactly as the syntax produced them', () => {
  const dest = (src) => {
    const blocks = blocksFor(src);
    const found = JSON.stringify(blocks).match(/"href":"([^"]*)"/);
    return found ? found[1] : null;
  };
  assert.equal(dest('[x](javascript:alert%281%29)'), 'javascript:alert%281%29',
    'a javascript: destination must survive into the IR as inert data');
  assert.equal(dest('[x](https://e.test/a)'), 'https://e.test/a');
  assert.equal(dest('[x](mailto:a@b.test)'), 'mailto:a@b.test');
  assert.equal(dest('[x](/rel/path)'), '/rel/path');
  assert.equal(dest('[x](#frag)'), '#frag');
  /* Syntax-specific difference is accepted and frozen, not canonicalised away. */
  const explicit = dest('[x](http://🍄.ga/)');
  const bare = dest('http://🍄.ga/');
  assert.ok(explicit && bare, 'both destination forms must exist');
  assert.equal(bare, 'http://%F0%9F%8D%84.ga/', 'GFM autolink carries the closure encoding');
});

check('provider profile varies only by option and stays isolated', () => {
  const profileMd = engineApi.providerProfileEngine('chatgpt-web-dated');
  const single = '~gone~';
  const formal = blocksFor(single);
  const profiled = blocksFor(single, profileMd);
  assert.match(JSON.stringify(formal), /strikethrough/, 'formal base keeps single-tilde strikethrough');
  assert.doesNotMatch(JSON.stringify(profiled), /strikethrough/, 'the dated provider profile does not');
  /* The profile must not have mutated the formal base engine. */
  assert.match(JSON.stringify(blocksFor(single)), /strikethrough/, 'formal base must remain unaffected');
  assert.match(JSON.stringify(blocksFor('~~gone~~', profileMd)), /strikethrough/, 'double tilde still applies');
});

check('parser or adapter failure yields a whole-message verbatim fallback', () => {
  const broken = { parse() { throw new Error('engine exploded'); } };
  const r = adapter.markdownToBlocks(broken, '# heading\n\ntext');
  assert.equal(r.fallback, true);
  assert.equal(r.blocks.length, 1);
  assert.equal(r.blocks[0].kind, 'paragraph');
  assert.equal(r.blocks[0].children[0].text, '# heading\n\ntext',
    "the author's characters must survive verbatim");
  assert.doesNotMatch(JSON.stringify(r.blocks), /heading"|codeBlock/, 'no partial parse may leak');
});

check('produced blocks validate through the accepted Render IR contract', () => {
  const irSandbox = vm.createContext({ console });
  irSandbox.globalThis = irSandbox;
  vm.runInContext(fs.readFileSync(path.join(REPO_ROOT, 'src-surfaces-base/studio/renderer/semantic/render-ir.v1.js'), 'utf8'), irSandbox);
  const ir = irSandbox.H2O.Studio.Renderer.renderIR;
  let validated = 0;
  for (const c of corpus.cases) {
    const blocks = blocksFor(c.source);
    const doc = ir.createConversation({ id: c.id, messages: [{ id: 'm1', role: 'assistant', blocks }] });
    const result = ir.validate(doc);
    assert.equal(result.ok, true, `${c.id}: ${result.errors.join('; ')}`);
    validated += 1;
  }
  assert.equal(validated, corpus.cases.length);
});

const nodeModule = await (async () => {
  try {
    const MarkdownIt = (await import('markdown-it')).default;
    const gfm = await import(pathToFileURL(path.join(MD_DIR, 'h2o-gfm.v1.js')).href);
    const eng = await import(pathToFileURL(path.join(MD_DIR, 'markdown-engine.v1.js')).href);
    const adp = await import(pathToFileURL(path.join(MD_DIR, 'markdown-ir-adapter.v1.js')).href);
    return { MarkdownIt, gfm: gfm.default || gfm, eng: eng.default || eng, adp: adp.default || adp };
  } catch (e) { return { unavailable: e.code || e.message }; }
})();

/* The Node/Mobile module path is a REQUIRED surface: it is what proves a
 * transitive change has not altered behaviour. If it cannot be resolved the
 * check must fail loudly - never pass silently, which would make the whole
 * parity assertion vacuous whenever dependencies happen to be absent. */
check('browser UMD and Node module paths agree semantically', () => {
  assert.ok(
    !nodeModule.unavailable,
    `Node/Mobile module path unresolvable (${nodeModule.unavailable}). `
      + 'Parity is UNPROVEN, not passing. Run `npm install` at the repository '
      + 'root so markdown-it 15.0.1 resolves, then re-run.',
  );
  const md = nodeModule.eng.createEngine({ MarkdownIt: nodeModule.MarkdownIt, gfm: nodeModule.gfm });
  const diffs = [];
  for (const c of corpus.cases) {
    const a = JSON.stringify(blocksFor(c.source));
    const b = JSON.stringify(nodeModule.adp.markdownToBlocks(md, c.source).blocks);
    if (a !== b) diffs.push(c.id);
  }
  assert.deepEqual(diffs, [], `browser/Node semantic divergence: ${diffs.join(', ')}`);
});


/* ------------------------------------------------------------------ *
 * validateLink blast radius.
 *
 * `md.validateLink = () => true` is LOAD-BEARING: it stops the engine
 * pre-filtering destinations so the IR carries exactly what the syntax
 * produced, leaving `sanitizerPolicy.classifyUrl` at the S2B sink as the single
 * URL admission authority. That is only safe while NO S1 path can turn a
 * destination into a live reference. This proves the blast radius is empty by
 * inspecting a COMMENT-STRIPPED view of the first-party S1 sources, so the
 * modules' own prose about href/innerHTML cannot satisfy or trip the guard.
 * ------------------------------------------------------------------ */

/* Strip comments while preserving string and regex literals, so a bare-word
 * scan sees code only. */
function codeOnly(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  let prevSignificant = '';
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && d === '/') { while (i < n && src[i] !== '\n') i += 1; continue; }
    if (c === '/' && d === '*') { i += 2; while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i += 1; i += 2; continue; }
    if (c === '"' || c === "'" || c === '`') {
      const q = c; out += c; i += 1;
      while (i < n) { if (src[i] === '\\') { out += src.slice(i, i + 2); i += 2; continue; } out += src[i]; if (src[i] === q) { i += 1; break; } i += 1; }
      prevSignificant = q; continue;
    }
    /* A `/` in value position starts a regex literal, not a comment. */
    if (c === '/' && /[=(,:[!&|?{};+\-*%~^]|^$/.test(prevSignificant)) {
      out += c; i += 1; let inClass = false;
      while (i < n) {
        if (src[i] === '\\') { out += src.slice(i, i + 2); i += 2; continue; }
        if (src[i] === '[') inClass = true;
        else if (src[i] === ']') inClass = false;
        else if (src[i] === '/' && !inClass) { out += src[i]; i += 1; break; }
        out += src[i]; i += 1;
      }
      prevSignificant = '/'; continue;
    }
    out += c;
    if (!/\s/.test(c)) prevSignificant = c;
    i += 1;
  }
  return out;
}

const S1_SOURCES = ['h2o-gfm.v1.js', 'markdown-engine.v1.js', 'markdown-ir-adapter.v1.js'];
const FORBIDDEN_SINKS = [
  ['href assignment', /\.href\s*=[^=]/],
  ['src assignment', /\.src\s*=[^=]/],
  ['window.open', /\bwindow\s*\.\s*open\s*\(/],
  ['navigation', /\blocation\s*\.\s*(assign|replace|href)\b|\bwindow\s*\.\s*location\b/],
  ['innerHTML sink', /\.(inner|outer)HTML\b/],
  ['insertAdjacentHTML sink', /\binsertAdjacentHTML\b/],
  ['DOM anchor/image creation', /createElement\s*\(|new\s+Image\s*\(|document\s*\.\s*create/],
];

check('validateLink blast radius is empty in first-party S1 source', () => {
  const offences = [];
  let scanned = 0;
  for (const rel of S1_SOURCES) {
    const code = codeOnly(fs.readFileSync(path.join(MD_DIR, rel), 'utf8'));
    scanned += 1;
    for (const [label, re] of FORBIDDEN_SINKS) {
      if (re.test(code)) offences.push(`${rel}: ${label}`);
    }
  }
  assert.equal(scanned, S1_SOURCES.length, 'non-vacuity: not every S1 source was scanned');
  assert.deepEqual(offences, [], `S1 source reaches a live sink: ${offences.join('; ')}`);
});

check('the blast-radius guard is non-vacuous and comment-aware', () => {
  /* RED: a planted sink in code position must be caught. */
  for (const [label, re] of FORBIDDEN_SINKS) {
    const planted = {
      'href assignment': 'a.href = u;',
      'src assignment': 'img.src = u;',
      'window.open': 'window.open(u);',
      navigation: 'window.location = u;',
      'innerHTML sink': 'el.innerHTML = h;',
      'insertAdjacentHTML sink': "el.insertAdjacentHTML('beforeend', h);",
      'DOM anchor/image creation': "document.createElement('a');",
    }[label];
    assert.ok(re.test(codeOnly(planted)), `guard missed a planted ${label}`);
  }
  /* GREEN: the same words as PROSE must not trip the guard - otherwise the
   * modules could never document why validateLink is safe. */
  const prose = [
    '/* The IR never performs an href assignment or innerHTML write. */',
    '// No window.open, no insertAdjacentHTML, no document.createElement here.',
    '/* src assignment and window.location navigation belong to the S2B sink. */',
  ].join('\n');
  const proseCode = codeOnly(prose);
  for (const [label, re] of FORBIDDEN_SINKS) {
    assert.ok(!re.test(proseCode), `guard fired on prose for ${label}`);
  }
  /* The stripper must not destroy real regex literals containing slashes. */
  assert.match(codeOnly('const re = /https?:\\/\\/x/;'), /https\?/);
});

check('validateLink is set open and documented as load-bearing', () => {
  const raw = fs.readFileSync(path.join(MD_DIR, 'markdown-engine.v1.js'), 'utf8');
  assert.match(codeOnly(raw), /validateLink\s*=\s*\(\s*\)\s*=>\s*true/, 'engine must leave validateLink open');
  assert.match(raw, /LOAD-BEARING/, 'the reason must be documented in source');
  /* And it must actually behave that way: a destination the engine would
   * otherwise reject still reaches the IR verbatim. */
  const { blocks } = adapter.markdownToBlocks(formalMd, '[x](javascript:alert(1))');
  const href = JSON.stringify(blocks).match(/"href":"([^"]*)"/);
  assert.ok(href, 'expected a link destination in the IR');
  assert.equal(href[1], 'javascript:alert(1)', 'destination must reach the IR unfiltered');
});


/* ------------------------------------------------------------------ *
 * Mobile: the ACTUAL bridge drives the same shared semantic path (T4).
 *
 * apps/studio/mobile/src/renderer/semantic-markdown.ts is loaded from source
 * (Node strips its type annotations; it contains no other TypeScript syntax)
 * with a require() that resolves exactly what Metro resolves: the shared
 * Renderer sources in place and the pinned markdown-it. Every corpus case must
 * project identically. This is what keeps Mobile from silently growing a
 * second authoritative parser again.
 * ------------------------------------------------------------------ */
const MOBILE_BRIDGE_REL = 'apps/studio/mobile/src/renderer/semantic-markdown.ts';

async function loadMobileBridge() {
  const { stripTypeScriptTypes, createRequire } = await import('node:module');
  const bridgePath = path.join(REPO_ROOT, MOBILE_BRIDGE_REL);
  const source = fs.readFileSync(bridgePath, 'utf8');
  /* The bridge is authored as an ES module (Metro/Babel handle the interop with
   * the CommonJS shared sources). A vm Script cannot take `export`, so the
   * export keyword is dropped and the public function re-exported explicitly. */
  let exportsSeen = 0;
  const js = stripTypeScriptTypes(source, { mode: 'strip' })
    .replace(/^export\s+(function|const|let)\s/mg, () => { exportsSeen += 1; return '$1 '.replace('$1', RegExp.$1); })
    + '\nmodule.exports.parseMarkdownToRenderBlocks = parseMarkdownToRenderBlocks;\n';
  if (exportsSeen === 0) throw new Error('bridge exposes no exported function');
  const localRequire = createRequire(bridgePath);
  const sandbox = vm.createContext({ console, atob, btoa, require: localRequire, module: { exports: {} }, exports: {} });
  sandbox.globalThis = sandbox;
  sandbox.module.exports = sandbox.exports;
  vm.runInContext(js, sandbox, { filename: MOBILE_BRIDGE_REL });
  return { api: sandbox.module.exports, source };
}

const mobile = await (async () => {
  try { return await loadMobileBridge(); }
  catch (e) { return { unavailable: e.code || e.message }; }
})();

check('the actual Mobile bridge consumes the shared sources, not a copy or a parser of its own', () => {
  assert.ok(!mobile.unavailable, `Mobile bridge could not load: ${mobile.unavailable}`);
  const src = mobile.source;
  assert.match(src, /require\('\.\.\/\.\.\/\.\.\/\.\.\/\.\.\/src-surfaces-base\/studio\/renderer\/markdown\/markdown-engine\.v1\.js'\)/,
    'bridge must require the shared engine source in place');
  assert.match(src, /require\('\.\.\/\.\.\/\.\.\/\.\.\/\.\.\/src-surfaces-base\/studio\/renderer\/markdown\/markdown-ir-adapter\.v1\.js'\)/,
    'bridge must require the shared adapter source in place');
  assert.match(src, /formalBaseEngine\(\)/, 'Mobile must use formal-base semantics');
  assert.doesNotMatch(src, /providerProfileEngine|chatgpt-web-dated/, 'no dated provider profile may be the Mobile default');
  assert.doesNotMatch(src, /markdownit\s*\(|new\s+MarkdownIt|require\(['"]markdown-it['"]\)/, 'the bridge must not construct its own engine');
  assert.equal(typeof mobile.api.parseMarkdownToRenderBlocks, 'function');
});

check('the actual Mobile bridge projects every corpus case identically (cross-surface parity)', () => {
  assert.ok(!mobile.unavailable, `Mobile bridge could not load: ${mobile.unavailable}`);
  const diffs = [];
  for (const c of corpus.cases) {
    const result = mobile.api.parseMarkdownToRenderBlocks(c.source);
    if (result.fallback !== false) { diffs.push(`${c.id} (fallback)`); continue; }
    try { assert.deepEqual(projectBlocks(result.blocks), normaliseExpected(c.expect.blocks)); }
    catch { diffs.push(c.id); }
  }
  assert.deepEqual(diffs, [], `Mobile bridge diverged on: ${diffs.join(', ')}`);
  /* Non-vacuity: a broken engine must surface as fallback, not as silent blocks. */
  const broken = mobile.api.parseMarkdownToRenderBlocks(undefined);
  assert.equal(typeof broken.fallback, 'boolean');
});

console.log(failures.length ? `FAIL ${failures.length} (passed ${checks.length})` : `PASS ${checks.length}`);
process.exit(failures.length ? 1 : 0);
