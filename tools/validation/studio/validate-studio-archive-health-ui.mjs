#!/usr/bin/env node
// Validator for the C6.3 read-only Saved Chat Archive Health panel details.
//
// Static-checks the helper module + the studio.js Settings wiring, and runs a
// pure behavioral check of formatting/copy helpers (no DOM needed). Proves the
// summary cards, package details list, read-only boundaries, and that no
// mutation/action surface was added.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), '..', '..', '..');
const HELPER_REL = 'src-surfaces-base/studio/ingestion/archive-health-ui.studio.js';
const STUDIO_JS_REL = 'src-surfaces-base/studio/studio.js';
const STUDIO_HTML_REL = 'src-surfaces-base/studio/studio.html';
const PACK_REL = 'tools/product/studio/pack-studio.mjs';

const PASS = [];
const FAIL = [];
function check(label, fn) {
  try { fn(); PASS.push(label); console.log(`  ✓ ${label}`); }
  catch (e) { const m = e && e.message ? e.message : String(e); FAIL.push({ label, m }); console.log(`  ✗ ${label}`); console.log(`      ${m}`); }
}
async function checkAsync(label, fn) {
  try { await fn(); PASS.push(label); console.log(`  ✓ ${label}`); }
  catch (e) { const m = e && e.message ? e.message : String(e); FAIL.push({ label, m }); console.log(`  ✗ ${label}`); console.log(`      ${m}`); }
}
function readRepo(rel) { return fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8'); }

const helperSrc = readRepo(HELPER_REL);
const studioJs = readRepo(STUDIO_JS_REL);
const studioHtml = readRepo(STUDIO_HTML_REL);
const pack = readRepo(PACK_REL);

// Strip comments so boundary scans test CODE, not the header prose (which names
// the non-goals: repair/import/Copy report JSON, etc.).
function stripComments(src) {
  return String(src)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}
const helperCode = stripComments(helperSrc);

// The read-only health card delegates sibling MOUNTS (operator action / inspector /
// importer) to their own modules. Those delegations legitimately name the sibling
// modules (e.g. archiveImporter, mountArchiveImporterCard, importerApi, and the
// Recovery Center's recoveryCenterUi / mountRecoveryCenterCard / recoveryCenterApi) — they are
// not import/mutation LOGIC in the health card itself. Neutralize ONLY those exact
// delegation identifiers so the read-only / no-action-label scans test the health
// card's own behavior; any other import/recover/restore/upsert token still trips.
const helperLogic = helperCode
  .replace(/H2O\.Studio\.archive(MaterializerAction|Inspector|Importer)\b/g, 'H2O.Studio.siblingModule')
  .replace(/H2O\.Studio\.recoveryCenterUi\b/g, 'H2O.Studio.siblingModule')
  .replace(/mountArchive(MaterializerAction|Inspector|Importer)Card/g, 'mountSiblingCard')
  .replace(/mountRecoveryCenterCard/g, 'mountSiblingCard')
  .replace(/\b(actionApi|inspectorApi|importerApi|recoveryCenterApi)\b/g, 'siblingApi');

function functionBlock(src, name) {
  const signature = `function ${name}`;
  const idx = src.indexOf(signature);
  assert.ok(idx >= 0, `${signature} missing`);
  const start = src.indexOf('{', idx);
  assert.ok(start >= 0, `${signature} body missing`);
  let depth = 0;
  for (let i = start; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === '{') depth += 1;
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(idx, i + 1);
    }
  }
  throw new Error(`${signature} body did not close`);
}

console.log('[archive-health-ui] static checks');

check('helper module exists and registers the public API', () => {
  assert.ok(fs.existsSync(path.join(REPO_ROOT, HELPER_REL)));
  assert.match(helperSrc, /H2O\.Studio\.archiveHealthUi/);
  assert.match(helperSrc, /renderArchiveHealthCard/);
  assert.match(helperSrc, /formatArchiveHealthSummary/);
  assert.match(helperSrc, /formatArchiveHealthSections/);
  assert.match(helperSrc, /renderArchiveHealthCounts/);
  assert.match(helperSrc, /formatPackageDetailsRows/);
  assert.match(helperSrc, /renderPackageDetails/);
  assert.match(helperSrc, /summarizePackageDbChecks/);
  assert.match(helperSrc, /summarizePackageAssetChecks/);
  assert.match(helperSrc, /copyArchiveHealthReport/);
});

check('helper renders the Run diagnostics button, Copy report JSON button, and status texts', () => {
  assert.ok(helperSrc.includes('Run diagnostics'));
  assert.ok(helperSrc.includes('Copy report JSON'));
  assert.ok(helperSrc.includes('Report JSON copied.'));
  assert.ok(helperSrc.includes('Could not copy report JSON.'));
  assert.ok(helperSrc.includes('Saved Chat Archive Health'));
  for (const t of [
    'Run diagnostics to check saved chat package health.',
    'Reading saved chat archive diagnostics…',
    'Archive diagnostics are available in Desktop Studio only.',
    'No saved chat packages found yet.',
    'Archive diagnostics completed.',
    'Archive diagnostics completed with warnings. Saved packages may still be portable.',
    'Archive diagnostics found package integrity problems.',
    'Could not run archive diagnostics.',
  ]) assert.ok(helperSrc.includes(t), `missing copy: ${t}`);
});

check('helper implements all six status-shell states', () => {
  for (const s of ['idle', 'loading', 'unavailable', 'empty', 'ready', 'error']) {
    assert.ok(new RegExp("'" + s + "'").test(helperSrc), `state literal missing: ${s}`);
  }
  for (const s of ['copyStatus', 'copied']) {
    assert.ok(helperSrc.includes(s), `copy state missing: ${s}`);
  }
  for (const s of ['detailsExpanded', 'visibleLimit']) {
    assert.ok(helperSrc.includes(s), `details state missing: ${s}`);
  }
});

check('helper is read-only: no mutation/repair/import/sync/CAS/DB-write/package-write', () => {
  // Scan comment-stripped CODE with sibling-mount delegation identifiers neutralized
  // (the header prose + the sibling module names legitimately mention the non-goals).
  for (const banned of [
    'repair', 'recover', 'import', 'delete', 'remove(', 'overwrite', 'restore', 'rebuild',
    'writeSavedChatPackageV1', 'putAssetBytes', 'getAssetBytes',
    'plugin:fs|write', 'plugin:sql', 'upsert', 'linkToTurn',
    'H2O.Studio.sync', 'webdav', 'chrome.',
  ]) {
    assert.ok(!helperLogic.includes(banned), `forbidden token in helper code: ${banned}`);
  }
});

check('helper has C6.2 summary count labels and separates integrity from drift', () => {
  for (const label of [
    'packagesTotal', 'packagesOk', 'packagesWarning', 'packagesBlocked', 'v1', 'v2',
    'missingLiveCasAssets', 'missingDbChats', 'missingDbSnapshots', 'orphanedPackages', 'stalePackages', 'storeAssetMismatches',
    'dbChecks passed', 'dbChecks warnings', 'dbChecks failed',
    /* M10 P3: renderer hygiene is surfaced, explicitly unavailable. */
    'rendererHygiene',
  ]) {
    assert.ok(helperSrc.includes(label), `summary label missing: ${label}`);
  }
  assert.ok(helperSrc.includes('Integrity'), 'integrity section missing');
  assert.ok(
    helperSrc.includes('Blocked packages failed trusted verification.'),
    'integrity section must explain that severity comes from trusted verification',
  );
  assert.ok(helperSrc.includes('Drift / informational warnings'), 'drift section missing');
  assert.ok(helperSrc.includes('Drift does not automatically mean a saved package is broken'), 'drift explanation missing');
  assert.ok(helperSrc.includes('grid-template-columns:repeat(auto-fit,minmax(150px,1fr))'), 'compact counts grid missing');
});

check('helper copy path uses safe clipboard and does not create/download/save files', () => {
  assert.ok(helperSrc.includes('navigator'));
  assert.ok(helperSrc.includes('clipboard.writeText'));
  assert.ok(helperSrc.includes('JSON.stringify(result, null, 2)'));
  for (const banned of ["createElement('a'", 'createElement("a"', '.download', 'showSaveFilePicker', 'createObjectURL', 'writeSavedChatPackageV1']) {
    assert.ok(!helperCode.includes(banned), `forbidden copy/download behavior: ${banned}`);
  }
});

check('helper has C6.3 read-only package details list, toggle, labels, and cap', () => {
  assert.ok(helperSrc.includes('Package details'), 'Package details title missing');
  assert.ok(helperSrc.includes('Show package details'), 'show details toggle missing');
  assert.ok(helperSrc.includes('Hide package details'), 'hide details toggle missing');
  assert.ok(helperSrc.includes('data-archive-health-package-details'), 'package details section marker missing');
  assert.ok(helperSrc.includes('data-archive-health-package-list'), 'package details list marker missing');
  assert.ok(helperSrc.includes('Showing '), 'Showing N of M packages behavior missing');
  assert.ok(helperSrc.includes('visibleLimit: 50'), 'visible package cap missing');
  assert.ok(helperSrc.includes('user-select:text'), 'package path should be selectable/copyable text');
  assert.ok(!helperCode.includes('<table'), 'package details should not add a table surface');
  assert.ok(helperSrc.includes('Blockers mean package integrity problems.'), 'blocker wording missing');
  assert.ok(helperSrc.includes('Warnings usually mean DB/CAS drift. The saved package may still be portable.'), 'calm warning wording missing');
  for (const label of [
    'packagePath', 'schemaVersion', 'status', 'chatId', 'snapshotId',
    'blockers', 'warnings',
    'chatExists', 'snapshotExists', 'packageIsLatest', 'storeAssetCount',
    'manifestAssetCount', 'packageAssetCount', 'missingPackageAssets',
    'missingLiveCasAssets', 'dataImageResidue', 'assetRefMismatches',
  ]) {
    assert.ok(helperSrc.includes(label), `package details label missing: ${label}`);
  }
});

check('helper has no package action buttons or action labels', () => {
  for (const deferred of ['Repair', 'Fix', 'Import', 'Recovery', 'Delete', 'Overwrite', 'Open package', 'Restore', 'Rebuild', 'Sync now']) {
    assert.ok(!helperLogic.includes(deferred), `forbidden package action leaked into helper: ${deferred}`);
  }
});

check('studio.js Settings adds the read-only archive health card container + title', () => {
  const cardHtml = functionBlock(studioJs, 'settingsArchiveHealthCardHtml');
  assert.ok(cardHtml.includes('wbSettingsArchiveHealthBox'), 'container id missing from archive card HTML helper');
  assert.ok(cardHtml.includes('Saved Chat Archive Health'), 'section title missing from archive card HTML helper');
  assert.ok(cardHtml.includes('data-settings-archive-health-section'), 'archive card section marker missing');
});

check('studio.js mounts the card in the active Diagnostics / Storage settings branch', () => {
  const topLevel = functionBlock(studioJs, 'settingsTopLevelContentHtml');
  const diagnosticsIdx = topLevel.indexOf('section === "diagnostics"');
  assert.ok(diagnosticsIdx >= 0, 'diagnostics branch missing from active Settings renderer');
  const libraryIdx = topLevel.indexOf('section === "library"', diagnosticsIdx);
  assert.ok(libraryIdx > diagnosticsIdx, 'diagnostics branch boundary missing');
  const diagnosticsBranch = topLevel.slice(diagnosticsIdx, libraryIdx);
  assert.ok(diagnosticsBranch.includes('settingsStorageDiagnosticsHtml(meta, cardStyle)'), 'active diagnostics branch missing storage diagnostics');
  assert.ok(diagnosticsBranch.includes('settingsArchiveHealthCardHtml(cardStyle)'), 'active diagnostics branch does not render archive health card');
  assert.ok(diagnosticsBranch.includes('settingsFolderOperatorModeDiagnosticsHtml(cardStyle, btnStyle)'), 'active diagnostics branch should preserve folder operator diagnostics');
  assert.ok(diagnosticsBranch.indexOf('settingsStorageDiagnosticsHtml(meta, cardStyle)') < diagnosticsBranch.indexOf('settingsArchiveHealthCardHtml(cardStyle)'), 'archive health should render inside diagnostics branch after storage diagnostics');
});

check('studio.js wiring calls only the read-only diagnostic API with the C5.4A options', () => {
  const block = functionBlock(studioJs, 'mountSettingsArchiveHealthCard');
  assert.ok(block.includes('renderArchiveHealthCard'), 'wiring does not call the helper');
  assert.ok(block.includes('diagnoseSavedChatArchiveV1'), 'wiring does not call diagnoseSavedChatArchiveV1');
  assert.ok(block.includes('archiveHealthMounted'), 'mount guard missing');
  for (const k of ['includeCasChecks', 'includeRendererChecks', 'includeDbChecks']) {
    assert.ok(block.includes(k), `diagnose options missing ${k}`);
  }
  // the wiring block (comment-stripped) must not perform any mutation/repair
  const blockCode = stripComments(block);
  for (const banned of ['repair', 'writeSavedChatPackageV1', 'putAssetBytes', 'upsert', 'delete', 'overwrite', 'import']) {
    assert.ok(!blockCode.includes(banned), `forbidden token in archive-health wiring: ${banned}`);
  }
});

check('studio.js post-render wiring runs for the same active Diagnostics branch that renders the container', () => {
  const shell = functionBlock(studioJs, 'renderSettingsSectionShell');
  assert.ok(shell.includes('settingsTopLevelContentHtml(key, cardStyle, btnStyle, extensionMeta)'), 'active settings shell must render top-level content');
  assert.ok(shell.includes('if (key === "diagnostics") mountSettingsArchiveHealthCard(panel);'), 'active diagnostics branch does not mount archive health after render');
  assert.ok(shell.indexOf('settingsTopLevelContentHtml(key, cardStyle, btnStyle, extensionMeta)') < shell.indexOf('mountSettingsArchiveHealthCard(panel)'), 'mount should happen after active branch markup is rendered');

  const route = functionBlock(studioJs, 'renderSettingsTopLevelRoute');
  assert.ok(route.includes('if (section === "diagnostics") mountSettingsArchiveHealthCard(panel);'), 'same-route diagnostics refresh path does not mount archive health');
});

check('helper is loaded in studio.html and packed', () => {
  assert.ok(studioHtml.includes('./ingestion/archive-health-ui.studio.js'), 'studio.html missing helper script');
  const count = (pack.match(/ingestion\/archive-health-ui\.studio\.js/g) || []).length;
  assert.ok(count >= 2, `expected source + mirror pack entries, got ${count}`);
});

console.log('[archive-health-ui] behavioral checks (pure formatArchiveHealthSummary)');

function loadHelper(extra) {
  const context = Object.assign({ console }, extra || {});
  context.globalThis = context; // no window, no document → renderArchiveHealthCard must no-op safely
  const sandbox = vm.createContext(context);
  vm.runInContext(helperSrc, sandbox, { filename: HELPER_REL });
  const api = sandbox.H2O?.Studio?.archiveHealthUi;
  if (!api) throw new Error('archiveHealthUi did not register');
  return api;
}

check('formatArchiveHealthSummary maps statuses without scary warning wording', () => {
  const api = loadHelper();

  const ok = api.formatArchiveHealthSummary({ status: 'ok' });
  assert.equal(ok.state, 'ready');
  assert.equal(ok.pill.tone, 'ok');
  assert.equal(ok.headline, 'Archive diagnostics completed.');

  const warn = api.formatArchiveHealthSummary({ status: 'warning' });
  assert.equal(warn.state, 'ready');
  assert.equal(warn.pill.tone, 'warn');
  assert.match(warn.headline, /may still be portable/);
  assert.match(warn.explanation, /drift/i);
  assert.match(warn.explanation, /portable|valid/i);
  assert.doesNotMatch(warn.headline + ' ' + warn.explanation, /corrupt|broken|integrity problem/i);

  const partial = api.formatArchiveHealthSummary({ status: 'partial' });
  assert.equal(partial.pill.tone, 'block');

  const blocked = api.formatArchiveHealthSummary({ status: 'blocked' });
  assert.equal(blocked.pill.tone, 'block');
  assert.match(blocked.headline, /integrity problems/i);

  const empty = api.formatArchiveHealthSummary({ status: 'empty' });
  assert.equal(empty.state, 'empty');
  assert.match(empty.headline, /No saved chat packages/i);

  // null / unknown must not throw
  const none = api.formatArchiveHealthSummary(null);
  assert.ok(none && typeof none.headline === 'string');
});

check('formatArchiveHealthSections returns the four C6.2 count sections', () => {
  const api = loadHelper();
  const sections = api.formatArchiveHealthSections({
    counts: {
      packagesTotal: 9,
      packagesOk: 8,
      packagesWarning: 1,
      packagesBlocked: 0,
      v1: 2,
      v2: 7,
      brokenPackageAssets: 0,
      assetRefMismatches: 0,
      dataImageResidue: 0,
      missingLiveCasAssets: 1,
      missingDbChats: 0,
      missingDbSnapshots: 0,
      orphanedPackages: 0,
      stalePackages: 1,
      storeAssetMismatches: 0,
    },
    dbChecks: { passed: 8, warnings: 1, failed: 0 },
  });
  assert.equal(JSON.stringify(sections.map((section) => section.key)), JSON.stringify(['archive-health', 'integrity', 'drift', 'db-checks']));
  const html = api.renderArchiveHealthCounts(sections);
  assert.match(html, /data-archive-health-counts/);
  assert.match(html, /packagesTotal/);
  assert.match(html, /missingLiveCasAssets/);
  assert.match(html, /dbChecks\.passed/);
  assert.match(html, /repeat\(auto-fit,minmax\(150px,1fr\)\)/);

  /* M10 P3 metric correction. The canonical verifier is fail-fast, so an exact
     broken-asset total does not exist, and the old mismatch count conflated
     package integrity with renderer hygiene. Both are RETIRED rather than
     rendered as a measured-looking zero. */
  for (const retired of ['brokenPackageAssets', 'assetRefMismatches']) {
    assert.ok(!html.includes(retired), `retired metric must not be presented: ${retired}`);
  }
  /* The Integrity card claims only what trusted verification supplies. */
  const integrity = sections.find((section) => section.key === 'integrity');
  assert.equal(JSON.stringify(integrity.counts.map((c) => c.key)), JSON.stringify(['packagesBlocked']),
    'the Integrity card presents only the trusted blocked count');

  /* UNAVAILABLE IS NOT ZERO. Renderer hygiene is not observed in P3, so it must
     render as the explicit unavailable label and must sit on the DRIFT side,
     never in the integrity severity area. */
  const drift = sections.find((section) => section.key === 'drift');
  const hygiene = drift.counts.find((c) => c.key === 'rendererHygiene');
  assert.ok(hygiene, 'renderer hygiene is presented on the drift side');
  assert.equal(hygiene.available, false, 'declared unavailable');
  assert.equal(hygiene.value, null, 'no synthetic numeric value');
  assert.match(html, /data-archive-health-count="rendererHygiene"[\s\S]{0,200}>n\/a</,
    'renderer hygiene renders as n/a, never 0');
  assert.ok(
    !integrity.counts.some((c) => c.key === 'rendererHygiene' || c.key === 'dataImageResidue'),
    'renderer hygiene must not appear as integrity severity',
  );
  /* And no clean-sounding claim is made about something nothing measured. */
  for (const forbidden of ['no residue', '0 issues', 'clean', 'verified', 'passed']) {
    assert.ok(!String(drift.note).toLowerCase().includes(forbidden), `hygiene copy must not claim: ${forbidden}`);
  }

  /* A MEASURED zero still renders 0 — the distinction is the whole point. */
  assert.match(html, /data-archive-health-count="packagesBlocked"[\s\S]{0,200}>0</,
    'a measured zero is still shown as 0');
  assert.match(html, /data-archive-health-count="missingDbChats"[\s\S]{0,200}>0</);
});

check('M10 P3: unavailable per-package metrics render n/a, measured ones still render', () => {
  const api = loadHelper();
  /* Trusted path: the legacy renderer buckets are absent, not empty. */
  const trusted = api.formatPackageDetailsRows({
    packages: [{
      packagePath: 'archive/packages/a.h2ochat', status: 'ok', chatId: 'c', snapshotId: 's',
      blockers: [], warnings: [],
      assetChecks: { manifestAssetCount: 0, packageAssetCount: 0, missingPackageAssets: [], missingLiveCasAssets: [] },
      dbChecks: {},
    }],
  })[0];
  assert.equal(trusted.assetChecks.dataImageResidue, null, 'unobserved, not zero');
  assert.equal(trusted.assetChecks.assetRefMismatches, null, 'unobserved, not zero');
  assert.equal(trusted.assetChecks.missingPackageAssets, 0, 'a measured empty list is still 0');

  /* Legacy helper output still carries real arrays; those must keep counting. */
  const legacy = api.formatPackageDetailsRows({
    packages: [{
      packagePath: 'archive/packages/b.h2ochat', status: 'blocked', chatId: 'c', snapshotId: 's',
      blockers: [], warnings: [],
      assetChecks: { dataImageResidue: [{ x: 1 }, { x: 2 }], assetRefMismatches: [{ y: 1 }] },
      dbChecks: {},
    }],
  })[0];
  assert.equal(legacy.assetChecks.dataImageResidue, 2, 'a measured list still counts');
  assert.equal(legacy.assetChecks.assetRefMismatches, 1);

  const html = api.renderPackageDetails({ packages: [{
    packagePath: 'archive/packages/a.h2ochat', status: 'blocked', chatId: 'c', snapshotId: 's',
    blockers: [{ code: 'generation-v3-gzip-decode-failed', message: 'The compressed snapshot could not be decoded.' }],
    warnings: [], assetChecks: {}, dbChecks: {},
  }] }, { detailsExpanded: true });
  const residueCell = html.slice(html.indexOf('data-archive-health-detail-field="dataImageResidue"'));
  const residueValue = residueCell.slice(0, residueCell.indexOf('</span></span>'));
  assert.ok(residueValue.includes('n/a'), 'unavailable renders n/a');
  assert.ok(!/>0</.test(residueValue), 'and never as a measured zero');
  /* §10: the trusted blocker explanation stays visible and authoritative. */
  assert.ok(html.includes('generation-v3-gzip-decode-failed'), 'trusted blocker code visible');
  assert.ok(html.includes('The compressed snapshot could not be decoded.'), 'explanation visible');
});

check('formatPackageDetailsRows sorts by severity and summarizes DB/asset checks defensively', () => {
  const api = loadHelper();
  const rows = api.formatPackageDetailsRows({
    packages: [
      {
        packagePath: 'archive/packages/ok.h2ochat',
        schemaVersion: 2,
        status: 'ok',
        chatId: 'chat-ok',
        snapshotId: 'snap-ok',
        warnings: [],
        blockers: [],
        dbChecks: { chatExists: true, snapshotExists: true, packageIsLatest: true, storeAssetCount: 1 },
        assetChecks: {
          manifestAssetCount: 1,
          packageAssetCount: 1,
          missingPackageAssets: [],
          missingLiveCasAssets: [],
          dataImageResidue: [],
          assetRefMismatches: [],
        },
      },
      {
        packagePath: 'archive/packages/blocked.h2ochat',
        schemaVersion: 2,
        status: 'blocked',
        chatId: 'chat-blocked',
        snapshotId: 'snap-blocked',
        warnings: [{ code: 'warn' }],
        blockers: [{ code: 'broken' }],
        dbChecks: { chatExists: false, snapshotExists: false, packageIsLatest: false, storeAssetCount: 0 },
        assetChecks: {
          manifestAssetCount: 2,
          packageAssetCount: 1,
          missingPackageAssets: [{ sha256: 'sha256-a' }],
          missingLiveCasAssets: [{ sha256: 'sha256-b' }],
          dataImageResidue: [{ path: 'chat.html' }],
          assetRefMismatches: [{ sha256: 'sha256-c' }],
        },
      },
      {
        packagePath: 'archive/packages/warn.h2ochat',
        schemaVersion: 1,
        status: 'warning',
        chatId: 'chat-warning',
        snapshotId: 'snap-warning',
        warnings: [{ code: 'drift' }],
        blockers: [],
      },
    ],
  });
  assert.equal(rows.length, 3);
  assert.equal(rows[0].status, 'blocked');
  assert.equal(rows[1].status, 'warning');
  assert.equal(rows[2].status, 'ok');
  assert.equal(rows[0].blockersCount, 1);
  assert.equal(rows[0].warningsCount, 1);
  assert.equal(rows[0].dbChecks.chatExists, false);
  assert.equal(rows[0].dbChecks.snapshotExists, false);
  assert.equal(rows[0].dbChecks.packageIsLatest, false);
  assert.equal(rows[0].dbChecks.storeAssetCount, 0);
  assert.equal(rows[0].assetChecks.manifestAssetCount, 2);
  assert.equal(rows[0].assetChecks.packageAssetCount, 1);
  assert.equal(rows[0].assetChecks.missingPackageAssets, 1);
  assert.equal(rows[0].assetChecks.missingLiveCasAssets, 1);
  assert.equal(rows[0].assetChecks.dataImageResidue, 1);
  assert.equal(rows[0].assetChecks.assetRefMismatches, 1);
});

check('renderPackageDetails is collapsed by default and expands capped read-only rows', () => {
  const api = loadHelper();
  const result = {
    packages: Array.from({ length: 55 }, (_, i) => ({
      packagePath: `archive/packages/pkg-${i}.h2ochat`,
      schemaVersion: i % 2 ? 1 : 2,
      status: i === 0 ? 'blocked' : i === 1 ? 'warning' : 'ok',
      chatId: `chat-${i}`,
      snapshotId: `snap-${i}`,
      warnings: i === 1 ? [{ code: 'drift' }] : [],
      blockers: i === 0 ? [{ code: 'broken' }] : [],
      dbChecks: { chatExists: true, snapshotExists: true, packageIsLatest: true, storeAssetCount: i },
      assetChecks: { manifestAssetCount: 0, packageAssetCount: 0 },
    })),
  };
  const collapsed = api.renderPackageDetails(result, { detailsExpanded: false, visibleLimit: 50 });
  assert.match(collapsed, /Package details/);
  assert.match(collapsed, /Show package details/);
  assert.doesNotMatch(collapsed, /data-archive-health-package-row/);

  const expanded = api.renderPackageDetails(result, { detailsExpanded: true, visibleLimit: 50 });
  assert.match(expanded, /Hide package details/);
  assert.match(expanded, /Showing 50 of 55 packages/);
  assert.match(expanded, /data-archive-health-package-row/);
  for (const label of ['packagePath', 'schemaVersion', 'status', 'chatId', 'snapshotId', 'chatExists', 'snapshotExists', 'packageIsLatest', 'storeAssetCount', 'manifestAssetCount', 'packageAssetCount', 'missingPackageAssets', 'missingLiveCasAssets', 'dataImageResidue', 'assetRefMismatches']) {
    assert.match(expanded, new RegExp(label.replace('.', '\\\\.')));
  }
});

await checkAsync('copyArchiveHealthReport pretty-prints JSON via navigator.clipboard.writeText and fails softly', async () => {
  let copied = '';
  const api = loadHelper({
    navigator: {
      clipboard: {
        writeText: async (text) => { copied = text; },
      },
    },
  });
  const ok = await api.copyArchiveHealthReport({ status: 'ok', counts: { packagesTotal: 1 } });
  assert.equal(ok.ok, true);
  assert.equal(ok.message, 'Report JSON copied.');
  assert.match(copied, /"packagesTotal": 1/);

  const noClipboardApi = loadHelper();
  const failed = await noClipboardApi.copyArchiveHealthReport({ status: 'ok' });
  assert.equal(failed.ok, false);
  assert.equal(failed.message, 'Could not copy report JSON.');
});

check('renderArchiveHealthCard is safe when no DOM is present (no crash, returns null)', () => {
  const api = loadHelper();
  assert.equal(typeof api.renderArchiveHealthCard, 'function');
  const out = api.renderArchiveHealthCard({}, { diagnose: async () => ({ status: 'ok' }) });
  assert.equal(out, null, 'must no-op without a document');
});

/* ── M06 T2.4 — New UI storage/reclamation overview, Analyze only ───────── */

const RECLAIM_REL = 'src-surfaces-base/studio/ingestion/saved-chat-reclamation-ui.studio.js';
const reclaimSrc = readRepo(RECLAIM_REL);
const reclaimCode = stripComments(reclaimSrc);

function loadReclamationApi(documentStub) {
  const global = { window: undefined, document: documentStub };
  global.window = global;
  const context = vm.createContext(global);
  vm.runInContext(reclaimSrc, context, { filename: RECLAIM_REL });
  return context.H2O.Studio.reclamationUi;
}

/* A minimal DOM stub: elements record textContent and children, and nothing
   can execute. Any markup that survived escaping would be visible as text. */
function domStub() {
  const created = [];
  function make(tag) {
    const node = {
      tagName: String(tag).toUpperCase(),
      _text: '',
      children: [],
      attrs: {},
      style: {},
      parentNode: null,
      disabled: false,
      listeners: {},
      set textContent(value) {
        this._text = String(value == null ? '' : value);
        this.children.forEach((child) => { child.parentNode = null; });
        this.children = [];
      },
      get textContent() { return this._text; },
      appendChild(child) { child.parentNode = this; this.children.push(child); return child; },
      setAttribute(k, v) { this.attrs[k] = v; },
      getAttribute(k) { return this.attrs[k]; },
      addEventListener(name, fn) { this.listeners[name] = fn; },
      querySelector(selector) {
        const match = /^\[([^=]+)="([^"]+)"\]$/.exec(selector);
        if (!match) return null;
        const visit = (parent) => {
          for (const child of parent.children || []) {
            if (String(child.attrs?.[match[1]] || '') === match[2]) return child;
            const nested = visit(child);
            if (nested) return nested;
          }
          return null;
        };
        return visit(this);
      },
    };
    created.push(node);
    return node;
  }
  return { document: { createElement: make }, created };
}

function flatten(node, out = []) {
  out.push(node);
  (node.children || []).forEach((c) => flatten(c, out));
  return out;
}
function allText(node) {
  return flatten(node).map((n) => n.textContent || '').join('\n');
}

const PREVIEW_FIXTURE = {
  schema: 'h2o.m06.reclamationPreview',
  schema_version: 1,
  sources: {
    package_scan_complete: true, package_scan_blockers: [],
    db_probe_complete: true, db_probe_blockers: [],
    cas_inventory_complete: true, cas_inventory_blockers: [],
  },
  plan: {
    schema: 'h2o.m06.reclamationPlan', schema_version: 1,
    complete: true, retention_floor: 3, blockers: [],
    totals: { occupants: 3, protected: 2, candidates: 1, excluded: 0, chats_in_scope: 1, referenced_cas_objects: 1 },
    decisions: [
      { path: 'archive/packages/c.g11.h2ochat', name: 'c.g11.h2ochat', chat_id: 'c', content_hash: '11',
        decision: 'protected', reasons: ['stranded-writing', 'import-provenance', 'retention-floor'] },
      { path: 'archive/packages/c.g22.h2ochat', name: 'c.g22.h2ochat', chat_id: 'c', content_hash: '22',
        decision: 'candidate', evidence: { saved_at: '2026-01-01T00:00:00.000Z', family_rank: 4, retention_floor: 3, content_obsolete: true, current_projection_content_hash: '11' } },
      { path: 'archive/packages/c.g33.h2ochat', name: 'c.g33.h2ochat', chat_id: 'c', content_hash: '',
        decision: 'excluded', reason: 'indeterminate' },
    ],
    cas: { complete: true, observed: ['aa', 'bb'], referenced: ['aa'], observed_unreferenced: ['bb'], incomplete_reasons: [] },
  },
};

const DIAGNOSTICS_FIXTURE = {
  packages: [{ chatId: 'c' }, { chatId: 'c' }],
  residue: {
    complete: true, count: 2,
    entries: [
      { name: '.h2o-genstage-00ff01', path: 'archive/packages/.h2o-genstage-00ff01', kind: 'generation-staging' },
      { name: '.h2o-durable-7-0.tmp', path: 'archive/assets/ab/.h2o-durable-7-0.tmp', kind: 'durable-temp' },
    ],
    unscanned: [],
  },
};

check('T2.4 New UI only — reclamation module is loaded and packed, no Legacy surface', () => {
  assert.ok(studioHtml.includes('./ingestion/saved-chat-reclamation-ui.studio.js'), 'studio.html must load the module');
  assert.ok(pack.includes('ingestion/saved-chat-reclamation-ui.studio.js'), 'pack-studio must include the module');
  const helperCode = stripComments(helperSrc);
  assert.ok(helperCode.includes('H2O.Studio.reclamationUi'),
    'the New UI health card must resolve the reclamation API in code');
  assert.ok(helperCode.includes('mountReclamationCard(container)'),
    'the New UI health card must actually mount the card');
  const legacyDirs = ['src-surfaces-base/legacy', 'src-runtime-base'];
  for (const dir of legacyDirs) {
    const abs = path.join(REPO_ROOT, dir);
    if (!fs.existsSync(abs)) continue;
    const hits = [];
    (function walk(d) {
      for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.(js|mjs|html)$/.test(entry.name)) {
          const text = fs.readFileSync(full, 'utf8');
          if (text.includes('h2o_archive_reclamation_preview') || text.includes('mountReclamationCard')) hits.push(full);
        }
      }
    })(abs);
    assert.deepEqual(hits, [], `M06 UI must not appear under ${dir}`);
  }
});

/* P4 T4.1: G02 passed, so this card legitimately offers the two approved
   destructive actions. The assertion is not deleted — it is narrowed from
   "no destructive control" to "EXACTLY the approved destructive controls",
   which is the stronger statement now that any exist. */
check('T4.1 exactly the two G02-approved actions exist — nothing else', () => {
  /* The SET of actions is the safety property; their order in the file is not. */
  const actions = [...reclaimCode.matchAll(/data-h2o-action', '([^']+)'/g)]
    .map((m) => m[1])
    .sort();
  assert.deepEqual(
    actions,
    ['analyze-archive', 'quarantine-occupant', 'reclaim-archive'],
    'exactly Analyze, Reclaim and the governed occupant remedy',
  );
  /* Only the two approved commands are invocable from this surface. */
  const commands = [...reclaimCode.matchAll(/'(h2o_archive_[a-z_]+)'/g)].map((m) => m[1]).sort();
  assert.deepEqual(
    [...new Set(commands)],
    [
      'h2o_archive_occupant_quarantine',
      'h2o_archive_reclamation_execute',
      'h2o_archive_reclamation_preview',
    ],
    'no third command is reachable from the New UI',
  );
  /* Still absent: raw purge, stale recovery and every CAS destructive verb. */
  for (const forbidden of [
    'h2o_archive_purge', 'h2o_archive_delete', 'h2o_archive_recover',
    'h2o_archive_stale', 'h2o_archive_collect', 'h2o_archive_cas',
    'purge_run', 'purge_all', 'purge_quarantined_item',
    'casCollect', 'cas_collect', 'collectible',
  ]) {
    assert.ok(!reclaimCode.includes(forbidden), `no destructive surface: ${forbidden}`);
  }
  assert.equal((reclaimCode.match(/createElement\('button'\)/g) || []).length, 0, 'buttons are created through the helper only');
  assert.equal((reclaimCode.match(/el\('button'/g) || []).length, 3, 'exactly three buttons exist');
});

check('T2.4 no automatic Analyze — no mount call, timer, interval or polling', () => {
  for (const forbidden of ['setInterval', 'setTimeout', 'requestIdleCallback', 'requestAnimationFrame', 'DOMContentLoaded']) {
    assert.ok(!reclaimCode.includes(forbidden), `no background scheduling: ${forbidden}`);
  }
  /* analyze() must be reachable only from the click listener and the returned API. */
  assert.ok(reclaimCode.includes("button.addEventListener('click'"), 'analyze is click-driven');
  const mountBody = reclaimCode.slice(reclaimCode.indexOf('function mountReclamationCard'));
  const beforeListener = mountBody
    .slice(0, mountBody.indexOf('addEventListener'))
    /* drop the declaration itself; only a CALL during mount is the hazard */
    .replace(/async function analyze\(\)/g, 'async function __decl__');
  assert.ok(!/\banalyze\(\)/.test(beforeListener), 'analyze must not be CALLED during mount');
});

check('T2.4 no second projection/contentHash/retention implementation', () => {
  for (const forbidden of ['sha256', 'Sha256', 'digest', 'contentHash =', 'K =', 'retentionFloor =', 'buildSavedChatPackage']) {
    assert.ok(!reclaimCode.includes(forbidden), `must not reimplement: ${forbidden}`);
  }
  assert.ok(reclaimCode.includes('probeCurrentSavedChatProjectionV1'), 'must reuse the existing projection producer');
  assert.ok(reclaimCode.includes('diagnoseSavedChatArchiveV1'), 'must reuse the composed T1.3 diagnostics');
  assert.ok(reclaimCode.includes("'h2o_archive_reclamation_preview'"), 'must call the trusted Preview command');
});

check('T2.4 no truncation, no persistence, no unsanitized markup', () => {
  for (const forbidden of ['.slice(0, 500', 'slice(0,500', '.slice(0, 10000', 'limit: 500', 'localStorage', 'sessionStorage', 'innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write']) {
    assert.ok(!reclaimCode.includes(forbidden), `forbidden: ${forbidden}`);
  }
  assert.ok(reclaimCode.includes('textContent'), 'returned data is rendered as text');
});

check('T4.1 every request contract carries no path, floor, force or candidate', () => {
  /* Preview AND the two activated commands, checked the same way. */
  for (const site of ['invoke(PREVIEW_COMMAND', 'invoke(EXECUTE_COMMAND', 'invoke(OCCUPANT_COMMAND']) {
    const at = reclaimCode.indexOf(site);
    assert.ok(at > 0, `${site} is invoked`);
    const req = reclaimCode.slice(at, at + 220).toLowerCase();
    for (const forbidden of ['path', 'root', 'floor', 'force', 'k:', 'retention', 'candidate', 'run_id', 'runid']) {
      assert.ok(!req.includes(forbidden), `${site} must not carry ${forbidden}`);
    }
  }
  /* Execute resends the SAME enabling request Analyze used — never the plan. */
  const exec = reclaimCode.slice(reclaimCode.indexOf('async function execute()'));
  assert.ok(exec.includes('var request = enablingRequest;'), 'execute reuses the enabling request');
  assert.ok(!/decisions|plan\.|preview\.plan/.test(exec.slice(0, exec.indexOf('invoke(EXECUTE_COMMAND'))),
    'no part of the analysis plan is sent as authority');
});

check('T2.4 overview model is derived only from the trusted Preview', () => {
  const api = loadReclamationApi(domStub().document);
  const o = api.formatPreviewOverview(PREVIEW_FIXTURE);
  assert.equal(o.schema, 'h2o.m06.reclamationPreview');
  assert.equal(o.complete, true);
  assert.equal(o.state, 'eligible');
  assert.equal(o.retentionFloor, 3);
  assert.equal(o.totals.candidates, 1);
  assert.equal(o.totals.protected, 2);
  assert.equal(o.cas.observedUnreferenced.length, 1);

  /* Blockers must make an INCOMPLETE analysis visibly different from a
     complete zero-candidate one. */
  const blocked = JSON.parse(JSON.stringify(PREVIEW_FIXTURE));
  blocked.plan.complete = false;
  blocked.plan.blockers = ['plan-package-scan-incomplete'];
  blocked.plan.totals.candidates = 0;
  blocked.sources.package_scan_complete = false;
  const b = api.formatPreviewOverview(blocked);
  assert.equal(b.state, 'incomplete');
  assert.notEqual(b.state, 'clean', 'incomplete must not read as clean');
  assert.deepEqual(b.blockers, ['plan-package-scan-incomplete']);

  const clean = JSON.parse(JSON.stringify(PREVIEW_FIXTURE));
  clean.plan.totals.candidates = 0;
  assert.equal(api.formatPreviewOverview(clean).state, 'clean');
});

check('T2.4 every protection reason survives presentation', () => {
  const api = loadReclamationApi(domStub().document);
  const rows = api.formatDecisionRows(PREVIEW_FIXTURE);
  const protectedRow = rows.find((r) => r.decision === 'protected');
  assert.deepEqual(protectedRow.reasons, ['stranded-writing', 'import-provenance', 'retention-floor']);
  assert.equal(rows.find((r) => r.decision === 'candidate').savedAt, '2026-01-01T00:00:00.000Z');
  assert.equal(rows.find((r) => r.decision === 'excluded').exclusionReason, 'indeterminate');
  /* Deterministic ordering by trusted identity. */
  assert.deepEqual(rows.map((r) => r.path), rows.map((r) => r.path).slice().sort());
});

check('T2.4 residue uses the COMPLETE T1.3 authority, not durable-temp alone', () => {
  const api = loadReclamationApi(domStub().document);
  const r = api.formatResidueOverview(DIAGNOSTICS_FIXTURE);
  assert.equal(r.count, 2, 'both residue families are counted');
  assert.equal(r.kinds['generation-staging'], 1, 'generation staging residue present');
  assert.equal(r.kinds['durable-temp'], 1, 'durable-temp residue present');
  assert.deepEqual(r.entries.map((e) => e.path).sort(), [
    'archive/assets/ab/.h2o-durable-7-0.tmp',
    'archive/packages/.h2o-genstage-00ff01',
  ], 'exact archive-relative paths are preserved');
  /* The durable-temp command alone must never be treated as the residue total. */
  assert.ok(!reclaimCode.includes('h2o_archive_durable_temp_residue'),
    'the card must not call the durable-temp probe as its residue authority');

  const partial = JSON.parse(JSON.stringify(DIAGNOSTICS_FIXTURE));
  partial.residue.complete = false;
  partial.residue.count = 0;
  partial.residue.entries = [];
  partial.residue.unscanned = [{ root: 'archive/assets', family: '.h2o-durable-*.tmp', reason: 'probe-failed' }];
  const p = api.formatResidueOverview(partial);
  assert.equal(p.complete, false, 'incomplete residue cannot read as an authoritative zero');
  assert.equal(p.unscanned.length, 1);
});

await checkAsync('T2.4 one Analyze click = one Preview invocation, none on mount', async () => {
  const stub = domStub();
  const api = loadReclamationApi(stub.document);
  const calls = [];
  const container = stub.document.createElement('div');
  const handle = api.mountReclamationCard(container, {
    diagnose: async () => DIAGNOSTICS_FIXTURE,
    probeProjection: async () => ({ status: 'ok', contentHash: 'a'.repeat(64) }),
    invoke: async (cmd, args) => { calls.push({ cmd, args }); return PREVIEW_FIXTURE; },
  });
  assert.equal(calls.length, 0, 'mounting must not invoke Preview');

  await handle.analyze();
  assert.equal(calls.length, 1, 'exactly one invocation per Analyze');
  assert.equal(calls[0].cmd, 'h2o_archive_reclamation_preview');
  assert.deepEqual(Object.keys(calls[0].args.request), ['projections']);
  assert.equal(calls[0].args.request.projections.length, 1, 'one unique chat, deduplicated');
  assert.equal(handle.getState().state, 'eligible');

  const text = allText(container);
  assert.ok(text.includes('Read-only'), 'the surface states it is read-only');
  /* "Storage & reclamation" is the SUBJECT, and "Nothing is deleted, renamed or
     moved" is the read-only promise — both must be allowed. What must never
     appear is wording that OFFERS or CLAIMS a destructive act. The absence of a
     destructive control itself is pinned structurally above. */
  /* P4: a Reclaim control legitimately renders. What must still never appear
     is wording that CLAIMS a deletion the run did not perform, or that offers
     a CAS reclamation which does not exist. */
  for (const forbidden of [
    /safe to delete/i, /\bcollectible\b/i, /\bdeletable\b/i,
    /were deleted/i, /has been deleted/i, /delete now/i,
    /reclaim cas/i, /purge cas/i, /collect orphan/i,
  ]) {
    assert.ok(!forbidden.test(text), `no dishonest or CAS-destructive offer: ${forbidden}`);
  }
  /* Analyze itself is still read-only, and says so; CAS is still analysis only. */
  assert.ok(/Analyze is read-only/i.test(text), 'Analyze is labelled read-only');
  assert.ok(/Analysis only/i.test(text), 'CAS is labelled analysis only');
  /* Reclaim exists but is NOT armed by mounting or by a failed analysis. */
  assert.equal(handle.canReclaim(), true, 'a complete Analyze arms Reclaim');
});

await checkAsync('M09 P0.2 Archive Health rerender preserves exactly one functional reclamation sibling', async () => {
  const stub = domStub();
  const parent = stub.document.createElement('div');
  const healthContainer = stub.document.createElement('div');
  let healthHtml = '';
  Object.defineProperty(healthContainer, 'innerHTML', {
    configurable: true,
    get() { return healthHtml; },
    set(value) {
      healthHtml = String(value == null ? '' : value);
      this.children.forEach((child) => { child.parentNode = null; });
      this.children = [];
    },
  });
  parent.appendChild(healthContainer);
  const wire = JSON.parse(JSON.stringify(PREVIEW_FIXTURE));
  wire.plan.decisions[2].occupant_remedy = { chat_id: 'c' };
  const calls = [];
  const global = {
    console,
    document: stub.document,
    confirm: () => true,
    __TAURI_INTERNALS__: {
      invoke: async (cmd) => {
        calls.push(cmd);
        if (cmd === 'h2o_archive_occupant_quarantine') {
          return { state: 'quarantined', occupantName: 'c.g33.h2ochat', classification: 'partial', quarantined: true, purged: false, dwell: 'one-run', blockers: [] };
        }
        return wire;
      },
    },
  };
  global.window = global;
  global.globalThis = global;
  const context = vm.createContext(global);
  vm.runInContext(reclaimSrc, context, { filename: RECLAIM_REL });
  context.H2O.Studio.ingestion = {
    diagnoseSavedChatArchiveV1: async () => DIAGNOSTICS_FIXTURE,
    probeCurrentSavedChatProjectionV1: async () => ({ status: 'ok', contentHash: 'a'.repeat(64) }),
  };
  vm.runInContext(helperSrc, context, { filename: HELPER_REL });

  const health = context.H2O.Studio.archiveHealthUi.renderArchiveHealthCard(healthContainer, {
    diagnose: async () => ({ status: 'ok', packages: [] }),
  });
  const cards = () => flatten(parent).filter((node) => node.attrs?.['data-h2o-card'] === 'saved-chat-reclamation');
  assert.equal(cards().length, 1, 'Archive Health mounts exactly one reclamation card');
  assert.equal(healthContainer.children.length, 0, 'reclamation card is not owned by the health render container');
  const analyze = flatten(parent).find((node) => node.attrs?.['data-h2o-action'] === 'analyze-archive');
  assert.ok(analyze && typeof analyze.listeners.click === 'function', 'Analyze control is functional');
  analyze.listeners.click();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(flatten(parent).some((node) => node.attrs?.['data-h2o-action'] === 'quarantine-occupant'),
    'Analyze rendered the governed occupant control');

  /* The REAL Archive Health run() renders loading and result states, clearing
     its own container both times. The sibling must remain outside that exact
     destructive render boundary. */
  health.run();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cards().length, 1, 'Archive Health rerender did not destroy or duplicate the reclamation card');

  const action = flatten(parent).find((node) => node.attrs?.['data-h2o-action'] === 'quarantine-occupant');
  assert.ok(action && typeof action.listeners.click === 'function', 'control remains functional after the real rerender');
  action.listeners.click();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.filter((cmd) => cmd === 'h2o_archive_occupant_quarantine').length, 1,
    'one click invokes the occupant control exactly once');

  context.H2O.Studio.reclamationUi.mountReclamationCard(healthContainer);
  assert.equal(cards().length, 1, 'an explicit remount remains idempotent');
});

await checkAsync('T2.4 in-flight guard: rapid Analyze cannot double-invoke or overwrite', async () => {
  const stub = domStub();
  const api = loadReclamationApi(stub.document);
  let calls = 0;
  let release;
  const gate = new Promise((r) => { release = r; });
  const container = stub.document.createElement('div');
  const handle = api.mountReclamationCard(container, {
    diagnose: async () => { await gate; return DIAGNOSTICS_FIXTURE; },
    probeProjection: async () => ({ status: 'ok', contentHash: 'a'.repeat(64) }),
    invoke: async () => { calls += 1; return PREVIEW_FIXTURE; },
  });
  const first = handle.analyze();
  const second = handle.analyze();
  /* Release BEFORE awaiting: without an in-flight guard both calls would
     proceed and this must fail on the count, not hang. */
  release();
  const [, secondResult] = await Promise.all([first, second]);
  assert.equal(calls, 1, 'only one Preview invocation occurred');
  assert.equal(secondResult, null, 'a second concurrent Analyze is refused');
});

await checkAsync('T2.4 failed projection cannot imply a candidate, and errors stay honest', async () => {
  const stub = domStub();
  const api = loadReclamationApi(stub.document);
  let sent = null;
  const container = stub.document.createElement('div');
  const handle = api.mountReclamationCard(container, {
    diagnose: async () => DIAGNOSTICS_FIXTURE,
    probeProjection: async () => { throw new Error('probe exploded'); },
    invoke: async (_cmd, args) => { sent = args; return { ...PREVIEW_FIXTURE, plan: { ...PREVIEW_FIXTURE.plan, totals: { ...PREVIEW_FIXTURE.plan.totals, candidates: 0 } } }; },
  });
  await handle.analyze();
  assert.equal(sent.request.projections[0].status, 'probe-failed', 'a failed probe is reported honestly');
  assert.notEqual(sent.request.projections[0].status, 'ok', 'never synthesized as ok');
  assert.equal(sent.request.projections[0].contentHash, '', 'no substituted hash');

  /* A command error must not render as an authoritative empty plan. */
  const stub2 = domStub();
  const api2 = loadReclamationApi(stub2.document);
  const container2 = stub2.document.createElement('div');
  const handle2 = api2.mountReclamationCard(container2, {
    diagnose: async () => DIAGNOSTICS_FIXTURE,
    probeProjection: async () => ({ status: 'ok', contentHash: 'a'.repeat(64) }),
    invoke: async () => { throw new Error('preview-request-too-large'); },
  });
  await handle2.analyze();
  assert.equal(handle2.getState().state, 'error');
  const text = allText(container2);
  assert.ok(text.includes('preview-request-too-large'), 'the exact refusal is surfaced');
  assert.ok(!/Nothing is currently eligible/.test(text), 'an error must not look like a clean result');
});

await checkAsync('T2.4 returned strings render as text, never markup', async () => {
  const stub = domStub();
  const api = loadReclamationApi(stub.document);
  const hostile = '<img src=x onerror="alert(1)">';
  const evil = JSON.parse(JSON.stringify(PREVIEW_FIXTURE));
  evil.plan.blockers = [hostile];
  evil.plan.complete = false;
  evil.plan.decisions[0].path = hostile;
  const container = stub.document.createElement('div');
  const handle = api.mountReclamationCard(container, {
    diagnose: async () => ({ packages: [{ chatId: 'c' }], residue: { complete: true, count: 1, entries: [{ path: hostile, name: hostile, kind: 'generation-staging' }], unscanned: [] } }),
    probeProjection: async () => ({ status: 'ok', contentHash: 'a'.repeat(64) }),
    invoke: async () => evil,
  });
  await handle.analyze();
  const nodes = flatten(container);
  assert.ok(nodes.some((n) => (n.textContent || '').includes(hostile)), 'the hostile string is present as TEXT');
  for (const n of nodes) {
    assert.equal(n.innerHTML, undefined, 'no node received innerHTML');
  }
});

await checkAsync('T2.4 empty archive renders a truthful complete-empty state', async () => {
  const stub = domStub();
  const api = loadReclamationApi(stub.document);
  const container = stub.document.createElement('div');
  const handle = api.mountReclamationCard(container, {
    diagnose: async () => ({ packages: [], residue: { complete: true, count: 0, entries: [], unscanned: [] } }),
    probeProjection: async () => ({ status: 'ok', contentHash: 'a'.repeat(64) }),
    invoke: async () => ({
      schema: 'h2o.m06.reclamationPreview', schema_version: 1,
      sources: { package_scan_complete: true, package_scan_blockers: [], db_probe_complete: true, db_probe_blockers: [], cas_inventory_complete: true, cas_inventory_blockers: [] },
      plan: { schema: 'h2o.m06.reclamationPlan', schema_version: 1, complete: true, retention_floor: 3, blockers: [], totals: { occupants: 0, protected: 0, candidates: 0, excluded: 0, chats_in_scope: 0, referenced_cas_objects: 0 }, decisions: [], cas: { complete: true, observed: [], referenced: [], observed_unreferenced: [], incomplete_reasons: [] } },
    }),
  });
  await handle.analyze();
  assert.equal(handle.getState().state, 'clean');
  assert.ok(allText(container).includes('Analysis complete'), 'a complete empty result says so');
});

check('T2.4 preview result is never persisted', () => {
  for (const forbidden of ['localStorage', 'sessionStorage', 'indexedDB', 'writeTextFile', 'plugin:fs|', 'preferences', 'receipt', '.h2o-reclaim']) {
    assert.ok(!reclaimCode.includes(forbidden), `must not persist via ${forbidden}`);
  }
});

console.log('');
if (FAIL.length) {
  console.error(`[archive-health-ui] ${FAIL.length} failed, ${PASS.length} passed`);
  process.exitCode = 1;
} else {
  console.log(`[archive-health-ui] all ${PASS.length} checks passed`);
}
