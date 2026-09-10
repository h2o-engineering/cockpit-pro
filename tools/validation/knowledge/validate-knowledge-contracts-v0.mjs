#!/usr/bin/env node
//
// Lane: L-COCKPIT-KNOWLEDGE-MODEL
// Mission: knowledge-model-contract-foundation-v0 (T2)
//
// Targeted validator for the frozen pure Knowledge Model v0 contract
// foundation under `shared/knowledge/`.
//
// Proof obligations (T2, in order):
//   1  valid ItemRef accepted
//   2  invalid/missing ItemRef fields fail closed
//   3  VersionRef requires an ItemRef and preserves its identity
//   4  SemanticBlockRef requires a VersionRef
//   5  Anchor requires SemanticBlockRef + textQuote.exact
//   6  malformed textPos is rejected
//   7  optional prefix/suffix/approx are preserved correctly
//   8  deferred XPath data does not make XPath an active resolver capability
//   9  Provenance preserves semantic derivation/source without mutation
//  10  Excerpt requires explicit source/provenance binding
//  11  ReanchorResult allows only anchored/reanchored/orphaned
//  12  versionScope is same_version
//  13  cross-version claims are impossible in v0
//  14  input objects are not mutated
//  15  no persistence/browser/network APIs in shared/knowledge/

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), '../../..');
const knowledgeDir = path.join(repoRoot, 'shared/knowledge');
const corePath = path.join(knowledgeDir, 'contracts-v0.js');

/* ── Load the core in an isolated sandbox (no Node globals leak in) ─────── */

const coreSource = fs.readFileSync(corePath, 'utf8');
const sandbox = { console };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(coreSource, sandbox, { filename: corePath });

const K = sandbox.H2O?.Knowledge?.ContractsV0;
assert.ok(K, 'ContractsV0 must publish on H2O.Knowledge');
assert.equal(K, sandbox.H2O.KnowledgeContractsV0, 'alias export must be the same frozen object');
assert.equal(K.contractVersion, 0, 'module-level contractVersion must be 0');
assert.ok(Object.isFrozen(K), 'public API must be frozen');

const EXPECTED_API = [
  '__installed',
  'contractVersion',
  'VERSION',
  'KINDS',
  'REANCHOR_STATUSES',
  'VERSION_SCOPE',
  'REANCHOR_VERSION_SCOPES',
  'SELECTOR_FAMILIES',
  'DEFERRED_SELECTOR_FAMILIES',
  'DERIVATIONS',
  'supportsSelector',
  'isDeferredSelector',
  'makeItemRef',
  'validateItemRef',
  'makeVersionRef',
  'validateVersionRef',
  'makeSemanticBlockRef',
  'validateSemanticBlockRef',
  'makeAnchor',
  'validateAnchor',
  'makeProvenance',
  'validateProvenance',
  'makeExcerpt',
  'validateExcerpt',
  'makeReanchorResult',
  'validateReanchorResult',
  'sameReference',
  'diagnose',
];
assert.deepEqual(Object.keys(K), EXPECTED_API, 'exported API keys must remain stable');

/* ── Helpers ───────────────────────────────────────────────────────────── */

// Deep-freeze every input handed to the core: any attempted write throws in
// strict mode, so obligation 14 is enforced, not merely observed.
function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.keys(value).forEach((key) => deepFreeze(value[key]));
  }
  return value;
}

function snapshot(value) {
  return JSON.stringify(value);
}

// The core runs in a vm realm, so its objects carry a different
// Object.prototype. Re-hydrate before any deep structural comparison.
function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function collectKinds(value, kind, out = []) {
  if (Array.isArray(value)) {
    value.forEach((entry) => collectKinds(entry, kind, out));
    return out;
  }
  if (value && typeof value === 'object') {
    if (value.kind === kind) out.push(value);
    Object.keys(value).forEach((key) => collectKinds(value[key], kind, out));
  }
  return out;
}

let checks = 0;
function ok(label, condition) {
  assert.ok(condition, label);
  checks += 1;
}

/* ── Fixtures: the T1 first-adapter mapping, as DATA only ──────────────── */
// No adapter code lives here or in shared/knowledge/. These literals exist
// only to prove the frozen captured-chat mapping is expressible in the
// generic v0 contracts. T3 owns the actual adapters.

const CHAT_ID = '6a9c227d-1f2b-4c3d-8e90-abcdef012345';
const CONTENT_HASH = `sha256-${'b'.repeat(64)}`;
const ANSWER_ID = 'msg_01H2OabcDEF';

const itemRefInput = deepFreeze({
  itemKind: 'captured_chat',
  scheme: 'chat-registry/chat-id',
  id: CHAT_ID,
});
const versionRefInput = deepFreeze({
  item: { ...itemRefInput },
  scheme: 'saved-chat/generation-content-hash',
  id: CONTENT_HASH,
});
const blockRefInput = deepFreeze({
  version: JSON.parse(JSON.stringify(versionRefInput)),
  blockKind: 'message',
  scheme: 'captured-chat/message-id',
  id: ANSWER_ID,
});

const blockRef = K.makeSemanticBlockRef(blockRefInput);
assert.ok(blockRef, 'fixture SemanticBlockRef must build');

function anchorInput(overrides = {}) {
  return deepFreeze({
    target: JSON.parse(JSON.stringify(blockRefInput)),
    selectors: { textQuote: { exact: 'the exact selected text' } },
    ...overrides,
  });
}
const anchor = K.makeAnchor(anchorInput());
assert.ok(anchor, 'fixture Anchor must build');

/* ── 1. valid ItemRef accepted ─────────────────────────────────────────── */

{
  const ref = K.makeItemRef(itemRefInput);
  ok('1: ItemRef built', !!ref);
  assert.deepEqual(plain(ref), {
    kind: 'item_ref',
    itemKind: 'captured_chat',
    scheme: 'chat-registry/chat-id',
    id: CHAT_ID,
  }, '1: ItemRef shape is exactly the frozen v0 shape');
  ok('1: validateItemRef accepts it', K.validateItemRef(ref).ok);
  ok('1: id consumed verbatim, never reminted', ref.id === CHAT_ID);
  ok('1: re-normalizing an ItemRef is idempotent', K.sameReference(K.makeItemRef(ref), ref));
  ok('1: output is detached from input', ref !== itemRefInput);
  // T1: no folder/category/tag/project fields on ItemRef.
  assert.deepEqual(Object.keys(ref), ['kind', 'itemKind', 'scheme', 'id'], '1: no extra ItemRef fields');
}

/* ── 2. invalid/missing ItemRef fields fail closed ─────────────────────── */

{
  const bad = [
    ['null input', null],
    ['non-object', 'chat-id'],
    ['array', []],
    ['missing itemKind', { scheme: 's', id: 'i' }],
    ['missing scheme', { itemKind: 'captured_chat', id: 'i' }],
    ['missing id', { itemKind: 'captured_chat', scheme: 's' }],
    ['empty id', { itemKind: 'captured_chat', scheme: 's', id: '' }],
    ['whitespace-padded id', { itemKind: 'captured_chat', scheme: 's', id: ' abc ' }],
    ['non-string id', { itemKind: 'captured_chat', scheme: 's', id: 12345 }],
    ['null id', { itemKind: 'captured_chat', scheme: 's', id: null }],
    ['wrong kind', { kind: 'version_ref', itemKind: 'captured_chat', scheme: 's', id: 'i' }],
    ['unknown key', { itemKind: 'captured_chat', scheme: 's', id: 'i', folderId: 'f_1' }],
  ];
  for (const [label, input] of bad) {
    ok(`2: rejected (${label})`, K.makeItemRef(deepFreeze(input)) === null);
  }
  // A numeric owner id is never coerced into a string identity.
  ok('2: no silent coercion', K.makeItemRef({ itemKind: 'k', scheme: 's', id: 7 }) === null);
  const report = K.validateItemRef({ kind: 'item_ref', itemKind: 'k', scheme: 's', id: '' });
  ok('2: validator reports the failing field', !report.ok && report.errors.includes('item_ref.id/invalid'));
  ok('2: validator rejects an unknown key directly', K.validateItemRef({
    ...plain(K.makeItemRef(itemRefInput)), folderId: 'f_1',
  }).ok === false);
}

/* ── 3. VersionRef requires an ItemRef and preserves its identity ──────── */

{
  ok('3: missing item rejected', K.makeVersionRef(deepFreeze({ scheme: 's', id: CONTENT_HASH })) === null);
  ok('3: null item rejected', K.makeVersionRef(deepFreeze({ item: null, scheme: 's', id: CONTENT_HASH })) === null);
  ok('3: invalid item rejected', K.makeVersionRef(deepFreeze({
    item: { itemKind: 'captured_chat', scheme: 's' }, scheme: 's', id: CONTENT_HASH,
  })) === null);
  ok('3: missing version id rejected', K.makeVersionRef(deepFreeze({ item: { ...itemRefInput }, scheme: 's' })) === null);

  const ref = K.makeVersionRef(versionRefInput);
  ok('3: VersionRef built', !!ref);
  ok('3: nested ItemRef identity preserved', K.sameReference(ref.item, K.makeItemRef(itemRefInput)));
  ok('3: owner version id preserved byte-exact', ref.id === CONTENT_HASH);
  ok('3: nested ItemRef is detached', ref.item !== versionRefInput.item);
  assert.deepEqual(Object.keys(ref), ['kind', 'item', 'scheme', 'id'], '3: no extra VersionRef fields');
  // Knowledge does not recompute or re-derive saved-chat identity.
  ok('3: version id not parsed or re-derived', ref.id.startsWith('sha256-') && ref.id === CONTENT_HASH);
  ok('3: validator rejects an item-less VersionRef directly',
    K.validateVersionRef({ kind: 'version_ref', scheme: 's', id: CONTENT_HASH }).ok === false);
  ok('3: validator rejects a malformed nested ItemRef directly', K.validateVersionRef({
    kind: 'version_ref', item: { kind: 'item_ref', itemKind: 'k', scheme: 's' }, scheme: 's', id: CONTENT_HASH,
  }).ok === false);
}

/* ── 4. SemanticBlockRef requires a VersionRef ─────────────────────────── */

{
  ok('4: missing version rejected', K.makeSemanticBlockRef(deepFreeze({
    blockKind: 'message', scheme: 'captured-chat/message-id', id: ANSWER_ID,
  })) === null);
  ok('4: item-in-place-of-version rejected', K.makeSemanticBlockRef(deepFreeze({
    version: { ...itemRefInput }, blockKind: 'message', scheme: 's', id: ANSWER_ID,
  })) === null);
  ok('4: missing blockKind rejected', K.makeSemanticBlockRef(deepFreeze({
    version: JSON.parse(JSON.stringify(versionRefInput)), scheme: 's', id: ANSWER_ID,
  })) === null);
  ok('4: missing block id rejected', K.makeSemanticBlockRef(deepFreeze({
    version: JSON.parse(JSON.stringify(versionRefInput)), blockKind: 'message', scheme: 's',
  })) === null);

  ok('4: block id is the owner message id', blockRef.id === ANSWER_ID);
  ok('4: chain reaches item identity', blockRef.version.item.id === CHAT_ID);
  assert.deepEqual(
    Object.keys(blockRef), ['kind', 'version', 'blockKind', 'scheme', 'id'],
    '4: no extra SemanticBlockRef fields',
  );
  ok('4: validator rejects a version-less block ref directly', K.validateSemanticBlockRef({
    kind: 'semantic_block_ref', blockKind: 'message', scheme: 's', id: ANSWER_ID,
  }).ok === false);
}

/* ── 5. Anchor requires SemanticBlockRef + textQuote.exact ─────────────── */

{
  ok('5: missing target rejected', K.makeAnchor(deepFreeze({
    selectors: { textQuote: { exact: 'x' } },
  })) === null);
  ok('5: invalid target rejected', K.makeAnchor(deepFreeze({
    target: { ...itemRefInput }, selectors: { textQuote: { exact: 'x' } },
  })) === null);
  ok('5: missing selectors rejected', K.makeAnchor(anchorInput({ selectors: undefined })) === null);
  ok('5: missing textQuote rejected', K.makeAnchor(anchorInput({ selectors: {} })) === null);
  ok('5: empty exact rejected', K.makeAnchor(anchorInput({ selectors: { textQuote: { exact: '' } } })) === null);
  ok('5: non-string exact rejected', K.makeAnchor(anchorInput({ selectors: { textQuote: { exact: 42 } } })) === null);
  ok('5: textPos alone rejected', K.makeAnchor(anchorInput({ selectors: { textPos: { start: 0, end: 4 } } })) === null);
  ok('5: unknown selector family fails closed', K.makeAnchor(anchorInput({
    selectors: { textQuote: { exact: 'x' }, cssSelector: { value: '.a' } },
  })) === null);
  ok('5: unknown textQuote key fails closed', K.makeAnchor(anchorInput({
    selectors: { textQuote: { exact: 'x', fuzzy: true } },
  })) === null);

  ok('5: anchor built', !!anchor);
  ok('5: anchor targets the block ref', K.sameReference(anchor.target, blockRef));
  ok('5: exact preserved verbatim', anchor.selectors.textQuote.exact === 'the exact selected text');
  // Content strings are never whitespace-normalized.
  const padded = K.makeAnchor(anchorInput({ selectors: { textQuote: { exact: '  spaced  ' } } }));
  ok('5: exact is not trimmed', padded.selectors.textQuote.exact === '  spaced  ');
  ok('5: validateAnchor accepts', K.validateAnchor(anchor).ok);
  ok('5: validator rejects a quote-less anchor directly', K.validateAnchor({
    kind: 'anchor', target: plain(blockRef), selectors: {},
  }).ok === false);
  ok('5: validator rejects a target-less anchor directly', K.validateAnchor({
    kind: 'anchor', selectors: { textQuote: { exact: 'x' } },
  }).ok === false);
}

/* ── 6. malformed textPos is rejected ──────────────────────────────────── */

{
  const badPos = [
    ['start > end', { start: 9, end: 4 }],
    ['start === end', { start: 4, end: 4 }],
    ['negative start', { start: -1, end: 4 }],
    ['non-integer start', { start: 1.5, end: 4 }],
    ['non-integer end', { start: 1, end: 4.25 }],
    ['NaN start', { start: Number.NaN, end: 4 }],
    ['Infinity end', { start: 0, end: Number.POSITIVE_INFINITY }],
    ['missing end', { start: 0 }],
    ['string bounds', { start: '0', end: '4' }],
    ['unknown key', { start: 0, end: 4, container: 'p[2]' }],
    ['not an object', 'ok'],
  ];
  for (const [label, textPos] of badPos) {
    ok(`6: textPos rejected (${label})`, K.makeAnchor(anchorInput({
      selectors: { textQuote: { exact: 'x' }, textPos },
    })) === null);
  }
  const withPos = K.makeAnchor(anchorInput({
    selectors: { textQuote: { exact: 'x' }, textPos: { start: 0, end: 4 } },
  }));
  ok('6: valid textPos accepted', !!withPos);
  assert.deepEqual(plain(withPos.selectors.textPos), { start: 0, end: 4 }, '6: textPos preserved exactly');
  // T1 §8: textPos is never proof on its own - it stays paired with the
  // required textQuote.exact that the incumbent resolver validates against.
  ok('6: textPos never stands alone', typeof withPos.selectors.textQuote.exact === 'string');
}

/* ── 7. optional prefix/suffix/approx preserved correctly ──────────────── */

{
  const full = K.makeAnchor(anchorInput({
    selectors: { textQuote: { exact: 'core', prefix: 'before ', suffix: ' after', approx: 128 } },
  }));
  ok('7: full quote built', !!full);
  assert.deepEqual(plain(full.selectors.textQuote), {
    exact: 'core', prefix: 'before ', suffix: ' after', approx: 128,
  }, '7: all optional fields preserved verbatim');

  // Falsy-but-valid values must survive rather than be dropped.
  const falsy = K.makeAnchor(anchorInput({
    selectors: { textQuote: { exact: 'core', prefix: '', suffix: '', approx: 0 } },
  }));
  ok('7: empty prefix preserved', falsy.selectors.textQuote.prefix === '');
  ok('7: empty suffix preserved', falsy.selectors.textQuote.suffix === '');
  ok('7: approx 0 preserved', falsy.selectors.textQuote.approx === 0);

  const omitted = K.makeAnchor(anchorInput());
  ok('7: absent optionals stay absent', !('prefix' in omitted.selectors.textQuote)
    && !('suffix' in omitted.selectors.textQuote)
    && !('approx' in omitted.selectors.textQuote));

  ok('7: non-string prefix rejected', K.makeAnchor(anchorInput({
    selectors: { textQuote: { exact: 'core', prefix: 12 } },
  })) === null);
  ok('7: non-finite approx rejected', K.makeAnchor(anchorInput({
    selectors: { textQuote: { exact: 'core', approx: Number.NaN } },
  })) === null);
  ok('7: string approx rejected', K.makeAnchor(anchorInput({
    selectors: { textQuote: { exact: 'core', approx: '12' } },
  })) === null);
}

/* ── 8. deferred XPath is data, not a resolver capability ──────────────── */

{
  ok('8: xpath is not an active selector family', K.supportsSelector('xpath') === false);
  ok('8: xpath is declared deferred', K.isDeferredSelector('xpath') === true);
  assert.deepEqual([...K.SELECTOR_FAMILIES], ['textQuote', 'textPos'], '8: active families frozen');
  assert.deepEqual([...K.DEFERRED_SELECTOR_FAMILIES], ['xpath'], '8: deferred families frozen');

  const xpathPayload = { startXPath: './/p[1]/text()[1]', startOffset: 3, endXPath: './/p[1]/text()[1]', endOffset: 19 };
  const withXPath = K.makeAnchor(anchorInput({
    selectors: { textQuote: { exact: 'core' } },
    deferredSelectors: { xpath: xpathPayload },
  }));
  ok('8: deferred xpath preserved', !!withXPath);
  assert.deepEqual(plain(withXPath.deferredSelectors.xpath), xpathPayload, '8: xpath bytes preserved intact');
  ok('8: xpath clone is detached', withXPath.deferredSelectors.xpath !== xpathPayload);

  // Carrying xpath never substitutes for the required quote selector.
  ok('8: xpath cannot replace textQuote', K.makeAnchor(anchorInput({
    selectors: {},
    deferredSelectors: { xpath: xpathPayload },
  })) === null);
  ok('8: xpath is not admitted as an active family', K.makeAnchor(anchorInput({
    selectors: { textQuote: { exact: 'core' }, xpath: xpathPayload },
  })) === null);
  ok('8: unknown deferred family fails closed', K.makeAnchor(anchorInput({
    selectors: { textQuote: { exact: 'core' } },
    deferredSelectors: { xpath: xpathPayload, cssPath: '.a' },
  })) === null);

  // No result may ever claim xpath resolved anything.
  ok('8: selectorUsed xpath rejected', K.makeReanchorResult(deepFreeze({
    status: 'reanchored', anchor: anchorInput(), span: { start: 0, end: 4 },
    selectorUsed: 'xpath', confidence: 0.75, reason: 'xpath',
  })) === null);

  // The module ships no resolver at all: resolution stays with the incumbent.
  const resolverLike = Object.keys(K).filter((key) => /resolve|evaluate|match|search/i.test(key));
  assert.deepEqual(resolverLike, [], '8: contract module exposes no resolver entry point');
  ok('8: diagnose reports no resolver', K.diagnose().selectors.resolvesDeferred === false
    && K.diagnose().selectors.resolverIncluded === false);
}

/* ── 9. Provenance preserves derivation/source without mutation ────────── */

{
  const input = deepFreeze({ derivation: 'anchor_resolution', source: anchorInput() });
  const before = snapshot(input);
  const provenance = K.makeProvenance(input);
  ok('9: provenance built', !!provenance);
  assert.deepEqual(Object.keys(provenance), ['kind', 'derivation', 'source'], '9: exact frozen shape');
  ok('9: derivation preserved', provenance.derivation === 'anchor_resolution');
  ok('9: source is the anchor', K.sameReference(provenance.source, anchor));
  ok('9: source is detached', provenance.source !== input.source);
  ok('9: input untouched', snapshot(input) === before);

  ok('9: missing derivation rejected', K.makeProvenance(deepFreeze({ source: anchorInput() })) === null);
  ok('9: unadmitted derivation rejected', K.makeProvenance(deepFreeze({
    derivation: 'manual_entry', source: anchorInput(),
  })) === null);
  ok('9: missing source rejected', K.makeProvenance(deepFreeze({ derivation: 'anchor_resolution' })) === null);
  ok('9: invalid source rejected', K.makeProvenance(deepFreeze({
    derivation: 'anchor_resolution', source: { kind: 'anchor' },
  })) === null);
  assert.deepEqual([...K.DERIVATIONS], ['anchor_resolution'], '9: only the first-slice derivation is admitted');
  ok('9: validator rejects an unadmitted derivation directly', K.validateProvenance({
    kind: 'provenance', derivation: 'manual_entry', source: plain(anchor),
  }).ok === false);
  ok('9: validator rejects a source-less provenance directly',
    K.validateProvenance({ kind: 'provenance', derivation: 'anchor_resolution' }).ok === false);
  // Not Library's source-marker array and not Saved-Chat package provenance.
  ok('9: provenance is not an array-shaped ledger', !Array.isArray(provenance)
    && K.makeProvenance(deepFreeze({ derivation: 'anchor_resolution', source: anchorInput(), entries: [] })) === null);
}

/* ── 10. Excerpt requires explicit source/provenance binding ───────────── */

{
  const provenance = K.makeProvenance({ derivation: 'anchor_resolution', source: anchorInput() });

  ok('10: missing provenance rejected', K.makeExcerpt(deepFreeze({ text: 'resolved text' })) === null);
  ok('10: null provenance rejected', K.makeExcerpt(deepFreeze({ text: 'resolved text', provenance: null })) === null);
  ok('10: malformed provenance rejected', K.makeExcerpt(deepFreeze({
    text: 'resolved text', provenance: { kind: 'provenance', derivation: 'anchor_resolution' },
  })) === null);
  ok('10: missing text rejected', K.makeExcerpt(deepFreeze({ provenance })) === null);
  ok('10: empty text rejected', K.makeExcerpt(deepFreeze({ text: '', provenance })) === null);
  ok('10: non-string text rejected', K.makeExcerpt(deepFreeze({ text: 12, provenance })) === null);

  const excerpt = K.makeExcerpt({ text: '  exact resolved text  ', provenance });
  ok('10: excerpt built', !!excerpt);
  assert.deepEqual(Object.keys(excerpt), ['kind', 'text', 'provenance'], '10: exact frozen shape');
  ok('10: text preserved verbatim, not display-normalized', excerpt.text === '  exact resolved text  ');
  ok('10: bound back to item identity', excerpt.provenance.source.target.version.item.id === CHAT_ID);
  ok('10: bound back to block identity', excerpt.provenance.source.target.id === ANSWER_ID);

  // The provenance source must be the very Anchor the excerpt came from.
  ok('10: matching anchor cross-check passes',
    !!K.makeExcerpt({ text: 'x', provenance }, { anchor: anchorInput() }));
  const otherAnchor = anchorInput({ selectors: { textQuote: { exact: 'a different quote' } } });
  ok('10: mismatched anchor cross-check fails closed',
    K.makeExcerpt({ text: 'x', provenance }, { anchor: otherAnchor }) === null);

  // The binding rule must hold in the validator itself, not only through the
  // constructor's provenance gate.
  ok('10: validator rejects an unbound excerpt directly',
    K.validateExcerpt({ kind: 'excerpt', text: 'resolved text' }).ok === false);
  ok('10: validator rejects a null binding directly',
    K.validateExcerpt({ kind: 'excerpt', text: 'resolved text', provenance: null }).ok === false);
  ok('10: validator rejects a malformed binding directly', K.validateExcerpt({
    kind: 'excerpt', text: 'resolved text', provenance: { kind: 'provenance', derivation: 'anchor_resolution' },
  }).ok === false);
  ok('10: validator rejects a binding whose source is not an Anchor directly', K.validateExcerpt({
    kind: 'excerpt', text: 'resolved text',
    provenance: { kind: 'provenance', derivation: 'anchor_resolution', source: plain(blockRef) },
  }).ok === false);

  // Library/archive preview fields named `excerpt` are a different thing.
  ok('10: a bare preview string is not an Excerpt', K.validateExcerpt('some preview text…').ok === false);
}

/* ── 11. ReanchorResult allows only anchored/reanchored/orphaned ───────── */

const baseResult = deepFreeze({
  status: 'anchored',
  anchor: anchorInput(),
  span: { start: 0, end: 4 },
  selectorUsed: 'textQuote',
  confidence: 1,
  reason: 'textQuote-exact',
  diagnostics: { tried: ['textQuote'], matchCount: 1, approx: null, xpathDeferred: false, notes: [] },
});

{
  assert.deepEqual([...K.REANCHOR_STATUSES], ['anchored', 'reanchored', 'orphaned'], '11: frozen status set');

  const anchored = K.makeReanchorResult(baseResult);
  ok('11: anchored accepted', !!anchored && anchored.status === 'anchored');

  const reanchored = K.makeReanchorResult(deepFreeze({
    ...baseResult, status: 'reanchored', selectorUsed: 'textPos', confidence: 0.75, reason: 'textPos-validated',
  }));
  ok('11: reanchored accepted', !!reanchored && reanchored.selectorUsed === 'textPos');

  const orphaned = K.makeReanchorResult(deepFreeze({
    status: 'orphaned', anchor: anchorInput(), span: null, selectorUsed: null,
    confidence: 0, reason: 'no-safe-match',
    diagnostics: { tried: ['textQuote', 'textPos'], matchCount: 0, approx: null, xpathDeferred: false, notes: [] },
  }));
  ok('11: orphaned accepted', !!orphaned && orphaned.span === null && orphaned.selectorUsed === null);

  for (const status of ['resolved', 'partial', 'ANCHORED', '', null, undefined, 1]) {
    ok(`11: rejected status ${JSON.stringify(status)}`,
      K.makeReanchorResult(deepFreeze({ ...baseResult, status })) === null);
  }

  // Status/selector coherence frozen from the incumbent resolver.
  ok('11: anchored must use textQuote',
    K.makeReanchorResult(deepFreeze({ ...baseResult, selectorUsed: 'textPos' })) === null);
  ok('11: reanchored must use textPos',
    K.makeReanchorResult(deepFreeze({ ...baseResult, status: 'reanchored' })) === null);
  ok('11: orphaned may not carry a span',
    K.makeReanchorResult(deepFreeze({ ...baseResult, status: 'orphaned', selectorUsed: null })) === null);
  ok('11: a resolved status may not omit its span',
    K.makeReanchorResult(deepFreeze({ ...baseResult, span: null })) === null);
  ok('11: malformed span rejected',
    K.makeReanchorResult(deepFreeze({ ...baseResult, span: { start: 4, end: 4 } })) === null);
  ok('11: malformed diagnostics rejected',
    K.makeReanchorResult(deepFreeze({ ...baseResult, diagnostics: { tried: 'textQuote' } })) === null);
  ok('11: negative matchCount rejected', K.makeReanchorResult(deepFreeze({
    ...baseResult, diagnostics: { ...baseResult.diagnostics, matchCount: -1 },
  })) === null);
  ok('11: missing anchor rejected',
    K.makeReanchorResult(deepFreeze({ ...baseResult, anchor: undefined })) === null);

  assert.deepEqual(Object.keys(anchored), [
    'kind', 'status', 'versionScope', 'anchor', 'span', 'selectorUsed', 'confidence', 'reason', 'diagnostics',
  ], '11: exact frozen ReanchorResult shape');
}

/* ── 12. versionScope is same_version ──────────────────────────────────── */

{
  ok('12: constant is same_version', K.VERSION_SCOPE === 'same_version');
  assert.deepEqual([...K.REANCHOR_VERSION_SCOPES], ['same_version'], '12: exactly one admitted scope');

  const defaulted = K.makeReanchorResult(baseResult);
  ok('12: omitted versionScope defaults to same_version', defaulted.versionScope === 'same_version');

  const restated = K.makeReanchorResult(deepFreeze({ ...baseResult, versionScope: 'same_version' }));
  ok('12: restating the fixed scope is accepted', restated.versionScope === 'same_version');

  ok('12: validator rejects a substituted scope', K.validateReanchorResult({
    ...defaulted, versionScope: 'cross_version',
  }).ok === false);
}

/* ── 13. cross-version claims are impossible in v0 ─────────────────────── */

{
  for (const scope of ['cross_version', 'any_version', 'latest', '', null]) {
    ok(`13: rejected versionScope ${JSON.stringify(scope)}`,
      K.makeReanchorResult(deepFreeze({ ...baseResult, versionScope: scope })) === null);
  }

  // No second version reference can ride along inside a result.
  for (const extra of [{ fromVersion: versionRefInput }, { toVersion: versionRefInput }, { versions: [] }]) {
    ok(`13: extra version field rejected (${Object.keys(extra)[0]})`,
      K.makeReanchorResult(deepFreeze({ ...baseResult, ...extra })) === null);
  }
  const smuggled = K.validateReanchorResult({ ...K.makeReanchorResult(baseResult), toVersion: versionRefInput });
  ok('13: validator names the smuggled key', !smuggled.ok
    && smuggled.errors.some((code) => code === 'reanchor_result/unknown-key:toVersion'));

  // A result structurally binds exactly one version, reached through its anchor.
  const built = K.makeReanchorResult(baseResult);
  const versions = collectKinds(built, 'version_ref');
  ok('13: exactly one VersionRef is reachable', versions.length === 1);
  ok('13: that version is the anchored one', versions[0].id === CONTENT_HASH);
  ok('13: reanchored means same-version fallback only',
    K.makeReanchorResult(deepFreeze({
      ...baseResult, status: 'reanchored', selectorUsed: 'textPos', confidence: 0.75, reason: 'textPos-validated',
    })).versionScope === 'same_version');
  ok('13: diagnose declares no cross-version capability', K.diagnose().reanchor.crossVersion === false);
}

/* ── 14. input objects are not mutated ─────────────────────────────────── */

{
  // Every input above was deep-frozen, so any write attempt would already
  // have thrown. This section additionally proves value-level immutability
  // and output detachment.
  const cases = [
    ['ItemRef', itemRefInput, (v) => K.makeItemRef(v)],
    ['VersionRef', versionRefInput, (v) => K.makeVersionRef(v)],
    ['SemanticBlockRef', blockRefInput, (v) => K.makeSemanticBlockRef(v)],
    ['Anchor', anchorInput({
      selectors: { textQuote: { exact: 'core', prefix: 'p', approx: 3 }, textPos: { start: 1, end: 5 } },
      deferredSelectors: { xpath: { startXPath: './/p[1]', startOffset: 0, endXPath: './/p[1]', endOffset: 4 } },
    }), (v) => K.makeAnchor(v)],
    ['Provenance', deepFreeze({ derivation: 'anchor_resolution', source: anchorInput() }), (v) => K.makeProvenance(v)],
    ['ReanchorResult', baseResult, (v) => K.makeReanchorResult(v)],
  ];
  for (const [label, input, build] of cases) {
    const before = snapshot(input);
    const out = build(input);
    ok(`14: ${label} built`, !!out);
    ok(`14: ${label} input unchanged`, snapshot(input) === before);
    ok(`14: ${label} output detached`, out !== input);
  }

  const excerptInput = deepFreeze({
    text: 'resolved',
    provenance: { kind: 'provenance', derivation: 'anchor_resolution', source: anchorInput() },
  });
  const excerptBefore = snapshot(excerptInput);
  const excerpt = K.makeExcerpt(excerptInput);
  ok('14: Excerpt built', !!excerpt);
  ok('14: Excerpt input unchanged', snapshot(excerptInput) === excerptBefore);

  // Mutating an output never reaches back into any input.
  const live = K.makeAnchor(anchorInput());
  live.selectors.textQuote.exact = 'MUTATED';
  live.target.version.item.id = 'MUTATED';
  ok('14: output mutation does not reach the input',
    anchorInput().selectors.textQuote.exact === 'the exact selected text'
    && itemRefInput.id === CHAT_ID);
  ok('14: a fresh build is unaffected', K.makeAnchor(anchorInput()).selectors.textQuote.exact === 'the exact selected text');

  // Validators are read-only too.
  const frozenResult = deepFreeze(K.makeReanchorResult(baseResult));
  const validateBefore = snapshot(frozenResult);
  ok('14: validateReanchorResult is read-only', K.validateReanchorResult(frozenResult).ok
    && snapshot(frozenResult) === validateBefore);
}

/* ── 15. no persistence/browser/network APIs in shared/knowledge/ ──────── */

{
  // Inventory lock: every module in the Lane's source home is scanned below,
  // so a new file must be admitted here deliberately rather than slip in
  // unscanned. T3 added the captured-chat compatibility adapter.
  const files = fs.readdirSync(knowledgeDir).filter((name) => /\.(js|mjs|cjs)$/.test(name)).sort();
  assert.deepEqual(files, [
    'captured-chat-highlight-adapter-v0.js',
    'contracts-v0.js',
  ], '15: shared/knowledge holds exactly the admitted v0 modules');

  // Scan a code-only view: a bare-word scan over raw source would fire on the
  // module's own purity disclaimers in its header comment.
  function stripComments(src) {
    let out = '';
    let state = 'code';
    let i = 0;
    while (i < src.length) {
      const c = src[i];
      const n = src[i + 1];
      if (state === 'code') {
        if (c === '/' && n === '/') { state = 'line'; i += 2; continue; }
        if (c === '/' && n === '*') { state = 'block'; i += 2; continue; }
        if (c === "'") state = 'sq';
        else if (c === '"') state = 'dq';
        else if (c === '`') state = 'tpl';
        out += c; i += 1; continue;
      }
      if (state === 'line') { if (c === '\n') { state = 'code'; out += c; } i += 1; continue; }
      if (state === 'block') {
        if (c === '*' && n === '/') { state = 'code'; i += 2; } else { if (c === '\n') out += c; i += 1; }
        continue;
      }
      if (c === '\\') { out += c + (n === undefined ? '' : n); i += 2; continue; }
      if ((state === 'sq' && c === "'") || (state === 'dq' && c === '"') || (state === 'tpl' && c === '`')) {
        state = 'code';
      }
      out += c; i += 1;
    }
    return out;
  }

  const BANNED = [
    'localStorage', 'sessionStorage', 'indexedDB', 'IDBFactory', 'openDatabase', 'caches',
    'document', 'window', 'navigator', 'location', 'history', 'alert',
    'fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'sendBeacon',
    'chrome', 'browser', 'importScripts', 'require', 'process', 'Deno', 'Buffer',
    'setTimeout', 'setInterval', 'queueMicrotask', 'Date', 'performance', 'random',
    'eval', 'Function',
  ];

  for (const name of files) {
    const filePath = path.join(knowledgeDir, name);
    const raw = fs.readFileSync(filePath, 'utf8');
    const code = stripComments(raw);

    // If the stripper had mangled a literal, the code-only view would not
    // parse - so this also proves the scan below ran over real code.
    assert.doesNotThrow(() => new vm.Script(code), `15: ${name} code-only view must still parse`);
    ok(`15: ${name} has a header comment the scan removed`, code.length < raw.length);

    for (const token of BANNED) {
      const hit = new RegExp(`\\b${token}\\b`).test(code);
      ok(`15: ${name} does not reference ${token}`, hit === false);
    }
    ok(`15: ${name} declares no imports/exports`, !/\bimport\s|\bexport\s|module\.exports/.test(code));
  }

  // The sandbox proves it dynamically: the core loaded and ran with no host
  // globals beyond `console`, and touched nothing but its own namespace.
  assert.deepEqual(
    Object.keys(sandbox).filter((key) => key !== 'console' && key !== 'globalThis'),
    ['H2O'],
    '15: loading the core creates exactly one global namespace',
  );
  assert.deepEqual(Object.keys(sandbox.H2O).sort(), ['Knowledge', 'KnowledgeContractsV0'],
    '15: only the Knowledge namespace and its alias are published');

  const d = K.diagnose();
  assert.deepEqual(plain(d.sideEffects), {
    dom: false, storage: false, network: false, persistence: false, migrations: false,
    propagation: false, writes: false, clock: false, randomness: false, inputMutation: false,
  }, '15: diagnose declares the purity contract');
  ok('15: not wired into runtime', d.runtimeWired === false && d.adaptersWired === false);
  ok('15: declared experimental at contractVersion 0', d.experimental === true && d.contractVersion === 0);
  assert.deepEqual(plain(d.contracts), [
    'item_ref', 'version_ref', 'semantic_block_ref', 'anchor', 'provenance', 'excerpt', 'reanchor_result',
  ], '15: exactly the seven admitted v0 contracts');
}

console.log(`[validate-knowledge-contracts-v0] ok — ${checks} checks across 15 obligations`);
