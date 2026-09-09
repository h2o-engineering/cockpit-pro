#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), '..', '..', '..');
const MODULE_REL = 'src-surfaces-base/studio/renderer/semantic/render-ir.v1.js';
const source = fs.readFileSync(path.join(REPO_ROOT, MODULE_REL), 'utf8');
const sandbox = vm.createContext({ console });
sandbox.globalThis = sandbox;
vm.runInContext(source, sandbox, { filename: MODULE_REL });
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
  assert.equal(ir.schemaVersion, 1);
  assert.match(ir.__version, /^0\.1\.0-m03-foundation$/);
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

console.log(`PASS ${checks.length}`);
