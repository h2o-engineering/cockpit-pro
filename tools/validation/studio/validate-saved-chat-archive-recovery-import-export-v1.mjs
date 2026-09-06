#!/usr/bin/env node
// H.1/H.2/H.4 — Saved-chat archive RECOVERY / IMPORT / EXPORT validator (static).
//
// H.0 (contract e8e2ca1) defined inspection/verification/open/import/export of
// .h2ochat packages, inspector-first. H.1 locked the contract; H.2 added the
// Desktop READ-ONLY package inspector; H.4 now adds the FIRST import/recovery
// action — a separate, Desktop-only, verification-gated, NO-OVERWRITE importer
// module (dry-run + explicit import-as-new). This validator asserts the H.0
// contract, the H.2 read-only inspector (which STAYS read-only), and the H.4
// importer (verification-gated, dry-run non-mutating, import-as-new via a fresh
// id, never the overwrite-by-id primitive, restore/relink deferred, no package
// HTML execution, Desktop-only), while the standing boundaries hold (Chrome no
// package authority, diagnostics read-only, writer a projection writer, and as
// of Phase J.2 only the bounded Desktop archiveExporter export/share runtime is
// allowed. As of Phase K.1 the verification-gated RESTORE module
// (restore-original-ids) is pre-authorized. As of Phase K.4.1 the future
// verification-gated RELINK module is pre-authorized by filename/entry point
// only; tombstone-override/un-delete stay deferred.
//
//   [H.1]       = the recovery/import/export contract (H.0 doc assertions).
//   [H.2]       = the read-only Archive Inspector implementation (stays read-only).
//   [H.4]       = the verification-gated, no-overwrite import/recovery action.
//   [INVARIANT] = boundaries that must hold now and after H.4.
//
// Static only: reads source/doc text, asserts patterns. No runtime, no imports of
// runtime modules, no DB, no network.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), '..', '..', '..');

const H0_CONTRACT_REL = 'release-evidence/2026-06-24/saved-chat-archive-phase-h0-recovery-import-export-contract.md';
const DIAGNOSTICS_REL = 'src-surfaces-base/studio/ingestion/saved-chat-archive-diagnostics.tauri.js';
const WRITER_REL = 'src-surfaces-base/studio/ingestion/saved-chat-package-v1.tauri.js';
const SCANNER_REL = 'src-surfaces-base/studio/ingestion/saved-chat-archive-request-inbox.tauri.js';
const MATERIALIZER_REL = 'src-surfaces-base/studio/ingestion/saved-chat-archive-materializer.tauri.js';
const DELIVERY_MV3_REL = 'src-surfaces-base/studio/ingestion/saved-chat-archive-request-delivery.mv3.js';
const IMPORT_BUNDLE_REL = 'src-surfaces-base/studio/ingestion/import-bundle.tauri.js';
const EXPORT_BUNDLE_REL = 'src-surfaces-base/studio/ingestion/export-bundle.tauri.js';
const STUDIO_DIR_REL = 'src-surfaces-base/studio';

const MATERIALIZE_API = 'materializeSavedChatArchiveRequestV1';
const PACKAGE_EXT = '.h2ochat';
const INSPECTOR_REL = 'src-surfaces-base/studio/ingestion/saved-chat-archive-inspector.studio.js';
const IMPORTER_REL = 'src-surfaces-base/studio/ingestion/saved-chat-archive-importer.studio.js';
const EXPORTER_REL = 'src-surfaces-base/studio/ingestion/saved-chat-archive-exporter.studio.js';
// Phase K.0/K.1 planning allowance: the future verification-gated, absent-only,
// no-overwrite RESTORE module (restore-original-ids). It does not exist yet (K.1 is
// contract + validator only); pre-authorizing it here keeps the K.2 restore module
// from tripping the .h2ochat-reference invariant. Relink + tombstone-override stay
// deferred (see RELINK_FORBIDDEN_NAMES).
const RESTORE_REL = 'src-surfaces-base/studio/ingestion/saved-chat-archive-restore.studio.js';
const RELINK_REL = 'src-surfaces-base/studio/ingestion/saved-chat-archive-relink.studio.js';
const HEALTH_UI_REL = 'src-surfaces-base/studio/ingestion/archive-health-ui.studio.js';
// Files that legitimately reference .h2ochat: the WRITER, the read-only DIAGNOSTICS,
// the read-only INSPECTOR (H.2), the verification-gated IMPORTER (H.4), the bounded
// Desktop EXPORTER (J.2), the M08 portable ZIP wrapper codec, the verification-gated
// RESTORE module (K.2), and the planned verification-gated RELINK module (K.4).
// No other module may reference it.
const ALLOWED_H2OCHAT = new Set([
  'src-surfaces-base/studio/ingestion/saved-chat-package-v1.tauri.js',
  /* M03 T02/T03: the single governed saved-chat package codec authority. It owns
   * gzip encode/decode, bounded package-member reads, physical/logical member
   * verification and the logical snapshot cap, so it legitimately resolves
   * `.h2ochat` package paths. Accepted alongside the writer, not in place of it. */
  'src-surfaces-base/studio/ingestion/saved-chat-package-codec.tauri.js',
  'src-surfaces-base/studio/ingestion/saved-chat-archive-diagnostics.tauri.js',
  'src-surfaces-base/studio/ingestion/saved-chat-archive-inspector.studio.js',
  'src-surfaces-base/studio/ingestion/saved-chat-archive-importer.studio.js',
  'src-surfaces-base/studio/ingestion/saved-chat-archive-exporter.studio.js',
  'src-surfaces-base/studio/ingestion/saved-chat-portable-zip.studio.js',
  RESTORE_REL,
  RELINK_REL,
]);
// Legacy placeholder import/recovery entry-point names we deliberately did NOT use
// (H.4 uses the cleaner dryRunImportPackage / importVerifiedPackage). These must
// not appear anywhere in the studio tree.
const FORBIDDEN_IMPORTER_NAMES = [
  'importSavedChatPackage', 'recoverSavedChat', 'openSavedChatPackage', 'importSavedChatArchivePackage',
];
// The REAL H.4 import/recovery entry points. They may exist ONLY in the importer
// module — never leaked into the writer/diagnostics/inspector/scanner/materializer
// or the Chrome reader.
const IMPORTER_ENTRY_NAMES = ['dryRunImportPackage', 'importVerifiedPackage'];
/* The import entry points are CALLER-CONFINED. They were confined to the
 * importer alone; the Recovery Center is now the one admitted caller, because
 * T04 wires Recover-as-New through exactly these governed entry points rather
 * than acquiring write authority of its own.
 *
 * This is a topology change, not an authority change, so the allowlist is an
 * exact path set with a pinned size — a third caller cannot appear silently —
 * and the admitted caller is additionally pinned to the exact importer symbols
 * it may name. */
const RECOVERY_CENTER_REL = 'src-surfaces-base/studio/ingestion/saved-chat-recovery-center-ui.studio.js';
const IMPORTER_ENTRY_CALLERS = new Set([IMPORTER_REL, RECOVERY_CENTER_REL]);
/* Everything the Recovery Center may name on the importer: the two T04 entry
 * points plus the pure snapshot mapper accepted at T03. */
const RECOVERY_CENTER_IMPORTER_SYMBOLS = new Set([
  'dryRunImportPackage',
  'importVerifiedPackage',
  'buildTurnsFromPackageSnapshot',
]);
// Broad/placeholder .h2ochat EXPORT / share entry points remain forbidden. J.2
// allows only the bounded Desktop archiveExporter module with these explicit
// names.
const FORBIDDEN_EXPORT_NAMES = [
  'exportSavedChatPackage', 'shareSavedChatPackage', 'exportSavedChatArchivePackage',
  'copySavedChatPackageToExport',
];
const EXPORTER_ENTRY_NAMES = ['archiveExporter', 'dryRunExportPackage', 'exportVerifiedPackage'];
// Planned K (restore-original-ids) entry points. They may exist ONLY in the restore
// module once K.2 lands — never leaked elsewhere. Absent in K.1. (Namespace-qualified
// so bare `archiveRestore` does not collide with unrelated sync-lane identifiers like
// archiveRestoreInstalled.)
const RESTORE_ENTRY_NAMES = ['H2O.Studio.archiveRestore', 'dryRunRestorePackage', 'restoreVerifiedPackage'];
/* T05: the restore entry points gain exactly one admitted caller, the Recovery
 * Center, on the same terms as the importer entry points above — an exact path
 * set with a pinned size, plus a symbol pin on what that caller may name.
 * Relink stays module-only. */
const RESTORE_ENTRY_CALLERS = new Set([RESTORE_REL, RECOVERY_CENTER_REL]);
const RECOVERY_CENTER_RESTORE_SYMBOLS = new Set([
  'dryRunRestorePackage',
  'restoreVerifiedPackage',
]);
// Planned K.4 relink entry points. They may exist ONLY in the future relink module.
// Tombstone override/undelete remains deferred everywhere.
const RELINK_ENTRY_NAMES = ['H2O.Studio.archiveRelink', 'dryRunRelinkPackage', 'relinkVerifiedPackage'];

const PASS = [];
const FAIL = [];
function check(label, fn) {
  try { fn(); PASS.push(label); console.log(`  ✓ ${label}`); }
  catch (e) { const m = e && e.message ? e.message : String(e); FAIL.push({ label, m }); console.log(`  ✗ ${label}`); console.log(`      ${m}`); }
}
function readRepo(rel) { return fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8'); }
function exists(rel) { return fs.existsSync(path.join(REPO_ROOT, rel)); }
function stripComments(srcText) {
  return String(srcText).replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');
}
function walkJs(absDir) {
  const out = [];
  for (const e of fs.readdirSync(absDir, { withFileTypes: true })) {
    const p = path.join(absDir, e.name);
    if (e.isDirectory()) out.push(...walkJs(p));
    else if (/\.js$/.test(e.name)) out.push(p);
  }
  return out;
}

const h0 = exists(H0_CONTRACT_REL) ? readRepo(H0_CONTRACT_REL) : '';
const diagCode = stripComments(readRepo(DIAGNOSTICS_REL));
const writerCode = stripComments(readRepo(WRITER_REL));
const scannerCode = stripComments(readRepo(SCANNER_REL));
const matCode = stripComments(readRepo(MATERIALIZER_REL));
const readerCode = stripComments(readRepo(DELIVERY_MV3_REL));
const importBundle = stripComments(readRepo(IMPORT_BUNDLE_REL));
const exportBundle = stripComments(readRepo(EXPORT_BUNDLE_REL));
const inspectorSrc = exists(INSPECTOR_REL) ? readRepo(INSPECTOR_REL) : '';
const inspectorCode = stripComments(inspectorSrc);
const importerSrc = exists(IMPORTER_REL) ? readRepo(IMPORTER_REL) : '';
const importerCode = stripComments(importerSrc);
const healthUiCode = stripComments(readRepo(HEALTH_UI_REL));

console.log('[archive-recovery-import-export] H.1 contract checks');

// --- A. H.0 contract (recovery / import / export) ----------------------------

check('[H.1] H.0 contract evidence file exists', () => {
  assert.ok(exists(H0_CONTRACT_REL), 'missing ' + H0_CONTRACT_REL);
});

check('[H.1] H.0 is marked PHASE H.0 CONTRACT — NOT IMPLEMENTED', () => {
  assert.match(h0, /PHASE H\.0 CONTRACT\s*[—-]\s*NOT IMPLEMENTED/);
});

check('[H.1] H.0 states no .h2ochat reader/importer/inspector exists yet', () => {
  assert.ok(h0.includes('reader / importer / inspector exists yet'),
    'H.0 must state no reader/importer/inspector exists yet');
});

check('[H.1] H.0 recommends a read-only inspector first (before import/write recovery)', () => {
  assert.ok(h0.includes('read-only package inspector first'), 'H.0 must recommend inspector-first');
});

check('[H.1] H.0 defines the product goals (inspect / verify / open / import-if-safe / export)', () => {
  for (const g of ['Inspect', 'Verify integrity', 'Open / read', 'Import into Desktop store', 'Export / share']) {
    assert.ok(h0.includes(g), 'H.0 product goal missing: ' + g);
  }
});

check('[H.1] H.0 preserves the authority model (Desktop owns import; Chrome no import / no package body; projection)', () => {
  assert.ok(h0.includes('Desktop owns import'), 'Desktop owns import');
  assert.match(h0, /Chrome does not import packages/i);
  assert.ok(h0.includes('does not read the package/CAS body'), 'Chrome does not read package/CAS body');
  assert.ok(h0.includes('projection, not the primary source of truth'), 'package is a projection, not primary truth');
});

check('[H.1] H.0 defines the recovery modes (inspector / import-as-new / restore-relink / reject)', () => {
  assert.ok(h0.includes('Read-only inspector'), 'mode: read-only inspector');
  assert.ok(h0.includes('Import as new recovered'), 'mode: import as new recovered');
  assert.ok(h0.includes('Restore / relink'), 'mode: restore / relink');
  assert.ok(h0.includes('Reject unsafe'), 'mode: reject unsafe/corrupted');
});

check('[H.1] H.0 defines the validation gate (required files + hashes + contentHash + schema + assets + no partial)', () => {
  for (const f of ['manifest.json', 'snapshot.json', 'chat.md', 'chat.html']) {
    assert.ok(h0.includes(f), 'validation gate missing required file: ' + f);
  }
  assert.ok(h0.includes('manifest.files'), 'hashes must match the manifest descriptors');
  assert.ok(h0.includes('sha256(snapshot.json)'), 'contentHash = sha256(snapshot.json) semantics');
  assert.ok(h0.includes('schemaVersion') && h0.includes('payloadVersion'), 'schema/payload version compatibility');
  assert.match(h0, /assets checked if present/i);
  assert.ok(h0.includes('No silent partial import'), 'no silent partial import');
});

check('[H.1] H.0 defines conflict handling (chatId / snapshotId / contentHash / title / foreign machine)', () => {
  assert.match(h0, /`chatId` already exists/);
  assert.match(h0, /`snapshotId` already exists/);
  assert.match(h0, /`contentHash` already exists/);
  assert.ok(h0.includes('title/name collision'), 'title/name collision');
  assert.ok(h0.includes('another machine/profile'), 'foreign package/profile/machine');
});

check('[H.1] H.0 defines the UX boundary (Desktop-only / inspector area / explicit / no global button / clear states)', () => {
  assert.ok(h0.includes('Desktop-only'), 'Desktop-only');
  assert.match(h0, /Archive Inspector|Archive Health/);
  assert.match(h0, /explicit operator action/i);
  assert.match(h0, /no global floating button/i);
  for (const st of ['verified', 'corrupted', 'already-exists', 'imported', 'rejected']) {
    assert.ok(h0.includes(st), 'clear state missing: ' + st);
  }
});

check('[H.1] H.0 defines the safety boundaries (no Chrome package authority / no scanner-materializer-watcher / no sync / no overwrite)', () => {
  assert.match(h0, /Chrome package write\/read authority/i);
  assert.match(h0, /No scanner changes/i);
  assert.match(h0, /No materializer changes/i);
  assert.match(h0, /No watcher\/daemon/i);
  assert.match(h0, /No sync \/ WebDAV \/ cloud propagation/i);
  assert.match(h0, /`?S0F0j`? \/ `?S0F1j`? edits/);
  assert.match(h0, /no package overwrite by default/i);
});

// --- B. Current runtime is pre-implementation (no inspector/importer yet) -----

check('[INVARIANT] .h2ochat referenced only by writer/diagnostics/inspector/importer/exporter; import entry points confined to the importer', () => {
  const offenders = [];
  for (const abs of walkJs(path.join(REPO_ROOT, STUDIO_DIR_REL))) {
    if (stripComments(fs.readFileSync(abs, 'utf8')).includes(PACKAGE_EXT)) {
      const rel = path.relative(REPO_ROOT, abs);
      if (!ALLOWED_H2OCHAT.has(rel)) offenders.push(rel);
    }
  }
  assert.deepEqual(offenders, [], '.h2ochat referenced outside the sanctioned owner allowlist (unexpected reader?): ' + offenders.join(', '));
  /* The allowlist stays an exact-path membership test, never a permissive
   * pattern: an arbitrary unrelated studio module is still an offender, and the
   * sanctioned owner count is pinned so it cannot grow silently. */
  assert.equal(ALLOWED_H2OCHAT.has('src-surfaces-base/studio/ingestion/saved-chat-archive-materializer.tauri.js'), false);
  assert.equal(ALLOWED_H2OCHAT.has('src-surfaces-base/studio/ingestion/some-unrelated-module.js'), false);
  assert.equal(ALLOWED_H2OCHAT.size, 9, 'sanctioned .h2ochat owner count changed');
  // Legacy placeholder names must not appear anywhere.
  for (const abs of walkJs(path.join(REPO_ROOT, STUDIO_DIR_REL))) {
    const code = stripComments(fs.readFileSync(abs, 'utf8'));
    for (const name of FORBIDDEN_IMPORTER_NAMES) {
      assert.ok(!code.includes(name), 'unexpected legacy import entry-point name: ' + name + ' in ' + path.relative(REPO_ROOT, abs));
    }
  }
  // The real H.4 import entry points may live ONLY in the importer module and,
  // since T04, in the Recovery Center that requests recovery through them.
  const observedCallers = [];
  for (const abs of walkJs(path.join(REPO_ROOT, STUDIO_DIR_REL))) {
    const rel = path.relative(REPO_ROOT, abs);
    const code = stripComments(fs.readFileSync(abs, 'utf8'));
    const names = IMPORTER_ENTRY_NAMES.filter((name) => code.includes(name));
    if (names.length) observedCallers.push(rel);
    if (IMPORTER_ENTRY_CALLERS.has(rel)) continue;
    for (const name of names) {
      assert.ok(false, 'import entry point leaked outside the admitted callers: ' + name + ' in ' + rel);
    }
  }
  /* The allowlist is EXACTLY two paths and cannot grow silently. */
  assert.equal(IMPORTER_ENTRY_CALLERS.size, 2, 'the admitted importer-caller set changed size');
  assert.ok(IMPORTER_ENTRY_CALLERS.has(IMPORTER_REL), 'the importer itself must remain admitted');
  assert.ok(IMPORTER_ENTRY_CALLERS.has(RECOVERY_CENTER_REL), 'the Recovery Center must be the only other admitted caller');
  for (const rel of [IMPORTER_REL, RECOVERY_CENTER_REL]) {
    assert.ok(fs.existsSync(path.join(REPO_ROOT, rel)), 'an admitted caller does not exist: ' + rel);
  }
  /* Both admitted callers must actually be observed, so the allowlist can never
   * quietly carry a path that no longer participates. */
  assert.deepEqual(observedCallers.slice().sort(), [IMPORTER_REL, RECOVERY_CENTER_REL].slice().sort(),
    'observed importer-entry callers differ from the admitted set: ' + observedCallers.join(', '));

  /* The admitted caller may name ONLY the governed T04 entry points and the pure
   * mapper. A fourth importer symbol in the Recovery Center would be new reach
   * into that module regardless of what it is called. */
  const rcCode = stripComments(readRepo(RECOVERY_CENTER_REL));
  const rcSymbols = new Set(
    (rcCode.match(/archiveImporter\s*\)?\s*\.\s*([A-Za-z0-9_$]+)/g) || [])
      .map((m) => m.split('.').pop().trim()),
  );
  for (const sym of rcSymbols) {
    assert.ok(RECOVERY_CENTER_IMPORTER_SYMBOLS.has(sym),
      'Recovery Center names a non-admitted importer symbol: archiveImporter.' + sym);
  }
  assert.equal(RECOVERY_CENTER_IMPORTER_SYMBOLS.size, 3, 'the admitted Recovery Center symbol set changed size');
  // The planned K restore/relink entry points may live ONLY in their dedicated
  // modules. This keeps importer/exporter/restore roles separated.
  const observedRestoreCallers = [];
  for (const abs of walkJs(path.join(REPO_ROOT, STUDIO_DIR_REL))) {
    const rel = path.relative(REPO_ROOT, abs);
    const code = stripComments(fs.readFileSync(abs, 'utf8'));
    const restoreNames = RESTORE_ENTRY_NAMES.filter((name) => code.includes(name));
    if (restoreNames.length) observedRestoreCallers.push(rel);
    if (!RESTORE_ENTRY_CALLERS.has(rel)) {
      for (const name of restoreNames) {
        assert.ok(false, 'restore entry point leaked outside the admitted callers: ' + name + ' in ' + rel);
      }
    }
    /* Relink is unchanged: it may live ONLY in the relink module. Tombstone
     * override/undelete remains deferred everywhere. */
    if (rel !== RELINK_REL) {
      for (const name of RELINK_ENTRY_NAMES) {
        assert.ok(!code.includes(name), 'relink entry point leaked outside the relink module: ' + name + ' in ' + rel);
      }
    }
  }
  /* The restore-caller allowlist is EXACTLY two paths and both must participate. */
  assert.equal(RESTORE_ENTRY_CALLERS.size, 2, 'the admitted restore-caller set changed size');
  assert.ok(RESTORE_ENTRY_CALLERS.has(RESTORE_REL), 'the restore module itself must remain admitted');
  assert.ok(RESTORE_ENTRY_CALLERS.has(RECOVERY_CENTER_REL), 'the Recovery Center must be the only other admitted caller');
  assert.equal(RESTORE_ENTRY_CALLERS.has(RELINK_REL), false, 'the relink module must never be an admitted restore caller');
  assert.deepEqual(observedRestoreCallers.slice().sort(), [RESTORE_REL, RECOVERY_CENTER_REL].slice().sort(),
    'observed restore-entry callers differ from the admitted set: ' + observedRestoreCallers.join(', '));
  /* And it may name ONLY the two governed T05 entry points. */
  const rcRestoreSymbols = new Set(
    (rcCode.match(/archiveRestore\s*\)?\s*\.\s*([A-Za-z0-9_$]+)/g) || [])
      .map((m) => m.split('.').pop().trim()),
  );
  assert.ok(rcRestoreSymbols.size > 0, 'the Recovery Center names no restore symbol — the pin would pass vacuously');
  for (const sym of rcRestoreSymbols) {
    assert.ok(RECOVERY_CENTER_RESTORE_SYMBOLS.has(sym),
      'Recovery Center names a non-admitted restore symbol: archiveRestore.' + sym);
  }
  assert.equal(RECOVERY_CENTER_RESTORE_SYMBOLS.size, 2, 'the admitted Recovery Center restore symbol set changed size');
  for (const sym of RECOVERY_CENTER_RESTORE_SYMBOLS) {
    assert.ok(rcRestoreSymbols.has(sym), 'an admitted restore symbol is not actually used: ' + sym);
  }
});

check('[INVARIANT] archive-path recovery reads are bound to TRUSTED package state, not to the package', () => {
  /* The defect this pins: a package read after its trusted verification could
   * supply the very digest/length/encoding used to validate it, and could
   * choose the weaker read regime by claiming a different schemaVersion. Both
   * governed consumers now take those expectations from the trusted
   * archive-integrity occupant instead.
   *
   * Scanned on COMMENT-STRIPPED source: the modules' own prose describes the
   * manifest they no longer trust, so a raw substring scan would report the
   * comment that promises the opposite. */
  const RESTORE_REL_LOCAL = 'src-surfaces-base/studio/ingestion/saved-chat-archive-restore.studio.js';
  for (const rel of [IMPORTER_REL, RESTORE_REL_LOCAL]) {
    const code = stripComments(readRepo(rel));
    const who = rel.split('/').pop();

    /* 1. The archive path performs no manifest read at all, so no descriptor or
     *    regime decision can be derived from one. */
    for (const banned of ['readPackageManifestJson', "readPackageTextFile(packagePath, 'manifest.json')"]) {
      assert.ok(!code.includes(banned), `${who}: archive path still reads the package manifest: ${banned}`);
    }
    /* 2. The regime is chosen by the TRUSTED construction family, never by a
     *    package-supplied schemaVersion or descriptor presence. */
    assert.ok(code.includes('anchors.family === FAMILY_V3'),
      `${who}: the read regime is not selected from the trusted construction family`);
    assert.ok(!/m\.schemaVersion === 3/.test(code) || rel === IMPORTER_REL,
      `${who}: a package-supplied schemaVersion still selects the read regime`);
    /* 3. Trusted member anchors are required, and the v3 descriptor is built
     *    solely from them. */
    for (const required of ['trustedOccupantFor', 'trustedStateMatches', 'trustedMemberAnchors',
      'trustedSnapshotDescriptor', 'readBoundPackageSnapshotJson']) {
      assert.ok(code.includes(required), `${who}: missing trusted-binding seam ${required}`);
    }
    assert.ok(code.includes('descriptor: trustedSnapshotDescriptor(anchors)'),
      `${who}: the v3 descriptor is not built solely from trusted anchors`);
    /* 4. v1/v2 compare the bounded reader's own returned measurements. */
    assert.ok(code.includes('read.physicalSha256') && code.includes('read.physicalByteLength'),
      `${who}: the v1/v2 read is not compared against the trusted physical measurements`);
    /* 5. Fail-closed, never a downgrade: an incomplete anchor set returns null
     *    rather than falling through to the weaker path. */
    assert.ok(/if \(!anchors\) return null;/.test(code),
      `${who}: partial trusted anchors do not fail closed`);
    /* 6. Neither module recomputes a digest of its own. */
    for (const banned of ['createHash', 'subtle.digest', 'sha256PrefixedBytes(']) {
      assert.ok(!code.includes(banned), `${who}: a second hash authority appeared: ${banned}`);
    }
  }

  /* The PORTABLE path is a different shape and stays untouched: it verifies one
   * in-memory contained entry set and then reads its manifest and snapshot from
   * that same set, so it has no second-read window. Its manifest use is
   * legitimate and must not be banned by the archive-path rule above. */
  const importerCode = stripComments(readRepo(IMPORTER_REL));
  assert.ok(importerCode.includes('readPackageSnapshotJsonFromBytes'),
    'the portable in-memory read seam was removed');
  assert.ok(importerCode.includes('loadPortableCandidate'),
    'the portable candidate path was removed');
  assert.ok(/sourceKind\) === 'archive-package'/.test(importerCode),
    'the importer no longer distinguishes the archive path from the portable path');
});

check('[INVARIANT] Chrome runtime (mv3 reader) has no package/CAS body or SQLite authority', () => {
  for (const banned of [PACKAGE_EXT, 'archive/packages', 'archive/assets', 'plugin:sql|',
    'writeSavedChatPackageV1', MATERIALIZE_API]) {
    assert.ok(!readerCode.includes(banned), 'Chrome reader must not reference: ' + banned);
  }
});

check('[INVARIANT] scanner/materializer/writer behavior unchanged for H.1', () => {
  assert.ok(!scannerCode.includes(MATERIALIZE_API), 'scanner stays enqueue-only (no materializer call)');
  assert.match(matCode, /if \(!detectTauri\(\)\) return;/); // materializer Desktop/Tauri-only
  assert.ok(writerCode.includes('writeSavedChatPackageV1'), 'writer still defines the package writer');
});

check('[INVARIANT] diagnostics keeps its live observations and stays read-only', () => {
  /* M10 P4 retired the duplicate JS package verifier. What survives here is
     everything that was never a validity decision: DB drift, live-CAS presence,
     write residue, capability reporting, and the trusted Health facade. */
  for (const live of [
    'dbDriftForIdentity', 'liveCasPresenceForShas', 'residueObservationV1',
    'diagnoseSavedChatArchiveCapabilitiesV1', 'diagnoseSavedChatArchiveV1',
  ]) {
    assert.match(diagCode, new RegExp(live), 'live observation missing: ' + live);
  }
  /* And it decides no package validity of its own any more: the verifier entry
     points are gone and nothing left computes a hash. */
  for (const retired of [
    'validateSavedChatPackageV1', 'validateSavedChatPackageBytesV1',
    'filesystemPackageSource', 'memoryPackageSource', 'sha256Hex', 'canonicalJson',
  ]) {
    assert.ok(!diagCode.includes(retired), 'retired verifier surface still present: ' + retired);
  }
  for (const banned of ['plugin:fs|write', 'plugin:sql|execute', MATERIALIZE_API, 'snapshots.create', 'snapshots.upsert']) {
    assert.ok(!diagCode.includes(banned), 'diagnostics must stay read-only (found: ' + banned + ')');
  }
});

check('[INVARIANT] package writer still writes projection packages and is NOT an importer', () => {
  assert.ok(writerCode.includes('writeSavedChatPackageV1'), 'writer present');
  assert.ok(writerCode.includes('projectionOnly'), 'writer emits projectionOnly provenance');
  for (const banned of FORBIDDEN_IMPORTER_NAMES.concat(['snapshots.create', 'snapshots.upsert'])) {
    assert.ok(!writerCode.includes(banned), 'writer must not become an importer (found: ' + banned + ')');
  }
});

check('[INVARIANT] import-bundle / export-bundle are full-bundle artifacts, not .h2ochat package import/export', () => {
  assert.ok(importBundle.includes('h2o.studio.fullBundle'), 'import-bundle is the full-bundle importer');
  assert.ok(!importBundle.includes(PACKAGE_EXT), 'import-bundle must not touch .h2ochat packages');
  assert.ok(exportBundle.includes('h2o.studio.fullBundle'), 'export-bundle is the full-bundle exporter');
  assert.ok(!exportBundle.includes(PACKAGE_EXT), 'export-bundle must not touch .h2ochat packages');
});

// --- C. H.2 read-only Archive Inspector implementation -----------------------

check('[H.2] read-only Archive Inspector module exists, registers archiveInspector, and the health UI delegates to it', () => {
  assert.ok(exists(INSPECTOR_REL), 'inspector module missing');
  assert.match(inspectorSrc, /H2O\.Studio\.archiveInspector\s*=/);
  assert.match(inspectorSrc, /function inspectPackage\s*\(/);
  assert.match(inspectorSrc, /mountArchiveInspectorCard/);
  assert.match(inspectorSrc, /renderArchiveInspectorCard/);
  // mounted adjacent to Archive Health via the read-only-preserving delegation
  assert.ok(healthUiCode.includes('mountArchiveInspectorCard'), 'health UI must delegate to the inspector mount');
});

check('[H.2] inspector is Desktop-only (detectTauri + isDesktopCapable gate)', () => {
  assert.match(inspectorCode, /function detectTauri\s*\(/);
  assert.match(inspectorCode, /__TAURI_INTERNALS__|__TAURI__/);
  assert.match(inspectorCode, /isDesktopCapable/);
});

/* M10 P3.5 superseded the original H.2 assertion. The Inspector used to reuse
 * the read-only JS diagnostics walk (validateSavedChatPackageV1 +
 * listSavedChatArchivePackagesV1); archive integrity is now read from the
 * TRUSTED native authority and partitioned through the canonical archive-health
 * mapping, so requiring the legacy verifier would now assert the architecture
 * P3.5 deliberately retired. The read-only, no-write, no-HTML-execution and
 * status-vocabulary guarantees around it are unchanged and still asserted by
 * the sibling checks below.
 *
 * `mapInspectStatus` deliberately REMAINS in the Inspector for the M08 portable
 * importer carveout; P3.6 retires it. This check therefore constrains only the
 * archive-integrity decision path. */
check('[H.2] inspector decides archive integrity from the trusted native authority, not the legacy JS verifier', () => {
  assert.ok(inspectorCode.includes('readSavedChatArchiveIntegrityV1'),
    'inspector must read archive integrity from the trusted native client');
  assert.ok(inspectorCode.includes('partitionOccupants'),
    'inspector must partition occupants through the canonical archive-health mapping');
  assert.ok(inspectorCode.includes('mapTrustedInspectStatus'),
    'inspector must map the TRUSTED occupant into its status vocabulary');
  for (const retired of ['validateSavedChatPackageV1', 'listSavedChatArchivePackagesV1']) {
    assert.ok(!inspectorCode.includes(retired),
      'inspector must not decide archive integrity through the retired legacy verifier: ' + retired);
  }
});

check('[H.2] inspector exposes the granular status vocabulary', () => {
  /* M10 P3.5 replaced the legacy labels with the trusted taxonomy, and P3.6b
     deleted the last legacy mapper: `missing-files` and `unsupported-version`
     are retired because no trusted fact proves either claim. */
  for (const st of ['verified', 'corrupted', 'hash-mismatch', 'read-error',
    'incomplete', 'unreadable', 'identity-mismatch', 'unsupported-encoding']) {
    assert.ok(inspectorCode.includes("'" + st + "'"), 'inspector status missing: ' + st);
  }
  for (const retired of ['missing-files', 'unsupported-version']) {
    assert.ok(!inspectorCode.includes("'" + retired + "'"), 'retired status still present: ' + retired);
  }
});

check('[H.2] inspector does NOT import or write the store (no snapshot create/upsert, no SQL/package write, no importer)', () => {
  for (const banned of ['snapshots.create', 'snapshots.upsert', 'plugin:sql|execute', 'plugin:sql|', 'writeSavedChatPackageV1',
    'plugin:fs|write', MATERIALIZE_API].concat(FORBIDDEN_IMPORTER_NAMES)) {
    assert.ok(!inspectorCode.includes(banned), 'inspector must stay read-only (found: ' + banned + ')');
  }
  assert.doesNotMatch(inspectorCode, /\bINSERT\s+INTO\b|\bUPDATE\b[^=]/i, 'inspector must not write SQL');
});

check('[H.2] inspector does NOT execute package HTML (reads chat.md escaped; never reads/injects chat.html; no eval/Function)', () => {
  assert.doesNotMatch(inspectorCode, /\beval\s*\(/, 'no eval');
  assert.doesNotMatch(inspectorCode, /new\s+Function\s*\(/, 'no new Function');
  assert.match(inspectorCode, /readPackageTextFile\([^)]*['"]chat\.md['"]/); // preview reads chat.md
  assert.doesNotMatch(inspectorCode, /readPackageTextFile\([^)]*['"]chat\.html['"]/, 'inspector must not read chat.html');
  assert.ok(inspectorSrc.includes('escapeHtml(r.preview)'), 'preview must be HTML-escaped');
});

check('[H.2] inspector has no watcher/daemon and no scanner/Chrome/sync/native coupling', () => {
  for (const banned of ['setInterval', 'setTimeout', 'MutationObserver', 'requestAnimationFrame', 'requestIdleCallback',
    'scanSavedChatArchiveRequestInboxV1', 'chrome.runtime', 'connectNative', 'sendNativeMessage',
    'H2O.Studio.sync', 'webdav', 'WebDAV', 'localhost', '127.0.0.1', 'ws://', 'wss://']) {
    assert.ok(!inspectorCode.includes(banned), 'inspector must not couple to: ' + banned);
  }
});

// --- D. H.4 verification-gated, no-overwrite import/recovery action ----------

console.log('[archive-recovery-import-export] H.4 importer checks');

check('[H.4] importer module exists, registers archiveImporter (dry-run + import + pure turn builder); health UI delegates the mount', () => {
  assert.ok(exists(IMPORTER_REL), 'importer module missing');
  assert.match(importerSrc, /H2O\.Studio\.archiveImporter\s*=/);
  assert.match(importerSrc, /function dryRunImportPackage\s*\(/);
  assert.match(importerSrc, /function importVerifiedPackage\s*\(/);
  assert.match(importerSrc, /function buildTurnsFromPackageSnapshot\s*\(/);
  assert.match(importerSrc, /mountArchiveImporterCard/);
  assert.ok(healthUiCode.includes('mountArchiveImporterCard'), 'health UI must delegate to the importer mount');
});

check('[H.4] importer is Desktop-only and gated on the store adapters (detectTauri + isDesktopCapable + snapshots/chats stores)', () => {
  assert.match(importerCode, /function detectTauri\s*\(/);
  assert.match(importerCode, /__TAURI_INTERNALS__|__TAURI__/);
  assert.match(importerCode, /function isDesktopCapable\s*\(/);
  assert.ok(importerCode.includes('getSnapshotsStore') && importerCode.includes('getChatsStore'),
    'importer must require the Desktop snapshots + chats store adapters');
});

check('[H.4] importer reuses the read-only inspector for verification (archiveInspector + inspectPackage)', () => {
  assert.ok(importerCode.includes('archiveInspector'), 'importer must use the inspector');
  assert.ok(importerCode.includes('inspectPackage'), 'importer must verify via inspectPackage');
});

check('[H.4] dry-run is NON-MUTATING (shared decision core and package/ZIP adapters perform no writes)', () => {
  const sharedBody = (importerCode.split(/function\s+dryRunCandidate\s*\(/)[1] || '')
    .split(/function\s+dryRunImportPackage\s*\(/)[0] || '';
  const adapterBody = (importerCode.split(/function\s+dryRunImportPackage\s*\(/)[1] || '')
    .split(/function\s+generateRecoveredChatId\s*\(/)[0] || '';
  assert.ok(sharedBody.length > 0, 'could not isolate shared dry-run decision core');
  assert.ok(adapterBody.length > 0, 'could not isolate dry-run adapters');
  for (const banned of ['.create(', '.upsert(', 'plugin:sql|', 'plugin:fs|write', 'INSERT INTO', 'UPDATE ']) {
    assert.ok(!sharedBody.includes(banned) && !adapterBody.includes(banned),
      'dry-run must not write (found: ' + banned + ')');
  }
  assert.ok(adapterBody.includes('loadArchiveCandidate(packagePath).then(dryRunCandidate)'),
    'package dry-run must delegate to the shared non-mutating decision core');
  assert.ok(adapterBody.includes('loadPortableCandidate(opts.zipBytes, opts.sourceName).then(dryRunCandidate)'),
    'portable ZIP dry-run must delegate to the shared non-mutating decision core');
  // The shared decision core reads existing state only.
  assert.ok(/\.get\(|\.listByChat\(/.test(sharedBody), 'dry-run must read store state (get / listByChat)');
});

check('[H.4] import is verification-gated (requires import-ready, re-verifies, refuses partial/empty)', () => {
  assert.ok(importerCode.includes('dryRunImportPackage'), 'import must consult the dry-run');
  assert.ok(importerCode.includes("'import-ready'") || importerCode.includes('import-ready'), 'import gates on import-ready');
  assert.match(importerCode, /status[^;]*!==\s*'verified'|'verified'/, 'import re-verifies the package');
  assert.ok(importerCode.includes('already-imported'), 'already-imported documented no-op');
  assert.ok(/no turns|refusing partial|partial import/i.test(importerSrc), 'import must refuse an empty/partial payload');
});

check('[H.4] NO-OVERWRITE by construction: import-as-new via snapshots.create with a fresh id; the overwrite-by-id primitive is never used; original ids never reused for a write', () => {
  assert.ok(/snapStore\.create\(|snapshots\.create\(/.test(importerCode), 'import-as-new must use snapshots.create (fresh id)');
  assert.ok(!/snapStore\.upsert\(|snapshots\.upsert\(/.test(importerCode), 'must never call the snapshot overwrite-by-id primitive');
  assert.ok(importerCode.includes('generateRecoveredChatId'), 'recovered chat id must be freshly generated');
  assert.ok(importerSrc.includes('refusing to reuse original id'), 'must guard against reusing the package original ids');
  // the snapshot create patch must not carry a snapshotId (which would route to overwrite)
  assert.doesNotMatch(importerCode, /create\(\{[^}]*snapshotId/s, 'snapshot create patch must not set snapshotId');
});

check('[H.4] importer writes ONLY through the store adapters (no raw SQL, no fs write, no package overwrite)', () => {
  for (const banned of ['plugin:sql|execute', 'plugin:sql|', 'plugin:fs|write', 'writeSavedChatPackageV1', MATERIALIZE_API]) {
    assert.ok(!importerCode.includes(banned), 'importer must not bypass the store adapters (found: ' + banned + ')');
  }
  assert.doesNotMatch(importerCode, /\bINSERT\s+INTO\b|\bUPDATE\b[^=]/i, 'importer must not write raw SQL');
});

check('[H.4] restore/relink deferred + import-as-new records provenance + full decision vocabulary present', () => {
  assert.ok(importerCode.includes('restore-relink-deferred'), 'restore/relink must be deferred');
  for (const prov of ['recovered', 'originalChatId', 'originalSnapshotId', 'recoveredAt']) {
    assert.ok(importerCode.includes(prov), 'provenance field missing: ' + prov);
  }
  /* M10 P3.6b retired `unsupported-version`: portable import is decided by the
     trusted native verifier, which refuses an incoherent version triple as
     structural incoherence — a different claim from "version unsupported",
     and no trusted fact proves the latter. */
  for (const st of ['import-ready', 'already-imported', 'conflict-chat-id', 'conflict-snapshot-id', 'corrupted', 'rejected', 'imported']) {
    assert.ok(importerCode.includes(st), 'decision/state missing: ' + st);
  }
  assert.ok(!importerCode.includes('unsupported-version'), 'unsupported-version is retired');
  {
  }
});

check('[H.4] importer executes no package HTML and has no watcher/scanner/Chrome/sync coupling', () => {
  assert.doesNotMatch(importerCode, /\beval\s*\(/, 'no eval');
  assert.doesNotMatch(importerCode, /new\s+Function\s*\(/, 'no new Function');
  assert.doesNotMatch(importerCode, /readPackageTextFile\([^)]*['"]chat\.html['"]/, 'importer must not read chat.html');
  for (const banned of ['setInterval', 'MutationObserver', 'requestAnimationFrame', 'requestIdleCallback',
    'scanSavedChatArchiveRequestInboxV1', 'chrome.runtime', 'connectNative', 'sendNativeMessage',
    'H2O.Studio.sync', 'webdav', 'WebDAV', 'ws://', 'wss://']) {
    assert.ok(!importerCode.includes(banned), 'importer must not couple to: ' + banned);
  }
});

check('[INVARIANT] bounded .h2ochat export runtime exists only in archiveExporter; broad placeholders remain forbidden', () => {
  const exporterPath = path.join(REPO_ROOT, EXPORTER_REL);
  assert.ok(fs.existsSync(exporterPath), 'J.2 exporter module must exist');
  const exporter = stripComments(fs.readFileSync(exporterPath, 'utf8'));
  assert.ok(exporter.includes('H2O.Studio.archiveExporter'), 'exporter must register H2O.Studio.archiveExporter');
  for (const name of EXPORTER_ENTRY_NAMES) {
    assert.ok(exporter.includes(name), 'exporter entry point missing: ' + name);
  }
  assert.ok(exporter.includes('H2O Studio Exports'), 'exporter must use the bounded export root');
  assert.ok(exporter.includes('inspectPackage'), 'exporter must verify via inspectPackage');
  assert.ok(healthUiCode.includes('mountArchiveExporterCard'), 'health UI must delegate to the exporter mount');
  for (const abs of walkJs(path.join(REPO_ROOT, STUDIO_DIR_REL))) {
    const code = stripComments(fs.readFileSync(abs, 'utf8'));
    for (const name of FORBIDDEN_EXPORT_NAMES) {
      assert.ok(!code.includes(name), 'forbidden broad package export entry point exists: ' + name + ' in ' + path.relative(REPO_ROOT, abs));
    }
    const rel = path.relative(REPO_ROOT, abs);
    if (rel !== EXPORTER_REL) {
      for (const name of EXPORTER_ENTRY_NAMES) {
        if (rel === HEALTH_UI_REL && name === 'archiveExporter') continue;
        assert.ok(!code.includes(name), 'bounded exporter entry leaked outside exporter module: ' + name + ' in ' + rel);
      }
    }
  }
});

console.log('');
if (FAIL.length) {
  console.error(`[archive-recovery-import-export] ${FAIL.length} failed, ${PASS.length} passed`);
  process.exitCode = 1;
} else {
  console.log(`[archive-recovery-import-export] PASS ${PASS.length} checks`);
}
