#!/usr/bin/env node
// Reader M01 T1: current contracts, named baseline gaps, and unimplemented
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
function extract(name, assigned = false) {
  const marker = assigned ? `H2O.Studio.${name} = function` : `function ${name}(`;
  const at = source.indexOf(marker);
  assert.ok(at >= 0, `missing source seam: ${name}`);
  const start = assigned ? source.indexOf('function', at) : at;
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    if (source[i] === '}' && --depth === 0) {
      const fn = source.slice(start, i + 1);
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

// Proposed T3 acceptance data, NOT a mock navigation implementation. The browser
// check below only proves these references resolve against the real current index.
const navigationVectors = Object.freeze({
  status: 'pending-T3',
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
  await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body data-route="reader"><main class="wbMain"><div id="viewReader"></div></main></body></html>' }));
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
  const seams = ['getStudioChatRenderer', 'bindReaderSemanticIndex', 'getReaderSemanticIndex', 'getReaderDecorationContributions', 'buildReaderDOM'].map(name => extract(name)).join('\n');
  await page.addScriptTag({ content: `(() => {
    const W = window, H2O = W.H2O;
    const state = { currentReaderSnapshot: null, currentReaderRender: null, selectedSnapshotId: '', selectedChatId: '' };
    let mounted = null, ribbonContext = {}, publications = 0;
    H2O.studioHost = {
      mount(opts) { mounted = opts; },
      getReaderRoot: () => mounted?.readerRoot,
      getTurnsRoot: () => mounted?.turnsEl,
      getScrollRoot: () => document.querySelector('.wbMain'),
    };
    H2O.util = { getChatId: () => state.currentReaderSnapshot?.chatId || '' };
    H2O.Studio.ribbon = { getContext: () => ribbonContext, setContext(ctx) { publications++; ribbonContext = ctx; } };
    const getEditOverride = () => null;
    const syncReaderTopOffset = () => {};
    const refreshReaderOverlay = () => {};
    ${seams}
    H2O.Studio.getReaderContext = ${extract('getReaderContext', true)};
    H2O.Studio.getDockContext = ${extract('getDockContext', true)};
    H2O.Studio.getReaderSemanticIndex = getReaderSemanticIndex;
    H2O.Studio.getReaderDecorationContributions = getReaderDecorationContributions;
    window.readerFixture = {
      state, get publications() { return publications; },
      mount(snap) {
        state.currentReaderRender?.decorationContributions?.disposeAll();
        state.currentReaderSnapshot = snap;
        ribbonContext = { route: 'reader', sentinel: 'preserved' }; publications = 0;
        const root = buildReaderDOM(snap);
        document.getElementById('viewReader').replaceChildren(root);
        return root;
      },
      get mounted() { return mounted; },
    };
  })();` });

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
      const button = document.createElement('button'); turns[0].appendChild(button); button.click();
      readerFixture.mounted.turnsEl.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      return { rich, reversed, mode: index.renderMode, rows, ignoredClicks: readerFixture.publications === before,
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
      assert.ok(run.ignoredClicks);
    }
  });
  await check('current', 'buildReaderDOM binds the exact real Renderer root/index/decorations and supplies the host', () => {
    for (const run of selection) assert.ok(run.bound && run.sameLifecycle);
  });
  await check('baseline', 'RDR-LIVE-001: rich assistant outer ID absent, inner ID present, turn correct, selectedMessageId null', () => {
    const row = selection.find(r => r.rich && !r.reversed).rows[1];
    assert.equal(row.outerId, null);
    assert.equal(row.innerId, 'a-1');
    assert.equal(row.sourceId, 'a-1');
    assert.equal(row.context.selectedTurnIdx, 2);
    assert.equal(row.context.selectedMessageId, null);
    console.log(`  RDR-LIVE-001 observation: ${JSON.stringify(row)}`);
    // The actual Renderer also exhibits this nesting in the canonical fixture
    // and for user turns. Pin that observed scope instead of assuming they pass.
    for (const run of selection) for (const selected of run.rows) {
      assert.equal(selected.outerId, null);
      assert.equal(selected.innerId, selected.sourceId);
      assert.equal(selected.context.selectedMessageId, null);
    }
    console.log('  Same identity gap reproduced for both roles in canonical and rich fixtures, including reversed role order.');
  });
  await check('fixture', 'T2: canonical AND rich, both roles, message identity comes from the selected index-linked message', () => {
    for (const run of selection) for (const row of run.rows) assert.equal(row.sourceId, row.role === 'user' ? 'u-1' : 'a-1');
    // T2 promotion: assert row.context.selectedMessageId === row.sourceId for
    // EVERY row above, replacing the RDR-LIVE-001 null diagnostic.
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
  await check('fixture', 'T3: goTo/next/previous vectors resolve against the current immutable Semantic Index; navigation/focus/scroll remain pending', async () => {
    const observed = await page.evaluate(vectors => {
      const root = readerFixture.state.currentReaderRender.root;
      const index = H2O.Studio.getReaderSemanticIndex(root);
      return { frozen: Object.isFrozen(index) && Object.isFrozen(index.turns()),
        foreign: H2O.Studio.getReaderSemanticIndex(document.createElement('div')),
        targets: vectors.cases.filter(c => Number.isInteger(c.expectedOrdinal)).map(c => {
          const turn = index.turns()[c.expectedOrdinal];
          return index.getTurn(turn.projectionKey) === turn && root.contains(turn.target) && !!index.getMessage(turn.messageKey);
        }),
      };
    }, navigationVectors);
    assert.ok(observed.frozen);
    assert.equal(observed.foreign, null);
    assert.ok(observed.targets.length > 0 && observed.targets.every(Boolean));
    console.log(`  FUTURE T3 vectors: ${JSON.stringify(navigationVectors)}`);
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
  // Keep the additional populated-content finding visible; it is not a T1 fix
  // and must not be hidden behind the healthy control-only boot result.
  const transcript = await page.evaluate(() => readerFixture.state.currentReaderRender.root.outerHTML);
  const populated = await mmPage.evaluate(html => {
    document.getElementById('viewReader').innerHTML = html;
    const diagnostics = H2O_MM_SHARED.diag.ensure().errors;
    const before = diagnostics.length;
    const result = H2O.MM.mnmp.api.core.rebuildNow('reader-m01-t1:populated');
    return { result, errors: diagnostics.slice(before).map(e => `${e.msg}: ${String(e.where)}`) };
  }, transcript);
  await check('baseline', 'RDR-M01-T1-OBS-001: populated MiniMap rebuild encounters undeclared rt (separate from healthy boot/toggle)', () => {
    assert.equal(populated.result?.status, 'error');
    assert.equal(populated.result?.ok, false);
    assert.match(populated.errors.join('\n'), /rt is not defined/);
    console.log(`  RDR-M01-T1-OBS-001 observation: ${JSON.stringify(populated)}`);
  });
} catch (error) {
  results.failed += 1;
  console.error(`FAIL: required Chromium fixture unavailable or incomplete (never a SKIP/PASS)\n${error.stack || error}`);
} finally {
  await browser?.close();
}
console.log(`\nREADER M01 T1: ${JSON.stringify(results)}; lifecycle counts reported above; future behavior is NOT counted as passing current behavior.`);
process.exitCode = results.failed ? 1 : 0;
