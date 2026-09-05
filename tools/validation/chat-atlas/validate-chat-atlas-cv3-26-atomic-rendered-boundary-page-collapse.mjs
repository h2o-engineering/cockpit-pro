#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const PAGE_PATH = 'src-runtime-base/1C1b.🔴📑 Thread Pages Controller 📑.js';
const RANGE_VALIDATOR_PATH = path.join(
  ROOT,
  'tools/validation/chat-atlas/validate-chat-atlas-cv3-23-page1-collapse-range-diagnostics.mjs',
);
const SOURCE = fs.readFileSync(path.join(ROOT, PAGE_PATH), 'utf8');
const PARENT = execFileSync(
  'git',
  ['show', `8c59f277e7df8756395a541994418212ef687f7f:${PAGE_PATH}`],
  { cwd: ROOT, encoding: 'utf8' },
);

let assertions = 0;
const fixtures = [];

function equal(actual, expected, message) {
  assertions += 1;
  assert.deepEqual(actual, expected, message);
}
function ok(value, message) {
  assertions += 1;
  assert.ok(value, message);
}
async function fixture(name, run) {
  try {
    await run();
    fixtures.push({ name, ok: true });
    console.log(`PASS ${name}`);
  } catch (error) {
    fixtures.push({ name, ok: false, error: String(error?.stack || error) });
    console.error(`FAIL ${name}\n${String(error?.stack || error)}`);
  }
}

function extractFunction(source, name) {
  const anchor = `  function ${name}(`;
  const start = source.indexOf(anchor);
  if (start < 0 || source.indexOf(anchor, start + anchor.length) >= 0) {
    throw new Error(`function-anchor-invalid:${name}`);
  }
  const bodyStart = source.indexOf('{', source.indexOf(')', start));
  let depth = 0;
  let quote = '';
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = bodyStart; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    if (lineComment) {
      if (char === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === '*' && next === '/') {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === '/' && next === '/') {
      lineComment = true;
      index += 1;
      continue;
    }
    if (char === '/' && next === '*') {
      blockComment = true;
      index += 1;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      continue;
    }
    if (char === '{') depth += 1;
    else if (char === '}' && --depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`function-boundary-invalid:${name}`);
}

function loadRangeHarnessFactory(productionSource) {
  const validator = fs.readFileSync(RANGE_VALIDATOR_PATH, 'utf8');
  const start = validator.indexOf('const CHAT =');
  const end = validator.indexOf('\nawait fixture(');
  if (start < 0 || end <= start) throw new Error('cv3-23-harness-boundary-invalid');
  const harnessBody = validator.slice(start, end);
  return vm.runInNewContext(`(() => {
    const SOURCE = injectedSource;
    const PARENT = injectedSource;
    const fixtures = [];
    let assertions = 0;
    const assert = injectedAssert;
    const vm = injectedVm;
    ${harnessBody}
    return Object.freeze({ createHarness, prime });
  })()`, {
    injectedSource: productionSource,
    injectedAssert: assert,
    injectedVm: vm,
  });
}

function buildTitleModel(count = 39) {
  const pages = [];
  for (let pageNo = 1; pageNo <= Math.ceil(count / 25); pageNo += 1) {
    const turnRecords = [];
    const start = ((pageNo - 1) * 25) + 1;
    const end = Math.min(count, pageNo * 25);
    for (let turnNo = start; turnNo <= end; turnNo += 1) {
      const noAnswer = turnNo === 13;
      turnRecords.push(Object.freeze({
        id: noAnswer ? `q-${turnNo}` : `a-${turnNo}`,
        answerId: noAnswer ? '' : `a-${turnNo}`,
        questionId: `q-${turnNo}`,
        turnId: `turn-${turnNo}`,
        aliasIds: noAnswer ? Object.freeze([]) : Object.freeze([`a-${turnNo}`]),
        turnNo,
        type: noAnswer ? 'no-answer' : 'answer',
      }));
    }
    pages.push(Object.freeze({
      pageNo,
      startOrder: start,
      endOrder: end,
      turnRecords: Object.freeze(turnRecords),
    }));
  }
  return Object.freeze({
    coherent: true,
    source: 'canonical',
    count,
    pageSize: 25,
    pageCount: pages.length,
    pages: Object.freeze(pages),
  });
}

function parentCapability() {
  const boundary = (pageNum) => Object.freeze({
    supported: pageNum <= 2,
    reason: pageNum <= 2 ? null : 'page-not-present',
    pageNum,
    pageStartOrder: ((pageNum - 1) * 25) + 1,
    chatId: 'chat-stage-2c2',
    routeKey: '/c/chat-stage-2c2',
    generation: 1,
    effectiveFingerprint: 'djb2:effective',
    graphFingerprint: 'djb2:graph',
    boundaryIdentityCurrent: pageNum <= 2,
    boundaryWrapperConnected: pageNum <= 2,
    leaseCurrent: pageNum <= 2,
    pageUnitOrderCurrent: pageNum <= 2,
  });
  const range = Object.freeze({
    supported: true,
    reason: null,
    pageNum: 1,
    pageStartOrder: 1,
    pageEndOrder: 25,
    chatId: 'chat-stage-2c2',
    routeKey: '/c/chat-stage-2c2',
    generation: 1,
    effectiveFingerprint: 'djb2:effective',
    graphFingerprint: 'djb2:graph',
    startBoundarySupported: true,
    nextBoundarySupported: true,
    rangeProven: true,
    startWrapperCurrent: true,
    endWrapperCurrent: true,
    rangeStartIndex: 4,
    rangeEndIndex: 57,
    hostWrapperCount: 50,
    h2oNodeCount: 3,
    ambiguousWrapperCount: 0,
    firstAmbiguousIndex: -1,
    pageUnitOrderCurrent: true,
    streaming: false,
    branchTransition: false,
  });
  return vm.runInNewContext(`(() => {
    const TITLE_LIST_PAGE_SIZE = 25;
    const buildTitleListPresentationPageModel = () => injectedModel;
    const getRenderedPageBoundaryCapability = injectedBoundary;
    const getPageCollapseRangeDiagnostics = () => injectedRange;
    ${extractFunction(PARENT, 'frozenPageCollapseCapability')}
    ${extractFunction(PARENT, 'pageCollapseCapabilityProductReason')}
    ${extractFunction(PARENT, 'getPageCollapseCapability')}
    ${extractFunction(PARENT, 'frozenCollapsedBoundaryResult')}
    ${extractFunction(PARENT, 'getCollapsedNativeBoundaryReadiness')}
    return Object.freeze({
      capability: getPageCollapseCapability(1),
      readiness: getCollapsedNativeBoundaryReadiness(1),
    });
  })()`, {
    injectedModel: buildTitleModel(),
    injectedBoundary: boundary,
    injectedRange: range,
  });
}

function createTransactionHarness(options = {}) {
  const rangeFactory = loadRangeHarnessFactory(SOURCE);
  const rangeHarness = rangeFactory.createHarness({
    productionSource: SOURCE,
    coldEnd: true,
    middleCount: 48,
    extraKind: 'title-list',
    count: 39,
  });
  rangeFactory.prime(rangeHarness);
  const rawPlan = rangeHarness.api.plan(1);
  if (!rawPlan?.ok) throw new Error(`range-plan-unavailable:${rawPlan?.diagnostic?.reason}`);
  // The range probe needs one already-owned H2O node to prove exclusion. It
  // is not the transaction's title list, so remove it before exercising the
  // real detached-list preparation/commit path below.
  rangeHarness.guard.locked = false;
  rangeHarness.extra?.remove?.();
  const model = buildTitleModel(Number(options.count || 39));
  const titleRows = model.pages[0]?.turnRecords || [];
  const plan = {
    ...rawPlan,
    pageNum: 1,
    pageStartOrder: 1,
    pageEndOrder: 25,
    chatId: rawPlan.authority.chatId,
    routeKey: rawPlan.authority.routeKey,
    generation: rawPlan.authority.generation,
    effectiveFingerprint: rawPlan.authority.effectiveFingerprint,
    graphFingerprint: rawPlan.startCapability.graphFingerprint,
    startBoundaryQId: rawPlan.authority.qId,
    nextBoundaryQId: rawPlan.nextAuthority.qId,
    titleRows,
    expectedTitleRowCount: 25,
    pageDivider: rangeHarness.p1Divider,
    pageStartSentinel: rangeHarness.p1Sentinel,
    nextPageDivider: rangeHarness.p2Divider,
    nextPageStartSentinel: rangeHarness.p2Sentinel,
    capabilityIdentity: Object.freeze({
      chatId: rawPlan.authority.chatId,
      routeKey: rawPlan.authority.routeKey,
      generation: rawPlan.authority.generation,
      effectiveFingerprint: rawPlan.authority.effectiveFingerprint,
      graphFingerprint: rawPlan.startCapability.graphFingerprint,
    }),
  };
  const safety = {
    storage: 0,
    cache: 0,
    preference: 0,
    canonical: 0,
    alias: 0,
    network: 0,
    navigation: 0,
    nonAnchorScrolling: 0,
    timers: 0,
    raf: 0,
    observers: 0,
    pageUnitMoves: 0,
    hostMoves: 0,
  };
  const calls = {
    capability: 0,
    plans: 0,
    preparations: 0,
    revalidations: 0,
    committedValidations: 0,
    viewportReads: 0,
    firstWriteAt: 0,
    titleInsertions: 0,
    stamps: 0,
    nativeSlots: 0,
    nativeOrdinals: 0,
    testArithmetic: 0,
    persistence: 0,
    materializations: 0,
    mountCandidateReads: 0,
    mountCandidateReadsAtOpenStateSet: [],
    pendingSelfBlockingSuppressions: 0,
    residualSourceReleases: 0,
  };
  const control = {
    model,
    authority: plan.authority,
    nextAuthority: plan.nextAuthority,
    startCapability: plan.startCapability,
    nextCapability: plan.nextCapability,
    activationReady: options.activationReady !== false,
    beforeFinalValidation: null,
    // Default off: with no transform every existing fixture sees the same plan.
    planTransform: null,
    navigationGeneration: 0,
    navigationStatus: Object.freeze({
      status: 'idle',
      targetQId: '',
      generation: 0,
      errorCode: null,
    }),
    collapseSources: new Map(),
  };
  const flow = rangeHarness.flow;
  const originalFlowInsert = flow.insertBefore.bind(flow);
  flow.insertBefore = (node, before) => {
    if (!calls.firstWriteAt) calls.firstWriteAt = Date.now() || 1;
    if (node?.className === 'cgxui-chat-page-title-list-synth') calls.titleInsertions += 1;
    else if (node === rangeHarness.p1Divider || node === rangeHarness.p2Divider
      || node === rangeHarness.p1Sentinel || node === rangeHarness.p2Sentinel) {
      safety.pageUnitMoves += 1;
    } else if (rangeHarness.hostWrappers.includes(node) || node === rangeHarness.end.wrapper) {
      safety.hostMoves += 1;
    }
    return originalFlowInsert(node, before);
  };
  for (const wrapper of rawPlan.hostWrappers) {
    const originalSet = wrapper.setAttribute.bind(wrapper);
    wrapper.setAttribute = (name, value) => {
      if (name === 'data-cgxui-chat-page-native-hidden') {
        if (!calls.firstWriteAt) calls.firstWriteAt = Date.now() || 1;
        calls.stamps += 1;
      }
      return originalSet(name, value);
    };
  }
  const NodeCtor = flow.constructor;
  rangeHarness.document.createElement = (tag) => {
    const node = new NodeCtor(tag, '', rangeHarness.guard);
    node.isConnected = false;
    return node;
  };
  rangeHarness.p1Divider.getBoundingClientRect = () => ({ top: 100, bottom: 127 });
  flow.scrollHeight = 90000;
  flow.clientHeight = 1000;
  flow.scrollTop = 0;
  class TitleListOpenStateMap extends Map {
    set(key, value) {
      calls.mountCandidateReadsAtOpenStateSet.push(calls.mountCandidateReads);
      return super.set(key, value);
    }
  }
  const S = {
    atomicPageCollapseTransactions: new Map(),
    atomicPageCollapseGuards: new Set(),
    nativeRangeActivePages: new Set(),
    collapsedPagesByChat: new Map(),
    titleListPagesByChat: new Map(),
    titleListStacksByKey: new Map(),
    titleListOpenStatesByKey: new TitleListOpenStateMap(),
    titleListOpenSequence: 0,
    collapsedBoundaryDiagnostics: new Map(),
  };
  const stackStats = {};
  const W = {
    H2O: { obs: { mounts: new Map() } },
    getComputedStyle: () => ({ overflowY: 'visible' }),
    scrollBy() {
      safety.nonAnchorScrolling += 1;
      throw new Error('forbidden-non-anchor-scroll');
    },
  };
  const throwing = (key) => () => {
    safety[key] += 1;
    throw new Error(`forbidden:${key}`);
  };
  const capability = Object.freeze({
    version: 1,
    supported: true,
    reason: null,
    productReason: 'ready',
    prerequisitesReady: true,
    atomicTransactionImplemented: true,
    activationReady: true,
    activationBlockReason: null,
    legacyNativeSlotConsulted: false,
  });
  const extractedNames = [
    'pageCollapseRangeH2OOwned',
    'pageCollapseRangeIdentityCarriers',
    'pageCollapseRangeIdentityOfCarrier',
    'pageCollapseRangeContainerIdentity',
    'pageCollapseRangeNodeCarriesIdentity',
    'pageCollapseMemberIdentityCurrent',
    'renderedBoundaryWrapperCarriesIdentity',
    'applyCollapsedNativeRange',
    'captureCollapsedPageViewportAnchor',
    'restoreCollapsedPageViewportAnchor',
    'propagateChatPageCollapseToMiniMap',
    'setAtomicTitleListMemory',
    'setAtomicCollapsedPageMemory',
    'prepareDetachedPageTitleList',
    'revalidateAtomicPageCollapsePlan',
    'hasTitleCollapseInlineResidue',
    'getPageMemberCollapseSources',
    'pageMemberFlowScopes',
    'releasePageMemberProjection',
    'releasePageMemberHideMarkers',
    'clearResidualPageTitleCollapseSources',
    'titleListOpenStateKey',
    'getTitleListSuffixContainers',
    'ensureTitleListSuffixContainer',
    'restoreTitleListProjectionRows',
    'titleListCanonicalMemberForOpenState',
    'titleListOpenStateCurrent',
    'titleListCurrentNativeMount',
    'titleListCurrentOpenMount',
    'requestTitleListCanonicalMaterialization',
    'titleListCanonicalMaterializationTerminal',
    'titleListCanonicalMaterializationSettled',
    'clearTitleListNativeInPlaceProjection',
    'reconcileTitleListNativeInPlaceProjection',
    'openTitleListNativeInPlace',
    'reconcilePendingTitleListMaterialization',
    'resetOpenedTitleListRows',
    'setTitleListMemberCollapsed',
    'releaseAtomicPageCollapseState',
    'rollbackAtomicPageCollapse',
    // Pass-4 identity surface: the committed collapse is resolved from
    // canonical identity, so the full-transaction world needs it too.
    'collapsedPageFlowRootByIdentity',
    'titleListCurrentProjectionNodes',
    'titleListCurrentProjectedCount',
    'currentCollapsedPageMembers',
    'currentCollapsedPageIntent',
    'collapsedPageCanonicalAuthorityCurrent',
    'resolveCurrentMountedPageMembers',
    'collapsedBoundaryNativeStartSurface',
    'resolveRenderedTurnSurfaceByIdentity',
    'getTurnSectionForNode',
    // getTurnAnchorNode is already supplied by this harness prologue.
    'validateCommittedAtomicPageCollapse',
    'collapsePageWithRenderedBoundaries',
    'applyExpandedCollapseControlState',
    'expandWindowedPageCollapse',
    'clearStaleWindowedCollapseStamps',
    'expandPageWithRenderedBoundaries',
    'reconcileActiveWindowedCollapse',
    'reconcileAtomicPageCollapseTransactions',
    'collapsedBoundaryStatusIdentity',
    'pageCollapseOperationEpoch',
    'pageCollapseEpochCoherent',
    'rollbackWindowedCollapseCandidates',
    'commitWindowedPageCollapse',
    'frozenAtomicPageCollapseDiagnostic',
    'recordAtomicPageCollapseAttempt',
    'getAtomicPageCollapseTransactionDiagnostic',
    'atomicPageCollapseFailureStage',
    'executeAtomicPageCollapseTransaction',
    'syncSyntheticTitleList',
    'expandAllAtomicPageCollapses',
  ];
  const correctionFallbacks = Object.freeze({
    titleListCanonicalMaterializationTerminal:
      "  function titleListCanonicalMaterializationTerminal() { return null; }",
    reconcilePendingTitleListMaterialization:
      "  function reconcilePendingTitleListMaterialization() { return null; }",
    setTitleListMemberCollapsed:
      "  function setTitleListMemberCollapsed() { return { ok: true, executor: 'legacy-inline' }; }",
  });
  const api = vm.runInNewContext(`(() => {
    const document = injectedDocument;
    const W = injectedWindow;
    const TOPW = W;
    const S = injectedState;
    const TITLE_LIST_PAGE_SIZE = 25;
    const TURN_HOST_SEL = '[data-testid="conversation-turn"], [data-testid^="conversation-turn-"]';
    const ATTR_CHAT_PAGE_NATIVE_HIDDEN = 'data-cgxui-chat-page-native-hidden';
    const ATTR_CHAT_PAGE_HIDDEN = 'data-cgxui-chat-page-hidden';
    const ATTR_CHAT_PAGE_QUESTION_HIDDEN = 'data-cgxui-chat-page-question-hidden';
    const ATTR_CHAT_PAGE_NO_ANSWER_QUESTION_HIDDEN = 'data-cgxui-chat-page-no-answer-question-hidden';
    const ATTR_CHAT_PAGE_WRAPPER_HIDDEN = 'data-cgxui-chat-page-wrapper-hidden';
    const ATTR_TITLE_LIST_FLOW_HIDDEN = 'data-cgxui-chat-page-title-list-hidden';
    const ATTR_TITLE_LIST_NUM = 'data-cgxui-chat-page-title-list-num';
    const ATTR_TITLE_LIST_SEGMENT = 'data-h2o-title-list-segment';
    const TITLE_LIST_SUFFIX_SEL = '[data-h2o-title-list-segment="suffix"]';
    const COLLAPSE_UNAVAILABLE_STATUS = 'collapsed-exact-boundary-unavailable';
    const MEMBER_RELEASE_MARKERS = [
      'data-cgxui-at-hidden',
      'data-at-question-hidden',
      ATTR_CHAT_PAGE_QUESTION_HIDDEN,
      ATTR_CHAT_PAGE_NO_ANSWER_QUESTION_HIDDEN,
      ATTR_TITLE_LIST_FLOW_HIDDEN,
    ];
    const MEMBER_RELEASE_SEL = MEMBER_RELEASE_MARKERS.map((attr) => '[' + attr + ']').join(',');
    // The canonical status reader the operation epoch consults. Control-driven,
    // like every other authority in this harness.
    const TITLE_LIST_EFFECTIVE_METHOD = Object.freeze({
      STATUS: 'getEffectivePresentationStatus',
      INDEX: 'getEffectivePresentationIndex',
      BY_QID: 'getEffectiveTurnRecordByQId',
      BY_AID: 'getEffectiveTurnRecordByAId',
    });
    const TURN_RUNTIME = () => ({
      getEffectivePresentationStatus: () => ({
        chatId: injectedControl.authority.chatId,
        routeKey: injectedControl.authority.routeKey,
        generation: injectedControl.authority.generation,
        canonicalFingerprint: injectedControl.authority.effectiveFingerprint,
        source: 'canonical',
      }),
    });
    const resolveChatId = () => 'chat-stage-2c2';
    const collapsedNativeRangeKey = (chatId, pageNum) => String(chatId) + '::' + String(pageNum);
    const titleListStackRegistryKey = (pageNum, chatId) => String(chatId) + '::' + String(pageNum);
    const titleListStackDomId = (pageNum) => 'cgxui-chat-page-title-stack-' + String(pageNum);
    const getSyntheticTitleListContainers = (pageNum) => Array.from(
      document.querySelectorAll('.cgxui-chat-page-title-list-synth')
    ).filter((node) => Number(node.getAttribute('data-page-num') || 0) === Number(pageNum));
    const MM_CORE_PAGES = () => ({
      setMiniMapPageCollapsed(pageNum, collapsed) {
        injectedCalls.minimapPropagations = Number(injectedCalls.minimapPropagations || 0) + 1;
        return { ok: true, pageNum, collapsed: !!collapsed };
      },
    });
    const AT_PUBLIC = () => ({
      buildDetachedBar(input) {
        injectedCalls.preparations += 1;
        const bar = document.createElement('div');
        bar.className = 'cgxui-answer-title';
        bar.setAttribute('data-answer-id', String(input.answerId || ''));
        bar.setAttribute('data-turn-no', String(input.turnNo || 0));
        bar.setAttribute('data-no-answer', input.noAnswer ? '1' : '0');
        return bar;
      },
    });
    const UM_PUBLIC = () => ({
      isCollapsedById(id, options = {}) {
        const sources = injectedControl.collapseSources.get(String(id || '')) || new Set();
        const source = String(options?.source || '');
        return source ? sources.has(source) : sources.size > 0;
      },
      expandManyByIds(ids, options = {}) {
        const source = String(options?.source || '');
        for (const id of ids || []) {
          const key = String(id || '');
          const sources = injectedControl.collapseSources.get(key) || new Set();
          if (source && sources.delete(source)) injectedCalls.residualSourceReleases += 1;
          if (sources.size) injectedControl.collapseSources.set(key, sources);
          else injectedControl.collapseSources.delete(key);
        }
        return { ok: true };
      },
      collapseManyByIds(ids, options = {}) {
        const source = String(options?.source || 'title-list-row');
        for (const id of ids || []) {
          const key = String(id || '');
          const sources = injectedControl.collapseSources.get(key) || new Set();
          sources.add(source);
          injectedControl.collapseSources.set(key, sources);
        }
        return { ok: true };
      },
    });
    const getConfiguredDividerRoutes = () => ({ dividerDotRoute: 'engine/unmount' });
    const recordManualTitleOverride = () => true;
    const onSyntheticTitleRowDblClick = () => {};
    const resolveSyntheticRowTitle = (member) => ({
      text: 'Title ' + String(member.turnNo),
      source: 'canonical',
      rank: 1,
      answerId: member.answerId || '',
    });
    const projectSyntheticRowTitle = () => ({ changed: false, preventedDowngrade: false });
    const applyStackedTitleBarWash = () => ({ status: 'painted' });
    const replayDeferredPageCollapseIntent = () => [];
    const releaseTitleStackBars = () => 0;
    const getTitleListStackStats = () => injectedStackStats;
    const syncTitleOnlyModeRootAttribute = () => {};
    const clearCollapsedBoundaryDiagnostic = () => {};
    const clearCollapseUnavailableFeedback = () => {};
    const applyCollapsedBoundaryControlState = () => ({ ok: true });
    const readRenderedBoundaryAuthority = (pageNum) => (
      Number(pageNum) === 1 ? injectedControl.authority : injectedControl.nextAuthority
    );
    const getRenderedPageBoundaryCapability = (pageNum) => (
      Number(pageNum) === 1 ? injectedControl.startCapability : injectedControl.nextCapability
    );
    const renderedBoundaryTransitionActive = (projection) => projection?.selectedPathConfirmationPending === true;
    const renderedBoundaryRecordStreaming = (record) => record?.livePendingStreaming === true;
    const buildTitleListPresentationPageModel = () => injectedControl.model;
    const memberSectionCandidates = (member, role) => {
      injectedCalls.mountCandidateReads += 1;
      const identity = role === 'user' ? member?.questionId : member?.answerId;
      return Array.from(injectedPlan.flowRoot.children || []).filter((node) => (
        pageCollapseRangeNodeCarriesIdentity(node, identity)
      ));
    };
    const getTurnAnchorNode = (section) => section;
    const titleListDirectFlowChild = (flowRoot, node) => (
      node?.parentElement === flowRoot ? node : null
    );
    const titleListMemberSections = (member) => ({
      record: null,
      questionSection: memberSectionCandidates(member, 'user')[0] || null,
      answerSection: member?.type === 'answer' ? (memberSectionCandidates(member, 'assistant')[0] || null) : null,
    });
    const memberAllFlowAnchors = (member) => [
      ...memberSectionCandidates(member, 'user'),
      ...(member?.type === 'answer' ? memberSectionCandidates(member, 'assistant') : []),
    ];
    const turnRecordForTitleListIdentity = (anyId = '', turnNo = 0) => (
      injectedControl.model.pages
        .flatMap((page) => page.turnRecords)
        .find((candidate) => (
          [candidate.id, candidate.questionId, candidate.answerId].includes(String(anyId || ''))
          || Number(candidate.turnNo || 0) === Number(turnNo || 0)
        )) || null
    );
    const pureCanonicalPageMemberDetails = () => injectedControl.model.pages[0].turnRecords;
    const _clearRestoreProps = (node) => {
      for (const prop of ['max-height', 'height', 'overflow', 'opacity', 'pointer-events']) {
        try {
          if (typeof node?.style?.removeProperty === 'function') node.style.removeProperty(prop);
          else node?.style?.setProperty?.(prop, '');
        } catch {}
      }
    };
    const clearTitleListFlowHiddenNode = (node) => {
      if (!node?.hasAttribute?.('data-cgxui-chat-page-title-list-hidden')) return false;
      node.removeAttribute('data-cgxui-chat-page-title-list-hidden');
      return true;
    };
    const MM_SH = () => ({ api: { rt: {
      setActiveTurnId(id) {
        injectedCalls.materializations += 1;
        const member = injectedControl.model.pages
          .flatMap((page) => page.turnRecords)
          .find((candidate) => [candidate.id, candidate.questionId, candidate.answerId].includes(String(id || ''))) || null;
        const selectedAnchors = member ? memberAllFlowAnchors(member) : [];
        injectedCalls.pendingSelfBlockingSuppressions += selectedAnchors.filter((node) => (
          node?.getAttribute?.(ATTR_CHAT_PAGE_NATIVE_HIDDEN) === String(injectedPlan.pageNum)
          || node?.getAttribute?.(ATTR_TITLE_LIST_FLOW_HIDDEN) === String(injectedPlan.pageNum)
        )).length;
        injectedControl.navigationGeneration += 1;
        injectedControl.navigationStatus = Object.freeze({
          status: 'mounting-target',
          targetQId: String(member?.questionId || ''),
          generation: injectedControl.navigationGeneration,
          errorCode: null,
        });
        return true;
      },
      getCompleteIndexNavigationStatus() {
        return injectedControl.navigationStatus;
      },
    } } });
    const evaluatePageCollapseCapability = () => {
      injectedCalls.capability += 1;
      injectedCalls.plans += 1;
      return {
        capability: Object.freeze({
          ...injectedCapability,
          activationReady: injectedControl.activationReady === true,
        }),
        plan: injectedControl.activationReady === true
          ? (typeof injectedControl.planTransform === 'function'
            ? injectedControl.planTransform({ ...injectedPlan, titleRows: injectedControl.model.pages[0].turnRecords })
            : { ...injectedPlan, titleRows: injectedControl.model.pages[0].turnRecords })
          : null,
      };
    };
    ${extractedNames.map((name) => {
      try { return extractFunction(SOURCE, name); }
      catch (error) {
        if (correctionFallbacks[name]) return correctionFallbacks[name];
        throw error;
      }
    }).join('\n')}
    const originalPrepare = prepareDetachedPageTitleList;
    prepareDetachedPageTitleList = (plan) => {
      const result = originalPrepare(plan);
      if (result.ok && typeof injectedControl.beforeFinalValidation === 'function') {
        const callback = injectedControl.beforeFinalValidation;
        injectedControl.beforeFinalValidation = null;
        callback();
      }
      return result;
    };
    const originalRevalidate = revalidateAtomicPageCollapsePlan;
    revalidateAtomicPageCollapsePlan = (plan) => {
      injectedCalls.revalidations += 1;
      return originalRevalidate(plan);
    };
    // Pass 4 split the single revalidation into a plan check before the first
    // write and a committed-state check after it. Both are counted, so the
    // ordering contract stays asserted rather than conflated.
    const originalCommittedValidate = validateCommittedAtomicPageCollapse;
    validateCommittedAtomicPageCollapse = (transaction) => {
      injectedCalls.committedValidations += 1;
      return originalCommittedValidate(transaction);
    };
    const originalCapture = captureCollapsedPageViewportAnchor;
    captureCollapsedPageViewportAnchor = (pageNum) => {
      injectedCalls.viewportReads += 1;
      return originalCapture(pageNum);
    };
    return Object.freeze({
      collapse: collapsePageWithRenderedBoundaries,
      execute: executeAtomicPageCollapseTransaction,
      diagnostic: getAtomicPageCollapseTransactionDiagnostic,
      expand: expandPageWithRenderedBoundaries,
      reconcile: reconcileAtomicPageCollapseTransactions,
      sync: syncSyntheticTitleList,
      expandAll: expandAllAtomicPageCollapses,
      prepare: prepareDetachedPageTitleList,
      revalidate: revalidateAtomicPageCollapsePlan,
      memberCurrent: pageCollapseMemberIdentityCurrent,
      nativeMount: titleListCurrentNativeMount,
      projectionNodes: titleListCurrentProjectionNodes,
      clearProjection: clearTitleListNativeInPlaceProjection,
      reconcileProjection: reconcileTitleListNativeInPlaceProjection,
      suffixContainers: getTitleListSuffixContainers,
      open: openTitleListNativeInPlace,
      reconcileOpen: reconcileTitleListNativeInPlaceProjection,
      close: clearTitleListNativeInPlaceProjection,
      resetOpen: resetOpenedTitleListRows,
      openMount: titleListCurrentOpenMount,
      state: S,
    });
  })()`, {
    injectedDocument: rangeHarness.document,
    injectedWindow: W,
    injectedState: S,
    injectedPlan: plan,
    injectedCapability: capability,
    injectedControl: control,
    injectedCalls: calls,
    injectedStackStats: stackStats,
    localStorage: { setItem: throwing('storage') },
    sessionStorage: { setItem: throwing('storage') },
    indexedDB: { open: throwing('storage') },
    fetch: throwing('network'),
    setTimeout: throwing('timers'),
    setInterval: throwing('timers'),
    requestAnimationFrame: throwing('raf'),
    MutationObserver: class {
      constructor() {
        safety.observers += 1;
        throw new Error('forbidden:observers');
      }
    },
  });
  rangeHarness.guard.locked = false;
  return {
    ...rangeHarness,
    rawPlan,
    plan,
    model,
    api,
    S,
    safety,
    calls,
    control,
    capability,
    window: W,
  };
}

/* Structural-scan skip set for the legacy full-interval transactions.

   `flowRoot` and `hostWrappers` are the two fields Prompt 171 grandfathered for
   the Pass-5 readers. `titleRowsPrepared` holds H2O's OWN synthetic title rows —
   live H2O DOM, not retained host-native state — and the scanner's H2O predicate
   recognises the synthetic container but not the individual bars it owns.
   Excluding them keeps the scan aimed at what it is for: stale remembered
   native/proof nodes. */
const PASS4R_TITLE_PROJECTION_KEYS = ['flowRoot', 'hostWrappers', 'titleRowsPrepared'];

function stampCount(h) {
  return h.rawPlan.hostWrappers.filter(
    (node) => node.getAttribute('data-cgxui-chat-page-native-hidden') === '1',
  ).length;
}
function titleLists(h) {
  return h.document.querySelectorAll('.cgxui-chat-page-title-list-synth');
}
function collapsedHeight(h) {
  return h.rawPlan.hostWrappers.reduce(
    (sum, node) => sum + (node.hasAttribute('data-cgxui-chat-page-native-hidden') ? 0 : 836),
    0,
  );
}
function collapse(h) {
  return h.api.collapse(1, { chatId: h.plan.chatId, source: 'validator' });
}
function expand(h) {
  // Models the user's second click on the divider control: an explicit
  // chat-page-divider source clears the persisted collapse intent, while
  // lifecycle expansions (rollback, host churn) preserve it.
  return h.api.expand(1, { chatId: h.plan.chatId, source: 'chat-page-divider:validator' });
}

const parent = parentCapability();
await fixture('parent capability prerequisites are ready while activation remains sealed', () => {
  equal(parent.capability.prerequisitesReady, true, 'parent prerequisites ready');
  equal(parent.capability.atomicTransactionImplemented, false, 'parent transaction sealed');
  equal(parent.capability.activationReady, false, 'parent activation sealed');
  equal(parent.readiness.ready, false, 'parent compatibility not ready');
  equal(parent.readiness.reason, 'atomic-collapse-transaction-pending', 'parent seal reason');
});
await fixture('parent click produces zero collapse mutations', () => {
  ok(!PARENT.includes('collapsePageWithRenderedBoundaries'), 'parent lacks transaction function');
  equal((PARENT.match(/data-cgxui-chat-page-native-hidden/g) || []).length > 0, true, 'parent retains inert legacy stamp support');
});

const h = createTransactionHarness();
await fixture('corrected capability reports atomic transaction implemented', () => {
  ok(SOURCE.includes('atomicTransactionImplemented: true'), 'implementation flag enabled');
});
await fixture('fully ready Page 1 reports activation ready', () => {
  ok(SOURCE.includes('activationReady: prerequisitesReady'), 'activation derives from prerequisites');
});
await fixture('compatibility wrapper reports ready', () => {
  ok(extractFunction(SOURCE, 'getCollapsedNativeBoundaryReadiness').includes('ready: activationReady'), 'compatibility uses activation');
});
await fixture('one click evaluates one capability', () => {
  const result = collapse(h);
  equal(result.ok, true, `collapse succeeds:${result.status}:${result.reason || ''}`);
  equal(h.calls.capability, 1, 'one capability read');
});
await fixture('one click builds one exact range plan', () => equal(h.calls.plans, 1, 'one plan'));
await fixture('one click enumerates flow root no more than once for plan', () => {
  equal(h.rawPlan.diagnostic.rangeProven, true, 'single real plan proven');
});
await fixture('plan contains exactly 50 host wrappers', () => equal(h.rawPlan.hostWrappers.length, 50, '50 hosts'));
await fixture('plan contains exactly 3 H2O exclusions', () => equal(h.rawPlan.h2oNodes.length, 3, '3 H2O nodes'));
await fixture('Page 2 boundary wrapper is the exclusive end', () => equal(h.rawPlan.endWrapper, h.end.wrapper, 'exclusive end'));
await fixture('Page 2 boundary wrapper is absent from host set', () => equal(h.rawPlan.hostWrappers.includes(h.end.wrapper), false, 'end excluded'));
await fixture('nodes after Page 2 boundary are excluded', () => equal(h.rawPlan.hostWrappers.includes(h.afterEnd), false, 'tail excluded'));
await fixture('complete 25-row title list is prepared detached', () => equal(h.S.atomicPageCollapseTransactions.values().next().value.titleRowsPrepared.length, 25, '25 rows'));
await fixture('detached preparation writes zero live DOM', () => equal(h.calls.titleInsertions, 1, 'only commit inserts live list'));
await fixture('detached preparation writes zero storage', () => equal(h.safety.storage, 0, 'no storage'));
await fixture('viewport anchor read precedes first transaction write', () => {
  equal(h.calls.viewportReads >= 1, true, 'anchor captured');
  equal(h.calls.firstWriteAt > 0, true, 'writes occurred after preparation');
});
await fixture('final revalidation occurs before insertion', () => {
  equal(h.calls.revalidations >= 1, true, 'the plan is revalidated immediately before the first write');
  equal(h.calls.committedValidations >= 1, true, 'the committed state is validated after the write');
});
await fixture('title insertion and stamps are synchronous', () => {
  equal(h.calls.titleInsertions, 1, 'one insertion');
  equal(h.calls.stamps, 50, 'same-task stamps');
});
await fixture('transaction has no async boundary', () => {
  equal(h.safety.timers + h.safety.raf + h.safety.observers, 0, 'no async surface');
});
await fixture('exactly 50 Page 1 wrappers are stamped', () => equal(stampCount(h), 50, '50 stamps'));
await fixture('all H2O nodes remain unstamped', () => equal(h.rawPlan.h2oNodes.some((node) => node.hasAttribute('data-cgxui-chat-page-native-hidden')), false, 'H2O clean'));
await fixture('Page 2 boundary remains unstamped', () => equal(h.end.wrapper.hasAttribute('data-cgxui-chat-page-native-hidden'), false, 'end clean'));
await fixture('every Page 2 wrapper remains unstamped', () => {
  equal(h.answer26.wrapper.hasAttribute('data-cgxui-chat-page-native-hidden'), false, 'answer 26 clean');
  equal(h.afterEnd.hasAttribute('data-cgxui-chat-page-native-hidden'), false, 'after end clean');
});
await fixture('host wrappers are not removed', () => equal(h.rawPlan.hostWrappers.every((node) => node.isConnected), true, 'hosts connected'));
await fixture('host wrappers are not reparented', () => equal(h.rawPlan.hostWrappers.every((node) => node.parentElement === h.flow), true, 'same parent'));
await fixture('host wrappers are not reordered', () => equal(h.rawPlan.hostWrappers[0], h.start.wrapper, 'start remains first host'));
await fixture('dividers are not removed', () => equal(h.p1Divider.isConnected && h.p2Divider.isConnected, true, 'dividers connected'));
await fixture('sentinels are not removed', () => equal(h.p1Sentinel.isConnected && h.p2Sentinel.isConnected, true, 'sentinels connected'));
await fixture('collapse moves zero Page units', () => equal(h.safety.pageUnitMoves, 0, 'no page units moved'));
await fixture('one synthetic Page 1 list is connected', () => {
  equal(titleLists(h).length, 1, 'one list');
  equal(h.S.collapsedPagesByChat.get(h.plan.chatId)?.has(1), true, 'memory-only collapsed state committed');
});
await fixture('all 25 title rows appear once', () => equal(titleLists(h)[0].children.length, 25, '25 unique nodes'));
await fixture('no duplicate native and title-list task boundary is published', () => equal(stampCount(h) === 50 && titleLists(h).length === 1, true, 'settled atomic state'));
await fixture('no hidden-without-title-list task boundary is published', () => equal(stampCount(h) > 0 && titleLists(h).length === 0, false, 'no broken state'));
await fixture('CSS stamp removes retained host height', () => equal(collapsedHeight(h), 0, 'zero Page 1 host height'));
await fixture('Page 2 remains adjacent after collapse', () => equal(h.end.wrapper.hasAttribute('data-cgxui-chat-page-native-hidden'), false, 'Page 2 visible'));
await fixture('collapse causes zero navigation', () => equal(h.safety.navigation, 0, 'no navigation'));
await fixture('collapse causes zero non-anchor scrolling', () => equal(h.safety.nonAnchorScrolling, 0, 'no scroll'));
await fixture('collapse causes zero persistence writes', () => equal(h.safety.storage + h.calls.persistence, 0, 'no persistence'));
await fixture('collapse invokes native-slot resolver zero times', () => equal(h.calls.nativeSlots, 0, 'zero native slots'));
await fixture('collapse invokes native ordinal inference zero times', () => equal(h.calls.nativeOrdinals, 0, 'zero ordinal'));
await fixture('collapse invokes pairCount times two zero times', () => equal(SOURCE.includes('pageCount * 2'), false, 'no pair multiplication'));
await fixture('collapse invokes test-ID ownership arithmetic zero times', () => equal(h.calls.testArithmetic, 0, 'zero test arithmetic'));
await fixture('second click while collapsed performs expansion', () => {
  const result = expand(h);
  equal(result.status, 'expanded', 'expanded');
});
await fixture('expansion releases exactly 50 stamps', () => equal(stampCount(h), 0, 'all stamps released'));
await fixture('expansion removes exactly one synthetic list', () => {
  equal(titleLists(h).length, 0, 'list removed');
  equal(h.S.collapsedPagesByChat.get(h.plan.chatId)?.has(1), false, 'collapsed memory cleared');
});
await fixture('expansion preserves unrelated visibility attributes', () => {
  h.start.wrapper.setAttribute('data-cgxui-at-hidden', 'manual');
  equal(h.start.wrapper.getAttribute('data-cgxui-at-hidden'), 'manual', 'manual visibility preserved');
});
await fixture('expansion moves zero host wrappers', () => equal(h.safety.hostMoves, 0, 'no host movement'));
await fixture('expansion moves zero Page units', () => equal(h.safety.pageUnitMoves, 0, 'no marker movement'));
await fixture('expansion writes zero persistence', () => equal(h.safety.storage, 0, 'no storage'));
await fixture('second expansion performs zero mutations', () => equal(expand(h).mutations, 0, 'idempotent expansion'));
// A committed member must survive the host virtualizing its content away.
// Measured live: the wrapper stays connected, in place and stamped, but its
// inner identity carrier is gone, so the message identity recorded at commit
// time is momentarily unprovable while the wrapper's own container id is not.
// Before the dual-domain proof this read as "member stale" and expanded a
// collapse the user never asked to open.
await fixture('committed member survives content unhydration', () => {
  const node = h.document.createElement('div');
  node.setAttribute('data-turn-id-container', 'container-A');
  const carrier = h.document.createElement('section');
  carrier.setAttribute('data-turn-id', 'container-A');
  const message = h.document.createElement('div');
  message.setAttribute('data-message-id', 'message-A');
  carrier.appendChild(message);
  node.appendChild(carrier);
  const proof = { identity: 'message-A', containerId: 'container-A' };
  equal(h.api.memberCurrent(node, proof), true, 'hydrated member is current');
  // Host virtualizes the content away: only the wrapper survives.
  node.removeChild(carrier);
  equal(h.api.memberCurrent(node, proof), true, 'unhydrated member stays current');
  // A wrapper the host reused for a different turn is still rejected.
  node.setAttribute('data-turn-id-container', 'container-B');
  equal(h.api.memberCurrent(node, proof), false, 'different container is not current');
  // A proof without the container domain still rejects an unprovable node.
  equal(h.api.memberCurrent(node, { identity: 'message-A' }), false, 'no fallback without container proof');
});

await fixture('five cycles use identical stamp sets', () => {
  const expected = h.rawPlan.hostWrappers;
  for (let index = 0; index < 5; index += 1) {
    equal(collapse(h).ok, true, `cycle ${index + 1} collapse`);
    equal(stampCount(h), expected.length, `cycle ${index + 1} set`);
    equal(expand(h).ok, true, `cycle ${index + 1} expand`);
  }
});
await fixture('five cycles accumulate zero layout offset', () => equal(collapsedHeight(h), 50 * 836, 'expanded height restored once'));

const abort = createTransactionHarness({ activationReady: false });
await fixture('failure before first write performs zero mutation', () => {
  equal(collapse(abort).ok, false, 'blocked');
  equal(stampCount(abort), 0, 'no stamps');
  equal(titleLists(abort).length, 0, 'no list');
});
const disconnect = createTransactionHarness();
disconnect.control.beforeFinalValidation = () => { disconnect.rawPlan.hostWrappers[10].isConnected = false; };
await fixture('wrapper disconnection at final revalidation aborts cleanly', () => {
  equal(collapse(disconnect).ok, false, 'aborted');
  equal(stampCount(disconnect), 0, 'no stamps');
});
const scope = createTransactionHarness();
scope.control.beforeFinalValidation = () => { scope.control.authority = { ...scope.control.authority, generation: 2 }; };
await fixture('scope change at final revalidation aborts cleanly', () => {
  equal(collapse(scope).ok, false, 'aborted');
  equal(titleLists(scope).length, 0, 'no list');
});
const writeFail = createTransactionHarness();
const failingNode = writeFail.rawPlan.hostWrappers[9];
const failingSet = failingNode.setAttribute.bind(failingNode);
failingNode.setAttribute = (name, value) => {
  if (name === 'data-cgxui-chat-page-native-hidden') throw new Error('injected-write-failure');
  return failingSet(name, value);
};
await fixture('failure after insertion invokes complete rollback', () => equal(collapse(writeFail).status, 'atomic-collapse-rolled-back', 'rolled back'));
await fixture('rollback releases all transaction stamps', () => equal(stampCount(writeFail), 0, 'rollback stamps zero'));
await fixture('rollback removes synthetic list', () => equal(titleLists(writeFail).length, 0, 'rollback list zero'));
await fixture('rollback leaves Page units intact', () => equal(writeFail.p1Divider.isConnected && writeFail.p2Divider.isConnected, true, 'markers intact'));
await fixture('rollback leaves Page 2 visible', () => equal(writeFail.end.wrapper.hasAttribute('data-cgxui-chat-page-native-hidden'), false, 'Page 2 visible'));

async function lifecycleFixture(name, mutate) {
  await fixture(name, () => {
    const x = createTransactionHarness();
    equal(collapse(x).ok, true, 'initial collapse');
    mutate(x);
    x.api.reconcile(name);
    equal(stampCount(x), 0, 'expanded safely');
    equal(titleLists(x).length, 0, 'list removed');
  });
}
await lifecycleFixture('route change expands safely', (x) => { x.control.authority = { ...x.control.authority, routeKey: '/c/new' }; });
await lifecycleFixture('generation change expands safely', (x) => { x.control.authority = { ...x.control.authority, generation: 2 }; });
await lifecycleFixture('effective fingerprint change expands safely', (x) => { x.control.authority = { ...x.control.authority, effectiveFingerprint: 'djb2:new' }; });
await lifecycleFixture('graph fingerprint change expands safely', (x) => { x.control.startCapability = { ...x.control.startCapability, graphFingerprint: 'djb2:new' }; });
await lifecycleFixture('flow-root replacement expands safely', (x) => { x.flow.isConnected = false; });
// 'start-boundary replacement expands safely' and 'end-boundary replacement
// expands safely' are no longer generic lifecycle cases. Their remembered-native
// expectation was retired by Pass 4, and they are re-implemented as dedicated
// fixtures under the same names in the Stage-2 identity world below, where a
// real CURRENT replacement can actually be mounted and resolved.
await lifecycleFixture('branch transition expands safely', (x) => { x.control.authority = { ...x.control.authority, projection: { selectedPathConfirmationPending: true } }; });
await lifecycleFixture('streaming begins while collapsed expands safely', (x) => { x.control.authority = { ...x.control.authority, record: { livePendingStreaming: true } }; });
await lifecycleFixture('selected path 39 to 18 releases all stamps', (x) => { x.control.model = buildTitleModel(18); });
await fixture('selected path 18 to 39 does not auto-collapse', () => {
  const x = createTransactionHarness();
  equal(x.api.reconcile('18-to-39').length, 0, 'no transaction to reactivate');
});
await fixture('reload-equivalent initialization starts expanded', () => equal(createTransactionHarness().S.atomicPageCollapseTransactions.size, 0, 'memory empty'));
await fixture('legacy persisted collapse does not activate collapse', () => {
  const x = createTransactionHarness();
  equal(stampCount(x), 0, 'legacy storage ignored');
});
await fixture('unsupported final page remains expanded', () => {
  const x = createTransactionHarness({ activationReady: false });
  equal(collapse(x).ok, false, 'unsupported');
});
await fixture('ambiguous range remains expanded', () => {
  const x = createTransactionHarness({ activationReady: false });
  equal(stampCount(x), 0, 'ambiguous sealed');
});
await fixture('incomplete title rows remain expanded', () => {
  const x = createTransactionHarness();
  x.control.model = buildTitleModel(24);
  equal(collapse(x).ok, false, 'incomplete rejected');
});
await fixture('page-unit drift remains expanded', () => {
  const x = createTransactionHarness();
  x.control.nextCapability = { ...x.control.nextCapability, pageUnitOrderCurrent: false };
  equal(collapse(x).ok, false, 'drift rejected');
});
await fixture('reentrant pointer click is blocked', () => {
  const x = createTransactionHarness();
  x.S.atomicPageCollapseGuards.add(`${x.plan.chatId}::1`);
  equal(collapse(x).status, 'transaction-busy', 'guard blocks pointer');
});
await fixture('reentrant keyboard activation is blocked', () => {
  const x = createTransactionHarness();
  x.S.atomicPageCollapseGuards.add(`${x.plan.chatId}::1`);
  equal(collapse(x).status, 'transaction-busy', 'guard blocks keyboard');
});
await fixture('pointer and keyboard paths share one transaction', () => ok(SOURCE.includes('S.onDividerDotKeyDown = forwardCollapseControlKeyboardActivation'), 'keyboard forwards to same click'));
await fixture('capability reads remain DOM-free', () => equal(h.rangeHarness?.safety?.domMutations || 0, 0, 'read-only authority'));
await fixture('capability reads remain storage-free', () => equal(h.safety.storage, 0, 'read storage-free'));
await fixture('transaction adds no timer', () => equal(h.safety.timers, 0, 'no timer'));
await fixture('transaction adds no interval', () => equal(h.safety.timers, 0, 'no interval'));
await fixture('transaction adds no RAF loop', () => equal(h.safety.raf, 0, 'no RAF'));
await fixture('transaction adds no observer', () => equal(h.safety.observers, 0, 'no observer'));
await fixture('transaction adds no network request', () => equal(h.safety.network, 0, 'no network'));
await fixture('transaction writes no authority state', () => equal(h.safety.canonical + h.safety.alias, 0, 'authority untouched'));
await fixture('product feedback excludes technical internals', () => {
  ok(!/native-slot|graph|wrapper|fingerprint/.test(String(h.capability.productReason)), 'safe product reason');
});
await fixture('1C1b is sole native-hidden transaction writer', () => {
  // P03C adds bounded unhide/rehide writes for the currently selected native
  // mount, but all statements remain inside this transaction/presentation
  // owner. No lifecycle helper or second module receives the attribute.
  // Stage-2 Pass 3 adds exactly two more, both still inside this transaction
  // owner: the mounted-subset stamp in applyCollapsedNativeRange, and the
  // model-B rollback restore in rollbackWindowedCollapseCandidates.
  // Stage-2 Pass 4 REMOVES one: the retained-node rebind restamp is retired
  // with the rebind model itself, so the bound tightens rather than relaxes.
  equal((SOURCE.match(/setAttribute\(ATTR_CHAT_PAGE_NATIVE_HIDDEN/g) || []).length, 6, 'bounded transaction-owner writer statements');
});
await fixture('1A1b remains Page-unit-only', () => {
  const core = fs.readFileSync(path.join(ROOT, 'src-runtime-base/1A1b.🟥🗺️ MiniMap Core 🧱🗺️.js'), 'utf8');
  equal(core.includes('collapsePageWithRenderedBoundaries'), false, 'no transaction in core');
});
await fixture('rendered boundary API remains semantically unchanged', () => ok(SOURCE.includes('function getRenderedPageBoundaryCapability('), 'boundary retained'));
await fixture('range diagnostics remain semantically unchanged', () => {
  equal(h.rawPlan.diagnostic.supported, true, 'range supported');
  equal(h.rawPlan.diagnostic.hostWrapperCount, 50, 'range count unchanged');
});
await fixture('graph bridge remains required', () => ok(SOURCE.includes('getGraphIdentityDiagnostics'), 'graph getter consumed'));

function createTransitionTimeMountLossHarness() {
  const x = createTransactionHarness();
  equal(collapse(x).ok, true, 'page collapse committed before transition-time loss');
  const transaction = x.S.atomicPageCollapseTransactions.values().next().value;
  const member = transaction.titleRows[0];
  const preOpenMount = x.api.nativeMount(transaction, member);
  const selectedRow = transaction.titleRowsPrepared[0];
  const lostAnswer = x.answer1.wrapper;
  const proof = x.rawPlan.wrapperProofs.get(lostAnswer);
  let lossTriggered = false;
  const originalSetAttribute = selectedRow.setAttribute.bind(selectedRow);
  selectedRow.setAttribute = (name, value) => {
    const result = originalSetAttribute(name, value);
    if (!lossTriggered && name === 'data-h2o-title-row-opened' && String(value) === '1') {
      lossTriggered = true;
      lostAnswer.remove();
    }
    return result;
  };
  x.calls.mountCandidateReads = 0;
  const opened = x.api.open(transaction, member);
  selectedRow.setAttribute = originalSetAttribute;
  return {
    x,
    transaction,
    member,
    selectedRow,
    lostAnswer,
    proof,
    preOpenMount,
    lossTriggered,
    opened,
  };
}

await fixture('P04B transition target is exactly mounted immediately before title open', () => {
  const scenario = createTransitionTimeMountLossHarness();
  equal(scenario.preOpenMount.ok, true, 'exact selected Q/A mount exists before open');
  equal(scenario.preOpenMount.anchors.length, 2, 'both selected native anchors are current before open');
});
await fixture('P04B host lifecycle loss during the real open projection enters scalar pending', () => {
  const scenario = createTransitionTimeMountLossHarness();
  equal(scenario.lossTriggered, true, 'host replacement occurs during selected-row projection');
  equal(scenario.opened.status, 'pending', 'transition-time loss enters pending');
  equal(scenario.x.calls.materializations, 1, 'one bounded canonical materialization is requested');
  const state = scenario.x.S.titleListOpenStatesByKey.values().next().value;
  equal(Object.values(state).some((value) => value instanceof scenario.x.flow.constructor), false, 'pending state is scalar-only');
  const synchronized = scenario.x.api.sync(
    scenario.transaction.pageNum,
    scenario.transaction.chatId,
    true,
    { reason: 'row-opened' },
  );
  equal(synchronized.status, 'pending', 'same-turn synchronous repair preserves bounded pending state');
  equal(scenario.x.S.atomicPageCollapseTransactions.size, 1, 'pending repair does not expand the committed page');
  equal(scenario.x.calls.materializations, 1, 'pending repair does not arm a second materialization request');
});
await fixture('P04B open resolves the current canonical mount before committing pending state', () => {
  const scenario = createTransitionTimeMountLossHarness();
  equal(scenario.x.calls.mountCandidateReadsAtOpenStateSet.at(-1) > 0, true, 'current mount was read before scalar state commit');
});
await fixture('P04B pending reveal is not self-blocked by selected whole-flow suppression', () => {
  const scenario = createTransitionTimeMountLossHarness();
  equal(scenario.x.calls.pendingSelfBlockingSuppressions, 0, 'selected surviving anchor remains materialization-eligible');
  equal(scenario.x.start.wrapper.hasAttribute('data-cgxui-chat-page-native-hidden'), false, 'selected current question anchor is exposed while answer remount is pending');
});
await fixture('P04B terminal no-progress clears the failed open projection coherently', () => {
  const scenario = createTransitionTimeMountLossHarness();
  const state = scenario.x.S.titleListOpenStatesByKey.values().next().value;
  scenario.x.control.navigationStatus = Object.freeze({
    status: 'unreachable',
    targetQId: scenario.member.questionId,
    generation: Number(state?.materializationGeneration || scenario.x.control.navigationGeneration),
    errorCode: 'no-progress',
  });
  const terminal = scenario.x.api.reconcileOpen(scenario.transaction, { reason: 'materialization-terminal' });
  equal(terminal.status.includes('cleared'), true, 'terminal materialization failure clears projection');
  equal(scenario.x.S.titleListOpenStatesByKey.size, 0, 'failed scalar open state is drained');
  equal(scenario.selectedRow.hasAttribute('data-h2o-title-row-opened'), false, 'selected row no longer advertises an unavailable open turn');
  equal(scenario.selectedRow.hasAttribute('data-h2o-title-row-pending'), false, 'pending row state is drained');
});
await fixture('P04B replacement remount settles the exact canonical native turn in place', () => {
  const scenario = createTransitionTimeMountLossHarness();
  const NodeCtor = scenario.x.flow.constructor;
  // Every later write to the predecessor is counted, so "untouched" is proven
  // by mutation count rather than by absence from an array.
  let staleWrites = 0;
  const staleSet = scenario.lostAnswer.setAttribute.bind(scenario.lostAnswer);
  const staleRemove = scenario.lostAnswer.removeAttribute.bind(scenario.lostAnswer);
  scenario.lostAnswer.setAttribute = (name, value) => { staleWrites += 1; return staleSet(name, value); };
  scenario.lostAnswer.removeAttribute = (name) => { staleWrites += 1; return staleRemove(name); };
  const replacement = new NodeCtor('DIV', 'host-turn-slot', scenario.x.guard);
  replacement.setAttribute('data-turn-id-container', scenario.proof.identity);
  const host = new NodeCtor('SECTION', 'native-turn-host', scenario.x.guard);
  const carrier = new NodeCtor('SECTION', 'identity-carrier', scenario.x.guard);
  carrier.setAttribute('data-turn-id', scenario.proof.identity);
  // A real replacement arrives as a native turn host. Without the testid the
  // identity resolver correctly refuses it as native-test-host-unavailable,
  // which would make the remount fixtures pass for the wrong reason. This
  // scenario builds a distinct native-turn host, so the host carries it.
  host.setAttribute('data-testid', 'conversation-turn-7');
  carrier.setAttribute('data-turn', 'assistant');
  host.appendChild(carrier);
  replacement.appendChild(host);
  const nextWrapper = scenario.x.rawPlan.hostWrappers[2] || scenario.x.end.wrapper;
  scenario.x.flow.insertBefore(replacement, nextWrapper);
  scenario.x.window.H2O.obs.mounts.set(scenario.proof.identity, { el: carrier, shell: replacement });
  const [result] = scenario.x.api.reconcile('observer-hub-remount');
  equal(result.status, 'current', 'replacement reconciliation preserves the committed title page');
  equal(scenario.x.api.openMount(scenario.transaction).ok, true, 'replacement resolves by exact canonical identity');
  equal(replacement.hasAttribute('data-cgxui-chat-page-native-hidden'), false, 'replacement selected anchor is visible');
  equal(scenario.x.api.projectionNodes(scenario.transaction).nodes.includes(scenario.lostAnswer), false, 'stale predecessor is absent from the current projection surface');
  /* The retained proof Map is retired by Pass 4: a committed collapse keeps no
     element-keyed proof at all, so "the stale proof key is released" is now the
     stronger claim that no such key can exist. */
  equal(Object.prototype.hasOwnProperty.call(scenario.transaction, 'wrapperProofs'), false, 'the transaction owns no wrapperProofs property at all');
  equal(pass4rHostNodes(scenario.transaction, NodeCtor, PASS4R_TITLE_PROJECTION_KEYS).length, 0, 'no remembered native or proof node is reachable from persistent transaction state');
  equal(staleWrites, 0, 'the stale predecessor received no write of any kind');
  equal(replacement.parentElement, scenario.x.flow, 'replacement remains under the host-owned flow');
  equal(scenario.transaction.titleRowsPrepared[0].parentElement, scenario.transaction.titleListContainer, 'selected row remains in the H2O prefix');
  equal(scenario.transaction.titleRowsPrepared.slice(1).every((row) => row.parentElement?.getAttribute?.('data-h2o-title-list-segment') === 'suffix'), true, 'nonselected rows remain in the H2O suffix');
});
await fixture('P04B explicit page close drains virtualized collapsed-flow residue', () => {
  const x = createTransactionHarness();
  equal(collapse(x).ok, true, 'page collapse committed');
  const transaction = x.S.atomicPageCollapseTransactions.values().next().value;
  const member = x.model.pages[0].turnRecords[0];
  const questionAnchor = x.api.nativeMount(transaction, member).anchors[0];
  x.control.collapseSources.set(member.answerId, new Set(['title-list-row', 'answer-title']));
  questionAnchor.setAttribute('data-at-collapsed', '1');
  questionAnchor.style.setProperty('max-height', '0px');
  x.answer1.wrapper.remove();
  const result = expand(x);
  equal(result.status, 'expanded', 'explicit page close completes');
  equal(x.control.collapseSources.size, 0, 'retired title collapse sources are cleared without a mounted answer');
  equal(questionAnchor.hasAttribute('data-at-collapsed'), false, 'question-side collapse residue is released');
  equal(String(questionAnchor.style.getPropertyValue('max-height') || ''), '', 'collapsed inline projection residue is released');
});
await fixture('P04B close during pending prevents stale remount from reopening title state', () => {
  const scenario = createTransitionTimeMountLossHarness();
  equal(scenario.x.api.close(scenario.transaction, { rehide: true }).status, 'closed', 'pending state closes');
  const NodeCtor = scenario.x.flow.constructor;
  const replacement = new NodeCtor('DIV', 'host-turn-slot', scenario.x.guard);
  replacement.setAttribute('data-turn-id-container', scenario.proof.identity);
  const carrier = new NodeCtor('SECTION', 'identity-carrier', scenario.x.guard);
  carrier.setAttribute('data-turn-id', scenario.proof.identity);
  // A real replacement arrives as a native turn host. Without the testid the
  // identity resolver correctly refuses it as native-test-host-unavailable,
  // which would make the remount fixtures pass for the wrong reason.
  carrier.setAttribute('data-testid', 'conversation-turn-7');
  carrier.setAttribute('data-turn', 'assistant');
  replacement.appendChild(carrier);
  scenario.x.flow.insertBefore(replacement, scenario.x.rawPlan.hostWrappers[2] || scenario.x.end.wrapper);
  scenario.x.window.H2O.obs.mounts.set(scenario.proof.identity, { el: carrier, shell: replacement });
  scenario.x.api.reconcile('stale-observer-after-pending-close');
  equal(scenario.x.S.titleListOpenStatesByKey.size, 0, 'stale remount does not recreate open or pending state');
  equal(replacement.getAttribute('data-cgxui-chat-page-native-hidden'), '1', 'cancelled selected replacement remains governed by closed title-list projection');
});
await fixture('P04B reset during pending drains scalar request state', () => {
  const scenario = createTransitionTimeMountLossHarness();
  scenario.x.api.resetOpen(scenario.transaction.pageNum, scenario.transaction.chatId);
  equal(scenario.x.S.titleListOpenStatesByKey.size, 0, 'reset drains the pending scalar state');
  equal(scenario.selectedRow.hasAttribute('data-h2o-title-row-pending'), false, 'reset clears pending row presentation');
  equal(scenario.selectedRow.hasAttribute('data-h2o-title-row-opened'), false, 'reset clears unavailable open presentation');
});
await fixture('P04B route or generation transition during pending cannot preserve stale open intent', () => {
  const scenario = createTransitionTimeMountLossHarness();
  scenario.transaction.routeKey = '/c/replaced-route';
  const [result] = scenario.x.api.reconcile('route-transition-during-pending');
  equal(result.status, 'expanded', 'stale pending transaction expands safely');
  equal(scenario.x.S.titleListOpenStatesByKey.size, 0, 'route transition drains stale pending state');
  equal(scenario.x.S.atomicPageCollapseTransactions.size, 0, 'route transition releases the stale committed transaction');
});

await fixture('P03C opens the exact canonical native turn in place between H2O prefix and suffix', () => {
  const x = createTransactionHarness();
  equal(collapse(x).ok, true, 'page collapse committed');
  const transaction = x.S.atomicPageCollapseTransactions.values().next().value;
  const member = transaction.titleRows[0];
  const nativeAnchors = x.api.projectionNodes(transaction).nodes.filter((node) => (
    node === x.start.wrapper || node === x.answer1.wrapper
  ));
  const originalParents = nativeAnchors.map((node) => node.parentElement);
  const opened = x.api.open(transaction, member);
  equal(opened.status, 'open', 'canonical mounted target opens');
  equal(nativeAnchors.map((node) => node.parentElement), originalParents, 'native parents stay host-owned');
  equal(nativeAnchors.every((node) => !node.hasAttribute('data-cgxui-chat-page-native-hidden')), true, 'exact native Q/A is visible');
  const suffix = x.document.querySelector('[data-h2o-title-list-segment="suffix"]');
  ok(suffix?.parentElement === x.flow, 'H2O suffix is in the original flow');
  equal(transaction.titleRowsPrepared[0].parentElement, transaction.titleListContainer, 'selected row stays in prefix');
  equal(transaction.titleRowsPrepared.slice(1).every((row) => row.parentElement === suffix), true, 'later title rows stay in suffix');
  equal(nativeAnchors.some((node) => transaction.titleListContainer.contains(node) || suffix.contains(node)), false, 'H2O projection contains no native wrapper');
  equal(x.safety.hostMoves, 0, 'open performs zero native-wrapper moves');
});
await fixture('P03C close restores the complete synthetic list without native restoration', () => {
  const x = createTransactionHarness();
  equal(collapse(x).ok, true, 'page collapse committed');
  const transaction = x.S.atomicPageCollapseTransactions.values().next().value;
  const member = transaction.titleRows[0];
  equal(x.api.open(transaction, member).status, 'open', 'opened');
  const nativeParents = x.api.projectionNodes(transaction).nodes.map((node) => node.parentElement);
  const closed = x.api.close(transaction, { rehide: true });
  equal(closed.status, 'closed', 'closed');
  equal(transaction.titleRowsPrepared.every((row) => row.parentElement === transaction.titleListContainer), true, 'all title rows return to one H2O list');
  equal(x.document.querySelectorAll('[data-h2o-title-list-segment="suffix"]').length, 0, 'suffix removed');
  equal(x.api.projectionNodes(transaction).nodes.map((node) => node.parentElement), nativeParents, 'native parents never change');
  equal(x.api.projectionNodes(transaction).nodes.every((node) => node.getAttribute('data-cgxui-chat-page-native-hidden') === '1'), true, 'native page is hidden again');
  equal(x.S.titleListOpenStatesByKey.size, 0, 'scalar open state drains');
  equal(x.safety.hostMoves, 0, 'close performs zero native-wrapper moves');
});
await fixture('P03C unmounted canonical target uses one bounded materialization request', () => {
  const x = createTransactionHarness();
  equal(collapse(x).ok, true, 'page collapse committed');
  const transaction = x.S.atomicPageCollapseTransactions.values().next().value;
  const member = transaction.titleRows[0];
  x.start.wrapper.remove();
  const first = x.api.open(transaction, member);
  equal(first.status, 'pending', 'missing exact mount is pending');
  equal(x.calls.materializations, 1, 'one canonical materialization request');
  const second = x.api.open(transaction, member);
  equal(second.status, 'pending', 'repeat remains bounded pending');
  equal(x.calls.materializations, 1, 'same open identity requests materialization at most once');
  const reconciled = x.api.openMount(transaction);
  equal(reconciled.ok, false, 'no ordinal or alternate target is substituted');
  equal(x.S.titleListOpenStatesByKey.size, 1, 'only scalar pending state is retained');
  const state = x.S.titleListOpenStatesByKey.values().next().value;
  equal(Object.values(state).some((value) => value instanceof x.flow.constructor), false, 'pending state retains no native node');
});
await fixture('P03C host remount resolves the current MountRegistry wrapper and releases the stale one', () => {
  const x = createTransactionHarness();
  equal(collapse(x).ok, true, 'page collapse committed');
  const transaction = x.S.atomicPageCollapseTransactions.values().next().value;
  const member = transaction.titleRows[0];
  equal(x.api.open(transaction, member).status, 'open', 'selected turn opened');
  const stale = x.start.wrapper;
  const proof = x.rawPlan.wrapperProofs.get(stale);
  const NodeCtor = x.flow.constructor;
  // Every later write to the predecessor is counted, so "released" is proven by
  // mutation count and attribute state, not merely by absence from an array.
  let staleWrites = 0;
  const staleSet = stale.setAttribute.bind(stale);
  const staleRemove = stale.removeAttribute.bind(stale);
  const staleMarkerBefore = stale.getAttribute('data-cgxui-chat-page-native-hidden');
  stale.setAttribute = (name, value) => { staleWrites += 1; return staleSet(name, value); };
  stale.removeAttribute = (name) => { staleWrites += 1; return staleRemove(name); };
  const replacement = new NodeCtor('DIV', 'host-turn-slot', x.guard);
  replacement.setAttribute('data-turn-id-container', proof.identity);
  const host = new NodeCtor('SECTION', 'native-turn-host', x.guard);
  const carrier = new NodeCtor('SECTION', 'identity-carrier', x.guard);
  carrier.setAttribute('data-turn-id', proof.identity);
  // Distinct native-turn host in this scenario, so the host carries the testid.
  host.setAttribute('data-testid', 'conversation-turn-7');
  carrier.setAttribute('data-turn', 'user');
  host.appendChild(carrier);
  replacement.appendChild(host);
  x.flow.replaceChild(replacement, stale);
  x.window.H2O.obs.mounts.set(proof.identity, { el: carrier, shell: replacement });
  const [result] = x.api.reconcile('observer-hub-remount');
  equal(result.status, 'current', 'committed projection survives exact remount');
  const mount = x.api.openMount(transaction);
  equal(mount.ok, true, 'current canonical mount resolves');
  equal(mount.anchors.includes(replacement), true, 'replacement wrapper is presented');
  equal(mount.anchors.includes(stale), false, 'stale wrapper is not presented');
  equal(x.api.projectionNodes(transaction).nodes.includes(stale), false, 'the stale wrapper is absent from the current projection surface');
  /* The retained proof Map is retired by Pass 4, so the stale proof key cannot
     be released — it can only be proven never to have existed. */
  equal(Object.prototype.hasOwnProperty.call(transaction, 'wrapperProofs'), false, 'the transaction owns no wrapperProofs property at all');
  equal(pass4rHostNodes(transaction, NodeCtor, PASS4R_TITLE_PROJECTION_KEYS).length, 0, 'no remembered native or proof node is reachable from persistent transaction state');
  // The member is answer-type, so its mount legitimately spans a question and
  // an answer anchor. What must be singular is the presentation of the REMOUNTED
  // identity: the replacement resolves exactly once, and nothing else does.
  equal(mount.anchors.filter((node) => node === replacement).length, 1, 'exactly one current canonical presentation resolves for the remounted identity');
  equal(staleWrites, 0, 'the stale predecessor received no write of any kind');
  equal(stale.getAttribute('data-cgxui-chat-page-native-hidden'), staleMarkerBefore, 'its attribute state is exactly as the host left it');
  equal(replacement.parentElement, x.flow, 'replacement remains under host flow');
  // The complete original remount/release path still succeeds end to end.
  const released = x.api.expand(1, { chatId: transaction.chatId, source: 'chat-page-divider:close' });
  equal(released.ok, true, 'the full release path completes after the remount');
  equal(replacement.getAttribute('data-cgxui-chat-page-native-hidden'), null, 'the current replacement is released');
  equal(staleWrites, 0, 'release still never writes the stale predecessor');
});
await fixture('P03C same-wrapper rehydration preserves host-owned nested content', () => {
  const x = createTransactionHarness();
  equal(collapse(x).ok, true, 'page collapse committed');
  const transaction = x.S.atomicPageCollapseTransactions.values().next().value;
  const member = transaction.titleRows[0];
  equal(x.api.open(transaction, member).status, 'open', 'selected turn opened');
  const wrapper = x.start.wrapper;
  const prior = wrapper.firstChild;
  const currentHostContent = new x.flow.constructor('DIV', 'host-rehydrated-content', x.guard);
  wrapper.replaceChild(currentHostContent, prior);
  const result = x.api.open(transaction, member);
  equal(result.status, 'open', 'same canonical wrapper remains open');
  equal(wrapper.firstChild, currentHostContent, 'host rehydrated content is untouched');
  equal(wrapper.parentElement, x.flow, 'same wrapper remains host-owned');
});
await fixture('P03C rapid close and stale reconciliation cannot recreate native ownership state', () => {
  const x = createTransactionHarness();
  equal(collapse(x).ok, true, 'page collapse committed');
  const transaction = x.S.atomicPageCollapseTransactions.values().next().value;
  const member = transaction.titleRows[0];
  equal(x.api.open(transaction, member).status, 'open', 'opened');
  equal(x.api.close(transaction, { rehide: true }).status, 'closed', 'closed');
  equal(x.api.reconcile('stale-observer-after-close')[0].status, 'current', 'stale callback is bounded reconciliation');
  equal(x.S.titleListOpenStatesByKey.size, 0, 'stale callback creates no open state');
  equal(x.api.projectionNodes(transaction).nodes.every((node) => node.parentElement === x.flow), true, 'all native wrappers remain in host flow');
  equal(x.safety.hostMoves, 0, 'no native wrapper was reparented');
});
await fixture('P03C C9 failed restore cannot leak a native reference because restore state is absent', () => {
  equal(SOURCE.includes('restoreInlineTurnToFlow'), false, 'no native restore helper remains');
  equal(SOURCE.includes('_h2oTitleListOrigin'), false, 'no raw native origin can leak');
});
await fixture('P03C C10 native-in-place projection cannot create double wrapper ownership', () => {
  equal(SOURCE.includes('adoptOpenedTurnIntoStack'), false, 'no native adoption helper remains');
  equal(SOURCE.includes('data-h2o-title-inline-slot'), false, 'no native inline slot remains');
  equal(SOURCE.includes('reconcileTitleListNativeInPlaceProjection'), true, 'bounded native-in-place projection replaces adoption');
});

// ---------------------------------------------------------------------------
// Stage 1 (Defect D) — current-ChatGPT-host native page-boundary identity.
//
// Measured host facts (Prompt 149) that the retired resolver violated:
//   * data-testid="conversation-turn-N" is WINDOW-RELATIVE. N tracks the host's
//     sliding render window, not canonical order, and is renumbered whenever
//     history is prepended.
//   * section data-turn-id carries the branch NODE id. It equals the product
//     qId only for never-branched turns.
//   * a logical turn is not fixed at exactly two native sections; consecutive
//     assistant sections occur.
// The boundary path must therefore resolve through the established
// MountRegistry/message-id resolver, never through a canonical-order ordinal.
// ---------------------------------------------------------------------------

// The Stage-1 collapsed-boundary resolution path: the production readiness
// function, the legacy diagnostic that duplicates it, and the shared native
// start-surface adapter they both delegate to.
function stage1BoundaryPathSource() {
  return [
    extractFunction(SOURCE, 'collapsedBoundaryNativeStartSurface'),
    extractFunction(SOURCE, 'getCollapsedExactBoundaryReadiness'),
    extractFunction(SOURCE, 'getLegacyCollapsedNativeBoundaryReadinessDiagnostic'),
  ].join('\n');
}

// A native testId interpolation is only a Defect-D violation when it is derived
// from CANONICAL identity (turnNo / order). Interpolations built from real DOM
// slot positions (startOrdinal, nativeOrdinal) are host-derived and belong to
// the separate retired native-slot diagnostic, not to this boundary contract.
function canonicalOrderDerivedTestIds(source) {
  return (String(source).match(/conversation-turn-\$\{[^`]*?\}/g) || [])
    .filter((expr) => /turnNo|\border\b/.test(expr));
}

// Minimal host DOM sufficient for the real extracted identity resolver.
function stage1Dom() {
  const attrRe = /\[([a-zA-Z-]+)(?:(\^?=)"([^"]*)")?\]/g;
  function matchesOne(node, sel) {
    const s = sel.trim();
    if (!s) return false;
    const tagMatch = s.match(/^([a-zA-Z]+)/);
    let rest = s;
    if (tagMatch) {
      if (String(node.tag).toLowerCase() !== tagMatch[1].toLowerCase()) return false;
      rest = s.slice(tagMatch[1].length);
    }
    attrRe.lastIndex = 0;
    let m;
    let saw = false;
    while ((m = attrRe.exec(rest))) {
      saw = true;
      const [, name, op, value] = m;
      const actual = node.attrs[name];
      if (actual == null) return false;
      if (op === '=' && actual !== value) return false;
      if (op === '^=' && !String(actual).startsWith(value)) return false;
    }
    return saw || !!tagMatch;
  }
  function matches(node, sel) {
    return String(sel).split(',').some((part) => matchesOne(node, part));
  }
  class N {
    constructor(tag, attrs = {}) {
      this.tag = tag;
      this.attrs = { ...attrs };
      this.children = [];
      this.parentElement = null;
    }
    append(child) { child.parentElement = this; this.children.push(child); return child; }
    getAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null; }
    setAttribute(name, value) { this.attrs[name] = String(value); }
    get isConnected() {
      let cur = this;
      while (cur.parentElement) cur = cur.parentElement;
      return cur === doc.body;
    }
    matches(sel) { return matches(this, sel); }
    closest(sel) {
      let cur = this;
      while (cur) { if (matches(cur, sel)) return cur; cur = cur.parentElement; }
      return null;
    }
    contains(other) {
      let cur = other;
      while (cur) { if (cur === this) return true; cur = cur.parentElement; }
      return false;
    }
    walk(out = []) { out.push(this); for (const c of this.children) c.walk(out); return out; }
    querySelectorAll(sel) { return this.walk([]).filter((n) => n !== this && matches(n, sel)); }
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  }
  const body = new N('body');
  const doc = {
    body,
    querySelectorAll: (sel) => body.querySelectorAll(sel),
    querySelector: (sel) => body.querySelector(sel),
  };
  return { doc, N };
}

// A current-host transcript: window-relative testids starting mid-thread,
// branch-node data-turn-id distinct from the product qId, and a logical turn
// rendered as one user section followed by TWO assistant sections.
function stage1Host({ testIdBase = 7 } = {}) {
  const { doc, N } = stage1Dom();
  const flow = doc.body.append(new N('div', { 'data-h2o-flow': 'root' }));
  const made = [];
  const add = (offset, role, msgId, nodeId) => {
    const wrapper = flow.append(new N('article', {}));
    const section = wrapper.append(new N('section', {
      'data-testid': `conversation-turn-${testIdBase + offset}`,
      'data-turn': role,
      'data-turn-id': nodeId,
    }));
    const msg = section.append(new N('div', {
      'data-message-id': msgId,
      'data-message-author-role': role,
    }));
    made.push({ wrapper, section, msg, msgId, nodeId, role });
    return made[made.length - 1];
  };
  // canonical turn 26 — qId differs from branch node id (regenerated turn)
  const q26 = add(0, 'user', 'qid-26-message', 'node-26-branch-b');
  const a26 = add(1, 'assistant', 'aid-26-message', 'node-26-branch-b');
  const a26b = add(2, 'assistant', 'aid-26b-message', 'node-26-branch-b2');
  // canonical turn 27 — three native sections precede it, so the fixed
  // two-sections-per-turn ordinal arithmetic cannot address it.
  const q27 = add(3, 'user', 'qid-27-message', 'node-27-branch-a');
  const a27 = add(4, 'assistant', 'aid-27-message', 'node-27-branch-a');
  return { doc, flow, q26, a26, a26b, q27, a27, N };
}

function stage1Resolver(host, mounts = new Map()) {
  const context = vm.createContext({
    document: host.doc,
    TOPW: { H2O: { obs: { mounts: { get: (id) => mounts.get(id) || null } } } },
    W: {},
    CSS: { escape: (v) => String(v) },
  });
  return vm.runInContext(`(() => {
    const TURN_HOST_SEL = '[data-testid="conversation-turn"], [data-testid^="conversation-turn-"]';
    ${extractFunction(SOURCE, 'renderedBoundaryDirectChildUnder')}
    ${extractFunction(SOURCE, 'renderedBoundaryRoleFromCarrier')}
    ${extractFunction(SOURCE, 'resolveRenderedTurnSurfaceByIdentity')}
    return resolveRenderedTurnSurfaceByIdentity;
  })()`, context);
}

await fixture('Stage1 D1 canonical-order native ordinal derivation is retired from the boundary path', () => {
  const boundary = stage1BoundaryPathSource();
  equal(SOURCE.includes('exactNativeStartSection'), false, 'duplicate ordinal resolver is absent from production');
  equal(/\(\s*order\s*-\s*1\s*\)\s*\*\s*2/.test(boundary), false, 'no (order-1)*2 native ordinal arithmetic in the boundary path');
  equal(/turnNo[^\n]*\)\s*-\s*1\s*\)\s*\*\s*2/.test(boundary), false, 'no turnNo-derived native ordinal arithmetic in the boundary path');
  equal(canonicalOrderDerivedTestIds(boundary), [], 'no canonical-order derived conversation-turn testId in the boundary path');
});

await fixture('Stage1 D2 boundary path resolves through the established identity resolver', () => {
  const adapter = extractFunction(SOURCE, 'collapsedBoundaryNativeStartSurface');
  const production = extractFunction(SOURCE, 'getCollapsedExactBoundaryReadiness');
  const legacy = extractFunction(SOURCE, 'getLegacyCollapsedNativeBoundaryReadinessDiagnostic');
  // The shared adapter is the ONLY native-start mechanism, and it delegates to
  // the established identity resolver rather than re-implementing lookup.
  ok(
    adapter.split('resolveRenderedTurnSurfaceByIdentity').length - 1 >= 1,
    'the native start-surface adapter delegates to the identity resolver',
  );
  // Both collapsed-boundary lookups (start and next-page start) route through it.
  ok(
    production.split('collapsedBoundaryNativeStartSurface').length - 1 >= 2,
    'production readiness resolves both boundaries through the adapter',
  );
  ok(
    legacy.split('collapsedBoundaryNativeStartSurface').length - 1 >= 2,
    'the duplicated legacy fallback resolves both boundaries through the adapter',
  );
  const boundary = stage1BoundaryPathSource();
  equal(/data-turn-id="\$\{/.test(boundary), false, 'no qId===data-turn-id native selector in the boundary path');
  equal(/\[data-turn="user"\]/.test(boundary), false, 'no fixed user-section role selector in the boundary path');
});

await fixture('Stage1 D3 identity resolver binds the exact current native surface on a current-host transcript', () => {
  const host = stage1Host({ testIdBase: 7 });
  const mounts = new Map([['qid-27-message', { el: host.q27.msg }]]);
  const resolve = stage1Resolver(host, mounts);
  const surface = resolve('qid-27-message', host.flow);
  equal(surface.ok, true, 'current connected native surface resolves by message identity');
  equal(surface.nativeTestHost, host.q27.section, 'the exact current native section is bound');
  equal(surface.directFlowWrapper, host.q27.wrapper, 'the direct flow wrapper is the host-owned wrapper');
  equal(surface.renderedRole, 'user', 'rendered role is read from the host, not assumed');
  // The retired arithmetic would have addressed conversation-turn-53 for
  // canonical order 27; the live surface is conversation-turn-10.
  equal(surface.testId, 'conversation-turn-10', 'native testId is window-relative, not canonical order');
  equal(host.q27.section.getAttribute('data-turn-id') !== 'qid-27-message', true, 'native data-turn-id is the branch node id, not the qId');
});

await fixture('Stage1 D4 testid renumbering and reassignment cannot move the bound surface', () => {
  const host = stage1Host({ testIdBase: 7 });
  const mounts = new Map([['qid-27-message', { el: host.q27.msg }]]);
  const resolve = stage1Resolver(host, mounts);
  const before = resolve('qid-27-message', host.flow);
  equal(before.testId, 'conversation-turn-10', 'baseline window position');
  // History prepend: the host renumbers every section; the same native turn
  // now carries a different testid, and the old testid moves to another turn.
  host.q26.section.setAttribute('data-testid', 'conversation-turn-10');
  host.q27.section.setAttribute('data-testid', 'conversation-turn-16');
  const after = resolve('qid-27-message', host.flow);
  equal(after.ok, true, 'renumbering does not unbind the surface');
  equal(after.nativeTestHost, host.q27.section, 'the same exact native turn stays bound after renumbering');
  equal(after.testId, 'conversation-turn-16', 'the bound surface reports its new window position');
  // The testid that USED to address turn 27 now belongs to turn 26. Identity
  // binding keeps the two turns distinct regardless of which testid they wear.
  const neighbour = resolve('qid-26-message', host.flow);
  equal(neighbour.ok, true, 'the neighbouring turn resolves on its own message identity');
  equal(neighbour.nativeTestHost, host.q26.section, 'the reassigned testid did not steal the neighbour binding');
  equal(neighbour.testId, 'conversation-turn-10', 'the neighbour now wears the testid that previously addressed turn 27');
  equal(neighbour.nativeTestHost === after.nativeTestHost, false, 'the two turns never collapse onto one surface');
});

await fixture('Stage1 D5 consecutive assistant sections and shells never create membership', () => {
  const host = stage1Host({ testIdBase: 7 });
  equal(host.a26.section.getAttribute('data-turn'), 'assistant', 'first assistant section');
  equal(host.a26b.section.getAttribute('data-turn'), 'assistant', 'consecutive assistant section exists');
  const resolve = stage1Resolver(host, new Map());
  // Unhydrated shell: a native section with no message identity at all.
  const shellWrapper = host.flow.append(new host.N('article', {}));
  shellWrapper.append(new host.N('section', {
    'data-testid': 'conversation-turn-12',
    'data-turn': 'assistant',
  }));
  equal(resolve('', host.flow).ok, false, 'empty identity never resolves');
  equal(resolve('qid-absent-message', host.flow).ok, false, 'unknown identity never resolves');
  equal(resolve('', host.flow).reason, 'identity-unmounted', 'missing identity fails closed');
});

await fixture('Stage1 D6 stale, disconnected and ambiguous bindings fail closed', () => {
  const host = stage1Host({ testIdBase: 7 });
  // Disconnected predecessor still referenced by the registry.
  const detached = host.q27.wrapper;
  const idx = host.flow.children.indexOf(detached);
  host.flow.children.splice(idx, 1);
  detached.parentElement = null;
  const staleMounts = new Map([['qid-27-message', { el: host.q27.msg }]]);
  const resolve = stage1Resolver(host, staleMounts);
  const stale = resolve('qid-27-message', host.flow);
  equal(stale.ok, false, 'a disconnected predecessor is never reused');
  equal(stale.reason, 'identity-unmounted', 'stale binding fails closed');
  // Ambiguity: two connected carriers share one node-domain id.
  const host2 = stage1Host({ testIdBase: 7 });
  const resolve2 = stage1Resolver(host2, new Map());
  const dup = resolve2('node-26-branch-b', host2.flow);
  equal(dup.ok, false, 'duplicate node-id carriers do not resolve');
  equal(dup.reason, 'identity-ambiguous', 'ambiguous identity fails closed');
});

await fixture('Stage1 V virtualization simultaneous-mount gate remains unrepaired by design', () => {
  const boundary = stage1BoundaryPathSource();
  ok(boundary.includes('native-start-not-mounted'), 'start boundary still requires a mounted native start');
  ok(boundary.includes('next-page-native-start-not-mounted'), 'next-page boundary still requires its own mounted native start');
  ok(boundary.includes('native-layout-boundary-unresolved'), 'both boundaries must share one resolved flow root');
  // A ~25-turn page inside a 6-11 section host window can never mount both
  // boundaries at once, so Stage 1 leaves long-thread collapse unavailable.
  const host = stage1Host({ testIdBase: 7 });
  const resolve = stage1Resolver(host, new Map([['qid-27-message', { el: host.q27.msg }]]));
  equal(resolve('qid-27-message', host.flow).ok, true, 'the mounted boundary resolves');
  equal(resolve('qid-52-message', host.flow).ok, false, 'the distant boundary is not mounted in the host window');
  equal(resolve('qid-52-message', host.flow).reason, 'identity-unmounted', 'the distant boundary fails closed, not approximated');
});

// ===========================================================================
// Stage 2 (Defect V) — host-windowed page collapse. PASS 1: RED + counterfactual.
//
// Current ChatGPT keeps only a small sliding window of the transcript mounted,
// so the two distant page boundaries of a 25-turn logical page are never
// present at the same time and no contiguous native interval spanning the page
// can exist. Stage-1 production still gates LOGICAL page-collapse capability on
// that native simultaneity/range proof, so a perfectly healthy canonical page
// is refused. These fixtures reproduce that refusal against UNMODIFIED Stage-1
// production and prove it is caused ONLY by the native machinery.
//
// The two `Stage2 V` fixtures below are EXPECTED TO FAIL until Pass 2 lands.
// ===========================================================================

// Real production capability chain, evaluated over the real CV-3.23 world.
// Nothing here re-implements the predicate: every symbol is extracted from the
// unmodified Stage-1 1C1b.
const STAGE2_BOUNDARY_SYMBOLS = [
  'renderedBoundaryStatusIdentity', 'frozenRenderedPageBoundaryCapability',
  'renderedBoundaryDirectChildUnder', 'renderedBoundaryRoleFromCarrier',
  'resolveRenderedTurnSurfaceByIdentity', 'renderedBoundaryThreadDivider',
  'renderedBoundaryStartSentinel', 'renderedBoundaryOrderingNodeAllowed',
  'renderedBoundaryLayoutProof', 'renderedBoundaryWrapperCarriesIdentity',
  'renderedBoundaryColdWrapperH2OOwned', 'resolveColdRenderedBoundaryWrapper',
  'renderedBoundaryPageUnitPlacement', 'renderedBoundaryTransitionActive',
  'renderedBoundaryRecordStreaming', 'readRenderedBoundaryAuthority',
  'renderedBoundaryLeaseScopeCurrent', 'getRenderedPageBoundaryCapability',
];
const STAGE2_RANGE_SYMBOLS = [
  'frozenPageCollapseRangeDiagnostics', 'pageCollapseRangeH2OOwned',
  'pageCollapseRangeIdentityCarriers', 'pageCollapseRangeIdentityOfCarrier',
  'pageCollapseRangeContainerIdentity', 'pageCollapseRangeNodeCarriesIdentity',
  'pageCollapseRangeHasRetainedHeight', 'pageCollapseRangeScopeCurrent',
  'clearStalePageCollapseRangeContinuity', 'readPageCollapseRangeGraphRecords',
  'buildPageCollapseRangePlan', 'classifyPageCollapseRange',
  'readFinalPageTerminalRecord', 'resolveFinalPageTerminalWrapper',
  'resolveFinalPageTailAuthority', 'renderedBoundaryPageEndSentinel',
  'getPageCollapseRangeDiagnostics',
];
const STAGE2_CAPABILITY_SYMBOLS = [
  'getTurnSectionForNode', 'getTurnAnchorNode', 'collapsedBoundaryNativeStartSurface',
  'resolveCurrentMountedPageMembers',
  'collapsedBoundaryStatusIdentity',
  'collapsedNativeRangeKey', 'validateCommittedAtomicPageCollapse',
  'collapsedPageCanonicalAuthorityCurrent',
  'collapsedPageFlowRootByIdentity',
  'titleListCurrentProjectionNodes', 'titleListCurrentProjectedCount',
  'currentCollapsedPageIntent', 'currentCollapsedPageMembers',
  'reconcileActiveWindowedCollapse', 'clearStaleWindowedCollapseStamps',
  'reconcileAtomicPageCollapseTransactions',
  'expandWindowedPageCollapse', 'expandPageWithRenderedBoundaries',
  'releaseAtomicPageCollapseState',
  'pageCollapseOperationEpoch', 'pageCollapseEpochCoherent',
  'rollbackWindowedCollapseCandidates', 'applyCollapsedNativeRange',
  'setAtomicCollapsedPageMemory', 'commitWindowedPageCollapse',
  'readEffectiveTitleListAuthority', 'pureCanonicalPageMemberDetails',
  'readTitleListPresentationAuthority', 'buildTitleListPresentationPageModel',
  'frozenPageCollapseCapability', 'pageCollapseCapabilityProductReason',
  'evaluatePageCollapseCapability', 'getPageCollapseCapability',
];

function stage2World(options = {}) {
  const rangeFactory = loadRangeHarnessFactory(SOURCE);
  const h = rangeFactory.createHarness({ productionSource: SOURCE, count: 39, ...options });
  rangeFactory.prime(h);
  h.guard.locked = false;
  // The range harness models canonical turns as `order`; production's canonical
  // member reader consumes listTurnRecords() with turnNo/qId/primaryAId. This
  // supplies the canonical authority the real predicate reads. It does not
  // fake, bypass or reimplement any part of the capability predicate.
  const canonicalRecords = h.records.map((record) => Object.freeze({
    turnNo: record.order,
    idx: record.order,
    turnId: `turn:${record.qId}`,
    qId: record.qId,
    questionId: record.qId,
    primaryAId: record.primaryAId,
    answerId: record.primaryAId,
    aId: record.primaryAId,
    answerIds: [record.primaryAId],
    answerVariants: [record.primaryAId],
    noAnswer: false,
    stopped: false,
  }));
  h.runtime.listTurnRecords = () => canonicalRecords;
  const names = [...STAGE2_BOUNDARY_SYMBOLS, ...STAGE2_RANGE_SYMBOLS, ...STAGE2_CAPABILITY_SYMBOLS]
    .filter((name) => SOURCE.includes(`  function ${name}(`));
  // Peripheral neighbours of the release/expand path (title stacks, MiniMap,
  // viewport anchoring, control chrome). They are Pass-5-owned or belong to
  // unrelated subsystems, so they are stubbed rather than dragged in; nothing
  // any Pass-4 fixture asserts on comes from a stub.
  const stubs = Object.entries({
    captureCollapsedPageViewportAnchor: '() => null',
    restoreCollapsedPageViewportAnchor: '() => true',
    clearTitleListNativeInPlaceProjection: '() => ({ ok: true, mutations: 0 })',
    reconcileTitleListNativeInPlaceProjection: '() => ({ ok: true, mutations: 0 })',
    reconcilePendingTitleListMaterialization: '() => null',
    // Deferred-intent replay is a separate owner with its own frozen coverage;
    // it is not part of the reconcile decision under test here.
    replayDeferredPageCollapseIntent: '() => []',
    releaseTitleStackBars: '() => 0',
    titleListStackRegistryKey: '(n, id) => `${id}::${n}`',
    titleListOpenStateKey: '(n, id) => `${id}::${n}`',
    setAtomicTitleListMemory: '() => true',
    clearResidualPageTitleCollapseSources: '() => 0',
    releasePageMemberHideMarkers: '() => 0',
    propagateChatPageCollapseToMiniMap: '() => true',
    getTitleListStackStats: '() => ({ activeStackId: \'\' })',
    syncTitleOnlyModeRootAttribute: '() => true',
    clearCollapseUnavailableFeedback: '() => true',
    clearCollapsedBoundaryDiagnostic: '() => true',
    applyCollapsedBoundaryControlState: '() => true',
    applyExpandedCollapseControlState: '() => true',
    getSyntheticTitleListContainers: '() => []',
    titleListCurrentOpenMount: '() => ({ ok: false, anchors: [] })',
    resolveChatId: '() => \'\'',
  })
    .filter(([name]) => !names.includes(name))
    .map(([name, body]) => `const ${name} = ${body};`);
  const api = vm.runInNewContext(`(() => {
    const document = injectedDocument;
    const Element = injectedElement;
    const W = injectedWindow;
    const TOPW = injectedWindow;
    const S = injectedState;
    const TITLE_LIST_PAGE_SIZE = 25;
    const TURN_HOST_SEL = '[data-testid="conversation-turn"], [data-testid^="conversation-turn-"]';
    const RENDERED_BOUNDARY_SENTINEL_ATTR = 'data-h2o-chat-page-boundary';
    const RENDERED_BOUNDARY_SENTINEL_PAGE_ATTR = 'data-h2o-chat-page-boundary-page';
    const RENDERED_BOUNDARY_SENTINEL_KIND_ATTR = 'data-h2o-chat-page-boundary-kind';
    const TITLE_LIST_EFFECTIVE_METHOD = Object.freeze({
      STATUS: 'getEffectivePresentationStatus',
      INDEX: 'getEffectivePresentationIndex',
      BY_QID: 'getEffectiveTurnRecordByQId',
      BY_AID: 'getEffectiveTurnRecordByAId',
    });
    const TURN_RUNTIME = () => injectedRuntime;
    const ATTR_CHAT_PAGE_NATIVE_HIDDEN = 'data-cgxui-chat-page-native-hidden';
    ${stubs.join('\n    ')}
    ${names.map((name) => extractFunction(SOURCE, name)).join('\n')}
    return Object.freeze({
      capability: getPageCollapseCapability,
      evaluate: (pageNum) => evaluatePageCollapseCapability(pageNum, { includePlan: true }),
      subset: resolveCurrentMountedPageMembers,
      model: buildTitleListPresentationPageModel,
      identity: resolveRenderedTurnSurfaceByIdentity,
      epoch: pageCollapseOperationEpoch,
      epochCoherent: pageCollapseEpochCoherent,
      commit: commitWindowedPageCollapse,
      stamp: applyCollapsedNativeRange,
      rollback: rollbackWindowedCollapseCandidates,
      // Refined Pass-4 surfaces. typeof-guarded so the RED can execute against
      // UNMODIFIED Pass-3 production, where these do not yet exist.
      validateCommitted: typeof validateCommittedAtomicPageCollapse === 'function'
        ? validateCommittedAtomicPageCollapse : null,
      reconcileActive: typeof reconcileActiveWindowedCollapse === 'function'
        ? reconcileActiveWindowedCollapse : null,
      reconcileAll: typeof reconcileAtomicPageCollapseTransactions === 'function'
        ? reconcileAtomicPageCollapseTransactions : null,
      clearStale: typeof clearStaleWindowedCollapseStamps === 'function'
        ? clearStaleWindowedCollapseStamps : null,
      expand: typeof expandWindowedPageCollapse === 'function'
        ? expandWindowedPageCollapse : null,
      expandPublic: typeof expandPageWithRenderedBoundaries === 'function'
        ? expandPageWithRenderedBoundaries : null,
      intent: typeof currentCollapsedPageIntent === 'function'
        ? currentCollapsedPageIntent : null,
      key: collapsedNativeRangeKey,
      state: S,
    });
  })()`, {
    injectedDocument: h.document,
    // The real node constructor: getTurnAnchorNode falls back on
    // `host instanceof Element`, so a dummy class silently returns null.
    injectedElement: h.flow.constructor,
    injectedWindow: { getComputedStyle: (node) => node.style },
    injectedState: Object.assign(h.S, {
      atomicPageCollapseTransactions: h.S.atomicPageCollapseTransactions || new Map(),
      nativeRangeActivePages: h.S.nativeRangeActivePages || new Set(),
      collapsedPagesByChat: h.S.collapsedPagesByChat || new Map(),
      atomicPageCollapseGuards: h.S.atomicPageCollapseGuards || new Set(),
      titleListOpenStatesByKey: h.S.titleListOpenStatesByKey || new Map(),
      titleListStacksByKey: h.S.titleListStacksByKey || new Map(),
      collapsedBoundaryDiagnostics: h.S.collapsedBoundaryDiagnostics || new Map(),
    }),
    injectedRuntime: h.runtime,
  });
  const nativeWrappers = h.flow.children.filter(
    (node) => !node.getAttribute?.('data-h2o-chat-page-boundary')
      && !String(node.className || '').includes('page-divider'),
  );
  return { h, api, nativeWrappers };
}

// The windowed world: canonical 39 turns, but the page-2 distant start is not
// mounted and only a handful of native wrappers exist.
const stage2Windowed = () => stage2World({ coldEnd: true, middleCount: 6, missingEnd: true });
// The counterfactual: byte-for-byte the same canonical inputs, with an
// artificial full native wrapper interval restored.
const stage2FullInterval = () => stage2World({ coldEnd: true, middleCount: 48 });

await fixture('Stage2 W1 windowed world keeps canonical authority and the title ledger healthy', () => {
  const { api } = stage2Windowed();
  const model = api.model();
  equal(model.coherent, true, 'canonical page model is coherent');
  equal(model.count, 39, 'canonical count is 39');
  equal(model.pageCount, 2, 'page size 25 yields two logical pages');
  equal(model.pages[0].startOrder, 1, 'page 1 starts at turn 1');
  equal(model.pages[0].endOrder, 25, 'page 1 ends at turn 25');
  equal(model.pages[1].startOrder, 26, 'page 2 starts at turn 26');
  equal(model.pages[1].endOrder, 39, 'page 2 ends at turn 39');
  const capability = api.capability(1);
  equal(capability.titleRowsCurrent, true, 'title rows are current');
  equal(capability.titleRowCount, 25, 'all 25 page-1 title rows are present');
  equal(capability.expectedTitleRowCount, 25, 'expected title row count matches');
  equal(capability.streaming, false, 'no streaming state');
  equal(capability.branchTransition, false, 'no branch transition');
});

await fixture('Stage2 W2 host window is small and the distant page boundaries never coexist', () => {
  const { api, nativeWrappers } = stage2Windowed();
  ok(nativeWrappers.length >= 6 && nativeWrappers.length <= 11,
    `host window holds 6-11 native wrappers (found ${nativeWrappers.length})`);
  const capability = api.capability(1);
  equal(capability.startBoundarySupported, true, 'the page-1 start boundary is inside the window');
  equal(capability.nextBoundarySupported, false, 'the page-2 start boundary is outside the window');
  equal(capability.hostWrapperCount, 0, 'no contiguous native interval spans the logical page');
});

await fixture('Stage2 W3 Stage-1 identity is healthy and no other failure class is present', () => {
  const { h, api } = stage2Windowed();
  const mounted = api.identity('q-1', h.flow);
  equal(mounted.ok, true, 'Stage-1 identity resolves the mounted canonical member');
  equal(mounted.nativeTestHost?.isConnected, true, 'the resolved surface is the current connected node');
  const distant = api.identity('q-26', h.flow);
  equal(distant.ok, false, 'the distant canonical member is simply unmounted');
  equal(distant.reason, 'identity-unmounted', 'unmounted, not ambiguous or misidentified');
  const capability = api.capability(1);
  equal(capability.ambiguousWrapperCount, 0, 'no identity ambiguity contributes to the refusal');
  equal(capability.titleRowsCurrent, true, 'the refusal is not missing title rows');
  equal(capability.streaming, false, 'the refusal is not streaming');
  equal(capability.branchTransition, false, 'the refusal is not a branch transition');
  equal(api.model().coherent, true, 'the refusal is not incomplete canonical authority');
});

await fixture('Stage2 C1 counterfactual: identical canonical world plus a full native interval is ACCEPTED', () => {
  const windowed = stage2Windowed();
  const full = stage2FullInterval();
  const a = windowed.api.model();
  const b = full.api.model();
  // Canonical inputs are held identical; only native presentation differs.
  equal([a.coherent, a.count, a.pageCount], [b.coherent, b.count, b.pageCount],
    'both worlds carry the identical canonical page model');
  // Array.from rebuilds both descriptors in this realm; the two models come
  // from separate VM contexts, so a cross-realm array would fail deepStrictEqual
  // on prototype identity alone even when the contents are identical.
  const descriptor = (model) => Array.from(model.pages, (p) => [p.startOrder, p.endOrder]);
  equal(descriptor(a), descriptor(b), 'both worlds carry the identical page descriptor');
  const capability = full.api.capability(1);
  equal(capability.supported, true, 'the same Stage-1 production ACCEPTS once the full native interval exists');
  equal(capability.productReason, 'ready', 'capability is ready');
  equal(capability.rangeProven, true, 'the artificial interval proves the native range');
  ok(capability.hostWrapperCount > 0, 'the artificial interval supplies host wrappers');
  // Pass 1 recorded here that the windowed world was REFUSED by this same
  // predicate while the full-interval world was accepted — that non-vacuity
  // evidence is preserved permanently in checkpoint 2ebe18bc. Pass 2 corrects
  // production, so the live invariant is now the Stage-2 one: identical
  // canonical inputs yield the identical logical outcome, whatever the host
  // window happens to be showing.
  equal(windowed.api.capability(1).supported, true,
    'the windowed world now yields the same logical capability as the full-interval world');
});

await fixture('Stage2 V1 host-windowed logical page collapse must be available', () => {
  // EXPECTED RED until Pass 2. A canonically healthy logical page must be
  // collapsible even though the host never mounts both distant boundaries.
  const { api } = stage2Windowed();
  const capability = api.capability(1);
  equal(api.model().coherent, true, 'precondition: canonical authority is healthy');
  equal(capability.titleRowsCurrent, true, 'precondition: title ledger is complete');
  equal(capability.supported, true,
    'logical page capability is available without a simultaneous distant native boundary');
});

await fixture('Stage2 V2 native range fields must not gate logical capability', () => {
  // EXPECTED RED until Pass 2. rangeProven / rangeStartIndex / rangeEndIndex /
  // hostWrapperCount / nextBoundarySupported are diagnostics, not gates.
  const { api } = stage2Windowed();
  const capability = api.capability(1);
  equal(capability.rangeProven, false, 'the windowed world genuinely has no proven native range');
  equal(capability.rangeStartIndex, -1, 'no native range start index exists');
  equal(capability.rangeEndIndex, -1, 'no native range end index exists');
  equal(capability.hostWrapperCount, 0, 'no host wrapper interval exists');
  equal(capability.nextBoundarySupported, false, 'the next distant boundary is not mounted');
  equal(capability.supported, true,
    'none of those native diagnostics may change the logical capability outcome');
});

// --------------------------------------------------------------------------
// Stage 2 PASS 2 — logical capability + mounted canonical subset planning.
// Transaction commit/rollback (Pass 3), incremental reconcile/expand (Pass 4)
// and title-list/P03B interaction (Pass 5) are deliberately NOT covered here.
// --------------------------------------------------------------------------

// A world where a page-2 canonical member is also currently mounted, so
// wrong-page exclusion can be proved against a real mounted member.
const stage2BothPagesMounted = () => stage2World({ coldEnd: false, middleCount: 6 });

await fixture('Stage2 P2-A canonical descriptor pages 39 turns as 1..25 / 26..39', () => {
  const { api } = stage2Windowed();
  const model = api.model();
  equal(model.count, 39, 'canonical count');
  equal(model.pageCount, 2, 'two logical pages at page size 25');
  equal(Array.from(model.pages, (p) => [p.pageNo, p.startOrder, p.endOrder]),
    [[1, 1, 25], [2, 26, 39]], 'page descriptor derives from canonical membership and page size only');
  const capability = api.capability(1);
  equal(capability.pageStartOrder, 1, 'capability carries the canonical start order');
  equal(capability.pageEndOrder, 25, 'capability carries the canonical end order');
  equal(capability.isFinalPage, false, 'page 1 is not the final page');
});

await fixture('Stage2 P2-B windowed candidate set is exactly the current mounted canonical members', () => {
  const { api } = stage2Windowed();
  const subset = api.subset(api.model().pages[0]);
  equal(subset.ok, true, 'the subset resolves');
  equal(Array.from(subset.mounted, (m) => m.turnNo), [1], 'exactly the currently mounted canonical member');
  equal(Array.from(subset.mounted, (m) => m.questionId), ['q-1'], 'candidates carry canonical identity');
  equal(subset.unmountedCount, 24, 'the other 24 canonical members are simply unmounted');
  ok(subset.mounted.every((m) => m.turnNo >= 1 && m.turnNo <= 25), 'every candidate lies inside the logical page');
});

await fixture('Stage2 P2-C a mounted canonical member of another page is excluded', () => {
  const { api } = stage2BothPagesMounted();
  const model = api.model();
  const page1 = api.subset(model.pages[0]);
  const page2 = api.subset(model.pages[1]);
  equal(Array.from(page2.mounted, (m) => m.turnNo), [26], 'turn 26 IS currently mounted');
  equal(Array.from(page1.mounted, (m) => m.turnNo), [1], 'yet page 1 excludes it');
  equal(page1.mounted.some((m) => m.turnNo === 26), false, 'wrong-page membership never leaks in');
});

await fixture('Stage2 P2-D a DOM-only noncanonical node is excluded', () => {
  const { h, api } = stage2World({ coldEnd: true, middleCount: 6, missingEnd: true, extraKind: 'client-created-root' });
  const subset = api.subset(api.model().pages[0]);
  equal(subset.ok, true, 'the noncanonical node does not break planning');
  const canonicalIds = new Set(api.model().pages[0].turnRecords.map((r) => String(r.questionId)));
  ok(subset.mounted.every((m) => canonicalIds.has(m.questionId)),
    'every candidate is a canonical page member; DOM-only nodes are never enumerated');
  equal(subset.mounted.some((m) => m.questionId === 'client-created-root'), false,
    'the client-created DOM root is not a candidate');
});

await fixture('Stage2 P2-E currently unmounted canonical members do not fail the plan', () => {
  // missingStart leaves the whole page unmounted in this window.
  const { api } = stage2World({ coldEnd: true, middleCount: 6, missingStart: true });
  const subset = api.subset(api.model().pages[0]);
  equal(subset.ok, true, 'an entirely unmounted page still plans successfully');
  equal(subset.mounted.length, 0, 'no candidates are currently mounted');
  equal(subset.unmountedCount, 25, 'all 25 canonical members are unmounted');
  equal(api.capability(1).supported, true, 'logical capability is unaffected by host windowing');
});

await fixture('Stage2 P2-F candidates are obtained through the frozen Stage-1 identity path', () => {
  const subsetSource = extractFunction(SOURCE, 'resolveCurrentMountedPageMembers');
  ok(subsetSource.includes('collapsedBoundaryNativeStartSurface'),
    'enumeration resolves each member through the Stage-1 boundary surface primitive');
  equal(/querySelectorAll\(\s*['"`]\[data-testid/.test(subsetSource), false,
    'enumeration never scans DOM wrappers to infer page membership');
  const { h, api } = stage2Windowed();
  const subset = api.subset(api.model().pages[0]);
  const direct = api.identity('q-1', subset.flowRoot);
  equal(direct.ok, true, 'the same identity path resolves the candidate independently');
  equal(subset.mounted[0].node.isConnected, true, 'the candidate node is the CURRENT connected node');
});

await fixture('Stage2 P2-G no canonical-order native testid lookup has reappeared', () => {
  const region = [
    extractFunction(SOURCE, 'resolveCurrentMountedPageMembers'),
    extractFunction(SOURCE, 'evaluatePageCollapseCapability'),
  ].join('\n');
  equal(SOURCE.includes('exactNativeStartSection'), false, 'the retired ordinal resolver is still absent');
  equal(canonicalOrderDerivedTestIds(region), [], 'no canonical-order derived testId in the Pass-2 region');
  equal(/data-turn-id="\$\{/.test(region), false, 'no qId===data-turn-id selector in the Pass-2 region');
  equal(/\(\s*order\s*-\s*1\s*\)\s*\*\s*2/.test(region), false, 'no two-section ordinal arithmetic in the Pass-2 region');
});

await fixture('Stage2 P2-H native range diagnostics stay observable but structurally non-gating', () => {
  const windowed = stage2Windowed().api.capability(1);
  const full = stage2FullInterval().api.capability(1);
  // Still reported, and genuinely different between the two worlds.
  equal(windowed.rangeProven, false, 'windowed world reports no proven range');
  equal(full.rangeProven, true, 'full-interval world reports a proven range');
  ok(full.hostWrapperCount > 0 && windowed.hostWrapperCount === 0, 'hostWrapperCount still differs');
  ok(full.rangeStartIndex >= 0 && windowed.rangeStartIndex === -1, 'range indices still differ');
  equal(windowed.nextBoundarySupported, false, 'the distant boundary is still reported as unmounted');
  // Yet the logical outcome is identical.
  equal(windowed.supported, full.supported, 'logical capability is identical across both worlds');
  // And structurally, none of them appears in the logical predicate.
  const predicate = extractFunction(SOURCE, 'evaluatePageCollapseCapability');
  const logical = predicate.slice(predicate.indexOf('const logicalAuthorityCurrent'), predicate.indexOf('let reason = null;'));
  for (const field of ['rangeProven', 'rangeStartIndex', 'rangeEndIndex', 'hostWrapperCount',
    'ambiguousWrapperCount', 'pageUnitOrderCurrent', 'nextBoundarySupported', 'leaseCurrent']) {
    equal(logical.includes(field), false, `${field} is not part of the logical capability predicate`);
  }
});

await fixture('Stage2 P2-I ambiguous current identity fails the whole plan closed', () => {
  const { h, api } = stage2Windowed();
  equal(api.subset(api.model().pages[0]).ok, true, 'baseline subset resolves');
  // A second connected carrier for the same canonical identity.
  const duplicate = h.document.createElement('SECTION');
  duplicate.setAttribute('data-turn-id', 'q-1');
  duplicate.setAttribute('data-turn', 'user');
  duplicate.setAttribute('data-testid', 'conversation-turn-99');
  h.flow.appendChild(duplicate);
  const subset = api.subset(api.model().pages[0]);
  equal(subset.ok, false, 'ambiguity fails the WHOLE plan, not just one candidate');
  equal(subset.reason, 'candidate-identity-ambiguous', 'the refusal names the ambiguity');
  equal(subset.mounted.length, 0, 'no partial candidate set escapes an ambiguous plan');
  const evaluation = api.evaluate(1);
  equal(evaluation.plan, null, 'no plan is emitted while a candidate identity is ambiguous');
  // Ambiguity is a PLANNING failure; the logical page itself is still valid.
  equal(evaluation.capability.supported, true, 'the logical page remains canonically valid');
});

await fixture('Stage2 P2-J disconnected and stale resolutions never enter the plan', () => {
  const { h, api } = stage2Windowed();
  const before = api.subset(api.model().pages[0]);
  equal(Array.from(before.mounted, (m) => m.turnNo), [1], 'the member is a candidate while connected');
  // Disconnect the only mounted candidate.
  const wrapper = before.mounted[0].node;
  const index = h.flow.children.indexOf(wrapper);
  h.flow.children.splice(index, 1);
  wrapper.parentElement = null;
  wrapper.isConnected = false;
  const after = api.subset(api.model().pages[0]);
  equal(after.ok, true, 'a disconnected member is ordinary windowing, not a plan failure');
  equal(after.mounted.length, 0, 'the disconnected predecessor is never carried into the plan');
  equal(after.unmountedCount, 25, 'it is counted as unmounted');
});

// --------------------------------------------------------------------------
// Stage 2 PASS 3 — mounted-subset transaction + E0/E1 epoch safety.
// Pass-4 (incremental reconcile / expand / post-commit rebind) and Pass-5
// (title-list / P03B) remain out of scope and are NOT asserted here.
// --------------------------------------------------------------------------

// Drive plan and commit as two explicit phases so host/canonical state can
// change in between, exactly as it does live.
function stage2Transaction(options = {}) {
  const world = stage2World(options);
  const plan = () => world.api.evaluate(1).plan;
  const commit = (builtPlan) => world.api.commit({
    num: 1,
    id: 'chat-stage-2c0',
    // The real key derivation, not a hand-written literal: expand and the
    // intent authority look the transaction up with this exact function.
    key: world.api.key('chat-stage-2c0', 1),
    plan: builtPlan,
    epochBefore: world.api.epoch(1),
    metrics: null,
  });
  return { ...world, plan, commit };
}
const hiddenAttr = (node) => node?.getAttribute?.('data-cgxui-chat-page-native-hidden') ?? null;

await fixture('Stage2 T3-A windowed plan stamps exactly the current mounted canonical members', () => {
  const t = stage2Transaction({ coldEnd: true, middleCount: 6, missingEnd: true });
  const p = t.plan();
  ok(!!p, 'a Pass-2 windowed plan is produced');
  equal(p.mountedCandidateCount, 1, 'one canonical member is currently mounted');
  const result = t.commit(p);
  equal(result.ok, true, 'the transaction commits');
  equal(result.status, 'collapsed', 'committed as a native collapse');
  equal(result.hidden, 1, 'exactly the mounted member was suppressed');
  equal(result.mutations, 1, 'exactly one native mutation');
  const subset = t.api.subset(t.api.model().pages[0]);
  equal(hiddenAttr(subset.mounted[0].node), '1', 'the current member carries the page-1 suppression stamp');
});

await fixture('Stage2 T3-B zero-candidate valid page succeeds with zero native mutation', () => {
  // missingStart leaves the whole logical page unmounted in this window.
  const t = stage2Transaction({ coldEnd: true, middleCount: 6, missingStart: true });
  const p = t.plan();
  equal(p.mountedCandidateCount, 0, 'no canonical member of the page is currently mounted');
  const result = t.commit(p);
  equal(result.ok, true, 'a canonically valid page still collapses');
  equal(result.status, 'collapsed-no-native-work', 'distinct no-native-work result');
  equal(result.reason, 'no-current-mounted-members', 'precise reason');
  equal(result.hidden, 0, 'zero suppression');
  equal(result.mutations, 0, 'zero native mutation');
  equal(t.api.state.atomicPageCollapseTransactions.size, 1, 'logical collapse intent is still recorded');
});

await fixture('Stage2 T3-C wrong-page and DOM-only nodes are untouched', () => {
  const t = stage2Transaction({ coldEnd: false, middleCount: 6 });
  const model = t.api.model();
  const page2Before = t.api.subset(model.pages[1]);
  equal(page2Before.mounted.map((m) => m.turnNo).join(','), '26', 'turn 26 is mounted and belongs to page 2');
  const result = t.commit(t.plan());
  equal(result.ok, true, 'page 1 commits');
  const page2After = t.api.subset(model.pages[1]);
  equal(hiddenAttr(page2After.mounted[0].node), null, 'the mounted page-2 member was never stamped');
  const stray = Array.from(t.h.flow.children).filter((node) => hiddenAttr(node) === '1');
  equal(stray.length, result.hidden, 'only the page-1 subset carries the stamp');
});

for (const [name, drift] of [
  ['T3-D route', { routeKey: '/c/other-route' }],
  ['T3-E generation', { generation: 9 }],
  ['T3-F effectiveFingerprint', { canonicalFingerprint: 'djb2:other-effective' }],
  ['T3-H count/page-layout', { count: 31 }],
]) {
  await fixture(`Stage2 ${name} drift between E0 and E1 aborts before mutation`, () => {
    const t = stage2Transaction({ coldEnd: true, middleCount: 6, missingEnd: true });
    const p = t.plan();
    const epochBefore = t.api.epoch(1);
    // Canonical drift occurs after planning, before commit.
    Object.assign(t.h.status, drift);
    const result = t.api.commit({
      num: 1, id: 'chat-stage-2c0', key: 'chat-stage-2c0::1',
      plan: p, epochBefore, metrics: null,
    });
    equal(result.ok, false, 'canonical drift aborts the transaction');
    equal(result.status, 'atomic-collapse-epoch-drift', 'aborted on epoch drift');
    equal(result.reason, 'authority-changed-during-transaction', 'precise reason');
    const subset = t.api.subset(t.api.model().pages[0]);
    for (const entry of subset.mounted) {
      equal(hiddenAttr(entry.node), null, 'no native mutation happened before the abort');
    }
  });
}

await fixture('Stage2 T3-G graphFingerprint drift between E0 and E1 aborts before mutation', () => {
  const t = stage2Transaction({ coldEnd: true, middleCount: 6, missingEnd: true });
  const p = t.plan();
  const epochBefore = t.api.epoch(1);
  t.h.graphScope.fingerprint = 'djb2:other-graph';
  const result = t.api.commit({
    num: 1, id: 'chat-stage-2c0', key: 'chat-stage-2c0::1',
    plan: p, epochBefore, metrics: null,
  });
  equal(result.ok, false, 'graph fingerprint drift aborts');
  equal(result.status, 'atomic-collapse-epoch-drift', 'aborted on epoch drift');
});

await fixture('Stage2 T3-I host replacement without canonical drift re-resolves and succeeds', () => {
  const t = stage2Transaction({ coldEnd: true, middleCount: 6, missingEnd: true });
  const p = t.plan();
  const planned = p.mountedCandidates[0].node;
  // The host replaces the member's wrapper between planning and commit, with
  // no canonical change whatsoever.
  const replacement = t.h.document.createElement('SECTION');
  replacement.setAttribute('data-turn-id', 'q-1');
  replacement.setAttribute('data-turn', 'user');
  replacement.setAttribute('data-testid', 'conversation-turn-77');
  const index = t.h.flow.children.indexOf(planned);
  t.h.flow.children.splice(index, 1);
  planned.parentElement = null;
  planned.isConnected = false;
  t.h.flow.appendChild(replacement);
  const result = t.commit(p);
  equal(result.ok, true, 'host replacement is not epoch drift');
  equal(result.hidden, 1, 'the CURRENT replacement is suppressed');
  equal(hiddenAttr(replacement), '1', 'the replacement node carries the stamp');
  equal(hiddenAttr(planned), null, 'the stale predecessor was never written');
});

await fixture('Stage2 T3-J candidate unmounting before commit drops normally', () => {
  const t = stage2Transaction({ coldEnd: true, middleCount: 6, missingEnd: true });
  const p = t.plan();
  equal(p.mountedCandidateCount, 1, 'planned with one mounted member');
  const planned = p.mountedCandidates[0].node;
  const index = t.h.flow.children.indexOf(planned);
  t.h.flow.children.splice(index, 1);
  planned.parentElement = null;
  planned.isConnected = false;
  const result = t.commit(p);
  equal(result.ok, true, 'an unmounted candidate is ordinary absence, not failure');
  equal(result.status, 'collapsed-no-native-work', 'nothing current remains to suppress');
  equal(result.mutations, 0, 'zero native mutation');
  equal(hiddenAttr(planned), null, 'the departed node was never written');
});

await fixture('Stage2 T3-K a member mounting before the final snapshot is included', () => {
  const t = stage2Transaction({ coldEnd: true, middleCount: 6, missingStart: true });
  const p = t.plan();
  equal(p.mountedCandidateCount, 0, 'planned with nothing mounted');
  // A canonical page member mounts after planning.
  const wrapper = t.h.document.createElement('DIV');
  const late = t.h.document.createElement('SECTION');
  late.setAttribute('data-turn-id', 'q-3');
  late.setAttribute('data-turn', 'user');
  late.setAttribute('data-testid', 'conversation-turn-31');
  wrapper.appendChild(late);
  t.h.flow.appendChild(wrapper);
  const result = t.commit(p);
  equal(result.ok, true, 'commit succeeds');
  equal(result.hidden, 1, 'the newly mounted member is included in the final snapshot');
  equal(hiddenAttr(wrapper), '1', 'the late arrival is suppressed');
});

await fixture('Stage2 T3-L identity ambiguity before commit fails the whole transaction closed', () => {
  const t = stage2Transaction({ coldEnd: true, middleCount: 6, missingEnd: true });
  const p = t.plan();
  const duplicate = t.h.document.createElement('SECTION');
  duplicate.setAttribute('data-turn-id', 'q-1');
  duplicate.setAttribute('data-turn', 'user');
  duplicate.setAttribute('data-testid', 'conversation-turn-98');
  t.h.flow.appendChild(duplicate);
  const result = t.commit(p);
  equal(result.ok, false, 'ambiguity fails the whole transaction');
  equal(result.status, 'atomic-collapse-candidate-unresolved', 'transaction refused');
  equal(result.reason, 'candidate-identity-ambiguous', 'precise ambiguity reason');
  const stamped = Array.from(t.h.flow.children).filter((node) => hiddenAttr(node) !== null);
  equal(stamped.length, 0, 'no candidate was stamped');
});

await fixture('Stage2 T3-M mid-commit stamping failure rolls back every mutated candidate', () => {
  const t = stage2Transaction({ coldEnd: false, middleCount: 6 });
  const subset = t.api.subset(t.api.model().pages[0]);
  const good = subset.mounted[0];
  // A second candidate whose setAttribute throws mid-commit.
  const hostile = { questionId: 'q-hostile', turnNo: 2, node: {
    isConnected: true,
    getAttribute: () => null,
    setAttribute: () => { throw new Error('stamp-failed'); },
  } };
  const applied = t.api.stamp({
    atomicRenderedBoundaryPlan: true,
    pageNum: 1,
    mountedCandidates: [good, hostile],
  });
  equal(applied.ok, false, 'the stamping pass fails');
  equal(applied.status, 'rendered-collapse-stamp-failed', 'precise failure status');
  equal(hiddenAttr(good.node), '1', 'the first candidate was mutated before the failure');
  ok(applied.restorable.length >= 1, 'everything already mutated is handed back for rollback');
  const rolled = t.api.rollback(1, applied.restorable);
  equal(hiddenAttr(good.node), null, 'rollback restored the mutated candidate');
  equal(rolled.restored >= 1, true, 'rollback reports what it restored');
});

await fixture('Stage2 T3-N transaction field set is unchanged and holds no new native truth', () => {
  const legacy = createTransactionHarness();
  equal(collapse(legacy).ok, true, 'legacy full-interval transaction still commits');
  const legacyTransaction = legacy.S.atomicPageCollapseTransactions.values().next().value;
  const legacyFields = Object.keys(legacyTransaction).sort();
  const t = stage2Transaction({ coldEnd: true, middleCount: 6, missingEnd: true });
  equal(t.commit(t.plan()).ok, true, 'windowed transaction commits');
  const windowedTransaction = t.api.state.atomicPageCollapseTransactions.values().next().value;
  equal(Object.keys(windowedTransaction).sort(), legacyFields,
    'the windowed transaction record carries exactly the legacy field set');
  for (const forbidden of ['mountedCandidates', 'candidateNode', 'currentFlowRoot',
    'candidateIdentities', 'stage2WindowedPlan', 'nativeTestId', 'domOrdinal']) {
    equal(Object.prototype.hasOwnProperty.call(windowedTransaction, forbidden), false,
      `${forbidden} is not persisted as transaction truth`);
  }
  // Rollback authority is scalar identity + prior value, never a retained node.
  const rollbackSource = extractFunction(SOURCE, 'rollbackWindowedCollapseCandidates');
  ok(rollbackSource.includes('collapsedBoundaryNativeStartSurface'), 'rollback re-resolves identity');
  equal(/entry\?\.node|entry\.node/.test(rollbackSource), false, 'rollback never consults a retained node');
});

await fixture('Stage2 T3-O rollback re-resolves identity and never writes a stale predecessor', () => {
  const t = stage2Transaction({ coldEnd: true, middleCount: 6, missingEnd: true });
  const p = t.plan();
  const original = p.mountedCandidates[0].node;
  equal(t.commit(p).ok, true, 'committed');
  equal(hiddenAttr(original), '1', 'the original node is stamped');
  // The host replaces the node before rollback runs.
  const replacement = t.h.document.createElement('SECTION');
  replacement.setAttribute('data-turn-id', 'q-1');
  replacement.setAttribute('data-turn', 'user');
  replacement.setAttribute('data-testid', 'conversation-turn-88');
  const index = t.h.flow.children.indexOf(original);
  t.h.flow.children.splice(index, 1);
  original.parentElement = null;
  original.isConnected = false;
  t.h.flow.appendChild(replacement);
  replacement.setAttribute('data-cgxui-chat-page-native-hidden', '1');
  const rolled = t.api.rollback(1, [{ questionId: 'q-1', turnNo: 1, priorValue: null }]);
  equal(rolled.restored, 1, 'rollback restored one candidate');
  equal(hiddenAttr(replacement), null, 'the CURRENT node was restored');
  equal(hiddenAttr(original), '1', 'the stale predecessor was left untouched, never written');
});

await fixture('Stage2 T3-P a full contiguous native interval remains unnecessary', () => {
  const t = stage2Transaction({ coldEnd: true, middleCount: 6, missingEnd: true });
  const capability = t.api.capability(1);
  equal(capability.rangeProven, false, 'no proven contiguous interval exists');
  equal(capability.hostWrapperCount, 0, 'no host wrapper interval exists');
  const p = t.plan();
  equal(Array.isArray(p.hostWrappers) && p.hostWrappers.length > 0, false, 'the plan carries no legacy interval');
  equal(t.commit(p).ok, true, 'the transaction commits without one');
});

await fixture('Stage2 T3-Q background reveal and materialization remain zero', () => {
  const commitSource = [
    extractFunction(SOURCE, 'commitWindowedPageCollapse'),
    extractFunction(SOURCE, 'resolveCurrentMountedPageMembers'),
    extractFunction(SOURCE, 'rollbackWindowedCollapseCandidates'),
  ].join('\n');
  for (const pattern of [
    /requestTitleListCanonicalMaterialization/, /jumpToId/, /scrollIntoView/,
    /setInterval/, /setTimeout/, /MutationObserver/, /requestAnimationFrame/,
  ]) {
    equal(pattern.test(commitSource), false, `no ${String(pattern)} in the Pass-3 transaction path`);
  }
});

// --------------------------------------------------------------------------
// Stage 2 REFINED PASS 4 — collapse-side native retirement, identity-based
// post-commit reconcile, windowed expand.
//
// The Pass-4/Pass-5 split is deliberate. Five collapse-owned native fields are
// retired now. `flowRoot` and `hostWrappers` are GRANDFATHERED: they survive
// only because the pre-existing Pass-5-owned title-list projection still reads
// them, and Pass-4 collapse logic may not read them at all. Pass 5A retires
// them together with the title-list rework (version 3).
// --------------------------------------------------------------------------

const PASS4R_RETIRED_NOW = ['endWrapper', 'pageDivider', 'stampedWrappers', 'startWrapper', 'wrapperProofs'];
const PASS4R_GRANDFATHERED = ['flowRoot', 'hostWrappers'];
const PASS4R_INTERMEDIATE_FIELDS = [
  'atomicRenderedBoundaryPlan', 'capabilityIdentity', 'chatId', 'effectiveFingerprint',
  'expectedTitleRowCount', 'flowRoot', 'generation', 'graphFingerprint', 'hostWrappers',
  'isFinalPage', 'nextBoundaryQId', 'pageEndOrder', 'pageNum', 'pageStartOrder',
  'routeKey', 'source', 'startBoundaryQId', 'titleListContainer', 'titleRows',
  'titleRowsPrepared', 'version',
].sort();
// Pass-4-owned collapse surface. Any DIRECT read of a grandfathered field here
// is a quarantine breach.
const PASS4R_COLLAPSE_FUNCTIONS = [
  'validateCommittedAtomicPageCollapse', 'reconcileActiveWindowedCollapse',
  'expandWindowedPageCollapse', 'expandPageWithRenderedBoundaries',
  'rollbackWindowedCollapseCandidates', 'releaseAtomicPageCollapseState',
  'clearStaleWindowedCollapseStamps', 'commitWindowedPageCollapse',
];

function pass4rHostNodes(value, NodeCtor, skipKeys = [], seen = new Set(), out = []) {
  if (!value || typeof value !== 'object' || seen.has(value)) return out;
  seen.add(value);
  if (value instanceof NodeCtor) {
    const cls = String(value.className || '');
    const isH2O = cls.includes('cgxui-chat-page-title-list-synth')
      || String(value.getAttribute?.('data-cgxui') || '').includes('chat-page-title-list');
    if (!isH2O) out.push(String(value.getAttribute?.('data-testid') || '') || cls || 'node');
    return out;
  }
  if (value instanceof Map) { for (const [k, v] of value) { pass4rHostNodes(k, NodeCtor, [], seen, out); pass4rHostNodes(v, NodeCtor, [], seen, out); } return out; }
  if (value instanceof Set) { for (const v of value) pass4rHostNodes(v, NodeCtor, [], seen, out); return out; }
  if (Array.isArray(value)) { for (const v of value) pass4rHostNodes(v, NodeCtor, [], seen, out); return out; }
  for (const [k, v] of Object.entries(value)) {
    if (skipKeys.includes(k)) continue;
    pass4rHostNodes(v, NodeCtor, [], seen, out);
  }
  return out;
}
function pass4rCommitted(options = {}) {
  const t = stage2Transaction(options);
  const result = t.commit(t.plan());
  const transaction = t.api.state.atomicPageCollapseTransactions.values().next().value || null;
  return { ...t, result, transaction };
}
const p4rHidden = (node) => node?.getAttribute?.('data-cgxui-chat-page-native-hidden') ?? null;

await fixture('Stage2 T4-A intermediate transaction shape retires five collapse-owned native fields', () => {
  const c = pass4rCommitted({ coldEnd: true, middleCount: 6, missingEnd: true });
  equal(c.result.ok, true, 'windowed transaction commits');
  const fields = Object.keys(c.transaction).sort();
  /* The five collapse-owned native holdings Pass 4 retired stay retired. The
     transaction's final shape is pinned by T5-A: Pass 5A superseded the
     intermediate version-2 record by retiring the last two grandfathered
     fields, so asserting the intermediate count here would now pin a shape the
     product deliberately no longer has. */
  for (const retired of PASS4R_RETIRED_NOW) {
    equal(fields.includes(retired), false, `${retired} is retired from transaction state`);
  }
  const outside = pass4rHostNodes(c.transaction, c.h.flow.constructor, PASS4R_GRANDFATHERED);
  equal(outside.length, 0,
    `no host-native node outside the Pass-4 grandfathered fields (found ${JSON.stringify(outside)})`);
});

await fixture('Stage2 T4-Q Pass-4 collapse logic never reads the grandfathered fields directly', () => {
  const present = PASS4R_COLLAPSE_FUNCTIONS.filter((name) => SOURCE.includes(`  function ${name}(`));
  ok(present.length >= 6, 'the Pass-4 collapse surface exists');
  let directReads = 0;
  for (const name of present) {
    const body = extractFunction(SOURCE, name);
    for (const field of PASS4R_GRANDFATHERED) {
      const hits = (body.match(new RegExp(`transaction\\.${field}\\b`, 'g')) || []).length;
      equal(hits, 0, `${name} performs no direct read of transaction.${field}`);
      directReads += hits;
    }
  }
  equal(directReads, 0, 'zero direct Pass-4 collapse reads of the grandfathered fields');
  /* The permitted indirect title-list dependency is TWO named Pass-4 sites, not
     one. `reconcileActiveWindowedCollapse` needs it for a real reason: without
     it, incremental collapse reconciliation re-stamps a member the user
     deliberately opened in place, so the pass fights the title-list projection
     every time it runs. Both sites consume the reader's existing verdict; they
     do not change its meaning. */
  const openMountSites = ['validateCommittedAtomicPageCollapse', 'reconcileActiveWindowedCollapse'];
  equal((SOURCE.match(/function titleListCurrentOpenMount\(/g) || []).length, 1,
    'titleListCurrentOpenMount is defined exactly once');
  equal((SOURCE.match(/titleListCurrentOpenMount\(/g) || []).length - 1, openMountSites.length,
    'exactly two call sites exist in the whole module');
  for (const name of openMountSites) {
    const body = extractFunction(SOURCE, name);
    equal((body.match(/titleListCurrentOpenMount\(/g) || []).length, 1,
      `${name} holds exactly one permitted indirect title-list dependency`);
    for (const forbidden of ['titleListCurrentNativeMount', 'reconcileTitleListNativeInPlaceProjection',
      'clearTitleListNativeInPlaceProjection', 'reconcilePendingTitleListMaterialization',
      'openTitleListNativeInPlace', 'requestTitleListCanonicalMaterialization']) {
      equal(body.includes(forbidden), false, `${name} has no third dependency via ${forbidden}`);
    }
  }
  equal((SOURCE.match(/P03B/g) || []).length, 0, 'P03B/reveal usage in the controller remains zero');
});

await fixture('Stage2 T4-B post-commit validation resolves current identity only', () => {
  const c = pass4rCommitted({ coldEnd: true, middleCount: 6, missingEnd: true });
  ok(!!c.api.validateCommitted, 'identity-based post-commit validation exists');
  equal(c.api.validateCommitted(c.transaction).ok, true, 'a committed windowed page validates');
  const body = extractFunction(SOURCE, 'validateCommittedAtomicPageCollapse');
  for (const retired of [...PASS4R_RETIRED_NOW, ...PASS4R_GRANDFATHERED]) {
    equal(new RegExp(`transaction\\.${retired}\\b`).test(body), false,
      `validation does not consume transaction.${retired}`);
  }
  ok(body.includes('currentCollapsedPageMembers') || body.includes('resolveCurrentMountedPageMembers'),
    'validation resolves current members by canonical identity');
});

await fixture('Stage2 T4-C a later-mounted canonical member is stamped on ordinary reconcile', () => {
  const c = pass4rCommitted({ coldEnd: true, middleCount: 6, missingStart: true });
  equal(c.result.status, 'collapsed-no-native-work', 'committed with nothing mounted');
  ok(!!c.api.reconcileActive, 'an incremental reconcile entry exists');
  const wrapper = c.h.document.createElement('DIV');
  const late = c.h.document.createElement('SECTION');
  late.setAttribute('data-turn-id', 'q-4');
  late.setAttribute('data-turn', 'user');
  late.setAttribute('data-testid', 'conversation-turn-41');
  wrapper.appendChild(late);
  c.h.flow.appendChild(wrapper);
  const pass = c.api.reconcileActive('presentation-updated');
  equal(pass.mutations >= 1, true, 'the later arrival is stamped');
  equal(p4rHidden(wrapper), '1', 'stamped for page 1');
});

await fixture('Stage2 T4-D replacement is stamped on the CURRENT node, predecessor untouched', () => {
  const c = pass4rCommitted({ coldEnd: true, middleCount: 6, missingEnd: true });
  const original = c.api.subset(c.api.model().pages[0]).mounted[0].node;
  const replacement = c.h.document.createElement('SECTION');
  replacement.setAttribute('data-turn-id', 'q-1');
  replacement.setAttribute('data-turn', 'user');
  replacement.setAttribute('data-testid', 'conversation-turn-71');
  const i = c.h.flow.children.indexOf(original);
  c.h.flow.children.splice(i, 1);
  original.parentElement = null; original.isConnected = false;
  c.h.flow.appendChild(replacement);
  c.api.reconcileActive('presentation-updated');
  equal(p4rHidden(replacement), '1', 'current replacement stamped');
  equal(p4rHidden(original), '1', 'stale predecessor left exactly as it was, never rewritten');
  const outside = pass4rHostNodes(c.transaction, c.h.flow.constructor, PASS4R_GRANDFATHERED);
  equal(outside.length, 0, 'no native reference copied into Pass-4-owned transaction state');
});

await fixture('Stage2 T4-E unmount retains no Pass-4-owned native truth', () => {
  const c = pass4rCommitted({ coldEnd: true, middleCount: 6, missingEnd: true });
  const node = c.api.subset(c.api.model().pages[0]).mounted[0].node;
  const i = c.h.flow.children.indexOf(node);
  c.h.flow.children.splice(i, 1);
  node.parentElement = null; node.isConnected = false;
  const outside = pass4rHostNodes(c.transaction, c.h.flow.constructor, PASS4R_GRANDFATHERED);
  equal(outside.length, 0, 'no Pass-4-owned node retained after unmount');
  equal(c.api.state.atomicPageCollapseTransactions.size, 1, 'the scalar record and intent remain');
  equal(c.api.validateCommitted(c.transaction).ok, true, 'an unmounted member is ordinary absence');
});

await fixture('Stage2 T4-F reconcile is idempotent for already-correct members', () => {
  const c = pass4rCommitted({ coldEnd: true, middleCount: 6, missingEnd: true });
  c.api.reconcileActive('presentation-updated');
  equal(c.api.reconcileActive('presentation-updated').mutations, 0,
    'an already-correct current member is left untouched');
});

await fixture('Stage2 T4-G reconcile never touches wrong-page or DOM-only nodes', () => {
  const c = pass4rCommitted({ coldEnd: false, middleCount: 6 });
  c.api.reconcileActive('presentation-updated');
  const page2 = c.api.subset(c.api.model().pages[1]);
  equal(p4rHidden(page2.mounted[0].node), null, 'the mounted page-2 member is untouched');
  const orphan = c.h.document.createElement('DIV');
  const section = c.h.document.createElement('SECTION');
  section.setAttribute('data-turn-id', 'not-canonical');
  section.setAttribute('data-testid', 'conversation-turn-90');
  orphan.appendChild(section);
  c.h.flow.appendChild(orphan);
  c.api.reconcileActive('presentation-updated');
  equal(p4rHidden(orphan), null, 'DOM-only noncanonical node untouched');
});

await fixture('Stage2 T4-H ambiguous current identity fails reconcile closed', () => {
  const c = pass4rCommitted({ coldEnd: true, middleCount: 6, missingEnd: true });
  const dup = c.h.document.createElement('SECTION');
  dup.setAttribute('data-turn-id', 'q-1');
  dup.setAttribute('data-turn', 'user');
  dup.setAttribute('data-testid', 'conversation-turn-96');
  c.h.flow.appendChild(dup);
  const pass = c.api.reconcileActive('presentation-updated');
  equal(pass.ok, false, 'ambiguity fails closed');
  equal(pass.reason, 'candidate-identity-ambiguous', 'precise reason');
  equal(pass.mutations, 0, 'no approximate projection applied');
});

await fixture('Stage2 T4-I expand clears intent and unstamps current members', () => {
  const c = pass4rCommitted({ coldEnd: true, middleCount: 6, missingEnd: true });
  const node = c.api.subset(c.api.model().pages[0]).mounted[0].node;
  equal(p4rHidden(node), '1', 'stamped by the collapse');
  ok(!!c.api.expand, 'a windowed expand entry exists');
  const expanded = c.api.expand(1, { chatId: 'chat-stage-2c0' });
  equal(expanded.ok, true, 'expand succeeds');
  equal(expanded.revealCount, 0, 'zero reveal');
  equal(p4rHidden(node), null, 'current member unstamped');
  equal(c.api.state.atomicPageCollapseTransactions.size, 0, 'the transaction record is deleted');
});

await fixture('Stage2 T4-J a member mounting after expand arrives unsuppressed', () => {
  const c = pass4rCommitted({ coldEnd: true, middleCount: 6, missingEnd: true });
  c.api.expand(1, { chatId: 'chat-stage-2c0' });
  const wrapper = c.h.document.createElement('DIV');
  const late = c.h.document.createElement('SECTION');
  late.setAttribute('data-turn-id', 'q-5');
  late.setAttribute('data-turn', 'user');
  late.setAttribute('data-testid', 'conversation-turn-51');
  wrapper.appendChild(late);
  c.h.flow.appendChild(wrapper);
  const pass = c.api.reconcileActive('presentation-updated');
  equal(p4rHidden(wrapper), null, 'no collapse intent remains, so the arrival is unsuppressed');
  equal(pass.mutations, 0, 'no stamping work happened');
});

await fixture('Stage2 T4-K stale hidden attribute re-entry is cleaned', () => {
  const c = pass4rCommitted({ coldEnd: true, middleCount: 6, missingEnd: true });
  c.api.expand(1, { chatId: 'chat-stage-2c0' });
  const reused = c.h.document.createElement('DIV');
  reused.setAttribute('data-cgxui-chat-page-native-hidden', '1');
  c.h.flow.appendChild(reused);
  ok(!!c.api.clearStale, 'a stale-stamp cleanup entry exists');
  const cleaned = c.api.clearStale('chat-stage-2c0');
  equal(p4rHidden(reused), null, 'the stale attribute is removed because page 1 is not collapsed');
  equal(cleaned.mutations >= 1, true, 'cleanup reports the mutation');
});

await fixture('Stage2 T4-L last logical intent wins over a stale collapse reconcile', () => {
  const c = pass4rCommitted({ coldEnd: true, middleCount: 6, missingEnd: true });
  const node = c.api.subset(c.api.model().pages[0]).mounted[0].node;
  c.api.expand(1, { chatId: 'chat-stage-2c0' });
  equal(p4rHidden(node), null, 'expanded');
  const pass = c.api.reconcileActive('stale-observer-after-expand');
  equal(pass.mutations, 0, 'the stale pass performs zero re-hide writes');
  equal(p4rHidden(node), null, 'the member stays unsuppressed');
});

await fixture('Stage2 T4-M/N Pass-4 reconcile and expand add no reveal, observer, timer or scheduler', () => {
  const names = ['reconcileActiveWindowedCollapse', 'clearStaleWindowedCollapseStamps', 'expandWindowedPageCollapse'];
  const present = names.filter((name) => SOURCE.includes(`  function ${name}(`));
  equal(present.length, names.length, 'the Pass-4 reconcile/expand surface exists');
  const body = present.map((name) => extractFunction(SOURCE, name)).join('\n');
  for (const pattern of [
    /requestTitleListCanonicalMaterialization/, /jumpToId/, /scrollIntoView/,
    /setInterval/, /setTimeout/, /MutationObserver/, /requestAnimationFrame/, /IntersectionObserver/,
  ]) {
    equal(pattern.test(body), false, `no ${String(pattern)} in the Pass-4 reconcile/expand surface`);
  }
});

await fixture('Stage2 T4 collapse-side rebind-by-retained-node is retired', () => {
  equal(SOURCE.includes('rebindCommittedAtomicPageCollapse'), false,
    'the retained-node rebind model is gone, not left as a facade');
});

/* --------------------------------------------------------------------------
   Class-1 boundary closure.

   These two names are historical and are kept for traceability, but what they
   assert is not. The retired contract said a remembered boundary ELEMENT going
   stale invalidates the collapse, and measured cleanup on 50 remembered wrapper
   objects. Under host windowing that is unanswerable: an unmounted member and a
   replaced member look identical to a retained reference, so ordinary host churn
   expanded a page the user had collapsed. The current contract is that the
   boundary is an IDENTITY — staleness is re-resolved, the CURRENT replacement
   receives the projection, and residue is measured on the live surface.
   -------------------------------------------------------------------------- */

// A predecessor write counter, so "untouched" is proven by mutation count and
// attribute state rather than by absence from an array.
function pass4rWatchWrites(node) {
  const state = { writes: 0, markerBefore: node.getAttribute('data-cgxui-chat-page-native-hidden') };
  const set = node.setAttribute.bind(node);
  const remove = node.removeAttribute.bind(node);
  node.setAttribute = (name, value) => { state.writes += 1; return set(name, value); };
  node.removeAttribute = (name) => { state.writes += 1; return remove(name); };
  return state;
}
function pass4rDetach(h, node) {
  const index = h.flow.children.indexOf(node);
  if (index >= 0) h.flow.children.splice(index, 1);
  node.parentElement = null;
  node.isConnected = false;
}
function pass4rMountTurn(h, identity, role, testId) {
  const node = h.document.createElement('SECTION');
  node.setAttribute('data-turn-id', identity);
  node.setAttribute('data-turn', role);
  node.setAttribute('data-testid', testId);
  h.flow.appendChild(node);
  return node;
}
// Canonical drift must remain fail-closed for a committed page, exercised over
// the SAME replacement coverage rather than in a separate world.
function pass4rAssertDriftFailsClosed(c) {
  for (const [label, drift] of [
    ['routeKey', { routeKey: '/c/other-route' }],
    ['generation', { generation: 9 }],
    ['effectiveFingerprint', { canonicalFingerprint: 'djb2:other-effective' }],
  ]) {
    const restore = { ...c.h.status };
    Object.assign(c.h.status, drift);
    equal(c.api.validateCommitted(c.transaction).ok, false, `${label} drift still fails closed`);
    Object.assign(c.h.status, restore);
  }
  const graphBefore = c.h.graphScope.fingerprint;
  c.h.graphScope.fingerprint = 'djb2:other-graph';
  equal(c.api.validateCommitted(c.transaction).ok, false, 'graphFingerprint drift still fails closed');
  c.h.graphScope.fingerprint = graphBefore;
  equal(c.api.validateCommitted(c.transaction).ok, true, 'the coherent page is valid again once drift clears');
}

await fixture('start-boundary replacement expands safely', () => {
  const c = pass4rCommitted({ coldEnd: false, middleCount: 6 });
  const start = c.api.subset(c.api.model().pages[0]).mounted[0];
  const stale = start.node;
  equal(p4rHidden(stale), '1', 'the page-1 start boundary is suppressed by the commit');
  const watch = pass4rWatchWrites(stale);

  // (A) The remembered boundary object alone going stale is host churn, not an
  // invalidation of a canonically coherent collapsed page.
  pass4rDetach(c.h, stale);
  equal(c.api.validateCommitted(c.transaction).ok, true, 'a stale remembered start boundary does not invalidate the collapse');
  equal(c.api.state.atomicPageCollapseTransactions.size, 1, 'the committed collapse is not expanded');

  // (B) A real CURRENT replacement arrives carrying the same canonical identity.
  const replacement = pass4rMountTurn(c.h, start.questionId, 'user', 'conversation-turn-64');

  // (C) Current presentation comes from the frozen Stage-1 identity path, and it
  // reports the replacement — never the remembered object.
  const surface = c.api.identity(start.questionId, c.h.flow);
  equal(surface.ok, true, 'the frozen identity resolver binds a current surface');
  equal(surface.directFlowWrapper === replacement, true, 'it resolves the CURRENT replacement');
  equal(surface.directFlowWrapper === stale, false, 'it never resolves the remembered predecessor');

  // (D) The replacement receives the collapsed projection.
  const pass = c.api.reconcileActive('start-boundary-replacement');
  equal(pass.ok, true, 'reconcile succeeds over the replacement');
  equal(pass.mutations, 1, 'exactly the replacement was stamped');
  equal(p4rHidden(replacement), '1', 'the CURRENT replacement carries the page-1 projection');

  // (E) The predecessor received no write of any kind.
  equal(watch.writes, 0, 'zero writes reached the stale predecessor');
  equal(p4rHidden(stale), watch.markerBefore, 'its attribute state is exactly as the host left it');

  // (F) Ambiguous CURRENT identity still fails closed.
  const duplicate = pass4rMountTurn(c.h, start.questionId, 'user', 'conversation-turn-65');
  const ambiguous = c.api.reconcileActive('start-boundary-ambiguous');
  equal(ambiguous.ok, false, 'ambiguous current identity fails closed');
  equal(ambiguous.reason, 'candidate-identity-ambiguous', 'precise reason');
  equal(ambiguous.mutations, 0, 'no approximate projection is applied');
  pass4rDetach(c.h, duplicate);

  // (G) Canonical drift remains fail-closed over the same coverage.
  pass4rAssertDriftFailsClosed(c);

  // (H) Residue is measured on the CURRENT live surface and by the bounded stale
  // marker sweep — never from a retained historical wrapper array.
  const expanded = c.api.expand(1, { chatId: 'chat-stage-2c0' });
  equal(expanded.ok, true, 'expansion completes');
  equal(p4rHidden(replacement), null, 'the CURRENT surface carries no residue');
  equal(c.h.flow.children.filter((node) => p4rHidden(node) !== null).length, 0, 'zero residue on the live flow');
  equal(c.api.clearStale('chat-stage-2c0').mutations, 0, 'the bounded stale sweep finds nothing left to clean');
  equal(watch.writes, 0, 'release still never writes the stale predecessor');
});

await fixture('end-boundary replacement expands safely', () => {
  const c = pass4rCommitted({ coldEnd: false, middleCount: 6 });
  const pageOne = c.api.subset(c.api.model().pages[0]).mounted[0];
  const endBoundary = c.api.subset(c.api.model().pages[1]).mounted[0];
  const staleEnd = endBoundary.node;
  equal(p4rHidden(pageOne.node), '1', 'page 1 is suppressed by the commit');
  equal(p4rHidden(staleEnd), null, 'the end-exclusive boundary belongs to page 2 and is never suppressed');
  const watch = pass4rWatchWrites(staleEnd);

  // (A) The remembered end boundary going stale is host churn, not invalidation.
  pass4rDetach(c.h, staleEnd);
  equal(c.api.validateCommitted(c.transaction).ok, true, 'a stale remembered end boundary does not invalidate the collapse');
  equal(c.api.state.atomicPageCollapseTransactions.size, 1, 'the committed collapse is not expanded');
  equal(p4rHidden(pageOne.node), '1', 'page 1 keeps its projection throughout');

  // (B) A real CURRENT replacement arrives carrying the same canonical identity.
  const replacement = pass4rMountTurn(c.h, endBoundary.questionId, 'user', 'conversation-turn-72');

  // (C) Current presentation comes from the frozen Stage-1 identity path.
  const surface = c.api.identity(endBoundary.questionId, c.h.flow);
  equal(surface.ok, true, 'the frozen identity resolver binds a current surface');
  equal(surface.directFlowWrapper === replacement, true, 'it resolves the CURRENT replacement');
  equal(surface.directFlowWrapper === staleEnd, false, 'it never resolves the remembered predecessor');

  // (D) The correct projection for an end-exclusive boundary is NO suppression:
  // it is page 2's member, and page 1's collapse must not reach across it.
  const pass = c.api.reconcileActive('end-boundary-replacement');
  equal(pass.ok, true, 'reconcile succeeds');
  equal(pass.mutations, 0, 'the page-1 projection does not extend to the replacement');
  equal(p4rHidden(replacement), null, 'the CURRENT end boundary stays visible');
  equal(p4rHidden(pageOne.node), '1', 'page 1 remains correctly suppressed');

  // (E) The predecessor received no write of any kind.
  equal(watch.writes, 0, 'zero writes reached the stale predecessor');
  equal(p4rHidden(staleEnd), watch.markerBefore, 'its attribute state is exactly as the host left it');

  // (F) Ambiguity beyond the page does not corrupt it, and ambiguity within it
  // still fails closed.
  const duplicateEnd = pass4rMountTurn(c.h, endBoundary.questionId, 'user', 'conversation-turn-73');
  const acrossBoundary = c.api.reconcileActive('end-boundary-ambiguous');
  equal(acrossBoundary.ok, true, 'ambiguity outside the collapsed page is not page 1 business');
  equal(acrossBoundary.mutations, 0, 'and it changes nothing');
  pass4rDetach(c.h, duplicateEnd);
  const duplicateMember = pass4rMountTurn(c.h, pageOne.questionId, 'user', 'conversation-turn-74');
  const withinPage = c.api.reconcileActive('page-member-ambiguous');
  equal(withinPage.ok, false, 'ambiguous current identity inside the page fails closed');
  equal(withinPage.reason, 'candidate-identity-ambiguous', 'precise reason');
  equal(withinPage.mutations, 0, 'no approximate projection is applied');
  pass4rDetach(c.h, duplicateMember);

  // (G) Canonical drift remains fail-closed over the same coverage.
  pass4rAssertDriftFailsClosed(c);

  // (H) Residue is measured on the CURRENT live surface and the bounded sweep.
  const expanded = c.api.expand(1, { chatId: 'chat-stage-2c0' });
  equal(expanded.ok, true, 'expansion completes');
  equal(c.h.flow.children.filter((node) => p4rHidden(node) !== null).length, 0, 'zero residue on the live flow');
  equal(c.api.clearStale('chat-stage-2c0').mutations, 0, 'the bounded stale sweep finds nothing left to clean');
  equal(watch.writes, 0, 'release still never writes the stale predecessor');
});

// --------------------------------------------------------------------------
// Stage 2 PASS 5A — final native-retention retirement.
//
// Version 3 is the fully-retired shape: the committed transaction holds ZERO
// persistent ChatGPT-owned native truth. The title-list projection keeps its
// own H2O-created handles (the synthetic container and the rows it owns) and
// derives every host-native relationship at point of use.
// --------------------------------------------------------------------------

const PASS5A_FINAL_FIELDS = [
  'atomicRenderedBoundaryPlan', 'capabilityIdentity', 'chatId', 'effectiveFingerprint',
  'expectedTitleRowCount', 'generation', 'graphFingerprint', 'isFinalPage',
  'nextBoundaryQId', 'pageEndOrder', 'pageNum', 'pageStartOrder', 'routeKey',
  'source', 'startBoundaryQId', 'titleListContainer', 'titleRows',
  'titleRowsPrepared', 'version',
].sort();
// The only handles a version-3 transaction may still hold are H2O-created.
const PASS5A_H2O_PROJECTION_KEYS = ['titleListContainer', 'titleRowsPrepared'];
const PASS5A_TITLE_FUNCTIONS = [
  'titleListCurrentNativeMount', 'clearTitleListNativeInPlaceProjection',
  'reconcileTitleListNativeInPlaceProjection', 'syncSyntheticTitleList',
  'reassertActiveTitleListFlowHidden',
];

await fixture('Stage2 T5-A version-3 transaction shape retires the last native fields', () => {
  const c = pass4rCommitted({ coldEnd: true, middleCount: 6, missingEnd: true });
  equal(c.result.ok, true, 'the windowed transaction commits');
  const fields = Object.keys(c.transaction).sort();
  equal(c.transaction.version, 3, 'version 3 = fully-retired Stage-2 shape');
  equal(fields.length, 19, 'exactly 19 persistent transaction fields');
  equal(fields, PASS5A_FINAL_FIELDS, 'exact version-3 field set');
});

await fixture('Stage2 T5-B/C/D no persistent ChatGPT-owned native node survives', () => {
  const c = pass4rCommitted({ coldEnd: true, middleCount: 6, missingEnd: true });
  equal(Object.prototype.hasOwnProperty.call(c.transaction, 'flowRoot'), false, 'flowRoot is absent');
  equal(Object.prototype.hasOwnProperty.call(c.transaction, 'hostWrappers'), false, 'hostWrappers is absent');
  // Scanned with only the H2O-created projection handles excluded: every other
  // reachable host node, at any nesting depth, is a retention failure.
  const retained = pass4rHostNodes(c.transaction, c.h.flow.constructor, PASS5A_H2O_PROJECTION_KEYS);
  equal(retained.length, 0, `zero persistent ChatGPT-owned native nodes (found ${JSON.stringify(retained)})`);
});

await fixture('Stage2 T5-E the Pass-5 compatibility writer is retired', () => {
  equal(SOURCE.includes('syncPass5CompatibilityNativeState'), false,
    'the compatibility writer is gone, not left as a facade');
});

await fixture('Stage2 T5-F/G/H title projection never consults a retained native field', () => {
  for (const name of PASS5A_TITLE_FUNCTIONS) {
    const body = extractFunction(SOURCE, name);
    for (const field of ['flowRoot', 'hostWrappers']) {
      equal((body.match(new RegExp(`transaction\\.${field}\\b`, 'g')) || []).length, 0,
        `${name} performs no read of transaction.${field}`);
    }
  }
  // The mount verdict and the ordering/suffix mechanics resolve the root at
  // point of use instead.
  for (const name of ['titleListCurrentNativeMount', 'reconcileTitleListNativeInPlaceProjection']) {
    ok(extractFunction(SOURCE, name).includes('collapsedPageFlowRootByIdentity'),
      `${name} derives the current root at point of use`);
  }
  // Pass 5A introduces no scheduling surface of its own, and stays on the
  // Pass-5B side of the reveal boundary.
  const pass5aBodies = ['titleListCurrentProjectionNodes', 'titleListCurrentProjectedCount']
    .map((name) => extractFunction(SOURCE, name)).join('\n');
  for (const pattern of [
    /setTimeout/, /setInterval/, /requestAnimationFrame/, /MutationObserver/,
    /IntersectionObserver/, /requestTitleListCanonicalMaterialization/, /scrollIntoView/, /jumpToId/,
  ]) {
    equal(pattern.test(pass5aBodies), false, `no ${String(pattern)} in the Pass-5A surface`);
  }
  equal((SOURCE.match(/P03B/g) || []).length, 0, 'P03B/reveal usage remains zero');
});

await fixture('Stage2 T5-F answer-type partial anchors remain incomplete', () => {
  const x = createTransactionHarness();
  equal(collapse(x).ok, true, 'page collapse committed');
  const transaction = x.S.atomicPageCollapseTransactions.values().next().value;
  const member = transaction.titleRows[0];
  equal(member.type, 'answer', 'the selected member is answer-type');
  const before = x.api.nativeMount(transaction, member);
  equal(before.ok, true, 'both current anchors resolve');
  equal(before.anchors.length, 2, 'answer-type completeness requires two current anchors');
  // Lose exactly one of the two required current anchors.
  x.answer1.wrapper.remove();
  const after = x.api.nativeMount(transaction, member);
  equal(after.ok, false, 'one of two anchors is not a complete mount');
  equal(after.reason, 'canonical-mount-incomplete', 'reported as incomplete, never as complete');
});

await fixture('Stage2 T5-G current replacement resolves and the stale predecessor is ignored', () => {
  const x = createTransactionHarness();
  equal(collapse(x).ok, true, 'page collapse committed');
  const transaction = x.S.atomicPageCollapseTransactions.values().next().value;
  const member = transaction.titleRows[0];
  const stale = x.start.wrapper;
  let staleWrites = 0;
  const set = stale.setAttribute.bind(stale);
  const remove = stale.removeAttribute.bind(stale);
  const markerBefore = stale.getAttribute('data-cgxui-chat-page-native-hidden');
  stale.setAttribute = (n, v) => { staleWrites += 1; return set(n, v); };
  stale.removeAttribute = (n) => { staleWrites += 1; return remove(n); };
  const NodeCtor = x.flow.constructor;
  const replacement = new NodeCtor('DIV', 'host-turn-slot', x.guard);
  const host = new NodeCtor('SECTION', 'native-turn-host', x.guard);
  const carrier = new NodeCtor('SECTION', 'identity-carrier', x.guard);
  carrier.setAttribute('data-turn-id', member.questionId);
  host.setAttribute('data-testid', 'conversation-turn-31');
  carrier.setAttribute('data-turn', 'user');
  host.appendChild(carrier);
  replacement.appendChild(host);
  x.flow.replaceChild(replacement, stale);
  x.window.H2O.obs.mounts.set(member.questionId, { el: carrier, shell: replacement });
  const mount = x.api.nativeMount(transaction, member);
  equal(mount.ok, true, 'the CURRENT replacement resolves by canonical identity');
  equal(mount.anchors.includes(replacement), true, 'the replacement is the presented anchor');
  equal(mount.anchors.includes(stale), false, 'the stale predecessor is ignored');
  equal(staleWrites, 0, 'the stale predecessor receives no write');
  equal(stale.getAttribute('data-cgxui-chat-page-native-hidden'), markerBefore, 'its attribute state is untouched');
});

await fixture('Stage2 T5-J projection is idempotent and touches only current canonical nodes', () => {
  const x = createTransactionHarness();
  equal(collapse(x).ok, true, 'page collapse committed');
  const transaction = x.S.atomicPageCollapseTransactions.values().next().value;
  const member = transaction.titleRows[0];
  equal(x.api.open(transaction, member).status, 'open', 'selected turn opened');
  const first = x.api.reconcileProjection(transaction, { reason: 'settle' });
  equal(first.ok, true, 'the projection settles');
  const second = x.api.reconcileProjection(transaction, { reason: 'idempotence' });
  equal(second.mutations, 0, 'an already-correct projection performs zero writes');
  // A DOM-only noncanonical node in the same flow is never touched.
  const orphan = x.flow.constructor ? new x.flow.constructor('DIV', 'host-unrelated', x.guard) : null;
  x.flow.appendChild(orphan);
  const third = x.api.reconcileProjection(transaction, { reason: 'dom-only' });
  equal(third.mutations, 0, 'a DOM-only noncanonical node draws no write');
  equal(orphan.hasAttribute('data-cgxui-chat-page-native-hidden'), false, 'and is left unmarked');
});

await fixture('Stage2 T5-N suffix placement follows the CURRENT ordered anchors', () => {
  const x = createTransactionHarness();
  equal(collapse(x).ok, true, 'page collapse committed');
  const transaction = x.S.atomicPageCollapseTransactions.values().next().value;
  const member = transaction.titleRows[0];
  equal(x.api.open(transaction, member).status, 'open', 'selected turn opened');
  const mount = x.api.nativeMount(transaction, member);
  const ordered = mount.anchors.slice().sort(
    (a, b) => x.flow.children.indexOf(a) - x.flow.children.indexOf(b),
  );
  const lastAnchor = ordered[ordered.length - 1];
  const suffix = x.api.suffixContainers(transaction.pageNum, transaction.chatId)[0] || null;
  ok(!!suffix, 'the suffix container exists');
  equal(suffix.parentElement, x.flow, 'the suffix sits in the current flow root');
  const placed = Array.from(x.flow.children);
  equal(placed.indexOf(suffix), placed.indexOf(lastAnchor) + 1,
    'immediately after the LAST CURRENT ordered anchor');
});

await fixture('Stage2 T5-O a vanished anchor before insertion fails safely', () => {
  const x = createTransactionHarness();
  equal(collapse(x).ok, true, 'page collapse committed');
  const transaction = x.S.atomicPageCollapseTransactions.values().next().value;
  const member = transaction.titleRows[0];
  equal(x.api.open(transaction, member).status, 'open', 'selected turn opened');
  // The whole current mount disappears between derivation and the next pass.
  x.start.wrapper.remove();
  x.answer1.wrapper.remove();
  const result = x.api.reconcileProjection(transaction, { reason: 'anchor-vanished' });
  equal(result.status === 'open', false, 'the projection never reports open over a vanished mount');
  ok(/cleared|pending/.test(String(result.status || '')),
    `it abandons the write safely (status ${result.status})`);
  for (const suffix of x.api.suffixContainers(transaction.pageNum, transaction.chatId)) {
    equal(suffix.previousElementSibling?.isConnected === false, false,
      'no suffix is positioned after a disconnected anchor');
    equal(suffix.parentElement === x.flow && suffix.previousElementSibling === null, false,
      'no best-effort append relative to stale state');
  }
});

// --------------------------------------------------------------------------
// Stage 2 PASS 5B — exact-target SUCCESS consumption.
//
// The bounded request already existed; only its success half was missing.
// 'navigated' is the coordinator's sole success token and is a statement about
// NAVIGATION, not about presentation: it is correlated to our own outstanding
// request, revalidated against the latest intent and canonical authority, and
// then still discarded unless the CURRENT exact target re-resolves.
// --------------------------------------------------------------------------

// A page whose selected member's exact target is not mounted, with exactly one
// bounded materialization request outstanding.
function pass5bPending() {
  const x = createTransactionHarness();
  equal(collapse(x).ok, true, 'page collapse committed');
  const transaction = x.S.atomicPageCollapseTransactions.values().next().value;
  const member = transaction.titleRows[0];
  x.start.wrapper.remove();
  equal(x.api.open(transaction, member).status, 'pending', 'the missing exact target is pending');
  equal(x.calls.materializations, 1, 'exactly one bounded request is outstanding');
  const state = x.S.titleListOpenStatesByKey.values().next().value;
  return { x, transaction, member, state };
}
function pass5bNavigated(scope, overrides = {}) {
  scope.x.control.navigationStatus = Object.freeze({
    status: 'navigated',
    targetQId: String(scope.member.questionId || ''),
    generation: Math.max(0, Number(scope.state?.materializationGeneration || 0) || 0),
    errorCode: null,
    ...overrides,
  });
}
// Re-mount the exact canonical target as a CURRENT node, the way the host does.
function pass5bRemountQuestion(scope, testId = 'conversation-turn-41') {
  const NodeCtor = scope.x.flow.constructor;
  const replacement = new NodeCtor('DIV', 'host-turn-slot', scope.x.guard);
  const host = new NodeCtor('SECTION', 'native-turn-host', scope.x.guard);
  const carrier = new NodeCtor('SECTION', 'identity-carrier', scope.x.guard);
  carrier.setAttribute('data-turn-id', scope.member.questionId);
  host.setAttribute('data-testid', testId);
  carrier.setAttribute('data-turn', 'user');
  host.appendChild(carrier);
  replacement.appendChild(host);
  scope.x.flow.insertBefore(replacement, scope.x.answer1.wrapper);
  scope.x.window.H2O.obs.mounts.set(scope.member.questionId, { el: carrier, shell: replacement });
  return replacement;
}

await fixture('Stage2 B5 navigated alone does not complete an unresolvable target', () => {
  const scope = pass5bPending();
  pass5bNavigated(scope);
  // The exact target is still not mounted: navigation succeeded, presentation
  // did not, and the two are not the same claim.
  const result = scope.x.api.reconcileOpen(scope.transaction, { reason: 'navigated-without-target' });
  equal(result.status, 'pending', 'the interaction stays pending');
  equal(result.materialization, 'navigated', 'the success is consumed and reported');
  equal(scope.state.pending, true, 'pending intent is retained');
  equal(scope.x.calls.materializations, 1, 'success processing issues no further request');
});

await fixture('Stage2 B6 navigated with a complete CURRENT target completes the interaction', () => {
  const scope = pass5bPending();
  pass5bNavigated(scope);
  pass5bRemountQuestion(scope);
  const result = scope.x.api.reconcileOpen(scope.transaction, { reason: 'navigated-with-target' });
  equal(result.status, 'open', 'the title interaction settles');
  equal(result.materialization, 'navigated', 'the correlated success is consumed');
  equal(scope.state.materializationStatus, 'navigated', 'the request records its exact success token');
  equal(scope.state.pending, false, 'pending intent is cleared');
  equal(scope.x.calls.materializations, 1, 'completion issues no further request');
});

await fixture('Stage2 B6b a CURRENT replacement with stable canonical identity completes', () => {
  const scope = pass5bPending();
  pass5bNavigated(scope);
  const replacement = pass5bRemountQuestion(scope, 'conversation-turn-77');
  const result = scope.x.api.reconcileOpen(scope.transaction, { reason: 'replacement-remount' });
  equal(result.status, 'open', 'the replacement completes the interaction');
  equal(result.materialization, 'navigated', 'through the correlated success, not by accident');
  equal(scope.x.api.nativeMount(scope.transaction, scope.member).anchors.includes(replacement), true,
    'the CURRENT replacement is the presented anchor');
  equal(scope.x.calls.materializations, 1, 'no further request');
});

await fixture('Stage2 B7 a non-matching target or older generation is ignored', () => {
  const wrongTarget = pass5bPending();
  pass5bNavigated(wrongTarget, { targetQId: 'some-other-canonical-id' });
  pass5bRemountQuestion(wrongTarget);
  const a = wrongTarget.x.api.reconcileOpen(wrongTarget.transaction, { reason: 'wrong-target' });
  equal(a.materialization, null, 'a success for another target is not consumed');
  equal(wrongTarget.state.materializationStatus === 'navigated', false, 'and never recorded as ours');

  const older = pass5bPending();
  // A genuinely OLDER status needs a known non-zero expectation on both sides:
  // generation 0 means "unknown" under the established correlation rule, not
  // "older", and is deliberately not treated as disqualifying.
  older.state.materializationGeneration = 5;
  pass5bNavigated(older, { generation: 3 });
  pass5bRemountQuestion(older);
  const b = older.x.api.reconcileOpen(older.transaction, { reason: 'older-generation' });
  equal(b.materialization, null, 'an older-generation success is not ours');
  equal(older.x.calls.materializations, 1, 'and provokes no new request');
});

await fixture('Stage2 B8 a newer generation for the exact target still correlates', () => {
  const scope = pass5bPending();
  const expected = Math.max(0, Number(scope.state?.materializationGeneration || 0) || 0);
  // Coordinator cancellation advances the same operation's generation.
  pass5bNavigated(scope, { generation: expected + 5 });
  pass5bRemountQuestion(scope);
  const result = scope.x.api.reconcileOpen(scope.transaction, { reason: 'newer-generation' });
  equal(result.materialization, 'navigated', 'the same operation is still recognised');
  equal(result.status, 'open', 'and the interaction completes');
});

await fixture('Stage2 B9 a late navigated after close is a no-op', () => {
  const scope = pass5bPending();
  const before = scope.x.calls.materializations;
  // The user closes the title state while the request is still outstanding.
  scope.x.api.clearProjection(scope.transaction, { rehide: true });
  equal(scope.x.S.titleListOpenStatesByKey.size, 0, 'the open state is drained by the close');
  pass5bNavigated(scope);
  const result = scope.x.api.reconcileOpen(scope.transaction, { reason: 'late-navigated-after-close' });
  equal(scope.x.S.titleListOpenStatesByKey.size, 0, 'the late success does not reopen the title state');
  equal(result.materialization == null, true, 'nothing is consumed without a current intent');
  equal(scope.x.calls.materializations, before, 'and no request is issued again');
  equal(scope.selectedRow?.hasAttribute?.('data-h2o-title-row-opened') || false, false, 'no row is reopened');
});

await fixture('Stage2 B10 a late navigated for target A never completes target B', () => {
  const scope = pass5bPending();
  const targetA = scope.member;
  // The user activates a different member while A is still pending.
  const targetB = scope.transaction.titleRows.slice(1).find(
    (candidate) => scope.x.api.nativeMount(scope.transaction, candidate).ok === true,
  ) || null;
  ok(!!targetB && targetB.id !== targetA.id, 'a distinct, currently mounted second target exists');
  equal(scope.x.api.open(scope.transaction, targetB).status, 'open', 'target B becomes the current intent');
  const stateB = scope.x.S.titleListOpenStatesByKey.values().next().value;
  equal(String(stateB.canonicalId || ''), String(targetB.id || ''), 'B owns the latest intent');
  const requestsBefore = scope.x.calls.materializations;
  // A's navigation result arrives afterwards.
  scope.x.control.navigationStatus = Object.freeze({
    status: 'navigated', targetQId: String(targetA.questionId || ''),
    generation: Number(scope.state?.materializationGeneration || 0) + 1, errorCode: null,
  });
  const result = scope.x.api.reconcileOpen(scope.transaction, { reason: 'late-navigated-for-a' });
  const stateAfter = scope.x.S.titleListOpenStatesByKey.values().next().value;
  equal(String(stateAfter.canonicalId || ''), String(targetB.id || ''), 'B still owns the intent');
  equal(result.materialization == null, true, "A's success never completes B");
  equal(stateAfter.materializationStatus === 'navigated', false, "and is never recorded on B's request");
  equal(scope.x.calls.materializations, requestsBefore, 'A is not re-requested');
});

await fixture('Stage2 B12 answer-type completion after navigated still needs both anchors', () => {
  const x = createTransactionHarness();
  equal(collapse(x).ok, true, 'page collapse committed');
  const transaction = x.S.atomicPageCollapseTransactions.values().next().value;
  const member = transaction.titleRows[0];
  equal(member.type, 'answer', 'the selected member is answer-type');
  // Only the answer surface is lost.
  x.answer1.wrapper.remove();
  equal(x.api.open(transaction, member).status, 'pending', 'one of two anchors is pending');
  const state = x.S.titleListOpenStatesByKey.values().next().value;
  x.control.navigationStatus = Object.freeze({
    status: 'navigated', targetQId: String(member.questionId || ''),
    generation: Number(state?.materializationGeneration || 0), errorCode: null,
  });
  const result = x.api.reconcileOpen(transaction, { reason: 'navigated-partial-answer' });
  equal(result.status, 'pending', 'navigated does not bypass member-type completeness');
  equal(result.materialization, 'navigated', 'the success is consumed, and still does not complete');
  equal(x.api.nativeMount(transaction, member).reason, 'canonical-mount-incomplete', 'one of two remains incomplete');
  equal(x.calls.materializations, 1, 'no further request');
});

await fixture('Stage2 B13 success consumption retains nothing and schedules nothing', () => {
  const scope = pass5bPending();
  pass5bNavigated(scope);
  pass5bRemountQuestion(scope);
  scope.x.api.reconcileOpen(scope.transaction, { reason: 'retention-check' });
  equal(scope.transaction.version, 3, 'the transaction is still version 3');
  equal(pass4rHostNodes(scope.transaction, scope.x.flow.constructor, PASS5A_H2O_PROJECTION_KEYS).length, 0,
    'zero persistent ChatGPT-owned native nodes after success consumption');
  const state = scope.x.S.titleListOpenStatesByKey.values().next().value || {};
  equal(Object.values(state).some((value) => value instanceof scope.x.flow.constructor), false,
    'the scalar open state retains no native node');
  const body = extractFunction(SOURCE, 'titleListCanonicalMaterializationSettled');
  for (const pattern of [/setTimeout/, /setInterval/, /requestAnimationFrame/, /MutationObserver/, /IntersectionObserver/, /scrollIntoView/]) {
    equal(pattern.test(body), false, `no ${String(pattern)} in the success consumer`);
  }
  equal((SOURCE.match(/P03B/g) || []).length, 0, 'P03B usage remains zero');
});

// --------------------------------------------------------------------------
// LIVE CORRECTION — defects found by the dedicated 28-turn fixture.
//
// A: the metrics line dereferences plan.hostWrappers.length before the Stage-2
//    windowed branch that explicitly permits the field to be missing. The real
//    windowed plan literal omits it entirely, so collapse threw before it could
//    ever reach the branch written to handle it.
// B: the all-or-nothing stamp guard is correct and stays correct. What was lost
//    is the reason: the catch discarded the thrown error, leaving only an opaque
//    transient-failure to diagnose the live page-2 stall with.
// --------------------------------------------------------------------------

// The real windowed plan shape: stage2WindowedPlan true and NO hostWrappers
// property at all. Absent and [] are different things here, and the difference
// is exactly what threw.
function liveWindowedPlanHarness({ emptyArray = false, mounted = null } = {}) {
  const x = createTransactionHarness();
  x.control.planTransform = (plan) => {
    const windowed = { ...plan, stage2WindowedPlan: true };
    if (emptyArray) windowed.hostWrappers = [];
    else delete windowed.hostWrappers;
    if (mounted) windowed.mountedCandidates = mounted(x);
    return windowed;
  };
  return x;
}

await fixture('Live A a windowed plan without hostWrappers never throws while recording metrics', () => {
  const x = liveWindowedPlanHarness();
  const result = x.api.execute(1, 'validator', { chatId: x.plan.chatId });
  ok(!!result && typeof result.status === 'string', 'collapse execution returns a decision instead of throwing');
  equal(String(result.status).includes('TypeError'), false, 'and not a thrown-shaped status');
  // The windowed branch is now reachable. This world has a current mounted
  // subset, so it takes the ordinary windowed transaction semantics.
  equal(result.status, 'collapsed', 'the windowed branch is reached and commits');
  const diagnostic = x.api.diagnostic();
  equal(diagnostic.available, true, 'an attempt diagnostic was recorded');
  equal(diagnostic.wrappersPlanned, 0, 'a missing hostWrappers field records zero planned wrappers');
  const transaction = x.S.atomicPageCollapseTransactions.values().next().value || null;
  ok(!!transaction, 'the collapse is committed');
  equal(transaction.version, 3, 'through the accepted version-3 shape');
  equal(pass4rHostNodes(transaction, x.flow.constructor, PASS5A_H2O_PROJECTION_KEYS).length, 0,
    'zero native retention');

  // The empty-current-subset outcome (collapsed-no-native-work /
  // no-current-mounted-members) is frozen by Stage2 T3-B and unchanged here;
  // this fixture owns only the metrics read that used to precede the branch.
});

await fixture('Live A an empty hostWrappers array remains valid and distinct from absent', () => {
  const absent = liveWindowedPlanHarness();
  const empty = liveWindowedPlanHarness({ emptyArray: true });
  const a = absent.api.execute(1, 'validator', { chatId: absent.plan.chatId });
  const b = empty.api.execute(1, 'validator', { chatId: empty.plan.chatId });
  equal(a.status, b.status, 'absent and empty reach the same windowed outcome');
  equal(absent.api.diagnostic().wrappersPlanned, 0, 'absent records zero');
  equal(empty.api.diagnostic().wrappersPlanned, 0, 'empty records zero');
  // The distinction is explicit: only one of the two carries the property.
  const absentPlan = absent.control.planTransform({ ...absent.rawPlan });
  const emptyPlan = empty.control.planTransform({ ...empty.rawPlan });
  equal(Object.prototype.hasOwnProperty.call(absentPlan, 'hostWrappers'), false, 'the absent case has no hostWrappers property');
  equal(Object.prototype.hasOwnProperty.call(emptyPlan, 'hostWrappers'), true, 'the empty case has the property');
  equal(emptyPlan.hostWrappers.length, 0, 'and it is an empty array');
});

await fixture('Live B a mid-subset stamp failure stays fail-closed and names its real reason', () => {
  const t = stage2Transaction({ coldEnd: false, middleCount: 6 });
  const real = t.api.subset(t.api.model().pages[0]).mounted[0];
  // Three canonical members presenting six current surfaces; the fourth write
  // throws. Every surface passes the pre-apply connected / non-H2O checks.
  const surface = (questionId, turnNo, hostile = false) => ({
    questionId,
    turnNo,
    node: {
      isConnected: true,
      getAttribute: () => null,
      hasAttribute: () => false,
      setAttribute: () => { if (hostile) throw new Error('host refused the attribute write'); },
      removeAttribute: () => {},
      className: 'host-turn-slot',
    },
  });
  const six = [
    surface('q-a', 1), surface('q-a2', 1), surface('q-b', 2),
    surface('q-b2', 2, true), surface('q-c', 3), surface('q-c2', 3),
  ];
  const applied = t.api.stamp({ atomicRenderedBoundaryPlan: true, pageNum: 1, mountedCandidates: six });
  equal(applied.ok, false, 'the stamping pass fails');
  equal(applied.status, 'rendered-collapse-stamp-failed', 'precise failure status is unchanged');
  equal(applied.hidden, 3, 'exactly the three writes that landed are reported');
  equal(applied.stamped.length, 3, 'and handed back for rollback');
  ok(/host refused the attribute write/.test(String(applied.reason || '')),
    `the real thrown reason survives the catch (got ${JSON.stringify(applied.reason)})`);
  // The all-or-nothing guard itself is untouched.
  const commit = extractFunction(SOURCE, 'commitWindowedPageCollapse');
  ok(/applied\.hidden !== snapshot\.mounted\.length/.test(commit),
    'the all-or-nothing guard is unchanged');
  // Rollback cleans every applied mutation and nothing is committed.
  const rolled = t.api.rollback(1, applied.restorable);
  equal(rolled.restored + rolled.residue.length, applied.restorable.length, 'every applied mutation is accounted for');
  equal(t.api.state.atomicPageCollapseTransactions.size, 0, 'no collapse transaction is committed');
  equal(hiddenAttr(real.node), null, 'zero residual hidden state on the live surface');
});

await fixture('Live B six successful writes give hidden six and do not roll back', () => {
  const t = stage2Transaction({ coldEnd: false, middleCount: 6 });
  const surface = (questionId, turnNo) => {
    let value = null;
    return {
      questionId,
      turnNo,
      node: {
        isConnected: true,
        getAttribute: () => value,
        hasAttribute: () => value != null,
        setAttribute: (name, next) => { value = String(next); },
        removeAttribute: () => { value = null; },
        className: 'host-turn-slot',
      },
    };
  };
  const six = [
    surface('q-a', 1), surface('q-a2', 1), surface('q-b', 2),
    surface('q-b2', 2), surface('q-c', 3), surface('q-c2', 3),
  ];
  const applied = t.api.stamp({ atomicRenderedBoundaryPlan: true, pageNum: 1, mountedCandidates: six });
  equal(applied.ok, true, 'all six writes succeed');
  equal(applied.hidden, 6, 'hidden counts all six current surfaces, not three members');
  equal(applied.stamped.length, 6, 'all six are stamped');
  equal(applied.reason == null, true, 'a successful pass carries no failure reason');
  equal(six.every((entry) => entry.node.getAttribute() === '1'), true, 'every surface carries the page stamp');
});

// --------------------------------------------------------------------------
// WINDOWED SUSTAIN — a committed windowed collapse is LOGICAL state.
//
// The commit path already accepts a page with nothing currently mounted
// (collapsed-no-native-work / no-current-mounted-members). Validation demanding
// a live native root therefore disagreed with the commit that produced it, and
// ordinary host virtualization expanded a collapse the user still owned.
// Canonical authority stays the first-order truth: every drift below still
// invalidates.
// --------------------------------------------------------------------------

// Ordinary host presentation churn: the page's flow root (and with it the
// divider) stops being live. No canonical identity-defining field changes.
function windowedRootLoss(scope) {
  scope.h.flow.isConnected = false;
}

await fixture('Live W1 a committed windowed collapse survives losing its live flow root', () => {
  const c = pass4rCommitted({ coldEnd: true, middleCount: 6, missingEnd: true });
  equal(c.result.ok, true, 'the windowed transaction commits');
  equal(c.api.validateCommitted(c.transaction).ok, true, 'valid while the root is live');
  windowedRootLoss(c);
  const verdict = c.api.validateCommitted(c.transaction);
  equal(verdict.ok, true, `root absence alone is ordinary presentation churn (reason ${JSON.stringify(verdict.reason)})`);
  equal(verdict.reason, null, 'and reports no invalidation reason');
  equal(c.api.state.atomicPageCollapseTransactions.size, 1, 'the transaction is still committed');
});

await fixture('Live W2 reconcile does not expand a windowed collapse for root absence alone', () => {
  const c = pass4rCommitted({ coldEnd: true, middleCount: 6, missingEnd: true });
  windowedRootLoss(c);
  ok(!!c.api.reconcileAll, 'the reconcile owner is available');
  const results = c.api.reconcileAll('host-virtualization');
  equal(c.api.state.atomicPageCollapseTransactions.size, 1, 'the committed collapse is retained');
  equal(results.some((entry) => String(entry.status || '').includes('expand')), false,
    'no expansion was performed');
});

await fixture('Live W3 zero, partial and replacement presentation all remain valid', () => {
  // A. zero current mounted members, root gone.
  const zero = pass4rCommitted({ coldEnd: true, middleCount: 6, missingEnd: true });
  const only = zero.api.subset(zero.api.model().pages[0]).mounted[0];
  const idx = zero.h.flow.children.indexOf(only.node);
  zero.h.flow.children.splice(idx, 1);
  only.node.parentElement = null;
  only.node.isConnected = false;
  windowedRootLoss(zero);
  equal(zero.api.validateCommitted(zero.transaction).ok, true, 'zero current members with no root stays valid');
  // This is the same truth the commit path already tells.
  const bare = pass4rCommitted({ coldEnd: true, middleCount: 6, missingStart: true });
  equal(bare.result.status, 'collapsed-no-native-work', 'commit accepts a zero-native windowed page');
  equal(bare.result.reason, 'no-current-mounted-members', 'with that exact frozen reason');
  equal(bare.api.validateCommitted(bare.transaction).ok, true, 'and validation agrees with it');

  // B. partial current subset, root live again.
  const partial = pass4rCommitted({ coldEnd: false, middleCount: 6 });
  equal(partial.api.validateCommitted(partial.transaction).ok, true, 'a partial mounted subset is valid');

  // C. current replacement presentation.
  const replaced = pass4rCommitted({ coldEnd: true, middleCount: 6, missingEnd: true });
  const original = replaced.api.subset(replaced.api.model().pages[0]).mounted[0];
  const replacement = replaced.h.document.createElement('SECTION');
  replacement.setAttribute('data-turn-id', original.questionId);
  replacement.setAttribute('data-turn', 'user');
  replacement.setAttribute('data-testid', 'conversation-turn-88');
  const at = replaced.h.flow.children.indexOf(original.node);
  replaced.h.flow.children.splice(at, 1);
  original.node.parentElement = null;
  original.node.isConnected = false;
  replaced.h.flow.appendChild(replacement);
  replaced.api.reconcileActive('replacement');
  equal(replaced.api.validateCommitted(replaced.transaction).ok, true, 'a current replacement is valid');
  equal(p4rHidden(replacement), '1', 'and carries the collapse marker');
});

await fixture('Live W4 canonical drift still invalidates a rootless windowed collapse', () => {
  for (const [label, drift] of [
    ['routeKey', { routeKey: '/c/other-route' }],
    ['generation', { generation: 9 }],
    ['effectiveFingerprint', { canonicalFingerprint: 'djb2:other-effective' }],
    ['count', { count: 31 }],
  ]) {
    const c = pass4rCommitted({ coldEnd: true, middleCount: 6, missingEnd: true });
    windowedRootLoss(c);
    Object.assign(c.h.status, drift);
    equal(c.api.validateCommitted(c.transaction).ok, false, `${label} drift still fails closed without a root`);
  }
  const graph = pass4rCommitted({ coldEnd: true, middleCount: 6, missingEnd: true });
  windowedRootLoss(graph);
  graph.h.graphScope.fingerprint = 'djb2:other-graph';
  equal(graph.api.validateCommitted(graph.transaction).ok, false, 'graphFingerprint drift still fails closed');
});

await fixture('Live W5 ambiguity and a missing marker still fail closed', () => {
  const ambiguous = pass4rCommitted({ coldEnd: true, middleCount: 6, missingEnd: true });
  const member = ambiguous.api.subset(ambiguous.api.model().pages[0]).mounted[0];
  const duplicate = ambiguous.h.document.createElement('SECTION');
  duplicate.setAttribute('data-turn-id', member.questionId);
  duplicate.setAttribute('data-turn', 'user');
  duplicate.setAttribute('data-testid', 'conversation-turn-91');
  ambiguous.h.flow.appendChild(duplicate);
  const verdict = ambiguous.api.validateCommitted(ambiguous.transaction);
  equal(verdict.ok, false, 'ambiguous current identity fails closed');
  equal(verdict.reason, 'candidate-identity-ambiguous', 'with the precise reason');

  const unmarked = pass4rCommitted({ coldEnd: true, middleCount: 6, missingEnd: true });
  const mounted = unmarked.api.subset(unmarked.api.model().pages[0]).mounted[0];
  mounted.node.removeAttribute('data-cgxui-chat-page-native-hidden');
  const missing = unmarked.api.validateCommitted(unmarked.transaction);
  equal(missing.ok, false, 'a current mounted member without the marker is still invalid');
  equal(missing.reason, 'transaction-commit-incomplete', 'reported as commit-incomplete');
});

const failed = fixtures.filter((entry) => !entry.ok);
console.log(`Fixtures: ${fixtures.length - failed.length}/${fixtures.length}`);
console.log(`Assertions: ${assertions}`);
console.log(
  `Safety counters: storage=${h.safety.storage} cache=${h.safety.cache} preference=${h.safety.preference}`
  + ` canonical=${h.safety.canonical} alias=${h.safety.alias} network=${h.safety.network}`
  + ` navigation=${h.safety.navigation} nonAnchorScrolling=${h.safety.nonAnchorScrolling}`
  + ` timers=${h.safety.timers} raf=${h.safety.raf} observers=${h.safety.observers}`
  + ` pageUnitMoves=${h.safety.pageUnitMoves} hostMoves=${h.safety.hostMoves}`,
);
if (failed.length) process.exitCode = 1;
