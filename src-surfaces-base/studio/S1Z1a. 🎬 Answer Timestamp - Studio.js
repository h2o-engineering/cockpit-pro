// ==UserScript==
// @h2o-id             s1z1a.answer.timestamp.studio
// @name               S1Z1a. 🎬 Answer Timestamp - Studio
// @namespace          H2O.Premium.CGX.answer.timestamp
// @author             HumamDev
// @version            2.1.1
// @revision           002
// @build              260328-002627
// @description        Timestamp under every assistant message (H2O Core aware) + " | #". Contract v2 Stage-1 spine, cgxui hooks, idempotent boot/dispose, legacy-safe.
// @match              https://chatgpt.com/*
// @run-at             document-idle
// @grant              none
// ==/UserScript==

(() => {
  'use strict';

  /* =============================================================================
   * 🧱 H2O Module Standard — Contract (v2.0) — Stage 1: Foundation/Mechanics
   * - Identity-first, registries, cgxui-only hooks (alongside legacy), boot/dispose,
   *   cleanup, no feature loss.
   * ============================================================================= */

  /* ───────────────────────────── 0) IDENTITY ───────────────────────────── */

  /** @core Identity + namespace anchors (Contract v2.0) */
  const TOK = 'AT';                  // Answer Timestamp
  const PID = 'answrts';             // Answer Timestamp (pid-safe)
  const CID = 'ANSWERTIMESTAMP';     // constant prefix carrier
  const SkID = 'ats';                // Skin ID

  const MODTAG = 'AnswerTimestamp';
  const MODICON = '⏳';
  const EMOJI_HDR = '🔴';

  const SUITE = 'prm';
  const HOST  = 'cgx';

  // Aliases (readability only; NOT new identities)
  const DsID = PID;
  const BrID = PID;

  /* ───────────────────────────── 1) REGISTRIES ───────────────────────────── */

  /** @core Constants & registries (no raw selector/key/style IDs) */
  const STUDIO_SEL = window.H2O.Studio.SELECTORS;
  const SEL_ = Object.freeze({
    ASSIST_MSG: 'div[data-message-author-role="assistant"]',
    STAMP_OURS: ':scope > .cgxui-ats-ts',
    STAMP_LEGACY: ':scope > .chatgpt-timestamp',
    CONV_TURNS: STUDIO_SEL.sel.conversationTurns,
    CONV_TURN: STUDIO_SEL.sel.conversationTurn,
    MAIN: 'main',
  });

  const ATTR_ = Object.freeze({
    OWNER: 'data-cgxui-owner',
    UI:    'data-cgxui',
    STATE: 'data-cgxui-state',
  });

  const CSS_ = Object.freeze({
    STYLE_ID: `cgxui-${SkID}-style`,
    // Keep legacy class name alive for compatibility, but style via cgxui.
    STAMP_CLASS_OURS: 'cgxui-ats-ts',
    STAMP_CLASS_LEGACY: 'chatgpt-timestamp',
  });

  const EV_ = Object.freeze({
    // bus topics (Core)
    BUS_INDEX_UPDATED: 'index:updated',
    BUS_TURN_UPDATED:  'turn:updated',

    // window events (compat)
    WIN_CORE_READY:    'h2o:core:ready',
    WIN_INDEX_UPDATED: 'h2o:index:updated',
    WIN_TURN_UPDATED:  'h2o:turn:updated',
    WIN_ANS_SCAN:      'h2o:answers:scan',
    WIN_PW_CHANGED:    'evt:h2o:pagination:pagechanged',
    WIN_PW_CHANGED_COMPAT: 'h2o:pagination:pagechanged',
  });

  const CFG_ = Object.freeze({
    // initial refresh delay (keeps old behavior)
    INITIAL_SCAN_DELAY_MS: 1200,
    QUEUE_ALL_DEBOUNCE_MS: 250,
    MO_MAX_NODE_CHILDREN: 24,
    PERF_LOG_MS: 10000,
    PERF_KEY: 'h2o:perf',
  });

  const UI_CFG_ = Object.freeze({
    KEY: `h2o:${SUITE}:${HOST}:${DsID}:cfg:ui:v1`,
    DEFAULTS: Object.freeze({
      collapsedHoverMode: 'under',
    }),
    MODES: Object.freeze(['under', 'tooltip', 'title-right']),
  });


  const TITLE_BAR_SEL_ = '[data-cgxui="atns-answer-title"][data-cgxui-owner="atns"]';

  const CSS_VAR_ = Object.freeze({
    ANCHOR_LEFT: '--cgxui-ats-anchor-left',
    ANCHOR_TOP: '--cgxui-ats-anchor-top',
    ANCHOR_WIDTH: '--cgxui-ats-anchor-width',
    ANCHOR_HEIGHT: '--cgxui-ats-anchor-height',
    UNDER_TOP: '--cgxui-ats-under-top',
    UNDER_MAX: '--cgxui-ats-under-max',
    RIGHT_LEFT: '--cgxui-ats-right-left',
    RIGHT_MAX: '--cgxui-ats-right-max',
  });

  /* ───────────────────────────── 2) VAULT + BOUNDED DIAG ───────────────────────────── */

  /** @core Module vault (H2O[TOK][PID]) + bounded DIAG (H2O[TOK][BrID].diag) */
  const W = window;
  const DOC = document;

  W.H2O = W.H2O || {};
  W.H2O[TOK] = W.H2O[TOK] || {};
  W.H2O[TOK][PID] = W.H2O[TOK][PID] || {};

  const MOD = W.H2O[TOK][PID];
  MOD.diag  = MOD.diag  || {};
  MOD.state = MOD.state || {};
  MOD.api   = MOD.api   || {};

  W.H2O[TOK][BrID] = W.H2O[TOK][BrID] || {};
  W.H2O[TOK][BrID].diag = W.H2O[TOK][BrID].diag || MOD.diag;

  const DIAG = W.H2O[TOK][BrID].diag;

  /* ───────────────────────────── 2.5) PERF + ROOT HELPERS ───────────────────────────── */

  /** @helper */
  function CORE_AT_perfEnabled() {
    try { return W.localStorage?.getItem(CFG_.PERF_KEY) === '1'; } catch {}
    return false;
  }

  /** @helper */
  function CORE_AT_perfInc(key, n = 1) {
    const perf = MOD.state.perf;
    if (!perf?.enabled) return;
    perf[key] = (perf[key] || 0) + n;
  }

  /** @helper */
  function CORE_AT_startPerfTicker() {
    const st = MOD.state;
    st.perf = st.perf || {
      enabled: false,
      fullScans: 0,
      deltaUpdates: 0,
      labelsUpdated: 0,
      cacheHits: 0,
      timer: 0,
    };

    st.perf.enabled = CORE_AT_perfEnabled();
    if (!st.perf.enabled || st.perf.timer) return;

    st.perf.timer = W.setInterval(() => {
      const p = MOD.state.perf;
      if (!p?.enabled) return;
      try {
        console.log('[1Z1a][perf]', {
          fullScans: p.fullScans || 0,
          deltaUpdates: p.deltaUpdates || 0,
          labelsUpdated: p.labelsUpdated || 0,
          cacheHits: p.cacheHits || 0,
        });
      } catch {}
      p.fullScans = 0;
      p.deltaUpdates = 0;
      p.labelsUpdated = 0;
      p.cacheHits = 0;
    }, CFG_.PERF_LOG_MS);
  }

  /** @helper */
  function CORE_AT_stopPerfTicker() {
    const st = MOD.state;
    const p = st.perf;
    if (!p?.timer) return;
    try { W.clearInterval(p.timer); } catch {}
    p.timer = 0;
  }

  /** @helper */
  function UTIL_AT_isStudioMode() {
  try {
    if (window.H2O_STUDIO_MODE) return true;
    if (document.documentElement?.dataset?.h2oStudioMode === '1') return true;
    if (document.body?.dataset?.h2oStudioMode === '1') return true;
  } catch {}
  return false;
}

function DOM_AT_getStudioConversationRoot() {
  try {
    return (
      document.querySelector('[data-h2o-studio-reader="1"] [data-testid="conversation-turns"]') ||
      document.querySelector('.cgScroll[data-testid="conversation-turns"]') ||
      document.querySelector('[data-testid="conversation-turns"]')
    );
  } catch {
    return null;
  }
}

function DOM_AT_readStampedCreateTime(div) {
  const nodes = [
    div,
    div?.closest?.('[data-h2o-create-time]'),
    div?.querySelector?.('[data-h2o-create-time]')
  ].filter(Boolean);

  for (const node of nodes) {
    const raw = String(node?.getAttribute?.('data-h2o-create-time') || '').trim();
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return n;
  }

  return 0;
}

function DOM_AT_getConversationRoot() {
    if (UTIL_AT_isStudioMode()) {
      return DOM_AT_getStudioConversationRoot() || null;
    }

    const turns = DOC.querySelector(SEL_.CONV_TURNS);
    if (turns) return turns;
    const turn = DOC.querySelector(SEL_.CONV_TURN);
    if (turn?.parentElement) return turn.parentElement;
    return DOC.querySelector(SEL_.MAIN) || null;
  }


  /** @helper */
  function UI_AT_normalizeCfg(raw) {
    const src = (raw && typeof raw === 'object') ? raw : {};
    const mode = String(src.collapsedHoverMode || UI_CFG_.DEFAULTS.collapsedHoverMode).trim().toLowerCase();
    return {
      collapsedHoverMode: UI_CFG_.MODES.includes(mode) ? mode : UI_CFG_.DEFAULTS.collapsedHoverMode,
    };
  }

  /** @helper */
  function UI_AT_readCfg() {
    try {
      return UI_AT_normalizeCfg(JSON.parse(W.localStorage?.getItem(UI_CFG_.KEY) || '{}') || {});
    } catch {
      return { ...UI_CFG_.DEFAULTS };
    }
  }

  /** @helper */
  function UI_AT_writeCfg(next) {
    const cfg = UI_AT_normalizeCfg(next);
    try { W.localStorage?.setItem(UI_CFG_.KEY, JSON.stringify(cfg)); } catch {}
    return cfg;
  }

  /** @helper */
  function UI_AT_applyCfg() {
    const cfg = UI_AT_readCfg();
    try { DOC.documentElement?.setAttribute?.('data-cgxui-ats-collapsed-hover-mode', cfg.collapsedHoverMode); } catch {}
    MOD.state.uiCfg = cfg;
    return cfg;
  }

  /** @helper */
  function DOM_AT_clearAnchorVars(msgEl) {
    if (!msgEl?.style) return;
    for (const key of Object.values(CSS_VAR_)) {
      try { msgEl.style.removeProperty(key); } catch {}
    }
  }

  /** @helper */
  function DOM_AT_syncAnchorVars(msgEl, titleEl) {
    if (!msgEl || !titleEl) return;
    const mr = msgEl.getBoundingClientRect?.();
    const tr = titleEl.getBoundingClientRect?.();
    if (!mr || !tr) return;

    const left = Math.max(0, Math.round(tr.left - mr.left));
    const top = Math.max(0, Math.round(tr.top - mr.top));
    const width = Math.max(0, Math.round(tr.width));
    const height = Math.max(0, Math.round(tr.height));
    const gap = 8;

    const underTop = top + height + 6;
    const underMax = Math.max(160, Math.round(mr.width - left - 12));
    const rightLeft = left + width + gap;
    const rightMax = Math.max(120, Math.round(mr.width - rightLeft - 12));

    msgEl.style.setProperty(CSS_VAR_.ANCHOR_LEFT, `${left}px`);
    msgEl.style.setProperty(CSS_VAR_.ANCHOR_TOP, `${top}px`);
    msgEl.style.setProperty(CSS_VAR_.ANCHOR_WIDTH, `${width}px`);
    msgEl.style.setProperty(CSS_VAR_.ANCHOR_HEIGHT, `${height}px`);
    msgEl.style.setProperty(CSS_VAR_.UNDER_TOP, `${underTop}px`);
    msgEl.style.setProperty(CSS_VAR_.UNDER_MAX, `${underMax}px`);
    msgEl.style.setProperty(CSS_VAR_.RIGHT_LEFT, `${rightLeft}px`);
    msgEl.style.setProperty(CSS_VAR_.RIGHT_MAX, `${rightMax}px`);
  }

  /** @helper */
  function DOM_AT_syncAnchorFromNode(node) {
    const titleEl = node?.closest?.(TITLE_BAR_SEL_) || null;
    const msgEl = titleEl?.closest?.(SEL_.ASSIST_MSG) || null;
    if (!titleEl || !msgEl) return;
    if (String(msgEl.getAttribute('data-at-collapsed') || '') !== '1') return;
    DOM_AT_syncAnchorVars(msgEl, titleEl);
  }

  /** @helper */
  function CORE_AT_bindTitleHoverAnchors() {
    const st = MOD.state;

    const onPointer = (evt) => DOM_AT_syncAnchorFromNode(evt.target);
    const onResize = () => {
      DOC.querySelectorAll(`${SEL_.ASSIST_MSG}[data-at-collapsed="1"] ${TITLE_BAR_SEL_}`).forEach((titleEl) => {
        const msgEl = titleEl.closest(SEL_.ASSIST_MSG);
        if (msgEl) DOM_AT_syncAnchorVars(msgEl, titleEl);
      });
    };

    W.addEventListener('pointerover', onPointer, true);
    W.addEventListener('pointermove', onPointer, true);
    W.addEventListener('mouseover', onPointer, true);
    W.addEventListener('mousemove', onPointer, true);
    W.addEventListener('focusin', onPointer, true);
    W.addEventListener('resize', onResize, true);
    W.addEventListener('scroll', onResize, true);

    st.cleanup.push(() => W.removeEventListener('pointerover', onPointer, true));
    st.cleanup.push(() => W.removeEventListener('pointermove', onPointer, true));
    st.cleanup.push(() => W.removeEventListener('mouseover', onPointer, true));
    st.cleanup.push(() => W.removeEventListener('mousemove', onPointer, true));
    st.cleanup.push(() => W.removeEventListener('focusin', onPointer, true));
    st.cleanup.push(() => W.removeEventListener('resize', onResize, true));
    st.cleanup.push(() => W.removeEventListener('scroll', onResize, true));
  }

  /* ───────────────────────────── 3) UI — CSS (idempotent) ───────────────────────────── */

  /** @critical */
  function UI_AT_injectCSSOnce() {
    if (DOC.getElementById(CSS_.STYLE_ID)) return;

    const style = DOC.createElement('style');
    style.id = CSS_.STYLE_ID;
    style.textContent = `
/* ${EMOJI_HDR} ${MODICON} ${MODTAG} — cgxui-only styling (legacy class kept for compatibility) */
.${CSS_.STAMP_CLASS_OURS},
.${CSS_.STAMP_CLASS_LEGACY}{
  font-size: 12px;
  color: #999;
  font-weight: 200;
  margin-top: 1px;
  margin-bottom: 1px;
  text-align: left;
  margin-left: 0;
  padding-left: 1px;
  width: 100%;
  max-width: 100vw;
  display: block;
  font-family: ui-monospace, "SF Mono", Monaco, monospace;
  transition: opacity 160ms ease, visibility 0s linear 160ms, transform 160ms ease;
}

${SEL_.ASSIST_MSG}{
  position: relative;
}

${SEL_.ASSIST_MSG}[data-at-collapsed="1"] > .${CSS_.STAMP_CLASS_OURS},
${SEL_.ASSIST_MSG}[data-at-collapsed="1"] > .${CSS_.STAMP_CLASS_LEGACY}{
  opacity: 0;
  visibility: hidden;
  margin: 0;
  pointer-events: none;
  position: absolute;
  left: var(${CSS_VAR_.ANCHOR_LEFT}, 10px);
  top: var(${CSS_VAR_.UNDER_TOP}, 42px);
  width: max-content;
  max-width: min(var(${CSS_VAR_.UNDER_MAX}, 320px), calc(100% - 12px));
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  z-index: 6;
}

html[data-cgxui-ats-collapsed-hover-mode="title-right"] ${SEL_.ASSIST_MSG}[data-at-collapsed="1"] > .${CSS_.STAMP_CLASS_OURS},
html[data-cgxui-ats-collapsed-hover-mode="title-right"] ${SEL_.ASSIST_MSG}[data-at-collapsed="1"] > .${CSS_.STAMP_CLASS_LEGACY}{
  top: calc(var(${CSS_VAR_.ANCHOR_TOP}, 9px) + (var(${CSS_VAR_.ANCHOR_HEIGHT}, 28px) / 2));
  left: var(${CSS_VAR_.RIGHT_LEFT}, 220px);
  width: max-content;
  max-width: min(var(${CSS_VAR_.RIGHT_MAX}, 320px), calc(100% - 12px));
  transform: translateY(-50%);
}

html[data-cgxui-ats-collapsed-hover-mode="under"] ${SEL_.ASSIST_MSG}[data-at-collapsed="1"]:has(${TITLE_BAR_SEL_}:hover) > .${CSS_.STAMP_CLASS_OURS},
html[data-cgxui-ats-collapsed-hover-mode="under"] ${SEL_.ASSIST_MSG}[data-at-collapsed="1"]:has(${TITLE_BAR_SEL_}:hover) > .${CSS_.STAMP_CLASS_LEGACY}{
  opacity: 1;
  visibility: visible;
  transition-delay: 0s;
  top: var(${CSS_VAR_.UNDER_TOP}, 42px);
  left: var(${CSS_VAR_.ANCHOR_LEFT}, 10px);
  width: max-content;
  max-width: min(var(${CSS_VAR_.UNDER_MAX}, 320px), calc(100% - 12px));
  padding: 0;
  background: transparent;
  border: 0;
  box-shadow: none;
  border-radius: 0;
  color: #999;
  text-align: left;
  transform: none;
}

html[data-cgxui-ats-collapsed-hover-mode="tooltip"] ${SEL_.ASSIST_MSG}[data-at-collapsed="1"]:has(${TITLE_BAR_SEL_}:hover) > .${CSS_.STAMP_CLASS_OURS},
html[data-cgxui-ats-collapsed-hover-mode="tooltip"] ${SEL_.ASSIST_MSG}[data-at-collapsed="1"]:has(${TITLE_BAR_SEL_}:hover) > .${CSS_.STAMP_CLASS_LEGACY}{
  opacity: 1;
  visibility: visible;
  transition-delay: 0s;
  top: var(${CSS_VAR_.UNDER_TOP}, 42px);
  left: var(${CSS_VAR_.ANCHOR_LEFT}, 10px);
  width: max-content;
  max-width: min(var(${CSS_VAR_.UNDER_MAX}, 420px), calc(100% - 20px));
  padding: 7px 12px;
  border-radius: 10px;
  background: rgba(18, 20, 26, 0.92);
  border: 1px solid rgba(255,255,255,0.16);
  box-shadow: 0 10px 24px rgba(0,0,0,0.34);
  color: rgba(233,236,243,0.96);
  transform: none;
}

html[data-cgxui-ats-collapsed-hover-mode="title-right"] ${SEL_.ASSIST_MSG}[data-at-collapsed="1"]:has(${TITLE_BAR_SEL_}:hover) > .${CSS_.STAMP_CLASS_OURS},
html[data-cgxui-ats-collapsed-hover-mode="title-right"] ${SEL_.ASSIST_MSG}[data-at-collapsed="1"]:has(${TITLE_BAR_SEL_}:hover) > .${CSS_.STAMP_CLASS_LEGACY}{
  opacity: 1;
  visibility: visible;
  transition-delay: 0s;
  top: calc(var(${CSS_VAR_.ANCHOR_TOP}, 9px) + (var(${CSS_VAR_.ANCHOR_HEIGHT}, 28px) / 2));
  left: var(${CSS_VAR_.RIGHT_LEFT}, 220px);
  right: auto;
  width: max-content;
  max-width: min(var(${CSS_VAR_.RIGHT_MAX}, 320px), calc(100% - 12px));
  padding: 2px 8px;
  border-radius: 8px;
  background: rgba(255,255,255,0.05);
  color: rgba(214,219,229,0.92);
  font-size: 11px;
  text-align: left;
  transform: translateY(-50%);
}
    `.trim();

    DOC.head.appendChild(style);

    MOD.state.styleEl = style;
    MOD.state.cleanup = MOD.state.cleanup || [];
    MOD.state.cleanup.push(() => {
      try { style.remove(); } catch {}
      MOD.state.styleEl = null;
    });
  }

  /* ───────────────────────────── 4) HELPERS (no feature loss) ───────────────────────────── */

  const UTIL_AT_months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

  /** @helper */
  function UTIL_AT_pad2(n) { return String(n).padStart(2, '0'); }

  /** @helper */
  function UTIL_AT_formatLocal(tsSeconds) {
    const d = new Date(tsSeconds * 1000);
    return `${UTIL_AT_months[d.getMonth()]} ${d.getDate()} - ${UTIL_AT_pad2(d.getHours())}:${UTIL_AT_pad2(d.getMinutes())}`;
  }

  // Fallback (cache per element so fiber scanning happens once)
  const STORE_AT_TS_cache = new WeakMap();       // div -> number|null
  const STORE_AT_REACTKEY_cache = new WeakMap(); // div -> string|null

  /** @helper */
  function DOM_AT_getReactFiberKey(div) {
    if (STORE_AT_REACTKEY_cache.has(div)) return STORE_AT_REACTKEY_cache.get(div);
    const k =
      Object.keys(div).find(x => x.startsWith('__reactFiber$')) ||
      Object.keys(div).find(x => x.startsWith('__reactProps$')) ||
      null;
    STORE_AT_REACTKEY_cache.set(div, k);
    return k;
  }

  /** @helper */
  function DOM_AT_findCreateTimeFromReact(div) {
    const reactKey = DOM_AT_getReactFiberKey(div);
    if (!reactKey) return null;

    // props shape
    if (reactKey.startsWith('__reactProps$')) {
      const p = div[reactKey];
      const t = p?.messages?.[0]?.create_time ?? p?.message?.create_time ?? null;
      return (typeof t === 'number' && isFinite(t) && t > 0) ? t : null;
    }

    // fiber shape
    let f = div[reactKey];
    for (let i = 0; i < 18 && f; i++) {
      const mp = f.memoizedProps;
      const t =
        mp?.messages?.[0]?.create_time ??
        mp?.message?.create_time ??
        mp?.children?.props?.messages?.[0]?.create_time ??
        mp?.children?.props?.message?.create_time ??
        null;
      if (typeof t === 'number' && isFinite(t) && t > 0) return t;
      f = f.return;
    }
    return null;
  }

  /** @critical */
  function DOM_AT_getCreateTime(div) {
    const stamped = DOM_AT_readStampedCreateTime(div);
    if (Number.isFinite(stamped) && stamped > 0) return stamped;

    const core = W.H2O?.time?.getCreateTime?.(div);
    if (Number.isFinite(core) && core > 0) return core;

    if (STORE_AT_TS_cache.has(div)) return STORE_AT_TS_cache.get(div);

    const ts = DOM_AT_findCreateTimeFromReact(div);
    const ok = (typeof ts === 'number' && isFinite(ts) && ts > 0) ? ts : null;
    STORE_AT_TS_cache.set(div, ok);
    return ok;
  }

  /** @helper */
  function DOM_AT_getPaginationTurnOffset() {
    const api = W.H2O_Pagination;
    const H = W.H2O;
    if (!api || typeof api.getPageInfo !== 'function') return 0;

    let info = null;
    try { info = api.getPageInfo(); } catch (_) { info = null; }
    if (!info || info.enabled === false) return 0;

    const totalCanonical = Math.max(
      Number(info?.totalTurns || 0),
      Number(info?.totalAnswers || 0),
      Number(info?.answerRange?.total || 0),
      Number(info?.bufferedAnswerRange?.total || 0),
    );
    const localTurns = Number(H?.turn?.total?.() || 0);
    if (!Number.isFinite(totalCanonical) || totalCanonical <= 0) return 0;
    if (!Number.isFinite(localTurns) || localTurns <= 0 || localTurns >= totalCanonical) return 0;

    const start = Math.max(
      0,
      Number(info?.bufferedAnswerRange?.start || info?.answerRange?.start || 0) || 0,
    );
    return start > 1 ? (start - 1) : 0;
  }

  /** @helper */
  function DOM_AT_getCanonicalTurnIndexFromRuntime(div) {
    const rt = W.H2O?.turnRuntime;
    if (!rt) return null;

    const aId = String(
      W.H2O?.msg?.getIdFromEl?.(div)
      || div?.getAttribute?.('data-message-id')
      || div?.dataset?.messageId
      || ''
    ).trim();
    if (!aId) return null;

    try {
      const record = rt.getTurnRecordByAId?.(aId) || null;
      const turnNo = Number(record?.turnNo || record?.idx || 0);
      return (Number.isFinite(turnNo) && turnNo > 0) ? turnNo : null;
    } catch (_) {
      return null;
    }
  }

  /** @helper */
  function DOM_AT_getTurnIndex(div) {
    const canonical = DOM_AT_getCanonicalTurnIndexFromRuntime(div);
    if (canonical) return canonical;

    const t0 = W.H2O?.turn?.getTurnIndexByAEl?.(div);
    if (!Number.isFinite(t0) || t0 <= 0) return null;
    return t0 + DOM_AT_getPaginationTurnOffset();
  }

  /** @helper */
  function DOM_AT_getAIndex(div) {
    const a0 = W.H2O?.index?.getAIndex?.(div);
    if (Number.isFinite(a0) && a0 > 0) return a0;

    const cached = MOD.state.domAIndexMap?.get?.(div);
    if (Number.isFinite(cached) && cached > 0) {
      CORE_AT_perfInc('cacheHits');
      return cached;
    }
    return null;
  }

  /** @helper */
  function DOM_AT_rebuildDomAIndexMap(root) {
    const map = new WeakMap();
    if (!root) {
      MOD.state.domAIndexMap = map;
      MOD.state.domAIndexCounter = 0;
      return;
    }

    const all = root.querySelectorAll?.(SEL_.ASSIST_MSG) || [];
    let idx = 0;
    for (const el of all) {
      idx += 1;
      map.set(el, idx);
    }
    MOD.state.domAIndexMap = map;
    MOD.state.domAIndexCounter = idx;
  }

  /** @helper */
  function DOM_AT_seedDomAIndexFromDelta(div) {
    const st = MOD.state;
    st.domAIndexMap = st.domAIndexMap || new WeakMap();
    if (st.domAIndexMap.has(div)) return;
    st.domAIndexCounter = (st.domAIndexCounter || 0) + 1;
    st.domAIndexMap.set(div, st.domAIndexCounter);
  }

  /** @critical */
  function UI_AT_buildLabel(div) {
    const ts = DOM_AT_getCreateTime(div);
    if (!ts) return null;

    const base = W.H2O?.time?.format?.(ts) || UTIL_AT_formatLocal(ts);

    // Prefer turn index to stay aligned with Turn(Q→A) system.
    const tIdx = DOM_AT_getTurnIndex(div);
    const aIdx = DOM_AT_getAIndex(div);

    if (tIdx) return `${base} | ${tIdx}`;
    if (aIdx) return `${base} | ${aIdx}`;
    return `${base}`;
  }

  /* ───────────────────────────── 5) DOM APPLY ───────────────────────────── */

  /** @critical */
  function DOM_AT_addOrUpdateOne(div) {
    if (!div || div.nodeType !== 1) return;

    const fullLabel = UI_AT_buildLabel(div);
    if (!fullLabel) return;

    let stamp =
      div.querySelector(SEL_.STAMP_OURS) ||
      div.querySelector(SEL_.STAMP_LEGACY) ||
      null;

    if (!stamp) {
      stamp = DOC.createElement('div');
      stamp.className = `${CSS_.STAMP_CLASS_LEGACY} ${CSS_.STAMP_CLASS_OURS}`;
      stamp.setAttribute(ATTR_.OWNER, SkID);
      stamp.setAttribute(ATTR_.UI, `${SkID}-stamp`);
      div.appendChild(stamp);
    } else {
      // Upgrade existing stamp node without breaking old styling/hooks
      if (!stamp.classList.contains(CSS_.STAMP_CLASS_OURS)) stamp.classList.add(CSS_.STAMP_CLASS_OURS);
      if (!stamp.classList.contains(CSS_.STAMP_CLASS_LEGACY)) stamp.classList.add(CSS_.STAMP_CLASS_LEGACY);
      if (!stamp.getAttribute(ATTR_.OWNER)) stamp.setAttribute(ATTR_.OWNER, SkID);
      if (!stamp.getAttribute(ATTR_.UI)) stamp.setAttribute(ATTR_.UI, `${SkID}-stamp`);
    }

    if (stamp.dataset.fullLabel !== fullLabel) {
      stamp.textContent = fullLabel;
      stamp.dataset.fullLabel = fullLabel;
      CORE_AT_perfInc('labelsUpdated');
    }

    const titleEl = div.querySelector?.(TITLE_BAR_SEL_) || null;
    if (String(div.getAttribute('data-at-collapsed') || '') === '1' && titleEl) {
      DOM_AT_syncAnchorVars(div, titleEl);
    } else {
      DOM_AT_clearAnchorVars(div);
    }
  }

  /* ───────────────────────────── 5b) STUDIO GOVERNED PATH (M03 P4 S4C T8 slice B) ─────────────────────────────
   * In a current M03 Studio Reader render the Renderer exposes, through the Reader
   * bridge, a read-only Semantic Index (target authority) and a per-render
   * DecorationContribution lifecycle (mutation authority). On that path the
   * assistant targets are the index's assistant MESSAGE projections - never a
   * provider-selector scan - and every stamp create / update / remove happens
   * inside one registered contribution per assistant message (owner
   * `studio-answer-timestamp`, id = the message projectionKey). Label semantics
   * (UI_AT_buildLabel), classes, cgxui attributes, dataset.fullLabel and the
   * collapsed-hover anchor variables are the accepted ones, unchanged. The
   * legacy DOM path below stays as the compatibility fallback (non-Studio,
   * no current Reader render, older host). Handles live only for the current
   * lifecycle instance; Reader disposeAll cleans up a discarded render.
   * ───────────────────────────────────────────────────────────────────────── */

  /** @core Consumer identity for the DecorationContribution lifecycle (deterministic, per render) */
  const GOV_ = Object.freeze({
    OWNER: 'studio-answer-timestamp',
    INDEX_SCHEMA: 'h2o.renderer.semantic-index',
    LIFECYCLE_SCHEMA: 'h2o.renderer.decoration-contribution',
    DIAG_ERR_MAX: 8,
  });

  // Consumer-local, ephemeral: handles for the CURRENT lifecycle only. Not a registry, never persisted.
  const STORE_AT_governed = { lifecycle: null, handles: new Map() };

  /** @helper bounded diagnostics for the governed path (H2O.AT.answrts.diag.governed) */
  function GOV_AT_diag(op, key, error) {
    try {
      const g = DIAG.governed = DIAG.governed || { errors: [], lastError: null };
      const entry = { op: String(op), key: String(key || ''), message: String((error && error.message) || error || '') };
      g.lastError = entry;
      g.errors.push(entry);
      if (g.errors.length > GOV_.DIAG_ERR_MAX) g.errors.splice(0, g.errors.length - GOV_.DIAG_ERR_MAX);
    } catch {}
  }

  /** @critical The current Reader render's contracts, or null (-> compatibility fallback). */
  function GOV_AT_currentRender() {
    if (!UTIL_AT_isStudioMode()) return null;
    const studio = W.H2O?.Studio;
    if (typeof studio?.getReaderSemanticIndex !== 'function' || typeof studio?.getReaderDecorationContributions !== 'function') return null;
    let semanticIndex = null;
    let root = null;
    let lifecycle = null;
    try {
      semanticIndex = studio.getReaderSemanticIndex();
      if (!semanticIndex || semanticIndex.schema !== GOV_.INDEX_SCHEMA || typeof semanticIndex.messages !== 'function' || typeof semanticIndex.getConversation !== 'function') return null;
      root = semanticIndex.getConversation()?.target || null;
      if (!root || root.nodeType !== 1 || !root.isConnected) return null;
      // Root-bound: the lifecycle must be the one the Reader holds for THIS root, and it must be bound to this index.
      lifecycle = studio.getReaderDecorationContributions(root);
    } catch {
      return null;
    }
    if (!lifecycle || lifecycle.schema !== GOV_.LIFECYCLE_SCHEMA || typeof lifecycle.register !== 'function' || typeof lifecycle.get !== 'function') return null;
    if (lifecycle.semanticIndex !== semanticIndex) return null;
    return { root, semanticIndex, lifecycle };
  }

  /** @helper Handles are scoped to one lifecycle instance; a new render forgets the stale ones (Reader disposeAll owns the old cleanup). */
  function GOV_AT_handlesFor(lifecycle) {
    const store = STORE_AT_governed;
    if (store.lifecycle !== lifecycle) {
      store.lifecycle = lifecycle;
      store.handles = new Map();
    }
    return store.handles;
  }

  /** @helper Release the handles this module owns (module dispose): stamps go with them. */
  function GOV_AT_releaseHandles() {
    const store = STORE_AT_governed;
    const handles = Array.from(store.handles.values());
    store.lifecycle = null;
    store.handles = new Map();
    for (const handle of handles) {
      try { handle.dispose(); } catch (e) { GOV_AT_diag('dispose', handle?.contributionKey, e); }
    }
  }

  /** @helper Assistant message projections of the index, in projection order (the target authority). */
  function GOV_AT_assistantProjections(semanticIndex) {
    let records = [];
    try { records = semanticIndex.messages() || []; } catch (e) { GOV_AT_diag('messages', '', e); return []; }
    const out = [];
    for (const record of records) {
      if (!record || record.kind !== 'message' || record.role !== 'assistant') continue;
      const target = record.target;
      if (!record.projectionKey || !target || target.nodeType !== 1) continue;
      out.push(record);
    }
    return out;
  }

  /** @helper Same numbering fallback as DOM_AT_rebuildDomAIndexMap, fed by projections instead of a selector scan. */
  function GOV_AT_rebuildDomAIndexMap(projections) {
    const map = new WeakMap();
    let idx = 0;
    for (const record of projections) {
      idx += 1;
      map.set(record.target, idx);
    }
    MOD.state.domAIndexMap = map;
    MOD.state.domAIndexCounter = idx;
  }

  /** @helper Our stamp under the exact target: adopt an existing one (own/legacy class) or create it with the accepted classes/attributes. */
  function GOV_AT_ensureStamp(msgEl) {
    let stamp =
      msgEl.querySelector(SEL_.STAMP_OURS) ||
      msgEl.querySelector(SEL_.STAMP_LEGACY) ||
      null;
    if (!stamp) {
      stamp = DOC.createElement('div');
      stamp.className = `${CSS_.STAMP_CLASS_LEGACY} ${CSS_.STAMP_CLASS_OURS}`;
      stamp.setAttribute(ATTR_.OWNER, SkID);
      stamp.setAttribute(ATTR_.UI, `${SkID}-stamp`);
      msgEl.appendChild(stamp);
    } else {
      if (!stamp.classList.contains(CSS_.STAMP_CLASS_OURS)) stamp.classList.add(CSS_.STAMP_CLASS_OURS);
      if (!stamp.classList.contains(CSS_.STAMP_CLASS_LEGACY)) stamp.classList.add(CSS_.STAMP_CLASS_LEGACY);
      if (!stamp.getAttribute(ATTR_.OWNER)) stamp.setAttribute(ATTR_.OWNER, SkID);
      if (!stamp.getAttribute(ATTR_.UI)) stamp.setAttribute(ATTR_.UI, `${SkID}-stamp`);
    }
    return stamp;
  }

  /** @critical The accepted per-message mutation (label, dataset.fullLabel, anchors) bound to ONE contribution target. */
  function GOV_AT_syncStamp(msgEl, stampRef) {
    const fullLabel = UI_AT_buildLabel(msgEl);
    if (!fullLabel) return; // no create time yet: no stamp (same as the legacy path)

    if (!stampRef.el || stampRef.el.parentNode !== msgEl) stampRef.el = GOV_AT_ensureStamp(msgEl);
    const stamp = stampRef.el;

    if (stamp.dataset.fullLabel !== fullLabel) {
      stamp.textContent = fullLabel;
      stamp.dataset.fullLabel = fullLabel;
      CORE_AT_perfInc('labelsUpdated');
    }

    const titleEl = msgEl.querySelector?.(TITLE_BAR_SEL_) || null;
    if (String(msgEl.getAttribute('data-at-collapsed') || '') === '1' && titleEl) {
      DOM_AT_syncAnchorVars(msgEl, titleEl);
    } else {
      DOM_AT_clearAnchorVars(msgEl);
    }
  }

  /** @critical DecorationContribution application factory: apply once, then update / dispose through the lifecycle. */
  function GOV_AT_applyStamp(context) {
    const msgEl = context.target; // the exact indexed assistant message Element
    const stampRef = { el: null };
    GOV_AT_syncStamp(msgEl, stampRef);
    return {
      update() {
        GOV_AT_syncStamp(msgEl, stampRef);
      },
      dispose() {
        const stamp = stampRef.el;
        stampRef.el = null;
        if (stamp && stamp.parentNode === msgEl) {
          try { stamp.remove(); } catch {}
        }
        DOM_AT_clearAnchorVars(msgEl);
      },
    };
  }

  /** @critical Governed reconciliation: one contribution per assistant projection; repeats update, never duplicate. */
  function GOV_AT_reconcile(render) {
    const { semanticIndex, lifecycle } = render;
    const handles = GOV_AT_handlesFor(lifecycle);
    const projections = GOV_AT_assistantProjections(semanticIndex);
    GOV_AT_rebuildDomAIndexMap(projections);

    for (const record of projections) {
      const key = record.projectionKey;
      const handle = handles.get(key);
      if (handle) {
        if (lifecycle.get(handle.contributionKey)) {
          try { handle.update({ reason: 'reconcile' }); } catch (e) { GOV_AT_diag('update', key, e); }
          continue;
        }
        handles.delete(key); // disposed elsewhere: register afresh below
      }
      try {
        const registered = lifecycle.register({
          owner: GOV_.OWNER,
          id: key,
          targetKey: key,
          value: { reason: 'reconcile' },
          apply: GOV_AT_applyStamp,
        });
        handles.set(key, registered);
      } catch (e) {
        GOV_AT_diag('register', key, e);
      }
    }
    return projections.length;
  }

  /** @helper Mutations produced by our own stamps never re-trigger a reconciliation. */
  function GOV_AT_mutationsOwned(muts) {
    for (const m of muts) {
      const target = m.target;
      if (target && target.nodeType === 1 && target.getAttribute?.(ATTR_.OWNER) === SkID) continue;
      const added = m.addedNodes;
      if (!added || !added.length) continue;
      for (const n of added) {
        if (n.nodeType !== 1 || n.getAttribute?.(ATTR_.OWNER) !== SkID) return false;
      }
    }
    return true;
  }

  /* ───────────────────────────── 6) SCHEDULER (no spam) ───────────────────────────── */

  const STORE_AT_pendingRoots = new Set();
  let STORE_AT_rafQueued = false;

  /** @helper */
  function DOM_AT_queueRoot(node, opts = null) {
    if (!node || node.nodeType !== 1) return;

    const convRoot = DOM_AT_getConversationRoot();
    if (UTIL_AT_isStudioMode() && convRoot && node !== convRoot) {
      if (!(convRoot.contains?.(node))) return;
    }
    if (opts?.full) MOD.state.pendingFullScan = true;
    if (opts?.delta) {
      CORE_AT_perfInc('deltaUpdates');
      if (node.matches?.(SEL_.ASSIST_MSG)) DOM_AT_seedDomAIndexFromDelta(node);
    }
    STORE_AT_pendingRoots.add(node);
    DOM_AT_scheduleFlush();
  }

  /** @helper */
  function DOM_AT_scheduleFlush() {
    if (STORE_AT_rafQueued) return;
    STORE_AT_rafQueued = true;
    requestAnimationFrame(() => {
      STORE_AT_rafQueued = false;
      DOM_AT_flush();
    });
  }

  /** @critical */
  function DOM_AT_flush() {
    const st = MOD.state;
    let roots = Array.from(STORE_AT_pendingRoots);
    STORE_AT_pendingRoots.clear();

    // M03 S4C slice B: a governed Studio render reconciles its assistant projections
    // through the Semantic Index + DecorationContribution; no selector-based target
    // discovery and no direct DOM_AT_addOrUpdateOne on this path.
    const governed = GOV_AT_currentRender();
    if (governed) {
      if (st.pendingFullScan) {
        st.pendingFullScan = false;
        CORE_AT_perfInc('fullScans');
      }
      GOV_AT_reconcile(governed);
      return;
    }

    if (st.pendingFullScan) {
      st.pendingFullScan = false;
      const fullRoot = DOM_AT_getConversationRoot() || DOC.body;
      DOM_AT_rebuildDomAIndexMap(fullRoot);
      roots = [fullRoot];
      CORE_AT_perfInc('fullScans');
    }

    for (const root of roots) {
      if (root.matches?.(SEL_.ASSIST_MSG)) {
        DOM_AT_addOrUpdateOne(root);
        continue;
      }
      const answers = root.querySelectorAll?.(SEL_.ASSIST_MSG);
      if (!answers || !answers.length) continue;
      answers.forEach(DOM_AT_addOrUpdateOne);
    }
  }

  /** @helper */
  function DOM_AT_queueAllAssistants() {
    CORE_AT_attachFallbackMO();
    const root = DOM_AT_getConversationRoot();
    if (root) {
      DOM_AT_queueRoot(root, { full: true });
      return;
    }
    // fallback safety only when conversation container is unavailable
    DOM_AT_queueRoot(DOC.body, { full: true });
  }

  /** @helper */
  function DOM_AT_queueAllAssistantsDebounced() {
    const st = MOD.state;
    if (st.queueAllTimer) return;
    st.queueAllTimer = W.setTimeout(() => {
      st.queueAllTimer = 0;
      DOM_AT_queueAllAssistants();
    }, CFG_.QUEUE_ALL_DEBOUNCE_MS);
  }

  /* ───────────────────────────── 7) HOOKS (Core + fallback) ───────────────────────────── */

  /** @critical */
  function CORE_AT_hookCore() {
    const st = MOD.state;
    if (st.coreHooked) return;

    // Must be tolerant: some deployments expose bus later.
    if (!W.H2O?.bus && !W.H2O?.index) return;

    st.coreHooked = true;
    const onCoreReindex = () => DOM_AT_queueAllAssistantsDebounced();

    // Bus topics (if present)
    try { W.H2O?.bus?.on?.(EV_.BUS_INDEX_UPDATED, onCoreReindex); } catch {}
    try { W.H2O?.bus?.on?.(EV_.BUS_TURN_UPDATED,  onCoreReindex); } catch {}

    // Window events (compat)
    W.addEventListener(EV_.WIN_INDEX_UPDATED, onCoreReindex, { passive: true });
    W.addEventListener(EV_.WIN_TURN_UPDATED,  onCoreReindex, { passive: true });
    W.addEventListener(EV_.WIN_ANS_SCAN,      onCoreReindex, { passive: true });
    W.addEventListener(EV_.WIN_PW_CHANGED, onCoreReindex, { passive: true });
    W.addEventListener(EV_.WIN_PW_CHANGED_COMPAT, onCoreReindex, { passive: true });

    st.cleanup = st.cleanup || [];
    st.cleanup.push(() => {
      W.removeEventListener(EV_.WIN_INDEX_UPDATED, onCoreReindex);
      W.removeEventListener(EV_.WIN_TURN_UPDATED,  onCoreReindex);
      W.removeEventListener(EV_.WIN_ANS_SCAN,      onCoreReindex);
      W.removeEventListener(EV_.WIN_PW_CHANGED, onCoreReindex);
      W.removeEventListener(EV_.WIN_PW_CHANGED_COMPAT, onCoreReindex);
      st.coreHooked = false;
    });

    DOM_AT_queueAllAssistants();
  }

  /** @critical */
  function CORE_AT_detachFallbackMO() {
    const st = MOD.state;
    if (!st.observer) return;
    try { st.observer.disconnect(); } catch {}
    st.observer = null;
    st.observerRoot = null;
  }

  /** @helper */
  function DOM_AT_collectAssistNodes(node, out) {
    if (!node || node.nodeType !== 1) return false;
    const el = /** @type {Element} */ (node);

    if (el.matches?.(SEL_.ASSIST_MSG)) {
      out.add(el);
      return false;
    }

    const childCount = el.childElementCount || 0;
    if (!childCount) return false;
    if (childCount > CFG_.MO_MAX_NODE_CHILDREN) return true;

    const first = el.querySelector?.(SEL_.ASSIST_MSG);
    if (!first) return false;
    out.add(first);

    // small wrappers: capture all assistant nodes in one pass
    if (childCount <= 6) {
      const all = el.querySelectorAll?.(SEL_.ASSIST_MSG);
      if (all?.length) all.forEach((a) => out.add(a));
    }
    return false;
  }

  /** @critical */
  function CORE_AT_attachFallbackMO() {
    const st = MOD.state;
    const root = DOM_AT_getConversationRoot() || DOC.body;
    if (st.observer && st.observerRoot === root) return;
    CORE_AT_detachFallbackMO();

    const mo = new MutationObserver((muts) => {
      // M03 S4C slice B: under a governed Studio render the observer is only a
      // render-change trigger - targets come from the Semantic Index, never
      // from matching provider selectors here; our own stamp mutations are ignored.
      if (GOV_AT_currentRender()) {
        if (!GOV_AT_mutationsOwned(muts)) DOM_AT_queueAllAssistantsDebounced();
        return;
      }

      const hit = new Set();
      let needRepair = false;

      for (const m of muts) {
        const added = m.addedNodes;
        if (!added || !added.length) continue;
        for (const n of added) {
          if (DOM_AT_collectAssistNodes(n, hit)) needRepair = true;
        }
      }

      if (hit.size) hit.forEach((n) => DOM_AT_queueRoot(n, { delta: true }));
      if (needRepair) DOM_AT_queueAllAssistantsDebounced();
    });

    mo.observe(root, { childList: true, subtree: true });

    st.observer = mo;
    st.observerRoot = root;
  }

  /* ───────────────────────────── 8) BOOT / DISPOSE (idempotent + full cleanup) ───────────────────────────── */

  /** @critical */
  function CORE_AT_boot() {
    const st = MOD.state;
    if (st.booted) return;
    st.booted = true;

    st.cleanup = st.cleanup || [];
    st.pendingFullScan = false;
    st.domAIndexMap = new WeakMap();
    st.domAIndexCounter = 0;
    st.queueAllTimer = 0;

    CORE_AT_startPerfTicker();

    UI_AT_injectCSSOnce();
    UI_AT_applyCfg();
    CORE_AT_bindTitleHoverAnchors();

    CORE_AT_attachFallbackMO();
    CORE_AT_hookCore();
    W.addEventListener(EV_.WIN_CORE_READY, CORE_AT_hookCore, { once: true });

    st.cleanup.push(() => {
      try { W.removeEventListener(EV_.WIN_CORE_READY, CORE_AT_hookCore); } catch {}
    });
    st.cleanup.push(() => {
      if (st.queueAllTimer) {
        try { W.clearTimeout(st.queueAllTimer); } catch {}
      }
      st.queueAllTimer = 0;
    });
    st.cleanup.push(() => CORE_AT_detachFallbackMO());
    st.cleanup.push(() => CORE_AT_stopPerfTicker());
    // M03 S4C slice B: the contributions this module registered go with it.
    st.cleanup.push(() => GOV_AT_releaseHandles());

    // initial scan (kept, but queued)
    const t = setTimeout(DOM_AT_queueAllAssistants, CFG_.INITIAL_SCAN_DELAY_MS);
    st.cleanup.push(() => clearTimeout(t));

    // Expose
    MOD.api.boot = CORE_AT_boot;
    MOD.api.dispose = CORE_AT_dispose;
    MOD.api.rescan = DOM_AT_queueAllAssistantsDebounced;
    MOD.api.getConfig = UI_AT_readCfg;
    MOD.api.applySetting = (key, value) => {
      const current = UI_AT_readCfg();
      const next = UI_AT_writeCfg({ ...current, [String(key || '')]: value });
      UI_AT_applyCfg();
      DOM_AT_queueAllAssistantsDebounced();
      return next;
    };
  }

  /** @critical */
  function CORE_AT_dispose() {
    const st = MOD.state;
    if (!st.booted) return;

    const cleanup = st.cleanup || [];
    while (cleanup.length) {
      const fn = cleanup.pop();
      try { fn && fn(); } catch {}
    }

    STORE_AT_pendingRoots.clear();
    STORE_AT_rafQueued = false;
    st.pendingFullScan = false;

    st.booted = false;
  }

  /* ───────────────────────────── 9) MINIMAL BOOTSTRAP ───────────────────────────── */

  CORE_AT_boot();

})();
