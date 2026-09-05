// ==H2O Module==
// @h2o-id             1c1b.chat.pages.controller
// @name               1C1b.🔴📑 Thread Pages Controller 📑
// @namespace          H2O.Premium.CGX.chat.pages.controller
// @author             HumamDev
// @version            2.2.5
// @revision           001
// @build              260413-010100
// @description        MiniMap add-on: chat-page fold behavior owner. Phase 5 moves page-fold DOM mechanics and title-list/page-collapse logic here.
// @match              https://chatgpt.com/*
// @run-at             document-idle
// @grant              none
// ==/H2O Module==

(() => {
  'use strict';

  const W = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;
  const TOPW = W.top || W;
  const H2O = (TOPW.H2O = TOPW.H2O || {});
  if (W !== TOPW) W.H2O = H2O;

  const MODTAG = 'ChatPagesCtl';
  const EV_PAGE_CHANGED = 'evt:h2o:pagination:pagechanged';
  const EV_PAGE_CFG_CHANGED = 'evt:h2o:pagination:configchanged';
  const EV_ANSWER_COLLAPSE = 'evt:h2o:answer:collapse';
  const EV_TITLE_SET = 'evt:h2o:title:set';
  const EV_CORE_INDEX_UPDATED = 'evt:h2o:core:index:updated';
  const EV_CORE_TURN_UPDATED = 'evt:h2o:core:turn:updated';
  const EV_MM_TOGGLE_PAGE_COLLAPSED = 'evt:h2o:minimap:toggle-page-collapsed';
  // 1A1d dispatches this prefixed name only, so binding one name yields
  // exactly one effective reconciliation per readiness transition.
  const EV_MM_SHELL_READY = 'evt:h2o:minimap:shell-ready';
  const EV_ROUTE_CHANGED = 'evt:h2o:route:changed';
  const EV_VISIT_STATE_MODE_CHANGED = 'evt:h2o:chat-pages:visit-state-mode-changed';
  const ATTR_CHAT_PAGE_HIDDEN = 'data-cgxui-chat-page-hidden';
  const ATTR_CHAT_PAGE_NUM = 'data-cgxui-chat-page-num';
  const ATTR_CHAT_PAGE_TITLE_ITEM = 'data-cgxui-chat-page-title-item';
  const ATTR_CHAT_PAGE_QUESTION_HIDDEN = 'data-cgxui-chat-page-question-hidden';
  const ATTR_CHAT_PAGE_NO_ANSWER_QUESTION_HIDDEN = 'data-cgxui-chat-page-no-answer-question-hidden';
  const ATTR_CHAT_PAGE_WRAPPER_HIDDEN = 'data-cgxui-chat-page-wrapper-hidden';
  const ATTR_CHAT_PAGE_NATIVE_HIDDEN = 'data-cgxui-chat-page-native-hidden';
  const ATTR_COLLAPSE_READINESS = 'data-h2o-collapse-readiness';
  const ATTR_COLLAPSE_REASON = 'data-h2o-collapse-reason';
  const ATTR_COLLAPSE_CONTROL_STATE = 'data-h2o-collapse-control-state';
  const ATTR_COLLAPSE_FEEDBACK = 'data-h2o-collapse-feedback';
  const COLLAPSE_UNAVAILABLE_STATUS = 'collapsed-exact-boundary-unavailable';
  const COLLAPSE_UNAVAILABLE_MESSAGE = 'Collapse unavailable until the next page boundary is loaded.';
  const COLLAPSE_LAYOUT_INCOMPLETE_MESSAGE = 'Collapse temporarily unavailable because the conversation layout is incomplete.';
  // Shown when the capability was ready but the transaction itself could not
  // commit. Naming a boundary or a layout problem there would be inaccurate.
  const COLLAPSE_TRANSIENT_FAILURE_MESSAGE = 'Collapse is temporarily unavailable. Please try again.';
  const ANSWER_TITLE_COLLAPSED_ATTR = 'data-at-collapsed';
  const TURN_HOST_SEL = '[data-testid="conversation-turn"], [data-testid^="conversation-turn-"]';
  const USER_MSG_SEL = '[data-message-author-role="user"]';
  const ASSISTANT_MSG_SEL = '[data-message-author-role="assistant"]';
  const NO_ANSWER_TITLE_BAR_SEL = '[data-cgxui="atns-answer-title"][data-cgxui-owner="atns"][data-at-no-answer="1"]';
  const ANSWER_TITLE_ICON_SEL = '[data-cgxui="atns-answer-title-icon"][data-cgxui-owner="atns"]';
  const TITLE_LIST_ROW_GAP_PX = 4;
  const DIVIDER_STYLE_ID = 'cgxui-chat-pages-divider-style';
  const TITLE_LIST_PAGE_SIZE = 25;
  const TITLE_LIST_PAGE_HYDRATION_OWNER = 'chat-pages:title-list';

  /* Divider visual keys — tune these safely */
  const DIVIDER_VISUAL_KEYS = Object.freeze({
    lineLeftScale: 1.30,
    lineRightScale: 1.30,

    // Authoritative live circle size: these tokens become inline !important
    // width/height/min-width/min-height on the dot, so they - not the authored
    // base CSS - decide what the user actually sees. The transparent hit child
    // stays 28x28 and centred around this circle.
    dotSizeExpandedPx: 14,                                      // 👈 ↑ = bigger circle; ↓ = smaller circle
    dotSizeCollapsedPx: 14,                                     // 👈 keep equal to the expanded size

    expandedDotColor: '#facc15',
    expandedDotGlowColor: 'rgba(250, 204, 21, 0.48)',
    expandedDotGlowBlurPx: 10,
    expandedDotGlowSpreadPx: 0,

    collapsedDotColor: '#b8c0cc',
    collapsedDotGlowColor: 'rgba(184, 192, 204, 0.30)',
    collapsedDotGlowBlurPx: 12,
    collapsedDotGlowSpreadPx: 0,
  });
  const RESTORE_PROPS = [
    'display', 'overflow', 'max-height', 'height', 'min-height',
    'margin-top', 'margin-bottom', 'padding-top', 'padding-bottom',
    'border-top-width', 'border-bottom-width', 'opacity',
    'pointer-events', 'transition', 'gap'
  ];
  const COMPACT_ZERO_PROPS = [
    'min-height','height','max-height','padding-top','padding-bottom','padding-left','padding-right',
    'margin-top','margin-bottom','gap','border-top-width','border-bottom-width'
  ];

  /* Phase 6: 1A2c is now the sole active owner of chat-page folding behavior; Core remains page-surface authority */
  const S = {
    booted: false,
    bound: false,
    chatId: '',
    collapsedPagesByChat: new Map(),
    titleListPagesByChat: new Map(),
    collapsedPageDriversByChat: new Map(),
    chatPageRevsByChat: new Map(),
    collapsedPageModesByChat: new Map(),
    bridgeOff: null,
    listenersBound: false,
    lastAppliedChatId: '',
    onDividerDblClick: null,
    onDividerClick: null,
    onDividerDotClick: null,
    onDividerDotKeyDown: null,
    onAnswerCollapse: null,
    onTitleSet: null,
    onCoreIndexUpdated: null,
    onCoreTurnUpdated: null,
    onPaginationPageChanged: null,
    onPaginationConfigChanged: null,
    onMiniMapTogglePageCollapsed: null,
    onRouteChanged: null,
    onVisitStateModeChanged: null,
    titleListObserverHubOff: null,
    dividerVisualTimer: null,
    dividerVisualRefreshToken: 0,
    dividerClickTimer: null,
    dividerStyleEl: null,
    titleListStacksByKey: new Map(),
    titleListOpenStatesByKey: new Map(),
    titleListStackStatsByKey: new Map(),
    titleListStackSequence: 0,
    titleListOpenSequence: 0,
    titleListRepairTimer: 0,
    titleListRepairPages: new Set(),
    titleListRepairAllPages: false,
    titleListHydrationRecoveryIdentity: '',
    titleListHydrationRecoveryIds: new Set(),
    nativeRangeActivePages: new Set(),
    collapsedBoundaryDiagnostics: new Map(),
    renderedPageBoundaryLeases: new Map(),
    pageCollapseRangeContinuity: new Map(),
    atomicPageCollapseTransactions: new Map(),
    atomicPageCollapseGuards: new Set(),
    atomicPageCollapseAttemptSeq: 0,
    atomicPageCollapseLastAttempt: null,
    dotExpandCampaignSeq: 0,
    dotExpandCampaigns: new Map(),
    titleListBatchDepth: 0,
    titleListBatchDirty: false,
    titleListPageHydration: {
      active: false,
      source: '',
      count: 0,
      pageCount: 0,
      normalPages: [],
      guardedIds: 0,
      paginationHeld: false,
    },
    titleIntentReplayInFlight: false,
    titleIntentTrailingTimer: null,
    titleIntentLastAppliedByAnswer: new Map(),
    titleIntentStats: {
      replayRuns: 0,
      replayNoops: 0,
      replaySkippedInert: 0,
      replayReentrantSkips: 0,
      titleSetEventsSeen: 0,
      targetedApplies: 0,
      fullPageApplies: 0,
      resolverCalls: 0,
      resolverDefaultReturns: 0,
      domMutationsFromTitleIntent: 0,
      localStorageReads: 0,
      localStorageWrites: 0,
      mutationReplayRequests: 0,
      mutationReplaySelfIgnored: 0,
      membershipScans: 0,
      skippedMembershipScansInert: 0,
      debugSnapshotCalls: 0,
      debugSnapshotMutations: 0,
    },
    // Single in-memory ledger cache: localStorage is read at most once per
    // chat (and refreshed on write-through). Every hot path — mutation
    // observers, isCollapsed, title-set events — must answer "is the intent
    // system active?" from this cache in O(1) with zero storage IO.
    titleIntentLedgerCache: { chatId: '', ledger: null, inert: true },
    visitState: {
      currentVisitId: '',
      currentChatId: '',
      visitSequence: 0,
      resets: 0,
      lastMode: 'remember',
      resetAppliedThisVisit: false,
      resetAppliedAt: 0,
      clearedFamilies: 0,
      clearedFamilyNames: [],
      clearedKeys: [],
      skippedKeys: [],
      missingChatIdDeferrals: 0,
      restoreSuppressedBecauseReset: false,
      liveStateCleared: false,
      domCleanupApplied: false,
      lastResult: null,
      deferredTimer: 0,
    },
  };

  function MM_SH() {
    try { return TOPW.H2O_MM_SHARED?.get?.() || null; } catch { return null; }
  }

  function MM_CORE_API() {
    try { return MM_SH()?.api?.core || null; } catch { return null; }
  }

  function MM_CORE_PAGES() {
    const core = MM_CORE_API();
    try { return core?.pages || core || null; } catch { return core || null; }
  }

  function AT_PUBLIC() {
    try { return TOPW.H2O?.AT?.tnswrttl?.api?.public || null; } catch { return null; }
  }

  function WASH_PUBLIC() {
    try { return TOPW.H2O?.MM?.wash || W.H2O?.MM?.wash || null; } catch { return null; }
  }

  function CM_ROUTER_API() {
    try { return TOPW.H2O?.CM?.chtmech?.api || null; } catch { return null; }
  }

  function TAGS_API() {
    try {
      return TOPW.H2O?.Tags || TOPW.H2O?.LibraryCore?.getService?.('tags') || TOPW.H2O?.LibraryCore?.getOwner?.('tags') || null;
    } catch {
      return null;
    }
  }

  function UM_PUBLIC() {
    try { return TOPW.H2O?.UM?.nmntmssgs?.api || null; } catch { return null; }
  }

  function UM_ADAPTER() {
    try {
      return TOPW.H2O?.UM?.nmntmssgs?.engine?.getChatAdapter?.()
        || UM_PUBLIC();
    } catch { return UM_PUBLIC(); }
  }

  function PG_ADAPTER() {
    try { return TOPW.H2O?.PW?.pgnwndw?.engine?.getChatAdapter?.() || null; } catch { return null; }
  }

  function ensureDividerStyle() {
    let styleEl = null;
    try { styleEl = document.getElementById(DIVIDER_STYLE_ID); } catch {}
    if (!styleEl) {
      try {
        styleEl = document.createElement('style');
        styleEl.id = DIVIDER_STYLE_ID;
        document.head.appendChild(styleEl);
      } catch {
        styleEl = null;
      }
    }
    if (!styleEl) return null;

    const css = `
.cgxui-chat-page-divider,
.cgxui-pgnw-page-divider {
  --cgxui-page-divider-dot-size: ${DIVIDER_VISUAL_KEYS.dotSizeExpandedPx}px;
  --cgxui-page-divider-dot-bg: ${DIVIDER_VISUAL_KEYS.expandedDotColor};
  --cgxui-page-divider-dot-glow: ${DIVIDER_VISUAL_KEYS.expandedDotGlowColor};
  --cgxui-page-divider-dot-glow-blur: ${DIVIDER_VISUAL_KEYS.expandedDotGlowBlurPx}px;
  --cgxui-page-divider-dot-glow-spread: ${DIVIDER_VISUAL_KEYS.expandedDotGlowSpreadPx}px;
}

.cgxui-chat-page-divider .cgxui-chat-page-divider-dot,
.cgxui-chat-page-divider .cgxui-pgnw-page-divider-dot,
.cgxui-pgnw-page-divider .cgxui-chat-page-divider-dot,
.cgxui-pgnw-page-divider .cgxui-pgnw-page-divider-dot {
  width: var(--cgxui-page-divider-dot-size) !important;
  height: var(--cgxui-page-divider-dot-size) !important;
  min-width: var(--cgxui-page-divider-dot-size) !important;
  min-height: var(--cgxui-page-divider-dot-size) !important;
  border-radius: 999px !important;
  background: var(--cgxui-page-divider-dot-bg) !important;
  box-shadow:
    0 0 0 1px color-mix(in srgb, var(--cgxui-page-divider-dot-bg) 24%, rgba(255,255,255,0.16)),
    0 0 var(--cgxui-page-divider-dot-glow-blur) var(--cgxui-page-divider-dot-glow-spread) var(--cgxui-page-divider-dot-glow) !important;
  transition: background-color 180ms ease, box-shadow 180ms ease, transform 180ms ease, width 180ms ease, height 180ms ease !important;
}

/* Page title projections remain H2O-owned. When one row is open, the primary
   projection stays before the selected native turn and a suffix projection
   carries later title rows after it; host-owned turn wrappers never enter
   either container. */
.cgxui-chat-page-title-list-synth,
.cgxui-chat-page-title-list-suffix {
  margin: 6px auto 14px;
  max-width: var(--thread-content-max-width, 48rem);
  padding: 4px 8px 4px 42px; /* left gutter for the faded side numerals */
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.cgxui-chat-page-title-list-synth > [data-cgxui="atns-answer-title"],
.cgxui-chat-page-title-list-suffix > [data-cgxui="atns-answer-title"] {
  position: relative;
  overflow: visible;
  margin: 0 !important;
}
/* Page-circle title-list number: a compact, softly faded index marker. Keep
   the glyph complete; the big-answer right-edge mask clips right-aligned
   two-digit markers in this much narrower box. */
.cgxui-chat-page-title-list-synth > [data-cgxui="atns-answer-title"][data-h2o-title-list-num="1"][data-h2o-turn-num]::before,
.cgxui-chat-page-title-list-suffix > [data-cgxui="atns-answer-title"][data-h2o-title-list-num="1"][data-h2o-turn-num]::before {
  content: attr(data-h2o-turn-num);
  position: absolute;
  right: 100%;
  top: 50%;
  transform: translateY(-50%);
  transform-origin: right center;
  margin-right: 11px;
  width: 2.25rem;
  min-width: 2.25rem;
  font-family: Georgia, "Times New Roman", serif;
  font-size: 1.15rem;
  font-weight: 700;
  font-variant-numeric: oldstyle-nums tabular-nums;
  font-feature-settings: 'onum' 1, 'tnum' 1;
  letter-spacing: 0;
  line-height: 1;
  color: rgba(128, 128, 128, 0.28);
  text-shadow: 0 0 10px rgba(128, 128, 128, 0.10);
  text-align: right;
  white-space: nowrap;
  pointer-events: none;
  user-select: none;
  z-index: 1;
  -webkit-mask-image: none;
  mask-image: none;
}
.cgxui-chat-page-title-list-synth > [data-h2o-title-row-opened="1"],
.cgxui-chat-page-title-list-suffix > [data-h2o-title-row-opened="1"] {
  box-shadow: inset 2px 0 0 rgba(94, 190, 150, 0.7);
}
/* The ownership stamp is the durable hide projection. Other mechanisms may
   restore inline display while repairing their own state; they must not make
   title-list-owned flow visible unless the stack owner removes this stamp. */
[data-cgxui-chat-page-title-list-hidden] {
  display: none !important;
}
`;

    if (styleEl.textContent !== css) styleEl.textContent = css;
    S.dividerStyleEl = styleEl;
    return styleEl;
  }

  function clearDividerRefreshTimer() {
    S.dividerVisualRefreshToken = Number(S.dividerVisualRefreshToken || 0) + 1;
    if (!S.dividerVisualTimer) return;
    try { clearTimeout(S.dividerVisualTimer); } catch {}
    S.dividerVisualTimer = null;
  }

  function clearDividerClickTimer() {
    if (!S.dividerClickTimer) return;
    try { W.clearTimeout(S.dividerClickTimer); } catch {}
    S.dividerClickTimer = null;
  }

  function openTagsCloudFromDivider(divider) {
    if (!(divider instanceof HTMLElement)) return false;
    const api = TAGS_API();
    if (typeof api?.openTagsCloudPopup !== 'function') return false;
    const chatId = resolveChatId();
    try {
      return !!api.openTagsCloudPopup(divider, {
        currentChatId: chatId,
        reason: 'chat-page-divider',
      });
    } catch {
      return false;
    }
  }

  function isDividerTitleCollapsed(pageNum = 0, chatId = '') {
    const num = Math.max(1, Number(pageNum || 0) || 0);
    const id = String(chatId || resolveChatId()).trim();
    if (!num || !id) return false;
    if (isTitleListActive(num, id)) return true;
    const summary = getPageCollapsedRowSummary(num, id);
    return !!summary.totalRows && !!summary.allCollapsed;
  }

  // Live per-row scan without the title-list-set shortcut. The divider circle
  // must decide collapse-vs-expand from what the rows actually look like, not
  // from the title-list bookkeeping — otherwise rows collapsed individually
  // (source `answer-title`) leave the page stuck in a mixed state the circle
  // can never resolve.
  function getLivePageRowCollapseSummary(pageNum = 0, chatId = '') {
    const num = Math.max(1, Number(pageNum || 0) || 0);
    const id = String(chatId || resolveChatId()).trim();
    const rows = getRows(num, id);
    let collapsedRows = 0;
    for (const row of rows) {
      if (isChatPageRowCollapsed(row)) collapsedRows += 1;
    }
    return {
      totalRows: rows.length,
      collapsedRows,
      allCollapsed: rows.length > 0 && collapsedRows >= rows.length,
      allExpanded: collapsedRows <= 0,
      mixed: collapsedRows > 0 && collapsedRows < rows.length,
    };
  }

  function getDividerUiMode(pageNum = 0, chatId = '') {
    const num = Math.max(1, Number(pageNum || 0) || 0);
    const id = String(chatId || resolveChatId()).trim();
    if (!num || !id) return 'normal';
    if (isDividerTitleCollapsed(num, id)) return 'all_collapsed';
    return 'normal';
  }

  function getDividerCircleState(pageNum = 0, chatId = '') {
    const num = Math.max(1, Number(pageNum || 0) || 0);
    if (!num) return 'expanded';
    return isDividerTitleCollapsed(num, chatId) ? 'collapsed' : 'expanded';
  }

  function getDividerRoots(pageNum = 0) {
    const num = Math.max(1, Number(pageNum || 0) || 0);
    if (!num) return [];
    const escaped = (typeof CSS !== 'undefined' && CSS?.escape)
      ? CSS.escape(String(num))
      : String(num).replace(/[^a-z0-9_-]/gi, '\\$&');
    const selectors = [
      `.cgxui-chat-page-divider[data-page-num="${escaped}"]`,
      `.cgxui-chat-page-divider[data-cgxui-chat-page-num="${escaped}"]`,
      `.cgxui-pgnw-page-divider[data-page-num="${escaped}"]`,
      `.cgxui-pgnw-page-divider[data-cgxui-chat-page-num="${escaped}"]`,
    ];
    try {
      return Array.from(new Set(selectors.flatMap((sel) => Array.from(document.querySelectorAll(sel)))));
    } catch {
      return [];
    }
  }

  function getDividerStateTokens(state = 'expanded') {
    const collapsed = String(state || '').trim().toLowerCase() === 'collapsed';
    if (collapsed) {
      return {
        dotSizePx: Math.max(0, Number(DIVIDER_VISUAL_KEYS.dotSizeCollapsedPx || 0) || 0),
        dotColor: String(DIVIDER_VISUAL_KEYS.collapsedDotColor || '').trim() || '#b8c0cc',
        dotGlowColor: String(DIVIDER_VISUAL_KEYS.collapsedDotGlowColor || '').trim() || 'rgba(184, 192, 204, 0.30)',
        dotGlowBlurPx: Math.max(0, Number(DIVIDER_VISUAL_KEYS.collapsedDotGlowBlurPx || 0) || 0),
        dotGlowSpreadPx: Number(DIVIDER_VISUAL_KEYS.collapsedDotGlowSpreadPx || 0) || 0,
      };
    }
    return {
      dotSizePx: Math.max(0, Number(DIVIDER_VISUAL_KEYS.dotSizeExpandedPx || 0) || 0),
      dotColor: String(DIVIDER_VISUAL_KEYS.expandedDotColor || '').trim() || '#facc15',
      dotGlowColor: String(DIVIDER_VISUAL_KEYS.expandedDotGlowColor || '').trim() || 'rgba(250, 204, 21, 0.48)',
      dotGlowBlurPx: Math.max(0, Number(DIVIDER_VISUAL_KEYS.expandedDotGlowBlurPx || 0) || 0),
      dotGlowSpreadPx: Number(DIVIDER_VISUAL_KEYS.expandedDotGlowSpreadPx || 0) || 0,
    };
  }

  function getDividerDotEls(divider = null) {
    if (!divider?.querySelectorAll) return [];
    try {
      return Array.from(divider.querySelectorAll('.cgxui-chat-page-divider-dot, .cgxui-pgnw-page-divider-dot'));
    } catch {
      return [];
    }
  }

  // Returns the rect this candidate was measured with when it qualifies as a
  // divider line, otherwise null. Handing the rect back lets one
  // getDividerLineEls invocation classify the candidate from the measurement
  // taken here rather than reading the same element's geometry again. The
  // predicates, thresholds and their order are unchanged, and the cheap checks
  // still run before anything is measured, so a dot or a text-bearing node is
  // still rejected without touching layout. Every caller tests the result for
  // truthiness, and a rect is always truthy.
  function isDividerLineCandidate(el = null, dividerRect = null) {
    if (!(el instanceof HTMLElement)) return null;
    if (!dividerRect) return null;
    const text = String(el.textContent || '').trim();
    if (text) return null;
    if (el.matches?.('.cgxui-chat-page-divider-dot, .cgxui-pgnw-page-divider-dot')) return null;
    const rect = el.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    if (rect.width < 24) return null;
    if (rect.height > 8) return null;
    if (rect.top < dividerRect.top - 24 || rect.bottom > dividerRect.bottom + 24) return null;
    return rect;
  }

  function getDividerLineEls(divider = null) {
    if (!divider?.querySelectorAll) return { left: null, right: null };
    const dividerRect = divider.getBoundingClientRect();
    const centerX = dividerRect.left + (dividerRect.width / 2);
    const preferredSelectors = [
      '.cgxui-chat-page-divider-line',
      '.cgxui-pgnw-page-divider-line',
      '[data-cgxui-chat-page-divider-line]',
      '[data-cgxui-page-divider-line]',
      '[class*="divider-line"]',
      '[class*="page-divider-line"]',
      '[class*="divider-rule"]',
    ];

    const candidates = [];
    const seen = new Set();
    const pushCandidate = (el) => {
      if (!(el instanceof HTMLElement)) return;
      if (seen.has(el)) return;
      const rect = isDividerLineCandidate(el, dividerRect);
      if (!rect) return;
      seen.add(el);
      candidates.push({ el, rect });
    };

    for (const sel of preferredSelectors) {
      let nodes = [];
      try { nodes = Array.from(divider.querySelectorAll(sel)); } catch {}
      for (const el of nodes) pushCandidate(el);
    }

    if (!candidates.length) {
      let fallbackNodes = [];
      try { fallbackNodes = Array.from(divider.querySelectorAll('*')); } catch {}
      for (const el of fallbackNodes) pushCandidate(el);
    }

    // Classify once, from the rect each candidate was already measured with.
    // candidates.map(classify) previously ran twice and classify re-read
    // geometry, so every accepted line was measured three times in one call --
    // once to validate it and twice to classify it -- with no layout-affecting
    // write in between, which made two of those three reads pure repetition.
    // Nothing is retained beyond this invocation: candidates, and every rect in
    // them, are rebuilt from scratch on the next call, so a later pass (the rAF
    // settle in particular) still measures fresh geometry.
    const classified = candidates.map(({ el, rect }) => ({
      el, rect, midX: rect.left + (rect.width / 2), width: rect.width,
    }));

    const leftItems = classified.filter((item) => item.midX <= centerX);
    const rightItems = classified.filter((item) => item.midX >= centerX);
    leftItems.sort((a, b) => b.width - a.width);
    rightItems.sort((a, b) => b.width - a.width);

    return {
      left: leftItems[0]?.el || null,
      right: rightItems[0]?.el || null,
    };
  }

  function getDividerLineBaseWidth(lineEl = null) {
    if (!(lineEl instanceof HTMLElement)) return 0;
    const cached = Number(lineEl.dataset?.cgxuiDividerBaseWidth || 0) || 0;
    if (cached > 0) return cached;
    const width = lineEl.getBoundingClientRect().width || 0;
    if (width > 0) {
      try { lineEl.dataset.cgxuiDividerBaseWidth = String(width); } catch {}
    }
    return width;
  }

  function applyDividerLineScale(lineEl = null, scale = 1, side = 'left') {
    if (!(lineEl instanceof HTMLElement)) return false;
    const nextScale = Math.max(0, Number(scale || 0) || 0);
    const origin = String(side || '').trim().toLowerCase() === 'right' ? 'left center' : 'right center';

    // Important: Core geometry recalculates line widths after divider render,
    // especially during boot/refresh. Width-based overrides lose that race.
    // Using transform keeps the geometry width as the base and extends only the
    // visual line length, so later geometry passes do not wipe out the effect.
    try { lineEl.style.removeProperty('flex'); } catch {}
    try { lineEl.style.removeProperty('width'); } catch {}
    try { lineEl.style.removeProperty('min-width'); } catch {}
    try { lineEl.style.removeProperty('max-width'); } catch {}
    try { lineEl.style.setProperty('transform-origin', origin, 'important'); } catch {}
    try { lineEl.style.setProperty('transform', `scaleX(${nextScale})`, 'important'); } catch {}
    try { lineEl.style.setProperty('will-change', 'transform', 'important'); } catch {}
    try { lineEl.style.setProperty('transition', 'transform 180ms ease', 'important'); } catch {}
    return true;
  }

  function applyDividerVisualsToRoot(divider = null, state = 'expanded', opts = {}) {
    if (!(divider instanceof HTMLElement)) return { ok: false, status: 'divider-missing' };

    const wrapped = !!opts?.wrapped;
    const tokens = getDividerStateTokens(state);
    const effectiveTokens = wrapped && state !== 'collapsed'
      ? {
          ...tokens,
          dotColor: '#9ca3af',
          dotGlowColor: 'rgba(156, 163, 175, 0.20)',
          dotGlowBlurPx: Math.max(4, Number(tokens.dotGlowBlurPx || 0) || 0),
        }
      : tokens;
    try { divider.setAttribute('data-cgxui-page-title-state', state); } catch {}
    if (wrapped) {
      try { divider.setAttribute('data-cgxui-page-wrap', '1'); } catch {}
    } else {
      try { divider.removeAttribute('data-cgxui-page-wrap'); } catch {}
    }
    try { divider.style.setProperty('--cgxui-page-divider-dot-size', `${effectiveTokens.dotSizePx}px`); } catch {}
    try { divider.style.setProperty('--cgxui-page-divider-dot-bg', effectiveTokens.dotColor); } catch {}
    try { divider.style.setProperty('--cgxui-page-divider-dot-glow', effectiveTokens.dotGlowColor); } catch {}
    try { divider.style.setProperty('--cgxui-page-divider-dot-glow-blur', `${effectiveTokens.dotGlowBlurPx}px`); } catch {}
    try { divider.style.setProperty('--cgxui-page-divider-dot-glow-spread', `${effectiveTokens.dotGlowSpreadPx}px`); } catch {}

    const dots = getDividerDotEls(divider);
    for (const dot of dots) {
      try { dot.style.setProperty('width', `${effectiveTokens.dotSizePx}px`, 'important'); } catch {}
      try { dot.style.setProperty('height', `${effectiveTokens.dotSizePx}px`, 'important'); } catch {}
      try { dot.style.setProperty('min-width', `${effectiveTokens.dotSizePx}px`, 'important'); } catch {}
      try { dot.style.setProperty('min-height', `${effectiveTokens.dotSizePx}px`, 'important'); } catch {}
    }

    const pills = Array.from(divider.querySelectorAll('.cgxui-chat-page-divider-pill, .cgxui-pgnw-page-divider-pill, [class*="page-divider-pill"]'));
    for (const pill of pills) {
      if (!(pill instanceof HTMLElement)) continue;
      if (wrapped) {
        try { pill.style.setProperty('background', 'rgba(28, 34, 31, 0.92)', 'important'); } catch {}
        try { pill.style.setProperty('border-style', 'dotted', 'important'); } catch {}
        try { pill.style.setProperty('border-color', 'rgba(148, 163, 156, 0.34)', 'important'); } catch {}
        try { pill.style.setProperty('box-shadow', '0 0 0 1px rgba(12, 16, 15, 0.55), inset 0 0 0 1px rgba(255,255,255,0.02)', 'important'); } catch {}
        try { pill.style.setProperty('opacity', '0.94', 'important'); } catch {}
      } else {
        try { pill.style.removeProperty('background'); } catch {}
        try { pill.style.removeProperty('border-style'); } catch {}
        try { pill.style.removeProperty('border-color'); } catch {}
        try { pill.style.removeProperty('box-shadow'); } catch {}
        try { pill.style.removeProperty('opacity'); } catch {}
      }
    }

    const lines = getDividerLineEls(divider);
    applyDividerLineScale(lines.left, DIVIDER_VISUAL_KEYS.lineLeftScale, 'left');
    applyDividerLineScale(lines.right, DIVIDER_VISUAL_KEYS.lineRightScale, 'right');

    return {
      ok: true,
      status: 'ok',
      state,
      wrapped,
      dots: dots.length,
      hasLeftLine: !!lines.left,
      hasRightLine: !!lines.right,
    };
  }

  function applyDividerVisualsForPage(pageNum = 0, chatId = '') {
    const num = Math.max(1, Number(pageNum || 0) || 0);
    if (!num) return { ok: false, status: 'page-missing', pageNum: num, count: 0 };
    ensureDividerStyle();
    const mode = getDividerUiMode(num, chatId);
    const state = getDividerCircleState(num, chatId);
    const wrapped = false;
    const roots = getDividerRoots(num);
    for (const divider of roots) applyDividerVisualsToRoot(divider, state, { wrapped });
    const collapseControl = syncCollapsedBoundaryControlForPage(num, chatId);
    return {
      ok: true,
      status: 'ok',
      pageNum: num,
      mode,
      state,
      wrapped,
      count: roots.length,
      collapseControl,
    };
  }

  function collectKnownPageNums(chatId = '') {
    const id = String(chatId || resolveChatId()).trim();
    const pageNums = new Set();
    try {
      const payload = getSections(id);
      for (const key of payload?.sections?.keys?.() || []) pageNums.add(Math.max(1, Number(key || 0) || 0));
    } catch {}
    for (const p of readCollapsedPages(id)) pageNums.add(Math.max(1, Number(p || 0) || 0));
    for (const p of readTitleListPages(id)) pageNums.add(Math.max(1, Number(p || 0) || 0));
    try {
      for (const divider of Array.from(document.querySelectorAll('.cgxui-chat-page-divider, .cgxui-pgnw-page-divider'))) {
        const num = getDividerPageNum(divider);
        if (num) pageNums.add(num);
      }
    } catch {}
    return Array.from(pageNums).filter(Boolean).sort((a, b) => a - b);
  }

  function applyDividerVisualsForChat(chatId = '') {
    const id = String(chatId || resolveChatId()).trim();
    const pages = collectKnownPageNums(id);
    for (const pageNum of pages) applyDividerVisualsForPage(pageNum, id);
    return { ok: true, status: 'ok', chatId: id, pages };
  }

  function applyDividerVisualsToDivider(divider = null, opts = {}) {
    if (!(divider instanceof HTMLElement)) return { ok: false, status: 'divider-missing' };
    ensureDividerStyle();
    const id = String(opts?.chatId || resolveChatId()).trim();
    const num = Math.max(1, Number(opts?.pageNum || getDividerPageNum(divider) || 0) || 0);
    // Placement belongs exclusively to MiniMap Core's verified
    // forcePlaceDividerBeforeTurnWrapper() pass. This callback is visual only:
    // renderChatPageDividers runs immediately, in RAF, and from delayed
    // mutation/scroll repairs. Rebuilding stack rows here caused the first
    // correct list to be overwritten by a later divider-repair cadence.
    const mode = getDividerUiMode(num, id);
    const state = String(opts?.state || getDividerCircleState(num, id) || 'expanded').trim() || 'expanded';
    const wrapped = false;
    const result = applyDividerVisualsToRoot(divider, state, { wrapped });
    return {
      ok: !!result?.ok,
      status: result?.status || (result?.ok ? 'ok' : 'failed'),
      chatId: id,
      pageNum: num,
      mode,
      state,
      wrapped,
      hasLeftLine: !!result?.hasLeftLine,
      hasRightLine: !!result?.hasRightLine,
    };
  }

  function scheduleDividerVisualRefresh(chatId = '', delay = 34) {
    clearDividerRefreshTimer();
    ensureDividerStyle();
    const id = String(chatId || resolveChatId()).trim();
    const token = Number(S.dividerVisualRefreshToken || 0);

    S.dividerVisualTimer = setTimeout(() => {
      if (token !== Number(S.dividerVisualRefreshToken || 0)) return;
      S.dividerVisualTimer = null;
      try { applyDividerVisualsForChat(id); } catch {}
    }, Math.max(0, Number(delay || 0) || 0));
    return true;
  }


  function resolveChatId() {
    try {
      const viaPages = MM_CORE_PAGES()?.getChatId?.();
      if (viaPages) return String(viaPages).trim();
    } catch {}
    try {
      const path = String(W.location.pathname || '/');
      const m = path.match(/\/c\/([^/?#]+)/i) || path.match(/\/g\/([^/?#]+)/i);
      if (m && m[1]) return decodeURIComponent(m[1]);
      return path || '/';
    } catch {
      return '';
    }
  }

  function safeChatKeyPart(chatId = '') {
    return String(chatId || '').trim().replace(/[^a-z0-9_-]/gi, '_');
  }

  function nsDisk() {
    try { return String(MM_SH()?.NS_DISK || 'h2o:prm:cgx:mnmp').trim(); } catch { return 'h2o:prm:cgx:mnmp'; }
  }

  function keyCollapsedPages(chatId = '') {
    const safeId = safeChatKeyPart(chatId || resolveChatId());
    return safeId ? `${nsDisk()}:ui:chat-pages:collapsed:${safeId}:v1` : '';
  }

  // ── Ordered Chat -> MiniMap propagation (MECHANISMS_RULES sec.9A) ─────────
  // Chat owns a monotonic per-page revision. A Chat *intent action* advances it
  // even when the action re-asserts the boolean Chat already holds — the user
  // re-collapsing a page is newer intent than an older MiniMap-local expansion.
  // Refresh, restoration and read-only reconciliation do NOT advance it; they
  // read the current revision so an unchanged revision cannot overwrite a newer
  // MiniMap-local choice. Chat never reads MiniMap's applied revision.
  function keyChatPageRevs(chatId = '') {
    const safeId = safeChatKeyPart(chatId || resolveChatId());
    return safeId ? `${nsDisk()}:ui:chat-pages:rev:${safeId}:v1` : '';
  }

  function readChatPageRevs(chatId = '') {
    const id = String(chatId || resolveChatId()).trim();
    if (!id) return {};
    const cached = S.chatPageRevsByChat.get(id);
    if (cached && typeof cached === 'object') return cached;
    let raw = null;
    try { raw = storageGetJSON(keyChatPageRevs(id), null); } catch { raw = null; }
    const out = {};
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      for (const [k, v] of Object.entries(raw)) {
        const num = Math.max(0, Number(k || 0) || 0);
        if (!num || !v || typeof v !== 'object') continue;
        out[String(num)] = { r: Math.max(0, Number(v.r || 0) || 0), s: !!v.s };
      }
    }
    S.chatPageRevsByChat.set(id, out);
    return out;
  }

  function writeChatPageRevs(chatId = '', revs = {}) {
    const id = String(chatId || resolveChatId()).trim();
    if (!id) return false;
    S.chatPageRevsByChat.set(id, revs);
    try { return !!storageSetJSON(keyChatPageRevs(id), revs); } catch { return false; }
  }

  // The ordering event is a Chat *action*, not a Chat value change. A user who
  // re-collapses a page in Chat must outrank a MiniMap-local expansion even
  // though Chat's own boolean never moved. The only calls that must NOT advance
  // are reconciliation re-asserts, which merely replay state Chat already holds.
  // 1C1b has exactly three such sources, all literal and all listed here.
  const CHAT_REV_REASSERT_SOURCES = new Set([
    'chat-pages-controller:refresh',
    'chat-pages-controller:title-set',
    'reset-all-mechanisms',
  ]);

  function isChatRevReassertSource(source = '') {
    return CHAT_REV_REASSERT_SOURCES.has(String(source || '').trim());
  }

  // Current revision for (chatId, pageNum). Called from the single visuals
  // path, so the atomic-transaction and the engine/pagination writers are both
  // covered without a second collapse implementation. Revision 0 means "Chat
  // has never acted on this page"; a re-assert reads without advancing.
  function chatPageRevFor(pageNum = 0, chatId = '', opts = {}) {
    const id = String(chatId || resolveChatId()).trim();
    const num = Math.max(1, Number(pageNum || 0) || 0);
    if (!id || !num) return 0;
    const revs = readChatPageRevs(id);
    const key = String(num);
    const prev = revs[key] || { r: 0, s: false };
    if (isChatRevReassertSource(opts?.source)) return Math.max(0, Number(prev.r || 0) || 0);
    let current = false;
    try { current = !!isPageCollapsed(num, id); } catch { current = false; }
    revs[key] = { r: Math.max(0, Number(prev.r || 0) || 0) + 1, s: current };
    writeChatPageRevs(id, revs);
    return revs[key].r;
  }

  // Revision history is deliberately NOT pruned by refresh-time page discovery.
  // collectKnownPageNums returns a PARTIAL union during bind, route restoration
  // and fresh load — the pagination ledger is empty and no dividers exist yet —
  // so an expanded page with real history would be dropped while MiniMap keeps
  // its appliedRev, and the next genuine Chat action would arrive with a lower
  // revision and be rejected as stale. Growth is bounded by pages-ever-seen per
  // chat, the same bound the MiniMap :v2 record already accepts.

  function keyTitleListPages(chatId = '') {
    const safeId = safeChatKeyPart(chatId || resolveChatId());
    return safeId ? `${nsDisk()}:ui:chat-pages:title-list:${safeId}:v1` : '';
  }

  function keyTitleIntentLedger(chatId = '') {
    const safeId = safeChatKeyPart(chatId || resolveChatId());
    return safeId ? `${nsDisk()}:ui:chat-pages:title-intent:${safeId}:v2` : '';
  }

  function storageGetRaw(key) {
    const k = String(key || '').trim();
    if (!k) return null;
    try {
      return W.localStorage?.getItem(k) ?? null;
    } catch {
      return null;
    }
  }

  function storageGetJSON(key, fallback = null) {
    const k = String(key || '').trim();
    if (!k) return fallback;
    try {
      const raw = W.localStorage?.getItem(k);
      return raw == null ? fallback : (JSON.parse(raw) ?? fallback);
    } catch {
      return fallback;
    }
  }

  function storageSetJSON(key, value) {
    const k = String(key || '').trim();
    if (!k) return false;
    try {
      W.localStorage?.setItem(k, JSON.stringify(value));
      return true;
    } catch {
      return false;
    }
  }

  function storageRemove(key) {
    const k = String(key || '').trim();
    if (!k) return false;
    try {
      W.localStorage?.removeItem(k);
      return true;
    } catch {
      return false;
    }
  }

  function normalizePageNums(raw) {
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

  function normalizeAnswerIds(raw) {
    const src = Array.isArray(raw) ? raw : [];
    const seen = new Set();
    const out = [];
    for (const item of src) {
      const id = String(item || '').trim();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      out.push(id);
    }
    out.sort();
    return out;
  }

  function normalizeTitleIntentState(state = '') {
    const s = String(state || '').trim().toLowerCase();
    return s === 'collapsed' ? 'collapsed' : 'expanded';
  }

  function samePageNums(a = [], b = []) {
    const left = normalizePageNums(a);
    const right = normalizePageNums(b);
    if (left.length !== right.length) return false;
    for (let i = 0; i < left.length; i += 1) {
      if (left[i] !== right[i]) return false;
    }
    return true;
  }

  function localReadCollapsedPagesSet(chatId = '') {
    const id = String(chatId || resolveChatId()).trim();
    if (!id) return new Set();
    const cached = S.collapsedPagesByChat.get(id);
    if (cached instanceof Set) return new Set(cached);
    // Stage 2C-2 does not restore legacy collapsed state after reload.
    const set = new Set();
    S.collapsedPagesByChat.set(id, set);
    return new Set(set);
  }

  function localWriteCollapsedPagesSet(chatId = '', pages = []) {
    const id = String(chatId || resolveChatId()).trim();
    if (!id) return new Set();
    const next = new Set(normalizePageNums(Array.isArray(pages) ? pages : Array.from(pages || [])));
    S.collapsedPagesByChat.set(id, next);
    storageSetJSON(keyCollapsedPages(id), Array.from(next));
    return new Set(next);
  }

  function localReadTitleListPagesSet(chatId = '') {
    const id = String(chatId || resolveChatId()).trim();
    if (!id) return new Set();
    const cached = S.titleListPagesByChat.get(id);
    if (cached instanceof Set) return new Set(cached);
    // Stage 2C-2 is explicit-session-only. Legacy persisted values remain
    // physically untouched but have zero activation authority after reload.
    const set = new Set();
    S.titleListPagesByChat.set(id, set);
    return new Set(set);
  }

  function localWriteTitleListPagesSet(chatId = '', pages = []) {
    const id = String(chatId || resolveChatId()).trim();
    if (!id) return new Set();
    const next = new Set(normalizePageNums(Array.isArray(pages) ? pages : Array.from(pages || [])));
    S.titleListPagesByChat.set(id, next);
    storageSetJSON(keyTitleListPages(id), Array.from(next));
    return new Set(next);
  }

  function localForgetTitleListPage(chatId = '', pageNum = 0) {
    const id = String(chatId || resolveChatId()).trim();
    const num = Math.max(1, Number(pageNum || 0) || 0);
    if (!id || !num) return false;
    const next = localReadTitleListPagesSet(id);
    const changed = next.delete(num);
    S.titleListPagesByChat.set(id, next);
    return changed;
  }

  function getDividerPageNum(divider = null) {
    return Math.max(1, Number(
      divider?.getAttribute?.('data-page-num') ||
      divider?.getAttribute?.('data-cgxui-chat-page-num') ||
      0
    ) || 0);
  }

  // ── Canonical Q+A pair contract ────────────────────────────────────────────
  // • A complete conversation unit is the Q+A pair: user prompt section plus the
  //   following assistant answer section. Page rows treat the pair as atomic.
  // • The assistant answer owns the single visible title bar for the pair.
  // • NO ANSWER shells are only for true orphan questions (no following answer).
  // • Page dividers anchor before the pair start (question wrapper), never
  //   between a question and its answer.
  // • Title collapse hides question + answer body; the bar stays as the handle.
  // ChatGPT wraps each turn <section data-testid="conversation-turn-N"
  // data-turn="user|assistant"> in its own only-child wrapper DIV, so sibling
  // walks between turn hosts dead-end. Pairing therefore uses document-order
  // adjacency over the live turn-section list, guarded to the same
  // conversation flow, with a short-lived cache for mass operations.
  const TURN_LIST_CACHE_TTL_MS = 300;
  let _turnSectionListCache = { at: 0, list: [] };

  function listTurnSections() {
    const now = Date.now();
    if (now - _turnSectionListCache.at <= TURN_LIST_CACHE_TTL_MS && _turnSectionListCache.list.length) {
      return _turnSectionListCache.list;
    }
    let list = [];
    try { list = Array.from(document.querySelectorAll(TURN_HOST_SEL)); } catch {}
    _turnSectionListCache = { at: now, list };
    return list;
  }

  function getTurnSectionForNode(node = null) {
    const el = node instanceof Element ? node : null;
    if (!el) return null;
    const direct = el.closest?.(TURN_HOST_SEL) || null;
    if (direct) return direct;
    // Wrapper div around a single turn section (2026 ChatGPT DOM shape).
    try {
      const inner = el.querySelectorAll?.(TURN_HOST_SEL) || [];
      if (inner.length === 1) return inner[0];
    } catch {}
    return null;
  }

  function sameConversationFlow(a = null, b = null) {
    if (!a || !b) return false;
    const flowOf = (el) => el.closest?.('main') || el.ownerDocument?.body || null;
    const fa = flowOf(a);
    return !!fa && fa === flowOf(b);
  }

  function getAdjacentTurnHost(host = null, dir = 1) {
    const section = getTurnSectionForNode(host);
    if (!section) return null;
    const list = listTurnSections();
    const idx = list.indexOf(section);
    if (idx < 0) return null;
    const next = list[idx + (dir < 0 ? -1 : 1)] || null;
    if (!next || !sameConversationFlow(section, next)) return null;
    return next;
  }

  function getTurnHostRole(host = null) {
    if (!host || host.nodeType !== 1) return '';
    const section = getTurnSectionForNode(host) || host;
    const turnAttr = String(section.getAttribute?.('data-turn') || '').trim().toLowerCase();
    if (turnAttr === 'user' || turnAttr === 'assistant') return turnAttr;
    const role = String(section.getAttribute?.('data-message-author-role') || '').trim().toLowerCase();
    if (role === 'user' || role === 'assistant') return role;
    try { if (section.querySelector?.(ASSISTANT_MSG_SEL)) return 'assistant'; } catch {}
    try { if (section.querySelector?.(USER_MSG_SEL)) return 'user'; } catch {}
    return '';
  }

  function getTurnHostForNode(node = null) {
    const el = node instanceof Element ? node : null;
    return getTurnSectionForNode(el) || el || null;
  }

  function getPreviousTurnHost(host = null) {
    const prev = getAdjacentTurnHost(host, -1);
    return prev && getTurnHostRole(prev) ? prev : null;
  }

  function getNextTurnHost(host = null) {
    const next = getAdjacentTurnHost(host, 1);
    return next && getTurnHostRole(next) ? next : null;
  }

  // The divider must sit between Q+A pairs, not inside a turn's only-child
  // wrapper chain. Climb from the pair-start section through wrappers whose
  // sole element child is the turn, and return the outermost such wrapper.
  function getTurnAnchorNode(host = null) {
    const section = getTurnSectionForNode(host) || (host instanceof Element ? host : null);
    if (!section) return null;
    let cur = section;
    while (cur.parentElement && cur.parentElement !== document.body) {
      const parent = cur.parentElement;
      // H2O title projections are never part of a native turn anchor.
      if (parent.matches?.('[data-cgxui="chat-page-title-list-synth"], [data-h2o-title-list-segment="suffix"]')) break;
      if (parent.children.length !== 1) break;
      // Never climb past the conversation flow container.
      if (parent.matches?.('main')) break;
      cur = parent;
    }
    return cur;
  }

  function getQuestionHostForAnswerHost(answerHost = null, answerMsgEl = null, opts = {}) {
    const host = getTurnHostForNode(answerHost || answerMsgEl);
    if (!host) return null;
    if (opts?.turnHostOnly !== true) {
      try {
        const sameTurnQuestion = host.querySelector?.(USER_MSG_SEL) || null;
        if (sameTurnQuestion && answerMsgEl && !sameTurnQuestion.contains?.(answerMsgEl)) return sameTurnQuestion;
      } catch {}
    }
    const prev = getPreviousTurnHost(host);
    return getTurnHostRole(prev) === 'user' ? prev : null;
  }

  function getPairedAssistantHostForQuestion(questionHost = null) {
    const host = getTurnHostForNode(questionHost);
    if (!host) return null;
    try {
      if (host.querySelector?.(ASSISTANT_MSG_SEL)) return host;
    } catch {}
    const next = getNextTurnHost(host);
    return getTurnHostRole(next) === 'assistant' ? next : null;
  }

  function removeNoAnswerTitleBar(host = null) {
    if (!host?.querySelectorAll) return 0;
    let removed = 0;
    try {
      for (const bar of Array.from(host.querySelectorAll(NO_ANSWER_TITLE_BAR_SEL))) {
        try { bar.remove(); removed += 1; } catch {}
      }
      host.removeAttribute?.('data-cgxui-chat-page-no-answer');
      host.removeAttribute?.(ATTR_CHAT_PAGE_NO_ANSWER_QUESTION_HIDDEN);
    } catch {}
    return removed;
  }

  function normalizeFullTurnRows(rows = []) {
    const out = [];
    const seenAnswerIds = new Set();
    for (const raw of Array.isArray(rows) ? rows : []) {
      if (!raw) continue;
      if (raw.noAnswer) {
        const questionHost = raw.questionHost || raw.answerHost || null;
        if (getPairedAssistantHostForQuestion(questionHost)) {
          removeNoAnswerTitleBar(questionHost);
          continue;
        }
        out.push(raw);
        continue;
      }
      const answerId = String(raw.answerId || '').trim();
      if (answerId) {
        if (seenAnswerIds.has(answerId)) continue;
        seenAnswerIds.add(answerId);
      }
      const questionHost = raw.questionHost || getQuestionHostForAnswerHost(raw.answerHost, raw.answerMsgEl) || null;
      if (questionHost) removeNoAnswerTitleBar(questionHost);
      out.push(questionHost === raw.questionHost ? raw : Object.assign({}, raw, { questionHost }));
    }
    return out;
  }

  function normalizeFullTurnSections(payload = null) {
    const sections = payload?.sections instanceof Map ? payload.sections : new Map();
    if (!sections.size) return payload || { sections: new Map(), allHosts: [] };

    const assistantPageByQuestion = new Map();
    for (const section of sections.values()) {
      const pageNum = Math.max(1, Number(section?.pageNum || 0) || 0);
      for (const host of Array.isArray(section?.hosts) ? section.hosts : []) {
        if (getTurnHostRole(host) !== 'assistant') continue;
        const qHost = getQuestionHostForAnswerHost(host, host?.querySelector?.(ASSISTANT_MSG_SEL) || null, { turnHostOnly: true });
        if (qHost) assistantPageByQuestion.set(qHost, pageNum);
      }
    }

    const nextSections = new Map();
    const allHosts = [];
    const allSeen = new Set();
    for (const [key, section] of sections) {
      const pageNum = Math.max(1, Number(section?.pageNum || key || 0) || 0);
      const hostSeen = new Set();
      const hosts = [];
      const addHost = (host) => {
        if (!host || hostSeen.has(host)) return;
        hostSeen.add(host);
        hosts.push(host);
        if (!allSeen.has(host)) {
          allSeen.add(host);
          allHosts.push(host);
        }
      };

      for (const host of Array.isArray(section?.hosts) ? section.hosts : []) {
        const role = getTurnHostRole(host);
        if (role === 'user') {
          const answerPage = assistantPageByQuestion.get(host) || 0;
          if (answerPage && answerPage !== pageNum) {
            removeNoAnswerTitleBar(host);
            continue;
          }
          addHost(host);
          continue;
        }
        if (role === 'assistant') {
          const qHost = getQuestionHostForAnswerHost(host, host?.querySelector?.(ASSISTANT_MSG_SEL) || null, { turnHostOnly: true });
          if (qHost) {
            removeNoAnswerTitleBar(qHost);
            addHost(qHost);
          }
          addHost(host);
          continue;
        }
        addHost(host);
      }

      // Keep hosts in document order so hosts[0] is the true pair start even
      // when the raw builder appended question hosts after assistant hosts.
      hosts.sort((a, b) => {
        if (a === b) return 0;
        try {
          return (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) ? -1 : 1;
        } catch { return 0; }
      });
      nextSections.set(pageNum || key, Object.assign({}, section, { pageNum: pageNum || section?.pageNum, hosts, hostSet: new Set(hosts) }));
    }

    return { sections: nextSections, allHosts };
  }

  function getRows(pageNum = 0, chatId = '') {
    try { return normalizeFullTurnRows(MM_CORE_PAGES()?.getRows?.(pageNum, chatId) || []); } catch { return []; }
  }

  function getPageAnswerIds(pageNum = 0, chatId = '') {
    return Array.from(new Set(
      getRows(pageNum, chatId)
        .filter((row) => !row?.noAnswer)
        .map((row) => String(row?.answerId || '').trim())
        .filter(Boolean)
    ));
  }

  // Rows only cover pairs whose content and title bar are currently hydrated.
  // Mass page actions must use authoritative membership — the canonical turn
  // list slice for the page — or freshly hydrating rows escape the action.
  // Ids that cannot be applied yet are collapsed on hydration by the
  // onTitleSet re-apply path.
  function getAuthoritativePageAnswerIds(pageNum = 0, chatId = '') {
    const num = Math.max(1, Number(pageNum || 0) || 0);
    return Array.from(new Set(
      purePresentationPageMemberDetails(num)
        .filter((member) => member?.type === 'answer')
        .map((member) => String(member?.answerId || '').trim())
        .filter(Boolean)
    ));
  }

  function createEmptyTitleIntentLedger() {
    return { rev: 0, pages: {}, overrides: {} };
  }

  function normalizeTitleIntentLedger(raw = null) {
    // Already-normalized ledgers (cache hits) pass through untouched: the
    // defensive normalize calls in every helper must not deep-copy on hot
    // paths. The marker is non-enumerable so JSON.stringify never persists it.
    if (raw && raw.__h2oTitleIntentNormalized === true) return raw;
    const out = createEmptyTitleIntentLedger();
    try {
      Object.defineProperty(out, '__h2oTitleIntentNormalized', { value: true, enumerable: false });
    } catch {}
    if (raw && typeof raw === 'object') {
      out.rev = Math.max(0, Number(raw.rev || 0) || 0);
      const pages = (raw.pages && typeof raw.pages === 'object') ? raw.pages : {};
      for (const [pageKey, entry] of Object.entries(pages)) {
        const pageNum = Math.max(1, Number(pageKey || entry?.page || 0) || 0);
        if (!pageNum || !entry || typeof entry !== 'object') continue;
        const rev = Math.max(0, Number(entry.rev || 0) || 0);
        out.pages[String(pageNum)] = {
          state: normalizeTitleIntentState(entry.state),
          rev,
          at: Math.max(0, Number(entry.at || 0) || 0),
          source: String(entry.source || 'unknown').trim() || 'unknown',
        };
        out.rev = Math.max(out.rev, rev);
      }
      const overrides = (raw.overrides && typeof raw.overrides === 'object') ? raw.overrides : {};
      for (const [rawAnswerId, entry] of Object.entries(overrides)) {
        const answerId = String(rawAnswerId || '').trim();
        if (!answerId || !entry || typeof entry !== 'object') continue;
        const rev = Math.max(0, Number(entry.rev || 0) || 0);
        out.overrides[answerId] = {
          state: normalizeTitleIntentState(entry.state),
          rev,
          page: Math.max(0, Number(entry.page || 0) || 0) || null,
          at: Math.max(0, Number(entry.at || 0) || 0),
          source: String(entry.source || 'manual').trim() || 'manual',
        };
        out.rev = Math.max(out.rev, rev);
      }
    }
    return out;
  }

  function countActiveTitleIntentPages(ledger = null) {
    const src = normalizeTitleIntentLedger(ledger);
    return Object.values(src.pages || {}).filter((entry) => Number(entry?.rev || 0) > 0).length;
  }

  function countActiveTitleIntentOverrides(ledger = null) {
    const src = normalizeTitleIntentLedger(ledger);
    return Object.values(src.overrides || {}).filter((entry) => Number(entry?.rev || 0) > 0).length;
  }

  function isTitleIntentLedgerInert(ledger = null) {
    const src = normalizeTitleIntentLedger(ledger);
    return countActiveTitleIntentPages(src) <= 0 && countActiveTitleIntentOverrides(src) <= 0;
  }

  function getTitleIntentStats() {
    return Object.assign({}, S.titleIntentStats || {});
  }

  function incTitleIntentStat(name = '', amount = 1) {
    const key = String(name || '').trim();
    if (!key) return;
    S.titleIntentStats[key] = Math.max(0, Number(S.titleIntentStats[key] || 0) || 0) + amount;
  }

  function cacheTitleIntentLedger(chatId = '', ledger = null) {
    const normalized = normalizeTitleIntentLedger(ledger);
    S.titleIntentLedgerCache = {
      chatId: String(chatId || '').trim(),
      ledger: normalized,
      inert: countActiveTitleIntentPages(normalized) <= 0 && countActiveTitleIntentOverrides(normalized) <= 0,
    };
    return normalized;
  }

  function readTitleIntentLedger(chatId = '') {
    const id = String(chatId || resolveChatId()).trim();
    const cache = S.titleIntentLedgerCache;
    if (cache && cache.chatId === id && cache.ledger) return cache.ledger;
    const key = keyTitleIntentLedger(id);
    incTitleIntentStat('localStorageReads');
    return cacheTitleIntentLedger(id, storageGetJSON(key, null));
  }

  function writeTitleIntentLedger(chatId = '', ledger = null) {
    const id = String(chatId || resolveChatId()).trim();
    const key = keyTitleIntentLedger(id);
    // The cache may hand back the same object callers then mutate; re-derive
    // the inert flag on every write-through so the O(1) gate stays truthful.
    const next = cacheTitleIntentLedger(id, ledger);
    incTitleIntentStat('localStorageWrites');
    if (key) storageSetJSON(key, next);
    return next;
  }

  // ── Central safety gate ─────────────────────────────────────────────────
  // THE single question every title-intent path asks first. O(1), no storage
  // IO, no allocation after the first per-chat read. While this returns
  // false the entire title-intent system is inert: no membership scans, no
  // resolver-driven DOM work, no replay scheduling, no projection stamping.
  // Only the two explicit user gestures (page circle click, manual title
  // toggle on a page that already has an intent) can flip it to true.
  function isTitleIntentEngineActive(chatId = '') {
    const id = String(chatId || resolveChatId()).trim();
    const cache = S.titleIntentLedgerCache;
    if (cache && cache.chatId === id && cache.ledger) return !cache.inert;
    readTitleIntentLedger(id);
    return !(S.titleIntentLedgerCache?.inert !== false);
  }

  function bumpTitleIntentRev(ledger = null) {
    const next = normalizeTitleIntentLedger(ledger);
    next.rev = Math.max(0, Number(next.rev || 0) || 0) + 1;
    return next.rev;
  }

  function titleIntentPageHasActiveState(pageNum = 0, ledger = null) {
    const num = Math.max(1, Number(pageNum || 0) || 0);
    if (!num) return false;
    const src = normalizeTitleIntentLedger(ledger);
    if (Number(src.pages?.[String(num)]?.rev || 0) > 0) return true;
    return Object.values(src.overrides || {}).some((entry) => Number(entry?.rev || 0) > 0
      && Math.max(1, Number(entry?.page || 0) || 0) === num);
  }

  function getTitleIntentPageForAnswerFromLedger(answerId = '', ledger = null) {
    const id = String(answerId || '').trim();
    if (!id) return null;
    const src = normalizeTitleIntentLedger(ledger);
    const overridePage = Math.max(0, Number(src.overrides?.[id]?.page || 0) || 0) || null;
    if (overridePage) return overridePage;
    return null;
  }

  function titleIntentDesiredIsActive(desired = null) {
    return !!desired && Number(desired.rev || 0) > 0
      && (desired.source === 'page-intent' || desired.source === 'manual');
  }

  function getHydratedTitleActualState(msgEl = null, bar = null) {
    if (!msgEl || !bar) return null;
    const msgCollapsed = msgEl?.getAttribute?.('data-at-collapsed') === '1';
    const barCollapsed = String(bar?.getAttribute?.('data-cgxui-state') || '').split(/\s+/).includes('collapsed');
    return (msgCollapsed || barCollapsed) ? 'collapsed' : 'expanded';
  }

  function titleIntentProjectionMatches(bar = null, desired = null) {
    if (!bar || !desired) return false;
    return String(bar.getAttribute?.('data-h2o-title-desired') || '') === String(desired.state || '')
      && String(bar.getAttribute?.('data-h2o-title-state-source') || '') === String(desired.source || '')
      && Number(bar.getAttribute?.('data-h2o-title-rev') || 0) === Math.max(0, Number(desired.rev || 0) || 0);
  }

  function beginTitleIntentReplay(opts = {}) {
    if (opts?.withinTitleIntentReplay === true) return true;
    if (S.titleIntentReplayInFlight) {
      incTitleIntentStat('replayReentrantSkips');
      return false;
    }
    S.titleIntentReplayInFlight = true;
    incTitleIntentStat('replayRuns');
    return true;
  }

  function endTitleIntentReplay(opts = {}) {
    if (opts?.withinTitleIntentReplay === true) return;
    S.titleIntentReplayInFlight = false;
  }

  function scheduleTrailingTitleIntentReplay(request = {}) {
    if (S.titleIntentTrailingTimer) return false;
    S.titleIntentTrailingTimer = W.setTimeout(() => {
      S.titleIntentTrailingTimer = null;
      const chatId = String(request?.chatId || resolveChatId()).trim();
      const ledger = readTitleIntentLedger(chatId);
      if (isTitleIntentLedgerInert(ledger)) {
        incTitleIntentStat('replaySkippedInert');
        return;
      }
      const answerId = String(request?.answerId || '').trim();
      const pageNum = Math.max(1, Number(request?.pageNum || request?.page || 0) || 0);
      try {
        if (answerId) applyTitleIntentToAnswer(answerId, { chatId, page: pageNum, animate: false, source: 'title-intent:trailing' });
        else if (pageNum) applyTitleIntentToPage(pageNum, { chatId, animate: false, source: 'title-intent:trailing' });
      } catch {}
    }, 0);
    return true;
  }

  // Page lookup for the resolver MUST be cheap and side-effect free: the
  // in-memory canonical turn list only. It must never call findRowByAnswerId
  // or getAuthoritativePageAnswerIds — those route through the Core row
  // builder, which is O(page) per call and CREATES no-answer title bars as a
  // side effect. Doing that per resolver call (isCollapsed / mutation
  // reconcile / title-set) is what froze chat open: thousands of mutations ×
  // all known pages × row builds, each build emitting new DOM mutations that
  // re-fed the observer. If the turn list cannot answer, return null and let
  // the caller treat the state as default — never scan to find out.
  function findPageForAnswerId(answerId = '') {
    const id = String(answerId || '').trim();
    if (!id) return null;
    try {
      const list = MM_CORE_API()?.getTurnList?.() || [];
      if (Array.isArray(list)) {
        const idx = list.findIndex((turn) => String(turn?.answerId || turn?.primaryAId || '').trim() === id);
        if (idx >= 0) return Math.max(1, Math.ceil((idx + 1) / 25));
      }
    } catch {}
    return null;
  }

  function resolveDesiredTitleState(answerId = '', opts = {}) {
    incTitleIntentStat('resolverCalls');
    const id = String(answerId || '').trim();
    const chatId = String(opts?.chatId || resolveChatId()).trim();
    const ledger = opts?.ledger ? normalizeTitleIntentLedger(opts.ledger) : readTitleIntentLedger(chatId);
    const explicitPage = Math.max(0, Number(opts?.page || opts?.pageNum || 0) || 0) || null;
    if (isTitleIntentLedgerInert(ledger)) {
      incTitleIntentStat('resolverDefaultReturns');
      return { state: 'expanded', source: 'default', rev: 0, page: explicitPage };
    }
    const page = explicitPage
      || getTitleIntentPageForAnswerFromLedger(id, ledger)
      || findPageForAnswerId(id)
      || null;
    const pageIntent = page ? ledger.pages[String(page)] || null : null;
    const override = id ? ledger.overrides[id] || null : null;
    const pageRev = Math.max(0, Number(pageIntent?.rev || 0) || 0);
    const overrideRev = Math.max(0, Number(override?.rev || 0) || 0);
    if (override && overrideRev > pageRev) {
      return { state: normalizeTitleIntentState(override.state), source: 'manual', rev: overrideRev, page };
    }
    if (pageIntent) {
      return { state: normalizeTitleIntentState(pageIntent.state), source: 'page-intent', rev: pageRev, page };
    }
    incTitleIntentStat('resolverDefaultReturns');
    return { state: 'expanded', source: 'default', rev: 0, page };
  }

  function writePageTitleIntent(pageNum = 0, state = 'expanded', opts = {}) {
    const id = String(opts?.chatId || resolveChatId()).trim();
    const num = Math.max(1, Number(pageNum || 0) || 0);
    if (!id || !num) return { ok: false, status: 'invalid-page-intent', chatId: id, pageNum: num };
    const ledger = readTitleIntentLedger(id);
    const rev = bumpTitleIntentRev(ledger);
    const nextState = normalizeTitleIntentState(state);
    if (!Array.isArray(opts?.answerIds)) incTitleIntentStat('membershipScans');
    const members = normalizeAnswerIds(opts?.answerIds || getAuthoritativePageAnswerIds(num, id));
    ledger.pages[String(num)] = {
      state: nextState,
      rev,
      at: Date.now(),
      source: String(opts?.source || 'chat-page-divider:circle').trim() || 'chat-page-divider:circle',
    };
    for (const answerId of members) {
      const override = ledger.overrides[answerId] || null;
      if (!override || Number(override.rev || 0) <= rev) delete ledger.overrides[answerId];
    }
    writeTitleIntentLedger(id, ledger);
    return { ok: true, status: 'ok', chatId: id, pageNum: num, state: nextState, rev, members };
  }

  function recordManualTitleOverride(answerId = '', state = 'expanded', opts = {}) {
    const answer = String(answerId || '').trim();
    const id = String(opts?.chatId || resolveChatId()).trim();
    if (!answer || !id) return { ok: false, status: 'invalid-manual-title-intent', answerId: answer, chatId: id };
    const ledger = readTitleIntentLedger(id);
    // Overrides exist to protect a manual choice from a PAGE intent. With no
    // active intent anywhere, the legacy/engine manual systems already own the
    // state — recording an override here would flip the ledger non-inert
    // forever and re-arm the whole replay machinery on every future chat
    // open. Manual toggles must never bootstrap the engine.
    if (isTitleIntentLedgerInert(ledger)) {
      incTitleIntentStat('replaySkippedInert');
      return { ok: true, status: 'skipped-inert', answerId: answer, chatId: id };
    }
    const rev = bumpTitleIntentRev(ledger);
    const page = Math.max(0, Number(opts?.page || opts?.pageNum || findPageForAnswerId(answer) || 0) || 0) || null;
    ledger.overrides[answer] = {
      state: normalizeTitleIntentState(state),
      rev,
      page,
      at: Date.now(),
      source: String(opts?.source || 'answer-title').trim() || 'answer-title',
    };
    writeTitleIntentLedger(id, ledger);
    return { ok: true, status: 'ok', chatId: id, answerId: answer, state: ledger.overrides[answer].state, rev, page };
  }

  function stampTitleIntentProjection(answerId = '', desired = null, bar = null, shell = null) {
    const id = String(answerId || '').trim();
    const d = desired || resolveDesiredTitleState(id);
    try {
      // No-op guard: identical projection attrs must not touch the DOM at
      // all — attribute churn is observable by other modules' observers.
      if (bar && titleIntentProjectionMatches(bar, d)
        && String(bar.getAttribute?.('data-h2o-title-answer-id') || '') === id
        && (!shell || String(shell.getAttribute?.('data-h2o-title-pending-rev') || '0') === String(Math.max(0, Number(d.rev || 0) || 0)))) {
        return d;
      }
      incTitleIntentStat('domMutationsFromTitleIntent');
      if (bar) {
        bar.setAttribute('data-h2o-title-answer-id', id);
        if (d.page != null) bar.setAttribute('data-h2o-title-page', String(d.page));
        else bar.removeAttribute('data-h2o-title-page');
        bar.setAttribute('data-h2o-title-desired', d.state);
        bar.setAttribute('data-h2o-title-state-source', d.source);
        bar.setAttribute('data-h2o-title-rev', String(Math.max(0, Number(d.rev || 0) || 0)));
        bar.setAttribute('data-h2o-title-hydrated', '1');
      }
      if (shell && d.rev > 0) {
        shell.setAttribute('data-h2o-title-pending-state', d.state);
        shell.setAttribute('data-h2o-title-pending-rev', String(Math.max(0, Number(d.rev || 0) || 0)));
        if (d.page != null) shell.setAttribute('data-h2o-title-page', String(d.page));
      }
    } catch {}
    return d;
  }

  function applyTitleIntentToAnswer(answerId = '', opts = {}) {
    const id = String(answerId || '').trim();
    if (!id) return { ok: false, status: 'invalid-answer-id', answerId: id };
    const chatId = String(opts?.chatId || resolveChatId()).trim();
    const ledger = opts?.ledger ? normalizeTitleIntentLedger(opts.ledger) : readTitleIntentLedger(chatId);
    if (isTitleIntentLedgerInert(ledger)) {
      incTitleIntentStat('replaySkippedInert');
      return { ok: true, status: 'skipped-inert', answerId: id, hydrated: false };
    }
    if (!beginTitleIntentReplay(opts)) {
      scheduleTrailingTitleIntentReplay({ chatId, answerId: id, pageNum: opts?.page || opts?.pageNum });
      return { ok: true, status: 'reentrant-scheduled', answerId: id, hydrated: false };
    }
    try {
      incTitleIntentStat('targetedApplies');
      const desired = resolveDesiredTitleState(id, { chatId, page: opts?.page || opts?.pageNum, ledger });
      if (!titleIntentDesiredIsActive(desired)) {
        incTitleIntentStat('replayNoops');
        return { ok: true, status: 'default-noop', answerId: id, desired, hydrated: false };
      }
      const at = AT_PUBLIC();
      const msgEl = at?.getMessageEl?.(id) || null;
      const bar = at?.getBar?.(id) || null;
      const shell = msgEl?.closest?.('[data-testid="conversation-turn"], [data-testid^="conversation-turn-"]') || msgEl?.parentElement || null;
      if (!msgEl || !bar) {
        stampTitleIntentProjection(id, desired, bar, shell);
        return { ok: true, status: 'deferred-unhydrated', answerId: id, desired, hydrated: false };
      }
      const actualState = getHydratedTitleActualState(msgEl, bar);
      const applyKey = `${id}:${desired.state}:${desired.source}:${Math.max(0, Number(desired.rev || 0) || 0)}`;
      if (actualState === desired.state
        && titleIntentProjectionMatches(bar, desired)
        && S.titleIntentLastAppliedByAnswer.get(id) === applyKey) {
        incTitleIntentStat('replayNoops');
        return { ok: true, status: 'noop-current', answerId: id, desired, hydrated: true };
      }
      stampTitleIntentProjection(id, desired, bar, shell);
      if (actualState === desired.state) {
        S.titleIntentLastAppliedByAnswer.set(id, applyKey);
        incTitleIntentStat('replayNoops');
        return { ok: true, status: 'noop-projection-only', answerId: id, desired, hydrated: true };
      }
      const collapsed = desired.state === 'collapsed';
      incTitleIntentStat('domMutationsFromTitleIntent');
      try {
        at?.setCollapsed?.(id, collapsed, {
          animate: opts?.animate === true,
          source: `title-intent:${desired.source}`,
        });
      } catch {}
      stampTitleIntentProjection(id, desired, at?.getBar?.(id) || bar, shell);
      S.titleIntentLastAppliedByAnswer.set(id, applyKey);
      return { ok: true, status: 'applied', answerId: id, desired, hydrated: true };
    } finally {
      endTitleIntentReplay(opts);
    }
  }

  function applyTitleIntentToPage(pageNum = 0, opts = {}) {
    const id = String(opts?.chatId || resolveChatId()).trim();
    const num = Math.max(1, Number(pageNum || 0) || 0);
    const ledger = opts?.ledger ? normalizeTitleIntentLedger(opts.ledger) : readTitleIntentLedger(id);
    if (isTitleIntentLedgerInert(ledger) || !titleIntentPageHasActiveState(num, ledger)) {
      incTitleIntentStat('replaySkippedInert');
      return { ok: true, status: 'skipped-inert', chatId: id, pageNum: num, members: 0, hydrated: 0, unhydrated: 0, results: [] };
    }
    if (!beginTitleIntentReplay(opts)) {
      scheduleTrailingTitleIntentReplay({ chatId: id, pageNum: num });
      return { ok: true, status: 'reentrant-scheduled', chatId: id, pageNum: num, members: 0, hydrated: 0, unhydrated: 0, results: [] };
    }
    try {
      incTitleIntentStat('fullPageApplies');
      if (!Array.isArray(opts?.answerIds)) incTitleIntentStat('membershipScans');
      const members = normalizeAnswerIds(opts?.answerIds || getAuthoritativePageAnswerIds(num, id));
      const results = [];
      for (const answerId of members) {
        results.push(applyTitleIntentToAnswer(answerId, {
          chatId: id,
          page: num,
          animate: opts?.animate === true,
          ledger,
          withinTitleIntentReplay: true,
        }));
      }
      return {
        ok: true,
        status: 'ok',
        chatId: id,
        pageNum: num,
        members: members.length,
        hydrated: results.filter((r) => r?.hydrated).length,
        unhydrated: results.filter((r) => !r?.hydrated).length,
        results,
      };
    } finally {
      endTitleIntentReplay(opts);
    }
  }

  function getResolvedPageTitleIntentSummary(pageNum = 0, chatId = '') {
    const id = String(chatId || resolveChatId()).trim();
    const num = Math.max(1, Number(pageNum || 0) || 0);
    const ledger = readTitleIntentLedger(id);
    const members = normalizeAnswerIds(getAuthoritativePageAnswerIds(num, id));
    let collapsed = 0;
    let expanded = 0;
    for (const answerId of members) {
      const desired = resolveDesiredTitleState(answerId, { chatId: id, page: num, ledger });
      if (desired.state === 'collapsed') collapsed += 1;
      else expanded += 1;
    }
    return {
      chatId: id,
      pageNum: num,
      ledger,
      members,
      collapsed,
      expanded,
      allCollapsed: members.length > 0 && collapsed >= members.length,
      allExpanded: expanded >= members.length,
      mixed: collapsed > 0 && expanded > 0,
    };
  }

  function getNoAnswerRows(pageNum = 0, chatId = '') {
    return getRows(pageNum, chatId).filter((row) => !!row?.noAnswer && !!row?.answerHost && !!row?.titleBar);
  }

  function getPageCollapsedRowSummary(pageNum = 0, chatId = '') {
    const num = Math.max(1, Number(pageNum || 0) || 0);
    const id = String(chatId || resolveChatId()).trim();
    const rows = getRows(num, id);
    if (!rows.length) {
      return {
        rows,
        totalRows: 0,
        collapsedRows: 0,
        allCollapsed: false,
        allExpanded: true,
        normalRows: [],
        noAnswerRows: [],
      };
    }

    const normalRows = rows.filter((row) => !row?.noAnswer && !!String(row?.answerId || '').trim());
    const noAnswerRows = rows.filter((row) => !!row?.noAnswer);
    if (isTitleListActive(num, id)) {
      return {
        rows,
        totalRows: rows.length,
        collapsedRows: rows.length,
        allCollapsed: rows.length > 0,
        allExpanded: false,
        normalRows,
        noAnswerRows,
      };
    }

    let collapsedRows = 0;
    if (normalRows.length) {
      collapsedRows += normalRows.filter((row) => isChatPageRowCollapsed(row)).length;
    }

    if (noAnswerRows.length) {
      collapsedRows += noAnswerRows.filter((row) => isChatPageRowCollapsed(row)).length;
    }

    return {
      rows,
      totalRows: rows.length,
      collapsedRows,
      allCollapsed: collapsedRows >= rows.length,
      allExpanded: collapsedRows <= 0,
      normalRows,
      noAnswerRows,
    };
  }

  function getSections(chatId = '') {
    try { return normalizeFullTurnSections(MM_CORE_PAGES()?.getSections?.(chatId) || { sections: new Map(), allHosts: [] }); } catch { return { sections: new Map(), allHosts: [] }; }
  }

  function normalizeVisualDriver(driver = 'legacy') {
    return String(driver || '').trim().toLowerCase() === 'engine' ? 'engine' : 'legacy';
  }

  function _driverStoreGet(store, chatId = '') {
    const id = String(chatId || resolveChatId()).trim();
    if (!id) return { chatId: '', map: new Map() };
    let map = store.get(id);
    if (!(map instanceof Map)) {
      map = new Map();
      store.set(id, map);
    }
    return { chatId: id, map };
  }

  function getDriverForPage(store, pageNum = 0, chatId = '') {
    const num = Math.max(1, Number(pageNum || 0) || 0);
    if (!num) return 'legacy';
    const entry = _driverStoreGet(store, chatId);
    return normalizeVisualDriver(entry.map.get(num));
  }

  function setDriverForPage(store, pageNum = 0, active = false, driver = 'legacy', chatId = '') {
    const num = Math.max(1, Number(pageNum || 0) || 0);
    const entry = _driverStoreGet(store, chatId);
    if (!entry.chatId || !num) return 'legacy';
    if (active) entry.map.set(num, normalizeVisualDriver(driver));
    else entry.map.delete(num);
    if (!entry.map.size) store.delete(entry.chatId);
    return getDriverForPage(store, num, entry.chatId);
  }

  function getPageCollapseDriver(pageNum = 0, chatId = '') {
    return getDriverForPage(S.collapsedPageDriversByChat, pageNum, chatId);
  }

  function setPageCollapseDriver(pageNum = 0, active = false, driver = 'legacy', chatId = '') {
    return setDriverForPage(S.collapsedPageDriversByChat, pageNum, active, driver, chatId);
  }

  function _pageModeStoreGet(chatId = '') {
    const id = String(chatId || resolveChatId()).trim();
    if (!id) return { chatId: '', map: new Map() };
    let map = S.collapsedPageModesByChat.get(id);
    if (!(map instanceof Map)) {
      map = new Map();
      S.collapsedPageModesByChat.set(id, map);
    }
    return { chatId: id, map };
  }

  function getPageCollapseMode(pageNum = 0, chatId = '') {
    const num = Math.max(1, Number(pageNum || 0) || 0);
    if (!num) return '';
    const entry = _pageModeStoreGet(chatId);
    return String(entry.map.get(num) || '').trim().toLowerCase();
  }

  function setPageCollapseMode(pageNum = 0, active = false, mode = '', chatId = '') {
    const num = Math.max(1, Number(pageNum || 0) || 0);
    const entry = _pageModeStoreGet(chatId);
    if (!entry.chatId || !num) return '';
    const normalized = String(mode || '').trim().toLowerCase();
    if (active && normalized) entry.map.set(num, normalized);
    else entry.map.delete(num);
    if (!entry.map.size) S.collapsedPageModesByChat.delete(entry.chatId);
    return getPageCollapseMode(num, entry.chatId);
  }

  function isChatPageDividerHost(host = null) {
    if (!host) return false;
    try {
      if (host.matches?.('.cgxui-chat-page-divider, .cgxui-pgnw-page-divider')) return true;
      if (host.getAttribute?.('data-cgxui-chat-page-divider') === '1') return true;
      if (host.querySelector?.('.cgxui-chat-page-divider, .cgxui-pgnw-page-divider')) return true;
      if (host.querySelector?.('[data-cgxui-chat-page-divider="1"]')) return true;
    } catch {}
    return false;
  }

  function getPageBodyHosts(hosts = []) {
    return Array.from(new Set((Array.isArray(hosts) ? hosts : []).filter((host) => host && !isChatPageDividerHost(host))));
  }

  function findRowByAnswerId(answerId = '') {
    try {
      const row = MM_CORE_PAGES()?.findRowByAnswerId?.(answerId) || null;
      return normalizeFullTurnRows(row ? [row] : [])[0] || row || null;
    } catch { return null; }
  }

  function readCollapsedPages(chatId = '') {
    return localReadCollapsedPagesSet(chatId);
  }

  function writeCollapsedPages(chatId = '', pages = []) {
    const id = String(chatId || resolveChatId()).trim();
    if (!id) return { ok: false, status: 'chat-id-missing', chatId: '', pages: [] };
    const next = Array.from(localWriteCollapsedPagesSet(id, pages));
    return { ok: true, status: 'ok', chatId: id, pages: next };
  }

  function isPageCollapsed(pageNum = 0, chatId = '') {
    const num = Math.max(1, Number(pageNum || 0) || 0);
    return !!num && localReadCollapsedPagesSet(chatId).has(num);
  }

  function readTitleListPages(chatId = '') {
    return localReadTitleListPagesSet(chatId);
  }

  function writeTitleListPages(chatId = '', pages = []) {
    const id = String(chatId || resolveChatId()).trim();
    if (!id) return { ok: false, status: 'chat-id-missing', chatId: '', pages: [] };
    const next = Array.from(localWriteTitleListPagesSet(id, pages));
    return { ok: true, status: 'ok', chatId: id, pages: next };
  }

  function isTitleListActive(pageNum = 0, chatId = '') {
    const num = Math.max(1, Number(pageNum || 0) || 0);
    const id = String(chatId || resolveChatId()).trim();
    return !!num && S.atomicPageCollapseTransactions.has(collapsedNativeRangeKey(id, num));
  }

  function _clearRestoreProps(el) {
    if (!el?.style) return;
    for (const p of RESTORE_PROPS) {
      try { el.style.removeProperty(p); } catch {}
    }
  }

  function isTitleBarCollapsed(bar = null) {
    return String(bar?.getAttribute?.('data-cgxui-state') || '').split(/\s+/).includes('collapsed');
  }

  function isAnswerTitleCollapsed(answerMsgEl = null, bar = null, answerId = '') {
    const id = String(answerId || answerMsgEl?.getAttribute?.('data-message-id') || answerMsgEl?.dataset?.messageId || '').trim();
    const at = AT_PUBLIC();
    try {
      if (id && at?.isCollapsed && at.isCollapsed(id)) return true;
    } catch {}
    try {
      const um = UM_PUBLIC();
      if (id && typeof um?.getManualCollapsedIds === 'function') {
        const directIds = um.getManualCollapsedIds({ source: 'answer-title' }) || [];
        const batchIds = um.getManualCollapsedIds({ source: 'title-list-row' }) || [];
        if ((Array.isArray(directIds) && directIds.includes(id)) || (Array.isArray(batchIds) && batchIds.includes(id))) {
          return true;
        }
      }
    } catch {}
    return String(answerMsgEl?.getAttribute?.(ANSWER_TITLE_COLLAPSED_ATTR) || '').trim() === '1'
      || String(bar?.getAttribute?.('data-cgxui-state') || '').split(/\s+/).includes('collapsed');
  }

  function getNoAnswerManagedEls(host = null, bar = null, questionHost = null) {
    if (!host?.children) return [];
    const titleBar = bar || host?.querySelector?.('[data-cgxui="atns-answer-title"][data-cgxui-owner="atns"][data-at-no-answer="1"]') || null;
    if (!titleBar) return Array.from(host.children);
    const ancestorPath = new Set();
    let cur = titleBar;
    while (cur && cur !== host) {
      ancestorPath.add(cur);
      cur = cur.parentElement;
    }
    const result = [];
    const seen = new Set(ancestorPath);
    for (const anc of ancestorPath) {
      const parent = anc.parentElement;
      if (!parent) continue;
      for (const sibling of parent.children) {
        if (seen.has(sibling)) continue;
        seen.add(sibling);
        result.push(sibling);
      }
    }

    const addOuterManaged = (root) => {
      const parent = root?.parentElement;
      if (!parent) return;
      for (const sibling of Array.from(parent.children || [])) {
        if (!sibling || sibling === root || sibling === host || sibling === questionHost) continue;
        if (isChatPageDividerHost(sibling)) continue;
        if (seen.has(sibling)) continue;
        seen.add(sibling);
        result.push(sibling);
      }
    };

    addOuterManaged(host);
    if (questionHost && questionHost !== host) {
      if (!seen.has(questionHost)) {
        seen.add(questionHost);
        result.push(questionHost);
      }
      addOuterManaged(questionHost);
    }
    return result;
  }

  function applyNoAnswerTitleCollapsedDom(host = null, collapsed = false, opts = {}) {
    const bar = opts?.bar || host?.querySelector?.('[data-cgxui="atns-answer-title"][data-cgxui-owner="atns"][data-at-no-answer="1"]') || null;
    const questionHost = opts?.questionHost || null;
    // Restore (collapsed=false) must NOT require the bar: on title-list
    // release the stack row has already been torn down, so the no-answer
    // question host would otherwise be stranded hidden (data-cgxui-at-hidden)
    // because the early-return skipped the un-hide. Collapse still needs the
    // bar to stamp its state.
    if (!host || (collapsed && !bar)) return { ok: false, status: 'missing-no-answer-title' };
    const animate = opts.animate !== false;
    const iconEl = bar?.querySelector?.(ANSWER_TITLE_ICON_SEL) || null;
    const managedEls = getNoAnswerManagedEls(host, bar, questionHost);
    const setNoAnswerHiddenAttr = (target, enabled) => {
      if (!target) return;
      if (enabled) target.setAttribute(ATTR_CHAT_PAGE_NO_ANSWER_QUESTION_HIDDEN, '1');
      else target.removeAttribute(ATTR_CHAT_PAGE_NO_ANSWER_QUESTION_HIDDEN);
    };
    if (collapsed) {
      bar.setAttribute('data-cgxui-state', 'collapsed editable');
      setNoAnswerHiddenAttr(host, true);
      setNoAnswerHiddenAttr(questionHost, true);
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
      if (bar) bar.setAttribute('data-cgxui-state', 'editable');
      setNoAnswerHiddenAttr(host, false);
      setNoAnswerHiddenAttr(questionHost, false);
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
        if (animate) setTimeout(() => { try { el.style.transition = ''; } catch {} }, 270);
      });
      // Stamp-driven safety sweep: collapse computes managedEls from the bar's
      // ancestor path, but on title-list release the bar is gone so the
      // managedEls set above (host.children) can miss the exact nodes collapse
      // stamped deeper in the subtree. Clear any lingering hide marker under
      // the host / question host directly so no-answer question turns cannot
      // stay hidden after expand.
      for (const scope of [host, questionHost]) {
        if (!scope?.querySelectorAll) continue;
        try {
          for (const node of scope.querySelectorAll('[data-cgxui-at-hidden],[data-at-question-hidden]')) {
            try { node.removeAttribute('data-cgxui-at-hidden'); } catch {}
            try { node.removeAttribute('data-at-question-hidden'); } catch {}
            _clearRestoreProps(node);
          }
        } catch {}
        try {
          if (scope.hasAttribute?.('data-at-question-hidden')) scope.removeAttribute('data-at-question-hidden');
        } catch {}
      }
    }
    return { ok: true, status: 'ok', host, bar, questionHost, collapsed: !!collapsed };
  }

  function restoreNoAnswerMemberContent(member = null, bar = null) {
    if (!member || member.type === 'answer') return false;
    const qSection = titleListMemberSections(member).questionSection;
    const qAnchor = qSection ? getTurnAnchorNode(qSection) : null;
    if (!qSection || !qAnchor) return false;
    const nodes = new Set([qAnchor, qSection]);
    try {
      for (const node of qAnchor.querySelectorAll(
        '[data-cgxui-at-hidden], [data-at-question-hidden], [data-cgxui-chat-page-question-hidden], [data-cgxui-chat-page-no-answer-question-hidden]'
      )) nodes.add(node);
    } catch {}
    for (const node of nodes) {
      const hadManagedResidue = node.hasAttribute?.('data-cgxui-at-hidden')
        || node.hasAttribute?.('data-at-question-hidden');
      const hadQuestionDisplayHide = node.hasAttribute?.(ATTR_CHAT_PAGE_QUESTION_HIDDEN);
      try { node.removeAttribute('data-cgxui-at-hidden'); } catch {}
      try { node.removeAttribute('data-at-question-hidden'); } catch {}
      try { node.removeAttribute(ATTR_CHAT_PAGE_QUESTION_HIDDEN); } catch {}
      try { node.removeAttribute(ATTR_CHAT_PAGE_NO_ANSWER_QUESTION_HIDDEN); } catch {}
      // Keep ATTR_TITLE_LIST_FLOW_HIDDEN intact until the bounded native-in-
      // place projection resolves and releases the exact canonical wrapper.
      if (hadManagedResidue) _clearRestoreProps(node);
      else if (hadQuestionDisplayHide) { try { node.style.removeProperty('display'); } catch {} }
    }
    try { bar?.setAttribute?.('data-cgxui-state', 'editable'); } catch {}
    const icon = bar?.querySelector?.(ANSWER_TITLE_ICON_SEL) || null;
    if (icon) icon.textContent = '⌄';
    return true;
  }

  function isChatPageRowCollapsed(row = null) {
    if (!row) return false;
    if (row.noAnswer) {
      const hostHidden = String(row.answerHost?.getAttribute?.(ATTR_CHAT_PAGE_NO_ANSWER_QUESTION_HIDDEN) || '').trim() === '1';
      const questionHidden = String(row.questionHost?.getAttribute?.(ATTR_CHAT_PAGE_NO_ANSWER_QUESTION_HIDDEN) || '').trim() === '1';
      return isTitleBarCollapsed(row.titleBar) || hostHidden || questionHidden;
    }
    return isAnswerTitleCollapsed(row.answerMsgEl, row.titleBar, row.answerId);
  }

  function _compactZeroEl(el) {
    if (!el?.style) return;
    for (const p of COMPACT_ZERO_PROPS) {
      try { el.style.setProperty(p, '0px', 'important'); } catch {}
    }
    try { el.setAttribute('data-cgxui-chat-page-title-wrapper', '1'); } catch {}
  }

  function _compactRestoreEl(el) {
    if (!el?.style) return;
    for (const p of COMPACT_ZERO_PROPS) {
      try { el.style.removeProperty(p); } catch {}
    }
    try { el.removeAttribute('data-cgxui-chat-page-title-wrapper'); } catch {}
  }

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

  function setChatPageTurnHostDomState(host, pageNum = 0, collapsed = false) {
    if (!host) return null;
    const num = Math.max(1, Number(pageNum || 0) || 0);
    if (num) host.setAttribute(ATTR_CHAT_PAGE_NUM, String(num));
    else host.removeAttribute(ATTR_CHAT_PAGE_NUM);
    if (collapsed) {
      host.setAttribute(ATTR_CHAT_PAGE_HIDDEN, '1');
      try { host.style.setProperty('display', 'none', 'important'); } catch {}
    } else {
      host.removeAttribute(ATTR_CHAT_PAGE_HIDDEN);
      try { host.style.removeProperty('display'); } catch {}
    }
    // ChatGPT sizes every turn through an only-child wrapper div
    // (height: var(--last-known-height, 50vh)); the section itself measures
    // 0px when its content is virtualized. Hiding only the section therefore
    // changes nothing in layout — the collapsed page keeps its full reserved
    // space and the next page never moves up. Page collapse must hide the
    // wrapper (the layout node) as well, and expand must restore it.
    const layoutNode = getTurnAnchorNode(host);
    if (layoutNode && layoutNode !== host) {
      if (collapsed) {
        layoutNode.setAttribute(ATTR_CHAT_PAGE_WRAPPER_HIDDEN, '1');
        try { layoutNode.style.setProperty('display', 'none', 'important'); } catch {}
      } else {
        layoutNode.removeAttribute(ATTR_CHAT_PAGE_WRAPPER_HIDDEN);
        try { layoutNode.style.removeProperty('display'); } catch {}
      }
    }
    return host;
  }

  // Restore every host stamped hidden for one page. The stamps
  // (page-num + page-hidden attrs) are written by collapse itself, so this
  // sweep covers unhydrated sections and both halves of every Q+A pair even
  // when the rebuilt section host list is incomplete. It only touches
  // page-collapse attributes — title-bar, title-list, MiniMap-local, and
  // unmount hide sources use different markers and are never cleared here.
  function sweepPageHiddenDomState(pageNum = 0) {
    const num = Math.max(1, Number(pageNum || 0) || 0);
    if (!num) return 0;
    let cleared = 0;
    try {
      const esc = (typeof CSS !== 'undefined' && CSS?.escape) ? CSS.escape(String(num)) : String(num);
      for (const host of Array.from(document.querySelectorAll(`[${ATTR_CHAT_PAGE_NUM}="${esc}"][${ATTR_CHAT_PAGE_HIDDEN}="1"]`))) {
        setChatPageTurnHostDomState(host, num, false);
        cleared += 1;
      }
    } catch {}
    return cleared;
  }

  // Clear page-hidden state for every page that is not currently recorded as
  // collapsed — the recovery net for stale stamps after resets, refreshes,
  // or interrupted toggles.
  function sweepStalePageHiddenDomState(chatId = '') {
    const id = String(chatId || resolveChatId()).trim();
    const collapsedSet = localReadCollapsedPagesSet(id);
    let cleared = 0;
    try {
      for (const host of Array.from(document.querySelectorAll(`[${ATTR_CHAT_PAGE_HIDDEN}="1"]`))) {
        const num = Math.max(0, Number(host.getAttribute(ATTR_CHAT_PAGE_NUM) || 0) || 0);
        if (num && collapsedSet.has(num)) continue;
        setChatPageTurnHostDomState(host, num || 1, false);
        cleared += 1;
      }
    } catch {}
    return cleared;
  }

  function sweepQuestionHostRestore() {
    try {
      for (const qHost of Array.from(document.querySelectorAll('[data-cgxui-chat-page-question-hidden="1"]'))) {
        qHost.removeAttribute(ATTR_CHAT_PAGE_QUESTION_HIDDEN);
        _clearRestoreProps(qHost);
      }
    } catch {}
    try {
      for (const qHost of Array.from(document.querySelectorAll('[data-at-question-hidden="1"]'))) {
        qHost.removeAttribute('data-at-question-hidden');
        _clearRestoreProps(qHost);
      }
    } catch {}
    try {
      // Stale wrapper hides (layout nodes of collapsed pages) must also be
      // released or restored pages would stay zero-height.
      for (const wrapper of Array.from(document.querySelectorAll(`[${ATTR_CHAT_PAGE_WRAPPER_HIDDEN}="1"]`))) {
        const inner = wrapper.querySelector?.(`[${ATTR_CHAT_PAGE_HIDDEN}="1"]`);
        if (inner) continue; // page still legitimately collapsed
        wrapper.removeAttribute(ATTR_CHAT_PAGE_WRAPPER_HIDDEN);
        try { wrapper.style.removeProperty('display'); } catch {}
      }
    } catch {}
  }

  function getTitleState(pageNum = 0, chatId = '') {
    const num = Math.max(1, Number(pageNum || 0) || 0);
    const id = String(chatId || resolveChatId()).trim();
    if (isTitleListActive(num, id)) return 'collapsed';
    const summary = getPageCollapsedRowSummary(num, id);
    if (!summary.totalRows) return 'expanded';
    if (summary.collapsedRows <= 0) return 'expanded';
    if (summary.collapsedRows >= summary.totalRows) return 'collapsed';
    return 'mixed';
  }

  function getState(chatId = '') {
    const id = String(chatId || resolveChatId()).trim();
    return {
      booted: !!S.booted,
      bound: !!S.bound,
      listenersBound: !!S.listenersBound,
      chatId: id,
      collapsedPages: Array.from(readCollapsedPages(id) || []).sort((a, b) => a - b),
      titleListPages: Array.from(readTitleListPages(id) || []).sort((a, b) => a - b),
    };
  }

  function getConfiguredDividerRoutes() {
    const cfg = CM_ROUTER_API()?.getConfig?.() || null;
    const gestureBackend = String(cfg?.gestureBackend || 'legacy').trim().toLowerCase();
    const answerTitleMode = String(cfg?.answerTitleDblClickMode || '').trim().toLowerCase();
    const dividerDotMode = String(cfg?.dividerDotClickMode || '').trim().toLowerCase();
    const dividerDblClickMode = String(cfg?.dividerDblClickMode || '').trim().toLowerCase();

    const titleBarRoute = gestureBackend === 'engine' && answerTitleMode === 'unmount-engine'
      ? 'engine/unmount'
      : (gestureBackend === 'off' ? 'off' : 'legacy');
    const dividerDotRoute = gestureBackend === 'engine' && dividerDotMode === 'unmount-engine'
      ? 'engine/unmount'
      : (gestureBackend === 'off' ? 'off' : 'legacy');
    let dividerDblClickRoute = gestureBackend === 'off' ? 'off' : 'legacy';
    if (gestureBackend === 'engine') {
      dividerDblClickRoute = dividerDblClickMode === 'unmount-page-collapse'
        ? 'engine/page-collapse'
        : 'engine/pagination';
    }

    return {
      titleBarRoute,
      dividerDotRoute,
      dividerDblClickRoute,
      hoverInfoBoxEnabled: String(cfg?.chatPageDividerHoverInfoBox || 'on').trim().toLowerCase() !== 'off',
    };
  }

  function getPageDividerDebugState(pageNum = 0, chatId = '') {
    const id = String(chatId || resolveChatId()).trim();
    const num = Math.max(1, Number(pageNum || 0) || 0);
    const rows = getRows(num, id);
    const pageCollapsed = isPageCollapsed(num, id);
    const pageCollapseDriver = getPageCollapseDriver(num, id);
    const pageCollapseMode = getPageCollapseMode(num, id);
    const titleState = getTitleState(num, id);
    const summary = getPageCollapsedRowSummary(num, id);
    const collapsedRows = summary.collapsedRows;
    const routes = getConfiguredDividerRoutes();
    let hiddenQuestionHosts = 0;
    for (const row of rows) {
      const host = row?.questionHost || null;
      if (!host) continue;
      if (String(host.getAttribute?.(ATTR_CHAT_PAGE_QUESTION_HIDDEN) || '').trim() === '1') {
        hiddenQuestionHosts += 1;
        continue;
      }
      try {
        if (String(host.style?.getPropertyValue?.('display') || '').trim().toLowerCase() === 'none') {
          hiddenQuestionHosts += 1;
        }
      } catch {}
    }
    return {
      ok: true,
      status: 'ok',
      pageNum: num,
      chatId: id,
      titleBarRoute: routes.titleBarRoute,
      dividerDotRoute: routes.dividerDotRoute,
      dividerDblClickRoute: routes.dividerDblClickRoute,
      hoverInfoBoxEnabled: routes.hoverInfoBoxEnabled,
      mode: getDividerUiMode(num, id),
      titleListActive: isTitleListActive(num, id),
      pageWrappedByPagination: false,
      pageCollapsed: !!pageCollapsed,
      pageCollapseDriver,
      pageCollapseMode,
      titleState,
      collapsedRows,
      totalRows: rows.length,
      detachedHosts: 0,
      hiddenQuestionHosts,
    };
  }

  function clearTitleListModeState(pageNum = 0, chatId = '') {
    const id = String(chatId || resolveChatId()).trim();
    const num = Math.max(1, Number(pageNum || 0) || 0);
    if (!id || !num) return false;
    const next = localReadTitleListPagesSet(id);
    const had = next.delete(num);
    if (had) localWriteTitleListPagesSet(id, Array.from(next));
    return had;
  }

  // ── Synthetic page title-list (stable, hydration-independent) ─────────────
  // Product contract: the circle lists EVERY canonical member of PAGE N in
  // canonical order, together under the page divider, stable across scroll.
  // In-flow bars cannot satisfy this — unhydrated members have no bars and
  // their wrappers hold full reserved heights between the bars that do exist.
  // So while title-list mode is active for a page we render ONE H2O-owned
  // container after the divider (rows keyed by answerId, text from the
  // persisted title cache with a deterministic fallback) and hide the page's
  // in-flow pair wrappers under a NAMESPACED stamp so page-collapse state can
  // never clobber our restore (and vice versa). No ChatGPT-owned node is
  // mutated beyond the same display-hide technique page collapse already uses.
  const ATTR_TITLE_LIST_FLOW_HIDDEN = 'data-cgxui-chat-page-title-list-hidden';
  const ATTR_TITLE_LIST_ORPHAN_TIMESTAMP_HIDDEN = 'data-cgxui-chat-page-title-list-orphan-timestamp-hidden';
  const ATTR_TITLE_ONLY_ACTIVE_PAGES = 'data-cgxui-chat-title-only-pages';
  const ATTR_TITLE_LIST_NUM = 'data-h2o-title-list-num';
  const TITLE_LIST_SYNTH_SEL = '[data-cgxui="chat-page-title-list-synth"]';
  const ATTR_TITLE_LIST_SEGMENT = 'data-h2o-title-list-segment';
  const TITLE_LIST_SUFFIX_SEL = '[data-h2o-title-list-segment="suffix"]';
  const TITLE_LIST_EFFECTIVE_METHOD = Object.freeze({
    STATUS: ['get', 'Effective', 'PresentationStatus'].join(''),
    INDEX: ['get', 'Effective', 'PresentationIndex'].join(''),
    BY_QID: ['get', 'Effective', 'TurnRecordByQId'].join(''),
    BY_AID: ['get', 'Effective', 'TurnRecordByAId'].join(''),
  });

  function TURN_RUNTIME() {
    try { return TOPW.H2O?.turnRuntime || W.H2O?.turnRuntime || null; } catch { return null; }
  }

  function turnRecordForTitleListIdentity(anyId = '', turnNo = 0) {
    const raw = String(anyId || '').trim();
    const rt = TURN_RUNTIME();
    try {
      return (raw && (
        rt?.[TITLE_LIST_EFFECTIVE_METHOD.BY_AID]?.(raw)
        || rt?.[TITLE_LIST_EFFECTIVE_METHOD.BY_QID]?.(raw)
        || rt?.getTurnRecordByAId?.(raw)
        || rt?.getTurnRecordByQId?.(raw)
        || rt?.getTurnRecordByTurnId?.(raw)
      )) || (turnNo ? rt?.getTurnRecordByTurnNo?.(turnNo) : null) || null;
    } catch { return null; }
  }

  function sectionByAnswerIdForTitleList(anyId = '', role = '', recordHint = null) {
    const raw = String(anyId || '').trim();
    const wantedRole = String(role || '').trim().toLowerCase();
    const record = recordHint || turnRecordForTitleListIdentity(raw);
    const ids = new Set([
      raw,
      record?.qId,
      record?.primaryAId,
      ...(Array.isArray(record?.answerIds) ? record.answerIds : []),
      ...(Array.isArray(record?._aliasIds) ? record._aliasIds : []),
    ].map((value) => String(value || '').trim()).filter(Boolean));
    const liveCandidate = wantedRole === 'user'
      ? record?.live?.qEl
      : wantedRole === 'assistant'
        ? record?.live?.primaryAEl
        : (record?.live?.primaryAEl || record?.live?.qEl);
    const liveSection = getTurnSectionForNode(liveCandidate);
    if (liveSection && (!wantedRole || getTurnHostRole(liveSection) === wantedRole)) return liveSection;
    for (const id of ids) {
      try {
        const esc = (typeof CSS !== 'undefined' && CSS?.escape) ? CSS.escape(id) : id.replace(/"/g, '\\"');
        const roleSel = wantedRole ? `[data-turn="${wantedRole}"]` : '';
        const section = document.querySelector(`section[data-testid^="conversation-turn"]${roleSel}[data-turn-id="${esc}"]`) || null;
        if (section) return section;
      } catch {}
    }
    return null;
  }

  function turnNumberOfSection(section = null) {
    return Math.max(0, Number(String(section?.getAttribute?.('data-testid') || '')
      .match(/conversation-turn-(\d+)/)?.[1] || 0) || 0);
  }

  function titleListMemberSections(member = null) {
    if (!member) return { record: null, questionSection: null, answerSection: null };
    const identity = member.answerId || member.questionId || member.id || '';
    const record = turnRecordForTitleListIdentity(identity, member.turnNo);
    let answerSection = member.type === 'answer'
      ? sectionByAnswerIdForTitleList(member.answerId, 'assistant', record)
      : null;
    let questionSection = sectionByAnswerIdForTitleList(member.questionId || record?.qId || identity, 'user', record);
    // Never recover a missing exact qId by indexing the currently mounted
    // USER subset. With Page 1 title-listed, the first mounted USER can be
    // canonical order 26; treating it as order 1 leaks Page 1 ownership onto
    // Page 2. Hydration must restore the exact identity instead.
    // Adjacency is a placement fallback only. Canonical membership and the
    // page/turn number still come from turnRuntime; visible order never
    // decides which page owns the pair.
    if (!questionSection && answerSection) {
      const previous = getPreviousTurnHost(answerSection);
      if (getTurnHostRole(previous) === 'user') questionSection = previous;
    }
    if (!answerSection && member.type === 'answer' && questionSection) {
      const next = getNextTurnHost(questionSection);
      if (getTurnHostRole(next) === 'assistant') answerSection = next;
    }
    return { record, questionSection, answerSection };
  }

  // Canonical PAGE TITLE members: every Q+A pair of the page, INCLUDING
  // unanswered pairs. Primary source is the Core turnRuntime record list —
  // the gap-aware pair map built from the persistent turn sections (pair 19
  // with no assistant still has a record with its true turnNo and qId).
  // Fallback is the MiniMap turn list (answers only) using each entry's own
  // turnNo/index field — NEVER the array offset, which drifts by one for
  // every unanswered pair before it.
  function pureCanonicalPageMemberDetails(pageNum = 0) {
    const num = Math.max(1, Number(pageNum || 0) || 0);
    const out = [];
    const seen = new Set();
    try {
      const records = TURN_RUNTIME()?.listTurnRecords?.() || [];
      for (const rec of Array.isArray(records) ? records : []) {
        const turnNo = Math.max(0, Number(rec?.turnNo || rec?.idx || 0) || 0);
        if (!turnNo || Math.ceil(turnNo / 25) !== num) continue;
        // H2O Core's canonical schema owns answers as primaryAId + answerIds;
        // answerId/aId are compatibility projections and can be absent during
        // reconciliation. Missing the canonical fields misclassified a real
        // Q+A record as NO ANSWER and left its flow content outside the stack.
        const answerId = String(
          rec?.primaryAId
          || rec?.answerId
          || rec?.aId
          || (Array.isArray(rec?.answerIds) ? rec.answerIds[0] : '')
          || ''
        ).trim();
        const questionId = String(rec?.qId || rec?.questionId || '').trim();
        const turnId = String(rec?.turnId || rec?.id || '').trim();
        const aliasIds = Array.from(new Set([
          answerId,
          ...(Array.isArray(rec?.answerIds) ? rec.answerIds : []),
          ...(Array.isArray(rec?._aliasIds) ? rec._aliasIds : []),
        ].map((value) => String(value || '').trim()).filter(Boolean)));
        const id = answerId || questionId || `turn-${turnNo}`;
        if (seen.has(id)) continue;
        seen.add(id);
        out.push({ id, answerId, questionId, turnId, aliasIds, turnNo, type: answerId ? 'answer' : 'no-answer' });
      }
    } catch {}
    if (!out.length) {
      try {
        const list = MM_CORE_API()?.getTurnList?.() || [];
        for (let i = 0; i < (Array.isArray(list) ? list.length : 0); i += 1) {
          const turnNo = Math.max(0, Number(list[i]?.turnNo || list[i]?.index || 0) || 0) || (i + 1);
          if (Math.ceil(turnNo / 25) !== num) continue;
          const answerId = String(list[i]?.answerId || list[i]?.primaryAId || '').trim();
          if (!answerId || seen.has(answerId)) continue;
          seen.add(answerId);
          out.push({
            id: answerId,
            answerId,
            questionId: String(list[i]?.questionId || list[i]?.qId || '').trim(),
            turnId: String(list[i]?.turnId || '').trim(),
            aliasIds: [answerId],
            turnNo,
            type: 'answer',
          });
        }
      } catch {}
    }
    out.sort((a, b) => a.turnNo - b.turnNo);
    return out;
  }

  function titleListEffectiveStatusIdentity(status = null) {
    return JSON.stringify([
      String(status?.source || ''),
      status?.overlayActive === true,
      Math.max(0, Number(status?.count || 0) || 0),
      String(status?.canonicalFingerprint || ''),
      String(status?.anchorQId || ''),
      Math.max(0, Number(status?.pathLength || 0) || 0),
      String(status?.chatId || ''),
      String(status?.routeKey || ''),
      Math.max(0, Number(status?.generation || 0) || 0),
    ]);
  }

  function titleListMemberFromPresentationRecord(record = null, expectedOrder = 0) {
    const order = Math.max(0, Number(record?.order || record?.turnNo || record?.idx || 0) || 0);
    if (!record || !order || order !== expectedOrder) return null;
    const questionId = String(record?.qId || record?.questionId || '').trim();
    const answerId = String(record?.primaryAId || record?.answerId || record?.aId || '').trim();
    const turnId = String(record?.turnId || record?.id || '').trim();
    const noAnswer = record?.noAnswer === true;
    if (!questionId || (noAnswer ? !!answerId : !answerId)) return null;
    const aliasIds = Array.from(new Set([
      answerId,
      ...(Array.isArray(record?.answerVariants) ? record.answerVariants : []),
      ...(Array.isArray(record?.answerIds) ? record.answerIds : []),
      ...(Array.isArray(record?._aliasIds) ? record._aliasIds : []),
    ].map((value) => String(value || '').trim()).filter(Boolean)));
    const id = answerId || questionId || `turn-${order}`;
    return {
      id,
      answerId,
      questionId,
      turnId,
      aliasIds,
      turnNo: order,
      type: answerId ? 'answer' : 'no-answer',
    };
  }

  // Read status + index + status as one effective authority snapshot. Any
  // transition, incomplete proof, identity ambiguity, or getter disagreement
  // falls back wholesale to the canonical list; effective count and canonical
  // rows are never mixed.
  function readEffectiveTitleListAuthority() {
    const rt = TURN_RUNTIME();
    if (!rt) return null;
    let before = null;
    let after = null;
    let index = null;
    try {
      before = rt[TITLE_LIST_EFFECTIVE_METHOD.STATUS]?.() || null;
      index = rt[TITLE_LIST_EFFECTIVE_METHOD.INDEX]?.() || null;
      after = rt[TITLE_LIST_EFFECTIVE_METHOD.STATUS]?.() || null;
    } catch {
      return null;
    }
    const count = Math.max(0, Number(before?.count || 0) || 0);
    if (
      before?.overlayActive !== true
      || before?.source !== 'selected-path-overlay'
      || count < 1
      || titleListEffectiveStatusIdentity(before) !== titleListEffectiveStatusIdentity(after)
      || index?.complete !== true
      || index?.proof !== 'selected-path-overlay'
      || !Array.isArray(index?.turns)
      || index.turns.length !== count
    ) return null;

    const members = [];
    const qIds = new Set();
    const aIds = new Set();
    for (let offset = 0; offset < index.turns.length; offset += 1) {
      const member = titleListMemberFromPresentationRecord(index.turns[offset], offset + 1);
      if (!member || qIds.has(member.questionId)) return null;
      qIds.add(member.questionId);
      let exactQ = null;
      try { exactQ = rt[TITLE_LIST_EFFECTIVE_METHOD.BY_QID]?.(member.questionId) || null; } catch {}
      if (
        Number(exactQ?.order || exactQ?.turnNo || exactQ?.idx || 0) !== member.turnNo
        || String(exactQ?.qId || exactQ?.questionId || '') !== member.questionId
      ) return null;
      if (member.answerId) {
        if (aIds.has(member.answerId)) return null;
        aIds.add(member.answerId);
        let exactA = null;
        try { exactA = rt[TITLE_LIST_EFFECTIVE_METHOD.BY_AID]?.(member.answerId) || null; } catch {}
        if (
          Number(exactA?.order || exactA?.turnNo || exactA?.idx || 0) !== member.turnNo
          || String(exactA?.primaryAId || exactA?.answerId || exactA?.aId || '') !== member.answerId
        ) return null;
      }
      members.push(member);
    }
    return {
      source: 'selected-path-overlay',
      count,
      pageCount: Math.ceil(count / 25),
      members,
      status: before,
    };
  }

  function readTitleListPresentationAuthority() {
    const effective = readEffectiveTitleListAuthority();
    if (effective) return effective;
    const members = [];
    for (let pageNum = 1; pageNum <= 512; pageNum += 1) {
      const page = pureCanonicalPageMemberDetails(pageNum);
      if (!page.length) break;
      members.push(...page);
      if (page.length < 25) break;
    }
    const count = members.length
      ? Math.max(...members.map((member) => Number(member?.turnNo || 0)))
      : 0;
    return {
      source: 'canonical',
      count,
      pageCount: count ? Math.ceil(count / 25) : 0,
      members,
      status: null,
    };
  }

  // Page existence is presentation-authority data, not mounted-DOM data.
  // This model is rebuilt in memory from one coherent effective-or-canonical
  // snapshot and is never written to cache, aliases, storage, or turn records.
  function buildTitleListPresentationPageModel() {
    const authority = readTitleListPresentationAuthority();
    const count = Math.max(0, Number(authority?.count || 0) || 0);
    const pageCount = count ? Math.ceil(count / TITLE_LIST_PAGE_SIZE) : 0;
    const pages = [];
    for (let pageNo = 1; pageNo <= pageCount; pageNo += 1) {
      const startOrder = ((pageNo - 1) * TITLE_LIST_PAGE_SIZE) + 1;
      const endOrder = Math.min(count, pageNo * TITLE_LIST_PAGE_SIZE);
      const turnRecords = (Array.isArray(authority?.members) ? authority.members : [])
        .filter((member) => {
          const order = Math.max(0, Number(member?.turnNo || 0) || 0);
          return order >= startOrder && order <= endOrder;
        })
        .sort((a, b) => Number(a?.turnNo || 0) - Number(b?.turnNo || 0));
      if (turnRecords.length !== (endOrder - startOrder + 1)) {
        return {
          source: 'canonical',
          count: 0,
          pageSize: TITLE_LIST_PAGE_SIZE,
          pageCount: 0,
          pages: [],
          coherent: false,
          reason: 'page-membership-incomplete',
        };
      }
      pages.push({ pageNo, startOrder, endOrder, turnRecords });
    }
    return {
      source: String(authority?.source || 'canonical'),
      count,
      pageSize: TITLE_LIST_PAGE_SIZE,
      pageCount,
      pages,
      coherent: count > 0 && pages.length === pageCount,
      reason: count > 0 ? 'complete' : 'authority-empty',
    };
  }

  const RENDERED_BOUNDARY_SENTINEL_ATTR = 'data-h2o-chat-page-boundary';
  const RENDERED_BOUNDARY_SENTINEL_PAGE_ATTR = 'data-h2o-chat-page-boundary-page';
  const RENDERED_BOUNDARY_SENTINEL_KIND_ATTR = 'data-h2o-chat-page-boundary-kind';

  function renderedBoundaryStatusIdentity(status = null) {
    return JSON.stringify([
      String(status?.source || ''),
      status?.overlayActive === true,
      Math.max(0, Number(status?.count || 0) || 0),
      String(status?.canonicalFingerprint || ''),
      String(status?.anchorQId || ''),
      Math.max(0, Number(status?.pathLength || 0) || 0),
      String(status?.chatId || ''),
      String(status?.routeKey || ''),
      Math.max(0, Number(status?.generation || 0) || 0),
    ]);
  }

  function frozenRenderedPageBoundaryCapability(raw = {}) {
    return Object.freeze({
      version: 2,
      supported: raw.supported === true,
      reason: raw.reason == null ? null : String(raw.reason || ''),
      pageNum: Math.max(1, Number(raw.pageNum || 0) || 0),
      pageStartOrder: Math.max(1, Number(raw.pageStartOrder || 0) || 0),
      isThreadStart: raw.isThreadStart === true,
      chatId: String(raw.chatId || '') || null,
      routeKey: String(raw.routeKey || ''),
      generation: Math.max(0, Number(raw.generation || 0) || 0),
      effectiveFingerprint: String(raw.effectiveFingerprint || '') || null,
      graphFingerprint: String(raw.graphFingerprint || '') || null,
      qId: String(raw.qId || '') || null,
      primaryAId: String(raw.primaryAId || '') || null,
      source: raw.source == null ? null : String(raw.source || ''),
      flowRootConnected: raw.flowRootConnected === true,
      boundarySectionMounted: raw.boundarySectionMounted === true,
      boundaryWrapperConnected: raw.boundaryWrapperConnected === true,
      boundaryDomRole: String(raw.boundaryDomRole || '') || null,
      boundaryTestId: String(raw.boundaryTestId || '') || null,
      boundaryDirectFlowIndex: Number.isInteger(raw.boundaryDirectFlowIndex)
        ? raw.boundaryDirectFlowIndex
        : -1,
      primaryAnswerMounted: raw.primaryAnswerMounted === true,
      primaryAnswerDomRole: String(raw.primaryAnswerDomRole || '') || null,
      primaryAnswerTestId: String(raw.primaryAnswerTestId || '') || null,
      primaryAnswerDirectFlowIndex: Number.isInteger(raw.primaryAnswerDirectFlowIndex)
        ? raw.primaryAnswerDirectFlowIndex
        : -1,
      dividerConnected: raw.dividerConnected === true,
      dividerBeforeBoundary: raw.dividerBeforeBoundary === true,
      startSentinelConnected: raw.startSentinelConnected === true,
      startSentinelBeforeBoundary: raw.startSentinelBeforeBoundary === true,
      interveningNonH2ONodeCount: Math.max(
        0,
        Number(raw.interveningNonH2ONodeCount || 0) || 0,
      ),
      boundaryIdentityCurrent: raw.boundaryIdentityCurrent === true,
      pageUnitOrderCurrent: raw.pageUnitOrderCurrent === true,
      pageUnitOrderReason: raw.pageUnitOrderReason == null
        ? null
        : String(raw.pageUnitOrderReason || ''),
      placementRepairRequired: raw.placementRepairRequired === true,
      leaseCurrent: raw.leaseCurrent === true,
    });
  }

  function renderedBoundaryDirectChildUnder(root = null, node = null) {
    if (!root || !node || root === node) return null;
    let current = node;
    while (current?.parentElement && current.parentElement !== root) {
      current = current.parentElement;
    }
    return current?.parentElement === root ? current : null;
  }

  function renderedBoundaryRoleFromCarrier(identityCarrier = null, nativeTestHost = null) {
    if (!identityCarrier || !nativeTestHost || !nativeTestHost.contains?.(identityCarrier)) {
      return { renderedRoleCarrier: null, renderedRole: '' };
    }
    let candidate = identityCarrier;
    while (candidate) {
      const turnRole = String(candidate.getAttribute?.('data-turn') || '').trim().toLowerCase();
      const authorRole = String(
        candidate.getAttribute?.('data-message-author-role') || ''
      ).trim().toLowerCase();
      const renderedRole = ['user', 'assistant'].includes(turnRole)
        ? turnRole
        : (['user', 'assistant'].includes(authorRole) ? authorRole : '');
      if (renderedRole) {
        return { renderedRoleCarrier: candidate, renderedRole };
      }
      if (candidate === nativeTestHost) break;
      candidate = candidate.parentElement;
    }
    return { renderedRoleCarrier: null, renderedRole: '' };
  }

  function resolveRenderedTurnSurfaceByIdentity(identity = '', flowRoot = null) {
    const id = String(identity || '').trim();
    if (!id) return { ok: false, reason: 'identity-unmounted' };
    let identityCarriers = [];
    /* Identity domains, per measured host contract: product identities (qId,
       primaryAId) are MESSAGE ids — the one stable identity across
       rematerialization — while section data-turn-id carries the branch NODE
       id. The two coincide only for never-branched turns, so a
       data-turn-id-only lookup matched product identities by accident and
       failed on any edited/regenerated turn (measured live: turn section
       data-turn-id 1f6f1e66… while its qId is c06d946d…). Resolve through
       the MountRegistry's message-id binding first; the node-id match stays
       for callers that pass node-domain ids. */
    try {
      const mounts = (TOPW?.H2O?.obs || W?.H2O?.obs)?.mounts;
      const rec = mounts?.get?.(id);
      const el = rec?.el?.isConnected === true ? rec.el : null;
      const section = el
        ? (el.closest?.('section[data-turn-id]') || el.closest?.(TURN_HOST_SEL) || null)
        : null;
      if (section?.isConnected === true) identityCarriers = [section];
    } catch {}
    if (!identityCarriers.length) {
      try {
        const node = document.querySelector(`[data-message-id="${(typeof CSS !== 'undefined' && CSS?.escape) ? CSS.escape(id) : id.replace(/"/g, '\\"')}"]`);
        const section = node?.isConnected === true
          ? (node.closest?.('section[data-turn-id]') || node.closest?.(TURN_HOST_SEL) || null)
          : null;
        if (section?.isConnected === true) identityCarriers = [section];
      } catch {}
    }
    if (!identityCarriers.length) {
      try {
        identityCarriers = Array.from(document.querySelectorAll('section[data-turn-id]')).filter(
          (carrier) => (
            carrier?.isConnected === true
            && String(carrier.getAttribute?.('data-turn-id') || '').trim() === id
          )
        );
      } catch {}
    }
    if (!identityCarriers.length) return { ok: false, reason: 'identity-unmounted' };
    if (identityCarriers.length !== 1) return { ok: false, reason: 'identity-ambiguous' };
    const identityCarrier = identityCarriers[0];
    let nativeTestHostCount = 0;
    let ancestor = identityCarrier;
    while (ancestor) {
      if (ancestor.matches?.(TURN_HOST_SEL)) nativeTestHostCount += 1;
      ancestor = ancestor.parentElement;
    }
    const nativeTestHost = identityCarrier.matches?.(TURN_HOST_SEL)
      ? identityCarrier
      : identityCarrier.closest?.(TURN_HOST_SEL) || null;
    if (
      nativeTestHostCount !== 1
      || !nativeTestHost
      || nativeTestHost?.isConnected !== true
      || !nativeTestHost.contains?.(identityCarrier)
    ) return { ok: false, reason: 'native-test-host-unavailable' };
    const identityWrapper = renderedBoundaryDirectChildUnder(flowRoot, identityCarrier);
    const nativeHostWrapper = renderedBoundaryDirectChildUnder(flowRoot, nativeTestHost);
    if (!identityWrapper || !nativeHostWrapper) {
      return { ok: false, reason: 'flow-wrapper-unavailable' };
    }
    if (identityWrapper !== nativeHostWrapper) {
      return { ok: false, reason: 'surface-wrapper-mismatch' };
    }
    const role = renderedBoundaryRoleFromCarrier(identityCarrier, nativeTestHost);
    return {
      ok: true,
      reason: null,
      identityCarrier,
      renderedRoleCarrier: role.renderedRoleCarrier,
      nativeTestHost,
      directFlowWrapper: identityWrapper,
      renderedRole: role.renderedRole,
      testId: String(nativeTestHost.getAttribute?.('data-testid') || '') || null,
    };
  }

  function renderedBoundaryThreadDivider(pageNum = 0) {
    const num = Math.max(1, Number(pageNum || 0) || 0);
    let dividers = [];
    try {
      dividers = Array.from(document.querySelectorAll(
        `.cgxui-chat-page-divider[data-page-num="${String(num)}"],`
        + ` .cgxui-pgnw-page-divider[data-page-num="${String(num)}"]`
      )).filter((divider) => (
        divider?.isConnected === true
        && !divider.closest?.('#cgx-mm-root, .cgxui-mm-page-divider')
      ));
    } catch {}
    return dividers.length === 1 ? dividers[0] : null;
  }

  function renderedBoundaryStartSentinel(pageNum = 0) {
    const num = Math.max(1, Number(pageNum || 0) || 0);
    let sentinels = [];
    try {
      sentinels = Array.from(document.querySelectorAll(
        `[${RENDERED_BOUNDARY_SENTINEL_ATTR}="page-${String(num)}-start"]`
      )).filter((sentinel) => (
        sentinel?.isConnected === true
        && String(sentinel.getAttribute?.(RENDERED_BOUNDARY_SENTINEL_PAGE_ATTR) || '') === String(num)
        && String(sentinel.getAttribute?.(RENDERED_BOUNDARY_SENTINEL_KIND_ATTR) || '') === 'start'
      ));
    } catch {}
    return sentinels.length === 1 ? sentinels[0] : null;
  }

  function renderedBoundaryOrderingNodeAllowed(node = null, divider = null) {
    if (!node || node.nodeType !== 1) return false;
    if (node === divider) return true;
    // Every H2O-owned page unit legitimately sits between the page start
    // sentinel and the boundary wrapper — divider, boundary sentinels and the
    // collapse title-list projection. The counter this feeds is
    // interveningNonH2ONodeCount, so an H2O node must never increment it.
    // Omitting the title list made the atomic transaction invalidate its own
    // committed output: inserting the projection flipped pageUnitOrderCurrent
    // to false, and the post-commit revalidation then rolled the whole
    // collapse back while the capability still reported activationReady.
    if (typeof pageCollapseRangeH2OOwned === 'function' && pageCollapseRangeH2OOwned(node)) return true;
    try {
      return !!node.getAttribute?.(RENDERED_BOUNDARY_SENTINEL_ATTR)
        && !!node.getAttribute?.(RENDERED_BOUNDARY_SENTINEL_PAGE_ATTR)
        && ['start', 'end'].includes(String(
          node.getAttribute?.(RENDERED_BOUNDARY_SENTINEL_KIND_ATTR) || ''
        ));
    } catch {
      return false;
    }
  }

  function renderedBoundaryLayoutProof(flowRoot = null, wrapper = null, divider = null, sentinel = null) {
    const children = Array.from(flowRoot?.children || []);
    const boundaryIndex = children.indexOf(wrapper);
    const dividerIndex = children.indexOf(divider);
    const sentinelIndex = children.indexOf(sentinel);
    const dividerBeforeBoundary = dividerIndex >= 0
      && boundaryIndex >= 0
      && dividerIndex < boundaryIndex;
    const startSentinelBeforeBoundary = sentinelIndex >= 0
      && boundaryIndex >= 0
      && sentinelIndex < boundaryIndex;
    const intervening = startSentinelBeforeBoundary
      ? children.slice(sentinelIndex + 1, boundaryIndex)
      : [];
    const interveningNonH2ONodeCount = intervening.filter(
      (node) => !renderedBoundaryOrderingNodeAllowed(node, divider)
    ).length;
    return {
      boundaryIndex,
      dividerBeforeBoundary,
      startSentinelBeforeBoundary,
      interveningNonH2ONodeCount,
    };
  }

  function renderedBoundaryWrapperCarriesIdentity(wrapper = null, identity = '') {
    const id = String(identity || '').trim();
    return !!wrapper
      && !!id
      && String(wrapper.getAttribute?.('data-turn-id-container') || '').trim() === id;
  }

  function renderedBoundaryColdWrapperH2OOwned(node = null) {
    if (!node || node.nodeType !== 1) return false;
    try {
      return node.matches?.(
        '.cgxui-chat-page-divider, .cgxui-pgnw-page-divider,'
        + ' [data-cgxui="chat-page-title-list-synth"],'
        + ' [data-h2o-chat-page-boundary], #cgx-mm-root,'
        + ' [data-cgxui-owner="mnmp"], [data-h2o-title-list-segment="suffix"]'
      ) === true;
    } catch {
      return false;
    }
  }

  function resolveColdRenderedBoundaryWrapper(flowRoot = null, identity = '') {
    const id = String(identity || '').trim();
    if (!flowRoot || flowRoot?.isConnected !== true || !id) {
      return { ok: false, reason: 'identity-unmounted', wrapper: null };
    }
    const exactMatches = Array.from(flowRoot.children || []).filter((child) => (
      child?.nodeType === 1
      && child?.isConnected === true
      && child?.parentElement === flowRoot
      && String(child.getAttribute?.('data-turn-id-container') || '').trim() === id
    ));
    if (!exactMatches.length) {
      return { ok: false, reason: 'identity-unmounted', wrapper: null };
    }
    if (exactMatches.length !== 1) {
      return { ok: false, reason: 'identity-ambiguous', wrapper: null };
    }
    const wrapper = exactMatches[0];
    if (renderedBoundaryColdWrapperH2OOwned(wrapper)) {
      return { ok: false, reason: 'identity-unproven', wrapper: null };
    }
    return { ok: true, reason: null, wrapper };
  }

  function renderedBoundaryPageUnitPlacement(flowRoot = null, wrapper = null, pageNum = 0) {
    const divider = renderedBoundaryThreadDivider(pageNum);
    const startSentinel = renderedBoundaryStartSentinel(pageNum);
    const dividerConnected = divider?.isConnected === true;
    const startSentinelConnected = startSentinel?.isConnected === true;
    const dividerInFlow = dividerConnected && divider?.parentElement === flowRoot;
    const sentinelInFlow = startSentinelConnected && startSentinel?.parentElement === flowRoot;
    const layout = renderedBoundaryLayoutProof(
      flowRoot,
      wrapper,
      dividerInFlow ? divider : null,
      sentinelInFlow ? startSentinel : null,
    );
    let pageUnitOrderReason = null;
    if (!dividerConnected) pageUnitOrderReason = 'divider-unavailable';
    else if (!startSentinelConnected) pageUnitOrderReason = 'sentinel-unavailable';
    else if (!dividerInFlow || !sentinelInFlow) pageUnitOrderReason = 'page-unit-order-incomplete';
    else if (!layout.startSentinelBeforeBoundary) {
      pageUnitOrderReason = 'sentinel-after-boundary';
    } else if (!layout.dividerBeforeBoundary) {
      pageUnitOrderReason = 'divider-after-boundary';
    } else if (layout.interveningNonH2ONodeCount) {
      pageUnitOrderReason = 'intervening-host-node';
    }
    const pageUnitOrderCurrent = pageUnitOrderReason == null;
    return {
      divider,
      startSentinel,
      dividerConnected,
      dividerBeforeBoundary: layout.dividerBeforeBoundary,
      startSentinelConnected,
      startSentinelBeforeBoundary: layout.startSentinelBeforeBoundary,
      interveningNonH2ONodeCount: layout.interveningNonH2ONodeCount,
      boundaryIndex: layout.boundaryIndex,
      pageUnitOrderCurrent,
      pageUnitOrderReason,
    };
  }

  function renderedBoundaryTransitionActive(projection = null) {
    return projection?.selectedPathConfirmationPending === true
      || projection?.selectedPathConfirmationLeaseActive === true
      || projection?.selectedPathRequestLeaseActive === true;
  }

  function renderedBoundaryRecordStreaming(record = null) {
    return record?.completeIndexPending === true
      || record?.livePendingStreaming === true;
  }

  function readRenderedBoundaryAuthority(pageNum = 0) {
    const num = Math.max(1, Number(pageNum || 0) || 0);
    const rt = TURN_RUNTIME();
    if (
      !rt
      || typeof rt.getEffectivePresentationStatus !== 'function'
      || typeof rt.getEffectivePresentationIndex !== 'function'
    ) return { ok: false, reason: 'authority-unavailable', pageNum: num };
    let before = null;
    let after = null;
    let index = null;
    let projection = null;
    try {
      before = rt.getEffectivePresentationStatus() || null;
      index = rt.getEffectivePresentationIndex() || null;
      projection = rt.getCompleteTurnIndexProjectionStatus?.() || null;
      after = rt.getEffectivePresentationStatus() || null;
    } catch {
      return { ok: false, reason: 'authority-unavailable', pageNum: num };
    }
    const count = Math.max(0, Number(before?.count || 0) || 0);
    const generation = Math.max(0, Number(before?.generation || 0) || 0);
    const effectiveFingerprint = String(index?.sourceFingerprint || '');
    const canonicalFingerprint = String(before?.canonicalFingerprint || '');
    const chatId = String(before?.chatId || '');
    const routeKey = String(before?.routeKey || '');
    const turns = Array.isArray(index?.turns) ? index.turns : [];
    const coherent = (
      count > 0
      && generation > 0
      && !!effectiveFingerprint
      && !!chatId
      && !!routeKey
      && index?.complete === true
      && turns.length === count
      && renderedBoundaryStatusIdentity(before) === renderedBoundaryStatusIdentity(after)
      && turns.every((record, offset) => (
        Math.max(0, Number(record?.order || record?.turnNo || 0) || 0) === offset + 1
        && !!String(record?.qId || '').trim()
      ))
      && projection?.authoritative === true
      && String(projection?.chatId || '') === chatId
      && Math.max(0, Number(projection?.routeGeneration || 0) || 0) === generation
      && String(projection?.fingerprint || '') === canonicalFingerprint
    );
    if (!coherent) {
      return {
        ok: false,
        reason: 'authority-incoherent',
        pageNum: num,
        count,
        generation,
        effectiveFingerprint,
        chatId,
        routeKey,
      };
    }
    const pageStartOrder = ((num - 1) * TITLE_LIST_PAGE_SIZE) + 1;
    if (pageStartOrder > count) {
      return {
        ok: false,
        reason: 'page-not-present',
        pageNum: num,
        pageStartOrder,
        count,
        generation,
        effectiveFingerprint,
        chatId,
        routeKey,
      };
    }
    const record = turns[pageStartOrder - 1] || null;
    const qId = String(record?.qId || '').trim();
    if (!qId) {
      return {
        ok: false,
        reason: 'boundary-qid-unavailable',
        pageNum: num,
        pageStartOrder,
        count,
        generation,
        effectiveFingerprint,
        chatId,
        routeKey,
      };
    }
    let exact = null;
    try { exact = rt.getEffectiveTurnRecordByQId?.(qId) || null; } catch {}
    if (
      !exact
      || Math.max(0, Number(exact?.order || exact?.turnNo || 0) || 0) !== pageStartOrder
      || String(exact?.qId || '') !== qId
    ) {
      return {
        ok: false,
        reason: 'authority-incoherent',
        pageNum: num,
        pageStartOrder,
        count,
        generation,
        effectiveFingerprint,
        chatId,
        routeKey,
      };
    }
    return {
      ok: true,
      pageNum: num,
      pageStartOrder,
      count,
      generation,
      effectiveFingerprint,
      chatId,
      routeKey,
      projection,
      statusIdentity: renderedBoundaryStatusIdentity(before),
      record: exact,
      qId,
      primaryAId: String(exact?.primaryAId || '').trim(),
    };
  }

  function renderedBoundaryLeaseScopeCurrent(lease = null, authority = null, graphFingerprint = '') {
    return !!lease
      && lease.pageNum === authority?.pageNum
      && lease.pageStartOrder === authority?.pageStartOrder
      && lease.chatId === authority?.chatId
      && lease.routeKey === authority?.routeKey
      && lease.generation === authority?.generation
      && lease.effectiveFingerprint === authority?.effectiveFingerprint
      && lease.graphFingerprint === graphFingerprint
      && lease.qId === authority?.qId
      && lease.primaryAId === authority?.primaryAId;
  }

  function renderedBoundaryIdentityProof(rt, ids) {
    /* Identity proof source order. The Tier-0 complete-index proof is the
       same host-payload-proven authority the whole foundation rests on and
       is available even where the identity GRAPH cannot be acquired — the
       graph needs an active backend fetch that the profile capability gates
       off on unauthorized activations (measured live:
       profile-not-authorized), which left this whole chain reporting
       'graph-unavailable' for entire sessions. Graph diagnostics remain the
       fallback for runtimes that predate the proof surface and for the rare
       state where branch flows hold a current graph while the index proof
       is momentarily unavailable. */
    try {
      if (typeof rt?.getCompleteIndexIdentityProof === 'function') {
        const proof = rt.getCompleteIndexIdentityProof(ids);
        if (proof?.available === true) return proof;
        const graph = rt?.getGraphIdentityDiagnostics?.(ids) || null;
        return graph?.available === true ? graph : proof;
      }
    } catch {}
    try { return rt?.getGraphIdentityDiagnostics?.(ids) || null; } catch { return null; }
  }

  function getRenderedPageBoundaryCapability(pageNum = 0) {
    const num = Math.max(1, Number(pageNum || 0) || 0);
    const authority = readRenderedBoundaryAuthority(num);
    const base = {
      pageNum: num,
      pageStartOrder: authority?.pageStartOrder || (((num - 1) * TITLE_LIST_PAGE_SIZE) + 1),
      isThreadStart: num === 1,
      chatId: authority?.chatId || '',
      routeKey: authority?.routeKey || '',
      generation: authority?.generation || 0,
      effectiveFingerprint: authority?.effectiveFingerprint || '',
      qId: authority?.qId || '',
      primaryAId: authority?.primaryAId || '',
    };
    const fail = (reason, extra = {}) => frozenRenderedPageBoundaryCapability({
      ...base,
      supported: false,
      reason,
      boundaryIdentityCurrent: false,
      leaseCurrent: false,
      ...extra,
    });
    if (!authority?.ok) {
      S.renderedPageBoundaryLeases.delete(num);
      return fail(authority?.reason || 'authority-unavailable');
    }
    const rt = TURN_RUNTIME();
    let graph = null;
    try {
      // typeof-guarded: validator sandboxes evaluate extracted slices that
      // may not carry the proof helper.
      graph = (typeof renderedBoundaryIdentityProof === 'function')
        ? renderedBoundaryIdentityProof(rt, [authority.qId, authority.primaryAId].filter(Boolean))
        : (rt?.getGraphIdentityDiagnostics?.([authority.qId, authority.primaryAId].filter(Boolean)) || null);
    } catch {}
    if (!graph?.available) {
      S.renderedPageBoundaryLeases.delete(num);
      return fail(
        graph?.reason === 'graph-stale'
          ? 'graph-stale'
          : (graph?.reason === 'authority-unavailable'
            ? 'authority-unavailable'
            : 'graph-unavailable'),
        { graphFingerprint: graph?.scope?.fingerprint || '' },
      );
    }
    const graphFingerprint = String(graph?.scope?.fingerprint || '');
    base.graphFingerprint = graphFingerprint;
    if (
      String(graph?.scope?.chatId || '') !== authority.chatId
      || String(graph?.scope?.routeKey || '') !== authority.routeKey
      || Math.max(0, Number(graph?.scope?.generation || 0) || 0) !== authority.generation
      || !graphFingerprint
    ) {
      S.renderedPageBoundaryLeases.delete(num);
      return fail('graph-stale');
    }
    const graphQ = graph.records?.find((record) => (
      record?.requestedId === authority.qId
    )) || null;
    if (graphQ?.found !== true || graphQ?.productUser !== true) {
      S.renderedPageBoundaryLeases.delete(num);
      return fail('rendered-boundary-head-unproven');
    }
    if (renderedBoundaryTransitionActive(authority.projection)) {
      S.renderedPageBoundaryLeases.delete(num);
      return fail('boundary-scope-changed');
    }
    if (renderedBoundaryRecordStreaming(authority.record)) {
      S.renderedPageBoundaryLeases.delete(num);
      return fail('streaming-active');
    }

    let lease = S.renderedPageBoundaryLeases.get(num) || null;
    if (lease && !renderedBoundaryLeaseScopeCurrent(lease, authority, graphFingerprint)) {
      S.renderedPageBoundaryLeases.delete(num);
      return fail('boundary-scope-changed');
    }
    const currentDivider = renderedBoundaryThreadDivider(num);
    const currentStartSentinel = renderedBoundaryStartSentinel(num);
    if (!lease && !currentDivider) return fail('divider-unavailable');
    if (!lease && !currentStartSentinel) {
      return fail('sentinel-unavailable', {
        dividerConnected: currentDivider?.isConnected === true,
      });
    }
    const flowRoot = (lease?.flowRoot?.isConnected === true ? lease.flowRoot : null)
      || currentDivider?.parentElement
      || null;
    let activeThread = null;
    try { activeThread = document.querySelector?.('#thread') || null; } catch {}
    if (
      !flowRoot
      || flowRoot?.isConnected !== true
      || activeThread?.isConnected !== true
      || !activeThread.contains?.(flowRoot)
      || (!lease && (
        flowRoot !== currentStartSentinel?.parentElement
        || currentDivider?.parentElement !== flowRoot
      ))
    ) {
      if (lease) S.renderedPageBoundaryLeases.delete(num);
      return fail(lease ? 'captured-wrapper-replaced' : 'flow-root-unavailable', {
        flowRootConnected: flowRoot?.isConnected === true,
        dividerConnected: currentDivider?.isConnected === true,
        startSentinelConnected: currentStartSentinel?.isConnected === true,
      });
    }

    const boundarySurface = resolveRenderedTurnSurfaceByIdentity(authority.qId, flowRoot);
    if (boundarySurface.reason === 'identity-ambiguous') {
      S.renderedPageBoundaryLeases.delete(num);
      return fail('boundary-section-ambiguous', {
        flowRootConnected: true,
        dividerConnected: currentDivider?.isConnected === true,
        startSentinelConnected: currentStartSentinel?.isConnected === true,
      });
    }
    if (boundarySurface.reason === 'identity-unmounted') {
      if (!lease) {
        const coldBoundary = resolveColdRenderedBoundaryWrapper(flowRoot, authority.qId);
        if (coldBoundary.reason === 'identity-ambiguous') {
          return fail('boundary-section-ambiguous', {
            flowRootConnected: true,
            dividerConnected: currentDivider?.isConnected === true,
            startSentinelConnected: currentStartSentinel?.isConnected === true,
          });
        }
        if (!coldBoundary.ok) {
          return fail('rendered-boundary-head-unproven', {
            flowRootConnected: true,
            dividerConnected: currentDivider?.isConnected === true,
            startSentinelConnected: currentStartSentinel?.isConnected === true,
          });
        }
        const coldWrapper = coldBoundary.wrapper;
        let currentAuthority = null;
        let currentGraph = null;
        try {
          currentAuthority = readRenderedBoundaryAuthority(num);
          currentGraph = (typeof renderedBoundaryIdentityProof === 'function')
          ? renderedBoundaryIdentityProof(rt, [authority.qId])
          : (rt.getGraphIdentityDiagnostics?.([authority.qId]) || null);
        } catch {}
        const currentGraphFingerprint = String(currentGraph?.scope?.fingerprint || '');
        const currentGraphQ = currentGraph?.records?.find((record) => (
          record?.requestedId === authority.qId
        )) || null;
        if (
          !currentAuthority?.ok
          || currentAuthority.statusIdentity !== authority.statusIdentity
          || currentAuthority.qId !== authority.qId
          || currentAuthority.primaryAId !== authority.primaryAId
          || renderedBoundaryTransitionActive(currentAuthority.projection)
        ) return fail('boundary-scope-changed');
        if (renderedBoundaryRecordStreaming(currentAuthority.record)) {
          return fail('streaming-active');
        }
        if (
          currentGraph?.available !== true
          || String(currentGraph?.scope?.chatId || '') !== authority.chatId
          || String(currentGraph?.scope?.routeKey || '') !== authority.routeKey
          || Math.max(0, Number(currentGraph?.scope?.generation || 0) || 0) !== authority.generation
          || currentGraphFingerprint !== graphFingerprint
        ) return fail('graph-stale');
        if (currentGraphQ?.found !== true || currentGraphQ?.productUser !== true) {
          return fail('rendered-boundary-head-unproven');
        }
        if (
          coldWrapper?.isConnected !== true
          || coldWrapper?.parentElement !== flowRoot
          || !renderedBoundaryWrapperCarriesIdentity(coldWrapper, authority.qId)
          || renderedBoundaryColdWrapperH2OOwned(coldWrapper)
        ) {
          return fail('rendered-boundary-head-unproven', {
            flowRootConnected: true,
            boundaryWrapperConnected: coldWrapper?.isConnected === true,
            dividerConnected: currentDivider?.isConnected === true,
            startSentinelConnected: currentStartSentinel?.isConnected === true,
          });
        }
        const coldLease = Object.freeze({
          pageNum: num,
          pageStartOrder: authority.pageStartOrder,
          chatId: authority.chatId,
          routeKey: authority.routeKey,
          generation: authority.generation,
          effectiveFingerprint: authority.effectiveFingerprint,
          graphFingerprint,
          qId: authority.qId,
          primaryAId: authority.primaryAId,
          flowRoot,
          boundaryWrapper: coldWrapper,
        });
        S.renderedPageBoundaryLeases.set(num, coldLease);
        const placement = renderedBoundaryPageUnitPlacement(flowRoot, coldWrapper, num);
        return frozenRenderedPageBoundaryCapability({
          ...base,
          supported: true,
          reason: null,
          source: 'exact-graph-backed-product-qid-wrapper',
          boundaryIdentityCurrent: true,
          flowRootConnected: true,
          boundarySectionMounted: false,
          boundaryWrapperConnected: true,
          boundaryDirectFlowIndex: placement.boundaryIndex,
          dividerConnected: placement.dividerConnected,
          dividerBeforeBoundary: placement.dividerBeforeBoundary,
          startSentinelConnected: placement.startSentinelConnected,
          startSentinelBeforeBoundary: placement.startSentinelBeforeBoundary,
          interveningNonH2ONodeCount: placement.interveningNonH2ONodeCount,
          pageUnitOrderCurrent: placement.pageUnitOrderCurrent,
          pageUnitOrderReason: placement.pageUnitOrderReason,
          placementRepairRequired: !placement.pageUnitOrderCurrent,
          leaseCurrent: true,
        });
      }
      const leaseBindingCurrent = lease.flowRoot === flowRoot
        && lease.boundaryWrapper?.isConnected === true
        && lease.boundaryWrapper?.parentElement === flowRoot
        && renderedBoundaryWrapperCarriesIdentity(lease.boundaryWrapper, authority.qId);
      if (!leaseBindingCurrent) {
        // Element references are ephemeral by measured host contract: a
        // replaced wrapper (or flow root) is the normal rematerialization
        // case, not a scope change. The lease is keyed by identity — the
        // proven qId — so re-resolve the binding and refresh the lease;
        // only an identity that cannot be re-proven fails.
        const rebound = (typeof resolveColdRenderedBoundaryWrapper === 'function')
          ? resolveColdRenderedBoundaryWrapper(flowRoot, authority.qId)
          : { ok: false, reason: 'resolver-unavailable' };
        if (rebound.reason === 'identity-ambiguous') {
          S.renderedPageBoundaryLeases.delete(num);
          return fail('boundary-section-ambiguous', {
            flowRootConnected: true,
            dividerConnected: currentDivider?.isConnected === true,
            startSentinelConnected: currentStartSentinel?.isConnected === true,
          });
        }
        const reboundOwned = (typeof renderedBoundaryColdWrapperH2OOwned === 'function')
          ? renderedBoundaryColdWrapperH2OOwned(rebound.wrapper)
          : false;
        if (
          !rebound.ok
          || rebound.wrapper?.isConnected !== true
          || rebound.wrapper?.parentElement !== flowRoot
          || !renderedBoundaryWrapperCarriesIdentity(rebound.wrapper, authority.qId)
          || reboundOwned
        ) {
          S.renderedPageBoundaryLeases.delete(num);
          return fail('captured-wrapper-replaced', {
            flowRootConnected: true,
            boundaryWrapperConnected: lease.boundaryWrapper?.isConnected === true,
            dividerConnected: currentDivider?.isConnected === true,
            startSentinelConnected: currentStartSentinel?.isConnected === true,
          });
        }
        lease = Object.freeze({ ...lease, flowRoot, boundaryWrapper: rebound.wrapper });
        S.renderedPageBoundaryLeases.set(num, lease);
      }
      const placement = renderedBoundaryPageUnitPlacement(
        flowRoot,
        lease.boundaryWrapper,
        num,
      );
      let currentStatus = null;
      let currentGraph = null;
      try {
        currentStatus = rt.getEffectivePresentationStatus?.() || null;
        currentGraph = (typeof renderedBoundaryIdentityProof === 'function')
          ? renderedBoundaryIdentityProof(rt, [authority.qId])
          : (rt.getGraphIdentityDiagnostics?.([authority.qId]) || null);
      } catch {}
      if (
        renderedBoundaryStatusIdentity(currentStatus) !== authority.statusIdentity
        || String(currentGraph?.scope?.fingerprint || '') !== graphFingerprint
      ) {
        S.renderedPageBoundaryLeases.delete(num);
        return fail('boundary-scope-changed');
      }
      return frozenRenderedPageBoundaryCapability({
        ...base,
        supported: true,
        reason: null,
        source: 'same-generation-captured-wrapper',
        boundaryIdentityCurrent: true,
        flowRootConnected: true,
        boundarySectionMounted: false,
        boundaryWrapperConnected: true,
        boundaryDirectFlowIndex: placement.boundaryIndex,
        dividerConnected: placement.dividerConnected,
        dividerBeforeBoundary: placement.dividerBeforeBoundary,
        startSentinelConnected: placement.startSentinelConnected,
        startSentinelBeforeBoundary: placement.startSentinelBeforeBoundary,
        interveningNonH2ONodeCount: placement.interveningNonH2ONodeCount,
        pageUnitOrderCurrent: placement.pageUnitOrderCurrent,
        pageUnitOrderReason: placement.pageUnitOrderReason,
        placementRepairRequired: !placement.pageUnitOrderCurrent,
        leaseCurrent: true,
      });
    }

    if (!boundarySurface.ok) {
      S.renderedPageBoundaryLeases.delete(num);
      return fail(lease ? 'captured-wrapper-replaced' : 'boundary-wrapper-unavailable', {
        flowRootConnected: true,
        boundarySectionMounted: true,
        dividerConnected: currentDivider?.isConnected === true,
        startSentinelConnected: currentStartSentinel?.isConnected === true,
      });
    }
    const boundaryDomRole = boundarySurface.renderedRole;
    if (boundaryDomRole !== 'user') {
      S.renderedPageBoundaryLeases.delete(num);
      return fail('rendered-boundary-head-unproven', {
        flowRootConnected: true,
        boundarySectionMounted: true,
        boundaryDomRole,
        dividerConnected: currentDivider?.isConnected === true,
        startSentinelConnected: currentStartSentinel?.isConnected === true,
      });
    }
    const boundaryWrapper = boundarySurface.directFlowWrapper;
    if (lease && (
      lease.flowRoot !== flowRoot
      || lease.boundaryWrapper !== boundaryWrapper
    )) {
      // The wrapper was just re-proven for the SAME identity on a fresh
      // element — the normal rematerialization case under the measured host
      // contract. Refresh the identity-keyed lease binding in place instead
      // of failing the capability over reference inequality.
      lease = Object.freeze({ ...lease, flowRoot, boundaryWrapper });
      S.renderedPageBoundaryLeases.set(num, lease);
    }
    const placement = renderedBoundaryPageUnitPlacement(flowRoot, boundaryWrapper, num);

    let primaryAnswerSurface = null;
    let primaryAnswerDomRole = '';
    let primaryAnswerWrapper = null;
    const answerSurface = resolveRenderedTurnSurfaceByIdentity(authority.primaryAId, flowRoot);
    if (answerSurface.reason === 'identity-ambiguous') {
      S.renderedPageBoundaryLeases.delete(num);
      return fail('boundary-section-ambiguous');
    }
    if (answerSurface.ok) {
      primaryAnswerSurface = answerSurface;
      primaryAnswerDomRole = answerSurface.renderedRole;
      primaryAnswerWrapper = answerSurface.directFlowWrapper;
      const answerIndex = Array.from(flowRoot.children || []).indexOf(primaryAnswerWrapper);
      if (
        primaryAnswerDomRole !== 'assistant'
        || !primaryAnswerWrapper
        || answerIndex <= placement.boundaryIndex
      ) {
        S.renderedPageBoundaryLeases.delete(num);
        return fail('boundary-order-invalid');
      }
    } else if (answerSurface.reason !== 'identity-unmounted') {
      S.renderedPageBoundaryLeases.delete(num);
      return fail('boundary-order-invalid');
    }

    let finalStatus = null;
    let finalGraph = null;
    try {
      finalStatus = rt.getEffectivePresentationStatus?.() || null;
      finalGraph = (typeof renderedBoundaryIdentityProof === 'function')
        ? renderedBoundaryIdentityProof(rt, [authority.qId])
        : (rt.getGraphIdentityDiagnostics?.([authority.qId]) || null);
    } catch {}
    if (
      renderedBoundaryStatusIdentity(finalStatus) !== authority.statusIdentity
      || String(finalGraph?.scope?.fingerprint || '') !== graphFingerprint
    ) {
      S.renderedPageBoundaryLeases.delete(num);
      return fail('boundary-scope-changed');
    }
    if (!lease) {
      S.renderedPageBoundaryLeases.set(num, Object.freeze({
        pageNum: num,
        pageStartOrder: authority.pageStartOrder,
        chatId: authority.chatId,
        routeKey: authority.routeKey,
        generation: authority.generation,
        effectiveFingerprint: authority.effectiveFingerprint,
        graphFingerprint,
        qId: authority.qId,
        primaryAId: authority.primaryAId,
        flowRoot,
        boundaryWrapper,
      }));
    }
    return frozenRenderedPageBoundaryCapability({
      ...base,
      supported: true,
      reason: null,
      source: 'exact-mounted-product-qid',
      boundaryIdentityCurrent: true,
      flowRootConnected: true,
      boundarySectionMounted: true,
      boundaryWrapperConnected: true,
      boundaryDomRole,
      boundaryTestId: boundarySurface.testId,
      boundaryDirectFlowIndex: placement.boundaryIndex,
      primaryAnswerMounted: !!primaryAnswerSurface,
      primaryAnswerDomRole,
      primaryAnswerTestId: primaryAnswerSurface?.testId || '',
      primaryAnswerDirectFlowIndex: primaryAnswerWrapper
        ? Array.from(flowRoot.children || []).indexOf(primaryAnswerWrapper)
        : -1,
      dividerConnected: placement.dividerConnected,
      dividerBeforeBoundary: placement.dividerBeforeBoundary,
      startSentinelConnected: placement.startSentinelConnected,
      startSentinelBeforeBoundary: placement.startSentinelBeforeBoundary,
      interveningNonH2ONodeCount: placement.interveningNonH2ONodeCount,
      pageUnitOrderCurrent: placement.pageUnitOrderCurrent,
      pageUnitOrderReason: placement.pageUnitOrderReason,
      placementRepairRequired: !placement.pageUnitOrderCurrent,
      leaseCurrent: true,
    });
  }

  function frozenPageCollapseRangeDiagnostics(raw = {}) {
    const firstAmbiguous = raw.firstAmbiguous && typeof raw.firstAmbiguous === 'object'
      ? Object.freeze({
        index: Number.isInteger(raw.firstAmbiguous.index) ? raw.firstAmbiguous.index : -1,
        tag: String(raw.firstAmbiguous.tag || ''),
        hasTurnIdContainer: raw.firstAmbiguous.hasTurnIdContainer === true,
        containsMountedIdentity: raw.firstAmbiguous.containsMountedIdentity === true,
        containsNativeTestHost: raw.firstAmbiguous.containsNativeTestHost === true,
        hasRetainedHeightStyle: raw.firstAmbiguous.hasRetainedHeightStyle === true,
        graphIdentityFound: raw.firstAmbiguous.graphIdentityFound === true,
      })
      : null;
    const signals = Object.freeze({
      graphIdentity: Math.max(0, Number(raw.classifierSignals?.graphIdentity || 0) || 0),
      mountedIdentity: Math.max(0, Number(raw.classifierSignals?.mountedIdentity || 0) || 0),
      nativeTestHost: Math.max(0, Number(raw.classifierSignals?.nativeTestHost || 0) || 0),
      retainedHeightContinuity: Math.max(
        0,
        Number(raw.classifierSignals?.retainedHeightContinuity || 0) || 0,
      ),
    });
    return Object.freeze({
      version: 1,
      supported: raw.supported === true,
      reason: raw.reason == null ? null : String(raw.reason || ''),
      pageNum: Math.max(1, Number(raw.pageNum || 0) || 0),
      pageStartOrder: Math.max(1, Number(raw.pageStartOrder || 0) || 0),
      pageEndOrder: Math.max(1, Number(raw.pageEndOrder || 0) || 0),
      chatId: String(raw.chatId || '') || null,
      routeKey: String(raw.routeKey || ''),
      generation: Math.max(0, Number(raw.generation || 0) || 0),
      effectiveFingerprint: String(raw.effectiveFingerprint || '') || null,
      graphFingerprint: String(raw.graphFingerprint || '') || null,
      startBoundarySupported: raw.startBoundarySupported === true,
      nextBoundarySupported: raw.nextBoundarySupported === true,
      startQId: String(raw.startQId || '') || null,
      nextBoundaryQId: String(raw.nextBoundaryQId || '') || null,
      startWrapperCurrent: raw.startWrapperCurrent === true,
      endWrapperCurrent: raw.endWrapperCurrent === true,
      finalTailSupported: raw.finalTailSupported === true,
      terminalIdentityCurrent: raw.terminalIdentityCurrent === true,
      terminalWrapperCurrent: raw.terminalWrapperCurrent === true,
      pageEndSentinelCurrent: raw.pageEndSentinelCurrent === true,
      rangeStartIndex: Number.isInteger(raw.rangeStartIndex) ? raw.rangeStartIndex : -1,
      rangeEndIndex: Number.isInteger(raw.rangeEndIndex) ? raw.rangeEndIndex : -1,
      hostWrapperCount: Math.max(0, Number(raw.hostWrapperCount || 0) || 0),
      h2oNodeCount: Math.max(0, Number(raw.h2oNodeCount || 0) || 0),
      ambiguousWrapperCount: Math.max(0, Number(raw.ambiguousWrapperCount || 0) || 0),
      firstAmbiguousIndex: Number.isInteger(raw.firstAmbiguousIndex)
        ? raw.firstAmbiguousIndex
        : -1,
      firstAmbiguous,
      classifierSignals: signals,
      pageUnitOrderCurrent: raw.pageUnitOrderCurrent === true,
      streaming: raw.streaming === true,
      branchTransition: raw.branchTransition === true,
      rangeProven: raw.rangeProven === true,
      isFinalPage: raw.isFinalPage === true,
    });
  }

  function pageCollapseRangeH2OOwned(node = null) {
    if (!node || node.nodeType !== 1) return false;
    try {
      return node.matches?.(
        '.cgxui-chat-page-divider, .cgxui-pgnw-page-divider,'
        + ' [data-cgxui="chat-page-title-list-synth"],'
        + ' [data-h2o-chat-page-boundary], #cgx-mm-root,'
        + ' [data-cgxui-owner="mnmp"], [data-h2o-title-list-segment="suffix"]'
      ) === true;
    } catch {
      return false;
    }
  }

  function pageCollapseRangeIdentityCarriers(node = null) {
    const carriers = [];
    if (!node || node.nodeType !== 1) return carriers;
    try {
      if (node.matches?.('section[data-turn-id]')) carriers.push(node);
      for (const carrier of Array.from(node.querySelectorAll?.('section[data-turn-id]') || [])) {
        if (!carriers.includes(carrier)) carriers.push(carrier);
      }
    } catch {}
    return carriers.filter((carrier) => carrier?.isConnected === true);
  }

  function pageCollapseRangeIdentityOfCarrier(carrier = null) {
    // Message ids are the product identity domain (stable across
    // rematerialization, provable against the complete-index authority);
    // section data-turn-id carries the branch NODE id and stays only as the
    // fallback for unhydrated shells, whose sections expose no message id.
    try {
      const messageNode = carrier?.querySelector?.('[data-message-id]');
      const messageId = String(messageNode?.getAttribute?.('data-message-id') || '').trim();
      if (messageId) return messageId;
    } catch {}
    return String(carrier?.getAttribute?.('data-turn-id') || '').trim();
  }

  function pageCollapseRangeContainerIdentity(node = null) {
    return String(node?.getAttribute?.('data-turn-id-container') || '').trim();
  }

  /* Is a COMMITTED member wrapper still the same host turn container?
     Two host-provided identity domains answer this, and the live one depends
     purely on hydration state:
       - the inner message identity, present while the turn is hydrated;
       - the wrapper's own data-turn-id-container, present in both states and
         measured stable across the host virtualizing the content away.
     Accepting either is what keeps a committed collapse provable when the
     host unhydrates a hidden range (measured: wrapper still connected, still
     a direct child, still carrying our hidden stamp, but carrierCount 0 - the
     message identity simply has no carrier to live on). Neither domain is a
     positional guess, so this proves membership exactly as strictly as before;
     it only stops mistaking "content virtualized" for "different turn". */
  function pageCollapseMemberIdentityCurrent(node = null, proof = null) {
    if (!node || !proof) return false;
    const identity = String(proof.identity || '').trim();
    if (identity && pageCollapseRangeNodeCarriesIdentity(node, identity)) return true;
    const containerId = String(proof.containerId || '').trim();
    if (!containerId) return false;
    return pageCollapseRangeContainerIdentity(node) === containerId;
  }

  function pageCollapseRangeNodeCarriesIdentity(node = null, identity = '') {
    const id = String(identity || '').trim();
    if (!node || !id) return false;
    if (pageCollapseRangeContainerIdentity(node) === id) return true;
    return pageCollapseRangeIdentityCarriers(node).some((carrier) => (
      pageCollapseRangeIdentityOfCarrier(carrier) === id
      || String(carrier?.getAttribute?.('data-turn-id') || '').trim() === id
    ));
  }

  function pageCollapseRangeHasRetainedHeight(node = null) {
    if (!node) return false;
    let value = '';
    try { value = String(node.style?.getPropertyValue?.('--last-known-height') || '').trim(); } catch {}
    if (value) return true;
    try {
      const computed = typeof W.getComputedStyle === 'function'
        ? W.getComputedStyle(node)
        : null;
      value = String(computed?.getPropertyValue?.('--last-known-height') || '').trim();
    } catch {}
    return !!value;
  }

  function pageCollapseRangeScopeCurrent(entry = null, authority = null, graphFingerprint = '', flowRoot = null) {
    return !!entry
      && entry.chatId === authority?.chatId
      && entry.routeKey === authority?.routeKey
      && entry.generation === authority?.generation
      && entry.effectiveFingerprint === authority?.effectiveFingerprint
      && entry.graphFingerprint === graphFingerprint
      && entry.pageNum === authority?.pageNum
      && entry.flowRoot === flowRoot;
  }

  function clearStalePageCollapseRangeContinuity(
    authority = null,
    graphFingerprint = '',
    flowRoot = null,
  ) {
    for (const [pageNum, entry] of Array.from(S.pageCollapseRangeContinuity.entries())) {
      if (!pageCollapseRangeScopeCurrent(entry, authority, graphFingerprint, flowRoot)) {
        S.pageCollapseRangeContinuity.delete(pageNum);
      }
    }
  }

  function readPageCollapseRangeGraphRecords(rt = null, identities = [], authority = null) {
    const ids = [];
    const seen = new Set();
    for (const raw of Array.isArray(identities) ? identities : []) {
      const id = String(raw || '').trim();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      ids.push(id);
    }
    const records = new Map();
    let fingerprint = '';
    if (!ids.length) return { ok: true, reason: null, fingerprint, records };
    for (let offset = 0; offset < ids.length; offset += 32) {
      const batch = ids.slice(offset, offset + 32);
      let graph = null;
      try {
        graph = (typeof renderedBoundaryIdentityProof === 'function')
          ? renderedBoundaryIdentityProof(rt, batch)
          : (rt?.getGraphIdentityDiagnostics?.(batch) || null);
      } catch {}
      if (!graph?.available) {
        return {
          ok: false,
          reason: graph?.reason === 'graph-stale' ? 'graph-stale' : 'graph-unavailable',
          fingerprint: String(graph?.scope?.fingerprint || ''),
          records,
        };
      }
      const batchFingerprint = String(graph?.scope?.fingerprint || '');
      if (
        String(graph?.scope?.chatId || '') !== authority?.chatId
        || String(graph?.scope?.routeKey || '') !== authority?.routeKey
        || Math.max(0, Number(graph?.scope?.generation || 0) || 0) !== authority?.generation
        || !batchFingerprint
        || (fingerprint && batchFingerprint !== fingerprint)
      ) {
        return { ok: false, reason: 'graph-stale', fingerprint: batchFingerprint, records };
      }
      fingerprint = batchFingerprint;
      for (const record of Array.isArray(graph.records) ? graph.records : []) {
        const requestedId = String(record?.requestedId || '').trim();
        if (requestedId && batch.includes(requestedId)) records.set(requestedId, record);
      }
    }
    return { ok: true, reason: null, fingerprint, records };
  }

  // ── Final-page tail authority ─────────────────────────────────────────────
  // A final page has no next-page start boundary, so its exclusive end is the
  // H2O page-end sentinel. The sentinel is never trusted on its own: it is a
  // structural delimiter accepted only after it has been cross-proven against
  // the exact terminal canonical identity of the page's last authoritative row.
  function renderedBoundaryPageEndSentinel(pageNum = 0) {
    const num = Math.max(1, Number(pageNum || 0) || 0);
    let sentinels = [];
    try {
      sentinels = Array.from(document.querySelectorAll(
        `[${RENDERED_BOUNDARY_SENTINEL_ATTR}="page-${String(num)}-end"]`
      )).filter((sentinel) => (
        sentinel?.isConnected === true
        && String(sentinel.getAttribute?.(RENDERED_BOUNDARY_SENTINEL_PAGE_ATTR) || '') === String(num)
        && String(sentinel.getAttribute?.(RENDERED_BOUNDARY_SENTINEL_KIND_ATTR) || '') === 'end'
      ));
    } catch {}
    return sentinels.length === 1 ? sentinels[0] : null;
  }

  // The terminal row is the authoritative row at pageEndOrder — never the last
  // mounted row, the highest test id, or the last flow child. Its terminal
  // identity is the accepted primary answer when the row has one, and the
  // question identity for NO ANSWER / stopped-without-answer rows.
  function readFinalPageTerminalRecord(pageEndOrder = 0, authority = null) {
    const order = Math.max(1, Number(pageEndOrder || 0) || 0);
    const rt = TURN_RUNTIME();
    if (!rt || typeof rt.getEffectivePresentationIndex !== 'function') {
      return { ok: false, reason: 'authority-unavailable' };
    }
    let index = null;
    try { index = rt.getEffectivePresentationIndex() || null; } catch {}
    const turns = Array.isArray(index?.turns) ? index.turns : [];
    if (
      index?.complete !== true
      || String(index?.sourceFingerprint || '') !== String(authority?.effectiveFingerprint || '')
      || turns.length !== Math.max(0, Number(authority?.count || 0) || 0)
      || order > turns.length
    ) return { ok: false, reason: 'authority-unavailable' };
    const record = turns[order - 1] || null;
    if (
      !record
      || Math.max(0, Number(record.order || record.turnNo || 0) || 0) !== order
    ) return { ok: false, reason: 'authority-unavailable' };
    const primaryAId = String(record.primaryAId || '').trim();
    const qId = String(record.qId || '').trim();
    const terminalId = primaryAId || qId;
    if (!terminalId) return { ok: false, reason: 'final-page-tail-unproven' };
    return {
      ok: true,
      reason: null,
      terminalOrder: order,
      terminalId,
      terminalKind: primaryAId ? 'answer' : 'question',
    };
  }

  // Resolve the one direct-flow wrapper carrying the exact terminal identity,
  // through the same accepted sources as the start boundary: an exact mounted
  // identity surface, or an exact graph-backed direct-flow identity wrapper.
  function resolveFinalPageTerminalWrapper(flowRoot = null, terminalId = '') {
    const id = String(terminalId || '').trim();
    if (!flowRoot || flowRoot?.isConnected !== true || !id) {
      return { ok: false, reason: 'final-page-tail-unproven', wrapper: null };
    }
    const surface = resolveRenderedTurnSurfaceByIdentity(id, flowRoot);
    if (surface.reason === 'identity-ambiguous') {
      return { ok: false, reason: 'final-page-tail-unproven', wrapper: null };
    }
    if (surface.ok) {
      return { ok: true, reason: null, wrapper: surface.directFlowWrapper, source: 'exact-mounted-identity' };
    }
    const cold = resolveColdRenderedBoundaryWrapper(flowRoot, id);
    if (cold.ok) {
      return { ok: true, reason: null, wrapper: cold.wrapper, source: 'exact-graph-backed-wrapper' };
    }
    return { ok: false, reason: 'final-page-tail-unproven', wrapper: null };
  }

  // Full tail proof. Yields the exclusive end delimiter (the sentinel) only when
  // the terminal wrapper is current, the sentinel is H2O-owned and positioned
  // after it, and every direct sibling strictly between them is H2O-owned.
  function resolveFinalPageTailAuthority(pageNum = 0, pageEndOrder = 0, authority = null, flowRoot = null) {
    const terminal = readFinalPageTerminalRecord(pageEndOrder, authority);
    if (!terminal.ok) {
      return { ok: false, reason: terminal.reason, terminalIdentityCurrent: false };
    }
    const resolved = resolveFinalPageTerminalWrapper(flowRoot, terminal.terminalId);
    if (!resolved.ok) {
      return {
        ok: false,
        reason: resolved.reason,
        terminalIdentityCurrent: true,
        terminalWrapperCurrent: false,
      };
    }
    const terminalWrapper = resolved.wrapper;
    const endSentinel = renderedBoundaryPageEndSentinel(pageNum);
    const base = {
      terminalIdentityCurrent: true,
      terminalWrapperCurrent: true,
      terminalKind: terminal.terminalKind,
    };
    if (
      !endSentinel
      || endSentinel.isConnected !== true
      || endSentinel.parentElement !== flowRoot
      || !pageCollapseRangeH2OOwned(endSentinel)
    ) {
      return { ok: false, reason: 'final-page-tail-unproven', ...base, pageEndSentinelCurrent: false };
    }
    if (
      terminalWrapper?.isConnected !== true
      || terminalWrapper?.parentElement !== flowRoot
    ) {
      return {
        ok: false,
        reason: 'final-page-tail-unproven',
        ...base,
        terminalWrapperCurrent: false,
        pageEndSentinelCurrent: true,
      };
    }
    const children = Array.from(flowRoot.children || []);
    const terminalIndex = children.indexOf(terminalWrapper);
    const sentinelIndex = children.indexOf(endSentinel);
    if (terminalIndex < 0 || sentinelIndex < 0 || sentinelIndex <= terminalIndex) {
      return { ok: false, reason: 'final-page-tail-unproven', ...base, pageEndSentinelCurrent: true };
    }
    // Everything strictly between the terminal wrapper and the sentinel must be
    // H2O-owned. A host-rendered or unclassifiable node there means the tail is
    // not proven: fail closed rather than extend the range or move the sentinel.
    for (let index = terminalIndex + 1; index < sentinelIndex; index += 1) {
      if (!pageCollapseRangeH2OOwned(children[index])) {
        return { ok: false, reason: 'final-page-tail-unproven', ...base, pageEndSentinelCurrent: true };
      }
    }
    return {
      ok: true,
      reason: null,
      ...base,
      pageEndSentinelCurrent: true,
      endExclusive: endSentinel,
    };
  }

  function buildPageCollapseRangePlan(pageNum = 0, options = {}) {
    const num = Math.max(1, Number(pageNum || 0) || 0);
    const includeDom = options?.includeDom === true;
    const finish = (diagnostic, privatePlan = null) => (
      includeDom
        ? {
          ok: diagnostic?.supported === true,
          diagnostic,
          ...(privatePlan || {}),
        }
        : diagnostic
    );
    const authority = readRenderedBoundaryAuthority(num);
    const pageStartOrder = authority?.pageStartOrder
      || (((num - 1) * TITLE_LIST_PAGE_SIZE) + 1);
    const count = Math.max(0, Number(authority?.count || 0) || 0);
    const pageEndOrder = Math.min(count || pageStartOrder, num * TITLE_LIST_PAGE_SIZE);
    const base = {
      pageNum: num,
      pageStartOrder,
      pageEndOrder,
      chatId: authority?.chatId || '',
      routeKey: authority?.routeKey || '',
      generation: authority?.generation || 0,
      effectiveFingerprint: authority?.effectiveFingerprint || '',
      startQId: authority?.qId || '',
      isFinalPage: count > 0 && pageEndOrder >= count,
    };
    const fail = (reason, extra = {}) => finish(
      frozenPageCollapseRangeDiagnostics({
        ...base,
        supported: false,
        reason,
        rangeProven: false,
        ...extra,
      })
    );
    if (!authority?.ok) {
      S.pageCollapseRangeContinuity.clear();
      return fail(authority?.reason || 'authority-unavailable');
    }
    const branchTransition = renderedBoundaryTransitionActive(authority.projection);
    const streaming = renderedBoundaryRecordStreaming(authority.record);
    if (branchTransition || streaming) {
      S.pageCollapseRangeContinuity.clear();
      return fail(branchTransition ? 'boundary-scope-changed' : 'streaming-active', {
        branchTransition,
        streaming,
      });
    }

    const startCapability = getRenderedPageBoundaryCapability(num);
    base.graphFingerprint = startCapability.graphFingerprint || '';
    base.startBoundarySupported = startCapability.supported === true;
    base.pageUnitOrderCurrent = startCapability.pageUnitOrderCurrent === true;
    // A final page has no next-page start boundary. Its exclusive end comes
    // from the proven page-end sentinel instead, and the shared direct-flow
    // classifier below then runs over the identical kind of interval.
    if (base.isFinalPage) {
      if (
        startCapability.supported !== true
        || startCapability.boundaryIdentityCurrent !== true
        || startCapability.leaseCurrent !== true
      ) {
        S.pageCollapseRangeContinuity.delete(num);
        const startReason = ['graph-unavailable', 'graph-stale', 'authority-unavailable']
          .includes(String(startCapability.reason || ''))
          ? startCapability.reason
          : 'start-boundary-unavailable';
        return fail(startReason, {
          startBoundarySupported: false,
          graphFingerprint: base.graphFingerprint,
          pageUnitOrderCurrent: base.pageUnitOrderCurrent,
        });
      }
      if (!base.pageUnitOrderCurrent) {
        S.pageCollapseRangeContinuity.delete(num);
        return fail('page-unit-order-invalid', {
          startBoundarySupported: true,
          graphFingerprint: base.graphFingerprint,
          pageUnitOrderCurrent: false,
        });
      }
      const finalGraphFingerprint = String(startCapability.graphFingerprint || '');
      base.graphFingerprint = finalGraphFingerprint;
      const finalStartLease = S.renderedPageBoundaryLeases.get(num) || null;
      if (!renderedBoundaryLeaseScopeCurrent(finalStartLease, authority, finalGraphFingerprint)) {
        S.pageCollapseRangeContinuity.delete(num);
        return fail('start-boundary-unavailable', {
          startBoundarySupported: true,
          graphFingerprint: finalGraphFingerprint,
          pageUnitOrderCurrent: true,
        });
      }
      const finalFlowRoot = finalStartLease.flowRoot;
      const finalStartWrapper = finalStartLease.boundaryWrapper;
      if (!(
        finalFlowRoot?.isConnected === true
        && finalStartWrapper?.isConnected === true
        && finalStartWrapper?.parentElement === finalFlowRoot
        && renderedBoundaryWrapperCarriesIdentity(finalStartWrapper, authority.qId)
      )) {
        S.pageCollapseRangeContinuity.delete(num);
        return fail('range-flow-root-incoherent', {
          startBoundarySupported: true,
          graphFingerprint: finalGraphFingerprint,
          startWrapperCurrent: false,
          pageUnitOrderCurrent: true,
        });
      }
      const tail = resolveFinalPageTailAuthority(num, base.pageEndOrder, authority, finalFlowRoot);
      if (!tail.ok) {
        S.pageCollapseRangeContinuity.delete(num);
        return fail(tail.reason || 'final-page-tail-unproven', {
          startBoundarySupported: true,
          graphFingerprint: finalGraphFingerprint,
          startWrapperCurrent: true,
          endWrapperCurrent: false,
          pageUnitOrderCurrent: true,
          finalTailSupported: false,
          terminalIdentityCurrent: tail.terminalIdentityCurrent === true,
          terminalWrapperCurrent: tail.terminalWrapperCurrent === true,
          pageEndSentinelCurrent: tail.pageEndSentinelCurrent === true,
        });
      }
      return classifyPageCollapseRange({
        num,
        base,
        finish,
        fail,
        authority,
        nextAuthority: null,
        startCapability,
        nextCapability: null,
        graphFingerprint: finalGraphFingerprint,
        flowRoot: finalFlowRoot,
        startWrapper: finalStartWrapper,
        endExclusive: tail.endExclusive,
        startWrapperCurrent: true,
        endWrapperCurrent: true,
        finalTail: tail,
      });
    }

    const nextAuthority = readRenderedBoundaryAuthority(num + 1);
    if (!nextAuthority?.ok) {
      S.pageCollapseRangeContinuity.delete(num);
      return fail('next-boundary-unavailable', {
        startBoundarySupported: base.startBoundarySupported,
        graphFingerprint: base.graphFingerprint,
      });
    }
    const nextStreaming = renderedBoundaryRecordStreaming(nextAuthority.record);
    const nextTransition = renderedBoundaryTransitionActive(nextAuthority.projection);
    if (nextStreaming || nextTransition) {
      S.pageCollapseRangeContinuity.clear();
      return fail(nextTransition ? 'boundary-scope-changed' : 'streaming-active', {
        startBoundarySupported: base.startBoundarySupported,
        graphFingerprint: base.graphFingerprint,
        nextBoundaryQId: nextAuthority.qId,
        branchTransition: nextTransition,
        streaming: nextStreaming,
      });
    }
    const nextCapability = getRenderedPageBoundaryCapability(num + 1);
    base.nextBoundaryQId = nextAuthority.qId;
    base.nextBoundarySupported = nextCapability.supported === true;
    base.pageUnitOrderCurrent = (
      startCapability.pageUnitOrderCurrent === true
      && nextCapability.pageUnitOrderCurrent === true
    );
    if (
      startCapability.supported !== true
      || startCapability.boundaryIdentityCurrent !== true
      || startCapability.leaseCurrent !== true
    ) {
      S.pageCollapseRangeContinuity.delete(num);
      const startReason = ['graph-unavailable', 'graph-stale', 'authority-unavailable']
        .includes(String(startCapability.reason || ''))
        ? startCapability.reason
        : 'start-boundary-unavailable';
      return fail(startReason, {
        startBoundarySupported: false,
        nextBoundarySupported: base.nextBoundarySupported,
        nextBoundaryQId: base.nextBoundaryQId,
        graphFingerprint: base.graphFingerprint,
        pageUnitOrderCurrent: base.pageUnitOrderCurrent,
      });
    }
    if (
      nextCapability.supported !== true
      || nextCapability.boundaryIdentityCurrent !== true
      || nextCapability.leaseCurrent !== true
    ) {
      S.pageCollapseRangeContinuity.delete(num);
      const nextReason = ['graph-unavailable', 'graph-stale', 'authority-unavailable']
        .includes(String(nextCapability.reason || ''))
        ? nextCapability.reason
        : 'next-boundary-unavailable';
      return fail(nextReason, {
        startBoundarySupported: true,
        nextBoundarySupported: false,
        nextBoundaryQId: base.nextBoundaryQId,
        graphFingerprint: base.graphFingerprint,
        pageUnitOrderCurrent: base.pageUnitOrderCurrent,
      });
    }
    if (!base.pageUnitOrderCurrent) {
      S.pageCollapseRangeContinuity.delete(num);
      return fail('page-unit-order-invalid', {
        startBoundarySupported: true,
        nextBoundarySupported: true,
        nextBoundaryQId: base.nextBoundaryQId,
        graphFingerprint: base.graphFingerprint,
        pageUnitOrderCurrent: false,
      });
    }
    if (
      authority.chatId !== nextAuthority.chatId
      || authority.routeKey !== nextAuthority.routeKey
      || authority.generation !== nextAuthority.generation
      || authority.effectiveFingerprint !== nextAuthority.effectiveFingerprint
      || startCapability.graphFingerprint !== nextCapability.graphFingerprint
    ) {
      S.pageCollapseRangeContinuity.clear();
      return fail('range-scope-changed', {
        startBoundarySupported: true,
        nextBoundarySupported: true,
        nextBoundaryQId: base.nextBoundaryQId,
        graphFingerprint: base.graphFingerprint,
        pageUnitOrderCurrent: true,
      });
    }

    const startLease = S.renderedPageBoundaryLeases.get(num) || null;
    const endLease = S.renderedPageBoundaryLeases.get(num + 1) || null;
    const graphFingerprint = String(startCapability.graphFingerprint || '');
    base.graphFingerprint = graphFingerprint;
    if (
      !renderedBoundaryLeaseScopeCurrent(startLease, authority, graphFingerprint)
      || !renderedBoundaryLeaseScopeCurrent(endLease, nextAuthority, graphFingerprint)
    ) {
      S.pageCollapseRangeContinuity.delete(num);
      return fail(!startLease ? 'start-boundary-unavailable' : 'next-boundary-unavailable', {
        startBoundarySupported: true,
        nextBoundarySupported: true,
        nextBoundaryQId: base.nextBoundaryQId,
        graphFingerprint,
        pageUnitOrderCurrent: true,
      });
    }
    const flowRoot = startLease.flowRoot;
    const startWrapper = startLease.boundaryWrapper;
    const endWrapper = endLease.boundaryWrapper;
    const startWrapperCurrent = (
      flowRoot?.isConnected === true
      && startWrapper?.isConnected === true
      && startWrapper?.parentElement === flowRoot
      && renderedBoundaryWrapperCarriesIdentity(startWrapper, authority.qId)
    );
    const endWrapperCurrent = (
      endLease.flowRoot === flowRoot
      && endWrapper?.isConnected === true
      && endWrapper?.parentElement === flowRoot
      && renderedBoundaryWrapperCarriesIdentity(endWrapper, nextAuthority.qId)
    );
    if (!startWrapperCurrent || !endWrapperCurrent) {
      S.pageCollapseRangeContinuity.delete(num);
      return fail('range-flow-root-incoherent', {
        startBoundarySupported: true,
        nextBoundarySupported: true,
        nextBoundaryQId: base.nextBoundaryQId,
        graphFingerprint,
        startWrapperCurrent,
        endWrapperCurrent,
        pageUnitOrderCurrent: true,
      });
    }

    return classifyPageCollapseRange({
      num,
      base,
      finish,
      fail,
      authority,
      nextAuthority,
      startCapability,
      nextCapability,
      graphFingerprint,
      flowRoot,
      startWrapper,
      endExclusive: endWrapper,
      startWrapperCurrent,
      endWrapperCurrent,
      finalTail: null,
    });
  }

  // One classifier for both range kinds. Non-final pages end at the next
  // page start wrapper, final pages end at their proven page-end sentinel;
  // the exclusive delimiter is never itself part of the hide set.
  function classifyPageCollapseRange(ctx = {}) {
    const {
      num, base, finish, fail, authority, nextAuthority = null,
      startCapability = null, nextCapability = null, graphFingerprint,
      flowRoot, startWrapper, endExclusive,
      startWrapperCurrent, endWrapperCurrent, finalTail = null,
    } = ctx;
    const nextSupported = base.isFinalPage !== true;
    const children = Array.from(flowRoot.children || []);
    const rangeStartIndex = children.indexOf(startWrapper);
    const rangeEndIndex = children.indexOf(endExclusive);
    if (rangeStartIndex < 0 || rangeEndIndex <= rangeStartIndex) {
      S.pageCollapseRangeContinuity.delete(num);
      return fail('range-order-invalid', {
        startBoundarySupported: true,
        nextBoundarySupported: nextSupported,
        nextBoundaryQId: base.nextBoundaryQId,
        graphFingerprint,
        startWrapperCurrent,
        endWrapperCurrent,
        rangeStartIndex,
        rangeEndIndex,
        pageUnitOrderCurrent: true,
      });
    }
    const interval = children.slice(rangeStartIndex, rangeEndIndex);
    const identities = [];
    for (const node of interval) {
      const containerId = pageCollapseRangeContainerIdentity(node);
      if (containerId) identities.push(containerId);
      for (const carrier of pageCollapseRangeIdentityCarriers(node)) {
        const id = pageCollapseRangeIdentityOfCarrier(carrier);
        if (id) identities.push(id);
      }
    }
    const rt = TURN_RUNTIME();
    const graphRead = readPageCollapseRangeGraphRecords(rt, identities, authority);
    if (!graphRead.ok) {
      S.pageCollapseRangeContinuity.delete(num);
      return fail(graphRead.reason, {
        startBoundarySupported: true,
        nextBoundarySupported: nextSupported,
        nextBoundaryQId: base.nextBoundaryQId,
        graphFingerprint: graphRead.fingerprint || graphFingerprint,
        startWrapperCurrent,
        endWrapperCurrent,
        rangeStartIndex,
        rangeEndIndex,
        pageUnitOrderCurrent: true,
      });
    }
    if (graphRead.fingerprint && graphRead.fingerprint !== graphFingerprint) {
      S.pageCollapseRangeContinuity.clear();
      return fail('graph-stale', {
        startBoundarySupported: true,
        nextBoundarySupported: nextSupported,
        nextBoundaryQId: base.nextBoundaryQId,
        graphFingerprint: graphRead.fingerprint,
        startWrapperCurrent,
        endWrapperCurrent,
        rangeStartIndex,
        rangeEndIndex,
        pageUnitOrderCurrent: true,
      });
    }

    clearStalePageCollapseRangeContinuity(authority, graphFingerprint, flowRoot);
    const prior = S.pageCollapseRangeContinuity.get(num) || null;
    const priorWrappers = pageCollapseRangeScopeCurrent(
      prior,
      authority,
      graphFingerprint,
      flowRoot,
    ) ? prior.wrappers : new Map();
    let hostWrapperCount = 0;
    let h2oNodeCount = 0;
    let ambiguousWrapperCount = 0;
    let firstAmbiguous = null;
    const classifierSignals = {
      graphIdentity: 0,
      mountedIdentity: 0,
      nativeTestHost: 0,
      retainedHeightContinuity: 0,
    };
    const provenWrappers = new Map();
    const unresolvedRangeWrappers = [];
    for (let offset = 0; offset < interval.length; offset += 1) {
      const node = interval[offset];
      const index = rangeStartIndex + offset;
      if (pageCollapseRangeH2OOwned(node)) {
        h2oNodeCount += 1;
        continue;
      }
      const containerId = pageCollapseRangeContainerIdentity(node);
      const containerRecord = containerId ? graphRead.records.get(containerId) : null;
      const carriers = pageCollapseRangeIdentityCarriers(node);
      let provenIdentity = '';
      let proofSource = '';
      if (containerId && containerRecord?.found === true) {
        provenIdentity = containerId;
        proofSource = 'graph-identity';
        classifierSignals.graphIdentity += 1;
      }
      if (!provenIdentity) {
        for (const carrier of carriers) {
          const id = pageCollapseRangeIdentityOfCarrier(carrier);
          const graphRecord = id ? graphRead.records.get(id) : null;
          if (graphRecord?.found !== true) continue;
          const surface = resolveRenderedTurnSurfaceByIdentity(id, flowRoot);
          if (
            surface?.ok === true
            && surface.directFlowWrapper === node
            && renderedBoundaryDirectChildUnder(flowRoot, surface.nativeTestHost) === node
          ) {
            provenIdentity = id;
            proofSource = 'mounted-identity';
            classifierSignals.mountedIdentity += 1;
            classifierSignals.nativeTestHost += 1;
            break;
          }
        }
      }
      if (!provenIdentity) {
        const continuity = priorWrappers?.get?.(node) || null;
        if (
          continuity
          && node?.isConnected === true
          && node?.parentElement === flowRoot
          && pageCollapseRangeNodeCarriesIdentity(node, continuity.identity)
        ) {
          provenIdentity = continuity.identity;
          proofSource = 'same-generation-continuity';
          classifierSignals.retainedHeightContinuity += 1;
        }
      }
      if (provenIdentity) {
        hostWrapperCount += 1;
        provenWrappers.set(node, Object.freeze({
          identity: provenIdentity,
          // The wrapper's OWN host container id, captured beside the proof.
          // Measured: it is present while the turn is hydrated and survives
          // the host virtualizing the content away unchanged (6/6), while the
          // inner message identity disappears with the content. Recording both
          // domains is what lets a committed member stay provable through
          // unhydration - see pageCollapseMemberIdentityCurrent.
          containerId,
          proofSource,
        }));
        continue;
      }
      unresolvedRangeWrappers.push({ node, index, offset, containerId, carriers });
    }

    /* Second pass — order-bracketed turn content. A host virtualized wrapper
       can carry only a sub-message id (reasoning and tool messages are not
       enumerable from the complete index; only the acquisition graph knows
       them, and the graph is not acquirable on unauthorized activations).
       Structural inference from PROVEN members replaces that: a host
       turn-content wrapper (data-turn-id-container) lying strictly between
       identity-proven neighbors whose authoritative orders differ by at
       most one belongs to the earlier turn's span. The page boundaries
       themselves bracket the edges. Anything wider stays ambiguous and
       fails closed exactly as before. */
    const rangeOrderOfProven = (candidate) => {
      const proof = provenWrappers.get(candidate) || null;
      if (!proof) return 0;
      const record = graphRead.records.get(proof.identity) || null;
      return Math.max(0, Number(record?.order || 0) || 0);
    };
    for (const entry of unresolvedRangeWrappers) {
      const { node, index, containerId, carriers } = entry;
      let bracketed = false;
      const isTurnContent = !!containerId || node?.matches?.('[data-turn-id-container]') === true;
      if (isTurnContent) {
        let leftOrder = 0;
        let leftIdentity = '';
        for (let at = entry.offset - 1; at >= 0; at -= 1) {
          const candidate = interval[at];
          if (pageCollapseRangeH2OOwned(candidate)) continue;
          if (!provenWrappers.has(candidate)) break;
          leftOrder = rangeOrderOfProven(candidate);
          leftIdentity = provenWrappers.get(candidate).identity;
          break;
        }
        if (!leftOrder) {
          // Left edge: the proven start boundary is the bracket.
          leftOrder = Math.max(0, Number(base.pageStartOrder || 0) || 0);
          leftIdentity = String(authority?.qId || '');
        }
        let rightOrder = 0;
        for (let at = entry.offset + 1; at < interval.length; at += 1) {
          const candidate = interval[at];
          if (pageCollapseRangeH2OOwned(candidate)) continue;
          if (!provenWrappers.has(candidate)) break;
          rightOrder = rangeOrderOfProven(candidate);
          break;
        }
        if (!rightOrder) {
          // Right edge: the proven end boundary (next page start, or the
          // final tail) is the bracket.
          rightOrder = Math.max(0, Number(base.pageEndOrder || 0) || 0) + 1;
        }
        if (
          leftOrder > 0
          && rightOrder > 0
          && leftIdentity
          && rightOrder - leftOrder >= 0
          && rightOrder - leftOrder <= 1
        ) {
          hostWrapperCount += 1;
          provenWrappers.set(node, Object.freeze({
            // The wrapper's own container id (a stable sub-message identity)
            // is what member revalidation can re-verify against the node;
            // the bracketing neighbor identity only justified membership.
            identity: containerId || leftIdentity,
            containerId,
            proofSource: 'order-bracketed-turn-content',
          }));
          classifierSignals.orderBracketed = Number(classifierSignals.orderBracketed || 0) + 1;
          bracketed = true;
        }
      }
      if (bracketed) continue;
      ambiguousWrapperCount += 1;
      if (!firstAmbiguous) {
        const containerRecord = containerId ? graphRead.records.get(containerId) : null;
        const mountedIds = carriers
          .map(pageCollapseRangeIdentityOfCarrier)
          .filter(Boolean);
        firstAmbiguous = {
          index,
          tag: String(node?.tagName || '').toUpperCase(),
          hasTurnIdContainer: !!containerId,
          containsMountedIdentity: mountedIds.length > 0,
          containsNativeTestHost: !!node?.matches?.(TURN_HOST_SEL)
            || !!node?.querySelector?.(TURN_HOST_SEL),
          hasRetainedHeightStyle: pageCollapseRangeHasRetainedHeight(node),
          graphIdentityFound: !!containerRecord?.found
            || mountedIds.some((id) => graphRead.records.get(id)?.found === true),
        };
      }
    }

    let finalStatus = null;
    let finalGraph = null;
    try {
      finalStatus = rt?.getEffectivePresentationStatus?.() || null;
      finalGraph = (typeof renderedBoundaryIdentityProof === 'function')
        ? renderedBoundaryIdentityProof(rt, [
          authority.qId,
          ...(nextAuthority ? [nextAuthority.qId] : []),
        ])
        : (rt?.getGraphIdentityDiagnostics?.([
          authority.qId,
          ...(nextAuthority ? [nextAuthority.qId] : []),
        ]) || null);
    } catch {}
    if (
      renderedBoundaryStatusIdentity(finalStatus) !== authority.statusIdentity
      || finalGraph?.available !== true
      || String(finalGraph?.scope?.fingerprint || '') !== graphFingerprint
      || String(finalGraph?.scope?.chatId || '') !== authority.chatId
      || String(finalGraph?.scope?.routeKey || '') !== authority.routeKey
      || Math.max(0, Number(finalGraph?.scope?.generation || 0) || 0) !== authority.generation
    ) {
      S.pageCollapseRangeContinuity.clear();
      return fail('range-scope-changed', {
        startBoundarySupported: true,
        nextBoundarySupported: nextSupported,
        nextBoundaryQId: base.nextBoundaryQId,
        graphFingerprint,
        startWrapperCurrent,
        endWrapperCurrent,
        rangeStartIndex,
        rangeEndIndex,
        hostWrapperCount,
        h2oNodeCount,
        ambiguousWrapperCount,
        firstAmbiguousIndex: firstAmbiguous?.index ?? -1,
        firstAmbiguous,
        classifierSignals,
        pageUnitOrderCurrent: true,
      });
    }
    if (ambiguousWrapperCount) {
      S.pageCollapseRangeContinuity.delete(num);
      return fail('range-wrapper-ambiguous', {
        startBoundarySupported: true,
        nextBoundarySupported: nextSupported,
        nextBoundaryQId: base.nextBoundaryQId,
        graphFingerprint,
        startWrapperCurrent,
        endWrapperCurrent,
        rangeStartIndex,
        rangeEndIndex,
        hostWrapperCount,
        h2oNodeCount,
        ambiguousWrapperCount,
        firstAmbiguousIndex: firstAmbiguous?.index ?? -1,
        firstAmbiguous,
        classifierSignals,
        pageUnitOrderCurrent: true,
      });
    }
    S.pageCollapseRangeContinuity.set(num, {
      pageNum: num,
      chatId: authority.chatId,
      routeKey: authority.routeKey,
      generation: authority.generation,
      effectiveFingerprint: authority.effectiveFingerprint,
      graphFingerprint,
      flowRoot,
      wrappers: provenWrappers,
    });
    const diagnostic = frozenPageCollapseRangeDiagnostics({
      ...base,
      supported: true,
      reason: null,
      graphFingerprint,
      startBoundarySupported: true,
      nextBoundarySupported: nextSupported,
      nextBoundaryQId: base.nextBoundaryQId,
      startWrapperCurrent,
      endWrapperCurrent,
      rangeStartIndex,
      rangeEndIndex,
      hostWrapperCount,
      h2oNodeCount,
      ambiguousWrapperCount: 0,
      firstAmbiguousIndex: -1,
      firstAmbiguous: null,
      classifierSignals,
      pageUnitOrderCurrent: true,
      streaming: false,
      branchTransition: false,
      rangeProven: true,
      isFinalPage: base.isFinalPage === true,
      finalTailSupported: !!finalTail,
      terminalIdentityCurrent: finalTail ? finalTail.terminalIdentityCurrent === true : false,
      terminalWrapperCurrent: finalTail ? finalTail.terminalWrapperCurrent === true : false,
      pageEndSentinelCurrent: finalTail ? finalTail.pageEndSentinelCurrent === true : false,
    });
    return finish(diagnostic, {
      authority,
      nextAuthority,
      startCapability,
      nextCapability,
      flowRoot,
      startWrapper,
      endWrapper: endExclusive,
      hostWrappers: Array.from(provenWrappers.keys()),
      h2oNodes: interval.filter((node) => pageCollapseRangeH2OOwned(node)),
      wrapperProofs: provenWrappers,
    });
  }


  function getPageCollapseRangeDiagnostics(pageNum = 0) {
    return buildPageCollapseRangePlan(pageNum, { includeDom: false });
  }

  function frozenPageCollapseCapability(raw = {}) {
    return Object.freeze({
      version: 1,
      supported: raw.supported === true,
      reason: raw.reason == null ? null : String(raw.reason || ''),
      productReason: String(raw.productReason || 'layout-incomplete'),
      pageNum: Math.max(1, Number(raw.pageNum || 0) || 0),
      pageStartOrder: Math.max(1, Number(raw.pageStartOrder || 0) || 0),
      pageEndOrder: Math.max(1, Number(raw.pageEndOrder || 0) || 0),
      chatId: String(raw.chatId || '') || null,
      routeKey: String(raw.routeKey || ''),
      generation: Math.max(0, Number(raw.generation || 0) || 0),
      effectiveFingerprint: String(raw.effectiveFingerprint || '') || null,
      graphFingerprint: String(raw.graphFingerprint || '') || null,
      startBoundarySupported: raw.startBoundarySupported === true,
      nextBoundarySupported: raw.nextBoundarySupported === true,
      rangeProven: raw.rangeProven === true,
      startWrapperCurrent: raw.startWrapperCurrent === true,
      endWrapperCurrent: raw.endWrapperCurrent === true,
      rangeStartIndex: Number.isInteger(raw.rangeStartIndex) ? raw.rangeStartIndex : -1,
      rangeEndIndex: Number.isInteger(raw.rangeEndIndex) ? raw.rangeEndIndex : -1,
      hostWrapperCount: Math.max(0, Number(raw.hostWrapperCount || 0) || 0),
      h2oNodeCount: Math.max(0, Number(raw.h2oNodeCount || 0) || 0),
      ambiguousWrapperCount: Math.max(0, Number(raw.ambiguousWrapperCount || 0) || 0),
      firstAmbiguousIndex: Number.isInteger(raw.firstAmbiguousIndex)
        ? raw.firstAmbiguousIndex
        : -1,
      pageUnitOrderCurrent: raw.pageUnitOrderCurrent === true,
      isFinalPage: raw.isFinalPage === true,
      finalTailSupported: raw.finalTailSupported === true,
      streaming: raw.streaming === true,
      branchTransition: raw.branchTransition === true,
      titleRowsCurrent: raw.titleRowsCurrent === true,
      titleRowCount: Math.max(0, Number(raw.titleRowCount || 0) || 0),
      expectedTitleRowCount: Math.max(0, Number(raw.expectedTitleRowCount || 0) || 0),
      prerequisitesReady: raw.prerequisitesReady === true,
      atomicTransactionImplemented: true,
      activationReady: raw.activationReady === true,
      activationBlockReason: raw.activationReady === true
        ? null
        : String(raw.activationBlockReason || raw.reason || 'layout-incomplete'),
      legacyNativeSlotConsulted: false,
    });
  }

  function pageCollapseCapabilityProductReason({
    prerequisitesReady = false,
    authorityCurrent = false,
    titleRowsCurrent = false,
    streaming = false,
    branchTransition = false,
    reason = '',
    ambiguousWrapperCount = 0,
  } = {}) {
    if (prerequisitesReady) return 'ready';
    if (streaming || branchTransition) return 'page-updating';
    if (
      ambiguousWrapperCount > 0
      || /ambiguous|unsupported-host|unsupported-layout/.test(String(reason || ''))
    ) return 'unsupported-layout';
    // A final page whose tail is not yet proven is still settling: report it as
    // loading rather than as a layout the reader is told is incomplete.
    if (/final-page-tail-unproven/.test(String(reason || ''))) return 'page-loading';
    if (
      /boundary|page-unit|range-scope|final-page|layout-incomplete/.test(String(reason || ''))
    ) return 'layout-incomplete';
    if (!authorityCurrent || !titleRowsCurrent) return 'page-loading';
    return 'layout-incomplete';
  }

  /* Stage 2 (Defect V) — current mounted canonical subset.

     The host keeps only a sliding window of the transcript mounted, so the two
     distant boundaries of a 25-turn logical page are never present at once and
     no contiguous native interval spanning the page can exist. Enumeration is
     therefore canonical-FIRST: we walk the canonical members of the logical
     page and ask the frozen Stage-1 identity path for each member's CURRENT
     surface. We never enumerate DOM wrappers and infer which ones "look" like
     they belong to the page, so a mounted wrong-page member, a DOM-only
     noncanonical node and visual adjacency are all structurally irrelevant.

     Policy per member:
       connected surface   -> include in the current mounted subset
       identity-unmounted  -> skip; ordinary host windowing, not a failure
       identity-ambiguous  -> fail the WHOLE plan closed
       stale/disconnected/other resolver refusal -> fail the whole plan closed

     Note the deliberate asymmetry against the retired whole-range rule: a
     page-wide "ambiguousWrapperCount === 0" prerequisite is gone, but ambiguity
     on a specific CURRENT candidate still fails closed. */
  function resolveCurrentMountedPageMembers(page = null, options = {}) {
    const members = Array.isArray(page?.turnRecords) ? page.turnRecords : [];
    const startOrder = Math.max(0, Number(page?.startOrder || 0) || 0);
    const endOrder = Math.max(startOrder, Number(page?.endOrder || 0) || 0);
    if (!members.length || !startOrder) {
      return { ok: false, reason: 'page-membership-unavailable', flowRoot: null, mounted: [], unmountedCount: 0 };
    }
    const scoped = members.filter((member) => {
      const order = Math.max(0, Number(member?.turnNo || 0) || 0);
      return order >= startOrder && order <= endOrder;
    });
    // Discovery pass: the flow root is taken from whichever canonical member of
    // this page is currently mounted, never from a start/end wrapper pair.
    let flowRoot = options?.flowRoot || null;
    if (!flowRoot) {
      for (const member of scoped) {
        const probe = collapsedBoundaryNativeStartSurface(member);
        if (probe.reason === 'identity-ambiguous') {
          return { ok: false, reason: 'candidate-identity-ambiguous', flowRoot: null, mounted: [], unmountedCount: 0 };
        }
        if (!probe.ok) continue;
        const anchor = getTurnAnchorNode(probe.section);
        const root = anchor?.parentElement || null;
        if (root?.isConnected === true) { flowRoot = root; break; }
      }
    }
    const mounted = [];
    let unmountedCount = 0;
    for (const member of scoped) {
      const surface = collapsedBoundaryNativeStartSurface(member, flowRoot);
      if (surface.reason === 'identity-ambiguous') {
        return { ok: false, reason: 'candidate-identity-ambiguous', flowRoot, mounted: [], unmountedCount: 0 };
      }
      if (!surface.ok) {
        // Unmounted is the expected windowed case. Every other refusal is a
        // stale/disconnected/out-of-scope resolution and fails closed.
        if (surface.reason === 'identity-unmounted') { unmountedCount += 1; continue; }
        return { ok: false, reason: `candidate-${String(surface.reason || 'unresolved')}`, flowRoot, mounted: [], unmountedCount: 0 };
      }
      const node = getTurnAnchorNode(surface.section);
      if (!node || node.isConnected !== true || (flowRoot && node.parentElement !== flowRoot)) {
        return { ok: false, reason: 'candidate-flow-scope-invalid', flowRoot, mounted: [], unmountedCount: 0 };
      }
      mounted.push(Object.freeze({
        turnNo: Math.max(0, Number(member?.turnNo || 0) || 0),
        questionId: String(member?.questionId || ''),
        answerId: String(member?.answerId || ''),
        node,
      }));
    }
    return { ok: true, reason: null, flowRoot: flowRoot || null, mounted, unmountedCount };
  }

  function evaluatePageCollapseCapability(pageNum = 0, options = {}) {
    const num = Math.max(1, Number(pageNum || 0) || 0);
    const model = buildTitleListPresentationPageModel();
    const page = model?.pages?.find?.((entry) => entry.pageNo === num) || null;
    const nextPage = model?.pages?.find?.((entry) => entry.pageNo === num + 1) || null;
    const pageStartOrder = Math.max(
      1,
      Number(page?.startOrder || (((num - 1) * TITLE_LIST_PAGE_SIZE) + 1)) || 1,
    );
    const pageEndOrder = Math.max(
      pageStartOrder,
      Number(page?.endOrder || pageStartOrder) || pageStartOrder,
    );
    const expectedTitleRowCount = page
      ? Math.max(0, pageEndOrder - pageStartOrder + 1)
      : 0;
    const titleRowCount = Array.isArray(page?.turnRecords) ? page.turnRecords.length : 0;
    const titleRowsCurrent = (
      model?.coherent === true
      && !!page
      && expectedTitleRowCount > 0
      && titleRowCount === expectedTitleRowCount
      && page.turnRecords.every(
        (member, offset) => Number(member?.turnNo || 0) === pageStartOrder + offset,
      )
    );
    const rangePlan = buildPageCollapseRangePlan(num, { includeDom: true });
    const range = rangePlan?.diagnostic || frozenPageCollapseRangeDiagnostics({
      pageNum: num,
      reason: 'range-unavailable',
    });
    const startCapability = rangePlan?.startCapability
      || getRenderedPageBoundaryCapability(num);
    const nextCapability = rangePlan?.nextCapability
      || getRenderedPageBoundaryCapability(num + 1);
    const finalPage = range.isFinalPage === true;
    const authorityCurrent = (
      model?.coherent === true
      && !!page
      && (finalPage || !!nextPage)
      && startCapability.pageStartOrder === pageStartOrder
      && (finalPage || nextCapability.pageStartOrder === nextPage.startOrder)
      && range.pageStartOrder === pageStartOrder
      && range.pageEndOrder === pageEndOrder
      && !!range.chatId
      && !!range.generation
      && !!range.effectiveFingerprint
      && !!range.graphFingerprint
    );
    const scopesCurrent = (
      authorityCurrent
      && startCapability.chatId === range.chatId
      && startCapability.routeKey === range.routeKey
      && startCapability.generation === range.generation
      && startCapability.effectiveFingerprint === range.effectiveFingerprint
      && startCapability.graphFingerprint === range.graphFingerprint
      && (finalPage || (
        nextCapability.chatId === range.chatId
        && nextCapability.routeKey === range.routeKey
        && nextCapability.generation === range.generation
        && nextCapability.effectiveFingerprint === range.effectiveFingerprint
        && nextCapability.graphFingerprint === range.graphFingerprint
      ))
    );
    const streaming = range.streaming === true;
    const branchTransition = range.branchTransition === true;
    /* Stage 2 (Defect V): LOGICAL page-collapse capability is canonical only.

       The retired predicate additionally required both distant native
       boundaries to be mounted and leased at the same instant, plus a proven
       contiguous wrapper interval spanning the page (rangeProven,
       rangeStartIndex/rangeEndIndex, hostWrapperCount > 0, a page-wide
       ambiguousWrapperCount === 0, and native document order). Under current
       host windowing those can never all hold for a 25-turn page, so a
       perfectly healthy canonical page was refused.

       Every field below comes from canonical authority and is fully populated
       with ZERO native boundary surfaces mounted. The native range values are
       still computed above, but only as diagnostics.

       `scopesCurrent` is retained in full: it is pure canonical scope CURRENCY
       (chat, route, generation, effective fingerprint, graph fingerprint and
       page order agreement between the authority and the range descriptor).
       Scope *presence* is not the same as scope *currency*, so a generation,
       fingerprint or route mismatch must still fail closed here. What is
       retired is only the native machinery layered on top of it. */
    const prerequisitesReady = (
      scopesCurrent
      && !streaming
      && !branchTransition
      && titleRowsCurrent
    );
    let reason = null;
    if (!prerequisitesReady) {
      // Only logical causes can block logical capability now. Native boundary
      // and range reasons are no longer eligible outcomes here.
      if (!model?.coherent || !page) reason = model?.reason || 'authority-unavailable';
      else if (!finalPage && !nextPage) reason = 'next-page-unavailable';
      else if (!scopesCurrent) reason = 'range-scope-changed';
      else if (streaming) reason = 'streaming-active';
      else if (branchTransition) reason = 'boundary-scope-changed';
      else if (!titleRowsCurrent) reason = 'title-rows-incomplete';
      else reason = 'authority-unavailable';
    }
    const productReason = pageCollapseCapabilityProductReason({
      prerequisitesReady,
      authorityCurrent,
      titleRowsCurrent,
      streaming,
      branchTransition,
      reason,
      ambiguousWrapperCount: range.ambiguousWrapperCount,
    });
    const capability = frozenPageCollapseCapability({
      supported: prerequisitesReady,
      reason,
      productReason,
      pageNum: num,
      pageStartOrder,
      pageEndOrder,
      chatId: range.chatId || startCapability.chatId,
      routeKey: range.routeKey || startCapability.routeKey,
      generation: range.generation || startCapability.generation,
      effectiveFingerprint: range.effectiveFingerprint || startCapability.effectiveFingerprint,
      graphFingerprint: range.graphFingerprint || startCapability.graphFingerprint,
      startBoundarySupported: startCapability.supported === true,
      nextBoundarySupported: nextCapability.supported === true,
      rangeProven: range.rangeProven === true,
      startWrapperCurrent: range.startWrapperCurrent === true,
      endWrapperCurrent: range.endWrapperCurrent === true,
      rangeStartIndex: range.rangeStartIndex,
      rangeEndIndex: range.rangeEndIndex,
      hostWrapperCount: range.hostWrapperCount,
      h2oNodeCount: range.h2oNodeCount,
      ambiguousWrapperCount: range.ambiguousWrapperCount,
      firstAmbiguousIndex: range.firstAmbiguousIndex,
      pageUnitOrderCurrent: range.pageUnitOrderCurrent === true,
      isFinalPage: range.isFinalPage === true,
      finalTailSupported: range.finalTailSupported === true,
      streaming,
      branchTransition,
      titleRowsCurrent,
      titleRowCount,
      expectedTitleRowCount,
      prerequisitesReady,
      activationReady: prerequisitesReady,
      activationBlockReason: prerequisitesReady ? null : (reason || 'layout-incomplete'),
    });
    /* Stage-2 Pass-2 plan shape.

       Authority is canonical and scalar. The current native nodes are carried
       as EPHEMERAL input for this pass only and are never persisted as logical
       truth: page existence, its start/end order and its membership all come
       from canonical authority alone.

       The legacy contiguous-range fields are still spread in when a native
       range happens to be proven, so the existing (Pass-3-owned) transaction
       path keeps its current behaviour untouched in the full-interval world. */
    const mountedSubset = (
      options?.includePlan === true && capability.activationReady === true
    ) ? resolveCurrentMountedPageMembers(page) : null;
    const privatePlan = (
      options?.includePlan === true
      && capability.activationReady === true
      && mountedSubset?.ok === true
    ) ? {
      ...(rangePlan?.ok === true ? rangePlan : {}),
      stage2WindowedPlan: true,
      count: Math.max(0, Number(model?.count || 0) || 0),
      candidateIdentities: Object.freeze(mountedSubset.mounted.map((entry) => Object.freeze({
        turnNo: entry.turnNo,
        questionId: entry.questionId,
      }))),
      mountedCandidates: mountedSubset.mounted,
      mountedCandidateCount: mountedSubset.mounted.length,
      unmountedCandidateCount: mountedSubset.unmountedCount,
      currentFlowRoot: mountedSubset.flowRoot,
      version: 1,
      pageNum: num,
      pageStartOrder,
      pageEndOrder,
      chatId: capability.chatId,
      routeKey: capability.routeKey,
      generation: capability.generation,
      effectiveFingerprint: capability.effectiveFingerprint,
      graphFingerprint: capability.graphFingerprint,
      startBoundaryQId: range.startQId,
      nextBoundaryQId: range.nextBoundaryQId,
      isFinalPage: range.isFinalPage === true,
      titleRows: Array.isArray(page?.turnRecords) ? page.turnRecords.slice() : [],
      expectedTitleRowCount,
      pageDivider: renderedBoundaryThreadDivider(num),
      pageStartSentinel: renderedBoundaryStartSentinel(num),
      nextPageDivider: renderedBoundaryThreadDivider(num + 1),
      nextPageStartSentinel: renderedBoundaryStartSentinel(num + 1),
      capabilityIdentity: JSON.stringify([
        capability.chatId,
        capability.routeKey,
        capability.generation,
        capability.effectiveFingerprint,
        capability.graphFingerprint,
        num,
        pageStartOrder,
        pageEndOrder,
        range.startQId,
        range.nextBoundaryQId,
      ]),
    } : null;
    return { capability, plan: privatePlan };
  }

  function getPageCollapseCapability(pageNum = 0) {
    return evaluatePageCollapseCapability(pageNum, { includePlan: false }).capability;
  }

  function collapsedNativeRangeKey(chatId = '', pageNum = 0) {
    return `${String(chatId || resolveChatId()).trim()}|${String(Math.max(1, Number(pageNum || 0) || 0))}`;
  }

  function collapsedBoundaryStatusIdentity(status = null) {
    return JSON.stringify([
      String(status?.source || ''),
      status?.overlayActive === true,
      Math.max(0, Number(status?.count || 0) || 0),
      String(status?.canonicalFingerprint || ''),
      String(status?.chatId || ''),
      String(status?.routeKey || ''),
      Math.max(0, Number(status?.generation || 0) || 0),
    ]);
  }

  /* Current-host native page-boundary identity.

     The host renders `data-testid="conversation-turn-N"` WINDOW-RELATIVE: N
     tracks the sliding render window and is renumbered whenever history is
     prepended, so it can never address a canonical member. Section
     `data-turn-id` carries the branch NODE id, which equals the product qId
     only for never-branched turns. A logical turn is also not fixed at two
     native sections. The retired resolver assumed all three, so it silently
     failed to bind current surfaces.

     Both collapsed-boundary lookups therefore delegate to the established
     MountRegistry/message-id resolver and accept only the CURRENT connected
     node; resolver outcomes (identity-unmounted, identity-ambiguous, stale or
     disconnected bindings) are surfaced unchanged and never approximated. */
  function collapsedBoundaryNativeStartSurface(member = null, flowRoot = null) {
    const qId = String(member?.questionId || '').trim();
    if (!qId) return { ok: false, reason: 'identity-unavailable', section: null, surface: null };
    let surface = null;
    try {
      surface = resolveRenderedTurnSurfaceByIdentity(qId, flowRoot || document.body);
    } catch {
      return { ok: false, reason: 'identity-unmounted', section: null, surface: null };
    }
    if (surface?.ok !== true) {
      return {
        ok: false,
        reason: String(surface?.reason || 'identity-unmounted'),
        section: null,
        surface: null,
      };
    }
    const section = surface.nativeTestHost?.isConnected === true ? surface.nativeTestHost : null;
    if (!section) return { ok: false, reason: 'identity-unmounted', section: null, surface: null };
    return { ok: true, reason: null, section, surface };
  }

  function frozenCollapsedBoundaryResult(raw = {}) {
    const value = {
      ready: raw.ready === true,
      reason: raw.ready === true && raw.reason == null
        ? null
        : String(raw.reason || 'collapsed-exact-boundary-unavailable'),
      structuralReason: raw.ready === true && raw.structuralReason == null
        ? null
        : String(raw.structuralReason || ''),
      pageNum: Math.max(1, Number(raw.pageNum || 0) || 0),
      flowRoot: raw.flowRoot || null,
      nativeStart: raw.nativeStart || null,
      nextPageNativeStart: raw.nextPageNativeStart || null,
      nativeSlotSequence: raw.nativeSlotSequence || null,
      nativeStartOrdinal: Math.max(0, Number(raw.nativeStartOrdinal || 0) || 0),
      nativeEndOrdinal: Math.max(0, Number(raw.nativeEndOrdinal || 0) || 0),
      startIdentity: raw.startIdentity ? Object.freeze({ ...raw.startIdentity }) : null,
      nextStartIdentity: raw.nextStartIdentity ? Object.freeze({ ...raw.nextStartIdentity }) : null,
      generation: Math.max(0, Number(raw.generation || 0) || 0),
      fingerprint: String(raw.fingerprint || ''),
      source: String(raw.source || ''),
      count: Math.max(0, Number(raw.count || 0) || 0),
      productReason: String(raw.productReason || ''),
      prerequisitesReady: raw.prerequisitesReady === true,
      activationReady: raw.activationReady === true,
      capabilityVersion: Math.max(0, Number(raw.capabilityVersion || 0) || 0),
      legacyNativeSlotConsulted: raw.legacyNativeSlotConsulted === true,
    };
    return Object.freeze(value);
  }

  function nativeTurnSlotClassSignature(node = null) {
    if (!node || node.nodeType !== 1) return '';
    const classes = String(node.className || '')
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .sort();
    return `${String(node.tagName || '').toUpperCase()}|${classes.join('.')}`;
  }

  function nativeTurnSlotLastKnownHeight(node = null) {
    if (!node?.style) return '';
    let value = '';
    try {
      const computed = typeof W.getComputedStyle === 'function'
        ? W.getComputedStyle(node)
        : (typeof getComputedStyle === 'function' ? getComputedStyle(node) : null);
      value = String(computed?.getPropertyValue?.('--last-known-height') || '').trim();
    } catch {}
    if (value) return value;
    try { return String(node.style.getPropertyValue?.('--last-known-height') || '').trim(); } catch {}
    return '';
  }

  function isNativeTurnSlotExcluded(node = null) {
    if (!node || node.nodeType !== 1) return true;
    try {
      if (node.matches?.(
        '.cgxui-chat-page-divider, .cgxui-pgnw-page-divider,'
        + ' [data-cgxui="chat-page-title-list-synth"],'
        + ' [data-h2o-chat-page-boundary], #cgx-mm-root,'
        + ' form, [contenteditable="true"],'
        + ' [data-cgxui-owner="mnmp"], [data-h2o-title-list-segment="suffix"]'
      )) return true;
      if (node.hasAttribute?.('data-cgxui-owner')) return true;
      if (node.closest?.('#cgx-mm-root')) return true;
    } catch {}
    return false;
  }

  function nativeTurnSlotMountedIdentity(section = null, membersByOrder = new Map(), expectedSlotCount = 0) {
    const nativeOrdinal = turnNumberOfSection(section);
    if (
      !nativeOrdinal
      || nativeOrdinal > expectedSlotCount
      || nativeOrdinal < 1
    ) return null;
    const order = Math.ceil(nativeOrdinal / 2);
    const member = membersByOrder.get(order) || null;
    if (!member) return null;
    const role = nativeOrdinal % 2 ? 'user' : 'assistant';
    const expectedId = role === 'user'
      ? String(member.questionId || '').trim()
      : String(member.answerId || '').trim();
    if (!expectedId) return null;
    const actualId = String(section.getAttribute?.('data-turn-id') || '').trim();
    const match = getTurnHostRole(section) === role && actualId === expectedId;
    return Object.freeze({
      state: match ? 'match' : 'conflict',
      match,
      ordinal: nativeOrdinal,
      order,
      role,
      expectedId,
      actualId,
      id: actualId,
      testId: `conversation-turn-${String(nativeOrdinal)}`,
    });
  }

  function frozenNativePageHeadCoherence(raw = {}) {
    const allowedStates = new Set(['match', 'absent', 'conflict', 'unavailable']);
    const state = allowedStates.has(raw.state) ? raw.state : 'unavailable';
    const freezeRole = (value = {}, ordinal = 0) => Object.freeze({
      state: allowedStates.has(value?.state) ? value.state : 'unavailable',
      expectedId: String(value?.expectedId || '') || null,
      actualId: String(value?.actualId || '') || null,
      ordinal: Math.max(0, Number(value?.ordinal || ordinal || 0) || 0),
    });
    const userOrdinal = Math.max(0, Number(raw.userOrdinal || 0) || 0);
    const assistantOrdinal = Math.max(0, Number(raw.assistantOrdinal || 0) || 0);
    return Object.freeze({
      state,
      coherent: state === 'match',
      convergenceEligible: state === 'absent',
      pageNum: Math.max(1, Number(raw.pageNum || 0) || 0),
      startOrder: Math.max(1, Number(raw.startOrder || 0) || 0),
      userOrdinal,
      assistantOrdinal,
      user: freezeRole(raw.user, userOrdinal),
      assistant: freezeRole(raw.assistant, assistantOrdinal),
    });
  }

  // Inert native page-head diagnostic. It reads only the exact USER/ASSISTANT
  // pair for the requested canonical page and never schedules convergence.
  function resolveNativePageHeadCoherence(pageNum = 0) {
    const num = Math.max(1, Number(pageNum || 0) || 0);
    const startOrder = ((num - 1) * TITLE_LIST_PAGE_SIZE) + 1;
    const userOrdinal = ((startOrder - 1) * 2) + 1;
    const assistantOrdinal = userOrdinal + 1;
    const unavailable = (extra = {}) => frozenNativePageHeadCoherence({
      state: 'unavailable',
      pageNum: num,
      startOrder,
      userOrdinal,
      assistantOrdinal,
      user: { state: 'unavailable', ordinal: userOrdinal },
      assistant: { state: 'unavailable', ordinal: assistantOrdinal },
      ...extra,
    });
    const rt = TURN_RUNTIME();
    if (!rt) return unavailable();
    let before = null;
    let after = null;
    let model = null;
    try {
      before = rt[TITLE_LIST_EFFECTIVE_METHOD.STATUS]?.() || null;
      model = buildTitleListPresentationPageModel();
      after = rt[TITLE_LIST_EFFECTIVE_METHOD.STATUS]?.() || null;
    } catch {
      return unavailable();
    }
    const count = Math.max(0, Number(before?.count || 0) || 0);
    if (
      !model?.coherent
      || count < startOrder
      || model.count !== count
      || model.source !== String(before?.source || '')
      || !Math.max(0, Number(before?.generation || 0) || 0)
      || !String(before?.canonicalFingerprint || '')
      || collapsedBoundaryStatusIdentity(before) !== collapsedBoundaryStatusIdentity(after)
    ) return unavailable();
    const page = model.pages.find((entry) => Number(entry?.pageNo || 0) === num) || null;
    const member = page?.turnRecords?.find(
      (entry) => Number(entry?.turnNo || 0) === startOrder
    ) || null;
    const expectedUserId = String(member?.questionId || '').trim();
    const expectedAssistantId = String(member?.answerId || '').trim();
    if (!member || !expectedUserId || !expectedAssistantId) {
      return unavailable({
        user: { state: 'unavailable', expectedId: expectedUserId, ordinal: userOrdinal },
        assistant: {
          state: 'unavailable',
          expectedId: expectedAssistantId,
          ordinal: assistantOrdinal,
        },
      });
    }
    const membersByOrder = new Map([[startOrder, member]]);
    const expectedSlotCount = count * 2;
    let sections = null;
    try { sections = Array.from(document.querySelectorAll(TURN_HOST_SEL)); } catch {}
    if (!sections) return unavailable();
    const classify = (ordinal, expectedId) => {
      const exactSections = sections.filter((section) => {
        try {
          return turnNumberOfSection(section) === ordinal
            && !section.closest?.(`${TITLE_LIST_SYNTH_SEL}, ${TITLE_LIST_SUFFIX_SEL}`);
        } catch { return false; }
      });
      if (!exactSections.length) {
        return { state: 'absent', expectedId, actualId: '', ordinal };
      }
      if (exactSections.length !== 1) {
        return { state: 'unavailable', expectedId, actualId: '', ordinal };
      }
      const identity = nativeTurnSlotMountedIdentity(
        exactSections[0],
        membersByOrder,
        expectedSlotCount,
      );
      if (!identity) return { state: 'unavailable', expectedId, actualId: '', ordinal };
      return {
        state: identity.match === true ? 'match' : 'conflict',
        expectedId: identity.expectedId,
        actualId: identity.actualId,
        ordinal,
      };
    };
    const user = classify(userOrdinal, expectedUserId);
    const assistant = classify(assistantOrdinal, expectedAssistantId);
    let current = null;
    try { current = rt[TITLE_LIST_EFFECTIVE_METHOD.STATUS]?.() || null; } catch {}
    if (collapsedBoundaryStatusIdentity(before) !== collapsedBoundaryStatusIdentity(current)) {
      return unavailable({
        user: { state: 'unavailable', expectedId: expectedUserId, ordinal: userOrdinal },
        assistant: {
          state: 'unavailable',
          expectedId: expectedAssistantId,
          ordinal: assistantOrdinal,
        },
      });
    }
    const state = (user.state === 'conflict' || assistant.state === 'conflict')
      ? 'conflict'
      : ((user.state === 'absent' || assistant.state === 'absent')
        ? 'absent'
        : ((user.state === 'match' && assistant.state === 'match') ? 'match' : 'unavailable'));
    return frozenNativePageHeadCoherence({
      state,
      pageNum: num,
      startOrder,
      userOrdinal,
      assistantOrdinal,
      user,
      assistant,
    });
  }

  function frozenNativeTurnSlotSequence(raw = {}) {
    const slots = Array.isArray(raw.slots)
      ? raw.slots.map((slot) => Object.freeze({ ...slot }))
      : [];
    const calibrationIdentities = Array.isArray(raw.calibrationIdentities)
      ? raw.calibrationIdentities.map((identity) => Object.freeze({ ...identity }))
      : [];
    return Object.freeze({
      ready: raw.ready === true,
      reason: String(raw.reason || (raw.ready ? 'ready' : 'native-turn-slot-sequence-unavailable')),
      flowRoot: raw.flowRoot || null,
      expectedSlotCount: Math.max(0, Number(raw.expectedSlotCount || 0) || 0),
      actualSlotCount: Math.max(0, Number(raw.actualSlotCount || 0) || 0),
      calibrated: raw.calibrated === true,
      slots: Object.freeze(slots),
      generation: Math.max(0, Number(raw.generation || 0) || 0),
      fingerprint: String(raw.fingerprint || ''),
      source: String(raw.source || ''),
      count: Math.max(0, Number(raw.count || 0) || 0),
      calibrationIdentities: Object.freeze(calibrationIdentities),
    });
  }

  // Read-only native-slot resolver. ChatGPT retains one direct-flow layout
  // slot per native USER/ASSISTANT turn even while the section is virtualized;
  // section-less slots keep the same host class signature and
  // --last-known-height. Exact count plus every mounted test-id calibration
  // is the authority—never nearest neighbours, mounted-array ordinals, or a
  // late Page 2 artifact.
  function resolveNativeTurnSlotSequence() {
    const rt = TURN_RUNTIME();
    if (!rt) return frozenNativeTurnSlotSequence({ reason: 'native-slot-runtime-unavailable' });
    let before = null;
    let after = null;
    let model = null;
    try {
      before = rt[TITLE_LIST_EFFECTIVE_METHOD.STATUS]?.() || null;
      model = buildTitleListPresentationPageModel();
      after = rt[TITLE_LIST_EFFECTIVE_METHOD.STATUS]?.() || null;
    } catch {
      return frozenNativeTurnSlotSequence({ reason: 'native-slot-authority-read-failed' });
    }
    const count = Math.max(0, Number(before?.count || 0) || 0);
    const expectedSlotCount = count * 2;
    const generation = Math.max(0, Number(before?.generation || 0) || 0);
    const fingerprint = String(before?.canonicalFingerprint || '');
    const source = String(before?.source || '');
    const fail = (reason, extra = {}) => frozenNativeTurnSlotSequence({
      reason,
      expectedSlotCount,
      generation,
      fingerprint,
      source,
      count,
      ...extra,
    });
    if (
      !model?.coherent
      || count < 1
      || expectedSlotCount < 2
      || model.count !== count
      || model.source !== source
      || !generation
      || !fingerprint
      || collapsedBoundaryStatusIdentity(before) !== collapsedBoundaryStatusIdentity(after)
    ) return fail('native-slot-authority-not-coherent');
    const members = model.pages
      .flatMap((page) => Array.isArray(page?.turnRecords) ? page.turnRecords : [])
      .sort((a, b) => Number(a?.turnNo || 0) - Number(b?.turnNo || 0));
    if (members.length !== count) return fail('native-slot-membership-incomplete');
    const membersByOrder = new Map(
      members.map((member) => [Math.max(0, Number(member?.turnNo || 0) || 0), member])
    );
    if (membersByOrder.size !== count || membersByOrder.has(0)) {
      return fail('native-slot-membership-ambiguous');
    }
    const exactMounted = [];
    const seenNativeOrdinals = new Set();
    let sections = [];
    try { sections = Array.from(document.querySelectorAll(TURN_HOST_SEL)); } catch {}
    for (const section of sections) {
      try {
        if (section.closest?.(`${TITLE_LIST_SYNTH_SEL}, ${TITLE_LIST_SUFFIX_SEL}`)) continue;
      } catch {}
      const mountedIdentity = nativeTurnSlotMountedIdentity(section, membersByOrder, expectedSlotCount);
      if (mountedIdentity?.match !== true) continue;
      const identity = Object.freeze({
        ordinal: mountedIdentity.ordinal,
        order: mountedIdentity.order,
        role: mountedIdentity.role,
        id: mountedIdentity.id,
        testId: mountedIdentity.testId,
      });
      if (seenNativeOrdinals.has(identity.ordinal)) {
        return fail('native-slot-mounted-identity-ambiguous');
      }
      seenNativeOrdinals.add(identity.ordinal);
      exactMounted.push({ section, identity });
    }
    if (!exactMounted.length) return fail('native-slot-calibration-unavailable');
    let activeThread = null;
    try { activeThread = document.querySelector?.('#thread') || null; } catch {}
    if (!activeThread?.isConnected) return fail('native-slot-active-thread-unavailable');

    // A section's local only-child anchor may stop at different host wrapper
    // depths. Project every exact section to a direct child of each common
    // ancestor candidate instead of requiring those local anchor parents to
    // match. Candidates are visited from deepest to shallowest.
    const directChildUnder = (candidateRoot, section) => {
      if (!candidateRoot || !section || candidateRoot === section) return null;
      let node = section;
      while (node?.parentElement && node.parentElement !== candidateRoot) {
        node = node.parentElement;
      }
      return node?.parentElement === candidateRoot ? node : null;
    };
    const commonRoots = [];
    let ancestor = exactMounted[0].section?.parentElement || null;
    while (ancestor) {
      let insideActiveThread = false;
      try {
        insideActiveThread = ancestor === activeThread || activeThread.contains?.(ancestor);
      } catch {}
      if (
        insideActiveThread
        && exactMounted.every((entry) => ancestor.contains?.(entry.section))
      ) commonRoots.push(ancestor);
      if (ancestor === activeThread) break;
      ancestor = ancestor.parentElement;
    }
    if (!commonRoots.length) return fail('native-slot-flow-root-unavailable');

    const exactBySection = new Map(exactMounted.map((entry) => [entry.section, entry]));
    let selected = null;
    let deepestFailure = null;
    for (const candidateRoot of commonRoots) {
      const directSlots = new Map();
      let collision = false;
      for (const entry of exactMounted) {
        const directSlot = directChildUnder(candidateRoot, entry.section);
        if (!directSlot || isNativeTurnSlotExcluded(directSlot) || directSlots.has(directSlot)) {
          collision = true;
          break;
        }
        directSlots.set(directSlot, entry);
      }
      if (collision) {
        deepestFailure ||= {
          reason: 'native-slot-mounted-slot-collision',
          flowRoot: candidateRoot,
          actualSlotCount: 0,
        };
        continue;
      }
      const structuralSignatures = new Set(
        Array.from(directSlots.keys())
          .map((node) => nativeTurnSlotClassSignature(node))
          .filter(Boolean)
      );
      if (!structuralSignatures.size) {
        deepestFailure ||= {
          reason: 'native-slot-structural-signature-unavailable',
          flowRoot: candidateRoot,
          actualSlotCount: 0,
        };
        continue;
      }
      const candidateSlots = [];
      let mountedStructureInvalid = false;
      for (const node of Array.from(candidateRoot.children || [])) {
        if (isNativeTurnSlotExcluded(node) || String(node.tagName || '').toUpperCase() !== 'DIV') continue;
        let nodeSections = [];
        try {
          nodeSections = Array.from(node.querySelectorAll?.(TURN_HOST_SEL) || []);
          if (node.matches?.(TURN_HOST_SEL)) nodeSections.unshift(node);
        } catch {}
        if (nodeSections.length) {
          const exactEntries = nodeSections
            .map((section) => exactBySection.get(section) || null)
            .filter(Boolean);
          if (
            nodeSections.length !== 1
            || exactEntries.length !== 1
            || directSlots.get(node) !== exactEntries[0]
          ) {
            mountedStructureInvalid = true;
            break;
          }
          candidateSlots.push(node);
          continue;
        }
        if (
          nativeTurnSlotLastKnownHeight(node)
          && structuralSignatures.has(nativeTurnSlotClassSignature(node))
        ) candidateSlots.push(node);
      }
      if (mountedStructureInvalid) {
        deepestFailure ||= {
          reason: 'native-slot-mounted-structure-invalid',
          flowRoot: candidateRoot,
          actualSlotCount: candidateSlots.length,
        };
        continue;
      }
      if (candidateSlots.length !== expectedSlotCount) {
        deepestFailure ||= {
          reason: 'native-slot-count-mismatch',
          flowRoot: candidateRoot,
          actualSlotCount: candidateSlots.length,
        };
        continue;
      }
      const calibrationIdentities = [];
      let calibrationMismatch = false;
      for (let index = 0; index < candidateSlots.length; index += 1) {
        const exact = directSlots.get(candidateSlots[index]) || null;
        if (!exact) continue;
        if (exact.identity.ordinal !== index + 1) {
          calibrationMismatch = true;
          break;
        }
        calibrationIdentities.push(exact.identity);
      }
      if (calibrationMismatch) {
        deepestFailure ||= {
          reason: 'native-slot-calibration-mismatch',
          flowRoot: candidateRoot,
          actualSlotCount: candidateSlots.length,
        };
        continue;
      }
      if (calibrationIdentities.length < 3) {
        deepestFailure ||= {
          reason: 'native-slot-calibration-insufficient',
          flowRoot: candidateRoot,
          actualSlotCount: candidateSlots.length,
        };
        continue;
      }
      selected = {
        flowRoot: candidateRoot,
        candidates: candidateSlots,
        exactSlots: directSlots,
        calibrationIdentities,
      };
      break;
    }
    if (!selected) return fail(
      deepestFailure?.reason || 'native-slot-flow-root-unavailable',
      {
        flowRoot: deepestFailure?.flowRoot || null,
        actualSlotCount: deepestFailure?.actualSlotCount || 0,
      }
    );
    const {
      flowRoot,
      candidates,
      exactSlots,
      calibrationIdentities,
    } = selected;
    let current = null;
    try { current = rt[TITLE_LIST_EFFECTIVE_METHOD.STATUS]?.() || null; } catch {}
    if (collapsedBoundaryStatusIdentity(before) !== collapsedBoundaryStatusIdentity(current)) {
      return fail('native-slot-authority-changed', {
        flowRoot,
        actualSlotCount: candidates.length,
      });
    }
    const slots = candidates.map((element, index) => {
      const exact = exactSlots.get(element) || null;
      return {
        ordinal: index + 1,
        element,
        mountedTestId: exact?.identity?.testId || '',
        mountedQId: exact?.identity?.role === 'user' ? exact.identity.id : '',
        mountedAId: exact?.identity?.role === 'assistant' ? exact.identity.id : '',
        structuralClassification: exact ? 'mounted-exact' : 'sectionless-last-known-height',
        generation,
        fingerprint,
      };
    });
    return frozenNativeTurnSlotSequence({
      ready: true,
      reason: 'ready',
      flowRoot,
      expectedSlotCount,
      actualSlotCount: slots.length,
      calibrated: true,
      slots,
      generation,
      fingerprint,
      source,
      count,
      calibrationIdentities,
    });
  }

  // Legacy exact-mounted boundary gate remains only as a conservative
  // structural fallback for hosts that do not expose the proven persistent
  // native-slot sequence.
  function getCollapsedExactBoundaryReadiness(pageNum = 0) {
    const num = Math.max(1, Number(pageNum || 0) || 0);
    const rt = TURN_RUNTIME();
    if (!rt || !num) {
      return frozenCollapsedBoundaryResult({ pageNum: num, reason: 'readiness-api-unavailable' });
    }
    let before = null;
    let after = null;
    let model = null;
    try {
      before = rt[TITLE_LIST_EFFECTIVE_METHOD.STATUS]?.() || null;
      model = buildTitleListPresentationPageModel();
      after = rt[TITLE_LIST_EFFECTIVE_METHOD.STATUS]?.() || null;
    } catch {
      return frozenCollapsedBoundaryResult({ pageNum: num, reason: 'authority-read-failed' });
    }
    const count = Math.max(0, Number(before?.count || 0) || 0);
    const fingerprint = String(before?.canonicalFingerprint || '');
    const generation = Math.max(0, Number(before?.generation || 0) || 0);
    const source = String(before?.source || '');
    const fail = (reason, extra = {}) => frozenCollapsedBoundaryResult({
      pageNum: num,
      reason,
      generation,
      fingerprint,
      source,
      count,
      ...extra,
    });
    if (
      !model?.coherent
      || count < 1
      || model.count !== count
      || model.source !== source
      || !generation
      || !fingerprint
      || collapsedBoundaryStatusIdentity(before) !== collapsedBoundaryStatusIdentity(after)
    ) return fail('authority-not-coherent');
    const page = model.pages.find((entry) => entry.pageNo === num) || null;
    const nextPage = model.pages.find((entry) => entry.pageNo === num + 1) || null;
    if (!page) return fail('page-outside-presentation');
    if (!nextPage) return fail('next-page-native-start-unavailable');
    const startMember = page.turnRecords[0] || null;
    const nextStartMember = nextPage.turnRecords[0] || null;
    const startIdentity = {
      order: Number(startMember?.turnNo || 0),
      qId: String(startMember?.questionId || ''),
    };
    const nextStartIdentity = {
      order: Number(nextStartMember?.turnNo || 0),
      qId: String(nextStartMember?.questionId || ''),
    };
    // Discovery pass: bind the start member's current native surface, then take
    // the flow root from that surface and re-resolve BOTH boundaries against it
    // so wrapper coherence is proved for the pair, not assumed from one side.
    const startProbe = collapsedBoundaryNativeStartSurface(startMember);
    if (!startProbe.ok) return fail('native-start-not-mounted', { startIdentity, nextStartIdentity });
    const probedStart = getTurnAnchorNode(startProbe.section);
    const flowRoot = probedStart?.parentElement || null;
    if (!flowRoot) return fail('native-layout-boundary-unresolved', { startIdentity, nextStartIdentity });
    const startResolved = collapsedBoundaryNativeStartSurface(startMember, flowRoot);
    const nextStartResolved = collapsedBoundaryNativeStartSurface(nextStartMember, flowRoot);
    if (!startResolved.ok) return fail('native-start-not-mounted', { startIdentity, nextStartIdentity });
    if (!nextStartResolved.ok) return fail('next-page-native-start-not-mounted', { startIdentity, nextStartIdentity });
    const nativeStart = getTurnAnchorNode(startResolved.section);
    const nextPageNativeStart = getTurnAnchorNode(nextStartResolved.section);
    if (
      !nativeStart
      || !nextPageNativeStart
      || nativeStart.parentElement !== flowRoot
      || nextPageNativeStart.parentElement !== flowRoot
    ) return fail('native-layout-boundary-unresolved', { startIdentity, nextStartIdentity });
    let ordered = false;
    try {
      ordered = !!(nativeStart.compareDocumentPosition(nextPageNativeStart) & Node.DOCUMENT_POSITION_FOLLOWING);
    } catch {}
    if (!ordered) {
      return fail('native-layout-boundary-order-invalid', {
        flowRoot,
        nativeStart,
        nextPageNativeStart,
        startIdentity,
        nextStartIdentity,
      });
    }
    let current = null;
    try { current = rt[TITLE_LIST_EFFECTIVE_METHOD.STATUS]?.() || null; } catch {}
    if (collapsedBoundaryStatusIdentity(before) !== collapsedBoundaryStatusIdentity(current)) {
      return fail('authority-changed-during-readiness', { startIdentity, nextStartIdentity });
    }
    return frozenCollapsedBoundaryResult({
      ready: true,
      reason: 'ready',
      pageNum: num,
      flowRoot,
      nativeStart,
      nextPageNativeStart,
      startIdentity,
      nextStartIdentity,
      generation,
      fingerprint,
      source,
      count,
    });
  }

  // Retained diagnostic compatibility for the native-slot retirement stage.
  // Production collapse readiness no longer calls this legacy resolver path.
  function getLegacyCollapsedNativeBoundaryReadinessDiagnostic(pageNum = 0) {
    const num = Math.max(1, Number(pageNum || 0) || 0);
    const sequence = typeof resolveNativeTurnSlotSequence === 'function'
      ? resolveNativeTurnSlotSequence()
      : Object.freeze({ ready: false, reason: 'native-slot-resolver-unavailable' });
    if (sequence.ready) {
      const pageSizeNative = TITLE_LIST_PAGE_SIZE * 2;
      const startOrdinal = ((num - 1) * pageSizeNative) + 1;
      const endOrdinal = Math.min(num * pageSizeNative, sequence.expectedSlotCount);
      if (
        startOrdinal > sequence.expectedSlotCount
        || endOrdinal < startOrdinal
      ) {
        return frozenCollapsedBoundaryResult({
          pageNum: num,
          reason: 'page-outside-presentation',
          structuralReason: 'native-slot-page-outside-presentation',
          generation: sequence.generation,
          fingerprint: sequence.fingerprint,
          source: sequence.source,
          count: sequence.count,
        });
      }
      const nativeStart = sequence.slots[startOrdinal - 1]?.element || null;
      const nextPageNativeStart = sequence.slots[endOrdinal]?.element || null;
      if (
        !nativeStart
        || nativeStart.parentElement !== sequence.flowRoot
        || (nextPageNativeStart && nextPageNativeStart.parentElement !== sequence.flowRoot)
      ) {
        return frozenCollapsedBoundaryResult({
          pageNum: num,
          reason: 'collapsed-exact-boundary-unavailable',
          structuralReason: 'native-slot-range-incoherent',
          generation: sequence.generation,
          fingerprint: sequence.fingerprint,
          source: sequence.source,
          count: sequence.count,
        });
      }
      return frozenCollapsedBoundaryResult({
        ready: true,
        reason: 'ready-native-turn-slots',
        pageNum: num,
        flowRoot: sequence.flowRoot,
        nativeStart,
        nextPageNativeStart,
        nativeSlotSequence: sequence,
        nativeStartOrdinal: startOrdinal,
        nativeEndOrdinal: endOrdinal,
        startIdentity: {
          order: Math.ceil(startOrdinal / 2),
          testId: `conversation-turn-${String(startOrdinal)}`,
        },
        nextStartIdentity: nextPageNativeStart ? {
          order: Math.ceil((endOrdinal + 1) / 2),
          testId: `conversation-turn-${String(endOrdinal + 1)}`,
        } : null,
        generation: sequence.generation,
        fingerprint: sequence.fingerprint,
        source: sequence.source,
        count: sequence.count,
      });
    }
    const exact = typeof getCollapsedExactBoundaryReadiness === 'function'
      ? getCollapsedExactBoundaryReadiness(num)
      : (() => {
          // Extraction-compatible legacy fallback for older real-source
          // validators. Production always owns getCollapsedExactBoundaryReadiness.
          const rt = TURN_RUNTIME();
          if (!rt || !num) {
            return frozenCollapsedBoundaryResult({ pageNum: num, reason: 'readiness-api-unavailable' });
          }
          let before = null;
          let after = null;
          let model = null;
          try {
            before = rt[TITLE_LIST_EFFECTIVE_METHOD.STATUS]?.() || null;
            model = buildTitleListPresentationPageModel();
            after = rt[TITLE_LIST_EFFECTIVE_METHOD.STATUS]?.() || null;
          } catch {
            return frozenCollapsedBoundaryResult({ pageNum: num, reason: 'authority-read-failed' });
          }
          const count = Math.max(0, Number(before?.count || 0) || 0);
          const fingerprint = String(before?.canonicalFingerprint || '');
          const generation = Math.max(0, Number(before?.generation || 0) || 0);
          const source = String(before?.source || '');
          const fail = (reason, extra = {}) => frozenCollapsedBoundaryResult({
            pageNum: num,
            reason,
            generation,
            fingerprint,
            source,
            count,
            ...extra,
          });
          if (
            !model?.coherent
            || count < 1
            || model.count !== count
            || model.source !== source
            || !generation
            || !fingerprint
            || collapsedBoundaryStatusIdentity(before) !== collapsedBoundaryStatusIdentity(after)
          ) return fail('authority-not-coherent');
          const page = model.pages.find((entry) => entry.pageNo === num) || null;
          const nextPage = model.pages.find((entry) => entry.pageNo === num + 1) || null;
          if (!page) return fail('page-outside-presentation');
          if (!nextPage) return fail('next-page-native-start-unavailable');
          const startMember = page.turnRecords[0] || null;
          const nextStartMember = nextPage.turnRecords[0] || null;
          const startIdentity = {
            order: Number(startMember?.turnNo || 0),
            qId: String(startMember?.questionId || ''),
          };
          const nextStartIdentity = {
            order: Number(nextStartMember?.turnNo || 0),
            qId: String(nextStartMember?.questionId || ''),
          };
          // Discovery pass: bind the start member's current native surface, then take
          // the flow root from that surface and re-resolve BOTH boundaries against it
          // so wrapper coherence is proved for the pair, not assumed from one side.
          const startProbe = collapsedBoundaryNativeStartSurface(startMember);
          if (!startProbe.ok) return fail('native-start-not-mounted', { startIdentity, nextStartIdentity });
          const probedStart = getTurnAnchorNode(startProbe.section);
          const flowRoot = probedStart?.parentElement || null;
          if (!flowRoot) return fail('native-layout-boundary-unresolved', { startIdentity, nextStartIdentity });
          const startResolved = collapsedBoundaryNativeStartSurface(startMember, flowRoot);
          const nextStartResolved = collapsedBoundaryNativeStartSurface(nextStartMember, flowRoot);
          if (!startResolved.ok) return fail('native-start-not-mounted', { startIdentity, nextStartIdentity });
          if (!nextStartResolved.ok) return fail('next-page-native-start-not-mounted', { startIdentity, nextStartIdentity });
          const nativeStart = getTurnAnchorNode(startResolved.section);
          const nextPageNativeStart = getTurnAnchorNode(nextStartResolved.section);
          if (
            !nativeStart
            || !nextPageNativeStart
            || nativeStart.parentElement !== flowRoot
            || nextPageNativeStart.parentElement !== flowRoot
          ) return fail('native-layout-boundary-unresolved', { startIdentity, nextStartIdentity });
          let ordered = false;
          try {
            ordered = !!(nativeStart.compareDocumentPosition(nextPageNativeStart) & Node.DOCUMENT_POSITION_FOLLOWING);
          } catch {}
          if (!ordered) {
            return fail('native-layout-boundary-order-invalid', {
              flowRoot,
              nativeStart,
              nextPageNativeStart,
              startIdentity,
              nextStartIdentity,
            });
          }
          let current = null;
          try { current = rt[TITLE_LIST_EFFECTIVE_METHOD.STATUS]?.() || null; } catch {}
          if (collapsedBoundaryStatusIdentity(before) !== collapsedBoundaryStatusIdentity(current)) {
            return fail('authority-changed-during-readiness', { startIdentity, nextStartIdentity });
          }
          return frozenCollapsedBoundaryResult({
            ready: true,
            reason: 'ready',
            pageNum: num,
            flowRoot,
            nativeStart,
            nextPageNativeStart,
            startIdentity,
            nextStartIdentity,
            generation,
            fingerprint,
            source,
            count,
          });
        })();
    if (exact.ready) return exact;
    return frozenCollapsedBoundaryResult({
      ...exact,
      structuralReason: sequence.reason,
    });
  }

  function getCollapsedNativeBoundaryReadiness(pageNum = 0) {
    const num = Math.max(1, Number(pageNum || 0) || 0);
    const capability = typeof getPageCollapseCapability === 'function'
      ? getPageCollapseCapability(num)
      : Object.freeze({
        version: 1,
        reason: 'readiness-api-unavailable',
        productReason: 'page-loading',
        prerequisitesReady: false,
        activationBlockReason: 'readiness-api-unavailable',
        generation: 0,
        effectiveFingerprint: '',
      });
    const prerequisitesReady = capability.prerequisitesReady === true;
    const activationReady = capability.activationReady === true;
    return frozenCollapsedBoundaryResult({
      ready: activationReady,
      reason: activationReady
        ? null
        : String(capability.activationBlockReason || capability.reason || 'collapsed-exact-boundary-unavailable'),
      structuralReason: activationReady
        ? null
        : String(capability.reason || 'layout-incomplete'),
      pageNum: num,
      generation: capability.generation,
      fingerprint: capability.effectiveFingerprint,
      source: 'rendered-boundary-collapse-capability',
      productReason: capability.productReason,
      prerequisitesReady,
      activationReady,
      capabilityVersion: capability.version,
      legacyNativeSlotConsulted: false,
    });
  }

  function isCollapsedNativeRangeExcluded(node = null) {
    if (!node || node.nodeType !== 1) return true;
    try {
      if (node.matches?.(
        '.cgxui-chat-page-divider, .cgxui-pgnw-page-divider,'
        + ' [data-cgxui="chat-page-title-list-synth"],'
        + ' [data-h2o-chat-page-boundary], #cgx-mm-root,'
        + ' form, [contenteditable="true"], [data-cgxui-owner="mnmp"]'
      )) return true;
      if (node.closest?.('#cgx-mm-root')) return true;
    } catch {}
    return false;
  }

  function directNodePresentationPages(node = null) {
    const pages = new Set();
    let sections = [];
    try { sections = Array.from(node?.querySelectorAll?.(TURN_HOST_SEL) || []); } catch {}
    if (node?.matches?.(TURN_HOST_SEL)) sections.unshift(node);
    for (const section of sections) {
      const testNo = turnNumberOfSection(section);
      if (!testNo) continue;
      const order = Math.ceil(testNo / 2);
      if (order) pages.add(Math.ceil(order / TITLE_LIST_PAGE_SIZE));
    }
    return pages;
  }

  function releaseCollapsedNativeRange(pageNum = 0, flowRoot = null) {
    const num = Math.max(1, Number(pageNum || 0) || 0);
    let nodes = [];
    try {
      const root = flowRoot?.querySelectorAll ? flowRoot : document;
      nodes = Array.from(root.querySelectorAll(`[${ATTR_CHAT_PAGE_NATIVE_HIDDEN}="${String(num)}"]`));
      if (root?.matches?.(`[${ATTR_CHAT_PAGE_NATIVE_HIDDEN}="${String(num)}"]`)) nodes.unshift(root);
    } catch {}
    let released = 0;
    for (const node of new Set(nodes)) {
      try {
        node.removeAttribute(ATTR_CHAT_PAGE_NATIVE_HIDDEN);
        released += 1;
      } catch {}
    }
    return released;
  }

  function applyCollapsedNativeRange(plan = null) {
    const num = Math.max(1, Number(plan?.pageNum || 0) || 0);
    /* Stage 2 Pass 3: when the plan carries a current mounted canonical subset
       the execution unit is that subset — sparse by nature, and requiring no
       whole-page flow root, no wrapper pair and no contiguous interval. Prior
       attribute state is captured per candidate so rollback (model B) can
       restore scalars onto re-resolved CURRENT nodes. The legacy contiguous
       branch below is unchanged for the full-interval world. */
    if (Array.isArray(plan?.mountedCandidates)) {
      const subset = plan.mountedCandidates;
      const restorable = [];
      for (const entry of subset) {
        const node = entry?.node || null;
        if (!node || node.isConnected !== true || pageCollapseRangeH2OOwned(node)) {
          return { ok: false, status: 'rendered-collapse-subset-stale', hidden: 0, mutations: 0, stamped: [], restorable: [] };
        }
      }
      const stamped = [];
      for (const entry of subset) {
        const node = entry.node;
        const priorValue = node.getAttribute?.(ATTR_CHAT_PAGE_NATIVE_HIDDEN);
        try {
          if (String(priorValue || '') !== String(num)) node.setAttribute(ATTR_CHAT_PAGE_NATIVE_HIDDEN, String(num));
          restorable.push({ questionId: entry.questionId, turnNo: entry.turnNo, priorValue: priorValue == null ? null : String(priorValue) });
          stamped.push(node);
        } catch (error) {
          /* All-or-nothing within the subset: hand back everything already
             mutated so the caller can roll every one of them back.

             The guard is right and stays exactly as it is; what was missing is
             WHY. Discarding the exception here left a live stall reporting
             nothing but a generic transient failure, so the thrown reason is
             carried out as a bounded scalar — no exception object, no node,
             nothing persisted — beside the unchanged status. */
          const reason = String(error?.message || error || 'stamp-write-failed').slice(0, 200);
          return {
            ok: false,
            status: 'rendered-collapse-stamp-failed',
            reason,
            hidden: stamped.length,
            mutations: stamped.length,
            stamped,
            restorable,
          };
        }
      }
      return { ok: true, status: 'collapsed', hidden: subset.length, mutations: stamped.length, stamped, restorable };
    }
    const root = plan?.flowRoot || null;
    const candidates = Array.isArray(plan?.hostWrappers) ? plan.hostWrappers : [];
    if (
      plan?.atomicRenderedBoundaryPlan !== true
      || !root
      || root?.isConnected !== true
      || !candidates.length
      || plan?.endWrapper?.parentElement !== root
      || candidates.includes(plan.endWrapper)
    ) {
      return {
        ok: false,
        status: 'rendered-collapse-plan-invalid',
        hidden: 0,
        mutations: 0,
        stamped: [],
      };
    }
    for (const node of candidates) {
      if (
        !node
        || node?.isConnected !== true
        || node?.parentElement !== root
        || pageCollapseRangeH2OOwned(node)
      ) {
        return {
          ok: false,
          status: 'rendered-collapse-plan-stale',
          hidden: 0,
          mutations: 0,
          stamped: [],
        };
      }
      const existing = String(node.getAttribute?.(ATTR_CHAT_PAGE_NATIVE_HIDDEN) || '');
      if (existing) {
        return {
          ok: false,
          status: 'rendered-collapse-stamp-conflict',
          hidden: 0,
          mutations: 0,
          stamped: [],
        };
      }
    }
    const stamped = [];
    try {
      for (const node of candidates) {
        if (node.getAttribute?.(ATTR_CHAT_PAGE_NATIVE_HIDDEN) === String(num)) continue;
        node.setAttribute(ATTR_CHAT_PAGE_NATIVE_HIDDEN, String(num));
        stamped.push(node);
      }
    } catch {
      return {
        ok: false,
        status: 'rendered-collapse-stamp-failed',
        hidden: stamped.length,
        mutations: stamped.length,
        stamped,
      };
    }
    return {
      ok: true,
      status: 'collapsed',
      hidden: candidates.length,
      mutations: stamped.length,
      stamped,
    };
  }

  function collapsedBoundaryDividers(pageNum = 0) {
    const num = Math.max(1, Number(pageNum || 0) || 0);
    try {
      return Array.from(document.querySelectorAll(
        `.cgxui-chat-page-divider[data-page-num="${String(num)}"], .cgxui-pgnw-page-divider[data-page-num="${String(num)}"]`
      ));
    } catch {
      return [];
    }
  }

  function setCollapseFeedbackAttribute(node = null, name = '', value = null) {
    if (!node || !name) return 0;
    const next = value == null ? null : String(value);
    let current = null;
    try { current = node.getAttribute(name); } catch {}
    if (current === next) return 0;
    try {
      if (next == null) node.removeAttribute(name);
      else node.setAttribute(name, next);
      return 1;
    } catch {
      return 0;
    }
  }

  function collapseUnavailableStatusNode(divider = null, pageNum = 0, create = false) {
    if (!divider?.querySelector) return null;
    let node = null;
    try { node = divider.querySelector(`[${ATTR_COLLAPSE_FEEDBACK}]`); } catch {}
    if (node || !create) return node;
    try {
      node = document.createElement('div');
      node.className = 'cgxui-chat-page-collapse-feedback';
      node.setAttribute(ATTR_COLLAPSE_FEEDBACK, String(Math.max(1, Number(pageNum || 0) || 1)));
      node.setAttribute('data-cgxui-owner', 'chtpgs');
      node.setAttribute('role', 'status');
      node.setAttribute('aria-live', 'polite');
      node.setAttribute('aria-atomic', 'true');
      node.setAttribute('aria-hidden', 'true');
      node.hidden = true;
      divider.appendChild(node);
    } catch {
      node = null;
    }
    return node;
  }

  function clearCollapseUnavailableFeedback(pageNum = 0) {
    const num = Math.max(1, Number(pageNum || 0) || 0);
    let mutations = 0;
    for (const divider of collapsedBoundaryDividers(num)) {
      const node = collapseUnavailableStatusNode(divider, num, false);
      if (!node) continue;
      if (node.hidden !== true) {
        try { node.hidden = true; mutations += 1; } catch {}
      }
      mutations += setCollapseFeedbackAttribute(node, 'aria-hidden', 'true');
      mutations += setCollapseFeedbackAttribute(node, ATTR_COLLAPSE_REASON, null);
      try {
        if (node.textContent !== '') {
          node.textContent = '';
          mutations += 1;
        }
      } catch {}
      try { node.removeAttribute('title'); } catch {}
    }
    return mutations;
  }

  function applyCollapsedBoundaryControlState(pageNum = 0, chatId = '', readiness = null) {
    const num = Math.max(1, Number(pageNum || 0) || 0);
    const id = String(chatId || resolveChatId()).trim();
    const titleListActive = isTitleListActive(num, id);
    // A ready capability whose transaction failed transiently stays
    // RETRYABLE: the control must not render blocked (and must not stamp
    // the unavailable readiness the skin styles as disabled) — the
    // transient feedback message already reports the failed attempt.
    const transientFailure = String(readiness?.productReason || '') === 'transient-failure';
    const blocked = !titleListActive && readiness?.ready !== true && !transientFailure;
    const diagnosticReason = blocked
      ? String(readiness?.structuralReason || readiness?.reason || 'readiness-api-unavailable')
      : '';
    const structuralFailure = blocked && !!String(readiness?.structuralReason || '').trim();
    const actionTitle = titleListActive
      ? `Expand Page ${num}`
      : blocked
        ? 'Collapse currently unavailable'
        : `Collapse Page ${num}`;
    const ariaLabel = titleListActive
      ? `Page ${num}. Expand page titles.`
      : blocked
        ? structuralFailure
          ? `Page ${num}. Collapse temporarily unavailable because the conversation layout is incomplete.`
          : `Page ${num}. Collapse currently unavailable.`
        : `Page ${num}. Collapse page titles.`;
    let mutations = 0;
    for (const divider of collapsedBoundaryDividers(num)) {
      mutations += setCollapseFeedbackAttribute(
        divider,
        ATTR_COLLAPSE_READINESS,
        blocked ? COLLAPSE_UNAVAILABLE_STATUS : null
      );
      mutations += setCollapseFeedbackAttribute(
        divider,
        ATTR_COLLAPSE_REASON,
        blocked ? diagnosticReason : null
      );
      const dot = divider.querySelector?.('.cgxui-chat-page-divider-dot, .cgxui-pgnw-page-divider-dot') || null;
      if (!dot) continue;
      mutations += setCollapseFeedbackAttribute(dot, 'aria-hidden', null);
      mutations += setCollapseFeedbackAttribute(dot, 'role', 'button');
      mutations += setCollapseFeedbackAttribute(dot, 'tabindex', '0');
      mutations += setCollapseFeedbackAttribute(dot, 'aria-disabled', null);
      mutations += setCollapseFeedbackAttribute(dot, ATTR_COLLAPSE_CONTROL_STATE, blocked ? 'blocked' : 'ready');
      mutations += setCollapseFeedbackAttribute(dot, 'title', actionTitle);
      mutations += setCollapseFeedbackAttribute(dot, 'aria-label', ariaLabel);
    }
    if (!blocked) clearCollapseUnavailableFeedback(num);
    return {
      ok: true,
      blocked,
      reason: diagnosticReason,
      productReason: String(readiness?.productReason || ''),
      pageNum: num,
      mutations,
    };
  }

  function showCollapseUnavailableFeedback(pageNum = 0, chatId = '', readiness = null) {
    const num = Math.max(1, Number(pageNum || 0) || 0);
    const id = String(chatId || resolveChatId()).trim();
    const structuralReason = String(readiness?.structuralReason || '').trim();
    const reason = structuralReason || String(readiness?.reason || 'readiness-api-unavailable');
    // A ready capability whose transaction failed is neither a missing next
    // boundary nor an incomplete layout — say only that it can be retried.
    const message = String(readiness?.productReason || '') === 'transient-failure'
      ? COLLAPSE_TRANSIENT_FAILURE_MESSAGE
      : structuralReason
        ? COLLAPSE_LAYOUT_INCOMPLETE_MESSAGE
        : COLLAPSE_UNAVAILABLE_MESSAGE;
    applyCollapsedBoundaryControlState(num, id, readiness);
    let visible = 0;
    for (const divider of collapsedBoundaryDividers(num)) {
      const node = collapseUnavailableStatusNode(divider, num, true);
      if (!node) continue;
      try { node.textContent = message; } catch {}
      try { node.hidden = false; } catch {}
      setCollapseFeedbackAttribute(node, 'aria-hidden', 'false');
      setCollapseFeedbackAttribute(node, ATTR_COLLAPSE_REASON, reason);
      setCollapseFeedbackAttribute(node, 'title', reason);
      visible += 1;
    }
    return { ok: visible > 0, status: visible ? 'visible' : 'divider-unavailable', visible, reason };
  }

  function explicitCollapseFeedbackSource(source = '') {
    return /^chat-page-divider:(circle|keyboard-enter|keyboard-space)$/.test(String(source || '').trim());
  }

  function handleCollapseUnavailableActivation(pageNum = 0, chatId = '', readiness = null, source = '') {
    return failClosedCollapsedTitleList(pageNum, chatId, readiness, source);
  }

  function forwardCollapseControlKeyboardActivation(ev = null) {
    const key = String(ev?.key || '');
    if (key !== 'Enter' && key !== ' ' && key !== 'Spacebar') {
      return { ok: false, status: 'not-collapse-key' };
    }
    if (ev?.repeat === true) return { ok: false, status: 'repeat-ignored' };
    const dot = ev?.target?.closest?.('.cgxui-chat-page-divider-dot, .cgxui-pgnw-page-divider-dot');
    if (!dot) return { ok: false, status: 'control-missing' };
    const divider = dot.closest?.('.cgxui-chat-page-divider, .cgxui-pgnw-page-divider');
    const pageNum = getDividerPageNum(divider);
    if (!pageNum) return { ok: false, status: 'page-missing' };
    try { ev.preventDefault(); ev.stopPropagation(); } catch {}
    const source = key === 'Enter'
      ? 'chat-page-divider:keyboard-enter'
      : 'chat-page-divider:keyboard-space';
    // Keyboard converges on the same owner as pointer activation rather than
    // synthesising a click, so both paths share one reentrancy guard, one
    // capability evaluation and one attempt diagnostic.
    const result = executeAtomicPageCollapseTransaction(pageNum, source, {
      chatId: resolveChatId(),
    });
    return { ok: result?.ok === true, status: result?.ok === true ? 'forwarded' : String(result?.status || 'collapse-transaction-failed'), source };
  }

  function syncCollapsedBoundaryControlForPage(pageNum = 0, chatId = '') {
    const num = Math.max(1, Number(pageNum || 0) || 0);
    const id = String(chatId || resolveChatId()).trim();
    if (isTitleListActive(num, id)) {
      return applyCollapsedBoundaryControlState(num, id, { ready: true, reason: 'title-list-active' });
    }
    const readiness = getCollapsedNativeBoundaryReadiness(num);
    if (readiness.ready) {
      S.collapsedBoundaryDiagnostics.delete(collapsedNativeRangeKey(id, num));
    }
    return applyCollapsedBoundaryControlState(num, id, readiness);
  }

  function recordCollapsedBoundaryDiagnostic(pageNum = 0, readiness = null, source = '') {
    const num = Math.max(1, Number(pageNum || 0) || 0);
    const chatId = resolveChatId();
    const detail = Object.freeze({
      status: 'collapsed-exact-boundary-unavailable',
      reason: String(
        readiness?.structuralReason
        || readiness?.reason
        || 'collapsed-exact-boundary-unavailable'
      ),
      pageNum: num,
      chatId,
      generation: Math.max(0, Number(readiness?.generation || 0) || 0),
      fingerprint: String(readiness?.fingerprint || ''),
      source: String(source || ''),
    });
    S.collapsedBoundaryDiagnostics.set(collapsedNativeRangeKey(chatId, num), detail);
    applyCollapsedBoundaryControlState(num, chatId, readiness);
    try {
      W.dispatchEvent(new CustomEvent('h2o:turn:updated', {
        detail: { reason: detail.status, pageNum: num },
      }));
    } catch {}
    return detail;
  }

  function clearCollapsedBoundaryDiagnostic(pageNum = 0, chatId = '') {
    const num = Math.max(1, Number(pageNum || 0) || 0);
    const id = String(chatId || resolveChatId()).trim();
    S.collapsedBoundaryDiagnostics.delete(collapsedNativeRangeKey(id, num));
    const readiness = isTitleListActive(num, id)
      ? { ready: true, reason: 'title-list-active' }
      : getCollapsedNativeBoundaryReadiness(num);
    applyCollapsedBoundaryControlState(num, id, readiness);
  }

  function getCollapsedBoundaryDiagnostic(pageNum = 0, chatId = '') {
    return S.collapsedBoundaryDiagnostics.get(collapsedNativeRangeKey(chatId, pageNum)) || null;
  }

  function captureCollapsedPageViewportAnchor(pageNum = 0) {
    const num = Math.max(1, Number(pageNum || 0) || 0);
    let anchor = null;
    try {
      anchor = document.querySelector(
        `.cgxui-chat-page-divider[data-page-num="${String(num)}"], .cgxui-pgnw-page-divider[data-page-num="${String(num)}"]`
      );
    } catch {}
    if (!anchor?.isConnected) return null;
    let top = NaN;
    try { top = Number(anchor.getBoundingClientRect?.().top); } catch {}
    let scrollRoot = null;
    let current = anchor.parentElement;
    while (current && current !== document.body) {
      try {
        const style = getComputedStyle(current);
        if (
          /auto|scroll/.test(String(style?.overflowY || ''))
          && Number(current.scrollHeight || 0) > Number(current.clientHeight || 0)
        ) {
          scrollRoot = current;
          break;
        }
      } catch {}
      current = current.parentElement;
    }
    if (!scrollRoot) scrollRoot = document.scrollingElement || W;
    return Number.isFinite(top) ? { anchor, top, scrollRoot } : null;
  }

  function restoreCollapsedPageViewportAnchor(snapshot = null, tolerancePx = 12) {
    if (!snapshot?.anchor?.isConnected || !Number.isFinite(snapshot.top)) return false;
    let current = NaN;
    try { current = Number(snapshot.anchor.getBoundingClientRect?.().top); } catch {}
    if (!Number.isFinite(current)) return false;
    const delta = current - snapshot.top;
    if (Math.abs(delta) > 0.5) {
      try {
        if (snapshot.scrollRoot && snapshot.scrollRoot !== W && 'scrollTop' in snapshot.scrollRoot) {
          snapshot.scrollRoot.scrollTop += delta;
        } else {
          W.scrollBy?.(0, delta);
        }
      } catch { return false; }
    }
    try { current = Number(snapshot.anchor.getBoundingClientRect?.().top); } catch { return false; }
    if (!Number.isFinite(current)) return false;
    if (Math.abs(current - snapshot.top) <= Math.max(0, Number(tolerancePx || 0) || 0)) return true;
    // Geometric truncation: collapsing the very page the viewport sits in
    // legitimately shortens the scroll range, so the pre-collapse offset can
    // be unreachable rather than lost. When the scroll root is clamped at a
    // boundary and the anchor is visible in the viewport, the restore is as
    // good as geometry allows - rolling back a committed collapse over an
    // unreachable pixel offset failed the user's explicit action.
    try {
      const root = (snapshot.scrollRoot && snapshot.scrollRoot !== W && 'scrollTop' in snapshot.scrollRoot)
        ? snapshot.scrollRoot
        : (document.scrollingElement || null);
      const maxTop = root ? Math.max(0, Number(root.scrollHeight || 0) - Number(root.clientHeight || 0)) : 0;
      const at = root ? Number(root.scrollTop || 0) : Number(W.scrollY || 0);
      const clamped = root ? (at <= 1 || at >= maxTop - 1) : false;
      const rect = snapshot.anchor.getBoundingClientRect?.();
      const viewportH = Number(W.innerHeight || document.documentElement?.clientHeight || 0);
      const visible = !!rect && rect.bottom > 0 && rect.top < viewportH;
      if (clamped && visible) return true;
    } catch {}
    return false;
  }

  // ── Chat Page Divider -> MiniMap, one way only ───────────────────────────
  // The Chat Page Divider is the origin for cross-surface page state: a Chat
  // collapse or expansion mirrors onto the same MiniMap page. The MiniMap
  // owner writes only MiniMap state, so there is no path back into the Chat
  // page and no recursion. Direct MiniMap actions never reach this function.
  function propagateChatPageCollapseToMiniMap(pageNum = 0, chatId = '', collapsed = false) {
    const num = Math.max(1, Number(pageNum || 0) || 0);
    const id = String(chatId || resolveChatId()).trim();
    if (!num || !id) return { ok: false, status: 'page-missing' };
    // The atomic transaction is a genuine Chat action, so it enters the same
    // ordered lane as the visuals push. Advancing twice for one user action is
    // harmless: MiniMap only ever compares "newer than what I applied".
    //
    // The revision is resolved OUTSIDE the propagation guard on purpose. If the
    // ordering owner is unreachable the push still goes out unordered, exactly
    // as it did before this section existed — a missing revision must never
    // turn into a dropped propagation.
    const source = 'chat-page-divider:atomic-transaction';
    let chatRev = 0;
    try { chatRev = Math.max(0, Number(chatPageRevFor(num, id, { source }) || 0) || 0); } catch { chatRev = 0; }
    const pushOpts = { source, propagate: true };
    if (chatRev > 0) { pushOpts.mode = 'chat-sync'; pushOpts.chatRev = chatRev; }
    try {
      MM_CORE_PAGES()?.setMiniMapPageCollapsed?.(num, !!collapsed, id, pushOpts);
      return { ok: true, status: 'propagated', pageNum: num, collapsed: !!collapsed };
    } catch {
      return { ok: false, status: 'minimap-unavailable', pageNum: num };
    }
  }

  function setAtomicTitleListMemory(chatId = '', pageNum = 0, active = false) {
    const id = String(chatId || resolveChatId()).trim();
    const num = Math.max(1, Number(pageNum || 0) || 0);
    const pages = S.titleListPagesByChat.get(id) instanceof Set
      ? new Set(S.titleListPagesByChat.get(id))
      : new Set();
    if (active) pages.add(num);
    else pages.delete(num);
    S.titleListPagesByChat.set(id, pages);
    return pages;
  }

  function setAtomicCollapsedPageMemory(chatId = '', pageNum = 0, active = false) {
    const id = String(chatId || resolveChatId()).trim();
    const num = Math.max(1, Number(pageNum || 0) || 0);
    const pages = S.collapsedPagesByChat.get(id) instanceof Set
      ? new Set(S.collapsedPagesByChat.get(id))
      : new Set();
    if (active) pages.add(num);
    else pages.delete(num);
    S.collapsedPagesByChat.set(id, pages);
    return pages;
  }

  function prepareDetachedPageTitleList(plan = null) {
    const members = Array.isArray(plan?.titleRows) ? plan.titleRows : [];
    if (
      !plan
      || !members.length
      || members.length !== plan.expectedTitleRowCount
      || getSyntheticTitleListContainers(plan.pageNum).length
    ) return { ok: false, status: 'detached-title-list-preconditions-failed' };
    const at = AT_PUBLIC();
    if (typeof at?.buildDetachedBar !== 'function') {
      return { ok: false, status: 'detached-title-list-factory-unavailable' };
    }
    let container = null;
    try {
      container = document.createElement('div');
      container.className = 'cgxui-chat-page-title-list-synth';
      container.setAttribute('data-cgxui', 'chat-page-title-list-synth');
      container.setAttribute('data-cgxui-owner', 'chtpgs');
      container.setAttribute('data-page-num', String(plan.pageNum));
      container.setAttribute('data-h2o-title-stack-owner', '1C1b:atomic-rendered-collapse');
      container.setAttribute('data-h2o-title-stack-id', titleListStackDomId(plan.pageNum));
      container.id = titleListStackDomId(plan.pageNum);
      container.addEventListener('dblclick', onSyntheticTitleRowDblClick, true);
      container._h2oTitleListDblClickHandler = onSyntheticTitleRowDblClick;
    } catch {
      return { ok: false, status: 'detached-title-list-container-failed' };
    }
    const rows = [];
    try {
      for (const member of members) {
        const resolved = member.type === 'answer'
          ? resolveSyntheticRowTitle(member)
          : { text: '', source: 'no-answer', rank: 3 };
        const bar = at.buildDetachedBar({
          answerId: member.type === 'answer'
            ? member.answerId
            : `no-answer:${member.questionId}`,
          turnNo: member.turnNo,
          title: resolved.source === 'fallback' ? '' : resolved.text,
          noAnswer: member.type !== 'answer',
        });
        if (!bar || bar?.isConnected === true) {
          return { ok: false, status: 'detached-title-list-row-failed', container };
        }
        bar.setAttribute('data-h2o-detached-title-bar', '1');
        bar.setAttribute('data-h2o-in-title-stack', String(plan.pageNum));
        bar.setAttribute('data-h2o-stack-key', member.id);
        bar.setAttribute('data-h2o-stack-type', member.type);
        bar.setAttribute('data-h2o-stack-turn-no', String(member.turnNo));
        bar.setAttribute(ATTR_TITLE_LIST_NUM, '1');
        bar.setAttribute('data-h2o-turn-num', String(member.turnNo));
        bar.setAttribute('data-h2o-title-row-hydrated', '0');
        bar.setAttribute('data-h2o-title-row-source', resolved.source);
        bar.setAttribute('data-h2o-title-row-source-rank', String(resolved.rank));
        if (resolved.answerId) {
          bar.setAttribute('data-h2o-title-row-source-id', String(resolved.answerId));
        }
        projectSyntheticRowTitle(member, bar);
        applyStackedTitleBarWash(member, bar);
        container.appendChild(bar);
        rows.push(bar);
      }
    } catch {
      return { ok: false, status: 'detached-title-list-build-failed', container };
    }
    if (
      rows.length !== plan.expectedTitleRowCount
      || Array.from(container.children || []).length !== rows.length
    ) {
      return { ok: false, status: 'detached-title-list-incomplete', container };
    }
    return { ok: true, status: 'prepared', container, rows };
  }

  /* Canonical currency of a collapsed page scope.

     Pass 4 retires the NATIVE half of committed-state validation, not this
     half. Route, generation, fingerprint, boundary identity, branch
     transition, streaming and title-row currency were always questions about
     the conversation rather than about remembered elements, and they stay a
     hard gate: a page whose canonical scope moved really is invalid, unlike a
     page whose wrappers merely churned.

     What is NOT required here is rendered-lease currency of either boundary
     (supported / leaseCurrent / pageUnitOrderCurrent). Measured in the windowed
     world: every canonical field of a healthy collapsed page agrees, and the
     validation still failed 'atomic-plan-scope-stale' solely because the NEXT
     page's distant boundary was not mounted — Defect V a second time, in the
     committed-state test rather than the activation predicate. Pass 2 retired
     the same requirement from activation; this is the same retirement, in the
     same terms, for the committed state.

     `scope` is any object carrying the canonical fields — a live plan during
     collapse, or a committed transaction afterwards. */
  function collapsedPageCanonicalAuthorityCurrent(scope = null) {
    if (!scope?.capabilityIdentity) return { ok: false, reason: 'atomic-plan-scope-stale' };
    const finalScope = scope.isFinalPage === true;
    const authority = readRenderedBoundaryAuthority(scope.pageNum);
    const nextAuthority = finalScope ? null : readRenderedBoundaryAuthority(scope.pageNum + 1);
    const startCapability = getRenderedPageBoundaryCapability(scope.pageNum);
    const nextCapability = finalScope ? null : getRenderedPageBoundaryCapability(scope.pageNum + 1);
    if (
      !authority?.ok
      || (!finalScope && !nextAuthority?.ok)
      || authority.chatId !== scope.chatId
      || authority.routeKey !== scope.routeKey
      || authority.generation !== scope.generation
      || authority.effectiveFingerprint !== scope.effectiveFingerprint
      || authority.qId !== scope.startBoundaryQId
      || renderedBoundaryTransitionActive(authority.projection)
      || renderedBoundaryRecordStreaming(authority.record)
      || startCapability.graphFingerprint !== scope.graphFingerprint
      || (!finalScope && (
        nextAuthority.chatId !== scope.chatId
        || nextAuthority.routeKey !== scope.routeKey
        || nextAuthority.generation !== scope.generation
        || nextAuthority.effectiveFingerprint !== scope.effectiveFingerprint
        || nextAuthority.qId !== scope.nextBoundaryQId
        || renderedBoundaryTransitionActive(nextAuthority.projection)
        || renderedBoundaryRecordStreaming(nextAuthority.record)
        || nextCapability.graphFingerprint !== scope.graphFingerprint
      ))
    ) return { ok: false, reason: 'atomic-plan-scope-stale' };
    const model = buildTitleListPresentationPageModel();
    const page = model?.pages?.find?.((entry) => entry.pageNo === scope.pageNum) || null;
    const currentRows = Array.isArray(page?.turnRecords) ? page.turnRecords : [];
    if (
      model?.coherent !== true
      || currentRows.length !== scope.expectedTitleRowCount
      || currentRows.length !== scope.titleRows.length
      || currentRows.some((member, index) => (
        member?.id !== scope.titleRows[index]?.id
        || Number(member?.turnNo || 0) !== Number(scope.titleRows[index]?.turnNo || 0)
      ))
    ) return { ok: false, reason: 'atomic-plan-title-rows-stale' };
    return { ok: true, reason: null };
  }

  function revalidateAtomicPageCollapsePlan(plan = null) {
    if (
      !plan
      || plan.atomicRenderedBoundaryPlan !== true
      || !plan.capabilityIdentity
      || plan.flowRoot?.isConnected !== true
      || plan.startWrapper?.isConnected !== true
      || plan.endWrapper?.isConnected !== true
      || plan.startWrapper?.parentElement !== plan.flowRoot
      || plan.endWrapper?.parentElement !== plan.flowRoot
      || !renderedBoundaryWrapperCarriesIdentity(plan.startWrapper, plan.startBoundaryQId)
      || (plan.isFinalPage === true
        ? !pageCollapseRangeH2OOwned(plan.endWrapper)
        : !renderedBoundaryWrapperCarriesIdentity(plan.endWrapper, plan.nextBoundaryQId))
      || plan.pageDivider?.isConnected !== true
      || plan.pageDivider?.parentElement !== plan.flowRoot
      || !Array.isArray(plan.hostWrappers)
      || !plan.hostWrappers.length
      || plan.hostWrappers.includes(plan.endWrapper)
    ) return { ok: false, reason: 'atomic-plan-wrapper-stale' };
    for (const node of plan.hostWrappers) {
      const proof = plan.wrapperProofs?.get?.(node) || null;
      if (
        node?.isConnected !== true
        || node?.parentElement !== plan.flowRoot
        || pageCollapseRangeH2OOwned(node)
        || !proof?.identity
        || !pageCollapseMemberIdentityCurrent(node, proof)
      ) return { ok: false, reason: 'atomic-plan-member-stale' };
    }
    const authority = readRenderedBoundaryAuthority(plan.pageNum);
    const finalPlan = plan.isFinalPage === true;
    const nextAuthority = finalPlan ? null : readRenderedBoundaryAuthority(plan.pageNum + 1);
    const startCapability = getRenderedPageBoundaryCapability(plan.pageNum);
    const nextCapability = finalPlan ? null : getRenderedPageBoundaryCapability(plan.pageNum + 1);
    if (finalPlan) {
      const tail = resolveFinalPageTailAuthority(
        plan.pageNum,
        plan.pageEndOrder,
        authority,
        plan.flowRoot,
      );
      if (!tail.ok || tail.endExclusive !== plan.endWrapper) {
        return { ok: false, reason: 'atomic-plan-scope-stale' };
      }
    }
    if (
      !authority?.ok
      || (!finalPlan && !nextAuthority?.ok)
      || authority.chatId !== plan.chatId
      || authority.routeKey !== plan.routeKey
      || authority.generation !== plan.generation
      || authority.effectiveFingerprint !== plan.effectiveFingerprint
      || authority.qId !== plan.startBoundaryQId
      || renderedBoundaryTransitionActive(authority.projection)
      || renderedBoundaryRecordStreaming(authority.record)
      || startCapability.supported !== true
      || startCapability.leaseCurrent !== true
      || startCapability.graphFingerprint !== plan.graphFingerprint
      || startCapability.pageUnitOrderCurrent !== true
      || (!finalPlan && (
        nextAuthority.chatId !== plan.chatId
        || nextAuthority.routeKey !== plan.routeKey
        || nextAuthority.generation !== plan.generation
        || nextAuthority.effectiveFingerprint !== plan.effectiveFingerprint
        || nextAuthority.qId !== plan.nextBoundaryQId
        || renderedBoundaryTransitionActive(nextAuthority.projection)
        || renderedBoundaryRecordStreaming(nextAuthority.record)
        || nextCapability.supported !== true
        || nextCapability.leaseCurrent !== true
        || nextCapability.graphFingerprint !== plan.graphFingerprint
        || nextCapability.pageUnitOrderCurrent !== true
      ))
    ) return { ok: false, reason: 'atomic-plan-scope-stale' };
    return collapsedPageCanonicalAuthorityCurrent(plan);
  }

  /* Stage 2 (Defect V) Pass 4 — identity-derived collapse surface.

     The flow root is re-derived on every use from the page's OWN divider
     rather than carried on the transaction. Under host windowing the element
     that was the flow root at commit time may have been replaced, and a
     transaction that pins it answers questions about a DOM that no longer
     exists. */
  function collapsedPageFlowRootByIdentity(pageNum = 0, options = {}) {
    const num = Math.max(1, Number(pageNum || 0) || 0);
    let divider = null;
    try {
      const node = document.querySelector(
        `.cgxui-chat-page-divider[data-page-num="${String(num)}"]`
      );
      divider = node?.getAttribute?.('data-page-num') === String(num) ? node : null;
    } catch { divider = null; }
    const root = divider?.parentElement || null;
    if (!root) return null;
    // Callers that ask a question about the CURRENT surface require liveness;
    // cleanup callers (see releaseAtomicPageCollapseState) do not.
    return options?.requireLive === false || root.isConnected === true ? root : null;
  }

  /* Current canonical membership of a committed page. Unmounted members are
     ordinary absence under windowing, replacements resolve to the CURRENT
     node, and ambiguity fails the caller closed. */
  function currentCollapsedPageMembers(transaction = null) {
    const empty = (reason) => ({ ok: false, reason, flowRoot: null, mounted: [], unmountedCount: 0 });
    if (!transaction || transaction.atomicRenderedBoundaryPlan !== true) return empty('transaction-missing');
    const model = buildTitleListPresentationPageModel();
    const page = model?.pages?.find?.((entry) => entry.pageNo === transaction.pageNum) || null;
    if (!page) return empty('page-outside-presentation');
    return resolveCurrentMountedPageMembers(page, {
      flowRoot: collapsedPageFlowRootByIdentity(transaction.pageNum),
    });
  }

  /* The single logical-intent authority: a page is collapsed if and only if a
     transaction is registered for it. */
  function currentCollapsedPageIntent(chatId = '', pageNum = 0) {
    const num = Math.max(1, Number(pageNum || 0) || 0);
    return S.atomicPageCollapseTransactions.has(collapsedNativeRangeKey(String(chatId || '').trim(), num));
  }

  function releaseAtomicPageCollapseState(transaction = null, options = {}) {
    if (!transaction) return { ok: true, status: 'inactive', mutations: 0 };
    const num = transaction.pageNum;
    const id = transaction.chatId;
    let mutations = 0;
    /* Rollback model B on release: the un-stamp target is re-resolved from
       CURRENT identity, never from a list captured at commit. A predecessor
       the host has already swapped out is left exactly as it is (writing it
       would both un-stamp nothing and strand our marker on the live element
       that replaced it); the element that currently carries the identity is
       the one released. */
    const snapshot = currentCollapsedPageMembers(transaction);
    /* Release derives its sweep root by identity like everything else, but
       deliberately does NOT require it to be live. Removing our marker inside
       a tree the host has already detached is harmless and completes the
       release; refusing to do it would leave the marker on nodes the host is
       free to recycle back into the flow, which is the stale-re-entry bug in
       reverse. The compatibility writer keeps its liveness rule. */
    const identityRoot = collapsedPageFlowRootByIdentity(num);
    const releaseRoot = identityRoot || snapshot.flowRoot || collapsedPageFlowRootByIdentity(num, { requireLive: false });
    try {
      mutations += clearTitleListNativeInPlaceProjection(transaction, { rehide: false }).mutations;
    } catch {}
    const expectedMarker = String(num);
    const unstamp = (node) => {
      if (!node || node.getAttribute?.(ATTR_CHAT_PAGE_NATIVE_HIDDEN) !== expectedMarker) return;
      try { node.removeAttribute(ATTR_CHAT_PAGE_NATIVE_HIDDEN); mutations += 1; } catch {}
    };
    for (const entry of snapshot.ok ? snapshot.mounted : []) unstamp(entry.node);
    // Interior host nodes that the legacy contiguous range stamped are not
    // canonical members, so they are released by their own marker inside the
    // live flow root instead of from a retained reference list.
    for (const child of Array.from(releaseRoot?.children || [])) unstamp(child);
    const container = transaction.titleListContainer || null;
    if (container) {
      try { releaseTitleStackBars(container); } catch {}
      if (container?.isConnected || container?.parentElement) {
        try { container.remove(); mutations += 1; } catch {}
      }
    }
    const key = collapsedNativeRangeKey(id, num);
    S.atomicPageCollapseTransactions.delete(key);
    S.nativeRangeActivePages.delete(key);
    S.titleListStacksByKey.delete(titleListStackRegistryKey(num, id));
    if (options?.preserveIntent !== true) {
      // The persisted collapse memory is USER intent. Only a user-driven
      // expansion may clear it: a rollback of a failed attempt or a
      // host-lifecycle expansion undoes the ATTEMPT, not the intent — the
      // collapse re-applies when the boundary is provable again. Erasing it
      // here silently dropped a durable preference on transient host churn.
      setAtomicTitleListMemory(id, num, false);
      setAtomicCollapsedPageMemory(id, num, false);
      // Explicit page expansion is the terminal owner of any member-level
      // title projection left behind by a temporarily unmounted answer. The
      // helpers inspect current canonical page membership and release only
      // title-owned sources/markers; no native node reference is retained.
      clearResidualPageTitleCollapseSources(num);
      releasePageMemberHideMarkers(num);
    }
    propagateChatPageCollapseToMiniMap(num, id, false);
    getTitleListStackStats(num, id).activeStackId = '';
    syncTitleOnlyModeRootAttribute(id);
    if (options?.clearDiagnostic !== false) {
      S.collapsedBoundaryDiagnostics.delete(collapsedNativeRangeKey(id, num));
      clearCollapseUnavailableFeedback(num);
      if (options?.controlReadiness) {
        applyCollapsedBoundaryControlState(num, id, options.controlReadiness);
      }
    }
    return { ok: true, status: 'expanded', mutations };
  }

  function rollbackAtomicPageCollapse(transaction = null, viewportAnchor = null, reason = '') {
    const released = releaseAtomicPageCollapseState(transaction, {
      clearDiagnostic: false,
      preserveIntent: true,
    });
    if (viewportAnchor) restoreCollapsedPageViewportAnchor(viewportAnchor, 4);
    return {
      ok: false,
      status: 'atomic-collapse-rolled-back',
      reason: String(reason || 'atomic-collapse-failed'),
      mutations: released.mutations,
    };
  }

  /* Committed-state validation, Pass 4: identity only.

     The old test asked whether a set of REMEMBERED elements was still where it
     was left. Under host windowing that question has no good answer — an
     unmounted member and a replaced member both look like invalidation, so a
     perfectly good collapse was expanded on ordinary host churn. This asks the
     only question that survives virtualization: is every member of this page
     that is CURRENTLY mounted currently suppressed? */
  function validateCommittedAtomicPageCollapse(transaction = null) {
    if (!transaction || transaction.atomicRenderedBoundaryPlan !== true) {
      return { ok: false, reason: 'transaction-missing' };
    }
    // Exactly the canonical half of the pre-Pass-4 plan revalidation, shared
    // verbatim with it. Only the native half became identity-resolved.
    const canonical = collapsedPageCanonicalAuthorityCurrent(transaction);
    if (!canonical.ok) return canonical;
    const snapshot = currentCollapsedPageMembers(transaction);
    if (!snapshot.ok) return { ok: false, reason: String(snapshot.reason || 'candidate-unresolved') };
    // Derived independently from the page's own divider, with the
    // member-discovered root as the windowed fallback. A flow root that is not
    // live is not host churn: the surface this collapse describes is gone.
    const derivedRoot = collapsedPageFlowRootByIdentity(transaction.pageNum) || snapshot.flowRoot || null;
    if (derivedRoot?.isConnected !== true) return { ok: false, reason: 'flow-root-unavailable' };
    // The one permitted indirect title-list dependency: a member deliberately
    // opened in place is legitimately visible and must not read as incomplete.
    // Skipped entirely when no open state exists, which is the same answer.
    const openMount = S.titleListOpenStatesByKey?.size
      ? titleListCurrentOpenMount(transaction)
      : { ok: false, anchors: [] };
    const openAnchors = new Set(openMount.ok ? openMount.anchors : []);
    /* Truthful status for an ACTIVE in-place open whose exact target is not
       available right now.

       An unmounted PAGE MEMBER is ordinary absence under windowing — that is
       the Pass-4 correction and it stands. An opened member is different: the
       user asked for that exact turn to be visible, a materialization request
       is already outstanding for it, and the title-list state still says
       `pending`. Reporting `current` there claims the open succeeded while the
       projection is still waiting, which is how a genuinely pending open began
       reading as settled.

       The verdict is the title-list's OWN (`openMount`, already computed above
       for the anchor exemption — no second call and no second projection
       model). That matters for the partial case in particular: an answer-type
       member requires both its current question and answer anchors, and one
       resolved anchor out of two is reported by that contract as
       `canonical-mount-incomplete`. Compatibility state may legitimately hold
       the one truthful wrapper for the legacy readers; it is not evidence that
       the exact target is complete, and this reads completeness only from the
       contract that defines it.

       Deliberately narrow: it requires an open state that is CURRENT (a member
       resolved) and ALREADY pending, so ordinary host churn around a healthy
       open cannot force pending on its own. */
    if (
      openMount.member
      && openMount.ok !== true
      && (openMount.state?.status === 'pending' || openMount.state?.pending === true)
    ) return { ok: false, reason: String(openMount.reason || 'title-list-open-target-unavailable') };
    const expectedMarker = String(transaction.pageNum);
    for (const entry of snapshot.mounted) {
      if (openAnchors.has(entry.node)) continue;
      if (entry.node?.getAttribute?.(ATTR_CHAT_PAGE_NATIVE_HIDDEN) !== expectedMarker) {
        return { ok: false, reason: 'transaction-commit-incomplete' };
      }
    }
    const container = transaction.titleListContainer || null;
    if (container && (
      container.isConnected !== true
      || (derivedRoot && container.parentElement !== derivedRoot)
      || getSyntheticTitleListContainers(transaction.pageNum).filter(
        (node) => node === container
      ).length !== 1
    )) return { ok: false, reason: 'transaction-commit-incomplete' };
    return { ok: true, reason: null };
  }

  /* Stage 2 (Defect V) Pass 3 — canonical operation epoch.

     Identity-defining fields only. `authoritySource` travels with the epoch as
     diagnostic provenance and is deliberately NOT compared: a source relabel
     while chat/route/generation/fingerprints/count/page-layout all hold is not
     canonical drift. Host presentation churn (mount, unmount, replacement,
     hydration) is likewise never epoch drift — it is re-resolved, not aborted
     on. */
  function pageCollapseOperationEpoch(pageNum = 0) {
    const num = Math.max(1, Number(pageNum || 0) || 0);
    const rt = TURN_RUNTIME();
    let status = null;
    try { status = rt?.[TITLE_LIST_EFFECTIVE_METHOD.STATUS]?.() || null; } catch { return null; }
    const model = buildTitleListPresentationPageModel();
    const page = model?.pages?.find?.((entry) => entry.pageNo === num) || null;
    const authority = readRenderedBoundaryAuthority(num);
    return Object.freeze({
      chatId: String(authority?.chatId || status?.chatId || ''),
      routeKey: String(authority?.routeKey || status?.routeKey || ''),
      generation: Math.max(0, Number(authority?.generation || status?.generation || 0) || 0),
      effectiveFingerprint: String(authority?.effectiveFingerprint || status?.canonicalFingerprint || ''),
      graphFingerprint: String(getRenderedPageBoundaryCapability(num)?.graphFingerprint || ''),
      count: Math.max(0, Number(model?.count || 0) || 0),
      pageStartOrder: Math.max(0, Number(page?.startOrder || 0) || 0),
      pageEndOrder: Math.max(0, Number(page?.endOrder || 0) || 0),
      coherent: model?.coherent === true,
      // Diagnostic provenance only — never compared for drift.
      authoritySource: String(model?.source || status?.source || ''),
      statusIdentity: collapsedBoundaryStatusIdentity(status),
    });
  }

  function pageCollapseEpochCoherent(before = null, after = null) {
    if (!before || !after) return false;
    return (
      before.coherent === true
      && after.coherent === true
      && before.chatId === after.chatId
      && before.routeKey === after.routeKey
      && before.generation === after.generation
      && before.effectiveFingerprint === after.effectiveFingerprint
      && before.graphFingerprint === after.graphFingerprint
      && before.count === after.count
      && before.pageStartOrder === after.pageStartOrder
      && before.pageEndOrder === after.pageEndOrder
      && before.statusIdentity === after.statusIdentity
    );
  }

  /* Rollback model B — ALWAYS re-resolve identity before restoring.

     The captured prior value is scalar presentation data. The captured node is
     NOT rollback authority: between stamping and rollback the host may have
     replaced the element, so we re-resolve the canonical identity and write the
     captured scalar onto the CURRENT node. A stale predecessor is never
     written, and an identity that has become ambiguous or unavailable is
     reported as precise residue rather than approximated. */
  function rollbackWindowedCollapseCandidates(pageNum = 0, entries = []) {
    let restored = 0;
    const residue = [];
    for (const entry of Array.isArray(entries) ? entries : []) {
      const member = { questionId: entry?.questionId, turnNo: entry?.turnNo };
      const surface = collapsedBoundaryNativeStartSurface(member);
      if (!surface.ok) {
        residue.push({ questionId: entry?.questionId, reason: String(surface.reason || 'unresolved') });
        continue;
      }
      const node = getTurnAnchorNode(surface.section);
      if (!node || node.isConnected !== true) {
        residue.push({ questionId: entry?.questionId, reason: 'rollback-node-unavailable' });
        continue;
      }
      try {
        if (entry?.priorValue == null) node.removeAttribute(ATTR_CHAT_PAGE_NATIVE_HIDDEN);
        else node.setAttribute(ATTR_CHAT_PAGE_NATIVE_HIDDEN, String(entry.priorValue));
        restored += 1;
      } catch {
        residue.push({ questionId: entry?.questionId, reason: 'rollback-write-failed' });
      }
    }
    return { restored, residue };
  }

  /* Stage-2 windowed transaction commit.

     Intent commit model A: validate E0/E1, record logical intent, then stamp the
     final current subset. Canonical drift is rejected BEFORE intent, and intent
     is logical so it does not depend on native availability — which is why an
     empty subset still commits successfully. */
  function commitWindowedPageCollapse(context = {}) {
    const { num, id, key, plan, epochBefore, metrics } = context;
    const model = buildTitleListPresentationPageModel();
    const page = model?.pages?.find?.((entry) => entry.pageNo === num) || null;
    if (!page) return { ok: false, status: 'collapsed-exact-boundary-unavailable', reason: 'page-outside-presentation' };

    // Final current candidate snapshot: Pass-2 ephemeral nodes are NOT trusted
    // at commit time. Members that mounted since planning are included; members
    // that unmounted are ordinary absence; replacements resolve to the CURRENT
    // node; ambiguity fails the whole transaction closed.
    const snapshot = resolveCurrentMountedPageMembers(page);
    if (!snapshot.ok) {
      return {
        ok: false,
        status: 'atomic-collapse-candidate-unresolved',
        reason: String(snapshot.reason || 'candidate-unresolved'),
      };
    }
    const epochAfter = pageCollapseOperationEpoch(num);
    if (!pageCollapseEpochCoherent(epochBefore, epochAfter)) {
      return { ok: false, status: 'atomic-collapse-epoch-drift', reason: 'authority-changed-during-transaction' };
    }

    /* Version 3 — Pass 5A. The committed collapse is IDENTITY state end to end:
       it retains no ChatGPT-owned native node at all. An element captured at
       commit time is only ever a guess about a host that recycles its DOM, so
       every host relationship — flow root, member wrapper, anchor order — is
       re-derived from canonical identity at the moment of use.

       The two handles that remain are H2O's own synthetic UI, not host state. */
    const transaction = {
      atomicRenderedBoundaryPlan: true,
      version: 3,
      pageNum: num,
      pageStartOrder: plan.pageStartOrder,
      pageEndOrder: plan.pageEndOrder,
      chatId: plan.chatId,
      routeKey: plan.routeKey,
      generation: plan.generation,
      effectiveFingerprint: plan.effectiveFingerprint,
      graphFingerprint: plan.graphFingerprint,
      startBoundaryQId: plan.startBoundaryQId || '',
      nextBoundaryQId: plan.nextBoundaryQId || '',
      isFinalPage: plan.isFinalPage === true,
      titleRows: Array.isArray(plan.titleRows) ? plan.titleRows.slice() : [],
      expectedTitleRowCount: plan.expectedTitleRowCount,
      capabilityIdentity: plan.capabilityIdentity,
      titleListContainer: null,
      titleRowsPrepared: [],
      source: String(context?.source || 'explicit-collapse'),
    };

    // Model A: intent is recorded before native work and does not depend on it.
    S.atomicPageCollapseTransactions.set(key, transaction);
    setAtomicCollapsedPageMemory(id, num, true);

    if (!snapshot.mounted.length) {
      // Valid no-native-work success: canonical page is collapsed logically,
      // there is simply nothing currently mounted to suppress this pass.
      return {
        ok: true,
        status: 'collapsed-no-native-work',
        reason: 'no-current-mounted-members',
        pageNum: num,
        chatId: id,
        hidden: 0,
        mutations: 0,
        rows: 0,
        generation: transaction.generation,
        effectiveFingerprint: transaction.effectiveFingerprint,
        graphFingerprint: transaction.graphFingerprint,
      };
    }

    const applied = applyCollapsedNativeRange({
      atomicRenderedBoundaryPlan: true,
      pageNum: num,
      mountedCandidates: snapshot.mounted,
    });
    if (metrics) metrics.wrappersStamped = (applied.stamped || []).length;
    if (!applied.ok || applied.hidden !== snapshot.mounted.length) {
      const rolled = rollbackWindowedCollapseCandidates(num, applied.restorable || []);
      S.atomicPageCollapseTransactions.delete(key);
      setAtomicCollapsedPageMemory(id, num, false);
      return {
        ok: false,
        status: 'atomic-collapse-rolled-back',
        // The captured cause when there is one, so the recorded attempt's
        // internalReason names the real failure instead of the stage alone.
        reason: String(applied.reason || applied.status || 'atomic-collapse-failed'),
        mutations: rolled.restored,
        residue: rolled.residue,
      };
    }
    S.nativeRangeActivePages.add(key);
    return {
      ok: true,
      status: 'collapsed',
      pageNum: num,
      chatId: id,
      hidden: applied.hidden,
      mutations: applied.mutations,
      rows: transaction.titleRows.length,
      generation: transaction.generation,
      effectiveFingerprint: transaction.effectiveFingerprint,
      graphFingerprint: transaction.graphFingerprint,
    };
  }

  function collapsePageWithRenderedBoundaries(pageNum = 0, options = {}) {
    const num = Math.max(1, Number(pageNum || 0) || 0);
    const id = String(options?.chatId || resolveChatId()).trim();
    const key = collapsedNativeRangeKey(id, num);
    if (S.atomicPageCollapseTransactions.has(key)) {
      return { ok: true, status: 'already-collapsed', pageNum: num, chatId: id };
    }
    if (S.atomicPageCollapseGuards.has(key)) {
      return { ok: false, status: 'transaction-busy', pageNum: num, chatId: id };
    }
    S.atomicPageCollapseGuards.add(key);
    const metrics = options?.metrics || null;
    let viewportAnchor = null;
    let transaction = null;
    try {
      const evaluation = evaluatePageCollapseCapability(num, { includePlan: true });
      if (metrics) metrics.capabilityEvaluations += 1;
      const capability = evaluation.capability;
      const plan = evaluation.plan;
      if (!capability?.activationReady || !plan) {
        return {
          ok: false,
          status: 'collapsed-exact-boundary-unavailable',
          reason: capability?.reason || 'layout-incomplete',
          capability,
        };
      }
      if (metrics) {
        metrics.rangePlansBuilt += 1;
        /* A Stage-2 windowed plan legitimately carries no hostWrappers field at
           all — the branch below is written for exactly that shape — so this
           line must not be the thing that decides whether collapse runs.
           Measured live: recording metrics threw before the windowed branch it
           was standing in front of could ever be reached. */
        metrics.wrappersPlanned = Array.isArray(plan.hostWrappers) ? plan.hostWrappers.length : 0;
      }
      plan.atomicRenderedBoundaryPlan = true;
      /* Stage 2 Pass 3 intake: a plan without a proven legacy contiguous
         interval is executed as a mounted-subset transaction. The full-interval
         world keeps the legacy path below byte-for-byte. */
      if (plan.stage2WindowedPlan === true && !(Array.isArray(plan.hostWrappers) && plan.hostWrappers.length)) {
        const epochBefore = pageCollapseOperationEpoch(num);
        if (!epochBefore?.coherent) {
          return { ok: false, status: 'collapsed-exact-boundary-unavailable', reason: 'authority-unavailable', capability };
        }
        return commitWindowedPageCollapse({
          num, id, key, plan, capability, epochBefore, metrics,
          source: options?.source,
        });
      }
      const prepared = prepareDetachedPageTitleList(plan);
      if (!prepared.ok) {
        return { ok: false, status: prepared.status, capability };
      }
      if (metrics) {
        metrics.detachedListsPrepared += 1;
        metrics.titleRowsPrepared = prepared.rows.length;
      }
      viewportAnchor = captureCollapsedPageViewportAnchor(num);
      if (!viewportAnchor) {
        return { ok: false, status: 'viewport-anchor-unavailable', capability };
      }
      const finalCheck = revalidateAtomicPageCollapsePlan(plan);
      if (!finalCheck.ok) {
        return { ok: false, status: finalCheck.reason, capability };
      }
      // One transaction shape for both worlds (version 3 — see the windowed
      // commit). The full-interval plan still owns wrapper elements while it
      // executes; they simply stop being durable committed state.
      transaction = {
        atomicRenderedBoundaryPlan: true,
        version: 3,
        pageNum: plan.pageNum,
        pageStartOrder: plan.pageStartOrder,
        pageEndOrder: plan.pageEndOrder,
        chatId: plan.chatId,
        routeKey: plan.routeKey,
        generation: plan.generation,
        effectiveFingerprint: plan.effectiveFingerprint,
        graphFingerprint: plan.graphFingerprint,
        startBoundaryQId: plan.startBoundaryQId,
        nextBoundaryQId: plan.nextBoundaryQId,
        isFinalPage: plan.isFinalPage === true,
        titleRows: plan.titleRows.slice(),
        expectedTitleRowCount: plan.expectedTitleRowCount,
        capabilityIdentity: plan.capabilityIdentity,
        titleListContainer: prepared.container,
        titleRowsPrepared: prepared.rows,
        source: String(options?.source || 'explicit-collapse'),
      };
      try {
        plan.flowRoot.insertBefore(prepared.container, plan.pageDivider.nextSibling);
        if (metrics) {
          metrics.firstWriteReached = true;
          metrics.syntheticListsInserted += 1;
        }
        const stamped = applyCollapsedNativeRange(plan);
        if (metrics) metrics.wrappersStamped = (stamped.stamped || []).length;
        if (!stamped.ok || stamped.hidden !== plan.hostWrappers.length) {
          return rollbackAtomicPageCollapse(transaction, viewportAnchor, stamped.status);
        }
        S.atomicPageCollapseTransactions.set(key, transaction);
        S.nativeRangeActivePages.add(key);
        S.titleListStacksByKey.set(titleListStackRegistryKey(num, id), prepared.container);
        setAtomicTitleListMemory(id, num, true);
        setAtomicCollapsedPageMemory(id, num, true);
        getTitleListStackStats(num, id).activeStackId = prepared.container.id;
        syncTitleOnlyModeRootAttribute(id);
        clearCollapsedBoundaryDiagnostic(num, id);
        clearCollapseUnavailableFeedback(num);
        propagateChatPageCollapseToMiniMap(num, id, true);
      } catch {
        return rollbackAtomicPageCollapse(transaction, viewportAnchor, 'atomic-collapse-write-failed');
      }
      if (!restoreCollapsedPageViewportAnchor(viewportAnchor, 4)) {
        return rollbackAtomicPageCollapse(transaction, viewportAnchor, 'viewport-restore-failed');
      }
      const committed = validateCommittedAtomicPageCollapse(transaction);
      if (!committed.ok) {
        return rollbackAtomicPageCollapse(transaction, viewportAnchor, committed.reason);
      }
      return {
        ok: true,
        status: 'collapsed',
        pageNum: num,
        chatId: id,
        hidden: plan.hostWrappers.length,
        rows: transaction.titleRowsPrepared.length,
        generation: transaction.generation,
        effectiveFingerprint: transaction.effectiveFingerprint,
        graphFingerprint: transaction.graphFingerprint,
      };
    } finally {
      S.atomicPageCollapseGuards.delete(key);
    }
  }

  // Expanded-control readiness comes from the rendered-boundary capability, not
  // from whatever triggered the expansion. The capability is a pure read, so
  // this cannot re-enter the transaction owner or start a reconcile loop.
  function applyExpandedCollapseControlState(pageNum = 0, chatId = '') {
    const num = Math.max(1, Number(pageNum || 0) || 0);
    const id = String(chatId || resolveChatId()).trim();
    let capability = null;
    try { capability = getPageCollapseCapability(num); } catch { capability = null; }
    const ready = capability?.activationReady === true;
    return applyCollapsedBoundaryControlState(num, id, {
      ready,
      reason: ready
        ? null
        : String(
          capability?.activationBlockReason
          || capability?.reason
          || COLLAPSE_UNAVAILABLE_STATUS
        ),
      productReason: ready ? 'ready' : String(capability?.productReason || 'page-loading'),
    });
  }

  /* Stage 2 (Defect V) Pass 4 — windowed expansion.

     Logical intent is cleared FIRST. While the transaction is still registered
     any concurrent reconcile pass would legitimately re-stamp the very members
     this function is about to release, so dropping the intent before the DOM
     work is what makes an expansion terminal rather than a race.

     Expansion reveals nothing. A member that is not mounted stays not mounted:
     materialising it is host navigation, which is not this function's business
     and would move the user's viewport on an operation they asked to be a
     removal of suppression. Residue is measured from the live flow root, not
     from a remembered wrapper list. */
  function expandWindowedPageCollapse(pageNum = 0, options = {}) {
    const num = Math.max(1, Number(pageNum || 0) || 0);
    const id = String(options?.chatId || resolveChatId()).trim();
    const key = collapsedNativeRangeKey(id, num);
    const transaction = S.atomicPageCollapseTransactions.get(key) || null;
    if (!transaction) {
      return { ok: true, status: 'inactive', pageNum: num, chatId: id, mutations: 0, revealCount: 0 };
    }
    const explicitExpansion = /^chat-page-divider:/.test(String(options?.source || ''));
    const viewportAnchor = captureCollapsedPageViewportAnchor(num);
    // Intent first — see above.
    S.atomicPageCollapseTransactions.delete(key);
    S.nativeRangeActivePages.delete(key);
    const released = releaseAtomicPageCollapseState(transaction, {
      controlReadiness: explicitExpansion
        ? { ready: true, reason: null, productReason: 'ready' }
        : null,
      preserveIntent: !explicitExpansion,
    });
    if (viewportAnchor) restoreCollapsedPageViewportAnchor(viewportAnchor, 4);
    // A lifecycle expansion is not itself evidence that the exact boundaries
    // are gone. Derive the expanded control state from the authoritative
    // capability once the release has settled: a page that is still provable
    // renders ready, and a page whose authority genuinely failed keeps its
    // own reason instead of a blanket boundary-unavailable claim.
    if (!explicitExpansion) {
      applyExpandedCollapseControlState(num, id);
    }
    const residualRoot = collapsedPageFlowRootByIdentity(num);
    const residualStamps = Array.from(residualRoot?.children || []).filter((node) => (
      node?.getAttribute?.(ATTR_CHAT_PAGE_NATIVE_HIDDEN) === String(num)
    )).length;
    const residualLists = getSyntheticTitleListContainers(num).filter((node) => node?.isConnected).length;
    return {
      ok: residualStamps === 0 && residualLists === 0,
      status: residualStamps || residualLists ? 'expansion-incomplete' : 'expanded',
      pageNum: num,
      chatId: id,
      mutations: released.mutations,
      revealCount: 0,
      residualStamps,
      residualLists,
    };
  }

  /* Stage 2 (Defect V) Pass 4 — stale marker cleanup on host re-entry.

     The host recycles wrappers across virtualization cycles, so a node can
     arrive already carrying our hidden marker from a page the user has since
     expanded. Without this, re-entering a chat silently re-hides content
     nobody asked to hide. The live transaction registry is the authority: a
     marker whose page has no active transaction is residue, not state. */
  function clearStaleWindowedCollapseStamps(chatId = '') {
    const id = String(chatId || resolveChatId()).trim();
    const model = buildTitleListPresentationPageModel();
    let root = null;
    for (const page of Array.isArray(model?.pages) ? model.pages : []) {
      root = collapsedPageFlowRootByIdentity(page.pageNo);
      if (root) break;
      const probe = resolveCurrentMountedPageMembers(page);
      if (probe.ok && probe.flowRoot?.isConnected === true) { root = probe.flowRoot; break; }
    }
    let mutations = 0;
    let scanned = 0;
    for (const child of Array.from(root?.children || [])) {
      const marker = child?.getAttribute?.(ATTR_CHAT_PAGE_NATIVE_HIDDEN);
      if (marker == null) continue;
      scanned += 1;
      const num = Math.max(0, Number(marker) || 0);
      if (num && currentCollapsedPageIntent(id, num)) continue;
      try { child.removeAttribute(ATTR_CHAT_PAGE_NATIVE_HIDDEN); mutations += 1; } catch {}
    }
    return { ok: true, mutations, scanned };
  }

  function expandPageWithRenderedBoundaries(pageNum = 0, options = {}) {
    const num = Math.max(1, Number(pageNum || 0) || 0);
    const id = String(options?.chatId || resolveChatId()).trim();
    const key = collapsedNativeRangeKey(id, num);
    if (!S.atomicPageCollapseTransactions.has(key)) {
      return { ok: true, status: 'inactive', pageNum: num, mutations: 0 };
    }
    if (S.atomicPageCollapseGuards.has(key)) {
      return { ok: false, status: 'transaction-busy', pageNum: num, chatId: id };
    }
    S.atomicPageCollapseGuards.add(key);
    try {
      return expandWindowedPageCollapse(num, { ...options, chatId: id });
    } finally {
      S.atomicPageCollapseGuards.delete(key);
    }
  }


  /* Stage 2 (Defect V) Pass 4 — incremental reconcile of ACTIVE collapsed pages.

     Under host windowing a committed collapse is never "finished". Members
     mount, unmount and get replaced for as long as the collapse lives, so a
     pass that concluded "already valid, nothing to do" left every later
     arrival visible inside a page the user had collapsed. Each pass now
     re-resolves current membership and stamps exactly the members that are
     currently missing the marker — an already-correct member is not rewritten,
     so the pass stays idempotent, and an identity that has become ambiguous
     fails the pass closed rather than projecting an approximation. */
  function reconcileActiveWindowedCollapse(reason = 'presentation-updated') {
    let mutations = 0;
    for (const transaction of Array.from(S.atomicPageCollapseTransactions.values())) {
      const snapshot = currentCollapsedPageMembers(transaction);
      if (!snapshot.ok) {
        return {
          ok: false,
          reason: String(snapshot.reason || 'candidate-unresolved'),
          pageNum: transaction.pageNum,
          mutations,
        };
      }
      // A member deliberately opened in place is an explicit visibility
      // decision by the user; re-stamping it here would have this pass fight
      // the title-list projection every time it ran.
      const openMount = S.titleListOpenStatesByKey?.size
        ? titleListCurrentOpenMount(transaction)
        : { ok: false, anchors: [] };
      const openAnchors = new Set(openMount.ok ? openMount.anchors : []);
      const expectedMarker = String(transaction.pageNum);
      const pending = snapshot.mounted.filter((entry) => (
        !openAnchors.has(entry.node)
        && entry.node?.getAttribute?.(ATTR_CHAT_PAGE_NATIVE_HIDDEN) !== expectedMarker
      ));
      if (!pending.length) continue;
      const applied = applyCollapsedNativeRange({
        atomicRenderedBoundaryPlan: true,
        pageNum: transaction.pageNum,
        mountedCandidates: pending,
      });
      if (!applied.ok) {
        const rolled = rollbackWindowedCollapseCandidates(transaction.pageNum, applied.restorable || []);
        return {
          ok: false,
          reason: String(applied.status || 'reconcile-stamp-failed'),
          pageNum: transaction.pageNum,
          mutations: mutations + rolled.restored,
        };
      }
      mutations += applied.mutations;
    }
    return { ok: true, reason: String(reason || ''), mutations };
  }

  function reconcileAtomicPageCollapseTransactions(reason = 'presentation-updated') {
    const results = [];
    // Stamping runs first and unconditionally: validation reports whether the
    // page is currently coherent, it is not a licence to skip the members that
    // mounted since the last pass.
    reconcileActiveWindowedCollapse(reason);
    for (const transaction of Array.from(S.atomicPageCollapseTransactions.values())) {
      let current = validateCommittedAtomicPageCollapse(transaction);
      if (!current.ok) {
        const pending = reconcilePendingTitleListMaterialization(transaction, reason);
        if (pending) {
          results.push({
            ok: true,
            status: 'pending',
            pageNum: transaction.pageNum,
            reason: current.reason,
          });
          continue;
        }
      }
      if (current.ok && typeof reconcileTitleListNativeInPlaceProjection === 'function') {
        reconcileTitleListNativeInPlaceProjection(transaction, { reason });
        current = validateCommittedAtomicPageCollapse(transaction);
      }
      if (current.ok) {
        results.push({ ok: true, status: 'current', pageNum: transaction.pageNum });
        continue;
      }
      results.push(expandPageWithRenderedBoundaries(transaction.pageNum, {
        chatId: transaction.chatId,
        source: `${reason}:${current.reason}`,
      }));
    }
    for (const replayed of replayDeferredPageCollapseIntent(reason)) results.push(replayed);
    return results;
  }

  /* Route-return collapse replay.
     Leaving a conversation legitimately tears the ephemeral projection down
     while the user's intent survives - a route change is a lifecycle
     expansion, so it preserves intent by design and drops only the committed
     transaction. Nothing then re-projected it on return, because the pass
     above iterates committed transactions and the route change had already
     removed this page's. Measured: isPageCollapsed(2) true with mode normal,
     0 synthetic lists and 0 title rows.

     The canonical intent for the active (legacy) route is the collapsed-pages
     state behind isPageCollapsed(). The title-intent ledger owns the engine
     route and is inert here - it was never written by the legacy gesture
     (ledgerRev 0, isTitleIntentSystemInert true), so gating replay on it
     skipped a perfectly valid intent. Replay therefore reads that single
     authority and re-enters collapsePageWithRenderedBoundaries, which remains
     the sole projection writer; nothing here writes projection or intent
     directly, so there is still exactly one logical writer.

     A page whose exact boundaries are not currently provable is skipped and
     its intent left untouched, so the collapse re-projects on a later pass
     once its members mount. Readiness is a pure read, which keeps a page that
     is never projectable from re-running the full plan on every reconcile. An
     explicit divider expansion clears the intent, so a page the user opened is
     never re-collapsed behind them. */
  let collapseIntentReplayActive = false;
  // Bounded per-page deferral retries. A page can legitimately be
  // unprojectable for a beat after a route return (its exact boundary members
  // have not mounted yet), and the ambient repair triggers are membership
  // events that may all have fired already. This re-arms the EXISTING repair
  // timer a bounded number of times instead of introducing another loop; the
  // counter clears as soon as the page projects, and intent is never touched.
  const collapseIntentReplayRetries = new Map();
  const COLLAPSE_INTENT_REPLAY_MAX_RETRIES = 6;

  function replayDeferredPageCollapseIntent(reason = 'intent-replay') {
    if (collapseIntentReplayActive) return [];
    const id = resolveChatId();
    if (!id) return [];
    let intent = null;
    try { intent = readCollapsedPages(id); } catch { intent = null; }
    if (!intent || !intent.size) return [];
    const out = [];
    collapseIntentReplayActive = true;
    try {
      for (const pageNum of Array.from(intent)) {
        const num = Math.max(1, Number(pageNum || 0) || 0);
        if (!num) continue;
        const key = collapsedNativeRangeKey(id, num);
        if (S.atomicPageCollapseTransactions.has(key)) continue;
        if (S.atomicPageCollapseGuards.has(key)) continue;
        let readiness = null;
        try { readiness = getCollapsedNativeBoundaryReadiness(num); } catch { readiness = null; }
        if (readiness?.activationReady !== true) {
          const retryKey = `${id}|${num}`;
          const attempts = Math.max(0, Number(collapseIntentReplayRetries.get(retryKey) || 0));
          if (attempts < COLLAPSE_INTENT_REPLAY_MAX_RETRIES) {
            collapseIntentReplayRetries.set(retryKey, attempts + 1);
            try { scheduleActiveTitleListRepair('collapse-intent-replay-retry', 400, num); } catch {}
          }
          out.push({
            ok: true,
            status: 'intent-replay-deferred',
            pageNum: num,
            chatId: id,
            attempts,
            reason: String(readiness?.reason || 'not-projectable'),
          });
          continue;
        }
        collapseIntentReplayRetries.delete(`${id}|${num}`);
        let replayed = null;
        try {
          replayed = collapsePageWithRenderedBoundaries(num, {
            chatId: id,
            source: `intent-replay:${String(reason || 'reconcile')}`,
          });
        } catch {
          replayed = { ok: false, status: 'intent-replay-failed', pageNum: num, chatId: id };
        }
        out.push(replayed);
      }
    } finally {
      collapseIntentReplayActive = false;
    }
    return out;
  }

  function expandAllAtomicPageCollapses(reason = 'scope-change') {
    const results = [];
    for (const transaction of Array.from(S.atomicPageCollapseTransactions.values())) {
      results.push(expandPageWithRenderedBoundaries(transaction.pageNum, {
        chatId: transaction.chatId,
        source: reason,
      }));
    }
    return results;
  }

  // ── Last-attempt transaction diagnostic ───────────────────────────────────
  // Memory-only, most-recent attempt only, scalars only. It exists so a live
  // failure names the exact stage it stopped at without another broad DOM
  // probe. No DOM references, no identities, no titles, no stack traces.
  function frozenAtomicPageCollapseDiagnostic(raw = {}) {
    return Object.freeze({
      version: 1,
      available: true,
      attemptId: Math.max(0, Number(raw.attemptId || 0) || 0),
      pageNum: Math.max(0, Number(raw.pageNum || 0) || 0),
      activationSource: String(raw.activationSource || ''),
      startedAt: Math.max(0, Number(raw.startedAt || 0) || 0),
      finishedAt: Math.max(0, Number(raw.finishedAt || 0) || 0),
      result: String(raw.result || ''),
      internalReason: raw.internalReason == null ? null : String(raw.internalReason),
      productReason: raw.productReason == null ? null : String(raw.productReason),
      capabilityEvaluations: Math.max(0, Number(raw.capabilityEvaluations || 0) || 0),
      rangePlansBuilt: Math.max(0, Number(raw.rangePlansBuilt || 0) || 0),
      detachedListsPrepared: Math.max(0, Number(raw.detachedListsPrepared || 0) || 0),
      firstWriteReached: raw.firstWriteReached === true,
      wrappersPlanned: Math.max(0, Number(raw.wrappersPlanned || 0) || 0),
      wrappersStamped: Math.max(0, Number(raw.wrappersStamped || 0) || 0),
      titleRowsPrepared: Math.max(0, Number(raw.titleRowsPrepared || 0) || 0),
      syntheticListsInserted: Math.max(0, Number(raw.syntheticListsInserted || 0) || 0),
      rollbackPerformed: raw.rollbackPerformed === true,
      generation: Math.max(0, Number(raw.generation || 0) || 0),
      effectiveFingerprint: String(raw.effectiveFingerprint || ''),
      graphFingerprint: String(raw.graphFingerprint || ''),
    });
  }

  function recordAtomicPageCollapseAttempt(input = {}) {
    S.atomicPageCollapseAttemptSeq = Math.max(0, Number(S.atomicPageCollapseAttemptSeq || 0) || 0) + 1;
    const metrics = input.metrics || {};
    const diagnostic = frozenAtomicPageCollapseDiagnostic({
      ...metrics,
      attemptId: S.atomicPageCollapseAttemptSeq,
      pageNum: input.pageNum,
      activationSource: input.activationSource,
      startedAt: input.startedAt,
      finishedAt: Date.now(),
      result: input.result,
      internalReason: input.internalReason,
      productReason: input.productReason,
      generation: input.generation,
      effectiveFingerprint: input.effectiveFingerprint,
      graphFingerprint: input.graphFingerprint,
    });
    S.atomicPageCollapseLastAttempt = diagnostic;
    return diagnostic;
  }

  function getAtomicPageCollapseTransactionDiagnostic() {
    const last = S.atomicPageCollapseLastAttempt;
    return last || Object.freeze({ version: 1, available: false });
  }

  // Map a transaction status to the stage it stopped at. The stage — not a
  // stale legacy readiness reason — is what drives the product message.
  function atomicPageCollapseFailureStage(status = '') {
    const value = String(status || '');
    if (value === 'transaction-busy') return 'reentrant-blocked';
    if (value === 'collapsed-exact-boundary-unavailable') return 'blocked-before-plan';
    if (value === 'atomic-collapse-rolled-back') return 'rolled-back';
    if (value === 'viewport-anchor-unavailable') return 'preparation-failed';
    if (value.startsWith('detached-title-list-')) return 'preparation-failed';
    if (value.startsWith('atomic-plan-')) return 'revalidation-failed';
    if (value === 'transaction-commit-incomplete') return 'commit-failed';
    return 'commit-failed';
  }

  // ── Single collapse-activation owner ──────────────────────────────────────
  // Pointer and keyboard activation converge here, and nowhere else. The
  // legacy title-list mode is never the user activation owner: it may only
  // maintain an already-committed projection. No legacy compatibility field
  // (flowRoot, nativeStart, nextPageNativeStart, nativeSlotSequence, ordinals,
  // identities) is read on this path — those remain null placeholders.
  function executeAtomicPageCollapseTransaction(pageNum = 0, activationSource = '', options = {}) {
    const num = Math.max(1, Number(pageNum || 0) || 0);
    const id = String(options?.chatId || resolveChatId()).trim();
    const source = String(activationSource || '').trim() || 'chat-page-divider:circle';
    const key = collapsedNativeRangeKey(id, num);
    const startedAt = Date.now();
    const metrics = {
      capabilityEvaluations: 0,
      rangePlansBuilt: 0,
      detachedListsPrepared: 0,
      firstWriteReached: false,
      wrappersPlanned: 0,
      wrappersStamped: 0,
      titleRowsPrepared: 0,
      syntheticListsInserted: 0,
      rollbackPerformed: false,
    };
    const record = (result, extra = {}) => recordAtomicPageCollapseAttempt({
      pageNum: num,
      activationSource: source,
      startedAt,
      metrics,
      result,
      ...extra,
    });

    // 1) One reentrancy-guard check.
    if (S.atomicPageCollapseGuards.has(key)) {
      return {
        ok: false,
        status: 'transaction-busy',
        pageNum: num,
        chatId: id,
        diagnostic: record('reentrant-blocked', {
          internalReason: 'transaction-busy',
          productReason: 'page-updating',
        }),
      };
    }

    // An explicit desired state lets the legacy entry points route through
    // this owner without inverting an already-correct state; the divider
    // controls pass no desired state and toggle against the atomic registry.
    const desired = String(options?.desired || '').trim();
    const alreadyCollapsed = S.atomicPageCollapseTransactions.has(key);
    if (desired === 'collapsed' && alreadyCollapsed) {
      return {
        ok: true,
        status: 'already-collapsed',
        pageNum: num,
        chatId: id,
        diagnostic: record('committed', { internalReason: null, productReason: null }),
      };
    }
    if (desired === 'expanded' && !alreadyCollapsed) {
      return {
        ok: true,
        status: 'already-expanded',
        pageNum: num,
        chatId: id,
        diagnostic: record('expanded', { internalReason: null, productReason: null }),
      };
    }

    // Already collapsed → atomic expansion through the same owner.
    if (alreadyCollapsed) {
      const transaction = S.atomicPageCollapseTransactions.get(key) || null;
      const expanded = expandPageWithRenderedBoundaries(num, { chatId: id, source });
      if (expanded?.ok === true) clearCollapseUnavailableFeedback(num);
      return {
        ok: expanded?.ok === true,
        status: expanded?.status || 'expanded',
        pageNum: num,
        chatId: id,
        diagnostic: record(expanded?.ok === true ? 'expanded' : 'commit-failed', {
          internalReason: expanded?.ok === true ? null : String(expanded?.status || 'expansion-incomplete'),
          productReason: expanded?.ok === true ? null : 'transient-failure',
          generation: transaction?.generation,
          effectiveFingerprint: transaction?.effectiveFingerprint,
          graphFingerprint: transaction?.graphFingerprint,
        }),
      };
    }

    // 2-7) capability → plan → detached preparation → viewport anchor →
    // final revalidation → atomic commit, all owned by the transaction.
    const collapsed = collapsePageWithRenderedBoundaries(num, { chatId: id, source, metrics });
    const capability = collapsed?.capability || null;
    if (collapsed?.ok === true) {
      clearCollapseUnavailableFeedback(num);
      return {
        ok: true,
        status: 'collapsed',
        pageNum: num,
        chatId: id,
        diagnostic: record('committed', {
          internalReason: null,
          productReason: null,
          generation: collapsed?.generation,
          effectiveFingerprint: collapsed?.effectiveFingerprint,
          graphFingerprint: collapsed?.graphFingerprint,
        }),
      };
    }

    const status = String(collapsed?.status || 'collapse-transaction-failed');
    const stage = atomicPageCollapseFailureStage(status);
    if (stage === 'rolled-back') metrics.rollbackPerformed = true;
    const internalReason = String(collapsed?.reason || status);
    // A capability that was ready must never be reported as a boundary or
    // layout problem: the transaction, not the layout, is what failed.
    const capabilityWasReady = capability?.activationReady === true;
    const productReason = (capabilityWasReady || stage !== 'blocked-before-plan')
      ? 'transient-failure'
      : String(capability?.productReason || 'layout-incomplete');
    const diagnostic = record(stage, {
      internalReason,
      productReason,
      generation: capability?.generation,
      effectiveFingerprint: capability?.effectiveFingerprint,
      graphFingerprint: capability?.graphFingerprint,
    });
    const readiness = frozenCollapsedBoundaryResult({
      pageNum: num,
      ready: false,
      reason: internalReason,
      productReason,
      structuralReason: productReason === 'layout-incomplete' ? internalReason : '',
      generation: capability?.generation,
      fingerprint: capability?.effectiveFingerprint,
      prerequisitesReady: capability?.prerequisitesReady === true,
      activationReady: capabilityWasReady,
    });
    if (explicitCollapseFeedbackSource(source)) {
      showCollapseUnavailableFeedback(num, id, readiness);
    }
    recordCollapsedBoundaryDiagnostic(num, readiness, source);
    return {
      ok: false,
      status,
      reason: internalReason,
      pageNum: num,
      chatId: id,
      diagnostic,
    };
  }

  function failClosedCollapsedTitleList(pageNum = 0, chatId = '', readiness = null, source = '') {
    const num = Math.max(1, Number(pageNum || 0) || 0);
    const id = String(chatId || resolveChatId()).trim();
    const key = collapsedNativeRangeKey(id, num);
    const transaction = S.atomicPageCollapseTransactions.get(key) || null;
    if (transaction) {
      expandPageWithRenderedBoundaries(num, {
        chatId: id,
        source: `fail-closed:${String(source || '')}`,
      });
    } else {
      releaseCollapsedNativeRange(num);
      S.nativeRangeActivePages.delete(key);
      localForgetTitleListPage(id, num);
      try { syncSyntheticTitleList(num, id, false, { reason: 'collapsed-exact-boundary-unavailable' }); } catch {}
    }
    const diagnostic = recordCollapsedBoundaryDiagnostic(num, readiness, source);
    if (explicitCollapseFeedbackSource(source)) {
      showCollapseUnavailableFeedback(num, id, readiness);
    }
    return {
      ok: false,
      status: 'collapsed-exact-boundary-unavailable',
      reason: String(readiness?.reason || diagnostic.reason),
      pageNum: num,
      chatId: id,
      enabled: false,
      diagnostic,
    };
  }

  function purePresentationPageMemberDetails(pageNum = 0) {
    const num = Math.max(1, Number(pageNum || 0) || 0);
    const authority = readTitleListPresentationAuthority();
    return authority.members.filter((member) => Math.ceil(Number(member?.turnNo || 0) / 25) === num);
  }

  function titleListPageHydrationIds(pages = []) {
    return Array.from(new Set((Array.isArray(pages) ? pages : []).flatMap((page) => (
      (Array.isArray(page?.turnRecords) ? page.turnRecords : []).flatMap((member) => [
        member?.questionId,
        member?.answerId,
        member?.turnId,
        ...(Array.isArray(member?.aliasIds) ? member.aliasIds : []),
      ])
    )).map((value) => String(value || '').trim()).filter(Boolean)));
  }

  function recoverMissingTitleListPageMembers(normalPages = [], model = null, mountGuard = null) {
    const pageModel = model?.pages ? model : buildTitleListPresentationPageModel();
    const identity = JSON.stringify([
      String(pageModel?.source || ''),
      Math.max(0, Number(pageModel?.count || 0) || 0),
      Math.max(0, Number(pageModel?.pageCount || 0) || 0),
      (Array.isArray(normalPages) ? normalPages : []).map((page) => Number(page?.pageNo || 0)),
      (Array.isArray(normalPages) ? normalPages : []).flatMap((page) => (
        (Array.isArray(page?.turnRecords) ? page.turnRecords : []).map((member) => (
          String(member?.questionId || member?.answerId || member?.turnId || '').trim()
        ))
      )),
    ]);
    if (S.titleListHydrationRecoveryIdentity !== identity) {
      S.titleListHydrationRecoveryIdentity = identity;
      S.titleListHydrationRecoveryIds.clear();
    }
    const um = UM_ADAPTER();
    const canRecover = String(mountGuard?.status || '') === 'guarded-unchanged';
    let represented = 0;
    let missing = 0;
    let requested = 0;
    const missingOrders = [];
    for (const page of Array.isArray(normalPages) ? normalPages : []) {
      for (const member of Array.isArray(page?.turnRecords) ? page.turnRecords : []) {
        const key = String(member?.questionId || member?.answerId || member?.turnId || '').trim();
        if (titleListMemberMateriallyPresent(member)) {
          represented += 1;
          if (key) S.titleListHydrationRecoveryIds.delete(key);
          continue;
        }
        missing += 1;
        missingOrders.push(Math.max(0, Number(member?.turnNo || 0) || 0));
        if (!canRecover || !key || S.titleListHydrationRecoveryIds.has(key)) continue;
        let accepted = false;
        try { accepted = um?.requestMountPairByUid?.(key, 'title-list-adjacent-page-recovery') === true; } catch {}
        if (!accepted) {
          try { accepted = um?.requestMountByUid?.(key, 'title-list-adjacent-page-recovery') === true; } catch {}
        }
        if (accepted) {
          S.titleListHydrationRecoveryIds.add(key);
          requested += 1;
        }
      }
    }
    return {
      represented,
      missing,
      missingOrders,
      requested,
      pending: S.titleListHydrationRecoveryIds.size,
    };
  }

  // Keep only the immediately adjacent, uncollapsed page(s) materialized.
  // Pagination temporarily restores its already-captured full flow; Unmount
  // then guards just those adjacent page identities. Farther pages remain
  // eligible for the existing optimizer, so title-list mode never becomes a
  // second virtualization system or an indefinite full-chat mount request.
  function reconcileTitleListPageHydration(chatId = '', opts = {}) {
    const id = String(chatId || resolveChatId()).trim();
    const model = buildTitleListPresentationPageModel();
    const activePages = Array.from(readTitleListPages(id))
      .map((value) => Math.max(1, Number(value || 0) || 0))
      .filter((pageNo) => pageNo <= model.pageCount)
      .sort((a, b) => a - b);
    const stampCleanup = typeof reconcileTitleListFlowHiddenArtifacts === 'function'
      ? reconcileTitleListFlowHiddenArtifacts(model, new Set(activePages))
      : { scanned: 0, kept: 0, released: 0 };
    const pg = PG_ADAPTER();
    const um = UM_ADAPTER();
    if (!activePages.length || !model.coherent) {
      let pagination = null;
      let mountGuard = null;
      try { mountGuard = um?.setPresentationMountGuard?.(TITLE_LIST_PAGE_HYDRATION_OWNER, []); } catch {}
      try { pagination = pg?.setPresentationFullFlowHold?.(TITLE_LIST_PAGE_HYDRATION_OWNER, false); } catch {}
      const timestamps = syncTitleListNativeTimestampVisibility(model, new Set());
      S.titleListPageHydration = {
        active: false,
        source: model.source,
        count: model.count,
        pageCount: model.pageCount,
        normalPages: [],
        guardedIds: 0,
        paginationHeld: false,
      };
      return {
        ok: model.coherent || model.count === 0,
        status: activePages.length ? 'authority-incomplete' : 'inactive',
        model,
        activePages,
        normalPages: [],
        pagination,
        mountGuard,
        stampCleanup,
        timestamps,
      };
    }

    // The adjacent normal page is part of the same visible title-list
    // presentation. It cannot remain in Pagination's detached window or
    // Unmount's background fragment cache while its divider says it is open.
    let pagination = null;
    try { pagination = pg?.setPresentationFullFlowHold?.(TITLE_LIST_PAGE_HYDRATION_OWNER, true); } catch {}
    const activeSet = new Set(activePages);
    const normalPages = model.pages.filter((page) => (
      !activeSet.has(page.pageNo)
      && activePages.some((activePage) => Math.abs(page.pageNo - activePage) === 1)
    ));
    const guardIds = titleListPageHydrationIds(normalPages);
    let mountGuard = null;
    try { mountGuard = um?.setPresentationMountGuard?.(TITLE_LIST_PAGE_HYDRATION_OWNER, guardIds); } catch {}
    const materialization = typeof recoverMissingTitleListPageMembers === 'function'
      ? recoverMissingTitleListPageMembers(normalPages, model, mountGuard)
      : { represented: 0, missing: 0, missingOrders: [], requested: 0, pending: 0 };

    // The pagination hold restores master turn wrappers synchronously and the
    // mount guard restores any H2O-soft-unmounted bodies synchronously. Divider
    // rendering can therefore use exact page-start identity in this same
    // stable reconstruction pass.
    try { MM_CORE_PAGES()?.renderDividers?.(id); } catch {}
    const timestamps = syncTitleListNativeTimestampVisibility(model, activeSet);
    S.titleListPageHydration = {
      active: true,
      source: model.source,
      count: model.count,
      pageCount: model.pageCount,
      normalPages: normalPages.map((page) => page.pageNo),
      guardedIds: guardIds.length,
      paginationHeld: pagination?.active === true,
    };
    return {
      ok: pagination?.ok !== false && mountGuard?.ok !== false,
      status: 'materialized',
      reason: String(opts?.reason || 'title-list'),
      model,
      activePages,
      normalPages: normalPages.map((page) => page.pageNo),
      guardedIds: guardIds.length,
      pagination,
      mountGuard,
      materialization,
      stampCleanup,
      timestamps,
    };
  }

  function isSyntheticTitlePlaceholder(value = '') {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    if (!text) return true;
    if (/^(?:…|\.{2,}|untitled answer|answer(?:\s+\d+)?|\d+)$/i.test(text)) return true;
    return false;
  }

  function titleListAnswerFamilyIds(member = null) {
    if (!member || member.type !== 'answer') return [];
    const ids = new Set([
      member.answerId,
      member.id,
      ...(Array.isArray(member.aliasIds) ? member.aliasIds : []),
    ].map((value) => String(value || '').trim()).filter(Boolean));
    let rec = turnRecordForTitleListIdentity(member.answerId || member.questionId || member.id, member.turnNo);
    const recTurnNo = Math.max(0, Number(rec?.turnNo || rec?.idx || 0) || 0);
    if (recTurnNo && member.turnNo && recTurnNo !== member.turnNo) rec = null;
    for (const value of [rec?.primaryAId, rec?.answerId, ...(Array.isArray(rec?.answerIds) ? rec.answerIds : []), ...(Array.isArray(rec?._aliasIds) ? rec._aliasIds : [])]) {
      const id = String(value || '').trim();
      if (id) ids.add(id);
    }
    return Array.from(ids);
  }

  function titleListIdentityMatchesMember(anyId = '', member = null) {
    const id = String(anyId || '').trim();
    if (!id || !member || member.type !== 'answer') return false;
    if (titleListAnswerFamilyIds(member).includes(id)) return true;
    const rec = turnRecordForTitleListIdentity(id, 0);
    const recTurnNo = Math.max(0, Number(rec?.turnNo || rec?.idx || 0) || 0);
    return !!(recTurnNo && member.turnNo && recTurnNo === member.turnNo);
  }

  function titleBarStrictlyMatchesMember(bar = null, member = null) {
    if (!bar || !member || member.type !== 'answer') return false;
    const barTurnNo = Math.max(0, Number(
      bar.getAttribute?.('data-h2o-stack-turn-no')
        || bar.getAttribute?.('data-h2o-turn-num')
        || 0
    ) || 0);
    // A canonical turn number is stronger than a transient hydration alias.
    // If both sides have one, a mismatch is terminal: never borrow that bar.
    const barId = String(bar.getAttribute?.('data-answer-id') || '').trim();
    if (barTurnNo && member.turnNo && barTurnNo !== member.turnNo) return false;
    if (barId) return titleListIdentityMatchesMember(barId, member);
    return !!(barTurnNo && member.turnNo && barTurnNo === member.turnNo);
  }

  // Ranked title sources — a known real title must never regress to a lower
  // rank: hydrated bar text (3) > persisted title cache (2) > canonical
  // record metadata (1) > fallback (0). No-answer rows carry no title text;
  // their identity IS the NO ANSWER badge.
  function resolveSyntheticRowTitle(member = null) {
    if (!member) return { text: '', source: 'fallback', rank: 0 };
    if (member.type !== 'answer') return { text: '', source: 'no-answer', rank: 3 };
    const at = AT_PUBLIC();
    const familyIds = titleListAnswerFamilyIds(member);
    let stackedCandidate = null;
    for (const answerId of familyIds) {
      try {
        const bar = at?.getBar?.(answerId) || null;
        if (!titleBarStrictlyMatchesMember(bar, member)) continue;
        const liveText = String(bar?.querySelector?.('[data-cgxui="atns-answer-title-text"]')?.textContent || '').trim();
        if (isSyntheticTitlePlaceholder(liveText)) continue;
        if (bar?.hasAttribute?.('data-h2o-in-title-stack')) {
          // A stacked row is a projection, not an independent authoritative
          // source. Keep it only as a last-known fallback so a corrected cache
          // or canonical metadata title can repair stale projected text.
          if (!stackedCandidate) stackedCandidate = { text: liveText, source: 'stacked-existing', rank: 1, answerId };
          continue;
        }
        return { text: liveText, source: 'hydrated', rank: 3, answerId };
      } catch {}
    }
    for (const answerId of familyIds) {
      try {
        if (!titleListIdentityMatchesMember(answerId, member)) continue;
        const cached = String(at?.getTitle?.(answerId) || '').trim();
        if (!isSyntheticTitlePlaceholder(cached)) return { text: cached, source: 'cached', rank: 2, answerId };
      } catch {}
    }
    try {
      const rec = turnRecordForTitleListIdentity(member.answerId || member.questionId || member.id, member.turnNo);
      const metaTitle = String(rec?.title || rec?.answerTitle || '').trim();
      if (!isSyntheticTitlePlaceholder(metaTitle)) return { text: metaTitle, source: 'metadata', rank: 1, answerId: member.answerId };
    } catch {}
    if (stackedCandidate) return stackedCandidate;
    return { text: 'Untitled Answer', source: 'fallback', rank: 0, answerId: member.answerId };
  }

  function setTitleListMemberFlowHidden(member = null, pageNum = 0, hidden = false) {
    if (!member) return false;
    if (
      hidden
      && S.nativeRangeActivePages.has(collapsedNativeRangeKey(resolveChatId(), pageNum))
    ) return false;
    // Hide/release every shell for this canonical turn, not only the first
    // section lookup. ChatGPT can briefly retain an older shell while a new
    // hydrated shell is mounted; either one becoming visible is a flow leak.
    const targets = memberAllFlowAnchors(member);
    if (!targets.length) return false;
    let changed = false;
    for (const node of targets) {
      if (setTitleListFlowAnchorHidden(node, pageNum, hidden)) changed = true;
    }
    return changed;
  }

  // Restore is stamp-driven (like sweepPageHiddenDomState): membership may
  // have changed since collapse, so we release whatever collapse stamped.
  function sweepSyntheticTitleListHidden(pageNum = 0) {
    const num = Math.max(0, Number(pageNum || 0) || 0);
    const sel = num
      ? `[${ATTR_TITLE_LIST_FLOW_HIDDEN}="${String(num)}"]`
      : `[${ATTR_TITLE_LIST_FLOW_HIDDEN}]`;
    let released = 0;
    try {
      for (const node of Array.from(document.querySelectorAll(sel))) {
        try { node.removeAttribute(ATTR_TITLE_LIST_FLOW_HIDDEN); } catch {}
        try { node.style.removeProperty('display'); } catch {}
        released += 1;
      }
    } catch {}
    return released;
  }

  // Collapse-route markers a page-level expand must release from member
  // sections. Page-collapse (lightening) markers are NOT listed — that
  // mechanism owns its own stamps and sweeps (sweepPageHiddenDomState).
  const MEMBER_RELEASE_MARKERS = [
    'data-cgxui-at-hidden',
    'data-at-question-hidden',
    ATTR_CHAT_PAGE_QUESTION_HIDDEN,
    ATTR_CHAT_PAGE_NO_ANSWER_QUESTION_HIDDEN,
    ATTR_TITLE_LIST_FLOW_HIDDEN,
  ];
  const MEMBER_RELEASE_SEL = MEMBER_RELEASE_MARKERS.map((a) => `[${a}]`).join(',');

  function getPageMemberCollapseSources(member = null) {
    const answerId = String(member?.answerId || '').trim();
    const state = { answerTitle: false, titleListRow: false, pageCollapse: false, allManual: false };
    if (!answerId) return state;
    try {
      const um = UM_PUBLIC();
      state.answerTitle = !!um?.isCollapsedById?.(answerId, { source: 'answer-title' });
      state.titleListRow = !!um?.isCollapsedById?.(answerId, { source: 'title-list-row' });
      state.pageCollapse = !!um?.isCollapsedById?.(answerId, { source: 'page-collapse' });
      state.allManual = !!um?.isCollapsedById?.(answerId);
    } catch {}
    return state;
  }

  function pageMemberFlowScopes(member = null) {
    const scopes = new Set();
    if (!member) return [];
    try { for (const anchor of memberAllFlowAnchors(member)) if (anchor) scopes.add(anchor); } catch {}
    try {
      const sections = titleListMemberSections(member);
      if (sections.questionSection) scopes.add(sections.questionSection);
      if (sections.answerSection) scopes.add(sections.answerSection);
    } catch {}
    return Array.from(scopes).filter((node) => node?.isConnected);
  }

  function hasTitleCollapseInlineResidue(node = null) {
    if (!node?.style) return false;
    const style = node.style;
    return String(style.maxHeight || '') === '0px'
      || (String(style.height || '') === '0px' && String(style.overflow || '') === 'hidden')
      || (String(style.opacity || '') === '0' && String(style.pointerEvents || '') === 'none');
  }

  function releasePageMemberProjection(member = null, pageNum = 0) {
    if (!member) return { releasedNodes: 0, skippedActiveSource: false };
    const sources = getPageMemberCollapseSources(member);
    if (sources.allManual) return { releasedNodes: 0, skippedActiveSource: true, sources };
    let releasedNodes = 0;
    const seen = new Set();
    for (const scope of pageMemberFlowScopes(member)) {
      const nodes = new Set([scope]);
      try {
        for (const inner of scope.querySelectorAll?.(`${MEMBER_RELEASE_SEL}, [data-at-collapsed], [style]`) || []) {
          if (inner.matches?.(MEMBER_RELEASE_SEL)
            || inner.getAttribute?.('data-at-collapsed') === '1'
            || hasTitleCollapseInlineResidue(inner)) nodes.add(inner);
        }
      } catch {}
      for (const node of nodes) {
        if (!node || seen.has(node)) continue;
        seen.add(node);
        let ownedResidue = hasTitleCollapseInlineResidue(node)
          || node.getAttribute?.('data-at-collapsed') === '1';
        for (const attr of MEMBER_RELEASE_MARKERS) {
          try {
            if (node.getAttribute?.(attr) != null) {
              node.removeAttribute(attr);
              ownedResidue = true;
            }
          } catch {}
        }
        try {
          if (node.getAttribute?.('data-at-collapsed') === '1') {
            node.removeAttribute('data-at-collapsed');
            ownedResidue = true;
          }
        } catch {}
        if (!ownedResidue) continue;
        const pageCollapseOwned = !!(node.hasAttribute?.(ATTR_CHAT_PAGE_HIDDEN)
          || node.hasAttribute?.(ATTR_CHAT_PAGE_WRAPPER_HIDDEN));
        _clearRestoreProps(node);
        if (!pageCollapseOwned) { try { node.style.removeProperty('display'); } catch {} }
        releasedNodes += 1;
      }
    }
    return { releasedNodes, skippedActiveSource: false, sources };
  }

  // Page-member stamp release for circle/dot EXPAND. at.sync() only clears
  // members whose assistant node is hydrated (unhydrated → 'answer-missing'
  // no-op), and adjacency-based question resolution misses multi-variant
  // "(2/2)" user turns — so answer-id/body-based cleanup alone strands their
  // question sections stamped hidden. This sweep is CANONICAL-MEMBER based:
  // the same record-backed section/anchor resolution the residual audit uses
  // (persistent shells survive virtualization), so every node the audit can
  // flag, this release can reach. Ledger-guarded per member: an id still
  // manually collapsed (any source — i.e. individual state on this page or a
  // race) keeps its projection untouched. Nodes owned by page-lightening keep
  // their display state.
  function releasePageMemberHideMarkers(pageNum = 0) {
    const num = Math.max(1, Number(pageNum || 0) || 0);
    let releasedNodes = 0;
    const releasedMemberIds = [];
    const skippedMemberIds = [];
    let membersScanned = 0;
    for (const member of pureCanonicalPageMemberDetails(num)) {
      membersScanned += 1;
      const released = releasePageMemberProjection(member, num);
      const memberNodes = Number(released.releasedNodes || 0);
      if (released.skippedActiveSource) skippedMemberIds.push(member.id);
      if (memberNodes) { releasedNodes += memberNodes; releasedMemberIds.push(member.id); }
    }
    return { ok: true, membersScanned, releasedNodes, releasedMemberIds, skippedMemberIds };
  }

  function clearResidualPageTitleCollapseSources(pageNum = 0) {
    const num = Math.max(1, Number(pageNum || 0) || 0);
    const members = pureCanonicalPageMemberDetails(num).filter((member) => member.type === 'answer' && member.answerId);
    const um = UM_PUBLIC();
    const cleared = {};
    for (const [key, source] of [['titleListRow', 'title-list-row'], ['answerTitle', 'answer-title']]) {
      const ids = members.filter((member) => {
        try { return !!um?.isCollapsedById?.(member.answerId, { source }); } catch { return false; }
      }).map((member) => member.answerId);
      if (!ids.length || typeof um?.expandManyByIds !== 'function') {
        cleared[key] = { ids, result: null };
        continue;
      }
      let result = null;
      try { result = um.expandManyByIds(ids, { source, emitLegacyAnswerCollapse: false }); } catch {}
      cleared[key] = { ids, result };
    }
    return cleared;
  }

  function pageMemberVisualState(node = null) {
    if (!node) return null;
    let cs = null; let rectHeight = 0; let rectWidth = 0;
    try { cs = getComputedStyle(node); } catch {}
    try {
      const rect = node.getBoundingClientRect();
      rectHeight = Number(rect.height || 0);
      rectWidth = Number(rect.width || 0);
    } catch {}
    return {
      exists: true,
      visible: rectHeight > 0 && rectWidth > 0
        && String(cs?.display || '') !== 'none'
        && String(cs?.visibility || '') !== 'hidden'
        && Number.parseFloat(String(cs?.opacity || '1')) > 0,
      display: String(cs?.display || ''),
      inlineDisplay: String(node.style?.display || ''),
      maxHeight: String(node.style?.maxHeight || ''),
      height: String(node.style?.height || ''),
      overflow: String(node.style?.overflow || ''),
      opacity: String(node.style?.opacity || ''),
      rectHeight: Number(rectHeight.toFixed(2)),
      styleCollapsed: hasTitleCollapseInlineResidue(node),
    };
  }

  function auditExpandedPageMember(member = null, pageNum = 0) {
    const at = AT_PUBLIC();
    const sources = getPageMemberCollapseSources(member);
    const sections = titleListMemberSections(member);
    const answerProjection = member?.type === 'answer' && member.answerId
      ? (at?.inspectCollapseProjection?.(member.answerId) || null)
      : null;
    const bars = [];
    try {
      for (const bar of Array.from(document.querySelectorAll('[data-cgxui="atns-answer-title"]'))) {
        if (stackRowMatchesMember(bar, member)) bars.push(bar);
      }
    } catch {}
    const visibleBars = bars.filter((bar) => pageMemberVisualState(bar)?.visible);
    const questionRole = sections.questionSection?.matches?.('[data-message-author-role="user"]')
      ? sections.questionSection
      : sections.questionSection?.querySelector?.('[data-message-author-role="user"]') || null;
    const answerRole = sections.answerSection?.matches?.('[data-message-author-role="assistant"]')
      ? sections.answerSection
      : sections.answerSection?.querySelector?.('[data-message-author-role="assistant"]') || null;
    const questionHydrated = !!questionRole;
    const answerHydrated = member?.type === 'answer' ? !!(answerRole || answerProjection?.hydrated) : false;
    const questionState = pageMemberVisualState(sections.questionSection);
    const answerState = pageMemberVisualState(sections.answerSection);
    const markerDetails = [];
    const markerNames = new Set();
    const seen = new Set();
    for (const scope of pageMemberFlowScopes(member)) {
      const nodes = new Set([scope]);
      try {
        for (const inner of scope.querySelectorAll?.(`${MEMBER_RELEASE_SEL}, [data-at-collapsed], [style]`) || []) {
          if (inner.matches?.(MEMBER_RELEASE_SEL)
            || inner.getAttribute?.('data-at-collapsed') === '1'
            || hasTitleCollapseInlineResidue(inner)) nodes.add(inner);
        }
      } catch {}
      for (const node of nodes) {
        if (!node || seen.has(node)) continue;
        seen.add(node);
        const markers = MEMBER_RELEASE_MARKERS.filter((attr) => node.getAttribute?.(attr) != null);
        if (node.getAttribute?.('data-at-collapsed') === '1') markers.push('data-at-collapsed');
        const styleCollapsed = hasTitleCollapseInlineResidue(node);
        if (!markers.length && !styleCollapsed) continue;
        markers.forEach((attr) => markerNames.add(attr));
        if (markerDetails.length < 10) {
          markerDetails.push({
            tag: String(node.tagName || ''),
            testid: String(node.getAttribute?.('data-testid') || node.closest?.('[data-testid^="conversation-turn"]')?.getAttribute?.('data-testid') || ''),
            markers,
            styleCollapsed,
            visual: pageMemberVisualState(node),
          });
        }
      }
    }
    const barStates = bars.map((bar) => String(bar.getAttribute?.('data-cgxui-state') || ''));
    const barCollapsed = barStates.some((state) => state.split(/\s+/).includes('collapsed'));
    const pageLightenCollapsed = isPageCollapsed(pageNum, resolveChatId());
    const expectedExpanded = !pageLightenCollapsed;
    const failures = [];
    if (expectedExpanded) {
      if (sources.answerTitle) failures.push('active-source:answer-title');
      if (sources.titleListRow) failures.push('active-source:title-list-row');
      if (sources.pageCollapse) failures.push('active-source:page-collapse-with-page-expanded');
      if (sources.allManual && !sources.answerTitle && !sources.titleListRow && !sources.pageCollapse) {
        failures.push('active-source:other-manual');
      }
      if (markerDetails.length) failures.push('collapse-marker-or-style-residue');
      if (barCollapsed) failures.push('title-bar-collapsed');
      if (member.type === 'answer' && answerHydrated && answerProjection?.actuallyExpanded !== true) failures.push('answer-projection-collapsed');
      if (questionHydrated && questionState?.visible !== true) failures.push('question-host-hidden');
      if (answerHydrated && answerState?.visible !== true) failures.push('answer-host-hidden');
      if (member.type === 'answer' && answerHydrated && visibleBars.length !== 1) failures.push(`visible-title-bar-count:${visibleBars.length}`);
      if (visibleBars.length > 1) failures.push(`duplicate-visible-title-bars:${visibleBars.length}`);
    }
    return {
      id: member?.id || '',
      answerId: member?.answerId || '',
      questionId: member?.questionId || '',
      turnNo: Number(member?.turnNo || 0),
      type: member?.type || '',
      activeSources: sources,
      titleBarCount: bars.length,
      visibleTitleBarCount: visibleBars.length,
      titleBarState: barStates,
      titleBarText: visibleBars.map((bar) => String(bar.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 100)),
      questionHostExists: !!sections.questionSection,
      questionHostHydrated: questionHydrated,
      questionHostVisible: questionState?.visible ?? false,
      questionHost: questionState,
      answerHostExists: !!sections.answerSection,
      answerHostHydrated: answerHydrated,
      answerHostVisible: answerState?.visible ?? false,
      answerHost: answerState,
      bodyFoldTargetExists: !!answerProjection?.bodyTargetExists,
      bodyFoldTarget: answerProjection?.bodyTargets?.[0] || null,
      bodyFoldTargets: answerProjection?.bodyTargets || [],
      hideCollapseMarkers: Array.from(markerNames),
      hideCollapseMarkerDetails: markerDetails,
      expectedExpanded,
      actuallyExpanded: expectedExpanded ? failures.length === 0 : false,
      failures,
    };
  }

  function auditExpandedPageFlow(pageNum = 0, chatId = '') {
    const num = Math.max(1, Number(pageNum || 0) || 0);
    const id = String(chatId || resolveChatId()).trim();
    const members = pureCanonicalPageMemberDetails(num).map((member) => auditExpandedPageMember(member, num));
    const failures = members.filter((member) => member.expectedExpanded && !member.actuallyExpanded);
    const titleListActive = isTitleListActive(num, id);
    const pageLightenCollapsed = isPageCollapsed(num, id);
    return {
      pageNum: num,
      chatId: id,
      titleListActive,
      pageLightenCollapsed,
      members,
      residualCollapsedFlowMembers: failures,
      residualCollapsedFlowMemberCount: failures.length,
      pageMemberExpandedStateFailures: failures.map((member) => ({
        id: member.id,
        turnNo: member.turnNo,
        type: member.type,
        failures: member.failures,
      })),
      allPageMembersExpandedAfterDotExpand: !titleListActive && !pageLightenCollapsed && failures.length === 0,
      pageFlowRestored: !titleListActive && !pageLightenCollapsed && failures.length === 0,
    };
  }

  function convergeExpandedPageFlow(pageNum = 0, chatId = '', opts = {}) {
    const num = Math.max(1, Number(pageNum || 0) || 0);
    const id = String(chatId || resolveChatId()).trim();
    if (isTitleListActive(num, id) || isPageCollapsed(num, id)) {
      return { ok: true, status: 'not-expanded-page', pageNum: num, chatId: id, pageFlowRestored: false };
    }
    const sourceCleanup = opts?.clearSources === false ? null : clearResidualPageTitleCollapseSources(num);
    const markerReleaseBefore = releasePageMemberHideMarkers(num);
    const at = AT_PUBLIC();
    const memberResults = [];
    for (const member of pureCanonicalPageMemberDetails(num)) {
      const sources = getPageMemberCollapseSources(member);
      if (sources.allManual) {
        memberResults.push({ id: member.id, turnNo: member.turnNo, status: 'active-collapse-source', sources });
        continue;
      }
      if (member.type === 'answer' && member.answerId) {
        let result = null;
        try { result = at?.convergeExpandedProjection?.(member.answerId, { animate: false }) || null; } catch {}
        // Expansion owns visibility; Washer owns color. Replay after the fold
        // executor so a newly restored/rehydrated answer surface cannot remain
        // unwashed while its MiniMap projection is already gold.
        try { WASH_PUBLIC()?.replayForId?.(member.answerId); } catch {}
        memberResults.push({ id: member.id, turnNo: member.turnNo, status: result?.status || 'title-api-unavailable', result });
      } else {
        const sections = titleListMemberSections(member);
        const bar = Array.from(document.querySelectorAll('[data-cgxui="atns-answer-title"]'))
          .find((candidate) => stackRowMatchesMember(candidate, member)) || null;
        const result = applyNoAnswerTitleCollapsedDom(sections.questionSection, false, {
          animate: false,
          bar,
          questionHost: sections.questionSection,
        });
        memberResults.push({
          id: member.id,
          turnNo: member.turnNo,
          status: result?.status || 'no-answer-restore',
          restored: result?.ok !== false,
        });
      }
      releasePageMemberProjection(member, num);
    }
    const markerReleaseAfter = releasePageMemberHideMarkers(num);
    const audit = auditExpandedPageFlow(num, id);
    return {
      ok: audit.pageFlowRestored,
      status: audit.pageFlowRestored ? 'page-flow-restored' : 'page-flow-residual',
      pageNum: num,
      chatId: id,
      sourceCleanup,
      markerReleaseBefore,
      markerReleaseAfter,
      memberResults,
      ...audit,
    };
  }

  function dotExpandCampaignKey(pageNum = 0, chatId = '') {
    return `${String(chatId || resolveChatId()).trim()}::${Math.max(1, Number(pageNum || 0) || 0)}`;
  }

  function cancelDotExpandConvergence(pageNum = 0, chatId = '') {
    const key = dotExpandCampaignKey(pageNum, chatId);
    const campaign = S.dotExpandCampaigns.get(key) || null;
    if (campaign?.timer) { try { W.clearTimeout(campaign.timer); } catch {} }
    if (campaign) S.dotExpandCampaigns.delete(key);
    return !!campaign;
  }

  function scheduleDotExpandConvergence(pageNum = 0, chatId = '') {
    const num = Math.max(1, Number(pageNum || 0) || 0);
    const id = String(chatId || resolveChatId()).trim();
    const key = dotExpandCampaignKey(num, id);
    cancelDotExpandConvergence(num, id);
    const campaign = {
      token: ++S.dotExpandCampaignSeq,
      startedAt: Date.now(),
      runs: 0,
      timer: 0,
      lastResult: null,
      completedAt: 0,
    };
    S.dotExpandCampaigns.set(key, campaign);
    const delays = [0, 60, 260, 900, 1800];
    const run = (index) => {
      if (S.dotExpandCampaigns.get(key) !== campaign) return;
      if (isTitleListActive(num, id) || isPageCollapsed(num, id)) {
        cancelDotExpandConvergence(num, id);
        return;
      }
      campaign.runs += 1;
      campaign.lastResult = convergeExpandedPageFlow(num, id, { clearSources: true });
      if (index >= delays.length - 1) {
        campaign.completedAt = Date.now();
        campaign.timer = 0;
        return;
      }
      campaign.timer = W.setTimeout(() => run(index + 1), Math.max(0, delays[index + 1] - delays[index]));
    };
    run(0);
    return campaign.lastResult;
  }

  function titleListStackRegistryKey(pageNum = 0, chatId = '') {
    return `${String(chatId || resolveChatId()).trim()}::${Math.max(1, Number(pageNum || 0) || 1)}`;
  }

  function titleListStackDomId(pageNum = 0) {
    return `cgxui-chat-page-title-list-p${Math.max(1, Number(pageNum || 0) || 1)}`;
  }

  function getSyntheticTitleListContainers(pageNum = 0) {
    try {
      return Array.from(document.querySelectorAll(`${TITLE_LIST_SYNTH_SEL}[data-page-num="${String(pageNum)}"]`));
    } catch { return []; }
  }

  function getTitleListStackStats(pageNum = 0, chatId = '') {
    const key = titleListStackRegistryKey(pageNum, chatId);
    let stats = S.titleListStackStatsByKey.get(key) || null;
    if (!stats) {
      stats = {
        buildCount: 0,
        replaceCount: 0,
        reattachCount: 0,
        rowReplaceCount: 0,
        identityRekeyCount: 0,
        titleUpgradeCount: 0,
        titleDowngradePreventedCount: 0,
        mutationCount: 0,
        syncCount: 0,
        lastBuildReason: '',
        lastReplaceReason: '',
        lastReattachReason: '',
        lastSyncReason: '',
        lastStackMutationReason: '',
        firstListCreatedAt: 0,
        lastStackMutationAt: 0,
        lastListSettledAt: 0,
        stackRectBeforeOpen: null,
        stackRectAfterOpen: null,
        lastOpenedTurnNo: 0,
        activeStackId: '',
      };
      S.titleListStackStatsByKey.set(key, stats);
    }
    return stats;
  }

  function markTitleListStackMutation(stats = null, reason = '') {
    if (!stats) return;
    stats.mutationCount = Number(stats.mutationCount || 0) + 1;
    stats.lastStackMutationReason = String(reason || 'stack-mutation');
    stats.lastStackMutationAt = Date.now();
  }

  function scoreTitleListContainer(container = null) {
    if (!container) return -1;
    let rows = 0;
    let washed = 0;
    let opened = 0;
    try {
      for (const child of Array.from(container.children || [])) {
        if (!child.matches?.('[data-h2o-stack-key]')) continue;
        rows += 1;
        if (child.hasAttribute('data-h2o-title-wash')) washed += 1;
        if (child.getAttribute('data-h2o-title-row-opened') === '1') opened += 1;
      }
    } catch {}
    return (rows * 100) + (washed * 10) + (opened * 5);
  }

  function getSyntheticTitleListContainer(pageNum = 0, chatId = '') {
    const num = Math.max(1, Number(pageNum || 0) || 1);
    const key = titleListStackRegistryKey(num, chatId);
    const registered = S.titleListStacksByKey.get(key) || null;
    if (registered?.isConnected && registered.matches?.(`${TITLE_LIST_SYNTH_SEL}[data-page-num="${String(num)}"]`)) {
      return registered;
    }
    const containers = getSyntheticTitleListContainers(num);
    return containers.sort((a, b) => scoreTitleListContainer(b) - scoreTitleListContainer(a))[0] || null;
  }

  function claimSingleTitleListContainer(pageNum = 0, chatId = '', divider = null, reason = 'stack-sync') {
    const num = Math.max(1, Number(pageNum || 0) || 1);
    const id = String(chatId || resolveChatId()).trim();
    const key = titleListStackRegistryKey(num, id);
    const stats = getTitleListStackStats(num, id);
    stats.syncCount += 1;
    stats.lastSyncReason = String(reason || 'stack-sync');
    const expectedId = titleListStackDomId(num);
    const containers = getSyntheticTitleListContainers(num);
    const registered = S.titleListStacksByKey.get(key) || null;
    const registeredMatches = !!registered?.matches?.(`${TITLE_LIST_SYNTH_SEL}[data-page-num="${String(num)}"]`);
    let container = registeredMatches
      ? registered
      : (containers.find((entry) => entry.id === expectedId)
        || containers.sort((a, b) => scoreTitleListContainer(b) - scoreTitleListContainer(a))[0]
        || null);

    if (registeredMatches && !registered.isConnected) {
      stats.reattachCount += 1;
      stats.lastReattachReason = String(reason || 'stack-sync');
      markTitleListStackMutation(stats, `reattach:${String(reason || 'stack-sync')}`);
    }

    if (!container) {
      container = document.createElement('div');
      container.className = 'cgxui-chat-page-title-list-synth';
      container.setAttribute('data-cgxui', 'chat-page-title-list-synth');
      container.setAttribute('data-cgxui-owner', 'chtpgs');
      container.setAttribute('data-page-num', String(num));
      stats.buildCount += 1;
      stats.lastBuildReason = String(reason || 'stack-sync');
      if (!stats.firstListCreatedAt) stats.firstListCreatedAt = Date.now();
      markTitleListStackMutation(stats, `build:${String(reason || 'stack-sync')}`);
    }

    // A surviving stack can outlive a hot module refresh. Replace its prior
    // capture listener explicitly so one double-click always has one stack
    // executor, never the old and new module handlers together.
    const priorDblClick = container._h2oTitleListDblClickHandler || null;
    if (priorDblClick !== onSyntheticTitleRowDblClick) {
      if (typeof priorDblClick === 'function') {
        try { container.removeEventListener('dblclick', priorDblClick, true); } catch {}
      }
      try { container.addEventListener('dblclick', onSyntheticTitleRowDblClick, true); } catch {}
      try { container._h2oTitleListDblClickHandler = onSyntheticTitleRowDblClick; } catch {}
    }

    if (container.id !== expectedId) container.id = expectedId;
    if (container.getAttribute('data-h2o-title-stack-owner') !== '1C1b:syncSyntheticTitleList') {
      container.setAttribute('data-h2o-title-stack-owner', '1C1b:syncSyntheticTitleList');
    }
    if (container.getAttribute('data-h2o-title-stack-id') !== expectedId) {
      container.setAttribute('data-h2o-title-stack-id', expectedId);
    }
    if (!container.hasAttribute('data-h2o-title-stack-seq')) {
      container.setAttribute('data-h2o-title-stack-seq', String(++S.titleListStackSequence));
    }
    S.titleListStacksByKey.set(key, container);
    stats.activeStackId = expectedId;

    // Older/hot-reloaded builds may have left more than one H2O projection.
    // Merge H2O title rows only. A duplicate containing any foreign/native
    // child fails closed in place; this owner must never move or delete it.
    for (const duplicate of getSyntheticTitleListContainers(num)) {
      if (duplicate === container) continue;
      const foreignChildren = Array.from(duplicate.children || []).filter(
        (child) => !child.matches?.('[data-h2o-stack-key]')
      );
      for (const row of Array.from(duplicate.children || [])) {
        if (!row.matches?.('[data-h2o-stack-key]')) continue;
        const rowKey = String(row.getAttribute('data-h2o-stack-key') || '');
        let existing = null;
        try {
          const esc = (typeof CSS !== 'undefined' && CSS.escape) ? CSS.escape(rowKey) : rowKey.replace(/"/g, '\\"');
          existing = container.querySelector(`:scope > [data-h2o-stack-key="${esc}"]`);
        } catch {}
        if (!existing) {
          try { container.appendChild(row); } catch {}
        } else {
          try { row.remove(); } catch {}
        }
      }
      if (!foreignChildren.length) {
        try { duplicate.remove(); } catch {}
      }
      stats.replaceCount += 1;
      stats.lastReplaceReason = `duplicate-container:${String(reason || 'stack-sync')}`;
      markTitleListStackMutation(stats, stats.lastReplaceReason);
    }

    if (divider?.parentNode && divider.nextElementSibling !== container) {
      try {
        divider.parentNode.insertBefore(container, divider.nextSibling);
        markTitleListStackMutation(stats, `anchor:${String(reason || 'stack-sync')}`);
      } catch {}
    }
    return container;
  }

  function titleBarMemberId(bar = null) {
    const stackKey = String(bar?.getAttribute?.('data-h2o-stack-key') || '').trim();
    if (stackKey) return stackKey;
    const answerId = String(bar?.getAttribute?.('data-answer-id') || '').trim();
    return answerId.startsWith('no-answer:') ? answerId.slice('no-answer:'.length) : answerId;
  }

  function stackRowMatchesMember(row = null, member = null) {
    if (!row || !member) return false;
    const rowType = String(row.getAttribute?.('data-h2o-stack-type') || (row.hasAttribute?.('data-at-no-answer') ? 'no-answer' : 'answer'));
    if (rowType !== member.type) return false;
    const rowTurnNo = Math.max(0, Number(row.getAttribute?.('data-h2o-stack-turn-no') || row.getAttribute?.('data-h2o-turn-num') || 0) || 0);
    if (rowTurnNo && member.turnNo) return rowTurnNo === member.turnNo;
    const rowId = titleBarMemberId(row);
    if (!rowId) return false;
    if (rowType !== 'answer') {
      return rowId === member.id || rowId === member.questionId;
    }
    return titleListIdentityMatchesMember(rowId, member);
  }

  function findStackRowForMember(container = null, member = null) {
    if (!container || !member) return null;
    try {
      const esc = (typeof CSS !== 'undefined' && CSS?.escape) ? CSS.escape(member.id) : member.id.replace(/"/g, '\\"');
      const exact = container.querySelector(`:scope > [data-h2o-stack-key="${esc}"]`);
      if (exact) return exact;
    } catch {}
    try {
      return Array.from(container.children || []).find((row) => (
        row.matches?.('[data-h2o-stack-key]') && stackRowMatchesMember(row, member)
      )) || null;
    } catch { return null; }
  }

  function projectSyntheticRowTitle(member = null, bar = null) {
    if (!bar || !member) return { changed: false, preventedDowngrade: false, source: '' };
    if (member.type !== 'answer') {
      const changed = bar.getAttribute('data-h2o-title-row-source') !== 'no-answer'
        || bar.getAttribute('data-h2o-title-row-source-rank') !== '3';
      if (changed) {
        bar.setAttribute('data-h2o-title-row-source', 'no-answer');
        bar.setAttribute('data-h2o-title-row-source-rank', '3');
        bar.removeAttribute('data-h2o-title-row-source-id');
      }
      return { changed, preventedDowngrade: false, source: 'no-answer' };
    }
    const textEl = bar.querySelector?.('[data-cgxui="atns-answer-title-text"]') || null;
    const currentText = String(textEl?.textContent || '').trim();
    const currentReal = !isSyntheticTitlePlaceholder(currentText);
    const currentRank = currentReal
      ? Math.max(1, Number(bar.getAttribute('data-h2o-title-row-source-rank') || 3) || 3)
      : 0;
    const resolved = resolveSyntheticRowTitle(member);
    const resolvedReal = !isSyntheticTitlePlaceholder(resolved.text) && resolved.source !== 'fallback';
    const currentSourceId = String(bar.getAttribute('data-h2o-title-row-source-id') || '').trim();
    const resolvedSourceId = String(resolved.answerId || member.answerId || '').trim();
    let changed = false;
    let preventedDowngrade = false;
    // The resolver is now turn-validated. Equal-rank text from the canonical
    // member must correct a row that was previously populated through a
    // colliding alias; rank alone cannot make wrong text permanent.
    if (resolvedReal && (
      !currentReal
      || resolved.rank > currentRank
      || currentText !== resolved.text
      || (resolvedSourceId && currentSourceId !== resolvedSourceId)
    )) {
      if (textEl && currentText !== resolved.text) { textEl.textContent = resolved.text; changed = true; }
      if (bar.getAttribute('data-h2o-title-row-source') !== resolved.source) {
        bar.setAttribute('data-h2o-title-row-source', resolved.source);
        changed = true;
      }
      if (bar.getAttribute('data-h2o-title-row-source-rank') !== String(resolved.rank)) {
        bar.setAttribute('data-h2o-title-row-source-rank', String(resolved.rank));
        changed = true;
      }
      if (resolvedSourceId && currentSourceId !== resolvedSourceId) {
        bar.setAttribute('data-h2o-title-row-source-id', resolvedSourceId);
        changed = true;
      }
    } else if (currentReal) {
      preventedDowngrade = !resolvedReal || resolved.rank < currentRank;
      if (!bar.hasAttribute('data-h2o-title-row-source')) {
        bar.setAttribute('data-h2o-title-row-source', 'hydrated');
        changed = true;
      }
      if (!bar.hasAttribute('data-h2o-title-row-source-rank')) {
        bar.setAttribute('data-h2o-title-row-source-rank', String(currentRank));
        changed = true;
      }
      if (!bar.hasAttribute('data-h2o-title-row-source-id')) {
        const barId = String(bar.getAttribute('data-answer-id') || member.answerId || '').trim();
        if (barId) bar.setAttribute('data-h2o-title-row-source-id', barId);
      }
    } else {
      const source = resolvedReal ? resolved.source : 'fallback';
      const rank = resolvedReal ? resolved.rank : 0;
      if (resolvedReal && textEl && currentText !== resolved.text) { textEl.textContent = resolved.text; changed = true; }
      if (bar.getAttribute('data-h2o-title-row-source') !== source) { bar.setAttribute('data-h2o-title-row-source', source); changed = true; }
      if (bar.getAttribute('data-h2o-title-row-source-rank') !== String(rank)) { bar.setAttribute('data-h2o-title-row-source-rank', String(rank)); changed = true; }
      if (resolvedSourceId && bar.getAttribute('data-h2o-title-row-source-id') !== resolvedSourceId) {
        bar.setAttribute('data-h2o-title-row-source-id', resolvedSourceId);
        changed = true;
      }
    }
    return {
      changed,
      preventedDowngrade,
      source: String(bar.getAttribute('data-h2o-title-row-source') || ''),
    };
  }

  function removeDuplicateFlowBarsForStackedMember(member = null, keepBar = null, titleBarPool = null) {
    if (!member?.id || !keepBar) return 0;
    let removed = 0;
    const candidates = new Set();
    try {
      const pool = Array.isArray(titleBarPool)
        ? titleBarPool
        : Array.from(document.querySelectorAll('[data-cgxui="atns-answer-title"][data-cgxui-owner="atns"]'));
      for (const candidate of pool) {
        if (!candidate?.isConnected) continue;
        if (candidate !== keepBar && stackRowMatchesMember(candidate, member)) candidates.add(candidate);
      }
    } catch {}
    // A title created during a partially hydrated pass can briefly lack its
    // answer-id. Canonical Q+A wrappers are a stronger ownership boundary
    // than that incomplete projection, so remove every competing title bar
    // inside this member's own flow anchors as well.
    try {
      for (const anchor of memberFlowAnchors(member)) {
        for (const candidate of Array.from(anchor.querySelectorAll?.('[data-cgxui="atns-answer-title"][data-cgxui-owner="atns"]') || [])) {
          if (candidate !== keepBar) candidates.add(candidate);
        }
      }
    } catch {}
    for (const candidate of candidates) {
      try { candidate.remove(); removed += 1; } catch {}
    }
    return removed;
  }

  function applyStackedTitleBarWash(member = null, bar = null) {
    if (!bar) return { ok: false, status: 'bar-missing' };
    const wash = WASH_PUBLIC();
    if (typeof wash?.applyToTitleBar !== 'function') return { ok: false, status: 'washer-api-unavailable' };
    const answerId = member?.type === 'answer' ? String(member.answerId || member.id || '').trim() : '';
    let resolved = null;
    try {
      resolved = wash?.resolveForId?.(answerId) || null;
      const existing = String(bar.getAttribute?.('data-h2o-title-wash') || '').trim();
      // Stack reconciliation is not the washer removal executor. If canonical
      // identity is temporarily incomplete, preserve the already-projected
      // color; an explicit washer change event clears it through 1A2a.
      if (!resolved?.colorName && existing) {
        return { ok: true, status: 'preserved-existing-on-identity-miss', colorName: existing };
      }
    } catch {}
    try {
      if (resolved?.colorName && typeof wash?.replayForId === 'function') {
        return wash.replayForId(answerId, { barEl: bar }) || { ok: true, status: 'replayed' };
      }
      return wash.applyToTitleBar(answerId, bar) || { ok: true, status: 'applied' };
    } catch { return { ok: false, status: 'washer-apply-failed' }; }
  }

  // Canonical physical lookup is ephemeral. The opened turn always remains
  // under its current host-owned flow parent; H2O moves only its own title
  // rows into prefix/suffix projection containers around that position.
  function memberFlowAnchors(member) {
    const out = [];
    const sections = titleListMemberSections(member);
    if (member?.type === 'answer' && member.answerId) {
      const section = sections.answerSection;
      const qHost = sections.questionSection
        || (section ? getQuestionHostForAnswerHost(section, null, { turnHostOnly: true }) : null);
      const qAnchor = qHost ? getTurnAnchorNode(qHost) : null;
      if (qAnchor) out.push(qAnchor);
      if (section) {
        const aAnchor = getTurnAnchorNode(section);
        if (aAnchor && aAnchor !== qAnchor) out.push(aAnchor);
      }
    } else if (member?.questionId) {
      const qSection = sections.questionSection;
      const qAnchor = qSection ? getTurnAnchorNode(qSection) : null;
      if (qAnchor) out.push(qAnchor);
    }
    return out;
  }

  function memberSectionCandidates(member = null, role = '') {
    if (!member) return [];
    const wantedRole = String(role || '').trim().toLowerCase();
    const record = turnRecordForTitleListIdentity(member.answerId || member.questionId || member.id, member.turnNo);
    const ids = new Set([
      member.id,
      member.questionId,
      member.answerId,
      member.turnId,
      record?.qId,
      record?.primaryAId,
      record?.turnId,
      ...(Array.isArray(member.aliasIds) ? member.aliasIds : []),
      ...(Array.isArray(record?.answerIds) ? record.answerIds : []),
      ...(Array.isArray(record?._aliasIds) ? record._aliasIds : []),
    ].map((value) => String(value || '').trim()).filter(Boolean));
    const out = new Set();
    const primary = titleListMemberSections(member);
    if (wantedRole === 'user' && primary.questionSection) out.add(primary.questionSection);
    if (wantedRole === 'assistant' && primary.answerSection) out.add(primary.answerSection);
    let sections = [];
    try {
      sections = Array.from(document.querySelectorAll(`section[data-testid^="conversation-turn"][data-turn="${wantedRole}"]`));
    } catch {}
    for (const section of sections) {
      const sectionId = String(section.getAttribute?.('data-turn-id') || '').trim();
      if (sectionId && ids.has(sectionId)) {
        out.add(section);
        continue;
      }
      const sectionRecord = turnRecordForTitleListIdentity(sectionId);
      if (sectionRecord && Number(sectionRecord.turnNo || 0) === Number(member.turnNo || 0)) out.add(section);
    }
    return Array.from(out).filter((section) => section?.isConnected);
  }

  function memberAllFlowAnchors(member = null) {
    if (!member) return [];
    const out = new Set(memberFlowAnchors(member));
    for (const section of memberSectionCandidates(member, 'user')) {
      const anchor = getTurnAnchorNode(section);
      if (anchor) out.add(anchor);
    }
    if (member.type === 'answer') {
      for (const section of memberSectionCandidates(member, 'assistant')) {
        const anchor = getTurnAnchorNode(section);
        if (anchor) out.add(anchor);
      }
    }
    return Array.from(out).filter((anchor) => anchor?.isConnected);
  }

  function clearTitleListFlowHiddenNode(anchor = null) {
    if (!anchor?.style) return false;
    const hadStamp = anchor.hasAttribute?.(ATTR_TITLE_LIST_FLOW_HIDDEN);
    const hadInlineHide = String(anchor.style.getPropertyValue?.('display') || '').toLowerCase() === 'none';
    try { anchor.removeAttribute(ATTR_TITLE_LIST_FLOW_HIDDEN); } catch {}
    try { anchor.style.removeProperty('display'); } catch {}
    return !!(hadStamp || hadInlineHide);
  }

  function buildTitleListFlowOwnershipSnapshot(modelInput = null) {
    const model = modelInput?.pages ? modelInput : buildTitleListPresentationPageModel();
    const identityToPage = new Map();
    const orderToPage = new Map();
    for (const page of Array.isArray(model?.pages) ? model.pages : []) {
      const pageNo = Math.max(1, Number(page?.pageNo || 0) || 0);
      for (const member of Array.isArray(page?.turnRecords) ? page.turnRecords : []) {
        const order = Math.max(0, Number(member?.turnNo || 0) || 0);
        if (order) orderToPage.set(order, pageNo);
        for (const value of [
          member?.id,
          member?.questionId,
          member?.answerId,
          member?.turnId,
          ...(Array.isArray(member?.aliasIds) ? member.aliasIds : []),
        ]) {
          const identity = String(value || '').trim();
          if (identity) identityToPage.set(identity, pageNo);
        }
      }
    }
    return { model, identityToPage, orderToPage };
  }

  function classifyTitleListFlowOwnership(node = null, snapshotInput = null) {
    if (!node) return { kind: 'neutral', pageNo: 0, pages: [], sections: 0, unknown: 0 };
    const snapshot = snapshotInput?.identityToPage
      ? snapshotInput
      : buildTitleListFlowOwnershipSnapshot();
    if (node.getAttribute?.('data-h2o-native-ts') === '1') {
      const order = Math.max(0, Number(titleListAdjacentTurnOrders(node)[0] || 0) || 0);
      const pageNo = Math.max(0, Number(snapshot.orderToPage.get(order) || 0) || 0);
      return pageNo
        ? { kind: 'owned', pageNo, pages: [pageNo], sections: 0, unknown: 0, timestamp: true }
        : { kind: 'foreign', pageNo: 0, pages: [], sections: 0, unknown: 1, timestamp: true };
    }
    const sections = [];
    try {
      if (node.matches?.(TURN_HOST_SEL)) sections.push(node);
      for (const section of Array.from(node.querySelectorAll?.(TURN_HOST_SEL) || [])) {
        if (!sections.includes(section)) sections.push(section);
      }
    } catch {}
    if (!sections.length) return { kind: 'neutral', pageNo: 0, pages: [], sections: 0, unknown: 0 };
    const pages = new Set();
    let unknown = 0;
    for (const section of sections) {
      const identity = String(section.getAttribute?.('data-turn-id') || '').trim();
      const pageNo = identity ? Math.max(0, Number(snapshot.identityToPage.get(identity) || 0) || 0) : 0;
      if (pageNo) pages.add(pageNo);
      else unknown += 1;
    }
    const pageList = Array.from(pages).sort((a, b) => a - b);
    if (pageList.length > 1 || (pageList.length && unknown)) {
      return { kind: 'mixed', pageNo: 0, pages: pageList, sections: sections.length, unknown };
    }
    if (pageList.length === 1) {
      return { kind: 'owned', pageNo: pageList[0], pages: pageList, sections: sections.length, unknown: 0 };
    }
    return { kind: 'foreign', pageNo: 0, pages: [], sections: sections.length, unknown };
  }

  function reconcileTitleListFlowHiddenArtifacts(modelInput = null, activePagesInput = null) {
    const snapshot = buildTitleListFlowOwnershipSnapshot(modelInput);
    const activePages = activePagesInput instanceof Set
      ? activePagesInput
      : new Set(Array.from(readTitleListPages(resolveChatId())));
    let scanned = 0;
    let kept = 0;
    let released = 0;
    let mixedReleased = 0;
    let foreignReleased = 0;
    let wrongOwnerReleased = 0;
    let nodes = [];
    try { nodes = Array.from(document.querySelectorAll(`[${ATTR_TITLE_LIST_FLOW_HIDDEN}]`)); } catch {}
    for (const node of nodes) {
      scanned += 1;
      const markerPage = Math.max(0, Number(node.getAttribute?.(ATTR_TITLE_LIST_FLOW_HIDDEN) || 0) || 0);
      const ownership = classifyTitleListFlowOwnership(node, snapshot);
      const valid = markerPage > 0
        && activePages.has(markerPage)
        && ownership.kind === 'owned'
        && ownership.pageNo === markerPage;
      if (valid) {
        kept += 1;
        continue;
      }
      if (ownership.kind === 'mixed') mixedReleased += 1;
      else if (ownership.kind === 'foreign' || ownership.kind === 'neutral') foreignReleased += 1;
      else if (ownership.pageNo !== markerPage) wrongOwnerReleased += 1;
      if (clearTitleListFlowHiddenNode(node)) released += 1;
    }
    return {
      scanned,
      kept,
      released,
      mixedReleased,
      foreignReleased,
      wrongOwnerReleased,
      activePages: Array.from(activePages).sort((a, b) => a - b),
      snapshot,
    };
  }

  function setTitleListFlowAnchorHidden(anchor = null, pageNum = 0, hidden = false, opts = {}) {
    if (!anchor?.style) return false;
    const num = Math.max(1, Number(pageNum || 0) || 0);
    let existingOwner = Math.max(0, Number(anchor.getAttribute?.(ATTR_TITLE_LIST_FLOW_HIDDEN) || 0) || 0);
    const clearOwnedStamp = () => {
      if (typeof clearTitleListFlowHiddenNode === 'function') return clearTitleListFlowHiddenNode(anchor);
      const hadStamp = anchor.hasAttribute?.(ATTR_TITLE_LIST_FLOW_HIDDEN);
      const hadInlineHide = String(anchor.style.getPropertyValue?.('display') || '').toLowerCase() === 'none';
      try { anchor.removeAttribute(ATTR_TITLE_LIST_FLOW_HIDDEN); } catch {}
      try { anchor.style.removeProperty('display'); } catch {}
      return !!(hadStamp || hadInlineHide);
    };
    if (hidden) {
      if (
        typeof buildTitleListFlowOwnershipSnapshot === 'function'
        && typeof classifyTitleListFlowOwnership === 'function'
      ) {
        const snapshot = opts?.ownershipSnapshot?.identityToPage
          ? opts.ownershipSnapshot
          : buildTitleListFlowOwnershipSnapshot();
        const ownership = classifyTitleListFlowOwnership(anchor, snapshot);
        const stampAllowed = ownership.kind === 'owned'
          ? ownership.pageNo === num
          : ownership.kind === 'neutral' && opts?.allowNeutral === true;
        if (!stampAllowed) {
          let existingOwnerStillValid = false;
          if (existingOwner && ownership.kind === 'owned' && ownership.pageNo === existingOwner) {
            try {
              existingOwnerStillValid = typeof readTitleListPages !== 'function'
                || readTitleListPages(resolveChatId()).has(existingOwner);
            } catch {}
          }
          if (existingOwner && !existingOwnerStillValid) clearOwnedStamp();
          return false;
        }
      }
      if (existingOwner && existingOwner !== num) {
        clearOwnedStamp();
        existingOwner = 0;
      }
      const alreadyStamped = String(anchor.getAttribute?.(ATTR_TITLE_LIST_FLOW_HIDDEN) || '') === String(num);
      const currentDisplay = String(getComputedStyle(anchor)?.display || '').toLowerCase();
      const alreadyHidden = currentDisplay === 'none';
      try { anchor.setAttribute(ATTR_TITLE_LIST_FLOW_HIDDEN, String(num)); } catch {}
      try { anchor.style.setProperty('display', 'none', 'important'); } catch {}
      return !alreadyStamped || !alreadyHidden;
    }
    if (existingOwner && existingOwner !== num) return false;
    return clearOwnedStamp();
  }

  function syncTitleOnlyModeRootAttribute(chatId = '') {
    const id = String(chatId || resolveChatId()).trim();
    const pages = Array.from(readTitleListPages(id))
      .map((value) => Math.max(1, Number(value || 0) || 0))
      .filter(Boolean)
      .sort((a, b) => a - b);
    try {
      if (pages.length) document.documentElement?.setAttribute?.(ATTR_TITLE_ONLY_ACTIVE_PAGES, pages.join(','));
      else document.documentElement?.removeAttribute?.(ATTR_TITLE_ONLY_ACTIVE_PAGES);
    } catch {}
    return pages;
  }

  function titleListDirectFlowChild(root = null, node = null) {
    if (!root || !node || !root.contains?.(node)) return null;
    let current = node;
    while (current?.parentElement && current.parentElement !== root) current = current.parentElement;
    return current?.parentElement === root ? current : null;
  }

  function titleListFlowArtifactAllowed(node = null, container = null) {
    if (!node) return false;
    if (node === container || node.contains?.(container)) return true;
    try {
      if (node.matches?.(
        '.cgxui-chat-page-divider, .cgxui-pgnw-page-divider,'
        + ` ${TITLE_LIST_SYNTH_SEL}, ${TITLE_LIST_SUFFIX_SEL}, [data-h2o-native-ts="1"]`
      )) return true;
    } catch {}
    return false;
  }

  function titleListTurnOrderForSection(section = null) {
    if (!section) return 0;
    const identity = String(section.getAttribute?.('data-turn-id') || '').trim();
    const record = turnRecordForTitleListIdentity(identity);
    const exact = Math.max(0, Number(record?.order || record?.turnNo || record?.idx || 0) || 0);
    if (exact) return exact;
    const role = getTurnHostRole(section);
    const sections = listTurnSections();
    const users = sections.filter((candidate) => getTurnHostRole(candidate) === 'user');
    if (role === 'user') return Math.max(0, users.indexOf(section) + 1);
    if (role === 'assistant') {
      const previous = getPreviousTurnHost(section);
      return Math.max(0, users.indexOf(previous) + 1);
    }
    return 0;
  }

  function titleListExactTurnOrderForSection(section = null) {
    if (!section) return 0;
    const identity = String(section.getAttribute?.('data-turn-id') || '').trim();
    if (!identity) return 0;
    const record = turnRecordForTitleListIdentity(identity);
    return Math.max(0, Number(record?.order || record?.turnNo || record?.idx || 0) || 0);
  }

  function titleListAdjacentTurnOrders(node = null) {
    if (!node) return [];
    const before = [];
    const after = [];
    for (const section of listTurnSections()) {
      let relation = 0;
      try { relation = node.compareDocumentPosition(section); } catch {}
      if (relation & 4) after.push(section);
      else if (relation & 2) before.push(section);
    }
    // Native separators introduce the following host turn. Ownership is
    // therefore the first following USER turn when one exists, not both
    // adjacent pages. At a Page 1/Page 2 boundary this keeps Page 2's
    // separator visible when only Page 1 is title-listed. The previous USER
    // turn is a tail fallback for a separator mounted after the final turn.
    const next = after.find((section) => getTurnHostRole(section) === 'user') || after[0] || null;
    const previous = before.slice().reverse().find((section) => getTurnHostRole(section) === 'user')
      || before[before.length - 1]
      || null;
    const order = titleListExactTurnOrderForSection(next || previous);
    return order ? [order] : [];
  }

  function titleListMemberMateriallyPresent(member = null) {
    if (!member) return false;
    const sections = titleListMemberSections(member);
    const required = [sections.questionSection];
    if (member.type === 'answer') required.push(sections.answerSection);
    if (required.some((section) => !section?.isConnected)) return false;
    for (const section of required) {
      try {
        if (String(section.style?.getPropertyValue?.('display') || '').toLowerCase() === 'none') return false;
        if (section.closest?.(`[${ATTR_TITLE_LIST_FLOW_HIDDEN}]`)) return false;
        if (section.querySelector?.(
          '[data-h2o-unmounted="1"], [data-h2o-um-turn-hidden="1"], .cgxui-unmounted-placeholder'
        )) return false;
      } catch { return false; }
    }
    return true;
  }

  function setOrphanTitleListTimestampHidden(timestamp = null, hidden = false) {
    if (!timestamp?.style) return false;
    const had = timestamp.hasAttribute?.(ATTR_TITLE_LIST_ORPHAN_TIMESTAMP_HIDDEN);
    if (hidden) {
      try { timestamp.setAttribute(ATTR_TITLE_LIST_ORPHAN_TIMESTAMP_HIDDEN, '1'); } catch {}
      try { timestamp.style.setProperty('display', 'none', 'important'); } catch {}
      return !had;
    }
    try { timestamp.removeAttribute(ATTR_TITLE_LIST_ORPHAN_TIMESTAMP_HIDDEN); } catch {}
    if (!timestamp.hasAttribute?.(ATTR_TITLE_LIST_FLOW_HIDDEN)) {
      try { timestamp.style.removeProperty('display'); } catch {}
    }
    return !!had;
  }

  function syncTitleListNativeTimestampVisibility(model = null, activePagesInput = null) {
    const pageModel = model?.pages ? model : buildTitleListPresentationPageModel();
    const activePages = activePagesInput instanceof Set
      ? activePagesInput
      : new Set(Array.from(readTitleListPages(resolveChatId())));
    const memberByOrder = new Map();
    for (const page of Array.isArray(pageModel?.pages) ? pageModel.pages : []) {
      for (const member of Array.isArray(page?.turnRecords) ? page.turnRecords : []) {
        const order = Math.max(0, Number(member?.turnNo || 0) || 0);
        if (order) memberByOrder.set(order, member);
      }
    }

    // Reuse the existing semantic native-timestamp recognizer. Its scan only
    // applies the stable `data-h2o-native-ts` marker; the user's timestamp
    // preference and content remain untouched.
    try { (TOPW.H2O?.NativeTimestamps || W.H2O?.NativeTimestamps)?.scan?.(); } catch {}
    let hidden = 0;
    let shown = 0;
    let orphanHidden = 0;
    let timestamps = [];
    try { timestamps = Array.from(document.querySelectorAll('[data-h2o-native-ts="1"]')); } catch {}
    for (const timestamp of timestamps) {
      if (!activePages.size) {
        const existingOwner = Math.max(0, Number(timestamp.getAttribute?.(ATTR_TITLE_LIST_FLOW_HIDDEN) || 0) || 0);
        if (existingOwner && setTitleListFlowAnchorHidden(timestamp, existingOwner, false)) shown += 1;
        setOrphanTitleListTimestampHidden(timestamp, false);
        continue;
      }
      const order = Math.max(0, Number(titleListAdjacentTurnOrders(timestamp)[0] || 0) || 0);
      if (!order) {
        if (setOrphanTitleListTimestampHidden(timestamp, true)) orphanHidden += 1;
        continue;
      }
      const pageNum = Math.max(1, Math.ceil(order / TITLE_LIST_PAGE_SIZE));
      const pageExists = pageNum <= Number(pageModel?.pageCount || 0);
      const member = memberByOrder.get(order) || null;
      const normalMaterialized = pageExists
        && !activePages.has(pageNum)
        && titleListMemberMateriallyPresent(member);
      const shouldHide = !normalMaterialized;
      setOrphanTitleListTimestampHidden(timestamp, false);
      if (shouldHide) {
        if (setTitleListFlowAnchorHidden(timestamp, pageNum, true)) hidden += 1;
      } else if (setTitleListFlowAnchorHidden(timestamp, pageNum, false)) {
        shown += 1;
      }
    }
    return { hidden, shown, orphanHidden, scanned: timestamps.length };
  }

  function stampTitleListNativeTimestampArtifacts(members = [], pageNum = 0) {
    const num = Math.max(1, Number(pageNum || 0) || 0);
    const orders = new Set(members.map((member) => Number(member?.turnNo || 0)).filter(Boolean));
    if (!orders.size) return 0;
    try { (TOPW.H2O?.NativeTimestamps || W.H2O?.NativeTimestamps)?.scan?.(); } catch {}
    let hidden = 0;
    let timestamps = [];
    try { timestamps = Array.from(document.querySelectorAll('[data-h2o-native-ts="1"]')); } catch {}
    for (const timestamp of timestamps) {
      if (!titleListAdjacentTurnOrders(timestamp).some((order) => orders.has(order))) continue;
      if (setTitleListFlowAnchorHidden(timestamp, num, true)) hidden += 1;
    }
    return hidden;
  }

  // One synchronous title-only projection owns every visibility write for a
  // listed page. It hides complete turn wrappers plus unknown host-owned
  // siblings in the page range, while explicitly allowing only the H2O title
  // H2O title projections and page-divider controls.
  function applyAtomicTitleOnlyPageProjection(pageNum = 0, chatId = '', members = [], container = null) {
    const num = Math.max(1, Number(pageNum || 0) || 0);
    const id = String(chatId || resolveChatId()).trim();
    const pageModel = typeof buildTitleListPresentationPageModel === 'function'
      ? buildTitleListPresentationPageModel()
      : null;
    const cleanup = (
      typeof reconcileTitleListFlowHiddenArtifacts === 'function'
      && typeof readTitleListPages === 'function'
    )
      ? reconcileTitleListFlowHiddenArtifacts(
        pageModel,
        new Set(Array.from(readTitleListPages(id)))
      )
      : {
        scanned: 0,
        kept: 0,
        released: 0,
        mixedReleased: 0,
        foreignReleased: 0,
        wrongOwnerReleased: 0,
        snapshot: null,
      };
    const ownershipSnapshot = cleanup.snapshot;
    let divider = null;
    try {
      divider = document.querySelector(
        `.cgxui-chat-page-divider[data-page-num="${String(num)}"],`
        + ` .cgxui-pgnw-page-divider[data-page-num="${String(num)}"]`
      );
    } catch {}
    const flowRoot = divider?.parentElement || container?.parentElement || null;
    const identityToOrder = new Map();
    for (const member of members) {
      const order = Math.max(0, Number(member?.turnNo || 0) || 0);
      if (!order) continue;
      for (const value of [
        member?.id,
        member?.questionId,
        member?.answerId,
        member?.turnId,
        ...(Array.isArray(member?.aliasIds) ? member.aliasIds : []),
      ]) {
        const identity = String(value || '').trim();
        if (identity) identityToOrder.set(identity, order);
      }
    }

    const protectedAnchors = new Set();
    for (const member of members) {
      const row = findStackRowForMember(container, member);
      const explicitlyOpened = row?.getAttribute?.('data-h2o-title-row-opened') === '1'
        && row?.getAttribute?.('data-h2o-title-row-opened-by') === 'dblclick';
      if (!explicitlyOpened) continue;
      for (const anchor of memberAllFlowAnchors(member)) protectedAnchors.add(anchor);
    }

    // Resolve ownership from exact current qId/aId/turn identities. A shared
    // conversation wrapper that contains Page 1 and Page 2 is "mixed" and
    // can never receive a Page 1 hide stamp. We recurse until reaching maximal
    // page-owned subtrees; neutral siblings are hidden only when bracketed by
    // page-owned turn artifacts inside that same parent.
    const classifyArtifact = (node) => {
      if (!node) return { kind: 'neutral', owned: 0, foreign: 0 };
      const sections = [];
      try {
        if (node.matches?.(TURN_HOST_SEL)) sections.push(node);
        for (const section of Array.from(node.querySelectorAll?.(TURN_HOST_SEL) || [])) {
          if (!sections.includes(section)) sections.push(section);
        }
      } catch {}
      if (!sections.length) return { kind: 'neutral', owned: 0, foreign: 0 };
      let owned = 0;
      let foreign = 0;
      for (const section of sections) {
        const identity = String(section.getAttribute?.('data-turn-id') || '').trim();
        if (identity && identityToOrder.has(identity)) owned += 1;
        else foreign += 1;
      }
      return {
        kind: owned && foreign ? 'mixed' : owned ? 'owned' : 'foreign',
        owned,
        foreign,
      };
    };
    const intersectsProtectedAnchor = (node) => {
      for (const anchor of protectedAnchors) {
        try {
          if (node === anchor || node.contains?.(anchor) || anchor.contains?.(node)) return true;
        } catch {}
      }
      return false;
    };
    let hidden = 0;
    const projectOwnedChildren = (parent) => {
      const children = Array.from(parent?.children || []);
      if (!children.length) return;
      const classes = children.map((node) => classifyArtifact(node));
      const pageBearingIndexes = classes
        .map((entry, index) => ((entry.kind === 'owned' || entry.kind === 'mixed') && entry.owned > 0 ? index : -1))
        .filter((index) => index >= 0);
      const first = pageBearingIndexes.length ? Math.min(...pageBearingIndexes) : -1;
      const last = pageBearingIndexes.length ? Math.max(...pageBearingIndexes) : -1;
      let previousBoundary = -1;
      let nextBoundary = children.length;
      if (first >= 0) {
        for (let index = 0; index < first; index += 1) {
          const dividerPage = Math.max(0, Number(children[index]?.getAttribute?.('data-page-num') || 0) || 0);
          if (classes[index]?.kind === 'foreign' || dividerPage === num) previousBoundary = index;
        }
      }
      if (last >= 0) {
        for (let index = last + 1; index < children.length; index += 1) {
          const dividerPage = Math.max(0, Number(children[index]?.getAttribute?.('data-page-num') || 0) || 0);
          if (classes[index]?.kind === 'foreign' || dividerPage > num) {
            nextBoundary = index;
            break;
          }
        }
      }
      for (let index = 0; index < children.length; index += 1) {
        const node = children[index] || null;
        const ownership = classes[index];
        if (!node || titleListFlowArtifactAllowed(node, container)) continue;
        if (ownership.kind === 'mixed') {
          projectOwnedChildren(node);
          continue;
        }
        if (ownership.kind === 'owned') {
          if (intersectsProtectedAnchor(node)) {
            projectOwnedChildren(node);
            continue;
          }
          if (setTitleListFlowAnchorHidden(node, num, true, { ownershipSnapshot })) hidden += 1;
          continue;
        }
        // Unknown host-owned siblings (quote cards, footer/action rows, etc.)
        // are page-owned only when they are enclosed by exact page-owned turn
        // artifacts in this same DOM parent. Never sweep past a foreign turn.
        if (
          ownership.kind === 'neutral'
          && first >= 0
          && index > previousBoundary
          && index < nextBoundary
          && !intersectsProtectedAnchor(node)
        ) {
          if (setTitleListFlowAnchorHidden(node, num, true, {
            ownershipSnapshot,
            allowNeutral: true,
          })) hidden += 1;
        }
      }
    };
    if (flowRoot) projectOwnedChildren(flowRoot);
    else {
      // Missing divider/root is a hydration edge. Hide only exact member
      // anchors; do not infer a wider page range from visual position.
      for (const member of members) {
        for (const anchor of memberAllFlowAnchors(member)) {
          if (classifyArtifact(anchor).kind !== 'owned' || intersectsProtectedAnchor(anchor)) continue;
          if (setTitleListFlowAnchorHidden(anchor, num, true, { ownershipSnapshot })) hidden += 1;
        }
      }
    }
    const nativeTimestampsHidden = stampTitleListNativeTimestampArtifacts(members, num);
    const activePages = syncTitleOnlyModeRootAttribute(id);
    return {
      ok: true,
      status: 'title-only',
      pageNum: num,
      source: readTitleListPresentationAuthority().source,
      hidden,
      nativeTimestampsHidden,
      cleanup: {
        scanned: cleanup.scanned,
        kept: cleanup.kept,
        released: cleanup.released,
        mixedReleased: cleanup.mixedReleased,
        foreignReleased: cleanup.foreignReleased,
        wrongOwnerReleased: cleanup.wrongOwnerReleased,
      },
      activePages,
    };
  }

  function titleListRectSnapshot(el = null) {
    try {
      const rect = el?.getBoundingClientRect?.();
      if (!rect) return null;
      return {
        left: Number(rect.left.toFixed(2)),
        right: Number(rect.right.toFixed(2)),
        top: Number(rect.top.toFixed(2)),
        bottom: Number(rect.bottom.toFixed(2)),
        width: Number(rect.width.toFixed(2)),
        height: Number(rect.height.toFixed(2)),
      };
    } catch { return null; }
  }

  function titleListOpenStateKey(pageNum = 0, chatId = '') {
    return titleListStackRegistryKey(pageNum, chatId);
  }

  function getTitleListSuffixContainers(pageNum = 0, chatId = '') {
    const num = Math.max(1, Number(pageNum || 0) || 1);
    const key = titleListOpenStateKey(num, chatId);
    try {
      return Array.from(document.querySelectorAll(`${TITLE_LIST_SUFFIX_SEL}[data-page-num="${String(num)}"]`))
        .filter((node) => String(node.getAttribute?.('data-h2o-title-list-key') || '') === key);
    } catch { return []; }
  }

  function ensureTitleListSuffixContainer(transaction = null) {
    // The current root is a precondition, resolved now rather than remembered:
    // a suffix has nowhere to belong if the page's flow is not live.
    if (!transaction?.titleListContainer) return null;
    if (collapsedPageFlowRootByIdentity(transaction.pageNum)?.isConnected !== true) return null;
    let suffix = getTitleListSuffixContainers(transaction.pageNum, transaction.chatId)[0] || null;
    if (!suffix) {
      try {
        suffix = document.createElement('div');
        suffix.className = 'cgxui-chat-page-title-list-suffix';
        suffix.setAttribute(ATTR_TITLE_LIST_SEGMENT, 'suffix');
        suffix.setAttribute('data-cgxui-owner', 'chtpgs');
        suffix.setAttribute('data-page-num', String(transaction.pageNum));
        suffix.setAttribute('data-h2o-title-list-key', titleListOpenStateKey(transaction.pageNum, transaction.chatId));
        suffix.addEventListener('dblclick', onSyntheticTitleRowDblClick, true);
        suffix._h2oTitleListDblClickHandler = onSyntheticTitleRowDblClick;
      } catch { return null; }
    }
    return suffix;
  }

  function restoreTitleListProjectionRows(transaction = null) {
    const primary = transaction?.titleListContainer || null;
    if (!primary) return 0;
    let mutations = 0;
    for (const row of Array.isArray(transaction?.titleRowsPrepared) ? transaction.titleRowsPrepared : []) {
      if (!row || row.parentElement === primary) continue;
      try { primary.appendChild(row); mutations += 1; } catch {}
    }
    for (const suffix of getTitleListSuffixContainers(transaction.pageNum, transaction.chatId)) {
      if (!suffix?.children?.length) {
        try { suffix.remove(); mutations += 1; } catch {}
      }
    }
    try { primary.removeAttribute(ATTR_TITLE_LIST_SEGMENT); } catch {}
    return mutations;
  }

  function titleListCanonicalMemberForOpenState(transaction = null, state = null) {
    if (!transaction || !state) return null;
    return (Array.isArray(transaction.titleRows) ? transaction.titleRows : []).find((member) => (
      String(member?.id || '') === String(state.canonicalId || '')
      && String(member?.questionId || '') === String(state.questionId || '')
      && String(member?.answerId || '') === String(state.answerId || '')
      && Number(member?.turnNo || 0) === Number(state.turnNo || 0)
    )) || null;
  }

  function titleListOpenStateCurrent(transaction = null, state = null) {
    if (!transaction || !state) return false;
    return String(state.chatId || '') === String(transaction.chatId || '')
      && Number(state.pageNum || 0) === Number(transaction.pageNum || 0)
      && String(state.routeKey || '') === String(transaction.routeKey || '')
      && Number(state.generation || 0) === Number(transaction.generation || 0)
      && String(state.effectiveFingerprint || '') === String(transaction.effectiveFingerprint || '')
      && !!titleListCanonicalMemberForOpenState(transaction, state);
  }

  /* Stage 2 Pass 5A — the page's CURRENT native projection surface.

     Derived at point of use and never persisted. The canonical model decides
     WHO belongs to this page; current identity resolution decides WHICH mounted
     node stands for each of them right now; the DOM is consulted only
     afterwards, and only for presentation mechanics. A member that is not
     mounted is ordinary absence, a replaced member resolves to its current
     node, and an identity that has become ambiguous is left out rather than
     guessed at. */
  function titleListCurrentProjectionNodes(transaction = null) {
    const out = { ok: false, reason: 'projection-surface-unavailable', root: null, nodes: [] };
    if (transaction?.atomicRenderedBoundaryPlan !== true) return out;
    const root = collapsedPageFlowRootByIdentity(transaction.pageNum);
    if (root?.isConnected !== true) return { ...out, reason: 'flow-root-unavailable' };
    const nodes = [];
    const admit = (node) => {
      if (!node || node.isConnected !== true || node.parentElement !== root) return;
      if (pageCollapseRangeH2OOwned(node) || nodes.includes(node)) return;
      nodes.push(node);
    };
    for (const member of Array.isArray(transaction.titleRows) ? transaction.titleRows : []) {
      for (const identity of [member?.questionId, member?.answerId]) {
        const id = String(identity || '').trim();
        if (!id) continue;
        let surface = null;
        try { surface = resolveRenderedTurnSurfaceByIdentity(id, root); } catch { surface = null; }
        if (surface?.ok === true) admit(surface.directFlowWrapper);
      }
      // Question and answer surfaces are resolved separately: a logical turn is
      // not a fixed number of native sections, so neither may be derived from
      // the other or from ordinal arithmetic.
      for (const role of ['user', 'assistant']) {
        if (role === 'assistant' && member?.type !== 'answer') continue;
        let sections = [];
        try { sections = memberSectionCandidates(member, role); } catch { sections = []; }
        if (sections.length !== 1) continue;
        let direct = null;
        try { direct = titleListDirectFlowChild(root, getTurnAnchorNode(sections[0])); } catch { direct = null; }
        admit(direct);
      }
    }
    // Presentation order only. DOM position never establishes membership.
    const children = Array.from(root.children || []);
    nodes.sort((a, b) => children.indexOf(a) - children.indexOf(b));
    return { ok: true, reason: null, root, nodes };
  }

  /* Diagnostic count of the CURRENT canonical members carrying this page's
     projection. Recomputed at point of use; nothing is retained. */
  function titleListCurrentProjectedCount(transaction = null) {
    const surface = titleListCurrentProjectionNodes(transaction);
    if (!surface.ok) return 0;
    const marker = String(transaction.pageNum);
    return surface.nodes.filter(
      (node) => node.getAttribute?.(ATTR_CHAT_PAGE_NATIVE_HIDDEN) === marker,
    ).length;
  }

  function titleListCurrentNativeMount(transaction = null, member = null) {
    const fail = (reason = 'canonical-mount-unavailable', anchors = []) => ({ ok: false, reason, anchors, member });
    if (!transaction || !member?.id) return fail('canonical-member-unavailable');
    // The current root is resolved at point of use, never carried.
    const root = collapsedPageFlowRootByIdentity(transaction.pageNum);
    if (root?.isConnected !== true) return fail('canonical-member-unavailable');
    // Canonical page membership comes from the transaction's own scalar page
    // scope — this is what the retired hostWrappers list stood in for.
    const order = Math.max(0, Number(member?.turnNo || 0) || 0);
    if (order && (order < transaction.pageStartOrder || order > transaction.pageEndOrder)) {
      return fail('canonical-mount-not-in-current-page');
    }
    const questionSections = memberSectionCandidates(member, 'user');
    const answerSections = member.type === 'answer' ? memberSectionCandidates(member, 'assistant') : [];
    if (questionSections.length > 1 || (member.type === 'answer' && answerSections.length > 1)) {
      return fail('canonical-mount-ambiguous');
    }
    const requiredSections = [
      questionSections[0] || null,
      ...(member.type === 'answer' ? [answerSections[0] || null] : []),
    ];
    const anchors = [];
    for (const section of requiredSections.filter(Boolean)) {
      const anchor = getTurnAnchorNode(section);
      const direct = titleListDirectFlowChild(root, anchor);
      if (
        !direct
        || direct?.isConnected !== true
        || direct.parentElement !== root
        || pageCollapseRangeH2OOwned(direct)
      ) return fail('canonical-mount-not-in-current-page', anchors);
      if (!anchors.includes(direct)) anchors.push(direct);
    }
    const complete = requiredSections.every((section) => section && anchors.some((anchor) => (
      anchor === section || anchor.contains?.(section)
    )));
    return complete
      ? { ok: true, reason: null, anchors, member }
      : fail('canonical-mount-incomplete', anchors);
  }

  function titleListCurrentOpenMount(transaction = null) {
    const state = S.titleListOpenStatesByKey.get(
      titleListOpenStateKey(transaction?.pageNum, transaction?.chatId)
    ) || null;
    if (!titleListOpenStateCurrent(transaction, state)) {
      return { ok: false, reason: state ? 'open-state-stale' : 'open-state-inactive', anchors: [], state, member: null };
    }
    const member = titleListCanonicalMemberForOpenState(transaction, state);
    return { ...titleListCurrentNativeMount(transaction, member), state, member };
  }

  function requestTitleListCanonicalMaterialization(state = null, member = null) {
    if (!state || !member || state.materializationRequested === true) return false;
    const canonicalId = String(member.answerId || member.questionId || member.id || '').trim();
    if (!canonicalId) return false;
    const record = turnRecordForTitleListIdentity(canonicalId, member.turnNo);
    state.materializationRequested = true;
    state.materializationTargetQId = String(record?.qId || member.questionId || '').trim();
    state.status = 'pending';
    let accepted = false;
    try {
      accepted = MM_SH()?.api?.rt?.setActiveTurnId?.(
        canonicalId,
        'title-list:native-in-place-materialization'
      ) === true;
    } catch { accepted = false; }
    const navigation = (() => {
      try { return MM_SH()?.api?.rt?.getCompleteIndexNavigationStatus?.() || null; } catch { return null; }
    })();
    state.materializationGeneration = Math.max(0, Number(navigation?.generation || 0) || 0);
    state.materializationStatus = String(navigation?.status || (accepted ? 'requested' : 'unavailable'));
    if (!accepted) state.materializationRequestFailed = true;
    return accepted;
  }

  function titleListCanonicalMaterializationTerminal(state = null) {
    if (!state?.materializationRequested) return null;
    let navigation = null;
    try { navigation = MM_SH()?.api?.rt?.getCompleteIndexNavigationStatus?.() || null; } catch {}
    if (!navigation) return state.materializationRequestFailed === true
      ? { status: 'unavailable', errorCode: 'request-rejected' }
      : null;
    const expectedQId = String(state.materializationTargetQId || state.questionId || '').trim();
    const targetQId = String(navigation.targetQId || '').trim();
    if (expectedQId && targetQId && expectedQId !== targetQId) return null;
    const expectedGeneration = Math.max(0, Number(state.materializationGeneration || 0) || 0);
    const generation = Math.max(0, Number(navigation.generation || 0) || 0);
    // Coordinator cancellation advances the same operation's generation.
    // Reject only an older status; a newer status is still ours when its
    // canonical target remains exact (checked above).
    if (expectedGeneration && generation && generation < expectedGeneration) return null;
    const status = String(navigation.status || '').trim();
    if (!['unavailable', 'unreachable', 'cancelled', 'stale-route-discarded'].includes(status)) return null;
    state.materializationStatus = status;
    return {
      status,
      errorCode: String(navigation.errorCode || status || 'materialization-failed'),
      generation,
      targetQId,
    };
  }

  /* Stage 2 Pass 5B — the SUCCESS half of the bounded materialization request.

     'navigated' is the coordinator's only success token, and it is a statement
     about NAVIGATION, not about presentation. It is correlated back to our own
     outstanding request through exactly the fields the failure reader already
     uses — no second token scheme, no extra persisted request object — and the
     caller must still re-resolve the CURRENT exact target before anything
     completes. A result that does not correlate is simply not ours.

     Generation follows the established rule: an OLDER status is not ours,
     while a newer one still can be, because coordinator cancellation advances
     the same operation's generation and the exact canonical target is what
     actually identifies it. */
  function titleListCanonicalMaterializationSettled(state = null) {
    if (!state?.materializationRequested) return null;
    let navigation = null;
    try { navigation = MM_SH()?.api?.rt?.getCompleteIndexNavigationStatus?.() || null; } catch {}
    if (!navigation) return null;
    if (String(navigation.status || '').trim() !== 'navigated') return null;
    const expectedQId = String(state.materializationTargetQId || state.questionId || '').trim();
    const targetQId = String(navigation.targetQId || '').trim();
    if (expectedQId && targetQId && expectedQId !== targetQId) return null;
    const expectedGeneration = Math.max(0, Number(state.materializationGeneration || 0) || 0);
    const generation = Math.max(0, Number(navigation.generation || 0) || 0);
    if (expectedGeneration && generation && generation < expectedGeneration) return null;
    return { status: 'navigated', generation, targetQId };
  }

  function clearTitleListNativeInPlaceProjection(transaction = null, options = {}) {
    if (!transaction) return { ok: true, status: 'inactive', mutations: 0 };
    const key = titleListOpenStateKey(transaction.pageNum, transaction.chatId);
    let mutations = restoreTitleListProjectionRows(transaction);
    for (const row of Array.isArray(transaction.titleRowsPrepared) ? transaction.titleRowsPrepared : []) {
      const hadState = row?.hasAttribute?.('data-h2o-title-row-opened')
        || row?.hasAttribute?.('data-h2o-title-row-pending');
      try {
        row.removeAttribute('data-h2o-title-row-opened');
        row.removeAttribute('data-h2o-title-row-opened-by');
        row.removeAttribute('data-h2o-title-row-pending');
      } catch {}
      if (hadState) mutations += 1;
    }
    if (options?.rehide !== false) {
      // Current canonical members only, resolved now. A stale predecessor is
      // never written and a DOM-only noncanonical node is never touched.
      for (const node of titleListCurrentProjectionNodes(transaction).nodes) {
        if (node.getAttribute?.(ATTR_CHAT_PAGE_NATIVE_HIDDEN) === String(transaction.pageNum)) continue;
        try { node.setAttribute(ATTR_CHAT_PAGE_NATIVE_HIDDEN, String(transaction.pageNum)); mutations += 1; } catch {}
      }
    }
    S.titleListOpenStatesByKey.delete(key);
    return { ok: true, status: 'closed', mutations };
  }

  function reconcileTitleListNativeInPlaceProjection(transaction = null, options = {}) {
    if (!transaction) return { ok: false, status: 'transaction-missing', mutations: 0 };
    const key = titleListOpenStateKey(transaction.pageNum, transaction.chatId);
    const state = S.titleListOpenStatesByKey.get(key) || null;
    if (!state) {
      const cleared = clearTitleListNativeInPlaceProjection(transaction, { rehide: true });
      return { ...cleared, status: 'inactive' };
    }
    if (!titleListOpenStateCurrent(transaction, state)) {
      const cleared = clearTitleListNativeInPlaceProjection(transaction, { rehide: true });
      return { ...cleared, status: 'open-state-stale-cleared' };
    }
    const member = titleListCanonicalMemberForOpenState(transaction, state);
    const rows = Array.isArray(transaction.titleRowsPrepared) ? transaction.titleRowsPrepared : [];
    const selectedIndex = (Array.isArray(transaction.titleRows) ? transaction.titleRows : []).indexOf(member);
    const selectedRow = rows[selectedIndex] || null;
    if (!selectedRow || selectedIndex < 0) {
      const cleared = clearTitleListNativeInPlaceProjection(transaction, { rehide: true });
      return { ...cleared, status: 'open-row-unavailable-cleared' };
    }
    let mutations = 0;
    for (const row of rows) {
      const selected = row === selectedRow;
      const opened = row.getAttribute?.('data-h2o-title-row-opened') === '1';
      if (selected !== opened) {
        try {
          if (selected) {
            row.setAttribute('data-h2o-title-row-opened', '1');
            row.setAttribute('data-h2o-title-row-opened-by', 'dblclick');
          } else {
            row.removeAttribute('data-h2o-title-row-opened');
            row.removeAttribute('data-h2o-title-row-opened-by');
            row.removeAttribute('data-h2o-title-row-pending');
          }
          mutations += 1;
        } catch {}
      }
    }
    /* The success is correlated here, AFTER the open state has been re-read
       from S.titleListOpenStatesByKey and proven current for this transaction
       (chat, page, route, generation, effective fingerprint and canonical
       member) by the checks above. A success belonging to an intent the user
       has since closed or replaced never reaches this point. */
    const settled = titleListCanonicalMaterializationSettled(state);
    if (settled) state.materializationStatus = settled.status;
    const materialization = settled ? settled.status : null;
    const initialMount = options?.currentMount?.member === member ? options.currentMount : null;
    const resolvedMount = titleListCurrentNativeMount(transaction, member);
    const initialStillCurrent = initialMount?.ok === true
      && resolvedMount.ok === true
      && initialMount.anchors.length === resolvedMount.anchors.length
      && initialMount.anchors.every((anchor) => resolvedMount.anchors.includes(anchor));
    const mount = initialStillCurrent ? initialMount : resolvedMount;
    if (!mount.ok) {
      const terminal = titleListCanonicalMaterializationTerminal(state);
      if (terminal) {
        const cleared = clearTitleListNativeInPlaceProjection(transaction, { rehide: true });
        if (member.type === 'answer' && member.answerId) {
          recordManualTitleOverride(member.answerId, 'collapsed', {
            chatId: transaction.chatId,
            page: transaction.pageNum,
            source: 'answer-title',
          });
          setTitleListMemberCollapsed(member, true);
        }
        return {
          ...cleared,
          status: `materialization-${terminal.status}-cleared`,
          reason: terminal.errorCode,
          mutations: mutations + cleared.mutations,
        };
      }
      state.pending = true;
      state.status = 'pending';
      mutations += restoreTitleListProjectionRows(transaction);
      const pendingEligible = new Set(mount.anchors || []);
      for (const node of titleListCurrentProjectionNodes(transaction).nodes) {
        if (pendingEligible.has(node)) {
          if (node.hasAttribute?.(ATTR_CHAT_PAGE_NATIVE_HIDDEN)) {
            try { node.removeAttribute(ATTR_CHAT_PAGE_NATIVE_HIDDEN); mutations += 1; } catch {}
          }
          if (clearTitleListFlowHiddenNode(node)) mutations += 1;
          continue;
        }
        if (node.getAttribute?.(ATTR_CHAT_PAGE_NATIVE_HIDDEN) === String(transaction.pageNum)) continue;
        try { node.setAttribute(ATTR_CHAT_PAGE_NATIVE_HIDDEN, String(transaction.pageNum)); mutations += 1; } catch {}
      }
      if (selectedRow.getAttribute?.('data-h2o-title-row-pending') !== '1') {
        try { selectedRow.setAttribute('data-h2o-title-row-pending', '1'); mutations += 1; } catch {}
      }
      const requested = requestTitleListCanonicalMaterialization(state, member);
      if (!requested && state.materializationRequestFailed === true) {
        const cleared = clearTitleListNativeInPlaceProjection(transaction, { rehide: true });
        if (member.type === 'answer' && member.answerId) {
          recordManualTitleOverride(member.answerId, 'collapsed', {
            chatId: transaction.chatId,
            page: transaction.pageNum,
            source: 'answer-title',
          });
          setTitleListMemberCollapsed(member, true);
        }
        return {
          ...cleared,
          status: 'materialization-unavailable-cleared',
          reason: 'request-rejected',
          mutations: mutations + cleared.mutations,
        };
      }
      /* Navigation succeeded and presentation did not. Those are different
         claims: the exact target still does not resolve, so the interaction
         stays pending rather than reporting a completion it cannot show. No
         further request is issued — the existing one is still the only one. */
      return {
        ok: true,
        status: 'pending',
        mutations,
        anchors: 0,
        materializationRequested: state.materializationRequested === true,
        materialization,
      };
    }
    const visible = new Set(mount.anchors);
    const surface = titleListCurrentProjectionNodes(transaction);
    for (const node of surface.nodes) {
      if (visible.has(node)) {
        if (node.hasAttribute?.(ATTR_CHAT_PAGE_NATIVE_HIDDEN)) {
          try { node.removeAttribute(ATTR_CHAT_PAGE_NATIVE_HIDDEN); mutations += 1; } catch {}
        }
        if (clearTitleListFlowHiddenNode(node)) mutations += 1;
      } else if (node.getAttribute?.(ATTR_CHAT_PAGE_NATIVE_HIDDEN) !== String(transaction.pageNum)) {
        try { node.setAttribute(ATTR_CHAT_PAGE_NATIVE_HIDDEN, String(transaction.pageNum)); mutations += 1; } catch {}
      }
    }
    try { selectedRow.removeAttribute('data-h2o-title-row-pending'); } catch {}
    const suffix = ensureTitleListSuffixContainer(transaction);
    if (!suffix) {
      const cleared = clearTitleListNativeInPlaceProjection(transaction, { rehide: true });
      return { ...cleared, status: 'suffix-unavailable-cleared', mutations: mutations + cleared.mutations };
    }
    try {
      transaction.titleListContainer.setAttribute(ATTR_TITLE_LIST_SEGMENT, 'prefix');
      for (let index = 0; index < rows.length; index += 1) {
        const target = index <= selectedIndex ? transaction.titleListContainer : suffix;
        if (rows[index]?.parentElement !== target) {
          target.appendChild(rows[index]);
          mutations += 1;
        }
      }
      /* Suffix placement, Pass 5A: derived from the CURRENT root and the
         CURRENT ordered anchors, with a re-check immediately before the write.
         The anchor set can change between derivation and mutation, and a
         best-effort append relative to stale state is what put the suffix in
         the wrong place; here the write is simply abandoned instead. */
      const currentRoot = surface.ok ? surface.root : collapsedPageFlowRootByIdentity(transaction.pageNum);
      const flowChildren = currentRoot?.isConnected === true
        ? Array.from(currentRoot.children || [])
        : [];
      const orderedAnchors = mount.anchors
        .filter((anchor) => anchor?.isConnected === true && anchor.parentElement === currentRoot)
        .sort((a, b) => flowChildren.indexOf(a) - flowChildren.indexOf(b));
      const lastAnchor = orderedAnchors[orderedAnchors.length - 1] || null;
      if (
        currentRoot?.isConnected !== true
        || !lastAnchor
        || lastAnchor.isConnected !== true
        || lastAnchor.parentElement !== currentRoot
      ) {
        const cleared = clearTitleListNativeInPlaceProjection(transaction, { rehide: true });
        return { ...cleared, status: 'canonical-mount-position-unavailable-cleared', mutations: mutations + cleared.mutations };
      }
      /* Placement is compared by CURRENT position, recomputed after the row
         moves above. `previousElementSibling` is a convenience the host is not
         obliged to expose on every surface, and treating its absence as "wrong
         place" made the pass re-insert on every reconcile instead of settling. */
      const placedChildren = Array.from(currentRoot.children || []);
      const anchorIndex = placedChildren.indexOf(lastAnchor);
      const suffixIndex = placedChildren.indexOf(suffix);
      if (suffix.parentElement !== currentRoot || anchorIndex < 0 || suffixIndex !== anchorIndex + 1) {
        currentRoot.insertBefore(suffix, lastAnchor.nextSibling);
        mutations += 1;
      }
    } catch {
      const cleared = clearTitleListNativeInPlaceProjection(transaction, { rehide: true });
      return { ...cleared, status: 'suffix-projection-failed-cleared', mutations: mutations + cleared.mutations };
    }
    state.pending = false;
    state.status = 'open';
    return {
      ok: true,
      status: 'open',
      mutations,
      anchors: mount.anchors.length,
      suffixRows: Math.max(0, rows.length - selectedIndex - 1),
      materialization,
    };
  }

  function openTitleListNativeInPlace(transaction = null, member = null) {
    if (!transaction || !member?.id) return { ok: false, status: 'open-preconditions-failed' };
    const key = titleListOpenStateKey(transaction.pageNum, transaction.chatId);
    const existing = S.titleListOpenStatesByKey.get(key) || null;
    if (
      titleListOpenStateCurrent(transaction, existing)
      && String(existing.canonicalId || '') === String(member.id || '')
      && String(existing.questionId || '') === String(member.questionId || '')
      && String(existing.answerId || '') === String(member.answerId || '')
      && Number(existing.turnNo || 0) === Number(member.turnNo || 0)
    ) {
      return reconcileTitleListNativeInPlaceProjection(transaction, { reason: 'row-open-repeat' });
    }
    // Resolve the exact current mount before publishing even scalar pending
    // intent. The reference is task-local only and is revalidated during the
    // projection write, so host replacement cannot turn it into retained
    // native ownership.
    const currentMount = titleListCurrentNativeMount(transaction, member);
    const state = {
      chatId: String(transaction.chatId || ''),
      pageNum: Number(transaction.pageNum || 0),
      canonicalId: String(member.id || ''),
      questionId: String(member.questionId || ''),
      answerId: String(member.answerId || ''),
      turnNo: Number(member.turnNo || 0),
      routeKey: String(transaction.routeKey || ''),
      generation: Number(transaction.generation || 0),
      effectiveFingerprint: String(transaction.effectiveFingerprint || ''),
      rowKey: String(member.id || ''),
      pending: currentMount.ok !== true,
      materializationRequested: false,
      materializationTargetQId: '',
      materializationGeneration: 0,
      materializationStatus: '',
      materializationRequestFailed: false,
      status: currentMount.ok === true ? 'opening' : 'pending',
      sequence: ++S.titleListOpenSequence,
    };
    S.titleListOpenStatesByKey.set(key, state);
    return reconcileTitleListNativeInPlaceProjection(transaction, {
      reason: 'row-open',
      currentMount,
    });
  }

  function reconcilePendingTitleListMaterialization(transaction = null, reason = 'presentation-updated') {
    if (!transaction) return null;
    const state = S.titleListOpenStatesByKey.get(
      titleListOpenStateKey(transaction.pageNum, transaction.chatId)
    ) || null;
    if (
      !titleListOpenStateCurrent(transaction, state)
      || state.pending !== true
      || state.status !== 'pending'
    ) return null;
    const result = reconcileTitleListNativeInPlaceProjection(transaction, { reason });
    return result?.status === 'pending' ? result : null;
  }

  function resetOpenedTitleListRows(pageNum = 0, chatId = '') {
    const num = Math.max(1, Number(pageNum || 0) || 0);
    const id = String(chatId || resolveChatId()).trim();
    const transaction = S.atomicPageCollapseTransactions.get(collapsedNativeRangeKey(id, num)) || null;
    if (transaction) return clearTitleListNativeInPlaceProjection(transaction, { rehide: true }).mutations;
    S.titleListOpenStatesByKey.delete(titleListOpenStateKey(num, id));
    let reset = 0;
    for (const container of getSyntheticTitleListContainers(num)) {
      for (const row of Array.from(container.querySelectorAll('[data-h2o-title-row-opened="1"], [data-h2o-title-row-pending="1"]'))) {
        try {
          row.removeAttribute('data-h2o-title-row-opened');
          row.removeAttribute('data-h2o-title-row-opened-by');
          row.removeAttribute('data-h2o-title-row-pending');
          reset += 1;
        } catch {}
      }
    }
    for (const suffix of getTitleListSuffixContainers(num, id)) {
      try { suffix.remove(); reset += 1; } catch {}
    }
    return reset;
  }

  function syntheticRowMember(row) {
    const type = String(row?.getAttribute?.('data-h2o-stack-type') || 'answer');
    const id = String(row?.getAttribute?.('data-h2o-stack-key') || row?.getAttribute?.('data-answer-id') || '').trim();
    if (!id) return null;
    return {
      id,
      type,
      answerId: type === 'answer' ? id : '',
      questionId: type === 'answer' ? '' : id,
      turnNo: Math.max(0, Number(row?.getAttribute?.('data-h2o-stack-turn-no') || 0) || 0),
    };
  }

  function setTitleListMemberCollapsed(member = null, collapsed = false) {
    if (!member?.answerId) return { ok: true, executor: 'no-answer' };
    const routes = getConfiguredDividerRoutes();
    const engineDriver = routes.dividerDotRoute === 'engine/unmount';
    const um = UM_PUBLIC();
    if (engineDriver && um) {
      try {
        let result = null;
        if (collapsed && typeof um.collapseManyByIds === 'function') {
          result = um.collapseManyByIds([member.answerId], {
            source: 'title-list-row',
            preserveShell: 'title-list-row',
            emitLegacyAnswerCollapse: false,
          });
        } else if (!collapsed && typeof um.expandManyByIds === 'function') {
          const results = [];
          const hasSource = (source) => {
            try { return typeof um.isCollapsedById !== 'function' || um.isCollapsedById(member.answerId, { source }); } catch { return true; }
          };
          if (hasSource('title-list-row')) {
            results.push(um.expandManyByIds([member.answerId], {
              source: 'title-list-row',
              emitLegacyAnswerCollapse: false,
            }));
          }
          // A pre-existing manual title collapse is the same row's own
          // source. Opening that row clears it without touching unrelated
          // page-collapse/background/windowing sources.
          if (hasSource('answer-title')) {
            results.push(um.expandManyByIds([member.answerId], {
              source: 'answer-title',
              emitLegacyAnswerCollapse: false,
            }));
          }
          // No matching engine source means the engine did no work. Fall
          // through to the local executor so a legacy DOM residue left by
          // a route change can still be expanded instead of producing an
          // empty "opened" row.
          result = results.length
            ? { ok: results.every((entry) => !!entry && entry.ok !== false), results }
            : null;
        }
        if (result && result.ok !== false) return { ok: true, executor: 'engine', result };
      } catch {}
    }
    // Fail-closed legacy fallback. The title-intent source makes the Title
    // Bar API compare actual DOM residue rather than the override written
    // immediately before this call, and does not record a second override.
    try {
      const result = AT_PUBLIC()?.setCollapsed?.(member.answerId, collapsed, {
        animate: false,
        source: 'title-intent:stack-row',
      });
      return { ok: !!result && result.ok !== false, executor: 'legacy', result };
    } catch { return { ok: false, executor: 'none' }; }
  }

  // DOUBLE-click on a stacked title bar opens/closes ONLY that member's turn
  // — the page stays in title-list mode and every other bar stays in the
  // stack with its turn hidden. This capture handler runs before the bar's
  // own dblclick listener (which would toggle bar collapse) and suppresses
  // it, plus cancels the bar's pending single-click title-edit timer.
  function onSyntheticTitleRowDblClick(ev) {
    const row = ev?.target?.closest?.('[data-h2o-stack-key]');
    if (!row) return;
    try { ev.preventDefault(); ev.stopPropagation(); ev.stopImmediatePropagation?.(); } catch {}
    try {
      if (row._titleEditTimer) { W.clearTimeout(row._titleEditTimer); row._titleEditTimer = 0; }
    } catch {}
    const projectedMember = syntheticRowMember(row);
    const projectionContainer = row.closest(`${TITLE_LIST_SYNTH_SEL}, ${TITLE_LIST_SUFFIX_SEL}`);
    const pageNum = Math.max(1, Number(projectionContainer?.getAttribute('data-page-num') || 0) || 0);
    const chatId = resolveChatId();
    const transaction = S.atomicPageCollapseTransactions.get(collapsedNativeRangeKey(chatId, pageNum)) || null;
    const member = (transaction?.titleRows || []).find((candidate) => (
      String(candidate?.id || '') === String(projectedMember?.id || '')
      && Number(candidate?.turnNo || 0) === Number(projectedMember?.turnNo || 0)
    )) || null;
    const container = transaction?.titleListContainer || null;
    if (!member || !pageNum || !transaction || !container) return;
    const opened = row.getAttribute('data-h2o-title-row-opened') === '1';
    if (!opened) {
      let executorResult = { ok: true, executor: 'no-answer' };
      if (member.type === 'answer') {
        // Explicit manual gesture: durable override first (works even for
        // unhydrated members — ledger only), then expand while the page-owned
        // native hide stamp remains active.
        recordManualTitleOverride(member.answerId, 'expanded', { chatId, page: pageNum, source: 'answer-title' });
        executorResult = setTitleListMemberCollapsed(member, false);
      } else {
        restoreNoAnswerMemberContent(member, row);
      }
      const openedInPlace = openTitleListNativeInPlace(transaction, member);
      const openedUsably = openedInPlace.ok === true
        && (openedInPlace.status === 'pending' || executorResult.ok !== false);
      if (!openedUsably) {
        clearTitleListNativeInPlaceProjection(transaction, { rehide: true });
        if (member.type === 'answer') {
          recordManualTitleOverride(member.answerId, 'collapsed', { chatId, page: pageNum, source: 'answer-title' });
          setTitleListMemberCollapsed(member, true);
        }
        setTitleListMemberFlowHidden(member, pageNum, true);
        try { syncSyntheticTitleList(pageNum, chatId, true, { reason: 'row-open-failed' }); } catch {}
        return;
      }
      try { syncSyntheticTitleList(pageNum, chatId, true, { reason: 'row-opened' }); } catch {}
    } else {
      // Close only H2O scalar/projection state, then re-hide the current
      // canonical native wrapper in its unchanged host-owned position.
      clearTitleListNativeInPlaceProjection(transaction, { rehide: true });
      if (member.type === 'answer') {
        recordManualTitleOverride(member.answerId, 'collapsed', { chatId, page: pageNum, source: 'answer-title' });
        setTitleListMemberCollapsed(member, true);
      }
      try { syncSyntheticTitleList(pageNum, chatId, true, { reason: 'row-closed' }); } catch {}
    }
    scheduleDividerVisualRefresh(chatId, 0);
  }

  // Release every real/detached bar from a stack container: real bars are
  // re-homed to their canonical message-element position, detached bars for
  // still-unhydrated members are removed (their owners recreate on demand).
  function restoreNoAnswerTitleBarToFlow(bar = null, member = null) {
    if (!bar || member?.type === 'answer') return false;
    const qSection = titleListMemberSections(member).questionSection;
    const qEl = qSection?.querySelector?.(USER_MSG_SEL) || null;
    if (!qSection || !qEl) return false;
    const parent = qEl.parentElement && qEl.parentElement !== qSection ? qEl.parentElement : qSection;
    try {
      parent.insertBefore(bar, qEl.nextElementSibling || null);
      bar.removeAttribute('data-h2o-detached-title-bar');
      return true;
    } catch { return false; }
  }

  function releaseTitleStackBars(container) {
    if (!container?.querySelectorAll) return 0;
    const at = AT_PUBLIC();
    let released = 0;
    for (const bar of Array.from(container.querySelectorAll('[data-h2o-stack-key]'))) {
      const member = syntheticRowMember(bar);
      const answerId = String(bar.getAttribute('data-answer-id') || '').trim();
      const detached = bar.getAttribute('data-h2o-detached-title-bar') === '1';
      for (const attr of ['data-h2o-in-title-stack', 'data-h2o-stack-key', 'data-h2o-stack-type', 'data-h2o-stack-turn-no', ATTR_TITLE_LIST_NUM, 'data-h2o-title-row-opened', 'data-h2o-title-row-opened-by']) {
        try { bar.removeAttribute(attr); } catch {}
      }
      const restoredNoAnswer = member?.type !== 'answer' && restoreNoAnswerTitleBarToFlow(bar, member);
      const msgEl = (!restoredNoAnswer && !detached && answerId) ? (at?.getMessageEl?.(answerId) || null) : null;
      if (restoredNoAnswer) {
        // Restored above; MiniMap Core remains the normal-flow NO ANSWER
        // creator/wiring owner once title-list mode is inactive.
      } else if (msgEl) {
        try { msgEl.insertBefore(bar, msgEl.firstElementChild || null); } catch { try { bar.remove(); } catch {} }
      } else {
        try { bar.remove(); } catch {}
      }
      // Rehosting removes the bar from the washed assistant subtree and the
      // answer body may have just rehydrated. Reproject from washer state onto
      // the restored flow answer, its one title bar, and the MiniMap button.
      if (member?.type === 'answer' && answerId) {
        try { WASH_PUBLIC()?.replayForId?.(answerId, { barEl: bar?.isConnected ? bar : null }); } catch {}
      }
      released += 1;
    }
    return released;
  }

  function syncSyntheticTitleList(pageNum = 0, chatId = '', active = false, opts = {}) {
    const num = Math.max(1, Number(pageNum || 0) || 0);
    const id = String(chatId || resolveChatId()).trim();
    const reason = String(opts?.reason || 'stack-sync').trim() || 'stack-sync';
    const transactionKey = collapsedNativeRangeKey(id, num);
    const transaction = S.atomicPageCollapseTransactions.get(transactionKey) || null;
    if (!active) {
      if (transaction) {
        return expandPageWithRenderedBoundaries(num, {
          chatId: id,
          source: `synthetic-release:${reason}`,
        });
      }
      releaseCollapsedNativeRange(num);
      S.nativeRangeActivePages.delete(transactionKey);
      let released = 0;
      for (const stale of getSyntheticTitleListContainers(num)) {
        released += releaseTitleStackBars(stale);
        try { stale.remove(); } catch {}
      }
      for (const suffix of getTitleListSuffixContainers(num, id)) {
        try { suffix.remove(); released += 1; } catch {}
      }
      S.titleListOpenStatesByKey.delete(titleListOpenStateKey(num, id));
      released += sweepSyntheticTitleListHidden(num);
      S.titleListStacksByKey.delete(titleListStackRegistryKey(num, id));
      getTitleListStackStats(num, id).activeStackId = '';
      syncTitleOnlyModeRootAttribute(id);
      try { WASH_PUBLIC()?.repairMiniMap?.(`title-list-release:${reason}`); } catch {}
      return { ok: true, status: 'inactive', pageNum: num, rows: 0, released };
    }
    if (transaction) {
      // Validation is itself identity-based now, so a projection sync
      // re-resolves replacement elements as part of asking the question. The
      // separate rebind step it used to need is gone.
      let current = validateCommittedAtomicPageCollapse(transaction);
      if (!current.ok) {
        const pending = reconcilePendingTitleListMaterialization(transaction, reason);
        if (pending) {
          return {
            ok: true,
            status: 'pending',
            pageNum: num,
            rows: transaction.titleRowsPrepared.length,
            stackId: transaction.titleListContainer.id,
            reason,
            titleOnly: {
              ok: true,
              status: 'pending',
              hidden: titleListCurrentProjectedCount(transaction),
              mutations: Number(pending.mutations || 0),
            },
          };
        }
      }
      if (current.ok) {
        reconcileTitleListNativeInPlaceProjection(transaction, { reason });
        current = validateCommittedAtomicPageCollapse(transaction);
      }
      if (!current.ok) {
        return expandPageWithRenderedBoundaries(num, {
          chatId: id,
          source: `synthetic-validate:${reason}:${current.reason}`,
        });
      }
      return {
        ok: true,
        status: 'current',
        pageNum: num,
        rows: transaction.titleRowsPrepared.length,
        stackId: transaction.titleListContainer.id,
        reason,
        titleOnly: {
          ok: true,
          status: 'collapsed',
          hidden: titleListCurrentProjectedCount(transaction),
          mutations: 0,
        },
      };
    }
    const readiness = getCollapsedNativeBoundaryReadiness(num);
    return failClosedCollapsedTitleList(num, id, readiness, reason);

  }

  function scheduleActiveTitleListRepair(reason = 'canonical-index-updated', delay = 16, pageNum = 0) {
    const requestedPage = Math.max(0, Number(pageNum || 0) || 0);
    if (requestedPage) S.titleListRepairPages.add(requestedPage);
    else S.titleListRepairAllPages = true;
    if (S.titleListRepairTimer) {
      try { W.clearTimeout(S.titleListRepairTimer); } catch {}
    }
    S.titleListRepairTimer = W.setTimeout(() => {
      S.titleListRepairTimer = 0;
      S.titleListRepairPages.clear();
      S.titleListRepairAllPages = false;
      reconcileAtomicPageCollapseTransactions(`scheduled:${reason}`);
    }, Math.max(0, Number(delay || 0) || 0));
    return true;
  }

  function reassertActiveTitleListFlowHidden(pageNum = 0, chatId = '') {
    const num = Math.max(1, Number(pageNum || 0) || 0);
    const id = String(chatId || resolveChatId()).trim();
    if (!isTitleListActive(num, id)) return { ok: true, status: 'inactive', hidden: 0 };
    const transaction = S.atomicPageCollapseTransactions.get(collapsedNativeRangeKey(id, num)) || null;
    const current = validateCommittedAtomicPageCollapse(transaction);
    if (!current.ok) {
      return expandPageWithRenderedBoundaries(num, {
        chatId: id,
        source: `reassert:${current.reason}`,
      });
    }
    return {
      ok: true,
      status: 'current',
      hidden: titleListCurrentProjectedCount(transaction),
      mutations: 0,
    };
  }

  function applyTitleListVisuals(pageNum = 0, opts = {}) {
    const id = String(opts?.chatId || resolveChatId()).trim();
    const num = Math.max(1, Number(pageNum || 0) || 0);
    const active = isTitleListActive(num, id);
    if (active) {
      const current = reassertActiveTitleListFlowHidden(num, id);
      return {
        ok: current?.ok !== false,
        status: current?.status || 'current',
        chatId: id,
        pageNum: num,
        rows: S.atomicPageCollapseTransactions.get(
          collapsedNativeRangeKey(id, num)
        )?.titleRowsPrepared?.length || 0,
        active: true,
        atomic: true,
      };
    }
    const rows = getRows(num, id);
    const at = AT_PUBLIC();
    const um = UM_PUBLIC();
    const routes = getConfiguredDividerRoutes();
    const driver = routes.dividerDotRoute === 'engine/unmount' ? 'engine' : 'legacy';
    const skipAnswerBatch = opts?.skipAnswerBatch === true;
    // The EXPAND batch is an explicit user action (divider dot click), never a
    // background repair: refresh/hydration passes call this function for every
    // known page with active=false, and running the expand batch there wiped
    // the `title-list-row` ledger (and, in legacy mode, manual collapses)
    // moments after a mass collapse — leaving freshly hydrated rows expanded.
    // Collapse re-application stays allowed on every pass so hydrating rows
    // of an active title-list page snap collapsed.
    const explicitDotAction = String(opts?.source || '').startsWith('chat-page-divider:dot');
    const ledger = readTitleIntentLedger(id);
    const pageHasTitleIntent = titleIntentPageHasActiveState(num, ledger);
    const needsAnswerIds = !!active || explicitDotAction || pageHasTitleIntent;
    const answerIds = needsAnswerIds ? normalizeAnswerIds(getAuthoritativePageAnswerIds(num, id)) : [];

    // Enter title-only mode before any collapse/unmount executor can expose a
    // row-by-row teardown. All host flow is synchronously hidden behind the
    // central projection in this same task; background collapse remains a
    // performance operation and is never a visible transition.
    let synth = active
      ? syncSyntheticTitleList(num, id, true, {
        reason: String(opts?.source || 'apply-title-list-visuals'),
        boundaryReadiness: opts?.boundaryReadiness || null,
      })
      : null;
    if (active && synth?.ok === false) {
      return {
        ok: false,
        status: synth.status || 'collapsed-exact-boundary-unavailable',
        chatId: id,
        pageNum: num,
        rows: rows.length,
        active: false,
        driver,
        synth,
      };
    }

    if (answerIds.length && !skipAnswerBatch) {
      if (driver === 'engine') {
        try {
          if (active && typeof um?.collapseManyByIds === 'function') {
            um.collapseManyByIds(answerIds, {
              source: 'title-list-row',
              preserveShell: 'title-list-row',
              emitLegacyAnswerCollapse: false,
            });
          } else if (!active && explicitDotAction && typeof um?.expandManyByIds === 'function') {
            um.expandManyByIds(answerIds, {
              source: 'title-list-row',
              emitLegacyAnswerCollapse: false,
            });
          }
        } catch {}
      } else if (at?.setCollapsed) {
        if (active || explicitDotAction) {
          for (const answerId of answerIds) {
            try { at.setCollapsed(answerId, !!active, { animate: false, source: 'chat-pages-controller:title-list' }); } catch {}
          }
        }
      }
    }

    // The synthetic stack is the sole active flow-hide owner. Legacy row
    // helpers are used only while releasing title-list mode so their old
    // inner-node stamps cannot compete with whole-wrapper hiding.
    if (!active) {
      for (const row of rows) {
        if (row.noAnswer) {
          applyNoAnswerTitleCollapsedDom(row.answerHost, false, {
            animate: opts?.animate === true,
            bar: row.titleBar,
            questionHost: row.questionHost,
          });
        } else {
          setQuestionHostTitleListHidden(row.questionHost, false);
        }
      }
    }
    if (!active) sweepQuestionHostRestore();
    // Exit only after expansion/restoration has completed, so releasing the
    // central stamp reveals one coherent normal-conversation state.
    if (!active) {
      synth = syncSyntheticTitleList(num, id, false, { reason: String(opts?.source || 'apply-title-list-visuals') });
    }

    const intentReplay = pageHasTitleIntent
      ? applyTitleIntentToPage(num, { chatId: id, answerIds, animate: opts?.animate === true, ledger })
      : { ok: true, status: 'skipped-inert', chatId: id, pageNum: num, members: 0, hydrated: 0, unhydrated: 0, results: [] };
    if (!pageHasTitleIntent) incTitleIntentStat('replaySkippedInert');
    // Dot expand is an explicit bounded convergence campaign. Source clearing
    // happens first (router + residual source check), then 1C1a's one title
    // projection executor unfolds every hydrated canonical member. Repeated
    // passes are bounded to 1.8s and page-scoped, covering native hydration
    // races without introducing another open-chat/background repair loop.
    let expandConvergence = null;
    if (active) cancelDotExpandConvergence(num, id);
    else if (explicitDotAction) expandConvergence = scheduleDotExpandConvergence(num, id);
    return { ok: true, status: 'ok', chatId: id, pageNum: num, rows: rows.length, active, driver, synth, intentReplay, expandConvergence };
  }

  function setTitleListMode(pageNum = 0, enabled = false, opts = {}) {
    const id = String(opts?.chatId || resolveChatId()).trim();
    const num = Math.max(1, Number(pageNum || 0) || 0);
    const source = String(opts?.source || 'chat-pages-controller:title-list').trim() || 'chat-pages-controller:title-list';
    if (enabled) {
      // Only the explicit divider transaction may activate Stage 2C-2.
      return {
        ok: false,
        status: 'explicit-atomic-activation-required',
        chatId: id,
        pageNum: num,
        enabled: false,
        source,
      };
    }
    const expanded = expandPageWithRenderedBoundaries(num, { chatId: id, source });
    if (expanded.status !== 'inactive') return expanded;
    releaseCollapsedNativeRange(num);
    localForgetTitleListPage(id, num);
    for (const stale of getSyntheticTitleListContainers(num)) {
      try { releaseTitleStackBars(stale); } catch {}
      try { stale.remove(); } catch {}
    }
    for (const suffix of getTitleListSuffixContainers(num, id)) {
      try { suffix.remove(); } catch {}
    }
    S.titleListOpenStatesByKey.delete(titleListOpenStateKey(num, id));
    S.titleListStacksByKey.delete(titleListStackRegistryKey(num, id));
    syncTitleOnlyModeRootAttribute(id);
    return { ok: true, status: 'inactive', chatId: id, pageNum: num, enabled: false, source };
  }

  function applyPageCollapsedVisuals(pageNum = 0, opts = {}) {
    const id = String(opts?.chatId || resolveChatId()).trim();
    const num = Math.max(1, Number(pageNum || 0) || 0);
    const collapsed = isPageCollapsed(num, id);
    const driver = normalizeVisualDriver(opts?.driver || getPageCollapseDriver(num, id));
    const mode = String(opts?.mode || getPageCollapseMode(num, id) || '').trim().toLowerCase();
    const payload = getSections(id);
    const section = payload?.sections?.get?.(num) || null;
    const hosts = Array.isArray(section?.hosts) ? section.hosts : [];
    const bodyHosts = getPageBodyHosts(hosts);

    for (const host of bodyHosts) setChatPageTurnHostDomState(host, num, collapsed);
    // Expand must not depend on the freshly rebuilt host list: hydration
    // churn can leave it incomplete and strand hidden sections/wrappers.
    // Collapse stamped every host it hid with page-num + hidden attrs, so
    // restore sweeps those stamps directly.
    if (!collapsed) sweepPageHiddenDomState(num);
    const pushSource = String(opts?.source || 'chat-sync').trim() || 'chat-sync';
    const chatRev = chatPageRevFor(num, id, { source: pushSource });
    try { MM_CORE_PAGES()?.setMiniMapPageCollapsed?.(num, collapsed, id, { source: pushSource, mode: 'chat-sync', chatRev, propagate: true }); } catch {}
    try { MM_CORE_PAGES()?.renderDividers?.(id); } catch {}
    scheduleDividerVisualRefresh(id, 0);
    return { ok: true, status: 'ok', chatId: id, pageNum: num, collapsed, hosts: bodyHosts.length, driver, mode, wrappedByPagination: false };
  }

  function applyPageVisuals(pageNum = 0, opts = {}) {
    const id = String(opts?.chatId || resolveChatId()).trim();
    const num = Math.max(1, Number(pageNum || 0) || 0);
    const source = String(opts?.source || 'chat-pages-controller').trim() || 'chat-pages-controller';
    const titleResult = applyTitleListVisuals(num, { chatId: id, source, animate: opts?.animate });
    const pageResult = applyPageCollapsedVisuals(num, { chatId: id, source });
    // Page-collapse restore can remove display from pair wrappers. Reassert
    // only the hide projection here; applyTitleListVisuals above already ran
    // the sole stack reconciler. A second full sync was the delayed row
    // replacement path that downgraded titles and washer state.
    const titleListFlow = reassertActiveTitleListFlowHidden(num, id);
    scheduleDividerVisualRefresh(id, 0);
    return { ok: titleResult?.ok !== false && pageResult?.ok !== false, status: 'ok', chatId: id, pageNum: num, titleResult, pageResult, titleListFlow };
  }

  function setPageCollapsed(pageNum = 0, collapsed = true, opts = {}) {
    const id = String(opts?.chatId || resolveChatId()).trim();
    const num = Math.max(1, Number(pageNum || 0) || 0);
    const driver = normalizeVisualDriver(opts?.driver);
    const mode = String(opts?.mode || '').trim().toLowerCase();
    const source = String(opts?.source || 'chat-pages-controller').trim() || 'chat-pages-controller';
    const transaction = executeAtomicPageCollapseTransaction(num, source, {
      chatId: id,
      desired: collapsed ? 'collapsed' : 'expanded',
    });
    return {
      ok: transaction?.ok === true,
      status: transaction?.status || 'ok',
      chatId: id,
      pageNum: num,
      collapsed: !!collapsed,
      source,
      driver,
      mode,
      transaction,
    };
  }

  function togglePageCollapsed(pageNum = 0, opts = {}) {
    const id = String(opts?.chatId || resolveChatId()).trim();
    const num = Math.max(1, Number(pageNum || 0) || 0);
    const driver = normalizeVisualDriver(opts?.driver);
    const mode = String(opts?.mode || '').trim().toLowerCase();
    const source = String(opts?.source || 'chat-pages-controller').trim() || 'chat-pages-controller';
    const transaction = executeAtomicPageCollapseTransaction(num, source, { chatId: id });
    return {
      ok: transaction?.ok === true,
      status: transaction?.status || 'ok',
      chatId: id,
      pageNum: num,
      source,
      driver,
      mode,
      transaction,
    };
  }

  function resetAllMechanisms(chatId = '') {
    const id = String(chatId || resolveChatId()).trim();
    if (!id) return { ok: false, status: 'chat-id-missing', chatId: '', pages: 0, answers: 0, manualCollapsed: 0 };

    const pageNums = collectKnownPageNums(id);
    const at = AT_PUBLIC();
    const um = UM_PUBLIC();
    const pg = PG_ADAPTER();
    const answerIds = new Set();
    const manualCollapsedIds = new Set();
    const resetDetails = {
      pagination: null,
      remountedBackgroundTurns: 0,
      unmountManual: null,
      titleBar: null,
    };

    for (const pageNum of pageNums) {
      for (const row of getRows(pageNum, id)) {
        const aId = String(row?.answerId || '').trim();
        if (aId && !row?.noAnswer) answerIds.add(aId);
      }
    }

    // Shell-persistent chats may have zero hydrated rows at visit time. The
    // canonical runtime still knows every answer id, which is required to
    // filter this chat out of the legacy global collapsed-id set safely.
    try {
      for (const record of TURN_RUNTIME()?.listTurnRecords?.() || []) {
        const ids = Array.isArray(record?.answerIds)
          ? record.answerIds
          : [record?.primaryAId, record?.answerId, record?.aId];
        for (const rawId of ids) {
          const aId = String(rawId || '').trim();
          if (aId) answerIds.add(aId);
        }
      }
    } catch {}

    try {
      const raw = um?.getManualCollapsedIds?.() || [];
      for (const rawId of Array.isArray(raw) ? raw : []) {
        const aId = String(rawId || '').trim();
        if (!aId) continue;
        manualCollapsedIds.add(aId);
        answerIds.add(aId);
      }
    } catch {}

    // Hard reset current chat back to origin before any of the 3 mechanisms.
    // 1) Tear down transient/committed pagination runtime so the live root returns to full-chat origin.
    // Keep preserveApi=true so feature surfaces survive; this is a live-session reset, not a feature unload.
    if (typeof pg?.teardownRuntimeSession === 'function') {
      try { resetDetails.pagination = pg.teardownRuntimeSession('thread-pages-controller:reset-all-mechanisms', { preserveApi: true }); } catch {}
    }

    // 2) Remount background-unmounted turns first so later hard-expands can take over mounted DOM reliably.
    if (typeof um?.remountAll === 'function') {
      try { resetDetails.remountedBackgroundTurns = Number(um.remountAll('thread-pages-controller:reset-all-mechanisms') || 0); } catch {}
    }

    // 3) Clear every manual Unmount collapse source for this chat, not only answer-title.
    //    This is critical because page divider dblclick may collapse with source 'page-collapse'.
    if (typeof um?.clearManualCollapsedForCurrentChat === 'function') {
      try {
        resetDetails.unmountManual = um.clearManualCollapsedForCurrentChat({
          chatId: id,
          emitLegacyAnswerCollapse: true,
        });
      } catch {}
    } else if (typeof um?.expandManyByIds === 'function' && answerIds.size) {
      try {
        resetDetails.unmountManual = um.expandManyByIds(Array.from(answerIds), {
          emitLegacyAnswerCollapse: true,
        });
      } catch {}
    }

    // 4) Clear Turn Title Bar local/dom residue for mounted rows in the current thread.
    if (typeof at?.resetCollapsedForCurrentChat === 'function') {
      try { resetDetails.titleBar = at.resetCollapsedForCurrentChat({ animate: false, answerIds: Array.from(answerIds) }); } catch {}
    }

    // 5) Restore question hosts / no-answer shells to the true open baseline.
    for (const pageNum of pageNums) {
      for (const row of getRows(pageNum, id)) {
        if (row.noAnswer) {
          applyNoAnswerTitleCollapsedDom(row.answerHost, false, { animate: false, bar: row.titleBar, questionHost: row.questionHost });
        } else {
          setQuestionHostTitleListHidden(row.questionHost, false);
        }
      }
    }

    // 6) Restore any stored title-list and divider-button page-collapse state for this thread.
    localWriteTitleListPagesSet(id, []);
    localWriteCollapsedPagesSet(id, []);
    // Clear the intent ledger only when it actually holds intents — an
    // already-inert chat must not get an empty ledger written on reset.
    if (isTitleIntentEngineActive(id)) writeTitleIntentLedger(id, createEmptyTitleIntentLedger());
    S.titleListPagesByChat.set(id, new Set());
    S.collapsedPageDriversByChat.delete(id);
    S.collapsedPageModesByChat.delete(id);
    for (const pageNum of pageNums) {
      applyPageVisuals(pageNum, { chatId: id, source: 'reset-all-mechanisms' });
    }

    // 7) Final sweep: remove residual hidden question/title-list state and any
    //    stale page-hidden sections/wrappers, then rebuild dividers from clean
    //    chat state.
    sweepStalePageHiddenDomState(id);
    sweepQuestionHostRestore();
    // Release ALL synthetic title-list containers and flow stamps (page 0 =
    // every page), including pages no longer in the known-page inventory.
    sweepSyntheticTitleListHidden(0);
    try {
      for (const container of Array.from(document.querySelectorAll(TITLE_LIST_SYNTH_SEL))) {
        releaseTitleStackBars(container);
        try { container.remove(); } catch {}
      }
      for (const suffix of Array.from(document.querySelectorAll(TITLE_LIST_SUFFIX_SEL))) {
        try { suffix.remove(); } catch {}
      }
    } catch {}
    for (const [key] of Array.from(S.titleListOpenStatesByKey.entries())) {
      if (!id || key.startsWith(`${id}::`)) S.titleListOpenStatesByKey.delete(key);
    }
    for (const [key] of Array.from(S.titleListStacksByKey.entries())) {
      if (!id || key.startsWith(`${id}::`)) S.titleListStacksByKey.delete(key);
    }
    for (const [key, stats] of Array.from(S.titleListStackStatsByKey.entries())) {
      if (!id || key.startsWith(`${id}::`)) stats.activeStackId = '';
    }
    try { MM_CORE_PAGES()?.renderDividers?.(id); } catch {}
    scheduleDividerVisualRefresh(id, 0);
    return {
      ok: true,
      status: 'ok',
      chatId: id,
      pages: pageNums.length,
      answers: answerIds.size,
      manualCollapsed: manualCollapsedIds.size,
      resetDetails,
    };
  }

  // ── Chat visit state policy (Performance → Mechanisms → Chat visit state) ──
  // One visit is one module load for a hard reload, or one transition into a
  // different chat id for SPA navigation. Ordinary pagination/title refreshes
  // stay inside that visit and must never retrigger reset.
  const KEY_VISIT_STATE_MODE_V1 = 'h2o:prm:cgx:mnmp:ui:chat-pages:visit-state-mode:v1';
  const KEY_LEGACY_TITLE_COLLAPSED_V1 = 'h2o:prm:cgx:atitle:collapsed:v1';

  function getVisitStateMode() {
    try {
      const v = W.localStorage?.getItem(KEY_VISIT_STATE_MODE_V1);
      return v === 'reset' ? 'reset' : 'remember';
    } catch { return 'remember'; }
  }

  function resolveVisitChatId(chatId = '') {
    try {
      const path = String(W.location?.pathname || '');
      const match = path.match(/\/c\/([^/?#]+)/i);
      if (match?.[1]) return decodeURIComponent(match[1]);
      if (!/\/g\/[^/?#]+/i.test(path)) return '';
    } catch {}
    const id = String(chatId || resolveChatId()).trim();
    if (!id || id === '/') return '';
    return id;
  }

  function beginChatVisit(chatId = '', opts = {}) {
    const id = resolveVisitChatId(chatId);
    const state = S.visitState;
    if (!id) {
      state.missingChatIdDeferrals += 1;
      return { ok: false, status: 'chat-id-missing', chatId: '' };
    }
    if (state.deferredTimer) {
      try { W.clearTimeout(state.deferredTimer); } catch {}
      state.deferredTimer = 0;
    }
    const forceNew = opts?.forceNew === true;
    if (forceNew || state.currentChatId !== id || !state.currentVisitId) {
      state.visitSequence += 1;
      state.currentChatId = id;
      state.currentVisitId = `${Date.now().toString(36)}-${state.visitSequence}-${safeChatKeyPart(id).slice(0, 18)}`;
      state.resetAppliedThisVisit = false;
      state.restoreSuppressedBecauseReset = false;
      state.liveStateCleared = false;
      state.domCleanupApplied = false;
    }
    return { ok: true, status: 'visit-ready', chatId: id, visitId: state.currentVisitId };
  }

  function clearTitleIntentProjectionAttrs() {
    const attrs = [
      'data-h2o-title-page', 'data-h2o-title-desired', 'data-h2o-title-state-source',
      'data-h2o-title-rev', 'data-h2o-title-pending-state', 'data-h2o-title-pending-rev',
    ];
    let changed = 0;
    try {
      for (const el of Array.from(document.querySelectorAll(attrs.map((attr) => `[${attr}]`).join(',')))) {
        let localChanged = false;
        for (const attr of attrs) {
          if (!el.hasAttribute?.(attr)) continue;
          try { el.removeAttribute(attr); localChanged = true; } catch {}
        }
        if (localChanged) changed += 1;
      }
    } catch {}
    return changed;
  }

  function clearVisitStateForChat(chatId = '', opts = {}) {
    const id = resolveVisitChatId(chatId);
    const state = S.visitState;
    if (!id) {
      state.missingChatIdDeferrals += 1;
      return { ok: false, status: 'chat-id-missing', chatId: '' };
    }

    const titleListKey = keyTitleListPages(id);
    const collapsedPagesKey = keyCollapsedPages(id);
    const intentKey = keyTitleIntentLedger(id);
    const before = {
      titleListPages: localReadTitleListPagesSet(id).size,
      collapsedPages: localReadCollapsedPagesSet(id).size,
      intentActive: isTitleIntentEngineActive(id),
      titleListRaw: storageGetRaw(titleListKey),
      collapsedRaw: storageGetRaw(collapsedPagesKey),
      intentRaw: storageGetRaw(intentKey),
      liveDrivers: S.collapsedPageDriversByChat.get(id)?.size || 0,
      liveModes: S.collapsedPageModesByChat.get(id)?.size || 0,
      detachedPages: 0,
      paginationActive: (() => {
        try {
          const paginationState = PG_ADAPTER()?.getDividerPaginationState?.() || null;
          return !!paginationState?.active || !!paginationState?.transient;
        } catch { return false; }
      })(),
    };

    const reset = resetAllMechanisms(id);
    const unmountReset = reset?.resetDetails?.unmountManual || null;
    const titleReset = reset?.resetDetails?.titleBar || null;

    const clearedKeys = [];
    const skippedKeys = [];
    const noteKey = (key, existed) => (existed ? clearedKeys : skippedKeys).push(key);
    noteKey(titleListKey, before.titleListRaw != null);
    noteKey(collapsedPagesKey, before.collapsedRaw != null);
    noteKey(intentKey, before.intentRaw != null);
    if (unmountReset?.storageKey) noteKey(unmountReset.storageKey, !!unmountReset.persistedExisted);
    noteKey(KEY_LEGACY_TITLE_COLLAPSED_V1, !!titleReset?.persistedChanged);

    storageRemove(titleListKey);
    storageRemove(collapsedPagesKey);
    storageRemove(intentKey);
    S.titleListPagesByChat.set(id, new Set());
    S.collapsedPagesByChat.set(id, new Set());
    S.collapsedPageDriversByChat.delete(id);
    S.collapsedPageModesByChat.delete(id);
    cacheTitleIntentLedger(id, createEmptyTitleIntentLedger());
    S.titleIntentLastAppliedByAnswer.clear();

    let orphanStackBarsCleaned = 0;
    try {
      const at = AT_PUBLIC();
      for (const bar of Array.from(document.querySelectorAll('[data-h2o-in-title-stack]'))) {
        if (bar.closest?.(TITLE_LIST_SYNTH_SEL)) continue;
        const answerId = String(bar.getAttribute('data-answer-id') || '').trim();
        const detached = bar.getAttribute('data-h2o-detached-title-bar') === '1';
        for (const attr of [
          'data-h2o-in-title-stack', 'data-h2o-stack-key', 'data-h2o-stack-type',
          'data-h2o-stack-turn-no', ATTR_TITLE_LIST_NUM, 'data-h2o-title-row-opened',
        ]) {
          try { bar.removeAttribute(attr); } catch {}
        }
        const msgEl = (!detached && answerId) ? (at?.getMessageEl?.(answerId) || null) : null;
        if (msgEl) {
          try { msgEl.insertBefore(bar, msgEl.firstElementChild || null); } catch {}
        } else if (detached) {
          try { bar.remove(); } catch {}
        }
        orphanStackBarsCleaned += 1;
      }
    } catch {}

    const projectionAttrsCleared = clearTitleIntentProjectionAttrs();
    sweepSyntheticTitleListHidden(0);
    sweepStalePageHiddenDomState(id);
    sweepQuestionHostRestore();

    const familyNames = [];
    if (before.titleListPages > 0 || before.titleListRaw != null) familyNames.push('title-list-pages');
    if (before.collapsedPages > 0 || before.collapsedRaw != null) familyNames.push('collapsed-pages');
    if (before.intentActive || before.intentRaw != null) familyNames.push('title-intent');
    if (unmountReset?.persistedExisted || Number(unmountReset?.liveRecords || 0) > 0) familyNames.push('engine-manual-title-collapse');
    if (titleReset?.persistedChanged) familyNames.push('legacy-manual-title-collapse');
    if (before.liveDrivers || before.liveModes || before.detachedPages || before.paginationActive) familyNames.push('live-page-runtime');

    const result = {
      ok: reset?.ok !== false,
      status: reset?.ok === false ? (reset?.status || 'reset-failed') : 'cleared',
      reason: String(opts?.reason || 'visit-reset'),
      chatId: id,
      clearedFamilies: familyNames.length,
      clearedFamilyNames: familyNames,
      clearedKeys,
      skippedKeys,
      liveStateCleared: reset?.ok !== false,
      domCleanupApplied: reset?.ok !== false,
      projectionAttrsCleared,
      orphanStackBarsCleaned,
      reset,
    };
    state.lastResult = result;
    return result;
  }

  function commitVisitResetResult(result = null) {
    const state = S.visitState;
    const ok = !!result?.ok;
    state.resets += ok ? 1 : 0;
    state.resetAppliedThisVisit = ok;
    state.resetAppliedAt = ok ? Date.now() : 0;
    state.clearedFamilies = Number(result?.clearedFamilies || 0);
    state.clearedFamilyNames = result?.clearedFamilyNames || [];
    state.clearedKeys = result?.clearedKeys || [];
    state.skippedKeys = result?.skippedKeys || [];
    state.liveStateCleared = !!result?.liveStateCleared;
    state.domCleanupApplied = !!result?.domCleanupApplied;
    return result;
  }

  function clearVisitStateForCurrentChat(opts = {}) {
    const id = resolveVisitChatId(opts?.chatId || resolveChatId());
    const visit = beginChatVisit(id);
    if (!visit.ok) return visit;
    S.visitState.restoreSuppressedBecauseReset = getVisitStateMode() === 'reset';
    return commitVisitResetResult(clearVisitStateForChat(id, {
      reason: opts?.reason || 'debug-api',
    }));
  }

  function maybeApplyVisitStatePolicy(chatId = '', opts = {}) {
    const state = S.visitState;
    const mode = getVisitStateMode();
    state.lastMode = mode;
    const visit = beginChatVisit(chatId, { forceNew: opts?.forceNewVisit === true });
    if (!visit.ok) return { mode, applied: false, deferred: true };
    if (mode !== 'reset') {
      state.restoreSuppressedBecauseReset = false;
      return { mode, applied: false, chatId: visit.chatId, visitId: visit.visitId };
    }
    state.restoreSuppressedBecauseReset = true;
    if (state.resetAppliedThisVisit && opts?.forceReset !== true) {
      return { mode, applied: false, alreadyApplied: true, chatId: visit.chatId, visitId: visit.visitId };
    }

    const result = clearVisitStateForChat(visit.chatId, { reason: opts?.reason || 'chat-visit' });
    commitVisitResetResult(result);
    return { mode, applied: !!result.ok, chatId: visit.chatId, visitId: visit.visitId, result };
  }

  function scheduleDeferredVisitRefresh(reason = 'deferred-chat-id', attempt = 0) {
    const state = S.visitState;
    if (state.deferredTimer) return;
    if (attempt >= 20) return;
    state.deferredTimer = W.setTimeout(() => {
      state.deferredTimer = 0;
      const id = resolveVisitChatId();
      if (!id) {
        state.missingChatIdDeferrals += 1;
        scheduleDeferredVisitRefresh(reason, attempt + 1);
        return;
      }
      refreshAll(id, { reason, forceNewVisit: true });
    }, 50);
  }

  function refreshAll(chatId = '', opts = {}) {
    const requestedId = String(chatId || resolveChatId()).trim();
    const atomicValidation = reconcileAtomicPageCollapseTransactions(
      String(opts?.reason || 'refresh')
    );
    const visitPolicy = maybeApplyVisitStatePolicy(requestedId, opts);
    if (visitPolicy.deferred) {
      scheduleDeferredVisitRefresh(opts?.reason || 'refresh-chat-id');
      return { ok: false, status: 'visit-reset-deferred', chatId: '', pages: [] };
    }
    const id = String(visitPolicy.chatId || requestedId).trim();
    const hydration = S.atomicPageCollapseTransactions.size
      ? { ok: true, status: 'atomic-collapse-active' }
      : reconcileTitleListPageHydration(id, {
        reason: String(opts?.reason || 'refresh'),
      });
    const pageNums = collectKnownPageNums(id);
    for (const pageNum of pageNums) {
      if (isTitleListActive(pageNum, id)) reassertActiveTitleListFlowHidden(pageNum, id);
      else applyPageVisuals(pageNum, { chatId: id, source: 'chat-pages-controller:refresh' });
    }
    sweepStalePageHiddenDomState(id);
    try { MM_CORE_PAGES()?.renderDividers?.(id); } catch {}
    scheduleDividerVisualRefresh(id, 0);
    return {
      ok: true,
      status: 'refreshed',
      chatId: id,
      pages: pageNums,
      hydration,
      atomicValidation,
    };
  }

  // Pure read-only membership for the debug snapshot: canonical turn-list
  // slice only. It must NEVER route through getRows /
  // getAuthoritativePageAnswerIds — the Core row builder creates no-answer
  // title bars as a side effect, so a diagnostic call could itself mutate the
  // DOM and re-feed the mutation observers it is trying to observe.
  function pureCanonicalPageMembers(pageNum = 0) {
    return pureCanonicalPageMemberDetails(pageNum)
      .filter((member) => member.type === 'answer' && member.answerId)
      .map((member) => member.answerId);
  }

  const LP_DIAG_UNKNOWN = 'unknown';

  function unknownLogicalPaginationDiagnostics(reason = 'diagnostic-unavailable') {
    const why = String(reason || 'diagnostic-unavailable');
    return {
      stableShellCount: LP_DIAG_UNKNOWN,
      hydratedRoleNodeCount: LP_DIAG_UNKNOWN,
      turnRuntimeRecordCount: LP_DIAG_UNKNOWN,
      paginationCanonicalCount: LP_DIAG_UNKNOWN,
      logicalPageMemberCount: LP_DIAG_UNKNOWN,
      logicalPageCount: LP_DIAG_UNKNOWN,
      logicalCanonicalReady: false,
      shellCoverageRatio: LP_DIAG_UNKNOWN,
      hydrationCoverageRatio: LP_DIAG_UNKNOWN,
      missingLogicalMembers: [],
      unknownOrUnpairedShells: [],
      pageMembershipGaps: [],
      duplicateLogicalMembers: [],
      paginationEnabled: LP_DIAG_UNKNOWN,
      unmountEnabled: LP_DIAG_UNKNOWN,
      physicalOptimizersInert: LP_DIAG_UNKNOWN,
      detachedHostCount: LP_DIAG_UNKNOWN,
      paginationPlaceholderCount: LP_DIAG_UNKNOWN,
      unmountPlaceholderCount: LP_DIAG_UNKNOWN,
      fragmentCacheCount: LP_DIAG_UNKNOWN,
      detachCommentCount: LP_DIAG_UNKNOWN,
      stalePhysicalResiduePresent: LP_DIAG_UNKNOWN,
      titleListActive: LP_DIAG_UNKNOWN,
      duplicateTitleBarsVisible: LP_DIAG_UNKNOWN,
      titleMismatches: [],
      noAnswerRowsStable: LP_DIAG_UNKNOWN,
      pageFlowRestored: LP_DIAG_UNKNOWN,
      logicalPaginationReadiness: {
        ready: false,
        blockers: ['diagnostic-unavailable'],
        warnings: [why],
        notes: ['Chat Atlas LP0.1 diagnostics are read-only and failed closed.'],
      },
    };
  }

  // Chat Atlas LP0.1 readiness is observation only. This helper must never
  // call materialize, ensureVisible, restore, remount, replay, or persistence
  // APIs. It reads stable shells, public config snapshots, exposed state, and
  // the safety results already computed by titleIntentDebugSnapshot().
  function inspectLogicalPaginationReadiness(context = {}) {
    const blockers = [];
    const warnings = [];
    const notes = [
      'read-only: no DOM, storage, ledger, washer, MiniMap, Pagination, or Unmount mutation',
      'hydrationCoverageRatio is observational; partial native hydration is expected',
      'paginationPlaceholderCount counts Pagination window scaffold nodes (sentinel/view)',
    ];
    const normalizeId = (value) => String(value || '').replace(/^conversation-turn-/, '').trim();
    const ratio = (part, total) => total > 0
      ? Math.round((Math.min(total, Math.max(0, Number(part || 0))) / total) * 10000) / 10000
      : LP_DIAG_UNKNOWN;

    let stableShells = [];
    let hydratedRoleNodes = [];
    try {
      stableShells = Array.from(document.querySelectorAll('section[data-testid^="conversation-turn"]'));
      hydratedRoleNodes = Array.from(document.querySelectorAll(
        'section[data-testid^="conversation-turn"][data-message-author-role], '
        + 'section[data-testid^="conversation-turn"] [data-message-author-role]',
      ));
    } catch {
      warnings.push('stable-shell-dom-scan-failed');
    }

    const runtime = TURN_RUNTIME();
    let runtimeRecords = null;
    try {
      const value = runtime?.listTurnRecords?.();
      if (Array.isArray(value)) runtimeRecords = value;
    } catch {
      warnings.push('turn-runtime-read-failed');
    }
    const turnRuntimeRecordCount = Array.isArray(runtimeRecords)
      ? runtimeRecords.length
      : LP_DIAG_UNKNOWN;

    const logicalMembers = [];
    const turnNos = new Map();
    const turnIds = new Map();
    const answerIds = new Map();
    const canonicalIds = new Set();
    const matchedShellsFromLiveRecords = new Set();
    const duplicateLogicalMembers = [];
    for (const record of Array.isArray(runtimeRecords) ? runtimeRecords : []) {
      const turnNo = Math.max(0, Number(record?.turnNo || record?.idx || 0) || 0);
      const turnId = normalizeId(record?.turnId || record?.id);
      const primaryAId = normalizeId(
        record?.primaryAId
        || record?.answerId
        || record?.aId
        || (Array.isArray(record?.answerIds) ? record.answerIds[0] : ''),
      );
      const qId = normalizeId(record?.qId || record?.questionId);
      if (turnNo) logicalMembers.push({ turnNo, turnId, primaryAId, qId });

      const registerDuplicate = (map, kind, value) => {
        if (!value) return;
        if (map.has(value)) {
          duplicateLogicalMembers.push({ kind, value, turnNos: [map.get(value), turnNo].filter(Boolean) });
        } else {
          map.set(value, turnNo);
        }
      };
      registerDuplicate(turnNos, 'turnNo', turnNo ? String(turnNo) : '');
      registerDuplicate(turnIds, 'turnId', turnId);
      registerDuplicate(answerIds, 'primaryAnswerId', primaryAId);

      for (const value of [
        turnId,
        qId,
        primaryAId,
        ...(Array.isArray(record?.answerIds) ? record.answerIds : []),
        ...(Array.isArray(record?._aliasIds) ? record._aliasIds : []),
      ]) {
        const id = normalizeId(value);
        if (id) canonicalIds.add(id);
      }
      for (const liveEl of [
        record?.live?.qEl,
        record?.live?.primaryAEl,
        ...(Array.isArray(record?.live?.answerEls) ? record.live.answerEls : []),
      ]) {
        try {
          const shell = liveEl?.closest?.('section[data-testid^="conversation-turn"]') || null;
          if (shell) matchedShellsFromLiveRecords.add(shell);
        } catch {}
      }
    }

    const seenTurnNos = new Set(logicalMembers.map((member) => member.turnNo).filter(Boolean));
    const maxTurnNo = seenTurnNos.size ? Math.max(...seenTurnNos) : 0;
    const missingLogicalMembers = [];
    for (let turnNo = 1; turnNo <= maxTurnNo; turnNo += 1) {
      if (!seenTurnNos.has(turnNo)) missingLogicalMembers.push(turnNo);
    }
    const pageGapMap = new Map();
    for (const turnNo of missingLogicalMembers) {
      const page = Math.ceil(turnNo / 25);
      const list = pageGapMap.get(page) || [];
      list.push(turnNo);
      pageGapMap.set(page, list);
    }
    const pageMembershipGaps = Array.from(pageGapMap.entries())
      .map(([page, missingTurnNos]) => ({ page, missingTurnNos }));

    const shellIds = (shell) => {
      const ids = new Set();
      const add = (value) => {
        const id = normalizeId(value);
        if (id) ids.add(id);
      };
      try {
        add(shell?.getAttribute?.('data-turn-id'));
        add(shell?.getAttribute?.('data-message-id'));
        add(shell?.getAttribute?.('data-testid'));
        for (const roleNode of shell?.querySelectorAll?.('[data-message-author-role]') || []) {
          add(roleNode.getAttribute?.('data-turn-id'));
          add(roleNode.getAttribute?.('data-message-id'));
          add(roleNode.getAttribute?.('data-testid'));
          add(roleNode.id);
        }
      } catch {}
      return Array.from(ids);
    };
    const unknownOrUnpairedShells = [];
    let matchedStableShellCount = 0;
    for (const shell of stableShells) {
      const ids = shellIds(shell);
      const matched = matchedShellsFromLiveRecords.has(shell) || ids.some((id) => canonicalIds.has(id));
      if (matched) {
        matchedStableShellCount += 1;
        continue;
      }
      unknownOrUnpairedShells.push({
        testid: String(shell?.getAttribute?.('data-testid') || ''),
        turn: String(shell?.getAttribute?.('data-turn') || ''),
        ids,
        hydratedRoleNodes: Number(shell?.querySelectorAll?.('[data-message-author-role]')?.length || 0),
      });
    }

    let paginationState = null;
    try {
      paginationState = TOPW.H2O?.PW?.pgnwndw?.state || TOPW.H2O_Pagination?.state || null;
    } catch {}
    let paginationCanonicalCount = LP_DIAG_UNKNOWN;
    let paginationCanonicalSource = '';
    for (const key of ['masterTurnUnits', 'canonicalTurns', 'turnUnits']) {
      const value = paginationState?.[key];
      if (!Array.isArray(value)) continue;
      paginationCanonicalCount = value.length;
      paginationCanonicalSource = key;
      break;
    }
    if (paginationCanonicalCount === LP_DIAG_UNKNOWN) warnings.push('pagination-canonical-count-unknown');
    else notes.push(`paginationCanonicalCount source: ${paginationCanonicalSource}`);

    let paginationEnabled = LP_DIAG_UNKNOWN;
    try {
      const cfg = TOPW.H2O_Pagination?.getConfig?.() || paginationState?.config || null;
      if (typeof cfg?.enabled === 'boolean') paginationEnabled = cfg.enabled;
    } catch {
      warnings.push('pagination-config-read-failed');
    }
    if (paginationEnabled === LP_DIAG_UNKNOWN) warnings.push('pagination-enabled-unknown');

    let unmountEnabled = LP_DIAG_UNKNOWN;
    try {
      const cfg = UM_PUBLIC()?.getConfig?.() || null;
      if (typeof cfg?.enabled === 'boolean') unmountEnabled = cfg.enabled;
    } catch {
      warnings.push('unmount-config-read-failed');
    }
    if (unmountEnabled === LP_DIAG_UNKNOWN) warnings.push('unmount-enabled-unknown');

    const detachedHostCount = 0;

    let paginationPlaceholderCount = LP_DIAG_UNKNOWN;
    let unmountPlaceholderCount = LP_DIAG_UNKNOWN;
    try {
      paginationPlaceholderCount = new Set(document.querySelectorAll(
        '.cgxui-pgnw-sentinel, .cgxui-pgnw-view, [data-cgxui-owner="pgnw"][data-cgxui-id^="pagination-"]',
      )).size;
      unmountPlaceholderCount = new Set(document.querySelectorAll(
        '.cgxui-unmounted-placeholder, .cgxui-nmms-ph[data-cgxui-owner="nmms"]',
      )).size;
    } catch {
      warnings.push('physical-placeholder-dom-scan-failed');
    }

    let fragmentCacheCount = LP_DIAG_UNKNOWN;
    try {
      const umState = TOPW.H2O?.UM?.nmntmssgs?.state || null;
      if (umState?.unmountMap instanceof Map || umState?.manualCollapseById instanceof Map) {
        const fragments = new Set();
        for (const record of umState?.unmountMap?.values?.() || []) {
          if (record?.frag) fragments.add(record.frag);
          if (record?.bodyFrag) fragments.add(record.bodyFrag);
        }
        for (const record of umState?.manualCollapseById?.values?.() || []) {
          if (record?.frag) fragments.add(record.frag);
          if (record?.bodyFrag) fragments.add(record.bodyFrag);
        }
        fragmentCacheCount = fragments.size;
      }
    } catch {
      warnings.push('fragment-cache-read-failed');
    }
    if (fragmentCacheCount === LP_DIAG_UNKNOWN) warnings.push('fragment-cache-count-unknown');

    let detachCommentCount = LP_DIAG_UNKNOWN;
    try {
      detachCommentCount = 0;
      const walker = document.createTreeWalker(
        document.body || document.documentElement,
        W.NodeFilter?.SHOW_COMMENT || 128,
      );
      let comment = walker.nextNode();
      while (comment) {
        if (String(comment.nodeValue || '').startsWith('cgxui-chat-page-detached:')) detachCommentCount += 1;
        comment = walker.nextNode();
      }
    } catch {
      warnings.push('detach-comment-count-unknown');
    }

    const physicalCounts = [
      detachedHostCount,
      paginationPlaceholderCount,
      unmountPlaceholderCount,
      fragmentCacheCount,
      detachCommentCount,
    ];
    const hasKnownPhysicalResidue = physicalCounts.some((value) => typeof value === 'number' && value > 0);
    const hasUnknownPhysicalResidue = physicalCounts.some((value) => value === LP_DIAG_UNKNOWN);
    let stalePhysicalResiduePresent = false;
    if ((paginationEnabled === false && Number(paginationPlaceholderCount || 0) > 0)
      || (unmountEnabled === false && (Number(unmountPlaceholderCount || 0) > 0 || Number(fragmentCacheCount || 0) > 0))
      || (context?.pageFlowRestored === true && (Number(detachedHostCount || 0) > 0 || Number(detachCommentCount || 0) > 0))) {
      stalePhysicalResiduePresent = true;
    } else if (hasUnknownPhysicalResidue && hasKnownPhysicalResidue) {
      stalePhysicalResiduePresent = LP_DIAG_UNKNOWN;
    }

    let physicalOptimizersInert = LP_DIAG_UNKNOWN;
    if (typeof paginationEnabled === 'boolean' && typeof unmountEnabled === 'boolean' && !hasUnknownPhysicalResidue) {
      physicalOptimizersInert = paginationEnabled === false
        && unmountEnabled === false
        && hasKnownPhysicalResidue === false;
    }

    const logicalPageMemberCount = new Set(logicalMembers.map((member) => member.turnNo)).size;
    const logicalPageCount = maxTurnNo ? Math.ceil(maxTurnNo / 25) : 0;
    const shellCoverageRatio = ratio(matchedStableShellCount, stableShells.length);
    const hydrationCoverageRatio = ratio(hydratedRoleNodes.length, stableShells.length);
    const paginationCoverageShortfall = typeof paginationCanonicalCount === 'number'
      && logicalPageMemberCount < paginationCanonicalCount;
    const logicalCanonicalReady = stableShells.length > 0
      && Array.isArray(runtimeRecords)
      && logicalPageMemberCount > 0
      && missingLogicalMembers.length === 0
      && duplicateLogicalMembers.length === 0
      && unknownOrUnpairedShells.length === 0
      && !paginationCoverageShortfall;

    if (!stableShells.length) blockers.push('stable-shells-not-detected');
    if (!Array.isArray(runtimeRecords)) blockers.push('turn-runtime-unavailable');
    else if (!runtimeRecords.length) blockers.push('turn-runtime-empty');
    if (missingLogicalMembers.length) blockers.push('missing-logical-members');
    if (unknownOrUnpairedShells.length) blockers.push('unknown-or-unpaired-shells');
    if (duplicateLogicalMembers.length) blockers.push('duplicate-logical-members');
    if (paginationCoverageShortfall) blockers.push('pagination-canonical-exceeds-logical-membership');
    if (paginationEnabled === true) blockers.push('pagination-enabled');
    if (unmountEnabled === true) blockers.push('unmount-enabled');
    if (paginationEnabled === LP_DIAG_UNKNOWN || unmountEnabled === LP_DIAG_UNKNOWN) blockers.push('physical-optimizer-state-unknown');
    if (stalePhysicalResiduePresent === true) blockers.push('stale-physical-residue');
    if (context?.duplicateTitleBarsVisible === true) blockers.push('duplicate-title-bars-visible');
    if (Array.isArray(context?.titleMismatches) && context.titleMismatches.length) blockers.push('title-mismatches');
    if (context?.noAnswerRowsStable === false) blockers.push('no-answer-rows-unstable');
    if (context?.pageFlowRestored === false) blockers.push('page-flow-not-restored');
    if (hydrationCoverageRatio !== LP_DIAG_UNKNOWN && hydrationCoverageRatio < 1) {
      notes.push('partial native hydration observed; this is expected and is not a readiness blocker by itself');
    }
    if (detachedHostCount > 0) warnings.push('detached-page-hosts-present');
    if (fragmentCacheCount > 0) warnings.push('unmount-fragment-caches-present');

    return {
      stableShellCount: stableShells.length,
      hydratedRoleNodeCount: hydratedRoleNodes.length,
      turnRuntimeRecordCount,
      paginationCanonicalCount,
      logicalPageMemberCount,
      logicalPageCount,
      logicalCanonicalReady,
      shellCoverageRatio,
      hydrationCoverageRatio,
      missingLogicalMembers,
      unknownOrUnpairedShells,
      pageMembershipGaps,
      duplicateLogicalMembers,
      paginationEnabled,
      unmountEnabled,
      physicalOptimizersInert,
      detachedHostCount,
      paginationPlaceholderCount,
      unmountPlaceholderCount,
      fragmentCacheCount,
      detachCommentCount,
      stalePhysicalResiduePresent,
      titleListActive: context?.titleListActive === true,
      duplicateTitleBarsVisible: context?.duplicateTitleBarsVisible === true,
      titleMismatches: Array.isArray(context?.titleMismatches) ? context.titleMismatches : [],
      noAnswerRowsStable: context?.noAnswerRowsStable ?? LP_DIAG_UNKNOWN,
      pageFlowRestored: context?.pageFlowRestored ?? LP_DIAG_UNKNOWN,
      logicalPaginationReadiness: {
        ready: logicalCanonicalReady === true
          && physicalOptimizersInert === true
          && stalePhysicalResiduePresent === false
          && blockers.length === 0,
        blockers: Array.from(new Set(blockers)),
        warnings: Array.from(new Set(warnings)),
        notes: Array.from(new Set(notes)),
      },
    };
  }

  function titleIntentDebugSnapshot(opts = {}) {
    const chatId = String(opts?.chatId || resolveChatId()).trim();
    const pageNum = Math.max(1, Number(opts?.page || opts?.pageNum || 1) || 1);
    const ledger = readTitleIntentLedger(chatId);
    // Read-only page inventory: canonical turn-list math + ledger pages +
    // already-rendered divider attrs. No getSections/getRows row building.
    const availableSet = new Set();
    try {
      const list = MM_CORE_API()?.getTurnList?.() || [];
      const pageCount = Array.isArray(list) && list.length ? Math.ceil(list.length / 25) : 0;
      for (let p = 1; p <= pageCount; p += 1) availableSet.add(p);
    } catch {}
    for (const key of Object.keys(ledger.pages || {})) {
      const p = Math.max(0, Number(key || 0) || 0);
      if (p) availableSet.add(p);
    }
    try {
      for (const divider of Array.from(document.querySelectorAll('.cgxui-chat-page-divider[data-page-num], .cgxui-pgnw-page-divider[data-page-num]'))) {
        const p = Math.max(0, Number(divider.getAttribute('data-page-num') || 0) || 0);
        if (p) availableSet.add(p);
      }
    } catch {}
    const availablePages = Array.from(availableSet).sort((a, b) => a - b);
    const activeIntentCount = countActiveTitleIntentPages(ledger);
    const activeOverrideCount = countActiveTitleIntentOverrides(ledger);
    const isIntentSystemInert = activeIntentCount <= 0 && activeOverrideCount <= 0;
    const members = normalizeAnswerIds(pureCanonicalPageMembers(pageNum));
    const pageIntent = ledger.pages[String(pageNum)] || null;
    const pageHasIntent = Number(pageIntent?.rev || 0) > 0;
    const at = AT_PUBLIC();
    const pageExists = availablePages.includes(pageNum) || members.length > 0 || pageHasIntent;
    let reasonIfNoMembers = '';
    if (!members.length) {
      if (!pageExists) reasonIfNoMembers = 'page-not-found';
      else if (pageHasIntent) reasonIfNoMembers = 'page-has-intent-but-no-canonical-members';
      else reasonIfNoMembers = 'no-canonical-members-detected';
    }
    const hydratedMembers = [];
    const unhydratedMembers = [];
    const memberDetails = [];
    let obeyCount = 0;

    for (const answerId of members) {
      const desired = resolveDesiredTitleState(answerId, { chatId, page: pageNum, ledger });
      const msgEl = at?.getMessageEl?.(answerId) || null;
      const bar = at?.getBar?.(answerId) || null;
      const hydrated = !!(msgEl && bar);
      const actualState = hydrated ? getHydratedTitleActualState(msgEl, bar) : null;
      const rect = bar?.getBoundingClientRect?.();
      const visible = !!(rect && rect.width > 0 && rect.height > 0);
      const attrs = hydrated ? {
        desired: bar.getAttribute?.('data-h2o-title-desired') || '',
        source: bar.getAttribute?.('data-h2o-title-state-source') || '',
        rev: Number(bar.getAttribute?.('data-h2o-title-rev') || 0) || 0,
        page: bar.getAttribute?.('data-h2o-title-page') || '',
        hydrated: bar.getAttribute?.('data-h2o-title-hydrated') || '',
      } : null;
      const detail = {
        answerId,
        desired,
        hydrated,
        visible,
        actualState,
        obeysResolver: !hydrated || actualState === desired.state,
        appliedAttrs: attrs,
      };
      if (detail.obeysResolver) obeyCount += 1;
      if (hydrated) hydratedMembers.push(answerId);
      else unhydratedMembers.push(answerId);
      memberDetails.push(detail);
    }

    const manualOverrides = Object.entries(ledger.overrides || {})
      .filter(([answerId, entry]) => members.includes(answerId) || Number(entry?.page || 0) === pageNum)
      .map(([answerId, entry]) => ({ answerId, state: entry.state, rev: entry.rev, page: entry.page, source: entry.source }));
    const pageRev = Math.max(0, Number(pageIntent?.rev || 0) || 0);
    const staleManualWinning = manualOverrides.some((entry) => Number(entry.rev || 0) <= pageRev
      && memberDetails.some((m) => m.answerId === entry.answerId && m.desired.source === 'manual'));
    const counters = getTitleIntentStats();

    // Mechanism route snapshot (read-only): proves which backend the circle /
    // title-bar / dblclick gestures actually route through right now.
    let mechanismRoutes = null;
    try {
      const cfg = CM_ROUTER_API()?.getConfig?.() || null;
      const routes = getConfiguredDividerRoutes();
      mechanismRoutes = {
        masterRoute: String(cfg?.gestureBackend || 'legacy'),
        titleBarRoute: routes.titleBarRoute,
        pageDividerCircleRoute: routes.dividerDotRoute,
        pageDividerDblClickRoute: routes.dividerDblClickRoute,
      };
    } catch {}
    const activeIntentPages = Object.entries(ledger.pages || {})
      .filter(([, entry]) => Number(entry?.rev || 0) > 0)
      .map(([key, entry]) => ({ page: Number(key), state: entry.state, rev: entry.rev, source: entry.source }));
    const activeOverrideAnswerIds = Object.entries(ledger.overrides || {})
      .filter(([, entry]) => Number(entry?.rev || 0) > 0)
      .map(([answerId]) => answerId);
    const activeIntentSource = activeIntentPages.map((entry) => entry.source);
    // No code path converts legacy v1 sets into v2 intents; intents can only
    // carry gesture sources ('chat-page-divider:circle' / 'answer-title').
    const createdFromLegacyTitleList = activeIntentSource.some((s) => /legacy|migrat/i.test(String(s || '')));
    const createdOnChatOpen = activeIntentPages.length > 0 && Number(counters.localStorageWrites || 0) > 0
      ? 'writes-happened-this-session-check-sources'
      : false;
    // Read-only peek at legacy v1 keys for this chat (getItem only, no writes).
    let legacyRelevantKeys = null;
    try {
      legacyRelevantKeys = {
        titleListV1: { key: keyTitleListPages(chatId), value: storageGetRaw(keyTitleListPages(chatId)) },
        collapsedV1: { key: keyCollapsedPages(chatId), value: storageGetRaw(keyCollapsedPages(chatId)) },
      };
    } catch {}
    const pageScopedGateResult = titleIntentPageHasActiveState(pageNum, ledger);
    const titleListActive = isTitleListActive(pageNum, chatId);
    const memberDetailsAll = pureCanonicalPageMemberDetails(pageNum);
    const expectedAnswerMemberCount = memberDetailsAll.filter((m) => m.type === 'answer').length;
    const expectedNoAnswerMemberCount = memberDetailsAll.filter((m) => m.type !== 'answer').length;
    const expectedTitleRowCount = memberDetailsAll.length;
    const synthContainers = getSyntheticTitleListContainers(pageNum);
    const synthContainer = getSyntheticTitleListContainer(pageNum, chatId);
    const suffixContainers = getTitleListSuffixContainers(pageNum, chatId);
    const titleProjectionContainers = [synthContainer, ...suffixContainers].filter(Boolean);
    const synthRows = titleProjectionContainers.flatMap((container) => (
      Array.from(container.children || []).filter((row) => row.matches?.('[data-h2o-stack-key]'))
    ));
    const stackStats = S.titleListStackStatsByKey.get(titleListStackRegistryKey(pageNum, chatId)) || {
      buildCount: 0,
      replaceCount: 0,
      reattachCount: 0,
      rowReplaceCount: 0,
      identityRekeyCount: 0,
      titleUpgradeCount: 0,
      titleDowngradePreventedCount: 0,
      mutationCount: 0,
      syncCount: 0,
      lastBuildReason: '',
      lastReplaceReason: '',
      lastReattachReason: '',
      lastSyncReason: '',
      lastStackMutationReason: '',
      firstListCreatedAt: 0,
      lastStackMutationAt: 0,
      lastListSettledAt: 0,
      stackRectBeforeOpen: null,
      stackRectAfterOpen: null,
      lastOpenedTurnNo: 0,
      activeStackId: '',
    };
    const titleListContainerIds = synthContainers.map((container, index) => (
      String(container.id || container.getAttribute('data-h2o-title-stack-id') || `anonymous-stack-${index + 1}`)
    ));
    const missingTitleRows = titleListActive
      ? memberDetailsAll.filter((member) => !synthRows.some((row) => stackRowMatchesMember(row, member)))
        .map((member) => ({ id: member.id, turnNo: member.turnNo, type: member.type }))
      : [];
    const titleNumbersInStack = synthRows
      .map((row) => Number(row.getAttribute('data-h2o-stack-turn-no') || 0) || 0)
      .filter(Boolean);
    const missingTitleNumbers = titleListActive
      ? memberDetailsAll.map((m) => m.turnNo).filter((n) => !titleNumbersInStack.includes(n))
      : [];
    // Duplicate / in-flow leak accounting is page-member scoped. Stacked bars
    // are classified by location, not merely by attrs, so the snapshot cannot
    // count the canonical rehosted instance as its own flow duplicate.
    const isVisibleEl = (el) => {
      try {
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        return !!(r && r.width > 0 && r.height > 0
          && cs.display !== 'none' && cs.visibility !== 'hidden'
          && Number.parseFloat(cs.opacity || '1') > 0);
      } catch { return false; }
    };
    const titleBarStrictlyMatchesMember = (bar = null, member = null) => {
      if (!bar || !member) return false;
      const barId = titleBarMemberId(bar);
      if (!barId) return false;
      if (member.type !== 'answer') {
        return barId === member.id || barId === member.questionId;
      }
      if (bar.hasAttribute?.('data-at-no-answer')) return false;
      const family = new Set(titleListAnswerFamilyIds(member));
      if (family.has(barId)) return true;
      const barRecord = turnRecordForTitleListIdentity(barId);
      for (const value of [
        barRecord?.primaryAId,
        barRecord?.answerId,
        barRecord?.turnId,
        ...(Array.isArray(barRecord?.answerIds) ? barRecord.answerIds : []),
        ...(Array.isArray(barRecord?._aliasIds) ? barRecord._aliasIds : []),
      ]) {
        if (family.has(String(value || '').trim())) return true;
      }
      return false;
    };
    const canonicalFlowOwnerByBar = new Map();
    try {
      for (const member of memberDetailsAll) {
        const memberSections = titleListMemberSections(member);
        for (const anchor of memberAllFlowAnchors(member)) {
          for (const bar of Array.from(anchor.querySelectorAll?.('[data-cgxui="atns-answer-title"][data-cgxui-owner="atns"]') || [])) {
            // Some native reserved-height wrapper chains have only one direct
            // child and make getTurnAnchorNode climb above a single Q+A pair.
            // An anchor is therefore only a search boundary, never ownership
            // proof. Require canonical bar identity or the exact member turn
            // section before assigning it; otherwise TITLE 33–35 can be
            // falsely grouped under visible PAGE 1 members.
            const barSection = getTurnSectionForNode(bar);
            const inExactMemberSection = member.type === 'answer'
              ? barSection === memberSections.answerSection || barSection === memberSections.questionSection
              : barSection === memberSections.questionSection;
            const hasIdentity = !!titleBarMemberId(bar);
            const staleNoAnswerInPairedQuestion = member.type === 'answer'
              && bar.hasAttribute?.('data-at-no-answer')
              && barSection === memberSections.questionSection;
            if (hasIdentity
              ? !titleBarStrictlyMatchesMember(bar, member) && !staleNoAnswerInPairedQuestion
              : !inExactMemberSection) continue;
            canonicalFlowOwnerByBar.set(bar, member.id);
          }
        }
      }
    } catch {}
    const canonicalMemberForBar = (bar = null) => {
      if (!bar) return null;
      const flowOwnerId = canonicalFlowOwnerByBar.get(bar) || '';
      if (flowOwnerId) {
        const flowOwner = memberDetailsAll.find((member) => member.id === flowOwnerId) || null;
        if (flowOwner) return flowOwner;
      }
      const inAnyStack = !!bar.closest?.(`${TITLE_LIST_SYNTH_SEL}, ${TITLE_LIST_SUFFIX_SEL}`);
      return memberDetailsAll.find((member) => (
        inAnyStack ? stackRowMatchesMember(bar, member) : titleBarStrictlyMatchesMember(bar, member)
      )) || null;
    };
    const visibleBarsByMember = new Map();
    const stackedVisibleBars = [];
    const inFlowVisibleBars = [];
    const titleBarClassifications = [];
    let duplicateTitleBarsVisible = false;
    let inFlowTitleBarsVisibleWhileStackActive = 0;
    try {
      for (const bar of Array.from(document.querySelectorAll('[data-cgxui="atns-answer-title"]'))) {
        const member = canonicalMemberForBar(bar);
        const memberId = String(member?.id || '');
        if (!memberId) continue;
        const visible = isVisibleEl(bar);
        const inThisStack = !!(titleProjectionContainers.includes(
          bar.closest?.(`${TITLE_LIST_SYNTH_SEL}, ${TITLE_LIST_SUFFIX_SEL}`)
        )
          && bar.getAttribute('data-h2o-in-title-stack') === String(pageNum));
        titleBarClassifications.push({
          memberId,
          turnNo: Number(bar.getAttribute('data-h2o-stack-turn-no') || bar.getAttribute('data-h2o-turn-num') || 0) || 0,
          location: inThisStack ? (visible ? 'inStack' : 'hiddenStack') : (visible ? 'inFlow' : 'hiddenFlow'),
          visible,
          inStack: inThisStack,
          detached: bar.getAttribute('data-h2o-detached-title-bar') === '1',
          washer: String(bar.getAttribute('data-h2o-title-wash') || ''),
        });
        if (!visible) continue;
        const list = visibleBarsByMember.get(memberId) || [];
        list.push({ bar, inStack: inThisStack });
        visibleBarsByMember.set(memberId, list);
        if (inThisStack) stackedVisibleBars.push(bar);
        else inFlowVisibleBars.push(bar);
      }
      duplicateTitleBarsVisible = Array.from(visibleBarsByMember.values()).some((list) => list.length > 1);
      inFlowTitleBarsVisibleWhileStackActive = titleListActive ? inFlowVisibleBars.length : 0;
    } catch {}

    // Residual-hide audit (Phase 4b acceptance). When the title-list is NOT
    // active and the page is not lightening-collapsed, no current-page member
    // wrapper/section may still carry a title-list / answer-collapse hide
    // marker. Circle/dot expand must leave the page visually normal; a
    // lingering data-cgxui-at-hidden (the engine's own marker) or a
    // question/title-list hide stamp keeps a turn invisible via CSS even
    // though the collapse ledger reads clean. The active-state pass fields did
    // not cover this, so an incomplete expand could falsely pass. Page-collapse
    // markers (data-cgxui-chat-page-hidden / -wrapper-hidden) are deliberately
    // excluded: those belong to the separate page-lightening mechanism.
    const RESIDUAL_HIDE_MARKERS = [
      'data-cgxui-at-hidden',
      'data-at-question-hidden',
      ATTR_CHAT_PAGE_QUESTION_HIDDEN,
      ATTR_CHAT_PAGE_NO_ANSWER_QUESTION_HIDDEN,
      ATTR_TITLE_LIST_FLOW_HIDDEN,
    ];
    const RESIDUAL_HIDE_SEL = RESIDUAL_HIDE_MARKERS.map((a) => `[${a}]`).join(',');
    const residualHiddenFlowMembers = [];
    let pageLightenCollapsed = false;
    try { pageLightenCollapsed = isPageCollapsed(pageNum, chatId); } catch {}
    if (!titleListActive && !pageLightenCollapsed) {
      const markerAttrsOf = (el) => {
        const hit = [];
        if (!el?.getAttribute) return hit;
        for (const attr of RESIDUAL_HIDE_MARKERS) {
          const v = el.getAttribute(attr);
          if (v != null && String(v).trim() && String(v).trim() !== '0') hit.push(attr);
        }
        return hit;
      };
      // Per-node evidence: report the EXACT element carrying each marker so a
      // member-level flag can never be ambiguous about which DOM node (own
      // section vs a descendant sibling/toolbar vs an anchor wrapper) is
      // responsible.
      const residualNodeDetail = (el, attrsHit) => {
        let rectHeight = 0; let display = '';
        try { rectHeight = Math.round(el.getBoundingClientRect?.().height || 0); } catch {}
        try { display = getComputedStyle(el).display; } catch {}
        const section = el.closest?.('section[data-testid^="conversation-turn"]') || null;
        return {
          markers: attrsHit,
          testid: String(el.getAttribute?.('data-testid') || section?.getAttribute?.('data-testid') || ''),
          selfIsSection: el === section,
          tag: String(el.tagName || ''),
          role: String(el.getAttribute?.('data-turn') || el.getAttribute?.('data-message-author-role') || ''),
          display,
          inlineDisplay: String(el.style?.display || ''),
          rectHeight,
          text: String(el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 60),
        };
      };
      for (const member of memberDetailsAll) {
        const scopes = new Set();
        for (const anchor of memberAllFlowAnchors(member)) if (anchor) scopes.add(anchor);
        const secs = titleListMemberSections(member);
        if (secs.answerSection) scopes.add(secs.answerSection);
        if (secs.questionSection) scopes.add(secs.questionSection);
        const markers = new Set();
        const nodes = [];
        const seenNodes = new Set();
        for (const scope of scopes) {
          try {
            const candidates = new Set([scope]);
            for (const inner of scope.querySelectorAll?.(RESIDUAL_HIDE_SEL) || []) candidates.add(inner);
            for (const el of candidates) {
              if (seenNodes.has(el)) continue;
              seenNodes.add(el);
              const hit = markerAttrsOf(el);
              if (!hit.length) continue;
              for (const attr of hit) markers.add(attr);
              if (nodes.length < 6) nodes.push(residualNodeDetail(el, hit));
            }
          } catch {}
        }
        if (markers.size) {
          residualHiddenFlowMembers.push({
            id: member.id,
            turnNo: member.turnNo,
            type: member.type,
            markers: Array.from(markers),
            nodes,
          });
        }
      }
    }
    // Strong post-expand proof: marker absence is necessary but insufficient.
    // Inspect every canonical member through the title-bar owner and canonical
    // question/answer sections so a collapsed bar token or markerless zero-
    // height body fails even when residualHiddenFlowMembers is empty.
    const expandedPageFlowAudit = (!titleListActive && !pageLightenCollapsed)
      ? auditExpandedPageFlow(pageNum, chatId)
      : {
          pageFlowRestored: 'notApplicable',
          allPageMembersExpandedAfterDotExpand: 'notApplicable',
          residualCollapsedFlowMembers: [],
          residualCollapsedFlowMemberCount: 0,
          pageMemberExpandedStateFailures: [],
          members: [],
        };
    const dotExpandCampaign = S.dotExpandCampaigns.get(dotExpandCampaignKey(pageNum, chatId)) || null;
    const dotExpandConvergence = dotExpandCampaign ? {
      token: dotExpandCampaign.token,
      startedAt: dotExpandCampaign.startedAt,
      completedAt: dotExpandCampaign.completedAt,
      runs: dotExpandCampaign.runs,
      pending: !!dotExpandCampaign.timer,
      lastStatus: String(dotExpandCampaign.lastResult?.status || ''),
      lastResidualCollapsedFlowMemberCount: Number(dotExpandCampaign.lastResult?.residualCollapsedFlowMemberCount || 0),
      lastPageFlowRestored: dotExpandCampaign.lastResult?.pageFlowRestored === true,
    } : null;
    // Divider/list order proof (read-only).
    let pageDividerEl = null;
    try {
      pageDividerEl = document.querySelector(`.cgxui-chat-page-divider[data-page-num="${String(pageNum)}"], .cgxui-pgnw-page-divider[data-page-num="${String(pageNum)}"]`);
    } catch {}
    const dividerBeforeSyntheticList = (pageDividerEl && synthContainer)
      ? !!(pageDividerEl.compareDocumentPosition(synthContainer) & Node.DOCUMENT_POSITION_FOLLOWING)
      : (synthContainer ? false : 'notApplicable');
    const syntheticListAnchor = (synthContainer && synthContainer.previousElementSibling === pageDividerEl)
      ? 'after-chat-page-divider'
      : (synthContainer ? 'detached-from-divider' : 'none');
    const titleListTransaction = S.atomicPageCollapseTransactions.get(
      collapsedNativeRangeKey(chatId, pageNum)
    ) || null;
    const diagnosticOpenState = S.titleListOpenStatesByKey.get(
      titleListOpenStateKey(pageNum, chatId)
    ) || null;
    const diagnosticOpenMemberId = titleListOpenStateCurrent(titleListTransaction, diagnosticOpenState)
      ? String(diagnosticOpenState.canonicalId || '')
      : '';
    // NO ANSWER flow accounting (read-only rect checks). Count both a leaked
    // title bar and leaked orphan/Q content: a flow wrapper can remain visible
    // even after its title bar was correctly rehosted into the stack.
    let visibleInFlowNoAnswerRows = 0;
    try {
      for (const bar of Array.from(document.querySelectorAll(NO_ANSWER_TITLE_BAR_SEL))) {
        const member = canonicalMemberForBar(bar);
        if (!member || member.type === 'answer') continue;
        const inThisStack = titleProjectionContainers.includes(
          bar.closest?.(`${TITLE_LIST_SYNTH_SEL}, ${TITLE_LIST_SUFFIX_SEL}`)
        );
        if (!inThisStack && isVisibleEl(bar)) visibleInFlowNoAnswerRows += 1;
      }
    } catch {}
    const orphanQuestionFlowDetails = memberDetailsAll.flatMap((member) => {
      if (member.type === 'answer') return [];
      if (String(member.id || '') === diagnosticOpenMemberId) return [];
      return memberAllFlowAnchors(member).flatMap((anchor) => {
        const inStack = !!anchor.closest?.(`${TITLE_LIST_SYNTH_SEL}, ${TITLE_LIST_SUFFIX_SEL}`);
        const visible = isVisibleEl(anchor);
        if (inStack || !visible) return [];
        const underList = !!(synthContainer
          && (synthContainer.compareDocumentPosition(anchor) & Node.DOCUMENT_POSITION_FOLLOWING));
        return [{
          id: member.id,
          questionId: member.questionId,
          turnNo: member.turnNo,
          anchor,
          underList,
          hasHideStamp: anchor.hasAttribute?.(ATTR_TITLE_LIST_FLOW_HIDDEN) || false,
          rect: titleListRectSnapshot(anchor),
        }];
      });
    });
    const visibleInFlowNoAnswerMembers = Array.from(new Map(
      orphanQuestionFlowDetails.map((entry) => [entry.id, entry])
    ).values());
    const orphanQuestionFlowVisible = visibleInFlowNoAnswerMembers.length;
    const orphanQuestionVisibleUnderList = visibleInFlowNoAnswerMembers.some((entry) => entry.underList);
    const noAnswerInFlowVisible = Math.max(orphanQuestionFlowVisible, visibleInFlowNoAnswerRows);
    const noAnswerRowsHiddenBySyntheticList = memberDetailsAll.filter((m) => {
      if (m.type === 'answer') return false;
      const anchors = memberAllFlowAnchors(m).filter((anchor) => !anchor.closest?.(TITLE_LIST_SYNTH_SEL));
      return anchors.length > 0 && anchors.every((anchor) => !isVisibleEl(anchor));
    }).length;
    const listedNoAnswerRows = synthRows.filter((row) => row.getAttribute('data-h2o-stack-type') === 'no-answer').length;
    // Title quality accounting.
    const rowSourceOf = (row) => String(row?.getAttribute?.('data-h2o-title-row-source') || '');
    const rowTitleOf = (row) => String(row?.querySelector?.('[data-cgxui="atns-answer-title-text"]')?.textContent || '').trim();
    const fallbackTitleRows = synthRows
      .filter((row) => row.getAttribute('data-h2o-stack-type') === 'answer'
        && (rowSourceOf(row) === 'fallback' || isSyntheticTitlePlaceholder(rowTitleOf(row))))
      .map((row) => ({
        turnNo: Number(row.getAttribute('data-h2o-stack-turn-no') || 0),
        id: row.getAttribute('data-h2o-stack-key'),
        text: rowTitleOf(row),
        source: rowSourceOf(row),
      }));
    const realTitleRows = synthRows.filter((row) => row.getAttribute('data-h2o-stack-type') === 'answer'
      && !isSyntheticTitlePlaceholder(rowTitleOf(row))
      && rowSourceOf(row) !== 'fallback').length;
    const rowsUsingFallbackDespiteKnownTitle = fallbackTitleRows.filter((entry) => {
      const member = memberDetailsAll.find((candidate) => candidate.turnNo === entry.turnNo && candidate.type === 'answer') || null;
      if (!member) return false;
      const resolved = resolveSyntheticRowTitle(member);
      return resolved.source !== 'fallback' && !isSyntheticTitlePlaceholder(resolved.text);
    });
    const openedStackRows = synthRows.filter((row) => row.getAttribute('data-h2o-title-row-opened') === '1');
    const manualOpenRows = openedStackRows.map((row) => ({
      id: row.getAttribute('data-h2o-stack-key'),
      turnNo: Number(row.getAttribute('data-h2o-stack-turn-no') || 0),
      type: row.getAttribute('data-h2o-stack-type') || 'answer',
      openedBy: row.getAttribute('data-h2o-title-row-opened-by') || '',
    }));
    const noAnswerAutoOpenedRows = manualOpenRows.filter((row) => row.type === 'no-answer' && row.openedBy !== 'dblclick');
    const noAnswerAutoOpened = noAnswerAutoOpenedRows.length > 0;
    const openedRowId = manualOpenRows[0]?.id || null;
    const titleRowSources = {
      hydratedTitleHits: synthRows.filter((row) => rowSourceOf(row) === 'hydrated').length,
      titleCacheHits: synthRows.filter((row) => rowSourceOf(row) === 'cached').length,
      metadataTitleHits: synthRows.filter((row) => rowSourceOf(row) === 'metadata').length,
      fallback: fallbackTitleRows.length,
      noAnswer: listedNoAnswerRows,
      hydrated: synthRows.filter((row) => row.getAttribute('data-h2o-title-row-hydrated') === '1').length,
      expandedByUser: manualOpenRows.length,
    };
    const titleFidelityRows = memberDetailsAll.flatMap((member) => {
      if (member.type !== 'answer') return [];
      const row = synthRows.find((candidate) => stackRowMatchesMember(candidate, member)) || null;
      const resolved = resolveSyntheticRowTitle(member);
      const displayedTitle = rowTitleOf(row);
      const expectedTitle = String(resolved?.text || '').trim();
      const comparable = !!(row && expectedTitle && resolved?.source !== 'fallback');
      return [{
        memberId: member.id,
        answerId: member.answerId,
        turnNo: member.turnNo,
        displayedTitle,
        expectedTitle,
        expectedSource: String(resolved?.source || ''),
        expectedSourceId: String(resolved?.answerId || ''),
        projectedSource: String(row?.getAttribute?.('data-h2o-title-row-source') || ''),
        projectedSourceId: String(row?.getAttribute?.('data-h2o-title-row-source-id') || ''),
        matches: comparable ? displayedTitle === expectedTitle : 'notApplicable',
      }];
    });
    const titleFidelityMismatches = titleFidelityRows.filter((entry) => entry.matches === false);
    const washMap = (() => {
      try {
        const viaApi = WASH_PUBLIC()?.getWashMap?.();
        if (viaApi && typeof viaApi === 'object') return viaApi;
        const direct = TOPW.H2O?.MM?.washMap;
        return direct && typeof direct === 'object' ? direct : {};
      } catch { return {}; }
    })();
    const washApi = WASH_PUBLIC();
    const canonicalExpectedMiniMapWashes = (() => {
      try {
        const viaApi = washApi?.getExpectedMiniMapWashes?.();
        if (Array.isArray(viaApi)) return viaApi;
      } catch {}
      return Object.entries(washMap || {}).flatMap(([rawId, rawName]) => {
        const colorName = String(rawName || '').trim().toLowerCase();
        if (!rawId || !colorName) return [];
        return [{ rawId, canonicalId: rawId, matchedId: rawId, colorName, turnNo: 0, source: 'snapshot-fallback' }];
      });
    })();
    const inspectMiniMapButton = (btn) => {
      const buttonId = String(btn.getAttribute('data-primary-a-id') || '').trim();
      let inspected = null;
      try { inspected = washApi?.inspectMiniBtn?.(buttonId, btn) || null; } catch {}
      if (!inspected) {
        const directColor = String(washMap?.[buttonId] || '').trim().toLowerCase();
        const actualWashed = btn.getAttribute('data-cgxui-wash') === '1' || btn.dataset?.wash === 'true';
        inspected = {
          requestedId: buttonId,
          buttonId,
          canonicalId: buttonId,
          matchedId: directColor ? buttonId : '',
          colorName: directColor || null,
          shouldWash: !!directColor,
          actualWashed,
          projectedWashId: String(btn.getAttribute('data-h2o-wash-id') || ''),
          projectedWashName: String(btn.getAttribute('data-h2o-wash-name') || ''),
          attrsMatch: actualWashed === !!directColor,
          visualMatches: !directColor,
          computedVisualWash: false,
          visualInspectionUnavailable: true,
          matchesExpected: actualWashed === !!directColor && !directColor,
        };
      }
      const mismatchReason = inspected.matchesExpected
        ? ''
        : inspected.actualWashed && !inspected.shouldWash
          ? 'unexpected-wash-on-unwashed-button'
          : !inspected.actualWashed && inspected.shouldWash
            ? 'missing-wash-on-washed-button'
            : inspected.attrsMatch === true && inspected.visualMatches === false
              ? inspected.visualInspectionUnavailable
                ? 'computed-visual-wash-inspection-unavailable'
                : inspected.selectedStyleMasksWash
                  ? 'attrs-present-but-selected-style-masks-wash'
                  : 'attrs-present-but-computed-visual-wash-missing'
              : 'wash-id-or-color-mismatch';
      return {
        turnNo: Math.max(0, Number(btn.dataset?.turnIdx || inspected.turnNo || 0) || 0),
        buttonId,
        canonicalId: String(inspected.canonicalId || ''),
        identityBasis: String(inspected.identityBasis || ''),
        matchedWashId: String(inspected.matchedId || ''),
        resolvedWash: String(inspected.colorName || ''),
        shouldWash: !!inspected.shouldWash,
        actualWashed: !!inspected.actualWashed,
        projectedWashId: String(inspected.projectedWashId || ''),
        projectedWashName: String(inspected.projectedWashName || ''),
        visibleButtonSelector: String(inspected.selector || ''),
        actualWashClasses: Array.isArray(inspected.actualWashClasses) ? inspected.actualWashClasses : [],
        cssVars: inspected.cssVars || {},
        computedStyle: inspected.computedStyle || {},
        expectedPaintBg: String(inspected.expectedPaintBg || ''),
        computedVisualWash: inspected.computedVisualWash === true,
        selectedOrCurrent: inspected.selectedOrCurrent === true,
        selectedStateTokens: String(inspected.selectedStateTokens || ''),
        selectedStyleMasksWash: inspected.selectedStyleMasksWash === true,
        attrsMatch: inspected.attrsMatch !== false,
        visualMatches: inspected.visualMatches !== false,
        matchesExpected: inspected.matchesExpected === true,
        mismatchReason,
      };
    };
    const miniMapWasherAudit = Array.from(document.querySelectorAll('[data-cgxui="mnmp-btn"]'))
      .map((btn) => inspectMiniMapButton(btn));
    for (const expected of canonicalExpectedMiniMapWashes) {
      const canonicalId = String(expected?.canonicalId || expected?.rawId || '').trim();
      if (!canonicalId) continue;
      const represented = miniMapWasherAudit.some((entry) => (
        entry.canonicalId === canonicalId
        || entry.buttonId === String(expected?.rawId || '')
      ));
      if (represented) continue;
      miniMapWasherAudit.push({
        turnNo: Math.max(0, Number(expected?.turnNo || 0) || 0),
        buttonId: '',
        canonicalId,
        matchedWashId: String(expected?.matchedId || expected?.rawId || ''),
        resolvedWash: String(expected?.colorName || ''),
        shouldWash: true,
        actualWashed: false,
        projectedWashId: '',
        projectedWashName: '',
        visibleButtonSelector: '',
        actualWashClasses: [],
        cssVars: {},
        computedStyle: {},
        expectedPaintBg: '',
        computedVisualWash: false,
        selectedOrCurrent: false,
        selectedStateTokens: '',
        selectedStyleMasksWash: false,
        attrsMatch: false,
        visualMatches: false,
        matchesExpected: false,
        mismatchReason: 'expected-washed-button-not-found',
        expectedSource: String(expected?.source || ''),
      });
    }
    const miniMapWasherMismatches = miniMapWasherAudit.filter((entry) => !entry.matchesExpected);
    const expectedWasherStates = memberDetailsAll.flatMap((member) => {
      if (member.type !== 'answer') return [];
      let resolved = null;
      try { resolved = washApi?.resolveForId?.(member.answerId) || null; } catch {}
      const fallbackColor = String(washMap?.[member.answerId] || '').trim().toLowerCase();
      const resolvedCanonicalId = String(resolved?.id || member.answerId || '').trim();
      const canonicalExpected = canonicalExpectedMiniMapWashes.find((entry) => (
        String(entry?.canonicalId || '') === resolvedCanonicalId
        || String(entry?.rawId || '') === String(member.answerId || '')
        || (Array.isArray(entry?.aliasRawIds)
          && entry.aliasRawIds.map((value) => String(value || '')).includes(String(member.answerId || '')))
      )) || null;
      const colorName = String(canonicalExpected?.colorName || resolved?.colorName || fallbackColor).trim().toLowerCase();
      return colorName ? [{
        memberId: member.id,
        answerId: member.answerId,
        turnNo: member.turnNo,
        colorName,
        canonicalId: String(canonicalExpected?.canonicalId || resolvedCanonicalId),
        matchedId: String(canonicalExpected?.matchedId || resolved?.matchedId || member.answerId || ''),
        candidateIds: Array.isArray(resolved?.candidateIds) ? resolved.candidateIds : [],
      }] : [];
    });
    const expectedWasherMemberIds = expectedWasherStates.map((entry) => entry.memberId);
    const washerTitleBarsInStack = synthRows.filter((row) => !!String(row.getAttribute('data-h2o-title-wash') || '').trim());
    const washerTitleBarsInFlowDuplicates = inFlowVisibleBars.filter((bar) => !!String(bar.getAttribute('data-h2o-title-wash') || '').trim());
    const goldTitleBarsInStack = washerTitleBarsInStack.filter((row) => String(row.getAttribute('data-h2o-title-wash') || '').toLowerCase() === 'gold');
    const goldTitleBarsInFlowDuplicates = washerTitleBarsInFlowDuplicates.filter((row) => String(row.getAttribute('data-h2o-title-wash') || '').toLowerCase() === 'gold');
    const activeFlashRowsInStack = synthRows.filter((row) => row.getAttribute('data-cgxui-flash') === '1'
      || Array.from(row.classList || []).some((cls) => /flash|active/i.test(String(cls || ''))));
    const washerProjectionComplete = expectedWasherStates.every((expected) => {
      const member = memberDetailsAll.find((candidate) => candidate.id === expected.memberId) || null;
      return !!(member && synthRows.some((row) => (
        stackRowMatchesMember(row, member)
        && String(row.getAttribute('data-h2o-title-wash') || '').trim().toLowerCase() === expected.colorName
      )));
    });
    const washerFidelityRows = expectedWasherStates.map((expected) => {
      const member = memberDetailsAll.find((candidate) => candidate.id === expected.memberId) || null;
      const row = member ? synthRows.find((candidate) => stackRowMatchesMember(candidate, member)) || null : null;
      const answerEl = (() => {
        try { return AT_PUBLIC()?.getMessageEl?.(expected.answerId) || titleListMemberSections(member).answerSection || null; } catch { return null; }
      })();
      const answerStyle = answerEl?.style || null;
      const flowWashName = String(
        answerEl?.getAttribute?.('data-h2o-wash-name')
          || Array.from(answerEl?.classList || []).find((name) => String(name).startsWith('cgxui-mnmp-wash-'))?.slice('cgxui-mnmp-wash-'.length)
          || ''
      ).trim().toLowerCase();
      const flowWashColor = String(answerStyle?.getPropertyValue?.('--h2o-at-wash-color') || answerStyle?.getPropertyValue?.('--h2o-band-color') || '').trim();
      const miniMapButtons = miniMapWasherAudit.filter((entry) => entry.canonicalId === expected.canonicalId);
      const miniMapProjected = miniMapButtons.some((entry) => (
        entry.shouldWash
        && entry.actualWashed
        && entry.matchedWashId === expected.matchedId
        && entry.resolvedWash === expected.colorName
      ));
      const miniMapWashed = miniMapButtons.some((entry) => (
        entry.shouldWash
        && entry.actualWashed
        && entry.computedVisualWash
        && entry.matchesExpected
        && entry.matchedWashId === expected.matchedId
        && entry.resolvedWash === expected.colorName
      ));
      return {
        ...expected,
        rowWash: String(row?.getAttribute?.('data-h2o-title-wash') || '').trim().toLowerCase(),
        rowWashId: String(row?.getAttribute?.('data-h2o-title-wash-id') || '').trim(),
        miniMapButtonCount: miniMapButtons.length,
        miniMapProjected,
        miniMapWashed,
        flowAnswerHydrated: !!answerEl,
        flowWashName,
        flowWashColor,
        flowWashed: !!(answerEl && (flowWashName === expected.colorName || flowWashColor)),
      };
    });
    // The canonical visual audit inserts an explicit missing-button row, so
    // its mismatch list is the complete MiniMap projection verdict. Keeping a
    // second page-member identity comparison here caused false failures after
    // expected rows were deduplicated onto the real button identity.
    const washerMiniMapProjectionReasons = miniMapWasherMismatches.map((entry) => String(entry.mismatchReason || 'minimap-wash-mismatch'));
    const washerMiniMapProjectionComplete = washerMiniMapProjectionReasons.length === 0;
    const washerFlowProjectionComplete = washerFidelityRows.every((entry) => !entry.flowAnswerHydrated || entry.flowWashed);
    const openedMember = openedStackRows.length === 1
      ? memberDetailsAll.find((member) => stackRowMatchesMember(openedStackRows[0], member)) || null
      : null;
    const openedRow = openedStackRows[0] || null;
    const openedMount = openedMember && titleListTransaction
      ? titleListCurrentNativeMount(titleListTransaction, openedMember)
      : { ok: false, anchors: [] };
    const openedMemberAnchors = openedMount.ok ? openedMount.anchors : [];
    const openedSections = openedMember ? titleListMemberSections(openedMember) : null;
    const requiredOpenedSections = openedSections
      ? [openedSections.questionSection, openedMember?.type === 'answer' ? openedSections.answerSection : null].filter(Boolean)
      : [];
    const openedSectionsCovered = requiredOpenedSections.length > 0
      && requiredOpenedSections.every((section) => openedMemberAnchors.some((anchor) => anchor === section || anchor.contains?.(section)));
    const openedSuffix = suffixContainers[0] || null;
    const openedFlowChildren = Array.from(titleListTransaction?.flowRoot?.children || []);
    const lastOpenedAnchor = openedMemberAnchors.slice().sort(
      (a, b) => openedFlowChildren.indexOf(a) - openedFlowChildren.indexOf(b)
    ).slice(-1)[0] || null;
    const openedTurnInsideListContext = manualOpenRows.length === 0
      ? 'notApplicable'
      : !!(openedMember && openedRow && titleListTransaction
        && openedRow.parentElement === synthContainer
        && openedMemberAnchors.length > 0
        && openedSectionsCovered
        && openedMemberAnchors.every((anchor) => (
          anchor.parentElement === titleListTransaction.flowRoot
          && !anchor.closest?.(`${TITLE_LIST_SYNTH_SEL}, ${TITLE_LIST_SUFFIX_SEL}`)
          && isVisibleEl(anchor)
        ))
        && (!openedSuffix || openedSuffix.previousElementSibling === lastOpenedAnchor));
    const otherRowsRemainCollapsed = manualOpenRows.length === 0
      ? 'notApplicable'
      : memberDetailsAll.filter((member) => member.id !== openedMember?.id).every((member) => {
          const anchors = memberAllFlowAnchors(member);
          return anchors.length > 0 && anchors.every((anchor) => !isVisibleEl(anchor));
        });
    const openedTurnsInlineInStack = 0;
    const openedInlineContentCount = 0;
    const orphanQuestionInlineVisible = openedMember?.type === 'no-answer'
      ? openedMemberAnchors.some((anchor) => isVisibleEl(anchor))
      : false;
    const doubleClickRowOpensOnlyThatTurn = manualOpenRows.length === 0
      ? 'notApplicable'
      : manualOpenRows.length === 1
        && openedTurnInsideListContext === true
        && openedTurnsInlineInStack === 0;
    const stackRectBeforeOpen = stackStats.stackRectBeforeOpen || null;
    const stackRectAfterOpen = manualOpenRows.length ? titleListRectSnapshot(synthContainer) : (stackStats.stackRectAfterOpen || null);
    const stackLayoutStable = manualOpenRows.length === 0
      ? 'notApplicable'
      : !!(stackRectBeforeOpen && stackRectAfterOpen
        && Math.abs(Number(stackRectBeforeOpen.left) - Number(stackRectAfterOpen.left)) <= 2
        && Math.abs(Number(stackRectBeforeOpen.width) - Number(stackRectAfterOpen.width)) <= 2);

    const noAnswerRowsStable = !titleListActive
      ? 'notApplicable'
      : expectedNoAnswerMemberCount === listedNoAnswerRows
        && noAnswerInFlowVisible === 0
        && orphanQuestionFlowVisible === 0
        && orphanQuestionVisibleUnderList === false
        && noAnswerAutoOpened === false;
    let logicalPaginationDiagnostics = null;
    try {
      logicalPaginationDiagnostics = inspectLogicalPaginationReadiness({
        chatId,
        pageNum,
        titleListActive,
        duplicateTitleBarsVisible,
        titleMismatches: titleFidelityMismatches,
        noAnswerRowsStable,
        pageFlowRestored: expandedPageFlowAudit.pageFlowRestored,
      });
    } catch (error) {
      logicalPaginationDiagnostics = unknownLogicalPaginationDiagnostics(
        `diagnostic-exception:${String(error?.message || error || 'unknown')}`,
      );
    }

    return {
      mechanismRoutes,
      logicalPaginationDiagnostics,
      logicalPaginationReadiness: logicalPaginationDiagnostics.logicalPaginationReadiness,
      visitState: {
        preference: getVisitStateMode(),
        chatId,
        currentVisitId: String(S.visitState?.currentVisitId || ''),
        resetModeActive: getVisitStateMode() === 'reset',
        resetAppliedThisVisit: !!S.visitState?.resetAppliedThisVisit,
        resetAppliedAt: Number(S.visitState?.resetAppliedAt || 0),
        clearedFamiliesOnLastReset: Number(S.visitState?.clearedFamilies || 0),
        clearedFamilyNames: Array.from(S.visitState?.clearedFamilyNames || []),
        clearedKeys: Array.from(S.visitState?.clearedKeys || []),
        skippedKeys: Array.from(S.visitState?.skippedKeys || []),
        missingChatIdDeferrals: Number(S.visitState?.missingChatIdDeferrals || 0),
        restoreSuppressedBecauseReset: !!S.visitState?.restoreSuppressedBecauseReset,
        liveStateCleared: !!S.visitState?.liveStateCleared,
        domCleanupApplied: !!S.visitState?.domCleanupApplied,
        rememberedTitleListPages: (() => { try { return localReadTitleListPagesSet(chatId)?.size || 0; } catch { return 0; } })(),
        rememberedCollapsedPages: (() => { try { return readCollapsedPages(chatId)?.size || 0; } catch { return 0; } })(),
        rememberedIntentActive: isTitleIntentEngineActive(chatId),
        sessionResets: Number(S.visitState?.resets || 0),
        lastResetApplied: !!S.visitState?.resetAppliedThisVisit,
      },
      activeIntentPages,
      activeOverrideAnswerIds,
      activeIntentSource,
      createdFromLegacyTitleList,
      createdOnChatOpen,
      legacyRelevantKeys,
      pageScopedGateResult,
      titleListActive,
      expectedPageMemberCount: members.length,
      expectedAnswerMemberCount,
      expectedNoAnswerMemberCount,
      expectedTitleRowCount,
      expectedTitleBarCount: expectedTitleRowCount,
      expectedAnswerTitleBars: expectedAnswerMemberCount,
      expectedNoAnswerTitleBars: expectedNoAnswerMemberCount,
      listedTitleRows: synthRows.length,
      listedTitleBarCount: synthRows.length,
      listedNoAnswerRows,
      listedNoAnswerTitleBars: listedNoAnswerRows,
      titleBarClassifications,
      stackedVisibleTitleBars: titleBarClassifications.filter((entry) => entry.location === 'inStack').length,
      hiddenFlowTitleBars: titleBarClassifications.filter((entry) => entry.location === 'hiddenFlow').length,
      duplicateTitleBarsVisible,
      inFlowTitleBarsVisibleWhileStackActive,
      inFlowTitleBarsVisibleWhileTitleListActive: inFlowTitleBarsVisibleWhileStackActive,
      residualHiddenFlowMembers,
      residualHiddenFlowMemberCount: residualHiddenFlowMembers.length,
      residualCollapsedFlowMembers: expandedPageFlowAudit.residualCollapsedFlowMembers,
      residualCollapsedFlowMemberCount: expandedPageFlowAudit.residualCollapsedFlowMemberCount,
      pageMemberExpandedStates: expandedPageFlowAudit.members,
      pageMemberExpandedStateFailures: expandedPageFlowAudit.pageMemberExpandedStateFailures,
      pageFlowRestored: expandedPageFlowAudit.pageFlowRestored,
      allPageMembersExpandedAfterDotExpand: expandedPageFlowAudit.allPageMembersExpandedAfterDotExpand,
      dotExpandConvergence,
      titleNumbersInStack,
      missingTitleNumbers,
      dividerBeforeTitleStack: dividerBeforeSyntheticList,
      dividerBeforeTitleList: dividerBeforeSyntheticList,
      titleStackAnchor: syntheticListAnchor,
      titleListAnchor: syntheticListAnchor,
      // Realness proof: every listed element must be a REAL title bar — the
      // atns-owned component (relocated or produced by 1C1a's own factory).
      // No fake row selector exists as the final row implementation.
      listedRealTitleBarCount: synthRows.filter((row) => row.matches?.('[data-cgxui="atns-answer-title"][data-cgxui-owner="atns"]')).length,
      listedTitleBarsAreRealTitleBars: synthRows.length > 0
        ? synthRows.every((row) => row.matches?.('[data-cgxui="atns-answer-title"][data-cgxui-owner="atns"]'))
        : 'notApplicable',
      stackTitleBarSelectors: [
        '[data-cgxui="atns-answer-title"][data-cgxui-owner="atns"]',
        '[data-at-no-answer="1"] (NO ANSWER variant)',
        '[data-h2o-detached-title-bar="1"] (1C1a factory-built, pre-hydration)',
      ],
      // Styling contract proof (Active Styling / Faded Number rules).
      fadedSideNumbersPresent: synthRows.length > 0
        ? synthRows.every((row) => Number(row.getAttribute('data-h2o-turn-num') || 0) > 0)
        : 'notApplicable',
      activeTitleBarNumbersPreserved: synthRows.length > 0
        ? synthRows.every((row) => Number(row.getAttribute('data-h2o-turn-num') || 0) > 0)
        : 'notApplicable',
      washerTitleBarsInStack: washerTitleBarsInStack.length,
      washerTitleBarsInFlowDuplicates: washerTitleBarsInFlowDuplicates.length,
      washerRowsInStack: washerTitleBarsInStack.map((row) => ({
        id: titleBarMemberId(row),
        turnNo: Number(row.getAttribute('data-h2o-stack-turn-no') || 0) || 0,
        wash: row.getAttribute('data-h2o-title-wash') || '',
      })),
      expectedWasherMemberIds,
      expectedWasherStates,
      canonicalExpectedMiniMapWashes,
      washerFidelityRows,
      miniMapWasherAudit,
      miniMapWasherMismatches,
      washerMiniMapProjectionReasons,
      washerMiniMapProjectionComplete,
      washerFlowProjectionComplete,
      titleFidelityRows,
      titleFidelityMismatches,
      goldActiveTitleBarsInStack: goldTitleBarsInStack.length,
      goldActiveTitleBarsInFlowDuplicates: goldTitleBarsInFlowDuplicates.length,
      activeFlashState: activeFlashRowsInStack.length
        ? { state: 'active', rows: activeFlashRowsInStack.map((row) => titleBarMemberId(row)) }
        : { state: 'none', rows: [] },
      activeTitleBarStylePreserved: !titleListActive
        ? 'notApplicable'
        : (expectedWasherMemberIds.length || activeFlashRowsInStack.length)
          ? washerProjectionComplete
          : 'notApplicable',
      // Ownership map (static, documents the single-owner model).
      titleListContainerCount: synthContainers.length,
      titleListContainerIds,
      stackOwner: String(synthContainer?.getAttribute?.('data-h2o-title-stack-owner') || '1C1b:syncSyntheticTitleList'),
      activeStackId: String(synthContainer?.id || ''),
      stackBuildCount: Number(stackStats.buildCount || 0),
      stackReplaceCount: Number(stackStats.replaceCount || 0),
      stackReattachCount: Number(stackStats.reattachCount || 0),
      stackRowReplaceCount: Number(stackStats.rowReplaceCount || 0),
      stackIdentityRekeyCount: Number(stackStats.identityRekeyCount || 0),
      stackTitleUpgradeCount: Number(stackStats.titleUpgradeCount || 0),
      stackTitleDowngradePreventedCount: Number(stackStats.titleDowngradePreventedCount || 0),
      stackMutationCount: Number(stackStats.mutationCount || 0),
      stackSyncCount: Number(stackStats.syncCount || 0),
      lastStackBuildReason: String(stackStats.lastBuildReason || ''),
      lastStackReplaceReason: String(stackStats.lastReplaceReason || ''),
      lastStackReattachReason: String(stackStats.lastReattachReason || ''),
      lastStackSyncReason: String(stackStats.lastSyncReason || ''),
      lastStackMutationReason: String(stackStats.lastStackMutationReason || ''),
      firstListCreatedAt: Number(stackStats.firstListCreatedAt || 0),
      lastStackMutationAt: Number(stackStats.lastStackMutationAt || 0),
      lastListSettledAt: Number(stackStats.lastListSettledAt || 0),
      stackRectBeforeOpen,
      stackRectAfterOpen,
      stackLayoutStable,
      dividerOwner: '1A1b:forcePlaceDividerBeforeTurnWrapper (also re-anchors the stack — Divider/Stack Unit Rule)',
      inFlowHideOwner: '1C1b:setTitleListMemberFlowHidden (+ dedup in syncSyntheticTitleList)',
      stylingOwner: '1A2a washer projection + 1C1a bar CSS + 1C1b stack numeral CSS + 1A1b:flashAnswer',
      duplicateMechanismConflicts: [
        (titleListActive && synthContainers.length !== 1) ? `title-list-container-count:${synthContainers.length}` : null,
        duplicateTitleBarsVisible ? 'duplicate-title-bars-visible' : null,
        inFlowTitleBarsVisibleWhileStackActive > 0 ? 'in-flow-member-bars-visible-while-stack-active' : null,
        noAnswerInFlowVisible > 0 ? 'no-answer-flow-visible-while-stack-active' : null,
        orphanQuestionVisibleUnderList ? 'orphan-question-visible-under-title-list' : null,
        noAnswerAutoOpened ? 'no-answer-row-opened-without-explicit-dblclick' : null,
        (titleListActive && dividerBeforeSyntheticList !== true) ? 'stack-above-divider' : null,
        openedTurnInsideListContext === false ? 'opened-turn-outside-list-context' : null,
        stackLayoutStable === false ? 'stack-horizontal-layout-shifted-after-open' : null,
        titleFidelityMismatches.length ? `title-fidelity-mismatches:${titleFidelityMismatches.length}` : null,
        (titleListActive && !washerProjectionComplete) ? 'washer-title-stack-projection-incomplete' : null,
        (expectedWasherStates.length && !washerMiniMapProjectionComplete) ? 'washer-minimap-projection-incomplete' : null,
      ].filter(Boolean),
      openedTitleNumber: manualOpenRows[0]?.turnNo || null,
      openedTurnsInlineInStack,
      openedInlineContentCount,
      openedTurnInsideListContext,
      doubleClickRowOpensOnlyThatTurn,
      pageRemainsInTitleListMode: manualOpenRows.length === 0 ? 'notApplicable' : titleListActive === true,
      otherRowsRemainCollapsed,
      noAnswerInStack: listedNoAnswerRows,
      noAnswerInFlowVisible,
      orphanQuestionFlowVisible,
      orphanQuestionVisibleUnderList,
      orphanQuestionInlineVisible,
      orphanQuestionFlowDetails: visibleInFlowNoAnswerMembers.map((entry) => ({
        id: entry.id,
        turnNo: entry.turnNo,
        questionId: entry.questionId,
        underList: entry.underList,
        hasHideStamp: entry.hasHideStamp,
        rect: entry.rect,
      })),
      noAnswerAutoOpened,
      noAnswerAutoOpenedRows,
      visibleInFlowNoAnswerMembers: visibleInFlowNoAnswerMembers.map((entry) => ({
        id: entry.id,
        turnNo: entry.turnNo,
        questionId: entry.questionId,
      })),
      visibleInFlowNoAnswerRows,
      noAnswerRowsHiddenBySyntheticList,
      missingTitleRows,
      titleRowSources,
      fallbackTitleRows,
      realTitleRows,
      rowsUsingFallbackDespiteKnownTitle,
      dividerBeforeSyntheticList,
      syntheticListAnchor,
      dividerPage: Number(pageDividerEl?.getAttribute?.('data-page-num') || 0) || null,
      syntheticListPage: Number(synthContainer?.getAttribute?.('data-page-num') || 0) || null,
      manualOpenRows,
      manualOverrideRows: activeOverrideAnswerIds,
      openedRowId,
      openedRowStillVisible: openedRowId
        ? !!(openedMemberAnchors.length
          && openedMemberAnchors.every((anchor) => anchor.isConnected
            && anchor.parentElement === titleListTransaction?.flowRoot
            && isVisibleEl(anchor)))
        : 'notApplicable',
      onlyOneTurnOpened: manualOpenRows.length ? manualOpenRows.length === 1 : 'notApplicable',
      moduleAvailable: true,
      ledgerKey: keyTitleIntentLedger(chatId),
      ledgerRev: ledger.rev,
      chatId,
      pageNum,
      pageIntent,
      pageExists,
      reasonIfNoMembers,
      availablePages,
      activeIntentCount,
      activeOverrideCount,
      isIntentSystemInert,
      pageHasIntent,
      titleIntentActive: !isIntentSystemInert,
      canonicalMembers: members.length,
      canonicalPageMembers: members,
      rowsHydrated: hydratedMembers.length,
      hydrated: hydratedMembers.length,
      unhydrated: unhydratedMembers.length,
      hydratedCount: hydratedMembers.length,
      unhydratedCount: unhydratedMembers.length,
      hydratedMembers,
      unhydratedMembers,
      members: memberDetails,
      manualOverrides,
      replayRuns: counters.replayRuns,
      replayNoops: counters.replayNoops,
      replaySkippedInert: counters.replaySkippedInert,
      replayReentrantSkips: counters.replayReentrantSkips,
      titleSetEventsSeen: counters.titleSetEventsSeen,
      targetedApplies: counters.targetedApplies,
      fullPageApplies: counters.fullPageApplies,
      counters,
      pass: {
        durablePageIntentExists: pageHasIntent ? true : 'notApplicable',
        canonicalPageMembershipUsed: !pageExists ? 'notApplicable' : members.length > 0,
        allHydratedMembersObeyResolver: !pageHasIntent ? 'notApplicable' : memberDetails.filter((m) => m.hydrated).every((m) => m.obeysResolver),
        unhydratedMembersNotDropped: !pageHasIntent ? 'notApplicable' : members.length > 0 && unhydratedMembers.every((answerId) => members.includes(answerId)),
        noVisibleOnlyPartialCollapse: !pageHasIntent ? 'notApplicable' : members.length > 0 && members.length >= hydratedMembers.length,
        expandSupersedesCollapse: !pageHasIntent ? 'notApplicable' : pageIntent.state !== 'expanded' || !staleManualWinning,
        staleRevDoesNotBeatNewerRev: !pageHasIntent && !activeOverrideCount ? 'notApplicable' : !staleManualWinning,
        manualOverridesAreExplicit: activeOverrideCount <= 0 ? 'notApplicable' : manualOverrides.every((entry) => !!entry.answerId && Number(entry.rev || 0) > 0 && !!entry.source),
        legacyKeysDidNotArmIntent: createdFromLegacyTitleList === false,
        titleListRowsComplete: !titleListActive
          ? 'notApplicable'
          : (expectedTitleRowCount > 0 && synthRows.length >= expectedTitleRowCount && missingTitleRows.length === 0),
        dividerBeforeSyntheticList: !titleListActive ? 'notApplicable' : dividerBeforeSyntheticList === true,
        noInFlowNoAnswerLeakWhileSyntheticListActive: !titleListActive
          ? 'notApplicable'
          : visibleInFlowNoAnswerRows === 0
            && noAnswerInFlowVisible === 0
            && orphanQuestionFlowVisible === 0
            && orphanQuestionVisibleUnderList === false,
        noNoAnswerAutoOpen: !titleListActive ? 'notApplicable' : noAnswerAutoOpened === false,
        oneTitleListContainer: !titleListActive
          ? 'notApplicable'
          : synthContainers.length === 1,
        noFallbackWhereRealTitleKnown: !titleListActive
          ? 'notApplicable'
          : rowsUsingFallbackDespiteKnownTitle.length === 0,
        doubleClickRowOpensOnlyThatTurn,
        pageRemainsInTitleListMode: manualOpenRows.length === 0
          ? 'notApplicable'
          : titleListActive === true,
        otherRowsRemainCollapsed,
        openedTurnInsideListContext,
        stackLayoutStable,
        noDuplicateTitleBarsVisible: !pageExists ? 'notApplicable' : duplicateTitleBarsVisible === false,
        // After circle/dot expand (title-list inactive, page not lightening-
        // collapsed) every current-page member must be fully released — no
        // lingering answer-collapse / title-list hide marker. Guards the
        // reported failure where semantic state read clean but question turns
        // stayed hidden via a stranded data-cgxui-at-hidden stamp.
        noResidualHiddenFlowMembers: (titleListActive || pageLightenCollapsed)
          ? 'notApplicable'
          : residualHiddenFlowMembers.length === 0,
        noResidualCollapsedFlowMembers: (titleListActive || pageLightenCollapsed)
          ? 'notApplicable'
          : expandedPageFlowAudit.residualCollapsedFlowMemberCount === 0,
        pageFlowRestored: expandedPageFlowAudit.pageFlowRestored,
        allPageMembersExpandedAfterDotExpand: expandedPageFlowAudit.allPageMembersExpandedAfterDotExpand,
        noInFlowTitleBarsWhileStackActive: !titleListActive ? 'notApplicable' : inFlowTitleBarsVisibleWhileStackActive === 0,
        noMissingTitleNumbers: !titleListActive ? 'notApplicable' : missingTitleNumbers.length === 0,
        listedTitleBarsAreRealTitleBars: !titleListActive
          ? 'notApplicable'
          : (synthRows.length > 0 && synthRows.every((row) => row.matches?.('[data-cgxui="atns-answer-title"][data-cgxui-owner="atns"]'))),
        fadedSideNumbersPresent: !titleListActive
          ? 'notApplicable'
          : synthRows.every((row) => Number(row.getAttribute('data-h2o-turn-num') || 0) > 0),
        activeTitleBarStylePreserved: !titleListActive
          ? 'notApplicable'
          : (expectedWasherMemberIds.length || activeFlashRowsInStack.length)
            ? washerProjectionComplete
            : 'notApplicable',
        washerStylePreserved: !titleListActive || !expectedWasherMemberIds.length
          ? 'notApplicable'
          : washerProjectionComplete,
        titleFidelityPreserved: !titleListActive
          ? 'notApplicable'
          : titleFidelityMismatches.length === 0,
        washerMiniMapProjectionPreserved: !expectedWasherMemberIds.length
          ? 'notApplicable'
          : washerMiniMapProjectionComplete,
        washerFlowProjectionRestored: titleListActive || !expectedWasherMemberIds.length
          ? 'notApplicable'
          : washerFlowProjectionComplete,
        noMechanismConflicts: !titleListActive
          ? 'notApplicable'
          : (synthContainers.length === 1
            && !duplicateTitleBarsVisible
            && inFlowTitleBarsVisibleWhileStackActive === 0
            && noAnswerInFlowVisible === 0
            && orphanQuestionFlowVisible === 0
            && orphanQuestionVisibleUnderList === false
            && noAnswerAutoOpened === false
            && dividerBeforeSyntheticList === true
            && openedTurnInsideListContext !== false
            && stackLayoutStable !== false),
      },
    };
  }

  function shouldRefreshOnPaginationConfigChanged(reason = '') {
    const why = String(reason || '').trim();
    switch (why) {
      case 'cfg:pwPageSize':
      case 'cfg:pwBufferAnswers':
      case 'cfg:diag':
      case 'cfg:pwAutoLoadSentinel':
      case 'cfg:pwShortcutsEnabled':
        return false;
      default:
        return true;
    }
  }

  function syncActiveTitleListsNow(reason = 'presentation-updated') {
    const results = reconcileAtomicPageCollapseTransactions(reason);
    return {
      ok: results.every((result) => result?.ok !== false),
      status: results.length ? 'validated' : 'inactive',
      pages: results.length,
      results,
    };
  }

  function titleListMutationTouchesOwnedFlow(payload = null) {
    if (!payload?.conversationRelevant) return false;
    for (const node of Array.isArray(payload?.addedElements) ? payload.addedElements : []) {
      if (!node || node.nodeType !== 1) continue;
      try {
        if (
          node.matches?.(`${TURN_HOST_SEL}, [role="separator"]`)
          || node.querySelector?.(`${TURN_HOST_SEL}, [role="separator"]`)
        ) return true;
        if (
          node.matches?.(`${TITLE_LIST_SYNTH_SEL}, [data-cgxui-owner="chtpgs"]`)
          || node.closest?.(TITLE_LIST_SYNTH_SEL)
        ) continue;
      } catch {}
    }
    return false;
  }

  function bindTitleListObserverHub() {
    if (typeof S.titleListObserverHubOff === 'function') return true;
    const hub = W.H2O?.obs || TOPW.H2O?.obs || null;
    if (!hub || typeof hub.onMutations !== 'function') return false;
    try { hub.ensureRoot?.('chat-pages:title-list'); } catch {}
    try {
      S.titleListObserverHubOff = hub.onMutations('chat-pages:title-list', (payload) => {
        const chatId = resolveChatId();
        if (!readTitleListPages(chatId).size) return;
        if (!titleListMutationTouchesOwnedFlow(payload)) return;
        // Observer Hub already batches native remounts into one microtask.
        // Reapply synchronously here so a newly mounted shell or timestamp is
        // stamped before the browser's next paint; no timer or second observer.
        syncActiveTitleListsNow('observer-hub-remount');
      });
      return typeof S.titleListObserverHubOff === 'function';
    } catch {
      S.titleListObserverHubOff = null;
      return false;
    }
  }

  function unbindTitleListObserverHub() {
    if (typeof S.titleListObserverHubOff !== 'function') return false;
    const off = S.titleListObserverHubOff;
    S.titleListObserverHubOff = null;
    try { off(); } catch {}
    return true;
  }

  function bind() {
    if (S.listenersBound) {
      S.bound = true;
      return { ok: true, status: 'already-bound', chatId: String(S.chatId || resolveChatId()).trim() };
    }

    S.onDividerDblClick = (ev) => {
      clearDividerClickTimer();
      try { TAGS_API()?.closeTagsCloudPopup?.(); } catch {}
      const dot = ev?.target?.closest?.('.cgxui-chat-page-divider-dot, .cgxui-pgnw-page-divider-dot');
      if (dot) return;
      const divider = ev?.target?.closest?.('.cgxui-chat-page-divider, .cgxui-pgnw-page-divider');
      if (!divider) return;
      const pageNum = getDividerPageNum(divider);
      if (!pageNum) return;
      try { ev.preventDefault(); ev.stopPropagation(); } catch {}
      const chatId = resolveChatId();
      const nextCollapsed = !isPageCollapsed(pageNum, chatId);
      const routed = CM_ROUTER_API()?.routeChatPageDividerDblClick?.({
        pageNum,
        chatId,
        dividerEl: divider,
        pageAnswerIds: getPageAnswerIds(pageNum, chatId),
        currentCollapsed: !nextCollapsed,
        nextCollapsed,
        owner: {
          setPageCollapsed,
        },
      });
      if (routed?.handled === true) return;
      try { togglePageCollapsed(pageNum, { chatId: resolveChatId(), source: 'chat-page-divider:dblclick' }); } catch {}
    };

    S.onDividerClick = (ev) => {
      if (Number(ev?.detail || 1) > 1) return;
      const dot = ev?.target?.closest?.('.cgxui-chat-page-divider-dot, .cgxui-pgnw-page-divider-dot');
      if (dot) return;
      const divider = ev?.target?.closest?.('.cgxui-chat-page-divider, .cgxui-pgnw-page-divider');
      if (!divider) return;
      const pageNum = getDividerPageNum(divider);
      if (!pageNum) return;
      try { ev.preventDefault(); ev.stopPropagation(); } catch {}
      clearDividerClickTimer();
      S.dividerClickTimer = W.setTimeout(() => {
        S.dividerClickTimer = null;
        openTagsCloudFromDivider(divider);
      }, 180);
    };

    S.onDividerDotClick = (ev) => {
      if (Number(ev?.detail || 1) > 1) return;
      const dot = ev?.target?.closest?.('.cgxui-chat-page-divider-dot, .cgxui-pgnw-page-divider-dot');
      if (!dot) return;
      const divider = dot.closest?.('.cgxui-chat-page-divider, .cgxui-pgnw-page-divider');
      if (!divider) return;
      const pageNum = getDividerPageNum(divider);
      if (!pageNum) return;
      try { ev.preventDefault(); ev.stopPropagation(); } catch {}
      const chatId = resolveChatId();
      const activationSource = String(
        ev?.h2oActivationSource || 'chat-page-divider:circle'
      ).trim() || 'chat-page-divider:circle';
      // Pointer activation converges on the single transaction owner, which
      // decides collapse vs expansion, records the attempt diagnostic and maps
      // its own failure feedback. No legacy readiness re-read here: it was the
      // stale legacy reason that mislabelled a transaction failure as a
      // missing next page boundary.
      executeAtomicPageCollapseTransaction(pageNum, activationSource, { chatId });
    };

    S.onDividerDotKeyDown = forwardCollapseControlKeyboardActivation;

    S.onAnswerCollapse = (ev) => {
      const answerId = String(ev?.detail?.answerId || '').trim();
      if (!answerId) return;
      // Page-circle legacy fallback updates every row synchronously, then the
      // page owner performs one state/stack/render commit. Re-entering here
      // once per row was the second repair cadence that replaced the first
      // list-like state and raced washer/NO ANSWER projection.
      if (S.titleListBatchDepth > 0) {
        S.titleListBatchDirty = true;
        return;
      }
      const chatId = resolveChatId();
      try { MM_CORE_PAGES()?.renderDividers?.(chatId); } catch {}
      scheduleDividerVisualRefresh(chatId);
    };

    S.onTitleSet = (ev) => {
      incTitleIntentStat('titleSetEventsSeen');
      const answerId = String(ev?.detail?.answerId || '').trim();
      if (!answerId) return;
      const chatId = resolveChatId();
      // O(1) gates FIRST. Title-set events fire for every bar during chat
      // open; nothing heavier than cached-ledger checks and title-list/page
      // set lookups may run before we know a page is actually collapsed,
      // title-listed, or intent-active. In the fully idle state this handler
      // must do zero row scans and zero DOM work.
      const engineActive = isTitleIntentEngineActive(chatId);
      const hasCollapsedPages = (readCollapsedPages(chatId)?.size || 0) > 0;
      const hasTitleListPages = (readTitleListPages(chatId)?.size || 0) > 0;
      if (!engineActive && !hasCollapsedPages && !hasTitleListPages) {
        incTitleIntentStat('replaySkippedInert');
        return;
      }
      const ledger = readTitleIntentLedger(chatId);
      const row = findRowByAnswerId(answerId);
      const pageNum = Math.max(0, Number(row?.pageNum
        || (engineActive ? getTitleIntentPageForAnswerFromLedger(answerId, ledger) : 0)
        || (engineActive ? findPageForAnswerId(answerId) : 0)
        || 0) || 0);
      if (!pageNum) return;
      if (engineActive && titleIntentPageHasActiveState(pageNum, ledger)) {
        applyTitleIntentToAnswer(answerId, { chatId, page: pageNum, animate: false, ledger });
        if (S.titleIntentReplayInFlight) return;
      }
      const pageCollapsed = isPageCollapsed(pageNum, chatId);
      const titleListActive = isTitleListActive(pageNum, chatId);
      if (!pageCollapsed && !titleListActive) return;
      // A title-set event is a hydration signal, not a page gesture. Repair
      // only this page's canonical stack and never replay the page-level
      // collapse executors or rebuild the stack twice.
      if (titleListActive) scheduleActiveTitleListRepair('title-set', 0, pageNum);
      if (pageCollapsed) applyPageCollapsedVisuals(pageNum, { chatId, source: 'chat-pages-controller:title-set' });
    };

    S.onCoreIndexUpdated = () => {
      const chatId = resolveChatId();
      const cached = S.titleListPagesByChat.get(chatId);
      if (cached instanceof Set && cached.size === 0) return;
      if (!(cached instanceof Set) && readTitleListPages(chatId).size === 0) return;
      scheduleActiveTitleListRepair('core-index-updated', 16);
    };

    S.onCoreTurnUpdated = (ev) => {
      if (String(ev?.detail?.reason || '') !== 'effective-presentation') return;
      syncActiveTitleListsNow('effective-presentation');
    };

    S.onPaginationPageChanged = () => {
      try { refreshAll(resolveChatId()); } catch {}
    };

    S.onPaginationConfigChanged = (ev) => {
      const reason = String(ev?.detail?.reason || '').trim();
      if (!shouldRefreshOnPaginationConfigChanged(reason)) return;
      try { setTimeout(() => { try { refreshAll(resolveChatId()); } catch {} }, 80); } catch {}
    };

    S.onRouteChanged = () => {
      expandAllAtomicPageCollapses('route-change');
      try {
        W.setTimeout(() => {
          const id = resolveVisitChatId();
          if (!id) {
            S.visitState.currentChatId = '';
            S.visitState.currentVisitId = '';
            scheduleDeferredVisitRefresh('route-change');
            return;
          }
          if (id === S.visitState.currentChatId) return;
          try { refreshAll(id, { reason: 'route-change', forceNewVisit: true }); } catch {}
        }, 0);
      } catch {}
    };

    S.onVisitStateModeChanged = (ev) => {
      const mode = String(ev?.detail?.mode || getVisitStateMode()).trim().toLowerCase();
      if (mode !== 'reset') {
        S.visitState.lastMode = 'remember';
        S.visitState.restoreSuppressedBecauseReset = false;
        return;
      }
      const id = resolveVisitChatId();
      if (!id) {
        scheduleDeferredVisitRefresh('preference-reset');
        return;
      }
      try {
        maybeApplyVisitStatePolicy(id, {
          forceReset: true,
          reason: 'preference-switched-to-reset',
        });
      } catch {}
    };

    S.onMiniMapShellReady = () => {
      // MiniMap became available: replay the pages it may have missed. Each
      // entry carries the revision Chat already holds — read, never advanced,
      // because readiness is not a new Chat action — so the ordered gate in
      // 1A1b applies only genuinely-missed actions and leaves a MiniMap-local
      // choice with nothing newer behind it untouched.
      try {
        const id = resolveChatId();
        if (!id) return;
        const snapshot = {};
        for (const pageNum of collectKnownPageNums(id)) {
          const num = Math.max(1, Number(pageNum || 0) || 0);
          if (!num) continue;
          snapshot[String(num)] = {
            c: !!isPageCollapsed(num, id),
            rev: chatPageRevFor(num, id, { source: 'chat-pages-controller:refresh' }),
          };
        }
        MM_CORE_PAGES()?.reconcileOnMiniMapReady?.(id, snapshot, { source: 'minimap-ready' });
      } catch {}
    };

    S.onMiniMapTogglePageCollapsed = (ev) => {
      const pageNum = Math.max(1, Number(ev?.detail?.pageNum || 0) || 0);
      if (!pageNum) return;
      const source = String(ev?.detail?.source || 'minimap-local').trim() || 'minimap-local';
      try { MM_CORE_PAGES()?.toggleMiniMapPageCollapsed?.(pageNum, '', { source, propagate: false }); } catch {}
    };

    document.addEventListener('dblclick', S.onDividerDblClick, true);
    window.addEventListener('click', S.onDividerClick, true);
    window.addEventListener('click', S.onDividerDotClick, true);
    window.addEventListener('keydown', S.onDividerDotKeyDown, true);
    window.addEventListener(EV_PAGE_CHANGED, S.onPaginationPageChanged);
    window.addEventListener(EV_ANSWER_COLLAPSE, S.onAnswerCollapse);
    window.addEventListener(EV_TITLE_SET, S.onTitleSet);
    window.addEventListener(EV_CORE_INDEX_UPDATED, S.onCoreIndexUpdated);
    window.addEventListener(EV_CORE_TURN_UPDATED, S.onCoreTurnUpdated);
    window.addEventListener(EV_MM_TOGGLE_PAGE_COLLAPSED, S.onMiniMapTogglePageCollapsed);
    window.addEventListener(EV_MM_SHELL_READY, S.onMiniMapShellReady);
    window.addEventListener(EV_PAGE_CFG_CHANGED, S.onPaginationConfigChanged);
    window.addEventListener(EV_ROUTE_CHANGED, S.onRouteChanged, true);
    window.addEventListener(EV_VISIT_STATE_MODE_CHANGED, S.onVisitStateModeChanged, true);
    window.addEventListener('popstate', S.onRouteChanged, true);
    window.addEventListener('hashchange', S.onRouteChanged, true);
    if (EV_PAGE_CHANGED.startsWith('evt:')) {
      window.addEventListener(EV_PAGE_CHANGED.slice(4), S.onPaginationPageChanged);
    }
    bindTitleListObserverHub();

    S.listenersBound = true;
    S.bound = true;
    S.chatId = resolveChatId();
    ensureDividerStyle();
    try { refreshAll(S.chatId, { reason: 'bind' }); } catch {}
    scheduleDividerVisualRefresh(S.chatId, 0);
    return { ok: true, status: 'bound', chatId: S.chatId };
  }

  function unbind() {
    clearDividerClickTimer();
    expandAllAtomicPageCollapses('unbind');
    S.titleListOpenStatesByKey.clear();
    try { document.removeEventListener('dblclick', S.onDividerDblClick, true); } catch {}
    try { window.removeEventListener('click', S.onDividerClick, true); } catch {}
    try { window.removeEventListener('click', S.onDividerDotClick, true); } catch {}
    try { window.removeEventListener('keydown', S.onDividerDotKeyDown, true); } catch {}
    try { window.removeEventListener(EV_PAGE_CHANGED, S.onPaginationPageChanged); } catch {}
    try { window.removeEventListener(EV_ANSWER_COLLAPSE, S.onAnswerCollapse); } catch {}
    try { window.removeEventListener(EV_TITLE_SET, S.onTitleSet); } catch {}
    try { window.removeEventListener(EV_CORE_INDEX_UPDATED, S.onCoreIndexUpdated); } catch {}
    try { window.removeEventListener(EV_CORE_TURN_UPDATED, S.onCoreTurnUpdated); } catch {}
    try { window.removeEventListener(EV_MM_TOGGLE_PAGE_COLLAPSED, S.onMiniMapTogglePageCollapsed); } catch {}
    try { window.removeEventListener(EV_MM_SHELL_READY, S.onMiniMapShellReady); } catch {}
    try { window.removeEventListener(EV_PAGE_CFG_CHANGED, S.onPaginationConfigChanged); } catch {}
    try { window.removeEventListener(EV_ROUTE_CHANGED, S.onRouteChanged, true); } catch {}
    try { window.removeEventListener(EV_VISIT_STATE_MODE_CHANGED, S.onVisitStateModeChanged, true); } catch {}
    try { window.removeEventListener('popstate', S.onRouteChanged, true); } catch {}
    try { window.removeEventListener('hashchange', S.onRouteChanged, true); } catch {}
    if (EV_PAGE_CHANGED.startsWith('evt:')) {
      try { window.removeEventListener(EV_PAGE_CHANGED.slice(4), S.onPaginationPageChanged); } catch {}
    }
    unbindTitleListObserverHub();
    S.onDividerDblClick = null;
    S.onDividerClick = null;
    S.onDividerDotClick = null;
    S.onDividerDotKeyDown = null;
    S.onAnswerCollapse = null;
    S.onTitleSet = null;
    S.onCoreIndexUpdated = null;
    S.onCoreTurnUpdated = null;
    S.onPaginationPageChanged = null;
    S.onPaginationConfigChanged = null;
    S.onMiniMapTogglePageCollapsed = null;
    S.onMiniMapShellReady = null;
    S.onRouteChanged = null;
    S.onVisitStateModeChanged = null;
    if (S.visitState.deferredTimer) {
      try { W.clearTimeout(S.visitState.deferredTimer); } catch {}
      S.visitState.deferredTimer = 0;
    }
    clearDividerRefreshTimer();
    if (S.titleListRepairTimer) {
      try { W.clearTimeout(S.titleListRepairTimer); } catch {}
      S.titleListRepairTimer = 0;
    }
    S.titleListRepairPages.clear();
    S.titleListRepairAllPages = false;
    S.titleListHydrationRecoveryIdentity = '';
    S.titleListHydrationRecoveryIds.clear();
    S.nativeRangeActivePages.clear();
    S.atomicPageCollapseTransactions.clear();
    S.atomicPageCollapseGuards.clear();
    S.collapsedBoundaryDiagnostics.clear();
    try {
      for (const node of Array.from(document.querySelectorAll(`[${ATTR_COLLAPSE_FEEDBACK}]`))) {
        try {
          node.hidden = true;
          node.textContent = '';
          node.setAttribute('aria-hidden', 'true');
          node.removeAttribute(ATTR_COLLAPSE_REASON);
          node.removeAttribute('title');
        } catch {}
      }
    } catch {}
    for (const campaign of S.dotExpandCampaigns.values()) {
      if (campaign?.timer) { try { W.clearTimeout(campaign.timer); } catch {} }
    }
    S.dotExpandCampaigns.clear();
    try { UM_ADAPTER()?.setPresentationMountGuard?.(TITLE_LIST_PAGE_HYDRATION_OWNER, []); } catch {}
    try { PG_ADAPTER()?.setPresentationFullFlowHold?.(TITLE_LIST_PAGE_HYDRATION_OWNER, false); } catch {}
    S.titleListPageHydration = {
      active: false,
      source: '',
      count: 0,
      pageCount: 0,
      normalPages: [],
      guardedIds: 0,
      paginationHeld: false,
    };
    S.listenersBound = false;
    S.bound = false;
    return { ok: true, status: 'unbound', chatId: String(S.chatId || '').trim() };
  }

  function registerBridge() {
    const SH = MM_SH();
    if (!SH) return null;
    SH.api = SH.api || Object.create(null);
    SH.api.mm = SH.api.mm || Object.create(null);
    const api = Object.freeze({
      ver: '2.2.5',
      boot,
      dispose,
      bind,
      unbind,
      refreshAll,
      readCollapsedPages,
      writeCollapsedPages,
      readTitleListPages,
      writeTitleListPages,
      isPageCollapsed,
      isTitleListActive,
      resolveNativeTurnSlotSequence,
      resolveNativePageHeadCoherence,
      getCollapsedNativeBoundaryReadiness,
      getRenderedPageBoundaryCapability,
      getPageCollapseRangeDiagnostics,
      getPageCollapseCapability,
      getAtomicPageCollapseTransactionDiagnostic,
      getCollapsedBoundaryDiagnostic,
      setTitleListMode,
      setPageCollapsed,
      togglePageCollapsed,
      getTitleState,
      getDividerUiMode,
      resetAllMechanisms,
      resetPageTitleStateForCurrentChat: resetAllMechanisms,
      resetCurrentChatOutline: resetAllMechanisms,
      clearVisitStateForCurrentChat,
      applyPageVisuals,
      applyPageCollapsedVisuals,
      applyDividerVisualsToDivider,
      readTitleIntentLedger,
      writePageTitleIntent,
      recordManualTitleOverride,
      resolveDesiredTitleState,
      applyTitleIntentToAnswer,
      applyTitleIntentToPage,
      titleIntentDebugSnapshot,
      isTitleIntentSystemInert: (chatId = '') => !isTitleIntentEngineActive(chatId),
      // O(1) cached gate — THE check every consumer must make before any
      // title-intent work. No storage IO, no allocation.
      isTitleIntentEngineActive,
      noteTitleIntentStat: incTitleIntentStat,
      getTitleIntentStats,
      getState,
      getPageDividerDebugState,
    });
    SH.api.mm.chatPagesCtl = api;
    try {
      TOPW.H2O = TOPW.H2O || {};
      TOPW.H2O.ChatPageTitleIntent = TOPW.H2O.ChatPageTitleIntent || {};
      TOPW.H2O.ChatPageTitleIntent.api = api;
      W.H2O_TITLE_INTENT_DEBUG = {
        snapshot: titleIntentDebugSnapshot,
        resolve: resolveDesiredTitleState,
        clearVisitStateForCurrentChat,
      };
      TOPW.H2O_TITLE_INTENT_DEBUG = W.H2O_TITLE_INTENT_DEBUG;
    } catch {}
    return SH.api.mm.chatPagesCtl;
  }

  function boot() {
    registerBridge();
    ensureDividerStyle();
    S.booted = true;
    S.chatId = resolveChatId();
    const bindResult = bind();
    return { ok: !!bindResult?.ok, status: bindResult?.status || 'booted', chatId: S.chatId };
  }

  function dispose() {
    unbind();
    try { S.dividerStyleEl?.remove?.(); } catch {}
    S.dividerStyleEl = null;
    S.booted = false;
    S.chatId = '';
    return { ok: true, status: 'disposed' };
  }

  boot();
})();
