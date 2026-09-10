#!/usr/bin/env node
// M03 P2 S2A T4 S0 — legacy Markdown parser freeze + engine-agnostic corpus shape.
//
// T4 has started, so neither bespoke Markdown implementation may gain new
// behaviour during the bounded dual-path window. This pins a digest PER PARSER
// FUNCTION rather than a whole-file SHA, so unrelated edits elsewhere in those
// files stay possible while a semantic edit to the parsers is detected.
//
// It also checks the shape of the engine-agnostic conformance corpus, so the
// corpus cannot silently rot or acquire engine-specific token forms before an
// engine is admitted.

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

/* Frozen at the accepted P1 baseline. A changed digest is not automatically a
 * defect - it means a bespoke parser moved during the freeze window and needs a
 * governed decision, not a silent re-pin. */
const WEB_FROZEN = Object.freeze({
  renderInlineMarkdown: 'bfe386e08278824128994432e2292c02b8e934badc14b5c6ccc53e38b4fd8017',
  countMarkdownIndent: 'a6d45d930e1a466eb4ceba8be797bd4c9470df2573ae8d776271c8784e98c40c',
  parseMarkdownListLine: '8d3f21fbb384947a8f8be1c6f82b6c1bb3c4c92083cb56e3605e8e00acdc7383',
  renderMarkdownList: 'd340f95768fd73df3f86f4284ad576d78b6a9f080f85f39880edc8c134ee713e',
  splitMarkdownTableRow: '84a6fc1dff2175f910213ad4fd5d2289f7383310e113040b138c7670f7494a7c',
  parseMarkdownTableAlign: '9653b37c6d5e2d49aeda08799d7ef68442b2328d18e70f7b2e91ba4f8041c894',
  parseMarkdownTableStart: '1421ad29b539448130d368511e6632f847f530071bb24c9729675f015ecb58f0',
  renderMarkdownTable: '939de74045298bda745741d43651424441f7125f0302ef77a770cc5f02d8acb2',
  renderTextAsChatGPTBlocks: '15ed1b6ce0c7f502f452cf25f5777bd780919134b6095549d0b772b674e8de25',
});
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

check('Web bespoke Markdown parser functions are unchanged during the T4 freeze', () => {
  for (const [name, expected] of Object.entries(WEB_FROZEN)) {
    const actual = sha256(extractFunction(webSource, name));
    assert.equal(actual, expected,
      `${name} changed during the T4 freeze window; a semantic edit to the legacy parser needs a governed decision`);
  }
  assert.equal(Object.keys(WEB_FROZEN).length, 9);
});

check('Mobile bespoke Markdown parser is unchanged during the T4 freeze', () => {
  for (const [name, expected] of Object.entries(MOBILE_FROZEN)) {
    const actual = sha256(extractFunction(mobileSource, name, 'export function'));
    assert.equal(actual, expected, `${name} changed during the T4 freeze window`);
  }
});

check('the freeze detects a semantic edit rather than passing vacuously', () => {
  const original = extractFunction(webSource, 'renderTextAsChatGPTBlocks');
  const mutated = original.replace('const out = [];', 'const out = []; /* edited */');
  assert.notEqual(mutated, original, 'control mutation did not apply');
  assert.notEqual(sha256(mutated), WEB_FROZEN.renderTextAsChatGPTBlocks,
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

check('the T4 contract records the frozen decisions and names no accepted engine', () => {
  assert.match(contract, /CommonMark 0\.31\.2/);
  assert.match(contract, /[Ff]ootnotes are outside T4/);
  assert.match(contract, /classifyUrl/);
  assert.match(contract, /literal semantic text/);
  assert.match(contract, /DIRECTLY_EVIDENCED_PROVIDER_PROFILE/);
  assert.match(contract, /EXPLICITLY_OUT_OF_SCOPE_FEATURE/);
  assert.doesNotMatch(contract, /vocabularyVersion/,
    'the removed vocabulary-version axis must not reappear in the contract');
  assert.match(contract, /pending governed admission/);
  for (const engine of ['micromark', 'markdown-it', 'remark', 'marked']) {
    assert.doesNotMatch(contract, new RegExp(`(accepted|selected|admitted)\\s+${engine}`, 'i'),
      `contract must not name ${engine} as accepted while selection is pending`);
  }
});

check('S0 introduced no engine dependency anywhere in the repository surface', () => {
  const pkg = JSON.parse(repo('package.json'));
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    for (const engine of ['micromark', 'markdown-it', 'remark', 'marked', 'commonmark']) {
      assert.equal(Object.prototype.hasOwnProperty.call(pkg[field] || {}, engine), false,
        `${engine} must not be a package dependency during S0`);
    }
  }
  const markdownDir = path.join(REPO_ROOT, 'src-surfaces-base/studio/renderer/markdown');
  assert.deepEqual(fs.readdirSync(markdownDir).sort(), ['README.md'],
    'S0 contributes contract documentation only - no parser, adapter or vendored engine');
});

console.log(`PASS ${checks.length}`);
