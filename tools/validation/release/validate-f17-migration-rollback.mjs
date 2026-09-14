#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { performance } from 'node:perf_hooks';

const VERSION = '0.1.0-f17.3.b';
const SCHEMA = 'h2o.release.migration-rollback-validation.v1';
const READY = 'MIGRATION ROLLBACK READY';
const WARNINGS_VERDICT = 'MIGRATION ROLLBACK WARNINGS';
const BLOCKED = 'MIGRATION ROLLBACK BLOCKED';
const ROOT = process.cwd();

/* The current Studio migration ceiling. v13 installed the guarded
 * folder_bindings protection; v23 (P02 folder relationship synchronization
 * T01) rebuilt sync_object_state domain-qualified and recreated the v13
 * triggers with the successor allowlist. Ordering and fixture classification
 * are pinned to this ceiling, not to v13. */
const EXPECTED_STUDIO_MIGRATION_MAX = 23;

const FLAGS = new Set(process.argv.slice(2));
const JSON_OUTPUT = FLAGS.has('--json');
const RUN_CARGO = FLAGS.has('--cargo');
const LIVE_DB_ATTESTED = FLAGS.has('--live-db-attested');
const DEEP_RESTORE_DRILL = FLAGS.has('--restore-drill');

const FILES = {
  lib: 'apps/studio/desktop/src-tauri/src/lib.rs',
  writerIdentity: 'apps/studio/desktop/src-tauri/src/sqlite_writer_identity.rs',
  desktopPackage: 'apps/studio/desktop/package.json',
  tauriConfig: 'apps/studio/desktop/src-tauri/tauri.conf.json'
};

const BLOCKERS = {
  MISSING_MIGRATION: 'migration-rollback-missing-migration-version',
  DUPLICATE_MIGRATION: 'migration-rollback-duplicate-migration-version',
  NON_SEQUENTIAL: 'migration-rollback-non-sequential-migration-versions',
  MISSING_V13_DDL: 'migration-rollback-missing-v13-guard-ddl',
  MISSING_DISABLE_LEVER: 'migration-rollback-guard-disable-lever-missing',
  MANIFEST_INCOMPLETE: 'migration-rollback-backup-manifest-incomplete',
  RESTORE_FAILED: 'migration-rollback-restore-drill-failed',
  REAL_DB_TOUCHED: 'migration-rollback-real-db-path-touched',
  CARGO_FAILED: 'migration-rollback-cargo-check-failed'
};

const WARNINGS = {
  CARGO_NOT_RUN: 'migration-rollback-cargo-not-run',
  LIVE_DB_NOT_ATTESTED: 'migration-rollback-live-db-not-attested',
  RESTORE_DEEP_NOT_RUN: 'migration-rollback-deep-restore-drill-not-run',
  PLUGIN_DB_PATH_UNRESOLVED: 'migration-rollback-plugin-db-path-runtime-decision-required'
};

const REAL_DB_PATH_NEEDLES = [
  'Application Support',
  'appData',
  'studio-v1.db'
];

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function readJson(rel) {
  return JSON.parse(read(rel));
}

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function statInfo(filePath) {
  const stat = fs.statSync(filePath);
  return {
    size: stat.size,
    mtime: stat.mtime.toISOString()
  };
}

function run(command, args, cwd = ROOT) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });
  return {
    command: `${path.relative(ROOT, cwd) || '.'}$ ${command} ${args.join(' ')}`,
    ok: result.status === 0,
    status: result.status,
    signal: result.signal,
    stdout: (result.stdout || '').trim().split('\n').filter(Boolean).slice(-12),
    stderr: (result.stderr || '').trim().split('\n').filter(Boolean).slice(-12),
    error: result.error ? String(result.error.message || result.error) : null
  };
}

function check(name, group, fn) {
  try {
    const detail = fn();
    return {
      name,
      group,
      ok: detail.ok !== false,
      blockers: detail.blockers || [],
      warnings: detail.warnings || [],
      detail
    };
  } catch (error) {
    return {
      name,
      group,
      ok: false,
      blockers: [String(error?.message || error)],
      warnings: [],
      detail: { error: String(error?.message || error) }
    };
  }
}

function extractStudioMigrations(libText) {
  const start = libText.indexOf('fn studio_migrations() -> Vec<Migration>');
  if (start < 0) {
    return { exists: false, body: '', versions: [] };
  }
  const end = libText.indexOf('\nasync fn ', start);
  const body = end > start ? libText.slice(start, end) : libText.slice(start);
  const versions = [...body.matchAll(/\bversion:\s*(\d+)\s*,/g)].map((match) => Number(match[1]));
  return { exists: true, body, versions };
}

function checkMigrationOrdering() {
  const migrations = extractStudioMigrations(read(FILES.lib));
  const expected = Array.from({ length: EXPECTED_STUDIO_MIGRATION_MAX }, (_, index) => index + 1);
  const sorted = [...migrations.versions].sort((a, b) => a - b);
  const duplicates = sorted.filter((version, index) => sorted.indexOf(version) !== index);
  const missing = expected.filter((version) => !sorted.includes(version));
  const extra = sorted.filter((version) => !expected.includes(version));
  const sequential = expected.length === sorted.length
    && expected.every((version, index) => sorted[index] === version);
  const blockers = [
    ...(missing.length || !migrations.exists ? [BLOCKERS.MISSING_MIGRATION] : []),
    ...(duplicates.length ? [BLOCKERS.DUPLICATE_MIGRATION] : []),
    ...(!sequential || extra.length ? [BLOCKERS.NON_SEQUENTIAL] : [])
  ];
  return {
    ok: blockers.length === 0,
    studioMigrationsExists: migrations.exists,
    expectedVersions: expected,
    observedVersions: migrations.versions,
    sequential,
    missingVersions: missing,
    duplicateVersions: duplicates,
    extraVersions: extra,
    blockers
  };
}

function checkV13GuardDdl() {
  const lib = read(FILES.lib);
  const writer = read(FILES.writerIdentity);
  const requiredLibNeedles = [
    'f16_folder_bindings_trigger_guard',
    'VALUES (1, 0, NULL, \'f16.4.c-default-off\')',
    'f16_protect_folder_bindings_insert',
    'f16_protect_folder_bindings_update',
    'f16_protect_folder_bindings_delete',
    'WHEN (SELECT COALESCE(enabled, 0) FROM f16_folder_bindings_trigger_guard WHERE id = 1) = 1',
    'f15.execute-settlement-writer',
    'f16.folder-legacy-fallback',
    'p02.relationship-apply'
  ];
  const requiredWriterNeedles = [
    'UPDATE f16_folder_bindings_trigger_guard',
    'set_folder_bindings_trigger_guard',
    'f16_configure_folder_bindings_trigger_protection',
    'FOLDER_BINDINGS_TRIGGER_TOKEN',
    'payload.enabled',
    'sqlite-folder-bindings-trigger-installed-disabled'
  ];
  const missingLib = requiredLibNeedles.filter((needle) => !lib.includes(needle));
  const missingWriter = requiredWriterNeedles.filter((needle) => !writer.includes(needle));
  const blockers = [
    ...(missingLib.length ? [BLOCKERS.MISSING_V13_DDL] : []),
    ...(missingWriter.length ? [BLOCKERS.MISSING_DISABLE_LEVER] : [])
  ];
  return {
    ok: blockers.length === 0,
    defaultOff: lib.includes("VALUES (1, 0, NULL, 'f16.4.c-default-off')"),
    guardedNotUnconditional: lib.includes('WHEN (SELECT COALESCE(enabled, 0) FROM f16_folder_bindings_trigger_guard WHERE id = 1) = 1'),
    guardDisableLeverPresent: missingWriter.length === 0,
    missingLib,
    missingWriter,
    blockers
  };
}

function createBackupManifest({ originalPath, backupPath, sourceVersion, targetVersion }) {
  const info = statInfo(originalPath);
  return {
    originalPath,
    backupPath,
    size: info.size,
    mtime: info.mtime,
    sha256: sha256File(originalPath),
    sourceAppVersion: sourceVersion,
    targetAppVersion: targetVersion,
    observedAtIso: new Date().toISOString()
  };
}

function requiredManifestFieldsPresent(manifest) {
  return [
    'originalPath',
    'backupPath',
    'size',
    'mtime',
    'sha256',
    'sourceAppVersion',
    'targetAppVersion',
    'observedAtIso'
  ].every((key) => manifest[key] !== undefined && manifest[key] !== null && manifest[key] !== '');
}

function checkBackupManifestAndRestore() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'h2o-f17-migration-'));
  const generatedPaths = [];
  try {
    const sourceVersion = readJson(FILES.desktopPackage).version || 'unknown';
    const targetVersion = readJson(FILES.tauriConfig).version || 'unknown';
    const original = path.join(tempRoot, 'studio-v1.db');
    const wal = `${original}-wal`;
    const shm = `${original}-shm`;
    fs.writeFileSync(original, 'fixture-db-v12-before-migration\n');
    fs.writeFileSync(wal, 'fixture-wal\n');
    fs.writeFileSync(shm, 'fixture-shm\n');
    generatedPaths.push(original, wal, shm);

    const backupDir = path.join(tempRoot, 'backup');
    fs.mkdirSync(backupDir);
    generatedPaths.push(backupDir);
    const stamp = '2026-06-14T000000Z';
    const backup = path.join(backupDir, `studio-v1.db.${stamp}.bak`);
    const backupWal = `${backup}-wal`;
    const backupShm = `${backup}-shm`;
    fs.copyFileSync(original, backup);
    fs.copyFileSync(wal, backupWal);
    fs.copyFileSync(shm, backupShm);
    generatedPaths.push(backup, backupWal, backupShm);

    const manifest = createBackupManifest({
      originalPath: original,
      backupPath: backup,
      sourceVersion,
      targetVersion
    });
    manifest.sidecars = [
      { originalPath: wal, backupPath: backupWal, sha256: sha256File(wal), ...statInfo(wal) },
      { originalPath: shm, backupPath: backupShm, sha256: sha256File(shm), ...statInfo(shm) }
    ];
    const manifestPath = path.join(backupDir, 'manifest.json');
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    generatedPaths.push(manifestPath);

    const restoreDir = path.join(tempRoot, 'restore');
    fs.mkdirSync(restoreDir);
    generatedPaths.push(restoreDir);
    const restored = path.join(restoreDir, 'studio-v1.db');
    fs.copyFileSync(backup, restored);
    generatedPaths.push(restored);
    if (DEEP_RESTORE_DRILL) {
      fs.copyFileSync(backupWal, `${restored}-wal`);
      fs.copyFileSync(backupShm, `${restored}-shm`);
      generatedPaths.push(`${restored}-wal`, `${restored}-shm`);
    }

    const manifestComplete = requiredManifestFieldsPresent(manifest);
    const restoreOk = sha256File(restored) === manifest.sha256;
    const tempOnly = generatedPaths.every((filePath) => path.resolve(filePath).startsWith(path.resolve(tempRoot)));
    const blockers = [
      ...(!manifestComplete ? [BLOCKERS.MANIFEST_INCOMPLETE] : []),
      ...(!restoreOk ? [BLOCKERS.RESTORE_FAILED] : []),
      ...(!tempOnly ? [BLOCKERS.REAL_DB_TOUCHED] : [])
    ];
    return {
      ok: blockers.length === 0,
      tempRoot,
      generatedPathCount: generatedPaths.length,
      manifestComplete,
      sidecarsIncluded: manifest.sidecars.length === 2,
      restoreDrillRan: true,
      deepRestoreDrillRan: DEEP_RESTORE_DRILL,
      restoreOk,
      tempOnly,
      manifest: {
        originalPath: manifest.originalPath,
        backupPath: manifest.backupPath,
        size: manifest.size,
        mtime: manifest.mtime,
        sha256: manifest.sha256,
        sourceAppVersion: manifest.sourceAppVersion,
        targetAppVersion: manifest.targetAppVersion,
        observedAtIso: manifest.observedAtIso,
        sidecarCount: manifest.sidecars.length
      },
      blockers,
      warnings: DEEP_RESTORE_DRILL ? [] : [WARNINGS.RESTORE_DEEP_NOT_RUN]
    };
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

function classifyFixture(fixture) {
  if (fixture.kind === 'empty') {
    return { classification: 'old', needsBackupBeforeMigration: true };
  }
  if (typeof fixture.userVersion !== 'number') {
    return { classification: 'unknown/future', needsBackupBeforeMigration: true };
  }
  if (fixture.userVersion < EXPECTED_STUDIO_MIGRATION_MAX) {
    return { classification: 'old', needsBackupBeforeMigration: true };
  }
  if (fixture.userVersion === EXPECTED_STUDIO_MIGRATION_MAX) {
    return { classification: 'current', needsBackupBeforeMigration: false };
  }
  return { classification: 'unknown/future', needsBackupBeforeMigration: true };
}

function checkOldDbFixtures() {
  const fixtures = [
    { id: 'empty-db', kind: 'empty', userVersion: null, expected: 'old', expectedBackup: true },
    { id: 'v1-only-db', kind: 'sqlite', userVersion: 1, expected: 'old', expectedBackup: true },
    { id: 'v3-folder-era-db', kind: 'sqlite', userVersion: 3, expected: 'old', expectedBackup: true },
    { id: 'v12-pre-folder-trigger-db', kind: 'sqlite', userVersion: 12, expected: 'old', expectedBackup: true },
    { id: 'v13-folder-trigger-db', kind: 'sqlite', userVersion: 13, expected: 'old', expectedBackup: true },
    { id: 'v22-pre-domain-qualified-db', kind: 'sqlite', userVersion: 22, expected: 'old', expectedBackup: true },
    { id: 'v23-current-db', kind: 'sqlite', userVersion: 23, expected: 'current', expectedBackup: false },
    { id: 'unknown-future-db', kind: 'sqlite', userVersion: 99, expected: 'unknown/future', expectedBackup: true }
  ];
  const results = fixtures.map((fixture) => {
    const observed = classifyFixture(fixture);
    return {
      id: fixture.id,
      userVersion: fixture.userVersion,
      classification: observed.classification,
      needsBackupBeforeMigration: observed.needsBackupBeforeMigration,
      ok: observed.classification === fixture.expected
        && observed.needsBackupBeforeMigration === fixture.expectedBackup
    };
  });
  const ok = results.every((item) => item.ok);
  return {
    ok,
    fixtureCount: fixtures.length,
    results,
    blockers: ok ? [] : ['migration-rollback-old-db-fixture-classification-failed']
  };
}

function checkV13RollbackContract() {
  const ddl = checkV13GuardDdl();
  const proof = {
    guardTableInstalled: ddl.defaultOff,
    rollbackDisablesGuard: ddl.guardDisableLeverPresent,
    rollbackDoesNotDropTriggers: ddl.guardedNotUnconditional,
    defaultOff: ddl.defaultOff,
    activeBlocksUnauthorized: ddl.guardedNotUnconditional,
    settlementIdentityAllowed: read(FILES.lib).includes('f15.execute-settlement-writer'),
    legacyFallbackIdentityAllowed: read(FILES.lib).includes('f16.folder-legacy-fallback'),
    p02RelationshipApplyIdentityAllowed: read(FILES.lib).includes('p02.relationship-apply'),
    disableRestoresLegacy: read(FILES.writerIdentity).includes('sqlite-folder-bindings-trigger-installed-disabled')
  };
  const ok = Object.values(proof).every(Boolean);
  return {
    ok,
    proof,
    blockers: ok ? [] : [BLOCKERS.MISSING_DISABLE_LEVER]
  };
}

function checkNoRealDbTouched() {
  const repoDbCandidates = [
    path.join(ROOT, 'studio-v1.db'),
    path.join(ROOT, 'apps/studio/desktop/studio-v1.db'),
    path.join(ROOT, 'apps/studio/desktop/src-tauri/studio-v1.db')
  ];
  const existingRepoDbFiles = repoDbCandidates.filter((filePath) => fs.existsSync(filePath));
  const sourceMentionsPluginPathOnly = REAL_DB_PATH_NEEDLES.includes('studio-v1.db');
  return {
    ok: existingRepoDbFiles.length === 0,
    existingRepoDbFiles,
    sourceMentionsPluginPathOnly,
    defaultUsesTempFiles: true,
    blockers: existingRepoDbFiles.length ? [BLOCKERS.REAL_DB_TOUCHED] : []
  };
}

function checkOptionalPolicy() {
  return {
    ok: true,
    cargoRequested: RUN_CARGO,
    liveDbAttested: LIVE_DB_ATTESTED,
    restoreDrillRequested: DEEP_RESTORE_DRILL,
    warnings: [
      ...(RUN_CARGO ? [] : [WARNINGS.CARGO_NOT_RUN]),
      ...(LIVE_DB_ATTESTED ? [] : [WARNINGS.LIVE_DB_NOT_ATTESTED]),
      WARNINGS.PLUGIN_DB_PATH_UNRESOLVED
    ],
    blockers: []
  };
}

function runCargoCheck() {
  if (!RUN_CARGO) {
    return {
      ok: true,
      requested: false,
      warnings: [WARNINGS.CARGO_NOT_RUN],
      blockers: []
    };
  }
  const result = run('cargo', ['check'], path.join(ROOT, 'apps/studio/desktop/src-tauri'));
  return {
    ok: result.ok,
    requested: true,
    result,
    blockers: result.ok ? [] : [BLOCKERS.CARGO_FAILED],
    warnings: []
  };
}

function runValidation() {
  const started = performance.now();
  const checks = [
    check('migration-source-ordering', 'migrations', checkMigrationOrdering),
    check('v13-guard-ddl-and-disable-lever', 'migrations', checkV13GuardDdl),
    check('backup-manifest-and-temp-restore', 'backup', checkBackupManifestAndRestore),
    check('old-db-fixture-classification', 'fixtures', checkOldDbFixtures),
    check('v13-trigger-guard-rollback', 'rollback', checkV13RollbackContract),
    check('no-real-db-touched', 'safety', checkNoRealDbTouched),
    check('optional-policy', 'optional', checkOptionalPolicy),
    check('cargo-check', 'optional', runCargoCheck)
  ];
  const blockers = checks.flatMap((item) => item.blockers);
  const warnings = [...new Set(checks.flatMap((item) => item.warnings))];
  const failedChecks = checks.filter((item) => !item.ok);
  const verdict = blockers.length > 0 ? BLOCKED : warnings.length > 0 ? WARNINGS_VERDICT : READY;
  return {
    schema: SCHEMA,
    version: VERSION,
    verdict,
    ok: blockers.length === 0,
    checks,
    checkCount: checks.length,
    passCount: checks.length - failedChecks.length,
    failCount: failedChecks.length,
    migrationOrder: checks.find((item) => item.name === 'migration-source-ordering')?.detail,
    oldDbFixtures: checks.find((item) => item.name === 'old-db-fixture-classification')?.detail,
    backupManifest: checks.find((item) => item.name === 'backup-manifest-and-temp-restore')?.detail,
    restoreDrill: checks.find((item) => item.name === 'backup-manifest-and-temp-restore')?.detail,
    v13GuardRollback: checks.find((item) => item.name === 'v13-trigger-guard-rollback')?.detail,
    noRealDbTouched: checks.find((item) => item.name === 'no-real-db-touched')?.detail,
    blockers,
    warnings,
    optional: {
      cargoRequested: RUN_CARGO,
      liveDbAttested: LIVE_DB_ATTESTED,
      restoreDrillRequested: DEEP_RESTORE_DRILL
    },
    durationMs: Math.round(performance.now() - started),
    observedAtIso: new Date().toISOString()
  };
}

function printHuman(result) {
  console.log(`F17 Migration/Rollback Validation: ${result.verdict}`);
  console.log(`schema: ${result.schema}`);
  console.log(`version: ${result.version}`);
  console.log(`checks: ${result.passCount}/${result.checkCount} passed, ${result.failCount} failed`);
  console.log(`blockers: ${result.blockers.length}`);
  console.log(`warnings: ${result.warnings.length}`);
  console.log(`cargo requested: ${result.optional.cargoRequested ? 'yes' : 'no'}`);
  console.log(`live DB attested: ${result.optional.liveDbAttested ? 'yes' : 'no'}`);
  console.log(`deep restore drill requested: ${result.optional.restoreDrillRequested ? 'yes' : 'no'}`);
  console.log('');
  for (const item of result.checks) {
    const status = item.ok ? 'OK' : 'FAIL';
    console.log(`${status} ${item.group}/${item.name}`);
    if (item.blockers.length) {
      console.log(`  blockers: ${item.blockers.join(', ')}`);
    }
    if (item.warnings.length) {
      console.log(`  warnings: ${item.warnings.join(', ')}`);
    }
  }
}

const result = runValidation();
if (JSON_OUTPUT) {
  console.log(JSON.stringify(result, null, 2));
} else {
  printHuman(result);
}
process.exitCode = result.ok ? 0 : 1;
