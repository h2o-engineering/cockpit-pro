#!/usr/bin/env node
//
// Lane: L-COCKPIT-KNOWLEDGE-MODEL
// Mission: knowledge-model-exact-reference-runtime-adoption-v0 (T3)
//
// Runtime proof for the Knowledge exact-reference consumer.
//
// REAL vs HARNESSED — stated plainly so the evidence is not overread:
//   REAL      the T2 Studio mirrors (contracts + captured-chat adapter), the
//             T3 consumer, and the incumbent plain-text anchor resolver.
//   HARNESSED the four owner APIs, because the real Reader consumer needs a
//             live DOM and the real coverage API needs Tauri + SQLite. The
//             resolution harness does NOT invent verdicts: it delegates each
//             one to the REAL incumbent resolver and shapes the row exactly as
//             highlight-resolution-consumer.studio.js does, taking
//             `text = plain.slice(span.start, span.end)` — which the DOM
//             wrapper guarantees equals `range.toString()` (it refuses to
//             return a range otherwise, anchor-resolver-dom.studio.js:155).
//
// Obligations: A admission · B inert/default-off · C owner identity ·
// D Saved-Chat authority · E real composition chain · F anchored ·
// G reanchored · H orphan · I annotation join · J immutability ·
// K contract regression.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

import {
  ARCHIVE_WORKBENCH_SOURCE_FILES,
  ARCHIVE_WORKBENCH_OUT_FILES,
  parseStudioHtmlScriptRefs,
} from '../../product/studio/pack-studio.mjs';

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), '../../..');
const STUDIO_DIR = path.join(repoRoot, 'src-surfaces-base/studio');

const CONTRACTS = 'src-surfaces-base/studio/knowledge/contracts-v0.studio.js';
const ADAPTER = 'src-surfaces-base/studio/knowledge/captured-chat-highlight-adapter-v0.studio.js';
const CONSUMER = 'src-surfaces-base/studio/knowledge/exact-reference-consumer.studio.js';
const RESOLVER = 'src-surfaces-base/studio/reader-notes/anchor-resolver.studio.js';

const CONSUMER_PACK = 'knowledge/exact-reference-consumer.studio.js';
const CONSUMER_FLAG = 'studio.knowledge.exactReferences.enabled';
const RESOLVER_FLAG = 'studio.readerNotes.anchorResolver.enabled';

let checks = 0;
function ok(label, condition) {
  assert.ok(condition, label);
  checks += 1;
}
function read(rel) {
  return fs.readFileSync(path.join(repoRoot, rel), 'utf8');
}
function plain(v) {
  return v === null || v === undefined ? v : JSON.parse(JSON.stringify(v));
}
function snapshot(v) {
  return JSON.stringify(v);
}
function deepFreeze(v) {
  if (v && typeof v === 'object' && !Object.isFrozen(v)) {
    Object.freeze(v);
    Object.keys(v).forEach((k) => deepFreeze(v[k]));
  }
  return v;
}

/* ══ Production-shaped owner fixtures ══════════════════════════════════ */

const CHAT_ID = '6a9c227d-1f2b-4c3d-8e90-abcdef012345';
const CONTENT_HASH = `sha256-${'b'.repeat(64)}`;
const OTHER_HASH = `sha256-${'c'.repeat(64)}`;
const ANSWER_ID = 'msg_01H2OabcDEF';
const NATIVE_ID = 'hl_7f3a';
const ANNOTATION_ID = `highlight:${CHAT_ID}:${ANSWER_ID}:${NATIVE_ID}`;

// library-item-view.studio.js buildItem() shape.
function capturedChatItem(overrides) {
  return deepFreeze(Object.assign({
    schemaVersion: 1,
    kind: 'captured_chat',
    id: CHAT_ID,
    title: 'Knowledge Model exact references',
    identity: { authority: 'chat-registry', chatId: CHAT_ID },
    content: { kind: 'captured_chat', snapshotId: 'snap_0091', snapshotCount: 3, messageCount: 12 },
    metadata: {
      category: { kind: 'category_ref', value: null, flattened: false },
      labels: { kind: 'label_assignments_ref', value: null, flattened: false },
      tags: [],
      folder: null,
    },
    raw: { libraryIndexRow: null, chatRegistryRecord: null },
  }, overrides || {}));
}

// saved-chat-coverage.tauri.js entryFrom() shape.
function coverageEntry(overrides) {
  return Object.assign({
    packagePath: `/archive/packages/${CHAT_ID}.g${'b'.repeat(64)}.h2ochat`,
    packageDirName: `${CHAT_ID}.g${'b'.repeat(64)}.h2ochat`,
    classification: 'generation',
    chatId: CHAT_ID,
    snapshotId: 'snap_0091',
    schemaVersion: 2,
    payloadVersion: 2,
    contentHash: CONTENT_HASH,
    savedAt: '2026-09-09T12:00:00.000Z',
    status: 'ok',
    blockers: [],
  }, overrides || {});
}

// describeSavedChatCoverageV1() result shape.
function coverageResult(overrides) {
  const entry = coverageEntry((overrides || {}).entry);
  const base = {
    chatId: CHAT_ID,
    projection: {
      status: 'ok',
      reason: '',
      contentHash: CONTENT_HASH,
      snapshotId: 'snap_0091',
      schemaVersion: 2,
      liveGenerationFamily: 'v1v2',
    },
    legacy: [],
    generations: [entry],
    unusable: [],
    fresh: [entry],
    stale: [],
    preserved: true,
    covered: true,
    selected: entry,
    bestHistorical: null,
    bestHistoricalTies: [],
    complete: true,
    reason: '',
  };
  const merged = Object.assign(base, overrides || {});
  delete merged.entry;
  return deepFreeze(merged);
}

// annotation-facade.studio.js mapAttributedHighlight() shape.
function highlightAnnotation(anchors, overrides) {
  return deepFreeze(Object.assign({
    schemaVersion: 1,
    kind: 'highlight',
    id: ANNOTATION_ID,
    item: { kind: 'captured_chat', id: CHAT_ID },
    attribution: 'attributed',
    source: {
      store: 'highlights', chatId: CHAT_ID, answerId: ANSWER_ID,
      nativeId: NATIVE_ID, convoId: null,
    },
    body: { color: 'yellow', text: 'preview text — NOT the excerpt', createdAt: 1757462400000 },
    raw: { id: NATIVE_ID, ts: 1757462400000, color: 'yellow', anchors },
  }, overrides || {}));
}

// Mirrors the highlights engine's TXT_rangeToQuote(range, root, 32).
function quoteFrom(text, exact, ctx = 32) {
  const start = text.indexOf(exact);
  const end = start + exact.length;
  return {
    exact,
    prefix: text.slice(Math.max(0, start - ctx), start),
    suffix: text.slice(end, end + ctx),
    approx: start,
  };
}

const PLAIN_A = 'The consumer reports 175 checks across obligations A to L today.';
const EXACT_A = 'reports 175 checks';
// Captured across a soft line break; the flattened text now holds a space.
const PLAIN_B = 'The result is hello world today.';
const EXACT_B = 'hello\nworld';
const PLAIN_C = 'pre TERM mid1 pre TERM end';

/* ══ Harness ═══════════════════════════════════════════════════════════ */

const OPAQUE_TOKEN = Object.freeze({ policy: 'opaque-capability-token' });

function makeRealm(opts = {}) {
  const sandbox = { console };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  for (const rel of [CONTRACTS, ADAPTER, RESOLVER, CONSUMER]) {
    vm.runInContext(read(rel), sandbox, { filename: rel });
  }

  const calls = {
    libraryGet: 0, coverage: 0, annotations: 0, resolve: 0,
    forbiddenIngestion: 0,
  };
  const seen = { chatId: null, token: null, root: null, options: null };

  sandbox.H2O.flags = {
    get(key, fallback) {
      if (key === RESOLVER_FLAG) return true;
      if (key === CONSUMER_FLAG) return opts.enabled !== false;
      return fallback;
    },
  };

  const resolver = sandbox.H2O.Studio.readerNotes.anchorResolver;
  const annotations = opts.annotations || [];
  const plainText = opts.plainText || PLAIN_A;

  sandbox.H2O.Studio.readerNotes.libraryItems = {
    isEnabled: () => true,
    get(itemId) {
      calls.libraryGet += 1;
      return opts.item === undefined ? capturedChatItem() : opts.item;
    },
  };

  sandbox.H2O.Studio.readerNotes.annotations = {
    isEnabled: () => true,
    listForItem(itemId, options) {
      calls.annotations += 1;
      if (opts.annotationsThrow) throw new Error('annotations boom');
      return opts.annotationList === undefined ? annotations : opts.annotationList;
    },
  };

  // Delegates every verdict to the REAL incumbent resolver; shapes the row
  // exactly as the real Reader consumer does.
  sandbox.H2O.Studio.readerNotes.highlightResolutionConsumer = {
    isEnabled: () => true,
    resolveForItem(itemId, root, options) {
      calls.resolve += 1;
      seen.root = root;
      seen.options = options;
      if (opts.resolveThrow) throw new Error('resolve boom');
      if (opts.resolveResult !== undefined) return opts.resolveResult;
      const resolved = [];
      const unresolved = [];
      for (const annotation of annotations) {
        const anchors = plain(annotation.raw && annotation.raw.anchors);
        const r = resolver.resolveInText(anchors, plainText, {});
        const row = {
          annotationId: annotation.id,
          nativeId: annotation.source.nativeId,
          answerId: annotation.source.answerId,
          source: plain(annotation.source),
          status: r.status,
          span: r.span ? { start: r.span.start, end: r.span.end } : null,
          selectorUsed: r.selectorUsed || null,
          confidence: Number.isFinite(r.confidence) ? r.confidence : 0,
          reason: r.reason || '',
          text: '',
          diagnostics: plain(r.diagnostics || {}),
        };
        if (r.status === 'anchored' || r.status === 'reanchored') {
          row.text = plainText.slice(r.span.start, r.span.end);
          resolved.push(row);
        } else {
          unresolved.push(row);
        }
      }
      return {
        schemaVersion: 1, itemId, resolved, unresolved,
        diagnostics: { reason: 'ok', considered: annotations.length },
      };
    },
  };

  sandbox.H2O.Studio.ingestion = {
    describeSavedChatCoverageV1(options, policyToken) {
      calls.coverage += 1;
      seen.chatId = options && options.chatId;
      seen.token = policyToken;
      if (opts.coverageThrow) throw new Error('coverage boom');
      return Promise.resolve(opts.coverage === undefined ? coverageResult() : opts.coverage);
    },
    // Lower-level owner APIs Knowledge must never touch.
    listSavedChatArchivePackagesV1() { calls.forbiddenIngestion += 1; throw new Error('forbidden'); },
    validateSavedChatPackageV1() { calls.forbiddenIngestion += 1; throw new Error('forbidden'); },
    probeCurrentSavedChatProjectionV1() { calls.forbiddenIngestion += 1; throw new Error('forbidden'); },
  };

  return {
    sandbox,
    calls,
    seen,
    consumer: sandbox.H2O.Studio.knowledge.exactReferences,
    contracts: sandbox.H2O.Knowledge.ContractsV0,
    describe: (itemId = CHAT_ID, root = { opaque: 'reader-root' }, options = { policyToken: OPAQUE_TOKEN }) =>
      sandbox.H2O.Studio.knowledge.exactReferences.describeForItemV1(itemId, root, options),
  };
}

/* ══ A. Admission ══════════════════════════════════════════════════════ */

{
  ok('A: consumer file exists', fs.existsSync(path.join(repoRoot, CONSUMER)));

  const refs = parseStudioHtmlScriptRefs(fs.readFileSync(path.join(STUDIO_DIR, 'studio.html'), 'utf8'));
  const iContracts = refs.indexOf('knowledge/contracts-v0.studio.js');
  const iAdapter = refs.indexOf('knowledge/captured-chat-highlight-adapter-v0.studio.js');
  const iConsumer = refs.indexOf(CONSUMER_PACK);
  ok('A: consumer admitted in studio.html', iConsumer !== -1);
  ok('A: order is contracts -> adapter -> consumer',
    iContracts !== -1 && iContracts < iAdapter && iAdapter < iConsumer);
  ok('A: consumer admitted exactly once', refs.filter((r) => r === CONSUMER_PACK).length === 1);

  const inIdx = ARCHIVE_WORKBENCH_SOURCE_FILES.indexOf(CONSUMER_PACK);
  const outIdx = ARCHIVE_WORKBENCH_OUT_FILES.indexOf(CONSUMER_PACK);
  ok('A: consumer packed in SOURCE list', inIdx !== -1);
  ok('A: consumer packed in OUT list', outIdx !== -1);
  ok('A: packed at matching indices', inIdx === outIdx);
  ok('A: packed exactly once in each list',
    ARCHIVE_WORKBENCH_SOURCE_FILES.filter((f) => f === CONSUMER_PACK).length === 1
    && ARCHIVE_WORKBENCH_OUT_FILES.filter((f) => f === CONSUMER_PACK).length === 1);
  ok('A: pack lists stay parallel',
    ARCHIVE_WORKBENCH_SOURCE_FILES.length === ARCHIVE_WORKBENCH_OUT_FILES.length
    && ARCHIVE_WORKBENCH_SOURCE_FILES.every((v, i) => v === ARCHIVE_WORKBENCH_OUT_FILES[i]));
}

/* ══ B. Inert / default-off ════════════════════════════════════════════ */

{
  // Loading the consumer into a realm whose owner APIs all explode must not
  // call any of them.
  let touched = 0;
  const trapSandbox = { console };
  trapSandbox.globalThis = trapSandbox;
  vm.createContext(trapSandbox);
  const boom = () => { touched += 1; throw new Error('owner API invoked at load'); };
  trapSandbox.H2O = {
    flags: { get: boom },
    Knowledge: { ContractsV0: { __installed: true }, CapturedChatHighlightAdapterV0: { __installed: true } },
    Studio: {
      readerNotes: {
        libraryItems: { get: boom }, annotations: { listForItem: boom },
        highlightResolutionConsumer: { resolveForItem: boom },
      },
      ingestion: { describeSavedChatCoverageV1: boom },
    },
  };
  vm.runInContext(read(CONSUMER), trapSandbox, { filename: CONSUMER });
  ok('B: loading the consumer invokes no owner API', touched === 0);
  ok('B: namespace installed on load',
    !!trapSandbox.H2O.Studio.knowledge.exactReferences.__installed);
  ok('B: API frozen', Object.isFrozen(trapSandbox.H2O.Studio.knowledge.exactReferences));

  // No flag system at all -> fail closed.
  const bare = { console };
  bare.globalThis = bare;
  vm.createContext(bare);
  vm.runInContext(read(CONSUMER), bare, { filename: CONSUMER });
  ok('B: default OFF with no flag system', bare.H2O.Studio.knowledge.exactReferences.isEnabled() === false);
  ok('B: flag key is the frozen one',
    bare.H2O.Studio.knowledge.exactReferences.flagKey === CONSUMER_FLAG);

  const disabled = makeRealm({ enabled: false });
  ok('B: disabled isEnabled() false', disabled.consumer.isEnabled() === false);
  const out = await disabled.describe();
  ok('B: explicit call while disabled fails closed', out.ok === false && out.reason === 'disabled');
  ok('B: disabled call produces no chain',
    out.itemRef === null && out.versionRef === null && out.references.length === 0);
  ok('B: disabled call touches no owner API',
    disabled.calls.libraryGet === 0 && disabled.calls.coverage === 0
    && disabled.calls.annotations === 0 && disabled.calls.resolve === 0);

  const d = disabled.consumer.diagnose();
  assert.deepEqual(plain(d.sideEffects), {
    dom: false, storage: false, network: false, persistence: false, navigation: false,
    writeBack: false, watchers: false, pollers: false, startupWork: false,
  }, 'B: diagnose declares the read-only posture');

  // Static: no scheduling or host-surface API anywhere in the consumer.
  const code = read(CONSUMER).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/[^\n]*$/gm, '');
  for (const token of ['setTimeout', 'setInterval', 'setImmediate', 'requestAnimationFrame',
    'MutationObserver', 'addEventListener', 'localStorage', 'sessionStorage', 'indexedDB',
    'fetch', 'XMLHttpRequest', 'document', 'window', 'chrome', 'location']) {
    ok(`B: consumer never references ${token}`, new RegExp(`\\b${token}\\b`).test(code) === false);
  }
}

/* ══ C. Owner identity ═════════════════════════════════════════════════ */

{
  const anchors = { textPos: { start: PLAIN_A.indexOf(EXACT_A), end: PLAIN_A.indexOf(EXACT_A) + EXACT_A.length }, textQuote: quoteFrom(PLAIN_A, EXACT_A) };
  const good = makeRealm({ annotations: [highlightAnnotation(anchors)], plainText: PLAIN_A });
  const out = await good.describe();
  ok('C: owner chatId preserved verbatim', out.itemRef.id === CHAT_ID);
  assert.deepEqual(plain(out.itemRef), {
    kind: 'item_ref', itemKind: 'captured_chat', scheme: 'chat-registry/chat-id', id: CHAT_ID,
  }, 'C: ItemRef is the frozen first-adapter mapping');

  const cases = [
    ['conflicting identities', capturedChatItem({ identity: { authority: 'chat-registry', chatId: 'other-chat' } })],
    ['foreign authority', capturedChatItem({ identity: { authority: 'source-documents', chatId: CHAT_ID } })],
    ['non captured_chat', deepFreeze({ kind: 'source_document', id: CHAT_ID })],
    ['no identity at all', deepFreeze({ kind: 'captured_chat', title: 'x' })],
    ['whitespace-padded id', deepFreeze({ kind: 'captured_chat', id: ` ${CHAT_ID} ` })],
    ['non-string id', deepFreeze({ kind: 'captured_chat', id: 12345 })],
  ];
  for (const [label, item] of cases) {
    const realm = makeRealm({ item, annotations: [highlightAnnotation(anchors)] });
    const r = await realm.describe();
    ok(`C: ${label} fails closed`, r.ok === false && r.reason === 'item-identity-unusable');
    ok(`C: ${label} never reaches coverage`, realm.calls.coverage === 0);
    ok(`C: ${label} yields no chain`, r.versionRef === null && r.references.length === 0);
  }

  const missing = makeRealm({ item: null });
  const rm = await missing.describe();
  ok('C: unknown item fails closed', rm.ok === false && rm.reason === 'item-not-found');
  ok('C: invalid itemId fails closed',
    (await makeRealm({}).describe('  ')).reason === 'invalid-item-id');
}

/* ══ D. Saved-Chat version authority ═══════════════════════════════════ */

const ANCHORS_A = {
  textPos: { start: PLAIN_A.indexOf(EXACT_A), end: PLAIN_A.indexOf(EXACT_A) + EXACT_A.length },
  textQuote: quoteFrom(PLAIN_A, EXACT_A),
};

{
  const realm = makeRealm({ annotations: [highlightAnnotation(ANCHORS_A)], plainText: PLAIN_A });
  const out = await realm.describe();
  ok('D: coverage called exactly once per describe', realm.calls.coverage === 1);
  ok('D: chatId forwarded to coverage', realm.seen.chatId === CHAT_ID);
  ok('D: policyToken forwarded identity-equal', realm.seen.token === OPAQUE_TOKEN);
  ok('D: policyToken never appears in the envelope',
    snapshot(out).indexOf('opaque-capability-token') === -1);
  ok('D: no lower-level ingestion API touched', realm.calls.forbiddenIngestion === 0);
  ok('D: VersionRef id is the selected generation contentHash', out.versionRef.id === CONTENT_HASH);
  assert.deepEqual(plain(out.versionRef), {
    kind: 'version_ref', item: plain(out.itemRef),
    scheme: 'saved-chat/generation-content-hash', id: CONTENT_HASH,
  }, 'D: VersionRef is the frozen mapping');

  const refuse = [
    ['covered false', { covered: false, selected: null, fresh: [] }, 'not-covered'],
    ['covered null (indeterminate)', { covered: null, selected: null, fresh: [], reason: 'projection-indeterminate' }, 'projection-indeterminate'],
    ['no current snapshot', { covered: null, selected: null, fresh: [], reason: 'no-current-snapshot' }, 'no-current-snapshot'],
    ['discovery incomplete', { covered: null, selected: null, fresh: [], complete: false, reason: 'discovery-incomplete' }, 'coverage-incomplete'],
    ['archive diagnostics unavailable', { covered: null, selected: null, fresh: [], reason: 'archive-diagnostics-unavailable' }, 'coverage-unavailable'],
    ['discovery failed', { covered: null, selected: null, fresh: [], reason: 'discovery-failed' }, 'coverage-discovery-failed'],
    ['selected missing', { covered: true, selected: null }, 'version-identity-unavailable'],
    ['selected legacy', { covered: true, selected: coverageEntry({ classification: 'legacy' }) }, 'version-identity-not-generation'],
    ['selected unclassified', { covered: true, selected: coverageEntry({ classification: 'unclassified' }) }, 'version-identity-not-generation'],
    ['selected classification missing', { covered: true, selected: coverageEntry({ classification: undefined }) }, 'version-identity-not-generation'],
    ['selected hash missing', { covered: true, selected: coverageEntry({ contentHash: '' }) }, 'version-identity-malformed'],
    ['selected hash padded', { covered: true, selected: coverageEntry({ contentHash: ` ${CONTENT_HASH} ` }) }, 'version-identity-malformed'],
    ['selected hash non-string', { covered: true, selected: coverageEntry({ contentHash: 42 }) }, 'version-identity-malformed'],
    ['projection missing', { covered: true, projection: null }, 'projection-identity-missing'],
    ['projection hash empty', { covered: true, projection: { status: 'ok', reason: '', contentHash: '', snapshotId: '', schemaVersion: 2, liveGenerationFamily: 'v1v2' } }, 'projection-identity-malformed'],
    ['selected/projection mismatch', { covered: true, selected: coverageEntry({ contentHash: OTHER_HASH }) }, 'version-identity-mismatch'],
  ];
  for (const [label, override, reason] of refuse) {
    const r = makeRealm({ coverage: coverageResult(override), annotations: [highlightAnnotation(ANCHORS_A)] });
    const res = await r.describe();
    ok(`D: ${label} -> ${reason}`, res.ok === false && res.reason === reason);
    ok(`D: ${label} yields no VersionRef`, res.versionRef === null);
    ok(`D: ${label} yields no reference or excerpt`, res.references.length === 0);
    ok(`D: ${label} never resolves`, r.calls.resolve === 0);
  }

  // projection.contentHash alone cannot establish a VersionRef.
  const projOnly = makeRealm({
    coverage: coverageResult({ covered: true, selected: null }),
    annotations: [highlightAnnotation(ANCHORS_A)],
  });
  const projRes = await projOnly.describe();
  ok('D: projection hash alone cannot establish a VersionRef',
    projRes.ok === false && projRes.versionRef === null);

  // bestHistorical cannot establish a VersionRef.
  const bestOnly = makeRealm({
    coverage: coverageResult({
      covered: null, selected: null, fresh: [], reason: 'discovery-incomplete', complete: false,
      bestHistorical: coverageEntry({ contentHash: OTHER_HASH }),
      bestHistoricalTies: [coverageEntry({ contentHash: OTHER_HASH })],
    }),
    annotations: [highlightAnnotation(ANCHORS_A)],
  });
  const bestRes = await bestOnly.describe();
  ok('D: bestHistorical cannot establish a VersionRef',
    bestRes.ok === false && bestRes.versionRef === null);
  ok('D: bestHistorical hash never leaks into the envelope',
    snapshot(bestRes).indexOf(OTHER_HASH) === -1);

  // Coverage API missing entirely, and throwing.
  const noCoverage = makeRealm({ annotations: [highlightAnnotation(ANCHORS_A)] });
  delete noCoverage.sandbox.H2O.Studio.ingestion.describeSavedChatCoverageV1;
  ok('D: missing coverage API fails closed',
    (await noCoverage.describe()).reason === 'coverage-unavailable');
  const throwing = makeRealm({ coverageThrow: true, annotations: [highlightAnnotation(ANCHORS_A)] });
  const tr = await throwing.describe();
  ok('D: throwing coverage API fails closed', tr.ok === false && tr.reason === 'coverage-failed');
  ok('D: throwing coverage never resolves', throwing.calls.resolve === 0);

  // No hashing / discovery / selection anywhere in the consumer source.
  const code = read(CONSUMER).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/[^\n]*$/gm, '');
  for (const token of ['createHash', 'sha256', 'digest', 'listSavedChatArchivePackagesV1',
    'validateSavedChatPackageV1', 'probeCurrentSavedChatProjectionV1', 'bestHistorical',
    'bestHistoricalTies', 'packagePath', 'packageDirName', 'savedAt']) {
    ok(`D: consumer never references ${token}`, new RegExp(`\\b${token}\\b`).test(code) === false);
  }
}

/* ══ E/F. Real composition chain — anchored success ════════════════════ */

{
  const annotation = highlightAnnotation(ANCHORS_A);
  const realm = makeRealm({ annotations: [annotation], plainText: PLAIN_A });
  const out = await realm.describe();

  ok('E: chain succeeded', out.ok === true && out.reason === '');
  ok('E: exactly one reference produced', out.references.length === 1);
  const ref = out.references[0];

  ok('E: ItemRef -> VersionRef -> SemanticBlockRef chain intact',
    ref.blockRef.version.item.id === CHAT_ID && ref.blockRef.version.id === CONTENT_HASH);
  assert.deepEqual(plain(ref.blockRef), {
    kind: 'semantic_block_ref', version: plain(out.versionRef),
    blockKind: 'message', scheme: 'captured-chat/message-id', id: ANSWER_ID,
  }, 'E: SemanticBlockRef is the frozen mapping');
  ok('E: answerId preserved', ref.answerId === ANSWER_ID && ref.annotationId === ANNOTATION_ID);
  ok('E: Anchor validates under the v0 contract', realm.contracts.validateAnchor(ref.anchor).ok);
  ok('E: Anchor targets the block ref', realm.contracts.sameReference(ref.anchor.target, ref.blockRef));
  ok('E: selectors came from the owner annotation',
    ref.anchor.selectors.textQuote.exact === ANCHORS_A.textQuote.exact
    && ref.anchor.selectors.textQuote.approx === ANCHORS_A.textQuote.approx);

  ok('F: anchored', ref.result.status === 'anchored');
  ok('F: selector is textQuote', ref.result.selectorUsed === 'textQuote');
  ok('F: same_version', ref.result.versionScope === 'same_version');
  ok('F: ReanchorResult validates', realm.contracts.validateReanchorResult(ref.result).ok);
  ok('F: Excerpt produced', !!ref.excerpt);
  ok('F: Excerpt is the Reader row text', ref.excerpt.text === EXACT_A);
  ok('F: Excerpt is the resolved span substring',
    ref.excerpt.text === PLAIN_A.slice(ref.result.span.start, ref.result.span.end));
  ok('F: Excerpt is not the highlight preview', ref.excerpt.text !== annotation.body.text);
  ok('F: Provenance derivation is anchor_resolution',
    ref.excerpt.provenance.derivation === 'anchor_resolution');
  ok('F: Provenance bound to the same Anchor',
    realm.contracts.sameReference(ref.excerpt.provenance.source, ref.anchor));
  ok('F: Excerpt validates', realm.contracts.validateExcerpt(ref.excerpt).ok);
  ok('F: reader owns resolution — consumer called it once', realm.calls.resolve === 1);
  ok('F: root forwarded opaquely and unqueried',
    realm.seen.root && realm.seen.root.opaque === 'reader-root');
  ok('F: no live Range in the envelope', snapshot(out).indexOf('"range"') === -1);
  ok('F: diagnostics count the excerpt',
    out.diagnostics.excerpted === 1 && out.diagnostics.orphaned === 0
    && out.diagnostics.versionScope === 'same_version' && out.diagnostics.coverageCalls === 1);
}

/* ══ G. Reanchored success (validated textPos fallback) ════════════════ */

{
  const anchors = {
    textPos: { start: 14, end: 25 },
    textQuote: { exact: EXACT_B, prefix: 'The result is ', suffix: ' today.', approx: 14 },
  };
  ok('G: the literal quote genuinely does not occur', PLAIN_B.indexOf(EXACT_B) === -1);
  const realm = makeRealm({ annotations: [highlightAnnotation(anchors)], plainText: PLAIN_B });
  const out = await realm.describe();
  ok('G: chain succeeded', out.ok === true && out.references.length === 1);
  const ref = out.references[0];
  ok('G: reanchored', ref.result.status === 'reanchored');
  ok('G: selector is textPos', ref.result.selectorUsed === 'textPos');
  ok('G: reason is textPos-validated', ref.result.reason === 'textPos-validated');
  ok('G: still same_version', ref.result.versionScope === 'same_version');
  ok('G: Excerpt produced', !!ref.excerpt);
  ok('G: Excerpt is the Reader row text', ref.excerpt.text === 'hello world');
  ok('G: Excerpt is NOT the stored textQuote.exact', ref.excerpt.text !== EXACT_B);
  ok('G: Excerpt equals the resolved span substring',
    ref.excerpt.text === PLAIN_B.slice(ref.result.span.start, ref.result.span.end));
  ok('G: Provenance bound to the same Anchor',
    realm.contracts.sameReference(ref.excerpt.provenance.source, ref.anchor));
}

/* ══ H. Orphan behavior ════════════════════════════════════════════════ */

{
  const tied = { textQuote: { exact: 'TERM', prefix: 'pre ', suffix: ' ', approx: 11 } };
  const realm = makeRealm({ annotations: [highlightAnnotation(tied)], plainText: PLAIN_C });
  const out = await realm.describe();
  ok('H: chain still succeeded', out.ok === true);
  ok('H: a reference is still retained', out.references.length === 1);
  const ref = out.references[0];
  ok('H: orphaned', ref.result.status === 'orphaned');
  ok('H: reason is ambiguous-textQuote', ref.result.reason === 'ambiguous-textQuote');
  ok('H: no span', ref.result.span === null);
  ok('H: no selector claimed', ref.result.selectorUsed === null);
  ok('H: NO Excerpt', ref.excerpt === null);
  ok('H: orphaned result still validates', realm.contracts.validateReanchorResult(ref.result).ok);
  ok('H: still same_version', ref.result.versionScope === 'same_version');
  ok('H: diagnostics count the orphan',
    out.diagnostics.orphaned === 1 && out.diagnostics.excerpted === 0);
  ok('H: no invented match text', snapshot(out).indexOf('"text":"TERM"') === -1);
}

/* ══ I. Annotation join ════════════════════════════════════════════════ */

{
  const annotation = highlightAnnotation(ANCHORS_A);

  // Resolution row whose annotationId matches nothing.
  const orphanRow = makeRealm({
    annotations: [annotation], plainText: PLAIN_A,
    annotationList: [],
  });
  const oOut = await orphanRow.describe();
  ok('I: unmatched row is skipped, not guessed',
    oOut.ok === true && oOut.references.length === 0 && oOut.skipped.length === 1
    && oOut.skipped[0].reason === 'annotation-not-found');

  // Duplicate annotation id -> ambiguous, refused rather than resolved.
  const dupe = makeRealm({
    annotations: [annotation], plainText: PLAIN_A,
    annotationList: [annotation, highlightAnnotation(ANCHORS_A, { body: { color: 'green', text: 'other', createdAt: 1 } })],
  });
  const dOut = await dupe.describe();
  ok('I: duplicate annotation id refused',
    dOut.references.length === 0 && dOut.skipped.length === 1
    && dOut.skipped[0].reason === 'annotation-ambiguous');

  // Anchors must come from the owner annotation, never from Reader text.
  const stripped = highlightAnnotation(ANCHORS_A, { raw: { id: NATIVE_ID, ts: 1, color: 'yellow' } });
  const noAnchors = makeRealm({ annotations: [annotation], plainText: PLAIN_A, annotationList: [stripped] });
  const nOut = await noAnchors.describe();
  ok('I: an annotation without anchors cannot be reconstructed from Reader text',
    nOut.references.length === 0 && nOut.skipped.length === 1
    && nOut.skipped[0].reason === 'block-ref-unavailable');

  // Cross-chat annotation must not be folded in.
  const foreign = highlightAnnotation(ANCHORS_A, {
    source: { store: 'highlights', chatId: 'a-different-chat', answerId: ANSWER_ID, nativeId: NATIVE_ID, convoId: null },
  });
  const fOut = await makeRealm({ annotations: [annotation], plainText: PLAIN_A, annotationList: [foreign] }).describe();
  ok('I: cross-chat annotation refused',
    fOut.references.length === 0 && fOut.skipped.length === 1
    && fOut.skipped[0].reason === 'block-ref-unavailable');

  // Unattributed highlight refused.
  const unattributed = highlightAnnotation(ANCHORS_A, { attribution: 'unattributed' });
  const uOut = await makeRealm({ annotations: [annotation], plainText: PLAIN_A, annotationList: [unattributed] }).describe();
  ok('I: unattributed annotation refused',
    uOut.references.length === 0 && uOut.skipped[0].reason === 'block-ref-unavailable');

  // Annotations API throwing / absent.
  ok('I: throwing annotations API fails closed',
    (await makeRealm({ annotationsThrow: true, annotations: [annotation] }).describe()).reason === 'annotations-failed');
  const noAnn = makeRealm({ annotations: [annotation] });
  delete noAnn.sandbox.H2O.Studio.readerNotes.annotations;
  ok('I: missing annotations API fails closed',
    (await noAnn.describe()).reason === 'annotations-unavailable');

  // Reader API throwing / returning junk.
  ok('I: throwing resolution API fails closed',
    (await makeRealm({ resolveThrow: true, annotations: [annotation] }).describe()).reason === 'resolution-failed');
  ok('I: junk resolution result fails closed',
    (await makeRealm({ resolveResult: 'nope', annotations: [annotation] }).describe()).reason === 'resolution-invalid');
}

/* ══ J. Immutability ═══════════════════════════════════════════════════ */

{
  const annotation = highlightAnnotation(ANCHORS_A);
  const item = capturedChatItem();
  const coverage = coverageResult();
  const options = deepFreeze({ policyToken: OPAQUE_TOKEN, resolutionOptions: deepFreeze({ note: 'x' }) });
  const root = deepFreeze({ opaque: 'reader-root' });

  const before = {
    item: snapshot(item), annotation: snapshot(annotation),
    coverage: snapshot(coverage), options: snapshot(options), root: snapshot(root),
  };

  const realm = makeRealm({ item, coverage, annotations: [annotation], plainText: PLAIN_A });
  const out = await realm.consumer.describeForItemV1(CHAT_ID, root, options);
  ok('J: chain succeeded on frozen inputs', out.ok === true && out.references.length === 1);

  ok('J: LibraryItem unchanged', snapshot(item) === before.item);
  ok('J: annotation unchanged', snapshot(annotation) === before.annotation);
  ok('J: coverage result unchanged', snapshot(coverage) === before.coverage);
  ok('J: selected/projection records unchanged',
    snapshot(coverage.selected) === snapshot(coverageResult().selected)
    && snapshot(coverage.projection) === snapshot(coverageResult().projection));
  ok('J: caller options unchanged', snapshot(options) === before.options);
  ok('J: root unchanged', snapshot(root) === before.root);
  ok('J: policyToken still identity-equal and unmutated',
    realm.seen.token === OPAQUE_TOKEN && Object.isFrozen(OPAQUE_TOKEN));
  ok('J: inputs were genuinely frozen',
    Object.isFrozen(item) && Object.isFrozen(coverage) && Object.isFrozen(annotation));

  // Mutating the envelope must not reach back into any owner input.
  out.references[0].excerpt.text = 'MUTATED';
  out.itemRef.id = 'MUTATED';
  ok('J: envelope mutation does not touch owner inputs',
    snapshot(item) === before.item && snapshot(annotation) === before.annotation
    && snapshot(coverage) === before.coverage);

  const again = await makeRealm({ item, coverage, annotations: [annotation], plainText: PLAIN_A }).describe();
  ok('J: a fresh run is unaffected',
    again.references[0].excerpt.text === EXACT_A && again.itemRef.id === CHAT_ID);
  ok('J: repeated runs are deterministic', snapshot(plain(again)) === snapshot(plain(
    await makeRealm({ item, coverage, annotations: [annotation], plainText: PLAIN_A }).describe(),
  )));
}

/* ══ K. Contract regression ════════════════════════════════════════════ */

{
  const realm = makeRealm({ annotations: [highlightAnnotation(ANCHORS_A)], plainText: PLAIN_A });
  const out = await realm.describe();
  ok('K: contracts still report same_version', realm.contracts.VERSION_SCOPE === 'same_version');
  ok('K: no cross-version capability', realm.contracts.diagnose().reanchor.crossVersion === false);
  for (const ref of out.references) {
    ok('K: every result is same_version', ref.result.versionScope === 'same_version');
    assert.deepEqual(Object.keys(ref.result), [
      'kind', 'status', 'versionScope', 'anchor', 'span', 'selectorUsed',
      'confidence', 'reason', 'diagnostics',
    ], 'K: ReanchorResult keeps exactly the frozen shape');
  }
  const text = snapshot(out);
  for (const token of ['cross_version', 'fromVersion', 'toVersion', 'versions']) {
    ok(`K: envelope carries no ${token}`, text.indexOf(token) === -1);
  }
  // Exactly one VersionRef is reachable in the whole envelope.
  const versionIds = new Set();
  (function walk(v) {
    if (Array.isArray(v)) return v.forEach(walk);
    if (v && typeof v === 'object') {
      if (v.kind === 'version_ref') versionIds.add(v.id);
      Object.keys(v).forEach((k) => walk(v[k]));
    }
  }(out));
  ok('K: exactly one version identity in the envelope', versionIds.size === 1);
  ok('K: and it is the verified generation hash', versionIds.has(CONTENT_HASH));
}

console.log(`[validate-knowledge-exact-reference-consumer-v0] ok — ${checks} checks across obligations A–K`);
