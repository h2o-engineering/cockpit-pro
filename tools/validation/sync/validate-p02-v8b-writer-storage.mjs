/*
 * P02 V8-B — scoped local-folder storage substrate.
 *
 * Disposable only: every repository below is a throwaway directory under the
 * system temp dir. Canonical app-data and the live P02 repository are never
 * opened, and no Desktop process is started.
 *
 * What this proves, and what it does not:
 *  - the REAL generic Z4 writer transport completes its ordered publication
 *    phases through the REAL Desktop adapter, producing a real J.1 inventory;
 *  - the adapter emits exactly the four native command names with exactly the
 *    argument keys the Rust commands declare (parsed from the Rust source);
 *  - the native semantics themselves are proven by the Rust unit tests in
 *    p02_writer_storage.rs, which run against the same disposable shapes.
 * The Node backend below is a deliberate test double standing in for the native
 * side so Z4 can be exercised without a Tauri process; the end-to-end packaged
 * wire is V8-C's proof, not this one.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createLocalWriterTransportPrimitives,
  deriveRevisionPath,
  deriveWriterPaths
} from '../../../packages/browser-adapters/chrome/sync-writer-transport-v2.mjs';
import {
  P02_SYNC_CONTRACT_V2,
  writerKeyHex
} from '../../../packages/browser-adapters/chrome/sync-contract-v2.mjs';
import { produceRevisionV2, rootParent }
  from '../../../packages/browser-adapters/chrome/sync-revision-production-v2.mjs';
import {
  P02_DESKTOP_WRITER_STORAGE,
  createDesktopLocalWriterStorage,
  decodeStorageBytes,
  encodeStorageBytes
} from '../../../src-surfaces-base/studio/sync/sync-writer-storage-desktop-v2.tauri.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../..');
const RUST_REL = 'apps/studio/desktop/src-tauri/src/p02_writer_storage.rs';
const ADAPTER_REL = 'src-surfaces-base/studio/sync/sync-writer-storage-desktop-v2.tauri.mjs';
const { SCHEMA } = P02_SYNC_CONTRACT_V2;
const WRITER = 'studio-desktop:tauri-desktop:sqlite:v8b-fixture-peer';
/* V8-C3a: mutating storage now requires a governed capability. */
const CAPABILITY = 'a'.repeat(64);
const HEX64 = /^[0-9a-f]{64}$/;
const CONTROL = /[\x00-\x1f\x7f]/;

let assertions = 0;
const failures = [];
const check = (condition, label) => {
  assertions += 1;
  if (condition !== true) failures.push(label);
};
async function rejects(run, label) {
  assertions += 1;
  try { await run(); failures.push(`${label} (no rejection)`); } catch (_) { /* expected */ }
}

const disposableRoots = [];
function makeRepository(label) {
  const container = fs.mkdtempSync(path.join(
    fs.realpathSync(process.env.TMPDIR || '/tmp'), `p02-v8b-${label}-`));
  const root = path.join(container, 'h2o-object-sync');
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(container, 'h2o-local-publication.v1.json'), 'p01-parent');
  fs.writeFileSync(path.join(root, 'library.info.json'), JSON.stringify({
    /* Full ceremony shape, as the V7 activation writer produces it: seven
     * top-level keys with the receipt embedded. A four-key stub cannot
     * exercise a gate regression that only trips on real documents. */
    schema: 'h2o.studio.syncLibraryInfo.p02.v1',
    formatVersion: 2, minimumCompatibleProtocolVersion: 2, layoutEpoch: 1,
    activatedAt: '2026-08-25T20:02:31.477Z',
    activatedByWriterSyncPeerId: 'studio-desktop:tauri-desktop:sqlite:test-peer',
    legacyBaselineReceipt: {
      schema: 'h2o.studio.syncLegacyBaseline.p02.v1',
      capturedAt: '2026-08-25T20:02:31.477Z',
      artifacts: []
    }
  }));
  disposableRoots.push(container);
  return { container, root };
}

/* Same whitelist the native parser enforces, applied to the same shapes. */
function parseStoragePath(relative) {
  if (typeof relative !== 'string' || !relative || relative.length > 512 ||
      relative.startsWith('/') || relative.includes('\\') || relative.includes(':') ||
      relative.includes('//') || CONTROL.test(relative)) return null;
  const parts = relative.split('/');
  if (parts.some((p) => !p || p === '.' || p === '..' || p.trim() !== p)) return null;
  const doc = (leaf) => {
    const marker = leaf.indexOf('.json.pending-');
    if (marker >= 0) {
      const base = leaf.slice(0, marker);
      const identity = leaf.slice(marker + '.json.pending-'.length);
      return HEX64.test(base) && HEX64.test(identity) ? { temporary: true } : null;
    }
    if (!leaf.endsWith('.json')) return null;
    return HEX64.test(leaf.slice(0, -5)) ? { temporary: false } : null;
  };
  if (parts.length === 4 && parts[0] === 'objects' && parts[2] === 'revisions' && HEX64.test(parts[1])) {
    const parsed = doc(parts[3]); return parsed && { kind: 'revision', ...parsed, parts };
  }
  if (parts.length === 4 && parts[0] === 'writers' && parts[2] === 'heads' && HEX64.test(parts[1])) {
    const parsed = doc(parts[3]); return parsed && { kind: 'heads', ...parsed, parts };
  }
  if (parts.length === 3 && parts[0] === 'writers' && HEX64.test(parts[1])) {
    if (parts[2] === 'state.json') return { kind: 'state', temporary: false, parts };
    const marker = parts[2].indexOf('.pending-');
    if (marker > 0 && parts[2].slice(0, marker) === 'state.json' &&
        HEX64.test(parts[2].slice(marker + '.pending-'.length))) {
      return { kind: 'state', temporary: true, parts };
    }
  }
  return null;
}

const calls = [];
function nativeDouble(root, faults = {}) {
  const resolve = (parsed) => path.join(root, ...parsed.parts);
  const { COMMAND } = P02_DESKTOP_WRITER_STORAGE;
  return async function invoke(command, args) {
    calls.push({ command, args: Object.keys(args).sort() });
    if (command === COMMAND.READ || command === COMMAND.READ_TEMPORARY) {
      const parsed = parseStoragePath(args.relativePath);
      if (!parsed) throw new Error('p02-v8b-storage-path-rejected');
      if (command === COMMAND.READ_TEMPORARY && !parsed.temporary) {
        throw new Error('p02-v8b-storage-path-rejected');
      }
      const target = resolve(parsed);
      let stat = null;
      try { stat = fs.lstatSync(target); } catch (_) { /* absent */ }
      if (stat === null) {
        return { schema: P02_DESKTOP_WRITER_STORAGE.SCHEMA, present: false, base64: null, byteLength: 0 };
      }
      if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('p02-v8b-storage-path-rejected');
      const bytes = new Uint8Array(fs.readFileSync(target));
      return {
        schema: P02_DESKTOP_WRITER_STORAGE.SCHEMA, present: true,
        base64: encodeStorageBytes(bytes), byteLength: bytes.length
      };
    }
    if (command === COMMAND.WRITE_TEMPORARY) {
      const parsed = parseStoragePath(args.relativePath);
      if (!parsed || !parsed.temporary) throw new Error('p02-v8b-storage-path-rejected');
      if (faults.failWriteTemporary) throw new Error('p02-v8b-storage-write-failed');
      const target = resolve(parsed);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const bytes = decodeStorageBytes(args.base64);
      try { fs.writeFileSync(target, Buffer.from(bytes), { flag: 'wx' }); }
      catch (_) { throw new Error('p02-v8b-storage-temporary-exists'); }
      if (faults.failAfterWriteTemporary) throw new Error('p02-v8b-injected-crash-after-temp');
      return bytes.length;
    }
    if (command === COMMAND.PROMOTE_TEMPORARY) {
      const pending = parseStoragePath(args.pendingPath);
      const finalParsed = parseStoragePath(args.finalPath);
      if (!pending || !finalParsed || !pending.temporary || finalParsed.temporary ||
          pending.kind !== finalParsed.kind) throw new Error('p02-v8b-storage-path-rejected');
      if (args.replaceExisting && finalParsed.kind !== 'state') {
        throw new Error('p02-v8b-storage-path-rejected');
      }
      if (faults.failPromote) throw new Error('p02-v8b-storage-promote-failed');
      const from = resolve(pending);
      const to = resolve(finalParsed);
      if (args.replaceExisting) { fs.renameSync(from, to); return null; }
      try { fs.linkSync(from, to); } catch (_) { throw new Error('p02-v8b-storage-target-exists'); }
      fs.unlinkSync(from);
      return null;
    }
    throw new Error(`unexpected-command:${command}`);
  };
}

const inventoryOf = (root) => {
  const found = [];
  (function walk(dir, prefix) {
    for (const entry of fs.readdirSync(dir).sort()) {
      const full = path.join(dir, entry);
      const rel = prefix ? `${prefix}/${entry}` : entry;
      if (fs.statSync(full).isDirectory()) walk(full, rel); else found.push(rel);
    }
  })(root, '');
  return found.sort();
};

async function genericRevision(objectId, text) {
  return produceRevisionV2({
    objectDomain: 'studio.generic.v8b.v1', objectId, revisionId: `${objectId}-r1`,
    writerSyncPeerId: WRITER, payload: { note: text }, parent: rootParent()
  });
}
const headFor = (produced) => ({
  schema: SCHEMA.HEAD,
  objectDomain: produced.objectDomain, objectId: produced.objectId, objectKey: produced.objectKey,
  revisionId: produced.revisionId, revisionBlobSha256: produced.revisionBlobSha256,
  payloadSha256: produced.payloadSha256,
  previousRevisionId: null, previousRevisionBlobSha256: null,
  writerSyncPeerId: WRITER, sourceUpdatedAtIso: '2026-08-25T00:00:00.000Z'
});
/* Z4's revision input is exactly V8-A's output: identity plus canonical bytes
 * plus the blob address. No envelope field is restated here. */
const revisionInputOf = (produced) => ({
  objectDomain: produced.objectDomain,
  objectId: produced.objectId,
  objectKey: produced.objectKey,
  revisionBlobSha256: produced.revisionBlobSha256,
  bytes: produced.canonicalBytes
});

/* ---------- 1. adapter satisfies the Z4 injected-storage contract ---------- */
const fx = makeRepository('z4');
const storage = createDesktopLocalWriterStorage({ capability: CAPABILITY, invoke: nativeDouble(fx.root) });
for (const method of ['read', 'writeTemporary', 'readTemporary', 'promoteTemporary']) {
  check(typeof storage[method] === 'function', `1 adapter exposes ${method}`);
}
const transport = createLocalWriterTransportPrimitives({ storage, ownedWriterSyncPeerId: WRITER });
check(typeof transport.publishBatch === 'function', '1 real Z4 transport accepted the adapter');

/* ---------- 2. real Z4 publication through the substrate ---------- */
const produced = await genericRevision('v8b-object-one', 'first');
const batch = await transport.publishBatch({
  revisions: [revisionInputOf(produced)], heads: [headFor(produced)]
});
check(batch.ok === true && batch.verdict === 'committed', '2 Z4 publishBatch committed');
check(JSON.stringify(batch.phases) === JSON.stringify([
  'writer-ownership-validated', 'immutable-revisions-verified', 'immutable-ancestry-verified',
  'complete-heads-snapshot-built', 'immutable-heads-snapshot-verified',
  'writer-state-pointer-verified', 'transport-batch-committed'
]), `2 exact frozen phase order (${batch.phases.join(' -> ')})`);

const writerKey = await writerKeyHex(WRITER);
const expectedRevision = deriveRevisionPath(produced.objectKey, produced.revisionBlobSha256);
const writerPaths = deriveWriterPaths(writerKey, batch.headsSnapshotSha256);
const inventory = inventoryOf(fx.root);
check(JSON.stringify(inventory) === JSON.stringify([
  'library.info.json', expectedRevision, writerPaths.snapshot, writerPaths.state
].sort()), `2 disposable inventory is exactly what Z4 requested (${inventory.join(', ')})`);
check(fs.readFileSync(path.join(fx.root, 'library.info.json'), 'utf8').includes('layoutEpoch'),
  '2 V7 authority preserved untouched');
check(fs.readFileSync(path.join(fx.container, 'h2o-local-publication.v1.json'), 'utf8') === 'p01-parent',
  '2 parent P01 compatibility artifact untouched');
check(!inventory.some((entry) => entry.includes('.pending-')), '2 no temporary residue remains');
check(Buffer.compare(
  fs.readFileSync(path.join(fx.root, expectedRevision)),
  Buffer.from(produced.canonicalBytes)) === 0,
'2 stored revision bytes are byte-identical to V8-A output');

/* ---------- 3. idempotent republication ---------- */
const again = await transport.publishBatch({
  revisions: [revisionInputOf(produced)], heads: [headFor(produced)]
});
check(again.verdict === 'committed' && again.headsSnapshotSha256 === batch.headsSnapshotSha256,
  '3 identical republication is idempotent');
check(JSON.stringify(inventoryOf(fx.root)) === JSON.stringify(inventory),
  '3 inventory unchanged on replay');

/* ---------- 4. adapter <-> native command/argument agreement ---------- */
const rustSource = fs.readFileSync(path.join(repo, RUST_REL), 'utf8');
const declared = {};
for (const match of rustSource.matchAll(/pub fn (h2o_p02_storage_[a-z_]+)\(([\s\S]*?)\)\s*->/g)) {
  /* digits matter: the `base64` parameter is invisible to a [a-z_] class. */
  declared[match[1]] = [...match[2].matchAll(/^\s*([a-z0-9_]+):/gm)]
    .map((p) => p[1]).filter((name) => name !== 'app')
    .map((name) => name.replace(/_([a-z])/g, (_, c) => c.toUpperCase())).sort();
}
check(Object.keys(declared).length === 4, '4 four native storage commands declared');
const emitted = new Map();
for (const call of calls) if (!emitted.has(call.command)) emitted.set(call.command, call.args);
for (const [command, args] of emitted) {
  check(Array.isArray(declared[command]), `4 adapter command ${command} exists natively`);
  check(JSON.stringify(args) === JSON.stringify(declared[command] || []),
    `4 ${command} argument keys match natively (${args.join(',')} vs ${(declared[command] || []).join(',')})`);
}
check(emitted.size === 4, `4 all four commands exercised by a real publication (${emitted.size})`);

/* ---------- 5. crash ordering at storage boundaries ---------- */
const crashFx = makeRepository('crash');
const crashProduced = await genericRevision('v8b-crash-object', 'crash');
const crashTransport = (faults) => createLocalWriterTransportPrimitives({
  storage: createDesktopLocalWriterStorage({ capability: CAPABILITY, invoke: nativeDouble(crashFx.root, faults) }),
  ownedWriterSyncPeerId: WRITER
});
const crashBatch = (faults) => crashTransport(faults).publishBatch({
  revisions: [revisionInputOf(crashProduced)], heads: [headFor(crashProduced)]
});
await rejects(() => crashBatch({ failWriteTemporary: true }), '5A failure before temp write aborts');
check(!fs.existsSync(path.join(crashFx.root, 'objects')), '5A no state after pre-write failure');
await rejects(() => crashBatch({ failAfterWriteTemporary: true }), '5B crash after temp write aborts');
const finalRevisionPath = path.join(crashFx.root,
  deriveRevisionPath(crashProduced.objectKey, crashProduced.revisionBlobSha256));
check(!fs.existsSync(finalRevisionPath), '5B no final document after crash-after-temp');
check(!fs.existsSync(path.join(crashFx.root, deriveWriterPaths(writerKey).state)),
  '5B no writer pointer exists after an incomplete revision');
await rejects(() => crashBatch({ failPromote: true }), '5C promotion failure aborts');
check(!fs.existsSync(path.join(crashFx.root, deriveWriterPaths(writerKey).state)),
  '5C pointer never references missing immutable dependencies');
check(fs.existsSync(path.join(crashFx.root, 'objects')), '5 retained temporary evidence is preserved');

/* ---------- 6. confinement vectors ---------- */
const guardStorage = createDesktopLocalWriterStorage({ capability: CAPABILITY, invoke: nativeDouble(fx.root) });
for (const attempt of [
  'library.info.json', '../h2o-local-publication.v1.json', '/etc/passwd',
  '../../etc/passwd', 'objects/../writers/x/state.json',
  `objects/${'a'.repeat(64)}/revisions/../../../library.info.json`,
  `objects\\${'a'.repeat(64)}\\revisions\\${'b'.repeat(64)}.json`,
  `objects/${'a'.repeat(64)}/revisions/${'b'.repeat(64)}.txt`,
  `writers/${'a'.repeat(64)}/other.json`, ''
]) {
  await rejects(() => guardStorage.read(attempt), `6 confinement rejects ${JSON.stringify(attempt)}`);
}
check(fs.readFileSync(path.join(fx.root, 'library.info.json'), 'utf8').includes('layoutEpoch'),
  '6 V7 authority still intact after every attempt');

/* ---------- 7. architecture ---------- */
const adapterCode = fs.readFileSync(path.join(repo, ADAPTER_REL), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
for (const leak of ['chat', 'snapshotId', 'sqlite', 'DatabaseSync', 'webdav', 'scheduler',
  'classif', 'ceremony', 'publishBatch', 'objectKey', 'writerKey', 'sha256']) {
  check(!adapterCode.toLowerCase().includes(leak.toLowerCase()), `7 adapter free of "${leak}"`);
}
const rustNoTests = rustSource.replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '').split('#[cfg(test)]')[0];
for (const leak of ['chat', 'snapshot_id', 'objectDomain', 'webdav', 'reqwest', 'scheduler']) {
  check(!rustNoTests.toLowerCase().includes(leak.toLowerCase()), `7 native substrate free of "${leak}"`);
}
check(/resolve_target_core/.test(rustNoTests), '7 repository authority is resolver-derived');
check(!rustNoTests.includes('repository_root: String'), '7 no caller-supplied repository root');

for (const container of disposableRoots) fs.rmSync(container, { recursive: true, force: true });

const verdict = failures.length === 0 ? 'P02_V8B_WRITER_STORAGE_PASS' : 'P02_V8B_WRITER_STORAGE_FAIL';
console.log(JSON.stringify({
  verdict, assertions, failures,
  nativeSubstrate: RUST_REL, desktopAdapter: ADAPTER_REL,
  z4PhaseOrder: batch.phases, disposableInventory: inventory,
  canonicalAppDataTouched: false, canonicalRepositoryTouched: false,
  processesLaunched: 0, webDavContacted: false
}, null, 2));
process.exit(failures.length === 0 ? 0 : 1);
