#!/usr/bin/env node
// Validator for C5.1-C5.3 saved-chat archive diagnostics.
//
// This check keeps the diagnostics lane read-only: package inventory and
// manifest/snapshot/hash/asset validation under AppLocalData archive/packages
// only, plus optional read-only live CAS presence comparison.

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), '..', '..', '..');

const MODULE_REL = 'src-surfaces-base/studio/ingestion/saved-chat-archive-diagnostics.tauri.js';
const CODEC_REL = 'src-surfaces-base/studio/ingestion/saved-chat-package-codec.tauri.js';
const STUDIO_HTML_REL = 'src-surfaces-base/studio/studio.html';
const PACK_STUDIO_REL = 'tools/product/studio/pack-studio.mjs';
const CAPABILITY_REL = 'apps/studio/desktop/src-tauri/capabilities/archive-cas.json';
const V3_FIXTURE_REL = 'tools/validation/fixtures/saved-chat-archive/v3/t06-canonical-assets.h2ochat';

const APP_LOCAL_DATA = 15;
const PACKAGE_ROOT = 'archive/packages';
const MODULE_NAME = 'saved-chat-archive-diagnostics.tauri.js';

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

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      if (typeof value[key] !== 'undefined') out[key] = canonicalize(value[key]);
    }
    return out;
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function sha256Prefixed(value) {
  return `sha256-${crypto.createHash('sha256').update(Buffer.from(value)).digest('hex')}`;
}

function encode(text) {
  return new TextEncoder().encode(text);
}

check('committed v3 fixture is renderer-free, canonical, and hash-consistent', () => {
  const root = path.join(REPO_ROOT, V3_FIXTURE_REL);
  const manifestBytes = fs.readFileSync(path.join(root, 'manifest.json'));
  const snapshotBytes = fs.readFileSync(path.join(root, 'snapshot.json'));
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  const snapshot = JSON.parse(snapshotBytes.toString('utf8'));
  assert.equal(manifest.schemaVersion, 3);
  assert.equal(manifest.payloadVersion, 3);
  assert.equal(manifest.files.snapshot.encoding, 'identity');
  assert.equal(manifest.files.snapshot.sha256, sha256Prefixed(snapshotBytes));
  assert.equal(manifest.files.snapshot.byteLength, snapshotBytes.length);
  assert.equal(fs.existsSync(path.join(root, 'chat.md')), false);
  assert.equal(fs.existsSync(path.join(root, 'chat.html')), false);
  for (const message of snapshot.messages) {
    assert.ok(Array.isArray(message.content));
    assert.equal(Object.hasOwn(message, 'contentText'), false);
    assert.equal(Object.hasOwn(message, 'contentHtml'), false);
  }
  const assetShas = manifest.assets.map((asset) => {
    const bytes = fs.readFileSync(path.join(root, asset.path));
    assert.equal(asset.byteLength, bytes.length);
    assert.equal(asset.sha256, sha256Prefixed(bytes));
    return asset.sha256;
  }).sort();
  const expected = sha256Prefixed(canonicalJson({ payloadVersion: 3, snapshot: manifest.files.snapshot.sha256, assets: assetShas }));
  assert.equal(manifest.contentHash, expected);
});

const ASSET_BYTES = Buffer.from('archive-diagnostic-asset');
const ASSET_SHA = sha256Prefixed(ASSET_BYTES);
const ASSET_PATH = `assets/${ASSET_SHA}.png`;
const ASSET_BYTES_2 = Buffer.from('archive-diagnostic-asset-two');
const ASSET_SHA_2 = sha256Prefixed(ASSET_BYTES_2);

function makePackage({ chatId, snapshotId, schemaVersion, assetSha = ASSET_SHA, dataImageResidue = false }) {
  const assetPath = `assets/${assetSha}.png`;
  const htmlRef = dataImageResidue ? 'data:image/png;base64,AAAA' : assetPath;
  const snapshot = {
    schema: 'h2o.savedChatSnapshot',
    schemaVersion,
    chatId,
    snapshotId,
    title: schemaVersion === 2 ? 'Archive diagnostics v2' : 'Archive diagnostics v1',
    capturedAt: '2026-06-24T00:00:00.000Z',
    messages: schemaVersion === 2
      ? [{ index: 0, role: 'assistant', contentText: 'image', contentHtml: `<p><img src="${htmlRef}"></p>`, assetRefs: [assetSha] }]
      : [{ index: 0, role: 'assistant', contentText: 'plain' }],
  };
  const snapshotText = canonicalJson(snapshot);
  const snapshotSha = sha256Prefixed(snapshotText);
  const assets = schemaVersion === 2 ? [{ sha256: assetSha, path: assetPath, ext: 'png', mimeType: 'image/png', byteLength: ASSET_BYTES.length, source: 'chatgpt-capture' }] : [];
  const contentHash = schemaVersion === 2
    ? sha256Prefixed(canonicalJson({ snapshot: snapshotSha, assets: assets.map((asset) => asset.sha256).sort() }))
    : snapshotSha;
  const htmlText = schemaVersion === 2 ? `<!doctype html><img src="${htmlRef}">` : '<!doctype html>';
  const manifest = {
    schema: 'h2o.savedChatPackage',
    schemaVersion,
    chatId,
    snapshotId,
    contentHash,
    files: {
      snapshot: { path: 'snapshot.json', sha256: snapshotSha, byteLength: encode(snapshotText).byteLength },
      markdown: { path: 'chat.md', sha256: sha256Prefixed(`# ${chatId}\n`), byteLength: encode(`# ${chatId}\n`).byteLength },
      html: { path: 'chat.html', sha256: sha256Prefixed(htmlText), byteLength: encode(htmlText).byteLength },
    },
    assets,
  };
  if (schemaVersion === 2) manifest.payloadVersion = 2;
  return {
    manifestText: canonicalJson(manifest),
    snapshotText,
    htmlText,
    manifest,
    snapshot,
  };
}

function makeV3Package({
  chatId = 'chat_diag_v3',
  snapshotId = 'snap_diag_v3',
  encoding = 'identity',
  payloadVersion = 3,
  assets = [],
  storedTransform = null,
  descriptorPatch = null,
} = {}) {
  const descriptors = assets.map(({ bytes, ext = 'png', mimeType = 'image/png' }) => {
    const body = Buffer.from(bytes);
    const assetSha = sha256Prefixed(body);
    return {
      body,
      descriptor: {
        sha256: assetSha,
        path: `assets/${assetSha}.${ext}`,
        ext,
        mimeType,
        byteLength: body.length,
        source: 'chatgpt-capture',
      },
    };
  });
  const assetRefs = descriptors.map((item) => item.descriptor.sha256);
  const html = descriptors.length
    ? `<p>${descriptors.map((item) => `<img src="${item.descriptor.path}">`).join('')}</p>`
    : '<p>v3 identity</p>';
  const snapshot = {
    schema: 'h2o.savedChatSnapshot',
    schemaVersion: 3,
    chatId,
    snapshotId,
    title: 'Archive diagnostics v3',
    capturedAt: '2026-08-24T00:00:00.000Z',
    messages: [{
      id: 'm0',
      turnIndex: 0,
      role: 'assistant',
      content: [{ type: 'text', text: 'v3 identity' }, { type: 'html', html, sanitized: true }],
      assetRefs,
    }],
  };
  const snapshotText = canonicalJson(snapshot);
  const logicalBytes = encode(snapshotText);
  const logicalSha = sha256Prefixed(logicalBytes);
  /* M03: gzip fixtures carry REAL gzip bytes so the governed decoder is
   * actually exercised. storedTransform builds corrupt/truncated variants. */
  let storedBytes = encoding === 'identity' ? logicalBytes : new Uint8Array(zlib.gzipSync(Buffer.from(logicalBytes)));
  if (typeof storedTransform === 'function') storedBytes = storedTransform(storedBytes);
  const descriptor = {
    path: 'snapshot.json',
    sha256: sha256Prefixed(storedBytes),
    byteLength: storedBytes.byteLength,
    encoding,
  };
  if (encoding !== 'identity') {
    descriptor.contentSha256 = logicalSha;
    descriptor.contentByteLength = logicalBytes.byteLength;
  }
  if (descriptorPatch) Object.assign(descriptor, typeof descriptorPatch === 'function' ? descriptorPatch(descriptor) : descriptorPatch);
  const manifestAssets = descriptors.map((item) => item.descriptor);
  const contentHash = sha256Prefixed(canonicalJson({
    payloadVersion: 3,
    snapshot: descriptor.contentSha256 ?? descriptor.sha256,
    assets: manifestAssets.map((asset) => asset.sha256).sort(),
  }));
  return {
    manifest: {
      schema: 'h2o.savedChatPackage',
      schemaVersion: 3,
      payloadVersion,
      chatId,
      snapshotId,
      contentHash,
      files: { snapshot: descriptor },
      assets: manifestAssets,
    },
    snapshot,
    snapshotText,
    storedBytes,
    descriptors,
  };
}

// C5.4A: read-only store adapter mock for DB reconciliation. Default is
// "consistent" for the standard fixtures (chat+snapshot exist, package is the
// latest snapshot, store asset registry matches the manifest) so existing tests
// stay green; config knobs inject the drift cases.
const SNAP_BY_CHAT = {
  chat_diag_v1: 'snap_diag_v1',
  chat_diag_v2: 'snap_diag_v2',
  chat_diag_bad: 'snap_diag_bad',
  chat_diag_bad_asset: 'snap_diag_bad_asset',
};
const ASSETS_BY_SNAP = {
  snap_diag_v2: [ASSET_SHA],
  snap_diag_bad_asset: [ASSET_SHA],
};

function buildDiagStore(config = {}) {
  const missingChats = new Set(config.missingChats || []);
  const missingSnapshots = new Set(config.missingSnapshots || []);
  const staleLatest = config.staleLatest || {}; // chatId -> fake latest snapshotId
  const assetOverride = config.assetOverride || {}; // snapshotId -> [sha...]
  const omit = new Set(config.omitMethods || []); // e.g. 'assets.listBySnapshot'
  const throwOn = new Set(config.throwOn || []); // method names that should throw

  const store = { chats: {}, snapshots: {}, assets: {} };
  if (!omit.has('chats.get')) {
    store.chats.get = async (id) => {
      if (throwOn.has('chats.get')) throw new Error('boom chats.get');
      return missingChats.has(id) ? null : { chatId: id, title: 't' };
    };
  }
  if (!omit.has('snapshots.get')) {
    store.snapshots.get = async (id) => {
      if (throwOn.has('snapshots.get')) throw new Error('boom snapshots.get');
      return missingSnapshots.has(id) ? null : { snapshot: { snapshotId: id } };
    };
  }
  if (!omit.has('snapshots.listByChat')) {
    store.snapshots.listByChat = async (chatId) => {
      if (throwOn.has('snapshots.listByChat')) throw new Error('boom listByChat');
      const latest = Object.prototype.hasOwnProperty.call(staleLatest, chatId) ? staleLatest[chatId] : SNAP_BY_CHAT[chatId];
      return latest ? [{ snapshotId: latest }] : [];
    };
  }
  if (!omit.has('assets.listBySnapshot')) {
    store.assets.listBySnapshot = async (snapshotId) => {
      if (throwOn.has('assets.listBySnapshot')) throw new Error('boom listBySnapshot');
      const shas = Object.prototype.hasOwnProperty.call(assetOverride, snapshotId) ? assetOverride[snapshotId] : (ASSETS_BY_SNAP[snapshotId] || []);
      return shas.map((sha) => ({ sha256: sha, turnIdx: 0, relation: 'inline' }));
    };
  }
  return store;
}

function createFixtureFs({ missingRoot = false, liveCasMissing = false, storeOptions = {}, extraEntries = [], readDirThrows = false, durableTemp = { complete: true, entries: [] }, durableTempThrows = false, trustedEnvelope = null } = {}) {
  const dirs = new Set();
  const files = new Map();
  const readCalls = [];
  const mutationCalls = [];
  const probeCalls = [];
  /* Per-path lstat metadata overrides for governed-reader negative cases. */
  const metaOverrides = new Map();
  const v1 = makePackage({ chatId: 'chat_diag_v1', snapshotId: 'snap_diag_v1', schemaVersion: 1 });
  const v2 = makePackage({ chatId: 'chat_diag_v2', snapshotId: 'snap_diag_v2', schemaVersion: 2 });
  const bad = makePackage({ chatId: 'chat_diag_bad', snapshotId: 'snap_diag_bad', schemaVersion: 1 });
  const badAsset = makePackage({ chatId: 'chat_diag_bad_asset', snapshotId: 'snap_diag_bad_asset', schemaVersion: 2, dataImageResidue: true });

  function addDir(p) { dirs.add(p); }
  function addFile(p, value) { files.set(p, typeof value === 'string' ? encode(value) : new Uint8Array(value)); }
  function addPackage(chatId, pkg, { omitHtml = false, omitAsset = false, corruptAsset = false } = {}) {
    const dir = `${PACKAGE_ROOT}/${chatId}.h2ochat`;
    addDir(dir);
    addFile(`${dir}/manifest.json`, pkg.manifestText);
    addFile(`${dir}/snapshot.json`, pkg.snapshotText);
    addFile(`${dir}/chat.md`, `# ${chatId}\n`);
    if (!omitHtml) addFile(`${dir}/chat.html`, pkg.htmlText);
    if (pkg.manifest.assets.length) {
      addDir(`${dir}/assets`);
      if (!omitAsset) {
        const asset = pkg.manifest.assets[0];
        addFile(`${dir}/${asset.path}`, corruptAsset ? Buffer.from('wrong-asset-bytes') : ASSET_BYTES);
      }
    }
    return dir;
  }

  if (!missingRoot) {
    addDir(PACKAGE_ROOT);
    addPackage('chat_diag_v1', v1);
    addPackage('chat_diag_v2', v2);
    addPackage('chat_diag_bad', bad, { omitHtml: true });
    addPackage('chat_diag_bad_asset', badAsset, { corruptAsset: true });
    addDir(`${PACKAGE_ROOT}/not_a_package`);
    addFile(`${PACKAGE_ROOT}/loose.txt`, 'not a package');
  }

  const entries = [
    { name: 'chat_diag_v1.h2ochat', isDirectory: true },
    { name: 'chat_diag_v2.h2ochat', isDirectory: true },
    { name: 'chat_diag_bad.h2ochat', isDirectory: true },
    { name: 'chat_diag_bad_asset.h2ochat', isDirectory: true },
    { name: 'not_a_package', isDirectory: true },
    { name: 'loose.txt', isFile: true },
    /* M06 T1.2: reserved infrastructure identities. They live at the archive
       ROOT, not under packages, and read-dir is scoped to packages only -- so
       these entries are a deliberately hostile placement, proving discovery
       excludes them even if they somehow appear here. */
    { name: '.h2o-archive.lock', isFile: true },
    { name: '.h2o-reclaim', isDirectory: true },
    ...extraEntries,
  ];

  async function invoke(cmd, args) {
    /* M06 T1.3 trusted read-only probe: no path, no baseDir, so it is answered
       before the fs-shaped assertions below. */
    if (cmd === 'h2o_archive_durable_temp_residue') {
      probeCalls.push({ cmd, args });
      if (durableTempThrows) throw new Error('simulated residue probe failure');
      return {
        complete: durableTemp.complete,
        root: 'archive/assets',
        kind: 'durable-temp',
        count: (durableTemp.entries || []).length,
        entries: durableTemp.entries || [],
        blockers: durableTemp.blockers || [],
      };
    }
    /* M10 P3b: `diagnoseSavedChatArchiveV1` is now sourced from trusted Rust, so
       the harness answers the trusted command. By default every fixture package
       is reported VERIFIED; a test that needs a different trusted verdict
       supplies its own `trustedEnvelope`. The legacy list/validate entry points
       tested elsewhere in this suite are untouched by this branch. */
    if (cmd === 'h2o_saved_chat_archive_integrity') {
      if (trustedEnvelope) return trustedEnvelope;
      const occupants = [...dirs]
        .filter((dir) => dir.startsWith(`${PACKAGE_ROOT}/`) && dir.endsWith('.h2ochat'))
        .sort()
        .map((dir) => {
          const name = dir.slice(PACKAGE_ROOT.length + 1);
          /* Read the fixture's OWN manifest identity so DB reconciliation has a
             truthful identity to reconcile; the trusted verdict itself is still
             supplied by this harness, not derived from bytes. */
          let manifest = {};
          try { manifest = JSON.parse(new TextDecoder().decode(files.get(`${dir}/manifest.json`))); } catch (_) { manifest = {}; }
          return {
            path: dir, name, class: 'verified-generation',
            chatId: String(manifest.chatId || name.replace(/\.h2ochat$/, '')),
            snapshotId: String(manifest.snapshotId || 'snap'),
            contentHash: String(manifest.contentHash || 'a'.repeat(64)).replace(/^sha256-/, ''),
            constructionFamily: manifest.payloadVersion === 2 ? 'v2' : 'v1',
            snapshotEncoding: 'identity', savedAt: '2026-01-01T00:00:00.000Z',
            orderable: true,
            assetShas: (manifest.assets || []).map((a) => a && a.sha256).filter(Boolean),
            blockers: [],
          };
        });
      return {
        schema: 'h2o.savedChatArchiveIntegrity', schemaVersion: 1,
        complete: true, blockers: [],
        observed: { byConstructionFamily: { v1: 0, v2: occupants.length, v3: 0 } },
        liveGenerationFamily: 'v3', occupants,
      };
    }
    const p = args && args.path;
    const options = args && args.options ? args.options : {};
    if (cmd === 'plugin:fs|write_file' || cmd === 'plugin:fs|write_text_file' || cmd === 'plugin:fs|mkdir' || cmd === 'plugin:fs|remove' || cmd === 'plugin:fs|rename') {
      mutationCalls.push({ cmd, path: p, baseDir: options.baseDir });
      throw new Error(`mutation command forbidden in diagnostics validator: ${cmd}`);
    }
    assert.equal(options.baseDir, APP_LOCAL_DATA, `${cmd} must use AppLocalData baseDir 15`);
    assert.ok(!String(p || '').includes('H2O Studio Sync'), `${cmd} must not touch Sync folder paths`);
    readCalls.push({ cmd, path: p, baseDir: options.baseDir });
    if (cmd === 'plugin:fs|exists') return dirs.has(p) || files.has(p);
    if (cmd === 'plugin:fs|read_dir') {
      if (readDirThrows) throw new Error('simulated read_dir failure');
      if (!dirs.has(p)) throw new Error(`not found: ${p}`);
      if (p.endsWith('/assets')) {
        const prefix = `${p}/`;
        return [...files.keys()]
          .filter((key) => key.startsWith(prefix))
          .map((key) => key.slice(prefix.length))
          .filter((name) => name && !name.includes('/'))
          .map((name) => ({ name, isFile: true }));
      }
      return entries;
    }
    if (cmd === 'plugin:fs|lstat') {
      /* Derived from the same fixture filesystem state as read_file. */
      let meta;
      if (files.has(p)) meta = { isFile: true, isDirectory: false, isSymlink: false, size: files.get(p).byteLength };
      else if (dirs.has(p)) meta = { isFile: false, isDirectory: true, isSymlink: false, size: 0 };
      else throw new Error(`not found: ${p}`);
      return Object.assign(meta, metaOverrides.get(p) || {});
    }
    if (cmd === 'plugin:fs|read_file') {
      if (!files.has(p)) throw new Error(`not found: ${p}`);
      return files.get(p);
    }
    throw new Error(`unexpected command: ${cmd}`);
  }

  return {
    invoke,
    readCalls,
    mutationCalls,
    probeCalls,
    metaOverrides,
    setMeta(path, patch) { metaOverrides.set(path, patch); },
    dirs,
    files,
    entries,
    addDir,
    addFile,
    paths: {
      v1: `${PACKAGE_ROOT}/chat_diag_v1.h2ochat`,
      v2: `${PACKAGE_ROOT}/chat_diag_v2.h2ochat`,
      bad: `${PACKAGE_ROOT}/chat_diag_bad.h2ochat`,
      badAsset: `${PACKAGE_ROOT}/chat_diag_bad_asset.h2ochat`,
    },
    assetCas: {
      exists: async (sha256) => !liveCasMissing && sha256 === ASSET_SHA,
      describe: async (sha256) => ({ sha256, exists: !liveCasMissing && sha256 === ASSET_SHA, path: `archive/assets/${sha256.slice(7, 9)}/${sha256}`, byteLength: ASSET_BYTES.length }),
    },
    store: buildDiagStore(storeOptions),
  };
}

function installV3Package(fixture, pkg, { manifest = true, snapshot = true } = {}) {
  const dir = `${PACKAGE_ROOT}/${pkg.manifest.chatId}.h2ochat`;
  fixture.addDir(dir);
  if (manifest) fixture.addFile(`${dir}/manifest.json`, canonicalJson(pkg.manifest));
  if (snapshot) fixture.addFile(`${dir}/snapshot.json`, pkg.storedBytes);
  for (const item of pkg.descriptors) {
    fixture.addDir(`${dir}/assets`);
    fixture.addFile(`${dir}/${item.descriptor.path}`, item.body);
  }
  if (!fixture.entries.some((entry) => entry.name === `${pkg.manifest.chatId}.h2ochat`)) {
    fixture.entries.push({ name: `${pkg.manifest.chatId}.h2ochat`, isDirectory: true });
  }
  return dir;
}

function loadModule(fixture) {
  const context = {
    console,
    TextEncoder,
    TextDecoder,
    Uint8Array,
    ArrayBuffer,
    crypto: globalThis.crypto || crypto.webcrypto,
    setTimeout,
    __TAURI_INTERNALS__: { invoke: fixture.invoke },
    H2O: { Studio: { ingestion: { assetCas: fixture.assetCas }, store: fixture.store } },
    /* Web streams the single governed codec authority requires. */
    ReadableStream,
    CompressionStream,
    DecompressionStream,
  };
  context.globalThis = context;
  context.window = context;
  const sandbox = vm.createContext(context);
  /* M03 T04: load the REAL governed saved-chat package codec, never a mock, so
   * diagnostics is proven against the one shared gzip/verification authority. */
  vm.runInContext(readRepo(CODEC_REL), sandbox, { filename: CODEC_REL });
  /* M10 P3b: `diagnoseSavedChatArchiveV1` is now sourced from the trusted
     chain, so the harness must install it. Loading these does NOT change what
     the legacy list/validate entry points below do — they are still the
     original JS verifier, which is exactly what most of this suite tests. */
  for (const rel of [
    'src-surfaces-base/studio/ingestion/saved-chat-archive-health-mapping.js',
    'src-surfaces-base/studio/ingestion/saved-chat-archive-integrity.tauri.js',
    'src-surfaces-base/studio/ingestion/saved-chat-archive-health-composition.js',
  ]) {
    vm.runInContext(readRepo(rel), sandbox, { filename: rel });
  }
  vm.runInContext(readRepo(MODULE_REL), sandbox, { filename: MODULE_REL });
  return sandbox.H2O.Studio.ingestion;
}

const moduleSource = readRepo(MODULE_REL);
const studioHtml = readRepo(STUDIO_HTML_REL);
const packStudio = readRepo(PACK_STUDIO_REL);
const capabilityRaw = readRepo(CAPABILITY_REL);
const capability = JSON.parse(capabilityRaw);

console.log('[saved-chat-archive-diagnostics-v1] static checks');

check('module file exists', () => {
  assert.ok(fs.existsSync(path.join(REPO_ROOT, MODULE_REL)));
});

check('module registers required H2O.Studio.ingestion APIs', () => {
  /* M10 P4 retired the duplicate JS verifier; what this module registers is the
     trusted Health facade plus decision-neutral observations. */
  for (const apiName of [
    'diagnoseSavedChatArchiveCapabilitiesV1',
    'diagnoseSavedChatArchiveV1',
    'dbDriftForIdentityV1',
    'liveCasPresenceForShasV1',
  ]) {
    assert.match(moduleSource, new RegExp(`H2O\\.Studio\\.ingestion\\.${apiName}`));
  }
});

check('module is Desktop/Tauri gated', () => {
  assert.match(moduleSource, /function detectTauri/);
  assert.match(moduleSource, /__TAURI_INTERNALS__/);
  assert.match(moduleSource, /if \(!detectTauri\(\)\) return/);
});

check('module uses AppLocalData baseDir 15 and archive/packages root', () => {
  assert.match(moduleSource, /APP_LOCAL_DATA\s*=\s*15/);
  assert.match(moduleSource, /PACKAGE_ROOT\s*=\s*'archive\/packages'/);
  assert.match(moduleSource, /LIVE_CAS_ROOT\s*=\s*'archive\/assets'/);
});

check('diagnostics owns no second gzip decoder or hash implementation', () => {
  assert.doesNotMatch(moduleSource, /DecompressionStream/);
  assert.doesNotMatch(moduleSource, /CompressionStream/);
  assert.doesNotMatch(moduleSource, /0x1f/);
  assert.doesNotMatch(moduleSource, /gzipDecode|inflate|gunzip/);
});

check('module contains no mutation filesystem commands', () => {
  for (const forbidden of [
    'plugin:fs|write_file',
    'plugin:fs|write_text_file',
    'plugin:fs|mkdir',
    'plugin:fs|remove',
    'plugin:fs|rename',
  ]) {
    assert.ok(!moduleSource.includes(forbidden), `forbidden command present: ${forbidden}`);
  }
});

check('module uses only read-only live CAS presence checks', () => {
  assert.match(moduleSource, /assetCas\.exists/);
  assert.match(moduleSource, /assetCas\.describe/);
  assert.ok(!moduleSource.includes('assetCas.putAssetBytes'));
  assert.ok(!moduleSource.includes('assetCas.getAssetBytes'));
  assert.ok(moduleSource.includes('live-cas-missing-package-portable'));
});

check('module does not implement CAS write-back, Sync, Chrome, import, or export reconciliation', () => {
  for (const forbidden of [
    'putAssetBytes',
    'getAssetBytes',
    'H2O.Studio.sync',
    'H2O Studio Sync',
    'importSavedChat',
    'recoverSavedChat',
    'writeSavedChatPackageV1',
  ]) {
    assert.ok(!moduleSource.includes(forbidden), `forbidden coupling present: ${forbidden}`);
  }
});

check('module reads DB only via read-only store adapters (no store mutation)', () => {
  // C5.4A reads
  assert.match(moduleSource, /\.chats\.get\b/);
  assert.match(moduleSource, /\.snapshots\.get\b/);
  assert.match(moduleSource, /\.snapshots\.listByChat\b/);
  assert.match(moduleSource, /\.assets\.listBySnapshot\b/);
  // unambiguous store-mutation method names must be absent entirely
  for (const banned of ['upsert', 'bulkUpsert', 'linkToTurn', 'unlinkFromTurn']) {
    assert.ok(!moduleSource.includes(banned), `store mutation referenced: ${banned}`);
  }
  // generic mutators must not be called on store namespaces
  const storeMutation = /\.(chats|snapshots|assets)\.(upsert|update|delete|remove|insert|write|patch|create|saveNow|bulkUpsert|linkToTurn|unlinkFromTurn)\s*\(/;
  assert.ok(!storeMutation.test(moduleSource), 'store mutation method call present on a store namespace');
});

check('module declares includeDbChecks option and dbChecks schema', () => {
  assert.match(moduleSource, /includeDbChecks/);
  assert.match(moduleSource, /function defaultDbChecks/);
  for (const field of ['chatExists', 'snapshotExists', 'latestSnapshotId', 'packageIsLatest', 'storeSnapshotCount', 'storeAssetCount', 'packageAssetSetMatchesStore', 'missingStoreAssets', 'extraStoreAssets']) {
    assert.match(moduleSource, new RegExp(field), `dbChecks field missing: ${field}`);
  }
  for (const code of ['missing-db-chat', 'missing-db-snapshot', 'stale-package', 'store-asset-registry-mismatch', 'db-api-missing', 'db-check-failed']) {
    assert.ok(moduleSource.includes(code), `db warning code missing: ${code}`);
  }
});

check('studio.html loads archive diagnostics module', () => {
  assert.ok(studioHtml.includes(`./ingestion/${MODULE_NAME}`));
});

check('pack-studio includes archive diagnostics module', () => {
  const count = (packStudio.match(new RegExp(`ingestion/${MODULE_NAME}`, 'g')) || []).length;
  assert.ok(count >= 2, `expected source and mirror pack entries, got ${count}`);
});

check('capability grants narrow read-dir under AppLocalData archive/packages', () => {
  const readDir = capability.permissions.find((entry) => entry.identifier === 'fs:allow-read-dir');
  assert.ok(readDir, 'fs:allow-read-dir missing');
  const paths = readDir.allow.map((entry) => entry.path).sort();
  assert.deepEqual(paths, [
    '$APPLOCALDATA/archive/packages',
    '$APPLOCALDATA/archive/packages/**',
  ]);
  for (const permission of capability.permissions) {
    for (const allow of permission.allow || []) {
      assert.ok(!String(allow.path || '').includes('$HOME'), `broad home path found: ${allow.path}`);
      assert.ok(!String(allow.path || '').includes('H2O Studio Sync'), `sync folder path found: ${allow.path}`);
    }
  }
});

check('M06 T1.2 renderer archive mutation authority remains exactly zero', () => {
  const granted = capability.permissions.map((entry) => entry.identifier).sort();
  /* Every mutation-shaped fs permission must be ABSENT from the archive
     capability. M06 adds trusted Rust authority only; it never widens the
     renderer. */
  for (const forbidden of [
    'fs:allow-remove',
    'fs:allow-rename',
    'fs:allow-write-file',
    'fs:allow-write-text-file',
    'fs:allow-mkdir',
    'fs:allow-copy-file',
    'fs:allow-truncate',
  ]) {
    assert.ok(!granted.includes(forbidden), `${forbidden} must not be granted under archive/**`);
  }
  /* Deliberately structural, NOT a raw-text ban: the capability description
     legitimately narrates that fs:allow-write-file and fs:allow-mkdir were
     REMOVED at the M05 G1 cutover, and Tauri grants only what appears in
     `permissions`. Banning the strings would force deleting accurate history. */
  /* And the grant set is exactly the read/metadata quartet. */
  assert.deepEqual(granted, [
    'fs:allow-exists',
    'fs:allow-lstat',
    'fs:allow-read-dir',
    'fs:allow-read-file',
  ]);
});

check('M06 T1.2 introduces no renderer-visible reclamation command or path-shaped API', () => {
  /* T1.2 reserves identities only. No destructive or path-shaped M06 command
     may be reachable from the renderer. */
  const forbiddenTokens = [
    'h2o_archive_reclaim',
    'h2o_archive_quarantine',
    'h2o_archive_purge',
    'h2o_archive_delete',
    'h2o_archive_gc',
  ];
  const libRs = readRepo('apps/studio/desktop/src-tauri/src/lib.rs');
  for (const token of forbiddenTokens) {
    assert.ok(!libRs.includes(token), `${token} must not be registered in lib.rs`);
    assert.ok(!capabilityRaw.includes(token), `${token} must not appear in the archive capability`);
  }
});

console.log('[saved-chat-archive-diagnostics-v1] fixture checks');

await checkAsync('APIs register in Tauri VM context', async () => {
  const fixture = createFixtureFs();
  const ingestion = loadModule(fixture);
  assert.equal(typeof ingestion.diagnoseSavedChatArchiveCapabilitiesV1, 'function');
  assert.equal(typeof ingestion.diagnoseSavedChatArchiveV1, 'function');
  assert.equal(typeof ingestion.dbDriftForIdentityV1, 'function');
  assert.equal(typeof ingestion.liveCasPresenceForShasV1, 'function');
  /* And the retired verifier entry points are genuinely gone from the runtime
     surface, not merely unexported. */
  for (const retired of ['listSavedChatArchivePackagesV1', 'validateSavedChatPackageV1', 'validateSavedChatPackageBytesV1']) {
    assert.equal(typeof ingestion[retired], 'undefined', `${retired} must not exist`);
  }
});

await checkAsync('capability diagnostic reports read-only Desktop archive scope', async () => {
  const fixture = createFixtureFs();
  const ingestion = loadModule(fixture);
  const result = ingestion.diagnoseSavedChatArchiveCapabilitiesV1();
  assert.equal(result.installed, true);
  assert.equal(result.desktopOnly, true);
  assert.equal(result.readOnly, true);
  assert.equal(result.baseDir, APP_LOCAL_DATA);
  assert.equal(result.roots.packages, PACKAGE_ROOT);
  assert.equal(result.boundaries.dbChecks, 'read-only-store-adapters');
  assert.equal(result.boundaries.casChecks, 'read-only-exists-describe');
  assert.equal(result.boundaries.sync, false);
  assert.equal(result.boundaries.chrome, false);
  assert.equal(result.boundaries.ui, false);
});

/* M10 P4: the DB-drift tests now drive the LIVE exported observation directly
   instead of reaching it through the retired package verifier. */
const V1_IDENTITY = { chatId: 'chat_diag_v1', snapshotId: 'snap_diag_v1', assetShas: [] };
const V2_IDENTITY = { chatId: 'chat_diag_v2', snapshotId: 'snap_diag_v2', assetShas: [ASSET_SHA] };

/* ---- M06 T1.3 residue diagnostics ---------------------------------- */

const RESIDUE_ENTRIES = [
  { name: '.h2o-genstage-00ff01', isDirectory: true },
  { name: '.h2o-genstage-00aa02', isDirectory: true },
  { name: '.h2o-durable-4711-0.tmp', isFile: true },
];

await checkAsync('T1.3 A/B/C residue count, exact paths and deterministic order', async () => {
  const fixture = createFixtureFs({ extraEntries: RESIDUE_ENTRIES });
  const ingestion = loadModule(fixture);
  const result = await ingestion.diagnoseSavedChatArchiveV1({ includeDbChecks: false });
  const residue = result.residue;

  /* (A) total count matches the complete residue list */
  assert.equal(residue.count, RESIDUE_ENTRIES.length);
  assert.equal(residue.count, residue.entries.length, 'count must equal the list it represents');
  assert.equal(result.counts.residueTotal, residue.count);

  /* (B) every residue item appears exactly once, by exact archive-relative path */
  /* Array.from re-homes vm-realm arrays into this realm; deepStrictEqual
     compares prototypes, so a vm array never deep-equals a host literal. */
  const paths = Array.from(residue.entries, (entry) => entry.path);
  assert.deepEqual([...new Set(paths)], paths, 'no residue path may repeat');
  assert.deepEqual(paths.slice().sort(), [
    `${PACKAGE_ROOT}/.h2o-durable-4711-0.tmp`,
    `${PACKAGE_ROOT}/.h2o-genstage-00aa02`,
    `${PACKAGE_ROOT}/.h2o-genstage-00ff01`,
  ]);
  assert.deepEqual(
    Array.from(residue.entries, (entry) => entry.kind).sort(),
    ['durable-temp', 'generation-staging', 'generation-staging'],
  );

  /* (C) ordering is deterministic regardless of directory order */
  assert.deepEqual(paths, paths.slice().sort(), 'residue must be emitted in sorted path order');
  const reversed = createFixtureFs({ extraEntries: RESIDUE_ENTRIES.slice().reverse() });
  const again = await loadModule(reversed).diagnoseSavedChatArchiveV1({ includeDbChecks: false });
  assert.deepEqual(Array.from(again.residue.entries, (e) => e.path), paths, 'order must not depend on readDir order');

  /* the scan really was complete, and (I) nothing was mutated */
  assert.equal(residue.complete, true);
  assert.equal(fixture.mutationCalls.length, 0);
});

await checkAsync('T1.3 D zero residue on a complete scan reports count 0 and an empty list', async () => {
  const fixture = createFixtureFs();
  const ingestion = loadModule(fixture);
  const result = await ingestion.diagnoseSavedChatArchiveV1({ includeDbChecks: false });
  assert.equal(result.complete, true);
  assert.equal(result.residue.complete, true);
  assert.equal(result.residue.count, 0);
  assert.equal(result.residue.entries.length, 0);
  /* BOTH families were enumerated, so the zero covers both */
  assert.deepEqual(Array.from(result.residue.scanned).sort(), ['archive/assets', PACKAGE_ROOT].sort());
  assert.equal(result.residue.unscanned.length, 0, 'nothing may be left unenumerated on a complete run');
  assert.deepEqual(
    Array.from(result.residue.sources, (source) => source.root).sort(),
    ['archive/assets', PACKAGE_ROOT].sort(),
  );
  assert.ok(fixture.probeCalls.length > 0, 'the trusted durable-temp probe must actually run');
  assert.equal(fixture.mutationCalls.length, 0);
});

await checkAsync('T1.3 E/K a failed scan can never claim authoritative zero residue', async () => {
  /* M10 P4 removed the bounded inventory walk, so truncation is no longer a way
     to produce a partial scan. The invariant that mattered survives intact: a
     walk that FAILED must not be read as proof that there is no residue. */
  const broken = createFixtureFs({ readDirThrows: true });
  const failed = await loadModule(broken).diagnoseSavedChatArchiveV1({ includeDbChecks: false });
  assert.equal(failed.residue.count, 0);
  assert.equal(failed.residue.complete, false, 'a failed walk is not authority for zero residue');
  assert.ok(
    failed.residue.unscanned.some((s) => s.root === PACKAGE_ROOT),
    'the unscanned source must be named rather than silently omitted',
  );
});

await checkAsync('T1.3 F/G/H packages and reserved infrastructure are never residue', async () => {
  const fixture = createFixtureFs({ extraEntries: RESIDUE_ENTRIES });
  const result = await loadModule(fixture).diagnoseSavedChatArchiveV1({ includeDbChecks: false });
  const names = Array.from(result.residue.entries, (entry) => entry.name);

  /* (F) valid generations/packages are not residue */
  for (const pkg of result.packages) {
    assert.ok(!names.includes(pkg.packageDirName), `${pkg.packageDirName} must not be residue`);
  }
  /* foreign, non-reserved entries are reported by the existing warnings, not
     counted as trusted-writer residue */
  for (const foreign of ['not_a_package', 'loose.txt']) {
    assert.ok(!names.includes(foreign), `${foreign} must not be counted as residue`);
  }
  /* (G) the instance lock and (H) the quarantine namespace are infrastructure */
  assert.ok(!names.includes('.h2o-archive.lock'), 'the instance lock is not residue');
  assert.ok(!names.includes('.h2o-reclaim'), 'the quarantine namespace is not residue');
  assert.equal(result.residue.count, RESIDUE_ENTRIES.length);
});

await checkAsync('T1.3 residue evidence carries into the aggregate diagnostic', async () => {
  const fixture = createFixtureFs({ extraEntries: RESIDUE_ENTRIES });
  const aggregate = await loadModule(fixture).diagnoseSavedChatArchiveV1({ includeDbChecks: false });
  assert.equal(aggregate.residue.count, RESIDUE_ENTRIES.length, 'aggregate must not publish a fresh empty residue block');
  assert.equal(aggregate.residue.complete, true);
  assert.equal(aggregate.counts.residueTotal, RESIDUE_ENTRIES.length);
  assert.equal(fixture.mutationCalls.length, 0);
});

await checkAsync('T1.3 I residue reporting introduces no mutation or delete behavior', async () => {
  const fixture = createFixtureFs({ extraEntries: RESIDUE_ENTRIES });
  const ingestion = loadModule(fixture);
  await ingestion.diagnoseSavedChatArchiveV1({ includeDbChecks: false });
  await ingestion.diagnoseSavedChatArchiveV1({ includeDbChecks: false });
  assert.equal(fixture.mutationCalls.length, 0, 'diagnostics must never issue a mutation command');
  /* and no reclamation-shaped API appeared on the surface */
  for (const forbidden of ['reclaimSavedChatArchiveResidueV1', 'deleteSavedChatArchiveResidueV1', 'purgeSavedChatArchiveV1', 'quarantineSavedChatArchiveV1']) {
    assert.equal(typeof ingestion[forbidden], 'undefined', `${forbidden} must not exist`);
  }
  const source = readRepo('src-surfaces-base/studio/ingestion/saved-chat-archive-diagnostics.tauri.js');
  for (const token of ['plugin:fs|remove', 'plugin:fs|rename', 'plugin:fs|write_file', 'plugin:fs|mkdir']) {
    assert.ok(!source.includes(token), `${token} must not appear in read-only diagnostics`);
  }
});

const DURABLE_TEMP_FIXTURE = {
  complete: true,
  entries: [
    { name: '.h2o-durable-9-1.tmp', path: 'archive/assets/ab/.h2o-durable-9-1.tmp', shard: 'ab', kind: 'durable-temp' },
    { name: '.h2o-durable-7-0.tmp', path: 'archive/assets/cd/.h2o-durable-7-0.tmp', shard: 'cd', kind: 'durable-temp' },
  ],
};

await checkAsync('T1.3 K/L both residue families compose into one counted, ordered list', async () => {
  const fixture = createFixtureFs({ extraEntries: RESIDUE_ENTRIES, durableTemp: DURABLE_TEMP_FIXTURE });
  const result = await loadModule(fixture).diagnoseSavedChatArchiveV1({ includeDbChecks: false });
  const residue = result.residue;

  /* (L) aggregate count equals the combined unique entry list */
  const expectedTotal = RESIDUE_ENTRIES.length + DURABLE_TEMP_FIXTURE.entries.length;
  assert.equal(residue.count, expectedTotal);
  assert.equal(residue.count, residue.entries.length);
  assert.equal(result.counts.residueTotal, expectedTotal);

  const paths = Array.from(residue.entries, (entry) => entry.path);
  assert.deepEqual([...new Set(paths)], paths, 'no residue path may appear twice');
  assert.deepEqual(paths, paths.slice().sort(), 'the combined list stays deterministically ordered');

  /* (K) both families are present and distinguishable */
  const kinds = Array.from(residue.entries, (entry) => entry.kind);
  /* 2 staging under packages, plus 3 durable-temp: one defensively placed
     under packages by the fixture and two from the trusted CAS probe. */
  assert.equal(kinds.filter((k) => k === 'generation-staging').length, 2);
  assert.equal(kinds.filter((k) => k === 'durable-temp').length, 3);
  assert.equal(kinds.filter((k) => k === 'durable-temp').length + kinds.filter((k) => k === 'generation-staging').length, expectedTotal);
  assert.ok(paths.includes('archive/assets/ab/.h2o-durable-9-1.tmp'));
  assert.ok(paths.includes(`${PACKAGE_ROOT}/.h2o-genstage-00ff01`));

  assert.equal(residue.complete, true);
  assert.equal(fixture.mutationCalls.length, 0);
});

await checkAsync('T1.3 M an incomplete source in EITHER family forbids a complete result', async () => {
  /* (i) durable probe reports incomplete */
  const partialProbe = createFixtureFs({ durableTemp: { complete: false, entries: [] } });
  const a = await loadModule(partialProbe).diagnoseSavedChatArchiveV1({ includeDbChecks: false });
  assert.equal(a.residue.complete, false, 'an incomplete probe forbids completeness');
  assert.equal(a.residue.count, 0);
  assert.ok(a.residue.unscanned.some((s) => s.root === 'archive/assets'), 'the incomplete source must be named');

  /* (ii) durable probe throws entirely */
  const brokenProbe = createFixtureFs({ durableTempThrows: true });
  const b = await loadModule(brokenProbe).diagnoseSavedChatArchiveV1({ includeDbChecks: false });
  assert.equal(b.residue.complete, false, 'a failed probe forbids completeness');
  assert.equal(b.residue.count, 0);
  assert.ok(b.residue.unscanned.some((s) => s.root === 'archive/assets' && s.reason === 'probe-failed'));

  /* (iv) the packages root is missing: staging absence is proven, but a failed
     probe still forbids an authoritative zero -- the exact false-zero shape */
  const missing = createFixtureFs({ missingRoot: true, durableTempThrows: true });
  const d = await loadModule(missing).diagnoseSavedChatArchiveV1({ includeDbChecks: false });
  assert.equal(d.residue.count, 0);
  assert.equal(d.residue.complete, false, 'missing packages root + failed probe must NOT be an authoritative zero');
});

await checkAsync('T1.3 N/O/P the probe is read-only, path-less, and grants nothing', async () => {
  /* (N) renderer capability is untouched by T1.3 */
  const granted = capability.permissions.map((entry) => entry.identifier).sort();
  assert.deepEqual(granted, ['fs:allow-exists', 'fs:allow-lstat', 'fs:allow-read-dir', 'fs:allow-read-file']);
  const readDir = capability.permissions.find((entry) => entry.identifier === 'fs:allow-read-dir');
  assert.deepEqual(readDir.allow.map((entry) => entry.path).sort(), [
    '$APPLOCALDATA/archive/packages',
    '$APPLOCALDATA/archive/packages/**',
  ], 'archive/assets read-dir must NOT have been granted to the renderer');

  /* (O) the command is invoked with no arguments at all */
  const fixture = createFixtureFs({ durableTemp: DURABLE_TEMP_FIXTURE });
  await loadModule(fixture).diagnoseSavedChatArchiveV1({ includeDbChecks: false });
  assert.ok(fixture.probeCalls.length > 0);
  for (const call of fixture.probeCalls) {
    const args = call.args === undefined || call.args === null ? {} : call.args;
    assert.deepEqual(Object.keys(args), [], 'the probe must be called with no caller-supplied input');
  }

  /* (P) no destructive authority anywhere in the trusted probe or its wiring */
  const probeSource = readRepo('apps/studio/desktop/src-tauri/src/archive_residue_probe.rs');
  for (const forbidden of ['unlinkat', 'remove_file', 'remove_dir', 'renameat', 'O_CREAT', 'O_TRUNC', 'mkdirat']) {
    assert.ok(!probeSource.includes(forbidden), `probe must not reference ${forbidden}`);
  }
  assert.equal(fixture.mutationCalls.length, 0);
});

/* M10 P3b: the aggregate facade is now sourced from TRUSTED verification, so
   package validity comes from the trusted envelope rather than from JS
   re-verification of the fixture bytes. The legacy verifier still exists and is
   still tested directly above via validateSavedChatPackageV1 — this case now
   pins what the PRODUCTION FACADE reports. */
await checkAsync('aggregate diagnostic returns partial for mixed trusted package health', async () => {
  const mixed = {
    schema: 'h2o.savedChatArchiveIntegrity', schemaVersion: 1, complete: true, blockers: [],
    observed: { byConstructionFamily: { v1: 2, v2: 2, v3: 0 } },
    liveGenerationFamily: 'v3',
    occupants: [
      { path: `${PACKAGE_ROOT}/chat_diag_v1.h2ochat`, name: 'chat_diag_v1.h2ochat', class: 'verified-generation', chatId: 'chat_diag_v1', snapshotId: 'snap_diag_v1', contentHash: 'a'.repeat(64), constructionFamily: 'v1', snapshotEncoding: 'identity', savedAt: '2026-01-01T00:00:00.000Z', orderable: true, assetShas: [], blockers: [] },
      { path: `${PACKAGE_ROOT}/chat_diag_v2.h2ochat`, name: 'chat_diag_v2.h2ochat', class: 'verified-generation', chatId: 'chat_diag_v2', snapshotId: 'snap_diag_v2', contentHash: 'b'.repeat(64), constructionFamily: 'v2', snapshotEncoding: 'identity', savedAt: '2026-01-02T00:00:00.000Z', orderable: true, assetShas: [], blockers: [] },
      { path: `${PACKAGE_ROOT}/chat_diag_bad.h2ochat`, name: 'chat_diag_bad.h2ochat', class: 'indeterminate', reason: 'corrupt', blockers: [{ code: 'generation-v3-snapshot-messages-invalid' }] },
      { path: `${PACKAGE_ROOT}/chat_diag_bad_asset.h2ochat`, name: 'chat_diag_bad_asset.h2ochat', class: 'indeterminate', reason: 'corrupt', blockers: [{ code: 'generation-asset-sha-mismatch' }] },
    ],
  };
  const fixture = createFixtureFs({ trustedEnvelope: mixed });
  const ingestion = loadModule(fixture);
  const result = await ingestion.diagnoseSavedChatArchiveV1({ limit: 20, includeDbChecks: false });

  assert.equal(result.status, 'partial', 'a trusted mix reads Mixed');
  assert.equal(result.counts.packagesTotal, 4);
  assert.equal(result.counts.packagesOk, 2);
  assert.equal(result.counts.packagesBlocked, 2);

  /* M10 P3 metric correction: the approximate integrity counts are RETIRED, and
     the legacy dataImageResidue COUNT stays retired even now that P3.5b
     performs hygiene — hygiene reports separately, under its own availability.
     None may reappear as a measured-looking 0. */
  for (const retired of ['brokenPackageAssets', 'assetRefMismatches', 'dataImageResidue']) {
    assert.ok(!(retired in result.counts), `${retired} must not be emitted`);
  }
  assert.equal(result.rendererHygiene.observed, false, 'hygiene availability is explicit');
  assert.equal(result.rendererHygiene.deferredTo, undefined, 'the P3.5 deferral is retired');
  assert.equal(result.rendererHygiene.packagesObserved, 0);

  /* What replaces them: the trusted rule that actually failed, per package. */
  const blocked = result.packages.filter((p) => p.status === 'blocked');
  assert.equal(blocked.length, 2);
  assert.equal(
    JSON.stringify(blocked.map((p) => p.blockers[0].code).sort()),
    JSON.stringify(['generation-asset-sha-mismatch', 'generation-v3-snapshot-messages-invalid']),
  );
  assert.ok(blocked[0].blockers[0].message.length > 0, 'each blocker is explained');
  assert.equal(fixture.mutationCalls.length, 0);
});

console.log('[saved-chat-archive-diagnostics-v1] C5.4A db-reconciliation checks');

const DB_CODES = new Set(['missing-db-chat', 'missing-db-snapshot', 'stale-package', 'store-asset-registry-mismatch', 'db-api-missing', 'db-check-failed']);

await checkAsync('capability advertises read-only store-adapter DB checks', async () => {
  const ingestion = loadModule(createFixtureFs());
  const caps = ingestion.diagnoseSavedChatArchiveCapabilitiesV1();
  assert.equal(caps.boundaries.dbChecks, 'read-only-store-adapters');
  assert.deepEqual([...caps.storeReads].sort(), ['assets.listBySnapshot', 'chats.get', 'snapshots.get', 'snapshots.listByChat']);
});

await checkAsync('consistent store: v2 dbChecks pass with no DB warnings', async () => {
  const fixture = createFixtureFs();
  const drift = await loadModule(fixture).dbDriftForIdentityV1(V2_IDENTITY, fixture.store);
  const db = drift.dbChecks;
  assert.equal(db.checked, true);
  assert.equal(db.available, true);
  assert.equal(db.chatExists, true);
  assert.equal(db.snapshotExists, true);
  assert.equal(db.packageIsLatest, true);
  assert.equal(db.storeAssetCount, 1);
  assert.equal(db.packageAssetSetMatchesStore, true);
  assert.equal(db.warnings.length, 0);
  assert.equal(drift.warnings.length, 0, 'no DB warnings on a consistent identity');
});

await checkAsync('missing DB chat is a warning, not a blocker', async () => {
  const fixture = createFixtureFs({ storeOptions: { missingChats: ['chat_diag_v1'] } });
  const drift = await loadModule(fixture).dbDriftForIdentityV1(V1_IDENTITY, fixture.store);
  assert.equal(drift.dbChecks.chatExists, false);
  assert.ok(drift.warnings.some((i) => i.code === 'missing-db-chat'));
  assert.equal(drift.dbChecks.blockers.length, 0, 'DB drift must not add blockers');
});

await checkAsync('stale package (not latest DB snapshot) is a warning', async () => {
  const fixture = createFixtureFs({ storeOptions: { staleLatest: { chat_diag_v2: 'snap_newer' } } });
  const drift = await loadModule(fixture).dbDriftForIdentityV1(V2_IDENTITY, fixture.store);
  assert.equal(drift.dbChecks.packageIsLatest, false);
  assert.equal(drift.dbChecks.latestSnapshotId, 'snap_newer');
  assert.ok(drift.warnings.some((i) => i.code === 'stale-package'));
  assert.equal(drift.dbChecks.blockers.length, 0);
});

await checkAsync('store asset registry mismatch is a warning', async () => {
  const fakeSha = 'sha256-' + 'b'.repeat(64);
  const fixture = createFixtureFs({ storeOptions: { assetOverride: { snap_diag_v2: [fakeSha] } } });
  const drift = await loadModule(fixture).dbDriftForIdentityV1(V2_IDENTITY, fixture.store);
  assert.equal(drift.dbChecks.packageAssetSetMatchesStore, false);
  assert.ok(drift.dbChecks.missingStoreAssets.includes(ASSET_SHA), 'manifest asset missing from store registry');
  assert.ok(drift.dbChecks.extraStoreAssets.includes(fakeSha), 'store registry has an extra asset');
  assert.ok(drift.warnings.some((i) => i.code === 'store-asset-registry-mismatch'));
  assert.equal(drift.dbChecks.blockers.length, 0);
});

await checkAsync('v1 asset-less identity with store assets present warns (mismatch, not blocker)', async () => {
  const fixture = createFixtureFs({ storeOptions: { assetOverride: { snap_diag_v1: ['sha256-' + 'c'.repeat(64)] } } });
  const drift = await loadModule(fixture).dbDriftForIdentityV1(V1_IDENTITY, fixture.store);
  assert.equal(drift.dbChecks.packageAssetSetMatchesStore, false);
  assert.ok(drift.warnings.some((i) => i.code === 'store-asset-registry-mismatch'));
  assert.equal(drift.dbChecks.blockers.length, 0);
});

await checkAsync('missing store namespace degrades to warning (db-api-missing), no crash/blocker', async () => {
  const fixture = createFixtureFs();
  const drift = await loadModule(fixture).dbDriftForIdentityV1(V2_IDENTITY, null);
  assert.equal(drift.dbChecks.available, false);
  assert.ok(drift.warnings.some((i) => i.code === 'db-api-missing'));
  assert.equal(drift.dbChecks.blockers.length, 0);
});

await checkAsync('partial store API (no assets.listBySnapshot) degrades to warning, no crash', async () => {
  const fixture = createFixtureFs({ storeOptions: { omitMethods: ['assets.listBySnapshot'] } });
  const drift = await loadModule(fixture).dbDriftForIdentityV1(V2_IDENTITY, fixture.store);
  assert.ok(drift.warnings.length > 0, 'a degraded store API is reported, not swallowed');
  assert.equal(drift.dbChecks.blockers.length, 0);
});

await checkAsync('store read throw degrades to warning (db-check-failed), no crash', async () => {
  const fixture = createFixtureFs({ storeOptions: { throwOn: ['chats.get'] } });
  const drift = await loadModule(fixture).dbDriftForIdentityV1(V1_IDENTITY, fixture.store);
  assert.ok(drift.warnings.some((i) => i.code === 'db-check-failed'));
  assert.equal(drift.dbChecks.blockers.length, 0);
});

await checkAsync('includeDbChecks:false skips DB reconciliation entirely', async () => {
  const fixture = createFixtureFs({ storeOptions: { missingChats: ['chat_diag_v2'] } });
  const result = await loadModule(fixture).diagnoseSavedChatArchiveV1({ includeDbChecks: false });
  assert.ok(!result.warnings.some((i) => DB_CODES.has(i.code)), 'no DB warnings when DB checks are disabled');
  assert.equal(result.dbChecks.warnings, 0);
});

await checkAsync('aggregate exposes dbChecks summary + DB drift counts (orphaned/missing/stale)', async () => {
  const fixture = createFixtureFs({
    storeOptions: {
      missingChats: ['chat_diag_v1'],
      missingSnapshots: ['snap_diag_v1'],
      staleLatest: { chat_diag_v2: 'snap_newer' },
    },
  });
  const ingestion = loadModule(fixture);
  const result = await ingestion.diagnoseSavedChatArchiveV1({ limit: 20 });
  assert.ok(result.dbChecks && typeof result.dbChecks.passed === 'number' && typeof result.dbChecks.warnings === 'number' && typeof result.dbChecks.failed === 'number');
  assert.ok(result.counts.missingDbChats >= 1, 'missingDbChats counted');
  assert.ok(result.counts.missingDbSnapshots >= 1, 'missingDbSnapshots counted');
  assert.ok(result.counts.orphanedPackages >= 1, 'orphaned (chat+snapshot missing) classified');
  assert.ok(result.counts.stalePackages >= 1, 'stalePackages counted');
  assert.equal(typeof result.counts.storeAssetMismatches, 'number');
  assert.equal(fixture.mutationCalls.length, 0, 'no fs mutation during diagnostics');
});

if (FAIL.length) {
  console.error(`\n[saved-chat-archive-diagnostics-v1] ${FAIL.length} failed, ${PASS.length} passed`);
  process.exitCode = 1;
} else {
  console.log(`\n[saved-chat-archive-diagnostics-v1] all ${PASS.length} checks passed`);
}
