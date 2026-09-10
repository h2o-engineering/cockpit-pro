#!/usr/bin/env node
/* tauri-build.mjs
 *
 * Desktop Studio release build wrapper.
 *
 * The default Tauri macOS DMG bundler uses Finder AppleScript for visual DMG
 * layout. F18.1 proved that app bundling succeeds but Finder styling can time
 * out during RC dry-runs. This wrapper keeps Tauri as the authority for the
 * binary and `.app`, then uses `create-dmg.mjs` for deterministic DMG output.
 */

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createGovernedDesktopBuildIdentity,
  governedDesktopBuildEnvironment,
} from './desktop-build-identity.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(here, '..');

function run(command, args, environment) {
  const result = spawnSync(command, args, {
    cwd: desktopRoot,
    stdio: 'inherit',
    env: environment
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${[command, ...args].join(' ')} exited with ${result.status}`);
  }
}

function readExactSourceCommit() {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: desktopRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`[tauri-build] unable to resolve exact source HEAD: ${String(result.stderr || '').trim()}`);
  }
  return String(result.stdout || '').trim();
}

function splitBundleValue(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

function parseArgs(args) {
  const forwarded = [];
  let requestedBundles = null;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--bundles' || arg === '-b') {
      requestedBundles = splitBundleValue(args[index + 1]);
      index += 1;
      continue;
    }
    if (arg.startsWith('--bundles=')) {
      requestedBundles = splitBundleValue(arg.slice('--bundles='.length));
      continue;
    }
    forwarded.push(arg);
  }

  return { forwarded, requestedBundles };
}

function wantsDmg(requestedBundles) {
  if (!requestedBundles) return true;
  return requestedBundles.includes('all') || requestedBundles.includes('dmg');
}

function validateBundleRequest(requestedBundles) {
  if (!requestedBundles) return;
  const supported = new Set(['all', 'app', 'dmg']);
  const unsupported = requestedBundles.filter((item) => !supported.has(item));
  if (unsupported.length) {
    throw new Error(`[tauri-build] unsupported macOS bundle target(s): ${unsupported.join(', ')}`);
  }
}

try {
  const { forwarded, requestedBundles } = parseArgs(process.argv.slice(2));
  validateBundleRequest(requestedBundles);
  const identity = createGovernedDesktopBuildIdentity({
    checkpoint: process.env.H2O_STUDIO_BUILD_CHECKPOINT,
    sourceCommit: readExactSourceCommit(),
    builtAt: new Date().toISOString(),
  });
  const buildEnvironment = governedDesktopBuildEnvironment(process.env, identity);

  console.log(`[tauri-build] governed identity ${identity.checkpoint} @ ${identity.sourceCommit}`);

  run('npm', ['run', 'prepare-dist'], buildEnvironment);
  run('tauri', ['build', '--bundles', 'app', ...forwarded], buildEnvironment);

  if (wantsDmg(requestedBundles)) {
    run('node', ['./build-tools/create-dmg.mjs'], buildEnvironment);
  }
} catch (error) {
  console.error(error?.message || error);
  process.exit(1);
}
