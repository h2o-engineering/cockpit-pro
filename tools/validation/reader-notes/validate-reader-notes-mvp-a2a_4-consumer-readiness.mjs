#!/usr/bin/env node
// Validator for Studio Reader & Notes MVP-A2a.4.1:
// consumer-readiness proof for A1 attributed highlights and the A2a DOM resolver.

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
const A1_LIBRARY_REL = 'src-surfaces-base/studio/reader-notes/library-item-view.studio.js';
const A1_ANNOTATION_REL = 'src-surfaces-base/studio/reader-notes/annotation-facade.studio.js';
const STUDIO_JS_REL = 'src-surfaces-base/studio/studio.js';
const RENDERER_JS_REL = 'src-surfaces-base/studio/renderer/chat-renderer.studio.js';
const STUDIO_HTML_REL = 'src-surfaces-base/studio/studio.html';
const PACK_REL = 'tools/product/studio/pack-studio.mjs';
const EVIDENCE_REL = 'release-evidence/2026-07-01/reader-notes-a2a4-consumer-readiness.md';

const A2A3_VALIDATOR_REL = 'tools/validation/reader-notes/validate-reader-notes-mvp-a2a_3-loader-pack-inert-exposure.mjs';
const A2A2D_VALIDATOR_REL = 'tools/validation/reader-notes/validate-reader-notes-mvp-a2a_2d-flags-read-purity.mjs';
const A2A2C_VALIDATOR_REL = 'tools/validation/reader-notes/validate-reader-notes-mvp-a2a_2_tauri-webkit-smoke.mjs';
const A2A2_VALIDATOR_REL = 'tools/validation/reader-notes/validate-reader-notes-mvp-a2a_2.mjs';
const A2A_VALIDATOR_REL = 'tools/validation/reader-notes/validate-reader-notes-mvp-a2a.mjs';
const A1_3_VALIDATOR_REL = 'tools/validation/reader-notes/validate-reader-notes-mvp-a1_3.mjs';
const A1_2_VALIDATOR_REL = 'tools/validation/reader-notes/validate-reader-notes-mvp-a1_2.mjs';
const A1_1_VALIDATOR_REL = 'tools/validation/reader-notes/validate-reader-notes-mvp-a1_1.mjs';
const A0_VALIDATOR_REL = 'tools/validation/reader-notes/validate-reader-notes-architecture-contract-v1_2.mjs';

const FLAG_KEY = 'studio.readerNotes.anchorResolver.enabled';
const CHAT_ID = 'chat-a2a4';
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

function readIfExists(rel) {
  const full = path.join(REPO_ROOT, rel);
  return fs.existsSync(full) ? fs.readFileSync(full, 'utf8') : null;
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

function listFilesRecursive(absDir, acc = []) {
  let entries = [];
  try { entries = fs.readdirSync(absDir, { withFileTypes: true }); } catch { return acc; }
  for (const entry of entries) {
    const p = path.join(absDir, entry.name);
    if (entry.isDirectory()) listFilesRecursive(p, acc);
    else acc.push(p);
  }
  return acc;
}

function resolveRuntime3H1aRel() {
  const runtimeDir = path.join(REPO_ROOT, 'src-runtime-base');
  const name = fs.readdirSync(runtimeDir).find((entry) => entry.startsWith('3H1a'));
  assert.ok(name, 'runtime 3H1a highlight engine must exist');
  return path.join('src-runtime-base', name);
}

function runValidator(rel) {
  const full = path.join(REPO_ROOT, rel);
  assert.ok(fs.existsSync(full), `${rel} must exist`);
  try {
    const out = execFileSync('node', [full], { cwd: REPO_ROOT, encoding: 'utf8' });
    assert.ok(/validation passed|tauri-webkit-console-harness-generated/.test(out), `${rel} did not report passed`);
  } catch (error) {
    const output = (error && (error.stdout || '')) + (error && (error.stderr || ''));
    throw new Error(`${rel} failed (exit ${error && error.status}): ${output.slice(-1000)}`);
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
  get collapsed() {
    return this.startContainer === this.endContainer && this.startOffset === this.endOffset;
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
  if (selector === '.cgFrame') return String(node.getAttribute('class') || '').split(/\s+/).includes('cgFrame');
  if (selector === '.cgScroll') return String(node.getAttribute('class') || '').split(/\s+/).includes('cgScroll');
  if (selector === '[data-turn]') return node.hasAttribute('data-turn');
  if (selector === '[data-message-author-role]') return node.hasAttribute('data-message-author-role');
  const idMatch = selector.match(/^\[data-message-id="([^"]+)"\]$/);
  if (idMatch) return node.getAttribute('data-message-id') === idMatch[1];
  const roleMatch = selector.match(/^\[data-message-author-role="([^"]+)"\]$/);
  if (roleMatch) return node.getAttribute('data-message-author-role') === roleMatch[1];
  const testIdMatch = selector.match(/^\[data-testid="([^"]+)"\]$/);
  if (testIdMatch) return node.getAttribute('data-testid') === testIdMatch[1];
  return false;
}

function makeElement(owner, tagName, attrs = {}, children = []) {
  const attr = new Map(Object.entries(attrs).map(([key, value]) => [key, String(value)]));
  const node = {
    nodeType: 1,
    tagName: String(tagName || 'div').toUpperCase(),
    nodeValue: null,
    childNodes: [],
    ownerDocument: owner,
    parentNode: null,
    getAttribute(name) {
      return attr.has(name) ? attr.get(name) : null;
    },
    setAttribute(name, value) {
      attr.set(name, String(value));
    },
    hasAttribute(name) {
      return attr.has(name);
    },
    querySelector(selector) {
      let found = null;
      walk(this, (candidate) => {
        if (!found && candidate !== this && matchesSelector(candidate, selector)) found = candidate;
      });
      return found;
    },
    querySelectorAll(selector) {
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

function buildSavedReaderFixture() {
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
    'data-message-id': ANSWER_ID,
  }, [msgBody]);
  const turn = makeElement(owner, 'section', {
    class: 'cgTurn cgTurn--assistant wbTurn wbTurn--fallback wbTurn--assistant',
    'data-turn': 'assistant',
    'data-testid': 'conversation-turn-2',
    'data-turn-idx': '1',
  }, [msgEl]);
  const scroll = makeElement(owner, 'div', {
    class: 'cgScroll wbReaderScroll wbRichRoot',
    'data-testid': 'conversation-turns',
  }, [turn]);
  const frame = makeElement(owner, 'div', {
    class: 'cgFrame',
    'data-chat-id': CHAT_ID,
  }, [
    makeElement(owner, 'div', { class: 'cgBody' }, [
      makeElement(owner, 'div', { class: 'cgThread' }, [scroll]),
    ]),
  ]);
  owner.root = frame;
  return { owner, frame, scroll, turn, msgEl };
}

function nativeHighlightEntry() {
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
      textPos: {
        start: 6,
        end: 24,
      },
      xpath: {
        startXPath: './div[1]/span[1]/text()[1]',
        startOffset: 0,
        endXPath: './div[1]/strong[1]/text()[1]',
        endOffset: 4,
      },
    },
  };
}

function attributedHighlightFixture() {
  const native = nativeHighlightEntry();
  const annotation = {
    schemaVersion: 1,
    kind: 'highlight',
    id: `highlight:${CHAT_ID}:${ANSWER_ID}:${NATIVE_ID}`,
    item: { kind: 'captured_chat', id: CHAT_ID },
    attribution: 'attributed',
    source: {
      store: 'highlights',
      chatId: CHAT_ID,
      answerId: ANSWER_ID,
      nativeId: NATIVE_ID,
      convoId: `c/${CHAT_ID}`,
    },
    body: {
      color: 'gold',
      text: EXACT,
      createdAt: 1710000000000,
    },
    raw: JSON.parse(JSON.stringify(native)),
  };
  return { annotation, native };
}

function findMessageRootForAnnotation(frame, annotation) {
  const answerId = String(annotation?.source?.answerId || '').trim();
  if (!answerId || !frame || typeof frame.querySelector !== 'function') return null;
  return frame.querySelector(`[data-message-id="${answerId}"]`);
}

function isEligibleAttributedHighlight(annotation) {
  return !!(
    annotation
    && annotation.kind === 'highlight'
    && annotation.attribution === 'attributed'
    && annotation.item
    && annotation.item.kind === 'captured_chat'
    && annotation.source
    && annotation.source.answerId
    && annotation.source.chatId
    && annotation.raw
    && annotation.raw.anchors
  );
}

function freshRuntime(flagValue = true) {
  const storageCalls = [];
  const flagCalls = [];
  const writeCalls = [];
  const sandbox = {
    H2O: {
      flags: {
        get(key, fallback) {
          flagCalls.push({ key, fallback });
          return key === FLAG_KEY ? flagValue : fallback;
        },
        set() { writeCalls.push('set'); },
        remove() { writeCalls.push('remove'); },
        clear() { writeCalls.push('clear'); },
      },
      Studio: { readerNotes: {} },
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
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(read(CORE_REL), sandbox, { filename: CORE_REL });
  vm.runInContext(read(DOM_REL), sandbox, { filename: DOM_REL });
  return { sandbox, storageCalls, flagCalls, writeCalls };
}

function storageWrites(calls) {
  return calls.filter((call) => !String(call[0]).endsWith('getItem'));
}

function resolveIfEligible(api, annotation, frame) {
  if (!isEligibleAttributedHighlight(annotation)) {
    return { skipped: true, reason: 'not-attributed-highlight', called: false };
  }
  const root = findMessageRootForAnnotation(frame, annotation);
  if (!root) return { skipped: false, called: false, reason: 'message-root-missing' };
  return {
    skipped: false,
    called: true,
    root,
    result: api.resolveHighlight(annotation, root, { consumer: 'a2a4-readiness' }),
  };
}

function assertEvidenceDoc() {
  const evidence = read(EVIDENCE_REL);
  for (const token of [
    'A2a.4.1 is validator/evidence only',
    'No runtime module was added',
    'No loader/pack changes were made',
    'No `studio.js` changes were made',
    'raw.anchors',
    'textQuote',
    'textPos',
    'xpath',
    'source.answerId',
    '[data-message-id]',
    'Notes/bookmarks and unattributed highlights are excluded',
    'XPath remains deferred',
    'Existing A2a.3 no-consumer gate remains valid',
    'does not authorize A2a.4.2',
  ]) {
    has(evidence, token, 'A2a.4.1 evidence');
  }
}

check('repo source evidence confirms A1 highlight annotations preserve native raw anchors', () => {
  const a1 = read(A1_ANNOTATION_REL);
  has(a1, 'function mapAttributedHighlight', 'A1 attributed highlight mapper');
  has(a1, "kind: 'highlight'", 'A1 highlight kind');
  has(a1, "attribution: 'attributed'", 'A1 attributed marker');
  has(a1, 'answerId: answer', 'A1 source answerId');
  has(a1, 'nativeId: nativeId', 'A1 source nativeId');
  has(a1, 'convoId: strOrNull(entry.convoId)', 'A1 source convoId');
  has(a1, 'raw: cloneValue(entry)', 'A1 raw clone');
  has(a1, "item.convoId === 'c/' + chatId", 'A1 exact attribution rule');
  const library = read(A1_LIBRARY_REL);
  has(library, "kind: KIND", 'A1 library item captured_chat kind');
  has(library, "authority: IDENTITY_AUTHORITY", 'A1 identity authority');
});

check('repo source evidence confirms 3H1a msgEl-relative nested anchor model', () => {
  const runtime3H1aRel = resolveRuntime3H1aRel();
  const h = read(runtime3H1aRel);
  has(h, 'const MSG_getAnswerId', '3H1a answer id accessor');
  has(h, "data-message-id", '3H1a message id selector');
  has(h, 'const HL_resolveAnchors', '3H1a resolver helper');
  has(h, 'anchors.textQuote', '3H1a textQuote selector');
  has(h, 'anchors.textPos', '3H1a textPos selector');
  has(h, 'anchors.xpath', '3H1a xpath selector');
  has(h, 'anchors: {', '3H1a nested native anchors write shape');
  has(h, 'xpath: XP_rangeToSerializable(range, msgEl)', '3H1a xpath relative to msgEl');
  has(h, 'textPos: TXT_rangeToPos(range, msgEl)', '3H1a textPos relative to msgEl');
  has(h, 'textQuote: TXT_rangeToQuote(range, msgEl, 32)', '3H1a textQuote relative to msgEl');
});

check('repo source evidence confirms saved-reader message root conventions', () => {
  const studio = read(STUDIO_JS_REL);
  const renderer = read(RENDERER_JS_REL);
  for (const token of [
    'function buildReaderDOM',
    'renderer.normalizeInput(snap)',
    "const root = turn.querySelector('[data-message-author-role], [data-message-id]') || turn",
  ]) {
    has(studio, token, 'studio.js Reader orchestration convention');
  }
  for (const token of [
    'root.className = "cgFrame"',
    'root.dataset.chatId',
    'const TURNS_TESTID = TESTIDS.CONVERSATION_TURNS || "conversation-turns"',
  ]) {
    has(renderer, token, 'Renderer reader DOM convention');
  }
  /* Reader M01 T5: T4 (3b5eac87) legitimately adds presentationProfile to
   * render options. The older wrap role/message-id pins were already stale on
   * main after accepted M03 (35d6da7a), before T4. Reuse executed contract proof:
   * the Reader consumer checks exact render arguments/binding; the Renderer
   * owner checks public role/message-id attributes in canonical AND rich DOM.
   * No Renderer-local variable name or production behavior is prescribed here. */
  runValidator('tools/validation/reader-notes/validate-reader-notes-mvp-a2a_4-highlight-resolution-consumer.mjs');
  runValidator('tools/validation/studio/validate-studio-renderer-contract-repair.mjs');
});

check('A1 attributed highlight fixture uses real nested 3H1a raw.anchors shape', () => {
  const { annotation, native } = attributedHighlightFixture();
  assert.equal(annotation.kind, 'highlight');
  assert.equal(annotation.attribution, 'attributed');
  assert.equal(annotation.source.answerId, ANSWER_ID);
  assert.equal(annotation.source.chatId, CHAT_ID);
  assert.equal(annotation.source.nativeId, NATIVE_ID);
  assert.equal(annotation.source.convoId, `c/${CHAT_ID}`);
  assert.notEqual(annotation.raw, native, 'raw must be clone-like, not the live native object');
  assert.equal(annotation.raw.anchors.textQuote.exact, EXACT);
  assert.equal(annotation.raw.anchors.textPos.start, 6);
  assert.equal(annotation.raw.anchors.textPos.end, 24);
  assert.ok(annotation.raw.anchors.xpath);
});

check('saved-reader fixture models cgFrame/cgScroll/turn/message root conventions', () => {
  const fixture = buildSavedReaderFixture();
  assert.equal(fixture.frame.getAttribute('class'), 'cgFrame');
  assert.equal(fixture.frame.getAttribute('data-chat-id'), CHAT_ID);
  assert.equal(fixture.scroll.getAttribute('data-testid'), 'conversation-turns');
  assert.equal(fixture.turn.getAttribute('data-turn'), 'assistant');
  assert.equal(fixture.msgEl.getAttribute('data-message-author-role'), 'assistant');
  assert.equal(fixture.msgEl.getAttribute('data-message-id'), ANSWER_ID);
  assert.equal(textContent(fixture.msgEl), PLAIN);
  assert.equal(findMessageRootForAnnotation(fixture.frame, attributedHighlightFixture().annotation), fixture.msgEl);
});

check('real A2a resolver modules install frozen APIs in sandbox', () => {
  const rt = freshRuntime(true);
  const core = rt.sandbox.H2O.Studio.readerNotes.anchorResolver;
  const dom = rt.sandbox.H2O.Studio.readerNotes.anchorResolverDom;
  assert.ok(core && core.__installed === true, 'core installed');
  assert.ok(dom && dom.__installed === true, 'DOM wrapper installed');
  assert.ok(Object.isFrozen(core), 'core frozen');
  assert.ok(Object.isFrozen(dom), 'DOM wrapper frozen');
  assert.equal(core.flagKey, FLAG_KEY);
  assert.equal(dom.flagKey, FLAG_KEY);
  assert.deepEqual(storageWrites(rt.storageCalls), []);
  assert.deepEqual(rt.writeCalls, []);
});

check('positive resolution passes A1 attributed highlight to msgEl root only', () => {
  const rt = freshRuntime(true);
  const dom = rt.sandbox.H2O.Studio.readerNotes.anchorResolverDom;
  const { annotation } = attributedHighlightFixture();
  const fixture = buildSavedReaderFixture();
  const root = findMessageRootForAnnotation(fixture.frame, annotation);
  assert.equal(root, fixture.msgEl);
  assert.notEqual(root, fixture.frame, 'must not use .cgFrame as resolution root');
  assert.notEqual(root, fixture.scroll, 'must not use .cgScroll as resolution root');
  const before = {
    text: textContent(fixture.frame),
    nodes: nodeCount(fixture.frame),
    overlays: overlayNodeCount(fixture.frame),
  };
  const result = dom.resolveHighlight(annotation, root, { consumer: 'a2a4-readiness' });
  assert.equal(result.status, 'anchored');
  assert.equal(result.span.start, 6);
  assert.equal(result.span.end, 24);
  assert.equal(result.selectorUsed, 'textQuote');
  assert.equal(result.confidence, 1);
  assert.equal(result.reason, 'textQuote-exact');
  assert.ok(result.range, 'range should materialize in the shim');
  assert.equal(result.range.toString(), EXACT);
  assert.equal(result.diagnostics.xpathDeferred, true, 'XPath is present but deferred');
  assert.equal(fixture.owner.evaluateCalls, 0, 'XPath/document.evaluate must not run');
  assert.equal(textContent(fixture.frame), before.text);
  assert.equal(nodeCount(fixture.frame), before.nodes);
  assert.equal(overlayNodeCount(fixture.frame), before.overlays);
  assert.deepEqual(storageWrites(rt.storageCalls), []);
  assert.deepEqual(rt.writeCalls, []);
});

check('explicit consumer-readiness guard excludes unattributed highlights, notes, and bookmarks', () => {
  const rt = freshRuntime(true);
  const dom = rt.sandbox.H2O.Studio.readerNotes.anchorResolverDom;
  const fixture = buildSavedReaderFixture();
  const { annotation } = attributedHighlightFixture();
  const unattributed = { ...annotation, attribution: 'unattributed', item: null };
  const note = { kind: 'note', raw: { anchors: annotation.raw.anchors }, source: { answerId: ANSWER_ID } };
  const bookmark = { kind: 'bookmark', raw: { anchors: annotation.raw.anchors }, source: { answerId: ANSWER_ID } };
  for (const candidate of [unattributed, note, bookmark]) {
    const out = resolveIfEligible(dom, candidate, fixture.frame);
    assert.equal(out.skipped, true);
    assert.equal(out.called, false);
    assert.equal(out.reason, 'not-attributed-highlight');
  }
  assert.equal(fixture.owner.createRangeCalls, 0, 'excluded annotations must not call Range');
});

check('fail-closed cases return safe orphaned results', () => {
  const { annotation } = attributedHighlightFixture();
  const enabled = freshRuntime(true).sandbox.H2O.Studio.readerNotes.anchorResolverDom;
  const disabled = freshRuntime(false).sandbox.H2O.Studio.readerNotes.anchorResolverDom;
  const fixture = buildSavedReaderFixture();
  assert.equal(enabled.resolveHighlight(annotation, null).reason, 'missing-root');
  assert.equal(enabled.resolveHighlight({ kind: 'note', raw: { anchors: annotation.raw.anchors } }, fixture.msgEl).reason, 'unsupported-annotation');
  assert.equal(enabled.resolveHighlight({ kind: 'highlight', raw: {} }, fixture.msgEl).reason, 'missing-anchors');
  const off = disabled.resolveHighlight(annotation, fixture.msgEl);
  assert.equal(off.status, 'orphaned');
  assert.equal(off.range, null);
  assert.equal(off.reason, 'disabled');
});

check('no mutation, mark rendering, overlay insertion, source mutation, or storage writes occur', () => {
  const rt = freshRuntime(true);
  const dom = rt.sandbox.H2O.Studio.readerNotes.anchorResolverDom;
  const fixture = buildSavedReaderFixture();
  const { annotation } = attributedHighlightFixture();
  const beforeAnnotation = JSON.stringify(annotation);
  const beforeFrameText = textContent(fixture.frame);
  const beforeMsgText = textContent(fixture.msgEl);
  const beforeNodes = nodeCount(fixture.frame);
  const beforeOverlays = overlayNodeCount(fixture.frame);
  const beforeNativeMutationFields = JSON.stringify({
    reanchorStatus: annotation.raw.reanchorStatus,
    sidecar: annotation.raw.sidecar,
  });
  const out = resolveIfEligible(dom, annotation, fixture.frame);
  assert.equal(out.called, true);
  assert.equal(out.result.status, 'anchored');
  assert.equal(JSON.stringify(annotation), beforeAnnotation, 'annotation and raw native entry must not mutate');
  assert.equal(JSON.stringify({
    reanchorStatus: annotation.raw.reanchorStatus,
    sidecar: annotation.raw.sidecar,
  }), beforeNativeMutationFields, 'no reanchorStatus/sidecar fields may be persisted');
  assert.equal(textContent(fixture.frame), beforeFrameText);
  assert.equal(textContent(fixture.msgEl), beforeMsgText);
  assert.equal(nodeCount(fixture.frame), beforeNodes);
  assert.equal(overlayNodeCount(fixture.frame), beforeOverlays);
  assert.deepEqual(storageWrites(rt.storageCalls), []);
  assert.deepEqual(rt.writeCalls, []);
});

check('XPath remains deferred and document.evaluate is never called', () => {
  const rt = freshRuntime(true);
  const dom = rt.sandbox.H2O.Studio.readerNotes.anchorResolverDom;
  const { annotation } = attributedHighlightFixture();
  const fixture = buildSavedReaderFixture();
  const result = dom.resolveHighlight(annotation, fixture.msgEl);
  assert.equal(result.diagnostics.xpathDeferred, true);
  assert.equal(fixture.owner.evaluateCalls, 0);

  const xpathOnly = JSON.parse(JSON.stringify(annotation));
  xpathOnly.raw.anchors = { xpath: annotation.raw.anchors.xpath };
  const unresolved = dom.resolveHighlight(xpathOnly, fixture.msgEl);
  assert.equal(unresolved.status, 'orphaned');
  assert.equal(unresolved.range, null);
  assert.equal(unresolved.diagnostics.xpathDeferred, true);
  assert.equal(fixture.owner.evaluateCalls, 0);
});

check('A2a.4.1 evidence-doc filename is not wired into loader/pack', () => {
  // A2a.4.2 (approved) creates and wires exactly one consumer module
  // (highlight-resolution-consumer.studio.js); the wired-consumer-state gate is
  // now owned by the A2a.3 and A2a.4.2 validators. This check only guards that
  // the A2a.4.1 evidence-doc filename never leaks into loader/pack.
  const html = read(STUDIO_HTML_REL);
  const pack = read(PACK_REL);
  for (const token of [
    'reader-notes-a2a4-consumer-readiness',
  ]) {
    hasNot(html, token, `studio.html ${token}`);
    hasNot(pack, token, `pack-studio ${token}`);
  }
});

check('forbidden runtime areas do not contain A2a.4 consumer-readiness footprint', () => {
  const forbiddenDirs = [
    'src-surfaces-base/studio/sync',
    'src-surfaces-base/studio/ingestion',
    'apps/studio/desktop/src-tauri',
    'src-runtime-base',
  ];
  const forbiddenFiles = [
    STUDIO_JS_REL,
    A1_LIBRARY_REL,
    A1_ANNOTATION_REL,
    CORE_REL,
    DOM_REL,
  ];
  const markers = ['highlight-resolution-consumer', 'highlightResolutionConsumer', 'a2a4-consumer-readiness'];
  for (const rel of forbiddenFiles) {
    const text = read(rel);
    for (const marker of markers) hasNot(text, marker, `${rel} marker ${marker}`);
  }
  for (const dir of forbiddenDirs) {
    for (const full of listFilesRecursive(path.join(REPO_ROOT, dir))) {
      if (!/\.(js|mjs|md|json|rs|toml|html|css)$/i.test(full)) continue;
      const text = fs.readFileSync(full, 'utf8');
      for (const marker of markers) {
        assert.ok(!text.includes(marker), `${path.relative(REPO_ROOT, full)} must not contain ${marker}`);
      }
    }
  }
  for (const file of listFilesRecursive(path.join(REPO_ROOT, 'src-surfaces-base/studio/reader-notes'))) {
    const rel = path.relative(REPO_ROOT, file);
    assert.ok(!/sidecar|enrichment|renderer-registry|native[_-]?note|imported[_-]?document|converted[_-]?note/i.test(rel), `${rel} must not be a deferred subsystem module`);
  }
});

check('evidence doc records A2a.4.1 scope and findings', assertEvidenceDoc);

check('A2a.3 no-consumer gate remains valid', () => runValidator(A2A3_VALIDATOR_REL));
check('A2a.2d validator still passes', () => runValidator(A2A2D_VALIDATOR_REL));
check('A2a.2c Tauri/WebKit generator validator still passes', () => runValidator(A2A2C_VALIDATOR_REL));
check('A2a.2 validator still passes', () => runValidator(A2A2_VALIDATOR_REL));
check('A2a validator still passes', () => runValidator(A2A_VALIDATOR_REL));
check('A1.3 validator still passes', () => runValidator(A1_3_VALIDATOR_REL));
check('A1.2 validator still passes', () => runValidator(A1_2_VALIDATOR_REL));
check('A1.1 validator still passes', () => runValidator(A1_1_VALIDATOR_REL));
check('A0 contract validator still passes', () => runValidator(A0_VALIDATOR_REL));

if (fail.length) {
  console.log(`\nReader & Notes MVP-A2a.4.1 consumer-readiness validation failed: ${fail.length} failed, ${pass.length} passed.`);
  process.exitCode = 1;
} else {
  console.log(`\nReader & Notes MVP-A2a.4.1 consumer-readiness validation passed: ${pass.length} checks.`);
}
