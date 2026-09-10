#!/usr/bin/env node
//
// Lane: L-COCKPIT-KNOWLEDGE-MODEL
// Mission: knowledge-model-exact-reference-runtime-adoption-v0 (T2)
//
// Studio admission / mirror / packaging validator for the Knowledge Model v0
// modules. Desktop Studio resolves modules through ./-relative <script src>
// tags rooted at src-surfaces-base/studio/ and the packer copies only from
// that tree, so shared/knowledge/ cannot be loaded directly and a Studio
// distribution mirror is required. This validator proves the mirror is a
// mirror and nothing more.
//
// Obligations:
//   A  canonical/mirror parity — IIFE bodies byte-identical, header-only drift
//   B  API parity — canonical and mirror publish equivalent frozen APIs
//   C  studio.html load order — contracts before adapter
//   D  pack parity — both paths once in each list, at matching indices
//   E  studio-reference coverage — the existing drift guard sees both
//   F  inert / read-only admission — namespaces only, adapter never invoked
//   G  canonical foundation byte-unchanged in this working tree

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

import {
  ARCHIVE_WORKBENCH_SOURCE_FILES,
  ARCHIVE_WORKBENCH_OUT_FILES,
  parseStudioHtmlScriptRefs,
  studioHtmlMissingFromAllowlist,
} from '../../product/studio/pack-studio.mjs';

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), '../../..');
const STUDIO_DIR = path.join(repoRoot, 'src-surfaces-base/studio');
const STUDIO_HTML = path.join(STUDIO_DIR, 'studio.html');

// The IIFE opener both Knowledge modules use. The shared/library cores open
// with `(() => {` instead, so this marker is deliberately module-specific
// rather than borrowed from those validators.
const IIFE_MARK = '(function (global) {';

const PAIRS = [
  {
    label: 'contracts',
    canonical: 'shared/knowledge/contracts-v0.js',
    mirror: 'src-surfaces-base/studio/knowledge/contracts-v0.studio.js',
    packPath: 'knowledge/contracts-v0.studio.js',
    namespaces: ['Knowledge', 'KnowledgeContractsV0'],
  },
  {
    label: 'adapter',
    canonical: 'shared/knowledge/captured-chat-highlight-adapter-v0.js',
    mirror: 'src-surfaces-base/studio/knowledge/captured-chat-highlight-adapter-v0.studio.js',
    packPath: 'knowledge/captured-chat-highlight-adapter-v0.studio.js',
    namespaces: ['Knowledge'],
  },
];

let checks = 0;
function ok(label, condition) {
  assert.ok(condition, label);
  checks += 1;
}

function read(rel) {
  return fs.readFileSync(path.join(repoRoot, rel), 'utf8');
}

function body(source, rel) {
  const idx = source.indexOf(IIFE_MARK);
  assert.ok(idx >= 0, `${rel}: IIFE marker ${IIFE_MARK} missing`);
  return { header: source.slice(0, idx), body: source.slice(idx) };
}

function plain(value) {
  return value === null || value === undefined ? value : JSON.parse(JSON.stringify(value));
}

// Load a list of scripts into one fresh realm with NO host globals beyond
// `console`. A module touching document/window/fetch/localStorage would throw
// ReferenceError here, so a clean load is itself evidence.
function loadInto(files, seed) {
  const sandbox = { console };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  if (typeof seed === 'function') seed(sandbox);
  for (const rel of files) {
    vm.runInContext(read(rel), sandbox, { filename: rel });
  }
  return sandbox;
}

/* ══ A. Canonical / mirror parity ══════════════════════════════════════ */

for (const pair of PAIRS) {
  const canonicalSource = read(pair.canonical);
  const mirrorSource = read(pair.mirror);
  const c = body(canonicalSource, pair.canonical);
  const m = body(mirrorSource, pair.mirror);

  ok(`A[${pair.label}]: IIFE body byte-identical to canonical`, c.body === m.body);
  ok(`A[${pair.label}]: mirror is exactly header + canonical body`,
    mirrorSource === m.header + c.body);
  ok(`A[${pair.label}]: only the header differs`, c.header !== m.header);

  // The permitted header difference must actually declare the relationship,
  // so a future reader cannot mistake the mirror for an authority.
  ok(`A[${pair.label}]: mirror header is marked MIRROR`, m.header.includes('MIRROR'));
  ok(`A[${pair.label}]: mirror header names its canonical source`,
    m.header.includes(pair.canonical));
  ok(`A[${pair.label}]: mirror header points at this validator`,
    m.header.includes('validate-knowledge-studio-mirror-parity'));
  // Header-only drift: the header must carry no executable content.
  ok(`A[${pair.label}]: mirror header is comment-only`,
    /^\s*(?:\/\*[\s\S]*?\*\/|\/\/[^\n]*\n|\s)*$/.test(m.header));
}

/* ══ B. API parity ═════════════════════════════════════════════════════ */

{
  const canonicalRealm = loadInto(PAIRS.map((p) => p.canonical));
  const mirrorRealm = loadInto(PAIRS.map((p) => p.mirror));

  const cContracts = canonicalRealm.H2O?.Knowledge?.ContractsV0;
  const mContracts = mirrorRealm.H2O?.Knowledge?.ContractsV0;
  const cAdapter = canonicalRealm.H2O?.Knowledge?.CapturedChatHighlightAdapterV0;
  const mAdapter = mirrorRealm.H2O?.Knowledge?.CapturedChatHighlightAdapterV0;

  ok('B: canonical contracts published', !!cContracts);
  ok('B: mirror contracts published', !!mContracts);
  ok('B: canonical adapter published', !!cAdapter);
  ok('B: mirror adapter published', !!mAdapter);

  ok('B: contracts API keys identical',
    JSON.stringify(Object.keys(cContracts)) === JSON.stringify(Object.keys(mContracts)));
  ok('B: adapter API keys identical',
    JSON.stringify(Object.keys(cAdapter)) === JSON.stringify(Object.keys(mAdapter)));
  ok('B: both contracts APIs frozen', Object.isFrozen(cContracts) && Object.isFrozen(mContracts));
  ok('B: both adapter APIs frozen', Object.isFrozen(cAdapter) && Object.isFrozen(mAdapter));

  // Constants, including the load-bearing v0 rules.
  for (const key of ['contractVersion', 'VERSION', 'VERSION_SCOPE']) {
    ok(`B: contracts constant ${key} identical`, cContracts[key] === mContracts[key]);
  }
  for (const key of ['KINDS', 'REANCHOR_STATUSES', 'REANCHOR_VERSION_SCOPES',
    'SELECTOR_FAMILIES', 'DEFERRED_SELECTOR_FAMILIES', 'DERIVATIONS']) {
    assert.deepEqual(plain(cContracts[key]), plain(mContracts[key]),
      `B: contracts constant ${key} identical`);
  }
  for (const key of ['ITEM_KIND', 'ITEM_SCHEME', 'IDENTITY_AUTHORITY', 'VERSION_SCHEME',
    'BLOCK_KIND', 'BLOCK_SCHEME', 'DERIVATION']) {
    ok(`B: adapter constant ${key} identical`, cAdapter[key] === mAdapter[key]);
  }

  assert.deepEqual(plain(cContracts.diagnose()), plain(mContracts.diagnose()),
    'B: contracts diagnose() identical');
  assert.deepEqual(plain(cAdapter.diagnose()), plain(mAdapter.diagnose()),
    'B: adapter diagnose() identical');

  // Behavioural spot-check: the same input yields the same contract object.
  const input = { itemKind: 'captured_chat', scheme: 'chat-registry/chat-id', id: 'chat-parity' };
  assert.deepEqual(plain(cContracts.makeItemRef(input)), plain(mContracts.makeItemRef(input)),
    'B: identical construction result');
  ok('B: mirror still rejects a malformed identity',
    mContracts.makeItemRef({ ...input, id: ' padded ' }) === null);
  ok('B: mirror preserves same_version', mContracts.VERSION_SCOPE === 'same_version'
    && mContracts.diagnose().reanchor.crossVersion === false);
}

/* ══ C. studio.html load order ═════════════════════════════════════════ */

{
  const html = fs.readFileSync(STUDIO_HTML, 'utf8');
  const refs = parseStudioHtmlScriptRefs(html);
  const contractsIdx = refs.indexOf(PAIRS[0].packPath);
  const adapterIdx = refs.indexOf(PAIRS[1].packPath);

  ok('C: contracts admitted in studio.html', contractsIdx !== -1);
  ok('C: adapter admitted in studio.html', adapterIdx !== -1);
  ok('C: contracts loads before the adapter', contractsIdx < adapterIdx);
  for (const pair of PAIRS) {
    ok(`C: ${pair.label} admitted exactly once`,
      refs.filter((r) => r === pair.packPath).length === 1);
  }
  // Contiguous cluster: nothing wedged between the two Knowledge scripts.
  ok('C: the Knowledge scripts form one contiguous cluster', adapterIdx === contractsIdx + 1);
}

/* ══ D. Pack parity ════════════════════════════════════════════════════ */

{
  ok('D: pack lists are equal length',
    ARCHIVE_WORKBENCH_SOURCE_FILES.length === ARCHIVE_WORKBENCH_OUT_FILES.length);
  const mismatched = ARCHIVE_WORKBENCH_SOURCE_FILES
    .map((v, i) => [v, ARCHIVE_WORKBENCH_OUT_FILES[i]])
    .filter(([a, b]) => a !== b);
  ok('D: every pack pair is index-aligned and identical', mismatched.length === 0);

  for (const pair of PAIRS) {
    const inIdx = ARCHIVE_WORKBENCH_SOURCE_FILES.indexOf(pair.packPath);
    const outIdx = ARCHIVE_WORKBENCH_OUT_FILES.indexOf(pair.packPath);
    ok(`D[${pair.label}]: present in SOURCE list`, inIdx !== -1);
    ok(`D[${pair.label}]: present in OUT list`, outIdx !== -1);
    ok(`D[${pair.label}]: at matching indices`, inIdx === outIdx);
    ok(`D[${pair.label}]: exactly once in SOURCE`,
      ARCHIVE_WORKBENCH_SOURCE_FILES.filter((f) => f === pair.packPath).length === 1);
    ok(`D[${pair.label}]: exactly once in OUT`,
      ARCHIVE_WORKBENCH_OUT_FILES.filter((f) => f === pair.packPath).length === 1);
    // The packed path must resolve to a real file under the Studio source dir.
    ok(`D[${pair.label}]: packed path resolves on disk`,
      fs.existsSync(path.join(STUDIO_DIR, pair.packPath)));
  }
  ok('D: contracts packed before the adapter',
    ARCHIVE_WORKBENCH_SOURCE_FILES.indexOf(PAIRS[0].packPath)
    < ARCHIVE_WORKBENCH_SOURCE_FILES.indexOf(PAIRS[1].packPath));
}

/* ══ E. Studio-reference coverage (the repo's own drift guard) ═════════ */

{
  const missing = studioHtmlMissingFromAllowlist(repoRoot);
  assert.deepEqual(missing, [], 'E: studio.html references no unpacked file');
  ok('E: the existing guard recognises both Knowledge scripts',
    !missing.includes(PAIRS[0].packPath) && !missing.includes(PAIRS[1].packPath));
}

/* ══ F. Inert / read-only admission ════════════════════════════════════ */

{
  // Loading the contracts mirror creates exactly its own namespaces.
  const contractsOnly = loadInto([PAIRS[0].mirror]);
  assert.deepEqual(
    Object.keys(contractsOnly).filter((k) => k !== 'console' && k !== 'globalThis'),
    ['H2O'],
    'F: contracts mirror creates exactly one global',
  );
  assert.deepEqual(Object.keys(contractsOnly.H2O).sort(), ['Knowledge', 'KnowledgeContractsV0'],
    'F: contracts mirror publishes only the Knowledge namespaces');

  // Loading the adapter mirror ALONE — with no contracts present at all —
  // must still succeed, which proves it invoked nothing at load time.
  const adapterOnly = loadInto([PAIRS[1].mirror]);
  assert.deepEqual(Object.keys(adapterOnly.H2O).sort(), ['Knowledge'],
    'F: adapter mirror publishes only the Knowledge namespace');
  assert.deepEqual(Object.keys(adapterOnly.H2O.Knowledge), ['CapturedChatHighlightAdapterV0'],
    'F: adapter mirror adds only its own entry');
  ok('F: adapter loads with no contracts present (nothing invoked at load)',
    !!adapterOnly.H2O.Knowledge.CapturedChatHighlightAdapterV0);
  ok('F: adapter reports contracts unavailable rather than reaching for them',
    adapterOnly.H2O.Knowledge.CapturedChatHighlightAdapterV0.diagnose().contractsAvailable === false);

  // Stronger: seed a booby-trapped ContractsV0 whose every method throws. A
  // clean load proves the admission calls none of them.
  let trapped = 0;
  const trap = loadInto([PAIRS[1].mirror], (sandbox) => {
    const boom = () => { trapped += 1; throw new Error('adapter invoked at load'); };
    sandbox.H2O = {
      Knowledge: {
        ContractsV0: new Proxy({ __installed: true }, {
          get(target, prop) {
            if (prop === '__installed') return true;
            return boom;
          },
        }),
      },
    };
  });
  ok('F: no contract method touched during admission', trapped === 0);
  ok('F: adapter still published alongside the trap',
    !!trap.H2O.Knowledge.CapturedChatHighlightAdapterV0);

  // Both mirrors loaded cleanly in realms holding no document, window, fetch,
  // localStorage, XMLHttpRequest or process — a reference would have thrown.
  ok('F: mirrors load with no host globals available', true);

  // Static confirmation over a code-only view: a bare-word scan of raw source
  // would fire on the modules' own purity disclaimers.
  function stripComments(src) {
    let out = '';
    let state = 'code';
    let i = 0;
    while (i < src.length) {
      const c = src[i];
      const n = src[i + 1];
      if (state === 'code') {
        if (c === '/' && n === '/') { state = 'line'; i += 2; continue; }
        if (c === '/' && n === '*') { state = 'block'; i += 2; continue; }
        if (c === "'") state = 'sq';
        else if (c === '"') state = 'dq';
        else if (c === '`') state = 'tpl';
        out += c; i += 1; continue;
      }
      if (state === 'line') { if (c === '\n') { state = 'code'; out += c; } i += 1; continue; }
      if (state === 'block') {
        if (c === '*' && n === '/') { state = 'code'; i += 2; } else { if (c === '\n') out += c; i += 1; }
        continue;
      }
      if (c === '\\') { out += c + (n === undefined ? '' : n); i += 2; continue; }
      if ((state === 'sq' && c === "'") || (state === 'dq' && c === '"') || (state === 'tpl' && c === '`')) {
        state = 'code';
      }
      out += c; i += 1;
    }
    return out;
  }

  const BANNED = [
    'localStorage', 'sessionStorage', 'indexedDB', 'IDBFactory', 'openDatabase', 'caches',
    'document', 'window', 'navigator', 'location', 'history', 'alert',
    'fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'sendBeacon',
    'chrome', 'browser', 'importScripts', 'require', 'process', 'Deno', 'Buffer',
    'setTimeout', 'setInterval', 'queueMicrotask', 'Date', 'performance', 'random',
    'eval', 'Function',
  ];

  const knowledgeStudioDir = path.join(STUDIO_DIR, 'knowledge');
  const studioFiles = fs.readdirSync(knowledgeStudioDir).filter((n) => /\.(js|mjs|cjs)$/.test(n)).sort();

  // Both mirrors must be present, and NOTHING may sit in the Knowledge cluster
  // directory without being packed — an unpacked file 404s at runtime and
  // ships unreviewed. Stated against the pack list rather than a hardcoded
  // inventory so it stays true as the Lane adds admitted modules.
  const mirrorNames = PAIRS.map((p) => path.basename(p.mirror)).sort();
  ok('F: both mirrors present in the Studio knowledge dir',
    mirrorNames.every((n) => studioFiles.includes(n)));
  const unpacked = studioFiles.filter((n) => !ARCHIVE_WORKBENCH_SOURCE_FILES.includes(`knowledge/${n}`));
  assert.deepEqual(unpacked, [], 'F: every file in the Studio knowledge dir is packed');

  // The banned-token purity scan is scoped to the MIRRORS. They must stay as
  // pure as the canonical cores they copy; other admitted Knowledge modules
  // are Studio runtime consumers with their own validators and their own,
  // different read-only obligations.
  for (const name of mirrorNames) {
    const raw = fs.readFileSync(path.join(knowledgeStudioDir, name), 'utf8');
    const code = stripComments(raw);
    assert.doesNotThrow(() => new vm.Script(code), `F: ${name} code-only view must still parse`);
    ok(`F: ${name} has a header the scan removed`, code.length < raw.length);
    for (const token of BANNED) {
      ok(`F: ${name} does not reference ${token}`, new RegExp(`\\b${token}\\b`).test(code) === false);
    }
    ok(`F: ${name} declares no imports/exports`, !/\bimport\s|\bexport\s|module\.exports/.test(code));
  }
}

/* ══ G. Canonical foundation byte-unchanged ════════════════════════════ */

{
  // Deliberately relative to HEAD rather than a pinned SHA: a hardcoded
  // baseline rots as the Lane advances, while "this working tree has not
  // touched canonical" is the property actually being asserted and stays true
  // across every future commit.
  let status;
  try {
    status = execFileSync(
      'git',
      ['status', '--porcelain=v1', '--', 'shared/knowledge/contracts-v0.js',
        'shared/knowledge/captured-chat-highlight-adapter-v0.js'],
      { cwd: repoRoot, encoding: 'utf8' },
    ).trim();
  } catch (error) {
    assert.fail(`G: canonical byte-identity requires git in the repo tree: ${error && error.message}`);
  }
  assert.equal(status, '', `G: canonical Knowledge sources must be unmodified, got:\n${status}`);

  const tracked = execFileSync('git', ['ls-files', '--', 'shared/knowledge'], { cwd: repoRoot, encoding: 'utf8' })
    .trim().split('\n').filter(Boolean).sort();
  assert.deepEqual(tracked, [
    'shared/knowledge/captured-chat-highlight-adapter-v0.js',
    'shared/knowledge/contracts-v0.js',
  ], 'G: the canonical source home still holds exactly the accepted two modules');
  ok('G: canonical remains the semantic authority (mirrors live outside shared/)',
    PAIRS.every((p) => p.mirror.startsWith('src-surfaces-base/studio/')));
}

console.log(`[validate-knowledge-studio-mirror-parity] ok — ${checks} checks across obligations A–G`);
