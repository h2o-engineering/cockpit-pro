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
const PRESENTATION_PROFILE_REL = 'src-surfaces-base/studio/renderer/presentation/presentation-profile.v1.js';
const PRESENTATION_CSS_REL = 'src-surfaces-base/studio/renderer/presentation/chatgpt-reference.v1.css';
const STUDIO_CSS_REL = 'src-surfaces-base/studio/studio.css';
/* Semantic sources: parse/ingress/IR. The content renderer is the DOM
 * presentation sink downstream of accepted IR and may consult the profile. */
const SEMANTIC_SOURCE_RELS = Object.freeze([
  'src-surfaces-base/studio/renderer/semantic/render-ir.v1.js',
  'src-surfaces-base/studio/renderer/semantic/semantic-ingress.v1.js',
  'src-surfaces-base/studio/renderer/markdown/h2o-gfm.v1.js',
  'src-surfaces-base/studio/renderer/markdown/markdown-engine.v1.js',
  'src-surfaces-base/studio/renderer/markdown/markdown-ir-adapter.v1.js',
]);
const CONTENT_RENDERER_REL = 'src-surfaces-base/studio/renderer/content/content-renderer.v1.js';
const SEMANTIC_INDEX_REL = 'src-surfaces-base/studio/renderer/semantic/semantic-index.v1.js';
const RENDER_IR_REL = 'src-surfaces-base/studio/renderer/semantic/render-ir.v1.js';
const PACK_STUDIO_REL = 'tools/product/studio/pack-studio.mjs';

function readRepo(rel) {
  return fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
}

function extractFunction(source, name) {
  const match = new RegExp(`\\bfunction\\s+${name}\\s*\\(`).exec(source);
  if (!match) throw new Error(`extractFunction: '${name}' not found`);
  const start = match.index;
  /* Skip the parameter list first: a default such as `meta = {}` carries
   * braces of its own, and the body brace is the first one after the
   * matching `)`. */
  let parenDepth = 0;
  let paramsEnd = -1;
  for (let i = match.index + match[0].length - 1; i < source.length; i += 1) {
    if (source[i] === '(') parenDepth += 1;
    else if (source[i] === ')') {
      parenDepth -= 1;
      if (parenDepth === 0) { paramsEnd = i; break; }
    }
  }
  if (paramsEnd === -1) throw new Error(`extractFunction: unterminated parameter list for '${name}'`);
  const braceOpen = source.indexOf('{', paramsEnd);
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

function extractConst(source, name) {
  const match = new RegExp(`^const\\s+${name}\\s*=\\s*[^;]+;`, 'm').exec(source);
  if (!match) throw new Error(`extractConst: '${name}' not found`);
  return match[0];
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
const presentationProfileSource = readRepo(PRESENTATION_PROFILE_REL);

/* The REAL PresentationProfile module, installed into an isolated fake window
 * so executed shell seams consume the real reference profile. */
function installPresentationProfile(context) {
  vm.runInContext(`${presentationProfileSource}\nthis.__presentationProfileApi = this.H2O.Studio.Renderer.presentationProfile;`, context);
  return context.__presentationProfileApi;
}

/* The Renderer's own resolver, extracted verbatim, bound to a sandbox whose
 * Studio namespace carries (or deliberately lacks) the real profile API. */
function presentationProfileGlobals(context, { withProfile = true } = {}) {
  const Studio = { Renderer: {} };
  if (withProfile) Studio.Renderer.presentationProfile = installPresentationProfile(context);
  return { Studio, PRESENTATION_PROFILE_ATTR: 'data-h2o-presentation-profile' };
}
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
    'typedContentKey',
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
    this.addedClasses = [];
    this.classList = { add: (...values) => { this.addedClasses.push(...values); } };
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
  const adoptions = [];
  const order = [];
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
    projectRichContent: (host) => { order.push(['project', host.role]); },
    cleanReaderUserTextNodeLeaks() {},
    getEditOverride: () => null,
    applyEditedMessageBody() {},
    attachUserAttachmentsToTurn: (host) => attachedUsers.push(host),
    /* S3A slice B: the user-bubble adoption seam runs on the H2O message host
     * after the sanitized fragment is appended; an unadoptable fragment must
     * fail the whole transcript closed. */
    adoptRichUserBubble: (host) => {
      adoptions.push(host.role);
      order.push(['adopt', host.role]);
      return !(host.appended[0] && host.appended[0].html === 'UNADOPTABLE');
    },
  };
  /* S3B: the edited-turn presentation hook is read from the real profile. */
  const profileContext = vm.createContext({});
  Object.assign(globals, presentationProfileGlobals(profileContext));
  const { fn, context } = loadFunction(rendererSource, 'mountRichTurns', globals);
  vm.runInContext(extractFunction(rendererSource, 'activePresentationProfile'), context);
  return { fn, decorated: shells, shells, attachedUsers, sanitizedContent, adoptions, order };
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
    assert.deepEqual(h.adoptions, ['user'], 'rich user-bubble adoption must run for user turns only - assistant/system/tool get no invented bubble');
    assert.deepEqual(h.order, [['adopt', 'user'], ['project', 'user'], ['project', 'assistant'], ['project', 'system'], ['project', 'tool']],
      'user-bubble adoption must run on the sanitized host before post-sanitizer content projection');
  }

  {
    const h = createRichMountHarness();
    const appended = [];
    const result = h.fn({ appendChild: (host) => appended.push(host) }, [
      { turnIdx: 1, role: 'user', outerHTML: 'user' },
      { turnIdx: 2, role: 'assistant', outerHTML: 'assistant' },
      { turnIdx: 3, role: 'assistant', outerHTML: 'assistant-2' },
    ], 'snap', { messages: [] }, { getEditOverride: (sid, turnIdx) => (sid === 'snap' && turnIdx === 2 ? 'edited text' : null) });
    assert.equal(result.fallbackRequired, false);
    assert.deepEqual(appended.map((host) => host.addedClasses), [[], ['wbTurn--edited'], []],
      'exactly the overridden assistant turn carries the profile edited-turn hook');
  }

  {
    const h = createRichMountHarness();
    const { result, appended } = runRichMount(h.fn, [
      { turnIdx: 1, role: 'assistant', outerHTML: 'assistant' },
      { turnIdx: 2, role: 'user', outerHTML: 'UNADOPTABLE' },
    ]);
    assert.equal(result.fallbackRequired, true, 'a rich user fragment that cannot be adopted must request canonical fallback');
    assert.equal(result.mountedTurnCount, 0);
    assert.equal(appended.length, 0, 'adoption failure must not leave a partial mount - whole-transcript fallback stays atomic');
    assert.deepEqual(h.adoptions, ['user']);
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
  get length() { return this.values.size; }
  [Symbol.iterator]() { return this.values.values(); }
}

class FakeTextNode {
  constructor(text) { this.nodeType = 3; this.nodeValue = String(text); this.parentNode = null; }
  get textContent() { return this.nodeValue; }
}

/* Tag-aware DOM fake for the structural seams: the Renderer builds every shell
 * with createElement/setAttribute/appendChild and now re-parents sanitized
 * content (rich user-bubble adoption), so the fake models a small live tree:
 * a node has one parent, moving it detaches it first, class state has a single
 * source of truth, and querySelectorAll answers class selectors in document
 * order. Only what the seams use is modelled. */
class FakeDomElement {
  constructor(tagName = 'DIV') {
    this.nodeType = 1;
    this.tagName = String(tagName).toUpperCase();
    this.attrs = new Map();
    this.classList = new FakeClassList();
    this.dataset = {};
    this.children = [];
    this.parentNode = null;
  }
  get className() { return [...this.classList].join(' '); }
  set className(value) {
    this.classList.values = new Set(String(value).split(/\s+/).filter(Boolean));
  }
  get firstChild() { return this.children[0] || null; }
  get childNodes() { return this.children.slice(); }
  get childElementCount() { return this.children.filter((child) => child && child.nodeType === 1).length; }
  get textContent() { return this.children.map((child) => child.textContent ?? '').join(''); }
  appendChild(node) { return this.insertBefore(node, null); }
  insertBefore(node, ref) {
    if (!node || typeof node !== 'object') throw new TypeError('insertBefore: not a node');
    if (node.parentNode) node.parentNode.removeChild(node);
    const idx = ref ? this.children.indexOf(ref) : -1;
    if (ref && idx === -1) throw new Error('insertBefore: reference node is not a child');
    if (idx === -1) this.children.push(node); else this.children.splice(idx, 0, node);
    node.parentNode = this;
    return node;
  }
  removeChild(node) {
    const idx = this.children.indexOf(node);
    if (idx === -1) throw new Error('removeChild: not a child');
    this.children.splice(idx, 1);
    node.parentNode = null;
    return node;
  }
  replaceWith(node) {
    const parent = this.parentNode;
    if (!parent) throw new Error('replaceWith: detached node');
    parent.insertBefore(node, this);
    parent.removeChild(this);
  }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  insertAdjacentElement(position, node) {
    const parent = this.parentNode;
    if (!parent) throw new Error('insertAdjacentElement: detached node');
    if (position === 'beforebegin') return parent.insertBefore(node, this);
    if (position === 'afterend') return parent.insertBefore(node, parent.children[parent.children.indexOf(this) + 1] || null);
    throw new Error(`insertAdjacentElement: unsupported position ${position}`);
  }
  addEventListener() {}
  contains(node) {
    return this.children.some((child) => child === node
      || (child && typeof child.contains === 'function' && child.contains(node)));
  }
  find(predicate) {
    for (const child of this.children) {
      if (child && child.nodeType === 1 && predicate(child)) return child;
      const nested = child && typeof child.find === 'function' ? child.find(predicate) : null;
      if (nested) return nested;
    }
    return null;
  }
  /* Class selectors only ('.a' or '.a, .b'), matched over descendants in
   * document order - the shape every structural seam under test uses. */
  querySelectorAll(selector) {
    const classes = String(selector).split(',').map((part) => part.trim());
    if (!classes.length || classes.some((part) => !/^\.[A-Za-z0-9_-]+$/.test(part))) {
      throw new Error(`FakeDomElement.querySelectorAll: unsupported selector ${selector}`);
    }
    const names = classes.map((part) => part.slice(1));
    const out = [];
    const walk = (node) => {
      for (const child of node.children) {
        if (child && child.nodeType === 1) {
          if (names.some((name) => child.classList.contains(name))) out.push(child);
          walk(child);
        }
      }
    };
    walk(this);
    return out;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  setAttribute(name, value) {
    if (name === 'class') { this.className = value; return; }
    this.attrs.set(name, String(value));
  }
  getAttribute(name) {
    if (name === 'class') return this.classList.length ? this.className : null;
    return this.attrs.has(name) ? this.attrs.get(name) : null;
  }
  removeAttribute(name) { if (name === 'class') this.className = ''; else this.attrs.delete(name); }
  hasAttribute(name) { return name === 'class' ? this.classList.length > 0 : this.attrs.has(name); }
}

function createRendererBuildHarness(richResult) {
  let canonicalCalls = 0;
  let richMountCalls = 0;
  const sandbox = {
    document: {
      createElement: (tagName) => new FakeDomElement(tagName),
    },
    Element: FakeDomElement,
    TURNS_TESTID: 'conversation-turns',
    normalizeInput: (input) => input,
    /* S2C/T11: render() first asks whether the input is a conforming Saved-Chat
     * v3 snapshot. These decision scenarios are not v3, so the semantic branch
     * must stay dormant and the rich/canonical decision must be unchanged. */
    semanticV3Conversation: () => null,
    buildSemanticConversation: () => { throw new Error('semantic branch must not run for non-v3 input'); },
    /* S4A: render() builds one Semantic Index per result through the installed
     * module; the decision harness records the call and returns a marker. */
    TURN_PROJECTION_META: new WeakMap(),
    activeSemanticIndexModule: () => ({ createShellIndex: (input) => ({ __stubIndex: true, renderMode: input.renderMode, semanticConversation: input.semanticConversation }) }),
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
  Object.assign(sandbox, presentationProfileGlobals(context));
  vm.runInContext([
    /* S4A slice B: render() opens the private per-render content collector and
     * delegates to renderWithCollector; the seam pair is extracted verbatim. */
    'let ACTIVE_CONTENT_COLLECTOR = null;',
    extractFunction(rendererSource, 'openContentCollector'),
    extractFunction(rendererSource, 'activePresentationProfile'),
    extractFunction(rendererSource, 'hasCompleteRichCoverage'),
    extractFunction(rendererSource, 'buildConversationShell'),
    extractFunction(rendererSource, 'renderWithCollector'),
    extractFunction(rendererSource, 'render'),
    'this.result = render;',
  ].join('\n'), context);
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

/*
 * M03 P3 S3A T6 slice A - shared H2O structural shell authority.
 *
 * Executes the REAL extracted seams (buildConversationShell, buildTurnShell,
 * buildMessageHost and the canonical / rich builders that must reach them)
 * against the tag-aware fake, and proves the effective DOM contract of every
 * mode is unchanged while structure now has exactly one construction seam.
 */
function validateStructuralShellAuthority() {
  /* S4A slice B: render() opens the per-render content collector and delegates the build to renderWithCollector(); both halves are the render body. */
  const renderFn = extractFunction(rendererSource, 'render') + '\n' + extractFunction(rendererSource, 'renderWithCollector');
  const canonicalTurnFn = extractFunction(rendererSource, 'buildCanonicalTurn');
  const canonicalMessageFn = extractFunction(rendererSource, 'buildCanonicalMessage');
  const richShellFn = extractFunction(rendererSource, 'buildRichTurnShell');
  const semanticConversationFn = extractFunction(rendererSource, 'buildSemanticConversation');

  /* A. The conversation shell is built by DOM APIs, never an innerHTML scaffold. */
  assert.doesNotMatch(renderFn, /innerHTML/, 'render() must not build the conversation shell from an HTML string');
  assert.match(renderFn, /buildConversationShell\(input\)/, 'render() must obtain the conversation shell from the shared seam');
  const shellFn = extractFunction(rendererSource, 'buildConversationShell');
  assert.doesNotMatch(shellFn, /innerHTML|insertAdjacentHTML/, 'the conversation shell seam must not use an HTML sink');
  assert.match(shellFn, /createElement\("section"\)/, 'the transcript root must be a native section');

  /* B. Every turn/message construction path reaches the shared seams. */
  assert.match(canonicalTurnFn, /buildTurnShell\(role, "canonical", meta\)/, 'canonical turns must use the shared turn seam');
  assert.match(richShellFn, /buildTurnShell\(role, "rich", meta\)/, 'rich turns must use the shared turn seam');
  assert.match(canonicalMessageFn, /buildMessageHost\(role, "canonical", meta\)/, 'canonical hosts must use the shared message seam');
  assert.match(richShellFn, /buildMessageHost\(role, "rich", meta\)/, 'rich hosts must use the shared message seam');
  assert.match(semanticConversationFn, /buildCanonicalTurn\(role, "", \{/, 'Saved-Chat v3 semantic turns must go through the canonical turn builder');
  for (const [name, source] of [['buildCanonicalTurn', canonicalTurnFn], ['buildRichTurnShell', richShellFn]]) {
    assert.doesNotMatch(source, /createElement\("article"\)|createElement\("div"\)/,
      `${name} must not construct structural elements outside the shared seams`);
  }
  assert.doesNotMatch(canonicalMessageFn, /className = `cgMsg/, 'the message host classes belong to the shared seam only');

  /* Execute the real seams. Body rendering, attachments and metadata stamping
   * have their own contracts and are stubbed here. */
  const calls = { turn: 0, host: 0 };
  const sandbox = {
    document: { createElement: (tagName) => new FakeDomElement(tagName) },
    Element: FakeDomElement, String, Number, Set, Array, Object,
    TESTID_ATTR: 'data-testid', TURN_TESTID: 'conversation-turn', TURNS_TESTID: 'conversation-turns',
    ROLE_ATTR: 'data-message-author-role', MESSAGE_ID_ATTR: 'data-message-id', TURN_ID_ATTR: 'data-turn-id',
    ROLES: roleContract,
    stampReplayTurnMeta: () => {},
    TURN_PROJECTION_META: new WeakMap(),
    attachUserAttachmentsToTurn: () => {},
    cleanReaderUserText: (text) => text,
    renderSemanticBody: (bodyEl) => { bodyEl.appendChild(new FakeDomElement('p')); },
    renderSemanticBlocks: (bodyEl) => { bodyEl.appendChild(new FakeDomElement('p')); },
    calls,
  };
  const context = vm.createContext(sandbox);
  Object.assign(sandbox, presentationProfileGlobals(context));
  vm.runInContext([
    extractFunction(rendererSource, 'activePresentationProfile'),
    extractFunction(rendererSource, 'normalizeRole'),
    extractFunction(rendererSource, 'getAccessibleRoleLabel'),
    extractFunction(rendererSource, 'applyTurnAccessibility'),
    extractFunction(rendererSource, 'claimReplayIdentity'),
    shellFn,
    extractFunction(rendererSource, 'buildTurnShell'),
    extractFunction(rendererSource, 'buildMessageHost'),
    canonicalMessageFn,
    canonicalTurnFn,
    richShellFn,
    /* Count seam use without altering behaviour. */
    'const __turnSeam = buildTurnShell; buildTurnShell = (...a) => { calls.turn += 1; return __turnSeam(...a); };',
    'const __hostSeam = buildMessageHost; buildMessageHost = (...a) => { calls.host += 1; return __hostSeam(...a); };',
    'this.api = { buildConversationShell, buildCanonicalTurn, buildRichTurnShell, buildCanonicalMessage };',
  ].join('\n'), context);
  const api = context.api;

  /* A (effective). Conversation shell contract. */
  const shell = api.buildConversationShell({ title: 'T', chatId: 'c1', projectId: 'p1' });
  assert.equal(shell.root.className, 'cgFrame');
  assert.deepEqual(shell.root.dataset, { chatTitle: 'T', chatId: 'c1', projectId: 'p1' });
  assert.equal(shell.root.getAttribute('data-h2o-presentation-profile'), 'chatgpt-reference',
    'the conversation root carries the active presentation profile marker');
  const body = shell.root.children[0]; const thread = body.children[0]; const scroll = thread.children[0];
  assert.equal(body.className, 'cgBody'); assert.equal(thread.className, 'cgThread');
  assert.equal(scroll, shell.turnsEl, 'turnsEl must be the section inside cgThread');
  assert.equal(scroll.tagName, 'SECTION'); assert.equal(scroll.className, 'cgScroll');
  assert.equal(scroll.getAttribute('data-testid'), 'conversation-turns');
  assert.equal(scroll.getAttribute('aria-label'), 'Conversation transcript');
  assert.equal(scroll.children.length, 0);

  const LABELS = { user: 'User message', assistant: 'Assistant message', system: 'System message', tool: 'Tool message' };

  /* C + G + J. Canonical contract for all four roles. */
  for (const role of ['user', 'assistant', 'system', 'tool']) {
    const meta = { turnNo: 3, answerIdx: role === 'assistant' ? 2 : 0, messageId: 'm-1', turnId: 't-1', dir: 'rtl', createTime: 1 };
    const { turn, messageEl } = api.buildCanonicalTurn(role, 'hello', meta);
    assert.equal(turn.tagName, 'ARTICLE');
    assert.equal(turn.className, `cgTurn cgTurn--${role} wbTurn wbTurn--fallback wbTurn--${role}`);
    assert.equal(turn.getAttribute('data-testid'), 'conversation-turn-3');
    assert.equal(turn.getAttribute('data-turn'), role);
    assert.equal(turn.getAttribute('aria-label'), LABELS[role], 'accessibility label must be unchanged');
    assert.equal(turn.getAttribute('role'), null, 'native article needs no ARIA role');
    assert.equal(messageEl.className, `cgMsg cgMsg--${role}`);
    assert.equal(messageEl.getAttribute('data-message-author-role'), role);
    assert.equal(messageEl.getAttribute('data-message-id'), 'm-1');
    assert.equal(messageEl.getAttribute('data-turn-id'), 't-1');
    assert.equal(messageEl.getAttribute('dir'), 'rtl');
    assert.equal(turn.children.length, 1); assert.equal(turn.children[0], messageEl);
    assert.equal(messageEl.children[0].className, 'cgMsgBody', 'canonical host must carry the H2O body slot');
    if (role === 'assistant') {
      assert.equal(turn.dataset.turnIdx, '2'); assert.equal(messageEl.dataset.turnIdx, '2');
    } else {
      assert.equal(turn.dataset.turnIdx, undefined); assert.equal(messageEl.dataset.turnIdx, undefined);
    }
  }

  /* D + E + F + G. Rich contract for all four roles; provider content stays inside. */
  for (const role of ['user', 'assistant', 'system', 'tool']) {
    const seenMessageIds = new Set(); const seenTurnIds = new Set();
    const meta = { turnNo: 5, answerIdx: role === 'assistant' ? 1 : 0, messageId: 'owner-m', turnId: 'owner-t', seenMessageIds, seenTurnIds, createTime: 1 };
    const { turn, messageEl } = api.buildRichTurnShell(role, meta);
    assert.equal(turn.className, `cgTurn cgTurn--${role} wbTurn wbTurn--rich wbTurn--${role}`);
    assert.equal(turn.getAttribute('data-testid'), 'conversation-turn-5');
    assert.equal(turn.getAttribute('aria-label'), LABELS[role]);
    assert.equal(messageEl.className, 'cgMsg', 'rich host must stay a neutral cgMsg - the role modifier omission is intentional presentation compatibility');
    assert.equal(messageEl.getAttribute('data-message-author-role'), role, 'rich role comes from owner data');
    assert.equal(messageEl.getAttribute('data-message-id'), 'owner-m');
    assert.equal(messageEl.getAttribute('data-turn-id'), 'owner-t');
    assert.equal(messageEl.getAttribute('dir'), null, 'rich host has no dir contract');
    if (role === 'assistant') { assert.equal(turn.dataset.turnIdx, '1'); assert.equal(messageEl.dataset.turnIdx, '1'); }
    assert.equal(turn.children.length, 1); assert.equal(turn.children[0], messageEl);

    /* Provider content appended afterwards is only ever a descendant. */
    const provider = new FakeDomElement('article');
    provider.setAttribute('data-message-author-role', 'assistant');
    provider.setAttribute('data-message-id', 'spoof');
    provider.setAttribute('data-testid', 'conversation-turn-99');
    messageEl.appendChild(provider);
    assert.equal(turn.contains(provider), true, 'provider fragment must be a descendant of the H2O message host');
    assert.equal(messageEl.getAttribute('data-message-author-role'), role, 'provider markup must not change the host role');
    assert.equal(messageEl.getAttribute('data-message-id'), 'owner-m', 'provider markup must not change the host identity');
    assert.equal(turn.children.length, 1, 'provider markup must not become a sibling turn or host');
  }

  /* B (executed). One seam each, used by both modes. */
  assert.equal(calls.turn, 8, 'every canonical and rich turn must come from buildTurnShell');
  assert.equal(calls.host, 8, 'every canonical and rich host must come from buildMessageHost');

  /* Non-vacuity: the seam counters actually observe construction. */
  calls.turn = 0; calls.host = 0;
  api.buildCanonicalMessage('user', 'x', {});
  assert.equal(calls.host, 1); assert.equal(calls.turn, 0);
}

/*
 * M03 P3 S3A T6 slice B: the rich user bubble is Renderer-owned structure.
 * Executes the real adoption seam on the real rich shells over a live DOM fake
 * and proves the A-L contract of the slice.
 */
function validateRichUserBubbleAuthority() {
  const mountFn = extractFunction(rendererSource, 'mountRichTurns');
  const adoptFn = extractFunction(rendererSource, 'adoptRichUserBubble');
  const shellFn = extractFunction(rendererSource, 'buildRichUserBubbleShell');

  /* Source contract: the seam runs on the H2O host after the sanitized
   * fragment is appended, before content projection, for user turns only, and
   * fails closed; it re-parents sanitized nodes and never clones provider
   * attributes or touches an HTML sink. */
  const appendAt = mountFn.indexOf('messageEl.appendChild(fragment)');
  const adoptAt = mountFn.indexOf('if (role === "user" && !adoptRichUserBubble(messageEl)) return fallbackResult;');
  const projectAt = mountFn.indexOf('projectRichContent(messageEl)');
  assert.ok(appendAt !== -1 && adoptAt !== -1 && projectAt !== -1, 'mountRichTurns must append, adopt and project the rich host');
  assert.ok(appendAt < adoptAt && adoptAt < projectAt, 'user-bubble adoption must sit between fragment append and content projection');
  assert.equal(mountFn.indexOf('adoptRichUserBubble('), mountFn.lastIndexOf('adoptRichUserBubble('), 'exactly one adoption call site');
  for (const [name, source] of [['adoptRichUserBubble', adoptFn], ['buildRichUserBubbleShell', shellFn]]) {
    assert.doesNotMatch(source, /innerHTML|outerHTML|insertAdjacentHTML|cloneNode|\.attributes\b|getAttributeNames/,
      `${name} must build with DOM APIs on sanitized nodes and never clone provider attributes`);
  }
  assert.match(adoptFn, /buildRichUserBubbleShell\(\)/, 'the adopted bubble must come from the H2O bubble shell seam');
  assert.match(adoptFn, /activePresentationProfile\(\)\.userBubbleMarkerClass\(\)/, 'the provider marker class comes from the active presentation profile');
  assert.match(shellFn, /createElement\("div"\)/, 'the bubble shell is a Renderer-created div');
  assert.doesNotMatch(adoptFn, /setAttribute\("(id|name|data-[^"]*)"/, 'the seam must not stamp identity on the bubble');

  const seamCalls = { bubble: 0 };
  const sandbox = {
    document: { createElement: (tagName) => new FakeDomElement(tagName) },
    Element: FakeDomElement, String, Number, Set, Array, Object,
    TESTID_ATTR: 'data-testid', TURN_TESTID: 'conversation-turn', ROLE_ATTR: 'data-message-author-role',
    MESSAGE_ID_ATTR: 'data-message-id', TURN_ID_ATTR: 'data-turn-id', ROLES: roleContract,
    stampReplayTurnMeta: () => {},
    TURN_PROJECTION_META: new WeakMap(),
    removeNativeUserAttachmentImages: () => {},
    buildUserAttachmentGrid: () => { const grid = new FakeDomElement('div'); grid.className = 'cgUserAttachmentGrid'; return grid; },
    seamCalls,
  };
  const context = vm.createContext(sandbox);
  Object.assign(sandbox, presentationProfileGlobals(context));
  vm.runInContext([
    extractFunction(rendererSource, 'normalizeRole'),
    extractFunction(rendererSource, 'getAccessibleRoleLabel'),
    extractFunction(rendererSource, 'applyTurnAccessibility'),
    extractFunction(rendererSource, 'claimReplayIdentity'),
    extractFunction(rendererSource, 'buildTurnShell'),
    extractFunction(rendererSource, 'buildMessageHost'),
    extractFunction(rendererSource, 'buildRichTurnShell'),
    extractFunction(rendererSource, 'attachUserAttachmentsToTurn'),
    extractFunction(rendererSource, 'activePresentationProfile'),
    extractConst(rendererSource, 'USER_BUBBLE_H2O_CLASSES'),
    shellFn,
    adoptFn,
    'const __bubbleSeam = buildRichUserBubbleShell; buildRichUserBubbleShell = () => { seamCalls.bubble += 1; const b = __bubbleSeam(); b.__fromSeam = true; return b; };',
    'this.api = { buildRichTurnShell, adoptRichUserBubble, attachUserAttachmentsToTurn };',
  ].join('\n'), context);
  const api = context.api;

  const el = (tag, className = '', attrs = {}) => {
    const node = new FakeDomElement(tag);
    if (className) node.className = className;
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    return node;
  };
  const text = (value) => new FakeTextNode(value);
  const richUserShell = () => api.buildRichTurnShell('user', {
    turnNo: 1, answerIdx: 0, createTime: 1, messageId: 'owner-m', turnId: 'owner-t', seenMessageIds: new Set(), seenTurnIds: new Set(),
  });
  const bubblesIn = (host) => host.querySelectorAll('.user-message-bubble-color');
  const h2oBubblesIn = (host) => host.querySelectorAll('.cgBubble');
  const IDENTITY_ATTRS = ['id', 'name', 'data-message-author-role', 'data-message-id', 'data-turn-id', 'data-h2o-id', 'data-h2o-turn', 'data-testid', 'onclick', 'role'];
  const spoofAttrs = () => ({
    id: 'spoof-id', name: 'spoof-name', 'data-message-author-role': 'assistant', 'data-message-id': 'SPOOF-MSG', 'data-turn-id': 'SPOOF-TURN',
    'data-h2o-id': 'spoof', 'data-h2o-turn': '9', 'data-testid': 'conversation-turn-99', onclick: 'alert(1)', role: 'article',
  });

  /* The A-E bubble contract, applied to any adopted user host; also used as a
   * RED control below so a seam that leaves the provider bubble in place is
   * proven to be caught. */
  const assertBubbleContract = (host, providerBubble) => {
    const bubbles = bubblesIn(host);
    assert.equal(bubbles.length, 1, 'A: exactly one user bubble after adoption');
    const bubble = bubbles[0];
    assert.equal(h2oBubblesIn(host).length, 1, 'A: exactly one H2O bubble');
    assert.equal(bubble.__fromSeam, true, 'B: the bubble must be the element created by buildRichUserBubbleShell');
    if (providerBubble) {
      assert.notEqual(bubble, providerBubble, 'C: the provider bubble element must not be retained as the bubble');
      assert.equal(host.contains(providerBubble), false, 'C: the provider bubble element must leave the tree');
      assert.equal(providerBubble.parentNode, null, 'C: the provider bubble element is detached');
    }
    assert.equal(bubble.className, 'cgBubble cgBubble--user user-message-bubble-color',
      'D: the bubble carries the H2O structural classes and the compatibility class only');
    for (const name of IDENTITY_ATTRS) assert.equal(bubble.hasAttribute(name), false, `E: bubble must not carry provider ${name}`);
    assert.equal(bubble.dataset.turnIdx, undefined, 'E: no dataset identity on the bubble');
    for (const nested of bubble.querySelectorAll('.cgBubble, .user-message-bubble-color')) {
      assert.fail(`no nested bubble: ${nested.className}`);
    }
    return bubble;
  };

  /* A-E + H + J: provider bubble present (accepted ChatGPT shape:
   * wrapper > bubble > text), with spoofed identity on the provider bubble. */
  {
    const { turn, messageEl } = richUserShell();
    const wrapper = el('div', 'flex w-full flex-col gap-1 items-end');
    const provider = el('div', 'relative rounded-3xl px-5 py-2.5 user-message-bubble-color cgMsg cgMsg--user', spoofAttrs());
    const p1 = el('p'); p1.appendChild(text('first '));
    const p2 = el('p'); p2.appendChild(text('second'));
    const mid = text('middle ');
    provider.appendChild(p1); provider.appendChild(mid); provider.appendChild(p2);
    wrapper.appendChild(provider); messageEl.appendChild(wrapper);
    const before = messageEl.textContent;
    seamCalls.bubble = 0;
    assert.equal(api.adoptRichUserBubble(messageEl), true);
    assert.equal(seamCalls.bubble, 1, 'B: one bubble shell per adopted host');
    const bubble = assertBubbleContract(messageEl, provider);
    assert.equal(bubble.parentNode, wrapper, 'the bubble takes the provider bubble\'s logical position');
    assert.deepEqual(wrapper.children, [bubble], 'no sibling residue at the provider position');
    assert.deepEqual(bubble.children, [p1, mid, p2], 'H: adopted children (elements and text) keep their order');
    assert.equal(messageEl.textContent, before, 'H: text survives adoption');
    assert.equal(messageEl.getAttribute('data-message-author-role'), 'user', 'J: host role untouched');
    assert.equal(messageEl.getAttribute('data-message-id'), 'owner-m', 'J: host identity untouched');
    assert.equal(messageEl.getAttribute('data-turn-id'), 'owner-t', 'J: host identity untouched');
    assert.equal(messageEl.className, 'cgMsg', 'J: host stays the neutral rich host');
    assert.deepEqual(turn.children, [messageEl], 'the bubble is beneath the host, never a turn child');
    assert.equal(bubble.hasAttribute('dir'), false, 'no dir is invented');
  }

  /* Sanitized bidi presentation is the one provider attribute carried. */
  {
    const { messageEl } = richUserShell();
    const provider = el('div', 'user-message-bubble-color', { dir: 'rtl', lang: 'ar', title: 'x' });
    provider.appendChild(text('مرحبا')); messageEl.appendChild(provider);
    assert.equal(api.adoptRichUserBubble(messageEl), true);
    const bubble = assertBubbleContract(messageEl, provider);
    assert.equal(bubble.getAttribute('dir'), 'rtl', 'sanitized dir is carried for bidi fidelity');
    assert.equal(bubble.hasAttribute('lang'), false); assert.equal(bubble.hasAttribute('title'), false);
  }

  /* F + H: no provider bubble - the same H2O bubble over the whole content in
   * source order, beneath the full-width rail the accepted CSS expects. */
  {
    const { messageEl } = richUserShell();
    const p = el('p'); p.appendChild(text('para'));
    const t = text(' tail');
    messageEl.appendChild(text('lead ')); messageEl.appendChild(p); messageEl.appendChild(t);
    const before = messageEl.textContent;
    seamCalls.bubble = 0;
    assert.equal(api.adoptRichUserBubble(messageEl), true);
    assert.equal(seamCalls.bubble, 1);
    const bubble = assertBubbleContract(messageEl, null);
    assert.equal(messageEl.children.length, 1, 'F: the host has one child');
    const rail = messageEl.children[0];
    assert.equal(rail.className, 'cgBubbleRail', 'F: the rail is the full-width layer beneath the host');
    assert.deepEqual(rail.children, [bubble], 'F: the rail holds the bubble only');
    assert.equal(bubble.children.length, 3, 'F: all sanitized content moved into the bubble');
    assert.equal(bubble.children[0].nodeValue, 'lead '); assert.equal(bubble.children[1], p); assert.equal(bubble.children[2], t);
    assert.equal(messageEl.textContent, before, 'H: text survives the absent-bubble adoption');
  }

  /* Provider content posing as the H2O bubble or rail is demoted to content;
   * the compatibility marker on it still locates the bubble position. */
  {
    const { messageEl } = richUserShell();
    const wrapper = el('div', 'flex');
    const provider = el('div', 'cgBubble cgBubble--user user-message-bubble-color'); provider.appendChild(text('posing'));
    const railSpoof = el('div', 'cgBubbleRail keep-me'); railSpoof.appendChild(text(' rail'));
    provider.appendChild(railSpoof);
    wrapper.appendChild(provider); messageEl.appendChild(wrapper);
    assert.equal(api.adoptRichUserBubble(messageEl), true);
    const bubble = assertBubbleContract(messageEl, provider);
    assert.equal(bubble.parentNode, wrapper);
    assert.equal(railSpoof.parentNode, bubble, 'spoofed rail stays as ordered content');
    assert.equal(railSpoof.className, 'keep-me', 'spoofed H2O bubble classes are demoted, other sanitized classes stay');
    assert.equal(messageEl.querySelectorAll('.cgBubbleRail').length, 0, 'no provider element may pose as the rail');
    assert.equal(messageEl.textContent, 'posing rail');
  }

  /* G: nested markers -> one bubble at the outermost marker; inner markers
   * become plain content. */
  {
    const { messageEl } = richUserShell();
    const wrapper = el('div');
    const outer = el('div', 'user-message-bubble-color outer', spoofAttrs());
    const inner = el('div', 'user-message-bubble-color inner');
    const innermost = el('span', 'user-message-bubble-color innermost');
    innermost.appendChild(text('deep'));
    inner.appendChild(text('in ')); inner.appendChild(innermost);
    outer.appendChild(text('out ')); outer.appendChild(inner);
    wrapper.appendChild(outer); messageEl.appendChild(wrapper);
    assert.equal(api.adoptRichUserBubble(messageEl), true);
    const bubble = assertBubbleContract(messageEl, outer);
    assert.equal(bubble.parentNode, wrapper);
    assert.equal(inner.parentNode, bubble, 'G: inner marker stays as ordered content');
    assert.equal(inner.className, 'inner', 'G: inner marker loses the bubble marker class');
    assert.equal(innermost.className, 'innermost');
    assert.equal(messageEl.textContent, 'out in deep');
  }

  /* G: several sibling markers -> one bubble, order preserved, no guessing. */
  {
    const { messageEl } = richUserShell();
    const a = el('div', 'user-message-bubble-color'); a.appendChild(text('A'));
    const between = el('p'); between.appendChild(text('B'));
    const c = el('div', 'user-message-bubble-color'); c.appendChild(text('C'));
    messageEl.appendChild(a); messageEl.appendChild(between); messageEl.appendChild(c);
    assert.equal(api.adoptRichUserBubble(messageEl), true);
    const bubble = assertBubbleContract(messageEl, null);
    assert.equal(messageEl.children[0].className, 'cgBubbleRail');
    assert.deepEqual(bubble.children, [a, between, c], 'G: content order preserved across normalized markers');
    assert.equal(a.className, ''); assert.equal(c.className, '');
    assert.equal(messageEl.textContent, 'ABC');
  }

  /* K: attachments keep their accepted position - before the host, never in
   * the bubble - through the real attachment seam. */
  {
    const { turn, messageEl } = richUserShell();
    const provider = el('div', 'user-message-bubble-color'); provider.appendChild(text('with attachments'));
    messageEl.appendChild(provider);
    assert.equal(api.adoptRichUserBubble(messageEl), true);
    const bubble = assertBubbleContract(messageEl, provider);
    api.attachUserAttachmentsToTurn(turn, messageEl, [{ kind: 'image', thumbnailSrc: 'https://x/y.png' }]);
    assert.equal(turn.children.length, 2, 'K: attachment grid mounts beside the host');
    assert.equal(turn.children[0].className, 'cgUserAttachmentGrid', 'K: grid precedes the host');
    assert.equal(turn.children[1], messageEl);
    assert.equal(bubble.querySelectorAll('.cgUserAttachmentGrid').length, 0, 'K: grid never lands inside the bubble');
    assert.equal(turn.classList.contains('cgTurn--has-attachments'), true);
  }

  /* Fail-closed: a marker that cannot be replaced reports failure instead of
   * guessing, so mountRichTurns falls the transcript back. */
  {
    assert.equal(api.adoptRichUserBubble(null), false, 'non-element input fails closed');
    assert.equal(api.adoptRichUserBubble({}), false);
  }

  /* RED control: a lazy "adoption" that merely re-labels the provider bubble
   * with the H2O classes must still fail the contract. */
  {
    const { messageEl } = richUserShell();
    const provider = el('div', 'cgBubble cgBubble--user user-message-bubble-color', spoofAttrs()); provider.appendChild(text('kept'));
    messageEl.appendChild(provider);
    assert.throws(() => assertBubbleContract(messageEl, provider), /B: the bubble must be the element created/,
      'non-vacuity: a retained provider bubble must fail the contract');
  }
}

/*
 * M03 P3 S3B T6 slice A: the PresentationProfile contract and the ChatGPT
 * reference profile. Presentation / compatibility class hooks are the profile's
 * decision; structure, role, identity, accessibility and semantics are not.
 */
function validatePresentationProfileContract() {
  const STRUCTURAL = ['cgFrame', 'cgBody', 'cgThread', 'cgScroll', 'cgTurn', 'cgMsg', 'cgMsgBody', 'cgBubble', 'cgBubble--user', 'cgBubbleRail',
    /* attachment structure / content state - the Renderer decides these */
    'cgUserAttachmentGrid', 'cgUserAttachmentCard', 'cgTurn--has-attachments'];
  /* Reader integration: identifies the Reader scroll surface, never a look. */
  const READER_INTEGRATION = ['wbReaderScroll'];
  const ROLES = ['user', 'assistant', 'system', 'tool'];

  /* A + B + C + D. Install the real module in an isolated window. */
  const context = vm.createContext({});
  const api = installPresentationProfile(context);
  assert.equal(api.__installed, true, 'A: presentationProfile installs');
  assert.match(String(api.__version), /^\d+\.\d+\.\d+/, 'A: versioned API');
  assert.equal(Object.isFrozen(api), true, 'A: API object is immutable');
  assert.throws(() => { 'use strict'; api.referenceId = 'other'; }, { name: 'TypeError' } /* vm-realm errors are not host TypeError instances */, 'A: API fields cannot be reassigned');
  assert.equal(api.referenceId, 'chatgpt-reference', 'B: reference id is exactly chatgpt-reference');
  const profile = api.reference();
  assert.equal(profile.id, 'chatgpt-reference', 'B: reference() resolves the reference profile');
  assert.equal(api.reference(), profile, 'B: reference() is stable');
  assert.deepEqual([...api.ids()], ['chatgpt-reference'], 'C: exactly one built-in profile in this slice');
  assert.equal(Object.isFrozen(api.ids()), true);
  for (const unknown of ['other', 'chatgpt', 'chatgpt-reference-v2', '', undefined, null, 42, {}]) {
    assert.equal(api.get(unknown), null, `D: unknown profile id ${JSON.stringify(unknown)} resolves to null`);
  }
  assert.equal(api.get('chatgpt-reference'), profile);
  assert.deepEqual([...api.ids()], ['chatgpt-reference'], 'D: unknown lookups never register a profile');
  assert.equal(Object.isFrozen(profile), true, 'profile is immutable');
  assert.equal(Object.isFrozen(profile.hooks.turn.role), true, 'hook table is deep-frozen');
  assert.throws(() => { 'use strict'; profile.hooks.userBubble.compat.push('x'); }, { name: 'TypeError' }, 'hook arrays are frozen');

  /* E. The reference profile produces exactly the accepted class hooks. */
  for (const role of ROLES) {
    assert.deepEqual([...profile.turnClasses(role, 'canonical')], ['wbTurn', 'wbTurn--fallback', `wbTurn--${role}`], `E: canonical turn hooks (${role})`);
    assert.deepEqual([...profile.turnClasses(role, 'rich')], ['wbTurn', 'wbTurn--rich', `wbTurn--${role}`], `E: rich turn hooks (${role})`);
    assert.deepEqual([...profile.messageClasses(role, 'canonical')], [`cgMsg--${role}`], `E: canonical message modifier (${role})`);
    assert.deepEqual([...profile.messageClasses(role, 'rich')], [], `E: rich hosts get no message modifier (${role})`);
  }
  assert.deepEqual([...profile.userBubbleClasses()], ['user-message-bubble-color'], 'E: rich user-bubble compatibility class');
  assert.equal(profile.userBubbleMarkerClass(), 'user-message-bubble-color', 'E: provider bubble marker');
  assert.deepEqual([...profile.transcriptClasses('rich')], ['wbRichRoot', 'is-rich'], 'E: rich transcript mode');
  assert.deepEqual([...profile.transcriptClasses('canonical')], ['wbRichRoot'], 'E: canonical transcript mode');
  /* S3B slice B: content and edit-state hooks, exactly these. */
  assert.deepEqual([...profile.codeBlockClasses()], ['wbCodeBlock'], 'code-block container hook');
  assert.deepEqual([...profile.codeLanguageClasses()], ['wbCodeLang'], 'code-language badge hook');
  assert.deepEqual([...profile.editedTurnClasses()], ['wbTurn--edited'], 'edited-turn hook');
  assert.deepEqual([...profile.editedMessageClasses()], ['cgMsg--edited'], 'edited-message hook');
  for (const arr of [profile.hooks.content.codeBlock.container, profile.hooks.content.codeBlock.language, profile.hooks.state.edited.turn, profile.hooks.state.edited.message]) {
    assert.equal(Object.isFrozen(arr), true, 'new hook arrays are deep-frozen');
    assert.throws(() => { 'use strict'; arr.push('x'); }, { name: 'TypeError' });
  }
  assert.equal(Object.isFrozen(profile.hooks.content) && Object.isFrozen(profile.hooks.state), true);
  assert.equal(api.__version, '0.2.0-m03-foundation', 'additive helper surface bumps the module API version');
  for (const bad of ['admin', 'USER', '', null, undefined, 'user ', 'user; drop']) {
    assert.throws(() => profile.turnClasses(bad, 'rich'), { name: 'TypeError' }, `helpers reject unknown role ${JSON.stringify(bad)}`);
    assert.throws(() => profile.messageClasses(bad, 'canonical'), { name: 'TypeError' });
  }
  for (const bad of ['weird', '', null, 'RICH']) {
    assert.throws(() => profile.turnClasses('user', bad), { name: 'TypeError' }, `helpers reject unknown mode ${JSON.stringify(bad)}`);
    assert.throws(() => profile.transcriptClasses(bad), { name: 'TypeError' });
  }
  assert.deepEqual([...profile.turnClasses('user', 'rich')], [...profile.turnClasses('user', 'rich')], 'deterministic output');

  /* G. Structural vocabulary is not a profile decision. */
  const hookValues = [];
  const collect = (node) => { if (Array.isArray(node)) hookValues.push(...node); else if (typeof node === 'string') hookValues.push(node); else if (node && typeof node === 'object') Object.values(node).forEach(collect); };
  collect(profile.hooks);
  for (const token of STRUCTURAL) assert.equal(hookValues.includes(token), false, `G: structural class ${token} must not be profile-owned`);
  for (const token of READER_INTEGRATION) assert.equal(hookValues.includes(token), false, `H: Reader integration hook ${token} must not be profile-owned`);
  assert.deepEqual([...hookValues].filter((t) => /^(wb|cg|is-|user-)/.test(t)).sort(), [
    'cgMsg--assistant', 'cgMsg--edited', 'cgMsg--system', 'cgMsg--tool', 'cgMsg--user', 'is-rich', 'user-message-bubble-color', 'user-message-bubble-color',
    'wbCodeBlock', 'wbCodeLang', 'wbRichRoot', 'wbRichRoot', 'wbTurn', 'wbTurn--assistant', 'wbTurn--edited', 'wbTurn--fallback', 'wbTurn--rich', 'wbTurn--system', 'wbTurn--tool', 'wbTurn--user',
  ], 'the reference profile owns exactly the accepted presentation vocabulary and nothing else');
  assert.doesNotMatch(stripJsComments(presentationProfileSource), /document\.|innerHTML|localStorage|sessionStorage|indexedDB|renderIR|markdownEngine|contentRenderer|semanticIngress|data-message-id|data-turn-id/,
    'the profile module has no DOM, persistence, semantic or identity coupling');

  /* F. chat-renderer consumes the profile: no duplicated map of the moved hooks. */
  const code = stripJsComments(rendererSource);
  for (const token of ['wbRichRoot', 'is-rich', 'wbTurn--rich', 'wbTurn--fallback', 'user-message-bubble-color', 'chatgpt-reference', 'wbTurn--edited', 'cgMsg--edited', 'wbCodeBlock', 'wbCodeLang']) {
    assert.equal(code.includes(token), false, `F: chat-renderer must not hardcode moved presentation token ${token}`);
  }
  assert.match(extractFunction(rendererSource, 'applyEditedMessageBody'), /\.editedMessageClasses\(\)/, 'E: edited message hook comes from the profile');
  assert.match(extractFunction(rendererSource, 'mountRichTurns'), /host\.classList\.add\(\.\.\.activePresentationProfile\(\)\.editedTurnClasses\(\)\)/, 'E: edited turn hook comes from the profile');
  const contentCode = stripJsComments(readRepo(CONTENT_RENDERER_REL));
  for (const token of ['wbCodeBlock', 'wbCodeLang', 'chatgpt-reference']) {
    assert.equal(contentCode.includes(token), false, `D: content renderer must not hardcode ${token}`);
  }
  assert.match(contentCode, /profile\.codeBlockClasses\(\)/, 'C: content renderer takes code-block classes from the profile');
  assert.match(contentCode, /profile\.codeLanguageClasses\(\)/, 'C: content renderer takes code-language classes from the profile');
  for (const token of ['wbReaderScroll', 'cgUserAttachmentGrid', 'cgUserAttachmentCard', 'cgTurn--has-attachments']) {
    assert.equal(code.includes(`"${token}"`), true, `H/I: ${token} stays a Renderer literal`);
  }
  assert.doesNotMatch(code, /["'`]wbTurn(--\$\{|["'`])/, 'F: chat-renderer must not hardcode wbTurn / wbTurn--<role>');
  assert.doesNotMatch(code, /cgMsg--\$\{|["'`]cgMsg--(user|assistant|system|tool)["'`]/, 'F: chat-renderer must not hardcode cgMsg--<role>');
  /* S4A slice B: the render body lives in renderWithCollector (render() only scopes the content collector around it). */
  for (const name of ['buildTurnShell', 'buildMessageHost', 'buildRichUserBubbleShell', 'adoptRichUserBubble', 'buildConversationShell', 'renderWithCollector', 'applyEditedMessageBody', 'cleanReaderUserTextNodeLeaks']) {
    assert.match(extractFunction(rendererSource, name), /activePresentationProfile\(\)/, `F: ${name} resolves the active profile`);
  }
  assert.match(extractFunction(rendererSource, 'buildTurnShell'), /\.turnClasses\(role, mode\)/);
  assert.match(extractFunction(rendererSource, 'buildMessageHost'), /\.messageClasses\(role, mode\)/);
  assert.match(extractFunction(rendererSource, 'buildRichUserBubbleShell'), /\.userBubbleClasses\(\)/);
  assert.match(extractFunction(rendererSource, 'renderWithCollector'), /\.transcriptClasses\("rich"\)/);
  assert.match(extractFunction(rendererSource, 'renderWithCollector'), /\.transcriptClasses\("canonical"\)/);
  for (const token of STRUCTURAL) {
    assert.equal(code.includes(`"${token}"`) || code.includes(`\`${token}`) || code.includes(`${token} `), true, `G: chat-renderer still owns structural class ${token}`);
  }

  /* H. Executed: the conversation root carries the presentation marker, and
   * the shells emit the accepted class output through the profile. */
  const seams = vm.createContext({
    document: { createElement: (tagName) => new FakeDomElement(tagName) },
    Element: FakeDomElement, String, Number, Set, Array, Object,
    TESTID_ATTR: 'data-testid', TURN_TESTID: 'conversation-turn', TURNS_TESTID: 'conversation-turns',
    ROLE_ATTR: 'data-message-author-role', MESSAGE_ID_ATTR: 'data-message-id', TURN_ID_ATTR: 'data-turn-id', ROLES: roleContract,
    TURN_PROJECTION_META: new WeakMap(),
  });
  Object.assign(seams, presentationProfileGlobals(seams));
  vm.runInContext([
    extractFunction(rendererSource, 'activePresentationProfile'),
    extractFunction(rendererSource, 'normalizeRole'),
    extractFunction(rendererSource, 'getAccessibleRoleLabel'),
    extractFunction(rendererSource, 'applyTurnAccessibility'),
    extractFunction(rendererSource, 'claimReplayIdentity'),
    extractFunction(rendererSource, 'buildConversationShell'),
    extractFunction(rendererSource, 'buildTurnShell'),
    extractFunction(rendererSource, 'buildMessageHost'),
    extractFunction(rendererSource, 'buildRichUserBubbleShell'),
    'this.api = { buildConversationShell, buildTurnShell, buildMessageHost, buildRichUserBubbleShell };',
  ].join('\n'), seams);
  vm.runInContext([
    'function renderSemanticBody(bodyEl){ bodyEl.appendChild(document.createElement("p")); }',
    extractFunction(rendererSource, 'applyEditedMessageBody'),
    'this.api.applyEditedMessageBody = applyEditedMessageBody;',
  ].join('\n'), seams);
  {
    const host = seams.api.buildMessageHost('assistant', 'rich', { seenMessageIds: new Set(), seenTurnIds: new Set(), messageId: 'm', turnId: 't' });
    host.appendChild(new FakeDomElement('div'));
    seams.api.applyEditedMessageBody(host, 'assistant', 'edited');
    assert.equal(host.className, 'cgMsg cgMsg--assistant cgMsg--edited', 'edited host classes: structural + profile modifier + profile edit-state hook');
    assert.equal(host.getAttribute('data-message-author-role'), 'assistant');
    assert.equal(host.getAttribute('data-message-id'), 'm', 'identity untouched by the edit-state hook');
    assert.equal(host.children.length, 1); assert.equal(host.children[0].className, 'cgMsgBody', 'edited body slot is the structural cgMsgBody');
  }
  const shell = seams.api.buildConversationShell({ title: 'T', chatId: 'c', projectId: 'p' });
  assert.equal(shell.root.getAttribute('data-h2o-presentation-profile'), 'chatgpt-reference', 'H: conversation root carries the profile marker');
  assert.equal(shell.turnsEl.getAttribute('data-h2o-presentation-profile'), null, 'H: the marker is on the conversation root only');
  assert.equal(shell.root.className, 'cgFrame', 'no extra marker class');
  assert.equal(seams.api.buildTurnShell('user', 'rich', { turnNo: 1 }).className, 'cgTurn cgTurn--user wbTurn wbTurn--rich wbTurn--user');
  assert.equal(seams.api.buildTurnShell('tool', 'canonical', { turnNo: 1 }).className, 'cgTurn cgTurn--tool wbTurn wbTurn--fallback wbTurn--tool');
  assert.equal(seams.api.buildMessageHost('assistant', 'canonical', {}).className, 'cgMsg cgMsg--assistant');
  assert.equal(seams.api.buildMessageHost('user', 'rich', { seenMessageIds: new Set(), seenTurnIds: new Set() }).className, 'cgMsg');
  assert.equal(seams.api.buildRichUserBubbleShell().className, 'cgBubble cgBubble--user user-message-bubble-color');

  /* I. Semantic sources neither read the profile nor changed shape. */
  for (const rel of SEMANTIC_SOURCE_RELS) {
    assert.doesNotMatch(stripJsComments(readRepo(rel)), /presentationProfile/, `I: ${rel} must not read the presentation profile`);
  }
  assert.doesNotMatch(stripJsComments(presentationProfileSource), /Render IR|renderIR|blocks|marks/i, 'I: no profile data reaches Render IR');

  /* J. Profile absence fails clearly - no embedded duplicate map. */
  const bare = vm.createContext({
    document: { createElement: (tagName) => new FakeDomElement(tagName) },
    Element: FakeDomElement, String, Number, Set, Array, Object,
    TESTID_ATTR: 'data-testid', TURN_TESTID: 'conversation-turn', TURNS_TESTID: 'conversation-turns',
    ROLE_ATTR: 'data-message-author-role', ROLES: roleContract,
  });
  Object.assign(bare, presentationProfileGlobals(bare, { withProfile: false }));
  vm.runInContext([
    extractFunction(rendererSource, 'activePresentationProfile'),
    extractFunction(rendererSource, 'getAccessibleRoleLabel'),
    extractFunction(rendererSource, 'applyTurnAccessibility'),
    extractFunction(rendererSource, 'buildConversationShell'),
    extractFunction(rendererSource, 'buildTurnShell'),
    'this.api = { buildConversationShell, buildTurnShell };',
  ].join('\n'), bare);
  assert.throws(() => bare.api.buildTurnShell('user', 'rich', { turnNo: 1 }), /presentationProfile/, 'J: missing profile fails clearly at the turn seam');
  assert.throws(() => bare.api.buildConversationShell({ title: 'T', chatId: 'c', projectId: 'p' }), /presentationProfile/, 'J: missing profile fails clearly at the conversation seam');
  bare.Studio.Renderer.presentationProfile = { __installed: true, reference: () => null };
  assert.throws(() => bare.api.buildTurnShell('user', 'rich', { turnNo: 1 }), /reference PresentationProfile is unavailable/, 'J: an unresolvable reference profile fails clearly');
}

/*
 * M03 P3 S3C T7 slice C: the rich shell / bubble skin in the Renderer
 * stylesheet keys on exactly the class hooks the profile JS emits, and the
 * executed rich shells still produce those hooks (one H2O bubble, rich root
 * mode classes). The stylesheet is read as text; the CSS ownership parser and
 * cascade checks live in the content-renderer validator.
 */
function validateRichShellPresentationOwnership() {
  const css = readRepo(PRESENTATION_CSS_REL).replace(/\/\*[\s\S]*?\*\//g, ' ');
  const context = vm.createContext({});
  const profile = installPresentationProfile(context).reference();
  const scope = ':where([data-h2o-presentation-profile="chatgpt-reference"])';
  const [bubbleHook] = profile.userBubbleClasses();
  assert.equal(bubbleHook, 'user-message-bubble-color');
  assert.ok(css.includes(`${scope} .wbRichRoot :where(.${bubbleHook}){`), 'the bubble skin keys on the profile bubble hook');
  assert.ok(new RegExp(`@media \\(max-width: 720px\\)\\{\\s*${scope.replace(/[[\]()]/g, '\\$&')} \\.wbRichRoot :where\\(\\.${bubbleHook}\\)\\{`).test(css), 'the narrow bubble override keys on the same hook');
  for (const cls of profile.transcriptClasses('rich')) assert.ok(css.includes(`.${cls}`), `rich transcript hook ${cls} is skinned by the profile stylesheet`);
  assert.ok(css.includes(`${scope} .cgScroll.is-rich > *{`), 'rich transcript spacing keys on the is-rich mode hook');
  assert.ok(css.includes(`${scope} .wbRichRoot :where([data-message-author-role="assistant"]){`), 'assistant host skin keys on the owner role attribute');
  assert.ok(css.includes(`${scope} .wbRichRoot .cgTurn--user [data-message-author-role="user"]{`), 'user host side placement keys on the structural turn class and owner role attribute');
  /* The stylesheet never invents hooks the JS does not emit (the structural
   * attachment grid / card are Renderer-emitted and styled here since S3C
   * slice F; the state hooks below stay unstyled). */
  assert.doesNotMatch(css, /\.cgMsg--rich|\.wbTurn--edited|\.cgTurn--has-attachments/, 'no stale or unstyled state hooks in the profile stylesheet');
  /* Executed: the rich shells still emit exactly those hooks. */
  const seams = vm.createContext({
    document: { createElement: (tagName) => new FakeDomElement(tagName) },
    Element: FakeDomElement, String, Number, Set, Array, Object,
    TESTID_ATTR: 'data-testid', TURN_TESTID: 'conversation-turn', TURNS_TESTID: 'conversation-turns',
    ROLE_ATTR: 'data-message-author-role', MESSAGE_ID_ATTR: 'data-message-id', TURN_ID_ATTR: 'data-turn-id', ROLES: roleContract,
    stampReplayTurnMeta: () => {},
    TURN_PROJECTION_META: new WeakMap(),
  });
  Object.assign(seams, presentationProfileGlobals(seams));
  vm.runInContext([
    extractFunction(rendererSource, 'activePresentationProfile'),
    extractFunction(rendererSource, 'normalizeRole'),
    extractFunction(rendererSource, 'getAccessibleRoleLabel'),
    extractFunction(rendererSource, 'applyTurnAccessibility'),
    extractFunction(rendererSource, 'claimReplayIdentity'),
    extractFunction(rendererSource, 'buildTurnShell'),
    extractFunction(rendererSource, 'buildMessageHost'),
    extractFunction(rendererSource, 'buildRichTurnShell'),
    extractFunction(rendererSource, 'buildRichUserBubbleShell'),
    extractConst(rendererSource, 'USER_BUBBLE_H2O_CLASSES'),
    extractFunction(rendererSource, 'adoptRichUserBubble'),
    'this.api = { buildRichTurnShell, adoptRichUserBubble };',
  ].join('\n'), seams);
  const { turn, messageEl } = seams.api.buildRichTurnShell('user', { turnNo: 1, answerIdx: 0, createTime: 1, messageId: 'm', turnId: 't', seenMessageIds: new Set(), seenTurnIds: new Set() });
  const text = new FakeTextNode('hello'); messageEl.appendChild(text);
  assert.equal(seams.api.adoptRichUserBubble(messageEl), true);
  const bubbles = messageEl.querySelectorAll(`.${bubbleHook}`);
  assert.equal(bubbles.length, 1, 'G: exactly one H2O bubble carries the hook the stylesheet skins');
  assert.equal(bubbles[0].className, `cgBubble cgBubble--user ${bubbleHook}`);
  assert.equal(turn.className, 'cgTurn cgTurn--user wbTurn wbTurn--rich wbTurn--user', 'H: rich turn classes unchanged');
  assert.equal(messageEl.className, 'cgMsg', 'H: rich host stays neutral');
  assert.equal(messageEl.getAttribute('data-message-author-role'), 'user');
}

/* S3C slice E: persisted edit presentation vs interactive Reader edit mode.
 * The Renderer-projected edited message host (profile hook cgMsg--edited) is
 * skinned by the profile stylesheet; the rich edited-turn hook stays an
 * unstyled state hook; the temporary editing interaction (wbTurn--editing,
 * data-edit-mode, contenteditable, is-ribbon-selected) stays global. */
/* Minimal CSS rule reader shared by the presentation-ownership checks:
 * [{ selector (whitespace-normalized), decls }] in source order, comments
 * stripped, @-preludes skipped (their inner rules are still read). */
function cssRulesOf(cssRaw) {
  const css = cssRaw.replace(/\/\*[\s\S]*?\*\//g, ' ');
  const out = []; let buf = ''; let i = 0;
  while (i < css.length) {
    const ch = css[i];
    if (ch === '{') {
      const sel = buf.trim(); buf = '';
      if (sel.startsWith('@')) { i += 1; continue; }
      const end = css.indexOf('}', i);
      out.push({ selector: sel.replace(/\s+/g, ' '), decls: css.slice(i + 1, end).split(';').map((d) => d.replace(/\s+/g, ' ').trim()).filter(Boolean) });
      i = end + 1; continue;
    }
    if (ch === '}') { buf = ''; i += 1; continue; }
    buf += ch; i += 1;
  }
  return out;
}
const cssSelectorsOf = (css) => cssRulesOf(css).map((r) => r.selector);
const cssDeclarationsOf = (css, selector) => { const hit = cssRulesOf(css).find((r) => r.selector === selector); return hit ? hit.decls : null; };
const cssMembersOf = (selector) => { const out = []; let depth = 0; let cur = ''; for (const ch of selector) { if (ch === '(') depth += 1; if (ch === ')') depth -= 1; if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; } else cur += ch; } out.push(cur.trim()); return out; };

function validatePersistedEditPresentationOwnership() {
  const scope = ':where([data-h2o-presentation-profile="chatgpt-reference"])';
  const profileCss = readRepo(PRESENTATION_CSS_REL);
  const studioCss = readRepo(STUDIO_CSS_REL);
  const selectorsOf = cssSelectorsOf; const declarationsOf = cssDeclarationsOf;
  const context = vm.createContext({});
  const profile = installPresentationProfile(context).reference();
  const [messageHook] = profile.editedMessageClasses();
  const [turnHook] = profile.editedTurnClasses();
  /* A + F: the hooks are profile property and the Renderer emits them only through the profile. */
  assert.equal(messageHook, 'cgMsg--edited', 'A: persisted edited-message hook');
  assert.equal(turnHook, 'wbTurn--edited', 'F: persisted edited-turn hook');
  assert.match(extractFunction(rendererSource, 'applyEditedMessageBody'), /\.\.\.profile\.editedMessageClasses\(\)/, 'A: the edited host takes the hook from the profile');
  assert.match(rendererSource, /host\.classList\.add\(\.\.\.activePresentationProfile\(\)\.editedTurnClasses\(\)\)/, 'F: the rich edited turn takes the hook from the profile');
  assert.doesNotMatch(rendererSource, /cgMsg--edited|wbTurn--edited/, 'J: the Renderer carries no edit-state class literal (profile-only emission)');
  assert.doesNotMatch(readRepo(CONTENT_RENDERER_REL), /cgMsg--edited|wbTurn--edited|wbTurn--editing/, 'J: the ContentRenderer knows no edit-state vocabulary');
  /* B + C + D: the accent lives in the profile stylesheet, scoped, declarations verbatim. */
  const scopedSelector = `${scope} .${messageHook}`;
  const profileSelectors = selectorsOf(profileCss);
  assert.ok(profileSelectors.includes(scopedSelector), 'B: cgMsg--edited presentation lives in the profile stylesheet');
  assert.deepEqual(declarationsOf(profileCss, scopedSelector), ['border-left: 2px solid rgba(122, 182, 255, .28)', 'padding-left: 12px', 'margin-left: -14px'], 'C: declarations match the accepted baseline exactly');
  assert.equal(profileSelectors.filter((sel) => sel.includes(messageHook)).length, 1, 'D: exactly one profile rule targets the hook');
  for (const sel of profileSelectors.flatMap(cssMembersOf)) assert.ok(sel.startsWith(scope), `D: profile-root scoped member: ${sel}`);
  /* The accepted cascade order keeps the accent before the user bubble skin (equal specificity). */
  assert.ok(profileSelectors.indexOf(scopedSelector) < profileSelectors.indexOf(`${scope} .cgMsg--user`), 'C: accent ordered before the user bubble skin, as in the accepted baseline');
  assert.ok(profileSelectors.indexOf(`${scope} .cgMsg`) < profileSelectors.indexOf(scopedSelector), 'C: accent ordered after the base message skin');
  /* E: global studio.css no longer declares the accent (no fallback duplicate). */
  const studioSelectors = selectorsOf(studioCss);
  assert.equal(studioSelectors.filter((sel) => sel.includes(messageHook)).length, 0, 'E: studio.css declares no cgMsg--edited presentation');
  /* G: the edited-turn hook stays unstyled in both sheets (a state hook, not a look). */
  assert.equal(studioSelectors.filter((sel) => sel.includes(turnHook)).length, 0, 'G: no wbTurn--edited rule in studio.css');
  assert.equal(profileSelectors.filter((sel) => sel.includes(turnHook)).length, 0, 'G: no wbTurn--edited rule in the profile stylesheet');
  /* H + I: interactive Reader edit-mode integration stays global and declaration-equivalent. */
  const interactive = {
    '.wbTurn--editing .wbEditBtn': ['display: none'],
    '.wbEditWrap': null,
    '.wbReader[data-edit-mode="on"] [data-turn].wbTurn--editing': ['background:transparent', 'outline:none', 'box-shadow:none', 'border-radius:0'],
    '.wbReader[data-edit-mode="on"] [data-turn].wbTurn--editing [contenteditable="true"]': ['outline:none !important', 'caret-color:var(--wb-text, currentColor)', 'cursor:text', 'background:rgba(122,182,255,.04)', 'border-radius:6px', 'transition:background-color 180ms ease'],
    '.wbReader[data-edit-mode="on"] [data-turn].is-ribbon-selected': ['background:transparent !important'],
    '.wbReader[data-edit-mode="on"] [data-turn].is-ribbon-selected::before, .wbReader[data-edit-mode="on"] [data-turn].is-ribbon-selected::after': ['display:none !important'],
    '.wbReader[data-edit-mode="on"] [data-turn].wbTurn--editing .cgMsg--user, .wbReader[data-edit-mode="on"] [data-turn].wbTurn--editing [data-message-author-role="user"]': ['width:100% !important', 'max-width:none !important', 'background:transparent !important', 'padding:0 !important'],
    '.wbRibbonAction[data-action-id="edit-mode"][aria-pressed="true"]': null,
  };
  for (const [sel, decls] of Object.entries(interactive)) {
    assert.ok(studioSelectors.includes(sel), `H: interactive edit-mode rule stays global: ${sel}`);
    if (decls) assert.deepEqual(declarationsOf(studioCss, sel), decls, `H: declaration-equivalent: ${sel}`);
  }
  for (const token of ['wbTurn--editing', 'wbEditWrap', 'wbEditBtn', 'data-edit-mode', 'contenteditable', 'is-ribbon-selected', 'wbRibbonAction']) {
    assert.ok(!profileSelectors.some((sel) => sel.includes(token)), `I: the profile stylesheet owns no interactive edit-mode selector (${token})`);
  }
  /* Executed: the persisted edit projection still emits exactly the profile hooks. */
  const seams = vm.createContext({
    document: { createElement: (tagName) => new FakeDomElement(tagName) },
    Element: FakeDomElement, String, Number, Set, Array, Object,
    TESTID_ATTR: 'data-testid', TURN_TESTID: 'conversation-turn', TURNS_TESTID: 'conversation-turns',
    ROLE_ATTR: 'data-message-author-role', MESSAGE_ID_ATTR: 'data-message-id', TURN_ID_ATTR: 'data-turn-id', ROLES: roleContract,
    stampReplayTurnMeta: () => {},
    TURN_PROJECTION_META: new WeakMap(),
  });
  Object.assign(seams, presentationProfileGlobals(seams));
  vm.runInContext([
    extractFunction(rendererSource, 'activePresentationProfile'),
    extractFunction(rendererSource, 'normalizeRole'),
    extractFunction(rendererSource, 'getAccessibleRoleLabel'),
    extractFunction(rendererSource, 'applyTurnAccessibility'),
    extractFunction(rendererSource, 'claimReplayIdentity'),
    extractFunction(rendererSource, 'buildTurnShell'),
    extractFunction(rendererSource, 'buildMessageHost'),
    'function renderSemanticBody(bodyEl){ bodyEl.appendChild(document.createElement("p")); }',
    extractFunction(rendererSource, 'applyEditedMessageBody'),
    'this.api = { buildTurnShell, buildMessageHost, applyEditedMessageBody };',
  ].join('\n'), seams);
  const host = seams.api.buildMessageHost('assistant', 'canonical', {});
  seams.api.applyEditedMessageBody(host, 'assistant', 'edited text');
  assert.equal(host.className, `cgMsg cgMsg--assistant ${messageHook}`, 'A: edited canonical host = structural + role modifier + profile edit hook');
  const turn = seams.api.buildTurnShell('assistant', 'rich', { turnNo: 2 });
  turn.classList.add(...profile.editedTurnClasses());
  assert.equal(turn.className, `cgTurn cgTurn--assistant wbTurn wbTurn--rich wbTurn--assistant ${turnHook}`, 'F: edited rich turn carries the state hook beside the shell classes');
}

/* S3C slice F: attachment + image/media presentation. The attachment grid /
 * card / has-attachments vocabulary stays Renderer structural property (never
 * a profile hook); their presentation, the generic image rule, the provider
 * image grid and the rich media containment live in the profile stylesheet;
 * the Reader-route attachment alignment stays global. Attachment semantics,
 * accessibility and image-source safety are executed through the real seams.
 */
function validateAttachmentPresentationOwnership() {
  const scope = ':where([data-h2o-presentation-profile="chatgpt-reference"])';
  const profileCss = readRepo(PRESENTATION_CSS_REL);
  const studioCss = readRepo(STUDIO_CSS_REL);
  const context = vm.createContext({});
  const profile = installPresentationProfile(context).reference();
  /* B: attachment vocabulary is not a profile hook and has no profile helper. */
  assert.doesNotMatch(JSON.stringify(profile.hooks), /Attachment|attachments/, 'B: attachment classes are not PresentationProfile hooks');
  assert.equal(Object.keys(profile).some((k) => /attachment/i.test(k)), false, 'B: no attachment helper on the profile');
  assert.doesNotMatch(presentationProfileSource.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ''), /cgUserAttachment|has-attachments/, 'B: the profile module code carries no attachment vocabulary');
  /* A + L (executed): the real grid builder and attachment seam emit the structural classes, group semantics, alt and safe sources. */
  const seams = vm.createContext({
    document: { createElement: (tagName) => new FakeDomElement(tagName) },
    Element: FakeDomElement, String, Number, Set, Array, Object, URL,
    TESTID_ATTR: 'data-testid', TURN_TESTID: 'conversation-turn', TURNS_TESTID: 'conversation-turns',
    ROLE_ATTR: 'data-message-author-role', MESSAGE_ID_ATTR: 'data-message-id', TURN_ID_ATTR: 'data-turn-id', ROLES: roleContract,
    stampReplayTurnMeta: () => {},
    TURN_PROJECTION_META: new WeakMap(),
    removeNativeUserAttachmentImages: () => {},
  });
  Object.assign(seams, presentationProfileGlobals(seams));
  vm.runInContext([
    extractFunction(rendererSource, 'activePresentationProfile'),
    extractFunction(rendererSource, 'normalizeRole'),
    extractFunction(rendererSource, 'getAccessibleRoleLabel'),
    extractFunction(rendererSource, 'applyTurnAccessibility'),
    extractFunction(rendererSource, 'claimReplayIdentity'),
    extractFunction(rendererSource, 'buildTurnShell'),
    extractFunction(rendererSource, 'buildMessageHost'),
    extractFunction(rendererSource, 'normalizeSafeImageSrc'),
    extractFunction(rendererSource, 'normalizeImageAlt'),
    extractFunction(rendererSource, 'buildUserAttachmentGrid'),
    extractFunction(rendererSource, 'attachUserAttachmentsToTurn'),
    'this.api = { buildTurnShell, buildMessageHost, buildUserAttachmentGrid, attachUserAttachmentsToTurn };',
  ].join('\n'), seams);
  const turn = seams.api.buildTurnShell('user', 'canonical', { turnNo: 1 });
  const host = seams.api.buildMessageHost('user', 'canonical', {}); turn.appendChild(host);
  seams.api.attachUserAttachmentsToTurn(turn, host, [
    { kind: 'image', thumbnailSrc: 'https://example.test/a.png', alt: 'first', captureStatus: 'linked', naturalWidth: 640, naturalHeight: 480 },
    { kind: 'image', thumbnailSrc: 'data:image/png;base64,iVBORw0KGgo=', alt: null, captureStatus: 'captured' },
    { kind: 'image', thumbnailSrc: 'javascript:alert(1)', alt: 'unsafe' },
    { kind: 'image', thumbnailSrc: 'data:text/html;base64,PHN2Zz4=', alt: 'unsafe data' },
    { kind: 'file', thumbnailSrc: 'https://example.test/not-an-image.pdf' },
  ]);
  assert.equal(turn.classList.contains('cgTurn--has-attachments'), true, 'A: has-attachments state hook stamped structurally');
  assert.equal(turn.children.length, 2, 'A: grid mounts beside the host'); assert.equal(turn.children[1], host, 'A: grid precedes the host (insertion order)');
  const grid = turn.children[0];
  assert.equal(grid.className, 'cgUserAttachmentGrid', 'A: structural grid class');
  assert.equal(grid.getAttribute('role'), 'group', 'L: attachment collection is a group'); assert.equal(grid.getAttribute('aria-label'), 'Attached images', 'L: group label');
  assert.equal(grid.children.length, 2, 'L: unsafe and non-image entries are dropped; safe https + raster data: kept');
  for (const card of grid.children) { assert.equal(card.className, 'cgUserAttachmentCard', 'A: structural card class'); assert.equal(card.children.length, 1); assert.equal(card.children[0].tagName, 'IMG'); }
  assert.equal(grid.children[0].dataset.captureStatus, 'linked'); assert.equal(grid.children[1].dataset.captureStatus, 'captured');
  assert.equal(grid.children[0].children[0].src, 'https://example.test/a.png'); assert.equal(grid.children[0].children[0].alt, 'first');
  assert.equal(grid.children[1].children[0].src, 'data:image/png;base64,iVBORw0KGgo='); assert.equal(grid.children[1].children[0].alt, '', 'L: null alt normalizes to an empty alt');
  assert.equal(grid.children[0].children[0].loading, 'lazy'); assert.equal(grid.children[0].children[0].decoding, 'async');
  assert.equal(grid.children[0].children[0].dataset.naturalWidth, '640'); assert.equal(grid.children[0].children[0].dataset.naturalHeight, '480');
  assert.equal(seams.api.buildUserAttachmentGrid([{ kind: 'image', thumbnailSrc: 'javascript:alert(1)' }]), null, 'L: an all-unsafe set yields no grid');
  {
    const bare = seams.api.buildTurnShell('user', 'canonical', { turnNo: 2 }); const bareHost = seams.api.buildMessageHost('user', 'canonical', {}); bare.appendChild(bareHost);
    seams.api.attachUserAttachmentsToTurn(bare, bareHost, []);
    assert.equal(bare.classList.contains('cgTurn--has-attachments'), false, 'A: no attachments -> no state hook'); assert.equal(bare.children.length, 1);
  }
  /* L (source invariants of the seam not executable in the fake DOM): native attachment removal keeps its accepted exclusions. */
  const removal = extractFunction(rendererSource, 'removeNativeUserAttachmentImages');
  assert.match(removal, /img\.closest\("\.cgUserAttachmentGrid"\)\) return;/, 'L: H2O attachment grid images are never removed');
  assert.match(removal, /img\.closest\(assistantRoleSelector\)\) return;/, 'L: assistant images are never removed');
  assert.match(removal, /\[data-message-attachment-id\], \[data-testid="image-asset"\], button, \[role="button"\]/, 'L: provider attachment holders are the removal targets');
  /* C/D/E/F/G/I/H: presentation ownership relation between the Renderer vocabulary and the two stylesheets. */
  const profileRules = cssRulesOf(profileCss); const studioRules = cssRulesOf(studioCss);
  const decls = (sel) => { const hit = profileRules.find((r) => r.selector === sel); return hit ? hit.decls : null; };
  assert.deepEqual(decls(`${scope} .cgUserAttachmentGrid`), ['--cg-user-attachment-size:112px', 'display:grid', 'grid-template-columns:repeat(auto-fit, minmax(var(--cg-user-attachment-size), var(--cg-user-attachment-size)))', 'justify-content:end', 'gap:8px', 'width:fit-content', 'max-width:min(100%, calc((var(--cg-user-attachment-size) * 3) + 16px))', 'margin:0 0 8px auto'], 'C: attachment grid presentation is profile-owned, verbatim');
  assert.deepEqual(decls(`${scope} .cgUserAttachmentCard`), ['width:var(--cg-user-attachment-size)', 'height:var(--cg-user-attachment-size)', 'overflow:hidden', 'border-radius:18px', 'border:1px solid rgba(255,255,255,.12)', 'background:rgba(255,255,255,.08)'], 'C: attachment card presentation is profile-owned, verbatim');
  assert.deepEqual(decls(`${scope} .cgUserAttachmentCard img`), ['display:block', 'width:100%', 'height:100%', 'max-width:none', 'object-fit:cover', 'border-radius:inherit'], 'C: attachment card image presentation is profile-owned, verbatim');
  assert.deepEqual(decls(`${scope} .wbRichRoot :where(img, video, canvas, svg)`), ['max-width:100%'], 'F: rich media containment is profile-owned, verbatim');
  const generic = profileRules.find((r) => cssMembersOf(r.selector).includes(`${scope} .cgMsgBody img`));
  assert.ok(generic, 'D/E: the generic image rule (incl. canonical cgMsgBody img) is profile-owned');
  assert.deepEqual(cssMembersOf(generic.selector).map((m) => m.replace(`${scope} `, '')), ['.dalle-image-container img', '[data-testid="image-asset"] img', '.wbRichRoot img', '.cgMsgBody img', '[data-message-author-role] img'], 'D/E: generic image members complete and scoped');
  assert.deepEqual(generic.decls, ['max-width: 100%', 'height: auto', 'border-radius: 8px']);
  assert.ok(profileRules.some((r) => r.selector === `${scope} .wbRichRoot .grid:has(> img), ${scope} .wbRichRoot [data-message-attachment-id]:has(> img)`), 'G: provider rich image grid presentation is profile-owned');
  assert.ok(profileRules.indexOf(generic) < profileRules.findIndex((r) => r.selector === `${scope} .cgUserAttachmentCard img`), 'generic image presentation precedes the attachment-card image specialization');
  for (const sheet of [profileRules, studioRules]) assert.equal(sheet.filter((r) => r.selector.includes('.cgTurn--has-attachments')).length, 0, 'I: cgTurn--has-attachments is a structural state hook without presentation');
  const globalAttachment = studioRules.filter((r) => cssMembersOf(r.selector).some((m) => /cgUserAttachment/.test(m)));
  assert.equal(globalAttachment.length, 1, 'H: exactly one attachment rule stays global');
  assert.ok(cssMembersOf(globalAttachment[0].selector).every((m) => m.startsWith('body[data-route="reader"]')), 'H: the global attachment rule is the Reader-route alignment');
  assert.ok(globalAttachment[0].decls.every((d) => /!important$/.test(d)), 'H: Reader-route alignment keeps !important');
  assert.equal(profileRules.filter((r) => r.selector.includes('body[data-route="reader"]')).length, 0, 'H: no Reader-route rule in the profile stylesheet');
  /* S3C slice G (hygiene): dead presentation removed and provably unproducible.
   * A/C: no executable source emits cgMsg--rich and the rich message modifiers
   * stay empty; B: no .cgMsg--rich rule in either sheet; D: the user-turn
   * attachment fallback is gone while the Renderer keeps stripping native user
   * images at extraction (so nothing can reach such a rule). */
  const codeOnly = (src) => src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, '');
  for (const [name, src] of [['chat-renderer', rendererSource], ['studio.js', studioSource], ['presentation-profile', presentationProfileSource], ['content-renderer', readRepo(CONTENT_RENDERER_REL)]]) {
    assert.doesNotMatch(codeOnly(src), /cgMsg--rich/, `A: ${name} emits no cgMsg--rich`);
  }
  for (const role of ['user', 'assistant', 'system', 'tool']) assert.deepEqual([...profile.messageClasses(role, 'rich')], [], `C: rich message modifier stays empty (${role})`);
  for (const [name, sheet] of [['profile', profileRules], ['studio.css', studioRules]]) {
    assert.equal(sheet.filter((r) => cssMembersOf(r.selector).some((m) => m.includes('.cgMsg--rich'))).length, 0, `B: no .cgMsg--rich rule in ${name}`);
    assert.equal(sheet.filter((r) => cssMembersOf(r.selector).some((m) => /\.cgTurn--user (\.grid|\[data-message-attachment-id\]):has\(img\)/.test(m))).length, 0, `D: no user-turn attachment fallback rule in ${name}`);
  }
  assert.match(extractFunction(rendererSource, 'extractRichTurnContentHtml'), /if \(normalizeRole\(ownerRole\) === \(ROLES\.USER \|\| "user"\)\) removeNativeUserAttachmentImages\(turnEl\);/, 'D: rich user replay still strips native attachment images at extraction (the fallback stays unreachable)');
  assert.ok(profileRules.some((r) => r.selector === `${scope} .wbRichRoot .grid:has(> img), ${scope} .wbRichRoot [data-message-attachment-id]:has(> img)`), 'F: the live provider rich image grid rule is preserved');
}

/* S3C slice H: final Renderer / Reader CSS boundary. Executed: every
 * successful rich user host carries exactly one H2O-owned bubble with the
 * profile marker (marker present, absent, nested, unrelated duplicates), so the
 * former no-bubble user host fallback E can never match a rich user host; the
 * rich path fails the transcript closed when adoption fails. Static: E is gone
 * from both sheets, H1 / provider outer structure / replay safety stay global
 * and out of the profile sheet, the profile sheet is unchanged at 1.0.6. */
function validateFinalRendererCssBoundary() {
  const scope = ':where([data-h2o-presentation-profile="chatgpt-reference"])';
  const profileCss = readRepo(PRESENTATION_CSS_REL);
  const studioCss = readRepo(STUDIO_CSS_REL);
  const context = vm.createContext({});
  const profile = installPresentationProfile(context).reference();
  const marker = profile.userBubbleMarkerClass();
  assert.equal(marker, 'user-message-bubble-color');
  /* A (executed): the real adoption seam on four fragment shapes. */
  const seams = vm.createContext({
    document: { createElement: (tagName) => new FakeDomElement(tagName) },
    Element: FakeDomElement, String, Number, Set, Array, Object,
    TESTID_ATTR: 'data-testid', TURN_TESTID: 'conversation-turn', TURNS_TESTID: 'conversation-turns',
    ROLE_ATTR: 'data-message-author-role', MESSAGE_ID_ATTR: 'data-message-id', TURN_ID_ATTR: 'data-turn-id', ROLES: roleContract,
    stampReplayTurnMeta: () => {},
    TURN_PROJECTION_META: new WeakMap(),
  });
  Object.assign(seams, presentationProfileGlobals(seams));
  vm.runInContext([
    extractFunction(rendererSource, 'activePresentationProfile'),
    extractFunction(rendererSource, 'normalizeRole'),
    extractFunction(rendererSource, 'getAccessibleRoleLabel'),
    extractFunction(rendererSource, 'applyTurnAccessibility'),
    extractFunction(rendererSource, 'claimReplayIdentity'),
    extractFunction(rendererSource, 'buildTurnShell'),
    extractFunction(rendererSource, 'buildMessageHost'),
    extractFunction(rendererSource, 'buildRichUserBubbleShell'),
    extractConst(rendererSource, 'USER_BUBBLE_H2O_CLASSES'),
    extractFunction(rendererSource, 'adoptRichUserBubble'),
    'this.api = { buildMessageHost, adoptRichUserBubble };',
  ].join('\n'), seams);
  const el = (tag, cls) => { const node = new FakeDomElement(tag); if (cls) node.className = cls; return node; };
  const shapes = {
    markerPresent: () => { const wrap = el('div', 'flex w-full flex-col'); const provider = el('div', `relative rounded-3xl ${marker}`); provider.appendChild(new FakeTextNode('hi')); wrap.appendChild(provider); return [wrap]; },
    markerAbsent: () => { const wrap = el('div', 'flex w-full flex-col'); const inner = el('div', 'relative rounded-3xl'); inner.appendChild(new FakeTextNode('no marker')); wrap.appendChild(inner); return [wrap]; },
    nestedMarkers: () => { const outer = el('div', marker); const inner = el('div', marker); inner.appendChild(new FakeTextNode('nested')); outer.appendChild(inner); return [outer]; },
    twoUnrelatedMarkers: () => { const a = el('div', marker); a.appendChild(new FakeTextNode('a')); const b = el('div', marker); b.appendChild(new FakeTextNode('b')); return [a, b]; },
    plainText: () => [new FakeTextNode('bare text')],
  };
  for (const [name, build] of Object.entries(shapes)) {
    const host = seams.api.buildMessageHost('user', 'rich', { seenMessageIds: new Set(), seenTurnIds: new Set(), messageId: 'm-' + name, turnId: 't-' + name });
    for (const node of build()) host.appendChild(node);
    assert.equal(seams.api.adoptRichUserBubble(host), true, `A: adoption succeeds (${name})`);
    const bubbles = host.querySelectorAll(`.${marker}`);
    assert.equal(bubbles.length, 1, `A: exactly one marked element after adoption (${name})`);
    assert.equal(bubbles[0].className, `cgBubble cgBubble--user ${marker}`, `A: the marked element is the H2O-owned bubble (${name})`);
    assert.equal(host.textContent, build().map((n) => n.textContent ?? '').join('') || host.textContent, `A: content preserved (${name})`);
  }
  assert.match(rendererSource, /if \(role === "user" && !adoptRichUserBubble\(messageEl\)\) return fallbackResult;/, 'A: a rich user host that cannot adopt a bubble fails the transcript closed (no bare rich user host is ever mounted)');
  assert.match(extractFunction(rendererSource, 'adoptRichUserBubble'), /const rail = document\.createElement\("div"\);\s*rail\.className = "cgBubbleRail";/, 'A: the no-marker path wraps content in the H2O rail + bubble');
  /* B/C: the dead no-bubble fallback is gone from both sheets. */
  const DEAD = /:not\(:has\(\.user-message-bubble-color\)\)/;
  const studioRules = cssRulesOf(studioCss), profileRules = cssRulesOf(profileCss);
  assert.equal(studioRules.filter((r) => cssMembersOf(r.selector).some((m) => DEAD.test(m) && !m.startsWith('body[data-route="reader"]'))).length, 0, 'B: the no-bubble user host fallback (and its narrow member) is gone from studio.css');
  assert.equal(profileRules.filter((r) => DEAD.test(r.selector)).length, 0, 'C: no no-bubble fallback in the profile stylesheet');
  /* D/E: H1 stays global, verbatim, and out of the profile. */
  const H1 = '.wbRichRoot .cgTurn--user[data-testid^="conversation-turn"]';
  assert.deepEqual(cssDeclarationsOf(studioCss, H1), ['display: flex', 'flex-direction: column', 'align-items: flex-end', 'justify-content: flex-start'], 'D: H1 rich user-turn placement stays global, verbatim (Renderer replay structural compatibility)');
  assert.equal(profileRules.filter((r) => r.selector.includes(H1)).length, 0, 'E: H1 is not in the profile stylesheet');
  /* F/G: Reader-route rich integration stays global and out of the profile. */
  /* Reader-route rich alignment rules (other-lane cgxui feature rules under the same route are not part of this set). */
  const readerRich = studioRules.filter((r) => cssMembersOf(r.selector).some((m) => m.startsWith('body[data-route="reader"]') && /wbRichRoot|cgMsg--user|cgUserAttachmentGrid/.test(m)) && !/data-cgxui/.test(r.selector));
  assert.ok(readerRich.length >= 6, `F: Reader-route rich integration rules stay global (found ${readerRich.length})`);
  assert.ok(readerRich.every((r) => r.decls.every((d) => /!important$/.test(d)) || r.selector.includes('.cgScroll >')), 'F: Reader-route rich alignment keeps its !important behaviour');
  assert.equal(profileRules.filter((r) => /data-route="reader"|^\.wbReader\b/.test(r.selector)).length, 0, 'G: no Reader-route / Reader integration rule in the profile stylesheet');
  assert.ok(studioRules.some((r) => r.selector === '.wbReader [data-turn].is-in-collapsed-section' && r.decls.includes('display:none')), 'F: Reader collapsed-section rule still global');
  /* H: provider outer structure stays global; I: replay interaction safety stays global and out of the profile. */
  for (const sel of ['.text-message', '.agent-turn', '.user-turn', '[data-testid^="conversation-turn"]', '.result-streaming']) assert.ok(studioRules.some((r) => cssMembersOf(r.selector).includes(sel)), `H: provider outer-structure rule stays global: ${sel}`);
  assert.deepEqual(cssDeclarationsOf(studioCss, '.wbRichRoot :where(button, input, textarea, select, summary)'), ['pointer-events:none'], 'I: replay interaction safety stays global, verbatim');
  assert.equal(profileRules.filter((r) => /:where\(button, input, textarea, select, summary\)|^\.text-message$|^\.agent-turn$|^\.user-turn$/.test(r.selector.replace(`${scope} `, ''))).length, 0, 'H/I: structural and safety rules are absent from the profile stylesheet');
  /* K: profile stylesheet unchanged at 1.0.6 and referenced as such. */
  assert.match(profileCss, /@version 1\.0\.6\b/, 'K: profile stylesheet version 1.0.6');
  assert.match(studioHtmlSource, /chatgpt-reference\.v1\.css\?v=1\.0\.6"/, 'K: studio.html references the 1.0.6 profile stylesheet');
  /* L: the Renderer still owns the structural vocabulary the boundary relies on. */
  assert.match(rendererSource, /turn\.className = \["cgTurn", `cgTurn--\$\{role\}`, \.\.\.activePresentationProfile\(\)\.turnClasses\(role, mode\)\]\.join\(" "\);|cgTurn--\$\{role\}/, 'L: the Renderer stamps cgTurn--<role> structurally');
}

/* M03 P4 S4A T8 slice A - Semantic Index shell foundation.
 *
 * Executes the REAL index module (and the real Render IR for the semantic
 * path) over FakeDomElement H2O shells, and pins the Renderer integration:
 * one frozen read-only index per render result, projection-local keys that
 * reuse Render IR identity, source ids as metadata, deterministic path /
 * ordinal fallbacks, no navigation or mutation API, no new DOM attributes. */
function validateSemanticIndexFoundation() {
  /* Records are built in the module's VM realm, so structural equality is compared as JSON (strict deepEqual also compares prototypes). */
  const deep = (actual, expected, message) => assert.equal(JSON.stringify(actual), JSON.stringify(expected), message);
  const indexSource = readRepo(SEMANTIC_INDEX_REL);
  const irSource = readRepo(RENDER_IR_REL);
  const packSource = readRepo(PACK_STUDIO_REL);
  /* A. Module contract: frozen, versioned, factory-only, no global current index, no DOM/persistence/navigation authority. */
  assert.match(indexSource, /^\/\/ @version 0\.2\.0-m03-s4a\n"use strict";/, 'A: module version comment convention');
  const context = vm.createContext({});
  vm.runInContext(`${irSource}\n${indexSource}\nthis.__ir = this.H2O.Studio.Renderer.renderIR; this.__ix = this.H2O.Studio.Renderer.semanticIndex;`, context);
  const api = context.__ix; const ir = context.__ir;
  assert.equal(api.__installed, true); assert.equal(api.__version, '0.2.0-m03-s4a'); assert.equal(api.schema, 'h2o.renderer.semantic-index'); assert.equal(api.schemaVersion, 1);
  assert.equal(Object.isFrozen(api), true, 'A: module namespace frozen');
  deep(Object.keys(api).sort(), ['__installed', '__version', 'bases', 'createShellIndex', 'kinds', 'schema', 'schemaVersion'], 'A: factory-only module surface');
  deep([...api.kinds], ['conversation', 'turn', 'message', 'block', 'text'], 'A: the five S4A kinds');
  const codeOnly = indexSource.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(codeOnly, /setAttribute|innerHTML|localStorage|sessionStorage|indexedDB|MutationObserver|ResizeObserver|IntersectionObserver|scrollIntoView|scrollTo\(|\.focus\(|Date\.now|Math\.random|randomUUID|outerHTML|addEventListener/, 'A: the index never mutates the DOM, persists, observes, navigates or uses non-deterministic identity');
  assert.doesNotMatch(codeOnly, /currentSemanticIndex|Renderer\.current/, 'A: no singleton current index');
  assert.doesNotMatch(codeOnly, /^  (const|let|var) \w+ = new (Map|WeakMap|Set)\(/m, 'A: no module-level registry (maps live inside createShellIndex only)');
  /* Fake H2O shells as the Renderer emits them. */
  const shell = (role, opts = {}) => {
    const turn = new FakeDomElement('article'); turn.className = `cgTurn cgTurn--${role} wbTurn wbTurn--fallback wbTurn--${role}`; turn.setAttribute('data-turn', role);
    if (opts.turnNo) turn.setAttribute('data-h2o-turn-no', String(opts.turnNo));
    const host = new FakeDomElement('div'); host.className = `cgMsg cgMsg--${role}`; host.setAttribute('data-message-author-role', role);
    if (opts.messageId) host.setAttribute('data-message-id', opts.messageId);
    if (opts.turnId) host.setAttribute('data-turn-id', opts.turnId);
    if (opts.grid) { const grid = new FakeDomElement('div'); grid.className = 'cgUserAttachmentGrid'; turn.appendChild(grid); }
    turn.appendChild(host);
    return { turn, host, meta: Object.freeze({ role, mode: 'canonical', turnNo: opts.turnNo || 0, messageId: opts.messageId || '', turnId: opts.turnId || '' }) };
  };
  const frame = (shells) => { const root = new FakeDomElement('div'); root.className = 'cgFrame'; const turnsEl = new FakeDomElement('section'); turnsEl.className = 'cgScroll wbRichRoot'; for (const s of shells) turnsEl.appendChild(s.turn); root.appendChild(turnsEl); const meta = new Map(shells.map((s) => [s.turn, s.meta])); return { root, turnsEl, describeTurn: (el) => meta.get(el) || null }; };
  const build = (shells, extra = {}) => { const f = frame(shells); return api.createShellIndex({ root: f.root, turnsEl: f.turnsEl, renderMode: 'canonical', source: { chatId: 'chat-1', snapshotId: 'snap-1' }, semanticConversation: null, describeTurn: f.describeTurn, ...extra }); };
  /* B/C/N: instance shape - read-only, frozen, no navigation or mutation methods. */
  const shellsA = [shell('user', { turnNo: 1, messageId: 'm-u1', turnId: 't-1', grid: true }), shell('assistant', { turnNo: 2, messageId: 'm-a1', turnId: 't-2' }), shell('system', { turnNo: 3, messageId: 'm-s1' }), shell('tool', { turnNo: 4 })];
  const ixA = build(shellsA);
  assert.equal(Object.isFrozen(ixA), true, 'C: index instance frozen');
  deep(Object.keys(ixA).sort(), ['basis', 'blocks', 'getBlock', 'getConversation', 'getGeometry', 'getMessage', 'getText', 'getTurn', 'messages', 'renderMode', 'schema', 'schemaVersion', 'semanticCorrespondenceLost', 'texts', 'turns', 'version'], 'N: read-only instance API only');
  for (const forbidden of ['register', 'set', 'delete', 'clear', 'update', 'mutate', 'append', 'replace', 'scrollTo', 'scrollIntoView', 'focus', 'select', 'highlight', 'decorate', 'navigate', 'selectTurn']) assert.equal(forbidden in ixA, false, `N: no ${forbidden} on the index`);
  assert.equal(Object.isFrozen(ixA.turns()) && Object.isFrozen(ixA.messages()), true, 'C: record arrays frozen');
  for (const rec of [ixA.getConversation(), ...ixA.turns(), ...ixA.messages()]) { assert.equal(Object.isFrozen(rec), true, 'C: records frozen'); if (rec.sourceRef) assert.equal(Object.isFrozen(rec.sourceRef), true, 'C: sourceRef frozen'); }
  /* D/E/G/I/J: source keys, source-message turn fallback, path fallback, uniqueness, targets, ownerRef stays null on the source path. */
  assert.equal(ixA.getConversation().projectionKey, 'conversation:source:snap-1'); deep(ixA.getConversation().sourceRef, { chatId: 'chat-1', snapshotId: 'snap-1' }); assert.equal(ixA.getConversation().ownerRef, null, 'G: source ids never become ownerRef'); assert.equal(ixA.getConversation().target.className, 'cgFrame', 'J: conversation target is the cgFrame root'); assert.equal(ixA.getConversation().target.children[0].children[0], shellsA[0].turn, 'J: the root owns the indexed turn shells');
  deep(ixA.turns().map((t) => t.projectionKey), ['turn:source:t-1', 'turn:source:t-2', 'turn:source-message:m-s1', 'turn:path:3'], 'D/I: turn keys - source, source-message fallback, path fallback');
  deep(ixA.messages().map((m) => m.projectionKey), ['message:source:m-u1', 'message:source:m-a1', 'message:source:m-s1', 'message:path:3'], 'D/I: message keys');
  deep(ixA.turns().map((t) => t.role), ['user', 'assistant', 'system', 'tool'], 'all four roles indexed');
  deep(ixA.turns().map((t) => [t.ordinal, t.turnNo]), [[0, 1], [1, 2], [2, 3], [3, 4]]);
  deep(ixA.messages()[0].sourceRef, { turnId: 't-1', messageId: 'm-u1' }, 'G: source ids are sourceRef metadata'); assert.equal(ixA.messages()[0].ownerRef, null); assert.equal(ixA.messages()[3].sourceRef, null);
  assert.equal(ixA.getTurn('turn:source:t-1').target, shellsA[0].turn, 'J: turn target is the H2O turn shell'); assert.equal(ixA.getMessage('message:source:m-u1').target, shellsA[0].host, 'J: message target is the cgMsg host, not the attachment grid');
  assert.equal(ixA.getTurn('turn:source:t-1').messageKey, 'message:source:m-u1'); assert.equal(ixA.getMessage('message:source:m-u1').turnKey, 'turn:source:t-1');
  deep(ixA.getConversation().turnKeys, ixA.turns().map((t) => t.projectionKey));
  const allKeys = [ixA.getConversation().projectionKey, ...ixA.turns().map((t) => t.projectionKey), ...ixA.messages().map((m) => m.projectionKey)];
  assert.equal(new Set(allKeys).size, allKeys.length, 'E: projection keys unique');
  /* K: unknown / cross-kind keys return null, never throw. */
  for (const bad of ['nope', '', null, undefined, 42, 'message:source:m-u1']) assert.equal(ixA.getTurn(bad), null); for (const bad of ['nope', 'turn:source:t-1']) assert.equal(ixA.getMessage(bad), null);
  assert.equal(ixA.getGeometry('nope'), null, 'K: unknown geometry null');
  /* M: fake targets are never connected to a live document -> geometry null without throwing. */
  assert.equal(ixA.getGeometry('turn:source:t-1'), null, 'M: unmeasurable (detached / no live document) target -> null');
  /* B/D: determinism + distinct instances. */
  const ixA2 = build(shellsA);
  assert.notEqual(ixA2, ixA, 'B: each build is a distinct instance'); deep(ixA2.turns().map((t) => t.projectionKey), ixA.turns().map((t) => t.projectionKey), 'D: deterministic keys for equivalent input');
  /* H: duplicate source ids reaching the index never overwrite; later duplicates get a deterministic ordinal suffix and keep their sourceRef. */
  const shellsDup = [shell('user', { turnNo: 1, messageId: 'dup', turnId: 'tdup' }), shell('assistant', { turnNo: 2, messageId: 'dup', turnId: 'tdup' }), shell('user', { turnNo: 3, messageId: 'dup' })];
  const ixDup = build(shellsDup);
  deep(ixDup.messages().map((m) => m.projectionKey), ['message:source:dup', 'message:source:dup:ordinal:1', 'message:source:dup:ordinal:2'], 'H: collision-safe message keys');
  deep(ixDup.turns().map((t) => t.projectionKey), ['turn:source:tdup', 'turn:source:tdup:ordinal:1', 'turn:source-message:dup'], 'H: collision-safe turn keys');
  assert.equal(ixDup.messages().length, 3, 'H: no record dropped'); deep(ixDup.messages()[1].sourceRef, { turnId: 'tdup', messageId: 'dup' }, 'H: sourceRef preserved on the duplicate');
  assert.equal(ixDup.getMessage('message:source:dup').target, shellsDup[0].host, 'H: first record not overwritten');
  /* F: semantic path - Render IR renderKeys / ownerRefs are reused verbatim; turns wrap the message key. */
  const conversation = ir.createConversation({ ownerRef: { type: 'h2o.savedChat.snapshot', id: 'chat-v3', version: 'snap-v3' }, messages: [ { role: 'user', ownerRef: { type: 'h2o.savedChat.message', id: 'v3-u1' }, blocks: [] }, { role: 'assistant', ownerRef: { type: 'h2o.savedChat.message', id: 'v3-a1', anchor: 'v3-u1' }, blocks: [] } ] });
  const shellsV3 = [shell('user', { turnNo: 1, messageId: 'v3-u1' }), shell('assistant', { turnNo: 2, messageId: 'v3-a1' })];
  const ixV3 = build(shellsV3, { semanticConversation: conversation, source: { chatId: 'chat-v3', snapshotId: 'snap-v3' } });
  assert.equal(ixV3.basis, 'semantic'); assert.equal(ixV3.semanticCorrespondenceLost, false);
  assert.equal(ixV3.getConversation().projectionKey, conversation.renderKey, 'F: conversation key is the Render IR renderKey'); deep(ixV3.getConversation().ownerRef, conversation.ownerRef, 'F: conversation ownerRef reused');
  deep(ixV3.messages().map((m) => m.projectionKey), conversation.messages.map((m) => m.renderKey), 'F: message keys are the Render IR renderKeys'); deep(ixV3.messages().map((m) => m.ownerRef), conversation.messages.map((m) => m.ownerRef), 'F: message ownerRefs reused');
  deep(ixV3.turns().map((t) => t.projectionKey), conversation.messages.map((m) => `turn:semantic:${encodeURIComponent(m.renderKey)}`), 'F: turn keys wrap the message renderKey by kind');
  deep(ixV3.turns().map((t) => t.ownerRef), [null, null], 'G: turns carry no owner identity of their own'); deep(ixV3.messages()[0].sourceRef, { messageId: 'v3-u1' }, 'G: v3 ids stay sourceRef metadata');
  /* One-to-one correspondence is required; a mismatch falls back to source/path identity instead of guessing ownership. */
  const ixLost = build(shellsV3.slice(0, 1), { semanticConversation: conversation });
  assert.equal(ixLost.semanticCorrespondenceLost, true); assert.equal(ixLost.basis, 'source'); assert.equal(ixLost.messages()[0].projectionKey, 'message:source:v3-u1'); assert.equal(ixLost.messages()[0].ownerRef, null);
  /* Renderer integration (static): one index per render result, resolved from the installed module, projection meta kept off the DOM. */
  const renderFn = extractFunction(rendererSource, 'render') + '\n' + extractFunction(rendererSource, 'renderWithCollector');
  assert.match(renderFn, /const semanticIndex = activeSemanticIndexModule\(\)\.createShellIndex\(\{/, 'render() builds the index through the installed module');
  assert.match(renderFn, /semanticConversation: renderMode === "canonical" \? semanticConversation : null/, 'the semantic conversation reaches the index only on the canonical (semantic-v3) path');
  assert.match(renderFn, /semanticSource: semanticConversation \? "savedChatSnapshotV3" : "",\s*semanticIndex,\s*\};/, 'the index is returned additively as semanticIndex');
  assert.match(extractFunction(rendererSource, 'activeSemanticIndexModule'), /no embedded index fallback exists/, 'no embedded index fallback');
  assert.match(rendererSource, /const TURN_PROJECTION_META = new WeakMap\(\);/, 'projection meta lives in a WeakMap beside the shells');
  assert.match(extractFunction(rendererSource, 'buildTurnShell'), /TURN_PROJECTION_META\.set\(turn, Object\.freeze\(\{/, 'buildTurnShell records frozen projection meta');
  assert.doesNotMatch(rendererSource, /currentSemanticIndex|data-h2o-projection|data-h2o-turn-key|data-h2o-message-key|data-h2o-block-key/, 'O: no mutable current index and no new projection DOM attributes');
  assert.doesNotMatch(extractFunction(rendererSource, 'buildTurnShell'), /setAttribute\("data-h2o-(?!turn-no|create-time)/, 'O: buildTurnShell emits no new data-h2o attributes');
  /* Admission: studio.html + both pack lists carry the module once, after semantic ingress and before the profile / renderers. */
  const refs = [...studioHtmlSource.matchAll(/<script src="\.\/([^"?]+)(?:\?[^"]*)?"><\/script>/g)].map((m) => m[1]);
  assert.equal(refs.filter((r) => r === 'renderer/semantic/semantic-index.v1.js').length, 1, 'studio.html admits the index module exactly once');
  assert.ok(refs.indexOf('renderer/semantic/semantic-index.v1.js') > refs.indexOf('renderer/semantic/semantic-ingress.v1.js') && refs.indexOf('renderer/semantic/semantic-index.v1.js') < refs.indexOf('renderer/presentation/presentation-profile.v1.js') && refs.indexOf('renderer/semantic/semantic-index.v1.js') < refs.indexOf('renderer/chat-renderer.studio.js'), 'index module loads after semantic ingress and before its consumers');
  assert.equal((packSource.match(/"renderer\/semantic\/semantic-index\.v1\.js",/g) || []).length, 2, 'pack-studio carries the module in both source and output lists');
}

/* M03 P4 S4A T8 slice B - content projections (block / text).
 *
 * Executes the REAL ContentRenderer with a fake document that hands out
 * FakeDomElement / FakeTextNode nodes, so the projection seam is proven on the
 * renderer that ships: one pre-order `block` report per non-text Render IR
 * node carrying the element it returned, one `text` report per text node
 * carrying the Text node itself (before mark wrappers), no extra wrapper, no
 * attribute. Then the REAL index folds those reports into block / text
 * records scoped by the parent message key. The chat-renderer integration is
 * pinned statically: normalized Render IR blocks reach the ContentRenderer,
 * bodies report through a private per-render collector, and the public
 * applyEditedMessageBody signature is unchanged. */
function validateSemanticIndexContentProjections() {
  const deep = (actual, expected, message) => assert.equal(JSON.stringify(actual), JSON.stringify(expected), message);
  const indexSource = readRepo(SEMANTIC_INDEX_REL);
  const irSource = readRepo(RENDER_IR_REL);
  const contentSource = readRepo(CONTENT_RENDERER_REL);
  /* A/B: module contract advanced additively. */
  const context = vm.createContext({});
  vm.runInContext(`${irSource}\n${indexSource}\nthis.__ir = this.H2O.Studio.Renderer.renderIR; this.__ix = this.H2O.Studio.Renderer.semanticIndex;`, context);
  const api = context.__ix; const ir = context.__ir;
  assert.equal(api.__version, '0.2.0-m03-s4a', 'B: index API version advanced for content projections');
  deep([...api.kinds], ['conversation', 'turn', 'message', 'block', 'text'], 'A: kinds include block + text');
  assert.equal(api.bases.RENDER_IR, 'render-ir', 'a Render IR basis token is exported');
  /* ContentRenderer seam (static): optional context hook, no public registry, text target reported before marks, no wrapper or attribute for indexing. */
  assert.match(contentSource, /^\/\/ @version 1\.1\.0\n"use strict";/, 'ContentRenderer version comment advanced');
  assert.match(contentSource, /function projectionSinkOf\(context\) \{\s*const sink = context && context\.projectionSink;\s*return typeof sink === "function" \? sink : null;/, 'the sink is an OPTIONAL render-context function');
  assert.match(contentSource, /const sink = block\.kind === "text" \? null : projectionSinkOf\(ctx\);\s*const report = sink \? \{ projection: "block", block, target: null \} : null;\s*if \(report\) sink\(report\);\s*const node = renderer\(block, ctx\);\s*if \(report\) report\.target = node;/, 'D: one pre-order block report per non-text node, completed with the returned element');
  assert.match(contentSource, /register\("text", \(block, context\) => \{\s*(?:\/\*[\s\S]*?\*\/\s*)?const node = textNode\(context, block\.text\);\s*const sink = projectionSinkOf\(context\);\s*if \(sink\) sink\(\{ projection: "text", block, target: node \}\);\s*return applyMarks\(node, block\.marks, context\);/, 'E/F/G: the text report carries the Text node itself and marks still wrap that same node - no wrapper element');
  assert.doesNotMatch(contentSource.replace(/\/\*[\s\S]*?\*\//g, ' '), /projectionSink[^\n]*setAttribute|data-h2o-projection|data-h2o-block-key|data-h2o-text-key/, 'U: the seam emits no DOM attribute');
  const exported = /Renderer\.contentRenderer = Object\.freeze\(\{([\s\S]*?)\}\);/.exec(contentSource)[1];
  assert.doesNotMatch(exported, /projection|sink|register\w+Projection/i, 'the seam is not part of the public ContentRenderer API');
  /* Executed: the real ContentRenderer over a fake document. */
  const doc = {
    createElement: (tag) => new FakeDomElement(tag),
    createTextNode: (text) => new FakeTextNode(text),
    createDocumentFragment: () => new FakeDomElement('#fragment'),
  };
  const contentContext = vm.createContext({});
  vm.runInContext(`${contentSource}\nthis.__content = this.H2O.Studio.Renderer.contentRenderer;`, contentContext);
  const content = contentContext.__content;
  assert.equal(content.__version, '1.1.0');
  const urlPolicy = { classifyUrl: (value) => (/^https:\/\//.test(String(value)) ? { ok: true } : { ok: false, reason: 'denied' }) };
  const presentationProfile = installPresentationProfile(vm.createContext({})).reference();
  const conversation = ir.createConversation({ id: 'h2o.render', messages: [{ id: 'h2o.message', role: 'assistant', blocks: [
    { kind: 'heading', level: 2, children: [{ kind: 'text', text: 'Title' }] },
    { kind: 'paragraph', children: [{ kind: 'text', text: 'plain ' }, { kind: 'text', text: 'strong-link', marks: [{ kind: 'strong' }, { kind: 'link', href: 'https://example.test/x' }] }, { kind: 'text', text: 'denied', marks: [{ kind: 'link', href: 'javascript:alert(1)' }] }] },
    { kind: 'list', ordered: false, items: [{ kind: 'listItem', blocks: [{ kind: 'paragraph', children: [{ kind: 'text', text: 'outer' }] }, { kind: 'list', ordered: true, items: [{ kind: 'listItem', blocks: [{ kind: 'paragraph', children: [{ kind: 'text', text: 'inner' }] }] }] }] }] },
    { kind: 'table', rows: [{ kind: 'tableRow', header: true, cells: [{ kind: 'tableCell', blocks: [{ kind: 'paragraph', children: [{ kind: 'text', text: 'h' }] }] }] }, { kind: 'tableRow', cells: [{ kind: 'tableCell', blocks: [{ kind: 'paragraph', children: [{ kind: 'text', text: 'c' }] }] }] }] },
    { kind: 'codeBlock', language: 'js', code: 'const x = 1;' },
    { kind: 'image', src: 'https://example.test/i.png', alt: 'pic' },
    { kind: 'file', href: 'https://example.test/f.pdf', name: 'file' },
    { kind: 'paragraph', children: [{ kind: 'text', text: 'a' }, { kind: 'hardBreak' }, { kind: 'text', text: 'b' }] },
    { kind: 'thematicBreak' },
    { kind: 'opaqueProviderBlock', opaqueKind: 'unsupportedOwnerContent', ownerContentType: 'gizmo', ownerContent: { name: 'Thing' } },
  ] }] });
  assert.equal(ir.validate(conversation).ok, true);
  const blocks = conversation.messages[0].blocks;
  const reports = [];
  const fragment = content.renderBlocks(blocks, { document: doc, urlPolicy, presentationProfile, projectionSink: (r) => reports.push(r) });
  const irWalk = []; const walk = (node) => { irWalk.push(node); for (const key of ['children', 'blocks', 'items', 'rows', 'cells']) if (Array.isArray(node[key])) node[key].forEach(walk); }; blocks.forEach(walk);
  assert.equal(reports.length, irWalk.length, 'D/E: exactly one report per accepted Render IR node (pre-order)');
  deep(reports.map((r) => r.block.renderKey), irWalk.map((n) => n.renderKey), 'M: reports follow the deterministic depth-first pre-order of the IR');
  for (const r of reports) {
    assert.equal(r.projection, r.block.kind === 'text' ? 'text' : 'block', 'text nodes are text projections, everything else a block projection');
    if (r.projection === 'text') { assert.equal(r.target instanceof FakeTextNode, true, 'F: text target is the Text node'); assert.equal(r.target.nodeValue, r.block.text); }
    else assert.equal(r.target instanceof FakeDomElement, true, 'D: block target is the returned element');
  }
  const byKind = Object.fromEntries(reports.filter((r) => r.projection === 'block').map((r) => [r.block.kind, r.target.tagName]));
  deep(byKind, { heading: 'H2', paragraph: 'P', list: 'OL', listItem: 'LI', table: 'TABLE', tableRow: 'TR', tableCell: 'TD', codeBlock: 'DIV', image: 'IMG', file: 'A', hardBreak: 'BR', thematicBreak: 'HR', opaqueProviderBlock: 'DIV' }, 'block targets are the existing ContentRenderer nodes (last occurrence per kind)');
  const marked = reports.find((r) => r.block.text === 'strong-link');
  assert.equal(marked.target.parentNode.tagName, 'A', 'F: marks wrap the reported Text node (marks[0] = strong outermost, link innermost)'); assert.equal(marked.target.parentNode.parentNode.tagName, 'STRONG');
  const denied = reports.find((r) => r.block.text === 'denied'); assert.equal(denied.target.parentNode.tagName, 'SPAN'); assert.equal(denied.target.parentNode.getAttribute('data-h2o-link-denied'), 'denied');
  assert.equal(reports.filter((r) => r.block.kind === 'opaqueProviderBlock').length, 1, 'N: one block record for an opaque block; its descendants are not projections');
  assert.equal(reports.filter((r) => r.block.kind === 'codeBlock').length, 1, 'the code text is not a text projection (not a Render IR text node)');
  assert.equal(fragment.children.length, blocks.length, 'G: the fragment carries exactly the top-level blocks - no wrapper added for indexing');
  /* No-sink render is byte-for-byte the same structure (the seam is inert without a sink). */
  const plain = content.renderBlocks(blocks, { document: doc, urlPolicy, presentationProfile });
  const shape = (node) => node instanceof FakeTextNode ? `#${node.nodeValue}` : `${node.tagName}[${[...node.attrs.entries()].map(([k, v]) => `${k}=${v}`).join(',')}](${node.children.map(shape).join('')})`;
  assert.equal(shape(fragment), shape(plain), 'G: reporting changes nothing in the rendered structure');
  /* Executed: the real index folds the reports into records scoped by the parent message key. */
  const turn = new FakeDomElement('article'); turn.className = 'cgTurn cgTurn--assistant'; turn.setAttribute('data-turn', 'assistant');
  const host = new FakeDomElement('div'); host.className = 'cgMsg cgMsg--assistant'; host.setAttribute('data-message-author-role', 'assistant'); const body = new FakeDomElement('div'); body.className = 'cgMsgBody'; host.appendChild(body); body.appendChild(fragment); turn.appendChild(host);
  const turnsEl = new FakeDomElement('section'); turnsEl.className = 'cgScroll wbRichRoot'; turnsEl.appendChild(turn); const root = new FakeDomElement('div'); root.className = 'cgFrame'; root.appendChild(turnsEl);
  const meta = new Map([[turn, { role: 'assistant', turnNo: 1, messageId: 'm-a1', turnId: '' }]]);
  const build = () => api.createShellIndex({ root, turnsEl, renderMode: 'canonical', source: { chatId: 'c', snapshotId: 's' }, semanticConversation: null, describeTurn: (el) => meta.get(el) || null, contentProjections: reports.map((report) => ({ report, bodyEl: body })), contentBodies: new Set([body]) });
  const ix = build();
  assert.equal(ix.blocks().length, reports.filter((r) => r.projection === 'block').length); assert.equal(ix.texts().length, reports.filter((r) => r.projection === 'text').length);
  const msg = ix.messages()[0];
  assert.equal(msg.contentIndexed, true); deep(msg.blockKeys, ix.blocks().map((b) => b.projectionKey)); deep(msg.textKeys, ix.texts().map((t) => t.projectionKey));
  for (const rec of [...ix.blocks(), ...ix.texts()]) {
    assert.equal(Object.isFrozen(rec), true, 'C: content records frozen'); assert.equal(rec.basis, 'render-ir'); assert.equal(rec.messageKey, msg.projectionKey); assert.equal(rec.messageOrdinal, 0);
    assert.equal(rec.projectionKey, `${rec.kind}:render:${encodeURIComponent(msg.projectionKey)}:${encodeURIComponent(rec.renderKey)}`, 'I: key = kind + parent message key + Render IR renderKey');
    assert.equal(rec.ownerRef, null, 'L: ordinary Markdown-shaped blocks carry no ownerRef');
    assert.equal(ix.getGeometry(rec.projectionKey), null, 'S: fake (never connected) targets measure to null');
  }
  deep([...ix.blocks(), ...ix.texts()].sort((a, b) => a.ordinal - b.ordinal).map((r) => r.renderKey), irWalk.map((n) => n.renderKey), 'M: content ordinals follow the pre-order walk');
  deep(ix.getConversation().blockKeys, msg.blockKeys); deep(ix.getConversation().textKeys, msg.textKeys);
  const t0 = ix.texts()[0], b0 = ix.blocks()[0];
  assert.equal(ix.getText(t0.projectionKey), t0); assert.equal(ix.getBlock(b0.projectionKey), b0); assert.equal(ix.getBlock(t0.projectionKey), null, 'K: cross-kind lookups are null'); assert.equal(ix.getText(b0.projectionKey), null); assert.equal(ix.getText('nope'), null); assert.equal(ix.getBlock(''), null);
  assert.equal(t0.target instanceof FakeTextNode, true, 'F: the indexed text target is the Text node');
  const ix2 = build(); deep(ix2.blocks().map((b) => b.projectionKey), ix.blocks().map((b) => b.projectionKey), 'deterministic content keys'); assert.notEqual(ix2, ix);
  const all = [ix.getConversation().projectionKey, ...ix.turns().map((t) => t.projectionKey), ...ix.messages().map((m) => m.projectionKey), ...ix.blocks().map((b) => b.projectionKey), ...ix.texts().map((t) => t.projectionKey)];
  assert.equal(new Set(all).size, all.length, 'projection keys unique across all five kinds');
  /* J: a second message with identical Markdown-shaped IR gets different content keys because the parent message key differs. */
  const turn2 = new FakeDomElement('article'); turn2.className = 'cgTurn cgTurn--assistant'; const host2 = new FakeDomElement('div'); host2.className = 'cgMsg cgMsg--assistant'; host2.setAttribute('data-message-author-role', 'assistant'); const body2 = new FakeDomElement('div'); body2.className = 'cgMsgBody'; host2.appendChild(body2); turn2.appendChild(host2); turnsEl.appendChild(turn2); meta.set(turn2, { role: 'assistant', turnNo: 2, messageId: 'm-a2', turnId: '' });
  const reports2 = []; body2.appendChild(content.renderBlocks(blocks, { document: doc, urlPolicy, presentationProfile, projectionSink: (r) => reports2.push(r) }));
  const ixTwin = api.createShellIndex({ root, turnsEl, renderMode: 'canonical', source: { chatId: 'c', snapshotId: 's' }, semanticConversation: null, describeTurn: (el) => meta.get(el) || null, contentProjections: [...reports.map((report) => ({ report, bodyEl: body })), ...reports2.map((report) => ({ report, bodyEl: body2 }))], contentBodies: new Set([body, body2]) });
  assert.equal(ixTwin.blocks().length, 2 * ix.blocks().length); assert.equal(new Set(ixTwin.blocks().map((b) => b.projectionKey)).size, ixTwin.blocks().length, 'J: identical Markdown in two messages still yields unique keys');
  deep(ixTwin.messages().map((m) => m.contentIndexed), [true, true]);
  /* O: a message with no ContentRenderer body is truthfully unindexed at content level. */
  const ixRaw = api.createShellIndex({ root, turnsEl, renderMode: 'rich', source: { chatId: 'c', snapshotId: 's' }, semanticConversation: null, describeTurn: (el) => meta.get(el) || null, contentProjections: [], contentBodies: new Set() });
  deep(ixRaw.messages().map((m) => [m.contentIndexed, m.blockKeys.length, m.textKeys.length]), [[false, 0, 0], [false, 0, 0]], 'O: no reports -> no content records, contentIndexed false');
  /* Chat renderer integration (static). */
  const bodyFn = extractFunction(rendererSource, 'renderSemanticBody');
  assert.match(bodyFn, /content\.renderBlocks\(doc\.messages\[0\]\.blocks, contentRenderContext\(bodyEl\)\)/, 'H: the Markdown path renders the validated Render IR blocks (renderKeys attached) through the sink context');
  assert.doesNotMatch(bodyFn, /renderBlocks\(parsed\.blocks/, 'H: the pre-IR adapter blocks are no longer what the ContentRenderer receives');
  assert.match(extractFunction(rendererSource, 'renderSemanticBlocks'), /content\.renderBlocks\(blocks, contentRenderContext\(bodyEl\)\)/, 'the semantic-v3 path reports through the same seam');
  assert.match(rendererSource, /let ACTIVE_CONTENT_COLLECTOR = null;/, 'private per-render collector');
  assert.match(extractFunction(rendererSource, 'render'), /const collection = openContentCollector\(\);\s*try \{\s*return renderWithCollector\(inputRaw, options, collection\.collector\);\s*\} finally \{\s*collection\.restore\(\);\s*\}/, 'the collector is scoped to one render invocation and always restored');
  assert.match(extractFunction(rendererSource, 'renderWithCollector'), /contentProjections: contentCollector\.projections,\s*contentBodies: contentCollector\.bodies,/, 'the collection reaches createShellIndex');
  assert.match(extractFunction(rendererSource, 'contentRenderContext'), /if \(!collector\) return \{ document \};/, 'without an open render the ContentRenderer runs with no sink (later edits do not mutate a snapshot)');
  assert.match(rendererSource, /function applyEditedMessageBody\(messageEl, role, text\)\{/, 'P: public applyEditedMessageBody signature unchanged');
  /* The pre-existing Reader text-leak cleanup (cleanReaderUserTextNodeLeaks) walks text nodes for its own accepted purpose; no projection code path may. */
  for (const name of ['contentRenderContext', 'markContentBody', 'openContentCollector', 'renderWithCollector', 'renderSemanticBody', 'renderSemanticBlocks']) assert.doesNotMatch(extractFunction(rendererSource, name), /querySelector|TreeWalker|createTreeWalker|textContent|innerHTML|outerHTML/, `O: no DOM scraping for projections in ${name}`);
  assert.doesNotMatch(indexSource.replace(/\/\*[\s\S]*?\*\//g, ' '), /querySelector|TreeWalker|textContent|innerHTML|outerHTML/, 'O: the index never walks or reads DOM content');
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
validateStructuralShellAuthority();
validateRichUserBubbleAuthority();
validatePresentationProfileContract();
validateRichShellPresentationOwnership();
validatePersistedEditPresentationOwnership();
validateAttachmentPresentationOwnership();
validateFinalRendererCssBoundary();
validateSemanticIndexFoundation();
validateSemanticIndexContentProjections();
validateExtractedRendererBoundary();

console.log('Studio renderer contract repair validation passed');
