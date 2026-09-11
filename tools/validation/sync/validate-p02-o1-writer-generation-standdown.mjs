#!/usr/bin/env node
/*
 * O1-T19 — writer-generation record and complete P01 mutation-gate coverage.
 *
 * One durable fact decides which generation owns this installation's data, and
 * the tests below are organised around the two ways getting it wrong is
 * catastrophic in opposite directions.
 *
 * FAIL OPEN and a transient storage failure re-authorizes P01 to write into a
 * repository P02 already owns. So the four observations are kept distinct -
 * absence is a fact we OBSERVED, and everything else is ignorance that refuses.
 *
 * FAIL CLOSED TOO EAGERLY and merely adding this read stands P01 down on every
 * installation in the world, which is the accepted product breaking. So a
 * positively observed absence must permit exactly as before.
 *
 * Both directions are checked at every seam, on both platforms, plus the native
 * boundary a determined caller could use to skip the JS entirely.
 *
 * NOTHING IS EXECUTED AGAINST REAL STATE. Every record here is disposable. The
 * Chrome ceremony fixture exercises the one fixed-purpose owner over in-memory
 * storage and locks; permanent assurance proves no second owner exists.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import {
  P02_GENERATION_ERROR,
  P02_GENERATION_STATE,
  P02_ROLLBACK_CEREMONY,
  P02_STANDDOWN_CEREMONY,
  P02_STANDDOWN_SCOPE,
  P02_WRITER_GENERATION,
  createP01MutationGate,
  p01MutationPermitted,
  readWriterGeneration
} from '../../../packages/core/sync-writer-generation-v2.mjs';
import {
  P02_CHROME_GENERATION,
  P02_CHROME_STANDDOWN,
  createChromeGenerationStore,
  createChromeP01MutationGate,
  createChromeP01WriterStanddown
}
  from '../../../packages/browser-adapters/chrome/sync-writer-generation-chrome-v2.mjs';
import {
  CHROME_P01_MUTATION_ADMISSION,
  createChromeP01MutationAdmission
} from '../../../packages/browser-adapters/chrome/sync-p01-mutation-admission-chrome.mjs';
import { writerKeyHex }
  from '../../../packages/browser-adapters/chrome/sync-contract-v2.mjs';
import { P01_OWNERSHIP_RULINGS, OWNERSHIP_REQUIRED_FIELDS }
  from './p01-seam-ownership-rulings.mjs';

let assertions = 0;
const failures = [];
const check = (condition, label) => {
  assertions += 1;
  if (condition !== true) failures.push(label);
};
const equal = (actual, expected, label) =>
  check(actual === expected, `${label} (expected ${String(expected)}, got ${String(actual)})`);

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

/* A chrome.storage.local-shaped area that answers from a fixed row map. Used to
 * drive the REAL generation gate rather than a hand-written observation double. */
const answeringArea = (rows) => ({
  get(keys, cb) {
    const list = Array.isArray(keys) ? keys : [keys];
    const out = {};
    list.forEach((key) => {
      if (Object.prototype.hasOwnProperty.call(rows, key)) out[key] = rows[key];
    });
    if (cb) { cb(out); return undefined; }
    return Promise.resolve(out);
  },
  set(_items, cb) { if (cb) cb(); return Promise.resolve(); }
});
const generatedStanddownRoot = process.env.H2O_STANDDOWN_GENERATED_DIR
  ? path.resolve(process.env.H2O_STANDDOWN_GENERATED_DIR) : null;
let generatedStanddownChecked = false;

/*
 * The migration ladder only - every Migration{...} entry in lib.rs. Command
 * registrations and module declarations live in the same file but are not
 * migrations, and must not be read as if they were.
 */
const ladderRegion = (lib) =>
  (lib.match(/Migration\s*\{[\s\S]*?\}/g) || []).join('\n');

const p02Record = (over = {}) => JSON.stringify({
  schemaVersion: 1, generation: 'p02',
  standdownAt: '2026-08-26T00:00:00.000Z',
  decidedByWriterSyncPeerId: 'studio-desktop:tauri-desktop:sqlite:ceremony',
  reason: 'governed standdown', ...over
});
const p01Record = () => JSON.stringify({ schemaVersion: 1, generation: 'p01' });

/* A store whose three outcomes are separately controllable. */
const store = (mode, value = null) => ({
  read: async () => {
    if (mode === 'unreadable') {
      throw Object.assign(new Error('io'), { code: P02_GENERATION_ERROR.UNOBSERVED });
    }
    return mode === 'absent' ? null : value;
  }
});

/* ===== 1. The four observations, and only two of them permit ===== */
{
  const cases = [
    ['absent', null, P02_GENERATION_STATE.ABSENT_OBSERVED, true, 'absent'],
    ['value', p01Record(), P02_GENERATION_STATE.RECORDED, true, 'p01'],
    ['value', p02Record(), P02_GENERATION_STATE.RECORDED, false, 'p02'],
    ['value', 'not json', P02_GENERATION_STATE.MALFORMED, false, 'malformed'],
    ['unreadable', null, P02_GENERATION_STATE.UNOBSERVED, false, 'unreadable']
  ];
  for (const [mode, value, expectedState, permitted, label] of cases) {
    const observation = await readWriterGeneration({ store: store(mode, value) });
    equal(observation.state, expectedState, `G1 ${label} observes as ${expectedState}`);
    equal(p01MutationPermitted(observation).permitted, permitted,
      `G2 ${label} ${permitted ? 'permits' : 'refuses'} P01 mutation`);
  }

  /* The distinction that carries everything: absence is observed, ignorance is not. */
  const absent = await readWriterGeneration({ store: store('absent') });
  const unreadable = await readWriterGeneration({ store: store('unreadable') });
  check(absent.state !== unreadable.state,
    'G3 a proven absence and an unreadable store are DIFFERENT observations');
  equal(absent.generation, 'p01',
    'G4 absence means p01 for compatibility - P01 keeps working exactly as today');
  equal(unreadable.generation, null,
    'G5 while an unreadable store yields no generation at all');
  equal(p01MutationPermitted(unreadable).reason, P02_GENERATION_ERROR.UNOBSERVED,
    'G6 and refuses with generation-unobserved');

  /* No store is not an empty store. */
  equal((await readWriterGeneration({})).state, P02_GENERATION_STATE.UNOBSERVED,
    'G7 a missing store is unobserved, never absent');

  /* A p02 record with no provenance is not an auditable decision. */
  for (const missing of ['standdownAt', 'decidedByWriterSyncPeerId', 'reason']) {
    const record = JSON.parse(p02Record());
    delete record[missing];
    const observation = await readWriterGeneration({
      store: store('value', JSON.stringify(record))
    });
    equal(observation.state, P02_GENERATION_STATE.MALFORMED,
      `G8 a p02 record with no ${missing} is malformed, not a standdown`);
  }
  /* A p01 record needs no provenance: it asserts the status quo. */
  equal((await readWriterGeneration({ store: store('value', p01Record()) })).generation, 'p01',
    'G9 while a p01 record asserts the status quo and needs none');
}

/* ===== 2. Desktop: the real kv_store, all five states ===== */
{
  const lib = read('apps/studio/desktop/src-tauri/src/lib.rs');
  const match = lib.match(/version: 1,[\s\S]*?sql: "([\s\S]*?)",\s*\n\s*kind:/);
  check(match !== null, 'D0 kv_store comes from the accepted migration v1');
  const db = new DatabaseSync(':memory:');
  db.exec(match[1].replace(/\\\s*\n\s*/g, '').replace(/\\"/g, '"'));

  let failReads = false;
  const desktopStore = {
    read: async (key) => {
      if (failReads) throw Object.assign(new Error('io'), { code: 'kv-read-failed' });
      const rows = db.prepare('SELECT value FROM kv_store WHERE key = ? LIMIT 1').all(key);
      return rows[0]?.value ?? null;
    }
  };
  const gate = createP01MutationGate({ store: desktopStore, seamName: 'desktop-test' });
  const put = (value) => db.prepare(
    'INSERT INTO kv_store (key, value, updated_at) VALUES (?,?,?) '
    + 'ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(P02_WRITER_GENERATION.KEY, value, 0);

  equal((await gate.requirePermitted()).permitted, true,
    'D1 Desktop, record absent -> existing P01 behavior');
  put(p01Record());
  equal((await gate.requirePermitted()).permitted, true, 'D2 Desktop, p01 -> permitted');
  put(p02Record());
  const stoodDown = await gate.requirePermitted();
  equal(stoodDown.permitted, false, 'D3 Desktop, p02 -> refused');
  equal(stoodDown.reason, P02_GENERATION_ERROR.STOOD_DOWN, 'D4 as p01-writer-stood-down');
  put('{"schemaVersion":1}');
  equal((await gate.requirePermitted()).permitted, false, 'D5 Desktop, malformed -> refused');
  failReads = true;
  const unreadable = await gate.requirePermitted();
  equal(unreadable.permitted, false, 'D6 Desktop, unreadable -> refused');
  equal(unreadable.reason, P02_GENERATION_ERROR.UNOBSERVED, 'D7 as generation-unobserved');

  /* RESTART: the record is durable in an existing store, no migration added. */
  failReads = false;
  put(p02Record());
  const remounted = createP01MutationGate({ store: desktopStore, seamName: 'after-restart' });
  equal((await remounted.requirePermitted()).permitted, false,
    'D8 the record survives a restart - a fresh gate over the same store still refuses');
  const versions = [...lib.matchAll(/version:\s*(\d+),/g)].map((m) => Number(m[1]));
  equal(Math.max(...versions), 22, 'D9 with NO migration added - the ladder still tops at v22');
  /* Scoped to the ladder itself. The whole-file form also matched an unrelated
   * command NAME elsewhere in lib.rs, which says nothing about migrations - the
   * claim being pinned is that no migration creates a generation table. */
  check(/writer_generation|generation_record/.test(ladderRegion(lib)) === false,
    'D10 and no generation table exists in the ladder');
}

/* ===== 3. Chrome: chrome.storage.local, all five states ===== */
{
  const backing = new Map();
  let failReads = false;
  globalThis.chrome = { runtime: {} };
  const area = {
    get(keys, callback) {
      if (failReads) {
        globalThis.chrome = { runtime: { lastError: { message: 'quota' } } };
        callback({});
        globalThis.chrome = { runtime: {} };
        return;
      }
      const rows = {};
      for (const key of keys) if (backing.has(key)) rows[key] = backing.get(key);
      callback(rows);
    }
  };
  const chromeStore = createChromeGenerationStore({ storageArea: area });
  const gate = createP01MutationGate({ store: chromeStore, seamName: 'chrome-test' });

  equal((await gate.requirePermitted()).permitted, true, 'C1 Chrome, absent -> existing behavior');
  backing.set(P02_WRITER_GENERATION.KEY, p01Record());
  equal((await gate.requirePermitted()).permitted, true, 'C2 Chrome, p01 -> permitted');
  backing.set(P02_WRITER_GENERATION.KEY, p02Record());
  equal((await gate.requirePermitted()).permitted, false, 'C3 Chrome, p02 -> refused');
  backing.set(P02_WRITER_GENERATION.KEY, 'garbage');
  equal((await gate.requirePermitted()).permitted, false, 'C4 Chrome, malformed -> refused');
  failReads = true;
  equal((await gate.requirePermitted()).reason, P02_GENERATION_ERROR.UNOBSERVED,
    'C5 Chrome, unreadable -> refused as generation-unobserved');

  /* A lastError that returns an EMPTY object must not read as absence. */
  check((await gate.requirePermitted()).permitted === false,
    'C6 a runtime.lastError with an empty result is a FAILED read, never an absent one');

  const store = read('packages/browser-adapters/chrome/sync-object-store.mjs');
  equal(store.match(/const DATABASE_VERSION = (\d+);/)?.[1], '4',
    'C7 with NO Chrome DATABASE_VERSION bump');
  equal((store.match(/database\.createObjectStore\(/g) || []).length, 6,
    'C8 and the same six object stores');
}

/* ===== 3b. The Desktop read path does not inherit the shim's fail-open ===== */
{
  /*
   * The chrome.storage shim ends its SELECT with `.catch(() => ({}))`, so a
   * failed query is indistinguishable from an empty table. Reading the
   * generation through it would turn every transient SQL failure into a proven
   * absence - and a proven absence RE-AUTHORIZES P01, which is the exact
   * fail-open this gate exists to prevent.
   */
  const shim = read('src-surfaces-base/studio/platform/platform.tauri.js');
  check(/\.catch\(function \(\) \{ return \{\}; \}\)/.test(shim),
    'X1 the platform shim really does swallow a failed SELECT into an empty result');

  const gate = read('src-surfaces-base/studio/sync/writer-generation-gate.js');
  check(gate.includes("invoke('plugin:sql|select'"),
    'X2 so the Desktop gate reads kv_store directly instead of through the shim');
  check(gate.includes('SELECT value FROM kv_store WHERE key = ? LIMIT 1'),
    'X3 with its own query');
  const desktopRead = gate.slice(
    gate.indexOf('function readRawDesktop'), gate.indexOf('function readRaw()')
  );
  check(desktopRead.includes('throw new Error(REASON.UNOBSERVED)'),
    'X4 and a rejected query stays a rejection - never an empty result');
  check(/isTauri\(\)/.test(gate.slice(gate.indexOf('function readRaw()'))),
    'X5 chosen by runtime, so Chrome keeps its own lastError-aware path');

  /* Driven: the two paths must disagree about a failing store in the right
   * direction - the direct read refuses, the shim-shaped read would not. */
  const failingDirect = () => Promise.reject(new Error('sql'));
  const shimShaped = () => Promise.reject(new Error('sql')).catch(() => ({}));
  const viaShim = await shimShaped();
  equal(Object.keys(viaShim).length, 0,
    'X6 a shim-shaped read of a failing store yields an empty object');
  const viaDirect = await failingDirect().then(() => 'resolved', () => 'rejected');
  equal(viaDirect, 'rejected',
    'X7 while the direct read rejects - which is what becomes generation-unobserved');
}

/* ===== 4. Every P01 mutation seam is gated, in the CURRENT source ===== */
{
  /*
   * Located by search rather than assumed from an older design document: each
   * entry names where the seam actually lives now.
   */
  const seams = [
    ['src-surfaces-base/studio/sync/sync-object-auto-reconcile.js', 'readAutoAuthority',
      'authority-reader', 'the centralized P01 automatic mutation gate'],
    ['packages/browser-adapters/chrome/sync-background-reconcile.mjs', 'p01WriterActive',
      'writer-active-signal', 'the Chrome background writer-active signal'],
    ['src-surfaces-base/studio/sync/folder-sync.tauri.js', 'getAutomaticModeAuthority',
      'authority-reader', 'the Desktop automatic-mode authority'],
    ['packages/browser-adapters/chrome/local-publication-writer.mjs', 'publishLocalRevisionInternal',
      'transport-byte-writer', 'both local-publication-writer branches'],
    ['src-surfaces-base/studio/sync/sync-object-runtime.tauri.js', 'publishObject',
      'canonical-publication-writer', 'the Desktop P01 publication writer'],
    ['src-surfaces-base/studio/sync/auto-import.mv3.js', 'exportNow',
      'manual-export', 'the Chrome export path, manual and automatic'],
    ['src-surfaces-base/studio/ingestion/export-bundle.tauri.js', 'exportLatestSyncBundle',
      'manual-export', 'the Desktop legacy/manual sync-bundle exporter'],
    ['apps/studio/desktop/src-tauri/src/item11_delivery_destination.rs', 'write_delivery_bytes',
      'native-write-command', 'the native delivery-byte writer']
  ];
  equal(seams.length, 8, 'S0 all eight approved seam classes are covered');

  for (const [file, symbol, seamClass, description] of seams) {
    const source = read(file);
    check(source.includes(symbol), `S1 ${description} still exists at ${file}`);
    const gated = /p01MayMutate|require_p01_mutation_permitted|writerGenerationGate/.test(source);
    check(gated, `S2 ${description} (${seamClass}) consults the generation gate`);
  }

  /* The gate is loaded BEFORE every P01 writer, so no seam can find it missing.
   * A seam that could not reach the gate would have to fail closed, which would
   * break the accepted P01 lane rather than protect it. */
  const html = read('src-surfaces-base/studio/studio.html');
  const gateAt = html.indexOf('sync/writer-generation-gate.js');
  check(gateAt > 0, 'S3 the gate is registered in studio.html');
  for (const writer of ['sync/folder-sync.tauri.js', 'sync/sync-object-auto-reconcile.js',
    /* O1-B2.1: this one now READS the installed gate to inject it. */
    'sync/local-publication.mv3.js']) {
    const writerAt = html.indexOf(writer);
    check(writerAt > gateAt, `S4 and loads BEFORE ${writer}`);
  }
  const packer = read('tools/product/studio/pack-studio.mjs');
  check(packer.includes('sync/writer-generation-gate.js'), 'S5 and ships in the packed tree');

  /* Every JS seam fails closed when the gate is unreachable. */
  for (const [file, , , description] of seams.filter(([f]) => f.endsWith('.js'))) {
    const source = read(file);
    check(/generation-unobserved|return false/.test(source),
      `S6 ${description} fails closed when the gate cannot be reached`);
  }
}

/* ===== 4b. The compatibility default does not weaken the p02 refusal ===== */
{
  /*
   * A seam permits when NO gate surface is installed, because that is a
   * pre-T19 runtime and P01 must behave exactly as before. That default must
   * not become a way to slip past a real gate, so the two conditions are
   * checked separately: absent SURFACE permits, present surface governs.
   */
  const seamSources = [
    ['src-surfaces-base/studio/sync/sync-object-auto-reconcile.js', 'p01MayMutateBoolean'],
    ['src-surfaces-base/studio/sync/folder-sync.tauri.js', 'p01MayMutateBoolean'],
    ['src-surfaces-base/studio/sync/sync-object-runtime.tauri.js', 'p01MayMutate'],
    ['src-surfaces-base/studio/sync/auto-import.mv3.js', 'p01MayMutate'],
    ['src-surfaces-base/studio/ingestion/export-bundle.tauri.js', 'p01MayMutate']
  ];
  for (const [file, method] of seamSources) {
    const text = read(file);
    check(text.includes(`gate.${method}()`),
      `Y1 ${path.basename(file)} defers to the gate when one is installed`);
    check(/pre-T19|compatibility position/.test(text),
      `Y2 ${path.basename(file)} documents why the absent-surface default permits`);
  }

  /* Driven: the same seam shape, with and without a gate, and with each of the
   * gate's four observations. */
  const seam = async (gate, method = 'p01MayMutate') => {
    if (!gate || typeof gate[method] !== 'function') return { permitted: true };
    try { return await gate[method](); } catch (_) { return { permitted: false }; }
  };
  equal((await seam(null)).permitted, true,
    'Y3 no gate surface -> permitted, so P01 is bit-identical to before');
  equal((await seam({ p01MayMutate: async () => ({ permitted: true }) })).permitted, true,
    'Y4 a gate observing absence or p01 -> permitted');
  equal((await seam({
    p01MayMutate: async () => ({ permitted: false, reason: P02_GENERATION_ERROR.STOOD_DOWN })
  })).permitted, false, 'Y5 a gate observing p02 -> REFUSED, which the default never overrides');
  equal((await seam({
    p01MayMutate: async () => ({ permitted: false, reason: P02_GENERATION_ERROR.UNOBSERVED })
  })).permitted, false, 'Y6 a gate observing an unreadable STORE -> refused');
  equal((await seam({ p01MayMutate: async () => { throw new Error('x'); } })).permitted, false,
    'Y7 and a gate that throws -> refused, never permitted');

  /* The build tests above prove the surface always ships, so Y3 is unreachable
   * in the product - it exists for pre-T19 runtimes and accepted harnesses. */
  check(read('src-surfaces-base/studio/studio.html').includes('sync/writer-generation-gate.js'),
    'Y8 and the real build always installs the gate, so the default never applies there');
}

/* ===== 5. The native boundary cannot be bypassed ===== */
{
  const gate = read('apps/studio/desktop/src-tauri/src/p01_generation_gate.rs');
  const delivery = read('apps/studio/desktop/src-tauri/src/item11_delivery_destination.rs');

  check(gate.includes('SELECT value FROM kv_store WHERE key = ?'),
    'N1 the native gate reads the same kv_store record the JS gate reads');
  check(gate.includes('GenerationObservation::Unobserved'),
    'N2 with the same four observations');

  /* Both commands that can reach write_delivery_bytes consult it. */
  for (const command of ['h2o_item11_prepare_delivery', 'h2o_item11_prepare_local_delivery']) {
    const at = delivery.indexOf(`pub async fn ${command}`);
    check(at > 0, `N3 ${command} exists`);
    const body = delivery.slice(at, at + 900);
    check(body.includes('require_p01_mutation_permitted'),
      `N4 ${command} consults the native gate`);
    /* Before any write: the check must precede the path resolution that leads
     * to write_delivery_bytes, or a refusal would arrive after the fact. */
    check(body.indexOf('require_p01_mutation_permitted') < body.indexOf('authorization_root'),
      `N5 ${command} checks BEFORE resolving the destination`);
  }

  /* The JS denial is therefore not the only line of defence. */
  check(delivery.includes('crate::p01_generation_gate::require_p01_mutation_permitted'),
    'N6 so a direct invoke that skips the JS still refuses');

  /* Contract parity: the two runtimes cannot disagree about a repository. */
  const js = read('packages/core/sync-writer-generation-v2.mjs');
  for (const [rustConst, jsText] of [
    ['h2o:studio:sync:writer-generation:v1', "KEY: 'h2o:studio:sync:writer-generation:v1'"],
    ['p01-writer-stood-down', "STOOD_DOWN: 'p01-writer-stood-down'"],
    ['generation-unobserved', "UNOBSERVED: 'generation-unobserved'"],
    ['generation-record-malformed', "MALFORMED: 'generation-record-malformed'"]
  ]) {
    check(gate.includes(rustConst) && js.includes(jsText),
      `N7 both runtimes agree on ${rustConst}`);
  }
}

/* ===== 6. p01WriterActive reports CAPABILITY, not presence ===== */
{
  const background = read('packages/browser-adapters/chrome/sync-background-reconcile.mjs');
  const at = background.indexOf('p01WriterActive:');
  const body = background.slice(at, at + 700);
  check(/installed !== true/.test(body),
    'W1 presence is still necessary - an absent writer is not active');
  check(body.includes('p01MayMutate'),
    'W2 but presence alone is no longer sufficient: the generation decides');
  check(/p01WriterActive: async \(\) => installed === true/.test(background) === false,
    'W3 the old presence-equals-active equation is gone');

  /* The behaviour, driven directly. */
  const makeGate = (verdict) => ({ p01MayMutate: async () => verdict });
  const signal = async (installed, verdict) => {
    if (installed !== true) return false;
    try { return (await makeGate(verdict).p01MayMutate())?.permitted === true; }
    catch (_) { return false; }
  };
  equal(await signal(true, { permitted: true }), true,
    'W4 installed and permitted -> active, so P02 stands down');
  equal(await signal(true, { permitted: false, reason: P02_GENERATION_ERROR.STOOD_DOWN }), false,
    'W5 installed but stood down -> NOT active, so P02 is not blocked by a writer that cannot write');
  equal(await signal(true, { permitted: false, reason: P02_GENERATION_ERROR.UNOBSERVED }), false,
    'W6 installed but unobservable -> NOT active, because P01 fails closed under it');
  equal(await signal(false, { permitted: true }), false, 'W7 not installed -> not active');
}

/* ===== 7. Exactly one fixed-purpose Chrome owner creates a p02 record ===== */
{
  const offenders = [];
  const looksLikeGenerationWriter = (text) =>
    (text.includes(P02_WRITER_GENERATION.KEY) ||
      text.includes('P02_WRITER_GENERATION.KEY')) &&
    /\.set\(|['"]set['"]|INSERT|UPDATE|writeTemporary|fs::write/.test(text);
  const scan = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (['node_modules', 'dist', 'prod', 'target', '.git'].includes(entry.name)) continue;
        scan(full);
        continue;
      }
      if (!/\.(mjs|js|rs)$/.test(entry.name)) continue;
      const rel = path.relative(root, full);
      if (rel.startsWith('tools/validation/')) continue;
      let text = fs.readFileSync(full, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      /* Only PRODUCTION code can write a record. A Rust cfg(test) module that
       * asserts the production half contains no write verbs necessarily
       * mentions those verbs, and matching its own guard list would be reading
       * the test as the thing it tests. */
      const testAt = text.indexOf('#[cfg(test)]');
      if (testAt > 0) text = text.slice(0, testAt);
      /* A generation-key reference plus a persistence sink is a candidate
       * owner. Both literal and imported-constant forms count. */
      if (looksLikeGenerationWriter(text)) {
        offenders.push(rel);
      }
    }
  };
  for (const dir of ['packages', 'src-surfaces-base', 'apps/studio/desktop/src-tauri/src']) {
    const full = path.join(root, dir);
    if (fs.existsSync(full)) scan(full);
  }
  equal(offenders.length, 1,
    `A1 exactly one production file owns generation persistence (${offenders.join(',')})`);
  equal(offenders[0],
    'packages/browser-adapters/chrome/sync-writer-generation-chrome-v2.mjs',
    'A1 and the sole owner is the canonical Chrome generation module');

  /* Every read gate remains write-incapable; only the canonical Chrome owner
   * module may contain the fixed-purpose set call. */
  for (const rel of [
    'packages/core/sync-writer-generation-v2.mjs',
    'src-surfaces-base/studio/sync/sync-writer-generation-desktop-v2.tauri.mjs',
    'src-surfaces-base/studio/sync/writer-generation-gate.js'
  ]) {
    const text = read(rel);
    check(/async write\(|function write\(|\.set\(|INSERT INTO/.test(text) === false,
      `A2 ${path.basename(rel)} has no write path at all`);
  }
  const chromeOwner = read(
    'packages/browser-adapters/chrome/sync-writer-generation-chrome-v2.mjs');
  equal((chromeOwner.match(/promisify\(area, 'set'/g) || []).length, 1,
    'A2 the canonical owner has exactly one storage-set call site');
  check(!/export\s+(async\s+)?function\s+(write|set)WriterGeneration/.test(chromeOwner),
    'A2 and exposes no generic generation setter');
  check(looksLikeGenerationWriter(`
    import { P02_WRITER_GENERATION } from './sync-writer-generation-v2.mjs';
    export async function forbiddenSecondOwner(area, record) {
      await area.set({ [P02_WRITER_GENERATION.KEY]: record });
    }
  `), 'A2 negative control REDs on a second constant-key generation writer');
  check(looksLikeGenerationWriter(`
    export async function forbiddenPanelWriter(chrome, record) {
      await chrome.storage.local.set({
        '${P02_WRITER_GENERATION.KEY}': record
      });
    }
  `), 'A2 negative control REDs on a direct panel-side generation writer');
  /* And no migration creates one. */
  check(/writer-generation|writer_generation/.test(
    ladderRegion(read('apps/studio/desktop/src-tauri/src/lib.rs'))
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  ) === false, 'A3 no migration references the generation record');
}

/* ===== 8. The ceremony and rollback are SPECIFIED, not executable ===== */
{
  equal(P02_STANDDOWN_CEREMONY.executable, false, 'P1 the standdown spec is not executable');
  equal(P02_STANDDOWN_CEREMONY.steps.length, 10, 'P2 with all ten ordered steps');
  const order = P02_STANDDOWN_CEREMONY.steps.map((s) => s.step);
  equal(order[0], 'verify-p02-foundation-and-authority',
    'P3 foundation first - standing P01 down before P02 can write leaves no writer');
  check(order.indexOf('drain-active-p01-mutation') < order.indexOf('write-generation-p02'),
    'P4 the drain precedes the write');
  check(order.indexOf('recover-or-abandon-retained-p02-intents') < order.indexOf('write-generation-p02'),
    'P5 and retained P02 intents are reconciled WHILE P02 is still authorized');
  check(order.indexOf('read-back-verify') < order.indexOf('restart-both-platforms'),
    'P6 read-back precedes restart');
  equal(order[order.length - 1], 'steady-activation-under-its-own-separate-gate',
    'P7 activation is last and under its OWN gate - standdown starts nothing');
  check(P02_STANDDOWN_CEREMONY.steps.every((s) => typeof s.why === 'string' && s.why.length > 20),
    'P8 every step states why it is in that position');

  equal(P02_ROLLBACK_CEREMONY.executable, false, 'P9 rollback is specified, not executable');
  const rollback = P02_ROLLBACK_CEREMONY.steps.map((s) => s.step);
  check(rollback.indexOf('recover-or-abandon-retained-p02-intents-under-p02-authority')
    < rollback.indexOf('write-generation-p01-under-governed-ceremony'),
    'P10 rollback drains P02 intents BEFORE reverting ownership');
  check(rollback.includes('re-prove-p01-mutation-capability'),
    'P11 and re-proves P01 capability - a rollback leaving P01 refusing rolled nothing back');
  check(rollback.length > 1,
    'P12 rollback is a ceremony, not a string change');
}

/* ===== 9. Gating P01 does not disable P02 ===== */
{
  /* The P02 receive/apply lane must not consult the P01 gate at all: standing
   * P01 down is precisely when P02 needs to keep working. */
  for (const rel of [
    'packages/core/sync-object-reconcile-v2.mjs',
    'packages/core/sync-object-apply-v2.mjs',
    'packages/browser-adapters/chrome/sync-revision-apply-v2.mjs'
  ]) {
    const text = read(rel);
    check(/p01MayMutate|p01-writer-stood-down/.test(text) === false,
      `Z1 the P02 lane (${path.basename(rel)}) is unaffected by P01 generation gating`);
  }
}

/* ===== Chrome executable standdown: disposable owner + route proof ===== */
{
  const deferred = () => {
    let resolve;
    let reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
  };
  const tick = () => new Promise((resolve) => setImmediate(resolve));

  class FakeWebLocks {
    constructor() { this.names = new Map(); }
    state(name) {
      if (!this.names.has(name)) {
        this.names.set(name, { held: new Set(), queue: [] });
      }
      return this.names.get(name);
    }
    request(name, options, callback) {
      const mode = options?.mode === 'shared' ? 'shared' : 'exclusive';
      const state = this.state(name);
      const available = state.queue.length === 0 &&
        (state.held.size === 0 || (mode === 'shared' &&
          [...state.held].every((row) => row.mode === 'shared')));
      if (options?.ifAvailable === true && !available) {
        return Promise.resolve().then(() => callback(null));
      }
      const result = deferred();
      const request = { name, mode, callback, result };
      if (available) this.grant(state, request);
      else state.queue.push(request);
      return result.promise;
    }
    grant(state, request) {
      const holder = { name: request.name, mode: request.mode };
      state.held.add(holder);
      Promise.resolve().then(() => request.callback(Object.freeze({
        name: request.name, mode: request.mode
      }))).then(request.result.resolve, request.result.reject).finally(() => {
        state.held.delete(holder);
        this.process(state);
      });
    }
    process(state) {
      if (state.queue.length === 0) return;
      const next = state.queue[0];
      if (next.mode === 'exclusive') {
        if (state.held.size !== 0) return;
        state.queue.shift();
        this.grant(state, next);
        return;
      }
      if ([...state.held].some((row) => row.mode === 'exclusive')) return;
      while (state.queue[0]?.mode === 'shared') {
        this.grant(state, state.queue.shift());
      }
    }
  }

  class MemoryStorageArea {
    constructor(rows = {}, options = {}) {
      this.rows = structuredClone(rows);
      this.options = options;
      this.writes = 0;
      this.writeKeys = [];
    }
    get(keys, callback) {
      if (this.options.failGet === true) throw new Error('get-failed');
      const names = Array.isArray(keys) ? keys : [keys];
      const result = {};
      for (const name of names) {
        if (Object.prototype.hasOwnProperty.call(this.rows, name)) {
          result[name] = structuredClone(this.rows[name]);
        }
      }
      callback(result);
    }
    set(items, callback) {
      this.writes += 1;
      this.writeKeys.push(...Object.keys(items));
      if (this.options.failSet === true) throw new Error('set-failed');
      Object.assign(this.rows, structuredClone(items));
      if (typeof this.options.afterSet === 'function') {
        this.options.afterSet(this.rows, items);
      }
      callback();
    }
  }

  const LOCAL = 'chrome:fixture:local';
  const PEER = 'studio-desktop:tauri-desktop:sqlite:fixture';
  const WRITER = await writerKeyHex(PEER, crypto.webcrypto);
  const AT = '2026-09-02T12:34:56.789Z';
  const validRows = () => ({
    [P02_CHROME_GENERATION.CONFIG_KEY]: {
      schemaVersion: 1,
      mode: 'manual',
      configuredPeers: [{ syncPeerId: PEER, writerKey: WRITER }]
    },
    [P02_CHROME_GENERATION.IDENTITY_KEY]: { syncPeerId: LOCAL }
  });
  const make = ({ rows = validRows(), storageOptions = {}, locks = new FakeWebLocks(),
    admission = null } = {}) => {
    const area = new MemoryStorageArea(rows, storageOptions);
    const ownerAdmission = admission || createChromeP01MutationAdmission({
      lockManager: locks
    });
    return {
      area,
      locks,
      admission: ownerAdmission,
      owner: createChromeP01WriterStanddown({
        storageArea: area,
        lockManager: locks,
        p01MutationAdmission: ownerAdmission,
        cryptoImplementation: crypto.webcrypto,
        clock: () => new Date(AT)
      })
    };
  };

  /* One page writer is active before the worker queues its exclusive hold. */
  const success = make();
  const pageAdmission = createChromeP01MutationAdmission({
    lockManager: success.locks
  });
  const entered = deferred();
  const finish = deferred();
  const active = pageAdmission.run({
    label: 'fixture-active-page-writer',
    generationCheck: async () => ({ permitted: true, generation: 'p01' }),
    operation: async () => { entered.resolve(); await finish.promise; return 'done'; }
  });
  await entered.promise;
  const standdown = success.owner.standDownP01Writer();
  await tick();
  let postHoldMutation = 0;
  let postHoldCode = null;
  try {
    await pageAdmission.run({
      label: 'fixture-late-writer',
      generationCheck: async () => ({ permitted: true, generation: 'p01' }),
      operation: async () => { postHoldMutation += 1; }
    });
  } catch (error) { postHoldCode = error?.code; }
  equal(postHoldMutation, 0, 'C1 hold refuses a new P01 mutation');
  equal(postHoldCode, CHROME_P01_MUTATION_ADMISSION.ERROR.HELD,
    'C1 with the common admission held result');
  equal(success.area.writes, 0, 'C1 drain does not write while old work is active');
  finish.resolve();
  equal(await active, 'done', 'C1 the already-admitted writer settles normally');
  const completed = await standdown;
  equal(completed.outcome, P02_CHROME_STANDDOWN.OUTCOME.STOOD_DOWN,
    'C2 the drained transition stands P01 down');
  equal(completed.storageWrites, 1, 'C2 with exactly one generation write');
  equal(success.area.writes, 1, 'C2 and exactly one storage set invocation');
  equal(success.area.writeKeys.join(','), P02_WRITER_GENERATION.KEY,
    'C2 whose only key is canonical writer-generation');
  const written = success.area.rows[P02_WRITER_GENERATION.KEY];
  equal(written.schemaVersion, 1, 'C3 record schema is exact');
  equal(written.generation, 'p02', 'C3 record generation is p02');
  equal(written.standdownAt, AT, 'C3 record timestamp comes from execution clock');
  equal(written.decidedByWriterSyncPeerId, PEER,
    'C3 decision maker comes from canonical configured peer');
  equal(written.reason, P02_CHROME_GENERATION.STANDDOWN_REASON,
    'C3 reason is fixed by source');
  const finalGate = createChromeP01MutationGate({
    storageArea: success.area, seamName: 'fixture-post-standdown'
  });
  const refusal = await finalGate.p01MayMutate();
  equal(refusal.permitted, false, 'C4 actual canonical gate refuses P01');
  equal(refusal.reason, P02_GENERATION_ERROR.STOOD_DOWN,
    'C4 with the p01-writer-stood-down reason');
  equal(success.area.rows[P02_CHROME_GENERATION.CONFIG_KEY].configuredPeers[0].syncPeerId,
    PEER, 'C4 configured peer remains unchanged');

  let postCommitMutation = 0;
  try {
    await pageAdmission.run({
      label: 'fixture-post-commit-writer',
      generationCheck: () => finalGate.p01MayMutate(),
      operation: async () => { postCommitMutation += 1; }
    });
  } catch (error) {
    equal(error?.code, P02_GENERATION_ERROR.STOOD_DOWN,
      'C5 released transient hold still refuses through canonical p02');
  }
  equal(postCommitMutation, 0, 'C5 no P01 mutation occurs after commit');

  const alreadyRows = validRows();
  alreadyRows[P02_WRITER_GENERATION.KEY] = structuredClone(written);
  const already = make({ rows: alreadyRows });
  const replay = await already.owner.standDownP01Writer();
  equal(replay.outcome, P02_CHROME_STANDDOWN.OUTCOME.ALREADY_STOOD_DOWN,
    'C6 valid p02 is an already-stood-down replay');
  equal(already.area.writes, 0, 'C6 replay writes zero');

  const malformedRows = validRows();
  malformedRows[P02_WRITER_GENERATION.KEY] = { schemaVersion: 99 };
  const malformed = make({ rows: malformedRows });
  equal((await malformed.owner.standDownP01Writer()).outcome,
    P02_CHROME_STANDDOWN.OUTCOME.GENERATION_STATE_INVALID,
    'C7 malformed generation fails closed');
  equal(malformed.area.writes, 0, 'C7 malformed generation writes zero');

  const p01Rows = validRows();
  p01Rows[P02_WRITER_GENERATION.KEY] = { schemaVersion: 1, generation: 'p01' };
  const existingP01 = make({ rows: p01Rows });
  equal((await existingP01.owner.standDownP01Writer()).outcome,
    P02_CHROME_STANDDOWN.OUTCOME.GENERATION_STATE_INVALID,
    'C7 an existing valid p01 decision is not overwritten');
  equal(existingP01.area.writes, 0, 'C7 existing p01 writes zero');

  const unobserved = make({ storageOptions: { failGet: true } });
  equal((await unobserved.owner.standDownP01Writer()).outcome,
    P02_CHROME_STANDDOWN.OUTCOME.GENERATION_STATE_INVALID,
    'C7 unobservable generation fails closed');
  equal(unobserved.area.writes, 0, 'C7 unobservable generation writes zero');

  for (const [label, mutate] of [
    ['missing peer', (rows) => { rows[P02_CHROME_GENERATION.CONFIG_KEY].configuredPeers = []; }],
    ['multiple peers', (rows) => { rows[P02_CHROME_GENERATION.CONFIG_KEY].configuredPeers.push(
      { syncPeerId: 'desktop:other', writerKey: '0'.repeat(64) }); }],
    ['self peer', (rows) => { rows[P02_CHROME_GENERATION.CONFIG_KEY].configuredPeers[0]
      .syncPeerId = LOCAL; }],
    ['auto mode', (rows) => { rows[P02_CHROME_GENERATION.CONFIG_KEY].mode = 'auto'; }],
    ['bad writer key', (rows) => { rows[P02_CHROME_GENERATION.CONFIG_KEY].configuredPeers[0]
      .writerKey = 'f'.repeat(64); }]
  ]) {
    const rows = validRows();
    mutate(rows);
    const fixture = make({ rows });
    equal((await fixture.owner.standDownP01Writer()).outcome,
      P02_CHROME_STANDDOWN.OUTCOME.CONFIGURED_PEER_AUTHORITY_INVALID,
      `C8 ${label} fails configured-peer authority`);
    equal(fixture.area.writes, 0, `C8 ${label} writes zero`);
  }

  /* A failed authority decision releases the temporary hold. */
  const invalidRows = validRows();
  invalidRows[P02_CHROME_GENERATION.CONFIG_KEY].configuredPeers = [];
  const reversible = make({ rows: invalidRows });
  equal((await reversible.owner.standDownP01Writer()).ok, false,
    'C9 pre-commit failure is reported');
  await tick();
  let resumed = 0;
  await createChromeP01MutationAdmission({ lockManager: reversible.locks }).run({
    label: 'fixture-precommit-resume',
    generationCheck: async () => ({ permitted: true, generation: 'p01' }),
    operation: async () => { resumed += 1; }
  });
  equal(resumed, 1, 'C9 pre-commit failure releases admission hold');

  const writeFailure = make({ storageOptions: { failSet: true } });
  const writeFailureResult = await writeFailure.owner.standDownP01Writer();
  equal(writeFailureResult.outcome, P02_CHROME_STANDDOWN.OUTCOME.PERSISTENCE_FAILED,
    'C10 storage failure is typed');
  equal(writeFailure.area.writes, 1, 'C10 no corrective retry follows a failed set');

  const mismatch = make({ storageOptions: {
    afterSet(rows) {
      rows[P02_WRITER_GENERATION.KEY] = { schemaVersion: 99 };
    }
  } });
  equal((await mismatch.owner.standDownP01Writer()).outcome,
    P02_CHROME_STANDDOWN.OUTCOME.READBACK_MISMATCH,
    'C11 exact read-back mismatch is typed');
  equal(mismatch.area.writes, 1, 'C11 read-back mismatch gets no corrective write');

  const noGenerationLocks = make({ locks: {} });
  equal((await noGenerationLocks.owner.standDownP01Writer()).outcome,
    P02_CHROME_STANDDOWN.OUTCOME.SERIALIZATION_UNAVAILABLE,
    'C12 absent admission serialization fails before mutation');
  equal(noGenerationLocks.area.writes, 0, 'C12 absent serialization writes zero');

  const noHold = make({ admission: {} });
  equal((await noHold.owner.standDownP01Writer()).outcome,
    P02_CHROME_STANDDOWN.OUTCOME.P01_NOT_QUIESCENT,
    'C13 missing hold primitive fails closed');
  equal(noHold.area.writes, 0, 'C13 missing hold writes zero');

  /* A writer that throws still releases its admitted lease in finally, so the
   * queued standdown drains and can commit once the failure settles. */
  const throwing = make();
  const throwingPage = createChromeP01MutationAdmission({
    lockManager: throwing.locks
  });
  const throwingEntered = deferred();
  const allowThrow = deferred();
  const throwingWriter = throwingPage.run({
    label: 'fixture-throwing-writer',
    generationCheck: async () => ({ permitted: true, generation: 'p01' }),
    operation: async () => {
      throwingEntered.resolve();
      await allowThrow.promise;
      throw new Error('fixture-writer-failed');
    }
  });
  await throwingEntered.promise;
  const afterThrow = throwing.owner.standDownP01Writer();
  await tick();
  allowThrow.resolve();
  try { await throwingWriter; } catch (_) { /* expected safe writer failure */ }
  equal((await afterThrow).outcome, P02_CHROME_STANDDOWN.OUTCOME.STOOD_DOWN,
    'C13 a throwing admitted writer releases and drain completes');
  equal(throwing.area.writes, 1,
    'C13 the post-drain transition still writes exactly once');

  const panel = read('src-surfaces-base/studio/settings/local-folder-sync.panel.js');
  const background = read(
    'tools/product/extensions/chatgpt/chrome/chrome-live-background.mjs');
  const desktopSources = [
    read('src-surfaces-base/studio/sync/folder-sync.tauri.js'),
    read('src-surfaces-base/studio/sync/sync-object-runtime.tauri.js')
  ].join('\n');
  check(panel.includes('Stand Down Chrome P01 Writer'),
    'C14 Chrome Local Folder exposes the fixed action');
  check(/action === "stand-down-p01-writer"[\s\S]{0,240}event\.isTrusted !== true[\s\S]{0,120}userActivation\?\.isActive !== true/.test(panel),
    'C14 page requires a trusted active Human gesture');
  check(/type: MSG_P01_WRITER_STANDDOWN,\s*build: H2O_BUILD_STAMP/.test(panel),
    'C14 request carries only fixed type/build provenance');
  check(!desktopSources.includes('Stand Down Chrome P01 Writer'),
    'C14 Desktop surfaces do not render the Chrome action');
  const routeStart = background.indexOf('if (msg.type === MSG_P01_WRITER_STANDDOWN)');
  const routeEnd = background.indexOf('if (msg.type === MSG_PAGE_DISABLE_ONCE)', routeStart);
  const route = background.slice(routeStart, routeEnd);
  check(routeStart > 0 && routeEnd > routeStart, 'C15 worker route is present');
  check(route.includes('Object.keys(msg).sort().join(",") !== "build,type"'),
    'C15 worker rejects any request options/authority fields');
  check(route.includes('isTrustedP02StudioSender(sender)'),
    'C15 route reuses exact own-Studio sender identity');
  check(route.includes('msg.build !== H2O_BUILD_STAMP'),
    'C15 route requires exact worker build');
  check(route.includes('__h2oP01WriterStanddownInFlight'),
    'C15 route is single-flight');

  /* C15 asserts absence of forbidden CAPABILITY, not absence of a substring.
   *
   * The route legitimately reads publication and manual-Apply in-flight latches
   * in order to answer `busy`, and a raw scan for "publication"/"apply" saw
   * those identifiers and failed a route that executes none of them. Reading a
   * guard is the opposite of invoking the thing it guards.
   *
   * So the control looks at what the route CALLS. One predicate collects every
   * violation, because the clauses only cover each other in combination - a
   * `runtime.<name>(` pin alone does not see `runtime.p02.runPass()`, which is
   * exactly what the injection control below caught when the clauses were
   * asserted separately. */
  const FORBIDDEN_CALLS = [
    'runPass', 'report',
    'applyNextAdmittedP02Revision', 'applyNextAdmittedRevision', 'manualApply', 'applyP02',
    'publish', 'publishP02', 'publishRevision', 'firstPublication',
    'receiveAdmit', 'admitP02', 'admitRevision', 'runReceive', 'receive'
  ];
  const standdownRouteViolations = (source) => {
    const violations = [];
    const called = new Set();
    const callRe = /\.\s*([A-Za-z_$][\w$]*)\s*\(/g;
    let m;
    while ((m = callRe.exec(source)) !== null) called.add(m[1]);
    for (const name of FORBIDDEN_CALLS) {
      if (called.has(name)) violations.push(`forbidden-call:${name}`);
    }
    /* Any runtime capability other than the single permitted one. */
    const runtimeCalls = [...source.matchAll(/runtime\s*\.\s*([A-Za-z_$][\w$]*)\s*\(/g)]
      .map((hit) => hit[1]);
    for (const name of runtimeCalls) {
      if (name !== 'standDownP01Writer') violations.push(`runtime-call:${name}`);
    }
    if (runtimeCalls.length !== 1) violations.push(`runtime-call-count:${runtimeCalls.length}`);
    /* Any reach into the P02 runtime surface at all, chained or not. */
    if (/\.\s*p02\s*\./.test(source)) violations.push('p02-surface-reached');
    return violations;
  };

  const routeViolations = standdownRouteViolations(route);
  check(routeViolations.length === 0,
    `C15 standdown route invokes no Receive/runPass/Apply/publication capability (saw ${JSON.stringify(routeViolations)})`);
  check(/__h2oP02PublicationInFlight|__h2oW3ManualApplyInFlight/.test(route),
    'C15 route still consults publication/manual-Apply in-flight guards to answer busy');

  /* Non-vacuous. Each injection is a real forbidden call in a disposable copy of
   * the route; the last case only reads one more guard identifier. */
  const inject = (replacement) => route.replace(
    'const result = await runtime.standDownP01Writer();', replacement);
  const injections = [
    ['nested runPass', inject('const result = await runtime.p02.runPass(); await runtime.standDownP01Writer();')],
    ['direct runPass', inject('await runtime.runPass(); const result = await runtime.standDownP01Writer();')],
    ['Apply invocation', inject('await runtime.applyNextAdmittedP02Revision(); const result = await runtime.standDownP01Writer();')],
    ['publication invocation', inject('await runtime.publishP02(); const result = await runtime.standDownP01Writer();')],
    ['Receive handler execution', inject('await runtime.receiveAdmit(); const result = await runtime.standDownP01Writer();')]
  ];
  for (const [label, mutated] of injections) {
    check(standdownRouteViolations(mutated).length > 0,
      `C15 RED control: an injected ${label} is detected`);
  }
  const withHarmlessGuard = route.replace(
    '__h2oW3ManualApplyInFlight) {',
    '__h2oW3ManualApplyInFlight || __h2oP02PublicationInFlight) {');
  check(standdownRouteViolations(withHarmlessGuard).length === 0,
    'C15 GREEN control: reading another in-flight guard identifier does not trip the control');

  /* Render the actual panel in a Chrome-shaped Studio realm. A trusted click
   * sends exactly one fixed request; an untrusted click sends none. */
  const listeners = [];
  let registration = null;
  let rendered = null;
  const messages = [];
  const view = {
    clean: (value) => String(value == null ? '' : value).trim(),
    escapeHtml: (value) => String(value == null ? '' : value),
    valueText: (value, fallback = 'Not available') =>
      String(value == null ? '' : value).trim() || fallback,
    statusRows: (rows) => rows.map(([label, value]) => `${label}:${value}`).join('|'),
    card: (title, body) => `<section><h3>${title}</h3>${body}</section>`,
    action: (id, label, options = {}) =>
      `<button data-domain-action="${id}"${options.disabled ? ' disabled' : ''}>${label}</button>`,
    link: (target, label) => `<a href="${target}">${label}</a>`,
    frame: () => (rendered = {
      html: '', contains: () => true, querySelector: () => ({ disabled: false })
    }),
    listen: (_root, type, handler) => {
      listeners.push({ type, handler });
      return () => {};
    },
    setBody: (target, html) => { target.html = html; }
  };
  const sandbox = {
    globalThis: null,
    H2O: { Studio: {
      settings: { domainPanels: {
        view,
        register: (spec) => { registration = spec; },
        loadScriptOnce: async () => true
      } },
      sync: { folder: {
        connectFolder: async () => ({ ok: true }),
        disconnectFolder: async () => ({ ok: true }),
        authorizeChromePublishing: async () => ({ ok: true }),
        getReadinessSnapshot: async () => ({
          foundation: { ready: true },
          localFolder: { ready: true },
          browserDelivery: { ready: true }
        }),
        getConnectedDirectoryHandle: () => ({ name: 'fixture-folder' })
      } }
    } },
    chrome: { runtime: {
      id: 'fixture-extension-id',
      lastError: null,
      sendMessage(message, callback) {
        messages.push(structuredClone(message));
        callback({
          schema: P02_CHROME_STANDDOWN.RESULT_SCHEMA,
          ok: true,
          outcome: 'stood-down',
          storageWrites: 1,
          verified: true,
          generation: 'p02',
          p01MayMutate: false
        });
      }
    } },
    navigator: { userActivation: { isActive: true } },
    console, Promise, Object, Array, String, JSON, Set, Number, Math, Date
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(panel, sandbox, {
    filename: 'settings/local-folder-sync.panel.js'
  });
  await registration.mount({});
  check(rendered.html.includes('data-domain-action="stand-down-p01-writer"'),
    'C16 actual Chrome render contains the standdown control');
  check(rendered.html.includes('Stand Down Chrome P01 Writer'),
    'C16 actual Chrome render contains the exact Human label');
  const click = listeners.filter((entry) => entry.type === 'click').pop().handler;
  const button = { dataset: { domainAction: 'stand-down-p01-writer' }, disabled: false };
  await click({
    isTrusted: false,
    target: { closest: () => button },
    preventDefault() {}
  });
  equal(messages.length, 0, 'C16 untrusted click sends zero requests');
  await click({
    isTrusted: true,
    target: { closest: () => button },
    preventDefault() {}
  });
  equal(messages.length, 1, 'C16 one trusted click sends exactly one request');
  equal(Object.keys(messages[0]).sort().join(','), 'build,type',
    'C16 trusted request has only build/type fields');
  equal(messages[0].type, 'h2o-ext-p02-standdown-p01-writer:v1',
    'C16 trusted request selects only the fixed standdown operation');
  check(rendered.html.includes('P01 mutation:Refused'),
    'C16 verified refusal is rendered from the typed result');
}

/* Optional candidate boundary: the canonical builder copies the owner module
 * verbatim and emits the worker/panel from the same committed source. */
if (generatedStanddownRoot) {
  const generatedModulePath = path.join(generatedStanddownRoot,
    'surfaces/studio/browser-adapters/chrome/sync-writer-generation-chrome-v2.mjs');
  const generatedPanelPath = path.join(generatedStanddownRoot,
    'surfaces/studio/settings/local-folder-sync.panel.js');
  const generatedBackgroundPath = path.join(generatedStanddownRoot, 'bg.js');
  check(fs.existsSync(generatedModulePath) && fs.existsSync(generatedPanelPath) &&
    fs.existsSync(generatedBackgroundPath),
  'C17 generated candidate contains owner, panel and worker');
  const generatedModule = fs.readFileSync(generatedModulePath, 'utf8');
  const generatedPanel = fs.readFileSync(generatedPanelPath, 'utf8');
  const generatedBackground = fs.readFileSync(generatedBackgroundPath, 'utf8');
  equal(generatedModule,
    read('packages/browser-adapters/chrome/sync-writer-generation-chrome-v2.mjs'),
  'C17 generated canonical owner is byte-identical to authored owner');
  equal((generatedModule.match(/promisify\(area, 'set'/g) || []).length, 1,
    'C17 generated owner has one generation persistence call site');
  check(generatedPanel.includes('Stand Down Chrome P01 Writer') &&
    generatedPanel.includes('h2o-ext-p02-standdown-p01-writer:v1'),
  'C17 generated Studio contains the trusted action and fixed op');
  check(generatedBackground.includes('h2o-ext-p02-standdown-p01-writer:v1') &&
    generatedBackground.includes('isTrustedP02StudioSender(sender)') &&
    generatedBackground.includes('__h2oP01WriterStanddownInFlight'),
  'C17 generated worker contains trust, build and single-flight route');
  equal((generatedBackground.match(/\.p02\.runPass\([^)]*\)/g) || []).length, 1,
    'C17 generated worker retains exactly one trusted manual-stage runPass caller');
  generatedStanddownChecked = true;
}

/* ---------------------------------------------------------------------------
 * W (O1-B2.1) — the gate must be WIRED, not merely mentioned.
 *
 * The original coverage check asked whether a seam's file contained a gate
 * identifier. The Chrome publication writer contained one and was still
 * ungated: its gate is an INJECTED parameter whose default is a permissive
 * stub, and neither production composition passed anything in. The file
 * mentioned the gate; the running product consulted the stub.
 *
 * So these prove three things a text search cannot: that one operation has one
 * NAME on every gate surface, that both production compositions actually hand a
 * gate over, and that a p02 record reaching that composition refuses.
 * ------------------------------------------------------------------------ */
{
  /* W1. One operation, one name. The core gate used to offer only
   * `requirePermitted`, so a seam asking for `p01MayMutate` got undefined,
   * called it, threw, and had the throw swallowed by its own fail-closed
   * catch - a gate that looked wired and answered nothing. */
  const answered = { get: (keys, cb) => cb({}) };
  const surfaces = [
    ['core', createP01MutationGate({ store: { read: async () => null } })],
    ['chrome port', createChromeP01MutationGate({ storageArea: answered })]
  ];
  for (const [name, gate] of surfaces) {
    check(typeof gate.p01MayMutate === 'function',
      `W1 the ${name} gate exposes p01MayMutate, the name every seam calls`);
    check(typeof gate.requirePermitted === 'function',
      `W1 the ${name} gate keeps requirePermitted for existing callers`);
    const viaSeamName = await gate.p01MayMutate();
    const viaOriginal = await gate.requirePermitted();
    equal(viaSeamName.permitted, viaOriginal.permitted,
      `W1 both names on the ${name} gate answer identically`);
  }
  const globalGate = read('src-surfaces-base/studio/sync/writer-generation-gate.js');
  check(/p01MayMutate:\s*p01MayMutate/.test(globalGate),
    'W1 the installed global gate exposes the same name');

  /* W1b. THREE names are called by seams, not two: two Desktop seams call
   * p01MayMutateBoolean. Every surface must answer every name a seam calls,
   * because the seams treat a MISSING method as "no gate installed" and PERMIT.
   * A surface short of a name would therefore fail OPEN. */
  for (const [name, gate] of surfaces) {
    check(typeof gate.p01MayMutateBoolean === 'function',
      `W1b the ${name} gate answers p01MayMutateBoolean too`);
    equal(await gate.p01MayMutateBoolean(), (await gate.p01MayMutate()).permitted,
      `W1b and the ${name} boolean form agrees with the verdict form`);
  }
  check(/p01MayMutateBoolean:\s*p01MayMutateBoolean/.test(globalGate),
    'W1b the installed global gate answers it as well');

  /* W1c. A gate that is PRESENT but does not answer must fail CLOSED. Absent
   * and broken are different facts, and only one of them may permit. */
  for (const rel of [
    'src-surfaces-base/studio/sync/sync-object-auto-reconcile.js',
    'src-surfaces-base/studio/sync/folder-sync.tauri.js'
  ]) {
    const source = read(rel);
    const at = source.indexOf('async function generationPermitsP01Mutation()');
    const helper = source.slice(at, source.indexOf('}', source.indexOf('p01MayMutateBoolean()', at)));
    check(/if \(!gate\) return true;/.test(helper),
      `W1c ${rel.split('/').pop()} permits only when there is NO gate at all`);
    check(/typeof gate\.p01MayMutateBoolean !== 'function'\) return false;/.test(helper),
      `W1c ${rel.split('/').pop()} refuses a gate that cannot answer`);
  }

  /* W2. Both production compositions INJECT the gate. Read the argument object
   * each one passes, not the file it lives in. */
  const compositions = [
    ['packages/browser-adapters/chrome/sync-background-reconcile.mjs',
      'the Chrome background automatic publication lane'],
    ['src-surfaces-base/studio/sync/local-publication.mv3.js',
      'the Chrome manual publication lane']
  ];
  for (const [file, description] of compositions) {
    const source = read(file);
    const at = source.indexOf('createChromeLocalPublicationWriter({');
    check(at > 0, `W2 ${description} builds the publication writer`);
    const args = source.slice(at, source.indexOf('});', at));
    check(/writerGenerationGate/.test(args),
      `W2 ${description} injects the generation gate into the writer`);
  }

  /* W3. The writer's default is permissive BY DESIGN - that is the pre-T19
   * compatibility position - which is exactly why W2 has to exist. Stated here
   * so the default can never be "fixed" into a refusal without someone reading
   * why it is the way it is. */
  const writerSource = read('packages/browser-adapters/chrome/local-publication-writer.mjs');
  check(/writerGenerationGate = \{ p01MayMutate: async \(\) => \(\{\s*permitted: true/.test(writerSource),
    'W3 the writer default is the documented permissive compatibility position');

  /* W4. Behaviour, not wiring: a p02 record reaching the real writer refuses,
   * and refuses before it touches a folder, a ledger or a projection. */
  const touched = [];
  const trap = new Proxy({}, {
    get(_target, property) {
      touched.push(String(property));
      return () => { throw new Error('the writer must not reach this'); };
    }
  });
  const writerModule = await import(
    '../../../packages/browser-adapters/chrome/local-publication-writer.mjs'
  );
  const gateReturning = (verdictValue) => ({ p01MayMutate: async () => verdictValue });

  const standDown = writerModule.createChromeLocalPublicationWriter({
    projection: trap, ledger: trap, folderAuthority: trap,
    cryptoImplementation: globalThis.crypto,
    writerGenerationGate: gateReturning({
      permitted: false, reason: P02_GENERATION_ERROR.STOOD_DOWN
    })
  });
  touched.length = 0;   /* construction validates its collaborators; only what
                         * happens AFTER it says anything about the gate. */
  let refusal = null;
  try { await standDown.publishLocalRevision('chat-1'); }
  catch (error) { refusal = error; }
  check(refusal !== null, 'W4 a stood-down generation refuses the publication');
  check(String(refusal?.code || refusal?.message).includes(P02_GENERATION_ERROR.STOOD_DOWN),
    'W4 and refuses with the standdown reason');
  equal(touched.length, 0,
    'W4 and refuses before touching the projection, ledger or folder');

  /* W5. An unreadable store refuses too - through the same composition, so the
   * fail-closed posture is a property of the wiring and not just of the gate. */
  const unreadable = writerModule.createChromeLocalPublicationWriter({
    projection: trap, ledger: trap, folderAuthority: trap,
    cryptoImplementation: globalThis.crypto,
    writerGenerationGate: { p01MayMutate: async () => { throw new Error('store down'); } }
  });
  touched.length = 0;
  let unreadableRefusal = null;
  try { await unreadable.publishLocalRevision('chat-1'); }
  catch (error) { unreadableRefusal = error; }
  check(unreadableRefusal !== null, 'W5 an unreadable store refuses the publication');
  equal(touched.length, 0, 'W5 and still touches nothing');

  /* W6. A positively absent record permits, so the accepted product keeps
   * working. The publication proceeds past the gate and fails later, on the
   * trap - which is the proof it got past the gate at all. */
  const absent = writerModule.createChromeLocalPublicationWriter({
    projection: trap, ledger: trap, folderAuthority: trap,
    cryptoImplementation: globalThis.crypto,
    writerGenerationGate: gateReturning({ permitted: true, reason: null })
  });
  touched.length = 0;
  let outcome = null;
  try { await absent.publishLocalRevision('chat-1'); }
  catch (error) { outcome = String(error?.code || error?.message || ''); }
  /* It still fails - these collaborators are traps - but it must fail for one
   * of the writer's OWN reasons. What matters is that the generation is no
   * longer what stopped it. */
  const generationReasons = Object.values(P02_GENERATION_ERROR);
  check(outcome !== null, 'W6 the permitted publication still runs to a verdict');
  check(!generationReasons.some((reason) => outcome.includes(reason)),
    `W6 a permitted generation is not what refuses (got ${outcome})`);
}

/* ---------------------------------------------------------------------------
 * N (O1-B2.1) — the native P01 transport command.
 *
 * The Item11 delivery writer is NOT the only native direct-write bypass point.
 * `h2o_sync_object_publish_transport` is a registered Tauri command that writes
 * the revision blob and the head document, reachable from anything in the
 * webview, and it had no generation gate.
 * ------------------------------------------------------------------------ */
{
  const transport = read('apps/studio/desktop/src-tauri/src/sync_object_transport.rs');
  const production = transport.slice(0, transport.indexOf('#[cfg(test)]'));
  const commandAt = production.indexOf('pub async fn h2o_sync_object_publish_transport');
  check(commandAt > 0, 'N1 the publish command is async so it can observe the generation');
  const body = production.slice(commandAt);
  const command = body.slice(0, body.indexOf('#[tauri::command]') > 0
    ? body.indexOf('#[tauri::command]') : body.length);

  check(command.includes('observe_generation'), 'N2 the command observes the generation');
  check(command.includes('DbInstances') || production.includes('use tauri_plugin_sql::DbInstances'),
    'N3 the command takes the database state it needs to observe it');
  const refusalAt = command.indexOf('generation_refusal');
  const transportAt = command.indexOf('production_transport');
  check(refusalAt > 0 && transportAt > 0 && refusalAt < transportAt,
    'N4 it refuses before a transport - and therefore a credential - exists');
  check(command.includes('require_profile_runtime_session'),
    'N5 the profile-session check it already had remains load-bearing');

  /* The read path is untouched: a standdown stops P01 WRITING. Refusing to read
   * would strand the data rather than transfer it. */
  const pullAt = production.indexOf('pub fn h2o_sync_object_pull_transport');
  const pull = production.slice(pullAt, production.indexOf('\n}\n', pullAt));
  check(!pull.includes('generation_refusal'), 'N6 the pull/read command is NOT gated');

  /* The P02 lane must never consult the P01 gate: gating it would refuse the
   * writer the standdown exists to install. */
  for (const rel of [
    'apps/studio/desktop/src-tauri/src/p02_activation.rs',
    'apps/studio/desktop/src-tauri/src/p02_publication_authority.rs',
    'apps/studio/desktop/src-tauri/src/p02_writer_storage.rs'
  ]) {
    check(!read(rel).includes('require_p01_mutation_permitted'),
      `N7 the P02 lane (${rel.split('/').pop()}) is unaffected`);
  }
}

/* ---------------------------------------------------------------------------
 * G (O1-B2.1) — GENERIC_SHARED_TRANSPORT: P01 GATE AT FEATURE ENTRY POINT.
 *
 * The Desktop exporter and the peer-transport mirror do not reach disk through
 * any P01-specific command. They call the GENERIC `plugin:fs|write_text_file`,
 * a substrate shared with features that have nothing to do with P01.
 *
 * Gating that substrate would refuse writes on behalf of unrelated features, so
 * the enforcement boundary for these is the H2O-authored P01 feature entry
 * point instead. That is a sound ruling only while two things hold, and both
 * are checked here rather than asserted in a comment: every H2O-authored route
 * to those writes passes a gated entry point, and no P01-specific native
 * command offers a way around them.
 * ------------------------------------------------------------------------ */
{
  const exporter = read('src-surfaces-base/studio/ingestion/export-bundle.tauri.js');

  /* G1. The exporter is the entry point, and it is gated before it writes. */
  const entryAt = exporter.indexOf('async function exportLatestSyncBundle(');
  const gateAt = exporter.indexOf('await generationPermitsP01Mutation()', entryAt);
  const mirrorAt = exporter.indexOf('writePeerTransportMirrorSafely({', entryAt);
  check(entryAt > 0, 'G1 the Desktop exporter entry point exists');
  check(gateAt > entryAt, 'G1 and consults the generation gate');
  check(mirrorAt > gateAt, 'G1 and does so BEFORE the peer-transport mirror write');

  /* G2. The mirror writer has exactly one production caller, and it is that
   * gated entry point. A second caller would be a second, ungated route. */
  const mirrorCallers = [];
  for (const rel of [
    'src-surfaces-base/studio/ingestion/export-bundle.tauri.js',
    'src-surfaces-base/studio/sync/folder-sync.tauri.js',
    'src-surfaces-base/studio/sync/auto-export.tauri.js',
    'src-surfaces-base/studio/sync/sync-object-runtime.tauri.js'
  ]) {
    const source = read(rel);
    if (/peerTransport\.writeLatestMirror|writeLatestMirror\(/.test(source)) mirrorCallers.push(rel);
  }
  equal(mirrorCallers.length, 1, 'G2 the peer-transport mirror has one production caller');
  check(mirrorCallers[0].endsWith('export-bundle.tauri.js'),
    'G2 and it is the gated exporter');

  /* G3. No P01-specific NATIVE command writes the sync folder, so there is no
   * native route that skips the JS entry point the way the transport command
   * did. This is the half of the ruling that would fail silently if someone
   * later added such a command. */
  const nativeDir = 'apps/studio/desktop/src-tauri/src';
  const nativeCommands = fs.readdirSync(path.join(root, nativeDir))
    .filter((name) => name.endsWith('.rs'))
    .flatMap((name) => {
      const source = read(`${nativeDir}/${name}`);
      const production = source.includes('#[cfg(test)]')
        ? source.slice(0, source.indexOf('#[cfg(test)]'))
        : source;
      return [...production.matchAll(/pub (?:async )?fn (h2o_[a-z0-9_]+)/g)]
        .map((match) => ({ name: match[1], file: name, production }));
    });
  const sameLine = (source, needle) => source.includes(needle);
  const p01ByteWriters = nativeCommands.filter(({ name }) =>
    ['h2o_item11_prepare_delivery', 'h2o_item11_prepare_local_delivery',
      'h2o_sync_object_publish_transport'].includes(name));
  equal(p01ByteWriters.length, 3, 'G3 the three P01 native byte writers are present');
  for (const { name, production } of p01ByteWriters) {
    const at = production.indexOf(`fn ${name}`);
    const body = production.slice(at, at + 2000);
    check(sameLine(body, 'require_p01_mutation_permitted') || sameLine(body, 'generation_refusal'),
      `G3 ${name} consults the generation gate`);
  }

  /* G4. And the exporter has no native command of its own to be skipped
   * through - if one ever appears, this ruling needs revisiting rather than
   * quietly continuing to hold. */
  const exporterNative = nativeCommands.filter(({ name }) =>
    /export|latest|bundle|mirror/.test(name));
  equal(exporterNative.length, 0,
    'G4 no P01-specific native command writes the exporter/mirror bytes');
}

/* ---------------------------------------------------------------------------
 * P (O1-B2.2) — the PACKED output, which is what actually runs.
 *
 * Source gating is a claim about what will be built. The Chrome extension and
 * the Desktop frontend both run from generated trees, and those trees were
 * stale: they composed the publication writer WITHOUT the gate long after the
 * source stopped doing so. A gate that is correct in source and absent in the
 * artifact is not protecting anyone.
 *
 * These are CONDITIONAL by design. Both trees are gitignored, so a fresh
 * checkout has none and asserting unconditionally would manufacture a permanent
 * red. But when a tree IS present, being stale is a failure - the absent case
 * and the wrong case must not share an answer, which is the same rule the gate
 * itself lives by.
 * ------------------------------------------------------------------------ */
const packedFindings = { chromePresent: false, desktopPresent: false };
{
  const exists = (rel) => fs.existsSync(path.join(root, rel));

  const CHROME_BG = 'apps/extensions/chatgpt/chrome/prod/bg.js';
  if (exists(CHROME_BG)) {
    packedFindings.chromePresent = true;
    const bg = read(CHROME_BG);

    /* P1. The production composition INJECTS the gate. Read the argument object
     * of the real construction, not the file. */
    const at = bg.lastIndexOf('createChromeLocalPublicationWriter({');
    check(at > 0, 'P1 the packed Chrome background composes the publication writer');
    const args = bg.slice(at, bg.indexOf('});', at));
    check(/writerGenerationGate/.test(args),
      'P1 and the packed composition injects the generation gate');

    /* P2. The value injected is the REAL gate over chrome.storage.local, not
     * some other object that happens to share the name. */
    check(/writerGenerationGate = createChromeP01MutationGate\(\{/.test(bg),
      'P2 the packed gate is built by createChromeP01MutationGate');

    /* P3. p01WriterActive consults it, and the packed gate ANSWERS that name -
     * the packed bundle previously carried a gate without p01MayMutate, so the
     * call threw and the signal was unconditionally false. */
    check(/p01WriterActive: async \(\) => \{[\s\S]{0,200}writerGenerationGate\.p01MayMutate\(\)/
      .test(bg), 'P3 packed p01WriterActive consults the real gate');
    check(/p01MayMutate: verdictFor/.test(bg),
      'P3 and the packed core gate answers p01MayMutate');
    check(/async p01MayMutateBoolean\(\)/.test(bg),
      'P3 and answers p01MayMutateBoolean too');

    /* P4. The permissive stub still EXISTS as the documented compatibility
     * default, but is no longer the effective production composition. Both
     * halves matter: losing the default would break pre-T19 callers, and
     * relying on it would leave production ungated. */
    check(/writerGenerationGate = \{ p01MayMutate: async \(\) => \(\{/.test(bg),
      'P4 the compatibility default survives in the packed writer');
    const stubAt = bg.indexOf('writerGenerationGate = { p01MayMutate: async () => ({');
    check(stubAt > 0 && stubAt < at,
      'P4 and the injected composition comes after it, so the stub is not what runs');
  }

  const DESKTOP_DIST = 'apps/studio/desktop/dist';
  if (exists(`${DESKTOP_DIST}/sync/local-publication.mv3.js`)) {
    packedFindings.desktopPresent = true;

    /* P5. The Desktop frontend carries the manual-lane injection. */
    const manual = read(`${DESKTOP_DIST}/sync/local-publication.mv3.js`);
    check(/writerGenerationGate: writerGenerationSurface\(\)/.test(manual),
      'P5 the packed Desktop manual lane injects the installed gate');

    /* P6. And the corrected seams: a gate that cannot answer must refuse. */
    for (const rel of ['sync/sync-object-auto-reconcile.js', 'sync/folder-sync.tauri.js']) {
      const source = read(`${DESKTOP_DIST}/${rel}`);
      check(/typeof gate\.p01MayMutateBoolean !== 'function'\) return false;/.test(source),
        `P6 the packed ${rel.split('/').pop()} refuses a gate that cannot answer`);
    }

    /* P7. The gate itself ships, and ahead of the writers that consult it. */
    check(exists(`${DESKTOP_DIST}/sync/writer-generation-gate.js`),
      'P7 the packed Desktop tree ships the gate');
    const html = read(`${DESKTOP_DIST}/studio.html`);
    const gateAt = html.indexOf('writer-generation-gate.js');
    check(gateAt > 0, 'P7 and registers it in the packed studio.html');
    for (const writer of ['folder-sync.tauri.js', 'sync-object-auto-reconcile.js']) {
      check(html.indexOf(writer) > gateAt, `P7 and loads it before ${writer}`);
    }
  }
}

/* ---------------------------------------------------------------------------
 * O (O1-B2.2) — SCOPE, and the ownership rulings that follow from it.
 *
 * The contract has two halves and needs both. One half alone says a stood-down
 * installation still publishes; the other alone turns the standdown into a
 * freeze in which the user cannot rename a folder and no inbound convergence
 * can be applied. The scope is the ARTIFACT, not the act of writing.
 * ------------------------------------------------------------------------ */
{
  /* O1. Both halves are recorded, as data rather than prose. */
  check(/sync-artifact mutation capability/.test(P02_STANDDOWN_SCOPE.STATEMENT),
    'O1 the scope statement is recorded');
  check(/not a global freeze/.test(P02_STANDDOWN_SCOPE.STATEMENT),
    'O1 and states what standdown is NOT');
  check(/must consult writer-generation/.test(P02_STANDDOWN_SCOPE.OBLIGATION),
    'O1 and the obligation on P01 paths coexists with it');
  check(P02_STANDDOWN_SCOPE.ARTIFACTS.length >= 6,
    'O1 the artifacts the gate governs are enumerated');
  check(P02_STANDDOWN_SCOPE.OUT_OF_SCOPE.length === 4,
    'O1 and the four out-of-scope kinds are enumerated');
  for (const entry of P02_STANDDOWN_SCOPE.OUT_OF_SCOPE) {
    check(typeof entry.why === 'string' && entry.why.length > 40,
      `O1 out-of-scope kind ${entry.kind} records WHY, not just that it is excluded`);
  }

  /* O2. Every recorded ruling is complete. An exclusion that cannot say what it
   * excludes, under whose authority, and why this record does not apply, is an
   * exclusion nobody can audit later - so incompleteness is a failure here
   * rather than a silently weaker claim. */
  equal(P01_OWNERSHIP_RULINGS.length, 4, 'O2 four ownership rulings are recorded');
  for (const ruling of P01_OWNERSHIP_RULINGS) {
    for (const field of OWNERSHIP_REQUIRED_FIELDS) {
      check(typeof ruling[field] === 'string' && ruling[field].trim().length > 0,
        `O2 ${ruling.symbol} records ${field}`);
    }
    check(/^OUT_OF_T19 — /.test(ruling.classification),
      `O2 ${ruling.symbol} carries an OUT_OF_T19 classification`);
    check(ruling.evidence.length > 60, `O2 ${ruling.symbol} cites concrete evidence`);
  }

  /* O3. The four excluded paths must NOT have acquired a gate. Excluding a path
   * and gating it anyway would mean the ruling was not applied. */
  for (const ruling of P01_OWNERSHIP_RULINGS) {
    const source = read(ruling.file);
    check(!/require_p01_mutation_permitted|p01MayMutate\(|generationPermitsP01Mutation/
      .test(source),
      `O3 ${ruling.symbol} was NOT gated - the ruling is applied, not overridden`);
  }

  /* O4. And the exclusions did not leak: the paths the gate DOES govern still
   * consult it. A scope ruling must narrow the gate's reach without loosening
   * its grip on what remains. */
  for (const [rel, symbol] of [
    ['src-surfaces-base/studio/sync/sync-object-runtime.tauri.js', 'publishObject'],
    ['src-surfaces-base/studio/ingestion/export-bundle.tauri.js', 'exportLatestSyncBundle'],
    ['src-surfaces-base/studio/sync/auto-import.mv3.js', 'exportNow'],
    ['packages/browser-adapters/chrome/local-publication-writer.mjs',
      'publishLocalRevisionInternal']
  ]) {
    const source = read(rel);
    check(/p01MayMutate|generationPermitsP01Mutation/.test(source),
      `O4 ${symbol} still consults the gate after the scope ruling`);
  }

  /* O5. The generic-substrate condition, which is the one the ruling made
   * conditional: no P01-specific publication route may reach it. The producers
   * of every P01 artifact are checked from the ARTIFACT side, so a new caller
   * would have to be added to one of them to slip past. */
  const substrateNames = ['executeAuthorizedSqlite', 'executeSettlementSqlite',
    'withSQLiteWriterIdentity', 'f15_authorized_sqlite_execute'];
  for (const rel of [
    'src-surfaces-base/studio/sync/sync-object-runtime.tauri.js',
    'src-surfaces-base/studio/ingestion/export-bundle.tauri.js',
    'src-surfaces-base/studio/sync/auto-import.mv3.js',
    'src-surfaces-base/studio/sync/peer-transport.js',
    'src-surfaces-base/studio/sync/export-log.js',
    'src-surfaces-base/studio/sync/browser-delivery-producer.tauri.js',
    'packages/browser-adapters/chrome/local-publication-writer.mjs',
    'packages/browser-adapters/chrome/sync-background-reconcile.mjs'
  ]) {
    const source = read(rel);
    for (const name of substrateNames) {
      check(!source.includes(name),
        `O5 the P01 artifact producer ${rel.split('/').pop()} does not reach ${name}`);
    }
  }
}

const verdict = failures.length === 0
  ? 'P02_O1_WRITER_GENERATION_STANDDOWN_PASS' : 'P02_O1_WRITER_GENERATION_STANDDOWN_FAIL';

async function scenarioGenerationStateConsumerVocabulary() {
  /* The prior validators missed a live product defect because they injected
   * hand-written doubles returning {state:'present'} - a token the canonical
   * observer cannot emit. So this control drives the REAL gate over a REAL
   * persisted p02 record and evaluates the SHIPPED consumer predicates.
   *
   * Both P02 publication consumers were testing 'present', so a valid standdown
   * produced generation-unreadable and p02-chrome-publication-p01-not-stood-down,
   * and manual and automatic publication were both unreachable behind a
   * fail-closed verdict. */
  const CONSUMERS = [
    ['packages/browser-adapters/chrome/sync-background-reconcile.mjs',
     /if \(generationObservation\?\.state === [^&]+&&\n\s*generationObservation\?\.generation === [^)]+\) \{/],
    ['packages/browser-adapters/chrome/sync-p02-publication-chrome-v2.mjs',
     /if \(observation\?\.state !== [\s\S]*?fail\('p02-chrome-publication-p01-not-stood-down'\);\n\s*\}/]
  ];

  /* Canonical vocabulary, read from the producer rather than restated here. */
  const producer = read('packages/core/sync-writer-generation-v2.mjs');
  const vocabulary = new Set(Object.values(P02_GENERATION_STATE));
  check(vocabulary.has('recorded') && vocabulary.has('absent-observed') &&
        vocabulary.has('malformed') && vocabulary.has('unobserved') && vocabulary.size === 4,
    'GEN canonical producer vocabulary is exactly the four known states');
  check(!producer.includes("'present'"),
    'GEN the canonical producer never emits a present state');

  /* Structural: no P02 generation consumer may test a token outside it. */
  for (const [file, extract] of CONSUMERS) {
    const source = read(file);
    const match = source.match(extract);
    check(!!match, `GEN consumer predicate is locatable in ${file}`);
    const literals = [...match[0].matchAll(/state\s*[!=]==\s*'([a-z-]+)'/g)].map((hit) => hit[1]);
    const outside = literals.filter((token) => !vocabulary.has(token));
    check(outside.length === 0,
      `GEN ${file} tests no generation-state token outside the canonical vocabulary (saw ${JSON.stringify(outside)})`);
    check(match[0].includes('P02_GENERATION_STATE.RECORDED'),
      `GEN ${file} uses the exported canonical recorded constant`);
  }

  /* Behavioural: the REAL gate over a REAL valid p02 record. */
  const area = answeringArea({
    [P02_WRITER_GENERATION.KEY]: {
      schema: P02_WRITER_GENERATION.SCHEMA,
      schemaVersion: P02_WRITER_GENERATION.SCHEMA_VERSION,
      generation: P02_WRITER_GENERATION.P02,
      standdownAt: '2026-09-04T00:00:00.000Z',
      decidedByWriterSyncPeerId: 'studio-chrome:mv3-chrome:idb-archive:gen-control-peer',
      reason: P02_CHROME_GENERATION.STANDDOWN_REASON
    }
  });
  const realGate = createChromeP01MutationGate({ storageArea: area, seamName: 'gen-vocabulary-control' });
  const observation = await realGate.observe();
  const verdict = await realGate.p01MayMutate();
  equal(observation.state, P02_GENERATION_STATE.RECORDED,
    'GEN the real producer reports recorded for a valid persisted p02 record');
  equal(observation.generation, P02_WRITER_GENERATION.P02, 'GEN and generation p02');

  const evaluateConsumers = (obs) => {
    const bg = read(CONSUMERS[0][0]).match(CONSUMERS[0][1])[0];
    const pub = read(CONSUMERS[1][0]).match(CONSUMERS[1][1])[0];
    const a = new Function('generationObservation', 'P02_GENERATION_STATE', 'P02_WRITER_GENERATION',
      `${bg} return true; } return false;`)(obs, P02_GENERATION_STATE, P02_WRITER_GENERATION);
    let b = true;
    try {
      new Function('observation', 'verdict', 'fail', 'P02_GENERATION_STATE', 'P02_WRITER_GENERATION',
        pub)(obs, verdict, (code) => { throw new Error(code); }, P02_GENERATION_STATE, P02_WRITER_GENERATION);
    } catch (_) { b = false; }
    return { automaticReachable: a, publicationGranted: b };
  };
  const granted = evaluateConsumers(observation);
  check(granted.automaticReachable,
    'GEN background automatic authority accepts real recorded/p02 (no generation-unreadable)');
  check(granted.publicationGranted,
    'GEN publication authority accepts real recorded/p02 (no p01-not-stood-down)');

  /* Negative matrix, every state from the real producer. */
  for (const [label, rows] of [
    ['absent-observed', {}],
    ['malformed', { [P02_WRITER_GENERATION.KEY]: { schema: 'wrong' } }],
    ['recorded/p01', { [P02_WRITER_GENERATION.KEY]: { schema: P02_WRITER_GENERATION.SCHEMA,
      schemaVersion: 1, generation: 'p01', standdownAt: '2026-09-04T00:00:00.000Z',
      decidedByWriterSyncPeerId: 'studio-chrome:mv3-chrome:idb-archive:gen-control-peer',
      reason: P02_CHROME_GENERATION.STANDDOWN_REASON } }],
    ['future/p03', { [P02_WRITER_GENERATION.KEY]: { schema: P02_WRITER_GENERATION.SCHEMA,
      schemaVersion: 1, generation: 'p03', standdownAt: '2026-09-04T00:00:00.000Z',
      decidedByWriterSyncPeerId: 'studio-chrome:mv3-chrome:idb-archive:gen-control-peer',
      reason: P02_CHROME_GENERATION.STANDDOWN_REASON } }]
  ]) {
    const g = createChromeP01MutationGate({ storageArea: answeringArea(rows), seamName: 'gen-negative' });
    const obs = await g.observe();
    const outcome = evaluateConsumers(obs);
    check(!outcome.automaticReachable && !outcome.publicationGranted,
      `GEN ${label} gains no publication authority`);
  }

  /* RED control: reintroducing the stale token must be caught in either consumer. */
  for (const [file, extract] of CONSUMERS) {
    const stale = read(file).match(extract)[0]
      .replace(/P02_GENERATION_STATE\.RECORDED/g, "'present'");
    const staleLiterals = [...stale.matchAll(/state\s*[!=]==\s*'([a-z-]+)'/g)].map((hit) => hit[1]);
    check(staleLiterals.some((token) => !vocabulary.has(token)),
      `GEN RED control: reintroducing state === 'present' into ${file} is detected`);
  }
}

await scenarioGenerationStateConsumerVocabulary();

console.log(JSON.stringify({
  verdict, assertions, failures,
  record: {
    key: P02_WRITER_GENERATION.KEY,
    desktop: 'kv_store (migration v1)', chrome: 'chrome.storage.local',
    migrationsAdded: 0, chromeDatabaseVersionBumped: false
  },
  interpretation: {
    'absent-observed': 'p01 - existing behavior, bit-identical',
    p01: 'permitted',
    p02: 'every P01 mutation path refuses',
    malformed: 'fail closed',
    unobserved: 'fail closed - an unreadable store is NOT an empty store'
  },
  seamClassesGated: 8,
  nativeP01WriteCommandsGated: [
    'h2o_item11_prepare_delivery', 'h2o_item11_prepare_local_delivery',
    'h2o_sync_object_publish_transport'
  ],
  packedOutputs: packedFindings,
  standdownScope: P02_STANDDOWN_SCOPE.STATEMENT,
  standdownObligation: P02_STANDDOWN_SCOPE.OBLIGATION,
  ownershipRulings: P01_OWNERSHIP_RULINGS.map((r) => `${r.symbol}: ${r.classification}`),
  genericSharedTransportRuling: 'GENERIC_SHARED_TRANSPORT - P01 GATE AT FEATURE ENTRY POINT',
  generationPersistenceOwners: 1,
  generatedStanddownChecked,
  ceremonyExecutedAgainstDisposableState: true,
  ceremonyExecutedAgainstRealState: false, rollbackExecuted: false,
  realProfileTouched: false, realRepositoryTouched: false, processesLaunched: 0
}, null, 2));
process.exit(failures.length === 0 ? 0 : 1);
