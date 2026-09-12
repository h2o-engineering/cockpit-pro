#!/usr/bin/env node
// Validator for Studio Reader & Notes MVP-A2a.4.2:
// read-only highlight-resolution consumer adapter.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), '..', '..', '..');

const CORE_REL = 'src-surfaces-base/studio/reader-notes/anchor-resolver.studio.js';
const DOM_REL = 'src-surfaces-base/studio/reader-notes/anchor-resolver-dom.studio.js';
const CONSUMER_REL = 'src-surfaces-base/studio/reader-notes/highlight-resolution-consumer.studio.js';
const STUDIO_HTML_REL = 'src-surfaces-base/studio/studio.html';
const PACK_REL = 'tools/product/studio/pack-studio.mjs';
const EVIDENCE_REL = 'release-evidence/2026-07-01/reader-notes-a2a4-highlight-resolution-consumer.md';
const A2A4_1_EVIDENCE_REL = 'release-evidence/2026-07-01/reader-notes-a2a4-consumer-readiness.md';

const A2A3_VALIDATOR_REL = 'tools/validation/reader-notes/validate-reader-notes-mvp-a2a_3-loader-pack-inert-exposure.mjs';
const A2A2D_VALIDATOR_REL = 'tools/validation/reader-notes/validate-reader-notes-mvp-a2a_2d-flags-read-purity.mjs';
const A2A2C_VALIDATOR_REL = 'tools/validation/reader-notes/validate-reader-notes-mvp-a2a_2_tauri-webkit-smoke.mjs';
const A2A2_VALIDATOR_REL = 'tools/validation/reader-notes/validate-reader-notes-mvp-a2a_2.mjs';
const A2A_VALIDATOR_REL = 'tools/validation/reader-notes/validate-reader-notes-mvp-a2a.mjs';
const A1_3_VALIDATOR_REL = 'tools/validation/reader-notes/validate-reader-notes-mvp-a1_3.mjs';
const A1_2_VALIDATOR_REL = 'tools/validation/reader-notes/validate-reader-notes-mvp-a1_2.mjs';
const A1_1_VALIDATOR_REL = 'tools/validation/reader-notes/validate-reader-notes-mvp-a1_1.mjs';
const A0_VALIDATOR_REL = 'tools/validation/reader-notes/validate-reader-notes-architecture-contract-v1_2.mjs';
/* M03 P4 S4C T8 slice A: the message-root lookup migrates to the Renderer's
 * read-only Semantic Index (primary) with the [data-message-id] scan retained
 * as the compatibility fallback; studio.js exposes the current render's index. */
const SEMANTIC_INDEX_REL = 'src-surfaces-base/studio/renderer/semantic/semantic-index.v1.js';
const STUDIO_JS_REL = 'src-surfaces-base/studio/studio.js';
const SEMANTIC_INDEX_SCHEMA = 'h2o.renderer.semantic-index';

const RESOLVER_FLAG_KEY = 'studio.readerNotes.anchorResolver.enabled';
const CONSUMER_FLAG_KEY = 'studio.readerNotes.highlightResolutionConsumer.enabled';
const CHAT_ID = 'chat-a2a4';
const ITEM_ID = CHAT_ID;
const ANSWER_ID = 'answer-a2a4';
const NATIVE_ID = 'highlight-a2a4';
const EXACT = 'some selected text';
const PLAIN = 'alpha some selected text omega';

const pass = [];
const fail = [];

function read(rel) {
  const full = path.join(REPO_ROOT, rel);
  assert.ok(fs.existsSync(full), `${rel} must exist`);
  return fs.readFileSync(full, 'utf8');
}

function check(label, fn) {
  try {
    fn();
    pass.push(label);
    console.log(`[ok] ${label}`);
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    fail.push({ label, message });
    console.log(`[fail] ${label}`);
    console.log(`       ${message}`);
  }
}

function has(text, needle, label) {
  assert.ok(text.includes(needle), `${label}: missing "${needle}"`);
}

function hasNot(text, needle, label) {
  assert.ok(!text.includes(needle), `${label}: must NOT contain "${needle}"`);
}

function runValidator(rel) {
  const full = path.join(REPO_ROOT, rel);
  assert.ok(fs.existsSync(full), `${rel} must exist`);
  try {
    const out = execFileSync('node', [full], { cwd: REPO_ROOT, encoding: 'utf8' });
    assert.ok(/validation passed|tauri-webkit-console-harness-generated/.test(out), `${rel} did not report passed`);
  } catch (error) {
    const output = (error && (error.stdout || '')) + (error && (error.stderr || ''));
    throw new Error(`${rel} failed (exit ${error && error.status}): ${output.slice(-1200)}`);
  }
}

function collectTextNodes(root, out = []) {
  if (!root) return out;
  if (root.nodeType === 3) {
    if (root.nodeValue.length > 0) out.push(root);
    return out;
  }
  for (const child of root.childNodes || []) collectTextNodes(child, out);
  return out;
}

function walk(root, fn) {
  if (!root) return;
  fn(root);
  for (const child of root.childNodes || []) walk(child, fn);
}

function nodeCount(root) {
  let count = 0;
  walk(root, () => { count += 1; });
  return count;
}

function textContent(root) {
  return collectTextNodes(root, []).map((node) => node.nodeValue).join('');
}

function markupSnapshot(root) {
  const parts = [];
  walk(root, (node) => {
    if (node.nodeType === 3) parts.push(`#text:${node.nodeValue}`);
    else if (node.nodeType === 1) {
      const attrs = Object.keys(node._attrs || {}).sort().map((key) => `${key}=${node._attrs[key]}`).join('|');
      parts.push(`${node.tagName}:${attrs}`);
    }
  });
  return parts.join('\n');
}

function overlayNodeCount(root) {
  let count = 0;
  walk(root, (node) => {
    if (node.nodeType !== 1) return;
    const tag = String(node.tagName || '').toLowerCase();
    if (tag === 'mark') count += 1;
    if (node.getAttribute && node.getAttribute('data-overlay-inline')) count += 1;
    if (node.getAttribute && node.getAttribute('data-highlight-id')) count += 1;
  });
  return count;
}

class RangeShim {
  constructor(owner) {
    this.owner = owner;
    this.startContainer = null;
    this.startOffset = 0;
    this.endContainer = null;
    this.endOffset = 0;
  }
  setStart(node, offset) {
    if (!node || node.nodeType !== 3) throw new Error('bad start');
    this.startContainer = node;
    this.startOffset = offset;
  }
  setEnd(node, offset) {
    if (!node || node.nodeType !== 3) throw new Error('bad end');
    this.endContainer = node;
    this.endOffset = offset;
  }
  toString() {
    const nodes = collectTextNodes(this.owner.root, []);
    const si = nodes.indexOf(this.startContainer);
    const ei = nodes.indexOf(this.endContainer);
    if (si < 0 || ei < 0 || si > ei) return '';
    if (si === ei) return String(nodes[si].nodeValue).slice(this.startOffset, this.endOffset);
    let out = String(nodes[si].nodeValue).slice(this.startOffset);
    for (let i = si + 1; i < ei; i += 1) out += String(nodes[i].nodeValue);
    out += String(nodes[ei].nodeValue).slice(0, this.endOffset);
    return out;
  }
}

function makeOwner() {
  return {
    root: null,
    createRangeCalls: 0,
    evaluateCalls: 0,
    createRange() {
      this.createRangeCalls += 1;
      return new RangeShim(this);
    },
    evaluate() {
      this.evaluateCalls += 1;
      return null;
    },
  };
}

function makeText(owner, value) {
  return {
    nodeType: 3,
    nodeValue: String(value),
    childNodes: [],
    ownerDocument: owner,
    parentNode: null,
  };
}

function matchesSelector(node, selector) {
  if (!node || node.nodeType !== 1 || typeof selector !== 'string') return false;
  if (selector === '[data-message-id]') return node.hasAttribute('data-message-id');
  if (selector === '.cgFrame') return String(node.getAttribute('class') || '').split(/\s+/).includes('cgFrame');
  if (selector === '.cgScroll') return String(node.getAttribute('class') || '').split(/\s+/).includes('cgScroll');
  if (selector === '[data-turn]') return node.hasAttribute('data-turn');
  if (selector === '[data-message-author-role]') return node.hasAttribute('data-message-author-role');
  return false;
}

function makeElement(owner, tagName, attrs = {}, children = [], queryLog = null) {
  const attr = new Map(Object.entries(attrs).map(([key, value]) => [key, String(value)]));
  const node = {
    nodeType: 1,
    tagName: String(tagName || 'div').toUpperCase(),
    nodeValue: null,
    childNodes: [],
    ownerDocument: owner,
    parentNode: null,
    _attrs: Object.fromEntries(attr.entries()),
    getAttribute(name) {
      return attr.has(name) ? attr.get(name) : null;
    },
    setAttribute(name, value) {
      attr.set(name, String(value));
      this._attrs[name] = String(value);
    },
    hasAttribute(name) {
      return attr.has(name);
    },
    removeAttribute(name) {
      attr.delete(name);
      delete this._attrs[name];
    },
    /* S4C: the real Semantic Index walks element children and class lists. */
    get children() {
      return this.childNodes.filter((child) => child && child.nodeType === 1);
    },
    get className() {
      return attr.has('class') ? attr.get('class') : '';
    },
    classList: {
      contains(name) {
        return String(attr.get('class') || '').split(/\s+/).includes(name);
      },
    },
    querySelectorAll(selector) {
      if (queryLog) queryLog.push(String(selector));
      const out = [];
      walk(this, (candidate) => {
        if (candidate !== this && matchesSelector(candidate, selector)) out.push(candidate);
      });
      return out;
    },
  };
  for (const child of children) {
    child.parentNode = node;
    node.childNodes.push(child);
  }
  return node;
}

function buildSavedReaderFixture(answerId = ANSWER_ID, queryLog = []) {
  const owner = makeOwner();
  const msgBody = makeElement(owner, 'div', { class: 'cgMsgBody' }, [
    makeText(owner, 'alpha '),
    makeElement(owner, 'span', {}, [makeText(owner, 'some selected ')]),
    makeElement(owner, 'strong', {}, [makeText(owner, 'text')]),
    makeText(owner, ' omega'),
  ]);
  const msgEl = makeElement(owner, 'div', {
    class: 'cgMsg cgMsg--assistant',
    'data-message-author-role': 'assistant',
    'data-message-id': answerId,
  }, [msgBody]);
  const turn = makeElement(owner, 'section', {
    class: 'cgTurn cgTurn--assistant wbTurn wbTurn--fallback wbTurn--assistant',
    'data-turn': 'assistant',
    'data-testid': 'conversation-turn-2',
  }, [msgEl]);
  const scroll = makeElement(owner, 'div', {
    class: 'cgScroll wbReaderScroll wbRichRoot',
    'data-testid': 'conversation-turns',
  }, [turn], queryLog);
  const frame = makeElement(owner, 'div', {
    class: 'cgFrame',
    'data-chat-id': CHAT_ID,
  }, [scroll], queryLog);
  owner.root = frame;
  return { owner, frame, scroll, turn, msgEl, queryLog };
}

function nativeHighlightEntry(answerId = ANSWER_ID) {
  return {
    id: NATIVE_ID,
    color: 'gold',
    ts: 1710000000000,
    convoId: `c/${CHAT_ID}`,
    anchors: {
      textQuote: {
        exact: EXACT,
        prefix: 'alpha ',
        suffix: ' omega',
        approx: 6,
      },
      textPos: { start: 6, end: 24 },
      xpath: { startXPath: './span[1]/text()[1]', startOffset: 0, endXPath: './strong[1]/text()[1]', endOffset: 4 },
    },
    answerId,
  };
}

function attributedHighlightFixture(answerId = ANSWER_ID) {
  const native = nativeHighlightEntry(answerId);
  return {
    schemaVersion: 1,
    kind: 'highlight',
    id: `highlight:${CHAT_ID}:${answerId}:${NATIVE_ID}`,
    item: { kind: 'captured_chat', id: CHAT_ID },
    attribution: 'attributed',
    source: {
      store: 'highlights',
      chatId: CHAT_ID,
      answerId,
      nativeId: NATIVE_ID,
      convoId: `c/${CHAT_ID}`,
    },
    body: { color: 'gold', text: EXACT, createdAt: 1710000000000 },
    raw: JSON.parse(JSON.stringify(native)),
  };
}

function jsonClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function makeSandbox({ consumerFlag = false, resolverFlag = true, annotations = [], resolverOverride = null, annotationsThrow = null, readerSemanticIndex = undefined, withSemanticIndexModule = false } = {}) {
  const storageCalls = [];
  const flagCalls = [];
  const writeCalls = [];
  const hookCalls = [];
  const annotationCalls = [];
  const resolverCalls = [];
  const accessorCalls = [];
  const sandbox = {
    H2O: {
      flags: {
        get(key, fallback) {
          flagCalls.push({ key, fallback });
          if (key === CONSUMER_FLAG_KEY) return consumerFlag;
          if (key === RESOLVER_FLAG_KEY) return resolverFlag;
          return fallback;
        },
        set() { writeCalls.push('flags.set'); },
        remove() { writeCalls.push('flags.remove'); },
        clear() { writeCalls.push('flags.clear'); },
      },
      Studio: {
        readerNotes: {
          annotations: {
            __installed: true,
            readonly: true,
            isEnabled() { return true; },
            listForItem(itemId, options) {
              annotationCalls.push({ itemId, options: jsonClone(options || {}) });
              if (annotationsThrow) throw annotationsThrow;
              return annotations;
            },
          },
        },
      },
      events: { on() { hookCalls.push('H2O.events.on'); } },
      bus: { on() { hookCalls.push('H2O.bus.on'); } },
    },
    localStorage: {
      getItem(key) { storageCalls.push(['getItem', key]); return null; },
      setItem(key, value) { storageCalls.push(['setItem', key, value]); },
      removeItem(key) { storageCalls.push(['removeItem', key]); },
      clear() { storageCalls.push(['clear']); },
    },
    sessionStorage: {
      setItem(key, value) { storageCalls.push(['session.setItem', key, value]); },
      removeItem(key) { storageCalls.push(['session.removeItem', key]); },
      clear() { storageCalls.push(['session.clear']); },
    },
    addEventListener() { hookCalls.push('addEventListener'); },
    setTimeout() { hookCalls.push('setTimeout'); return 0; },
    setInterval() { hookCalls.push('setInterval'); return 0; },
    requestAnimationFrame() { hookCalls.push('requestAnimationFrame'); return 0; },
    MutationObserver: function MutationObserver() { hookCalls.push('MutationObserver'); return { observe() { hookCalls.push('observe'); }, disconnect() {} }; },
    document: {
      addEventListener() { hookCalls.push('document.addEventListener'); },
      createRange() { hookCalls.push('document.createRange'); return {}; },
      evaluate() { hookCalls.push('document.evaluate'); return null; },
    },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  /* S4C: the Reader bridge (H2O.Studio.getReaderSemanticIndex) is a stub here -
   * a function, a throwing function, or absent - so the consumer's use of it is
   * observable; the real studio.js functions are executed separately. */
  if (readerSemanticIndex !== undefined) {
    sandbox.H2O.Studio.getReaderSemanticIndex = function (root) {
      accessorCalls.push(root);
      if (typeof readerSemanticIndex === 'function') return readerSemanticIndex(root);
      return readerSemanticIndex;
    };
  }
  vm.createContext(sandbox);
  if (withSemanticIndexModule) vm.runInContext(read(SEMANTIC_INDEX_REL), sandbox, { filename: SEMANTIC_INDEX_REL });
  vm.runInContext(read(CORE_REL), sandbox, { filename: CORE_REL });
  vm.runInContext(read(DOM_REL), sandbox, { filename: DOM_REL });
  if (resolverOverride) {
    sandbox.H2O.Studio.readerNotes.anchorResolverDom = resolverOverride(resolverCalls);
  }
  vm.runInContext(read(CONSUMER_REL), sandbox, { filename: CONSUMER_REL });
  return { sandbox, storageCalls, flagCalls, writeCalls, hookCalls, annotationCalls, resolverCalls, accessorCalls };
}

/* S4C helpers: the REAL Semantic Index module over the fake reader fixture. The
 * Renderer supplies projection metadata through describeTurn (never through
 * DOM attributes), so a fixture may carry NO data-message-id at all and still
 * project sourceRef.messageId. */
function buildSemanticIndex(rt, fixture, { chatId = CHAT_ID, snapshotId = 'snap-a2a4', meta = null } = {}) {
  const api = rt.sandbox.H2O.Studio.Renderer.semanticIndex;
  assert.ok(api && api.__installed === true, 'real Semantic Index module installed in the sandbox');
  return api.createShellIndex({
    root: fixture.frame,
    turnsEl: fixture.scroll,
    renderMode: 'canonical',
    source: { chatId, snapshotId },
    semanticConversation: null,
    describeTurn: (turnEl) => (meta ? (meta.get(turnEl) || null) : null),
    contentProjections: [],
    contentBodies: new Set(),
  });
}

/* A shape-valid index whose records are chosen by the test (identity traps). */
function fakeSemanticIndex(root, messages) {
  return Object.freeze({
    schema: SEMANTIC_INDEX_SCHEMA,
    schemaVersion: 1,
    version: 'fake',
    getConversation: () => ({ projectionKey: 'conversation:path:0', kind: 'conversation', target: root }),
    messages: () => messages,
  });
}

function extractStudioFunction(source, name) {
  const match = new RegExp(`\\bfunction\\s+${name}\\s*\\(`).exec(source);
  assert.ok(match, `studio.js function ${name} must exist`);
  const braceOpen = source.indexOf('{', match.index);
  let depth = 0;
  for (let i = braceOpen; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(match.index, i + 1);
    }
  }
  throw new Error(`unterminated studio.js function ${name}`);
}

function spyResolver(calls) {
  return (resolverCalls) => ({
    __installed: true,
    readonly: true,
    flagKey: RESOLVER_FLAG_KEY,
    isEnabled: () => true,
    resolveHighlight(annotation, msgEl, options) {
      resolverCalls.push('called');
      calls.push({ msgEl, options });
      return { status: 'anchored', span: { start: 6, end: 24 }, selectorUsed: 'textQuote', confidence: 1, reason: 'textQuote-exact', range: { toString: () => EXACT }, diagnostics: { xpathDeferred: true } };
    },
    diagnose: () => ({ coreAvailable: true, deferredSelectors: ['xpath'] }),
  });
}

function resolveWith(rt, fixture, options) {
  return rt.sandbox.H2O.Studio.readerNotes.highlightResolutionConsumer.resolveForItem(ITEM_ID, fixture.frame, options);
}

function storageWrites(calls) {
  return calls.filter((call) => !String(call[0]).endsWith('getItem'));
}

function assertSerializable(value) {
  const encoded = JSON.stringify(value);
  assert.ok(encoded && encoded.length > 0, 'value must JSON encode');
  assert.equal(JSON.stringify(JSON.parse(encoded)), encoded, 'JSON round-trip must be stable');
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function assertNoLiveReferences(row) {
  assert.ok(!Object.prototype.hasOwnProperty.call(row, 'range'), 'row must not expose range');
  assert.ok(!Object.prototype.hasOwnProperty.call(row, 'annotation'), 'row must not expose annotation');
  assert.ok(!Object.prototype.hasOwnProperty.call(row, 'msgEl'), 'row must not expose msgEl');
}

function sourceSafetyChecks() {
  const source = read(CONSUMER_REL);
  for (const token of [
    'localStorage',
    'sessionStorage',
    'indexedDB',
    'chrome.',
    'document.evaluate',
    'MutationObserver',
    'setTimeout',
    'setInterval',
    'requestAnimationFrame',
    'addEventListener',
    'removeEventListener',
    '.appendChild(',
    '.insertBefore(',
    '.removeChild(',
    '.normalize(',
    '.splitText(',
    'reanchorStatus',
    'sidecar.write',
    'native_note',
    'imported_document',
    'converted_note',
  ]) {
    hasNot(source, token, `consumer source safety ${token}`);
  }
  hasNot(source, RESOLVER_FLAG_KEY, 'consumer must not hard-code resolver flag');
  hasNot(source, 'annotationFacade.enabled', 'consumer must not hard-code annotation facade flag');
  hasNot(source, 'annotationHighlights.enabled', 'consumer must not hard-code highlight flag');
}

check('consumer module source exists and has the approved public surface only', () => {
  const source = read(CONSUMER_REL);
  has(source, 'highlightResolutionConsumer', 'consumer namespace');
  has(source, CONSUMER_FLAG_KEY, 'consumer flag key');
  has(source, 'resolveForItem', 'consumer resolve method');
  has(source, "querySelectorAll('[data-message-id]')", 'safe answerId lookup');
  hasNot(source, '[data-message-id="', 'unsafe answerId selector interpolation');
  hasNot(source, 'return range', 'live Range return');
  sourceSafetyChecks();
});

check('loader and pack include consumer after A1 and A2a resolver modules', () => {
  const order = [
    'reader-notes/library-item-view.studio.js',
    'reader-notes/annotation-facade.studio.js',
    'reader-notes/anchor-resolver.studio.js',
    'reader-notes/anchor-resolver-dom.studio.js',
    'reader-notes/highlight-resolution-consumer.studio.js',
  ];
  for (const [rel, text] of [[STUDIO_HTML_REL, read(STUDIO_HTML_REL)], [PACK_REL, read(PACK_REL)]]) {
    let last = -1;
    for (const token of order) {
      const idx = text.indexOf(token);
      assert.ok(idx >= 0, `${rel} missing ${token}`);
      assert.ok(idx > last, `${rel} order violation for ${token}`);
      last = idx;
    }
  }
});

check('module install is frozen, default-off, and inert at load', () => {
  const rt = makeSandbox({ consumerFlag: false, annotations: [attributedHighlightFixture()] });
  const api = rt.sandbox.H2O.Studio.readerNotes.highlightResolutionConsumer;
  assert.ok(api && api.__installed === true, 'consumer installed');
  assert.ok(Object.isFrozen(api), 'consumer API frozen');
  assert.deepEqual(Object.keys(api).sort(), ['__installed', 'diagnose', 'flagKey', 'isEnabled', 'readonly', 'resolveForItem', 'selfCheck', 'version'].sort());
  assert.equal(api.readonly, true);
  assert.equal(api.flagKey, CONSUMER_FLAG_KEY);
  assert.equal(api.isEnabled(), false);
  assert.deepEqual(rt.annotationCalls, [], 'no annotation calls at load');
  assert.deepEqual(rt.resolverCalls, [], 'no resolver calls at load');
  assert.deepEqual(storageWrites(rt.storageCalls), [], 'no storage writes at load');
  assert.deepEqual(rt.writeCalls, [], 'no flag writes at load');
  assert.deepEqual(rt.hookCalls, [], 'no automatic hooks at load');
});

check('disabled consumer returns a safe empty result without invoking upstream APIs', () => {
  const rt = makeSandbox({ consumerFlag: false, resolverFlag: true, annotations: [attributedHighlightFixture()] });
  const fixture = buildSavedReaderFixture();
  const out = rt.sandbox.H2O.Studio.readerNotes.highlightResolutionConsumer.resolveForItem(ITEM_ID, fixture.frame);
  assert.equal(out.diagnostics.reason, 'disabled');
  assert.deepEqual(plain(out.resolved), []);
  assert.deepEqual(plain(out.unresolved), []);
  assert.deepEqual(rt.annotationCalls, []);
  assert.equal(fixture.owner.createRangeCalls, 0);
});

check('happy path resolves one attributed highlight into a data-only row', () => {
  const annotation = attributedHighlightFixture();
  const annotationBefore = JSON.stringify(annotation);
  const rt = makeSandbox({ consumerFlag: true, resolverFlag: true, annotations: [annotation] });
  const fixture = buildSavedReaderFixture();
  const before = {
    text: textContent(fixture.frame),
    nodes: nodeCount(fixture.frame),
    overlays: overlayNodeCount(fixture.frame),
    markup: markupSnapshot(fixture.frame),
  };
  const out = rt.sandbox.H2O.Studio.readerNotes.highlightResolutionConsumer.resolveForItem(ITEM_ID, fixture.frame, { consumer: 'a2a4.2-validator' });
  assert.equal(out.schemaVersion, 1);
  assert.equal(out.itemId, ITEM_ID);
  assert.equal(out.resolved.length, 1);
  assert.equal(out.unresolved.length, 0);
  assert.equal(rt.annotationCalls.length, 1);
  assert.equal(rt.annotationCalls[0].itemId, ITEM_ID);
  assert.deepEqual(rt.annotationCalls[0].options, { kind: 'highlight' });
  assert.deepEqual(fixture.queryLog, ['[data-message-id]']);
  const row = out.resolved[0];
  assert.equal(row.annotationId, annotation.id);
  assert.equal(row.nativeId, NATIVE_ID);
  assert.equal(row.answerId, ANSWER_ID);
  assert.equal(row.status, 'anchored');
  assert.deepEqual(plain(row.span), { start: 6, end: 24 });
  assert.equal(row.selectorUsed, 'textQuote');
  assert.equal(row.confidence, 1);
  assert.equal(row.reason, 'textQuote-exact');
  assert.equal(row.text, EXACT);
  assert.equal(row.diagnostics.xpathDeferred, true);
  assertNoLiveReferences(row);
  assertSerializable(out);
  assert.notEqual(row.source, annotation.source, 'source must be cloned');
  assert.notEqual(row.diagnostics, rt.sandbox.H2O.Studio.readerNotes.anchorResolverDom.diagnose().lastDiagnostics, 'diagnostics must be cloned');
  row.source.answerId = 'mutated';
  row.diagnostics.xpathDeferred = false;
  assert.equal(annotation.source.answerId, ANSWER_ID, 'row source mutation must not mutate annotation source');
  assert.equal(JSON.stringify(annotation), annotationBefore, 'annotation/raw must not mutate');
  assert.equal(textContent(fixture.frame), before.text);
  assert.equal(nodeCount(fixture.frame), before.nodes);
  assert.equal(overlayNodeCount(fixture.frame), before.overlays);
  assert.equal(markupSnapshot(fixture.frame), before.markup);
  assert.equal(fixture.owner.evaluateCalls, 0, 'XPath must remain deferred');
  assert.deepEqual(storageWrites(rt.storageCalls), []);
  assert.deepEqual(rt.writeCalls, []);
});

check('safe answerId lookup handles special characters without selector interpolation', () => {
  const tricky = 'answer-"] .bad';
  const annotation = attributedHighlightFixture(tricky);
  const rt = makeSandbox({ consumerFlag: true, resolverFlag: true, annotations: [annotation] });
  const fixture = buildSavedReaderFixture(tricky);
  const out = rt.sandbox.H2O.Studio.readerNotes.highlightResolutionConsumer.resolveForItem(ITEM_ID, fixture.frame);
  assert.equal(out.resolved.length, 1);
  assert.deepEqual(fixture.queryLog, ['[data-message-id]']);
  assert.equal(out.resolved[0].answerId, tricky);
});

check('unattributed highlights, notes, bookmarks, and unsupported kinds are excluded before resolver invocation', () => {
  const base = attributedHighlightFixture();
  const annotations = [
    { ...base, id: 'unattributed', attribution: 'unattributed', item: null },
    { kind: 'note', id: 'note-1', source: { answerId: ANSWER_ID }, raw: { anchors: base.raw.anchors } },
    { kind: 'bookmark', id: 'bookmark-1', source: { answerId: ANSWER_ID }, raw: { anchors: base.raw.anchors } },
    { kind: 'quote', id: 'quote-1', source: { answerId: ANSWER_ID }, raw: { anchors: base.raw.anchors } },
  ];
  const rt = makeSandbox({
    consumerFlag: true,
    annotations,
    resolverOverride: (calls) => ({
      __installed: true,
      readonly: true,
      flagKey: RESOLVER_FLAG_KEY,
      isEnabled: () => true,
      resolveHighlight() { calls.push('called'); throw new Error('resolver should not be called'); },
      diagnose: () => ({ coreAvailable: true, deferredSelectors: ['xpath'] }),
    }),
  });
  const fixture = buildSavedReaderFixture();
  const out = rt.sandbox.H2O.Studio.readerNotes.highlightResolutionConsumer.resolveForItem(ITEM_ID, fixture.frame);
  assert.equal(out.resolved.length, 0);
  assert.equal(out.unresolved.length, 0);
  assert.equal(out.diagnostics.skipped.length, 4);
  assert.deepEqual(rt.resolverCalls, []);
});

check('missing anchors and missing answerId fail closed without resolver invocation', () => {
  const base = attributedHighlightFixture();
  const missingAnchors = { ...base, id: 'missing-anchors', raw: {} };
  const missingAnswer = { ...base, id: 'missing-answer', source: { ...base.source, answerId: '' } };
  const rt = makeSandbox({
    consumerFlag: true,
    annotations: [missingAnchors, missingAnswer],
    resolverOverride: (calls) => ({
      __installed: true,
      readonly: true,
      flagKey: RESOLVER_FLAG_KEY,
      isEnabled: () => true,
      resolveHighlight() { calls.push('called'); return {}; },
      diagnose: () => ({ coreAvailable: true, deferredSelectors: ['xpath'] }),
    }),
  });
  const fixture = buildSavedReaderFixture();
  const out = rt.sandbox.H2O.Studio.readerNotes.highlightResolutionConsumer.resolveForItem(ITEM_ID, fixture.frame);
  assert.equal(out.resolved.length, 0);
  assert.equal(out.unresolved.length, 2);
  assert.deepEqual(plain(out.unresolved.map((row) => row.reason).sort()), ['missing-answer', 'not-eligible'].sort());
  assert.deepEqual(rt.resolverCalls, []);
});

check('fail-closed cases return safe data-only results', () => {
  let rt = makeSandbox({ consumerFlag: true, annotations: [attributedHighlightFixture()] });
  assert.equal(rt.sandbox.H2O.Studio.readerNotes.highlightResolutionConsumer.resolveForItem('', buildSavedReaderFixture().frame).diagnostics.reason, 'invalid-item');
  assert.equal(rt.sandbox.H2O.Studio.readerNotes.highlightResolutionConsumer.resolveForItem(ITEM_ID, null).diagnostics.reason, 'missing-root');

  rt = makeSandbox({ consumerFlag: true, annotations: [attributedHighlightFixture()] });
  delete rt.sandbox.H2O.Studio.readerNotes.annotations;
  assert.equal(rt.sandbox.H2O.Studio.readerNotes.highlightResolutionConsumer.resolveForItem(ITEM_ID, buildSavedReaderFixture().frame).diagnostics.reason, 'deps-unavailable');

  rt = makeSandbox({ consumerFlag: true, annotations: [] });
  assert.equal(rt.sandbox.H2O.Studio.readerNotes.highlightResolutionConsumer.resolveForItem(ITEM_ID, buildSavedReaderFixture().frame).diagnostics.reason, 'no-highlights');

  rt = makeSandbox({ consumerFlag: true, annotations: [attributedHighlightFixture()] });
  let out = rt.sandbox.H2O.Studio.readerNotes.highlightResolutionConsumer.resolveForItem(ITEM_ID, buildSavedReaderFixture('different-answer').frame);
  assert.equal(out.unresolved[0].reason, 'message-root-missing');

  rt = makeSandbox({ consumerFlag: true, resolverFlag: false, annotations: [attributedHighlightFixture()] });
  out = rt.sandbox.H2O.Studio.readerNotes.highlightResolutionConsumer.resolveForItem(ITEM_ID, buildSavedReaderFixture().frame);
  assert.equal(out.unresolved[0].reason, 'resolver-disabled');

  rt = makeSandbox({
    consumerFlag: true,
    annotations: [attributedHighlightFixture()],
    resolverOverride: () => ({
      __installed: true,
      readonly: true,
      flagKey: RESOLVER_FLAG_KEY,
      isEnabled: () => true,
      resolveHighlight: () => ({ status: 'orphaned', range: null, span: null, reason: 'no-match', diagnostics: {} }),
      diagnose: () => ({ coreAvailable: true, deferredSelectors: ['xpath'] }),
    }),
  });
  out = rt.sandbox.H2O.Studio.readerNotes.highlightResolutionConsumer.resolveForItem(ITEM_ID, buildSavedReaderFixture().frame);
  assert.equal(out.unresolved[0].reason, 'resolver-orphaned');

  rt = makeSandbox({
    consumerFlag: true,
    annotations: [attributedHighlightFixture()],
    resolverOverride: () => ({
      __installed: true,
      readonly: true,
      flagKey: RESOLVER_FLAG_KEY,
      isEnabled: () => true,
      resolveHighlight: () => ({ status: 'orphaned', range: null, span: { start: 6, end: 24 }, reason: 'range-unavailable', diagnostics: {} }),
      diagnose: () => ({ coreAvailable: true, deferredSelectors: ['xpath'] }),
    }),
  });
  out = rt.sandbox.H2O.Studio.readerNotes.highlightResolutionConsumer.resolveForItem(ITEM_ID, buildSavedReaderFixture().frame);
  assert.equal(out.unresolved[0].reason, 'range-unavailable');

  rt = makeSandbox({ consumerFlag: true, annotations: [attributedHighlightFixture()], annotationsThrow: new Error('boom') });
  assert.equal(rt.sandbox.H2O.Studio.readerNotes.highlightResolutionConsumer.resolveForItem(ITEM_ID, buildSavedReaderFixture().frame).diagnostics.reason, 'deps-unavailable');

  rt = makeSandbox({
    consumerFlag: true,
    annotations: [attributedHighlightFixture()],
    resolverOverride: () => ({
      __installed: true,
      readonly: true,
      flagKey: RESOLVER_FLAG_KEY,
      isEnabled: () => true,
      resolveHighlight: () => { throw new Error('resolver boom'); },
      diagnose: () => ({ coreAvailable: true, deferredSelectors: ['xpath'] }),
    }),
  });
  out = rt.sandbox.H2O.Studio.readerNotes.highlightResolutionConsumer.resolveForItem(ITEM_ID, buildSavedReaderFixture().frame);
  assert.equal(out.unresolved[0].reason, 'resolver-error');
});

check('own feature flag gates only the consumer and upstream self-gating is respected', () => {
  const source = read(CONSUMER_REL);
  has(source, CONSUMER_FLAG_KEY, 'own consumer flag');
  hasNot(source, RESOLVER_FLAG_KEY, 'no resolver flag hard-code');
  const rt = makeSandbox({ consumerFlag: true, resolverFlag: false, annotations: [attributedHighlightFixture()] });
  const out = rt.sandbox.H2O.Studio.readerNotes.highlightResolutionConsumer.resolveForItem(ITEM_ID, buildSavedReaderFixture().frame);
  assert.equal(out.diagnostics.upstream.resolverEnabled, false);
  assert.equal(out.unresolved[0].reason, 'resolver-disabled');
});

/* ---- M03 P4 S4C T8 slice A: Semantic Index becomes the primary message-root
 * authority; data-message-id stays the compatibility fallback. --------------- */

const ACCEPTED_ROW_KEYS = ['annotationId', 'nativeId', 'answerId', 'source', 'status', 'span', 'selectorUsed', 'confidence', 'reason', 'text', 'diagnostics'];

function buildIndexedFixture({ answerId = ANSWER_ID, withAttribute = true, queryLog = [] } = {}) {
  /* The Renderer's projection metadata path: sourceRef.messageId comes from
   * describeTurn, not from the attribute; the attribute may be absent. */
  const fixture = buildSavedReaderFixture(answerId, queryLog);
  if (!withAttribute) fixture.msgEl.removeAttribute('data-message-id');
  const meta = new Map([[fixture.turn, { role: 'assistant', turnNo: 2, messageId: answerId, turnId: 't-2' }]]);
  return { fixture, meta };
}

check('S4C: consumer source names the Semantic Index primary authority and keeps the compatibility scan verbatim', () => {
  const source = read(CONSUMER_REL);
  has(source, 'getReaderSemanticIndex', 'current Reader index bridge');
  has(source, 'options.semanticIndex', 'explicit index option');
  has(source, "sourceRef.messageId !== answerId", 'answerId matched against sourceRef.messageId only');
  has(source, 'function findMessageRootBySemanticIndex', 'index path');
  has(source, 'function findMessageRootByCompatibilityAttribute', 'compat path');
  has(source, "querySelectorAll('[data-message-id]')", 'compat scan retained');
  hasNot(source, '[data-message-id="', 'no selector interpolation');
  for (const token of ['projectionKey === answerId', 'renderKey === answerId', 'ownerRef === answerId', 'answerId === record.projectionKey', 'answerId === record.renderKey', 'textContent', 'decorationContribution', 'decorationContributions', '.register(', 'data-h2o-projection', 'data-h2o-message-key', 'data-h2o-turn-key', 'data-h2o-block-key', 'data-h2o-text-key', 'scrollIntoView', 'scrollTo(', 'TreeWalker']) {
    hasNot(source, token, `S4C consumer must not contain ${token}`);
  }
  assert.ok(!/\b(?:semanticIndex|index|explicit|current)\.\w+\s*=[^=]/.test(source.replace(/\/\*[\s\S]*?\*\//g, '')), '16: the consumer never writes into a Semantic Index');
  sourceSafetyChecks();
});

check('S4C: studio.js exposes a read-only current-render Semantic Index bridge on the existing Reader lifecycle seam (static)', () => {
  const studio = read(STUDIO_JS_REL);
  has(studio, 'H2O.Studio.getReaderSemanticIndex = getReaderSemanticIndex;', 'accessor exposed beside the other read-only Studio accessors');
  has(studio, 'currentReaderRender: null,', 'Reader-owned current-render state field');
  const build = extractStudioFunction(studio, 'buildReaderDOM');
  has(build, 'const rendererResult = renderer.render(rendererInput, { getEditOverride });', 'Renderer result received');
  has(build, 'bindReaderSemanticIndex(rendererResult);', 'binding happens when buildReaderDOM receives the Renderer result');
  const unmount = extractStudioFunction(studio, 'studioHostUnmount');
  has(unmount, 'state.currentReaderRender = null;', 'unmount clears the bridge');
  has(unmount, 'state.currentReaderEditOverrides = null;', 'existing per-render Reader state is cleared on the same seam');
  const bind = extractStudioFunction(studio, 'bindReaderSemanticIndex');
  const get = extractStudioFunction(studio, 'getReaderSemanticIndex');
  for (const [name, text] of [['bindReaderSemanticIndex', bind], ['getReaderSemanticIndex', get]]) {
    for (const token of ['querySelector', 'getElementById', 'document.', 'localStorage', 'sessionStorage', 'indexedDB', 'decorationContributions', 'scrollTo', 'scrollIntoView', 'createShellIndex', 'Object.assign(', 'JSON.parse']) {
      hasNot(text, token, `${name} must not contain ${token}`);
    }
  }
  has(get, 'if (root !== undefined && root !== current.root) return null;', 'an unmatched root yields null');
  has(bind, 'Object.freeze({ root, semanticIndex })', 'binding is a frozen root/index pair');
  assert.equal((studio.match(/bindReaderSemanticIndex\(/g) || []).length, 2, 'exactly one binding call site (definition + buildReaderDOM)');
});

check('S4C: current Reader Semantic Index accessor returns the exact bound index, null for a foreign root, null once unmounted (executed real studio.js functions)', () => {
  const studio = read(STUDIO_JS_REL);
  const state = { currentReaderEditOverrides: [], currentReaderRender: null };
  const unmounts = [];
  const sandbox = vm.createContext({ state, W: { H2O: { studioHost: { unmount(reason) { unmounts.push(reason); } } } } });
  vm.runInContext([
    extractStudioFunction(studio, 'bindReaderSemanticIndex'),
    extractStudioFunction(studio, 'getReaderSemanticIndex'),
    extractStudioFunction(studio, 'studioHostUnmount'),
    'this.bind = bindReaderSemanticIndex; this.get = getReaderSemanticIndex; this.unmount = studioHostUnmount;',
  ].join('\n'), sandbox);
  const rootA = { tag: 'cgFrame-A' }; const rootB = { tag: 'cgFrame-B' };
  const ixA = Object.freeze({ schema: SEMANTIC_INDEX_SCHEMA, id: 'A' }); const ixB = Object.freeze({ schema: SEMANTIC_INDEX_SCHEMA, id: 'B' });
  assert.equal(sandbox.get(), null, 'no current render -> null'); assert.equal(sandbox.get(rootA), null);
  sandbox.bind({ root: rootA, semanticIndex: ixA, turnsEl: {}, decorationContributions: { list() { return []; } } });
  assert.equal(sandbox.get(rootA), ixA, '1: the exact index of the current render'); assert.equal(sandbox.get(), ixA, 'unqualified call returns the current index');
  assert.equal(sandbox.get(rootB), null, '2: a foreign root receives nothing'); assert.equal(sandbox.get(null), null, 'null is not the current root'); assert.equal(sandbox.get({ ...rootA }), null, 'identity, not shape');
  assert.equal(Object.isFrozen(state.currentReaderRender), true, 'bound pair frozen'); assert.deepEqual(Object.keys(state.currentReaderRender), ['root', 'semanticIndex'], 'only root + index are tracked (no decoration lifecycle, no Reader internals)');
  sandbox.bind({ root: rootB, semanticIndex: ixB });
  assert.equal(sandbox.get(rootA), null, 'a replaced render no longer answers for the old root'); assert.equal(sandbox.get(rootB), ixB, 'the new render answers');
  sandbox.unmount('studio:test');
  assert.deepEqual(unmounts, ['studio:test']); assert.equal(state.currentReaderRender, null, '3: unmount clears the bridge'); assert.equal(state.currentReaderEditOverrides, null); assert.equal(sandbox.get(), null); assert.equal(sandbox.get(rootB), null);
  sandbox.bind({ root: rootA }); assert.equal(state.currentReaderRender, null, 'never manufactures an index'); assert.equal(sandbox.get(rootA), null);
  sandbox.bind({ semanticIndex: ixA }); assert.equal(sandbox.get(), null, 'no root, no binding');
  sandbox.bind(null); assert.equal(sandbox.get(), null);
});

check('S4C: the Semantic Index path resolves the message root by sourceRef.messageId with data-message-id REMOVED and without the compatibility scan', () => {
  const annotation = attributedHighlightFixture();
  const rows = {};
  for (const mode of ['reader-bridge', 'explicit-option']) {
    const resolverSeen = [];
    const queryLog = [];
    const { fixture, meta } = buildIndexedFixture({ withAttribute: false, queryLog });
    let index = null;
    const rt = makeSandbox({ consumerFlag: true, resolverFlag: true, annotations: [annotation], withSemanticIndexModule: true, resolverOverride: spyResolver(resolverSeen), readerSemanticIndex: mode === 'reader-bridge' ? (root) => (root === fixture.frame ? index : null) : undefined });
    index = buildSemanticIndex(rt, fixture, { meta });
    assert.equal(index.messages().length, 1); assert.deepEqual(plain(index.messages()[0].sourceRef), { turnId: 't-2', messageId: ANSWER_ID }, 'sourceRef carried by describeTurn metadata, not by the attribute');
    assert.equal(fixture.msgEl.hasAttribute('data-message-id'), false, 'fixture target carries no data-message-id');
    assert.equal(fixture.frame.querySelectorAll('[data-message-id]').length, 0, 'the compatibility scan could not find it'); queryLog.length = 0;
    const before = markupSnapshot(fixture.frame);
    const out = resolveWith(rt, fixture, mode === 'explicit-option' ? { semanticIndex: index, consumer: 's4c' } : { consumer: 's4c' });
    assert.equal(out.diagnostics.reason, 'ok'); assert.equal(out.resolved.length, 1, `${mode}: resolved through the index`); assert.equal(out.unresolved.length, 0);
    assert.deepEqual(queryLog, [], `${mode}: 6/7 - no querySelectorAll("[data-message-id]") on the successful index path`);
    assert.equal(resolverSeen.length, 1); assert.equal(resolverSeen[0].msgEl, fixture.msgEl, `${mode}: 13 - the anchor resolver receives the exact indexed message element`); assert.equal(resolverSeen[0].msgEl, index.messages()[0].target);
    assert.deepEqual(plain(out.diagnostics.messageRootLookup), { primary: 'semantic-index', fallback: 'data-message-id', semanticIndexAvailable: true, bySemanticIndex: 1, byCompatibilityAttribute: 0 });
    if (mode === 'reader-bridge') { assert.equal(rt.accessorCalls.length, 1, 'one bridge read per invocation'); assert.equal(rt.accessorCalls[0], fixture.frame, 'the bridge is asked for THIS root'); }
    else assert.equal(rt.accessorCalls.length, 0, 'a valid explicit index takes priority; the bridge is not consulted');
    assert.equal(markupSnapshot(fixture.frame), before, 'read-only: no wrapper, attribute or node added'); assert.equal(Object.isFrozen(index), true, '16: the index stays frozen'); assert.deepEqual(Object.keys(index).sort(), ['basis', 'blocks', 'getBlock', 'getConversation', 'getGeometry', 'getMessage', 'getText', 'getTurn', 'messages', 'renderMode', 'schema', 'schemaVersion', 'semanticCorrespondenceLost', 'texts', 'turns', 'version'], '16: no mutation method on the index');
    const row = out.resolved[0]; assert.deepEqual(Object.keys(row), ACCEPTED_ROW_KEYS, '14: row schema unchanged'); assertNoLiveReferences(row); assertSerializable(out);
    rows[mode] = plain(out.resolved);
  }
  assert.deepEqual(rows['reader-bridge'], rows['explicit-option']);
  /* Same fixture WITH the attribute present: the index still wins and the scan never runs. */
  const queryLog = []; const resolverSeen = []; const { fixture, meta } = buildIndexedFixture({ withAttribute: true, queryLog });
  let index = null; const rt = makeSandbox({ consumerFlag: true, annotations: [annotation], withSemanticIndexModule: true, resolverOverride: spyResolver(resolverSeen), readerSemanticIndex: (root) => (root === fixture.frame ? index : null) });
  index = buildSemanticIndex(rt, fixture, { meta }); queryLog.length = 0;
  const out = resolveWith(rt, fixture);
  assert.equal(out.resolved.length, 1); assert.deepEqual(queryLog, [], 'index primary even when the attribute exists'); assert.equal(resolverSeen[0].msgEl, fixture.msgEl);
  assert.deepEqual(rows['reader-bridge'], plain(out.resolved), 'rows identical with or without the attribute');
});

check('S4C: answerId is a SOURCE identifier - projectionKey, renderKey and ownerRef never match it', () => {
  const resolverSeen = [];
  const { fixture } = buildIndexedFixture({ withAttribute: false });
  /* Records whose projection / render / owner identities EQUAL the answerId but whose sourceRef does not. */
  const trapIndex = fakeSemanticIndex(fixture.frame, Object.freeze([
    Object.freeze({ projectionKey: ANSWER_ID, kind: 'message', renderKey: ANSWER_ID, ownerRef: Object.freeze({ id: ANSWER_ID }), sourceRef: Object.freeze({ messageId: 'other-source-id' }), target: fixture.msgEl }),
  ]));
  let rt = makeSandbox({ consumerFlag: true, annotations: [attributedHighlightFixture()], resolverOverride: spyResolver(resolverSeen), readerSemanticIndex: trapIndex });
  let out = resolveWith(rt, fixture);
  assert.equal(out.resolved.length, 0); assert.equal(out.unresolved.length, 1); assert.equal(out.unresolved[0].reason, 'message-root-missing', '5: identity traps do not resolve; compat cannot either (attribute absent)'); assert.deepEqual(resolverSeen, []);
  assert.deepEqual(plain(out.diagnostics.messageRootLookup), { primary: 'semantic-index', fallback: 'data-message-id', semanticIndexAvailable: true, bySemanticIndex: 0, byCompatibilityAttribute: 0 });
  /* Control: the same record with a matching sourceRef resolves. */
  const okIndex = fakeSemanticIndex(fixture.frame, Object.freeze([
    Object.freeze({ projectionKey: 'message:path:0', kind: 'message', renderKey: null, ownerRef: null, sourceRef: Object.freeze({ messageId: ANSWER_ID }), target: fixture.msgEl }),
  ]));
  rt = makeSandbox({ consumerFlag: true, annotations: [attributedHighlightFixture()], resolverOverride: spyResolver(resolverSeen), readerSemanticIndex: okIndex });
  out = resolveWith(rt, fixture);
  assert.equal(out.resolved.length, 1); assert.equal(resolverSeen[0].msgEl, fixture.msgEl);
  /* An annotation whose answerId is literally a projection key must not match a record by key. */
  const real = makeSandbox({ consumerFlag: true, annotations: [attributedHighlightFixture('message:source:' + ANSWER_ID)], withSemanticIndexModule: true, resolverOverride: spyResolver(resolverSeen), readerSemanticIndex: (root) => (root === fixture.frame ? realIndex : null) });
  const { fixture: f2, meta } = buildIndexedFixture({ withAttribute: false }); const realIndex = buildSemanticIndex(real, f2, { meta });
  assert.equal(realIndex.messages()[0].projectionKey, 'message:source:' + ANSWER_ID, 'the projection key literally equals the crafted answerId');
  out = resolveWith(real, f2);
  assert.equal(out.unresolved.length, 1); assert.equal(out.unresolved[0].reason, 'message-root-missing', '5: a projection key is not a source id');
});

check('S4C: without any Semantic Index the compatibility lookup stays the sole authority with identical rows (8)', () => {
  const annotation = attributedHighlightFixture();
  const resolverSeen = [];
  /* No bridge at all (accessor absent), attribute present -> compat path, one scan. */
  let queryLog = []; let fixture = buildSavedReaderFixture(ANSWER_ID, queryLog);
  let rt = makeSandbox({ consumerFlag: true, annotations: [annotation], resolverOverride: spyResolver(resolverSeen) });
  assert.equal(typeof rt.sandbox.H2O.Studio.getReaderSemanticIndex, 'undefined');
  const compat = resolveWith(rt, fixture);
  assert.equal(compat.resolved.length, 1); assert.deepEqual(queryLog, ['[data-message-id]'], '8: the compat scan runs exactly as before'); assert.equal(resolverSeen[0].msgEl, fixture.msgEl);
  assert.deepEqual(plain(compat.diagnostics.messageRootLookup), { primary: 'semantic-index', fallback: 'data-message-id', semanticIndexAvailable: false, bySemanticIndex: 0, byCompatibilityAttribute: 1 });
  /* Bridge present but returning null (no current render) -> same. */
  queryLog = []; fixture = buildSavedReaderFixture(ANSWER_ID, queryLog);
  rt = makeSandbox({ consumerFlag: true, annotations: [annotation], resolverOverride: spyResolver(resolverSeen), readerSemanticIndex: null });
  const viaNull = resolveWith(rt, fixture);
  assert.equal(viaNull.resolved.length, 1); assert.deepEqual(queryLog, ['[data-message-id]']); assert.equal(rt.accessorCalls.length, 1);
  /* Bridge returning a non-index or throwing -> compat, contained. */
  for (const bad of [{}, 'nope', () => { throw new Error('bridge boom'); }]) {
    queryLog = []; fixture = buildSavedReaderFixture(ANSWER_ID, queryLog);
    rt = makeSandbox({ consumerFlag: true, annotations: [annotation], resolverOverride: spyResolver(resolverSeen), readerSemanticIndex: bad });
    const out = resolveWith(rt, fixture);
    assert.equal(out.resolved.length, 1, 'a broken bridge never breaks resolution'); assert.deepEqual(queryLog, ['[data-message-id]']);
  }
  /* The index-path rows and the compat rows are the same data. */
  const { fixture: fx, meta } = buildIndexedFixture({ withAttribute: false });
  let index = null; const viaIndexRt = makeSandbox({ consumerFlag: true, annotations: [annotation], withSemanticIndexModule: true, resolverOverride: spyResolver(resolverSeen), readerSemanticIndex: (root) => (root === fx.frame ? index : null) });
  index = buildSemanticIndex(viaIndexRt, fx, { meta });
  assert.deepEqual(plain(resolveWith(viaIndexRt, fx).resolved), plain(compat.resolved), '14: index-path rows equal compat-path rows');
});

check('S4C: an index miss (no sourceRef match) falls back to the compatibility attribute (9)', () => {
  const resolverSeen = []; const queryLog = [];
  const fixture = buildSavedReaderFixture(ANSWER_ID, queryLog);
  const meta = new Map([[fixture.turn, { role: 'assistant', turnNo: 2, messageId: 'some-other-message', turnId: 't-2' }]]);
  let index = null; const rt = makeSandbox({ consumerFlag: true, annotations: [attributedHighlightFixture()], withSemanticIndexModule: true, resolverOverride: spyResolver(resolverSeen), readerSemanticIndex: (root) => (root === fixture.frame ? index : null) });
  index = buildSemanticIndex(rt, fixture, { meta }); queryLog.length = 0;
  assert.equal(index.messages()[0].sourceRef.messageId, 'some-other-message');
  const out = resolveWith(rt, fixture);
  assert.equal(out.resolved.length, 1, '9: compat resolves'); assert.deepEqual(queryLog, ['[data-message-id]']); assert.equal(resolverSeen[0].msgEl, fixture.msgEl);
  assert.deepEqual(plain(out.diagnostics.messageRootLookup), { primary: 'semantic-index', fallback: 'data-message-id', semanticIndexAvailable: true, bySemanticIndex: 0, byCompatibilityAttribute: 1 });
  /* A matched record whose target is unusable (not an element / outside the root) also falls back. */
  for (const target of [null, { nodeType: 3 }, makeElement(fixture.owner, 'div', { 'data-message-id': ANSWER_ID })]) {
    const broken = fakeSemanticIndex(fixture.frame, [{ projectionKey: 'message:path:0', kind: 'message', sourceRef: { messageId: ANSWER_ID }, target }]);
    queryLog.length = 0; const seen = [];
    const rt2 = makeSandbox({ consumerFlag: true, annotations: [attributedHighlightFixture()], resolverOverride: spyResolver(seen), readerSemanticIndex: broken });
    const out2 = resolveWith(rt2, fixture);
    assert.equal(out2.resolved.length, 1); assert.deepEqual(queryLog, ['[data-message-id]'], 'unusable index target -> compat'); assert.equal(seen[0].msgEl, fixture.msgEl, 'the resolver still receives the in-root element');
  }
});

check('S4C: a stale / foreign Semantic Index is never used for another Renderer root (10)', () => {
  const resolverSeen = [];
  const queryLogA = []; const queryLogB = [];
  const { fixture: A, meta: metaA } = buildIndexedFixture({ withAttribute: true, queryLog: queryLogA });
  const { fixture: B, meta: metaB } = buildIndexedFixture({ withAttribute: false, queryLog: queryLogB });
  let indexB = null;
  /* The bridge (wrongly) hands out B's index for root A. */
  const rt = makeSandbox({ consumerFlag: true, annotations: [attributedHighlightFixture()], withSemanticIndexModule: true, resolverOverride: spyResolver(resolverSeen), readerSemanticIndex: () => indexB });
  indexB = buildSemanticIndex(rt, B, { meta: metaB }); queryLogA.length = 0; queryLogB.length = 0;
  assert.equal(indexB.getConversation().target, B.frame); assert.equal(indexB.messages()[0].target, B.msgEl);
  const out = resolveWith(rt, A);
  assert.equal(out.resolved.length, 1, 'A still resolves - through its own compatibility attribute'); assert.deepEqual(queryLogA, ['[data-message-id]']); assert.deepEqual(queryLogB, []);
  assert.equal(resolverSeen[0].msgEl, A.msgEl, '10: B\'s message element is never handed out for root A'); assert.notEqual(resolverSeen[0].msgEl, B.msgEl);
  assert.deepEqual(plain(out.diagnostics.messageRootLookup), { primary: 'semantic-index', fallback: 'data-message-id', semanticIndexAvailable: false, bySemanticIndex: 0, byCompatibilityAttribute: 1 }, 'a foreign index counts as unavailable');
  /* Explicit foreign index option: same rejection; the (correct) bridge is consulted next. */
  let indexA = null; const rt2 = makeSandbox({ consumerFlag: true, annotations: [attributedHighlightFixture()], withSemanticIndexModule: true, resolverOverride: spyResolver(resolverSeen), readerSemanticIndex: (root) => (root === A.frame ? indexA : null) });
  indexA = buildSemanticIndex(rt2, A, { meta: metaA }); const indexB2 = buildSemanticIndex(rt2, B, { meta: metaB }); queryLogA.length = 0;
  const out2 = resolveWith(rt2, A, { semanticIndex: indexB2 });
  assert.equal(out2.resolved.length, 1); assert.deepEqual(queryLogA, [], 'the foreign explicit index is skipped and the bound current index resolves'); assert.equal(resolverSeen[resolverSeen.length - 1].msgEl, A.msgEl); assert.equal(rt2.accessorCalls.length, 1);
  /* Foreign root without any compat attribute: nothing resolves, and B's element is never used. */
  const rt3 = makeSandbox({ consumerFlag: true, annotations: [attributedHighlightFixture()], withSemanticIndexModule: true, resolverOverride: spyResolver(resolverSeen), readerSemanticIndex: () => indexB });
  const { fixture: C } = buildIndexedFixture({ withAttribute: false });
  const out3 = resolveWith(rt3, C);
  assert.equal(out3.unresolved[0].reason, 'message-root-missing');
});

check('S4C: when neither the index nor the attribute resolves, message-root-missing is preserved (11)', () => {
  const resolverSeen = [];
  const { fixture, meta } = buildIndexedFixture({ withAttribute: true });
  fixture.msgEl.setAttribute('data-message-id', 'different-answer');
  meta.set(fixture.turn, { role: 'assistant', turnNo: 2, messageId: 'different-answer', turnId: 't-2' });
  let index = null; const rt = makeSandbox({ consumerFlag: true, annotations: [attributedHighlightFixture()], withSemanticIndexModule: true, resolverOverride: spyResolver(resolverSeen), readerSemanticIndex: (root) => (root === fixture.frame ? index : null) });
  index = buildSemanticIndex(rt, fixture, { meta });
  const out = resolveWith(rt, fixture);
  assert.equal(out.resolved.length, 0); assert.equal(out.unresolved.length, 1); assert.equal(out.unresolved[0].reason, 'message-root-missing'); assert.equal(out.unresolved[0].status, 'orphaned'); assert.deepEqual(resolverSeen, []);
  assert.deepEqual(Object.keys(out.unresolved[0]), ACCEPTED_ROW_KEYS, '14: unresolved row schema unchanged'); assertSerializable(out);
});

check('S4C: duplicate source-message ids keep deterministic first-match semantics on both paths (12)', () => {
  const owner = makeOwner(); const queryLog = [];
  const mkMsg = (label) => makeElement(owner, 'div', { class: 'cgMsg cgMsg--assistant', 'data-message-author-role': 'assistant', 'data-message-id': ANSWER_ID }, [
    makeElement(owner, 'div', { class: 'cgMsgBody' }, [makeText(owner, 'alpha '), makeElement(owner, 'span', {}, [makeText(owner, 'some selected ')]), makeElement(owner, 'strong', {}, [makeText(owner, 'text')]), makeText(owner, ` omega ${label}`)]),
  ]);
  const msg1 = mkMsg('one'); const msg2 = mkMsg('two');
  const turn1 = makeElement(owner, 'section', { class: 'cgTurn cgTurn--assistant', 'data-turn': 'assistant' }, [msg1]);
  const turn2 = makeElement(owner, 'section', { class: 'cgTurn cgTurn--assistant', 'data-turn': 'assistant' }, [msg2]);
  const scroll = makeElement(owner, 'div', { class: 'cgScroll wbReaderScroll wbRichRoot', 'data-testid': 'conversation-turns' }, [turn1, turn2], queryLog);
  const frame = makeElement(owner, 'div', { class: 'cgFrame', 'data-chat-id': CHAT_ID }, [scroll], queryLog);
  owner.root = frame;
  const fixture = { owner, frame, scroll, msgEl: msg1, queryLog };
  const meta = new Map([[turn1, { role: 'assistant', turnNo: 1, messageId: ANSWER_ID, turnId: 'dup' }], [turn2, { role: 'assistant', turnNo: 2, messageId: ANSWER_ID, turnId: 'dup' }]]);
  const seenIndex = []; const seenCompat = [];
  let index = null; const viaIndex = makeSandbox({ consumerFlag: true, annotations: [attributedHighlightFixture()], withSemanticIndexModule: true, resolverOverride: spyResolver(seenIndex), readerSemanticIndex: (root) => (root === frame ? index : null) });
  index = buildSemanticIndex(viaIndex, fixture, { meta }); queryLog.length = 0;
  assert.deepEqual(plain(index.messages().map((m) => m.projectionKey)), ['message:source:' + ANSWER_ID, 'message:source:' + ANSWER_ID + ':ordinal:1'], 'the index keeps both records, collision-safe');
  assert.equal(resolveWith(viaIndex, fixture).resolved.length, 1); assert.equal(seenIndex[0].msgEl, msg1, '12: first index record in projection order'); assert.deepEqual(queryLog, []);
  const viaCompat = makeSandbox({ consumerFlag: true, annotations: [attributedHighlightFixture()], resolverOverride: spyResolver(seenCompat) });
  assert.equal(resolveWith(viaCompat, fixture).resolved.length, 1); assert.equal(seenCompat[0].msgEl, msg1, '12: first matching DOM message - identical choice');
});

check('S4C: flags, read-only behavior and the anchor-resolution contract are unchanged with the index path (15/17/18)', () => {
  const { fixture, meta } = buildIndexedFixture({ withAttribute: false });
  let index = null;
  /* Disabled consumer: the bridge is never consulted. */
  let rt = makeSandbox({ consumerFlag: false, annotations: [attributedHighlightFixture()], withSemanticIndexModule: true, readerSemanticIndex: (root) => (root === fixture.frame ? index : null) });
  index = buildSemanticIndex(rt, fixture, { meta });
  assert.equal(resolveWith(rt, fixture).diagnostics.reason, 'disabled'); assert.equal(rt.accessorCalls.length, 0, 'disabled -> no bridge read');
  /* Resolver-disabled and resolver-orphaned outcomes keep their reasons through the index path. */
  rt = makeSandbox({ consumerFlag: true, resolverFlag: false, annotations: [attributedHighlightFixture()], withSemanticIndexModule: true, readerSemanticIndex: (root) => (root === fixture.frame ? index : null) });
  index = buildSemanticIndex(rt, fixture, { meta });
  let out = resolveWith(rt, fixture); assert.equal(out.unresolved[0].reason, 'resolver-disabled', 'the message root resolved through the index; the resolver gate is unchanged');
  rt = makeSandbox({ consumerFlag: true, resolverFlag: true, annotations: [attributedHighlightFixture()], withSemanticIndexModule: true, readerSemanticIndex: (root) => (root === fixture.frame ? index : null) });
  index = buildSemanticIndex(rt, fixture, { meta });
  const before = markupSnapshot(fixture.frame);
  out = resolveWith(rt, fixture, { consumer: 's4c' });
  assert.equal(out.resolved.length, 1, 'the REAL anchor resolver anchors on the indexed element'); assert.equal(out.resolved[0].text, EXACT); assert.equal(out.resolved[0].reason, 'textQuote-exact'); assert.equal(out.resolved[0].diagnostics.xpathDeferred, true);
  assert.equal(markupSnapshot(fixture.frame), before, '17: no node or attribute introduced'); assert.equal(fixture.owner.evaluateCalls, 0, 'XPath still deferred'); assert.deepEqual(storageWrites(rt.storageCalls), []); assert.deepEqual(rt.writeCalls, []); assert.deepEqual(rt.hookCalls, []);
  assert.equal(fixture.frame.querySelectorAll('[data-message-id]').length, 0, 'still no attribute');
  const diag = rt.sandbox.H2O.Studio.readerNotes.highlightResolutionConsumer.diagnose();
  assert.deepEqual(plain(diag.messageRootAuthority), { primary: 'semantic-index', fallback: 'data-message-id' }); assert.equal(diag.noRender, true); assert.equal(diag.returnsLiveRange, false);
  assert.deepEqual(Object.keys(rt.sandbox.H2O.Studio.readerNotes.highlightResolutionConsumer).sort(), ['__installed', 'diagnose', 'flagKey', 'isEnabled', 'readonly', 'resolveForItem', 'selfCheck', 'version'].sort(), 'public surface unchanged');
  assert.equal('decorationContribution' in rt.sandbox.H2O.Studio.Renderer, false, '18: no DecorationContribution involved');
});

check('evidence doc records A2a.4.2 scope and exclusions', () => {
  const evidence = read(EVIDENCE_REL);
  for (const token of [
    'A2a.4.2 creates one read-only explicit-invocation consumer module',
    'studio.readerNotes.highlightResolutionConsumer.enabled',
    'reader-notes/highlight-resolution-consumer.studio.js',
    'No auto-run',
    'No UI rendering',
    'No live `Range` return',
    'Data-only rows',
    'attribute comparison',
    'notes/bookmarks/unattributed',
    'Own flag + upstream self-gating',
    'A2a.4.2b real-boot smoke is required before any UI consumer slice',
    'does not authorize UI rendering, XPath, A2b',
  ]) {
    has(evidence, token, 'A2a.4.2 evidence');
  }
});

check('updated A2a.3 loader/pack inert exposure validator still passes', () => runValidator(A2A3_VALIDATOR_REL));
check('A2a.4.1 consumer-readiness evidence remains present', () => {
  const evidence = read(A2A4_1_EVIDENCE_REL);
  has(evidence, 'A2a.4.1 is validator/evidence only', 'A2a.4.1 evidence');
  has(evidence, 'source.answerId', 'A2a.4.1 message-root evidence');
});
check('A2a.2d validator still passes', () => runValidator(A2A2D_VALIDATOR_REL));
check('A2a.2c Tauri/WebKit generator validator still passes', () => runValidator(A2A2C_VALIDATOR_REL));
check('A2a.2 validator still passes', () => runValidator(A2A2_VALIDATOR_REL));
check('A2a validator still passes', () => runValidator(A2A_VALIDATOR_REL));
check('A1.3 validator still passes', () => runValidator(A1_3_VALIDATOR_REL));
check('A1.2 validator still passes', () => runValidator(A1_2_VALIDATOR_REL));
check('A1.1 validator still passes', () => runValidator(A1_1_VALIDATOR_REL));
check('A0 contract validator still passes', () => runValidator(A0_VALIDATOR_REL));

if (fail.length) {
  console.log(`\nReader & Notes MVP-A2a.4.2 highlight-resolution consumer validation failed: ${fail.length} failed, ${pass.length} passed.`);
  process.exitCode = 1;
} else {
  console.log(`\nReader & Notes MVP-A2a.4.2 highlight-resolution consumer validation passed: ${pass.length} checks.`);
}
