#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
const storeSource = read('src-surfaces-base/studio/store/highlights.js');
const engineSource = read('src-surfaces-base/studio/S3H1a. 🎬 Highlights Engine - Studio.js');
const dockSource = read('src-surfaces-base/studio/dock/tabs/highlights.tab.studio.js');
const key = 'h2o:prm:cgx:nlnhghlghtr:state:inline_highlights:v3';
const colors = ['blue', 'red', 'green', 'gold', 'sky', 'pink', 'purple', 'orange'];
const results = [];

async function check(name, run) {
  await run();
  results.push(name);
  console.log(`PASS ${results.length}: ${name}`);
}

const initial = {
  itemsByAnswer: {
    'answer-a': [
      { id: 'hl-1', color: 'gold', ts: 1, pairNo: 2, convoId: 'c/chat-1',
        anchors: { xpath: '/p[1]', textPos: { start: 0, end: 5 }, textQuote: { exact: 'hello' } },
        other: { keep: true } },
      { id: 'hl-2', color: 'blue', ts: 2, pairNo: 2, convoId: 'c/chat-1', anchors: { textQuote: { exact: 'world' } } },
    ],
    'answer-b': [{ id: 'hl-foreign', color: 'green', ts: 3, convoId: 'c/chat-2' }],
  },
  _meta: { currentColor: 'gold' },
};

const context = vm.createContext({ console, setTimeout: () => 1, clearTimeout: () => {} });
vm.runInContext(`
  var window = globalThis;
  var disk = { ${JSON.stringify(key)}: JSON.parse(${JSON.stringify(JSON.stringify(initial))}) };
  var writes = 0, failNextWrite = false, listeners = [], storeEvents = [], miniMapEvents = [];
  var chrome = {
    runtime: { lastError: null },
    storage: {
      onChanged: { addListener(fn) { listeners.push(fn); }, removeListener(fn) { listeners = listeners.filter(x => x !== fn); } },
      local: {
        get(keys, cb) { cb({ [${JSON.stringify(key)}]: JSON.parse(JSON.stringify(disk[${JSON.stringify(key)}])) }); },
        set(record, cb) {
          if (failNextWrite) {
            failNextWrite = false;
            chrome.runtime.lastError = { message: 'disk denied' };
            cb();
            chrome.runtime.lastError = null;
            return;
          }
          const oldValue = JSON.parse(JSON.stringify(disk[${JSON.stringify(key)}]));
          disk[${JSON.stringify(key)}] = JSON.parse(JSON.stringify(record[${JSON.stringify(key)}]));
          writes += 1;
          const change = { [${JSON.stringify(key)}]: { oldValue, newValue: JSON.parse(JSON.stringify(disk[${JSON.stringify(key)}])) } };
          listeners.forEach(fn => fn(change, 'local'));
          cb();
        },
      },
    },
  };
  var H2O = { Studio: { store: { __registerEntity(name, api) { this[name] = api; } } } };
  var flagMode = false;
  H2O.flags = { get(_key, fallback) { return flagMode; } };
  window.syncMiniMapDot = (answerId, colorSet, opts) => miniMapEvents.push({ answerId, colorSet, opts });
`, context);
vm.runInContext(storeSource, context, { filename: 'store/highlights.js' });
const store = context.H2O.Studio.store.highlights;
await store.init();
store.subscribe((event) => context.storeEvents.push(event));

const mark = { color: 'gold', removed: false };
const message = {
  isConnected: true,
  getAttribute(name) { return name === 'data-message-id' ? this.messageId : null; },
  messageId: 'answer-a',
  querySelectorAll(selector) { return !mark.removed && selector.includes('hl-1') ? [mark] : []; },
};
const rendererRoot = { isConnected: true, contains(node) { return node === message; } };
const pane = { contains(node) { return node === rendererRoot; } };
const conversation = { target: rendererRoot, sourceRef: { chatId: 'chat-1' } };
const messageRecord = { kind: 'message', role: 'assistant', sourceRef: { messageId: 'answer-a' }, target: message };
const index = { getConversation: () => conversation, messages: () => [messageRecord] };
const dockContext = { eligible: true, chatId: 'chat-1', snapshotId: 'display-only' };
context.document = { getElementById: (id) => id === 'viewReader' ? pane : null };
context.H2O.studioHost = { getReaderRoot: () => rendererRoot };
context.H2O.Studio.getDockContext = () => dockContext;
context.H2O.Studio.getReaderSemanticIndex = (rootArg) => rootArg === rendererRoot ? index : null;

const start = engineSource.indexOf("  const HL_DOCK_FLAG = 'studio.dock.highlightsWriteBack.enabled';");
const end = engineSource.indexOf('  const HL_turnToAnswerId =', start);
assert.ok(start > 0 && end > start, 'precise Authoring bridge exists');
const bridge = engineSource.slice(start, end);
context.bridge = vm.runInContext(`(() => {
  const W = window, H2O = window.H2O;
  const PAL_names = () => ${JSON.stringify(colors)};
  const CSS_CLS_HL = 'cgxui-inhl-inline-hl';
  const ATTR_HL_ID = 'data-highlight-id';
  const UTIL_cssEsc = value => String(value);
  const HL_setMarkColor = (element, color) => { element.color = color; };
  const HL_unwrapById = id => { if (id === 'hl-1') window.mark.removed = true; };
  const HL_restoreMessage = () => { window.restores += 1; };
  const HL_notifyChanged = () => { window.notifications += 1; };
  const HL_emitInlineChanged = () => { window.inlineEvents += 1; };
  const STORE_colorsFrom = answerId => (H2O.Studio.store.highlights.getForAnswer(answerId) || []).map(x => x.color);
  ${bridge}
  return { write: HL_writeExistingFromDock, enabled: HL_dockWriteEnabled, resolve: HL_resolveDockTarget };
})()`, context, { filename: 'S3H1a-Dock-bridge.js' });
context.mark = mark;
context.restores = 0;
context.notifications = 0;
context.inlineEvents = 0;
const request = { currentRendererRoot: rendererRoot, chatId: 'chat-1', answerId: 'answer-a', highlightId: 'hl-1', color: 'red' };
const snapshot = { id: 'display-only', messages: [{ id: 'answer-a', body: 'untouched' }] };
const snapshotBefore = JSON.stringify(snapshot);
const disk = () => JSON.parse(JSON.stringify(context.disk[key]));
const target = () => disk().itemsByAnswer['answer-a'].find(x => x.id === 'hl-1');

await check('flag defaults off and causes zero writes', async () => {
  assert.equal(context.bridge.enabled(), false);
  assert.equal((await context.bridge.write('recolor', request)).ok, false);
  assert.equal(context.writes, 0);
});
await check('missing, throwing and malformed flags fail closed', async () => {
  context.H2O.flags = null;
  assert.equal(context.bridge.enabled(), false);
  context.H2O.flags = { get() { throw new Error('bad flags'); } };
  assert.equal(context.bridge.enabled(), false);
  context.H2O.flags = { get: () => 'true' };
  assert.equal(context.bridge.enabled(), false);
  assert.equal(context.writes, 0);
  context.H2O.flags = { get: () => true };
});
await check('canonical eight-color restriction rejects other names', async () => {
  assert.equal((await context.bridge.write('recolor', { ...request, color: 'teal' })).ok, false);
  assert.equal(context.writes, 0);
  const paletteBlock = engineSource.match(/const CFG_PALETTE_DEFAULTS = Object\.freeze\(\[([\s\S]*?)\]\);/)?.[1] || '';
  const canonicalNames = [...paletteBlock.matchAll(/title:\s*'([^']+)'/g)].map(match => match[1]);
  assert.deepEqual(canonicalNames, colors);
});
await check('current root, answerId and highlight id bind the action', async () => {
  assert.ok(context.bridge.resolve(request));
  assert.equal(context.bridge.resolve({ ...request, answerId: 'answer-b' }), null);
  assert.equal(context.bridge.resolve({ ...request, currentRendererRoot: {} }), null);
  assert.equal((await context.bridge.write('recolor', { ...request, highlightId: 'absent' })).ok, false);
  assert.equal(context.writes, 0);
});
await check('stale message and foreign Reader root fail closed', async () => {
  message.messageId = 'stale';
  assert.equal((await context.bridge.write('recolor', request)).ok, false);
  message.messageId = 'answer-a';
  dockContext.chatId = 'chat-2';
  assert.equal((await context.bridge.write('recolor', request)).ok, false);
  dockContext.chatId = 'chat-1';
  assert.equal(context.writes, 0);
});
await check('one existing item recolors with advanced ts and preserved fields', async () => {
  const before = target();
  const result = await context.bridge.write('recolor', request);
  assert.equal(result.ok, true);
  const after = target();
  assert.equal(after.id, before.id);
  assert.deepEqual(after.anchors, before.anchors);
  assert.equal(after.pairNo, before.pairNo);
  assert.deepEqual(after.other, before.other);
  assert.ok(after.ts > before.ts);
  assert.equal(after.color, 'red');
  assert.equal(context.writes, 1);
});
await check('unrelated highlights and schema remain intact', async () => {
  assert.equal(disk().itemsByAnswer['answer-a'].find(x => x.id === 'hl-2').color, 'blue');
  assert.equal(disk().itemsByAnswer['answer-b'][0].color, 'green');
  assert.equal(store.diagnose().schemaVersion, 3);
  assert.equal(store.diagnose().canonicalKey, key);
  assert.equal(disk()._meta.source, 'studio');
});
await check('Store, DOM, MiniMap and change events follow confirmed recolor', async () => {
  assert.equal(store.getForAnswer('answer-a')[0].color, 'red');
  assert.equal(mark.color, 'red');
  assert.ok(context.miniMapEvents.some(e => e.answerId === 'answer-a'));
  assert.ok(context.notifications > 0 && context.inlineEvents > 0);
  assert.ok(context.storeEvents.some(e => e.op === 'applyExisting'));
});
await check('failed persistence reloads canonical Store without optimistic success', async () => {
  const before = disk();
  const writesBefore = context.writes;
  context.failNextWrite = true;
  const result = await context.bridge.write('recolor', { ...request, color: 'purple' });
  assert.equal(result.ok, false);
  assert.deepEqual(disk(), before);
  assert.equal(context.writes, writesBefore);
  assert.equal(store.getForAnswer('answer-a')[0].color, 'red');
  assert.equal(mark.color, 'red');
});
await check('hard delete removes exactly one item without a tombstone', async () => {
  const before = context.writes;
  const result = await context.bridge.write('remove', request);
  assert.equal(result.ok, true);
  assert.equal(context.writes, before + 1);
  assert.equal(target(), undefined);
  assert.equal(disk().itemsByAnswer['answer-a'].length, 1);
  assert.equal(disk().itemsByAnswer['answer-b'].length, 1);
  assert.equal(mark.removed, true);
  assert.ok(!JSON.stringify(disk()).includes('tombstone'));
});
await check('storage change listener does not write back or resurrect hard delete', async () => {
  const before = context.writes;
  assert.equal(store.getForAnswer('answer-a').some(x => x.id === 'hl-1'), false);
  assert.equal(context.writes, before);
  assert.equal(context.listeners.length, 1);
});
await check('snapshot remains display-only and Dock performs no direct storage write', async () => {
  assert.equal(JSON.stringify(snapshot), snapshotBefore);
  assert.ok(!/chrome\s*\.\s*storage\s*\.\s*local\s*\.\s*(set|remove|clear)\s*\(/.test(dockSource));
  assert.ok(dockSource.includes('H2O.inline'));
});
await check('flag is evaluated at render and action; no create, scoring or export path', async () => {
  assert.ok(dockSource.includes('writeEnabled() ? currentActionContext'));
  assert.ok(dockSource.includes('if (busy || !active || !writeEnabled())'));
  assert.ok(bridge.includes('HL_dockWriteEnabled() && !!HL_resolveDockTarget(request)'));
  assert.ok(!/createHighlight|smartScor|exportHighlight|snapshot\s*\./i.test(bridge));
  assert.ok(!/new\s+Storage|new\s+Overlay|tombstone/i.test(bridge));
});

class TestNode {
  constructor(tag) {
    this.tag = tag;
    this.children = [];
    this.attributes = {};
    this.listeners = {};
    this.style = { setProperty() {} };
    this.textContent = '';
  }
  get firstChild() { return this.children[0] || null; }
  appendChild(child) { this.children.push(child); return child; }
  removeChild(child) { this.children.splice(this.children.indexOf(child), 1); return child; }
  setAttribute(name, value) { this.attributes[name] = value; }
  addEventListener(name, listener) { this.listeners[name] = listener; }
  fire(name) { this.listeners[name]?.(); }
}
const descendants = (node, tag) => node.children.flatMap(child =>
  [ ...(child.tag === tag ? [child] : []), ...descendants(child, tag) ]);
context.document.createElement = tag => new TestNode(tag);
let tab;
context.H2O.Studio.dock = { registerTab(name, definition) {
  assert.equal(name, 'highlights');
  tab = definition;
} };
vm.runInContext(dockSource, context, { filename: 'dock/tabs/highlights.tab.studio.js' });
const container = new TestNode('div');
const renderDock = () => tab.render(container, { readerRoot: pane, snapshotId: snapshot.id });
const dockCalls = [];
context.H2O.inline = {
  async recolorExistingHighlight(args) { dockCalls.push({ op: 'recolor', args }); return { ok: true }; },
  async removeExistingHighlight(args) { dockCalls.push({ op: 'remove', args }); return { ok: true }; },
};

await check('actual Dock rendering stays read-only with flag off or missing', async () => {
  context.H2O.flags = { get: () => false };
  const writesBefore = context.writes;
  let cleanup = renderDock();
  assert.equal(descendants(container, 'select').length, 0);
  assert.equal(descendants(container, 'button').length, 0);
  cleanup();
  context.H2O.flags = null;
  cleanup = renderDock();
  assert.equal(descendants(container, 'select').length, 0);
  assert.equal(context.writes, writesBefore);
  cleanup();
});
await check('actual Dock renders one eligible message and canonical eight controls', async () => {
  context.H2O.flags = { get: () => true };
  const cleanup = renderDock();
  const selects = descendants(container, 'select');
  assert.equal(selects.length, 1, 'foreign answer has no action control');
  assert.equal(descendants(container, 'button').length, 1);
  assert.deepEqual(selects[0].children.map(option => option.value), colors);
  cleanup();
});
await check('actual Dock delegates exact current answer and id to Authoring APIs', async () => {
  const cleanup = renderDock();
  const select = descendants(container, 'select')[0];
  select.value = 'pink';
  select.fire('change');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(dockCalls.length, 1);
  assert.equal(dockCalls[0].op, 'recolor');
  assert.equal(dockCalls[0].args.answerId, 'answer-a');
  assert.equal(dockCalls[0].args.highlightId, 'hl-2');
  assert.equal(dockCalls[0].args.currentRendererRoot, rendererRoot);
  assert.equal(dockCalls[0].args.chatId, 'chat-1');
  assert.equal(dockCalls[0].args.color, 'pink');
  descendants(container, 'button')[0].fire('click');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(dockCalls.length, 2);
  assert.equal(dockCalls[1].op, 'remove');
  assert.equal(dockCalls[1].args.highlightId, 'hl-2');
  assert.equal(JSON.stringify(snapshot), snapshotBefore);
  cleanup();
});
await check('captured Dock control fails closed when flag turns off before action', async () => {
  const cleanup = renderDock();
  const oldControl = descendants(container, 'button')[0];
  const before = dockCalls.length;
  context.H2O.flags = { get: () => false };
  oldControl.fire('click');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(dockCalls.length, before);
  assert.equal(descendants(container, 'button').length, 0);
  cleanup();
});
await check('captured Dock control fails closed when flags throw at action time', async () => {
  context.H2O.flags = { get: () => true };
  const cleanup = renderDock();
  const oldControl = descendants(container, 'button')[0];
  const before = dockCalls.length;
  context.H2O.flags = { get() { throw new Error('flags unavailable'); } };
  oldControl.fire('click');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(dockCalls.length, before);
  cleanup();
});

console.log(`PASS ${results.length} focused Highlights write-back groups`);
