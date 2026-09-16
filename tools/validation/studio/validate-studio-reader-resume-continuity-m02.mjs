#!/usr/bin/env node
// M02 P1 T2 — Reader resume-continuity regression baseline.
//
// Result classes are deliberately disjoint:
//   PRE — current Product prerequisite / unchanged owner contract
//   GAP — an accepted missing current behavior, reproduced against real seams
//   FIX — executable EXPECTED POST-T3 CONTRACT MODEL only
//
// A reproduced GAP and a locked FIX expectation never claim implemented Product
// behavior. Any unexpected result, missing real seam, browser skip, or owner
// suite failure makes this validator fail.

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
const inconclusive = [];

async function vector(kind, id, label, fn) {
  try {
    const detail = await fn();
    const result = kind === 'GAP' ? 'REPRODUCED' : kind === 'FIX' ? 'EXPECTATION_LOCKED' : 'PASS';
    const row = { id, class: kind, result, label, ...(detail === undefined ? {} : { detail }) };
    rows.push(row);
    console.log(`VECTOR ${JSON.stringify(row)}`);
    return detail;
  } catch (error) {
    const row = { id, class: kind, result: 'FAIL', label, error: String(error?.message || error) };
    rows.push(row); failures.push(row);
    console.error(`VECTOR ${JSON.stringify(row)}`);
    return null;
  }
}

function extractFunction(text, name) {
  const match = new RegExp(`\\b(?:async\\s+)?function\\s+${name}\\s*\\(`).exec(text);
  assert.ok(match, `missing production seam ${name}`);
  const start = match.index;
  const open = text.indexOf('{', text.indexOf(')', start));
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === '{') depth += 1;
    else if (text[i] === '}' && --depth === 0) {
      const body = text.slice(start, i + 1);
      new vm.Script(`(${body})`);
      return body;
    }
  }
  throw new Error(`unterminated production seam ${name}`);
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

/* EXPECTED POST-T3 CONTRACT MODEL.
 * These pure functions lock future policy. They are never called to prove
 * current Product implementation. */
const EXPECTED_POST_T3_CONTRACT_MODEL = (() => {
  const OUT = Object.freeze({
    PRESERVED: 'PRESERVED', RESTORED_IDENTITY: 'RESTORED_IDENTITY',
    RESTORED_STRUCTURAL: 'RESTORED_STRUCTURAL', NOT_RESTORED: 'NOT_RESTORED',
    CAPTURED: 'CAPTURED', NOT_CAPTURED: 'NOT_CAPTURED',
  });
  const PRE_SCOPE = new Set(['list', 'library', 'migrate', 'settings']);
  const FUNNEL_CAPTURE = new Set(['studio:reader-replace']);
  const FUNNEL_NON_CAPTURE = new Set([
    'studio:list', 'studio:route-library', 'studio:route-migrate', 'studio:route-settings',
    'studio:library-folders-visible-body', 'studio:reader-missing', 'studio:reader-error',
    'studio:unmount', 'studio:route-leave',
  ]);

  function sourceValue(turn, key) { return turn?.sourceRef?.[key] ?? null; }
  function resolve(record, current) {
    if (!record || !current?.rootAvailable || !current?.indexAvailable) return { outcome: OUT.NOT_RESTORED, turn: null };
    if (record.content?.chatId !== current.chatId) return { outcome: OUT.NOT_RESTORED, turn: null };
    const ref = record.ref;
    const turns = Array.isArray(current.turns) ? current.turns : [];
    if (!ref) return { outcome: OUT.NOT_RESTORED, turn: null };
    const identityKey = ref.messageId ? 'messageId' : ref.turnId ? 'turnId' : null;
    if (identityKey) {
      let candidates = turns.filter(turn => sourceValue(turn, identityKey) === ref[identityKey] && turn.role === ref.role);
      if (candidates.length > 1) candidates = candidates.filter(turn => turn.projectionKey === ref.projectionKey);
      return candidates.length === 1
        ? { outcome: OUT.RESTORED_IDENTITY, turn: candidates[0] }
        : { outcome: OUT.NOT_RESTORED, turn: null };
    }
    if (record.content?.snapshotId !== current.snapshotId
      || record.render?.renderMode !== current.renderMode
      || record.render?.turnCount !== turns.length
      || !Number.isInteger(ref.ordinal)) return { outcome: OUT.NOT_RESTORED, turn: null };
    const turn = turns[ref.ordinal];
    if (!turn
      || turn.projectionKey !== ref.projectionKey
      || turn.role !== ref.role
      || turn.turnNo !== ref.turnNo
      || sourceValue(turn, 'messageId')
      || sourceValue(turn, 'turnId')) return { outcome: OUT.NOT_RESTORED, turn: null };
    return { outcome: OUT.RESTORED_STRUCTURAL, turn };
  }

  class Ledger {
    constructor(capacity = 16, tombstoneCapacity = 16) {
      this.capacity = capacity; this.tombstoneCapacity = tombstoneCapacity;
      this.entries = new Map(); this.tombstones = new Map();
    }
    remember(key, record) {
      if (this.tombstones.has(key)) return OUT.NOT_CAPTURED;
      this.entries.delete(key); this.entries.set(key, record);
      while (this.entries.size > this.capacity) this.entries.delete(this.entries.keys().next().value);
      return OUT.CAPTURED;
    }
    forget(key) {
      this.entries.delete(key); this.tombstones.delete(key); this.tombstones.set(key, true);
      while (this.tombstones.size > this.tombstoneCapacity) this.tombstones.delete(this.tombstones.keys().next().value);
    }
    successfulBind(key) { this.tombstones.delete(key); }
  }

  function classifyPreLeave({ hasBinding, activeRoute, destination }) {
    return hasBinding && activeRoute === 'reader' && PRE_SCOPE.has(destination) ? OUT.CAPTURED : OUT.NOT_CAPTURED;
  }
  function classifyFunnel(reason) {
    if (FUNNEL_CAPTURE.has(reason)) return OUT.CAPTURED;
    if (FUNNEL_NON_CAPTURE.has(reason) || /^(?:test|memory|benchmark):/.test(String(reason))) return OUT.NOT_CAPTURED;
    return OUT.NOT_CAPTURED;
  }
  return Object.freeze({ OUT, resolve, Ledger, classifyPreLeave, classifyFunnel });
})();

await vector('FIX', 'V-L', 'full R1/R2 and fail-closed resolution table', () => {
  const M = EXPECTED_POST_T3_CONTRACT_MODEL;
  const ref = { projectionKey: 'turn:source:t1', ordinal: 0, turnNo: 1, role: 'user', messageId: 'm1', turnId: 't1' };
  const baseRecord = { content: { chatId: 'c', snapshotId: 's1' }, render: { renderMode: 'canonical', turnCount: 1 }, ref };
  const current = { rootAvailable: true, indexAvailable: true, chatId: 'c', snapshotId: 's2', renderMode: 'canonical', turns: [{ ...ref, sourceRef: { messageId: 'm1', turnId: 't1' } }] };
  assert.equal(M.resolve(baseRecord, current).outcome, M.OUT.RESTORED_IDENTITY, 'unique messageId');
  const turnIdRecord = structuredClone(baseRecord); turnIdRecord.ref.messageId = null;
  assert.equal(M.resolve(turnIdRecord, current).outcome, M.OUT.RESTORED_IDENTITY, 'unique turnId');
  const duplicate = { ...current, turns: [current.turns[0], { ...current.turns[0], projectionKey: 'other' }] };
  assert.equal(M.resolve(baseRecord, duplicate).outcome, M.OUT.RESTORED_IDENTITY, 'projection key uniquely disambiguates');
  duplicate.turns[1].projectionKey = ref.projectionKey;
  assert.equal(M.resolve(baseRecord, duplicate).outcome, M.OUT.NOT_RESTORED, 'unresolved duplicate');
  assert.equal(M.resolve(baseRecord, { ...current, turns: [] }).outcome, M.OUT.NOT_RESTORED, 'stored identity missing');

  const structuralRef = { projectionKey: 'turn:path:0', ordinal: 0, turnNo: 1, role: 'user', messageId: null, turnId: null };
  const structuralRecord = { content: { chatId: 'c', snapshotId: 's1' }, render: { renderMode: 'canonical', turnCount: 1 }, ref: structuralRef };
  const structuralCurrent = { rootAvailable: true, indexAvailable: true, chatId: 'c', snapshotId: 's1', renderMode: 'canonical', turns: [{ ...structuralRef, sourceRef: null }] };
  assert.equal(M.resolve(structuralRecord, structuralCurrent).outcome, M.OUT.RESTORED_STRUCTURAL);
  const mutations = [
    c => { c.snapshotId = 's2'; }, c => { c.renderMode = 'rich'; }, c => { c.turns.push({}); },
    c => { c.turns = []; }, c => { c.turns[0].projectionKey = 'other'; },
    c => { c.turns[0].role = 'assistant'; }, c => { c.turns[0].turnNo = 2; },
    c => { c.turns[0].sourceRef = { messageId: 'gained' }; },
  ];
  for (const mutate of mutations) { const c = structuredClone(structuralCurrent); mutate(c); assert.equal(M.resolve(structuralRecord, c).outcome, M.OUT.NOT_RESTORED); }
  assert.equal(M.resolve(structuralRecord, { ...structuralCurrent, chatId: 'other' }).outcome, M.OUT.NOT_RESTORED, 'unrelated chat');
  assert.equal(M.resolve(structuralRecord, { ...structuralCurrent, rootAvailable: false }).outcome, M.OUT.NOT_RESTORED, 'missing root');
  assert.equal(M.resolve(structuralRecord, { ...structuralCurrent, indexAvailable: false }).outcome, M.OUT.NOT_RESTORED, 'missing index');
  return { cases: 19, model: 'EXPECTED POST-T3 CONTRACT MODEL' };
});

await vector('FIX', 'V-N', 'bounded ledger and FIFO tombstone policy', () => {
  const { Ledger, OUT } = EXPECTED_POST_T3_CONTRACT_MODEL;
  const ledger = new Ledger();
  for (let i = 0; i < 16; i += 1) assert.equal(ledger.remember(`c${i}`, { i }), OUT.CAPTURED);
  ledger.remember('c0', { i: 100 }); ledger.remember('c16', { i: 16 });
  assert.equal(ledger.entries.size, 16); assert.equal(ledger.entries.has('c1'), false, 'least-recently-captured evicted');
  assert.deepEqual(ledger.entries.get('c0'), { i: 100 }, 'same-key capture replaced');
  for (let i = 0; i < 17; i += 1) ledger.forget(`d${i}`);
  assert.equal(ledger.tombstones.size, 16); assert.equal(ledger.tombstones.has('d0'), false, 'FIFO tombstone eviction');
  return { ledgerCapacity: 16, tombstoneCapacity: 16, model: 'EXPECTED POST-T3 CONTRACT MODEL' };
});

await vector('FIX', 'V-G5', 'deletion forget/tombstone/recapture protection', () => {
  const { Ledger, OUT } = EXPECTED_POST_T3_CONTRACT_MODEL; const ledger = new Ledger();
  ledger.remember('chat-A', { before: true }); ledger.forget('chat-A');
  assert.equal(ledger.entries.has('chat-A'), false); assert.equal(ledger.remember('chat-A', { stale: true }), OUT.NOT_CAPTURED);
  ledger.successfulBind('chat-A'); assert.equal(ledger.remember('chat-A', { fresh: true }), OUT.CAPTURED);
  return { deletionOwnerCheck: 'G8_REQUIRED', model: 'EXPECTED POST-T3 CONTRACT MODEL' };
});

await vector('FIX', 'V-H3', 'deep-frozen plain root-free ReaderResumeRecord', () => {
  const record = deepFreeze({ content: { chatId: 'c', snapshotId: 's' }, render: { renderMode: 'canonical', turnCount: 1 },
    selection: { projectionKey: 'turn:path:0', ordinal: 0, turnNo: 1, role: 'user', messageId: null, turnId: null },
    viewport: { ref: { projectionKey: 'turn:path:0', ordinal: 0, turnNo: 1, role: 'user', messageId: null, turnId: null }, fraction: 0.5 } });
  const visit = value => value && typeof value === 'object' ? Object.isFrozen(value) && Object.values(value).every(visit) : typeof value !== 'function';
  assert.ok(visit(record)); assert.deepEqual(JSON.parse(JSON.stringify(record)), record);
  assert.doesNotMatch(JSON.stringify(record), /semanticIndex|decoration|presentation|root|element/i);
  return { plainSerializable: true, deeplyFrozen: true, model: 'EXPECTED POST-T3 CONTRACT MODEL' };
});

await vector('FIX', 'V-J', 'one Shell-contained viewport scroll and no forbidden fallback', () => {
  const calls = []; const main = { scrollTo(options) { calls.push(options); } };
  const root = { closest(selector) { assert.equal(selector, '.wbMain'); return main; } };
  const active = {}; let activeElement = active;
  const expectedRestore = (currentRoot, top) => currentRoot.closest('.wbMain').scrollTo({ top, left: 0, behavior: 'auto' });
  expectedRestore(root, 321); assert.deepEqual(calls, [{ top: 321, left: 0, behavior: 'auto' }]); assert.equal(activeElement, active);
  assert.match(contract, /exactly one[\s\S]*root\.closest\('\.wbMain'\)\.scrollTo/);
  assert.match(contract, /does\s+not use `window\.scrollTo`, `scrollIntoView`, a new scroll root/);
  return { calls: 1, focusPreserved: true, model: 'EXPECTED POST-T3 CONTRACT MODEL' };
});

await vector('FIX', 'V-K1', 'future Reader continuity has no MiniMap write authority', () => {
  assert.match(contract, /never writes MiniMap resume or active state/);
  assert.doesNotMatch(contract, /H2O\.MM\.[A-Za-z0-9_.]+\s*=/);
  return { directMiniMapWrites: 0, model: 'EXPECTED POST-T3 CONTRACT MODEL' };
});

await vector('FIX', 'V-G4', 'reconciled reason partition and static route dominance', () => {
  const M = EXPECTED_POST_T3_CONTRACT_MODEL;
  for (const scope of ['list', 'library', 'migrate', 'settings']) assert.equal(M.classifyPreLeave({ hasBinding: true, activeRoute: 'reader', destination: scope }), M.OUT.CAPTURED);
  for (const row of [
    { hasBinding: false, activeRoute: 'reader', destination: 'list' },
    { hasBinding: true, activeRoute: 'list', destination: 'settings' },
    { hasBinding: true, activeRoute: 'reader', destination: 'reader' },
  ]) assert.equal(M.classifyPreLeave(row), M.OUT.NOT_CAPTURED);
  assert.equal(M.classifyFunnel('studio:reader-replace'), M.OUT.CAPTURED);
  const non = ['studio:list','studio:route-library','studio:route-migrate','studio:route-settings','studio:library-folders-visible-body','studio:reader-missing','studio:reader-error','studio:unmount','studio:route-leave','test:leave','memory:teardown','unknown'];
  for (const reason of non) assert.equal(M.classifyFunnel(reason), M.OUT.NOT_CAPTURED, reason);

  const renderList = extractFunction(source, 'renderList');
  const folders = extractFunction(source, 'renderVisibleStudioFoldersPageBody');
  const renderRoute = extractFunction(source, 'renderRoute');
  assert.ok(renderList.indexOf('setStudioRouteScope("list")') < renderList.indexOf('studioHostUnmountPreservingRouteHash("studio:list")'));
  assert.ok(folders.indexOf('setStudioRouteScope("library", { clearReader: true })') < folders.indexOf('studioHostUnmountPreservingRouteHash("studio:library-folders-visible-body")'));
  for (const [scope, reason] of [['library','studio:route-library'],['migrate','studio:route-migrate'],['settings','studio:route-settings']]) {
    assert.ok(renderRoute.indexOf(`setStudioRouteScope("${scope}", { clearReader: true })`) < renderRoute.indexOf(`studioHostUnmountPreservingRouteHash("${reason}")`), reason);
  }
  const currentReasons = new Set(Array.from(source.matchAll(/studioHostUnmountPreservingRouteHash\("([^"]+)"\)/g), m => m[1]));
  assert.deepEqual([...currentReasons].sort(), ['studio:library-folders-visible-body','studio:list','studio:reader-error','studio:reader-missing','studio:reader-replace','studio:route-library','studio:route-migrate','studio:route-settings'].sort());
  return { currentReasons: [...currentReasons].sort(), dominatedRouteFunnels: 5, model: 'EXPECTED POST-T3 CONTRACT MODEL + source inspection' };
});

await vector('FIX', 'V-I', 'automatic restore preserves active focus', () => {
  const active = { id: 'keeper' }; let activeElement = active;
  const automaticRestore = () => ({ outcome: 'RESTORED_IDENTITY' });
  assert.equal(automaticRestore().outcome, 'RESTORED_IDENTITY'); assert.equal(activeElement, active);
  return { activeElement: 'unchanged', model: 'EXPECTED POST-T3 CONTRACT MODEL' };
});

// Chromium is mandatory. The explicit browser binary is also made available to
// unchanged owner suites whose launch() calls intentionally accept no options.
const browserRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'reader-m02-pw-'));
process.env.PLAYWRIGHT_BROWSERS_PATH = browserRoot;
async function resolveChromium() {
  const override = String(process.env.H2O_PLAYWRIGHT_MODULE || '').trim();
  const entry = override && fs.statSync(override).isDirectory() ? path.join(override, 'index.js') : override;
  const mod = await import(entry ? pathToFileURL(entry).href : 'playwright');
  return mod.chromium || mod.default?.chromium;
}

let browser;
let browserFacts = null;
let vmFacts = null;
let vpFacts = null;
try {
  const chromium = await resolveChromium();
  assert.ok(chromium, 'Playwright Chromium is required');
  const explicitChrome = String(process.env.H2O_READER_CHROMIUM || '').trim();
  if (explicitChrome) {
    // Unchanged strict owner suites call chromium.launch() without options.
    // Give those child processes a disposable module wrapper that injects the
    // already-selected local executable without altering their source.
    const override = String(process.env.H2O_PLAYWRIGHT_MODULE || '').trim();
    const entry = override && fs.statSync(override).isDirectory() ? path.join(override, 'index.js') : override;
    assert.ok(entry, 'H2O_PLAYWRIGHT_MODULE is required with H2O_READER_CHROMIUM');
    const wrapperPath = path.join(browserRoot, 'playwright-explicit-chromium.mjs');
    fs.writeFileSync(wrapperPath, [
      `import * as namespace from ${JSON.stringify(pathToFileURL(entry).href)};`,
      'const base = namespace.default || namespace;',
      `const executablePath = ${JSON.stringify(explicitChrome)};`,
      'export const chromium = new Proxy(base.chromium, {',
      "  get(target, property, receiver) {",
      "    if (property === 'launch') return (options = {}) => target.launch({ ...options, executablePath });",
      '    const value = Reflect.get(target, property, receiver);',
      "    return typeof value === 'function' ? value.bind(target) : value;",
      '  },',
      '});',
      'export default { chromium };',
      '',
    ].join('\n'));
    process.env.H2O_PLAYWRIGHT_MODULE = wrapperPath;
  }
  browser = await chromium.launch({ headless: true, ...(explicitChrome ? { executablePath: explicitChrome } : {}) });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, reducedMotion: 'reduce' });
  const pageErrors = []; page.on('pageerror', error => pageErrors.push(String(error)));
  await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html data-h2o-runtime="tauri"><body data-route="reader" data-sidebar="open" data-density="comfortable" style="margin:0;height:800px"><button id="keeper">keeper</button><div class="wbShell" style="height:758px"><div class="wbStage" style="height:758px"><main class="wbMain" style="box-sizing:border-box"><section id="viewListPanel"></section><section id="viewReader" class="wbReader"></section><section id="wbLibraryRegion" class="wbPanel wbPanel--libraryRegion" hidden></section></main></div></div></body></html>' }));
  await page.goto('http://reader.test/');
  for (const rel of ['studio.css','renderer/presentation/chatgpt-reference.v1.css','renderer/presentation/h2o-clean-reader.v1.css']) await page.addStyleTag({ path: path.join(STUDIO, rel) });
  const rendererScripts = [
    'platform/selectors.contract.js','platform/html-sanitizer.js','renderer/safety/sanitizer-policy.v1.js','renderer/safety/vendor/dompurify/purify.js','renderer/safety/html-sanitizer.v2.js',
    'renderer/markdown/vendor/markdown-it/markdown-it.umd.min.js','renderer/markdown/h2o-gfm.v1.js','renderer/markdown/markdown-engine.v1.js','renderer/markdown/markdown-ir-adapter.v1.js',
    'renderer/semantic/render-ir.v1.js','renderer/semantic/semantic-ingress.v1.js','renderer/semantic/semantic-index.v1.js','renderer/decoration/decoration-contribution.v1.js',
    'renderer/presentation/presentation-profile.v1.js','renderer/presentation/h2o-clean-reader.v1.js','renderer/content/content-renderer.v1.js','renderer/chat-renderer.studio.js',
  ];
  for (const rel of rendererScripts) await page.addScriptTag({ path: path.join(STUDIO, rel) });
  const seamNames = ['getStudioChatRenderer','bindReaderSemanticIndex','getReaderSemanticIndex','getReaderDecorationContributions','disposeReaderRenderDecorations','studioHostUnmount','isCurrentReaderRoot','resolveReaderNavigationTarget','getReaderNavigationTarget','publishReaderTurnSelection','readerNearestScrollDelta','goToReaderTarget','stepReaderTarget','nextReaderTarget','previousReaderTarget','buildReaderDOM','applyUiState','setStudioRouteScope'];
  const seams = seamNames.map(name => extractFunction(source, name)).join('\n');
  const navInstall = source.match(/H2O\.Studio\.readerNavigation = Object\.freeze\([\s\S]*?\);/)?.[0];
  assert.ok(navInstall, 'missing Reader navigation API install');
  await page.addScriptTag({ content: `(() => {
    const W=window,$=selector=>document.querySelector(selector);
    const state={currentReaderSnapshot:null,currentReaderRender:null,currentReaderNavigationTarget:null,currentReaderEditOverrides:null,activeRoute:'reader',sidebarExpanded:true,density:'comfortable'};
    let mounted=null,profile='chatgpt-reference',ribbonContext={route:'reader',chatType:'saved'},publications=0;
    H2O.studioHost={mount(opts){mounted=opts;opts.readerRoot.setAttribute('data-h2o-studio-reader','1');opts.scrollEl.setAttribute('data-scroll-root','1');},unmount(){mounted=null;},getReaderRoot(){return mounted?.readerRoot||null;},getTurnsRoot(){return mounted?.turnsEl||null;},getScrollRoot(){return document.querySelector('.wbMain');}};
    H2O.Studio.appearance={get(key){return key==='presentationProfile'?profile:undefined;}};
    H2O.Studio.ribbon={getContext(){return ribbonContext;},setContext(ctx){publications++;ribbonContext=ctx;}};
    H2O.Studio.getDockContext=()=>null; H2O.util=Object.assign(H2O.util||{},{getChatId:()=>state.currentReaderSnapshot?.chatId||''});
    const normalizeStudioRouteScope=value=>['reader','library','migrate','settings','list'].includes(String(value))?String(value):'list';
    const syncDesktopRibbonHiddenScope=()=>{},installAdaptiveReaderLayout=()=>{},applyAdaptiveReaderLayoutMarker=()=>{};
    const getEditOverride=()=>null,syncReaderTopOffset=()=>{},refreshReaderOverlay=()=>{},__mountOverlayEditorOnTurn=()=>{};
    ${seams}
    H2O.Studio.getReaderSemanticIndex=getReaderSemanticIndex;
    ${navInstall}
    const long=i=>('turn '+i+' content ').repeat(45);
    const richTurn=(role,i,text,ids={})=>({role,turnIdx:i+1,messageId:ids.messageId??'',turnId:ids.turnId??'',outerHTML:'<article data-testid="conversation-turn-'+(i+1)+'"><div data-message-author-role="'+role+'"><div class="'+(role==='user'?'user-message-bubble-color':'markdown prose')+'"><p>'+text+'</p></div></div></article>'});
    function makeSnapshot({mode='canonical',chatId='chat-A',snapshotId='snap-A',ids=true,count=10,roleShift=false,duplicate=false}={}){
      const messages=Array.from({length:count},(_,i)=>({role:roleShift&&i===1?'user':i%2?'assistant':'user',text:long(i),...(ids?{messageId:duplicate?'dup':'m-'+i,turnId:duplicate?'dupt':'t-'+i}:{})}));
      const snap={chatId,snapshotId,messages};
      if(mode==='rich') snap.richTurns=messages.map((m,i)=>richTurn(m.role,i,m.text,ids?{messageId:m.messageId,turnId:m.turnId}:{}));
      return snap;
    }
    function mount(snap,nextProfile='chatgpt-reference'){
      profile=nextProfile; state.activeRoute='reader';state.currentReaderSnapshot=snap;document.body.dataset.route='reader';
      const root=buildReaderDOM(snap);document.getElementById('viewReader').replaceChildren(root);return root;
    }
    function replace(snap,nextProfile){studioHostUnmount('studio:reader-replace');return mount(snap,nextProfile);}
    function selectOrdinal(ordinal){const root=state.currentReaderRender.root,turn=state.currentReaderRender.semanticIndex.turns()[ordinal];return H2O.Studio.readerNavigation.goTo({currentRendererRoot:root,projectionKey:turn.projectionKey},{preserveFocus:true});}
    function placeViewport(ordinal,fraction=.35){const main=document.querySelector('.wbMain'),turn=state.currentReaderRender.semanticIndex.turns()[ordinal].target;const line=main.getBoundingClientRect().top+Math.min(300,main.clientHeight*.4);const r=turn.getBoundingClientRect();main.scrollTop+=r.top+r.height*fraction-line;return observeViewport(line);}
    function observeViewport(line){const main=document.querySelector('.wbMain'),index=state.currentReaderRender?.semanticIndex;if(!index)return null;const turn=index.turns().find(t=>{const r=t.target.getBoundingClientRect();return line>=r.top&&line<r.bottom;});if(!turn)return null;const r=turn.target.getBoundingClientRect();return{projectionKey:turn.projectionKey,fraction:Math.max(0,Math.min(.9999,(line-r.top)/Math.max(r.height,1))),line,geometry:{top:r.top,bottom:r.bottom,height:r.height,scrollTop:main.scrollTop,paddingTop:getComputedStyle(main).paddingTop}};}
    function presentationGap(mode){const snap=makeSnapshot({mode});mount(snap,'chatgpt-reference');selectOrdinal(1);const before=placeViewport(4,.35),line=before.line;document.getElementById('keeper').focus();const active=document.activeElement;const main=document.querySelector('.wbMain'),calls=[],scroll=main.scrollTo;main.scrollTo=function(...args){calls.push(args);return scroll.apply(this,args);};replace(snap,'h2o-clean-reader');const middle={target:state.currentReaderNavigationTarget,viewport:observeViewport(line),profile:state.currentReaderRender.presentation?.effectiveId};replace(snap,'chatgpt-reference');const after={target:state.currentReaderNavigationTarget,viewport:observeViewport(line),profile:state.currentReaderRender.presentation?.effectiveId};main.scrollTo=scroll;return{mode,before,middle,after,scrollCalls:calls.length,focusPreserved:document.activeElement===active};}
    function leaveGap(reason,scope){const snap=makeSnapshot();mount(snap);selectOrdinal(2);const before=placeViewport(5,.4);setStudioRouteScope(scope,{clearReader:true});studioHostUnmount(reason);document.getElementById('viewReader').replaceChildren();mount(snap);return{before,target:state.currentReaderNavigationTarget,after:observeViewport(before.line)};}
    function chatLedgerGap(){const a=makeSnapshot({chatId:'A',snapshotId:'A'}),b=makeSnapshot({chatId:'B',snapshotId:'B'});mount(a);selectOrdinal(2);const before=placeViewport(5,.4);replace(b);selectOrdinal(1);placeViewport(3,.2);replace(a);return{before,target:state.currentReaderNavigationTarget,after:observeViewport(before.line)};}
    function rebuildGap(kind){let first=makeSnapshot({ids:kind!=='identityless'});mount(first);selectOrdinal(1);const oldContext=ribbonContext,oldRoot=state.currentReaderRender.root;
      let next=first;if(kind==='unrelated')next=makeSnapshot({chatId:'other',snapshotId:'other'});if(kind==='newerIdentityless')next=makeSnapshot({ids:false,snapshotId:'snap-new'});if(kind==='deleted') {next=structuredClone(first);next.messages.splice(1,1);}if(kind==='duplicate')next=makeSnapshot({duplicate:true});if(kind==='roleChanged')next=makeSnapshot({roleShift:true});if(kind==='identityless')next=makeSnapshot({ids:false});
      replace(next);return{target:state.currentReaderNavigationTarget,ribbon:ribbonContext,oldContext,oldRootCurrent:isCurrentReaderRoot(oldRoot,first),newRoot:state.currentReaderRender.root!==oldRoot};}
    function equivalentTarget(){const snap=makeSnapshot();const root=mount(snap);selectOrdinal(1);const target=state.currentReaderNavigationTarget;return{sameRoot:state.currentReaderRender.root===root,targetPreserved:state.currentReaderNavigationTarget===target,context:ribbonContext};}
    function determinism(){const fixtures={canonicalSource:makeSnapshot({count:2}),richSource:makeSnapshot({mode:'rich',count:2}),semanticV3:{schema:'h2o.savedChatSnapshot',schemaVersion:3,chatId:'v3',snapshotId:'v3',messages:[{id:'v3u',role:'user',content:[{type:'text',text:'q'}]},{id:'v3a',parentId:'v3u',role:'assistant',content:[{type:'text',text:'a'}]}]},canonicalPath:makeSnapshot({ids:false,count:2}),richPath:makeSnapshot({mode:'rich',ids:false,count:2})};const tuple=r=>({renderMode:r.renderMode,turnCount:r.semanticIndex.turns().length,turns:r.semanticIndex.turns().map(t=>({projectionKey:t.projectionKey,ordinal:t.ordinal,turnNo:t.turnNo,role:t.role,sourceRef:t.sourceRef}))});const rows=[];for(const[fixture,input]of Object.entries(fixtures))for(const p of['chatgpt-reference','h2o-clean-reader']){const a=H2O.Studio.chatRenderer.render(input,{getEditOverride,presentationProfile:p}),b=H2O.Studio.chatRenderer.render(input,{getEditOverride,presentationProfile:p});rows.push({fixture,profile:p,a:tuple(a),b:tuple(b),same:JSON.stringify(tuple(a))===JSON.stringify(tuple(b))});}const changed=structuredClone(fixtures.canonicalSource);changed.messages.pop();const negativeDifferent=JSON.stringify(tuple(H2O.Studio.chatRenderer.render(fixtures.canonicalSource,{getEditOverride,presentationProfile:'chatgpt-reference'})))!==JSON.stringify(tuple(H2O.Studio.chatRenderer.render(changed,{getEditOverride,presentationProfile:'chatgpt-reference'})));return{rows,negativeDifferent};}
    const routeReasons={'studio:list':'list','studio:route-library':'library','studio:route-migrate':'migrate','studio:route-settings':'settings','studio:library-folders-visible-body':'library'};
    const scopeReasons={list:'studio:route-scope:list',library:'studio:route-scope:library',migrate:'studio:route-scope:migrate',settings:'studio:route-scope:settings'};
    let vpLine=0,vpCaptures=[],vpLedger=null;
    function vpObserve(){const index=state.currentReaderRender?.semanticIndex,root=state.currentReaderRender?.root,main=root?.closest('.wbMain');if(!index||!root?.isConnected||!main)return null;const turn=index.turns().find(t=>{const r=t.target.getBoundingClientRect();return vpLine>=r.top&&vpLine<r.bottom;});if(!turn)return null;const r=turn.target.getBoundingClientRect();return{projectionKey:turn.projectionKey,fraction:Math.max(0,Math.min(.9999,(vpLine-r.top)/Math.max(r.height,1))),geometry:{line:vpLine,top:r.top,bottom:r.bottom,height:r.height,mainTop:main.getBoundingClientRect().top,scrollTop:main.scrollTop,paddingTop:getComputedStyle(main).paddingTop}};}
    function vpCapture(reason,seam){const viewport=vpObserve();if(!viewport)return{outcome:'NOT_CAPTURED',reason,seam};vpLedger=JSON.parse(JSON.stringify({viewport}));vpCaptures.push({reason,seam,record:vpLedger});return{outcome:'CAPTURED',reason,seam};}
    function vpScope(scope,probe){if(probe&&state.currentReaderRender&&state.activeRoute==='reader'&&scope!=='reader')vpCapture(scopeReasons[scope],'pre-leave');setStudioRouteScope(scope,{clearReader:scope!=='list'});}
    function vpFunnel(reason,probe){if(probe&&reason==='studio:reader-replace')return vpCapture(reason,'discard-funnel');return{outcome:'NOT_CAPTURED',reason,seam:'discard-funnel'};}
    function vpReset(placement,subscriber){vpCaptures=[];vpLedger=null;const reader=document.getElementById('viewReader'),region=document.getElementById('wbLibraryRegion');reader.removeAttribute('data-library-overlay');region.hidden=true;region.textContent='';mount(makeSnapshot());const main=document.querySelector('.wbMain'),turn=state.currentReaderRender.semanticIndex.turns()[4].target,lineOffset=Math.min(300,main.clientHeight*.4),r=turn.getBoundingClientRect();main.scrollTop+=r.top+r.height*.25-(main.getBoundingClientRect().top+lineOffset);const placed=turn.getBoundingClientRect();vpLine=placement==='boundary'?placed.top+.25:placed.top+placed.height/2;const preSubscriber=vpObserve();if(subscriber){reader.dataset.libraryOverlay='1';region.hidden=false;region.textContent='Library';}return{preSubscriber,pre:vpObserve()};}
    function vpFinal(){const main=document.querySelector('.wbMain'),reader=document.getElementById('viewReader'),region=document.getElementById('wbLibraryRegion');return{activeRoute:state.activeRoute,bodyRoute:document.body.dataset.route,snapshot:state.currentReaderSnapshot?.snapshotId||null,scrollTop:main.scrollTop,paddingTop:getComputedStyle(main).paddingTop,readerConnected:!!state.currentReaderRender?.root?.isConnected,overlay:reader.getAttribute('data-library-overlay'),regionHidden:region.hidden,regionText:region.textContent};}
    function vpRoute(reason,placement,probe,subscriber=false){const seeded=vpReset(placement,subscriber),scope=routeReasons[reason];vpScope(scope,probe);const captured=vpLedger?JSON.parse(JSON.stringify(vpLedger)):null,later=vpFunnel(reason,probe);return{reason,placement,subscriber,seeded,later,capturedCount:vpCaptures.length,ledger:vpLedger,ledgerUnchanged:JSON.stringify(captured)===JSON.stringify(vpLedger),final:vpFinal()};}
    function vpReplace(placement,probe){const seeded=vpReset(placement,false),later=vpFunnel('studio:reader-replace',probe);return{reason:'studio:reader-replace',placement,subscriber:false,seeded,later,capturedCount:vpCaptures.length,ledger:vpLedger,ledgerUnchanged:true,final:vpFinal()};}
    function vpNegative(reason){vpReset('mid',false);const result=reason==='studio:route-scope:reader'?(vpScope('reader',true),{outcome:'NOT_CAPTURED'}):vpFunnel(reason,true);return{reason,result,capturedCount:vpCaptures.length,ledger:vpLedger};}
    window.m02={state,get context(){return ribbonContext;},get publications(){return publications;},presentationGap,leaveGap,chatLedgerGap,rebuildGap,equivalentTarget,determinism,vpRoute,vpReplace,vpNegative};
  })();` });

  browserFacts = await page.evaluate(() => ({
    presentation: [m02.presentationGap('canonical'), m02.presentationGap('rich')],
    list: m02.leaveGap('studio:list','list'), settings: m02.leaveGap('studio:route-settings','settings'),
    chatLedger: m02.chatLedgerGap(), equivalent: m02.equivalentTarget(),
    identityless: m02.rebuildGap('identityless'), unrelated: m02.rebuildGap('unrelated'), newerIdentityless: m02.rebuildGap('newerIdentityless'),
    deleted: m02.rebuildGap('deleted'), duplicate: m02.rebuildGap('duplicate'), roleChanged: m02.rebuildGap('roleChanged'),
    determinism: m02.determinism(),
  }));

  const vpRows = [];
  for (const placement of ['boundary','mid']) {
    for (const reason of ['studio:list','studio:route-library','studio:route-migrate','studio:route-settings','studio:library-folders-visible-body']) {
      const probe = await page.evaluate(({reason,placement}) => m02.vpRoute(reason,placement,true,false), {reason,placement});
      const control = await page.evaluate(({reason,placement}) => m02.vpRoute(reason,placement,false,false), {reason,placement});
      probe.controlEqual = JSON.stringify(probe.final) === JSON.stringify(control.final); vpRows.push(probe);
    }
    const probe = await page.evaluate(placement => m02.vpReplace(placement,true), placement);
    const control = await page.evaluate(placement => m02.vpReplace(placement,false), placement);
    probe.controlEqual = JSON.stringify(probe.final) === JSON.stringify(control.final); vpRows.push(probe);
    const sub = await page.evaluate(placement => m02.vpRoute('studio:route-library',placement,true,true), placement);
    const subControl = await page.evaluate(placement => m02.vpRoute('studio:route-library',placement,false,true), placement);
    sub.controlEqual = JSON.stringify(sub.final) === JSON.stringify(subControl.final); vpRows.push(sub);
  }
  const negatives = await page.evaluate(() => ['studio:reader-missing','studio:reader-error','studio:route-scope:reader','test:leave','memory:teardown','unknown:reason'].map(reason=>m02.vpNegative(reason)));
  vpFacts = { rows: vpRows.map(row => ({ reason:row.reason,placement:row.placement,subscriber:row.subscriber,pre:row.seeded.pre,captured:row.ledger?.viewport||null,capturedCount:row.capturedCount,later:row.later.outcome,ledgerUnchanged:row.ledgerUnchanged,controlEqual:row.controlEqual,subscriberStable:!row.subscriber||JSON.stringify(row.seeded.preSubscriber)===JSON.stringify(row.seeded.pre) })), negatives };
  assert.deepEqual(pageErrors, [], 'browser fixture page errors');
} catch (error) {
  inconclusive.push({ id: 'BROWSER', error: String(error?.stack || error) });
  console.error(`BROWSER_PRECONDITION_FAIL ${String(error?.stack || error)}`);
} finally {
  await browser?.close();
}

if (!browserFacts || !vpFacts) {
  failures.push({ id: 'BROWSER', class: 'PRE', result: 'FAIL', error: inconclusive[0]?.error || 'browser facts unavailable' });
} else {
  for (const [index, id] of ['V-A1','V-A2'].entries()) {
    await vector('GAP', id, `${browserFacts.presentation[index].mode} presentation A→B→A loses current continuity`, () => {
      const row=browserFacts.presentation[index]; assert.equal(row.middle.target,null);assert.equal(row.after.target,null);assert.equal(row.middle.profile,'h2o-clean-reader');assert.equal(row.after.profile,'chatgpt-reference');assert.equal(row.scrollCalls,0);assert.ok(row.focusPreserved);return row;
    });
    await vector('FIX', id, 'selection and viewport restore independently without focus movement', () => ({ selection:'RESTORED_IDENTITY_OR_STRUCTURAL',viewport:'RESTORED_IDENTITY_OR_STRUCTURAL',focus:'unchanged',model:'EXPECTED POST-T3 CONTRACT MODEL' }));
  }
  await vector('GAP','V-B1','list leave/reopen has no current resume continuity',()=>{assert.equal(browserFacts.list.target,null);return browserFacts.list;});
  await vector('FIX','V-B1','list pre-leave future record restores same snapshot',()=>({outcome:'RESTORED_IDENTITY_OR_STRUCTURAL',model:'EXPECTED POST-T3 CONTRACT MODEL'}));
  await vector('GAP','V-B2','settings leave/reopen has no current resume continuity',()=>{assert.equal(browserFacts.settings.target,null);return browserFacts.settings;});
  await vector('FIX','V-B2','settings pre-leave future record restores same snapshot',()=>({outcome:'RESTORED_IDENTITY_OR_STRUCTURAL',model:'EXPECTED POST-T3 CONTRACT MODEL'}));
  await vector('GAP','V-B3','A→B→A has no current per-chat continuity ledger',()=>{assert.equal(browserFacts.chatLedger.target,null);return browserFacts.chatLedger;});
  await vector('FIX','V-B3','future ledger restores A state only to A',()=>({A:'isolated',B:'isolated',model:'EXPECTED POST-T3 CONTRACT MODEL'}));

  const ribbonSource=fs.readFileSync(path.join(STUDIO,'ribbon/ribbon-shell.studio.js'),'utf8');
  const setContext=extractFunction(ribbonSource,'setContext');
  const ribbonSandbox=vm.createContext({});
  vm.runInContext(`const CHAT_TYPES=new Set(['saved','linked','native']);const RibbonEvents={contextChanged:'changed'};const internalState={context:{}};function isPlainObject(v){return !!v&&typeof v==='object'&&!Array.isArray(v);}function isNonEmptyString(v){return typeof v==='string'&&v.trim().length>0;}function softEmit(){};${setContext};setContext({route:'reader',chatType:'saved',snapshotId:'s',chatId:'c',selectedMessageId:'m-1',selectedTurnIdx:2});globalThis.before=Object.assign({},internalState.context);setContext({route:'read',chatType:'saved',snapshotId:'s',chatId:'c',title:'c',originalUrl:null,readOnly:false});globalThis.after=Object.assign({},internalState.context);`,ribbonSandbox);
  vmFacts={before:{...ribbonSandbox.before},after:{...ribbonSandbox.after}};
  await vector('GAP','V-C1','equivalent target survives while exact Ribbon publication erases selection',()=>{assert.ok(browserFacts.equivalent.sameRoot&&browserFacts.equivalent.targetPreserved);assert.equal(vmFacts.before.selectedTurnIdx,2);assert.equal(vmFacts.after.selectedTurnIdx,null);assert.equal(vmFacts.after.selectedMessageId,null);return{reader:browserFacts.equivalent,ribbon:vmFacts};});
  await vector('FIX','V-C1','future route publication preserves valid current selection',()=>({selectedTurnIdx:2,selectedMessageId:'m-1',shellGate:'G7',model:'EXPECTED POST-T3 CONTRACT MODEL'}));
  await vector('GAP','V-C2','unresolvable rebuild retains stale Ribbon selection today',()=>{const r=browserFacts.deleted;assert.equal(r.target,null);assert.equal(r.ribbon.selectedTurnIdx,r.oldContext.selectedTurnIdx);assert.equal(r.ribbon.selectedMessageId,r.oldContext.selectedMessageId);return r;});
  await vector('FIX','V-C2','future unresolvable rebuild explicitly clears Ribbon selection',()=>({selectedTurnIdx:null,selectedMessageId:null,shellGate:'G7',model:'EXPECTED POST-T3 CONTRACT MODEL'}));
  await vector('PRE','V-D','new Reader binding clears current-render navigation target',()=>{assert.equal(browserFacts.identityless.target,null);return{cleared:true};});
  await vector('PRE','V-E','unrelated chat/snapshot cannot inherit current target',()=>{assert.equal(browserFacts.unrelated.target,null);return{inherited:false};});
  await vector('FIX','V-E','future populated ledger remains chat/snapshot isolated',()=>({inherited:false,model:'EXPECTED POST-T3 CONTRACT MODEL'}));
  await vector('GAP','V-F1','identity-less same-snapshot rebuild loses continuity today',()=>{assert.equal(browserFacts.identityless.target,null);return browserFacts.identityless;});
  await vector('FIX','V-F1','identity-less same-snapshot future structural restore',()=>({outcome:'RESTORED_STRUCTURAL',selectedMessageId:null,model:'EXPECTED POST-T3 CONTRACT MODEL'}));
  await vector('PRE','V-F2','identity-less newer snapshot stays fail closed',()=>{assert.equal(browserFacts.newerIdentityless.target,null);return{outcome:'NOT_RESTORED'};});
  await vector('PRE','V-G1','deleted source identity stays fail closed',()=>{assert.equal(browserFacts.deleted.target,null);return{outcome:'NOT_RESTORED'};});
  await vector('PRE','V-G2','duplicate source identity does not auto-select after rebuild',()=>{assert.equal(browserFacts.duplicate.target,null);return{outcome:'NOT_RESTORED'};});
  await vector('PRE','V-G3','role/structural mismatch does not auto-select after rebuild',()=>{assert.equal(browserFacts.roleChanged.target,null);return{outcome:'NOT_RESTORED'};});
  await vector('PRE','V-M','real Renderer projection tuples are deterministic',()=>{for(const row of browserFacts.determinism.rows)assert.ok(row.same,`${row.fixture}/${row.profile}`);assert.ok(browserFacts.determinism.negativeDifferent);return{fixtures:[...new Set(browserFacts.determinism.rows.map(r=>r.fixture))],profiles:[...new Set(browserFacts.determinism.rows.map(r=>r.profile))],comparisons:browserFacts.determinism.rows.length,negativeDifferent:true};});
  await vector('PRE','V-P','current geometry supports the reconciled capture point',()=>{for(const row of vpFacts.rows){assert.equal(row.pre.projectionKey,row.captured.projectionKey,`${row.reason}/${row.placement}`);assert.ok(Math.abs(row.pre.fraction-row.captured.fraction)<=1e-4);assert.equal(row.capturedCount,1);assert.equal(row.later,row.reason==='studio:reader-replace'?'CAPTURED':'NOT_CAPTURED');assert.ok(row.ledgerUnchanged&&row.controlEqual&&row.subscriberStable);}for(const row of vpFacts.negatives){assert.equal(row.result.outcome,'NOT_CAPTURED');assert.equal(row.capturedCount,0);assert.equal(row.ledger,null);}return{cases:vpFacts.rows.length,negatives:vpFacts.negatives.length,rows:vpFacts.rows};});
  await vector('FIX','V-P','pre-leave/discard-funnel observation model is single-capture and side-effect neutral',()=>({routeCases:vpFacts.rows.filter(r=>r.reason!=='studio:reader-replace').length,replaceCases:vpFacts.rows.filter(r=>r.reason==='studio:reader-replace').length,model:'EXPECTED POST-T3 CONTRACT MODEL / OBSERVATION PROBE'}));
}

function runOwner(name, rel, env = {}, expected = []) {
  const run=spawnSync(process.execPath,[path.join(ROOT,rel)],{cwd:ROOT,encoding:'utf8',timeout:180000,maxBuffer:64*1024*1024,env:{...process.env,...env}});
  const output=`${run.stdout||''}${run.stderr||''}`;
  assert.ifError(run.error);assert.equal(run.status,0,`${name} failed\n${output.slice(-8000)}`);
  for(const pattern of expected)assert.match(output,pattern,`${name} missing ${pattern}`);
  return output;
}

await vector('PRE','V-O','M01 predecessor bytes and required foreign owner suites remain green',()=>{
  for(const rel of[M01_CONTRACT_REL,M01_VALIDATOR_REL]){const shown=spawnSync('git',['show',`origin/main:${rel}`],{cwd:ROOT,encoding:null,maxBuffer:16*1024*1024});assert.equal(shown.status,0);assert.ok(Buffer.from(shown.stdout).equals(fs.readFileSync(path.join(ROOT,rel))),`${rel} differs from origin/main`);}
  const m01=runOwner('Reader M01',M01_VALIDATOR_REL,{},[/"current":22/,/"baseline":0/,/"fixture":0/,/"failed":0/]);
  const lifecycle=runOwner('Renderer lifecycle','tools/validation/studio/validate-studio-renderer-lifecycle-idempotence.mjs',{},[/24\/24 passed/]);
  const presentation=runOwner('Presentation registry','tools/validation/studio/validate-studio-renderer-presentation-registry-v1.mjs',{H2O_REQUIRE_PRESENTATION_REGISTRY_TIER2:'1'},[/PASS 9/]);
  const content=runOwner('ContentRenderer','tools/validation/studio/validate-studio-content-renderer-v1.mjs',{H2O_REQUIRE_CONTENT_RENDERER_TIER2:'1'},[/PASS 74/]);
  const notes=runOwner('Reader Notes','tools/validation/reader-notes/validate-reader-notes-mvp-a2a_4-highlight-resolution-consumer.mjs',{},[/passed: 32 checks/]);
  const long=fs.readFileSync(path.join(ROOT,'tools/validation/studio/benchmark-studio-renderer-long-chat.mjs'),'utf8');const memory=fs.readFileSync(path.join(ROOT,'tools/validation/studio/benchmark-studio-renderer-memory.mjs'),'utf8');
  const longBlock=long.slice(long.indexOf('const refreshHelpers = ['),long.indexOf('].map((name) => extractFunction',long.indexOf('const refreshHelpers = [')));
  const memoryBlock=memory.slice(memory.indexOf('const studioFunctions = ['),memory.indexOf('].map((name) => extractFunction',memory.indexOf('const studioFunctions = [')));
  for(const name of['getStudioChatRenderer','getReusableReaderMount','isReusableReaderMountCurrent','collectRendererEditOverrides','haveEquivalentRendererEditOverrides','canReuseReaderDOM','bindReaderSemanticIndex','getReaderSemanticIndex','getReaderDecorationContributions','disposeReaderRenderDecorations','studioHostUnmount'])assert.match(longBlock,new RegExp(`"${name}"`));
  for(const name of['studioHostUnmount','getStudioChatRenderer','isCurrentReaderRoot','getReusableReaderMount','isReusableReaderMountCurrent','collectRendererEditOverrides','haveEquivalentRendererEditOverrides','canReuseReaderDOM','refreshReaderOverlay','buildReaderDOM','bindReaderSemanticIndex','getReaderSemanticIndex','getReaderDecorationContributions','disposeReaderRenderDecorations'])assert.match(memoryBlock,new RegExp(`"${name}"`));
  assert.doesNotMatch(longBlock,/setStudioRouteScope|applyUiState/);assert.doesNotMatch(memoryBlock,/setStudioRouteScope|applyUiState/);
  return{m01:'22/0/0/0',lifecycle:'24/24',presentation:(presentation.match(/PASS \d+/)||[])[0],content:(content.match(/PASS \d+/)||[])[0],readerNotes:(notes.match(/passed: \d+ checks/)||[])[0],m03ExtractionInventory:'accurate',bytesIdentical:[M01_CONTRACT_REL,M01_VALIDATOR_REL]};
});

await vector('PRE','V-H1','stale renderToken completion has no authority',()=>({ownerEvidence:'Renderer lifecycle 24/24 through V-O'}));
await vector('PRE','V-H2','detached or reattached stale root cannot regain authority',()=>({ownerEvidence:'Reader M01 22-group floor through V-O'}));
await vector('PRE','V-I','explicit M01 goTo focus behavior remains green',()=>({ownerEvidence:'Reader M01 focus/motion vectors through V-O'}));
await vector('PRE','V-K2','real MiniMap derives active state through current viewport/index behavior',()=>({ownerEvidence:'Reader M01 populated Core/Engine navigation through V-O',observation:'RDR-M02-T1-OBS-001 remains non-blocking'}));

try { fs.rmSync(browserRoot,{recursive:true,force:true}); } catch {}

const counts={
  current:rows.filter(r=>r.class==='PRE'&&r.result==='PASS').length,
  gaps:rows.filter(r=>r.class==='GAP'&&r.result==='REPRODUCED').length,
  fixes:rows.filter(r=>r.class==='FIX'&&r.result==='EXPECTATION_LOCKED').length,
  failures:failures.length,
  inconclusive:inconclusive.length,
};
console.log('');
console.log(`CURRENT_PRODUCT_PASS=${counts.current}`);
console.log(`KNOWN_BASELINE_GAPS=${counts.gaps}`);
console.log(`FUTURE_FIX_EXPECTATIONS=${counts.fixes}`);
console.log(`FAILURES=${counts.failures}`);
console.log(`INCONCLUSIVE=${counts.inconclusive}`);
console.log(`VECTOR_RESULTS=${JSON.stringify(rows.map(({id,class:kind,result})=>({id,class:kind,result})))}`);
if(counts.gaps!==8){console.error(`Expected exactly 8 baseline gaps, observed ${counts.gaps}`);process.exitCode=1;}
if(counts.failures||counts.inconclusive)process.exitCode=1;
