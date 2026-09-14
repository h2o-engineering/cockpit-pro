#!/usr/bin/env node
// Lean publisher Batch 1 validator.
//
// Sandbox-only: every fixture repository and every destination lives under a
// recorded mkdtemp root. This suite never touches live generated output, never
// creates the canonical delivery anchor, and performs no browser action.

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  LeanPublisherError,
  acquireLock,
  releaseLock,
  inspectPublisherLock,
  prepareLockCandidate,
  publishLockCandidate,
  discardLockCandidate,
  prepareLockRelease,
  commitLockRelease,
  purgeReleasedLock,
  buildManifest,
  validateStagedAliases,
  validateStagedDevOutput,
  validateStagedExtension,
  validateCrossOutput,
  publisherTargetPolicy,
  DEV_CONTROLS_TARGET,
  STUDIO_LAUNCHER_TARGET,
} from "../../publish/lean-publisher.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..", "..");
const PUBLISHER_REL = "tools/publish/lean-publisher.mjs";
const VALIDATOR_REL = "tools/validation/publish/validate-lean-publisher-v1.mjs";
const PACKAGE_JSON_REL = "package.json";
const PUBLISHER = path.join(ROOT, PUBLISHER_REL);

const FINAL_PATHS = Object.freeze([PACKAGE_JSON_REL, PUBLISHER_REL, VALIDATOR_REL]);
const UNCOMMITTED_MODIFIED = Object.freeze([PUBLISHER_REL, VALIDATOR_REL]);
const UNCOMMITTED_UNTRACKED = Object.freeze([]);
const PUBLICATION_AUTHORITY_ROUND_PATHS = Object.freeze([
  "tools/publish/lean-publisher.mjs",
  "tools/publish/lean-activator.mjs",
  "tools/publish/lean-payload-transaction.mjs",
  "tools/validation/publish/validate-lean-publisher-v1.mjs",
  "tools/validation/publish/validate-lean-activator-v1.mjs",
  "tools/validation/publish/validate-lean-payload-transaction-v1.mjs",
].sort());
const EXPECTED_RUNTIME_SCENARIOS = 64;
const EXPECTED_SCOPE_SCENARIOS = 9;
const LOCK_PENDING_PREFIX = ".h2o-publisher-lock.pending-";
const FORBIDDEN_STALE_PREFIX = ".h2o-publisher-lock.stale-";
const LOCK_RELEASED_PREFIX = ".h2o-publisher-lock.released-";
const LOCK_REQUIRED_FIELDS = Object.freeze([
  "schemaVersion", "ownerId", "pid", "repository", "approvedHead", "startedAt",
]);
const RAW_OS_ERROR_CODES = Object.freeze(["ENOENT", "EEXIST", "ENOTEMPTY", "EINVAL", "EACCES", "EPERM"]);
const DEAD_PID = 2_147_483_646;
const DESTINATION_ENV_NAMES = Object.freeze([
  "H2O_SERVER_DIR",
  "H2O_EXT_OUT_DIR",
  "H2O_EXT_BUILD_ROOT",
  "H2O_PANEL_OUT_DIR",
  "H2O_DEV_DIR_NAME",
  "H2O_SRC_DIR",
  "H2O_ALIAS_MODE",
]);

const runtimeResults = [];
const scopeResults = [];
const temporaryRoots = new Set();
let preservedStagingRoots = [];
let publisherPairProbe = null;
let staleContentionProbe = null;
let churnProbe = null;
let stagedAliasEvidence = null;

function temporaryBase() {
  try { return fs.realpathSync.native(os.tmpdir()); } catch { return os.tmpdir(); }
}
function temporaryRoot(label) {
  const root = fs.mkdtempSync(path.join(temporaryBase(), `h2o-leanpub-${label}-`));
  temporaryRoots.add(root);
  return root;
}
function isWithin(parent, candidate) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
function assertSandboxPath(candidate) {
  assert.equal(
    [...temporaryRoots].some((root) => isWithin(root, candidate)),
    true,
    `path escaped the validator sandbox: ${candidate}`,
  );
}
function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", timeout: 30_000, killSignal: "SIGTERM" }).trim();
}
function run(command, args, options = {}) {
  return spawnSync(command, args, { encoding: "utf8", timeout: 300_000, killSignal: "SIGTERM", ...options });
}
function sorted(values) { return [...values].sort(); }
function sameSet(a, b) { return JSON.stringify(sorted(a)) === JSON.stringify(sorted(b)); }
function lines(value) { return String(value).trim().split("\n").filter(Boolean); }

// ─── scope classification ────────────────────────────────────────────────────

function scopeFailure(message, state) {
  throw new assert.AssertionError({
    message: `${message}: ${JSON.stringify({
      modifiedTracked: sorted(state.modifiedTracked),
      staged: sorted(state.staged),
      untracked: sorted(state.untracked),
      trackedFinal: sorted(state.trackedFinal),
      missingFinal: sorted(state.missingFinal),
    })}`,
  });
}

export function classifyLeanPublisherScope(state) {
  const normalized = {
    modifiedTracked: sorted(state.modifiedTracked ?? []),
    staged: sorted(state.staged ?? []),
    untracked: sorted(state.untracked ?? []),
    trackedFinal: sorted(state.trackedFinal ?? []),
    missingFinal: sorted(state.missingFinal ?? []),
  };
  if (normalized.staged.length) {
    scopeFailure("Lean publisher Batch 1 forbids staged paths", normalized);
  }
  if (sameSet(normalized.modifiedTracked, PUBLICATION_AUTHORITY_ROUND_PATHS) &&
      normalized.untracked.length === 0 && normalized.missingFinal.length === 0) {
    return "studio-publication-authority-uncommitted";
  }
  const uncommitted =
    sameSet(normalized.modifiedTracked, UNCOMMITTED_MODIFIED) &&
    sameSet(normalized.untracked, UNCOMMITTED_UNTRACKED) &&
    sameSet(normalized.trackedFinal, FINAL_PATHS) &&
    normalized.missingFinal.length === 0;
  if (uncommitted) return "uncommitted";
  const committed =
    normalized.modifiedTracked.length === 0 &&
    normalized.untracked.length === 0 &&
    sameSet(normalized.trackedFinal, FINAL_PATHS) &&
    normalized.missingFinal.length === 0;
  if (committed) return "committed-clean";
  scopeFailure("Lean publisher Batch 1 scope mismatch", normalized);
}

function currentScopeState() {
  return {
    modifiedTracked: lines(git(ROOT, ["diff", "--name-only", "HEAD", "--"])),
    staged: lines(git(ROOT, ["diff", "--cached", "--name-only", "--"])),
    untracked: lines(git(ROOT, ["ls-files", "--others", "--exclude-standard", "--"])),
    trackedFinal: lines(git(ROOT, ["ls-files", "--", ...FINAL_PATHS])),
    missingFinal: FINAL_PATHS.filter((relative) => !fs.existsSync(path.join(ROOT, relative))),
  };
}
function baseScope(overrides = {}) {
  return {
    modifiedTracked: [...UNCOMMITTED_MODIFIED],
    staged: [],
    untracked: [...UNCOMMITTED_UNTRACKED],
    trackedFinal: [...FINAL_PATHS],
    missingFinal: [],
    ...overrides,
  };
}
function scopeTest(name, fn) {
  fn();
  scopeResults.push(name);
  process.stdout.write(`ok scope ${scopeResults.length} - ${name}\n`);
}
function runScopeSelfTests() {
  scopeTest("exact uncommitted copy-mode correction scope is accepted", () => {
    assert.equal(classifyLeanPublisherScope(baseScope()), "uncommitted");
  });
  scopeTest("exact committed-clean Batch 1 scope is accepted", () => {
    assert.equal(classifyLeanPublisherScope(baseScope({
      modifiedTracked: [], untracked: [], trackedFinal: [...FINAL_PATHS],
    })), "committed-clean");
  });
  scopeTest("staging is rejected", () => {
    assert.throws(() => classifyLeanPublisherScope(baseScope({ staged: [PACKAGE_JSON_REL] })), /forbids staged/u);
  });
  scopeTest("missing publisher modification is rejected", () => {
    assert.throws(() => classifyLeanPublisherScope(baseScope({ modifiedTracked: [VALIDATOR_REL] })), /scope mismatch/u);
  });
  scopeTest("missing validator modification is rejected", () => {
    assert.throws(() => classifyLeanPublisherScope(baseScope({ modifiedTracked: [PUBLISHER_REL] })), /scope mismatch/u);
  });
  scopeTest("a third tracked source path is rejected", () => {
    assert.throws(() => classifyLeanPublisherScope(baseScope({
      modifiedTracked: [...UNCOMMITTED_MODIFIED, "tools/dev/dev-all.mjs"],
    })), /scope mismatch/u);
  });
  scopeTest("an untracked source path is rejected", () => {
    assert.throws(() => classifyLeanPublisherScope(baseScope({
      untracked: ["tools/publish/extra.mjs"],
    })), /scope mismatch/u);
  });
  scopeTest("a missing final path is rejected", () => {
    assert.throws(() => classifyLeanPublisherScope(baseScope({ missingFinal: [PUBLISHER_REL] })), /scope mismatch/u);
  });
  scopeTest("exact Studio publication-authority round is accepted without staging", () => {
    assert.equal(classifyLeanPublisherScope(baseScope({
      modifiedTracked: [...PUBLICATION_AUTHORITY_ROUND_PATHS],
    })), "studio-publication-authority-uncommitted");
  });
  assert.equal(scopeResults.length, EXPECTED_SCOPE_SCENARIOS);
}

async function test(name, fn) {
  await fn();
  runtimeResults.push(name);
  process.stdout.write(`ok ${runtimeResults.length} - ${name}\n`);
}

// ─── fixtures ────────────────────────────────────────────────────────────────

const ICON_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

/**
 * A publishable fixture: a real clone of this repository (so the accepted
 * foundation commits exist), on branch main, with the gitignored build inputs
 * provided and the working tree committed clean.
 */
function createPublishableFixture(label) {
  const top = temporaryRoot(label);
  const repository = path.join(top, "h2o-cp-source");
  execFileSync("git", ["clone", "--quiet", "--local", ROOT, repository], {
    cwd: top, encoding: "utf8", timeout: 120_000, killSignal: "SIGTERM",
  });
  git(repository, ["checkout", "--quiet", "-B", "main", "HEAD"]);
  git(repository, ["config", "user.name", "Lean Publisher Validator"]);
  git(repository, ["config", "user.email", "lean-publisher@example.invalid"]);

  const dependencyRoot = fs.existsSync(path.join(ROOT, "node_modules"))
    ? path.join(ROOT, "node_modules")
    : path.resolve(ROOT, "..", "..", "h2o-cp-source", "node_modules");
  fs.mkdirSync(path.join(repository, "node_modules"), { recursive: true });
  for (const entry of fs.readdirSync(dependencyRoot)) {
    const link = path.join(repository, "node_modules", entry);
    if (!fs.existsSync(link)) fs.symlinkSync(path.join(dependencyRoot, entry), link);
  }
  const canonicalMainRoot = path.resolve(ROOT, "..", "..", "h2o-cp-source");
  for (const relative of ["assets/chrome-dev-controls-icons", "assets/chrome-dev-lean-icons", "assets/internal-dev-controls-icons"]) {
    const source = fs.existsSync(path.join(ROOT, relative))
      ? path.join(ROOT, relative) : path.join(canonicalMainRoot, relative);
    if (!fs.existsSync(source)) continue;
    const destination = path.join(repository, relative);
    fs.mkdirSync(destination, { recursive: true });
    for (const file of fs.readdirSync(source)) {
      const from = path.join(source, file);
      if (fs.statSync(from).isFile()) fs.copyFileSync(from, path.join(destination, file));
    }
  }
  const localConfig = fs.existsSync(path.join(ROOT, "config/local/identity-provider.local.json"))
    ? path.join(ROOT, "config/local/identity-provider.local.json")
    : path.join(canonicalMainRoot, "config/local/identity-provider.local.json");
  if (fs.existsSync(localConfig)) {
    fs.mkdirSync(path.join(repository, "config/local"), { recursive: true });
    fs.copyFileSync(localConfig, path.join(repository, "config/local/identity-provider.local.json"));
  }
  // Copy the exact publisher under test. Before the Batch 1 checkpoint this adds
  // an uncommitted file; in committed-clean validation it is already identical.
  fs.copyFileSync(PUBLISHER, path.join(repository, PUBLISHER_REL));

  git(repository, ["add", "-A"]);
  if (git(repository, ["diff", "--cached", "--name-only"])) {
    git(repository, ["commit", "-q", "-m", "fixture: lean publisher build inputs"]);
  }
  assert.equal(git(repository, ["status", "--porcelain=v1"]), "");
  return { top, repository };
}

function publisherEnvironment(overrides = {}) {
  const environment = { ...process.env };
  for (const name of Object.keys(environment)) {
    if (name.startsWith("H2O_")) delete environment[name];
  }
  return { ...environment, ...overrides };
}

function runPublisher(fixture, { args = ["--stage-only"], env = {} } = {}) {
  const result = run(process.execPath, [path.join(fixture.repository, PUBLISHER_REL), ...args], {
    cwd: fixture.repository,
    env: publisherEnvironment(env),
  });
  let receipt = null;
  const match = String(result.stdout || "").match(/receipt\s+:\s+(\S+)/u);
  if (match && fs.existsSync(match[1])) receipt = JSON.parse(fs.readFileSync(match[1], "utf8"));
  const stagingMatch = String(result.stdout || "").match(/staging root\s+:\s+(\S+)/u);
  return { result, receipt, stagingRoot: stagingMatch ? stagingMatch[1] : null };
}

function errorCodeOf(result) {
  const match = String(result.stderr || "").match(/"error":"([^"]+)"/u);
  return match ? match[1] : null;
}

function syntheticStage(label) {
  const root = temporaryRoot(label);
  const serverRoot = path.join(root, "server");
  const stage = {
    root,
    serverRoot,
    aliasDir: path.join(serverRoot, "alias"),
    devOutputDir: path.join(serverRoot, "dev_output"),
    proxyPackFile: path.join(serverRoot, "dev_output", "proxy", "_paste-pack.ext.txt"),
    extensionRoot: path.join(root, "extension"),
    receiptFile: path.join(root, "publication-receipt.json"),
  };
  fs.mkdirSync(stage.aliasDir, { recursive: true });
  fs.mkdirSync(path.dirname(stage.proxyPackFile), { recursive: true });
  fs.mkdirSync(stage.extensionRoot, { recursive: true });
  return stage;
}

function seedSyntheticSource(label) {
  const root = temporaryRoot(`${label}-src`);
  const worktree = path.join(root, "approved");
  fs.mkdirSync(path.join(worktree, "src-runtime-base"), { recursive: true });
  fs.writeFileSync(path.join(worktree, "src-runtime-base", "9Z9z. Probe.js"), "probe\n");
  return { repository: worktree, root };
}

function seedProxyPack(stage, buildTimestamp) {
  fs.writeFileSync(stage.proxyPackFile, `// H2O EXT Proxy Pack (header-only)\n// buildTs=${buildTimestamp}\n// count=1\n`);
}

function seedExtension(stage, buildTimestamp) {
  fs.writeFileSync(path.join(stage.extensionRoot, "manifest.json"), JSON.stringify({ manifest_version: 3, name: "x" }));
  fs.writeFileSync(path.join(stage.extensionRoot, "loader.js"), `// build ${buildTimestamp}\n`);
  fs.writeFileSync(path.join(stage.extensionRoot, "bg.js"), "bg\n");
  fs.writeFileSync(path.join(stage.extensionRoot, "title-contract-bridge.js"), "bridge\n");
  fs.mkdirSync(path.join(stage.extensionRoot, "provider"), { recursive: true });
  fs.writeFileSync(path.join(stage.extensionRoot, "provider", "identity-provider-supabase.js"), "provider\n");
}

function expectPublisherError(code, fn) {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof LeanPublisherError, `expected LeanPublisherError, got ${error?.name}`);
    assert.equal(error.code, code);
    return error;
  }
  assert.fail(`expected LeanPublisherError ${code}`);
}

// ─── contention harness ──────────────────────────────────────────────────────

/** Support directories that must never survive a completed round. */
function lockResidue(parentDirectory) {
  return fs.readdirSync(parentDirectory)
    .filter((name) => name.startsWith(LOCK_PENDING_PREFIX)
      || name.startsWith(FORBIDDEN_STALE_PREFIX)
      || name.startsWith(LOCK_RELEASED_PREFIX))
    .sort();
}

function lockIdentity(lockDirectory) {
  const lockStat = fs.lstatSync(lockDirectory, { bigint: true });
  const metadataFile = path.join(lockDirectory, "lock.json");
  const metadataStat = fs.lstatSync(metadataFile, { bigint: true });
  const raw = fs.readFileSync(metadataFile);
  const metadata = JSON.parse(raw.toString("utf8"));
  return {
    lockPath: lockDirectory,
    lockInode: String(lockStat.ino),
    lockMode: String(lockStat.mode),
    lockMtimeNs: String(lockStat.mtimeNs),
    metadataInode: String(metadataStat.ino),
    metadataMode: String(metadataStat.mode),
    metadataMtimeNs: String(metadataStat.mtimeNs),
    metadataBytes: raw.length,
    metadataSha256: crypto.createHash("sha256").update(raw).digest("hex"),
    ownerId: metadata.ownerId,
    pid: metadata.pid,
    startedAt: metadata.startedAt,
    repository: metadata.repository,
    approvedHead: metadata.approvedHead,
  };
}

/** Content digest of a fixture tree, ignoring git bookkeeping and node_modules. */
function fixtureManifest(root) {
  const out = [];
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name, "en"))) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute).split(path.sep).join("/");
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) out.push(`L ${relative} ${fs.readlinkSync(absolute)}`);
      else if (stat.isDirectory()) { out.push(`D ${relative}`); walk(absolute); }
      else out.push(`F ${relative} ${stat.size} ${crypto.createHash("sha256").update(fs.readFileSync(absolute)).digest("hex")}`);
    }
  };
  walk(root);
  return crypto.createHash("sha256").update(out.join("\n")).digest("hex");
}

// Each contender spins to a shared start instant, acquires once, records the
// outcome, then HOLDS the process alive until the round is closed — so an
// acquired lock's PID stays live for the whole contention window.
const CONTENDER_SOURCE = `
import fs from "node:fs";
import { acquireLock } from "__PUBLISHER_URL__";
const [, , lock, out, at, done] = process.argv;
const idle = new Int32Array(new SharedArrayBuffer(4));
while (Date.now() < Number(at)) {}
let result;
try {
  const acquired = acquireLock(lock, { pid: process.pid, approvedHead: "contended" });
  result = { ok: true, ownerId: acquired.ownerId, pid: process.pid };
} catch (error) {
  result = {
    ok: false,
    code: typeof error?.code === "string" ? error.code : String(error?.message),
    details: error?.details ?? null,
  };
}
fs.writeFileSync(out, JSON.stringify(result));
const deadline = Date.now() + 20000;
while (!fs.existsSync(done) && Date.now() < deadline) Atomics.wait(idle, 0, 0, 5);
`;

// Retries across a validator-controlled release barrier: it keeps attempting
// until it wins the lock or observes that a DIFFERENT owner has taken over,
// recording every outcome code it saw on the way.
const RELEASE_CONTENDER_SOURCE = `
import fs from "node:fs";
import { acquireLock } from "__PUBLISHER_URL__";
const [, , lock, out, at, done, outgoingOwnerId] = process.argv;
const idle = new Int32Array(new SharedArrayBuffer(4));
while (Date.now() < Number(at)) {}
const codes = [];
let won = null;
const deadline = Date.now() + 15000;
while (Date.now() < deadline) {
  try { won = acquireLock(lock, { pid: process.pid, approvedHead: "incoming" }); break; }
  catch (error) {
    const code = typeof error?.code === "string" ? error.code : String(error?.message);
    codes.push(code);
    if (code === "publisher-already-running" && error?.details?.ownerId
        && error.details.ownerId !== outgoingOwnerId) break;
  }
  Atomics.wait(idle, 0, 0, 2);
}
fs.writeFileSync(out, JSON.stringify({ pid: process.pid, ownerId: won ? won.ownerId : null, codes }));
const hold = Date.now() + 20000;
while (won && !fs.existsSync(done) && Date.now() < hold) Atomics.wait(idle, 0, 0, 5);
`;

// Repeated acquire/hold/release cycles. An exclusive sentinel makes two
// simultaneous owners impossible to miss.
const CHURN_WORKER_SOURCE = `
import fs from "node:fs";
import { acquireLock, releaseLock } from "__PUBLISHER_URL__";
const [, , lock, sentinel, out, at, iterations] = process.argv;
const idle = new Int32Array(new SharedArrayBuffer(4));
while (Date.now() < Number(at)) {}
const codes = {};
let acquired = 0, violations = 0;
for (let i = 0; i < Number(iterations); i += 1) {
  let owned = null;
  try { owned = acquireLock(lock, { pid: process.pid, approvedHead: "churn" }); }
  catch (error) {
    const code = typeof error?.code === "string" ? error.code : String(error?.message);
    codes[code] = (codes[code] || 0) + 1;
  }
  if (!owned) { Atomics.wait(idle, 0, 0, 1); continue; }
  acquired += 1;
  try { fs.writeFileSync(sentinel, String(process.pid), { flag: "wx" }); } catch { violations += 1; }
  Atomics.wait(idle, 0, 0, 1);
  try { fs.rmSync(sentinel, { force: true }); } catch {}
  releaseLock(lock, process.pid, owned.ownerId);
}
fs.writeFileSync(out, JSON.stringify({ pid: process.pid, acquired, violations, codes }));
`;

function writeWorker(directory, name, source) {
  const file = path.join(directory, name);
  fs.writeFileSync(file, source.replace("__PUBLISHER_URL__", pathToFileURL(PUBLISHER).href));
  return file;
}

function spawnWorker(worker, args) {
  return new Promise((resolve) => {
    spawn(process.execPath, [worker, ...args], { stdio: "ignore" }).on("exit", resolve);
  });
}

async function waitForFiles(files, ticks = 600) {
  for (let waited = 0; waited < ticks; waited += 1) {
    if (files.every((file) => fs.existsSync(file))) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}

function readResults(files) {
  return files.map((file) => {
    try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
  }).filter(Boolean);
}

async function contendedRounds({ label, rounds, contenders, seedStaleLock }) {
  const root = temporaryRoot(`contend-${label}`);
  const worker = path.join(root, "contender.mjs");
  fs.writeFileSync(worker, CONTENDER_SOURCE.replace("__PUBLISHER_URL__", pathToFileURL(PUBLISHER).href));

  const outcomes = [];
  for (let index = 0; index < rounds; index += 1) {
    const directory = path.join(root, `round-${index}`);
    fs.mkdirSync(directory, { recursive: true });
    const lock = path.join(directory, ".h2o-publisher-lock");
    const done = path.join(directory, "done");
    let staleOwnerId = null;
    let staleBefore = null;
    if (seedStaleLock) {
      staleOwnerId = acquireLock(lock, { pid: DEAD_PID, approvedHead: "stale" }).ownerId;
      staleBefore = lockIdentity(lock);
    }

    const at = Date.now() + 200;
    const outputs = Array.from({ length: contenders }, (_, n) => path.join(directory, `c${n}.json`));
    const exits = outputs.map((out) => new Promise((resolve) => {
      spawn(process.execPath, [worker, lock, out, String(at), done], { stdio: "ignore" })
        .on("exit", resolve);
    }));
    // Close the round only once every contender has recorded its outcome.
    for (let waited = 0; waited < 400; waited += 1) {
      if (outputs.every((out) => fs.existsSync(out))) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    fs.writeFileSync(done, "");
    await Promise.all(exits);

    const results = outputs.map((out) => {
      try { return JSON.parse(fs.readFileSync(out, "utf8")); }
      catch { return { ok: false, code: "no-result", details: null }; }
    });
    const winners = results.filter((r) => r.ok);
    const losers = results.filter((r) => !r.ok);
    const metadataFile = path.join(lock, "lock.json");
    const finalMetadata = fs.existsSync(metadataFile)
      ? JSON.parse(fs.readFileSync(metadataFile, "utf8"))
      : null;
    const staleAfter = seedStaleLock ? lockIdentity(lock) : null;
    if (winners.length === 1 && finalMetadata) releaseLock(lock, winners[0].pid, winners[0].ownerId);

    outcomes.push({
      index,
      contenders,
      winners,
      losers,
      rawOsErrors: losers.filter((l) => RAW_OS_ERROR_CODES.includes(l.code)),
      finalMetadata,
      staleOwnerId,
      staleBefore,
      staleAfter,
      lockAfterRelease: fs.existsSync(lock),
      residue: lockResidue(directory),
    });
  }
  return outcomes;
}

// ─── runtime scenarios ───────────────────────────────────────────────────────

async function runRuntimeScenarios() {
  const publisherSource = fs.readFileSync(PUBLISHER, "utf8");

  await test("publisher implements no activation, promotion, Chrome, canary or push operation", () => {
    assert.doesNotMatch(publisherSource, /\bactivate\s*\(|promoteDelivery|stageToLive|renameSync\([^)]*live/u);
    assert.doesNotMatch(publisherSource, /puppeteer|playwright|chrome:\/\/|--remote-debugging-port|browserCanary\s*\(/u);
    assert.match(publisherSource, /activationPerformed: false/u);
    assert.match(publisherSource, /browserReloadPerformed: false/u);
    assert.match(publisherSource, /browserCanaryPerformed: false/u);
    assert.match(publisherSource, /pushPerformed: false/u);
    assert.doesNotMatch(publisherSource, /["']push["']/u);
  });
  await test("publisher uses no lease or token material and strips inherited H2O_* destinations", () => {
    assert.doesNotMatch(publisherSource, /acquireLease|verifyLease|ownershipToken|H2O_CANONICAL_DELIVERY_TOKEN/u);
    assert.match(publisherSource, /startsWith\("H2O_"\)\) delete environment\[name\]/u);
    assert.match(publisherSource, /anchor\.cockpitProRoot, LOCK_DIR_NAME/u);
    assert.doesNotMatch(publisherSource, /anchor\.root, LOCK_DIR_NAME/u);
    assert.doesNotMatch(publisherSource, /H2O_ALIAS_MODE:\s*["']symlink["']/u);
  });
  await test("publisher independently pins Dev Controls and one-unit Studio staging policies", () => {
    const dev = publisherTargetPolicy(DEV_CONTROLS_TARGET);
    const studio = publisherTargetPolicy(STUDIO_LAUNCHER_TARGET);
    assert.deepEqual(dev.outputFamilies, ["alias", "devOutput", "extension"]);
    assert.deepEqual(studio.outputFamilies, ["extension"]);
    assert.equal(studio.artifactBasename, "studio-launcher");
    assert.equal(studio.expectedExtensionId, "bpobkkppdlldlkccaehmpfclmkhiemhg");
    assert.equal(studio.exactCanonicalHeadRequired, true);
    assert.throws(() => publisherTargetPolicy("caller-selected-path"), LeanPublisherError);
  });

  // ── lock ───────────────────────────────────────────────────────────────────
  await test("lock acquires atomically and records complete metadata", () => {
    const root = temporaryRoot("lock-acquire");
    const lock = path.join(root, ".h2o-publisher-lock");
    const acquired = acquireLock(lock, { pid: process.pid, approvedHead: "abc" });
    assert.equal(fs.statSync(lock).isDirectory(), true);
    const metadata = JSON.parse(fs.readFileSync(path.join(lock, "lock.json"), "utf8"));
    for (const field of LOCK_REQUIRED_FIELDS) assert.notEqual(metadata[field], undefined, field);
    assert.equal(metadata.pid, process.pid);
    assert.equal(metadata.approvedHead, "abc");
    assert.equal(metadata.ownerId, acquired.ownerId);
    assert.match(metadata.ownerId, /^[0-9a-f-]{36}$/u);
    // The lock became visible in one step with no support-directory remnant.
    assert.deepEqual(fs.readdirSync(root), [".h2o-publisher-lock"]);
  });
  await test("a second publisher is blocked while a live owner holds the lock", () => {
    const root = temporaryRoot("lock-block");
    const lock = path.join(root, ".h2o-publisher-lock");
    acquireLock(lock, { pid: process.pid, approvedHead: "abc" });
    const error = expectPublisherError("publisher-already-running", () =>
      acquireLock(lock, { pid: process.pid + 1, approvedHead: "def" }));
    assert.equal(error.details.ownerPid, process.pid);
  });
  await test("a stale dead-PID lock fails closed without mutation", () => {
    const root = temporaryRoot("lock-stale");
    const lock = path.join(root, ".h2o-publisher-lock");
    acquireLock(lock, { pid: DEAD_PID, approvedHead: "stale" });
    const before = lockIdentity(lock);
    const error = expectPublisherError("publisher-lock-stale", () =>
      acquireLock(lock, { pid: process.pid, approvedHead: "fresh" }));
    assert.deepEqual(Object.keys(error.details).sort(), [
      "approvedHead", "lockPath", "pid", "repository", "startedAt",
    ]);
    assert.equal(error.details.pid, DEAD_PID);
    assert.equal(error.details.lockPath, lock);
    assert.deepEqual(lockIdentity(lock), before);
    assert.deepEqual(fs.readdirSync(root), [".h2o-publisher-lock"]);
  });
  await test("release requires matching owner id and pid, and stays in finally", () => {
    const mine = path.join(temporaryRoot("lock-release"), ".h2o-publisher-lock");
    const owned = acquireLock(mine, { pid: process.pid, approvedHead: "abc" });
    releaseLock(mine, process.pid, "a-different-owner-id");
    assert.equal(fs.existsSync(mine), true, "a foreign owner id must not release");
    releaseLock(mine, process.pid + 5, owned.ownerId);
    assert.equal(fs.existsSync(mine), true, "a foreign pid must not release");
    releaseLock(mine, process.pid, owned.ownerId);
    assert.equal(fs.existsSync(mine), false);
    const theirs = path.join(temporaryRoot("lock-foreign"), ".h2o-publisher-lock");
    const other = acquireLock(theirs, { pid: process.pid + 5, approvedHead: "other" });
    releaseLock(theirs, process.pid, other.ownerId);
    assert.equal(fs.existsSync(theirs), true);
  });

  // ── end-to-end stage-only ─────────────────────────────────────────────────
  const fixture = createPublishableFixture("e2e");
  let staged = null;
  await test("stage-only publisher succeeds in a clean fixture repository", () => {
    staged = runPublisher(fixture);
    assert.equal(staged.result.status, 0, staged.result.stderr);
    assert.ok(staged.receipt, "receipt was not produced");
    assertSandboxPath(fixture.repository);
    preservedStagingRoots.push(staged.stagingRoot);
  });
  let studioStaged = null;
  await test("real isolated Studio target stages one exact validated launcher generation", () => {
    const canonicalStudio = path.join(fixture.repository,
      "apps", "extensions", "chatgpt", "chrome", "studio-launcher");
    const canonicalBefore = fs.existsSync(canonicalStudio) ? fixtureManifest(canonicalStudio) : null;
    const authorizedHead = git(fixture.repository, ["rev-parse", "HEAD"]);
    studioStaged = runPublisher(fixture, { args: ["--stage-only", "--target", "studio-launcher",
      "--authorized-head", authorizedHead] });
    assert.equal(studioStaged.result.status, 0, studioStaged.result.stderr);
    assert.ok(studioStaged.receipt, "Studio stage receipt was not produced");
    preservedStagingRoots.push(studioStaged.stagingRoot);
    const receipt = studioStaged.receipt;
    assert.equal(receipt.schemaVersion, 2);
    assert.equal(receipt.publicationTarget, "studio-launcher");
    assert.deepEqual(receipt.outputFamilies, ["extension"]);
    assert.equal(receipt.authorizedHead, authorizedHead);
    assert.equal(receipt.sourceAuthority.head, authorizedHead);
    assert.equal(receipt.expectedExtensionId, "bpobkkppdlldlkccaehmpfclmkhiemhg");
    assert.match(receipt.generationId, /^[a-f0-9]{64}$/u);
    assert.equal(receipt.validatorResult.extension.exactFileSet, true);
    assert.equal(receipt.validatorResult.extension.extensionId, receipt.expectedExtensionId);
    assert.deepEqual(receipt.validatorResult.extension.requiredLoadOrder,
      ["platform/selectors.contract.js", "platform/html-sanitizer.js",
        "renderer/safety/sanitizer-policy.v1.js",
        "renderer/safety/vendor/dompurify/purify.js",
        "renderer/safety/html-sanitizer.v2.js",
        "renderer/chat-renderer.studio.js", "studio.js"]);
    assert.equal(fs.existsSync(path.join(receipt.outputPaths.extension,
      "surfaces", "studio", "renderer", "chat-renderer.studio.js")), true);
    assert.equal(fs.existsSync(path.join(receipt.outputPaths.extension,
      "surfaces", "studio", "S0D3e. 🎬 Transcript Studio Host - Studio.js")), true);
    assert.equal(receipt.canonicalBaseline.state, canonicalBefore === null ? "absent" : "present");
    assert.equal(fs.existsSync(canonicalStudio), canonicalBefore !== null,
      "isolated stage must not create or remove canonical Studio");
    if (canonicalBefore !== null) assert.equal(fixtureManifest(canonicalStudio), canonicalBefore);
    for (const flag of ["activationPerformed", "runtimeActivationPerformed", "browserReloadPerformed",
      "browserCanaryPerformed", "deploymentPerformed", "releasePerformed", "pushPerformed"]) {
      assert.equal(receipt[flag], false, flag);
    }
  });
  await test("Studio staging rejects an older ancestral source before building", () => {
    const oldRoot = path.join(fixture.top, "older-source");
    git(fixture.repository, ["worktree", "add", "--quiet", "--detach", oldRoot, "HEAD^"]);
    const authorizedHead = git(fixture.repository, ["rev-parse", "HEAD"]);
    try {
      const attempt = runPublisher(fixture, { args: ["--stage-only", "--target", "studio-launcher",
        "--authorized-head", authorizedHead, "--source-worktree", oldRoot] });
      assert.equal(attempt.result.status, 1);
      assert.equal(errorCodeOf(attempt.result), "authorized-head-mismatch");
      assert.equal(attempt.stagingRoot, null);
    } finally {
      git(fixture.repository, ["worktree", "remove", "--force", oldRoot]);
    }
  });
  await test("staged alias directory exists and contains aliases", () => {
    const aliasDir = staged.receipt.outputPaths.alias;
    assert.equal(fs.statSync(aliasDir).isDirectory(), true);
    assert.ok(fs.readdirSync(aliasDir).length > 0);
  });
  await test("staged aliases use effective copy mode with safe compatibility links", () => {
    const aliasDir = staged.receipt.outputPaths.alias;
    const entries = fs.readdirSync(aliasDir).filter((name) => name !== ".DS_Store");
    const regularFiles = entries.filter((name) => fs.lstatSync(path.join(aliasDir, name)).isFile());
    const symlinks = entries.filter((name) => fs.lstatSync(path.join(aliasDir, name)).isSymbolicLink());
    assert.ok(regularFiles.length > 0, "copy mode must produce regular-file aliases");
    assert.equal(staged.receipt.validatorResult.alias.aliasCount, entries.length);
    assert.equal(staged.receipt.validatorResult.alias.regularFileCount, regularFiles.length);
    assert.equal(staged.receipt.validatorResult.alias.symlinkCount, symlinks.length);
    stagedAliasEvidence = {
      aliasCount: entries.length,
      regularFileCount: regularFiles.length,
      symlinkCount: symlinks.length,
      candidateCopyManifestEqual: false,
      manifestDigest: staged.receipt.treeDigests.alias,
    };
  });
  await test("no staged alias is a broken symlink", () => {
    const aliasDir = staged.receipt.outputPaths.alias;
    for (const name of fs.readdirSync(aliasDir)) {
      const alias = path.join(aliasDir, name);
      if (!fs.lstatSync(alias).isSymbolicLink()) continue;
      assert.equal(fs.existsSync(alias), true, `broken alias: ${name}`);
    }
  });
  await test("every staged alias link stays inside the staged alias tree or approved source", () => {
    const aliasDir = staged.receipt.outputPaths.alias;
    const approved = fs.realpathSync(fixture.repository);
    const stagedAliasRoot = fs.realpathSync(aliasDir);
    for (const name of fs.readdirSync(aliasDir)) {
      const alias = path.join(aliasDir, name);
      if (!fs.lstatSync(alias).isSymbolicLink()) continue;
      const resolved = fs.realpathSync(alias);
      assert.equal(
        isWithin(stagedAliasRoot, resolved) || isWithin(approved, resolved),
        true,
        `escaped alias: ${name}`,
      );
    }
  });
  await test("staged dev output holds one non-empty proxy pack with the publisher build marker", () => {
    const pack = staged.receipt.outputPaths.proxyPack;
    assert.equal(fs.statSync(pack).isFile(), true);
    assert.ok(fs.statSync(pack).size > 0);
    assert.match(fs.readFileSync(pack, "utf8"), new RegExp(`^// buildTs=${staged.receipt.buildTimestamp}$`, "mu"));
  });
  await test("staged extension contains every required non-empty file", () => {
    for (const relative of ["manifest.json", "loader.js", "bg.js", "title-contract-bridge.js", "provider/identity-provider-supabase.js"]) {
      const file = path.join(staged.receipt.outputPaths.extension, relative);
      assert.equal(fs.existsSync(file), true, relative);
      assert.ok(fs.statSync(file).size > 0, relative);
    }
    const manifest = JSON.parse(fs.readFileSync(path.join(staged.receipt.outputPaths.extension, "manifest.json"), "utf8"));
    assert.ok(manifest.manifest_version, "staged manifest must parse as a manifest object");
  });
  await test("staged extension loader embeds the publisher build marker", () => {
    const loader = fs.readFileSync(path.join(staged.receipt.outputPaths.extension, "loader.js"), "utf8");
    assert.ok(loader.includes(staged.receipt.buildTimestamp));
  });
  await test("all staged outputs remain under one staging root", () => {
    for (const target of Object.values(staged.receipt.outputPaths)) {
      assert.equal(isWithin(staged.receipt.stagingRoot, target), true, target);
    }
    assert.equal(isWithin(temporaryBase(), staged.receipt.stagingRoot), true);
    assert.equal(isWithin(ROOT, staged.receipt.stagingRoot), false);
  });
  await test("receipt reports stage-only with activation and browser work absent", () => {
    assert.equal(staged.receipt.schemaVersion, 1);
    assert.equal(staged.receipt.mode, "stage-only");
    assert.equal(staged.receipt.branch, "main");
    assert.equal(staged.receipt.activationPerformed, false);
    assert.equal(staged.receipt.browserReloadPerformed, false);
    assert.equal(staged.receipt.browserCanaryPerformed, false);
    assert.equal(staged.receipt.pushPerformed, false);
    assert.equal(staged.receipt.approvedHead, git(fixture.repository, ["rev-parse", "HEAD"]));
  });
  await test("receipt carries no token, digest, signature or session material", () => {
    const raw = JSON.stringify(staged.receipt);
    assert.doesNotMatch(raw, /ownershipToken|tokenSha256|tokenCorrelationPrefix|signature|privateKey|capability/u);
  });
  await test("receipt records per-family digests and manifests are deterministic", () => {
    for (const family of ["alias", "devOutput", "extension"]) {
      assert.match(staged.receipt.treeDigests[family], /^[0-9a-f]{64}$/u);
      assert.ok(staged.receipt.fileCounts[family] > 0);
    }
    const first = buildManifest(staged.receipt.outputPaths.extension, staged.receipt.stagingRoot);
    const second = buildManifest(staged.receipt.outputPaths.extension, staged.receipt.stagingRoot);
    assert.equal(first.treeDigest, second.treeDigest);
    assert.equal(first.treeDigest, staged.receipt.treeDigests.extension);
  });
  await test("staged alias manifest survives a verbatim sibling candidate copy", () => {
    const sourceRoot = staged.receipt.stagingRoot;
    const sourceAlias = staged.receipt.outputPaths.alias;
    const candidateRoot = temporaryRoot("alias-candidate");
    const candidateAlias = path.join(candidateRoot, path.relative(sourceRoot, sourceAlias));
    assert.equal(path.dirname(candidateRoot), path.dirname(sourceRoot));
    assert.equal(fs.statSync(candidateRoot).dev, fs.statSync(sourceRoot).dev);
    fs.mkdirSync(path.dirname(candidateAlias), { recursive: true });
    fs.cpSync(sourceAlias, candidateAlias, { recursive: true, verbatimSymlinks: true });

    const sourceManifest = buildManifest(sourceAlias, sourceRoot);
    const candidateManifest = buildManifest(candidateAlias, candidateRoot);
    assert.deepEqual(candidateManifest, sourceManifest);

    const linkTargets = (root) => Object.fromEntries(fs.readdirSync(root)
      .filter((name) => fs.lstatSync(path.join(root, name)).isSymbolicLink())
      .sort()
      .map((name) => [name, fs.readlinkSync(path.join(root, name))]));
    const regularBytes = (root) => Object.fromEntries(fs.readdirSync(root)
      .filter((name) => fs.lstatSync(path.join(root, name)).isFile())
      .sort()
      .map((name) => [name, fs.readFileSync(path.join(root, name)).toString("base64")]));
    assert.deepEqual(linkTargets(candidateAlias), linkTargets(sourceAlias));
    assert.deepEqual(regularBytes(candidateAlias), regularBytes(sourceAlias));
    stagedAliasEvidence.candidateCopyManifestEqual = true;
  });
  await test("a successful run preserves its staging root for the activation batch", () => {
    assert.equal(fs.existsSync(staged.receipt.stagingRoot), true);
    assert.equal(fs.existsSync(path.join(staged.receipt.stagingRoot, "publication-receipt.json")), true);
  });
  await test("a publisher run creates no canonical delivery anchor or lease", () => {
    const anchor = path.resolve(fixture.repository, "..", ".h2o-canonical-delivery");
    assert.equal(fs.existsSync(anchor), false);
    assert.equal(fs.existsSync(path.join(fixture.top, ".h2o-canonical-delivery")), false);
  });
  await test("inherited destination variables cannot redirect staged output", () => {
    const decoy = path.join(temporaryRoot("decoy"), "live-decoy");
    fs.mkdirSync(decoy, { recursive: true });
    const redirected = runPublisher(fixture, {
      env: {
        ...Object.fromEntries(DESTINATION_ENV_NAMES.map((name) => [name, decoy])),
        H2O_ALIAS_MODE: "symlink",
      },
    });
    assert.equal(redirected.result.status, 0, redirected.result.stderr);
    assert.equal(fs.readdirSync(decoy).length, 0, "inherited destination variable redirected output");
    assert.equal(isWithin(temporaryBase(), redirected.receipt.stagingRoot), true);
    assert.ok(redirected.receipt.validatorResult.alias.regularFileCount > 0,
      "hostile inherited symlink mode was not stripped");
    preservedStagingRoots.push(redirected.receipt.stagingRoot);
  });
  await test("repository paths with spaces and emoji source filenames stage safely", () => {
    const spaced = createPublishableFixture("path with spaces 🧪");
    const attempt = runPublisher(spaced);
    assert.equal(attempt.result.status, 0, attempt.result.stderr);
    assert.ok(attempt.receipt, "receipt was not produced for the spaced repository path");
    assert.match(attempt.receipt.repository, /path with spaces 🧪/u);
    assert.ok(attempt.receipt.validatorResult.alias.regularFileCount > 0);
    assert.ok(attempt.receipt.fileCounts.alias > 0);
    preservedStagingRoots.push(attempt.stagingRoot);
  });

  // ── source preflight rejections ───────────────────────────────────────────
  await test("a dirty tracked working tree rejects before building", () => {
    const dirty = createPublishableFixture("dirty");
    fs.appendFileSync(path.join(dirty.repository, "package.json"), "\n");
    const attempt = runPublisher(dirty);
    assert.equal(attempt.result.status, 1);
    assert.equal(errorCodeOf(attempt.result), "worktree-not-clean");
  });
  await test("a non-empty index rejects before building", () => {
    const staged2 = createPublishableFixture("index");
    fs.appendFileSync(path.join(staged2.repository, "package.json"), "\n");
    git(staged2.repository, ["add", "package.json"]);
    const attempt = runPublisher(staged2);
    assert.equal(attempt.result.status, 1);
    assert.ok(["index-not-empty", "worktree-not-clean"].includes(errorCodeOf(attempt.result)));
  });
  await test("untracked non-ignored source rejects before building", () => {
    const untracked = createPublishableFixture("untracked");
    fs.writeFileSync(path.join(untracked.repository, "tools", "stray-source.mjs"), "// stray\n");
    const attempt = runPublisher(untracked);
    assert.equal(attempt.result.status, 1);
    assert.equal(errorCodeOf(attempt.result), "untracked-source-present");
  });
  await test("untracked source created during builders rejects before receipt", () => {
    const raced = createPublishableFixture("untracked-during-build");
    fs.appendFileSync(
      path.join(raced.repository, "tools", "loader", "make-aliases.mjs"),
      '\nfs.writeFileSync(path.join(process.cwd(), "mid-build-untracked.tmp"), "foreign writer\\n");\n',
    );
    git(raced.repository, ["add", "tools/loader/make-aliases.mjs"]);
    git(raced.repository, ["commit", "-q", "-m", "fixture: create untracked source during build"]);

    const before = new Set(fs.readdirSync(temporaryBase()).filter((name) =>
      name.startsWith("h2o-publish-stage-")));
    const attempt = runPublisher(raced);
    const leaked = fs.readdirSync(temporaryBase()).filter((name) =>
      name.startsWith("h2o-publish-stage-") && !before.has(name));
    assert.equal(attempt.result.status, 1);
    assert.equal(errorCodeOf(attempt.result), "source-changed-during-build");
    assert.match(String(attempt.result.stderr), /mid-build-untracked\.tmp/u);
    assert.equal(attempt.receipt, null);
    assert.deepEqual(leaked, [], "mid-build source race left a staging root behind");
    assert.equal(fs.existsSync(path.join(raced.top, ".h2o-publisher-lock")), false);
  });
  await test("a branch other than main rejects before building", () => {
    const branched = createPublishableFixture("branch");
    git(branched.repository, ["checkout", "--quiet", "-b", "not-main"]);
    const attempt = runPublisher(branched);
    assert.equal(attempt.result.status, 1);
    assert.equal(errorCodeOf(attempt.result), "unexpected-branch");
  });
  await test("invalid arguments reject before any lock or staging work", () => {
    for (const args of [[], ["--activate"], ["--stage-only", "--stage-only"]]) {
      const attempt = runPublisher(fixture, { args });
      assert.equal(attempt.result.status, 1);
      assert.equal(errorCodeOf(attempt.result), "invalid-arguments");
    }
  });

  // ── staged-output validation rejections (synthetic stages) ────────────────
  await test("a broken staged alias rejects", () => {
    const stage = syntheticStage("broken-alias");
    const source = seedSyntheticSource("broken-alias");
    fs.symlinkSync(path.join(source.repository, "src-runtime-base", "missing.js"), path.join(stage.aliasDir, "a.js"));
    expectPublisherError("staged-alias-broken-symlink", () => validateStagedAliases(stage, source, [source.repository]));
  });
  await test("a staged alias pointing into another worktree rejects", () => {
    const stage = syntheticStage("foreign-alias");
    const source = seedSyntheticSource("foreign-alias");
    const foreign = path.join(source.root, "foreign-worktree");
    fs.mkdirSync(path.join(foreign, "src-runtime-base"), { recursive: true });
    fs.writeFileSync(path.join(foreign, "src-runtime-base", "9Z9z. Probe.js"), "probe\n");
    fs.symlinkSync(path.join(foreign, "src-runtime-base", "9Z9z. Probe.js"), path.join(stage.aliasDir, "a.js"));
    expectPublisherError("staged-alias-target-outside-source", () =>
      validateStagedAliases(stage, source, [source.repository, foreign]));
  });
  await test("a staged alias pointing into generated output rejects", () => {
    const stage = syntheticStage("generated-alias");
    const source = seedSyntheticSource("generated-alias");
    const generated = path.join(source.repository, "apps", "dev-server", "alias-source.js");
    fs.mkdirSync(path.dirname(generated), { recursive: true });
    fs.writeFileSync(generated, "generated\n");
    fs.symlinkSync(generated, path.join(stage.aliasDir, "a.js"));
    expectPublisherError("staged-alias-generated-target", () =>
      validateStagedAliases(stage, source, [source.repository]));
  });
  await test("an empty staged alias directory rejects", () => {
    const stage = syntheticStage("empty-alias");
    const source = seedSyntheticSource("empty-alias");
    expectPublisherError("staged-alias-empty", () => validateStagedAliases(stage, source, [source.repository]));
    fs.mkdirSync(path.join(stage.aliasDir, "directory-entry"));
    expectPublisherError("staged-alias-entry-type", () =>
      validateStagedAliases(stage, source, [source.repository]));
  });
  await test("a missing staged proxy pack rejects", () => {
    const stage = syntheticStage("missing-pack");
    expectPublisherError("staged-proxy-pack-count", () => validateStagedDevOutput(stage, "1700000000000"));
  });
  await test("a leftover atomic temporary file in staged dev output rejects", () => {
    const stage = syntheticStage("temp-file");
    seedProxyPack(stage, "1700000000000");
    fs.writeFileSync(path.join(path.dirname(stage.proxyPackFile), "._paste-pack.ext.txt.tmp-1-2"), "partial\n");
    expectPublisherError("staged-proxy-temp-file", () => validateStagedDevOutput(stage, "1700000000000"));
  });
  await test("a mismatched staged proxy build marker rejects", () => {
    const stage = syntheticStage("marker");
    seedProxyPack(stage, "1700000000001");
    expectPublisherError("staged-proxy-build-marker-mismatch", () => validateStagedDevOutput(stage, "1700000000000"));
  });
  await test("a missing required staged extension file rejects", () => {
    const stage = syntheticStage("missing-ext");
    const source = seedSyntheticSource("missing-ext");
    seedExtension(stage, "1700000000000");
    fs.rmSync(path.join(stage.extensionRoot, "title-contract-bridge.js"));
    expectPublisherError("staged-extension-file-missing", () =>
      validateStagedExtension(stage, source, "1700000000000", [source.repository]));
  });
  await test("a mismatched staged extension build marker rejects", () => {
    const stage = syntheticStage("ext-marker");
    const source = seedSyntheticSource("ext-marker");
    seedExtension(stage, "1700000000001");
    expectPublisherError("staged-extension-build-marker-mismatch", () =>
      validateStagedExtension(stage, source, "1700000000000", [source.repository]));
  });
  await test("a missing staged family rejects cross-output validation", () => {
    const stage = syntheticStage("cross");
    expectPublisherError("staged-output-missing", () => validateCrossOutput(stage));
  });

  // ── failure cleanup ───────────────────────────────────────────────────────
  await test("a failed staged build removes only its own staging root", () => {
    const broken = createPublishableFixture("child-failure");
    // Break a build input so a builder child fails after staging is created.
    fs.writeFileSync(path.join(broken.repository, "config", "loader-deps.json"), "{ not json\n");
    git(broken.repository, ["add", "-A"]);
    git(broken.repository, ["commit", "-q", "-m", "fixture: break loader deps"]);
    const before = new Set(fs.readdirSync(temporaryBase()).filter((n) => n.startsWith("h2o-publish-stage-")));
    const attempt = runPublisher(broken);
    const after = new Set(fs.readdirSync(temporaryBase()).filter((n) => n.startsWith("h2o-publish-stage-")));
    if (attempt.result.status === 0) {
      // Malformed deps are tolerated by the proxy writer; assert staging is still contained.
      assert.equal(isWithin(temporaryBase(), attempt.receipt.stagingRoot), true);
      preservedStagingRoots.push(attempt.receipt.stagingRoot);
    } else {
      assert.equal([...after].filter((n) => !before.has(n)).length, 0, "failed run left a staging root behind");
    }
    // Previously preserved successful staging roots are untouched either way.
    for (const preserved of preservedStagingRoots) assert.equal(fs.existsSync(preserved), true);
  });
  await test("cleanup never follows a staging symlink and the lock always releases in finally", () => {
    assert.match(publisherSource, /!stat\.isSymbolicLink\(\)/u);
    assert.match(
      publisherSource,
      /\}\s*finally\s*\{\s*releaseLock\(lockDirectory, process\.pid, lock\.ownerId\);/u,
    );
  });

  // ── atomic acquisition corrections ────────────────────────────────────────
  await test("a prepared lock candidate is never visible at the final lock path", () => {
    const root = temporaryRoot("lock-candidate");
    const lock = path.join(root, ".h2o-publisher-lock");
    const candidate = prepareLockCandidate(lock, { pid: process.pid, approvedHead: "candidate" });

    // The candidate is COMPLETE while the final path is still untouched.
    assert.equal(fs.existsSync(lock), false, "final lock path must remain absent");
    assert.equal(path.dirname(candidate.pendingDirectory), root);
    assert.equal(path.basename(candidate.pendingDirectory).startsWith(LOCK_PENDING_PREFIX), true);
    assert.equal((fs.statSync(candidate.pendingDirectory).mode & 0o777).toString(8), "700");
    const pendingMetadataFile = path.join(candidate.pendingDirectory, "lock.json");
    assert.equal((fs.statSync(pendingMetadataFile).mode & 0o777).toString(8), "600");
    const pendingMetadata = JSON.parse(fs.readFileSync(pendingMetadataFile, "utf8"));
    for (const field of LOCK_REQUIRED_FIELDS) assert.notEqual(pendingMetadata[field], undefined, field);

    // A contender observes ABSENT — never a partial final lock — and wins.
    assert.deepEqual(inspectPublisherLock(lock), { state: "absent", metadata: null });
    const contender = acquireLock(lock, { pid: process.pid, approvedHead: "contender" });
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(lock, "lock.json"), "utf8")).ownerId,
      contender.ownerId,
    );

    // Publishing the now-losing candidate is clean contention, not an OS error.
    assert.equal(publishLockCandidate(candidate), false);
    assert.equal(fs.existsSync(candidate.pendingDirectory), false, "pending path must be cleaned");
    const discarded = prepareLockCandidate(lock, { pid: process.pid, approvedHead: "discarded" });
    discardLockCandidate(discarded);
    assert.equal(fs.existsSync(discarded.pendingDirectory), false, "discarded candidate must be removed");

    // An externally created incomplete or malformed lock fails CLOSED and is
    // never deleted — the defect being corrected did exactly the opposite.
    releaseLock(lock, process.pid, contender.ownerId);
    assert.equal(fs.existsSync(lock), false);
    const failClosed = {
      "publisher-lock-incomplete": () => fs.mkdirSync(lock, { recursive: false, mode: 0o700 }),
      "publisher-lock-malformed": () => {
        fs.mkdirSync(lock, { recursive: false, mode: 0o700 });
        fs.writeFileSync(path.join(lock, "lock.json"), "{ not json");
      },
      "publisher-lock-invalid-pid": () => {
        fs.mkdirSync(lock, { recursive: false, mode: 0o700 });
        fs.writeFileSync(path.join(lock, "lock.json"), JSON.stringify({
          schemaVersion: 1, ownerId: "x", pid: "nope", repository: "/r", approvedHead: "h", startedAt: "t",
        }));
      },
      "publisher-lock-symlink": () => {
        const decoy = path.join(root, "decoy");
        fs.mkdirSync(decoy, { recursive: true });
        fs.symlinkSync(decoy, lock);
      },
    };
    for (const [code, seed] of Object.entries(failClosed)) {
      seed();
      expectPublisherError(code, () => acquireLock(lock, { pid: process.pid, approvedHead: "x" }));
      let survived = true;
      try { fs.lstatSync(lock); } catch { survived = false; }
      assert.equal(survived, true, `${code} must not delete the lock`);
      fs.rmSync(lock, { recursive: true, force: true });
    }
    fs.rmSync(path.join(root, "decoy"), { recursive: true, force: true });
    assert.deepEqual(fs.readdirSync(root), [], "no lock support-directory remnant may survive");
  });

  await test("simultaneous acquisition yields exactly one winner in every round", async () => {
    const outcomes = await contendedRounds({
      label: "simultaneous-pairs", rounds: 24, contenders: 2, seedStaleLock: false,
    });
    for (const round of outcomes) {
      assert.equal(round.winners.length, 1, `round ${round.index}: ${JSON.stringify(round)}`);
      assert.equal(round.losers.length, round.contenders - 1);
      assert.deepEqual(
        [...new Set(round.losers.map((l) => l.code))], ["publisher-already-running"],
        `round ${round.index} loser codes: ${JSON.stringify(round.losers.map((l) => l.code))}`,
      );
      assert.equal(round.rawOsErrors.length, 0, JSON.stringify(round.rawOsErrors));
      assert.equal(new Set(round.winners.map((w) => w.ownerId)).size, 1);
      for (const field of LOCK_REQUIRED_FIELDS) assert.notEqual(round.finalMetadata?.[field], undefined, field);
      assert.equal(round.finalMetadata.ownerId, round.winners[0].ownerId);
      assert.equal(round.lockAfterRelease, false, "release must leave no lock");
      assert.deepEqual(round.residue, [], `round ${round.index} residue: ${JSON.stringify(round.residue)}`);
    }
    publisherPairProbe = {
      rounds: outcomes.length,
      contendersPerRound: 2,
      successes: outcomes.reduce((sum, round) => sum + round.winners.length, 0),
      alreadyRunning: outcomes.reduce(
        (sum, round) => sum + round.losers.filter((loser) =>
          loser.code === "publisher-already-running").length,
        0,
      ),
      doubleOwners: outcomes.filter((round) => round.winners.length !== 1).length,
      rawOsErrors: outcomes.reduce((sum, round) => sum + round.rawOsErrors.length, 0),
    };
  });

  await test("simultaneous contenders preserve and reject a stale publisher lock", async () => {
    assert.doesNotMatch(
      publisherSource,
      /\.h2o-publisher-lock\.stale-|quarantine|recoveredStaleLock/u,
    );
    const outcomes = await contendedRounds({
      label: "stale-preservation", rounds: 40, contenders: 8, seedStaleLock: true,
    });
    for (const round of outcomes) {
      assert.equal(round.winners.length, 0, `round ${round.index}: ${JSON.stringify(round)}`);
      assert.equal(round.losers.length, round.contenders);
      assert.deepEqual(
        [...new Set(round.losers.map((loser) => loser.code))], ["publisher-lock-stale"],
        `round ${round.index} loser codes: ${JSON.stringify(round.losers.map((l) => l.code))}`,
      );
      assert.equal(round.rawOsErrors.length, 0, JSON.stringify(round.rawOsErrors));
      assert.equal(round.finalMetadata.ownerId, round.staleOwnerId);
      assert.equal(round.finalMetadata.pid, DEAD_PID);
      assert.equal(round.lockAfterRelease, true);
      assert.deepEqual(round.staleAfter, round.staleBefore);
      for (const loser of round.losers) {
        assert.deepEqual(Object.keys(loser.details).sort(), [
          "approvedHead", "lockPath", "pid", "repository", "startedAt",
        ]);
        assert.equal(loser.details.pid, DEAD_PID);
        assert.equal(loser.details.lockPath, round.staleBefore.lockPath);
      }
      assert.deepEqual(round.residue, [], `round ${round.index} residue: ${JSON.stringify(round.residue)}`);
    }
    staleContentionProbe = {
      rounds: outcomes.length,
      contendersPerRound: 8,
      successes: outcomes.reduce((sum, round) => sum + round.winners.length, 0),
      staleRejections: outcomes.reduce((sum, round) => sum + round.losers.length, 0),
      rawOsErrors: outcomes.reduce((sum, round) => sum + round.rawOsErrors.length, 0),
      preservedLocks: outcomes.filter((round) =>
        JSON.stringify(round.staleAfter) === JSON.stringify(round.staleBefore)).length,
    };
  });

  await test("a real builder failure deterministically removes staging and the lock", () => {
    const broken = createPublishableFixture("deterministic-failure");
    // A real guarded builder that fails AFTER staging has begun.
    fs.writeFileSync(
      path.join(broken.repository, "tools/product/extensions/chatgpt/chrome/build-chrome-live-extension.mjs"),
      'process.stderr.write("deterministic builder failure\\n");\nprocess.exit(7);\n',
    );
    git(broken.repository, ["add", "-A"]);
    git(broken.repository, ["commit", "-q", "-m", "fixture: deterministic builder failure"]);
    const fixtureBefore = fixtureManifest(broken.repository);
    const before = new Set(fs.readdirSync(temporaryBase()).filter((n) => n.startsWith("h2o-publish-stage-")));

    const attempt = runPublisher(broken);

    assert.equal(attempt.result.status, 1, attempt.result.stdout);
    assert.equal(errorCodeOf(attempt.result), "builder-failed");
    assert.match(String(attempt.result.stderr), /"status":\s*7/u);
    const leaked = [...fs.readdirSync(temporaryBase())]
      .filter((n) => n.startsWith("h2o-publish-stage-") && !before.has(n));
    assert.deepEqual(leaked, [], "the failed invocation must remove its own staging root");
    assert.equal(attempt.receipt, null, "no success receipt may be retained");
    assert.equal(fs.existsSync(path.join(broken.top, ".h2o-publisher-lock")), false);
    assert.deepEqual(lockResidue(broken.top), [], "no lock support directory may remain");
    assert.equal(fs.existsSync(path.join(broken.top, ".h2o-canonical-delivery")), false);
    assert.equal(fixtureManifest(broken.repository), fixtureBefore, "fixture output must be byte-identical");
    for (const preserved of preservedStagingRoots) assert.equal(fs.existsSync(preserved), true);
  });

  await test("atomic release never shows contenders an incomplete lock", async () => {
    const root = temporaryRoot("release-contention");
    const lock = path.join(root, ".h2o-publisher-lock");
    const outgoing = acquireLock(lock, { pid: process.pid, approvedHead: "outgoing" });

    // (2) Hold the release exactly at the ownership-verified, pre-rename point.
    const prepared = prepareLockRelease(lock, process.pid, outgoing.ownerId);
    assert.notEqual(prepared, null, "ownership verification must succeed");
    assert.equal(path.basename(prepared.releasedPath).startsWith(LOCK_RELEASED_PREFIX), true);
    assert.equal(path.dirname(prepared.releasedPath), root, "released path must be a sibling");
    assert.equal(fs.existsSync(path.join(lock, "lock.json")), true, "lock stays complete before the rename");
    assert.equal(inspectPublisherLock(lock).state, "live");

    // (3) Synchronized contenders that retry across the barrier.
    const worker = writeWorker(root, "release-contender.mjs", RELEASE_CONTENDER_SOURCE);
    const done = path.join(root, "done");
    const outputs = Array.from({ length: 6 }, (_, n) => path.join(root, `rc${n}.json`));
    const at = Date.now() + 250;
    const exits = outputs.map((out) =>
      spawnWorker(worker, [lock, out, String(at), done, outgoing.ownerId]));
    await new Promise((resolve) => setTimeout(resolve, 450));

    // (4) Let the atomic rename happen, then (5) hold the deletion.
    assert.equal(commitLockRelease(prepared), "released");
    assert.equal(fs.existsSync(prepared.releasedPath), true, "released copy is retained for now");
    await new Promise((resolve) => setTimeout(resolve, 450));
    assert.equal(fs.existsSync(prepared.releasedPath), true, "deletion is still held");

    await waitForFiles(outputs);
    const results = readResults(outputs);
    fs.writeFileSync(done, "");
    await Promise.all(exits);

    // (6) Nothing may have observed a metadata-less lock.
    const seen = results.flatMap((r) => r.codes);
    assert.equal(seen.includes("publisher-lock-incomplete"), false,
      `a contender saw an incomplete lock: ${JSON.stringify(seen)}`);
    assert.deepEqual(seen.filter((c) => RAW_OS_ERROR_CODES.includes(c)), []);
    assert.deepEqual([...new Set(seen)], ["publisher-already-running"], JSON.stringify([...new Set(seen)]));
    const winners = results.filter((r) => r.ownerId);
    assert.equal(winners.length, 1, `expected one next owner, got ${winners.length}`);
    assert.notEqual(winners[0].ownerId, outgoing.ownerId);

    // The outgoing owner must never remove the next owner's lock.
    assert.equal(releaseLock(lock, process.pid, outgoing.ownerId), "not-owned");
    assert.equal(fs.existsSync(lock), true);
    assert.equal(JSON.parse(fs.readFileSync(path.join(lock, "lock.json"), "utf8")).ownerId, winners[0].ownerId);

    purgeReleasedLock(prepared);
    assert.equal(fs.existsSync(prepared.releasedPath), false, "released directory must be removed");
    assert.equal(releaseLock(lock, winners[0].pid, winners[0].ownerId), "released");
    assert.equal(fs.existsSync(lock), false, "the next owner releases cleanly");
    assert.deepEqual(lockResidue(root), [], "no pending, stale or released directory may remain");

    // Acquire/release churn: the window this correction closes, under load.
    const churnRoot = temporaryRoot("release-churn");
    const churnLock = path.join(churnRoot, ".h2o-publisher-lock");
    const sentinel = path.join(churnRoot, "sentinel");
    const churnWorker = writeWorker(churnRoot, "churn.mjs", CHURN_WORKER_SOURCE);
    const churnOutputs = Array.from({ length: 8 }, (_, n) => path.join(churnRoot, `w${n}.json`));
    const churnAt = Date.now() + 300;
    await Promise.all(churnOutputs.map((out) =>
      spawnWorker(churnWorker, [churnLock, sentinel, out, String(churnAt), "60"])));
    const churn = readResults(churnOutputs);
    assert.equal(churn.length, 8, "every churn worker must report");
    const totals = churn.reduce((accumulator, worker) => {
      accumulator.acquired += worker.acquired;
      accumulator.violations += worker.violations;
      for (const [code, count] of Object.entries(worker.codes)) {
        accumulator.codes[code] = (accumulator.codes[code] || 0) + count;
      }
      return accumulator;
    }, { acquired: 0, violations: 0, codes: {} });
    assert.equal(totals.violations, 0, "two simultaneous lock owners during churn");
    assert.ok(totals.acquired > 0, "churn must actually acquire");
    assert.equal(totals.codes["publisher-lock-incomplete"], undefined, JSON.stringify(totals.codes));
    assert.deepEqual(Object.keys(totals.codes).filter((c) => RAW_OS_ERROR_CODES.includes(c)), []);
    assert.deepEqual(
      Object.keys(totals.codes).filter((c) => c !== "publisher-already-running" && c !== "publisher-lock-contended"),
      [], JSON.stringify(totals.codes),
    );
    assert.equal(fs.existsSync(churnLock), false, "churn must end with no lock");
    assert.deepEqual(lockResidue(churnRoot), [], "churn must leave no lock support directory");
    churnProbe = {
      workers: churn.length,
      cyclesPerWorker: 60,
      acquisitions: totals.acquired,
      doubleOwners: totals.violations,
      incompleteErrors: totals.codes["publisher-lock-incomplete"] || 0,
      rawOsErrors: Object.entries(totals.codes)
        .filter(([code]) => RAW_OS_ERROR_CODES.includes(code))
        .reduce((sum, [, count]) => sum + count, 0),
    };
  });

  // ─── Batch 2A-R.1: source-worktree authority ───────────────────────────────
  //
  // Canonical comparison authority (repository / branch / approvedHead) stays
  // pinned to the fixture's own repository. Source artifact authority may be an
  // explicitly selected clean registered sibling worktree. Canonical
  // working-copy dirtiness is irrelevant only in explicit-worktree mode.

  const SENTINEL_REL = "config/h2o-source-authority-sentinel.txt";

  /** Real-aware path normalisation matching the publisher's realAware(). */
  function realpath(target) {
    try { return fs.realpathSync.native(target); } catch { return path.resolve(target); }
  }

  /** Register a sibling worktree of the fixture at `commitish`. */
  function addFixtureWorktree(fixture, label, commitish = "HEAD") {
    const root = path.join(fixture.top, label);
    git(fixture.repository, ["worktree", "add", "--quiet", "--detach", root, commitish]);
    provisionLocalBuildInputs(fixture.repository, root);
    return realpath(root);
  }

  // The stage builders consume local build inputs that are deliberately untracked
  // (dependency tree, icon packs, local identity provider config). A clean committed
  // worktree therefore cannot build on its own: whoever prepares a source worktree
  // must provision the same local inputs the canonical worktree carries. These are
  // all gitignored, so provisioning them leaves the source worktree clean.
  //
  // This models an OPERATOR PREREQUISITE, not committed-source provenance. These
  // bytes are outside sourceAuthority.head/tree by construction, so they are never
  // evidence of which commit produced an artifact — see P-R11, which proves source
  // selection using committed product source only.
  function provisionLocalBuildInputs(from, to) {
    const dependencies = path.join(from, "node_modules");
    if (fs.existsSync(dependencies)) {
      const target = path.join(to, "node_modules");
      fs.mkdirSync(target, { recursive: true });
      for (const entry of fs.readdirSync(dependencies)) {
        const link = path.join(target, entry);
        if (!fs.existsSync(link)) fs.symlinkSync(path.join(dependencies, entry), link);
      }
    }
    for (const relative of [
      "assets/chrome-dev-controls-icons",
      "assets/chrome-dev-lean-icons",
      "assets/internal-dev-controls-icons",
      "config/local/identity-provider.local.json",
    ]) {
      const origin = path.join(from, relative);
      if (!fs.existsSync(origin)) continue;
      const target = path.join(to, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.cpSync(origin, target, { recursive: true });
    }
  }

  /** Dirty the fixture's canonical worktree with unrelated tracked + untracked content. */
  function dirtyCanonical(fixture) {
    fs.appendFileSync(path.join(fixture.repository, "package.json"), "\n");
    fs.writeFileSync(path.join(fixture.repository, "unrelated-untracked.txt"), "unrelated\n");
  }

  const RUNTIME_BASE_REL = "src-runtime-base";
  const EXTENSION_BUILDER_REL = "tools/product/extensions/chatgpt/chrome/build-chrome-live-extension.mjs";
  const EXTENSION_BUILDER_CHAINED = "build-chrome-live-extension.chained.mjs";

  /**
   * A committed runtime module that make-aliases genuinely consumes: every file
   * in the runtime base is aliased because the publisher stages with
   * H2O_ALIAS_SCOPE=all, which disables order-file filtering. Chosen
   * deterministically and never a lane owned by other work.
   */
  function pickAliasedSourceFile(root) {
    const names = fs.readdirSync(path.join(root, RUNTIME_BASE_REL))
      .filter((name) => name.endsWith(".js"))
      .filter((name) => !/Prompt Manager|Export/u.test(name))
      .sort();
    assert.ok(names.length > 0, "fixture must expose aliasable runtime source");
    return path.join(RUNTIME_BASE_REL, names[0]);
  }

  /**
   * Replace the last stage builder with a fixture-owned hook. The publisher runs
   * aliases -> dev-output -> extension and only then proves post-build source
   * stability, so a hook here executes deterministically inside the build window
   * and before that proof — no sleeps and no timing race. `chain` re-runs the
   * real builder afterwards for scenarios that must still produce staged output.
   */
  function installStageHook(fixture, body, { chain = false } = {}) {
    const builder = path.join(fixture.repository, EXTENSION_BUILDER_REL);
    let tail = "";
    if (chain) {
      fs.copyFileSync(builder, path.join(path.dirname(builder), EXTENSION_BUILDER_CHAINED));
      tail = `await import("./${EXTENSION_BUILDER_CHAINED}");\n`;
    }
    fs.writeFileSync(builder, `${body}\n${tail}`);
    git(fixture.repository, ["add", "-A"]);
    git(fixture.repository, ["commit", "-q", "-m", "fixture: stage-window hook"]);
  }

  /** Staged alias files whose bytes exactly equal `sourceFile`. */
  function aliasesMatchingSource(stagingRoot, sourceFile) {
    const wanted = fs.readFileSync(sourceFile);
    const aliasRoot = path.join(stagingRoot, "server", "alias");
    if (!fs.existsSync(aliasRoot)) return [];
    return fs.readdirSync(aliasRoot)
      .map((name) => path.join(aliasRoot, name))
      .filter((file) => fs.lstatSync(file).isFile() && fs.readFileSync(file).equals(wanted));
  }

  /** Every staged file containing `marker`, across all staged families. */
  function stagedFilesContaining(stagingRoot, marker) {
    const hits = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.isFile()) {
          try { if (fs.readFileSync(full, "utf8").includes(marker)) hits.push(full); } catch { /* binary */ }
        }
      }
    };
    walk(stagingRoot);
    return hits;
  }

  await test("P-R1 legacy canonical mode is unchanged and records canonical source authority", () => {
    const fixture = createPublishableFixture("r1-legacy");
    const staged = runPublisher(fixture);
    assert.equal(staged.result.status, 0, String(staged.result.stderr));
    assert.equal(staged.receipt.sourceAuthority.mode, "canonical");
    assert.equal(staged.receipt.sourceAuthority.head, staged.receipt.approvedHead);
    assert.equal(staged.receipt.sourceAuthority.worktreeRoot, realpath(fixture.repository));
    assert.equal(staged.receipt.sourceAuthority.branch, "main");
  });

  await test("P-R2 explicit clean source succeeds while canonical is dirty", () => {
    const fixture = createPublishableFixture("r1-dirty-canonical");
    const worktree = addFixtureWorktree(fixture, "clean-source");
    dirtyCanonical(fixture);
    const staged = runPublisher(fixture, { args: ["--stage-only", "--source-worktree", worktree] });
    assert.equal(staged.result.status, 0, String(staged.result.stderr));
    assert.equal(staged.receipt.sourceAuthority.mode, "explicit-worktree");
    assert.equal(staged.receipt.sourceAuthority.worktreeRoot, worktree);
    assert.equal(staged.receipt.repository, realpath(fixture.repository));
    assert.equal(staged.receipt.branch, "main");
  });

  await test("P-R3 clean ancestor source succeeds while canonical is ahead", () => {
    const fixture = createPublishableFixture("r1-ancestor");
    const ancestor = git(fixture.repository, ["rev-parse", "HEAD"]);
    const worktree = addFixtureWorktree(fixture, "ancestor-source", ancestor);
    fs.writeFileSync(path.join(fixture.repository, SENTINEL_REL), "canonical-ahead\n");
    git(fixture.repository, ["add", "-A"]);
    git(fixture.repository, ["commit", "-q", "-m", "fixture: advance canonical"]);
    const staged = runPublisher(fixture, { args: ["--stage-only", "--source-worktree", worktree] });
    assert.equal(staged.result.status, 0, String(staged.result.stderr));
    assert.equal(staged.receipt.sourceAuthority.head, ancestor);
    assert.notEqual(staged.receipt.approvedHead, ancestor);
  });

  await test("P-R4 divergent source is rejected", () => {
    const fixture = createPublishableFixture("r1-divergent");
    const worktree = addFixtureWorktree(fixture, "divergent-source");
    fs.writeFileSync(path.join(worktree, SENTINEL_REL), "divergent\n");
    git(worktree, ["add", "-A"]);
    git(worktree, ["commit", "-q", "-m", "fixture: diverge source"]);
    const staged = runPublisher(fixture, { args: ["--stage-only", "--source-worktree", worktree] });
    assert.notEqual(staged.result.status, 0);
    assert.equal(errorCodeOf(staged.result), "source-not-ancestor-of-canonical");
  });

  await test("P-R5 foreign repository source is rejected", () => {
    const fixture = createPublishableFixture("r1-foreign-a");
    const foreign = createPublishableFixture("r1-foreign-b");
    const staged = runPublisher(fixture, {
      args: ["--stage-only", "--source-worktree", foreign.repository],
    });
    assert.notEqual(staged.result.status, 0);
    assert.equal(errorCodeOf(staged.result), "source-worktree-foreign-repository");
  });

  await test("P-R6 unregistered copied checkout is rejected", () => {
    const fixture = createPublishableFixture("r1-unregistered");
    const copy = path.join(fixture.top, "copied-checkout");
    fs.cpSync(fixture.repository, copy, { recursive: true });
    const staged = runPublisher(fixture, { args: ["--stage-only", "--source-worktree", copy] });
    assert.notEqual(staged.result.status, 0);
    assert.ok(
      ["source-worktree-unregistered", "source-worktree-foreign-repository"].includes(errorCodeOf(staged.result)),
      `unexpected code ${errorCodeOf(staged.result)}`,
    );
  });

  await test("P-R7 dirty source is rejected for tracked, staged and untracked content", () => {
    for (const [label, dirty, code] of [
      ["tracked", (wt) => fs.appendFileSync(path.join(wt, "package.json"), "\n"), "source-worktree-not-clean"],
      ["staged", (wt) => {
        fs.appendFileSync(path.join(wt, "package.json"), "\n");
        git(wt, ["add", "package.json"]);
      }, "source-index-not-empty"],
      ["untracked", (wt) => fs.writeFileSync(path.join(wt, "stray.txt"), "x\n"), "source-untracked-present"],
    ]) {
      const fixture = createPublishableFixture(`r1-dirty-${label}`);
      const worktree = addFixtureWorktree(fixture, "dirty-source");
      dirty(worktree);
      const staged = runPublisher(fixture, { args: ["--stage-only", "--source-worktree", worktree] });
      assert.notEqual(staged.result.status, 0, label);
      assert.equal(errorCodeOf(staged.result), code, label);
    }
  });

  // Generator pinning. The marker lives in a runtime module make-aliases really
  // consumes, so the staged alias bytes are decisive evidence of which worktree
  // the builders read. If H2O_SRC_DIR ever reverted to canonical REPO_ROOT the
  // staged alias would carry the canonical dirty marker and this fails.
  await test("P-R11 staged bytes come from the selected source, not dirty canonical", () => {
    const fixture = createPublishableFixture("r1-provenance");
    const relative = pickAliasedSourceFile(fixture.repository);
    const SOURCE_MARKER = "H2O_PROVENANCE_SOURCE_WORKTREE_R1";
    const CANONICAL_MARKER = "H2O_PROVENANCE_CANONICAL_DIRTY_R1";
    const canonicalFile = path.join(fixture.repository, relative);

    // Commit the source marker so canonical main and the sibling worktree agree,
    // then select a clean worktree at that commit.
    fs.appendFileSync(canonicalFile, `\n// ${SOURCE_MARKER}\n`);
    git(fixture.repository, ["add", "-A"]);
    git(fixture.repository, ["commit", "-q", "-m", "fixture: source provenance marker"]);
    const worktree = addFixtureWorktree(fixture, "provenance-source");
    const sourceFile = path.join(worktree, relative);

    // Canonical working copy only: same line, conflicting value, uncommitted.
    fs.writeFileSync(canonicalFile,
      fs.readFileSync(canonicalFile, "utf8").replace(SOURCE_MARKER, CANONICAL_MARKER));
    assert.ok(fs.readFileSync(canonicalFile, "utf8").includes(CANONICAL_MARKER),
      "dirty canonical must carry the canonical marker");
    assert.ok(fs.readFileSync(sourceFile, "utf8").includes(SOURCE_MARKER),
      "selected source must carry the source marker");
    assert.equal(git(worktree, ["status", "--porcelain=v1"]), "", "source worktree stays clean");

    const staged = runPublisher(fixture, { args: ["--stage-only", "--source-worktree", worktree] });
    assert.equal(staged.result.status, 0, String(staged.result.stderr));

    // Positive: exactly one staged alias equals the selected source byte-for-byte.
    const matches = aliasesMatchingSource(staged.stagingRoot, sourceFile);
    assert.equal(matches.length, 1, "one staged alias must equal the selected source bytes");
    assert.ok(fs.readFileSync(matches[0], "utf8").includes(SOURCE_MARKER));
    assert.ok(stagedFilesContaining(staged.stagingRoot, SOURCE_MARKER).length > 0,
      "the source marker must actually reach the stage");
    // Negative: the dirty canonical value reached nothing at all.
    assert.deepEqual(stagedFilesContaining(staged.stagingRoot, CANONICAL_MARKER), [],
      "canonical dirty bytes must not reach the stage");
    assert.equal(staged.receipt.sourceAuthority.head, git(worktree, ["rev-parse", "HEAD"]));
    assert.equal(staged.receipt.sourceAuthority.tree, git(worktree, ["rev-parse", "HEAD^{tree}"]));
  });

  await test("P-R8 source HEAD movement during the build is rejected", () => {
    const fixture = createPublishableFixture("r1-head-moved");
    const worktree = addFixtureWorktree(fixture, "moving-source");
    installStageHook(fixture, [
      'import { execFileSync } from "node:child_process";',
      'execFileSync("git", ["commit", "--allow-empty", "-q", "-m", "probe: advance source"],',
      '  { cwd: process.env.LEANPUB_PROBE_SOURCE_WT });',
    ].join("\n"));
    const before = git(worktree, ["rev-parse", "HEAD"]);

    const staged = runPublisher(fixture, {
      args: ["--stage-only", "--source-worktree", worktree],
      env: { LEANPUB_PROBE_SOURCE_WT: worktree },
    });
    assert.equal(staged.result.status, 1, String(staged.result.stdout));
    assert.equal(errorCodeOf(staged.result), "source-head-moved");
    assert.equal(staged.receipt, null, "no receipt may survive a moved source");
    assert.notEqual(git(worktree, ["rev-parse", "HEAD"]), before, "the hook must really have moved HEAD");
  });

  await test("P-R9 source dirtied during the build is rejected", () => {
    const fixture = createPublishableFixture("r1-dirt-during-build");
    const relative = pickAliasedSourceFile(fixture.repository);
    const worktree = addFixtureWorktree(fixture, "dirtying-source");
    installStageHook(fixture, [
      'import fs from "node:fs";',
      'import path from "node:path";',
      'fs.appendFileSync(',
      '  path.join(process.env.LEANPUB_PROBE_SOURCE_WT, process.env.LEANPUB_PROBE_DIRTY_REL),',
      '  "\\n// probe: mid-build dirt\\n");',
    ].join("\n"));

    const staged = runPublisher(fixture, {
      args: ["--stage-only", "--source-worktree", worktree],
      env: { LEANPUB_PROBE_SOURCE_WT: worktree, LEANPUB_PROBE_DIRTY_REL: relative },
    });
    assert.equal(staged.result.status, 1, String(staged.result.stdout));
    assert.equal(errorCodeOf(staged.result), "source-changed-during-build");
    assert.equal(staged.receipt, null, "no receipt may survive a dirtied source");
    assert.notEqual(git(worktree, ["status", "--porcelain=v1"]), "", "the hook must really have dirtied the source");
  });

  // The approved policy is ancestry, not an exact canonical-HEAD pin: canonical
  // main may advance mid-build provided the selected source stays reachable.
  await test("P-R10 canonical may advance during the build while the source stays an ancestor", () => {
    const fixture = createPublishableFixture("r1-canonical-advance");
    const sourceCommit = git(fixture.repository, ["rev-parse", "HEAD"]);
    const worktree = addFixtureWorktree(fixture, "ancestor-source", sourceCommit);
    // Installing the hook is itself the pre-staging advance to C1.
    installStageHook(fixture, [
      'import { execFileSync } from "node:child_process";',
      'execFileSync("git", ["commit", "--allow-empty", "-q", "-m", "probe: advance canonical"],',
      '  { cwd: process.env.LEANPUB_PROBE_CANONICAL });',
    ].join("\n"), { chain: true });
    const c1 = git(fixture.repository, ["rev-parse", "HEAD"]);
    assert.notEqual(c1, sourceCommit, "canonical must lead the source before staging");

    const staged = runPublisher(fixture, {
      args: ["--stage-only", "--source-worktree", worktree],
      env: { LEANPUB_PROBE_CANONICAL: fixture.repository },
    });
    assert.equal(staged.result.status, 0, String(staged.result.stderr));
    const c2 = git(fixture.repository, ["rev-parse", "HEAD"]);
    assert.notEqual(c2, c1, "canonical must really have advanced during the build");
    assert.equal(staged.receipt.approvedHead, c1, "receipt keeps the preflight canonical head");
    assert.equal(staged.receipt.sourceAuthority.head, sourceCommit);
    assert.equal(staged.receipt.sourceAuthority.mode, "explicit-worktree");
    // Ancestry to the advanced canonical head still holds.
    execFileSync("git", ["merge-base", "--is-ancestor", sourceCommit, c2],
      { cwd: fixture.repository, encoding: "utf8", timeout: 60_000 });
  });

  await test("P-R12 receipt records canonical and source authority fields", () => {
    const fixture = createPublishableFixture("r1-receipt");
    const worktree = addFixtureWorktree(fixture, "receipt-source");
    const staged = runPublisher(fixture, { args: ["--stage-only", "--source-worktree", worktree] });
    assert.equal(staged.result.status, 0, String(staged.result.stderr));
    const authority = staged.receipt.sourceAuthority;
    assert.deepEqual(Object.keys(authority).sort(),
      ["branch", "commonDir", "head", "mode", "tree", "worktreeRoot"]);
    assert.equal(authority.mode, "explicit-worktree");
    assert.equal(authority.head, git(worktree, ["rev-parse", "HEAD"]));
    assert.equal(authority.tree, git(worktree, ["rev-parse", "HEAD^{tree}"]));
    assert.equal(authority.branch, null, "detached fixture worktree records a null branch");
    assert.equal(authority.worktreeRoot, worktree);
    assert.equal(authority.commonDir, realpath(git(fixture.repository, ["rev-parse", "--path-format=absolute", "--git-common-dir"])));
    // Canonical comparison authority untouched.
    assert.equal(staged.receipt.repository, realpath(fixture.repository));
    assert.equal(staged.receipt.branch, "main");
    assert.equal(staged.receipt.approvedHead, git(fixture.repository, ["rev-parse", "HEAD"]));
  });

  // A fresh clone carries no generated live tree, so comparing it before/after
  // would compare nothing. Seed both live families with recognisable sentinels
  // first; then an unchanged digest is real evidence rather than two absences.
  await test("P-R13 explicit-source staging writes nothing outside the temporary stage root", () => {
    const fixture = createPublishableFixture("r1-stage-only");
    const worktree = addFixtureWorktree(fixture, "isolated-source");
    const liveAlias = path.join(fixture.repository, "apps", "dev-server", "alias");
    const liveDevOutput = path.join(fixture.repository, "apps", "dev-server", "dev_output");
    for (const [directory, name] of [[liveAlias, "0Z0z_live_alias_sentinel.js"], [liveDevOutput, "live_dev_output_sentinel.txt"]]) {
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(path.join(directory, name), `H2O_LIVE_SENTINEL_MUST_NOT_CHANGE ${name}\n`);
    }
    const before = { alias: fixtureManifest(liveAlias), devOutput: fixtureManifest(liveDevOutput) };
    assert.ok(before.alias.length > 0, "seeded live alias tree must be non-empty");
    assert.ok(before.devOutput.length > 0, "seeded live dev_output tree must be non-empty");

    const staged = runPublisher(fixture, { args: ["--stage-only", "--source-worktree", worktree] });
    assert.equal(staged.result.status, 0, String(staged.result.stderr));
    assert.ok(isWithin(realpath(os.tmpdir()), realpath(staged.stagingRoot)), "stage root must be temporary");

    assert.deepEqual(fixtureManifest(liveAlias), before.alias, "fixture live alias tree must be untouched");
    assert.deepEqual(fixtureManifest(liveDevOutput), before.devOutput, "fixture live dev_output tree must be untouched");
    // The staged families really were produced, i.e. the comparison is not vacuous.
    assert.ok(fs.existsSync(path.join(staged.stagingRoot, "server", "alias")), "stage must hold its own alias family");
  });

  await test("P-R14 CLI rejects malformed --source-worktree usage", () => {
    const fixture = createPublishableFixture("r1-cli");
    const worktree = addFixtureWorktree(fixture, "cli-source");
    const cases = [
      [["--stage-only", "--source-worktree", worktree, "--source-worktree", worktree], "duplicate"],
      [["--stage-only", "--source-worktree"], "missing value"],
      [["--stage-only", "--source-worktree", path.join(fixture.top, "nope")], "nonexistent"],
      [["--stage-only", "--source-worktree", path.join(fixture.repository, "package.json")], "file"],
    ];
    for (const [args, label] of cases) {
      const staged = runPublisher(fixture, { args });
      assert.notEqual(staged.result.status, 0, label);
      assert.ok(
        ["invalid-arguments", "source-worktree-missing", "source-worktree-not-directory"].includes(errorCodeOf(staged.result)),
        `${label}: unexpected code ${errorCodeOf(staged.result)}`,
      );
    }
  });

  await test("runtime scenario count is exact", () => {
    assert.equal(runtimeResults.length + 1, EXPECTED_RUNTIME_SCENARIOS);
  });

  assert.equal(runtimeResults.length, EXPECTED_RUNTIME_SCENARIOS);
}

function printScope() {
  process.stdout.write(`${JSON.stringify({
    validator: VALIDATOR_REL,
    implementation: [PUBLISHER_REL],
    finalPaths: FINAL_PATHS,
    uncommittedModified: UNCOMMITTED_MODIFIED,
    uncommittedUntracked: UNCOMMITTED_UNTRACKED,
    runtimeScenarios: EXPECTED_RUNTIME_SCENARIOS,
    scopeScenarios: EXPECTED_SCOPE_SCENARIOS,
  })}\n`);
}

async function main() {
  const args = process.argv.slice(2);
  const allowed = new Set(["--scope-check", "--print-scope"]);
  if (args.length > 1 || args.some((arg) => !allowed.has(arg))) {
    throw new Error(`unknown or duplicate arguments: ${args.join(" ")}`);
  }
  if (args[0] === "--print-scope") { printScope(); return; }
  const scopeMode = classifyLeanPublisherScope(currentScopeState());
  if (args[0] === "--scope-check") {
    process.stdout.write(`${JSON.stringify({ ok: true, scopeMode })}\n`);
    return;
  }
  runScopeSelfTests();
  await runRuntimeScenarios();
  process.stdout.write(`${JSON.stringify({
    ok: true,
    validator: VALIDATOR_REL,
    scopeMode,
    runtimeScenarios: runtimeResults.length,
    scopeScenarios: scopeResults.length,
    stagingRootsPreserved: preservedStagingRoots.length,
    activationImplemented: false,
    browserActionPerformed: false,
    canonicalAnchorCreated: false,
    practicalProbes: {
      publisherPairs: publisherPairProbe,
      staleContention: staleContentionProbe,
      acquireReleaseChurn: churnProbe,
    },
    stagedAliasEvidence,
  })}\n`);
}

try {
  await main();
} finally {
  for (const root of temporaryRoots) {
    fs.rmSync(root, { recursive: true, force: true });
  }
  // Staging roots created by the publisher live outside the validator sandbox;
  // this suite created them, so this suite removes them.
  for (const preserved of preservedStagingRoots) {
    try {
      if (preserved && path.basename(preserved).startsWith("h2o-publish-stage-")) {
        fs.rmSync(preserved, { recursive: true, force: true });
      }
    } catch {}
  }
}
