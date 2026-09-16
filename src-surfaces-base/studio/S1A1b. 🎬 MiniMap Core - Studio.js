// ==UserScript==
// @h2o-id             s1a1b.minimap.core.studio
// @name               S1A1b. 🎬 MiniMap Core - Studio
// @namespace          H2O.Premium.CGX.minimap.core
// @author             HumamDev
// @version            12.8.0
// @revision           007
// @build              260412-000003
// @description        MiniMap Core: state/index/rebuild/registry authority
// @match              https://chatgpt.com/*
// @run-at             document-idle
// @grant              none
// ==/UserScript==

(() => {
  'use strict';

  const W = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;
  const TOPW = W.top || W;
  const H2O = (TOPW.H2O = TOPW.H2O || {});
  if (W !== TOPW) W.H2O = H2O;
  const STUDIO_SEL = W.H2O.Studio.SELECTORS;
  H2O.perf = H2O.perf || {};
  H2O.perf.modules = H2O.perf.modules || Object.create(null);
  const PERF_MODULE = (H2O.perf.modules.miniMapCoreUi && typeof H2O.perf.modules.miniMapCoreUi === 'object')
    ? H2O.perf.modules.miniMapCoreUi
    : (H2O.perf.modules.miniMapCoreUi = Object.create(null));
  const PERF = (() => {
    const existing = PERF_MODULE.__h2oPerfState;
    if (existing && typeof existing === 'object') return existing;
    const next = createMiniMapCoreUiPerfState();
    try {
      Object.defineProperty(PERF_MODULE, '__h2oPerfState', {
        value: next,
        configurable: true,
        writable: true,
      });
    } catch {
      PERF_MODULE.__h2oPerfState = next;
    }
    return next;
  })();
  ensureMiniMapCoreUiPerfStateShape(PERF);
  PERF_MODULE.getStats = getMiniMapCoreUiPerfStats;
  PERF_MODULE.resetStats = () => {
    resetMiniMapCoreUiPerfState(PERF);
    return getMiniMapCoreUiPerfStats();
  };

  // Kernel-authoritative bridge access (no fallbacks here; util.mm decides)
  const MM = () => (TOPW.H2O_MM_SHARED?.get?.() || null)?.util?.mm || null;
  const MM_core = () => MM()?.core?.() || null;
  const MM_ui = () => MM()?.ui?.() || null;
  const MM_rt = () => MM()?.rt?.() || null;
  const MM_behavior = () => (TOPW.H2O_MM_SHARED?.get?.() || null)?.util?.behavior || null;
  const MM_uiRefs = () => MM()?.uiRefs?.() || (MM_ui()?.getRefs?.() || {});


/* Phase 1 compatibility seam for 1A2c Chat Pages Controller */
function getChatPagesControllerApi() {
  try {
    return TOPW.H2O_MM_SHARED?.get?.()?.api?.mm?.chatPagesCtl || null;
  } catch {
    return null;
  }
}

function callChatPagesCtl(methodName, args, fallbackFn) {
  const api = getChatPagesControllerApi();
  const fn = api && typeof api[methodName] === 'function' ? api[methodName] : null;
  if (fn) {
    try {
      return fn(...(Array.isArray(args) ? args : []));
    } catch (err) {
      try { console.warn('[MiniMap Core] chatPagesCtl delegation failed:', methodName, err); } catch {}
    }
  }
  return typeof fallbackFn === 'function'
    ? fallbackFn(...(Array.isArray(args) ? args : []))
    : false;
}

function AT_PUBLIC() {
  try {
    return TOPW.H2O?.AT?.tnswrttl?.api?.public || null;
  } catch {
    return null;
  }
}

function UM_PUBLIC() {
  try {
    return TOPW.H2O?.UM?.nmntmssgs?.api || null;
  } catch {
    return null;
  }
}

  const CORE_VER = '12.6.22';
  const MAX_TRIES = 80;
  const GAP_MS = 120;
  const REBUILD_FALLBACK_MS = 180;

  const S = {
    inited: false,
    installTries: 0,
    installTimer: null,
    rebuildTimer: null,
    rebuildRaf: 0,
    rebuildToken: 0,
    rebuildReason: '',
    turnList: [],
    turnById: new Map(),
    turnIdByAId: new Map(),
    answerByTurnId: new Map(),
    answerEls: [],
    mapButtons: null,
    emptyRetryTimer: null,
    emptyRetryCount: 0,
    retryTimer: null,
    retryCount: 0,
    retryKind: '',
    retryReason: '',
    rebuildInFlight: false,
    rebuildQueuedReason: '',
    lastRebuildResult: null,
    lastActiveIndex: 0,
    gutterSyncQueue: new Map(),
    gutterSyncRaf: 0,
    marginSymbolsBridgeBound: false,
    marginSymbolsBridgeOff: null,
    washBridgeBound: false,
    washBridgeOff: null,
    viewBridgeBound: false,
    viewBridgeOff: null,
    washRepaintQueue: new Set(),
    washRepaintRaf: 0,
    washRepaintAll: false,
    washBridgeLastSig: '',
    washBridgeLastTs: 0,
    qWashStoreRaw: '',
    qWashStore: Object.create(null),
    lastAppliedViewMode: '',
    lastActiveBtnEl: null,
    lastActiveTurnIdFast: '',
    lastActiveBtnId: '',
    perfFullScanTick: 0,
    perfRebuildWindowTs: 0,
    perfRebuildTriggerCount: 0,
    selectedMiniDividerId: '',
    dividerDrag: null,
    collapsedMiniMapPagesByChat: new Map(),
    collapsedChatPagesByChat: new Map(),
    titleListChatPagesByChat: new Map(),
    chatPageStatusCardEl: null,
    chatPageStatusCardAnchor: null,
  };

  const PERF_SCOPE = {
    fullRenderDepth: 0,
    incrementalDepth: 0,
    dividerDepth: 0,
  };

  const UI_TOK = Object.freeze({
    OWNER: 'mnmp',
    COL: 'mnmp-col',
    WRAP: 'mnmp-wrap',
    BTN: 'mnmp-btn',
    QBTN: 'mnmp-qbtn',
    DIVIDER_LAYER: 'mnmp-divider-layer',
    DIVIDER: 'mnmp-divider',
    COL_LEGACY: 'mm-col',
    WRAP_LEGACY: 'mm-wrap',
    BTN_LEGACY: 'mm-btn',
    QBTN_LEGACY: 'mm-qbtn',
  });
  const EMPTY_RETRY_MAX = 8;
  const EMPTY_RETRY_GAP_MS = 180;
  const COLOR_BY_NAME = Object.freeze({
    blue: '#3A8BFF',
    red: '#FF4A4A',
    green: '#31D158',
    gold: '#FFD700',
    sky: '#4CD3FF',
    pink: '#FF71C6',
    purple: '#A36BFF',
    orange: '#FFA63A',
  });
  const EV_MARGIN_SYMBOLS_CHANGED = 'evt:h2o:margin:symbols:changed';
  const EV_VIEW_CHANGED = 'evt:h2o:minimap:view-changed';
  const CLS_HIDE_QWASH = 'cgx-mm-hide-qwash';
  const EV_WASH_CHANGED = Object.freeze([
    'evt:h2o:mm:wash_changed',
    'h2o:mm:wash_changed',
    'evt:h2o:wash:changed',
    'h2o:wash:changed',
    'evt:h2o:answer:wash',
    'h2o:answer:wash',
  ]);
  const FLASH_CLS = Object.freeze({
    WASH_WRAP: 'cgxui-mnmp-wash-wrap',
    WASH_WRAP_LEGACY: 'cgxui-wash-wrap',
    FLASH: 'cgxui-mnmp-flash',
    FLASH_LEGACY: 'cgxui-flash',
  });
  const KEY_MARGIN_SYMBOLS_FALLBACK = 'h2o:prm:cgx:mrgnnchr:symbols:v1';
  const KEY_MARGIN_SYMBOL_COLORS_FALLBACK = 'h2o:prm:cgx:mrgnnchr:symbols_colors:v1';
  const KEY_MARGIN_PINS_FALLBACK = 'h2o:prm:cgx:mrgnnchr:state:pins:v1';
  const KEY_QWASH_FALLBACK = 'h2o:qwash:map:v1';
  const KEY_CUSTOM_DIVIDERS_SUFFIX = 'state:custom_dividers:chat';
  const KEY_COLLAPSED_PAGES_SUFFIX = 'ui:collapsed_pages:chat';
  const KEY_TURN_CACHE_META_SUFFIX = 'state:turn_cache_meta:chat';
  const KEY_TURN_CACHE_TURNS_SUFFIX = 'state:turn_cache:chat';
  const KEY_PAGE_LABEL_STYLE_SUFFIX = 'ui:page-label-style:v1';
  const KEY_PAGE_DIVIDERS_SUFFIX = 'ui:page-dividers:v1';
  const KEY_CHAT_PAGE_DIVIDERS_SUFFIX = 'ui:chat-pages:v1';
  const EV_PAGE_CHANGED = 'evt:h2o:pagination:pagechanged';
  const EV_MM_INDEX_HYDRATED = 'evt:h2o:minimap:index:hydrated';
  const EV_MM_INDEX_APPENDED = 'evt:h2o:minimap:index:appended';
  const EV_MM_DIVIDER_CHANGED = 'evt:h2o:minimap:divider:changed';
  const EV_MM_DIVIDER_SELECTED = 'evt:h2o:minimap:divider:selected';
  const ATTR_PAGE_LABEL_STYLE = 'data-cgxui-page-label-style';
  const ATTR_PAGE_DIVIDERS = 'data-cgxui-page-dividers';
  const ATTR_CHAT_PAGE_DIVIDERS = 'data-cgxui-chat-pages';
  const ATTR_CHAT_PAGE_DIVIDER = 'data-cgxui-chat-page-divider';
  const ATTR_CHAT_PAGE_NUM = 'data-cgxui-chat-page-num';
  const ATTR_CHAT_PAGE_COLLAPSED = 'data-cgxui-chat-page-collapsed';
  const ATTR_CHAT_PAGE_HIDDEN = 'data-cgxui-chat-page-hidden';
  const ATTR_CHAT_PAGE_TITLE_LIST = 'data-cgxui-chat-page-title-list';
  const ATTR_CHAT_PAGE_TITLE_STATE = 'data-cgxui-chat-page-title-state';
  const ATTR_CHAT_PAGE_QUESTION_HIDDEN = 'data-cgxui-chat-page-question-hidden';
  const PAGE_LABEL_STYLE_DEFAULT = 'pill';
  const PAGE_LABEL_STYLE_PILL = 'pill';

  // Manual divider: user-created, draggable MiniMap divider edited from Quick Controls.
  const MINI_DIVIDER_DEFAULT_COLOR = '#facc15';                 // 👈 new divider default color
  const MINI_DIVIDER_LAYOUT = Object.freeze({
    GAP_CENTER_RATIO: 0.5,                                      // 👈 base target inside each gap; 0.5 = center, lower = higher, higher = lower
    UPPER_BOX_CLEARANCE_PX: 0,                                  // 👈 minimum space kept below the upper box before the divider center can sit
    LOWER_BOX_CLEARANCE_PX: 0,                                  // 👈 minimum space kept above the lower box so the divider stays visually detached from its top edge
  });

  const PERF_ASSERT_ON = (() => {
    try { return String(localStorage.getItem('h2o:perf') || '') === '1'; } catch { return false; }
  })();

  function perfNow() {
    const n = Number(W.performance?.now?.() || Date.now());
    return Number.isFinite(n) ? n : 0;
  }

  function perfRoundMs(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) return null;
    return Math.round(n * 1000) / 1000;
  }

  function createDurationBucket() {
    return {
      count: 0,
      totalMs: 0,
      maxMs: 0,
      slowOver4Count: 0,
      slowOver8Count: 0,
      slowOver16Count: 0,
      slowOver50Count: 0,
    };
  }

  function createSummaryBucket() {
    return Object.assign(createDurationBucket(), {
      beforeBootCount: 0,
      afterBootCount: 0,
      lastReason: '',
      lastAt: 0,
    });
  }

  function createRenderUnitsBucket() {
    return {
      answerRows: 0,
      answerButtons: 0,
      questionButtons: 0,
      miniPageDividers: 0,
      overlayDividers: 0,
      chatPageDividers: 0,
      gutterSymbols: 0,
      washRepaints: 0,
      activeStateUpdates: 0,
      collapseVisualUpdates: 0,
      counterUpdates: 0,
      lastRenderUnit: '',
      lastAt: 0,
    };
  }

  function createNodeLifecycleBucket() {
    return {
      created: Object.create(null),
      reused: Object.create(null),
      removed: Object.create(null),
      repaired: Object.create(null),
      noOp: Object.create(null),
      lastAction: '',
      lastUnit: '',
      lastAt: 0,
    };
  }

  function createMiniMapCoreUiPerfState() {
    return {
      bootCompletedAt: 0,
      fullRender: Object.assign(createSummaryBucket(), {
        branches: Object.create(null),
      }),
      incrementalRefresh: Object.assign(createSummaryBucket(), {
        appendTurnStatuses: Object.create(null),
      }),
      dividerUi: Object.assign(createSummaryBucket(), {
        createdCount: 0,
        reusedCount: 0,
        removedCount: 0,
      }),
      domWriteCluster: createSummaryBucket(),
      renderUnits: createRenderUnitsBucket(),
      nodeLifecycle: createNodeLifecycleBucket(),
      paths: {
        ensureTurnButtons: createDurationBucket(),
        renderFromCache: createDurationBucket(),
        appendTurnFromAnswerEl: createDurationBucket(),
        syncTurnRowDom: createDurationBucket(),
        ensureQuestionBtnForWrap: createDurationBucket(),
        applyMiniMapPageUiPrefs: createDurationBucket(),
        applyMiniMapPageCollapsedState: createDurationBucket(),
        applyAllMiniMapPageCollapsedStates: createDurationBucket(),
        flushWashRepaintQueue: createDurationBucket(),
        flushMiniMapGutterQueue: createDurationBucket(),
        setActive: createDurationBucket(),
        updateToggleColor: createDurationBucket(),
        updateCounter: createDurationBucket(),
        renderMiniDividerOverlay: createDurationBucket(),
        renderChatPageDividers: createDurationBucket(),
      },
    };
  }

  function ensureMiniMapCoreUiPerfStateShape(target) {
    if (!target || typeof target !== 'object') return target;
    if (!target.paths || typeof target.paths !== 'object') target.paths = createMiniMapCoreUiPerfState().paths;
    if (!target.renderUnits || typeof target.renderUnits !== 'object') target.renderUnits = createRenderUnitsBucket();
    if (!target.nodeLifecycle || typeof target.nodeLifecycle !== 'object') target.nodeLifecycle = createNodeLifecycleBucket();
    if (!target.fullRender || typeof target.fullRender !== 'object') target.fullRender = Object.assign(createSummaryBucket(), { branches: Object.create(null) });
    if (!target.fullRender.branches || typeof target.fullRender.branches !== 'object') target.fullRender.branches = Object.create(null);
    if (!target.incrementalRefresh || typeof target.incrementalRefresh !== 'object') target.incrementalRefresh = Object.assign(createSummaryBucket(), { appendTurnStatuses: Object.create(null) });
    if (!target.incrementalRefresh.appendTurnStatuses || typeof target.incrementalRefresh.appendTurnStatuses !== 'object') target.incrementalRefresh.appendTurnStatuses = Object.create(null);
    if (!target.dividerUi || typeof target.dividerUi !== 'object') target.dividerUi = Object.assign(createSummaryBucket(), { createdCount: 0, reusedCount: 0, removedCount: 0 });
    if (!target.domWriteCluster || typeof target.domWriteCluster !== 'object') target.domWriteCluster = createSummaryBucket();
    return target;
  }

  function recordDuration(bucket, msRaw) {
    if (!bucket) return 0;
    const ms = Number(msRaw);
    if (!Number.isFinite(ms) || ms < 0) return 0;
    bucket.count = Number(bucket.count || 0) + 1;
    bucket.totalMs = Number(bucket.totalMs || 0) + ms;
    bucket.maxMs = Math.max(Number(bucket.maxMs || 0), ms);
    if (ms > 4) bucket.slowOver4Count = Number(bucket.slowOver4Count || 0) + 1;
    if (ms > 8) bucket.slowOver8Count = Number(bucket.slowOver8Count || 0) + 1;
    if (ms > 16) bucket.slowOver16Count = Number(bucket.slowOver16Count || 0) + 1;
    if (ms > 50) bucket.slowOver50Count = Number(bucket.slowOver50Count || 0) + 1;
    return ms;
  }

  function bumpCounter(obj, key, delta = 1) {
    if (!obj) return 0;
    const k = String(key || '');
    obj[k] = Number(obj[k] || 0) + Number(delta || 0);
    return obj[k];
  }

  function bumpReason(obj, key) {
    const reason = String(key || '').trim() || 'unknown';
    return bumpCounter(obj, reason);
  }

  function copyPlainCounts(obj) {
    const out = Object.create(null);
    for (const key of Object.keys(obj || {})) out[key] = Number(obj[key] || 0);
    return out;
  }

  function readDurationBucket(bucket) {
    const count = Number(bucket?.count || 0);
    const totalMs = Number(bucket?.totalMs || 0);
    return {
      count,
      totalMs: perfRoundMs(totalMs) ?? 0,
      avgMs: count > 0 ? perfRoundMs(totalMs / count) : null,
      maxMs: count > 0 ? perfRoundMs(bucket?.maxMs || 0) : null,
      slowOver4Count: Number(bucket?.slowOver4Count || 0),
      slowOver8Count: Number(bucket?.slowOver8Count || 0),
      slowOver16Count: Number(bucket?.slowOver16Count || 0),
      slowOver50Count: Number(bucket?.slowOver50Count || 0),
    };
  }

  function readSummaryBucket(bucket) {
    return Object.assign(readDurationBucket(bucket), {
      beforeBootCount: Number(bucket?.beforeBootCount || 0),
      afterBootCount: Number(bucket?.afterBootCount || 0),
      lastReason: String(bucket?.lastReason || ''),
      lastAt: Number(bucket?.lastAt || 0),
    });
  }

  function currentPerfPhase() {
    return Number(PERF.bootCompletedAt || 0) > 0 ? 'afterBoot' : 'beforeBoot';
  }

  function noteSummaryBucket(bucket, reason = '') {
    if (!bucket) return;
    if (currentPerfPhase() === 'afterBoot') bucket.afterBootCount = Number(bucket.afterBootCount || 0) + 1;
    else bucket.beforeBootCount = Number(bucket.beforeBootCount || 0) + 1;
    bucket.lastReason = String(reason || '');
    bucket.lastAt = Date.now();
  }

  function enterPerfOwner(kind) {
    if (kind === 'fullRender') {
      const owned = PERF_SCOPE.fullRenderDepth === 0;
      PERF_SCOPE.fullRenderDepth += 1;
      return owned;
    }
    if (kind === 'incremental') {
      const owned = PERF_SCOPE.fullRenderDepth === 0 && PERF_SCOPE.dividerDepth === 0 && PERF_SCOPE.incrementalDepth === 0;
      PERF_SCOPE.incrementalDepth += 1;
      return owned;
    }
    if (kind === 'divider') {
      const owned = PERF_SCOPE.fullRenderDepth === 0 && PERF_SCOPE.incrementalDepth === 0 && PERF_SCOPE.dividerDepth === 0;
      PERF_SCOPE.dividerDepth += 1;
      return owned;
    }
    return false;
  }

  function exitPerfOwner(kind) {
    if (kind === 'fullRender') PERF_SCOPE.fullRenderDepth = Math.max(0, PERF_SCOPE.fullRenderDepth - 1);
    else if (kind === 'incremental') PERF_SCOPE.incrementalDepth = Math.max(0, PERF_SCOPE.incrementalDepth - 1);
    else if (kind === 'divider') PERF_SCOPE.dividerDepth = Math.max(0, PERF_SCOPE.dividerDepth - 1);
  }

  function noteRenderUnit(unit, delta = 1) {
    if (!unit) return 0;
    const next = bumpCounter(PERF.renderUnits, unit, delta);
    PERF.renderUnits.lastRenderUnit = String(unit);
    PERF.renderUnits.lastAt = Date.now();
    return next;
  }

  function noteNodeLifecycle(kind, unit, delta = 1) {
    const bucket = PERF.nodeLifecycle?.[kind];
    if (!bucket || !unit) return 0;
    const next = bumpCounter(bucket, unit, delta);
    PERF.nodeLifecycle.lastAction = String(kind || '');
    PERF.nodeLifecycle.lastUnit = String(unit || '');
    PERF.nodeLifecycle.lastAt = Date.now();
    return next;
  }

  function resetMiniMapCoreUiPerfState(target) {
    if (!target) return target;
    const bootCompletedAt = Number(target.bootCompletedAt || 0) > 0 ? Number(target.bootCompletedAt || 0) : 0;
    const next = createMiniMapCoreUiPerfState();
    next.bootCompletedAt = bootCompletedAt;
    Object.keys(next).forEach((key) => { target[key] = next[key]; });
    return target;
  }

  function getMiniMapCoreUiPerfStats() {
    ensureMiniMapCoreUiPerfStateShape(PERF);
    const paths = Object.create(null);
    for (const key of Object.keys(PERF.paths || {})) paths[key] = readDurationBucket(PERF.paths[key]);
    return {
      bootCompletedAt: Number(PERF.bootCompletedAt || 0),
      fullRender: Object.assign(readSummaryBucket(PERF.fullRender), {
        branches: copyPlainCounts(PERF.fullRender?.branches),
      }),
      incrementalRefresh: Object.assign(readSummaryBucket(PERF.incrementalRefresh), {
        appendTurnStatuses: copyPlainCounts(PERF.incrementalRefresh?.appendTurnStatuses),
      }),
      dividerUi: Object.assign(readSummaryBucket(PERF.dividerUi), {
        createdCount: Number(PERF.dividerUi?.createdCount || 0),
        reusedCount: Number(PERF.dividerUi?.reusedCount || 0),
        removedCount: Number(PERF.dividerUi?.removedCount || 0),
      }),
      domWriteCluster: readSummaryBucket(PERF.domWriteCluster),
      renderUnits: {
        answerRows: Number(PERF.renderUnits?.answerRows || 0),
        answerButtons: Number(PERF.renderUnits?.answerButtons || 0),
        questionButtons: Number(PERF.renderUnits?.questionButtons || 0),
        miniPageDividers: Number(PERF.renderUnits?.miniPageDividers || 0),
        overlayDividers: Number(PERF.renderUnits?.overlayDividers || 0),
        chatPageDividers: Number(PERF.renderUnits?.chatPageDividers || 0),
        gutterSymbols: Number(PERF.renderUnits?.gutterSymbols || 0),
        washRepaints: Number(PERF.renderUnits?.washRepaints || 0),
        activeStateUpdates: Number(PERF.renderUnits?.activeStateUpdates || 0),
        collapseVisualUpdates: Number(PERF.renderUnits?.collapseVisualUpdates || 0),
        counterUpdates: Number(PERF.renderUnits?.counterUpdates || 0),
        lastRenderUnit: String(PERF.renderUnits?.lastRenderUnit || ''),
        lastAt: Number(PERF.renderUnits?.lastAt || 0),
      },
      nodeLifecycle: {
        created: copyPlainCounts(PERF.nodeLifecycle?.created),
        reused: copyPlainCounts(PERF.nodeLifecycle?.reused),
        removed: copyPlainCounts(PERF.nodeLifecycle?.removed),
        repaired: copyPlainCounts(PERF.nodeLifecycle?.repaired),
        noOp: copyPlainCounts(PERF.nodeLifecycle?.noOp),
        lastAction: String(PERF.nodeLifecycle?.lastAction || ''),
        lastUnit: String(PERF.nodeLifecycle?.lastUnit || ''),
        lastAt: Number(PERF.nodeLifecycle?.lastAt || 0),
      },
      paths,
    };
  }

  function warn(msg, extra) { try { console.warn('[MiniMap Core]', msg, extra || ''); } catch {} }

  function getRegs() {
    const SH = TOPW.H2O_MM_SHARED?.get?.();
    const SEL = SH?.SEL_ || SH?.registries?.SEL || W?.H2O?.SEL || {};
    return { SH, SEL };
  }

  function q(sel, root = document) {
    try { return sel ? root.querySelector(sel) : null; } catch { return null; }
  }

  function escAttr(v) {
    const s = String(v || '');
    if (!s) return s;
    try { return (window.CSS?.escape) ? CSS.escape(s) : s.replace(/"/g, '\\"'); } catch { return s; }
  }

  function qq(sel, root = document) {
    try { return sel ? Array.from(root.querySelectorAll(sel)) : []; } catch { return []; }
  }

  function markPerfFullScan() {
    S.perfFullScanTick = Number(S.perfFullScanTick || 0) + 1;
  }

  function perfLog(label, payload = null) {
    if (!PERF_ASSERT_ON) return;
    try {
      console.debug(`[MiniMap][perf] ${label}`, payload || {});
    } catch {}
  }

  function perfReportDuration(label, t0, scanTick0, payload = null) {
    if (!PERF_ASSERT_ON) return;
    const elapsed = Math.max(0, Number(performance.now() - Number(t0 || 0)).toFixed(2));
    const scansTotal = Number(S.perfFullScanTick || 0);
    const scansDelta = Math.max(0, scansTotal - Number(scanTick0 || 0));
    perfLog(label, Object.assign({
      ms: elapsed,
      fullScansDelta: scansDelta,
      fullScansTotal: scansTotal,
    }, payload || {}));
  }

  function perfMarkRebuildTrigger(reason = '') {
    if (!PERF_ASSERT_ON) return;
    const now = Date.now();
    if (!S.perfRebuildWindowTs) S.perfRebuildWindowTs = now;
    S.perfRebuildTriggerCount = Number(S.perfRebuildTriggerCount || 0) + 1;
    const windowMs = Math.max(1, now - Number(S.perfRebuildWindowTs || now));
    const perMinute = Math.round((Number(S.perfRebuildTriggerCount || 0) * 60000) / windowMs);
    perfLog('rebuild.trigger', {
      reason: String(reason || ''),
      countInWindow: Number(S.perfRebuildTriggerCount || 0),
      windowMs,
      approxPerMinute: perMinute,
    });
    if (windowMs >= 60000) {
      S.perfRebuildWindowTs = now;
      S.perfRebuildTriggerCount = 0;
    }
  }

  function setStateToken(el, tok, on) {
    if (!el) return;
    const key = 'data-cgxui-state';
    const cur = String(el.getAttribute(key) || '').trim();
    const set = new Set(cur ? cur.split(/\s+/).filter(Boolean) : []);
    if (on) set.add(tok); else set.delete(tok);
    if (set.size) el.setAttribute(key, Array.from(set).join(' '));
    else el.removeAttribute(key);
  }

  function mmBtnSelector() {
    const { SEL } = getRegs();
    return SEL.MM_BTN || '[data-cgxui="mnmp-btn"], [data-cgxui="mm-btn"]';
  }

  function getCoreViewMode() {
    try {
      const viaUi = String(MM_ui()?.getViewMode?.() || '').trim().toLowerCase();
      if (viaUi) return viaUi;
    } catch {}
    try {
      const viaPanel = String(MM_uiRefs()?.panel?.getAttribute?.('data-cgxui-view') || '').trim().toLowerCase();
      if (viaPanel) return viaPanel;
    } catch {}
    return 'classic';
  }

  function isQaViewActive() {
    return getCoreViewMode() === 'qa';
  }

  function getMiniMapRootEl() {
    try {
      const viaRefs = MM_uiRefs()?.root || null;
      if (viaRefs) return viaRefs;
    } catch {}
    return q('[data-cgxui="mnmp-root"][data-cgxui-owner="mnmp"], [data-h2o-owner="minimap-v10"]');
  }

  function qwashApi() {
    return TOPW?.H2O_QWASH_API || W?.H2O_QWASH_API || null;
  }

  function syncCurrentViewArtifacts(force = false) {
    const mode = String(getCoreViewMode() || 'classic').trim().toLowerCase() || 'classic';
    const refs = MM_uiRefs();
    const panel = refs?.panel || minimapPanel();
    if (panel) {
      try { panel.setAttribute('data-cgxui-view', mode); } catch {}
    }

    const root = refs?.root || getMiniMapRootEl();
    const hideQwash = mode === 'qa';
    if (root) {
      try { root.classList.toggle(CLS_HIDE_QWASH, hideQwash); } catch {}
    }

    if (!force && mode === String(S.lastAppliedViewMode || '').trim()) return mode;
    S.lastAppliedViewMode = mode;

    const api = qwashApi();
    if (hideQwash) {
      try { api?.clearMiniMap?.(); } catch {}
      try {
        collectMiniBtns().forEach((btn) => { clearQuestionWashMiniRing(btn); });
      } catch {}
    } else {
      try { api?.repaint?.('core:view-sync'); } catch {}
    }
    return mode;
  }

  function getWrapForMiniBtn(btn) {
    if (!btn) return null;
    return (
      btn.closest?.(`[data-cgxui="${UI_TOK.WRAP}"]`) ||
      btn.closest?.(`[data-cgxui="${UI_TOK.WRAP_LEGACY}"]`) ||
      btn.closest?.('.cgxui-mm-wrap') ||
      null
    );
  }

  function getQuestionBtnForWrap(wrap) {
    if (!wrap) return null;
    return (
      wrap.querySelector?.(`[data-cgxui="${UI_TOK.QBTN}"]`) ||
      wrap.querySelector?.(`[data-cgxui="${UI_TOK.QBTN_LEGACY}"]`) ||
      wrap.querySelector?.('.cgxui-mm-qbtn') ||
      null
    );
  }

  function resolveQaRowCanonicalMeta(turn = null, { btn = null, wrap = null, qBtn = null, primaryAId = '' } = {}) {
    const directTurnId = String(
      turn?.turnId ||
      qBtn?.dataset?.turnId ||
      wrap?.dataset?.turnId ||
      btn?.dataset?.turnId ||
      ''
    ).trim();
    const directAnswerId = String(
      primaryAId ||
      turn?.answerId ||
      turn?.primaryAId ||
      qBtn?.dataset?.primaryAId ||
      wrap?.dataset?.primaryAId ||
      btn?.dataset?.primaryAId ||
      btn?.dataset?.id ||
      ''
    ).trim();
    const cachedQuestionId = String(
      turn?.questionId ||
      turn?.qId ||
      qBtn?.dataset?.questionId ||
      wrap?.dataset?.questionId ||
      ''
    ).trim();
    let turnIdx = Math.max(0, Number(
      turn?.index ||
      turn?.turnNo ||
      turn?.idx ||
      qBtn?.dataset?.turnIdx ||
      wrap?.dataset?.turnIdx ||
      btn?.dataset?.turnIdx ||
      0
    ) || 0);

    let record = null;
    for (const key of [directAnswerId, directTurnId, cachedQuestionId]) {
      if (!key) continue;
      record = getSharedTurnRecordByAnyId(key);
      if (record) break;
    }

    const canonicalQuestionId = String(record?.qId || record?.questionId || '').trim();
    const turnId = String(record?.turnId || directTurnId).trim();
    const answerId = String(record?.primaryAId || record?.answerId || directAnswerId).trim();
    if (!turnIdx) {
      turnIdx = Math.max(0, Number(record?.turnNo || record?.idx || record?.index || 0) || 0);
    }

    return {
      record,
      turnId,
      answerId,
      questionId: String(canonicalQuestionId || cachedQuestionId).trim(),
      canonicalQuestionId,
      cachedQuestionId,
      turnIdx,
      questionEl: record?.questionEl || record?.qEl || record?.live?.qEl || turn?.questionEl || turn?.qEl || turn?.live?.qEl || null,
    };
  }

  function backfillQaRowMeta(wrap, qBtn, meta = null) {
    if (!meta) return false;
    const turnId = String(meta?.turnId || '').trim();
    const answerId = String(meta?.answerId || meta?.primaryAId || '').trim();
    const questionId = String(meta?.questionId || meta?.canonicalQuestionId || meta?.cachedQuestionId || '').trim();
    const turnIdx = Math.max(0, Number(meta?.turnIdx || meta?.index || 0) || 0);
    const idx = turnIdx > 0 ? String(turnIdx) : '';

    if (wrap) {
      wrap.dataset.turnId = turnId;
      if (answerId) wrap.dataset.primaryAId = answerId;
      else delete wrap.dataset.primaryAId;
      if (questionId) wrap.dataset.questionId = questionId;
      else delete wrap.dataset.questionId;
      if (idx) wrap.dataset.turnIdx = idx;
      else delete wrap.dataset.turnIdx;
    }

    if (qBtn) {
      qBtn.dataset.turnId = turnId;
      if (answerId) qBtn.dataset.primaryAId = answerId;
      else delete qBtn.dataset.primaryAId;
      if (questionId) qBtn.dataset.questionId = questionId;
      else delete qBtn.dataset.questionId;
      if (idx) qBtn.dataset.turnIdx = idx;
      else delete qBtn.dataset.turnIdx;
    }

    return true;
  }

  function syncWrapMeta(wrap, turn, band, qaMeta = null) {
    if (!wrap) return null;
    const meta = qaMeta || resolveQaRowCanonicalMeta(turn, { wrap });
    const turnIdx = Math.max(0, Number(meta?.turnIdx || turn?.index || 0) || 0);
    const questionId = String(meta?.questionId || '').trim();
    const turnId = String(meta?.turnId || turn?.turnId || '').trim();
    const answerId = String(meta?.answerId || turn?.answerId || turn?.primaryAId || '').trim();
    const pageNum = Math.max(1, Math.ceil(Math.max(1, turnIdx || 1) / 25));
    wrap.dataset.turnIdx = String(turnIdx);
    wrap.dataset.pageNum = String(pageNum);
    wrap.dataset.pageBand = String(band || getTurnPageBand(turnIdx || turn?.index || 0));
    wrap.dataset.turnId = turnId;
    if (answerId) wrap.dataset.primaryAId = answerId;
    else delete wrap.dataset.primaryAId;
    if (questionId) wrap.dataset.questionId = questionId;
    else delete wrap.dataset.questionId;
    return wrap;
  }

  function syncAnswerBtnMeta(btn, turn, band) {
    if (!btn) return null;
    const turnId = String(turn?.turnId || '').trim();
    const answerId = String(turn?.answerId || '').trim();
    const idx = String(turn?.index || 0);
    const pageNum = String(Math.max(1, Math.ceil(Math.max(1, Number(turn?.index || 0) || 1) / 25)));
    const pageBand = String(band || getTurnPageBand(turn?.index || 0));

    btn.dataset.id = turnId;
    btn.dataset.turnId = turnId;
    btn.dataset.primaryAId = answerId;
    btn.dataset.turnIdx = idx;
    btn.dataset.pageNum = pageNum;
    btn.dataset.pageBand = pageBand;
    btn.dataset.surfaceRole = 'answer';
    btn.setAttribute('aria-label', `Go to answer ${idx || ''}`);

    const num = btn.querySelector('.cgxui-mm-num');
    if (num) num.textContent = String(turn?.index || '');
    return btn;
  }

  function syncQuestionBtnMeta(qBtn, turn, band, qaMeta = null) {
    if (!qBtn) return null;
    const meta = qaMeta || resolveQaRowCanonicalMeta(turn, { wrap: getWrapForMiniBtn(qBtn), qBtn });
    const turnId = String(meta?.turnId || turn?.turnId || '').trim();
    const answerId = String(meta?.answerId || turn?.answerId || turn?.primaryAId || '').trim();
    const questionId = String(meta?.questionId || '').trim();
    const idxNum = Math.max(0, Number(meta?.turnIdx || turn?.index || 0) || 0);
    const idx = String(idxNum);
    const pageNum = String(Math.max(1, Math.ceil(Math.max(1, idxNum || 1) / 25)));
    const pageBand = String(band || getTurnPageBand(idxNum || turn?.index || 0));

    qBtn.dataset.turnId = turnId;
    if (answerId) qBtn.dataset.primaryAId = answerId;
    else delete qBtn.dataset.primaryAId;
    if (questionId) qBtn.dataset.questionId = questionId;
    else delete qBtn.dataset.questionId;
    qBtn.dataset.turnIdx = idx;
    qBtn.dataset.pageNum = pageNum;
    qBtn.dataset.pageBand = pageBand;
    qBtn.dataset.surfaceRole = 'question';
    qBtn.setAttribute('aria-label', `Go to question ${idx || ''}`);
    qBtn.textContent = '';
    return qBtn;
  }

  function ensureQuestionBtnForWrap(wrap, turn, band, enabled = isQaViewActive(), qaMeta = null) {
    const perfOwned = enterPerfOwner('incremental');
    const perfT0 = perfNow();
    try {
      if (!wrap) {
        noteNodeLifecycle('noOp', 'questionButtons');
        return null;
      }

      let qBtn = getQuestionBtnForWrap(wrap);

      if (!enabled) {
        if (qBtn) {
          qBtn.remove();
          noteNodeLifecycle('removed', 'questionButtons');
        } else {
          noteNodeLifecycle('noOp', 'questionButtons');
        }
        return null;
      }

      if (!qBtn) {
        qBtn = document.createElement('button');
        qBtn.type = 'button';
        qBtn.className = 'cgxui-mm-qbtn';
        qBtn.setAttribute('data-cgxui-owner', UI_TOK.OWNER);
        qBtn.setAttribute('data-cgxui', UI_TOK.QBTN);
        noteNodeLifecycle('created', 'questionButtons');
      } else {
        noteNodeLifecycle('reused', 'questionButtons');
      }

      syncQuestionBtnMeta(qBtn, turn, band, qaMeta);
      backfillQaRowMeta(wrap, qBtn, qaMeta);

      if (wrap.firstChild !== qBtn) {
        wrap.insertBefore(qBtn, wrap.firstChild || null);
      }
      noteRenderUnit('questionButtons');
      return qBtn;
    } finally {
      const ms = perfNow() - perfT0;
      recordDuration(PERF.paths.ensureQuestionBtnForWrap, ms);
      if (perfOwned) {
        recordDuration(PERF.incrementalRefresh, ms);
        noteSummaryBucket(PERF.incrementalRefresh, 'ensureQuestionBtnForWrap');
      }
      exitPerfOwner('incremental');
    }
  }

  function syncTurnRowDom(btn, turn, { qaEnabled = isQaViewActive() } = {}) {
    const perfOwned = enterPerfOwner('incremental');
    const perfT0 = perfNow();
    try {
      if (!btn || !turn) return { wrap: null, qBtn: null, btn: btn || null };
      const wrap = getWrapForMiniBtn(btn);
      const qaMeta = resolveQaRowCanonicalMeta(turn, { btn, wrap, primaryAId: turn?.answerId || turn?.primaryAId || '' });
      const band = getTurnPageBand(qaMeta?.turnIdx || turn.index);

      syncAnswerBtnMeta(btn, turn, band);
      syncWrapMeta(wrap, turn, band, qaMeta);

      const qBtn = ensureQuestionBtnForWrap(wrap, turn, band, qaEnabled, qaMeta);
      backfillQaRowMeta(wrap, qBtn, qaMeta);
      return { wrap, qBtn, btn };
    } finally {
      const ms = perfNow() - perfT0;
      recordDuration(PERF.paths.syncTurnRowDom, ms);
      if (perfOwned) {
        recordDuration(PERF.incrementalRefresh, ms);
        noteSummaryBucket(PERF.incrementalRefresh, 'syncTurnRowDom');
      }
      exitPerfOwner('incremental');
    }
  }

  function setPeerQuestionActiveFromAnswerBtn(btn, on) {
    const wrap = getWrapForMiniBtn(btn);
    const qBtn = getQuestionBtnForWrap(wrap);
    if (!qBtn) return false;
    const active = !!on;
    qBtn.classList.toggle('inview', active);
    setStateToken(qBtn, 'peer-active', active);
    if (active) qBtn.setAttribute('data-cgxui-inview', '1');
    else qBtn.removeAttribute('data-cgxui-inview');
    return true;
  }

  function hexToRgb(hex) {
    const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(String(hex || '').trim());
    if (!m) return { r: 0, g: 0, b: 0 };
    return { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) };
  }

  function luminance({ r, g, b }) {
    const srgb = [r, g, b].map((v0) => {
      let v = Number(v0) || 0;
      v /= 255;
      return v <= 0.03928 ? (v / 12.92) : Math.pow((v + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * srgb[0] + 0.7152 * srgb[1] + 0.0722 * srgb[2];
  }

  function bestTextColor(bgHex) {
    const L = luminance(hexToRgb(bgHex || '#222'));
    return L > 0.5 ? '#111' : '#fff';
  }

  function normalizeQuestionWashColorId(input) {
    const id = String(input || '').trim().toLowerCase();
    return COLOR_BY_NAME[id] ? id : '';
  }

  function isStableQuestionId(v) {
    const id = String(v || '').trim().replace(/^conversation-turn-/, '');
    if (!id || id.length < 6) return false;
    if (/^(?:user|assistant|message)$/i.test(id)) return false;
    return true;
  }

  function getStableQuestionIdFromElement(el) {
    if (!el || !(el instanceof Element)) return '';

    const qwrapNode = (
      el.closest?.('[data-h2o-qwrap-id], [data-ho-qwrap-id]') ||
      el.querySelector?.('[data-h2o-qwrap-id], [data-ho-qwrap-id]') ||
      null
    );
    if (qwrapNode) {
      const qwrapId = String(
        qwrapNode.getAttribute?.('data-h2o-qwrap-id')
        || qwrapNode.getAttribute?.('data-ho-qwrap-id')
        || qwrapNode.dataset?.h2oQwrapId
        || qwrapNode.dataset?.hoQwrapId
        || ''
      ).trim();
      if (isStableQuestionId(qwrapId)) return qwrapId;
    }

    try {
      const qId = TOPW?.H2O?.index?.getQId?.(el) || W?.H2O?.index?.getQId?.(el) || '';
      const normalized = String(qId || '').trim();
      if (isStableQuestionId(normalized)) return normalized;
    } catch {}

    try {
      const textEl =
        el.querySelector?.('.cgxui-qswr-text') ||
        el.querySelector?.('.whitespace-pre-wrap') ||
        null;
      const qwrapId =
        W?.H2O_getStableQwrapId?.(el, textEl) ||
        TOPW?.H2O_getStableQwrapId?.(el, textEl) ||
        '';
      const normalized = String(qwrapId || '').trim();
      if (isStableQuestionId(normalized)) return normalized;
    } catch {}

    const attrs = [
      'data-h2o-qwrap-id',
      'data-ho-qwrap-id',
      'data-h2o-uid',
      'data-ho-uid',
      'data-message-id',
      'data-turn-id',
      'id',
    ];
    const roots = [
      el,
      el.closest?.(STUDIO_SEL.sel.anyMessageHost) || null,
    ].filter(Boolean);

    for (const root of roots) {
      for (const attr of attrs) {
        const raw = String(root.getAttribute?.(attr) || '').trim().replace(/^conversation-turn-/, '');
        if (isStableQuestionId(raw)) return raw;
      }
    }
    return '';
  }

  function readQuestionWashCssVar(el, prop) {
    if (!el || !(el instanceof Element) || !prop) return '';
    try {
      const direct = String(el.style?.getPropertyValue(prop) || '').trim();
      if (direct) return direct;
    } catch {}
    try {
      const computed = String(W.getComputedStyle(el).getPropertyValue(prop) || '').trim();
      if (computed) return computed;
    } catch {}
    return '';
  }

  function resolveQuestionWashColorFromElement(questionEl) {
    if (!questionEl || !(questionEl instanceof Element)) return '';
    const candidates = [];
    const push = (el) => {
      if (el instanceof Element && !candidates.includes(el)) candidates.push(el);
    };
    push(questionEl);
    push(questionEl.closest?.('.cgxq-qwash-on') || null);
    push(questionEl.querySelector?.('.cgxq-qwash-on') || null);
    try {
      Array.from(questionEl.querySelectorAll?.('.cgxq-qwash-on') || []).slice(0, 4).forEach(push);
    } catch {}

    for (const el of candidates) {
      for (const prop of ['--cgxq-qwash-wash-edge', '--cgxq-qwash-wash-deep', '--cgxq-qwash-wash']) {
        const raw = readQuestionWashCssVar(el, prop);
        if (raw && raw !== 'transparent') return raw;
      }
    }
    return '';
  }

  function coerceQuestionWashEntry(rawEntry) {
    if (rawEntry == null) return null;
    if (typeof rawEntry === 'string') {
      const colorId = normalizeQuestionWashColorId(rawEntry);
      return colorId ? { colorId } : null;
    }
    if (typeof rawEntry !== 'object' || Array.isArray(rawEntry)) return null;
    const colorId = normalizeQuestionWashColorId(
      rawEntry.colorId ?? rawEntry.color ?? rawEntry.colorName ?? rawEntry.name ?? rawEntry.c
    );
    return colorId ? { colorId } : null;
  }

  function getQuestionWashStore() {
    let raw = '';
    try { raw = String(W.localStorage?.getItem(KEY_QWASH_FALLBACK) || ''); } catch {}
    if (raw === S.qWashStoreRaw && S.qWashStore && typeof S.qWashStore === 'object') {
      return S.qWashStore;
    }

    const nextStore = Object.create(null);
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          Object.entries(parsed).forEach(([rawKey, rawEntry]) => {
            const key = String(rawKey || '').trim();
            const entry = coerceQuestionWashEntry(rawEntry);
            if (key && entry) nextStore[key] = entry;
          });
        }
      } catch {}
    }

    S.qWashStoreRaw = raw;
    S.qWashStore = nextStore;
    return nextStore;
  }

  function questionWashScopeKey() {
    try {
      const m = String(W.location.pathname || '').match(/\/c\/([^/]+)/);
      if (m && m[1]) return `c:${m[1]}`;
      return String(W.location.pathname || '/');
    } catch {
      return '/';
    }
  }

  function resolveMiniBtnWashState(primaryAId, btnEl = null) {
    const id = String(
      primaryAId ||
      btnEl?.dataset?.primaryAId ||
      btnEl?.dataset?.id ||
      btnEl?.dataset?.turnId ||
      ''
    ).trim();
    if (!id) {
      return { id: '', colorName: null, bg: null, isGold: false, paintBg: '', text: '' };
    }
    const washMap = (W?.H2O?.MM?.washMap && typeof W.H2O.MM.washMap === 'object') ? W.H2O.MM.washMap : null;
    if (!washMap) {
      return { id, colorName: null, bg: null, isGold: false, paintBg: '', text: '' };
    }

    const rawName = washMap?.[id];
    const norm = String(rawName || '').trim().toLowerCase();
    const colorName = norm && COLOR_BY_NAME[norm] ? norm : null;
    if (rawName && !colorName) {
      try { delete washMap[id]; } catch {}
    }

    const bg = colorName ? (COLOR_BY_NAME?.[colorName] || null) : null;
    const isGold = !!bg && (colorName === 'gold' || String(bg).toUpperCase() === '#FFD700');
    const paintBg = bg ? (isGold ? '#E6C200' : bg) : '';
    const text = bg ? bestTextColor(paintBg) : '';
    return { id, colorName, bg, isGold, paintBg, text };
  }

  function resolveQuestionBtnWashState(primaryAId, qBtn = null) {
    const store = getQuestionWashStore();
    const btn = qBtn || null;
    const wrap = getWrapForMiniBtn(btn);
    const meta = resolveQaRowCanonicalMeta(null, { qBtn: btn, wrap, primaryAId });
    backfillQaRowMeta(wrap, btn, meta);

    const canonicalQuestionId = String(meta?.canonicalQuestionId || '').trim();
    const cachedQuestionId = String(meta?.cachedQuestionId || '').trim();
    let questionId = String(canonicalQuestionId || cachedQuestionId || '').trim();
    const turnId = String(meta?.turnId || '').trim();
    let turnIdx = Math.max(0, Number(meta?.turnIdx || 0) || 0);
    if (!turnIdx) {
      const turnApi = TOPW?.H2O?.turn || W?.H2O?.turn || null;
      if (!turnIdx && questionId && typeof turnApi?.getTurnIndexByQId === 'function') {
        try { turnIdx = Math.max(0, Number(turnApi.getTurnIndexByQId(questionId) || 0) || 0); } catch {}
      }
    }

    const keys = [];
    const pushKey = (rawKey) => {
      const key = String(rawKey || '').trim();
      if (key && !keys.includes(key)) keys.push(key);
    };
    pushKey(canonicalQuestionId ? `id:${canonicalQuestionId}` : '');
    if (cachedQuestionId && cachedQuestionId !== canonicalQuestionId) {
      pushKey(`id:${cachedQuestionId}`);
    }
    pushKey(turnId ? `id:${turnId}` : '');
    if (turnIdx > 0) {
      pushKey(`ord:${questionWashScopeKey()}:${turnIdx}`);
    }

    let entry = null;
    let matchedKey = '';
    for (const key of keys) {
      if (!store[key]) continue;
      entry = store[key];
      matchedKey = key;
      break;
    }

    let stableQuestionId = '';
    if (!entry) {
      stableQuestionId = getStableQuestionIdFromElement(meta?.questionEl || null);
      if (!questionId && stableQuestionId) questionId = stableQuestionId;
      if (stableQuestionId && stableQuestionId !== canonicalQuestionId && stableQuestionId !== cachedQuestionId) {
        const liveKey = `id:${stableQuestionId}`;
        if (store[liveKey]) {
          entry = store[liveKey];
          matchedKey = liveKey;
        }
      }
    }

    const colorName = normalizeQuestionWashColorId(entry?.colorId);
    const liveBg = colorName ? '' : resolveQuestionWashColorFromElement(meta?.questionEl || null);
    const bg = colorName ? (COLOR_BY_NAME[colorName] || null) : (liveBg || null);
    return {
      matchedKey,
      answerId: String(meta?.answerId || primaryAId || '').trim(),
      questionId,
      stableQuestionId,
      turnId,
      turnIdx,
      colorName: colorName || null,
      bg,
    };
  }

  function clearQuestionWashMiniRing(btnEl) {
    if (!btnEl) return false;
    const num = btnEl.querySelector?.('.cgxui-mm-num') || null;
    if (!num) return false;
    try { num.classList.remove('cgxq-qwash-mm-num-on'); } catch {}
    try {
      num.style.removeProperty('--cgxq-qwash-mm-ring');
      num.style.removeProperty('--cgxq-qwash-mm-fill');
      num.style.removeProperty('display');
      num.style.removeProperty('align-items');
      num.style.removeProperty('justify-content');
      num.style.removeProperty('min-width');
      num.style.removeProperty('height');
      num.style.removeProperty('padding');
      num.style.removeProperty('box-sizing');
      num.style.removeProperty('line-height');
      num.style.removeProperty('border-radius');
      num.style.removeProperty('border');
      num.style.removeProperty('background');
      num.style.removeProperty('color');
      num.style.removeProperty('box-shadow');
    } catch {}
    return true;
  }

  function clearMiniBtnWashVisual(btnEl) {
    if (!btnEl) return false;
    try { delete btnEl.dataset.wash; } catch {}
    try { btnEl.removeAttribute('data-cgxui-wash'); } catch {}
    try {
      btnEl.style.removeProperty('background');
      btnEl.style.removeProperty('color');
      btnEl.style.removeProperty('text-shadow');
      btnEl.style.removeProperty('box-shadow');
      btnEl.style.removeProperty('--cgxui-mnmp-q-wash-color');
    } catch {}
    try {
      for (const cls of Array.from(btnEl.classList || [])) {
        if (!cls) continue;
        if (cls.startsWith('cgxui-mnmp-wash-') || cls.startsWith('cgxui-wash-')) {
          btnEl.classList.remove(cls);
        }
      }
    } catch {}
    return true;
  }

  function applyQaWashToQuestionBtn(primaryAId, qBtn) {
    if (!qBtn) return false;
    const wrap = getWrapForMiniBtn(qBtn);
    const wash = resolveQuestionBtnWashState(primaryAId, qBtn);
    backfillQaRowMeta(wrap, qBtn, wash);
    clearMiniBtnWashVisual(qBtn);
    if (!wash.bg) return false;
    qBtn.dataset.wash = 'true';
    try { qBtn.setAttribute('data-cgxui-wash', '1'); } catch {}
    try { qBtn.style.setProperty('--cgxui-mnmp-q-wash-color', wash.bg); } catch {}
    return true;
  }

  function fallbackApplyWashToMiniBtn(primaryAId, btnEl) {
    if (!btnEl) return false;
    const wash = resolveMiniBtnWashState(primaryAId, btnEl);
    if (!wash.id) return false;

    const { bg, isGold, paintBg, text } = wash;
    if (bg) {
      btnEl.style.background = `linear-gradient(145deg, rgba(255,255,255,0.06), rgba(0,0,0,0.10)), ${paintBg}`;
      btnEl.style.color = text;
      btnEl.style.textShadow = (text === '#fff')
        ? '0 0 2px rgba(0,0,0,.35)'
        : '0 1px 0 rgba(255,255,255,.35)';
      btnEl.style.boxShadow = isGold
        ? '0 0 5px 1px rgba(255,215,0,0.30)'
        : `0 0 6px 2px ${bg}40`;
      btnEl.dataset.wash = 'true';
      try { btnEl.setAttribute('data-cgxui-wash', '1'); } catch {}
    } else {
      btnEl.style.background = 'rgba(255,255,255,.06)';
      btnEl.style.color = '#e5e7eb';
      btnEl.style.textShadow = '0 0 2px rgba(0,0,0,.25)';
      btnEl.style.boxShadow = 'none';
      btnEl.dataset.wash = 'false';
      try { btnEl.removeAttribute('data-cgxui-wash'); } catch {}
    }
    return true;
  }

  function applyWashToMiniBtn(primaryAId, btnEl) {
    const id = String(
      primaryAId ||
      btnEl?.dataset?.primaryAId ||
      btnEl?.dataset?.id ||
      btnEl?.dataset?.turnId ||
      ''
    ).trim();
    if (!btnEl || !id) return false;

    try {
      const sharedApply = TOPW.H2O_MM_SHARED?.get?.()?.util?.mmApplyWashToBtn;
      if (typeof sharedApply === 'function') {
        const arity = Number(sharedApply.length || 0);
        if (arity >= 3) {
          sharedApply(id, btnEl, fallbackApplyWashToMiniBtn);
          return true;
        }
        const out = sharedApply(id, btnEl);
        if (out === false) return !!fallbackApplyWashToMiniBtn(id, btnEl);
        if (out == null) {
          try { fallbackApplyWashToMiniBtn(id, btnEl); } catch {}
        }
        return true;
      }
    } catch {}

    try {
      const washApi = W?.H2O?.MM?.wash;
      if (washApi && typeof washApi.applyToMiniBtn === 'function') {
        washApi.applyToMiniBtn(id, btnEl);
        return true;
      }
    } catch {}

    return !!fallbackApplyWashToMiniBtn(id, btnEl);
  }

  function collectMiniBtns() {
    const out = [];
    const seen = new Set();

    try {
      const map = ensureMapStore();
      for (const btn of map.values()) {
        if (!btn || !btn.isConnected || seen.has(btn)) continue;
        seen.add(btn);
        out.push(btn);
      }
    } catch {}
    if (out.length) return out;

    let scanRoot = null;
    try { scanRoot = minimapCol(MM_uiRefs()?.panel || null) || null; } catch {}
    if (!scanRoot) {
      try {
        const panel = minimapPanel();
        scanRoot = minimapCol(panel) || panel || null;
      } catch {}
    }
    if (!scanRoot) scanRoot = document;
    markPerfFullScan();
    for (const btn of qq(mmBtnSelector(), scanRoot)) {
      if (!btn || seen.has(btn)) continue;
      seen.add(btn);
      out.push(btn);
    }
    return out;
  }

  function washEventSig(detail) {
    const all = detail?.all === true || detail?.full === true;
    const color = String(detail?.colorName ?? detail?.color ?? '').trim();
    if (all) return `all|${color}`;
    const ids = extractWashEventIds(detail).sort();
    if (!ids.length && !color) return '';
    return `${ids.join(',')}|${color}`;
  }

  function repaintMiniBtnByAnswerId(anyId, btnEl = null) {
    const key = String(
      anyId ||
      btnEl?.dataset?.primaryAId ||
      btnEl?.dataset?.id ||
      btnEl?.dataset?.turnId ||
      ''
    ).trim();
    if (!key) return false;
    const btn = btnEl || getBtnById(key);
    if (!btn) return false;
    const primaryAId = String(btn?.dataset?.primaryAId || key).trim();
    if (!primaryAId) return false;
    const wrap = getWrapForMiniBtn(btn);
    const qBtn = getQuestionBtnForWrap(wrap);

    if (isQaViewActive()) {
      const qaMeta = resolveQaRowCanonicalMeta(null, { btn, wrap, qBtn, primaryAId });
      backfillQaRowMeta(wrap, qBtn, qaMeta);
      clearMiniBtnWashVisual(btn);
      clearQuestionWashMiniRing(btn);
      applyWashToMiniBtn(primaryAId, btn);
      applyQaWashToQuestionBtn(primaryAId, qBtn);
      return true;
    }

    clearMiniBtnWashVisual(qBtn);
    return !!applyWashToMiniBtn(primaryAId, btn);
  }

  function repaintAllMiniBtns() {
    let painted = 0;
    for (const btn of collectMiniBtns()) {
      const id = String(
        btn?.dataset?.primaryAId ||
        btn?.dataset?.id ||
        btn?.dataset?.turnId ||
        ''
      ).trim();
      if (!id) continue;
      if (repaintMiniBtnByAnswerId(id, btn)) painted += 1;
    }
    return painted;
  }

  function extractWashEventIds(detail) {
    const ids = new Set();
    const push = (v) => {
      const s = String(v || '').trim();
      if (s) ids.add(s);
    };
    push(detail?.primaryAId);
    push(detail?.answerId);
    push(detail?.id);
    push(detail?.turnId);
    const buckets = [detail?.primaryAIds, detail?.answerIds, detail?.ids, detail?.turnIds];
    for (const arr of buckets) {
      if (!Array.isArray(arr)) continue;
      for (const v of arr) push(v);
    }
    return Array.from(ids);
  }

  function flushWashRepaintQueue() {
    const perfOwned = enterPerfOwner('incremental');
    const perfT0 = perfNow();
    try {
      S.washRepaintRaf = 0;
      const repaintAll = !!S.washRepaintAll;
      S.washRepaintAll = false;
      const ids = Array.from(S.washRepaintQueue.values());
      S.washRepaintQueue.clear();

      if (repaintAll || !ids.length) {
        const repainted = Number(repaintAllMiniBtns() || 0);
        if (repainted > 0) noteRenderUnit('washRepaints', repainted);
        try {
          const activeBtn = q('[data-cgxui="mnmp-btn"][data-cgxui-state~="active"], [data-cgxui="mm-btn"][data-cgxui-state~="active"], .cgxui-mm-btn.active');
          const activeId = String(activeBtn?.dataset?.turnId || activeBtn?.dataset?.primaryAId || '').trim();
          if (activeId) updateToggleColor(activeId);
        } catch {}
        return true;
      }

      for (const id of ids) {
        try { repaintMiniBtnByAnswerId(id); } catch {}
      }
      if (ids.length) noteRenderUnit('washRepaints', ids.length);
      try { updateToggleColor(ids[0] || ''); } catch {}
      return true;
    } finally {
      const ms = perfNow() - perfT0;
      recordDuration(PERF.paths.flushWashRepaintQueue, ms);
      if (perfOwned) {
        recordDuration(PERF.incrementalRefresh, ms);
        noteSummaryBucket(PERF.incrementalRefresh, 'flushWashRepaintQueue');
      }
      exitPerfOwner('incremental');
    }
  }

  function scheduleWashRepaint(ids = null) {
    if (ids == null) S.washRepaintAll = true;
    else if (Array.isArray(ids)) {
      for (const raw of ids) {
        const id = String(raw || '').trim();
        if (id) S.washRepaintQueue.add(id);
      }
      if (!S.washRepaintQueue.size) S.washRepaintAll = true;
    } else {
      const id = String(ids || '').trim();
      if (id) S.washRepaintQueue.add(id);
      else S.washRepaintAll = true;
    }
    if (S.washRepaintRaf) return true;
    S.washRepaintRaf = requestAnimationFrame(flushWashRepaintQueue);
    return true;
  }

  function bindWashBridge() {
    if (S.washBridgeBound) return true;

    const onWashChanged = (ev) => {
      const detail = ev?.detail || {};
      const sig = washEventSig(detail);
      if (sig) {
        const now = performance.now();
        if (sig === S.washBridgeLastSig && (now - S.washBridgeLastTs) < 45) return;
        S.washBridgeLastSig = sig;
        S.washBridgeLastTs = now;
      }
      if (detail?.all === true || detail?.full === true) {
        scheduleWashRepaint();
        return;
      }
      const ids = extractWashEventIds(detail);
      if (ids.length) scheduleWashRepaint(ids);
      else scheduleWashRepaint();
    };

    for (const evtName of EV_WASH_CHANGED) {
      window.addEventListener(evtName, onWashChanged);
    }

    S.washBridgeOff = () => {
      for (const evtName of EV_WASH_CHANGED) {
        try { window.removeEventListener(evtName, onWashChanged); } catch {}
      }
      if (S.washRepaintRaf) {
        try { cancelAnimationFrame(S.washRepaintRaf); } catch {}
      }
      S.washRepaintRaf = 0;
      S.washRepaintAll = false;
      S.washRepaintQueue.clear();
      S.washBridgeLastSig = '';
      S.washBridgeLastTs = 0;
    };
    S.washBridgeBound = true;
    return true;
  }

  function unbindWashBridge() {
    try { S.washBridgeOff?.(); } catch {}
    S.washBridgeOff = null;
    S.washBridgeBound = false;
  }

  function bindViewBridge() {
    if (S.viewBridgeBound) return true;

    const onViewChanged = () => {
      try { syncCurrentViewArtifacts(true); } catch {}
      scheduleWashRepaint();
    };

    window.addEventListener(EV_VIEW_CHANGED, onViewChanged);
    if (EV_VIEW_CHANGED.startsWith('evt:')) {
      window.addEventListener(EV_VIEW_CHANGED.slice(4), onViewChanged);
    }

    S.viewBridgeOff = () => {
      try { window.removeEventListener(EV_VIEW_CHANGED, onViewChanged); } catch {}
      if (EV_VIEW_CHANGED.startsWith('evt:')) {
        try { window.removeEventListener(EV_VIEW_CHANGED.slice(4), onViewChanged); } catch {}
      }
    };
    S.viewBridgeBound = true;
    return true;
  }

  function unbindViewBridge() {
    try { S.viewBridgeOff?.(); } catch {}
    S.viewBridgeOff = null;
    S.viewBridgeBound = false;
  }

  function getUiRefs() {
    try {
      return MM_uiRefs();
    } catch {
      return {};
    }
  }

  function safeDiag(kind, msg, extra) {
    try { TOPW.H2O_MM_DIAG?.[kind]?.(msg, extra); } catch {}
  }

  function counterEl() {
    const refs = getUiRefs();
    if (refs.counter && refs.counter.isConnected) return refs.counter;
    return q('[data-cgxui$="counter"]');
  }

  function toggleEl() {
    const { SEL } = getRegs();
    const refs = getUiRefs();
    return refs.toggle || q(SEL.MM_TOGGLE || '') || q('[data-cgxui$="toggle"]');
  }

  function toggleCountEl() {
    const { SEL } = getRegs();
    const tg = toggleEl();
    return tg?.querySelector?.(SEL.MM_BTN_COUNT || SEL.MM_TOGGLE_COUNT || '.cgxui-mm-count')
      || q(SEL.MM_TOGGLE_COUNT || '')
      || q('.cgxui-mm-count')
      || tg?.querySelector?.('[data-cgxui$="count"]')
      || null;
  }

  function getMiniMapScroller(btn = null) {
    const refs = getUiRefs();
    const panel = refs.panel || minimapPanel();
    const col = refs.col || minimapCol(panel);
    const candidates = [col, panel];

    if (btn?.closest) {
      const wrap = btn.closest('[data-cgxui="mnmp-wrap"], [data-cgxui="mm-wrap"]');
      if (wrap) candidates.push(wrap.parentElement);
    }
    if (panel) {
      candidates.push(...qq('*', panel).slice(0, 24));
    }

    const seen = new Set();
    for (const el of candidates) {
      if (!el || seen.has(el)) continue;
      seen.add(el);
      try {
        const cs = getComputedStyle(el);
        if (el.scrollHeight > el.clientHeight && cs.overflowY !== 'visible') return el;
      } catch {}
    }

    let p = panel?.parentElement || null;
    let guard = 0;
    while (p && guard < 6) {
      guard += 1;
      try {
        const cs = getComputedStyle(p);
        if (p.scrollHeight > p.clientHeight && cs.overflowY !== 'visible') return p;
      } catch {}
      p = p.parentElement;
    }
    return panel || col || null;
  }

  function centerMiniMapNode(node, { smooth = true } = {}) {
    if (!node) return false;

    const scroller = getMiniMapScroller(node);
    if (scroller?.scrollTo) {
      const scrollerTop = scroller.getBoundingClientRect().top;
      const nodeTop = node.getBoundingClientRect().top;
      const current = scroller.scrollTop || 0;
      const delta = (nodeTop - scrollerTop) - (scroller.clientHeight / 2 - node.clientHeight / 2);
      scroller.scrollTo({
        top: Math.max(0, current + delta),
        behavior: smooth ? 'smooth' : 'auto',
      });
      return true;
    }

    try {
      node.scrollIntoView?.({ block: 'center', behavior: smooth ? 'smooth' : 'auto' });
      return true;
    } catch {
      return false;
    }
  }

  function getAnswerEls() {
    const { SEL } = getRegs();
    const primary = qq(SEL.ANSWER || '');
    if (primary.length) return primary;
    const a = qq(STUDIO_SEL.sel.assistantTurnTagged);
    if (a.length) return a;
    const b = qq(STUDIO_SEL.sel.assistantTurn);
    if (b.length) return b;
    return qq(STUDIO_SEL.sel.conversationTurnLoose).flatMap((host) => {
      try {
        const el = host?.querySelector?.(STUDIO_SEL.sel.assistantTurn);
        return el ? [el] : [];
      } catch {
        return [];
      }
    });
  }

  function pickAssistantMessageEl(node) {
    if (!node || node.nodeType !== 1) return null;
    const role = String(node.getAttribute?.('data-message-author-role') || '').toLowerCase();
    if (role === 'assistant') return node;
    try {
      const nested = node.querySelector?.(STUDIO_SEL.sel.assistantTurn);
      if (nested) return nested;
    } catch {}
    try {
      const up = node.closest?.(STUDIO_SEL.sel.assistantTurn);
      if (up) return up;
    } catch {}
    return null;
  }

  function getMessageId(el) {
    try {
      const viaFn = W.getMessageId?.(el);
      if (viaFn) return String(viaFn);
    } catch {}

    const raw = (
      el?.getAttribute?.('data-message-id') ||
      el?.dataset?.messageId ||
      el?.getAttribute?.('data-cgxui-id') ||
      el?.getAttribute?.('data-h2o-ans-id') ||
      el?.dataset?.h2oAnsId ||
      ''
    );
    if (raw) return String(raw);

    const gen = `a_${Math.random().toString(36).slice(2)}`;
    try { el?.setAttribute?.('data-h2o-core-id', gen); } catch {}
    return gen;
  }

  function parseTurnId(el, idx, aId) {
    const raw = (
      el?.getAttribute?.('data-turn-id') ||
      el?.dataset?.turnId ||
      el?.getAttribute?.('data-cgx-turn-id') ||
      ''
    );
    if (raw) return String(raw).trim();
    if (aId) return `turn:${aId}`;
    return `turn:${idx}`;
  }

  // FNV-1a-inspired 32-bit hash, base-36 encoded. Mirrors Pagination's stableHash36
  // exactly so that path_<hash> fallback IDs are identical across all modules.
  function stableHash36(input) {
    const str = String(input || '');
    let h = 2166136261;
    for (let i = 0; i < str.length; i += 1) {
      h ^= str.charCodeAt(i);
      h += (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24);
    }
    return (h >>> 0).toString(36);
  }

  function resolveChatId() {
    // Check shared util hook first (may be populated by another H2O module).
    const fromUtil = String(W?.H2O?.util?.getChatId?.() || '').trim();
    if (fromUtil) return fromUtil;
    // Mirror Pagination getChatId() exactly: /c/, /g/, then path_hash fallback.
    // This guarantees Core, Engine, and Pagination all key collapse state on the
    // same identity string for the same chat/GPT/session.
    const path = String(location.pathname || '/');
    const m = path.match(/\/c\/([^/?#]+)/i) || path.match(/\/g\/([^/?#]+)/i);
    if (m && m[1]) {
      try { return decodeURIComponent(m[1]); } catch (_) { return m[1]; }
    }
    return `path_${stableHash36(`${location.origin}${path}${location.search || ''}`)}`;
  }

  function safeChatKeyPart(chatId = '') {
    return String(chatId || '').trim().replace(/[^a-z0-9_-]/gi, '_');
  }

  function nsDisk() {
    const { SH } = getRegs();
    try {
      const ns = SH?.util?.ns;
      if (ns && typeof ns.disk === 'function') return ns.disk('prm', 'cgx', 'mnmp');
    } catch {}
    return String(SH?.NS_DISK || 'h2o:prm:cgx:mnmp');
  }

  function keyTurnCacheMeta(chatId = '') {
    const safeId = safeChatKeyPart(chatId || resolveChatId());
    if (!safeId) return '';
    return `${nsDisk()}:${KEY_TURN_CACHE_META_SUFFIX}:${safeId}:v1`;
  }

  function keyTurnCacheTurns(chatId = '') {
    const safeId = safeChatKeyPart(chatId || resolveChatId());
    if (!safeId) return '';
    return `${nsDisk()}:${KEY_TURN_CACHE_TURNS_SUFFIX}:${safeId}:v1`;
  }

  function keyCustomDividers(chatId = '') {
    const safeId = safeChatKeyPart(chatId || resolveChatId());
    if (!safeId) return '';
    return `${nsDisk()}:${KEY_CUSTOM_DIVIDERS_SUFFIX}:${safeId}:v1`;
  }

  function keyCollapsedPages(chatId = '') {
    const safeId = safeChatKeyPart(chatId || resolveChatId());
    if (!safeId) return '';
    return `${nsDisk()}:${KEY_COLLAPSED_PAGES_SUFFIX}:${safeId}:v1`;
  }

  function keyPageLabelStyle() {
    return `${nsDisk()}:${KEY_PAGE_LABEL_STYLE_SUFFIX}`;
  }

  function keyPageDividers() {
    return `${nsDisk()}:${KEY_PAGE_DIVIDERS_SUFFIX}`;
  }

  function keyChatPageDividers() {
    return `${nsDisk()}:${KEY_CHAT_PAGE_DIVIDERS_SUFFIX}`;
  }

  function makeMiniDividerId() {
    return `divider:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`;
  }

  function clampMiniDividerRatio(value, fallback = 0.5) {
    const ratio = Number(value);
    if (!Number.isFinite(ratio)) return fallback;
    return Math.min(1, Math.max(0, ratio));
  }

  function normalizeMiniDividerStyle(raw) {
    const style = String(raw || '').trim().toLowerCase();
    return style === 'dashed' || style === 'dotted' ? style : 'solid';
  }

  function normalizeMiniDividerColor(raw, fallback = MINI_DIVIDER_DEFAULT_COLOR) {
    const value = String(raw || '').trim().toLowerCase();
    if (/^#?[0-9a-f]{3}$/i.test(value)) {
      const hex = value.replace(/^#/, '');
      return `#${hex.split('').map((ch) => ch + ch).join('')}`;
    }
    if (/^#?[0-9a-f]{6}$/i.test(value)) {
      return `#${value.replace(/^#/, '')}`;
    }
    return String(fallback || MINI_DIVIDER_DEFAULT_COLOR).trim().toLowerCase();
  }

  function normalizeMiniDividerRecord(raw, fallbackYRatio = null, chatId = '') {
    const rawRatio = raw?.yRatio ?? raw?.ratio ?? raw?.y ?? fallbackYRatio;
    const hasRatio = Number.isFinite(Number(rawRatio));
    const gapId = String(raw?.gapId || raw?.anchorId || raw?.gap || '').trim();
    const rawSlot =
      raw?.afterTurnIndex ??
      raw?.position ??
      raw?.after ??
      0;
    const slot = Math.max(0, Number(rawSlot) || 0);
    if (!hasRatio && !slot && !gapId) return null;
    const resolvedChatId = String(chatId || raw?.chatId || resolveChatId() || '').trim();
    return {
      id: String(raw?.id || raw?.dividerId || '').trim() || makeMiniDividerId(),
      chatId: resolvedChatId,
      gapId,
      yRatio: hasRatio ? clampMiniDividerRatio(rawRatio) : null,
      afterTurnIndex: slot,
      style: normalizeMiniDividerStyle(raw?.style || raw?.lineStyle || raw?.type || ''),
      color: normalizeMiniDividerColor(raw?.color || raw?.lineColor || raw?.hex || ''),
    };
  }

  function normalizeMiniDividerList(records, chatId = '') {
    const src = Array.isArray(records) ? records : [];
    const byId = new Map();
    for (let i = 0; i < src.length; i += 1) {
      const item = normalizeMiniDividerRecord(src[i], null, chatId);
      if (!item) continue;
      byId.set(String(item.id || '').trim(), item);
    }
    return Array.from(byId.values()).sort((a, b) => {
      const aRatio = Number.isFinite(Number(a?.yRatio)) ? Number(a.yRatio) : Infinity;
      const bRatio = Number.isFinite(Number(b?.yRatio)) ? Number(b.yRatio) : Infinity;
      if (aRatio !== bRatio) return aRatio - bRatio;
      const aSlot = Number(a?.afterTurnIndex || 0);
      const bSlot = Number(b?.afterTurnIndex || 0);
      if (aSlot !== bSlot) return aSlot - bSlot;
      return String(a?.id || '').localeCompare(String(b?.id || ''));
    });
  }

  function loadMiniDividers(chatId = '') {
    const id = String(chatId || resolveChatId()).trim();
    if (!id) return [];
    const key = keyCustomDividers(id);
    if (!key) return [];
    return normalizeMiniDividerList(storageGetJSON(key, []), id);
  }

  function saveMiniDividers(chatId = '', items = []) {
    const id = String(chatId || resolveChatId()).trim();
    if (!id) return { ok: false, status: 'chat-id-missing', chatId: '', items: [] };
    const key = keyCustomDividers(id);
    if (!key) return { ok: false, status: 'key-missing', chatId: id, items: [] };
    const nextItems = normalizeMiniDividerList(items, id);
    const ok = storageSetJSON(key, nextItems);
    return {
      ok,
      status: ok ? 'ok' : 'storage-failed',
      chatId: id,
      items: nextItems,
    };
  }

  function getMiniDividers(chatId = '') {
    return loadMiniDividers(chatId);
  }

  function normalizeMiniMapPageLabelStyle(_raw) {
    return PAGE_LABEL_STYLE_PILL;
  }

  function normalizeMiniMapPageDividersEnabled(raw, fallback = true) {
    if (typeof raw === 'boolean') return raw;
    const value = String(raw ?? '').trim().toLowerCase();
    if (!value) return !!fallback;
    if (value === '0' || value === 'false' || value === 'off' || value === 'hidden' || value === 'no') return false;
    if (value === '1' || value === 'true' || value === 'on' || value === 'show' || value === 'yes') return true;
    return !!fallback;
  }

  function normalizeChatPageDividersEnabled(raw, fallback = true) {
    return normalizeMiniMapPageDividersEnabled(raw, fallback);
  }

  function normalizeMiniMapCollapsedPages(raw) {
    const src = Array.isArray(raw) ? raw : [];
    const seen = new Set();
    const out = [];
    for (const item of src) {
      const pageNum = Math.max(1, Number(item || 0) || 0);
      if (!pageNum || seen.has(pageNum)) continue;
      seen.add(pageNum);
      out.push(pageNum);
    }
    out.sort((a, b) => a - b);
    return out;
  }

  function getMiniMapPageLabelStyle() {
    return normalizeMiniMapPageLabelStyle(storageGetStr(keyPageLabelStyle(), PAGE_LABEL_STYLE_DEFAULT));
  }

  function getMiniMapPageDividersEnabled() {
    return normalizeMiniMapPageDividersEnabled(storageGetStr(keyPageDividers(), '1'), true);
  }

  function getChatPageDividersEnabled() {
    return normalizeChatPageDividersEnabled(storageGetStr(keyChatPageDividers(), '1'), true);
  }

  function readCollapsedMiniMapPages(chatId = '') {
    const id = String(chatId || resolveChatId()).trim();
    if (!id) return new Set();
    const cached = S.collapsedMiniMapPagesByChat.get(id);
    if (cached instanceof Set) return new Set(cached);
    const key = keyCollapsedPages(id);
    const next = new Set(normalizeMiniMapCollapsedPages(storageGetJSON(key, [])));
    S.collapsedMiniMapPagesByChat.set(id, next);
    return new Set(next);
  }

  function saveCollapsedMiniMapPages(chatId = '', pages = []) {
    const id = String(chatId || resolveChatId()).trim();
    if (!id) return { ok: false, status: 'chat-id-missing', chatId: '', pages: [] };
    const key = keyCollapsedPages(id);
    if (!key) return { ok: false, status: 'key-missing', chatId: id, pages: [] };
    const nextPages = normalizeMiniMapCollapsedPages(Array.isArray(pages) ? pages : Array.from(pages || []));
    S.collapsedMiniMapPagesByChat.set(id, new Set(nextPages));
    const ok = storageSetJSON(key, nextPages);
    return {
      ok,
      status: ok ? 'ok' : 'storage-failed',
      chatId: id,
      pages: nextPages,
    };
  }

  function getMiniMapCollapsedPages(chatId = '') {
    return Array.from(readCollapsedMiniMapPages(chatId));
  }

  function isMiniMapPageCollapsed(pageNum = 0, chatId = '') {
    const num = Math.max(1, Number(pageNum || 0) || 0);
    if (!num) return false;
    return readCollapsedMiniMapPages(chatId).has(num);
  }

  function applyMiniMapPageUiPrefs(opts = {}) {
    const perfOwned = enterPerfOwner('incremental');
    const perfT0 = perfNow();
    try {
      const refs = MM_uiRefs();
      const root = refs?.root || getMiniMapRootEl();
      const panel = refs?.panel || minimapPanel();
      const labelStyle = PAGE_LABEL_STYLE_PILL;
      const dividersEnabled = normalizeMiniMapPageDividersEnabled(
        Object.prototype.hasOwnProperty.call(opts || {}, 'pageDividersEnabled')
          ? opts.pageDividersEnabled
          : getMiniMapPageDividersEnabled(),
        true
      );
      const chatPagesEnabled = normalizeChatPageDividersEnabled(
        Object.prototype.hasOwnProperty.call(opts || {}, 'chatPageDividersEnabled')
          ? opts.chatPageDividersEnabled
          : getChatPageDividersEnabled(),
        true
      );
      for (const el of [root, panel]) {
        if (!el) continue;
        try { el.setAttribute(ATTR_PAGE_LABEL_STYLE, labelStyle); } catch {}
        try { el.setAttribute(ATTR_PAGE_DIVIDERS, dividersEnabled ? '1' : '0'); } catch {}
      }
      try { document.documentElement.setAttribute(ATTR_CHAT_PAGE_DIVIDERS, chatPagesEnabled ? '1' : '0'); } catch {}
      try { renderChatPageDividers(resolveChatId()); } catch {}
      return { root, panel, pageLabelStyle: labelStyle, pageDividersEnabled: dividersEnabled, chatPageDividersEnabled: chatPagesEnabled };
    } finally {
      const ms = perfNow() - perfT0;
      recordDuration(PERF.paths.applyMiniMapPageUiPrefs, ms);
      if (perfOwned) {
        recordDuration(PERF.incrementalRefresh, ms);
        noteSummaryBucket(PERF.incrementalRefresh, 'applyMiniMapPageUiPrefs');
      }
      exitPerfOwner('incremental');
    }
  }

  function getMiniMapPageDivider(pageNum = 0, col = null) {
    const num = Math.max(1, Number(pageNum || 0) || 0);
    const track = col || minimapCol() || ensureCol();
    if (!track || !num) return null;
    return track.querySelector?.(`.cgxui-mm-page-divider[data-page-num="${String(num)}"]`) || null;
  }

  function setMiniMapPageDividerDomState(divider, collapsed = false) {
    if (!divider) return null;
    const on = !!collapsed;
    const pageNum = Math.max(1, Number(divider?.dataset?.pageNum || 0) || 1);
    if (on) divider.setAttribute('data-page-collapsed', '1');
    else divider.removeAttribute('data-page-collapsed');
    const label = divider.querySelector?.('.cgxui-mm-page-divider-label') || null;
    if (label) {
      label.setAttribute('aria-expanded', on ? 'false' : 'true');
      label.title = on
        ? `Page ${pageNum} collapsed. Double-click to expand.`
        : `Page ${pageNum}. Click to jump. Double-click to collapse.`;
    }
    return divider;
  }

  function setMiniMapPageWrapDomState(wrap, collapsed = false) {
    if (!wrap) return null;
    if (collapsed) wrap.setAttribute('data-page-collapsed', '1');
    else wrap.removeAttribute('data-page-collapsed');
    return wrap;
  }

  function applyMiniMapPageCollapsedState(pageNum = 0, collapsed = false, col = null) {
    const perfOwned = enterPerfOwner('incremental');
    const perfT0 = perfNow();
    try {
      const num = Math.max(1, Number(pageNum || 0) || 0);
      const track = col || minimapCol() || ensureCol();
      if (!track || !num) return false;
      const wraps = qq(`.cgxui-mm-wrap[data-page-num="${String(num)}"]`, track);
      for (const wrap of wraps) setMiniMapPageWrapDomState(wrap, collapsed);
      const divider = getMiniMapPageDivider(num, track);
      setMiniMapPageDividerDomState(divider, collapsed);
      noteRenderUnit('collapseVisualUpdates', wraps.length + (divider ? 1 : 0));
      return true;
    } finally {
      const ms = perfNow() - perfT0;
      recordDuration(PERF.paths.applyMiniMapPageCollapsedState, ms);
      if (perfOwned) {
        recordDuration(PERF.incrementalRefresh, ms);
        noteSummaryBucket(PERF.incrementalRefresh, 'applyMiniMapPageCollapsedState');
      }
      exitPerfOwner('incremental');
    }
  }

  function applyAllMiniMapPageCollapsedStates(chatId = '', col = null) {
    const perfOwned = enterPerfOwner('incremental');
    const perfT0 = perfNow();
    try {
      const track = col || minimapCol() || ensureCol();
      if (!track) return false;
      const collapsed = readCollapsedMiniMapPages(chatId);
      const wraps = qq('.cgxui-mm-wrap[data-page-num]', track);
      for (const wrap of wraps) {
        const pageNum = Math.max(1, Number(wrap?.dataset?.pageNum || 0) || 0);
        setMiniMapPageWrapDomState(wrap, collapsed.has(pageNum));
      }
      const dividers = qq('.cgxui-mm-page-divider[data-page-num]', track);
      for (const divider of dividers) {
        const pageNum = Math.max(1, Number(divider?.dataset?.pageNum || 0) || 0);
        setMiniMapPageDividerDomState(divider, collapsed.has(pageNum));
      }
      noteRenderUnit('collapseVisualUpdates', wraps.length + dividers.length);
      return true;
    } finally {
      const ms = perfNow() - perfT0;
      recordDuration(PERF.paths.applyAllMiniMapPageCollapsedStates, ms);
      if (perfOwned) {
        recordDuration(PERF.incrementalRefresh, ms);
        noteSummaryBucket(PERF.incrementalRefresh, 'applyAllMiniMapPageCollapsedStates');
      }
      exitPerfOwner('incremental');
    }
  }

  function normalizeMiniMapCollapseArgs(chatIdOrOpts = '', sourceOrOpts = 'core') {
    let chatId = '';
    let source = 'core';
    let opts = null;

    if (chatIdOrOpts && typeof chatIdOrOpts === 'object' && !Array.isArray(chatIdOrOpts)) {
      opts = chatIdOrOpts;
      chatId = String(chatIdOrOpts.chatId || '').trim();
      source = String(chatIdOrOpts.source || 'core').trim() || 'core';
    } else {
      chatId = String(chatIdOrOpts || '').trim();
      if (sourceOrOpts && typeof sourceOrOpts === 'object' && !Array.isArray(sourceOrOpts)) {
        opts = sourceOrOpts;
        source = String(sourceOrOpts.source || 'core').trim() || 'core';
        if (!chatId) chatId = String(sourceOrOpts.chatId || '').trim();
      } else {
        source = String(sourceOrOpts || 'core').trim() || 'core';
      }
    }

    return { chatId, source, opts: opts || Object.create(null) };
  }

  function setMiniMapPageCollapsed(pageNum = 0, collapsed = true, chatId = '', source = 'core') {
    const arg = normalizeMiniMapCollapseArgs(chatId, source);
    const id = String(arg.chatId || resolveChatId()).trim();
    const num = Math.max(1, Number(pageNum || 0) || 0);
    if (!id || !num) {
      return { ok: false, status: !id ? 'chat-id-missing' : 'page-missing', chatId: id, pageNum: num, collapsed: !!collapsed };
    }
    const nextCollapsed = !!collapsed;
    const set = readCollapsedMiniMapPages(id);
    if (nextCollapsed) set.add(num);
    else set.delete(num);
    const result = saveCollapsedMiniMapPages(id, Array.from(set));
    try { applyMiniMapPageCollapsedState(num, nextCollapsed, minimapCol()); } catch {}
    try { renderMiniDividerOverlay(id); } catch {}
    return Object.assign({}, result, {
      source: String(arg.source || 'core'),
      pageNum: num,
      collapsed: nextCollapsed,
    });
  }

  function toggleMiniMapPageCollapsed(pageNum = 0, chatId = '', source = 'core') {
    const arg = normalizeMiniMapCollapseArgs(chatId, source);
    const id = String(arg.chatId || resolveChatId()).trim();
    const num = Math.max(1, Number(pageNum || 0) || 0);
    const nextCollapsed = !isMiniMapPageCollapsed(num, id);
    return setMiniMapPageCollapsed(num, nextCollapsed, id, { source: String(arg.source || 'core'), propagate: arg.opts?.propagate });
  }

  function setMiniMapPageLabelStyle(_value, source = 'core') {
    const next = PAGE_LABEL_STYLE_PILL;
    const ok = storageSetStr(keyPageLabelStyle(), next);
    applyMiniMapPageUiPrefs({ pageLabelStyle: next });
    return { ok, status: ok ? 'ok' : 'storage-failed', source: String(source || 'core'), value: next };
  }

  function setMiniMapPageDividersEnabled(value, source = 'core') {
    const next = normalizeMiniMapPageDividersEnabled(value, true);
    const ok = storageSetStr(keyPageDividers(), next ? '1' : '0');
    applyMiniMapPageUiPrefs({ pageDividersEnabled: next });
    try { renderMiniDividerOverlay(resolveChatId()); } catch {}
    return { ok, status: ok ? 'ok' : 'storage-failed', source: String(source || 'core'), enabled: next };
  }

  function setChatPageDividersEnabled(value, source = 'core') {
    const next = normalizeChatPageDividersEnabled(value, true);
    const ok = storageSetStr(keyChatPageDividers(), next ? '1' : '0');
    applyMiniMapPageUiPrefs({ chatPageDividersEnabled: next });
    return { ok, status: ok ? 'ok' : 'storage-failed', source: String(source || 'core'), enabled: next };
  }

  function coreFallback_readCollapsedChatPages(chatId = '') {
    const id = String(chatId || resolveChatId()).trim();
    if (!id) return new Set();
    const cached = S.collapsedChatPagesByChat.get(id);
    return (cached instanceof Set) ? new Set(cached) : new Set();
  }

  function coreFallback_isChatPageCollapsed(pageNum = 0, chatId = '') {
    const num = Math.max(1, Number(pageNum || 0) || 0);
    return coreFallback_readCollapsedChatPages(chatId).has(num);
  }

  function coreFallback_setChatPageCollapsed(pageNum = 0, collapsed = true, chatId = '', source = 'core') {
    const id = String(chatId || resolveChatId()).trim();
    const num = Math.max(1, Number(pageNum || 0) || 0);
    if (!id) {
      return { ok: false, status: 'chat-id-missing', chatId: id, pageNum: num, collapsed: !!collapsed };
    }
    const nextCollapsed = !!collapsed;
    const next = readCollapsedChatPages(id);
    if (nextCollapsed) next.add(num);
    else next.delete(num);
    S.collapsedChatPagesByChat.set(id, next);
    try { renderChatPageDividers(id); } catch {}
    try { setMiniMapPageCollapsed(num, nextCollapsed, id, { source: 'chat-sync', propagate: true }); } catch {}
    return {
      ok: true,
      status: 'ok',
      source: String(source || 'core'),
      chatId: id,
      pageNum: num,
      collapsed: nextCollapsed,
    };
  }

  function coreFallback_toggleChatPageCollapsed(pageNum = 0, chatId = '', source = 'core') {
    const id = String(chatId || resolveChatId()).trim();
    const num = Math.max(1, Number(pageNum || 0) || 0);
    const nextCollapsed = !coreFallback_isChatPageCollapsed(num, id);
    return coreFallback_setChatPageCollapsed(num, nextCollapsed, id, source);
  }

  // Manual divider storage helpers. Legacy MiniDivider names remain for compatibility.
  function getMiniDividerById(dividerId, chatId = '') {
    const id = String(dividerId || '').trim();
    if (!id) return null;
    return loadMiniDividers(chatId).find((item) => String(item?.id || '').trim() === id) || null;
  }

  function getMiniDividerByAfterTurn(afterTurnIndex, chatId = '') {
    const slot = Math.max(0, Number(afterTurnIndex || 0) || 0);
    if (!slot) return null;
    const list = loadMiniDividers(chatId);
    return list.find((item) => Number(item?.afterTurnIndex || 0) === slot) || null;
  }

  function getSelectedMiniDividerId() {
    return String(S.selectedMiniDividerId || '').trim();
  }

  function emitMiniDividerChanged(detail = {}) {
    const out = {
      chatId: String(detail?.chatId || resolveChatId() || '').trim(),
      dividerId: String(detail?.dividerId || '').trim(),
      action: String(detail?.action || 'update').trim(),
      source: String(detail?.source || 'core').trim(),
      item: detail?.item || null,
      items: Array.isArray(detail?.items) ? detail.items.slice() : undefined,
    };
    try { window.dispatchEvent(new CustomEvent(EV_MM_DIVIDER_CHANGED, { detail: out })); } catch {}
    return out;
  }

  function emitMiniDividerSelected(detail = {}) {
    const out = {
      chatId: String(detail?.chatId || resolveChatId() || '').trim(),
      dividerId: String(detail?.dividerId || '').trim(),
      source: String(detail?.source || 'core').trim(),
    };
    try { window.dispatchEvent(new CustomEvent(EV_MM_DIVIDER_SELECTED, { detail: out })); } catch {}
    return out;
  }

  function setSelectedMiniDividerId(dividerId = '', opts = {}) {
    const nextId = String(dividerId || '').trim();
    const prevId = String(S.selectedMiniDividerId || '').trim();
    S.selectedMiniDividerId = nextId;
    if (opts.render !== false) {
      try { renderMiniDividerOverlay(String(opts.chatId || resolveChatId() || '').trim()); } catch {}
    }
    if (opts.emit !== false && nextId !== prevId) {
      emitMiniDividerSelected({
        chatId: String(opts.chatId || resolveChatId() || '').trim(),
        dividerId: nextId,
        source: String(opts.source || 'core').trim(),
      });
    }
    return nextId;
  }

  function selectMiniDivider(dividerId = '', chatId = '', source = 'core') {
    const item = getMiniDividerById(dividerId, chatId);
    const nextId = String(item?.id || '').trim();
    setSelectedMiniDividerId(nextId, {
      chatId: String(chatId || resolveChatId() || '').trim(),
      source,
      render: true,
      emit: true,
    });
    return item || null;
  }

  function upsertMiniDivider(record = {}, chatId = '') {
    const id = String(chatId || resolveChatId()).trim();
    const existing = getMiniDividerById(record?.id || record?.dividerId || '', id);
    const merged = Object.assign({}, existing || {}, record || {});
    const item = normalizeMiniDividerRecord(merged, existing?.yRatio ?? null, id);
    if (!item) return { ok: false, status: 'position-missing', chatId: id, item: null, items: [] };
    const list = loadMiniDividers(id).filter((entry) => String(entry?.id || '').trim() !== item.id);
    list.push(item);
    const saved = saveMiniDividers(id, list);
    if (saved.ok) {
      setSelectedMiniDividerId(item.id, { chatId: id, source: 'core:update', render: false, emit: true });
      try { renderMiniDividerOverlay(id); } catch {}
      emitMiniDividerChanged({
        chatId: id,
        dividerId: item.id,
        action: existing ? 'update' : 'create',
        source: 'core:update',
        item,
        items: saved.items,
      });
    }
    return Object.assign({}, saved, { item });
  }

  function createMiniDivider(record = {}, chatId = '') {
    const id = String(chatId || resolveChatId()).trim();
    const model = getMiniDividerGapModel();
    const defaultGap = getDefaultMiniDividerGap(model);
    const seed = Object.assign({
      gapId: String(defaultGap?.id || '').trim(),
      yRatio: Number.isFinite(Number(defaultGap?.ratio)) ? Number(defaultGap.ratio) : null,
      style: 'solid',
      color: MINI_DIVIDER_DEFAULT_COLOR,
    }, record || {});
    const hasPlacement =
      String(seed?.gapId || '').trim() ||
      Number.isFinite(Number(seed?.yRatio)) ||
      Math.max(0, Number(seed?.afterTurnIndex || 0) || 0);
    if (!hasPlacement) {
      return { ok: false, status: 'gap-missing', chatId: id, item: null, items: loadMiniDividers(id) };
    }
    return upsertMiniDivider(seed, id);
  }

  function removeMiniDividerById(dividerId, chatId = '') {
    const id = String(chatId || resolveChatId()).trim();
    const dividerKey = String(dividerId || '').trim();
    if (!id) return { ok: false, status: 'chat-id-missing', chatId: '', items: [] };
    if (!dividerKey) return { ok: false, status: 'divider-id-missing', chatId: id, items: loadMiniDividers(id) };
    const list = loadMiniDividers(id).filter((entry) => String(entry?.id || '').trim() !== dividerKey);
    const saved = saveMiniDividers(id, list);
    if (saved.ok) {
      if (String(S.selectedMiniDividerId || '').trim() === dividerKey) {
        setSelectedMiniDividerId('', { chatId: id, source: 'core:remove', render: false, emit: true });
      }
      try { renderMiniDividerOverlay(id); } catch {}
      emitMiniDividerChanged({
        chatId: id,
        dividerId: dividerKey,
        action: 'remove',
        source: 'core:remove',
        items: saved.items,
      });
    }
    return saved;
  }

  function removeMiniDividerByAfterTurn(afterTurnIndex, chatId = '') {
    const id = String(chatId || resolveChatId()).trim();
    const slot = Math.max(0, Number(afterTurnIndex || 0) || 0);
    if (!id) return { ok: false, status: 'chat-id-missing', chatId: '', items: [] };
    if (!slot) return { ok: false, status: 'position-missing', chatId: id, items: loadMiniDividers(id) };
    const match = getMiniDividerByAfterTurn(slot, id);
    if (!match?.id) return { ok: false, status: 'divider-missing', chatId: id, items: loadMiniDividers(id) };
    return removeMiniDividerById(match.id, id);
  }

  function normalizeCacheTurnRow(raw, fallbackIdx = 0) {
    const i = Math.max(1, Number(raw?.idx || raw?.index || fallbackIdx || 1) || 1);
    const answerId = String(raw?.answerId || raw?.primaryAId || raw?.aId || '').trim();
    const turnId = String(raw?.turnId || raw?.id || (answerId ? `turn:a:${answerId}` : `turn:${i}`)).trim();
    if (!turnId) return null;
    return {
      idx: i,
      turnId,
      answerId,
      primaryAId: answerId,
    };
  }

  function normalizeCacheTurnRows(rows) {
    const src = Array.isArray(rows) ? rows : [];
    const out = [];
    const seen = new Set();
    for (let i = 0; i < src.length; i += 1) {
      const row = normalizeCacheTurnRow(src[i], i + 1);
      if (!row) continue;
      const key = String(row.answerId || row.turnId || '').trim();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      row.idx = out.length + 1;
      out.push(row);
    }
    return out;
  }

  function enrichCacheTurnRowsFromPagination(rows) {
    const base = normalizeCacheTurnRows(rows);
    if (!base.length) return base;

    const canonical = getCanonicalTurnsFromPagination();
    const canonicalList = Array.isArray(canonical?.list) ? canonical.list : [];
    if (!canonicalList.length) return base;

    const canonicalByTurnId = new Map();
    const canonicalByAnswerId = new Map();
    for (const turn of canonicalList) {
      const turnId = String(turn?.turnId || '').trim();
      const answerId = normalizePaginationAnswerId(turn?.answerId || turn?.primaryAId || '');
      if (turnId) canonicalByTurnId.set(turnId, turn);
      if (answerId) canonicalByAnswerId.set(answerId, turn);
    }

    return base.map((row, idx) => {
      const answerId = normalizePaginationAnswerId(row?.answerId || row?.primaryAId || row?.aId || '');
      const turnId = String(row?.turnId || row?.id || '').trim();
      const canonicalTurn =
        canonicalByTurnId.get(turnId)
        || (answerId ? canonicalByAnswerId.get(answerId) : null)
        || canonicalList[idx]
        || null;
      if (!canonicalTurn) return row;

      const nextAnswerId = normalizePaginationAnswerId(canonicalTurn?.answerId || canonicalTurn?.primaryAId || answerId);
      const nextTurnId = String(canonicalTurn?.turnId || turnId || '').trim();

      return {
        ...row,
        idx: Math.max(1, Number(row?.idx || row?.index || idx + 1) || idx + 1),
        turnId: nextTurnId || turnId,
        answerId: nextAnswerId || answerId,
        primaryAId: nextAnswerId || answerId,
      };
    });
  }

  function minimapPanel() {
    const { SEL } = getRegs();
    try {
      const { panel: refsPanel } = MM_uiRefs();
      if (refsPanel && refsPanel.isConnected) return refsPanel;
    } catch {}
    const all = [
      ...qq(SEL.MINIMAP || ''),
      ...qq(SEL.PANEL || ''),
      ...qq('[data-cgxui$="minimap"]'),
    ].filter((el) => el && el.isConnected);
    if (!all.length) return null;
    return all[all.length - 1] || null;
  }

  function minimapCol(panelEl = null) {
    const { SEL } = getRegs();
    const root = panelEl && panelEl.querySelector ? panelEl : document;
    return q(SEL.MM_COL, root) ||
      q(`[data-cgxui="${UI_TOK.COL}"][data-cgxui-owner="${UI_TOK.OWNER}"]`, root) ||
      q(`[data-cgxui="${UI_TOK.COL_LEGACY}"][data-cgxui-owner="${UI_TOK.OWNER}"]`, root) ||
      q('.cgxui-mm-col', root);
  }

  function ensureCol() {
    let panel = minimapPanel();
    if (!panel) {
      try {
        panel = MM_ui()?.ensureUI?.('core:ensure-col')?.panel || minimapPanel();
      } catch {}
    }
    if (!panel) return null;

    let col = minimapCol(panel);
    if (col) return col;

    col = document.createElement('div');
    col.className = 'cgxui-mm-col';
    col.setAttribute('data-cgxui-owner', UI_TOK.OWNER);
    col.setAttribute('data-cgxui', UI_TOK.COL);
    panel.appendChild(col);
    return col;
  }

  function ensureMapStore() {
    if (S.mapButtons instanceof Map) return S.mapButtons;
    const m =
      (W.H2O_MM_mapButtons instanceof Map) ? W.H2O_MM_mapButtons :
      (W.mapButtons instanceof Map) ? W.mapButtons :
      new Map();
    return setMapStore(m);
  }

  function setMapStore(nextMap) {
    const incoming = (nextMap instanceof Map) ? nextMap : new Map();
    const live =
      (S.mapButtons instanceof Map) ? S.mapButtons :
      (W.H2O_MM_mapButtons instanceof Map) ? W.H2O_MM_mapButtons :
      (W.mapButtons instanceof Map) ? W.mapButtons :
      null;
    const m = live || incoming;
    if (m !== incoming) {
      const entries = Array.from(incoming.entries());
      m.clear();
      for (const [key, value] of entries) m.set(key, value);
    }
    S.mapButtons = m;
    try { W.H2O_MM_mapButtons = m; } catch {}
    try { W.mapButtons = m; } catch {}
    return m;
  }

  function replaceArrayContents(target, nextItems) {
    const out = Array.isArray(target) ? target : [];
    const items = (out === nextItems) ? nextItems.slice() : (Array.isArray(nextItems) ? nextItems : []);
    out.length = 0;
    for (const item of items) out.push(item);
    return out;
  }

  function replaceMapContents(target, nextMap) {
    const out = (target instanceof Map) ? target : new Map();
    const entries = (out === nextMap)
      ? Array.from(nextMap.entries())
      : Array.from((nextMap instanceof Map ? nextMap : new Map()).entries());
    out.clear();
    for (const [key, value] of entries) out.set(key, value);
    return out;
  }

  function publishTurnSnapshot(snapshot = null) {
    const next = snapshot && typeof snapshot === 'object' ? snapshot : {};
    const list = Array.isArray(next.list) ? next.list : [];
    const byId = (next.byId instanceof Map) ? next.byId : new Map();
    const byAId = (next.byAId instanceof Map) ? next.byAId : new Map();
    const answerByTurn = (next.answerByTurn instanceof Map) ? next.answerByTurn : new Map();
    const answers = Array.isArray(next.answers) ? next.answers : [];

    S.turnList = replaceArrayContents(S.turnList, list);
    S.turnById = replaceMapContents(S.turnById, byId);
    S.turnIdByAId = replaceMapContents(S.turnIdByAId, byAId);
    S.answerByTurnId = replaceMapContents(S.answerByTurnId, answerByTurn);
    S.answerEls = replaceArrayContents(S.answerEls, answers);

    const byIdGlobal =
      (W.H2O_MM_turnById instanceof Map) ? W.H2O_MM_turnById :
      new Map();
    const byAIdGlobal =
      (W.H2O_MM_turnIdByAId instanceof Map) ? W.H2O_MM_turnIdByAId :
      new Map();
    replaceMapContents(byIdGlobal, byId);
    replaceMapContents(byAIdGlobal, byAId);
    try { W.H2O_MM_turnById = byIdGlobal; } catch {}
    try { W.H2O_MM_turnIdByAId = byAIdGlobal; } catch {}
    try { renderChatPageDividers(resolveChatId()); } catch {}

    return {
      list: S.turnList,
      byId: S.turnById,
      byAId: S.turnIdByAId,
      answerByTurn: S.answerByTurnId,
      answers: S.answerEls,
    };
  }

  function mmIdxNow() {
    const now = Date.now();
    return Number.isFinite(now) ? now : 0;
  }

  // Compatibility shim: keep shell/engine contracts stable while mm_index persistence is removed from Core.
  function mmIdxEmitHydrated(detail = {}) {
    const out = {
      chatId: String(detail?.chatId || '').trim(),
      source: String(detail?.source || 'core'),
      status: String(detail?.status || 'noop'),
      turnCount: Number(detail?.turnCount || 0),
      renderedCount: Number(detail?.renderedCount || 0),
      ts: Number(detail?.ts || mmIdxNow()),
    };
    try { window.dispatchEvent(new CustomEvent(EV_MM_INDEX_HYDRATED, { detail: out })); } catch {}
    return out;
  }

  function hydrateIndexFromDisk(chatId = '', opts = {}) {
    const detail = mmIdxEmitHydrated({
      chatId: String(chatId || '').trim(),
      source: String(opts?.source || 'core'),
      status: 'noop',
      turnCount: 0,
      renderedCount: 0,
    });
    return { ok: false, status: 'noop', detail };
  }

  function renderFromIndex(chatId = '', _idxObj = null, opts = {}) {
    return hydrateIndexFromDisk(chatId, opts);
  }

  function loadTurnCache(chatId = '') {
    const id = String(chatId || resolveChatId()).trim();
    if (!id) return null;
    const turnsKey = keyTurnCacheTurns(id);
    const metaKey = keyTurnCacheMeta(id);
    if (!turnsKey || !metaKey) return null;

    const turns = enrichCacheTurnRowsFromPagination(storageGetJSON(turnsKey, null));
    if (!turns.length) return null;

    const last = turns[turns.length - 1] || null;
    const rawMeta = storageGetJSON(metaKey, null);
    const meta = {
      chatId: id,
      turnCount: turns.length,
      lastTurnId: String(rawMeta?.lastTurnId || last?.turnId || '').trim(),
      updatedAt: Number(rawMeta?.updatedAt || 0) || mmIdxNow(),
    };
    const lastActiveTurnId = String(rawMeta?.lastActiveTurnId || '').trim();
    const lastActiveAnswerId = String(rawMeta?.lastActiveAnswerId || '').trim();
    if (lastActiveTurnId) meta.lastActiveTurnId = lastActiveTurnId;
    if (lastActiveAnswerId) meta.lastActiveAnswerId = lastActiveAnswerId;

    return { meta, turns };
  }

  function clearTurnCache(chatId = '') {
    const id = String(chatId || resolveChatId()).trim();
    if (!id) return { ok: false, status: 'chat-id-missing' };

    const turnsKey = keyTurnCacheTurns(id);
    const metaKey = keyTurnCacheMeta(id);
    if (!turnsKey || !metaKey) return { ok: false, status: 'key-missing' };

    const okTurns = storageRemove(turnsKey);
    const okMeta = storageRemove(metaKey);
    return {
      ok: !!(okTurns && okMeta),
      status: (okTurns && okMeta) ? 'ok' : 'remove-failed',
      chatId: id,
    };
  }

  function saveTurnCache(chatId = '', turns = []) {
    const id = String(chatId || resolveChatId()).trim();
    if (!id) return { ok: false, status: 'chat-id-missing' };

    const turnsKey = keyTurnCacheTurns(id);
    const metaKey = keyTurnCacheMeta(id);
    if (!turnsKey || !metaKey) return { ok: false, status: 'key-missing' };

    const rows = enrichCacheTurnRowsFromPagination(turns);
    if (!rows.length) return { ok: false, status: 'turns-empty', turnsCount: 0 };

    const last = rows[rows.length - 1] || null;
    const activeTurnId = String(S.lastActiveTurnIdFast || S.lastActiveBtnId || '').trim();
    const activeTurn = activeTurnId ? findTurnByAnyId(activeTurnId) : null;
    const activeAnswerId = String(activeTurn?.answerId || '').trim();
    const meta = {
      chatId: id,
      turnCount: rows.length,
      lastTurnId: String(last?.turnId || '').trim(),
      updatedAt: mmIdxNow(),
    };
    if (activeTurnId) meta.lastActiveTurnId = activeTurnId;
    if (activeAnswerId) meta.lastActiveAnswerId = activeAnswerId;

    const okTurns = storageSetJSON(turnsKey, rows);
    const okMeta = storageSetJSON(metaKey, meta);
    const ok = !!(okTurns && okMeta);
    return {
      ok,
      status: ok ? 'ok' : 'storage-failed',
      meta,
      turnsCount: rows.length,
    };
  }

  function renderFromCache(chatId = '') {
    const perfT0 = perfNow();
    try {
      const id = String(chatId || resolveChatId()).trim();
      if (!id) return { ok: false, renderedCount: 0, status: 'chat-id-missing' };

      const cached = loadTurnCache(id);
      if (!cached || !Array.isArray(cached.turns) || !cached.turns.length) {
        mmIdxEmitHydrated({
          chatId: id,
          source: 'cache',
          status: 'cache-miss',
          turnCount: 0,
          renderedCount: 0,
        });
        return { ok: false, renderedCount: 0, status: 'cache-miss', chatId: id, lastTurnId: '', lastAnswerId: '' };
      }

      const ensured = ensureUiRefsForRebuild('cache-render');
      if (!ensured.ready) {
        return { ok: false, renderedCount: 0, status: 'ui-missing', chatId: id, lastTurnId: '', lastAnswerId: '' };
      }

      const list = [];
      const byId = new Map();
      const byAId = new Map();
      for (const row of cached.turns) {
        const turnId = String(row?.turnId || '').trim();
        if (!turnId) continue;
        const answerId = String(row?.primaryAId || row?.answerId || '').trim();
        const idx = Math.max(1, Number(row?.idx || 0) || (list.length + 1));
        const turn = { turnId, answerId, index: idx, el: null };
        list.push(turn);
        byId.set(turnId, turn);
        if (answerId) byAId.set(answerId, turnId);
      }

      if (!list.length) {
        return { ok: false, renderedCount: 0, status: 'cache-empty', chatId: id, lastTurnId: '', lastAnswerId: '' };
      }

      const snapshot = {
        list,
        byId,
        byAId,
        answerByTurn: new Map(),
        answers: [],
      };

      const map = ensureTurnButtons(snapshot.list, { skipActiveSync: true });
      const renderedCount = Number(list.length || 0);
      const last = cached.turns[cached.turns.length - 1] || null;
      const lastTurnId = String(last?.turnId || '').trim();
      const lastAnswerId = String(last?.primaryAId || last?.answerId || '').trim();
      const paginationCoverage = validateTurnsAgainstPagination(list, { source: 'cache-render' });
      if (map instanceof Map) publishTurnSnapshot(snapshot);
      const activeHint = String(
        cached?.meta?.lastActiveTurnId ||
        cached?.meta?.lastActiveAnswerId ||
        S.lastActiveTurnIdFast ||
        cached?.meta?.lastTurnId ||
        lastTurnId ||
        lastAnswerId
      ).trim();
      if (map instanceof Map && activeHint) {
        try { setActive(activeHint, 'cache-render'); } catch {}
      } else if (map instanceof Map) {
        try { updateCounter(''); } catch {}
      }

      mmIdxEmitHydrated({
        chatId: id,
        source: 'cache',
        status: 'cache-hit',
        turnCount: renderedCount,
        renderedCount,
      });
      return {
        ok: !!(map instanceof Map) && renderedCount > 0,
        renderedCount,
        status: renderedCount > 0 ? 'ok' : 'cache-empty',
        chatId: id,
        lastTurnId,
        lastAnswerId,
        paginationCoverage,
      };
    } finally {
      recordDuration(PERF.paths.renderFromCache, perfNow() - perfT0);
    }
  }

  function appendTurnFromAnswerEl(_chatId = '', _answerEl = null, _opts = {}) {
    const perfOwned = enterPerfOwner('incremental');
    const perfT0 = perfNow();
    try {
      const chatId = String(_chatId || resolveChatId()).trim();
      const source = String(_opts?.source || 'core:append').trim();
      const rootEl = (_answerEl && _answerEl.nodeType === 1) ? _answerEl : null;
      if (!rootEl) {
        bumpReason(PERF.incrementalRefresh.appendTurnStatuses, 'noop');
        return { ok: false, status: 'noop' };
      }

      const answerEl = pickAssistantMessageEl(rootEl);
      if (!answerEl) {
        bumpReason(PERF.incrementalRefresh.appendTurnStatuses, 'ignored');
        return { ok: false, status: 'ignored' };
      }
      if (!answerEl.isConnected) {
        bumpReason(PERF.incrementalRefresh.appendTurnStatuses, 'stale');
        return { ok: false, status: 'stale' };
      }

      const ensured = ensureUiRefsForRebuild('append-turn');
      if (!ensured.ready) {
        bumpReason(PERF.incrementalRefresh.appendTurnStatuses, 'uiMissing');
        return { ok: false, status: 'ui-missing' };
      }

      if (!S.turnList.length) indexTurns();

      const answerId = String(getMessageId(answerEl) || '').trim();
      if (!answerId) {
        bumpReason(PERF.incrementalRefresh.appendTurnStatuses, 'noop');
        return { ok: false, status: 'noop' };
      }
      let turnId = String(S.turnIdByAId.get(answerId) || '').trim();
      if (!turnId) turnId = String(parseTurnId(answerEl, S.turnList.length + 1, answerId) || `turn:a:${answerId}`).trim();
      if (!turnId) {
        bumpReason(PERF.incrementalRefresh.appendTurnStatuses, 'noop');
        return { ok: false, status: 'noop' };
      }

      const existing = findTurnByAnyId(turnId) || findTurnByAnyId(answerId);
      if (existing) {
        const existingTurnId = String(existing.turnId || turnId).trim();
        if (!existingTurnId) {
          bumpReason(PERF.incrementalRefresh.appendTurnStatuses, 'error');
          return { ok: false, status: 'error' };
        }
        if (!existing.answerId) existing.answerId = answerId;
        existing.el = answerEl;
        S.turnById.set(existingTurnId, existing);
        if (answerId) S.turnIdByAId.set(answerId, existingTurnId);
        S.answerByTurnId.set(existingTurnId, answerEl);
        if (!S.answerEls.length || S.answerEls[S.answerEls.length - 1] !== answerEl) {
          if (!S.answerEls.includes(answerEl)) S.answerEls.push(answerEl);
        }
        const map = ensureMapStore();
        let btn = map.get(existingTurnId) || null;
        if (!btn) {
          const col = ensureCol();
          if (!col) {
            bumpReason(PERF.incrementalRefresh.appendTurnStatuses, 'uiMissing');
            return { ok: false, status: 'ui-missing' };
          }
          const made = createBtn(existing);
          btn = made.btn;
          try { col.appendChild(made.wrap); } catch {}
          noteNodeLifecycle('repaired', 'answerRows');
          noteNodeLifecycle('created', 'answerRows');
          noteNodeLifecycle('created', 'answerButtons');
        } else {
          noteNodeLifecycle('reused', 'answerRows');
          noteNodeLifecycle('reused', 'answerButtons');
        }
        if (btn) {
          syncTurnRowDom(btn, existing, { qaEnabled: isQaViewActive() });
          map.set(existingTurnId, btn);
          const symbolMeta = getMarginSymbolMetaForAnswer(answerId);
          updateMiniMapGutterSymbol(btn, symbolMeta.symbols, { color: String(symbolMeta.colors[0] || '').trim() });
          repaintMiniBtnByAnswerId(answerId || existingTurnId, btn);
          noteRenderUnit('answerRows');
          noteRenderUnit('answerButtons');
          noteRenderUnit('gutterSymbols');
        }
        try { renderChatPageDividers(chatId); } catch {}
        bumpReason(PERF.incrementalRefresh.appendTurnStatuses, 'exists');
        return {
          ok: true,
          status: 'exists',
          chatId,
          source,
          turnId: existingTurnId,
          answerId,
          idx: Number(existing.index || 0),
        };
      }

      const lastKnownAnswer = S.answerEls[S.answerEls.length - 1] || null;
      if (lastKnownAnswer && lastKnownAnswer.isConnected && lastKnownAnswer !== answerEl) {
        try {
          const rel = lastKnownAnswer.compareDocumentPosition(answerEl);
          const follows = !!(rel & Node.DOCUMENT_POSITION_FOLLOWING);
          if (!follows) {
            bumpReason(PERF.incrementalRefresh.appendTurnStatuses, 'nonMonotonic');
            return { ok: false, status: 'non-monotonic', chatId, source, turnId, answerId };
          }
        } catch {}
      }

      const nextIdx = Math.max(1, Number(S.turnList.length || 0) + 1);
      const nextTurn = { turnId, answerId, index: nextIdx, el: answerEl };
      S.turnList.push(nextTurn);
      S.turnById.set(turnId, nextTurn);
      if (answerId) S.turnIdByAId.set(answerId, turnId);
      S.answerByTurnId.set(turnId, answerEl);
      S.answerEls.push(answerEl);

      const map = ensureMapStore();
      const col = ensureCol();
      if (!col) {
        bumpReason(PERF.incrementalRefresh.appendTurnStatuses, 'uiMissing');
        return { ok: false, status: 'ui-missing' };
      }
      const made = createBtn(nextTurn);
      const btn = made.btn;
      try { col.appendChild(made.wrap); } catch {}
      noteNodeLifecycle('created', 'answerRows');
      noteNodeLifecycle('created', 'answerButtons');
      noteRenderUnit('answerRows');
      noteRenderUnit('answerButtons');

      syncTurnRowDom(btn, nextTurn, { qaEnabled: isQaViewActive() });

      map.set(turnId, btn);

      const symbolMeta = getMarginSymbolMetaForAnswer(answerId);
      updateMiniMapGutterSymbol(btn, symbolMeta.symbols, { color: String(symbolMeta.colors[0] || '').trim() });
      repaintMiniBtnByAnswerId(answerId || turnId, btn);
      noteRenderUnit('gutterSymbols');
      try { W.syncMiniMapDot?.(answerId); } catch {}
      try { W.H2O_MM_syncQuoteBadgesForIdx?.(btn, nextIdx); } catch {}
      try {
        if (chatId) saveTurnCache(chatId, S.turnList);
      } catch {}
      try {
        window.dispatchEvent(new CustomEvent(EV_MM_INDEX_APPENDED, {
          detail: {
            chatId,
            source,
            turnId,
            answerId,
            msgId: answerId,
            idx: nextIdx,
          },
        }));
      } catch {}
      try { renderChatPageDividers(chatId); } catch {}
      bumpReason(PERF.incrementalRefresh.appendTurnStatuses, 'appended');

      return {
        ok: true,
        status: 'appended',
        chatId,
        source,
        turnId,
        answerId,
        idx: nextIdx,
      };
    } finally {
      const ms = perfNow() - perfT0;
      recordDuration(PERF.paths.appendTurnFromAnswerEl, ms);
      if (perfOwned) {
        recordDuration(PERF.incrementalRefresh, ms);
        noteSummaryBucket(PERF.incrementalRefresh, 'appendTurnFromAnswerEl');
      }
      exitPerfOwner('incremental');
    }
  }

  function attachVisibleAnswers(_chatId = '', root = null) {
    const host = (root && root.querySelectorAll) ? root : document;
    const { SEL } = getRegs();
    const sel = SEL.ANSWER || STUDIO_SEL.sel.assistantTurnTagged;
    const answers = qq(sel, host);
    if (!answers.length) return { ok: false, status: 'empty', attached: 0 };

    let attached = 0;
    const attachedEls = [];
    for (const el of answers) {
      const aid = String(getMessageId(el) || '').trim();
      if (!aid) continue;
      const turnId = String(S.turnIdByAId.get(aid) || '').trim();
      if (!turnId) continue;
      const turn = S.turnById.get(turnId) || null;
      if (turn) turn.el = el;
      S.answerByTurnId.set(turnId, el);
      attached += 1;
      attachedEls.push(el);
    }
    if (attachedEls.length) S.answerEls = attachedEls;
    return { ok: attached > 0, status: attached > 0 ? 'ok' : 'empty', attached };
  }

  function storageApi() {
    try { return getRegs()?.SH?.util?.storage || null; } catch { return null; }
  }

  function storageGetJSON(key, fallback = null) {
    const k = String(key || '').trim();
    if (!k) return fallback;
    const storage = storageApi();
    if (storage && typeof storage.getJSON === 'function') {
      try {
        const parsed = storage.getJSON(k, fallback);
        return parsed == null ? fallback : parsed;
      } catch {}
    }
    try {
      const raw = localStorage.getItem(k);
      if (raw == null) return fallback;
      const parsed = JSON.parse(raw);
      return parsed == null ? fallback : parsed;
    } catch {
      return fallback;
    }
  }

  function storageGetStr(key, fallback = '') {
    const k = String(key || '').trim();
    if (!k) return fallback;
    const storage = storageApi();
    if (storage && typeof storage.getStr === 'function') {
      try {
        const value = storage.getStr(k, null);
        return value == null ? fallback : String(value);
      } catch {}
    }
    try {
      const raw = localStorage.getItem(k);
      return raw == null ? fallback : String(raw);
    } catch {
      return fallback;
    }
  }

  function storageSetJSON(key, val) {
    const k = String(key || '').trim();
    if (!k) return false;
    const storage = storageApi();
    if (storage && typeof storage.setJSON === 'function') {
      try { return !!storage.setJSON(k, val); } catch {}
    }
    try {
      localStorage.setItem(k, JSON.stringify(val));
      return true;
    } catch {
      return false;
    }
  }

  function storageSetStr(key, val) {
    const k = String(key || '').trim();
    if (!k) return false;
    const storage = storageApi();
    if (storage && typeof storage.setStr === 'function') {
      try { return !!storage.setStr(k, String(val)); } catch {}
    }
    try {
      localStorage.setItem(k, String(val));
      return true;
    } catch {
      return false;
    }
  }

  function storageRemove(key) {
    const k = String(key || '').trim();
    if (!k) return false;
    const storage = storageApi();
    if (storage && typeof storage.remove === 'function') {
      try {
        storage.remove(k);
        return true;
      } catch {}
    }
    if (storage && typeof storage.del === 'function') {
      try {
        storage.del(k);
        return true;
      } catch {}
    }
    if (storage && typeof storage.removeItem === 'function') {
      try {
        storage.removeItem(k);
        return true;
      } catch {}
    }
    try {
      localStorage.removeItem(k);
      return true;
    } catch {
      return false;
    }
  }

  function normalizeSymbols(symbols) {
    if (!Array.isArray(symbols)) return [];
    const out = [];
    for (const sym of symbols) {
      const s = String(sym || '').trim();
      if (s) out.push(s);
    }
    return out;
  }

  function normalizeColors(colors) {
    if (!Array.isArray(colors)) return [];
    return colors.map((c) => String(c || '').trim());
  }

  function collectSymbolEntriesFromBuckets(buckets) {
    const rows = Array.isArray(buckets) ? buckets : [];
    const picked = [];
    let seq = 0;
    for (const b of rows) {
      const items = Array.isArray(b?.items)
        ? b.items
        : ((b?.items && typeof b.items === 'object') ? Object.values(b.items) : []);
      for (const it of items) {
        if (!it || it.type !== 'symbol') continue;
        const sym = String(it?.data?.symbol || '').trim();
        if (!sym) continue;
        const color = String(it?.data?.color || it?.ui?.color || '').trim();
        const ts = Number(it?.ts);
        seq += 1;
        picked.push({
          sym,
          color,
          ts: Number.isFinite(ts) ? ts : Number.MAX_SAFE_INTEGER,
          seq,
        });
      }
    }
    if (!picked.length) return [];
    picked.sort((a, b) => (a.ts - b.ts) || (a.seq - b.seq));
    return picked.map((x) => ({ symbol: x.sym, color: String(x.color || '').trim() }));
  }

  function collectSymbolsFromBuckets(buckets) {
    return collectSymbolEntriesFromBuckets(buckets).map((x) => x.symbol);
  }

  function collectSymbolColorsFromBuckets(buckets) {
    return collectSymbolEntriesFromBuckets(buckets).map((x) => x.color);
  }

  function marginSymbolsMapKey() {
    const key =
      TOPW?.H2O?.MA?.mrgnnchr?.api?.core?.keys?.KEY_MANCHOR_SYMBOLS_V1 ||
      TOPW?.H2O?.KEYS?.MRGNNCHR_SYMBOLS_V1 ||
      KEY_MARGIN_SYMBOLS_FALLBACK;
    return String(key || KEY_MARGIN_SYMBOLS_FALLBACK).trim();
  }

  function marginPinsStoreKey() {
    const key =
      TOPW?.H2O?.MA?.mrgnnchr?.api?.core?.keys?.KEY_MANCHOR_STATE_PINS_V1 ||
      TOPW?.H2O?.KEYS?.MRGNNCHR_STATE_PINS_V1 ||
      KEY_MARGIN_PINS_FALLBACK;
    return String(key || KEY_MARGIN_PINS_FALLBACK).trim();
  }

  function marginSymbolColorsMapKey() {
    const key =
      TOPW?.H2O?.MA?.mrgnnchr?.api?.core?.keys?.KEY_MANCHOR_SYMBOL_COLORS_V1 ||
      TOPW?.H2O?.KEYS?.MRGNNCHR_SYMBOL_COLORS_V1 ||
      KEY_MARGIN_SYMBOL_COLORS_FALLBACK;
    return String(key || KEY_MARGIN_SYMBOL_COLORS_FALLBACK).trim();
  }

  function loadMarginSymbolsMap() {
    const map = storageGetJSON(marginSymbolsMapKey(), null);
    if (!map || typeof map !== 'object' || Array.isArray(map)) return null;
    return map;
  }

  function loadMarginSymbolColorsMap() {
    const map = storageGetJSON(marginSymbolColorsMapKey(), null);
    if (!map || typeof map !== 'object' || Array.isArray(map)) return null;
    return map;
  }

  function buildMarginSymbolMetaMapFromPinsStore() {
    const store = storageGetJSON(marginPinsStoreKey(), null);
    if (!store || typeof store !== 'object' || Array.isArray(store)) return Object.create(null);
    const out = Object.create(null);
    for (const [answerId, buckets] of Object.entries(store)) {
      const id = String(answerId || '').trim();
      if (!id) continue;
      const bucketList = Array.isArray(buckets)
        ? buckets
        : ((buckets && typeof buckets === 'object') ? Object.values(buckets) : []);
      const symbols = collectSymbolsFromBuckets(bucketList);
      if (!symbols.length) continue;
      const colors = collectSymbolColorsFromBuckets(bucketList);
      out[id] = { symbols, colors };
    }
    return out;
  }

  function getMarginSymbolMetaMap() {
    const symbolsMap = loadMarginSymbolsMap();
    if (symbolsMap) {
      const colorsMap = loadMarginSymbolColorsMap();
      const pinsMetaMap = colorsMap ? null : buildMarginSymbolMetaMapFromPinsStore();
      const colorsSource = colorsMap || Object.create(null);
      const out = Object.create(null);
      for (const [answerId, symbolsRaw] of Object.entries(symbolsMap)) {
        const id = String(answerId || '').trim();
        if (!id) continue;
        const symbols = normalizeSymbols(symbolsRaw);
        if (!symbols.length) continue;
        const colors = normalizeColors(
          colorsSource[id] ?? pinsMetaMap?.[id]?.colors ?? []
        );
        out[id] = { symbols, colors };
      }
      return out;
    }
    return buildMarginSymbolMetaMapFromPinsStore();
  }

  function getMarginSymbolMetaForAnswer(answerId, symbolMetaMap = null) {
    const id = String(answerId || '').trim();
    if (!id) return { symbols: [], colors: [] };
    const map = (symbolMetaMap && typeof symbolMetaMap === 'object' && !Array.isArray(symbolMetaMap))
      ? symbolMetaMap
      : getMarginSymbolMetaMap();
    const raw = map?.[id];
    if (Array.isArray(raw)) return { symbols: normalizeSymbols(raw), colors: [] };
    return {
      symbols: normalizeSymbols(raw?.symbols),
      colors: normalizeColors(raw?.colors),
    };
  }

  function getMarginSymbolsForAnswer(answerId, symbolMetaMap = null) {
    return getMarginSymbolMetaForAnswer(answerId, symbolMetaMap).symbols;
  }

  function ensureMiniMapGutter(btnRow) {
    if (!btnRow || typeof btnRow !== 'object') return null;
    const wrap = btnRow.matches?.('[data-cgxui="mnmp-wrap"], [data-cgxui="mm-wrap"], .cgxui-mm-wrap')
      ? btnRow
      : btnRow.closest?.('[data-cgxui="mnmp-wrap"], [data-cgxui="mm-wrap"], .cgxui-mm-wrap');
    if (!wrap) return null;

    let gutter = wrap.querySelector('.cgxui-mm-gutter');
    if (!gutter) {
      gutter = document.createElement('div');
      gutter.className = 'cgxui-mm-gutter';
      wrap.appendChild(gutter);
    }

    let sym = gutter.querySelector('.cgxui-mm-gutterSym');
    if (!sym) {
      sym = document.createElement('span');
      sym.className = 'cgxui-mm-gutterSym';
      gutter.appendChild(sym);
    }
    return { wrap, gutter, sym };
  }

  function updateMiniMapGutterSymbol(btnRow, symbols, opts = null) {
    const mounted = ensureMiniMapGutter(btnRow);
    if (!mounted) return false;

    const first = normalizeSymbols(symbols)[0] || '';
    const color = String(opts?.color || '').trim();

    const maApi = TOPW?.H2O?.MA?.mrgnnchr?.api?.core;

    if (maApi && maApi.symbols?.buildViewModel && maApi.symbols?.resolveSemanticId) {
        mounted.sym.textContent = '';
        const symbolId = first ? maApi.symbols.resolveSemanticId(first, first) : '';

        if (symbolId) {
            const vm = maApi.symbols.buildViewModel(symbolId, color, '');
            if (vm && vm.svgBody) {
                const flipStyle = vm.symbolId === 'arrow' ? 'transform: scaleX(-1); transform-origin: 50% 50%;' : '';
                mounted.sym.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vm.viewBox}" fill="none" aria-hidden="true" focusable="false" style="width: 100%; height: 100%; ${flipStyle}">${vm.svgBody}</svg>`;
            }
        }
    } else {
        if (mounted.sym.textContent !== first) mounted.sym.textContent = first;
    }

    if (first) mounted.gutter.setAttribute('data-has-symbol', '1');
    else mounted.gutter.removeAttribute('data-has-symbol');

    if (!first) {
      if (mounted.sym.style.color) mounted.sym.style.color = '';
      return true;
    }
    if (color) {
      if (mounted.sym.style.color !== color) mounted.sym.style.color = color;
    } else if (mounted.sym.style.color) {
      mounted.sym.style.color = '';
    }
    return true;
  }

  function syncMiniMapGutterForAnswer(answerId, symbols = null, colors = null) {
    const id = String(answerId || '').trim();
    if (!id) return false;
    const btn = getBtnById(id) || findMiniBtn(id);
    if (!btn) return false;

    const hasSymbols = Array.isArray(symbols);
    const hasColors = Array.isArray(colors);
    const meta = (!hasSymbols || !hasColors) ? getMarginSymbolMetaForAnswer(id) : null;
    const nextSymbols = hasSymbols ? normalizeSymbols(symbols) : (meta?.symbols || []);
    const nextColors = hasColors ? normalizeColors(colors) : (meta?.colors || []);
    return updateMiniMapGutterSymbol(btn, nextSymbols, { color: String(nextColors[0] || '').trim() });
  }

  function flushMiniMapGutterQueue() {
    const perfOwned = enterPerfOwner('incremental');
    const perfT0 = perfNow();
    try {
      S.gutterSyncRaf = 0;
      const entries = Array.from(S.gutterSyncQueue.entries());
      S.gutterSyncQueue.clear();
      for (const [answerId, payload] of entries) {
        try {
          syncMiniMapGutterForAnswer(answerId, payload?.symbols ?? null, payload?.colors ?? null);
        } catch {}
      }
      if (entries.length) noteRenderUnit('gutterSymbols', entries.length);
    } finally {
      const ms = perfNow() - perfT0;
      recordDuration(PERF.paths.flushMiniMapGutterQueue, ms);
      if (perfOwned) {
        recordDuration(PERF.incrementalRefresh, ms);
        noteSummaryBucket(PERF.incrementalRefresh, 'flushMiniMapGutterQueue');
      }
      exitPerfOwner('incremental');
    }
  }

  function scheduleMiniMapGutterSync(answerId, symbols = null, colors = null) {
    const id = String(answerId || '').trim();
    if (!id) return;
    const hasSymbols = Array.isArray(symbols);
    const hasColors = Array.isArray(colors);
    const prev = S.gutterSyncQueue.get(id) || { symbols: null, colors: null };
    const next = {
      symbols: hasSymbols ? normalizeSymbols(symbols) : prev.symbols,
      colors: hasColors ? normalizeColors(colors) : prev.colors,
    };
    if (!hasSymbols && !hasColors && !S.gutterSyncQueue.has(id)) {
      next.symbols = null;
      next.colors = null;
    }
    S.gutterSyncQueue.set(id, next);
    if (S.gutterSyncRaf) return;
    S.gutterSyncRaf = requestAnimationFrame(flushMiniMapGutterQueue);
  }

  function bindMarginSymbolsBridge() {
    if (S.marginSymbolsBridgeBound) return true;

    const onMarginSymbolsChanged = (ev) => {
      const detail = ev?.detail || {};
      const answerId = String(detail.answerId || '').trim();
      if (!answerId) return;
      const symbols = Array.isArray(detail.symbols) ? detail.symbols : null;
      const colors = Array.isArray(detail.colors) ? detail.colors : null;
      scheduleMiniMapGutterSync(answerId, symbols, colors);
    };

    window.addEventListener(EV_MARGIN_SYMBOLS_CHANGED, onMarginSymbolsChanged);
    if (EV_MARGIN_SYMBOLS_CHANGED.startsWith('evt:')) {
      window.addEventListener(EV_MARGIN_SYMBOLS_CHANGED.slice(4), onMarginSymbolsChanged);
    }

    S.marginSymbolsBridgeOff = () => {
      try { window.removeEventListener(EV_MARGIN_SYMBOLS_CHANGED, onMarginSymbolsChanged); } catch {}
      if (EV_MARGIN_SYMBOLS_CHANGED.startsWith('evt:')) {
        try { window.removeEventListener(EV_MARGIN_SYMBOLS_CHANGED.slice(4), onMarginSymbolsChanged); } catch {}
      }
    };
    S.marginSymbolsBridgeBound = true;
    return true;
  }

  function unbindMarginSymbolsBridge() {
    try { S.marginSymbolsBridgeOff?.(); } catch {}
    S.marginSymbolsBridgeOff = null;
    S.marginSymbolsBridgeBound = false;
  }

  function getTurnRuntimeApi() {
    return TOPW?.H2O?.turnRuntime || W?.H2O?.turnRuntime || null;
  }

  function projectSharedTurnRecord(record, fallbackIndex = 0) {
    const turnId = String(record?.turnId || '').trim();
    if (!turnId) return null;
    const answerId = String(record?.primaryAId || record?.answerId || '').trim();
    const questionId = String(record?.qId || record?.questionId || '').trim();
    const index = Math.max(1, Number(record?.turnNo || record?.idx || fallbackIndex || 1) || 1);
    const el = record?.live?.primaryAEl || record?.primaryAEl || null;
    const questionEl = record?.live?.qEl || record?.qEl || null;
    return { turnId, answerId, questionId, index, el: el || null, questionEl: questionEl || null };
  }

  function projectCanonicalTurnRecord(record, fallbackIndex = 0) {
    const turnId = String(record?.turnId || record?.id || '').trim();
    if (!turnId) return null;
    const answerId = String(record?.answerId || record?.primaryAId || record?.aId || '').trim();
    const questionId = String(record?.questionId || record?.qId || '').trim();
    const index = Math.max(1, Number(record?.index || record?.idx || record?.turnNo || fallbackIndex || 1) || 1);
    const el = record?.el || record?.primaryAEl || record?.answerEl || record?.live?.primaryAEl || null;
    const questionEl = record?.questionEl || record?.qEl || record?.live?.qEl || null;
    return { turnId, answerId, questionId, index, el: el || null, questionEl: questionEl || null };
  }

  function getPublishedTurnByIdMap() {
    try {
      return (W.H2O_MM_turnById instanceof Map) ? W.H2O_MM_turnById : null;
    } catch {
      return null;
    }
  }

  function getPublishedTurnIdByAIdMap() {
    try {
      return (W.H2O_MM_turnIdByAId instanceof Map) ? W.H2O_MM_turnIdByAId : null;
    } catch {
      return null;
    }
  }

  function getExistingMapStore() {
    try {
      if (S.mapButtons instanceof Map) return S.mapButtons;
      if (W.H2O_MM_mapButtons instanceof Map) return W.H2O_MM_mapButtons;
      if (W.mapButtons instanceof Map) return W.mapButtons;
    } catch {}
    return null;
  }

  function canonicalLookupCandidates(anyId) {
    const key = String(anyId || '').trim();
    if (!key) return [];
    const out = [];
    const push = (value) => {
      const next = String(value || '').trim();
      if (next && !out.includes(next)) out.push(next);
    };
    push(key);
    if (key.startsWith('turn:')) push(key.slice(5));
    else push(`turn:${key}`);
    return out;
  }

  function lookupCanonicalTurnByTurnId(turnId) {
    const key = String(turnId || '').trim();
    if (!key) return null;
    if (S.turnById instanceof Map && S.turnById.has(key)) {
      return S.turnById.get(key) || null;
    }
    if (Array.isArray(S.turnList) && S.turnList.length) {
      const fromList = S.turnList.find((turn) => String(turn?.turnId || '').trim() === key) || null;
      if (fromList) return fromList;
    }
    const published = getPublishedTurnByIdMap();
    if (published?.has?.(key)) {
      return projectCanonicalTurnRecord(published.get(key), 0);
    }
    return null;
  }

  function lookupCanonicalTurnIdByAnswerId(answerId) {
    const key = String(answerId || '').trim();
    if (!key) return '';
    if (S.turnIdByAId instanceof Map) {
      const direct = String(S.turnIdByAId.get(key) || '').trim();
      if (direct) return direct;
    }
    if (Array.isArray(S.turnList) && S.turnList.length) {
      const fromList = S.turnList.find((turn) => String(turn?.answerId || '').trim() === key) || null;
      const turnId = String(fromList?.turnId || '').trim();
      if (turnId) return turnId;
    }
    const published = getPublishedTurnIdByAIdMap();
    const mapped = String(published?.get?.(key) || '').trim();
    if (mapped) return mapped;
    const publishedById = getPublishedTurnByIdMap();
    if (publishedById?.size) {
      for (const turn of publishedById.values()) {
        const fromMap = projectCanonicalTurnRecord(turn, 0);
        if (String(fromMap?.answerId || '').trim() === key) {
          return String(fromMap?.turnId || '').trim();
        }
      }
    }
    return mapped;
  }

  function hasCanonicalTurnSnapshotState() {
    return !!(
      (Array.isArray(S.turnList) && S.turnList.length)
      || (S.turnById instanceof Map && S.turnById.size)
      || (S.turnIdByAId instanceof Map && S.turnIdByAId.size)
      || (getPublishedTurnByIdMap()?.size)
      || (getPublishedTurnIdByAIdMap()?.size)
    );
  }

  function compareCanonicalTurns(a, b) {
    const ai = Math.max(0, Number(a?.index || 0) || 0);
    const bi = Math.max(0, Number(b?.index || 0) || 0);
    if (ai !== bi) return ai - bi;
    return String(a?.turnId || '').localeCompare(String(b?.turnId || ''));
  }

  function buildCanonicalSnapshotFromTurns(source = null, opts = {}) {
    const rows = Array.isArray(source)
      ? source.slice()
      : ((source instanceof Map) ? Array.from(source.values()) : []);
    if (!rows.length) return null;

    const answerByTurnSource = (opts.answerByTurn instanceof Map) ? opts.answerByTurn : null;
    const answersSource = Array.isArray(opts.answers) ? opts.answers.filter(Boolean) : [];
    const byAIdSource = (opts.byAId instanceof Map) ? opts.byAId : null;
    const reverseAnswerByTurn = new Map();
    if (byAIdSource) {
      for (const [answerId, turnId] of byAIdSource.entries()) {
        const aid = String(answerId || '').trim();
        const tid = String(turnId || '').trim();
        if (aid && tid && !reverseAnswerByTurn.has(tid)) reverseAnswerByTurn.set(tid, aid);
      }
    }

    if (source instanceof Map) {
      rows.sort((a, b) => compareCanonicalTurns(
        projectCanonicalTurnRecord(a, 0),
        projectCanonicalTurnRecord(b, 0)
      ));
    }

    const list = [];
    const byId = new Map();
    const byAId = new Map();
    const answerByTurn = new Map();
    const answers = [];
    const seenAnswers = new Set();

    for (let i = 0; i < rows.length; i += 1) {
      const turn = projectCanonicalTurnRecord(rows[i], i + 1);
      if (!turn) continue;
      if (!turn.answerId) {
        const fallbackAnswerId = String(reverseAnswerByTurn.get(turn.turnId) || '').trim();
        if (fallbackAnswerId) turn.answerId = fallbackAnswerId;
      }
      if (byId.has(turn.turnId)) continue;
      list.push(turn);
      byId.set(turn.turnId, turn);
      if (turn.answerId && !byAId.has(turn.answerId)) byAId.set(turn.answerId, turn.turnId);
      const attached = answerByTurnSource?.get?.(turn.turnId) || turn.el || null;
      if (attached) {
        answerByTurn.set(turn.turnId, attached);
        if (!seenAnswers.has(attached)) {
          seenAnswers.add(attached);
          answers.push(attached);
        }
      }
    }

    if (!list.length) return null;
    return {
      list,
      byId,
      byAId,
      answerByTurn,
      answers: answers.length ? answers : answersSource,
    };
  }

  function getBestCanonicalSnapshot() {
    const fromState =
      buildCanonicalSnapshotFromTurns(S.turnList, {
        byAId: S.turnIdByAId,
        answerByTurn: S.answerByTurnId,
        answers: S.answerEls,
      })
      || buildCanonicalSnapshotFromTurns(S.turnById, {
        byAId: S.turnIdByAId,
        answerByTurn: S.answerByTurnId,
        answers: S.answerEls,
      });
    if (fromState?.list?.length) return fromState;

    const publishedById = getPublishedTurnByIdMap();
    const publishedByAId = getPublishedTurnIdByAIdMap();
    return buildCanonicalSnapshotFromTurns(publishedById, {
      byAId: publishedByAId,
      answerByTurn: S.answerByTurnId,
      answers: S.answerEls,
    });
  }

  function recoverMiniBtnFromDom(anyId, resolvedTurnId = '') {
    const key = String(anyId || '').trim();
    const turnId = String(resolvedTurnId || '').trim();
    const root = minimapCol(MM_uiRefs()?.panel || null) || minimapCol() || minimapPanel() || null;
    if (!root) return null;

    const ids = [];
    const push = (value) => {
      const next = String(value || '').trim();
      if (next && !ids.includes(next)) ids.push(next);
    };
    push(turnId);
    push(key);

    let btn = null;
    for (const id of ids) {
      const esc = escAttr(id);
      btn = q(`[data-cgxui="mnmp-btn"][data-turn-id="${esc}"]`, root)
        || q(`[data-cgxui="mnmp-btn"][data-id="${esc}"]`, root)
        || q(`[data-cgxui="mnmp-btn"][data-primary-a-id="${esc}"]`, root)
        || q(`[data-cgxui="mm-btn"][data-turn-id="${esc}"]`, root)
        || q(`[data-cgxui="mm-btn"][data-id="${esc}"]`, root)
        || q(`[data-cgxui="mm-btn"][data-primary-a-id="${esc}"]`, root)
        || null;
      if (btn) break;
    }
    if (!btn) return null;

    const canonicalTurnId = String(
      turnId
      || btn?.dataset?.turnId
      || lookupCanonicalTurnIdByAnswerId(String(btn?.dataset?.primaryAId || '').trim())
      || ''
    ).trim();
    if (canonicalTurnId) {
      try { ensureMapStore().set(canonicalTurnId, btn); } catch {}
    }
    return btn;
  }

  function getCanonicalTurnsFromSharedRuntime() {
    const api = getTurnRuntimeApi();
    if (!api) return null;

    let records = [];
    try {
      if (typeof api.listTurns === 'function') {
        records = api.listTurns() || [];
      } else if (typeof api.listTurnRecords === 'function') {
        records = api.listTurnRecords() || [];
      }
    } catch {
      records = [];
    }
    if (!Array.isArray(records) || !records.length) return null;

    const list = [];
    const byId = new Map();
    const byAId = new Map();
    const answerByTurn = new Map();
    const answers = [];

    for (let i = 0; i < records.length; i += 1) {
      const turn = projectSharedTurnRecord(records[i], i + 1);
      if (!turn) continue;
      list.push(turn);
      byId.set(turn.turnId, turn);
      if (turn.answerId) byAId.set(turn.answerId, turn.turnId);
      if (turn.el) {
        answerByTurn.set(turn.turnId, turn.el);
        answers.push(turn.el);
      }
    }

    return list.length ? { list, byId, byAId, answerByTurn, answers } : null;
  }

  function getAuthoritativeTurnSnapshot() {
    const runtimeCanonical = getCanonicalTurnsFromSharedRuntime();
    const paginationCanonical = getCanonicalTurnsFromPagination();
    if (runtimeCanonical?.list?.length) {
      if (shouldUseSharedRuntimeCanonical(runtimeCanonical, paginationCanonical)) {
        return runtimeCanonical;
      }
    }
    if (paginationCanonical?.list?.length) return paginationCanonical;

    const turnApi = TOPW?.H2O?.turn || W?.H2O?.turn || null;
    let apiTurns = null;
    try {
      apiTurns = (typeof turnApi?.getTurns === 'function') ? (turnApi.getTurns() || null) : null;
    } catch {
      apiTurns = null;
    }
    const turnsCanonical = buildCanonicalTurnCollection(apiTurns, { requireAnswer: true });
    if (turnsCanonical?.list?.length) return turnsCanonical;

    const domCanonical = buildCanonicalTurnCollection(getAnswerEls(), { requireAnswer: true });
    if (domCanonical?.list?.length) return domCanonical;

    return {
      list: [],
      byId: new Map(),
      byAId: new Map(),
      answerByTurn: new Map(),
      answers: [],
    };
  }

  function hasCanonicalAssistantTurnShape(turn) {
    const answerId = normalizePaginationAnswerId(turn?.answerId || '');
    if (!answerId) return false;
    return String(turn?.turnId || '').trim() === `turn:a:${answerId}`;
  }

  function shouldUseSharedRuntimeCanonical(sharedCanonical, paginationCanonical) {
    const sharedList = Array.isArray(sharedCanonical?.list) ? sharedCanonical.list : [];
    if (!sharedList.length) return false;

    let paginationEnabled = false;
    try {
      const info = W?.H2O_Pagination?.getPageInfo?.();
      if (info && typeof info.enabled === 'boolean') paginationEnabled = !!info.enabled;
    } catch {}

    const canonicalList = Array.isArray(paginationCanonical?.list) ? paginationCanonical.list : [];
    if (!paginationEnabled || !canonicalList.length) return true;

    const sharedAnswerTurns = sharedList.filter((turn) => !!normalizePaginationAnswerId(turn?.answerId || ''));
    if (sharedAnswerTurns.length < canonicalList.length) return false;

    const checkCount = Math.min(getPaginationPageSizeHint(), canonicalList.length);
    for (let i = 0; i < checkCount; i += 1) {
      const sharedTurn = sharedAnswerTurns[i] || null;
      const sharedAnswerId = normalizePaginationAnswerId(sharedTurn?.answerId || '');
      const canonicalAnswerId = normalizePaginationAnswerId(canonicalList[i]?.answerId || '');
      if (!hasCanonicalAssistantTurnShape(sharedTurn)) return false;
      if (!sharedAnswerId || !canonicalAnswerId || sharedAnswerId !== canonicalAnswerId) return false;
    }

    return true;
  }

  function getSharedTurnRecordByAnyId(anyId) {
    const api = getTurnRuntimeApi();
    const key = String(anyId || '').trim();
    if (!api || !key) return null;
    try {
      return api.getTurnRecordByTurnId?.(key)
        || api.getTurnRecordByAId?.(key)
        || api.getTurnRecordByQId?.(key)
        || null;
    } catch {
      return null;
    }
  }

  function isPaginationWindowingEnabled() {
    try {
      return !!W?.H2O_Pagination?.getPageInfo?.()?.enabled;
    } catch {
      return false;
    }
  }

  function isTurnOnCurrentPaginationPage(turnOrId, answerId = '') {
    if (!isPaginationWindowingEnabled()) return true;
    const turnId = (turnOrId && typeof turnOrId === 'object')
      ? String(turnOrId?.turnId || '').trim()
      : String(turnOrId || '').trim();
    const answerKey = String(answerId || (turnOrId && typeof turnOrId === 'object' ? turnOrId?.answerId || '' : '')).trim();
    const record = getSharedTurnRecordByAnyId(turnId || answerKey);
    const inCurrent = record?.page?.inCurrentPage;
    return (typeof inCurrent === 'boolean') ? inCurrent : true;
  }

  function indexTurns(opts = {}) {
    const authoritative = getAuthoritativeTurnSnapshot();
    const snapshot = {
      list: Array.isArray(authoritative?.list) ? authoritative.list.slice() : [],
      byId: authoritative?.byId instanceof Map ? authoritative.byId : new Map(),
      byAId: authoritative?.byAId instanceof Map ? authoritative.byAId : new Map(),
      answerByTurn: authoritative?.answerByTurn instanceof Map ? authoritative.answerByTurn : new Map(),
      answers: Array.isArray(authoritative?.answers) ? authoritative.answers.slice() : [],
    };
    if (opts?.commit === false) return snapshot;
    publishTurnSnapshot(snapshot);
    return S.turnList;
  }

  function getPaginationState() {
    try {
      return W?.H2O?.PW?.pgnwndw?.state || W?.H2O_Pagination?.state || null;
    } catch {
      return null;
    }
  }

  function normalizePaginationTurnId(raw, fallbackIdx = 0, answerId = '') {
    const direct = String(raw?.turnId || raw?.id || '').trim();
    if (direct) return direct;

    const uid = String(raw?.uid || raw?.turnUid || '').trim();
    if (uid) return uid.startsWith('turn:') ? uid : `turn:${uid}`;

    if (answerId) return `turn:a:${answerId}`;

    const idx = Math.max(1, Number(raw?.turnNo || raw?.gid || raw?.index || raw?.answerIndex || fallbackIdx || 1) || 1);
    return `pw-turn-${idx}`;
  }

  function normalizePaginationAnswerId(raw) {
    let id = String(raw || '').replace(/^conversation-turn-/, '').trim();
    if (!id) return '';
    if (id.startsWith('turn:a:')) id = id.slice(7).trim();
    else if (id.startsWith('turn:')) id = id.slice(5).trim();
    return id;
  }

  function buildCanonicalTurnCollection(rows, { requireAnswer = false } = {}) {
    const rt = getTurnRuntimeApi();
    const src = Array.isArray(rows) ? rows : [];
    if (!src.length) return null;

    const list = [];
    const byId = new Map();
    const byAId = new Map();
    const answerByTurn = new Map();
    const answers = [];
    const seen = new Set();

    for (const raw of src) {
      if (!raw) continue;

      let answerEl = raw?.primaryAEl || raw?.answerEl || raw?.el || null;
      if (!answerEl && raw?.node) answerEl = pickAssistantMessageEl(raw.node);
      if (!answerEl && raw?.nodeType === 1) answerEl = pickAssistantMessageEl(raw);

      let answerId = normalizePaginationAnswerId(raw?.answerId || raw?.primaryAId || raw?.aId || '');
      if (!answerId && answerEl) answerId = normalizePaginationAnswerId(getMessageId(answerEl) || '');
      if (requireAnswer && !answerId && !answerEl) continue;

      const fallbackIndex = list.length + 1;
      const turnIndex1 = (raw?.turnIndex != null)
        ? (Math.max(1, Number(raw?.turnIndex) + 1) || 0)
        : 0;

      // Priority 1: Core turnRuntime turnNo via answerId — correct Q+A pair
      // number (1..N), properly accounts for unanswered-turn gaps so button 20
      // = pair 20 even when pair 19 is unanswered.
      let canonicalIndex = 0;
      if (rt && answerId) {
        try {
          const coreRecord = rt.getTurnRecordByAId?.(answerId) || null;
          const coreTurnNo = Math.max(0, Number(coreRecord?.turnNo || coreRecord?.idx || 0) || 0);
          if (coreTurnNo > 0) canonicalIndex = coreTurnNo;
        } catch {}
      }
      // Priority 2: answerIndex from pagination — fallback when Core hasn't reconciled yet.
      if (!canonicalIndex) {
        const answerIndexRaw = Math.max(0, Number(raw?.answerIndex || 0) || 0);
        if (answerIndexRaw > 0) canonicalIndex = answerIndexRaw;
      }
      // Priority 3: other fields for non-pagination sources.
      if (!canonicalIndex) {
        canonicalIndex = Math.max(1, Number(
            raw?.turnNo
            || raw?.gid
            || raw?.index
            || raw?.idx
            || turnIndex1
            || fallbackIndex
          ) || fallbackIndex);
      }

      const turnId = normalizePaginationTurnId(raw, canonicalIndex, answerId);
      const dedupeKey = String(answerId || turnId || '').trim();
      if (!dedupeKey || seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);

      const turn = {
        turnId,
        answerId,
        index: canonicalIndex,
        turnNo: canonicalIndex,
        gid: canonicalIndex,
        el: answerEl || null,
      };
      list.push(turn);
      byId.set(turnId, turn);
      if (answerId) byAId.set(answerId, turnId);
      if (answerEl) {
        answerByTurn.set(turnId, answerEl);
        answers.push(answerEl);
      }
    }

    if (!list.length) return null;
    return { list, byId, byAId, answerByTurn, answers };
  }

  function getCanonicalTurnsFromPagination() {
    const ps = getPaginationState();
    const canonicalRows =
      (Array.isArray(ps?.masterTurnUnits) && ps.masterTurnUnits.length) ? ps.masterTurnUnits
        : (Array.isArray(ps?.canonicalTurns) && ps.canonicalTurns.length) ? ps.canonicalTurns
          : (Array.isArray(ps?.masterAnswers) && ps.masterAnswers.length) ? ps.masterAnswers
            : null;
    const canonical = buildCanonicalTurnCollection(canonicalRows, { requireAnswer: true });
    if (canonical?.list?.length) return canonical;

    const rawTurns = Array.isArray(ps?.masterTurns) ? ps.masterTurns : [];
    return buildCanonicalTurnCollection(rawTurns, { requireAnswer: true });
  }

  function getPaginationPageSizeHint() {
    try {
      const info = W?.H2O_Pagination?.getPageInfo?.();
      const fromInfo = Math.max(1, Number(info?.pageSize || 0) || 0);
      if (fromInfo > 0) return fromInfo;
    } catch {}
    const ps = getPaginationState();
    const candidates = [
      ps?.runtime?.pageSize,
      ps?.config?.pageSize,
      ps?.pageSize,
    ];
    for (const raw of candidates) {
      const n = Math.max(1, Number(raw || 0) || 0);
      if (n > 0) return n;
    }
    return 25;
  }

  function validateTurnsAgainstPagination(turns = S.turnList, opts = {}) {
    const canonical = getCanonicalTurnsFromPagination();
    const canonicalList = Array.isArray(canonical?.list) ? canonical.list : [];
    const enabled = (() => {
      try {
        const info = W?.H2O_Pagination?.getPageInfo?.();
        if (info && typeof info.enabled === 'boolean') return !!info.enabled;
      } catch {}
      return canonicalList.length > 0;
    })();
    if (!enabled && !canonicalList.length) {
      return { ok: true, applicable: false, reason: 'pagination-off', pageSize: 0, checkedCount: 0 };
    }
    if (!canonicalList.length) {
      return { ok: true, applicable: false, reason: 'canonical-unavailable', pageSize: getPaginationPageSizeHint(), checkedCount: 0 };
    }

    const list = Array.isArray(turns) ? turns : [];
    const pageSize = Math.max(1, Number(opts?.pageSize || getPaginationPageSizeHint() || 25) || 25);
    const checkedCount = Math.min(pageSize, canonicalList.length);
    if (!checkedCount) {
      return { ok: true, applicable: true, reason: 'empty-canonical', pageSize, checkedCount: 0 };
    }
    if (!list.length) {
      return {
        ok: false,
        applicable: true,
        reason: 'turns-empty',
        pageSize,
        checkedCount,
        missingAnswerCount: checkedCount,
        mismatchedAnswerCount: 0,
        missingTurnCount: 0,
        firstMismatchAt: 1,
      };
    }

    let missingAnswerCount = 0;
    let mismatchedAnswerCount = 0;
    let missingTurnCount = 0;
    let firstMismatchAt = 0;
    let firstExpectedAnswerId = '';
    let firstActualAnswerId = '';
    let firstExpectedTurnId = '';
    let firstActualTurnId = '';

    for (let i = 0; i < checkedCount; i += 1) {
      const expected = canonicalList[i] || null;
      const actual = list[i] || null;
      const expectedAnswerId = normalizePaginationAnswerId(expected?.answerId || expected?.primaryAId || '');
      const actualAnswerId = normalizePaginationAnswerId(actual?.answerId || actual?.primaryAId || actual?.aId || '');
      const expectedTurnId = String(expected?.turnId || '').trim();
      const actualTurnId = String(actual?.turnId || actual?.id || '').trim();

      let mismatch = false;
      if (!actual) {
        missingTurnCount += 1;
        mismatch = true;
      } else if (expectedAnswerId) {
        if (!actualAnswerId) {
          missingAnswerCount += 1;
          mismatch = true;
        } else if (actualAnswerId !== expectedAnswerId) {
          mismatchedAnswerCount += 1;
          mismatch = true;
        }
      } else if (expectedTurnId && actualTurnId !== expectedTurnId) {
        missingTurnCount += 1;
        mismatch = true;
      }

      if (mismatch && !firstMismatchAt) {
        firstMismatchAt = i + 1;
        firstExpectedAnswerId = expectedAnswerId;
        firstActualAnswerId = actualAnswerId;
        firstExpectedTurnId = expectedTurnId;
        firstActualTurnId = actualTurnId;
      }
    }

    const ok = missingAnswerCount === 0 && mismatchedAnswerCount === 0 && missingTurnCount === 0 && list.length >= checkedCount;
    return {
      ok,
      applicable: true,
      reason: ok ? 'ok' : 'first-page-mismatch',
      pageSize,
      checkedCount,
      missingAnswerCount,
      mismatchedAnswerCount,
      missingTurnCount,
      firstMismatchAt,
      firstExpectedAnswerId,
      firstActualAnswerId,
      firstExpectedTurnId,
      firstActualTurnId,
      totalTurns: list.length,
      totalCanonicalTurns: canonicalList.length,
    };
  }

  function getTurnPageBand(turnIndex) {
    const idx = Math.max(1, Number(turnIndex || 1));
    if (idx <= 25) return 'normal';
    if (idx <= 50) return 'teal';
    if (idx <= 75) return 'blue';
    if (idx <= 100) return 'darkred';
    return 'violet';
  }

  // MiniMap page divider: automatic structural divider inside the MiniMap track.
  function createMiniMapPageDivider(pageNum, band, collapsed = false) {
    const div = document.createElement('div');
    div.className = 'cgxui-mm-page-divider';
    div.setAttribute('data-page-band', String(band || 'normal'));
    div.setAttribute('data-page-num', String(pageNum || 1));
    div.innerHTML = `<span class="cgxui-mm-page-divider-line"></span><button type="button" class="cgxui-mm-page-divider-label" data-page-num="${String(pageNum || 1)}" data-page-band="${String(band || 'normal')}" aria-label="Go to Page ${String(pageNum || 1)}">Page ${pageNum}</button><span class="cgxui-mm-page-divider-line"></span>`;
    setMiniMapPageDividerDomState(div, collapsed);
    return div;
  }

  function ensureMiniDividerLayer(panel = null) {
    const host = panel || minimapPanel();
    if (!host) return null;
    let layer =
      host.querySelector?.(`[data-cgxui="${UI_TOK.DIVIDER_LAYER}"][data-cgxui-owner="${UI_TOK.OWNER}"]`) ||
      host.querySelector?.('.cgxui-mm-divider-layer') ||
      null;
    if (layer) return layer;
    layer = document.createElement('div');
    layer.className = 'cgxui-mm-divider-layer';
    layer.setAttribute('data-cgxui-owner', UI_TOK.OWNER);
    layer.setAttribute('data-cgxui', UI_TOK.DIVIDER_LAYER);
    host.appendChild(layer);
    return layer;
  }

  function getMiniDividerTrackMetrics(panel = null, col = null) {
    const host = panel || minimapPanel();
    const track = col || minimapCol(host);
    if (!host || !track || !track.isConnected) return null;
    const top = Number(track.offsetTop || 0) || 0;
    const height = Math.max(0, Number(track.offsetHeight || 0) || 0);
    if (!height) return null;
    return { panel: host, col: track, top, height };
  }

  function getMiniDividerRowMeta(row, idx = 0) {
    if (!row?.matches) return null;
    if (row.matches(`[data-cgxui="${UI_TOK.WRAP}"], [data-cgxui="${UI_TOK.WRAP_LEGACY}"], .cgxui-mm-wrap`)) {
      const turnId = String(row?.dataset?.turnId || '').trim();
      const turnIdx = Math.max(0, Number(row?.dataset?.turnIdx || 0) || 0);
      const keyCore = turnId || (turnIdx ? `idx:${turnIdx}` : `row:${idx}`);
      return {
        el: row,
        type: 'turn',
        key: `turn:${keyCore}`,
        turnId,
        turnIdx,
      };
    }
    if (row.matches('.cgxui-mm-page-divider')) {
      const pageNum = Math.max(1, Number(row?.dataset?.pageNum || 1) || 1);
      return {
        el: row,
        type: 'page-divider',
        key: `page:${pageNum}`,
        pageNum,
      };
    }
    return {
      el: row,
      type: 'row',
      key: `row:${idx}`,
    };
  }


  function isMiniDividerSurfaceVisible(el) {
    if (!el?.isConnected) return false;
    const w = Number(el.offsetWidth || 0) || 0;
    const h = Number(el.offsetHeight || 0) || 0;
    if (!(w > 0 && h > 0)) return false;

    const cs = getComputedStyle(el);
    if (!cs) return true;

    if (cs.display === 'none') return false;
    if (cs.visibility === 'hidden') return false;
    if ((Number(cs.opacity) || 0) <= 0.001) return false;

    return true;
  }

  function getMiniDividerRowBounds(meta) {
    const row = meta?.el || null;
    if (!row) return null;

    const rowTop = Number(row.offsetTop || 0) || 0;
    const rowBottom = rowTop + (Number(row.offsetHeight || 0) || 0);

    if (meta?.type !== 'turn') {
      return { top: rowTop, bottom: rowBottom };
    }

    const qBtn = getQuestionBtnForWrap(row);
    const aBtn =
      row.querySelector?.(`[data-cgxui="${UI_TOK.BTN}"]`) ||
      row.querySelector?.(`[data-cgxui="${UI_TOK.BTN_LEGACY}"]`) ||
      row.querySelector?.('.cgxui-mm-btn') ||
      null;

    const parts = [];

    // In Q+A view: use visible question + answer as one grouped snap surface.
    // In Classic view: qBtn should not exist, but even if it does, hidden ones are ignored.
    for (const el of [qBtn, aBtn]) {
      if (!isMiniDividerSurfaceVisible(el)) continue;

      const top = rowTop + (Number(el.offsetTop || 0) || 0);
      const bottom = top + (Number(el.offsetHeight || 0) || 0);

      if (!(bottom > top)) continue;
      parts.push({ top, bottom });
    }

    if (!parts.length) {
      return { top: rowTop, bottom: rowBottom };
    }

    return {
      top: Math.min(...parts.map((part) => part.top)),
      bottom: Math.max(...parts.map((part) => part.bottom)),
    };
  }

  function getMiniDividerGapModel(panel = null, col = null) {
    const info = getMiniDividerTrackMetrics(panel, col);
    if (!info) return null;

    // IMPORTANT:
    // Only turn rows are valid snap neighbors for custom dividers.
    // This excludes page dividers and any other non-turn rows.
    const rows = Array.from(info.col.children || [])
      .map((row, idx) => getMiniDividerRowMeta(row, idx))
      .filter((meta) => meta && meta.type === 'turn');

    const gaps = [];
    const centerRatio = Math.max(
      0,
      Math.min(1, Number(MINI_DIVIDER_LAYOUT.GAP_CENTER_RATIO ?? 0.5) || 0.5)
    );
    const upperClearance = Math.max(
      0,
      Number(MINI_DIVIDER_LAYOUT.UPPER_BOX_CLEARANCE_PX ?? 0) || 0
    );
    const lowerClearance = Math.max(
      0,
      Number(MINI_DIVIDER_LAYOUT.LOWER_BOX_CLEARANCE_PX ?? 0) || 0
    );

    for (let i = 0; i < rows.length - 1; i += 1) {
      const before = rows[i];
      const after = rows[i + 1];

      const beforeBounds = getMiniDividerRowBounds(before);
      const afterBounds = getMiniDividerRowBounds(after);

      if (!beforeBounds || !afterBounds) continue;

      const beforeBottom = Number(beforeBounds.bottom || 0);
      const afterTop = Number(afterBounds.top || 0);
      const gapHeight = afterTop - beforeBottom;

      if (!(gapHeight > 0)) continue;

      // True target inside the real turn-to-turn gap
      const desiredY = beforeBottom + (gapHeight * centerRatio);

      // Safety clamps
      const safeMinY = beforeBottom + upperClearance;
      const safeMaxY = afterTop - lowerClearance;

      let y = desiredY;

      if (safeMaxY >= safeMinY) {
        y = Math.min(safeMaxY, Math.max(safeMinY, desiredY));
      } else {
        // If the clearances are too large for this gap,
        // fall back to the raw geometric center of the TURN gap,
        // not some other row model.
        y = beforeBottom + (gapHeight * 0.5);
      }

      const ratio = clampMiniDividerRatio(y / Math.max(1, info.height));

      gaps.push({
        id: `gap:${before.key}::${after.key}`,
        index: gaps.length + 1,
        y,
        ratio,
        before,
        after,
        gapHeight,
        beforeBottom,
        afterTop,
      });
    }

    return { metrics: info, rows, gaps };
  }

  function findNearestMiniDividerGap(targetRatio, model = null) {
    const gapModel = model || getMiniDividerGapModel();
    const gaps = Array.isArray(gapModel?.gaps) ? gapModel.gaps : [];
    if (!gaps.length) return null;
    const ratio = clampMiniDividerRatio(targetRatio);
    let best = gaps[0];
    let bestDist = Math.abs(Number(best?.ratio || 0) - ratio);
    for (let i = 1; i < gaps.length; i += 1) {
      const gap = gaps[i];
      const dist = Math.abs(Number(gap?.ratio || 0) - ratio);
      if (dist < bestDist) {
        best = gap;
        bestDist = dist;
      }
    }
    return best;
  }

  function findNearestMiniDividerGapByY(targetY, model = null) {
    const gapModel = model || getMiniDividerGapModel();
    const gaps = Array.isArray(gapModel?.gaps) ? gapModel.gaps : [];
    if (!gaps.length) return null;
    const y = Number(targetY);
    if (!Number.isFinite(y)) return gaps[0] || null;
    let best = gaps[0];
    let bestDist = Math.abs(Number(best?.y || 0) - y);
    for (let i = 1; i < gaps.length; i += 1) {
      const gap = gaps[i];
      const dist = Math.abs(Number(gap?.y || 0) - y);
      if (dist < bestDist) {
        best = gap;
        bestDist = dist;
      }
    }
    return best;
  }

  function getMiniDividerGapFromSlot(afterTurnIndex, model = null) {
    const gapModel = model || getMiniDividerGapModel();
    const gaps = Array.isArray(gapModel?.gaps) ? gapModel.gaps : [];
    const slot = Math.max(0, Number(afterTurnIndex || 0) || 0);
    if (!slot || !gaps.length) return null;
    return gaps.find((gap) => Number(gap?.before?.turnIdx || 0) === slot) || null;
  }

  function resolveMiniDividerGap(item, model = null) {
    const gapModel = model || getMiniDividerGapModel();
    const gaps = Array.isArray(gapModel?.gaps) ? gapModel.gaps : [];
    if (!gaps.length) return null;
    const gapId = String(item?.gapId || '').trim();
    if (gapId) {
      const byId = gaps.find((gap) => String(gap?.id || '').trim() === gapId) || null;
      if (byId) return byId;
    }
    const slot = Math.max(0, Number(item?.afterTurnIndex || 0) || 0);
    if (slot) {
      const bySlot = getMiniDividerGapFromSlot(slot, gapModel);
      if (bySlot) return bySlot;
    }
    const rawRatio = Number(item?.yRatio);
    if (Number.isFinite(rawRatio)) {
      const byRatio = findNearestMiniDividerGap(rawRatio, gapModel);
      if (byRatio) return byRatio;
    }
    return gaps[0] || null;
  }

  function getDefaultMiniDividerGap(model = null) {
    const gapModel = model || getMiniDividerGapModel();
    const gaps = Array.isArray(gapModel?.gaps) ? gapModel.gaps : [];
    if (!gaps.length) return null;
    const info = gapModel?.metrics || null;
    const activeBtn = info?.col?.querySelector?.('[data-cgxui="mnmp-btn"][data-cgxui-state~="active"], [data-cgxui="mm-btn"][data-cgxui-state~="active"], .cgxui-mm-btn[data-cgxui-state~="active"], .cgxui-mm-btn.active') || null;
    const wrap = getWrapForMiniBtn(activeBtn);
    const activeIdx = Math.max(0, Number(wrap?.dataset?.turnIdx || activeBtn?.dataset?.turnIdx || 0) || 0);
    if (activeIdx) {
      const direct = getMiniDividerGapFromSlot(activeIdx, gapModel);
      if (direct) return direct;
      const wrapBottom = Number(wrap?.offsetTop || 0) + Number(wrap?.offsetHeight || 0);
      return findNearestMiniDividerGap(wrapBottom / Math.max(1, info?.height || 1), gapModel) || gaps[0];
    }
    return gaps[Math.floor(gaps.length / 2)] || gaps[0] || null;
  }

  function positionMiniDividerElement(divider, gap) {
    if (!divider) return false;
    const nextRatio = clampMiniDividerRatio(gap?.ratio);
    const nextY = Number(gap?.y);
    const gapId = String(gap?.id || '').trim();
    if (Number.isFinite(nextY)) divider.style.top = `${nextY.toFixed(2)}px`;
    else divider.style.top = `${(nextRatio * 100).toFixed(4)}%`;
    divider.dataset.yRatio = String(nextRatio);
    if (gapId) divider.dataset.gapId = gapId;
    else delete divider.dataset.gapId;
    return true;
  }

  function handleMiniDividerPointerDown(e, dividerId = '') {
    const item = getMiniDividerById(dividerId);
    if (!item) return;
    const panel = minimapPanel();
    const layer = ensureMiniDividerLayer(panel);
    const divider = e?.currentTarget || null;
    if (!panel || !layer || !divider) return;

    e.preventDefault();
    e.stopPropagation();

    const model = getMiniDividerGapModel(panel, minimapCol(panel));
    const gaps = Array.isArray(model?.gaps) ? model.gaps : [];
    if (!gaps.length) return;

    const selectedId = String(item?.id || '').trim();
    if (selectedId) {
      setSelectedMiniDividerId(selectedId, { chatId: item.chatId, source: 'core:drag-start', render: false, emit: true });
      try {
        const nodes = Array.from(layer.querySelectorAll('.cgxui-mm-overlay-divider[data-divider-id]'));
        for (const node of nodes) {
          node.setAttribute('data-selected', node === divider ? '1' : '0');
        }
      } catch {}
    }

    const layerRect = () => layer.getBoundingClientRect();
    const startGap = resolveMiniDividerGap(item, model) || gaps[0];
    if (!startGap) return;

    const gapFromClientY = (clientY) => {
      const rect = layerRect();
      const y = Number(clientY || 0) - rect.top;
      return findNearestMiniDividerGapByY(y, model) || startGap;
    };

    const prevDrag = S.dividerDrag;
    if (prevDrag) {
      try { window.removeEventListener('pointermove', prevDrag.move, true); } catch {}
      try { window.removeEventListener('pointerup', prevDrag.up, true); } catch {}
      try { window.removeEventListener('pointercancel', prevDrag.up, true); } catch {}
      S.dividerDrag = null;
    }

    const move = (ev) => {
      ev.preventDefault?.();
      const gap = gapFromClientY(ev.clientY);
      if (S.dividerDrag) {
        S.dividerDrag.gapId = String(gap?.id || '').trim();
        S.dividerDrag.ratio = Number(gap?.ratio || startGap?.ratio || 0.5);
      }
      positionMiniDividerElement(divider, gap);
    };
    const up = (ev) => {
      try { window.removeEventListener('pointermove', move, true); } catch {}
      try { window.removeEventListener('pointerup', up, true); } catch {}
      try { window.removeEventListener('pointercancel', up, true); } catch {}
      const drag = S.dividerDrag;
      S.dividerDrag = null;
      if (!drag) return;
      const finalGap = gapFromClientY(ev?.clientY);
      const existing = getMiniDividerById(drag.dividerId, drag.chatId) || item;
      const result = upsertMiniDivider({
        id: drag.dividerId,
        gapId: String(finalGap?.id || drag.gapId || '').trim(),
        yRatio: Number(finalGap?.ratio || drag.ratio || startGap?.ratio || 0.5),
        style: existing?.style,
        color: existing?.color,
        afterTurnIndex: 0,
      }, drag.chatId);
      if (!result?.ok && divider) {
        positionMiniDividerElement(divider, startGap);
      }
      try { ev.preventDefault?.(); } catch {}
    };

    S.dividerDrag = {
      dividerId: selectedId,
      chatId: item.chatId,
      gapId: String(startGap?.id || '').trim(),
      ratio: Number(startGap?.ratio || 0.5),
      move,
      up,
    };

    try { window.addEventListener('pointermove', move, true); } catch {}
    try { window.addEventListener('pointerup', up, true); } catch {}
    try { window.addEventListener('pointercancel', up, true); } catch {}
  }

  function createOverlayMiniDivider(item, metrics = null) {
    const divider = document.createElement('div');
    const style = normalizeMiniDividerStyle(item?.style || '');
    const color = normalizeMiniDividerColor(item?.color || '');
    const selected = String(item?.id || '').trim() === String(S.selectedMiniDividerId || '').trim();
    const model = metrics?.gaps ? metrics : getMiniDividerGapModel(metrics?.panel || null, metrics?.col || null);
    const gap = resolveMiniDividerGap(item, model);
    if (!gap) return null;

    divider.className = 'cgxui-mm-overlay-divider';
    divider.setAttribute('data-cgxui-owner', UI_TOK.OWNER);
    divider.setAttribute('data-cgxui', UI_TOK.DIVIDER);
    divider.setAttribute('data-divider-id', String(item?.id || ''));
    divider.setAttribute('data-divider-style', style);
    divider.setAttribute('data-selected', selected ? '1' : '0');
    divider.style.setProperty('--cgxui-mm-overlay-divider-color', color);
    divider.innerHTML = '<span class="cgxui-mm-overlay-divider-hit" aria-hidden="true"></span><span class="cgxui-mm-overlay-divider-line" aria-hidden="true"></span>';
    positionMiniDividerElement(divider, gap);
    divider.addEventListener('pointerdown', (e) => handleMiniDividerPointerDown(e, item?.id || ''), { passive: false });
    return divider;
  }

  function renderMiniDividerOverlay(chatId = '') {
    const perfOwned = enterPerfOwner('divider');
    const perfT0 = perfNow();
    try {
      const panel = minimapPanel();
      const col = minimapCol(panel);
      const layer = ensureMiniDividerLayer(panel);
      if (!panel || !col || !layer) return null;

      const items = loadMiniDividers(chatId);
      const model = getMiniDividerGapModel(panel, col);
      const metrics = model?.metrics || null;
      if (!metrics || !Array.isArray(model?.gaps)) {
        const removedCount = Number(layer.childElementCount || 0) || 0;
        if (removedCount > 0) {
          noteNodeLifecycle('removed', 'overlayDividers', removedCount);
          PERF.dividerUi.removedCount = Number(PERF.dividerUi.removedCount || 0) + removedCount;
        }
        layer.replaceChildren();
        return layer;
      }

      layer.style.top = `${metrics.top}px`;
      layer.style.height = `${metrics.height}px`;

      const selectedId = String(S.selectedMiniDividerId || '').trim();
      if (selectedId && !items.some((item) => String(item?.id || '').trim() === selectedId)) {
        S.selectedMiniDividerId = '';
      }

      const prevCount = Number(layer.childElementCount || 0) || 0;
      const frag = document.createDocumentFragment();
      let createdCount = 0;
      for (const item of items) {
        const divider = createOverlayMiniDivider(item, model);
        if (divider) {
          frag.appendChild(divider);
          createdCount += 1;
        }
      }
      if (prevCount > 0) noteNodeLifecycle('removed', 'overlayDividers', prevCount);
      if (createdCount > 0) {
        noteNodeLifecycle('created', 'overlayDividers', createdCount);
        noteRenderUnit('overlayDividers', createdCount);
        PERF.dividerUi.createdCount = Number(PERF.dividerUi.createdCount || 0) + createdCount;
      }
      if (prevCount > 0) PERF.dividerUi.removedCount = Number(PERF.dividerUi.removedCount || 0) + prevCount;
      layer.replaceChildren(frag);
      return layer;
    } finally {
      const ms = perfNow() - perfT0;
      recordDuration(PERF.paths.renderMiniDividerOverlay, ms);
      if (perfOwned) {
        recordDuration(PERF.dividerUi, ms);
        noteSummaryBucket(PERF.dividerUi, 'renderMiniDividerOverlay');
      }
      exitPerfOwner('divider');
    }
  }

  function createBtn(turn) {
    const wrap = document.createElement('div');
    wrap.className = 'cgxui-mm-wrap';
    wrap.setAttribute('data-cgxui-owner', UI_TOK.OWNER);
    wrap.setAttribute('data-cgxui', UI_TOK.WRAP);

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'cgxui-mm-btn';
    btn.setAttribute('data-cgxui-owner', UI_TOK.OWNER);
    btn.setAttribute('data-cgxui', UI_TOK.BTN);
    btn.innerHTML = '<span class="cgxui-mm-qfrom" aria-hidden="true"></span>'
      + '<span class="cgxui-mm-qto" aria-hidden="true"></span>'
      + `<span class="cgxui-mm-num" aria-hidden="true">${turn.index}</span>`;

    wrap.appendChild(btn);
    syncTurnRowDom(btn, turn, { qaEnabled: isQaViewActive() });

    return {
      wrap,
      btn,
      qBtn: getQuestionBtnForWrap(wrap),
    };
  }

  function ensureTurnButtons(list = S.turnList, opts = {}) {
    const perfOwned = enterPerfOwner('fullRender');
    const perfT0 = perfNow();
    try {
      const explicitTurns = Array.isArray(list) ? list.filter(Boolean) : [];
      const snapshot = explicitTurns.length ? null : getAuthoritativeTurnSnapshot();
      const turns = explicitTurns.length ? explicitTurns : (Array.isArray(snapshot?.list) ? snapshot.list : []);
      const col = ensureCol();
      if (!col) return null;
      applyMiniMapPageUiPrefs();
      if (!turns.length) {
        bumpReason(PERF.fullRender.branches, 'emptyListClear');
        col.textContent = '';
        const clearedMap = setMapStore(new Map());
        try { renderMiniDividerOverlay(resolveChatId()); } catch {}
        return clearedMap;
      }

      const prevMap = ensureMapStore();
      const nextMap = new Map();
      const marginSymbolMetaMap = getMarginSymbolMetaMap();
      const frag = document.createDocumentFragment();
      const postCommitJobs = [];
      const qaEnabled = syncCurrentViewArtifacts() === 'qa';
      const collapsedPages = readCollapsedMiniMapPages(resolveChatId());
      let expectedRows = 0;
      for (const turn of turns) {
        const turnIndex = Number(turn?.index || 0);
        if (!turnIndex) continue;
        expectedRows += 1;
        if (((turnIndex - 1) % 25) === 0) expectedRows += 1;
      }
      const fastChildren = Array.from(col.children || []);
      let canReuseStructure = fastChildren.length === expectedRows && expectedRows > 0;
      let childIdx = 0;

      if (canReuseStructure) {
        for (const turn of turns) {
          const turnId = String(turn?.turnId || '').trim();
          const turnIndex = Number(turn?.index || 0);
          const pageNum = Math.max(1, Math.ceil(turnIndex / 25));
          if (!turnId || !turnIndex) {
            canReuseStructure = false;
            break;
          }
          if (turnIndex > 0 && ((turnIndex - 1) % 25 === 0)) {
            const divider = fastChildren[childIdx] || null;
            const dividerPageNum = Math.max(1, Number(divider?.dataset?.pageNum || 0) || 0);
            if (!divider?.classList?.contains?.('cgxui-mm-page-divider') || dividerPageNum !== pageNum) {
              canReuseStructure = false;
              break;
            }
            childIdx += 1;
          }
          const wrap = fastChildren[childIdx] || null;
          const wrapTurnId = String(wrap?.dataset?.turnId || '').trim();
          const btn = wrap?.querySelector?.(`[data-cgxui="${UI_TOK.BTN}"], [data-cgxui="${UI_TOK.BTN_LEGACY}"], .cgxui-mm-btn`) || null;
          const btnTurnId = String(btn?.dataset?.turnId || '').trim();
          if (!wrap?.classList?.contains?.('cgxui-mm-wrap') || !btn || wrapTurnId !== turnId || btnTurnId !== turnId) {
            canReuseStructure = false;
            break;
          }
          childIdx += 1;
        }
        if (childIdx !== fastChildren.length) canReuseStructure = false;
      }

      if (canReuseStructure) {
        childIdx = 0;
        for (const turn of turns) {
          const turnId = String(turn?.turnId || '').trim();
          if (!turnId) continue;

          const turnIndex = Number(turn?.index || 0);
          const pageNum = Math.max(1, Math.ceil(turnIndex / 25));
          const band = getTurnPageBand(turnIndex);
          const pageCollapsed = collapsedPages.has(pageNum);
          noteNodeLifecycle('reused', 'answerRows');
          noteNodeLifecycle('reused', 'answerButtons');
          noteRenderUnit('answerRows');
          noteRenderUnit('answerButtons');

          if (turnIndex > 0 && ((turnIndex - 1) % 25 === 0)) {
            const divider = fastChildren[childIdx] || null;
            if (divider) {
              divider.setAttribute('data-page-band', String(band || 'normal'));
              divider.setAttribute('data-page-num', String(pageNum));
              setMiniMapPageDividerDomState(divider, pageCollapsed);
              noteNodeLifecycle('reused', 'miniPageDividers');
              noteRenderUnit('miniPageDividers');
            }
            childIdx += 1;
          }

          const wrap = fastChildren[childIdx] || null;
          const btn = wrap?.querySelector?.(`[data-cgxui="${UI_TOK.BTN}"], [data-cgxui="${UI_TOK.BTN_LEGACY}"], .cgxui-mm-btn`) || null;
          childIdx += 1;
          if (!wrap || !btn) {
            canReuseStructure = false;
            noteNodeLifecycle('repaired', 'answerRows');
            break;
          }

          syncTurnRowDom(btn, turn, { qaEnabled });
          syncWrapMeta(wrap, turn, band);
          syncAnswerBtnMeta(btn, turn, band);
          ensureQuestionBtnForWrap(wrap, turn, band, qaEnabled);
          setMiniMapPageWrapDomState(wrap, pageCollapsed);
          nextMap.set(turnId, btn);

          const answerId = String(turn?.answerId || '').trim();
          const symbolMeta = getMarginSymbolMetaForAnswer(answerId, marginSymbolMetaMap);
          postCommitJobs.push({
            turnId,
            answerId,
            turnIndex: turn.index,
            symbols: symbolMeta.symbols,
            color: String(symbolMeta.colors[0] || '').trim(),
          });
        }
        if (canReuseStructure) {
          bumpReason(PERF.fullRender.branches, 'fastReusePath');
          applyAllMiniMapPageCollapsedStates(resolveChatId(), col);
          const committedMap = setMapStore(nextMap);
          try { renderMiniDividerOverlay(resolveChatId()); } catch {}

          if (!opts?.skipActiveSync) {
            bumpReason(PERF.fullRender.branches, 'activeSyncApplied');
            const activeId = String(S.lastActiveTurnIdFast || S.lastActiveBtnId || '').trim();
            if (activeId) {
              try { setActive(activeId, 'rebuild:turn-buttons'); } catch {}
            } else {
              try { updateCounter(''); } catch {}
            }
          }
          for (const job of postCommitJobs) {
            const btn = committedMap.get(job.turnId) || null;
            if (!btn || !btn.isConnected) continue;
            updateMiniMapGutterSymbol(btn, job.symbols, { color: job.color });
            repaintMiniBtnByAnswerId(job.answerId || job.turnId, btn);
            noteRenderUnit('gutterSymbols');
            try { W.syncMiniMapDot?.(job.answerId); } catch {}
            try { W.H2O_MM_syncQuoteBadgesForIdx?.(btn, job.turnIndex); } catch {}
          }
          requestAnimationFrame(() => {
            try { W.H2O?.MM?.dots?.repaintDotsForAllMiniBtns?.(); } catch {}
            try { W.H2O_MM_repaintDots?.(); } catch {}
          });
          if (!PERF.bootCompletedAt) PERF.bootCompletedAt = Date.now();
          return committedMap;
        }
        nextMap.clear();
        postCommitJobs.length = 0;
      }

      bumpReason(PERF.fullRender.branches, 'fallbackRebuildPath');
      for (const turn of turns) {
        const turnId = String(turn?.turnId || '').trim();
        if (!turnId) continue;

        const turnIndex = Number(turn?.index || 0);
        const pageNum = Math.max(1, Math.ceil(turnIndex / 25));
        const band = getTurnPageBand(turnIndex);
        const pageCollapsed = collapsedPages.has(pageNum);

        if (turnIndex > 0 && ((turnIndex - 1) % 25 === 0)) {
          frag.appendChild(createMiniMapPageDivider(pageNum, band, pageCollapsed));
          noteNodeLifecycle('created', 'miniPageDividers');
          noteRenderUnit('miniPageDividers');
        }

        const answerId = String(turn?.answerId || '').trim();
        let btn = prevMap.get(turnId) || null;
        let wrap = null;
        if (!btn || !btn.isConnected) {
          if (btn) noteNodeLifecycle('repaired', 'answerRows');
          const made = createBtn(turn);
          btn = made.btn;
          wrap = made.wrap;
          noteNodeLifecycle('created', 'answerRows');
          noteNodeLifecycle('created', 'answerButtons');
        } else {
          wrap = getWrapForMiniBtn(btn);
          if (!wrap) {
            noteNodeLifecycle('repaired', 'answerRows');
            const made = createBtn(turn);
            btn = made.btn;
            wrap = made.wrap;
            noteNodeLifecycle('created', 'answerRows');
            noteNodeLifecycle('created', 'answerButtons');
          } else {
            noteNodeLifecycle('reused', 'answerRows');
            noteNodeLifecycle('reused', 'answerButtons');
            syncTurnRowDom(btn, turn, { qaEnabled });
          }
        }

        if (!wrap) continue;

        noteRenderUnit('answerRows');
        noteRenderUnit('answerButtons');
        syncWrapMeta(wrap, turn, band);
        syncAnswerBtnMeta(btn, turn, band);
        ensureQuestionBtnForWrap(wrap, turn, band, qaEnabled);
        setMiniMapPageWrapDomState(wrap, pageCollapsed);

        frag.appendChild(wrap);
        nextMap.set(turnId, btn);

        const symbolMeta = getMarginSymbolMetaForAnswer(answerId, marginSymbolMetaMap);
        postCommitJobs.push({
          turnId,
          answerId,
          turnIndex: turn.index,
          symbols: symbolMeta.symbols,
          color: String(symbolMeta.colors[0] || '').trim(),
        });
      }

      bumpReason(PERF.fullRender.branches, 'replaceChildrenCommit');
      col.replaceChildren(frag);
      applyAllMiniMapPageCollapsedStates(resolveChatId(), col);
      const committedMap = setMapStore(nextMap);
      try { renderMiniDividerOverlay(resolveChatId()); } catch {}

      if (!opts?.skipActiveSync) {
        bumpReason(PERF.fullRender.branches, 'activeSyncApplied');
        const activeId = String(S.lastActiveTurnIdFast || S.lastActiveBtnId || '').trim();
        if (activeId) {
          try { setActive(activeId, 'rebuild:turn-buttons'); } catch {}
        } else {
          try { updateCounter(''); } catch {}
        }
      }
      for (const job of postCommitJobs) {
        const btn = committedMap.get(job.turnId) || null;
        if (!btn || !btn.isConnected) continue;
        updateMiniMapGutterSymbol(btn, job.symbols, { color: job.color });
        repaintMiniBtnByAnswerId(job.answerId || job.turnId, btn);
        noteRenderUnit('gutterSymbols');
        try { W.syncMiniMapDot?.(job.answerId); } catch {}
        try { W.H2O_MM_syncQuoteBadgesForIdx?.(btn, job.turnIndex); } catch {}
      }
      requestAnimationFrame(() => {
        try { W.H2O?.MM?.dots?.repaintDotsForAllMiniBtns?.(); } catch {}
        try { W.H2O_MM_repaintDots?.(); } catch {}
      });

      if (!PERF.bootCompletedAt) PERF.bootCompletedAt = Date.now();
      return committedMap;
    } finally {
      const ms = perfNow() - perfT0;
      recordDuration(PERF.paths.ensureTurnButtons, ms);
      if (perfOwned) {
        recordDuration(PERF.fullRender, ms);
        noteSummaryBucket(PERF.fullRender, 'ensureTurnButtons');
        recordDuration(PERF.domWriteCluster, ms);
        noteSummaryBucket(PERF.domWriteCluster, 'ensureTurnButtons');
      }
      exitPerfOwner('fullRender');
    }
  }

  function getMiniMapPageDividerLabel(pageNum = 0) {
    const num = Math.max(1, Number(pageNum || 0) || 1);
    const col = ensureCol();
    if (!col) return null;
    try {
      return col.querySelector(`.cgxui-mm-page-divider-label[data-page-num="${String(num)}"]`);
    } catch {
      return null;
    }
  }

  function findTurnByAnyId(anyId) {
    const key = String(anyId || '').trim();
    if (!key) return null;
    const candidates = canonicalLookupCandidates(key);
    for (const c of candidates) {
      if (!c) continue;
      const direct = lookupCanonicalTurnByTurnId(c);
      if (direct) return direct;
      const mappedTurnId = lookupCanonicalTurnIdByAnswerId(c);
      if (mappedTurnId) {
        const mappedTurn = lookupCanonicalTurnByTurnId(mappedTurnId);
        if (mappedTurn) return mappedTurn;
      }
    }
    for (const c of candidates) {
      const sharedRecord = getSharedTurnRecordByAnyId(c);
      if (sharedRecord) return projectSharedTurnRecord(sharedRecord);
    }
    return null;
  }

  function getBtnById(anyId) {
    const key = String(anyId || '').trim();
    if (!key) return null;
    const map = getExistingMapStore();
    const direct = map?.get?.(key) || null;
    if (direct) return direct;

    const turnId = resolveBtnId(key);
    if (turnId) {
      const byTurnId = (getExistingMapStore() || map)?.get?.(turnId) || null;
      if (byTurnId) return byTurnId;
    }

    return recoverMiniBtnFromDom(key, turnId);
  }

  function getTurnById(turnId) {
    const key = String(turnId || '').trim();
    if (!key) return null;
    return findTurnByAnyId(key);
  }

  function refreshTurnsCache() {
    const snapshot = getBestCanonicalSnapshot();
    if (snapshot?.list?.length) {
      publishTurnSnapshot(snapshot);
      return S.turnList.slice();
    }
    indexTurns();
    return S.turnList.slice();
  }

  function getTurns() {
    if (S.turnList.length) return S.turnList.slice();
    return refreshTurnsCache();
  }

  function resolveBtnId(anyId) {
    const id = String(anyId || '').trim();
    if (!id) return '';

    const map = getExistingMapStore();
    if (map?.has?.(id)) return id;

    const directTurn = lookupCanonicalTurnByTurnId(id);
    if (directTurn?.turnId) return String(directTurn.turnId).trim();

    const mapped = lookupCanonicalTurnIdByAnswerId(id);
    if (mapped) return String(mapped).trim();

    const sharedTurnId = String(getSharedTurnRecordByAnyId(id)?.turnId || '').trim();
    if (sharedTurnId) return sharedTurnId;

    if (!hasCanonicalTurnSnapshotState()) {
      refreshTurnsCache();
      const retryMap = getExistingMapStore() || map;
      if (retryMap?.has?.(id)) return id;
      const retryTurn = lookupCanonicalTurnByTurnId(id);
      if (retryTurn?.turnId) return String(retryTurn.turnId).trim();
      const retryMapped = lookupCanonicalTurnIdByAnswerId(id);
      if (retryMapped) return String(retryMapped).trim();
    }

    return id;
  }

  function turnIdxForAnswerEl(answerEl) {
    if (!answerEl) return 0;
    const viaCore = W?.H2O?.turn?.getTurnIndexByAEl?.(answerEl) || 0;
    if (viaCore) return viaCore;

    const aId = String(getMessageId(answerEl) || '').trim();
    if (!aId) return 0;

    const turnId = lookupCanonicalTurnIdByAnswerId(aId);
    if (turnId) {
      const turn = lookupCanonicalTurnByTurnId(turnId);
      const idx = Math.max(0, Number(turn?.index || 0) || 0);
      if (idx > 0) return idx;
    }

    const sharedTurnNo = Number(getSharedTurnRecordByAnyId(aId)?.turnNo || 0);
    if (sharedTurnNo > 0) return sharedTurnNo;

    if (!hasCanonicalTurnSnapshotState()) {
      refreshTurnsCache();
      const retryTurnId = lookupCanonicalTurnIdByAnswerId(aId);
      if (retryTurnId) {
        return Math.max(0, Number(lookupCanonicalTurnByTurnId(retryTurnId)?.index || 0) || 0);
      }
    }
    return 0;
  }

  function findMiniBtn(anyId) {
    const key = String(anyId || '').trim();
    if (!key) return null;

    const map = getExistingMapStore();
    const direct = map?.get?.(key);
    if (direct) return direct;

    const resolvedId = resolveBtnId(key);
    if (resolvedId) {
      const byResolved = (getExistingMapStore() || map)?.get?.(String(resolvedId).trim());
      if (byResolved) return byResolved;
    }

    return recoverMiniBtnFromDom(key, resolvedId);
  }

  function getTurnList() {
    return S.turnList.slice();
  }

  function getTurnIndex(anyId = '') {
    const key = String(anyId || '').trim();
    if (!key) return 0;
    const turn = findTurnByAnyId(key);
    return Number(turn?.index || 0);
  }

  function computeActiveFromViewport(opts = {}) {
    if (!S.turnList.length && !S.answerEls.length) indexTurns();
    const turns = S.turnList.length ? S.turnList : [];
    const turnAllowed = (turn) => {
      if (!turn) return false;
      return isTurnOnCurrentPaginationPage(turn, String(turn?.answerId || '').trim());
    };
    const turnAnchor = Number.isFinite(opts?.turnAnchorY)
      ? Number(opts.turnAnchorY)
      : Math.max(0, Math.floor(window.innerHeight * 0.22));
    const fallbackAnchor = Number.isFinite(opts?.anchorY) ? Number(opts.anchorY) : 120;
    const activePageDivider = (() => {
      const dividers = qq('.cgxui-pgnw-page-divider[data-page-num]');
      if (!dividers.length) return null;

      let best = null;
      let bestDist = Infinity;
      for (const el of dividers) {
        if (!el?.getBoundingClientRect) continue;
        const rect = el.getBoundingClientRect();
        if (rect.bottom < 0 || rect.top > window.innerHeight) continue;

        const pageNum = Math.max(1, Number(el.getAttribute?.('data-page-num') || 0) || 0);
        if (!pageNum) continue;

        const dist = (rect.top <= turnAnchor && rect.bottom >= turnAnchor)
          ? 0
          : Math.min(Math.abs(rect.top - turnAnchor), Math.abs(rect.bottom - turnAnchor));
        if (dist < bestDist) {
          bestDist = dist;
          best = { el, pageNum, dist };
          if (dist === 0) break;
        }
      }
      const threshold = Math.max(72, Math.floor(window.innerHeight * 0.18));
      return best && Number(best.dist || 0) <= threshold ? best : null;
    })();
    const activePageNum = Math.max(0, Number(activePageDivider?.pageNum || 0) || 0);

    let pickedTurn = null;

    if (turns.length) {
      const lastId = String(S.lastActiveTurnIdFast || '').trim();
      if (lastId) {
        const lastTurn = S.turnById.get(lastId) || null;
        const lastEl = lastTurn?.el || S.answerByTurnId.get(lastId) || null;
        if (lastEl?.getBoundingClientRect) {
          try {
            const r = lastEl.getBoundingClientRect();
            if (turnAllowed(lastTurn) && r.bottom >= 0 && r.top <= window.innerHeight && r.top <= turnAnchor && r.bottom >= turnAnchor) {
              const turnId = String(lastTurn?.turnId || lastId).trim();
              const answerId = String(lastTurn?.answerId || '').trim();
              const idx = Number(lastTurn?.index || getTurnIndex(turnId || answerId) || 0);
              return { activeTurnId: turnId, activeAnswerId: answerId, activeBtnIndex: idx, activePageNum };
            }
          } catch {}
        }
      }

      const visibleSet = (opts?.visibleSet instanceof Set && opts.visibleSet.size)
        ? Array.from(opts.visibleSet)
        : [];

      if (visibleSet.length) {
        let bestEl = null;
        let bestDist = Infinity;

        for (const el of visibleSet) {
          if (!el?.getBoundingClientRect) continue;
          const r = el.getBoundingClientRect();
          if (r.bottom < 0 || r.top > window.innerHeight) continue;

          const dist = (r.top <= turnAnchor && r.bottom >= turnAnchor)
            ? 0
            : Math.min(Math.abs(r.top - turnAnchor), Math.abs(r.bottom - turnAnchor));

          if (dist < bestDist) {
            bestDist = dist;
            bestEl = el;
            if (dist === 0) break;
          }
        }

        if (bestEl) {
          const aId = String(getMessageId(bestEl) || '').trim();
          const turnId = aId ? (S.turnIdByAId.get(aId) || '') : '';
          if (turnId) {
            const turn = S.turnById.get(turnId) || null;
            if (turnAllowed(turn)) pickedTurn = turn;
          }
        }
      }

      if (!pickedTurn) {
        try {
          const probe = document.elementFromPoint(Math.floor(window.innerWidth * 0.5), turnAnchor);
          const { SEL } = getRegs();
          const aEl = probe?.closest?.(
            SEL.ANSWER || STUDIO_SEL.sel.assistantTurnTagged
          );
          if (aEl) {
            const aId = String(getMessageId(aEl) || '').trim();
            const turnId = aId ? (S.turnIdByAId.get(aId) || '') : '';
            if (turnId) {
              const turn = S.turnById.get(turnId) || null;
              if (turnAllowed(turn)) pickedTurn = turn;
            }
          }
        } catch {}
      }

      if (!pickedTurn) {
        const last = Math.max(1, Number(S.lastActiveIndex || 1));
        const i0 = Math.max(0, last - 25);
        const i1 = Math.min(turns.length - 1, last + 25);
        let bestTurn = null;
        let bestDist = Infinity;

        for (let i = i0; i <= i1; i += 1) {
          const t = turns[i];
          if (!turnAllowed(t)) continue;
          const turnId = String(t?.turnId || '').trim();
          let el = t?.el || (turnId ? S.answerByTurnId.get(turnId) : null);
          // Keep active-compute bounded: no per-turn DOM queries in this loop.
          if (!el) continue;
          if (!el?.getBoundingClientRect) continue;
          const r = el.getBoundingClientRect();
          if (r.bottom < 0 || r.top > window.innerHeight) continue;

          const dist = (r.top <= turnAnchor && r.bottom >= turnAnchor)
            ? 0
            : Math.min(Math.abs(r.top - turnAnchor), Math.abs(r.bottom - turnAnchor));

          if (dist < bestDist) {
            bestDist = dist;
            bestTurn = t;
            if (dist === 0) break;
          }
        }
        pickedTurn = bestTurn || null;
      }
    }

    if (pickedTurn) {
      const turnId = String(pickedTurn.turnId || '').trim();
      const answerId = String(pickedTurn.answerId || '').trim();
      const idx = Number(pickedTurn.index || getTurnIndex(turnId || answerId) || 0);
      return { activeTurnId: turnId, activeAnswerId: answerId, activeBtnIndex: idx, activePageNum };
    }

    const answers = (S.answerEls.length ? S.answerEls : getAnswerEls()).filter((el) => !!el && el.isConnected);
    if (!answers.length) return { activeTurnId: '', activeAnswerId: '', activeBtnIndex: 0, activePageNum };

    const y = window.scrollY || 0;
    let bestEl = null;
    let bestDelta = Infinity;
    for (const el of answers) {
      const r = el?.getBoundingClientRect?.();
      if (!r) continue;
      const top = r.top + y;
      const d = Math.abs(top - y - fallbackAnchor);
      if (d < bestDelta) {
        bestDelta = d;
        bestEl = el;
      }
    }

    if (!bestEl) return { activeTurnId: '', activeAnswerId: '', activeBtnIndex: 0, activePageNum };
    const aId = String(getMessageId(bestEl) || '').trim();
    const turnId = aId ? (S.turnIdByAId.get(aId) || '') : '';
    if (!isTurnOnCurrentPaginationPage(turnId || aId, aId)) {
      return { activeTurnId: '', activeAnswerId: '', activeBtnIndex: 0, activePageNum };
    }
    return {
      activeTurnId: turnId,
      activeAnswerId: aId,
      activeBtnIndex: getTurnIndex(turnId || aId),
      activePageNum,
    };
  }

  function setBtnActiveState(btn, on) {
    if (!btn) return;
    const active = !!on;
    btn.classList.toggle('active', active);
    btn.classList.toggle('inview', active);
    setStateToken(btn, 'active', active);
    setStateToken(btn, 'inview', active);
    if (active) btn.setAttribute('data-cgxui-inview', '1');
    else btn.removeAttribute('data-cgxui-inview');
  }

  function isBtnActive(btn) {
    if (!btn) return false;
    try {
      if (btn.classList?.contains?.('active')) return true;
    } catch {}
    const st = String(btn.getAttribute?.('data-cgxui-state') || '').trim();
    return /\bactive\b/.test(st);
  }

  function setActive(anyId, reason = 'core') {
    const perfOwned = enterPerfOwner('incremental');
    const perfUiT0 = perfNow();
    const perfT0 = PERF_ASSERT_ON ? performance.now() : 0;
    const key = String(anyId || '').trim();
    const scanTick0 = Number(S.perfFullScanTick || 0);
    let activeVisualUpdates = 0;
    const perfDone = (ok, payload = null) => {
      if (PERF_ASSERT_ON) {
        perfReportDuration('setActive', perfT0, scanTick0, Object.assign({
          ok: !!ok,
          reason: String(reason || 'core'),
        }, payload || {}));
        console.assert(scanTick0 === Number(S.perfFullScanTick || 0), '[MiniMap] Active path must be O(1) — no full scans');
      }
      return !!ok;
    };
    try {
      if (!key) return perfDone(false, { status: 'id-missing' });

      const turn = findTurnByAnyId(key);
      const targetTurnId = String(turn?.turnId || key).trim();
      if (!targetTurnId) return perfDone(false, { status: 'turn-missing' });

      const nextBtn = getBtnById(targetTurnId);
      if (!nextBtn) return perfDone(false, { status: 'btn-missing', id: targetTurnId });

      const sameTarget = targetTurnId === String(S.lastActiveTurnIdFast || '').trim();
      const isScrollReason = String(reason || '').trim() === 'scroll-sync';
      const fastActive = isBtnActive(nextBtn);
      const fastPrevOk = !S.lastActiveBtnEl || !S.lastActiveBtnEl.isConnected || S.lastActiveBtnEl === nextBtn;
      if (isScrollReason && sameTarget && fastActive && fastPrevOk) {
        S.lastActiveBtnEl = nextBtn;
        S.lastActiveTurnIdFast = targetTurnId;
        S.lastActiveBtnId = targetTurnId;
        S.lastActiveIndex = Number(turn?.index || S.lastActiveIndex || 0);
        return perfDone(true, { id: targetTurnId, status: 'noop:same-active' });
      }

      let prevBtn = S.lastActiveBtnEl;
      if (prevBtn && !prevBtn.isConnected) prevBtn = null;
      if (!prevBtn) {
        const stale = q('[data-cgxui="mnmp-btn"][data-cgxui-state~="active"], [data-cgxui="mm-btn"][data-cgxui-state~="active"], .cgxui-mm-btn.active');
        if (stale && stale !== nextBtn) {
          setBtnActiveState(stale, false);
          setPeerQuestionActiveFromAnswerBtn(stale, false);
          activeVisualUpdates += 1;
        }
      }
      if (prevBtn && prevBtn !== nextBtn) {
        setBtnActiveState(prevBtn, false);
        setPeerQuestionActiveFromAnswerBtn(prevBtn, false);
        activeVisualUpdates += 1;
      }
      setBtnActiveState(nextBtn, true);
      setPeerQuestionActiveFromAnswerBtn(nextBtn, true);
      activeVisualUpdates += 1;
      S.lastActiveBtnEl = nextBtn;
      S.lastActiveTurnIdFast = targetTurnId;
      S.lastActiveBtnId = targetTurnId;

      updateCounter(targetTurnId);
      updateToggleColor(targetTurnId);
      S.lastActiveIndex = Number(turn?.index || getTurnIndex(targetTurnId) || S.lastActiveIndex || 0);
      if (activeVisualUpdates > 0) noteRenderUnit('activeStateUpdates', activeVisualUpdates);
      return perfDone(true, { id: targetTurnId, status: 'updated' });
    } finally {
      const ms = perfNow() - perfUiT0;
      recordDuration(PERF.paths.setActive, ms);
      if (perfOwned) {
        recordDuration(PERF.incrementalRefresh, ms);
        noteSummaryBucket(PERF.incrementalRefresh, reason || 'setActive');
      }
      exitPerfOwner('incremental');
    }
  }

  function centerOn(anyId, { force = false, smooth = true, activate = true } = {}) {
    const key = String(anyId || '').trim();
    if (!key) return false;
    const btn = getBtnById(key);
    if (!btn) return false;

    centerMiniMapNode(btn, { smooth });

    if (activate) {
      const targetId = String(btn.dataset.turnId || key).trim();
      const already = targetId && targetId === String(S.lastActiveTurnIdFast || '').trim() && isBtnActive(btn);
      if (!already || force) setActive(targetId || key);
    }
    return true;
  }

  // Chat page divider: automatic structural divider inside the live chat surface.
  function getChatPageTurnHost(turn = null) {
    const turnId = String(turn?.turnId || '').trim();
    const answerId = String(turn?.answerId || '').trim();
    let answerEl = turn?.el || turn?.primaryAEl || turn?.answerEl || null;
    if (!(answerEl?.isConnected)) {
      const attached = turnId ? (S.answerByTurnId.get(turnId) || null) : null;
      if (attached?.isConnected) answerEl = attached;
    }
    if (!(answerEl?.isConnected) && answerId) {
      answerEl = resolveAnswerEl(answerId) || null;
    }
    if (!(answerEl?.isConnected) && turnId) {
      const resolvedTurn = findTurnByAnyId(turnId) || null;
      const resolvedAnswerId = String(resolvedTurn?.answerId || '').trim();
      if (resolvedAnswerId) answerEl = resolveAnswerEl(resolvedAnswerId) || null;
    }
    if (!answerEl?.isConnected) return null;
    if (turn && !turn.el) turn.el = answerEl;
    if (turnId) S.answerByTurnId.set(turnId, answerEl);
    return answerEl.closest('[data-testid="conversation-turn"], [data-testid^="conversation-turn"]') || answerEl;
  }


  const ANSWER_TITLE_SEL = '[data-cgxui="atns-answer-title"][data-cgxui-owner="atns"]';
  const ANSWER_TITLE_LABEL_SEL = '[data-cgxui="atns-answer-title-label"][data-cgxui-owner="atns"]';
  const ANSWER_TITLE_TEXT_SEL = '[data-cgxui="atns-answer-title-text"][data-cgxui-owner="atns"]';
  const ANSWER_TITLE_BADGE_SEL = '[data-cgxui="atns-answer-title-badge"][data-cgxui-owner="atns"]';
  const ANSWER_TITLE_ICON_SEL = '[data-cgxui="atns-answer-title-icon"][data-cgxui-owner="atns"]';
  const ANSWER_TITLE_COLLAPSED_ATTR = 'data-at-collapsed';
  const ANSWER_TITLE_NO_ANSWER_ATTR = 'data-at-no-answer';
  const ATTR_CHAT_PAGE_TITLE_ITEM = 'data-cgxui-chat-page-title-item';
  const ATTR_CHAT_PAGE_NO_ANSWER = 'data-cgxui-chat-page-no-answer';
  const ATTR_CHAT_PAGE_NO_ANSWER_QUESTION_HIDDEN = 'data-cgxui-chat-page-no-answer-question-hidden';
  const EV_ANSWER_COLLAPSE = 'evt:h2o:answer:collapse';

  // ── ✏️ ADJUSTABLE: gap (in px) between collapsed title bars in title-list mode ──
  // Increase this number for more breathing room between rows; decrease for tighter packing.
  const TITLE_LIST_ROW_GAP_PX = 4;

  // localStorage key for persisting which pages are in title-list mode (per chat)
  const KEY_TITLE_LIST_PAGES = 'h2o:prm:cgx:mnmp:state:titlelist:pages:v1';
  const CHAT_PAGE_STATUS_CARD_ID = 'cgxui-chat-page-status-card';
  const ATTR_CHAT_PAGE_STATUS_BOUND = 'data-cgxui-chat-page-status-bound';

  function getChatPageDividerDotEl(divider = null) {
    if (!divider?.querySelector) return null;
    return divider.querySelector('.cgxui-chat-page-divider-dot, .cgxui-pgnw-page-divider-dot');
  }

  function getChatPageDividerTextEl(divider = null) {
    if (!divider?.querySelector) return null;
    return divider.querySelector('.cgxui-chat-page-divider-text, .cgxui-pgnw-page-divider-text');
  }

  function ensureChatPageDividerMarkup(divider = null, pageNum = 1) {
    if (!divider?.querySelector) return divider;
    const label = getChatPageDividerLabelEl(divider);
    if (!label) return divider;
    let dot = getChatPageDividerDotEl(divider);
    let textEl = getChatPageDividerTextEl(divider);
    if (!dot) {
      dot = document.createElement('span');
      dot.className = divider.classList?.contains('cgxui-pgnw-page-divider')
        ? 'cgxui-pgnw-page-divider-dot'
        : 'cgxui-chat-page-divider-dot';
      dot.setAttribute('aria-hidden', 'true');
      label.insertBefore(dot, label.firstChild || null);
    }
    if (!textEl) {
      textEl = document.createElement('span');
      textEl.className = divider.classList?.contains('cgxui-pgnw-page-divider')
        ? 'cgxui-pgnw-page-divider-text'
        : 'cgxui-chat-page-divider-text';
      textEl.textContent = `Page ${String(pageNum || 1)}`;
      label.appendChild(textEl);
    } else {
      textEl.textContent = `Page ${String(pageNum || 1)}`;
    }
    return divider;
  }

  function ensureChatPageStatusCard() {
    let card = S.chatPageStatusCardEl;
    if (card?.isConnected) return card;
    try { card = document.getElementById(CHAT_PAGE_STATUS_CARD_ID); } catch {}
    if (!(card instanceof HTMLElement)) {
      try {
        card = document.createElement('div');
        card.id = CHAT_PAGE_STATUS_CARD_ID;
        card.setAttribute('role', 'tooltip');
        card.setAttribute('aria-hidden', 'true');
        card.setAttribute('data-cgxui-owner', UI_TOK.OWNER);
        card.style.position = 'fixed';
        card.style.left = '-9999px';
        card.style.top = '-9999px';
        card.style.zIndex = '2147483646';
        card.style.pointerEvents = 'none';
        card.style.maxWidth = '320px';
        card.style.padding = '10px 12px';
        card.style.borderRadius = '10px';
        card.style.border = '1px solid rgba(148, 163, 184, 0.32)';
        card.style.background = 'rgba(15, 23, 42, 0.96)';
        card.style.color = '#e5eefc';
        card.style.boxShadow = '0 12px 32px rgba(0, 0, 0, 0.34)';
        card.style.font = '12px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
        card.style.whiteSpace = 'pre';
        card.style.opacity = '0';
        card.style.visibility = 'hidden';
        card.style.transform = 'translateY(4px)';
        card.style.transition = 'opacity 120ms ease, transform 120ms ease';
        document.body.appendChild(card);
      } catch {
        card = null;
      }
    }
    S.chatPageStatusCardEl = card instanceof HTMLElement ? card : null;
    return S.chatPageStatusCardEl;
  }

  function formatChatPageStatusCardText(state = null) {
    const pageNum = Math.max(1, Number(state?.pageNum || 0) || 1);
    const titleBarRoute = String(state?.titleBarRoute || 'unknown').trim() || 'unknown';
    const dividerDotRoute = String(state?.dividerDotRoute || 'unknown').trim() || 'unknown';
    const dividerDblClickRoute = String(state?.dividerDblClickRoute || 'unknown').trim() || 'unknown';
    const mode = String(state?.mode || 'normal').trim() || 'normal';
    const pageCollapsed = !!state?.pageCollapsed ? 'on' : 'off';
    const pageCollapseDriverRaw = String(state?.pageCollapseDriver || 'legacy').trim() || 'legacy';
    const pageCollapseMode = String(state?.pageCollapseMode || '').trim() || 'off';
    const titleList = !!state?.titleListActive ? 'on' : 'off';
    const titleState = String(state?.titleState || 'expanded').trim() || 'expanded';
    const collapsedRows = Math.max(0, Number(state?.collapsedRows || 0) || 0);
    const totalRows = Math.max(0, Number(state?.totalRows || 0) || 0);
    const detachedHosts = Math.max(0, Number(state?.detachedHosts || 0) || 0);
    const hiddenQuestionHosts = Math.max(0, Number(state?.hiddenQuestionHosts || 0) || 0);
    const pageCollapseDriver = !state?.pageCollapsed && pageCollapseDriverRaw === 'legacy'
      ? 'none (legacy fallback)'
      : pageCollapseDriverRaw;
    return [
      `Page ${pageNum}`,
      ``,
      `Configured routes:`,
      `- title-bar: ${titleBarRoute}`,
      `- divider-dot: ${dividerDotRoute}`,
      `- divider-dblclick: ${dividerDblClickRoute}`,
      ``,
      `Current page state:`,
      `- mode: ${mode}`,
      `- page-collapse: ${pageCollapsed}`,
      `- page-collapse-driver: ${pageCollapseDriver}`,
      `- page-collapse-mode: ${pageCollapseMode}`,
      `- title-list: ${titleList}`,
      `- title-state: ${titleState}`,
      `- rows: ${collapsedRows}/${totalRows} collapsed`,
      `- detached-hosts: ${detachedHosts}`,
      `- hidden-question-hosts: ${hiddenQuestionHosts}`,
    ].join('\n');
  }

  function hideChatPageStatusCard(anchor = null) {
    const card = S.chatPageStatusCardEl;
    if (!(card instanceof HTMLElement)) return false;
    if (anchor && S.chatPageStatusCardAnchor && anchor !== S.chatPageStatusCardAnchor) return false;
    S.chatPageStatusCardAnchor = null;
    try { card.setAttribute('aria-hidden', 'true'); } catch {}
    try { card.style.opacity = '0'; } catch {}
    try { card.style.visibility = 'hidden'; } catch {}
    try { card.style.transform = 'translateY(4px)'; } catch {}
    return true;
  }

  function showChatPageStatusCard(divider = null) {
    if (!(divider instanceof HTMLElement)) return false;
    const card = ensureChatPageStatusCard();
    if (!(card instanceof HTMLElement)) return false;
    const pageNum = getChatPageDividerPageNum(divider);
    const chatId = String(resolveChatId() || '').trim();
    const state = getChatPageDividerDebugState(pageNum, chatId) || passiveGetChatPageDividerDebugState(pageNum, chatId);
    card.textContent = formatChatPageStatusCardText(state);

    try { card.style.left = '-9999px'; } catch {}
    try { card.style.top = '-9999px'; } catch {}
    try { card.style.visibility = 'hidden'; } catch {}
    try { card.style.opacity = '0'; } catch {}
    try { card.style.transform = 'translateY(4px)'; } catch {}

    const rect = divider.getBoundingClientRect();
    const viewportW = Math.max(0, Number(window.innerWidth || document.documentElement?.clientWidth || 0) || 0);
    const viewportH = Math.max(0, Number(window.innerHeight || document.documentElement?.clientHeight || 0) || 0);
    const margin = 10;
    const width = Math.max(0, Number(card.offsetWidth || 0) || 0);
    const height = Math.max(0, Number(card.offsetHeight || 0) || 0);
    let left = rect.left + (rect.width / 2) - (width / 2);
    let top = rect.top - height - margin;
    if (top < margin) top = rect.bottom + margin;
    left = Math.max(margin, Math.min(left, Math.max(margin, viewportW - width - margin)));
    top = Math.max(margin, Math.min(top, Math.max(margin, viewportH - height - margin)));

    try { card.style.left = `${Math.round(left)}px`; } catch {}
    try { card.style.top = `${Math.round(top)}px`; } catch {}
    try { card.style.visibility = 'visible'; } catch {}
    try { card.style.opacity = '1'; } catch {}
    try { card.style.transform = 'translateY(0)'; } catch {}
    try { card.setAttribute('aria-hidden', 'false'); } catch {}
    S.chatPageStatusCardAnchor = divider;
    return true;
  }

  function bindChatPageDividerStatusCard(divider = null) {
    if (!(divider instanceof HTMLElement)) return divider;
    if (divider.getAttribute?.(ATTR_CHAT_PAGE_STATUS_BOUND) === '1') return divider;
    try { divider.setAttribute(ATTR_CHAT_PAGE_STATUS_BOUND, '1'); } catch {}

    const open = () => { try { showChatPageStatusCard(divider); } catch {} };
    const close = (ev) => {
      const next = ev?.relatedTarget;
      if (next instanceof Node && divider.contains?.(next)) return;
      try { hideChatPageStatusCard(divider); } catch {}
    };

    divider.addEventListener('pointerenter', open);
    divider.addEventListener('pointerleave', close);
    divider.addEventListener('focusin', open);
    divider.addEventListener('focusout', close);
    return divider;
  }

  function coreFallback_getChatPageTitleListPages(chatId = '') {
    const id = String(chatId || resolveChatId()).trim();
    if (!id) return new Set();
    // Return in-memory cache if already loaded for this chatId
    const cached = S.titleListChatPagesByChat.get(id);
    if (cached instanceof Set) return new Set(cached);
    // First access for this chatId — lazy-load from localStorage
    try {
      const diskKey = `${KEY_TITLE_LIST_PAGES}:${id}`;
      const arr = storageGetJSON(diskKey, []);
      const loaded = new Set(
        (Array.isArray(arr) ? arr : []).map(n => Math.max(1, Number(n) || 0)).filter(n => n > 0)
      );
      S.titleListChatPagesByChat.set(id, loaded);
      return new Set(loaded);
    } catch {
      S.titleListChatPagesByChat.set(id, new Set()); // cache empty to avoid re-trying
      return new Set();
    }
  }

  function coreFallback_isChatPageTitleListActive(pageNum = 0, chatId = '') {
    const num = Math.max(1, Number(pageNum || 0) || 0);
    if (!num) return false;
    return getChatPageTitleListPages(chatId).has(num);
  }

  function coreFallback_setChatPageTitleListPages(chatId = '', pages = []) {
    const id = String(chatId || resolveChatId()).trim();
    if (!id) return new Set();
    const next = new Set();
    const src = Array.isArray(pages) ? pages : Array.from(pages || []);
    for (const page of src) {
      const num = Math.max(1, Number(page || 0) || 0);
      if (num) next.add(num);
    }
    S.titleListChatPagesByChat.set(id, next);
    // Persist to localStorage so state survives page refresh
    try {
      const diskKey = `${KEY_TITLE_LIST_PAGES}:${id}`;
      storageSetJSON(diskKey, Array.from(next));
    } catch {}
    return new Set(next);
  }

  function getAnswerTitleBarEl(answerMsgEl = null) {
    if (!answerMsgEl?.querySelector) return null;
    try { return answerMsgEl.querySelector(`:scope > ${ANSWER_TITLE_SEL}`) || answerMsgEl.querySelector(ANSWER_TITLE_SEL); } catch {}
    return answerMsgEl.querySelector(ANSWER_TITLE_SEL);
  }

  function getAnswerTitleAnswerId(answerMsgEl = null) {
    return String(
      answerMsgEl?.getAttribute?.('data-message-id')
      || answerMsgEl?.dataset?.messageId
      || answerMsgEl?.getAttribute?.('data-h2o-ans-id')
      || answerMsgEl?.dataset?.h2oAnsId
      || answerMsgEl?.getAttribute?.('data-cgxui-id')
      || ''
    ).trim();
  }

  function isAnswerTitleCollapsed(answerMsgEl = null, bar = null) {
    const answerId = getAnswerTitleAnswerId(answerMsgEl);
    const at = AT_PUBLIC();
    try {
      if (answerId && at?.isCollapsed && at.isCollapsed(answerId)) return true;
    } catch {}
    try {
      if (answerId && UM_PUBLIC()?.isCollapsedById?.(answerId)) return true;
    } catch {}
    return String(answerMsgEl?.getAttribute?.(ANSWER_TITLE_COLLAPSED_ATTR) || '').trim() === '1'
      || String(bar?.getAttribute?.('data-cgxui-state') || '').split(/\s+/).includes('collapsed');
  }

  function getAnswerTitleBodyEls(answerMsgEl = null, bar = null) {
    if (!answerMsgEl?.children) return [];
    const titleBar = bar || getAnswerTitleBarEl(answerMsgEl);
    return Array.from(answerMsgEl.children).filter((el) => el && el !== titleBar);
  }

  // Returns ALL elements that belong to the same turn as answerMsgEl but live
  // OUTSIDE it — thinking-disclosure blocks, "Stopped thinking" banners, quick-answer
  // links etc.  These elements appear at different DOM depths depending on the
  // ChatGPT version, so we walk every ancestor from answerMsgEl up to (but not
  // including) the conversation-turn host and collect siblings at each level.
  function getAnswerTitleSiblingEls(answerMsgEl = null) {
    if (!answerMsgEl) return [];
    const turnHost = getAnswerTitleTurnHost(answerMsgEl);
    if (!turnHost) return [];

    // Build the complete ancestor path from answerMsgEl up to (not including) turnHost.
    // These elements must never appear in the result — they contain the bar and the answer.
    const ancestorPath = new Set();
    let cur = answerMsgEl;
    while (cur && cur !== turnHost) {
      ancestorPath.add(cur);
      cur = cur.parentElement;
    }

    // For each ancestor, collect its siblings that are NOT in the ancestor path and NOT
    // owned by cgxui. This finds "Stopped thinking", "Quick answer" etc. at any DOM depth
    // without ever accidentally collecting an ancestor element itself.
    const result = [];
    const seen = new Set(ancestorPath); // pre-seed so ancestors are excluded from result

    for (const anc of ancestorPath) {
      const parent = anc.parentElement;
      if (!parent) continue;
      for (const sibling of parent.children) {
        if (seen.has(sibling)) continue;
        seen.add(sibling);
        if (sibling.getAttribute?.('data-cgxui') || sibling.getAttribute?.('data-cgxui-owner')) continue;
        result.push(sibling);
      }
    }
    return result;
  }

  function getAnswerTitleTurnHost(answerMsgEl = null) {
    if (!answerMsgEl) return null;
    return answerMsgEl.closest?.(STUDIO_SEL.sel.conversationTurnLoose) || answerMsgEl.parentElement || null;
  }


  function isTitleBarCollapsed(bar = null) {
    return String(bar?.getAttribute?.('data-cgxui-state') || '').split(/\s+/).includes('collapsed');
  }

  function getQuestionMessageEl(host = null) {
    if (!host || host.nodeType !== 1) return null;
    const selfRole = String(host.getAttribute?.('data-message-author-role') || '').trim().toLowerCase();
    if (selfRole === 'user') return host;
    try { return host.querySelector?.(STUDIO_SEL.sel.userTurn) || null; } catch {}
    return null;
  }

  function getNoAnswerTitleBarEl(host = null) {
    if (!host?.querySelector) return null;
    try { return host.querySelector(`:scope > ${ANSWER_TITLE_SEL}[${ANSWER_TITLE_NO_ANSWER_ATTR}="1"]`) || host.querySelector(`${ANSWER_TITLE_SEL}[${ANSWER_TITLE_NO_ANSWER_ATTR}="1"]`); } catch {}
    return host.querySelector(`${ANSWER_TITLE_SEL}[${ANSWER_TITLE_NO_ANSWER_ATTR}="1"]`);
  }

  function getNoAnswerTitleId(host = null) {
    const qEl = getQuestionMessageEl(host);
    const qId = String(
      qEl?.getAttribute?.('data-message-id')
      || qEl?.dataset?.messageId
      || host?.getAttribute?.('data-turn-id')
      || host?.dataset?.turnId
      || ''
    ).trim();
    if (qId) return `no-answer:${qId}`;
    const turns = qq(STUDIO_SEL.sel.conversationTurnLoose);
    const idx = Math.max(0, turns.indexOf(host));
    return `no-answer:dom:${idx + 1}`;
  }

  function getChatPageTurnDisplayNumber(host = null) {
    const qEl = getQuestionMessageEl(host);
    const candidates = [
      qEl?.getAttribute?.('data-message-id'),
      qEl?.dataset?.messageId,
      host?.getAttribute?.('data-turn-id'),
      host?.dataset?.turnId,
    ].map((v) => String(v || '').trim()).filter(Boolean);
    for (const id of candidates) {
      const rec = getSharedTurnRecordByAnyId(id);
      const turnNo = Math.max(0, Number(rec?.turnNo || rec?.idx || rec?.index || 0) || 0);
      if (turnNo > 0) return turnNo;
    }
    const turns = qq(STUDIO_SEL.sel.conversationTurnLoose);
    const idx = turns.indexOf(host);
    return idx >= 0 ? (idx + 1) : 0;
  }

  function removeNoAnswerTitleBar(host = null) {
    const bar = getNoAnswerTitleBarEl(host);
    if (bar) {
      try { bar.remove(); } catch {}
    }
    if (host) {
      host.removeAttribute?.(ATTR_CHAT_PAGE_NO_ANSWER);
      host.removeAttribute?.(ATTR_CHAT_PAGE_NO_ANSWER_QUESTION_HIDDEN);
    }
    return true;
  }

  function ensureNoAnswerTitleBar(host = null) {
    if (!host || host.nodeType !== 1) return null;
    if (pickAssistantMessageEl(host)) {
      removeNoAnswerTitleBar(host);
      return null;
    }
    const qEl = getQuestionMessageEl(host);
    if (!qEl) return null;

    let bar = getNoAnswerTitleBarEl(host);
    const isNew = !bar;   // track whether we just created the bar
    if (isNew) {
      bar = document.createElement('div');
      bar.setAttribute('data-cgxui-owner', 'atns');
      bar.setAttribute('data-cgxui', 'atns-answer-title');
      bar.setAttribute(ANSWER_TITLE_NO_ANSWER_ATTR, '1');
      bar.setAttribute('data-cgxui-state', 'editable');

      const badge = document.createElement('span');
      badge.setAttribute('data-cgxui-owner', 'atns');
      badge.setAttribute('data-cgxui', 'atns-answer-title-badge');
      badge.setAttribute('data-cgxui-part', 'badge');

      const label = document.createElement('span');
      label.setAttribute('data-cgxui-owner', 'atns');
      label.setAttribute('data-cgxui', 'atns-answer-title-label');
      label.setAttribute('data-cgxui-part', 'label');

      const text = document.createElement('span');
      text.setAttribute('data-cgxui-owner', 'atns');
      text.setAttribute('data-cgxui', 'atns-answer-title-text');
      text.setAttribute('data-cgxui-part', 'text');

      const icon = document.createElement('span');
      icon.setAttribute('data-cgxui-owner', 'atns');
      icon.setAttribute('data-cgxui', 'atns-answer-title-icon');
      icon.setAttribute('data-cgxui-part', 'icon');
      icon.setAttribute('aria-hidden', 'true');

      bar.appendChild(badge);
      bar.appendChild(label);
      bar.appendChild(text);
      bar.appendChild(icon);
    }

    const answerId = getNoAnswerTitleId(host);
    const turnNo = getChatPageTurnDisplayNumber(host);
    const labelEl = bar.querySelector?.(ANSWER_TITLE_LABEL_SEL) || null;
    const textEl  = bar.querySelector?.(ANSWER_TITLE_TEXT_SEL)  || null;
    const iconEl  = bar.querySelector?.(ANSWER_TITLE_ICON_SEL)  || null;
    // Always update label text (turn number can change after re-index)
    if (labelEl) labelEl.textContent = turnNo > 0 ? `TITLE ${turnNo}` : 'TITLE';
    if (textEl)  textEl.textContent  = 'NO ANSWER';
    // ONLY initialise icon and state on a freshly created bar.
    // If the bar already exists, it may be in collapsed state — do NOT reset it.
    if (isNew) {
      if (iconEl)  iconEl.textContent  = '⌄';
      try { bar.setAttribute('data-cgxui-state', 'editable'); } catch {}
    }
    try { bar.setAttribute('data-answer-id', answerId); } catch {}
    try { bar.setAttribute(ANSWER_TITLE_NO_ANSWER_ATTR, '1'); } catch {}
    try { host.setAttribute(ATTR_CHAT_PAGE_NO_ANSWER, '1'); } catch {}

    // Stamp data-message-id with the synthetic answerId so resolveAnswerEl()
    // finds this bar when the MiniMap btn for this no-answer turn is clicked.
    // Without this the flash fell back to the raw turn host, creating a weird strip.
    if (answerId) {
      try { bar.setAttribute('data-message-id', answerId); } catch {}
    }

    // Wire dblclick directly on the bar — same pattern Answer Title uses for regular bars.
    // Use bar.closest() at click time (not the closure `host`) so the reference is always live.
    if (!bar._noAnswerDblClickWired) {
      bar._noAnswerDblClickWired = true;
      bar.addEventListener('dblclick', (e) => {
        try { e.stopPropagation(); e.preventDefault(); } catch {}
        const liveHost = bar.closest(STUDIO_SEL.sel.conversationTurnLoose);
        if (!liveHost) return;
        const nextCollapsed = !isTitleBarCollapsed(bar);
        applyNoAnswerTitleCollapsedDom(liveHost, nextCollapsed, { animate: true });
        try { renderChatPageDividers(resolveChatId()); } catch {}
      });
    }

    // Insert the bar INSIDE qEl's immediate parent (the content wrapper / innerWrapper).
    // This gives the bar the same horizontal padding and positioning as the user message,
    // so it aligns correctly with the other title bars in the chat.
    // getNoAnswerManagedEls is aware of this and returns bar's SIBLINGS within that same
    // parent (not host.children), so the bar is correctly excluded from collapsing.
    const insertParent = (qEl.parentElement && qEl.parentElement !== host)
      ? qEl.parentElement
      : host;
    // Place bar immediately after qEl inside insertParent
    if (bar.parentElement !== insertParent || bar.previousElementSibling !== qEl) {
      try { insertParent.insertBefore(bar, qEl.nextElementSibling || null); } catch {}
    }
    return bar;
  }

  function getNoAnswerManagedEls(host = null, bar = null) {
    if (!host?.children) return [];
    const titleBar = bar || getNoAnswerTitleBarEl(host);
    if (!titleBar) return Array.from(host.children);

    // Build the complete ancestor path from titleBar up to (not including) host.
    // These are elements that contain or ARE the bar — they must never be collapsed.
    const ancestorPath = new Set();
    let cur = titleBar;
    while (cur && cur !== host) {
      ancestorPath.add(cur);
      cur = cur.parentElement;
    }

    // For each ancestor, collect its siblings (elements sharing the same parent that are
    // NOT in the ancestor path). This captures the question element, "Stopped thinking",
    // "Quick answer" etc. at every level without accidentally hiding the bar.
    const result = [];
    const seen = new Set(ancestorPath); // pre-seed so ancestors are excluded

    for (const anc of ancestorPath) {
      const parent = anc.parentElement;
      if (!parent) continue;
      for (const sibling of parent.children) {
        if (seen.has(sibling)) continue;
        seen.add(sibling);
        result.push(sibling);
      }
    }
    return result;
  }

  function applyNoAnswerTitleCollapsedDom(host = null, collapsed = false, opts = {}) {
    const bar = ensureNoAnswerTitleBar(host);
    if (!host || !bar) return { ok: false, status: 'missing-no-answer-title' };
    const animate = opts.animate !== false;
    const iconEl = bar.querySelector?.(ANSWER_TITLE_ICON_SEL) || null;
    const managedEls = getNoAnswerManagedEls(host, bar);
    if (collapsed) {
      bar.setAttribute('data-cgxui-state', 'collapsed editable');
      host.setAttribute(ATTR_CHAT_PAGE_NO_ANSWER_QUESTION_HIDDEN, '1');
      if (iconEl) iconEl.textContent = '›';
      managedEls.forEach((el) => {
        if (animate) el.style.transition = 'opacity 220ms ease, max-height 220ms ease, height 220ms ease';
        el.style.overflow = 'hidden';
        el.style.maxHeight = '0px';
        el.style.height = '0px';
        el.style.minHeight = '0px';
        el.style.marginTop = '0px';
        el.style.marginBottom = '0px';
        el.style.paddingTop = '0px';
        el.style.paddingBottom = '0px';
        el.style.borderTopWidth = '0px';
        el.style.borderBottomWidth = '0px';
        el.style.opacity = '0';
        el.style.pointerEvents = 'none';
        try { el.setAttribute('data-cgxui-at-hidden', '1'); } catch {}
      });
    } else {
      bar.setAttribute('data-cgxui-state', 'editable');
      host.removeAttribute(ATTR_CHAT_PAGE_NO_ANSWER_QUESTION_HIDDEN);
      if (iconEl) iconEl.textContent = '⌄';
      managedEls.forEach((el) => {
        if (animate) el.style.transition = 'opacity 220ms ease, max-height 220ms ease, height 220ms ease';
        el.style.overflow = '';
        el.style.maxHeight = '';
        el.style.height = '';
        el.style.minHeight = '';
        el.style.marginTop = '';
        el.style.marginBottom = '';
        el.style.paddingTop = '';
        el.style.paddingBottom = '';
        el.style.borderTopWidth = '';
        el.style.borderBottomWidth = '';
        el.style.opacity = '';
        el.style.pointerEvents = '';
        try { el.removeAttribute('data-cgxui-at-hidden'); } catch {}
        if (animate) {
          setTimeout(() => {
            try { el.style.transition = ''; } catch {}
          }, 270);
        }
      });
    }
    return { ok: true, status: 'ok', host, bar, collapsed: !!collapsed };
  }

  function isChatPageRowCollapsed(row = null) {
    if (!row) return false;
    if (row.noAnswer) {
      return isTitleBarCollapsed(row.titleBar) || String(row.questionHost?.getAttribute?.(ATTR_CHAT_PAGE_NO_ANSWER_QUESTION_HIDDEN) || '').trim() === '1';
    }
    return isAnswerTitleCollapsed(row.answerMsgEl, row.titleBar);
  }

  // Zero every spacing/sizing property on an element, covering all the ways
  // ChatGPT's Tailwind/CSS classes can create visible height.
  function _zeroElSpacing(el) {
    if (!el?.style) return;
    try { el.style.setProperty('min-height',         '0px',     'important'); } catch {}
    try { el.style.setProperty('height',             '0px',     'important'); } catch {}
    try { el.style.setProperty('max-height',         '0px',     'important'); } catch {}
    try { el.style.setProperty('padding-top',        '0px',     'important'); } catch {}
    try { el.style.setProperty('padding-bottom',     '0px',     'important'); } catch {}
    try { el.style.setProperty('padding-left',       '0px',     'important'); } catch {}
    try { el.style.setProperty('padding-right',      '0px',     'important'); } catch {}
    try { el.style.setProperty('margin-top',         '0px',     'important'); } catch {}
    try { el.style.setProperty('margin-bottom',      '0px',     'important'); } catch {}
    try { el.style.setProperty('gap',                '0px',     'important'); } catch {}
    try { el.style.setProperty('border-top-width',   '0px',     'important'); } catch {}
    try { el.style.setProperty('border-bottom-width','0px',     'important'); } catch {}
    try { el.style.setProperty('overflow',           'hidden',  'important'); } catch {}
    try { el.style.setProperty('opacity',            '0',       'important'); } catch {}
    try { el.style.setProperty('pointer-events',     'none',    'important'); } catch {}
  }

  // Remove all spacing/sizing overrides set by _zeroElSpacing.
  function _restoreElSpacing(el) {
    if (!el?.style) return;
    const props = [
      'min-height','height','max-height',
      'padding-top','padding-bottom','padding-left','padding-right',
      'margin-top','margin-bottom','gap',
      'border-top-width','border-bottom-width',
      'overflow','opacity','pointer-events',
    ];
    for (const p of props) { try { el.style.removeProperty(p); } catch {} }
  }

  // Properties that ChatGPT's Tailwind classes set and that create visible vertical space.
  const _COMPACT_ZERO_PROPS = [
    'min-height', 'padding-top', 'padding-bottom',
    'margin-top', 'margin-bottom', 'gap',
    'border-top-width', 'border-bottom-width',
  ];

  // Zero all spacing props on a single element with !important.
  function _compactZeroEl(el) {
    if (!el?.style) return;
    for (const p of _COMPACT_ZERO_PROPS) {
      try { el.style.setProperty(p, '0px', 'important'); } catch {}
    }
    try { el.setAttribute('data-cgxui-chat-page-title-wrapper', '1'); } catch {}
  }

  // Remove all spacing overrides added by _compactZeroEl.
  function _compactRestoreEl(el) {
    if (!el?.style) return;
    for (const p of _COMPACT_ZERO_PROPS) {
      try { el.style.removeProperty(p); } catch {}
    }
    try { el.removeAttribute('data-cgxui-chat-page-title-wrapper'); } catch {}
  }

  // Collect every DOM ancestor between msgEl (exclusive) and host (exclusive).
  // This handles any number of intermediate wrappers ChatGPT may insert.
  function _getAncestorsBetween(innerEl, outerEl) {
    const ancestors = [];
    if (!innerEl || !outerEl) return ancestors;
    let cur = innerEl.parentElement;
    while (cur && cur !== outerEl) {
      ancestors.push(cur);
      cur = cur.parentElement;
    }
    return ancestors;
  }

  function applyChatPageTitleListCompactDom(row = null, active = false) {
    const isNoAnswer = !!row?.noAnswer;
    const host  = row?.answerHost || row?.questionHost || null;
    const bar   = row?.titleBar || null;
    const msgEl = row?.answerMsgEl || null;
    const compact = !!active && isChatPageRowCollapsed(row);
    if (!host) return false;

    // All ancestors between msgEl and host (exclusive on both ends).
    // For no-answer rows msgEl is null; we still want to zero innerWrapper etc.
    const ancestors = msgEl ? _getAncestorsBetween(msgEl, host) : [];

    // For no-answer rows the gap source is the innerWrapper of the question host.
    // We find it as the first child of host (same logic, no msgEl to walk from).
    const noAnswerInner = isNoAnswer ? (host.firstElementChild || null) : null;

    if (compact) {
      host.setAttribute?.(ATTR_CHAT_PAGE_TITLE_ITEM, '1');

      // 1) Host: zero its own spacing (host itself rarely has ChatGPT padding, but be safe)
      try { host.style.setProperty('min-height',    '0px', 'important'); } catch {}
      try { host.style.setProperty('padding-top',   '0px', 'important'); } catch {}
      try { host.style.setProperty('padding-bottom','0px', 'important'); } catch {}
      try { host.style.setProperty('margin-top',    '0px', 'important'); } catch {}
      try { host.style.setProperty('margin-bottom', `${TITLE_LIST_ROW_GAP_PX}px`, 'important'); } catch {}
      try { host.style.setProperty('gap',           '0px', 'important'); } catch {}

      // 2) Walk EVERY ancestor between msgEl and host and zero them all.
      //    This catches innerWrapper (py-5), any agent-turn div, any flex wrappers, etc.
      //    regardless of how many levels ChatGPT inserts between them.
      for (const anc of ancestors) {
        if (anc === bar) continue; // never touch the bar itself
        _compactZeroEl(anc);
      }

      // 3) For no-answer rows: also zero the first-child wrapper directly
      if (isNoAnswer && noAnswerInner && noAnswerInner !== bar) {
        _compactZeroEl(noAnswerInner);
      }

      // 4) msgEl itself (the [data-message-author-role="assistant"] element)
      if (msgEl) {
        try { msgEl.style.setProperty('min-height',    '0px', 'important'); } catch {}
        try { msgEl.style.setProperty('padding-top',   '0px', 'important'); } catch {}
        try { msgEl.style.setProperty('padding-bottom','0px', 'important'); } catch {}
        try { msgEl.style.setProperty('margin-top',    '0px', 'important'); } catch {}
        try { msgEl.style.setProperty('margin-bottom', '0px', 'important'); } catch {}
        try { msgEl.style.setProperty('gap',           '0px', 'important'); } catch {}
      }

      // 5) Bar: always visible, tight bottom margin only
      if (bar) {
        try { bar.style.setProperty('margin-top',    '0px', 'important'); } catch {}
        try { bar.style.setProperty('margin-bottom', `${TITLE_LIST_ROW_GAP_PX}px`, 'important'); } catch {}
        try { bar.style.removeProperty('display'); } catch {}
        try { bar.style.removeProperty('visibility'); } catch {}
        try { bar.style.removeProperty('opacity'); } catch {}
      }

      // 6) No-answer host must stay as block (not display:none)
      if (isNoAnswer) {
        try { host.style.setProperty('display', 'block', 'important'); } catch {}
      }

    } else {
      // ── EXPAND: remove all inline overrides ──────────────────────────
      host.removeAttribute?.(ATTR_CHAT_PAGE_TITLE_ITEM);
      const hostRestoreProps = ['min-height','padding-top','padding-bottom','margin-top','margin-bottom','gap'];
      for (const p of hostRestoreProps) { try { host.style.removeProperty(p); } catch {} }
      if (isNoAnswer) { try { host.style.removeProperty('display'); } catch {} }

      for (const anc of ancestors) {
        if (anc === bar) continue;
        _compactRestoreEl(anc);
      }

      if (isNoAnswer && noAnswerInner && noAnswerInner !== bar) {
        _compactRestoreEl(noAnswerInner);
      }

      if (msgEl) {
        const mProps = ['min-height','padding-top','padding-bottom','margin-top','margin-bottom','gap'];
        for (const p of mProps) { try { msgEl.style.removeProperty(p); } catch {} }
      }

      if (bar) {
        try { bar.style.removeProperty('margin-top'); } catch {}
        try { bar.style.removeProperty('margin-bottom'); } catch {}
      }
    }
    return true;
  }

  function getAnswerTitleToolbarEls(answerMsgEl = null) {
    const turnHost = getAnswerTitleTurnHost(answerMsgEl);
    if (!turnHost?.querySelectorAll) return [];
    const selectors = [
      '[aria-label="Response actions"]',
      '[data-testid="response-actions"]',
    ];
    const out = [];
    const seen = new Set();
    for (const sel of selectors) {
      let nodes = [];
      try { nodes = Array.from(turnHost.querySelectorAll(sel)); } catch {}
      for (const el of nodes) {
        if (!el || seen.has(el)) continue;
        seen.add(el);
        out.push(el);
      }
    }
    return out;
  }

  function applyAnswerTitleCollapsedDom(answerMsgEl = null, collapsed = false, opts = {}) {
    const msgEl = answerMsgEl || null;
    const bar = getAnswerTitleBarEl(msgEl);
    if (!msgEl || !bar) return { ok: false, status: 'missing-title-bar' };
    const answerId = String(opts.answerId || getAnswerTitleAnswerId(msgEl)).trim();
    const animate = opts.animate !== false;
    const at = AT_PUBLIC();
    if (answerId && at?.setCollapsed) {
      try {
        return at.setCollapsed(answerId, !!collapsed, {
          animate,
          source: String(opts?.source || 'minimap-core:compat').trim() || 'minimap-core:compat',
        });
      } catch {}
    }
    const iconEl = bar.querySelector?.(ANSWER_TITLE_ICON_SEL) || null;
    const bodyEls = getAnswerTitleBodyEls(msgEl, bar);
    const siblingEls = getAnswerTitleSiblingEls(msgEl);
    const toolbarEls = getAnswerTitleToolbarEls(msgEl).filter((el) => !bodyEls.includes(el) && !siblingEls.includes(el));
    const managedEls = bodyEls.concat(siblingEls).concat(toolbarEls);
    if (collapsed) {
      bar.setAttribute('data-cgxui-state', 'collapsed editable');
      msgEl.setAttribute(ANSWER_TITLE_COLLAPSED_ATTR, '1');
      if (iconEl) iconEl.textContent = '›';
      managedEls.forEach((el) => {
        if (animate) {
          el.style.transition = 'opacity 220ms ease, max-height 220ms ease, height 220ms ease';
        }
        el.style.overflow = 'hidden';
        el.style.maxHeight = '0px';
        el.style.height = '0px';
        el.style.minHeight = '0px';
        el.style.marginTop = '0px';
        el.style.marginBottom = '0px';
        el.style.paddingTop = '0px';
        el.style.paddingBottom = '0px';
        el.style.borderTopWidth = '0px';
        el.style.borderBottomWidth = '0px';
        el.style.opacity = '0';
        el.style.pointerEvents = 'none';
      });
      // Also stamp a CSS attribute on sibling/toolbar elements so the Skin CSS rule
      // can hide them with !important — this survives React re-renders that reset inline styles.
      siblingEls.concat(toolbarEls).forEach(el => {
        try { el.setAttribute('data-cgxui-at-hidden', '1'); } catch {}
      });
    } else {
      bar.setAttribute('data-cgxui-state', 'editable');
      msgEl.removeAttribute(ANSWER_TITLE_COLLAPSED_ATTR);
      if (iconEl) iconEl.textContent = '⌄';
      managedEls.forEach((el) => {
        if (animate) {
          el.style.transition = 'opacity 220ms ease, max-height 220ms ease, height 220ms ease';
        }
        el.style.overflow = '';
        el.style.maxHeight = '';
        el.style.height = '';
        el.style.minHeight = '';
        el.style.marginTop = '';
        el.style.marginBottom = '';
        el.style.paddingTop = '';
        el.style.paddingBottom = '';
        el.style.borderTopWidth = '';
        el.style.borderBottomWidth = '';
        el.style.opacity = '';
        el.style.pointerEvents = '';
        if (animate) {
          setTimeout(() => {
            try { el.style.transition = ''; } catch {}
          }, 270);
        }
      });
      // Remove the React-resistant CSS attribute from sibling/toolbar elements
      siblingEls.concat(toolbarEls).forEach(el => {
        try { el.removeAttribute('data-cgxui-at-hidden'); } catch {}
      });
    }
    if (answerId) {
      try { window.dispatchEvent(new CustomEvent(EV_ANSWER_COLLAPSE, { detail: { answerId, collapsed: !!collapsed } })); } catch {}
    }
    return { ok: true, status: 'ok', answerId, collapsed: !!collapsed, bar, msgEl };
  }

  function setQuestionHostTitleListHidden(host = null, hidden = false) {
    if (!host) return null;
    if (hidden) {
      host.setAttribute(ATTR_CHAT_PAGE_QUESTION_HIDDEN, '1');
      try { host.style.setProperty('display', 'none', 'important'); } catch {}
    } else {
      host.removeAttribute(ATTR_CHAT_PAGE_QUESTION_HIDDEN);
      try { host.style.removeProperty('display'); } catch {}
    }
    return host;
  }

  function buildChatPageAnswerRows(pageNum = 0) {
    const num = Math.max(1, Number(pageNum || 0) || 0);
    if (!num) return [];
    const payload = buildChatPageSections();
    const section = payload?.sections?.get?.(num) || null;
    const hosts = Array.isArray(section?.hosts) ? section.hosts : [];
    const rows = [];
    let pendingQuestionHost = null;
    for (let i = 0; i < hosts.length; i += 1) {
      const host = hosts[i];
      const role = getChatPageTurnRole(host);
      if (role === 'user') {
        const nextHost = hosts[i + 1] || null;
        const nextRole = getChatPageTurnRole(nextHost);
        if (nextRole === 'assistant') {
          removeNoAnswerTitleBar(host);
          pendingQuestionHost = host;
        } else {
          const bar = ensureNoAnswerTitleBar(host);
          const answerId = String(bar?.getAttribute?.('data-answer-id') || getNoAnswerTitleId(host)).trim();
          if (bar && answerId) {
            rows.push({
              pageNum: num,
              questionHost: host,
              answerHost: host,
              answerMsgEl: null,
              answerId,
              titleBar: bar,
              collapsed: isTitleBarCollapsed(bar),
              noAnswer: true,
            });
          }
          pendingQuestionHost = null;
        }
        continue;
      }
      if (role !== 'assistant') continue;
      if (pendingQuestionHost) removeNoAnswerTitleBar(pendingQuestionHost);
      const answerMsgEl = pickAssistantMessageEl(host) || host.querySelector?.(STUDIO_SEL.sel.assistantTurn) || null;
      const answerId = getAnswerTitleAnswerId(answerMsgEl);
      const bar = getAnswerTitleBarEl(answerMsgEl);
      if (!answerMsgEl || !answerId || !bar) {
        pendingQuestionHost = null;
        continue;
      }
      rows.push({
        pageNum: num,
        questionHost: pendingQuestionHost || null,
        answerHost: host,
        answerMsgEl,
        answerId,
        titleBar: bar,
        collapsed: isAnswerTitleCollapsed(answerMsgEl, bar),
        noAnswer: false,
      });
      pendingQuestionHost = null;
    }
    return rows;
  }

  function syncNoAnswerTitleBars(chatId = '') {
    const id = String(chatId || resolveChatId()).trim();
    void id;

    // Pass 1: section-based sweep (handles paginated chats)
    const payload = buildChatPageSections();
    const sections = payload?.sections;
    let ensured = 0;
    if (sections instanceof Map && sections.size) {
      for (const [pageNum] of sections) {
        const rows = buildChatPageAnswerRows(pageNum);
        for (const row of rows) {
          if (row?.noAnswer) ensured += 1;
        }
      }
    }

    // Pass 2: direct DOM sweep — catches orphaned user turns that the section
    // builder missed (e.g. a trailing question with no answer yet, or a chat
    // where S.turnList hasn't been populated yet).
    try {
      const allTurnEls = qq(STUDIO_SEL.sel.conversationTurnLoose);
      for (let i = 0; i < allTurnEls.length; i += 1) {
        const host = allTurnEls[i];
        const role = getChatPageTurnRole(host);
        if (role !== 'user') continue;
        if (pickAssistantMessageEl(host)) continue; // has assistant reply inside → skip
        // Lookahead: if the next turn element is an assistant turn, this user
        // turn is part of a normal Q+A pair — do NOT create a NO ANSWER bar.
        // This mirrors the same lookahead logic buildChatPageAnswerRows uses.
        const nextTurn = allTurnEls[i + 1] || null;
        if (nextTurn && getChatPageTurnRole(nextTurn) === 'assistant') continue;
        // Ensure the NO ANSWER bar is present in this orphaned turn
        const bar = ensureNoAnswerTitleBar(host);
        if (bar) ensured += 1;
      }
    } catch (_e) {}

    return ensured;
  }

  function findChatPageRowByAnswerId(answerId = '') {
    const target = String(answerId || '').trim();
    if (!target) return null;
    const payload = buildChatPageSections();
    const sections = payload?.sections;
    if (!(sections instanceof Map)) return null;
    for (const [pageNum] of sections) {
      const rows = buildChatPageAnswerRows(pageNum);
      const hit = rows.find((row) => String(row?.answerId || '').trim() === target) || null;
      if (hit) return hit;
    }
    return null;
  }

  function coreFallback_getChatPageTitleState(pageNum = 0, chatId = '') {
    const rows = buildChatPageAnswerRows(pageNum);
    if (!rows.length) return 'expanded';
    const collapsedCount = rows.filter((row) => isChatPageRowCollapsed(row)).length;
    if (collapsedCount <= 0) return 'expanded';
    if (collapsedCount >= rows.length && coreFallback_isChatPageTitleListActive(pageNum, chatId)) return 'collapsed';
    return 'mixed';
  }

  function coreFallback_applyChatPageTitleListPageVisuals(pageNum = 0, chatId = '') {
    const active = coreFallback_isChatPageTitleListActive(pageNum, chatId);
    const rows = buildChatPageAnswerRows(pageNum);
    // Set the gap CSS variable whenever we apply visuals for an active title-list page
    if (active) {
      try { document.documentElement.style.setProperty('--cgxui-title-list-row-gap', `${TITLE_LIST_ROW_GAP_PX}px`); } catch {}
    }
    for (const row of rows) {
      if (row.noAnswer) {
        // Force-collapse when title-list is active regardless of current DOM state.
        // On restore from refresh the DOM is clean (no collapsed state yet) so we must
        // always drive it to match the saved title-list state.
        applyNoAnswerTitleCollapsedDom(row.answerHost, active, { animate: false });
      } else {
        if (active && !isChatPageRowCollapsed(row)) {
          // Row is not yet collapsed (e.g. page just loaded and AT hasn't run yet) —
          // force-collapse now so the title-list layout is immediately correct.
          applyAnswerTitleCollapsedDom(row.answerMsgEl, true, { answerId: row.answerId, animate: false });
        }
        setQuestionHostTitleListHidden(row.questionHost, active);
      }
      applyChatPageTitleListCompactDom(row, active);
    }
    return rows;
  }

  function coreFallback_setChatPageTitleListMode(pageNum = 0, enabled = true, chatId = '', source = 'core') {
    // Sync the gap CSS variable with the JS constant so the Skin CSS uses the same value.
    try { document.documentElement.style.setProperty('--cgxui-title-list-row-gap', `${TITLE_LIST_ROW_GAP_PX}px`); } catch {}
    const id = String(chatId || resolveChatId()).trim();
    const num = Math.max(1, Number(pageNum || 0) || 0);
    if (!id || !num) {
      return { ok: false, status: !id ? 'chat-id-missing' : 'page-missing', chatId: id, pageNum: num, enabled: !!enabled };
    }
    const next = coreFallback_getChatPageTitleListPages(id);
    const rows = buildChatPageAnswerRows(num);
    if (enabled) next.add(num); else next.delete(num);
    coreFallback_setChatPageTitleListPages(id, Array.from(next));
    for (const row of rows) {
      // Collapse/expand body and question visibility FIRST
      if (row.noAnswer) {
        applyNoAnswerTitleCollapsedDom(row.answerHost, !!enabled, { animate: true });
      } else {
        applyAnswerTitleCollapsedDom(row.answerMsgEl, !!enabled, { answerId: row.answerId, animate: true });
        setQuestionHostTitleListHidden(row.questionHost, !!enabled);
      }
      // THEN apply compact spacing — now isChatPageRowCollapsed() reflects the new state
      applyChatPageTitleListCompactDom(row, !!enabled);
    }

    // Safety sweep on EXPAND: do a direct DOM scan to restore ALL hidden question hosts.
    // This handles stale row.questionHost references (React re-renders) and clears
    // inline styles set by EITHER Core (display:none) OR Answer Title (height:0/opacity:0).
    if (!enabled) {
      const restoreProps = ['display', 'overflow', 'max-height', 'height', 'min-height',
                           'margin-top', 'margin-bottom', 'padding-top', 'padding-bottom',
                           'border-top-width', 'border-bottom-width', 'opacity',
                           'pointer-events', 'transition'];
      try {
        for (const qHost of qq('[data-cgxui-chat-page-question-hidden="1"]')) {
          qHost.removeAttribute('data-cgxui-chat-page-question-hidden');
          for (const p of restoreProps) { try { qHost.style.removeProperty(p); } catch {} }
        }
      } catch {}
      try {
        for (const qHost of qq('[data-at-question-hidden="1"]')) {
          qHost.removeAttribute('data-at-question-hidden');
          for (const p of restoreProps) { try { qHost.style.removeProperty(p); } catch {} }
        }
      } catch {}
    }
    try { renderChatPageDividers(id); } catch {}
    return {
      ok: true,
      status: 'ok',
      source: String(source || 'core'),
      chatId: id,
      pageNum: num,
      enabled: !!enabled,
      rows: rows.length,
    };
  }

  function coreFallback_toggleChatPageTitleListMode(pageNum = 0, chatId = '', source = 'core') {
    const id = String(chatId || resolveChatId()).trim();
    const num = Math.max(1, Number(pageNum || 0) || 0);
    const next = !coreFallback_isChatPageTitleListActive(num, id);
    return coreFallback_setChatPageTitleListMode(num, next, id, source);
  }

function passiveReadChatPageSet() {
  return new Set();
}

function passiveIsChatPageCollapsed() {
  return false;
}

function passiveGetChatPageTitleState() {
  return 'expanded';
}

function passiveGetChatPageDividerDebugState(pageNum = 0, chatId = '') {
  const id = String(chatId || resolveChatId() || '').trim();
  const num = Math.max(1, Number(pageNum || 0) || 0);
  return {
    ok: false,
    status: 'chat-pages-controller-unavailable',
    pageNum: num,
    chatId: id,
    titleBarRoute: 'unknown',
    dividerDotRoute: 'unknown',
    dividerDblClickRoute: 'unknown',
    mode: 'normal',
    pageCollapsed: false,
    pageCollapseDriver: 'legacy',
    pageCollapseMode: '',
    titleListActive: false,
    titleState: 'expanded',
    collapsedRows: 0,
    totalRows: 0,
    detachedHosts: 0,
    hiddenQuestionHosts: 0,
  };
}

function passiveChatPagesWriteResult(pageNum = 0, extra = {}) {
  const chatId = String(extra?.chatId || '').trim();
  const source = String(extra?.source || 'core-passive').trim() || 'core-passive';
  const num = Math.max(1, Number(pageNum || 0) || 0);
  return Object.assign({
    ok: false,
    status: 'chat-pages-controller-unavailable',
    chatId,
    pageNum: num,
    source,
  }, extra || {});
}

function passiveBindChatPageDividerBridge(force = false) {
  return {
    ok: false,
    status: 'chat-pages-controller-unavailable',
    force: !!force,
    source: 'core-passive',
  };
}

function passiveUnbindChatPageDividerBridge() {
  return {
    ok: false,
    status: 'chat-pages-controller-unavailable',
    source: 'core-passive',
  };
}

function readCollapsedChatPages(chatId = '') {
  return callChatPagesCtl('readCollapsedPages', [chatId], passiveReadChatPageSet);
}

function isChatPageCollapsed(pageNum = 0, chatId = '') {
  return callChatPagesCtl('isPageCollapsed', [pageNum, chatId], passiveIsChatPageCollapsed);
}

function setChatPageCollapsed(pageNum = 0, collapsed = true, chatId = '', source = 'core') {
  return callChatPagesCtl(
    'setPageCollapsed',
    [pageNum, collapsed, { chatId, source }],
    (num, nextCollapsed, opts = {}) => passiveChatPagesWriteResult(num, {
      chatId: String(opts?.chatId || chatId || '').trim(),
      collapsed: !!nextCollapsed,
      source: String(opts?.source || source || 'core-passive').trim() || 'core-passive',
    })
  );
}

function toggleChatPageCollapsed(pageNum = 0, chatId = '', source = 'core') {
  return callChatPagesCtl(
    'togglePageCollapsed',
    [pageNum, { chatId, source }],
    (num, opts = {}) => passiveChatPagesWriteResult(num, {
      chatId: String(opts?.chatId || chatId || '').trim(),
      source: String(opts?.source || source || 'core-passive').trim() || 'core-passive',
    })
  );
}

function getChatPageTitleListPages(chatId = '') {
  return callChatPagesCtl('readTitleListPages', [chatId], passiveReadChatPageSet);
}

function setChatPageTitleListPages(chatId = '', pages = []) {
  return callChatPagesCtl(
    'writeTitleListPages',
    [chatId, pages],
    (id, nextPages = []) => ({
      ok: false,
      status: 'chat-pages-controller-unavailable',
      chatId: String(id || chatId || '').trim(),
      pages: Array.isArray(nextPages) ? nextPages.slice() : Array.from(nextPages || []),
      source: 'core-passive',
    })
  );
}

function isChatPageTitleListActive(pageNum = 0, chatId = '') {
  return callChatPagesCtl('isTitleListActive', [pageNum, chatId], passiveIsChatPageCollapsed);
}

function getChatPageTitleState(pageNum = 0, chatId = '') {
  return callChatPagesCtl('getTitleState', [pageNum, chatId], passiveGetChatPageTitleState);
}

function getChatPageDividerUiMode(pageNum = 0, chatId = '', opts = {}) {
  const num = Math.max(1, Number(pageNum || 0) || 0);
  const id = String(chatId || resolveChatId() || '').trim();
  const fallbackMode = !!opts?.pageCollapsed
    ? 'page_collapsed'
    : (coreFallback_isChatPageTitleListActive(num, id) ? 'title_list' : 'normal');
  const mode = callChatPagesCtl('getDividerUiMode', [num, id], () => fallbackMode);
  const raw = String(mode || fallbackMode).trim();
  return raw === 'page_collapsed' || raw === 'title_list' ? raw : 'normal';
}

function getChatPageDividerDebugState(pageNum = 0, chatId = '') {
  return callChatPagesCtl('getPageDividerDebugState', [pageNum, chatId], passiveGetChatPageDividerDebugState);
}

function setChatPageTitleListMode(pageNum = 0, enabled = true, chatId = '', source = 'core') {
  return callChatPagesCtl(
    'setTitleListMode',
    [pageNum, enabled, { chatId, source }],
    (num, nextEnabled, opts = {}) => passiveChatPagesWriteResult(num, {
      chatId: String(opts?.chatId || chatId || '').trim(),
      enabled: !!nextEnabled,
      source: String(opts?.source || source || 'core-passive').trim() || 'core-passive',
    })
  );
}

function toggleChatPageTitleListMode(pageNum = 0, chatId = '', source = 'core') {
  return callChatPagesCtl(
    'toggleTitleListMode',
    [pageNum, { chatId, source }],
    (num, opts = {}) => passiveChatPagesWriteResult(num, {
      chatId: String(opts?.chatId || chatId || '').trim(),
      source: String(opts?.source || source || 'core-passive').trim() || 'core-passive',
    })
  );
}

function applyChatPageTitleListPageVisuals(pageNum = 0, chatId = '') {
  return callChatPagesCtl(
    'applyTitleListVisuals',
    [pageNum, { chatId }],
    (num, opts = {}) => passiveChatPagesWriteResult(num, {
      chatId: String(opts?.chatId || chatId || '').trim(),
      source: String(opts?.source || 'core-passive').trim() || 'core-passive',
    })
  );
}

function applyChatPageDividerVisuals(divider = null, pageNum = 0, chatId = '') {
  if (!(divider instanceof HTMLElement)) return false;
  return callChatPagesCtl(
    'applyDividerVisualsToDivider',
    [divider, { pageNum, chatId }],
    () => false
  );
}

function bindChatPageDividerBridge(force = false) {
  return callChatPagesCtl('bind', [{ force }], passiveBindChatPageDividerBridge);
}

function ensureChatPageDividerBridge(force = false) {
  return callChatPagesCtl('bind', [{ force }], passiveBindChatPageDividerBridge);
}

function unbindChatPageDividerBridge() {
  return callChatPagesCtl('unbind', [], passiveUnbindChatPageDividerBridge);
}
  function getChatPageDividerPageNum(divider = null) {
    return Math.max(1, Number(
      divider?.getAttribute?.('data-page-num')
      || divider?.getAttribute?.(ATTR_CHAT_PAGE_NUM)
      || 0
    ) || 0);
  }

  function getChatPageDividerLabelEl(divider = null) {
    if (!divider?.querySelector) return null;
    return divider.querySelector('.cgxui-chat-page-divider-label, .cgxui-pgnw-page-divider-pill');
  }

  function createChatPageDivider(pageNum = 1, band = 'normal') {
    const div = document.createElement('div');
    div.className = 'cgxui-chat-page-divider';
    div.setAttribute('data-cgxui-owner', UI_TOK.OWNER);
    div.setAttribute(ATTR_CHAT_PAGE_DIVIDER, '1');
    div.setAttribute('data-page-num', String(pageNum || 1));
    div.setAttribute('data-page-band', String(band || 'normal'));
    div.innerHTML = `<span class="cgxui-chat-page-divider-line"></span><span class="cgxui-chat-page-divider-label"><span class="cgxui-chat-page-divider-dot" aria-hidden="true"></span><span class="cgxui-chat-page-divider-text">Page ${String(pageNum || 1)}</span></span><span class="cgxui-chat-page-divider-line"></span>`;
    return div;
  }

  function getChatPageAnchorBoxEl(host = null) {
    if (!host || host.nodeType !== 1) return null;
    const assistantHost = pickAssistantMessageEl(host) || host.querySelector?.(STUDIO_SEL.sel.assistantTurn) || host;
    if (!assistantHost) return null;
    const toolbar = assistantHost.querySelector?.('[aria-label="Response actions"]');
    if (toolbar instanceof Element && toolbar.isConnected) return toolbar;
    try {
      const content = assistantHost.querySelector?.('.markdown, .prose, [class*="prose"], .whitespace-pre-wrap, [data-message-content], [class*="message"]');
      if (content instanceof Element && content.isConnected) return content;
    } catch {}
    return assistantHost;
  }

  function getChatPageAnchorCenterX(host = null) {
    const box = getChatPageAnchorBoxEl(host) || host || null;
    if (!box) return NaN;
    try {
      const rect = box.getBoundingClientRect();
      const w = Number(rect?.width || 0) || 0;
      if (!w) return NaN;
      return Number(rect.left || 0) + (w / 2);
    } catch {
      return NaN;
    }
  }

  function getPreviousChatPageAnchorHost(host = null) {
    let cur = host?.previousElementSibling || null;
    while (cur) {
      if (isChatPageDividerEl(cur)) {
        cur = cur.previousElementSibling || null;
        continue;
      }
      const role = getChatPageTurnRole(cur);
      if (role === 'assistant' || role === 'user') return cur;
      cur = cur.previousElementSibling || null;
    }
    return null;
  }

  function applyChatPageDividerGeometry(divider = null, prevHost = null, nextHost = null) {
    if (!divider || !divider.isConnected) return false;
    const label = divider.querySelector?.('.cgxui-chat-page-divider-label') || null;
    const leftLine = divider.querySelector?.('.cgxui-chat-page-divider-line:first-child') || divider.children?.[0] || null;
    const rightLine = divider.querySelector?.('.cgxui-chat-page-divider-line:last-child') || divider.children?.[2] || null;
    if (!label || !leftLine || !rightLine) return false;

    const dividerRect = divider.getBoundingClientRect();
    const rowWidth = Number(dividerRect?.width || 0) || 0;
    if (!rowWidth) return false;

    const anchorHost = prevHost || getPreviousChatPageAnchorHost(divider) || nextHost || null;
    let anchorCenter = getChatPageAnchorCenterX(anchorHost);
    if (!Number.isFinite(anchorCenter)) anchorCenter = Number(dividerRect.left || 0) + (rowWidth / 2);

    const centerLocal = anchorCenter - Number(dividerRect.left || 0);
    const labelRect = label.getBoundingClientRect();
    const labelWidth = Math.max(108, Number(labelRect?.width || 0) || 0);
    const minLine = 24;
    const gap = 12;
    const clampedCenter = Math.max((labelWidth / 2) + minLine + gap, Math.min(rowWidth - ((labelWidth / 2) + minLine + gap), centerLocal));
    const leftWidth = Math.max(minLine, clampedCenter - (labelWidth / 2) - gap);
    const rightWidth = Math.max(minLine, rowWidth - clampedCenter - (labelWidth / 2) - gap);
    const labelLeft = Math.max(leftWidth + gap, Math.min(rowWidth - rightWidth - gap - labelWidth, clampedCenter - (labelWidth / 2)));

    try {
      divider.style.setProperty('--cgxui-chat-page-label-left', `${labelLeft}px`);
      divider.style.setProperty('--cgxui-chat-page-label-width', `${labelWidth}px`);
      divider.style.setProperty('--cgxui-chat-page-left-line-w', `${leftWidth}px`);
      divider.style.setProperty('--cgxui-chat-page-right-line-w', `${rightWidth}px`);
      divider.style.setProperty('--cgxui-chat-page-center-x', `${clampedCenter}px`);
      divider.setAttribute('data-cgxui-chat-geometry', '1');
    } catch {}
    return true;
  }

  function isChatPageDividerEl(el, pageNum = 0) {
    if (!el?.classList) return false;
    const isKnownDivider =
      el.getAttribute?.(ATTR_CHAT_PAGE_DIVIDER) === '1'
      || el.classList.contains('cgxui-chat-page-divider')
      // Pagination may own the functional surface, but it still participates in the shared chat page divider UI layer.
      || el.classList.contains('cgxui-pgnw-page-divider');
    if (!isKnownDivider) return false;
    const num = Math.max(1, Number(pageNum || 0) || 0);
    if (!num) return true;
    return getChatPageDividerPageNum(el) === num;
  }

  function resolveChatPageDividerEl(target = null) {
    const el = (target instanceof Element)
      ? target
      : ((target?.parentElement instanceof Element)
        ? target.parentElement
        : ((target?.parentNode instanceof Element) ? target.parentNode : null));
    if (!el?.closest) return null;
    return el.closest('.cgxui-chat-page-divider, .cgxui-pgnw-page-divider');
  }

  function getChatPageTurnRole(host = null) {
    if (!host || host.nodeType !== 1) return '';
    const selfRole = String(host.getAttribute?.('data-message-author-role') || '').trim().toLowerCase();
    if (selfRole === 'user' || selfRole === 'assistant') return selfRole;
    if (pickAssistantMessageEl(host)) return 'assistant';
    try {
      const userEl = host.querySelector?.(STUDIO_SEL.sel.userTurn);
      if (userEl) return 'user';
    } catch {}
    return '';
  }

  function addChatPageSectionHost(section, host) {
    if (!section || !host || host.nodeType !== 1) return false;
    if (!(section.hostSet instanceof Set)) section.hostSet = new Set();
    if (section.hostSet.has(host)) return false;
    section.hostSet.add(host);
    section.hosts.push(host);
    return true;
  }

  function buildChatPageSectionsFromPaginationState() {
    const ps = getPaginationState();
    const masterTurns = Array.isArray(ps?.masterTurns) ? ps.masterTurns : [];
    if (!masterTurns.length) return null;

    // Page boundaries must use Core turnNo (true pair number), not answerIndex.
    // answerIndex skips unanswered turns (e.g. answerIndex 26 = pair 27 when
    // pair 19 is unanswered), causing the section boundary to land one pair late.
    const pageSize = Math.max(1, Number(ps?.pageSize || 0) || 25);
    const rt = getTurnRuntimeApi();

    const sections = new Map();
    const allHosts = [];
    const allHostSet = new Set();

    // Track the last resolved pageNum so unanswered-question turns inherit
    // the page of the surrounding answered turns.
    let lastPageNum = 1;

    for (let i = 0; i < masterTurns.length; i += 1) {
      const row = masterTurns[i] || null;
      const host = row?.node || null;
      if (!host || host.nodeType !== 1) continue;

      const answerIndex = Math.max(0, Number(row?.answerIndex || 0) || 0);
      let pageNum;
      if (answerIndex > 0) {
        // Resolve true pair number via Core turnRuntime.
        let pairNo = 0;
        const aId = String(row?.answerId || '').trim();
        if (rt && aId) {
          try {
            const rec = rt.getTurnRecordByAId?.(aId) || null;
            pairNo = Math.max(0, Number(rec?.turnNo || rec?.idx || 0) || 0);
          } catch {}
        }
        if (!pairNo) pairNo = answerIndex; // fallback when Core not yet reconciled
        pageNum = Math.max(1, Math.ceil(pairNo / pageSize));
        lastPageNum = pageNum;
      } else {
        // Unanswered question: inherit page from surrounding answered turns.
        // Look ahead for the next answered turn's pairNo.
        let found = false;
        for (let j = i + 1; j < masterTurns.length; j += 1) {
          const nextRow = masterTurns[j] || null;
          const nextAIdx = Math.max(0, Number(nextRow?.answerIndex || 0) || 0);
          if (nextAIdx > 0) {
            let nextPairNo = 0;
            const nextAId = String(nextRow?.answerId || '').trim();
            if (rt && nextAId) {
              try {
                const rec = rt.getTurnRecordByAId?.(nextAId) || null;
                nextPairNo = Math.max(0, Number(rec?.turnNo || rec?.idx || 0) || 0);
              } catch {}
            }
            if (!nextPairNo) nextPairNo = nextAIdx;
            pageNum = Math.max(1, Math.ceil(nextPairNo / pageSize));
            found = true;
            break;
          }
        }
        if (!found) pageNum = lastPageNum;
      }

      let section = sections.get(pageNum);
      if (!section) {
        section = {
          pageNum,
          band: String(getTurnPageBand(pageNum * pageSize) || 'normal'),
          hosts: [],
          hostSet: new Set(),
        };
        sections.set(pageNum, section);
      }
      addChatPageSectionHost(section, host);
      if (!allHostSet.has(host)) {
        allHostSet.add(host);
        allHosts.push(host);
      }
    }

    return sections.size ? { sections, allHosts } : null;
  }

  function buildChatPageSectionsFromTurnList() {
    const turns = Array.isArray(S.turnList) ? S.turnList : [];
    if (!turns.length) return null;

    const sections = new Map();
    const allHosts = [];
    const allHostSet = new Set();

    for (const turn of turns) {
      const idx = Math.max(1, Number(turn?.index || 0) || 0);
      if (!idx) continue;

      const host = getChatPageTurnHost(turn);
      if (!host) continue;

      const pageNum = Math.max(1, Math.ceil(idx / 25));
      let section = sections.get(pageNum);
      if (!section) {
        section = {
          pageNum,
          band: String(getTurnPageBand(idx) || 'normal'),
          hosts: [],
          hostSet: new Set(),
        };
        sections.set(pageNum, section);
      }

      let prev = host.previousElementSibling || null;
      while (prev && isChatPageDividerEl(prev)) prev = prev.previousElementSibling || null;
      if (prev && getChatPageTurnRole(prev) === 'user') addChatPageSectionHost(section, prev);
      addChatPageSectionHost(section, host);
    }

    // ── Orphaned user-turn sweep ──────────────────────────────────────────────
    // getChatPageTurnHost() returns null for turns with no assistant element,
    // so any user-only turn (question without an answer) is skipped by the loop
    // above.  We scan the live DOM here and add those turns so that
    // buildChatPageAnswerRows can later call ensureNoAnswerTitleBar on them.
    try {
      const allTurnEls = qq(STUDIO_SEL.sel.conversationTurnLoose);
      for (const domHost of allTurnEls) {
        if (allHostSet.has(domHost)) continue;
        const role = getChatPageTurnRole(domHost);
        if (role !== 'user') continue;
        if (pickAssistantMessageEl(domHost)) continue; // has assistant → not orphaned

        // Determine page by walking back to the nearest already-placed sibling.
        let pageNum = 1;
        let sib = domHost.previousElementSibling;
        outer: while (sib) {
          if (!isChatPageDividerEl(sib)) {
            for (const [pn, sec] of sections) {
              if (sec.hostSet instanceof Set && sec.hostSet.has(sib)) { pageNum = pn; break outer; }
            }
          }
          sib = sib.previousElementSibling;
        }

        let section = sections.get(pageNum);
        if (!section) {
          section = { pageNum, band: String(getTurnPageBand((pageNum - 1) * 25 + 1) || 'normal'), hosts: [], hostSet: new Set() };
          sections.set(pageNum, section);
        }
        addChatPageSectionHost(section, domHost);
      }
    } catch (_e) {}
    // ─────────────────────────────────────────────────────────────────────────

    for (const section of sections.values()) {
      for (const host of section.hosts) {
        if (allHostSet.has(host)) continue;
        allHostSet.add(host);
        allHosts.push(host);
      }
    }

    return { sections, allHosts };
  }

  // Direct DOM scan — no dependency on Pagination or S.turnList.
  // Finds all live conversation-turn containers and assigns them to pages
  // purely from their DOM position order. This is the independent fallback
  // that makes collapse work regardless of whether Pagination is loaded.
  function buildChatPageSectionsFromDom() {
    const turnEls = qq(STUDIO_SEL.sel.conversationTurnLoose);
    if (!turnEls.length) return null;

    const sections = new Map();
    const allHosts = [];
    const allHostSet = new Set();
    let answerIdx = 0;

    for (const host of turnEls) {
      // Count only assistant turns for page numbering (mirrors how Core indexes turns)
      const isAssistant = !!host.querySelector(STUDIO_SEL.sel.assistantTurn);
      if (isAssistant) answerIdx += 1;

      const pageNum = Math.max(1, Math.ceil(Math.max(1, answerIdx) / 25));

      if (!allHostSet.has(host)) {
        allHostSet.add(host);
        allHosts.push(host);
      }

      let section = sections.get(pageNum);
      if (!section) {
        section = {
          pageNum,
          band: String(getTurnPageBand(Math.max(1, answerIdx)) || 'normal'),
          hosts: [],
          hostSet: new Set(),
        };
        sections.set(pageNum, section);
      }
      addChatPageSectionHost(section, host);
    }

    return { sections, allHosts };
  }

  function buildChatPageSections() {
    return buildChatPageSectionsFromPaginationState()
      || buildChatPageSectionsFromTurnList()
      || buildChatPageSectionsFromDom()
      || { sections: new Map(), allHosts: [] };
  }

  function setChatPageTurnHostDomState(host, pageNum = 0, collapsed = false) {
    if (!host) return null;
    const num = Math.max(1, Number(pageNum || 0) || 0);
    if (num) host.setAttribute(ATTR_CHAT_PAGE_NUM, String(num));
    else host.removeAttribute(ATTR_CHAT_PAGE_NUM);
    if (collapsed) {
      host.setAttribute(ATTR_CHAT_PAGE_HIDDEN, '1');
      // Also set inline display:none so the node is hidden regardless of
      // whether the Skin CSS is loaded — this is the only reliable way to
      // hide unanswered-question turn nodes (e.g. Q19 with no answer) which
      // have no assistant element and may not be caught by CSS attribute rules.
      try { host.style.setProperty('display', 'none', 'important'); } catch {}
    } else {
      host.removeAttribute(ATTR_CHAT_PAGE_HIDDEN);
      try { host.style.removeProperty('display'); } catch {}
    }
    return host;
  }

  function setChatPageDividerDomState(divider, collapsed = false, pageNum = 0, band = 'normal', chatId = '') {
    if (!divider) return null;
    const num = Math.max(1, Number(pageNum || getChatPageDividerPageNum(divider) || 0) || 1);
    const id = String(chatId || resolveChatId() || '').trim();
    const uiMode = getChatPageDividerUiMode(num, id, { pageCollapsed: !!collapsed });
    const effectiveCollapsed = uiMode === 'page_collapsed';
    const effectiveTitleListActive = uiMode === 'title_list';
    const effectiveTitleState = effectiveTitleListActive ? 'collapsed' : 'expanded';
    divider.setAttribute(ATTR_CHAT_PAGE_DIVIDER, '1');
    divider.setAttribute(ATTR_CHAT_PAGE_NUM, String(num));
    if (divider.classList?.contains('cgxui-chat-page-divider')) {
      divider.setAttribute('data-page-num', String(num));
      divider.setAttribute('data-page-band', String(band || 'normal'));
    }
    ensureChatPageDividerMarkup(divider, num);
    bindChatPageDividerStatusCard(divider);
    if (effectiveCollapsed) divider.setAttribute(ATTR_CHAT_PAGE_COLLAPSED, '1');
    else divider.removeAttribute(ATTR_CHAT_PAGE_COLLAPSED);

    if (effectiveTitleListActive) divider.setAttribute(ATTR_CHAT_PAGE_TITLE_LIST, '1');
    else divider.removeAttribute(ATTR_CHAT_PAGE_TITLE_LIST);

    divider.setAttribute(ATTR_CHAT_PAGE_TITLE_STATE, effectiveTitleState);
    const dot = getChatPageDividerDotEl(divider);
    if (dot) {
      try { dot.setAttribute('data-page-title-state', effectiveTitleState); } catch {}
      try { dot.removeAttribute('title'); } catch {}
    }

    const title = `Page ${num}`;
    const label = getChatPageDividerLabelEl(divider);
    if (label) {
      try { label.setAttribute('aria-expanded', effectiveCollapsed ? 'false' : 'true'); } catch {}
      try { label.title = title; } catch {}
    }
    try { divider.title = title; } catch {}
    return divider;
  }

  function isChatPageHostHidden(host = null) {
    if (!host) return false;
    if (String(host.getAttribute?.(ATTR_CHAT_PAGE_HIDDEN) || '').trim() === '1') return true;
    try {
      return String(host.style?.getPropertyValue?.('display') || '').trim().toLowerCase() === 'none';
    } catch {
      return false;
    }
  }

  function getChatPageSectionCollapsedState(pageNum = 0, chatId = '', hosts = []) {
    const num = Math.max(1, Number(pageNum || 0) || 0);
    const id = String(chatId || resolveChatId() || '').trim();
    const sectionHosts = Array.isArray(hosts) ? hosts : [];
    for (const host of sectionHosts) {
      if (isChatPageHostHidden(host)) return true;
    }
    if (num) {
      try {
        if (document.querySelector?.(`[${ATTR_CHAT_PAGE_NUM}="${String(num)}"][${ATTR_CHAT_PAGE_HIDDEN}="1"]`)) return true;
      } catch {}
    }
    return !!(num && readCollapsedChatPages(id)?.has?.(num));
  }

  function renderChatPageDividers(chatId = '') {
    const perfOwned = enterPerfOwner('divider');
    const perfT0 = perfNow();
    try {
      const id = String(chatId || resolveChatId() || '').trim();
      const existingCoreDividers = qq(`.cgxui-chat-page-divider[data-cgxui-owner="${escAttr(UI_TOK.OWNER)}"]`);
      const keepCoreDividers = new Set();
      const { sections } = buildChatPageSections();
      if (!sections.size) {
        for (const divider of existingCoreDividers) {
          try { divider.remove(); } catch {}
        }
        return false;
      }
      try { syncNoAnswerTitleBars(id); } catch {}
      let createdCount = 0;
      let reusedCount = 0;

      for (const section of sections.values()) {
        const pageNum = Math.max(1, Number(section?.pageNum || 0) || 0);
        if (!pageNum) continue;

        const hosts = Array.isArray(section?.hosts) ? section.hosts : [];
        const pageCollapsed = getChatPageSectionCollapsedState(pageNum, id, hosts);
        const band = String(section?.band || getTurnPageBand(((pageNum - 1) * 25) + 1) || 'normal');

        // Page 1 divider IS rendered (at the top of the conversation) but is
        // not collapsible — the dblclick handler already guards against that.
        const startHost = hosts[0] || null;
        if (!startHost?.parentNode) continue;

        let divider = startHost.previousElementSibling;
        if (!isChatPageDividerEl(divider, pageNum)) {
          divider =
            startHost.parentNode?.querySelector?.(`.cgxui-pgnw-page-divider[data-page-num="${String(pageNum)}"]`)
            || startHost.parentNode?.querySelector?.(`.cgxui-chat-page-divider[data-cgxui-owner="${escAttr(UI_TOK.OWNER)}"][data-page-num="${String(pageNum)}"]`)
            || null;
        }
        if (!divider) {
          divider = createChatPageDivider(pageNum, band);
          createdCount += 1;
          noteNodeLifecycle('created', 'chatPageDividers');
        } else {
          reusedCount += 1;
          noteNodeLifecycle('reused', 'chatPageDividers');
        }
        setChatPageDividerDomState(divider, pageCollapsed, pageNum, band, id);

        if (divider.classList?.contains('cgxui-chat-page-divider')) {
          if (divider.parentNode !== startHost.parentNode || divider.nextSibling !== startHost) {
            try { startHost.parentNode.insertBefore(divider, startHost); } catch {}
          }
          try {
            const prevHost = getPreviousChatPageAnchorHost(startHost);
            applyChatPageDividerGeometry(divider, prevHost, startHost);
            applyChatPageDividerVisuals(divider, pageNum, id);
            requestAnimationFrame(() => {
              try {
                const livePrevHost = getPreviousChatPageAnchorHost(startHost);
                applyChatPageDividerGeometry(divider, livePrevHost, startHost);
                applyChatPageDividerVisuals(divider, pageNum, id);
              } catch {}
            });
          } catch {}
          keepCoreDividers.add(divider);
        }
      }

      let removedCount = 0;
      for (const divider of existingCoreDividers) {
        if (keepCoreDividers.has(divider)) continue;
        removedCount += 1;
        try { divider.remove(); } catch {}
      }
      if (createdCount > 0) noteRenderUnit('chatPageDividers', createdCount);
      if (reusedCount > 0) noteRenderUnit('chatPageDividers', reusedCount);
      if (removedCount > 0) noteNodeLifecycle('removed', 'chatPageDividers', removedCount);
      PERF.dividerUi.createdCount = Number(PERF.dividerUi.createdCount || 0) + createdCount;
      PERF.dividerUi.reusedCount = Number(PERF.dividerUi.reusedCount || 0) + reusedCount;
      PERF.dividerUi.removedCount = Number(PERF.dividerUi.removedCount || 0) + removedCount;
      try { document.documentElement.setAttribute(ATTR_CHAT_PAGE_DIVIDERS, getChatPageDividersEnabled() ? '1' : '0'); } catch {}
      return true;
    } finally {
      const ms = perfNow() - perfT0;
      recordDuration(PERF.paths.renderChatPageDividers, ms);
      if (perfOwned) {
        recordDuration(PERF.dividerUi, ms);
        noteSummaryBucket(PERF.dividerUi, 'renderChatPageDividers');
      }
      exitPerfOwner('divider');
    }
  }

  function centerOnPageDivider(pageNum, { smooth = true } = {}) {
    const label = getMiniMapPageDividerLabel(pageNum);
    if (!label) return false;
    return centerMiniMapNode(label, { smooth });
  }

  function updateToggleColor(anyId) {
    const perfOwned = enterPerfOwner('incremental');
    const perfT0 = perfNow();
    try {
      const key = String(anyId || '').trim();
      if (!key) return false;
      const tg = toggleEl();
      if (!tg) return false;

      const turn = findTurnByAnyId(key);
      const btnId = String(turn?.turnId || key).trim();
      const primaryId = String(turn?.answerId || getBtnById(btnId)?.dataset?.primaryAId || '').trim();
      const washMap = (W?.H2O?.MM?.washMap && typeof W.H2O.MM.washMap === 'object') ? W.H2O.MM.washMap : {};
      const colorName = washMap[primaryId || btnId] || null;
      const raw = COLOR_BY_NAME[colorName] || colorName || '';
      tg.style.background = raw ? `color-mix(in srgb, ${raw} 30%, #2f2f2f)` : '#2f2f2f';
      return true;
    } finally {
      const ms = perfNow() - perfT0;
      recordDuration(PERF.paths.updateToggleColor, ms);
      if (perfOwned) {
        recordDuration(PERF.incrementalRefresh, ms);
        noteSummaryBucket(PERF.incrementalRefresh, 'updateToggleColor');
      }
      exitPerfOwner('incremental');
    }
  }

  function applyToggleCounterPageBand(turnIndex = 0, total = 0) {
    const band = total > 0 ? getTurnPageBand(Math.max(1, Number(turnIndex || 1) || 1)) : 'normal';
    const tg = toggleEl();
    const tEl = toggleCountEl();
    if (tg) tg.setAttribute('data-page-band', band);
    if (tEl) tEl.setAttribute('data-page-band', band);
    return band;
  }

  function updateCounter(anyId = '') {
    const perfOwned = enterPerfOwner('incremental');
    const perfT0 = perfNow();
    try {
      const key = String(anyId || '').trim();

      // When pagination is active, the canonical turn list (S.turnList) only
      // contains answered turns (e.g. 34 for a 35-turn chat with one unanswered
      // question). Use H2O Core's turn total instead, which counts all Q+A pairs
      // including unanswered ones — giving the correct 35.
      const coreTurnTotal = Math.max(0, Number(W?.H2O?.turn?.total?.() || 0) || 0);
      const paginationEnabled = isPaginationWindowingEnabled();
      const total = Number(
        (paginationEnabled && coreTurnTotal > 0)
          ? coreTurnTotal
          : (S.turnList.length || coreTurnTotal || getAnswerEls().length || 0)
      );

      let idx = Number(getTurnIndex(key));
      if (!idx && key.startsWith('turn:')) {
        const m = key.match(/(\d+)$/);
        if (m) idx = Number(m[1]) || 0;
      }
      if (!idx) idx = total > 0 ? 1 : 0;

      const cEl = counterEl();
      if (cEl) cEl.textContent = `Answer: ${idx}/${total}`;

      const tEl = toggleCountEl();
      if (tEl) {
        tEl.textContent = `${idx}/${total}`;
      }
      applyToggleCounterPageBand(idx, total);

      if (key) updateToggleColor(key);
      noteRenderUnit('counterUpdates');
      return true;
    } finally {
      const ms = perfNow() - perfT0;
      recordDuration(PERF.paths.updateCounter, ms);
      if (perfOwned) {
        recordDuration(PERF.incrementalRefresh, ms);
        noteSummaryBucket(PERF.incrementalRefresh, 'updateCounter');
      }
      exitPerfOwner('incremental');
    }
  }

  function resolveRebuildActiveId() {
    try {
      const fastBtn = S.lastActiveBtnEl;
      const fastId = String(fastBtn?.dataset?.turnId || fastBtn?.dataset?.id || '').trim();
      if (fastBtn?.isConnected && fastId) return fastId;
    } catch {}
    const fast = String(S.lastActiveTurnIdFast || '').trim();
    if (fast) return fast;
    try {
      const active = q('[data-cgxui="mnmp-btn"][data-cgxui-state~="active"], [data-cgxui="mm-btn"][data-cgxui-state~="active"], .cgxui-mm-btn.active');
      const activeId = String(active?.dataset?.turnId || active?.dataset?.id || active?.dataset?.primaryAId || '').trim();
      if (activeId) return activeId;
    } catch {}
    const viewport = computeActiveFromViewport({});
    const viewportId = String(viewport?.activeTurnId || viewport?.activeAnswerId || '').trim();
    if (viewportId) return viewportId;
    const first = S.turnList[0] || null;
    return String(first?.turnId || first?.answerId || '').trim();
  }

  function finalizeRebuildUi(reason = 'core:rebuild') {
    const activeId = resolveRebuildActiveId();
    if (activeId) {
      setActive(activeId, `rebuild:${String(reason || 'core:rebuild')}`);
      return true;
    }
    updateCounter('');
    return false;
  }

  function syncActiveFromViewport(opts = {}) {
    const active = computeActiveFromViewport(opts);
    const id = String(active?.activeTurnId || active?.activeAnswerId || '').trim();
    if (!id) return active;

    if (opts?.center) centerOn(id, { force: false, smooth: true });
    else setActive(id, 'viewport-sync');

    if (opts?.relabel) {
      try { W.relabelMiniMap?.(); } catch {}
    }
    return Object.assign({}, active, { syncedId: id });
  }

  function resolveAnswerEl(target) {
    if (!target) return null;
    if (target && target.nodeType === 1) return target;
    const id = String(target || '').trim();
    if (!id) return null;
    try {
      const esc = escAttr(id);
      return q(`[data-message-id="${esc}"]`) ||
        q(`[data-cgxui-id="${esc}"]`) ||
        q(`[data-h2o-ans-id="${esc}"]`) ||
        q(`[data-h2o-core-id="${esc}"]`) ||
        // Fallback for no-answer title bars which carry data-answer-id with the synthetic id
        q(`[data-answer-id="${esc}"][${ANSWER_TITLE_NO_ANSWER_ATTR}="1"]`);
    } catch {
      return null;
    }
  }

  function parseFlashDurationMs(raw, fallback = 1600) {
    const s = String(raw || '').trim().toLowerCase();
    if (!s) return fallback;
    if (s.endsWith('ms')) {
      const n = Number(s.slice(0, -2));
      return Number.isFinite(n) && n > 0 ? n : fallback;
    }
    if (s.endsWith('s')) {
      const n = Number(s.slice(0, -1));
      return Number.isFinite(n) && n > 0 ? Math.round(n * 1000) : fallback;
    }
    const n = Number(s);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  }

  function getPageFlashDurationMs(target = null) {
    const fallback = 1600;
    const sources = [
      (target instanceof Element) ? target : null,
      document.documentElement,
    ].filter(Boolean);
    for (const source of sources) {
      try {
        const raw = String(getComputedStyle(source).getPropertyValue('--cgxui-mnmp-flash-ms') || '').trim();
        const ms = parseFlashDurationMs(raw, 0);
        if (ms > 0) return ms;
      } catch {}
    }
    return fallback;
  }

  function applyTempFlash(answerEl, opts = null) {
    const target = answerEl?.querySelector?.('[data-message-content]') || answerEl;
    if (!target) return false;
    try {
      const flashMs = Math.max(200, getPageFlashDurationMs(target) + 80);
      const surface = String(opts?.surface || 'answer').trim().toLowerCase() === 'question' ? 'question' : 'answer';
      const hadWrap = !!target.classList?.contains?.(FLASH_CLS.WASH_WRAP);
      const hadWrapLegacy = !!target.classList?.contains?.(FLASH_CLS.WASH_WRAP_LEGACY);
      const hasAnyWashTintClass = () => {
        const inlineBandColor = String(
          target.style?.getPropertyValue?.('--h2o-band-color')
          || target.style?.getPropertyValue?.('--cgxui-mnmp-band-color')
          || ''
        ).trim();
        const inlineBandOpacity = String(
          target.style?.getPropertyValue?.('--h2o-band-opacity')
          || target.style?.getPropertyValue?.('--cgxui-mnmp-band-opacity')
          || ''
        ).trim();
        if (inlineBandColor || inlineBandOpacity) return true;
        const classes = Array.from(target.classList || []);
        return classes.some((cls) => {
          if (!cls || cls === FLASH_CLS.WASH_WRAP || cls === FLASH_CLS.WASH_WRAP_LEGACY) return false;
          return cls.startsWith('cgxui-mnmp-wash-') || cls.startsWith('cgxui-wash-');
        });
      };
      target.classList?.add?.(FLASH_CLS.WASH_WRAP, FLASH_CLS.WASH_WRAP_LEGACY);
      target.classList?.remove?.(FLASH_CLS.FLASH, FLASH_CLS.FLASH_LEGACY);
      try { target.removeAttribute('data-cgxui-flash'); } catch {}
      try { target.setAttribute('data-cgxui-flash-surface', surface); } catch {}
      void target.offsetWidth;
      target.classList?.add?.(FLASH_CLS.FLASH, FLASH_CLS.FLASH_LEGACY);
      try { target.setAttribute('data-cgxui-flash', '1'); } catch {}
      setTimeout(() => {
        try { target.classList?.remove?.(FLASH_CLS.FLASH, FLASH_CLS.FLASH_LEGACY); } catch {}
        try { target.removeAttribute('data-cgxui-flash'); } catch {}
        try { target.removeAttribute('data-cgxui-flash-surface'); } catch {}
        const keepWrap = hasAnyWashTintClass();
        if (!hadWrap && !keepWrap) {
          try { target.classList?.remove?.(FLASH_CLS.WASH_WRAP); } catch {}
        }
        if (!hadWrapLegacy && !keepWrap) {
          try { target.classList?.remove?.(FLASH_CLS.WASH_WRAP_LEGACY); } catch {}
        }
      }, flashMs);
      return true;
    } catch {
      return false;
    }
  }

  function flashAnswer(target) {
    const el = resolveAnswerEl(target);
    if (!el) return false;
    try { applyTempFlash(el); } catch {}
    try {
      const aId = String(getMessageId(el) || '').trim();
      if (aId) {
        const { SEL } = getRegs();
        const btn = q(SEL.MM_BTN_BY_PRIMARY_A_ID?.(aId) || '') ||
          q(SEL.MM_BTN_BY_ID?.(aId) || '') ||
          q(`[data-cgxui$="btn"][data-primary-a-id="${escAttr(aId)}"]`) ||
          q(`[data-cgxui$="btn"][data-id="${escAttr(aId)}"]`);
        if (btn) {
          try { btn.setAttribute('data-cgxui-flash', '1'); } catch {}
          setTimeout(() => { try { btn.removeAttribute('data-cgxui-flash'); } catch {} }, 1200);
        }
      }
    } catch {}
    return true;
  }

  function emitAnswersScan(reason = 'core') {
    const SH = TOPW.H2O_MM_SHARED?.get?.();
    const EV = SH?.EV_ || SH?.registries?.EV || W?.H2O?.EV || {};
    const evtName = EV.ANSWERS_SCAN || 'evt:h2o:answers:scan';
    try { W.H2O?.bus?.emit?.('answers:scan', { reason }); } catch {}
    try { window.dispatchEvent(new CustomEvent(evtName, { detail: { reason } })); } catch {}
  }

  function behaviorApi() {
    try { return MM_behavior() || null; } catch { return null; }
  }

  function getBehavior(force = false) {
    const api = behaviorApi();
    try { return api?.get?.(!!force) || api?.defaults?.() || null; } catch { return null; }
  }

  function setBehavior(next, reason = 'core:setBehavior') {
    const api = behaviorApi();
    try { return api?.set?.(next, reason) || getBehavior(true); } catch { return getBehavior(true); }
  }

  function validateBehavior(next, opts = {}) {
    const api = behaviorApi();
    try { return api?.validate?.(next, opts) || api?.defaults?.() || null; } catch { return api?.defaults?.() || null; }
  }

  function makeRebuildResult(reason, status = 'not-ready') {
    return {
      ok: status === 'ok',
      status,
      reason: String(reason || 'core:rebuildNow'),
      built: {
        ui: false,
        turns: 0,
        buttons: false,
      },
      retry: {
        scheduled: false,
        count: Number(S.retryCount || 0),
        kind: String(S.retryKind || ''),
      },
    };
  }

  function clearRetry() {
    try { if (S.retryTimer) clearTimeout(S.retryTimer); } catch {}
    S.retryTimer = null;
    S.retryCount = 0;
    S.retryKind = '';
    S.retryReason = '';
  }

  function scheduleRetry(kind = 'retry', reason = 'core:retry') {
    if (S.retryTimer) return false;
    if (S.retryCount >= EMPTY_RETRY_MAX) return false;
    S.retryCount += 1;
    S.retryKind = String(kind || 'retry');
    S.retryReason = String(reason || S.rebuildReason || 'core:retry');
    const delay = Math.min(1400, EMPTY_RETRY_GAP_MS * (2 ** Math.max(0, S.retryCount - 1)));
    S.retryTimer = setTimeout(() => {
      S.retryTimer = null;
      const why = `${S.retryReason}:retry:${S.retryKind}:${S.retryCount}`;
      rebuildNow(why);
    }, delay);
    return true;
  }

  function ensureUiRefsForRebuild(reason = 'core:rebuildNow') {
    const ui = MM_ui();
    let refs = MM_uiRefs();
    const hasRefs = !!(refs?.root && refs?.panel);
    if (hasRefs) return { ui, refs, ready: true };
    try { ui?.ensureUI?.(`core:rebuildNow:${reason}`); } catch {}
    refs = MM_uiRefs();
    return { ui, refs, ready: !!(refs?.root && refs?.panel) };
  }

  function cancelScheduledRebuild() {
    const schedule = TOPW?.H2O?.runtime?.schedule || W?.H2O?.runtime?.schedule || null;
    if (schedule) {
      try { schedule.cancel('minimap:rebuild'); } catch {}
      try { schedule.cancel('minimap:rebuild:fallback'); } catch {}
    }
    if (S.rebuildRaf) {
      try { cancelAnimationFrame(S.rebuildRaf); } catch {}
      S.rebuildRaf = 0;
    }
    if (S.rebuildTimer) {
      try { clearTimeout(S.rebuildTimer); } catch {}
      S.rebuildTimer = null;
    }
  }

  function invalidateScheduledRebuild() {
    S.rebuildToken += 1;
    cancelScheduledRebuild();
  }

  function runScheduledRebuild(token) {
    if (!token || token !== S.rebuildToken) return false;
    // Consume this cycle token before running rebuild so correctness does not depend on rebuildNow internals.
    S.rebuildToken += 1;
    cancelScheduledRebuild();
    rebuildNow(S.rebuildReason);
    return true;
  }

  function rebuildNow(reason = 'core:rebuildNow') {
    const perfT0 = PERF_ASSERT_ON ? performance.now() : 0;
    const scanTick0 = Number(S.perfFullScanTick || 0);
    const why = String(reason || 'core:rebuildNow');
    // Direct rebuild must run immediately and clear any pending scheduled handles.
    cancelScheduledRebuild();
    S.rebuildReason = why;
    if (S.rebuildInFlight) {
      S.rebuildReason = why;
      const queued = makeRebuildResult(why, 'queued');
      S.lastRebuildResult = queued;
      perfReportDuration('rebuildNow', perfT0, scanTick0, {
        reason: why,
        status: 'queued',
        turns: Number(S.turnList.length || 0),
      });
      return queued;
    }

    S.rebuildInFlight = true;
    let out = makeRebuildResult(why, 'not-ready');
    try {
      const ensured = ensureUiRefsForRebuild(why);
      out.built.ui = !!ensured.ready;
      if (!ensured.ready) {
        out.reason = 'ui-missing';
        out.retry.scheduled = scheduleRetry('ui-missing', why);
        out.retry.count = S.retryCount;
        out.retry.kind = S.retryKind;
        S.lastRebuildResult = out;
        return out;
      }
      applyMiniMapPageUiPrefs();

      const snapshot = indexTurns({ commit: false });
      const list = Array.isArray(snapshot?.list) ? snapshot.list : [];
      out.built.turns = list.length;
      if (!out.built.turns) {
        out.reason = 'turns-empty';
        out.retry.scheduled = scheduleRetry('turns-empty', why);
        out.retry.count = S.retryCount;
        out.retry.kind = S.retryKind;
        S.lastRebuildResult = out;
        return out;
      }

      const rt = MM_rt();
      let map = null;
      let usedFallbackEnsureButtons = false;
      if (rt && typeof rt.ensureButtons === 'function') {
        try {
          map = rt.ensureButtons({
            reason: `core:${why}`,
            turns: list.slice(),
            refs: ensured.refs || {},
          }) || null;
        } catch (e) {
          safeDiag('err', 'core.rebuildNow:rt.ensureButtons', e);
        }
      }
      if (!(map instanceof Map)) {
        map = ensureTurnButtons(list, { skipActiveSync: true });
        usedFallbackEnsureButtons = true;
      }
      out.built.buttons = !!(map && map.size >= 0);
      if (!out.built.buttons) {
        out.status = 'partial';
        out.reason = 'buttons-missing';
        out.retry.scheduled = scheduleRetry('buttons-missing', why);
        out.retry.count = S.retryCount;
        out.retry.kind = S.retryKind;
        S.lastRebuildResult = out;
        return out;
      }
      publishTurnSnapshot(snapshot);
      if (!usedFallbackEnsureButtons) {
        try { repaintAllMiniBtns(); } catch {}
      }
      const activeId = String(S.lastActiveTurnIdFast || S.lastActiveBtnId || '').trim();
      if (activeId) {
        try { setActive(activeId, `rebuild:${why}`); } catch {}
      } else {
        try { updateCounter(''); } catch {}
      }
      try { finalizeRebuildUi(why); } catch {}
      try {
        const chatId = resolveChatId();
        if (chatId) saveTurnCache(chatId, S.turnList);
      } catch {}
      clearRetry();
      try {
        const sh2 = TOPW.H2O_MM_SHARED?.get?.();
        if (sh2?.state) sh2.state.didEverBuildButtons = true;
      } catch {}
      try { W.H2O_MM_bindDelegatedHandlersOnce?.(); } catch {}
      emitAnswersScan(`core:${S.rebuildReason}`);

      out.status = 'ok';
      out.ok = true;
      out.reason = why;
      out.retry.scheduled = false;
      out.retry.count = 0;
      out.retry.kind = '';
      S.lastRebuildResult = out;
      return out;
    } catch (e) {
      safeDiag('err', 'core.rebuildNow', e);
      const failed = makeRebuildResult(why, 'error');
      failed.reason = 'error';
      failed.retry.scheduled = scheduleRetry('error', why);
      failed.retry.count = S.retryCount;
      failed.retry.kind = S.retryKind;
      S.lastRebuildResult = failed;
      return failed;
    } finally {
      S.rebuildInFlight = false;
      S.rebuildQueuedReason = '';
      perfReportDuration('rebuildNow', perfT0, scanTick0, {
        reason: why,
        status: String(S.lastRebuildResult?.status || out?.status || ''),
        turns: Number(S.lastRebuildResult?.built?.turns || out?.built?.turns || 0),
      });
    }
  }

  function clearEmptyRetry() {
    clearRetry();
    S.emptyRetryTimer = null;
    S.emptyRetryCount = 0;
  }

  function scheduleEmptyRetry(reason = 'core:empty') {
    scheduleRetry('turns-empty', reason);
  }

  function scheduleRebuild(reason = 'core:rebuild') {
    S.rebuildReason = String(reason || 'core:rebuild');
    perfMarkRebuildTrigger(S.rebuildReason);
    if (S.rebuildRaf || S.rebuildTimer) return true;
    const token = (S.rebuildToken += 1);
    const schedule = TOPW?.H2O?.runtime?.schedule || W?.H2O?.runtime?.schedule || null;
    if (schedule) {
      S.rebuildRaf = schedule.rafOnce('minimap:rebuild', () => { runScheduledRebuild(token); });
      S.rebuildTimer = schedule.timeoutOnce('minimap:rebuild:fallback', REBUILD_FALLBACK_MS, () => {
        runScheduledRebuild(token);
      });
      return true;
    }
    S.rebuildRaf = requestAnimationFrame(() => { runScheduledRebuild(token); });
    S.rebuildTimer = setTimeout(() => {
      runScheduledRebuild(token);
    }, REBUILD_FALLBACK_MS);
    return true;
  }

  function resnapshot(reason = 'core:resnapshot') {
    indexTurns();
    return S.turnList;
  }

  function refreshAnswers(reason = 'core:refreshAnswers') {
    return rebuildNow(reason);
  }

  function initCore() {
    if (S.inited) return true;
    S.inited = true;
    indexTurns();
    syncCurrentViewArtifacts(true);
    applyMiniMapPageUiPrefs();
    bindMarginSymbolsBridge();
    bindWashBridge();
    bindViewBridge();
    return true;
  }

  function disposeCore() {
    invalidateScheduledRebuild();
    clearEmptyRetry();
    S.rebuildInFlight = false;
    S.rebuildQueuedReason = '';
    if (S.gutterSyncRaf) {
      try { cancelAnimationFrame(S.gutterSyncRaf); } catch {}
      S.gutterSyncRaf = 0;
    }
    S.gutterSyncQueue.clear();
    if (S.washRepaintRaf) {
      try { cancelAnimationFrame(S.washRepaintRaf); } catch {}
      S.washRepaintRaf = 0;
    }
    S.washRepaintQueue.clear();
    S.washRepaintAll = false;
    S.lastActiveBtnEl = null;
    S.lastActiveTurnIdFast = '';
    S.lastActiveBtnId = '';
    if (S.dividerDrag) {
      try { window.removeEventListener('pointermove', S.dividerDrag.move, true); } catch {}
      try { window.removeEventListener('pointerup', S.dividerDrag.up, true); } catch {}
      try { window.removeEventListener('pointercancel', S.dividerDrag.up, true); } catch {}
      S.dividerDrag = null;
    }
    unbindMarginSymbolsBridge();
    unbindWashBridge();
    unbindViewBridge();
    S.inited = false;
    return true;
  }

  const CORE_PAGES_API = {
    getChatId: resolveChatId,
    getSections: buildChatPageSections,
    getRows: buildChatPageAnswerRows,
    findRowByAnswerId: findChatPageRowByAnswerId,
    renderDividers: renderChatPageDividers,
    scheduleRebuild,
    setMiniMapPageCollapsed,
    toggleMiniMapPageCollapsed,
    getDividerPageNum: getChatPageDividerPageNum,
  };

  const CORE_API = {
    ver: CORE_VER,
    pages: CORE_PAGES_API,
    initCore,
    disposeCore,
    scheduleRebuild,
    rebuildNow,
    refreshAnswers,
    resnapshot,
    getTurnIndex,
    getTurns,
    refreshTurnsCache,
    resolveBtnId,
    turnIdxForAnswerEl,
    findMiniBtn,
    getTurnList,
    getTurnById,
    getBtnById,
    ensureTurnButtons,
    loadTurnCache,
    clearTurnCache,
    saveTurnCache,
    getManualDividers: getMiniDividers,
    getManualDividerById: getMiniDividerById,
    getManualDividerByAfterTurn: getMiniDividerByAfterTurn,
    getSelectedManualDividerId: getSelectedMiniDividerId,
    selectManualDivider: selectMiniDivider,
    createManualDivider: createMiniDivider,
    upsertManualDivider: upsertMiniDivider,
    removeManualDividerById: removeMiniDividerById,
    removeManualDividerByAfterTurn: removeMiniDividerByAfterTurn,
    renderManualDividerOverlay: renderMiniDividerOverlay,
    getMiniDividers,
    getMiniDividerById,
    getMiniDividerByAfterTurn,
    getSelectedMiniDividerId,
    selectMiniDivider,
    createMiniDivider,
    upsertMiniDivider,
    removeMiniDividerById,
    removeMiniDividerByAfterTurn,
    renderMiniDividerOverlay,
    getMiniMapPageLabelStyle,
    setMiniMapPageLabelStyle,
    getMiniMapPageDividersEnabled,
    setMiniMapPageDividersEnabled,
    getChatPageDividersEnabled,
    setChatPageDividersEnabled,
    renderChatPageDividers,
    ensureChatPageDividerBridge,
    isChatPageCollapsed,
    setChatPageCollapsed,
    toggleChatPageCollapsed,
    getMiniMapCollapsedPages,
    isMiniMapPageCollapsed,
    setMiniMapPageCollapsed,
    toggleMiniMapPageCollapsed,
    applyMiniMapPageUiPrefs,
    renderFromCache,
    validateTurnsAgainstPagination,
    hydrateIndexFromDisk,
    renderFromIndex,
    appendTurnFromAnswerEl,
    attachVisibleAnswers,
    repaintMiniBtnByAnswerId,
    repaintAllMiniBtns,
    updateMiniMapGutterSymbol,
    syncMiniMapGutterForAnswer,
    scheduleMiniMapGutterSync,
    setActive,
    centerOn,
    centerOnPageDivider,
    updateCounter,
    updateToggleColor,
    syncActiveFromViewport,
    computeActiveFromViewport,
    applyTempFlash,
    flashAnswer,
    getAnswerList: () => S.answerEls.slice(),
    getBehavior,
    setBehavior,
    validateBehavior,
  };

  function installGlobalApi() {
    const resolveAnyId = (firstArg) => {
      if (typeof firstArg === 'string' || typeof firstArg === 'number') return String(firstArg);
      const ds = firstArg?.dataset || null;
      return String(
        ds?.id ||
        ds?.turnId ||
        ds?.primaryAId ||
        firstArg?.id ||
        firstArg?.turnId ||
        firstArg?.answerId ||
        firstArg?.activeTurnId ||
        ''
      ).trim();
    };
    const installAliasesOn = (T) => {
      if (!T) return;
      T.H2O_MM_getAnswersSafe = () => CORE_API.getAnswerList();
      T.getAnswers = () => CORE_API.getAnswerList();
      T.H2O_MM_getTurns = (...args) => CORE_API.getTurns?.(...args);
      T.H2O_MM_refreshTurnsCache = (...args) => CORE_API.refreshTurnsCache?.(...args);
      T.H2O_MM_resolveBtnId = (...args) => CORE_API.resolveBtnId?.(...args);
      T.H2O_MM_turnIdxForAnswerEl = (...args) => CORE_API.turnIdxForAnswerEl?.(...args);
      T.H2O_MM_findMiniBtn = (...args) => CORE_API.findMiniBtn?.(...args);
      T.H2O_MM_updateMiniMapGutterSymbol = (...args) => CORE_API.updateMiniMapGutterSymbol?.(...args);
      T.setActiveMiniMapButton = (...args) => {
        const id = resolveAnyId(args[0]);
        return id ? CORE_API.setActive(id, 'legacy-global') : false;
      };
      T.centerMiniMapOnId = (...args) => {
        const id = resolveAnyId(args[0]);
        const opts = (args[1] && typeof args[1] === 'object') ? args[1] : {};
        return id ? CORE_API.centerOn(id, opts) : false;
      };
      T.updateCounterToId = (id) => CORE_API.updateCounter(resolveAnyId(id));
      T.updateToggleColorById = (id) => CORE_API.updateToggleColor(resolveAnyId(id));
      T.updateActiveMiniMapBtn = (arg = {}) => {
        const opts = (arg && typeof arg === 'object' && !Array.isArray(arg)) ? arg : {};
        return CORE_API.syncActiveFromViewport(opts);
      };
      T.H2O_MM_repaintMiniBtnByAnswerId = (...args) => CORE_API.repaintMiniBtnByAnswerId(...args);
      T.H2O_MM_repaintAllMiniBtns = (...args) => CORE_API.repaintAllMiniBtns(...args);
      T.applyTempFlash = (...args) => CORE_API.applyTempFlash(...args);
      T.flashAnswer = (...args) => CORE_API.flashAnswer(...args);
      if (typeof T.updateMiniMapGutterSymbol !== 'function') {
        T.updateMiniMapGutterSymbol = (...args) => CORE_API.updateMiniMapGutterSymbol?.(...args);
      }
      if (typeof T.H2O_MM_coreRebuildNow !== 'function') {
        T.H2O_MM_coreRebuildNow = (...args) => CORE_API.rebuildNow(...args);
      }
      if (typeof T.H2O_MM_coreScheduleRebuild !== 'function') {
        T.H2O_MM_coreScheduleRebuild = (...args) => CORE_API.scheduleRebuild(...args);
      }
      if (typeof T.enhanceAll !== 'function') {
        T.enhanceAll = () => CORE_API.rebuildNow('main:shim');
      }
      if (typeof T.h2oEnhanceAll !== 'function') {
        T.h2oEnhanceAll = (..._args) => T.enhanceAll();
      }
      if (typeof T.h2oRebuildMiniMap !== 'function') {
        T.h2oRebuildMiniMap = (..._args) => T.enhanceAll();
      }
    };
    installAliasesOn(TOPW);
    if (W !== TOPW) installAliasesOn(W);
    try { TOPW.H2O_MM_CORE_PLUGIN = true; } catch {}
    try { TOPW.H2O_MM_CORE_VER = CORE_VER; } catch {}
    try { TOPW.H2O_MM_CORE_READY = true; } catch {}
    // Expose CORE_API directly so Engine's multi-fallback resolver can always
    // reach it even when the shared kernel bridge is temporarily unavailable.
    try { TOPW.H2O_MM_CORE_API = CORE_API; } catch {}
    if (W !== TOPW) { try { W.H2O_MM_CORE_API = CORE_API; } catch {} }
  }

  function installIntoKernelShared() {
    try {
      const root = TOPW.H2O_MM_SHARED;
      if (!root || typeof root !== 'object') return false;
      root.api = (root.api && typeof root.api === 'object') ? root.api : {};
      root.api.core = CORE_API;
      root.api.rt = root.api.rt || null;
      root.api.ui = root.api.ui || null;
      const vaultApi = TOPW?.H2O?.MM?.mnmp?.api;
      if (vaultApi && typeof vaultApi === 'object') {
        vaultApi.core = CORE_API;
        vaultApi.rt = vaultApi.rt || null;
        vaultApi.ui = vaultApi.ui || null;
      }
      return true;
    } catch {
      return false;
    }
  }

  function clearInstallTimer() {
    try { if (S.installTimer) clearTimeout(S.installTimer); } catch {}
    S.installTimer = null;
  }

  function scheduleInstallRetry() {
    clearInstallTimer();
    S.installTimer = setTimeout(() => {
      S.installTries += 1;
      const ok = installIntoKernelShared();
      if (ok) return;
      if (S.installTries >= MAX_TRIES) {
        warn('Kernel shared bridge not found; Core kept global-only.', { tries: S.installTries });
        return;
      }
      scheduleInstallRetry();
    }, GAP_MS);
  }

  installGlobalApi();
  initCore();
  if (!installIntoKernelShared()) scheduleInstallRetry();
})();
