#!/usr/bin/env node
/*
 * New UI Desktop P02 Apply — Round 2A projection wiring.
 *
 * Live operational verification on canonical main 47854f9b: Receive from Chrome
 * completed (objects admitted 1, apply candidates 1) and Apply then blocked with
 * round2a-projection-unavailable (canonical import attempts 0, repository
 * writes 0). The canonical runtime resolves H2O.Desktop.SyncObjectProjection
 * lazily and fails closed when it is absent. The Legacy operator entrypoint used
 * to preload that module and publish H2O.Desktop.Sync.round2aReady; the New UI
 * Local Folder panel loads only sync-object-runtime.tauri.js and then imports
 * the Desktop reverse facade, so nothing on the canonical surface guaranteed the
 * projection. The facade now owns that guarantee for the runtime members it
 * consumes.
 *
 * This proof drives the REAL projection module, the REAL canonical runtime and
 * the REAL facade seams in a synthetic Desktop: projection initially absent,
 * Apply invoked, and the canonical runtime reached with its dependency
 * satisfied. It publishes nothing, applies nothing and touches no store.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { stagePackedGraph } from './p02-dist-graph.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const RUNTIME_REL = 'src-surfaces-base/studio/sync/sync-object-runtime.tauri.js';
const PROJECTION_REL = 'src-surfaces-base/studio/sync/sync-object-projection.tauri.js';
const FACADE_REL = 'src-surfaces-base/studio/sync/sync-reverse-desktop-v2.tauri.mjs';
const PANEL_REL = 'src-surfaces-base/studio/settings/local-folder-sync.panel.js';
const LEGACY_REL = 'src-surfaces-base/studio/sync/manual-sync-ui.tauri.js';
const PROJECTION_ASSET = '/sync/sync-object-projection.tauri.js';
const OBJECT_ID = 'chat-projection-wiring-fixture';
const OBJECT_DOMAIN = 'studio.chat.saved-state.v1';
const LOCAL_PEER = 'studio-desktop:tauri-desktop:sqlite:00000000-0000-4000-8000-000000000001';
const STOP = 'harness-stop-after-projection';

const failures = [];
let assertions = 0;
const check = (condition, label) => {
  assertions += 1;
  if (!condition) failures.push(label);
};
const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');

/* ── A. the composition contract on canonical source ─────────────────── */
{
  const runtime = read(RUNTIME_REL);
  const projectionGate = runtime.slice(runtime.indexOf('function projection()'),
    runtime.indexOf('function stores()'));
  check(projectionGate.includes("if (!api) fail('round2a-projection-unavailable')"),
    'A1 the canonical runtime fails closed when H2O.Desktop.SyncObjectProjection is absent');
  const panel = read(PANEL_REL);
  const loaderStart = panel.indexOf('async function desktopP02ReverseRuntime()');
  const loader = panel.slice(loaderStart, panel.indexOf('return runtime;', loaderStart));
  check(loader.includes('loadScriptOnce("./sync/sync-object-runtime.tauri.js"'),
    'A2 the New UI Local Folder panel loads only the canonical runtime script');
  check(loader.includes('import("../sync/sync-reverse-desktop-v2.tauri.mjs")'),
    'A3 and then imports the Desktop reverse facade');
  check(!loader.includes('sync-object-projection') && !loader.includes('round2aReady'),
    'A4 the panel itself guarantees no projection - the facade must');
  const legacy = read(LEGACY_REL);
  check(!/round2aReady\s*=/.test(legacy) && !legacy.includes('sync-object-projection.tauri.js'),
    'A5 the canonical Legacy entrypoint publishes no round2aReady preload (the Round 2A operator hunk is not admitted)');
  const facade = read(FACADE_REL);
  const installer = facade.slice(facade.indexOf('export function installDesktopP02Reverse('));
  check(installer.includes('const canonicalApply = projectionGuardedRuntime(scope, canonicalRuntime);'),
    'A6 the facade hands the factory the projection-guarded canonical runtime members');
  check(installer.includes("typeof canonicalRuntime?.applyNextAdmittedP02Revision !== 'function'") &&
    installer.includes("fail('p02-desktop-reverse-runtime-unavailable')"),
    'A7 the facade readiness gate is unchanged');
  const guard = facade.slice(facade.indexOf('export function projectionGuardedRuntime('),
    facade.indexOf('export function installDesktopP02Reverse('));
  check(guard.includes('resolveCanonicalAnchor: async (objectId, options) => {') &&
    guard.includes('applyNextAdmittedP02Revision: async (objectId) => {') &&
    (guard.match(/await ensureRound2AProjection\(scope\);/g) || []).length === 2,
    'A8 both consumed runtime members await the projection guarantee before delegating');
  check(facade.includes("const ROUND2A_PROJECTION_ASSET = '/sync/sync-object-projection.tauri.js';"),
    'A9 the projection is attached from the governed root asset namespace');
}

/* ── synthetic Desktop: real runtime, projection initially absent ─────── */
function makeDesktop({ projectionLoad = 'ok', round2aReady = null } = {}) {
  const calls = [];
  const loads = [];
  const candidateRequests = [];
  const sandbox = {
    console, crypto: crypto.webcrypto, TextEncoder, TextDecoder, structuredClone,
    setTimeout, clearTimeout, queueMicrotask,
    H2O: {
      Studio: {
        store: {},
        identity: {
          whenReady: async () => ({ syncPeerId: LOCAL_PEER }),
          authority: () => ({ desktop: true, canonical: true, status: 'canonical' }),
          get: () => ({ syncPeerId: LOCAL_PEER })
        },
        sync: {}
      },
      Desktop: {}
    },
    __TAURI_INTERNALS__: {
      invoke: async (command, args) => {
        calls.push({ command, args });
        if (command === 'h2o_sync_object_runtime_session') return { bootId: 'projection-wiring-boot' };
        if (command === 'plugin:sql|execute') return [1, 0];
        if (command === 'plugin:sql|select') return [];
        throw new Error(`unexpected command: ${command}`);
      }
    }
  };
  sandbox.globalThis = sandbox;
  sandbox.window = sandbox;
  sandbox.document = {
    createElement(tag) { return { tagName: tag, async: true, src: '', onload: null, onerror: null }; },
    head: {
      appendChild(script) {
        loads.push(script.src);
        if (projectionLoad === 'fail' || script.src !== PROJECTION_ASSET) {
          queueMicrotask(() => script.onerror && script.onerror(new Error('asset-not-found')));
          return script;
        }
        try {
          if (projectionLoad === 'ok') {
            vm.runInContext(read(PROJECTION_REL), sandbox, { filename: 'sync-object-projection.tauri.js' });
          }
          queueMicrotask(() => script.onload && script.onload());
        } catch (error) {
          queueMicrotask(() => script.onerror && script.onerror(error));
        }
        return script;
      }
    },
    documentElement: { appendChild(script) { return sandbox.document.head.appendChild(script); } }
  };
  vm.createContext(sandbox);
  vm.runInContext(read(RUNTIME_REL), sandbox, { filename: 'sync-object-runtime.tauri.js' });
  if (round2aReady) sandbox.H2O.Desktop.Sync = { round2aReady: round2aReady(sandbox) };
  /* The P02 local source the runtime pulls from: it records the request the
   * runtime built (which needs the projection's objectKeyHex) and stops the
   * pass there - nothing is applied. */
  sandbox.H2O.Desktop.SyncObjectP02LocalSource = Object.freeze({
    sourceKind: 'p02-admitted-local',
    readCandidate: async (request) => {
      candidateRequests.push(request);
      const error = new Error(STOP); error.code = STOP; throw error;
    }
  });
  return { sandbox, calls, loads, candidateRequests };
}

const packed = stagePackedGraph();
const facade = await packed.importPacked('sync/sync-reverse-desktop-v2.tauri.mjs');
check(typeof facade.ensureRound2AProjection === 'function' &&
  typeof facade.projectionGuardedRuntime === 'function',
  'B0 the facade exports its projection guarantee seams');

/* ── B. Apply with the projection initially absent ───────────────────── */
{
  const desktop = makeDesktop();
  const runtime = desktop.sandbox.H2O.Desktop.SyncObjectRuntime;
  check(typeof runtime?.applyNextAdmittedP02Revision === 'function',
    'B1 the real canonical runtime is loaded');
  check(!desktop.sandbox.H2O.Desktop.SyncObjectProjection,
    'B2 the projection is initially unavailable - the live defect precondition');
  let direct = null;
  try { await runtime.applyNextAdmittedP02Revision(OBJECT_ID); }
  catch (error) { direct = error?.code || error?.message; }
  check(direct === 'round2a-projection-unavailable',
    'B3 the unguarded runtime reproduces the live failure exactly');
  check(desktop.loads.length === 0, 'B4 the runtime itself attaches no projection');

  const guarded = facade.projectionGuardedRuntime(desktop.sandbox, runtime);
  let outcome = null;
  try { await guarded.applyNextAdmittedP02Revision(OBJECT_ID); }
  catch (error) { outcome = error?.code || error?.message; }
  check(outcome !== 'round2a-projection-unavailable',
    'B5 the guarded Apply no longer fails on the projection dependency');
  check(outcome === STOP,
    `B6 the canonical runtime was reached and stopped only at the local source (got ${outcome})`);
  check(desktop.loads.length === 1 && desktop.loads[0] === PROJECTION_ASSET,
    'B7 exactly one projection asset was attached, from the governed root namespace');
  check(!!desktop.sandbox.H2O.Desktop.SyncObjectProjection,
    'B8 H2O.Desktop.SyncObjectProjection is available after the guarantee');
  check(desktop.calls.some((c) => c.command === 'h2o_sync_object_runtime_session'),
    'B9 the runtime session was opened - the pass ran inside the canonical runtime');
  check(desktop.candidateRequests.length === 1 &&
    desktop.candidateRequests[0].objectId === OBJECT_ID &&
    desktop.candidateRequests[0].objectKeyHex === sha256(`${OBJECT_DOMAIN}\u0000${OBJECT_ID}`),
    'B10 the runtime computed the object key through the freshly attached projection');
  check(desktop.calls.every((c) => c.command !== 'plugin:sql|execute' ||
    !/INSERT INTO chats|INSERT INTO snapshots|last_applied_revision_id = \?/.test(c.args?.query || '')),
    'B11 nothing was applied and no canonical row was written');

  let second = null;
  try { await guarded.applyNextAdmittedP02Revision(OBJECT_ID); }
  catch (error) { second = error?.code || error?.message; }
  check(second === STOP && desktop.loads.length === 1,
    'B12 a second Apply reuses the attached projection - no second load');

  /* The anchor member consumed by Receive classification is guarded too. */
  const fresh = makeDesktop();
  const freshGuarded = facade.projectionGuardedRuntime(fresh.sandbox, fresh.sandbox.H2O.Desktop.SyncObjectRuntime);
  let anchorError = null;
  try { await freshGuarded.resolveCanonicalAnchor(OBJECT_ID); }
  catch (error) { anchorError = error?.code || error?.message; }
  check(anchorError !== 'round2a-projection-unavailable' && fresh.loads.length === 1 &&
    !!fresh.sandbox.H2O.Desktop.SyncObjectProjection,
    `B13 resolveCanonicalAnchor also guarantees the projection first (got ${anchorError})`);
}

/* ── C. fail-closed when the projection cannot be attached ───────────── */
{
  const desktop = makeDesktop({ projectionLoad: 'fail' });
  const guarded = facade.projectionGuardedRuntime(desktop.sandbox, desktop.sandbox.H2O.Desktop.SyncObjectRuntime);
  let error = null;
  try { await guarded.applyNextAdmittedP02Revision(OBJECT_ID); } catch (e) { error = e; }
  check(error?.code === 'round2a-projection-unavailable',
    'C1 a failed projection load is the same typed failure the runtime raises');
  check(error?.detail === 'projection-asset-load-failed',
    'C2 with a bounded detail naming the predicate');
  check(desktop.calls.every((c) => c.command !== 'h2o_sync_object_runtime_session'),
    'C3 the canonical runtime is never invoked without its dependency');
  check(desktop.candidateRequests.length === 0, 'C4 no pull was attempted');

  const silent = makeDesktop({ projectionLoad: 'silent' });
  const silentGuarded = facade.projectionGuardedRuntime(silent.sandbox, silent.sandbox.H2O.Desktop.SyncObjectRuntime);
  let silentError = null;
  try { await silentGuarded.applyNextAdmittedP02Revision(OBJECT_ID); } catch (e) { silentError = e; }
  check(silentError?.code === 'round2a-projection-unavailable' &&
    silentError?.detail === 'projection-api-missing-after-load',
    'C5 an asset that loads without publishing the API is refused, not trusted');

  const noDocument = makeDesktop();
  delete noDocument.sandbox.document;
  let noDocError = null;
  try { await facade.ensureRound2AProjection(noDocument.sandbox); } catch (e) { noDocError = e; }
  check(noDocError?.code === 'round2a-projection-unavailable' &&
    noDocError?.detail === 'projection-document-unavailable',
    'C6 no document, no load, typed refusal');
}

/* ── D. an existing round2aReady owner is honored ────────────────────── */
{
  const desktop = makeDesktop({
    round2aReady: (sandbox) => Promise.resolve().then(() => {
      vm.runInContext(read(PROJECTION_REL), sandbox, { filename: 'sync-object-projection.tauri.js' });
    })
  });
  const guarded = facade.projectionGuardedRuntime(desktop.sandbox, desktop.sandbox.H2O.Desktop.SyncObjectRuntime);
  let outcome = null;
  try { await guarded.applyNextAdmittedP02Revision(OBJECT_ID); }
  catch (error) { outcome = error?.code || error?.message; }
  check(outcome === STOP && desktop.loads.length === 0 &&
    !!desktop.sandbox.H2O.Desktop.SyncObjectProjection,
    'D1 when a loader already publishes round2aReady it is awaited and no second load is attached');

  const hollow = makeDesktop({ round2aReady: () => Promise.resolve() });
  let hollowError = null;
  try { await facade.ensureRound2AProjection(hollow.sandbox); } catch (e) { hollowError = e; }
  check(hollowError?.code === 'round2a-projection-unavailable' &&
    hollowError?.detail === 'round2a-ready-without-projection',
    'D2 a round2aReady that resolves without the projection is refused');
}

/* ── E. facade ordering: the guarantee sits at the runtime call, after the
 *       existing config/generation/leaf refusals ───────────────────────── */
{
  const desktop = makeDesktop();
  desktop.sandbox.H2O.Studio.sync = {
    getConfig: async () => ({ schemaVersion: 1, mode: 'off', configuredPeers: [] }),
    setConfig: async () => {},
    mutateCanonicalConfig: async () => ({ written: false, outcome: 'no-effect' })
  };
  const api = facade.installDesktopP02Reverse(desktop.sandbox);
  check(typeof api?.applyAdmittedFromChrome === 'function', 'E1 the facade installs on the synthetic Desktop');
  const result = await api.applyAdmittedFromChrome();
  check(result?.ok === false && result?.outcome === 'sync-mode-off',
    'E2 the existing fail-closed refusals still run first');
  check(desktop.loads.length === 0,
    'E3 and no projection is attached before Apply is actually reachable');
  check(desktop.calls.every((c) => c.command !== 'h2o_sync_object_runtime_session'),
    'E4 the canonical runtime is not entered on a refused Apply');
}

if (failures.length) {
  console.error(JSON.stringify({ verdict: 'P02_DESKTOP_REVERSE_PROJECTION_WIRING_FAIL', assertions, failures }, null, 2));
  process.exit(1);
}
console.log(JSON.stringify({
  verdict: 'P02_DESKTOP_REVERSE_PROJECTION_WIRING_PASS',
  assertions,
  proves: 'New UI Desktop Apply guarantees H2O.Desktop.SyncObjectProjection before the canonical runtime; fail-closed preserved; round2aReady honored; nothing applied'
}, null, 2));
