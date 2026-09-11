#!/usr/bin/env node
/* M10 P3.5b - renderer hygiene as archive DRIFT.
 *
 * The property under test is not "does it find residue" but "can it ever be
 * mistaken for an integrity verdict". Hygiene reads a package a second time,
 * so every path here pins that it adds warnings and nothing else, skips what
 * trusted integrity refused, and reports unavailability rather than a clean
 * zero it never measured. */
import assert from 'node:assert/strict';
import nodeCrypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../..');
const HYGIENE = 'src-surfaces-base/studio/ingestion/saved-chat-archive-renderer-hygiene.js';
const CODEC = 'src-surfaces-base/studio/ingestion/saved-chat-package-codec.tauri.js';
const COMPOSITION = 'src-surfaces-base/studio/ingestion/saved-chat-archive-health-composition.js';
const MAPPING = 'src-surfaces-base/studio/ingestion/saved-chat-archive-health-mapping.js';
const DIAGNOSTICS = 'src-surfaces-base/studio/ingestion/saved-chat-archive-diagnostics.tauri.js';
const HEALTH_UI = 'src-surfaces-base/studio/ingestion/archive-health-ui.studio.js';
const STUDIO_HTML = 'src-surfaces-base/studio/studio.html';
const PACK_STUDIO = 'tools/product/studio/pack-studio.mjs';
const readRepo = (rel) => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

/* vm-realm arrays are not reference-equal to host arrays, so structural
 * assertions compare serialized values instead. */
const same = (actual, expected, message) =>
  assert.equal(JSON.stringify(actual), JSON.stringify(expected), message);

/* Comment-stripped view: these modules DISCLAIM the very tokens the structural
 * proofs search for, so prose would otherwise read as a violation. */
function codeOnly(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const utf8 = (s) => new TextEncoder().encode(s);

function loadSandbox(files, extra) {
  const context = {
    console, setTimeout, clearTimeout, URL, TextEncoder, TextDecoder, Uint8Array, ArrayBuffer,
    crypto: globalThis.crypto || nodeCrypto.webcrypto,
    ReadableStream, CompressionStream, DecompressionStream,
    __TAURI_INTERNALS__: { invoke: async () => { throw new Error('no invoke'); } },
    H2O: { Studio: { ingestion: {} } },
    ...(extra || {}),
  };
  context.globalThis = context; context.window = context;
  const sandbox = vm.createContext(context);
  for (const rel of files) vm.runInContext(readRepo(rel), sandbox, { filename: rel });
  return sandbox;
}

/* The REAL bounded decoder is used throughout; only the filesystem read is
 * substituted, so the gzip path under test is the shipped one. */
function hygieneWith(memberBytes, options) {
  const opts = options || {};
  const sandbox = loadSandbox([CODEC, HYGIENE]);
  const ingestion = sandbox.H2O.Studio.ingestion;
  const realCodec = ingestion.savedChatPackageCodec;
  const codec = opts.noCodec ? null : {
    LOGICAL_SNAPSHOT_CAP_BYTES: realCodec.LOGICAL_SNAPSHOT_CAP_BYTES,
    decodeGzipBounded: realCodec.decodeGzipBounded,
    readBoundedPackageMemberBytes: async () => {
      if (opts.readError) throw Object.assign(new Error('read'), { code: opts.readError });
      return { path: 'snapshot.json', storedBytes: memberBytes, byteLength: memberBytes.byteLength };
    },
  };
  ingestion.savedChatPackageCodec = codec;
  return { observe: ingestion.observeSavedChatRendererHygieneV1, codec: realCodec, sandbox };
}

async function gzipBytes(codec, text) {
  return codec.gzipEncodeBytes(utf8(text), { physicalByteCap: codec.LOGICAL_SNAPSHOT_CAP_BYTES });
}

const VALID = { class: 'verified-generation', packagePath: 'archive/packages/a.h2ochat' };
const RESIDUE_JSON = '{"messages":[{"contentHtml":"<img src=\\"data:image/png;base64,AAA\\">"}]}';
const CLEAN_JSON = '{"messages":[{"contentText":"hello"}]}';

let failures = 0;
const checks = [];
const check = (name, fn) => checks.push({ name, fn });

/* ---- API + family rule ---------------------------------------------- */

check('C01 module installs observeSavedChatRendererHygieneV1', async () => {
  const { observe } = hygieneWith(utf8(CLEAN_JSON));
  assert.equal(typeof observe, 'function');
});

check('C02 trusted indeterminate is SKIPPED, not observed', async () => {
  const { observe } = hygieneWith(utf8(RESIDUE_JSON));
  const out = await observe({ packagePath: 'p', class: 'indeterminate', snapshotEncoding: 'identity' });
  assert.equal(out.applicable, false);
  assert.equal(out.observed, false);
  assert.equal(out.reason, 'trusted-integrity-indeterminate');
  same(out.warnings, []);
});

check('C03 reserved-infrastructure occupants are skipped', async () => {
  const { observe } = hygieneWith(utf8(RESIDUE_JSON));
  const out = await observe({ packagePath: 'p', class: 'reserved-infrastructure' });
  assert.equal(out.applicable, false);
});

check('C04 legacy-package class IS observed', async () => {
  const { observe } = hygieneWith(utf8(CLEAN_JSON));
  const out = await observe({ packagePath: 'p', class: 'legacy-package', snapshotEncoding: 'identity' });
  assert.equal(out.observed, true);
});

check('C05 missing packagePath is skipped without a read', async () => {
  const { observe } = hygieneWith(utf8(RESIDUE_JSON));
  const out = await observe({ class: 'verified-generation' });
  assert.equal(out.applicable, false);
  assert.equal(out.reason, 'renderer-hygiene-no-package-path');
});

/* ---- V3 gzip is IN scope (the acceptance case) ----------------------- */

check('C06 V3 gzip snapshot with data:image is OBSERVED as drift', async () => {
  const probe = hygieneWith(utf8(''));
  const stored = await gzipBytes(probe.codec, RESIDUE_JSON);
  const { observe } = hygieneWith(stored);
  const out = await observe({
    ...VALID, constructionFamily: 'v3', snapshotEncoding: 'gzip',
    logicalSnapshotByteLength: utf8(RESIDUE_JSON).byteLength, assetShas: [],
  });
  assert.equal(out.observed, true);
  assert.equal(out.encoding, 'gzip');
  assert.equal(out.findings.dataImageResidue, true);
  assert.equal(out.warnings.length, 1);
  assert.equal(out.warnings[0].code, 'renderer-data-image-residue');
});

check('C07 V3 identity snapshot with data:image is observed', async () => {
  const { observe } = hygieneWith(utf8(RESIDUE_JSON));
  const out = await observe({ ...VALID, constructionFamily: 'v3', snapshotEncoding: 'identity', assetShas: [] });
  assert.equal(out.findings.dataImageResidue, true);
});

check('C08 a clean snapshot is observed with NO warnings', async () => {
  const { observe } = hygieneWith(utf8(CLEAN_JSON));
  const out = await observe({ ...VALID, snapshotEncoding: 'identity', assetShas: [] });
  assert.equal(out.observed, true);
  assert.equal(out.findings.dataImageResidue, false);
  same(out.warnings, []);
});

check('C09 encoding defaults to identity when the trusted fact is absent', async () => {
  const { observe } = hygieneWith(utf8(CLEAN_JSON));
  const out = await observe({ ...VALID });
  assert.equal(out.encoding, 'identity');
  assert.equal(out.observed, true);
});

/* ---- drift, never a verdict ----------------------------------------- */

check('C10 an observation never carries a blocker or status field', async () => {
  const { observe } = hygieneWith(utf8(RESIDUE_JSON));
  const out = await observe({ ...VALID, snapshotEncoding: 'identity', assetShas: [] });
  for (const banned of ['blockers', 'status', 'ok', 'valid', 'verified', 'severity', 'class']) {
    assert.equal(out[banned], undefined, `hygiene must not emit ${banned}`);
  }
});

check('C11 hygiene warnings are warnings - none is labelled a blocker', async () => {
  const { observe } = hygieneWith(utf8(RESIDUE_JSON));
  const out = await observe({ ...VALID, snapshotEncoding: 'identity', assetShas: [] });
  out.warnings.forEach((w) => {
    assert.equal(typeof w.code, 'string');
    assert.equal(w.blocker, undefined);
  });
});

/* ---- asset-ref drift against the TRUSTED manifest -------------------- */

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);

check('C12 a snapshot asset ref absent from the trusted set is drift', async () => {
  const { observe } = hygieneWith(utf8(`{"assetRef":"sha256-${SHA_B}"}`));
  const out = await observe({ ...VALID, snapshotEncoding: 'identity', assetShas: [SHA_A] });
  assert.equal(out.findings.assetRefDrift.length, 1);
  assert.equal(out.findings.assetRefDrift[0], SHA_B);
  assert.equal(out.warnings[0].code, 'renderer-asset-ref-not-in-trusted-manifest');
});

check('C13 a ref present in the trusted set is NOT drift', async () => {
  const { observe } = hygieneWith(utf8(`{"assetRef":"sha256-${SHA_A}"}`));
  const out = await observe({ ...VALID, snapshotEncoding: 'identity', assetShas: [SHA_A] });
  same(out.findings.assetRefDrift, []);
  same(out.warnings, []);
});

check('C14 trusted bare hex matches prefixed content refs (representation)', async () => {
  const { observe } = hygieneWith(utf8(`{"assetRef":"sha256-${SHA_A}"}`));
  const bare = await observe({ ...VALID, snapshotEncoding: 'identity', assetShas: [SHA_A] });
  const prefixed = await observe({ ...VALID, snapshotEncoding: 'identity', assetShas: [`sha256-${SHA_A}`] });
  same(bare.findings.assetRefDrift, []);
  same(prefixed.findings.assetRefDrift, [],
    'a prefixed trusted sha must not read as drift');
});

check('C15 duplicate refs are reported once', async () => {
  const { observe } = hygieneWith(utf8(`{"a":"sha256-${SHA_B}","b":"sha256-${SHA_B}"}`));
  const out = await observe({ ...VALID, snapshotEncoding: 'identity', assetShas: [] });
  assert.equal(out.findings.assetRefDrift.length, 1);
});

check('C16 absent trusted assetShas means NO comparison, not zero drift', async () => {
  const { observe } = hygieneWith(utf8(`{"assetRef":"sha256-${SHA_B}"}`));
  const out = await observe({ ...VALID, snapshotEncoding: 'identity' });
  assert.equal(out.findings.assetRefsComparable, false);
  same(out.findings.assetRefDrift, []);
  same(out.warnings, [], 'no comparison can produce no finding');
});

/* ---- unavailable is not clean ---------------------------------------- */

check('C17 gzip without a trusted logical length is UNAVAILABLE, never guessed', async () => {
  const probe = hygieneWith(utf8(''));
  const stored = await gzipBytes(probe.codec, RESIDUE_JSON);
  const { observe } = hygieneWith(stored);
  const out = await observe({ ...VALID, snapshotEncoding: 'gzip', assetShas: [] });
  assert.equal(out.observed, false);
  assert.equal(out.applicable, true);
  assert.equal(out.reason, 'renderer-hygiene-logical-length-unavailable');
  assert.equal(out.findings, undefined, 'an unavailable observation reports no findings');
});

check('C18 a vanished package is a race, not a finding', async () => {
  const { observe } = hygieneWith(utf8(''), { readError: 'saved-chat-member-read-failed' });
  const out = await observe({ ...VALID, snapshotEncoding: 'identity', assetShas: [] });
  assert.equal(out.observed, false);
  assert.equal(out.reason, 'renderer-hygiene-package-unreadable');
  same(out.warnings, []);
});

check('C19 transport loss is reported as transport-unavailable', async () => {
  const { observe } = hygieneWith(utf8(''), { readError: 'saved-chat-member-read-unavailable' });
  const out = await observe({ ...VALID, snapshotEncoding: 'identity' });
  assert.equal(out.reason, 'renderer-hygiene-transport-unavailable');
});

check('C20 a corrupt gzip member is unavailable, not clean', async () => {
  const { observe } = hygieneWith(new Uint8Array([1, 2, 3, 4]));
  const out = await observe({ ...VALID, snapshotEncoding: 'gzip', logicalSnapshotByteLength: 64, assetShas: [] });
  assert.equal(out.observed, false);
  assert.equal(out.reason, 'renderer-hygiene-decode-failed');
});

check('C21 an absent codec is unavailable, not clean', async () => {
  const { observe } = hygieneWith(utf8(RESIDUE_JSON), { noCodec: true });
  const out = await observe({ ...VALID, snapshotEncoding: 'identity' });
  assert.equal(out.observed, false);
  assert.equal(out.reason, 'renderer-hygiene-codec-unavailable');
});

check('C22 an unsupported encoding is unavailable, not clean', async () => {
  const { observe } = hygieneWith(utf8(RESIDUE_JSON));
  const out = await observe({ ...VALID, snapshotEncoding: 'brotli' });
  assert.equal(out.observed, false);
  assert.equal(out.reason, 'renderer-hygiene-encoding-unsupported');
});

/* ---- structural: no second verifier, no second gzip ------------------ */

check('C23 hygiene calls no verification API and owns no gzip', async () => {
  const code = codeOnly(readRepo(HYGIENE));
  for (const banned of ['verifyPackageMemberBytes', 'readVerifiedPackageMember',
    'DecompressionStream', 'CompressionStream', 'sha256Prefixed', 'digest', 'subtle']) {
    assert.doesNotMatch(code, new RegExp(banned), `hygiene must not reference ${banned}`);
  }
  assert.match(code, /decodeGzipBounded/, 'gzip must go through the shared bounded decoder');
});

check('C24 the retired legacy blocker code is not resurrected by hygiene', async () => {
  assert.doesNotMatch(codeOnly(readRepo(HYGIENE)), /data-image-residue-v2/);
  assert.match(readRepo(HYGIENE), /renderer-data-image-residue/);
});

/* ---- composition + downstream wiring --------------------------------- */

function composeSandbox() {
  const sandbox = loadSandbox([MAPPING, COMPOSITION]);
  return sandbox;
}

check('C25 composition observes V3 (hygiene rule differs from renderer DETAIL)', async () => {
  const sandbox = composeSandbox();
  const seen = [];
  const out = await sandbox.H2O.Studio.ingestion.composeSavedChatArchiveHealthV1({
    readIntegrity: async () => ({
      complete: true, blockers: [], occupants: [
        { path: 'p/v3.h2ochat', class: 'verified-generation', constructionFamily: 'v3' },
        { path: 'p/bad.h2ochat', class: 'indeterminate', reason: 'corrupt' },
      ],
    }),
    includeDbChecks: false, includeCasChecks: false,
    rendererHygiene: async (facts) => {
      seen.push(facts.packagePath);
      return { applicable: true, observed: true, findings: { dataImageResidue: true, assetRefDrift: [] },
        warnings: [{ code: 'renderer-data-image-residue', message: 'residue' }] };
    },
  });
  same(seen, ['p/v3.h2ochat'], 'V3 observed; indeterminate skipped');
  assert.equal(out.rendererHygiene.packagesObserved, 1);
  assert.equal(out.rendererHygiene.packagesSkipped, 1);
  assert.equal(out.rendererHygiene.dataImageResidue, 1);
});

check('C26 hygiene findings surface as package DRIFT, not as a blocker', async () => {
  const sandbox = composeSandbox();
  const out = await sandbox.H2O.Studio.ingestion.composeSavedChatArchiveHealthV1({
    readIntegrity: async () => ({
      complete: true, blockers: [],
      occupants: [{ path: 'p/v3.h2ochat', class: 'verified-generation', constructionFamily: 'v3' }],
    }),
    includeDbChecks: false, includeCasChecks: false,
    rendererHygiene: async () => ({ applicable: true, observed: true,
      findings: { dataImageResidue: true, assetRefDrift: [] },
      warnings: [{ code: 'renderer-data-image-residue', message: 'residue' }] }),
  });
  assert.equal(out.model.observed.packagesBlocked, 0, 'hygiene must never block');
  assert.equal(out.model.observed.packagesWarning, 1);
  assert.equal(out.model.aggregateState, 'healthy-with-drift');
});

check('C27 an unavailable hygiene read counts as unavailable, never as clean', async () => {
  const sandbox = composeSandbox();
  const out = await sandbox.H2O.Studio.ingestion.composeSavedChatArchiveHealthV1({
    readIntegrity: async () => ({
      complete: true, blockers: [],
      occupants: [{ path: 'p/v3.h2ochat', class: 'verified-generation', constructionFamily: 'v3' }],
    }),
    includeDbChecks: false, includeCasChecks: false,
    rendererHygiene: async () => ({ applicable: true, observed: false, reason: 'renderer-hygiene-decode-failed', warnings: [] }),
  });
  assert.equal(out.rendererHygiene.packagesUnavailable, 1);
  assert.equal(out.rendererHygiene.packagesObserved, 0);
  assert.equal(out.model.aggregateState, 'healthy', 'unavailability adds no severity');
});

check('C28 a throwing observer degrades to unavailable, not to a verdict', async () => {
  const sandbox = composeSandbox();
  const out = await sandbox.H2O.Studio.ingestion.composeSavedChatArchiveHealthV1({
    readIntegrity: async () => ({
      complete: true, blockers: [],
      occupants: [{ path: 'p/v3.h2ochat', class: 'verified-generation' }],
    }),
    includeDbChecks: false, includeCasChecks: false,
    rendererHygiene: async () => { throw new Error('boom'); },
  });
  assert.equal(out.rendererHygiene.packagesUnavailable, 1);
  assert.equal(out.model.aggregateState, 'healthy');
});

check('C29 Health UI renders hygiene n/a when nothing was observed', async () => {
  const sandbox = loadSandbox([HEALTH_UI]);
  const ui = sandbox.H2O.Studio.archiveHealthUi || sandbox.H2O.Studio.ingestion.archiveHealthUi;
  const sections = ui.formatArchiveHealthSections({ counts: {}, rendererHygiene: { observed: false } });
  const drift = sections.find((s) => s.key === 'drift');
  const item = drift.counts.find((c) => c.key === 'rendererHygiene');
  assert.ok(item, 'an unobserved hygiene metric must still be listed');
  assert.equal(item.available, false);
  assert.equal(item.value, null, 'never a numeric zero');
});

check('C30 Health UI renders measured hygiene counts once observed', async () => {
  const sandbox = loadSandbox([HEALTH_UI]);
  const ui = sandbox.H2O.Studio.archiveHealthUi || sandbox.H2O.Studio.ingestion.archiveHealthUi;
  const sections = ui.formatArchiveHealthSections({
    counts: {},
    rendererHygiene: { observed: true, dataImageResidue: 2, assetRefDrift: 1, packagesUnavailable: 3 },
  });
  const drift = sections.find((s) => s.key === 'drift');
  const byKey = Object.fromEntries(drift.counts.map((c) => [c.key, c.value]));
  assert.equal(byKey['rendererHygiene.dataImageResidue'], 2);
  assert.equal(byKey['rendererHygiene.assetRefDrift'], 1);
  assert.equal(byKey['rendererHygiene.packagesUnavailable'], 3,
    'partial coverage must be stated, not hidden');
});

check('C31 cause-aware drift copy, without a seventh operator state', async () => {
  const sandbox = loadSandbox([HEALTH_UI]);
  const ui = sandbox.H2O.Studio.archiveHealthUi || sandbox.H2O.Studio.ingestion.archiveHealthUi;
  const plain = ui.formatArchiveHealthSummary({ status: 'warning', complete: true });
  const hygienic = ui.formatArchiveHealthSummary({
    status: 'warning', complete: true, rendererHygiene: { observed: true, dataImageResidue: 1, assetRefDrift: 0 },
  });
  assert.equal(plain.status, hygienic.status, 'state is unchanged');
  same(plain.pill, hygienic.pill, 'pill and tone are unchanged');
  assert.notEqual(plain.explanation, hygienic.explanation, 'copy names the actual cause');
  assert.match(hygienic.explanation, /renderer residue/i);

  const mixed = ui.formatArchiveHealthSummary({
    status: 'partial', complete: true, rendererHygiene: { observed: true, dataImageResidue: 1, assetRefDrift: 0 },
  });
  assert.equal(mixed.pill.label, 'Mixed');
  assert.match(mixed.explanation, /renderer residue/i);
});

check('C32 hygiene is wired into studio.html and both pack-studio manifests', async () => {
  assert.match(readRepo(STUDIO_HTML), /ingestion\/saved-chat-archive-renderer-hygiene\.js/);
  const html = readRepo(STUDIO_HTML);
  assert.ok(html.indexOf('saved-chat-package-codec.tauri.js') < html.indexOf('saved-chat-archive-renderer-hygiene.js'),
    'hygiene must load after the codec it decodes through');
  assert.ok(html.indexOf('saved-chat-archive-renderer-hygiene.js') < html.indexOf('saved-chat-archive-health-composition.js'),
    'hygiene must load before the composition that resolves it');
  const pack = readRepo(PACK_STUDIO);
  assert.equal((pack.match(/ingestion\/saved-chat-archive-renderer-hygiene\.js/g) || []).length, 2,
    'both pack-studio module lists must carry the module');
});

check('C33 the diagnostics facade no longer defers hygiene to P3.5', async () => {
  const code = codeOnly(readRepo(DIAGNOSTICS));
  assert.doesNotMatch(code, /deferredTo/, 'the P3.5 deferral stub must be gone');
  assert.match(code, /result\.rendererHygiene\s*=/);
  assert.match(code, /packagesUnavailable/);
});

for (const { name, fn } of checks) {
  try { await fn(); console.log(`PASS  ${name}`); }
  catch (error) { failures += 1; console.error(`FAIL  ${name}\n      ${error && error.message}`); }
}
if (failures > 0) {
  console.error(`\n${failures} renderer-hygiene validation check(s) failed.`);
  process.exit(1);
}
console.log(`\nAll ${checks.length} renderer-hygiene validation checks passed.`);
