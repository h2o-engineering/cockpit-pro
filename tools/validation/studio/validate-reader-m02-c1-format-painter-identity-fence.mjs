#!/usr/bin/env node
// Reader M02 C1 — Format Painter chat/snapshot identity fence (focused validator).
//
// Defect (HDA C1, Mission establish-reader-resume-and-position-continuity):
// the MESSAGE-mode Format Painter armed state carried no chat/snapshot identity,
// and the Ribbon's contextChanged subscriber compared only selectedTurnIdx before
// calling bridge.applyMessageFormatPaint(...). An automatic Reader selection /
// Ribbon publication that moves the live context to another chat or snapshot
// could therefore retarget a stale armed painter and persist formatting into the
// wrong target. The correction (semantic A — disarm on identity change) binds the
// armed record to the shell context identity (chatId + snapshotId) it was armed
// under and disarms it BEFORE the turn comparison whenever the live identity
// differs. Inline Format Painter is not part of the defect and is unchanged.
//
// This validator executes the REAL ribbon shell (ribbon-shell.studio.js) and the
// REAL Ribbon surface (S0Y1a) inside node:vm over a minimal hand-rolled DOM, arms
// the painter through the real click path, publishes contexts exactly the way
// studio.js does (renderRoute tail → selection publication), and records every
// applyMessageFormatPaint call together with the live identity at call time.
// It also runs a mutation control (fence disabled) and, when the pinned baseline
// Ribbon blob is reachable through git, the genuine pre-C1 source, to prove the
// harness detects the defect rather than passing vacuously.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), '..', '..', '..');

const FILES = {
  shell: 'src-surfaces-base/studio/ribbon/ribbon-shell.studio.js',
  ribbon: 'src-surfaces-base/studio/S0Y1a. 🎬 Studio Ribbon - Studio.js',
};
/* Ribbon blob at Product main f57d7306 (pre-C1) — used only for the optional
 * genuine-baseline negative control. */
const BASELINE_RIBBON_BLOB = '77e96f37fd9934c9a67aa3b7a6b81edb3d6b4e2d';

const read = (rel) => fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
const SHELL_SRC = read(FILES.shell);
const RIBBON_SRC = read(FILES.ribbon);
const SHELL_SCRIPT = new vm.Script(SHELL_SRC, { filename: FILES.shell });
const RIBBON_SCRIPT = new vm.Script(RIBBON_SRC, { filename: FILES.ribbon });

const PASS = [];
const FAIL = [];
const SKIP = [];
/* vm-realm objects are not reference-equal to host prototypes; normalise before deepEqual. */
const plain = (v) => JSON.parse(JSON.stringify(v));

function check(label, fn) {
  try {
    fn();
    PASS.push(label);
    console.log(`  PASS ${label}`);
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    FAIL.push({ label, message });
    console.log(`  FAIL ${label}`);
    console.log(`       ${message}`);
  }
}

async function checkAsync(label, fn) {
  try {
    await fn();
    PASS.push(label);
    console.log(`  PASS ${label}`);
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    FAIL.push({ label, message });
    console.log(`  FAIL ${label}`);
    console.log(`       ${message}`);
  }
}

/* ── Minimal DOM (subset sufficient for the Ribbon surface) ──────────────── */

const selectorCache = new Map();

function parseCompound(str) {
  const c = { tag: null, id: null, classes: [], attrs: [], nots: [] };
  const s = str.trim();
  let i = 0;
  while (i < s.length) {
    const rest = s.slice(i);
    let m;
    if (i === 0 && (m = /^(\*|[a-zA-Z][\w-]*)/.exec(rest))) {
      c.tag = m[1] === '*' ? null : m[1].toLowerCase();
      i += m[0].length;
      continue;
    }
    if ((m = /^#([\w-]+)/.exec(rest))) { c.id = m[1]; i += m[0].length; continue; }
    if ((m = /^\.([\w-]+)/.exec(rest))) { c.classes.push(m[1]); i += m[0].length; continue; }
    if ((m = /^\[\s*([\w-]+)\s*(?:(=)\s*(?:"([^"]*)"|'([^']*)'|([^\]\s]+)))?\s*\]/.exec(rest))) {
      const value = m[2] ? (m[3] !== undefined ? m[3] : (m[4] !== undefined ? m[4] : m[5])) : null;
      c.attrs.push({ name: m[1].toLowerCase(), value });
      i += m[0].length;
      continue;
    }
    if (rest.startsWith(':not(')) {
      let depth = 0;
      let j = i + 4;
      for (; j < s.length; j += 1) {
        if (s[j] === '(') depth += 1;
        else if (s[j] === ')') { depth -= 1; if (depth === 0) break; }
      }
      c.nots.push(parseCompound(s.slice(i + 5, j)));
      i = j + 1;
      continue;
    }
    throw new Error('mini-dom: unsupported selector fragment: ' + rest);
  }
  return c;
}

function parseComplex(sel) {
  const parts = [];
  let depth = 0;
  let quote = null;
  let cur = '';
  let pendingComb = null;
  const flush = () => {
    if (cur.trim()) {
      parts.push({ compound: parseCompound(cur), combinator: pendingComb });
      cur = '';
      pendingComb = null;
    }
  };
  for (const ch of sel) {
    if (quote) { cur += ch; if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
    if (ch === '[' || ch === '(') depth += 1;
    else if (ch === ']' || ch === ')') depth -= 1;
    if (depth === 0 && (ch === ' ' || ch === '>')) {
      if (cur.trim()) { flush(); pendingComb = ch === '>' ? '>' : ' '; }
      else if (ch === '>') pendingComb = '>';
      continue;
    }
    cur += ch;
  }
  flush();
  return parts;
}

function parseSelectorList(sel) {
  const key = String(sel);
  if (selectorCache.has(key)) return selectorCache.get(key);
  const list = [];
  let depth = 0;
  let quote = null;
  let cur = '';
  for (const ch of key) {
    if (quote) { cur += ch; if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
    if (ch === '[' || ch === '(') depth += 1;
    else if (ch === ']' || ch === ')') depth -= 1;
    if (depth === 0 && ch === ',') { list.push(parseComplex(cur)); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) list.push(parseComplex(cur));
  selectorCache.set(key, list);
  return list;
}

function matchesCompound(el, c) {
  if (!el || el.nodeType !== 1) return false;
  if (c.tag && el.localName !== c.tag) return false;
  if (c.id && el.getAttribute('id') !== c.id) return false;
  for (const cls of c.classes) if (!el.classList.contains(cls)) return false;
  for (const a of c.attrs) {
    if (!el.hasAttribute(a.name)) return false;
    if (a.value !== null && el.getAttribute(a.name) !== a.value) return false;
  }
  for (const n of c.nots) if (matchesCompound(el, n)) return false;
  return true;
}

function matchesComplex(el, parts) {
  const matchAt = (node, idx) => {
    if (!matchesCompound(node, parts[idx].compound)) return false;
    if (idx === 0) return true;
    if (parts[idx].combinator === '>') {
      const p = node.parentElement;
      return !!p && matchAt(p, idx - 1);
    }
    let a = node.parentElement;
    while (a) { if (matchAt(a, idx - 1)) return true; a = a.parentElement; }
    return false;
  };
  return matchAt(el, parts.length - 1);
}

function elementMatches(el, sel) {
  return parseSelectorList(sel).some((parts) => matchesComplex(el, parts));
}

class MiniEvent {
  constructor(type, init = {}) {
    this.type = String(type);
    this.bubbles = !!init.bubbles;
    this.cancelable = !!init.cancelable;
    this.detail = init.detail;
    this.defaultPrevented = false;
    this.target = null;
    this.currentTarget = null;
    this._stopped = false;
    this._stoppedImmediate = false;
    if (init.props) Object.assign(this, init.props);
  }
  preventDefault() { if (this.cancelable) this.defaultPrevented = true; }
  stopPropagation() { this._stopped = true; }
  stopImmediatePropagation() { this._stopped = true; this._stoppedImmediate = true; }
}

class MiniClassList {
  constructor(el) { this.el = el; }
  _list() { return (this.el.getAttribute('class') || '').split(/\s+/).filter(Boolean); }
  _write(list) { if (list.length) this.el.setAttribute('class', list.join(' ')); else this.el.removeAttribute('class'); }
  add(...names) { const l = this._list(); for (const n of names) if (!l.includes(n)) l.push(n); this._write(l); }
  remove(...names) { this._write(this._list().filter((n) => !names.includes(n))); }
  contains(n) { return this._list().includes(n); }
  toggle(n, force) {
    const has = this.contains(n);
    const want = force === undefined ? !has : !!force;
    if (want && !has) this.add(n); else if (!want && has) this.remove(n);
    return want;
  }
}

function makeDataset(el) {
  const toAttr = (k) => 'data-' + String(k).replace(/[A-Z]/g, (m) => '-' + m.toLowerCase());
  const toKey = (a) => a.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
  return new Proxy({}, {
    get(_, k) {
      if (typeof k !== 'string') return undefined;
      const v = el.getAttribute(toAttr(k));
      return v === null ? undefined : v;
    },
    set(_, k, v) { el.setAttribute(toAttr(k), String(v)); return true; },
    has(_, k) { return typeof k === 'string' && el.hasAttribute(toAttr(k)); },
    deleteProperty(_, k) { el.removeAttribute(toAttr(k)); return true; },
    ownKeys() { return [...el._attrs.keys()].filter((a) => a.startsWith('data-')).map(toKey); },
    getOwnPropertyDescriptor(_, k) {
      const v = el.getAttribute(toAttr(k));
      return v === null ? undefined : { value: v, enumerable: true, configurable: true, writable: true };
    },
  });
}

function makeStyle() {
  const m = new Map();
  return {
    setProperty(k, v) { m.set(String(k), String(v)); },
    removeProperty(k) { m.delete(String(k)); },
    getPropertyValue(k) { return m.get(String(k)) || ''; },
  };
}

class MiniNode {
  constructor(doc, nodeType) {
    this.ownerDocument = doc;
    this.nodeType = nodeType;
    this.parentNode = null;
    this.childNodes = [];
    this._listeners = new Map();
  }
  get parentElement() { return this.parentNode && this.parentNode.nodeType === 1 ? this.parentNode : null; }
  get firstChild() { return this.childNodes[0] || null; }
  get lastChild() { return this.childNodes[this.childNodes.length - 1] || null; }
  get nextSibling() {
    if (!this.parentNode) return null;
    const s = this.parentNode.childNodes;
    return s[s.indexOf(this) + 1] || null;
  }
  get previousSibling() {
    if (!this.parentNode) return null;
    const s = this.parentNode.childNodes;
    const i = s.indexOf(this);
    return i > 0 ? s[i - 1] : null;
  }
  get children() { return this.childNodes.filter((n) => n.nodeType === 1); }
  get firstElementChild() { return this.children[0] || null; }
  _toNodes(items) {
    const out = [];
    for (const it of items) {
      if (it && it.nodeType === 11) out.push(...it.childNodes.slice());
      else if (it && typeof it.nodeType === 'number') out.push(it);
      else out.push(new MiniText(this.ownerDocument, String(it)));
    }
    return out;
  }
  appendChild(node) {
    for (const n of this._toNodes([node])) {
      if (n.parentNode) n.parentNode.removeChild(n);
      n.parentNode = this;
      this.childNodes.push(n);
    }
    return node;
  }
  insertBefore(node, ref) {
    if (!ref) return this.appendChild(node);
    for (const n of this._toNodes([node])) {
      if (n.parentNode) n.parentNode.removeChild(n);
      const i = this.childNodes.indexOf(ref);
      if (i < 0) throw new Error('mini-dom: insertBefore reference not a child');
      n.parentNode = this;
      this.childNodes.splice(i, 0, n);
    }
    return node;
  }
  removeChild(node) {
    const i = this.childNodes.indexOf(node);
    if (i < 0) throw new Error('mini-dom: removeChild not a child');
    this.childNodes.splice(i, 1);
    node.parentNode = null;
    return node;
  }
  replaceChild(newNode, oldNode) {
    const i = this.childNodes.indexOf(oldNode);
    if (i < 0) throw new Error('mini-dom: replaceChild not a child');
    this.insertBefore(newNode, oldNode);
    return this.removeChild(oldNode);
  }
  append(...items) { for (const n of this._toNodes(items)) this.appendChild(n); }
  prepend(...items) { const first = this.firstChild; for (const n of this._toNodes(items)) this.insertBefore(n, first); }
  replaceChildren(...items) { for (const c of this.childNodes.slice()) this.removeChild(c); this.append(...items); }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  contains(node) { let n = node; while (n) { if (n === this) return true; n = n.parentNode; } return false; }
  get textContent() { return this.childNodes.map((c) => c.textContent).join(''); }
  set textContent(v) {
    this.replaceChildren();
    if (v !== null && v !== undefined && String(v) !== '') this.appendChild(new MiniText(this.ownerDocument, String(v)));
  }
  addEventListener(type, fn, opts) {
    if (typeof fn !== 'function') return;
    const capture = opts === true || !!(opts && opts.capture);
    const once = !!(opts && opts.once);
    const list = this._listeners.get(type) || [];
    if (list.some((l) => l.fn === fn && l.capture === capture)) return;
    list.push({ fn, capture, once });
    this._listeners.set(type, list);
  }
  removeEventListener(type, fn, opts) {
    const capture = opts === true || !!(opts && opts.capture);
    const list = this._listeners.get(type);
    if (!list) return;
    this._listeners.set(type, list.filter((l) => !(l.fn === fn && l.capture === capture)));
  }
  _invoke(ev, phaseCapture) {
    const list = (this._listeners.get(ev.type) || []).slice();
    for (const l of list) {
      if (l.capture !== phaseCapture) continue;
      if (ev._stoppedImmediate) return;
      ev.currentTarget = this;
      if (l.once) this.removeEventListener(ev.type, l.fn, l.capture);
      l.fn.call(this, ev);
    }
  }
  dispatchEvent(ev) {
    ev.target = ev.target || this;
    const pathNodes = [];
    let n = this;
    while (n) { pathNodes.push(n); n = n.parentNode; }
    for (let i = pathNodes.length - 1; i >= 0; i -= 1) {
      if (ev._stopped) break;
      pathNodes[i]._invoke(ev, true);
    }
    for (let i = 0; i < pathNodes.length; i += 1) {
      if (ev._stopped) break;
      if (i > 0 && !ev.bubbles) break;
      pathNodes[i]._invoke(ev, false);
    }
    ev.currentTarget = null;
    return !ev.defaultPrevented;
  }
}

class MiniText extends MiniNode {
  constructor(doc, data) { super(doc, 3); this.data = String(data); }
  get textContent() { return this.data; }
  set textContent(v) { this.data = String(v); }
}

class MiniElement extends MiniNode {
  constructor(doc, tag) {
    super(doc, 1);
    this.localName = String(tag).toLowerCase();
    this.tagName = this.localName.toUpperCase();
    this._attrs = new Map();
    this._html = '';
    this._value = '';
    this.style = makeStyle();
    this.classList = new MiniClassList(this);
    this.dataset = makeDataset(this);
  }
  setAttribute(k, v) { this._attrs.set(String(k).toLowerCase(), String(v)); }
  getAttribute(k) { const v = this._attrs.get(String(k).toLowerCase()); return v === undefined ? null : v; }
  hasAttribute(k) { return this._attrs.has(String(k).toLowerCase()); }
  removeAttribute(k) { this._attrs.delete(String(k).toLowerCase()); }
  get id() { return this.getAttribute('id') || ''; }
  set id(v) { this.setAttribute('id', v); }
  get className() { return this.getAttribute('class') || ''; }
  set className(v) { this.setAttribute('class', v); }
  get title() { return this.getAttribute('title') || ''; }
  set title(v) { this.setAttribute('title', v); }
  get hidden() { return this.hasAttribute('hidden'); }
  set hidden(v) { if (v) this.setAttribute('hidden', ''); else this.removeAttribute('hidden'); }
  get disabled() { return this.hasAttribute('disabled'); }
  set disabled(v) { if (v) this.setAttribute('disabled', ''); else this.removeAttribute('disabled'); }
  get tabIndex() { return Number(this.getAttribute('tabindex') || -1); }
  set tabIndex(v) { this.setAttribute('tabindex', String(v)); }
  get value() { return this._value; }
  set value(v) { this._value = String(v); }
  get innerHTML() { return this._html; }
  set innerHTML(v) { this.replaceChildren(); this._html = String(v); }
  get innerText() { return this.textContent; }
  set innerText(v) { this.textContent = v; }
  get offsetWidth() { return 0; }
  get offsetHeight() { return 0; }
  get clientWidth() { return 0; }
  get clientHeight() { return 0; }
  getBoundingClientRect() { return { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }; }
  focus() { this.ownerDocument.activeElement = this; }
  blur() { if (this.ownerDocument.activeElement === this) this.ownerDocument.activeElement = this.ownerDocument.body; }
  click() { this.dispatchEvent(new MiniEvent('click', { bubbles: true, cancelable: true })); }
  matches(sel) { return elementMatches(this, sel); }
  closest(sel) { let n = this; while (n && n.nodeType === 1) { if (elementMatches(n, sel)) return n; n = n.parentElement; } return null; }
  _descendants(out) { for (const c of this.childNodes) { if (c.nodeType === 1) { out.push(c); c._descendants(out); } } return out; }
  querySelectorAll(sel) { return this._descendants([]).filter((e) => elementMatches(e, sel)); }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
}

class MiniDocument extends MiniNode {
  constructor() {
    super(null, 9);
    this.ownerDocument = this;
    this.readyState = 'complete';
    this.documentElement = new MiniElement(this, 'html');
    this.head = new MiniElement(this, 'head');
    this.body = new MiniElement(this, 'body');
    this.documentElement.appendChild(this.head);
    this.documentElement.appendChild(this.body);
    this.appendChild(this.documentElement);
    this.activeElement = this.body;
  }
  createElement(tag) { return new MiniElement(this, tag); }
  createElementNS(_ns, tag) { return new MiniElement(this, tag); }
  createTextNode(t) { return new MiniText(this, t); }
  createDocumentFragment() { const f = new MiniNode(this, 11); return f; }
  getElementById(id) { return this.documentElement._descendants([this.documentElement]).find((e) => e.getAttribute('id') === String(id)) || null; }
  querySelectorAll(sel) { return this.documentElement._descendants([this.documentElement]).filter((e) => elementMatches(e, sel)); }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
}

/* ── Harness: real shell + real Ribbon in a vm context ──────────────────── */

function unrefTimeout(fn, ms, ...args) {
  const t = setTimeout(fn, ms, ...args);
  if (t && typeof t.unref === 'function') t.unref();
  return t;
}

async function createHarness(opts = {}) {
  const ribbonScript = opts.ribbonScript || RIBBON_SCRIPT;
  const doc = new MiniDocument();
  const container = doc.createElement('section');
  container.id = 'studioRibbon';
  doc.body.appendChild(container);

  const state = {
    heldCapture: null,          /* H2O.Studio.inlineSelection.getHeldCapture() result */
    applyBehaviour: 'ok',       /* 'ok' | 'no-change' | 'fail' | 'reject' | 'deferred' | 'unavailable' */
    pendingResolve: null,
  };
  const bridgeCalls = [];
  const inlineCalls = [];
  let seq = 0;

  const sandbox = {
    H2O: {},
    document: doc,
    console: { log() {}, warn() {}, error() {}, info() {}, debug() {} },
    setTimeout: unrefTimeout,
    clearTimeout,
    setInterval: (fn, ms, ...a) => { const t = setInterval(fn, ms, ...a); if (t && t.unref) t.unref(); return t; },
    clearInterval,
    requestAnimationFrame: (fn) => unrefTimeout(fn, 0),
    cancelAnimationFrame: clearTimeout,
    queueMicrotask,
    location: { hash: '', href: '' },
    history: { state: null, pushState() {}, replaceState() {}, back() {} },
    navigator: {},
    localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    Blob: class {},
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  const context = vm.createContext(sandbox);

  SHELL_SCRIPT.runInContext(context);
  const shell = sandbox.H2O.Studio.ribbon;
  assert.ok(shell && shell.__shellInstalled === true, 'real ribbon shell must install');

  const bridge = {
    getMessageStateForTurn(turnIdx) {
      return Promise.resolve({ heading: { level: 2 }, bold: true, align: 'left', capturedFromTurn: Number(turnIdx) });
    },
    applyMessageFormatPaint(turnIdx, payload) {
      const live = shell.getContext();
      seq += 1;
      bridgeCalls.push({ seq, turnIdx: Number(turnIdx), payload, chatId: live.chatId, snapshotId: live.snapshotId });
      /* Mirror studio.js __ribbonBridge_publishAndRender: the persisted op
       * republishes overlay counts under the LIVE identity synchronously. */
      shell.setContext(Object.assign({}, shell.getContext(), {
        hasOverlay: true,
        undoCount: (Number(live.undoCount) || 0) + 1,
        redoCount: 0,
      }));
      switch (state.applyBehaviour) {
        case 'no-change': return Promise.resolve({ ok: true, applied: [], failed: [], reason: 'no-change' });
        case 'fail': return Promise.resolve({ ok: false, applied: [], failed: [], reason: 'drift-detected' });
        case 'reject': return Promise.reject(new Error('apply rejected'));
        case 'deferred': return new Promise((resolve) => { state.pendingResolve = resolve; });
        default: return Promise.resolve({ ok: true, applied: ['heading', 'bold'], failed: [], reason: '' });
      }
    },
    getInlineStateForTurn(_turnIdx) {
      return Promise.resolve({ bold: [{ start: 0, end: 1000 }], italic: [], underline: [], strikethrough: [], subscript: [], superscript: [], textColor: [] });
    },
    applyInlineFormatPaint(turnIdx, anchor, styles) {
      const live = shell.getContext();
      inlineCalls.push({ turnIdx: Number(turnIdx), anchor, styles, chatId: live.chatId, snapshotId: live.snapshotId });
      return Promise.resolve({ ok: true });
    },
  };
  sandbox.H2O.Studio.RibbonBridge = bridge;
  sandbox.H2O.Studio.overlay = {
    intervalsCover(list, s, e) { return Array.isArray(list) && list.some((g) => Number(g.start) <= s && Number(g.end) >= e); },
  };
  sandbox.H2O.Studio.inlineSelection = { getHeldCapture() { return state.heldCapture; } };

  ribbonScript.runInContext(context);
  assert.equal(sandbox.H2O.Studio.__studioRibbonSurfaceInstalled, true, 'real Ribbon surface must install');

  const flush = async (ticks = 6) => { for (let i = 0; i < ticks; i += 1) await new Promise((r) => setImmediate(r)); };
  const painterButton = () => container.querySelector('.wbRibbonAction[data-action-id="format-painter"]');
  const armedUI = () => { const b = painterButton(); return !!(b && b.getAttribute('aria-pressed') === 'true'); };
  const status = () => { const s = container.querySelector('.wbRibbonStatus'); return s ? s.textContent : null; };

  /* studio.js renderRoute tail (read route, saved snapshot): full context,
   * selectedTurnIdx intentionally absent (→ null). */
  const publishReaderMount = ({ chatId, snapshotId, title }) => shell.setContext({
    route: 'read',
    chatType: 'saved',
    snapshotId: snapshotId,
    chatId: chatId,
    title: title || chatId,
    originalUrl: null,
    readOnly: false,
  });
  /* studio.js reader selection handler (and Reader resume): merge selection
   * into the current context. */
  const publishSelection = (turnIdx, messageId) => shell.setContext(Object.assign({}, shell.getContext(), {
    selectedMessageId: messageId || (turnIdx ? 'msg-' + turnIdx : null),
    selectedTurnIdx: turnIdx,
  }));
  /* studio.js refreshReaderOverlay / publishAndRender: overlay-state merge. */
  const publishOverlayState = (fields) => shell.setContext(Object.assign({}, shell.getContext(), fields));
  /* studio.js renderRoute tail for a non-reader route. */
  const publishListRoute = () => shell.setContext({ route: 'saved', chatType: null, snapshotId: null, chatId: null, title: null, originalUrl: null, readOnly: false });

  const clickPainter = () => {
    const btn = painterButton();
    assert.ok(btn, 'format-painter button must be rendered');
    assert.ok(!btn.hasAttribute('disabled'), 'format-painter button must be enabled');
    btn.click();
  };
  const pressEscape = () => doc.dispatchEvent(new MiniEvent('keydown', { bubbles: true, cancelable: true, props: { key: 'Escape' } }));

  const armMessagePainter = async ({ chatId, snapshotId, turnIdx, sticky = false }) => {
    publishReaderMount({ chatId, snapshotId });
    publishSelection(turnIdx);
    await flush();
    clickPainter();
    await flush();
    assert.equal(status(), 'Format Painter: select a target message', 'message painter must arm');
    assert.equal(armedUI(), true, 'armed UI must reflect');
    if (sticky) {
      clickPainter();
      await flush();
      assert.equal(status(), 'Format Painter locked', 'second click within the lock window must lock (sticky)');
      assert.equal(armedUI(), true, 'sticky painter stays armed');
    }
  };

  return {
    sandbox, doc, container, shell, state, bridgeCalls, inlineCalls,
    flush, painterButton, armedUI, status, clickPainter, pressEscape,
    publishReaderMount, publishSelection, publishOverlayState, publishListRoute, armMessagePainter,
  };
}

const A = { chatId: 'chat-A', snapshotId: 'snap-A1' };
const A2 = { chatId: 'chat-A', snapshotId: 'snap-A2' };
const B = { chatId: 'chat-B', snapshotId: 'snap-B1' };

function assertNoWrites(h) {
  assert.equal(h.bridgeCalls.length, 0, 'expected ZERO applyMessageFormatPaint calls, got ' + JSON.stringify(h.bridgeCalls));
}

/* ── 0. Harness sanity ──────────────────────────────────────────────────── */

await checkAsync('harness: real shell + real Ribbon render the saved ribbon; painter enabled only with a selected turn', async () => {
  const h = await createHarness();
  h.publishReaderMount(A);
  await h.flush();
  assert.equal(h.container.dataset.chatType, 'saved');
  assert.ok(h.container.querySelector('.wbRibbonTab[data-tab-id="format"]'), 'Format tab rendered');
  const before = h.painterButton();
  assert.ok(before && before.hasAttribute('disabled'), 'painter disabled without a selected turn');
  h.publishSelection(3);
  await h.flush();
  const after = h.painterButton();
  assert.ok(after && !after.hasAttribute('disabled'), 'painter enabled with a selected turn');
  assert.equal(h.armedUI(), false);
  assertNoWrites(h);
});

/* ── 1. Same identity — single-use ──────────────────────────────────────── */

await checkAsync('single-use, same chat + same snapshot + new turn: applies exactly once under the armed identity, then disarms', async () => {
  const h = await createHarness();
  await h.armMessagePainter({ ...A, turnIdx: 3 });
  h.publishSelection(5);
  await h.flush();
  assert.equal(h.bridgeCalls.length, 1, 'one persisted apply');
  assert.deepEqual({ turnIdx: h.bridgeCalls[0].turnIdx, chatId: h.bridgeCalls[0].chatId, snapshotId: h.bridgeCalls[0].snapshotId },
    { turnIdx: 5, chatId: 'chat-A', snapshotId: 'snap-A1' });
  assert.equal(h.bridgeCalls[0].payload.capturedFromTurn, 3, 'payload captured from the source turn');
  assert.equal(h.status(), 'Formatting applied');
  assert.equal(h.armedUI(), false, 'single-use disarms after apply');
  h.publishSelection(7);
  await h.flush();
  assert.equal(h.bridgeCalls.length, 1, 'no second apply after single-use disarm');
});

await checkAsync('same identity: selecting the source turn again does not apply and keeps the painter armed', async () => {
  const h = await createHarness();
  await h.armMessagePainter({ ...A, turnIdx: 3 });
  h.publishSelection(9);   /* move away without arming a new capture is impossible; instead verify source-turn re-selection first */
  await h.flush();
  assert.equal(h.bridgeCalls.length, 1);
  const h2 = await createHarness();
  await h2.armMessagePainter({ ...A, turnIdx: 3 });
  h2.publishSelection(null);           /* deselect (same identity) */
  h2.publishSelection(3);              /* re-select the source turn */
  await h2.flush();
  assertNoWrites(h2);
  assert.equal(h2.armedUI(), true, 'still armed');
});

await checkAsync('same identity: renderRoute-style full republish of the SAME chat/snapshot keeps the painter armed; a following user target applies', async () => {
  const h = await createHarness();
  await h.armMessagePainter({ ...A, turnIdx: 3 });
  h.publishReaderMount(A);              /* same identity, selectedTurnIdx → null */
  await h.flush();
  assertNoWrites(h);
  assert.equal(h.armedUI(), true, 'same-identity republish must not disarm');
  h.publishSelection(5);                /* legitimate user-selected target */
  await h.flush();
  assert.equal(h.bridgeCalls.length, 1);
  assert.equal(h.bridgeCalls[0].turnIdx, 5);
  assert.equal(h.bridgeCalls[0].snapshotId, 'snap-A1');
});

await checkAsync('same identity: overlay-state republish (hasOverlay/undo/redo) neither disarms nor applies', async () => {
  const h = await createHarness();
  await h.armMessagePainter({ ...A, turnIdx: 3 });
  h.publishOverlayState({ hasOverlay: true, undoCount: 2, redoCount: 1 });
  await h.flush();
  assertNoWrites(h);
  assert.equal(h.armedUI(), true);
});

/* ── 2. Same identity — sticky ──────────────────────────────────────────── */

await checkAsync('sticky, same identity: applies to each new target, re-arms bound to the same identity, Escape disarms', async () => {
  const h = await createHarness();
  await h.armMessagePainter({ ...A, turnIdx: 3, sticky: true });
  h.publishSelection(5);
  await h.flush();
  assert.equal(h.bridgeCalls.length, 1);
  assert.equal(h.status(), 'Formatting applied — select next target');
  assert.equal(h.armedUI(), true, 'sticky re-arms after a successful apply');
  h.publishSelection(7);
  await h.flush();
  assert.equal(h.bridgeCalls.length, 2);
  assert.deepEqual(h.bridgeCalls.map((c) => [c.turnIdx, c.chatId, c.snapshotId]), [[5, 'chat-A', 'snap-A1'], [7, 'chat-A', 'snap-A1']]);
  h.pressEscape();
  await h.flush();
  assert.equal(h.status(), 'Format Painter off');
  assert.equal(h.armedUI(), false);
  h.publishSelection(9);
  await h.flush();
  assert.equal(h.bridgeCalls.length, 2, 'no apply after Escape');
});

await checkAsync('sticky, same identity: a failed apply (drift) reports and leaves the painter disarmed (no re-arm)', async () => {
  const h = await createHarness();
  await h.armMessagePainter({ ...A, turnIdx: 3, sticky: true });
  h.state.applyBehaviour = 'fail';
  h.publishSelection(5);
  await h.flush();
  assert.equal(h.bridgeCalls.length, 1);
  assert.equal(h.status(), 'Format paint failed: drift-detected');
  assert.equal(h.armedUI(), false);
  h.publishSelection(7);
  await h.flush();
  assert.equal(h.bridgeCalls.length, 1);
});

/* ── 3. Cross identity — the C1 defect class ────────────────────────────── */

await checkAsync('CROSS CHAT: automatic publication (renderRoute tail → selection) into another chat produces ZERO persisted writes and disarms', async () => {
  const h = await createHarness();
  await h.armMessagePainter({ ...A, turnIdx: 3 });
  h.publishReaderMount(B);              /* automatic context move: identity B, no selected turn */
  await h.flush();
  assert.equal(h.armedUI(), false, 'painter disarmed at the identity boundary');
  assert.equal(h.status(), 'Format Painter off — chat/snapshot changed');
  h.publishSelection(5);                /* automatic Reader selection/resume in B */
  await h.flush();
  assertNoWrites(h);
  h.publishSelection(4);                /* subsequent user click in B */
  await h.flush();
  assertNoWrites(h);
  assert.equal(h.armedUI(), false);
});

await checkAsync('CROSS SNAPSHOT: automatic publication into another snapshot of the SAME chat produces ZERO persisted writes and disarms', async () => {
  const h = await createHarness();
  await h.armMessagePainter({ ...A, turnIdx: 3 });
  h.publishReaderMount(A2);
  await h.flush();
  assert.equal(h.armedUI(), false);
  h.publishSelection(5);
  await h.flush();
  assertNoWrites(h);
});

await checkAsync('CROSS IDENTITY, single merged publication carrying a valid target turn: refused, ZERO writes', async () => {
  const h = await createHarness();
  await h.armMessagePainter({ ...A, turnIdx: 3 });
  h.publishOverlayState({ chatId: 'chat-B', snapshotId: 'snap-B1', selectedMessageId: 'msg-5', selectedTurnIdx: 5 });
  await h.flush();
  assertNoWrites(h);
  assert.equal(h.armedUI(), false);
});

await checkAsync('STALE ARMED STATE: identity B resumes on the SAME turn index as the source, then a user picks another turn — ZERO writes', async () => {
  const h = await createHarness();
  await h.armMessagePainter({ ...A, turnIdx: 3 });
  h.publishReaderMount(B);
  h.publishSelection(3);                /* same index as sourceTurnIdx — pre-C1 this silently kept the stale arm */
  await h.flush();
  assertNoWrites(h);
  assert.equal(h.armedUI(), false, 'stale armed state must not survive the identity change');
  h.publishSelection(4);
  await h.flush();
  assertNoWrites(h);
});

await checkAsync('STICKY CROSS IDENTITY: a locked painter is disarmed at the identity boundary, ZERO writes in the new chat', async () => {
  const h = await createHarness();
  await h.armMessagePainter({ ...A, turnIdx: 3, sticky: true });
  h.publishReaderMount(B);
  h.publishSelection(5);
  await h.flush();
  assertNoWrites(h);
  assert.equal(h.armedUI(), false);
  h.publishSelection(6);
  await h.flush();
  assertNoWrites(h);
});

await checkAsync('STICKY RE-ARM RACE: identity moves while a same-identity apply is pending → no re-arm into the foreign identity, no second write', async () => {
  const h = await createHarness();
  await h.armMessagePainter({ ...A, turnIdx: 3, sticky: true });
  h.state.applyBehaviour = 'deferred';
  h.publishSelection(5);
  await h.flush();
  assert.equal(h.bridgeCalls.length, 1, 'first apply issued under A');
  assert.equal(h.bridgeCalls[0].snapshotId, 'snap-A1');
  assert.ok(typeof h.state.pendingResolve === 'function', 'apply is pending');
  h.publishReaderMount(B);              /* automatic move while the apply is in flight */
  h.publishSelection(2);
  await h.flush();
  h.state.pendingResolve({ ok: true, applied: ['heading'], failed: [], reason: '' });
  await h.flush();
  assert.equal(h.armedUI(), false, 'sticky must not re-arm into a foreign identity');
  assert.equal(h.status(), 'Formatting applied — Format Painter off (chat/snapshot changed)');
  h.state.applyBehaviour = 'ok';
  h.publishSelection(4);
  await h.flush();
  assert.equal(h.bridgeCalls.length, 1, 'no write into chat B');
});

await checkAsync('LEAVING THE READER: a non-reader route publication (no chat identity) disarms; returning to the origin snapshot does not revive the arm', async () => {
  const h = await createHarness();
  await h.armMessagePainter({ ...A, turnIdx: 3 });
  h.publishListRoute();
  await h.flush();
  assert.equal(h.container.hidden, true, 'ribbon hidden without a chat context (unchanged behavior)');
  h.publishReaderMount(A);
  h.publishSelection(5);
  await h.flush();
  assertNoWrites(h);
  assert.equal(h.armedUI(), false);
});

await checkAsync('FAIL CLOSED: an armed record without a bound snapshotId never applies (synthetic saved context lacking snapshotId)', async () => {
  const h = await createHarness();
  h.shell.setContext({ route: 'read', chatType: 'saved', snapshotId: null, chatId: 'chat-A', title: 'x', originalUrl: null, readOnly: false });
  h.publishSelection(3);
  await h.flush();
  h.clickPainter();
  await h.flush();
  assert.equal(h.armedUI(), true, 'arms (isEnabled only gates chatType + turn)');
  h.publishSelection(5);                /* identical (unbound) identity, new turn */
  await h.flush();
  assertNoWrites(h);
  assert.equal(h.armedUI(), false, 'unbound armed record is disarmed, not applied');
});

/* ── 4. Invalid / failed target handling ────────────────────────────────── */

await checkAsync('failed target handling: bridge rejection and a bridge without applyMessageFormatPaint both end disarmed with the pre-C1 statuses', async () => {
  const h = await createHarness();
  await h.armMessagePainter({ ...A, turnIdx: 3 });
  h.state.applyBehaviour = 'reject';
  h.publishSelection(5);
  await h.flush();
  assert.equal(h.bridgeCalls.length, 1);
  assert.equal(h.status(), 'Format paint failed');
  assert.equal(h.armedUI(), false);

  const h2 = await createHarness();
  await h2.armMessagePainter({ ...A, turnIdx: 3 });
  const original = h2.sandbox.H2O.Studio.RibbonBridge.applyMessageFormatPaint;
  delete h2.sandbox.H2O.Studio.RibbonBridge.applyMessageFormatPaint;
  h2.publishSelection(5);
  await h2.flush();
  /* The synchronous 'Format Painter unavailable' status is wiped by the
   * same-tick contextChanged re-render (pre-existing Ribbon behavior, not
   * part of C1); the safety facts are: disarmed, zero calls. */
  assert.equal(h2.armedUI(), false);
  assertNoWrites(h2);
  h2.sandbox.H2O.Studio.RibbonBridge.applyMessageFormatPaint = original;
  h2.publishSelection(6);
  await h2.flush();
  assertNoWrites(h2);
});

/* ── 5. Inline Format Painter unchanged ─────────────────────────────────── */

const heldOn = (turnIdx) => ({ ok: true, selectedTurnIdx: turnIdx, selectedMessageId: 'msg-' + turnIdx, anchor: { textPos: { start: 2, end: 9 } } });

await checkAsync('inline painter, same identity: arms from the held selection, ignores contextChanged, applies on the second click, then disarms', async () => {
  const h = await createHarness();
  h.publishReaderMount(A);
  h.publishSelection(3);
  h.state.heldCapture = heldOn(3);
  await h.flush();
  h.clickPainter();
  await h.flush();
  assert.equal(h.status(), 'Inline Format Painter: select target text, then click Format Painter');
  assert.equal(h.armedUI(), true);
  h.publishSelection(5);               /* contextChanged must NOT apply inline */
  await h.flush();
  assertNoWrites(h);
  assert.equal(h.inlineCalls.length, 0);
  assert.equal(h.armedUI(), true, 'inline arm survives contextChanged (unchanged)');
  h.state.heldCapture = heldOn(5);
  h.clickPainter();
  await h.flush();
  assert.equal(h.inlineCalls.length, 1);
  assert.deepEqual(plain({ turnIdx: h.inlineCalls[0].turnIdx, anchor: h.inlineCalls[0].anchor, bold: h.inlineCalls[0].styles.bold }),
    { turnIdx: 5, anchor: { textPos: { start: 2, end: 9 }, messageId: 'msg-5' }, bold: true });
  assert.equal(h.status(), 'Inline formatting applied');
  assert.equal(h.armedUI(), false);
  assertNoWrites(h);
});

await checkAsync('inline painter is not fenced by contextChanged (unchanged): a cross-identity publication leaves the inline arm untouched and never calls the message apply', async () => {
  const h = await createHarness();
  h.publishReaderMount(A);
  h.publishSelection(3);
  h.state.heldCapture = heldOn(3);
  await h.flush();
  h.clickPainter();
  await h.flush();
  assert.equal(h.armedUI(), true);
  h.publishReaderMount(B);
  h.publishSelection(5);
  await h.flush();
  assertNoWrites(h);
  assert.equal(h.inlineCalls.length, 0);
  assert.equal(h.armedUI(), true, 'inline armed state is outside the C1 fence (explicit-click semantics unchanged)');
  h.pressEscape();
  await h.flush();
  assert.equal(h.armedUI(), false);
});

/* ── 6. Unrelated Ribbon behavior ───────────────────────────────────────── */

await checkAsync('unrelated Ribbon behavior: tab switch, collapse toggle and contextChanged re-render still work', async () => {
  const h = await createHarness();
  h.publishReaderMount(A);
  await h.flush();
  const homeTab = h.container.querySelector('.wbRibbonTab[data-tab-id="home"]');
  assert.ok(homeTab, 'home tab rendered');
  homeTab.click();
  assert.equal(h.shell.getActiveTab(), 'home');
  assert.ok(h.container.querySelector('.wbRibbonTab[data-tab-id="home"][aria-selected="true"]'), 'tab switch re-rendered');
  const collapse = () => h.container.querySelector('[data-action="toggle-collapsed"]');
  assert.ok(collapse(), 'collapse control rendered');
  collapse().click();
  assert.equal(h.shell.getCollapsed(), true);
  assert.equal(h.container.dataset.collapsed, 'true', 'collapsedChanged re-rendered');
  collapse().click();                  /* re-queried: the re-render replaced the control */
  assert.equal(h.shell.getCollapsed(), false);
  assert.equal(h.container.dataset.collapsed, '');
  h.publishReaderMount(B);
  await h.flush();
  assert.equal(h.container.dataset.chatType, 'saved');
  assert.equal(h.shell.getContext().chatId, 'chat-B');
  assertNoWrites(h);
});

/* ── 7. Static structure pins (comment-stripped view) ───────────────────── */

const codeOnly = (src) => src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');

check('static: the identity fence precedes any applyMessageFormatPaint call inside the contextChanged subscriber', () => {
  const code = codeOnly(RIBBON_SRC);
  const subStart = code.indexOf('shell.subscribe(function (evt)');
  assert.ok(subStart > 0, 'subscriber found');
  const block = code.slice(subStart, code.indexOf('prefs.subscribe', subStart));
  const fenceAt = block.indexOf('__formatPainterIdentityMatches(__formatPainterArmed, nctx)');
  const applyAt = block.indexOf('applyMessageFormatPaint(nTurn');
  assert.ok(fenceAt > 0 && applyAt > 0, 'both the fence and the apply call are present');
  assert.ok(fenceAt < applyAt, 'fence must be evaluated before the apply call');
  assert.match(block, /if \(!__formatPainterIdentityMatches\(__formatPainterArmed, nctx\)\) \{[\s\S]*?__formatPainterDisarm\(\);[\s\S]*?\} else if \(Number\.isFinite\(nTurn\)/);
});

check('static: the message-mode armed record and the sticky re-arm carry chatId + snapshotId; the inline record is unchanged', () => {
  const code = codeOnly(RIBBON_SRC);
  assert.match(code, /mode: 'message', payload: p, sourceTurnIdx: turnIdx, sticky: false, chatId: armIdentity\.chatId, snapshotId: armIdentity\.snapshotId/);
  assert.match(code, /mode: 'message', payload: keepPayload, sourceTurnIdx: keepSrc, sticky: true, chatId: keepIdentity\.chatId, snapshotId: keepIdentity\.snapshotId/);
  assert.match(code, /wasSticky && __formatPainterIdentityMatches\(keepIdentity, rctx\)/);
  const inlineRecords = code.match(/mode: 'inline'[^\n]*/g) || [];
  assert.ok(inlineRecords.length >= 2, 'inline engage records present');
  for (const rec of inlineRecords) assert.ok(!/chatId|snapshotId/.test(rec), 'inline record must not be widened: ' + rec);
});

check('static: the fence uses only canonical shell context identity values and fails closed on an unbound record', () => {
  const code = codeOnly(RIBBON_SRC);
  assert.match(code, /function __formatPainterIdentityOf\(ctx\) \{[\s\S]*?ctx\.chatId[\s\S]*?ctx\.snapshotId[\s\S]*?\n  \}/);
  assert.match(code, /function __formatPainterIdentityMatches\(armed, ctx\) \{\s*if \(!armed \|\| typeof armed\.snapshotId !== 'string' \|\| !armed\.snapshotId\) return false;/);
  assert.match(code, /live\.snapshotId === armed\.snapshotId && live\.chatId === armed\.chatId/);
  assert.ok(!/__formatPainterIdentity(Of|Matches)[\s\S]{0,400}(localStorage|sessionStorage|location\.hash|history\.)/.test(code), 'no invented identity source');
});

/* ── 8. Negative controls: the harness must detect the defect ───────────── */

const FENCE_FN_RE = /function __formatPainterIdentityMatches\(armed, ctx\) \{[\s\S]*?\n  \}\n/;

async function runCrossIdentityScenario(ribbonScript) {
  const h = await createHarness({ ribbonScript });
  await h.armMessagePainter({ ...A, turnIdx: 3 });
  h.publishReaderMount(B);
  h.publishSelection(5);
  await h.flush();
  return h;
}

await checkAsync('NEGATIVE CONTROL (mutation): with the identity fence forced open, the cross-chat scenario DOES persist a write into chat B', async () => {
  const mutant = RIBBON_SRC.replace(FENCE_FN_RE, 'function __formatPainterIdentityMatches() { return true; }\n');
  assert.notEqual(mutant, RIBBON_SRC, 'mutation must apply');
  const h = await runCrossIdentityScenario(new vm.Script(mutant, { filename: 'ribbon-mutant-fence-open.js' }));
  assert.equal(h.bridgeCalls.length, 1, 'mutant must reproduce the defect');
  assert.deepEqual({ turnIdx: h.bridgeCalls[0].turnIdx, chatId: h.bridgeCalls[0].chatId, snapshotId: h.bridgeCalls[0].snapshotId },
    { turnIdx: 5, chatId: 'chat-B', snapshotId: 'snap-B1' }, 'the stale payload lands in the wrong identity');
  assert.equal(h.bridgeCalls[0].payload.capturedFromTurn, 3, 'payload captured in chat A');
});

{
  let baseline = null;
  try {
    baseline = execFileSync('git', ['-C', REPO_ROOT, 'cat-file', 'blob', BASELINE_RIBBON_BLOB], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 });
  } catch (_) { baseline = null; }
  if (baseline && baseline.length > 0) {
    await checkAsync('NEGATIVE CONTROL (genuine baseline blob 77e96f37): the pre-C1 Ribbon persists the cross-chat write the fence now prevents', async () => {
      assert.ok(!baseline.includes('__formatPainterIdentityMatches'), 'baseline has no fence');
      const h = await runCrossIdentityScenario(new vm.Script(baseline, { filename: 'ribbon-baseline-77e96f37.js' }));
      assert.equal(h.bridgeCalls.length, 1, 'baseline reproduces the defect');
      assert.equal(h.bridgeCalls[0].chatId, 'chat-B');
      assert.equal(h.bridgeCalls[0].snapshotId, 'snap-B1');
      assert.equal(h.bridgeCalls[0].turnIdx, 5);
    });
    await checkAsync('baseline parity: the inline Format Painter branch and the click-path arm/lock/cancel logic are byte-identical to the baseline', async () => {
      const slice = (src, from, to) => {
        const a = src.indexOf(from);
        const b = src.indexOf(to, a);
        assert.ok(a > 0 && b > a, 'anchors present: ' + from);
        return src.slice(a, b);
      };
      /* Whole armed-click branch (inline apply + message lock/cancel) up to the arm paths. */
      assert.equal(
        slice(RIBBON_SRC, "if (__formatPainterArmed) {\n        const armed = __formatPainterArmed;", '/* Message-level capture (8g-1).'),
        slice(baseline, "if (__formatPainterArmed) {\n        const armed = __formatPainterArmed;", '/* Message-level capture (8g-1).'),
        'armed-click branch (inline apply, sticky lock, cancel, inline capture) unchanged'
      );
      /* Everything outside the Format Painter section is unchanged: compare the source with the C1 hunks normalised away. */
      const strip = (src) => src
        .replace(/\n  \/\* Reader M02 C1 — chat\/snapshot identity fence[\s\S]*?\n  \}(?=\n  function __formatPainterSetArmedUI)/, '')
        .replace(/\n  \/\* Phase 8g-1 \/ 8g-2a — Format Painter armed state \(single-use\)\. Either[\s\S]*?never persisted\. \*\//, '')
        .replace(/\/\* Message-level capture \(8g-1\)\.[\s\S]*?setStatus\('Capturing formatting…'\);/, '')
        .replace(/, chatId: armIdentity\.chatId, snapshotId: armIdentity\.snapshotId/, '')
        .replace(/if \(!__formatPainterIdentityMatches\(__formatPainterArmed, nctx\)\) \{[\s\S]*?\} else if \(Number\.isFinite\(nTurn\)/, 'if (Number.isFinite(nTurn)')
        .replace(/ Reader M02 C1 —\n\s*\* the re-arm stays bound[\s\S]*?meanwhile\. \*\//, ' */')
        .replace(/\n\s*const keepIdentity = \{ chatId: armed\.chatId, snapshotId: armed\.snapshotId \};/, '')
        .replace(/\n\s*let rctx = null;\n\s*try \{ rctx = shell\.getContext\(\); \} catch \(_\) \{ rctx = null; \}/, '')
        .replace(/if \(wasSticky && __formatPainterIdentityMatches\(keepIdentity, rctx\)\) __formatPainterEngage\(\{ mode: 'message', payload: keepPayload, sourceTurnIdx: keepSrc, sticky: true, chatId: keepIdentity\.chatId, snapshotId: keepIdentity\.snapshotId \}/, "if (wasSticky) __formatPainterEngage({ mode: 'message', payload: keepPayload, sourceTurnIdx: keepSrc, sticky: true }")
        .replace(/\n\s*else if \(wasSticky\) fpStatus\('Formatting applied — Format Painter off \(chat\/snapshot changed\)'\);/, '');
      const current = strip(RIBBON_SRC);
      const base = strip(baseline);
      if (current !== base) {
        let i = 0;
        while (i < current.length && current[i] === base[i]) i += 1;
        assert.fail('residual difference outside the C1 hunks near: ' + JSON.stringify(current.slice(Math.max(0, i - 80), i + 120)));
      }
    });
  } else {
    SKIP.push('NEGATIVE CONTROL (genuine baseline blob): git object ' + BASELINE_RIBBON_BLOB + ' unavailable in this checkout — mutation control still ran');
    console.log('  SKIP genuine-baseline control: blob ' + BASELINE_RIBBON_BLOB + ' not reachable via git (mutation control covers the harness sensitivity)');
  }
}

/* ── Report ─────────────────────────────────────────────────────────────── */

if (FAIL.length) {
  console.error(`\n[reader-m02-c1-format-painter-identity-fence] ${FAIL.length} failed, ${PASS.length} passed${SKIP.length ? `, ${SKIP.length} skipped` : ''}`);
  process.exitCode = 1;
} else {
  console.log(`\n[reader-m02-c1-format-painter-identity-fence] all ${PASS.length} checks passed${SKIP.length ? ` (${SKIP.length} optional control skipped)` : ''}`);
}
