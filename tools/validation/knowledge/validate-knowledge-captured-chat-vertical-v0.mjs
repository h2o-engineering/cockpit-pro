#!/usr/bin/env node
//
// Lane: L-COCKPIT-KNOWLEDGE-MODEL
// Mission: knowledge-model-contract-foundation-v0 (T3)
//
// Integrated vertical proof of the Knowledge Model v0 contracts over the real
// captured-chat / highlight compatibility path. Loads the REAL modules -
// nothing here reimplements the resolver:
//
//   shared/knowledge/contracts-v0.js
//   shared/knowledge/captured-chat-highlight-adapter-v0.js
//   src-surfaces-base/studio/reader-notes/anchor-resolver.studio.js
//
// Coverage:
//   A  exact quote success (the whole chain, in one test)
//   B  validated textPos fallback
//   C  ambiguous quote -> orphaned, no Excerpt
//   D  unsafe / no match -> orphaned, no Excerpt
//   E  deferred XPath survives but never resolves
//   F  missing / invalid owner identity fails closed
//   G  owner inputs are not mutated
//
// The incumbent resolver is exercised as shipped, behind its own feature
// flag. The flag stub below is test scaffolding in this sandbox only; no
// Product flag default is changed.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), '../../..');

const CONTRACTS_PATH = path.join(repoRoot, 'shared/knowledge/contracts-v0.js');
const ADAPTER_PATH = path.join(repoRoot, 'shared/knowledge/captured-chat-highlight-adapter-v0.js');
const RESOLVER_PATH = path.join(
  repoRoot,
  'src-surfaces-base/studio/reader-notes/anchor-resolver.studio.js',
);
const RESOLVER_FLAG = 'studio.readerNotes.anchorResolver.enabled';

/* ── Load the real modules into one sandbox, the way surfaces compose ──── */

const sandbox = { console };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
for (const file of [CONTRACTS_PATH, ADAPTER_PATH, RESOLVER_PATH]) {
  vm.runInContext(fs.readFileSync(file, 'utf8'), sandbox, { filename: file });
}

const K = sandbox.H2O?.Knowledge?.ContractsV0;
const A = sandbox.H2O?.Knowledge?.CapturedChatHighlightAdapterV0;
const RESOLVER = sandbox.H2O?.Studio?.readerNotes?.anchorResolver;
assert.ok(K, 'contracts-v0 must publish on H2O.Knowledge.ContractsV0');
assert.ok(A, 'adapter must publish on H2O.Knowledge.CapturedChatHighlightAdapterV0');
assert.ok(RESOLVER, 'incumbent anchor resolver must publish on H2O.Studio.readerNotes.anchorResolver');
assert.equal(typeof RESOLVER.resolveInText, 'function', 'incumbent resolver must expose resolveInText');

// Minimal read-only flag surface the incumbent resolver reads at call time.
let resolverFlagOn = true;
sandbox.H2O.flags = {
  get(key, fallback) {
    if (key === RESOLVER_FLAG) return resolverFlagOn;
    return fallback;
  },
};
assert.equal(RESOLVER.isEnabled(), true, 'incumbent resolver must be enabled for the proof');

/* ── Helpers ───────────────────────────────────────────────────────────── */

function plain(value) {
  return value === null || value === undefined ? value : JSON.parse(JSON.stringify(value));
}

function snapshot(value) {
  return JSON.stringify(value);
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.keys(value).forEach((key) => deepFreeze(value[key]));
  }
  return value;
}

let checks = 0;
function ok(label, condition) {
  assert.ok(condition, label);
  checks += 1;
}

// Counting pass-through so the proof can show the incumbent resolver really
// ran, and ran unmodified.
let resolverCalls = 0;
let lastResolverInput = null;
const countingResolver = {
  resolveInText(anchors, plainText, options) {
    resolverCalls += 1;
    lastResolverInput = plain(anchors);
    return RESOLVER.resolveInText(anchors, plainText, options);
  },
};

/* ── Production-shaped owner fixtures ──────────────────────────────────── */

const CHAT_ID = '6a9c227d-1f2b-4c3d-8e90-abcdef012345';
const CONTENT_HASH = `sha256-${'b'.repeat(64)}`;
const ANSWER_ID = 'msg_01H2OabcDEF';
const NATIVE_ID = 'hl_7f3a';

// Shaped exactly like library-item-view.studio.js `buildItem()` output.
function capturedChatItem(overrides) {
  return deepFreeze({
    schemaVersion: 1,
    kind: 'captured_chat',
    id: CHAT_ID,
    title: 'Knowledge Model contract foundation',
    identity: { authority: 'chat-registry', chatId: CHAT_ID },
    content: { kind: 'captured_chat', snapshotId: 'snap_0091', snapshotCount: 3, messageCount: 12 },
    metadata: {
      category: { kind: 'category_ref', value: null, flattened: false },
      labels: { kind: 'label_assignments_ref', value: null, flattened: false },
      tags: [],
      folder: null,
    },
    raw: { libraryIndexRow: null, chatRegistryRecord: null },
    ...(overrides || {}),
  });
}

// Mirrors the highlights engine's TXT_rangeToQuote(range, root, 32).
function quoteFrom(plainText, exact, ctx = 32) {
  const start = plainText.indexOf(exact);
  const end = start + exact.length;
  return {
    exact,
    prefix: plainText.slice(Math.max(0, start - ctx), start),
    suffix: plainText.slice(end, end + ctx),
    approx: start,
  };
}

// Shaped exactly like annotation-facade.studio.js `mapAttributedHighlight()`.
function highlightAnnotation(anchors, overrides) {
  return deepFreeze({
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
      convoId: null,
    },
    body: { color: 'yellow', text: 'highlight preview text — NOT the excerpt', createdAt: 1757462400000 },
    raw: {
      id: NATIVE_ID,
      ts: 1757462400000,
      color: 'yellow',
      anchors,
    },
    ...(overrides || {}),
  });
}

function runChain(input, options) {
  return A.resolveHighlightExcerpt(input, { resolver: countingResolver, ...(options || {}) });
}

/* ══ A. Exact quote success — the complete chain in one test ════════════ */

const PLAIN_A = 'The validator reports 207 checks across 15 obligations for this slice.';
const EXACT_A = 'reports 207 checks';

{
  const quote = quoteFrom(PLAIN_A, EXACT_A);
  const anchors = { textPos: { start: quote.approx, end: quote.approx + EXACT_A.length }, textQuote: quote };
  const item = capturedChatItem();
  const annotation = highlightAnnotation(anchors);

  const callsBefore = resolverCalls;
  const out = runChain({ item, contentHash: CONTENT_HASH, annotation, plainText: PLAIN_A });

  ok('A: chain executed', out.ok === true && out.reason === '');

  // Owner identity is referenced, never reminted.
  ok('A: ItemRef preserves the owner chatId', out.itemRef.id === CHAT_ID);
  assert.deepEqual(plain(out.itemRef), {
    kind: 'item_ref', itemKind: 'captured_chat', scheme: 'chat-registry/chat-id', id: CHAT_ID,
  }, 'A: ItemRef is the frozen first-adapter mapping');
  assert.deepEqual(plain(out.versionRef), {
    kind: 'version_ref',
    item: plain(out.itemRef),
    scheme: 'saved-chat/generation-content-hash',
    id: CONTENT_HASH,
  }, 'A: VersionRef is the frozen first-adapter mapping');
  ok('A: owner contentHash preserved byte-exact', out.versionRef.id === CONTENT_HASH);
  assert.deepEqual(plain(out.blockRef), {
    kind: 'semantic_block_ref',
    version: plain(out.versionRef),
    blockKind: 'message',
    scheme: 'captured-chat/message-id',
    id: ANSWER_ID,
  }, 'A: SemanticBlockRef is the frozen first-adapter mapping');
  ok('A: answerId preserved', out.blockRef.id === ANSWER_ID);

  // The Anchor is a faithful carrier of the existing selectors.
  ok('A: Anchor targets the block ref', K.sameReference(out.anchor.target, out.blockRef));
  ok('A: Anchor validates under the v0 contract', K.validateAnchor(out.anchor).ok);
  assert.deepEqual(plain(out.anchor.selectors.textQuote), plain(quote), 'A: textQuote carried across intact');
  assert.deepEqual(plain(out.resolverInput), plain(anchors),
    'A: the selectors handed to the resolver are exactly the owner anchors');

  // The incumbent resolver really ran, and its verdict is what got mapped.
  ok('A: incumbent resolver was invoked', resolverCalls === callsBefore + 1);
  const direct = RESOLVER.resolveInText(plain(anchors), PLAIN_A, {});
  ok('A: incumbent verdict is anchored/textQuote',
    direct.status === 'anchored' && direct.selectorUsed === 'textQuote');
  ok('A: mapped status matches the incumbent', out.result.status === direct.status);
  ok('A: mapped selectorUsed matches the incumbent', out.result.selectorUsed === direct.selectorUsed);
  ok('A: mapped confidence matches the incumbent', out.result.confidence === direct.confidence);
  ok('A: mapped reason matches the incumbent', out.result.reason === direct.reason);
  assert.deepEqual(plain(out.result.span), plain(direct.span), 'A: mapped span matches the incumbent');

  ok('A: ReanchorResult is same_version', out.result.versionScope === 'same_version');
  ok('A: ReanchorResult validates under the v0 contract', K.validateReanchorResult(out.result).ok);

  // The Excerpt is the exact resolved substring, bound back to this Anchor.
  ok('A: Excerpt produced', !!out.excerpt);
  ok('A: Excerpt text is the resolved substring',
    out.excerpt.text === PLAIN_A.slice(out.result.span.start, out.result.span.end));
  ok('A: Excerpt text equals the exact quote here', out.excerpt.text === EXACT_A);
  ok('A: Excerpt is not the highlight preview', out.excerpt.text !== annotation.body.text);
  ok('A: Provenance derivation is anchor_resolution',
    out.excerpt.provenance.derivation === 'anchor_resolution');
  ok('A: Provenance points at the same Anchor',
    K.sameReference(out.excerpt.provenance.source, out.anchor));
  ok('A: Excerpt validates under the v0 contract', K.validateExcerpt(out.excerpt).ok);
  ok('A: Excerpt reaches item identity',
    out.excerpt.provenance.source.target.version.item.id === CHAT_ID);
  ok('A: Excerpt reaches version identity',
    out.excerpt.provenance.source.target.version.id === CONTENT_HASH);
  ok('A: Excerpt reaches block identity', out.excerpt.provenance.source.target.id === ANSWER_ID);
}

/* ══ B. Validated textPos fallback (same version, never cross-version) ══ */

// Natural drift: the highlight was captured across a soft line break, so the
// stored quote holds "\n" where the current flattened plain text holds " ".
// The quote no longer matches literally; the stored span still does, and the
// incumbent validates it by normalized equality.
const PLAIN_B = 'The result is hello world today.';
const EXACT_B = 'hello\nworld';

{
  const anchors = {
    textPos: { start: 14, end: 25 },
    textQuote: { exact: EXACT_B, prefix: 'The result is ', suffix: ' today.', approx: 14 },
  };
  const item = capturedChatItem();
  const annotation = highlightAnnotation(anchors);

  ok('B: the literal quote genuinely does not occur', PLAIN_B.indexOf(EXACT_B) === -1);

  const out = runChain({ item, contentHash: CONTENT_HASH, annotation, plainText: PLAIN_B });
  ok('B: chain executed', out.ok === true);

  const direct = RESOLVER.resolveInText(plain(anchors), PLAIN_B, {});
  ok('B: incumbent falls back to validated textPos',
    direct.status === 'reanchored' && direct.selectorUsed === 'textPos'
    && direct.reason === 'textPos-validated');
  ok('B: mapped status is reanchored', out.result.status === 'reanchored');
  ok('B: mapped selector is textPos', out.result.selectorUsed === 'textPos');
  ok('B: mapped confidence matches the incumbent', out.result.confidence === direct.confidence);

  // The load-bearing v0 rule: safe fallback inside ONE version.
  ok('B: still same_version', out.result.versionScope === 'same_version');
  ok('B: exactly one VersionRef is reachable', out.result.anchor.target.version.id === CONTENT_HASH);

  ok('B: Excerpt produced', !!out.excerpt);
  ok('B: Excerpt is the resolved substring',
    out.excerpt.text === PLAIN_B.slice(out.result.span.start, out.result.span.end));
  ok('B: Excerpt is "hello world"', out.excerpt.text === 'hello world');
  // The whole point: the resolved substring wins over the stored quote.
  ok('B: Excerpt is NOT the raw textQuote.exact', out.excerpt.text !== EXACT_B);
  ok('B: Provenance points at the same Anchor',
    K.sameReference(out.excerpt.provenance.source, out.anchor));
  ok('B: Excerpt validates under the v0 contract', K.validateExcerpt(out.excerpt).ok);
}

/* ══ C. Ambiguous quote fails closed ═══════════════════════════════════ */

const PLAIN_C = 'pre TERM mid1 pre TERM end';

{
  // Two matches, equidistant from the recorded approx: an unbreakable tie.
  const tied = {
    textQuote: { exact: 'TERM', prefix: 'pre ', suffix: ' ', approx: 11 },
  };
  const out = runChain({
    item: capturedChatItem(),
    contentHash: CONTENT_HASH,
    annotation: highlightAnnotation(tied),
    plainText: PLAIN_C,
  });
  ok('C: chain executed', out.ok === true);
  ok('C: orphaned on an approx tie', out.result.status === 'orphaned');
  ok('C: reason is ambiguous-textQuote', out.result.reason === 'ambiguous-textQuote');
  ok('C: two candidates were seen', out.result.diagnostics.matchCount === 2);
  ok('C: no span', out.result.span === null);
  ok('C: no selector claimed', out.result.selectorUsed === null);
  ok('C: NO Excerpt', out.excerpt === null);
  // The Excerpt gate is guarded both in the orchestrator and in buildExcerpt;
  // assert the inner guard directly so each layer is load-bearing on its own.
  ok('C: buildExcerpt refuses an orphaned result outright',
    A.buildExcerpt(out.result, PLAIN_C) === null);
  ok('C: still same_version', out.result.versionScope === 'same_version');
  ok('C: orphaned result still validates', K.validateReanchorResult(out.result).ok);

  // Ambiguity without any approx to disambiguate: same fail-closed outcome.
  const noApprox = { textQuote: { exact: 'TERM', prefix: 'pre ', suffix: ' ' } };
  const out2 = runChain({
    item: capturedChatItem(),
    contentHash: CONTENT_HASH,
    annotation: highlightAnnotation(noApprox),
    plainText: PLAIN_C,
  });
  ok('C: orphaned without approx', out2.result.status === 'orphaned'
    && out2.result.reason === 'ambiguous-textQuote');
  ok('C: no Excerpt without approx', out2.excerpt === null);

  // Ambiguity is never rescued by a textPos that was not validated.
  const withPos = {
    textQuote: { exact: 'TERM', prefix: 'pre ', suffix: ' ', approx: 11 },
    textPos: { start: 4, end: 8 },
  };
  const out3 = runChain({
    item: capturedChatItem(),
    contentHash: CONTENT_HASH,
    annotation: highlightAnnotation(withPos),
    plainText: PLAIN_C,
  });
  ok('C: ambiguity is not rescued by textPos', out3.result.status === 'orphaned' && out3.excerpt === null);
}

/* ══ D. Unsafe / no match fails closed ═════════════════════════════════ */

const PLAIN_D = 'Nothing here matches at all.';

{
  // Quote absent, and the stored span points at different text.
  const mismatched = {
    textQuote: { exact: 'an absent phrase', prefix: '', suffix: '', approx: 0 },
    textPos: { start: 0, end: 7 },
  };
  const out = runChain({
    item: capturedChatItem(),
    contentHash: CONTENT_HASH,
    annotation: highlightAnnotation(mismatched),
    plainText: PLAIN_D,
  });
  ok('D: chain executed', out.ok === true);
  ok('D: orphaned', out.result.status === 'orphaned');
  ok('D: reason is no-safe-match', out.result.reason === 'no-safe-match');
  ok('D: no candidates matched', out.result.diagnostics.matchCount === 0);
  ok('D: NO Excerpt', out.excerpt === null);
  ok('D: buildExcerpt refuses an orphaned result outright',
    A.buildExcerpt(out.result, PLAIN_D) === null);
  ok('D: the mismatch was recorded, not guessed past',
    out.result.diagnostics.notes.includes('textPos quote mismatch'));

  // Out-of-range span: malformed, never clamped into a match.
  const outOfRange = {
    textQuote: { exact: 'an absent phrase', prefix: '', suffix: '', approx: 0 },
    textPos: { start: 0, end: 9999 },
  };
  const out2 = runChain({
    item: capturedChatItem(),
    contentHash: CONTENT_HASH,
    annotation: highlightAnnotation(outOfRange),
    plainText: PLAIN_D,
  });
  ok('D: out-of-range span orphans', out2.result.status === 'orphaned' && out2.excerpt === null);
  ok('D: out-of-range span was reported malformed',
    out2.result.diagnostics.notes.includes('malformed textPos'));

  // Flag off: the incumbent fails closed and nothing is excerpted.
  resolverFlagOn = false;
  const quote = quoteFrom(PLAIN_A, EXACT_A);
  const out3 = runChain({
    item: capturedChatItem(),
    contentHash: CONTENT_HASH,
    annotation: highlightAnnotation({ textQuote: quote }),
    plainText: PLAIN_A,
  });
  resolverFlagOn = true;
  ok('D: disabled resolver orphans', out3.result.status === 'orphaned' && out3.result.reason === 'disabled');
  ok('D: disabled resolver yields no Excerpt', out3.excerpt === null);
  ok('D: resolver re-enabled for the remaining cases', RESOLVER.isEnabled() === true);
}

/* ══ E. Deferred XPath survives adaptation but never resolves ═══════════ */

{
  const xpath = { startXPath: './/p[1]/text()[1]', startOffset: 4, endXPath: './/p[1]/text()[1]', endOffset: 22 };
  const quote = quoteFrom(PLAIN_A, EXACT_A);
  const anchors = {
    xpath,
    textPos: { start: quote.approx, end: quote.approx + EXACT_A.length },
    textQuote: quote,
  };
  const out = runChain({
    item: capturedChatItem(),
    contentHash: CONTENT_HASH,
    annotation: highlightAnnotation(anchors),
    plainText: PLAIN_A,
  });

  ok('E: chain executed', out.ok === true);
  assert.deepEqual(plain(out.anchor.deferredSelectors.xpath), xpath, 'E: xpath bytes survive adaptation');
  ok('E: xpath is carried as deferred, not as a selector',
    out.anchor.selectors.xpath === undefined && K.supportsSelector('xpath') === false);
  ok('E: xpath is detached from the owner input',
    out.anchor.deferredSelectors.xpath !== anchors.xpath);
  ok('E: xpath reaches the resolver as opaque data', lastResolverInput.xpath !== undefined);
  ok('E: the incumbent reports it deferred', out.result.diagnostics.xpathDeferred === true);
  ok('E: success came from textQuote, never xpath',
    out.result.status === 'anchored' && out.result.selectorUsed === 'textQuote');
  ok('E: Excerpt still comes from the resolved span',
    out.excerpt.text === PLAIN_A.slice(out.result.span.start, out.result.span.end));

  // XPath alone is not a resolution path: with no textQuote there is no Anchor.
  const xpathOnly = runChain({
    item: capturedChatItem(),
    contentHash: CONTENT_HASH,
    annotation: highlightAnnotation({ xpath }),
    plainText: PLAIN_A,
  });
  ok('E: xpath-only fails closed', xpathOnly.ok === false && xpathOnly.reason === 'invalid-anchor');
  ok('E: xpath-only produces no result', xpathOnly.result === null);
  ok('E: xpath-only produces no Excerpt', xpathOnly.excerpt === null);
}

/* ══ F. Missing / invalid owner identity fails closed ═══════════════════ */

{
  const quote = quoteFrom(PLAIN_A, EXACT_A);
  const goodAnchors = { textQuote: quote };
  const goodAnnotation = highlightAnnotation(goodAnchors);

  function expectFail(label, input, reason) {
    const out = runChain(input);
    ok(`F: ${label} -> ${reason}`, out.ok === false && out.reason === reason);
    ok(`F: ${label} produces no reference chain`, out.itemRef === null && out.versionRef === null
      && out.blockRef === null && out.anchor === null);
    ok(`F: ${label} produces no result or Excerpt`, out.result === null && out.excerpt === null);
  }

  const base = { item: capturedChatItem(), contentHash: CONTENT_HASH, annotation: goodAnnotation, plainText: PLAIN_A };

  // chatId
  expectFail('no chat identity at all',
    { ...base, item: deepFreeze({ kind: 'captured_chat', title: 'x' }) }, 'missing-item-identity');
  expectFail('empty chatId',
    { ...base, item: deepFreeze({ kind: 'captured_chat', id: '', identity: { authority: 'chat-registry', chatId: '' } }) },
    'missing-item-identity');
  expectFail('whitespace-padded chatId',
    { ...base, item: deepFreeze({ kind: 'captured_chat', id: ` ${CHAT_ID} ` }) }, 'missing-item-identity');
  expectFail('non-string chatId',
    { ...base, item: deepFreeze({ kind: 'captured_chat', id: 12345 }) }, 'missing-item-identity');
  expectFail('conflicting chat identity',
    { ...base, item: deepFreeze({ kind: 'captured_chat', id: CHAT_ID, identity: { authority: 'chat-registry', chatId: 'other-chat' } }) },
    'item-identity-conflict');
  expectFail('foreign identity authority',
    { ...base, item: deepFreeze({ kind: 'captured_chat', id: CHAT_ID, identity: { authority: 'source-documents', chatId: CHAT_ID } }) },
    'identity-authority-mismatch');
  expectFail('wrong item kind',
    { ...base, item: deepFreeze({ kind: 'source_document', id: CHAT_ID }) }, 'item-kind-mismatch');
  expectFail('item not an object', { ...base, item: CHAT_ID }, 'invalid-item');

  // contentHash — owner-supplied, never derived
  expectFail('missing contentHash', { ...base, contentHash: undefined }, 'missing-version-identity');
  expectFail('empty contentHash', { ...base, contentHash: '' }, 'missing-version-identity');
  expectFail('whitespace-padded contentHash', { ...base, contentHash: ` ${CONTENT_HASH} ` }, 'missing-version-identity');
  expectFail('non-string contentHash', { ...base, contentHash: 42 }, 'missing-version-identity');
  expectFail('null contentHash', { ...base, contentHash: null }, 'missing-version-identity');

  // answerId
  expectFail('missing answerId', {
    ...base,
    annotation: deepFreeze({ ...plain(goodAnnotation), source: { store: 'highlights', chatId: CHAT_ID, nativeId: NATIVE_ID } }),
  }, 'missing-block-identity');
  expectFail('empty answerId', {
    ...base,
    annotation: deepFreeze({ ...plain(goodAnnotation), source: { store: 'highlights', chatId: CHAT_ID, answerId: '', nativeId: NATIVE_ID } }),
  }, 'missing-block-identity');
  expectFail('no source block at all', {
    ...base, annotation: deepFreeze({ ...plain(goodAnnotation), source: null }),
  }, 'missing-block-identity');

  // annotation eligibility and cross-item safety
  expectFail('unattributed highlight', {
    ...base, annotation: deepFreeze({ ...plain(goodAnnotation), attribution: 'unattributed' }),
  }, 'annotation-not-attributed');
  expectFail('not a highlight', {
    ...base, annotation: deepFreeze({ ...plain(goodAnnotation), kind: 'note' }),
  }, 'annotation-kind-mismatch');
  expectFail('annotation belongs to another chat', {
    ...base,
    annotation: deepFreeze({
      ...plain(goodAnnotation),
      source: { ...plain(goodAnnotation).source, chatId: 'a-different-chat' },
    }),
  }, 'annotation-item-mismatch');
  expectFail('annotation item points elsewhere', {
    ...base,
    annotation: deepFreeze({ ...plain(goodAnnotation), item: { kind: 'captured_chat', id: 'a-different-chat' } }),
  }, 'annotation-item-mismatch');

  // anchor inputs
  expectFail('no anchors', {
    ...base, annotation: deepFreeze({ ...plain(goodAnnotation), raw: { id: NATIVE_ID } }),
  }, 'missing-anchors');
  expectFail('no raw payload', {
    ...base, annotation: deepFreeze({ ...plain(goodAnnotation), raw: null }),
  }, 'missing-anchors');
  expectFail('anchors without textQuote', {
    ...base, annotation: highlightAnnotation({ textPos: { start: 0, end: 4 } }),
  }, 'invalid-anchor');
  expectFail('empty exact', {
    ...base, annotation: highlightAnnotation({ textQuote: { exact: '', prefix: '', suffix: '', approx: 0 } }),
  }, 'invalid-anchor');
  expectFail('malformed textPos', {
    ...base, annotation: highlightAnnotation({ textQuote: quote, textPos: { start: 9, end: 4 } }),
  }, 'invalid-anchor');

  // harness inputs
  expectFail('plain text missing', { ...base, plainText: undefined }, 'invalid-plain-text');
  expectFail('plain text not a string', { ...base, plainText: 123 }, 'invalid-plain-text');

  // The resolver is injected, never reached for through a global.
  const noResolver = A.resolveHighlightExcerpt(base, {});
  ok('F: no resolver -> resolver-unavailable',
    noResolver.ok === false && noResolver.reason === 'resolver-unavailable');
  const badResolver = A.resolveHighlightExcerpt(base, { resolver: { resolveInText: 'nope' } });
  ok('F: non-callable resolver -> resolver-unavailable',
    badResolver.ok === false && badResolver.reason === 'resolver-unavailable');
  const throwingResolver = A.resolveHighlightExcerpt(base, {
    resolver: { resolveInText() { throw new Error('boom'); } },
  });
  ok('F: a throwing resolver fails closed',
    throwingResolver.ok === false && throwingResolver.reason === 'resolver-error');
  const junkResolver = A.resolveHighlightExcerpt(base, { resolver: { resolveInText: () => 'not-an-object' } });
  ok('F: a junk resolver result fails closed',
    junkResolver.ok === false && junkResolver.reason === 'resolver-result-invalid');

  // A resolver claiming success it cannot substantiate must not yield text.
  const lyingResolver = A.resolveHighlightExcerpt(base, {
    resolver: () => null,
  });
  ok('F: a non-object resolver fails closed', lyingResolver.ok === false);
  const spanlessSuccess = A.resolveHighlightExcerpt(base, {
    resolver: {
      resolveInText: () => ({
        status: 'anchored', span: null, selectorUsed: 'textQuote', confidence: 1, reason: 'forged',
        diagnostics: { tried: [], matchCount: 0, approx: null, xpathDeferred: false, notes: [] },
      }),
    },
  });
  ok('F: anchored-without-span is refused by the contract',
    spanlessSuccess.ok === false && spanlessSuccess.reason === 'unmappable-result');
  const forgedSelector = A.resolveHighlightExcerpt(base, {
    resolver: {
      resolveInText: () => ({
        status: 'anchored', span: { start: 0, end: 4 }, selectorUsed: 'xpath', confidence: 1, reason: 'forged',
        diagnostics: { tried: [], matchCount: 1, approx: null, xpathDeferred: true, notes: [] },
      }),
    },
  });
  ok('F: an xpath-claimed success is refused by the contract',
    forgedSelector.ok === false && forgedSelector.reason === 'unmappable-result');
}

/* ══ G. Owner inputs are not mutated ═══════════════════════════════════ */

{
  const quote = quoteFrom(PLAIN_A, EXACT_A);
  const xpath = { startXPath: './/p[1]/text()[1]', startOffset: 4, endXPath: './/p[1]/text()[1]', endOffset: 22 };
  const anchors = {
    xpath,
    textPos: { start: quote.approx, end: quote.approx + EXACT_A.length },
    textQuote: quote,
  };
  // Every fixture is already deep-frozen, so a write would throw rather than
  // merely be observed; the snapshots prove value-level immutability too.
  const item = capturedChatItem();
  const annotation = highlightAnnotation(anchors);
  const itemBefore = snapshot(item);
  const annotationBefore = snapshot(annotation);
  const anchorsBefore = snapshot(anchors);

  const out = runChain({ item, contentHash: CONTENT_HASH, annotation, plainText: PLAIN_A });
  ok('G: chain executed', out.ok === true && !!out.excerpt);
  ok('G: item unchanged', snapshot(item) === itemBefore);
  ok('G: annotation unchanged', snapshot(annotation) === annotationBefore);
  ok('G: anchors unchanged', snapshot(anchors) === anchorsBefore);
  ok('G: inputs were genuinely frozen', Object.isFrozen(item) && Object.isFrozen(annotation.raw.anchors));

  // Outputs are detached: mutating them never reaches back.
  out.anchor.selectors.textQuote.exact = 'MUTATED';
  out.excerpt.text = 'MUTATED';
  out.itemRef.id = 'MUTATED';
  ok('G: mutating outputs does not touch the owner inputs',
    snapshot(item) === itemBefore && snapshot(annotation) === annotationBefore);
  const again = runChain({ item, contentHash: CONTENT_HASH, annotation, plainText: PLAIN_A });
  ok('G: a fresh run is unaffected', again.excerpt.text === EXACT_A && again.itemRef.id === CHAT_ID);
  ok('G: repeated runs are deterministic', snapshot(plain(again.result)) === snapshot(plain(
    runChain({ item, contentHash: CONTENT_HASH, annotation, plainText: PLAIN_A }).result,
  )));
}

/* ══ Adapter posture ═══════════════════════════════════════════════════ */

{
  const d = A.diagnose();
  ok('adapter: contracts resolved from the shared namespace', d.contractsAvailable === true);
  ok('adapter: resolver is injected, not reimplemented',
    d.resolver.injected === true && d.resolver.reimplemented === false);
  ok('adapter: mints no owner identity',
    d.mintsOwnerIdentity === false && d.recomputesVersionIdentity === false);
  ok('adapter: not wired into runtime', d.runtimeWired === false);
  assert.deepEqual(plain(d.excerptStatuses), ['anchored', 'reanchored'],
    'adapter: Excerpts only from successful resolutions');
  assert.deepEqual(plain(d.mapping), {
    itemKind: 'captured_chat',
    itemScheme: 'chat-registry/chat-id',
    identityAuthority: 'chat-registry',
    versionScheme: 'saved-chat/generation-content-hash',
    blockKind: 'message',
    blockScheme: 'captured-chat/message-id',
    derivation: 'anchor_resolution',
  }, 'adapter: exactly the frozen T1 first-adapter mapping');

  // The incumbent surface was consumed, not modified: it still reports the
  // same posture it ships with.
  const rd = RESOLVER.diagnose();
  assert.deepEqual(plain(rd.supportedSelectors), ['textQuote', 'textPos'],
    'incumbent resolver selector support unchanged');
  assert.deepEqual(plain(rd.deferredSelectors), ['xpath'], 'incumbent resolver still defers xpath');
  assert.deepEqual(plain(rd.statuses), ['anchored', 'reanchored', 'orphaned'],
    'incumbent resolver status set unchanged');
  ok('incumbent resolver reports no internal errors', rd.errors.length === 0);
  ok('incumbent resolver was exercised repeatedly', resolverCalls >= 8);
}

console.log(`[validate-knowledge-captured-chat-vertical-v0] ok — ${checks} checks, `
  + `${resolverCalls} incumbent resolver invocations across cases A–G`);
