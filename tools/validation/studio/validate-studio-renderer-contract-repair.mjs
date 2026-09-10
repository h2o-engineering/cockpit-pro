#!/usr/bin/env node
// Focused regression coverage for the Studio renderer contract and extracted
// Phase 3 module boundary, the focused T09/T10 fidelity/resilience round, and
// the T13 base-transcript accessibility semantics.
// Uses small DOM seams around the real renderer functions so the validator stays
// dependency-free while exercising role fidelity, rich success/fallback state,
// shared sanitization order, assistant-only collection, malformed input, and
// deterministic whole-transcript rich/canonical selection.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), '..', '..', '..');
const STUDIO_REL = 'src-surfaces-base/studio/studio.js';
const RENDERER_REL = 'src-surfaces-base/studio/renderer/chat-renderer.studio.js';
const STUDIO_HTML_REL = 'src-surfaces-base/studio/studio.html';
const ARCHIVE_REL = 'src-surfaces-base/studio/S0D3a. 🎬 Transcript Archive Engine - Studio.js';
const SANITIZER_REL = 'src-surfaces-base/studio/platform/html-sanitizer.js';

function readRepo(rel) {
  return fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
}

function extractFunction(source, name) {
  const match = new RegExp(`\\bfunction\\s+${name}\\s*\\(`).exec(source);
  if (!match) throw new Error(`extractFunction: '${name}' not found`);
  const start = match.index;
  const braceOpen = source.indexOf('{', start);
  let depth = 0;
  for (let i = braceOpen; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`extractFunction: unterminated '${name}'`);
}

function stripJsComments(source) {
  let out = '';
  let i = 0;
  let quote = '';
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    if (quote) {
      if (ch === '\\') { out += ch + (next ?? ''); i += 2; continue; }
      if (ch === quote) quote = '';
      out += ch; i += 1; continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; out += ch; i += 1; continue; }
    if (ch === '/' && next === '*') { const e = source.indexOf('*/', i + 2); i = e === -1 ? source.length : e + 2; out += ' '; continue; }
    if (ch === '/' && next === '/') { const e = source.indexOf('\n', i); i = e === -1 ? source.length : e; out += ' '; continue; }
    out += ch; i += 1;
  }
  return out;
}

const studioSource = readRepo(STUDIO_REL);
const rendererSource = readRepo(RENDERER_REL);
const studioHtmlSource = readRepo(STUDIO_HTML_REL);
const archiveSource = readRepo(ARCHIVE_REL);
const roleContract = {
  USER: 'user',
  ASSISTANT: 'assistant',
  SYSTEM: 'system',
  TOOL: 'tool',
};

function loadFunction(source, name, globals = {}) {
  const context = vm.createContext({ ...globals });
  vm.runInContext(`${extractFunction(source, name)}\nthis.result = ${name};`, context);
  return { fn: context.result, context };
}

function validateRoleFidelity() {
  const studio = loadFunction(rendererSource, 'normalizeRole', { ROLES: roleContract }).fn;
  const archive = loadFunction(archiveSource, 'normalizeRole', {
    H2O: { Studio: { SELECTORS: { ROLES: roleContract } } },
  }).fn;

  for (const role of ['user', 'assistant', 'system', 'tool']) {
    assert.equal(studio(role), role, `Studio renderer collapsed ${role}`);
    assert.equal(archive(role), role, `S0D3a adapter collapsed ${role}`);
  }
  assert.equal(studio('SYSTEM'), 'system', 'Studio role normalization must remain case-insensitive');
  assert.equal(archive('TOOL'), 'tool', 'S0D3a role normalization must remain case-insensitive');
  assert.equal(studio('unknown'), '', 'unknown Renderer roles must not silently become assistant turns');
  assert.equal(studio('', 'user'), 'user', 'Renderer-local callers may provide an explicit canonical fallback');
  assert.equal(archive('unknown'), 'assistant', 'unknown S0D3a roles retain the legacy assistant fallback');
}

function validateRendererInputContract() {
  const sandbox = vm.createContext({
    NORMALIZED_INPUT: Symbol('renderer-input'),
    ROLES: roleContract,
    String,
    Number,
    Array,
    Object,
    Set,
    URL,
  });
  const helpers = [
    'resolveSnapshotTurnCreateTime',
    'normalizeRole',
    'normalizeSafeImageSrc',
    'normalizeAttachmentRecord',
    'normalizeAttachments',
    'normalizeRichTurns',
    'normalizeRendererMessage',
    'normalizeRendererMessages',
    'normalizeInput',
    'haveEquivalentRendererAttachments',
    'haveEquivalentRendererMessages',
    'haveEquivalentRendererRichTurns',
    'isRenderEquivalent',
  ].map((name) => extractFunction(rendererSource, name)).join('\n');
  vm.runInContext(`${helpers}\nthis.normalizeRendererInput = normalizeInput;\nthis.isRenderEquivalent = isRenderEquivalent;`, sandbox);

  const source = {
    snapshotId: 'snap-1',
    chatId: 'chat-1',
    meta: {
      title: 'Contract chat',
      projectId: 'project-1',
      turnCreateTimes: { 2: 42 },
      richTurns: [{ turnIdx: 1, role: 'system', outerHTML: '<section></section>' }],
    },
    messages: [
      { order: 4, role: 'user', text: 'u', messageId: 'm-u' },
      { order: 1, role: 'assistant', text: 'a', turnId: 't-a' },
      { order: 3, role: 'system', text: 's' },
      { order: 2, role: 'tool', text: 't' },
    ],
  };
  const before = JSON.stringify(source);
  const input = sandbox.normalizeRendererInput(source);

  assert.deepEqual(Array.from(input.messages, (row) => row.role),
    ['user', 'assistant', 'system', 'tool'],
    'normalized Renderer input must preserve all four roles and source order');
  assert.equal(input.messages[1].createTime, 42, 'metadata timestamp projection must survive normalization');
  assert.equal(input.messages[0].messageId, 'm-u');
  assert.equal(input.messages[1].turnId, 't-a');
  assert.equal(input.richTurns[0].role, 'system');
  assert.equal(input.title, 'Contract chat');
  assert.equal(input.projectId, 'project-1');
  assert.equal(JSON.stringify(source), before, 'Renderer normalization must not mutate the saved snapshot');
  assert.notEqual(input.messages, source.messages, 'Renderer input must be logically detached from platform records');

  const desktopShape = {
    snapshotId: source.snapshotId,
    chatId: source.chatId,
    metadata: source.meta,
    messages: source.messages,
  };
  const desktopInput = sandbox.normalizeRendererInput(desktopShape);
  assert.deepEqual(
    JSON.parse(JSON.stringify(desktopInput)),
    JSON.parse(JSON.stringify(input)),
    'meta and metadata source projections must converge on one logical Renderer input'
  );

  const malformedSource = {
    messages: [
      {
        role: 'user',
        text: '',
        messageId: ' duplicate-message ',
        turnId: 'duplicate-turn',
        attachments: [
          { kind: 'image', thumbnailSrc: 'https://example.com/image.png', alt: 'safe' },
          { kind: 'image', thumbnailSrc: 'data:image/webp;base64,QUJDRA==', captureStatus: 'embedded' },
          { kind: 'image', thumbnailSrc: 'javascript:alert(1)', captureStatus: 'linked' },
          { kind: 'file', src: 'https://example.com/file.pdf' },
          { kind: 'image', captureStatus: 'failed', error: 'capture failed' },
        ],
      },
      { role: 'assistant', text: 'kept', messageId: 'duplicate-message', turnId: 'duplicate-turn' },
      { role: 'mystery', text: 'must not become an answer' },
      { text: 'missing role must stay local' },
    ],
  };
  const malformedBefore = JSON.stringify(malformedSource);
  const resilient = sandbox.normalizeRendererInput(malformedSource);
  assert.deepEqual(Array.from(resilient.messages, (row) => row.role), ['user', 'assistant'],
    'missing/unknown roles must be omitted locally without collapsing the valid transcript');
  assert.equal(resilient.messages[0].text, '', 'valid empty content must survive normalization');
  assert.equal(resilient.messages[0].messageId, 'duplicate-message');
  assert.equal(resilient.messages[0].turnId, 'duplicate-turn');
  assert.equal(resilient.messages[1].messageId, '', 'later duplicate message IDs must be omitted');
  assert.equal(resilient.messages[1].turnId, '', 'later duplicate turn IDs must be omitted');
  assert.equal(resilient.messages[0].attachments.length, 3,
    'safe remote/data images and a failed record must survive while unsafe/unsupported records degrade away');
  assert.equal(resilient.messages[0].attachments[1].thumbnailSrc, 'data:image/webp;base64,QUJDRA==');
  assert.equal(resilient.messages[0].attachments[2].captureStatus, 'failed');
  assert.equal(JSON.stringify(malformedSource), malformedBefore,
    'malformed input projection must not mutate the saved snapshot');

  const metadataFree = sandbox.normalizeRendererInput({ messages: [{ role: 'tool' }] });
  const metadataFreeAgain = sandbox.normalizeRendererInput({ messages: [{ role: 'tool' }] });
  assert.equal(metadataFree.title, 'Saved chat');
  assert.equal(metadataFree.messages[0].text, '');
  assert.deepEqual(JSON.parse(JSON.stringify(metadataFree)), JSON.parse(JSON.stringify(metadataFreeAgain)),
    'incomplete metadata must produce deterministic normalized output');

  const equivalentBase = {
    snapshotId: 'equivalent-snapshot',
    chatId: 'equivalent-chat',
    meta: { title: 'Equivalent', projectId: 'project-a', turnCreateTimes: { 1: 101, 2: 202 } },
    messages: [
      {
        role: 'user', text: 'question', messageId: 'message-1', turnId: 'turn-1',
        attachments: [{ kind: 'image', thumbnailSrc: 'https://example.com/a.png', alt: 'A', naturalWidth: 20 }],
      },
      { role: 'assistant', text: 'answer', messageId: 'message-2', turnId: 'turn-2' },
    ],
    richTurns: [
      { turnIdx: 1, role: 'user', messageId: 'message-1', turnId: 'turn-1', outerHTML: '<article>User</article>' },
      { turnIdx: 2, role: 'assistant', messageId: 'message-2', turnId: 'turn-2', outerHTML: '<article>Assistant</article>' },
    ],
  };
  const equivalentBefore = JSON.stringify(equivalentBase);
  const sameWithIrrelevantMetadata = structuredClone(equivalentBase);
  sameWithIrrelevantMetadata.meta.folderId = 'folder-does-not-render';
  assert.equal(sandbox.isRenderEquivalent(equivalentBase, sameWithIrrelevantMetadata), true,
    'non-Renderer folder metadata must not force base transcript replacement');

  const changedText = structuredClone(equivalentBase);
  changedText.messages[1].text = 'changed answer';
  assert.equal(sandbox.isRenderEquivalent(equivalentBase, changedText), false,
    'same-ID changed canonical text must require a full render');

  const changedRole = structuredClone(equivalentBase);
  changedRole.messages[1].role = 'tool';
  assert.equal(sandbox.isRenderEquivalent(equivalentBase, changedRole), false,
    'same-ID changed canonical role must require a full render');

  const changedAttachment = structuredClone(equivalentBase);
  changedAttachment.messages[0].attachments[0].alt = 'Changed alternative';
  assert.equal(sandbox.isRenderEquivalent(equivalentBase, changedAttachment), false,
    'same-ID changed visible attachment data must require a full render');

  const changedRichHtml = structuredClone(equivalentBase);
  changedRichHtml.richTurns[1].outerHTML = '<article>Changed assistant</article>';
  assert.equal(sandbox.isRenderEquivalent(equivalentBase, changedRichHtml), false,
    'same-ID changed rich HTML must require a full render');

  const changedIdentity = structuredClone(equivalentBase);
  changedIdentity.snapshotId = 'different-snapshot';
  assert.equal(sandbox.isRenderEquivalent(equivalentBase, changedIdentity), false,
    'different snapshot identity must not reuse the mounted Reader');
  assert.equal(JSON.stringify(equivalentBase), equivalentBefore,
    'render-equivalence checks must not mutate source snapshots');
}

class FakeElement {
  constructor(role = '') {
    this.role = role;
    this.message = null;
    this.removed = false;
    this.appended = [];
    this.classList = { add() {} };
  }
  appendChild(node) { this.appended.push(node); return node; }
  remove() { this.removed = true; }
}

/*
 * M03 P1 S1A T1: the rich path now runs
 *   owner record -> Stage 0 inert compat -> sanitizer v2 fragment -> H2O shells.
 * The harness stubs that seam, so role and identity reaching the shell can only
 * have come from the owner record, never from provider markup.
 */
function createRichMountHarness() {
  const shells = [];
  const attachedUsers = [];
  const sanitizedContent = [];
  const globals = {
    Element: FakeElement,
    normalizeRichTurns: (rows) => Array.isArray(rows) ? rows : [],
    resolveSnapshotTurnCreateTime: () => 0,
    normalizeAttachments: () => [],
    normalizeRole: (raw) => ['user', 'assistant', 'system', 'tool'].includes(String(raw).toLowerCase())
      ? String(raw).toLowerCase() : '',
    extractRichTurnContentHtml: (html) => String(html || ''),
    sanitizeRichContentFragment: (html) => {
      if (html === 'INVALID') return null;
      sanitizedContent.push(html);
      return { nodeType: 11, html };
    },
    buildRichTurnShell: (role, meta) => {
      shells.push({ role, answerIdx: meta.answerIdx, messageId: meta.messageId, turnId: meta.turnId, turnNo: meta.turnNo });
      const turn = new FakeElement(role);
      turn.message = new FakeElement(role);
      return { turn, messageEl: turn.message };
    },
    projectRichContent() {},
    cleanReaderUserTextNodeLeaks() {},
    getEditOverride: () => null,
    applyEditedMessageBody() {},
    attachUserAttachmentsToTurn: (host) => attachedUsers.push(host),
  };
  const { fn } = loadFunction(rendererSource, 'mountRichTurns', globals);
  return { fn, decorated: shells, shells, attachedUsers, sanitizedContent };
}

function runRichMount(fn, rows) {
  const appended = [];
  const container = { appendChild: (host) => appended.push(host) };
  const result = fn(container, rows, '', { messages: [] }, { getEditOverride: () => null });
  return { result, appended };
}

function validateRichMountContract() {
  {
    const h = createRichMountHarness();
    const { result, appended } = runRichMount(h.fn, [
      { turnIdx: 1, role: 'user', outerHTML: 'user' },
    ]);
    assert.equal(result.mountedTurnCount, 1);
    assert.equal(result.assistantTurnEls.length, 0);
    assert.equal(result.fallbackRequired, false);
    assert.equal(appended.length, 1, 'valid rich user-only turn must mount exactly once');
  }

  {
    const h = createRichMountHarness();
    const { result, appended } = runRichMount(h.fn, [
      { turnIdx: 1, role: 'system', outerHTML: 'system' },
      { turnIdx: 2, role: 'tool', outerHTML: 'tool' },
    ]);
    assert.equal(result.mountedTurnCount, 2);
    assert.equal(result.assistantTurnEls.length, 0);
    assert.equal(result.fallbackRequired, false);
    assert.equal(appended.length, 2, 'valid zero-assistant rich turns must each mount once');
  }

  {
    const h = createRichMountHarness();
    const { result, appended } = runRichMount(h.fn, [
      { turnIdx: 1, role: 'user', outerHTML: 'user' },
      { turnIdx: 2, role: 'assistant', outerHTML: 'assistant' },
      { turnIdx: 3, role: 'system', outerHTML: 'system' },
      { turnIdx: 4, role: 'tool', outerHTML: 'tool' },
    ]);
    assert.equal(result.mountedTurnCount, 4);
    assert.equal(appended.length, 4);
    assert.equal(result.assistantTurnEls.length, 1, 'assistant collection must exclude user/system/tool turns');
    assert.equal(result.assistantTurnEls[0].role, 'assistant');
    assert.deepEqual(h.decorated.map((row) => row.answerIdx), [0, 1, 0, 0], 'answer numbering must be assistant-only');
    assert.equal(h.attachedUsers.length, 1, 'user attachment decoration must remain user-only');
  }

  {
    const h = createRichMountHarness();
    const { result, appended } = runRichMount(h.fn, [
      { turnIdx: 1, role: 'user', outerHTML: 'user' },
      { turnIdx: 2, role: 'assistant', outerHTML: 'INVALID' },
    ]);
    assert.equal(result.fallbackRequired, true, 'invalid rich replay must request canonical fallback');
    assert.equal(result.mountedTurnCount, 0);
    assert.equal(result.assistantTurnEls.length, 0);
    assert.equal(appended.length, 0, 'failed rich replay must not leave a partial mount');
  }

  {
    const h = createRichMountHarness();
    const { result, appended } = runRichMount(h.fn, [
      { turnIdx: 1, role: 'mystery', outerHTML: 'mystery' },
    ]);
    assert.equal(result.fallbackRequired, true, 'a rich turn with no canonical role must fail locally');
    assert.equal(appended.length, 0, 'invalid-role rich replay must not leave a partial mount');
  }
}

class FakeIdentityElement {
  constructor(attrs = {}, tagName = 'DIV') {
    this.attrs = new Map(Object.entries(attrs));
    this.tagName = String(tagName).toUpperCase();
    this.removed = false;
  }
  getAttribute(name) { return this.attrs.has(name) ? this.attrs.get(name) : null; }
  setAttribute(name, value) { this.attrs.set(name, String(value)); }
  removeAttribute(name) { this.attrs.delete(name); }
  hasAttribute(name) { return this.attrs.has(name); }
  remove() { this.removed = true; }
}

function validateRichIdentityResilience() {
  const claim = loadFunction(rendererSource, 'claimReplayIdentity', {
    Element: FakeIdentityElement,
    Set,
    String,
  }).fn;
  const seen = new Set();
  const first = new FakeIdentityElement({ 'data-message-id': 'message-1' });
  const duplicate = new FakeIdentityElement({ 'data-message-id': 'message-1' });
  const missing = new FakeIdentityElement();

  assert.equal(claim(first, 'data-message-id', '', seen), 'message-1');
  assert.equal(claim(duplicate, 'data-message-id', '', seen), '');
  assert.equal(duplicate.getAttribute('data-message-id'), null,
    'later duplicate rich identity must be removed from the replay DOM');
  assert.equal(claim(missing, 'data-message-id', '', seen), '',
    'missing rich identity must remain optional and must not throw');
  assert.equal(claim(missing, 'data-message-id', 'message-2', seen), 'message-2');
  assert.equal(missing.getAttribute('data-message-id'), 'message-2');
}

function validateRendererAccessibilityContract() {
  assert.match(rendererSource,
    /grid\.setAttribute\("role", "group"\);\s*grid\.setAttribute\("aria-label", "Attached images"\);/,
    'attachment collection label must be exposed through a nameable group semantic');
  const normalizeRole = (raw) => {
    const role = String(raw || '').trim().toLowerCase();
    return ['user', 'assistant', 'system', 'tool'].includes(role) ? role : '';
  };
  const context = vm.createContext({
    Element: FakeIdentityElement,
    ROLES: roleContract,
    normalizeRole,
    String,
  });
  vm.runInContext([
    extractFunction(rendererSource, 'getAccessibleRoleLabel'),
    extractFunction(rendererSource, 'applyTurnAccessibility'),
    extractFunction(rendererSource, 'normalizeImageAlt'),
    extractFunction(rendererSource, 'normalizeReplayImageAccessibility'),
    extractFunction(rendererSource, 'normalizeReplayLinkAccessibility'),
    'this.a11y = { getAccessibleRoleLabel, applyTurnAccessibility, normalizeImageAlt, normalizeReplayImageAccessibility, normalizeReplayLinkAccessibility };',
  ].join('\n'), context);

  const canonicalTurn = new FakeIdentityElement({ role: 'button', 'aria-labelledby': 'stale-host-label' }, 'article');
  context.a11y.applyTurnAccessibility(canonicalTurn, 'assistant');
  assert.equal(canonicalTurn.getAttribute('role'), null, 'native article must not retain redundant/stale ARIA role');
  assert.equal(canonicalTurn.getAttribute('aria-labelledby'), null, 'stale host-page label reference must be removed');
  assert.equal(canonicalTurn.getAttribute('aria-label'), 'Assistant message');

  const richTurn = new FakeIdentityElement({}, 'section');
  context.a11y.applyTurnAccessibility(richTurn, 'system');
  assert.equal(richTurn.getAttribute('role'), 'article', 'rich replay turn hosts must expose equivalent article semantics');
  assert.equal(richTurn.getAttribute('aria-label'), 'System message');
  assert.equal(context.a11y.getAccessibleRoleLabel('user'), 'User message');
  assert.equal(context.a11y.getAccessibleRoleLabel('tool'), 'Tool message');
  assert.equal(context.a11y.getAccessibleRoleLabel('unknown'), '', 'unknown roles must not acquire fabricated labels');

  assert.equal(context.a11y.normalizeImageAlt(null), '', 'missing image alt must remain empty');
  assert.equal(context.a11y.normalizeImageAlt('diagram'), 'diagram', 'supplied image alt must remain intact');
  const unlabeledImage = new FakeIdentityElement({ src: 'https://example.com/image.png' }, 'img');
  assert.equal(context.a11y.normalizeReplayImageAccessibility(unlabeledImage), true);
  assert.equal(unlabeledImage.getAttribute('alt'), '', 'rich images without source alt must become explicitly decorative');
  const brokenImage = new FakeIdentityElement({ src: '#' }, 'img');
  assert.equal(context.a11y.normalizeReplayImageAccessibility(brokenImage), false);
  assert.equal(brokenImage.removed, true, 'sanitizer-neutralized broken images must not remain misleading content');

  const inertLink = new FakeIdentityElement({ href: '#', target: '_blank', rel: 'noopener' }, 'a');
  context.a11y.normalizeReplayLinkAccessibility(inertLink);
  assert.equal(inertLink.getAttribute('href'), null, 'sanitizer-neutralized links must not remain keyboard focus targets');
  assert.equal(inertLink.getAttribute('target'), null);
  assert.equal(inertLink.getAttribute('rel'), null);
  const externalLink = new FakeIdentityElement({ href: 'https://example.com' }, 'a');
  context.a11y.normalizeReplayLinkAccessibility(externalLink);
  assert.equal(externalLink.getAttribute('target'), '_blank');
  assert.equal(externalLink.getAttribute('rel'), 'noreferrer noopener');
}

/*
 * M03 P1 S1A T1 — rich replay consumes Renderer sanitizer v2, never v1.
 */
function validateRendererSanitizerV2Migration() {
  /* 1. chat-renderer no longer resolves the shared v1 surface at all. */
  const code = stripJsComments(rendererSource);
  assert.doesNotMatch(code, /html\s*[?.]*\.\s*sanitize\b/,
    'chat-renderer must not resolve H2O.Studio.html.sanitize for rich replay');
  assert.match(code, /Renderer\s*[?.]*\.\s*htmlSanitizer/,
    'chat-renderer must resolve the Renderer sanitizer v2');
  assert.match(code, /sanitizeToFragment\s*\(/,
    'rich replay must use the v2 fragment path');
  assert.doesNotMatch(code, /tpl\.innerHTML\s*=\s*sanitized/,
    'no sanitized-string to template reparse may remain after v2');

  /* 2. Stage 0 is an inert compatibility stage with no security authority.
   *    Its real-DOM parsing behaviour is proven by the browser harness; here we
   *    assert it stays inert and never duplicates sanitizer policy. */
  assert.match(code, /createElement\("template"\)/,
    'Stage 0 must parse through an inert template');
  const stage0 = code.slice(code.indexOf('function stage0CompatCleanup'), code.indexOf('function extractRichTurnContentHtml'));
  assert.doesNotMatch(stage0, /removeAttribute|javascript:|\bon\[a-z\]/i,
    'Stage 0 must not duplicate sanitizer security policy');

  /* 3. v2 failure modes all fail closed to null — never to v1. */
  const makeFragmentFn = (engine) => loadFunction(rendererSource, 'sanitizeRichContentFragment', {
    String, W: { H2O: { Studio: { Renderer: { htmlSanitizer: engine } } } },
  }).fn;
  const good = { nodeType: 11 };
  assert.equal(makeFragmentFn({ isSupported: () => true, sanitizeToFragment: () => good })('<p>x</p>'), good);
  assert.equal(makeFragmentFn(undefined)('<p>x</p>'), null, 'absent v2 must fail closed');
  assert.equal(makeFragmentFn({ isSupported: () => false, sanitizeToFragment: () => good })('<p>x</p>'), null,
    'unsupported v2 must fail closed');
  assert.equal(makeFragmentFn({ isSupported: () => true, sanitizeToFragment: () => { throw new Error('boom'); } })('<p>x</p>'), null,
    'throwing v2 must fail closed');
  assert.equal(makeFragmentFn({ isSupported: () => true, sanitizeToFragment: () => 'a string' })('<p>x</p>'), null,
    'non-fragment v2 result must fail closed');

  /* 4. v2 failure yields a whole-transcript canonical fallback, no partial mount. */
  const h = createRichMountHarness();
  const appended = [];
  const result = h.fn({ appendChild: (n) => appended.push(n) },
    [{ turnIdx: 1, role: 'user', outerHTML: 'user' }, { turnIdx: 2, role: 'assistant', outerHTML: 'INVALID' }],
    '', { messages: [] }, { getEditOverride: () => null });
  assert.equal(result.fallbackRequired, true, 'v2 failure must request canonical fallback');
  assert.equal(result.mountedTurnCount, 0);
  assert.equal(appended.length, 0, 'no hybrid partial rich transcript may remain');
}

/*
 * Provider markup must never win structure, role or identity.
 */
function validateProviderSpoofRejected() {
  const h = createRichMountHarness();
  const appended = [];
  const spoof = '<section data-testid="conversation-turn-99" data-turn="assistant">'
    + '<div data-message-author-role="assistant" data-message-id="SPOOFED-MSG" data-turn-id="SPOOFED-TURN">x</div></section>';
  const result = h.fn({ appendChild: (n) => appended.push(n) }, [{
    turnIdx: 1, role: 'user', outerHTML: spoof, messageId: 'owner-msg-1', turnId: 'owner-turn-1',
  }], '', { messages: [] }, { getEditOverride: () => null });

  assert.equal(result.fallbackRequired, false);
  assert.equal(h.shells.length, 1);
  const shell = h.shells[0];
  assert.equal(shell.role, 'user', 'shell role must come from the owner record, not provider markup');
  assert.equal(shell.messageId, 'owner-msg-1', 'shell message identity must come from the owner record');
  assert.equal(shell.turnId, 'owner-turn-1', 'shell turn identity must come from the owner record');
  assert.equal(shell.turnNo, 1, 'turn ordering must come from the owner record');
  assert.equal(appended[0].role, 'user');
}

class FakeClassList {
  constructor() { this.values = new Set(); }
  add(...values) { values.forEach((value) => this.values.add(value)); }
  remove(...values) { values.forEach((value) => this.values.delete(value)); }
  contains(value) { return this.values.has(value); }
}

class FakeScroll {
  constructor(tagName = 'SECTION') {
    this.tagName = tagName;
    this.attrs = new Map();
    this.classList = new FakeClassList();
    this.children = [];
  }
  appendChild(value) { this.children.push(value); return value; }
  addEventListener() {}
  contains(value) { return this.children.includes(value); }
  querySelectorAll() { return []; }
  setAttribute(name, value) { this.attrs.set(name, String(value)); }
  getAttribute(name) { return this.attrs.get(name) || null; }
}

class FakeRoot {
  constructor() {
    this.dataset = {};
    this.className = '';
    this.scroll = null;
  }
  set innerHTML(value) {
    const html = String(value || '');
    const tagName = String(html.match(/<([a-z]+)\s+class="cgScroll"/i)?.[1] || 'div').toUpperCase();
    this.scroll = new FakeScroll(tagName);
    const label = html.match(/class="cgScroll"[^>]*aria-label="([^"]+)"/i)?.[1] || '';
    if (label) this.scroll.setAttribute('aria-label', label);
  }
  querySelector(selector) { return selector === '.cgScroll' ? this.scroll : null; }
}

function createRendererBuildHarness(richResult) {
  let canonicalCalls = 0;
  let richMountCalls = 0;
  const sandbox = {
    document: {
      createElement: () => new FakeRoot(),
    },
    Element: FakeScroll,
    TURNS_TESTID: 'conversation-turns',
    normalizeInput: (input) => input,
    mountRichTurns: (container) => {
      richMountCalls += 1;
      for (let i = 0; i < richResult.mountedTurnCount; i += 1) container.appendChild({ kind: 'rich' });
      return richResult;
    },
    buildCanonicalConversation: (container, snap) => {
      canonicalCalls += 1;
      for (const row of snap.messages || []) container.appendChild({ kind: 'canonical', role: row.role });
      return (snap.messages || []).filter((row) => row.role === 'assistant').map(() => ({ role: 'assistant' }));
    },
    Promise,
    String,
    Array,
    Object,
  };
  const context = vm.createContext(sandbox);
  vm.runInContext(`${extractFunction(rendererSource, 'hasCompleteRichCoverage')}\n${extractFunction(rendererSource, 'render')}\nthis.result = render;`, context);
  return {
    fn: context.result,
    getCanonicalCalls: () => canonicalCalls,
    getRichMountCalls: () => richMountCalls,
  };
}

function validateBuildFallbackDecision() {
  {
    const h = createRendererBuildHarness({ mountedTurnCount: 1, assistantTurnEls: [], fallbackRequired: false });
    const result = h.fn({ chatId: 'user-only', title: 'User only', projectId: '', snapshotId: '', richTurns: [{ role: 'user' }], messages: [{ role: 'user' }] });
    assert.equal(result.turnsEl.children.length, 1, 'rich user-only build must render exactly one turn');
    assert.equal(h.getCanonicalCalls(), 0, 'rich user-only build must not enter canonical fallback');
    assert.equal(result.turnsEl.classList.contains('is-rich'), true);
    assert.equal(result.renderMode, 'rich');
    assert.equal(result.turnsEl.tagName, 'SECTION', 'transcript root must use native section semantics');
    assert.equal(result.turnsEl.getAttribute('aria-label'), 'Conversation transcript');
  }

  {
    const h = createRendererBuildHarness({ mountedTurnCount: 2, assistantTurnEls: [], fallbackRequired: false });
    const result = h.fn({ chatId: 'zero-assistant', title: '', projectId: '', snapshotId: '', richTurns: [{ role: 'system' }, { role: 'tool' }], messages: [{ role: 'system' }, { role: 'tool' }] });
    assert.equal(result.turnsEl.children.length, 2);
    assert.equal(h.getCanonicalCalls(), 0, 'valid zero-assistant rich build must not enter canonical fallback');
  }

  {
    const h = createRendererBuildHarness({ mountedTurnCount: 0, assistantTurnEls: [], fallbackRequired: true });
    const result = h.fn({ chatId: 'fallback', title: '', projectId: '', snapshotId: '', richTurns: [{ role: 'user' }, { role: 'assistant' }], messages: [{ role: 'user' }, { role: 'assistant' }] });
    assert.equal(h.getCanonicalCalls(), 1, 'genuine rich failure must activate canonical fallback');
    assert.equal(h.getRichMountCalls(), 1, 'complete rich replay must be attempted before genuine fallback');
    assert.equal(result.turnsEl.children.length, 2);
    assert.equal(result.turnsEl.classList.contains('is-rich'), false);
    assert.equal(result.renderMode, 'canonical');
  }

  {
    const h = createRendererBuildHarness({ mountedTurnCount: 1, assistantTurnEls: [], fallbackRequired: false });
    const result = h.fn({ chatId: 'partial-rich', title: '', projectId: '', snapshotId: '', richTurns: [{ role: 'user' }], messages: [{ role: 'user' }, { role: 'assistant' }] });
    assert.equal(h.getRichMountCalls(), 0, 'incomplete whole-transcript rich coverage must not suppress canonical turns');
    assert.equal(h.getCanonicalCalls(), 1);
    assert.equal(result.turnsEl.children.length, 2, 'mixed rich/text input must emit one complete canonical transcript');
    assert.equal(result.renderMode, 'canonical');
  }

  {
    const assistant = { role: 'assistant' };
    const h = createRendererBuildHarness({ mountedTurnCount: 4, assistantTurnEls: [assistant], fallbackRequired: false });
    const result = h.fn({ chatId: 'roles', title: '', projectId: '', snapshotId: '', richTurns: [{}, {}, {}, {}], messages: [] });
    assert.equal(result.assistantTurnEls.length, 1);
    assert.equal(result.assistantTurnEls[0], assistant, 'Renderer result must expose the assistant-only collection');
  }
}

function validateExtractedRendererBoundary() {
  const sanitizerTag = '<script src="./platform/html-sanitizer.js"></script>';
  const rendererTag = '<script src="./renderer/chat-renderer.studio.js"></script>';
  const studioTag = '<script src="./studio.js?v=2.5.80"></script>';
  assert.ok(studioHtmlSource.indexOf(sanitizerTag) < studioHtmlSource.indexOf(rendererTag),
    'Renderer module must load after the shared sanitizer');
  assert.ok(studioHtmlSource.indexOf(rendererTag) < studioHtmlSource.indexOf(studioTag),
    'Renderer module must load before studio.js orchestration');
  assert.match(rendererSource, /Studio\.chatRenderer\s*=\s*Object\.freeze/,
    'Renderer module must install the canonical Studio API');
  assert.match(studioSource, /renderer\.normalizeInput\(snap\)/,
    'studio.js must normalize snapshots through the Renderer boundary');
  assert.match(studioSource, /renderer\.render\(rendererInput,\s*\{\s*getEditOverride\s*\}\)/,
    'studio.js must construct transcripts through the Renderer boundary');
  assert.doesNotMatch(studioSource, /function\s+(mountRichTurns|buildCanonicalConversation|renderTextAsChatGPTBlocks)\s*\(/,
    'studio.js must not retain extracted Renderer implementations');
}

validateRoleFidelity();
validateRendererInputContract();
validateRichMountContract();
validateRichIdentityResilience();
validateRendererAccessibilityContract();
validateRendererSanitizerV2Migration();
validateProviderSpoofRejected();
validateBuildFallbackDecision();
validateExtractedRendererBoundary();

console.log('Studio renderer contract repair validation passed');
