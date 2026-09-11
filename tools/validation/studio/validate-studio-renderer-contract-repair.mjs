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
    extractFunction(rendererSource, 'activePresentationProfile'),
    extractFunction(rendererSource, 'hasCompleteRichCoverage'),
    extractFunction(rendererSource, 'buildConversationShell'),
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
  const renderFn = extractFunction(rendererSource, 'render');
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
  for (const name of ['buildTurnShell', 'buildMessageHost', 'buildRichUserBubbleShell', 'adoptRichUserBubble', 'buildConversationShell', 'render', 'applyEditedMessageBody', 'cleanReaderUserTextNodeLeaks']) {
    assert.match(extractFunction(rendererSource, name), /activePresentationProfile\(\)/, `F: ${name} resolves the active profile`);
  }
  assert.match(extractFunction(rendererSource, 'buildTurnShell'), /\.turnClasses\(role, mode\)/);
  assert.match(extractFunction(rendererSource, 'buildMessageHost'), /\.messageClasses\(role, mode\)/);
  assert.match(extractFunction(rendererSource, 'buildRichUserBubbleShell'), /\.userBubbleClasses\(\)/);
  assert.match(extractFunction(rendererSource, 'render'), /\.transcriptClasses\("rich"\)/);
  assert.match(extractFunction(rendererSource, 'render'), /\.transcriptClasses\("canonical"\)/);
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
  /* The stylesheet never invents hooks the JS does not emit. */
  assert.doesNotMatch(css, /\.cgMsg--rich|\.wbTurn--edited|\.cgTurn--has-attachments|\.cgUserAttachment/, 'no stale or non-profile hooks in the profile stylesheet');
  /* Executed: the rich shells still emit exactly those hooks. */
  const seams = vm.createContext({
    document: { createElement: (tagName) => new FakeDomElement(tagName) },
    Element: FakeDomElement, String, Number, Set, Array, Object,
    TESTID_ATTR: 'data-testid', TURN_TESTID: 'conversation-turn', TURNS_TESTID: 'conversation-turns',
    ROLE_ATTR: 'data-message-author-role', MESSAGE_ID_ATTR: 'data-message-id', TURN_ID_ATTR: 'data-turn-id', ROLES: roleContract,
    stampReplayTurnMeta: () => {},
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
function validatePersistedEditPresentationOwnership() {
  const scope = ':where([data-h2o-presentation-profile="chatgpt-reference"])';
  const profileCss = readRepo(PRESENTATION_CSS_REL).replace(/\/\*[\s\S]*?\*\//g, ' ');
  const studioCss = readRepo(STUDIO_CSS_REL).replace(/\/\*[\s\S]*?\*\//g, ' ');
  /* Minimal rule reader: [{ selector (whitespace-normalized), decls }] in source order; @-preludes are skipped. */
  const rulesOf = (css) => {
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
  };
  const selectorsOf = (css) => rulesOf(css).map((r) => r.selector);
  const declarationsOf = (css, selector) => { const hit = rulesOf(css).find((r) => r.selector === selector); return hit ? hit.decls : null; };
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
  const members = (selector) => { const out = []; let depth = 0; let cur = ''; for (const ch of selector) { if (ch === '(') depth += 1; if (ch === ')') depth -= 1; if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; } else cur += ch; } out.push(cur.trim()); return out; };
  for (const sel of profileSelectors.flatMap(members)) assert.ok(sel.startsWith(scope), `D: profile-root scoped member: ${sel}`);
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
validateExtractedRendererBoundary();

console.log('Studio renderer contract repair validation passed');
