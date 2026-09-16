#!/usr/bin/env node
// M04 P2 — Renderer presentation registry: consumer coverage (the one planned
// permanent registry validator; this T4 slice covers the Appearance preference
// contribution, the current New UI Presentation selector and the Reader
// integration through the real seams; T5 consolidates the T3 registry-lifetime
// / stylesheet / neutrality coverage here).
//
// Tier 1 (always): appearance-keys + appearance-store in fresh VM contexts with
// a fake platform storage adapter, coercion spies and controllable timers.
// Tier 2 (real Chromium): the REAL Appearance panel over the REAL Renderer
// registry (lazy list-derived Presentation row, missing-registry isolation),
// then the REAL Reader seams (extracted verbatim from studio.js, as the
// lifecycle validator does) driving the REAL Renderer through the New UI
// selector: selection, hydration, equivalent reuse, changed-profile rebuild,
// committed and rapid A -> B -> A, unknown preference, route leave.
// An unavailable browser SKIPs loudly; SKIP is never reported as evidence.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), '..', '..', '..');
const STUDIO = path.join(REPO_ROOT, 'src-surfaces-base/studio');
const KEYS_REL = 'appearance/appearance-keys.js';
const STORE_REL = 'appearance/appearance-store.studio.js';
const PANEL_REL = 'appearance/appearance-panel.studio.js';
const STUDIO_JS_REL = 'studio.js';
const PROFILE_REL = 'renderer/presentation/presentation-profile.v1.js';
const CLEAN_READER_REL = 'renderer/presentation/h2o-clean-reader.v1.js';
const STORAGE_KEY = 'h2o:studio:appearance:presentationProfile:v1';
const STRICT = /^(1|true|yes)$/i.test(String(process.env.H2O_REQUIRE_PRESENTATION_REGISTRY_TIER2 || ''));
/* Optional visible evidence: a directory receiving PNGs of the real panel row and the Reader before / after selection. */
const SHOTS_DIR = String(process.env.H2O_PRESENTATION_REGISTRY_SHOTS || '').trim();
async function shot(page, name, selector = null) {
  if (!SHOTS_DIR) return;
  fs.mkdirSync(SHOTS_DIR, { recursive: true });
  const target = path.join(SHOTS_DIR, `${name}.png`);
  if (selector) await page.locator(selector).first().screenshot({ path: target }); else await page.screenshot({ path: target });
  console.log(`SHOT_WRITTEN: ${target}`);
}

const checks = [];
const failures = [];
function check(label, fn) {
  try { fn(); checks.push(label); console.log(`✓ ${label}`); }
  catch (e) { failures.push(label); console.log(`✗ ${label}\n    ${e.message}`); }
}
const read = (rel) => fs.readFileSync(path.join(STUDIO, rel), 'utf8');

/* --------------------------------------------------------------- Tier 1 -- */

/* A fresh Appearance store over a fake platform storage. `stored` seeds the
 * hydration values; get()/set() are asynchronous like the real adapters. */
async function loadStore({ stored = {}, adapter = 'fake' } = {}) {
  const storage = { reads: [], writes: [] };
  const attributes = {}; const cssVars = {};
  const timers = [];
  const dispatched = [];
  const sandbox = vm.createContext({
    console,
    queueMicrotask,
    Date,
    CustomEvent: class CustomEvent { constructor(type, init) { this.type = type; this.detail = init && init.detail; } },
    setTimeout(fn, ms) { timers.push({ fn, ms }); return timers.length; },
    clearTimeout() {},
    document: { documentElement: { setAttribute(k, v) { attributes[k] = v; }, style: { setProperty(k, v) { cssVars[k] = v; } } } },
    dispatchEvent(event) { dispatched.push(event); return true; },
  });
  sandbox.window = sandbox; sandbox.globalThis = sandbox;
  sandbox.H2O = { Studio: { platform: {
    env: { adapter },
    storage: {
      get(key) { storage.reads.push(key); return Promise.resolve(Object.prototype.hasOwnProperty.call(stored, key) ? stored[key] : undefined); },
      set(key, value) { storage.writes.push([key, value]); return Promise.resolve(); },
    },
  } } };
  vm.runInContext(read(KEYS_REL), sandbox, { filename: 'appearance-keys.js' });
  vm.runInContext(read(STORE_REL), sandbox, { filename: 'appearance-store.studio.js' });
  /* bootHydrate is a microtask; the adapter promises resolve within a few ticks. */
  for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setImmediate(resolve));
  const appearance = sandbox.H2O.Studio.appearance;
  return { appearance, storage, attributes, cssVars, dispatched, flush() { const pending = timers.splice(0); for (const t of pending) t.fn(); return pending.length; } };
}

/* A value whose every conversion hook throws (and counts). */
function coercionTrap() {
  const calls = { toString: 0, valueOf: 0, toPrimitive: 0 };
  const trap = Object.create(null);
  Object.defineProperty(trap, 'toString', { value() { calls.toString += 1; throw new Error('toString invoked'); } });
  Object.defineProperty(trap, 'valueOf', { value() { calls.valueOf += 1; throw new Error('valueOf invoked'); } });
  Object.defineProperty(trap, Symbol.toPrimitive, { value() { calls.toPrimitive += 1; throw new Error('toPrimitive invoked'); } });
  return { trap, calls };
}

check('M04 P2 T4 (D): appearance-keys carries exactly one new logical key with its storage key and default; every other key, default, bound and event is unchanged', () => {
  const sandbox = vm.createContext({}); sandbox.window = sandbox;
  vm.runInContext(read(KEYS_REL), sandbox, { filename: 'appearance-keys.js' });
  const a = sandbox.H2O.Studio.appearance;
  /* VM-realm objects are copied before strict deepEqual (prototype realms differ). */
  assert.deepEqual({ ...a.keys }, {
    theme: 'h2o:studio:appearance:theme:v1', typography: 'h2o:studio:appearance:typography:v1', fontSize: 'h2o:studio:appearance:fontSize:v1', contentWidth: 'h2o:studio:appearance:contentWidth:v1',
    showFolders: 'h2o:studio:appearance:showFolders:v1', showNotes: 'h2o:studio:appearance:showNotes:v1', plainText: 'h2o:studio:appearance:plainText:v1', alwaysOnTop: 'h2o:studio:appearance:alwaysOnTop:v1',
    presentationProfile: STORAGE_KEY,
  }, 'A: the eight existing storage keys plus presentationProfile');
  assert.deepEqual({ ...a.defaults }, { theme: 'dark', typography: 'sans', fontSize: 16, contentWidth: 48, showFolders: true, showNotes: true, plainText: false, alwaysOnTop: false, presentationProfile: 'chatgpt-reference' }, 'A: default chatgpt-reference');
  assert.deepEqual([[...a.themes], [...a.typographies]], [['dark', 'light', 'sepia'], ['sans', 'serif', 'mono']]);
  assert.deepEqual(JSON.parse(JSON.stringify(a.bounds)), { fontSize: { min: 13, max: 22, step: 1 }, contentWidth: { min: 36, max: 72, step: 4 } });
  assert.deepEqual({ ...a.events }, { changed: 'evt:h2o:studio:appearance:changed', ready: 'evt:h2o:studio:appearance:ready' });
  assert.equal(Object.isFrozen(a.keys) && Object.isFrozen(a.defaults), true);
});

await (async () => {
  const fresh = await loadStore();
  check('M04 P2 T4 (D): the store preserves any string exactly (unknown ids and the empty string), persists it verbatim, and notifies one change per distinct value', () => {
    const { appearance, storage, flush, dispatched } = fresh;
    assert.equal(appearance.get('presentationProfile'), 'chatgpt-reference', 'default before any set');
    const events = []; const unsubscribe = appearance.subscribe((event) => events.push(event));
    appearance.set('presentationProfile', 'h2o-clean-reader');
    assert.equal(appearance.get('presentationProfile'), 'h2o-clean-reader');
    appearance.set('presentationProfile', 'h2o-clean-reader');
    assert.equal(events.length, 1, 'an equal value is a no-op (no second change)');
    appearance.set('presentationProfile', 'no-such-profile');
    assert.equal(appearance.get('presentationProfile'), 'no-such-profile', 'an unknown id is preserved verbatim (no registry validation, no effective fallback)');
    appearance.set('presentationProfile', '');
    assert.equal(appearance.get('presentationProfile'), '', 'the empty string is preserved');
    assert.deepEqual(events.map((e) => [e.type, e.key, e.value]), [['change', 'presentationProfile', 'h2o-clean-reader'], ['change', 'presentationProfile', 'no-such-profile'], ['change', 'presentationProfile', '']]);
    assert.equal(flush(), 1, 'one debounced flush');
    assert.deepEqual(storage.writes.filter(([key]) => key === STORAGE_KEY), [[STORAGE_KEY, '']], 'the latest verbatim value is persisted under the storage key');
    assert.equal(appearance.getAll().presentationProfile, '', 'getAll carries the preference');
    assert.ok(dispatched.some((e) => e.type === 'evt:h2o:studio:appearance:changed' && e.detail.key === 'presentationProfile'), 'window-level changed event still dispatched');
    unsubscribe();
    appearance.set('presentationProfile', 'chatgpt-reference');
    assert.equal(events.length, 3, 'unsubscribed');
    assert.deepEqual([...appearance.selfCheck().errors], [], 'no store errors');
  });
  check('M04 P2 T4 (D): non-string values fall back to the default without invoking any conversion hook; other keys keep their coercion', () => {
    const { appearance } = fresh;
    appearance.set('presentationProfile', 'h2o-clean-reader');
    for (const value of [42, true, null, undefined, ['h2o-clean-reader'], { id: 'h2o-clean-reader' }, Symbol('p'), () => 'h2o-clean-reader']) {
      appearance.set('presentationProfile', 'h2o-clean-reader');
      appearance.set('presentationProfile', value);
      assert.equal(appearance.get('presentationProfile'), 'chatgpt-reference', `non-string ${typeof value} -> default`);
    }
    const { trap, calls } = coercionTrap();
    appearance.set('presentationProfile', 'h2o-clean-reader');
    assert.doesNotThrow(() => appearance.set('presentationProfile', trap), 'a throwing coercion trap cannot break set()');
    assert.equal(appearance.get('presentationProfile'), 'chatgpt-reference');
    assert.deepEqual(calls, { toString: 0, valueOf: 0, toPrimitive: 0 }, 'no toString / valueOf / Symbol.toPrimitive ran');
    const strTrap = new String('h2o-clean-reader'); /* a String object is not a string primitive */
    appearance.set('presentationProfile', strTrap);
    assert.equal(appearance.get('presentationProfile'), 'chatgpt-reference', 'String objects are non-strings');
    appearance.set('theme', 'nope'); assert.equal(appearance.get('theme'), 'dark', 'theme coercion unchanged');
    appearance.set('fontSize', 99); assert.equal(appearance.get('fontSize'), 22, 'fontSize clamp unchanged');
    appearance.set('plainText', 'true'); assert.equal(appearance.get('plainText'), true, 'boolean coercion unchanged');
  });
  check('M04 P2 T4 (D): apply() writes no document attribute or variable for the preference (the Renderer applies the profile per render)', () => {
    const { appearance, attributes, cssVars } = fresh;
    appearance.set('presentationProfile', 'h2o-clean-reader');
    appearance.apply();
    assert.deepEqual(Object.keys(attributes).sort(), ['data-h2o-plain-text', 'data-h2o-show-folders', 'data-h2o-show-notes', 'data-h2o-theme', 'data-h2o-typography'], 'only the existing attributes');
    assert.deepEqual(Object.keys(cssVars).sort(), ['--wb-appearance-content-width', '--wb-appearance-font-size']);
    assert.ok(!JSON.stringify(attributes).includes('clean-reader') && !JSON.stringify(cssVars).includes('clean-reader'));
  });
})();

await (async () => {
  const unknown = await loadStore({ stored: { [STORAGE_KEY]: 'no-such-profile' } });
  const empty = await loadStore({ stored: { [STORAGE_KEY]: '' } });
  const nonString = await loadStore({ stored: { [STORAGE_KEY]: 7 } });
  const absent = await loadStore({ stored: {} });
  const fallback = await loadStore({ stored: { [STORAGE_KEY]: 'h2o-clean-reader' }, adapter: 'fallback' });
  check('M04 P2 T4 (D): hydration round trips — unknown and empty strings survive verbatim, a stored non-string hydrates to the default, absent stays default, ready fires once without change events, nothing is written back', () => {
    for (const [label, harness, expected] of [['unknown', unknown, 'no-such-profile'], ['empty', empty, ''], ['non-string', nonString, 'chatgpt-reference'], ['absent', absent, 'chatgpt-reference']]) {
      assert.equal(harness.appearance.isReady(), true, `${label}: hydrated`);
      assert.equal(harness.appearance.get('presentationProfile'), expected, `${label}: hydrated value`);
      assert.ok(harness.storage.reads.includes(STORAGE_KEY), `${label}: the storage key was read at boot`);
      assert.deepEqual(harness.storage.writes, [], `${label}: hydration persists nothing (no effective fallback written back)`);
      assert.deepEqual(harness.dispatched.filter((e) => e.type === 'evt:h2o:studio:appearance:ready').length, 1, `${label}: one ready`);
      assert.equal(harness.dispatched.some((e) => e.type === 'evt:h2o:studio:appearance:changed' && e.detail.type === 'change'), false, `${label}: hydration emits no change event`);
      assert.deepEqual([...harness.appearance.selfCheck().errors], [], `${label}: no errors`);
    }
    assert.equal(fallback.appearance.get('presentationProfile'), 'chatgpt-reference', 'a fallback adapter (no real storage) keeps defaults');
    assert.deepEqual(fallback.storage.reads, [], 'and never reads');
  });
})();

/* --------------------------------------------------------------- Tier 2 -- */

/* Same source-extraction convention as the lifecycle / Reader validators:
 * only the named seams run; the Studio application is not booted. */
const studioSource = read(STUDIO_JS_REL);
function extract(name, text = studioSource) {
  const match = new RegExp(`\\b(?:async\\s+)?function\\s+${name}\\s*\\(`).exec(text);
  assert.ok(match, `missing source seam: ${name}`);
  const at = match.index;
  const open = text.indexOf('{', text.indexOf(')', at));
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === '{') depth += 1;
    if (text[i] === '}' && --depth === 0) { const fn = text.slice(at, i + 1); new vm.Script(`(${fn})`); return fn; }
  }
  throw new Error(`unterminated source seam: ${name}`);
}
const READER_SEAMS = ['getStudioChatRenderer', 'bindReaderSemanticIndex', 'getReaderSemanticIndex', 'getReaderDecorationContributions', 'disposeReaderRenderDecorations', 'studioHostUnmount', 'studioHostUnmountPreservingRouteHash', 'isCurrentReaderRoot', 'getReusableReaderMount', 'isReusableReaderMountCurrent', 'collectRendererEditOverrides', 'haveEquivalentRendererEditOverrides', 'getReaderPresentationPreference', 'isReaderPresentationCurrent', 'canReuseReaderDOM', 'refreshReaderPresentation', 'subscribeReaderToPresentationPreference', 'rememberPublicationTarget', 'renderReader', 'buildReaderDOM'];
const CHAIN = ['platform/selectors.contract.js', 'platform/html-sanitizer.js', 'renderer/safety/sanitizer-policy.v1.js', 'renderer/safety/vendor/dompurify/purify.js', 'renderer/safety/html-sanitizer.v2.js', 'renderer/markdown/vendor/markdown-it/markdown-it.umd.min.js', 'renderer/markdown/h2o-gfm.v1.js', 'renderer/markdown/markdown-engine.v1.js', 'renderer/markdown/markdown-ir-adapter.v1.js', 'renderer/semantic/render-ir.v1.js', 'renderer/semantic/semantic-ingress.v1.js', 'renderer/semantic/semantic-index.v1.js', 'renderer/decoration/decoration-contribution.v1.js', PROFILE_REL, CLEAN_READER_REL, 'renderer/content/content-renderer.v1.js', 'renderer/chat-renderer.studio.js'];

/* Reader seams + the collaborator stubs renderReader needs (mirrors the
 * lifecycle validator's harness) + a marker-faithful fake Studio host. */
function readerSeamsScript() {
  return `(() => {
    const W = window; const H2O = W.H2O; const $ = (selector) => document.querySelector(selector);
    const STUDIO_BOOT_AUX_TIMEOUT_MS = 1;
    const state = { rowsCache: [], activeRoute: 'list', renderToken: 0, currentReaderSnapshot: null, currentReaderEditOverrides: null, currentReaderRender: null, currentReaderNavigationTarget: null, readerPresentationUnsubscribe: null, publicationTarget: null, selectedSnapshotId: '', selectedChatId: '', lastView: 'saved', lastFolderId: '' };
    const snapshots = new Map(); const renders = []; const lifecycleDisposals = [];
    let hostState = { root: null, turns: null, scroll: null, snapshot: null, mountCount: 0, unmountCount: 0 };
    H2O.studioHost = {
      mount(opts) { hostState.root = opts.readerRoot; hostState.turns = opts.turnsEl; hostState.scroll = opts.scrollEl; hostState.snapshot = opts.snapshot; hostState.mountCount += 1; opts.readerRoot.setAttribute('data-h2o-studio-reader', '1'); opts.scrollEl.setAttribute('data-scroll-root', '1'); return true; },
      unmount() { if (!hostState.root) return false; hostState.root.removeAttribute('data-h2o-studio-reader'); hostState.scroll?.removeAttribute('data-scroll-root'); hostState.root = null; hostState.turns = null; hostState.scroll = null; hostState.snapshot = null; hostState.unmountCount += 1; return true; },
      getReaderRoot: () => (hostState.root?.isConnected ? hostState.root : null),
      getTurnsRoot: () => (hostState.turns?.isConnected ? hostState.turns : null),
      getScrollRoot: () => (hostState.scroll?.isConnected ? hostState.scroll : null),
      updateSnapshot(snapshot) { if (!hostState.root?.isConnected) return false; hostState.snapshot = snapshot; return true; },
    };
    const setStudioRouteScope = (name) => { state.activeRoute = name; };
    const applyDesktopReaderRibbonSession = () => {}; const ensureReaderTopbarActions = () => {}; const setRouteMeta = () => {};
    const callArchive = async (_op, payload) => snapshots.get(String(payload?.snapshotId || '')) || null;
    const fetchWorkbenchRows = async () => []; const enrichRowsWithFolderData = async (rows) => rows; const renderFolderSidebar = () => {}; const refreshSidebarChatList = () => {};
    const promiseWithTimeoutFallback = async (promise, _t, _l, fallback) => { try { return await promise; } catch { return fallback; } };
    const fetchFolderCatalog = async () => ({ canonical: [], review: [] }); const fetchLabelCatalog = async () => []; const fetchCategoryCatalog = async () => [];
    const resolveFolderBindingsForChatIds = async () => new Map(); const normalizeFolderBinding = (v) => v; const resolveFolderName = () => ''; const updateRowFolderBinding = () => {};
    const getEditOverride = () => null; const refreshReaderOverlay = () => {}; const syncReaderTopOffset = () => {}; const renderReaderRouteMeta = () => {}; const setActiveSidebarChat = () => {}; const syncSelectionControls = () => {}; const applyUiState = () => {}; const esc = (v) => String(v || '');
    const publishReaderTurnSelection = () => null; const __mountOverlayEditorOnTurn = () => {};
    ${READER_SEAMS.map((name) => extract(name)).join('\n')}
    const realBuild = buildReaderDOM;
    /* observe every real render through the real seam */
    const observedBuild = (snap, input) => { const root = realBuild(snap, input); renders.push({ snapshotId: String(snap?.snapshotId || ''), effectiveId: state.currentReaderRender?.presentation?.effectiveId || null, requestedId: state.currentReaderRender?.presentation?.requestedId, reason: state.currentReaderRender?.presentation?.reason, marker: root.getAttribute('data-h2o-presentation-profile') }); return root; };
    window.reader = {
      state, renders, hostState, snapshots,
      subscribe: subscribeReaderToPresentationPreference,
      refresh: refreshReaderPresentation,
      isCurrent: isReaderPresentationCurrent,
      render(id) { return renderReader(id); },
      leave(reason) { state.renderToken += 1; state.currentReaderSnapshot = null; studioHostUnmountPreservingRouteHash(reason || 'test:leave'); },
      idle: async () => { for (let i = 0; i < 20; i += 1) await new Promise((r) => setTimeout(r, 0)); },
      addSnapshot(id, snap) { snapshots.set(id, snap); },
      currentRoot: () => document.getElementById('viewReader').firstElementChild,
    };
    /* buildReaderDOM is called by name inside renderReader; rebind the observed wrapper on the same binding. */
    buildReaderDOM = observedBuild;
  })();`;
}

async function resolvePlaywright() {
  const override = process.env.H2O_PLAYWRIGHT_MODULE;
  try {
    if (override) {
      if (!fs.existsSync(override)) return null;
      const entry = fs.statSync(override).isDirectory() ? path.join(override, 'index.js') : override;
      const mod = await import(pathToFileURL(entry).href);
      return mod?.chromium || mod?.default?.chromium || null;
    }
    const mod = await import('playwright');
    return mod?.chromium || mod?.default?.chromium || null;
  } catch { return null; }
}

const chromium = await resolvePlaywright();
if (!chromium) {
  console.log('SKIP real-browser selector / Reader smoke unavailable (set H2O_PLAYWRIGHT_MODULE)');
  console.log('SKIP is not PASS: the New UI selector and Reader lifecycle were not inspected.');
  if (STRICT) { console.error('FAIL H2O_REQUIRE_PRESENTATION_REGISTRY_TIER2 is set'); process.exit(1); }
} else {
  const MIME = { '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css' };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    if (rel === '__selector__') {
      const seed = url.searchParams.get('seed'); const deferHydration = url.searchParams.get('defer') === '1'; const withRegistry = url.searchParams.get('registry') !== '0';
      const chain = withRegistry ? CHAIN : [];
      const links = ['studio.css', 'renderer/presentation/chatgpt-reference.v1.css', 'renderer/presentation/h2o-clean-reader.v1.css'].map((r) => `<link rel="stylesheet" href="./${r}">`).join('');
      /* Production order: the Appearance modules evaluate BEFORE the Renderer chain (studio.html). */
      const platform = `<script>window.H2O = { Studio: { platform: { env: { adapter: 'fake' }, storage: (() => { const seed = ${JSON.stringify(seed)}; const store = new Map(seed === null ? [] : [['${STORAGE_KEY}', seed]]); const writes = []; let release = null; const gate = ${deferHydration ? 'new Promise((resolve) => { release = resolve; })' : 'Promise.resolve()'}; window.__storage = { store, writes, release: () => release && release() }; return { get: (key) => gate.then(() => store.get(key)), set(key, value) { writes.push([key, value]); store.set(key, value); return Promise.resolve(); } }; })() } } };</script>`;
      const appearance = [KEYS_REL, STORE_REL, PANEL_REL].map((r) => `<script src="./${r}"></script>`).join('');
      /* minimal Shell: a header slot for the real trigger (laid out at the end like the production top bar) and the Reader pane */
      const shell = '<style>.wbTop{display:flex;justify-content:flex-end;padding:8px 12px}</style><header class="wbTop"></header><main class="wbMain"><div id="viewListPanel" hidden></div><section id="viewReader" class="wbReader" hidden></section></main>';
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`<!doctype html><meta charset="utf-8"><title>selector</title>${links}${platform}${appearance}<body data-route="reader">${shell}${chain.map((r) => `<script src="./${r}"></script>`).join('\n')}${withRegistry ? '<script src="./__reader_seams__.js"></script>' : ''}`);
      return;
    }
    if (rel === '__reader_seams__.js') { res.writeHead(200, { 'Content-Type': 'text/javascript' }); res.end(readerSeamsScript()); return; }
    const file = path.join(STUDIO, rel);
    if (!file.startsWith(STUDIO) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end('nf'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(fs.readFileSync(file));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch();

  async function openPage(query) {
    const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
    const errors = []; page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(`${base}/__selector__${query}`, { waitUntil: 'load' });
    return { page, errors };
  }
  const SNAPSHOT = { snapshotId: 'snap-A', chatId: 'chat-A', meta: { title: 'A' }, messages: [ { role: 'user', text: 'Question `q`', messageId: 'u1', turnId: 't1' }, { role: 'assistant', text: 'Answer\n\n```js\nlet a = 1;\n```', messageId: 'a1', turnId: 't1' } ] };

  /* ── panel: lazy list-derived row, selection, unknown value, isolation ── */
  const { page: panelPage, errors: panelErrors } = await openPage('');
  const panel = await panelPage.evaluate(async () => {
    const a = H2O.Studio.appearance; const pp = H2O.Studio.Renderer.presentationProfile;
    for (let i = 0; i < 20 && !a.isReady(); i += 1) await new Promise((r) => setTimeout(r, 5));
    /* lazy lookup: a profile registered AFTER the panel module installed but BEFORE the first open is enumerated. */
    pp.register({ id: 't4-late-registered', owner: 't4-test', version: '0.1.0', displayName: 'T4 late profile', provider: null, stylesheet: null, modes: ['canonical', 'rich'], hooks: { transcript: { canonical: [], rich: [] }, turn: { base: [], canonical: [], rich: [], role: { user: [], assistant: [], system: [], tool: [] } }, message: { canonical: { user: [], assistant: [], system: [], tool: [] }, rich: { user: [], assistant: [], system: [], tool: [] } }, userBubble: { compat: [] }, content: {}, state: { edited: { turn: [], message: [] } } } });
    const trigger = document.querySelector('.wbAppearanceBtn');
    const out = { ready: a.isReady(), triggerMounted: !!trigger && !!trigger.closest('.wbTop'), panelBeforeOpen: !!document.querySelector('.wbAppearancePanel') };
    a.panel.open();
    const sections = [...document.querySelectorAll('.wbAppearanceSection')].map((s) => s.querySelector('.wbAppearanceSectionTitle').textContent);
    const reading = [...document.querySelectorAll('.wbAppearanceSection')].find((s) => s.querySelector('.wbAppearanceSectionTitle').textContent === 'Reading');
    const rows = [...reading.querySelectorAll('.wbAppearanceSectionBody > *')].map((r) => r.querySelector('.wbAppearanceRowLabel')?.textContent || r.className);
    const group = reading.querySelector('.wbAppearanceSegmented[aria-label="Presentation"]');
    const buttons = () => [...group.querySelectorAll('.wbAppearanceSegmentedBtn')].map((b) => ({ value: b.getAttribute('data-value'), label: b.textContent, on: b.classList.contains('is-on'), pressed: b.getAttribute('aria-pressed') }));
    out.sections = sections; out.readingRows = rows; out.options = buttons(); out.registry = pp.list().map((p) => [p.id, p.displayName]);
    out.hint = group.parentElement.querySelector('.wbAppearanceRowHint')?.textContent;
    /* click the Clean Reader option through the real button */
    const events = []; a.subscribe((e) => events.push([e.type, e.key, e.value]));
    group.querySelector('[data-value="h2o-clean-reader"]').click();
    out.afterClick = { value: a.get('presentationProfile'), options: buttons(), events: events.slice() };
    /* unknown value set programmatically (e.g. hydrated from another install): preserved, no button on */
    a.set('presentationProfile', 'no-such-profile');
    out.unknown = { value: a.get('presentationProfile'), options: buttons() };
    a.set('presentationProfile', 'chatgpt-reference');
    out.back = buttons();
    /* the panel never registers / resolves: registry untouched, sealed state untouched */
    out.registryAfter = { ids: [...pp.ids()], sealed: pp.sealed() };
    await new Promise((r) => setTimeout(r, 300)); /* debounce flush */
    out.persisted = window.__storage.writes.filter(([k]) => k.endsWith('presentationProfile:v1')).map(([, v]) => v);
    window.__panelOut = out;
    return out;
  });
  await shot(panelPage, 't4-appearance-panel-presentation-row', '.wbAppearancePanel');
  panel.closed = await panelPage.evaluate(() => { H2O.Studio.appearance.panel.close(); return document.querySelector('.wbAppearancePanel').hasAttribute('hidden'); });
  await panelPage.close();
  const { page: noRegistryPage, errors: noRegistryErrors } = await openPage('?registry=0');
  const noRegistry = await noRegistryPage.evaluate(async () => {
    const a = H2O.Studio.appearance;
    for (let i = 0; i < 20 && !a.isReady(); i += 1) await new Promise((r) => setTimeout(r, 5));
    a.panel.open();
    const reading = [...document.querySelectorAll('.wbAppearanceSection')].find((s) => s.querySelector('.wbAppearanceSectionTitle').textContent === 'Reading');
    return { renderer: typeof H2O.Studio.Renderer, sections: [...document.querySelectorAll('.wbAppearanceSection')].length, readingRows: [...reading.querySelectorAll('.wbAppearanceSectionBody > *')].map((r) => r.querySelector('.wbAppearanceRowLabel')?.textContent), presentationRow: !!document.querySelector('.wbAppearanceSegmented[aria-label="Presentation"]'), themeButtons: document.querySelectorAll('.wbAppearanceSegmented[aria-label="Theme"] .wbAppearanceSegmentedBtn').length, toggles: document.querySelectorAll('.wbAppearanceRow--toggle').length, value: a.get('presentationProfile'), errors: a.selfCheck().errors };
  });
  await noRegistryPage.close();

  check('M04 P2 T4 (D): the real Appearance panel adds one lazy, list-derived Presentation row to the Reading section (id -> value, displayName -> label, late registrations included); clicking selects through the store', () => {
    assert.deepEqual(panelErrors, [], 'no page errors');
    assert.deepEqual({ ready: panel.ready, triggerMounted: panel.triggerMounted, panelBeforeOpen: panel.panelBeforeOpen }, { ready: true, triggerMounted: true, panelBeforeOpen: false }, 'trigger mounted in .wbTop; the panel is built lazily on first open');
    assert.deepEqual(panel.sections, ['Theme', 'Typography', 'Reading', 'Options'], 'existing sections preserved');
    assert.deepEqual(panel.readingRows, ['Font size', 'Text width', 'Presentation'], 'one Presentation row appended to Reading');
    assert.deepEqual(panel.registry, [['chatgpt-reference', 'ChatGPT reference presentation'], ['h2o-clean-reader', 'H2O Clean Reader'], ['t4-late-registered', 'T4 late profile']]);
    assert.deepEqual(panel.options, [{ value: 'chatgpt-reference', label: 'ChatGPT reference presentation', on: true, pressed: 'true' }, { value: 'h2o-clean-reader', label: 'H2O Clean Reader', on: false, pressed: 'false' }, { value: 't4-late-registered', label: 'T4 late profile', on: false, pressed: 'false' }], 'options are exactly presentationProfile.list() at construction, default pressed');
    assert.equal(panel.hint, 'Reader presentation profile');
    assert.deepEqual(panel.afterClick.value, 'h2o-clean-reader'); assert.deepEqual(panel.afterClick.options.map((o) => o.on), [false, true, false]); assert.deepEqual(panel.afterClick.events, [['change', 'presentationProfile', 'h2o-clean-reader']]);
    assert.deepEqual(panel.unknown, { value: 'no-such-profile', options: panel.unknown.options }, 'unknown value preserved'); assert.deepEqual(panel.unknown.options.map((o) => o.on), [false, false, false], 'no option pressed for an unknown preference');
    assert.deepEqual(panel.back.map((o) => o.on), [true, false, false]);
    assert.deepEqual(panel.registryAfter, { ids: ['chatgpt-reference', 'h2o-clean-reader', 't4-late-registered'], sealed: false }, 'the panel registers and resolves nothing');
    assert.deepEqual(panel.persisted, ['chatgpt-reference'], 'the debounced flush persists the latest verbatim value');
    assert.equal(panel.closed, true);
  });
  check('M04 P2 T4 (D): with the Renderer registry unavailable the Presentation row is omitted and the rest of the panel is intact', () => {
    assert.deepEqual(noRegistryErrors, [], 'no page errors');
    assert.deepEqual(noRegistry, { renderer: 'undefined', sections: 4, readingRows: ['Font size', 'Text width'], presentationRow: false, themeButtons: 3, toggles: 3, value: 'chatgpt-reference', errors: [] });
  });

  /* ── Reader: selector-driven lifecycle through the real seams ── */
  async function readerScenario(query, body, after = null) {
    const { page, errors } = await openPage(query);
    const result = await page.evaluate(body, SNAPSHOT);
    if (after) await after(page, result);
    await page.close();
    return { result, errors };
  }
  const flow = await readerScenario('', async (SNAP) => {
    const a = H2O.Studio.appearance; const r = window.reader; const pp = H2O.Studio.Renderer.presentationProfile;
    for (let i = 0; i < 20 && !a.isReady(); i += 1) await new Promise((r2) => setTimeout(r2, 5));
    r.addSnapshot('snap-A', SNAP);
    r.subscribe(); r.subscribe();
    const out = { subscribed: typeof r.state.readerPresentationUnsubscribe, sealedBefore: pp.sealed() };
    await r.render('snap-A'); await r.idle();
    const root1 = r.currentRoot();
    out.first = { marker: root1.getAttribute('data-h2o-presentation-profile'), renders: r.renders.slice(), sealedAfter: pp.sealed(), userClass: root1.querySelector('.cgMsg[data-message-author-role="user"]').className, bound: r.state.currentReaderRender.root === root1, descriptor: r.state.currentReaderRender.presentation.effectiveId };
    /* same effective configuration: equivalent refresh reuses */
    await r.render('snap-A'); await r.idle();
    out.reuse = { sameRoot: r.currentRoot() === root1, renders: r.renders.length, mounts: r.hostState.mountCount };
    /* New UI selection through the real panel button */
    a.panel.open();
    document.querySelector('.wbAppearanceSegmented[aria-label="Presentation"] [data-value="h2o-clean-reader"]').click();
    a.panel.close();
    await r.idle();
    const root2 = r.currentRoot();
    out.selectClean = { marker: root2.getAttribute('data-h2o-presentation-profile'), newRoot: root2 !== root1, oldDetached: !root1.isConnected, renders: r.renders.slice(1), mounts: r.hostState.mountCount, unmounts: r.hostState.unmountCount, userClass: root2.querySelector('.cgMsg[data-message-author-role="user"]').className, code: root2.querySelector('.cgMsgBody pre').parentElement.className, rootsInReader: document.getElementById('viewReader').children.length, bound: r.state.currentReaderRender.root === root2 && r.state.currentReaderRender.presentation.effectiveId === 'h2o-clean-reader', userBlockRadius: getComputedStyle(root2.querySelector('.cgMsg[data-message-author-role="user"]')).borderTopLeftRadius };
    /* committed A -> B -> A: back to the reference rebuilds again, never the cached first root */
    a.set('presentationProfile', 'chatgpt-reference'); await r.idle();
    const root3 = r.currentRoot();
    out.backToReference = { marker: root3.getAttribute('data-h2o-presentation-profile'), fresh: root3 !== root1 && root3 !== root2, renders: r.renders.length, mounts: r.hostState.mountCount };
    /* rapid A -> B -> A before B commits */
    a.set('presentationProfile', 'h2o-clean-reader'); a.set('presentationProfile', 'chatgpt-reference'); await r.idle();
    out.rapid = { sameRoot: r.currentRoot() === root3, renders: r.renders.length, mounts: r.hostState.mountCount, marker: r.currentRoot().getAttribute('data-h2o-presentation-profile') };
    /* unknown preference resolving to the mounted configuration reuses; requested id is preserved by the store */
    a.set('presentationProfile', 'no-such-profile'); await r.idle();
    out.unknown = { sameRoot: r.currentRoot() === root3, renders: r.renders.length, stored: a.get('presentationProfile'), current: r.isCurrent('no-such-profile') };
    /* route leave: cleanup, then a change renders nothing */
    r.leave('test:leave'); await r.idle();
    a.set('presentationProfile', 'h2o-clean-reader'); await r.idle();
    out.leave = { readerChildren: document.getElementById('viewReader').children.length, binding: r.state.currentReaderRender, renders: r.renders.length, unmounts: r.hostState.unmountCount };
    /* reopen: the preference in force selects the profile of the first render */
    await r.render('snap-A'); await r.idle();
    out.reopen = { marker: r.currentRoot().getAttribute('data-h2o-presentation-profile'), reason: r.renders[r.renders.length - 1].reason, renders: r.renders.length };
    r.state.readerPresentationUnsubscribe();
    a.set('presentationProfile', 'chatgpt-reference'); await r.idle();
    out.unsubscribed = { renders: r.renders.length };
    return out;
  }, async (page) => {
    if (!SHOTS_DIR) return;
    /* the scenario ended by unsubscribing; re-arm the application-lifetime subscription for the visible run */
    await page.evaluate(async () => { const a = H2O.Studio.appearance; const r = window.reader; r.state.readerPresentationUnsubscribe = null; r.subscribe(); a.set('presentationProfile', 'chatgpt-reference'); await r.render('snap-A'); await r.idle(); });
    await shot(page, 't4-reader-reference-selected', '#viewReader');
    await page.evaluate(async () => { const a = H2O.Studio.appearance; const r = window.reader; a.panel.open(); document.querySelector('.wbAppearanceSegmented[aria-label="Presentation"] [data-value="h2o-clean-reader"]').click(); await r.idle(); });
    await shot(page, 't4-reader-clean-reader-selected-panel-open');
    await page.evaluate(() => H2O.Studio.appearance.panel.close());
    await shot(page, 't4-reader-clean-reader-selected', '#viewReader');
  });
  check('M04 P2 T4 (C): the real New UI selector drives the real Reader seams and Renderer — first render sealed under the current preference, equivalent reuse, Clean Reader selection rebuilds, committed A -> B -> A rebuilds twice, rapid bounce keeps A, unknown preference reuses, route leave cleans up', () => {
    assert.deepEqual(flow.errors, [], 'no page errors');
    const f = flow.result;
    assert.deepEqual({ subscribed: f.subscribed, sealedBefore: f.sealedBefore, sealedAfter: f.first.sealedAfter }, { subscribed: 'function', sealedBefore: false, sealedAfter: true }, 'one subscription; the first Reader render seals the registries');
    assert.deepEqual({ marker: f.first.marker, descriptor: f.first.descriptor, bound: f.first.bound, userClass: f.first.userClass, renders: f.first.renders.map((x) => [x.effectiveId, x.reason]) }, { marker: 'chatgpt-reference', descriptor: 'chatgpt-reference', bound: true, userClass: 'cgMsg cgMsg--user', renders: [['chatgpt-reference', 'explicit']] }, 'the default preference renders the reference profile explicitly');
    assert.deepEqual(f.reuse, { sameRoot: true, renders: 1, mounts: 1 }, 'same effective configuration reuses the mounted transcript');
    assert.deepEqual({ marker: f.selectClean.marker, newRoot: f.selectClean.newRoot, oldDetached: f.selectClean.oldDetached, renders: f.selectClean.renders.map((x) => x.effectiveId), mounts: f.selectClean.mounts, unmounts: f.selectClean.unmounts, userClass: f.selectClean.userClass, code: f.selectClean.code, rootsInReader: f.selectClean.rootsInReader, bound: f.selectClean.bound, userBlockRadius: f.selectClean.userBlockRadius }, { marker: 'h2o-clean-reader', newRoot: true, oldDetached: true, renders: ['h2o-clean-reader'], mounts: 2, unmounts: 1, userClass: 'cgMsg', code: 'h2oCleanCode', rootsInReader: 1, bound: true, userBlockRadius: '12px' }, 'selecting H2O Clean Reader in the panel disposes and rebuilds the open Reader under the new profile with its stylesheet applied');
    assert.deepEqual(f.backToReference, { marker: 'chatgpt-reference', fresh: true, renders: 3, mounts: 3 }, 'committed A -> B -> A rebuilds twice; no old-root cache');
    assert.deepEqual(f.rapid, { sameRoot: true, renders: 3, mounts: 3, marker: 'chatgpt-reference' }, 'rapid A -> B -> A before B commits: A stays, B never installs');
    assert.deepEqual(f.unknown, { sameRoot: true, renders: 3, stored: 'no-such-profile', current: true }, 'an unknown preference resolving to the mounted reference reuses; the raw choice is preserved by the store');
    assert.deepEqual(f.leave, { readerChildren: 0, binding: null, renders: 3, unmounts: 3 }, 'route leave disposes; a later change renders nothing');
    assert.deepEqual(f.reopen, { marker: 'h2o-clean-reader', reason: 'explicit', renders: 4 }, 'reopening renders under the preference in force');
    assert.deepEqual(f.unsubscribed, { renders: 4 }, 'the retained handle unsubscribes');
  });

  const hydrationDifferent = await readerScenario('?seed=h2o-clean-reader&defer=1', async (SNAP) => {
    const a = H2O.Studio.appearance; const r = window.reader;
    r.addSnapshot('snap-A', SNAP); r.subscribe();
    await r.render('snap-A'); await r.idle();
    const root1 = r.currentRoot();
    const before = { ready: a.isReady(), marker: root1.getAttribute('data-h2o-presentation-profile'), renders: r.renders.length };
    window.__storage.release(); /* hydration completes now: ready */
    for (let i = 0; i < 40 && !a.isReady(); i += 1) await new Promise((r2) => setTimeout(r2, 5));
    await r.idle();
    return { before, after: { ready: a.isReady(), value: a.get('presentationProfile'), marker: r.currentRoot().getAttribute('data-h2o-presentation-profile'), rebuilt: r.currentRoot() !== root1, renders: r.renders.map((x) => x.effectiveId), mounts: r.hostState.mountCount } };
  });
  const hydrationSame = await readerScenario('?seed=chatgpt-reference&defer=1', async (SNAP) => {
    const a = H2O.Studio.appearance; const r = window.reader;
    r.addSnapshot('snap-A', SNAP); r.subscribe();
    await r.render('snap-A'); await r.idle();
    const root1 = r.currentRoot();
    window.__storage.release();
    for (let i = 0; i < 40 && !a.isReady(); i += 1) await new Promise((r2) => setTimeout(r2, 5));
    await r.idle();
    return { ready: a.isReady(), sameRoot: r.currentRoot() === root1, renders: r.renders.length, mounts: r.hostState.mountCount };
  });
  const hydrationUnknown = await readerScenario('?seed=no-such-profile', async (SNAP) => {
    const a = H2O.Studio.appearance; const r = window.reader;
    for (let i = 0; i < 20 && !a.isReady(); i += 1) await new Promise((r2) => setTimeout(r2, 5));
    r.addSnapshot('snap-A', SNAP); r.subscribe();
    await r.render('snap-A'); await r.idle();
    a.panel.open();
    const pressed = [...document.querySelectorAll('.wbAppearanceSegmented[aria-label="Presentation"] .wbAppearanceSegmentedBtn')].map((b) => b.classList.contains('is-on'));
    await new Promise((r2) => setTimeout(r2, 300));
    return { value: a.get('presentationProfile'), render: r.renders[0], pressed, writes: window.__storage.writes.length };
  });
  check('M04 P2 T4 (C): hydration to a different persisted profile refreshes the open Reader once; hydration to the same profile never rebuilds; an unknown persisted id renders the reference fallback while the raw choice is kept and nothing is written back', () => {
    assert.deepEqual(hydrationDifferent.errors, []); assert.deepEqual(hydrationSame.errors, []); assert.deepEqual(hydrationUnknown.errors, []);
    assert.deepEqual(hydrationDifferent.result.before, { ready: false, marker: 'chatgpt-reference', renders: 1 }, 'rendered before hydration with the default');
    assert.deepEqual(hydrationDifferent.result.after, { ready: true, value: 'h2o-clean-reader', marker: 'h2o-clean-reader', rebuilt: true, renders: ['chatgpt-reference', 'h2o-clean-reader'], mounts: 2 }, 'ready with a different hydrated profile -> guarded refresh');
    assert.deepEqual(hydrationSame.result, { ready: true, sameRoot: true, renders: 1, mounts: 1 }, 'ready with the same effective profile -> no rebuild');
    assert.deepEqual({ value: hydrationUnknown.result.value, effectiveId: hydrationUnknown.result.render.effectiveId, requestedId: hydrationUnknown.result.render.requestedId, reason: hydrationUnknown.result.render.reason, pressed: hydrationUnknown.result.pressed, writes: hydrationUnknown.result.writes }, { value: 'no-such-profile', effectiveId: 'chatgpt-reference', requestedId: 'no-such-profile', reason: 'unknown-profile-fallback', pressed: [false, false], writes: 0 }, 'Renderer fallback, Reader preference preserved, no persisted effective fallback');
  });

  await browser.close();
  server.close();
}

console.log(failures.length ? `FAIL ${failures.length} (passed ${checks.length})` : `PASS ${checks.length}`);
process.exit(failures.length ? 1 : 0);
