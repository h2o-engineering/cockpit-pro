#!/usr/bin/env node
/*
 * Governed Desktop maintenance suppression — disposable validation.
 *
 * Proves that with persisted Sync config genuinely `mode:"auto"`, an engaged
 * maintenance window leaves the accepted P01 automatic writer incapable of any
 * mutation, through every wired trigger; and that with suppression absent the
 * accepted behaviour is unchanged.
 *
 * Disposable in-memory runtime only. No canonical app-data, no SQLite, no
 * migration, no V7/V8, no WebDAV.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const coreSource = fs.readFileSync(
  path.join(root, 'src-surfaces-base/studio/sync/sync-linear-reconcile-core.js'), 'utf8');
const source = fs.readFileSync(
  path.join(root, 'src-surfaces-base/studio/sync/sync-object-auto-reconcile.js'), 'utf8');

let assertions = 0;
const scenarios = [];
function check(v, m) { assert.ok(v, m); assertions += 1; }
function equal(a, b, m) { assert.equal(a, b, m); assertions += 1; }
function deepEqual(a, b, m) { assert.deepEqual(a, b, m); assertions += 1; }
function scenario(n) { scenarios.push(n); }

/*
 * Desktop harness with a real native seam. `suppression` selects what the
 * maintenance command does: 'engaged', 'absent-command', 'not-engaged',
 * or 'throws' (the fail-closed case).
 */
function makeDesktop({ mode = 'auto', suppression = 'not-engaged' } = {}) {
  let timerId = 0;
  const timers = new Map();
  const windowListeners = new Map();
  const documentListeners = new Map();
  const folderListeners = new Set();
  const operations = [];
  const invokeCalls = [];
  const config = Object.freeze({ schemaVersion: 1, mode });
  const identity = Object.freeze({ installId: 'disposable-install', syncPeerId: 'disposable-peer' });
  const destination = Object.freeze({ canonicalPath: '/disposable/container', valid: true });
  const anchor = { current: { classification: 'LOCAL_UNPUBLISHED_CHANGE', revisionId: 'r1',
    localPublishedMatch: false, remoteAppliedMatch: false } };

  const delivery = () => ({
    rehydrateDestinationAuthorization: async () => ({ valid: true, status: 'authorized' }),
    destinationAuthorizationSnapshot: () => ({ valid: true, status: 'authorized' }),
    receiveLocalPublication: async () => { operations.push('receive'); return { ok: true, verdict: 'local-publication-absent' }; },
    readLineage: async () => ({ ok: true, currentRevisionId: null, currentRevisionBlobSha256Hex: null }),
    prepareLocalBrowserDelivery: async () => {
      operations.push('publish'); anchor.current.localPublishedMatch = true;
      return { ok: true, verdict: 'published' };
    }
  });

  const H2O = {
    Studio: {
      sync: {
        /* Canonical mode authority: genuinely reports auto. Untouched. */
        getAutomaticModeAuthority: async () => ({
          loaded: true, valid: true, mode: config.mode,
          automaticExportEnabled: config.mode === 'auto'
        }),
        folder: { subscribe(l) { folderListeners.add(l); return () => folderListeners.delete(l); } },
        identity, destination
      },
      platform: { env: { isTauri: true } },
      getPublicationTarget: () => ({ chatId: 'object-a' }),
      store: {}
    },
    Desktop: {
      Sync: { round2aReady: Promise.resolve() },
      SyncObjectDelivery: delivery(),
      SyncObjectRuntime: {
        applyNextAdmittedLocalRevision: async () => { operations.push('apply'); return { ok: true, verdict: 'no-eligible-revision' }; },
        resolveCanonicalAnchor: async () => { operations.push('anchor'); return { ...anchor.current }; }
      }
    }
  };

  const internals = suppression === 'absent-command'
    ? undefined
    : {
      invoke: async (command) => {
        invokeCalls.push(command);
        if (suppression === 'throws') throw new Error('native-unavailable');
        return {
          schema: 'h2o.studio.syncMaintenanceSuppression.v1',
          suppressed: suppression === 'engaged',
          reason: suppression === 'engaged' ? 'governed-maintenance-window' : 'not-engaged',
          ephemeral: true,
          persistedConfigurationChanged: false
        };
      }
    };

  const context = {
    H2O,
    __TAURI__: {},
    __TAURI_INTERNALS__: internals,
    location: { protocol: 'tauri:' },
    navigator: { locks: { request: async (_n, _o, cb) => cb() } },
    document: {
      readyState: 'complete', visibilityState: 'visible',
      addEventListener(n, l) { documentListeners.set(n, l); },
      removeEventListener(n) { documentListeners.delete(n); },
      createElement: () => ({}), head: { appendChild: (s) => { s.onload?.(); return s; } }
    },
    setTimeout(cb) { const id = ++timerId; timers.set(id, cb); return id; },
    clearTimeout(id) { timers.delete(id); },
    addEventListener(n, l) { windowListeners.set(n, l); },
    removeEventListener(n) { windowListeners.delete(n); },
    console
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(coreSource, context, { filename: 'sync-linear-reconcile-core.js' });
  vm.runInContext(source, context, { filename: 'sync-object-auto-reconcile.js' });

  const api = context.H2O.Studio.sync.objectAutoReconcile;
  async function drain() {
    for (let pass = 0; pass < 6; pass += 1) {
      const pending = [...timers.entries()];
      timers.clear();
      for (const [, cb] of pending) cb();
      await new Promise((r) => setImmediate(r));
    }
  }
  return { context, api, timers, windowListeners, documentListeners, folderListeners,
    operations, invokeCalls, config, identity, destination, drain };
}

/* ---------- suppression ENGAGED, persisted mode really is auto ---------- */
async function verifySuppressionActive() {
  const triggers = [
    ['bootstrap', async (h) => { await h.drain(); }],
    ['focus', async (h) => { h.windowListeners.get('focus')?.(); await h.drain(); }],
    ['visibilitychange', async (h) => { h.documentListeners.get('visibilitychange')?.(); await h.drain(); }],
    ['library-index event', async (h) => { h.windowListeners.get('evt:h2o:library-index:updated')?.(); await h.drain(); }],
    ['cross-surface sync event', async (h) => { h.windowListeners.get('evt:h2o:library:cross-surface-sync')?.(); await h.drain(); }],
    ['reader-refresh event', async (h) => { h.windowListeners.get('evt:h2o:studio:reader-refresh-requested')?.(); await h.drain(); }],
    ['publication wake', async (h) => {
      for (const l of h.folderListeners) l({ kind: 'object-local-publication-available' });
      await h.drain();
    }],
    ['explicit scheduleReconcile', async (h) => { h.api.scheduleReconcile('manual-trigger'); await h.drain(); }]
  ];
  for (const [label, fire] of triggers) {
    const h = makeDesktop({ mode: 'auto', suppression: 'engaged' });
    await fire(h);
    equal(h.operations.length, 0,
      `${label}: suppression blocks every P01 operation (receive/apply/publish)`);
  }

  /* The authority itself reports not-authorized while config still says auto. */
  const h = makeDesktop({ mode: 'auto', suppression: 'engaged' });
  equal(await h.api.__test.readMaintenanceSuppression(), true, 'maintenance suppression is engaged');
  equal(await h.api.__test.readAutoAuthority(), false,
    'automatic authority is denied while suppressed');
  const result = await h.api.__test.run('probe', 0);
  equal(result.verdict, 'automatic-disabled', 'run() refuses before any mutation');
  equal(h.operations.length, 0, 'no P01 automatic publication occurred');

  /* Coalescing / repeated triggers cannot accumulate into a mutation. */
  for (let i = 0; i < 5; i += 1) h.api.scheduleReconcile('repeat-' + i);
  await h.drain(); await h.drain();
  equal(h.operations.length, 0, 'coalesced and repeated scheduling stays suppressed');

  /* Nothing persisted was touched. */
  deepEqual({ ...h.config }, { schemaVersion: 1, mode: 'auto' },
    'persisted Sync configuration remains mode:auto and unchanged');
  deepEqual({ ...h.identity }, { installId: 'disposable-install', syncPeerId: 'disposable-peer' },
    'peer/install identity unchanged');
  deepEqual({ ...h.destination }, { canonicalPath: '/disposable/container', valid: true },
    'destination authorization unchanged');
  scenario('MS-S01 suppression engaged: every wired trigger yields zero P01 operations');
}

/* ---------- suppression ABSENT: accepted behaviour unchanged ---------- */
async function verifyNormalBehaviourUnchanged() {
  /* No native command at all — the accepted world. */
  const legacy = makeDesktop({ mode: 'auto', suppression: 'absent-command' });
  equal(await legacy.api.__test.readMaintenanceSuppression(), false,
    'absent native seam is never treated as suppression');
  equal(await legacy.api.__test.readAutoAuthority(), true,
    'mode:auto still yields automatic authority without the seam');
  await legacy.drain();
  check(legacy.operations.length > 0,
    'accepted Auto behaviour still performs P01 work when not suppressed');

  /* Command present and explicitly not engaged. */
  const live = makeDesktop({ mode: 'auto', suppression: 'not-engaged' });
  equal(await live.api.__test.readAutoAuthority(), true,
    'mode:auto with suppression not engaged retains authority');
  await live.drain();
  check(live.operations.length > 0, 'normal Auto behaviour is unchanged');

  /* Other canonical modes keep their meaning. */
  for (const mode of ['manual', 'notify', 'off']) {
    const h = makeDesktop({ mode, suppression: 'not-engaged' });
    equal(await h.api.__test.readAutoAuthority(), false,
      `${mode} remains non-automatic (canonical meaning unchanged)`);
    await h.drain();
    equal(h.operations.length, 0, `${mode} performs no automatic P01 work`);
  }
  scenario('MS-S02 suppression absent: auto/manual/notify/off semantics unchanged');
}

/* ---------- fail-closed ---------- */
async function verifyFailClosed() {
  const broken = makeDesktop({ mode: 'auto', suppression: 'throws' });
  equal(await broken.api.__test.readMaintenanceSuppression(), true,
    'a failing maintenance probe fails CLOSED (assumed suppressed)');
  equal(await broken.api.__test.readAutoAuthority(), false,
    'unprovable suppression state denies automatic authority');
  await broken.drain();
  equal(broken.operations.length, 0, 'fail-closed performs no P01 work');

  /* Resolved once: the answer cannot flip mid-process. */
  const stable = makeDesktop({ mode: 'auto', suppression: 'engaged' });
  await stable.api.__test.readMaintenanceSuppression();
  await stable.api.__test.readMaintenanceSuppression();
  await stable.api.__test.readMaintenanceSuppression();
  equal(stable.invokeCalls.length, 1,
    'suppression is resolved once per process and cannot race');
  scenario('MS-S03 fail-closed on probe failure; resolved exactly once');
}

/* ---------- P02 / safety isolation ---------- */
async function verifySafetyIsolation() {
  const h = makeDesktop({ mode: 'auto', suppression: 'engaged' });
  await h.drain();
  deepEqual([...new Set(h.invokeCalls)], ['h2o_sync_maintenance_suppression'],
    'the only native command this path invokes is the maintenance probe');

  const rust = fs.readFileSync(
    path.join(root, 'apps/studio/desktop/src-tauri/src/sync_maintenance_suppression.rs'), 'utf8');
  /* Scan CODE, not prose: the doc comment legitimately names what the seam is
   * for, so comment text must be stripped before asserting capability absence. */
  const rustCode = rust
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');
  for (const forbidden of [
    'library.info', 'h2o-object-sync', 'sqlx', 'studio-v1.db',
    'fs::write', 'fs::create_dir', 'create_dir_all', 'reqwest', 'http'
  ]) {
    check(!rustCode.includes(forbidden),
      `the maintenance authority has no ${forbidden} capability in code`);
  }
  check(!/\buse std::fs\b/.test(rustCode) && !/\buse std::net\b/.test(rustCode),
    'the maintenance authority imports no filesystem or network capability');
  check(rust.includes('persisted_configuration_changed: false'),
    'the authority declares it changes no persisted configuration');
  check(!rust.includes('env::set_var'),
    'the authority never writes its own environment');
  scenario('MS-S04 the seam has no persistence, migration, V7/V8 or WebDAV capability');
}

/* ---------- no bypass ---------- */
function verifyNoBypass() {
  /* Every automatic path in the module reaches mutation through
   * generationMayMutate() -> readAutoAuthority(), which is where the gate is. */
  const gated = source.slice(source.indexOf('async function readAutoAuthority'));
  check(/if \(await readMaintenanceSuppression\(\)\) return false;/.test(gated),
    'the suppression check is the first statement of the central authority');
  const mayMutate = (source.match(/mayMutate: function \(\) \{\s*return generationMayMutate/g) || []);
  equal(mayMutate.length, 2,
    'both Desktop and Chrome reconcile paths gate mutation through generationMayMutate');
  check(/async function generationMayMutate[\s\S]*?await readAutoAuthority\(\) === true/.test(source),
    'generationMayMutate defers to the central authority');
  check(/async function run\([\s\S]*?if \(!await generationMayMutate\(expectedGeneration\)\)/.test(source),
    'run() refuses before taking mutation ownership');
  /* No scheduling path calls the reconcile engine without run(). Accepted
   * source takes ownership in exactly two places, both inside run() and both
   * after its generationMayMutate() refusal: the Desktop branch and the
   * Chrome branch inside the P01 admission lease. Nothing outside run()
   * takes it. */
  equal((source.match(/withMutationOwnership\(/g) || []).length, 3,
    'mutation ownership is taken in exactly two places (definition + Desktop use + Chrome use)');
  const runBody = source.slice(source.indexOf('async function run('));
  const runEnd = runBody.indexOf('\n  }\n');
  const runOnly = runBody.slice(0, runEnd);
  equal((runOnly.match(/withMutationOwnership\(/g) || []).length, 2,
    'both mutation-ownership uses live inside run()');
  check(runOnly.indexOf('if (!await generationMayMutate(expectedGeneration))') <
    runOnly.indexOf('withMutationOwnership('),
  'run() refuses via generationMayMutate() before either use takes ownership');
  equal((source.slice(0, source.indexOf('async function run(')).match(/withMutationOwnership\(/g) || []).length, 1,
    'before run() the only occurrence is the definition itself');
  equal((source.slice(source.indexOf('async function run(') + runEnd).match(/withMutationOwnership\(/g) || []).length, 0,
    'no scheduling path after run() takes mutation ownership directly');
  scenario('MS-S05 single centralized gate with no bypass around it');
}

async function main() {
  await verifySuppressionActive();
  await verifyNormalBehaviourUnchanged();
  await verifyFailClosed();
  await verifySafetyIsolation();
  verifyNoBypass();
  console.log(JSON.stringify({
    verdict: 'SYNC_MAINTENANCE_SUPPRESSION_PASS',
    assertions,
    deterministicScenarios: scenarios.length,
    scenarios,
    canonicalAppDataTouched: false,
    migrationExecuted: false,
    persistedConfigurationChanged: false,
    v7Executed: false,
    v8Artifacts: false,
    webDavContacted: false
  }, null, 2));
}

await main();
