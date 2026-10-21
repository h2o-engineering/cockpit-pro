// ==UserScript==
// @h2o-id             s3h1a.highlights.engine.studio
// @name               S3H1a. 🎬 Highlights Engine - Studio
// @namespace          H2O.Premium.CGX.highlights.engine
// @author             HumamDev
// @version            3.2.11
// @revision           002
// @build              260328-002627
// @description        H2O Contract v2.0 refactor — Inline highlights (XPath + TextPosition + TextQuote) with configurable apply/remove shortcuts, popup trigger, editable palette, robust persistence, MiniMap sync, and Control Hub integration.
// @match              https://chatgpt.com/*
// @run-at             document-idle
// @grant              unsafeWindow
// ==/UserScript==

(() => {
  'use strict';

  /* ───────────────────────────── 🧬 Identity (Contract v2.0) ───────────────────────────── */
  const W = (typeof unsafeWindow !== 'undefined' && unsafeWindow) ? unsafeWindow : window;
  const TOPW = W.top || W;
  const H2O = (W.H2O = W.H2O || {});

  const TOK = 'HE';
  const PID = 'nlnhghlghtr';
  const CID = 'ihighlighter';
  const SkID = 'inhl';
  const BrID = PID;
  const DsID = PID;
  const MODTAG = 'IHighlighter';
  const MODICON = '🖌️';
  const EMOJI_HDR = '🟩';
  const SUITE = 'prm';
  const HOST = 'cgx';

  // Vault (Contract): H2O[TOK][BrID] = { diag, state, api }
  const MODROOT = (H2O[TOK] ||= {});
  const MOD = (MODROOT[BrID] ||= {});
  const STATE = (MOD.state ||= { installed: false, enabled: true, booted: false });

  if (STATE.installed) return;
  STATE.installed = true;

  const DIAG = (MOD.diag ||= {
    bootCount: 0,
    disposedCount: 0,
    lastBootAt: 0,
    lastDisposeAt: 0,
    steps: [],
    lastError: null
  });

  const DIAG_step = (m) => { try { DIAG.steps.push({ t: Date.now(), m: String(m || '') }); } catch {} };
  const DIAG_fail = (err) => { try { DIAG.lastError = String(err?.stack || err || ''); } catch {} };

  /* ───────────────────────────── ⚙️ CFG_ (no magic) ───────────────────────────── */
  const CFG_DEBUG = true;
  const CFG_RESTORE_DEBOUNCE_MS = 250;
  const CFG_STABLE_WINDOW_MS = 400;
  const CFG_SAVE_DEBOUNCE_MS = 250;
  const CFG_UNSTABLE_RETRY_MAX = 12;
  const CFG_UNSTABLE_RETRY_BASE_MS = 200;
  const CFG_UNSTABLE_RETRY_STEP_MS = 60;
  const CFG_SIGNAL_DEDUPE_MS = 180;

  const CFG_REFRESH_STABLE_MAX_WAIT_MS = 4500;
  const CFG_REFRESH_STABLE_FRAMES = 3;
  const CFG_SELECTION_CTX_MAX_AGE_MS = 15000;

  const CFG_MIRROR_LEGACY_KEYS = false;
  const CFG_MIRROR_ALIAS_KEYS = false;

  /* ───────────────────────────── KEY_ (Disk) ───────────────────────────── */
  const NS_DISK = `h2o:${SUITE}:${HOST}:${DsID}`;

  const KEY_DISK_CANON = `${NS_DISK}:state:inline_highlights:v3`;
  const KEY_CFG_UI_V1 = `${NS_DISK}:cfg:ui:v1`;

  /* ───────────────────────────── EV_ (Bus + DOM) ───────────────────────────── */
  const EV_BUS_INLINE_CHANGED = 'inline:changed';
  const EV_BUS_MSG_REMOUNTED = 'message:remounted';

  const EV_DOM_CGXUI_INLINE_CHANGED = 'cgxui-inline:changed';
  const EV_DOM_H2O_INLINE_CHANGED = 'h2o:inline:changed';
  const EV_DOM_H2O_INLINE_RESTORED = 'h2o:inline:restored';
  const EV_DOM_H2O_INLINE_RESTORED_EVT = 'evt:h2o:inline:restored';
  const EV_DOM_H2O_PAGINATION_CHANGED = 'h2o:pagination:pagechanged';
  const EV_DOM_H2O_PAGINATION_CHANGED_EVT = 'evt:h2o:pagination:pagechanged';
  const EV_DOM_H2O_MSG_REMOUNTED = 'h2o:message:remounted';
  const EV_DOM_H2O_MSG_REMOUNTED_EVT = 'evt:h2o:message:remounted';

  const EV_DOM_CGXUI_HL_CHANGED_A = 'h2o:highlight-changed';
  const EV_DOM_CGXUI_HL_CHANGED_B = 'h2o:highlightsChanged';
  const EV_DOM_H2O_HL_CHANGED = 'h2o:highlightsChanged';

  const EV_DOM_CGXUI_MSG_REMOUNTED = 'h2o:message-remounted';
  const EV_DOM_STUDIO_READER_REFRESH_REQUESTED = 'evt:h2o:studio:reader-refresh-requested';
  const MSG_EXT_HIGHLIGHT_REQ = 'h2o-ext-live:highlight:req';

  /* ───────────────────────────── SEL_ ───────────────────────────── */
  const STUDIO_SEL = W.H2O.Studio.SELECTORS;
  const SEL_ANSWER = STUDIO_SEL.sel.assistantTurn;
  const SEL_MSG = STUDIO_SEL.sel.assistantOrUser;
  const SEL_MAIN = 'main';
  const SEL_TURN_HOST = '[data-testid="conversation-turn"], [data-testid^="conversation-turn-"]';

  /* ───────────────────────────── ATTR_ ───────────────────────────── */
  const ATTR_HL_ID = 'data-highlight-id';
  const ATTR_HL_COLOR = 'data-highlight-color';
  const ATTR_ANSWER_ID = 'data-answer-id';

  /* ───────────────────────────── CGXUI (owned UI hooks) ───────────────────────────── */
  const ATTR_CGX_OWNER = 'data-cgxui-owner';
  const ATTR_CGX_UI = 'data-cgxui';
  const ATTR_CGX_STATE = 'data-cgxui-state';

  const CSS_STYLE_ID = `cgxui-${SkID}-style`;

  /* ───────────────────────────── CSS_ ───────────────────────────── */

  const CSS_CLS_HL = `cgxui-${SkID}-inline-hl`;
  const CSS_CLS_TOOLS = `cgxui-${SkID}-hl-tools`;
  const CSS_CLS_SWATCH = `cgxui-${SkID}-hl-swatch`;
  const CSS_CLS_SWATCH_WRAP = `cgxui-${SkID}-hl-swatches`;

  const CGX_UI_TOOLS = `${SkID}-tools`;
  const CGX_UI_SWATCH = `${SkID}-swatch`;

  /* ───────────────────────────── 🎨 Palette ───────────────────────────── */
  const CFG_DEFAULT_COLOR = 'gold';
  const CFG_PALETTE_DEFAULTS = Object.freeze([
    Object.freeze({ title: 'blue',   label: 'Blue',   group: 'primary',   pair: 'sky',    color: '#3B82F6' }),
    Object.freeze({ title: 'red',    label: 'Red',    group: 'primary',   pair: 'pink',   color: '#FF4C4C' }),
    Object.freeze({ title: 'green',  label: 'Green',  group: 'primary',   pair: 'purple', color: '#22C55E' }),
    Object.freeze({ title: 'gold',   label: 'Gold',   group: 'primary',   pair: 'orange', color: '#FFD54F' }),
    Object.freeze({ title: 'sky',    label: 'Sky',    group: 'secondary', pair: 'blue',   color: '#7DD3FC' }),
    Object.freeze({ title: 'pink',   label: 'Pink',   group: 'secondary', pair: 'red',    color: '#F472B6' }),
    Object.freeze({ title: 'purple', label: 'Purple', group: 'secondary', pair: 'green',  color: '#A855F7' }),
    Object.freeze({ title: 'orange', label: 'Orange', group: 'secondary', pair: 'gold',   color: '#FF914D' }),
  ]);
  const CFG_APPLY_SHORTCUTS = Object.freeze(['meta_or_ctrl_1', 'meta_1', 'ctrl_1', 'meta_or_ctrl_shift_1', 'none']);
  const CFG_CLEAR_SHORTCUTS = Object.freeze(['meta_or_ctrl_z', 'meta_z', 'ctrl_z', 'escape', 'backspace', 'delete', 'none']);
  const CFG_POPUP_TRIGGERS = Object.freeze(['hover', 'click', 'middle_click', 'right_click', 'none']);
  const CFG_SHORTCUT_COLOR_MODES = Object.freeze([
    'default_color',
    'first_primary',
    'current_color',
    'next_primary',
    'paired_secondary',
    'random',
  ]);
  const CFG_UI_DEFAULTS = Object.freeze({
    applyShortcut: 'meta_or_ctrl_1',
    clearShortcut: 'meta_or_ctrl_z',
    popupTrigger: 'middle_click',
    shortcutColorMode: 'current_color',
    defaultColor: CFG_DEFAULT_COLOR,
    palette: CFG_PALETTE_DEFAULTS.map((entry) => Object.freeze({ title: entry.title, color: entry.color })),
  });

  /* ───────────────────────────── ⌨️ Hotkeys ───────────────────────────── */
  const KEY_CYCLE = 'Digit2';

  /* ───────────────────────────── 🧰 UTIL_ ───────────────────────────── */
  const log = (...a) => { if (CFG_DEBUG) console.log(`[H2O.${MODTAG}]`, ...a); };

  const UTIL_isMac = () => /Mac|iPhone|iPad|iPod/.test(navigator.platform);
  const UTIL_debounce = (fn, wait) => { let t = null; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), wait); }; };
  const UTIL_hashText = (s) => { let h = 5381, i = s.length; while (i) h = (h * 33) ^ s.charCodeAt(--i); return h >>> 0; };
  const UTIL_textOf = (el) => (el && el.textContent) ? el.textContent : '';

  const UTIL_cssEsc = (s) => {
    try { return CSS.escape(String(s)); }
    catch { return String(s).replace(/["\\]/g, '\\$&'); }
  };

  const UTIL_safeParse = (s, fallback) => {
    try {
      if (s && typeof s === 'object') return s;
      return JSON.parse(String(s));
    } catch {
      return fallback;
    }
  };
  const UTIL_clone = (v, fallback = null) => {
    try { return JSON.parse(JSON.stringify(v)); }
    catch { return fallback; }
  };
  const UTIL_normalizeHexColor = (raw, fallback = null) => {
    const base = String(raw || '').trim().replace(/^#/, '');
    const expanded = /^[\da-f]{3}$/i.test(base)
      ? base.split('').map((ch) => ch + ch).join('')
      : base;
    if (!/^[\da-f]{6}$/i.test(expanded)) return fallback;
    return `#${expanded.toLowerCase()}`;
  };
  const UTIL_isEditableLike = (el) => {
    if (!el || el.nodeType !== 1) return false;
    if (el.isContentEditable) return true;
    if (el.closest?.('[contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"]')) return true;
    if (el.closest?.('input, textarea, select, button')) return true;
    if (el.closest?.('[role="textbox"], [role="combobox"], [role="searchbox"], [data-lexical-editor="true"]')) return true;
    return false;
  };

  const UTIL_getChatId = () => {
    const m = location.pathname.match(/\/c\/([a-z0-9-]+)/i);
    if (m) return m[1];
    try {
      const frame = document.querySelector('#viewReader .cgFrame[data-chat-id], .cgFrame[data-chat-id]');
      const id = String(frame?.getAttribute?.('data-chat-id') || frame?.dataset?.chatId || '').trim();
      if (id) return id;
    } catch {}
    return '';
  };

  const UTIL_getConvoKey = () => {
    const id = UTIL_getChatId() || '';
    return id ? `c/${id}` : 'c/unknown';
  };

  const UTIL_timerSet = new Set();
  const UTIL_setTimeout = (fn, ms) => {
    const t = setTimeout(() => { UTIL_timerSet.delete(t); fn(); }, ms);
    UTIL_timerSet.add(t);
    return t;
  };
  const UTIL_clearAllTimers = () => { for (const t of Array.from(UTIL_timerSet)) clearTimeout(t); UTIL_timerSet.clear(); };

  const UTIL_unsubs = [];
  const UTIL_on = (target, type, fn, opts) => {
    target.addEventListener(type, fn, opts);
    const off = () => { try { target.removeEventListener(type, fn, opts); } catch {} };
    UTIL_unsubs.push(off);
    return off;
  };
  const UTIL_onBus = (type, fn) => {
    const bus = H2O?.bus;
    if (!bus || typeof bus.on !== 'function' || typeof bus.off !== 'function') return () => {};
    bus.on(type, fn);
    const off = () => { try { bus.off(type, fn); } catch {} };
    UTIL_unsubs.push(off);
    return off;
  };
  const UTIL_offAll = () => { while (UTIL_unsubs.length) { try { UTIL_unsubs.pop()(); } catch {} } };

  /* ───────────────────────────── ⚙️ UI config ───────────────────────────── */
  let STATE_uiCfg = null;

  const CFG_findPaletteEntry = (rawPalette, title, idx) => {
    if (!Array.isArray(rawPalette)) return null;
    const byTitle = rawPalette.find((entry) => String(entry?.title || entry?.key || '').trim().toLowerCase() === title);
    if (byTitle) return byTitle;
    return rawPalette[idx] || null;
  };

  const CFG_normalizeUiConfig = (raw) => {
    const src = raw && typeof raw === 'object' ? raw : {};
    const palette = CFG_PALETTE_DEFAULTS.map((fallback, idx) => {
      const incoming = CFG_findPaletteEntry(src.palette, fallback.title, idx);
      return {
        title: fallback.title,
        color: UTIL_normalizeHexColor(incoming?.color || incoming?.hex, fallback.color),
      };
    });
    const paletteNames = CFG_PALETTE_DEFAULTS.map((entry) => entry.title);
    const defaultColor = paletteNames.includes(String(src.defaultColor || '').trim().toLowerCase())
      ? String(src.defaultColor).trim().toLowerCase()
      : CFG_DEFAULT_COLOR;
    return {
      applyShortcut: CFG_APPLY_SHORTCUTS.includes(src.applyShortcut) ? src.applyShortcut : CFG_UI_DEFAULTS.applyShortcut,
      clearShortcut: CFG_CLEAR_SHORTCUTS.includes(src.clearShortcut) ? src.clearShortcut : CFG_UI_DEFAULTS.clearShortcut,
      popupTrigger: CFG_POPUP_TRIGGERS.includes(src.popupTrigger) ? src.popupTrigger : CFG_UI_DEFAULTS.popupTrigger,
      shortcutColorMode: CFG_SHORTCUT_COLOR_MODES.includes(src.shortcutColorMode) ? src.shortcutColorMode : CFG_UI_DEFAULTS.shortcutColorMode,
      defaultColor,
      palette,
    };
  };

  const CFG_loadUiConfig = () => {
    if (STATE_uiCfg) return UTIL_clone(STATE_uiCfg, CFG_UI_DEFAULTS) || CFG_UI_DEFAULTS;
    try {
      const raw = UTIL_safeParse(localStorage.getItem(KEY_CFG_UI_V1) || '{}', {}) || {};
      STATE_uiCfg = CFG_normalizeUiConfig(raw);
    } catch {
      STATE_uiCfg = CFG_normalizeUiConfig(null);
    }
    return UTIL_clone(STATE_uiCfg, CFG_UI_DEFAULTS) || CFG_UI_DEFAULTS;
  };

  const CFG_getUiConfig = () => CFG_loadUiConfig();

  const CFG_saveUiConfig = (next) => {
    STATE_uiCfg = CFG_normalizeUiConfig(next);
    try { localStorage.setItem(KEY_CFG_UI_V1, JSON.stringify(STATE_uiCfg)); } catch {}
    return CFG_getUiConfig();
  };

  /* ───────────────────────────── 🧩 Bridge: minimal H2O.msg (if Core not loaded yet) ───────────────────────────── */
  H2O.msg = H2O.msg || {};
  H2O.msg.normalizeId = H2O.msg.normalizeId || ((id) => String(id || '').replace(/^conversation-turn-/, '').trim());
  H2O.msg.getIdFromEl = H2O.msg.getIdFromEl || ((el) => {
    if (!el) return '';
    if (el?.dataset?.h2oUid) return H2O.msg.normalizeId(el.dataset.h2oUid);
    if (el?.dataset?.hoUid) {
      // migrate legacy attr to new key
      try { el.dataset.h2oUid = el.dataset.hoUid; } catch {}
      return H2O.msg.normalizeId(el.dataset.hoUid);
    }

    const mid =
      el.getAttribute?.('data-message-id') ||
      el.dataset?.messageId ||
      el.getAttribute?.('data-cgxui-id') ||
      el.dataset?.h2oId ||
      el.dataset?.hoId ||
      el.getAttribute?.('data-cgxui-uid') ||
      el.dataset?.h2oUid ||
      el.dataset?.hoUid ||
      '';

    if (mid) return H2O.msg.normalizeId(mid);

    const t = el.dataset?.testid || el.dataset?.testId || el.getAttribute?.('data-testid') || '';
    if (t && t.startsWith('conversation-turn-')) return H2O.msg.normalizeId(t);

    return '';
  });

  /* ───────────────────────────── 📌 Message helpers ───────────────────────────── */
  W.ANSWER_SEL = W.ANSWER_SEL || SEL_ANSWER;

  const MSG_isSoftUnmounted = (el) => {
    if (!el) return false;
    if (el.dataset && el.dataset.h2oUnmounted === '1') return true;
    if (el.dataset && el.dataset.hoUnmounted === '1') {
      try { el.dataset.h2oUnmounted = '1'; } catch {}
      return true;
    }
    if (el.classList?.contains('cgxui-unmounted-placeholder')) return true;
    if (el.querySelector?.('.cgxui-unmounted-placeholder')) return true;
    return false;
  };

  const MSG_getPairNoFromEl = (el) => {
    const turn = el?.closest?.('[data-testid^="conversation-turn-"]');
    const tid = turn?.getAttribute?.('data-testid') || '';
    const m = tid.match(/conversation-turn-(\d+)/);
    if (!m) return null;
    const n = parseInt(m[1], 10);
    return Number.isFinite(n) ? (n + 1) : null;
  };

  const MSG_getAnswerId = (el) => {
    const coreId = H2O.msg?.getIdFromEl?.(el);
    if (coreId) return coreId;

    const fallbackIdx = Array.from(document.querySelectorAll(SEL_MSG)).indexOf(el);
    return el?.getAttribute?.('data-message-id')
      || el?.id
      || (el?.dataset?.testid?.includes?.('message') ? el.dataset.testid : null)
      || `idx_${fallbackIdx}`;
  };

  const MSG_getRole = (el) => String(el?.getAttribute?.('data-message-author-role') || '').trim().toLowerCase();
  const MSG_roleMatches = (el, roleHint = '') => {
    const role = MSG_getRole(el);
    const hint = String(roleHint || '').trim().toLowerCase();
    if (!hint) return !!role;
    if (hint === 'assistant' || hint === 'answer') return role === 'assistant' || role === 'answer';
    if (hint === 'user' || hint === 'question') return role === 'user' || role === 'question';
    return role === hint;
  };
  const MSG_isQuestionRestoreReady = (el) => {
    const msg = el?.matches?.(SEL_MSG) ? el : MSG_findContainer(el);
    if (!msg || !MSG_roleMatches(msg, 'question')) return false;
    if (msg.dataset?.hoQwrapDone === '1' || msg.dataset?.h2oQwrapDone === '1') return true;
    return !!msg.querySelector?.('.cgxui-qswr');
  };

  const MSG_isUnstableAnswerId = (id) => {
    if (!id) return true;
    const s = String(id).trim();
    if (!s) return true;
    if (s === 'null' || s === 'undefined') return true;
    if (/^idx_\d+$/.test(s)) return true;
    if (/^message_\d+$/.test(s)) return true;
    return false;
  };

  const MSG_findContainer = (node) => {
    let el = (node && (node.nodeType === 1 ? node : node.parentElement));
    while (el && el !== document.body) {
      if (el.matches?.(SEL_ANSWER)) return el;

      const role = el.getAttribute?.('data-message-author-role');
      if (role === 'assistant' || role === 'user') return el;

      if (el.hasAttribute?.('data-message-id')) return el;

      if (el.classList?.contains('prose') || el.matches?.('.markdown')) {
        const owner = el.closest?.(SEL_ANSWER);
        return owner || el.closest?.(SEL_MSG) || el;
      }
      el = el.parentElement;
    }
    return null;
  };

  const MSG_getById = (id, opts = {}) => {
    const rawId = H2O.msg?.normalizeId?.(id) || String(id || '').trim();
    const roleHint = String(opts?.role || '').trim().toLowerCase();
    if (!rawId) return null;
    const accept = (el) => {
      const msg = el?.matches?.(SEL_MSG) ? el : MSG_findContainer(el);
      if (!msg || !MSG_roleMatches(msg, roleHint)) return null;
      const msgId = H2O.msg?.normalizeId?.(MSG_getAnswerId(msg)) || String(MSG_getAnswerId(msg) || '').trim();
      return msgId === rawId ? msg : null;
    };

    try {
      const found = accept(H2O.msg?.findEl?.(rawId));
      if (found) return found;
    } catch {}

    const esc = UTIL_cssEsc(rawId);
    const selectors = [
      `[data-message-id="${esc}"]`,
      `[id="${esc}"]`,
      `[data-cgxui-id="${esc}"]`,
      `[data-cgxui-uid="${esc}"]`,
      `[data-h2o-uid="${esc}"]`,
      `[data-ho-uid="${esc}"]`,
      `[data-testid="conversation-turn-${esc}"]`,
      `[data-testid="${esc}"]`,
    ];
    for (const selector of selectors) {
      const found = accept(document.querySelector(selector));
      if (found) return found;
    }

    const all = document.querySelectorAll(SEL_MSG);
    for (const el of all) {
      if (!MSG_roleMatches(el, roleHint)) continue;
      const msgId = H2O.msg?.normalizeId?.(MSG_getAnswerId(el)) || String(MSG_getAnswerId(el) || '').trim();
      if (msgId === rawId) return el;
    }
    return null;
  };

  const MSG_getTurnHost = (el) => {
    const msg = el?.matches?.(SEL_MSG) ? el : MSG_findContainer(el);
    if (!msg) return null;
    return msg.closest?.(SEL_TURN_HOST) || null;
  };

  const MSG_getByTurnId = (turnId, roleHint = '') => {
    const id = String(turnId || '').trim();
    if (!id) return null;
    const esc = UTIL_cssEsc(id);
    const nodes = document.querySelectorAll(`[data-turn-id="${esc}"]`);
    for (const node of nodes) {
      const msg = node?.matches?.(SEL_MSG) ? node : MSG_findContainer(node);
      if (!msg || !MSG_roleMatches(msg, roleHint)) continue;
      return msg;
    }
    return null;
  };

  const MSG_resolveTurnPair = (target, opts = {}) => {
    const detail = target?.detail && typeof target.detail === 'object'
      ? target.detail
      : (target && typeof target === 'object' && !target?.nodeType ? target : {});
    const detailEl = detail?.el?.nodeType === 1 ? detail.el : null;
    const directEl = target?.nodeType === 1 ? target : detailEl;
    let msgEl = directEl ? (MSG_findContainer(directEl) || directEl) : null;
    const roleHint = String(opts?.role || detail?.role || MSG_getRole(msgEl) || '').trim().toLowerCase();
    let turnId = String(opts?.turnId || detail?.turnId || '').trim();
    let messageId = String(
      opts?.answerId ||
      detail?.answerId ||
      opts?.uid ||
      detail?.uid ||
      opts?.id ||
      detail?.id ||
      ''
    ).trim();

    if (!messageId && msgEl) messageId = String(MSG_getAnswerId(msgEl) || '').trim();
    if (!msgEl && messageId) msgEl = MSG_getById(messageId, { role: roleHint });

    const role = roleHint || MSG_getRole(msgEl);
    const canonical = CANON_resolveAnswerMeta(messageId || turnId, { role, msgEl });
    if (!turnId) turnId = String(canonical?.turnId || '').trim();

    let turnHost = MSG_getTurnHost(msgEl);
    if (!turnHost && turnId) turnHost = MSG_getTurnHost(MSG_getByTurnId(turnId));

    let answerEl = turnHost?.querySelector?.(SEL_ANSWER) || null;
    let questionEl = turnHost?.querySelector?.(STUDIO_SEL.sel.userTurn) || null;
    if (!answerEl && role !== 'question' && msgEl && MSG_roleMatches(msgEl, 'answer')) answerEl = msgEl;
    if (!questionEl && role === 'question' && msgEl && MSG_roleMatches(msgEl, 'question')) questionEl = msgEl;
    if (!answerEl && canonical?.answerId) answerEl = MSG_getById(canonical.answerId, { role: 'answer' });
    if (!questionEl && turnId) questionEl = MSG_getByTurnId(turnId, 'question');
    if (!answerEl && turnId) answerEl = MSG_getByTurnId(turnId, 'answer');

    const answerId = String(
      MSG_getAnswerId(answerEl) ||
      canonical?.answerId ||
      (!role || role === 'assistant' || role === 'answer' ? messageId : '') ||
      ''
    ).trim();
    const questionId = String(
      MSG_getAnswerId(questionEl) ||
      ((role === 'user' || role === 'question') ? messageId : '') ||
      ''
    ).trim();

    const nodes = [];
    const seen = new Set();
    for (const el of [questionEl, answerEl]) {
      const msg = el?.matches?.(SEL_MSG) ? el : MSG_findContainer(el);
      if (!msg || !msg.isConnected) continue;
      const id = String(MSG_getAnswerId(msg) || '').trim() || `node:${nodes.length}`;
      if (seen.has(id)) continue;
      seen.add(id);
      nodes.push(msg);
    }

    return {
      turnId,
      answerId,
      questionId,
      answerEl: answerEl || null,
      questionEl: questionEl || null,
      messageId,
      role,
      nodes,
    };
  };

  const CANON_ensurePaginationReady = (reason = 'canonical') => {
    const api = W.H2O_Pagination || null;
    if (!api) return false;
    const state = W?.H2O?.PW?.pgnwndw?.state || null;
    const hasMaster = !!(Array.isArray(state?.masterAnswers) && state.masterAnswers.length);
    if (state?.booted && hasMaster) return true;

    try {
      if (!state?.booted) api.boot?.(`highlighter:${reason}`);
      else if (!hasMaster) api.rebuildIndex?.(`highlighter:${reason}`);
    } catch {}

    const nextState = W?.H2O?.PW?.pgnwndw?.state || null;
    return !!(nextState?.booted && Array.isArray(nextState?.masterAnswers) && nextState.masterAnswers.length);
  };

  const CANON_isPaginationEnabled = () => {
    const api = W.H2O_Pagination || null;
    if (!api) return false;
    try {
      const info = api.getPageInfo?.();
      if (info && typeof info.enabled === 'boolean') return !!info.enabled;
    } catch {}
    return !!(W?.H2O?.PW?.pgnwndw?.state?.booted);
  };

  const CANON_collectAnswerIdCandidates = (rawId) => {
    const out = [];
    const seen = new Set();
    const push = (value) => {
      const id = H2O.msg?.normalizeId?.(value) || String(value || '').trim();
      if (!id || seen.has(id)) return;
      seen.add(id);
      out.push(id);
    };

    push(rawId);
    try { push(W.H2O?.turn?.getPrimaryAIdByAId?.(String(rawId || '').trim())); } catch {}
    return out;
  };

  const CANON_resolveFromPagination = (rawId) => {
    const candidates = CANON_collectAnswerIdCandidates(rawId);
    if (!candidates.length) return null;
    const api = W.H2O_Pagination || null;
    if (!api) return null;
    CANON_ensurePaginationReady('resolve-answer-meta');

    for (const id of candidates) {
      let resolved = null;
      try { resolved = api.resolveAnyIdToPage?.(id) || null; } catch {}
      if (!resolved) {
        try {
          const turn = api.resolveAnyIdToTurnRecord?.(id) || null;
          if (turn) {
            resolved = {
              turn,
              answer: null,
              turnIndex: Number(turn?.turnIndex),
              answerIndex: Number(turn?.answerIndex || 0),
              turnId: String(turn?.turnId || '').trim(),
              answerId: String(turn?.answerId || turn?.primaryAId || '').trim(),
            };
          }
        } catch {}
      }
      if (!resolved) continue;

      const answerIndex1 = Number(resolved?.answerIndex || resolved?.answer?.answerIndex || resolved?.turn?.answerIndex || 0);
      const turnIndex0 = Number.isFinite(Number(resolved?.turnIndex)) && Number(resolved?.turnIndex) >= 0
        ? Number(resolved.turnIndex)
        : (answerIndex1 > 0 ? (answerIndex1 - 1) : -1);
      const answerId = String(resolved?.answerId || resolved?.answer?.answerId || resolved?.turn?.answerId || resolved?.answer?.primaryAId || '').trim();
      const turnId = String(resolved?.turnId || resolved?.turn?.turnId || resolved?.answer?.turnId || '').trim();

      return {
        source: 'pagination',
        answerId: answerId || id,
        turnId,
        answerIndex: answerIndex1 > 0 ? (answerIndex1 - 1) : -1,
        answerNumber: answerIndex1 > 0 ? answerIndex1 : null,
        pairNo: answerIndex1 > 0 ? answerIndex1 : null,
        turnIndex: turnIndex0,
      };
    }
    return null;
  };

  const CANON_resolveFromMiniMap = (rawId) => {
    const candidates = CANON_collectAnswerIdCandidates(rawId);
    if (!candidates.length) return null;
    const byId = (TOPW?.H2O_MM_turnById instanceof Map) ? TOPW.H2O_MM_turnById : null;
    const byAId = (TOPW?.H2O_MM_turnIdByAId instanceof Map) ? TOPW.H2O_MM_turnIdByAId : null;
    for (const id of candidates) {
      let turn = byId?.get?.(id) || null;
      if (!turn) {
        const turnId = String(byAId?.get?.(id) || '').trim();
        if (turnId) turn = byId?.get?.(turnId) || null;
      }
      if (!turn) continue;

      const idx = Math.max(0, Number(turn?.index || 0) || 0);
      return {
        source: 'minimap',
        answerId: String(turn?.answerId || id).trim(),
        turnId: String(turn?.turnId || '').trim(),
        answerIndex: idx > 0 ? (idx - 1) : -1,
        answerNumber: idx > 0 ? idx : null,
        pairNo: idx > 0 ? idx : null,
        turnIndex: idx > 0 ? (idx - 1) : -1,
      };
    }
    return null;
  };

  const CANON_resolveFromTurnSvc = (rawId, roleHint = '') => {
    const candidates = CANON_collectAnswerIdCandidates(rawId);
    if (!candidates.length) return null;
    const turnSvc = W.H2O?.turn;
    if (!turnSvc) return null;
    const role = String(roleHint || '').trim().toLowerCase();
    for (const id of candidates) {
      const callFn = (fn) => (typeof fn === 'function' ? Number(fn(id) || 0) : 0);
      let answerNumber = 0;
      if (role === 'assistant' || role === 'answer') answerNumber = callFn(turnSvc.getTurnIndexByAId);
      else if (role === 'user' || role === 'question') answerNumber = callFn(turnSvc.getTurnIndexByQId);
      if (answerNumber <= 0) answerNumber = callFn(turnSvc.getTurnIndexByAId) || callFn(turnSvc.getTurnIndexByQId);
      if (answerNumber <= 0) continue;

      let answerId = '';
      let turnId = '';
      try {
        const turns = (typeof turnSvc.getTurns === 'function') ? (turnSvc.getTurns.call(turnSvc) || []) : [];
        const turn = Array.isArray(turns) ? turns[answerNumber - 1] : null;
        answerId = String(turn?.primaryAId || turn?.answerId || '').trim();
        turnId = String(turn?.turnId || turn?.id || '').trim();
      } catch {}

      return {
        source: 'turn',
        answerId: answerId || ((role === 'assistant' || role === 'answer') ? id : ''),
        turnId,
        answerIndex: answerNumber - 1,
        answerNumber,
        pairNo: answerNumber,
        turnIndex: answerNumber - 1,
      };
    }
    return null;
  };

  const CANON_resolveAnswerMeta = (rawId, opts = {}) => {
    const id = H2O.msg?.normalizeId?.(rawId) || String(rawId || '').trim();
    if (!id) return null;
    const role = String(opts?.role || '').trim().toLowerCase();
    const msgEl = opts?.msgEl || null;

    const resolved =
      CANON_resolveFromPagination(id)
      || CANON_resolveFromMiniMap(id)
      || CANON_resolveFromTurnSvc(id, role);
    if (resolved) return resolved;

    const pairNo = MSG_getPairNoFromEl(msgEl);
    if (!pairNo) return null;
    return {
      source: 'dom',
      answerId: (role === 'assistant' || role === 'answer') ? id : '',
      turnId: '',
      answerIndex: pairNo - 1,
      answerNumber: pairNo,
      pairNo,
      turnIndex: pairNo - 1,
    };
  };

  /* ── Storage seam (Studio store owns Highlights persistence) ──
   * S3H1a delegates all highlight reads/writes to
   * H2O.Studio.store.highlights. Single backend (chrome.storage.local),
   * single canonical key (KEY_DISK_CANON). Cross-context sync with
   * native 3H1a happens at the chrome.storage.onChanged layer (the store
   * binds via H2O.Studio.platform.broadcast.onAnyChange when available).
   * UI prefs (KEY_CFG_UI_V1) remain owned by S3H1a's CFG_loadUiConfig /
   * CFG_saveUiConfig (separate concern, untouched).
   * See surfaces/studio/store/highlights.js and store/README.md.
   */
  const STORE_read = () => W.H2O.Studio.store.highlights.getAll();
  const STORE_write = (u) => W.H2O.Studio.store.highlights.update(u);
  const STORE_saveNow = () => W.H2O.Studio.store.highlights.saveNow();

  /* ───────────────────────────── 🧱 Store shape ───────────────────────────── */
  const PAL_list = () => {
    const cfg = CFG_getUiConfig();
    return CFG_PALETTE_DEFAULTS.map((fallback, idx) => ({
      ...fallback,
      color: UTIL_normalizeHexColor(cfg?.palette?.[idx]?.color, fallback.color),
    }));
  };
  const PAL_names = () => PAL_list().map((entry) => entry.title);
  const PAL_defaultName = () => CFG_getUiConfig().defaultColor || CFG_DEFAULT_COLOR;
  const PAL_primaryNames = () => PAL_list().filter((entry) => entry.group === 'primary').map((entry) => entry.title);
  const PAL_secondaryNames = () => PAL_list().filter((entry) => entry.group === 'secondary').map((entry) => entry.title);

  const STORE_ensureShape = (draft) => {
    draft.itemsByAnswer = draft.itemsByAnswer || {};
    draft._meta = draft._meta || { currentColor: PAL_defaultName() };
    if (!draft._meta.currentColor) draft._meta.currentColor = PAL_defaultName();
    if (!draft.convoId) draft.convoId = UTIL_getConvoKey();
    return draft;
  };

  const STORE_getCurrentColor = () => {
    const s = STORE_read();
    const c = (s && s._meta && s._meta.currentColor) || PAL_defaultName();
    return PAL_names().includes(String(c || '').trim().toLowerCase())
      ? String(c || '').trim().toLowerCase()
      : PAL_defaultName();
  };

  const STORE_setCurrentColor = (title) => {
    STORE_write((d) => {
      STORE_ensureShape(d);
      d._meta.currentColor = PAL_names().includes(String(title || '').trim().toLowerCase())
        ? String(title || '').trim().toLowerCase()
        : PAL_defaultName();
      return d;
    });
  };

  const PAL_colorDef = (name) => {
    const found = PAL_list().find((entry) => entry.title === String(name || '').trim().toLowerCase());
    if (found) return found;
    const def = PAL_list().find((entry) => entry.title === PAL_defaultName());
    return def || PAL_list()[0];
  };

  const PAL_nextName = (cur) => {
    const names = PAL_names();
    const i = Math.max(0, names.indexOf(cur));
    return names[(i + 1) % names.length];
  };

  const PAL_normalizeName = (name) => PAL_colorDef(String(name || '').trim().toLowerCase()).title;
  const PAL_pairName = (name) => PAL_colorDef(name)?.pair || PAL_colorDef(PAL_defaultName())?.pair || PAL_defaultName();
  const PAL_primaryNameFor = (name) => {
    const entry = PAL_colorDef(name);
    return entry?.group === 'primary' ? entry.title : PAL_colorDef(entry?.pair)?.title || PAL_primaryNames()[0] || PAL_defaultName();
  };

  const CFG_getPaletteConfig = () => {
    const cfg = CFG_getUiConfig();
    return {
      defaultColor: cfg.defaultColor,
      palette: PAL_list().map((entry) => ({
        title: entry.title,
        label: entry.label,
        group: entry.group,
        pair: entry.pair,
        color: entry.color,
      })),
    };
  };

  const CFG_setPaletteConfig = (next = {}) => {
    const current = CFG_getUiConfig();
    const merged = CFG_saveUiConfig({
      ...current,
      defaultColor: next.defaultColor ?? current.defaultColor,
      palette: Array.isArray(next.palette) ? next.palette : current.palette,
    });
    HL_refreshPaletteRuntime?.();
    return {
      defaultColor: merged.defaultColor,
      palette: PAL_list().map((entry) => ({
        title: entry.title,
        label: entry.label,
        group: entry.group,
        pair: entry.pair,
        color: entry.color,
      })),
    };
  };

  const CFG_resetPaletteConfig = () => {
    const current = CFG_getUiConfig();
    const next = CFG_saveUiConfig({
      ...current,
      defaultColor: CFG_UI_DEFAULTS.defaultColor,
      palette: CFG_UI_DEFAULTS.palette,
    });
    STORE_write((draft) => {
      STORE_ensureShape(draft);
      if (!draft?._meta?.currentColor || !PAL_names().includes(String(draft._meta.currentColor || '').trim().toLowerCase())) {
        draft._meta.currentColor = next.defaultColor || CFG_DEFAULT_COLOR;
      }
      return draft;
    });
    HL_refreshPaletteRuntime?.();
    return CFG_getPaletteConfig();
  };

  const CFG_applyUiSetting = (optKey, value) => {
    const current = CFG_getUiConfig();
    let next = current;

    switch (String(optKey || '')) {
      case 'applyShortcut':
        next = CFG_saveUiConfig({ ...current, applyShortcut: value });
        break;
      case 'clearShortcut':
        next = CFG_saveUiConfig({ ...current, clearShortcut: value });
        break;
      case 'popupTrigger':
        next = CFG_saveUiConfig({ ...current, popupTrigger: value });
        break;
      case 'shortcutColorMode':
        next = CFG_saveUiConfig({ ...current, shortcutColorMode: value });
        break;
      case 'defaultColor':
        next = CFG_saveUiConfig({ ...current, defaultColor: value });
        break;
      default:
        return CFG_getUiConfig();
    }

    if (String(optKey || '') === 'defaultColor') {
      STORE_write((draft) => {
        STORE_ensureShape(draft);
        if (!draft?._meta?.currentColor) draft._meta.currentColor = PAL_defaultName();
        return draft;
      });
    }
    return next;
  };

  const STORE_colorsFrom = (answerId) => {
    const s = STORE_read();
    const list = s?.itemsByAnswer?.[answerId] || [];
    const hex = list.map(h => (PAL_colorDef(h.color)?.color) || '').filter(Boolean);
    return Array.from(new Set(hex));
  };

  /* ───────────────────────────── 🧠 Text flatten + anchors ───────────────────────────── */
  const TXT_flatten = (root) => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: n => n.nodeValue?.length ? NodeFilter.FILTER_ACCEPT : NodeFilter.REJECT
    });
    let plain = '', map = [], acc = 0, n;
    while ((n = walker.nextNode())) {
      const len = n.nodeValue.length;
      map.push({ node: n, start: acc, end: acc + len });
      acc += len;
      plain += n.nodeValue;
    }
    return { plain, map, length: plain.length };
  };

  const TXT_rangeToPos = (range, root) => {
    const { map } = TXT_flatten(root);
    const nodeOffset = (node, offset) => {
      for (const seg of map) if (seg.node === node) return seg.start + offset;
      return null;
    };
    const s = nodeOffset(range.startContainer, range.startOffset);
    const e = nodeOffset(range.endContainer, range.endOffset);
    return (s == null || e == null) ? null : { start: s, end: e };
  };

  const TXT_posToRange = (pos, root) => {
    const { map, length } = TXT_flatten(root);
    if (!pos || pos.start < 0 || pos.end > length || pos.start >= pos.end) return null;

    const locate = (off) => {
      for (const seg of map) if (off >= seg.start && off <= seg.end) return { node: seg.node, offset: off - seg.start };
      return null;
    };

    const a = locate(pos.start), b = locate(pos.end);
    if (!a || !b) return null;
    const r = document.createRange();
    r.setStart(a.node, a.offset);
    r.setEnd(b.node, b.offset);
    return r;
  };

  const TXT_sliceBounds = (str, start, end) => str.slice(Math.max(0, start), Math.min(str.length, end));
  const TXT_normalizeString = (value) => String(value || '').replace(/\s+/g, ' ').trim();

  const TXT_rangeToQuote = (range, root, ctx = 32) => {
    const { plain } = TXT_flatten(root);
    const pos = TXT_rangeToPos(range, root);
    if (!pos) return null;
    const exact = plain.slice(pos.start, pos.end);
    const prefix = TXT_sliceBounds(plain, pos.start - ctx, pos.start);
    const suffix = TXT_sliceBounds(plain, pos.end, pos.end + ctx);
    return { exact, prefix, suffix, approx: pos.start };
  };

  const TXT_findByQuote = (root, quote) => {
    if (!quote || !quote.exact) return null;
    const { plain } = TXT_flatten(root);
    const approx = Number.isFinite(quote.approx)
      ? Math.max(0, Math.min(plain.length, Math.floor(quote.approx)))
      : null;
    const prefix = quote.prefix || '';
    const suffix = quote.suffix || '';
    const matches = [];

    for (let idx = plain.indexOf(quote.exact); idx !== -1; idx = plain.indexOf(quote.exact, idx + 1)) {
      const start = idx;
      const end = start + quote.exact.length;
      const hasPrefix = !prefix || plain.slice(Math.max(0, start - prefix.length), start).endsWith(prefix);
      if (!hasPrefix) continue;
      const hasSuffix = !suffix || plain.slice(end, end + suffix.length).startsWith(suffix);
      if (!hasSuffix) continue;
      const dist = approx != null ? Math.abs(start - approx) : 0;
      matches.push({ start, dist });
    }

    if (!matches.length) return null;
    matches.sort((a, b) => {
      if (a.dist !== b.dist) return a.dist - b.dist;
      return a.start - b.start;
    });

    const bestStart = matches[0].start;
    return TXT_posToRange({ start: bestStart, end: bestStart + quote.exact.length }, root);
  };

  const TXT_rangeMatchesQuote = (range, quote) => {
    if (!range) return false;
    if (!quote || !quote.exact) return true;
    const actual = range.toString();
    if (actual === quote.exact) return true;
    return TXT_normalizeString(actual) === TXT_normalizeString(quote.exact);
  };

  /* ───────────────────────────── 🧭 XPath helpers ───────────────────────────── */
  const XP_firstText = (el) => {
    const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    return w.nextNode();
  };
  const XP_lastText = (el) => {
    const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let last = null, n;
    while ((n = w.nextNode())) last = n;
    return last;
  };

  const XP_siblingIndex = (n) => { let i = 1, p = n; while ((p = p.previousSibling)) if (p.nodeName === n.nodeName) i++; return i; };

  const XP_fromNode = (node, root) => {
    if (!node || node === root) return '.';
    const parts = [];
    while (node && node !== root) {
      parts.unshift(`${node.nodeName.toLowerCase()}[${XP_siblingIndex(node)}]`);
      node = node.parentNode;
    }
    return './/' + parts.join('/');
  };

  const XP_nodeFrom = (xpath, root = document) => {
    try {
      const r = document.evaluate(xpath, root, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
      if (r.singleNodeValue) return r.singleNodeValue;
    } catch (e) {
      console.warn(`[H2O.${MODTAG}] XPath eval failed`, xpath, e);
    }

    const base = xpath.replace(/\/#text\[\d+\]$/, '');
    try {
      const candidate = document.evaluate(base, root, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
      if (candidate) {
        const tn = XP_firstText(candidate);
        if (tn) return tn;
      }
    } catch {}
    return null;
  };

  const XP_rangeToSerializable = (range, scopeRoot) => {
    let startNode = range.startContainer;
    let endNode = range.endContainer;

    if (startNode.nodeType !== 3) startNode = XP_firstText(startNode) || startNode.firstChild;
    if (endNode.nodeType !== 3) endNode = XP_lastText(endNode) || endNode.lastChild;

    return {
      startXPath: XP_fromNode(startNode, scopeRoot),
      startOffset: range.startOffset,
      endXPath: XP_fromNode(endNode, scopeRoot),
      endOffset: range.endOffset,
    };
  };

  const XP_serializableToRange = (obj, scopeRoot) => {
    if (!obj || !obj.startXPath || !obj.endXPath) return null;
    const clean = (p) => String(p).replace(/\/#text\[\d+\]/g, '');
    const startXPath = clean(obj.startXPath);
    const endXPath = clean(obj.endXPath);

    const startNode = XP_nodeFrom(startXPath, scopeRoot);
    const endNode = XP_nodeFrom(endXPath, scopeRoot);
    if (!startNode || !endNode) return null;

    let sNode = (startNode.nodeType === 3) ? startNode : (XP_firstText(startNode) || startNode.firstChild);
    let eNode = (endNode.nodeType === 3) ? endNode : (XP_lastText(endNode) || endNode.lastChild);
    if (!sNode || !eNode) return null;

    let sOff = obj.startOffset ?? 0;
    while (sNode && sOff > (sNode.nodeValue?.length ?? 0)) {
      sOff -= (sNode.nodeValue?.length ?? 0);
      do { sNode = sNode.nextSibling; if (!sNode) return null; } while (sNode.nodeType !== 3);
    }

    let eOff = obj.endOffset ?? 0;
    while (eNode && eOff > (eNode.nodeValue?.length ?? 0)) {
      eOff -= (eNode.nodeValue?.length ?? 0);
      do { eNode = eNode.nextSibling; if (!eNode) return null; } while (eNode.nodeType !== 3);
    }

    const r = document.createRange();
    try { r.setStart(sNode, sOff); r.setEnd(eNode, eOff); } catch { return null; }
    return r;
  };

  /* ───────────────────────────── 🧷 Wrapping / unwrapping ───────────────────────────── */
  const HL_isMark = (el) => el && el.nodeType === 1 && el.classList?.contains(CSS_CLS_HL);

  const HL_splitText = (node, offset) => {
    if (node.nodeType !== 3) return node;
    if (offset <= 0 || offset >= node.nodeValue.length) return node;
    return node.splitText(offset);
  };

  const HL_constrainToAncestor = (range, ancestor) => {
    const r = range.cloneRange();
    if (!ancestor.contains(r.startContainer)) {
      const start = XP_firstText(ancestor);
      if (!start) return null;
      r.setStart(start, 0);
    }
    if (!ancestor.contains(r.endContainer)) {
      const end = XP_lastText(ancestor);
      if (!end) return null;
      r.setEnd(end, end.nodeValue?.length || 0);
    }
    return r;
  };

  const RANGE_rectFrom = (range) => {
    if (!range) return null;

    const hasArea = (rect) => !!rect && ((Number(rect.width) || 0) > 0 || (Number(rect.height) || 0) > 0);

    let rect = null;
    try { rect = range.getBoundingClientRect?.() || null; } catch {}

    if (!hasArea(rect)) {
      try {
        const rects = Array.from(range.getClientRects?.() || []);
        rect = rects.find(hasArea) || rects[0] || rect;
      } catch {}
    }

    if (!rect) return null;

    const left = Number(rect.left) || 0;
    const top = Number(rect.top) || 0;
    const width = Number(rect.width) || 0;
    const height = Number(rect.height) || 0;
    const right = Number(rect.right);
    const bottom = Number(rect.bottom);

    return {
      left,
      top,
      width,
      height,
      right: Number.isFinite(right) ? right : (left + width),
      bottom: Number.isFinite(bottom) ? bottom : (top + height),
    };
  };

  const HL_textNodesInRange = (range, root) => {
    if (!range) return [];
    const container = root || range.commonAncestorContainer || document.querySelector(SEL_ANSWER);
    if (!container) return [];
    const baseEl = (container.nodeType === 1) ? container : container.parentElement;
    if (!baseEl) return [];
    const answer = baseEl.closest?.(SEL_ANSWER) || baseEl;

    const strictNodes = [];
    try {
      const walker = document.createTreeWalker(answer, NodeFilter.SHOW_TEXT, null);
      let n;
      while ((n = walker.nextNode())) {
        if (!n.nodeValue || !n.nodeValue.trim()) continue;

        let overlaps = false;
        try { if (typeof range.intersectsNode === 'function') overlaps = range.intersectsNode(n); } catch {}

        if (!overlaps) {
          try {
            const r2 = document.createRange();
            r2.selectNodeContents(n);
            overlaps = !(
              range.compareBoundaryPoints(Range.END_TO_START, r2) <= 0 ||
              range.compareBoundaryPoints(Range.START_TO_END, r2) >= 0
            );
          } catch {}
        }

        if (overlaps) strictNodes.push(n);
      }
    } catch (err) {
      console.warn(`[H2O.${MODTAG}] walker failed`, err);
    }

    if (strictNodes.length) return strictNodes;

    const broad = [];
    answer.querySelectorAll('*').forEach(el => {
      el.childNodes.forEach(c => { if (c.nodeType === 3 && c.nodeValue && c.nodeValue.trim()) broad.push(c); });
    });
    return broad;
  };

  const HL_markFactory = (colorHex, id, ansId, colorName) => {
    const m = document.createElement('mark');

    m.className = CSS_CLS_HL;

    // ✅ cgxui ownership (Contract)
    m.setAttribute(ATTR_CGX_OWNER, SkID);

    m.setAttribute(ATTR_HL_ID, id);
    if (ansId) m.setAttribute(ATTR_ANSWER_ID, ansId);
    if (colorName) m.setAttribute(ATTR_HL_COLOR, colorName);

    m.style.setProperty('--hl-color', colorHex);
    return m;
  };

  const HL_mergeAdjacent = (el) => {
    if (!HL_isMark(el)) return;
    const next = el.nextSibling;
    if (HL_isMark(next) && next.getAttribute(ATTR_HL_ID) === el.getAttribute(ATTR_HL_ID)) {
      while (next.firstChild) el.appendChild(next.firstChild);
      next.remove();
      HL_mergeAdjacent(el);
    }
  };

  const HL_setMarkColor = (el, colorName) => {
    const def = PAL_colorDef(colorName);
    el.setAttribute(ATTR_HL_COLOR, colorName);

    // expose token for other modules (DockPanel/HighlightsTab) without hex guessing
    el.dataset.color = colorName;
    el.dataset.highlightColor = colorName;
    el.dataset.h2oInlineColor = colorName;
    el.style.setProperty('--hl-color', def.color);
  };

  const UI_toolsRefreshSwatches = () => {
    if (!STATE_toolsEl) return;
    const wrap = STATE_toolsEl.querySelector(`.${CSS_CLS_SWATCH_WRAP}`);
    if (!wrap) return;
    wrap.innerHTML = PAL_list().map((entry) =>
      `<button class="${CSS_CLS_SWATCH}" ${ATTR_CGX_OWNER}="${SkID}" ${ATTR_CGX_UI}="${CGX_UI_SWATCH}" data-color="${entry.title}" title="${entry.label}" style="--swatch:${entry.color}"></button>`
    ).join('');
  };

  const HL_refreshPaletteRuntime = () => {
    UI_toolsRefreshSwatches();

    const touchedAnswers = new Set();
    document.querySelectorAll(`.${CSS_CLS_HL}`).forEach((mark) => {
      const colorName = PAL_normalizeName(
        mark.getAttribute(ATTR_HL_COLOR)
        || mark.dataset?.highlightColor
        || mark.dataset?.h2oInlineColor
        || mark.dataset?.color
        || PAL_defaultName()
      );
      HL_setMarkColor(mark, colorName);
      const answerId = String(mark.getAttribute(ATTR_ANSWER_ID) || MSG_getAnswerId(MSG_findContainer(mark)) || '').trim();
      if (answerId) touchedAnswers.add(answerId);
    });

    if (!PAL_names().includes(STORE_getCurrentColor())) STORE_setCurrentColor(PAL_defaultName());

    touchedAnswers.forEach((answerId) => {
      HL_notifyChanged(answerId);
      HL_emitInlineChanged(answerId);
      try { W.syncMiniMapDot?.(answerId, STORE_colorsFrom(answerId), { persist: true }); } catch {}
    });
    MM_primeFromStore?.();
  };

  const HL_updateStoreColor = (answerId, id, newColor) => {
    STORE_write(d => {
      STORE_ensureShape(d);
      const list = d.itemsByAnswer[answerId] || [];
      const item = list.find(h => h.id === id);
      if (item) item.color = newColor || PAL_defaultName();
      return d;
    });
  };

  const HL_removeStoreItem = (answerId, id) => {
    STORE_write(d => {
      STORE_ensureShape(d);
      const list = d.itemsByAnswer[answerId] || [];
      d.itemsByAnswer[answerId] = list.filter(h => h.id !== id);
      return d;
    });
  };

  const HL_wrapRange = (range, colorTitle, answerId, existingId) => {
    if (!range || range.collapsed) return null;

    const def = PAL_colorDef(colorTitle || PAL_defaultName());
    const hlId = existingId || `hl_${Math.random().toString(36).slice(2, 9)}`;
    let inserted = 0;

    try {
      if (range.startContainer.nodeType !== 3) {
        const s = XP_firstText(range.startContainer) || range.startContainer.firstChild;
        if (s && s.nodeType === 3) range.setStart(s, 0);
      }
      if (range.endContainer.nodeType !== 3) {
        const e = XP_lastText(range.endContainer) || range.endContainer.lastChild;
        if (e && e.nodeType === 3) range.setEnd(e, e.nodeValue.length);
      }
    } catch (err) {
      log('wrapRange normalize failed', err);
      return null;
    }

    const sRight = HL_splitText(range.startContainer, range.startOffset);
    if (sRight && sRight !== range.startContainer) range.setStart(sRight, 0);
    HL_splitText(range.endContainer, range.endOffset);

    const answerRoot = MSG_getById(answerId) || MSG_findContainer(range.commonAncestorContainer) || range.commonAncestorContainer;
    const nodes = HL_textNodesInRange(range, answerRoot);
    if (!nodes.length) return null;

    for (const tn of nodes) {
      let start = 0, end = tn.nodeValue.length;
      if (tn === range.startContainer) start = range.startOffset;
      if (tn === range.endContainer) end = range.endOffset;
      if (end <= start) continue;

      const slice = tn.nodeValue.slice(start, end);
      if (!slice || !slice.trim()) continue;

      const existingParent = tn.parentElement && tn.parentElement.closest?.(`.${CSS_CLS_HL}`);
      if (existingParent) {
        const pid = existingParent.getAttribute(ATTR_HL_ID);
        if (pid) {
          HL_setMarkColor(existingParent, colorTitle || PAL_defaultName());
          HL_updateStoreColor(answerId, pid, colorTitle || PAL_defaultName());
        }
        continue;
      }

      HL_splitText(tn, end);
      const mid = HL_splitText(tn, start);

      const m = HL_markFactory(def.color, hlId, answerId, (colorTitle || PAL_defaultName()));
      mid.parentNode.insertBefore(m, mid);
      m.appendChild(mid);

      // dataset hook (still useful)
      m.dataset.highlightColor = colorTitle || PAL_defaultName();
      m.dataset.h2oInlineColor = colorTitle || PAL_defaultName();

      HL_mergeAdjacent(m.previousSibling);
      HL_mergeAdjacent(m);
      inserted++;
    }

    const answerEl = MSG_getById(answerId);
    if (answerEl) {
      answerEl.querySelectorAll('mark mark').forEach(inner => {
        const parent = inner.parentNode;
        while (inner.firstChild) parent.insertBefore(inner.firstChild, inner);
        inner.remove();
        parent.normalize?.();
      });
    }

    return inserted ? { id: hlId } : null;
  };

  const HL_unwrapById = (id, scopeEl) => {
    const root = scopeEl || document;
    const els = root.querySelectorAll(`.${CSS_CLS_HL}[${ATTR_HL_ID}="${UTIL_cssEsc(id)}"]`);
    els.forEach(el => {
      const p = el.parentNode;
      while (el.firstChild) p.insertBefore(el.firstChild, el);
      p.removeChild(el);
      p.normalize?.();
    });
  };

  /* ───────────────────────────── 🧠 Anchors → range ───────────────────────────── */
  const HL_resolveAnchors = (item, root) => {
    const anchors = item.anchors || {};
    if (!anchors || typeof anchors !== 'object') return null;

    if (anchors.textQuote) {
      const r = TXT_findByQuote(root, anchors.textQuote);
      if (r && !r.collapsed) return r;
    }
    if (anchors.textPos) {
      const r = TXT_posToRange(anchors.textPos, root);
      if (r && !r.collapsed && TXT_rangeMatchesQuote(r, anchors.textQuote)) return r;
    }
    if (anchors.xpath) {
      const r = XP_serializableToRange(anchors.xpath, root);
      if (r && !r.collapsed) return r;
    }
    return null;
  };

  /* ───────────────────────────── 🚌 Signals ───────────────────────────── */
  const HL_collectDomColors = (msgEl) => {
    const set = new Set();
    msgEl.querySelectorAll('.' + CSS_CLS_HL).forEach(m => {
      const c = m.style.getPropertyValue('--hl-color') || m.dataset.color || '';
      if (c) set.add(c);
    });
    return Array.from(set);
  };

  const HL_emitInlineChanged = (msgElOrId) => {
    const el = (typeof msgElOrId === 'string')
      ? (MSG_getById(msgElOrId) || W.document.querySelector(`[data-message-id="${msgElOrId}"]`))
      : msgElOrId;

    if (!el) return;

    const answerId = MSG_getAnswerId(el);
    const domColors = HL_collectDomColors(el);
    const storeCols = STORE_colorsFrom(answerId);
    const colors = domColors.length ? domColors : storeCols;

    const detail = { answerId, colors, source: 'highlighter', ts: Date.now() };

    if (H2O?.events?.emit) {
      H2O.events.emit(EV_BUS_INLINE_CHANGED, detail);
      return;
    }

    try { W.dispatchEvent(new CustomEvent(EV_DOM_CGXUI_INLINE_CHANGED,  { detail, bubbles: true, composed: true })); } catch {}
    try { W.dispatchEvent(new CustomEvent(EV_DOM_H2O_INLINE_CHANGED, { detail, bubbles: true, composed: true })); } catch {}
    try { W.dispatchEvent(new CustomEvent(`evt:h2o:inline:changed`, { detail, bubbles: true, composed: true })); } catch {}
    try { W.dispatchEvent(new CustomEvent(`h2o-inline:changed`, { detail, bubbles: true, composed: true })); } catch {}
  };

  const HL_notifyChanged = (answerId) => {
    try { W.dispatchEvent(new CustomEvent(EV_DOM_CGXUI_HL_CHANGED_A, { detail: { id: answerId } })); } catch {}
    try { W.dispatchEvent(new CustomEvent(EV_DOM_CGXUI_HL_CHANGED_B, { detail: { answerId } })); } catch {}
    try { W.dispatchEvent(new CustomEvent(EV_DOM_H2O_HL_CHANGED,  { detail: { answerId } })); } catch {}
  };

  /* ───────────────────────────── 💾 Save highlight ───────────────────────────── */
  const HL_save = (answerId, payload) => {
    const enriched = { ...payload, convoId: UTIL_getConvoKey() };
    if (enriched.pairNo == null) {
      const meta = CANON_resolveAnswerMeta(answerId, { role: 'assistant', msgEl: MSG_getById(answerId) });
      enriched.pairNo = meta?.pairNo ?? MSG_getPairNoFromEl(MSG_getById(answerId));
    }

    STORE_write(d => {
      STORE_ensureShape(d);
      const list = (d.itemsByAnswer[answerId] = d.itemsByAnswer[answerId] || []);
      if (!list.some(h => h.id === enriched.id)) list.push(enriched);
      return d;
    });
  };

  /* ───────────────────────────── ♻️ Restore one message ───────────────────────────── */
  const HL_restoreMessage = (msgEl) => {
    if (!msgEl) return;
    if (MSG_isSoftUnmounted(msgEl)) return;

    const answerId = MSG_getAnswerId(msgEl);
    const s = STORE_read();
    const list = s?.itemsByAnswer?.[answerId] || [];
    if (!list.length) { HL_emitInlineChanged(msgEl); return; }

    const existing = new Set(
      Array.from(msgEl.querySelectorAll(`.${CSS_CLS_HL}`)).map(el => el.getAttribute(ATTR_HL_ID))
    );

    for (const h of list) {
      if (!h || !h.anchors) continue;
      if (existing.has(h.id)) continue;

      const r = HL_resolveAnchors(h, msgEl);
      if (!r || r.collapsed) continue;

      const out = HL_wrapRange(r, h.color || PAL_defaultName(), answerId, h.id);
      if (out) existing.add(h.id);
    }

    HL_emitInlineChanged(msgEl);
  };

  /* ───────────────────────────── 🧰 Tools popup (selection + highlighted text) ───────────────────────────── */
  let STATE_toolsEl = null;
  let STATE_toolsTargetId = null;
  let STATE_toolsAnswerId = null;
  let STATE_toolsMode = 'single';
  let STATE_toolsCtx = null;
  let STATE_toolsBound = false;
  let STATE_lastMarkCtx = null;

  const HL_captureMarkContext = (markEl) => {
    if (!markEl) return null;
    const id = String(markEl.getAttribute?.(ATTR_HL_ID) || '').trim();
    const answerId = String(
      markEl.getAttribute?.(ATTR_ANSWER_ID)
      || MSG_getAnswerId(MSG_findContainer(markEl))
      || ''
    ).trim();
    if (!id || !answerId) return null;
    return { id, answerId };
  };

  const HL_rememberMarkContext = (markEl) => {
    const ctx = HL_captureMarkContext(markEl);
    if (ctx) STATE_lastMarkCtx = ctx;
    return ctx;
  };

  const HL_removeHighlightIds = (answerId, ids, scopeEl = null) => {
    const targetAnswerId = String(answerId || '').trim();
    const list = Array.from(new Set((Array.isArray(ids) ? ids : []).map((id) => String(id || '').trim()).filter(Boolean)));
    if (!targetAnswerId || !list.length) return false;

    const msgEl = scopeEl || MSG_getById(targetAnswerId) || null;
    list.forEach((id) => {
      HL_unwrapById(id, msgEl || undefined);
      HL_removeStoreItem(targetAnswerId, id);
    });
    if (STATE_lastMarkCtx && STATE_lastMarkCtx.answerId === targetAnswerId && list.includes(STATE_lastMarkCtx.id)) {
      STATE_lastMarkCtx = null;
    }

    UI_toolsHide();
    HL_notifyChanged(targetAnswerId);
    HL_emitInlineChanged(msgEl || targetAnswerId);
    try { W.syncMiniMapDot?.(targetAnswerId, STORE_colorsFrom(targetAnswerId), { persist: true }); } catch {}
    return true;
  };

  /* Dock Phase 3: a narrow existing-item bridge. The current Renderer index
   * and its mounted root, rather than a Dock row or snapshot id, identify the
   * message that may be changed. The Store rereads the item from disk. */
  const HL_DOCK_FLAG = 'studio.dock.highlightsWriteBack.enabled';
  const HL_dockWriteEnabled = () => {
    try { return H2O.flags?.get?.(HL_DOCK_FLAG, false) === true; }
    catch { return false; }
  };

  const HL_resolveDockTarget = (request) => {
    const root = request?.currentRendererRoot;
    const chatId = String(request?.chatId || '').trim();
    const answerId = String(request?.answerId || '').trim();
    const id = String(request?.highlightId || '').trim();
    const pane = document.getElementById('viewReader');
    if (!root?.isConnected || !pane?.contains?.(root) ||
        W.H2O?.studioHost?.getReaderRoot?.() !== root ||
        !chatId || !answerId || !id) return null;

    let context, index, conversation, messages;
    try {
      context = H2O.Studio?.getDockContext?.();
      index = H2O.Studio?.getReaderSemanticIndex?.(root);
      conversation = index?.getConversation?.();
      messages = index?.messages?.();
    } catch { return null; }
    if (context?.eligible !== true || String(context.chatId || '').trim() !== chatId ||
        conversation?.target !== root ||
        String(conversation?.sourceRef?.chatId || '').trim() !== chatId ||
        !Array.isArray(messages)) return null;

    const matches = messages.filter((record) =>
      record?.kind === 'message' && record?.role === 'assistant' &&
      String(record?.sourceRef?.messageId || '').trim() === answerId &&
      record?.target?.isConnected && root.contains(record.target) &&
      record.target.getAttribute?.('data-message-id') === answerId
    );
    if (matches.length !== 1) return null;
    return { root, msgEl: matches[0].target, chatId, answerId, id };
  };

  const HL_syncDockItem = (target) => {
    const store = W.H2O?.Studio?.store?.highlights;
    const list = store?.getForAnswer?.(target.answerId) || [];
    const item = list.find((entry) => String(entry?.id || '') === target.id);
    const marks = target.msgEl.querySelectorAll(`.${CSS_CLS_HL}[${ATTR_HL_ID}="${UTIL_cssEsc(target.id)}"]`);
    if (item) {
      marks.forEach((mark) => HL_setMarkColor(mark, item.color));
      if (!marks.length) HL_restoreMessage(target.msgEl);
    } else {
      HL_unwrapById(target.id, target.msgEl);
    }
    HL_notifyChanged(target.answerId);
    HL_emitInlineChanged(target.msgEl);
    try { W.syncMiniMapDot?.(target.answerId, STORE_colorsFrom(target.answerId), { persist: true }); } catch {}
  };

  const HL_writeExistingFromDock = async (op, request) => {
    if (!HL_dockWriteEnabled()) return { ok: false, reason: 'flag-off' };
    const target = HL_resolveDockTarget(request);
    if (!target) return { ok: false, reason: 'stale-reader' };
    const color = String(request?.color || '').trim().toLowerCase();
    if (op === 'recolor' && !PAL_names().includes(color)) return { ok: false, reason: 'invalid-color' };
    const store = W.H2O?.Studio?.store?.highlights;
    if (typeof store?.applyExisting !== 'function' || typeof store?.reloadStrict !== 'function') {
      return { ok: false, reason: 'store-unavailable' };
    }
    const guard = () => HL_dockWriteEnabled() && !!HL_resolveDockTarget(request);
    const result = await store.applyExisting({
      op, answerId: target.answerId, id: target.id, color,
      convoId: `c/${target.chatId}`, allowedColors: PAL_names(), guard,
    });
    if (!result?.ok) {
      try { await store.reloadStrict(); } catch { return { ok: false, reason: 'canonical-reload-failed' }; }
    }
    const current = HL_resolveDockTarget(request);
    if (current) HL_syncDockItem(current);
    return result;
  };

  const HL_turnToAnswerId = (turnId, answerIdHint = '') => {
    const hint = String(answerIdHint || '').trim();
    if (hint) return hint;

    const key = String(turnId || '').trim();
    if (!key) return '';
    if (key.startsWith('turn:a:')) return key.slice(7).trim();
    if (key.startsWith('turn:')) return key.slice(5).trim();

    try {
      const turn = TOPW?.H2O_MM_turnById?.get?.(key);
      const aid = String(turn?.answerId || turn?.primaryAId || '').trim();
      if (aid) return aid;
    } catch {}
    try {
      const entries = TOPW?.H2O_MM_turnIdByAId?.entries?.();
      if (entries) {
        for (const [aId, tId] of entries) {
          if (String(tId || '').trim() === key) return String(aId || '').trim();
        }
      }
    } catch {}
    return '';
  };

  const HL_findAnswerByTurn = (turnId, answerIdHint = '') => {
    const answerId = HL_turnToAnswerId(turnId, answerIdHint);
    if (answerId) {
      const direct = MSG_getById(answerId);
      if (direct) return { answerId, el: direct };
    }
    const key = String(turnId || '').trim();
    if (!key) return { answerId: answerId || '', el: null };
    const esc = UTIL_cssEsc(key);
    const byTurn =
      document.querySelector(`${SEL_ANSWER}[data-turn-id="${esc}"]`) ||
      document.querySelector(`[data-turn-id="${esc}"]`);
    const msg = byTurn ? (MSG_findContainer(byTurn) || byTurn) : null;
    return { answerId: answerId || MSG_getAnswerId(msg), el: msg || null };
  };

  async function HL_recolorTurnHighlights(turnId, fromColor, toColor, opts = {}) {
    const from = String(fromColor || '').trim().toLowerCase();
    const to = String(toColor || '').trim().toLowerCase();
    if (!from || !to || from === to) return { ok: false, changed: 0, reason: 'noop' };

    const resolved = HL_findAnswerByTurn(turnId, opts?.answerId || '');
    const answerId = String(resolved?.answerId || '').trim();
    if (!answerId) return { ok: false, changed: 0, reason: 'no-answer' };

    const msgEl = resolved?.el || MSG_getById(answerId);
    let changed = 0;
    const touchedIds = new Set();

    if (msgEl) {
      const marks = Array.from(msgEl.querySelectorAll(`.${CSS_CLS_HL}`));
      for (const mark of marks) {
        const color = String(
          mark.getAttribute(ATTR_HL_COLOR) ||
          mark.dataset?.highlightColor ||
          mark.dataset?.h2oInlineColor ||
          mark.dataset?.color ||
          ''
        ).trim().toLowerCase();
        if (color !== from) continue;
        HL_setMarkColor(mark, to);
        const id = String(mark.getAttribute(ATTR_HL_ID) || '').trim();
        if (id) touchedIds.add(id);
        changed += 1;
      }
    }

    if (changed > 0) {
      STORE_write(d => {
        STORE_ensureShape(d);
        const list = d?.itemsByAnswer?.[answerId] || [];
        for (const item of list) {
          const id = String(item?.id || '').trim();
          if (!id) continue;
          if (touchedIds.size ? touchedIds.has(id) : String(item?.color || '').trim().toLowerCase() === from) {
            item.color = to;
          }
        }
        return d;
      });
    } else {
      STORE_write(d => {
        STORE_ensureShape(d);
        const list = d?.itemsByAnswer?.[answerId] || [];
        for (const item of list) {
          if (String(item?.color || '').trim().toLowerCase() === from) {
            item.color = to;
            changed += 1;
          }
        }
        return d;
      });
      if (changed > 0 && msgEl) HL_restoreMessage(msgEl);
    }

    if (changed > 0) {
      STORE_setCurrentColor(to);
      try { await STORE_saveNow(); } catch {}
      HL_notifyChanged(answerId);
      HL_emitInlineChanged(msgEl || answerId);
      try { W.syncMiniMapDot?.(answerId, STORE_colorsFrom(answerId), { persist: true }); } catch {}
    }
    return { ok: true, changed, answerId, turnId: String(turnId || '').trim(), from, to };
  }

  const UI_toolsEnsure = () => {
    if (STATE_toolsEl) return STATE_toolsEl;

    const el = document.createElement('div');
    STATE_toolsEl = el;

    // ✅ cgxui class
    el.className = CSS_CLS_TOOLS;

    // ✅ cgxui ownership + ui tags
    el.setAttribute(ATTR_CGX_OWNER, SkID);
    el.setAttribute(ATTR_CGX_UI, CGX_UI_TOOLS);
    el.setAttribute(ATTR_CGX_STATE, 'hidden');

    el.innerHTML = `
      <div class="${CSS_CLS_SWATCH_WRAP}" ${ATTR_CGX_OWNER}="${SkID}" ${ATTR_CGX_UI}="${SkID}-swatches">
        ${PAL_list().map((p) =>
          `<button class="${CSS_CLS_SWATCH}" ${ATTR_CGX_OWNER}="${SkID}" ${ATTR_CGX_UI}="${CGX_UI_SWATCH}" data-color="${p.title}" title="${p.label}" style="--swatch:${p.color}"></button>`
        ).join('')}
      </div>
    `;

    document.body.appendChild(el);

    if (!STATE_toolsBound) {
      STATE_toolsBound = true;

      UTIL_on(el, 'click', (e) => {
        e.stopPropagation();
        if (!STATE_toolsAnswerId) return;

        const sw = e.target.closest?.(`.${CSS_CLS_SWATCH}`);
        if (!sw) return;

        const colorName = String(sw.dataset.color || '').trim().toLowerCase();
        if (!colorName) return;

        if (STATE_toolsMode === 'bulk-recolor') {
          const ctx = STATE_toolsCtx || {};
          const sourceColor = String(ctx.sourceColor || '').trim().toLowerCase();
          if (!sourceColor || sourceColor === colorName) {
            UI_toolsHide();
            return;
          }
          STORE_setCurrentColor(colorName);
          HL_recolorTurnHighlights(ctx.turnId, sourceColor, colorName, { answerId: ctx.answerId })
            .catch((err) => { if (CFG_DEBUG) console.warn(`[H2O.${MODTAG}] bulk recolor failed`, err); });
          UI_toolsHide();
          return;
        }

        if (STATE_toolsMode === 'selection') {
          const ctx = STATE_toolsCtx || {};
          const range = HL_resolveSelectionCtxRange(ctx);
          const applied = range ? HL_applyRange(range, {
            answerId: ctx.answerId,
            msgEl: ctx.msgEl,
            color: colorName,
            clearSelection: true,
          }) : false;
          if (applied) STORE_setCurrentColor(colorName);
          else UI_toolsHide();
          return;
        }

        if (!STATE_toolsTargetId) return;

        let msgEl = MSG_getById(STATE_toolsAnswerId);
        const currentEl = document.querySelector(`.${CSS_CLS_HL}[${ATTR_HL_ID}="${UTIL_cssEsc(STATE_toolsTargetId)}"]`);
        const currentColor = currentEl?.getAttribute(ATTR_HL_COLOR);

        if (!msgEl && currentEl) msgEl = MSG_findContainer(currentEl);

        // Toggle off if same color clicked again
        if (currentColor === colorName) {
          HL_unwrapById(STATE_toolsTargetId, msgEl);
          HL_removeStoreItem(STATE_toolsAnswerId, STATE_toolsTargetId);
          UI_toolsHide();
          HL_notifyChanged(STATE_toolsAnswerId);
          HL_emitInlineChanged(msgEl || STATE_toolsAnswerId);
          return;
        }

        // Recolor
        document.querySelectorAll(`.${CSS_CLS_HL}[${ATTR_HL_ID}="${UTIL_cssEsc(STATE_toolsTargetId)}"]`)
          .forEach(node => HL_setMarkColor(node, colorName));

        HL_updateStoreColor(STATE_toolsAnswerId, STATE_toolsTargetId, colorName);
        STORE_setCurrentColor(colorName);
        UI_toolsHide();
        HL_notifyChanged(STATE_toolsAnswerId);
        HL_emitInlineChanged(msgEl || STATE_toolsAnswerId);
      }, true);

      UTIL_on(document, 'mousedown', (e) => {
        if (!STATE_toolsEl || STATE_toolsEl.style.pointerEvents !== 'auto') return;

        // don't close when middle-clicking a highlight (open/reposition trigger)
        if (e.button === 1 && e.target?.closest?.(`.${CSS_CLS_HL}`)) return;

        if (!STATE_toolsEl.contains(e.target)) UI_toolsHide();
      }, true);

      UTIL_on(document, 'keydown', (e) => { if (e.key === 'Escape') UI_toolsHide(); }, true);
      UTIL_on(window, 'scroll', UI_toolsHide, { passive: true });
      UTIL_on(window, 'resize', UI_toolsHide, { passive: true });
    }

    return el;
  };

  const UI_toolsPositionRect = (anchorRect) => {
    if (!anchorRect) return false;

    const t = UI_toolsEnsure();

    t.style.transform = 'translate(-9999px,-9999px)';
    t.style.opacity = '0';
    t.style.pointerEvents = 'none';
    t.setAttribute(ATTR_CGX_STATE, 'hidden');

    const marginY = 10;
    const panelWidth = t.offsetWidth || 180;
    const panelHeight = t.offsetHeight || 44;
    const left = Number(anchorRect.left) || 0;
    const top = Number(anchorRect.top) || 0;
    const width = Number(anchorRect.width) || Math.max(0, (Number(anchorRect.right) || 0) - left);
    const bottom = Number(anchorRect.bottom) || (top + (Number(anchorRect.height) || 0));

    let x = left + (width / 2) - (panelWidth / 2);
    let y = top - panelHeight - marginY;

    if (x + panelWidth > window.innerWidth - 8) x = window.innerWidth - panelWidth - 8;
    if (x < 8) x = 8;
    if (y < 8) y = bottom + marginY;

    t.style.transform = `translate(${x}px, ${y}px)`;
    t.style.opacity = '1';
    t.style.pointerEvents = 'auto';
    t.setAttribute(ATTR_CGX_STATE, 'open');
    return true;
  };

  const UI_toolsPositionFor = (markEl) => {
    return UI_toolsPositionRect(markEl?.getBoundingClientRect?.() || null);
  };

  const UI_toolsHide = () => {
    if (!STATE_toolsEl) return;
    STATE_toolsEl.style.opacity = '0';
    STATE_toolsEl.style.pointerEvents = 'none';
    STATE_toolsEl.setAttribute(ATTR_CGX_STATE, 'hidden');
    STATE_toolsTargetId = null;
    STATE_toolsAnswerId = null;
    STATE_toolsMode = 'single';
    STATE_toolsCtx = null;
  };

  const UI_toolsOpen = (ctx = {}) => {
    const modeRaw = String(ctx.mode || 'single').trim();
    const mode = (modeRaw === 'recolor-turn') ? 'bulk-recolor' : modeRaw;
    const answerId = String(ctx.answerId || '').trim();
    const turnId = String(ctx.turnId || '').trim();
    const sourceColor = String(ctx.sourceColor || '').trim().toLowerCase();
    const targetId = String(ctx.highlightId || '').trim();

    if (mode === 'bulk-recolor') {
      const resolvedAnswerId = HL_turnToAnswerId(turnId, answerId);
      if (!resolvedAnswerId || !sourceColor) return false;
      STATE_toolsMode = 'bulk-recolor';
      STATE_toolsCtx = { mode, turnId, answerId: resolvedAnswerId, sourceColor };
      STATE_toolsAnswerId = resolvedAnswerId;
      STATE_toolsTargetId = null;

      const t = UI_toolsEnsure();
      t.style.transform = 'translate(-9999px,-9999px)';
      t.style.opacity = '0';
      t.style.pointerEvents = 'none';
      t.setAttribute(ATTR_CGX_STATE, 'hidden');

      const panelWidth = t.offsetWidth || 180;
      const panelHeight = t.offsetHeight || 44;
      const anchorRect = ctx.anchorRect || null;
      const margin = 8;
      const xBase = Number.isFinite(ctx.leftAnchorX)
        ? ctx.leftAnchorX
        : (anchorRect ? (anchorRect.left || 0) : Number(ctx.clientX || 0));
      const yBase = anchorRect
        ? (anchorRect.top || 0) + ((anchorRect.height || 0) / 2)
        : Number(ctx.clientY || 0);

      let x = Math.round(xBase - panelWidth - margin);
      let y = Math.round(yBase - (panelHeight / 2));
      if (x + panelWidth > window.innerWidth - 8) x = window.innerWidth - panelWidth - 8;
      if (x < 8) x = 8;
      if (y + panelHeight > window.innerHeight - 8) y = window.innerHeight - panelHeight - 8;
      if (y < 8) y = 8;

      t.style.transform = `translate(${x}px, ${y}px)`;
      t.style.opacity = '1';
      t.style.pointerEvents = 'auto';
      t.setAttribute(ATTR_CGX_STATE, 'open');
      return true;
    }

    if (mode === 'selection') {
      const selectionCtxRaw = (ctx.selection && typeof ctx.selection === 'object')
        ? ctx.selection
        : HL_captureSelectionContext(ctx.range || null);
      if (!selectionCtxRaw) return false;

      const selectionCtx = {
        mode: 'selection',
        answerId: String(selectionCtxRaw.answerId || '').trim(),
        msgEl: selectionCtxRaw.msgEl || null,
        range: selectionCtxRaw.range || null,
        anchors: selectionCtxRaw.anchors || null,
        anchorRect: selectionCtxRaw.anchorRect || null,
      };
      if (!selectionCtx.answerId) return false;

      const resolvedRange = HL_resolveSelectionCtxRange(selectionCtx);
      if (!resolvedRange) return false;

      selectionCtx.anchorRect = selectionCtx.anchorRect || RANGE_rectFrom(resolvedRange);
      if (!selectionCtx.anchorRect) return false;

      STATE_toolsMode = 'selection';
      STATE_toolsCtx = selectionCtx;
      STATE_toolsTargetId = null;
      STATE_toolsAnswerId = selectionCtx.answerId;
      return UI_toolsPositionRect(selectionCtx.anchorRect);
    }

    if (!targetId || !answerId) return false;
    const markEl = document.querySelector(`.${CSS_CLS_HL}[${ATTR_HL_ID}="${UTIL_cssEsc(targetId)}"]`);
    if (!markEl) return false;
    STATE_toolsMode = 'single';
    STATE_toolsCtx = { mode: 'single' };
    STATE_toolsTargetId = targetId;
    STATE_toolsAnswerId = answerId;
    UI_toolsPositionFor(markEl);
    return true;
  };

  const HL_openPopupForMark = (markEl) => {
    const ctx = HL_rememberMarkContext(markEl);
    if (!ctx) return false;
    return UI_toolsOpen({ highlightId: ctx.id, answerId: ctx.answerId });
  };

  const UI_onMouseEnterMark = (markEl) => {
    if (CFG_getUiConfig().popupTrigger !== 'hover') return false;
    HL_rememberMarkContext(markEl);
    return HL_openPopupForMark(markEl);
  };

  /* ───────────────────────────── ✍️ Selection → highlight ───────────────────────────── */
  const STATE_unstableRetries = new WeakMap(); // Element -> count
  let STATE_lastSelectionCtx = null;
  let STATE_lastSelectionTs = 0;

  const HL_captureSelectionContext = (rangeInput = null) => {
    let raw = null;
    try {
      if (rangeInput && typeof rangeInput.cloneRange === 'function') raw = rangeInput.cloneRange();
      else {
        const sel = window.getSelection();
        if (sel?.rangeCount) raw = sel.getRangeAt(0).cloneRange();
      }
    } catch {}

    if (!raw || raw.collapsed) return null;

    const msgEl = MSG_findContainer(raw.commonAncestorContainer);
    const answerId = MSG_getAnswerId(msgEl);
    if (!msgEl || !answerId) return null;

    const range = HL_constrainToAncestor(raw, msgEl);
    if (!range || range.collapsed || !TXT_normalizeString(range.toString())) return null;

    return {
      mode: 'selection',
      answerId,
      msgEl,
      range: range.cloneRange(),
      anchorRect: RANGE_rectFrom(range),
      anchors: {
        xpath: XP_rangeToSerializable(range, msgEl),
        textPos: TXT_rangeToPos(range, msgEl),
        textQuote: TXT_rangeToQuote(range, msgEl, 32),
      },
    };
  };

  const HL_setSelectionContextCache = (ctx) => {
    if (!ctx) return null;
    const range = (() => {
      try { return ctx.range?.cloneRange?.() || null; } catch { return null; }
    })();
    STATE_lastSelectionCtx = {
      ...ctx,
      range,
      anchorRect: ctx.anchorRect ? { ...ctx.anchorRect } : null,
      anchors: ctx.anchors ? { ...ctx.anchors } : null,
    };
    STATE_lastSelectionTs = Date.now();
    return STATE_lastSelectionCtx;
  };

  const HL_getSelectionContext = (rangeInput = null) => {
    const live = HL_captureSelectionContext(rangeInput);
    if (live) return HL_setSelectionContextCache(live);
    if (STATE_lastSelectionCtx && (Date.now() - STATE_lastSelectionTs) <= CFG_SELECTION_CTX_MAX_AGE_MS) {
      return STATE_lastSelectionCtx;
    }
    return null;
  };

  const HL_resolveSelectionCtxRange = (ctx = {}) => {
    const msgEl = (ctx.answerId ? MSG_getById(ctx.answerId) : null) || ctx.msgEl || null;
    if (!msgEl) return null;

    let range = null;
    try {
      if (ctx.range && typeof ctx.range.cloneRange === 'function') range = ctx.range.cloneRange();
    } catch {}

    const rangeInsideMsg = !!range
      && !range.collapsed
      && msgEl.contains(range.startContainer)
      && msgEl.contains(range.endContainer);

    if (!rangeInsideMsg) range = HL_resolveAnchors({ anchors: ctx.anchors || null }, msgEl);

    const constrained = range ? HL_constrainToAncestor(range, msgEl) : null;
    if (!constrained || constrained.collapsed || !TXT_normalizeString(constrained.toString())) return null;
    return constrained;
  };

  const HL_applyRange = (rangeInput, opts = {}) => {
    if (!rangeInput || typeof rangeInput.cloneRange !== 'function') return false;

    const raw = rangeInput.cloneRange();
    if (raw.collapsed) return false;

    const msgEl = (opts.answerId ? MSG_getById(opts.answerId) : null) || opts.msgEl || MSG_findContainer(raw.commonAncestorContainer);
    const answerId = String(opts.answerId || MSG_getAnswerId(msgEl) || '').trim();
    if (!msgEl || !answerId) return false;

    const range = HL_constrainToAncestor(raw, msgEl);
    if (!range || range.collapsed || !TXT_normalizeString(range.toString())) return false;

    const colorTitle = PAL_normalizeName(opts.color || STORE_getCurrentColor() || PAL_defaultName());
    if (opts.color) STORE_setCurrentColor(colorTitle);

    // 1) recolor intersecting marks
    const touched = [];
    const walker = document.createTreeWalker(msgEl, NodeFilter.SHOW_ELEMENT, {
      acceptNode(el) {
        if (!el.classList?.contains(CSS_CLS_HL)) return NodeFilter.FILTER_REJECT;
        const r = new Range(); r.selectNodeContents(el);
        const hit = !(range.compareBoundaryPoints(Range.END_TO_START, r) <= 0 ||
                      range.compareBoundaryPoints(Range.START_TO_END, r) >= 0);
        return hit ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      }
    });

    let node;
    while ((node = walker.nextNode())) {
      HL_setMarkColor(node, colorTitle);
      HL_updateStoreColor(answerId, node.getAttribute(ATTR_HL_ID), colorTitle);
      touched.push(node);
    }
    if (touched.length) {
      try { void STORE_saveNow(); } catch {}
    }

    // 2) new highlight if none touched
    if (!touched.length) {
      const xpath = XP_rangeToSerializable(range, msgEl);
      const textPos = TXT_rangeToPos(range, msgEl);
      const textQuote = TXT_rangeToQuote(range, msgEl, 32);
      const wrapped = HL_wrapRange(range, colorTitle, answerId);

      if (wrapped?.id) {
        const pairNo = MSG_getPairNoFromEl(msgEl);

        HL_save(answerId, {
          id: wrapped.id,
          color: colorTitle,
          anchors: { xpath, textPos, textQuote },
          ts: Date.now(),
          pairNo
        });
        try { void STORE_saveNow(); } catch {}
      }
    }

    if (opts.clearSelection !== false) {
      try { window.getSelection()?.removeAllRanges(); } catch {}
    }
    UI_toolsHide();
    HL_notifyChanged(answerId);
    HL_emitInlineChanged(msgEl);
    return true;
  };

  const HL_openSelectionPopup = (rangeInput = null) => {
    const ctx = HL_getSelectionContext(rangeInput);
    if (!ctx) return false;
    return UI_toolsOpen({ mode: 'selection', selection: ctx });
  };

  const HL_doSelection = (opts = {}) => {
    const ctx = HL_getSelectionContext(opts.range || null);
    if (!ctx) return false;
    return HL_applyRange(ctx.range, {
      answerId: ctx.answerId,
      msgEl: ctx.msgEl,
      color: opts.color,
      clearSelection: opts.clearSelection,
    });
  };

  /* ───────────────────────────── 🎨 Styles (cgxui only) ───────────────────────────── */
  const UI_injectStyles = () => {
    if (document.getElementById(CSS_STYLE_ID)) return;

    const css = `
mark.${CSS_CLS_HL}{
  --hl-color: var(--hl-color, #FFD54F);
  --hl-strength: 0.46;
  background-color: color-mix(in srgb, var(--hl-color) calc(var(--hl-strength) * 100%), transparent) !important;
  color: inherit !important;

  border-radius: 2px;
  padding: 0 1px;
  box-shadow: none;

  box-decoration-break: clone;
  -webkit-box-decoration-break: clone;
  line-height: inherit;
  text-decoration: none !important;
  outline: none;
  display: inline;

  transition: background-color .15s ease, opacity .12s ease;
}

mark.${CSS_CLS_HL} + mark.${CSS_CLS_HL}{
  margin-left: -1px;
}

mark.${CSS_CLS_HL}:hover{
  background-color: color-mix(in srgb, var(--hl-color) 58%, transparent) !important;
}

/* Tools panel (was .cgxui-hl-tools) */
.${CSS_CLS_TOOLS}[${ATTR_CGX_OWNER}="${SkID}"]{
  position: fixed;
  top: 0; left: 0;
  transform: translate(-9999px, -9999px);

  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: center;

  width: auto;
  height: auto;

  padding: 7px;
  margin: 0;

  border: 1px solid rgba(255,255,255,0.05);
  border-radius: 7px;

  background: rgba(70,70,70,0.85);
  backdrop-filter: blur(8px) saturate(60%);
  -webkit-backdrop-filter: blur(8px);

  box-shadow: 0 4px 12px rgba(0,0,0,0.45);

  opacity: 0;
  pointer-events: none;
  transition: opacity .15s ease;
  z-index: 99999;
}

.${CSS_CLS_SWATCH_WRAP}[${ATTR_CGX_OWNER}="${SkID}"]{
  display: grid;
  grid-template-columns: repeat(4, auto);
  gap: 4px;
  padding: 0;
  margin: 0;
}

.${CSS_CLS_SWATCH}[${ATTR_CGX_OWNER}="${SkID}"]{
  all: unset;
  box-sizing: border-box;

  width: 16px;
  height: 8px;
  border-radius: 2px;

  background: color-mix(in srgb, var(--swatch) 70%, #1a1a1a);
  cursor: pointer;
  opacity: 0.95;
  transition: transform .12s ease, box-shadow .12s ease;
}

.${CSS_CLS_SWATCH}[${ATTR_CGX_OWNER}="${SkID}"]:hover{
  opacity: 1;
  transform: scale(1.12);
  box-shadow: 0 0 4px color-mix(in srgb, var(--swatch) 40%, transparent);
}
    `;

    const s = document.createElement('style');
    s.id = CSS_STYLE_ID;
    s.setAttribute(ATTR_CGX_OWNER, SkID);
    s.textContent = css;
    document.head.appendChild(s);

    MOD._styleEl = s;
  };

  /* ───────────────────────────── 🧭 Restore scheduler (SPA) ───────────────────────────── */
  let STATE_urlSig = location.pathname + location.search;
  const STATE_restoreTimers = new Map();
  const STATE_stabilizeTs = new Map();
  const STATE_lastTextHash = new Map();
  const STATE_restoreSignalSeen = new Map();

  const REST_scheduleFor = (el) => {
    if (!el) return;

    if (MSG_isSoftUnmounted(el)) {
      const n = (STATE_unstableRetries.get(el) || 0) + 1;
      STATE_unstableRetries.set(el, n);
      if (n <= CFG_UNSTABLE_RETRY_MAX) UTIL_setTimeout(() => REST_scheduleFor(el), 250 + n * 50);
      return;
    }

    const id = MSG_getAnswerId(el);

    if (MSG_isUnstableAnswerId(id)) {
      const n = (STATE_unstableRetries.get(el) || 0) + 1;
      STATE_unstableRetries.set(el, n);
      if (n <= CFG_UNSTABLE_RETRY_MAX) UTIL_setTimeout(() => REST_scheduleFor(el), CFG_UNSTABLE_RETRY_BASE_MS + n * CFG_UNSTABLE_RETRY_STEP_MS);
      return;
    }

    STATE_unstableRetries.delete(el);

    clearTimeout(STATE_restoreTimers.get(id));
    if (MSG_isQuestionRestoreReady(el)) {
      STATE_restoreTimers.set(id, UTIL_setTimeout(() => {
        STATE_restoreTimers.delete(id);
        HL_restoreMessage(el);
      }, 0));
      return;
    }
    STATE_restoreTimers.set(id, setTimeout(() => REST_tryWhenStable(el, id), CFG_RESTORE_DEBOUNCE_MS));
  };

  const REST_tryWhenStable = (el, id) => {
    const t = UTIL_textOf(el);
    const h = UTIL_hashText(t);
    const last = STATE_lastTextHash.get(id);
    const now = performance.now();
    const lastTs = STATE_stabilizeTs.get(id) || 0;

    if (h !== last || (now - lastTs) < CFG_STABLE_WINDOW_MS) {
      STATE_lastTextHash.set(id, h);
      STATE_stabilizeTs.set(id, now);
      STATE_restoreTimers.set(id, setTimeout(() => REST_tryWhenStable(el, id), CFG_STABLE_WINDOW_MS));
      return;
    }

    HL_restoreMessage(el);
  };

  const REST_allStable = (reason = 'initial') => {
    const start = performance.now();
    const MAX_WAIT_MS = CFG_REFRESH_STABLE_MAX_WAIT_MS;
    const NEED_STABLE_FRAMES = CFG_REFRESH_STABLE_FRAMES;

    let lastSig = '';
    let stableFrames = 0;

    const makeSig = (nodes) => {
      const a = nodes.slice(0, 3).map(n => MSG_getAnswerId(n)).join(',');
      const b = nodes.slice(-3).map(n => MSG_getAnswerId(n)).join(',');
      return `${nodes.length}|${a}|${b}`;
    };

    const tick = () => {
      const nodes = Array.from(document.querySelectorAll(SEL_MSG));
      if (!nodes.length) {
        if ((performance.now() - start) < MAX_WAIT_MS) return requestAnimationFrame(tick);
        return;
      }

      const ok = nodes.every(n => n && n.isConnected && !MSG_isSoftUnmounted(n) && !MSG_isUnstableAnswerId(MSG_getAnswerId(n)));
      const sig = makeSig(nodes);

      if (ok && sig === lastSig) stableFrames++;
      else stableFrames = 0;

      lastSig = sig;

      if (stableFrames >= NEED_STABLE_FRAMES) {
        nodes.forEach(REST_scheduleFor);
        return;
      }

      if ((performance.now() - start) < MAX_WAIT_MS) return requestAnimationFrame(tick);

      nodes.forEach(REST_scheduleFor);
    };

    requestAnimationFrame(tick);
  };

  const REST_shouldSkipSignal = (kind, rawKey, windowMs = CFG_SIGNAL_DEDUPE_MS) => {
    const key = String(rawKey || '').trim();
    if (!key) return false;
    const sig = `${String(kind || 'restore')}|${key}`;
    const now = performance.now();
    const last = Number(STATE_restoreSignalSeen.get(sig) || 0);
    STATE_restoreSignalSeen.set(sig, now);
    if (STATE_restoreSignalSeen.size > 192) {
      for (const [storedKey, storedTs] of Array.from(STATE_restoreSignalSeen.entries())) {
        if ((now - Number(storedTs || 0)) > (windowMs * 8)) STATE_restoreSignalSeen.delete(storedKey);
      }
    }
    return (now - last) < windowMs;
  };

  const REST_scheduleResolvedNodes = (nodes = []) => {
    const seen = new Set();
    let count = 0;
    for (const el of Array.isArray(nodes) ? nodes : []) {
      const msg = el?.matches?.(SEL_MSG) ? el : MSG_findContainer(el);
      if (!msg || !msg.isConnected) continue;
      const id = String(MSG_getAnswerId(msg) || '').trim() || `node:${count}`;
      if (seen.has(id)) continue;
      seen.add(id);
      REST_scheduleFor(msg);
      count += 1;
    }
    return count;
  };

  const REST_restoreInlineHighlights = (target, opts = {}) => {
    const resolved = MSG_resolveTurnPair(target, opts);
    const scheduledCount = REST_scheduleResolvedNodes(resolved.nodes);
    return {
      ok: scheduledCount > 0,
      scheduledCount,
      ...resolved,
    };
  };

  const REST_mountedHighlightsAvailable = () => {
    try {
      const store = STORE_read() || {};
      const byAnswer = store.itemsByAnswer || {};
      const nodes = Array.from(document.querySelectorAll(SEL_MSG));
      for (const node of nodes) {
        const answerId = String(MSG_getAnswerId(node) || '').trim();
        if (!answerId) continue;
        const list = byAnswer[answerId];
        if (Array.isArray(list) && list.length) return true;
      }
    } catch {}
    return false;
  };

  const REST_reloadStoreThenAllStable = (reason = 'studio-reader-loaded') => {
    const finish = () => REST_allStable(reason);
    try {
      const store = W.H2O?.Studio?.store?.highlights;
      if (REST_mountedHighlightsAvailable() || !store || typeof store.reload !== 'function') {
        finish();
        return;
      }
      Promise.resolve(store.reload()).then(finish, finish);
    } catch {
      finish();
    }
  };

  const REST_handleTargetedSignal = (payload, kind = 'restore') => {
    const detail = payload?.detail && typeof payload.detail === 'object' ? payload.detail : payload;
    const resolved = MSG_resolveTurnPair(detail);
    const key = [
      resolved.answerId,
      resolved.questionId,
      resolved.turnId,
      Number(detail?.ts || 0) || '',
      String(detail?.source || kind || '').trim(),
    ].filter(Boolean).join('|');
    if (!key || REST_shouldSkipSignal(kind, key)) return false;
    return REST_restoreInlineHighlights(detail).ok;
  };

  const REST_handlePaginationSignal = (payload) => {
    const detail = payload?.detail && typeof payload.detail === 'object' ? payload.detail : payload;
    const answerRange = detail?.answerRange || {};
    const key = [
      Number(detail?.pageIndex ?? -1),
      Number(detail?.pageCount ?? -1),
      Number(answerRange?.start ?? 0),
      Number(answerRange?.end ?? 0),
      Number(detail?.ts ?? 0),
    ].join('|');
    if (REST_shouldSkipSignal('pagination', key)) return false;
    REST_allStable('pagination:pagechanged');
    return true;
  };

  /* ───────────────────────────── 🔭 Observers + navigation patch ───────────────────────────── */
  let STATE_mo = null;
  let STATE_historyPS = null;
  let STATE_historyRS = null;

  const OBS_observeMessages = () => {
    const root = document.querySelector(SEL_MAIN) || document.body;

    const mo = new MutationObserver(muts => {
      const touched = new Set();

      for (const m of muts) {
        const target = m.target;

        if (target instanceof Element && target.matches?.(SEL_MSG) && !MSG_isSoftUnmounted(target)) {
          touched.add(target);
        }

        if (m.type === 'attributes' && target instanceof Element && target.matches?.(SEL_MSG)) {
          touched.add(target);
        }

        if (m.addedNodes && m.addedNodes.length) {
          m.addedNodes.forEach(n => {
            if (!(n instanceof Element)) return;

            if (n.matches?.(SEL_MSG) && !MSG_isSoftUnmounted(n)) touched.add(n);

            n.querySelectorAll?.(SEL_MSG).forEach(el => {
              if (!MSG_isSoftUnmounted(el)) touched.add(el);
            });
          });
        }
      }

      touched.forEach(REST_scheduleFor);
    });

    mo.observe(root, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['data-cgxui-unmounted', 'data-message-id', 'data-cgxui-uid', 'data-testid', 'id']
    });

    document.querySelectorAll(SEL_MSG).forEach(el => { if (!MSG_isSoftUnmounted(el)) REST_scheduleFor(el); });

    STATE_mo = mo;
  };

  const OBS_hookNavigation = () => {
    const navEvent = () => {
      const sig = location.pathname + location.search;
      if (sig !== STATE_urlSig) {
        STATE_urlSig = sig;
        setTimeout(() => document.querySelectorAll(SEL_MSG).forEach(REST_scheduleFor), 200);
      }
    };

    STATE_historyPS = history.pushState;
    STATE_historyRS = history.replaceState;

    history.pushState = function (...a) { STATE_historyPS.apply(this, a); navEvent(); };
    history.replaceState = function (...a) { STATE_historyRS.apply(this, a); navEvent(); };

    UTIL_on(window, 'popstate', navEvent);
  };

  const OBS_unhookNavigation = () => {
    try { if (STATE_historyPS) history.pushState = STATE_historyPS; } catch {}
    try { if (STATE_historyRS) history.replaceState = STATE_historyRS; } catch {}
    STATE_historyPS = null;
    STATE_historyRS = null;
  };

  const UTIL_whenReady = (selector, cb, timeout = 10000) => {
    const start = performance.now();
    (function check() {
      const el = document.querySelector(selector);
      if (el) return cb(el);
      if (performance.now() - start < timeout) return setTimeout(check, 200);
      console.warn(`[H2O.${MODTAG}] whenReady timeout`, selector);
    })();
  };

  /* ───────────────────────────── 🧠 MiniMap prime from store (colors only) ───────────────────────────── */
  const MM_primeFromStore = () => {
    try {
      const store = STORE_read() || {};
      STORE_ensureShape(store);

      const currentConvoId = UTIL_getConvoKey();
      const itemsByAnswer = store.itemsByAnswer || {};
      for (const [answerId, list] of Object.entries(itemsByAnswer)) {
        if (!Array.isArray(list) || !list.length) continue;

        const msgEl = MSG_getById(answerId) || MSG_findContainer(document.querySelector(`[data-message-id="${answerId}"]`));
        const role = msgEl?.getAttribute?.('data-message-author-role') || 'assistant';
        const canon = CANON_resolveAnswerMeta(answerId, { role, msgEl });
        const scoped = list.filter((h) => {
          if (!h) return false;
          if (h.convoId) return h.convoId === currentConvoId;
          return !!(msgEl || canon);
        });
        if (!scoped.length) continue;

        const hex = scoped.map(h => (PAL_colorDef(h.color)?.color) || '').filter(Boolean);
        const colors = Array.from(new Set(hex));
        if (!colors.length) continue;

        const detail = { answerId, colors, source: 'highlighter:prime', ts: Date.now() };

        if (H2O?.events?.emit) H2O.events.emit(EV_BUS_INLINE_CHANGED, detail);
        else {
          try { W.dispatchEvent(new CustomEvent(EV_DOM_CGXUI_INLINE_CHANGED,  { detail, bubbles: true, composed: true })); } catch {}
          try { W.dispatchEvent(new CustomEvent(EV_DOM_H2O_INLINE_CHANGED, { detail, bubbles: true, composed: true })); } catch {}
          try { W.dispatchEvent(new CustomEvent(`evt:h2o:inline:changed`, { detail, bubbles: true, composed: true })); } catch {}
          try { W.dispatchEvent(new CustomEvent(`h2o-inline:changed`, { detail, bubbles: true, composed: true })); } catch {}
        }

        if (typeof window.syncMiniMapDot === 'function') {
          window.syncMiniMapDot(answerId, colors, { persist: true });
        }
      }
    } catch (err) {
      console.warn(`[H2O.${MODTAG}] primeFromStore failed`, err);
    }
  };

  /* ───────────────────────────── ⌨️ Keyboard ───────────────────────────── */
  const KEY_hasSingleMod = (e, mod) => {
    if (mod === 'meta') return !!(e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey);
    if (mod === 'ctrl') return !!(e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey);
    if (mod === 'meta_or_ctrl') return !!(!e.altKey && !e.shiftKey && ((e.metaKey && !e.ctrlKey) || (e.ctrlKey && !e.metaKey)));
    return false;
  };

  const KEY_matchesBinding = (e, binding) => {
    const key = String(binding || '').trim().toLowerCase();
    if (!key || key === 'none') return false;

    switch (key) {
      case 'meta_or_ctrl_1':
        return e.code === 'Digit1' && KEY_hasSingleMod(e, 'meta_or_ctrl');
      case 'meta_1':
        return e.code === 'Digit1' && KEY_hasSingleMod(e, 'meta');
      case 'ctrl_1':
        return e.code === 'Digit1' && KEY_hasSingleMod(e, 'ctrl');
      case 'meta_or_ctrl_shift_1':
        return e.code === 'Digit1'
          && !e.altKey
          && e.shiftKey
          && ((e.metaKey && !e.ctrlKey) || (e.ctrlKey && !e.metaKey));
      case 'meta_or_ctrl_z':
        return e.code === 'KeyZ' && KEY_hasSingleMod(e, 'meta_or_ctrl');
      case 'meta_z':
        return e.code === 'KeyZ' && KEY_hasSingleMod(e, 'meta');
      case 'ctrl_z':
        return e.code === 'KeyZ' && KEY_hasSingleMod(e, 'ctrl');
      case 'escape':
        return !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey && e.key === 'Escape';
      case 'backspace':
        return !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey && e.key === 'Backspace';
      case 'delete':
        return !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey && e.key === 'Delete';
      default:
        return false;
    }
  };

  const HL_resolveShortcutColor = () => {
    const cfg = CFG_getUiConfig();
    const current = STORE_getCurrentColor();
    const primaryNames = PAL_primaryNames();
    const secondaryNames = PAL_secondaryNames();

    switch (String(cfg.shortcutColorMode || '').trim()) {
      case 'default_color':
        return PAL_defaultName();
      case 'first_primary':
        return primaryNames[0] || PAL_defaultName();
      case 'next_primary': {
        const base = PAL_primaryNameFor(current);
        const idx = Math.max(0, primaryNames.indexOf(base));
        return primaryNames[(idx + 1) % Math.max(primaryNames.length, 1)] || PAL_defaultName();
      }
      case 'paired_secondary': {
        const currentDef = PAL_colorDef(current);
        if (currentDef?.group === 'secondary') return currentDef.title;
        const paired = PAL_pairName(currentDef?.title || current);
        return secondaryNames.includes(paired) ? paired : (secondaryNames[0] || PAL_defaultName());
      }
      case 'random': {
        const colors = PAL_names();
        if (!colors.length) return PAL_defaultName();
        const idx = Math.floor(Math.random() * colors.length);
        return colors[idx] || PAL_defaultName();
      }
      case 'current_color':
      default:
        return current || PAL_defaultName();
    }
  };

  const HL_collectHighlightIdsInRange = (range, msgEl) => {
    if (!range || !msgEl) return [];
    const ids = new Set();
    const marks = Array.from(msgEl.querySelectorAll(`.${CSS_CLS_HL}`));
    for (const mark of marks) {
      let overlaps = false;
      try { if (typeof range.intersectsNode === 'function') overlaps = range.intersectsNode(mark); } catch {}
      if (!overlaps) {
        try {
          const markRange = document.createRange();
          markRange.selectNodeContents(mark);
          overlaps = !(
            range.compareBoundaryPoints(Range.END_TO_START, markRange) <= 0
            || range.compareBoundaryPoints(Range.START_TO_END, markRange) >= 0
          );
        } catch {}
      }
      if (!overlaps) continue;
      const id = String(mark.getAttribute(ATTR_HL_ID) || '').trim();
      if (id) ids.add(id);
    }
    return Array.from(ids);
  };

  const HL_clearActiveHighlight = () => {
    const selectionCtx = HL_captureSelectionContext();
    if (selectionCtx) {
      const msgEl = selectionCtx.msgEl || MSG_getById(selectionCtx.answerId);
      const range = HL_resolveSelectionCtxRange(selectionCtx);
      const ids = range ? HL_collectHighlightIdsInRange(range, msgEl) : [];
      if (ids.length) return HL_removeHighlightIds(selectionCtx.answerId, ids, msgEl);
    }

    const active = (STATE_toolsTargetId && STATE_toolsAnswerId)
      ? { id: STATE_toolsTargetId, answerId: STATE_toolsAnswerId }
      : STATE_lastMarkCtx;

    if (!active?.id || !active?.answerId) return false;
    return HL_removeHighlightIds(active.answerId, [active.id], MSG_getById(active.answerId));
  };

  const KEY_onKeyDown = (e) => {
    if (!STATE.enabled) return;
    if (UTIL_isEditableLike(e.target)) return;

    const cfg = CFG_getUiConfig();

    if (KEY_matchesBinding(e, cfg.clearShortcut)) {
      const removed = HL_clearActiveHighlight();
      if (removed) {
        e.preventDefault();
        return;
      }
    }

    const needMeta = UTIL_isMac();
    const metaOk = (needMeta && e.metaKey && !e.ctrlKey) || (!needMeta && e.ctrlKey && !e.metaKey);
    if (KEY_matchesBinding(e, cfg.applyShortcut)) {
      e.preventDefault();
      HL_doSelection({ color: HL_resolveShortcutColor(), clearSelection: true });
      return;
    }

    if (!metaOk || e.altKey || e.shiftKey) return;

    if (e.code === KEY_CYCLE) {
      e.preventDefault();
      const next = PAL_nextName(STORE_getCurrentColor());
      STORE_setCurrentColor(next);
      HL_notifyChanged(null);
    }
  };

  /* ───────────────────────────── 📚 listEntries + clear helpers (public API) ───────────────────────────── */
  const API_listEntries = (options = {}) => {
    const {
      includeEmptyText = false,
      maxTextLen = 200,
      maxContextLen = 260
    } = options;

    const store = STORE_read() || {};
    STORE_ensureShape(store);

    const currentConvoId = UTIL_getConvoKey();
    const itemsByAnswer = store.itemsByAnswer || {};

    const msgs = Array.from(document.querySelectorAll(SEL_MSG));
    const indexByAnswerId = new Map();
    msgs.forEach((el, idx) => {
      const id = MSG_getAnswerId(el);
      if (id) indexByAnswerId.set(id, idx);
    });

    const entries = [];

    for (const [answerId, list] of Object.entries(itemsByAnswer)) {
      if (!Array.isArray(list) || !list.length) continue;

      const msgEl = MSG_getById(answerId) || MSG_findContainer(document.querySelector(`[data-message-id="${answerId}"]`));
      const role = msgEl?.getAttribute?.('data-message-author-role') || 'assistant';
      const canon = CANON_resolveAnswerMeta(answerId, { role, msgEl });
      const canonicalAnswerId = String(canon?.answerId || '').trim();
      const answerIndex = Number.isFinite(Number(canon?.answerIndex))
        ? Number(canon.answerIndex)
        : (indexByAnswerId.get(answerId) ?? -1);
      const answerNumber = Number.isFinite(Number(canon?.answerNumber))
        ? Number(canon.answerNumber)
        : (!CANON_isPaginationEnabled() && Number.isFinite(Number(list?.[0]?.pairNo)) ? Number(list[0].pairNo) : (answerIndex >= 0 ? (answerIndex + 1) : null));
      const turnId = String(canon?.turnId || '').trim();
      const turnIndex = Number.isFinite(Number(canon?.turnIndex))
        ? Number(canon.turnIndex)
        : (answerIndex >= 0 ? answerIndex : -1);

      for (const h of list) {
        if (!h || !h.id) continue;

        if (h.convoId && h.convoId !== currentConvoId) continue;
        if (!h.convoId && !msgEl && !canon) continue;

        const hlId = h.id;
        let text = '';
        let context = '';
        let range = null;

        if (msgEl) {
          const marks = msgEl.querySelectorAll(`mark.${CSS_CLS_HL}[${ATTR_HL_ID}="${UTIL_cssEsc(hlId)}"]`);
          if (marks.length) {
            const rr = document.createRange();
            rr.setStartBefore(marks[0]);
            rr.setEndAfter(marks[marks.length - 1]);
            text = (rr.toString() || '').replace(/\s+/g, ' ').trim();
          }

          if (!text) {
            range = HL_resolveAnchors(h, msgEl);
            if (range && !range.collapsed) text = (range.toString() || '').replace(/\s+/g, ' ').trim();
          }
        }

        if (!text && h.anchors?.textQuote?.exact) {
          text = (h.anchors.textQuote.exact || '').replace(/\s+/g, ' ').trim();
        }

        if (!text && !includeEmptyText) continue;

        const fullText = text;
        if (text.length > maxTextLen) text = text.slice(0, maxTextLen).trimEnd() + '…';

        if (h.anchors?.textQuote) {
          const tq = h.anchors.textQuote;
          const pre = (tq.prefix || '').replace(/\s+/g, ' ').trim();
          const suf = (tq.suffix || '').replace(/\s+/g, ' ').trim();
          context = [pre, fullText, suf].filter(Boolean).join(' … ');
          if (context.length > maxContextLen) context = context.slice(0, maxContextLen).trimEnd() + '…';
        } else {
          context = text;
        }

        const colorName = h.color || PAL_defaultName();
        const def = PAL_colorDef(colorName);
        const colorHex = def?.color || PAL_colorDef(PAL_defaultName()).color;

        entries.push({
          convoId: h.convoId || currentConvoId,
          answerId: canonicalAnswerId || answerId,
          turnId,
          hlId,
          colorName,
          colorHex,
          text,
          context,
          role,
          answerIndex,
          answerNumber,
          turnIndex,
          pairNo: Number.isFinite(Number(canon?.pairNo)) ? Number(canon.pairNo) : (!CANON_isPaginationEnabled() ? (h.pairNo ?? answerNumber ?? null) : (answerNumber ?? null)),
          createdAt: h.ts || 0,
          anchors: h.anchors || {}
        });
      }
    }

    entries.sort((a, b) => {
      const aRank = Number.isFinite(Number(a.answerIndex)) && Number(a.answerIndex) >= 0
        ? Number(a.answerIndex)
        : (Number.isFinite(Number(a.answerNumber)) && Number(a.answerNumber) > 0 ? (Number(a.answerNumber) - 1) : Number.MAX_SAFE_INTEGER);
      const bRank = Number.isFinite(Number(b.answerIndex)) && Number(b.answerIndex) >= 0
        ? Number(b.answerIndex)
        : (Number.isFinite(Number(b.answerNumber)) && Number(b.answerNumber) > 0 ? (Number(b.answerNumber) - 1) : Number.MAX_SAFE_INTEGER);
      if (aRank !== bRank) return aRank - bRank;
      return (a.createdAt || 0) - (b.createdAt || 0);
    });

    return entries;
  };

  const API_clearAll = async () => {
    try {
      STORE_write(() => ({}));
      await STORE_saveNow();
    } catch (err) {
      if (CFG_DEBUG) console.warn(`[H2O.${MODTAG}] clearAll failed`, err);
    }
  };

  const API_clearCurrentChat = async () => {
    const currentConvoId = UTIL_getConvoKey();
    const answerEls = Array.from(document.querySelectorAll(SEL_ANSWER));
    const mountedAnswerIds = new Set();
    const removedByAnswer = new Map();
    const currentChatAnswerCache = new Map();

    for (const msgEl of answerEls) {
      const answerId = String(MSG_getAnswerId(msgEl) || '').trim();
      if (!answerId) continue;
      mountedAnswerIds.add(answerId);

      const ids = Array.from(new Set(
        Array.from(msgEl.querySelectorAll(`.${CSS_CLS_HL}`))
          .map((mark) => String(mark.getAttribute(ATTR_HL_ID) || '').trim())
          .filter(Boolean)
      ));
      if (!ids.length) continue;
      removedByAnswer.set(answerId, ids);
      ids.forEach((id) => HL_unwrapById(id, msgEl));
    }

    const isCurrentChatAnswerId = (answerId) => {
      const key = String(answerId || '').trim();
      if (!key) return false;
      if (mountedAnswerIds.has(key)) return true;
      if (currentChatAnswerCache.has(key)) return !!currentChatAnswerCache.get(key);

      let inCurrentChat = false;
      try {
        const msgEl = MSG_getById(key);
        const canon = CANON_resolveAnswerMeta(key, { role: 'assistant', msgEl });
        inCurrentChat = !!(canon?.answerId || canon?.turnId);
      } catch {}

      currentChatAnswerCache.set(key, inCurrentChat);
      return inCurrentChat;
    };

    try {
      STORE_write((draft) => {
        STORE_ensureShape(draft);
        const byAnswer = draft.itemsByAnswer || {};

        for (const [answerId, list] of Object.entries(byAnswer)) {
          if (!Array.isArray(list) || !list.length) continue;

          const knownRemoved = new Set(removedByAnswer.get(answerId) || []);
          const isLegacyCurrentChat = isCurrentChatAnswerId(answerId);
          const nextList = list.filter((item) => {
            const itemId = String(item?.id || '').trim();
            const itemConvoId = String(item?.convoId || '').trim();
            const remove = (itemConvoId && itemConvoId === currentConvoId)
              || knownRemoved.has(itemId)
              || (!itemConvoId && isLegacyCurrentChat);
            if (remove && itemId) knownRemoved.add(itemId);
            return !remove;
          });

          if (knownRemoved.size) removedByAnswer.set(answerId, Array.from(knownRemoved));
          if (nextList.length) byAnswer[answerId] = nextList;
          else delete byAnswer[answerId];
        }

        return draft;
      });
      await STORE_saveNow();
    } catch (err) {
      if (CFG_DEBUG) console.warn(`[H2O.${MODTAG}] clearCurrentChat failed`, err);
      throw err;
    }

    UI_toolsHide();
    STATE_lastMarkCtx = null;

    let removedHighlights = 0;
    for (const [answerId, ids] of removedByAnswer.entries()) {
      removedHighlights += ids.length;
      HL_notifyChanged(answerId);
      HL_emitInlineChanged(answerId);
      try { W.syncMiniMapDot?.(answerId, [], { persist: true }); } catch {}
    }
    MM_primeFromStore();

    return {
      ok: true,
      convoId: currentConvoId,
      removedHighlights,
      touchedAnswers: removedByAnswer.size,
      message: removedHighlights
        ? `Cleared ${removedHighlights} highlight(s) from this chat.`
        : 'No highlights found in this chat.',
    };
  };

  /* ───────────────────────────── 🌐 Public API (canonical + legacy mirrors) ───────────────────────────── */
  const API = {
    getStore: () => STORE_read(),
    hasHighlights: (answerId) => {
      const s = STORE_read() || {};
      return !!(s.itemsByAnswer && s.itemsByAnswer[answerId]?.length);
    },
    resolveAnswerMeta: (anyId, opts = {}) => CANON_resolveAnswerMeta(anyId, opts),
    restoreInlineHighlights: (target, opts = {}) => REST_restoreInlineHighlights(target, opts),
    listEntries: (options) => API_listEntries(options || {}),
    clearAll: API_clearAll,
    clearCurrentChat: API_clearCurrentChat,
    openPopup: (ctx = {}) => UI_toolsOpen(ctx),
    recolorTurnHighlights: (turnId, fromColor, toColor, opts = {}) => HL_recolorTurnHighlights(turnId, fromColor, toColor, opts),
    recolorExistingHighlight: (request) => HL_writeExistingFromDock('recolor', request),
    removeExistingHighlight: (request) => HL_writeExistingFromDock('remove', request),
    getConfig: () => CFG_getUiConfig(),
    applySetting: (optKey, value) => CFG_applyUiSetting(optKey, value),
    getPaletteConfig: () => CFG_getPaletteConfig(),
    paletteConfig: {
      getConfig: () => CFG_getPaletteConfig(),
      setConfig: (next) => CFG_setPaletteConfig(next || {}),
      resetConfig: () => CFG_resetPaletteConfig(),
      setDefaultColor: (name) => CFG_applyUiSetting('defaultColor', name),
    },
    setCurrentColor: STORE_setCurrentColor,
    getCurrentColor: STORE_getCurrentColor,
    setEnabled: (on) => { STATE.enabled = !!on; log('setEnabled', STATE.enabled); },
    getEnabled: () => STATE.enabled,
    dispose: () => CORE_dispose()
  };

  MOD.api = API;
  H2O.inline = API;
  W.H2OInline = API;
  W.restoreInlineHighlights = (target, opts = {}) => API.restoreInlineHighlights(target, opts);
  TOPW.H2O_HL = TOPW.H2O_HL || {};
  TOPW.H2O_HL.openPopup = (ctx = {}) => API.openPopup(ctx);
  TOPW.H2O_HL.resolveAnswerMeta = (anyId, opts = {}) => API.resolveAnswerMeta(anyId, opts);
  TOPW.H2O_HL.restoreInlineHighlights = (target, opts = {}) => API.restoreInlineHighlights(target, opts);
  TOPW.H2O_HL.recolorTurnHighlights = (turnId, fromColor, toColor, opts = {}) =>
    API.recolorTurnHighlights(turnId, fromColor, toColor, opts);

  if (typeof W.listAllEntries !== 'function') W.listAllEntries = function listAllEntriesLegacy() { return []; };
  W.listAllEntries = (...a) => API.listEntries(...a);

  /* ───────────────────────────── 🧩 Control Hub registration (legacy bridge) ───────────────────────────── */
  const BRIDGE_registerControlHub = () => {
    try {
      W.h2oConfig = W.h2oConfig || {};
      W.h2oConfig.features = W.h2oConfig.features || {};

      const describeShortcut = (value) => {
        switch (String(value || '').trim()) {
          case 'meta_1': return 'Cmd+1';
          case 'ctrl_1': return 'Ctrl+1';
          case 'meta_or_ctrl_shift_1': return 'Cmd/Ctrl+Shift+1';
          case 'none': return 'disabled';
          default: return 'Cmd/Ctrl+1';
        }
      };
      const describeClear = (value) => {
        switch (String(value || '').trim()) {
          case 'meta_z': return 'Cmd+Z';
          case 'ctrl_z': return 'Ctrl+Z';
          case 'escape': return 'Escape';
          case 'backspace': return 'Backspace';
          case 'delete': return 'Delete';
          case 'none': return 'disabled';
          default: return 'Cmd/Ctrl+Z';
        }
      };
      const describePopup = (value) => {
        switch (String(value || '').trim()) {
          case 'hover': return 'hover';
          case 'click': return 'click';
          case 'right_click': return 'right-click';
          case 'none': return 'disabled';
          default: return 'middle-click';
        }
      };

      const featureApi = {
        key: 'inlineHighlighter',
        label: 'Inline Highlighter',
        description: 'Configurable selection shortcut, remove shortcut, popup trigger, and editable palette.',
        enabled() { return STATE.enabled; },
        setEnabled(on) { STATE.enabled = !!on; console.log('[ControlHub→Highlighter] setEnabled:', STATE.enabled ? 'ON' : 'OFF'); },
        getConfig() { return CFG_getUiConfig(); },
        applySetting(optKey, value) { return CFG_applyUiSetting(optKey, value); },
        getSummary() {
          const cfg = CFG_getUiConfig();
          return `Apply on ${describeShortcut(cfg.applyShortcut)}, clear on ${describeClear(cfg.clearShortcut)}, popup on ${describePopup(cfg.popupTrigger)}.`;
        },
        paletteConfig: API.paletteConfig,
        clearCurrentChat: API.clearCurrentChat,
      };

      W.h2oConfig.features.highlighter = featureApi;
      W.h2oConfig.features.inlineHighlighter = featureApi;
      W.hoConfig = W.h2oConfig;
      W.hoConfig.features = W.h2oConfig.features;
    } catch (e) {
      console.warn(`[H2O.${MODTAG}] ControlHub registration failed`, e);
    }
  };

  /* ───────────────────────────── 🚀 Boot / dispose ───────────────────────────── */
  let CORE_hasBooted = false;

  const CORE_boot = async () => {
    if (CORE_hasBooted) return;
    CORE_hasBooted = true;

    DIAG_step('boot');
    DIAG.bootCount += 1;
    DIAG.lastBootAt = Date.now();

    UI_injectStyles();
    OBS_hookNavigation();
    OBS_observeMessages();

    UTIL_on(document, 'keydown', KEY_onKeyDown, true);

    UTIL_on(document, 'mousedown', (e) => {
      const mark = e.target.closest?.(`.${CSS_CLS_HL}`);
      if (!mark) return;
      HL_rememberMarkContext(mark);

      const trigger = CFG_getUiConfig().popupTrigger;
      if (e.button === 1 && trigger === 'middle_click') {
        e.preventDefault();
        HL_openPopupForMark(mark);
        return;
      }
      if (e.button === 0 && trigger === 'click') {
        e.preventDefault();
        HL_openPopupForMark(mark);
      }
    }, true);

    UTIL_on(document, 'contextmenu', (e) => {
      const mark = e.target.closest?.(`.${CSS_CLS_HL}`);
      if (!mark) return;
      HL_rememberMarkContext(mark);
      if (CFG_getUiConfig().popupTrigger !== 'right_click') return;
      e.preventDefault();
      e.stopPropagation();
      HL_openPopupForMark(mark);
    }, true);

    UTIL_on(document, 'mouseenter', (e) => {
      const mark = e.target.closest?.(`.${CSS_CLS_HL}`);
      if (mark) UI_onMouseEnterMark(mark);
    }, { capture: true, passive: true });

    const onRemounted = (payload) => {
      REST_handleTargetedSignal(payload, 'remount');
    };
    const onInlineRestored = (payload) => {
      REST_handleTargetedSignal(payload, 'inline-restored');
    };
    const onPaginationChanged = (payload) => {
      REST_handlePaginationSignal(payload);
    };
    const onStudioReaderRefreshRequested = (payload) => {
      const detail = payload?.detail && typeof payload.detail === 'object' ? payload.detail : {};
      if (detail.source && detail.source !== 'reader-loaded') return;
      REST_reloadStoreThenAllStable('studio-reader-loaded');
    };

    for (const evtName of [
      EV_DOM_H2O_MSG_REMOUNTED_EVT,
      EV_DOM_H2O_MSG_REMOUNTED,
      EV_DOM_CGXUI_MSG_REMOUNTED,
      EV_BUS_MSG_REMOUNTED,
    ]) {
      UTIL_on(W, evtName, onRemounted, true);
      UTIL_onBus(evtName, onRemounted);
    }

    for (const evtName of [
      EV_DOM_H2O_INLINE_RESTORED_EVT,
      EV_DOM_H2O_INLINE_RESTORED,
    ]) {
      UTIL_on(W, evtName, onInlineRestored, true);
      UTIL_onBus(evtName, onInlineRestored);
    }

    for (const evtName of [
      EV_DOM_H2O_PAGINATION_CHANGED_EVT,
      EV_DOM_H2O_PAGINATION_CHANGED,
    ]) {
      UTIL_on(W, evtName, onPaginationChanged, true);
      UTIL_onBus(evtName, onPaginationChanged);
    }

    UTIL_on(W, EV_DOM_STUDIO_READER_REFRESH_REQUESTED, onStudioReaderRefreshRequested, true);
    UTIL_onBus(EV_DOM_STUDIO_READER_REFRESH_REQUESTED, onStudioReaderRefreshRequested);

    UTIL_whenReady(SEL_MAIN, () => {
      REST_allStable('boot');
      MM_primeFromStore();
    });

    const rememberSelection = UTIL_debounce(() => {
      HL_getSelectionContext();
    }, 40);
    UTIL_on(document, 'selectionchange', rememberSelection, false);
    UTIL_on(document, 'mouseup', rememberSelection, true);

    try {
      UTIL_on(window, 'message', (ev) => {
        if (ev.source !== window) return;
        const data = ev.data;
        if (!data || data.type !== MSG_EXT_HIGHLIGHT_REQ) return;
        const req = data.req && typeof data.req === 'object' ? data.req : {};
        const action = String(req.action || 'popup').trim().toLowerCase();
        if (action === 'apply') {
          HL_doSelection({ color: req.color, clearSelection: true });
          return;
        }
        HL_openSelectionPopup();
      }, false);

      // ── Transport seam ──────────────────────────────────────────────────
      // Inbound highlight-trigger messages route through
      // H2O.Studio.platform.messaging.on — the required boundary for the
      // future Tauri port. Type filter ('h2o-highlight-trigger'), action
      // dispatch, and "no async response" semantics are preserved exactly:
      // the handler returns nothing, which under both chrome.runtime and
      // the platform adapter means "synchronous, do not sendResponse".
      // Falls back to direct chrome.runtime.onMessage.addListener if the
      // platform adapter is unavailable. See
      // surfaces/studio/STUDIO_PLATFORM_ADAPTER_GUIDE.md.
      const onHighlightTrigger = (request) => {
        if (request?.type !== 'h2o-highlight-trigger') return;
        const action = String(request?.action || 'popup').trim().toLowerCase();
        if (action === 'apply') {
          HL_doSelection({ color: request?.color, clearSelection: true });
          return;
        }
        HL_openSelectionPopup();
      };
      const pmHL = (function () {
        const p = W.H2O && W.H2O.Studio && W.H2O.Studio.platform && W.H2O.Studio.platform.messaging;
        if (!p || typeof p.on !== 'function') return null;
        const env = W.H2O && W.H2O.Studio && W.H2O.Studio.platform && W.H2O.Studio.platform.env;
        if (env && env.adapter === 'fallback') return null;
        return p;
      })();
      if (pmHL) {
        pmHL.on('highlight', onHighlightTrigger);
      } else if (chrome?.runtime?.onMessage) {
        chrome.runtime.onMessage.addListener(onHighlightTrigger);
      }
    } catch (err) {
      console.warn(`[H2O.${MODTAG}] highlight-trigger listener failed`, err);
    }

    log('booted');
  };

  const CORE_dispose = () => {
    if (!CORE_hasBooted) return;
    CORE_hasBooted = false;
    DIAG_step('dispose');
    DIAG.disposedCount += 1;
    DIAG.lastDisposeAt = Date.now();
    try { STATE_mo?.disconnect(); } catch {}
    try { W.H2O?.Studio?.store?.highlights?.dispose?.(); } catch {}
    try { OBS_unhookNavigation(); } catch {}
    try { UTIL_offAll(); } catch {}
    try { UTIL_clearAllTimers(); } catch {}
    log('disposed');
  };

  const init = async () => {
    DIAG.steps = [];
    DIAG_step('init');

    await (W.H2O?.Studio?.store?.highlights?.init?.() || Promise.resolve());

    BRIDGE_registerControlHub();
    CORE_boot();
  };

  init().catch((err) => {
    console.error(`[H2O.${MODTAG}] boot failed`, err);
    DIAG_fail(err);
  });

})();
