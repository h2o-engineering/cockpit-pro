// ==UserScript==
// @h2o-id             s1a1e.minimap.skin.studio
// @name               S1A1e. 🎬 MiniMap Skin - Studio
// @namespace          H2O.Premium.CGX.minimap.skin
// @author             HumamDev
// @version            12.7.1
// @revision           001
// @build              260304-102754
// @description        MiniMap Skin: CSS-only style API for Shell delegation
// @match              https://chatgpt.com/*
// @run-at             document-idle
// @grant              none
// ==/UserScript==

(() => {
  'use strict';

  const W = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;
  const TOPW = W.top || W;

  const SKIN_VER = '12.7.0';
  const PRELAYOUT_CLASS = 'cgxui-mm-prelayout';
  const EVT_SKIN_READY = 'evt:h2o:minimap:skin-ready';

  const SkID = 'mnmp';
  // Keep the MiniMap stack below the Workspace Dock overlay.
  const Z = 2147483644;
  const Z_BELOW = Z - 1;
  const QA_LAYOUT = Object.freeze({
    GROUP_GAP_PX: 2,
    QUESTION_HEIGHT_PX: 12,
    QUESTION_RADIUS_PX: 5,
    QUESTION_BG: 'rgba(255,255,255,0.018)',
  });
  const ACTIVE_RING = Object.freeze({
    COLOR: '#FFD700',
    LINE_WIDTH_PX: 1,
    OUTLINE_WIDTH_PX: 1.5,
    OUTLINE_OFFSET_PX: 1.5,
    ANSWER_LINE_OPACITY: '85%',
    ANSWER_GLOW_OPACITY: '25%',
    ANSWER_OUTLINE_OPACITY: '38%',
    QUESTION_LINE_OPACITY: '45%',
    QUESTION_GLOW_OPACITY: '12%',
    QUESTION_OUTLINE_OPACITY: '18%',
    GLOW_BLUR_PX: 10,
    GLOW_SPREAD_PX: 2,
  });
  const PAGE_FLASH = Object.freeze({
    QUESTION_HEIGHT_TOP_PX: 12,
    QUESTION_HEIGHT_BOTTOM_PX: 18,
    ANSWER_HEIGHT_TOP_PX: 25,
    ANSWER_HEIGHT_BOTTOM_PX: 50,
    DURATION_MS: 1600,
    PEAK_OPACITY: 0.06,
    GLOW_BLUR_PX: 22,
    GLOW_ALPHA: 0.35,
    RADIUS_PX: 12,
  });
  const ANSWER_WASH_AREA = Object.freeze({
    HEIGHT_TOP_PX: 25,
    HEIGHT_BOTTOM_PX: 50,
  });
  const DIVIDER_LAYOUT = Object.freeze({
    LEFT_INSET_PX: 25,                                          // 👈 ↑ = line starts more right; ↓ / − = extends more left
    RIGHT_INSET_PX: -10,                                        // 👈 ↑ = line ends more left; ↓ = extends more right
    LINE_WIDTH_PX: 1,                                           // 👈 ↑ = thicker; ↓ = thinner
    LINE_OPACITY: 0.24,                                         // 👈 ↑ = stronger; ↓ = fainter
    LINE_OFFSET_UP_PX: 6,                                     // 👈 ↑ = renders the line higher inside its hit area; helps keep it visually off the lower box
  });
  const CHAT_PAGE_DIVIDER_LAYOUT = Object.freeze({
    LINE_LENGTH_PX: 247,   // 190 × 1.3 = 247 (30% longer on each side)
    LEFT_INSET_PX: 0,                                           // 👈 ↑ = shorter left line; ↓ / − = longer left line
    RIGHT_INSET_PX: 0,                                          // 👈 ↑ = shorter right line; ↓ / − = longer right line
    LINE_WIDTH_PX: 1,                                           // 👈 ↑ = thicker divider line; ↓ = thinner divider line
    ROW_GAP_PX: 12,
    MARGIN_TOP_PX: 22,
    MARGIN_BOTTOM_PX: 18,
  });

  const CSS_ = Object.freeze({
    STYLE_ID: `cgxui-${SkID}-style`,
  });
  const STYLE_OWNER_ATTR = 'data-h2o-mm-skin';
  const STYLE_OWNER_VER_ATTR = 'data-h2o-mm-skin-ver';

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
    ACCESS: `${SkID}-access`,
    // Bottom control (legacy alias: AUX)
    DIAL: `${SkID}-aux`,
    AUX: `${SkID}-aux`,
    WRAP: `${SkID}-wrap`,
    BTN: `${SkID}-btn`,
    QBTN: `${SkID}-qbtn`,
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

  const COLORS = [
    { name: 'blue', color: '#3A8BFF' },
    { name: 'red', color: '#FF4A4A' },
    { name: 'green', color: '#31D158' },
    { name: 'gold', color: '#FFD700' },
    { name: 'sky', color: '#4CD3FF' },
    { name: 'pink', color: '#FF71C6' },
    { name: 'purple', color: '#A36BFF' },
    { name: 'orange', color: '#FFA63A' }
  ];
function CSS_MM_text() {
  const selScoped = (ui) => `[${ATTR_.CGXUI}="${ui}"][${ATTR_.CGXUI_OWNER}="${SkID}"]`;

  const S_ROOT       = selScoped(UI_.ROOT);
  const S_MINIMAP     = selScoped(UI_.MINIMAP);
  const S_COL         = selScoped(UI_.COL);
  const S_TOGGLE      = selScoped(UI_.TOGGLE);
  const S_ACCESS      = selScoped(UI_.ACCESS);
  const S_DIAL        = selScoped(UI_.DIAL);

  const S_BTN         = selScoped(UI_.BTN);
  const S_QBTN        = selScoped(UI_.QBTN);
  const S_DOTROW      = selScoped(UI_.DOTROW);
  const S_WRAP        = selScoped(UI_.WRAP);
  const S_COUNTER     = selScoped(UI_.COUNTER);
  const S_PINROW      = selScoped(UI_.PINROW);
  const S_PIN_QUOTE   = selScoped(UI_.PIN_QUOTE);
  const S_PIN_QWASH   = selScoped(UI_.PIN_QWASH);
  const S_PIN_REV     = selScoped(UI_.PIN_REV);
  const S_DIAL_PINROW = selScoped(UI_.DIAL_PINROW);
  const S_DIAL_PIN_DOTS = selScoped(UI_.DIAL_PIN_DOTS);
  const S_DIAL_PIN_TITLES = selScoped(UI_.DIAL_PIN_TITLES);
  const S_DIAL_PIN_SYMBOLS = selScoped(UI_.DIAL_PIN_SYMBOLS);

  const S_DIAL_UP      = selScoped(UI_.DIAL_UP);
  const S_DIAL_DOWN    = selScoped(UI_.DIAL_DOWN);

  const S_COUNT     = selScoped(UI_.COUNT);

  const base = `

:root {
  --cgxui-mnmp-flash-peak: ${PAGE_FLASH.PEAK_OPACITY};
  --cgxui-mnmp-flash-ms:   ${PAGE_FLASH.DURATION_MS}ms;
  --cgxui-mnmp-flash-ease: ease-in-out;
  --cgxui-mnmp-question-flash-top: -${PAGE_FLASH.QUESTION_HEIGHT_TOP_PX}px;
  --cgxui-mnmp-question-flash-bottom: -${PAGE_FLASH.QUESTION_HEIGHT_BOTTOM_PX}px;
  --cgxui-mnmp-answer-flash-top: -${PAGE_FLASH.ANSWER_HEIGHT_TOP_PX}px;
  --cgxui-mnmp-answer-flash-bottom: -${PAGE_FLASH.ANSWER_HEIGHT_BOTTOM_PX}px;
  --cgxui-mnmp-answer-wash-top: -${ANSWER_WASH_AREA.HEIGHT_TOP_PX}px;
  --cgxui-mnmp-answer-wash-bottom: -${ANSWER_WASH_AREA.HEIGHT_BOTTOM_PX}px;
  --cgxui-mnmp-flash-radius: ${PAGE_FLASH.RADIUS_PX}px;
  --cgxui-mnmp-flash-glow-blur: ${PAGE_FLASH.GLOW_BLUR_PX}px;
  --cgxui-mnmp-flash-glow-alpha: ${PAGE_FLASH.GLOW_ALPHA};
  --cgxui-mnmp-btn-width: 40px;
  --cgxui-mnmp-btn-height: 20px;
  --cgxui-mnmp-minimap-top: 92px;
}

${S_ROOT}{
  position: fixed !important;

  --root-top: 60px;
  --root-right: 5px; /* default anchor: near right edge but safely inside */
  top: var(--root-top);
  right: var(--root-right);

  /* Keep axis stable */
  z-index: ${Z} !important;
  width: var(--box-w);

  display: flex;
  flex-direction: column;
  align-items: center;

  /* Stack spacing */
  --stack-gap: 0px;         /* your base */
  --stack-trim: 1px;        /* use this to nudge BOTH gaps equally */

  gap: var(--stack-gap);

  /* Root padding / bleed safety */
  --root-pad-right: 0px;
  --root-pad-bottom: 20px;
  padding-right: var(--root-pad-right);
  padding-bottom: var(--root-pad-bottom);

  overflow: visible !important;

  --box-w: 72px;
  --box-h: 36px;
  --box-r: 8px;

  --axis-x: 0px;
  --axis-y: 0px; /* moves toggle + minimap + dial together */
  --mm-center-fix-x: 0px;

  --mm-x: 0px;
  --mm-y:  calc(-1 * var(--stack-trim));
  --toggle-x: var(--mm-x);
  --toggle-y: calc(-1 * var(--stack-trim));

  /* MiniMap max-height formula control */
  --mm-max-vh: 60vh;
  --mm-max-sub: 140px; /* calc(100vh - this) */
  /* Used later as: max-height: min(var(--mm-max-vh), calc(100vh - var(--mm-max-sub))); */

  --mm-pad-r: 6px;      /* right padding */
  --mm-edge-gap: 6px;   /* keep top/bottom MiniMap edge spacing symmetrical */
  --mm-pad-t: var(--mm-edge-gap);
  --mm-pad-b: var(--mm-edge-gap);

  /* dot gutter reserved INSIDE minimap on left */
  --mm-dot-gutter: 28px;

  /* dot gap between dots and button */
  --mm-dot-gap: 10px;

  --mm-dot-x: calc(-2 * (var(--mm-dot-gutter) - var(--mm-dot-gap)));
  --mm-side-lane: calc(var(--mm-pad-r) + var(--mm-dot-gutter));
  --mm-gutter-w: 16px;
  --mm-gutter-sym-size: 12px;
  --mm-gutter-outset: 4px;
  --mm-gutter-sym-shift-x: 0.5px;
  --mm-w: calc(var(--mm-btn-w) + (2 * var(--mm-side-lane)));

  /* dot size + grid spacing */
  --mm-dot-size: 5px;
  --mm-dot-col-gap: 3px;
  --mm-dot-row-gap: 3px;
  --mm-dot-cols: 4;

  --mm-btn-w: 56px;
  --mm-btn-h: 24px;
  --mm-btn-r: 6px;
  --mm-q-btn-h: ${QA_LAYOUT.QUESTION_HEIGHT_PX}px;
  --mm-q-btn-r: ${QA_LAYOUT.QUESTION_RADIUS_PX}px;
  --mm-qa-gap: 2px;
  --mm-qa-group-gap: ${QA_LAYOUT.GROUP_GAP_PX}px;

  /* Button baseline visuals */
  --mm-btn-border: 1px solid rgba(255,255,255,0.22);
  --mm-btn-bg: rgba(255,255,255,0.05);
  --mm-btn-bg-hover: rgba(255,255,255,0.08);
  --mm-btn-bg-active: rgba(255,255,255,0.12);
  --mm-q-btn-border: 1px solid rgba(255,255,255,0.16);
  --mm-q-btn-bg: ${QA_LAYOUT.QUESTION_BG};
  --mm-q-btn-bg-hover: rgba(255,255,255,0.045);
  --mm-q-btn-bg-active: rgba(255,255,255,0.065);
  --mm-btn-opacity: 0.5;

  --mm-active-ring-color: ${ACTIVE_RING.COLOR};
  --mm-active-ring-line-width: ${ACTIVE_RING.LINE_WIDTH_PX}px;
  --mm-active-ring-outline-width: ${ACTIVE_RING.OUTLINE_WIDTH_PX}px;
  --mm-active-ring-outline-offset: ${ACTIVE_RING.OUTLINE_OFFSET_PX}px;
  --mm-active-ring-glow-blur: ${ACTIVE_RING.GLOW_BLUR_PX}px;
  --mm-active-ring-glow-spread: ${ACTIVE_RING.GLOW_SPREAD_PX}px;
  --mm-active-ring-answer-line-opacity: ${ACTIVE_RING.ANSWER_LINE_OPACITY};
  --mm-active-ring-answer-glow-opacity: ${ACTIVE_RING.ANSWER_GLOW_OPACITY};
  --mm-active-ring-answer-outline-opacity: ${ACTIVE_RING.ANSWER_OUTLINE_OPACITY};
  --mm-active-ring-question-line-opacity: ${ACTIVE_RING.QUESTION_LINE_OPACITY};
  --mm-active-ring-question-glow-opacity: ${ACTIVE_RING.QUESTION_GLOW_OPACITY};
  --mm-active-ring-question-outline-opacity: ${ACTIVE_RING.QUESTION_OUTLINE_OPACITY};

  --mm-btn-shadow-inset: inset 0 0 0 1px rgba(255,255,255,0.12);
  --mm-btn-shadow-hover: inset 0 0 0 1px rgba(255,255,255,0.22), 0 4px 10px rgba(0,0,0,0.30);
  --mm-btn-shadow-active:
    inset 0 0 0 1px rgba(255,255,255,0.18),
    0 0 0 var(--mm-active-ring-line-width) color-mix(in srgb, var(--mm-active-ring-color) var(--mm-active-ring-answer-line-opacity), transparent),
    0 0 var(--mm-active-ring-glow-blur) color-mix(in srgb, var(--mm-active-ring-color) var(--mm-active-ring-answer-glow-opacity), transparent),
    0 0 calc(var(--mm-active-ring-glow-blur) * 0.6) var(--mm-active-ring-glow-spread) color-mix(in srgb, var(--mm-active-ring-color) var(--mm-active-ring-answer-glow-opacity), transparent);
  --mm-q-btn-shadow-inset: inset 0 0 0 1px rgba(255,255,255,0.08);
  --mm-q-btn-shadow-hover: inset 0 0 0 1px rgba(255,255,255,0.14), 0 2px 6px rgba(0,0,0,0.22);
  --mm-q-btn-shadow-active:
    inset 0 0 0 1px rgba(255,255,255,0.14),
    0 0 0 var(--mm-active-ring-line-width) color-mix(in srgb, var(--mm-active-ring-color) var(--mm-active-ring-question-line-opacity), transparent),
    0 0 calc(var(--mm-active-ring-glow-blur) * 0.6) color-mix(in srgb, var(--mm-active-ring-color) var(--mm-active-ring-question-glow-opacity), transparent);

  /* Button transitions */
  --mm-btn-trans-delay: 0.1s;
  --mm-btn-trans:
    background 0.45s ease-in-out,
    box-shadow 0.45s ease-in-out,
    color 0.5s ease,
    filter 0.4s ease,
    opacity 0.6s ease;

  --mm-flash-opacity: 0.25;
  --mm-flash-ms: 3500ms;
  --mm-flash-shadow: 0 0 4px rgba(255,215,0,0.65), inset 0 0 2px rgba(255,215,0,0.5);

  --mm-fade-a: 80px;
  --mm-fade-b: 55px;
  --mm-fade-c: 25px;
  --mm-fade-o1: 0.75;
  --mm-fade-o2: 0.45;
  --mm-fade-o3: 0.25;

  --toggle-bg: rgba(255,255,255,0.035);
  --toggle-shadow: inset 0 0 2px rgba(255,255,255,0.03), 0 2px 4px rgba(0,0,0,0.2);
  --toggle-shadow-hover: inset 0 1px 1px rgba(255,255,255,0.07), 0 3px 6px rgba(255,215,0,0.2);
  --toggle-text: rgba(255,255,255,0.4);
  --toggle-faded: 0.15;
  --toggle-faded-hover: 0.55;

  /* Modern UI typography for toggle + minimap numbers */
  --ui-font-modern: "SF Pro Display", "Inter Variable", "Inter", "Segoe UI Variable Text", "Aptos", "Helvetica Neue", Arial, sans-serif;
  --ui-font-numeric: "SF Pro Rounded", "SF Pro Display", "Inter Variable", "Inter", "Segoe UI Variable Text", "Aptos", "Helvetica Neue", Arial, sans-serif;

  --dial-x: var(--mm-x);
  --dial-y: calc(-1 * var(--stack-trim));
  --dial-inner-gap: 6px;
  --dial-inner-pad-x: 0px;
  --dial-slide-y: 0px;
  --dial-slide-y-hidden: 0px;
  --dial-fade-in-ms: 360ms;
  --dial-fade-out-ms: 920ms;
  --dial-fade-in-ease: cubic-bezier(0.22, 0.61, 0.36, 1);
  --dial-fade-out-ease: cubic-bezier(0.16, 1, 0.3, 1);
  --dial-fade-ms: var(--dial-fade-in-ms);
  --dial-fade-ease: var(--dial-fade-in-ease);

  --mm-scrollbar-w: 6px;
  --mm-scrollbar-thumb: #666;
  --mm-scrollbar-thumb-r: 4px;
  --mm-scrollbar-thumb-opacity: 0.5;
  --mm-scrollbar-thumb-opacity-hover: 1;

  /* Interaction rule */
  pointer-events: auto;
}
${S_ROOT} > * { pointer-events: auto; }
${S_ROOT}, ${S_MINIMAP} {
  transition: opacity 150ms ease !important;
}
${S_ROOT}.${PRELAYOUT_CLASS},
${S_MINIMAP}.${PRELAYOUT_CLASS} {
  opacity: 0 !important;
  pointer-events: none !important;
}

/* Theme tint only (Section 8 owns geometry/background/border) */

${S_BTN} {
  cursor: pointer;
  pointer-events: auto;
  user-select: none;
}

:root.dark ${S_BTN} { color: #ccc; }
:root.light ${S_BTN} { color: #333; }

@media (prefers-reduced-motion: reduce) {
  :root { --cgxui-mnmp-flash-ms: 800ms; }
}

/* Allow answer content to host wash/flash overlays */
[${ATTR_.MSG_ROLE}="assistant"] .markdown {
  position: relative;
}

/* Host element for wash + temporary flash */
.${CLS_.WASH_WRAP} {
  position: relative;
  z-index: 0;
}

/* One ::before rule per color (e.g. .cgxui-mnmp-wash-red::before) */
${COLORS.map(({ name, color }) => `
  .${CLS_.WASH_PREFIX}${name}::before {
    content: '';
    position: absolute;

    /* Extend wash above + below full answer block */
    top: var(--cgxui-mnmp-answer-wash-top);
    bottom: var(--cgxui-mnmp-answer-wash-bottom);

    /* Overflow horizontally across full viewport width */
    left: -100vw;
    right: -100vw;

    z-index: -1;              /* behind text */
    pointer-events: none;

    background: color-mix(in srgb, ${color} 50%, transparent);
    opacity: 0.08;            /* soft matte wash */
  }
`).join('')}

@keyframes cgxui-mnmp-flash-fade {
  0%   { opacity: 0; }
  25%  { opacity: var(--cgxui-mnmp-flash-peak); }
  75%  { opacity: var(--cgxui-mnmp-flash-peak); }
  100% { opacity: 0; }
}

.${CLS_.WASH_WRAP}.${CLS_.FLASH}::after,
.${CLS_.WASH_WRAP}[${ATTR_.CGXUI_FLASH}="1"]::after {
  content: '';
  position: absolute;
  left: -100vw;
  right: -100vw;

  background: color-mix(in srgb, gold 60%, transparent);
  box-shadow: 0 0 var(--cgxui-mnmp-flash-glow-blur) rgba(255, 215, 0, var(--cgxui-mnmp-flash-glow-alpha)); /* soft glow halo */
  opacity: 0;
  z-index: 0;
  pointer-events: auto;
  border-radius: var(--cgxui-mnmp-flash-radius);
  animation: cgxui-mnmp-flash-fade var(--cgxui-mnmp-flash-ms) var(--cgxui-mnmp-flash-ease);
}

.${CLS_.WASH_WRAP}[data-cgxui-flash-surface="question"]::after {
  top: var(--cgxui-mnmp-question-flash-top);
  bottom: var(--cgxui-mnmp-question-flash-bottom);
}

.${CLS_.WASH_WRAP}[data-cgxui-flash-surface="answer"]::after,
.${CLS_.WASH_WRAP}:not([data-cgxui-flash-surface])::after {
  top: var(--cgxui-mnmp-answer-flash-top);
  bottom: var(--cgxui-mnmp-answer-flash-bottom);
}

/* Legacy keyframe (kept for compatibility if referenced anywhere else) */
@keyframes h2oFlashFade {
  0%   { opacity: 0.9; }
  40%  { opacity: 0.5; }
  100% { opacity: 0; }
}

/* Message index label (if used as message number) */
.chatgpt-timestamp.msg-number {
  font-size: 14.5px;
  font-weight: 500;
  color: rgba(255, 215, 0, 0.7);      /* matte gold */
  margin-left: 8px;
  text-shadow: 0 0 1px rgba(255, 215, 0, 0.15);
}

@keyframes cgxui-mnmp-soft-fade {
  0%   { opacity: 0.14; }
  20%  { opacity: 0.12; }
  40%  { opacity: 0.09; }
  60%  { opacity: 0.06; }
  80%  { opacity: 0.03; }
  90%  { opacity: 0.015; }
  96%  { opacity: 0.007; }
  100% { opacity: 0.0001; }
}

/* Collapsed state (toggle OFF): fade out + block interaction */
${S_MINIMAP}[${ATTR_.CGXUI_STATE}~="collapsed"] {
  opacity: 0;
  visibility: hidden;
  pointer-events: none !important;
  height: 0 !important;
  min-height: 0 !important;
  max-height: 0 !important;
  padding-top: 0 !important;
  padding-bottom: 0 !important;
  border-width: 0 !important;
  overflow: hidden !important;
  z-index: ${Z_BELOW} !important;  /* keep toggle above */
}

${S_MINIMAP}[${ATTR_.CGXUI_STATE}~="collapsed"] *,
${S_MINIMAP}[${ATTR_.CGXUI_STATE}~="collapsed"]::before,
${S_MINIMAP}[${ATTR_.CGXUI_STATE}~="collapsed"]::after {
  pointer-events: none !important;
}

/* Collapsed state (toggle OFF): Dial follows MiniMap */
${S_DIAL}[${ATTR_.CGXUI_STATE}~="collapsed"] {
  opacity: 0;
  pointer-events: none;
  --dial-fade-ms: var(--dial-fade-out-ms);
  --dial-fade-ease: var(--dial-fade-out-ease);
  --dial-slide-y: var(--dial-slide-y-hidden);
}

${S_DIAL}:not([${ATTR_.CGXUI_STATE}~="collapsed"]) {
  opacity: 1 !important;
  pointer-events: auto;
  --dial-fade-ms: var(--dial-fade-in-ms);
  --dial-fade-ease: var(--dial-fade-in-ease);
  --dial-slide-y: 0px;
  transform: translate(
    calc(var(--axis-x, 0px) + var(--dial-x, 0px)),
    calc(var(--axis-y, 0px) + var(--dial-y, 0px) + var(--dial-slide-y, 0px))
  ) !important;
}

/* Collapsed state (toggle OFF): hide Dial too (same behavior as minimap) */
${S_ROOT} ${S_MINIMAP}[${ATTR_.CGXUI_STATE}~="collapsed"] ~ ${S_DIAL} {
  opacity: 0 !important;
  pointer-events: none !important;
  --dial-fade-ms: var(--dial-fade-out-ms);
  --dial-fade-ease: var(--dial-fade-out-ease);
  --dial-slide-y: var(--dial-slide-y-hidden);
}

/* Collapsed state (toggle OFF): hide Dial too (order-independent) */
${S_DIAL}[${ATTR_.CGXUI_STATE}~="collapsed"],
${S_ROOT}[${ATTR_.CGXUI_STATE}~="collapsed"] ${S_DIAL} {
  opacity: 0 !important;
  pointer-events: none !important;
  --dial-fade-ms: var(--dial-fade-out-ms);
  --dial-fade-ease: var(--dial-fade-out-ease);
  --dial-slide-y: var(--dial-slide-y-hidden);
}

${S_MINIMAP}{
  position: relative !important;
  order: 1;

  /* in-flow (no fixed) */
  top: auto !important;
  right: auto !important;

  /* center under stack axis */
  left: auto !important;
  transform: translate(
    calc(var(--axis-x) + var(--mm-x)),
    calc(var(--axis-y) + var(--mm-y))
  ) !important;

  /* width of the whole minimap "track" (btns + dots area via padding-left gutter) */
  width: var(--mm-w) !important;
  min-width: var(--mm-w) !important;

  /* scroll behavior */
  height: auto !important;

  max-height: min(var(--mm-max-vh), calc(100vh - var(--mm-max-sub))) !important;

  overflow-y: auto !important;
  overflow-x: visible !important;

  /* box model */
  margin: 0 !important;
  box-sizing: border-box !important;
  scrollbar-gutter: stable both-edges;

  padding-left:  var(--mm-side-lane) !important;
  padding-right: var(--mm-side-lane) !important;

  padding-bottom: var(--mm-pad-b) !important;
  scroll-padding-bottom: var(--mm-pad-b);
  padding-top: var(--mm-pad-t, 8px) !important;
  scroll-padding-top: var(--mm-pad-t, 8px) !important;

-webkit-mask-image: linear-gradient(to bottom,
  rgba(0,0,0,1) 0%,                                               /* keep = full visibility at top */
  rgba(0,0,0,1) calc(100% - var(--mm-fade-a)),                   /* 👈👈👈  ↑ Num. → fade starts higher (stronger) */
  rgba(0,0,0,var(--mm-fade-o1)) calc(100% - var(--mm-fade-b)),   /* 👈👈👈  ↓ Opacity → fade stronger earlier */
  rgba(0,0,0,var(--mm-fade-o2)) calc(100% - var(--mm-fade-c)),   /* 👈👈👈  ↑ Num. → longer ramp (smoother) */
  rgba(0,0,0,var(--mm-fade-o3)) 100%                             /* 👈👈👈  ↑ Final opacity → fade weaker (more visible) */
);
  -webkit-mask-size: 100% 100%;
  -webkit-mask-repeat: no-repeat;

  mask-image: linear-gradient(to bottom,
    rgba(0,0,0,1) 0%,
    rgba(0,0,0,1) calc(100% - 80px),
    rgba(0,0,0,0.75) calc(100% - 55px),
    rgba(0,0,0,0.45) calc(100% - 25px),
    rgba(0,0,0,0.25) 100%
  );
  mask-size: 100% 100%;
  mask-repeat: no-repeat;
}

/* Scrollbar styling (invisible, but scrolling still works) */ /* 👈👈👈 */
${S_MINIMAP}{
  scrollbar-width: none;        /* Firefox */
  -ms-overflow-style: none;     /* old Edge/IE */
}
${S_MINIMAP}::-webkit-scrollbar{
  width: 0 !important;          /* Chrome/Safari/Opera */
  height: 0 !important;
}
${S_MINIMAP}::-webkit-scrollbar-thumb{
  background: transparent !important;
}
${S_MINIMAP}::-webkit-scrollbar-track{
  background: transparent !important;
}

/* Inner column for MiniMap buttons */
${S_COL} {
  display: flex;
  flex-direction: column;
  gap: 6px;
  align-items: center;  /* center each row inside the 72px strip */
}

${S_TOGGLE}{
  /* --- Stack layout (authoritative) --- */
  position: relative !important;
  order: 0;
  top: auto !important;
  right: auto !important;
  left: auto !important;
  transform: translate(
    calc(var(--axis-x, 0px) + var(--toggle-x, var(--mm-x, 0px))),
    calc(var(--axis-y, 0px) + var(--toggle-y, 0px))
  ) !important;
  margin: 0 !important;
  align-self: center !important;
  z-index: ${Z} !important;

  width: var(--box-w) !important;
  height: var(--box-h) !important;
  border-radius: var(--box-r) !important;
  padding: 0 !important;
  box-sizing: border-box !important;

  /* --- Look & feel (preserved from fixed version) --- */
  background: rgba(255, 255, 255, 0.035);
  box-shadow:
    inset 0 0 2px rgba(255,255,255,0.03),
    0 2px 4px rgba(0,0,0,0.2);

  display: flex !important;
  align-items: center !important;
  justify-content: center !important;

  cursor: pointer;
  user-select: none;

  transition: all 0.2s ease;

  font: 500 13px/1 var(--ui-font-modern);
  font-variant-numeric: tabular-nums lining-nums;
  text-rendering: geometricPrecision;
  -webkit-font-smoothing: antialiased;
  color: rgba(255, 255, 255, 0.4);
  letter-spacing: 0.2px;
  text-shadow: 0 0 2px rgba(0,0,0,0.2);
}

${S_TOGGLE}:hover {
  filter: brightness(1.15);
  box-shadow:
    inset 0 1px 1px rgba(255, 255, 255, 0.07),
    0 3px 6px rgba(255, 215, 0, 0.2);
}

/* The collapsed entry keeps the same footprint and remains recognizable
   without hover. Expanded counter/pin presentation is preserved. */
${S_TOGGLE}[${ATTR_.CGXUI_STATE}~="faded"] {
  opacity: 1;
  background: var(--wb-surface, #2f2f2f);
  border: 1px solid rgba(255,215,0,0.55) !important;
  color: var(--wb-text, #ececec);
}
${S_ACCESS} {
  appearance: none;
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  box-sizing: border-box;
  margin: 0;
  padding: 0 0 8px;
  border: 0;
  border-radius: inherit;
  background: transparent;
  color: transparent;
  font: inherit;
  cursor: pointer;
}
${S_TOGGLE}[${ATTR_.CGXUI_STATE}~="faded"] ${S_ACCESS} {
  color: inherit;
}
${S_TOGGLE}[${ATTR_.CGXUI_STATE}~="faded"] ${S_COUNT} {
  visibility: hidden;
}
${S_ACCESS}:focus-visible {
  outline: 2px solid #FFD700;
  outline-offset: 3px;
}

/* Inner counter text on toggle */
${S_COUNT} {
  position: absolute;
  left: 50%;
  top: 8px;
  transform: translateX(-50%);
  font-family: var(--ui-font-numeric);
  font-weight: 520;
  font-size: 13.5px;
  font-variant-numeric: tabular-nums lining-nums;
  font-feature-settings: "tnum" 1, "lnum" 1;
  letter-spacing: 0.015em;
  color: rgba(243,245,251,0.94);
  margin: 0;
  padding: 0;
  line-height: 1;
  text-shadow: 0 1px 2px rgba(0,0,0,0.35);
  white-space: nowrap;
  -webkit-font-smoothing: antialiased;
  pointer-events: none;
}

${S_PINROW} {
  position: absolute;
  left: 50%;
  bottom: 3px;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: calc(100% - 14px);
  pointer-events: auto;
}

${S_DIAL_PINROW} {
  position: absolute;
  top: 3px;
  left: 0;
  right: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 7px;
  pointer-events: auto;
  z-index: 2;
}

${S_PIN_QUOTE}, ${S_PIN_QWASH}, ${S_PIN_REV}, ${S_DIAL_PIN_DOTS}, ${S_DIAL_PIN_TITLES}, ${S_DIAL_PIN_SYMBOLS} {
  width: 7px;
  height: 7px;
  min-width: 7px;
  min-height: 7px;
  padding: 0;
  margin: 0;
  border: 0;
  border-radius: 50%;
  background: rgba(255,255,255,0.24);
  color: rgba(255,255,255,0.58);
  box-shadow: none;
  font: 700 8px/1 var(--ui-font-modern);
  display: grid;
  place-items: center;
  cursor: pointer;
  opacity: 0.66;
  transition: opacity 0.16s ease, transform 0.16s ease, background 0.16s ease;
}

${S_PIN_QUOTE}:hover, ${S_PIN_QWASH}:hover, ${S_PIN_REV}:hover, ${S_DIAL_PIN_DOTS}:hover, ${S_DIAL_PIN_TITLES}:hover, ${S_DIAL_PIN_SYMBOLS}:hover {
  opacity: 0.9;
  background: rgba(255,255,255,0.35);
}

${S_PIN_QUOTE}.is-off, ${S_PIN_QWASH}.is-off, ${S_PIN_REV}.is-off, ${S_DIAL_PIN_DOTS}.is-off, ${S_DIAL_PIN_TITLES}.is-off, ${S_DIAL_PIN_SYMBOLS}.is-off {
  opacity: 0.28;
  background: rgba(255,255,255,0.13);
}

${S_PIN_QUOTE}:focus-visible, ${S_PIN_QWASH}:focus-visible, ${S_PIN_REV}:focus-visible, ${S_DIAL_PIN_DOTS}:focus-visible, ${S_DIAL_PIN_TITLES}:focus-visible, ${S_DIAL_PIN_SYMBOLS}:focus-visible {
  outline: 1px solid rgba(255,215,0,0.45);
  outline-offset: 1px;
}

${S_ROOT}.cgx-mm-hide-quotes .cgxui-mm-qfrom,
${S_ROOT}.cgx-mm-hide-quotes .cgxui-mm-qto {
  opacity: 0 !important;
  visibility: hidden !important;
  pointer-events: none !important;
}

${S_ROOT}.cgx-mm-hide-revs .cgxui-mm-qrev,
${S_ROOT}.cgx-mm-hide-revs .cgxui-mm-arev {
  opacity: 0 !important;
  visibility: hidden !important;
  pointer-events: none !important;
}

${S_ROOT}.cgx-mm-hide-qwash .cgxq-qwash-mm-num-on {
  opacity: 0 !important;
  visibility: hidden !important;
  pointer-events: none !important;
}

${S_ROOT}.cgx-mm-hide-dots ${S_DOTROW} {
  opacity: 0 !important;
  visibility: hidden !important;
  pointer-events: none !important;
}

${S_ROOT}.cgx-mm-hide-symbols .cgxui-mm-gutter,
${S_ROOT}.cgx-mm-hide-symbols .cgxui-mm-gutterSym {
  opacity: 0 !important;
  visibility: hidden !important;
  pointer-events: none !important;
}

/* Bottom Dial button */
${S_DIAL}{
  position: relative !important;
  order: 2;

  display: flex !important;
  align-items: center !important;
  justify-content: center !important;
  padding: 0 var(--dial-inner-pad-x, 0px) !important;
  gap: var(--dial-inner-gap, 6px) !important;
  opacity: 1 !important;
  z-index: ${Z} !important;

  top: auto !important;
  right: auto !important;

  left: auto !important;
  transform: translate(
    calc(var(--axis-x, 0px) + var(--dial-x, 0px)),
    calc(var(--axis-y, 0px) + var(--dial-y, 0px) + var(--dial-slide-y, 0px))
  ) !important;

  transition:
    opacity var(--dial-fade-ms, 360ms) var(--dial-fade-ease, cubic-bezier(0.22, 0.61, 0.36, 1)),
    transform 180ms ease-out,
    filter 180ms ease,
    box-shadow 180ms ease,
    background 180ms ease;

  width: var(--box-w) !important;
  height: var(--box-h) !important;
  border-radius: var(--box-r) !important;

  flex: 0 0 auto !important;
  min-width: 0 !important;

  margin: 0 !important;
  box-sizing: border-box !important;

  background: var(--toggle-bg);
  box-shadow: var(--toggle-shadow);

  cursor: pointer;
  user-select: none;

  pointer-events: auto;
}

${S_DIAL}:hover {
  filter: brightness(1.15);
  box-shadow:
    inset 0 1px 1px rgba(255, 255, 255, 0.07),
    0 3px 6px rgba(255, 215, 0, 0.2);
}

${S_DIAL}:active {
  filter: brightness(1.15);
  box-shadow:
    inset 0 1px 1px rgba(255, 255, 255, 0.07),
    0 3px 6px rgba(255, 215, 0, 0.2);
}

/* Keep vertical control stack order deterministic even if external CSS touches order */
${S_ROOT} > ${S_TOGGLE} { order: 0 !important; }
${S_ROOT} > ${S_MINIMAP} { order: 1 !important; }
${S_ROOT} > ${S_DIAL} { order: 2 !important; }

${S_TOGGLE}, ${S_DIAL}{
  width: var(--box-w) !important;
  height: var(--box-h) !important;
  border-radius: var(--box-r) !important;

  box-sizing: border-box !important;
  border: 0 !important;
  line-height: normal !important;

  flex: 0 0 auto !important;
  min-width: 0 !important;
}

${S_DIAL_UP}, ${S_DIAL_DOWN}{
  width: 20px;
  height: 20px;
  border-radius: 8px;
  background: transparent;
  border: 1px solid rgba(255,255,255,0.16);

  display: grid;
  place-items: center;

  cursor: pointer;
  pointer-events: auto;
  user-select: none;

  opacity: 0.55;
  transition: opacity 0.18s ease, filter 0.18s ease, transform 0.18s ease, border-color 0.18s ease;
  margin: 1px 0 0 !important;

  position: relative;
  top: 2px;   /* increase to 2px if needed */

  flex: 0 0 auto;
}

/* Sleek chevrons */
${S_DIAL_UP} svg,
${S_DIAL_DOWN} svg {
  width: 11px;
  height: 11px;
  fill: none;
  stroke: rgba(255,255,255,0.68);
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
  filter: drop-shadow(0 0 1px rgba(0,0,0,0.35));
}

${S_DIAL_UP}:hover,
${S_DIAL_DOWN}:hover {
  opacity: 0.9;
  filter: brightness(1.15);
  border-color: rgba(255,215,0,0.32);
}

${S_DIAL_UP}:active,
${S_DIAL_DOWN}:active {
  transform: translateY(0.5px);
}

${S_DIAL_UP}:hover, ${S_DIAL_DOWN}:hover{
  filter: brightness(1.18);
  background: rgba(255,255,255,0.07);
  color: rgba(255,255,255,0.85);
}

${S_DIAL_UP}:active, ${S_DIAL_DOWN}:active{
  filter: brightness(1.05);
  background: rgba(255,255,255,0.09);
}

/* MiniMap Button — unified (was split into “fill wrapper” + “geometry”).
   Think of it like: ONE canonical button style that contains BOTH:
   - layout/flex centering + user-select + baseline inset border (old 100%/100% block)
   - final geometry (56×24), transitions, opacity, and premium feel (old fixed-size block)
*/

${S_BTN}{
  /* --- Core geometry (authoritative) --- */
  width: var(--mm-btn-w) !important;
  height: var(--mm-btn-h) !important;

  /* Kill any legacy shove */
  margin-left: 0 !important;
  margin-right: 0 !important;

  /* --- Layout / interaction --- */
  display: flex;
  align-items: center;
  justify-content: center;

  position: relative !important;
  cursor: pointer;
  pointer-events: auto;
  user-select: none;
  overflow: visible;
  box-sizing: border-box;

  /* --- Typography --- */
  font-size: 12px;
  line-height: 1;
  font-family: var(--ui-font-numeric);
  font-weight: 460;
  font-variant-numeric: tabular-nums lining-nums;
  font-feature-settings: "tnum" 1, "lnum" 1;
  letter-spacing: 0.02em;
  text-rendering: geometricPrecision;
  -webkit-font-smoothing: antialiased;

  /* --- Visual baseline --- */
  border-radius: var(--mm-btn-r);
  border: var(--mm-btn-border);

  background: var(--mm-btn-bg);
  opacity: var(--mm-btn-opacity);
  box-shadow: var(--mm-btn-shadow-inset);

  color: #e5e7eb !important;
  text-shadow: 0 0 2px rgba(0, 0, 0, 0.25);

  /* --- Motion/perf --- */
  transition: var(--mm-btn-trans);
  transition-delay: var(--mm-btn-trans-delay);

  contain: paint;
  will-change: opacity, transform;

  -webkit-tap-highlight-color: transparent;

}

/* Hover: keep both old hover looks (rim + lift) */
${S_BTN}:hover{
  color: white;
  background: var(--mm-btn-bg-hover);
  box-shadow: var(--mm-btn-shadow-hover);
}

/* Active: merge both active glows */
${S_BTN}[${ATTR_.CGXUI_STATE}~="active"]{
  background: var(--mm-btn-bg-active);
  box-shadow: var(--mm-btn-shadow-active);
}

${S_QBTN}{
  width: var(--mm-btn-w) !important;
  height: var(--mm-q-btn-h) !important;
  margin-left: 0 !important;
  margin-right: 0 !important;

  display: flex !important;
  align-items: center !important;
  justify-content: center !important;

  position: relative !important;
  cursor: pointer;
  pointer-events: auto;
  user-select: none;
  overflow: hidden !important;
  box-sizing: border-box !important;

  border-radius: var(--mm-q-btn-r) !important;
  border: var(--mm-q-btn-border) !important;

  background: var(--mm-q-btn-bg) !important;
  opacity: var(--mm-btn-opacity) !important;
  box-shadow: var(--mm-q-btn-shadow-inset) !important;

  color: rgba(229,231,235,0.82) !important;
  text-shadow: none !important;

  transition: var(--mm-btn-trans) !important;
  transition-delay: var(--mm-btn-trans-delay) !important;

  contain: paint;
  will-change: opacity, transform;
  -webkit-tap-highlight-color: transparent;
}

${S_QBTN}::before{
  content: "";
  position: absolute;
  inset: 0;
  border-radius: inherit;
  background: transparent;
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.2s ease, background 0.2s ease;
}

${S_QBTN}:hover{
  background: var(--mm-q-btn-bg-hover) !important;
  box-shadow: var(--mm-q-btn-shadow-hover) !important;
  opacity: 0.86 !important;
}

${S_QBTN}[${ATTR_.CGXUI_STATE}~="peer-active"],
${S_QBTN}[${ATTR_.CGXUI_INVIEW}="1"]{
  background: var(--mm-q-btn-bg-active) !important;
  box-shadow: var(--mm-q-btn-shadow-active) !important;
  opacity: 0.92 !important;
  outline: var(--mm-active-ring-outline-width) solid color-mix(in srgb, var(--mm-active-ring-color) var(--mm-active-ring-question-outline-opacity), transparent) !important;
  outline-offset: var(--mm-active-ring-outline-offset) !important;
}

${S_QBTN}:focus,
${S_QBTN}:focus-visible{
  outline: none !important;
  box-shadow: none !important;
}

${S_QBTN}[${ATTR_.CGXUI_STATE}~="peer-active"]:focus,
${S_QBTN}[${ATTR_.CGXUI_STATE}~="peer-active"]:focus-visible,
${S_QBTN}[${ATTR_.CGXUI_INVIEW}="1"]:focus,
${S_QBTN}[${ATTR_.CGXUI_INVIEW}="1"]:focus-visible{
  box-shadow: var(--mm-q-btn-shadow-active) !important;
}

${S_MINIMAP}[${ATTR_.CGXUI_VIEW}="qa"] ${S_QBTN}[${ATTR_.CGXUI_WASH}="1"]::before{
  background: color-mix(in srgb, var(--cgxui-mnmp-q-wash-color, transparent) 26%, transparent);
  opacity: 1;
}

${S_MINIMAP}[${ATTR_.CGXUI_VIEW}="qa"] ${S_QBTN}[${ATTR_.CGXUI_WASH}="1"]{
  border-color: color-mix(in srgb, var(--cgxui-mnmp-q-wash-color, rgba(255,255,255,0.16)) 50%, rgba(255,255,255,0.16)) !important;
  box-shadow:
    var(--mm-q-btn-shadow-inset),
    inset 0 0 0 1px color-mix(in srgb, var(--cgxui-mnmp-q-wash-color, transparent) 18%, transparent),
    0 0 8px color-mix(in srgb, var(--cgxui-mnmp-q-wash-color, transparent) 18%, transparent) !important;
}

${S_MINIMAP}[${ATTR_.CGXUI_VIEW}="qa"] ${S_QBTN}[${ATTR_.CGXUI_WASH}="1"][${ATTR_.CGXUI_STATE}~="peer-active"],
${S_MINIMAP}[${ATTR_.CGXUI_VIEW}="qa"] ${S_QBTN}[${ATTR_.CGXUI_WASH}="1"][${ATTR_.CGXUI_INVIEW}="1"]{
  box-shadow:
    var(--mm-q-btn-shadow-active),
    inset 0 0 0 1px color-mix(in srgb, var(--cgxui-mnmp-q-wash-color, transparent) 22%, transparent),
    0 0 10px color-mix(in srgb, var(--cgxui-mnmp-q-wash-color, transparent) 22%, transparent) !important;
}

${S_DOTROW} {
  position: absolute;
  top: 50%;
  transform: translateY(-50%);
  display: grid;
  align-items: center;
  justify-items: center;
  pointer-events: auto;
  z-index: 10;
  box-sizing: content-box;
  contain: paint;

  grid-template-columns: repeat(var(--mm-dot-cols), var(--mm-dot-size));
  grid-auto-rows: var(--mm-dot-size);
  column-gap: var(--mm-dot-col-gap);
  row-gap: var(--mm-dot-row-gap);
  left: var(--mm-dot-x) !important;
}

${S_MINIMAP}[${ATTR_.CGXUI_VIEW}="qa"] ${S_DOTROW}[data-h2o-dot-surface="question"] {
  top: calc(var(--mm-q-btn-h) / 2) !important;
}

${S_MINIMAP}[${ATTR_.CGXUI_VIEW}="qa"] ${S_DOTROW}[data-h2o-dot-surface="answer"] {
  top: calc(var(--mm-q-btn-h) + var(--mm-qa-gap) + (var(--mm-btn-h) / 2) + 1px) !important;
}

${S_BTN}[${ATTR_.CGXUI_FLASH}="1"]::after {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: 6px;
  background: color-mix(in srgb, gold 80%, transparent);
  opacity: 0.25;
  animation: cgxui-mnmp-soft-fade 3.5s ease-in-out;
  pointer-events: none;
  z-index: 1;
  box-shadow:
    0 0 4px rgba(255, 215, 0, 0.65),
    inset 0 0 2px rgba(255, 215, 0, 0.5);
}

${S_BTN}[${ATTR_.CGXUI_INVIEW}="1"] {
  position: relative;
  z-index: 3;
  background: color-mix(in srgb, currentColor 25%, rgba(0, 0, 0, 0.8));
  outline: var(--mm-active-ring-outline-width) solid color-mix(in srgb, var(--mm-active-ring-color) var(--mm-active-ring-answer-outline-opacity), transparent);
  outline-offset: var(--mm-active-ring-outline-offset);
  box-shadow:
    0 0 calc(var(--mm-active-ring-glow-blur) * 0.4) 1px color-mix(in srgb, var(--mm-active-ring-color) var(--mm-active-ring-answer-glow-opacity), transparent),
    0 0 var(--mm-active-ring-glow-blur) calc(var(--mm-active-ring-glow-spread) * 2) color-mix(in srgb, var(--mm-active-ring-color) var(--mm-active-ring-answer-glow-opacity), transparent);
  filter: brightness(0.85);
  opacity: 1 !important;
  transition:
    outline 0.3s ease,
    box-shadow 0.3s ease,
    filter 0.3s ease,
    background 0.3s ease;
}

${S_BTN}[${ATTR_.CGXUI_STATE}~="noanswer"]{
}

${S_BTN}[${ATTR_.CGXUI_STATE}~="noanswer"] .cgxui-mm-num{
  opacity: 0.26;
  animation: cgxui-mnmp-noanswer-num-breathe 2.8s ease-in-out infinite;
}

${S_BTN} .cgxui-mm-num{
  position: absolute;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  display: inline-block; /* keeps opacity animation behavior */
  background: transparent;
  border: 0;
  padding: 0;
  margin: 0 !important;
  border-radius: 0;
  box-shadow: none;
  outline: none;
  pointer-events: none;
}

@keyframes cgxui-mnmp-noanswer-num-breathe{
  0%   { opacity: 0.18; }
  50%  { opacity: 0.34; }
  100% { opacity: 0.18; }
}

${S_BTN}[${ATTR_.CGXUI_STATE}~="rev"]::before{
  content: '';
  position: absolute;
  inset: 0;
  border-radius: 6px;
  pointer-events: none;
  z-index: 2;

  background: repeating-linear-gradient(
    135deg,
    rgba(255,255,255,0.18) 0px,
    rgba(255,255,255,0.18) 5px,
    rgba(255,255,255,0.05) 5px,
    rgba(255,255,255,0.05) 10px
  );

  /* tiny rim so the pattern reads even on low-contrast themes */
  box-shadow: inset 0 0 0 1px rgba(255,255,255,0.10);

  opacity: 0.42;
}
${S_BTN}[${ATTR_.CGXUI_STATE}~="rev"][${ATTR_.CGXUI_STATE}~="active"]::before,
${S_BTN}[${ATTR_.CGXUI_STATE}~="rev"][${ATTR_.CGXUI_INVIEW}="1"]::before{
  opacity: 0.60;
}

${S_BTN}:focus,
${S_BTN}:focus-visible {
  outline: none !important;
  box-shadow: none;
}

/* Keep your active glow even if the button is focused */
${S_BTN}[${ATTR_.CGXUI_STATE}~="active"]:focus,
${S_BTN}[${ATTR_.CGXUI_STATE}~="active"]:focus-visible {
  box-shadow:
    inset 0 0 0 1px rgba(255,255,255,0.18),
    0 0 0 1px rgba(255, 215, 0, 0.85),
    0 0 8px rgba(255, 215, 0, 0.35) !important;
}

${S_ROOT}[data-cgxui-page-dividers="0"] .cgxui-mm-page-divider,
${S_MINIMAP}[data-cgxui-page-dividers="0"] .cgxui-mm-page-divider{
  display: none !important;
}
html[data-cgxui-chat-pages="0"] .cgxui-chat-page-divider,
html[data-cgxui-chat-pages="0"] [data-cgxui-chat-page-divider="1"]{
  display: none !important;
}
html [data-cgxui-chat-page-hidden="1"]{
  display: none !important;
}
/* ── React-resistant sibling/toolbar hiding ──
   Stamped on thinking blocks, "Quick answer", toolbars etc. when a turn is collapsed.
   Uses !important so it survives ChatGPT's stylesheet rules AND React re-renders
   that would reset inline styles but leave data attributes intact. */
html [data-cgxui-at-hidden="1"] {
  height: 0 !important;
  max-height: 0 !important;
  min-height: 0 !important;
  overflow: hidden !important;
  opacity: 0 !important;
  pointer-events: none !important;
  margin-top: 0 !important;
  margin-bottom: 0 !important;
  padding-top: 0 !important;
  padding-bottom: 0 !important;
  border-top-width: 0 !important;
  border-bottom-width: 0 !important;
}

html [data-cgxui-chat-page-question-hidden="1"]{
  display: none !important;
}

/* ══════════════════════════════════════════════════════════════════
   COMPACT TITLE-LIST ROWS
   These rules use permanent CSS (not inline styles) so they survive
   React re-renders that would reset inline style properties.
   ══════════════════════════════════════════════════════════════════ */

/* ── The turn host itself ── */
html [data-cgxui-chat-page-title-item="1"]{
  min-height: 0 !important;
  padding-top: 0 !important;
  padding-bottom: 0 !important;
  padding-left: 0 !important;
  padding-right: 0 !important;
  margin-top: 0 !important;
  margin-bottom: var(--cgxui-title-list-row-gap, 4px) !important;
  gap: 0 !important;
  border-top-width: 0 !important;
  border-bottom-width: 0 !important;
  overflow: visible !important;
}

/* ── ALL direct children of the host except the title bar ──
   This zeros the inner padding wrapper (py-5 / agent-turn / flex wrappers)
   at every depth using child + descendant combinator combos.
   Using data-cgxui-chat-page-title-item on the host means we don't need to
   stamp individual wrapper elements — the CSS reaches them via :not() filter. */
html [data-cgxui-chat-page-title-item="1"] > *:not([data-cgxui="atns-answer-title"]) {
  min-height: 0 !important;
  padding-top: 0 !important;
  padding-bottom: 0 !important;
  margin-top: 0 !important;
  margin-bottom: 0 !important;
  gap: 0 !important;
  border-top-width: 0 !important;
  border-bottom-width: 0 !important;
}

/* ── ALL deeper descendants (grandchildren etc.) except the title bar and its contents ──
   Zeros wrappers at ANY depth between the host and the assistant message element. */
html [data-cgxui-chat-page-title-item="1"] *:not([data-cgxui="atns-answer-title"]):not([data-cgxui-owner="atns"]) {
  min-height: 0 !important;
  padding-top: 0 !important;
  padding-bottom: 0 !important;
  margin-top: 0 !important;
  margin-bottom: 0 !important;
  gap: 0 !important;
  border-top-width: 0 !important;
  border-bottom-width: 0 !important;
}

/* ── Individually named wrappers (belt-and-suspenders for common ChatGPT class names) ── */
html [data-cgxui-chat-page-title-wrapper="1"]{
  min-height: 0 !important;
  padding-top: 0 !important;
  padding-bottom: 0 !important;
  padding-left: 0 !important;
  padding-right: 0 !important;
  margin-top: 0 !important;
  margin-bottom: 0 !important;
  gap: 0 !important;
  border-top-width: 0 !important;
  border-bottom-width: 0 !important;
  overflow: visible !important;
}

/* ── Title bar inside a compact row: always visible, tight spacing ── */
html [data-cgxui-chat-page-title-item="1"] [data-cgxui="atns-answer-title"][data-cgxui-owner="atns"]{
  display: inline-flex !important;
  visibility: visible !important;
  opacity: 1 !important;
  pointer-events: auto !important;
  margin-top: 0 !important;
  margin-bottom: var(--cgxui-title-list-row-gap, 4px) !important;
  max-height: none !important;
  height: auto !important;
  overflow: visible !important;
  padding-top: initial !important;
  padding-bottom: initial !important;
}

/* ── Contents of title bar must NOT be zeroed by the wildcard rule above ── */
html [data-cgxui-chat-page-title-item="1"] [data-cgxui="atns-answer-title"][data-cgxui-owner="atns"] *{
  min-height: revert !important;
  padding-top: revert !important;
  padding-bottom: revert !important;
  margin-top: revert !important;
  margin-bottom: revert !important;
  gap: revert !important;
  border-top-width: revert !important;
  border-bottom-width: revert !important;
}

/* ── No-answer host: must stay block so its bar is visible ── */
html [data-cgxui-chat-page-no-answer="1"][data-cgxui-chat-page-title-item="1"]{
  display: block !important;
}

/* ── No-answer bar: always visible and interactive ── */
html [data-cgxui-chat-page-no-answer="1"] [data-cgxui="atns-answer-title"][data-at-no-answer="1"]{
  display: inline-flex !important;
  visibility: visible !important;
  opacity: 1 !important;
  max-height: none !important;
  height: auto !important;
  overflow: visible !important;
  pointer-events: auto !important;
}


.cgxui-chat-page-divider,
.cgxui-pgnw-page-divider[data-cgxui-chat-page-divider="1"]{
  --cgxui-chat-page-left-inset: ${CHAT_PAGE_DIVIDER_LAYOUT.LEFT_INSET_PX}px;
  --cgxui-chat-page-right-inset: ${CHAT_PAGE_DIVIDER_LAYOUT.RIGHT_INSET_PX}px;
}
.cgxui-chat-page-divider{
  display:flex;
  align-items:center;
  justify-content:center;
  gap:${CHAT_PAGE_DIVIDER_LAYOUT.ROW_GAP_PX}px;
  margin: ${CHAT_PAGE_DIVIDER_LAYOUT.MARGIN_TOP_PX}px 0 ${CHAT_PAGE_DIVIDER_LAYOUT.MARGIN_BOTTOM_PX}px;
  box-sizing: border-box;
  position: relative;
  z-index: 0;
  --cgxui-chat-page-fg: rgba(243,244,246,0.98);
  --cgxui-chat-page-border: rgba(255,255,255,0.12);
  --cgxui-chat-page-bg: rgba(45,48,56,0.96);
}
.cgxui-chat-page-divider-line{
  flex: 1 1 ${CHAT_PAGE_DIVIDER_LAYOUT.LINE_LENGTH_PX}px;
  max-width: ${CHAT_PAGE_DIVIDER_LAYOUT.LINE_LENGTH_PX}px;
  min-width: 24px;
  height: ${CHAT_PAGE_DIVIDER_LAYOUT.LINE_WIDTH_PX}px;
  background: linear-gradient(
    90deg,
    transparent 0%,
    color-mix(in srgb, var(--cgxui-chat-page-border) 85%, white 15%) 12%,
    color-mix(in srgb, var(--cgxui-chat-page-border) 88%, white 12%) 88%,
    transparent 100%
  );
  opacity: 0.9;
}

.cgxui-chat-page-divider-line:first-child,
.cgxui-chat-page-divider-line:last-child{
  margin-left: 0;
  margin-right: 0;
}
.cgxui-chat-page-divider-label,
.cgxui-pgnw-page-divider-pill{
  flex:0 0 auto;
  display:inline-flex;
  align-items:center;
  justify-content:center;
  gap: 8px;
  min-width: 108px;
  padding: 7px 14px;
  border-radius: 999px;
  border:1px solid var(--cgxui-chat-page-border, var(--pgnw-band-border));
  background: color-mix(in srgb, var(--cgxui-chat-page-bg, var(--pgnw-band-bg)) 82%, transparent);
  color: var(--cgxui-chat-page-fg, var(--pgnw-band-fg));
  font: 700 11px/1.1 ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  white-space: nowrap;
}
.cgxui-chat-page-divider-text,
.cgxui-pgnw-page-divider-text{
  display:inline-block;
}
.cgxui-chat-page-divider-dot,
.cgxui-pgnw-page-divider-dot{
  width: 8px;
  height: 8px;
  min-width: 8px;
  min-height: 8px;
  border-radius: 999px;
  background: color-mix(in srgb, currentColor 82%, transparent);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, currentColor 18%, transparent);
  opacity: 0.92;
  cursor: pointer;
  transition: opacity 0.18s ease, filter 0.18s ease, background 0.18s ease, transform 0.18s ease;
}
.cgxui-chat-page-divider[data-cgxui-chat-page-title-state="expanded"] .cgxui-chat-page-divider-dot,
.cgxui-pgnw-page-divider[data-cgxui-chat-page-title-state="expanded"] .cgxui-pgnw-page-divider-dot{
  opacity: 0.95;
  filter: saturate(1.05) brightness(1.04);
}
.cgxui-chat-page-divider[data-cgxui-chat-page-title-state="mixed"] .cgxui-chat-page-divider-dot,
.cgxui-pgnw-page-divider[data-cgxui-chat-page-title-state="mixed"] .cgxui-pgnw-page-divider-dot{
  opacity: 0.72;
  filter: saturate(0.82) brightness(0.92);
}
.cgxui-chat-page-divider[data-cgxui-chat-page-title-state="collapsed"] .cgxui-chat-page-divider-dot,
.cgxui-pgnw-page-divider[data-cgxui-chat-page-title-state="collapsed"] .cgxui-pgnw-page-divider-dot{
  opacity: 0.42;
  filter: saturate(0.55) brightness(0.82);
}
.cgxui-chat-page-divider-dot:hover,
.cgxui-pgnw-page-divider-dot:hover{
  transform: scale(1.08);
}
.cgxui-chat-page-divider,
.cgxui-pgnw-page-divider[data-cgxui-chat-page-divider="1"]{
  cursor: pointer;
}
.cgxui-chat-page-divider:hover .cgxui-chat-page-divider-label,
.cgxui-pgnw-page-divider[data-cgxui-chat-page-divider="1"]:hover .cgxui-pgnw-page-divider-pill{
  filter: brightness(1.12) saturate(1.1);
}
.cgxui-chat-page-divider-label:focus,
.cgxui-chat-page-divider-label:focus-visible{
  outline: 2px solid color-mix(in srgb, var(--cgxui-chat-page-border) 60%, white 40%);
  outline-offset: 2px;
}
.cgxui-pgnw-page-divider[data-cgxui-chat-page-divider="1"] > .cgxui-pgnw-page-divider-line{
  flex: 1 1 ${CHAT_PAGE_DIVIDER_LAYOUT.LINE_LENGTH_PX}px;
  max-width: ${CHAT_PAGE_DIVIDER_LAYOUT.LINE_LENGTH_PX}px;
  height: ${CHAT_PAGE_DIVIDER_LAYOUT.LINE_WIDTH_PX}px;
}
.cgxui-pgnw-page-divider[data-cgxui-chat-page-divider="1"] > .cgxui-pgnw-page-divider-line:first-child{
  margin-left: var(--cgxui-chat-page-left-inset);
}
.cgxui-pgnw-page-divider[data-cgxui-chat-page-divider="1"] > .cgxui-pgnw-page-divider-line:last-child{
  margin-right: var(--cgxui-chat-page-right-inset);
}
.cgxui-pgnw-page-divider[data-cgxui-chat-page-divider="1"]{
  justify-content: center;
  position: relative;
  z-index: 0;
  margin: ${CHAT_PAGE_DIVIDER_LAYOUT.MARGIN_TOP_PX}px 0 ${CHAT_PAGE_DIVIDER_LAYOUT.MARGIN_BOTTOM_PX}px;
}
.cgxui-chat-page-divider[data-cgxui-chat-page-collapsed="1"] .cgxui-chat-page-divider-label,
.cgxui-pgnw-page-divider[data-cgxui-chat-page-collapsed="1"] .cgxui-pgnw-page-divider-pill{
  opacity: 0.65;
  filter: saturate(0.5) brightness(0.85);
  outline: 1px dashed color-mix(in srgb, currentColor 35%, transparent);
  outline-offset: 3px;
}
.cgxui-chat-page-divider[data-page-band="normal"]{
  --cgxui-chat-page-fg: rgba(236,253,245,0.98);
  --cgxui-chat-page-border: rgba(16,185,129,0.24);
  --cgxui-chat-page-bg: rgba(5,150,105,0.34);
}
.cgxui-chat-page-divider[data-page-band="teal"]{
  --cgxui-chat-page-fg: rgba(254,252,232,0.98);
  --cgxui-chat-page-border: rgba(250,204,21,0.24);
  --cgxui-chat-page-bg: rgba(161,98,7,0.34);
}
.cgxui-chat-page-divider[data-page-band="blue"]{
  --cgxui-chat-page-fg: rgba(239,246,255,0.98);
  --cgxui-chat-page-border: rgba(96,165,250,0.24);
  --cgxui-chat-page-bg: rgba(29,78,216,0.34);
}
.cgxui-chat-page-divider[data-page-band="darkred"]{
  --cgxui-chat-page-fg: rgba(254,242,242,0.98);
  --cgxui-chat-page-border: rgba(220,38,38,0.24);
  --cgxui-chat-page-bg: rgba(153,27,27,0.34);
}
.cgxui-chat-page-divider[data-page-band="violet"]{
  --cgxui-chat-page-fg: rgba(245,243,255,0.98);
  --cgxui-chat-page-border: rgba(139,92,246,0.24);
  --cgxui-chat-page-bg: rgba(109,40,217,0.34);
}
${S_ROOT} ${S_WRAP}[data-page-collapsed="1"],
${S_MINIMAP} ${S_WRAP}[data-page-collapsed="1"]{
  display: none !important;
}

.cgxui-mm-page-divider{
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  margin: 7px 0 6px;
  padding: 0 4px;
  box-sizing: border-box;
  opacity: 0.92;
  position: relative;
  z-index: 2;
}
.cgxui-mm-page-divider-line{
  flex: 0 0 12px;
  width: 12px;
  min-width: 12px;
  max-width: 12px;
  height: 1px;
  background: rgba(255,255,255,0.14);
  opacity: 0.82;
}
.cgxui-mm-page-divider-label{
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font: inherit;
  font-size: 10px;
  line-height: 1;
  letter-spacing: .05em;
  text-transform: uppercase;
  appearance: none;
  min-width: 42px;
  min-height: 16px;
  border: 1px solid rgba(255,255,255,0.12);
  background: rgba(255,255,255,0.04);
  padding: 1px 6px;
  margin: 0;
  border-radius: 6px;
  box-sizing: border-box;
  color: rgba(229,231,235,0.72);
  cursor: pointer;
  transition: color 0.18s ease, background 0.18s ease, border-color 0.18s ease, text-shadow 0.18s ease, transform 0.18s ease;
}
.cgxui-mm-page-divider-label{
  border-radius: 999px;
  padding: 2px 7px;
}
.cgxui-mm-page-divider[data-page-collapsed="1"] .cgxui-mm-page-divider-label{
  opacity: 0.96;
}
.cgxui-mm-page-divider-label:hover{
  transform: translateY(-1px);
}
.cgxui-mm-page-divider-label:focus,
.cgxui-mm-page-divider-label:focus-visible{
  outline: none;
  background: rgba(255,255,255,0.06);
}
.cgxui-mm-page-divider[data-page-band="normal"] .cgxui-mm-page-divider-label{
  color: #34d399;
  border-color: rgba(52,211,153,0.26);
  background: rgba(5,150,105,0.10);
  text-shadow: 0 0 8px rgba(16,185,129,0.24);
}
.cgxui-mm-page-divider[data-page-band="teal"] .cgxui-mm-page-divider-label{
  color: #facc15;
  border-color: rgba(250,204,21,0.24);
  background: rgba(161,98,7,0.10);
  text-shadow: 0 0 8px rgba(250,204,21,0.24);
}
.cgxui-mm-page-divider[data-page-band="blue"] .cgxui-mm-page-divider-label{
  color: #60a5fa;
  border-color: rgba(96,165,250,0.24);
  background: rgba(37,99,235,0.10);
  text-shadow: 0 0 8px rgba(96,165,250,0.24);
}
.cgxui-mm-page-divider[data-page-band="darkred"] .cgxui-mm-page-divider-label{
  color: #f87171;
  border-color: rgba(248,113,113,0.24);
  background: rgba(127,29,29,0.12);
  text-shadow: 0 0 8px rgba(248,113,113,0.24);
}
.cgxui-mm-page-divider[data-page-band="violet"] .cgxui-mm-page-divider-label{
  color: #c4b5fd;
  border-color: rgba(196,181,253,0.24);
  background: rgba(109,40,217,0.12);
  text-shadow: 0 0 8px rgba(196,181,253,0.24);
}
.cgxui-mm-page-divider[data-page-band="teal"] .cgxui-mm-page-divider-line{
  background: rgba(250,204,21,0.20);
}
.cgxui-mm-page-divider[data-page-band="blue"] .cgxui-mm-page-divider-line{
  background: rgba(96,165,250,0.20);
}
.cgxui-mm-page-divider[data-page-band="darkred"] .cgxui-mm-page-divider-line{
  background: rgba(248,113,113,0.22);
}
.cgxui-mm-page-divider[data-page-band="violet"] .cgxui-mm-page-divider-line{
  background: rgba(196,181,253,0.22);
}

.cgxui-mm-divider-layer{
  position: absolute;
  left: 0;
  right: 0;
  pointer-events: none;
  z-index: 1;
  --mm-divider-left-inset: calc(var(--mm-dot-x) + ${DIVIDER_LAYOUT.LEFT_INSET_PX}px);
  --mm-divider-right-inset: calc((var(--mm-side-lane) - var(--mm-gutter-outset)) + ${DIVIDER_LAYOUT.RIGHT_INSET_PX}px);
}
.cgxui-mm-overlay-divider{
  position: absolute;
  left: 0;
  right: 0;
  height: 8px;
  transform: translateY(-50%);
  pointer-events: auto;
  cursor: ns-resize;
  touch-action: none;
}
.cgxui-mm-overlay-divider-hit{
  position: absolute;
  inset: 0;
}
.cgxui-mm-overlay-divider-line{
  position: absolute;
  left: var(--mm-divider-left-inset);
  right: var(--mm-divider-right-inset);
  top: calc(50% - ${DIVIDER_LAYOUT.LINE_WIDTH_PX * 0.5}px - ${DIVIDER_LAYOUT.LINE_OFFSET_UP_PX}px);
  height: ${DIVIDER_LAYOUT.LINE_WIDTH_PX}px;
  background: var(--cgxui-mm-overlay-divider-color, #facc15);
  opacity: ${DIVIDER_LAYOUT.LINE_OPACITY};
  box-shadow: none;
  transition: opacity 0.18s ease, filter 0.18s ease;
}
.cgxui-mm-overlay-divider[data-divider-style="dashed"] .cgxui-mm-overlay-divider-line{
  background:
    repeating-linear-gradient(
      90deg,
      var(--cgxui-mm-overlay-divider-color, #facc15) 0 7px,
      transparent 7px 12px
    );
}
.cgxui-mm-overlay-divider[data-divider-style="dotted"] .cgxui-mm-overlay-divider-line{
  background:
    radial-gradient(circle, var(--cgxui-mm-overlay-divider-color, #facc15) 0 62%, transparent 68%) left center / 8px 100% repeat-x;
}
.cgxui-mm-overlay-divider:hover .cgxui-mm-overlay-divider-line,
.cgxui-mm-overlay-divider[data-selected="1"] .cgxui-mm-overlay-divider-line{
  opacity: 0.5;
  filter: brightness(1.04);
}

${S_BTN} .cgxui-mm-num{
  color: #e5e7eb !important;
}
${S_COUNT}[data-page-band="normal"],
${S_TOGGLE}[data-page-band="normal"] ${S_COUNT}{
  color: #34d399;
  text-shadow: 0 0 8px rgba(16,185,129,0.24);
}
${S_COUNT}[data-page-band="teal"],
${S_TOGGLE}[data-page-band="teal"] ${S_COUNT}{
  color: #facc15;
  text-shadow: 0 0 8px rgba(250,204,21,0.24);
}
${S_COUNT}[data-page-band="blue"],
${S_TOGGLE}[data-page-band="blue"] ${S_COUNT}{
  color: #60a5fa;
  text-shadow: 0 0 8px rgba(96,165,250,0.24);
}
${S_COUNT}[data-page-band="darkred"],
${S_TOGGLE}[data-page-band="darkred"] ${S_COUNT}{
  color: #f87171;
  text-shadow: 0 0 8px rgba(248,113,113,0.24);
}
${S_COUNT}[data-page-band="violet"],
${S_TOGGLE}[data-page-band="violet"] ${S_COUNT}{
  color: #c4b5fd;
  text-shadow: 0 0 8px rgba(196,181,253,0.24);
}

/* per-item wrap that contains btn + dots */
${S_WRAP}{
  width: 100% !important;
  height: var(--mm-btn-h, 24px) !important;

  display: flex !important;
  align-items: center !important;
  justify-content: center !important;

  flex: 0 0 auto !important;
  min-width: 0 !important;
  box-sizing: border-box !important;

  position: relative !important;
  z-index: 2 !important;
  overflow: visible !important;
  color: #e5e7eb;
}

/* QA mode: one row becomes a vertical pair (Q above A) */
${S_MINIMAP}[${ATTR_.CGXUI_VIEW}="qa"] ${S_WRAP}{
  height: calc(var(--mm-q-btn-h) + var(--mm-btn-h) + var(--mm-qa-gap)) !important;
  display: flex !important;
  flex-direction: column !important;
  align-items: center !important;
  justify-content: flex-start !important;
  gap: var(--mm-qa-gap) !important;
}

${S_MINIMAP}[${ATTR_.CGXUI_VIEW}="qa"] ${S_WRAP} + ${S_WRAP}{
  margin-top: var(--mm-qa-group-gap) !important;
}

/* QA mode: keep gutter aligned with the ANSWER box center, not row center */
${S_MINIMAP}[${ATTR_.CGXUI_VIEW}="qa"] ${S_WRAP} .cgxui-mm-gutter{
  top: calc(var(--mm-q-btn-h) + var(--mm-qa-gap) + (var(--mm-btn-h) / 2)) !important;
  transform: translateY(-50%) !important;
  height: var(--mm-btn-h, 24px) !important;
}

${S_WRAP} .cgxui-mm-gutter{
  position: absolute !important;
  top: 50% !important;
  left: calc(50% + (var(--mm-btn-w, 56px) / 2) + var(--mm-gutter-outset, 4px)) !important;
  right: auto !important;
  transform: translateY(-50%) !important;
  width: var(--mm-gutter-w, 16px) !important;
  height: var(--mm-btn-h, 24px) !important;
  display: flex !important;
  align-items: center !important;
  justify-content: center !important;
  pointer-events: none !important;
  user-select: none !important;
  z-index: 11 !important;
}

${S_WRAP} .cgxui-mm-gutterSym{
  font-size: var(--mm-gutter-sym-size, 12px) !important;
  font-family: var(--ui-font-modern) !important;
  font-weight: 600 !important;
  line-height: 1 !important;
  opacity: 0.88;
  transform: translateX(var(--mm-gutter-sym-shift-x, 0.5px)) scale(0.85);
  transform-origin: 50% 50%;
  text-shadow: 0 1px 2px rgba(0,0,0,0.35);
  pointer-events: none !important;
}

${S_WRAP} .cgxui-mm-gutter:not([data-has-symbol="1"]) .cgxui-mm-gutterSym{
  opacity: 0 !important;
}

${S_COUNTER} {
  position: fixed;
  z-index: ${typeof Z !== 'undefined' ? Z : 2147483644};
  padding: 6px 12px;
  border-radius: 8px;
  font-size: 14px;
  font-family: monospace;
  color: #fff;
  background: rgba(0,0,0,0.75);
  box-shadow: 0 0 6px rgba(0,0,0,0.3);
  pointer-events: none;
  transition: transform .1s ease-out, opacity .15s ease-out;
  opacity: .95;
  display: none
}

${S_COUNTER}[${ATTR_.CGXUI_STATE}~="show"] { display: block !important; }

${S_MINIMAP} .cgxui-save-md::before,
${S_MINIMAP} .cgxui-save-md::after,
${S_MINIMAP} .cgxui-inline-hl::before,
${S_MINIMAP} .cgxui-inline-hl::after,
${S_MINIMAP} .cgxui-under-ui::before,
${S_MINIMAP} .cgxui-under-ui::after {
  content: none !important;
  background: none !important;
  box-shadow: none !important;
}

/* (moved) 🔢 Revision Badges CSS → 1a.🔴🔁 Revision Badges (MiniMap Plugin) */
  `;
  return base;
}

  function stampStyleOwnership(el) {
    if (!el || typeof el.setAttribute !== 'function') return el || null;
    try { el.setAttribute(STYLE_OWNER_ATTR, SkID); } catch {}
    try { el.setAttribute(STYLE_OWNER_VER_ATTR, SKIN_VER); } catch {}
    return el;
  }

  function styleDoc() {
    try {
      const topDoc = TOPW?.document || null;
      if (topDoc?.head && topDoc?.documentElement) return topDoc;
    } catch {}
    return document;
  }

  function SKIN_ensureStyle() {
    installApi();
    const doc = styleDoc();
    const existing = doc?.getElementById?.(CSS_.STYLE_ID) || null;
    if (existing) {
      const nextCss = CSS_MM_text();
      if (existing.textContent !== nextCss) existing.textContent = nextCss;
      return emitSkinReady(stampStyleOwnership(existing), 'reuse');
    }
    if (!doc?.createElement) return null;
    const el = doc.createElement('style');
    el.id = CSS_.STYLE_ID;
    el.textContent = CSS_MM_text();
    stampStyleOwnership(el);
    const head = doc.head || doc.documentElement || null;
    if (!head) return null;
    head.appendChild(el);
    return emitSkinReady(el, 'mount');
  }

  function SKIN_unmountStyle() {
    installApi();
    const doc = styleDoc();
    const el = doc?.getElementById?.(CSS_.STYLE_ID) || null;
    if (!el) return false;
    try { el.remove(); } catch {}
    skinReadyEmitted = false;
    try { TOPW.H2O_MM_SKIN_READY = false; } catch {}
    try { W.H2O_MM_SKIN_READY = false; } catch {}
    return true;
  }

  let skinReadyEmitted = false;

  function markSkinReady(el) {
    try { TOPW.H2O_MM_SKIN_PLUGIN = true; } catch {}
    try { TOPW.H2O_MM_SKIN_VER = SKIN_VER; } catch {}
    try { TOPW.H2O_MM_SKIN_READY = true; } catch {}
    try { W.H2O_MM_SKIN_READY = true; } catch {}
    return el || null;
  }

  function emitSkinReady(el, reason) {
    markSkinReady(el);
    if (skinReadyEmitted) return el || null;
    skinReadyEmitted = true;
    try {
      const CE = TOPW.CustomEvent || W.CustomEvent;
      if (typeof CE === 'function' && TOPW?.dispatchEvent) {
        TOPW.dispatchEvent(new CE(EVT_SKIN_READY, {
          detail: {
            owner: 'skin',
            ver: SKIN_VER,
            styleId: CSS_.STYLE_ID,
            reason: String(reason || 'ensure'),
          }
        }));
      }
    } catch {}
    return el || null;
  }

  const SKIN_API = Object.freeze({
    ver: SKIN_VER,
    owner: 'skin',
    ensureStyle: SKIN_ensureStyle,
    unmountStyle: SKIN_unmountStyle,
  });

  function installLegacyMirror(target) {
    if (!target || typeof target !== 'object') return false;
    try {
      target.H2O = target.H2O || {};
      target.H2O.MM = target.H2O.MM || {};
      target.H2O.MM.mnmp = target.H2O.MM.mnmp || {};
      target.H2O.MM.mnmp.api = (target.H2O.MM.mnmp.api && typeof target.H2O.MM.mnmp.api === 'object')
        ? target.H2O.MM.mnmp.api
        : {};
      target.H2O.MM.mnmp.api.skin = SKIN_API;
      return true;
    } catch {
      return false;
    }
  }

  function installApi() {
    let installed = false;
    try {
      const refs = TOPW.H2O_MM_SHARED?.get?.() || null;
      if (refs && typeof refs === 'object') {
        refs.api = (refs.api && typeof refs.api === 'object') ? refs.api : {};
        refs.api.skin = SKIN_API;

        if (refs.vault && typeof refs.vault === 'object') {
          refs.vault.api = (refs.vault.api && typeof refs.vault.api === 'object') ? refs.vault.api : {};
          refs.vault.api.skin = SKIN_API;
        }
        installed = true;
      }
    } catch {}
    installed = installLegacyMirror(TOPW) || installed;
    installed = installLegacyMirror(W) || installed;
    return installed;
  }

  installApi();
  try { SKIN_ensureStyle(); } catch {}
})();