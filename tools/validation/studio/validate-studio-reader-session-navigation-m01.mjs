#!/usr/bin/env node
// Reader M01 T3: current contracts, remaining baseline gaps, and unimplemented
// acceptance vectors are separate results. No production behavior is replaced.
// See docs/contracts/studio-reader-session-navigation-m01.md for scope,
// policies and later write-sets.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const STUDIO = path.join(ROOT, 'src-surfaces-base/studio');
const source = fs.readFileSync(path.join(STUDIO, 'studio.js'), 'utf8');
const results = { current: 0, baseline: 0, fixture: 0, failed: 0 };
async function check(kind, label, fn) {
  try {
    await fn();
    results[kind] += 1;
    const prefix = { current: 'PASSING CURRENT CONTRACT', baseline: 'KNOWN BASELINE GAP', fixture: 'FUTURE POST-FIX EXPECTATION (fixture only; behavior pending)' }[kind];
    console.log(`${prefix}: ${label}`);
  } catch (error) {
    results.failed += 1;
    console.error(`FAIL: ${label}\n${error.stack || error}`);
  }
}

// Same source-extraction convention as the existing lifecycle validator.
// Only these small, named seams run; the full Studio application is not booted.
function extract(name, assigned = false, text = source) {
  const marker = assigned ? `H2O.Studio.${name} = function` : `function ${name}(`;
  const at = text.indexOf(marker);
  assert.ok(at >= 0, `missing source seam: ${name}`);
  const start = assigned ? text.indexOf('function', at) : at;
  const open = text.indexOf('{', text.indexOf(')', start));
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === '{') depth += 1;
    if (text[i] === '}' && --depth === 0) {
      const fn = text.slice(start, i + 1);
      new vm.Script(`(${fn})`); // fail clearly if a future edit breaks extraction
      return fn;
    }
  }
  throw new Error(`unterminated source seam: ${name}`);
}

// Reuse the owner's executable suite, including deferred loads / render tokens,
// equivalent reuse, replacement, missing/error discard, leave/reopen, and the
// exact index/decorations binding + cleanup-before-forgetting contract.
await check('current', 'existing Renderer/Reader lifecycle suite', () => {
  const run = spawnSync(process.execPath, [path.join(ROOT, 'tools/validation/studio/validate-studio-renderer-lifecycle-idempotence.mjs')], { encoding: 'utf8', timeout: 30000 });
  process.stdout.write(run.stdout || '');
  process.stderr.write(run.stderr || '');
  assert.ifError(run.error);
  assert.equal(run.status, 0, 'required lifecycle suite must be green');
});

// T3 acceptance vectors execute the source-extracted production navigation API.
const navigationVectors = Object.freeze({
  status: 'implemented-T3',
  targetShape: ['currentRendererRoot', 'projectionKey'],
  orderedTargets: 'currentSemanticIndex.turns()',
  cases: [
    { operation: 'goTo', targetOrdinal: 1, expectedOrdinal: 1 },
    { operation: 'next', selectedOrdinal: 0, expectedOrdinal: 1 },
    { operation: 'previous', selectedOrdinal: 1, expectedOrdinal: 0 },
    { operation: 'next', selectedOrdinal: null, expectedOrdinal: 0 },
    { operation: 'previous', selectedOrdinal: null, expectedOrdinal: 1 },
    { operation: 'next', selectedOrdinal: 1, expectedOrdinal: null, reason: 'boundary' },
    { operation: 'previous', selectedOrdinal: 0, expectedOrdinal: null, reason: 'boundary' },
    { operation: 'goTo', projectionKey: 'missing', expectedOrdinal: null, reason: 'unresolved' },
    { operation: 'goTo', root: 'discarded-render', expectedOrdinal: null, reason: 'stale-session' },
    { operation: 'goTo', root: 'foreign-render', expectedOrdinal: null, reason: 'foreign' },
    { operation: 'goTo', disconnected: true, expectedOrdinal: null, reason: 'disconnected' },
  ],
  focus: { default: 'target-with-preventScroll', preserve: 'leave-activeElement-unchanged', failed: 'unchanged' },
  scroll: { root: 'Shell-provided', default: 'auto', smooth: 'explicit-opt-in', reducedMotion: 'auto', block: 'nearest', inline: 'nearest', failed: 'unchanged' },
});

async function resolveChromium() {
  const override = process.env.H2O_PLAYWRIGHT_MODULE;
  const entry = override && fs.statSync(override).isDirectory() ? path.join(override, 'index.js') : override;
  const mod = await import(entry ? pathToFileURL(entry).href : 'playwright');
  return mod.chromium || mod.default?.chromium;
}

let browser;
try {
  const chromium = await resolveChromium();
  assert.ok(chromium, 'Playwright Chromium required; set H2O_PLAYWRIGHT_MODULE');
  browser = await chromium.launch({ headless: true, ...(process.env.H2O_READER_CHROMIUM ? { executablePath: process.env.H2O_READER_CHROMIUM } : {}) });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, reducedMotion: 'reduce' });
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(String(error)));
  // No application server, user data, or external resources. This route supplies
  // only the Shell container fixture; scripts are loaded from the checked-out tree.
  await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body data-route="reader"><main class="wbMain"><section id="viewReader" class="wbReader"></section></main></body></html>' }));
  await page.goto('http://reader.test/c/chat-reader');
  const rendererScripts = [
    'platform/selectors.contract.js', 'platform/html-sanitizer.js',
    'renderer/safety/sanitizer-policy.v1.js', 'renderer/safety/vendor/dompurify/purify.js', 'renderer/safety/html-sanitizer.v2.js',
    'renderer/markdown/vendor/markdown-it/markdown-it.umd.min.js', 'renderer/markdown/h2o-gfm.v1.js',
    'renderer/markdown/markdown-engine.v1.js', 'renderer/markdown/markdown-ir-adapter.v1.js',
    'renderer/semantic/render-ir.v1.js', 'renderer/semantic/semantic-ingress.v1.js', 'renderer/semantic/semantic-index.v1.js',
    'renderer/decoration/decoration-contribution.v1.js', 'renderer/presentation/presentation-profile.v1.js',
    'renderer/content/content-renderer.v1.js', 'renderer/chat-renderer.studio.js',
  ];
  for (const rel of rendererScripts) await page.addScriptTag({ path: path.join(STUDIO, rel) });
  const seams = ['getStudioChatRenderer', 'bindReaderSemanticIndex', 'getReaderSemanticIndex', 'getReaderDecorationContributions', 'isCurrentReaderRoot', 'resolveReaderNavigationTarget', 'getReaderNavigationTarget', 'publishReaderTurnSelection', 'readerNearestScrollDelta', 'goToReaderTarget', 'stepReaderTarget', 'nextReaderTarget', 'previousReaderTarget', 'disposeReaderRenderDecorations', 'studioHostUnmount', 'buildReaderDOM'].map(name => extract(name)).join('\n');
  const readerSeamsScript = `(() => {
    const W = window, H2O = W.H2O, $ = selector => document.querySelector(selector);
    const state = { currentReaderSnapshot: null, currentReaderRender: null, selectedSnapshotId: '', selectedChatId: '' };
    let mounted = null, ribbonContext = {}, publications = 0, editorCalls = [];
    H2O.studioHost = {
      mount(opts) { mounted = opts; },
      unmount() { mounted = null; },
      getReaderRoot: () => mounted?.readerRoot,
      getTurnsRoot: () => mounted?.turnsEl,
      getScrollRoot: () => document.querySelector('.wbMain'),
    };
    H2O.util = Object.assign(H2O.util || {}, { getChatId: () => state.currentReaderSnapshot?.chatId || '' });
    H2O.Studio.ribbon = { getContext: () => ribbonContext, setContext(ctx) { publications++; ribbonContext = ctx; } };
    const getEditOverride = () => null;
    const syncReaderTopOffset = () => {};
    const refreshReaderOverlay = () => {};
    const __mountOverlayEditorOnTurn = (turn, snapshot, turnIdx) => { editorCalls.push({ turn, snapshot, turnIdx }); };
    ${seams}
    H2O.Studio.getReaderContext = ${extract('getReaderContext', true)};
    H2O.Studio.getDockContext = ${extract('getDockContext', true)};
    H2O.Studio.getReaderSemanticIndex = getReaderSemanticIndex;
    H2O.Studio.getReaderDecorationContributions = getReaderDecorationContributions;
    ${source.match(/H2O\.Studio\.readerNavigation = Object\.freeze\([\s\S]*?\);/)[0]}
    window.readerFixture = {
      state, unmount: studioHostUnmount, get publications() { return publications; }, get editorCalls() { return editorCalls; },
      mount(snap) {
        state.currentReaderRender?.decorationContributions?.disposeAll();
        state.currentReaderSnapshot = snap;
        ribbonContext = { route: 'reader', sentinel: 'preserved' }; publications = 0; editorCalls = [];
        const root = buildReaderDOM(snap);
        document.getElementById('viewReader').dataset.editMode = 'off';
        document.getElementById('viewReader').replaceChildren(root);
        return root;
      },
      get mounted() { return mounted; },
    };
  })();`;
  await page.addScriptTag({ content: readerSeamsScript });

  const selection = await page.evaluate(() => {
    const messages = [{ role: 'user', text: 'question', messageId: 'u-1' }, { role: 'assistant', text: 'answer', messageId: 'a-1' }];
    const snapshot = (rich, reversed = false) => {
      const ordered = reversed ? messages.slice().reverse() : messages;
      return { snapshotId: 'snap-reader', chatId: 'chat-reader', messages: ordered,
        ...(rich ? { richTurns: ordered.map((m, i) => ({ role: m.role, turnIdx: i + 1, messageId: m.messageId,
          outerHTML: '<article data-testid="conversation-turn-' + (i + 1) + '"><div data-message-author-role="' + m.role + '" data-message-id="' + m.messageId + '"><div class="' + (m.role === 'user' ? 'user-message-bubble-color' : 'markdown prose') + '"><p>' + m.text + '</p></div></div></article>' })) } : {}),
      };
    };
    window.readerSnapshots = { canonical: snapshot(false), rich: snapshot(true) };
    return [false, true].flatMap(rich => [false, true].map(reversed => {
      const root = readerFixture.mount(snapshot(rich, reversed));
      const index = H2O.Studio.getReaderSemanticIndex(root);
      const turns = Array.from(root.querySelectorAll('[data-turn]'));
      const rows = turns.map(turn => {
        const record = index.turns().find(t => t.target === turn);
        const message = index.getMessage(record.messageKey);
        const target = message.target.querySelector('p') || message.target;
        target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        return { role: turn.getAttribute('data-turn'), ordinal: record.ordinal, outerId: turn.getAttribute('data-message-id'),
          innerId: message.target.getAttribute('data-message-id'), sourceId: message.sourceRef?.messageId,
          context: H2O.Studio.ribbon.getContext(), selected: turn.classList.contains('is-ribbon-selected'),
          selectedCount: root.querySelectorAll('.is-ribbon-selected').length };
      });
      // Interactive descendants and clicks outside a turn must not republish.
      const before = readerFixture.publications;
      const controls = [
        ['button', {}], ['a', { href: '#' }], ['input', {}], ['select', {}], ['textarea', {}],
        ['div', { contenteditable: 'true' }], ['div', { class: 'wbEditBtn' }],
        ['div', { class: 'wbEditWrap' }], ['div', { class: 'wbEditTextarea' }],
      ];
      for (const [tag, attrs] of controls) {
        const control = document.createElement(tag);
        for (const [name, value] of Object.entries(attrs)) control.setAttribute(name, value);
        turns[0].appendChild(control);
        control.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        control.remove();
      }
      const ignoredInteractive = readerFixture.publications === before;
      readerFixture.mounted.turnsEl.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      return { rich, reversed, mode: index.renderMode, rows, ignoredInteractive, ignoredNonTurn: readerFixture.publications === before,
        bound: readerFixture.state.currentReaderRender.root === root && readerFixture.mounted.readerRoot === root,
        sameLifecycle: H2O.Studio.getReaderDecorationContributions(root).semanticIndex === index };
    }));
  });
  await check('current', 'real canonical/rich turns use one role-independent Reader click handler and 1-based Ribbon selection', () => {
    for (const run of selection) {
      assert.equal(run.mode, run.rich ? 'rich' : 'canonical');
      assert.deepEqual(run.rows.map(r => r.role), run.reversed ? ['assistant', 'user'] : ['user', 'assistant']);
      for (const [i, row] of run.rows.entries()) {
        assert.equal(row.context.selectedTurnIdx, i + 1);
        assert.equal(row.ordinal, i); // index ordinals are zero-based
        assert.equal(row.context.sentinel, 'preserved');
        assert.equal(row.context.route, 'reader');
        assert.equal(row.selected, true);
        assert.equal(row.selectedCount, 1);
      }
      assert.ok(run.ignoredInteractive && run.ignoredNonTurn);
    }
  });
  await check('current', 'buildReaderDOM binds the exact real Renderer root/index/decorations and supplies the host', () => {
    for (const run of selection) assert.ok(run.bound && run.sameLifecycle);
  });
  await check('current', 'RDR-LIVE-001 repaired: source message identity for both roles/projections, including reversed role order', () => {
    const row = selection.find(r => r.rich && !r.reversed).rows[1];
    assert.equal(row.outerId, null);
    assert.equal(row.innerId, 'a-1');
    assert.equal(row.sourceId, 'a-1');
    assert.equal(row.context.selectedTurnIdx, 2);
    assert.equal(row.context.selectedMessageId, 'a-1');
    console.log(`  RDR-LIVE-001 observation: ${JSON.stringify(row)}`);
    // T1's null diagnostic is superseded by the real T2 behavior for every row.
    // The Renderer nesting remains unchanged; Reader consumes its public index.
    for (const run of selection) for (const selected of run.rows) {
      assert.equal(selected.outerId, null);
      assert.equal(selected.innerId, selected.sourceId);
      assert.equal(selected.sourceId, selected.role === 'user' ? 'u-1' : 'a-1');
      assert.equal(selected.context.selectedMessageId, selected.sourceId);
    }
    console.log('  All 8 role/projection/order selections publish the linked source ID and correct 1-based Reader position.');
  });

  await check('current', 'missing source identity publishes null without using projection keys or DOM decoys', async () => {
    const rows = await page.evaluate(() => Object.entries(readerSnapshots).flatMap(([mode, saved]) => {
      const snap = structuredClone(saved);
      for (const message of snap.messages) delete message.messageId;
      for (const turn of snap.richTurns || []) {
        delete turn.messageId;
        turn.outerHTML = turn.outerHTML.replace(/ data-message-id="[^"]*"/g, '');
      }
      const root = readerFixture.mount(snap);
      const index = H2O.Studio.getReaderSemanticIndex(root);
      return index.turns().map((turn, i) => {
        const message = index.getMessage(turn.messageKey);
        // Index identity is already sealed. Neither shell nor descendant DOM
        // attributes are a Reader fallback, even if they appear later.
        turn.target.setAttribute('data-message-id', 'outer-decoy');
        message.target.setAttribute('data-message-id', 'inner-decoy');
        message.target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        return { mode: index.renderMode, expectedMode: mode, sourceId: message.sourceRef?.messageId ?? null,
          key: message.projectionKey, context: H2O.Studio.ribbon.getContext(), turnIdx: i + 1,
          publications: readerFixture.publications };
      });
    }));
    assert.equal(rows.length, 4);
    for (const row of rows) {
      assert.equal(row.mode, row.expectedMode);
      assert.equal(row.sourceId, null);
      assert.ok(row.key);
      assert.equal(row.context.selectedMessageId, null);
      assert.equal(row.context.selectedTurnIdx, row.turnIdx);
      assert.equal(row.context.sentinel, 'preserved');
      assert.equal(row.publications, row.turnIdx);
    }
  });
  await check('current', 'foreign, stale, detached and discarded render targets do not republish or select by guessed identity', async () => {
    const rows = await page.evaluate(() => {
      const f = readerFixture, rows = [];
      const click = (label, target) => {
        const before = f.publications;
        const context = H2O.Studio.ribbon.getContext();
        const oldClasses = target.className;
        target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        rows.push({ label, unchanged: before === f.publications && context === H2O.Studio.ribbon.getContext() && target.className === oldClasses });
      };
      const oldRoot = f.mount(readerSnapshots.rich);
      const oldIndex = H2O.Studio.getReaderSemanticIndex(oldRoot);
      const oldTurn = oldIndex.turns()[0].target;
      // Reopen the SAME snapshot/IDs with a new DOM: IDs/ordinals alone cannot
      // prove that an old listener belongs to this current render.
      const root = f.mount(readerSnapshots.rich);
      const binding = f.state.currentReaderRender;
      const turn = binding.semanticIndex.turns()[0].target;
      turn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      click('detached previous render, same source IDs', oldTurn);
      document.getElementById('viewReader').appendChild(oldRoot);
      click('connected previous render, same source IDs', oldTurn);
      oldRoot.remove();
      const clone = turn.cloneNode(true);
      clone.classList.remove('is-ribbon-selected');
      f.mounted.turnsEl.appendChild(clone);
      click('foreign cloned turn inside current container', clone);
      clone.remove();
      f.state.currentReaderRender = Object.freeze({ ...binding, semanticIndex: oldIndex });
      click('current root bound to foreign index with identical IDs/ordinals', turn);
      f.state.currentReaderRender = binding;
      root.remove();
      click('detached current render', turn);
      document.getElementById('viewReader').appendChild(root);
      f.state.currentReaderRender = null;
      click('discarded current binding', turn);
      f.state.currentReaderRender = binding;
      return rows;
    });
    assert.equal(rows.length, 6);
    for (const row of rows) assert.ok(row.unchanged, row.label);
  });
  await check('current', 'Edit Mode keeps its selection classes unchanged, publishes identity and invokes single-click editor once', async () => {
    const rows = await page.evaluate(() => Object.values(readerSnapshots).flatMap(snap => {
      const f = readerFixture, root = f.mount(snap);
      document.getElementById('viewReader').dataset.editMode = 'on';
      const turns = H2O.Studio.getReaderSemanticIndex(root).turns();
      turns[0].target.classList.add('is-ribbon-selected');
      return turns.map((turn, i) => {
        const before = turns.map(t => t.target.className).join('|');
        turn.target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        const edit = f.editorCalls.at(-1);
        return { sameClasses: before === turns.map(t => t.target.className).join('|'),
          context: H2O.Studio.ribbon.getContext(), expectedId: turn.sourceRef.messageId,
          turnIdx: i + 1, calls: f.editorCalls.length,
          correctEditor: edit?.turn === turn.target && edit?.snapshot === snap && edit?.turnIdx === i + 1 };
      });
    }));
    assert.equal(rows.length, 4);
    for (const row of rows) {
      assert.ok(row.sameClasses && row.correctEditor);
      assert.equal(row.calls, row.turnIdx);
      assert.equal(row.context.selectedMessageId, row.expectedId);
      assert.equal(row.context.selectedTurnIdx, row.turnIdx);
      assert.equal(row.context.sentinel, 'preserved');
    }
  });

  await check('current', 'Reader/Dock contexts follow A -> B -> closed and preserve visible saved-editor compatibility', async () => {
    const observed = await page.evaluate(() => {
      const f = readerFixture, api = H2O.Studio, pane = document.getElementById('viewReader');
      const rows = [];
      for (const id of ['A', 'B']) {
        f.state.currentReaderSnapshot = Object.freeze({ snapshotId: 'snap-' + id, chatId: 'chat-' + id });
        rows.push([api.getReaderContext(), api.getDockContext()]);
      }
      f.state.currentReaderSnapshot = null; pane.hidden = true;
      rows.push([api.getReaderContext(), api.getDockContext()]);
      pane.hidden = false; f.state.selectedSnapshotId = 'editor-snap'; f.state.selectedChatId = 'editor-chat';
      rows.push(api.getDockContext());
      f.mount(window.readerSnapshots.rich);
      return rows;
    });
    for (const [i, id] of ['A', 'B'].entries()) {
      assert.deepEqual(observed[i][0], { snapshotId: 'snap-' + id, chatId: 'chat-' + id, title: '' });
      assert.deepEqual(observed[i][1], { snapshotId: 'snap-' + id, chatId: 'chat-' + id, source: 'reader', eligible: true });
    }
    assert.deepEqual(observed[2], [{ snapshotId: '', chatId: '', title: '' }, { snapshotId: '', chatId: '', source: 'none', eligible: false }]);
    assert.deepEqual(observed[3], { snapshotId: 'editor-snap', chatId: 'editor-chat', source: 'saved-editor', eligible: true });
  });
  await check('current', 'T3: goTo / next / previous, boundaries and stale/foreign/disconnected rejection in both projections', async () => {
    const rows = await page.evaluate(vectors => {
      const f = readerFixture, nav = H2O.Studio.readerNavigation, pane = document.getElementById('viewReader');
      const scrollRoot = document.querySelector('.wbMain');
      scrollRoot.style.cssText = 'height:240px;width:640px;overflow:auto;position:relative';
      const keeper = document.createElement('button'); document.body.prepend(keeper);
      return Object.entries(readerSnapshots).flatMap(([mode, snap]) => vectors.cases.map(vector => {
        const oldRoot = f.mount(snap), oldIndex = H2O.Studio.getReaderSemanticIndex(oldRoot);
        const root = f.mount(snap), index = H2O.Studio.getReaderSemanticIndex(root), turns = index.turns();
        turns.forEach(t => { t.target.style.cssText = 'height:180px;margin:0'; });
        const target = { currentRendererRoot: root, projectionKey: turns[vector.targetOrdinal ?? 1].projectionKey };
        if (vector.root === 'discarded-render') {
          target.currentRendererRoot = oldRoot;
          // Even reattaching the old root cannot make the reused key current.
          pane.appendChild(oldRoot);
        }
        if (vector.root === 'foreign-render') target.currentRendererRoot = document.createElement('div');
        if (vector.projectionKey) target.projectionKey = vector.projectionKey;
        if (vector.disconnected) turns[1].target.remove();
        if (vector.selectedOrdinal != null) turns[vector.selectedOrdinal].target.click();
        scrollRoot.scrollTop = 0; keeper.focus();
        const before = { context: H2O.Studio.ribbon.getContext(), publications: f.publications,
          classes: turns.map(t => t.target.className).join('|'), selected: f.state.currentReaderNavigationTarget };
        const effects = [], scrollCalls = [];
        const scroll = scrollRoot.scrollTo;
        scrollRoot.scrollTo = function(options) { effects.push('scroll'); scrollCalls.push(options); return scroll.call(this, options); };
        const focuses = turns.map(t => t.target.focus);
        turns.forEach(t => { const focus = t.target.focus; t.target.focus = function(options) { effects.push(['focus', options]); return focus.call(this, options); }; });
        const ok = vector.operation === 'goTo' ? nav.goTo(target) : nav[vector.operation]();
        scrollRoot.scrollTo = scroll; turns.forEach((t, i) => { t.target.focus = focuses[i]; });
        const expected = Number.isInteger(vector.expectedOrdinal) ? turns[vector.expectedOrdinal] : null;
        const row = { mode, vector, ok, frozen: Object.isFrozen(index) && Object.isFrozen(turns), sameKey: oldIndex.turns()[1].projectionKey === turns[1].projectionKey,
          effects, scrollCalls, selectedCount: root.querySelectorAll('.is-ribbon-selected').length,
          selected: expected ? expected.target.classList.contains('is-ribbon-selected') : false,
          context: H2O.Studio.ribbon.getContext(), expectedId: expected ? index.getMessage(expected.messageKey).sourceRef?.messageId : null,
          publications: f.publications - before.publications,
          focused: document.activeElement === expected?.target, noTabStop: turns.every(t => t.target.tabIndex === -1),
          unchanged: before.context === H2O.Studio.ribbon.getContext() && before.selected === f.state.currentReaderNavigationTarget &&
            before.classes === turns.map(t => t.target.className).join('|') && document.activeElement === keeper && scrollRoot.scrollTop === 0 };
        oldRoot.remove(); return row;
      }));
    }, navigationVectors);
    assert.equal(rows.length, 22);
    for (const row of rows) {
      assert.ok(row.frozen, 'current Renderer index remains immutable');
      assert.ok(row.sameKey, 'stale case really reuses the key');
      if (row.vector.expectedOrdinal == null) {
        assert.equal(row.ok, false, JSON.stringify(row));
        assert.ok(row.unchanged); assert.equal(row.publications, 0); assert.deepEqual(row.effects, []);
      } else {
        assert.equal(row.ok, true, JSON.stringify(row));
        assert.equal(row.context.selectedTurnIdx, row.vector.expectedOrdinal + 1);
        assert.equal(row.context.selectedMessageId, row.expectedId);
        assert.equal(row.context.sentinel, 'preserved');
        assert.equal(row.publications, 1); assert.equal(row.selectedCount, 1);
        assert.ok(row.selected && row.focused && row.noTabStop, JSON.stringify(row));
        assert.deepEqual(row.effects, [['focus', { preventScroll: true }], 'scroll']);
        assert.equal(row.scrollCalls.length, 1); assert.equal(row.scrollCalls[0].behavior, 'auto');
      }
    }
    console.log('  22 navigation vectors PASS (canonical + rich); accepted transitions publish once; rejected transitions have no side effects.');
  });
  await check('current', 'T3: preserve-focus, opt-in smooth, reduced motion and Shell-only nearest scrolling', async () => {
    for (const reducedMotion of ['no-preference', 'reduce']) {
      await page.emulateMedia({ reducedMotion });
      const rows = await page.evaluate(() => Object.values(readerSnapshots).flatMap(snap => [undefined, { preserveFocus: true }, { behavior: 'smooth' }].map(options => {
        const root = readerFixture.mount(snap), nav = H2O.Studio.readerNavigation;
        const turns = H2O.Studio.getReaderSemanticIndex(root).turns();
        turns.forEach(t => { t.target.style.cssText = 'height:180px;margin:0'; });
        const scrollRoot = document.querySelector('.wbMain'); scrollRoot.scrollTop = 0;
        const keeper = document.querySelector('button'); keeper.focus();
        const target = turns[1].target, bounds = target.getBoundingClientRect(), viewport = scrollRoot.getBoundingClientRect();
        const expectedTop = bounds.bottom - viewport.top - scrollRoot.clientTop - scrollRoot.clientHeight;
        const beforeWindow = window.scrollY, calls = [], scroll = scrollRoot.scrollTo;
        scrollRoot.scrollTo = function(options) { calls.push(options); return scroll.call(this, options); };
        const ok = nav.goTo(nav.targetForElement(target), options);
        scrollRoot.scrollTo = scroll;
        return { ok, options, calls, expectedTop, actualTop: scrollRoot.scrollTop,
          preserve: document.activeElement === keeper, focused: document.activeElement === target,
          noTabStop: target.tabIndex === -1, windowUnchanged: window.scrollY === beforeWindow };
      })));
      for (const row of rows) {
        assert.ok(row.ok && row.noTabStop && row.windowUnchanged);
        assert.equal(row.preserve, row.options?.preserveFocus === true);
        assert.equal(row.focused, row.options?.preserveFocus !== true, JSON.stringify(row));
        assert.equal(row.calls.length, 1);
        const behavior = row.options?.behavior === 'smooth' && reducedMotion === 'no-preference' ? 'smooth' : 'auto';
        assert.equal(row.calls[0].behavior, behavior);
        assert.equal(row.calls[0].left, 0);
        assert.ok(Math.abs(row.calls[0].top - row.expectedTop) < 1, JSON.stringify(row));
        if (behavior === 'auto') assert.ok(Math.abs(row.actualTop - row.expectedTop) < 1, JSON.stringify(row));
      }
    }
    console.log('  12 focus/motion vectors PASS; actual immediate scroll stays in the Shell container.');
  });

  await check('current', 'T3: temporary focus accommodation cleans up on blur, existing tabindex is preserved, discard clears selection', async () => {
    const observed = await page.evaluate(() => {
      const f = readerFixture, nav = H2O.Studio.readerNavigation;
      const root = f.mount(readerSnapshots.canonical), turns = H2O.Studio.getReaderSemanticIndex(root).turns();
      const target = nav.targetForElement(turns[0].target);
      nav.goTo(target);
      const focused = document.activeElement === turns[0].target && turns[0].target.getAttribute('tabindex') === '-1';
      document.querySelector('button').focus();
      const cleaned = !turns[0].target.hasAttribute('tabindex');
      turns[1].target.setAttribute('tabindex', '-1');
      nav.next(); // the clicked/navigated first remains the current semantic selection
      document.querySelector('button').focus();
      const preserved = turns[1].target.getAttribute('tabindex') === '-1';
      const before = f.publications;
      f.unmount('reader-m01-t3:leave');
      const discarded = f.state.currentReaderNavigationTarget === null && !nav.goTo(target) && !nav.next() && !nav.previous() && f.publications === before;
      const reopened = f.mount(readerSnapshots.canonical);
      const next = nav.next() && H2O.Studio.ribbon.getContext().selectedTurnIdx === 1;
      return { focused, cleaned, preserved, discarded, reopened: reopened !== root, next };
    });
    assert.ok(Object.values(observed).every(Boolean), JSON.stringify(observed));
  });

  await check('current', 'Reader browser fixture completes without uncaught script errors', () => assert.deepEqual(pageErrors, []));
  // Control-only boot fixture, separate from transcript indexing/navigation.
  // Load all six *real* MiniMap modules in current studio.html order, without
  // stubbing their kernel, core, engine, shell, skin, or views APIs.
  const mmPage = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const minimapErrors = [];
  mmPage.on('pageerror', error => minimapErrors.push(String(error)));
  await mmPage.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body data-route="reader"><main class="wbMain"><div id="viewReader"></div></main></body></html>' }));
  await mmPage.goto('http://reader.test/c/chat-reader');
  await mmPage.addScriptTag({ path: path.join(STUDIO, 'platform/selectors.contract.js') });
  const minimapScripts = Array.from(fs.readFileSync(path.join(STUDIO, 'studio.html'), 'utf8').matchAll(/<script src="\.\/(S1A1[a-f]\. [^"]+MiniMap [^"]+\.js)"><\/script>/g), m => m[1]);
  assert.equal(minimapScripts.length, 6);
  for (const rel of minimapScripts) await mmPage.addScriptTag({ path: path.join(STUDIO, rel) });
  await mmPage.waitForFunction(() => window.H2O_MM_ENGINE_READY === true && window.H2O_MM_SHELL_READY === true, null, { timeout: 10000 });
  // Wait for actual collapsed opacity, including the production boot hold and
  // transition, rather than turning animations off or overriding the CSS.
  await mmPage.waitForFunction(() => {
    const refs = H2O.MM.mnmp.api.ui.getRefs();
    return getComputedStyle(refs.toggle).opacity === '0.15' && refs.root.getBoundingClientRect().width > 0;
  }, null, { timeout: 10000 });
  const minimap = await mmPage.evaluate(() => {
    const api = H2O.MM.mnmp.api.ui, refs = api.getRefs();
    const has = (el, token) => (el.getAttribute('data-cgxui-state') || '').split(/\s+/).includes(token);
    const before = { collapsed: api.getCollapsed(), panelCollapsed: has(refs.panel, 'collapsed'),
      faded: has(refs.toggle, 'faded'), opacity: getComputedStyle(refs.toggle).opacity,
      ariaLabel: refs.toggle.getAttribute('aria-label'), title: refs.toggle.getAttribute('title'),
      tag: refs.toggle.tagName, tabIndex: refs.toggle.tabIndex, role: refs.toggle.getAttribute('role') };
    // Execute the actual bound toggle gesture, not a replacement toggle function.
    refs.toggle.click();
    const expanded = !has(refs.panel, 'collapsed') && !has(refs.dial, 'collapsed') && !has(refs.toggle, 'faded');
    refs.toggle.click();
    return { before, expanded, collapsedAgain: has(refs.panel, 'collapsed'),
      modules: ['KERNEL', 'VIEWS', 'SKIN', 'SHELL', 'CORE', 'ENGINE'].map(name => window['H2O_MM_' + name + '_READY']),
      mounted: [refs.root, refs.panel, refs.toggle, refs.dial].every(el => el.isConnected),
      realCore: H2O.MM.mnmp.api.core.ver !== 'kernel-core-stub' && typeof H2O.MM.mnmp.api.core.rebuildNow === 'function',
      engineReady: H2O_MM_ENGINE_READY,
    };
  });
  await check('current', 'MiniMap control fixture: modules, shell mount, core/engine boot and programmatic toggle expand/collapse are healthy', () => {
    assert.deepEqual(minimap.modules, [true, true, true, true, true, true]);
    assert.ok(minimap.mounted && minimap.realCore && minimap.engineReady);
    assert.ok(minimap.before.collapsed && minimap.before.panelCollapsed && minimap.before.faded);
    assert.ok(minimap.expanded && minimap.collapsedAgain);
  });
  await check('baseline', 'RDR-LIVE-002: collapsed access opacity 0.15; no aria-label/title; div outside keyboard tab order', () => {
    assert.equal(minimap.before.opacity, '0.15');
    assert.equal(minimap.before.ariaLabel, null);
    assert.equal(minimap.before.title, null);
    assert.equal(minimap.before.tag, 'DIV');
    assert.equal(minimap.before.tabIndex, -1);
    assert.equal(minimap.before.role, null);
    console.log(`  RDR-LIVE-002 observation: ${JSON.stringify(minimap)}`);
  });
  console.log('FUTURE POST-FIX EXPECTATION (T4; pending): visible collapsed affordance and focus indicator; pointer click and Tab/Enter/Space expand/collapse; accessible name; preserve all six modules and working engine. See companion contract for acceptance vectors.');
  await check('current', 'MiniMap control fixture completes without uncaught script errors', () => assert.deepEqual(minimapErrors, []));
  // Populate the same real MiniMap fixture only after proving empty boot.
  for (const rel of rendererScripts.slice(1)) await mmPage.addScriptTag({ path: path.join(STUDIO, rel) });
  await mmPage.addScriptTag({ content: readerSeamsScript });
  const snapshots = await page.evaluate(() => readerSnapshots);
  const populated = await mmPage.evaluate(snapshots => {
    window.readerSnapshots = snapshots;
    document.getElementById('viewReader').className = 'wbReader';
    const diagnostics = H2O_MM_SHARED.diag.ensure().errors;
    return Object.entries(snapshots).map(([mode, snap]) => {
      readerFixture.mount(snap);
      const before = diagnostics.length;
      const core = H2O.MM.mnmp.api.core;
      const result = core.rebuildNow('reader-m01-t3:populated');
      return { mode, result, turns: core.getTurnList().map(t => ({ turnId: t.turnId, answerId: t.answerId, index: t.index, keys: Object.keys(t) })),
        errors: diagnostics.slice(before).map(e => `${e.msg}: ${String(e.where)}`) };
    });
  }, snapshots);
  await check('current', 'RDR-M01-T1-OBS-001 resolved: populated real MiniMap Core rebuilding succeeds in both projections', () => {
    for (const row of populated) {
      assert.equal(row.result?.ok, true, JSON.stringify(row));
      assert.notEqual(row.result?.status, 'error');
      assert.ok(row.turns.length > 0); assert.deepEqual(row.errors, []);
    }
    console.log(`  Populated rebuild: ${JSON.stringify(populated)}`);
  });

  await mmPage.addScriptTag({ path: path.join(STUDIO, 'S0A1a. 🎬 H2O Core - Studio.js') });
  await check('current', 'MiniMap Engine API and real button dispatch use Reader navigation with current Core membership', async () => {
    const rows = await mmPage.evaluate(async () => {
      const rows = [];
      for (const [mode, snap] of Object.entries(readerSnapshots)) {
      await new Promise(resolve => setTimeout(resolve, 440)); // distinct user gestures, outside double-click suppression
      const root = readerFixture.mount(snap), index = H2O.Studio.getReaderSemanticIndex(root);
      H2O.index.refresh('reader-m01-t3');
      const core = H2O.MM.mnmp.api.core, engine = H2O.MM.mnmp.api.rt;
      core.rebuildNow('reader-m01-t3:engine');
      const turn = core.getTurnList()[0], btn = core.getBtnById(turn.turnId);
      const api = H2O.Studio.readerNavigation, calls = [];
      H2O.Studio.readerNavigation = { ...api, goTo(target, options) {
        calls.push({ current: target.currentRendererRoot === root, key: target.projectionKey, options });
        return api.goTo(target, options);
      } };
      const before = readerFixture.publications;
      const ok = engine.setActiveTurnId(turn.turnId);
      const apiContext = H2O.Studio.ribbon.getContext();
      const afterApi = readerFixture.publications;
      btn.click();
      const buttonContext = H2O.Studio.ribbon.getContext();
      const afterButton = readerFixture.publications;
      H2O.MM.mnmp.api.ui.setViewMode('qa'); core.rebuildNow('reader-m01-t3:qa');
      const qBtn = document.querySelector('[data-cgxui="mnmp-qbtn"], [data-cgxui="mm-qbtn"]');
      if (qBtn) {
        qBtn.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 }));
        qBtn.click();
      }
      const questionContext = H2O.Studio.ribbon.getContext();
      H2O.Studio.readerNavigation = api;
      rows.push({ mode, ok, calls, apiContext, buttonContext, apiPublications: afterApi - before,
        buttonPublications: afterButton - afterApi, questionPublications: readerFixture.publications - afterButton, questionContext, qBtn: !!qBtn, expectedKey: index.turns()[1].projectionKey,
        turn: { id: turn.turnId, keys: Object.keys(core.getTurnById(turn.turnId)), btn: btn.outerHTML },
        focused: document.activeElement === index.turns()[0].target });
      }
      return rows;
    });
    for (const row of rows) {
      assert.ok(row.ok, JSON.stringify(row));
      assert.equal(row.calls.length, 3, JSON.stringify(row));
      assert.ok(row.calls.every(c => c.current));
      assert.ok(row.calls.slice(0, 2).every(c => c.key === row.expectedKey));
      assert.equal(row.questionPublications, 1, JSON.stringify(row));
      assert.ok(row.qBtn); assert.equal(row.questionContext.selectedMessageId, 'u-1');
      assert.equal(row.questionContext.selectedTurnIdx, 1);
      assert.equal(row.apiPublications, 1); assert.equal(row.buttonPublications, 1);
      assert.equal(row.apiContext.selectedMessageId, 'a-1'); assert.equal(row.apiContext.selectedTurnIdx, 2);
      assert.deepEqual(row.apiContext, row.buttonContext); assert.ok(row.focused);
    }
    console.log('  Real MiniMap Engine setActiveTurnId + answer click + question pointer/click: canonical/rich PASS, one Reader publication each.');
  });

  await check('current', 'MiniMap Core keeps true Q+A numbering across an unanswered turn via the real runtime', async () => {
    const observed = await mmPage.evaluate(() => {
      const snap = { snapshotId: 'snap-gaps', chatId: 'chat-gaps', messages: [
        { role: 'user', messageId: 'q-gap', text: 'unanswered' },
        { role: 'user', messageId: 'q-2', text: 'second question' },
        { role: 'assistant', messageId: 'a-2', text: 'second answer' },
        { role: 'user', messageId: 'q-3', text: 'third question' },
        { role: 'assistant', messageId: 'a-3', text: 'third answer' },
      ] };
      readerFixture.mount(snap); H2O.index.refresh('reader-m01-t3:gaps');
      const core = H2O.MM.mnmp.api.core, result = core.rebuildNow('reader-m01-t3:gaps');
      return { result, turns: core.getTurnList().map(t => ({ answerId: t.answerId, index: t.index,
        runtime: H2O.turnRuntime.getTurnRecordByTurnId(t.turnId)?.turnNo, button: Number(core.getBtnById(t.turnId)?.dataset?.turnIdx) })),
        unanswered: H2O.turnRuntime.getTurnRecordByQId('q-gap')?.hasAssistant };
    });
    assert.ok(observed.result.ok, JSON.stringify(observed));
    assert.deepEqual(observed.turns, [{ answerId: '', index: 1, runtime: 1, button: 1 }, { answerId: 'a-2', index: 2, runtime: 2, button: 2 }, { answerId: 'a-3', index: 3, runtime: 3, button: 3 }]);
    assert.equal(observed.unanswered, false);
  });

  // Exercise the repaired priority branch directly with the actual runtime:
  // the full Core may choose its shared-record fast path before this helper.
  const coreSource = fs.readFileSync(path.join(STUDIO, 'S1A1b. 🎬 MiniMap Core - Studio.js'), 'utf8');
  const coreSeams = ['getTurnRuntimeApi', 'normalizePaginationTurnId', 'normalizePaginationAnswerId', 'buildCanonicalTurnCollection']
    .map(name => extract(name, false, coreSource)).join('\n');
  await mmPage.addScriptTag({ content: `(() => {
    const W = window, TOPW = window;
    ${coreSeams}
    window.readerCoreCollection = buildCanonicalTurnCollection;
  })();` });
  await check('current', 'Core canonical collection uses runtime pair numbers before pagination/row fallbacks; runtime unavailable stays safe', async () => {
    const row = await mmPage.evaluate(() => {
      const rows = [{ answerId: 'a-2', answerIndex: 22, turnNo: 42 }, { answerId: 'a-3', turnNo: 43 }];
      const runtime = H2O.turnRuntime;
      const linked = readerCoreCollection(rows).list.map(t => t.index);
      let fallback;
      try {
        H2O.turnRuntime = null;
        fallback = readerCoreCollection(rows).list.map(t => t.index);
      } finally { H2O.turnRuntime = runtime; }
      return { linked, fallback, empty: readerCoreCollection([]) };
    });
    assert.deepEqual(row, { linked: [2, 3], fallback: [22, 43], empty: null });
  });

  await check('current', 'MiniMap page divider uses the same Reader path; stale Core target cannot select the replacement render', async () => {
    // Let the previous pointer gesture leave the existing double-click window.
    await mmPage.waitForTimeout(440);
    await mmPage.evaluate(() => {
      const f = readerFixture, root = f.mount(readerSnapshots.rich);
      H2O.index.refresh('reader-m01-t3:page');
      const core = H2O.MM.mnmp.api.core;
      core.rebuildNow('reader-m01-t3:page');
      const api = H2O.Studio.readerNavigation;
      window.mmPageCalls = [];
      window.mmOriginalNavigation = api;
      H2O.Studio.readerNavigation = { ...api, goTo(target, options) {
        mmPageCalls.push({ current: target.currentRendererRoot === root, key: target.projectionKey });
        return api.goTo(target, options);
      } };
      document.querySelector('.cgxui-mm-page-divider-label').click();
    });
    await mmPage.waitForFunction(() => readerFixture.publications === 1, null, { timeout: 3000 });
    const row = await mmPage.evaluate(() => {
      const f = readerFixture, core = H2O.MM.mnmp.api.core, engine = H2O.MM.mnmp.api.rt;
      const context = H2O.Studio.ribbon.getContext(), calls = mmPageCalls.slice();
      H2O.Studio.readerNavigation = mmOriginalNavigation;
      const oldTurn = core.getTurnList()[0];
      const root = f.mount(readerSnapshots.rich);
      const before = H2O.Studio.ribbon.getContext(), active = document.activeElement;
      const scrollRoot = document.querySelector('.wbMain'), scroll = scrollRoot.scrollTo, effects = [];
      scrollRoot.scrollTo = (...args) => effects.push(args);
      const ok = engine.setActiveTurnId(oldTurn.turnId);
      scrollRoot.scrollTo = scroll;
      return { context, calls, ok, unchanged: f.publications === 0 && before === H2O.Studio.ribbon.getContext() && document.activeElement === active && effects.length === 0,
        newRoot: root !== oldTurn.el?.closest('.cgFrame') };
    });
    assert.equal(row.calls.length, 1); assert.ok(row.calls[0].current);
    assert.equal(row.context.selectedMessageId, 'a-1'); assert.equal(row.context.selectedTurnIdx, 2);
    assert.equal(row.ok, false); assert.ok(row.unchanged && row.newRoot, JSON.stringify(row));
  });

} catch (error) {
  results.failed += 1;
  console.error(`FAIL: required Chromium fixture unavailable or incomplete (never a SKIP/PASS)\n${error.stack || error}`);
} finally {
  await browser?.close();
}
console.log(`\nREADER M01 T3: ${JSON.stringify(results)}; lifecycle counts reported above; future behavior is NOT counted as passing current behavior.`);
process.exitCode = results.failed ? 1 : 0;
