// ==UserScript==
// @h2o-id             s1a1d.minimap.shell.studio
// @name               S1A1d. 🎬 MiniMap Shell - Studio
// @namespace          H2O.Premium.CGX.minimap.shell
// @author             HumamDev
// @version            12.7.0
// @revision           002
// @build              260304-102754
// @description        MiniMap Shell: UI owner bridge (Phase 2)
// @match              https://chatgpt.com/*
// @run-at             document-idle
// @grant              none

// ==/UserScript==

/* Smoke Test Checklist
 * - Main only -> UI works (fallback)
 * - Kernel+Main -> UI works (legacy)
 * - Kernel+Main+Shell -> UI works and only Shell owns UI
 * - Shell only -> warns+idle
 */

(() => {
  'use strict';

  const W = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;
  const TOPW = W.top || W;
  const H2O = (TOPW.H2O = TOPW.H2O || {});
  if (W !== TOPW) W.H2O = H2O;
  const STUDIO_SEL = W.H2O.Studio.SELECTORS;
  H2O.perf = H2O.perf || {};
  H2O.perf.modules = H2O.perf.modules || Object.create(null);
  const PERF_MODULE = (H2O.perf.modules.miniMapShell && typeof H2O.perf.modules.miniMapShell === 'object')
    ? H2O.perf.modules.miniMapShell
    : (H2O.perf.modules.miniMapShell = Object.create(null));
  const PERF = (() => {
    const existing = PERF_MODULE.__h2oPerfState;
    if (existing && typeof existing === 'object') return existing;
    const next = createMiniMapShellPerfState();
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
  ensureMiniMapShellPerfStateShape(PERF);
  PERF_MODULE.getStats = getMiniMapShellPerfStats;
  PERF_MODULE.resetStats = () => {
    resetMiniMapShellPerfState(PERF);
    return getMiniMapShellPerfStats();
  };

  // Kernel-authoritative bridge access (no fallbacks here; util.mm decides)
  const MM = () => (TOPW.H2O_MM_SHARED?.get?.() || null)?.util?.mm || null;
  const MM_core = () => MM()?.core?.() || null;
  const MM_ui = () => MM()?.ui?.() || null;
  const MM_rt = () => MM()?.rt?.() || null;
  const MM_behavior = () => (TOPW.H2O_MM_SHARED?.get?.() || null)?.util?.behavior || null;
  const MM_uiRefs = () => MM()?.uiRefs?.() || (MM_ui()?.getRefs?.() || {});

  const SHELL_VER = '12.7.0';
  const EV_SHELL_READY = 'evt:h2o:minimap:shell-ready';
  const EVT_SHELL_NO_BUTTONS = 'evt:h2o:minimap:shell:no-buttons';
  const EV_SKIN_READY = 'evt:h2o:minimap:skin-ready';
  const EV_ROUTE_CHANGED = 'evt:h2o:route:changed';
  const EV_QUICK_READY = 'evt:h2o:minimap:quick-ready';
  const EV_BEHAVIOR_CHANGED = 'evt:h2o:mm:behavior-changed';
  const EVT_MM_INDEX_HYDRATED = 'evt:h2o:minimap:index:hydrated';
  const EVT_MM_INDEX_APPENDED = 'evt:h2o:minimap:index:appended';
  const EVT_MM_VIEW_CHANGED = 'evt:h2o:minimap:view-changed';
  const KEY_COLLAPSED = 'h2o:prm:cgx:mnmp:ui:collapsed:v1';
  const KEY_COLLAPSED_LEGACY = 'ho:mm:collapsed';
  const KEY_COLLAPSED_CHAT_SUFFIX = 'ui:collapsed:chat';
  const KEY_MM_INDEX_CHAT_SUFFIX = 'state:mm_index:chat';
  const KEY_AXIS_OFFSET_SUFFIX = 'ui:axis-offset:v1';
  const KEY_CENTER_FIX_X_SUFFIX = 'ui:center-fix-x:v1';
  const KEY_BADGE_QUOTES_SUFFIX = 'ui:badgeVisibility:quotes:v1';
  const KEY_BADGE_REVS_SUFFIX = 'ui:badgeVisibility:revisions:v1';
  const KEY_BADGE_QWASH_SUFFIX = 'ui:badgeVisibility:qwash:v1';
  const KEY_DIAL_DOTS_VIS_SUFFIX = 'ui:dialPins:dots:v1';
  const KEY_DIAL_SYMBOLS_VIS_SUFFIX = 'ui:dialPins:symbols:v1';
  const KEY_DIAL_HEIGHT_STEP_SUFFIX = 'ui:dialHeightStep:v1';
  const KEY_DIAL_HEIGHT_DIR_SUFFIX = 'ui:dialHeightDir:v1';
  const KEY_BOOT_MODE_SUFFIX = 'ui:boot-mode:v1';
  const EV_BADGE_VISIBILITY = 'evt:h2o:minimap:badge-visibility';
  const DIAL_HEIGHT_STEP_MAX = 2;
  const DIAL_HEIGHT_STEP_DELTA_PX = 22;
  const DIAL_HEIGHT_STEP_DELTA_VH = 6;
  const BOOT_MODE_CACHE_FIRST = 'cache_first';
  const BOOT_MODE_REBUILD_FIRST = 'rebuild_first';
  const DEFAULT_COLLAPSED_ON_BOOT = true;
  const AXIS_BOOT_DEFAULT_X = -16;
  const AXIS_BOOT_DEFAULT_Y = 0;
  const FORCE_AXIS_DEFAULT_EACH_LOAD = true;
  const FORCE_CENTER_FIX_RESET_EACH_LOAD = true;
  const LOCK_MM_CENTER_FIX_TO_AXIS = true;
  const ROOT_CGX = 'mm-root';
  const ROOT_ID = 'cgx-mm-root';
  const PRELAYOUT_CLASS = 'cgxui-mm-prelayout';
  const VIEW_CHAT_PATH_RE = /^(?:\/c\/|\/g\/[^/]+\/c\/)/i;
  const VIEW_SEARCH_SEL = [
    '[role="dialog"] input[placeholder*="Search chats" i]',
    'input[placeholder*="Search chats" i]',
    '[role="dialog"] input[type="search"]',
  ].join(',');

  try {
    TOPW.H2O_MM_SHELL_PLUGIN = true;
    TOPW.H2O_MM_UI_SHELL_PLUGIN = true;
    TOPW.H2O_MM_SHELL_VER = SHELL_VER;
    TOPW.H2O_MM_UI_SHELL_VER = SHELL_VER;
    if (typeof TOPW.H2O_MM_SHELL_READY !== 'boolean') TOPW.H2O_MM_SHELL_READY = false;
    if (typeof TOPW.H2O_MM_UI_SHELL_READY !== 'boolean') TOPW.H2O_MM_UI_SHELL_READY = false;
  } catch {}

  const ATTR = Object.freeze({
    CGXUI_OWNER: 'data-cgxui-owner',
    CGXUI: 'data-cgxui',
    CGXUI_STATE: 'data-cgxui-state',
  });

  const UI = Object.freeze({
    ROOT: 'mnmp-root',
    MINIMAP: 'mnmp-minimap',
    // Top control: toggle button
    TOGGLE: 'mnmp-toggle',
    ACCESS: 'mnmp-access',
    // Bottom control: dial button (legacy alias: AUX)
    DIAL: 'mnmp-aux',
    AUX: 'mnmp-aux',
  });

  const SEL = Object.freeze({
    ROOT: `[${ATTR.CGXUI}="${UI.ROOT}"][${ATTR.CGXUI_OWNER}="mnmp"]`,
    PANEL: `[${ATTR.CGXUI}="${UI.MINIMAP}"][${ATTR.CGXUI_OWNER}="mnmp"]`,
    TOGGLE: `[${ATTR.CGXUI}="${UI.TOGGLE}"][${ATTR.CGXUI_OWNER}="mnmp"]`,
    DIAL: `[${ATTR.CGXUI}="${UI.DIAL}"][${ATTR.CGXUI_OWNER}="mnmp"]`,
    AUX: `[${ATTR.CGXUI}="${UI.DIAL}"][${ATTR.CGXUI_OWNER}="mnmp"]`, // compatibility alias
    STYLE: '#cgxui-mnmp-style',
  });

  const SkID = 'mnmp';
  const ATTR_ = Object.freeze({
    CGXUI_OWNER: 'data-cgxui-owner',
    CGXUI: 'data-cgxui',
    CGXUI_STATE: 'data-cgxui-state',
    CGXUI_VIEW: 'data-cgxui-view',
    CGXUI_INVIEW: 'data-cgxui-inview',
    CGXUI_FLASH: 'data-cgxui-flash',
    CGXUI_WASH: 'data-cgxui-wash',
    CGXUI_WASH_LEGACY_HL: 'data-cgxui-hl',
    MSG_ROLE: 'data-message-author-role',
  });

  const UI_ = Object.freeze({
    ROOT: `${SkID}-root`,
    MINIMAP: `${SkID}-minimap`,
    COL: `${SkID}-col`,
    // Top control
    TOGGLE: `${SkID}-toggle`,
    // Bottom control (legacy alias: AUX)
    DIAL: `${SkID}-aux`,
    AUX: `${SkID}-aux`,
    WRAP: `${SkID}-wrap`,
    BTN: `${SkID}-btn`,
    DOTROW: `${SkID}-dotrow`,
    COUNT: `${SkID}-count`,
    PINROW: `${SkID}-pinrow`,
    PIN_QUOTE: `${SkID}-pin-quote`,
    PIN_QWASH: `${SkID}-pin-qwash`,
    PIN_REV: `${SkID}-pin-rev`,
    DIAL_PINROW: `${SkID}-dial-pinrow`,
    DIAL_PIN_DOTS: `${SkID}-dial-pin-dots`,
    DIAL_PIN_TITLES: `${SkID}-dial-pin-titles`,
    DIAL_PIN_SYMBOLS: `${SkID}-dial-pin-symbols`,
    COUNTER: `${SkID}-counter`,
    DIAL_UP: `${SkID}-dial-up`,
    DIAL_DOWN: `${SkID}-dial-down`,
    AUX_UP: `${SkID}-dial-up`,
    AUX_DOWN: `${SkID}-dial-down`,
  });

  const CLS_ = Object.freeze({
    ROOT: `cgxui-${SkID}-root`,
    MINIMAP: `cgxui-${SkID}-minimap`,
    COL: `cgxui-${SkID}-col`,
    TOGGLE: `cgxui-${SkID}-toggle`,
    DIAL: `cgxui-${SkID}-aux`,
    AUX: `cgxui-${SkID}-aux`,
    COUNT: `cgxui-${SkID}-count`,
    COUNTER: `cgxui-${SkID}-counter`,
    WASH_WRAP: `cgxui-${SkID}-wash-wrap`,
    WASH_PREFIX: `cgxui-${SkID}-wash-`,
    FLASH: `cgxui-${SkID}-flash`,
  });

  const state = {
    retries: 0,
    mounting: false,
    booted: false,
    bootHoldMO: null,
    bootHoldTimer: null,
    alignMO: null,
    alignRaf: 0,
    alignResizeBound: false,
    bootCollapseApplied: false,
    bootCollapseSig: '',
    routeSig: '',
    routeRaf: 0,
    routeAttachTimer: null,
    routeAttachToken: 0,
    routeBound: false,
    routeReason: '',
    viewSig: '',
    viewRaf: 0,
    viewMO: null,
    noButtonsRebuildAt: 0,
    prelayoutSig: '',
    prelayoutDone: false,
    prelayoutRaf1: 0,
    prelayoutRaf2: 0,
    prelayoutFailsafeTimer: null,
    prelayoutLastBtnCount: -1,
    prelayoutStableTicks: 0,
    prelayoutStartedAt: 0,
    quickReady: !!TOPW.H2O_MM_QUICK_READY,
    behaviorHooked: false,
    skinRecoveryAt: 0,
    skinRecoveryWarned: false,
    off: [],
    badgeVisibility: {
      loaded: false,
      quotes: true,
      qwash: true,
      revisions: true,
    },
    dialVisibility: {
      loaded: false,
      dots: true,
      symbols: true,
    },
    dialHeight: {
      loaded: false,
      step: 0,
      dir: 1,
      basePx: null,
      baseVh: null,
    },
  };

  const PERF_SCOPE = {
    ensureShellDepth: 0,
    refreshShellDepth: 0,
    shellEventDepth: 0,
  };

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

  function createMiniMapShellPerfState() {
    return {
      bootCompletedAt: 0,
      ensureShell: createSummaryBucket(),
      refreshShell: createSummaryBucket(),
      shellState: {
        reuseCount: 0,
        createCount: 0,
        rebuildCount: 0,
        noOpCount: 0,
        panelCreated: 0,
        colCreated: 0,
        toggleCreated: 0,
        dialCreated: 0,
        toggleReparented: 0,
        dialReparented: 0,
        shellMissingOrDetached: 0,
        skinEnsureCalls: 0,
        skinStyleInserted: 0,
        skinStyleReused: 0,
        lastShellState: '',
        lastReason: '',
        lastAt: 0,
      },
      noButtonsHandling: {
        callCount: 0,
        eventDispatchCount: 0,
        throttledCount: 0,
        skippedNoShellCount: 0,
        skippedNoButtonsCount: 0,
        lastReason: '',
        lastAt: 0,
      },
      shellEvents: {
        enabled: true,
        total: createSummaryBucket(),
        surfaces: Object.create(null),
        gestures: Object.create(null),
        actions: Object.create(null),
        lastType: '',
        lastAction: '',
        lastAt: 0,
      },
      paths: {
        ensureSkinHealthy: createDurationBucket(),
        skinEnsureStyle: createDurationBucket(),
        applyViewMode: createDurationBucket(),
        applyViewVisibility: createDurationBucket(),
        runPrelayoutAlign: createDurationBucket(),
        requestNoButtonsRebuild: createDurationBucket(),
        syncRouteState: createDurationBucket(),
        ensureUI: createDurationBucket(),
        mountUI: createDurationBucket(),
        unmountUI: createDurationBucket(),
        runShellBinding: createDurationBucket(),
        togglePinClick: createDurationBucket(),
        dialPinClick: createDurationBucket(),
        dialTitleClick: createDurationBucket(),
        dialTitleDblclick: createDurationBucket(),
      },
    };
  }

  function ensureMiniMapShellPerfStateShape(target) {
    if (!target || typeof target !== 'object') return target;
    if (!target.ensureShell || typeof target.ensureShell !== 'object') target.ensureShell = createSummaryBucket();
    if (!target.refreshShell || typeof target.refreshShell !== 'object') target.refreshShell = createSummaryBucket();
    if (!target.shellState || typeof target.shellState !== 'object') target.shellState = createMiniMapShellPerfState().shellState;
    if (!target.noButtonsHandling || typeof target.noButtonsHandling !== 'object') target.noButtonsHandling = createMiniMapShellPerfState().noButtonsHandling;
    if (!target.paths || typeof target.paths !== 'object') {
      target.paths = createMiniMapShellPerfState().paths;
    }
    if (!target.shellEvents || typeof target.shellEvents !== 'object') {
      target.shellEvents = createMiniMapShellPerfState().shellEvents;
    }
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

  function noteShellState(key, reason = '') {
    if (key) PERF.shellState[key] = Number(PERF.shellState[key] || 0) + 1;
    PERF.shellState.lastShellState = String(key || '');
    PERF.shellState.lastReason = String(reason || '');
    PERF.shellState.lastAt = Date.now();
  }

  function enterShellOwner(kind) {
    if (kind === 'ensureShell') {
      const owned = PERF_SCOPE.ensureShellDepth === 0;
      PERF_SCOPE.ensureShellDepth += 1;
      return owned;
    }
    if (kind === 'refreshShell') {
      const owned = PERF_SCOPE.ensureShellDepth === 0 && PERF_SCOPE.refreshShellDepth === 0;
      PERF_SCOPE.refreshShellDepth += 1;
      return owned;
    }
    if (kind === 'shellEvent') {
      const owned = PERF_SCOPE.shellEventDepth === 0;
      PERF_SCOPE.shellEventDepth += 1;
      return owned;
    }
    return false;
  }

  function exitShellOwner(kind) {
    if (kind === 'ensureShell') PERF_SCOPE.ensureShellDepth = Math.max(0, PERF_SCOPE.ensureShellDepth - 1);
    else if (kind === 'refreshShell') PERF_SCOPE.refreshShellDepth = Math.max(0, PERF_SCOPE.refreshShellDepth - 1);
    else if (kind === 'shellEvent') PERF_SCOPE.shellEventDepth = Math.max(0, PERF_SCOPE.shellEventDepth - 1);
  }

  function resetMiniMapShellPerfState(target) {
    if (!target) return target;
    const bootCompletedAt = Number(target.bootCompletedAt || 0) > 0 ? Number(target.bootCompletedAt || 0) : 0;
    const next = createMiniMapShellPerfState();
    next.bootCompletedAt = bootCompletedAt;
    Object.keys(next).forEach((key) => { target[key] = next[key]; });
    return target;
  }

  function getMiniMapShellPerfStats() {
    ensureMiniMapShellPerfStateShape(PERF);
    const paths = Object.create(null);
    for (const key of Object.keys(PERF.paths || {})) paths[key] = readDurationBucket(PERF.paths[key]);
    return {
      bootCompletedAt: Number(PERF.bootCompletedAt || 0),
      ensureShell: readSummaryBucket(PERF.ensureShell),
      refreshShell: readSummaryBucket(PERF.refreshShell),
      shellState: {
        reuseCount: Number(PERF.shellState?.reuseCount || 0),
        createCount: Number(PERF.shellState?.createCount || 0),
        rebuildCount: Number(PERF.shellState?.rebuildCount || 0),
        noOpCount: Number(PERF.shellState?.noOpCount || 0),
        panelCreated: Number(PERF.shellState?.panelCreated || 0),
        colCreated: Number(PERF.shellState?.colCreated || 0),
        toggleCreated: Number(PERF.shellState?.toggleCreated || 0),
        dialCreated: Number(PERF.shellState?.dialCreated || 0),
        toggleReparented: Number(PERF.shellState?.toggleReparented || 0),
        dialReparented: Number(PERF.shellState?.dialReparented || 0),
        shellMissingOrDetached: Number(PERF.shellState?.shellMissingOrDetached || 0),
        skinEnsureCalls: Number(PERF.shellState?.skinEnsureCalls || 0),
        skinStyleInserted: Number(PERF.shellState?.skinStyleInserted || 0),
        skinStyleReused: Number(PERF.shellState?.skinStyleReused || 0),
        lastShellState: String(PERF.shellState?.lastShellState || ''),
        lastReason: String(PERF.shellState?.lastReason || ''),
        lastAt: Number(PERF.shellState?.lastAt || 0),
      },
      noButtonsHandling: {
        callCount: Number(PERF.noButtonsHandling?.callCount || 0),
        eventDispatchCount: Number(PERF.noButtonsHandling?.eventDispatchCount || 0),
        throttledCount: Number(PERF.noButtonsHandling?.throttledCount || 0),
        skippedNoShellCount: Number(PERF.noButtonsHandling?.skippedNoShellCount || 0),
        skippedNoButtonsCount: Number(PERF.noButtonsHandling?.skippedNoButtonsCount || 0),
        lastReason: String(PERF.noButtonsHandling?.lastReason || ''),
        lastAt: Number(PERF.noButtonsHandling?.lastAt || 0),
      },
      shellEvents: {
        enabled: PERF.shellEvents?.enabled !== false,
        total: readSummaryBucket(PERF.shellEvents?.total),
        surfaces: copyPlainCounts(PERF.shellEvents?.surfaces),
        gestures: copyPlainCounts(PERF.shellEvents?.gestures),
        actions: copyPlainCounts(PERF.shellEvents?.actions),
        lastType: String(PERF.shellEvents?.lastType || ''),
        lastAction: String(PERF.shellEvents?.lastAction || ''),
        lastAt: Number(PERF.shellEvents?.lastAt || 0),
      },
      paths,
    };
  }

  function log(...args) { try { console.log('[MiniMap Shell]', ...args); } catch {} }
  function warn(...args) { try { console.warn('[MiniMap Shell]', ...args); } catch {} }

  function installIndexDebugListenerOnce() {
    const key = '__H2O_MM_INDEX_DEBUG_LISTENER__';
    try { if (window[key]) return false; } catch {}
    let enabled = false;
    try { enabled = String(localStorage.getItem('h2o:mm:indexDebug') || '') === '1'; } catch {}
    if (!enabled) return false;
    try {
      window.addEventListener(EVT_MM_INDEX_HYDRATED, () => {
        try { console.count('mm hydrated'); } catch {}
      }, true);
      try { window[key] = true; } catch {}
      return true;
    } catch {
      return false;
    }
  }

  function getSharedRefs() {
    try { return TOPW.H2O_MM_SHARED?.get?.() || null; } catch { return null; }
  }

  const skinWarnState = Object.seal({ ensureMissing: false, unmountMissing: false });

  function skinApi() {
    const refs = TOPW.H2O_MM_SHARED?.get?.() || null;
    return refs?.api?.skin || refs?.vault?.api?.skin || W?.H2O?.MM?.mnmp?.api?.skin || null;
  }

  function skinStyleHealthy() {
    const styleEl = document.querySelector(SEL.STYLE);
    if (!styleEl) return false;
    const owner = String(styleEl.getAttribute('data-h2o-mm-skin') || '').trim();
    return owner === SkID;
  }

  function skinApiReady() {
    const api = skinApi();
    return !!(api && typeof api.ensureStyle === 'function');
  }

  function skinReadyFlag() {
    try { return !!TOPW.H2O_MM_SKIN_READY; } catch {}
    return false;
  }

  function shellDepsReady() {
    if (!(skinApiReady() || skinReadyFlag())) return false;
    if (skinStyleHealthy()) return true;
    const api = skinApi();
    if (api && typeof api.ensureStyle === 'function') {
      try { api.ensureStyle('shell:deps-ready'); } catch {}
    }
    return skinStyleHealthy();
  }


  function skinEnsureStyle(reason = '') {
    const perfOwned = enterShellOwner('refreshShell');
    const perfT0 = perfNow();
    const beforeHealthy = skinStyleHealthy();
    noteShellState('skinEnsureCalls', reason || 'skinEnsureStyle');
    try {
      const api = skinApi();
      if (api && typeof api.ensureStyle === 'function') {
        try { return api.ensureStyle(reason); } catch {}
      }
      if (!skinWarnState.ensureMissing) {
        skinWarnState.ensureMissing = true;
        warn('MiniMap Skin API missing ensureStyle; UI continues unstyled.');
      }
      return null;
    } finally {
      const afterHealthy = skinStyleHealthy();
      if (afterHealthy && !beforeHealthy) noteShellState('skinStyleInserted', reason || 'skinEnsureStyle');
      else if (afterHealthy) noteShellState('skinStyleReused', reason || 'skinEnsureStyle');
      const ms = perfNow() - perfT0;
      recordDuration(PERF.paths.skinEnsureStyle, ms);
      if (perfOwned) {
        recordDuration(PERF.refreshShell, ms);
        noteSummaryBucket(PERF.refreshShell, reason || 'skinEnsureStyle');
      }
      exitShellOwner('refreshShell');
    }
  }

  function ensureSkinHealthy(reason = 'ensure-ui') {
    const perfOwned = enterShellOwner('refreshShell');
    const perfT0 = perfNow();
    try {
      if (skinStyleHealthy()) {
        state.skinRecoveryWarned = false;
        return true;
      }
      const now = Date.now();
      if ((now - Number(state.skinRecoveryAt || 0)) >= 1000) {
        state.skinRecoveryAt = now;
        try { skinEnsureStyle(reason || 'ensure-ui'); } catch {}
      }
      const healthy = skinStyleHealthy();
      if (healthy) {
        state.skinRecoveryWarned = false;
        return true;
      }
      if (!state.skinRecoveryWarned) {
        state.skinRecoveryWarned = true;
        warn('MiniMap Skin style missing/unowned; attempted recovery.', { reason: String(reason || 'ensure-ui') });
      }
      return false;
    } finally {
      const ms = perfNow() - perfT0;
      recordDuration(PERF.paths.ensureSkinHealthy, ms);
      if (perfOwned) {
        recordDuration(PERF.refreshShell, ms);
        noteSummaryBucket(PERF.refreshShell, reason || 'ensureSkinHealthy');
      }
      exitShellOwner('refreshShell');
    }
  }

  function skinUnmountStyle(reason = '') {
    const api = skinApi();
    if (api && typeof api.unmountStyle === 'function') {
      try { return !!api.unmountStyle(reason); } catch {}
    }
    if (!skinWarnState.unmountMissing) {
      skinWarnState.unmountMissing = true;
      warn('MiniMap Skin API missing unmountStyle; skipping style cleanup.');
    }
    return false;
  }

  function viewsApi() {
    const refs = getSharedRefs();
    const viaStable = refs?.api?.views;
    if (viaStable && typeof viaStable === 'object') return viaStable;
    try {
      const viaRoot = TOPW.H2O_MM_SHARED?.api?.views;
      if (viaRoot && typeof viaRoot === 'object') return viaRoot;
    } catch {}
    try {
      const viaLegacy = W?.H2O?.MM?.mnmp?.api?.views;
      if (viaLegacy && typeof viaLegacy === 'object') return viaLegacy;
    } catch {}
    return null;
  }

  function getViewMode() {
    const api = viewsApi();
    if (api && typeof api.getMode === 'function') {
      try {
        const mode = String(api.getMode() || '').trim();
        return mode || 'classic';
      } catch {}
    }
    return 'classic';
  }

  function setViewMode(mode, opts = {}) {
    const api = viewsApi();
    if (api && typeof api.setMode === 'function') {
      try {
        const next = String(api.setMode(mode, opts) || '').trim();
        return next || 'classic';
      } catch {}
    }
    return 'classic';
  }

  function applyViewMode(refs = getRefs()) {
    const perfOwned = enterShellOwner('refreshShell');
    const perfT0 = perfNow();
    try {
      const panel = refs?.panel || null;
      const mode = getViewMode();
      if (!panel) return mode;
      try { panel.setAttribute(ATTR_.CGXUI_VIEW, mode); } catch {}
      return mode;
    } finally {
      const ms = perfNow() - perfT0;
      recordDuration(PERF.paths.applyViewMode, ms);
      if (perfOwned) {
        recordDuration(PERF.refreshShell, ms);
        noteSummaryBucket(PERF.refreshShell, 'applyViewMode');
      }
      exitShellOwner('refreshShell');
    }
  }

  function getRefs() {
    const root = document.querySelector(SEL.ROOT);
    const panel = document.querySelector(SEL.PANEL);
    const toggle = document.querySelector(SEL.TOGGLE);
    const dial = document.querySelector(SEL.DIAL);
    const col = panel?.querySelector?.(`[${ATTR.CGXUI}="${UI_.COL}"][${ATTR.CGXUI_OWNER}="${SkID}"]`) || null;
    const counter = document.querySelector(`[${ATTR.CGXUI}="${UI_.COUNTER}"][${ATTR.CGXUI_OWNER}="${SkID}"]`) || null;
    const count = toggle?.querySelector?.(`[${ATTR.CGXUI}="${UI_.COUNT}"][${ATTR.CGXUI_OWNER}="${SkID}"]`) || null;
    const pinQuote = toggle?.querySelector?.(`[${ATTR.CGXUI}="${UI_.PIN_QUOTE}"][${ATTR.CGXUI_OWNER}="${SkID}"]`) || null;
    const pinQwash = toggle?.querySelector?.(`[${ATTR.CGXUI}="${UI_.PIN_QWASH}"][${ATTR.CGXUI_OWNER}="${SkID}"]`) || null;
    const pinRev = toggle?.querySelector?.(`[${ATTR.CGXUI}="${UI_.PIN_REV}"][${ATTR.CGXUI_OWNER}="${SkID}"]`) || null;
    const dialPinDots = dial?.querySelector?.(`[${ATTR.CGXUI}="${UI_.DIAL_PIN_DOTS}"][${ATTR.CGXUI_OWNER}="${SkID}"]`) || null;
    const dialPinTitles = dial?.querySelector?.(`[${ATTR.CGXUI}="${UI_.DIAL_PIN_TITLES}"][${ATTR.CGXUI_OWNER}="${SkID}"]`) || null;
    const dialPinSymbols = dial?.querySelector?.(`[${ATTR.CGXUI}="${UI_.DIAL_PIN_SYMBOLS}"][${ATTR.CGXUI_OWNER}="${SkID}"]`) || null;
    // Keep a stable refs shape for all dependents.
    const scroller = col || panel || null;
    const list = col || null;
    return {
      root,
      panel,
      toggle,
      dial,
      aux: dial,
      col,
      counter,
      count,
      pinQuote,
      pinQwash,
      pinRev,
      dialPinDots,
      dialPinTitles,
      dialPinSymbols,
      scroller,
      list
    };
  }

  function viewIsChatPath() {
    return VIEW_CHAT_PATH_RE.test(String(location.pathname || '').trim());
  }

  function viewIsVisibleNode(el) {
    if (!el || !el.isConnected) return false;
    try {
      const cs = W.getComputedStyle?.(el);
      if (cs) {
        if (cs.display === 'none') return false;
        if (cs.visibility === 'hidden') return false;
        const op = Number.parseFloat(cs.opacity || '1');
        if (Number.isFinite(op) && op <= 0.02) return false;
      }
      const r = el.getBoundingClientRect?.();
      return !!(r && r.width > 0 && r.height > 0);
    } catch {
      return false;
    }
  }

  function viewIsSearchPanelOpen() {
    let list = [];
    try { list = Array.from(document.querySelectorAll(VIEW_SEARCH_SEL)); } catch { list = []; }
    if (!list.length) return false;
    for (const el of list) {
      if (!viewIsVisibleNode(el)) continue;
      const ph = String(el.getAttribute?.('placeholder') || '').toLowerCase();
      if (ph.includes('search chats')) return true;
      if (el.closest?.('[role="dialog"]')) return true;
    }
    return false;
  }

  function viewShouldShowControls() {
    return viewIsChatPath() && !viewIsSearchPanelOpen();
  }

  function viewSetDisplay(el, show) {
    if (!el) return;
    try {
      if (show) el.style.removeProperty('display');
      else el.style.setProperty('display', 'none', 'important');
    } catch {}
  }

  function applyViewVisibility(refs = getRefs(), reason = 'view') {
    const perfOwned = enterShellOwner('refreshShell');
    const perfT0 = perfNow();
    try {
      const show = viewShouldShowControls();
      const sig = `${show ? 1 : 0}|${String(location.pathname || '')}|${viewIsSearchPanelOpen() ? 1 : 0}`;
      if (sig === state.viewSig) return show;
      state.viewSig = sig;
      viewSetDisplay(refs?.root, show);
      viewSetDisplay(refs?.toggle, show);
      viewSetDisplay(refs?.panel, show);
      viewSetDisplay(refs?.dial, show);
      if (!show) {
        try { stateSet(refs?.panel, 'collapsed', true); } catch {}
        try { stateSet(refs?.dial, 'collapsed', true); } catch {}
        try { stateSet(refs?.toggle, 'faded', true); } catch {}
      } else {
        applyBootCollapsedDefault(`view:${String(reason || 'view')}`);
      }
      ensureToggleAccess(refs);
      return show;
    } finally {
      const ms = perfNow() - perfT0;
      recordDuration(PERF.paths.applyViewVisibility, ms);
      if (perfOwned) {
        recordDuration(PERF.refreshShell, ms);
        noteSummaryBucket(PERF.refreshShell, reason || 'applyViewVisibility');
      }
      exitShellOwner('refreshShell');
    }
  }

  function scheduleViewVisibility(reason = 'view') {
    if (state.viewRaf) return;
    state.viewRaf = requestAnimationFrame(() => {
      state.viewRaf = 0;
      applyViewVisibility(getRefs(), reason);
    });
  }

  function clearViewObserver() {
    try { state.viewMO?.disconnect?.(); } catch {}
    state.viewMO = null;
    if (state.viewRaf) {
      try { cancelAnimationFrame(state.viewRaf); } catch {}
      state.viewRaf = 0;
    }
    state.viewSig = '';
  }

  function ensureViewObserver() {
    if (state.viewMO || !document.documentElement) return;
    state.viewMO = new MutationObserver(() => scheduleViewVisibility('dom'));
    try {
      state.viewMO.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['class', 'style', 'hidden', 'open', 'aria-hidden'],
      });
    } catch {}
  }

  function stateHas(el, tok) {
    if (!el) return false;
    const cur = String(el.getAttribute(ATTR.CGXUI_STATE) || '').trim();
    if (!cur) return false;
    return cur.split(/\s+/).includes(String(tok));
  }

  function stateSet(el, tok, on) {
    if (!el) return;
    const cur = String(el.getAttribute(ATTR.CGXUI_STATE) || '').trim();
    const set = new Set(cur ? cur.split(/\s+/).filter(Boolean) : []);
    const key = String(tok);
    if (on) set.add(key); else set.delete(key);
    if (set.size) el.setAttribute(ATTR.CGXUI_STATE, Array.from(set).join(' '));
    else el.removeAttribute(ATTR.CGXUI_STATE);
  }

  function resolveChatId() {
    const fromCore = String(W?.H2O?.util?.getChatId?.() || '').trim();
    if (fromCore) return fromCore;
    const m = String(location.pathname || '').match(/\/(?:c|chat)\/([a-z0-9-]+)/i);
    return m ? String(m[1] || '').trim() : '';
  }

  function safeChatKeyPart(chatId = '') {
    return String(chatId || '').trim().replace(/[^a-z0-9_-]/gi, '_');
  }

  function keyCollapsedChat(chatId = '') {
    const safeId = safeChatKeyPart(chatId || resolveChatId());
    if (!safeId) return '';
    return `${nsDisk()}:${KEY_COLLAPSED_CHAT_SUFFIX}:${safeId}:v1`;
  }

  function keyMmIndexChat(chatId = '') {
    const safeId = safeChatKeyPart(chatId || resolveChatId());
    if (!safeId) return '';
    return `${nsDisk()}:${KEY_MM_INDEX_CHAT_SUFFIX}:${safeId}:v1`;
  }

  function readStoredRaw(key) {
    const k = String(key || '').trim();
    if (!k) return null;
    const storage = storageApi();
    if (storage && typeof storage.getStr === 'function') {
      return storage.getStr(k, null);
    }
    try { return localStorage.getItem(k); } catch { return null; }
  }

  function writeStoredRaw(key, val) {
    const k = String(key || '').trim();
    if (!k) return false;
    const v = String(val ?? '');
    const storage = storageApi();
    if (storage && typeof storage.setStr === 'function') {
      return !!storage.setStr(k, v);
    }
    try {
      localStorage.setItem(k, v);
      return true;
    } catch {
      return false;
    }
  }

  function resolveCollapsedStored(chatId = '') {
    const byChatKey = keyCollapsedChat(chatId);
    if (byChatKey) {
      const chatRaw = readStoredRaw(byChatKey);
      if (chatRaw != null) {
        return { collapsed: parseStoredBool(chatRaw, DEFAULT_COLLAPSED_ON_BOOT), source: 'chat', key: byChatKey };
      }
    }
    const globalRaw = readStoredRaw(KEY_COLLAPSED);
    if (globalRaw != null) {
      return { collapsed: parseStoredBool(globalRaw, DEFAULT_COLLAPSED_ON_BOOT), source: 'global', key: KEY_COLLAPSED };
    }
    const legacyRaw = readStoredRaw(KEY_COLLAPSED_LEGACY);
    if (legacyRaw != null) {
      return { collapsed: parseStoredBool(legacyRaw, DEFAULT_COLLAPSED_ON_BOOT), source: 'legacy', key: KEY_COLLAPSED_LEGACY };
    }
    return { collapsed: !!DEFAULT_COLLAPSED_ON_BOOT, source: 'default', key: '' };
  }

  function getCollapsed(chatId = '') {
    return !!resolveCollapsedStored(chatId).collapsed;
  }

  function setCollapsed(on, opts = {}) {
    const collapsed = !!on;
    const refs = getRefs();
    stateSet(refs.panel, 'collapsed', collapsed);
    stateSet(refs.dial, 'collapsed', collapsed);
    stateSet(refs.toggle, 'faded', collapsed);
    ensureToggleAccess(refs);

    const persist = opts?.persist !== false;
    if (!persist) return collapsed;

    const chatId = String(opts?.chatId || resolveChatId()).trim();
    const chatKey = keyCollapsedChat(chatId);
    const writeGlobal = opts?.writeGlobal === true;
    const val = collapsed ? '1' : '0';

    if (chatKey) writeStoredRaw(chatKey, val);
    if (writeGlobal) writeStoredRaw(KEY_COLLAPSED, val);
    return collapsed;
  }

  function collapsedSig(chatId = '') {
    const id = String(chatId || resolveChatId()).trim() || '__global__';
    return `${id}|${location.pathname}|${location.search}`;
  }

  function applyBootCollapsedDefault(reason = 'boot') {
    const chatId = resolveChatId();
    const sig = collapsedSig(chatId);
    if (state.bootCollapseApplied && state.bootCollapseSig === sig) return getCollapsed(chatId);
    state.bootCollapseApplied = true;
    state.bootCollapseSig = sig;
    const desired = getCollapsed(chatId);
    return setCollapsed(desired, { persist: false, writeGlobal: false, chatId, reason });
  }

  function storageApi() {
    try { return getSharedRefs()?.util?.storage || null; } catch { return null; }
  }

  function nsDisk() {
    const sh = getSharedRefs();
    try {
      const ns = sh?.util?.ns;
      if (ns && typeof ns.disk === 'function') return ns.disk('prm', 'cgx', 'mnmp');
    } catch {}
    return String(sh?.NS_DISK || 'h2o:prm:cgx:mnmp');
  }

  function keyBadgeQuotes() {
    return `${nsDisk()}:${KEY_BADGE_QUOTES_SUFFIX}`;
  }

  function keyBadgeRevs() {
    return `${nsDisk()}:${KEY_BADGE_REVS_SUFFIX}`;
  }

  function keyBadgeQwash() {
    return `${nsDisk()}:${KEY_BADGE_QWASH_SUFFIX}`;
  }

  function keyDialDotsVisibility() {
    return `${nsDisk()}:${KEY_DIAL_DOTS_VIS_SUFFIX}`;
  }

  function keyDialSymbolsVisibility() {
    return `${nsDisk()}:${KEY_DIAL_SYMBOLS_VIS_SUFFIX}`;
  }

  function keyDialHeightStep() {
    return `${nsDisk()}:${KEY_DIAL_HEIGHT_STEP_SUFFIX}`;
  }

  function keyDialHeightDir() {
    return `${nsDisk()}:${KEY_DIAL_HEIGHT_DIR_SUFFIX}`;
  }

  function keyAxisOffset() {
    return `${nsDisk()}:${KEY_AXIS_OFFSET_SUFFIX}`;
  }

  function keyCenterFixX() {
    return `${nsDisk()}:${KEY_CENTER_FIX_X_SUFFIX}`;
  }

  function keyBootMode() {
    return `${nsDisk()}:${KEY_BOOT_MODE_SUFFIX}`;
  }

  function parseStoredBool(raw, fallback = true) {
    if (raw == null) return !!fallback;
    const s = String(raw).trim().toLowerCase();
    if (s === '1' || s === 'true') return true;
    if (s === '0' || s === 'false') return false;
    return !!fallback;
  }

  function parseStoredInt(raw, fallback = 0, min = 0, max = 2) {
    const n = Number.parseInt(String(raw ?? ''), 10);
    if (!Number.isFinite(n)) return fallback;
    if (n < min) return min;
    if (n > max) return max;
    return n;
  }

  function normalizeBootMode(raw) {
    const mode = String(raw || '').trim().toLowerCase();
    if (mode === BOOT_MODE_CACHE_FIRST) return BOOT_MODE_CACHE_FIRST;
    if (mode === BOOT_MODE_REBUILD_FIRST) return BOOT_MODE_REBUILD_FIRST;
    return BOOT_MODE_REBUILD_FIRST;
  }

  function getBootMode() {
    return normalizeBootMode(readStoredRaw(keyBootMode()));
  }

  function setBootMode(mode) {
    const next = normalizeBootMode(mode);
    writeStoredRaw(keyBootMode(), next);
    return next;
  }

  function readStoredBool(key, fallback = true) {
    const storage = storageApi();
    if (storage && typeof storage.getStr === 'function') {
      return parseStoredBool(storage.getStr(key, null), fallback);
    }
    try { return parseStoredBool(localStorage.getItem(key), fallback); } catch { return !!fallback; }
  }

  function writeStoredBool(key, on) {
    const val = on ? '1' : '0';
    const storage = storageApi();
    if (storage && typeof storage.setStr === 'function') {
      storage.setStr(key, val);
      return;
    }
    try { localStorage.setItem(key, val); } catch {}
  }

  function readStoredInt(key, fallback = 0, min = 0, max = 2) {
    const storage = storageApi();
    if (storage && typeof storage.getStr === 'function') {
      return parseStoredInt(storage.getStr(key, null), fallback, min, max);
    }
    try { return parseStoredInt(localStorage.getItem(key), fallback, min, max); } catch { return fallback; }
  }

  function writeStoredInt(key, n) {
    const val = String(Number.isFinite(n) ? Math.trunc(n) : 0);
    const storage = storageApi();
    if (storage && typeof storage.setStr === 'function') {
      storage.setStr(key, val);
      return;
    }
    try { localStorage.setItem(key, val); } catch {}
  }

  function readStoredJSON(key, fallback = null) {
    const storage = storageApi();
    if (storage && typeof storage.getJSON === 'function') {
      try {
        const v = storage.getJSON(key, null);
        return (v == null) ? fallback : v;
      } catch {}
    }
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return fallback;
      const parsed = JSON.parse(raw);
      return (parsed == null) ? fallback : parsed;
    } catch {
      return fallback;
    }
  }

  function parseStoredPx(raw, fallback = 0) {
    const n = Number.parseFloat(String(raw ?? '').replace('px', '').trim());
    if (!Number.isFinite(n)) return Number.parseFloat(String(fallback || 0)) || 0;
    return n;
  }

  function readAxisOffset() {
    if (FORCE_AXIS_DEFAULT_EACH_LOAD) {
      return { x: AXIS_BOOT_DEFAULT_X, y: AXIS_BOOT_DEFAULT_Y };
    }
    const raw = readStoredJSON(keyAxisOffset(), null);
    return {
      x: Math.round(parseStoredPx(raw?.axisX, 0)),
      y: Math.round(parseStoredPx(raw?.axisY, 0)),
    };
  }

  function applyAxisOffsetFromDisk(root) {
    if (!root) return false;
    const axis = readAxisOffset();
    try { root.style.setProperty('--axis-x', `${axis.x}px`); } catch {}
    try { root.style.setProperty('--axis-y', `${axis.y}px`); } catch {}
    return true;
  }

  function readCenterFixX() {
    if (FORCE_CENTER_FIX_RESET_EACH_LOAD) return 0;
    const raw = readStoredRaw(keyCenterFixX());
    return Math.round(parseStoredPx(raw, 0));
  }

  function applyCenterFixFromDisk(root) {
    if (!root) return false;
    if (LOCK_MM_CENTER_FIX_TO_AXIS) return resetCenterFixToZero(root);
    const x = readCenterFixX();
    try { root.style.setProperty('--mm-center-fix-x', `${x}px`); } catch {}
    return true;
  }

  function applyBootCenterFix(root) {
    if (!root) return false;
    if (LOCK_MM_CENTER_FIX_TO_AXIS) return resetCenterFixToZero(root);
    return applyCenterFixFromDisk(root);
  }

  function persistCenterFixX(x) {
    if (LOCK_MM_CENTER_FIX_TO_AXIS) return 0;
    const v = Math.round(parseStoredPx(x, 0));
    writeStoredRaw(keyCenterFixX(), `${v}`);
    return v;
  }

  function loadBadgeVisibilityOnce() {
    if (state.badgeVisibility.loaded) return state.badgeVisibility;
    state.badgeVisibility.quotes = readStoredBool(keyBadgeQuotes(), true);
    state.badgeVisibility.qwash = readStoredBool(keyBadgeQwash(), true);
    state.badgeVisibility.revisions = readStoredBool(keyBadgeRevs(), true);
    state.badgeVisibility.loaded = true;
    return state.badgeVisibility;
  }

  function emitBadgeVisibility(kind, on) {
    const detail = {
      kind: String(kind || ''),
      on: !!on,
      visibility: {
        quotes: state.badgeVisibility.quotes !== false,
        qwash: state.badgeVisibility.qwash !== false,
        revisions: state.badgeVisibility.revisions !== false,
      }
    };
    const targets = (TOPW && TOPW !== W) ? [W, TOPW] : [W];
    targets.forEach((target) => {
      try { target.dispatchEvent(new CustomEvent(EV_BADGE_VISIBILITY, { detail })); } catch {}
      try { target.dispatchEvent(new CustomEvent('h2o:minimap:badge-visibility', { detail })); } catch {}
    });
    bridgeQuestionWashVisibility(detail);
  }

  function bridgeQuestionWashVisibility(detail) {
    const kind = String(detail?.kind || '').trim().toLowerCase();
    if (kind !== 'qwash') return false;

    const invoke = () => {
      let ok = false;
      [TOPW?.H2O_QWASH_API, W?.H2O_QWASH_API].forEach((api) => {
        if (!api || typeof api !== 'object') return;
        try {
          api.onMiniMapVisibilityChanged?.(detail);
          if (detail?.on === false) api.clearMiniMap?.();
          if (detail?.on === true) api.repaint?.('shell:badge-visibility');
          ok = true;
        } catch {}
      });
      return ok;
    };

    const ok = invoke();
    if (!ok && detail?.on === false) {
      try {
        (getRoot() || document).querySelectorAll('.cgxq-qwash-mm-num-on').forEach((num) => {
          num.classList.remove('cgxq-qwash-mm-num-on');
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
        });
      } catch {}
    }

    W.setTimeout(() => { invoke(); }, 0);
    W.setTimeout(() => { invoke(); }, 120);
    return ok;
  }

  function resolveDialBasePx(root) {
    if (Number.isFinite(state.dialHeight.basePx) && state.dialHeight.basePx > 0) return state.dialHeight.basePx;
    let base = 140;
    try {
      const raw = getComputedStyle(root).getPropertyValue('--mm-max-sub');
      const parsed = Number.parseFloat(String(raw || '').trim());
      if (Number.isFinite(parsed) && parsed > 0) base = parsed;
    } catch {}
    state.dialHeight.basePx = base;
    return base;
  }

  function resolveDialBaseVh(root) {
    if (Number.isFinite(state.dialHeight.baseVh) && state.dialHeight.baseVh > 0) return state.dialHeight.baseVh;
    let base = 60;
    try {
      const raw = String(getComputedStyle(root).getPropertyValue('--mm-max-vh') || '').trim();
      const parsed = Number.parseFloat(raw);
      if (Number.isFinite(parsed) && parsed > 0) base = parsed;
    } catch {}
    state.dialHeight.baseVh = base;
    return base;
  }

  function applyDialHeightStep(refs = getRefs()) {
    const root = refs?.root;
    if (!root) return;
    const step = parseStoredInt(state.dialHeight.step, 0, 0, DIAL_HEIGHT_STEP_MAX);
    const base = resolveDialBasePx(root);
    const baseVh = resolveDialBaseVh(root);
    const nextPx = base + (step * DIAL_HEIGHT_STEP_DELTA_PX);
    const nextVh = Math.max(20, baseVh - (step * DIAL_HEIGHT_STEP_DELTA_VH));
    try {
      root.style.setProperty('--mm-max-sub', `${nextPx}px`);
      root.style.setProperty('--mm-max-vh', `${nextVh}vh`);
      root.setAttribute('data-cgxui-dial-step', String(step));
    } catch {}
  }

  function loadDialHeightStepOnce(refs = getRefs()) {
    if (state.dialHeight.loaded) {
      applyDialHeightStep(refs);
      return state.dialHeight.step;
    }
    state.dialHeight.step = readStoredInt(keyDialHeightStep(), 0, 0, DIAL_HEIGHT_STEP_MAX);
    state.dialHeight.dir = readStoredInt(keyDialHeightDir(), 1, -1, 1) === -1 ? -1 : 1;
    state.dialHeight.loaded = true;
    applyDialHeightStep(refs);
    return state.dialHeight.step;
  }

  function setDialHeightStep(step, refs = getRefs()) {
    const next = parseStoredInt(step, 0, 0, DIAL_HEIGHT_STEP_MAX);
    state.dialHeight.step = next;
    state.dialHeight.loaded = true;
    writeStoredInt(keyDialHeightStep(), next);
    writeStoredInt(keyDialHeightDir(), state.dialHeight.dir === -1 ? -1 : 1);
    applyDialHeightStep(refs);
    return next;
  }

  function cycleDialHeightStep(refs = getRefs()) {
    const cur = loadDialHeightStepOnce(refs);
    let dir = state.dialHeight.dir === -1 ? -1 : 1;
    let next = cur + dir;
    if (next > DIAL_HEIGHT_STEP_MAX) {
      dir = -1;
      next = cur - 1;
    } else if (next < 0) {
      dir = 1;
      next = cur + 1;
    }
    state.dialHeight.dir = dir;
    return setDialHeightStep(next, refs);
  }

  function syncPinButtons(refs = getRefs()) {
    const cfg = loadBadgeVisibilityOnce();
    const apply = (btn, isOn) => {
      if (!btn) return;
      btn.setAttribute('aria-pressed', isOn ? 'true' : 'false');
      btn.classList.toggle('is-off', !isOn);
    };
    apply(refs.pinQuote, cfg.quotes !== false);
    apply(refs.pinQwash, cfg.qwash !== false);
    apply(refs.pinRev, cfg.revisions !== false);
  }

  function applyBadgeVisibility(refs = getRefs()) {
    const cfg = loadBadgeVisibilityOnce();
    const root = refs?.root || null;
    if (root) {
      root.classList.toggle('cgx-mm-hide-quotes', cfg.quotes === false);
      root.classList.toggle('cgx-mm-hide-qwash', cfg.qwash === false);
      root.classList.toggle('cgx-mm-hide-revs', cfg.revisions === false);
    }
    syncPinButtons(refs);
  }

  function setBadgeVisibility(kind, on) {
    const cfg = loadBadgeVisibilityOnce();
    if (kind === 'quotes') {
      cfg.quotes = !!on;
      writeStoredBool(keyBadgeQuotes(), cfg.quotes);
      emitBadgeVisibility(kind, cfg.quotes);
    } else if (kind === 'qwash') {
      cfg.qwash = !!on;
      writeStoredBool(keyBadgeQwash(), cfg.qwash);
      emitBadgeVisibility(kind, cfg.qwash);
    } else if (kind === 'revisions') {
      cfg.revisions = !!on;
      writeStoredBool(keyBadgeRevs(), cfg.revisions);
      emitBadgeVisibility(kind, cfg.revisions);
    }
    applyBadgeVisibility(getRefs());
  }

  function toggleBadgeVisibility(kind) {
    const cfg = loadBadgeVisibilityOnce();
    if (kind === 'quotes') return setBadgeVisibility(kind, !(cfg.quotes !== false));
    if (kind === 'qwash') return setBadgeVisibility(kind, !(cfg.qwash !== false));
    if (kind === 'revisions') return setBadgeVisibility(kind, !(cfg.revisions !== false));
    return false;
  }

  function loadDialVisibilityOnce() {
    if (state.dialVisibility.loaded) return state.dialVisibility;
    state.dialVisibility.dots = readStoredBool(keyDialDotsVisibility(), true);
    state.dialVisibility.symbols = readStoredBool(keyDialSymbolsVisibility(), true);
    state.dialVisibility.loaded = true;
    return state.dialVisibility;
  }

  function syncDialPinButtons(refs = getRefs()) {
    const cfg = loadDialVisibilityOnce();
    const apply = (btn, isOn) => {
      if (!btn) return;
      btn.setAttribute('aria-pressed', isOn ? 'true' : 'false');
      btn.classList.toggle('is-off', !isOn);
    };
    apply(refs.dialPinDots, cfg.dots !== false);
    apply(refs.dialPinSymbols, cfg.symbols !== false);
    syncDialTitlePinButton(refs);
  }

  function applyDialVisibility(refs = getRefs()) {
    const cfg = loadDialVisibilityOnce();
    const root = refs?.root || null;
    if (root) {
      root.classList.toggle('cgx-mm-hide-dots', cfg.dots === false);
      root.classList.toggle('cgx-mm-hide-symbols', cfg.symbols === false);
    }
    syncDialPinButtons(refs);
  }

  function setDialVisibility(kind, on) {
    const cfg = loadDialVisibilityOnce();
    if (kind === 'dots') {
      cfg.dots = !!on;
      writeStoredBool(keyDialDotsVisibility(), cfg.dots);
    } else if (kind === 'symbols') {
      cfg.symbols = !!on;
      writeStoredBool(keyDialSymbolsVisibility(), cfg.symbols);
    } else {
      return false;
    }
    applyDialVisibility(getRefs());
    return true;
  }

  function toggleDialVisibility(kind) {
    const cfg = loadDialVisibilityOnce();
    if (kind === 'dots') return setDialVisibility(kind, !(cfg.dots !== false));
    if (kind === 'symbols') return setDialVisibility(kind, !(cfg.symbols !== false));
    return false;
  }

  function getStickyTitlePanelsMap() {
    try {
      if (TOPW.H2O_MM_stickyTitlePanels instanceof Map) return TOPW.H2O_MM_stickyTitlePanels;
    } catch {}
    try {
      if (W.H2O_MM_stickyTitlePanels instanceof Map) return W.H2O_MM_stickyTitlePanels;
    } catch {}
    return null;
  }

  function getStickyTitlePanelsStateFallback() {
    const map = getStickyTitlePanelsMap();
    let total = 0;
    let visible = 0;
    if (!(map instanceof Map)) return { total, visible };
    map.forEach((panel, id) => {
      if (!panel || !panel.isConnected) {
        map.delete(id);
        return;
      }
      total += 1;
      if (panel.style.display !== 'none') visible += 1;
    });
    return { total, visible };
  }

  function getStickyTitlePanelsState() {
    try {
      const stateFromPlugin = W.getStickyTitlePanelsState?.();
      if (stateFromPlugin && typeof stateFromPlugin === 'object') {
        const total = Number.parseInt(stateFromPlugin.total, 10);
        const visible = Number.parseInt(stateFromPlugin.visible, 10);
        return {
          total: Number.isFinite(total) ? Math.max(0, total) : 0,
          visible: Number.isFinite(visible) ? Math.max(0, visible) : 0,
        };
      }
    } catch {}
    return getStickyTitlePanelsStateFallback();
  }

  function syncDialTitlePinButton(refs = getRefs()) {
    const btn = refs?.dialPinTitles;
    if (!btn) return;
    const stateNow = getStickyTitlePanelsState();
    const hasVisible = stateNow.visible > 0;
    btn.setAttribute('aria-pressed', hasVisible ? 'true' : 'false');
    btn.classList.toggle('is-off', !hasVisible);
    const tip = hasVisible
      ? 'Hide Open Title Labels (double-click: toggle all)'
      : 'Show Open Title Labels (double-click: toggle all)';
    btn.setAttribute('aria-label', tip);
    btn.title = tip;
  }

  function fallbackToggleOpenStickyTitlePanels() {
    const map = getStickyTitlePanelsMap();
    if (!(map instanceof Map)) return false;

    const stateNow = getStickyTitlePanelsStateFallback();
    if (!stateNow.total) return true;

    const show = stateNow.visible === 0;
    map.forEach((panel, id) => {
      if (!panel || !panel.isConnected) {
        map.delete(id);
        return;
      }
      panel.style.display = show ? 'flex' : 'none';
    });
    if (show) {
      try { W.repositionAllStickyPanels?.(); } catch {}
    }
    return true;
  }

  function fallbackToggleAllStickyTitlePanels() {
    const btnSel = `[${ATTR.CGXUI}="${UI_.BTN}"][${ATTR.CGXUI_OWNER}="${SkID}"]`;
    const btns = Array.from(document.querySelectorAll(btnSel));
    if (!btns.length) return fallbackToggleOpenStickyTitlePanels();

    const map = getStickyTitlePanelsMap();
    let hasAny = false;
    let allVisible = true;

    for (const btn of btns) {
      const answerId = String(btn?.dataset?.primaryAId || btn?.dataset?.id || '').trim();
      if (!answerId) continue;
      hasAny = true;
      const panel = map?.get?.(answerId);
      if (!panel || !panel.isConnected || panel.style.display === 'none') {
        allVisible = false;
        break;
      }
    }

    if (!hasAny) return false;

    if (allVisible) {
      map?.forEach?.((panel, id) => {
        if (!panel || !panel.isConnected) {
          map.delete(id);
          return;
        }
        panel.style.display = 'none';
      });
      return true;
    }

    for (const btn of btns) {
      const answerId = String(btn?.dataset?.primaryAId || btn?.dataset?.id || '').trim();
      if (!answerId) continue;
      const panel = map?.get?.(answerId);
      if (panel && panel.isConnected && panel.style.display !== 'none') continue;
      try { W.toggleStickyTitlePanel?.(btn, answerId); } catch {}
    }
    try { W.repositionAllStickyPanels?.(); } catch {}
    return true;
  }

  function toggleOpenStickyTitlePanelsFromPin() {
    let ok = false;
    try {
      const result = W.toggleOpenStickyTitlePanels?.();
      ok = !!result || typeof W.toggleOpenStickyTitlePanels === 'function';
    } catch {}
    if (!ok) ok = fallbackToggleOpenStickyTitlePanels();
    syncDialTitlePinButton(getRefs());
    return ok;
  }

  function toggleAllStickyTitlePanelsFromPin() {
    let ok = false;
    try {
      const result = W.toggleAllStickyTitlePanels?.();
      ok = !!result || typeof W.toggleAllStickyTitlePanels === 'function';
    } catch {}
    if (!ok) ok = fallbackToggleAllStickyTitlePanels();
    syncDialTitlePinButton(getRefs());
    return ok;
  }

  function markReady(on) {
    const isReady = !!on;
    try { TOPW.H2O_MM_SHELL_READY = isReady; } catch {}
    try { TOPW.H2O_MM_UI_SHELL_READY = isReady; } catch {}
    return isReady;
  }

  function emitShellReady() {
    try { W.dispatchEvent(new CustomEvent(EV_SHELL_READY, { detail: { ver: SHELL_VER } })); } catch {}
  }

  function getRoot() {
    const byId = document.getElementById(ROOT_ID);
    const roots = Array.from(document.querySelectorAll(`${SEL.ROOT}, [data-h2o-owner="minimap-v10"]`))
      .filter(el => el && el.isConnected);
    if (byId && byId.isConnected && !roots.includes(byId)) roots.unshift(byId);

    if (roots.length > 1) {
      const keep = roots.find(el => el.matches?.(SEL.ROOT)) || roots[0];
      roots.forEach((el) => { if (el !== keep) { try { el.remove(); } catch {} } });
      keep.setAttribute('data-cgx', ROOT_CGX);
      keep.classList.add('cgx-mm', CLS_.ROOT);
      keep.id = keep.id || ROOT_ID;
      keep.setAttribute(ATTR.CGXUI_OWNER, SkID);
      keep.setAttribute(ATTR.CGXUI, UI.ROOT);
      if (keep.parentElement !== document.body) document.body.appendChild(keep);
      return keep;
    }

    if (byId && byId.isConnected) {
      byId.setAttribute('data-cgx', ROOT_CGX);
      byId.classList.add('cgx-mm', CLS_.ROOT);
      byId.id = byId.id || ROOT_ID;
      byId.setAttribute(ATTR.CGXUI_OWNER, SkID);
      byId.setAttribute(ATTR.CGXUI, UI.ROOT);
      if (byId.parentElement !== document.body) document.body.appendChild(byId);
      return byId;
    }

    let root = document.querySelector(SEL.ROOT);
    if (root && root.isConnected) return root;

    root = document.querySelector('[data-h2o-owner="minimap-v10"]');
    if (root && root.isConnected) {
      root.setAttribute('data-cgx', ROOT_CGX);
      root.classList.add('cgx-mm', CLS_.ROOT);
      root.id = root.id || ROOT_ID;
      root.setAttribute(ATTR.CGXUI_OWNER, SkID);
      root.setAttribute(ATTR.CGXUI, UI.ROOT);
      if (root.parentElement !== document.body) document.body.appendChild(root);
      return root;
    }

    root = document.createElement('div');
    root.id = ROOT_ID;
    root.className = `cgx-mm ${CLS_.ROOT}`;
    root.setAttribute('data-cgx', ROOT_CGX);
    root.setAttribute(ATTR.CGXUI_OWNER, SkID);
    root.setAttribute(ATTR.CGXUI, UI.ROOT);
    document.body.appendChild(root);
    return root;
  }

  function bind(target, type, fn, opts) {
    if (!target || typeof target.addEventListener !== 'function') return;
    target.addEventListener(type, fn, opts);
    state.off.push(() => { try { target.removeEventListener(type, fn, opts); } catch {} });
  }

  function cleanupListeners() {
    while (state.off.length) {
      const off = state.off.pop();
      try { off?.(); } catch {}
    }
  }

  function clearBootHoldWatchers() {
    try { state.bootHoldMO?.disconnect?.(); } catch {}
    state.bootHoldMO = null;
    try { if (state.bootHoldTimer) clearTimeout(state.bootHoldTimer); } catch {}
    state.bootHoldTimer = null;
  }

  function clearAlignWatchers() {
    try { state.alignMO?.disconnect?.(); } catch {}
    state.alignMO = null;
    if (state.alignRaf) {
      try { cancelAnimationFrame(state.alignRaf); } catch {}
      state.alignRaf = 0;
    }
  }

  function clearPrelayoutRafs() {
    if (state.prelayoutRaf1) {
      try { cancelAnimationFrame(state.prelayoutRaf1); } catch {}
      state.prelayoutRaf1 = 0;
    }
    if (state.prelayoutRaf2) {
      try { cancelAnimationFrame(state.prelayoutRaf2); } catch {}
      state.prelayoutRaf2 = 0;
    }
    if (state.prelayoutFailsafeTimer) {
      try { clearTimeout(state.prelayoutFailsafeTimer); } catch {}
      state.prelayoutFailsafeTimer = null;
    }
  }

  function prelayoutLoadSig() {
    const chatId = String(resolveChatId() || '__global__').trim();
    return `${chatId}|${location.pathname}|${location.search}`;
  }

  function setPrelayoutClass(refs = getRefs(), on = false) {
    const root = refs?.root || null;
    const panel = refs?.panel || null;
    const add = !!on;
    if (root) root.classList.toggle(PRELAYOUT_CLASS, add);
    if (panel) panel.classList.toggle(PRELAYOUT_CLASS, add);
  }

  function quickPluginPresent() {
    try { return TOPW.H2O_MM_QUICK_PLUGIN === true; } catch { return false; }
  }

  function quickReadyNow() {
    try {
      if (TOPW.H2O_MM_QUICK_READY === true) return true;
    } catch {}
    return state.quickReady === true;
  }

  function shouldHoldForQuick(elapsedMs = 0) {
    if (quickReadyNow()) return false;
    if (quickPluginPresent()) return true;
    // short grace to let quick-controls mount and apply persisted style/size before unhide
    return elapsedMs < 700;
  }

  function maybeCompletePrelayout() {
    const sig = prelayoutLoadSig();
    if (state.prelayoutDone && state.prelayoutSig === sig) return true;
    if (state.prelayoutSig !== sig) return false;
    const refs = getRefs();
    if (!(refs?.root && refs?.panel)) return false;
    const elapsed = Math.max(0, performance.now() - (state.prelayoutStartedAt || 0));
    if (shouldHoldForQuick(elapsed)) return false;
    const btnCount = countMiniMapButtons(refs);
    if (btnCount <= 0) return false;
    const changedCount = btnCount !== state.prelayoutLastBtnCount;
    state.prelayoutLastBtnCount = btnCount;
    if (LOCK_MM_CENTER_FIX_TO_AXIS) {
      resetCenterFixToZero(refs.root);
      if (state.prelayoutFailsafeTimer) {
        try { clearTimeout(state.prelayoutFailsafeTimer); } catch {}
        state.prelayoutFailsafeTimer = null;
      }
      setPrelayoutClass(refs, false);
      state.prelayoutDone = true;
      return true;
    }
    const delta = alignMiniMapCenter(refs);
    if (changedCount || !Number.isFinite(delta) || delta >= 1) {
      state.prelayoutStableTicks = 0;
      return false;
    }
    state.prelayoutStableTicks += 1;
    if (state.prelayoutStableTicks < 2) return false;
    if (state.prelayoutFailsafeTimer) {
      try { clearTimeout(state.prelayoutFailsafeTimer); } catch {}
      state.prelayoutFailsafeTimer = null;
    }
    setPrelayoutClass(refs, false);
    state.prelayoutDone = true;
    return true;
  }

  function runPrelayoutAlign(reason = 'boot') {
    const perfOwned = enterShellOwner('refreshShell');
    const perfT0 = perfNow();
    try {
      const refs = getRefs();
      if (!(refs?.root && refs?.panel)) return false;
      applyAxisOffsetFromDisk(refs.root);
      applyBootCenterFix(refs.root);
      const sig = prelayoutLoadSig();
      if (state.prelayoutDone && state.prelayoutSig === sig) return false;

      state.prelayoutSig = sig;
      state.prelayoutDone = false;
      state.prelayoutLastBtnCount = -1;
      state.prelayoutStableTicks = 0;
      state.prelayoutStartedAt = performance.now();
      setPrelayoutClass(refs, true);
      clearPrelayoutRafs();
      const fallbackWaitMs = quickPluginPresent() ? 1200 : 420;
      const runFailsafe = () => {
        state.prelayoutFailsafeTimer = null;
        if (maybeCompletePrelayout()) return;
        const refsNow = getRefs();
        if (hasNoButtonsButAnswers(refsNow)) {
          requestNoButtonsRebuild(`prelayout:${String(reason || 'boot')}`);
        }
        if (LOCK_MM_CENTER_FIX_TO_AXIS) resetCenterFixToZero(refsNow?.root || null);
        else {
          try { alignMiniMapCenter(refsNow); } catch {}
        }
        try { setPrelayoutClass(refsNow, false); } catch {}
        state.prelayoutDone = true;
      };
      state.prelayoutFailsafeTimer = setTimeout(runFailsafe, fallbackWaitMs);

      state.prelayoutRaf1 = requestAnimationFrame(() => {
        state.prelayoutRaf1 = 0;
        const refsNow = getRefs();
        if (LOCK_MM_CENTER_FIX_TO_AXIS) resetCenterFixToZero(refsNow?.root || null);
        else {
          try { alignMiniMapCenter(refsNow); } catch {}
        }
        maybeCompletePrelayout();
      });
      return true;
    } finally {
      const ms = perfNow() - perfT0;
      recordDuration(PERF.paths.runPrelayoutAlign, ms);
      if (perfOwned) {
        recordDuration(PERF.refreshShell, ms);
        noteSummaryBucket(PERF.refreshShell, reason || 'runPrelayoutAlign');
      }
      exitShellOwner('refreshShell');
    }
  }

  function applyControlBoxSize(el) {
    if (!el) return;
    try { Object.assign(el.style, { width: 'var(--box-w)', height: 'var(--box-h)' }); } catch {}
  }

  function mmButtonSel() {
    return [
      `[${ATTR.CGXUI}="${UI_.BTN}"][${ATTR.CGXUI_OWNER}="${SkID}"]`,
      '[data-cgxui="mm-btn"]',
      '.cgxui-mm-btn',
    ].join(', ');
  }

  function centerX(el) {
    if (!el || !el.isConnected) return null;
    try {
      const r = el.getBoundingClientRect();
      if (!Number.isFinite(r.left) || !Number.isFinite(r.width)) return null;
      return r.left + (r.width / 2);
    } catch {
      return null;
    }
  }

  function resetCenterFixToZero(root) {
    if (!root) return false;
    try { root.style.setProperty('--mm-center-fix-x', '0px'); } catch {}
    return true;
  }

  function alignMiniMapCenter(refs = getRefs()) {
    const root = refs?.root;
    if (!root) return NaN;
    if (LOCK_MM_CENTER_FIX_TO_AXIS) {
      resetCenterFixToZero(root);
      return 0;
    }
    const anchor = refs?.toggle || refs?.dial;
    const col = refs?.col || null;
    if (!anchor || !col) return NaN;
    const lane = col.querySelector(mmButtonSel());
    if (!lane) return NaN;
    const aX = centerX(anchor);
    const lX = centerX(col) ?? centerX(lane);
    if (!Number.isFinite(aX) || !Number.isFinite(lX)) return NaN;
    const dx = aX - lX;
    // Deadband avoids tiny oscillation from fractional layout rounding.
    if (Math.abs(dx) < 1) return 0;
    const cur = Number.parseFloat(String(root.style.getPropertyValue('--mm-center-fix-x') || '0').replace('px', '')) || 0;
    // Apply delta on top of current fix; assigning raw dx causes ping-pong.
    const next = Math.round(cur + dx);
    if (Math.abs(next - cur) < 1) return Math.abs(dx);
    try { root.style.setProperty('--mm-center-fix-x', `${next}px`); } catch {}
    persistCenterFixX(next);
    return Math.abs(dx);
  }

  function scheduleMiniMapCenterAlign() {
    if (state.alignRaf) return;
    state.alignRaf = requestAnimationFrame(() => {
      state.alignRaf = 0;
      const refs = getRefs();
      if (LOCK_MM_CENTER_FIX_TO_AXIS) resetCenterFixToZero(refs?.root || null);
      else alignMiniMapCenter(refs);
      maybeCompletePrelayout();
    });
  }

  function installMiniMapCenterWatchers(refs = getRefs()) {
    clearAlignWatchers();
    if (LOCK_MM_CENTER_FIX_TO_AXIS) {
      resetCenterFixToZero(refs?.root || null);
      maybeCompletePrelayout();
      return;
    }
    const col = refs?.col;
    if (col && typeof MutationObserver !== 'undefined') {
      state.alignMO = new MutationObserver(() => scheduleMiniMapCenterAlign());
      try { state.alignMO.observe(col, { childList: true, subtree: true }); } catch {}
    }
    scheduleMiniMapCenterAlign();
  }

  function hasMiniMapButtons(refs = getRefs()) {
    return countMiniMapButtons(refs) > 0;
  }

  function countMiniMapButtons(refs = getRefs()) {
    const scope = refs?.col || refs?.panel || null;
    if (!scope) return 0;
    try { return Number(scope.querySelectorAll(mmButtonSel()).length || 0); } catch {}
    return 0;
  }

  function hasAssistantAnswersInDom() {
    try { return !!document.querySelector(STUDIO_SEL.sel.assistantTurn); } catch {}
    return false;
  }

  function hasNoButtonsButAnswers(refs = getRefs()) {
    return countMiniMapButtons(refs) <= 0 && hasAssistantAnswersInDom();
  }

  function requestNoButtonsRebuild(reason = 'ensure-ui') {
    const perfOwned = enterShellOwner('refreshShell');
    const perfT0 = perfNow();
    PERF.noButtonsHandling.callCount = Number(PERF.noButtonsHandling.callCount || 0) + 1;
    PERF.noButtonsHandling.lastReason = String(reason || 'ensure-ui');
    PERF.noButtonsHandling.lastAt = Date.now();
    try {
      const refs = getRefs();
      if (!(refs?.root && refs?.panel)) {
        PERF.noButtonsHandling.skippedNoShellCount = Number(PERF.noButtonsHandling.skippedNoShellCount || 0) + 1;
        return false;
      }
      if (!hasNoButtonsButAnswers(refs)) {
        PERF.noButtonsHandling.skippedNoButtonsCount = Number(PERF.noButtonsHandling.skippedNoButtonsCount || 0) + 1;
        return false;
      }
      const now = Date.now();
      if ((now - Number(state.noButtonsRebuildAt || 0)) < 1500) {
        PERF.noButtonsHandling.throttledCount = Number(PERF.noButtonsHandling.throttledCount || 0) + 1;
        return false;
      }
      state.noButtonsRebuildAt = now;
      try {
        window.dispatchEvent(new CustomEvent(EVT_SHELL_NO_BUTTONS, {
          detail: {
            reason: String(reason || 'ensure-ui'),
            chatId: String(resolveChatId() || '').trim(),
            ts: Date.now(),
            source: 'shell',
          },
        }));
        PERF.noButtonsHandling.eventDispatchCount = Number(PERF.noButtonsHandling.eventDispatchCount || 0) + 1;
        return true;
      } catch {
        return false;
      }
    } finally {
      const ms = perfNow() - perfT0;
      recordDuration(PERF.paths.requestNoButtonsRebuild, ms);
      if (perfOwned) {
        recordDuration(PERF.refreshShell, ms);
        noteSummaryBucket(PERF.refreshShell, reason || 'requestNoButtonsRebuild');
      }
      exitShellOwner('refreshShell');
    }
  }

  function releaseBootHold() {
    const refs = getRefs();
    if (!refs.dial) return false;
    stateSet(refs.dial, 'boot-wait', false);
    // Cleanup from earlier startup strategy if token exists.
    stateSet(refs.root, 'boot-hold', false);
    clearBootHoldWatchers();
    return true;
  }

  function syncBootVisibility(refs = getRefs()) {
    if (!(refs?.root && refs?.panel && refs?.toggle && refs?.dial)) return;
    // Keep Dial visible immediately with the MiniMap shell.
    // We intentionally avoid boot-wait hiding to prevent reload flash/hide.
    releaseBootHold();
  }

  function emitRouteChanged(source = 'shell') {
    const detail = { source: String(source || 'shell'), href: String(location.href || ''), chatId: resolveChatId() };
    try { window.dispatchEvent(new CustomEvent(EV_ROUTE_CHANGED, { detail })); } catch {}
    try { window.dispatchEvent(new CustomEvent(EV_ROUTE_CHANGED.replace(/^evt:/, ''), { detail })); } catch {}
  }

  function installHistoryRouteBridge() {
    if (TOPW.H2O_MM_ROUTE_BRIDGE_INSTALLED === true) return true;

    const patch = (name) => {
      const orig = history?.[name];
      if (typeof orig !== 'function') return;
      if (orig.__h2oMmRouteWrapped) return;
      const wrapped = function h2oMmRouteWrapped(...args) {
        const out = orig.apply(this, args);
        emitRouteChanged(`history:${name}`);
        return out;
      };
      try { Object.defineProperty(wrapped, '__h2oMmRouteWrapped', { value: true }); } catch {}
      try { history[name] = wrapped; } catch {}
    };
    patch('pushState');
    patch('replaceState');
    try { TOPW.H2O_MM_ROUTE_BRIDGE_INSTALLED = true; } catch {}
    return true;
  }

  function syncRouteState(reason = 'route') {
    const perfOwned = enterShellOwner('refreshShell');
    const perfT0 = perfNow();
    try {
      const showControls = applyViewVisibility(getRefs(), reason);
      if (!showControls) {
        clearRouteAttachCheck();
        return false;
      }
      const chatId = resolveChatId();
      const sig = collapsedSig(chatId);
      if (sig === state.routeSig && state.bootCollapseApplied) return false;
      state.routeSig = sig;
      applyAxisOffsetFromDisk(getRefs()?.root || null);
      applyBootCenterFix(getRefs()?.root || null);
      applyBootCollapsedDefault(`route:${String(reason || 'route')}`);
      runPrelayoutAlign(`route:${String(reason || 'route')}`);
      const core = MM_core();
      const hydrateReason = `shell:route:${String(reason || 'route')}`;
      let shouldRebuild = false;
      if (core && typeof core.hydrateIndexFromDisk === 'function') {
        let res = null;
        try { res = core.hydrateIndexFromDisk(chatId, { reason: hydrateReason, source: 'shell' }); } catch {}
        const status = String(res?.status || res?.detail?.status || '').trim();
        const turnCount = Number(
          res?.detail?.turnCount ??
          (Array.isArray(res?.index?.turns) ? res.index.turns.length : 0) ??
          0
        ) || 0;
        if (!res || status === 'error' || status === 'noop') shouldRebuild = true;
        else scheduleRouteAttachCheck(chatId, turnCount, reason);
      } else {
        try {
          window.dispatchEvent(new CustomEvent(EVT_MM_INDEX_HYDRATED, {
            detail: {
              chatId: String(chatId || '').trim(),
              source: 'shell-fallback',
              status: 'noop',
              turnCount: 0,
              renderedCount: 0,
              ts: Date.now(),
            },
          }));
        } catch {}
        shouldRebuild = true;
      }
      if (shouldRebuild) {
        clearRouteAttachCheck();
        try { core?.scheduleRebuild?.(`shell:route:${String(reason || 'route')}`); } catch {}
      }
      return true;
    } finally {
      const ms = perfNow() - perfT0;
      recordDuration(PERF.paths.syncRouteState, ms);
      if (perfOwned) {
        recordDuration(PERF.refreshShell, ms);
        noteSummaryBucket(PERF.refreshShell, reason || 'syncRouteState');
      }
      exitShellOwner('refreshShell');
    }
  }

  function scheduleRouteSync(reason = 'route') {
    state.routeReason = String(reason || 'route');
    if (state.routeRaf) return;
    state.routeRaf = requestAnimationFrame(() => {
      state.routeRaf = 0;
      syncRouteState(state.routeReason || 'route');
    });
  }

  function clearRouteAttachCheck() {
    if (!state.routeAttachTimer) return;
    try { clearTimeout(state.routeAttachTimer); } catch {}
    state.routeAttachTimer = null;
  }

  function scheduleRouteAttachCheck(chatId = '', turnCount = 0, reason = 'route') {
    const cid = String(chatId || '').trim();
    const turns = Number(turnCount || 0);
    const why = String(reason || 'route');
    state.routeAttachToken += 1;
    const token = state.routeAttachToken;
    clearRouteAttachCheck();
    state.routeAttachTimer = setTimeout(() => {
      state.routeAttachTimer = null;
      if (token !== state.routeAttachToken) return;
      const core = MM_core();
      if (!core) return;
      if (typeof core.attachVisibleAnswers !== 'function') {
        if (turns > 0) {
          try { core.scheduleRebuild?.(`shell:route:${why}:attach-missing`); } catch {}
        }
        return;
      }
      let out = null;
      try { out = core.attachVisibleAnswers(cid); } catch {}
      const attached = Number(out?.attached || 0);
      const ok = !!out?.ok;
      if (!ok || (turns > 0 && attached <= 0)) {
        try { core.scheduleRebuild?.(`shell:route:${why}:attach-failed`); } catch {}
      }
    }, 180);
  }

  function ensureRouteBindings() {
    if (state.routeBound) return;
    state.routeBound = true;
    installHistoryRouteBridge();
    ensureViewObserver();
    scheduleViewVisibility('bind');

    const onRoute = () => scheduleRouteSync('event');
    bind(window, EV_ROUTE_CHANGED, onRoute, { passive: true });
    bind(window, EV_ROUTE_CHANGED.replace(/^evt:/, ''), onRoute, { passive: true });
    bind(window, 'popstate', onRoute, { passive: true });
    bind(window, 'hashchange', onRoute, { passive: true });
    bind(window, 'pageshow', () => scheduleViewVisibility('pageshow'), { passive: true });
    bind(window, 'resize', () => scheduleViewVisibility('resize'), { passive: true });
    bind(window, 'focus', () => scheduleViewVisibility('focus'), { passive: true });
    bind(document, 'focusin', () => scheduleViewVisibility('focusin'), true);
    bind(window, 'evt:h2o:answers:scan', onRoute, { passive: true });
    bind(window, 'h2o:answers:scan', onRoute, { passive: true });

    const onQuickReady = () => {
      state.quickReady = true;
      runPrelayoutAlign('quick-ready');
    };
    bind(window, EV_QUICK_READY, onQuickReady, { passive: true });
    bind(window, EV_QUICK_READY.replace(/^evt:/, ''), onQuickReady, { passive: true });
  }

  function ensureDialButtons(dial) {
    const SVG_UP = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M6 14l6-6 6 6" /></svg>';
    const SVG_DOWN = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M6 10l6 6 6-6" /></svg>';
    let cachedScrollEl = null;
    const getScrollEl = () => {
      const direct = document.querySelector('[data-scroll-root="1"]');
      if (direct) return (cachedScrollEl = direct);
      if (cachedScrollEl && document.contains(cachedScrollEl)) return cachedScrollEl;
      const cands = Array.from(document.querySelectorAll('body *'))
        .filter((el) => {
          const cs = getComputedStyle(el);
          if (!/(auto|scroll)/.test(cs.overflowY)) return false;
          return (el.scrollHeight - el.clientHeight) > 200;
        })
        .sort((a, b) => (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight));
      return (cachedScrollEl = cands[0] || document.scrollingElement || document.documentElement);
    };
    const scrollToTop = () => {
      const el = getScrollEl();
      if (el === document.scrollingElement || el === document.documentElement || el === document.body) {
        window.scrollTo({ top: 0, behavior: 'smooth' });
        return;
      }
      try { el.scrollTo({ top: 0, behavior: 'smooth' }); } catch { el.scrollTop = 0; }
    };
    const scrollToBottom = () => {
      const el = getScrollEl();
      let top = 0;
      if (el === document.scrollingElement || el === document.documentElement || el === document.body) {
        const h = Math.max(document.documentElement.scrollHeight, document.body.scrollHeight);
        top = Math.max(0, h - window.innerHeight);
        window.scrollTo({ top, behavior: 'smooth' });
        return;
      }
      top = Math.max(0, (el.scrollHeight - el.clientHeight));
      try { el.scrollTo({ top, behavior: 'smooth' }); } catch { el.scrollTop = top; }
    };
    const ensureBtn = (ui, title, svg, onClick) => {
      const q = `[${ATTR.CGXUI}="${ui}"][${ATTR.CGXUI_OWNER}="${SkID}"]`;
      let btn = dial.querySelector(q);
      if (!btn) {
        btn = document.createElement('button');
        btn.setAttribute(ATTR.CGXUI, ui);
        btn.setAttribute(ATTR.CGXUI_OWNER, SkID);
        dial.appendChild(btn);
      }
      btn.type = 'button';
      btn.title = title;
      btn.setAttribute('aria-label', title);
      btn.innerHTML = svg;
      btn.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        onClick();
      };
    };
    ensureBtn(UI_.DIAL_UP, 'Scroll to top', SVG_UP, scrollToTop);
    ensureBtn(UI_.DIAL_DOWN, 'Scroll to bottom', SVG_DOWN, scrollToBottom);
  }

  function behaviorApi() {
    try { return MM_behavior() || null; } catch { return null; }
  }

  function behaviorMap() {
    const api = behaviorApi();
    try { return api?.get?.() || api?.defaults?.() || null; } catch { return null; }
  }

  function behaviorBinding(surface, gesture, ev) {
    const api = behaviorApi();
    const map = behaviorMap();
    try { return api?.getBinding?.(surface, gesture, ev, map) || { kind: 'none' }; } catch { return { kind: 'none' }; }
  }

  function markSynthetic(ev, key) {
    try { Object.defineProperty(ev, key, { value: true }); } catch {}
    try { ev[key] = true; } catch {}
    return ev;
  }

  function openExportMenu() {
    const exportBtn =
      document.getElementById('cgxui-xpch-export-btn') ||
      document.querySelector('[data-cgxui="xpch-dl-toggle"][data-cgxui-owner="xpch"]');
    if (exportBtn && typeof exportBtn.click === 'function') {
      try { exportBtn.click(); return true; } catch {}
    }
    return false;
  }

  function openQuickControls(ctx = null) {
    // For native toggle middle-click, Quick Controls plugin already listens on this same auxclick.
    // Re-dispatching here can double-toggle (open then close).
    if (ctx?.surface === 'toggle' && ctx?.gesture === 'mid' && ctx?.ev?.type === 'auxclick') {
      return true;
    }
    const refs = getRefs();
    const toggle = refs?.toggle;
    if (!toggle) return false;
    try {
      const ev = markSynthetic(new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1, buttons: 4 }), '__h2oBehaviorSyntheticQuick');
      toggle.dispatchEvent(ev);
      return true;
    } catch {
      return false;
    }
  }

  function resolveShellBinding(binding, ctx, actions, customActions) {
    const map = behaviorMap() || {};
    const kind = String(binding?.kind || '').trim();
    if (!kind) return { binding: { kind: 'none' }, fn: null };
    if (kind === 'auto') {
      const api = behaviorApi();
      let next = null;
      try {
        const defs = api?.defaults?.() || null;
        next = defs?.[ctx.surface]?.[ctx.gesture] || null;
      } catch {}
      if (!next || !next.kind || next.kind === 'auto') return { binding: { kind: 'none' }, fn: null };
      const nk = String(next.kind || '').trim();
      return { binding: next, fn: (nk === 'custom') ? null : (actions[nk] || null) };
    }
    if (kind === 'custom') {
      const id = String(binding?.id || '').trim();
      if (!id || typeof customActions[id] !== 'function') {
        behaviorApi()?.warnOnce?.(`shell-custom:${ctx.surface}:${ctx.gesture}:${id || 'missing'}`, 'Unknown custom action id; fallback applied.', { surface: ctx.surface, gesture: ctx.gesture, id });
        const fb = map?.customFallback?.kind === 'none' ? { kind: 'none' } : { kind: String(map?.customFallback?.kind || 'none') };
        if (fb.kind === 'none') return { binding: fb, fn: null };
        return { binding: fb, fn: actions[fb.kind] || null };
      }
      return { binding, fn: customActions[id] };
    }
    return { binding, fn: actions[kind] || null };
  }

  function runShellBinding(surface, gesture, ev, btnEl = null) {
    const perfOwned = enterShellOwner('shellEvent');
    const perfT0 = perfNow();
    PERF.shellEvents.enabled = true;
    bumpCounter(PERF.shellEvents.surfaces, surface || 'unknown');
    bumpCounter(PERF.shellEvents.gestures, gesture || 'unknown');
    PERF.shellEvents.lastType = `${String(surface || 'unknown')}:${String(gesture || 'unknown')}`;
    PERF.shellEvents.lastAt = Date.now();
    try {
      const binding = behaviorBinding(surface, gesture, ev);
      const kind = String(binding?.kind || '').trim();
      if (kind === 'none') {
        bumpReason(PERF.shellEvents.actions, 'none');
        PERF.shellEvents.lastAction = 'none';
        return false;
      }
      if (kind === 'blocked') {
        bumpReason(PERF.shellEvents.actions, 'blocked');
        PERF.shellEvents.lastAction = 'blocked';
        ev?.preventDefault?.();
        ev?.stopPropagation?.();
        return true;
      }

      const actions = {
        hideMap: (ctx) => {
          const refs = ctx.uiRefs || getRefs();
          const collapsed = !stateHas(refs.panel, 'collapsed');
          setCollapsed(collapsed);
          return true;
        },
        quick: (ctx) => openQuickControls(ctx),
        export: () => openExportMenu(),
        adjust: () => {
          cycleDialHeightStep(getRefs());
          return true;
        },
        auto: () => false,
      };
      const actionsCustom = {
        'quick.open': () => openQuickControls(),
        'export.menu.open': () => openExportMenu(),
      };
      const ctx = {
        surface,
        gesture,
        btnEl,
        ev,
        uiRefs: getRefs(),
        sh: getSharedRefs(),
        core: MM_core(),
        rt: MM_rt(),
      };
      const resolved = resolveShellBinding(binding, ctx, actions, actionsCustom);
      const resolvedKind = String(resolved?.binding?.kind || kind || 'none').trim() || 'none';
      bumpReason(PERF.shellEvents.actions, resolvedKind);
      PERF.shellEvents.lastAction = resolvedKind;
      if (!resolved.fn) {
        behaviorApi()?.warnOnce?.(`shell-action:${surface}:${gesture}:${kind}`, 'Action unavailable; safe no-op.', { surface, gesture, kind });
        ev?.preventDefault?.();
        ev?.stopPropagation?.();
        return true;
      }
      ev?.preventDefault?.();
      ev?.stopPropagation?.();
      try {
        return !!resolved.fn(ctx, binding?.payload || {});
      } catch (e) {
        behaviorApi()?.warnOnce?.(`shell-action-err:${surface}:${gesture}:${kind}`, 'Action failed; safe no-op.', { err: String(e?.message || e) });
        return false;
      }
    } finally {
      const ms = perfNow() - perfT0;
      recordDuration(PERF.paths.runShellBinding, ms);
      if (perfOwned) {
        recordDuration(PERF.shellEvents.total, ms);
        noteSummaryBucket(PERF.shellEvents.total, PERF.shellEvents.lastType || 'runShellBinding');
      }
      exitShellOwner('shellEvent');
    }
  }

  // Keep the existing wrapper and its independent pin buttons. A sibling
  // native button supplies access without nesting interactive controls or
  // duplicating keyboard activation; its click bubbles to the existing binding.
  function ensureToggleAccess(refs = getRefs()) {
    const { toggle, panel } = refs;
    if (!toggle || !panel) return;
    let access = toggle.querySelector(`[${ATTR.CGXUI}="${UI.ACCESS}"][${ATTR.CGXUI_OWNER}="${SkID}"]`);
    if (!access) {
      access = document.createElement('button');
      access.type = 'button';
      access.setAttribute(ATTR.CGXUI, UI.ACCESS);
      access.setAttribute(ATTR.CGXUI_OWNER, SkID);
      access.textContent = 'MiniMap';
      toggle.prepend(access);
    }
    const expanded = !stateHas(panel, 'collapsed');
    const name = expanded ? 'Hide MiniMap navigation' : 'Show MiniMap navigation';
    access.setAttribute('aria-label', name);
    access.setAttribute('aria-expanded', String(expanded));
    access.title = name;
    // The existing panel has no stable ID; aria-controls is intentionally absent.
  }

  function ensureToggleBinding(toggle) {
    if (!toggle) return;
    ensureToggleAccess({ toggle, panel: getRefs().panel });
    if (toggle.dataset.h2oShellBound) return;
    toggle.dataset.h2oShellBound = '1';

    bind(toggle, 'click', (e) => {
      if (e?.__h2oBehaviorSyntheticQuick) return;
      runShellBinding('toggle', 'click', e, toggle);
    });
    bind(toggle, 'dblclick', (e) => {
      if (e?.__h2oBehaviorSyntheticQuick) return;
      runShellBinding('toggle', 'dblclick', e, toggle);
    });
    bind(toggle, 'mousedown', (e) => {
      if (e?.button !== 1 || e?.__h2oBehaviorSyntheticQuick) return;
      const b = behaviorBinding('toggle', 'mid', e);
      if (String(b?.kind || 'none') !== 'none') e.preventDefault();
    }, { passive: false });
    bind(toggle, 'auxclick', (e) => {
      if (e?.button !== 1 || e?.__h2oBehaviorSyntheticQuick) return;
      runShellBinding('toggle', 'mid', e, toggle);
    }, { passive: false });
  }

  function ensureDialCycleBinding(dial) {
    if (!dial || dial.dataset.h2oDialCycleBound === '3') return;
    dial.dataset.h2oDialCycleBound = '3';
    const dialBtnSel = `[${ATTR.CGXUI}="${UI_.DIAL_UP}"],[${ATTR.CGXUI}="${UI_.DIAL_DOWN}"]`;

    const isDialButton = (target) => !!(target && typeof target.closest === 'function' && target.closest(dialBtnSel));

    bind(dial, 'click', (e) => {
      if (isDialButton(e?.target)) return;
      runShellBinding('dial', 'click', e, dial);
    });
    bind(dial, 'dblclick', (e) => {
      if (isDialButton(e?.target)) return;
      runShellBinding('dial', 'dblclick', e, dial);
    });
    bind(dial, 'mousedown', (e) => {
      if (e?.button !== 1 || isDialButton(e?.target)) return;
      const b = behaviorBinding('dial', 'mid', e);
      if (String(b?.kind || 'none') !== 'none') e.preventDefault();
    }, { passive: false });
    bind(dial, 'auxclick', (e) => {
      if (e?.button !== 1 || isDialButton(e?.target)) return;
      runShellBinding('dial', 'mid', e, dial);
    }, { passive: false });
  }

  function ensureTogglePins(toggle) {
    if (!toggle) return;
    let row = toggle.querySelector(`[${ATTR.CGXUI}="${UI_.PINROW}"][${ATTR.CGXUI_OWNER}="${SkID}"]`);
    if (!row) {
      row = document.createElement('div');
      row.className = 'cgx-mm-pinrow';
      row.setAttribute(ATTR.CGXUI_OWNER, SkID);
      row.setAttribute(ATTR.CGXUI, UI_.PINROW);
      toggle.appendChild(row);
    }

    const ensurePin = (ui, className, ariaLabel, kind) => {
      let btn = row.querySelector(`[${ATTR.CGXUI}="${ui}"][${ATTR.CGXUI_OWNER}="${SkID}"]`);
      if (!btn) {
        btn = document.createElement('button');
        btn.className = `cgx-mm-pin ${className}`;
        btn.setAttribute(ATTR.CGXUI, ui);
        btn.setAttribute(ATTR.CGXUI_OWNER, SkID);
        row.appendChild(btn);
      }
      btn.type = 'button';
      btn.textContent = '•';
      btn.setAttribute('aria-label', ariaLabel);
      btn.title = ariaLabel;
      if (!btn.dataset.h2oPinBound) {
        btn.dataset.h2oPinBound = '1';
        const stop = (e) => { e.stopPropagation(); };
        bind(btn, 'pointerdown', stop, true);
        bind(btn, 'mousedown', stop, true);
        bind(btn, 'keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') stop(e);
        }, true);
        bind(btn, 'click', (e) => {
          const perfOwned = enterShellOwner('shellEvent');
          const perfT0 = perfNow();
          PERF.shellEvents.enabled = true;
          bumpReason(PERF.shellEvents.actions, 'toggleBadgeVisibility');
          bumpCounter(PERF.shellEvents.surfaces, 'togglePin');
          bumpCounter(PERF.shellEvents.gestures, 'click');
          PERF.shellEvents.lastType = `togglePin:${String(kind || 'unknown')}:click`;
          PERF.shellEvents.lastAction = 'toggleBadgeVisibility';
          PERF.shellEvents.lastAt = Date.now();
          try {
            e.preventDefault();
            e.stopPropagation();
            toggleBadgeVisibility(kind);
          } finally {
            const ms = perfNow() - perfT0;
            recordDuration(PERF.paths.togglePinClick, ms);
            if (perfOwned) {
              recordDuration(PERF.shellEvents.total, ms);
              noteSummaryBucket(PERF.shellEvents.total, PERF.shellEvents.lastType);
            }
            exitShellOwner('shellEvent');
          }
        }, true);
      }
      return btn;
    };

    const pinQuote = ensurePin(UI_.PIN_QUOTE, 'cgx-mm-pin-quote', 'Toggle Quote Badges', 'quotes');
    const pinQwash = ensurePin(UI_.PIN_QWASH, 'cgx-mm-pin-qwash', 'Toggle Question Color Square', 'qwash');
    const pinRev = ensurePin(UI_.PIN_REV, 'cgx-mm-pin-rev', 'Toggle Revision Badges', 'revisions');
    try {
      row.appendChild(pinQuote);
      row.appendChild(pinQwash);
      row.appendChild(pinRev);
    } catch {}
    syncPinButtons(getRefs());
  }

  function ensureDialPins(dial) {
    if (!dial) return;
    let row = dial.querySelector(`[${ATTR.CGXUI}="${UI_.DIAL_PINROW}"][${ATTR.CGXUI_OWNER}="${SkID}"]`);
    if (!row) {
      row = document.createElement('div');
      row.className = 'cgx-mm-dial-pinrow';
      row.setAttribute(ATTR.CGXUI_OWNER, SkID);
      row.setAttribute(ATTR.CGXUI, UI_.DIAL_PINROW);
      dial.appendChild(row);
    }

    const ensurePin = (ui, className, ariaLabel, kind) => {
      let btn = row.querySelector(`[${ATTR.CGXUI}="${ui}"][${ATTR.CGXUI_OWNER}="${SkID}"]`);
      if (!btn) {
        btn = document.createElement('button');
        btn.className = `cgx-mm-pin ${className}`;
        btn.setAttribute(ATTR.CGXUI, ui);
        btn.setAttribute(ATTR.CGXUI_OWNER, SkID);
        row.appendChild(btn);
      }
      btn.type = 'button';
      btn.textContent = '•';
      btn.setAttribute('aria-label', ariaLabel);
      btn.title = ariaLabel;
      if (!btn.dataset.h2oDialPinBound) {
        btn.dataset.h2oDialPinBound = '1';
        const stop = (e) => { e.stopPropagation(); };
        bind(btn, 'pointerdown', stop, true);
        bind(btn, 'mousedown', stop, true);
        bind(btn, 'keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') stop(e);
        }, true);
        bind(btn, 'click', (e) => {
          const perfOwned = enterShellOwner('shellEvent');
          const perfT0 = perfNow();
          PERF.shellEvents.enabled = true;
          bumpReason(PERF.shellEvents.actions, 'toggleDialVisibility');
          bumpCounter(PERF.shellEvents.surfaces, 'dialPin');
          bumpCounter(PERF.shellEvents.gestures, 'click');
          PERF.shellEvents.lastType = `dialPin:${String(kind || 'unknown')}:click`;
          PERF.shellEvents.lastAction = 'toggleDialVisibility';
          PERF.shellEvents.lastAt = Date.now();
          try {
            e.preventDefault();
            e.stopPropagation();
            toggleDialVisibility(kind);
          } finally {
            const ms = perfNow() - perfT0;
            recordDuration(PERF.paths.dialPinClick, ms);
            if (perfOwned) {
              recordDuration(PERF.shellEvents.total, ms);
              noteSummaryBucket(PERF.shellEvents.total, PERF.shellEvents.lastType);
            }
            exitShellOwner('shellEvent');
          }
        }, true);
      }
      return btn;
    };

    const ensureTitlePin = () => {
      const ui = UI_.DIAL_PIN_TITLES;
      const ariaLabel = 'Toggle Open Title Labels (double-click: toggle all)';
      let btn = row.querySelector(`[${ATTR.CGXUI}="${ui}"][${ATTR.CGXUI_OWNER}="${SkID}"]`);
      if (!btn) {
        btn = document.createElement('button');
        btn.className = 'cgx-mm-pin cgx-mm-pin-titles';
        btn.setAttribute(ATTR.CGXUI, ui);
        btn.setAttribute(ATTR.CGXUI_OWNER, SkID);
        row.appendChild(btn);
      }
      btn.type = 'button';
      btn.textContent = '•';
      btn.setAttribute('aria-label', ariaLabel);
      btn.title = ariaLabel;

      if (!btn.dataset.h2oDialTitlePinBound) {
        btn.dataset.h2oDialTitlePinBound = '1';
        let clickTimer = null;
        const stop = (e) => { e.stopPropagation(); };
        const stopHard = (e) => {
          e.preventDefault();
          e.stopPropagation();
        };

        bind(btn, 'pointerdown', stop, true);
        bind(btn, 'mousedown', stop, true);
        bind(btn, 'keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') stop(e);
        }, true);

        bind(btn, 'click', (e) => {
          const perfOwned = enterShellOwner('shellEvent');
          const perfT0 = perfNow();
          PERF.shellEvents.enabled = true;
          bumpReason(PERF.shellEvents.actions, 'toggleOpenStickyTitlePanelsFromPin');
          bumpCounter(PERF.shellEvents.surfaces, 'dialTitlePin');
          bumpCounter(PERF.shellEvents.gestures, 'click');
          PERF.shellEvents.lastType = 'dialTitlePin:click';
          PERF.shellEvents.lastAction = 'toggleOpenStickyTitlePanelsFromPin';
          PERF.shellEvents.lastAt = Date.now();
          try {
            stopHard(e);
            if (clickTimer) clearTimeout(clickTimer);
            clickTimer = setTimeout(() => {
              clickTimer = null;
              toggleOpenStickyTitlePanelsFromPin();
            }, 220);
          } finally {
            const ms = perfNow() - perfT0;
            recordDuration(PERF.paths.dialTitleClick, ms);
            if (perfOwned) {
              recordDuration(PERF.shellEvents.total, ms);
              noteSummaryBucket(PERF.shellEvents.total, PERF.shellEvents.lastType);
            }
            exitShellOwner('shellEvent');
          }
        }, true);

        bind(btn, 'dblclick', (e) => {
          const perfOwned = enterShellOwner('shellEvent');
          const perfT0 = perfNow();
          PERF.shellEvents.enabled = true;
          bumpReason(PERF.shellEvents.actions, 'toggleAllStickyTitlePanelsFromPin');
          bumpCounter(PERF.shellEvents.surfaces, 'dialTitlePin');
          bumpCounter(PERF.shellEvents.gestures, 'dblclick');
          PERF.shellEvents.lastType = 'dialTitlePin:dblclick';
          PERF.shellEvents.lastAction = 'toggleAllStickyTitlePanelsFromPin';
          PERF.shellEvents.lastAt = Date.now();
          try {
            stopHard(e);
            if (clickTimer) {
              clearTimeout(clickTimer);
              clickTimer = null;
            }
            toggleAllStickyTitlePanelsFromPin();
          } finally {
            const ms = perfNow() - perfT0;
            recordDuration(PERF.paths.dialTitleDblclick, ms);
            if (perfOwned) {
              recordDuration(PERF.shellEvents.total, ms);
              noteSummaryBucket(PERF.shellEvents.total, PERF.shellEvents.lastType);
            }
            exitShellOwner('shellEvent');
          }
        }, true);
      }

      return btn;
    };

    const pinDots = ensurePin(UI_.DIAL_PIN_DOTS, 'cgx-mm-pin-dots', 'Toggle Highlight Dots', 'dots');
    const pinTitles = ensureTitlePin();
    const pinSymbols = ensurePin(UI_.DIAL_PIN_SYMBOLS, 'cgx-mm-pin-symbols', 'Toggle Right Symbols', 'symbols');
    try {
      row.appendChild(pinDots);
      row.appendChild(pinTitles);
      row.appendChild(pinSymbols);
    } catch {}
    syncDialPinButtons(getRefs());
  }

  function installControlHubFeature() {
    window.h2oConfig = window.h2oConfig || {};
    window.h2oConfig.features = window.h2oConfig.features || {};
    window.h2oConfig.features.minimap = {
      key: 'minimap',
      label: 'MiniMap',
      description: 'Sidebar MiniMap + answer map + nav buttons',
      enabled() { return !getCollapsed(); },
      setEnabled(on) {
        const refs = getRefs();
        const collapsed = !on;
        setCollapsed(collapsed);
        if (refs.root) refs.root.style.display = on ? '' : 'none';
        if (refs.toggle) refs.toggle.style.display = on ? '' : 'none';
      }
    };
  }

  function ensureBehaviorHook() {
    if (state.behaviorHooked) return;
    state.behaviorHooked = true;
    bind(window, EV_BEHAVIOR_CHANGED, () => {
      try { behaviorApi()?.get?.(true); } catch {}
    }, true);
  }

  function ensureUI(reason = '') {
    const perfOwned = enterShellOwner('ensureShell');
    const perfT0 = perfNow();
    try {
      ensureBehaviorHook();
      ensureRouteBindings();
      state.quickReady = state.quickReady || (TOPW.H2O_MM_QUICK_READY === true);
      const refsBefore = getRefs();
      if (refsBefore.root && refsBefore.panel && refsBefore.toggle && refsBefore.dial) {
        noteShellState('reuseCount', reason || 'ensure-ui');
        ensureSkinHealthy(reason || 'ensure-ui');
        applyViewMode(refsBefore);
        applyAxisOffsetFromDisk(refsBefore.root);
        applyBootCenterFix(refsBefore.root);
        applyBootCollapsedDefault();
        applyViewVisibility(refsBefore, reason || 'ensure-ui');
        loadDialHeightStepOnce(refsBefore);
        ensureToggleBinding(refsBefore.toggle);
        ensureDialCycleBinding(refsBefore.dial);
        ensureTogglePins(refsBefore.toggle);
        ensureDialPins(refsBefore.dial);
        installMiniMapCenterWatchers(refsBefore);
        if (!state.alignResizeBound) {
          state.alignResizeBound = true;
          bind(window, 'resize', () => scheduleMiniMapCenterAlign(), { passive: true });
        }
        applyBadgeVisibility(getRefs());
        applyDialVisibility(getRefs());
        syncBootVisibility(refsBefore);
        runPrelayoutAlign(`ensure:${String(reason || 'reuse')}`);
        requestNoButtonsRebuild(`ensure:${String(reason || 'reuse')}`);
        return refsBefore;
      }
      if (state.mounting) {
        noteShellState('noOpCount', reason || 'ensure-ui');
        return refsBefore;
      }
      const hadAnyShell = !!(refsBefore.root || refsBefore.panel || refsBefore.toggle || refsBefore.dial);
      noteShellState(hadAnyShell ? 'rebuildCount' : 'createCount', reason || 'ensure-ui');
      noteShellState('shellMissingOrDetached', reason || 'ensure-ui');
      state.mounting = true;
      try {
        skinEnsureStyle(reason || 'ensure-ui');
        const root = getRoot();
        try {
          root.classList.add(CLS_.ROOT);
          root.setAttribute(ATTR.CGXUI_OWNER, SkID);
          root.setAttribute(ATTR.CGXUI, UI.ROOT);
        } catch {}
        setPrelayoutClass({ root, panel: null }, true);
        applyAxisOffsetFromDisk(root);
        applyBootCenterFix(root);

        let panel = root.querySelector(SEL.PANEL);
        if (!panel) {
          panel = document.createElement('div');
          panel.className = CLS_.MINIMAP;
          panel.setAttribute(ATTR.CGXUI_OWNER, SkID);
          panel.setAttribute(ATTR.CGXUI, UI.MINIMAP);
          root.appendChild(panel);
          noteShellState('panelCreated', reason || 'ensure-ui');
        }
        panel.classList.add(CLS_.MINIMAP);
        panel.setAttribute(ATTR.CGXUI_OWNER, SkID);
        panel.setAttribute(ATTR.CGXUI, UI.MINIMAP);
        applyViewMode({ panel });
        setPrelayoutClass({ root, panel }, true);
        skinEnsureStyle(reason || 'ensure-ui');

        let col = panel.querySelector(`[${ATTR.CGXUI}="${UI_.COL}"][${ATTR.CGXUI_OWNER}="${SkID}"]`);
        if (!col) {
          col = document.createElement('div');
          col.className = CLS_.COL;
          col.setAttribute(ATTR.CGXUI_OWNER, SkID);
          col.setAttribute(ATTR.CGXUI, UI_.COL);
          panel.appendChild(col);
          noteShellState('colCreated', reason || 'ensure-ui');
        }
        Object.assign(col.style, { overflow: 'visible' });

        let toggle = document.querySelector(SEL.TOGGLE);
        if (toggle && toggle.parentElement !== root) {
          noteShellState('toggleReparented', reason || 'ensure-ui');
          try { root.prepend(toggle); } catch {}
        }
        if (!toggle) {
          toggle = document.createElement('div');
          toggle.className = CLS_.TOGGLE;
          toggle.setAttribute(ATTR.CGXUI_OWNER, SkID);
          toggle.setAttribute(ATTR.CGXUI, UI.TOGGLE);
          root.appendChild(toggle);
          noteShellState('toggleCreated', reason || 'ensure-ui');
        }
        toggle.classList.add(CLS_.TOGGLE);
        toggle.setAttribute(ATTR.CGXUI_OWNER, SkID);
        toggle.setAttribute(ATTR.CGXUI, UI.TOGGLE);
        applyControlBoxSize(toggle);
        if (!toggle.querySelector(`[${ATTR.CGXUI}="${UI_.COUNT}"][${ATTR.CGXUI_OWNER}="${SkID}"]`)) {
          toggle.innerHTML = `<span class="${CLS_.COUNT}" ${ATTR.CGXUI_OWNER}="${SkID}" ${ATTR.CGXUI}="${UI_.COUNT}" style="pointer-events: none;">0 / 0</span>`;
        }
        ensureTogglePins(toggle);

        let dial = document.querySelector(SEL.DIAL);
        if (dial && dial.parentElement !== root) {
          noteShellState('dialReparented', reason || 'ensure-ui');
          try { root.appendChild(dial); } catch {}
        }
        if (!dial) {
          dial = document.createElement('div');
          dial.className = CLS_.DIAL;
          dial.setAttribute(ATTR.CGXUI_OWNER, SkID);
          dial.setAttribute(ATTR.CGXUI, UI.DIAL);
          root.appendChild(dial);
          noteShellState('dialCreated', reason || 'ensure-ui');
        }
        dial.classList.add(CLS_.DIAL);
        dial.setAttribute(ATTR.CGXUI_OWNER, SkID);
        dial.setAttribute(ATTR.CGXUI, UI.DIAL);
        applyControlBoxSize(dial);

        ensureDialButtons(dial);
        ensureDialPins(dial);
        try {
          root.appendChild(toggle);
          root.appendChild(panel);
          root.appendChild(dial);
        } catch {}

        applyBootCollapsedDefault();
        loadDialHeightStepOnce(getRefs());
        applyBadgeVisibility(getRefs());
        applyDialVisibility(getRefs());
        applyViewVisibility(getRefs(), reason || 'mount');
        syncBootVisibility(getRefs());
        installControlHubFeature();
        ensureToggleBinding(toggle);
        ensureDialCycleBinding(dial);
        installMiniMapCenterWatchers(getRefs());
        if (!state.alignResizeBound) {
          state.alignResizeBound = true;
          bind(window, 'resize', () => scheduleMiniMapCenterAlign(), { passive: true });
        }
        runPrelayoutAlign(`mount:${String(reason || 'mount')}`);
        requestNoButtonsRebuild(`mount:${String(reason || 'mount')}`);
        return getRefs();
      } finally {
        state.mounting = false;
      }
    } finally {
      const ms = perfNow() - perfT0;
      recordDuration(PERF.paths.ensureUI, ms);
      if (perfOwned) {
        recordDuration(PERF.ensureShell, ms);
        noteSummaryBucket(PERF.ensureShell, reason || 'ensureUI');
      }
      exitShellOwner('ensureShell');
    }
  }

  function mountUI(reason = '') {
    const perfT0 = perfNow();
    try {
      return ensureUI(reason || 'mount');
    } finally {
      recordDuration(PERF.paths.mountUI, perfNow() - perfT0);
    }
  }

  function unmountUI() {
    const perfT0 = perfNow();
    try {
      const refs = getRefs();
      cleanupListeners();
      clearViewObserver();
      clearPrelayoutRafs();
      setPrelayoutClass(refs, false);
      state.prelayoutSig = '';
      state.prelayoutDone = false;
      state.prelayoutLastBtnCount = -1;
      state.prelayoutStableTicks = 0;
      if (state.routeRaf) {
        try { cancelAnimationFrame(state.routeRaf); } catch {}
        state.routeRaf = 0;
      }
      clearRouteAttachCheck();
      state.routeAttachToken = 0;
      state.routeBound = false;
      state.routeSig = '';
      state.routeReason = '';
      clearBootHoldWatchers();
      clearAlignWatchers();
      state.alignResizeBound = false;
      try { refs.counter?.remove?.(); } catch {}
      try { refs.root?.remove?.(); } catch {}
      try { skinUnmountStyle('unmount-ui'); } catch {}
      markReady(false);
      return true;
    } finally {
      recordDuration(PERF.paths.unmountUI, perfNow() - perfT0);
    }
  }

  function installAPI() {
    const api = {
      mountUI,
      unmountUI,
      ensureUI,
      ensureStyle: skinEnsureStyle,
      setCollapsed,
      getCollapsed,
      getRefs,
      storageApi,
      nsDisk,
      keyMmIndexChat,
      keyBootMode,
      getBootMode,
      setBootMode,
      getViewMode,
      setViewMode,
    };
    try {
      const sharedRoot = TOPW.H2O_MM_SHARED;
      if (sharedRoot && typeof sharedRoot === 'object') {
        sharedRoot.api = (sharedRoot.api && typeof sharedRoot.api === 'object') ? sharedRoot.api : {};
        sharedRoot.api.ui = api;
      }
    } catch {}
    try {
      const refs = TOPW.H2O_MM_SHARED?.get?.() || null;
      if (refs?.vault?.api && typeof refs.vault.api === 'object') refs.vault.api.ui = api;
      if (refs?.api && typeof refs.api === 'object') refs.api.ui = api;
    } catch {}
    try {
      W.H2O = W.H2O || {};
      W.H2O.MM = W.H2O.MM || {};
      W.H2O.MM.mnmp = W.H2O.MM.mnmp || {};
      W.H2O.MM.mnmp.api = (W.H2O.MM.mnmp.api && typeof W.H2O.MM.mnmp.api === 'object')
        ? W.H2O.MM.mnmp.api
        : {};
      W.H2O.MM.mnmp.api.ui = api;
    } catch {}
    return api;
  }

  function markShellReady() {
    if (state.booted) return;
    if (!shellDepsReady()) return;
    const refs = getRefs();
    if (!(refs?.panel && refs?.toggle)) return;
    state.booted = true;
    if (!PERF.bootCompletedAt) PERF.bootCompletedAt = Date.now();
    markReady(true);
    emitShellReady();
    log('UI shell ready.', { ver: SHELL_VER });
  }

  function tryBoot() {
    installIndexDebugListenerOnce();
    installAPI();
    if (!shellDepsReady()) return false;
    const refs = ensureUI('boot');
    const healthy = ensureSkinHealthy('shell:boot');
    if (refs?.panel && refs?.toggle && healthy) {
      installAPI();
      markShellReady();
      return true;
    }
    return false;
  }

  function scheduleBoot(maxRetries = 20, gapMs = 120) {
    const tick = () => {
      state.retries += 1;
      const done = tryBoot();
      if (done) return;
      if (state.retries >= maxRetries) {
        warn('Shell UI did not mount in time; leaving as-is.');
        return;
      }
      setTimeout(tick, gapMs);
    };
    tick();
  }

  installAPI();

  try {
    W.addEventListener(EV_SKIN_READY, () => {
      try {
        if (!state.booted) tryBoot();
      } catch {}
    }, true);
  } catch {}

  scheduleBoot(40, 150);

  try {
    W.addEventListener(EVT_MM_VIEW_CHANGED, () => {
      try { applyViewMode(getRefs()); } catch {}
    }, true);
  } catch {}

  try {
    W.addEventListener('pageshow', () => {
      try { scheduleViewVisibility('pageshow'); } catch {}
      try { ensureUI('event:pageshow'); } catch {}
      try { scheduleRouteSync('pageshow'); } catch {}
    }, { passive: true });
  } catch {}
})();
