#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), '..', '..', '..');
const irPath = process.argv[2] || path.join(REPO_ROOT, 'src-surfaces-base/studio/renderer/semantic/render-ir.v1.js');
const ingressPath = process.argv[3] || path.join(REPO_ROOT, 'src-surfaces-base/studio/renderer/semantic/semantic-ingress.v1.js');
const fixturePath = process.argv[4] || path.join(REPO_ROOT, 'tools/validation/fixtures/studio-renderer-semantic/semantic-ingress-cases.v1.json');

const irSource = fs.readFileSync(irPath, 'utf8');
const ingressSource = fs.readFileSync(ingressPath, 'utf8');
const fixtures = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));

const sandbox = vm.createContext({ console });
sandbox.globalThis = sandbox;
vm.runInContext(irSource, sandbox, { filename: irPath });
vm.runInContext(ingressSource, sandbox, { filename: ingressPath });

const ir = sandbox.H2O?.Studio?.Renderer?.renderIR;
const ingress = sandbox.H2O?.Studio?.Renderer?.semanticIngress;
assert.ok(ir, 'Render IR API did not register');
assert.ok(ingress, 'Semantic ingress API did not register');

const checks = [];
function check(label, fn) {
  fn();
  checks.push(label);
  console.log(`✓ ${label}`);
}

/* Cross-surface conformance projection: the stable, language-neutral shape a
 * Web/Studio or Mobile implementation must agree on. Render keys are excluded
 * on purpose because they are projection-local and transient. */
const PROJECTED_BLOCK_FIELDS = [
  'opaqueKind', 'mediaType', 'ownerSanitized', 'ownerContentType', 'ownerContent',
  'text', 'html', 'src', 'thumbnailSrc', 'alt', 'width', 'height', 'captureStatus',
];

function projectBlock(block) {
  const out = { kind: block.kind };
  for (const field of PROJECTED_BLOCK_FIELDS) {
    if (block[field] !== undefined) out[field] = block[field];
  }
  if (block.ownerRef != null) out.ownerRef = block.ownerRef;
  if (Array.isArray(block.children)) out.children = Array.from(block.children, projectBlock);
  return out;
}

function projectConversation(doc) {
  const out = { ok: true };
  if (doc.ownerRef != null) out.ownerRef = doc.ownerRef;
  out.messages = Array.from(doc.messages, (message) => {
    const projected = { role: message.role, dir: message.dir };
    if (message.ownerRef != null) projected.ownerRef = message.ownerRef;
    projected.blocks = Array.from(message.blocks, projectBlock);
    return projected;
  });
  /* The module under test runs in a vm sandbox, so IR objects carry that
   * realm's intrinsics. Round-tripping yields plain host-realm data, which is
   * also exactly the surface-neutral form a Mobile implementation would emit. */
  return JSON.parse(JSON.stringify(out));
}

function runCase(fixtureCase) {
  try {
    return { ok: true, doc: ingress.fromSource(fixtureCase.input, fixtureCase.sourceKind) };
  } catch (error) {
    return { ok: false, error };
  }
}

function caseById(id) {
  const found = fixtures.cases.find((entry) => entry.id === id);
  assert.ok(found, `missing fixture case: ${id}`);
  return found;
}

function ingestById(id) {
  const result = runCase(caseById(id));
  assert.ok(result.ok, `fixture case ${id} unexpectedly failed: ${result.error?.message}`);
  return result.doc;
}

check('installs a Renderer-owned ingress API on top of Render IR v1 without redefining it', () => {
  assert.equal(ingress.schema, 'h2o.renderer.semantic-ingress');
  assert.equal(ingress.schemaVersion, 1);
  assert.match(ingress.__version, /^0\.1\.0-m03-foundation$/);
  assert.equal(ir.schema, 'h2o.renderer.render-ir');
  assert.equal(ir.schemaVersion, 1);
  assert.deepEqual([...ingress.supportedV3ContentTypes], ['text', 'html']);
  assert.equal(ingress.sourceKinds.NORMALIZED_STUDIO, 'normalizedStudioSnapshot');
  assert.equal(ingress.sourceKinds.SAVED_CHAT_V3, 'savedChatSnapshotV3');
});

check('maps current normalized Studio user and assistant messages into Render IR', () => {
  const user = ingestById('current-user-plain-text');
  assert.equal(user.messages[0].role, 'user');
  assert.equal(user.messages[0].blocks[0].kind, 'paragraph');
  assert.equal(user.messages[0].blocks[0].children[0].text, 'What is H2O?');

  const assistant = ingestById('current-assistant-plain-text-rtl');
  assert.equal(assistant.messages[0].role, 'assistant');
  assert.equal(assistant.messages[0].dir, 'rtl');
  assert.equal(assistant.messages[0].blocks[0].children[0].text, 'H2O is a platform.');
});

check('preserves all four canonical roles including system and tool', () => {
  const doc = ingestById('current-four-canonical-roles');
  assert.deepEqual(doc.messages.map((m) => m.role), ['user', 'assistant', 'system', 'tool']);
  const v3Tool = ingestById('v3-unsupported-future-content-type');
  assert.equal(v3Tool.messages[0].role, 'tool');
});

check('fails closed on unknown roles instead of coercing them to assistant', () => {
  for (const id of ['current-unknown-role-fails-closed', 'v3-unknown-role-fails-closed']) {
    const result = runCase(caseById(id));
    assert.equal(result.ok, false, `${id} should fail closed`);
    assert.match(result.error.message, /semantic-ingress: .*unsupported role/);
    assert.doesNotMatch(result.error.message, /assistant/);
  }
});

check('maps Saved-Chat v3 typed text content[] into Render IR', () => {
  const doc = ingestById('v3-text-content');
  assert.equal(doc.messages[0].blocks.length, 1);
  assert.equal(doc.messages[0].blocks[0].kind, 'paragraph');
  assert.equal(doc.messages[0].blocks[0].children[0].text, 'hello');
  const wrongVersion = runCase(caseById('v3-wrong-schema-version-fails-closed'));
  assert.equal(wrongVersion.ok, false);
  assert.match(wrongVersion.error.message, /schemaVersion must be 3/);
});

check('represents owner-sanitized HTML as controlled opaque content and refuses unsanitized HTML', () => {
  const doc = ingestById('v3-sanitized-html-content');
  const block = doc.messages[0].blocks[0];
  assert.equal(block.kind, 'opaqueProviderBlock');
  assert.equal(block.opaqueKind, ingress.opaqueKinds.OWNER_SANITIZED_HTML);
  assert.equal(block.mediaType, 'text/html');
  assert.equal(block.ownerSanitized, true);
  assert.equal(block.html, '<p>Sanitized</p>');

  const unsafe = runCase(caseById('v3-unsanitized-html-fails-closed'));
  assert.equal(unsafe.ok, false);
  assert.match(unsafe.error.message, /not marked sanitized/);

  const legacy = runCase(caseById('v3-legacy-scalar-content-fails-closed'));
  assert.equal(legacy.ok, false);
  assert.match(legacy.error.message, /legacy scalar content/);
});

check('preserves multipart owner content order one owner part to one IR block', () => {
  const fixtureCase = caseById('v3-ordered-multipart-text-and-html');
  const doc = ingestById('v3-ordered-multipart-text-and-html');
  const parts = fixtureCase.input.messages[0].content;
  const blocks = doc.messages[0].blocks;
  assert.equal(blocks.length, parts.length);
  assert.deepEqual(blocks.map((b) => b.kind), ['paragraph', 'opaqueProviderBlock', 'paragraph']);
  assert.equal(blocks[0].children[0].text, 'first');
  assert.equal(blocks[1].html, '<p>second</p>');
  assert.equal(blocks[2].children[0].text, 'third');
});

check('applies one controlled policy to unsupported owner content without claiming semantic support', () => {
  const doc = ingestById('v3-unsupported-future-content-type');
  const block = doc.messages[0].blocks[0];
  assert.equal(block.kind, 'opaqueProviderBlock');
  assert.equal(block.opaqueKind, ingress.opaqueKinds.UNSUPPORTED_OWNER_CONTENT);
  assert.equal(block.ownerContentType, 'futureWidget');
  assert.equal(block.ownerContent.widgetId, 'w-9');
  assert.equal(block.ownerContent.payload.a, 1);
  assert.ok(!ingress.supportedV3ContentTypes.includes('futureWidget'));
  assert.equal(ir.validate(doc).ok, true, ir.validate(doc).errors.join('; '));
});

check('keeps owner-issued identity as references and mints no Renderer durable IDs', () => {
  const doc = ingestById('v3-ordered-multipart-text-and-html');
  const message = doc.messages[0];
  assert.deepEqual({ ...message.ownerRef }, { type: 'h2o.savedChat.message', id: 'm2', anchor: 'm1' });
  for (const durable of ['contentBlockId', 'messageId', 'id', 'semanticRef']) {
    assert.equal(Object.prototype.hasOwnProperty.call(message, durable), false, `message must not expose ${durable}`);
    for (const block of message.blocks) {
      assert.equal(Object.prototype.hasOwnProperty.call(block, durable), false, `block must not expose ${durable}`);
    }
  }
  assert.notEqual(message.renderKey, 'm2');
  assert.match(message.renderKey, /^message:/);
  for (const block of message.blocks) assert.match(block.renderKey, /^message:/);

  const studio = ingestById('current-user-plain-text');
  assert.deepEqual({ ...studio.messages[0].ownerRef }, { type: 'h2o.studio.message', id: 'm-1', anchor: 't-1' });
  assert.deepEqual({ ...studio.ownerRef }, { type: 'h2o.studio.chatSnapshot', id: 'chat-1', version: 'snap-1' });
});

check('never mutates or freezes owner input objects', () => {
  for (const fixtureCase of fixtures.cases) {
    const before = JSON.parse(JSON.stringify(fixtureCase.input));
    runCase(fixtureCase);
    assert.deepEqual(fixtureCase.input, before, `${fixtureCase.id} mutated its owner input`);
    assert.equal(Object.isFrozen(fixtureCase.input), false, `${fixtureCase.id} froze its owner input`);
    for (const message of fixtureCase.input.messages || []) {
      assert.equal(Object.isFrozen(message), false, `${fixtureCase.id} froze an owner message`);
    }
  }
});

check('produces conversations that pass existing Render IR v1 validation', () => {
  let validated = 0;
  for (const fixtureCase of fixtures.cases) {
    if (fixtureCase.expect.ok !== true) continue;
    const doc = ingestById(fixtureCase.id);
    assert.equal(doc.schema, ir.schema);
    assert.equal(doc.schemaVersion, ir.schemaVersion);
    assert.equal(doc.transient, true);
    assert.equal(Object.isFrozen(doc), true);
    const result = ir.validate(doc);
    assert.equal(result.ok, true, `${fixtureCase.id}: ${result.errors.join('; ')}`);
    validated += 1;
  }
  assert.ok(validated >= 7, `expected at least 7 validated conversations, got ${validated}`);
});

check('matches every declared cross-surface conformance projection', () => {
  assert.equal(fixtures.schema, 'h2o.renderer.semantic-ingress-fixtures');
  assert.equal(fixtures.schemaVersion, 1);
  assert.ok(fixtures.cases.length >= 12, 'fixture set must cover the required conformance cases');
  for (const fixtureCase of fixtures.cases) {
    const result = runCase(fixtureCase);
    if (fixtureCase.expect.ok === true) {
      assert.ok(result.ok, `${fixtureCase.id} unexpectedly failed: ${result.error?.message}`);
      assert.deepEqual(projectConversation(result.doc), fixtureCase.expect, `${fixtureCase.id} conformance projection mismatch`);
    } else {
      assert.equal(result.ok, false, `${fixtureCase.id} should have failed closed`);
      assert.match(result.error.message, new RegExp(fixtureCase.expect.errorMatch), `${fixtureCase.id} error mismatch`);
    }
  }
});

check('ingress stays free of DOM, sanitizer, persistence and provider-markup authority', () => {
  assert.doesNotMatch(ingressSource, /document\.|querySelector|innerHTML|outerHTML|localStorage|sessionStorage|indexedDB|__TAURI__|H2O\.Studio\.sync|history\.|location\.|scrollTo\(/);
  assert.doesNotMatch(ingressSource, /sanitizeHtml|richTurns/);
});

console.log(`PASS ${checks.length}`);
