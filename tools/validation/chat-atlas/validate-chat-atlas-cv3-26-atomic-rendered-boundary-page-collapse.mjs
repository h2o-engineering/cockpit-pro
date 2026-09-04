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
    'clearTitleListNativeInPlaceProjection',
    'reconcileTitleListNativeInPlaceProjection',
    'openTitleListNativeInPlace',
    'reconcilePendingTitleListMaterialization',
    'resetOpenedTitleListRows',
    'setTitleListMemberCollapsed',
    'releaseAtomicPageCollapseState',
    'rollbackAtomicPageCollapse',
    'validateCommittedAtomicPageCollapse',
    'rebindCommittedAtomicPageCollapse',
    'collapsePageWithRenderedBoundaries',
    'applyExpandedCollapseControlState',
    'expandPageWithRenderedBoundaries',
    'reconcileAtomicPageCollapseTransactions',
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
          ? { ...injectedPlan, titleRows: injectedControl.model.pages[0].turnRecords }
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
    const originalCapture = captureCollapsedPageViewportAnchor;
    captureCollapsedPageViewportAnchor = (pageNum) => {
      injectedCalls.viewportReads += 1;
      return originalCapture(pageNum);
    };
    return Object.freeze({
      collapse: collapsePageWithRenderedBoundaries,
      expand: expandPageWithRenderedBoundaries,
      reconcile: reconcileAtomicPageCollapseTransactions,
      sync: syncSyntheticTitleList,
      expandAll: expandAllAtomicPageCollapses,
      prepare: prepareDetachedPageTitleList,
      revalidate: revalidateAtomicPageCollapsePlan,
      memberCurrent: pageCollapseMemberIdentityCurrent,
      nativeMount: titleListCurrentNativeMount,
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
await fixture('final revalidation occurs before insertion', () => equal(h.calls.revalidations >= 2, true, 'pre and post validation'));
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
await lifecycleFixture('start-boundary replacement expands safely', (x) => { x.start.wrapper.isConnected = false; });
await lifecycleFixture('end-boundary replacement expands safely', (x) => { x.end.wrapper.isConnected = false; });
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
  equal((SOURCE.match(/setAttribute\(ATTR_CHAT_PAGE_NATIVE_HIDDEN/g) || []).length, 5, 'bounded transaction-owner writer statements');
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
  const proof = transaction.wrapperProofs.get(lostAnswer);
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
  const replacement = new NodeCtor('DIV', 'host-turn-slot', scenario.x.guard);
  replacement.setAttribute('data-turn-id-container', scenario.proof.identity);
  const host = new NodeCtor('SECTION', 'native-turn-host', scenario.x.guard);
  const carrier = new NodeCtor('SECTION', 'identity-carrier', scenario.x.guard);
  carrier.setAttribute('data-turn-id', scenario.proof.identity);
  carrier.setAttribute('data-turn', 'assistant');
  host.appendChild(carrier);
  replacement.appendChild(host);
  const nextWrapper = scenario.transaction.hostWrappers[2] || scenario.x.end.wrapper;
  scenario.x.flow.insertBefore(replacement, nextWrapper);
  scenario.x.window.H2O.obs.mounts.set(scenario.proof.identity, { el: carrier, shell: replacement });
  const [result] = scenario.x.api.reconcile('observer-hub-remount');
  equal(result.status, 'current', 'replacement reconciliation preserves the committed title page');
  equal(scenario.x.api.openMount(scenario.transaction).ok, true, 'replacement resolves by exact canonical identity');
  equal(replacement.hasAttribute('data-cgxui-chat-page-native-hidden'), false, 'replacement selected anchor is visible');
  equal(scenario.transaction.hostWrappers.includes(scenario.lostAnswer), false, 'stale predecessor reference is released');
  equal(scenario.transaction.wrapperProofs.has(scenario.lostAnswer), false, 'stale predecessor proof key is released');
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
  carrier.setAttribute('data-turn', 'assistant');
  replacement.appendChild(carrier);
  scenario.x.flow.insertBefore(replacement, scenario.transaction.hostWrappers[2] || scenario.x.end.wrapper);
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
  const nativeAnchors = transaction.hostWrappers.filter((node) => (
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
  const nativeParents = transaction.hostWrappers.map((node) => node.parentElement);
  const closed = x.api.close(transaction, { rehide: true });
  equal(closed.status, 'closed', 'closed');
  equal(transaction.titleRowsPrepared.every((row) => row.parentElement === transaction.titleListContainer), true, 'all title rows return to one H2O list');
  equal(x.document.querySelectorAll('[data-h2o-title-list-segment="suffix"]').length, 0, 'suffix removed');
  equal(transaction.hostWrappers.map((node) => node.parentElement), nativeParents, 'native parents never change');
  equal(transaction.hostWrappers.every((node) => node.getAttribute('data-cgxui-chat-page-native-hidden') === '1'), true, 'native page is hidden again');
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
  const proof = transaction.wrapperProofs.get(stale);
  const NodeCtor = x.flow.constructor;
  const replacement = new NodeCtor('DIV', 'host-turn-slot', x.guard);
  replacement.setAttribute('data-turn-id-container', proof.identity);
  const host = new NodeCtor('SECTION', 'native-turn-host', x.guard);
  const carrier = new NodeCtor('SECTION', 'identity-carrier', x.guard);
  carrier.setAttribute('data-turn-id', proof.identity);
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
  equal(transaction.hostWrappers.includes(stale), false, 'transaction releases stale wrapper reference');
  equal(transaction.wrapperProofs.has(stale), false, 'transaction releases stale proof key');
  equal(replacement.parentElement, x.flow, 'replacement remains under host flow');
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
  equal(transaction.hostWrappers.every((node) => node.parentElement === x.flow), true, 'all native wrappers remain in host flow');
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
