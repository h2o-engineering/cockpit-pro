#!/usr/bin/env node
// Focused T11 lifecycle validation for Studio Reader orchestration and S0D3e.
// Uses the real lifecycle functions with small DOM/storage seams so refresh,
// replacement, route leave/return, and stale async completion remain testable
// without browser infrastructure or downstream Reader implementation.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), '..', '..', '..');
const STUDIO_REL = 'src-surfaces-base/studio/studio.js';
const HOST_REL = 'src-surfaces-base/studio/S0D3e. 🎬 Transcript Studio Host - Studio.js';
const studioSource = fs.readFileSync(path.join(REPO_ROOT, STUDIO_REL), 'utf8');
const hostSource = fs.readFileSync(path.join(REPO_ROOT, HOST_REL), 'utf8');

function extractFunction(source, name) {
  const match = new RegExp(`\\b(?:async\\s+)?function\\s+${name}\\s*\\(`).exec(source);
  if (!match) throw new Error(`extractFunction: '${name}' not found`);
  const start = match.index;
  const braceOpen = source.indexOf('{', start);
  let depth = 0;
  for (let i = braceOpen; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`extractFunction: unterminated '${name}'`);
}

class FakeNode {
  constructor(snapshotId = '') {
    this.snapshotId = snapshotId;
    this.isConnected = false;
    this.attrs = new Map();
    this.children = [];
  }
  setAttribute(name, value) { this.attrs.set(name, String(value)); }
  getAttribute(name) { return this.attrs.get(name) || null; }
  removeAttribute(name) { this.attrs.delete(name); }
  setConnected(value) {
    this.isConnected = !!value;
    for (const child of this.children) child.setConnected(value);
  }
  appendChild(node) {
    this.children.push(node);
    node.setConnected(this.isConnected);
    return node;
  }
  contains(node) { return node === this || this.children.some((child) => child.contains(node)); }
}

class FakeReaderElement {
  constructor() {
    this.children = [];
    this.hidden = true;
    this._html = '';
  }
  replaceChildren(...nodes) {
    for (const node of this.children) node.setConnected(false);
    this.children = nodes;
    for (const node of nodes) node.setConnected(true);
    this._html = '';
  }
  set innerHTML(value) {
    this.replaceChildren();
    this._html = String(value || '');
  }
  get innerHTML() { return this._html; }
  appendChild(node) {
    this.children.push(node);
    node.setConnected(true);
    return node;
  }
  contains(node) { return this.children.includes(node) && node.isConnected; }
}

function makeLocation(pathname = '/studio.html', hash = '') {
  return { pathname, search: '', hash };
}

function installHistory(location) {
  return {
    state: {},
    replaceState(nextState, _title, rawUrl) {
      this.state = nextState || {};
      const parsed = new URL(String(rawUrl || ''), 'https://studio.local');
      location.pathname = parsed.pathname;
      location.search = parsed.search;
      location.hash = parsed.hash;
    },
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function makeSnapshot(id, chatId = `chat-${id}`, messages = [{ role: 'user', text: id }]) {
  return { snapshotId: id, chatId, meta: { title: id }, messages };
}

function createRenderHarness() {
  const readerEl = new FakeReaderElement();
  const listPanel = { hidden: false };
  const location = makeLocation('/studio.html', '#/read/A');
  const history = installHistory(location);
  const loads = new Map();
  let bindings = new Map();
  const roots = [];
  const events = [];
  const overlayRefreshes = [];

  const hostState = {
    root: null,
    turns: null,
    scroll: null,
    snapshot: null,
    mountCount: 0,
    unmountCount: 0,
    rejectSnapshotUpdate: false,
  };
  const studioHost = {
    mount(opts) {
      if (hostState.root || hostState.snapshot) this.unmount('remount');
      hostState.root = opts.readerRoot || null;
      hostState.turns = opts.turnsEl || null;
      hostState.scroll = opts.scrollEl || null;
      hostState.snapshot = opts.snapshot || null;
      hostState.root?.setAttribute('data-h2o-studio-reader', '1');
      hostState.turns?.setAttribute('data-testid', 'conversation-turns');
      hostState.scroll?.setAttribute('data-scroll-root', '1');
      hostState.mountCount += 1;
      return true;
    },
    unmount() {
      if (!hostState.root && !hostState.snapshot) return false;
      hostState.root?.removeAttribute('data-h2o-studio-reader');
      hostState.scroll?.removeAttribute('data-scroll-root');
      hostState.root = null;
      hostState.turns = null;
      hostState.scroll = null;
      hostState.snapshot = null;
      hostState.unmountCount += 1;
      return true;
    },
    getReaderRoot() {
      return hostState.root?.isConnected ? hostState.root : null;
    },
    getTurnsRoot() {
      return hostState.turns?.isConnected ? hostState.turns : null;
    },
    getScrollRoot() {
      return hostState.scroll?.isConnected ? hostState.scroll : null;
    },
    updateSnapshot(snapshot) {
      if (hostState.rejectSnapshotUpdate) return false;
      if (!hostState.root?.isConnected || !hostState.turns?.isConnected || !hostState.scroll?.isConnected) return false;
      if (!hostState.root.contains(hostState.turns) || !hostState.root.contains(hostState.scroll)) return false;
      hostState.snapshot = snapshot || null;
      return true;
    },
  };

  const state = {
    renderToken: 0,
    rowsCache: [],
    currentReaderSnapshot: null,
    currentReaderEditOverrides: null,
    /* M03 S4C: the current-render bridge ({ root, semanticIndex, decorationContributions }). */
    currentReaderRender: null,
    selectedSnapshotId: '',
    selectedChatId: '',
    lastView: 'saved',
    lastFolderId: '',
    activeRoute: 'list',
  };
  /* M03 S4C slice B: every stubbed render carries a fake read-only index and a
   * spy DecorationContribution lifecycle, bound through the REAL
   * bindReaderSemanticIndex so the real unmount seam is what disposes them. */
  const lifecycles = [];
  const warnings = [];
  let failNextDisposeAll = false;
  const makeSpyLifecycle = (root, semanticIndex) => {
    const lifecycle = {
      schema: 'h2o.renderer.decoration-contribution', schemaVersion: 1, version: 'spy',
      semanticIndex, root, disposeAllCalls: 0, bindingAtDispose: [], active: 1,
      register() { throw new Error('the Reader never registers'); },
      get() { return null; },
      list() { return lifecycle.active ? [{ contributionKey: 'decoration:spy:x' }] : []; },
      disposeAll() {
        lifecycle.disposeAllCalls += 1;
        lifecycle.bindingAtDispose.push(state.currentReaderRender);
        lifecycle.active = 0;
        if (failNextDisposeAll) { failNextDisposeAll = false; throw new Error('spy cleanup failure'); }
        return [];
      },
    };
    lifecycles.push(lifecycle);
    return lifecycle;
  };

  const rendererProjection = (snapshot) => {
    const meta = snapshot?.meta && typeof snapshot.meta === 'object'
      ? snapshot.meta
      : (snapshot?.metadata && typeof snapshot.metadata === 'object' ? snapshot.metadata : {});
    return JSON.stringify({
      snapshotId: String(snapshot?.snapshotId || ''),
      chatId: String(snapshot?.chatId || ''),
      title: String(meta.title || snapshot?.title || snapshot?.chatId || 'Saved chat'),
      projectId: String(meta.projectId || snapshot?.projectId || ''),
      messages: Array.isArray(snapshot?.messages) ? snapshot.messages : [],
      richTurns: Array.isArray(snapshot?.richTurns || meta.richTurns) ? (snapshot.richTurns || meta.richTurns) : [],
    });
  };
  /* M04 P2 T4: the fake Renderer mirrors the implemented presentation contract
   * (T2): describePresentation() resolves a request to the effective profile
   * (absent / '' -> default, unknown / malformed -> reference fallback) and the
   * combined registry token exists only once the first render sealed the
   * registries (null before). The stubbed buildReaderDOM below "renders" with
   * the current Appearance preference exactly like the real seam. */
  const PROFILES = { 'chatgpt-reference': '1.0.0', 'h2o-clean-reader': '1.0.0' };
  const rendererState = { sealed: false, digest: '{"schema":"h2o.renderer.registry-digest","schemaVersion":1,"presentationProfile":"pp","contentRenderer":"cr"}' };
  const describePresentation = (request) => {
    const absent = request === undefined || request === null || request === '';
    const known = typeof request === 'string' && Object.prototype.hasOwnProperty.call(PROFILES, request);
    const effectiveId = known ? request : 'chatgpt-reference';
    return Object.freeze({ schema: 'h2o.renderer.presentation-descriptor', schemaVersion: 1, requestedId: typeof request === 'string' && !absent ? request : null, effectiveId, profileVersion: PROFILES[effectiveId], reason: absent ? 'default' : (known ? 'explicit' : 'unknown-profile-fallback'), registryDigest: rendererState.sealed ? rendererState.digest : null });
  };
  const chatRenderer = {
    normalizeInput(snapshot) { return snapshot; },
    isRenderEquivalent(left, right) { return rendererProjection(left) === rendererProjection(right); },
    render() { return null; },
    describePresentation,
  };
  /* M04 P2 T4: Appearance store stub - the Reader-owned preference, its
   * subscribe/unsubscribe contract and the ready / change notifications. */
  const appearanceState = { presentationProfile: 'chatgpt-reference', ready: false };
  const appearanceSubscribers = new Set();
  const appearanceEvents = [];
  const appearance = {
    get(key) { return key === 'presentationProfile' ? appearanceState.presentationProfile : undefined; },
    isReady() { return appearanceState.ready; },
    subscribe(fn) { appearanceSubscribers.add(fn); return () => appearanceSubscribers.delete(fn); },
    notify(event) { appearanceEvents.push(event); for (const fn of Array.from(appearanceSubscribers)) fn(event); },
  };
  const renders = [];
  const W = {
    location,
    history,
    H2O: {
      studioHost,
      Studio: {
        chatRenderer,
        appearance,
        SELECTORS: {
          ATTR: { TESTID: 'data-testid' },
          TESTIDS: { CONVERSATION_TURNS: 'conversation-turns' },
        },
      },
    },
    dispatchEvent(event) { events.push(event); },
  };
  const document = {
    getElementById(id) { return id === 'viewReader' ? readerEl : null; },
  };
  const bySelector = {
    '#viewReader': readerEl,
    '#viewListPanel': listPanel,
  };

  const sandbox = vm.createContext({
    W,
    document,
    state,
    $: (selector) => bySelector[selector] || null,
    String,
    Array,
    Object,
    Promise,
    Map,
    console: { log: console.log, error: console.error, warn(...args) { warnings.push(args.map(String).join(' ')); } },
    CustomEvent: class CustomEvent { constructor(type, init) { this.type = type; this.detail = init?.detail; } },
    STUDIO_BOOT_AUX_TIMEOUT_MS: 1,
    setStudioRouteScope(name, opts) {
      state.activeRoute = name;
      if (opts?.clearReader) state.currentReaderSnapshot = null;
    },
    applyDesktopReaderRibbonSession() {},
    ensureReaderTopbarActions() {},
    setRouteMeta() {},
    callArchive: async (_op, payload) => {
      const value = loads.get(String(payload?.snapshotId || ''));
      return await Promise.resolve(value);
    },
    fetchWorkbenchRows: async () => [],
    enrichRowsWithFolderData: async (rows) => rows,
    renderFolderSidebar() {},
    promiseWithTimeoutFallback: async (promise, _timeout, _label, fallback) => {
      try { return await Promise.resolve(promise); } catch { return fallback; }
    },
    fetchFolderCatalog: async () => ({ canonical: [], review: [] }),
    fetchLabelCatalog: async () => [],
    fetchCategoryCatalog: async () => [],
    resolveFolderBindingsForChatIds: async () => bindings,
    normalizeFolderBinding: (value) => value || { folderId: '', folderName: '' },
    resolveFolderName: () => '',
    updateRowFolderBinding() {},
    refreshSidebarChatList() {},
    getEditOverride() { return null; },
    buildReaderDOM(snap) {
      const root = new FakeNode(String(snap?.snapshotId || ''));
      const turns = new FakeNode(`${root.snapshotId}-turns`);
      root.appendChild(turns);
      roots.push(root);
      /* The Renderer result shape the real seam binds: root + read-only index + lifecycle
       * + (M04 P2 T4) the frozen presentation descriptor of THIS render, resolved from
       * the current Appearance preference; the first render seals the registries. */
      rendererState.sealed = true;
      const presentation = describePresentation(appearance.get('presentationProfile'));
      renders.push({ snapshotId: root.snapshotId, effectiveId: presentation.effectiveId, requestedId: presentation.requestedId });
      const semanticIndex = Object.freeze({ schema: 'h2o.renderer.semantic-index', schemaVersion: 1, version: '0.2.0-m03-s4a', getConversation: () => ({ kind: 'conversation', target: root }), messages: () => [] });
      sandbox.bindReaderSemanticIndex({ root, turnsEl: turns, scrollEl: turns, semanticIndex, decorationContributions: makeSpyLifecycle(root, semanticIndex), presentation });
      studioHost.mount({ readerRoot: root, turnsEl: turns, scrollEl: turns, snapshot: snap });
      return root;
    },
    refreshReaderOverlay(root, snap) { overlayRefreshes.push({ root, snap }); },
    renderReaderRouteMeta() {},
    setActiveSidebarChat() {},
    syncSelectionControls() {},
    applyUiState() {},
    esc: (value) => String(value || ''),
  });

  const lifecycleFunctions = [
    'getStudioChatRenderer',
    /* M03 S4C: the current-render bridge is part of the unmount seam. */
    'bindReaderSemanticIndex',
    'getReaderSemanticIndex',
    'getReaderDecorationContributions',
    'disposeReaderRenderDecorations',
    'studioHostUnmount',
    'studioHostUnmountPreservingRouteHash',
    'isCurrentReaderRoot',
    'getReusableReaderMount',
    'isReusableReaderMountCurrent',
    'collectRendererEditOverrides',
    'haveEquivalentRendererEditOverrides',
    /* M04 P2 T4: the presentation-preference seams the reuse decision and the
     * guarded refresh run through (extracted verbatim, like the rest). */
    'getReaderPresentationPreference',
    'isReaderPresentationCurrent',
    'canReuseReaderDOM',
    'refreshReaderPresentation',
    'subscribeReaderToPresentationPreference',
    /* Current-main collaborator called by renderReader (Item 10 publication
     * target maintenance); extracted verbatim so the real seam runs unstubbed. */
    'rememberPublicationTarget',
    'renderReader',
  ].map((name) => extractFunction(studioSource, name)).join('\n');
  vm.runInContext(`${lifecycleFunctions}\nthis.renderReaderUnderTest = renderReader;\nthis.isCurrentReaderRootUnderTest = isCurrentReaderRoot;\nthis.leaveReaderUnderTest = studioHostUnmountPreservingRouteHash;\nthis.subscribeReaderUnderTest = subscribeReaderToPresentationPreference;\nthis.refreshReaderPresentationUnderTest = refreshReaderPresentation;\nthis.isReaderPresentationCurrentUnderTest = isReaderPresentationCurrent;`, sandbox);

  return {
    renderReader: sandbox.renderReaderUnderTest,
    isCurrentReaderRoot: sandbox.isCurrentReaderRootUnderTest,
    leaveReader(reason = 'test:leave') {
      state.renderToken += 1;
      state.currentReaderSnapshot = null;
      sandbox.leaveReaderUnderTest(reason);
    },
    setLoad(id, value) { loads.set(id, value); },
    setBindings(value) { bindings = value; },
    rejectHostSnapshotUpdate(value = true) { hostState.rejectSnapshotUpdate = !!value; },
    readerEl,
    listPanel,
    state,
    hostState,
    roots,
    overlayRefreshes,
    location,
    history,
    events,
    /* M03 S4C */
    lifecycles,
    warnings,
    failNextDisposeAll() { failNextDisposeAll = true; },
    getReaderSemanticIndex: sandbox.getReaderSemanticIndex,
    getReaderDecorationContributions: sandbox.getReaderDecorationContributions,
    bindReaderSemanticIndex: sandbox.bindReaderSemanticIndex,
    /* M04 P2 T4 */
    renders,
    appearanceState,
    appearanceEvents,
    appearanceSubscribers,
    rendererState,
    subscribeReader: sandbox.subscribeReaderUnderTest,
    refreshReaderPresentation: sandbox.refreshReaderPresentationUnderTest,
    isReaderPresentationCurrent: sandbox.isReaderPresentationCurrentUnderTest,
    setPresentationPreference(value) {
      const previous = appearanceState.presentationProfile;
      appearanceState.presentationProfile = value;
      if (previous !== value) appearance.notify({ type: 'change', key: 'presentationProfile', value });
    },
    hydrate(value) {
      if (value !== undefined) appearanceState.presentationProfile = value;
      appearanceState.ready = true;
      appearance.notify({ type: 'ready', key: null, value: null });
    },
    notifyUnrelated() { appearance.notify({ type: 'change', key: 'theme', value: 'light' }); },
  };
}

function createRouteHashHarness() {
  const readerEl = new FakeReaderElement();
  const oldRoot = new FakeNode('A');
  readerEl.replaceChildren(oldRoot);
  const location = makeLocation('/c/chat-A', '#/library');
  const history = installHistory(location);
  let unmounts = 0;
  const W = { location, history, H2O: { studioHost: {} } };
  const document = { getElementById: () => readerEl };
  const state = { currentReaderEditOverrides: [] };
  const sandbox = vm.createContext({ W, document, state, String, Object });
  sandbox.W.H2O.studioHost.unmount = () => {
    unmounts += 1;
    location.pathname = '/studio.html';
    location.hash = '#/read/A';
    return true;
  };
  vm.runInContext(`${extractFunction(studioSource, 'disposeReaderRenderDecorations')}\n${extractFunction(studioSource, 'studioHostUnmount')}\n${extractFunction(studioSource, 'studioHostUnmountPreservingRouteHash')}\nthis.leave = studioHostUnmountPreservingRouteHash;`, sandbox);
  return { leave: sandbox.leave, readerEl, oldRoot, location, getUnmounts: () => unmounts };
}

function createHostHarness() {
  const location = makeLocation('/studio.html', '#/read/A');
  const history = installHistory(location);
  const documentElement = new FakeNode();
  const body = new FakeNode();
  const routeEvents = [];
  const originalGetChatId = () => 'native-chat';
  const W = {
    location,
    history,
    H2O: {
      util: { getChatId: originalGetChatId },
      obs: {
        ensureRoot() {},
        markDirty() {},
        flush() {},
        withSuppressed(_reason, callback) { callback(); },
      },
      index: { refresh() {} },
    },
    dispatchEvent(event) { routeEvents.push(event); },
    requestAnimationFrame(callback) { callback(); },
    setTimeout(callback) { callback(); },
  };
  const D = { documentElement, body };
  const sandbox = vm.createContext({
    window: W,
    document: D,
    history,
    Object,
    String,
    Array,
    CustomEvent: class CustomEvent { constructor(type, init) { this.type = type; this.detail = init?.detail; } },
  });
  const instrumentedHostSource = hostSource.replace(
    '  W.H2O.studioHost = {',
    '  W.__getStudioHostSnapshotForTest = () => STATE.snapshot;\n\n  W.H2O.studioHost = {'
  );
  assert.notEqual(instrumentedHostSource, hostSource, 'host snapshot test hook must install');
  vm.runInContext(instrumentedHostSource, sandbox, { filename: HOST_REL });
  return {
    api: W.H2O.studioHost,
    W,
    D,
    routeEvents,
    originalGetChatId,
    getSnapshot: () => W.__getStudioHostSnapshotForTest(),
  };
}

const PASS = [];
const FAIL = [];
async function check(label, fn) {
  try { await fn(); PASS.push(label); }
  catch (error) { FAIL.push({ label, error: error?.stack || String(error) }); }
}

await check('same snapshot refresh converges on one current transcript', async () => {
  const h = createRenderHarness();
  const source = makeSnapshot('A');
  h.setLoad('A', source);
  h.setBindings(new Map([['chat-A', { folderId: 'folder-1', folderName: 'Folder 1' }]]));
  const before = JSON.stringify(source);

  await h.renderReader('A');
  const firstRoot = h.readerEl.children[0];
  await h.renderReader('A');

  assert.equal(h.readerEl.children.length, 1);
  assert.equal(h.readerEl.children[0].snapshotId, 'A');
  assert.equal(h.readerEl.children[0], firstRoot, 'equivalent refresh must preserve root identity');
  assert.equal(firstRoot.isConnected, true);
  assert.equal(h.hostState.root, h.readerEl.children[0]);
  assert.equal(h.hostState.snapshot.snapshotId, 'A');
  assert.equal(h.hostState.mountCount, 1, 'equivalent refresh must not remount S0D3e');
  assert.equal(h.overlayRefreshes.length, 1, 'fast refresh must refresh downstream Overlay projection');
  assert.equal(h.state.currentReaderSnapshot.snapshotId, 'A');
  assert.equal(h.state.currentReaderSnapshot.meta.folderId, 'folder-1');
  assert.equal(JSON.stringify(source), before, 'folder projection must not mutate loaded snapshot');
});

await check('same-ID Renderer-visible changes always replace the mounted transcript', async () => {
  const variants = [
    ['canonical text', (snap) => { snap.messages[0].text = 'changed text'; }],
    ['canonical role', (snap) => { snap.messages[0].role = 'system'; }],
    ['attachment', (snap) => { snap.messages[0].attachments = [{ kind: 'image', alt: 'changed' }]; }],
    ['rich HTML', (snap) => {
      snap.richTurns = [{ turnIdx: 1, role: 'user', outerHTML: '<article>changed</article>' }];
    }],
  ];
  for (const [label, mutate] of variants) {
    const h = createRenderHarness();
    const initial = makeSnapshot('A');
    h.setLoad('A', initial);
    await h.renderReader('A');
    const firstRoot = h.readerEl.children[0];
    const changed = structuredClone(initial);
    mutate(changed);
    h.setLoad('A', changed);
    await h.renderReader('A');
    assert.notEqual(h.readerEl.children[0], firstRoot, `${label} change must replace the root`);
    assert.equal(firstRoot.isConnected, false, `${label} change must detach the previous root`);
    assert.equal(h.hostState.mountCount, 2, `${label} change must remount S0D3e`);
  }
});

await check('equivalent fast refresh publishes the fresh snapshot without mutation', async () => {
  const h = createRenderHarness();
  const initial = makeSnapshot('A');
  h.setLoad('A', initial);
  await h.renderReader('A');
  const root = h.readerEl.children[0];
  const fresh = structuredClone(initial);
  fresh.meta.category = { id: 'surrounding-only' };
  const before = JSON.stringify(fresh);
  h.setLoad('A', fresh);
  await h.renderReader('A');
  assert.equal(h.readerEl.children[0], root);
  assert.equal(h.state.currentReaderSnapshot, fresh, 'fresh loaded snapshot object must become current');
  assert.equal(h.hostState.snapshot, fresh, 'fast refresh must replace the host snapshot reference');
  assert.equal(JSON.stringify(fresh), before, 'fast refresh must not mutate the loaded snapshot');
});

await check('host snapshot publication failure forces the normal rebuild path', async () => {
  const h = createRenderHarness();
  const initial = makeSnapshot('A');
  h.setLoad('A', initial);
  await h.renderReader('A');
  const firstRoot = h.readerEl.children[0];
  const fresh = structuredClone(initial);
  fresh.meta.category = { id: 'presentation-only' };
  h.setLoad('A', fresh);
  h.rejectHostSnapshotUpdate(true);
  await h.renderReader('A');
  assert.notEqual(h.readerEl.children[0], firstRoot, 'publication failure must replace the mounted root');
  assert.equal(firstRoot.isConnected, false, 'publication failure must detach the obsolete root');
  assert.equal(h.hostState.mountCount, 2, 'publication failure must use the normal host mount path');
  assert.equal(h.hostState.snapshot, fresh, 'full rebuild must publish the fresh snapshot');
});

await check('detached or stale host roots reject otherwise-equivalent fast refresh', async () => {
  const detached = createRenderHarness();
  detached.setLoad('A', makeSnapshot('A'));
  await detached.renderReader('A');
  const detachedRoot = detached.readerEl.children[0];
  detachedRoot.setConnected(false);
  await detached.renderReader('A');
  assert.notEqual(detached.readerEl.children[0], detachedRoot, 'detached root must be rebuilt');
  assert.equal(detached.hostState.mountCount, 2);

  const stale = createRenderHarness();
  stale.setLoad('A', makeSnapshot('A'));
  await stale.renderReader('A');
  const staleRoot = stale.readerEl.children[0];
  const unrelatedTurns = new FakeNode('unrelated-turns');
  unrelatedTurns.setConnected(true);
  stale.hostState.turns = unrelatedTurns;
  stale.hostState.scroll = unrelatedTurns;
  await stale.renderReader('A');
  assert.notEqual(stale.readerEl.children[0], staleRoot, 'stale host references must force rebuild');
  assert.equal(stale.hostState.mountCount, 2);
});

await check('A to B replacement leaves only B active', async () => {
  const h = createRenderHarness();
  h.setLoad('A', makeSnapshot('A'));
  h.setLoad('B', makeSnapshot('B'));
  await h.renderReader('A');
  const aRoot = h.readerEl.children[0];
  await h.renderReader('B');
  assert.equal(h.readerEl.children.length, 1);
  assert.equal(h.readerEl.children[0].snapshotId, 'B');
  assert.equal(aRoot.isConnected, false);
  assert.equal(h.hostState.root.snapshotId, 'B');
  assert.equal(h.hostState.snapshot.snapshotId, 'B');
  assert.equal(h.state.selectedSnapshotId, 'B');
});

await check('rapid A to B race rejects stale late A result', async () => {
  const h = createRenderHarness();
  h.setLoad('A', makeSnapshot('A'));
  await h.renderReader('A');
  const a = deferred();
  const b = deferred();
  h.setLoad('A', a.promise);
  h.setLoad('B', b.promise);

  const renderA = h.renderReader('A');
  const renderB = h.renderReader('B');
  b.resolve(makeSnapshot('B'));
  await renderB;
  a.resolve(makeSnapshot('A'));
  await renderA;

  assert.equal(h.readerEl.children.length, 1);
  assert.equal(h.readerEl.children[0].snapshotId, 'B');
  assert.equal(h.state.currentReaderSnapshot.snapshotId, 'B');
  assert.equal(h.hostState.mountCount, 2, 'stale refreshed A must never reuse or remount after B');
});

await check('Reader to non-Reader race invalidates the pending Reader result', async () => {
  const h = createRenderHarness();
  h.setLoad('A', makeSnapshot('A'));
  await h.renderReader('A');
  const a = deferred();
  h.setLoad('A', a.promise);
  const renderA = h.renderReader('A');
  h.location.hash = '#/library';
  h.leaveReader('test:library-race');
  a.resolve(makeSnapshot('A'));
  await renderA;
  assert.equal(h.readerEl.children.length, 0);
  assert.equal(h.hostState.mountCount, 1, 'late refreshed A must not reuse or remount after route leave');
  assert.equal(h.state.currentReaderSnapshot, null);
});

await check('Reader leave and same/different snapshot returns remain single-mounted', async () => {
  const h = createRenderHarness();
  h.setLoad('A', makeSnapshot('A'));
  h.setLoad('B', makeSnapshot('B'));
  await h.renderReader('A');
  const aRoot = h.readerEl.children[0];
  h.location.hash = '#/library';
  h.leaveReader('test:library');
  assert.equal(h.readerEl.children.length, 0);
  assert.equal(aRoot.isConnected, false);
  assert.equal(h.hostState.root, null);
  assert.equal(h.state.currentReaderSnapshot, null);

  await h.renderReader('A');
  assert.equal(h.readerEl.children.length, 1);
  assert.equal(h.readerEl.children[0].snapshotId, 'A');
  h.location.hash = '#/library';
  h.leaveReader('test:library-repeat');

  await h.renderReader('B');
  assert.equal(h.readerEl.children.length, 1);
  assert.equal(h.readerEl.children[0].snapshotId, 'B');
  assert.equal(h.hostState.snapshot.snapshotId, 'B');
});

await check('route teardown preserves requested non-Reader hash', () => {
  const h = createRouteHashHarness();
  h.leave('test:library');
  assert.equal(h.getUnmounts(), 1);
  assert.equal(h.location.pathname, '/studio.html');
  assert.equal(h.location.hash, '#/library');
  assert.equal(h.readerEl.children.length, 0);
  assert.equal(h.oldRoot.isConnected, false);
});

await check('failed and empty snapshot refreshes remain non-accumulating', async () => {
  const h = createRenderHarness();
  const empty = makeSnapshot('empty', 'chat-empty', []);
  h.setLoad('empty', empty);
  h.setLoad('missing', null);
  await h.renderReader('empty');
  await h.renderReader('empty');
  assert.equal(h.readerEl.children.length, 1);
  assert.equal(h.readerEl.children[0].snapshotId, 'empty');
  await h.renderReader('missing');
  assert.equal(h.readerEl.children.length, 0);
  assert.equal(h.hostState.root, null);
  assert.equal(h.state.currentReaderSnapshot, null);
  assert.match(h.readerEl.innerHTML, /Snapshot not found/);
  const error = deferred();
  h.setLoad('error', error.promise);
  const errorRender = h.renderReader('error');
  error.reject(new Error('load failed'));
  await errorRender;
  assert.equal(h.readerEl.children.length, 0);
  assert.equal(h.hostState.root, null);
  assert.equal(h.state.currentReaderSnapshot, null);
  assert.match(h.readerEl.innerHTML, /load failed/);
});

await check('current-root guard rejects detached or superseded async work', async () => {
  const h = createRenderHarness();
  h.setLoad('A', makeSnapshot('A'));
  h.setLoad('B', makeSnapshot('B'));
  await h.renderReader('A');
  const aRoot = h.readerEl.children[0];
  const aSnap = h.state.currentReaderSnapshot;
  assert.equal(h.isCurrentReaderRoot(aRoot, aSnap), true);
  await h.renderReader('B');
  assert.equal(h.isCurrentReaderRoot(aRoot, aSnap), false);
  assert.equal(h.isCurrentReaderRoot(h.readerEl.children[0], h.state.currentReaderSnapshot), true);
  h.leaveReader();
  assert.equal(h.isCurrentReaderRoot(aRoot, aSnap), false);
});

await check('S0D3e repeated mount/unmount keeps only connected current roots', () => {
  const h = createHostHarness();
  const makeRoots = (name) => {
    const root = new FakeNode(name);
    const turns = new FakeNode(`${name}-turns`);
    const scroll = new FakeNode(`${name}-scroll`);
    root.appendChild(turns);
    root.appendChild(scroll);
    root.setConnected(true);
    return { root, turns, scroll };
  };
  const a = makeRoots('A');
  const b = makeRoots('B');
  h.api.mount({ readerRoot: a.root, turnsEl: a.turns, scrollEl: a.scroll, snapshot: makeSnapshot('A') });
  assert.equal(h.api.getReaderRoot(), a.root);
  assert.equal(a.root.getAttribute('data-h2o-studio-reader'), '1');
  assert.equal(a.scroll.getAttribute('data-scroll-root'), '1');
  assert.equal(h.W.H2O.util.getChatId(), 'chat-A');

  h.api.mount({ readerRoot: b.root, turnsEl: b.turns, scrollEl: b.scroll, snapshot: makeSnapshot('B') });
  assert.equal(a.root.getAttribute('data-h2o-studio-reader'), null);
  assert.equal(a.scroll.getAttribute('data-scroll-root'), null);
  assert.equal(h.api.getReaderRoot(), b.root);
  assert.equal(h.api.getTurnsRoot(), b.turns);
  assert.equal(h.api.getScrollRoot(), b.scroll);
  assert.equal(h.W.H2O.util.getChatId(), 'chat-B');

  const freshB = structuredClone(makeSnapshot('B'));
  freshB.meta.folderId = 'presentation-only';
  assert.equal(h.api.updateSnapshot(freshB), true, 'current same-route snapshot should update without remount');
  assert.equal(h.api.getReaderRoot(), b.root, 'snapshot publication must preserve the mounted root');
  assert.equal(h.W.H2O.util.getChatId(), 'chat-B');
  assert.equal(h.api.updateSnapshot(makeSnapshot('C')), false, 'different-route snapshot must not replace host state');

  b.root.isConnected = false;
  assert.equal(h.api.getReaderRoot(), null, 'disconnected roots must not be exposed');
  b.root.isConnected = true;
  assert.equal(h.api.unmount('test:leave'), true);
  assert.equal(h.api.getReaderRoot(), null);
  assert.equal(h.api.getTurnsRoot(), null);
  assert.equal(h.api.getScrollRoot(), null);
  assert.equal(b.root.getAttribute('data-h2o-studio-reader'), null);
  assert.equal(b.scroll.getAttribute('data-scroll-root'), null);
  assert.equal(h.W.H2O.util.getChatId(), 'native-chat');
  assert.equal(h.api.unmount('test:repeat'), false);

  const aAgain = makeRoots('A-again');
  h.api.mount({
    readerRoot: aAgain.root,
    turnsEl: aAgain.turns,
    scrollEl: aAgain.scroll,
    snapshot: makeSnapshot('A-again'),
  });
  assert.equal(h.api.getReaderRoot(), aAgain.root);
  assert.equal(h.W.H2O.util.getChatId(), 'chat-A-again');
});

await check('S0D3e snapshot publication rejects detached and inconsistent mounted roots', () => {
  const h = createHostHarness();
  const root = new FakeNode('validity-root');
  const turns = new FakeNode('validity-turns');
  const scroll = new FakeNode('validity-scroll');
  root.appendChild(turns);
  root.appendChild(scroll);
  root.setConnected(true);
  const initial = makeSnapshot('A');
  h.api.mount({ readerRoot: root, turnsEl: turns, scrollEl: scroll, snapshot: initial });
  const accepted = structuredClone(initial);
  accepted.meta.folderId = 'accepted-presentation';
  assert.equal(h.api.updateSnapshot(accepted), true);
  assert.equal(h.getSnapshot(), accepted);

  const rejected = structuredClone(initial);
  rejected.meta.folderId = 'must-not-publish';
  const assertRejectedWithoutMutation = (label) => {
    assert.equal(h.api.updateSnapshot(rejected), false, label);
    assert.equal(h.getSnapshot(), accepted, `${label}: host snapshot must remain unchanged`);
  };

  root.setConnected(false);
  assertRejectedWithoutMutation('detached Reader root must reject publication');
  root.setConnected(true);

  turns.setConnected(false);
  assertRejectedWithoutMutation('detached turns root must reject publication');
  turns.setConnected(true);

  scroll.setConnected(false);
  assertRejectedWithoutMutation('detached scroll root must reject publication');
  scroll.setConnected(true);

  root.children = [];
  assertRejectedWithoutMutation('roots outside the Reader ownership tree must reject publication');
  root.children = [turns, scroll];

  root.removeAttribute('data-h2o-studio-reader');
  assertRejectedWithoutMutation('missing Reader lifecycle marker must reject publication');
  root.setAttribute('data-h2o-studio-reader', '1');

  assert.equal(h.api.updateSnapshot(makeSnapshot('B')), false, 'route identity mismatch must reject publication');
  assert.equal(h.getSnapshot(), accepted, 'route mismatch must preserve the current host snapshot');
});

await check('non-Reader routes and late overlay work use lifecycle guards', () => {
  for (const route of ['library', 'migrate', 'settings']) {
    assert.match(studioSource, new RegExp(`studioHostUnmountPreservingRouteHash\\("studio:route-${route}"\\)`));
    const branch = new RegExp(
      `if \\(route\\.name === "${route}"\\) \\{[\\s\\S]*?state\\.renderToken \\+= 1;[\\s\\S]*?studioHostUnmountPreservingRouteHash\\("studio:route-${route}"\\)`
    );
    assert.match(studioSource, branch, `${route} route must invalidate pending Reader work before teardown`);
  }
  const overlayGuard = studioSource.indexOf('if (!isCurrentReaderRoot(root, snap)) return;');
  const overlayApply = studioSource.indexOf('__applier(root, snap, __overlay || null)');
  assert.ok(overlayGuard >= 0 && overlayGuard < overlayApply,
    'late overlay result must be gated before it can touch a superseded base root');
});

/* M03 P4 S4C T8 slice B - the Reader current-render bridge carries the
 * DecorationContribution lifecycle and the real unmount seam disposes it. */
await check('S4C: current-render bridge exposes the exact Semantic Index + DecorationContribution lifecycle of the mounted render; wrong root -> null', async () => {
  const h = createRenderHarness();
  assert.equal(h.getReaderSemanticIndex(), null); assert.equal(h.getReaderDecorationContributions(), null, 'no active Reader render -> null');
  h.setLoad('A', makeSnapshot('A'));
  await h.renderReader('A');
  const root = h.readerEl.children[0];
  const lifecycle = h.lifecycles[0];
  assert.equal(h.state.currentReaderRender.root, root, 'bound to the mounted Renderer root');
  assert.equal(h.getReaderDecorationContributions(root), lifecycle, 'A: the exact lifecycle the Renderer result carried');
  assert.equal(h.getReaderDecorationContributions(), lifecycle, 'unqualified call answers for the current render');
  assert.equal(h.getReaderSemanticIndex(root), lifecycle.semanticIndex, 'the index of the same render');
  assert.equal(h.getReaderDecorationContributions(new FakeNode('foreign')), null, 'B: wrong root -> null'); assert.equal(h.getReaderDecorationContributions(null), null); assert.equal(h.getReaderSemanticIndex(new FakeNode('foreign')), null);
  /* M04 P2 T4: the binding also retains the render's presentation descriptor (was ['root', 'semanticIndex', 'decorationContributions']). */
  assert.deepEqual(Object.keys(h.state.currentReaderRender), ['root', 'semanticIndex', 'decorationContributions', 'presentation'], 'one bounded current-render record'); assert.equal(Object.isFrozen(h.state.currentReaderRender), true);
  assert.deepEqual({ effectiveId: h.state.currentReaderRender.presentation.effectiveId, digest: typeof h.state.currentReaderRender.presentation.registryDigest }, { effectiveId: 'chatgpt-reference', digest: 'string' }, 'the mounted descriptor of the default render');
  /* missing lifecycle on a result -> null, never manufactured */
  h.bindReaderSemanticIndex({ root, semanticIndex: lifecycle.semanticIndex });
  assert.equal(h.getReaderDecorationContributions(root), null, 'missing lifecycle -> null'); assert.equal(h.getReaderSemanticIndex(root), lifecycle.semanticIndex);
  h.bindReaderSemanticIndex({ root, semanticIndex: lifecycle.semanticIndex, decorationContributions: lifecycle });
  assert.equal(lifecycle.disposeAllCalls, 0, 'binding never disposes');
});

await check('S4C: Reader unmount disposes the current lifecycle exactly once BEFORE clearing the binding; replacement and route leave dispose only their own render', async () => {
  const h = createRenderHarness();
  h.setLoad('A', makeSnapshot('A'));
  h.setLoad('B', makeSnapshot('B'));
  await h.renderReader('A');
  const [lifeA] = h.lifecycles;
  await h.renderReader('B');
  const lifeB = h.lifecycles[1];
  assert.equal(lifeA.disposeAllCalls, 1, 'C: A disposed once when B replaced it'); assert.equal(lifeA.bindingAtDispose[0]?.decorationContributions, lifeA, 'C: the binding was still A at disposal time (cleanup precedes forgetting)');
  assert.equal(lifeB.disposeAllCalls, 0, 'B is alive'); assert.equal(h.getReaderDecorationContributions(h.readerEl.children[0]), lifeB);
  await h.renderReader('B');
  assert.equal(lifeB.disposeAllCalls, 0, 'an equivalent fast refresh keeps B mounted and undisposed'); assert.equal(h.lifecycles.length, 2);
  h.leaveReader('test:leave');
  assert.equal(lifeB.disposeAllCalls, 1, 'C: route leave disposes B once'); assert.equal(lifeA.disposeAllCalls, 1, 'A is not disposed again');
  assert.equal(h.state.currentReaderRender, null, 'binding cleared after disposal'); assert.equal(h.getReaderDecorationContributions(), null); assert.equal(h.getReaderSemanticIndex(), null);
  h.leaveReader('test:leave-again');
  assert.equal(lifeB.disposeAllCalls, 1, 'a repeated discard finds nothing to dispose'); assert.deepEqual(h.warnings, []);
});

await check('S4C: a failing decoration cleanup is diagnosed and never blocks Reader teardown', async () => {
  const h = createRenderHarness();
  h.setLoad('A', makeSnapshot('A'));
  h.setLoad('B', makeSnapshot('B'));
  await h.renderReader('A');
  const [lifeA] = h.lifecycles;
  h.failNextDisposeAll();
  await h.renderReader('B');
  assert.equal(lifeA.disposeAllCalls, 1, 'D: cleanup attempted once'); assert.equal(h.warnings.length, 1, 'D: failure diagnosed'); assert.match(h.warnings[0], /reader decoration cleanup reported a failure/);
  assert.equal(h.readerEl.children.length, 1); assert.equal(h.readerEl.children[0].snapshotId, 'B', 'D: teardown and replacement continued'); assert.equal(h.hostState.unmountCount, 1); assert.equal(h.state.currentReaderRender.decorationContributions, h.lifecycles[1], 'the new render is bound');
  h.failNextDisposeAll();
  h.leaveReader('test:leave');
  assert.equal(h.lifecycles[1].disposeAllCalls, 1); assert.equal(h.warnings.length, 2); assert.equal(h.state.currentReaderRender, null, 'D: binding cleared despite the failure'); assert.equal(h.readerEl.children.length, 0); assert.equal(h.hostState.unmountCount, 2);
  /* static: order inside the seam + no double dispose path */
  const unmount = extractFunction(studioSource, 'studioHostUnmount');
  assert.ok(unmount.indexOf('disposeReaderRenderDecorations(reason);') < unmount.indexOf('state.currentReaderRender = null;'), 'C: dispose precedes forgetting the binding');
  assert.equal((studioSource.match(/disposeReaderRenderDecorations\(/g) || []).length, 2, 'exactly one disposal call site (definition + studioHostUnmount)');
  assert.doesNotMatch(extractFunction(studioSource, 'disposeReaderRenderDecorations'), /querySelector|getElementById|scrollTo|location\.|createLifecycle/, 'the disposer only reaches the bound lifecycle');
});

await check('mounted Reader listener retains only primitive snapshot identity', () => {
  assert.match(studioSource, /const mountedSnapshotId = String\(snap\?\.snapshotId \|\| ''\);/);
  assert.match(studioSource, /String\(currentSnap\.snapshotId \|\| ''\) === mountedSnapshotId/);
});

/* M04 P2 T4 (HDA decision C) - Reader consumption of the presentation
 * preference through the real seams: render call, current binding, reuse
 * predicate, one application-lifetime Appearance subscription and the guarded
 * refresh. Every scenario runs the REAL renderReader / canReuseReaderDOM /
 * refreshReaderPresentation / subscribeReaderToPresentationPreference. */
const readerTurnaround = () => new Promise((resolve) => setTimeout(resolve, 0));
const tick = async () => { for (let i = 0; i < 12; i += 1) await readerTurnaround(); };

await check('T4: the render passes the current preference; the binding keeps the descriptor; the same effective configuration reuses (renderReader and refresh are no-ops)', async () => {
  const h = createRenderHarness();
  h.setLoad('A', makeSnapshot('A'));
  h.subscribeReader();
  assert.equal(typeof h.state.readerPresentationUnsubscribe, 'function', 'unsubscribe handle retained');
  assert.equal(h.appearanceSubscribers.size, 1, 'exactly one application-lifetime subscription');
  h.subscribeReader();
  assert.equal(h.appearanceSubscribers.size, 1, 'a repeated install is a no-op');
  await h.renderReader('A');
  const root = h.readerEl.children[0];
  assert.deepEqual(h.renders, [{ snapshotId: 'A', effectiveId: 'chatgpt-reference', requestedId: 'chatgpt-reference' }], 'the render received the current preference');
  assert.equal(h.state.currentReaderRender.presentation.effectiveId, 'chatgpt-reference');
  await h.renderReader('A');
  assert.equal(h.readerEl.children[0], root, 'same effective configuration: root reused'); assert.equal(h.hostState.mountCount, 1); assert.equal(h.renders.length, 1);
  h.refreshReaderPresentation();
  await tick();
  assert.equal(h.readerEl.children[0], root, 'refresh with the same configuration: no-op'); assert.equal(h.renders.length, 1);
  h.notifyUnrelated();
  await tick();
  assert.equal(h.renders.length, 1, 'other Appearance keys never refresh the Reader');
});

await check('T4: a different effective configuration disposes and rebuilds; committed A -> B -> A rebuilds twice with no old-root cache', async () => {
  const h = createRenderHarness();
  h.setLoad('A', makeSnapshot('A'));
  h.subscribeReader();
  await h.renderReader('A');
  const rootA1 = h.readerEl.children[0];
  const lifeA1 = h.lifecycles[0];
  h.setPresentationPreference('h2o-clean-reader');
  await tick();
  const rootB = h.readerEl.children[0];
  assert.notEqual(rootB, rootA1, 'changed configuration rebuilds'); assert.equal(rootA1.isConnected, false, 'the old root is discarded');
  assert.equal(lifeA1.disposeAllCalls, 1, 'the replaced render was disposed exactly once'); assert.equal(lifeA1.bindingAtDispose[0]?.decorationContributions, lifeA1, 'cleanup before forgetting');
  assert.deepEqual(h.renders.map((r) => r.effectiveId), ['chatgpt-reference', 'h2o-clean-reader']);
  assert.equal(h.state.currentReaderRender.presentation.effectiveId, 'h2o-clean-reader', 'the binding follows the new render');
  assert.equal(h.hostState.mountCount, 2);
  h.setPresentationPreference('chatgpt-reference');
  await tick();
  const rootA2 = h.readerEl.children[0];
  assert.ok(rootA2 !== rootB && rootA2 !== rootA1, 'committed A -> B -> A: the second A is a fresh render, never the cached first root');
  assert.deepEqual(h.renders.map((r) => r.effectiveId), ['chatgpt-reference', 'h2o-clean-reader', 'chatgpt-reference']); assert.equal(h.hostState.mountCount, 3);
  assert.equal(h.lifecycles[1].disposeAllCalls, 1); assert.equal(h.lifecycles[2].disposeAllCalls, 0); assert.equal(h.readerEl.children.length, 1);
});

await check('T4: rapid A -> B -> A before B commits keeps A (the outstanding render reads the preference at its decision); a stale B never installs', async () => {
  const h = createRenderHarness();
  h.setLoad('A', makeSnapshot('A'));
  h.subscribeReader();
  await h.renderReader('A');
  const root = h.readerEl.children[0];
  h.setPresentationPreference('h2o-clean-reader');   /* refresh starts and awaits its load */
  h.setPresentationPreference('chatgpt-reference'); /* bounced back before B committed */
  await tick();
  assert.equal(h.readerEl.children[0], root, 'A stays mounted'); assert.equal(h.hostState.mountCount, 1, 'no rebuild');
  assert.deepEqual(h.renders.map((r) => r.effectiveId), ['chatgpt-reference'], 'B was never rendered');
  assert.equal(h.state.currentReaderRender.presentation.effectiveId, 'chatgpt-reference');
  /* A -> B -> unknown while B is outstanding: the unknown choice resolves to
   * the mounted reference configuration, so nothing rebuilds and B never installs. */
  h.setPresentationPreference('h2o-clean-reader');
  h.setPresentationPreference('unknown-profile');
  await tick();
  assert.deepEqual(h.renders.map((r) => r.effectiveId), ['chatgpt-reference'], 'an unknown choice that resolves to the mounted configuration reuses; the outstanding B never installs');
  assert.equal(h.hostState.mountCount, 1); assert.equal(h.readerEl.children[0], root);
  /* A -> B -> C (all distinct) while B is outstanding: only C renders. */
  h.setPresentationPreference('h2o-clean-reader');
  h.setPresentationPreference('chatgpt-reference');
  h.setPresentationPreference('h2o-clean-reader');
  await tick();
  assert.deepEqual(h.renders.map((r) => r.effectiveId), ['chatgpt-reference', 'h2o-clean-reader'], 'the final selection renders once');
  assert.equal(h.hostState.mountCount, 2); assert.equal(h.state.currentReaderRender.presentation.effectiveId, 'h2o-clean-reader');
});

await check('T4: hydration to the same effective profile never rebuilds; hydration to a different profile is a guarded refresh; a pre-seal null token never equals a mounted descriptor', async () => {
  const h = createRenderHarness();
  h.setLoad('A', makeSnapshot('A'));
  h.subscribeReader();
  /* unsealed registries: nothing mounted -> never "current" */
  assert.equal(h.isReaderPresentationCurrent('chatgpt-reference'), false, 'no mounted render -> not current');
  await h.renderReader('A');
  const root = h.readerEl.children[0];
  h.hydrate('chatgpt-reference');
  await tick();
  assert.equal(h.readerEl.children[0], root, 'ready with the same effective profile: no rebuild'); assert.equal(h.hostState.mountCount, 1);
  h.rendererState.sealed = false; /* a describePresentation() answer without a sealed token */
  assert.equal(h.isReaderPresentationCurrent('chatgpt-reference'), false, 'pre-seal null digest never equals the mounted sealed descriptor');
  h.rendererState.sealed = true;
  assert.equal(h.isReaderPresentationCurrent('chatgpt-reference'), true); assert.equal(h.isReaderPresentationCurrent(''), true, 'absent request resolves to the mounted default'); assert.equal(h.isReaderPresentationCurrent('no-such-profile'), true, 'unknown request resolves to the mounted reference');
  assert.equal(h.isReaderPresentationCurrent('h2o-clean-reader'), false);
  const h2 = createRenderHarness();
  h2.setLoad('A', makeSnapshot('A'));
  h2.subscribeReader();
  await h2.renderReader('A');
  const first = h2.readerEl.children[0];
  h2.hydrate('h2o-clean-reader');
  await tick();
  assert.notEqual(h2.readerEl.children[0], first, 'ready that hydrated a different profile refreshes the open Reader'); assert.equal(h2.renders[1].effectiveId, 'h2o-clean-reader'); assert.equal(h2.hostState.mountCount, 2);
});

await check('T4: route leave and stale continuations keep the existing guards authoritative; no Reader means no refresh', async () => {
  const h = createRenderHarness();
  h.setLoad('A', makeSnapshot('A'));
  h.subscribeReader();
  h.setPresentationPreference('h2o-clean-reader');
  await tick();
  assert.equal(h.renders.length, 0, 'no open Reader: a preference change renders nothing');
  await h.renderReader('A');
  assert.equal(h.renders[0].effectiveId, 'h2o-clean-reader', 'the first render used the preference in force');
  h.leaveReader('test:leave');
  assert.equal(h.state.currentReaderRender, null);
  h.setPresentationPreference('chatgpt-reference');
  await tick();
  assert.equal(h.renders.length, 1, 'after route leave a preference change renders nothing'); assert.equal(h.readerEl.children.length, 0);
  /* stale continuation: a refresh render superseded by a route leave never installs */
  await h.renderReader('A');
  const root = h.readerEl.children[0];
  h.setPresentationPreference('h2o-clean-reader'); /* refresh in flight */
  h.leaveReader('test:leave-during-refresh');
  await tick();
  assert.equal(h.readerEl.children.length, 0, 'the superseded refresh installed nothing'); assert.equal(h.state.currentReaderRender, null); assert.equal(root.isConnected, false);
  assert.equal(h.renders.length, 2, 'no render happened after the leave');
  assert.equal(typeof h.state.readerPresentationUnsubscribe, 'function');
  h.state.readerPresentationUnsubscribe();
  assert.equal(h.appearanceSubscribers.size, 0, 'the retained handle unsubscribes');
});

const total = PASS.length + FAIL.length;

console.log(`\n[validate-studio-renderer-lifecycle-idempotence] ${PASS.length}/${total} passed`);
for (const label of PASS) console.log(`  ✓ ${label}`);
if (FAIL.length) {
  console.log('');
  for (const row of FAIL) console.log(`  ✗ ${row.label}\n${row.error}`);
  process.exit(1);
}
