#!/usr/bin/env node
/* M10 P3.5.4 - Bounded NON-VERIFYING gzip decode export.
 *
 * The renderer-hygiene observer needs the snapshot's logical bytes WITHOUT
 * asserting package validity: hygiene is drift, never an integrity verdict.
 * The codec already owned a bounded, non-verifying decoder; P3.5.4 exposes
 * that single existing implementation rather than duplicating gzip anywhere.
 * These proofs pin the contract that makes the export safe. */
import assert from 'node:assert/strict';
import nodeCrypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../..');
const CODEC = 'src-surfaces-base/studio/ingestion/saved-chat-package-codec.tauri.js';
const readRepo = (rel) => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

function loadCodec(overrides) {
  const context = {
    console, setTimeout, clearTimeout, URL, TextEncoder, TextDecoder, Uint8Array, ArrayBuffer,
    crypto: globalThis.crypto || nodeCrypto.webcrypto,
    ReadableStream, CompressionStream, DecompressionStream,
    __TAURI_INTERNALS__: { invoke: async () => { throw new Error('no invoke in decode proofs'); } },
    H2O: { Studio: { ingestion: {} } },
    ...(overrides || {}),
  };
  context.globalThis = context; context.window = context;
  const sandbox = vm.createContext(context);
  vm.runInContext(readRepo(CODEC), sandbox, { filename: CODEC });
  return sandbox.H2O.Studio.ingestion.savedChatPackageCodec;
}

const utf8 = (s) => new TextEncoder().encode(s);
const text = (b) => new TextDecoder().decode(b);
async function gzipOf(codec, s) {
  return codec.gzipEncodeBytes(utf8(s), { physicalByteCap: codec.LOGICAL_SNAPSHOT_CAP_BYTES });
}

let failures = 0;
const checks = [];
const check = (name, fn) => checks.push({ name, fn });

/* 1 - the capability is reachable at all. */
check('P1 decodeGzipBounded is exposed on the public codec surface', async () => {
  const codec = loadCodec();
  assert.equal(typeof codec.decodeGzipBounded, 'function',
    'decodeGzipBounded must be callable by hygiene consumers');
});

/* 2 - it really decodes; hygiene must see the same logical text a reader sees. */
check('P2 round-trips gzip-encoded logical bytes', async () => {
  const codec = loadCodec();
  const stored = await gzipOf(codec, 'hygiene payload <img src="data:image/png;base64,AAAA">');
  const decoded = await codec.decodeGzipBounded(stored, 4096, codec.LOGICAL_SNAPSHOT_CAP_BYTES);
  assert.equal(text(decoded), 'hygiene payload <img src="data:image/png;base64,AAAA">');
});

/* 3 - NON-VERIFYING: the return value carries no validity signal that a
 * consumer could mistake for an integrity verdict. */
check('P3 returns raw bytes only - no verified/valid/hashOk/integrityStatus field', async () => {
  const codec = loadCodec();
  const stored = await gzipOf(codec, 'abc');
  const decoded = await codec.decodeGzipBounded(stored, 64, 64);
  assert.ok(decoded instanceof Uint8Array, 'decoder must return plain bytes');
  for (const banned of ['verified', 'valid', 'hashOk', 'integrityStatus', 'packageVerified', 'logicalSha256']) {
    assert.equal(decoded[banned], undefined, `decode result must not carry ${banned}`);
  }
});

/* 4 - NON-VERIFYING, behaviourally: content that would fail a SHA check still
 * decodes. This is what lets hygiene observe an indeterminate-free V3 package
 * without ever pronouncing on its validity. */
check('P4 performs no hash comparison - content with no expected digest decodes', async () => {
  const codec = loadCodec();
  const stored = await gzipOf(codec, 'tampered-but-well-formed');
  const decoded = await codec.decodeGzipBounded(stored, 4096, 4096);
  assert.equal(text(decoded), 'tampered-but-well-formed');
  assert.doesNotMatch(readRepo(CODEC).split('async function decodeGzipBounded')[1].split('\n  }\n')[0],
    /sha256|digest|expected/i, 'the decoder body must contain no digest logic');
});

/* 5 - the bound is real: a decompression bomb is refused, not buffered. */
check('P5 enforces the logical cap with saved-chat-member-decoded-output-exceeds-cap', async () => {
  const codec = loadCodec();
  const stored = await gzipOf(codec, 'x'.repeat(50000));
  await assert.rejects(
    () => codec.decodeGzipBounded(stored, 50000, 1024),
    (e) => e.code === 'saved-chat-member-decoded-output-exceeds-cap');
});

/* 6 - the effective bound is min(declared, governed): a generous governed cap
 * cannot widen a small declared length, and vice versa. */
check('P6 effective cap is min(contentByteLength, logicalByteCap)', async () => {
  const codec = loadCodec();
  const stored = await gzipOf(codec, 'y'.repeat(4000));
  await assert.rejects(
    () => codec.decodeGzipBounded(stored, 500, codec.LOGICAL_SNAPSHOT_CAP_BYTES),
    (e) => e.code === 'saved-chat-member-decoded-output-exceeds-cap',
    'a small declared content length must bind even under a large governed cap');
  const ok = await codec.decodeGzipBounded(stored, 4000, codec.LOGICAL_SNAPSHOT_CAP_BYTES);
  assert.equal(ok.byteLength, 4000);
});

/* 7 - malformed input fails closed with a decode code, never a silent empty
 * buffer that hygiene would read as "no residue". */
check('P7 malformed gzip rejects with saved-chat-member-decompression-failed', async () => {
  const codec = loadCodec();
  await assert.rejects(
    () => codec.decodeGzipBounded(new Uint8Array([1, 2, 3, 4, 5]), 64, 64),
    (e) => e.code === 'saved-chat-member-decompression-failed');
});

/* 8 - a host without gzip is unavailable, not clean. */
check('P8 missing DecompressionStream rejects with saved-chat-member-gzip-unavailable', async () => {
  const codec = loadCodec({ DecompressionStream: undefined });
  await assert.rejects(
    () => codec.decodeGzipBounded(new Uint8Array([31, 139]), 64, 64),
    (e) => e.code === 'saved-chat-member-gzip-unavailable');
});

/* Structural: P3.5.4 authorized an EXPORT, not a new decoder. */
check('P9 exactly one decoder implementation and one gzip construction site remain', async () => {
  const src = readRepo(CODEC);
  assert.equal((src.match(/async function decodeGzipBounded/g) || []).length, 1);
  assert.equal((src.match(/new global\.DecompressionStream/g) || []).length, 1);
});

for (const { name, fn } of checks) {
  try { await fn(); console.log(`PASS  ${name}`); }
  catch (error) { failures += 1; console.error(`FAIL  ${name}\n      ${error && error.message}`); }
}
if (failures > 0) {
  console.error(`\n${failures} bounded-decode validation check(s) failed.`);
  process.exit(1);
}
console.log(`\nAll ${checks.length} bounded-decode validation checks passed.`);
