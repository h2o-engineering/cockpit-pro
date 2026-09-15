// ==UserScript==
// @h2o-id             s1a1c.minimap.engine.studio
// @name               S1A1c. 🎬 MiniMap Engine - Studio
// @namespace          H2O.Premium.CGX.minimap.engine
// @author             HumamDev
// @version            12.8.0
// @revision           006
// @build              260329-012900
// @description        MiniMap Engine: hard runtime authority (observers, rebuild scheduling, active sync)
// @match              https://chatgpt.com/*
// @run-at             document-idle
// @grant              none
// ==/UserScript==

/* Cutover Smoke Test Checklist
 * - Kernel+Shell+Engine (Main optional): MiniMap appears, updates, navigates
 * - Kernel+Shell+Main+Engine: no double observers, no duplicate rebuild loops
 * - Remove Main: system remains functional (target architecture)
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
  const PERF_MODULE = (H2O.perf.modules.miniMapEngine && typeof H2O.perf.modules.miniMapEngine === 'object')
    ? H2O.perf.modules.miniMapEngine
    : (H2O.perf.modules.miniMapEngine = Object.create(null));
  const PERF = (() => {
    const existing = PERF_MODULE.__h2oPerfState;
    if (existing && typeof existing === 'object') return existing;
    const next = createMiniMapEnginePerfState();
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
  ensureMiniMapEnginePerfStateShape(PERF);
  PERF_MODULE.getStats = getMiniMapEnginePerfStats;
  PERF_MODULE.resetStats = () => {
    resetMiniMapEnginePerfState(PERF);
    return getMiniMapEnginePerfStats();
  };

  // Kernel-authoritative bridge access (no fallbacks here; util.mm decides)
  const MM = () => (TOPW.H2O_MM_SHARED?.get?.() || null)?.util?.mm || null;
  const MM_core = () => MM()?.core?.() || null;
  const MM_ui = () => MM()?.ui?.() || null;
  const MM_rt = () => MM()?.rt?.() || null;
  const MM_behavior = () => (TOPW.H2O_MM_SHARED?.get?.() || null)?.util?.behavior || null;
  const MM_uiRefs = () => MM()?.uiRefs?.() || (MM_ui()?.getRefs?.() || {});
  const MM_schedule = () => TOPW.H2O?.runtime?.schedule || W.H2O?.runtime?.schedule || null;

  const __rafFallback = Object.create(null);

  function MM_scheduleRafOnce(key, fn) {
    const perfBucket = PERF.rafOnce;
    const perfKey = String(key || '').trim() || 'unknown';
    perfBucket.requestedCount = Number(perfBucket.requestedCount || 0) + 1;
    perfBucket.lastKey = perfKey;
    perfBucket.lastAt = Date.now();
    const keyBucket = ensureRafOnceKeyBucket(perfKey);
    keyBucket.requestedCount = Number(keyBucket.requestedCount || 0) + 1;
    keyBucket.lastAt = perfBucket.lastAt;
    const schedule = MM_schedule();
    if (schedule && typeof schedule.rafOnce === 'function') {
      const isPending = typeof schedule.isPending === 'function' ? !!schedule.isPending(key) : false;
      if (isPending) {
        perfBucket.coalescedCount = Number(perfBucket.coalescedCount || 0) + 1;
        keyBucket.coalescedCount = Number(keyBucket.coalescedCount || 0) + 1;
      }
      return schedule.rafOnce(key, () => {
        perfBucket.executedCount = Number(perfBucket.executedCount || 0) + 1;
        keyBucket.executedCount = Number(keyBucket.executedCount || 0) + 1;
        fn();
      });
    }
    if (__rafFallback[key]) {
      perfBucket.coalescedCount = Number(perfBucket.coalescedCount || 0) + 1;
      keyBucket.coalescedCount = Number(keyBucket.coalescedCount || 0) + 1;
      return;
    }
    __rafFallback[key] = requestAnimationFrame(() => {
      delete __rafFallback[key];
      perfBucket.executedCount = Number(perfBucket.executedCount || 0) + 1;
      keyBucket.executedCount = Number(keyBucket.executedCount || 0) + 1;
      fn();
    });
  }

  const ENGINE_VER = '12.7.0';
  const EVT_ENGINE_READY = 'evt:h2o:minimap:engine-ready';
  const EVT_SHELL_READY = 'evt:h2o:minimap:shell-ready';
  const EVT_ROUTE_CHANGED = 'evt:h2o:route:changed';
  const EVT_ANSWERS_SCAN_FALLBACK = 'evt:h2o:answers:scan';
  const EVT_BEHAVIOR_CHANGED = 'evt:h2o:mm:behavior-changed';
  const EVT_MM_INDEX_APPENDED = 'evt:h2o:minimap:index:appended';
  const EVT_MM_INDEX_HYDRATED = 'evt:h2o:minimap:index:hydrated';
  const EVT_MM_VIEW_CHANGED = 'evt:h2o:minimap:view-changed';
  const EVT_SHELL_NO_BUTTONS = 'evt:h2o:minimap:shell:no-buttons';
  const EVT_PAGE_CHANGED = 'evt:h2o:pagination:pagechanged';
  const EVT_PAGE_CHANGED_ALIAS = 'h2o:pagination:pagechanged';
  const EVT_MSG_REMOUNTED = 'evt:h2o:message:remounted';
  const EVT_MSG_REMOUNTED_ALIAS = 'h2o:message:remounted';
  const EVT_MSG_MOUNT_REQUEST = 'h2o:message:mount:request';
  const EVT_ARCHIVE_SCROLL_TO_COLD = 'evt:h2o:archive:scroll-to-cold';

  const BOOT_MAX_TRIES = 80;
  const BOOT_GAP_MS = 120;
  const MO_REBUILD_COOLDOWN_MS = 320;
  const BOOT_MODE_CACHE_FIRST = 'cache_first';
  const BOOT_MODE_REBUILD_FIRST = 'rebuild_first';
  const PERF_ASSERT_ON = (() => {
    try { return String(localStorage.getItem('h2o:perf') || '') === '1'; } catch { return false; }
  })();
  const S = {
    running: false,
    bootDone: false,
    bootTries: 0,
    bootTimer: null,
    rebuildReason: '',
    syncRAF: 0,
    syncQueued: false,
    syncReasons: new Set(),

    domMO: null,
    panelMO: null,
    panelRootMO: null,
    formRO: null,
    io: null,
    ioObserved: new Set(),

    firstPaintRaf: 0,
    failsafeTimer: null,
    paginationCheckFastTimer: null,
    paginationCheckSlowTimer: null,

    offScroll: null,
    offResize: null,
    offShellReady: null,
    offBehaviorChanged: null,
    offRouteChanged: null,
    offBtnClick: null,
    offPaginationChanged: null,
    offPaginationChangedAlias: null,
    offIndexAppended: null,
    offIndexHydrated: null,
    offViewChanged: null,
    offShellNoButtons: null,

    lastActiveTurnId: '',
    lastActiveBtnId: '',
    lastActiveBtnEl: null,
    perfFullScanTick: 0,
    moRebuildCooldownUntil: 0,
    visibleSet: new Set(),
    mapButtons: null,
    turnListeners: new Set(),
    scrollSyncDisabled: false,
    mmScroller: null,
    mmUser: false,
    mmProgram: false,
    mmUserTimer: null,
    pageJumpTimer: null,
    pageJumpToken: 0,
    pageJumpUntil: 0,
    lastActivePageNum: 0,
    offMmWheel: null,
    offMmTouchStart: null,
    offMmMouseDown: null,
    lastViewMode: '',
    structureRecoveryQueued: false,
    structureRecoveryReason: '',
  };

  function getCoreSurface() {
    return MM_core();
  }

  function disableScrollSync(reason = 'core-missing') {
    if (S.scrollSyncDisabled) return;
    S.scrollSyncDisabled = true;
    warn('Scroll sync disabled.', { reason });
  }

  function hasPendingPageJump() {
    return Number(S.pageJumpUntil || 0) > Date.now();
  }

  function cancelPageJumpGuard(token = 0) {
    const activeToken = Number(S.pageJumpToken || 0);
    if (token && token !== activeToken) return false;
    clearTimer('pageJumpTimer');
    S.pageJumpUntil = 0;
    S.mmProgram = false;
    return true;
  }

  function armPageJumpGuard(ms = 1100, reason = 'page-divider') {
    const waitMs = Math.max(260, Number(ms || 0) || 0);
    const token = Number(S.pageJumpToken || 0) + 1;
    S.pageJumpToken = token;
    S.pageJumpUntil = Date.now() + waitMs;
    S.mmProgram = true;
    clearTimer('pageJumpTimer');
    S.pageJumpTimer = setTimeout(() => {
      if (token !== Number(S.pageJumpToken || 0)) return;
      S.pageJumpTimer = null;
      S.pageJumpUntil = 0;
      S.mmProgram = false;
      if (S.running) scheduleSyncActive(`${String(reason || 'page-divider')}:settled`);
    }, waitMs);
    return token;
  }

  function getDiag() {
    const SH = TOPW.H2O_MM_SHARED?.get?.();
    try {
      const d = SH?.diag?.ensure?.({ name: 'H2O MiniMap Engine', diagKey: 'H2O:diag:minimap' });
      return d && typeof d.log === 'function' ? d : null;
    } catch {
      return null;
    }
  }

  function dlog(step, data) {
    try { getDiag()?.log?.(step, data); } catch {}
  }

  function derr(where, err) {
    try { getDiag()?.err?.(err, where); } catch {}
  }

  function warn(msg, extra) { try { console.warn('[MiniMap Engine]', msg, extra || ''); } catch {} }

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
      slowOver100Count: 0,
    };
  }

  function createDurationBucketMap(keys = []) {
    const out = Object.create(null);
    for (const key of keys) out[String(key)] = createDurationBucket();
    return out;
  }

  function createPointerDownPerfState() {
    return Object.assign(createDurationBucket(), {
      beforeBootCount: 0,
      afterBootCount: 0,
      lastAt: 0,
      lastTargetType: '',
      lastActionType: '',
      targetType: createDurationBucketMap([
        'answerButton',
        'questionButton',
        'pageDividerLabel',
        'background',
        'unknown',
      ]),
      actionType: createDurationBucketMap([
        'noOp',
        'jumpOrScroll',
        'directUiRefresh',
        'rebuildSchedule',
        'structureRecoveryCheck',
      ]),
      branches: Object.create(null),
    });
  }

  function createMiniMapEnginePerfState() {
    return {
      bootCompletedAt: 0,
      rafOnce: {
        requestedCount: 0,
        executedCount: 0,
        coalescedCount: 0,
        lastKey: '',
        lastAt: 0,
        keys: Object.create(null),
      },
      scheduleSyncActive: {
        callCount: 0,
        executedCount: 0,
        coalescedCount: 0,
        lastReason: '',
        lastAt: 0,
        reasons: Object.create(null),
        beforeBoot: { callCount: 0, executedCount: 0, coalescedCount: 0 },
        afterBoot: { callCount: 0, executedCount: 0, coalescedCount: 0 },
      },
      syncActiveExecution: Object.assign(createDurationBucket(), {
        beforeBootCount: 0,
        afterBootCount: 0,
      }),
      wheelGuard: Object.assign(createDurationBucket(), {
        touchstartCount: 0,
        mousedownCount: 0,
        beforeBootCount: 0,
        afterBootCount: 0,
      }),
      rebuild: {
        scheduleCallCount: 0,
        executedCount: 0,
        coalescedCount: 0,
        lastReason: '',
        lastAt: 0,
        reasons: Object.create(null),
        beforeBoot: { scheduleCallCount: 0, executedCount: 0, coalescedCount: 0 },
        afterBoot: { scheduleCallCount: 0, executedCount: 0, coalescedCount: 0 },
        duration: createDurationBucket(),
      },
      structureRecovery: {
        callCount: 0,
        coalescedCount: 0,
        executedCheckCount: 0,
        shellNoButtonsEvents: 0,
        recoveryTriggeredRebuildCount: 0,
        lastReason: '',
        lastAt: 0,
      },
      refreshFromIndexedState: {
        callCount: 0,
        successCount: 0,
        duration: createDurationBucket(),
      },
      pointerDown: createPointerDownPerfState(),
    };
  }

  function ensureMiniMapEnginePerfStateShape(target) {
    if (!target || typeof target !== 'object') return target;
    if (!target.pointerDown || typeof target.pointerDown !== 'object') target.pointerDown = createPointerDownPerfState();
    if (!target.pointerDown.targetType || typeof target.pointerDown.targetType !== 'object') target.pointerDown.targetType = Object.create(null);
    if (!target.pointerDown.actionType || typeof target.pointerDown.actionType !== 'object') target.pointerDown.actionType = Object.create(null);
    if (!target.pointerDown.branches || typeof target.pointerDown.branches !== 'object') target.pointerDown.branches = Object.create(null);
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
    if (ms > 100) bucket.slowOver100Count = Number(bucket.slowOver100Count || 0) + 1;
    return ms;
  }

  function bumpCounter(obj, key) {
    if (!obj) return 0;
    const k = String(key || '');
    obj[k] = Number(obj[k] || 0) + 1;
    return obj[k];
  }

  function bumpReason(obj, key) {
    const reason = String(key || '').trim() || 'unknown';
    return bumpCounter(obj, reason);
  }

  function currentPerfPhase() {
    return Number(PERF.bootCompletedAt || 0) > 0 ? 'afterBoot' : 'beforeBoot';
  }

  function bumpPhaseCounter(bucket, phase, key) {
    if (!bucket || !bucket[phase]) return 0;
    return bumpCounter(bucket[phase], key);
  }

  function ensureRafOnceKeyBucket(key) {
    const k = String(key || '').trim() || 'unknown';
    const keys = PERF.rafOnce.keys || (PERF.rafOnce.keys = Object.create(null));
    if (!keys[k] || typeof keys[k] !== 'object') {
      keys[k] = {
        requestedCount: 0,
        executedCount: 0,
        coalescedCount: 0,
        lastAt: 0,
      };
    }
    return keys[k];
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
      slowOver100Count: Number(bucket?.slowOver100Count || 0),
    };
  }

  function ensureDurationBucketMapEntry(obj, key) {
    const k = String(key || '').trim() || 'unknown';
    if (!obj[k] || typeof obj[k] !== 'object') obj[k] = createDurationBucket();
    return obj[k];
  }

  function copyDurationBucketMap(obj) {
    const out = Object.create(null);
    for (const key of Object.keys(obj || {})) out[key] = readDurationBucket(obj[key]);
    return out;
  }

  function copyPlainCounts(obj) {
    const out = Object.create(null);
    for (const key of Object.keys(obj || {})) out[key] = Number(obj[key] || 0);
    return out;
  }

  function copyRafOnceKeys(obj) {
    const out = Object.create(null);
    for (const key of Object.keys(obj || {})) {
      const bucket = obj[key] || {};
      out[key] = {
        requestedCount: Number(bucket.requestedCount || 0),
        executedCount: Number(bucket.executedCount || 0),
        coalescedCount: Number(bucket.coalescedCount || 0),
        lastAt: Number(bucket.lastAt || 0),
      };
    }
    return out;
  }

  function copyPhaseCounts(obj) {
    const out = Object.create(null);
    for (const key of Object.keys(obj || {})) out[key] = Number(obj[key] || 0);
    return out;
  }

  function resetMiniMapEnginePerfState(target) {
    if (!target) return target;
    const bootCompletedAt = S.bootDone ? Math.max(0, Number(target.bootCompletedAt || Date.now())) : 0;
    target.bootCompletedAt = bootCompletedAt;
    target.rafOnce = {
      requestedCount: 0,
      executedCount: 0,
      coalescedCount: 0,
      lastKey: '',
      lastAt: 0,
      keys: Object.create(null),
    };
    target.scheduleSyncActive = {
      callCount: 0,
      executedCount: 0,
      coalescedCount: 0,
      lastReason: '',
      lastAt: 0,
      reasons: Object.create(null),
      beforeBoot: { callCount: 0, executedCount: 0, coalescedCount: 0 },
      afterBoot: { callCount: 0, executedCount: 0, coalescedCount: 0 },
    };
    target.syncActiveExecution = Object.assign(createDurationBucket(), {
      beforeBootCount: 0,
      afterBootCount: 0,
    });
    target.wheelGuard = Object.assign(createDurationBucket(), {
      touchstartCount: 0,
      mousedownCount: 0,
      beforeBootCount: 0,
      afterBootCount: 0,
    });
    target.rebuild = {
      scheduleCallCount: 0,
      executedCount: 0,
      coalescedCount: 0,
      lastReason: '',
      lastAt: 0,
      reasons: Object.create(null),
      beforeBoot: { scheduleCallCount: 0, executedCount: 0, coalescedCount: 0 },
      afterBoot: { scheduleCallCount: 0, executedCount: 0, coalescedCount: 0 },
      duration: createDurationBucket(),
    };
    target.structureRecovery = {
      callCount: 0,
      coalescedCount: 0,
      executedCheckCount: 0,
      shellNoButtonsEvents: 0,
      recoveryTriggeredRebuildCount: 0,
      lastReason: '',
      lastAt: 0,
    };
    target.refreshFromIndexedState = {
      callCount: 0,
      successCount: 0,
      duration: createDurationBucket(),
    };
    target.pointerDown = createPointerDownPerfState();
    return target;
  }

  function getMiniMapEnginePerfStats() {
    ensureMiniMapEnginePerfStateShape(PERF);
    const scheduleBucket = PERF.scheduleSyncActive || {};
    const execBucket = PERF.syncActiveExecution || {};
    const wheelBucket = PERF.wheelGuard || {};
    const rebuildBucket = PERF.rebuild || {};
    const recoveryBucket = PERF.structureRecovery || {};
    const refreshBucket = PERF.refreshFromIndexedState || {};
    const pointerDownBucket = PERF.pointerDown || {};
    return {
      bootCompletedAt: Number(PERF.bootCompletedAt || 0),
      rafOnce: {
        requestedCount: Number(PERF.rafOnce?.requestedCount || 0),
        executedCount: Number(PERF.rafOnce?.executedCount || 0),
        coalescedCount: Number(PERF.rafOnce?.coalescedCount || 0),
        lastKey: String(PERF.rafOnce?.lastKey || ''),
        lastAt: Number(PERF.rafOnce?.lastAt || 0),
        keys: copyRafOnceKeys(PERF.rafOnce?.keys),
      },
      scheduleSyncActive: {
        callCount: Number(scheduleBucket.callCount || 0),
        executedCount: Number(scheduleBucket.executedCount || 0),
        coalescedCount: Number(scheduleBucket.coalescedCount || 0),
        lastReason: String(scheduleBucket.lastReason || ''),
        lastAt: Number(scheduleBucket.lastAt || 0),
        reasons: copyPlainCounts(scheduleBucket.reasons),
        beforeBoot: copyPhaseCounts(scheduleBucket.beforeBoot),
        afterBoot: copyPhaseCounts(scheduleBucket.afterBoot),
      },
      syncActiveExecution: Object.assign(readDurationBucket(execBucket), {
        beforeBootCount: Number(execBucket.beforeBootCount || 0),
        afterBootCount: Number(execBucket.afterBootCount || 0),
      }),
      wheelGuard: Object.assign(readDurationBucket(wheelBucket), {
        touchstartCount: Number(wheelBucket.touchstartCount || 0),
        mousedownCount: Number(wheelBucket.mousedownCount || 0),
        beforeBootCount: Number(wheelBucket.beforeBootCount || 0),
        afterBootCount: Number(wheelBucket.afterBootCount || 0),
      }),
      rebuild: Object.assign({
        scheduleCallCount: Number(rebuildBucket.scheduleCallCount || 0),
        executedCount: Number(rebuildBucket.executedCount || 0),
        coalescedCount: Number(rebuildBucket.coalescedCount || 0),
        lastReason: String(rebuildBucket.lastReason || ''),
        lastAt: Number(rebuildBucket.lastAt || 0),
        reasons: copyPlainCounts(rebuildBucket.reasons),
        beforeBoot: copyPhaseCounts(rebuildBucket.beforeBoot),
        afterBoot: copyPhaseCounts(rebuildBucket.afterBoot),
      }, readDurationBucket(rebuildBucket.duration)),
      structureRecovery: {
        callCount: Number(recoveryBucket.callCount || 0),
        coalescedCount: Number(recoveryBucket.coalescedCount || 0),
        executedCheckCount: Number(recoveryBucket.executedCheckCount || 0),
        shellNoButtonsEvents: Number(recoveryBucket.shellNoButtonsEvents || 0),
        recoveryTriggeredRebuildCount: Number(recoveryBucket.recoveryTriggeredRebuildCount || 0),
        lastReason: String(recoveryBucket.lastReason || ''),
        lastAt: Number(recoveryBucket.lastAt || 0),
      },
      refreshFromIndexedState: Object.assign({
        callCount: Number(refreshBucket.callCount || 0),
        successCount: Number(refreshBucket.successCount || 0),
      }, readDurationBucket(refreshBucket.duration)),
      pointerDown: Object.assign(readDurationBucket(pointerDownBucket), {
        beforeBootCount: Number(pointerDownBucket.beforeBootCount || 0),
        afterBootCount: Number(pointerDownBucket.afterBootCount || 0),
        lastAt: Number(pointerDownBucket.lastAt || 0),
        lastTargetType: String(pointerDownBucket.lastTargetType || ''),
        lastActionType: String(pointerDownBucket.lastActionType || ''),
        targetType: copyDurationBucketMap(pointerDownBucket.targetType),
        actionType: copyDurationBucketMap(pointerDownBucket.actionType),
        branches: copyDurationBucketMap(pointerDownBucket.branches),
      }),
    };
  }

  function syncViewportPageDivider(core, pageNum, reason = 'scroll') {
    const num = Math.max(0, Number(pageNum || 0) || 0);
    if (!num || typeof core?.centerOnPageDivider !== 'function') {
      S.lastActivePageNum = 0;
      return false;
    }

    const why = String(reason || '').trim();
    const shouldSmooth = !why.startsWith('scroll');
    const shouldRecenter = (
      num !== Number(S.lastActivePageNum || 0)
      || why.includes('pagechanged')
      || why.includes('page-divider')
      || why.includes('settled')
      || why.includes('boot')
      || why.includes('rebuild')
      || why.includes('resize')
    );
    S.lastActivePageNum = num;
    if (!shouldRecenter) return false;

    try { return !!core.centerOnPageDivider(num, { smooth: shouldSmooth }); } catch (e) {
      derr('sync:centerOnPageDivider', e);
      return false;
    }
  }

  function diagAssertNoMainHelpers() {
    const diag = getDiag();
    if (!diag) return;
    const names = [
      ['setActive', 'MiniMapButton'].join(''),
      ['center', 'MiniMapOnId'].join(''),
      ['updateActive', 'MiniMapBtn'].join(''),
      ['updateCounter', 'ToId'].join(''),
      ['updateToggleColor', 'ById'].join(''),
    ];
    try {
      const present = names.filter((n) => typeof TOPW?.[n] === 'function');
      if (present.length) diag.log?.('engine:assert-main-helpers-present', { names: present });
    } catch {}
  }

  function markPlugin() {
    try { TOPW.H2O_MM_ENGINE_PLUGIN = true; } catch {}
    try { TOPW.H2O_MM_ENGINE_VER = ENGINE_VER; } catch {}
  }

  function markReady(ready) {
    try { TOPW.H2O_MM_ENGINE_READY = !!ready; } catch {}
  }

  function getRegs() {
    const SH = TOPW.H2O_MM_SHARED?.get?.();
    const SEL = SH?.SEL_ || SH?.registries?.SEL || W?.H2O?.SEL || {};
    const EV = SH?.EV_ || SH?.registries?.EV || W?.H2O?.EV || {};
    return { SEL, EV };
  }

  function q(sel, root = document) {
    try { return sel ? root.querySelector(sel) : null; } catch { return null; }
  }

  function qq(sel, root = document) {
    try { return sel ? Array.from(root.querySelectorAll(sel)) : []; } catch { return []; }
  }

  function markPerfFullScan() {
    S.perfFullScanTick = Number(S.perfFullScanTick || 0) + 1;
  }

  function answersSelector() {
    const { SEL } = getRegs();
    return SEL.ANSWER || STUDIO_SEL.sel.assistantTurnTagged;
  }

  function conversationTurnSelector() {
    return STUDIO_SEL.sel.conversationTurnLoose;
  }

  function getViewportScrollRoot() {
    const direct = document.querySelector?.('[data-scroll-root="1"]');
    return direct || window;
  }

  function getViewportAnchorY() {
    const root = getViewportScrollRoot();
    if (!root || root === window) {
      return {
        anchorY: 120,
        turnAnchorY: Math.max(0, Math.floor(window.innerHeight * 0.22)),
      };
    }
    try {
      const rect = root.getBoundingClientRect();
      const rootHeight = Math.max(0, Number(root.clientHeight || rect.height || 0));
      const top = Number(rect.top || 0);
      return {
        anchorY: Math.round(top + Math.min(120, Math.max(56, rootHeight * 0.16))),
        turnAnchorY: Math.round(top + Math.max(56, rootHeight * 0.22)),
      };
    } catch {
      return {
        anchorY: 120,
        turnAnchorY: Math.max(0, Math.floor(window.innerHeight * 0.22)),
      };
    }
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

  function normalizeBootMode(raw) {
    const mode = String(raw || '').trim().toLowerCase();
    if (mode === BOOT_MODE_CACHE_FIRST) return BOOT_MODE_CACHE_FIRST;
    if (mode === BOOT_MODE_REBUILD_FIRST) return BOOT_MODE_REBUILD_FIRST;
    return BOOT_MODE_REBUILD_FIRST;
  }

  function getBootMode() {
    try {
      const viaUi = MM_ui()?.getBootMode?.();
      if (viaUi != null) return normalizeBootMode(viaUi);
    } catch {}
    return BOOT_MODE_REBUILD_FIRST;
  }

  function currentViewMode() {
    try {
      const mode = TOPW.H2O_MM_SHARED?.get?.()?.api?.views?.getMode?.();
      return String(mode || '').trim();
    } catch {
      return '';
    }
  }

  function mmBtnSelector() {
    const { SEL } = getRegs();
    return SEL.MM_BTN
      || '[data-cgxui="mnmp-btn"], [data-cgxui="mm-btn"], [data-cgxui="mnmp-qbtn"], [data-cgxui="mm-qbtn"]';
  }

  function activeBtnSelector() {
    const { SEL } = getRegs();
    return SEL.MM_BTN_ACTIVE || '[data-cgxui="mnmp-btn"][data-cgxui-state~="active"], [data-cgxui="mm-btn"][data-cgxui-state~="active"], .cgxui-mm-btn.active';
  }

  function btnClassName() {
    return 'cgxui-mm-btn';
  }

  function wrapClassName() {
    return 'cgxui-mm-wrap';
  }

  function convContainer() {
    const { SEL } = getRegs();
    return q(SEL.CONV_TURNS) || q(SEL.MAIN) || document.body;
  }

  function formEl() {
    const { SEL } = getRegs();
    return q(SEL.FORM);
  }

  function minimapPanel() {
    try {
      const { panel } = MM_uiRefs();
      if (panel && panel.isConnected) return panel;
    } catch {}
    const { SEL } = getRegs();
    return q(SEL.MINIMAP) || q(SEL.PANEL) || q('[data-cgxui$="minimap"]');
  }

  function minimapCol() {
    try {
      const { col } = MM_uiRefs();
      if (col && col.isConnected) return col;
    } catch {}
    const { SEL } = getRegs();
    return q(SEL.MM_COL) || q('[data-cgxui="mm-col"]') || q('.cgxui-mm-col');
  }

  function ensureCol() {
    const panel = minimapPanel();
    if (!panel) return null;

    let col = minimapCol();
    if (col) return col;

    col = document.createElement('div');
    col.className = 'cgxui-mm-col';
    col.setAttribute('data-cgxui-owner', 'mnmp');
    col.setAttribute('data-cgxui', 'mm-col');
    panel.appendChild(col);
    return col;
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

  function selectMiniBtnById(id) {
    const key = String(id || '').trim();
    if (!key) return null;
    try {
      const esc = (window.CSS?.escape) ? CSS.escape(key) : key.replace(/"/g, '\\"');
      return q(`[data-cgxui="mnmp-btn"][data-id="${esc}"]`)
        || q(`[data-cgxui="mnmp-btn"][data-turn-id="${esc}"]`)
        || q(`[data-cgxui="mnmp-btn"][data-primary-a-id="${esc}"]`)
        || q(`[data-cgxui="mm-btn"][data-id="${esc}"]`)
        || q(`[data-cgxui="mm-btn"][data-turn-id="${esc}"]`)
        || q(`[data-cgxui="mm-btn"][data-primary-a-id="${esc}"]`)
        || null;
    } catch {
      return null;
    }
  }

  function internalSetActiveClass(btnId, opts = null) {
    const id = String(btnId || '').trim();
    if (!id) return false;
    const scanTick0 = Number(S.perfFullScanTick || 0);
    // Invariant: regular runtime uses Core.setActive; local fallback is repair-only.
    const core = MM_core();
    if (core && typeof core.setActive === 'function') {
      try { core.setActive(id, 'engine'); } catch {}
      S.lastActiveTurnId = id;
      S.lastActiveBtnId = id;
      try { S.lastActiveBtnEl = core.getBtnById?.(id) || S.lastActiveBtnEl || null; } catch {}
      if (PERF_ASSERT_ON) console.assert(scanTick0 === Number(S.perfFullScanTick || 0), '[MiniMap] Active path must be O(1) — no full scans');
      return true;
    }
    if (!opts?.repair) return false;
    const nextBtn = findBtnById(id, { repair: true });
    if (!nextBtn) return false;
    let prevBtn = findBtnById(S.lastActiveBtnId || S.lastActiveTurnId, { repair: true });
    if (!prevBtn || !prevBtn.isConnected) prevBtn = q(activeBtnSelector());
    if (prevBtn && prevBtn !== nextBtn) {
      prevBtn.classList.remove('active', 'inview');
      setStateToken(prevBtn, 'active', false);
      setStateToken(prevBtn, 'inview', false);
      prevBtn.removeAttribute('data-cgxui-inview');
    }
    nextBtn.classList.add('active', 'inview');
    setStateToken(nextBtn, 'active', true);
    setStateToken(nextBtn, 'inview', true);
    nextBtn.setAttribute('data-cgxui-inview', '1');
    S.lastActiveTurnId = id;
    S.lastActiveBtnId = id;
    S.lastActiveBtnEl = nextBtn;
    if (PERF_ASSERT_ON) console.assert(scanTick0 === Number(S.perfFullScanTick || 0), '[MiniMap] Active path must be O(1) — no full scans');
    return true;
  }

  function normalizeNavId(raw) {
    return String(raw || '').replace(/^conversation-turn-/, '').trim();
  }

  function buildIdVariants(...inputs) {
    const out = new Set();
    const push = (raw) => {
      const id = normalizeNavId(raw);
      if (!id) return;

      out.add(id);

      if (id.startsWith('turn:a:')) {
        const bare = normalizeNavId(id.slice(7));
        if (bare) {
          out.add(bare);
          out.add(`turn:${bare}`);
        }
        return;
      }

      if (id.startsWith('turn:')) {
        const bare = normalizeNavId(id.slice(5));
        if (bare) out.add(bare);
        return;
      }

      out.add(`turn:${id}`);
    };

    for (const value of inputs.flat(Infinity)) push(value);
    return Array.from(out);
  }

  function normalizeAssistantEl(el) {
    if (!el) return null;
    try {
      const role = String(el.getAttribute?.('data-message-author-role') || '').toLowerCase();
      if (role === 'assistant') return el;
    } catch {}
    try {
      const nested = el.querySelector?.(STUDIO_SEL.sel.assistantTurn);
      if (nested) return nested;
    } catch {}
    try {
      const up = el.closest?.(STUDIO_SEL.sel.assistantTurn);
      if (up) return up;
    } catch {}
    return el;
  }

  function normalizeQuestionEl(el) {
    if (!el) return null;
    try {
      const role = String(el.getAttribute?.('data-message-author-role') || '').toLowerCase();
      if (role === 'user') return el;
    } catch {}
    try {
      const nested = el.querySelector?.(STUDIO_SEL.sel.userTurn);
      if (nested) return nested;
    } catch {}
    try {
      const up = el.closest?.(STUDIO_SEL.sel.userTurn);
      if (up) return up;
    } catch {}
    return null;
  }

  function getTurnHostEl(el) {
    if (!el) return null;
    try {
      return el.closest?.('[data-testid="conversation-turn"], [data-testid^="conversation-turn"]') || null;
    } catch {
      return null;
    }
  }

  function collectResolvedNodeIds(node) {
    const out = new Set();
    const push = (raw) => {
      for (const variant of buildIdVariants(raw)) out.add(variant);
    };
    if (!node) return out;

    const turnHost = getTurnHostEl(node);
    const assistantEl = normalizeAssistantEl(node);
    const questionEl = normalizeQuestionEl(node);
    const candidates = [node, turnHost, assistantEl, questionEl];

    for (const candidate of candidates) {
      if (!candidate) continue;
      push(candidate.getAttribute?.('data-turn-id'));
      push(candidate.getAttribute?.('data-message-id'));
      push(candidate.getAttribute?.('data-cgxui-id'));
      push(candidate.getAttribute?.('data-h2o-ans-id'));
      push(candidate.getAttribute?.('data-h2o-core-id'));
      push(candidate?.dataset?.turnId);
      push(candidate?.dataset?.messageId);
    }

    return out;
  }

  function isResolvedOnRequestedPage(node, ctx) {
    if (!node?.isConnected) return false;

    const expectedPageIndex = Number(ctx?.pageInfo?.pageIndex);
    if (!Number.isFinite(expectedPageIndex)) return true;

    const api = getPaginationApi();
    if (typeof api?.getPageInfo !== 'function') return true;
    try {
      return Number(api.getPageInfo()?.pageIndex ?? -1) === expectedPageIndex;
    } catch {
      return false;
    }
  }

  function MINI_isResolvedTargetElement(node, ctx, surface = 'answer') {
    const target = MINI_getCanonicalTargetCtx(ctx, surface);
    if (!node?.isConnected) return false;
    if (!isResolvedOnRequestedPage(node, target)) return false;

    const expectedTurnHost =
      (target?.pageInfo?.targetTurnHost?.isConnected ? target.pageInfo.targetTurnHost : null)
      || getTurnHostEl(target?.pageInfo?.targetHost || target?.pageInfo?.targetAnswerHost || null);
    const expectedAnswerHost = normalizeAssistantEl(
      target?.pageInfo?.targetAnswerHost || target?.pageInfo?.targetHost || target?.pageInfo?.targetTurnHost || null,
    );
    const expectedQuestionEl = normalizeQuestionEl(target?.pageInfo?.targetTurnHost || target?.pageInfo?.targetHost || null);
    const nodeTurnHost = getTurnHostEl(node);

    if (expectedTurnHost && nodeTurnHost && expectedTurnHost !== nodeTurnHost) return false;

    if (surface === 'answer' && expectedAnswerHost) {
      if (normalizeAssistantEl(node) !== expectedAnswerHost) return false;
    }

    if (surface === 'question' && expectedQuestionEl) {
      const qNode = normalizeQuestionEl(node);
      if (qNode) return qNode === expectedQuestionEl;

      const aNode = normalizeAssistantEl(node);
      if (!aNode || !expectedTurnHost || getTurnHostEl(aNode) !== expectedTurnHost) return false;
    }

    const wantedIds = new Set(buildIdVariants(
      target.turnId,
      target.answerId,
      target.questionId,
      target.canonicalId,
      target.id,
      target?.pageInfo?.turnId,
      target?.pageInfo?.answerId,
    ));

    if (!wantedIds.size) return true;

    for (const gotId of collectResolvedNodeIds(node)) {
      if (wantedIds.has(gotId)) return true;
    }

    return !!expectedTurnHost && nodeTurnHost === expectedTurnHost;
  }

  function getPaginationApi() {
    const api = W.H2O_Pagination;
    return api && typeof api === 'object' ? api : null;
  }

  function getPaginationState() {
    try {
      return W?.H2O?.PW?.pgnwndw?.state || W?.H2O_Pagination?.state || null;
    } catch {
      return null;
    }
  }

  function getPaginationCanonicalTurnByIndex(turnIdx = 0) {
    // turnIdx is now the Core paired turnNo (1..N counting all Q+A pairs),
    // matching what MiniMap buttons store after the buildCanonicalTurnCollection fix.
    const idx = Math.max(1, Number(turnIdx || 0) || 0);
    if (!idx) return null;
    try {
      const ps = getPaginationState();
      const answers = Array.isArray(ps?.masterAnswers) ? ps.masterAnswers : [];
      const turns = Array.isArray(ps?.masterTurns) ? ps.masterTurns : [];
      const rt = W?.H2O?.turnRuntime || null;

      // Primary path: find the masterAnswers entry whose answerId maps to
      // Core turnNo === idx. Correctly handles unanswered-turn gaps because
      // Core turnNo counts all pairs including unanswered ones.
      let answer = null;
      if (rt && typeof rt.getTurnRecordByAId === 'function') {
        answer = answers.find((row) => {
          const aId = String(row?.answerId || row?.primaryAId || row?.aId || '').trim();
          if (!aId) return false;
          try {
            const coreRecord = rt.getTurnRecordByAId(aId);
            return Math.max(0, Number(coreRecord?.turnNo || coreRecord?.idx || 0) || 0) === idx;
          } catch { return false; }
        }) || null;
      }

      // Fallback: direct answerIndex lookup (works when no unanswered gaps before this answer).
      if (!answer) {
        answer = answers[idx - 1] || answers.find((row) => {
          return Math.max(0, Number(row?.answerIndex || 0) || 0) === idx;
        }) || null;
      }

      // Resolve the paired turn node.
      let rawTurn = null;
      if (answer) {
        const turnIndex = Number(answer?.turnIndex ?? -1);
        if (Number.isFinite(turnIndex) && turnIndex >= 0) {
          rawTurn = turns[turnIndex] || null;
        }
        if (!rawTurn) {
          rawTurn = turns.find((row) => {
            return row?.turnId === answer?.turnId
              || row?.uid === answer?.turnUid
              || row?.gid === answer?.gid;
          }) || null;
        }
      }

      if (!rawTurn && !answer) return null;
      return {
        turnId: normalizeNavId(rawTurn?.turnId || answer?.turnId || rawTurn?.id || ''),
        answerId: normalizeNavId(answer?.answerId || answer?.primaryAId || answer?.aId || rawTurn?.answerId || ''),
        questionId: normalizeNavId(rawTurn?.qId || answer?.qId || rawTurn?.questionId || answer?.questionId || ''),
        turn: rawTurn || answer || null,
      };
    } catch {
      return null;
    }
  }

  function getUnmountApi() {
    return W?.H2O?.UM?.nmntmssgs?.api || null;
  }

  function isPaginationEnabled() {
    const api = getPaginationApi();
    if (!api || typeof api.getPageInfo !== 'function') return false;
    try { return api.getPageInfo()?.enabled !== false; } catch { return false; }
  }

  function isUnmountEnabled() {
    const api = getUnmountApi();
    if (!api || typeof api.getConfig !== 'function') return false;
    try { return api.getConfig()?.enabled !== false; } catch { return false; }
  }

  function isVirtualizedConversation() {
    return isPaginationEnabled() || isUnmountEnabled();
  }

  function resolveTurnRecord(anyId, primaryAId = '') {
    const key = normalizeNavId(anyId);
    const aId = normalizeNavId(primaryAId);
    if (!key && !aId) return null;

    const candidateSet = new Set(buildIdVariants(
      key,
      aId,
      aId ? `turn:a:${aId}` : '',
    ));
    const core = getCoreSurface();
    let turn = null;

    for (const candidate of candidateSet) {
      if (!candidate || turn) continue;
      try { turn = core?.getTurnById?.(candidate) || null; } catch {}
    }

    if (!turn && core && typeof core.getTurnList === 'function') {
      try {
        const list = core.getTurnList() || [];
        turn = list.find((row) => {
          const rowIds = buildIdVariants(
            row?.turnId,
            row?.answerId,
            row?.primaryAId,
            row?.qId,
            row?.turnUid,
            row?.primaryAId ? `turn:a:${row.primaryAId}` : '',
          );
          return rowIds.some((rowId) => candidateSet.has(rowId));
        }) || null;
      } catch {}
    }

    return turn;
  }

  function findTurnHostById(anyId) {
    const variants = buildIdVariants(anyId);
    for (const variant of variants) {
      if (!variant) continue;
      try {
        const esc = (window.CSS?.escape) ? CSS.escape(variant) : variant.replace(/"/g, '\\"');
        const el = q(`[data-turn-id="${esc}"]`);
        if (!el) continue;
        return el.closest?.('[data-testid="conversation-turn"], [data-testid^="conversation-turn"]') || el;
      } catch {}
    }
    return null;
  }

  function findAnswerById(answerId) {
    const id = normalizeNavId(answerId);
    if (!id) return null;
    const variants = buildIdVariants(id, `turn:a:${id}`);
    try {
      for (const variant of variants) {
        if (!variant) continue;
        const esc = (window.CSS?.escape) ? CSS.escape(variant) : variant.replace(/"/g, '\\"');
        const el = q(`[data-message-id="${esc}"]`) ||
          q(`[data-cgxui-id="${esc}"]`) ||
          q(`[data-h2o-ans-id="${esc}"]`) ||
          q(`[data-h2o-core-id="${esc}"]`) ||
          q(`[data-turn-id="${esc}"]`);
        if (el) return normalizeAssistantEl(el);
      }
      return null;
    } catch {
      return null;
    }
  }

  function resolveAnswerTarget(anyId, primaryAId = '', turnIdxHint = 0) {
    const key = normalizeNavId(anyId);
    const aId = normalizeNavId(primaryAId);
    const t = resolveTurnRecord(key, aId);
    const answerId = normalizeNavId(t?.answerId || t?.primaryAId || aId || '');
    const turnId = normalizeNavId(t?.turnId || key || '');
    const direct = (
      normalizeAssistantEl(t?.primaryAEl) ||
      findAnswerById(answerId || turnId || key) ||
      normalizeAssistantEl(findTurnHostById(turnId || key)) ||
      normalizeAssistantEl(t?.el) ||
      normalizeAssistantEl(t?.qEl)
    );
    if (direct) return direct;

    if (isVirtualizedConversation()) return null;

    // Fallback: resolve by turn index to the Nth assistant answer in DOM order.
    let idx = Number(t?.index || t?.idx || turnIdxHint || 0);
    const core = getCoreSurface();
    if (!idx && core && typeof core.getTurnIndex === 'function') {
      try { idx = Number(core.getTurnIndex(key) || 0); } catch {}
    }
    if (idx > 0) {
      const escIdx = String(idx);
      const byStampedTurn = q(
        `${conversationTurnSelector()}[data-turn-idx="${escIdx}"] [data-message-author-role="assistant"], ` +
        `${conversationTurnSelector()} [data-message-author-role="assistant"][data-turn-idx="${escIdx}"]`
      );
      if (byStampedTurn) return byStampedTurn;
      markPerfFullScan();
      const answers = qq(answersSelector());
      const byStampedAnswer = answers.find((el) => {
        try {
          const elIdx = Math.max(
            0,
            Number(
              el?.dataset?.turnIdx
              || el.closest?.(conversationTurnSelector())?.dataset?.turnIdx
              || 0
            ) || 0
          );
          return elIdx === idx;
        } catch {
          return false;
        }
      }) || null;
      if (byStampedAnswer) return byStampedAnswer;
      const el = answers[idx - 1] || null;
      if (el) return el;
    }
    return null;
  }

  function resolveQuestionTarget(anyId, primaryAId = '') {
    const key = normalizeNavId(anyId);
    const aId = normalizeNavId(primaryAId);
    const t = resolveTurnRecord(key, aId);
    const turnId = normalizeNavId(t?.turnId || key || '');

    const qDirect =
      normalizeQuestionEl(t?.qEl) ||
      normalizeQuestionEl(findTurnHostById(turnId || key));
    if (qDirect) return qDirect;

    // Fallback: from the answer, pick the closest previous user message.
    const ans = resolveAnswerTarget(key, aId, Number(t?.idx || t?.index || 0));
    if (ans) {
      try {
        const turnHost = ans.closest?.(conversationTurnSelector());
        const qInTurn = normalizeQuestionEl(turnHost?.querySelector?.(STUDIO_SEL.sel.userTurn));
        if (qInTurn) return qInTurn;
      } catch {}
      try {
        let cur = ans.previousElementSibling;
        while (cur) {
          const q = normalizeQuestionEl(cur);
          if (q) return q;
          cur = cur.previousElementSibling;
        }
      } catch {}
      try {
        const host = ans.closest?.('[data-testid^="conversation-turn"]') || ans.parentElement;
        const q = host?.querySelector?.(STUDIO_SEL.sel.userTurn);
        if (q) return q;
      } catch {}
      try {
        const users = qq(STUDIO_SEL.sel.userTurn);
        let best = null;
        for (const u of users) {
          if (!u?.isConnected) continue;
          const rel = u.compareDocumentPosition(ans);
          if (!(rel & Node.DOCUMENT_POSITION_FOLLOWING)) continue;
          if (!best || (best.compareDocumentPosition(u) & Node.DOCUMENT_POSITION_FOLLOWING)) best = u;
        }
        const q = normalizeQuestionEl(best);
        if (q) return q;
      } catch {}
    }

    if (isVirtualizedConversation()) return null;

    // Index-based fallback when turn payload lacks qEl.
    try {
      const core2 = getCoreSurface();
      let idx = Number(t?.idx || t?.index || 0);
      if (!idx && core2 && typeof core2.getTurnIndex === 'function') {
        idx = Number(core2.getTurnIndex(key) || 0);
      }
      if (idx > 0) {
        const turnHosts = qq(conversationTurnSelector());
        const host = turnHosts[idx - 1] || null;
        const q = normalizeQuestionEl(host?.querySelector?.(STUDIO_SEL.sel.userTurn));
        if (q) return q;
      }
    } catch {}
    if (ans) {
      try {
        const ar = ans.getBoundingClientRect();
        const users = qq(STUDIO_SEL.sel.userTurn);
        const near = users.find((u) => {
          const ur = u.getBoundingClientRect();
          return ur.top <= ar.top && (ar.top - ur.top) < 1400;
        }) || null;
        const q = normalizeQuestionEl(near);
        if (q) return q;
      } catch {}
    }
    return null;
  }

  function dispatchMountRequest(msgId, source = 'mnmp-engine') {
    const id = normalizeNavId(msgId);
    if (!id) return false;
    try {
      const api = getUnmountApi();
      if (typeof api?.requestMountByUid === 'function') {
        return api.requestMountByUid(id, String(source || 'mnmp-engine')) !== false;
      }
    } catch {}
    try {
      window.dispatchEvent(new CustomEvent(EVT_MSG_MOUNT_REQUEST, {
        detail: { msgId: id, id, source: String(source || 'mnmp-engine') },
      }));
      return true;
    } catch {
      return false;
    }
  }

  function waitForRemountByMsgId(msgId, timeoutMs = 1200) {
    const id = String(msgId || '').trim();
    if (!id) return Promise.resolve(false);
    const maxWaitMs = Math.max(120, Number(timeoutMs || 1200) || 1200);
    return new Promise((resolve) => {
      let done = false;
      let rafId = 0;
      let timerId = 0;
      const start = performance.now();

      const finish = (ok) => {
        if (done) return;
        done = true;
        try { if (rafId) cancelAnimationFrame(rafId); } catch {}
        try { if (timerId) clearTimeout(timerId); } catch {}
        try { window.removeEventListener(EVT_MSG_REMOUNTED, onRemounted, true); } catch {}
        try { window.removeEventListener(EVT_MSG_REMOUNTED_ALIAS, onRemounted, true); } catch {}
        resolve(!!ok);
      };

      const matchesMsg = (detail) => {
        const got = String(detail?.msgId || detail?.id || detail?.answerId || '').trim();
        if (!got) return false;
        return got === id || got === `turn:${id}` || `turn:${got}` === id;
      };

      const onRemounted = (e) => {
        if (!matchesMsg(e?.detail)) return;
        finish(true);
      };

      const poll = () => {
        if (findAnswerById(id)) {
          finish(true);
          return;
        }
        if ((performance.now() - start) >= maxWaitMs) {
          finish(false);
          return;
        }
        rafId = requestAnimationFrame(poll);
      };

      try { window.addEventListener(EVT_MSG_REMOUNTED, onRemounted, true); } catch {}
      try { window.addEventListener(EVT_MSG_REMOUNTED_ALIAS, onRemounted, true); } catch {}
      timerId = setTimeout(() => finish(!!findAnswerById(id)), maxWaitMs + 20);
      rafId = requestAnimationFrame(poll);
    });
  }

  function MINI_getCanonicalTargetCtx(ctx, surface = 'answer') {
    const turn = ctx?.turn || resolveTurnRecord(ctx?.turnId || ctx?.id || '', ctx?.answerId || '');
    const turnId = normalizeNavId(turn?.turnId || ctx?.turnId || ctx?.id || '');
    const answerId = normalizeNavId(turn?.answerId || turn?.primaryAId || ctx?.answerId || '');
    const questionId = normalizeNavId(turn?.qId || turn?.questionId || '');
    const canonicalId = normalizeNavId(
      surface === 'question'
        ? (questionId || turnId || answerId || ctx?.id || '')
        : (answerId || turnId || ctx?.id || ''),
    );

    return {
      ...(ctx || {}),
      turn,
      turnId,
      answerId,
      questionId,
      canonicalId,
      surface,
    };
  }

  async function MINI_materializeTarget(ctx, surface = 'answer') {
    const next = MINI_getCanonicalTargetCtx(ctx, surface);
    const requestId = normalizeNavId(next.canonicalId || next.answerId || next.turnId || next.id || '');

    if (isPaginationEnabled()) {
      const api = getPaginationApi();
      if (typeof api?.ensureVisibleById === 'function' && requestId) {
        try {
          const pageInfo = await api.ensureVisibleById(requestId, {
            reason: `minimap:${surface}:${String(next?.gesture || 'click')}`,
            restoreAnchor: false,
            timeoutMs: 1400,
          });
          next.pageInfo = pageInfo || null;
          if (pageInfo?.turn) next.turn = pageInfo.turn;
          if (pageInfo?.turnId) next.turnId = normalizeNavId(pageInfo.turnId);
          if (pageInfo?.answerId) next.answerId = normalizeNavId(pageInfo.answerId);
          if (pageInfo?.turn?.qId && !next.questionId) next.questionId = normalizeNavId(pageInfo.turn.qId);
        } catch (e) {
          derr('turn:materialize:pagination', e);
        }
      }
    }

    const mountId = normalizeNavId(next.answerId || next.canonicalId || next.turnId || requestId);
    if (isUnmountEnabled() && mountId) {
      try {
        const api = getUnmountApi();
        if (typeof api?.requestMountByUid === 'function') api.requestMountByUid(mountId, `mnmp-engine:${surface}`);
        else dispatchMountRequest(mountId, `mnmp-engine:${surface}`);
      } catch (e) {
        derr('turn:materialize:unmount', e);
        dispatchMountRequest(mountId, `mnmp-engine:${surface}`);
      }
    }

    return next;
  }

  function MINI_resolveTargetElement(ctx, surface = 'answer') {
    const target = MINI_getCanonicalTargetCtx(ctx, surface);
    const fromPageInfo = surface === 'question'
      ? (
        normalizeQuestionEl(target?.pageInfo?.targetTurnHost || target?.pageInfo?.targetHost || null)
        || normalizeAssistantEl(target?.pageInfo?.targetAnswerHost || target?.pageInfo?.targetHost || target?.pageInfo?.targetTurnHost || null)
      )
      : normalizeAssistantEl(target?.pageInfo?.targetAnswerHost || target?.pageInfo?.targetHost || target?.pageInfo?.targetTurnHost || null);
    if (MINI_isResolvedTargetElement(fromPageInfo, target, surface)) return fromPageInfo;

    if (surface === 'question') {
      const resolved =
        resolveQuestionTarget(target.questionId || target.turnId || target.canonicalId, target.answerId)
        || resolveAnswerTarget(target.answerId || target.turnId || target.canonicalId, target.answerId, Number(target?.btnEl?.dataset?.turnIdx || 0));
      return MINI_isResolvedTargetElement(resolved, target, surface) ? resolved : null;
    }
    const resolved = resolveAnswerTarget(
      target.answerId || target.canonicalId || target.turnId,
      target.answerId,
      Number(target?.btnEl?.dataset?.turnIdx || 0),
    );
    return MINI_isResolvedTargetElement(resolved, target, surface) ? resolved : null;
  }

  function MINI_waitForResolvedTarget(ctx, surface = 'answer', timeoutMs = 1400) {
    const maxWaitMs = Math.max(120, Number(timeoutMs || 1400) || 1400);
    return new Promise((resolve) => {
      const t0 = performance.now();

      const tick = () => {
        const target = MINI_resolveTargetElement(ctx, surface);
        if (target) {
          resolve(target);
          return;
        }
        if ((performance.now() - t0) >= maxWaitMs) {
          resolve(null);
          return;
        }
        requestAnimationFrame(tick);
      };

      requestAnimationFrame(tick);
    });
  }

  // Reader navigation uses the current Semantic Index. Core still owns paired
  // membership and button/page metadata; no transcript query or materialization
  // is needed for the current, fully mounted Reader render.
  function MINI_navigateReaderTarget(ctx, surface = 'answer', options = null) {
    const studio = W.H2O?.Studio;
    const navigation = studio?.readerNavigation;
    if (!navigation) return null; // Reader API not installed (empty boot).
    const root = W.H2O?.studioHost?.getReaderRoot?.();
    const index = studio.getReaderSemanticIndex(root);
    if (!root?.isConnected || !index) return false;
    const core = getCoreSurface();
    const turn = ctx?.turn || core?.getTurnById?.(ctx?.turnId || ctx?.id) || null;
    const answerEl = turn?.el || turn?.primaryAEl || turn?.live?.primaryAEl;
    // A retained Core record from another render must not acquire a new target
    // just because that render reused the same source ID.
    const answerTarget = navigation.targetForElement(answerEl);
    if (answerEl && (!answerTarget || answerTarget.currentRendererRoot !== root)) return false;
    let target = answerTarget;
    if (surface === 'question') {
      const paired = W.H2O?.turnRuntime?.getTurnRecordByAId?.(turn?.answerId || turn?.primaryAId);
      const questionEl = turn?.questionEl || turn?.qEl || turn?.live?.qEl || paired?.live?.qEl;
      const questionId = ctx?.questionId || turn?.questionId || turn?.qId || paired?.qId;
      // An unanswered turn may supply only its authoritative question element.
      // Source-ID lookup requires a proven current answer, never a stale element.
      const message = !questionEl && answerTarget && questionId
        ? index.messages().find(record => record.sourceRef?.messageId === questionId) : null;
      target = navigation.targetForElement(questionEl || message?.target);
    }
    if (!target || target.currentRendererRoot !== root || !navigation.goTo(target, options)) return false;
    setActiveTurnId(ctx?.turnId || ctx?.id || turn?.turnId, 'reader:' + surface, { skipPageScroll: true });
    return true;
  }

  function MINI_scrollToResolvedTarget(target, ctx, surface = 'answer') {
    if (!target) return false;
    scrollPageToTarget(target, true, 'center');
    if (surface === 'question') {
      let flashed = false;
      try { flashed = !!MM_core()?.applyTempFlash?.(target, { surface: 'question' }); } catch {}
      if (!flashed) {
        try { W.applyTempFlash?.(target, { surface: 'question' }); } catch {}
      }
    } else {
      let flashed = false;
      try { flashed = !!MM_core()?.flashAnswer?.(target); } catch {}
      if (!flashed) {
        try { flashed = !!W.flashAnswer?.(target); } catch {}
      }
      if (!flashed) {
        try { W.applyTempFlash?.(target); } catch {}
      }
    }
    setActiveTurnId(
      ctx?.turnId || ctx?.id || ctx?.answerId || ctx?.canonicalId || '',
      `turn:${ctx?.gesture || 'click'}:${surface}`,
      { skipPageScroll: true },
    );
    return true;
  }

  function MINI_navigateTurnTarget(ctx, surface = 'answer') {
    const immediateCtx = MINI_getCanonicalTargetCtx(ctx, surface);
    const immediate = MINI_resolveTargetElement(immediateCtx, surface);
    if (immediate) return Promise.resolve({ ctx: immediateCtx, target: immediate, materialized: false });

    return MINI_materializeTarget(immediateCtx, surface).then(async (materializedCtx) => {
      const waitMs = isVirtualizedConversation() ? 1600 : 480;
      const target = await MINI_waitForResolvedTarget(materializedCtx, surface, waitMs);
      return { ctx: materializedCtx, target, materialized: true };
    });
  }

  function scrollPageToTarget(target, smooth = true, block = 'center') {
    if (!target || !target.isConnected) return false;
    const findScrollableAncestors = (el) => {
      const out = [];
      let cur = el?.parentElement || null;
      while (cur && cur !== document.body && cur !== document.documentElement) {
        try {
          const cs = getComputedStyle(cur);
          const oy = String(cs?.overflowY || '');
          const canScroll = (oy === 'auto' || oy === 'scroll' || oy === 'overlay') && cur.scrollHeight > cur.clientHeight + 4;
          if (canScroll) out.push(cur);
        } catch {}
        cur = cur.parentElement;
      }
      return out;
    };
    const ancestors = findScrollableAncestors(target).filter((el) => !el.closest?.('[data-cgxui-owner="mnmp"]'));
    const byScrollRoot = ancestors.find((el) => el.hasAttribute?.('data-scroll-root')) || null;
    const byTall = ancestors.filter((el) => (el.clientHeight || 0) >= Math.max(240, Math.floor(window.innerHeight * 0.45)));
    const host = byScrollRoot || byTall[byTall.length - 1] || ancestors[ancestors.length - 1] || null;
    try {
      if (host && host !== target) {
        const before = host.scrollTop;
        const hr = host.getBoundingClientRect();
        const tr = target.getBoundingClientRect();
        const topInHost = (tr.top - hr.top) + host.scrollTop;
        const targetCenter = topInHost - ((host.clientHeight - tr.height) * (block === 'start' ? 0.08 : 0.5));
        const desiredTop = Math.max(0, Math.floor(targetCenter));
        host.scrollTo({ top: desiredTop, behavior: smooth ? 'smooth' : 'auto' });
        // Keep smooth behavior smooth; force set only for non-smooth paths.
        if (!smooth) {
          setTimeout(() => {
            try {
              if (Math.abs((host.scrollTop || 0) - desiredTop) > 2) host.scrollTop = desiredTop;
            } catch {}
          }, 0);
        }
        if (Math.abs(host.scrollTop - before) > 1) return true;
        if (!smooth) {
          try { host.scrollTop = desiredTop; } catch {}
          if (Math.abs(host.scrollTop - before) > 1) return true;
        }
        return true;
      }
    } catch {}
    try {
      target.scrollIntoView?.({ behavior: smooth ? 'smooth' : 'auto', block });
      return true;
    } catch {}
    try {
      const top = Math.max(0, (target.getBoundingClientRect().top + (window.scrollY || 0)) - 120);
      window.scrollTo({ top, behavior: smooth ? 'smooth' : 'auto' });
      return true;
    } catch {
      return false;
    }
  }

  function resetVisibleAnswersObserver() {
    try { S.io?.disconnect?.(); } catch {}
    S.io = null;
    S.ioObserved.clear();
    S.visibleSet.clear();
  }

  function ensureVisibleAnswersObserver() {
    if (S.io) return S.io;
    if (typeof IntersectionObserver !== 'function') {
      S.io = null;
      return null;
    }
    S.io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (e.isIntersecting) S.visibleSet.add(e.target);
        else S.visibleSet.delete(e.target);
      }
    }, { root: null, rootMargin: '-120px 0px -40px 0px', threshold: 0 });
    return S.io;
  }

  function pruneObservedAnswers() {
    if (!S.ioObserved.size) return 0;
    const io = S.io;
    let removed = 0;
    for (const el of Array.from(S.ioObserved)) {
      if (el?.isConnected) continue;
      removed += 1;
      try { io?.unobserve?.(el); } catch {}
      S.ioObserved.delete(el);
      S.visibleSet.delete(el);
    }
    return removed;
  }

  function observeVisibleAnswers(answers, opts = {}) {
    if (opts?.reset) resetVisibleAnswersObserver();
    const io = ensureVisibleAnswersObserver();
    if (!io) return;
    const list = (Array.isArray(answers) ? answers : []).filter((el) => !!el && el.isConnected);
    if (opts?.incremental) {
      for (const el of list) {
        if (S.ioObserved.has(el)) continue;
        try { io.observe(el); } catch {}
        S.ioObserved.add(el);
      }
      if (opts?.prune) pruneObservedAnswers();
      return;
    }
    const next = new Set(list);
    for (const el of Array.from(S.ioObserved)) {
      if (next.has(el) && el.isConnected) continue;
      try { io.unobserve(el); } catch {}
      S.ioObserved.delete(el);
      S.visibleSet.delete(el);
    }
    for (const el of next) {
      if (S.ioObserved.has(el)) continue;
      try { io.observe(el); } catch {}
      S.ioObserved.add(el);
    }
    if (opts?.prune !== false) pruneObservedAnswers();
  }

  function currentAnswerEls() {
    const core = MM_core();
    try {
      const coreList = core?.getAnswerList?.();
      if (Array.isArray(coreList)) {
        const connected = coreList.filter((el) => !!el && el.isConnected);
        if (connected.length) return connected;
        const anyDomAnswer = q(answersSelector());
        if (!anyDomAnswer) return [];
      }
    } catch {}
    markPerfFullScan();
    return qq(answersSelector());
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

  function ensureChatPageDividerBridgeFromRuntime(force = false) {
    try { MM_core()?.ensureChatPageDividerBridge?.(force); } catch (e) { derr('bridges:chat-page-divider', e); }
  }

  function ensureDelegatedHandlers() {
    if (S.offBtnClick) return;

    const MM = (window.MM = window.MM || {});
    const supportsAuxClick = ('onauxclick' in document);
    const PAGE_DIVIDER_LABEL_SEL = '.cgxui-mm-page-divider-label';
    let lastMidTime = 0;
    let lastMidId = '';
    let midTimer = null;
    let pageClickTimer = null;
    let pendingPageNum = 0;
    let lastTapTs = 0;
    let lastTapId = '';
    let suppressClickUntil = 0;
    let activePointerPerf = null;

    const isQuestionSurfaceBtn = (btn) => {
      if (!btn) return false;
      const ui = String(btn.getAttribute?.('data-cgxui') || '').trim().toLowerCase();
      if (ui === 'mnmp-qbtn' || ui === 'mm-qbtn') return true;
      if (String(btn.dataset?.surfaceRole || '').trim().toLowerCase() === 'question') return true;
      return !!btn.classList?.contains?.('cgxui-mm-qbtn');
    };

    const callWashPalette = (ev, primaryAId, anchorBtnEl = null) => {
      try {
        const SH = TOPW.H2O_MM_SHARED?.get?.();
        if (SH?.util?.mmOpenWashPalette) return !!SH.util.mmOpenWashPalette(ev, primaryAId, anchorBtnEl);
      } catch {}
      try {
        const api = W?.H2O?.MM?.wash;
        if (api && typeof api.openPalette === 'function') {
          api.openPalette(ev, primaryAId, anchorBtnEl);
          return true;
        }
      } catch {}
      return false;
    };

    const openExportMenu = () => {
      const exportBtn =
        document.getElementById('cgxui-xpch-export-btn') ||
        document.querySelector('[data-cgxui="xpch-dl-toggle"][data-cgxui-owner="xpch"]');
      if (exportBtn && typeof exportBtn.click === 'function') {
        try { exportBtn.click(); return true; } catch {}
      }
      return false;
    };

    const getTurn = (turnId) => {
      try { return getCoreSurface()?.getTurnById?.(turnId) || null; } catch { return null; }
    };

    const isOwnedMiniMapBtn = (btn) => {
      if (!btn) return false;
      try {
        const owner = String(btn.getAttribute?.('data-cgxui-owner') || '').trim();
        if (owner === 'mnmp') return true;
      } catch {}
      try {
        const ui = String(btn.getAttribute?.('data-cgxui') || '').trim();
        if (ui === 'mnmp-btn' || ui === 'mm-btn' || ui === 'mnmp-qbtn' || ui === 'mm-qbtn') return true;
      } catch {}
      try {
        if (btn.classList?.contains?.('cgxui-mm-btn')) return true;
        if (btn.classList?.contains?.('cgxui-mm-qbtn')) return true;
      } catch {}
      return false;
    };

    const getEventElement = (target) => {
      if (target instanceof Element) return target;
      const parent = target?.parentElement || target?.parentNode || null;
      return (parent instanceof Element) ? parent : null;
    };

    const pointerPerfState = () => ensureMiniMapEnginePerfStateShape(PERF).pointerDown;

    const pointerPerfRecordBranch = (label, msRaw) => {
      if (!activePointerPerf || !label) return 0;
      const perfBucket = pointerPerfState();
      return recordDuration(ensureDurationBucketMapEntry(perfBucket.branches, label), msRaw);
    };

    const pointerPerfSetActionType = (type) => {
      if (!activePointerPerf) return String(type || '').trim() || 'noOp';
      const next = String(type || '').trim() || 'noOp';
      if (!activePointerPerf.actionType || activePointerPerf.actionType === 'noOp') {
        activePointerPerf.actionType = next;
      }
      return activePointerPerf.actionType;
    };

    const getOwnedPageDividerLabel = (target) => {
      const el = getEventElement(target);
      if (!el?.closest) return null;
      const label = el.closest(PAGE_DIVIDER_LABEL_SEL);
      if (label) {
        try {
          return label.closest?.('.cgxui-mm-page-divider[data-page-num]') ? label : null;
        } catch {}
      }
      const divider = el.closest?.('.cgxui-mm-page-divider[data-page-num]');
      if (!divider) return null;
      try {
        return divider.querySelector?.(PAGE_DIVIDER_LABEL_SEL) || null;
      } catch {}
      return null;
    };

    const isOwnedPageDividerLabel = (label) => {
      if (!label) return false;
      try {
        if (!label.matches?.(PAGE_DIVIDER_LABEL_SEL)) return false;
        return !!label.closest?.('.cgxui-mm-page-divider[data-page-num]');
      } catch {}
      return false;
    };

    const classifyPointerTarget = (target) => {
      const eventEl = getEventElement(target);
      const pageLabel = getOwnedPageDividerLabel(target);
      if (pageLabel && isOwnedPageDividerLabel(pageLabel)) {
        return { targetType: 'pageDividerLabel', pageLabel, btn: null };
      }
      const btn = eventEl?.closest?.(mmBtnSelector()) || null;
      if (btn && isOwnedMiniMapBtn(btn)) {
        return {
          targetType: isQuestionSurfaceBtn(btn) ? 'questionButton' : 'answerButton',
          pageLabel: null,
          btn,
        };
      }
      const ownedSurface = eventEl?.closest?.('[data-cgxui-owner="mnmp"]') || null;
      if (ownedSurface && isMiniMapOwnedNode(ownedSurface)) {
        return { targetType: 'background', pageLabel: null, btn: null };
      }
      return { targetType: 'unknown', pageLabel: null, btn: null };
    };

    const clearPendingPageJump = () => {
      if (pageClickTimer) {
        try { clearTimeout(pageClickTimer); } catch {}
      }
      pageClickTimer = null;
      pendingPageNum = 0;
    };

    const getPageNumFromDividerLabel = (label) => Math.max(1, Number(
      label?.dataset?.pageNum
      || label?.closest?.('.cgxui-mm-page-divider')?.getAttribute?.('data-page-num')
      || 0
    ) || 0);

    const jumpToPageFromDivider = (pageNum, event) => {
      const num = Math.max(1, Number(pageNum || 0) || 0);
      if (!num) return false;

      event?.preventDefault?.();
      event?.stopPropagation?.();
      suppressClickUntil = performance.now() + 260;

      const core = getCoreSurface();
      const firstTurnIdx = Math.max(1, ((pageNum - 1) * 25) + 1);
      const canonical = getPaginationCanonicalTurnByIndex(firstTurnIdx) || null;
      const turn = canonical?.turn || core?.getTurnList?.()?.[firstTurnIdx - 1] || null;
      const targetId = String(canonical?.answerId || canonical?.turnId || turn?.answerId || turn?.turnId || '').trim();
      if (!targetId) return false;
      const readerResult = MINI_navigateReaderTarget({ id: targetId, turnId: turn?.turnId, turn }, 'answer');
      if (readerResult !== null) {
        if (readerResult) {
          core?.centerOnPageDivider?.(num, { smooth: false });
          S.lastActivePageNum = num;
        }
        return readerResult;
      }

      const finishSmoothScroll = async () => {
        const ctx = {
          id: targetId,
          turnId: String(canonical?.turnId || turn?.turnId || '').trim(),
          answerId: String(canonical?.answerId || turn?.answerId || '').trim(),
          questionId: String(canonical?.questionId || turn?.qId || turn?.questionId || '').trim(),
          gesture: 'page-divider',
          btnEl: null,
        };
        const materializedCtx = await MINI_materializeTarget(ctx, 'answer');
        const target = await MINI_waitForResolvedTarget(materializedCtx, 'answer', isVirtualizedConversation() ? 1800 : 600);
        const host = getTurnHostEl(target) || target;
        if (host) {
          try { scrollPageToTarget(host, true, 'start'); } catch {}
          try { getCoreSurface()?.centerOnPageDivider?.(num, { smooth: false }); } catch {}
          S.lastActivePageNum = num;
          return true;
        }
        return false;
      };

      const pw = W.H2O_Pagination;
      if (pw && typeof pw.goToPageStart === 'function') {
        armPageJumpGuard(520, 'page-divider');
        try { pw.goToPageStart(num - 1, 'minimap:page-divider', { smooth: false }); } catch {}
        finishSmoothScroll();
        return true;
      }

      finishSmoothScroll();
      return true;
    };

    const schedulePageJumpFromDivider = (label, event) => {
      if (!label || !isOwnedPageDividerLabel(label)) return false;
      const pageNum = getPageNumFromDividerLabel(label);
      if (!pageNum) return false;
      event?.preventDefault?.();
      event?.stopPropagation?.();
      // If this is the second click of a double-click, cancel the pending jump
      // and let the dblclick event handle collapse instead. We must NOT execute
      // the jump synchronously here: doing so calls pw.goToPageStart → renderPage
      // synchronously, which destroys the label element before the dblclick fires,
      // making isOwnedPageDividerLabel return false on the detached node.
      if (Number(event?.detail || 1) > 1) {
        clearPendingPageJump();
        return false;
      }
      clearPendingPageJump();
      // Defer the jump so a fast double-click can cancel it before execution.
      // Keep the single-click jump behind the browser dblclick window so a
      // legitimate double-click cannot be pre-empted by a page jump/remount.
      pendingPageNum = pageNum;
      pageClickTimer = setTimeout(() => {
        const nextPageNum = Math.max(1, Number(pendingPageNum || pageNum) || 0);
        pageClickTimer = null;
        pendingPageNum = 0;
        jumpToPageFromDivider(nextPageNum, event);
      }, 400);
      return true;
    };

    const togglePageCollapseFromDivider = (label, event) => {
      // Resolve page number directly — tolerant of detached or replaced label nodes.
      const pageNum = Math.max(0, Number(
        label?.dataset?.pageNum
        || label?.closest?.('.cgxui-mm-page-divider')?.getAttribute?.('data-page-num')
        || label?.getAttribute?.('data-page-num')
        || 0
      ) || 0);
      if (!pageNum) return false;
      clearPendingPageJump();
      event?.preventDefault?.();
      event?.stopPropagation?.();
      suppressClickUntil = performance.now() + 180;
      try {
        // Multi-fallback core resolver: kernel bridge → direct global → custom event.
        const core =
          getCoreSurface() ||
          TOPW?.H2O_MM_CORE_API ||
          W?.H2O_MM_CORE_API ||
          TOPW?.H2O?.MM?.mnmp?.api?.core ||
          null;
        if (core?.toggleMiniMapPageCollapsed) {
          return !!core.toggleMiniMapPageCollapsed(pageNum, '', {
            source: 'minimap-local',
            propagate: false,
          });
        }
        window.dispatchEvent(new CustomEvent('evt:h2o:minimap:toggle-page-collapsed', {
          detail: {
            pageNum,
            source: 'minimap-local',
            propagate: false,
          },
        }));
        return true;
      } catch {
        return false;
      }
    };

    const turnCtx = (btn, gesture, ev) => {
      const surfaceRole = String(btn?.dataset?.surfaceRole || 'answer').trim().toLowerCase() || 'answer';
      const turnIdx = Math.max(0, Number(btn?.dataset?.turnIdx || 0) || 0);
      const paginationTurn = turnIdx > 0 ? getPaginationCanonicalTurnByIndex(turnIdx) : null;
      const turnId = String(paginationTurn?.turnId || btn?.dataset?.id || btn?.dataset?.turnId || '').trim();
      const answerId = String(paginationTurn?.answerId || btn?.dataset?.primaryAId || '').trim();
      const questionId = String(paginationTurn?.questionId || btn?.dataset?.questionId || '').trim();
      const id = surfaceRole === 'question'
        ? (questionId || turnId || answerId)
        : (answerId || turnId || questionId);
      const turn = paginationTurn?.turn || (turnId ? getTurn(turnId) : null) || resolveTurnRecord(answerId || turnId || questionId, answerId);
      return {
        surface: 'turn',
        surfaceRole,
        gesture,
        turnIdx,
        turnId,
        answerId,
        questionId,
        id,
        btnEl: btn || null,
        ev,
        turn,
        sh: TOPW.H2O_MM_SHARED?.get?.() || null,
        core: MM_core(),
        rt: MM_rt(),
        uiRefs: MM_uiRefs(),
      };
    };

    const turnActions = {
      answer: (ctx) => {
        const readerResult = MINI_navigateReaderTarget(ctx, 'answer');
        if (readerResult !== null) return readerResult;
        if (!ctx?.id) return false;
        MM.program = true;
        MINI_navigateTurnTarget(ctx, 'answer').then(({ ctx: nextCtx, target }) => {
          if (!target) return;
          MINI_scrollToResolvedTarget(target, nextCtx, 'answer');
        }).catch((e) => {
          derr('turn:answer:navigate', e);
        }).finally(() => {
          setTimeout(() => { MM.program = false; }, 160);
        });
        return true;
      },
      question: (ctx) => {
        const readerResult = MINI_navigateReaderTarget(ctx, 'question');
        if (readerResult !== null) return readerResult;
        if (!ctx?.id) return false;
        MM.program = true;
        MINI_navigateTurnTarget(ctx, 'question').then(({ ctx: nextCtx, target }) => {
          if (!target) return;
          MINI_scrollToResolvedTarget(target, nextCtx, 'question');
        }).catch((e) => {
          derr('turn:question:navigate', e);
        }).finally(() => {
          setTimeout(() => { MM.program = false; }, 180);
        });
        return true;
      },
      palette: (ctx) => {
        if (!ctx?.answerId && !ctx?.id) return false;
        const rect = ctx.btnEl?.getBoundingClientRect?.();
        const event = ctx.ev || {
          clientX: Math.round((rect?.left || 0) + ((rect?.width || 0) / 2)),
          clientY: Math.round((rect?.top || 0) + ((rect?.height || 0) / 2)),
          preventDefault() {},
          stopPropagation() {},
        };
        return !!callWashPalette(event, ctx.answerId || ctx.id, ctx.btnEl || null);
      },
      titles: (ctx) => {
        try { W.toggleStickyTitlePanel?.(ctx.btnEl || null, ctx.answerId || ctx.id); } catch {}
        return true;
      },
      quick: () => {
        const toggle = MM_uiRefs()?.toggle || q('[data-cgxui="mnmp-toggle"][data-cgxui-owner="mnmp"]');
        if (!toggle) return false;
        try {
          const ev = new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1, buttons: 4 });
          try { Object.defineProperty(ev, '__h2oBehaviorSyntheticQuick', { value: true }); } catch {}
          toggle.dispatchEvent(ev);
          return true;
        } catch {
          return false;
        }
      },
      export: () => openExportMenu(),
      auto: () => false,
    };
    const turnActionsCustom = {
      'export.menu.open': () => openExportMenu(),
      'quick.open': (ctx) => turnActions.quick(ctx),
    };

    const resolveTurnBinding = (binding, ctx) => {
      const map = behaviorMap() || {};
      const kind = String(binding?.kind || '').trim();
      if (!kind) return { binding: { kind: 'none' }, fn: null };
      if (kind === 'auto') {
        const defs = behaviorApi()?.defaults?.() || null;
        const next = defs?.turn?.[ctx.gesture] || null;
        const nk = String(next?.kind || '').trim();
        if (!nk || nk === 'auto') return { binding: { kind: 'none' }, fn: null };
        return { binding: next, fn: (nk === 'custom') ? null : (turnActions[nk] || null) };
      }
      if (kind === 'custom') {
        const id = String(binding?.id || '').trim();
        if (!id || typeof turnActionsCustom[id] !== 'function') {
          behaviorApi()?.warnOnce?.(`turn-custom:${ctx.gesture}:${id || 'missing'}`, 'Unknown custom action id; fallback applied.', { gesture: ctx.gesture, id });
          const fbKind = String(map?.customFallback?.kind || 'none').trim();
          const fb = (fbKind === 'none') ? { kind: 'none' } : { kind: fbKind };
          if (fb.kind === 'none') return { binding: fb, fn: null };
          return { binding: fb, fn: turnActions[fb.kind] || null };
        }
        return { binding, fn: turnActionsCustom[id] };
      }
      return { binding, fn: turnActions[kind] || null };
    };

    const normalizeTurnBindingForSurface = (binding, ctx) => {
      const role = String(ctx?.surfaceRole || 'answer').trim().toLowerCase();
      const gesture = String(ctx?.gesture || '').trim().toLowerCase();
      if (role !== 'question') return binding;
      if (gesture !== 'click') return binding;

      return { kind: 'question' };
    };

    const runTurnGesture = (btn, gesture, event) => {
      if (!btn || !isOwnedMiniMapBtn(btn)) return false;

      const ctx = turnCtx(btn, gesture, event);
      if (!ctx.id) return false;
      const gestureKey = String(gesture || '').trim().toLowerCase() || 'click';

      const isCold = btn.classList?.contains?.('h2o-mm-cold') || String(btn.getAttribute?.('data-h2o-archive-cold') || '') === '1';
      if (isCold && gesture === 'click') {
        const branchT0 = activePointerPerf ? perfNow() : 0;
        const answerIndex = Math.max(1, Number(btn?.dataset?.turnIdx || 0) || 0);
        const rawMsgIdx = Number(btn?.dataset?.h2oArchiveMsgIdx);
        const msgIdx = Number.isFinite(rawMsgIdx) ? Math.floor(rawMsgIdx) : -1;
        try {
          window.dispatchEvent(new CustomEvent(EVT_ARCHIVE_SCROLL_TO_COLD, {
            detail: {
              chatId: String(resolveChatId() || '').trim(),
              answerIndex,
              msgIdx,
              turnId: String(ctx.turnId || '').trim(),
              answerId: String(ctx.answerId || '').trim(),
              source: 'minimap:click:cold',
            },
          }));
        } catch {}
        try { setActiveTurnId(ctx.id, 'turn:click:cold'); } catch {}
        event?.preventDefault?.();
        event?.stopPropagation?.();
        pointerPerfSetActionType('jumpOrScroll');
        if (branchT0) pointerPerfRecordBranch('runTurnGesture:click:coldClick', perfNow() - branchT0);
        return true;
      }

      const binding0 = behaviorBinding('turn', gesture, event);
      const binding = normalizeTurnBindingForSurface(binding0, ctx);
      const kind = String(binding?.kind || '').trim();

      if (kind === 'none') {
        const branchT0 = activePointerPerf ? perfNow() : 0;
        if (branchT0) pointerPerfRecordBranch(`runTurnGesture:${gestureKey}:binding:none`, perfNow() - branchT0);
        return false;
      }
      if (kind === 'blocked') {
        const branchT0 = activePointerPerf ? perfNow() : 0;
        event?.preventDefault?.();
        event?.stopPropagation?.();
        if (branchT0) pointerPerfRecordBranch(`runTurnGesture:${gestureKey}:binding:blocked`, perfNow() - branchT0);
        return true;
      }

      const resolved = resolveTurnBinding(binding, ctx);
      if (!resolved.fn) {
        const branchT0 = activePointerPerf ? perfNow() : 0;
        behaviorApi()?.warnOnce?.(
          `turn-action:${gesture}:${kind}:${ctx.surfaceRole || 'answer'}`,
          'Turn action unavailable; safe no-op.',
          { gesture, kind, surfaceRole: ctx.surfaceRole || 'answer' }
        );
        event?.preventDefault?.();
        event?.stopPropagation?.();
        if (branchT0) pointerPerfRecordBranch(`runTurnGesture:${gestureKey}:action:missing`, perfNow() - branchT0);
        return true;
      }

      const actionKey = (
        resolved.fn === turnActions.answer ? 'answer'
          : resolved.fn === turnActions.question ? 'question'
            : resolved.fn === turnActions.palette ? 'palette'
              : resolved.fn === turnActions.titles ? 'titles'
                : (resolved.fn === turnActions.quick || resolved.fn === turnActionsCustom['quick.open']) ? 'quick'
                  : (resolved.fn === turnActions.export || resolved.fn === turnActionsCustom['export.menu.open']) ? 'export'
                    : (kind || 'unknown')
      );
      const branchLabel = `runTurnGesture:${gestureKey}:action:${actionKey}`;
      const branchT0 = activePointerPerf ? perfNow() : 0;
      event?.preventDefault?.();
      event?.stopPropagation?.();
      try {
        const ok = !!resolved.fn(ctx, binding?.payload || {});
        if (branchT0) pointerPerfRecordBranch(branchLabel, perfNow() - branchT0);
        if (ok) {
          if (actionKey === 'answer' || actionKey === 'question') pointerPerfSetActionType('jumpOrScroll');
          else if (actionKey === 'palette' || actionKey === 'titles' || actionKey === 'quick' || actionKey === 'export') pointerPerfSetActionType('directUiRefresh');
        }
        return ok;
      } catch (e) {
        if (branchT0) pointerPerfRecordBranch(`runTurnGesture:${gestureKey}:error`, perfNow() - branchT0);
        behaviorApi()?.warnOnce?.(
          `turn-action-err:${gesture}:${kind}:${ctx.surfaceRole || 'answer'}`,
          'Turn action failed; safe no-op.',
          { err: String(e?.message || e), surfaceRole: ctx.surfaceRole || 'answer' }
        );
        return false;
      }
    };

    const pointerHandler = (e) => {
      const perfT0 = perfNow();
      const phase = (S.bootDone || Number(PERF.bootCompletedAt || 0) > 0) ? 'afterBoot' : 'beforeBoot';
      const classified = (e.button != null && e.button !== 0)
        ? { targetType: 'unknown', pageLabel: null, btn: null }
        : classifyPointerTarget(e.target);
      activePointerPerf = {
        actionType: 'noOp',
        targetType: classified.targetType,
      };
      try {
        if (e.button != null && e.button !== 0) {
          pointerPerfRecordBranch('pointerHandler:nonLeft', perfNow() - perfT0);
          return;
        }
        const pageLabel = classified.pageLabel;
        if (pageLabel && isOwnedPageDividerLabel(pageLabel)) {
          pointerPerfRecordBranch('pointerHandler:pageDividerEarlyReturn', perfNow() - perfT0);
          return;
        }
        const btn = classified.btn;
        if (!btn || !isOwnedMiniMapBtn(btn)) {
          pointerPerfRecordBranch('pointerHandler:noOwnedButton', perfNow() - perfT0);
          return;
        }

        const id = String(btn.dataset?.id || btn.dataset?.turnId || btn.dataset?.primaryAId || '').trim();
        const now = performance.now();
        const isDouble = !!id && id === lastTapId && (now - lastTapTs) < 360;
        lastTapId = id;
        lastTapTs = now;

        if (isDouble) {
          suppressClickUntil = now + 420;
          runTurnGesture(btn, 'dblclick', e);
          return;
        }
        const handled = runTurnGesture(btn, 'click', e);
        if (handled && W.H2O?.Studio?.readerNavigation && activePointerPerf?.actionType === 'jumpOrScroll') {
          suppressClickUntil = now + 360; // the following click is the same Reader transition
        }
      } finally {
        const perfBucket = pointerPerfState();
        const totalMs = perfNow() - perfT0;
        const targetType = String(activePointerPerf?.targetType || classified.targetType || 'unknown');
        const actionType = String(activePointerPerf?.actionType || 'noOp');
        recordDuration(perfBucket, totalMs);
        if (phase === 'afterBoot') perfBucket.afterBootCount = Number(perfBucket.afterBootCount || 0) + 1;
        else perfBucket.beforeBootCount = Number(perfBucket.beforeBootCount || 0) + 1;
        perfBucket.lastAt = Date.now();
        perfBucket.lastTargetType = targetType;
        perfBucket.lastActionType = actionType;
        recordDuration(ensureDurationBucketMapEntry(perfBucket.targetType, targetType), totalMs);
        recordDuration(ensureDurationBucketMapEntry(perfBucket.actionType, actionType), totalMs);
        activePointerPerf = null;
      }
    };

    const handler = (e) => {
      if (performance.now() < suppressClickUntil) return;
      const pageLabel = getOwnedPageDividerLabel(e.target);
      if (pageLabel && isOwnedPageDividerLabel(pageLabel)) {
        schedulePageJumpFromDivider(pageLabel, e);
        return;
      }
      const btn = e.target?.closest?.(mmBtnSelector());
      if (!btn || !isOwnedMiniMapBtn(btn)) return;
      runTurnGesture(btn, 'click', e);
    };

    const dblHandler = (e) => {
      // Resolve the MiniMap page divider container from the event target.
      // Do NOT gate on isOwnedPageDividerLabel — on a fast dblclick the browser
      // can report a slightly different e.target for the dblclick vs the preceding
      // clicks, and any descendant of .cgxui-mm-page-divider is a valid hit target.
      const el = (e.target instanceof Element) ? e.target : (e.target?.parentElement || null);
      if (!el) return;
      const divider = el.closest?.('.cgxui-mm-page-divider[data-page-num]');
      if (!divider) return;
      const pageNum = Math.max(0, Number(divider.getAttribute('data-page-num') || 0) || 0);
      if (!pageNum) return;
      clearPendingPageJump();
      e?.preventDefault?.();
      e?.stopPropagation?.();
      // Delegate to togglePageCollapseFromDivider using the live divider element
      // so its page-num resolution also uses the container attribute.
      togglePageCollapseFromDivider(divider, e);
    };

    const handleMiddleEvent = (event) => {
      const btn = event?.target?.closest?.(mmBtnSelector());
      if (!btn || event.button !== 1) return;
      if (!btn.closest?.('[data-cgxui$="minimap"]')) return;
      if (isQuestionSurfaceBtn(btn)) return;

      const turnId = String(btn.dataset?.id || btn.dataset?.turnId || '').trim();
      if (!turnId) return;

      const midBinding = behaviorBinding('turn', 'mid', event);
      const dmidBinding = behaviorBinding('turn', 'dmid', event);
      const hasMid = String(midBinding?.kind || 'none') !== 'none';
      const hasDmid = String(dmidBinding?.kind || 'none') !== 'none';
      if (!hasMid && !hasDmid) return;

      // Consume auxclick immediately so other middle-click listeners can't fire a single action
      // before we decide whether this gesture is single-middle or double-middle.
      event.preventDefault();
      event.stopPropagation();

      const now = performance.now();
      const delta = now - lastMidTime;
      const isSame = (turnId === lastMidId);
      lastMidTime = now;
      lastMidId = turnId;

      if (isSame && delta < 280 && hasDmid) {
        if (midTimer) { clearTimeout(midTimer); midTimer = null; }
        runTurnGesture(btn, 'dmid', event);
      } else {
        if (midTimer) { clearTimeout(midTimer); midTimer = null; }
        if (!hasMid) return;
        const rect = btn.getBoundingClientRect?.();
        const clientX = Number.isFinite(event?.clientX) ? event.clientX : Math.round((rect?.left || 0) + ((rect?.width || 0) / 2));
        const clientY = Number.isFinite(event?.clientY) ? event.clientY : Math.round((rect?.top || 0) + ((rect?.height || 0) / 2));
        midTimer = setTimeout(() => {
          midTimer = null;
          const fakeEvt = {
            clientX,
            clientY,
            button: 1,
            shiftKey: !!event?.shiftKey,
            altKey: !!event?.altKey,
            metaKey: !!event?.metaKey,
            preventDefault() {},
            stopPropagation() {},
          };
          runTurnGesture(btn, 'mid', fakeEvt);
        }, 260);
      }
    };

    const suppressMiddleDown = (event) => {
      const btn = event?.target?.closest?.(mmBtnSelector());
      if (!btn || event.button !== 1) return;
      if (!btn.closest?.('[data-cgxui$="minimap"]')) return;
      if (isQuestionSurfaceBtn(btn)) return;
      const b = behaviorBinding('turn', 'mid', event);
      const db = behaviorBinding('turn', 'dmid', event);
      if (String(b?.kind || 'none') === 'none' && String(db?.kind || 'none') === 'none') return;
      event.preventDefault();
      event.stopPropagation();
    };

    window.addEventListener('pointerdown', pointerHandler, true);
    window.addEventListener('click', handler, true);
    window.addEventListener('dblclick', dblHandler, true);
    if (supportsAuxClick) {
      window.addEventListener('mousedown', suppressMiddleDown, true);
      window.addEventListener('auxclick', handleMiddleEvent, true);
    } else {
      window.addEventListener('mousedown', handleMiddleEvent, true);
    }
    S.offBtnClick = () => {
      try { window.removeEventListener('pointerdown', pointerHandler, true); } catch {}
      try { window.removeEventListener('click', handler, true); } catch {}
      try { window.removeEventListener('dblclick', dblHandler, true); } catch {}
      try { window.removeEventListener('mousedown', suppressMiddleDown, true); } catch {}
      try { window.removeEventListener('auxclick', handleMiddleEvent, true); } catch {}
      try { window.removeEventListener('mousedown', handleMiddleEvent, true); } catch {}
      try { if (midTimer) clearTimeout(midTimer); } catch {}
      try { if (pageClickTimer) clearTimeout(pageClickTimer); } catch {}
      midTimer = null;
      pageClickTimer = null;
      pendingPageNum = 0;
    };
  }

  function emitAnswersScan(reason = 'engine') {
    const { EV } = getRegs();
    const evtName = EV.ANSWERS_SCAN || EVT_ANSWERS_SCAN_FALLBACK;
    try { W.H2O?.bus?.emit?.('answers:scan', { reason }); } catch {}
    try { window.dispatchEvent(new CustomEvent(evtName, { detail: { reason } })); } catch {}
  }

  function findBtnById(id, opts = null) {
    const key = String(id || '').trim();
    if (!key) return null;
    try {
      const btn = MM_core()?.getBtnById?.(key);
      if (btn) return btn;
    } catch {}
    if (!opts?.repair) return null;
    return selectMiniBtnById(key);
  }

  function getActiveTurnId() {
    try {
      const b = q(activeBtnSelector());
      const id = String(b?.dataset?.id || b?.dataset?.turnId || '').trim();
      if (id) return id;
    } catch {}
    return String(S.lastActiveTurnId || '');
  }

  function getTurnIndex(anyId) {
    const core = MM_core();
    const key = String(anyId || getActiveTurnId() || '').trim();
    if (!key || !core) return 0;
    try { return Number(core.getTurnIndex?.(key) || 0); } catch { return 0; }
  }

  function notifyTurnChange(source = 'engine') {
    const id = getActiveTurnId();
    if (!id || id === S.lastActiveTurnId) return;

    S.lastActiveTurnId = id;
    const detail = { activeTurnId: id, source };

    for (const cb of Array.from(S.turnListeners)) {
      try { cb(detail); } catch {}
    }
  }

  function setActiveTurnId(id, source = 'api', opts = {}) {
    const key = normalizeNavId(id);
    if (!key) return false;
    if (!opts?.skipPageScroll) {
      const readerResult = MINI_navigateReaderTarget({ id: key, turnId: key }, 'answer', opts);
      if (readerResult !== null) return readerResult;
    }

    const core = getCoreSurface();
    if (!core) {
      disableScrollSync('set-active:no-core');
      return false;
    }
    S.mmProgram = true;
    const skipPageScroll = !!opts?.skipPageScroll;
    if (!skipPageScroll) {
      const target = resolveAnswerTarget(key);
      try { scrollPageToTarget(target, true, 'center'); } catch (e) { derr('setActive:target.scroll', e); }
    }
    try { core.setActive?.(key, source); } catch (e) { derr('setActive:core.setActive', e); }
    try { core.centerOn?.(key, { force: true, smooth: true, activate: false }); } catch (e) { derr('setActive:core.centerOn', e); }
    try { core.updateCounter?.(key); } catch (e) { derr('setActive:core.updateCounter', e); }
    try { core.updateToggleColor?.(key); } catch (e) { derr('setActive:core.updateToggleColor', e); }
    clearTimeout(S.mmUserTimer);
    S.mmUserTimer = setTimeout(() => { S.mmProgram = false; }, 240);

    S.lastActiveTurnId = key;
    S.lastActiveBtnId = key;
    try { S.lastActiveBtnEl = core.getBtnById?.(key) || S.lastActiveBtnEl || null; } catch {}
    notifyTurnChange(source);
    return true;
  }

  function queueSyncActiveReason(reason = 'scroll') {
    const why = String(reason || 'scroll').trim() || 'scroll';
    S.syncReasons.add(why);
    return why;
  }

  function flushSyncActiveReason() {
    const reasons = Array.from(S.syncReasons || []);
    S.syncReasons.clear();
    if (!reasons.length) return 'scroll';
    const primary = reasons.find((reason) => !String(reason || '').startsWith('scroll')) || reasons[0];
    return [primary].concat(reasons.filter((reason) => reason !== primary)).join('|');
  }

  function scheduleSyncActive(reason = 'scroll') {
    if (!S.running) return false;
    const phase = currentPerfPhase();
    const perfBucket = PERF.scheduleSyncActive;
    const why = queueSyncActiveReason(reason);
    perfBucket.callCount = Number(perfBucket.callCount || 0) + 1;
    perfBucket.lastReason = why;
    perfBucket.lastAt = Date.now();
    bumpReason(perfBucket.reasons, why);
    bumpPhaseCounter(perfBucket, phase, 'callCount');
    if (S.syncQueued) {
      perfBucket.coalescedCount = Number(perfBucket.coalescedCount || 0) + 1;
      bumpPhaseCounter(perfBucket, phase, 'coalescedCount');
      return true;
    }
    S.syncQueued = true;
    const run = () => {
      const execPhase = currentPerfPhase();
      S.syncQueued = false;
      perfBucket.executedCount = Number(perfBucket.executedCount || 0) + 1;
      bumpPhaseCounter(perfBucket, execPhase, 'executedCount');
      const execBucket = PERF.syncActiveExecution;
      if (execPhase === 'afterBoot') execBucket.afterBootCount = Number(execBucket.afterBootCount || 0) + 1;
      else execBucket.beforeBootCount = Number(execBucket.beforeBootCount || 0) + 1;
      const perfT0 = perfNow();
      try {
        syncActive(flushSyncActiveReason());
      } finally {
        recordDuration(execBucket, perfNow() - perfT0);
      }
    };
    const schedule = MM_schedule();
    if (schedule && typeof schedule.rafOnce === 'function') {
      MM_scheduleRafOnce('minimap:sync-active', run);
      return true;
    }
    S.syncRAF = requestAnimationFrame(() => {
      S.syncRAF = 0;
      run();
    });
    return true;
  }

  function syncActive(reason = 'scroll') {
    if (!S.running) return;
    if (S.scrollSyncDisabled) return;
    if (S.mmUser || S.mmProgram) return;
    const scanTick0 = Number(S.perfFullScanTick || 0);
    try { pruneObservedAnswers(); } catch {}
    const core = getCoreSurface();
    if (!core) {
      disableScrollSync('sync:no-core');
      return;
    }
    let id = '';
    if (typeof core.computeActiveFromViewport !== 'function' || typeof core.setActive !== 'function') {
      disableScrollSync('sync:core-surface-missing');
      return;
    }
    const anchors = getViewportAnchorY();
    const active = core.computeActiveFromViewport({
      visibleSet: S.visibleSet,
      anchorY: anchors.anchorY,
      turnAnchorY: anchors.turnAnchorY,
    });
    const activePageNum = Math.max(0, Number(active?.activePageNum || 0) || 0);
    id = String(active?.activeTurnId || active?.activeAnswerId || active?.syncedId || '');
    if (id) {
      let nextBtn = null;
      try { nextBtn = core.getBtnById?.(id) || null; } catch {}
      const stateStr = String(nextBtn?.getAttribute?.('data-cgxui-state') || '');
      const alreadyActive = !!(
        nextBtn &&
        (nextBtn.classList?.contains?.('active') || /\bactive\b/.test(stateStr))
      );
      const sameId = id === String(S.lastActiveTurnId || S.lastActiveBtnId || '').trim();
      if (!(sameId && alreadyActive)) {
        try { core.setActive(id, 'scroll-sync'); } catch (e) { derr('sync:setActive', e); }
        const centeredDivider = syncViewportPageDivider(core, activePageNum, reason);
        if (!centeredDivider) {
          try { core.centerOn?.(id, { force: false, smooth: true, activate: false }); } catch (e) { derr('sync:centerOn', e); }
        }
        S.lastActiveTurnId = id;
        S.lastActiveBtnId = id;
        try { S.lastActiveBtnEl = core.getBtnById?.(id) || S.lastActiveBtnEl || null; } catch {}
        if (PERF_ASSERT_ON) console.assert(scanTick0 === Number(S.perfFullScanTick || 0), '[MiniMap] Active path must be O(1) — no full scans');
      } else {
        syncViewportPageDivider(core, activePageNum, reason);
      }
    } else {
      syncViewportPageDivider(core, activePageNum, reason);
    }
    notifyTurnChange(reason);
  }

  function clearMiniMapGuardBindings() {
    try { S.offMmWheel?.(); } catch {}
    try { S.offMmTouchStart?.(); } catch {}
    try { S.offMmMouseDown?.(); } catch {}
    S.offMmWheel = null;
    S.offMmTouchStart = null;
    S.offMmMouseDown = null;
    S.mmScroller = null;
    S.mmUser = false;
    S.mmProgram = false;
    clearTimeout(S.mmUserTimer);
    S.mmUserTimer = null;
  }

  function miniMapScroller() {
    const panel = minimapPanel();
    if (!panel) return null;
    if (S.mmScroller && S.mmScroller.isConnected) return S.mmScroller;
    const { SEL } = getRegs();
    const pick = (sel) => {
      const s = String(sel || '').trim();
      if (!s) return null;
      try { return panel.querySelector(s); } catch { return null; }
    };
    const candidates = [
      pick(SEL.MM_COL),
      pick(SEL.MM_SCROLL),
      pick(SEL.MM_COL_LEGACY),
      pick(SEL.COL_PLAIN),
      panel,
    ].filter(Boolean);
    const found = candidates.find((el) => {
      try {
        return el.scrollHeight > el.clientHeight && getComputedStyle(el).overflowY !== 'visible';
      } catch {
        return false;
      }
    }) || panel;
    return found;
  }

  function bindMiniMapScrollGuards() {
    const SH = TOPW.H2O_MM_SHARED?.get?.();
    const on = SH?.util?.on || ((t, ev, fn, opts) => {
      t?.addEventListener?.(ev, fn, opts);
      return () => { try { t?.removeEventListener?.(ev, fn, opts); } catch {} };
    });
    const scroller = miniMapScroller();
    if (!scroller) return;
    if (scroller === S.mmScroller && S.offMmWheel) return;
    clearMiniMapGuardBindings();
    S.mmScroller = scroller;
    const markUser = (ms) => {
      S.mmUser = true;
      clearTimeout(S.mmUserTimer);
      S.mmUserTimer = setTimeout(() => { S.mmUser = false; }, ms);
    };
    S.offMmWheel = on(scroller, 'wheel', () => {
      const perfBucket = PERF.wheelGuard;
      const phase = currentPerfPhase();
      if (phase === 'afterBoot') perfBucket.afterBootCount = Number(perfBucket.afterBootCount || 0) + 1;
      else perfBucket.beforeBootCount = Number(perfBucket.beforeBootCount || 0) + 1;
      const perfT0 = perfNow();
      try {
        markUser(450);
      } finally {
        recordDuration(perfBucket, perfNow() - perfT0);
      }
    }, { passive: false });
    S.offMmTouchStart = on(scroller, 'touchstart', () => {
      PERF.wheelGuard.touchstartCount = Number(PERF.wheelGuard.touchstartCount || 0) + 1;
      markUser(650);
    }, { passive: false });
    S.offMmMouseDown = on(scroller, 'mousedown', (e) => {
      PERF.wheelGuard.mousedownCount = Number(PERF.wheelGuard.mousedownCount || 0) + 1;
      if (e?.target?.closest?.(mmBtnSelector())) return;
      markUser(450);
    }, { passive: false });
  }

  function refreshFromIndexedState(reason = 'engine:indexed-refresh', opts = {}) {
    const perfBucket = PERF.refreshFromIndexedState;
    perfBucket.callCount = Number(perfBucket.callCount || 0) + 1;
    const perfT0 = perfNow();
    let ok = false;
    try {
      const core = MM_core();
      if (!core) return false;

      const refs = MM_uiRefs();
      const panel = refs?.panel || minimapPanel();
      const col = refs?.col || minimapCol();
      if (!panel?.isConnected || !col?.isConnected) return false;

      if (opts?.reconcileRows) {
        if (typeof core.ensureTurnButtons !== 'function') return false;
        try {
          const out = core.ensureTurnButtons();
          if (!(out instanceof Map)) return false;
        } catch (e) {
          derr('refreshFromIndexedState:ensureTurnButtons', e);
          return false;
        }
      }

      if (buildMissing()) return false;

      const chatId = resolveChatId();
      try { ensureChatPageDividerBridgeFromRuntime(); } catch (e) { derr('refreshFromIndexedState:chatPageDividerBridge', e); }
      try { core.attachVisibleAnswers?.(chatId); } catch (e) { derr('refreshFromIndexedState:attachVisibleAnswers', e); }
      try { observeVisibleAnswers(currentAnswerEls()); } catch (e) { derr('refreshFromIndexedState:observeVisibleAnswers', e); }
      try { bindMiniMapScrollGuards(); } catch (e) { derr('refreshFromIndexedState:bindMiniMapScrollGuards', e); }
      scheduleSyncActive(reason);
      ok = true;
      return true;
    } finally {
      if (ok) perfBucket.successCount = Number(perfBucket.successCount || 0) + 1;
      recordDuration(perfBucket.duration, perfNow() - perfT0);
    }
  }

  function rebuildNow(reason = 'engine:rebuildNow') {
    const perfBucket = PERF.rebuild;
    const phase = currentPerfPhase();
    perfBucket.executedCount = Number(perfBucket.executedCount || 0) + 1;
    bumpPhaseCounter(perfBucket, phase, 'executedCount');
    const durationT0 = perfNow();
    const perfT0 = PERF_ASSERT_ON ? performance.now() : 0;
    const scanTick0 = Number(S.perfFullScanTick || 0);
    S.rebuildReason = String(reason || 'engine:rebuildNow');
    try {
      const core = MM_core();
      if (!core) return false;

      let ok = false;
      try {
        const res = core.rebuildNow?.(S.rebuildReason);
        ok = (res && typeof res === 'object') ? !!res.ok : !!res;
      } catch (e) {
        derr('rebuildNow:core', e);
      }

      if (ok) {
        ensureChatPageDividerBridgeFromRuntime();
        try { observeVisibleAnswers(core.getAnswerList?.() || []); } catch {}
        try { bindMiniMapScrollGuards(); } catch {}
        scheduleSyncActive('rebuild');
      }

      if (PERF_ASSERT_ON) {
        try {
          console.debug('[MiniMap][perf] engine.rebuildNow', {
            reason: S.rebuildReason,
            ok,
            ms: Math.max(0, Number(performance.now() - perfT0).toFixed(2)),
            fullScansDelta: Math.max(0, Number(S.perfFullScanTick || 0) - scanTick0),
            fullScansTotal: Number(S.perfFullScanTick || 0),
          });
        } catch {}
      }

      return ok;
    } finally {
      recordDuration(perfBucket.duration, perfNow() - durationT0);
    }
  }

  function scheduleRebuild(reason = 'engine:rebuild') {
    const perfBucket = PERF.rebuild;
    const phase = currentPerfPhase();
    const why = String(reason || 'engine:rebuild');
    perfBucket.scheduleCallCount = Number(perfBucket.scheduleCallCount || 0) + 1;
    perfBucket.lastReason = why;
    perfBucket.lastAt = Date.now();
    bumpReason(perfBucket.reasons, why);
    bumpPhaseCounter(perfBucket, phase, 'scheduleCallCount');
    S.rebuildReason = why;
    const core = MM_core();
    if (!core) return false;
    const schedule = MM_schedule();
    if (schedule && typeof schedule.isPending === 'function') {
      const pending = !!(schedule.isPending('minimap:rebuild') || schedule.isPending('minimap:rebuild:fallback'));
      if (pending) {
        perfBucket.coalescedCount = Number(perfBucket.coalescedCount || 0) + 1;
        bumpPhaseCounter(perfBucket, phase, 'coalescedCount');
      }
    }
    try { return !!core.scheduleRebuild?.(S.rebuildReason); } catch { return false; }
  }

  function onTurnChange(cb) {
    if (typeof cb !== 'function') return () => {};
    S.turnListeners.add(cb);
    return () => { try { S.turnListeners.delete(cb); } catch {} };
  }

  function clearTimer(name, type = 'timeout') {
    const id = S[name];
    if (!id) return;
    try {
      if (type === 'interval') clearInterval(id);
      else clearTimeout(id);
    } catch {}
    S[name] = null;
  }

  function cancelScheduledTask(key, field, type = 'timeout') {
    const schedule = MM_schedule();
    if (schedule) {
      try { schedule.cancel(key); } catch {}
    }
    const id = S[field];
    if (!id) {
      S[field] = type === 'raf' ? 0 : null;
      return;
    }
    if (type === 'raf') {
      try { cancelAnimationFrame(id); } catch {}
      S[field] = 0;
      return;
    }
    try {
      if (type === 'interval') clearInterval(id);
      else clearTimeout(id);
    } catch {}
    S[field] = null;
  }

  function uiRefsReady(refs = MM_uiRefs()) {
    return !!(
      refs?.root?.isConnected
      && refs?.panel?.isConnected
      && refs?.toggle?.isConnected
    );
  }

  function removedNodeContainsUi(node, refs = MM_uiRefs()) {
    if (!node || node.nodeType !== 1) return false;
    const el = node;
    const targets = [refs?.root, refs?.panel, refs?.toggle].filter(Boolean);
    for (const target of targets) {
      if (!target) continue;
      if (el === target) return true;
      try {
        if (el.contains?.(target)) return true;
      } catch {}
    }
    try {
      if (el.matches?.('[data-cgxui="mnmp-root"], [data-cgxui="mnmp-minimap"], [data-cgxui="mnmp-toggle"], [data-cgxui="mm-panel"], [data-cgxui="mm-toggle"]')) {
        return true;
      }
    } catch {}
    if (Number(el.childElementCount || 0) > 12) return false;
    try {
      return !!el.querySelector?.('[data-cgxui="mnmp-root"], [data-cgxui="mnmp-minimap"], [data-cgxui="mnmp-toggle"], [data-cgxui="mm-panel"], [data-cgxui="mm-toggle"]');
    } catch {
      return false;
    }
  }

  function scheduleStructureRecoveryCheck(reason = 'panel:removed') {
    const perfBucket = PERF.structureRecovery;
    const why0 = String(reason || 'panel:removed');
    perfBucket.callCount = Number(perfBucket.callCount || 0) + 1;
    perfBucket.lastReason = why0;
    perfBucket.lastAt = Date.now();
    S.structureRecoveryReason = why0;
    if (S.structureRecoveryQueued) {
      perfBucket.coalescedCount = Number(perfBucket.coalescedCount || 0) + 1;
      return true;
    }
    S.structureRecoveryQueued = true;
    MM_scheduleRafOnce('minimap:structure-recovery', () => {
      S.structureRecoveryQueued = false;
      perfBucket.executedCheckCount = Number(perfBucket.executedCheckCount || 0) + 1;
      const why = String(S.structureRecoveryReason || reason || 'panel:removed');
      S.structureRecoveryReason = '';
      if (!S.running) return;
      recoverUiStructure(why, { allowWithoutAnswers: why === 'panel:removed' });
    });
    return true;
  }

  function stop(reason = 'engine:stop') {
    cancelScheduledTask('minimap:first-paint', 'firstPaintRaf', 'raf');
    cancelScheduledTask('minimap:first-paint:failsafe', 'failsafeTimer');
    clearTimer('pageJumpTimer');
    cancelScheduledTask('minimap:pagination-check:fast', 'paginationCheckFastTimer');
    cancelScheduledTask('minimap:pagination-check:slow', 'paginationCheckSlowTimer');
    cancelScheduledTask('minimap:sync-active', 'syncRAF', 'raf');
    try { MM_schedule()?.cancel?.('minimap:structure-recovery'); } catch {}
    S.syncQueued = false;
    S.syncReasons.clear();
    S.structureRecoveryQueued = false;
    S.structureRecoveryReason = '';

    try { S.domMO?.disconnect?.(); } catch {}
    try { S.panelMO?.disconnect?.(); } catch {}
    try { S.panelRootMO?.disconnect?.(); } catch {}
    try { S.formRO?.disconnect?.(); } catch {}
    resetVisibleAnswersObserver();
    S.domMO = null;
    S.panelMO = null;
    S.panelRootMO = null;
    S.formRO = null;
    clearMiniMapGuardBindings();

    try { S.offScroll?.(); } catch {}
    try { S.offResize?.(); } catch {}
    try { S.offShellReady?.(); } catch {}
    try { S.offBehaviorChanged?.(); } catch {}
    try { S.offRouteChanged?.(); } catch {}
    try { S.offBtnClick?.(); } catch {}
    try { S.offPaginationChanged?.(); } catch {}
    try { S.offPaginationChangedAlias?.(); } catch {}
    try { S.offIndexAppended?.(); } catch {}
    try { S.offIndexHydrated?.(); } catch {}
    try { S.offViewChanged?.(); } catch {}
    try { S.offShellNoButtons?.(); } catch {}
    S.offScroll = null;
    S.offResize = null;
    S.offShellReady = null;
    S.offBehaviorChanged = null;
    S.offRouteChanged = null;
    S.offBtnClick = null;
    S.offPaginationChanged = null;
    S.offPaginationChangedAlias = null;
    S.offIndexAppended = null;
    S.offIndexHydrated = null;
    S.offViewChanged = null;
    S.offShellNoButtons = null;

    S.running = false;
    S.scrollSyncDisabled = false;
    S.pageJumpToken = 0;
    S.pageJumpUntil = 0;
    S.lastActivePageNum = 0;
    S.lastActiveBtnEl = null;
    S.lastActiveBtnId = '';
    S.moRebuildCooldownUntil = 0;
    markReady(false);
    dlog('engine:stop', { reason });
    return true;
  }

  function pickAddedAnswerNode(node, answerSel) {
    if (!node || node.nodeType !== 1) return null;
    const el = node;
    if (el.matches?.(answerSel)) return el;
    const role = String(el.getAttribute?.('data-message-author-role') || '').toLowerCase();
    if (role === 'assistant') return el;
    const c1 = el.firstElementChild || null;
    if (c1?.matches?.(answerSel)) return c1;
    const c2 = c1?.firstElementChild || null;
    if (c2?.matches?.(answerSel)) return c2;
    const shouldScanDeep = (el.childElementCount || 0) <= 12
      || el.matches?.(`${conversationTurnSelector()}, [data-testid="conversation-turns"], main`);
    if (!shouldScanDeep || !el.querySelector) return null;
    return el.querySelector(answerSel);
  }

  function nodeContainsRealMessageOrTurn(node, answerSel = answersSelector()) {
    if (!node || node.nodeType !== 1) return false;
    const el = node;
    try {
      if (el.matches?.(answerSel)) return true;
    } catch {}
    try {
      const role = String(el.getAttribute?.('data-message-author-role') || '').toLowerCase();
      if (role === 'assistant' || role === 'user') return true;
    } catch {}
    try {
      if (el.matches?.(`${conversationTurnSelector()}, [data-testid="conversation-turns"]`)) return true;
    } catch {}
    try {
      if (el.querySelector?.(`${answerSel}, [data-message-author-role="assistant"], [data-message-author-role="user"], ${conversationTurnSelector()}, [data-testid="conversation-turns"]`)) return true;
    } catch {}
    return false;
  }

  function isMiniMapOwnedNode(node, answerSel = answersSelector()) {
    if (!node || node.nodeType !== 1) return false;
    const el = node;
    let owned = false;
    try {
      owned = String(el.getAttribute?.('data-cgxui-owner') || '').trim() === 'mnmp';
    } catch {}
    if (!owned) {
      try {
        owned = !!el.closest?.('[data-cgxui-owner="mnmp"]');
      } catch {}
    }
    if (!owned) return false;
    return !nodeContainsRealMessageOrTurn(el, answerSel);
  }

  function collectMutationSignals(muts) {
    const answerSel = answersSelector();
    const added = new Set();
    let rebuildHit = false;
    for (const m of muts || []) {
      if (!m || m.type !== 'childList') continue;
      const hasAdded = !!(m.addedNodes && m.addedNodes.length);
      const hasRemoved = !!(m.removedNodes && m.removedNodes.length);
      if (!hasAdded && !hasRemoved) continue;
      for (const n of Array.from(m?.removedNodes || [])) {
        if (!n || n.nodeType !== 1) continue;
        const el = n;
        if (isMiniMapOwnedNode(el, answerSel)) continue;
        if (el.matches?.(answerSel)) {
          rebuildHit = true;
          break;
        }
        const childCount = Number(el.childElementCount || 0);
        const isTurnLike = !!el.matches?.(`${conversationTurnSelector()}, [data-testid="conversation-turns"], main`);
        if (isTurnLike && childCount <= 12 && el.querySelector?.(answerSel)) {
          rebuildHit = true;
          break;
        }
      }
      for (const n of Array.from(m?.addedNodes || [])) {
        if (isMiniMapOwnedNode(n, answerSel)) continue;
        const answerEl = pickAddedAnswerNode(n, answerSel);
        if (answerEl) added.add(answerEl);
      }
    }
    return { addedAnswers: Array.from(added), rebuildHit };
  }

  function installPanelObservers() {
    try { S.panelMO?.disconnect?.(); } catch {}
    try { S.panelRootMO?.disconnect?.(); } catch {}
    S.panelMO = null;
    S.panelRootMO = null;

    const panelRoot = MM_uiRefs()?.root || null;
    const panelHost = panelRoot?.parentElement || document.body;
    const onPanelMutations = (muts) => {
      if (!S.running) return;
      const refs = MM_uiRefs();
      const hit = muts.some((m) => Array.from(m?.removedNodes || []).some((n) => removedNodeContainsUi(n, refs)));
      if (!hit) return;
      scheduleStructureRecoveryCheck('panel:removed');
    };

    if (panelHost) {
      S.panelMO = new MutationObserver(onPanelMutations);
      S.panelMO.observe(panelHost, { childList: true, subtree: false });
    }
    if (panelRoot) {
      S.panelRootMO = new MutationObserver(onPanelMutations);
      S.panelRootMO.observe(panelRoot, { childList: true, subtree: false });
    }
  }

  function recoverUiStructure(reason = 'panel:removed', opts = {}) {
    if (!S.running) return false;
    const allowWithoutAnswers = !!opts?.allowWithoutAnswers;
    const answersPresent = hasAnswersInDom();
    const refsMissing = !uiRefsReady();
    const missingBuild = buildMissing();

    if (!allowWithoutAnswers && !answersPresent) return false;
    if (!refsMissing && !missingBuild) return false;

    try { MM_ui()?.ensureUI?.(`engine:${reason}`); } catch (e) { derr('recoverUiStructure:ensureUI', e); }
    installPanelObservers();

    if (!uiRefsReady()) {
      PERF.structureRecovery.recoveryTriggeredRebuildCount = Number(PERF.structureRecovery.recoveryTriggeredRebuildCount || 0) + 1;
      scheduleRebuild(reason);
      return true;
    }
    if (!answersPresent && allowWithoutAnswers) return true;
    if (refreshFromIndexedState(reason, { reconcileRows: true })) return true;
    if (!buildMissing()) return true;

    PERF.structureRecovery.recoveryTriggeredRebuildCount = Number(PERF.structureRecovery.recoveryTriggeredRebuildCount || 0) + 1;
    scheduleRebuild(reason);
    return true;
  }

  function bindObservers() {
    const SH = TOPW.H2O_MM_SHARED?.get?.();
    const on = SH?.util?.on || ((t, ev, fn, opts) => {
      t?.addEventListener?.(ev, fn, opts);
      return () => { try { t?.removeEventListener?.(ev, fn, opts); } catch {} };
    });

    const root = convContainer();
    if (root) {
      S.domMO = new MutationObserver((muts) => {
        if (!S.running) return;
        const sig = collectMutationSignals(muts);
        const core = MM_core();
        const chatId = resolveChatId();
        let didDeltaAppend = false;
        let appendStructuralFailure = false;
        const observedNewAnswers = [];
        if (sig.addedAnswers.length) {
          const appendFn = core?.appendTurnFromAnswerEl;
          if (typeof appendFn === 'function' && chatId) {
            for (const answerEl of sig.addedAnswers) {
              let out = null;
              try { out = appendFn(chatId, answerEl, { source: 'engine:mo' }); } catch {}
              const status = String(out?.status || '').trim();
              if (out?.ok || status === 'appended' || status === 'exists') {
                didDeltaAppend = true;
                observedNewAnswers.push(answerEl);
              }
              if (status === 'error' || status === 'non-monotonic' || status === 'ui-missing') {
                appendStructuralFailure = true;
              }
            }
          }
        }
        if (didDeltaAppend) {
          try { observeVisibleAnswers(observedNewAnswers.length ? observedNewAnswers : sig.addedAnswers, { incremental: true, prune: true }); } catch {}
          scheduleSyncActive('mo:append');
        }
        const shouldCheckRecovery = !!sig.rebuildHit || appendStructuralFailure || (!!sig.addedAnswers.length && !didDeltaAppend);
        if (shouldCheckRecovery) {
          const needsRebuild = appendStructuralFailure
            || sig.rebuildHit
            || buildMissing()
            || paginationCoverageNeedsRebuild('mo:answers');
          if (!needsRebuild) return;
          const now = Date.now();
          if (now >= Number(S.moRebuildCooldownUntil || 0)) {
            S.moRebuildCooldownUntil = now + MO_REBUILD_COOLDOWN_MS;
            scheduleRebuild('mo:answers');
          }
        }
      });
      S.domMO.observe(root, { childList: true, subtree: true });
    }

    const viewportScrollRoot = getViewportScrollRoot();
    S.offScroll = on(viewportScrollRoot, 'scroll', () => scheduleSyncActive('scroll'), { passive: true });
    S.offResize = on(window, 'resize', () => {
      try { W.positionCounterBox?.(); } catch {}
      scheduleSyncActive('resize');
    }, { passive: true });

    const form = formEl();
    if (form && typeof ResizeObserver === 'function') {
      S.formRO = new ResizeObserver(() => {
        try { W.positionCounterBox?.(); } catch {}
      });
      S.formRO.observe(form);
    }

    installPanelObservers();
    if (!S.offShellNoButtons) {
      S.offShellNoButtons = on(window, EVT_SHELL_NO_BUTTONS, (e) => {
        PERF.structureRecovery.shellNoButtonsEvents = Number(PERF.structureRecovery.shellNoButtonsEvents || 0) + 1;
        if (!S.running) return;
        if (!hasAnswersInDom()) return;
        if (!buildMissing()) return;
        const why = String(e?.detail?.reason || 'shell:no-buttons').trim() || 'shell:no-buttons';
        scheduleStructureRecoveryCheck(`shell:no-buttons:${why}`);
      }, { passive: true });
    }
    bindMiniMapScrollGuards();

    const onRouteChanged = () => {
      if (!S.running) return;
      resetVisibleAnswersObserver();
      scheduleFirstPaintRebuild('route');
    };
    try {
      window.addEventListener(EVT_ROUTE_CHANGED, onRouteChanged, true);
      window.addEventListener(EVT_ROUTE_CHANGED.replace(/^evt:/, ''), onRouteChanged, true);
      S.offRouteChanged = () => {
        try { window.removeEventListener(EVT_ROUTE_CHANGED, onRouteChanged, true); } catch {}
        try { window.removeEventListener(EVT_ROUTE_CHANGED.replace(/^evt:/, ''), onRouteChanged, true); } catch {}
      };
    } catch {}

    const onPaginationChanged = () => {
      if (!S.running) return;
      ensureChatPageDividerBridgeFromRuntime();
      const chatId = resolveChatId();
      try { MM_core()?.attachVisibleAnswers?.(chatId); } catch {}
      try { observeVisibleAnswers(currentAnswerEls()); } catch {}
      if (hasPendingPageJump()) return;
      if (paginationCoverageNeedsRebuild('pagination:pagechanged')) {
        scheduleRebuild('pagination:canonical-mismatch:pagechanged');
        return;
      }
      scheduleSyncActive('pagination:pagechanged');
    };
    S.offPaginationChanged = on(window, EVT_PAGE_CHANGED, onPaginationChanged, { passive: true });
    S.offPaginationChangedAlias = on(window, EVT_PAGE_CHANGED_ALIAS, onPaginationChanged, { passive: true });

    const onIndexHydrated = () => {
      if (!S.running) return;
      ensureChatPageDividerBridgeFromRuntime();
      const chatId = resolveChatId();
      try { MM_core()?.attachVisibleAnswers?.(chatId); } catch {}
      try { observeVisibleAnswers(currentAnswerEls()); } catch {}
      schedulePaginationCoverageCheck('index:hydrated');
      scheduleSyncActive('index:hydrated');
    };
    S.offIndexHydrated = on(window, EVT_MM_INDEX_HYDRATED, onIndexHydrated, { passive: true });

    const onIndexAppended = (e) => {
      if (!S.running) return;
      const detail = e?.detail || {};
      const msgId = String(detail?.msgId || detail?.answerId || '').trim();
      if (msgId) {
        const answerEl = findAnswerById(msgId);
        if (answerEl) {
          try { observeVisibleAnswers([answerEl], { incremental: true, prune: true }); } catch {}
        }
      }
      scheduleSyncActive('index:appended');
    };
    S.offIndexAppended = on(window, EVT_MM_INDEX_APPENDED, onIndexAppended, { passive: true });

    const onViewChanged = (e) => {
      if (!S.running) return;
      const detail = e?.detail || {};
      const modeFromEvent = String(detail?.mode || detail?.nextMode || '').trim();
      if (modeFromEvent) {
        if (modeFromEvent === String(S.lastViewMode || '').trim()) return;
        S.lastViewMode = modeFromEvent;
      } else {
        const modeNow = currentViewMode();
        if (modeNow && modeNow === String(S.lastViewMode || '').trim()) return;
        if (modeNow) S.lastViewMode = modeNow;
      }
      MM_scheduleRafOnce('minimap:view-refresh', () => {
        if (!S.running) return;
        if (refreshFromIndexedState('view:changed', { reconcileRows: true })) return;
        scheduleRebuild('view:changed');
      });
    };
    S.offViewChanged = on(window, EVT_MM_VIEW_CHANGED, onViewChanged, { passive: true });
  }

  function hasAnswersInDom() {
    try {
      if (hasAnswersInDomCheap()) return true;
      const list = MM_core()?.getAnswerList?.();
      if (Array.isArray(list)) return list.some((el) => !!el && el.isConnected);
      return false;
    } catch {
      return false;
    }
  }

  function hasAnswersInDomCheap() {
    try { return !!q(answersSelector()); } catch { return false; }
  }

  function getPaginationCoverageDetail() {
    try {
      return MM_core()?.validateTurnsAgainstPagination?.() || null;
    } catch {
      return null;
    }
  }

  function paginationCoverageNeedsRebuild(reason = 'pagination') {
    const detail = getPaginationCoverageDetail();
    if (!detail || !detail.applicable || detail.ok) return false;
    if (PERF_ASSERT_ON) {
      try { console.warn('[MiniMap] pagination canonical mismatch → rebuild', { reason, detail }); } catch {}
    }
    return true;
  }

  function schedulePaginationCoverageCheck(reason = 'pagination') {
    const why = String(reason || 'pagination');
    const run = (tag) => {
      if (!S.running) return;
      if (!paginationCoverageNeedsRebuild(`${why}:${tag}`)) return;
      scheduleRebuild(`pagination:canonical-mismatch:${why}:${tag}`);
    };

    const schedule = MM_schedule();
    cancelScheduledTask('minimap:pagination-check:fast', 'paginationCheckFastTimer');
    cancelScheduledTask('minimap:pagination-check:slow', 'paginationCheckSlowTimer');
    if (schedule) {
      S.paginationCheckFastTimer = schedule.timeoutOnce('minimap:pagination-check:fast', 120, () => {
        S.paginationCheckFastTimer = null;
        run('fast');
      });
      S.paginationCheckSlowTimer = schedule.timeoutOnce('minimap:pagination-check:slow', 700, () => {
        S.paginationCheckSlowTimer = null;
        run('slow');
      });
      return;
    }
    S.paginationCheckFastTimer = setTimeout(() => {
      S.paginationCheckFastTimer = null;
      run('fast');
    }, 120);
    S.paginationCheckSlowTimer = setTimeout(() => {
      S.paginationCheckSlowTimer = null;
      run('slow');
    }, 700);
  }

  function cacheBootNeedsRebuild(cacheResult) {
    const renderedCount = Number(cacheResult?.renderedCount || 0);
    const answersExist = hasAnswersInDomCheap();
    if (renderedCount === 0 && answersExist) return true;
    const lastAnswerId = String(cacheResult?.lastAnswerId || '').trim();
    const lastTurnId = String(cacheResult?.lastTurnId || '').trim();
    const probeId = lastAnswerId || lastTurnId;
    if (probeId && !findAnswerById(probeId)) return true;
    const paginationCoverage = cacheResult?.paginationCoverage || getPaginationCoverageDetail();
    if (paginationCoverage?.applicable && !paginationCoverage?.ok) return true;
    return false;
  }

  function buildMissing() {
    const core = MM_core();
    const turns = Number(core?.getTurnList?.()?.length || 0);
    let btns = 0;
    const scope = minimapCol() || minimapPanel() || null;
    if (scope) {
      markPerfFullScan();
      try { btns = Number(scope.querySelectorAll(mmBtnSelector()).length || 0); } catch {}
    } else {
      markPerfFullScan();
      btns = Number(qq(mmBtnSelector()).length || 0);
    }
    return turns <= 0 || btns <= 0;
  }

  function scheduleFirstPaintRebuild(reason = 'boot') {
    const why = String(reason || 'boot');
    const schedule = MM_schedule();
    cancelScheduledTask('minimap:first-paint', 'firstPaintRaf', 'raf');
    cancelScheduledTask('minimap:first-paint:failsafe', 'failsafeTimer');

    const stage = (tag) => {
      if (!S.running || !hasAnswersInDom()) return false;
      const probeReason = `boot:first-paint:${why}:${tag}`;
      if (buildMissing()) return scheduleRebuild(probeReason);
      if (paginationCoverageNeedsRebuild(probeReason)) {
        return scheduleRebuild(`pagination:canonical-mismatch:${probeReason}`);
      }
      return scheduleSyncActive(probeReason);
    };

    if (schedule) {
      S.firstPaintRaf = schedule.rafOnce('minimap:first-paint', () => {
        S.firstPaintRaf = 0;
        stage('raf');
      });
      S.failsafeTimer = schedule.timeoutOnce('minimap:first-paint:failsafe', 1000, () => {
        S.failsafeTimer = null;
        stage('1000ms');
      });
      return;
    }
    S.firstPaintRaf = requestAnimationFrame(() => {
      S.firstPaintRaf = 0;
      stage('raf');
    });
    S.failsafeTimer = setTimeout(() => {
      S.failsafeTimer = null;
      stage('1000ms');
    }, 1000);
  }

  function start(reason = 'engine:start') {
    if (S.running) return true;
    const core = MM_core();
    if (!core || TOPW.H2O_MM_CORE_READY !== true) {
      warn('Core not ready; runtime idle.', { reason });
      return false;
    }
    if (!shellReady()) {
      warn('Shell not ready; runtime idle.', { reason });
      return false;
    }

    S.running = true;

    // Shell owns first UI mount; engine only verifies refs once shell is ready.
    try { MM_ui()?.ensureUI?.(`engine:${reason}`); } catch (e) { derr('start:ensureUI', e); }
    try { core.initCore?.(); } catch (e) { derr('start:initCore', e); }
    try { ensureChatPageDividerBridgeFromRuntime(true); } catch (e) { derr('start:ensureChatPageDividerBridge', e); }
    try { ensureDelegatedHandlers(); } catch (e) { derr('start:bindDelegatedHandlers', e); }
    try { W.H2O?.MM?.dots?.attachInlineMutationObserver?.(); } catch (e) { derr('start:attachInlineMutationObserver', e); }

    const bootMode = getBootMode();
    const chatId = resolveChatId();
    S.lastViewMode = currentViewMode() || String(S.lastViewMode || '');
    let cacheResult = null;
    let cacheBootRendered = false;
    if (bootMode === BOOT_MODE_CACHE_FIRST && typeof core.renderFromCache === 'function') {
      try {
        cacheResult = core.renderFromCache(chatId);
        cacheBootRendered = !!cacheResult?.ok;
      } catch (e) {
        derr('start:renderFromCache', e);
        cacheBootRendered = false;
      }
      const mismatch = (!cacheResult || !cacheResult.ok) || cacheBootNeedsRebuild(cacheResult);
      if (mismatch) {
        try {
          const coverage = cacheResult?.paginationCoverage || getPaginationCoverageDetail();
          if (coverage?.applicable && !coverage?.ok) core.clearTurnCache?.(chatId);
        } catch (e) { derr('start:clearTurnCache', e); }
        if (PERF_ASSERT_ON) {
          try { console.warn('[MiniMap] cache mismatch → rebuild fallback'); } catch {}
        }
        scheduleRebuild('cache:mismatch');
      }
    }

    bindObservers();
    if (cacheBootRendered) {
      try { core.attachVisibleAnswers?.(chatId); } catch (e) { derr('start:attachVisibleAnswers:cache', e); }
      try { observeVisibleAnswers(currentAnswerEls()); } catch (e) { derr('start:observeVisibleAnswers:cache', e); }
      try { bindMiniMapScrollGuards(); } catch (e) { derr('start:bindMiniMapScrollGuards:cache', e); }
      scheduleSyncActive('boot:cache');
    } else if (hasAnswersInDom()) rebuildNow(`boot:answers-present:${reason}`);
    else scheduleRebuild(`boot:${reason}`);
    scheduleFirstPaintRebuild(reason);

    dlog('engine:start', {
      reason,
      bootMode,
      cacheBootRendered,
      cacheStatus: String(cacheResult?.status || ''),
    });
    return true;
  }

  const RUNTIME_API = {
    ver: ENGINE_VER,
    owner: 'engine',
    start,
    stop,
    scheduleRebuild,
    rebuildNow,
    getActiveTurnId,
    getActiveId: getActiveTurnId,
    setActiveTurnId,
    getTurnIndex,
    onTurnChange,
  };

  function installRuntimeApi() {
    try {
      const SH = TOPW.H2O_MM_SHARED?.get?.();
      if (SH?.api) SH.api.rt = Object.assign({}, SH.api.rt || {}, RUNTIME_API);
      return true;
    } catch {
      return false;
    }
  }

  function shellReady() {
    try { return TOPW.H2O_MM_SHELL_READY === true; } catch { return false; }
  }

  function depsReady() {
    const core = MM_core();
    const refs = MM_uiRefs();
    const hasUiRefs = !!(refs?.root && refs?.panel && refs?.toggle);
    return !!core
      && TOPW.H2O_MM_CORE_READY === true
      && shellReady()
      && hasUiRefs;
  }

  function clearBootTimer() {
    try { if (S.bootTimer) clearTimeout(S.bootTimer); } catch {}
    S.bootTimer = null;
  }

  function emitEngineReady() {
    try { window.dispatchEvent(new CustomEvent(EVT_ENGINE_READY, { detail: { ver: ENGINE_VER } })); } catch {}
  }

  function installDelegatedHandlersBridge() {
    try {
      if (typeof W.H2O_MM_bindDelegatedHandlersOnce !== 'function') {
        W.H2O_MM_bindDelegatedHandlersOnce = function H2O_MM_bindDelegatedHandlersOnce() {
          try { ensureDelegatedHandlers(); } catch {}
          return true;
        };
      }
    } catch {}
  }

  function bootAttempt(source = 'timer') {
    if (S.bootDone) return;
    diagAssertNoMainHelpers();

    S.bootTries++;
    if (!depsReady()) {
      if (S.bootTries >= BOOT_MAX_TRIES) {
        warn('Dependencies missing for runtime cutover; engine idle.', { source, tries: S.bootTries, coreReady: TOPW.H2O_MM_CORE_READY === true, shellReady: shellReady(), uiRefs: !!(MM_uiRefs()?.root && MM_uiRefs()?.panel && MM_uiRefs()?.toggle) });
        clearBootTimer();
      }
      return;
    }

    if (!installRuntimeApi()) return;
    if (!start(`boot:${source}`)) return;

    S.bootDone = true;
    if (!PERF.bootCompletedAt) PERF.bootCompletedAt = Date.now();
    markReady(true);
    emitEngineReady();
    clearBootTimer();
  }

  function scheduleBootTick() {
    clearBootTimer();
    S.bootTimer = setTimeout(() => {
      bootAttempt('retry');
      if (!S.bootDone && S.bootTries < BOOT_MAX_TRIES) scheduleBootTick();
    }, BOOT_GAP_MS);
  }

  function bindRetryHooks() {
    const retry = () => {
      if (S.bootDone) return;
      bootAttempt('event');
      if (!S.bootDone && S.bootTries < BOOT_MAX_TRIES) scheduleBootTick();
    };

    try {
      window.addEventListener(EVT_SHELL_READY, retry);
      S.offShellReady = () => { try { window.removeEventListener(EVT_SHELL_READY, retry); } catch {} };
    } catch {}

    try {
      const onBehaviorChanged = () => {
        try { behaviorApi()?.get?.(true); } catch {}
      };
      window.addEventListener(EVT_BEHAVIOR_CHANGED, onBehaviorChanged, true);
      S.offBehaviorChanged = () => { try { window.removeEventListener(EVT_BEHAVIOR_CHANGED, onBehaviorChanged, true); } catch {} };
    } catch {}
  }

  markPlugin();
  markReady(false);
  installDelegatedHandlersBridge();
  installRuntimeApi();
  bindRetryHooks();
  bootAttempt('init');
  if (!S.bootDone) scheduleBootTick();
})();
