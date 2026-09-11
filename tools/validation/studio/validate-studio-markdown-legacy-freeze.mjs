#!/usr/bin/env node
// M03 P2 S2A T4 S0/S1 — legacy Markdown parser freeze + engine containment.
//
// T4 has started, so neither bespoke Markdown implementation may gain new
// behaviour during the bounded dual-path window. This pins a digest PER PARSER
// FUNCTION rather than a whole-file SHA, so unrelated edits elsewhere in those
// files stay possible while a semantic edit to the parsers is detected.
//
// It also checks the shape of the engine-agnostic conformance corpus, so the
// corpus cannot silently rot or acquire engine-specific token forms.
//
// S1 transition: the engine-NEGATIVE controls ("no engine exists anywhere")
// are replaced by exact CONTAINMENT assertions. markdown-it 15.0.1 is now
// admitted and vendored, so the useful control is no longer "absent" but
// "present in exactly the admitted places and nowhere else" - which is what
// keeps the engine unwired while Stage A and Stage B remain forbidden.

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), '..', '..', '..');
const WEB_REL = 'src-surfaces-base/studio/renderer/chat-renderer.studio.js';
const MOBILE_REL = 'apps/studio/mobile/src/renderer/parse.ts';
const CORPUS_REL = 'tools/validation/fixtures/studio-renderer-markdown/markdown-conformance.v1.json';
const CONTRACT_REL = 'src-surfaces-base/studio/renderer/markdown/README.md';

/* T5 retired the Web bespoke parser: the canonical Markdown body now renders
 * through the markdown engine, the Render IR contract and the typed
 * ContentRenderer. These names must therefore be ABSENT, not merely frozen.
 * The Mobile parser below stays frozen - its cutover is separate work. */
const WEB_RETIRED = Object.freeze([
  'renderInlineMarkdown',
  'countMarkdownIndent',
  'parseMarkdownListLine',
  'renderMarkdownList',
  'splitMarkdownTableRow',
  'parseMarkdownTableAlign',
  'parseMarkdownTableStart',
  'renderMarkdownTable',
  'renderTextAsChatGPTBlocks',
]);

const MOBILE_FROZEN = Object.freeze({
  parseMarkdown: 'fa891b8cd15c1766cbbd736967c32311c8ed461d4c9152e14ce6865874b2b6e5',
});

const CATEGORIES = Object.freeze(['FORMAL_COMMONMARK', 'FORMAL_GFM', 'H2O_POLICY', 'CURRENT_BEHAVIOR_MIGRATION']);

function repo(rel) { return fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8'); }
function sha256(text) { return crypto.createHash('sha256').update(text, 'utf8').digest('hex'); }

/* Brace-matched extraction: the same seam the Renderer contract validator uses. */
function extractFunction(source, name, prefix = 'function') {
  const match = new RegExp(`\\b${prefix}\\s+${name}\\s*\\(`).exec(source);
  if (!match) throw new Error(`freeze: '${name}' not found - the parser was renamed or removed`);
  const open = source.indexOf('{', match.index);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(match.index, i + 1);
    }
  }
  throw new Error(`freeze: unterminated '${name}'`);
}

const webSource = repo(WEB_REL);
const mobileSource = repo(MOBILE_REL);
const corpus = JSON.parse(repo(CORPUS_REL));
const contract = repo(CONTRACT_REL);

const checks = [];
function check(label, fn) {
  fn();
  checks.push(label);
  console.log(`✓ ${label}`);
}

check('the Web bespoke Markdown parser is retired, not merely frozen', () => {
  assert.equal(WEB_RETIRED.length, 9);
  const survivors = WEB_RETIRED.filter((name) => new RegExp(`\\bfunction\\s+${name}\\s*\\(`).test(webSource));
  assert.deepEqual(survivors, [],
    `retired Web parser functions are still defined: ${survivors.join(', ')}`);
  /* No call sites either - a retired parser must not be reachable. */
  const called = WEB_RETIRED.filter((name) => new RegExp(`\\b${name}\\s*\\(`).test(webSource));
  assert.deepEqual(called, [], `retired Web parser functions are still referenced: ${called.join(', ')}`);
  /* The canonical Markdown body path must not build HTML strings. */
  assert.doesNotMatch(webSource, /innerHTML\s*=\s*renderTextAsChatGPTBlocks/,
    'the canonical Markdown body must not be assigned through innerHTML');
});

check('the retirement check is non-vacuous', () => {
  /* RED: a re-introduced definition or call site must be detected. */
  for (const name of WEB_RETIRED) {
    assert.match(`function ${name}(x){}`, new RegExp(`\\bfunction\\s+${name}\\s*\\(`),
      `the detector would miss a re-introduced ${name} definition`);
    assert.match(`const out = ${name}(text);`, new RegExp(`\\b${name}\\s*\\(`),
      `the detector would miss a re-introduced ${name} call site`);
  }
  /* GREEN: the retired names must not appear merely because prose mentions
   * Markdown - the file still legitimately discusses markdown rendering. */
  assert.doesNotMatch('// markdown rendering notes', /\bfunction\s+renderInlineMarkdown\s*\(/);
});

check('Mobile bespoke Markdown parser is unchanged during the T4 freeze', () => {
  for (const [name, expected] of Object.entries(MOBILE_FROZEN)) {
    const actual = sha256(extractFunction(mobileSource, name, 'export function'));
    assert.equal(actual, expected, `${name} changed during the T4 freeze window`);
  }
});

check('the Mobile freeze detects a semantic edit rather than passing vacuously', () => {
  const original = extractFunction(mobileSource, 'parseMarkdown', 'export function');
  const mutated = `${original} /* edited */`;
  assert.notEqual(mutated, original, 'control mutation did not apply');
  assert.notEqual(sha256(mutated), MOBILE_FROZEN.parseMarkdown,
    'a changed parser body must produce a different digest');
});

check('conformance corpus declares the frozen T4 target and scope', () => {
  assert.equal(corpus.schema, 'h2o.renderer.markdown-conformance');
  assert.equal(corpus.schemaVersion, 1);
  assert.equal(corpus.commonmark, '0.31.2');
  assert.ok(corpus.outOfScope.includes('footnotes'), 'footnotes must stay out of T4 scope');
  for (const item of ['tables', 'task-list items', 'strikethrough', 'extended autolink literals']) {
    assert.ok(corpus.gfmScope.includes(item), `formal GFM scope must include ${item}`);
  }
});

check('every corpus case is well formed and engine-agnostic', () => {
  assert.ok(corpus.cases.length >= 30, `expected a substantive corpus, got ${corpus.cases.length}`);
  const ids = new Set();
  for (const c of corpus.cases) {
    assert.ok(c.id && !ids.has(c.id), `duplicate or missing case id: ${c.id}`);
    ids.add(c.id);
    assert.ok(CATEGORIES.includes(c.category), `${c.id}: unknown category ${c.category}`);
    assert.equal(typeof c.source, 'string', `${c.id}: source must be a string`);
    assert.ok(Array.isArray(c.expect?.blocks), `${c.id}: expect.blocks must be an array`);
  }
  for (const category of CATEGORIES) {
    assert.ok(corpus.cases.some((c) => c.category === category), `no case for ${category}`);
  }
  /* Expectations are Render IR projections: no render keys, no engine tokens. */
  const serialized = JSON.stringify(corpus.cases.map((c) => c.expect));
  for (const forbidden of ['renderKey', 'micromark', 'markdown-it', 'mdast', 'tokenize', 'nodeType']) {
    assert.doesNotMatch(serialized, new RegExp(forbidden, 'i'), `corpus expectations must not encode ${forbidden}`);
  }
});

check('corpus covers the representative constructs T4 must decide', () => {
  const ids = corpus.cases.map((c) => c.id).join(' ');
  for (const needle of ['heading-4-6', 'thematic-break', 'hard-break', 'soft-break', 'fenced-code',
    'nested-list', 'ordered-start', 'task-list', 'table-alignment', 'strikethrough-single',
    'autolink-www', 'autolink-http', 'autolink-email', 'autolink-protocol', 'raw-html', 'escapes', 'entities']) {
    assert.ok(ids.includes(needle), `corpus is missing a case for ${needle}`);
  }
  /* The new vocabulary-2 kinds must actually appear in expectations. */
  const serialized = JSON.stringify(corpus.cases.map((c) => c.expect));
  assert.match(serialized, /"thematicBreak"/);
  assert.match(serialized, /"hardBreak"/);
});

check('the T4 contract records the frozen decisions and the admitted engine', () => {
  assert.match(contract, /CommonMark 0\.31\.2/);
  assert.match(contract, /[Ff]ootnotes are outside T4/);
  assert.match(contract, /classifyUrl/);
  assert.match(contract, /literal semantic text/);
  assert.match(contract, /DIRECTLY_EVIDENCED_PROVIDER_PROFILE/);
  assert.match(contract, /EXPLICITLY_OUT_OF_SCOPE_FEATURE/);
  assert.doesNotMatch(contract, /vocabularyVersion/,
    'the removed vocabulary-version axis must not reappear in the contract');
  /* S1: the admitted engine is recorded, and recorded as still unwired. */
  assert.match(contract, /markdown-it 15\.0\.1/, 'contract must record the admitted engine');
  assert.match(contract, /unwired/i, 'contract must record that the engine is not yet wired');
  assert.doesNotMatch(contract, /pending governed admission/,
    'engine selection is no longer pending - the contract must not still say so');
  /* The engines that were NOT chosen must still not be named as accepted. */
  for (const engine of ['micromark', 'remark', 'marked', 'commonmark']) {
    assert.doesNotMatch(contract, new RegExp(`(accepted|selected|admitted)\\s+${engine}`, 'i'),
      `contract must not name ${engine} as accepted`);
  }
});

check('the admitted engine is contained in exactly its authorized locations', () => {
  /* The engine is a Mobile package dependency and a Studio vendored artifact.
   * It is deliberately NOT a root dependency on any surface. */
  const pkg = JSON.parse(repo('package.json'));
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    for (const engine of ['micromark', 'markdown-it', 'remark', 'marked', 'commonmark']) {
      assert.equal(Object.prototype.hasOwnProperty.call(pkg[field] || {}, engine), false,
        `${engine} must not be a ROOT package dependency`);
    }
  }
  /* Exact file set of the Renderer markdown directory. */
  const markdownDir = path.join(REPO_ROOT, 'src-surfaces-base/studio/renderer/markdown');
  assert.deepEqual(fs.readdirSync(markdownDir).sort(),
    ['README.md', 'h2o-gfm.v1.js', 'markdown-engine.v1.js', 'markdown-ir-adapter.v1.js', 'vendor'],
    'the markdown directory must hold exactly the contract, the three first-party sources and vendor/');
  assert.deepEqual(fs.readdirSync(path.join(markdownDir, 'vendor')).sort(), ['markdown-it'],
    'vendor/ must hold exactly the admitted engine');
  assert.deepEqual(fs.readdirSync(path.join(markdownDir, 'vendor/markdown-it')).sort(),
    ['PIN.json', 'THIRD_PARTY_NOTICES', 'markdown-it.umd.min.js'],
    'the vendor directory file set is governed and exact');
  /* No competing engine may be vendored beside it. */
  for (const engine of ['micromark', 'remark', 'marked', 'commonmark']) {
    assert.ok(!fs.existsSync(path.join(markdownDir, 'vendor', engine)),
      `${engine} must not be vendored - one engine is admitted`);
  }
});

check('the Mobile bespoke parser stays free of the Web engine', () => {
  /* Mobile cutover is separate work: the Web engine must not leak into the
   * Mobile parser while its freeze still stands. The Stage-A packlists,
   * studio.html, the publisher and the activator all legitimately NAME these
   * files - delivery and load admission are exactly what those files do - so
   * they are deliberately not asserted here. Their real invariant is order
   * agreement, checked below. */
  assert.doesNotMatch(mobileSource,
    /markdown-it|markdown-engine\.v1|markdown-ir-adapter\.v1|h2o-gfm\.v1|content-renderer\.v1/,
    `${MOBILE_REL} must not reference the Web markdown engine`);
});

check('studio.html, publisher and activator agree on the semantic load order', () => {
  const html = repo('src-surfaces-base/studio/studio.html');
  /* Cache-bust queries are presentation, not identity - strip them, exactly as
   * the packer's own ref parser does. */
  const refs = [...html.matchAll(/<script\s+src="\.\/([^"]+)"/g)]
    .map((m) => m[1].split('?')[0]);
  const order = (source, rel) => {
    const at = source.indexOf('const STUDIO_REQUIRED_ORDER = Object.freeze([');
    assert.notEqual(at, -1, `${rel} has no STUDIO_REQUIRED_ORDER`);
    const body = source.slice(at, source.indexOf(']);', at));
    return [...body.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  };
  const publisher = order(repo('tools/publish/lean-publisher.mjs'), 'lean-publisher.mjs');
  const activator = order(repo('tools/publish/lean-activator.mjs'), 'lean-activator.mjs');
  assert.deepEqual(publisher, activator, 'publisher and activator required order disagree');

  const positions = publisher.map((name) => refs.indexOf(name));
  const missing = publisher.filter((name, i) => positions[i] === -1);
  assert.deepEqual(missing, [], `required-order entries absent from studio.html: ${missing.join(', ')}`);
  for (let i = 1; i < positions.length; i += 1) {
    assert.ok(positions[i] > positions[i - 1],
      `studio.html loads ${publisher[i]} before ${publisher[i - 1]}, contradicting the required order`);
  }

  /* The semantic chain must actually be present and correctly sequenced. */
  for (const name of [
    'renderer/markdown/vendor/markdown-it/markdown-it.umd.min.js',
    'renderer/markdown/h2o-gfm.v1.js',
    'renderer/markdown/markdown-engine.v1.js',
    'renderer/markdown/markdown-ir-adapter.v1.js',
    'renderer/semantic/render-ir.v1.js',
    'renderer/semantic/semantic-ingress.v1.js',
    'renderer/content/content-renderer.v1.js',
    'renderer/chat-renderer.studio.js',
  ]) {
    assert.ok(publisher.includes(name), `required order is missing ${name}`);
    assert.equal(refs.filter((r) => r === name).length, 1, `${name} must be loaded exactly once`);
  }
  /* Dependency order inside the semantic chain, then the consumer last. */
  assert.ok(refs.indexOf('renderer/semantic/semantic-ingress.v1.js') > refs.indexOf('renderer/semantic/render-ir.v1.js'),
    'semantic ingress must load after the Render IR contract it builds on');
  assert.ok(refs.indexOf('renderer/content/content-renderer.v1.js') > refs.indexOf('renderer/semantic/semantic-ingress.v1.js'),
    'the ContentRenderer must load after semantic ingress');
  assert.ok(refs.indexOf('renderer/chat-renderer.studio.js')
    > refs.indexOf('renderer/content/content-renderer.v1.js'),
    'the Renderer must load after the ContentRenderer it consumes');

  /* Licence material is delivered, never executed. */
  assert.doesNotMatch(html, /<script[^>]*THIRD_PARTY_NOTICES/, 'notices must not be a script');
  assert.doesNotMatch(html, /<script[^>]*PIN\.json/, 'PIN.json must not be a script');
});

console.log(`PASS ${checks.length}`);
