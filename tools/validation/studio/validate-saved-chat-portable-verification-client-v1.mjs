#!/usr/bin/env node
/* M10 P3.6a — the thin trusted portable verification client.
 *
 * The property under test is that this module carries bytes and decides
 * nothing. Every check here exists to stop it growing a second opinion: no
 * hashing, no manifest reading, no legacy fallback, and a result contract that
 * fails closed rather than being read optimistically. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MODULE_REL = 'src-surfaces-base/studio/ingestion/saved-chat-portable-package-verification.tauri.js';
const STUDIO_HTML = 'src-surfaces-base/studio/studio.html';
const PACK_STUDIO = 'tools/product/studio/pack-studio.mjs';
const NATIVE_REL = 'apps/studio/desktop/src-tauri/src/saved_chat_portable_verify.rs';
const LIB_REL = 'apps/studio/desktop/src-tauri/src/lib.rs';
const readRepo = (rel) => fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
const codeOnly = (text) => text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');

const PASS = [];
const FAIL = [];
async function check(label, fn) {
  try { await fn(); PASS.push(label); console.log(`  ✓ ${label}`); }
  catch (e) { FAIL.push(label); console.log(`  ✗ ${label}`); console.log(`      ${e && e.message}`); }
}

const OK_RESULT = {
  schema: 'h2o.savedChatPortablePackageVerification',
  schemaVersion: 1,
  verified: true,
  packageDirName: 'chat_a.h2ochat',
  chatId: 'chat_a',
  snapshotId: 'snap_a',
  contentHash: 'a'.repeat(64),
  constructionFamily: 'v3',
  nameClassification: 'legacy',
  assetShas: [],
  logicalSnapshotByteLength: 12,
};

/* Loads the REAL module against a scripted invoke, recording every call so the
   session protocol itself can be asserted. */
function load(script) {
  const calls = [];
  const invoke = async (command, arg, meta) => {
    calls.push({ command, arg, meta });
    const reply = script[command];
    if (typeof reply === 'function') return reply(arg, meta, calls);
    if (reply === undefined) throw new Error(`unscripted command: ${command}`);
    return reply;
  };
  const context = {
    console, TextEncoder, TextDecoder, Uint8Array, ArrayBuffer,
    __TAURI_INTERNALS__: { invoke },
    H2O: { Studio: { ingestion: {} } },
  };
  context.globalThis = context; context.window = context;
  const sandbox = vm.createContext(context);
  vm.runInContext(readRepo(MODULE_REL), sandbox, { filename: MODULE_REL });
  return { api: sandbox.H2O.Studio.ingestion, calls };
}

const happyScript = (over = {}) => ({
  h2o_saved_chat_portable_verify_begin: { schema: OK_RESULT.schema, schemaVersion: 1, ok: true, token: 7 },
  h2o_saved_chat_portable_verify_declare: { ok: true },
  h2o_saved_chat_portable_verify_write: { ok: true },
  h2o_saved_chat_portable_verify_finish: OK_RESULT,
  h2o_saved_chat_portable_verify_abort: { ok: true },
  ...over,
});

const bytes = (text) => new TextEncoder().encode(text);

console.log('= saved-chat trusted portable verification client (M10 P3.6a) =');

await check('the module installs and exposes only the verification entry point', () => {
  const { api } = load(happyScript());
  assert.equal(typeof api.verifySavedChatPortablePackageV1, 'function');
  const contract = api.SAVED_CHAT_PORTABLE_VERIFICATION_CONTRACT;
  assert.equal(contract.schema, 'h2o.savedChatPortablePackageVerification');
  assert.equal(contract.schemaVersion, 1);
  assert.equal(contract.ownsVerification, false);
  assert.equal(contract.ownsContentHash, false);
  assert.equal(contract.hasLegacyFallback, false);
});

await check('it drives begin -> declare -> write -> finish, and declares before writing', async () => {
  const { api, calls } = load(happyScript());
  const out = await api.verifySavedChatPortablePackageV1({
    packageDirName: 'chat_a.h2ochat',
    members: { manifest: bytes('{}'), snapshot: bytes('{"a":1}') },
  });
  assert.equal(out.verified, true);
  const order = calls.map((c) => c.command.replace('h2o_saved_chat_portable_verify_', ''));
  assert.deepEqual(order, ['begin', 'declare', 'write', 'declare', 'write', 'finish']);
  /* Each member is declared with its exact length before any byte is sent. */
  const declares = calls.filter((c) => c.command.endsWith('_declare')).map((c) => c.arg.options);
  assert.deepEqual(declares.map((d) => d.member), ['manifest', 'snapshot']);
  assert.deepEqual(declares.map((d) => d.expectedLength), [2, 7]);
});

await check('member bytes travel as a RAW body, never JSON-serialized', async () => {
  const { api, calls } = load(happyScript());
  await api.verifySavedChatPortablePackageV1({
    packageDirName: 'chat_a.h2ochat',
    members: { manifest: bytes('{}') },
  });
  const write = calls.find((c) => c.command.endsWith('_write'));
  assert.ok(write.arg instanceof Uint8Array, 'the chunk is the raw request body');
  /* The token/member ride in the options header, exactly like the archive
     generation writer — the bytes are never wrapped in an object. */
  const options = JSON.parse(write.meta.headers.options);
  assert.equal(options.token, 7);
  assert.equal(options.member, 'manifest');
});

await check('assets are sent under the native asset member key', async () => {
  const { api, calls } = load(happyScript());
  const key = `asset:sha256-${'b'.repeat(64)}.png`;
  await api.verifySavedChatPortablePackageV1({
    packageDirName: 'chat_a.h2ochat',
    members: { manifest: bytes('{}'), assets: [{ key, bytes: bytes('PNG') }] },
  });
  const declared = calls.filter((c) => c.command.endsWith('_declare')).map((c) => c.arg.options.member);
  assert.ok(declared.includes(key), 'the asset key is passed through verbatim');
});

await check('an empty member is still written once, so it completes rather than underruns', async () => {
  const { api, calls } = load(happyScript());
  await api.verifySavedChatPortablePackageV1({
    packageDirName: 'chat_a.h2ochat',
    members: { manifest: bytes('') },
  });
  const writes = calls.filter((c) => c.command.endsWith('_write'));
  assert.equal(writes.length, 1);
  assert.equal(writes[0].arg.length, 0);
});

await check('a large member is chunked, and chunks are sequential with no offset', async () => {
  const { api, calls } = load(happyScript());
  const big = new Uint8Array(4 * 1024 * 1024 + 10);
  await api.verifySavedChatPortablePackageV1({
    packageDirName: 'chat_a.h2ochat',
    members: { manifest: big },
  });
  const writes = calls.filter((c) => c.command.endsWith('_write'));
  assert.equal(writes.length, 2, 'split at the transport chunk size');
  assert.equal(writes[0].arg.length + writes[1].arg.length, big.length);
  for (const write of writes) {
    const options = JSON.parse(write.meta.headers.options);
    assert.equal(options.offset, undefined, 'there is no caller-controlled offset');
  }
});

await check('a native semantic refusal is returned, not thrown', async () => {
  const refusal = {
    schema: OK_RESULT.schema, schemaVersion: 1, verified: false,
    refusal: { stage: 'verifier', code: 'generation-v3-gzip-decoded-sha-mismatch' },
  };
  const { api } = load(happyScript({ h2o_saved_chat_portable_verify_finish: refusal }));
  const out = await api.verifySavedChatPortablePackageV1({
    packageDirName: 'chat_a.h2ochat', members: { manifest: bytes('{}') },
  });
  assert.equal(out.verified, false);
  assert.equal(out.refusal.stage, 'verifier');
  assert.equal(out.refusal.code, 'generation-v3-gzip-decoded-sha-mismatch');
  /* The client does not translate, soften or re-label the native code. */
});

await check('the result contract fails closed on schema, version and shape', async () => {
  const cases = [
    [{ ...OK_RESULT, schema: 'h2o.somethingElse' }, 'portable-verify-schema-mismatch'],
    [{ ...OK_RESULT, schemaVersion: 2 }, 'portable-verify-schema-version-unsupported'],
    [{ ...OK_RESULT, verified: 'yes' }, 'portable-verify-envelope-malformed'],
    [{ ...OK_RESULT, verified: false, refusal: undefined }, 'portable-verify-envelope-malformed'],
    [{ ...OK_RESULT, contentHash: '' }, 'portable-verify-envelope-malformed'],
    ['not-an-object', 'portable-verify-envelope-malformed'],
  ];
  for (const [payload, code] of cases) {
    const { api } = load(happyScript({ h2o_saved_chat_portable_verify_finish: payload }));
    await assert.rejects(
      () => api.verifySavedChatPortablePackageV1({
        packageDirName: 'chat_a.h2ochat', members: { manifest: bytes('{}') },
      }),
      (e) => e.code === code,
      `expected ${code} for ${JSON.stringify(payload).slice(0, 60)}`,
    );
  }
});

await check('a refused session and a refused member fail closed with distinct codes', async () => {
  const busy = load(happyScript({
    h2o_saved_chat_portable_verify_begin: { ok: false, code: 'portable-session-busy' },
  }));
  await assert.rejects(
    () => busy.api.verifySavedChatPortablePackageV1({
      packageDirName: 'chat_a.h2ochat', members: { manifest: bytes('{}') },
    }),
    (e) => e.code === 'portable-verify-session-refused',
  );
  const refused = load(happyScript({
    h2o_saved_chat_portable_verify_declare: { ok: false, code: 'portable-member-duplicate' },
  }));
  await assert.rejects(
    () => refused.api.verifySavedChatPortablePackageV1({
      packageDirName: 'chat_a.h2ochat', members: { manifest: bytes('{}') },
    }),
    (e) => e.code === 'portable-verify-member-refused',
  );
});

await check('an abnormal exit aborts the session; a finished one is not re-aborted', async () => {
  /* The single session slot must never be held by an abandoned upload. */
  const failing = load(happyScript({
    h2o_saved_chat_portable_verify_write: () => { throw new Error('transport died'); },
  }));
  await assert.rejects(() => failing.api.verifySavedChatPortablePackageV1({
    packageDirName: 'chat_a.h2ochat', members: { manifest: bytes('{}') },
  }));
  const aborted = failing.calls.filter((c) => c.command.endsWith('_abort'));
  assert.equal(aborted.length, 1, 'the failed upload aborts exactly once');
  assert.equal(aborted[0].arg.options.token, 7);

  const happy = load(happyScript());
  await happy.api.verifySavedChatPortablePackageV1({
    packageDirName: 'chat_a.h2ochat', members: { manifest: bytes('{}') },
  });
  assert.equal(happy.calls.filter((c) => c.command.endsWith('_abort')).length, 0,
    'finish already destroyed the session');
});

await check('an unavailable transport fails closed with no legacy fallback', async () => {
  const context = { console, TextEncoder, Uint8Array, ArrayBuffer, __TAURI__: {}, H2O: { Studio: { ingestion: {} } } };
  context.globalThis = context; context.window = context;
  const sandbox = vm.createContext(context);
  vm.runInContext(readRepo(MODULE_REL), sandbox, { filename: MODULE_REL });
  const api = sandbox.H2O.Studio.ingestion;
  await assert.rejects(
    () => api.verifySavedChatPortablePackageV1({ packageDirName: 'c.h2ochat', members: {} }),
    (e) => e.code === 'portable-verify-transport-unavailable',
  );
});

await check('the client owns no verification, hashing or package semantics', () => {
  const code = codeOnly(readRepo(MODULE_REL));
  for (const banned of [
    'subtle', 'digest(', 'createHash', 'sha256(', 'canonicalJson',
    'validateSavedChatPackageBytesV1', 'validateSavedChatPackageV1',
    'DecompressionStream', 'CompressionStream',
    'contentHashOk', 'schemaVersion === 3', 'payloadVersion',
    'archiveInspector', 'diagnoseSavedChatArchiveV1', 'readSavedChatArchiveIntegrityV1',
  ]) {
    assert.ok(!code.includes(banned), `the thin client must not reference ${banned}`);
  }
  /* JSON.parse appears only for the options header it wrote itself — it must
     never parse a package member. */
  assert.ok(!/JSON\.parse\s*\(\s*(manifest|snapshot)/.test(code), 'no member parsing');
});

await check('the native wire is bare hex; the client never re-prefixes it', () => {
  const native = codeOnly(readRepo(NATIVE_REL));
  assert.ok(native.includes('fn bare_hex'), 'the native side strips the prefix');
  const client = codeOnly(readRepo(MODULE_REL));
  assert.ok(!client.includes("'sha256-'"), 'the client applies no prefix of its own');
});

await check('all five commands are registered in every invoke handler arm', () => {
  const lib = readRepo(LIB_REL);
  for (const command of [
    'h2o_saved_chat_portable_verify_begin',
    'h2o_saved_chat_portable_verify_declare',
    'h2o_saved_chat_portable_verify_write',
    'h2o_saved_chat_portable_verify_finish',
    'h2o_saved_chat_portable_verify_abort',
  ]) {
    const count = (lib.match(new RegExp(command, 'g')) || []).length;
    assert.equal(count, 2, `${command} must be registered in BOTH build arms`);
  }
  assert.ok(lib.includes('PortableVerifyState::default()'), 'session state is managed');
});

await check('the native adapter delegates semantics and writes nothing', () => {
  const native = codeOnly(readRepo(NATIVE_REL));
  assert.ok(native.includes('verify_package('), 'it calls the existing semantic verifier');
  assert.ok(native.includes('VerificationAdmission::AllSupported'), 'durable read gate');
  /* No second verifier, no filesystem, no persistence. */
  for (const banned of [
    'fn validate_manifest', 'fn derive_content_hash', 'DecompressionStream',
    'std::fs::', 'File::create', 'tempfile', 'archive_root', 'plugin:sql',
  ]) {
    assert.ok(!native.includes(banned), `the adapter must not contain ${banned}`);
  }
});

await check('the client is wired ahead of the importer and exporter', () => {
  const html = readRepo(STUDIO_HTML);
  const client = html.indexOf('saved-chat-portable-package-verification.tauri.js');
  assert.ok(client > 0, 'studio.html loads the client');
  assert.ok(client < html.indexOf('saved-chat-archive-exporter.studio.js'), 'before the exporter');
  const pack = readRepo(PACK_STUDIO);
  assert.equal(
    (pack.match(/ingestion\/saved-chat-portable-package-verification\.tauri\.js/g) || []).length, 2,
    'both pack-studio module lists carry the client',
  );
});

await check('the importer verifies BEFORE it decodes, and refuses without decoding', () => {
  /* The decode-order rule is the whole point of P3.6b: a package that trusted
     native code refused must never reach the snapshot decoder. */
  const importer = readRepo('src-surfaces-base/studio/ingestion/saved-chat-archive-importer.studio.js');
  const loader = importer.slice(
    importer.indexOf('async function loadPortableCandidate('),
    importer.indexOf('/* Shared non-mutating decision core.'),
  );
  assert.ok(loader.length > 0, 'the portable loader is present');
  const verifyAt = loader.indexOf('await verify(');
  const decodeAt = loader.indexOf('readPackageSnapshotJsonFromBytes');
  assert.ok(verifyAt > 0, 'the loader calls the trusted verifier');
  assert.ok(decodeAt > verifyAt, 'the snapshot decode happens only after verification');
  /* And it is reachable only from the verified branch. */
  const verifiedBranch = loader.slice(loader.indexOf("if (status === 'verified')"));
  assert.ok(verifiedBranch.includes('readPackageSnapshotJsonFromBytes'),
    'the decode lives inside the verified branch');
  assert.ok(!loader.slice(0, loader.indexOf("if (status === 'verified')"))
    .includes('readPackageSnapshotJsonFromBytes'), 'and nowhere before it');
});

await check('the importer keeps no legacy validity path and invents no hash specificity', () => {
  const code = codeOnly(readRepo('src-surfaces-base/studio/ingestion/saved-chat-archive-importer.studio.js'));
  assert.ok(code.includes('verifySavedChatPortablePackageV1'), 'it uses the trusted client');
  for (const banned of ['validateSavedChatPackageBytesV1', 'validateSavedChatPackageV1', 'mapInspectStatus']) {
    assert.ok(!code.includes(banned), `the importer must not reference ${banned}`);
  }
  /* `unsupported-version` is retired: the native verifier refuses an incoherent
     version triple as structural incoherence, which is a different claim. */
  assert.ok(!code.includes("'unsupported-version'"), 'unsupported-version is retired');
  /* Nor does the importer re-specialise a trusted refusal into hash granularity
     it does not own. */
  assert.ok(!/hash-mismatch/.test(code.slice(code.indexOf('function portableStatusFor'), code.indexOf('async function loadPortableCandidate'))),
    'portable status mapping invents no hash specificity');
});

await check('the exporter verifies ONCE, before the ZIP exists', () => {
  const exporter = readRepo('src-surfaces-base/studio/ingestion/saved-chat-archive-exporter.studio.js');
  const code = codeOnly(exporter);
  /* Exactly one semantic verification call: in assembly, on the members, before
     any container is built. Verifying again after the write would be ceremony —
     the read-back already proves the published bytes are those bytes. */
  assert.equal((code.match(/await verify\(/g) || []).length, 1,
    'exactly one trusted verification, performed once');
  const assemble = exporter.slice(
    exporter.indexOf('async function assemblePortablePackage('),
    exporter.indexOf('function bytesEqual('),
  );
  assert.ok(assemble.includes('await verify('), 'verification happens during assembly');
  assert.ok(!assemble.includes('buildPortableZip'), 'and before any ZIP is built');

  /* The read-back is transport identity only — it no longer re-runs semantics. */
  const readback = exporter.slice(
    exporter.indexOf('async function verifyPortableZipReadback('),
    exporter.indexOf('async function dryRunExportPackageZip('),
  );
  assert.ok(readback.includes('bytesEqual'), 'read-back proves byte equality');
  assert.ok(!readback.includes('getPortableVerifier'), 'and performs no second verification');
});

await check('the exporter owns no semantic hash authority, only transport hashing', () => {
  const code = codeOnly(readRepo('src-surfaces-base/studio/ingestion/saved-chat-archive-exporter.studio.js'));
  for (const retired of ['contentHashExpected', 'canonicalJson', 'validateSavedChatPackageBytesV1']) {
    assert.ok(!code.includes(retired), `retired: ${retired}`);
  }
  /* sha256Prefixed survives for TRANSPORT identity: copied-member equality and
     the published ZIP's own byte identity. */
  assert.ok(code.includes('sha256Prefixed'), 'transport hashing is retained');
  assert.ok(code.includes('prefixedHash'), 'the trusted hash is formatted, not recomputed');
});

console.log('');
if (FAIL.length) {
  console.log(`[saved-chat-portable-verification-client] ${FAIL.length} failed, ${PASS.length} passed`);
  process.exit(1);
}
console.log(`[saved-chat-portable-verification-client] all ${PASS.length} checks passed`);
