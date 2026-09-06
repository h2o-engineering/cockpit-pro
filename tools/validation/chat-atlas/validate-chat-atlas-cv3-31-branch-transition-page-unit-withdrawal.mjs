#!/usr/bin/env node
// CV-3.31 — branch-transition Chat page-unit withdrawal (Stage 2C-2f).
//
// Live defect: switching from the coherent 39-turn branch to the 18-turn
// selected path replaced mounted content while this module's turn list, and
// therefore its page model, still described 39 turns. Page 2 stayed in-model,
// its divider was reused, and the anchor ladder fell through to stale
// sentinels that removeH2OChatPageUnitNode could never remove - so PAGE 2 was
// actively moved above Turn 17 until authority finally converged.
//
// Three proven source causes are covered here:
//   1. chatPageUnitIdentity hashed the CANONICAL fingerprint, which does not
//      change when a different path is selected through one canonical graph.
//   2. reconcileChatPageUnits had no branch-transition or coherence gate.
//   3. removeH2OChatPageUnitNode tested the boundary attribute against '1',
//      while sentinels store page-N-start / page-N-end.
//
// Every fixture below runs the real production bodies from 1A1b. The page
// model and the ordering enforcer are injected as instrumented doubles so the
// gate can be proven to run BEFORE any create/reuse/move/anchor work - that
// call count is the proof, not a pattern match. Placement mechanics
// themselves remain owned by CV-3.22 and CV-3.29.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const CORE_PATH = 'src-runtime-base/1A1b.🟥🗺️ MiniMap Core 🧱🗺️.js';
const PAGE_PATH = 'src-runtime-base/1C1b.🔴📑 Thread Pages Controller 📑.js';
const TITLE_PATH = 'src-runtime-base/1C1a.🟥📛 Turn Title Bar 📛.js';
const SKIN_PATH = 'src-runtime-base/1A1e.🟥🗺️ MiniMap Skin 🖐🗺️.js';
// The chat page's structural implementation moved out of MiniMap Core into
// 0C3a Chat Page Structure Engine. This validator asserts on that
// implementation, so CORE_SOURCE is the MiniMap Core file plus the engine it
// now lives in. Nothing about what is asserted changes: positive checks and
// function extraction still find the code, and the negative checks below get
// strictly stronger, since the forbidden pattern must now be absent from both
// files rather than from MiniMap Core alone.
const STRUCTURE_PATH = 'src-runtime-base/0C3a.⬛️📐 Chat Page Structure Engine 📐.js';
const STRUCTURE_SOURCE = fs.readFileSync(path.join(ROOT, STRUCTURE_PATH), 'utf8');
const CORE_SOURCE = `${fs.readFileSync(path.join(ROOT, CORE_PATH), 'utf8')}\n${STRUCTURE_SOURCE}`;
const PAGE_SOURCE = fs.readFileSync(path.join(ROOT, PAGE_PATH), 'utf8');
const TITLE_SOURCE = fs.readFileSync(path.join(ROOT, TITLE_PATH), 'utf8');
const SKIN_SOURCE = fs.readFileSync(path.join(ROOT, SKIN_PATH), 'utf8');
const CORE0_PATH = 'src-runtime-base/0A1a.⬛️🧠 H2O Core 🧠.js';
// The Chat Atlas Ledger moved out of H2O Core into 0A3b Chat Atlas Ledger,
// with 0A3a Chat Atlas Core brokering it. This validator asserts on that
// implementation, so the H2O Core source it reads is now the aggregate of the
// three files the code actually lives in. No assertion changes: positive checks
// and by-name extraction still find the code, and negative checks get strictly
// stronger because a forbidden pattern must be absent from all three.
const H2O_CORE_AGGREGATE_SOURCES = [
  'src-runtime-base/0A1a.⬛️🧠 H2O Core 🧠.js',
  'src-runtime-base/0A3a.⬛️🧭 Chat Atlas Core 🧭.js',
  'src-runtime-base/0A3b.⬛️📒 Chat Atlas Ledger 📒.js',
];
const CORE0_SOURCE = H2O_CORE_AGGREGATE_SOURCES
  .map((rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8'))
  .join('\n');
// The central Chat Atlas authority — including everything this validator drives
// through the broker — now lives in 0A3a. Binding-level extraction reads that
// owner directly rather than the aggregate, so a same-named binding in another
// owner can never be picked up by mistake.
const ATLAS_CORE_SOURCE = fs.readFileSync(
  path.join(ROOT, 'src-runtime-base/0A3a.⬛️🧭 Chat Atlas Core 🧭.js'),
  'utf8',
);

const CHAT_ID = 'chat-branch-transition';
const ROUTE_KEY = '/c/chat-branch-transition';
const CANONICAL_FP = 'djb2:1yue4v7';   // one canonical graph, both branches
const FP_39 = 'djb2:2iocqu';           // effective fingerprint, 39-turn branch
const FP_18 = 'djb2:15jcf17';          // effective fingerprint, 18-turn branch

let assertions = 0;
const fixtures = [];
function ok(value, message) { assertions += 1; assert.ok(value, message); }
function equal(actual, expected, message) { assertions += 1; assert.equal(actual, expected, message); }
async function fixture(name, fn) {
  try { await fn(); fixtures.push({ name, ok: true }); console.log(`PASS ${name}`); }
  catch (error) { fixtures.push({ name, ok: false, error }); console.log(`FAIL ${name}`); }
}

function extractFunction(source, name) {
  const anchor = `  function ${name}(`;
  const start = source.indexOf(anchor);
  if (start < 0 || source.indexOf(anchor, start + anchor.length) >= 0) throw new Error(`function-anchor-invalid:${name}`);
  const bodyStart = source.indexOf('{', source.indexOf(')', start));
  let d = 0, q = '', esc = false, lc = false, bc = false;
  for (let i = bodyStart; i < source.length; i += 1) {
    const c = source[i], n = source[i + 1];
    if (lc) { if (c === '\n') lc = false; continue; }
    if (bc) { if (c === '*' && n === '/') { bc = false; i += 1; } continue; }
    if (q) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === q) q = ''; continue; }
    if (c === '/' && n === '/') { lc = true; i += 1; continue; }
    if (c === '/' && n === '*') { bc = true; i += 1; continue; }
    if (c === '"' || c === "'" || c === '`') { q = c; continue; }
    if (c === '{') d += 1;
    else if (c === '}' && --d === 0) return source.slice(start, i + 1);
  }
  throw new Error(`function-boundary-invalid:${name}`);
}

function extractNestedFunction(source, name) {
  const anchor = `function ${name}(`;
  const start = source.indexOf(anchor);
  if (start < 0 || source.indexOf(anchor, start + anchor.length) >= 0) throw new Error(`nested-function-anchor-invalid:${name}`);
  const bodyStart = source.indexOf('{', source.indexOf(')', start));
  let d = 0, q = '', esc = false, lc = false, bc = false;
  for (let i = bodyStart; i < source.length; i += 1) {
    const c = source[i], n = source[i + 1];
    if (lc) { if (c === '\n') lc = false; continue; }
    if (bc) { if (c === '*' && n === '/') { bc = false; i += 1; } continue; }
    if (q) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === q) q = ''; continue; }
    if (c === '/' && n === '/') { lc = true; i += 1; continue; }
    if (c === '/' && n === '*') { bc = true; i += 1; continue; }
    if (c === '"' || c === "'" || c === '`') { q = c; continue; }
    if (c === '{') d += 1;
    else if (c === '}' && --d === 0) return source.slice(start, i + 1);
  }
  throw new Error(`nested-function-boundary-invalid:${name}`);
}

// 0A3a declares its Ledger-service forwards as `const x = (...) => ...` rather
// than function declarations, precisely so they cannot collide with the real
// implementations under a `  function <name>(` scan. Extracting them needs its
// own anchor: newline-anchored so a deeper-indented binding of the same name is
// not mistaken for the module-level one, and terminated by `;` at depth 0.
function extractBinding(source, name) {
  const anchor = `\n  const ${name} = `;
  const found = source.indexOf(anchor);
  if (found < 0 || source.indexOf(anchor, found + anchor.length) >= 0) throw new Error(`binding-anchor-invalid:${name}`);
  const start = found + 1;
  let d = 0, q = '', esc = false, lc = false, bc = false;
  for (let i = found + anchor.length; i < source.length; i += 1) {
    const c = source[i], n = source[i + 1];
    if (lc) { if (c === '\n') lc = false; continue; }
    if (bc) { if (c === '*' && n === '/') { bc = false; i += 1; } continue; }
    if (q) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === q) q = ''; continue; }
    if (c === '/' && n === '/') { lc = true; i += 1; continue; }
    if (c === '/' && n === '*') { bc = true; i += 1; continue; }
    if (c === '"' || c === "'" || c === '`') { q = c; continue; }
    if (c === '{' || c === '(' || c === '[') d += 1;
    else if (c === '}' || c === ')' || c === ']') d -= 1;
    else if (c === ';' && d === 0) return source.slice(start, i + 1);
    if (d < 0) throw new Error(`binding-boundary-invalid:${name}`);
  }
  throw new Error(`binding-boundary-invalid:${name}`);
}

// ── DOM with real connection semantics ────────────────────────────────────
function parts(sel) { return String(sel || '').split(',').map((s) => s.trim()).filter(Boolean); }
function matchOne(node, sel) {
  const t = String(sel || '').trim();
  const tag = t.match(/^([a-zA-Z]+)/);
  if (tag && String(node.tagName).toUpperCase() !== tag[1].toUpperCase()) return false;
  for (const c of Array.from(t.matchAll(/\.([A-Za-z0-9_-]+)/g)).map((m) => m[1])) {
    if (!String(node.className || '').split(/\s+/).includes(c)) return false;
  }
  for (const m of t.matchAll(/\[([^\]=]+)(?:="([^"]*)")?\]/g)) {
    const name = m[1].trim();
    const actual = node.getAttribute(name);
    if (actual == null) return false;
    if (m[2] != null && String(actual) !== m[2]) return false;
  }
  return true;
}
class El {
  constructor(tag = 'DIV', className = '') {
    this.tagName = String(tag).toUpperCase(); this.nodeType = 1; this.className = className;
    this.children = []; this.parentElement = null; this.attrs = new Map(); this.isConnected = false;
    this.style = { _v: new Map(), setProperty(k, v) { this._v.set(k, v); }, removeProperty(k) { this._v.delete(k); }, getPropertyValue(k) { return this._v.get(k) || ''; } };
  }
  addEventListener() {} removeEventListener() {}
  get parentNode() { return this.parentElement; }
  setAttribute(n, v) { this.attrs.set(String(n), String(v)); }
  getAttribute(n) { return this.attrs.has(String(n)) ? this.attrs.get(String(n)) : null; }
  hasAttribute(n) { return this.attrs.has(String(n)); }
  removeAttribute(n) { this.attrs.delete(String(n)); }
  get classList() { const self = this; return { contains: (c) => String(self.className || '').split(/\s+/).includes(c), add: (c) => { if (!self.classList.contains(c)) self.className = `${self.className} ${c}`.trim(); }, remove: () => {} }; }
  _conn(v) { this.isConnected = v; for (const c of this.children) c._conn(v); }
  appendChild(c) { if (c.parentElement) c.parentElement.removeChild(c); c.parentElement = this; this.children.push(c); c._conn(this.isConnected); return c; }
  insertBefore(c, ref) { if (c.parentElement) c.parentElement.removeChild(c); c.parentElement = this; const i = ref ? this.children.indexOf(ref) : -1; if (i < 0) this.children.push(c); else this.children.splice(i, 0, c); c._conn(this.isConnected); return c; }
  removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); c.parentElement = null; c._conn(false); return c; }
  remove() { if (this.parentElement) this.parentElement.removeChild(this); }
  get nextSibling() { const p = this.parentElement; if (!p) return null; return p.children[p.children.indexOf(this) + 1] || null; }
  matches(sel) { return parts(sel).some((p) => matchOne(this, p)); }
  closest(sel) { let n = this; while (n) { if (n.matches(sel)) return n; n = n.parentElement; } return null; }
  querySelectorAll(sel) { const out = []; const w = (n) => { for (const c of n.children) { if (c.matches(sel)) out.push(c); w(c); } }; w(this); return out; }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  contains(o) { let n = o; while (n) { if (n === this) return true; n = n.parentElement; } return false; }
}

const OWNER = 'cgxui';
const BOUNDARY_ATTR = 'data-h2o-chat-page-boundary';

// options:
//   turns          — model turn count (drives model.count / pageCount)
//   effectiveCount — authoritative effective count (mismatch => incoherent)
//   effectiveFp    — authoritative effective fingerprint
//   transition     — projection transition flags
//   transitionStatus — optional live projection transition reader
//   overlayActive  — effective presentation is a settled selected-path overlay
//   units          — which page units to pre-mount (default from turns)
//   realStructuralModel — execute production buildChatPageUnitModel through the
//                         mmHost().getTurnList() dependency instead of the
//                         narrow count-only model used by the gate fixtures
function makeHarness(options = {}) {
  const turns = Number(options.turns ?? 39);
  let effectiveCount = Number(options.effectiveCount ?? turns);
  let effectiveFp = String(options.effectiveFp ?? (turns === 18 ? FP_18 : FP_39));
  const transition = Object.assign({
    trustedSelectionIntentActive: false,
    branchSelectionStale: false,
    branchExpansionPending: false,
    branchExpansionFailClosed: false,
    branchExpansionState: 'idle',
    branchExpansionReason: null,
    branchExpansionPriorCount: 0,
    branchExpansionTargetCount: 0,
    branchExpansionExpectedFingerprint: null,
    branchExpansionRequiredPageNums: [],
    selectedPathRequestLeaseActive: false,
    selectedPathConfirmationLeaseActive: false,
    selectedPathConfirmationPending: false,
  }, options.transition || {});

  const root = new El('MAIN', 'thread'); root.isConnected = true;
  const document = {
    documentElement: new El('HTML'),
    createElement: (tag) => new El(tag),
    querySelectorAll: (sel) => root.querySelectorAll(sel),
    querySelector: (sel) => root.querySelector(sel),
  };
  document.documentElement.isConnected = true;

  const makeStructuralTurns = (count) => new Array(count).fill(null).map((_, i) => ({
    order: i + 1,
    turnNo: i + 1,
    qId: `q-${i + 1}`,
    questionId: `q-${i + 1}`,
    primaryAId: `a-${i + 1}`,
    answerId: `a-${i + 1}`,
    turnId: `turn:q-${i + 1}`,
  }));
  const structuralHost = {
    turns: makeStructuralTurns(turns),
    getTurnList() { return this.turns; },
  };
  const mmHostBridge = () => structuralHost;
  const S = { chatPageUnitState: null };
  Object.defineProperty(S, 'turnList', {
    enumerable: true,
    get() { return mmHostBridge()?.getTurnList?.() || []; },
  });
  const W = { location: { pathname: ROUTE_KEY } };
  const overlayActive = options.overlayActive === true;

  const enforceCalls = [];
  const sandbox = {
    document, S, W, console,
    UI_TOK: { OWNER },
    CHAT_PAGE_BOUNDARY_ATTR: BOUNDARY_ATTR,
    CHAT_PAGE_BOUNDARY_PAGE_ATTR: 'data-h2o-chat-page-boundary-page',
    CHAT_PAGE_BOUNDARY_KIND_ATTR: 'data-h2o-chat-page-boundary-kind',
    resolveChatId: () => CHAT_ID,
    // Authority doubles. Only these two feed the gate.
    callEffectiveTurnRuntime: (verb) => {
      if (verb === 'STATUS') {
        return {
          source: overlayActive ? 'selected-path-overlay' : 'canonical', overlayActive, count: effectiveCount,
          canonicalFingerprint: CANONICAL_FP, anchorQId: null, pathLength: 0, generation: 7,
        };
      }
      if (verb === 'INDEX') {
        return { sourceFingerprint: effectiveFp, turns: new Array(effectiveCount).fill(null) };
      }
      return null;
    },
    getTurnRuntimeApi: () => ({
      getCompleteTurnIndexProjectionStatus: () => Object.assign({
        enabled: true, authoritative: true, status: 'authoritative', chatId: CHAT_ID,
        count: effectiveCount, source: 'complete-index', fingerprint: effectiveFp, routeGeneration: 7,
      }, typeof options.transitionStatus === 'function' ? options.transitionStatus() : transition),
    }),
    // Instrumented ordering enforcer: any call proves the gate did NOT hold.
    enforceChatPageUnitOrder: (model, candidatesByPage, reason) => {
      enforceCalls.push({ pageCount: model?.pageCount, reason });
      return { reason, identity: model?.identity, source: model?.source, count: model?.count, pageCount: model?.pageCount, created: 0, moved: 0, removed: 0, deferred: 0, hydrationRequests: 0, pages: [] };
    },
    getActualThreadPageDividers: () => root.querySelectorAll('.cgxui-chat-page-divider'),
    pageNumberOfThreadDivider: (d) => Number(d.getAttribute('data-page-num') || 0),
    compareChatPageNodes: () => 0,
    getChatPagesControllerApi: () => ({
      resolveNativePageHeadCoherence: () => Object.freeze({
        state: String(options.pageHeadState || 'match'),
      }),
    }),
    mmHost: mmHostBridge,
    resolveChatPageExactArtifact: () => null,
    getPageStartTurnWrapper: () => null,
    getChatPageTitleListRoot: () => null,
    setChatPageUnitAttributeIfChanged: (node, name, value) => {
      if (!node || !name) return false;
      if (value == null) { if (!node.hasAttribute(name)) return false; node.removeAttribute(name); return true; }
      if (node.getAttribute(name) === String(value)) return false;
      node.setAttribute(name, String(value));
      return true;
    },
  };
  vm.createContext(sandbox);

  const names = [
    'getChatPageUnitState', 'chatPageUnitIdentity', 'getEffectivePresentationRuntimeStatus',
    'getCompleteIndexProjectionStatus', 'isOwnedChatPageBoundarySentinel', 'removeH2OChatPageUnitNode',
    'createChatPageBoundarySentinel', 'chatPageUnitBranchTransitionActive',
    'chatPageUnitPresentationCoherence', 'withdrawChatPageUnits', 'reconcileChatPageUnits',
  ];
  const buildModelSource = options.realStructuralModel === true
    ? [
      extractFunction(STRUCTURE_SOURCE, 'chatPageRecordOrder'),
      extractFunction(STRUCTURE_SOURCE, 'buildChatPageUnitModel'),
    ].join('\n')
    : `function buildChatPageUnitModel(){
        const count = S.turnList.length;
        const pageCount = count > 0 ? Math.ceil(count / 25) : 0;
        const pages = [];
        for (let p = 1; p <= pageCount; p += 1) {
          pages.push({ pageNum: p, startOrder: ((p - 1) * 25) + 1, endOrder: Math.min(count, p * 25) });
        }
        return Object.freeze({ identity: chatPageUnitIdentity(), chatId: '${CHAT_ID}', source: 'canonical', count, pageCount, pages });
      }`;
  const src = names.map((n) => extractFunction(CORE_SOURCE, n)).join('\n')
    + `\nconst CHAT_PAGE_BOUNDARY_SENTINEL_VALUE = ${String(CORE_SOURCE.match(/const CHAT_PAGE_BOUNDARY_SENTINEL_VALUE = (.+);/)[1])};`
    + `\n${buildModelSource}`
    + `\nglobalThis.__api = { ${names.join(', ')}, buildChatPageUnitModel };`;
  new vm.Script(src, { filename: CORE_PATH }).runInContext(sandbox);

  const api = sandbox.__api;

  // Mount the page units for the CURRENT model, exactly as production does.
  const mountUnits = (pageCount) => {
    const state = api.getChatPageUnitState();
    for (let p = 1; p <= pageCount; p += 1) {
      const divider = new El('DIV', 'cgxui-chat-page-divider');
      divider.setAttribute('data-page-num', String(p));
      divider.setAttribute('data-cgxui-owner', OWNER);
      root.appendChild(divider);
      state.pendingDividers.set(p, divider);
      for (const kind of ['start', 'end']) {
        const sentinel = api.createChatPageBoundarySentinel(p, kind);
        root.appendChild(sentinel);
        state.sentinels.set(`${p}:${kind}`, sentinel);
      }
    }
    state.identity = api.chatPageUnitIdentity();
  };

  return {
    api, root, document, S, sandbox, enforceCalls, mountUnits,
    dividers: () => root.querySelectorAll('.cgxui-chat-page-divider'),
    sentinels: () => root.querySelectorAll(`[${BOUNDARY_ATTR}]`),
    unit: (page, kind) => root.querySelectorAll(`[${BOUNDARY_ATTR}="page-${page}-${kind}"]`)[0] || null,
    divider: (page) => root.querySelectorAll(`.cgxui-chat-page-divider[data-page-num="${page}"]`)[0] || null,
    setTurns: (n) => { structuralHost.turns = makeStructuralTurns(Math.max(0, Number(n || 0) || 0)); },
    structuralHost, transition,
    setEffectiveCount: (n) => { effectiveCount = Math.max(0, Number(n || 0) || 0); },
    setEffectiveFingerprint: (value) => { effectiveFp = String(value || ''); },
  };
}

// Public 0C3a recovery world for the live empty-turn-list failure. Unlike the
// narrow gate fixtures above, this world executes production
// buildChatPageUnitModel(), presentation coherence, reconciliation and
// renderChatPageDividers(). The mutable structural source is the same
// mmHost().getTurnList() seam used by 0C3a; effective authority remains fixed.
// Timers are deterministic and recorded so recovery can only occur through a
// callback production itself scheduled.
function makeTemporaryStructuralModelRecoveryWorld() {
  const page = makeHarness({
    turns: 37,
    effectiveCount: 37,
    effectiveFp: FP_39,
    realStructuralModel: true,
  });
  let now = 0;
  let nextTimerId = 1;
  const timers = new Map();
  const timerTrace = [];
  const scheduleTimer = (callback, delay = 0) => {
    const boundedDelay = Math.max(0, Number(delay || 0) || 0);
    const id = nextTimerId++;
    timers.set(id, { id, callback, delay: boundedDelay, due: now + boundedDelay });
    timerTrace.push({ event: 'scheduled', id, delay: boundedDelay, at: now });
    return id;
  };
  const clearTimer = (id) => {
    if (!timers.has(id)) return;
    timers.delete(id);
    timerTrace.push({ event: 'cleared', id, at: now });
  };
  const runNextTimer = () => {
    const task = Array.from(timers.values()).sort((a, b) => a.due - b.due || a.id - b.id)[0] || null;
    if (!task) return false;
    timers.delete(task.id);
    now = Math.max(now, task.due);
    timerTrace.push({ event: 'fired', id: task.id, delay: task.delay, at: now });
    task.callback();
    return true;
  };
  const flushImmediateTimers = () => {
    let fired = 0;
    while (fired < 50) {
      const task = Array.from(timers.values())
        .filter((entry) => entry.due <= now)
        .sort((a, b) => a.id - b.id)[0] || null;
      if (!task) break;
      timers.delete(task.id);
      timerTrace.push({ event: 'fired', id: task.id, delay: task.delay, at: now });
      task.callback();
      fired += 1;
    }
    return fired;
  };
  const pendingRecoveryTimers = () => Array.from(timers.values())
    .filter((entry) => entry.delay > 0)
    .sort((a, b) => a.due - b.due || a.id - b.id);

  page.sandbox.W.setTimeout = scheduleTimer;
  page.sandbox.W.clearTimeout = clearTimer;
  page.sandbox.setTimeout = scheduleTimer;
  page.sandbox.clearTimeout = clearTimer;
  Object.assign(page.sandbox, {
    qq: (selector, root = page.document) => Array.from(root.querySelectorAll(selector)),
    escAttr: (value) => String(value || ''),
    bindDividerScrollRepairOnce: () => {},
    bindDividerOrderObserverOnce: () => {},
    enterPerfOwner: () => false,
    exitPerfOwner: () => {},
    perfNow: () => now,
    getPaginationState: () => null,
    buildChatPageSections: () => ({ sections: new Map(), allHosts: [] }),
    syncNoAnswerTitleBars: () => {},
    getChatPageSectionCollapsedState: () => false,
    getTurnPageBand: () => 'normal',
    createChatPageDivider: (pageNum) => {
      const divider = new El('DIV', 'cgxui-chat-page-divider');
      divider.setAttribute('data-cgxui-owner', OWNER);
      divider.setAttribute('data-cgxui-chat-page-divider', '1');
      divider.setAttribute('data-page-num', String(pageNum));
      return divider;
    },
    setChatPageDividerDomState: (divider, _collapsed, pageNum) => {
      divider.setAttribute('data-page-num', String(pageNum));
      divider.setAttribute('data-cgxui-chat-page-num', String(pageNum));
    },
    noteNodeLifecycle: () => {},
    noteRenderUnit: () => {},
    recordDuration: () => {},
    noteSummaryBucket: () => {},
    getChatPageDividersEnabled: () => true,
    getPreviousChatPageAnchorHost: () => null,
    applyChatPageDividerGeometry: () => {},
    applyChatPageDividerVisuals: () => {},
    requestAnimationFrame: (callback) => scheduleTimer(callback, 16),
  });
  new vm.Script(`
    const ATTR_CHAT_PAGE_DIVIDERS = 'data-cgxui-chat-page-dividers';
    const PERF = { paths: { renderChatPageDividers: {} }, dividerUi: {} };
    let dividerRenderInFlight = false;
    ${extractFunction(STRUCTURE_SOURCE, 'renderChatPageDividers')}
    globalThis.__publicPageRecoveryApi = Object.freeze({
      renderDividers: renderChatPageDividers,
    });
  `, { filename: `${STRUCTURE_PATH}:temporary-model-public-render` }).runInContext(page.sandbox);

  const runPublicPageStructurePass = (reason) => {
    const reconciliation = page.api.reconcileChatPageUnits(reason);
    const rendered = page.sandbox.__publicPageRecoveryApi.renderDividers(CHAT_ID);
    return { reconciliation, rendered };
  };
  const runProductionCallbacks = (limit = 50) => {
    let fired = 0;
    while (fired < limit && runNextTimer()) fired += 1;
    return fired;
  };
  return {
    page,
    runPublicPageStructurePass,
    flushImmediateTimers,
    runProductionCallbacks,
    pendingRecoveryTimers,
    timerTrace,
    pendingTimers: () => Array.from(timers.values()),
  };
}

// Public scroll-repair world. The structural render/reconcile authority is the
// same production-backed world above; only time and browser event delivery are
// deterministic. Counters wrap the production boundaries without replacing
// their work, so the RED proves repeated entry into the expensive public path.
function makeDividerScrollRepairWorld() {
  const world = makeTemporaryStructuralModelRecoveryWorld();
  const { page } = world;
  page.mountUnits(2);
  page.api.reconcileChatPageUnits('divider-scroll:baseline');
  world.runPublicPageStructurePass('divider-scroll:baseline-render');
  world.flushImmediateTimers();

  const counters = {
    notifications: 0,
    runDividerRepair: 0,
    fullRender: 0,
    reconcile: 0,
  };
  let clock = 1000;
  let anchorGeneration = 1;
  const anchorHost = () => {
    const section = new El('SECTION');
    section.setAttribute('data-testid', `conversation-turn-${anchorGeneration}`);
    section.getBoundingClientRect = () => ({ top: 100, bottom: 200, left: 0, right: 100 });
    const wrapper = new El('DIV');
    wrapper.appendChild(section);
    return { wrapper, section, testid: section.getAttribute('data-testid'), mode: 'test-host' };
  };
  let liveAnchor = anchorHost();
  page.sandbox.getPageStartTurnWrapper = () => liveAnchor;

  const originalEnforce = page.sandbox.enforceChatPageUnitOrder;
  page.sandbox.enforceChatPageUnitOrder = (model, candidatesByPage, reason) => {
    // This remains an instrumented ordering seam, as elsewhere in CV-3.31,
    // but it performs the one public DOM effect needed by the missing-divider
    // control: attach the exact candidate production created for each page.
    for (const pageModel of Array.isArray(model?.pages) ? model.pages : []) {
      const candidate = (candidatesByPage.get(pageModel.pageNum) || [])[0] || null;
      if (candidate && !candidate.isConnected) page.root.appendChild(candidate);
    }
    return originalEnforce(model, candidatesByPage, reason);
  };

  const originalReconcile = page.sandbox.reconcileChatPageUnits;
  page.sandbox.reconcileChatPageUnits = (...args) => {
    counters.reconcile += 1;
    return originalReconcile(...args);
  };
  const originalRender = page.sandbox.renderChatPageDividers;
  page.sandbox.renderChatPageDividers = (...args) => {
    counters.fullRender += 1;
    return originalRender(...args);
  };
  page.sandbox.Date = { now: () => clock };
  new vm.Script(`
    let dividerScrollRepairAt = 0;
    let dividerScrollTrailTimer = 0;
    ${extractFunction(STRUCTURE_SOURCE, 'runDividerRepair')}
    ${extractFunction(STRUCTURE_SOURCE, 'onDividerRepairScroll')}
    globalThis.__dividerScrollRepairApi = Object.freeze({
      notify: onDividerRepairScroll,
      run: runDividerRepair,
    });
  `, { filename: `${STRUCTURE_PATH}:divider-scroll-repair` }).runInContext(page.sandbox);
  const productionRun = page.sandbox.__dividerScrollRepairApi.run;
  page.sandbox.runDividerRepair = (...args) => {
    counters.runDividerRepair += 1;
    return productionRun(...args);
  };

  const notify = (advanceMs = 400) => {
    clock += Math.max(0, Number(advanceMs || 0) || 0);
    counters.notifications += 1;
    return page.sandbox.__dividerScrollRepairApi.notify();
  };
  const flush = () => world.runProductionCallbacks(100);
  const resetCounts = () => {
    counters.notifications = 0;
    counters.runDividerRepair = 0;
    counters.fullRender = 0;
    counters.reconcile = 0;
  };
  const replaceAnchor = () => {
    anchorGeneration += 1;
    liveAnchor = anchorHost();
    return liveAnchor;
  };
  return { world, page, counters, notify, flush, resetCounts, replaceAnchor };
}

function makeRebuildCounterHarness(options = {}) {
  const turnIds = new Array(18).fill(null).map((_, index) => `turn-${index + 1}`);
  const buttons = new Map(turnIds.map((turnId) => [turnId, {
    isConnected: true,
    active: false,
    dataset: { turnId, id: turnId },
  }]));
  const oldTurn25Id = 'turn-25';
  const S = {
    turnList: turnIds.map((turnId, index) => ({ turnId, answerId: `answer-${index + 1}`, index: index + 1 })),
    lastActiveTurnIdFast: options.cachedFast === undefined ? oldTurn25Id : String(options.cachedFast || ''),
    lastActiveBtnId: options.cachedBtn === undefined ? oldTurn25Id : String(options.cachedBtn || ''),
    lastActiveBtnEl: null,
  };
  const stats = {
    setActiveCalls: [],
    counterCalls: [],
    counterText: '25/39',
  };
  const updateCounter = (anyId = '') => {
    const id = String(anyId || '').trim();
    stats.counterCalls.push(id);
    const index = Math.max(1, turnIds.indexOf(id) + 1);
    stats.counterText = `${index}/18`;
    return true;
  };
  const setActive = (anyId, reason = '') => {
    const id = String(anyId || '').trim();
    stats.setActiveCalls.push({ id, reason: String(reason || '') });
    if (options.concurrentActiveId) {
      const concurrentId = String(options.concurrentActiveId);
      S.lastActiveTurnIdFast = concurrentId;
      S.lastActiveBtnId = concurrentId;
      const concurrent = buttons.get(concurrentId);
      if (concurrent) concurrent.active = true;
    }
    const btn = buttons.get(id) || null;
    if (!btn || options.forceSetActiveFailure === true) return false;
    for (const candidate of buttons.values()) candidate.active = false;
    btn.active = true;
    S.lastActiveTurnIdFast = id;
    S.lastActiveBtnId = id;
    updateCounter(id);
    return true;
  };
  const sandbox = {
    S,
    setActive,
    updateCounter,
    getBtnById: (id) => buttons.get(String(id || '').trim()) || null,
    findTurnByAnyId: (id) => {
      const key = String(id || '').trim();
      return S.turnList.find((turn) => turn.turnId === key || turn.answerId === key) || null;
    },
    q: () => Array.from(buttons.values()).find((button) => button.active) || null,
    computeActiveFromViewport: () => ({ activeTurnId: '', activeAnswerId: '' }),
  };
  vm.createContext(sandbox);
  const sources = options.sources || {};
  const functionSources = {
    clearMissingRebuildActiveIdentity: sources.clearMissingRebuildActiveIdentity
      || extractFunction(CORE_SOURCE, 'clearMissingRebuildActiveIdentity'),
    applyRebuildActiveId: sources.applyRebuildActiveId
      || extractFunction(CORE_SOURCE, 'applyRebuildActiveId'),
    resolveRebuildActiveId: sources.resolveRebuildActiveId
      || extractFunction(CORE_SOURCE, 'resolveRebuildActiveId'),
    finalizeRebuildUi: sources.finalizeRebuildUi
      || extractFunction(CORE_SOURCE, 'finalizeRebuildUi'),
  };
  new vm.Script(
    Object.values(functionSources).join('\n')
      + '\nglobalThis.__rebuildApi = { clearMissingRebuildActiveIdentity, applyRebuildActiveId, resolveRebuildActiveId, finalizeRebuildUi };',
    { filename: `${CORE_PATH}:rebuild-counter` },
  ).runInContext(sandbox);
  return {
    api: sandbox.__rebuildApi,
    S,
    stats,
    buttons,
    oldTurn25Id,
    listIds: turnIds,
    activeMarkerIds: () => Array.from(buttons.entries()).filter(([, button]) => button.active).map(([id]) => id),
  };
}

// ══════════════════════════════════════════════════════════════════════════
// A — the transition signal and its lifecycle (0A1a, source contract)
// ══════════════════════════════════════════════════════════════════════════

await fixture('1 trusted native branch selection publishes the transition synchronously', () => {
  const capture = extractFunction(CORE0_SOURCE, 'chatAtlasRecordTrustedNativeBranchSelection');
  // Both flags are set inside the capture body itself - no await, no timer -
  // so they are live before ChatGPT can replace the mounted branch content.
  const staleIndex = capture.indexOf('completeTurnIndexAuthorityState.branchSelectionStale = true;');
  const intentIndex = capture.indexOf('completeTurnIndexAuthorityState.trustedSelectedPathIntent = Object.freeze({');
  ok(staleIndex > 0, 'capture marks the branch selection stale');
  ok(intentIndex > 0, 'capture freezes the trusted intent');
  ok(!/\bawait\b/.test(capture.slice(0, Math.max(staleIndex, intentIndex))), 'no await precedes publication');
  ok(!/setTimeout\(/.test(capture.slice(0, Math.max(staleIndex, intentIndex))), 'no timer precedes publication');
  // Published through the existing complete-index status contract.
  ok(CORE0_SOURCE.includes('branchSelectionStale: completeTurnIndexAuthorityState.branchSelectionStale === true'), 'branchSelectionStale published');
  ok(CORE0_SOURCE.includes('trustedSelectionIntentActive: !!completeTurnIndexAuthorityState.trustedSelectedPathIntent'), 'trusted intent published');
});

await fixture('2 an untrusted or unrelated click publishes nothing', () => {
  const capture = extractFunction(CORE0_SOURCE, 'chatAtlasRecordTrustedNativeBranchSelection');
  const staleIndex = capture.indexOf('completeTurnIndexAuthorityState.branchSelectionStale = true;');
  const head = capture.slice(0, staleIndex);
  // A click with no branch direction, or outside the authoritative route, or
  // whose ownership does not resolve canonically, returns before publication.
  ok(head.includes('if (\n      !direction'), 'non-branch clicks return early');
  ok(head.includes('|| route.chatId !== completeTurnIndexAuthorityState.chatId'), 'foreign chat returns early');
  ok(head.includes('if (ownership.ok !== true) {'), 'unresolved ownership returns early');
  const ownershipReturn = head.indexOf('if (ownership.ok !== true) {');
  ok(head.slice(ownershipReturn).includes('return false;'), 'unresolved ownership returns false before publication');
});

await fixture('3 no second branch-selection authority is introduced', () => {
  // 1A1b only READS the Core's published fields; it never writes them.
  for (const field of ['branchSelectionStale', 'trustedSelectionIntentActive']) {
    ok(CORE_SOURCE.includes(field), `${field} is consumed`);
    ok(!new RegExp(`${field}\\s*=[^=]`).test(CORE_SOURCE), `${field} is never assigned in MiniMap Core`);
  }
  ok(!/completeTurnIndexAuthorityState/.test(CORE_SOURCE), 'MiniMap Core owns no complete-index authority state');
});

// ══════════════════════════════════════════════════════════════════════════
// B/C — authority pass-through and effective-presentation identity
// ══════════════════════════════════════════════════════════════════════════

await fixture('4 projection status preserves the transition fields', () => {
  const h = makeHarness({ transition: { branchSelectionStale: true } });
  const status = h.api.getCompleteIndexProjectionStatus();
  equal(status.branchSelectionStale, true, 'branchSelectionStale preserved');
  equal(status.trustedSelectionIntentActive, false, 'intent flag preserved');
  for (const f of ['selectedPathRequestLeaseActive', 'selectedPathConfirmationLeaseActive', 'selectedPathConfirmationPending']) {
    equal(status[f], false, `${f} preserved`);
  }
  // The pre-existing fields are untouched.
  equal(status.enabled, true, 'enabled retained');
  equal(status.authoritative, true, 'authoritative retained');
});

await fixture('5 effective fingerprint is exposed without a third fingerprint model', () => {
  const h = makeHarness({ turns: 39 });
  const status = h.api.getEffectivePresentationRuntimeStatus();
  equal(status.canonicalFingerprint, CANONICAL_FP, 'canonical fingerprint retained');
  equal(status.effectiveFingerprint, FP_39, 'effective fingerprint exposed');
  equal(status.effectiveCount, 39, 'effective count exposed');
  // It is read through the existing INDEX verb, the same source 1C1b uses.
  const fn = extractFunction(CORE_SOURCE, 'getEffectivePresentationRuntimeStatus');
  ok(fn.includes("callEffectiveTurnRuntime('INDEX')"), 'uses the existing INDEX verb');
  ok(fn.includes('index?.sourceFingerprint'), 'reads the authoritative sourceFingerprint');
  ok(PAGE_SOURCE.includes("String(index?.sourceFingerprint || '')"), 'same field the Pages Controller calls effectiveFingerprint');
});

await fixture('6 effective fingerprint change invalidates identity while canonical is unchanged', () => {
  const a = makeHarness({ turns: 39, effectiveFp: FP_39 });
  const b = makeHarness({ turns: 39, effectiveFp: FP_18 });
  const idA = a.api.chatPageUnitIdentity();
  const idB = b.api.chatPageUnitIdentity();
  ok(idA.includes(CANONICAL_FP) && idB.includes(CANONICAL_FP), 'canonical fingerprint unchanged in both');
  ok(idA.includes(FP_39) && idB.includes(FP_18), 'effective fingerprint present in both');
  ok(idA !== idB, 'identity changes on effective fingerprint change alone');
  // Existing components are preserved.
  for (const part of [CHAT_ID, ROUTE_KEY, 'canonical', '39', '7', '2']) {
    ok(idA.split('|').includes(part), `identity retains ${part}`);
  }
});

// ══════════════════════════════════════════════════════════════════════════
// D — the gate, withdrawal and rebuild
// ══════════════════════════════════════════════════════════════════════════

await fixture('7 coherent 39-turn branch reconciles normally with two pages', () => {
  const h = makeHarness({ turns: 39 });
  h.mountUnits(2);
  equal(h.dividers().length, 2, 'Page 1 and Page 2 dividers mounted');
  equal(h.sentinels().length, 4, 'four sentinels mounted');
  const result = h.api.reconcileChatPageUnits('test');
  equal(result.withdrawn, undefined, 'no withdrawal on a coherent branch');
  equal(h.enforceCalls.length, 1, 'ordering enforcement runs');
  equal(h.enforceCalls[0].pageCount, 2, 'enforced with two pages');
  equal(h.dividers().length, 2, 'both dividers survive');
});

await fixture('8 switching 39 to 18 withdraws every H2O page unit', () => {
  const h = makeHarness({ turns: 39 });
  h.mountUnits(2);
  const staleDivider = h.divider(2);
  const staleStart = h.unit(2, 'start');
  const staleEnd = h.unit(2, 'end');
  ok(staleDivider && staleStart && staleEnd, 'stale Page 2 units exist before the switch');
  // Trusted branch selection fires; mounted content is changing but the model
  // still describes 39 turns.
  h.sandbox.getTurnRuntimeApi = () => ({ getCompleteTurnIndexProjectionStatus: () => ({ enabled: true, authoritative: true, branchSelectionStale: true, trustedSelectionIntentActive: true }) });
  const result = h.api.reconcileChatPageUnits('branch-switch');
  equal(result.status, 'branch-transition-withdrawn', 'explicit fail-closed status');
  equal(result.withdrawn, true, 'withdrawal reported');
  equal(result.branchTransition, true, 'transition recorded');
  equal(h.enforceCalls.length, 0, 'nothing created, moved or anchored');
  equal(h.dividers().length, 0, 'no divider remains connected');
  equal(h.sentinels().length, 0, 'no sentinel remains connected');
  equal(staleDivider.isConnected, false, 'stale Page 2 divider disconnected');
  equal(staleStart.isConnected, false, 'stale page-2-start disconnected');
  equal(staleEnd.isConnected, false, 'stale page-2-end disconnected');
  equal(result.created, 0, 'created zero');
  equal(result.moved, 0, 'moved zero');
});

await fixture('9 withdrawal clears pending references so nothing can be reused', () => {
  const h = makeHarness({ turns: 39, transition: { branchSelectionStale: true } });
  h.mountUnits(2);
  const state = h.api.getChatPageUnitState();
  equal(state.pendingDividers.size, 2, 'pending dividers held before withdrawal');
  h.api.reconcileChatPageUnits('branch-switch');
  equal(state.pendingDividers.size, 0, 'pending divider references cleared');
  equal(state.sentinels.size, 0, 'sentinel references cleared');
  equal(state.hydrationRequested.size, 0, 'hydration requests cleared');
  equal(state.identity, '', 'stale identity dropped');
  equal(state.last, null, 'withdrawal never stands in as a settled layout');
});

await fixture('10 a stale Page 2 unit cannot be reused, recreated or anchored during the gate', () => {
  const h = makeHarness({ turns: 39, transition: { trustedSelectionIntentActive: true } });
  h.mountUnits(2);
  h.api.reconcileChatPageUnits('branch-switch');
  // Repeated passes during the same transition stay inert and idempotent.
  for (let i = 0; i < 3; i += 1) {
    const again = h.api.reconcileChatPageUnits(`branch-switch-${i}`);
    equal(again.status, 'branch-transition-withdrawn', `pass ${i} stays withdrawn`);
    equal(again.removed, 0, `pass ${i} removes nothing further (idempotent)`);
  }
  equal(h.enforceCalls.length, 0, 'no anchor rung was ever consulted');
  equal(h.dividers().length, 0, 'no divider recreated');
  equal(h.sentinels().length, 0, 'no sentinel recreated');
});

await fixture('11 no clickable stale control and no CSS-only hiding', () => {
  const h = makeHarness({ turns: 39, transition: { branchSelectionStale: true } });
  h.mountUnits(2);
  const staleDivider = h.divider(2);
  h.api.reconcileChatPageUnits('branch-switch');
  equal(staleDivider.parentElement, null, 'divider removed from the DOM, not hidden');
  const withdraw = extractFunction(CORE_SOURCE, 'withdrawChatPageUnits');
  ok(!/display|visibility|opacity|hidden/.test(withdraw), 'withdrawal applies no CSS visibility');
  ok(withdraw.includes('removeH2OChatPageUnitNode'), 'withdrawal removes through the owned-node predicate only');
});

await fixture('12 withdrawal never removes host conversation nodes', () => {
  const h = makeHarness({ turns: 39, transition: { branchSelectionStale: true } });
  h.mountUnits(2);
  const host = new El('ARTICLE', 'host-turn');
  host.setAttribute('data-testid', 'conversation-turn-17');
  h.root.appendChild(host);
  const foreign = new El('SPAN', 'not-ours');
  foreign.setAttribute(BOUNDARY_ATTR, 'page-2-start');   // similar text, no owner stamp
  h.root.appendChild(foreign);
  h.api.reconcileChatPageUnits('branch-switch');
  equal(host.isConnected, true, 'host turn survives');
  equal(foreign.isConnected, true, 'foreign look-alike survives');
});

await fixture('13 incoherent presentation withdraws even without a transition flag', () => {
  // Authority already reports 18 while the model still holds 39.
  const h = makeHarness({ turns: 39, effectiveCount: 18, effectiveFp: FP_18 });
  h.mountUnits(2);
  const coherence = h.api.chatPageUnitPresentationCoherence({ count: 39 });
  equal(coherence.coherent, false, 'model and authority disagree');
  equal(coherence.reason, 'effective-count-mismatch', 'explicit incoherence reason');
  const result = h.api.reconcileChatPageUnits('post-switch');
  equal(result.status, 'branch-transition-withdrawn', 'fail-closed');
  equal(result.presentationCoherent, false, 'incoherence recorded');
  equal(h.enforceCalls.length, 0, 'no placement under incoherence');
});

await fixture('14 after coherent 18-turn authority only Page 1 rebuilds', () => {
  const h = makeHarness({ turns: 39, transition: { branchSelectionStale: true } });
  h.mountUnits(2);
  h.api.reconcileChatPageUnits('branch-switch');
  equal(h.dividers().length, 0, 'withdrawn');
  // New presentation lands: turn list, authority and flags all agree on 18.
  h.setTurns(18);
  h.sandbox.callEffectiveTurnRuntime = (verb) => {
    if (verb === 'STATUS') return { source: 'canonical', overlayActive: false, count: 18, canonicalFingerprint: CANONICAL_FP, anchorQId: null, pathLength: 0, generation: 7 };
    if (verb === 'INDEX') return { sourceFingerprint: FP_18, turns: new Array(18).fill(null) };
    return null;
  };
  h.sandbox.getTurnRuntimeApi = () => ({ getCompleteTurnIndexProjectionStatus: () => ({ enabled: true, authoritative: true, branchSelectionStale: false, trustedSelectionIntentActive: false }) });
  const rebuilt = h.api.reconcileChatPageUnits('post-switch');
  equal(rebuilt.status === 'branch-transition-withdrawn', false, 'transition cleared');
  equal(h.enforceCalls.length, 1, 'placement resumes exactly once');
  equal(h.enforceCalls[0].pageCount, 1, 'only Page 1 units are built');
  equal(h.unit(2, 'start'), null, 'no page-2-start remains');
  equal(h.unit(2, 'end'), null, 'no page-2-end remains');
  equal(h.divider(2), null, 'no Page 2 divider remains');
  // Page 1 is now the final page.
  const model = h.api.buildChatPageUnitModel();
  equal(model.pageCount, 1, 'single page model');
  equal(model.pages[0].endOrder, 18, 'Page 1 ends at turn 18');
});

await fixture('15 switching back to a coherent 39-turn branch rebuilds two pages', () => {
  const h = makeHarness({ turns: 18, effectiveFp: FP_18 });
  h.mountUnits(1);
  h.setTurns(39);
  h.sandbox.callEffectiveTurnRuntime = (verb) => {
    if (verb === 'STATUS') return { source: 'canonical', overlayActive: false, count: 39, canonicalFingerprint: CANONICAL_FP, anchorQId: null, pathLength: 0, generation: 7 };
    if (verb === 'INDEX') return { sourceFingerprint: FP_39, turns: new Array(39).fill(null) };
    return null;
  };
  const rebuilt = h.api.reconcileChatPageUnits('branch-return');
  equal(rebuilt.status === 'branch-transition-withdrawn', false, 'coherent, so no withdrawal');
  equal(h.enforceCalls.length, 1, 'placement runs');
  equal(h.enforceCalls[0].pageCount, 2, 'two pages rebuilt');
});

await fixture('16 branch changes start expanded', () => {
  // Withdrawal removes units and clears state; it never writes a collapsed
  // marker, and the collapsed attribute is applied only by the Chat page
  // decorate path from authority.
  const withdraw = extractFunction(CORE_SOURCE, 'withdrawChatPageUnits');
  ok(!/COLLAPSED|collapsed/.test(withdraw), 'withdrawal writes no collapsed state');
  const reconcile = extractFunction(CORE_SOURCE, 'reconcileChatPageUnits');
  const gate = reconcile.slice(reconcile.indexOf('{'), reconcile.indexOf('const candidatesByPage'));
  ok(!/collapsed/i.test(gate), 'the gate writes no collapsed state');
});

// ══════════════════════════════════════════════════════════════════════════
// E — sentinel ownership and removal
// ══════════════════════════════════════════════════════════════════════════

await fixture('17 removeH2OChatPageUnitNode removes every owned page unit', () => {
  const h = makeHarness({ turns: 39 });
  for (const [page, kind] of [[1, 'start'], [1, 'end'], [2, 'start'], [2, 'end']]) {
    const sentinel = h.api.createChatPageBoundarySentinel(page, kind);
    h.root.appendChild(sentinel);
    equal(sentinel.getAttribute(BOUNDARY_ATTR), `page-${page}-${kind}`, `sentinel stores page-${page}-${kind}`);
    equal(h.api.removeH2OChatPageUnitNode(sentinel), true, `page-${page}-${kind} removed`);
    equal(sentinel.isConnected, false, `page-${page}-${kind} disconnected`);
  }
  const divider = new El('DIV', 'cgxui-chat-page-divider');
  h.root.appendChild(divider);
  equal(h.api.removeH2OChatPageUnitNode(divider), true, 'owned divider removed');
  const pgnw = new El('DIV', 'cgxui-pgnw-page-divider');
  h.root.appendChild(pgnw);
  equal(h.api.removeH2OChatPageUnitNode(pgnw), true, 'owned pgnw divider removed');
  const legacy = new El('SPAN');
  legacy.setAttribute(BOUNDARY_ATTR, '1');
  h.root.appendChild(legacy);
  equal(h.api.removeH2OChatPageUnitNode(legacy), true, 'legacy "1" marker still removed');
});

await fixture('18 the removal predicate refuses foreign and malformed nodes', () => {
  const h = makeHarness({ turns: 39 });
  const cases = [
    ['host span with no attributes', () => new El('SPAN', 'host-thing')],
    ['similar text, no owner stamp', () => { const n = new El('SPAN'); n.setAttribute(BOUNDARY_ATTR, 'page-2-start'); return n; }],
    ['owner stamp, wrong value form', () => { const n = new El('SPAN'); n.setAttribute(BOUNDARY_ATTR, 'page-x-start'); n.setAttribute('data-cgxui-owner', OWNER); return n; }],
    ['page zero is not a page', () => { const n = new El('SPAN'); n.setAttribute(BOUNDARY_ATTR, 'page-0-start'); n.setAttribute('data-cgxui-owner', OWNER); n.setAttribute('data-h2o-chat-page-boundary-page', '0'); n.setAttribute('data-h2o-chat-page-boundary-kind', 'start'); return n; }],
    ['page/kind attributes disagree', () => { const n = new El('SPAN'); n.setAttribute(BOUNDARY_ATTR, 'page-2-start'); n.setAttribute('data-cgxui-owner', OWNER); n.setAttribute('data-h2o-chat-page-boundary-page', '3'); n.setAttribute('data-h2o-chat-page-boundary-kind', 'start'); return n; }],
    ['unknown kind', () => { const n = new El('SPAN'); n.setAttribute(BOUNDARY_ATTR, 'page-2-middle'); n.setAttribute('data-cgxui-owner', OWNER); n.setAttribute('data-h2o-chat-page-boundary-page', '2'); n.setAttribute('data-h2o-chat-page-boundary-kind', 'middle'); return n; }],
  ];
  for (const [label, make] of cases) {
    const node = make();
    h.root.appendChild(node);
    equal(h.api.removeH2OChatPageUnitNode(node), false, `refuses: ${label}`);
    equal(node.isConnected, true, `survives: ${label}`);
  }
});

await fixture('19 sentinels remain page-unit markers, not host boundary proof', () => {
  // The repair changed only removability. Rendered-boundary authority still
  // resolves through the exact host wrapper identity.
  ok(CORE_SOURCE.includes("String(child.getAttribute?.('data-turn-id-container') || '').trim() === qId"), 'exact wrapper identity retained');
  const sentinel = extractFunction(CORE_SOURCE, 'createChatPageBoundarySentinel');
  ok(!sentinel.includes('data-turn-id-container'), 'sentinels carry no host boundary identity');
});

// ══════════════════════════════════════════════════════════════════════════
// F — same-branch deferred placement is preserved
// ══════════════════════════════════════════════════════════════════════════

await fixture('20 coherent same-branch anchor loss is deferred, never withdrawn', () => {
  const h = makeHarness({ turns: 39 });
  h.mountUnits(2);
  const divider = h.divider(2);
  // Anchors are a placement concern; the gate never consults them.
  const result = h.api.reconcileChatPageUnits('anchor-transiently-lost');
  equal(result.status === 'branch-transition-withdrawn', false, 'no withdrawal');
  equal(h.enforceCalls.length, 1, 'placement still runs and can defer');
  equal(divider.isConnected, true, 'divider retained for the deferred case');
  equal(h.sentinels().length, 4, 'sentinels retained');
});

await fixture('21 absent virtualized wrappers never trigger withdrawal', () => {
  // Coherence compares counts and fingerprints only - it must not look at
  // mounted wrappers, which virtualization removes inside one coherent branch.
  const coherence = extractFunction(CORE_SOURCE, 'chatPageUnitPresentationCoherence');
  for (const f of ['isConnected', 'querySelector', 'wrapper', 'nativeSlot', 'parentNode']) {
    ok(!coherence.includes(f), `coherence ignores ${f}`);
  }
  const h = makeHarness({ turns: 39 });
  h.mountUnits(2);
  // Strip every host wrapper: the model and authority still agree on 39.
  for (const child of h.root.children.slice()) {
    if (String(child.className).includes('host')) child.remove();
  }
  const result = h.api.reconcileChatPageUnits('virtualized');
  equal(result.status === 'branch-transition-withdrawn', false, 'no withdrawal from unmounted wrappers');
  equal(h.enforceCalls.length, 1, 'placement proceeds');
});

await fixture('22 authority that cannot be read never forces withdrawal', () => {
  const h = makeHarness({ turns: 39 });
  h.sandbox.callEffectiveTurnRuntime = () => null;
  const coherence = h.api.chatPageUnitPresentationCoherence({ count: 39 });
  equal(coherence.coherent, true, 'unreadable authority proves nothing');
  equal(coherence.reason, 'authority-unavailable', 'explicit reason');
});

// ══════════════════════════════════════════════════════════════════════════
// G — accepted work is untouched
// ══════════════════════════════════════════════════════════════════════════

await fixture('23 no recursion or observer re-entry is introduced', () => {
  const reconcile = extractFunction(CORE_SOURCE, 'reconcileChatPageUnits');
  const gate = reconcile.slice(reconcile.indexOf('{'), reconcile.indexOf('const candidatesByPage'));
  ok(!/reconcileChatPageUnits\(/.test(gate), 'the gate never re-enters reconciliation');
  ok(!/renderChatPageDividers\(/.test(gate), 'the gate schedules no render pass');
  const withdraw = extractFunction(CORE_SOURCE, 'withdrawChatPageUnits');
  for (const f of ['reconcileChatPageUnits(', 'renderChatPageDividers(', 'setTimeout(', 'requestAnimationFrame(', 'MutationObserver']) {
    ok(!withdraw.includes(f), `withdrawal does not call ${f}`);
  }
  ok(reconcile.includes('state.reconcileInFlight = true;'), 'withdrawal runs inside the in-flight guard');
});

await fixture('24 Stage 2C-2d final-page and control derivation survive', () => {
  ok(CORE_SOURCE.includes('exact-terminal-page-artifact'), 'final-page terminal-tail anchoring retained');
  /* Structural rather than an exact source literal. The protected block moved
     from the collapse wrapper into the windowed expansion that wrapper now
     delegates to; the guard, the call and the derivation are identical and only
     the indentation depth changed, so matching the literal reported a pure
     re-indentation as a lost invariant. The three guarantees the literal stood
     for are asserted directly, and each of them still fails if the guard is
     dropped, the call is removed, or an unguarded duplicate appears. */
  const expandedControlCalls = [...PAGE_SOURCE.matchAll(/applyExpandedCollapseControlState\(num,\s*id\)/g)];
  equal(expandedControlCalls.length, 1, 'exactly one expanded-control invocation on the protected path');
  ok(
    /if\s*\(\s*!explicitExpansion\s*\)\s*\{\s*applyExpandedCollapseControlState\(num,\s*id\)\s*;\s*\}/.test(PAGE_SOURCE),
    'authoritative expanded-control derivation retained under its !explicitExpansion guard',
  );
  ok(
    expandedControlCalls.every((call) => /if\s*\(\s*!explicitExpansion\s*\)\s*\{\s*$/.test(
      PAGE_SOURCE.slice(Math.max(0, call.index - 160), call.index),
    )),
    'no unguarded expanded-control invocation exists',
  );
  equal((PAGE_SOURCE.match(/typeof applyExpandedCollapseControlState/g) || []).length, 0, 'no test-harness guard leaked');
  equal((PAGE_SOURCE.match(/function executeAtomicPageCollapseTransaction\(/g) || []).length, 1, 'one collapse transaction owner');
});

await fixture('25 Stage 2C-2eA title-bar remount restoration survives', () => {
  ok(TITLE_SOURCE.includes('TIME_recoverRemountedTitleBar'), 'recovery helper retained');
  ok(TITLE_SOURCE.includes('DOM_liveAnswerTitleBar'), 'live-bar resolver retained');
  equal((TITLE_SOURCE.match(/STATE_\.seen\.clear\(/g) || []).length, 0, 'seen ledger never cleared');
  equal((TITLE_SOURCE.match(/STATE_\.seen\.delete\(/g) || []).length, 0, 'seen ledger never pruned');
});

await fixture('26 corrected Stage 2C-2eB hit target and Tags behaviour survive', () => {
  equal((SKIN_SOURCE.match(/divider-dot::before/g) || []).length, 0, 'rejected pseudo-element still absent');
  ok(SKIN_SOURCE.includes('.cgxui-chat-page-divider-dot-hit,'), 'real hit child rule retained');
  ok(CORE_SOURCE.includes('ensureChatPageDividerDotHitEl'), 'hit child still created by MiniMap Core');
  const tokens = PAGE_SOURCE.slice(PAGE_SOURCE.indexOf('const DIVIDER_VISUAL_KEYS'));
  equal(Number((tokens.match(/dotSizeExpandedPx:\s*(\d+)/) || [])[1]), 14, 'visible circle still 14');
  equal(Number((SKIN_SOURCE.match(/DOT_HIT_SIZE_PX:\s*(\d+)/) || [])[1]), 28, 'hit target still 28');
  equal((PAGE_SOURCE.match(/addEventListener\('click',\s*S\.onDivider/g) || []).length, 2, 'still two divider click listeners');
  ok(PAGE_SOURCE.includes('openTagsCloudFromDivider'), 'Tags behaviour retained');
});

await fixture('27 MiniMap synchronization ownership is unchanged', () => {
  ok(PAGE_SOURCE.includes('propagateChatPageCollapseToMiniMap'), 'Chat to MiniMap one-way propagation retained');
  const withdraw = extractFunction(CORE_SOURCE, 'withdrawChatPageUnits');
  for (const f of ['propagate', 'MiniMap', 'setPageCollapsed', 'miniMap']) {
    ok(!withdraw.includes(f), `withdrawal does not touch ${f}`);
  }
  const coherence = extractFunction(CORE_SOURCE, 'chatPageUnitPresentationCoherence');
  ok(!/propagate|setPageCollapsed/.test(coherence), 'coherence owns no collapse state');
});

await fixture('28 no persistence or canonical publication behaviour changes', () => {
  const touched = ['withdrawChatPageUnits', 'chatPageUnitPresentationCoherence', 'chatPageUnitBranchTransitionActive', 'isOwnedChatPageBoundarySentinel'];
  for (const name of touched) {
    const body = extractFunction(CORE_SOURCE, name);
    for (const f of ['localStorage', 'sessionStorage', 'storageSet', 'storageGet', 'publish', 'fetch(']) {
      ok(!body.includes(f), `${name} does not touch ${f}`);
    }
  }
});

// ══════════════════════════════════════════════════════════════════════════
// H — stale MiniMap active identity cannot preserve the previous counter
// ══════════════════════════════════════════════════════════════════════════

await fixture('29 rebuilt 18-turn list falls back from stale Turn 25 to exactly 1/18', () => {
  const h = makeRebuildCounterHarness();
  equal(h.listIds.length, 18, 'exactly 18 rebuilt buttons');
  equal(h.listIds[0], 'turn-1', 'list begins at Turn 1');
  equal(h.listIds[17], 'turn-18', 'list ends at Turn 18');
  equal(h.listIds.includes(h.oldTurn25Id), false, 'old Turn 25 button is absent');
  const activated = h.api.applyRebuildActiveId(h.oldTurn25Id, '39-to-18');
  equal(activated, false, 'stale activation reports failure');
  equal(h.stats.setActiveCalls.length, 1, 'setActive called exactly once');
  equal(h.stats.setActiveCalls[0].id, h.oldTurn25Id, 'failed identity is exact old Turn 25');
  equal(h.stats.counterCalls.length, 1, 'fallback counter written exactly once');
  equal(h.stats.counterCalls[0], '', 'fallback uses the existing empty-ID contract');
  equal(h.stats.counterText, '1/18', 'counter is exactly 1/18');
  equal(h.stats.counterText === '25/39', false, 'old complete counter is gone');
  equal(h.activeMarkerIds().length, 0, 'no stale active DOM marker remains');
  equal(h.S.lastActiveTurnIdFast, '', 'fast stale identity cleared');
  equal(h.S.lastActiveBtnId, '', 'button stale identity cleared');
});

await fixture('30 finalizeRebuildUi uses the same failed-activation fallback', () => {
  const h = makeRebuildCounterHarness();
  const activated = h.api.finalizeRebuildUi('39-to-18');
  equal(activated, false, 'finalizer returns false after failed activation');
  equal(h.stats.setActiveCalls.length, 1, 'finalizer attempts activation once');
  equal(h.stats.counterCalls.length, 1, 'finalizer writes one fallback');
  equal(h.stats.counterCalls[0], '', 'finalizer fallback uses empty ID');
  equal(h.stats.counterText, '1/18', 'finalizer reaches 1/18');
  equal(h.S.lastActiveTurnIdFast, '', 'finalizer clears stale fast identity');
  equal(h.S.lastActiveBtnId, '', 'finalizer clears stale button identity');
});

await fixture('31 successful rebuild activation writes its counter once with no fallback', () => {
  for (const method of ['applyRebuildActiveId', 'finalizeRebuildUi']) {
    const h = makeRebuildCounterHarness({ cachedFast: 'turn-18', cachedBtn: 'turn-18' });
    const activated = method === 'applyRebuildActiveId'
      ? h.api.applyRebuildActiveId('turn-18', 'success')
      : h.api.finalizeRebuildUi('success');
    equal(activated, true, `${method} reports success`);
    equal(h.stats.setActiveCalls.length, 1, `${method} activates once`);
    equal(h.stats.counterCalls.length, 1, `${method} writes the successful counter once`);
    equal(h.stats.counterCalls[0], 'turn-18', `${method} never invokes empty-ID fallback`);
    equal(h.stats.counterText, '18/18', `${method} preserves successful activation counter`);
    equal(h.activeMarkerIds().join(','), 'turn-18', `${method} has one active marker`);
  }
});

await fixture('32 absent cached identity writes one fallback without calling setActive', () => {
  const h = makeRebuildCounterHarness({ cachedFast: '', cachedBtn: '' });
  equal(h.api.applyRebuildActiveId('', 'empty'), false, 'empty identity is not activated');
  equal(h.stats.setActiveCalls.length, 0, 'setActive is not called');
  equal(h.stats.counterCalls.length, 1, 'one fallback write');
  equal(h.stats.counterCalls[0], '', 'empty fallback identity');
  equal(h.stats.counterText, '1/18', 'empty path preserves architecture fallback');
});

await fixture('33 stale clearing cannot erase a newer valid concurrent identity', () => {
  const h = makeRebuildCounterHarness({ concurrentActiveId: 'turn-18' });
  equal(h.api.applyRebuildActiveId(h.oldTurn25Id, 'concurrent'), false, 'old activation still fails');
  equal(h.S.lastActiveTurnIdFast, 'turn-18', 'newer fast identity retained');
  equal(h.S.lastActiveBtnId, 'turn-18', 'newer button identity retained');
  equal(h.activeMarkerIds().join(','), 'turn-18', 'newer active marker retained');
  equal(h.stats.counterCalls.filter((id) => id === '').length, 1, 'failed pass still performs one fallback');
});

await fixture('34 production rebuild caller uses one guarded activation path', () => {
  const rebuild = extractFunction(CORE_SOURCE, 'rebuildNow');
  equal((rebuild.match(/applyRebuildActiveId\(activeId, why\)/g) || []).length, 1, 'main caller invokes guarded helper once');
  equal((rebuild.match(/finalizeRebuildUi\(why\)/g) || []).length, 0, 'main caller cannot duplicate activation through finalizer');
  equal((rebuild.match(/setActive\(activeId, `rebuild:/g) || []).length, 0, 'main caller never ignores setActive directly');
  const apply = extractFunction(CORE_SOURCE, 'applyRebuildActiveId');
  ok(apply.includes('setActive(activeId, `rebuild:${String(reason || \'core:rebuild\')}`) === true'), 'helper consumes exact boolean success');
  ok(apply.includes("try { updateCounter(''); } catch {}"), 'failed path owns the empty-ID fallback');
  const finalize = extractFunction(CORE_SOURCE, 'finalizeRebuildUi');
  ok(finalize.includes('return applyRebuildActiveId(activeId, reason);'), 'finalizer returns guarded result without unconditional true');
});

await fixture('35 mutation ignoring setActive return is killed', () => {
  const source = extractFunction(CORE_SOURCE, 'applyRebuildActiveId');
  const needle = "        activated = setActive(activeId, `rebuild:${String(reason || 'core:rebuild')}`) === true;";
  const mutant = source.replace(needle, "        setActive(activeId, `rebuild:${String(reason || 'core:rebuild')}`);\n        activated = true;");
  ok(mutant !== source, 'ignore-return mutant applied');
  const h = makeRebuildCounterHarness({ sources: { applyRebuildActiveId: mutant } });
  equal(h.api.applyRebuildActiveId(h.oldTurn25Id, 'mutant'), true, 'mutant falsely reports success');
  equal(h.stats.counterText, '25/39', 'mutant preserves stale counter and is observable');
});

await fixture('36 mutation returning true unconditionally from finalizer is killed', () => {
  const source = extractFunction(CORE_SOURCE, 'finalizeRebuildUi');
  const mutant = source.replace(
    '    return applyRebuildActiveId(activeId, reason);',
    '    applyRebuildActiveId(activeId, reason);\n    return true;',
  );
  ok(mutant !== source, 'unconditional-true mutant applied');
  const h = makeRebuildCounterHarness({ sources: { finalizeRebuildUi: mutant } });
  equal(h.api.finalizeRebuildUi('mutant'), true, 'mutant masks failed activation');
  equal(h.stats.setActiveCalls[0].id, h.oldTurn25Id, 'masked attempt was the missing Turn 25');
});

await fixture('37 mutation omitting failed-path fallback is killed', () => {
  const source = extractFunction(CORE_SOURCE, 'applyRebuildActiveId');
  const mutant = source.replace("    try { updateCounter(''); } catch {}", '    void 0;');
  ok(mutant !== source, 'missing-fallback mutant applied');
  const h = makeRebuildCounterHarness({ sources: { applyRebuildActiveId: mutant } });
  equal(h.api.applyRebuildActiveId(h.oldTurn25Id, 'mutant'), false, 'activation still fails');
  equal(h.stats.counterCalls.length, 0, 'mutant writes no fallback');
  equal(h.stats.counterText, '25/39', 'mutant leaves stale counter visible');
});

await fixture('38 mutation retaining stale active identity is killed', () => {
  const source = extractFunction(CORE_SOURCE, 'applyRebuildActiveId');
  const mutant = source.replace('      clearMissingRebuildActiveIdentity(activeId);', '      void activeId;');
  ok(mutant !== source, 'retain-stale mutant applied');
  const h = makeRebuildCounterHarness({ sources: { applyRebuildActiveId: mutant } });
  h.api.applyRebuildActiveId(h.oldTurn25Id, 'mutant');
  equal(h.S.lastActiveTurnIdFast, h.oldTurn25Id, 'mutant retains fast stale identity');
  equal(h.S.lastActiveBtnId, h.oldTurn25Id, 'mutant retains button stale identity');
});

await fixture('39 mutation adding fallback after successful activation is killed', () => {
  const source = extractFunction(CORE_SOURCE, 'applyRebuildActiveId');
  const mutant = source.replace('      if (activated) return true;', "      if (activated) { updateCounter(''); return true; }");
  ok(mutant !== source, 'duplicate-fallback mutant applied');
  const h = makeRebuildCounterHarness({
    cachedFast: 'turn-18',
    cachedBtn: 'turn-18',
    sources: { applyRebuildActiveId: mutant },
  });
  equal(h.api.applyRebuildActiveId('turn-18', 'mutant'), true, 'activation itself succeeds');
  equal(h.stats.setActiveCalls.length, 1, 'mutant still calls setActive once');
  equal(h.stats.counterCalls.length, 2, 'mutant performs duplicate counter write');
  equal(h.stats.counterCalls[1], '', 'duplicate write is the forbidden fallback');
});

await fixture('40 conflicting reverse-expansion Page 2 head keeps page units withdrawn', () => {
  const h = makeHarness({
    turns: 39,
    effectiveCount: 39,
    effectiveFp: FP_39,
    pageHeadState: 'conflict',
    transition: {
      branchExpansionFailClosed: true,
      branchExpansionState: 'fail-closed',
      branchExpansionReason: 'native-page-head-conflict',
      branchExpansionPriorCount: 18,
      branchExpansionTargetCount: 39,
      branchExpansionExpectedFingerprint: FP_39,
      branchExpansionRequiredPageNums: [2],
    },
  });
  h.mountUnits(2);
  const result = h.api.reconcileChatPageUnits('reverse-expansion-conflict');
  equal(result.withdrawn, true, 'conflicting expansion is withdrawn');
  equal(result.withdrawalReason, 'native-page-head-conflict', 'native conflict is diagnostic reason');
  equal(result.status, 'native-page-head-conflict-withdrawn', 'precise ordering status');
  equal(result.pageCount, 0, 'withdrawn result publishes zero pages');
  equal(h.document.documentElement.getAttribute('data-h2o-page-unit-ordering-count'), '0', 'diagnostic ordering count is zero');
  equal(h.enforceCalls.length, 0, 'ordering enforcement is sealed');
  equal(h.divider(2), null, 'no Page 2 divider survives or rebuilds');
});


await fixture('29 a current selected-path overlay settles page units despite stale scope and a retained intent', () => {
  const make = (projection, effective) => {
    const sandbox = { console };
    vm.createContext(sandbox);
    const src = extractFunction(CORE_SOURCE, 'chatPageUnitBranchTransitionActive')
      + `\nfunction getCompleteIndexProjectionStatus(){ return ${JSON.stringify(projection)}; }`
      + `\nfunction getEffectivePresentationRuntimeStatus(){ return ${JSON.stringify(effective)}; }`
      + `\nglobalThis.__active = chatPageUnitBranchTransitionActive();`;
    new vm.Script(src, { filename: CORE_PATH }).runInContext(sandbox);
    return sandbox.__active;
  };
  const staleIntent = {
    trustedSelectionIntentActive: true, branchSelectionStale: true,
    branchExpansionPending: false, branchExpansionFailClosed: false,
    selectedPathRequestLeaseActive: false, selectedPathConfirmationLeaseActive: false,
    selectedPathConfirmationPending: false,
  };
  const overlayOn = { overlayActive: true, source: 'selected-path-overlay', count: 39 };
  const overlayOff = { overlayActive: false, source: 'canonical', count: 39 };
  equal(make(staleIntent, overlayOff), true, 'no overlay: stale scope keeps units withdrawn');
  equal(make(staleIntent, overlayOn), false, 'a published overlay IS the completed branch: units settle');
  equal(make({ ...staleIntent, selectedPathRequestLeaseActive: true }, overlayOn), true, 'a pending request lease still withholds settlement');
  equal(make({ ...staleIntent, branchExpansionPending: true }, overlayOn), true, 'pending expansion still withholds settlement');
  equal(make({ ...staleIntent, branchTransactionPending: true }, overlayOn), true, 'a pending branch transaction dominates every other flag');
});

// ── Stage 2C Items 1-2 — effective-path identity, badge cache, transition
// authority. Owned here because this validator already owns branch-transition
// authority and already executes the real 1A1b bodies. Every assertion below
// runs extracted production source, not a pattern match.
await fixture('stage-2c items 1-2: effective-path identity is separate, guarded and authoritative', () => {
  // (1)(3) The accessor is its own function and the pinned getter is untouched
  // by it: neither body references the other, so nothing was replaced.
  const accessorSrc = extractFunction(CORE0_SOURCE, 'getChatAtlasEffectivePathIdentity');
  const pinnedSrc = extractFunction(CORE0_SOURCE, 'getCompleteTurnIndexProjectionStatus');
  ok(accessorSrc.length > 0, 'accessor exists independently in Core');
  equal(pinnedSrc.includes('getChatAtlasEffectivePathIdentity'), false,
    'pinned projection getter does not call or wrap the new accessor');
  equal(accessorSrc.includes('function getCompleteTurnIndexProjectionStatus'), false,
    'accessor does not redefine the pinned getter');
  // The byte pin that used to stand here was a proxy for THIS fixture's real
  // claim: that introducing getChatAtlasEffectivePathIdentity did not replace,
  // wrap or absorb the projection getter. The two assertions above state that
  // directly. Byte identity additionally forbade any later change to the
  // getter for any reason, which has since collided with two separately
  // accepted corrections to its body - memoizing the native diagnostics it
  // spread in (the steady-state selector-storm fix) and reporting a disabled
  // gate truthfully instead of as 'idle'. Neither touches this fixture's
  // subject, so the contract is stated semantically instead: the getter
  // remains one self-contained function that still publishes the
  // branch-transition fields page-unit withdrawal reads.
  ok(/^\s*function getCompleteTurnIndexProjectionStatus\(/.test(pinnedSrc),
    'projection getter remains its own self-contained function');
  equal((pinnedSrc.match(/function getCompleteTurnIndexProjectionStatus\(/g) || []).length, 1,
    'projection getter is not redefined inside its own body');
  for (const field of [
    'branchTransactionPending',
    'branchExpansionPending',
    'branchExpansionFailClosed',
    'selectedPathRequestLeaseActive',
    'selectedPathConfirmationLeaseActive',
    'selectedPathConfirmationPending',
    'trustedSelectionIntentActive',
    'branchSelectionStale',
  ]) {
    ok(pinnedSrc.includes(`${field}:`),
      `projection getter still publishes ${field} for page-unit withdrawal`);
  }

  // (2) exported on the public runtime api. The accessor and its export both
  // moved to 0A3a, which adopts H2O.turnRuntime through Object.assign(rt, {...}),
  // so the export is a shorthand property at that block's indentation instead of
  // H2O Core's old four-space list. The requirement is unchanged — the name must
  // reach the public runtime surface — and scoping the match to the adoption
  // block keeps it from passing on any incidental mention.
  const rtAdoption = ATLAS_CORE_SOURCE.slice(ATLAS_CORE_SOURCE.indexOf('Object.assign(rt, {'));
  ok(/\n\s+getChatAtlasEffectivePathIdentity,\n/.test(rtAdoption),
    'accessor is exported on the public api surface');

  // (4)(5) Run the REAL accessor body with controlled dependencies.
  const ctx = {
    getEffectivePresentationIndex: () => ({ turns: [{ qId: 'q1' }, { qId: 'q2' }], sourceFingerprint: 'fp-eff' }),
    getEffectivePresentationStatus: () => ({ source: 'selected-path-overlay', overlayActive: true, pathLength: 2 }),
    chatAtlasPathIdentityKey: (t) => `k:${t.length}`,
    chatAtlasCompleteIndexStableHash: (v) => `h${String(v).length}`,
    chatAtlasFreeze: (o) => Object.freeze(o),
    completeTurnIndexAuthorityState: { chatId: 'c1', generation: 7 },
    JSON, String, Number, Array, Object,
  };
  vm.createContext(ctx);
  vm.runInContext(`${accessorSrc}\nglobalThis.__out = getChatAtlasEffectivePathIdentity();`, ctx);
  const out = ctx.__out;
  ok(Object.isFrozen(out), 'accessor result is frozen');
  equal(out.effectiveCount, 2, 'effectiveCount reflects the effective path length');
  equal(out.effectiveSource, 'selected-path-overlay', 'effectiveSource is exposed');
  equal(out.overlayActive, true, 'overlayActive is exposed');
  ok(typeof out.effectivePathRevision === 'string' && out.effectivePathRevision.startsWith('djb2:'),
    'effectivePathRevision is exposed as a hash');
  ok(Object.values(out).every((v) => v === null || ['string', 'number', 'boolean'].includes(typeof v)),
    'accessor result is content-free: primitives only');

  // Fail-closed: a throwing dependency must not throw out of the accessor.
  const ctx2 = { ...ctx, getEffectivePresentationIndex: () => { throw new Error('x'); },
    getEffectivePresentationStatus: () => { throw new Error('x'); } };
  vm.createContext(ctx2);
  vm.runInContext(`${accessorSrc}\nglobalThis.__out = getChatAtlasEffectivePathIdentity();`, ctx2);
  equal(ctx2.__out.effectiveCount, 0, 'accessor fails closed to zero effective count');
  equal(ctx2.__out.overlayActive, false, 'accessor fails closed to non-overlay');
});

await fixture('stage-2c item 2: badge cache follows effective-path authority', () => {
  const mapSrc = extractFunction(CORE_SOURCE, 'getBranchBadgeMap');
  let rebuilds = 0;
  const base = { effectivePathRevision: 'djb2:r1', effectiveCount: 18, effectiveSource: 'selected-path-overlay', overlayActive: true };
  let eff = { ...base };
  const ctx = {
    getCompleteIndexProjectionStatus: () => ({ enabled: true, chatId: CHAT_ID, routeGeneration: 3, fingerprint: CANONICAL_FP, count: 39 }),
    getEffectivePathIdentity: () => eff,
    branchBadgeCache: { key: '', byQId: null },
    getTurnRuntimeApi: () => ({ getChatAtlasBranchBadges: () => { rebuilds += 1; return [{ qId: 'q1', primaryAId: 'a1' }]; } }),
    Map, String, Object, Array, Number,
  };
  vm.createContext(ctx);
  const run = `${mapSrc}\nglobalThis.__m = getBranchBadgeMap();`;
  vm.runInContext(run, ctx); equal(rebuilds, 1, 'first badge map computes once');
  vm.runInContext(run, ctx); equal(rebuilds, 1, 'unchanged effective identity hits the cache');
  // (6)(7) each effective axis alone must invalidate
  for (const [field, next, label] of [
    ['effectivePathRevision', 'djb2:r2', 'effectivePathRevision'],
    ['effectiveCount', 19, 'effectiveCount'],
    ['effectiveSource', 'canonical', 'effectiveSource'],
    ['overlayActive', false, 'overlayActive'],
  ]) {
    const before = rebuilds;
    eff = { ...base, [field]: next };
    vm.runInContext(run, ctx);
    equal(rebuilds, before + 1, `${label} change alone invalidates the badge cache`);
    eff = { ...base };
    vm.runInContext(run, ctx);
  }
});

await fixture('stage-2c item 2: MiniMap authority during and outside trusted transition', () => {
  // The real presentation-count expression, evaluated with controlled inputs.
  const i = CORE_SOURCE.indexOf('const expectedPresentationCount = overlayActive');
  ok(i > 0, 'presentation-count authority expression exists in production source');
  const expr = CORE_SOURCE.slice(i, CORE_SOURCE.indexOf(';', CORE_SOURCE.indexOf('projectedCount', i)) + 1);
  const gateI = CORE_SOURCE.indexOf('const branchTransitionInFlight =');
  ok(gateI > 0, 'transition gate exists in production source');
  const gate = CORE_SOURCE.slice(gateI, CORE_SOURCE.indexOf(';', gateI) + 1);
  const evaluate = (completeIndex, effectiveIdentity, overlayActive, effectivePresentation) => {
    const ctx = { completeIndex, effectiveIdentity, overlayActive, effectivePresentation };
    vm.createContext(ctx);
    vm.runInContext(`${gate}\n${expr}\nglobalThis.__c = expectedPresentationCount;`, ctx);
    return ctx.__c;
  };
  const eff = { available: true, effectiveCount: 19 };
  const quiet = { projectedCount: 20, branchSelectionStale: false, trustedSelectionIntentActive: false, branchTransactionPending: false };
  // (9) each established transition signal alone selects effective authority
  for (const flag of ['branchSelectionStale', 'trustedSelectionIntentActive', 'branchTransactionPending']) {
    equal(evaluate({ ...quiet, [flag]: true }, eff, false, { count: 0 }), 19,
      `${flag} alone makes effectiveCount the MiniMap authority`);
  }
  // (8) projected count is not presentation authority during a transition
  equal(evaluate({ ...quiet, branchSelectionStale: true }, eff, false, { count: 0 }) === quiet.projectedCount, false,
    'projected count is not used as authority during a trusted transition');
  // (10) outside a transition the historical projected boundary stands
  equal(evaluate(quiet, eff, false, { count: 0 }), 20, 'outside a transition projectedCount remains authoritative');
  // overlay path is unchanged by the transition gate
  equal(evaluate({ ...quiet, branchSelectionStale: true }, eff, true, { count: 39 }), 39,
    'a published overlay still supplies the effective presentation count');
  // (11) accessor-unavailable fallback reproduces historical behaviour
  equal(evaluate({ ...quiet, branchSelectionStale: true }, { available: false, effectiveCount: 0 }, false, { count: 0 }), 20,
    'older Core without the accessor falls back to historical projectedCount');
});

await fixture('stage-2c items 1-2: invariant surface unchanged', () => {
  // (12)(13) The trusted-selection subsystem adds no persistence of any kind.
  for (const [label, src] of [['Core', CORE0_SOURCE], ['MiniMap', CORE_SOURCE]]) {
    for (const api of ['sessionStorage', 'indexedDB', 'chrome.storage']) {
      equal(src.includes(api), false, `${label} introduces no ${api} persistence`);
    }
    equal(/addEventListener\(\s*['"]pagehide['"]/.test(src), false, `${label} adds no pagehide persistence`);
    equal(/addEventListener\(\s*['"]visibilitychange['"]/.test(src), false, `${label} adds no visibilitychange persistence`);
  }
  const accessorSrc = extractFunction(CORE0_SOURCE, 'getChatAtlasEffectivePathIdentity');
  const bridgeSrc = extractFunction(CORE_SOURCE, 'getEffectivePathIdentity');
  for (const [label, src] of [['accessor', accessorSrc], ['MiniMap bridge', bridgeSrc]]) {
    equal(/setItem|removeItem|localStorage|sessionStorage|indexedDB/.test(src), false,
      `${label} performs zero storage writes`);
  }
});


// ── Stage 2C — acquisition-state truthfulness ────────────────────────────
// A trusted selection whose branch transaction has PUBLISHED must never be
// rewritten into a failure by a later DOM re-derivation, nor by intent expiry.
// The real chatAtlasSelectedPathPublishedForToken body is executed here.
function extractConstBlock(source, name) {
  const at = source.indexOf(`const ${name}`);
  if (at < 0) throw new Error(`const-missing:${name}`);
  return source.slice(at, source.indexOf(']))', at) + 3);
}

function truthWorld({ txState, txToken, acqToken, acqStatus,
                     published = true, acceptedCount = 39, acceptedFingerprint = 'djb2:ok',
                     graphChat = 'c', graphRoute = '/c/c', graphGeneration = 1 }) {
  const sandbox = {
    completeTurnIndexAuthorityState: {
      branchTransactionState: txState ? { state: txState, token: txToken } : null,
      chatId: 'c', routeKey: '/c/c', generation: 1,
    },
    selectedPathAcquisitionState: {
      token: acqToken, status: acqStatus,
      lastPublicationDecision: published === null ? null
        : { published, acceptedCount, acceptedFingerprint },
      graph: graphChat === null ? null
        : { chatId: graphChat, routeKey: graphRoute, generation: graphGeneration },
    },
    chatAtlasCompleteIndexIdentity: (v) => {
      const id = String(v || '').trim();
      return /^[a-z0-9._:-]{1,256}$/i.test(id) ? id : '';
    },
    String, Number, Object, Array,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  new vm.Script(
    extractFunction(CORE0_SOURCE, 'chatAtlasSelectedPathPublishedForToken')
    + '\nglobalThis.__f = chatAtlasSelectedPathPublishedForToken;',
  ).runInContext(sandbox);
  return sandbox.__f;
}

await fixture('stage-2c A: publication ownership is enforced at the primitives', () => {
  // The rule now lives inside the two mutating primitives and the one direct
  // mutation, so it cannot be bypassed by adding another call site.
  const fail = extractFunction(CORE0_SOURCE, 'chatAtlasSelectedPathFail');
  // selectedPathFail uses the EARLIER signal — the transaction lifecycle —
  // because publication evidence does not exist yet when it can first run.
  const guardAt = fail.indexOf("transaction.state === 'pending'");
  ok(guardAt >= 0, 'selectedPathFail consults the transaction lifecycle');
  ok(fail.includes("=== 'selected-answer-not-changed'"),
    'the pending guard is scoped to the post-switch artefact only');
  ok(fail.includes('chatAtlasAcquisitionPublicationOwned()'),
    'published transactions are gated by publication ownership, not state alone');
  for (const sentinel of ["status = 'failed'", 'path = null', 'proof = null']) {
    ok(fail.indexOf(sentinel) > guardAt, `the guard precedes ${sentinel}`);
  }

  const clear = extractFunction(CORE0_SOURCE, 'chatAtlasClearSelectedPathAcquisition');
  const clearGuard = clear.indexOf('chatAtlasAcquisitionPublicationOwned()');
  ok(clearGuard >= 0, 'the clear primitive consults publication ownership');
  ok(clear.includes('chatAtlasAcquisitionResetBoundary(reason)'),
    'and exempts explicit reset boundaries');
  for (const sentinel of ["token = null", 'path = null', 'proof = null']) {
    ok(clear.indexOf(sentinel) > clearGuard, `the guard precedes ${sentinel}`);
  }

  const retain = extractFunction(CORE0_SOURCE, 'chatAtlasRetainIdentityGraph');
  ok(retain.includes('!chatAtlasAcquisitionPublicationOwned()'),
    'ordinary graph re-capture cannot destroy a published record');
  const gr = retain.indexOf("reason = 'graph-replaced'");
  ok(retain.indexOf('!chatAtlasAcquisitionPublicationOwned()') < gr,
    'the guard precedes the graph-replaced demotion');

  // Reset boundaries are classified, not string-whitelisted at call sites.
  const resets = extractConstBlock(CORE0_SOURCE, 'CHAT_ATLAS_ACQUISITION_RESET_REASONS');
  for (const r of ['route-changed', 'authority-reset', 'canonical-fingerprint-changed',
    'identity-graph-refetch-scope-drift']) {
    ok(resets.includes(r), `${r} is a genuine reset boundary`);
  }
  for (const r of ['trusted-intent-unavailable', 'trusted-intent-expired',
    'trusted-intent-superseded']) {
    ok(!resets.includes(r), `${r} is ordinary lifecycle cleanup, not a reset`);
  }

  // The compensating restores are gone: prevention, not repair.
  const hold = extractFunction(CORE0_SOURCE, 'chatAtlasSelectedPathHoldPublished');
  ok(!hold.includes("status = 'proven'"), 'the hold no longer restores status');
  const install = extractFunction(CORE0_SOURCE, 'chatAtlasInstallSelectedPathOverlay');
  ok(!install.includes("selectedPathAcquisitionState.status = 'proven'"),
    'restore-on-publish is removed');
});

await fixture('stage-2c B: an unpublished selection keeps the not-changed failure', () => {
  const f = truthWorld({ txState: 'pending', txToken: 't1', acqToken: 't1', acqStatus: 'proven' });
  equal(f('t1'), false, 'a pending transaction is not a completed selection');
  const g = truthWorld({ txState: null, txToken: '', acqToken: '', acqStatus: 'inactive' });
  equal(g('t1'), false, 'no transaction at all is never treated as published');
});

await fixture('stage-2c C: stale or ambiguous publication still fails closed', () => {
  const base = { txState: 'published', txToken: 't1', acqToken: 't1', acqStatus: 'failed' };
  equal(truthWorld(base)('t1'), true, 'a real published decision holds even from a demoted record');
  equal(truthWorld({ ...base, published: false })('t1'), false, 'an unpublished decision proves nothing');
  equal(truthWorld({ ...base, published: null })('t1'), false, 'a missing decision proves nothing');
  equal(truthWorld({ ...base, acceptedCount: 0 })('t1'), false, 'an empty accepted path proves nothing');
  equal(truthWorld({ ...base, acceptedFingerprint: '' })('t1'), false, 'no accepted fingerprint, no proof');
  equal(truthWorld({ ...base, txState: 'pending' })('t1'), false, 'a pending transaction is not complete');
  equal(truthWorld({ ...base, txState: 'fail-closed' })('t1'), false, 'a fail-closed transaction is never complete');
  equal(truthWorld({ ...base, txToken: 'other' })('t1'), false, 'a transaction for another token proves nothing');
  equal(truthWorld({ ...base, acqToken: 'other' })('t1'), false, 'an acquisition bound elsewhere proves nothing');
  equal(truthWorld({ ...base, graphChat: null })('t1'), false, 'no retained graph, no proof');
  equal(truthWorld({ ...base, graphChat: 'other' })('t1'), false, 'a graph from another chat is out of scope');
  equal(truthWorld({ ...base, graphGeneration: 2 })('t1'), false, 'a graph from another generation is stale');
  equal(truthWorld(base)(''), false, 'an empty token never matches');
});

await fixture('stage-2c D: intent expiry does not rewrite a completed selection', () => {
  const body = extractFunction(CORE0_SOURCE, 'chatAtlasCurrentTrustedNativeBranchSelection');
  ok(body.includes('&& !chatAtlasSelectedPathPublishedForToken(intent.token)'),
    'expiry clears the acquisition only when the selection did not publish');
  const guarded = body.indexOf("&& !chatAtlasSelectedPathPublishedForToken(intent.token)");
  const guardedClear = body.indexOf('chatAtlasClearSelectedPathAcquisition', guarded);
  ok(guarded >= 0 && guardedClear > guarded,
    'the expiry clear is inside the guarded branch, not before it');
  ok(body.slice(guarded, guardedClear).indexOf('}') < 0,
    'no block closes between the guard and the clear it protects');
  ok(body.includes('completeTurnIndexAuthorityState.trustedSelectedPathIntent = null'),
    'the INTENT is still retired on expiry');
});

await fixture('stage-2c E: route reset still clears acquisition normally', () => {
  const reset = extractFunction(CORE0_SOURCE, 'chatAtlasResetCompleteIndexRoute');
  ok(reset.length > 0, 'the route reset path is intact');
  const clear = extractFunction(CORE0_SOURCE, 'chatAtlasClearSelectedPathAcquisition');
  ok(!clear.includes('chatAtlasSelectedPathPublishedForToken'),
    'the clear primitive itself is unguarded, so resets still work');
});

// ── Expired trusted-intent request-lease ownership ────────────────────────
// The page-unit gate remains fail-closed on a live lease. The repair belongs
// in 0A3a's lifecycle owner: retire only a matching lease after its work no
// longer owns the expiring intent, and never touch a newer token.
function requestLeaseWorld({ leaseToken = 'token-old', ownsIntent = false } = {}) {
  const clears = [];
  const state = {
    selectedPathRequestLease: {
      evidence: { selectionToken: leaseToken, qId: 'q-branch' },
    },
  };
  const sandbox = {
    state,
    String,
    selectedPathRequestOwnsIntent: () => ownsIntent,
    clearSelectedPathRequestLease: (reason) => {
      const lease = state.selectedPathRequestLease;
      if (!lease) return;
      clears.push({ reason, token: lease.evidence.selectionToken });
      state.selectedPathRequestLease = null;
    },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  new vm.Script(
    extractNestedFunction(ATLAS_CORE_SOURCE, 'clearExpiredSelectedPathRequestLeaseForIntent')
      + '\nglobalThis.__release = clearExpiredSelectedPathRequestLeaseForIntent;',
    { filename: `${CORE0_PATH}:expired-request-lease` },
  ).runInContext(sandbox);
  return {
    release: sandbox.__release,
    active: () => !!state.selectedPathRequestLease,
    clears,
  };
}

function trustedIntentExpiryWorld({
  leaseToken = 'token-old',
  ownsIntent = false,
  refetchOwned = false,
  published = false,
} = {}) {
  const lease = requestLeaseWorld({ leaseToken, ownsIntent });
  const intent = Object.freeze({
    token: 'token-old', observedAt: 0, qId: 'q-branch', chatId: 'chat',
    routeKey: '/c/chat', generation: 3, staleRevision: 7,
  });
  const traces = [];
  let acquisitionClears = 0;
  class FixtureDate extends Date { static now() { return 6001; } }
  const sandbox = {
    completeTurnIndexAuthorityState: {
      trustedSelectedPathIntent: intent,
      branchExpansionState: 'idle', branchExpansionLease: null,
      enabled: true, chatId: 'chat', routeKey: '/c/chat', generation: 3,
    },
    selectedPathAcquisitionState: {
      token: 'token-old', anchorQId: 'q-branch', chatId: 'chat', routeKey: '/c/chat',
      generation: 3, staleRevision: 7,
      refetchAttemptedForToken: refetchOwned ? 'token-old' : null,
      refetchActiveForToken: refetchOwned ? 'token-old' : null,
    },
    completeIndexRefreshCoordinator: {
      selectedPathRequestOwnsIntent: () => ownsIntent,
      clearExpiredSelectedPathRequestLeaseForIntent: (...args) => lease.release(...args),
    },
    COMPLETE_TURN_INDEX_REFRESH_LIMITS: { trustedSelectionWindowMs: 5000 },
    CHAT_ATLAS_BRANCH_EXPANSION_MAX_MS: 12000,
    chatAtlasCompleteIndexIdentity: (value) => String(value || '').trim(),
    chatAtlasPreExpansionCanonicalReturnWindow: () => Object.freeze({ active: false }),
    chatAtlasBranchTransactionCurrent: () => published
      ? Object.freeze({ state: 'published', token: 'token-old' })
      : null,
    chatAtlasSelectedPathPublishedForToken: () => published,
    chatAtlasClearSelectedPathAcquisition: () => { acquisitionClears += 1; },
    chatAtlasTraceTrustedLifecycle: (event, detail) => traces.push({ event, detail }),
    chatAtlasFailClosedPreExpansionReturn: () => { throw new Error('unexpected-pre-expansion-return'); },
    Date: FixtureDate, Math, String, Number, Object, Array,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  new vm.Script(
    extractFunction(ATLAS_CORE_SOURCE, 'chatAtlasCurrentTrustedNativeBranchSelection')
      + '\nglobalThis.__expire = chatAtlasCurrentTrustedNativeBranchSelection;',
    { filename: `${CORE0_PATH}:trusted-intent-expiry` },
  ).runInContext(sandbox);
  return {
    expire: sandbox.__expire,
    state: sandbox.completeTurnIndexAuthorityState,
    lease,
    traces,
    acquisitionClearCount: () => acquisitionClears,
  };
}

await fixture('lease-expiry A: live pending work retains its request lease and page-unit withdrawal', () => {
  const world = trustedIntentExpiryWorld({ ownsIntent: true, refetchOwned: true });
  equal(world.expire('q-branch')?.token, 'token-old', 'owned work keeps the intent authoritative beyond capture age');
  equal(world.lease.active(), true, 'live request lease remains active');
  equal(world.lease.clears.length, 0, 'live request lease is not cleared');
  const h = makeHarness({ turns: 26, effectiveCount: 26, transition: { selectedPathRequestLeaseActive: world.lease.active() } });
  h.mountUnits(2);
  const result = h.api.reconcileChatPageUnits('pending-request-lease');
  equal(result.status, 'branch-transition-withdrawn', 'pending lease still withholds page-unit settlement');
  equal(h.enforceCalls.length, 0, 'pending lease still blocks placement');
});

await fixture('lease-expiry B: matching stale lease clears and coherent page units can settle', () => {
  const world = trustedIntentExpiryWorld();
  equal(world.expire('q-branch'), null, 'expired intent retires');
  equal(world.lease.active(), false, 'matching stale request lease clears');
  equal(world.lease.clears.at(-1)?.reason, 'trusted-intent-expired', 'existing clear primitive receives the expiry reason');
  equal(world.acquisitionClearCount(), 1, 'unpublished acquisition follows its existing expiry cleanup');
  const h = makeHarness({ turns: 26, effectiveCount: 26, transition: { selectedPathRequestLeaseActive: world.lease.active() } });
  h.mountUnits(2);
  const result = h.api.reconcileChatPageUnits('expired-request-lease');
  equal(result.status === 'branch-transition-withdrawn', false, 'the transition gate can settle');
  equal(h.enforceCalls.at(-1)?.pageCount, 2, 'the coherent 26-turn route can rebuild two page units');
});

await fixture('lease-expiry C: expiry of an old intent cannot clear a newer request lease', () => {
  const world = trustedIntentExpiryWorld({ leaseToken: 'token-new' });
  equal(world.expire('q-branch'), null, 'old intent still expires');
  equal(world.lease.active(), true, 'newer request lease remains active');
  equal(world.lease.clears.length, 0, 'no clear primitive is called for a token mismatch');
});

await fixture('lease-expiry D: published overlay survives expiry without a stale matching lease', () => {
  const world = trustedIntentExpiryWorld({ published: true });
  equal(world.expire('q-branch'), null, 'published selection intent expires normally');
  equal(world.state.trustedSelectedPathIntent, null, 'published selection retires only the intent');
  equal(world.lease.active(), false, 'matching stale request lease no longer survives publication expiry');
  equal(world.acquisitionClearCount(), 0, 'published acquisition remains owned and untouched');
  equal(world.traces.at(-1)?.event, 'trusted-intent-expired', 'expiry lifecycle trace remains exact');
  equal(world.traces.at(-1)?.detail?.reason, 'age-window-exceeded', 'expiry reason remains exact');
});

// ── Production scheduling of trusted-intent expiry ───────────────────────
// The predicate fixtures above intentionally call the reader at t+6001. This
// world instead drives the real capture -> t+0 reconcile -> transaction path
// and then fires only timers that those production bodies actually schedule.
// Its coordinator seam models the live terminal shape: the trusted request was
// accepted (and therefore legitimately leased), publication work quiesced, but
// the matching lease remained. It never manufactures an expiry callback.
function productionSchedulingExpiryWorld(options = {}) {
  const startAt = 1000;
  let now = startAt;
  let nextTimerId = 1;
  const timers = new Map();
  const timerTrace = [];
  const scheduleTimer = (callback, delayRaw = 0) => {
    const delay = Math.max(0, Number(delayRaw || 0));
    const id = nextTimerId;
    nextTimerId += 1;
    timers.set(id, { id, callback, delay, dueAt: now + delay, cleared: false });
    timerTrace.push({ event: 'scheduled', id, at: now, delay, dueAt: now + delay });
    return id;
  };
  const clearTimer = (id) => {
    const timer = timers.get(id);
    if (!timer || timer.cleared) return;
    timer.cleared = true;
    timerTrace.push({ event: 'cleared', id, at: now, delay: timer.delay, dueAt: timer.dueAt });
  };
  const pendingTimers = () => Array.from(timers.values())
    .filter((timer) => !timer.cleared)
    .sort((a, b) => a.dueAt - b.dueAt || a.id - b.id);
  const runDue = () => {
    let ran = 0;
    while (true) {
      const timer = pendingTimers().find((candidate) => candidate.dueAt <= now);
      if (!timer) break;
      timer.cleared = true;
      timerTrace.push({ event: 'fired', id: timer.id, at: now, delay: timer.delay, dueAt: timer.dueAt });
      timer.callback();
      ran += 1;
    }
    return ran;
  };
  const advanceTo = (value) => { now = Math.max(now, Number(value || 0)); };

  class FixtureDate extends Date { static now() { return now; } }
  const qId = 'q-branch';
  const oldAnswerId = 'a-old';
  const route = { chatId: 'chat', routeKey: '/c/chat' };
  const state = {
    enabled: true,
    chatId: route.chatId,
    routeKey: route.routeKey,
    generation: 3,
    index: {
      sourceFingerprint: 'djb2:production-scheduling-baseline',
      turns: [{
        order: 26,
        qId,
        primaryAId: oldAnswerId,
        answerVariants: [oldAnswerId, 'a-new'],
      }],
    },
    nativeConvergenceActivating: false,
    nativeConvergenceState: null,
    trustedSelectionSequence: 0,
    trustedSelectionCaptureCount: 0,
    trustedSelectedPathIntent: null,
    trustedNativeReconcileTask: null,
    branchExpansionState: 'idle',
    branchExpansionLease: null,
    branchSelectionStale: false,
    branchSelectionStaleRevision: 0,
    branchSelectionStaleQId: '',
    branchSelectionStaleChatId: '',
    branchSelectionStaleRouteKey: '',
    branchSelectionStaleGeneration: 0,
    branchTransactionState: null,
    branchTransactionSeq: 0,
    branchTransactionTrace: [],
  };
  const lifecycleTrace = [];
  const coordinatorTrace = [];
  const notificationTrace = [];
  const coordinatorState = {
    selectedPathRequestLease: null,
    matchingWork: false,
  };
  const selectedPathAcquisitionState = {
    token: null,
    anchorQId: null,
    chatId: route.chatId,
    routeKey: route.routeKey,
    generation: 3,
    staleRevision: 0,
    refetchAttemptedForToken: null,
    refetchActiveForToken: null,
    graph: null,
  };

  const messageNode = (id, role) => ({
    getAttribute: (name) => (name === 'data-message-id'
      ? id
      : (name === 'data-message-author-role' ? role : null)),
  });
  const scope = {
    getAttribute: (name) => (name === 'data-testid' ? 'conversation-turn-26' : null),
    querySelectorAll: (selector) => selector === '[data-message-id]'
      ? [messageNode(qId, 'user'), messageNode(oldAnswerId, 'assistant')]
      : [],
  };
  const button = {
    tagName: 'BUTTON',
    getAttribute: (name) => (name === 'aria-label' ? 'Previous response' : null),
    closest: (selector) => selector === '[data-testid^="conversation-turn-"]' ? scope : null,
  };
  const event = {
    isTrusted: true,
    target: button,
    composedPath: () => [button],
    timeStamp: 77,
    type: 'click',
    detail: 1,
    button: 0,
    pointerId: 4,
  };

  const sandbox = {
    completeTurnIndexAuthorityState: state,
    selectedPathAcquisitionState,
    COMPLETE_TURN_INDEX_REFRESH_LIMITS: { trustedSelectionWindowMs: 5000 },
    CHAT_ATLAS_BRANCH_EXPANSION_MAX_MS: 12000,
    CHAT_ATLAS_BRANCH_TRANSACTION_CAP_MS: 90000,
    W: {
      setTimeout: scheduleTimer,
      clearTimeout: clearTimer,
      H2O_CHAT_PAGE_STRUCTURE_API: options.chatPageStructureApi || null,
    },
    setTimeout: scheduleTimer,
    clearTimeout: clearTimer,
    Date: FixtureDate,
    Math, String, Number, Object, Array, Set, Map, JSON, Promise,
    chatAtlasFullIndexRoute: () => route,
    getEffectivePresentationIndex: () => state.index,
    getEffectivePresentationStatus: () => ({ source: 'canonical', overlayActive: false }),
    chatAtlasCaptureBranchReturnCandidate: () => null,
    chatAtlasResetBranchExpansionLifecycle: () => {},
    chatAtlasClearSelectedPathOverlay: () => {},
    chatAtlasClearSelectedPathAcquisition: () => {},
    chatAtlasMarkManualBranchOverride: () => {},
    chatAtlasNotifyCompleteIndexState: () => {
      notificationTrace.push({
        at: now,
        intentActive: !!state.trustedSelectedPathIntent,
        leaseActive: !!coordinatorState.selectedPathRequestLease,
        transactionState: state.branchTransactionState?.state || null,
      });
      if (typeof options.onCompleteIndexState === 'function') options.onCompleteIndexState();
    },
    scheduleChatAtlasLedgerFlush: () => {},
    chatAtlasTraceTrustedLifecycle: (name, detail) => lifecycleTrace.push({ name, detail, at: now }),
    chatAtlasPreExpansionCanonicalReturnWindow: () => Object.freeze({ active: false }),
    chatAtlasFailClosedPreExpansionReturn: () => { throw new Error('unexpected-pre-expansion-return'); },
    chatAtlasSelectedPathPublishedForToken: () => false,
    chatAtlasTryPublishRetainedBranchTransaction: () => ({ handled: false, published: false }),
    getCompleteTurnIndexProjectionStatus: () => ({}),
  };

  const requestScopeFor = (evidence) => Object.freeze({
    requestIdentity: evidence.signature,
    token: evidence.selectionToken,
    chatId: route.chatId,
    routeKey: route.routeKey,
    generation: state.generation,
    staleRevision: state.branchSelectionStaleRevision,
    qId: evidence.qId,
  });
  const requestOwnsIntent = (intent) => {
    const lease = coordinatorState.selectedPathRequestLease;
    return coordinatorState.matchingWork === true
      && !!lease
      && lease.evidence.selectionToken === intent?.token
      && lease.scope.token === intent?.token
      && lease.scope.qId === intent?.qId;
  };
  const clearRequestLease = (reason) => {
    const lease = coordinatorState.selectedPathRequestLease;
    if (!lease) return;
    coordinatorTrace.push({ event: 'trusted-request-lease-cancelled', reason, token: lease.evidence.selectionToken, at: now });
    coordinatorState.selectedPathRequestLease = null;
  };
  sandbox.state = coordinatorState;
  sandbox.selectedPathRequestOwnsIntent = requestOwnsIntent;
  sandbox.clearSelectedPathRequestLease = clearRequestLease;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  new vm.Script(
    extractNestedFunction(ATLAS_CORE_SOURCE, 'clearExpiredSelectedPathRequestLeaseForIntent')
      + '\nglobalThis.__clearExpiredLease = clearExpiredSelectedPathRequestLeaseForIntent;',
    { filename: `${CORE0_PATH}:production-expiry-lease-helper` },
  ).runInContext(sandbox);

  const coordinator = {
    schedule: (cause, opts = {}) => {
      const evidence = Object.freeze({ ...opts.selectedPathEvidence });
      coordinatorState.matchingWork = true;
      coordinatorState.selectedPathRequestLease = Object.freeze({
        evidence,
        scope: requestScopeFor(evidence),
        routeKey: route.routeKey,
        generation: state.generation,
        acceptedAt: now,
      });
      coordinatorTrace.push({
        event: 'trusted-request-lease-created',
        cause,
        token: evidence.selectionToken,
        ownedAtAcceptance: requestOwnsIntent(state.trustedSelectedPathIntent),
        at: now,
      });
      // Model the published/quiescent live state. The request work is over;
      // only the lease object and still-pending branch transaction survive.
      coordinatorState.matchingWork = false;
      coordinatorTrace.push({ event: 'selected-path-work-quiescent', token: evidence.selectionToken, at: now });
      // Production's coordinator publishes state changes through its onState
      // adapter, which delegates to chatAtlasNotifyCompleteIndexState.
      if (options.coordinatorStateNotifications === true) {
        sandbox.chatAtlasNotifyCompleteIndexState();
      }
      return Promise.resolve({ selectedPathRequestLeaseActive: true });
    },
    selectedPathRequestOwnsIntent: requestOwnsIntent,
    clearExpiredSelectedPathRequestLeaseForIntent: sandbox.__clearExpiredLease,
    getStatus: () => ({
      selectedPathRequestLeaseActive: !!coordinatorState.selectedPathRequestLease,
      requestActive: coordinatorState.matchingWork,
      timerPending: pendingTimers().length > 0,
    }),
  };
  sandbox.completeIndexRefreshCoordinator = coordinator;
  sandbox.chatAtlasCompleteIndexSelectedPathEvidence = (cause) => {
    const intent = state.trustedSelectedPathIntent;
    return intent ? Object.freeze({
      signature: `trusted.${intent.token}`,
      cause,
      qId: intent.qId,
      observedAnswerId: '',
      trusted: true,
      selectionToken: intent.token,
      confirmationAttempt: false,
      baselineAnswerId: oldAnswerId,
      expectChange: true,
    }) : null;
  };

  const productionFunctions = [
    'chatAtlasCompleteIndexIdentity',
    'chatAtlasCompleteIndexStableHash',
    'chatAtlasCompleteIndexNativeBranchButton',
    'chatAtlasCompleteIndexNativeBranchDirection',
    'chatAtlasTrustedNativeBranchOwnership',
    'chatAtlasBranchTransactionTrace',
    'chatAtlasBranchTransactionCurrent',
    'chatAtlasOpenBranchTransaction',
    'chatAtlasCancelTrustedNativeBranchReconcile',
    'chatAtlasScheduleTrustedNativeBranchReconcile',
    'chatAtlasRunTrustedNativeBranchReconcile',
    'chatAtlasCurrentTrustedNativeBranchSelection',
    'chatAtlasScheduleCompleteIndexRefresh',
    'chatAtlasRecordTrustedNativeBranchSelection',
  ];
  new vm.Script(
    extractFunction(ATLAS_CORE_SOURCE, 'chatAtlasCompleteIndexCode')
      + '\n' + productionFunctions.map((name) => extractFunction(ATLAS_CORE_SOURCE, name)).join('\n')
      + `\nglobalThis.__productionSchedulingApi = {
          capture: chatAtlasRecordTrustedNativeBranchSelection,
          transactionCurrent: chatAtlasBranchTransactionCurrent,
        };`,
    { filename: `${CORE0_PATH}:production-expiry-scheduling` },
  ).runInContext(sandbox);

  return {
    capture: () => sandbox.__productionSchedulingApi.capture(event),
    transactionCurrent: () => sandbox.__productionSchedulingApi.transactionCurrent(),
    advanceTo,
    runDue,
    now: () => now,
    startAt,
    pendingTimers,
    timerTrace,
    lifecycleTrace,
    coordinatorTrace,
    notificationTrace,
    state,
    coordinator,
    coordinatorState,
    intentActive: () => !!state.trustedSelectedPathIntent,
    leaseActive: () => !!coordinatorState.selectedPathRequestLease,
  };
}

let productionSchedulingRedOutcome = null;
await fixture('lease-expiry E: production scheduling eventually retires a quiescent stale lease after transaction ownership ends', () => {
  const world = productionSchedulingExpiryWorld();

  const baseline = makeHarness({
    turns: 26,
    effectiveCount: 26,
    transition: { selectedPathRequestLeaseActive: world.leaseActive() },
  });
  baseline.mountUnits(2);
  const baselineResult = baseline.api.reconcileChatPageUnits('pre-selection-baseline');
  equal(baselineResult.status === 'branch-transition-withdrawn', false, 'baseline page units may settle');
  equal(world.intentActive(), false, 'baseline trusted intent is absent');
  equal(world.leaseActive(), false, 'baseline request lease is absent');

  equal(world.capture(), true, 'real trusted-native capture path accepts the native click');
  ok(world.state.trustedSelectedPathIntent?.token, 'capture creates a trusted intent');
  equal(world.state.branchTransactionState?.state, 'pending', 'capture opens a matching pending branch transaction');
  equal(world.pendingTimers().length, 1, 'capture schedules exactly one production callback');
  equal(world.pendingTimers()[0]?.delay, 0, 'the production callback is the immediate trusted-native reconcile');

  equal(world.runDue(), 1, 'only the production-scheduled t+0 callback runs');
  equal(world.intentActive(), true, 'the young transaction-owned intent remains active at t+0');
  equal(world.leaseActive(), true, 'the accepted trusted request creates a matching lease');
  equal(world.coordinatorTrace[0]?.ownedAtAcceptance, true, 'the request lease was legitimate when accepted');
  equal(world.coordinator.selectedPathRequestOwnsIntent(world.state.trustedSelectedPathIntent), false,
    'published/quiescent work no longer owns the retained lease');

  world.advanceTo(world.startAt + 5001);
  equal(world.runDue(), 0, 'no production callback is scheduled at the nominal intent deadline');
  equal(world.state.branchTransactionState?.state, 'pending', 'transaction ownership remains pending past 5000 ms');
  equal(world.intentActive(), true, 'cleanup correctly does not occur while the transaction still owns the intent');
  equal(world.leaseActive(), true, 'matching lease remains while transaction ownership is pending');

  world.advanceTo(world.startAt + 90001);
  const terminal = world.transactionCurrent();
  equal(terminal?.state, 'fail-closed', 'the production transaction reader applies the bounded cap');
  equal(terminal?.reason, 'transaction-cap', 'terminal ownership reason matches the live failure');
  world.advanceTo(world.startAt + 120000);
  equal(world.runDue(), 0, 'zero further production activity yields no expiry callback');
  equal(world.pendingTimers().length, 0, 'nothing is armed after transaction ownership becomes terminal');

  const transition = makeHarness({
    turns: 26,
    effectiveCount: 26,
    transition: { selectedPathRequestLeaseActive: world.leaseActive() },
  });
  transition.mountUnits(2);
  const transitionResult = transition.api.reconcileChatPageUnits('post-transaction-quiescence');
  productionSchedulingRedOutcome = {
    timerTrace: world.timerTrace.map((entry) => ({ ...entry })),
    transactionState: terminal?.state || null,
    transactionReason: terminal?.reason || null,
    intentActive: world.intentActive(),
    leaseActive: world.leaseActive(),
    pageUnitTransitionActive: transitionResult.status === 'branch-transition-withdrawn',
  };

  equal(world.intentActive(), false,
    'NO_PRODUCTION_EXPIRY_WAKEUP: terminal ownership must schedule eventual trusted-intent retirement');
  equal(world.leaseActive(), false,
    'NO_PRODUCTION_EXPIRY_WAKEUP: eventual expiry must clear the matching stale request lease');
  equal(transitionResult.status === 'branch-transition-withdrawn', false,
    'NO_PRODUCTION_EXPIRY_WAKEUP: page-unit settlement must become eligible without further activity');
});

let postLeaseReconcileRedOutcome = null;
await fixture('lease-expiry F: expiry-driven lease clear re-signals page-unit reconciliation without further activity', () => {
  let world = null;
  const pageReconcileTrace = [];
  const page = makeHarness({
    turns: 26,
    effectiveCount: 26,
    overlayActive: true,
    transitionStatus: () => ({
      trustedSelectionIntentActive: world?.intentActive() === true,
      branchSelectionStale: world?.state?.branchSelectionStale === true,
      branchTransactionPending: world?.state?.branchTransactionState?.state === 'pending',
      selectedPathRequestLeaseActive: world?.leaseActive() === true,
    }),
  });
  page.mountUnits(2);
  const initialPageState = page.api.getChatPageUnitState();
  initialPageState.last = Object.freeze({
    status: 'settled', count: 26, pageCount: 2, withdrawn: false,
  });
  page.document.documentElement.setAttribute('data-h2o-page-unit-ordering-status', 'settled');
  page.document.documentElement.setAttribute('data-h2o-page-unit-ordering-count', '2');

  // This is the page-structure consumer of a production Core state signal.
  // The fixture itself never invokes page reconciliation: capture, coordinator
  // onState, and any future expiry-clear signal are the only callers.
  const onProductionPageStateSignal = () => {
    const result = page.api.reconcileChatPageUnits('complete-index-state-event');
    pageReconcileTrace.push({
      status: result?.status || null,
      count: Number(page.document.documentElement.getAttribute('data-h2o-page-unit-ordering-count') || 0),
      dividerCount: page.dividers().length,
    });
    return result;
  };
  world = productionSchedulingExpiryWorld({
    coordinatorStateNotifications: true,
    onCompleteIndexState: onProductionPageStateSignal,
    chatPageStructureApi: {
      reconcilePageUnits: onProductionPageStateSignal,
      renderDividers: onProductionPageStateSignal,
    },
  });

  const initialModel = page.api.buildChatPageUnitModel();
  equal(initialModel.pageCount, 2, 'baseline 26-turn route canonically requires Page 2');
  equal(page.dividers().length, 2, 'baseline begins with two settled page dividers');
  equal(page.document.documentElement.getAttribute('data-h2o-page-unit-ordering-status'), 'settled',
    'baseline page-unit ordering is settled');

  equal(world.capture(), true, 'production trusted-native capture accepts the branch selection');
  equal(world.runDue(), 1, 'production t+0 trusted-native reconciliation runs');
  equal(world.intentActive(), true, 'trusted intent remains active during legitimate pending ownership');
  equal(world.leaseActive(), true, 'matching request lease is active during legitimate work');
  ok(pageReconcileTrace.some((entry) => entry.status === 'branch-transition-withdrawn'),
    'production state signaling withdraws page units during the live transition');
  equal(page.dividers().length, 0, 'transition withdrawal removes the in-chat Page 2 divider');

  world.advanceTo(world.startAt + 90001);
  const terminal = world.transactionCurrent();
  equal(terminal?.state, 'fail-closed', 'transaction ownership becomes terminal at its production cap');
  equal(terminal?.reason, 'transaction-cap', 'terminal ownership reason matches the live lifecycle');
  world.advanceTo(world.startAt + 120000);
  world.runDue();

  const branchTransitionActive = page.api.chatPageUnitBranchTransitionActive();
  const finalModel = page.api.buildChatPageUnitModel();
  const finalStatus = page.document.documentElement.getAttribute('data-h2o-page-unit-ordering-status');
  const finalCount = Number(page.document.documentElement.getAttribute('data-h2o-page-unit-ordering-count') || 0);
  const page2DividerEligible = branchTransitionActive === false && finalModel.pageCount >= 2;
  postLeaseReconcileRedOutcome = {
    expiryWakeupStillPassing: world.intentActive() === false && world.leaseActive() === false,
    leaseCleared: world.leaseActive() === false,
    branchTransitionActive,
    pageUnitStatus: finalStatus,
    pageUnitCount: finalCount,
    canonicalPage2: finalModel.pageCount >= 2,
    page2DividerEligible,
    page2DividerCount: page.divider(2) ? 1 : 0,
    notificationTrace: world.notificationTrace.map((entry) => ({ ...entry })),
    pageReconcileTrace: pageReconcileTrace.map((entry) => ({ ...entry })),
  };

  equal(world.intentActive(), false, 'production expiry wakeup still retires the stale trusted intent');
  equal(world.leaseActive(), false, 'production expiry wakeup still clears the matching stale lease');
  equal(branchTransitionActive, false, 'no branch-transition ownership remains after expiry cleanup');
  equal(finalModel.pageCount, 2, 'canonical Page 2 remains present after expiry cleanup');
  equal(page2DividerEligible, true, 'Page 2 is eligible to settle after transition ownership ends');
  equal(finalStatus, 'settled',
    'NO_POST_LEASE_CLEAR_PAGE_UNIT_RECONCILE: expiry-driven lease clear must re-run page-unit reconciliation');
  equal(finalCount, 2,
    'NO_POST_LEASE_CLEAR_PAGE_UNIT_RECONCILE: the coherent 26-turn route must restore two page units');
});

let temporaryStructuralModelRecoveryRedOutcome = null;
await fixture('page-structure recovery: a temporarily unavailable structural turn model re-arms public settlement', () => {
  const world = makeTemporaryStructuralModelRecoveryWorld();
  const { page } = world;

  page.mountUnits(2);
  const initialModel = page.api.buildChatPageUnitModel();
  const initialResult = page.api.reconcileChatPageUnits('temporary-model:baseline');
  const initialStatus = page.document.documentElement.getAttribute('data-h2o-page-unit-ordering-status');
  const initialCount = Number(page.document.documentElement.getAttribute('data-h2o-page-unit-ordering-count') || 0);
  equal(initialModel.count, 37, 'baseline structural model contains all 37 turns');
  equal(initialModel.pageCount, 2, 'baseline structural model canonically includes Page 2');
  equal(initialResult.status, 'settled', 'baseline page-unit ordering settles');
  equal(initialStatus, 'settled', 'baseline publishes settled ordering status');
  equal(initialCount, 2, 'baseline publishes two page units');
  equal(page.divider(2) ? 1 : 0, 1, 'baseline Page 2 divider is present exactly once');

  // Reproduce the live loss at the real structural seam only. Effective
  // authority remains truthful at 37 and every transition owner is inactive.
  page.setTurns(0);
  const unavailableModel = page.api.buildChatPageUnitModel();
  const unavailableCoherence = page.api.chatPageUnitPresentationCoherence(unavailableModel);
  const branchTransitionActive = page.api.chatPageUnitBranchTransitionActive();
  const leaseActive = page.api.getCompleteIndexProjectionStatus().selectedPathRequestLeaseActive === true;
  const unavailablePass = world.runPublicPageStructurePass('temporary-model:unavailable');
  world.flushImmediateTimers();

  // A repeated ordinary public pass must reuse one recovery authority rather
  // than accumulating another retry. No recovery callback is fired yet.
  world.runPublicPageStructurePass('temporary-model:unavailable-repeat');
  world.flushImmediateTimers();
  const recoveryTimers = world.pendingRecoveryTimers();
  const retryArmed = recoveryTimers.length > 0;
  const page2DividerSurvived = !!page.divider(2);

  // A partial non-empty structural model remains genuine incoherence. It must
  // continue to fail closed and must not be reclassified as unavailable.
  const genuine = makeHarness({ turns: 26, effectiveCount: 37, effectiveFp: FP_39, realStructuralModel: true });
  genuine.mountUnits(2);
  const genuineModel = genuine.api.buildChatPageUnitModel();
  const genuineCoherence = genuine.api.chatPageUnitPresentationCoherence(genuineModel);
  const genuineResult = genuine.api.reconcileChatPageUnits('temporary-model:genuine-incoherence');
  const genuineIncoherenceStillFailsClosed = genuineModel.count === 26
    && genuineCoherence.coherent === false
    && genuineResult.status === 'branch-transition-withdrawn'
    && Number(genuine.document.documentElement.getAttribute('data-h2o-page-unit-ordering-count') || 0) === 0;

  // Restore only mmHost().getTurnList(). Recovery must now come solely from a
  // callback production armed during the unavailable public pass.
  page.setTurns(37);
  const restoredModel = page.api.buildChatPageUnitModel();
  world.runProductionCallbacks();
  world.flushImmediateTimers();
  const finalModel = page.api.buildChatPageUnitModel();
  const finalStatus = page.document.documentElement.getAttribute('data-h2o-page-unit-ordering-status');
  const finalCount = Number(page.document.documentElement.getAttribute('data-h2o-page-unit-ordering-count') || 0);
  const finalPage2DividerCount = page.divider(2) ? 1 : 0;
  const retryDisarmed = world.pendingRecoveryTimers().length === 0;
  const recoveryOccurred = finalStatus === 'settled'
    && finalCount === 2
    && finalModel.pageCount === 2
    && finalPage2DividerCount === 1
    && retryDisarmed;

  temporaryStructuralModelRecoveryRedOutcome = {
    initialPageUnitStatus: initialStatus,
    initialPageUnitCount: initialCount,
    unavailableModelCount: unavailableModel.count,
    authorityCount: unavailableCoherence.authorityCount,
    branchTransitionActive,
    leaseActive,
    unavailableStatus: unavailablePass.reconciliation?.status || null,
    retryArmed,
    retryCount: recoveryTimers.length,
    page2DividerSurvived,
    restoredModelCount: restoredModel.count,
    recoveryOccurred,
    genuineIncoherenceStillFailsClosed,
    finalPageUnitStatus: finalStatus,
    finalPageUnitCount: finalCount,
    finalPage2DividerCount,
    retryDisarmed,
    timerTrace: world.timerTrace.map((entry) => ({ ...entry })),
  };

  equal(unavailableModel.count, 0, 'temporary structural model is empty at the live failure seam');
  equal(unavailableCoherence.authorityCount, 37, 'effective authority remains truthful at 37 turns');
  equal(unavailableCoherence.coherent, false, 'empty structural model cannot be published as coherent');
  equal(branchTransitionActive, false, 'no selected-path branch transition owns the unavailable window');
  equal(leaseActive, false, 'no selected-path request lease owns the unavailable window');
  equal(unavailablePass.reconciliation?.status, 'branch-transition-withdrawn', 'current fail-closed withdrawal is observable');
  equal(genuineIncoherenceStillFailsClosed, true, 'genuine non-empty model mismatch remains fail-closed');
  equal(restoredModel.count, 37, 'structural model becomes available again without a DOM mutation');
  equal(retryArmed, true,
    'NO_PAGE_STRUCTURE_RETRY_WHEN_MODEL_UNAVAILABLE: empty structural model with live authority must arm recovery');
  equal(recoveryTimers.length, 1,
    'temporary model loss must use one coalesced recovery authority without duplicate retries');
  equal(page2DividerSurvived, true,
    'DIVIDER_DESTRUCTIVELY_REMOVED_DURING_MODEL_UNAVAILABLE: settled Page 2 must survive the retryable window');
  equal(recoveryOccurred, true,
    'NO_PAGE_STRUCTURE_RETRY_WHEN_MODEL_UNAVAILABLE: production retry must restore settled Page 2 after model return');
  equal(retryDisarmed, true, 'successful settlement cancels the bounded recovery task');
});

let dividerScrollRepairRedOutcome = null;
await fixture('divider scroll repair: unchanged settled inputs do not repeat the full public repair path', () => {
  const unchanged = makeDividerScrollRepairWorld();
  const initialIdentity = unchanged.page.api.buildChatPageUnitModel().identity;
  const initialDividers = unchanged.page.dividers().length;
  unchanged.notify(400);
  unchanged.notify(400);
  unchanged.notify(400);
  unchanged.flush();
  const unchangedCounts = { ...unchanged.counters };
  const unchangedFinalIdentity = unchanged.page.api.buildChatPageUnitModel().identity;
  const unchangedFinalDividers = unchanged.page.dividers().length;

  const pageUnitChange = makeDividerScrollRepairWorld();
  pageUnitChange.notify(400);
  pageUnitChange.flush();
  pageUnitChange.resetCounts();
  pageUnitChange.page.setEffectiveFingerprint('djb2:changed-page-unit-identity');
  pageUnitChange.notify(400);
  pageUnitChange.flush();
  const pageUnitChangeControl = pageUnitChange.counters.fullRender > 0;

  const anchorChange = makeDividerScrollRepairWorld();
  anchorChange.notify(400);
  anchorChange.flush();
  anchorChange.resetCounts();
  anchorChange.replaceAnchor();
  anchorChange.notify(400);
  anchorChange.flush();
  const anchorChangeControl = anchorChange.counters.fullRender > 0;

  const branchSettlement = makeDividerScrollRepairWorld();
  branchSettlement.notify(400);
  branchSettlement.flush();
  branchSettlement.page.transition.selectedPathRequestLeaseActive = true;
  branchSettlement.page.api.reconcileChatPageUnits('divider-scroll:transition-active');
  branchSettlement.resetCounts();
  branchSettlement.page.transition.selectedPathRequestLeaseActive = false;
  branchSettlement.notify(400);
  branchSettlement.flush();
  const branchSettlementControl = branchSettlement.counters.fullRender > 0
    && branchSettlement.page.api.chatPageUnitBranchTransitionActive() === false;

  const modelRecovery = makeDividerScrollRepairWorld();
  modelRecovery.notify(400);
  modelRecovery.flush();
  modelRecovery.page.setTurns(0);
  modelRecovery.world.runPublicPageStructurePass('divider-scroll:model-unavailable');
  modelRecovery.world.flushImmediateTimers();
  modelRecovery.resetCounts();
  modelRecovery.page.setTurns(37);
  modelRecovery.notify(400);
  modelRecovery.flush();
  const modelRecoveryControl = modelRecovery.counters.fullRender > 0
    && modelRecovery.page.api.buildChatPageUnitModel().count === 37;

  const pageCountChange = makeDividerScrollRepairWorld();
  pageCountChange.notify(400);
  pageCountChange.flush();
  pageCountChange.resetCounts();
  pageCountChange.page.setTurns(51);
  pageCountChange.page.setEffectiveCount(51);
  pageCountChange.page.setEffectiveFingerprint('djb2:page-count-3');
  pageCountChange.notify(400);
  pageCountChange.flush();
  const pageCountChangeControl = pageCountChange.counters.fullRender > 0
    && pageCountChange.page.api.buildChatPageUnitModel().pageCount === 3;

  const missingDivider = makeDividerScrollRepairWorld();
  missingDivider.notify(400);
  missingDivider.flush();
  missingDivider.resetCounts();
  missingDivider.page.divider(2)?.remove();
  const missingBefore = missingDivider.page.divider(2) == null;
  missingDivider.notify(400);
  missingDivider.flush();
  const missingDividerControl = missingBefore
    && missingDivider.counters.fullRender > 0
    && !!missingDivider.page.divider(2);

  dividerScrollRepairRedOutcome = {
    repairEntryPath: 'bindDividerScrollRepairOnce -> onDividerRepairScroll -> runDividerRepair -> renderChatPageDividers -> reconcileChatPageUnits',
    scrollNotifications: unchangedCounts.notifications,
    runDividerRepairCount: unchangedCounts.runDividerRepair,
    fullRenderCount: unchangedCounts.fullRender,
    pageUnitReconcileCount: unchangedCounts.reconcile,
    initialIdentity,
    finalIdentity: unchangedFinalIdentity,
    initialDividers,
    finalDividers: unchangedFinalDividers,
    unchangedStateRepeatsRepair: unchangedCounts.fullRender > 1,
    pageUnitChangeControl,
    anchorChangeControl,
    branchSettlementControl,
    modelRecoveryControl,
    pageCountChangeControl,
    missingDividerControl,
  };

  equal(initialIdentity, unchangedFinalIdentity, 'equivalent scroll notifications retain exact page-unit identity');
  equal(initialDividers, 2, 'stable baseline starts with exactly two dividers');
  equal(unchangedFinalDividers, 2, 'equivalent notifications preserve exactly two correct dividers');
  equal(pageUnitChangeControl, true, 'page-unit identity change still executes repair');
  equal(anchorChangeControl, true, 'divider anchor/host replacement still executes repair');
  equal(branchSettlementControl, true, 'branch-transition settlement still executes repair');
  equal(modelRecoveryControl, true, 'model-unavailable recovery still executes repair');
  equal(pageCountChangeControl, true, 'valid page-count change still executes repair');
  equal(missingDividerControl, true, 'missing required divider still executes repair and restores it');
  equal(unchangedCounts.fullRender, 1,
    'UNCHANGED_DIVIDER_STATE_MUST_NOT_REPEAT_FULL_SCROLL_REPAIR: equivalent scroll notifications must coalesce to one full repair');
});


// ── Stage 2C — selectedPathFail transaction-lifecycle guard ───────────────
// The real chatAtlasSelectedPathFail body is executed against a sandbox that
// models only what the guard reads, so the assertions are behavioural.
function failWorld({ txState, txToken, acqToken = 't1' }) {
  const acquisition = {
    token: acqToken, status: 'proven', reason: 'selected-path-proven',
    path: [1, 2, 3], proof: { ok: true }, anchorQId: 'q', anchorSelectedAId: 'a',
    provenAt: 'ts', evaluatedLedgerVersion: 0,
    lastPublicationDecision: null, graph: null,
  };
  const sandbox = {
    completeTurnIndexAuthorityState: {
      branchTransactionState: txState ? { state: txState, token: txToken } : null,
      chatId: 'c', routeKey: '/c/c', generation: 1,
    },
    selectedPathAcquisitionState: acquisition,
    chatAtlasLedgerState: { version: 7 },
    chatAtlasBranchTransactionTrace: () => {},
    chatAtlasCompleteIndexCode: (v, f) => String(v || f || ''),
    chatAtlasCompleteIndexIdentity: (v) => String(v || '').trim(),
    getSelectedPathAcquisitionStatus: () => ({
      status: acquisition.status, reason: acquisition.reason,
      pathLength: Array.isArray(acquisition.path) ? acquisition.path.length : 0,
    }),
    chatAtlasSelectedPathPublishedForToken: () => false,
    chatAtlasAcquisitionPublicationOwned: () => false,
    String, Number, Object, Array,
  };
  sandbox.globalThis = sandbox;
  // chatAtlasSelectedPathFail is 0A3a-owned and reads the Ledger version through
  // 0A3a's own service registry, so the whole resolution path is extracted from
  // 0A3a and given the registry's backing store. No Ledger is registered here,
  // which the registry reports as version 0 — exactly the state this fixture
  // previously produced with an empty Ledger.
  sandbox.services = Object.create(null);
  vm.createContext(sandbox);
  new vm.Script(
    extractFunction(ATLAS_CORE_SOURCE, 'chatAtlasSelectedPathFail')
    + '\n' + extractFunction(ATLAS_CORE_SOURCE, 'getService')
    + '\n' + ['LEDGER_SERVICE', 'ledger', 'getLedgerVersion', 'chatAtlasCoreLedgerVersion']
      .map((n) => extractBinding(ATLAS_CORE_SOURCE, n)).join('\n')
    + '\nglobalThis.__fail = chatAtlasSelectedPathFail;',
  ).runInContext(sandbox);
  return { fail: sandbox.__fail, acquisition };
}

await fixture('stage-2c F: a pending transaction blocks only the post-switch artefact', () => {
  const w = failWorld({ txState: 'pending', txToken: 't1' });
  const out = w.fail('selected-answer-not-changed', { token: 't1', qId: 'q' }, 'a');
  equal(w.acquisition.status, 'proven', 'selected-answer-not-changed leaves status untouched');
  equal(w.acquisition.path.length, 3, 'and leaves path intact');
  ok(w.acquisition.proof, 'and leaves proof intact');
  equal(out.status, 'proven', 'the caller sees the unchanged record');

  // CV-3.8 containment: genuine derivation failures must still be recorded
  // while the transaction is pending, or a 20/21 hybrid could settle.
  for (const reason of ['anchor-not-in-graph', 'fork-unresolved',
    'descent-variant-ambiguous', 'proof-ownership-invalid']) {
    const g = failWorld({ txState: 'pending', txToken: 't1' });
    g.fail(reason, { token: 't1', qId: 'q' }, 'a');
    equal(g.acquisition.status, 'failed', `${reason} is still recorded while pending`);
    equal(g.acquisition.path, null, `${reason} still clears path`);
  }

  // A published transaction alone is NOT evidence — ownership decides.
  const pub = failWorld({ txState: 'published', txToken: 't1' });
  pub.fail('selected-answer-not-changed', { token: 't1', qId: 'q' }, 'a');
  equal(pub.acquisition.status, 'failed',
    'published alone does not suppress; publication ownership does');
});

await fixture('stage-2c G: a legitimate failure is never suppressed', () => {
  const cases = [
    ['fail-closed transaction', { txState: 'fail-closed', txToken: 't1' }],
    ['wrong-token transaction', { txState: 'pending', txToken: 'other' }],
    ['no transaction at all', { txState: null, txToken: '' }],
  ];
  for (const [label, opts] of cases) {
    const w = failWorld(opts);
    w.fail('selected-answer-not-changed', { token: 't1', qId: 'q' }, 'a');
    equal(w.acquisition.status, 'failed', `${label}: the failure still lands`);
    equal(w.acquisition.path, null, `${label}: path is cleared as before`);
    equal(w.acquisition.proof, null, `${label}: proof is cleared as before`);
  }
});

await fixture('stage-2c H: the guard asserts nothing about success', () => {
  const body = extractFunction(CORE0_SOURCE, 'chatAtlasSelectedPathFail');
  const at = body.indexOf("transaction.state === 'pending'");
  ok(at >= 0, 'the transaction-lifecycle guard exists');
  const before = body.slice(0, body.indexOf('return getSelectedPathAcquisitionStatus();', at));
  const code = before.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  for (const forbidden of ["status = 'proven'", 'lastPublicationDecision =',
    'setTimeout(', 'schedule(', 'Schedule(']) {
    ok(!code.includes(forbidden), `the guard never uses ${forbidden}`);
  }
  ok(body.indexOf("status = 'failed'") > at, 'the guard precedes every mutation');
});

const failed = fixtures.filter((f) => !f.ok);
if (dividerScrollRepairRedOutcome) {
  console.log(`CV-3.31 divider-scroll-repair ${JSON.stringify(dividerScrollRepairRedOutcome)}`);
}
console.log(`CV-3.31 fixtures ${fixtures.length - failed.length}/${fixtures.length} assertions ${assertions}`);
if (failed.length) {
  for (const f of failed) console.error(`${f.name}: ${f.error?.message || f.error}`);
  process.exitCode = 1;
}
