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

console.log(`PASS ${checks.length}`);
