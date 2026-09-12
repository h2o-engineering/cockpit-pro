#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), '..', '..', '..');
const modulePath = process.argv[2] || path.join(REPO_ROOT, 'src-surfaces-base/studio/renderer/semantic/render-ir.v1.js');
const source = fs.readFileSync(modulePath, 'utf8');
const sandbox = vm.createContext({ console });
sandbox.globalThis = sandbox;
vm.runInContext(source, sandbox, { filename: modulePath });
const ir = sandbox.H2O?.Studio?.Renderer?.renderIR;
assert.ok(ir, 'Render IR API did not register');

const checks = [];
function check(label, fn) {
  fn();
  checks.push(label);
  console.log(`✓ ${label}`);
}

check('publishes a versioned transient Renderer-owned IR contract', () => {
  assert.equal(ir.schema, 'h2o.renderer.render-ir');
  /* T4 is an additive vocabulary change to a transient, unwired IR: the
   * document shape is unchanged, so schemaVersion stays 1 and the module
   * version alone carries the change. */
  assert.equal(ir.schemaVersion, 1);
  assert.match(ir.__version, /^0\.2\.0-m03-p2$/);
});

check('covers the initial semantic/AI-native block vocabulary without provider shells', () => {
  for (const kind of ['paragraph','heading','text','list','blockquote','codeBlock','table','image','file','math','citation','toolCall','toolResult','artifact','opaqueProviderBlock']) {
    assert.ok([...ir.blockKinds].includes(kind), `missing ${kind}`);
  }
  assert.doesNotMatch(source, /outerHTML|richTurns|innerHTML/);
});

check('supports all four canonical transcript roles and rejects unknown roles', () => {
  for (const role of ['user', 'assistant', 'system', 'tool']) {
    assert.equal(ir.createMessage({ role, blocks: [] }, 0).role, role);
  }
  assert.throws(() => ir.createMessage({ role: 'unknown', blocks: [] }, 0), /Unsupported Render IR role/);
});

check('derives deterministic projection-local keys without claiming durable contentBlockId ownership', () => {
  const a = ir.createBlock({ kind: 'paragraph', contentBlockId: 'owner-block-42', children: [{ kind: 'text', text: 'hello' }] }, { messageKey: 'message:a', ordinal: 0 });
  const b = ir.createBlock({ kind: 'paragraph', contentBlockId: 'owner-block-42', children: [{ kind: 'text', text: 'hello' }] }, { messageKey: 'message:a', ordinal: 0 });
  assert.equal(a.renderKey, b.renderKey);
  assert.equal(a.ownerRef, 'owner-block-42');
  assert.equal(Object.prototype.hasOwnProperty.call(a, 'contentBlockId'), false);
});

check('does not freeze or mutate owner-provided source objects while freezing the IR copy', () => {
  const sourceMeta = { nested: { value: 1 } };
  const block = ir.createBlock({ kind: 'artifact', metadata: sourceMeta }, { messageKey: 'message:a', path: '0' });
  assert.equal(Object.isFrozen(block.metadata), true);
  assert.equal(Object.isFrozen(sourceMeta), false);
  assert.equal(Object.isFrozen(sourceMeta.nested), false);
  sourceMeta.nested.value = 2;
  assert.equal(block.metadata.nested.value, 1);
});

check('projection-local fallback paths remain unique beyond 1000 sibling/nested nodes', () => {
  const blocks = Array.from({ length: 1505 }, (_, index) => ({ kind: 'text', text: String(index) }));
  const message = ir.createMessage({ role: 'assistant', blocks }, 0);
  const keys = message.blocks.map((block) => block.renderKey);
  assert.equal(new Set(keys).size, keys.length);
  const nested = ir.createBlock({ kind: 'list', items: [[{ kind: 'text', text: 'x' }]] }, { messageKey: 'message:a', path: '1501' });
  assert.notEqual(nested.renderKey, nested.items[0].renderKey);
});

check('creates immutable conversation/message/block structures', () => {
  const doc = ir.createConversation({
    id: 'conversation-1',
    messages: [
      { id: 'm1', role: 'user', blocks: [{ kind: 'paragraph', children: [{ kind: 'text', text: 'Q' }] }] },
      { id: 'm2', role: 'assistant', blocks: [{ kind: 'codeBlock', language: 'js', code: '1 + 1' }] },
    ],
  });
  assert.equal(doc.transient, true);
  assert.equal(Object.isFrozen(doc), true);
  assert.equal(Object.isFrozen(doc.messages[0]), true);
  assert.equal(Object.isFrozen(doc.messages[0].blocks[0]), true);
  assert.equal(ir.validate(doc).ok, true, ir.validate(doc).errors.join('; '));
});

check('validation rejects duplicate projection keys and malformed semantic nodes', () => {
  const bad = {
    schema: ir.schema,
    schemaVersion: ir.schemaVersion,
    transient: true,
    messages: [
      { renderKey: 'dup', role: 'assistant', blocks: [{ renderKey: 'dup', kind: 'heading', level: 9 }] },
    ],
  };
  const result = ir.validate(bad);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /duplicate renderKey/.test(e)));
  assert.ok(result.errors.some((e) => /level/.test(e)));
});

check('foundation stays free of DOM, persistence, Reader navigation and Sync authority', () => {
  assert.doesNotMatch(source, /document\.|querySelector|localStorage|sessionStorage|indexedDB|__TAURI__|H2O\.Studio\.sync|history\.|location\.|scrollTo\(/);
});

/* ---- M03 P2 S2A T4 S0: additive semantic kinds ------------------------- */

check('S0. thematicBreak is a first-class block separator with no payload', () => {
  const doc = ir.createConversation({ id: 's0-tb',
    messages: [{ id: 'm1', role: 'assistant', blocks: [
      { kind: 'paragraph', children: [{ kind: 'text', text: 'before' }] },
      { kind: 'thematicBreak' },
      { kind: 'paragraph', children: [{ kind: 'text', text: 'after' }] },
    ] }] });
  assert.deepEqual(doc.messages[0].blocks.map((b) => b.kind), ['paragraph', 'thematicBreak', 'paragraph']);
  const result = ir.validate(doc);
  assert.equal(result.ok, true, result.errors.join('; '));

  const withPayload = JSON.parse(JSON.stringify(doc));
  withPayload.messages[0].blocks[1].text = 'not allowed';
  const bad = ir.validate(withPayload);
  assert.equal(bad.ok, false, 'a separator must not carry a text payload');
  assert.ok(bad.errors.some((e) => /must not carry a text payload/.test(e)));
});

check('S0. hardBreak is inline-only, payload-free, and rejected at message level', () => {
  const inline = ir.createConversation({ id: 's0-hb',
    messages: [{ id: 'm1', role: 'assistant', blocks: [
      { kind: 'paragraph', children: [{ kind: 'text', text: 'a' }, { kind: 'hardBreak' }, { kind: 'text', text: 'b' }] },
    ] }] });
  assert.deepEqual(inline.messages[0].blocks[0].children.map((c) => c.kind), ['text', 'hardBreak', 'text']);
  assert.equal(ir.validate(inline).ok, true, ir.validate(inline).errors.join('; '));

  const blockLevel = ir.createConversation({ id: 's0-hb-bad',
    messages: [{ id: 'm1', role: 'assistant', blocks: [{ kind: 'hardBreak' }] }] });
  const result = ir.validate(blockLevel);
  assert.equal(result.ok, false, 'a block-level hardBreak is not a truthful semantic break');
  assert.ok(result.errors.some((e) => /only valid inside an inline children collection/.test(e)));

  const withPayload = JSON.parse(JSON.stringify(inline));
  withPayload.messages[0].blocks[0].children[1].text = 'not allowed';
  assert.equal(ir.validate(withPayload).ok, false, 'hardBreak must not carry a text payload');
});

check('S0. the document shape is unchanged and carries no extra version axis', () => {
  const doc = ir.createConversation({ id: 's0-shape', messages: [{ id: 'm1', role: 'user', blocks: [] }] });
  assert.deepEqual(Object.keys(doc).sort(),
    ['messages', 'ownerRef', 'renderKey', 'schema', 'schemaVersion', 'transient'],
    'the T4 vocabulary addition must not add a top-level field');
  assert.equal(Object.keys(ir).filter((k) => /vocab/i.test(k)).length, 0,
    'the API must expose no vocabulary-version surface');
  /* Active guard over the removed ARCHITECTURE, not the ordinary English word:
   * prose such as "the Render IR vocabulary remains closed" is fine, while the
   * deleted vocabularyVersion mechanism and its constants must not return. */
  assert.doesNotMatch(source, /vocabularyVersion|VOCABULARY_VERSION|BLOCK_KIND_VOCABULARY/,
    'the removed vocabularyVersion mechanism must not reappear in the Render IR source');
  /* A pre-T4 document - one that simply never mentions the new kinds - is
   * still valid, unchanged. */
  const legacy = { schema: ir.schema, schemaVersion: 1, transient: true,
    messages: [{ renderKey: 'm1', role: 'user', blocks: [
      { renderKey: 'b1', kind: 'paragraph', children: [{ renderKey: 'b1t', kind: 'text', text: 'hello' }] }] }] };
  assert.equal(ir.validate(legacy).ok, true, 'pre-T4 documents must keep validating unchanged');
});

check('S0. every legacy T2 kind and mark remains constructible and valid', () => {
  for (const kind of ['paragraph', 'heading', 'text', 'list', 'listItem', 'blockquote', 'codeBlock',
    'table', 'tableRow', 'tableCell', 'image', 'file', 'math', 'citation', 'toolCall', 'toolResult',
    'artifact', 'opaqueProviderBlock']) {
    assert.ok([...ir.blockKinds].includes(kind), `missing legacy kind ${kind}`);
  }
  for (const kind of ['thematicBreak', 'hardBreak']) {
    assert.ok([...ir.blockKinds].includes(kind), `missing T4 kind ${kind}`);
  }
  const doc = ir.createConversation({ id: 's0-legacy',
    messages: [{ id: 'm1', role: 'assistant', blocks: [
      { kind: 'heading', level: 6, children: [{ kind: 'text', text: 'deep' }] },
      { kind: 'codeBlock', language: 'js', code: '1 + 1' },
      { kind: 'list', items: [[{ kind: 'text', text: 'x' }]] },
      { kind: 'blockquote', blocks: [{ kind: 'paragraph', children: [{ kind: 'text', text: 'q' }] }] },
      { kind: 'opaqueProviderBlock', opaqueKind: 'ownerSanitizedHtml', html: '<p>x</p>' },
    ] }] });
  assert.equal(ir.validate(doc).ok, true, ir.validate(doc).errors.join('; '));
  for (const mark of ['strong', 'emphasis', 'code', 'strikethrough', 'link']) {
    assert.equal(ir.createMark({ kind: mark }).kind, mark);
  }
});

check('S0. unknown block and mark kinds are still rejected', () => {
  for (const kind of ['footnote', 'markdownHtml', 'alert', 'mermaid', 'softBreak']) {
    assert.throws(() => ir.createBlock({ kind }, { messageKey: 'm', path: '0' }), /Unsupported Render IR block kind/);
  }
  assert.throws(() => ir.createMark({ kind: 'highlight' }), /Unsupported Render IR mark kind/);
  const doc = { schema: ir.schema, schemaVersion: 1, transient: true,
    messages: [{ renderKey: 'm1', role: 'user', blocks: [{ renderKey: 'b1', kind: 'footnote' }] }] };
  assert.equal(ir.validate(doc).ok, false);
});

check('S0. T2 invariants survive the vocabulary addition', () => {
  const doc = ir.createConversation({ id: 's0-inv',
    messages: [{ id: 'm1', role: 'tool', contentBlockId: 'owner-block-1', blocks: [
      { kind: 'thematicBreak' },
      { kind: 'paragraph', children: [{ kind: 'text', text: 'x' }, { kind: 'hardBreak' }] },
    ] }] });
  assert.equal(doc.transient, true);
  assert.equal(Object.isFrozen(doc), true);
  assert.equal(Object.isFrozen(doc.messages[0].blocks[0]), true);
  assert.equal(doc.messages[0].role, 'tool');
  assert.throws(() => ir.createMessage({ role: 'narrator', blocks: [] }, 0), /Unsupported Render IR role/);
  assert.equal(Object.prototype.hasOwnProperty.call(doc.messages[0], 'contentBlockId'), false);
  assert.equal(doc.messages[0].ownerRef, 'owner-block-1');
  for (const block of doc.messages[0].blocks) {
    assert.equal(Object.prototype.hasOwnProperty.call(block, 'contentBlockId'), false);
    assert.match(block.renderKey, /^message:/);
  }
  const keys = new Set(doc.messages[0].blocks.map((b) => b.renderKey));
  assert.equal(keys.size, doc.messages[0].blocks.length);
  assert.doesNotMatch(source, /localStorage|sessionStorage|indexedDB|document\./);
});

/* M03 P4 S4A T8 slice A: the Semantic Index projects Render IR identity, it
 * never competes with it. Loaded into the same sandbox so the invariant is
 * checked against the real modules, over minimal element-like shells. */
check('S4A. the Semantic Index reuses Render IR renderKey / ownerRef verbatim and mints no competing or durable identity', () => {
  const indexPath = path.join(REPO_ROOT, 'src-surfaces-base/studio/renderer/semantic/semantic-index.v1.js');
  const indexSource = fs.readFileSync(indexPath, 'utf8');
  vm.runInContext(indexSource, sandbox, { filename: indexPath });
  const index = sandbox.H2O.Studio.Renderer.semanticIndex;
  assert.equal(index.__installed, true); assert.equal(index.schema, 'h2o.renderer.semantic-index'); assert.equal(index.schemaVersion, 1);
  assert.equal(Object.isFrozen(index), true);
  const conversation = ir.createConversation({ ownerRef: { type: 'h2o.savedChat.snapshot', id: 'chat', version: 'snap' }, messages: [
    { role: 'user', ownerRef: { type: 'h2o.savedChat.message', id: 'u1' }, blocks: [{ kind: 'paragraph', children: [{ kind: 'text', text: 'q' }] }] },
    { role: 'assistant', ownerRef: { type: 'h2o.savedChat.message', id: 'a1', anchor: 'u1' }, blocks: [] },
  ] });
  assert.equal(ir.validate(conversation).ok, true);
  /* Minimal element-like shells: nodeType 1, class list, attributes, children. */
  const el = (className, attrs = {}) => { const node = { nodeType: 1, className, children: [], attrs, classList: { contains: (c) => className.split(' ').includes(c) }, getAttribute: (n) => (n in attrs ? attrs[n] : null), isConnected: false }; return node; };
  const shells = conversation.messages.map((m, i) => { const turn = el(`cgTurn cgTurn--${m.role}`, { 'data-turn': m.role, 'data-h2o-turn-no': String(i + 1) }); const host = el(`cgMsg cgMsg--${m.role}`, { 'data-message-author-role': m.role }); turn.children.push(host); return turn; });
  const turnsEl = el('cgScroll wbRichRoot'); turnsEl.children.push(...shells); const root = el('cgFrame'); root.children.push(turnsEl);
  const built = index.createShellIndex({ root, turnsEl, renderMode: 'canonical', source: { chatId: 'chat', snapshotId: 'snap' }, semanticConversation: conversation, describeTurn: () => null });
  assert.equal(built.basis, 'semantic');
  assert.equal(built.getConversation().projectionKey, conversation.renderKey, 'conversation projection key is the Render IR renderKey');
  assert.equal(JSON.stringify(built.getConversation().ownerRef), JSON.stringify(conversation.ownerRef));
  assert.equal(JSON.stringify(built.messages().map((m) => m.projectionKey)), JSON.stringify(conversation.messages.map((m) => m.renderKey)), 'message projection keys are the Render IR renderKeys, verbatim');
  assert.equal(JSON.stringify(built.messages().map((m) => m.ownerRef)), JSON.stringify(conversation.messages.map((m) => m.ownerRef)), 'ownerRefs pass through untouched');
  assert.equal(JSON.stringify(built.turns().map((t) => t.projectionKey)), JSON.stringify(conversation.messages.map((m) => `turn:semantic:${encodeURIComponent(m.renderKey)}`)), 'turn keys wrap the message renderKey by projection kind');
  for (const rec of [built.getConversation(), ...built.turns(), ...built.messages()]) {
    assert.equal(Object.prototype.hasOwnProperty.call(rec, 'contentBlockId'), false, 'no Renderer-owned durable id');
    assert.equal(Object.isFrozen(rec), true);
  }
  assert.doesNotMatch(indexSource, /contentBlockId|Date\.now|Math\.random|randomUUID|localStorage|sessionStorage|indexedDB/, 'the index neither mints durable identity nor persists');
  /* The Render IR module itself is untouched by the index: same frozen API, same key algorithm. */
  assert.equal(ir.makeRenderKey('message', 'x', 0), 'message:owner%3Ax'); assert.equal(ir.makeRenderKey('message', '', 3), 'message:path%3A3');
});

check('S4A. content projections keep the Render IR block renderKey as their identity basis, scoped by the parent message projection', () => {
  const index = sandbox.H2O.Studio.Renderer.semanticIndex;
  assert.equal(index.__version, '0.2.0-m03-s4a'); assert.equal(JSON.stringify([...index.kinds]), JSON.stringify(['conversation', 'turn', 'message', 'block', 'text']));
  const conversation = ir.createConversation({ ownerRef: { type: 'h2o.savedChat.snapshot', id: 'chat', version: 'snap' }, messages: [
    { role: 'assistant', ownerRef: { type: 'h2o.savedChat.message', id: 'a1' }, blocks: [ { kind: 'paragraph', children: [{ kind: 'text', text: 'hello', marks: [{ kind: 'strong' }] }, { kind: 'text', text: ' world' }] }, { kind: 'thematicBreak' }, { kind: 'paragraph', ownerRef: { type: 'owner.block', id: 'b-77' }, children: [{ kind: 'text', text: 'owned' }] } ] },
  ] });
  assert.equal(ir.validate(conversation).ok, true);
  const el = (className, attrs = {}) => ({ nodeType: 1, className, children: [], parentNode: null, classList: { contains: (c) => className.split(' ').includes(c) }, getAttribute: (n) => (n in attrs ? attrs[n] : null), isConnected: false });
  const textNode = (text) => ({ nodeType: 3, nodeValue: text, isConnected: false });
  const turn = el('cgTurn cgTurn--assistant', { 'data-turn': 'assistant', 'data-h2o-turn-no': '1' }); const host = el('cgMsg cgMsg--assistant', { 'data-message-author-role': 'assistant' }); const body = el('cgMsgBody'); body.parentNode = host; host.children.push(body); turn.children.push(host);
  const turnsEl = el('cgScroll wbRichRoot'); turnsEl.children.push(turn); const root = el('cgFrame'); root.children.push(turnsEl);
  /* Reports as the ContentRenderer seam issues them: pre-order, text targets are Text nodes. */
  const message = conversation.messages[0]; const reports = [];
  const walk = (node) => { reports.push({ report: { projection: node.kind === 'text' ? 'text' : 'block', block: node, target: node.kind === 'text' ? textNode(node.text) : el(node.kind) }, bodyEl: body }); for (const key of ['children', 'blocks', 'items', 'rows', 'cells']) if (Array.isArray(node[key])) node[key].forEach(walk); };
  message.blocks.forEach(walk);
  const built = index.createShellIndex({ root, turnsEl, renderMode: 'canonical', source: { chatId: 'chat', snapshotId: 'snap' }, semanticConversation: conversation, describeTurn: () => null, contentProjections: reports, contentBodies: new Set([body]) });
  const msg = built.messages()[0];
  assert.equal(msg.projectionKey, message.renderKey); assert.equal(msg.contentIndexed, true);
  const records = [...built.blocks(), ...built.texts()].sort((a, b) => a.ordinal - b.ordinal);
  assert.equal(JSON.stringify(records.map((r) => r.renderKey)), JSON.stringify(reports.map((r) => r.report.block.renderKey)), 'every content record retains its Render IR renderKey, in pre-order');
  for (const r of records) {
    assert.equal(r.basis, 'render-ir'); assert.equal(r.messageKey, message.renderKey);
    assert.equal(r.projectionKey, `${r.kind}:render:${encodeURIComponent(message.renderKey)}:${encodeURIComponent(r.renderKey)}`, 'projection key = kind : parent message key : Render IR renderKey');
    assert.equal(Object.prototype.hasOwnProperty.call(r, 'contentBlockId'), false); assert.equal(Object.isFrozen(r), true);
  }
  assert.equal(JSON.stringify(records.map((r) => r.ownerRef)), JSON.stringify([null, null, null, null, { type: 'owner.block', id: 'b-77' }, null]), 'ownerRef comes only from the Render IR block ownerRef (owner-supplied), never from ids or text');
  assert.equal(built.texts().every((t) => t.target.nodeType === 3), true, 'text targets are Text nodes'); assert.equal(built.blocks().every((b) => b.target.nodeType === 1), true);
  assert.equal(built.texts().length, 3); assert.equal(built.blocks().length, 3);
  assert.equal(built.getGeometry(built.texts()[0].projectionKey), null, 'unconnected text target -> null geometry');
});

console.log(`PASS ${checks.length}`);
