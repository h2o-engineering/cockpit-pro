#!/usr/bin/env node
// C5-C focused validator — Studio Host runtime identity + local-file adapters.
//
// Executes the production platform/index.js, platform.mv3.js, platform.tauri.js
// and settings/build-identity.panel.js inside vm sandboxes with mocked hosts,
// and proves the frozen C5-C boundary:
//   V1  fallback runtime identity fails closed
//   V2  MV3 identity reads the real adapter and exposes only loaded facts
//   V3  MV3 derives nothing from names (channel / variant / Lane / BTP / provenance)
//   V4  Tauri identity invokes h2o_studio_desktop_build_identity through the adapter
//   V5  Tauri passes the governed payload through without reinterpretation
//   V6  build-identity.panel consumes Platform runtime identity, not Tauri invoke
//   V7  MV3 importFile = picker + text read → normalized { name, size, type, text }
//   V8  MV3 cancel is non-error (null)
//   V9  Tauri importFile = dialog open + read_text_file → same normalized shape
//   V10 Tauri cancel is non-error (null)
//   V11 no JSON parsing / Saved Chats bundle semantics inside Host importFile
//   V12 exportBlob remains available and compatible on MV3 / Tauri
//   V13 fallback import fails closed
//   V14 no build-channel inference from display / manifest names was introduced
//   V15 no excluded Product path is required (read-only evidence)
//   NC  negative controls prove the boundary checks detect a broken seam
//
// Run: node tools/validation/studio/validate-studio-host-runtime-local-file-adapters-c5-c.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { TextDecoder, TextEncoder } from 'node:util';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), '..', '..', '..');

const REL = {
  index: 'src-surfaces-base/studio/platform/index.js',
  mv3: 'src-surfaces-base/studio/platform/platform.mv3.js',
  tauri: 'src-surfaces-base/studio/platform/platform.tauri.js',
  panel: 'src-surfaces-base/studio/settings/build-identity.panel.js',
  guide: 'src-surfaces-base/studio/STUDIO_PLATFORM_ADAPTER_GUIDE.md',
  studioHtml: 'src-surfaces-base/studio/studio.html',
  packStudio: 'tools/product/studio/pack-studio.mjs',
  capabilities: 'apps/studio/desktop/src-tauri/capabilities/default.json',
  libRs: 'apps/studio/desktop/src-tauri/src/lib.rs',
  buildIdentityRs: 'apps/studio/desktop/src-tauri/src/build_identity.rs',
};

const RUNTIME_IDENTITY_SCHEMA = 'h2o.studio.platform.loaded-runtime-identity.v1';
const LOCAL_FILE_SCHEMA = 'h2o.studio.platform.local-file.v1';
const DESKTOP_BUILD_IDENTITY_SCHEMA = 'h2o.studio.desktop-build-identity.v1';
const DESKTOP_BUILD_IDENTITY_COMMAND = 'h2o_studio_desktop_build_identity';

/* The complete key set a loaded-runtime identity record may carry. */
const RUNTIME_IDENTITY_KEYS = [
  'schema', 'adapter', 'available', 'reason',
  'runtimeId', 'displayName', 'version', 'versionName',
  'desktopBuildIdentity', 'desktopBuildIdentityError',
];
/* Facts Host Integration must never derive from a name. */
const FORBIDDEN_DERIVED_KEYS = [
  'channel', 'buildChannel', 'variant', 'buildVariant', 'lane', 'laneId',
  'btp', 'btpId', 'role', 'sourceCommit', 'checkpoint', 'provenance',
];
const LOCAL_FILE_KEYS = ['schema', 'name', 'size', 'type', 'text'];

const PASS = [];
const FAIL = [];

function readRepo(rel) {
  return fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
}

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

function stripComments(src) {
  return String(src)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

/* Extract one `function <name>(` body from adapter source by brace balance. */
function sliceFunction(src, name) {
  const start = src.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `function ${name} not found`);
  const open = src.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === '{') depth += 1;
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`function ${name} is unterminated`);
}

/* ───────────────────────── sandbox helpers ───────────────────────── */

function makeElement(doc, tag) {
  const el = {
    tagName: String(tag).toUpperCase(),
    attributes: {},
    style: {},
    listeners: {},
    children: [],
    parentNode: null,
    files: null,
    hidden: false,
    dataset: {},
    setAttribute(k, v) { this.attributes[k] = String(v); },
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attributes, k) ? this.attributes[k] : null; },
    addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); },
    removeEventListener(type, fn) { this.listeners[type] = (this.listeners[type] || []).filter((f) => f !== fn); },
    dispatch(type) { for (const fn of (this.listeners[type] || []).slice()) fn({ type, target: this }); },
    appendChild(child) { child.parentNode = this; this.children.push(child); return child; },
    removeChild(child) {
      const idx = this.children.indexOf(child);
      if (idx < 0) throw new Error('removeChild: not a child');
      this.children.splice(idx, 1);
      child.parentNode = null;
      return child;
    },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    click() { doc.__clicks.push(this); if (typeof doc.__onClick === 'function') doc.__onClick(this); },
    remove() { if (this.parentNode) this.parentNode.removeChild(this); },
  };
  return el;
}

function makeDocument() {
  const doc = {
    __clicks: [],
    __onClick: null,
    readyState: 'complete',
    baseURI: 'https://studio.test/studio.html',
    addEventListener() {},
    removeEventListener() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
    getElementById() { return null; },
  };
  doc.createElement = (tag) => makeElement(doc, tag);
  doc.documentElement = makeElement(doc, 'html');
  doc.documentElement.style.setProperty = () => {};
  doc.documentElement.style.removeProperty = () => {};
  doc.body = makeElement(doc, 'body');
  return doc;
}

function makeStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(String(k)) ? map.get(String(k)) : null),
    setItem: (k, v) => { map.set(String(k), String(v)); },
    removeItem: (k) => { map.delete(String(k)); },
    key: (i) => Array.from(map.keys())[i] ?? null,
    get length() { return map.size; },
  };
}

function makeBaseContext(extra = {}) {
  const context = {
    console: { log() {}, warn() {}, error() {}, info() {}, debug() {} },
    setTimeout, clearTimeout, setInterval, clearInterval,
    TextEncoder, TextDecoder, Uint8Array, ArrayBuffer, URL,
    CustomEvent: class CustomEvent { constructor(type, init) { this.type = type; this.detail = init && init.detail; } },
    addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; },
    location: { href: 'https://studio.test/studio.html', search: '' },
    ...extra,
  };
  context.window = context;
  context.globalThis = context;
  context.self = context;
  return vm.createContext(context);
}

function run(sandbox, rel) {
  vm.runInContext(readRepo(rel), sandbox, { filename: rel });
}

function loadFallback() {
  const sandbox = makeBaseContext({ document: makeDocument() });
  run(sandbox, REL.index);
  return sandbox;
}

function makeChrome(manifest, id = 'abcdefghijklmnopabcdefghijklmnop') {
  const local = new Map();
  return {
    runtime: {
      id,
      getManifest: () => manifest,
      getURL: (p) => `chrome-extension://${id}/${p}`,
      sendMessage() {},
      onMessage: { addListener() {}, removeListener() {} },
      lastError: undefined,
    },
    storage: {
      local: {
        set: (obj, cb) => { for (const k of Object.keys(obj)) local.set(k, obj[k]); if (cb) cb(); },
        get: (keys, cb) => { cb({}); },
      },
      onChanged: { addListener() {}, removeListener() {} },
    },
  };
}

function loadMv3({ manifest, chrome, document = makeDocument(), extra = {} } = {}) {
  const sandbox = makeBaseContext({
    chrome: chrome || makeChrome(manifest || { name: 'Cockpit Pro', version: '2.5.37', version_name: 'opaque-loaded-fact' }),
    document,
    localStorage: makeStorage(),
    ...extra,
  });
  run(sandbox, REL.index);
  run(sandbox, REL.mv3);
  return sandbox;
}

function governedPayload() {
  return {
    schema: DESKTOP_BUILD_IDENTITY_SCHEMA,
    checkpoint: 'C5C-T01',
    sourceCommit: '62856d4b088aa4b0a756fc3dcc7e922de344d312',
    builtAt: '2026-09-19T00:00:00Z',
    appVersion: '0.1.0',
    architecture: 'arm64',
    governed: true,
    executableSha256: 'ab'.repeat(32),
    executableSha256Error: null,
    /* an unexpected extra field must survive transport untouched */
    extraFieldFromNative: 'kept-verbatim',
  };
}

/* Tauri sandbox: a scripted invoke that records every command, refuses the
 * SQLite bootstrap (so the adapter stays on its localStorage shim) and only
 * answers the commands each test explicitly scripts. */
function loadTauri({ script = {}, document = makeDocument(), withPanel = false } = {}) {
  const calls = [];
  const invoke = (cmd, args) => {
    calls.push({ cmd, args });
    if (cmd === 'plugin:sql|load') return Promise.reject(new Error('sqlite disabled in validator'));
    if (Object.prototype.hasOwnProperty.call(script, cmd)) {
      const handler = script[cmd];
      try {
        return Promise.resolve(typeof handler === 'function' ? handler(args) : handler);
      } catch (e) {
        return Promise.reject(e);
      }
    }
    return Promise.reject(new Error(`unexpected invoke: ${cmd}`));
  };
  const sandbox = makeBaseContext({
    __TAURI_INTERNALS__: { invoke },
    document,
    localStorage: makeStorage(),
  });
  run(sandbox, REL.index);
  run(sandbox, REL.tauri);
  if (withPanel) run(sandbox, REL.panel);
  return { sandbox, calls };
}

function keysOf(record) {
  return Object.keys(record).sort();
}

/* Sandbox objects carry the vm realm's prototypes; compare them by value. */
function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function assertRuntimeIdentityShape(record, adapter) {
  assert.ok(record && typeof record === 'object', 'record must be an object');
  assert.equal(record.schema, RUNTIME_IDENTITY_SCHEMA);
  assert.equal(record.adapter, adapter);
  assert.equal(typeof record.available, 'boolean');
  assert.deepEqual(keysOf(record), [...RUNTIME_IDENTITY_KEYS].sort(), 'record exposes exactly the frozen key set');
  for (const key of FORBIDDEN_DERIVED_KEYS) {
    assert.ok(!(key in record), `record must not carry derived fact "${key}"`);
  }
  assert.ok(Object.isFrozen(record), 'record is frozen');
}

/* Boundary checks reused by the negative controls. */
function assertNoDirectTauriTransport(panelSrc) {
  const code = stripComments(panelSrc);
  assert.doesNotMatch(code, /__TAURI_INTERNALS__|__TAURI__/, 'panel must not resolve Tauri globals');
  assert.doesNotMatch(code, /\binvoke\s*\(/, 'panel must not invoke Tauri commands');
  assert.doesNotMatch(code, new RegExp(DESKTOP_BUILD_IDENTITY_COMMAND), 'panel must not know the native command');
  assert.match(code, /platform\?\.runtime|platform\.runtime/, 'panel consumes platform.runtime');
  assert.match(code, /getLoadedRuntimeIdentity/, 'panel consumes getLoadedRuntimeIdentity');
}

function assertNoNameChannelInference(src, label, { identitySlice = false } = {}) {
  const code = stripComments(src);
  assert.doesNotMatch(code, /Cockpit Pro|Dev Controls|\bLean\b/i, `${label}: no manifest-name heuristics`);
  assert.doesNotMatch(code, /chrome-ext-prod|dev-controls|dev-lean/i, `${label}: no channel labels`);
  /* broadcast code legitimately names its `channel`; the build-channel fact
   * check therefore runs only over identity function slices. */
  if (identitySlice) {
    assert.doesNotMatch(code, /\b(?:build)?[Cc]hannel\b\s*[:=]/, `${label}: no channel fact is produced`);
  }
}

function assertPayloadPassThrough(record, payload) {
  assert.equal(record.desktopBuildIdentity, payload, 'the governed payload is the same object the native command returned');
  assert.deepEqual(record.desktopBuildIdentity, governedPayload(), 'no field was added, removed or rewritten');
  assert.equal(record.desktopBuildIdentityError, null);
}

function assertNoSavedChatsSemantics(fnSrc, label) {
  const code = stripComments(fnSrc);
  assert.doesNotMatch(code, /JSON\.parse/, `${label}: no JSON parsing`);
  assert.doesNotMatch(code, /fullBundle|h2o\.studio\.|legacy|archive|dryRun|dry-run|backup|importMode|migrat|schemaVersion/i, `${label}: no bundle / migration semantics`);
}

/* ═════════════════════════ V1 / V13 — fallback ═════════════════════════ */

console.log('C5-C — fallback contract');

await checkAsync('V1 fallback runtime identity fails closed with unavailable facts', async () => {
  const sandbox = loadFallback();
  const platform = sandbox.H2O.Studio.platform;
  assert.equal(typeof platform.runtime.getLoadedRuntimeIdentity, 'function');
  const record = await platform.runtime.getLoadedRuntimeIdentity();
  assertRuntimeIdentityShape(record, 'fallback');
  assert.equal(record.available, false);
  assert.equal(record.reason, 'runtime-identity-unavailable');
  for (const key of ['runtimeId', 'displayName', 'version', 'versionName', 'desktopBuildIdentity']) {
    assert.equal(record[key], null, `${key} is null, never synthesized`);
  }
});

await checkAsync('V13 fallback importFile fails closed (rejects, never a synthesized record)', async () => {
  const sandbox = loadFallback();
  const platform = sandbox.H2O.Studio.platform;
  assert.equal(platform.files.available, false);
  assert.equal(typeof platform.files.importFile, 'function');
  await assert.rejects(platform.files.importFile(), /files\.importFile unavailable/);
  assert.equal(typeof platform.files.exportBlob, 'undefined', 'fallback still advertises no exportBlob');
});

check('V1b index.js normalizes files like runtime so importFile is always callable', () => {
  const code = stripComments(readRepo(REL.index));
  assert.match(code, /current\.files = Object\.assign\(\{\}, fallback\.files, impl\.files \|\| \{\}\)/);
  assert.match(code, /getLoadedRuntimeIdentity: loadedRuntimeIdentityUnavailable/);
  assert.match(code, /importFile: unavailableAsync\('files\.importFile'\)/);
});

/* ═════════════════════════ V2 / V3 — MV3 identity ═════════════════════════ */

console.log('C5-C — MV3 loaded-runtime identity');

await checkAsync('V2 MV3 identity reads the real adapter and exposes only loaded runtime/manifest facts', async () => {
  const manifest = { name: 'H2O Cockpit Pro', version: '2.5.37', version_name: '2.5.37-lean (build 9)', manifest_version: 3, permissions: ['storage'] };
  const sandbox = loadMv3({ manifest });
  const platform = sandbox.H2O.Studio.platform;
  assert.equal(platform.env.adapter, 'mv3', 'mv3 adapter registered');
  const record = await platform.runtime.getLoadedRuntimeIdentity();
  assertRuntimeIdentityShape(record, 'mv3');
  assert.equal(record.available, true);
  assert.equal(record.reason, null);
  assert.equal(record.runtimeId, 'abcdefghijklmnopabcdefghijklmnop');
  assert.equal(record.displayName, 'H2O Cockpit Pro');
  assert.equal(record.version, '2.5.37');
  assert.equal(record.versionName, '2.5.37-lean (build 9)', 'version_name is passed through verbatim');
  assert.equal(record.desktopBuildIdentity, null, 'MV3 never carries a Desktop build identity');
  assert.equal(record.desktopBuildIdentityError, null);
  assert.ok(!('manifest_version' in record) && !('permissions' in record), 'other manifest fields do not leak');
});

await checkAsync('V2b MV3 identity reports missing manifest facts as null (no defaults)', async () => {
  const sandbox = loadMv3({ manifest: { name: 'X' } });
  const record = await sandbox.H2O.Studio.platform.runtime.getLoadedRuntimeIdentity();
  assert.equal(record.displayName, 'X');
  assert.equal(record.version, null);
  assert.equal(record.versionName, null);
  const broken = loadMv3({ chrome: Object.assign(makeChrome({}), { runtime: { id: 'idonly', getManifest: () => { throw new Error('boom'); } } }) });
  const record2 = await broken.H2O.Studio.platform.runtime.getLoadedRuntimeIdentity();
  assert.equal(record2.available, true);
  assert.equal(record2.runtimeId, 'idonly');
  assert.equal(record2.displayName, null);
});

await checkAsync('V3 MV3 derives no channel/variant/Lane/BTP/provenance from names', async () => {
  for (const name of ['Cockpit Pro', 'H2O Dev Controls', 'H2O Lean', 'L-STUDIO-HOST-INTEGRATION BTP-7 role:prod commit:deadbeef checkpoint:C1']) {
    const sandbox = loadMv3({ manifest: { name, version: '1.0.0', version_name: 'prod' } });
    const record = await sandbox.H2O.Studio.platform.runtime.getLoadedRuntimeIdentity();
    assertRuntimeIdentityShape(record, 'mv3');
    assert.equal(record.displayName, name, 'the name is only echoed, never interpreted');
    const serialized = JSON.stringify(record).toLowerCase();
    assert.ok(!/"channel"|"variant"|"lane"|"btp"|"role"|"sourcecommit"|"checkpoint"/.test(serialized), 'no derived keys in the record');
  }
  assertNoNameChannelInference(sliceFunction(readRepo(REL.mv3), 'runtimeGetLoadedRuntimeIdentity'), 'mv3 identity', { identitySlice: true });
  const code = stripComments(sliceFunction(readRepo(REL.mv3), 'runtimeGetLoadedRuntimeIdentity'));
  assert.doesNotMatch(code, /\.test\(|match\(|indexOf\(|includes\(/, 'no string matching over loaded names');
});

/* ═════════════════════════ V4 / V5 — Tauri identity ═════════════════════════ */

console.log('C5-C — Tauri loaded-runtime identity');

await checkAsync('V4 Tauri identity invokes h2o_studio_desktop_build_identity through the adapter', async () => {
  const payload = governedPayload();
  const { sandbox, calls } = loadTauri({
    script: {
      [DESKTOP_BUILD_IDENTITY_COMMAND]: payload,
      'plugin:app|identifier': 'org.h2o.studio.desktop',
      'plugin:app|name': 'H2O Studio',
      'plugin:app|version': '0.1.0',
    },
  });
  const platform = sandbox.H2O.Studio.platform;
  assert.equal(platform.env.adapter, 'tauri', 'tauri adapter registered');
  assert.equal(platform.env.isTauri, true);
  const before = calls.length;
  const record = await platform.runtime.getLoadedRuntimeIdentity();
  const during = calls.slice(before).map((c) => c.cmd);
  assert.ok(during.includes(DESKTOP_BUILD_IDENTITY_COMMAND), 'native build-identity command invoked');
  assert.equal(during.filter((c) => c === DESKTOP_BUILD_IDENTITY_COMMAND).length, 1, 'invoked exactly once per call');
  const allowed = new Set([DESKTOP_BUILD_IDENTITY_COMMAND, 'plugin:app|identifier', 'plugin:app|name', 'plugin:app|version']);
  for (const cmd of during) assert.ok(allowed.has(cmd), `only granted loaded-fact seams are used (${cmd})`);
  assertRuntimeIdentityShape(record, 'tauri');
  assert.equal(record.available, true);
  assert.equal(record.runtimeId, 'org.h2o.studio.desktop');
  assert.equal(record.displayName, 'H2O Studio');
  assert.equal(record.version, '0.1.0');
  assert.equal(record.versionName, null);
  assertPayloadPassThrough(record, payload);
});

await checkAsync('V4b adding runtime.getLoadedRuntimeIdentity keeps the Tauri resolveAsset fallback and D1 openUrl promotion', async () => {
  const opened = [];
  const { sandbox } = loadTauri({ script: { 'plugin:shell|open': (a) => { opened.push(a.path); return null; } } });
  const platform = sandbox.H2O.Studio.platform;
  assert.equal(typeof platform.runtime.resolveAsset, 'function');
  assert.equal(platform.runtime.resolveAsset('icons/x.svg'), 'https://studio.test/icons/x.svg', 'index.js document-relative fallback still serves Tauri');
  await platform.runtime.openUrl('https://example.test/');
  await platform.openUrl('https://example.test/alias');
  assert.deepEqual(opened, ['https://example.test/', 'https://example.test/alias'], 'runtime.openUrl and the D1 alias both reach plugin:shell|open');
  assert.equal(typeof platform.window.setAlwaysOnTop, 'function', 'Tauri window namespace still mirrored');
});

await checkAsync('V5 Tauri passes the governed payload through without semantic reinterpretation', async () => {
  const payload = governedPayload();
  /* an UNSTAMPED / ungoverned payload must arrive exactly as produced too */
  const unstamped = Object.assign(governedPayload(), { checkpoint: 'UNSTAMPED', governed: false, sourceCommit: '' });
  const { sandbox } = loadTauri({ script: { [DESKTOP_BUILD_IDENTITY_COMMAND]: () => unstamped } });
  const record = await sandbox.H2O.Studio.platform.runtime.getLoadedRuntimeIdentity();
  assert.equal(record.desktopBuildIdentity, unstamped);
  assert.equal(record.desktopBuildIdentity.checkpoint, 'UNSTAMPED', 'not stamped, not defaulted');
  assert.equal(record.desktopBuildIdentity.governed, false);
  assert.equal(record.available, true, 'the transported payload is a loaded fact even when app facts are unavailable');
  assert.equal(record.runtimeId, null, 'ungranted app facts are null, not guessed');
  const src = stripComments(sliceFunction(readRepo(REL.tauri), 'runtimeGetLoadedRuntimeIdentity'))
    + stripComments(sliceFunction(readRepo(REL.tauri), 'invokeDesktopBuildIdentity'));
  assert.doesNotMatch(src, /checkpoint|sourceCommit|builtAt|appVersion|architecture|governed|executableSha256/, 'adapter never reads or rewrites governed fields');
  assert.doesNotMatch(src, /UNSTAMPED|H2O_STUDIO_BUILD|env!/, 'adapter never regenerates build facts');
  assertNoNameChannelInference(src, 'tauri identity', { identitySlice: true });
  void payload;
});

await checkAsync('V5b Tauri identity fails closed when the native command is unavailable', async () => {
  const { sandbox } = loadTauri({ script: { [DESKTOP_BUILD_IDENTITY_COMMAND]: () => { throw new Error('command h2o_studio_desktop_build_identity not allowed'); } } });
  const record = await sandbox.H2O.Studio.platform.runtime.getLoadedRuntimeIdentity();
  assertRuntimeIdentityShape(record, 'tauri');
  assert.equal(record.available, false);
  assert.equal(record.reason, 'runtime-identity-unavailable');
  assert.equal(record.desktopBuildIdentity, null, 'no synthesized identity');
  assert.match(record.desktopBuildIdentityError, /not allowed/);
  const empty = loadTauri({ script: { [DESKTOP_BUILD_IDENTITY_COMMAND]: null } });
  const record2 = await empty.sandbox.H2O.Studio.platform.runtime.getLoadedRuntimeIdentity();
  assert.equal(record2.desktopBuildIdentity, null);
  assert.equal(record2.desktopBuildIdentityError, 'desktop-build-identity-empty');
});

/* ═════════════════════════ V6 — settings panel consumer ═════════════════════════ */

console.log('C5-C — build-identity.panel consumer');

await checkAsync('V6 build-identity.panel consumes Platform runtime identity rather than Tauri invoke', async () => {
  assertNoDirectTauriTransport(readRepo(REL.panel));
  const payload = governedPayload();
  const { sandbox, calls } = loadTauri({ script: { [DESKTOP_BUILD_IDENTITY_COMMAND]: payload }, withPanel: true });
  const api = sandbox.H2O.Studio.settingsBuildIdentity;
  assert.equal(typeof api.load, 'function');
  const identity = await api.load();
  assert.equal(identity.schema, DESKTOP_BUILD_IDENTITY_SCHEMA);
  assert.equal(identity.checkpoint, 'C5C-T01');
  assert.equal(identity.sourceCommit, '62856d4b088aa4b0a756fc3dcc7e922de344d312');
  assert.equal(identity.stamped, true, 'existing governed validation semantics preserved');
  assert.ok(Object.isFrozen(identity));
  assert.ok(calls.some((c) => c.cmd === DESKTOP_BUILD_IDENTITY_COMMAND), 'the native command ran through the adapter');
  /* the panel caches: a second load does not re-invoke */
  const n = calls.filter((c) => c.cmd === DESKTOP_BUILD_IDENTITY_COMMAND).length;
  await api.load();
  assert.equal(calls.filter((c) => c.cmd === DESKTOP_BUILD_IDENTITY_COMMAND).length, n, 'identity promise is cached by the panel');
});

await checkAsync('V6b panel keeps its display validation and fails closed on an unavailable payload', async () => {
  const bad = loadTauri({ script: { [DESKTOP_BUILD_IDENTITY_COMMAND]: () => { throw new Error('native-transport-failed'); } }, withPanel: true });
  await assert.rejects(bad.sandbox.H2O.Studio.settingsBuildIdentity.load(), /native-transport-failed/);
  const wrongSchema = loadTauri({ script: { [DESKTOP_BUILD_IDENTITY_COMMAND]: { schema: 'other' } }, withPanel: true });
  await assert.rejects(wrongSchema.sandbox.H2O.Studio.settingsBuildIdentity.load(), /desktop-build-identity-invalid/);
  /* not Desktop → null, never extension metadata */
  const mv3 = loadMv3();
  run(mv3, REL.panel);
  assert.equal(await mv3.H2O.Studio.settingsBuildIdentity.load(), null);
  assert.equal(mv3.H2O.Studio.settingsBuildIdentity.badgeHtml(), '');
  /* Desktop without the Platform capability → the documented runtime-unavailable code */
  const noRuntime = loadTauri({ withPanel: true });
  noRuntime.sandbox.H2O.Studio.platform.runtime = { resolveAsset: () => '' };
  await assert.rejects(noRuntime.sandbox.H2O.Studio.settingsBuildIdentity.load(), /desktop-build-identity-runtime-unavailable/);
});

/* ═════════════════════════ V7 / V8 — MV3 importFile ═════════════════════════ */

console.log('C5-C — MV3 importFile');

function fakeFile({ name, size, type, text, viaFileReader = false }) {
  const file = { name, size, type };
  if (!viaFileReader) file.text = async () => text;
  file.__text = text;
  return file;
}

await checkAsync('V7 MV3 importFile performs picker + text read and returns normalized name/size/type/text', async () => {
  const document = makeDocument();
  const text = '{"schema":"h2o.studio.fullBundle.v2","chats":[]}';
  const file = fakeFile({ name: 'bundle.json', size: 999, type: 'application/json', text });
  document.__onClick = (input) => {
    assert.equal(input.tagName, 'INPUT');
    assert.equal(input.type, 'file');
    assert.equal(input.multiple, false, 'single file only');
    assert.equal(input.accept, 'application/json,.json');
    assert.equal(input.parentNode, document.body, 'transient input is attached while the picker is open');
    assert.equal(input.style.display, 'none', 'hidden');
    input.files = [file];
    setTimeout(() => input.dispatch('change'), 0);
  };
  const sandbox = loadMv3({ document });
  const platform = sandbox.H2O.Studio.platform;
  assert.equal(platform.files.available, true);
  const record = await platform.files.importFile({ mimeTypes: ['application/json'], extensions: ['json'] });
  assert.deepEqual(keysOf(record), [...LOCAL_FILE_KEYS].sort(), 'record exposes exactly schema/name/size/type/text');
  assert.equal(record.schema, LOCAL_FILE_SCHEMA);
  assert.equal(record.name, 'bundle.json');
  assert.equal(record.size, 999, 'browser-reported size');
  assert.equal(record.type, 'application/json', 'browser-reported MIME');
  assert.equal(record.text, text, 'the caller receives already-read text, not a File');
  assert.ok(Object.isFrozen(record));
  assert.equal(document.body.children.length, 0, 'transient input cleaned up');
  assert.equal(document.__clicks.length, 1);
});

await checkAsync('V7b MV3 importFile normalizes unknown type/size and reads through FileReader when File.text is absent', async () => {
  const document = makeDocument();
  const text = 'héllo wörld';
  const file = fakeFile({ name: 'notes.txt', size: undefined, type: '', text, viaFileReader: true });
  document.__onClick = (input) => { input.files = [file]; setTimeout(() => input.dispatch('change'), 0); };
  class FileReader {
    readAsText(f) { setTimeout(() => { this.result = f.__text; this.onload(); }, 0); }
  }
  const sandbox = loadMv3({ document, extra: { FileReader } });
  const record = await sandbox.H2O.Studio.platform.files.importFile();
  assert.equal(record.name, 'notes.txt');
  assert.equal(record.type, '', 'unknown MIME stays the neutral empty string, never guessed');
  assert.equal(record.size, new TextEncoder().encode(text).length, 'size falls back to the UTF-8 byte length actually read');
  assert.equal(record.text, text);
});

await checkAsync('V8 MV3 cancel is non-error (cancel event and empty change both resolve null)', async () => {
  const cancelled = makeDocument();
  cancelled.__onClick = (input) => setTimeout(() => input.dispatch('cancel'), 0);
  const s1 = loadMv3({ document: cancelled });
  assert.equal(await s1.H2O.Studio.platform.files.importFile(), null);
  assert.equal(cancelled.body.children.length, 0, 'input removed after cancel');
  const emptied = makeDocument();
  emptied.__onClick = (input) => { input.files = []; setTimeout(() => input.dispatch('change'), 0); };
  const s2 = loadMv3({ document: emptied });
  assert.equal(await s2.H2O.Studio.platform.files.importFile(), null);
  /* a read failure IS an error — never masked as a cancel */
  const failing = makeDocument();
  failing.__onClick = (input) => { input.files = [{ name: 'x', size: 1, type: '', text: async () => { throw new Error('read-failed'); } }]; setTimeout(() => input.dispatch('change'), 0); };
  const s3 = loadMv3({ document: failing });
  await assert.rejects(s3.H2O.Studio.platform.files.importFile(), /read-failed/);
  assert.equal(failing.body.children.length, 0, 'input removed after failure');
});

/* ═════════════════════════ V9 / V10 — Tauri importFile ═════════════════════════ */

console.log('C5-C — Tauri importFile');

await checkAsync('V9 Tauri importFile performs dialog open + read_text_file and returns the same normalized shape', async () => {
  const text = '{"schema":"h2o.studio.fullBundle.v2"}\n';
  const { sandbox, calls } = loadTauri({
    script: {
      'plugin:dialog|open': (args) => {
        assert.equal(args.options.multiple, false);
        assert.equal(args.options.directory, false);
        assert.deepEqual(plain(args.options.filters), [{ name: 'Bundle', extensions: ['json'] }]);
        return '/Users/someone/Downloads/bundle.json';
      },
      'plugin:fs|read_text_file': (args) => {
        assert.equal(args.path, '/Users/someone/Downloads/bundle.json');
        assert.equal(args.options, undefined, 'no baseDir option: the dialog plugin scopes the picked file');
        return text;
      },
    },
  });
  const platform = sandbox.H2O.Studio.platform;
  assert.equal(platform.files.available, true);
  const before = calls.length;
  const record = await platform.files.importFile({ extensions: ['.json'], filterName: 'Bundle' });
  const during = calls.slice(before).map((c) => c.cmd);
  assert.deepEqual(during, ['plugin:dialog|open', 'plugin:fs|read_text_file'], 'exactly dialog open then text read');
  assert.deepEqual(keysOf(record), [...LOCAL_FILE_KEYS].sort());
  assert.equal(record.schema, LOCAL_FILE_SCHEMA);
  assert.equal(record.name, 'bundle.json', 'user-facing name only; the host path does not leak');
  assert.ok(!JSON.stringify(record).includes('/Users/someone'), 'no path in the record');
  assert.equal(record.size, new TextEncoder().encode(text).length);
  assert.equal(record.type, '', 'the OS dialog reports no MIME; none is guessed');
  assert.equal(record.text, text);
  assert.ok(Object.isFrozen(record));
});

await checkAsync('V9b Tauri importFile accepts the { path } picker shape and byte-array read responses', async () => {
  const text = 'ünïcode ✓';
  const bytes = Array.from(new TextEncoder().encode(text));
  const { sandbox } = loadTauri({
    script: {
      'plugin:dialog|open': { path: 'C:\\Users\\x\\Desktop\\notes.txt' },
      'plugin:fs|read_text_file': bytes,
    },
  });
  const record = await sandbox.H2O.Studio.platform.files.importFile();
  assert.equal(record.name, 'notes.txt');
  assert.equal(record.text, text);
  assert.equal(record.size, bytes.length);
  const bad = loadTauri({ script: { 'plugin:dialog|open': '/tmp/a.txt', 'plugin:fs|read_text_file': { not: 'text' } } });
  await assert.rejects(bad.sandbox.H2O.Studio.platform.files.importFile(), /unsupported read_text_file response/);
});

await checkAsync('V10 Tauri cancel is non-error (null from the dialog resolves null, no read)', async () => {
  const { sandbox, calls } = loadTauri({ script: { 'plugin:dialog|open': null } });
  const before = calls.length;
  assert.equal(await sandbox.H2O.Studio.platform.files.importFile(), null);
  const during = calls.slice(before).map((c) => c.cmd);
  assert.deepEqual(during, ['plugin:dialog|open'], 'no read after cancel');
  /* a rejected read IS an error, never a cancel */
  const denied = loadTauri({ script: { 'plugin:dialog|open': '/x/y.json', 'plugin:fs|read_text_file': () => { throw new Error('forbidden path'); } } });
  await assert.rejects(denied.sandbox.H2O.Studio.platform.files.importFile(), /forbidden path/);
});

/* ═════════════════════════ V11 — Saved Chats semantic fence ═════════════════════════ */

console.log('C5-C — owner fences');

check('V11 no JSON parsing or Saved Chats bundle/schema semantics exist in Host importFile', () => {
  const mv3 = readRepo(REL.mv3);
  const tauri = readRepo(REL.tauri);
  for (const name of ['filesImportFile', 'normalizeLocalFileRecord', 'readFileText', 'importAcceptList']) {
    assertNoSavedChatsSemantics(sliceFunction(mv3, name), `mv3 ${name}`);
  }
  for (const name of ['filesImportFile', 'normalizeLocalFileRecord', 'decodeTextRead', 'importDialogFilters', 'fileNameFromPath', 'pickedPathString']) {
    assertNoSavedChatsSemantics(sliceFunction(tauri, name), `tauri ${name}`);
  }
  assert.doesNotMatch(stripComments(readRepo(REL.index)), /JSON\.parse/, 'index.js parses nothing');
  /* the import seam never activates importJson as a semantic migration API */
  for (const [label, src] of [['mv3', mv3], ['tauri', tauri], ['index', readRepo(REL.index)]]) {
    assert.doesNotMatch(stripComments(src), /importJson\s*[:=]\s*function|function\s+filesImportJson/, `${label}: importJson not activated`);
  }
});

/* ═════════════════════════ V12 — exportBlob regression ═════════════════════════ */

await checkAsync('V12 exportBlob remains available and compatible on MV3 and Tauri', async () => {
  /* MV3: Blob + object URL + anchor */
  const document = makeDocument();
  const urls = [];
  const URL = { createObjectURL: (b) => { urls.push(b); return 'blob:studio/1'; }, revokeObjectURL: () => {} };
  const mv3 = loadMv3({ document, extra: { URL } });
  const blob = { size: 3, type: 'text/markdown', text: async () => 'abc' };
  const res = await mv3.H2O.Studio.platform.files.exportBlob({ suggestedName: 'x.md', blob });
  assert.deepEqual(plain(res), { ok: true, suggestedName: 'x.md' });
  assert.equal(urls[0], blob);
  assert.equal(document.__clicks.length, 1);
  assert.equal(document.__clicks[0].tagName, 'A');
  assert.equal(document.__clicks[0].download, 'x.md');
  /* Tauri: cancel semantics and text save */
  const cancelled = loadTauri({ script: { 'plugin:dialog|save': null } });
  assert.deepEqual(plain(await cancelled.sandbox.H2O.Studio.platform.files.exportBlob({ suggestedName: 'x.md', blob })), { ok: false, reason: 'cancelled' });
  const writes = [];
  const saved = loadTauri({ script: { 'plugin:dialog|save': '/tmp/x.md', 'plugin:fs|write_text_file': (a) => { writes.push(a); return null; } } });
  const res2 = await saved.sandbox.H2O.Studio.platform.files.exportBlob({ suggestedName: 'x.md', blob });
  assert.deepEqual(plain(res2), { ok: true, path: '/tmp/x.md', suggestedName: 'x.md' });
  assert.deepEqual(plain(writes), [{ path: '/tmp/x.md', contents: 'abc' }]);
  /* Tauri: binary-safe path + blob-anchor fallback when the fs command is missing */
  const binWrites = [];
  const bin = loadTauri({ script: { 'plugin:dialog|save': '/tmp/x.docx', 'plugin:fs|write_file': (a) => { binWrites.push(a); return null; } } });
  const docx = { size: 2, type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', arrayBuffer: async () => new Uint8Array([1, 2]).buffer };
  assert.deepEqual(plain(await bin.sandbox.H2O.Studio.platform.files.exportBlob({ suggestedName: 'x.docx', blob: docx })), { ok: true, path: '/tmp/x.docx', suggestedName: 'x.docx' });
  assert.deepEqual(plain(binWrites), [{ path: '/tmp/x.docx', contents: [1, 2] }]);
  const fbDoc = makeDocument();
  const fb = loadTauri({ script: { 'plugin:dialog|save': '/tmp/x.md' }, document: fbDoc });
  fb.sandbox.URL = URL;
  const res3 = await fb.sandbox.H2O.Studio.platform.files.exportBlob({ suggestedName: 'x.md', blob });
  assert.deepEqual(plain(res3), { ok: true, suggestedName: 'x.md', fallback: 'blob-anchor' });
  /* the surface still carries the same export entry point on both adapters */
  assert.equal(typeof mv3.H2O.Studio.platform.files.exportBlob, 'function');
  assert.equal(typeof saved.sandbox.H2O.Studio.platform.files.exportBlob, 'function');
});

/* ═════════════════════════ V14 — no channel inference introduced ═════════════════════════ */

check('V14 no build-channel inference from display/manifest names was introduced in Host authority', () => {
  for (const rel of [REL.index, REL.mv3, REL.tauri, REL.panel]) {
    assertNoNameChannelInference(readRepo(rel), rel);
  }
  const guide = readRepo(REL.guide);
  assert.match(guide, /getLoadedRuntimeIdentity/);
  assert.match(guide, /importFile/);
  assert.doesNotMatch(guide, /Promise<File\|null>/, 'placeholder File-returning import contract removed');
  for (const term of ['name', 'size', 'type', 'text']) {
    assert.match(guide, new RegExp(`\\b${term}\\b`), `guide documents ${term}`);
  }
  assert.match(guide, /Build & Delivery/);
  assert.match(guide, /Saved Chats/);
});

/* ═════════════════════════ V15 — no excluded path required ═════════════════════════ */

check('V15 no excluded Product path is required: existing admission, capabilities and native command suffice', () => {
  const html = readRepo(REL.studioHtml);
  for (const rel of ['platform/index.js', 'platform/platform.mv3.js', 'platform/platform.tauri.js', 'settings/build-identity.panel.js']) {
    assert.ok(html.includes(`./${rel}`), `studio.html already loads ${rel}`);
    assert.ok(readRepo(REL.packStudio).includes(`"${rel}"`), `pack-studio.mjs already packs ${rel}`);
  }
  const caps = JSON.parse(readRepo(REL.capabilities));
  const ids = caps.permissions.map((p) => (typeof p === 'string' ? p : p.identifier));
  for (const need of ['core:default', 'dialog:allow-open', 'fs:allow-read-text-file']) {
    assert.ok(ids.includes(need), `capability ${need} already granted`);
  }
  const libRs = readRepo(REL.libRs);
  assert.match(libRs, /build_identity::h2o_studio_desktop_build_identity/, 'native command already registered');
  assert.match(libRs, /tauri_plugin_dialog::init\(\)/);
  assert.match(libRs, /tauri_plugin_fs::init\(\)/);
  assert.match(readRepo(REL.buildIdentityRs), new RegExp(`fn ${DESKTOP_BUILD_IDENTITY_COMMAND}\\(`));
  /* every Tauri seam the adapter uses is inside the granted set */
  const tauriSrc = stripComments(readRepo(REL.tauri));
  const used = new Set();
  for (const m of tauriSrc.matchAll(/invoke\((?:command|'([^']+)')/g)) if (m[1]) used.add(m[1]);
  for (const cmd of ['plugin:dialog|open', 'plugin:fs|read_text_file']) assert.ok(used.has(cmd), `${cmd} used by the adapter`);
  const identitySrc = stripComments(sliceFunction(readRepo(REL.tauri), 'runtimeGetLoadedRuntimeIdentity'));
  for (const cmd of ['plugin:app|identifier', 'plugin:app|name', 'plugin:app|version']) assert.ok(identitySrc.includes(`'${cmd}'`), `${cmd} (core:default) used by identity`);
  assert.doesNotMatch(stripComments(sliceFunction(readRepo(REL.tauri), 'filesImportFile')), /read_file'|read_dir|write_|mkdir|BaseDirectory|baseDir/, 'import uses no other fs command');
});

/* ═════════════════════════ NC — negative controls ═════════════════════════ */

console.log('C5-C — negative controls (anti-degeneracy)');

check('NC1 the panel-transport check detects a panel that resolves Tauri invoke directly', () => {
  const tampered = readRepo(REL.panel).replace(
    'function resolveLoadedRuntimeIdentity() {',
    "function resolveLoadedRuntimeIdentity() {\n    const internals = global.__TAURI_INTERNALS__; if (internals) return () => internals.invoke('h2o_studio_desktop_build_identity');",
  );
  assert.notEqual(tampered, readRepo(REL.panel), 'control mutation applied');
  assert.throws(() => assertNoDirectTauriTransport(tampered), /must not (resolve Tauri globals|invoke Tauri commands|know the native command)/);
});

check('NC2 the name-inference check detects a reintroduced manifest-name channel heuristic', () => {
  const tampered = readRepo(REL.mv3).replace(
    'displayName: loadedFact(manifest.name),',
    "displayName: loadedFact(manifest.name),\n        channel: /Cockpit Pro/i.test(String(manifest.name)) ? 'production (chrome-ext-prod)' : 'unknown',",
  );
  assert.notEqual(tampered, readRepo(REL.mv3), 'control mutation applied');
  assert.throws(() => assertNoNameChannelInference(tampered, 'control'), /no manifest-name heuristics|no channel labels|no channel fact/);
  const sliceOnly = sliceFunction(tampered, 'runtimeGetLoadedRuntimeIdentity').replace(/Cockpit Pro/g, 'X').replace(/chrome-ext-prod/g, 'y');
  assert.throws(() => assertNoNameChannelInference(sliceOnly, 'control-slice', { identitySlice: true }), /no channel fact/);
});

await checkAsync('NC3 the pass-through check detects a Tauri adapter that reinterprets the governed payload', async () => {
  const payload = governedPayload();
  const { sandbox } = loadTauri({ script: { [DESKTOP_BUILD_IDENTITY_COMMAND]: payload } });
  const record = await sandbox.H2O.Studio.platform.runtime.getLoadedRuntimeIdentity();
  assertPayloadPassThrough(record, payload);
  const reinterpreted = Object.assign({}, record, { desktopBuildIdentity: Object.assign({}, payload, { checkpoint: 'C5C-T01-normalized' }) });
  assert.throws(() => assertPayloadPassThrough(reinterpreted, payload), /same object|no field/);
  const shapeBroken = Object.assign({}, record, { channel: 'production' });
  assert.throws(() => assertRuntimeIdentityShape(shapeBroken, 'tauri'), /exactly the frozen key set|derived fact/);
});

check('NC4 the Saved Chats fence detects JSON parsing inside a Host importFile', () => {
  const tampered = sliceFunction(readRepo(REL.tauri), 'filesImportFile').replace(
    'return normalizeLocalFileRecord(',
    'var parsed = JSON.parse(read.text); if (parsed && parsed.schema === "h2o.studio.fullBundle.v2") { /* migrate */ }\n        return normalizeLocalFileRecord(',
  );
  assert.throws(() => assertNoSavedChatsSemantics(tampered, 'control'), /no JSON parsing|no bundle/);
});

/* ═════════════════════════ summary ═════════════════════════ */

console.log('');
console.log(`C5-C host runtime identity + local-file adapters: ${PASS.length} passed, ${FAIL.length} failed`);
if (FAIL.length) {
  for (const f of FAIL) console.log(`  - ${f.label}: ${f.message}`);
  process.exit(1);
}
