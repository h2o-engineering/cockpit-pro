#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { performance } from 'node:perf_hooks';

const VERSION = '0.1.0-f17.2.b';
const SCHEMA = 'h2o.release.build-package-validation.v1';
const READY = 'BUILD PACKAGE READY';
const WARNINGS = 'BUILD PACKAGE WARNINGS';
const BLOCKED = 'BUILD PACKAGE BLOCKED';
const ROOT = process.cwd();
const NODE = process.execPath;
const SOURCE_SAFE_VALIDATION_MODE = 'source-safe-local';
const SOURCE_SAFE_TEMP_ROOT = fs.mkdtempSync(
  path.join(os.tmpdir(), 'h2o-f17-source-safe-')
);
const SOURCE_SAFE_EXTENSION_ROOT = path.join(
  SOURCE_SAFE_TEMP_ROOT,
  'extension-output'
);
const SOURCE_SAFE_EXTENSION_OUT = path.join(
  SOURCE_SAFE_EXTENSION_ROOT,
  'prod'
);
const EXPECTED_CANONICAL_ANCHOR = path.resolve(
  ROOT,
  '..',
  '.h2o-canonical-delivery'
);
const CANONICAL_ANCHOR_INITIALLY_ABSENT =
  !fs.existsSync(EXPECTED_CANONICAL_ANCHOR);
const SOURCE_SAFE_CONTRACT = Object.freeze({
  validationMode: SOURCE_SAFE_VALIDATION_MODE,
  sourceSafeValidationImplemented: true,
  releaseValidatorLiveWritesProhibited: true,
  publicationValidationComplete: false,
  stageE3Required: true
});
const EXPECTED_STUDIO_MIGRATION_MAX = 22;
let sourceSafeRealBuilderExecutions = 0;
let sourceSafeValidatedFileCount = 0;

const FLAGS = new Set(process.argv.slice(2));
const JSON_OUTPUT = FLAGS.has('--json');
const RUN_CARGO = FLAGS.has('--cargo');
const RUN_TAURI_BUILD = FLAGS.has('--tauri-build');
const INSPECT_ARTIFACTS = FLAGS.has('--artifacts');

const FILES = {
  lib: 'apps/studio/desktop/src-tauri/src/lib.rs',
  desktopPackage: 'apps/studio/desktop/package.json',
  tauriConfig: 'apps/studio/desktop/src-tauri/tauri.conf.json',
  rootPackage: 'package.json',
  buildChrome: 'tools/product/extensions/chatgpt/chrome/build-chrome-live-extension.mjs',
  prepareDist: 'apps/studio/desktop/build-tools/prepare-dist.mjs',
  packStudio: 'tools/product/studio/pack-studio.mjs'
};

const ARTIFACT_DIRS = [
  SOURCE_SAFE_EXTENSION_OUT,
  'apps/studio/desktop/dist',
  'apps/studio/desktop/src-tauri/target/release/bundle'
];

const OPTIONAL_WARNINGS = {
  CARGO_NOT_RUN: 'build-package-optional-cargo-not-run',
  TAURI_NOT_RUN: 'build-package-optional-tauri-build-not-run',
  ARTIFACTS_NOT_INSPECTED: 'build-package-optional-artifacts-not-inspected',
  ARTIFACTS_ABSENT: 'build-package-artifacts-requested-absent',
  MOBILE_NOT_VALIDATED: 'build-package-mobile-eas-not-validated',
  RELEASE_DRY_RUN_NOT_EXECUTED: 'build-package-release-dry-run-not-executed'
};

const BLOCKERS = {
  MISSING_DEPENDENCY: 'build-package-missing-validator-dependency',
  MIGRATION_DRIFT: 'build-package-migration-gap-duplicate-or-missing-v13',
  MISSING_TRIGGER: 'build-package-missing-guarded-trigger-ddl',
  VERSION_MISMATCH: 'build-package-desktop-tauri-version-mismatch',
  MISSING_DESKTOP_VERSION: 'build-package-missing-desktop-package-version',
  MISSING_TAURI_VERSION: 'build-package-missing-tauri-version',
  REQUIRED_SCRIPT_MISSING: 'build-package-required-build-script-missing',
  PREPARE_DIST_GUARD_MISSING: 'build-package-prepare-dist-stale-guard-missing',
  SOURCE_SAFE_EXTENSION_FAILED: 'build-package-source-safe-extension-build-failed',
  CARGO_FAILED: 'build-package-cargo-check-failed',
  TAURI_FAILED: 'build-package-tauri-build-failed',
  ARTIFACT_VERSION_MISMATCH: 'build-package-artifact-version-mismatch'
};

function absolutePath(rel) {
  return path.isAbsolute(rel) ? rel : path.join(ROOT, rel);
}

function read(rel) {
  return fs.readFileSync(absolutePath(rel), 'utf8');
}

function readJson(rel) {
  return JSON.parse(read(rel));
}

function exists(rel) {
  return fs.existsSync(absolutePath(rel));
}

function commandText(command, args, cwd = ROOT) {
  const relCwd = path.relative(ROOT, cwd) || '.';
  return `${relCwd}$ ${command} ${args.join(' ')}`;
}

function run(command, args, opts = {}) {
  const cwd = opts.cwd || ROOT;
  const result = spawnSync(command, args, {
    cwd,
    env: opts.replaceEnv
      ? opts.env
      : { ...process.env, ...(opts.env || {}) },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });
  return {
    command: commandText(command, args, cwd),
    ok: result.status === 0,
    status: result.status,
    signal: result.signal,
    stdout: (result.stdout || '').trim().split('\n').filter(Boolean).slice(-12),
    stderr: (result.stderr || '').trim().split('\n').filter(Boolean).slice(-12),
    error: result.error ? String(result.error.message || result.error) : null
  };
}

function sourceSafeBuilderEnvironment() {
  const environment = { ...process.env };
  for (const name of Object.keys(environment)) {
    if (name.startsWith('H2O_')) delete environment[name];
  }
  Object.assign(environment, {
    H2O_SRC_DIR: ROOT,
    H2O_EXT_BUILD_ROOT: SOURCE_SAFE_EXTENSION_ROOT,
    H2O_EXT_OUT_DIR: SOURCE_SAFE_EXTENSION_OUT,
    H2O_EXT_DEV_VARIANT: 'production'
  });
  return environment;
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
      blockers: [BLOCKERS.MISSING_DEPENDENCY],
      warnings: [],
      detail: { error: String(error?.message || error) }
    };
  }
}

function checkRequiredFiles() {
  const missing = Object.values(FILES).filter((file) => !exists(file));
  return {
    ok: missing.length === 0,
    missing,
    blockers: missing.length ? [BLOCKERS.MISSING_DEPENDENCY] : []
  };
}

function extractStudioMigrations(libText) {
  const fnStart = libText.indexOf('fn studio_migrations() -> Vec<Migration>');
  if (fnStart < 0) {
    return { exists: false, body: '', versions: [] };
  }
  const nextMarker = libText.indexOf('\nasync fn ', fnStart);
  const body = nextMarker > fnStart ? libText.slice(fnStart, nextMarker) : libText.slice(fnStart);
  const versions = [...body.matchAll(/\bversion:\s*(\d+)\s*,/g)].map((match) => Number(match[1]));
  return { exists: true, body, versions };
}

function checkMigrations() {
  const libText = read(FILES.lib);
  const migrations = extractStudioMigrations(libText);
  const expected = Array.from(
    { length: EXPECTED_STUDIO_MIGRATION_MAX },
    (_, index) => index + 1
  );
  const sorted = [...migrations.versions].sort((a, b) => a - b);
  const duplicateVersions = sorted.filter((version, index) => sorted.indexOf(version) !== index);
  const missingVersions = expected.filter((version) => !sorted.includes(version));
  const extraVersions = sorted.filter((version) => !expected.includes(version));
  const sequential = expected.length === sorted.length
    && expected.every((version, index) => sorted[index] === version);
  const ok = migrations.exists && sequential && duplicateVersions.length === 0 && missingVersions.length === 0 && extraVersions.length === 0;
  return {
    ok,
    studioMigrationsExists: migrations.exists,
    expectedVersions: expected,
    observedVersions: migrations.versions,
    sequential,
    duplicateVersions,
    missingVersions,
    extraVersions,
    blockers: ok ? [] : [BLOCKERS.MIGRATION_DRIFT]
  };
}

function checkV13TriggerDdl() {
  const libText = read(FILES.lib);
  const requiredNeedles = [
    'f16_folder_bindings_trigger_guard',
    'f16_protect_folder_bindings_insert',
    'f16_protect_folder_bindings_update',
    'f16_protect_folder_bindings_delete',
    'f16-folder-bindings-write-protected:insert',
    'f16-folder-bindings-write-protected:update',
    'f16-folder-bindings-write-protected:delete',
    'f15.execute-settlement-writer',
    'f16.folder-legacy-fallback'
  ];
  const missing = requiredNeedles.filter((needle) => !libText.includes(needle));
  return {
    ok: missing.length === 0,
    requiredNeedles,
    missing,
    blockers: missing.length ? [BLOCKERS.MISSING_TRIGGER] : []
  };
}

function checkVersions() {
  const desktopPackage = readJson(FILES.desktopPackage);
  const tauriConfig = readJson(FILES.tauriConfig);
  const rootPackage = readJson(FILES.rootPackage);
  const desktopVersion = desktopPackage.version || '';
  const tauriVersion = tauriConfig.version || tauriConfig.package?.version || '';
  const blockers = [];
  if (!desktopVersion) {
    blockers.push(BLOCKERS.MISSING_DESKTOP_VERSION);
  }
  if (!tauriVersion) {
    blockers.push(BLOCKERS.MISSING_TAURI_VERSION);
  }
  if (desktopVersion && tauriVersion && desktopVersion !== tauriVersion) {
    blockers.push(BLOCKERS.VERSION_MISMATCH);
  }
  return {
    ok: blockers.length === 0,
    desktopPackageVersion: desktopVersion,
    tauriVersion,
    rootPackageVersion: rootPackage.version || null,
    rootPackageVersionAuthority: rootPackage.version ? 'workspace-root-not-app-authority' : 'none',
    userscriptVersionAxis: 'separate',
    blockers
  };
}

function checkBuildScripts() {
  const rootPackage = readJson(FILES.rootPackage);
  const desktopPackage = readJson(FILES.desktopPackage);
  const missingFiles = [
    FILES.buildChrome,
    FILES.prepareDist,
    FILES.packStudio
  ].filter((file) => !exists(file));
  const missingRootScripts = ['rev:dry', 'rev:stamp', 'release:dry', 'ship:dry', 'gate:library', 'audit:secrets']
    .filter((script) => !rootPackage.scripts?.[script]);
  const missingDesktopScripts = ['prepare-dist', 'tauri:build']
    .filter((script) => !desktopPackage.scripts?.[script]);
  const blockers = [];
  if (missingFiles.length || missingRootScripts.length || missingDesktopScripts.length) {
    blockers.push(BLOCKERS.REQUIRED_SCRIPT_MISSING);
  }
  return {
    ok: blockers.length === 0,
    missingFiles,
    missingRootScripts,
    missingDesktopScripts,
    blockers
  };
}

function runSourceSafeExtensionBuild() {
  const relative = path.relative(
    SOURCE_SAFE_TEMP_ROOT,
    SOURCE_SAFE_EXTENSION_OUT
  );
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    return {
      ok: false,
      blockers: [BLOCKERS.SOURCE_SAFE_EXTENSION_FAILED],
      reason: 'source-safe-extension-destination-escaped-temporary-root'
    };
  }
  const result = run(NODE, [FILES.buildChrome], {
    env: sourceSafeBuilderEnvironment(),
    replaceEnv: true
  });
  sourceSafeRealBuilderExecutions += 1;
  if (!result.ok) {
    return {
      ok: false,
      blockers: [BLOCKERS.SOURCE_SAFE_EXTENSION_FAILED],
      result
    };
  }

  const requiredFiles = [
    'manifest.json',
    'bg.js',
    'loader.js',
    'README.txt',
    'provider/identity-provider-supabase.js'
  ];
  const files = requiredFiles.map((relativePath) => {
    const filename = path.join(SOURCE_SAFE_EXTENSION_OUT, relativePath);
    const stat = fs.statSync(filename);
    const bytes = fs.readFileSync(filename);
    if (!stat.isFile() || bytes.length <= 0) {
      throw new Error(`source-safe extension output is empty: ${filename}`);
    }
    sourceSafeValidatedFileCount += 1;
    return {
      relativePath,
      bytes: bytes.length
    };
  });
  const manifest = JSON.parse(
    fs.readFileSync(
      path.join(SOURCE_SAFE_EXTENSION_OUT, 'manifest.json'),
      'utf8'
    )
  );
  const ok = Boolean(
    manifest &&
    typeof manifest === 'object' &&
    manifest.manifest_version
  );
  return {
    ok,
    blockers: ok ? [] : [BLOCKERS.SOURCE_SAFE_EXTENSION_FAILED],
    result,
    destination: SOURCE_SAFE_EXTENSION_OUT,
    destinationUnderTemporaryRoot: true,
    realBuilderExecution: true,
    requiredFiles: files,
    manifestVersion: manifest.manifest_version || null
  };
}

function checkPrepareDist() {
  const text = read(FILES.prepareDist);
  const requiredNeedles = [
    'STALE BUILD DETECTED',
    'SKIP_STALENESS_CHECK',
    'extensionBuildDir(\'prod\')',
    'SURFACES_STUDIO_DIR',
    'rewriteHtmlReferences',
    'sanitizeBasename',
    'fs.rmSync(dist'
  ];
  const missing = requiredNeedles.filter((needle) => !text.includes(needle));
  return {
    ok: missing.length === 0,
    requiredNeedles,
    missing,
    blockers: missing.length ? [BLOCKERS.PREPARE_DIST_GUARD_MISSING] : []
  };
}

function checkTauriConfig() {
  const tauriConfig = readJson(FILES.tauriConfig);
  const frontendDist = tauriConfig.build?.frontendDist || '';
  const productName = tauriConfig.productName || '';
  const identifier = tauriConfig.identifier || '';
  const version = tauriConfig.version || tauriConfig.package?.version || '';
  const ok = Boolean(frontendDist === '../dist' && productName && identifier && version);
  return {
    ok,
    productName,
    identifier,
    version,
    frontendDist,
    blockers: ok ? [] : [BLOCKERS.REQUIRED_SCRIPT_MISSING]
  };
}

function checkStudioPackReadiness() {
  const packText = read(FILES.packStudio);
  const buildText = read(FILES.buildChrome);
  const hasCompare = packText.includes('compareArchiveWorkbenchToSource');
  const hasSourceFiles = packText.includes('ARCHIVE_WORKBENCH_SOURCE_FILES');
  const hasOutFiles = packText.includes('ARCHIVE_WORKBENCH_OUT_FILES');
  const buildUsesPack = buildText.includes('pack-studio.mjs') || buildText.includes('../../../studio/pack-studio.mjs');
  const ok = hasCompare && hasSourceFiles && hasOutFiles && buildUsesPack;
  return {
    ok,
    hasCompareArchiveWorkbenchToSource: hasCompare,
    hasArchiveWorkbenchSourceFiles: hasSourceFiles,
    hasArchiveWorkbenchOutFiles: hasOutFiles,
    buildUsesStudioPack: buildUsesPack,
    blockers: ok ? [] : [BLOCKERS.REQUIRED_SCRIPT_MISSING]
  };
}

function checkArtifactPolicy() {
  if (!INSPECT_ARTIFACTS) {
    return {
      ok: true,
      requested: false,
      inspected: false,
      artifactDirs: ARTIFACT_DIRS,
      warnings: [OPTIONAL_WARNINGS.ARTIFACTS_NOT_INSPECTED],
      blockers: []
    };
  }

  const existing = ARTIFACT_DIRS.filter((dir) => exists(dir));
  const warnings = existing.length ? [] : [OPTIONAL_WARNINGS.ARTIFACTS_ABSENT];
  const desktopVersion = readJson(FILES.desktopPackage).version || '';
  const tauriVersion = readJson(FILES.tauriConfig).version || '';
  const blockers = desktopVersion && tauriVersion && desktopVersion !== tauriVersion
    ? [BLOCKERS.ARTIFACT_VERSION_MISMATCH]
    : [];
  return {
    ok: blockers.length === 0,
    requested: true,
    inspected: true,
    artifactDirs: ARTIFACT_DIRS,
    existingArtifactDirs: existing,
    expectedVersion: desktopVersion,
    tauriVersion,
    warnings,
    blockers
  };
}

function checkOptionalPolicy() {
  return {
    ok: true,
    cargoRequested: RUN_CARGO,
    tauriBuildRequested: RUN_TAURI_BUILD,
    artifactsRequested: INSPECT_ARTIFACTS,
    mobileEasValidated: false,
    releaseDryRunExecuted: false,
    warnings: [
      ...(RUN_CARGO ? [] : [OPTIONAL_WARNINGS.CARGO_NOT_RUN]),
      ...(RUN_TAURI_BUILD ? [] : [OPTIONAL_WARNINGS.TAURI_NOT_RUN]),
      OPTIONAL_WARNINGS.MOBILE_NOT_VALIDATED,
      OPTIONAL_WARNINGS.RELEASE_DRY_RUN_NOT_EXECUTED
    ],
    blockers: []
  };
}

function runCargoCheck() {
  if (!RUN_CARGO) {
    return {
      ok: true,
      requested: false,
      command: 'cargo check',
      warnings: [OPTIONAL_WARNINGS.CARGO_NOT_RUN],
      blockers: []
    };
  }
  const result = run('cargo', ['check'], {
    cwd: path.join(ROOT, 'apps/studio/desktop/src-tauri')
  });
  return {
    ok: result.ok,
    requested: true,
    result,
    blockers: result.ok ? [] : [BLOCKERS.CARGO_FAILED],
    warnings: []
  };
}

function runTauriBuild() {
  if (!RUN_TAURI_BUILD) {
    return {
      ok: true,
      requested: false,
      command: 'npm run tauri:build',
      warnings: [OPTIONAL_WARNINGS.TAURI_NOT_RUN],
      blockers: []
    };
  }
  const result = run('npm', ['run', 'tauri:build'], {
    cwd: path.join(ROOT, 'apps/studio/desktop'),
    env: { H2O_STUDIO_BUILD_CHECKPOINT: 'F17_VALIDATION' }
  });
  return {
    ok: result.ok,
    requested: true,
    result,
    blockers: result.ok ? [] : [BLOCKERS.TAURI_FAILED],
    warnings: []
  };
}

function runValidation() {
  const started = performance.now();
  const checks = [
    check('required-files', 'source', checkRequiredFiles),
    check('migration-source', 'migrations', checkMigrations),
    check('v13-folder-bindings-trigger-ddl', 'migrations', checkV13TriggerDdl),
    check('version-consistency', 'versions', checkVersions),
    check('build-script-config', 'build', checkBuildScripts),
    check('source-safe-chrome-extension-build', 'build', runSourceSafeExtensionBuild),
    check('prepare-dist-stale-guard', 'build', checkPrepareDist),
    check('tauri-frontend-dist-config', 'build', checkTauriConfig),
    check('studio-pack-source-comparison-readiness', 'build', checkStudioPackReadiness),
    check('artifact-policy', 'artifacts', checkArtifactPolicy),
    check('optional-policy', 'optional', checkOptionalPolicy),
    check('cargo-check', 'optional', runCargoCheck),
    check('tauri-build', 'optional', runTauriBuild)
  ];

  const blockers = checks.flatMap((item) => item.blockers);
  const warnings = [...new Set(checks.flatMap((item) => item.warnings))];
  const failedChecks = checks.filter((item) => !item.ok);
  const verdict = blockers.length > 0 ? BLOCKED : warnings.length > 0 ? WARNINGS : READY;

  return {
    schema: SCHEMA,
    version: VERSION,
    verdict,
    ok: blockers.length === 0,
    checks,
    checkCount: checks.length,
    passCount: checks.length - failedChecks.length,
    failCount: failedChecks.length,
    blockers,
    warnings,
    optional: {
      cargoRequested: RUN_CARGO,
      tauriBuildRequested: RUN_TAURI_BUILD,
      artifactsRequested: INSPECT_ARTIFACTS
    },
    sourceSafeValidation: {
      ...SOURCE_SAFE_CONTRACT,
      sourceSafeModeRequested: FLAGS.has('--source-safe'),
      temporaryRootCreated: true,
      temporaryRoot: SOURCE_SAFE_TEMP_ROOT,
      extensionBuildDestination: SOURCE_SAFE_EXTENSION_OUT,
      realBuilderExecutions: sourceSafeRealBuilderExecutions,
      validatedFileCount: sourceSafeValidatedFileCount
    },
    evidence: {
      migration: checks.find((item) => item.name === 'migration-source')?.detail,
      v13Trigger: checks.find((item) => item.name === 'v13-folder-bindings-trigger-ddl')?.detail,
      versions: checks.find((item) => item.name === 'version-consistency')?.detail,
      artifacts: checks.find((item) => item.name === 'artifact-policy')?.detail
    },
    durationMs: Math.round(performance.now() - started),
    observedAtIso: new Date().toISOString()
  };
}

function printHuman(result) {
  console.log(`F17 Build/Package Validation: ${result.verdict}`);
  console.log(`schema: ${result.schema}`);
  console.log(`version: ${result.version}`);
  console.log(`checks: ${result.passCount}/${result.checkCount} passed, ${result.failCount} failed`);
  console.log(`blockers: ${result.blockers.length}`);
  console.log(`warnings: ${result.warnings.length}`);
  console.log(`cargo requested: ${result.optional.cargoRequested ? 'yes' : 'no'}`);
  console.log(`tauri build requested: ${result.optional.tauriBuildRequested ? 'yes' : 'no'}`);
  console.log(`artifacts requested: ${result.optional.artifactsRequested ? 'yes' : 'no'}`);
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

let result;
let cleanupCompleted = false;
let cleanupError = null;
try {
  result = runValidation();
} finally {
  try {
    const relative = path.relative(os.tmpdir(), SOURCE_SAFE_TEMP_ROOT);
    if (
      relative.startsWith('..') ||
      path.isAbsolute(relative) ||
      !path.basename(SOURCE_SAFE_TEMP_ROOT).startsWith('h2o-f17-source-safe-')
    ) {
      throw new Error(
        `refusing unsafe source-safe cleanup: ${SOURCE_SAFE_TEMP_ROOT}`
      );
    }
    fs.rmSync(SOURCE_SAFE_TEMP_ROOT, { recursive: true, force: true });
    cleanupCompleted = !fs.existsSync(SOURCE_SAFE_TEMP_ROOT);
  } catch (error) {
    cleanupError = error;
  }
}
const canonicalAnchorCreated =
  CANONICAL_ANCHOR_INITIALLY_ABSENT &&
  fs.existsSync(EXPECTED_CANONICAL_ANCHOR);
result.sourceSafeValidation.cleanupCompleted = cleanupCompleted;
result.sourceSafeValidation.canonicalAnchorCreated = canonicalAnchorCreated;
if (!cleanupCompleted || canonicalAnchorCreated || cleanupError) {
  result.ok = false;
  result.verdict = BLOCKED;
  result.blockers = [
    ...new Set([
      ...result.blockers,
      BLOCKERS.SOURCE_SAFE_EXTENSION_FAILED
    ])
  ];
  result.sourceSafeValidation.cleanupError = cleanupError
    ? String(cleanupError.message || cleanupError)
    : null;
}
if (JSON_OUTPUT) {
  console.log(JSON.stringify(result, null, 2));
} else {
  printHuman(result);
}
process.exitCode = result.ok ? 0 : 1;
