#!/usr/bin/env node
// Validator for the Saved Chat Recovery Center timeline surface (Mission T02).
//
// The Recovery Center is a COMPOSITION. Every fact it shows was established by
// an authority that already owns it, so the only thing worth proving here is
// that the surface does not quietly acquire authority of its own on the way to
// the screen — and that it does not lose the guarantees the authorities below
// it paid for.
//
// The failure modes this file is built to catch, each of which has a real
// precedent in this lane:
//
//   - re-deriving order (a filename, an mtime, a generatedAt, an insertion
//     index) instead of consuming coverage's already-sorted populations;
//   - re-reading the trusted archive once per row, turning one bounded read
//     into an N+1 storm;
//   - presenting an INCOMPLETE scan as absence;
//   - making a damaged package selectable, or hiding it so the operator reads
//     "nothing was ever saved";
//   - inventing a universal `recoverable` bit this Task has no authority for;
//   - letting an arbitrary or absolute path become a selection target;
//   - leaving a stale chat/version selection alive across a refresh.
//
// Everything is loaded into a Node VM against a DOM stub. No DB, no filesystem,
// no Tauri, no network.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), '..', '..', '..');

const UI_REL = 'src-surfaces-base/studio/ingestion/saved-chat-recovery-center-ui.studio.js';
const ADAPTER_REL = 'src-surfaces-base/studio/ingestion/saved-chat-archive-presentation.studio.js';
const IMPORTER_REL = 'src-surfaces-base/studio/ingestion/saved-chat-archive-importer.studio.js';
const SANITIZER_REL = 'src-surfaces-base/studio/platform/html-sanitizer.js';
const HEALTH_UI_REL = 'src-surfaces-base/studio/ingestion/archive-health-ui.studio.js';
const HTML_REL = 'src-surfaces-base/studio/studio.html';
const PACK_REL = 'tools/product/studio/pack-studio.mjs';

const PASS = [];
const FAIL = [];
function check(label, fn) {
  try { fn(); PASS.push(label); console.log(`  ✓ ${label}`); }
  catch (e) { const m = e && e.message ? e.message : String(e); FAIL.push({ label, m }); console.log(`  ✗ ${label}`); console.log(`      ${m}`); }
}
async function checkAsync(label, fn) {
  try { await fn(); PASS.push(label); console.log(`  ✓ ${label}`); }
  catch (e) { const m = e && e.message ? e.message : String(e); FAIL.push({ label, m }); console.log(`  ✗ ${label}`); console.log(`      ${m}`); }
}
function readRepo(rel) { return fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8'); }

/* Values built inside the VM are not reference-equal to host values, so
 * deepEqual reports "same structure, not reference-equal" on arrays that are in
 * fact identical. Compare by value. */
function sameList(actual, expected, message) {
  assert.equal(Array.from(actual).join('\u0000'), expected.join('\u0000'), message);
}

/* Source scans must read CODE. This module's header documents at length the
 * authorities it refuses to hold, so a naive substring sweep over the raw file
 * reports a violation for the very comment that promises the opposite. */
function codeOnly(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

const uiSrc = readRepo(UI_REL);
const uiCode = codeOnly(uiSrc);

/* ── DOM stub, just rich enough for this card ───────────────────────────── */
function domStub() {
  const make = (tag) => {
    const node = {
      tagName: String(tag).toUpperCase(),
      children: [], attributes: {}, style: {}, disabled: false,
      id: '', value: '', selected: false, parentNode: null,
      _text: '', _listeners: {},
      set textContent(v) { this._text = String(v); this.children = []; },
      get textContent() { return this._text; },
      setAttribute(k, v) { this.attributes[k] = String(v); },
      getAttribute(k) { return this.attributes[k]; },
      appendChild(c) { c.parentNode = node; this.children.push(c); return c; },
      addEventListener(kind, fn) { this._listeners[kind] = fn; },
      click() { const fn = this._listeners.click; return fn ? fn() : undefined; },
      change() { const fn = this._listeners.change; return fn ? fn() : undefined; },
      querySelector(sel) {
        const m = /^\[([^=]+)="([^"]*)"\]$/.exec(String(sel));
        if (!m) return null;
        const walk = (n) => {
          if (n !== node && n.attributes && n.attributes[m[1]] === m[2]) return n;
          for (const c of n.children || []) { const hit = walk(c); if (hit) return hit; }
          return null;
        };
        return walk(node);
      },
    };
    return node;
  };
  return { createElement: make };
}

function walkAll(node, out = []) {
  if (!node) return out;
  out.push(node);
  for (const c of node.children || []) walkAll(c, out);
  return out;
}
function allText(node) {
  return walkAll(node).map((n) => n._text || '').join(' ');
}
function nodesWithAttr(node, attr, value) {
  return walkAll(node).filter((n) => n.attributes && (value === undefined
    ? n.attributes[attr] !== undefined
    : n.attributes[attr] === value));
}
function findByAction(node, action) {
  return nodesWithAttr(node, 'data-h2o-action', action)[0] || null;
}

/* Load the surface + the real presentation adapter into one VM. The adapter is
 * loaded for real, not stubbed: the labels an operator reads are part of what
 * this surface promises. */
function loadUi(document) {
  const ctx = vm.createContext({ console, Promise, setTimeout, TextDecoder, TextEncoder });
  ctx.window = ctx;
  ctx.globalThis = ctx;
  ctx.document = document;
  vm.runInContext(readRepo(ADAPTER_REL), ctx, { filename: ADAPTER_REL });
  /* The REAL snapshot->turns mapper and the REAL Studio sanitizer. The preview
   * proof is worthless against stubs of the two things it must reuse. */
  vm.runInContext(readRepo(IMPORTER_REL), ctx, { filename: IMPORTER_REL });
  vm.runInContext(readRepo(SANITIZER_REL), ctx, { filename: SANITIZER_REL });
  vm.runInContext(uiSrc, ctx, { filename: UI_REL });
  return {
    ctx,
    api: ctx.H2O.Studio.recoveryCenterUi,
    ingestion: ctx.H2O.Studio.ingestion,
    buildTurns: ctx.H2O.Studio.archiveImporter.buildTurnsFromPackageSnapshot,
    extractText: ctx.H2O.Studio.html.sanitize.extractTextFromHtml,
  };
}

/* ── Preview fixtures ─────────────────────────────────────────────────────
 * Written in the two shapes the shipping writer actually produces: v3 typed
 * content parts, and the v1/v2 scalar `contentText`. */
const enc = (obj) => new TextEncoder().encode(JSON.stringify(obj));

const V3_MANIFEST = { schemaVersion: 3, files: { snapshot: { path: 'snapshot.json', encoding: 'gzip', sha256: 'x' } } };
const V1_MANIFEST = { schemaVersion: 1 };
const V3_SNAPSHOT = {
  schemaVersion: 3, title: 'Third version', capturedAt: '2026-08-22T00:00:00.000Z',
  messages: [
    { role: 'user', content: [{ type: 'text', text: 'what did I save?' }] },
    { role: 'assistant', content: [{ type: 'html', html: '<script>steal()</script><p onclick="x()">the archived answer</p>' }] },
  ],
};
const V1_SNAPSHOT = {
  schemaVersion: 1, title: 'Legacy version',
  messages: [{ role: 'user', contentText: 'legacy scalar body' }],
};

/* Declared as a function so it resolves the hash constants at call time rather
 * than at module-evaluation time, where they are not yet initialized. */
function identityForPath(packagePath) {
  return ({
    'archive/packages/chat_a.g1.h2ochat': HASH_CUR,
    'archive/packages/chat_a.g2.h2ochat': HASH_MID,
    'archive/packages/chat_a.g3.h2ochat': HASH_OLD,
    'archive/packages/chat_b.legacy.h2ochat': HASH_OLD,
  })[packagePath] || HASH_CUR;
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/* A faithful stand-in for the governed codec seam: it records exactly what the
 * surface asked for, so the caps and the v3/v1 routing are provable. */
/* A faithful stand-in for the governed codec seam.
 *
 * It models a PACKAGE ON DISK and enforces the same descriptor contract the real
 * codec does: the verified-member path refuses when the descriptor it is handed
 * does not match the bytes actually present, and the bounded path reports the
 * digest and length of what it actually read. Without that, every substitution
 * proof below would pass vacuously against a stub that returns whatever it is
 * asked for. */
function codecStub(opts = {}) {
  const calls = [];
  const disk = opts.disk || { snapshot: V3_SNAPSHOT, ...anchors('1', 'v3', 'gzip') };
  return {
    calls,
    codec: {
      __installed: true,
      LOGICAL_SNAPSHOT_CAP_BYTES: 8 * 1024 * 1024,
      readBoundedPackageMemberBytes(input) {
        calls.push({ fn: 'readBoundedPackageMemberBytes', ...input });
        if (opts.boundedFails) return Promise.reject(new Error('saved-chat-member-read-failed'));
        return Promise.resolve({
          storedBytes: opts.malformedSnapshot
            ? new TextEncoder().encode('{not json')
            : enc(disk.snapshot),
          physicalSha256: disk.snapshotPhysicalSha256,
          physicalByteLength: disk.snapshotPhysicalByteLength,
        });
      },
      readVerifiedPackageMember(input) {
        calls.push({ fn: 'readVerifiedPackageMember', ...input });
        if (opts.verifiedFails) return Promise.reject(new Error('saved-chat-member-logical-sha-mismatch'));
        const d = input.descriptor || {};
        /* Exactly what the real codec enforces before returning anything. */
        if (d.sha256 !== disk.snapshotPhysicalSha256 || d.byteLength !== disk.snapshotPhysicalByteLength) {
          return Promise.reject(new Error('saved-chat-member-physical-hash-mismatch'));
        }
        if (d.encoding !== disk.snapshotEncoding) {
          return Promise.reject(new Error('saved-chat-member-unsupported-encoding'));
        }
        if (d.contentSha256 !== disk.logicalSnapshotSha256 || d.contentByteLength !== disk.logicalSnapshotByteLength) {
          return Promise.reject(new Error('saved-chat-member-logical-sha-mismatch'));
        }
        if (opts.verifiedDeferred) return opts.verifiedDeferred.promise;
        return Promise.resolve({ logicalBytes: enc(disk.snapshot) });
      },
    },
  };
}

/* ── Synthetic archive ──────────────────────────────────────────────────────
 *
 * Two chats. One of them holds several valid generations plus a damaged
 * occupant; the other holds a single legacy package. Hashes are written in the
 * representations the shipping engine actually emits: bare on the trusted
 * occupant, prefixed on the projection. */
const HASH_CUR = 'a'.repeat(64);
const HASH_OLD = 'b'.repeat(64);
const HASH_MID = 'd'.repeat(64);

/* The trusted member anchors the Rust verifier publishes per package occupant.
 * They are what binds rendered bytes to the inspected package state, so the
 * fixtures carry them exactly as `package_occupant` emits them. */
function anchors(tag, family = 'v3', encoding = 'gzip') {
  return {
    constructionFamily: family,
    snapshotEncoding: encoding,
    snapshotPhysicalSha256: 'sha256-' + tag.repeat(64),
    snapshotPhysicalByteLength: 100 + tag.charCodeAt(0),
    logicalSnapshotSha256: 'sha256-' + tag.toUpperCase().repeat(64).toLowerCase(),
    logicalSnapshotByteLength: 200 + tag.charCodeAt(0),
  };
}

const OCC = {
  aCur: { class: 'verified-generation', name: 'chat_a.g1.h2ochat', path: 'archive/packages/chat_a.g1.h2ochat', chatId: 'chat_a', snapshotId: 's1', contentHash: HASH_CUR, savedAt: '2026-08-22T00:00:00.000Z', constructionFamily: 'v3', blockers: [] , ...anchors('1', 'v3', 'gzip') },
  aMid: { class: 'verified-generation', name: 'chat_a.g2.h2ochat', path: 'archive/packages/chat_a.g2.h2ochat', chatId: 'chat_a', snapshotId: 's2', contentHash: HASH_MID, savedAt: '2026-08-21T00:00:00.000Z', constructionFamily: 'v3', blockers: [] , ...anchors('2', 'v3', 'gzip') },
  aOld: { class: 'verified-generation', name: 'chat_a.g3.h2ochat', path: 'archive/packages/chat_a.g3.h2ochat', chatId: 'chat_a', snapshotId: 's3', contentHash: HASH_OLD, savedAt: '2026-08-20T00:00:00.000Z', constructionFamily: 'v3', blockers: [] , ...anchors('3', 'v3', 'identity') },
  aBad: { class: 'indeterminate', reason: 'corrupt', name: 'chat_a.g4.h2ochat', path: 'archive/packages/chat_a.g4.h2ochat', chatId: 'chat_a', contentHash: '', savedAt: '', blockers: [{ code: 'generation-v3-gzip-decode-failed' }] },
  bLegacy: { class: 'legacy-package', name: 'chat_b.legacy.h2ochat', path: 'archive/packages/chat_b.legacy.h2ochat', chatId: 'chat_b', snapshotId: 's9', contentHash: HASH_OLD, savedAt: '2026-07-01T00:00:00.000Z', constructionFamily: 'v1', blockers: [] , ...anchors('4', 'v1', 'identity') },
  reserved: { class: 'reserved-infrastructure', name: 'quarantine', path: 'archive/packages/quarantine' },
  stray: { class: 'indeterminate', reason: 'not-a-package-name', name: 'notes.txt', path: 'archive/packages/notes.txt' },
};

function envelope(over) {
  return Object.assign({
    schema: 'h2o.savedChatArchiveIntegrity', schemaVersion: 1, complete: true,
    occupants: [OCC.aCur, OCC.aMid, OCC.aOld, OCC.aBad, OCC.bLegacy, OCC.reserved, OCC.stray],
    blockers: [],
  }, over || {});
}

/* The real partition, so the surface is proved against the canonical one. */
function loadPartition() {
  const ctx = vm.createContext({ console });
  ctx.window = ctx;
  vm.runInContext(readRepo('src-surfaces-base/studio/ingestion/saved-chat-archive-health-mapping.js'), ctx,
    { filename: 'health-mapping' });
  return ctx.H2O.Studio.archiveHealthMapping.partitionOccupants;
}
const partitionOccupants = loadPartition();

function covEntry(occ, over) {
  return Object.assign({
    packagePath: occ.path,
    packageDirName: occ.name,
    classification: occ.class === 'verified-generation' ? 'generation'
      : (occ.class === 'legacy-package' ? 'legacy' : 'unclassified'),
    chatId: occ.chatId || '',
    snapshotId: occ.snapshotId || '',
    schemaVersion: occ.constructionFamily === 'v3' ? 3 : 1,
    payloadVersion: occ.constructionFamily === 'v3' ? 3 : null,
    contentHash: occ.contentHash || '',
    savedAt: occ.savedAt || '',
    status: (occ.class === 'verified-generation' || occ.class === 'legacy-package') ? 'ok' : 'blocked',
    blockers: (occ.blockers || []).map((b) => b.code),
  }, over || {});
}

/* Coverage's real output shape for chat_a: newest-first, exactly as
 * compareHistorical produced it. */
function coverageA(over) {
  const cur = covEntry(OCC.aCur);
  const mid = covEntry(OCC.aMid);
  const old = covEntry(OCC.aOld);
  return Object.assign({
    chatId: 'chat_a', complete: true, preserved: true, covered: true,
    projection: { status: 'ok', contentHash: 'sha256-' + HASH_CUR, schemaVersion: 3 },
    generations: [cur, mid, old], legacy: [], unusable: [covEntry(OCC.aBad)],
    fresh: [cur],
    stale: [Object.assign({}, mid, { staleKind: 'content-stale' }), Object.assign({}, old, { staleKind: 'content-stale' })],
    selected: cur, bestHistorical: null, bestHistoricalTies: [], reason: '',
  }, over || {});
}

/* chat_b holds a single v1 legacy package, so the v1/v2 read path can be
 * exercised through a genuinely v1 trusted occupant rather than by overriding a
 * v3 one. */
function coverageB(over) {
  const legacy = covEntry(OCC.bLegacy);
  return Object.assign({
    chatId: 'chat_b', complete: true, preserved: true, covered: true,
    projection: { status: 'ok', contentHash: 'sha256-' + HASH_OLD, schemaVersion: 1 },
    generations: [], legacy: [legacy], unusable: [],
    fresh: [legacy], stale: [], selected: legacy,
    bestHistorical: null, bestHistoricalTies: [], reason: '',
  }, over || {});
}

function harness(overrides) {
  const o = overrides || {};
  const calls = { integrity: 0, coverage: 0, inspect: 0, coverageChats: [], inspectPaths: [], dryRun: [], execute: [],
    restoreDryRun: [], restoreExecute: [] };
  const document = domStub();
  const { api, ingestion, buildTurns, extractText } = loadUi(document);
  const stub = codecStub(Object.assign({}, o.codecOptions || {}, o.disk ? { disk: o.disk } : {}));
  calls.codec = stub.calls;
  const container = document.createElement('div');
  const card = api.renderRecoveryCenterCard(container, Object.assign({
    capable: true,
    autoLoad: false,
    readIntegrity: () => { calls.integrity += 1; return Promise.resolve(o.envelope || envelope()); },
    partitionOccupants,
    describeCoverage: ({ chatId }) => {
      calls.coverage += 1; calls.coverageChats.push(chatId);
      if (o.coverageFor) return Promise.resolve(o.coverageFor(chatId));
      return Promise.resolve(chatId === 'chat_b' ? coverageB() : coverageA());
    },
    describeState: ingestion.describeSavedChatArchiveStateV1,
    entryPresentation: ingestion.savedChatArchivePresentationV1.entryPresentation,
    inspectPackage: ({ packagePath }) => {
      calls.inspect += 1; calls.inspectPaths.push(packagePath);
      if (o.inspectFor) return o.inspectFor(packagePath);
      /* Each package reverifies to ITS OWN trusted identity, so the binding
       * checks exercise what they claim to rather than tripping on a fixture
       * that gives every package the same hash. */
      return Promise.resolve({
        ok: true, status: 'verified', packagePath, packageDirName: packagePath.split('/').pop(),
        identity: {
          chatId: 'chat_a', snapshotId: 's1', title: 'A chat',
          contentHash: 'sha256-' + identityForPath(packagePath), schemaVersion: 3, messageCount: 4,
        },
        checks: { archiveEnumerationComplete: true }, blockers: [], preview: '', error: null,
      });
    },
    codec: o.noCodec ? null : stub.codec,
    buildTurns,
    extractText,
    dryRunImport: (input) => {
      calls.dryRun.push(input);
      if (o.dryRunFails) return Promise.reject(new Error('dry-run threw'));
      if (o.dryRunDeferred) return o.dryRunDeferred.promise;
      return Promise.resolve(o.dryRunResult || { ok: true, decision: 'import-ready', status: 'import-ready',
        packagePath: input.packagePath, mutated: false, reason: '' });
    },
    executeImport: (input) => {
      calls.execute.push(input);
      if (o.executeFails) return Promise.reject(new Error('import threw'));
      return Promise.resolve(o.executeResult || { ok: true, status: 'imported', decision: 'import-ready',
        packagePath: input.packagePath, recovered: { chatId: 'recovered_abc' }, reason: '' });
    },
    /* T05: the governed restore seams, stubbed on exactly the shape the real
     * restore module returns — including `ok: true` for already-present, which
     * is what makes the "success is read from the status" proof meaningful. */
    dryRunRestore: (input) => {
      calls.restoreDryRun.push(input);
      if (o.restoreDryRunFails) return Promise.reject(new Error('restore dry-run threw'));
      if (o.restoreDryRunDeferred) return o.restoreDryRunDeferred.promise;
      return Promise.resolve(o.restoreDryRunResult || { ok: true, decision: 'restore-ready', status: 'restore-ready',
        packagePath: input.packagePath, mode: 'restore-original-ids', mutated: false, reason: '' });
    },
    executeRestore: (input) => {
      calls.restoreExecute.push(input);
      if (o.restoreExecuteFails) return Promise.reject(new Error('restore threw'));
      if (o.restoreExecuteDeferred) return o.restoreExecuteDeferred.promise;
      return Promise.resolve(o.restoreExecuteResult || { ok: true, status: 'restored', decision: 'restore-ready',
        packagePath: input.packagePath, mode: 'restore-original-ids',
        restored: { chatId: 'chat_a', snapshotId: 's1', turnCount: 4 }, reason: '' });
    },
  }, o.options || {}));
  return { api, ingestion, document, container, card, calls, buildTurns, extractText };
}

console.log('── Saved Chat Recovery Center validator (T02) ─────────────────');

/* ── Property 1 — one trusted read per open/refresh, never per row ───────── */
await checkAsync('1. the trusted archive is read ONCE per open and ONCE per refresh, never per row', async () => {
  const h = harness();
  await h.card.load();
  assert.equal(h.calls.integrity, 1, 'open did not read the trusted archive exactly once');
  await h.card.selectChat('chat_a');
  const rows = nodesWithAttr(h.container, 'data-h2o-row', 'recovery-center-version');
  assert.ok(rows.length >= 4, `expected the chat's rows to render, saw ${rows.length}`);
  assert.equal(h.calls.integrity, 1, `rendering ${rows.length} rows triggered ${h.calls.integrity - 1} extra trusted reads (N+1)`);
  assert.equal(h.calls.coverage, 1, 'coverage was called more than once for one chat selection');
  await h.card.load();
  assert.equal(h.calls.integrity, 2, 'refresh did not re-read the trusted archive');

  /* Selecting a version adds exactly ONE further trusted read — the fresh
   * enumeration that supplies the member anchors the preview is bound to. It is
   * per SELECTION, never per row. */
  await h.card.selectChat('chat_a');
  const beforeSelect = h.calls.integrity;
  await h.card.selectVersion('archive/packages/chat_a.g1.h2ochat');
  assert.equal(h.calls.integrity, beforeSelect + 1,
    `version selection performed ${h.calls.integrity - beforeSelect} trusted reads, expected exactly 1`);
});

/* ── Property 2 — the canonical partition is the only one ────────────────── */
check('2. reserved infrastructure and non-package strays never become chats or rows', () => {
  const h = harness();
  const index = h.api.buildChatIndex(partitionOccupants(envelope().occupants).packageOccupants);
  const labels = index.map((c) => c.label);
  assert.ok(!labels.some((l) => /quarantine|notes\.txt/.test(l)),
    'a reserved or stray occupant reached the chat index: ' + labels.join(', '));
  sameList(index.filter((c) => c.attributed).map((c) => c.chatId), ['chat_a', 'chat_b']);
});

check('2b. the module contains no second occupant partition', () => {
  assert.ok(!/reserved-infrastructure|not-a-package-name|verified-generation|legacy-package/.test(uiCode),
    'the surface re-implements trusted class handling instead of using partitionOccupants');
});

/* ── Property 3 — coverage order is consumed, never recomputed ───────────── */
check('3. the module holds no ordering authority: no comparator, no sort, no clock', () => {
  for (const token of ['.sort(', 'localeCompare', 'mtime', 'generatedAt', 'Date.now', 'new Date', 'getTime(']) {
    assert.ok(!uiCode.includes(token), `ordering/timestamp authority found in code: ${token}`);
  }
});

await checkAsync('3b. rows appear in COVERAGE order, not in any order this surface chose', async () => {
  const h = harness();
  await h.card.load();
  await h.card.selectChat('chat_a');
  const sections = h.card.getState().sections;
  const current = sections.find((s) => s.key === 'current');
  const historical = sections.find((s) => s.key === 'historical');
  sameList(current.rows.map((r) => r.packageDirName), ['chat_a.g1.h2ochat']);
  // coverage handed stale as [g2, g3]; the surface must not reorder it.
  sameList(historical.rows.map((r) => r.packageDirName), ['chat_a.g2.h2ochat', 'chat_a.g3.h2ochat']);
});

check('3c. NEGATIVE CONTROL — a scrambled coverage order is carried through unchanged', () => {
  const h = harness();
  const scrambled = coverageA();
  scrambled.stale = [scrambled.stale[1], scrambled.stale[0]];
  const sections = h.api.buildTimelineSections(scrambled, h.ingestion.savedChatArchivePresentationV1.entryPresentation);
  const historical = sections.find((s) => s.key === 'historical');
  sameList(historical.rows.map((r) => r.packageDirName), ['chat_a.g3.h2ochat', 'chat_a.g2.h2ochat'],
    'the surface re-sorted coverage output instead of consuming it');
});

/* ── Property 4 — one inspection per version selection ───────────────────── */
await checkAsync('4. the package inspector runs for the SELECTED version only', async () => {
  const h = harness();
  await h.card.load();
  await h.card.selectChat('chat_a');
  assert.equal(h.calls.inspect, 0, 'rendering rows already inspected packages');
  await h.card.selectVersion('archive/packages/chat_a.g2.h2ochat');
  assert.equal(h.calls.inspect, 1);
  sameList(h.calls.inspectPaths, ['archive/packages/chat_a.g2.h2ochat']);
});

/* ── Property 5 — an incomplete scan is stated, never read as absence ────── */
await checkAsync('5. `complete === false` is visibly communicated in the Archive Health wording', async () => {
  const h = harness({ envelope: envelope({ complete: false }) });
  await h.card.load();
  const text = allText(h.container);
  assert.ok(text.includes('Partial scan'), 'the Partial scan pill is missing');
  assert.ok(text.includes('Archive discovery was incomplete.'), 'the incomplete headline is missing');
  assert.ok(text.includes('absence cannot be concluded'), 'the absence caveat is missing');
});

await checkAsync('5b. NEGATIVE CONTROL — a complete scan does not show the partial-scan warning', async () => {
  const h = harness();
  await h.card.load();
  const text = allText(h.container);
  assert.ok(!text.includes('Partial scan'), 'a complete scan was labelled a partial scan');
});

await checkAsync('5c. a missing `complete` flag is treated as incomplete, never assumed complete', async () => {
  const h = harness({ envelope: { schema: 'x', occupants: [], blockers: [] } });
  await h.card.load();
  assert.equal(h.card.getState().complete, false, 'an unstated scan state was assumed complete');
  assert.ok(allText(h.container).includes('Partial scan'),
    'an unstated scan state was presented without the partial-scan warning');
});

/* ── Property 6 — freshness is never asserted without an authority ───────── */
await checkAsync('6. when coverage cannot assert freshness, no row is labelled current or historical', async () => {
  const h = harness({
    coverageFor: () => coverageA({
      projection: { status: 'db-unavailable', contentHash: '' },
      covered: null, fresh: [], stale: [], selected: null,
    }),
  });
  await h.card.load();
  await h.card.selectChat('chat_a');
  const keys = h.card.getState().sections.map((s) => s.key);
  assert.ok(!keys.includes('current') && !keys.includes('historical'),
    'the surface asserted freshness the coverage authority refused to assert: ' + keys.join(', '));
  assert.ok(keys.includes('preserved-generations'), 'preserved versions were hidden instead of shown');
  const text = allText(h.container);
  assert.ok(text.includes('not marked current or historical'), 'the operator was not told freshness is unasserted');
});

/* ── Property 7 — damaged packages are visible AND non-selectable ────────── */
await checkAsync('7. an unusable occupant is shown, and cannot be selected', async () => {
  const h = harness();
  await h.card.load();
  await h.card.selectChat('chat_a');
  const unusable = h.card.getState().sections.find((s) => s.key === 'unusable');
  assert.ok(unusable && unusable.rows.length === 1, 'the damaged package was hidden — absence would be implied');
  assert.equal(unusable.rows[0].selectable, false, 'a damaged package was selectable');
  const nonSelectable = nodesWithAttr(h.container, 'data-h2o-selectable', '0');
  assert.equal(nonSelectable.length, 1, 'the damaged row is not rendered as non-selectable');
  assert.notEqual(nonSelectable[0].tagName, 'BUTTON', 'a non-selectable row was still rendered as a button');
  await h.card.selectVersion('archive/packages/chat_a.g4.h2ochat');
  assert.equal(h.calls.inspect, 0, 'selecting a damaged package was allowed through');
  assert.equal(h.card.getState().selectedPackagePath, '');
  // The trusted CLASS is what makes it non-selectable — not its section. A
  // damaged package offered in a selectable section must still be refused.
  const present = h.ingestion.savedChatArchivePresentationV1.entryPresentation;
  const cov = coverageA();
  cov.fresh = [covEntry(OCC.aBad)];
  const smuggled = h.api.buildTimelineSections(cov, present)
    .find((s2) => s2.key === 'current').rows[0];
  assert.equal(smuggled.kind, 'unusable', 'fixture no longer models a damaged package');
  assert.equal(smuggled.selectable, false,
    'a damaged package became selectable merely by appearing in a selectable section');
});

/* Coverage's `unusable` population is NOT limited to entries whose trusted
 * class is unusable: a generation that verified as a class but carries no
 * recomputed identity (blocked status, empty contentHash) lands there too. So
 * the section-level gate has to hold on its own — the trusted-class gate alone
 * would let exactly that row through. */
await checkAsync('7c. an unusable-population row is non-selectable even with a valid class', async () => {
  const h = harness();
  const present = h.ingestion.savedChatArchivePresentationV1.entryPresentation;
  const cov = coverageA();
  cov.unusable = [covEntry(OCC.aCur, { status: 'blocked', contentHash: '' })];
  const row = h.api.buildTimelineSections(cov, present)
    .find((s2) => s2.key === 'unusable').rows[0];
  assert.equal(row.kind, 'generation', 'fixture no longer models a classed-but-unusable entry');
  assert.equal(row.selectable, false,
    'a row coverage placed in `unusable` was selectable because its class looked valid');
});

check('7b. no universal recovery-eligibility bit is published', () => {
  assert.ok(!/recoverable/i.test(uiCode), 'the surface publishes a recovery-eligibility claim it has no authority for');
  assert.ok(!/\brestorable\b|\bcanRecover\b|\beligible\b/i.test(uiCode), 'an eligibility claim leaked into the row model');
});

/* ── Property 8 — selection identity is the trusted, scoped path ─────────── */
await checkAsync('8. only a trusted, archive-scoped path can become a selection target', async () => {
  const h = harness();
  await h.card.load();
  await h.card.selectChat('chat_a');
  for (const hostile of [
    '/etc/passwd',
    '/Users/someone/Library/Application Support/archive/packages/x.h2ochat',
    'archive/packages/../../../etc/passwd',
    'archive/packages/chat_a.g1.h2ochat/../../evil.h2ochat',
    '../archive/packages/chat_a.g1.h2ochat',
    'archive/packages/chat_a.g9.h2ochat',
    '',
  ]) {
    await h.card.selectVersion(hostile);
    assert.equal(h.calls.inspect, 0, `an out-of-scope selector reached the inspector: ${hostile}`);
    assert.equal(h.card.getState().selectedPackagePath, '', `an out-of-scope selector was retained: ${hostile}`);
  }
  await h.card.selectVersion('archive/packages/chat_a.g1.h2ochat');
  assert.equal(h.calls.inspect, 1, 'the legitimate trusted path was refused');
});

await checkAsync('8a. an out-of-scope path on a TRUSTED-VALID row is still non-selectable', async () => {
  const h = harness();
  const present = h.ingestion.savedChatArchivePresentationV1.entryPresentation;
  for (const hostile of [
    '/Users/someone/Library/Application Support/archive/packages/x.h2ochat',
    'archive/packages/../../../etc/passwd.h2ochat',
    'somewhere/else/chat_a.g1.h2ochat',
    'archive/packages/',
    'archive/packagesX/chat_a.g1.h2ochat',
    'C:\\archive\\packages\\chat_a.g1.h2ochat',
  ]) {
    const cov = coverageA();
    cov.fresh = [covEntry(OCC.aCur, { packagePath: hostile, packageDirName: hostile.split('/').pop() })];
    const sections = h.api.buildTimelineSections(cov, present);
    const row = sections.find((s2) => s2.key === 'current').rows[0];
    assert.equal(row.kind, 'generation', 'fixture no longer models a trusted-valid row');
    assert.equal(row.selectable, false, `an out-of-scope path stayed selectable: ${hostile}`);
  }
  /* The hostile paths above are each refused by the guard's PREFIX or
   * FORWARD-SLASH condition, so none of them reaches its traversal/backslash
   * clause — deleting that clause outright leaves every one of them rejected,
   * and the assertion above stays green over a real hole.
   *
   * These selectors are shaped to land on that clause and nothing else: each
   * carries the exact package-root prefix, a non-empty leaf, and no forward
   * slash in the leaf, so the surrounding conditions all pass and only the
   * traversal/backslash rejection can refuse them. The preconditions are
   * asserted rather than assumed, so a later edit cannot quietly make these
   * fixtures vacuous again. */
  const PREFIX = 'archive/packages/';
  for (const { selector, isolates } of [
    // Leaf is exactly "..": no backslash, so ONLY the traversal condition can
    // reject it. Without that condition the archive root's own parent becomes
    // a selectable target.
    { selector: 'archive/packages/..', isolates: 'traversal' },
    // Leaf carries backslashes and no "..": ONLY the backslash condition can
    // reject it, so removing that half alone is caught here.
    { selector: 'archive/packages/a\\b', isolates: 'backslash' },
    // Both together — a Windows-style escape out of the package root.
    { selector: 'archive/packages/a\\..\\b', isolates: 'traversal + backslash' },
  ]) {
    const leaf = selector.slice(PREFIX.length);
    // Condition C: prove the case actually reaches the intended clause.
    assert.ok(selector.startsWith(PREFIX), `${selector} would be refused by the prefix condition`);
    assert.ok(leaf.length > 0, `${selector} would be refused by the empty-leaf condition`);
    assert.ok(!leaf.includes('/'), `${selector} would be refused by the forward-slash condition`);

    const cov = coverageA();
    cov.fresh = [covEntry(OCC.aCur, { packagePath: selector, packageDirName: leaf })];
    const sections = h.api.buildTimelineSections(cov, present);
    const row = sections.find((s2) => s2.key === 'current').rows[0];
    assert.equal(row.kind, 'generation', 'fixture no longer models a trusted-valid row');
    assert.equal(row.selectable, false,
      `the ${isolates} guard did not reject a selectable target: ${selector}`);
  }

  // Control: the same row with its real trusted path IS selectable.
  const ok = coverageA();
  const sections = h.api.buildTimelineSections(ok, present);
  assert.equal(sections.find((s2) => s2.key === 'current').rows[0].selectable, true,
    'the scope guard rejected a legitimate trusted path');
});

check('8c. the surface holds no package-name grammar', () => {
  assert.ok(!uiCode.includes('.h2ochat'),
    'the package extension vocabulary leaked into a surface that is not a sanctioned owner of it');
});

check('8b. no hash is fabricated, derived or re-implemented in this surface', () => {
  for (const token of ['sha256(', 'createHash', 'subtle.digest', 'canonicalJson', 'contentHashV3', "'sha256-' +", 'sha256Prefixed']) {
    assert.ok(!uiCode.includes(token), `hash derivation found in code: ${token}`);
  }
});

/* ── Property 9 — no verification, discovery or mutation authority ───────── */
check('9. the surface holds no verification, filesystem or mutation authority', () => {
  for (const token of [
    'invoke(', '__TAURI__.invoke', 'readDir', 'readTextFile', 'writeTextFile', 'removeFile', 'remove(',
    'snapshots.create', 'upsert', 'DELETE ', 'INSERT ', 'UPDATE ',
    'h2o_archive_reclamation_preview', 'h2o_archive_reclamation_execute', 'h2o_archive_occupant_quarantine',
  ]) {
    assert.ok(!uiCode.includes(token), `forbidden capability found in code: ${token}`);
  }
});

check('9b. the reclamation preview is not a source for this surface', () => {
  assert.ok(!uiCode.includes('reclamation'), 'the surface reaches into the reclamation authority');
});

check('9c. no recovery, import, restore, relink or confirmation control exists', () => {
  /* The importer NAMESPACE is legitimately referenced for exactly one thing —
   * its PURE `buildTurnsFromPackageSnapshot` mapper, which owns the v3
   * typed-parts vs v1/v2 scalar-text distinction. Banning the bare namespace
   * would forbid that reuse and push this surface into re-implementing the
   * mapping, so the ban targets the mutation ENTRY POINTS instead, and the
   * next check pins the namespace to that single pure symbol. */
  /* T04 wires Recover-as-New through the governed importer and T05 wires
   * Restore-Original-Identity through the governed restore module, so those four
   * entry points are no longer banned here — they are pinned instead, by the two
   * symbol checks below and by the caller allowlists in the restore/relink and
   * recovery-import-export invariants. Everything else stays banned: the ZIP
   * entry points, the ENTIRE relink family, every restore-current / overwrite /
   * force / override variant, and every native confirmation dialog. */
  for (const token of [
    'confirm(', 'archiveExporter', 'archiveRelink',
    'importVerifiedZip', 'dryRunImportZip',
    'relinkVerifiedPackage', 'dryRunRelinkPackage',
    'importPackage', 'restorePackage', 'restore-current', 'overwrite-existing',
    'forceRestore', 'force-restore', 'overrideRestore', 'override-restore',
    'tombstoneOverride', 'unDelete', 'undeleteChat',
    'restoreCurrent', 'overwriteExisting', 'mergeInto', 'relinkTo',
  ]) {
    assert.ok(!uiCode.includes(token), `an out-of-boundary control leaked in: ${token}`);
  }
});

check('9c-pin. the importer namespace is pinned to exactly three admitted symbols', () => {
  /* One pure mapper (T03) and the two governed T04 entry points. A fourth symbol
   * would be new reach into the importer whatever it is named, so the set is
   * pinned by size as well as by membership. */
  const ADMITTED = new Set(['buildTurnsFromPackageSnapshot', 'dryRunImportPackage', 'importVerifiedPackage']);
  const refs = uiCode.match(/archiveImporter\s*\)?\s*\.\s*([A-Za-z0-9_$]+)/g) || [];
  const symbols = new Set(refs.map((r) => r.split('.').pop().trim()));
  assert.equal(ADMITTED.size, 3, 'the admitted importer symbol set changed size');
  for (const sym of ADMITTED) {
    assert.ok(uiCode.includes(sym), `an admitted importer symbol is not actually used: ${sym}`);
  }
  for (const sym of symbols) {
    assert.ok(ADMITTED.has(sym), `a non-admitted importer symbol is referenced: archiveImporter.${sym}`);
  }
});

check('9c-pin-restore. the restore namespace is pinned to exactly two admitted symbols', () => {
  /* T05 composes exactly the governed dry-run and the governed execution. A
   * third symbol would be new reach into the restore module whatever it is
   * named — a relink helper, an internal SQL helper, a direct writer, a
   * restore-current or overwrite variant — so the set is pinned by size as well
   * as by membership, and both members must actually be used. */
  const ADMITTED = new Set(['dryRunRestorePackage', 'restoreVerifiedPackage']);
  const refs = uiCode.match(/archiveRestore\s*\)?\s*\.\s*([A-Za-z0-9_$]+)/g) || [];
  const symbols = new Set(refs.map((r) => r.split('.').pop().trim()));
  assert.equal(ADMITTED.size, 2, 'the admitted restore symbol set changed size');
  assert.ok(symbols.size > 0, 'no restore symbol is referenced at all — the pin would pass vacuously');
  for (const sym of ADMITTED) {
    assert.ok(uiCode.includes(sym), `an admitted restore symbol is not actually used: ${sym}`);
  }
  for (const sym of symbols) {
    assert.ok(ADMITTED.has(sym), `a non-admitted restore symbol is referenced: archiveRestore.${sym}`);
  }
});

await checkAsync('9d. only Refresh and version-selection controls are rendered', async () => {
  const h = harness();
  await h.card.load();
  await h.card.selectChat('chat_a');
  const actions = nodesWithAttr(h.container, 'data-h2o-action').map((n) => n.attributes['data-h2o-action']);
  assert.ok(actions.length > 1, 'no controls rendered at all — the check would pass vacuously');
  /* Exactly the T02 refresh, the T02/T03 version selector, the two T04 steps and
   * the two T05 steps. Nothing else, and no disabled placeholder for anything
   * else. */
  const allowed = new Set([
    'recovery-center-refresh',
    'recovery-center-select-version',
    'recovery-center-prepare-recover-as-new',
    'recovery-center-recover-as-new',
    'recovery-center-prepare-restore-original',
    'recovery-center-restore-original',
  ]);
  for (const a of actions) assert.ok(allowed.has(a), `an unexpected control is present: ${a}`);
  assert.equal(allowed.size, 6, 'the rendered-action allowlist changed size');
  /* Destructive or out-of-boundary alternatives remain absent from the SOURCE,
   * so not even a disabled placeholder can exist. */
  for (const banned of [
    'recovery-center-relink', 'recovery-center-restore-current',
    'recovery-center-overwrite', 'recovery-center-overwrite-existing',
    'recovery-center-force-restore', 'recovery-center-override-restore',
    'recovery-center-tombstone-override', 'recovery-center-un-delete',
    'recovery-center-merge-into', 'recovery-center-force', 'recovery-center-override',
  ]) {
    assert.ok(!uiCode.includes(banned), `an out-of-boundary control leaked in: ${banned}`);
  }
});

await checkAsync('9d-t05. both T05 controls are rendered only after a preview, and never before', async () => {
  /* The prepare control must exist once a version is readable, and the
   * confirming control must not — that pairing is what makes the allowlist above
   * non-vacuous for T05. */
  const h = harness();
  await h.card.load();
  await h.card.selectChat('chat_a');
  assert.equal(nodesWithAttr(h.container, 'data-h2o-action', 'recovery-center-prepare-restore-original').length, 0,
    'the T05 prepare control exists before any version was previewed');
  await previewed(h);
  assert.equal(nodesWithAttr(h.container, 'data-h2o-action', 'recovery-center-prepare-restore-original').length, 1,
    'the T05 prepare control is missing after a readable preview');
  assert.equal(nodesWithAttr(h.container, 'data-h2o-action', 'recovery-center-restore-original').length, 0,
    'the T05 mutation control exists before any approval');
});

/* ── G01 topology: one governed mutation request, nothing beneath it ────── */
check('9e. the ONLY mutation-capable call is the governed importer execution', () => {
  /* Direct writer primitives stay categorically absent — the symbol pin above
   * proves what is reached, and this proves nothing is reached around it. */
  for (const token of [
    'plugin:sql', 'INSERT ', 'UPDATE ', 'DELETE ', 'execute(', 'snapshots.create', 'chats.upsert', 'upsert(',
    'plugin:fs', 'writeTextFile', 'writeFile', 'removeFile', 'remove(', 'mkdir',
    'invoke(', '__TAURI__.invoke',
    'h2o_archive_reclamation_execute', 'h2o_archive_occupant_quarantine', 'h2o_archive_generation_publish',
    'putAssetBytes', 'deleteAsset', 'publishGeneration',
  ]) {
    assert.ok(!uiCode.includes(token), `a direct mutation primitive leaked in: ${token}`);
  }
  /* Exactly two execution entry points, and both are governed: the importer's
   * and the restore module's. Nothing is reached around or beneath them. */
  const execRefs = (uiCode.match(/importVerifiedPackage/g) || []).length;
  assert.ok(execRefs >= 1, 'the governed importer execution is not wired');
  assert.ok(uiCode.includes('dryRunImportPackage'), 'the governed non-mutating dry-run is not wired');
  assert.ok(uiCode.includes('restoreVerifiedPackage'), 'the governed restore execution is not wired');
  assert.ok(uiCode.includes('dryRunRestorePackage'), 'the governed non-mutating restore dry-run is not wired');
  /* The execution call sites pass only the address, the module's own mode, and —
   * for restore — the module's own confirmation. */
  assert.ok(/executeImport\(\{ packagePath: path, mode: IMPORT_MODE \}\)/.test(uiCode),
    'the import execution call does not use the minimal { packagePath, mode } contract');
  assert.ok(/executeRestore\(\{ packagePath: path, mode: RESTORE_MODE, confirm: true \}\)/.test(uiCode),
    'the restore execution call does not use the minimal { packagePath, mode, confirm } contract');
  /* The restore mode is the restore module's own, stated as a literal constant
   * so no other mode can be requested. */
  assert.ok(/var RESTORE_MODE = 'restore-original-ids';/.test(uiCode),
    'the restore mode is not pinned to the restore module\'s own value');
  /* Success is read from the STATUS, never from `ok` — the restore module
   * reports ok === true for already-present too. */
  assert.ok(!/restored\.ok === true/.test(uiCode) && !/restoreResult\.ok/.test(uiCode),
    'the restore outcome is read from ok rather than from the authoritative status');
  assert.ok(/dryRunImport\(\{ packagePath: path \}\)/.test(uiCode),
    'the dry-run call does not use the minimal { packagePath } contract');
});

/* ── Property 10 — refresh invalidates a stale selection ─────────────────── */
await checkAsync('10. a refresh that drops a chat clears the stale chat AND version selection', async () => {
  let env = envelope();
  const h = harness({ options: { readIntegrity: () => Promise.resolve(env) } });
  await h.card.load();
  await h.card.selectChat('chat_a');
  await h.card.selectVersion('archive/packages/chat_a.g1.h2ochat');
  assert.equal(h.card.getState().selectedChatId, 'chat_a');
  assert.equal(h.card.getState().selectedPackagePath, 'archive/packages/chat_a.g1.h2ochat');

  env = envelope({ occupants: [OCC.bLegacy] });   // chat_a is gone
  await h.card.load();
  const s = h.card.getState();
  assert.equal(s.selectedChatId, '', 'a chat that no longer exists stayed selected');
  assert.equal(s.selectedPackagePath, '', 'a version of a vanished chat stayed selected');
  assert.equal(s.sections.length, 0, 'a vanished chat left its rows on screen');
  assert.equal(s.inspection, null, 'a stale inspection survived the refresh');
});

await checkAsync('10b. changing chat clears the previous chat version selection', async () => {
  const h = harness();
  await h.card.load();
  await h.card.selectChat('chat_a');
  await h.card.selectVersion('archive/packages/chat_a.g1.h2ochat');
  await h.card.selectChat('chat_b');
  const s = h.card.getState();
  assert.equal(s.selectedPackagePath, '', 'a version selection survived a chat change');
  assert.equal(s.inspection, null, 'an inspection from the previous chat survived a chat change');
});

/* ── Property 11 — remount is neutral, and the surface is registered ─────── */
await checkAsync('11. remounting yields exactly one card and one set of controls', async () => {
  const document = domStub();
  const { api } = loadUi(document);
  const parent = document.createElement('div');
  const health = document.createElement('div');
  parent.appendChild(health);
  const opts = { capable: true, autoLoad: false, readIntegrity: () => Promise.resolve(envelope()), partitionOccupants };

  api.mountRecoveryCenterCard(health, opts);
  api.mountRecoveryCenterCard(health, opts);
  api.mountRecoveryCenterCard(health, opts);

  const mounts = nodesWithAttr(parent, 'data-h2o-recovery-center-mount', '1');
  assert.equal(mounts.length, 1, `remounting created ${mounts.length} mount points`);
  const cards = nodesWithAttr(parent, 'data-h2o-card', 'saved-chat-recovery-center');
  assert.equal(cards.length, 1, `remounting left ${cards.length} cards behind`);
  const refreshes = nodesWithAttr(parent, 'data-h2o-action', 'recovery-center-refresh');
  assert.equal(refreshes.length, 1, `remounting left ${refreshes.length} refresh controls behind`);
});

check('11b. the surface degrades to a Desktop-only message instead of crashing', () => {
  const document = domStub();
  const { api } = loadUi(document);
  const container = document.createElement('div');
  const card = api.renderRecoveryCenterCard(container, { capable: false });
  assert.ok(card, 'the card returned null instead of degrading');
  assert.ok(allText(container).includes('Desktop Studio only'), 'no Desktop-only message was shown');
});

check('11c. the module is registered in studio.html and in both pack lists', () => {
  const leaf = 'saved-chat-recovery-center-ui.studio.js';
  assert.ok(readRepo(HTML_REL).includes(`./ingestion/${leaf}`), 'not registered in studio.html');
  const pack = readRepo(PACK_REL);
  const occurrences = pack.split(`"ingestion/${leaf}"`).length - 1;
  assert.equal(occurrences, 2, `expected 2 pack-list registrations, found ${occurrences}`);
  assert.ok(readRepo(HEALTH_UI_REL).includes('mountRecoveryCenterCard'), 'the health card never mounts it');
});

/* ── Runtime shape: the whole surface end to end ─────────────────────────── */
await checkAsync('12. end to end: two chats, an ordered timeline, statuses and a selection', async () => {
  const h = harness();
  await h.card.load();
  const chats = h.card.getState().chats;
  sameList(chats.filter((c) => c.attributed).map((c) => c.chatId), ['chat_a', 'chat_b']);
  assert.equal(chats.find((c) => c.chatId === 'chat_a').packageCount, 4);

  await h.card.selectChat('chat_a');
  const text = allText(h.container);
  assert.ok(text.includes('Current'), 'no Current section rendered');
  assert.ok(text.includes('Earlier versions'), 'no historical section rendered');
  assert.ok(text.includes('Damaged or unreadable'), 'no damaged section rendered');
  assert.ok(text.includes('Immutable generation'), 'the trusted kind label is missing');
  assert.ok(text.includes('generation-v3-gzip-decode-failed'), 'the blocker code was hidden from the operator');

  const rows = h.card.getState().sections.flatMap((s) => s.rows);
  assert.equal(rows.filter((r) => r.isCurrent).length, 1, 'exactly one row should be current');
  assert.equal(rows.find((r) => r.isCurrent).packageDirName, 'chat_a.g1.h2ochat');

  await h.card.selectVersion('archive/packages/chat_a.g1.h2ochat');
  const detail = allText(h.container);
  assert.ok(detail.includes('Version detail'), 'the detail panel is missing');
  assert.ok(detail.includes('verified'), 'the inspected status is missing');
  assert.ok(detail.includes('sha256-' + HASH_CUR), 'the verified contentHash is missing');
  const selectedNodes = nodesWithAttr(h.container, 'data-h2o-selected', '1');
  assert.equal(selectedNodes.length, 1, 'the selected row is not marked exactly once');
});


/* ══ T03 — read-only version preview ═══════════════════════════════════════
 *
 * The preview is the first path that turns archived bytes into something an
 * operator reads, so the properties worth proving are: it never opens content
 * the FRESH trusted verdict did not authorize, it never renders archived markup
 * as markup, it always goes through the governed codec seam, and a slow answer
 * for an abandoned selection can never appear under a newer one. */

async function selectVerifiedVersion(h, path = 'archive/packages/chat_a.g1.h2ochat') {
  await h.card.load();
  await h.card.selectChat('chat_a');
  await h.card.selectVersion(path);
  return h.card.getState();
}

await checkAsync('13. preview opens ONLY after a fresh trusted re-inspection', async () => {
  const h = harness();
  await h.card.load();
  await h.card.selectChat('chat_a');
  assert.equal(h.calls.inspect, 0, 'listing a chat already inspected a package');
  assert.equal(h.calls.codec.length, 0, 'listing a chat already read package bytes');
  await h.card.selectVersion('archive/packages/chat_a.g1.h2ochat');
  assert.equal(h.calls.inspect, 1, 'the selected version was not re-inspected');
  assert.ok(h.calls.codec.length > 0, 'no governed codec read happened for a verified version');
  assert.equal(h.card.getState().previewPhase, 'ready');
});

await checkAsync('13b. a version the fresh verdict does NOT accept yields no content read', async () => {
  const h = harness({
    inspectFor: (packagePath) => Promise.resolve({
      ok: false, status: 'hash-mismatch', packagePath,
      identity: { contentHash: '' }, checks: {}, blockers: ['generation-content-hash-mismatch'], error: null,
    }),
  });
  const s2 = await selectVerifiedVersion(h);
  assert.equal(s2.previewPhase, 'refused', `expected refused, got ${s2.previewPhase}`);
  assert.equal(s2.preview, null, 'refused content was still built');
  assert.equal(h.calls.codec.length, 0, 'package bytes were read for a version trusted verification refused');
});

await checkAsync('14. an unusable row can neither be inspected nor previewed', async () => {
  const h = harness();
  await h.card.load();
  await h.card.selectChat('chat_a');
  await h.card.selectVersion('archive/packages/chat_a.g4.h2ochat');   // the damaged occupant
  assert.equal(h.calls.inspect, 0, 'a damaged package reached the inspector');
  assert.equal(h.calls.codec.length, 0, 'a damaged package reached the byte reader');
  assert.equal(h.card.getState().previewPhase, 'idle');
  assert.equal(h.card.getState().preview, null);
});

await checkAsync('15. an identity mismatch refuses the preview BEFORE reading any content', async () => {
  const h = harness({
    inspectFor: (packagePath) => Promise.resolve({
      ok: true, status: 'verified', packagePath,
      /* The address still resolves, but to a different generation. */
      identity: { contentHash: 'sha256-' + HASH_OLD, schemaVersion: 3 },
      checks: {}, blockers: [], error: null,
    }),
  });
  const s2 = await selectVerifiedVersion(h);
  assert.equal(s2.previewPhase, 'stale', `expected stale, got ${s2.previewPhase}`);
  assert.equal(s2.preview, null, 'content was built for a package whose identity changed');
  assert.equal(h.calls.codec.length, 0, 'bytes were read from a package with a mismatched identity');
});

await checkAsync('16. the TRUSTED family decides the read path, and no manifest is consulted', async () => {
  const v3 = harness();
  await selectVerifiedVersion(v3);
  const verified = v3.calls.codec.filter((c) => c.fn === 'readVerifiedPackageMember');
  assert.equal(verified.length, 1, 'the v3 governed verified-member read was not used');
  assert.equal(verified[0].expectedPath, 'snapshot.json');
  /* Every descriptor field comes from the trusted occupant, not from the package. */
  const a = anchors('1', 'v3', 'gzip');
  assert.equal(verified[0].descriptor.sha256, a.snapshotPhysicalSha256, 'physical digest was not the trusted one');
  assert.equal(verified[0].descriptor.byteLength, a.snapshotPhysicalByteLength);
  assert.equal(verified[0].descriptor.encoding, a.snapshotEncoding);
  assert.equal(verified[0].descriptor.contentSha256, a.logicalSnapshotSha256, 'logical digest was not the trusted one');
  assert.equal(verified[0].descriptor.contentByteLength, a.logicalSnapshotByteLength);
  assert.equal(v3.calls.codec.filter((c) => c.memberPath === 'manifest.json').length, 0,
    'the manifest is still in the trust chain');

  const v1 = harness({ disk: { snapshot: V1_SNAPSHOT, ...anchors('4', 'v1', 'identity') } });
  await v1.card.load();
  await v1.card.selectChat('chat_b');
  await v1.card.selectVersion('archive/packages/chat_b.legacy.h2ochat');
  const s1 = v1.card.getState();
  assert.equal(v1.calls.codec.filter((c) => c.fn === 'readVerifiedPackageMember').length, 0,
    'a v1 package was pushed through the v3 verified-member path');
  assert.ok(v1.calls.codec.some((c) => c.fn === 'readBoundedPackageMemberBytes' && c.memberPath === 'snapshot.json'),
    'the v1 snapshot was not read through the governed bounded reader');
  assert.equal(s1.previewPhase, 'ready', `expected ready, got ${s1.previewPhase}`);
  assert.equal(s1.preview.messages[0].text, 'legacy scalar body', 'the v1 scalar body was not mapped');
});

await checkAsync('17. every governed read carries a finite physical cap', async () => {
  const h = harness();
  await selectVerifiedVersion(h);
  assert.ok(h.calls.codec.length > 0, 'no reads to inspect');
  for (const call of h.calls.codec) {
    assert.ok(Number.isFinite(call.physicalByteCap) && call.physicalByteCap > 0,
      `${call.fn} was called without a finite physical cap`);
    if (call.fn === 'readVerifiedPackageMember') {
      assert.ok(Number.isFinite(call.logicalByteCap) && call.logicalByteCap > 0,
        'the verified member read was called without a logical cap');
    }
  }
});

check('17b. the surface owns no filesystem read of its own', () => {
  for (const token of ['plugin:fs', 'read_file', 'lstat', 'readDir', 'readTextFile', 'BaseDirectory', 'baseDir']) {
    assert.ok(!uiCode.includes(token), `a direct filesystem access leaked in: ${token}`);
  }
});

await checkAsync('18. archived HTML is reduced to TEXT by the existing sanitizer, never rendered', async () => {
  const h = harness({ codecOptions: { manifest: V3_MANIFEST, snapshot: V3_SNAPSHOT } });
  const s2 = await selectVerifiedVersion(h);
  const answer = s2.preview.messages[1];
  assert.ok(answer.text.includes('the archived answer'), 'the readable answer text was lost');
  assert.ok(!answer.text.includes('<script'), 'archived script markup survived into the preview');
  assert.ok(!answer.text.includes('onclick'), 'an archived event handler survived into the preview');
  assert.ok(!/<[a-z]/i.test(answer.text), `archived markup survived as markup: ${answer.text}`);
  // And nothing in the rendered DOM was ever produced from markup.
  const rendered = allText(h.container);
  assert.ok(rendered.includes('the archived answer'), 'the preview text never reached the DOM');
  assert.ok(!rendered.includes('steal()'), 'archived script content reached the DOM');
});

check('18b. no markup sink exists in the surface at all', () => {
  for (const token of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'eval(', 'new Function', 'createContextualFragment']) {
    assert.ok(!uiCode.includes(token), `a markup/execution sink leaked in: ${token}`);
  }
});

await checkAsync('19. changing the selected version clears the previous preview', async () => {
  const h = harness();
  await selectVerifiedVersion(h, 'archive/packages/chat_a.g1.h2ochat');
  assert.equal(h.card.getState().previewPhase, 'ready');
  const first = h.card.getState().preview;
  await h.card.selectVersion('archive/packages/chat_a.g2.h2ochat');
  const s2 = h.card.getState();
  assert.equal(s2.selectedPackagePath, 'archive/packages/chat_a.g2.h2ochat');
  assert.notEqual(s2.preview, first, 'the previous version preview object survived the change');
});

await checkAsync('20. changing chat clears the preview entirely', async () => {
  const h = harness();
  await selectVerifiedVersion(h);
  assert.equal(h.card.getState().previewPhase, 'ready');
  await h.card.selectChat('chat_b');
  const s2 = h.card.getState();
  assert.equal(s2.preview, null, 'a preview survived a chat change');
  assert.equal(s2.previewPhase, 'idle');
  assert.equal(s2.selectedPackagePath, '');
});

await checkAsync('21. a late result for an abandoned version cannot overwrite a newer preview', async () => {
  /* The abandoned selection must be allowed to reach its READ before being
   * abandoned — otherwise the token gate upstream ends it early and the late
   * write-back this check exists to catch never becomes possible. So the hang
   * is keyed to the first version's own path, and the selection is given a few
   * microtask turns to arrive there before the second version is chosen. */
  const slow = deferred();
  const doc2 = domStub();
  const loaded = loadUi(doc2);
  const codec = {
    __installed: true,
    LOGICAL_SNAPSHOT_CAP_BYTES: 8 * 1024 * 1024,
    readBoundedPackageMemberBytes() { return Promise.resolve({ storedBytes: enc(V3_MANIFEST) }); },
    readVerifiedPackageMember(input) {
      if (String(input.packagePath).endsWith('chat_a.g1.h2ochat')) return slow.promise;
      return Promise.resolve({ logicalBytes: enc({ ...V3_SNAPSHOT, title: 'SECOND' }) });
    },
  };
  const container2 = doc2.createElement('div');
  const card2 = loaded.api.renderRecoveryCenterCard(container2, {
    capable: true, autoLoad: false,
    readIntegrity: () => Promise.resolve(envelope()),
    partitionOccupants,
    describeCoverage: () => Promise.resolve(coverageA()),
    describeState: loaded.ingestion.describeSavedChatArchiveStateV1,
    entryPresentation: loaded.ingestion.savedChatArchivePresentationV1.entryPresentation,
    /* Each package reverifies to ITS OWN identity, so this check exercises the
     * async ordering rather than accidentally tripping the mismatch guard. */
    inspectPackage: ({ packagePath }) => Promise.resolve({
      ok: true, status: 'verified', packagePath,
      identity: { contentHash: 'sha256-' + identityForPath(packagePath), schemaVersion: 3 },
      checks: {}, blockers: [], error: null,
    }),
    codec, buildTurns: loaded.buildTurns, extractText: loaded.extractText,
  });
  const flush = async () => { for (let i = 0; i < 12; i += 1) await Promise.resolve(); };

  await card2.load();
  await card2.selectChat('chat_a');
  const abandoned = card2.selectVersion('archive/packages/chat_a.g1.h2ochat');
  await flush();
  assert.equal(card2.getState().previewPhase, 'loading', 'the first selection never reached its read');

  await card2.selectVersion('archive/packages/chat_a.g2.h2ochat');
  assert.equal(card2.getState().preview && card2.getState().preview.title, 'SECOND',
    'the newer preview did not land');

  slow.resolve({ logicalBytes: enc({ ...V3_SNAPSHOT, title: 'FIRST-LATE' }) });
  await abandoned;
  await flush();

  const s2 = card2.getState();
  assert.equal(s2.selectedPackagePath, 'archive/packages/chat_a.g2.h2ochat');
  assert.equal(s2.preview && s2.preview.title, 'SECOND',
    `a late result for an abandoned selection replaced the newer preview (${s2.preview && s2.preview.title})`);
  assert.ok(!allText(container2).includes('FIRST-LATE'), 'abandoned content reached the DOM');
});

await checkAsync('22. a refresh that drops the chat clears the preview too', async () => {
  let env = envelope();
  const h = harness({ options: { readIntegrity: () => Promise.resolve(env) } });
  await selectVerifiedVersion(h);
  assert.equal(h.card.getState().previewPhase, 'ready');
  env = envelope({ occupants: [OCC.bLegacy] });
  await h.card.load();
  const s2 = h.card.getState();
  assert.equal(s2.preview, null, 'a preview survived a refresh that dropped its chat');
  assert.equal(s2.previewPhase, 'idle');
});

await checkAsync('23. a decode failure leaves an error state and NO stale content', async () => {
  const h = harness({
    disk: { snapshot: V1_SNAPSHOT, ...anchors('4', 'v1', 'identity') },
    codecOptions: { malformedSnapshot: true },
  });
  await h.card.load();
  await h.card.selectChat('chat_b');
  await h.card.selectVersion('archive/packages/chat_b.legacy.h2ochat');
  const s2 = h.card.getState();
  assert.equal(s2.previewPhase, 'error', `expected error, got ${s2.previewPhase}`);
  assert.equal(s2.preview, null, 'malformed content produced a preview');
  assert.ok(!allText(h.container).includes('legacy scalar body'), 'stale content remained on screen');
});

await checkAsync('23b. a governed read failure surfaces as an error, not as content', async () => {
  const h = harness({ codecOptions: { manifest: V3_MANIFEST, verifiedFails: true } });
  const s2 = await selectVerifiedVersion(h);
  assert.equal(s2.previewPhase, 'error');
  assert.equal(s2.preview, null);
});

await checkAsync('24. without the governed codec there is no preview at all', async () => {
  const h = harness({ noCodec: true });
  const s2 = await selectVerifiedVersion(h);
  assert.equal(s2.previewPhase, 'unsupported', `expected unsupported, got ${s2.previewPhase}`);
  assert.equal(s2.preview, null, 'content appeared without the governed reader');
});

check('25. a long conversation is bounded and the truncation is STATED', () => {
  const document = domStub();
  const { api, buildTurns, extractText } = loadUi(document);
  const many = { schemaVersion: 3, messages: [] };
  for (let i = 0; i < 500; i += 1) {
    many.messages.push({ role: 'user', content: [{ type: 'text', text: 'm' + i }] });
  }
  const preview = api.buildPreviewFromTurns(buildTurns(many), extractText);
  assert.equal(preview.totalMessages, 500);
  assert.ok(preview.shownMessages < 500, 'an unbounded preview was built');
  assert.equal(preview.truncated, true, 'truncation was not stated');
  assert.equal(preview.messages.length, preview.shownMessages);

  const long = { schemaVersion: 3, messages: [{ role: 'user', content: [{ type: 'text', text: 'x'.repeat(50000) }] }] };
  const one = api.buildPreviewFromTurns(buildTurns(long), extractText).messages[0];
  assert.ok(one.text.length < 50000, 'an unbounded message body was built');
  assert.equal(one.textTruncated, true, 'message truncation was not stated');
});

check('26. no preview cache, index or persistence is introduced', () => {
  for (const token of ['localStorage', 'sessionStorage', 'indexedDB', 'previewCache', 'previewIndex', 'new Map(', 'WeakMap']) {
    assert.ok(!uiCode.includes(token), `preview state was persisted or cached: ${token}`);
  }
});

check('27. the preview added no new decoder, hash or verification authority', () => {
  for (const token of ['gzip', 'inflate', 'pako', 'DecompressionStream', 'decodeGzipBounded',
    'verifyPackageMemberBytes', 'sha256PrefixedBytes', 'createHash', 'subtle.digest']) {
    assert.ok(!uiCode.includes(token), `a duplicate decoding/verification authority leaked in: ${token}`);
  }
  // The two governed entry points ARE used.
  assert.ok(uiCode.includes('readBoundedPackageMemberBytes'), 'the governed bounded reader is not used');
  assert.ok(uiCode.includes('readVerifiedPackageMember'), 'the governed verified-member reader is not used');
});


/* ══ T03 identity binding — post-inspection substitution ═══════════════════
 *
 * `packagePath` is an address, not proof. Between the trusted inspection and
 * the byte read, the package at that address can change. These prove the bytes
 * that reach the screen are bound to the state that was actually verified.
 *
 * Package B below is INTERNALLY CONSISTENT: its bytes match its own digests, so
 * a check that merely re-verified B against B's own claims would pass it. */
const PACKAGE_B_SNAPSHOT = {
  schemaVersion: 3, title: 'SUBSTITUTED', capturedAt: '2026-09-01T00:00:00.000Z',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'attacker content' }] }],
};

await checkAsync('28. V1/V2 — bytes substituted after inspection are refused', async () => {
  /* The trusted occupant describes package A ('4'); the disk now holds B ('9'). */
  const h = harness({ disk: { snapshot: PACKAGE_B_SNAPSHOT, ...anchors('9', 'v1', 'identity') } });
  await h.card.load();
  await h.card.selectChat('chat_b');
  await h.card.selectVersion('archive/packages/chat_b.legacy.h2ochat');
  const s2 = h.card.getState();
  assert.notEqual(s2.previewPhase, 'ready', 'substituted v1 bytes were previewed');
  assert.equal(s2.preview, null, 'substituted v1 content was built');
  assert.ok(!allText(h.container).includes('attacker content'), 'substituted content reached the DOM');
});

await checkAsync('29. V1/V2 — a digest mismatch alone is enough to refuse', async () => {
  /* Same byte LENGTH as the trusted anchor, only the digest differs, so the
   * refusal cannot be attributed to the length check. */
  const trusted = anchors('4', 'v1', 'identity');
  const h = harness({
    disk: {
      snapshot: PACKAGE_B_SNAPSHOT,
      ...trusted,
      snapshotPhysicalSha256: 'sha256-' + '9'.repeat(64),
    },
  });
  await h.card.load();
  await h.card.selectChat('chat_b');
  await h.card.selectVersion('archive/packages/chat_b.legacy.h2ochat');
  const s2 = h.card.getState();
  assert.equal(s2.previewPhase, 'error', `expected error, got ${s2.previewPhase}`);
  assert.equal(s2.preview, null);
});

await checkAsync('30. V3 — a self-consistent substituted package is refused', async () => {
  /* B's descriptor and bytes agree with each other. The only thing that can
   * catch it is that the descriptor handed to the codec came from the TRUSTED
   * scan of A, not from B. */
  const h = harness({ disk: { snapshot: PACKAGE_B_SNAPSHOT, ...anchors('9', 'v3', 'gzip') } });
  const s2 = await selectVerifiedVersion(h);
  assert.notEqual(s2.previewPhase, 'ready', 'a substituted v3 package was previewed');
  assert.equal(s2.preview, null, 'substituted v3 content was built');
  assert.ok(!allText(h.container).includes('attacker content'), 'substituted content reached the DOM');
  const verified = h.calls.codec.filter((c) => c.fn === 'readVerifiedPackageMember');
  assert.equal(verified.length, 1, 'the governed verified-member path was skipped');
  assert.equal(verified[0].descriptor.sha256, anchors('1', 'v3', 'gzip').snapshotPhysicalSha256,
    'the descriptor was taken from the substituted package rather than the trusted scan');
});

await checkAsync('31. COPIED-CLAIM — copying the old contentHash claim does not help', async () => {
  /* The decisive negative control. A substituted package copies A's manifest
   * contentHash claim verbatim while carrying its own snapshot descriptor and
   * bytes. A binding built on that single self-reported field would accept it.
   *
   * Here it cannot even be consulted: the manifest is not read at all, and the
   * descriptor comes from the trusted scan of A. */
  const h = harness({
    disk: { snapshot: PACKAGE_B_SNAPSHOT, ...anchors('9', 'v3', 'gzip') },
    codecOptions: { manifest: { schemaVersion: 3, contentHash: 'sha256-' + HASH_CUR,
      files: { snapshot: { path: 'snapshot.json', encoding: 'gzip',
        sha256: 'sha256-' + '9'.repeat(64), byteLength: 157,
        contentSha256: 'sha256-' + '9'.repeat(64), contentByteLength: 257 } } } },
  });
  const s2 = await selectVerifiedVersion(h);
  assert.notEqual(s2.previewPhase, 'ready', 'the copied-claim substitution was previewed');
  assert.equal(s2.preview, null);
  assert.ok(!allText(h.container).includes('attacker content'), 'substituted content reached the DOM');
  assert.equal(h.calls.codec.filter((c) => c.memberPath === 'manifest.json').length, 0,
    'the manifest was consulted, so a copied claim is still part of the trust chain');
});

await checkAsync('32. the two trusted reads must agree on the package state', async () => {
  /* The inspection verified one identity; the enumeration reports another for
   * the same address. Neither is trusted over the other — the binding fails. */
  const h = harness({
    inspectFor: (packagePath) => Promise.resolve({
      ok: true, status: 'verified', packagePath,
      identity: { contentHash: 'sha256-' + 'e'.repeat(64), schemaVersion: 3 },
      checks: {}, blockers: [], error: null,
    }),
    coverageFor: () => coverageA({
      fresh: [covEntry(OCC.aCur, { contentHash: 'e'.repeat(64) })],
      stale: [], selected: null,
    }),
  });
  const s2 = await selectVerifiedVersion(h);
  assert.equal(s2.previewPhase, 'stale', `expected stale, got ${s2.previewPhase}`);
  assert.equal(s2.preview, null);
  assert.equal(h.calls.codec.length, 0, 'bytes were read before the two trusted reads agreed');
});

/* Both sides of that binding are TRUSTED output, so an ABSENT identity is a
 * failure to bind rather than an absence of evidence — the opposite of the
 * lenient selected-row comparison, where a missing row identity legitimately
 * asserts nothing. Absence has to fail closed in BOTH directions, and neither
 * direction is protected by the equality case above: an accepting guard makes
 * both of these read bytes and render. */
await checkAsync('32b. an ABSENT inspected identity fails closed', async () => {
  const h = harness({
    /* Verified, but the inspection carries no content identity at all. */
    inspectFor: (packagePath) => Promise.resolve({
      ok: true, status: 'verified', packagePath,
      identity: { contentHash: '', schemaVersion: 3 },
      checks: {}, blockers: [], error: null,
    }),
  });
  const s2 = await selectVerifiedVersion(h);
  assert.notEqual(s2.previewPhase, 'ready',
    'an absent inspected identity was treated as agreement and the preview opened');
  assert.equal(s2.previewPhase, 'stale', `expected stale, got ${s2.previewPhase}`);
  assert.equal(s2.preview, null, 'content was built without a proven inspected identity');
  assert.equal(h.calls.codec.length, 0, 'bytes were read without a proven inspected identity');
  assert.ok(!allText(h.container).includes('the archived answer'), 'content reached the DOM');
});

await checkAsync('32c. an ABSENT enumerated identity fails closed', async () => {
  /* The mirror case: the inspection proved an identity, but the fresh trusted
   * enumeration reports none for that occupant, so there is nothing to bind to.
   * The selected row still carries its identity, so the lenient row comparison
   * upstream passes and this guard is genuinely the one under test. */
  const identityless = { ...OCC.aCur };
  delete identityless.contentHash;
  const h = harness({
    envelope: envelope({ occupants: [identityless, OCC.aMid, OCC.aOld, OCC.aBad, OCC.bLegacy] }),
  });
  const s2 = await selectVerifiedVersion(h);
  assert.notEqual(s2.previewPhase, 'ready',
    'an absent enumerated identity was treated as agreement and the preview opened');
  assert.equal(s2.previewPhase, 'stale', `expected stale, got ${s2.previewPhase}`);
  assert.equal(s2.preview, null, 'content was built without a proven enumerated identity');
  assert.equal(h.calls.codec.length, 0, 'bytes were read without a proven enumerated identity');
  assert.ok(!allText(h.container).includes('the archived answer'), 'content reached the DOM');

  /* An empty-string identity is the same absence, not a value that can match. */
  const emptyIdentity = { ...OCC.aCur, contentHash: '' };
  const h2 = harness({
    envelope: envelope({ occupants: [emptyIdentity, OCC.aMid, OCC.aOld, OCC.aBad, OCC.bLegacy] }),
  });
  const s3 = await selectVerifiedVersion(h2);
  assert.equal(s3.previewPhase, 'stale', `empty identity: expected stale, got ${s3.previewPhase}`);
  assert.equal(h2.calls.codec.length, 0, 'bytes were read for an empty enumerated identity');
});

/* The case that makes the absence guard LOAD-BEARING rather than merely
 * redundant. With one identity present the equality comparison already rejects
 * the other's absence, so those two directions survive deleting the guard. When
 * BOTH are absent, equality reports a match — two nothings are "equal" — and the
 * explicit absence check is the only thing standing between an unproven package
 * and a rendered preview. */
await checkAsync('32d. TWO absent identities are not a match', async () => {
  const identityless = { ...OCC.aCur };
  delete identityless.contentHash;
  const h = harness({
    envelope: envelope({ occupants: [identityless, OCC.aMid, OCC.aOld, OCC.aBad, OCC.bLegacy] }),
    inspectFor: (packagePath) => Promise.resolve({
      ok: true, status: 'verified', packagePath,
      identity: { contentHash: '', schemaVersion: 3 },
      checks: {}, blockers: [], error: null,
    }),
  });
  const s2 = await selectVerifiedVersion(h);
  assert.notEqual(s2.previewPhase, 'ready',
    'two absent identities compared equal and the preview opened on an unproven package');
  assert.equal(s2.previewPhase, 'stale', `expected stale, got ${s2.previewPhase}`);
  assert.equal(s2.preview, null, 'content was built with no proven identity on either side');
  assert.equal(h.calls.codec.length, 0, 'bytes were read with no proven identity on either side');
  assert.ok(!allText(h.container).includes('the archived answer'), 'content reached the DOM');
});

await checkAsync('33. V3 with no governed member facts is refused, never downgraded', async () => {
  /* A v3 occupant whose trusted member anchors are absent. The forbidden
   * behaviour is falling through to the plain snapshot.json read. */
  const stripped = { ...OCC.aCur };
  delete stripped.snapshotEncoding;
  delete stripped.snapshotPhysicalSha256;
  delete stripped.snapshotPhysicalByteLength;
  delete stripped.logicalSnapshotSha256;
  delete stripped.logicalSnapshotByteLength;
  const h = harness({
    envelope: envelope({ occupants: [stripped, OCC.aMid, OCC.aOld, OCC.aBad, OCC.bLegacy] }),
  });
  const s2 = await selectVerifiedVersion(h);
  assert.equal(s2.previewPhase, 'unbindable', `expected unbindable, got ${s2.previewPhase}`);
  assert.equal(s2.preview, null, 'content was built without governed member facts');
  assert.equal(h.calls.codec.length, 0, 'a v3 package fell through to an unverified read');

  /* A PARTIAL anchor set is not a weaker anchor set — it is a set of checks
   * that would silently not happen. Lengths present, digests missing: still
   * refused, and still no read. */
  const digestless = { ...OCC.aCur };
  delete digestless.snapshotPhysicalSha256;
  delete digestless.logicalSnapshotSha256;
  const h2 = harness({
    envelope: envelope({ occupants: [digestless, OCC.aMid, OCC.aOld, OCC.aBad, OCC.bLegacy] }),
  });
  const s3 = await selectVerifiedVersion(h2);
  assert.equal(s3.previewPhase, 'unbindable', `partial anchors: expected unbindable, got ${s3.previewPhase}`);
  assert.equal(h2.calls.codec.length, 0, 'a package with no trusted digests was read anyway');

  /* And an encoding-less v3 occupant likewise. */
  const encodingless = { ...OCC.aCur };
  delete encodingless.snapshotEncoding;
  const h3 = harness({
    envelope: envelope({ occupants: [encodingless, OCC.aMid, OCC.aOld, OCC.aBad, OCC.bLegacy] }),
  });
  const s4 = await selectVerifiedVersion(h3);
  assert.equal(s4.previewPhase, 'unbindable', `no encoding: expected unbindable, got ${s4.previewPhase}`);
  assert.equal(h3.calls.codec.length, 0, 'a package with no trusted encoding was read anyway');
});

await checkAsync('34. HAPPY PATH — v3 gzip, v3 identity and v1 all still preview', async () => {
  const gzip = harness();
  const g = await selectVerifiedVersion(gzip, 'archive/packages/chat_a.g1.h2ochat');
  assert.equal(g.previewPhase, 'ready', `v3 gzip: ${g.previewPhase}`);
  assert.equal(gzip.calls.codec[0].descriptor.encoding, 'gzip');

  const identity = harness({ disk: { snapshot: V3_SNAPSHOT, ...anchors('3', 'v3', 'identity') } });
  const i = await selectVerifiedVersion(identity, 'archive/packages/chat_a.g3.h2ochat');
  assert.equal(i.previewPhase, 'ready', `v3 identity: ${i.previewPhase}`);
  assert.equal(identity.calls.codec[0].descriptor.encoding, 'identity');

  const legacy = harness({ disk: { snapshot: V1_SNAPSHOT, ...anchors('4', 'v1', 'identity') } });
  await legacy.card.load();
  await legacy.card.selectChat('chat_b');
  await legacy.card.selectVersion('archive/packages/chat_b.legacy.h2ochat');
  assert.equal(legacy.card.getState().previewPhase, 'ready', 'v1 legacy did not preview');
  assert.equal(legacy.card.getState().preview.messages[0].text, 'legacy scalar body');
});


/* ══ T04 — Recover as New ═══════════════════════════════════════════════════
 *
 * This surface can request exactly one mutation and owns none of it. What must
 * be proved is that nothing requests it implicitly, that the request carries no
 * authority of its own, and that an approval prepared for one version can never
 * be spent on another. */

async function previewed(h, path = 'archive/packages/chat_a.g1.h2ochat') {
  await h.card.load();
  await h.card.selectChat('chat_a');
  await h.card.selectVersion(path);
  return h.card.getState();
}

await checkAsync('35. selection and preview alone request nothing', async () => {
  const h = harness();
  await h.card.load();
  await h.card.selectChat('chat_a');
  assert.equal(h.calls.dryRun.length, 0, 'listing a chat ran a dry-run');
  assert.equal(h.calls.execute.length, 0, 'listing a chat imported');
  const s2 = await previewed(h);
  assert.equal(s2.previewPhase, 'ready', 'fixture no longer previews');
  assert.equal(h.calls.dryRun.length, 0, 'a successful preview ran a dry-run on its own');
  assert.equal(h.calls.execute.length, 0, 'a successful preview imported on its own');
  assert.equal(s2.recoverPhase, 'idle');
});

await checkAsync('36. mount, refresh and remount never request anything', async () => {
  const document = domStub();
  const loaded = loadUi(document);
  const parent = document.createElement('div');
  const health = document.createElement('div');
  parent.appendChild(health);
  const seen = { dryRun: 0, execute: 0 };
  const opts = {
    capable: true, autoLoad: true,
    readIntegrity: () => Promise.resolve(envelope()),
    partitionOccupants,
    describeCoverage: () => Promise.resolve(coverageA()),
    dryRunImport: () => { seen.dryRun += 1; return Promise.resolve({ decision: 'import-ready' }); },
    executeImport: () => { seen.execute += 1; return Promise.resolve({ ok: true, status: 'imported' }); },
  };
  loaded.api.mountRecoveryCenterCard(health, opts);
  loaded.api.mountRecoveryCenterCard(health, opts);
  const card = loaded.api.mountRecoveryCenterCard(health, opts);
  await card.load();
  assert.equal(seen.dryRun, 0, 'mount/remount/refresh ran a dry-run');
  assert.equal(seen.execute, 0, 'mount/remount/refresh imported');
});

await checkAsync('37. the first operator step runs exactly one dry-run and imports nothing', async () => {
  const h = harness();
  await previewed(h);
  await h.card.prepareRecoverAsNew();
  assert.equal(h.calls.dryRun.length, 1, `expected 1 dry-run, saw ${h.calls.dryRun.length}`);
  assert.deepEqual(Object.keys(h.calls.dryRun[0]).sort(), ['packagePath'],
    'the dry-run received more than the package address');
  assert.equal(h.calls.dryRun[0].packagePath, 'archive/packages/chat_a.g1.h2ochat');
  assert.equal(h.calls.execute.length, 0, 'the first step imported');
  assert.equal(h.card.getState().recoverPhase, 'ready-to-confirm');
});

await checkAsync('38. an import-ready verdict offers the second step and still imports nothing', async () => {
  const h = harness();
  await previewed(h);
  await h.card.prepareRecoverAsNew();
  const confirmBtns = nodesWithAttr(h.container, 'data-h2o-action', 'recovery-center-recover-as-new');
  assert.equal(confirmBtns.length, 1, 'the confirming control is not offered after an import-ready verdict');
  assert.equal(h.calls.execute.length, 0, 'offering the control already imported');
  assert.ok(allText(h.container).includes('import-ready'), "the importer's own verdict is not shown");
});

await checkAsync('39. the second step requests exactly one import, carrying no authority', async () => {
  const h = harness();
  await previewed(h);
  await h.card.prepareRecoverAsNew();
  await h.card.recoverAsNew();
  assert.equal(h.calls.execute.length, 1, `expected 1 import, saw ${h.calls.execute.length}`);
  const sent = h.calls.execute[0];
  assert.deepEqual(Object.keys(sent).sort(), ['mode', 'packagePath'],
    'the execution carried fields beyond the address and mode: ' + Object.keys(sent).join(', '));
  assert.equal(sent.packagePath, 'archive/packages/chat_a.g1.h2ochat', 'the selected trusted row was not the target');
  assert.equal(sent.mode, 'import-as-new', "the importer's own mode was not used");
  for (const forbidden of ['dryRun', 'decision', 'eligible', 'eligibility', 'contentHash', 'snapshotId',
    'chatId', 'identity', 'provenance', 'recoveredId', 'preview']) {
    assert.ok(!(forbidden in sent), `caller-supplied authority reached the importer: ${forbidden}`);
  }
  assert.equal(h.card.getState().recoverPhase, 'success');
});

await checkAsync('40. a refused dry-run offers no mutation and imports nothing', async () => {
  for (const decision of ['conflict-chat-id', 'conflict-snapshot-id', 'corrupted', 'rejected', 'already-imported']) {
    const h = harness({ dryRunResult: { ok: decision === 'already-imported', decision, status: decision, reason: 'r' } });
    await previewed(h);
    await h.card.prepareRecoverAsNew();
    const s2 = h.card.getState();
    assert.equal(s2.recoverPhase, 'refused', `${decision}: expected refused, got ${s2.recoverPhase}`);
    assert.equal(nodesWithAttr(h.container, 'data-h2o-action', 'recovery-center-recover-as-new').length, 0,
      `${decision}: a mutation control was offered`);
    await h.card.recoverAsNew();
    assert.equal(h.calls.execute.length, 0, `${decision}: an import happened anyway`);
    assert.ok(allText(h.container).includes(decision), `${decision}: the verdict was not shown honestly`);
  }
});

await checkAsync('41. a dry-run error imports nothing and offers nothing', async () => {
  const h = harness({ dryRunFails: true });
  await previewed(h);
  await h.card.prepareRecoverAsNew();
  assert.equal(h.card.getState().recoverPhase, 'error');
  assert.equal(nodesWithAttr(h.container, 'data-h2o-action', 'recovery-center-recover-as-new').length, 0);
  await h.card.recoverAsNew();
  assert.equal(h.calls.execute.length, 0, 'an import followed a failed dry-run');
});

await checkAsync('42. changing version invalidates a prepared confirmation', async () => {
  const h = harness();
  await previewed(h, 'archive/packages/chat_a.g1.h2ochat');
  await h.card.prepareRecoverAsNew();
  assert.equal(h.card.getState().recoverPhase, 'ready-to-confirm');
  await h.card.selectVersion('archive/packages/chat_a.g2.h2ochat');
  const s2 = h.card.getState();
  assert.notEqual(s2.recoverPhase, 'ready-to-confirm', 'an approval survived a version change');
  assert.equal(s2.recoverForPath, '', 'the approval stayed bound to a path');
  assert.equal(nodesWithAttr(h.container, 'data-h2o-action', 'recovery-center-recover-as-new').length, 0);
  await h.card.recoverAsNew();
  assert.equal(h.calls.execute.length, 0, 'a stale approval was spent on another version');
});

await checkAsync('43. changing chat invalidates a prepared confirmation', async () => {
  const h = harness();
  await previewed(h);
  await h.card.prepareRecoverAsNew();
  await h.card.selectChat('chat_b');
  const s2 = h.card.getState();
  assert.equal(s2.recoverPhase, 'idle', 'an approval survived a chat change');
  await h.card.recoverAsNew();
  assert.equal(h.calls.execute.length, 0, 'an import followed a chat change');
});

await checkAsync('44. refresh invalidates a prepared confirmation', async () => {
  let env = envelope();
  const h = harness({ options: { readIntegrity: () => Promise.resolve(env) } });
  await previewed(h);
  await h.card.prepareRecoverAsNew();
  assert.equal(h.card.getState().recoverPhase, 'ready-to-confirm');
  env = envelope({ occupants: [OCC.bLegacy] });   // the chat disappears
  await h.card.load();
  const s2 = h.card.getState();
  assert.equal(s2.recoverPhase, 'idle', 'an approval survived a refresh that dropped its chat');
  await h.card.recoverAsNew();
  assert.equal(h.calls.execute.length, 0, 'an import followed a refresh');
});

await checkAsync('45. a late dry-run for an abandoned version cannot arm a newer one', async () => {
  const slow = deferred();
  const h = harness({ dryRunDeferred: slow });
  await previewed(h, 'archive/packages/chat_a.g1.h2ochat');
  const abandoned = h.card.prepareRecoverAsNew();
  assert.equal(h.card.getState().recoverPhase, 'preflighting');
  await h.card.selectVersion('archive/packages/chat_a.g2.h2ochat');
  slow.resolve({ ok: true, decision: 'import-ready', status: 'import-ready' });
  await abandoned;
  for (let i = 0; i < 12; i += 1) await Promise.resolve();
  const s2 = h.card.getState();
  assert.notEqual(s2.recoverPhase, 'ready-to-confirm',
    'a late dry-run for an abandoned version armed the newly selected one');
  assert.equal(nodesWithAttr(h.container, 'data-h2o-action', 'recovery-center-recover-as-new').length, 0);
  await h.card.recoverAsNew();
  assert.equal(h.calls.execute.length, 0, 'the late verdict enabled an import');
});

await checkAsync('46. an unreadable preview can never reach recovery', async () => {
  for (const [label, opts] of [
    ['refused', { inspectFor: (packagePath) => Promise.resolve({ ok: false, status: 'hash-mismatch', packagePath, identity: {}, checks: {}, blockers: [] }) }],
    ['stale', { inspectFor: (packagePath) => Promise.resolve({ ok: true, status: 'verified', packagePath, identity: { contentHash: 'sha256-' + HASH_OLD }, checks: {}, blockers: [] }) }],
    ['error', { codecOptions: { verifiedFails: true } }],
    ['unbindable', { envelope: envelope({ occupants: [(() => { const o = { ...OCC.aCur }; delete o.snapshotPhysicalSha256; return o; })(), OCC.aMid, OCC.aOld, OCC.aBad, OCC.bLegacy] }) }],
  ]) {
    const h = harness(opts);
    const s2 = await previewed(h);
    assert.notEqual(s2.previewPhase, 'ready', `${label}: fixture no longer models an unreadable preview`);
    assert.equal(nodesWithAttr(h.container, 'data-h2o-action', 'recovery-center-prepare-recover-as-new').length, 0,
      `${label}: the recovery step was offered for an unreadable preview`);
    await h.card.prepareRecoverAsNew();
    assert.equal(h.calls.dryRun.length, 0, `${label}: a dry-run ran for an unreadable preview`);
    await h.card.recoverAsNew();
    assert.equal(h.calls.execute.length, 0, `${label}: an import ran for an unreadable preview`);
  }
});

await checkAsync('47. an authoritative import rejection is shown, with no retry or fallback', async () => {
  const h = harness({ executeResult: { ok: false, status: 'rejected', decision: 'import-ready',
    packagePath: 'archive/packages/chat_a.g1.h2ochat', recovered: null, reason: 'package no longer verified at write time' } });
  await previewed(h);
  await h.card.prepareRecoverAsNew();
  await h.card.recoverAsNew();
  const s2 = h.card.getState();
  assert.equal(s2.recoverPhase, 'refused', `expected refused, got ${s2.recoverPhase}`);
  assert.equal(h.calls.execute.length, 1, 'the refusal was retried');
  const text = allText(h.container);
  assert.ok(text.includes('rejected'), 'the refusal status was not shown');
  assert.ok(text.includes('no longer verified'), "the importer's reason was not shown");
  assert.ok(!text.includes('Recovered as a new chat'), 'a refusal was presented as success');
});

await checkAsync('48. a successful import is reported from the importer result only', async () => {
  const h = harness();
  await previewed(h);
  await h.card.prepareRecoverAsNew();
  await h.card.recoverAsNew();
  assert.equal(h.calls.execute.length, 1, 'exactly one mutation request expected');
  const text = allText(h.container);
  assert.ok(text.includes('Recovered as a new chat'), 'success was not shown');
  assert.ok(text.includes('recovered_abc'), 'the recovered identity the importer returned was not shown');
  /* And a second click does not re-request: the approval was spent. */
  await h.card.recoverAsNew();
  assert.equal(h.calls.execute.length, 1, 'the spent approval requested a second import');
});

await checkAsync('49. archived content cannot create or trigger a recovery control', async () => {
  const hostile = {
    schemaVersion: 3, title: '<button data-h2o-action="recovery-center-recover-as-new">go</button>',
    messages: [{ role: 'user', content: [{ type: 'html',
      html: '<button data-h2o-action="recovery-center-recover-as-new" onclick="x()">Recover</button>' }] }],
  };
  const h = harness({ disk: { snapshot: hostile, ...anchors('1', 'v3', 'gzip') } });
  await previewed(h);
  assert.equal(h.card.getState().previewPhase, 'ready');
  const controls = nodesWithAttr(h.container, 'data-h2o-action', 'recovery-center-recover-as-new');
  assert.equal(controls.length, 0, 'archived content produced a mutation control');
  assert.equal(h.calls.dryRun.length, 0, 'archived content triggered a dry-run');
  assert.equal(h.calls.execute.length, 0, 'archived content triggered an import');
});

/* ── T05 — Restore Original Identity ──────────────────────────────────────────
 * The second — and last — mutation this surface can request, and it owns none
 * of it. Absent-only restore under the package's ORIGINAL chatId and
 * snapshotId is decided entirely by the governed restore module: conflicts,
 * tombstones, digest comparability, the trusted content binding, the
 * transaction and every refusal. What must be proved here is that the surface
 * asks for exactly one thing, asks for it only on deliberate operator intent,
 * and can never spend one version's approval — or one operation's approval —
 * on another. */

/* The surface's own success wording, read from the module rather than copied
 * here, so the "a no-write outcome was not labelled as a restore" assertions
 * cannot drift apart from the copy they are testing. */
const uiTextRestoreSuccess = loadUi(domStub()).api.TEXT.restoreSuccess;
assert.ok(typeof uiTextRestoreSuccess === 'string' && uiTextRestoreSuccess.length > 0,
  'the surface publishes no restore success wording to test against');

await checkAsync('50. selection and preview alone request no restore', async () => {
  const h = harness();
  await h.card.load();
  await h.card.selectChat('chat_a');
  assert.equal(h.calls.restoreDryRun.length, 0, 'listing a chat ran a restore dry-run');
  assert.equal(h.calls.restoreExecute.length, 0, 'listing a chat restored');
  const s2 = await previewed(h);
  assert.equal(s2.previewPhase, 'ready', 'fixture no longer previews');
  assert.equal(h.calls.restoreDryRun.length, 0, 'a successful preview ran a restore dry-run on its own');
  assert.equal(h.calls.restoreExecute.length, 0, 'a successful preview restored on its own');
  assert.equal(s2.restorePhase, 'idle');
});

await checkAsync('51. mount, refresh and remount never request a restore', async () => {
  const document = domStub();
  const loaded = loadUi(document);
  const parent = document.createElement('div');
  const health = document.createElement('div');
  parent.appendChild(health);
  const seen = { dryRun: 0, execute: 0 };
  const opts = {
    capable: true, autoLoad: true,
    readIntegrity: () => Promise.resolve(envelope()),
    partitionOccupants,
    describeCoverage: () => Promise.resolve(coverageA()),
    dryRunRestore: () => { seen.dryRun += 1; return Promise.resolve({ decision: 'restore-ready' }); },
    executeRestore: () => { seen.execute += 1; return Promise.resolve({ ok: true, status: 'restored' }); },
  };
  loaded.api.mountRecoveryCenterCard(health, opts);
  loaded.api.mountRecoveryCenterCard(health, opts);
  const card = loaded.api.mountRecoveryCenterCard(health, opts);
  await card.load();
  assert.equal(seen.dryRun, 0, 'mount/remount/refresh ran a restore dry-run');
  assert.equal(seen.execute, 0, 'mount/remount/refresh restored');
});

await checkAsync('52. the first T05 step runs exactly one restore dry-run and restores nothing', async () => {
  const h = harness();
  await previewed(h);
  await h.card.prepareRestoreOriginalIdentity();
  assert.equal(h.calls.restoreDryRun.length, 1, `expected 1 restore dry-run, saw ${h.calls.restoreDryRun.length}`);
  assert.deepEqual(Object.keys(h.calls.restoreDryRun[0]).sort(), ['packagePath'],
    'the restore dry-run received more than the package address');
  assert.equal(h.calls.restoreDryRun[0].packagePath, 'archive/packages/chat_a.g1.h2ochat');
  assert.equal(h.calls.restoreExecute.length, 0, 'the first step restored');
  assert.equal(h.calls.execute.length, 0, 'the first T05 step reached the importer');
  assert.equal(h.card.getState().restorePhase, 'ready-to-confirm');
});

await checkAsync('53. a restore-ready verdict offers the second step and still restores nothing', async () => {
  const h = harness();
  await previewed(h);
  await h.card.prepareRestoreOriginalIdentity();
  const confirmBtns = nodesWithAttr(h.container, 'data-h2o-action', 'recovery-center-restore-original');
  assert.equal(confirmBtns.length, 1, 'the confirming control is not offered after a restore-ready verdict');
  assert.equal(h.calls.restoreExecute.length, 0, 'offering the control already restored');
  assert.ok(allText(h.container).includes('restore-ready'), "the restore module's own verdict is not shown");
});

await checkAsync('54. the second T05 step requests exactly one restore, carrying no authority', async () => {
  const h = harness();
  await previewed(h);
  await h.card.prepareRestoreOriginalIdentity();
  await h.card.restoreOriginalIdentity();
  assert.equal(h.calls.restoreExecute.length, 1, `expected 1 restore, saw ${h.calls.restoreExecute.length}`);
  const sent = h.calls.restoreExecute[0];
  assert.deepEqual(Object.keys(sent).sort(), ['confirm', 'mode', 'packagePath'],
    'the execution carried fields beyond the address, mode and confirmation: ' + Object.keys(sent).join(', '));
  assert.equal(sent.packagePath, 'archive/packages/chat_a.g1.h2ochat', 'the selected trusted row was not the target');
  assert.equal(sent.mode, 'restore-original-ids', "the restore module's own mode was not used");
  assert.equal(sent.confirm, true, 'the backend confirmation gate was not satisfied explicitly');
  for (const forbidden of ['dryRun', 'decision', 'restoreReady', 'eligible', 'eligibility', 'contentHash',
    'snapshotId', 'chatId', 'identity', 'digest', 'provenance', 'preview', 'previewState',
    'conflict', 'conflictResult', 'tombstone', 'tombstoned', 'anchors', 'trustedAnchors', 'sql', 'writePlan']) {
    assert.ok(!(forbidden in sent), `caller-supplied authority reached the restore module: ${forbidden}`);
  }
  assert.equal(h.calls.execute.length, 0, 'a T05 confirmation reached the importer');
  assert.equal(h.card.getState().restorePhase, 'success');
});

await checkAsync('55. an already-present dry-run offers no mutation and is not shown as a restore', async () => {
  const h = harness({ restoreDryRunResult: { ok: true, decision: 'already-present', status: 'already-present', reason: 'original snapshot already present' } });
  await previewed(h);
  await h.card.prepareRestoreOriginalIdentity();
  const s2 = h.card.getState();
  assert.equal(s2.restorePhase, 'no-write', `expected no-write, got ${s2.restorePhase}`);
  assert.equal(nodesWithAttr(h.container, 'data-h2o-action', 'recovery-center-restore-original').length, 0,
    'a mutation control was offered for an already-present verdict');
  const text = allText(h.container);
  assert.ok(text.includes('already-present'), 'the verdict was not shown honestly');
  assert.ok(!text.includes(uiTextRestoreSuccess), 'an already-present verdict was labelled as a restore');
  await h.card.restoreOriginalIdentity();
  assert.equal(h.calls.restoreExecute.length, 0, 'a restore followed an already-present verdict');
});

await checkAsync('56. every authoritative refusal blocks the mutation entirely', async () => {
  for (const decision of ['conflict-chat-id', 'conflict-snapshot-id', 'tombstoned', 'rejected',
    'corrupted', 'unsupported-version', 'read-error']) {
    const h = harness({ restoreDryRunResult: { ok: false, decision, status: decision, reason: 'r' } });
    await previewed(h);
    await h.card.prepareRestoreOriginalIdentity();
    const s2 = h.card.getState();
    assert.equal(s2.restorePhase, 'refused', `${decision}: expected refused, got ${s2.restorePhase}`);
    assert.equal(s2.restoreForPath, '', `${decision}: a refusal still pinned an approval`);
    assert.equal(nodesWithAttr(h.container, 'data-h2o-action', 'recovery-center-restore-original').length, 0,
      `${decision}: a mutation control was offered`);
    await h.card.restoreOriginalIdentity();
    assert.equal(h.calls.restoreExecute.length, 0, `${decision}: a restore happened anyway`);
    assert.ok(allText(h.container).includes(decision), `${decision}: the verdict was not shown honestly`);
  }
});

await checkAsync('57. a restore dry-run error restores nothing and offers nothing', async () => {
  const h = harness({ restoreDryRunFails: true });
  await previewed(h);
  await h.card.prepareRestoreOriginalIdentity();
  assert.equal(h.card.getState().restorePhase, 'error');
  assert.equal(nodesWithAttr(h.container, 'data-h2o-action', 'recovery-center-restore-original').length, 0);
  await h.card.restoreOriginalIdentity();
  assert.equal(h.calls.restoreExecute.length, 0, 'a restore followed a failed dry-run');
});

await checkAsync('58. changing version invalidates a prepared T05 approval', async () => {
  const h = harness();
  await previewed(h, 'archive/packages/chat_a.g1.h2ochat');
  await h.card.prepareRestoreOriginalIdentity();
  assert.equal(h.card.getState().restorePhase, 'ready-to-confirm');
  await h.card.selectVersion('archive/packages/chat_a.g2.h2ochat');
  const s2 = h.card.getState();
  assert.notEqual(s2.restorePhase, 'ready-to-confirm', 'an approval survived a version change');
  assert.equal(s2.restoreForPath, '', 'the approval stayed bound to a path');
  assert.equal(nodesWithAttr(h.container, 'data-h2o-action', 'recovery-center-restore-original').length, 0);
  await h.card.restoreOriginalIdentity();
  assert.equal(h.calls.restoreExecute.length, 0, 'a stale approval was spent on another version');
});

await checkAsync('59. changing chat invalidates a prepared T05 approval', async () => {
  const h = harness();
  await previewed(h);
  await h.card.prepareRestoreOriginalIdentity();
  await h.card.selectChat('chat_b');
  assert.equal(h.card.getState().restorePhase, 'idle', 'an approval survived a chat change');
  await h.card.restoreOriginalIdentity();
  assert.equal(h.calls.restoreExecute.length, 0, 'a restore followed a chat change');
});

await checkAsync('60. refresh invalidates a prepared T05 approval', async () => {
  let env = envelope();
  const h = harness({ options: { readIntegrity: () => Promise.resolve(env) } });
  await previewed(h);
  await h.card.prepareRestoreOriginalIdentity();
  assert.equal(h.card.getState().restorePhase, 'ready-to-confirm');
  env = envelope({ occupants: [OCC.bLegacy] });   // the chat disappears
  await h.card.load();
  assert.equal(h.card.getState().restorePhase, 'idle', 'an approval survived a refresh that dropped its chat');
  await h.card.restoreOriginalIdentity();
  assert.equal(h.calls.restoreExecute.length, 0, 'a restore followed a refresh');
});

await checkAsync('61. remounting the card invalidates a prepared T05 approval', async () => {
  const document = domStub();
  const loaded = loadUi(document);
  const parent = document.createElement('div');
  const health = document.createElement('div');
  parent.appendChild(health);
  const seen = { execute: 0 };
  const opts = {
    capable: true, autoLoad: false,
    readIntegrity: () => Promise.resolve(envelope()),
    partitionOccupants,
    describeCoverage: () => Promise.resolve(coverageA()),
    dryRunRestore: () => Promise.resolve({ ok: true, decision: 'restore-ready', status: 'restore-ready' }),
    executeRestore: () => { seen.execute += 1; return Promise.resolve({ ok: true, status: 'restored' }); },
  };
  const first = loaded.api.mountRecoveryCenterCard(health, opts);
  await first.load();
  await first.selectChat('chat_a');
  await first.selectVersion('archive/packages/chat_a.g1.h2ochat');
  await first.prepareRestoreOriginalIdentity();
  const second = loaded.api.mountRecoveryCenterCard(health, opts);
  assert.notEqual(second, first, 'remount did not produce a new card instance');
  assert.equal(second.getState().restorePhase, 'idle', 'a remounted card carried a prepared approval');
  await second.restoreOriginalIdentity();
  assert.equal(seen.execute, 0, 'a remounted card spent an approval prepared before the remount');
});

await checkAsync('62. a late restore dry-run for an abandoned version cannot arm a newer one', async () => {
  const slow = deferred();
  const h = harness({ restoreDryRunDeferred: slow });
  await previewed(h, 'archive/packages/chat_a.g1.h2ochat');
  const abandoned = h.card.prepareRestoreOriginalIdentity();
  assert.equal(h.card.getState().restorePhase, 'preflighting');
  await h.card.selectVersion('archive/packages/chat_a.g2.h2ochat');
  slow.resolve({ ok: true, decision: 'restore-ready', status: 'restore-ready' });
  await abandoned;
  for (let i = 0; i < 12; i += 1) await Promise.resolve();
  const s2 = h.card.getState();
  assert.notEqual(s2.restorePhase, 'ready-to-confirm',
    'a late restore dry-run for an abandoned version armed the newly selected one');
  assert.equal(nodesWithAttr(h.container, 'data-h2o-action', 'recovery-center-restore-original').length, 0);
  await h.card.restoreOriginalIdentity();
  assert.equal(h.calls.restoreExecute.length, 0, 'the late verdict enabled a restore');
});

await checkAsync('63. returning to the same version does not resurrect a spent or abandoned approval', async () => {
  const A = 'archive/packages/chat_a.g1.h2ochat';
  const B = 'archive/packages/chat_a.g2.h2ochat';
  const h = harness();
  await previewed(h, A);
  await h.card.prepareRestoreOriginalIdentity();
  assert.equal(h.card.getState().restoreForPath, A);
  await h.card.selectVersion(B);
  await h.card.selectVersion(A);
  const s2 = h.card.getState();
  assert.equal(s2.restorePhase, 'idle', 'returning to the same version resurrected an approval');
  assert.equal(s2.restoreForPath, '', 'the old path pin came back');
  assert.equal(nodesWithAttr(h.container, 'data-h2o-action', 'recovery-center-restore-original').length, 0);
  await h.card.restoreOriginalIdentity();
  assert.equal(h.calls.restoreExecute.length, 0, 'the resurrected approval was spendable');
});

await checkAsync('64. an unreadable preview can never reach restore', async () => {
  for (const [label, opts] of [
    ['refused', { inspectFor: (packagePath) => Promise.resolve({ ok: false, status: 'hash-mismatch', packagePath, identity: {}, checks: {}, blockers: [] }) }],
    ['stale', { inspectFor: (packagePath) => Promise.resolve({ ok: true, status: 'verified', packagePath, identity: { contentHash: 'sha256-' + HASH_OLD }, checks: {}, blockers: [] }) }],
    ['error', { codecOptions: { verifiedFails: true } }],
    ['unbindable', { envelope: envelope({ occupants: [(() => { const o = { ...OCC.aCur }; delete o.snapshotPhysicalSha256; return o; })(), OCC.aMid, OCC.aOld, OCC.aBad, OCC.bLegacy] }) }],
  ]) {
    const h = harness(opts);
    const s2 = await previewed(h);
    assert.notEqual(s2.previewPhase, 'ready', `${label}: fixture no longer models an unreadable preview`);
    assert.equal(nodesWithAttr(h.container, 'data-h2o-action', 'recovery-center-prepare-restore-original').length, 0,
      `${label}: the restore step was offered for an unreadable preview`);
    await h.card.prepareRestoreOriginalIdentity();
    assert.equal(h.calls.restoreDryRun.length, 0, `${label}: a restore dry-run ran for an unreadable preview`);
    await h.card.restoreOriginalIdentity();
    assert.equal(h.calls.restoreExecute.length, 0, `${label}: a restore ran for an unreadable preview`);
  }
});

await checkAsync('65. rapid repeated confirmation issues exactly ONE restore', async () => {
  const h = harness();
  await previewed(h);
  await h.card.prepareRestoreOriginalIdentity();
  /* Dispatched synchronously, with no await between them: the approval must be
   * consumed before the first await or the second dispatch would also see it. */
  const bursts = [
    h.card.restoreOriginalIdentity(), h.card.restoreOriginalIdentity(), h.card.restoreOriginalIdentity(),
    h.card.restoreOriginalIdentity(), h.card.restoreOriginalIdentity(),
  ];
  await Promise.all(bursts);
  assert.equal(h.calls.restoreExecute.length, 1,
    `five synchronous confirmations issued ${h.calls.restoreExecute.length} restores`);
});

await checkAsync('66. an authoritative restore refusal is shown, with no retry or fallback', async () => {
  for (const status of ['conflict', 'tombstoned', 'rejected', 'write-error']) {
    const h = harness({ restoreExecuteResult: { ok: false, status, decision: 'restore-ready', reason: 'refused by the restore module', restored: null } });
    await previewed(h);
    await h.card.prepareRestoreOriginalIdentity();
    await h.card.restoreOriginalIdentity();
    assert.equal(h.calls.restoreExecute.length, 1, `${status}: the refusal was retried`);
    const s2 = h.card.getState();
    assert.equal(s2.restorePhase, 'refused', `${status}: a refusal was not reported as one`);
    assert.equal(s2.restoreForPath, '', `${status}: the approval survived the refusal`);
    assert.ok(allText(h.container).includes(status), `${status}: the refusal was not shown honestly`);
    assert.equal(h.calls.execute.length, 0, `${status}: a refused restore fell back to the importer`);
    /* And it cannot be re-fired without a fresh preparation. */
    await h.card.restoreOriginalIdentity();
    assert.equal(h.calls.restoreExecute.length, 1, `${status}: a refused approval was spendable again`);
  }
});

await checkAsync('67. a restore error is shown, with no retry or fallback', async () => {
  const h = harness({ restoreExecuteFails: true });
  await previewed(h);
  await h.card.prepareRestoreOriginalIdentity();
  await h.card.restoreOriginalIdentity();
  assert.equal(h.calls.restoreExecute.length, 1, 'the error was retried');
  assert.equal(h.card.getState().restorePhase, 'error');
  assert.equal(h.calls.execute.length, 0, 'a failed restore fell back to the importer');
});

await checkAsync('68. a successful restore is reported from the restore result only, and the approval is spent', async () => {
  const h = harness({ restoreExecuteResult: { ok: true, status: 'restored', decision: 'restore-ready',
    mode: 'restore-original-ids', restored: { chatId: 'chat_orig', snapshotId: 'snap_orig', turnCount: 7 }, reason: '' } });
  await previewed(h);
  await h.card.prepareRestoreOriginalIdentity();
  await h.card.restoreOriginalIdentity();
  const s2 = h.card.getState();
  assert.equal(s2.restorePhase, 'success');
  const text = allText(h.container);
  for (const shown of ['restored', 'chat_orig', 'snap_orig', '7']) {
    assert.ok(text.includes(shown), `the restore module's own result was not reported: ${shown}`);
  }
  assert.equal(s2.restoreForPath, '', 'the approval was not spent');
  await h.card.restoreOriginalIdentity();
  assert.equal(h.calls.restoreExecute.length, 1, 'the spent approval requested a second restore');
});

await checkAsync('69. an already-present EXECUTION is reported as no-write, never as a restore', async () => {
  /* The restore module reports ok === true for already-present. Reading success
   * from `ok` would label a no-write outcome as a restore that happened. */
  const h = harness({ restoreExecuteResult: { ok: true, status: 'already-present', decision: 'restore-ready',
    restored: { chatId: 'chat_a', snapshotId: 's1', turnCount: 0 }, reason: 'original snapshot already present; no write performed' } });
  await previewed(h);
  await h.card.prepareRestoreOriginalIdentity();
  await h.card.restoreOriginalIdentity();
  const s2 = h.card.getState();
  assert.equal(s2.restorePhase, 'no-write', `expected no-write, got ${s2.restorePhase}`);
  const text = allText(h.container);
  assert.ok(text.includes('already-present'), 'the no-write outcome was not shown honestly');
  assert.ok(!text.includes(uiTextRestoreSuccess), 'a no-write outcome was labelled as a restore');
});

await checkAsync('70. T04 and T05 remain two separate operations, never one generic call', async () => {
  const h = harness();
  await previewed(h);
  await h.card.prepareRecoverAsNew();
  await h.card.recoverAsNew();
  assert.equal(h.calls.execute.length, 1, 'the T04 flow no longer works');
  assert.equal(h.calls.restoreExecute.length, 0, 'a T04 confirmation reached the restore module');
  const h2 = harness();
  await previewed(h2);
  await h2.card.prepareRestoreOriginalIdentity();
  await h2.card.restoreOriginalIdentity();
  assert.equal(h2.calls.restoreExecute.length, 1, 'the T05 flow does not work');
  assert.equal(h2.calls.execute.length, 0, 'a T05 confirmation reached the importer');
  /* Distinct modes and distinct call shapes — not one parameterised mutation. */
  assert.equal(h.calls.execute[0].mode, 'import-as-new');
  assert.equal(h2.calls.restoreExecute[0].mode, 'restore-original-ids');
  assert.ok(!('confirm' in h.calls.execute[0]), 'the importer call grew a restore-shaped confirmation');
});

await checkAsync('71. starting a T05 restore invalidates any prepared T04 approval', async () => {
  const h = harness();
  await previewed(h);
  await h.card.prepareRecoverAsNew();
  await h.card.prepareRestoreOriginalIdentity();
  assert.equal(h.card.getState().restorePhase, 'ready-to-confirm');
  await h.card.restoreOriginalIdentity();
  assert.equal(h.calls.restoreExecute.length, 1, 'the restore did not run');
  const s2 = h.card.getState();
  assert.notEqual(s2.recoverPhase, 'ready-to-confirm', 'a T04 approval survived a T05 mutation request');
  assert.equal(s2.recoverForPath, '', 'the T04 approval stayed bound to a path');
  assert.equal(nodesWithAttr(h.container, 'data-h2o-action', 'recovery-center-recover-as-new').length, 0);
  await h.card.recoverAsNew();
  assert.equal(h.calls.execute.length, 0,
    'an approval prepared BEFORE the restore was spent on the importer afterwards');
});

await checkAsync('72. starting a T04 recovery invalidates any prepared T05 approval', async () => {
  const h = harness();
  await previewed(h);
  await h.card.prepareRestoreOriginalIdentity();
  await h.card.prepareRecoverAsNew();
  assert.equal(h.card.getState().recoverPhase, 'ready-to-confirm');
  await h.card.recoverAsNew();
  assert.equal(h.calls.execute.length, 1, 'the import did not run');
  const s2 = h.card.getState();
  assert.notEqual(s2.restorePhase, 'ready-to-confirm', 'a T05 approval survived a T04 mutation request');
  assert.equal(s2.restoreForPath, '', 'the T05 approval stayed bound to a path');
  assert.equal(nodesWithAttr(h.container, 'data-h2o-action', 'recovery-center-restore-original').length, 0);
  await h.card.restoreOriginalIdentity();
  assert.equal(h.calls.restoreExecute.length, 0,
    'an approval prepared BEFORE the import was spent on the restore module afterwards');
});

await checkAsync('73. archived content cannot create or trigger a restore control', async () => {
  const hostile = {
    schemaVersion: 3, title: '<button data-h2o-action="recovery-center-restore-original">go</button>',
    messages: [{ role: 'user', content: [{ type: 'html',
      html: '<button data-h2o-action="recovery-center-restore-original" onclick="x()">Restore</button>'
        + '<button data-h2o-action="recovery-center-prepare-restore-original">Prepare</button>' }] }],
  };
  const h = harness({ disk: { snapshot: hostile, ...anchors('1', 'v3', 'gzip') } });
  await previewed(h);
  assert.equal(h.card.getState().previewPhase, 'ready');
  assert.equal(nodesWithAttr(h.container, 'data-h2o-action', 'recovery-center-restore-original').length, 0,
    'archived content produced a restore mutation control');
  /* The genuine prepare control is rendered by the surface itself, so the proof
   * is that the archived copy added nothing to it. */
  assert.equal(nodesWithAttr(h.container, 'data-h2o-action', 'recovery-center-prepare-restore-original').length, 1,
    'archived content changed how many prepare controls exist');
  assert.equal(h.calls.restoreDryRun.length, 0, 'archived content triggered a restore dry-run');
  assert.equal(h.calls.restoreExecute.length, 0, 'archived content triggered a restore');
});

await checkAsync('74. a cross-action request never strands the other operation mid-flight', async () => {
  /* The two operations share one request token, so starting either discards the
   * other's IN-FLIGHT read. That read must not leave its phase stuck busy —
   * which would disable the other control for the rest of the card's life. */
  const slow = deferred();
  const h = harness({ restoreDryRunDeferred: slow });
  await previewed(h);
  const stranded = h.card.prepareRestoreOriginalIdentity();
  assert.equal(h.card.getState().restorePhase, 'preflighting');
  await h.card.prepareRecoverAsNew();
  assert.equal(h.card.getState().recoverPhase, 'ready-to-confirm', 'the T04 request did not settle');
  slow.resolve({ ok: true, decision: 'restore-ready', status: 'restore-ready' });
  await stranded;
  for (let i = 0; i < 12; i += 1) await Promise.resolve();
  const s2 = h.card.getState();
  assert.ok(!['preflighting', 'executing'].includes(s2.restorePhase),
    `the stranded T05 request is stuck in ${s2.restorePhase}`);
  assert.notEqual(s2.restorePhase, 'ready-to-confirm', 'a stranded late verdict armed the T05 control');
  await h.card.restoreOriginalIdentity();
  assert.equal(h.calls.restoreExecute.length, 0, 'the stranded verdict enabled a restore');
  /* And the T05 prepare control is usable again, not permanently disabled. */
  const prepares = nodesWithAttr(h.container, 'data-h2o-action', 'recovery-center-prepare-restore-original');
  assert.equal(prepares.length, 1, 'the T05 prepare control disappeared');
  assert.equal(prepares[0].disabled, false, 'the T05 prepare control is permanently disabled');
});

await checkAsync('75. a SETTLED approval survives the other operation being prepared', async () => {
  /* This is what makes checks 71 and 72 real: if preparing one operation already
   * discarded the other's settled approval, the execution-time invalidation
   * those checks target could never be observed. */
  const h = harness();
  await previewed(h);
  await h.card.prepareRecoverAsNew();
  assert.equal(h.card.getState().recoverPhase, 'ready-to-confirm');
  await h.card.prepareRestoreOriginalIdentity();
  const s2 = h.card.getState();
  assert.equal(s2.recoverPhase, 'ready-to-confirm', 'preparing T05 discarded a settled T04 approval');
  assert.equal(s2.restorePhase, 'ready-to-confirm', 'the T05 approval did not settle');
  assert.equal(nodesWithAttr(h.container, 'data-h2o-action', 'recovery-center-recover-as-new').length, 1);
  assert.equal(nodesWithAttr(h.container, 'data-h2o-action', 'recovery-center-restore-original').length, 1);
  assert.equal(h.calls.execute.length, 0, 'preparing armed an import');
  assert.equal(h.calls.restoreExecute.length, 0, 'preparing armed a restore');
});

await checkAsync('76. a late restore RESULT for an abandoned version never renders as the newly selected one', async () => {
  /* The dry-run half of this is check 62. This is the execution half: a restore
   * that was confirmed for A and answers after the operator moved to B must not
   * paint A's outcome — success or refusal — under B. */
  const slow = deferred();
  const h = harness({ restoreExecuteDeferred: slow });
  await previewed(h, 'archive/packages/chat_a.g1.h2ochat');
  await h.card.prepareRestoreOriginalIdentity();
  const inFlight = h.card.restoreOriginalIdentity();
  assert.equal(h.card.getState().restorePhase, 'executing', 'the approval was not consumed synchronously');
  /* The governed call is issued on a microtask, so let it be dispatched before
   * asserting it happened. */
  for (let i = 0; i < 4; i += 1) await Promise.resolve();
  assert.equal(h.calls.restoreExecute.length, 1, 'the execution was not issued');
  await h.card.selectVersion('archive/packages/chat_a.g2.h2ochat');
  slow.resolve({ ok: true, status: 'restored', decision: 'restore-ready',
    restored: { chatId: 'chat_from_A', snapshotId: 'snap_from_A', turnCount: 9 }, reason: '' });
  await inFlight;
  for (let i = 0; i < 12; i += 1) await Promise.resolve();
  const s2 = h.card.getState();
  assert.equal(s2.selectedPackagePath, 'archive/packages/chat_a.g2.h2ochat');
  assert.notEqual(s2.restorePhase, 'success', "a late result painted the abandoned version's success onto a newer one");
  assert.equal(s2.restoreResult, null, 'a late result was retained for a version no longer selected');
  const text = allText(h.container);
  for (const leaked of ['chat_from_A', 'snap_from_A']) {
    assert.ok(!text.includes(leaked), `the abandoned version's result is displayed under a newer selection: ${leaked}`);
  }
  assert.equal(h.calls.restoreExecute.length, 1, 'the selection change issued another restore');
});

await checkAsync('77. a NEWER restore dry-run invalidates the approval the previous one produced', async () => {
  /* Re-preparing must not leave the earlier verdict spendable — neither while
   * the newer dry-run is still in flight, nor after it settles on a refusal. */
  const slow = deferred();
  let seen = 0;
  const h = harness({
    options: {
      dryRunRestore: (input) => {
        seen += 1;
        return seen === 1
          ? Promise.resolve({ ok: true, decision: 'restore-ready', status: 'restore-ready', packagePath: input.packagePath })
          : slow.promise;
      },
    },
  });
  await previewed(h);
  await h.card.prepareRestoreOriginalIdentity();
  assert.equal(h.card.getState().restorePhase, 'ready-to-confirm');
  const second = h.card.prepareRestoreOriginalIdentity();
  const mid = h.card.getState();
  assert.equal(mid.restorePhase, 'preflighting', 'the newer dry-run did not start');
  assert.equal(mid.restoreForPath, '', 'the previous approval survived a newer dry-run');
  assert.equal(nodesWithAttr(h.container, 'data-h2o-action', 'recovery-center-restore-original').length, 0,
    'the mutation control survived a newer dry-run');
  await h.card.restoreOriginalIdentity();
  assert.equal(h.calls.restoreExecute.length, 0, 'the superseded approval was spendable mid-flight');
  slow.resolve({ ok: false, decision: 'conflict-chat-id', status: 'conflict-chat-id', reason: 'r' });
  await second;
  const after = h.card.getState();
  assert.equal(after.restorePhase, 'refused', `expected refused, got ${after.restorePhase}`);
  assert.equal(after.restoreForPath, '');
  await h.card.restoreOriginalIdentity();
  assert.equal(h.calls.restoreExecute.length, 0, 'the superseded approval was spendable after the newer refusal');
  assert.equal(seen, 2, 'the newer dry-run was not actually issued');
});

console.log('');
if (FAIL.length) {
  console.log(`[recovery-center] ${FAIL.length} of ${PASS.length + FAIL.length} checks FAILED`);
  for (const f of FAIL) console.log(`  ✗ ${f.label}: ${f.m}`);
  process.exit(1);
}
console.log(`[recovery-center] PASS ${PASS.length}`);
