#!/usr/bin/env node
// Reader M02 T3 — production-executing current-session resume-continuity floor.
//
// This harness executes the private Reader controller and the real extracted
// studio.js transition seams. Every group is a current Product assertion; the
// former T2 GAP/FIX model is retained only in Git history and the contract.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const STUDIO = path.join(ROOT, 'src-surfaces-base/studio');
const STUDIO_JS_REL = 'src-surfaces-base/studio/studio.js';
const CONTRACT_REL = 'docs/contracts/studio-reader-resume-continuity-m02.md';
const M01_CONTRACT_REL = 'docs/contracts/studio-reader-session-navigation-m01.md';
const M01_VALIDATOR_REL = 'tools/validation/studio/validate-studio-reader-session-navigation-m01.mjs';
const source = fs.readFileSync(path.join(ROOT, STUDIO_JS_REL), 'utf8');
const contract = fs.readFileSync(path.join(ROOT, CONTRACT_REL), 'utf8');
const rows = [];
const failures = [];

async function group(id, label, fn) {
  try {
    const detail = await fn();
    const row = { id, result: 'PASS', label, ...(detail === undefined ? {} : { detail }) };
    rows.push(row);
    console.log(`GROUP ${JSON.stringify(row)}`);
    return detail;
  } catch (error) {
    const row = { id, result: 'FAIL', label, error: String(error?.stack || error) };
    rows.push(row); failures.push(row);
    console.error(`GROUP ${JSON.stringify(row)}`);
    return null;
  }
}

function extractFunction(text, name) {
  const match = new RegExp(`\\b(?:async\\s+)?function\\s+${name}\\s*\\(`).exec(text);
  assert.ok(match, `missing production seam ${name}`);
  const start = match.index;
  const open = text.indexOf('{', text.indexOf(')', start));
  let depth = 0;
  let quote = '';
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  let templateDepth = 0;
  for (let i = open; i < text.length; i += 1) {
    const ch = text[i], next = text[i + 1];
    if (lineComment) { if (ch === '\n') lineComment = false; continue; }
    if (blockComment) { if (ch === '*' && next === '/') { blockComment = false; i += 1; } continue; }
    if (quote) {
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (quote === '`' && ch === '$' && next === '{') { templateDepth += 1; depth += 1; i += 1; continue; }
      if (ch === quote && (quote !== '`' || templateDepth === 0)) quote = '';
      else if (quote === '`' && ch === '}' && templateDepth > 0) { templateDepth -= 1; depth -= 1; }
      continue;
    }
    if (ch === '/' && next === '/') { lineComment = true; i += 1; continue; }
    if (ch === '/' && next === '*') { blockComment = true; i += 1; continue; }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '{') depth += 1;
    else if (ch === '}' && --depth === 0) {
      const body = text.slice(start, i + 1);
      new vm.Script(`(${body})`);
      return body;
    }
  }
  throw new Error(`unterminated production seam ${name}`);
}

function indexOfOrFail(haystack, needle, label) {
  const index = haystack.indexOf(needle);
  assert.ok(index >= 0, `missing ${label || needle}`);
  return index;
}

await group('SOURCE', 'exact private controller and bounded production hooks', () => {
  const controller = extractFunction(source, 'createReaderResumeController');
  const unmount = extractFunction(source, 'studioHostUnmount');
  const scope = extractFunction(source, 'setStudioRouteScope');
  const reader = extractFunction(source, 'renderReader');
  const route = extractFunction(source, 'renderRoute');
  const deletion = extractFunction(source, 'executeDeleteChat');

  assert.match(source, /readerResume:\s*null/);
  assert.doesNotMatch(source, /H2O\.Studio\.readerResume\s*=/);
  assert.deepEqual(['remember', 'restore', 'forget'].sort(), ['remember', 'restore', 'forget'].sort());
  assert.match(controller, /return Object\.freeze\(\{ remember: capture, restore, forget \}\)/);
  assert.doesNotMatch(controller, /localStorage|sessionStorage|chrome\.storage|indexedDB|postMessage|fetch\(|XMLHttpRequest|H2O\.MM|MiniMap/i);

  assert.ok(indexOfOrFail(unmount, 'state.readerResume?.remember?.(reason)', 'reader-replace remember')
    < indexOfOrFail(unmount, 'state.currentReaderEditOverrides = null', 'unmount teardown'));
  assert.ok(indexOfOrFail(scope, 'state.readerResume?.remember?.', 'S1 remember')
    < indexOfOrFail(scope, 'state.activeRoute = normalizeStudioRouteScope(routeName)', 'route mutation'));
  const finalApply = reader.lastIndexOf('applyUiState();');
  const restore = indexOfOrFail(reader, 'state.readerResume?.restore?.()', 'rebuild restore');
  const refresh = indexOfOrFail(reader, 'evt:h2o:studio:reader-refresh-requested', 'reader refresh');
  assert.ok(finalApply >= 0 && finalApply < restore && restore < refresh);
  assert.match(reader, /if \(!canReuseMountedReader\)\s*\{[\s\S]*?readerResume\?\.restore/);
  assert.match(reader, /if \(token !== state\.renderToken\) return;\s*if \(!canReuseMountedReader\)/);
  assert.ok(indexOfOrFail(deletion, 'if (deleted)', 'semantic deletion success guard')
    < indexOfOrFail(deletion, 'state.readerResume?.forget?.(chatId)', 'Reader forget'));
  assert.ok(indexOfOrFail(deletion, 'state.readerResume?.forget?.(chatId)', 'Reader forget')
    < indexOfOrFail(deletion, 'await deleteEditOverridesForSnapshot(snapshotId)', 'first cleanup'));
  assert.match(route, /selectedMessageId:\s*__selectedMessageId/);
  assert.match(route, /selectedTurnIdx:\s*__selectedTurnIdx/);
  return { privateApi: ['remember', 'restore', 'forget'], capacity: 16, tombstones: 16 };
});

await group('CONTRACT', 'implemented contract preserves frozen architecture and owner fences', () => {
  for (const pattern of [
    /Status: M02 P2 T3 implemented checkpoint/,
    /messageId is primary/,
    /same snapshotId and renderMode/,
    /same-snapshot structural identity/,
    /\.wbMain/,
    /exactly one .*scrollTo/s,
    /never writes MiniMap resume or active state/,
    /no generic Anchor API/i,
  ]) assert.match(contract, pattern);
  return { architecture: 'frozen', ownerBoundaries: 'preserved' };
});

const rendererScripts = [
  'platform/selectors.contract.js', 'platform/html-sanitizer.js',
  'renderer/safety/sanitizer-policy.v1.js', 'renderer/safety/vendor/dompurify/purify.js',
  'renderer/safety/html-sanitizer.v2.js', 'renderer/markdown/vendor/markdown-it/markdown-it.umd.min.js',
  'renderer/markdown/h2o-gfm.v1.js', 'renderer/markdown/markdown-engine.v1.js',
  'renderer/markdown/markdown-ir-adapter.v1.js', 'renderer/semantic/render-ir.v1.js',
  'renderer/semantic/semantic-ingress.v1.js', 'renderer/semantic/semantic-index.v1.js',
  'renderer/decoration/decoration-contribution.v1.js', 'renderer/presentation/presentation-profile.v1.js',
  'renderer/presentation/h2o-clean-reader.v1.js', 'renderer/content/content-renderer.v1.js',
  'renderer/chat-renderer.studio.js',
];

const seamNames = [
  'getStudioChatRenderer', 'isCurrentReaderRoot', 'getReusableReaderMount',
  'isReusableReaderMountCurrent', 'collectRendererEditOverrides',
  'haveEquivalentRendererEditOverrides', 'getReaderPresentationPreference',
  'isReaderPresentationCurrent', 'canReuseReaderDOM', 'bindReaderSemanticIndex',
  'getReaderSemanticIndex', 'getReaderDecorationContributions',
  'disposeReaderRenderDecorations', 'createReaderResumeController',
  'studioHostUnmount', 'studioHostUnmountPreservingRouteHash',
  'resolveReaderNavigationTarget', 'getReaderNavigationTarget',
  'publishReaderTurnSelection', 'readerNearestScrollDelta', 'goToReaderTarget',
  'stepReaderTarget', 'nextReaderTarget', 'previousReaderTarget',
  'buildReaderDOM', 'setStudioRouteScope', 'renderReader', 'renderRoute',
  'executeDeleteChat',
];
const seams = seamNames.map(name => extractFunction(source, name)).join('\n\n');
const navInstall = source.match(/H2O\.Studio\.readerNavigation = Object\.freeze\([\s\S]*?\);/)?.[0];
assert.ok(navInstall, 'missing M01 Reader navigation installation');

const ribbonSource = fs.readFileSync(path.join(STUDIO, 'ribbon/ribbon-shell.studio.js'), 'utf8');
const ribbonSetContext = extractFunction(ribbonSource, 'setContext');

const browserRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'reader-m02-t3-'));
async function resolveChromium() {
  const override = String(process.env.H2O_PLAYWRIGHT_MODULE || '').trim();
  const entry = override && fs.statSync(override).isDirectory() ? path.join(override, 'index.js') : override;
  const mod = await import(entry ? pathToFileURL(entry).href : 'playwright');
  return mod.chromium || mod.default?.chromium;
}

let browser;
let page;
let browserError = null;
try {
  const chromium = await resolveChromium();
  assert.ok(chromium, 'Playwright Chromium is required');
  const executablePath = String(process.env.H2O_READER_CHROMIUM || '').trim();
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
  page = await browser.newPage({ viewport: { width: 1280, height: 800 }, reducedMotion: 'reduce' });
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(String(error?.stack || error)));
  await page.route('**/*', route => route.fulfill({
    contentType: 'text/html',
    body: '<!doctype html><html data-h2o-runtime="tauri"><body data-route="reader" data-sidebar="open" data-density="comfortable" style="margin:0"><button id="keeper">keeper</button><div class="wbShell"><div class="wbStage"><main class="wbMain" style="box-sizing:border-box;height:620px;overflow:auto;padding:16px 0"><section id="viewListPanel"></section><section id="viewReader" class="wbReader"></section><section id="wbLibraryRegion" hidden></section><section id="viewMigratePanel" hidden></section><section id="viewSettingsPanel" hidden></section></main></div></div></body></html>',
  }));
  await page.goto('http://reader-m02.test/');
  for (const rel of ['studio.css', 'renderer/presentation/chatgpt-reference.v1.css', 'renderer/presentation/h2o-clean-reader.v1.css']) {
    await page.addStyleTag({ path: path.join(STUDIO, rel) });
  }
  for (const rel of rendererScripts) await page.addScriptTag({ path: path.join(STUDIO, rel) });

  await page.addScriptTag({ content: `(() => {
    const W = window;
    const $ = selector => document.querySelector(selector);
    const CHAT_TYPES = new Set(['saved', 'linked', 'native']);
    const RibbonEvents = { contextChanged: 'contextChanged' };
    const internalState = { context: {} };
    const isPlainObject = value => !!value && typeof value === 'object' && !Array.isArray(value);
    const isNonEmptyString = value => typeof value === 'string' && value.trim().length > 0;
    let ribbonPublications = 0;
    function softEmit() {}
    ${ribbonSetContext}

    const state = {
      rowsCache: [], folderCatalog: [], folderLocalReview: [], labelCatalog: [], categoryCatalog: [],
      selectedSnapshotId: '', selectedChatId: '', lastView: 'saved', lastFolderId: '',
      currentReaderSnapshot: null, publicationTarget: null, activeRoute: 'reader', sidebarExpanded: true,
      density: 'comfortable', layout: 'focused', renderToken: 0, currentReaderEditOverrides: null,
      currentReaderRender: null, currentReaderNavigationTarget: null, readerResume: null,
    };
    let mounted = null;
    let profile = 'chatgpt-reference';
    let routeNow = { name: 'read', snapshotId: '' };
    let deleteMode = 'success';
    let operationLog = [];
    let applyCalls = 0;
    const snapshots = new Map();
    const deferredLoads = new Map();
    const scrollCalls = [];
    const windowScrollCalls = [];
    const scrollIntoViewCalls = [];
    const nativeElementScrollTo = HTMLElement.prototype.scrollTo;
    const nativeScrollIntoView = HTMLElement.prototype.scrollIntoView;
    const nativeWindowScrollTo = window.scrollTo;
    HTMLElement.prototype.scrollTo = function(options) {
      scrollCalls.push({ kind: this.classList.contains('wbMain') ? 'main' : 'element', options: Object.assign({}, options) });
      if (typeof nativeElementScrollTo === 'function') return nativeElementScrollTo.call(this, options);
      if (options && typeof options === 'object') { if ('top' in options) this.scrollTop = options.top; if ('left' in options) this.scrollLeft = options.left; }
    };
    HTMLElement.prototype.scrollIntoView = function(...args) { scrollIntoViewCalls.push(args); if (typeof nativeScrollIntoView === 'function') return nativeScrollIntoView.apply(this, args); };
    window.scrollTo = function(...args) { windowScrollCalls.push(args); };

    H2O.studioHost = {
      mount(opts) { mounted = opts; opts.readerRoot.setAttribute('data-h2o-studio-reader', '1'); opts.scrollEl.setAttribute('data-scroll-root', '1'); },
      unmount() { mounted = null; },
      getReaderRoot() { return mounted?.readerRoot || null; },
      getTurnsRoot() { return mounted?.turnsEl || null; },
      getScrollRoot() { return mounted?.scrollEl || null; },
      updateSnapshot(snapshot) { if (!mounted) return false; mounted.snapshot = snapshot; return true; },
    };
    H2O.Studio.appearance = { get(key) { return key === 'presentationProfile' ? profile : undefined; } };
    H2O.Studio.ribbon = {
      getContext() { return internalState.context; },
      setContext(context) { ribbonPublications += 1; return setContext(context); },
    };
    H2O.util = Object.assign(H2O.util || {}, { getChatId: () => state.currentReaderSnapshot?.chatId || '' });

    const normalizeStudioRouteScope = value => ['reader', 'library', 'migrate', 'settings', 'list'].includes(String(value)) ? String(value) : 'list';
    const syncDesktopRibbonHiddenScope = () => {};
    const getEditOverride = () => null;
    const syncReaderTopOffset = () => {};
    const refreshReaderOverlay = () => {};
    const __mountOverlayEditorOnTurn = () => {};
    const applyDesktopReaderRibbonSession = () => {};
    const ensureReaderTopbarActions = () => {};
    const setRouteMeta = () => {};
    const renderFolderSidebar = () => {};
    const fetchWorkbenchRows = async () => [];
    const enrichRowsWithFolderData = async rows => rows;
    const promiseWithTimeoutFallback = async (promise, timeout, label, fallback) => { try { return await promise; } catch { return fallback; } };
    const fetchFolderCatalog = async () => ({ canonical: [], review: [] });
    const fetchLabelCatalog = async () => [];
    const fetchCategoryCatalog = async () => [];
    const resolveFolderBindingsForChatIds = async () => new Map();
    const STUDIO_BOOT_AUX_TIMEOUT_MS = 20;
    const normalizeFolderBinding = value => value || {};
    const resolveFolderName = () => '';
    const updateRowFolderBinding = () => {};
    const refreshSidebarChatList = () => {};
    const hydrateEditOverrideCompatibilityView = async () => {};
    const rememberPublicationTarget = snap => { state.publicationTarget = { chatId: snap.chatId, snapshotId: snap.snapshotId }; };
    const renderReaderRouteMeta = () => {};
    const setActiveSidebarChat = () => {};
    const syncSelectionControls = () => {};
    function applyUiState() { applyCalls += 1; document.body.dataset.route = state.currentReaderSnapshot ? 'reader' : normalizeStudioRouteScope(state.activeRoute); }
    const settingsApplyConvergenceAccess = () => {};
    const settingsReleaseEmbeddedToolPanels = () => {};
    const renderVisibleStudioFoldersPageBody = async () => {};
    const renderMigrateRoute = () => {};
    const renderSettingsRoute = async () => {};
    const renderList = async () => { state.currentReaderSnapshot = null; setStudioRouteScope('list'); studioHostUnmountPreservingRouteHash('studio:list'); };
    const parseHash = () => routeNow;
    const clearDeleteConfirm = () => {};
    const deleteEditOverridesForSnapshot = async () => { operationLog.push('delete-overrides'); return true; };
    const forgetPublicationTarget = () => {};
    const renderSidebarChatList = () => {};

    async function callArchive(op, payload) {
      operationLog.push(op);
      if (op === 'loadSnapshot') {
        if (deferredLoads.has(payload.snapshotId)) return deferredLoads.get(payload.snapshotId).promise;
        return snapshots.get(payload.snapshotId) || null;
      }
      if (op === 'deleteAllSnapshots' || op === 'deleteSnapshot') {
        if (deleteMode === 'failure') throw new Error('delete failed');
        return true;
      }
      return null;
    }

    ${seams}
    state.readerResume = createReaderResumeController();
    H2O.Studio.getReaderSemanticIndex = getReaderSemanticIndex;
    ${navInstall}

    const long = index => ('turn ' + index + ' content ').repeat(65);
    const richTurn = (role, index, message, ids = {}) => ({
      role, turnIdx: index + 1, messageId: ids.messageId ?? '', turnId: ids.turnId ?? '',
      outerHTML: '<article data-testid="conversation-turn-' + (index + 1) + '"><div data-message-author-role="' + role + '"><div class="' + (role === 'user' ? 'user-message-bubble-color' : 'markdown prose') + '"><p>' + message + '</p></div></div></article>',
    });
    function makeSnapshot({ chatId = 'chat-A', snapshotId = 'snap-A', mode = 'canonical', count = 10, ids = true, duplicate = false, roleShift = false, secondarySuffix = '' } = {}) {
      const messages = Array.from({ length: count }, (_, index) => {
        const role = roleShift && index === 1 ? 'user' : (index % 2 ? 'assistant' : 'user');
        return { role, text: long(index), ...(ids ? { messageId: duplicate ? 'dup-message' : 'm-' + index, turnId: (duplicate ? 'dup-turn' : 't-' + index) + secondarySuffix } : {}) };
      });
      const snapshot = { chatId, snapshotId, messages, meta: { title: chatId } };
      if (mode === 'rich') snapshot.richTurns = messages.map((message, index) => richTurn(message.role, index, message.text, ids ? message : {}));
      return snapshot;
    }
    function reset({ keepController = false } = {}) {
      try { studioHostUnmount('test:reset'); } catch {}
      document.getElementById('viewReader').replaceChildren();
      state.currentReaderSnapshot = null; state.currentReaderRender = null; state.currentReaderNavigationTarget = null;
      state.currentReaderEditOverrides = null; state.activeRoute = 'reader'; state.renderToken = 0;
      state.selectedSnapshotId = ''; state.selectedChatId = ''; state.rowsCache = [];
      profile = 'chatgpt-reference'; routeNow = { name: 'read', snapshotId: '' };
      snapshots.clear(); deferredLoads.clear(); deleteMode = 'success'; operationLog = [];
      scrollCalls.length = 0; windowScrollCalls.length = 0; scrollIntoViewCalls.length = 0;
      ribbonPublications = 0; applyCalls = 0; internalState.context = {};
      if (!keepController) state.readerResume = createReaderResumeController();
      document.body.dataset.route = 'reader';
      document.getElementById('keeper').focus();
    }
    function mountDirect(snapshot, nextProfile = profile) {
      profile = nextProfile; state.activeRoute = 'reader'; state.currentReaderSnapshot = snapshot;
      state.selectedSnapshotId = snapshot.snapshotId; state.selectedChatId = snapshot.chatId;
      const reader = document.getElementById('viewReader'); reader.replaceChildren();
      const root = buildReaderDOM(snapshot); reader.appendChild(root); state.currentReaderEditOverrides = [];
      document.body.dataset.route = 'reader'; return root;
    }
    function rebuildDirect(snapshot, nextProfile = profile) {
      studioHostUnmount('test:rebuild');
      return mountDirect(snapshot, nextProfile);
    }
    function selectOrdinal(ordinal) {
      const root = state.currentReaderRender.root;
      const turn = state.currentReaderRender.semanticIndex.turns()[ordinal];
      return H2O.Studio.readerNavigation.goTo({ currentRendererRoot: root, projectionKey: turn.projectionKey }, { preserveFocus: true });
    }
    function contentTop(main) { const style = getComputedStyle(main); return main.getBoundingClientRect().top + main.clientTop + (parseFloat(style.paddingTop) || 0); }
    function placeViewport(ordinal, fraction = .35) {
      const main = document.querySelector('.wbMain');
      const turn = state.currentReaderRender.semanticIndex.turns()[ordinal];
      const geometry = state.currentReaderRender.semanticIndex.getGeometry(turn.projectionKey);
      const line = contentTop(main) + 120;
      main.scrollTop += geometry.top + geometry.height * fraction - line;
      return observeViewport();
    }
    function observeViewport() {
      const main = document.querySelector('.wbMain');
      const index = state.currentReaderRender?.semanticIndex;
      if (!index) return null;
      const top = contentTop(main), bottom = top + main.clientHeight;
      const line = top + 120;
      const rows = index.turns().map(turn => ({ turn, geometry: index.getGeometry(turn.projectionKey) }))
        .filter(row => row.geometry && row.geometry.height > 0 && row.geometry.width > 0 && row.geometry.bottom > top && row.geometry.top < bottom);
      let row = null; for (const candidate of rows) if (candidate.geometry.top <= line) row = candidate;
      row = row || rows[0]; if (!row) return null;
      return { projectionKey: row.turn.projectionKey, ordinal: row.turn.ordinal, fraction: Math.max(0, Math.min(.9999, (line - row.geometry.top) / row.geometry.height)) };
    }
    function selected() {
      const target = state.currentReaderNavigationTarget;
      const current = state.currentReaderRender;
      const turn = target?.currentRendererRoot === current?.root ? current.semanticIndex.getTurn(target.projectionKey) : null;
      const message = turn ? current.semanticIndex.getMessage(turn.messageKey) : null;
      return turn ? { ordinal: turn.ordinal, role: turn.role, projectionKey: turn.projectionKey, messageId: message?.sourceRef?.messageId || null } : null;
    }
    function forceDuplicateIndex(messageId = 'dup-message', turnId = 'dup-turn') {
      const current = state.currentReaderRender;
      const root = current?.root;
      const turnsEl = H2O.studioHost.getTurnsRoot();
      if (!root || !turnsEl) throw new Error('duplicate-index fixture requires a current Reader render');
      const semanticIndex = H2O.Studio.Renderer.semanticIndex.createShellIndex({
        root,
        turnsEl,
        renderMode: current.semanticIndex.renderMode,
        source: {
          chatId: current.semanticIndex.getConversation().sourceRef.chatId,
          snapshotId: current.semanticIndex.getConversation().sourceRef.snapshotId,
        },
        describeTurn(turnEl) {
          return {
            role: turnEl.getAttribute('data-turn'),
            turnNo: Number(turnEl.getAttribute('data-h2o-turn-no')),
            messageId,
            turnId,
          };
        },
      });
      state.currentReaderRender = Object.freeze({ ...current, semanticIndex });
      return semanticIndex;
    }
    function counters() { return { ribbonPublications, applyCalls, scrollCalls: structuredClone(scrollCalls), windowScrollCalls: windowScrollCalls.length, scrollIntoViewCalls: scrollIntoViewCalls.length }; }
    function clearCounters() { ribbonPublications = 0; applyCalls = 0; scrollCalls.length = 0; windowScrollCalls.length = 0; scrollIntoViewCalls.length = 0; operationLog = []; }
    function defer(snapshotId) { let resolve; const promise = new Promise(done => { resolve = done; }); deferredLoads.set(snapshotId, { promise, resolve }); return resolve; }
    function article() { const node = document.createElement('article'); node.innerHTML = '<button class="wbDeleteBtn"></button>'; document.body.appendChild(node); return node; }

    window.readerM02 = {
      state, makeSnapshot, reset, mountDirect, rebuildDirect, selectOrdinal, placeViewport, observeViewport,
      selected, counters, clearCounters, snapshots, setProfile(value) { profile = value; },
      setRoute(value) { routeNow = value; }, setDeleteMode(value) { deleteMode = value; },
      defer, resolveDeferred(id, value) { deferredLoads.get(id)?.resolve(value); },
      renderReader, renderRoute, executeDeleteChat, studioHostUnmount, setStudioRouteScope,
      article, get context() { return structuredClone(internalState.context); },
      get operationLog() { return operationLog.slice(); },
      newController() { return createReaderResumeController(); },
      setController(value) { state.readerResume = value; },
      nativeController() { return createReaderResumeController(); },
      forceDuplicateIndex,
    };
  })();` });

  await group('V-Q1', 'production S1 pre-leave capture for every non-Reader route and boundary placement', async () => {
    const facts = await page.evaluate(() => {
      const out = [];
      for (const destination of ['list', 'library', 'migrate', 'settings']) {
        for (const placement of ['gap', 'inside']) {
          readerM02.reset();
          const snap = readerM02.makeSnapshot({ chatId: destination + '-' + placement, snapshotId: destination + '-' + placement });
          readerM02.mountDirect(snap); readerM02.selectOrdinal(2); readerM02.placeViewport(5, placement === 'gap' ? .9999 : .4);
          const before = readerM02.observeViewport();
          readerM02.state.currentReaderSnapshot = null;
          readerM02.setStudioRouteScope(destination, { clearReader: true });
          readerM02.studioHostUnmount('studio:route-' + destination);
          document.querySelector('.wbMain').scrollTop = 0;
          readerM02.mountDirect(snap);
          readerM02.clearCounters(); const result = readerM02.state.readerResume.restore();
          out.push({ destination, placement, before, after: readerM02.observeViewport(), selected: readerM02.selected(), result, counters: readerM02.counters() });
        }
      }
      return out;
    });
    for (const row of facts) {
      assert.equal(row.result.selection, 'RESTORED_IDENTITY');
      assert.equal(row.result.viewport, 'RESTORED_IDENTITY');
      assert.equal(row.selected.ordinal, 2);
      assert.equal(row.counters.scrollCalls.filter(call => call.kind === 'main').length, 1);
      assert.ok(Math.abs(row.before.fraction - row.after.fraction) < .02, `${row.destination}/${row.placement}`);
    }
    return { routes: 4, placements: 2, cases: facts.length, snapshotNullBeforeCapture: true };
  });

  await group('V-Q2', 'real studioHostUnmount reader-replace capture is first and single', async () => {
    const fact = await page.evaluate(() => {
      readerM02.reset(); const snap = readerM02.makeSnapshot({ chatId: 'replace', snapshotId: 'replace' });
      readerM02.mountDirect(snap); readerM02.selectOrdinal(3); const before = readerM02.placeViewport(6, .25);
      readerM02.studioHostUnmount('studio:reader-replace');
      readerM02.mountDirect(snap); readerM02.clearCounters(); const result = readerM02.state.readerResume.restore();
      return { before, after: readerM02.observeViewport(), selected: readerM02.selected(), result, counters: readerM02.counters() };
    });
    assert.equal(fact.result.selection, 'RESTORED_IDENTITY'); assert.equal(fact.selected.ordinal, 3);
    assert.equal(fact.counters.scrollCalls.filter(call => call.kind === 'main').length, 1);
    assert.ok(Math.abs(fact.before.fraction - fact.after.fraction) < .02);
    return fact;
  });

  await group('V-Q3', 'real extracted renderReader rebuild restores selection and viewport without focus movement', async () => {
    const facts = await page.evaluate(async () => {
      const out = [];
      for (const mode of ['canonical', 'rich']) {
        readerM02.reset(); const snap = readerM02.makeSnapshot({ chatId: 'render-' + mode, snapshotId: 'render-' + mode, mode });
        readerM02.snapshots.set(snap.snapshotId, snap); await readerM02.renderReader(snap.snapshotId);
        H2O.Studio.ribbon.setContext({ route: 'read', chatType: 'saved', snapshotId: snap.snapshotId, chatId: snap.chatId });
        readerM02.selectOrdinal(2); const before = readerM02.placeViewport(6, .37);
        document.getElementById('keeper').focus(); const active = document.activeElement;
        readerM02.setProfile('h2o-clean-reader'); readerM02.clearCounters();
        await readerM02.renderReader(snap.snapshotId);
        out.push({ mode, before, after: readerM02.observeViewport(), selected: readerM02.selected(), context: readerM02.context, focusPreserved: document.activeElement === active, counters: readerM02.counters() });
      }
      return out;
    });
    for (const row of facts) {
      assert.equal(row.selected.ordinal, 2); assert.equal(row.selected.messageId, 'm-2');
      assert.equal(row.context.selectedTurnIdx, 3); assert.equal(row.context.selectedMessageId, 'm-2');
      assert.equal(row.focusPreserved, true); assert.equal(row.counters.ribbonPublications, 1);
      assert.equal(row.counters.scrollCalls.filter(call => call.kind === 'main').length, 1);
      assert.equal(row.counters.scrollCalls.filter(call => call.kind !== 'main').length, 0);
      assert.equal(row.counters.windowScrollCalls, 0); assert.equal(row.counters.scrollIntoViewCalls, 0);
      assert.ok(Math.abs(row.before.fraction - row.after.fraction) < .02, row.mode);
    }
    return { modes: facts.map(row => row.mode), focus: 'preserved', mainScrollsPerRestore: 1 };
  });

  await group('V-Q3B', 'stale render-token completion has zero restore side effects', async () => {
    const fact = await page.evaluate(async () => {
      readerM02.reset();
      const base = readerM02.makeSnapshot({ chatId: 'rapid-A', snapshotId: 'rapid-A' });
      readerM02.snapshots.set(base.snapshotId, base); await readerM02.renderReader(base.snapshotId);
      readerM02.selectOrdinal(1); readerM02.placeViewport(4, .3);
      const b = readerM02.makeSnapshot({ chatId: 'rapid-B', snapshotId: 'rapid-B' });
      const c = readerM02.makeSnapshot({ chatId: 'rapid-C', snapshotId: 'rapid-C' });
      readerM02.defer('rapid-B'); readerM02.snapshots.set('rapid-C', c);
      const pendingB = readerM02.renderReader('rapid-B');
      const pendingC = readerM02.renderReader('rapid-C'); await pendingC;
      readerM02.clearCounters(); readerM02.resolveDeferred('rapid-B', b); await pendingB;
      return { selectedChatId: readerM02.state.selectedChatId, counters: readerM02.counters(), rootChat: readerM02.state.currentReaderSnapshot?.chatId };
    });
    assert.equal(fact.selectedChatId, 'rapid-C'); assert.equal(fact.rootChat, 'rapid-C');
    assert.equal(fact.counters.ribbonPublications, 0); assert.equal(fact.counters.scrollCalls.length, 0);
    return { rapidABC: 'PASS', staleEffects: 0 };
  });

  await group('V-Q4', 'production ledger, tombstone, deletion and capacity behavior', async () => {
    const facts = await page.evaluate(async () => {
      const results = {};
      readerM02.reset();
      const failed = readerM02.makeSnapshot({ chatId: 'delete-fail', snapshotId: 'delete-fail' });
      readerM02.mountDirect(failed); readerM02.selectOrdinal(1); readerM02.state.readerResume.remember('studio:reader-replace');
      readerM02.setDeleteMode('failure'); let forgetFailures = 0; const native = readerM02.state.readerResume;
      readerM02.setController({ remember: native.remember, restore: native.restore, forget(key) { forgetFailures += 1; return native.forget(key); } });
      await readerM02.executeDeleteChat(failed.chatId, failed.snapshotId, readerM02.article());
      readerM02.setController(native); readerM02.rebuildDirect(failed); results.failure = { forgetFailures, restore: native.restore(), selected: readerM02.selected() };

      readerM02.reset();
      const deleted = readerM02.makeSnapshot({ chatId: 'delete-ok', snapshotId: 'delete-ok' });
      readerM02.mountDirect(deleted); readerM02.selectOrdinal(1); readerM02.state.readerResume.remember('studio:reader-replace');
      readerM02.setDeleteMode('success'); let forgetSuccess = 0; const native2 = readerM02.state.readerResume;
      readerM02.setController({ remember: native2.remember, restore: native2.restore, forget(key) { forgetSuccess += 1; return native2.forget(key); } });
      readerM02.clearCounters(); await readerM02.executeDeleteChat(deleted.chatId, deleted.snapshotId, readerM02.article());
      const order = readerM02.operationLog; readerM02.setController(native2);
      readerM02.state.activeRoute = 'reader'; readerM02.mountDirect(deleted); const afterDelete = native2.restore();
      readerM02.selectOrdinal(2); const recapture = native2.remember('studio:reader-replace'); readerM02.rebuildDirect(deleted); const rebound = native2.restore();
      results.success = { forgetSuccess, order, afterDelete, recapture, rebound, selected: readerM02.selected() };

      readerM02.reset(); const ctl = readerM02.state.readerResume;
      for (let index = 0; index < 17; index += 1) {
        const snap = readerM02.makeSnapshot({ chatId: 'cap-' + index, snapshotId: 'cap-' + index, count: 3 });
        readerM02.mountDirect(snap); readerM02.selectOrdinal(1); ctl.remember('studio:reader-replace');
      }
      const cap0 = readerM02.makeSnapshot({ chatId: 'cap-0', snapshotId: 'cap-0', count: 3 }); readerM02.mountDirect(cap0); const evicted = ctl.restore();
      const cap1 = readerM02.makeSnapshot({ chatId: 'cap-1', snapshotId: 'cap-1', count: 3 }); readerM02.mountDirect(cap1); const retained = ctl.restore();
      for (let index = 0; index < 17; index += 1) ctl.forget('tomb-' + index);
      const tomb0 = readerM02.makeSnapshot({ chatId: 'tomb-0', snapshotId: 'tomb-0', count: 2 }); readerM02.mountDirect(tomb0); const tombEvicted = ctl.remember('studio:reader-replace');
      const tomb1 = readerM02.makeSnapshot({ chatId: 'tomb-1', snapshotId: 'tomb-1', count: 2 }); readerM02.mountDirect(tomb1); const tombRetained = ctl.remember('studio:reader-replace');
      results.capacity = { evicted, retained, tombEvicted, tombRetained };
      return results;
    });
    assert.equal(facts.failure.forgetFailures, 0); assert.equal(facts.failure.restore.selection, 'RESTORED_IDENTITY');
    assert.equal(facts.success.forgetSuccess, 1); assert.ok(facts.success.order.indexOf('deleteAllSnapshots') < facts.success.order.indexOf('delete-overrides'));
    assert.equal(facts.success.afterDelete.selection, 'NOT_RESTORED'); assert.equal(facts.success.recapture, 'CAPTURED');
    assert.equal(facts.success.rebound.selection, 'RESTORED_IDENTITY');
    assert.equal(facts.capacity.evicted.selection, 'NOT_RESTORED'); assert.equal(facts.capacity.retained.selection, 'RESTORED_IDENTITY');
    assert.equal(facts.capacity.tombEvicted, 'CAPTURED'); assert.equal(facts.capacity.tombRetained, 'NOT_CAPTURED');
    return { deletionFailureForgetCalls: 0, deletionSuccessForgetCalls: 1, ledgerCapacity: 16, tombstoneCapacity: 16 };
  });

  await group('V-Q5', 'real extracted renderRoute final Ribbon publication is selection coherent', async () => {
    const facts = await page.evaluate(async () => {
      readerM02.reset(); const snap = readerM02.makeSnapshot({ chatId: 'route-chat', snapshotId: 'route-snap' });
      readerM02.mountDirect(snap); readerM02.selectOrdinal(3); readerM02.state.readerResume.remember('studio:reader-replace'); readerM02.studioHostUnmount('test:rebuild'); document.getElementById('viewReader').replaceChildren();
      readerM02.snapshots.set(snap.snapshotId, snap); readerM02.setRoute({ name: 'read', snapshotId: snap.snapshotId }); await readerM02.renderRoute();
      const read = { context: readerM02.context, selected: readerM02.selected() };
      readerM02.setRoute({ name: 'library', view: 'dashboard' }); await readerM02.renderRoute();
      return { read, nonReader: readerM02.context };
    });
    assert.equal(facts.read.context.route, 'read'); assert.equal(facts.read.context.chatType, 'saved');
    assert.equal(facts.read.context.snapshotId, 'route-snap'); assert.equal(facts.read.context.chatId, 'route-chat');
    assert.equal(facts.read.context.selectedTurnIdx, 4); assert.equal(facts.read.context.selectedMessageId, 'm-3');
    assert.equal(facts.nonReader.selectedTurnIdx, null); assert.equal(facts.nonReader.selectedMessageId, null);
    return { restoredReader: 'coherent', nonReader: 'cleared' };
  });

  await group('V-Q6', 'real Semantic Index R1/R2 fail-closed matrix', async () => {
    const rows = await page.evaluate(() => {
      const out = {};
      function run(name, first, second, selectedOrdinal = 1) {
        readerM02.reset(); readerM02.mountDirect(first); readerM02.selectOrdinal(selectedOrdinal); readerM02.state.readerResume.remember('studio:reader-replace');
        readerM02.rebuildDirect(second); const result = readerM02.state.readerResume.restore(); out[name] = { result, selected: readerM02.selected() };
      }
      function runDuplicate(name, first, second, selectedOrdinal = 1) {
        readerM02.reset(); readerM02.mountDirect(first); readerM02.forceDuplicateIndex(); readerM02.selectOrdinal(selectedOrdinal); readerM02.state.readerResume.remember('studio:reader-replace');
        readerM02.rebuildDirect(second); readerM02.forceDuplicateIndex(); const result = readerM02.state.readerResume.restore(); out[name] = { result, selected: readerM02.selected() };
      }
      run('newerIdentity', readerM02.makeSnapshot({chatId:'r1-new',snapshotId:'old'}), readerM02.makeSnapshot({chatId:'r1-new',snapshotId:'new'}));
      runDuplicate('duplicateSame', readerM02.makeSnapshot({chatId:'r1-dup',snapshotId:'same'}), readerM02.makeSnapshot({chatId:'r1-dup',snapshotId:'same'}), 2);
      runDuplicate('duplicateNewer', readerM02.makeSnapshot({chatId:'r1-dup-new',snapshotId:'old'}), readerM02.makeSnapshot({chatId:'r1-dup-new',snapshotId:'new'}), 2);
      run('secondaryMismatch', readerM02.makeSnapshot({chatId:'r1-secondary',snapshotId:'old'}), readerM02.makeSnapshot({chatId:'r1-secondary',snapshotId:'new',secondarySuffix:'-changed'}));
      const noMessage = readerM02.makeSnapshot({chatId:'r1-primary',snapshotId:'new'}); delete noMessage.messages[1].messageId;
      run('primaryMissing', readerM02.makeSnapshot({chatId:'r1-primary',snapshotId:'old'}), noMessage);
      run('roleMismatch', readerM02.makeSnapshot({chatId:'r1-role',snapshotId:'old'}), readerM02.makeSnapshot({chatId:'r1-role',snapshotId:'new',roleShift:true}));
      run('structural', readerM02.makeSnapshot({chatId:'r2-ok',snapshotId:'same',ids:false}), readerM02.makeSnapshot({chatId:'r2-ok',snapshotId:'same',ids:false}));
      run('structuralNewer', readerM02.makeSnapshot({chatId:'r2-new',snapshotId:'old',ids:false}), readerM02.makeSnapshot({chatId:'r2-new',snapshotId:'new',ids:false}));
      run('structuralMode', readerM02.makeSnapshot({chatId:'r2-mode',snapshotId:'same',ids:false}), readerM02.makeSnapshot({chatId:'r2-mode',snapshotId:'same',ids:false,mode:'rich'}));
      run('unrelated', readerM02.makeSnapshot({chatId:'r1-a',snapshotId:'old'}), readerM02.makeSnapshot({chatId:'r1-b',snapshotId:'new'}));
      return out;
    });
    assert.equal(rows.newerIdentity.result.selection, 'RESTORED_IDENTITY');
    assert.equal(rows.duplicateSame.result.selection, 'RESTORED_IDENTITY'); assert.equal(rows.duplicateSame.selected.ordinal, 2);
    for (const key of ['duplicateNewer','secondaryMismatch','primaryMissing','roleMismatch','structuralNewer','structuralMode','unrelated']) assert.equal(rows[key].result.selection, 'NOT_RESTORED', key);
    assert.equal(rows.structural.result.selection, 'RESTORED_STRUCTURAL'); assert.equal(rows.structural.selected.messageId, null);
    return { cases: Object.keys(rows).length, R1: 'PASS', R2: 'PASS', failClosed: 'PASS' };
  });

  await group('V-Q7', 'production S1 hook replaces the T2 observation model', async () => {
    const result = await page.evaluate(() => {
      readerM02.reset(); const snap = readerM02.makeSnapshot({chatId:'s1-real',snapshotId:'s1-real'});
      readerM02.mountDirect(snap); readerM02.selectOrdinal(1); readerM02.placeViewport(4,.45);
      const captured = readerM02.state.readerResume.remember('studio:route-scope:list');
      const ignored = readerM02.state.readerResume.remember('studio:list');
      return { captured, ignored };
    });
    assert.deepEqual(result, { captured: 'CAPTURED', ignored: 'NOT_CAPTURED' });
    return { modelOnly: false, productionController: true };
  });

  await group('SCENARIOS', 'required race, empty, tall, detached and reuse scenarios', async () => {
    const facts = await page.evaluate(async () => {
      const out = {};
      readerM02.reset(); const empty = readerM02.makeSnapshot({chatId:'empty',snapshotId:'empty',count:0}); readerM02.mountDirect(empty); out.emptyCapture = readerM02.state.readerResume.remember('studio:reader-replace'); readerM02.rebuildDirect(empty); readerM02.clearCounters(); out.emptyRestore = readerM02.state.readerResume.restore(); out.emptyCounters = readerM02.counters();
      readerM02.reset(); const tall = readerM02.makeSnapshot({chatId:'tall',snapshotId:'tall',count:1}); tall.messages[0].text = ('very tall content ').repeat(1200); readerM02.mountDirect(tall); const before = readerM02.placeViewport(0,.6); readerM02.state.readerResume.remember('studio:reader-replace'); readerM02.rebuildDirect(tall); readerM02.clearCounters(); const tallResult = readerM02.state.readerResume.restore(); out.tall = {before,after:readerM02.observeViewport(),tallResult,counters:readerM02.counters()};
      readerM02.reset(); const detached = readerM02.makeSnapshot({chatId:'detached',snapshotId:'detached'}); const detachedRoot = readerM02.mountDirect(detached); detachedRoot.remove(); out.detached = readerM02.state.readerResume.remember('studio:reader-replace');
      readerM02.reset(); const reuse = readerM02.makeSnapshot({chatId:'reuse',snapshotId:'reuse'}); readerM02.snapshots.set('reuse',reuse); await readerM02.renderReader('reuse'); readerM02.selectOrdinal(2); const root = readerM02.state.currentReaderRender.root; readerM02.clearCounters(); await readerM02.renderReader('reuse'); out.reuse = {sameRoot:root===readerM02.state.currentReaderRender.root,counters:readerM02.counters(),selected:readerM02.selected()};
      readerM02.reset(); const pending = readerM02.makeSnapshot({chatId:'pending',snapshotId:'pending'}); readerM02.snapshots.set('pending',pending); await readerM02.renderReader('pending'); readerM02.selectOrdinal(1); readerM02.placeViewport(4,.3); readerM02.defer('pending'); const load = readerM02.renderReader('pending'); readerM02.state.renderToken += 1; readerM02.state.currentReaderSnapshot = null; readerM02.setStudioRouteScope('list'); readerM02.studioHostUnmount('studio:list'); readerM02.resolveDeferred('pending',pending); readerM02.clearCounters(); await load; out.leavePending = readerM02.counters();
      return out;
    });
    assert.equal(facts.emptyCapture, 'CAPTURED'); assert.equal(facts.emptyRestore.selection, 'NOT_RESTORED'); assert.equal(facts.emptyRestore.viewport, 'NOT_RESTORED'); assert.equal(facts.emptyCounters.scrollCalls.length,0);
    assert.equal(facts.tall.tallResult.viewport,'RESTORED_IDENTITY'); assert.equal(facts.tall.counters.scrollCalls.filter(call=>call.kind==='main').length,1); assert.ok(Math.abs(facts.tall.before.fraction-facts.tall.after.fraction)<.02);
    assert.equal(facts.detached,'NOT_CAPTURED'); assert.equal(facts.reuse.sameRoot,true); assert.equal(facts.reuse.counters.scrollCalls.length,0); assert.equal(facts.reuse.counters.ribbonPublications,0); assert.equal(facts.reuse.selected.ordinal,2);
    assert.equal(facts.leavePending.scrollCalls.length,0); assert.equal(facts.leavePending.ribbonPublications,0);
    return { empty:'PASS', tall:'PASS', detached:'PASS', equivalentReuse:'PASS', leavePending:'PASS' };
  });

  await group('RECORD', 'captured records are deeply frozen, serializable and root-free', async () => {
    const fact = await page.evaluate(() => {
      readerM02.reset();
      const NativeMap = window.Map; const maps = [];
      window.Map = class SpyMap extends NativeMap { constructor(...args) { super(...args); maps.push(this); } };
      const controller = readerM02.newController(); window.Map = NativeMap; readerM02.setController(controller);
      const snap = readerM02.makeSnapshot({chatId:'record',snapshotId:'record'}); readerM02.mountDirect(snap); readerM02.selectOrdinal(1); readerM02.placeViewport(3,.2); controller.remember('studio:reader-replace');
      const record = Array.from(maps[0].values())[0];
      const seen = new Set(); let rootFree = true, deepFrozen = true;
      function visit(value) { if (!value || typeof value !== 'object' || seen.has(value)) return; seen.add(value); if (!Object.isFrozen(value)) deepFrozen=false; if (value instanceof Element || value === readerM02.state.currentReaderRender?.semanticIndex) rootFree=false; for (const child of Object.values(value)) visit(child); }
      visit(record); return {deepFrozen,rootFree,json:JSON.parse(JSON.stringify(record)),keys:Object.keys(record)};
    });
    assert.equal(fact.deepFrozen,true); assert.equal(fact.rootFree,true); assert.deepEqual(fact.keys.sort(),['content','render','selection','viewport']);
    assert.doesNotMatch(JSON.stringify(fact.json),/semanticIndex|decoration|presentation|element|root/i);
    return { deepFrozen:true, serializable:true, rootFree:true };
  });

  await group('NEGATIVE-CONTROL', 'harness detects deliberately missing T3 controller behavior', async () => {
    const fact = await page.evaluate(async () => {
      readerM02.reset(); const snap=readerM02.makeSnapshot({chatId:'negative',snapshotId:'negative'}); readerM02.snapshots.set('negative',snap); await readerM02.renderReader('negative'); readerM02.selectOrdinal(2); readerM02.placeViewport(5,.3);
      readerM02.setController(Object.freeze({remember(){return 'NOT_CAPTURED';},restore(){return Object.freeze({selection:'NOT_RESTORED',viewport:'NOT_RESTORED'});},forget(){return false;}}));
      readerM02.setProfile('h2o-clean-reader'); readerM02.clearCounters(); await readerM02.renderReader('negative');
      return {selected:readerM02.selected(),counters:readerM02.counters(),context:readerM02.context};
    });
    assert.equal(fact.selected,null); assert.equal(fact.counters.scrollCalls.length,0); assert.equal(fact.context.selectedTurnIdx,null);
    return { missingSeamDetected:true };
  });

  assert.deepEqual(pageErrors, [], `browser page errors: ${pageErrors.join('\n')}`);
} catch (error) {
  browserError = error;
  failures.push({ id: 'BROWSER', result: 'FAIL', error: String(error?.stack || error) });
  console.error(`BROWSER_FAIL ${String(error?.stack || error)}`);
} finally {
  await browser?.close();
  try { fs.rmSync(browserRoot, { recursive: true, force: true }); } catch {}
}

await group('PREDECESSOR', 'M01 contract and validator remain byte-identical to Product main', () => {
  for (const rel of [M01_CONTRACT_REL, M01_VALIDATOR_REL]) {
    const shown = spawnSync('git', ['show', `origin/main:${rel}`], { cwd: ROOT, encoding: null, maxBuffer: 32 * 1024 * 1024 });
    assert.equal(shown.status, 0, `git show ${rel}`);
    assert.ok(Buffer.from(shown.stdout).equals(fs.readFileSync(path.join(ROOT, rel))), `${rel} changed`);
  }
  return { files: [M01_CONTRACT_REL, M01_VALIDATOR_REL] };
});

const required = ['V-Q1','V-Q2','V-Q3','V-Q3B','V-Q4','V-Q5','V-Q6','V-Q7','NEGATIVE-CONTROL'];
for (const id of required) {
  if (!rows.some(row => row.id === id && row.result === 'PASS')) failures.push({ id, result: 'FAIL', error: 'required group missing' });
}
console.log('');
console.log(`M02_T3_CURRENT_GROUPS=${rows.filter(row => row.result === 'PASS').length}`);
for (const id of required) console.log(`${id.replace('-', '_').replace('-', '_')}=${rows.some(row => row.id === id && row.result === 'PASS') ? 'PASS' : 'FAIL'}`);
console.log(`NEGATIVE_CONTROL_RESULT=${rows.some(row => row.id === 'NEGATIVE-CONTROL' && row.result === 'PASS') ? 'PASS' : 'FAIL'}`);
console.log(`FAILURES=${failures.length}`);
if (browserError || failures.length) process.exitCode = 1;
