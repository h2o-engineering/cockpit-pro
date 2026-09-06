#!/usr/bin/env node
/* Fresh-Desktop Sync bootstrap runtime isolation.
 *
 * A Desktop identity with NO persisted 'h2o:studio:sync:config:v1' must boot
 * UNCONFIGURED and NON-MUTATING: effective mode off, watcher not started, the
 * shared HOME-relative 'H2O Studio Sync' folder never read, and no automatic
 * import of chrome-latest.json. Absence of a config is not implicit historical
 * opt-in; only an ACTUALLY PERSISTED config may select an automatic mode, and
 * the Phase 3 legacy manual->auto migration may only act on a persisted config.
 *
 * Every persisted mode (auto / manual / notify / off), the legacy migration and
 * ordinary setConfig reconfiguration keep their existing behavior.
 *
 * Deterministic: folder-sync.tauri.js runs in a VM with a synthetic Tauri fs,
 * a synthetic chrome.storage.local, a controlled clock and controlled timers.
 * It never touches the real HOME and carries no user payload data.
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import vm from 'node:vm';
import { TextDecoder, TextEncoder } from 'node:util';
import { webcrypto } from 'node:crypto';

const root = process.cwd();
const folderSyncFile = 'src-surfaces-base/studio/sync/folder-sync.tauri.js';
const source = fs.readFileSync(path.join(root, folderSyncFile), 'utf8');

const CONFIG_KEY = 'h2o:studio:sync:config:v1';
const SYNC_FOLDER = 'H2O Studio Sync';
const CHROME_LATEST = 'chrome-latest.json';
const SHARED_BUNDLE_PATH = `${SYNC_FOLDER}/${CHROME_LATEST}`;
const HOME_BASE_DIR = 21;              /* Tauri v2 BaseDirectory::Home */
const PHASE3_VERSION = 1;
const FILE_STABLE_MS = 1500;

const failures = [];
function assert(condition, message) {
  if (!condition) failures.push(message);
}
function assertEqual(actual, expected, message) {
  assert(actual === expected, `${message} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
}

/* Synthetic Chrome export bundle. Schema-shaped only — no user payload. */
function syntheticChromeLatestBundle() {
  return {
    schema: 'h2o.studio.fullBundle.v2',
    exportedAt: '2026-01-01T00:00:00.000Z',
    exportId: 'synthetic-export-fixture',
    sequenceNumber: 1,
    sourceSurfaceKind: 'chrome-studio',
    sourceAppKind: 'chrome-extension',
    sourceStoreKind: 'mv3-storage',
    sourcePeerEnvelope: { peerIdHash: 'synthetic-peer', installIdHash: 'synthetic-install' },
    chatArchive: {
      schema: 'h2o.chatArchive.bundle.v1',
      exportedAt: '2026-01-01T00:00:00.000Z',
      catalogs: { categories: [], labels: [], tags: [] },
      chats: [
        {
          chatIndex: { id: 'synthetic-chat-1', title: 'Synthetic Chat', view: 'saved', organization: {} },
          snapshots: [{ id: 'synthetic-snapshot-1', content: 'synthetic body' }],
        },
      ],
    },
  };
}

function createRuntime(persistedConfig) {
  const storage = new Map();
  if (persistedConfig) storage.set(CONFIG_KEY, persistedConfig);

  const invokeCalls = [];
  const importBundleCalls = [];
  const timers = [];
  const intervals = [];
  let clockMs = Date.UTC(2026, 0, 1, 0, 0, 0);

  class VmDate extends Date {
    constructor(...args) {
      if (args.length === 0) super(clockMs);
      else super(...args);
    }
    static now() { return clockMs; }
  }

  const bundleText = JSON.stringify(syntheticChromeLatestBundle());

  function invoke(command, args) {
    const call = { command, path: String((args && args.path) || ''), options: (args && args.options) || {} };
    invokeCalls.push(call);
    if (command === 'plugin:fs|read_dir') {
      if (call.path !== SYNC_FOLDER) return Promise.reject(new Error(`unexpected read_dir path: ${call.path}`));
      return Promise.resolve([{ name: CHROME_LATEST, isDirectory: false, isFile: true, isSymlink: false }]);
    }
    if (command === 'plugin:fs|read_text_file') {
      if (call.path !== SHARED_BUNDLE_PATH) return Promise.reject(new Error(`unexpected read_text_file path: ${call.path}`));
      return Promise.resolve(bundleText);
    }
    return Promise.reject(new Error(`unstubbed tauri command: ${command}`));
  }

  const context = {
    console,
    TextEncoder,
    TextDecoder,
    crypto: webcrypto,
    Date: VmDate,
    Promise,
    JSON,
    Math,
    Object,
    Array,
    String,
    Number,
    Boolean,
    Error,
    RegExp,
    Set,
    Map,
    Uint8Array,
    ArrayBuffer,
    isFinite,
    setTimeout(callback, delay) {
      timers.push({ callback, delay: Number(delay) || 0 });
      return timers.length;
    },
    clearTimeout() {},
    setInterval(callback, delay) {
      intervals.push({ callback, delay: Number(delay) || 0 });
      return intervals.length;
    },
    clearInterval(id) {
      const index = Number(id) - 1;
      if (index >= 0 && index < intervals.length) intervals[index] = null;
    },
    H2O: {
      Studio: {
        ingestion: {
          async dryRunImportBundle() {
            return { ok: true, plan: { chats: 1 }, sourceVersion: 'synthetic' };
          },
          async importBundle(bundle, mode, options) {
            importBundleCalls.push({ mode, options });
            return {
              ok: true,
              mode,
              destinationBackend: 'sqlite-fixture',
              written: { chats: 1, snapshots: 1, categories: 0, folders: 0 },
              skipped: { chats: 0, snapshots: 0, categories: 0, folders: 0 },
              warnings: [],
              errors: [],
            };
          },
        },
        sync: {},
      },
      LibraryIndex: {
        async refresh() { return { ok: true }; },
      },
    },
    chrome: {
      storage: {
        local: {
          get(keys, callback) {
            const out = {};
            for (const key of Array.isArray(keys) ? keys : [keys]) {
              if (storage.has(key)) out[key] = storage.get(key);
            }
            callback(out);
          },
          set(items, callback) {
            for (const [key, value] of Object.entries(items || {})) storage.set(key, value);
            if (callback) callback();
          },
        },
      },
      runtime: { lastError: null },
    },
    __TAURI_INTERNALS__: { invoke },
  };
  context.window = context;
  context.globalThis = context;
  vm.createContext(context);

  return {
    context,
    storage,
    invokeCalls,
    importBundleCalls,
    advance(ms) { clockMs += Number(ms) || 0; },
    async settle() {
      for (let i = 0; i < 60; i += 1) await new Promise((resolve) => setImmediate(resolve));
    },
    runPendingTimers() {
      const queued = timers.splice(0, timers.length);
      for (const timer of queued) {
        if (typeof timer.callback === 'function') timer.callback();
      }
    },
    runIntervalTick() {
      for (const entry of intervals) {
        if (entry && typeof entry.callback === 'function') entry.callback();
      }
    },
  };
}

/* Boot the module the way the Desktop shell does, then let the boot
 * setTimeout(…, 0) auto-start block run to completion. */
async function boot(persistedConfig) {
  const runtime = await loadModule(persistedConfig);
  runtime.runPendingTimers();
  await runtime.settle();
  return runtime;
}

/* Module loaded, boot auto-start block NOT yet run — lets a test observe
 * getConfig() before the boot block persists a migrated config. */
async function loadModule(persistedConfig) {
  const runtime = createRuntime(persistedConfig);
  vm.runInContext(source, runtime.context, { filename: folderSyncFile });
  return runtime;
}

/* Two watcher cycles separated by more than the file-stability window: the
 * first records the candidate, the second treats it as stable and (in auto
 * mode) imports it. */
async function runStabilizedWatcherCycles(runtime) {
  runtime.advance(FILE_STABLE_MS * 2);
  runtime.runIntervalTick();
  await runtime.settle();
  runtime.advance(FILE_STABLE_MS * 2);
  runtime.runIntervalTick();
  await runtime.settle();
}

function api(runtime) {
  return runtime.context.H2O.Studio.sync;
}
function readDirCalls(runtime) {
  return runtime.invokeCalls.filter((call) => call.command === 'plugin:fs|read_dir');
}
function bundleReadCalls(runtime) {
  return runtime.invokeCalls.filter(
    (call) => call.command === 'plugin:fs|read_text_file' && call.path === SHARED_BUNDLE_PATH,
  );
}

/* ── A. ABSENT persisted config → unconfigured / non-mutating ──────────── */
async function proveAbsentConfigIsUnconfigured() {
  const runtime = await boot(null);
  const sync = api(runtime);

  const config = await sync.getConfig();
  assertEqual(config.mode, 'off', 'A: absent config must resolve to effective mode off');
  assertEqual(config.folderPath, '', 'A: absent config must resolve to an empty folderPath');
  assert(!config.autoImportMigration, 'A: absent config must not report a legacy auto-import migration');

  const watcher = sync.getWatcherState();
  assertEqual(watcher.running, false, 'A: absent config must not start the watcher');
  assertEqual(watcher.mode, 'off', 'A: absent config must leave the watcher mode off');
  assertEqual(watcher.folderPath, '', 'A: absent config must leave the watcher folderPath empty');

  await runStabilizedWatcherCycles(runtime);

  assertEqual(readDirCalls(runtime).length, 0,
    'A: absent config must not read the shared HOME-relative sync folder');
  assertEqual(bundleReadCalls(runtime).length, 0,
    'A: absent config must not read the shared chrome-latest.json');
  assertEqual(runtime.importBundleCalls.length, 0,
    'A: absent config must not run an automatic import');

  const health = sync.diagnose().desktopAutoImport;
  assertEqual(health.autoImportEnabled, false, 'A: absent config must report auto-import disabled');
  assertEqual(health.effectiveMode, 'off', 'A: absent config must report effective mode off');

  assertEqual(runtime.storage.has(CONFIG_KEY), false,
    'A: reading an absent config must not persist a synthetic config');
  assertEqual(sync.getLedger ? (await sync.getLedger()).entries.length : -1, 0,
    'A: absent config must leave the sync ledger empty');
}

/* ── B. Explicit persisted auto + configured folder ────────────────────── */
async function provePersistedAutoStillImports() {
  const runtime = await boot({
    schemaVersion: 1,
    mode: 'auto',
    folderPath: SYNC_FOLDER,
    phase3AutoSyncConfigVersion: PHASE3_VERSION,
    updatedAt: '2026-01-01T00:00:00.000Z',
  });
  const sync = api(runtime);

  const config = await sync.getConfig();
  assertEqual(config.mode, 'auto', 'B: persisted auto must remain auto');
  assertEqual(config.folderPath, SYNC_FOLDER, 'B: persisted auto must keep its configured folder');
  assertEqual(sync.getWatcherState().running, true, 'B: persisted auto must start the watcher on boot');

  await runStabilizedWatcherCycles(runtime);

  const dirCalls = readDirCalls(runtime);
  assert(dirCalls.length > 0, 'B: persisted auto must scan the configured folder');
  assertEqual(dirCalls[0] && dirCalls[0].path, SYNC_FOLDER, 'B: scan must target the configured folder');
  assertEqual(dirCalls[0] && dirCalls[0].options && dirCalls[0].options.baseDir, HOME_BASE_DIR,
    'B: a relative folderPath must still resolve against BaseDirectory::Home');
  assert(bundleReadCalls(runtime).length > 0, 'B: persisted auto must read a stable chrome-latest.json');
  assert(runtime.importBundleCalls.length > 0, 'B: persisted auto must run the automatic import');
  assertEqual(runtime.importBundleCalls[0] && runtime.importBundleCalls[0].mode, 'merge',
    'B: automatic import must remain merge-only');
  assertEqual(sync.diagnose().desktopAutoImport.autoImportEnabled, true,
    'B: persisted auto must report auto-import enabled');
}

/* ── C/D/E. Explicit manual / notify / off are preserved verbatim ──────── */
async function provePersistedManualPreserved() {
  const runtime = await boot({
    schemaVersion: 1,
    mode: 'manual',
    folderPath: SYNC_FOLDER,
    phase3AutoSyncConfigVersion: PHASE3_VERSION,
    updatedAt: '2026-01-01T00:00:00.000Z',
  });
  const sync = api(runtime);
  assertEqual((await sync.getConfig()).mode, 'manual', 'C: persisted manual must remain manual');
  assertEqual(sync.getWatcherState().running, false, 'C: persisted manual must not start the watcher');
  await runStabilizedWatcherCycles(runtime);
  assertEqual(runtime.importBundleCalls.length, 0, 'C: persisted manual must not auto-import');
}

async function provePersistedNotifyPreserved() {
  const runtime = await boot({
    schemaVersion: 1,
    mode: 'notify',
    folderPath: SYNC_FOLDER,
    phase3AutoSyncConfigVersion: PHASE3_VERSION,
    updatedAt: '2026-01-01T00:00:00.000Z',
  });
  const sync = api(runtime);
  assertEqual((await sync.getConfig()).mode, 'notify', 'D: persisted notify must remain notify');
  assertEqual(sync.getWatcherState().running, true, 'D: persisted notify must start the watcher');
  await runStabilizedWatcherCycles(runtime);
  assert(readDirCalls(runtime).length > 0, 'D: persisted notify must keep scanning the configured folder');
  assertEqual(runtime.importBundleCalls.length, 0, 'D: persisted notify must queue rather than auto-import');
  assertEqual(sync.getPendingCandidates().length, 1, 'D: persisted notify must surface a pending candidate');
}

async function provePersistedOffPreserved() {
  const runtime = await boot({
    schemaVersion: 1,
    mode: 'off',
    folderPath: SYNC_FOLDER,
    phase3AutoSyncConfigVersion: PHASE3_VERSION,
    updatedAt: '2026-01-01T00:00:00.000Z',
  });
  const sync = api(runtime);
  assertEqual((await sync.getConfig()).mode, 'off', 'E: persisted off must remain off');
  assertEqual(sync.getWatcherState().running, false, 'E: persisted off must not start the watcher');
  await runStabilizedWatcherCycles(runtime);
  assertEqual(runtime.importBundleCalls.length, 0, 'E: persisted off must not auto-import');
}

/* ── F. Legacy migration runs only on an actually persisted config ─────── */
async function proveLegacyMigrationScope() {
  const legacyConfig = {
    schemaVersion: 1,
    mode: 'manual',
    folderPath: '',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };

  /* Read-time migration semantics, observed before the boot block rewrites
   * the persisted config. */
  const preBoot = await loadModule(legacyConfig);
  const migrated = await api(preBoot).getConfig();
  assertEqual(migrated.mode, 'auto', 'F: persisted legacy manual must still migrate to auto');
  assertEqual(migrated.folderPath, SYNC_FOLDER, 'F: migrated legacy config must take the default sync folder');
  assertEqual(migrated.autoImportMigration, 'phase3-legacy-manual-to-auto',
    'F: migrated legacy config must report the migration marker');
  assertEqual(api(preBoot).diagnose().desktopAutoImport.configMigration, 'phase3-legacy-manual-to-auto',
    'F: migrated legacy config must expose the migration in diagnostics');

  /* Boot settles the migration into a persisted config exactly once. */
  const runtime = await boot(legacyConfig);
  const sync = api(runtime);
  assertEqual((await sync.getConfig()).mode, 'auto', 'F: migrated legacy config must remain auto after boot');
  assertEqual(sync.getWatcherState().running, true, 'F: migrated legacy config must start the watcher');
  const persisted = runtime.storage.get(CONFIG_KEY);
  assertEqual(persisted && persisted.mode, 'auto', 'F: boot must persist the migrated mode');
  assertEqual(persisted && persisted.phase3AutoSyncConfigVersion, PHASE3_VERSION,
    'F: boot must persist the Phase 3 marker so the migration does not repeat');
  assert(!(persisted && persisted.autoImportMigration),
    'F: the persisted migrated config must not keep the one-shot migration marker');

  /* An absent config is not a legacy config. */
  const freshPreBoot = await loadModule(null);
  const freshConfig = await api(freshPreBoot).getConfig();
  assert(!freshConfig.autoImportMigration, 'F: absent config must not be treated as a legacy config');
  assertEqual(api(freshPreBoot).diagnose().desktopAutoImport.configMigration, '',
    'F: absent config must report no migration');
  const fresh = await boot(null);
  assertEqual(fresh.storage.has(CONFIG_KEY), false,
    'F: absent config must not be migrated into a persisted config');
}

/* ── G. Ordinary reconfiguration from a fresh Desktop still works ──────── */
async function proveOrdinaryConfigurationStillWorks() {
  const runtime = await boot(null);
  const sync = api(runtime);
  assertEqual(sync.getWatcherState().running, false, 'G: fresh Desktop must start unconfigured');

  const next = await sync.setConfig({ mode: 'auto', folderPath: SYNC_FOLDER });
  await runtime.settle();
  assertEqual(next.mode, 'auto', 'G: setConfig must move a fresh Desktop into auto');
  assertEqual(next.folderPath, SYNC_FOLDER, 'G: setConfig must keep the chosen folder');
  assertEqual(next.phase3AutoSyncConfigVersion, PHASE3_VERSION, 'G: setConfig must stamp the Phase 3 marker');
  const persisted = runtime.storage.get(CONFIG_KEY);
  assertEqual(persisted && persisted.mode, 'auto', 'G: setConfig must persist the explicit choice');
  assertEqual(sync.getWatcherState().running, true, 'G: setConfig(auto) must start the watcher immediately');

  await runStabilizedWatcherCycles(runtime);
  assert(runtime.importBundleCalls.length > 0, 'G: an explicitly configured fresh Desktop must import normally');

  const off = await sync.setConfig({ mode: 'off' });
  await runtime.settle();
  assertEqual(off.mode, 'off', 'G: setConfig must be able to turn sync back off');
  assertEqual(sync.getWatcherState().running, false, 'G: setConfig(off) must stop the watcher');

  /* Choosing auto without naming a folder still resolves the default sync
   * folder — the default folder is a consequence of an explicit auto choice,
   * never of an absent config. */
  const bare = await boot(null);
  const bareNext = await api(bare).setConfig({ mode: 'auto' });
  await bare.settle();
  assertEqual(bareNext.folderPath, SYNC_FOLDER,
    'G: an explicit auto choice with no folder must still resolve the default sync folder');
  assertEqual(api(bare).getWatcherState().running, true,
    'G: an explicit auto choice with no folder must still start the watcher');

  /* Setting only a folder is not an opt-in to automatic sync. */
  const folderOnly = await boot(null);
  const folderOnlyNext = await api(folderOnly).setConfig({ folderPath: SYNC_FOLDER });
  await folderOnly.settle();
  assertEqual(folderOnlyNext.mode, 'off',
    'G: naming a folder without choosing a mode must leave sync off');
  assertEqual(api(folderOnly).getWatcherState().running, false,
    'G: naming a folder without choosing a mode must not start the watcher');
  assertEqual(folderOnly.importBundleCalls.length, 0,
    'G: naming a folder without choosing a mode must not import');
}

/* ── Source-level guard: the default config must not name an automatic mode */
function proveDefaultConfigSource() {
  const marker = source.match(/function defaultConfig\(\)\s*\{[\s\S]*?\n\s{2}\}/);
  assert(!!marker, 'defaultConfig() not found in folder-sync.tauri.js');
  if (!marker) return;
  const body = marker[0];
  assert(/mode:\s*'off'/.test(body), "defaultConfig() must default to mode 'off'");
  assert(/folderPath:\s*''/.test(body), "defaultConfig() must default to an empty folderPath");
  assert(!/SYNC_FOLDER_NAME/.test(body),
    'defaultConfig() must not seed the shared HOME-relative sync folder');
}

async function main() {
  proveDefaultConfigSource();
  await proveAbsentConfigIsUnconfigured();
  await provePersistedAutoStillImports();
  await provePersistedManualPreserved();
  await provePersistedNotifyPreserved();
  await provePersistedOffPreserved();
  await proveLegacyMigrationScope();
  await proveOrdinaryConfigurationStillWorks();

  if (failures.length) {
    console.error('Fresh-Desktop Sync bootstrap isolation validation failed');
    for (const failure of failures) console.error(`- ${failure}`);
    process.exit(1);
  }
  console.log('Fresh-Desktop Sync bootstrap isolation validation passed');
}

main().catch((error) => {
  console.error('Fresh-Desktop Sync bootstrap isolation validation errored');
  console.error(error);
  process.exit(1);
});
