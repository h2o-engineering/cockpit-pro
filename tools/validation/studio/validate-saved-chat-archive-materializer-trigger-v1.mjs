#!/usr/bin/env node
// F.1/F.2 — Saved-chat archive MATERIALIZER TRIGGER BOUNDARY validator (static).
//
// The materializer itself (D.2C) already exists and is behaviorally covered by
// validate-saved-chat-archive-materializer-v1.mjs. This validator does NOT
// re-test materializer internals. It locks the Phase F *trigger boundary*: it
// asserts the cross-module invariants that must hold while a validated request
// becomes a materialized package, and — since F.2 — that the ONE trigger is a
// bounded, Desktop-only operator action (no automatic/scanner/watcher trigger).
//
// Checks are labeled [INVARIANT] (must always hold) or [F.2] (the bounded
// operator-action contract). F.1 originally asserted that no trigger existed;
// F.2 flipped that gate to assert the contracted operator action is present
// and correctly bounded.
//
// Static only: reads source, asserts patterns. No runtime, no imports of
// runtime modules, no DB, no network.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), '..', '..', '..');

const MATERIALIZER_REL = 'src-surfaces-base/studio/ingestion/saved-chat-archive-materializer.tauri.js';
const SCANNER_REL = 'src-surfaces-base/studio/ingestion/saved-chat-archive-request-inbox.tauri.js';
const DIAGNOSTICS_REL = 'src-surfaces-base/studio/ingestion/saved-chat-archive-diagnostics.tauri.js';
const HEALTH_UI_REL = 'src-surfaces-base/studio/ingestion/archive-health-ui.studio.js';
const DELIVERY_MV3_REL = 'src-surfaces-base/studio/ingestion/saved-chat-archive-request-delivery.mv3.js';
const STUDIO_HTML_REL = 'src-surfaces-base/studio/studio.html';
const S0F0J_REL = 'src-surfaces-base/studio/S0F0j. 🎬 Library Actions Core - Studio.js';
const S0F1J_REL = 'src-surfaces-base/studio/S0F1j. 🎬 Library Actions - Studio.js';
const ACTION_REL = 'src-surfaces-base/studio/ingestion/saved-chat-archive-materializer-action.studio.js';

const MATERIALIZE_API = 'materializeSavedChatArchiveRequestV1';
/* The governed active-family writer boundary the materializer must publish through. */
const ACTIVE_WRITER_API = 'writeSavedChatPackageForLiveGenerationFamily';
// The Desktop scanner the operator action must NOT auto-invoke.
const SCANNER_API = 'scanSavedChatArchiveRequestInboxV1';
// Chrome intent / read-back / badge APIs the Desktop materializer must never call.
const CHROME_APIS = [
  'deliverSavedChatArchiveRequestV1',
  'readSavedChatArchiveRequestReceiptV1',
  'refreshSavedChatArchiveRequestStatusV1',
  'computeSavedChatArchiveStatusV1',
  'appendSavedChatArchiveStatusBadgeV1',
  'maybeDeliverSavedChatArchiveOnSaveToFolderV1',
];
// The full materializer result-status vocabulary (the trigger result contract).
const RESULT_VOCAB = [
  'written',
  'already-written',
  'failed',
  'needs-desktop-snapshot',
  'db-unavailable',
  'not-eligible',
  'not-found',
];

const PASS = [];
const FAIL = [];
function check(label, fn) {
  try { fn(); PASS.push(label); console.log(`  ✓ ${label}`); }
  catch (e) { const m = e && e.message ? e.message : String(e); FAIL.push({ label, m }); console.log(`  ✗ ${label}`); console.log(`      ${m}`); }
}
async function checkAsync(label, fn) {
  try { await fn(); PASS.push(label); console.log(`  ✓ ${label}`); }
  catch (e) { const m = e?.message ?? String(e); FAIL.push({ label, m }); console.log(`  ✗ ${label}`); console.log(`      ${m}`); }
}

function readRepo(rel) { return fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8'); }
function exists(rel) { return fs.existsSync(path.join(REPO_ROOT, rel)); }
function stripComments(srcText) {
  return String(srcText).replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');
}
function hasStr(text, s) { return text.includes("'" + s + "'") || text.includes('"' + s + '"'); }

const matSrc = readRepo(MATERIALIZER_REL);
const matCode = stripComments(matSrc);
const scannerCode = stripComments(readRepo(SCANNER_REL));
const diagCode = stripComments(readRepo(DIAGNOSTICS_REL));
const healthUiCode = stripComments(readRepo(HEALTH_UI_REL));
const deliveryMv3Code = stripComments(readRepo(DELIVERY_MV3_REL));
const studioHtml = readRepo(STUDIO_HTML_REL);
const s0f0j = readRepo(S0F0J_REL);
const s0f1j = readRepo(S0F1J_REL);
const actionSrc = readRepo(ACTION_REL);
const actionCode = stripComments(actionSrc);

console.log('[archive-materializer-trigger] F.1 boundary checks');

// --- A. Trigger surface exists & is Desktop-only ----------------------------

check('[INVARIANT] materializer module exists and registers ' + MATERIALIZE_API + ' under ingestion', () => {
  assert.ok(exists(MATERIALIZER_REL), 'materializer module missing');
  assert.match(matSrc, new RegExp('H2O\\.Studio\\.ingestion\\.' + MATERIALIZE_API + '\\s*='));
  assert.ok(studioHtml.includes('./ingestion/saved-chat-archive-materializer.tauri.js'), 'studio.html does not load the materializer');
});

check('[INVARIANT] materializer is Desktop/Tauri-only (detectTauri gate, returns when not Tauri)', () => {
  assert.match(matCode, /function detectTauri\s*\(/);
  assert.match(matCode, /__TAURI_INTERNALS__|__TAURI__/);
  assert.match(matCode, /if \(!detectTauri\(\)\) return;/);
});

// --- B. Eligibility contract ------------------------------------------------

check('[INVARIANT] only `validated` is eligible; `written` -> already-written; every other state -> not-eligible; absent -> not-found', () => {
  assert.match(matCode, /STATUS_VALIDATED\s*=\s*['"]validated['"]/);
  assert.match(matCode, /STATUS_WRITTEN\s*=\s*['"]written['"]/);
  // written short-circuits to already-written (idempotent, no writer call)
  assert.match(matCode, /previousStatus\s*===\s*STATUS_WRITTEN/);
  assert.ok(hasStr(matCode, 'already-written'), 'already-written branch missing');
  // anything not validated -> not-eligible (so failed/duplicate/needs-desktop-snapshot/rejected are all rejected)
  assert.match(matCode, /previousStatus\s*!==\s*STATUS_VALIDATED/);
  assert.ok(hasStr(matCode, 'not-eligible'), 'not-eligible branch missing');
  assert.ok(hasStr(matCode, 'not-found'), 'not-found branch missing');
  // re-resolution must also re-validate before writing
  assert.match(matCode, /reStatus\s*!==\s*STATUS_VALIDATED/);
  // there must be NO branch that accepts failed/duplicate as eligible-to-write
  assert.doesNotMatch(matCode, /previousStatus\s*===\s*STATUS_FAILED/, 'failed must not be a write-eligible branch');
  assert.doesNotMatch(matCode, /===\s*['"]duplicate['"]/, 'duplicate must not be a write-eligible branch');
});

check('[INVARIANT] full materializer result-status vocabulary is present', () => {
  for (const s of RESULT_VOCAB) {
    const constName = 'STATUS_' + s.toUpperCase().replace(/-/g, '_');
    assert.ok(hasStr(matCode, s) || matCode.includes(constName), `result status missing: ${s}`);
  }
});

// --- C. Writer boundary -----------------------------------------------------

check('[INVARIANT] the governed active-family writer is the only writer, called once, with snapshotId + policy token + overwrite:false, no content leak', () => {
  /* The writer moved behind the policy-governed active-family boundary
     (`saved-chat-generation-policy.tauri.js`), which forbids overwrite outright,
     requires an unforgeable policy token, and publishes through the trusted
     native generation publisher. The invariant is unchanged — ONE governed
     writer call, carrying only the resolved snapshotId — so it is asserted
     against that boundary rather than the retired literal spelling. */
  const callMatch = matCode.match(
    new RegExp(ACTIVE_WRITER_API + '\\s*\\(\\s*(\\{[\\s\\S]*?\\})\\s*,\\s*([A-Za-z_$][\\w$]*)\\s*,?\\s*\\)'),
  );
  assert.ok(callMatch, 'governed active-family writer call not found');
  const callArgs = callMatch[1];
  assert.match(callArgs, /snapshotId\s*:/);
  assert.match(callArgs, /overwrite\s*:\s*false/);
  for (const banned of ['targetDir', 'targetFolder', 'packagePath', 'manifest', 'contentHash', 'html', 'assets', 'envelope', 'request:', 'payload', 'normalized']) {
    assert.ok(!callArgs.includes(banned), `writer call leaked a non-authoritative source field: ${banned}`);
  }
  /* The family is selected by the trusted policy token, never by the renderer:
     the second argument must be the token read from the policy command. */
  assert.equal(callMatch[2], 'policyToken', 'the writer must receive the trusted policy token');
  assert.match(matCode, /readSavedChatGenerationPolicy\s*\(/, 'the policy token is read, not synthesized');
  assert.equal(
    (matCode.match(new RegExp(ACTIVE_WRITER_API + '\\s*\\(', 'g')) || []).length, 1,
    'writer must be called exactly once',
  );
  /* And nothing bypasses that boundary: no retired direct writer, no direct
     publisher, and no raw native archive write command. */
  for (const bypass of [
    'writeSavedChatPackageV1',
    'publishBuiltSavedChatGeneration',
    'h2o_archive_generation_begin',
    'h2o_archive_generation_write_member',
    'h2o_archive_generation_commit',
    'h2o_archive_durable_write',
  ]) {
    assert.ok(!matCode.includes(bypass), `materializer bypasses the governed writer boundary: ${bypass}`);
  }
});

check('[INVARIANT] overwrite defaults false in the trigger API surface', () => {
  assert.match(matSrc, new RegExp(MATERIALIZE_API + '\\([^)]*overwrite\\s*=\\s*false'));
});

check('[INVARIANT] materializer mutates ONLY saved_chat_archive_requests (no INSERT/DELETE/migration); status+meta_json.materialization patch', () => {
  assert.match(matCode, /var QUEUE_TABLE\s*=\s*['"]saved_chat_archive_requests['"]/);
  assert.doesNotMatch(matCode, /\bINSERT\s+INTO\b|\bDELETE\s+FROM\b|\bUPSERT\b/i, 'no INSERT/DELETE allowed');
  assert.doesNotMatch(matCode, /CREATE\s+TABLE|ALTER\s+TABLE|plugin:sql\|load|MigrationKind/i, 'no migration allowed');
  const updates = matCode.match(/UPDATE\b[^\n]{0,50}/gi) || [];
  assert.ok(updates.length >= 1, 'expected at least one queue UPDATE');
  for (const u of updates) {
    assert.ok(/QUEUE_TABLE/.test(u) || /saved_chat_archive_requests/i.test(u), `UPDATE targets a non-queue table: ${u}`);
  }
  assert.match(matCode, /materialization/);
});

// --- D. No Chrome / read-back coupling --------------------------------------

check('[INVARIANT] materializer does not call any Chrome delivery/read-back/status/badge API', () => {
  for (const api of CHROME_APIS) {
    assert.ok(!matCode.includes(api), `materializer must not reference Chrome API: ${api}`);
  }
});

check('[INVARIANT] materializer result marks chromeRuntime:false, syncTransport:false, packageWriteDeferred:false', () => {
  assert.match(matCode, /chromeRuntime:\s*false/);
  assert.match(matCode, /syncTransport:\s*false/);
  assert.match(matCode, /packageWriteDeferred:\s*false/);
});

check('[INVARIANT] Chrome delivery (mv3) performs no package/CAS/SQLite write and never calls the materializer', () => {
  assert.ok(!deliveryMv3Code.includes(MATERIALIZE_API), 'Chrome delivery must not call the materializer');
  assert.ok(!deliveryMv3Code.includes('writeSavedChatPackageV1'), 'Chrome delivery must not call the package writer');
  assert.doesNotMatch(deliveryMv3Code, /plugin:sql\|/, 'Chrome delivery must not touch Desktop SQLite');
  for (const banned of ['putAssetBytes', 'getAssetBytes', 'asset-cas', 'plugin:fs|write']) {
    assert.ok(!deliveryMv3Code.includes(banned), `Chrome delivery must not write: ${banned}`);
  }
});

// --- E. Scanner stays enqueue-only ------------------------------------------

check('[INVARIANT] scanner stays enqueue-only: packageWriteDeferred:true, materializeTriggered:false, never materializeTriggered:true', () => {
  assert.match(scannerCode, /packageWriteDeferred:\s*true/);
  assert.match(scannerCode, /materializeTriggered:\s*false/);
  assert.doesNotMatch(scannerCode, /materializeTriggered:\s*true/, 'scanner must not flip materializeTriggered true');
});

check('[INVARIANT] scanner does not invoke the materializer or the package writer', () => {
  assert.ok(!scannerCode.includes(MATERIALIZE_API), 'scanner must not call the materializer');
  assert.ok(!scannerCode.includes('writeSavedChatPackageV1'), 'scanner must not call the package writer');
});

// --- F. No watcher / poller / daemon ----------------------------------------

check('[INVARIANT] no automatic watcher/poller/daemon in the materializer or scanner', () => {
  for (const [name, code] of [['materializer', matCode], ['scanner', scannerCode]]) {
    for (const banned of ['setInterval', 'MutationObserver', 'requestAnimationFrame']) {
      assert.ok(!code.includes(banned), `${name} must not use ${banned}`);
    }
  }
});

// --- G. No sync / webdav / native messaging / localhost relay ----------------

check('[INVARIANT] materializer has no sync/webdav/native-messaging/localhost-relay coupling', () => {
  for (const banned of [
    'H2O.Studio.sync', 'webdav', 'WebDAV',
    'connectNative', 'sendNativeMessage', 'chrome.runtime',
    'localhost', '127.0.0.1', 'ws://', 'wss://', 'fetch(',
    'service-worker', 'serviceWorker',
  ]) {
    assert.ok(!matCode.includes(banned), `materializer must not couple to: ${banned}`);
  }
});

// --- H. Bounded operator-action trigger (F.2) -------------------------------
// F.1 asserted NO trigger was wired. F.2 adds exactly one: a bounded,
// Desktop-only operator action in its own module. These checks pin that
// contract and prove no automatic/scanner/watcher trigger crept in.

check('[F.2] operator action module exists, registers archiveMaterializerAction, and is loaded + packed', () => {
  assert.ok(exists(ACTION_REL), 'operator action module missing');
  assert.match(actionSrc, /H2O\.Studio\.archiveMaterializerAction\s*=/);
  assert.match(actionSrc, /renderArchiveMaterializerActionCard/);
  assert.match(actionSrc, /mountArchiveMaterializerActionCard/);
  assert.ok(studioHtml.includes('./ingestion/saved-chat-archive-materializer-action.studio.js'), 'studio.html does not load the operator action module');
});

check('[F.2] operator action invokes the materializer for an explicit requestId (no forced overwrite)', () => {
  assert.ok(actionCode.includes(MATERIALIZE_API), 'operator action must call the materializer');
  assert.match(actionCode, new RegExp(MATERIALIZE_API + '\\s*\\(\\s*\\{\\s*requestId'));
  assert.doesNotMatch(actionCode, /overwrite\s*:\s*true/, 'operator action must not force overwrite:true');
});

check('[F.2] operator action is Desktop/Tauri capability-gated', () => {
  assert.match(actionCode, /function detectTauri\s*\(/);
  assert.match(actionCode, /__TAURI_INTERNALS__|__TAURI__/);
  assert.match(actionCode, /isDesktopCapable/);
});

/* Phase 5 lock-step update. The blanket textual ban on SCANNER_API was a proxy
 * for the real G.0 invariant: the scanner must never run BY ITSELF. It was
 * accurate while nothing invoked the inbox at all — but that also left a
 * producer-delivered request unable to reach the queue through any operator
 * action, which blocked the assembled-system proof. The action may now call the
 * scanner from an explicit click handler; what stays forbidden is automatic
 * invocation, and that is now asserted directly rather than by absence. */
check('[F.2] operator action does NOT auto-call the scanner; selection is restricted to validated rows', () => {
  assert.match(actionCode, /status:\s*['"]validated['"]/);
  // Any scanner call must be reached only from the explicit operator handler.
  const autoTriggers = [
    /addEventListener\(\s*['"]load['"]/,
    /DOMContentLoaded/,
    /setInterval\s*\(/,
    /setTimeout\s*\([^)]*scan/i,
  ];
  for (const re of autoTriggers) {
    assert.doesNotMatch(actionCode, re, `operator action must not auto-trigger: ${re}`);
  }
});

/* ── Phase 5 — explicit operator request-inbox intake ────────────────────── */

check('[P5.1] New UI action is wired to the governed inbox authority', () => {
  assert.ok(actionCode.includes(SCANNER_API), 'action must invoke the governed inbox scanner');
  assert.match(actionCode, /scanRequestInbox\s*:\s*scanRequestInbox/, 'intake must be exported');
  assert.match(actionCode, /data-archive-materializer-intake-run/, 'no New UI control renders the intake');
  assert.ok(hasStr(actionCode, 'Scan request inbox'), 'intake control has no operator-facing label');
});

check('[P5.2] intake is explicit: reached only from a click handler', () => {
  assert.match(actionCode, /intakeBtn[^;]*addEventListener\(\s*['"]click['"]\s*,\s*doScanInbox/,
    'intake must be bound to an explicit click');
  // doScanInbox is the ONLY caller of the intake seam.
  const callers = (actionCode.match(/runIntake\s*\(/g) || []).length;
  assert.equal(callers, 1, `intake seam must have exactly one call site, found ${callers}`);
});

check('[P5.3] no watcher/polling introduced by the intake', () => {
  for (const banned of ['setInterval', 'MutationObserver', 'requestIdleCallback', 'FileSystemObserver']) {
    assert.ok(!actionCode.includes(banned), `intake must not use ${banned}`);
  }
});

check('[P5.4] intake reimplements no admission logic — it delegates entirely', () => {
  // The governed inbox owns parsing, validation, dedupe and enqueue.
  for (const banned of ['enqueueSavedChatArchiveRequestV1', 'INSERT INTO', 'dedupeKey', 'normalizeEnvelope', 'savedChatArchiveRequest.v1']) {
    assert.ok(!actionCode.includes(banned), `intake must not reimplement: ${banned}`);
  }
});

check('[P5.5] intake is bounded and cannot widen the governed scan', () => {
  assert.match(actionCode, /DEFAULT_INTAKE_LIMIT\s*=\s*50/);
  assert.match(actionCode, /MAX_INTAKE_LIMIT\s*=\s*200/);
  assert.match(actionCode, /limit\s*>\s*MAX_INTAKE_LIMIT/, 'intake limit must be clamped');
});

check('[P5.6] intake reports the inbox result vocabulary, not a second state model', () => {
  for (const k of ['scanned', 'processed', 'validated', 'duplicates', 'rejected', 'needsDesktopSnapshot', 'dbUnavailable']) {
    assert.ok(hasStr(actionCode, k), `intake result presentation missing counter: ${k}`);
  }
});

check('[P5.7] intake fails honestly and never manufactures validated state', () => {
  assert.match(actionCode, /inbox-unavailable/, 'must report an unavailable inbox');
  assert.doesNotMatch(actionCode, /validated\s*[:=]\s*true/, 'must never assert validated itself');
  assert.doesNotMatch(actionCode, /status\s*=\s*['"]validated['"]/, 'must never set validated status itself');
});

check('[P5.8] Materialize validated remains a SEPARATE explicit action', () => {
  assert.ok(hasStr(actionCode, 'Materialize validated'), 'batch action must remain');
  assert.match(actionCode, /data-archive-materializer-batch-run/, 'batch control must remain');
  // The intake handler must not materialize.
  const intakeFn = actionCode.slice(actionCode.indexOf('function doScanInbox'));
  const body = intakeFn.slice(0, intakeFn.indexOf('function doLoadValidated'));
  assert.ok(!/materiali/i.test(body), 'intake handler must not materialize');
});

check('[P5.9] intake requires no Legacy UI route', () => {
  // The control lives in the Studio New UI operator card, not a legacy surface.
  assert.ok(actionCode.includes('data-archive-materializer-action-card'), 'control must live on the New UI action card');
  for (const legacy of ['chrome.runtime', 'chrome.storage', 'browser.runtime']) {
    assert.ok(!actionCode.includes(legacy), `intake must not depend on ${legacy}`);
  }
});

check('[F.2] operator action has no watcher/poller/daemon (no automatic materialization)', () => {
  for (const banned of ['setInterval', 'setTimeout', 'MutationObserver', 'requestAnimationFrame', 'requestIdleCallback']) {
    assert.ok(!actionCode.includes(banned), `operator action must not use ${banned}`);
  }
});

check('[F.2] operator action surfaces the full materializer result vocabulary + invalid-state', () => {
  for (const s of RESULT_VOCAB) {
    assert.ok(hasStr(actionCode, s), `operator action result presentation missing: ${s}`);
  }
  assert.ok(hasStr(actionCode, 'invalid-state'), 'operator action must surface invalid-state');
});

check('[F.2] operator action has no writer/Chrome/sync/webdav/native coupling', () => {
  assert.ok(!actionCode.includes('writeSavedChatPackageV1'), 'operator action must not call the package writer directly');
  for (const api of CHROME_APIS) {
    assert.ok(!actionCode.includes(api), `operator action must not reference Chrome API: ${api}`);
  }
  for (const banned of [
    'H2O.Studio.sync', 'webdav', 'WebDAV', 'connectNative', 'sendNativeMessage',
    'chrome.runtime', 'localhost', '127.0.0.1', 'ws://', 'wss://', 'fetch(',
    'plugin:fs|write', 'putAssetBytes', 'getAssetBytes',
  ]) {
    assert.ok(!actionCode.includes(banned), `operator action must not couple to: ${banned}`);
  }
});

check('[F.2] Archive Health UI stays read-only but delegates to the separate operator action', () => {
  assert.ok(healthUiCode.includes('mountArchiveMaterializerActionCard'), 'health UI must delegate to the operator action module');
  assert.ok(!healthUiCode.includes(MATERIALIZE_API), 'health UI must not call the materializer directly');
  assert.ok(!healthUiCode.includes('writeSavedChatPackageV1'), 'health UI must not call the package writer');
});

// --- I. Permanent boundaries (diagnostics + mega-files never trigger) --------

check('[INVARIANT] Archive diagnostics remains read-only: does not call the materializer', () => {
  assert.ok(!diagCode.includes(MATERIALIZE_API), 'diagnostics must not call the materializer');
});

check('[INVARIANT] library action mega-files (S0F0j / S0F1j) do not wire the materializer', () => {
  assert.ok(!s0f0j.includes(MATERIALIZE_API), 'S0F0j must not wire the materializer');
  assert.ok(!s0f1j.includes(MATERIALIZE_API), 'S0F1j must not wire the materializer');
});

/* ── Phase 5 repair — BEHAVIORAL proof of the intake wrapper ───────────────
 * The original P5 regressions asserted the wiring by scanning source text and
 * exercised the governed scanner separately, so nothing ever EXECUTED
 * scanRequestInbox. A ReferenceError on its first line (an undefined
 * safeObject carried over from sibling modules) therefore shipped: the button
 * threw on every click while every check stayed green. These run the wrapper. */
function loadActionCard({ scanImpl }) {
  const ctx = {
    console, JSON, Date, Math, Promise, Object, Array, String, Number, Boolean,
    Error, isFinite, parseInt, setTimeout,
    H2O: { Studio: { ingestion: { scanSavedChatArchiveRequestInboxV1: scanImpl } } },
    __TAURI_INTERNALS__: { invoke: async () => { throw new Error('no invoke in this harness'); } },
  };
  ctx.globalThis = ctx; ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(REPO_ROOT, ACTION_REL), 'utf8'), ctx, { filename: ACTION_REL });
  return ctx.H2O.Studio.archiveMaterializerAction;
}

await checkAsync('[P5.R1] wrapper executes, delegates exactly once, and preserves the governed result', async () => {
  const calls = [];
  const governed = {
    ok: true, status: 'completed', scanned: 1, processed: 1, validated: 1,
    duplicates: 0, rejected: 0, needsDesktopSnapshot: 0, dbUnavailable: 0,
    receiptsWritten: 1, materializeTriggered: false, packageWriteDeferred: true,
    blockers: [], warnings: [],
  };
  const api = loadActionCard({ scanImpl: async (opts) => { calls.push(opts); return governed; } });
  assert.equal(typeof api.scanRequestInbox, 'function', 'wrapper not exported');

  const res = await api.scanRequestInbox({ limit: 50 });   // must not throw

  assert.equal(calls.length, 1, `expected exactly one delegation, got ${calls.length}`);
  assert.equal(calls[0].limit, 50, 'bounded limit not passed through');
  assert.equal(res.status, 'completed', 'governed result not preserved');
  assert.equal(res.validated, 1);
  assert.equal(res.materializeTriggered, false, 'intake must never materialize');
  assert.equal(res.packageWriteDeferred, true);
});

await checkAsync('[P5.R2] wrapper clamps the bound and survives absent/garbage options', async () => {
  const calls = [];
  const api = loadActionCard({ scanImpl: async (opts) => { calls.push(opts); return { ok: true, status: 'completed', scanned: 0, processed: 0 }; } });
  await api.scanRequestInbox();                 // no argument at all
  await api.scanRequestInbox(null);
  await api.scanRequestInbox('nonsense');
  await api.scanRequestInbox({ limit: 9999 });  // above MAX
  await api.scanRequestInbox({ limit: 0 });     // below MIN
  assert.equal(calls.length, 5, 'every call must reach the governed scanner');
  assert.deepEqual(calls.map((c) => c.limit), [50, 50, 50, 200, 50], 'limit defaulting/clamping is wrong');
});

await checkAsync('[P5.R3] an absent governed scanner is reported, not thrown', async () => {
  const api = loadActionCard({ scanImpl: undefined });
  const res = await api.scanRequestInbox({ limit: 50 });
  assert.equal(res.status, 'inbox-unavailable');
  assert.equal(res.unavailable, true);
});

await checkAsync('[P5.R4] a scanner throw surfaces the REAL error and never claims an empty inbox', async () => {
  const api = loadActionCard({ scanImpl: async () => { throw new Error('capability denied: read_dir'); } });
  let threw = false, res = null;
  try { res = await api.scanRequestInbox({ limit: 50 }); } catch (_) { threw = true; }
  // The wrapper itself propagates; the card's handler is what converts it to a
  // failed result. Either way the error text must survive to presentation.
  const src = actionCode;
  assert.match(src, /error:\s*String\(\(err && err\.message\)/, 'handler must capture the error message');
  assert.match(src, /var threwError = cleanString\(r\.error\)/, 'presentation must read the captured error');
  assert.match(src, /if \(threwError\) \{[\s\S]{0,400}?escapeHtml\(threwError\)/, 'presentation must render the real error');
  // And the empty-inbox text must be the ELSE branch, never shown on a throw.
  assert.match(src, /\} else if \(num\(r\.processed\) === 0\) \{/, 'empty-inbox text must be mutually exclusive with the error branch');
  assert.ok(threw || (res && res.status), 'wrapper must either propagate or return a status');
});

await checkAsync('[P5.R5] NEGATIVE CONTROL — an undefined identifier in the wrapper fails this suite', async () => {
  /* Reproduces the exact shipped defect class: the wrapper body referencing a
   * helper this module does not define. If the behavioural tests above could
   * not see that, they would not have caught the original bug either. */
  /* Anchor the mutation INSIDE scanRequestInbox. The module uses this same
   * options idiom in several functions, so an unanchored replace silently
   * mutates a different one and the control proves nothing. */
  const src = fs.readFileSync(path.join(REPO_ROOT, ACTION_REL), 'utf8');
  const fnStart = src.indexOf('async function scanRequestInbox');
  assert.ok(fnStart > 0, 'wrapper not found');
  const optsLine = "var opts = (options && typeof options === 'object') ? options : {};";
  const optsAt = src.indexOf(optsLine, fnStart);
  assert.ok(optsAt > fnStart && optsAt < fnStart + 800, 'options line not found inside the wrapper');
  const broken = src.slice(0, optsAt) + 'var opts = safeObject(options);' + src.slice(optsAt + optsLine.length);
  assert.ok(broken.slice(fnStart, fnStart + 800).includes('safeObject(options)'),
    'mutation did not land inside the wrapper');
  const ctx = {
    console, JSON, Date, Math, Promise, Object, Array, String, Number, Boolean, Error, isFinite, parseInt, setTimeout,
    H2O: { Studio: { ingestion: { scanSavedChatArchiveRequestInboxV1: async () => ({ ok: true, status: 'completed', scanned: 1, processed: 1 }) } } },
    __TAURI_INTERNALS__: { invoke: async () => { throw new Error('no invoke'); } },
  };
  ctx.globalThis = ctx; ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(broken, ctx, { filename: 'MUTANT-' + ACTION_REL });
  let caught = null;
  try { await ctx.H2O.Studio.archiveMaterializerAction.scanRequestInbox({ limit: 50 }); }
  catch (e) { caught = e; }
  assert.ok(caught, 'the broken wrapper MUST throw — otherwise this suite cannot catch the shipped defect class');
  assert.match(String(caught.message), /safeObject is not defined/, `expected ReferenceError, got: ${caught && caught.message}`);
});


console.log('');
if (FAIL.length) {
  console.error(`[archive-materializer-trigger] ${FAIL.length} failed, ${PASS.length} passed`);
  process.exitCode = 1;
} else {
  console.log(`[archive-materializer-trigger] PASS ${PASS.length} checks`);
}
