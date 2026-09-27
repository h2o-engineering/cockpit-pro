#!/usr/bin/env node
// Read-only source and optional exact-RC validation. No build, tag, GitHub,
// publisher, deployment, or activation commands are invoked.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  createGovernedDesktopBuildIdentity,
  governedDesktopBuildEnvironment,
} from '../../../apps/studio/desktop/build-tools/desktop-build-identity.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const documentPath = 'docs/systems/cross-platform/studio-desktop-component-release-contract.md';
const releaseDocument = read(documentPath);
const facts = contractFacts(releaseDocument);
const semverPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const shaPattern = /^[0-9a-f]{40}$/;
const digestPattern = /^sha256:[0-9a-f]{64}$/;
const checkpointPattern = /^[A-Z][A-Z0-9]*(?:[._-][A-Z0-9]+)*$/;
const expectedFacts = {
  COMPONENT_ID: 'studio-desktop',
  DISPLAY_NAME: 'H2O Studio Desktop',
  NPM_ID: '@h2o/studio-desktop',
  RUST_ID: 'h2o-studio-desktop',
  TAURI_ID: 'org.h2o.studio.desktop',
  VERSION_SOURCE: 'apps/studio/desktop/package.json#version',
  VERSION_SCHEME: 'SemVer',
  VERSION_SYNC_RULE: 'exact-equality-before-rc',
  COMPONENT_VERSION_FORMAT: 'studio-desktop@<SemVer>',
  RC_FORMAT: 'studio-desktop/v<SemVer>/rc.<positive-decimal-integer>',
  RELEASE_ID_FORMAT: 'studio-desktop/v<SemVer>',
  RELEASE_TAG_FORMAT: 'component/studio-desktop/v<SemVer>',
  RC_TAG: 'NONE',
  APP_DIGEST_METHOD: 'bundle-tree-sha256-v1',
  DMG_DIGEST_METHOD: 'sha256-file-v1',
  GITHUB_RELEASE_IS_AUTHORITY: 'NO',
  RELEASE_DECISION_AUTHORITY: 'HDA / Product',
  PUBLICATION_DECISION_AUTHORITY: 'HDA / Product',
  TAG_MECHANICS_OWNER: 'L-H2OCODE-REPOSITORY',
  GITHUB_RELEASE_MECHANICS_OWNER: 'L-H2OCODE-REPOSITORY',
  BUILD_DELIVERY_OWNER: 'L-DEVELOPER-BUILD-DELIVERY-SCOPE-STU',
};

function read(relative) {
  return fs.readFileSync(path.join(root, relative), 'utf8');
}

function contractFacts(document) {
  const match = document.match(/<!-- T05-CONTRACT-FACTS-START -->([\s\S]*?)<!-- T05-CONTRACT-FACTS-END -->/);
  assert.ok(match, 'contract facts block is missing');
  const result = {};
  for (const line of match[1].trim().split(/\r?\n/)) {
    const entry = line.match(/^([A-Z_]+)=(.+)$/);
    assert.ok(entry, 'invalid contract fact: ' + line);
    assert.equal(Object.hasOwn(result, entry[1]), false, 'duplicate contract fact: ' + entry[1]);
    result[entry[1]] = entry[2];
  }
  return result;
}

function strictSemver(value) {
  if (typeof value !== 'string') return false;
  const match = semverPattern.exec(value);
  if (!match || match[0].length !== value.length) return false;
  return !match[4]?.split('.').some((part) => /^\d+$/.test(part) && part.length > 1 && part[0] === '0');
}

function componentVersionId(version) {
  assert.ok(strictSemver(version), 'invalid strict SemVer: ' + version);
  return 'studio-desktop@' + version;
}

function rcId(version, number) {
  assert.ok(strictSemver(version), 'invalid RC version');
  assert.match(String(number), /^[1-9]\d*$/, 'RC number must be positive decimal without a leading zero');
  return 'studio-desktop/v' + version + '/rc.' + number;
}

function releaseTag(version) {
  assert.ok(strictSemver(version), 'invalid tag version');
  return 'component/studio-desktop/v' + version;
}

function versionFromComponentId(value) {
  if (typeof value !== 'string' || !value.startsWith('studio-desktop@')) return null;
  const version = value.slice('studio-desktop@'.length);
  return strictSemver(version) ? version : null;
}

function versionAndRcNumber(value) {
  const match = /^studio-desktop\/v(.+)\/rc\.([1-9]\d*)$/.exec(value);
  return match && match[0].length === value.length && strictSemver(match[1]) ? [match[1], match[2]] : null;
}

function versionFromTag(value) {
  if (typeof value !== 'string' || !value.startsWith('component/studio-desktop/v')) return null;
  const version = value.slice('component/studio-desktop/v'.length);
  return strictSemver(version) ? version : null;
}

function packageVersion(cargoText) {
  const header = /^\[package\][^\S\r\n]*$/m.exec(cargoText);
  assert.ok(header, 'Cargo [package] block missing');
  const remainder = cargoText.slice(header.index + header[0].length);
  const end = remainder.search(/^\[/m);
  const block = end < 0 ? remainder : remainder.slice(0, end);
  const name = /^name\s*=\s*"([^"]+)"/m.exec(block);
  const version = /^version\s*=\s*"([^"]+)"/m.exec(block);
  assert.ok(name && version, 'Cargo package name/version missing');
  return { name: name[1], version: version[1] };
}

function checkSourceIdentityAndVersion(expectedVersion) {
  const npm = JSON.parse(read('apps/studio/desktop/package.json'));
  const tauri = JSON.parse(read('apps/studio/desktop/src-tauri/tauri.conf.json'));
  const cargo = packageVersion(read('apps/studio/desktop/src-tauri/Cargo.toml'));
  const npmLock = JSON.parse(read('package-lock.json'));
  const cargoLock = read('apps/studio/desktop/src-tauri/Cargo.lock');
  const lockedCargo = /\[\[package\]\]\s*\nname = "h2o-studio-desktop"\s*\nversion = "([^"]+)"/.exec(cargoLock);
  assert.equal(npm.name, facts.NPM_ID);
  assert.equal(cargo.name, facts.RUST_ID);
  assert.equal(tauri.identifier, facts.TAURI_ID);
  assert.ok(strictSemver(npm.version), 'canonical package version is not strict SemVer');
  if (expectedVersion !== null) assert.equal(npm.version, expectedVersion, 'version changed from expected value');
  assert.equal(tauri.version, npm.version, 'Tauri version mismatch');
  assert.equal(cargo.version, npm.version, 'Cargo version mismatch');
  assert.equal(npmLock.packages?.['apps/studio/desktop']?.name, npm.name, 'npm lock package name mismatch');
  assert.equal(npmLock.packages?.['apps/studio/desktop']?.version, npm.version, 'npm lock version mismatch');
  assert.ok(lockedCargo, 'Cargo.lock Desktop package entry missing');
  assert.equal(lockedCargo[1], npm.version, 'Cargo.lock version mismatch');
  return npm.version;
}

function requireSource(source, pattern, label) {
  assert.match(source, pattern, label);
}

function checkBuildImplementation() {
  const wrapper = read('apps/studio/desktop/build-tools/tauri-build.mjs');
  const build = read('apps/studio/desktop/src-tauri/build.rs');
  const runtime = read('apps/studio/desktop/src-tauri/src/build_identity.rs');
  const identity = createGovernedDesktopBuildIdentity({
    checkpoint: 'CREI_T05_CHECK',
    sourceCommit: 'a'.repeat(40),
    builtAt: '2026-09-27T00:00:00.000Z',
  });
  assert.deepEqual(identity, {
    checkpoint: 'CREI_T05_CHECK',
    sourceCommit: 'a'.repeat(40),
    builtAt: '2026-09-27T00:00:00.000Z',
  });
  assert.ok(Object.isFrozen(identity));
  assert.equal(governedDesktopBuildEnvironment({}, identity).H2O_STUDIO_BUILD_GOVERNED, 'true');
  assert.throws(() => createGovernedDesktopBuildIdentity({
    checkpoint: 'bad', sourceCommit: 'a'.repeat(40), builtAt: identity.builtAt,
  }));
  assert.throws(() => createGovernedDesktopBuildIdentity({
    checkpoint: identity.checkpoint, sourceCommit: 'short', builtAt: identity.builtAt,
  }));
  requireSource(wrapper, /sourceCommit:\s*readExactSourceCommit\(\)/, 'wrapper must read exact Git HEAD');
  requireSource(wrapper, /builtAt:\s*new Date\(\)\.toISOString\(\)/, 'wrapper must stamp UTC build time');
  requireSource(wrapper, /H2O_STUDIO_BUILD_CHECKPOINT/, 'wrapper must require checkpoint');
  requireSource(wrapper, /governedDesktopBuildEnvironment\(process\.env,\s*identity\)/, 'wrapper must pass governed stamp');
  requireSource(wrapper, /run\('tauri',\s*\['build',\s*'--bundles',\s*'app'/, 'wrapper must build app bundle');
  requireSource(build, /profile == "release" && !governed/, 'release profile must require governed build');
  requireSource(build, /supplied_source_commit != git_sha/, 'build must compare supplied commit to HEAD');
  requireSource(build, /git_dirty = git_output\([\s\S]*?"status",\s*"--porcelain"/, 'build must inspect dirty state');
  for (const key of ['CHECKPOINT', 'SOURCE_COMMIT', 'TIMESTAMP', 'GOVERNED']) {
    requireSource(build, new RegExp('cargo:rustc-env=H2O_STUDIO_BUILD_' + key + '='), 'build missing ' + key + ' stamp');
  }
  requireSource(build, /cargo:rustc-env=H2O_BUILD_DIRTY=\{git_dirty\}/, 'build must stamp dirty state');
  requireSource(build, /cargo:rustc-env=H2O_BUILD_PROFILE=\{profile\}/, 'build must stamp profile');
  for (const field of ['checkpoint', 'source_commit', 'built_at', 'app_version', 'architecture', 'governed']) {
    requireSource(runtime, new RegExp('\\b' + field + ':\\s*'), 'runtime missing ' + field);
  }
  requireSource(runtime, /app_version:\s*env!\("CARGO_PKG_VERSION"\)/, 'runtime version must come from Cargo');
  requireSource(runtime, /architecture:\s*runtime_architecture\(\)/, 'runtime architecture missing');
  requireSource(runtime, /governed:\s*bool/, 'runtime governed state missing');
  // OS and actual clean-tree eligibility are checked against an actual RC input below.
}

function checkArtifactImplementation() {
  const dmg = read('apps/studio/desktop/build-tools/create-dmg.mjs');
  const wrapper = read('apps/studio/desktop/build-tools/tauri-build.mjs');
  requireSource(dmg, /const appBundle = path\.join\(macosBundleRoot,\s*[^;]+\);/, 'app bundle path missing');
  requireSource(dmg, /const dmgPath = path\.join\(dmgBundleRoot,\s*dmgName\)/, 'DMG path missing');
  requireSource(dmg, /createHash\('sha256'\)/, 'DMG SHA-256 missing');
  requireSource(dmg, /const digest = sha256File\(dmgPath\)/, 'final DMG bytes not hashed');
  requireSource(wrapper, /run\('node',\s*\['\.\/build-tools\/create-dmg\.mjs'\]/, 'wrapper must call DMG builder');
  assert.equal(facts.APP_DIGEST_METHOD, 'bundle-tree-sha256-v1');
  assert.equal(facts.DMG_DIGEST_METHOD, 'sha256-file-v1');
  assert.match(releaseDocument, /There is no\s+existing frozen \.app bundle-tree digest/);
  assert.match(releaseDocument, /RC- or Release-bound bytes cannot be replaced in place/);
}

function checkGrammar(version) {
  assert.equal(componentVersionId(version), 'studio-desktop@' + version);
  assert.equal(versionFromComponentId(componentVersionId(version)), version);
  assert.deepEqual(versionAndRcNumber(rcId(version, 1)), [version, '1']);
  assert.equal(versionFromTag(releaseTag(version)), version);
  for (const invalid of ['01.2.3', '1.2.3-01', '1.2', '1.2.3-', '1.2.3+', '1.2.3\n']) {
    assert.equal(strictSemver(invalid), false, 'accepted invalid SemVer: ' + invalid);
  }
  assert.equal(versionAndRcNumber('studio-desktop/v' + version + '/rc.0'), null);
  assert.equal(versionAndRcNumber('studio-desktop/v' + version + '/rc.01'), null);
  assert.equal(versionAndRcNumber('studio-desktop/v' + version + '/rc.1\n'), null);
  assert.equal(versionFromTag('9z.hide.disclaimer-' + version), null);
  assert.equal(versionFromTag('component/studio-desktop/v' + version + '/rc.1'), null);
}

function codePointCompare(left, right) {
  const a = Array.from(left, (character) => character.codePointAt(0));
  const b = Array.from(right, (character) => character.codePointAt(0));
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return a.length - b.length;
}

function fileSha256(file) {
  const hash = createHash('sha256');
  const fd = fs.openSync(file, 'r');
  const buffer = Buffer.allocUnsafe(64 * 1024);
  try {
    for (;;) {
      const bytes = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (bytes === 0) break;
      hash.update(buffer.subarray(0, bytes));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

function bundleTreeSha256(directory) {
  const entries = [];
  function visit(absolute, relative) {
    const stat = fs.lstatSync(absolute);
    let type;
    let value;
    if (stat.isDirectory()) {
      type = 'd';
      value = '';
    } else if (stat.isFile()) {
      type = 'f';
      value = fileSha256(absolute);
    } else if (stat.isSymbolicLink()) {
      type = 'l';
      value = fs.readlinkSync(absolute);
    } else {
      throw new Error('unsupported bundle entry: ' + relative);
    }
    entries.push([relative, type, stat.mode & 0o777, value]);
    if (type === 'd') {
      for (const name of fs.readdirSync(absolute)) {
        visit(path.join(absolute, name), relative === '.' ? name : relative + '/' + name);
      }
    }
  }
  assert.ok(fs.lstatSync(directory).isDirectory(), '.app path is not a directory');
  visit(directory, '.');
  entries.sort((left, right) => codePointCompare(left[0], right[0]));
  const hash = createHash('sha256');
  for (const entry of entries) hash.update(JSON.stringify(entry) + '\n', 'utf8');
  return hash.digest('hex');
}

function exactHead() {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert.equal(result.status, 0, 'cannot read exact Product HEAD');
  return result.stdout.trim();
}

function buildKey(version, sourceCommit, build) {
  return 'studio-desktop/v' + version + '/build/' + build.checkpoint + '/' +
    sourceCommit + '/' + build.builtAt + '/' + build.os + '-' +
    build.architecture + '/governed';
}

function checkRcManifest(manifestPath, version) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  assert.equal(manifest.schema, 'h2o.studio.desktop-rc.v1');
  assert.equal(manifest.componentId, facts.COMPONENT_ID);
  assert.equal(manifest.version, version);
  assert.equal(manifest.componentVersionId, componentVersionId(version));
  const rc = versionAndRcNumber(manifest.rcId);
  assert.ok(rc, 'invalid RC ID');
  assert.equal(rc[0], version);
  assert.match(manifest.sourceCommit, shaPattern, 'RC source commit must be full Git SHA');
  assert.equal(manifest.sourceCommit, exactHead(), 'RC source does not match checked-out Product HEAD');
  const status = spawnSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], {
    cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert.equal(status.status, 0, 'cannot inspect RC source state');
  assert.equal(status.stdout.trim(), '', 'RC source worktree must be clean');
  const build = manifest.build;
  assert.ok(build && typeof build === 'object', 'RC build missing');
  assert.match(build.checkpoint, checkpointPattern);
  assert.equal(new Date(build.builtAt).toISOString(), build.builtAt, 'build time must be exact UTC ISO');
  assert.match(build.os, /^[a-z][a-z0-9-]*$/);
  assert.match(build.architecture, /^[a-z0-9][a-z0-9_-]*$/);
  assert.equal(build.profile, 'release');
  assert.equal(build.governed, true);
  assert.equal(build.sourceDirty, false, 'dirty source is not RC eligible');
  const key = buildKey(version, manifest.sourceCommit, build);
  assert.equal(build.key, key, 'build key mismatch');
  assert.ok(Array.isArray(manifest.artifacts) && manifest.artifacts.length > 0, 'RC artifacts missing');
  const keys = new Set();
  for (const artifact of manifest.artifacts) {
    assert.ok(artifact && ['app', 'dmg'].includes(artifact.kind), 'unsupported artifact kind');
    assert.equal(artifact.version, version);
    assert.equal(artifact.sourceCommit, manifest.sourceCommit);
    assert.equal(artifact.os, build.os);
    assert.equal(artifact.architecture, build.architecture);
    assert.match(artifact.digest, digestPattern);
    assert.equal(artifact.digestMethod, artifact.kind === 'app' ?
      facts.APP_DIGEST_METHOD : facts.DMG_DIGEST_METHOD);
    assert.equal(artifact.key, key + '/artifact/' + artifact.kind + '/' + artifact.digest);
    assert.equal(keys.has(artifact.key), false, 'duplicate artifact key');
    keys.add(artifact.key);
    assert.equal(typeof artifact.path, 'string', 'artifact path missing');
    const absolute = path.resolve(path.dirname(manifestPath), artifact.path);
    assert.ok(absolute.endsWith(artifact.kind === 'app' ? '.app' : '.dmg'), 'artifact path/kind mismatch');
    if (artifact.kind === 'dmg') {
      assert.ok(fs.lstatSync(absolute).isFile(), 'DMG path is not a regular file');
    }
    const actual = artifact.kind === 'app' ? bundleTreeSha256(absolute) : fileSha256(absolute);
    assert.equal(artifact.digest, 'sha256:' + actual, 'artifact bytes/bundle differ from RC binding');
  }
}

function args() {
  let expectedVersion = null;
  let rcManifest = null;
  const input = process.argv.slice(2);
  for (let i = 0; i < input.length; i += 1) {
    if (input[i] === '--expected-version' && expectedVersion === null) {
      expectedVersion = input[++i];
    } else if (input[i] === '--rc-manifest' && rcManifest === null) {
      rcManifest = input[++i];
    } else {
      throw new Error('unsupported argument: ' + input[i]);
    }
  }
  if (expectedVersion !== null) assert.ok(strictSemver(expectedVersion), 'invalid expected version');
  if (rcManifest !== null) assert.ok(rcManifest, 'missing RC manifest path');
  return { expectedVersion, rcManifest };
}

try {
  const { expectedVersion, rcManifest } = args();
  assert.deepEqual(facts, expectedFacts, 'contract facts drift');
  assert.match(releaseDocument, /GitHub Release is hosted presentation and distribution of an already-approved/);
  assert.match(releaseDocument, /It is not H2O release authority/);
  assert.match(releaseDocument, /No.*tag creation|tag creation,/);
  assert.match(releaseDocument, /historical Product tags keep their|Historical Product tags keep their/);
  const version = checkSourceIdentityAndVersion(expectedVersion);
  checkBuildImplementation();
  checkArtifactImplementation();
  checkGrammar(version);
  if (rcManifest !== null) checkRcManifest(path.resolve(rcManifest), version);
  console.log('STUDIO_DESKTOP_COMPONENT_RELEASE_CONTRACT=PASS');
  console.log('COMPONENT_IDENTITY_VALIDATION=PASS');
  console.log('VERSION_SYNC_VALIDATION=PASS version=' + version);
  console.log('BUILD_IDENTITY_VALIDATION=PASS source-bindings; actual build/OS/clean state requires RC input');
  console.log('ARTIFACT_IDENTITY_VALIDATION=PASS DMG source SHA-256 and distinct digest contract; actual bytes require RC input');
  console.log('RC_IDENTITY_VALIDATION=PASS grammar' + (rcManifest ? ' and manifest bytes; embedded build readback remains separate' : '; no RC supplied'));
  console.log('TAG_GRAMMAR_VALIDATION=PASS');
  console.log('GITHUB_RELEASE_MAPPING_VALIDATION=PASS');
  console.log('AUTHORITY_BOUNDARY_VALIDATION=PASS');
  console.log('NO_PUBLICATION_VALIDATION=PASS read-only validator');
} catch (error) {
  console.error('STUDIO_DESKTOP_COMPONENT_RELEASE_CONTRACT=HOLD ' + (error?.message || error));
  process.exitCode = 1;
}
