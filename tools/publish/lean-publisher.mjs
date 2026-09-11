#!/usr/bin/env node
// Lean publisher — Batch 1 (stage-only).
//
// Builds aliases, dev output and one Chrome extension variant into a LOCAL
// temporary staging root, validates the result lightly, and writes a simple
// JSON receipt. It never touches live generated output.
//
// Scope guard rails for this batch:
//   - no activation, no promotion, no Chrome reload, no browser canary;
//   - no canonical delivery lease is created and the canonical anchor is not
//     used as storage (the cross-worktree lock is a sibling of it);
//   - no tokens, capabilities or cryptographic session material exist here.
//
// Threat model is lean: accidental parallel publication, stale worktrees, the
// wrong repository or commit, mixed build outputs, and failed builds touching
// live output. It is not a defence against a deliberately malicious same-user
// process.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { deriveSharedAnchor } from "./canonical-delivery-lib.mjs";
import { getExtensionId } from "../product/extensions/chatgpt/chrome/chrome-extension-keys.mjs";
import {
  ARCHIVE_WORKBENCH_OUT_FILES,
  compareArchiveWorkbenchToSource,
  parseStudioHtmlScriptRefs,
} from "../product/studio/pack-studio.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// Repository root is derived from this module's own location, never from the
// environment, so a parent shell cannot redirect which source gets published.
const REPO_ROOT = path.resolve(HERE, "..", "..");

const LOCK_DIR_NAME = ".h2o-publisher-lock";
const LOCK_METADATA_FILE = "lock.json";
const LOCK_PENDING_PREFIX = ".h2o-publisher-lock.pending-";
const LOCK_RELEASED_PREFIX = ".h2o-publisher-lock.released-";
const LOCK_SCHEMA_VERSION = 1;
const LOCK_REQUIRED_FIELDS = Object.freeze([
  "schemaVersion",
  "ownerId",
  "pid",
  "repository",
  "approvedHead",
  "startedAt",
]);
const RECEIPT_FILE = "publication-receipt.json";
const RECEIPT_SCHEMA_VERSION = 1;
const TARGET_AWARE_RECEIPT_SCHEMA_VERSION = 2;
const STAGED_EXTENSION_VARIANT = "dev-controls-oauth-google";
export const DEV_CONTROLS_TARGET = "dev-controls-oauth-google";
export const STUDIO_LAUNCHER_TARGET = "studio-launcher";
export const STUDIO_LAUNCHER_EXTENSION_ID = "bpobkkppdlldlkccaehmpfclmkhiemhg";
const CHILD_TIMEOUT_MS = 300_000;

// Accepted safety foundation. HEAD must descend from these.
const FOUNDATION_COMMITS = Object.freeze([
  "3ce2264ad0e32d9a6fa4d17b4cf89f84d652db2f", // E2A
  "b4f5e730a5a39a7b45571138d48aafe4710cb90a", // Lean E2B closure
]);

const GUARDED_WRITERS = Object.freeze([
  "tools/loader/make-aliases.mjs",
  "tools/loader/make-ext-proxy-pack.mjs",
  "tools/product/extensions/chatgpt/chrome/build-chrome-live-extension.mjs",
  "tools/product/extensions/chatgpt/chrome/pack-ops-panel.mjs",
  "tools/product/extensions/chatgpt/chrome/pack-desk.mjs",
  "tools/product/identity/build-identity-provider-bundle.mjs",
]);

const REQUIRED_EXTENSION_FILES = Object.freeze([
  "manifest.json",
  "loader.js",
  "bg.js",
  "title-contract-bridge.js",
  "provider/identity-provider-supabase.js",
]);

const STUDIO_LAUNCHER_SHELL_FILES = Object.freeze([
  "README.txt",
  "bg.js",
  "manifest.json",
  "icons/icon16.png",
  "icons/icon32.png",
  "icons/icon48.png",
  "icons/icon128.png",
  "icons/icon256.png",
  "icons/icon512.png",
  "icons/icon1024.png",
  "icons/manifest-icons.json",
]);

const STUDIO_REQUIRED_ORDER = Object.freeze([
  "platform/selectors.contract.js",
  "platform/html-sanitizer.js",
  "renderer/safety/sanitizer-policy.v1.js",
  "renderer/safety/vendor/dompurify/purify.js",
  "renderer/safety/html-sanitizer.v2.js",
  "renderer/markdown/vendor/markdown-it/markdown-it.umd.min.js",
  "renderer/markdown/h2o-gfm.v1.js",
  "renderer/markdown/markdown-engine.v1.js",
  "renderer/markdown/markdown-ir-adapter.v1.js",
  "renderer/semantic/render-ir.v1.js",
  "renderer/semantic/semantic-ingress.v1.js",
  "renderer/content/content-renderer.v1.js",
  "renderer/chat-renderer.studio.js",
  "studio.js",
]);

const PUBLISHER_TARGETS = Object.freeze({
  [DEV_CONTROLS_TARGET]: Object.freeze({
    targetId: DEV_CONTROLS_TARGET,
    receiptSchemaVersion: RECEIPT_SCHEMA_VERSION,
    outputFamilies: Object.freeze(["alias", "devOutput", "extension"]),
    extensionVariant: STAGED_EXTENSION_VARIANT,
    artifactBasename: "extension",
    canonicalVariant: STAGED_EXTENSION_VARIANT,
    expectedExtensionId: null,
    exactCanonicalHeadRequired: false,
  }),
  [STUDIO_LAUNCHER_TARGET]: Object.freeze({
    targetId: STUDIO_LAUNCHER_TARGET,
    receiptSchemaVersion: TARGET_AWARE_RECEIPT_SCHEMA_VERSION,
    outputFamilies: Object.freeze(["extension"]),
    extensionVariant: STUDIO_LAUNCHER_TARGET,
    artifactBasename: STUDIO_LAUNCHER_TARGET,
    canonicalVariant: STUDIO_LAUNCHER_TARGET,
    expectedExtensionId: STUDIO_LAUNCHER_EXTENSION_ID,
    exactCanonicalHeadRequired: true,
  }),
});

export function publisherTargetPolicy(targetId = DEV_CONTROLS_TARGET) {
  const policy = PUBLISHER_TARGETS[targetId];
  if (!policy) {
    fail("publication-target-not-accepted", "Publication target is not independently admitted.", {
      targetId,
      accepted: Object.keys(PUBLISHER_TARGETS),
    });
  }
  return policy;
}

export class LeanPublisherError extends Error {
  constructor(code, message, details = undefined) {
    super(`${code}: ${message}`);
    this.name = "LeanPublisherError";
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

function fail(code, message, details) {
  throw new LeanPublisherError(code, message, details);
}

function git(cwd, args) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: 20_000,
    killSignal: "SIGTERM",
  });
  if (result.status !== 0) {
    fail("git-command-failed", `git ${args.join(" ")} failed`, {
      status: result.status ?? null,
    });
  }
  return String(result.stdout || "").trim();
}

function gitAllows(cwd, args) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: 20_000,
    killSignal: "SIGTERM",
  });
  return result.status === 0;
}

function sha256File(filename) {
  return crypto.createHash("sha256").update(fs.readFileSync(filename)).digest("hex");
}

function isWithin(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/** Resolve the deepest existing ancestor, then re-append the missing suffix. */
function realAware(target) {
  let cursor = path.resolve(target);
  const suffix = [];
  while (!fs.existsSync(cursor)) {
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    suffix.unshift(path.basename(cursor));
    cursor = parent;
  }
  let base = cursor;
  if (fs.existsSync(cursor)) {
    try {
      base = fs.realpathSync.native(cursor);
    } catch {
      base = fs.realpathSync(cursor);
    }
  }
  return path.resolve(base, ...suffix);
}

// ─── publisher lock ──────────────────────────────────────────────────────────
//
// One simple cross-worktree lock. Its location is derived through the existing
// E1 shared-anchor helper (so every worktree of this repository agrees on one
// place) but it is a SIBLING of the canonical anchor: this publisher never
// creates the canonical delivery anchor or a lease.
//
// Acquisition is ONE atomic step. A complete candidate lock — directory mode
// 0700 with a complete lock.json inside at mode 0600 — is prepared under a
// unique pending name and then renamed onto the final path. rename(2) onto an
// existing non-empty directory fails, so exactly one candidate can ever become
// the lock, and the lock is never observable in a partial state. The earlier
// mkdir-then-write sequence exposed a window in which a second publisher saw a
// metadata-less directory, classified the live owner as stale and deleted it.

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists under another user.
    return error?.code === "EPERM";
  }
}

function buildLockMetadata(metadata) {
  return {
    schemaVersion: LOCK_SCHEMA_VERSION,
    // Non-secret unique owner identity: it only distinguishes publisher runs.
    ownerId: crypto.randomUUID(),
    pid: Number.isInteger(metadata?.pid) ? metadata.pid : process.pid,
    repository: typeof metadata?.repository === "string" ? metadata.repository : REPO_ROOT,
    approvedHead: typeof metadata?.approvedHead === "string" ? metadata.approvedHead : "",
    startedAt: typeof metadata?.startedAt === "string" ? metadata.startedAt : new Date().toISOString(),
  };
}

/**
 * Classify the final lock path without ever mutating it.
 *
 * Fails closed (throws) for a symlinked or dangling-symlink path, a non
 * directory, missing/malformed/incomplete metadata and an invalid PID: those
 * states are never auto-deleted. Otherwise reports absent / live / stale.
 */
export function inspectPublisherLock(lockDirectory) {
  let stat;
  try {
    stat = fs.lstatSync(lockDirectory);
  } catch (error) {
    if (error?.code === "ENOENT") return { state: "absent", metadata: null };
    throw error;
  }
  if (stat.isSymbolicLink()) {
    fail("publisher-lock-symlink", "Publisher lock path is a symlink.", { lockDirectory });
  }
  if (!stat.isDirectory()) {
    fail("publisher-lock-not-directory", "Publisher lock path is not a directory.", { lockDirectory });
  }

  // The whole lock may be renamed aside for release between the lstat above
  // and this read. That move is atomic, so the lock either is gone (absent) or
  // a fresh one has already been published in its place (readable on retry).
  // Only a directory that persistently has no metadata is a genuinely
  // incomplete lock, and that still fails closed.
  const metadataPath = path.join(lockDirectory, LOCK_METADATA_FILE);
  let raw = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      raw = fs.readFileSync(metadataPath, "utf8");
      break;
    } catch (error) {
      if (error?.code !== "ENOENT") break;
      if (!fs.existsSync(lockDirectory)) return { state: "absent", metadata: null };
    }
  }
  if (raw === null) {
    fail("publisher-lock-incomplete", "Publisher lock has no metadata; refusing to remove it.", {
      lockDirectory,
    });
  }
  let metadata;
  try {
    metadata = JSON.parse(raw);
  } catch {
    fail("publisher-lock-malformed", "Publisher lock metadata does not parse; refusing to remove it.", {
      lockDirectory,
    });
  }
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    fail("publisher-lock-malformed", "Publisher lock metadata is not an object.", { lockDirectory });
  }
  const missing = LOCK_REQUIRED_FIELDS.filter((field) => metadata[field] === undefined);
  if (missing.length) {
    fail("publisher-lock-incomplete", "Publisher lock metadata is incomplete; refusing to remove it.", {
      lockDirectory,
      missing,
    });
  }
  if (!Number.isInteger(metadata.pid) || metadata.pid <= 0) {
    fail("publisher-lock-invalid-pid", "Publisher lock metadata has an invalid PID.", {
      lockDirectory,
      pid: metadata.pid,
    });
  }
  return {
    state: processIsAlive(metadata.pid) ? "live" : "stale",
    metadata,
  };
}

function removeSupportDirectory(directory, prefix) {
  // Only ever remove a directory this module named, and never follow a symlink.
  if (!path.basename(directory).startsWith(prefix)) return;
  try {
    const stat = fs.lstatSync(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) return;
    fs.rmSync(directory, { recursive: true, force: true });
  } catch {
    // Never let support cleanup mask a real failure.
  }
}

/**
 * Prepare a COMPLETE candidate lock under a unique pending name. Exported so a
 * validator can observe the acquisition boundary without any timing games:
 * between prepare and publish the final lock path is still untouched.
 */
export function prepareLockCandidate(lockDirectory, metadata) {
  const parent = path.dirname(lockDirectory);
  const resolved = buildLockMetadata(metadata);
  const pendingDirectory = fs.mkdtempSync(path.join(parent, LOCK_PENDING_PREFIX));
  try {
    fs.writeFileSync(
      path.join(pendingDirectory, LOCK_METADATA_FILE),
      `${JSON.stringify(resolved, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    fs.chmodSync(pendingDirectory, 0o700);
  } catch (error) {
    removeSupportDirectory(pendingDirectory, LOCK_PENDING_PREFIX);
    throw error;
  }
  return { pendingDirectory, lockDirectory, ownerId: resolved.ownerId, metadata: resolved };
}

/** Discard an unused candidate. Always safe to call. */
export function discardLockCandidate(candidate) {
  if (candidate?.pendingDirectory) {
    removeSupportDirectory(candidate.pendingDirectory, LOCK_PENDING_PREFIX);
  }
}

/**
 * Atomically publish a candidate. Returns true only for the single winner;
 * EEXIST/ENOTEMPTY mean another publisher won and are reported as contention,
 * never as raw operating-system failures.
 */
export function publishLockCandidate(candidate) {
  try {
    fs.renameSync(candidate.pendingDirectory, candidate.lockDirectory);
    return true;
  } catch (error) {
    discardLockCandidate(candidate);
    if (error?.code === "EEXIST" || error?.code === "ENOTEMPTY" || error?.code === "EACCES") {
      return false;
    }
    throw error;
  }
}

export function acquireLock(lockDirectory, metadata) {
  const inspection = inspectPublisherLock(lockDirectory);
  if (inspection.state === "live") {
    fail("publisher-already-running", "Another publisher process owns the publisher lock.", {
      lockDirectory,
      ownerPid: inspection.metadata.pid,
      ownerId: inspection.metadata.ownerId,
      ownerHead: inspection.metadata.approvedHead ?? null,
    });
  }
  if (inspection.state === "stale") {
    fail("publisher-lock-stale", "Publisher lock belongs to a process that is no longer running.", {
      pid: inspection.metadata.pid,
      startedAt: inspection.metadata.startedAt,
      repository: inspection.metadata.repository,
      approvedHead: inspection.metadata.approvedHead,
      lockPath: lockDirectory,
    });
  }

  const candidate = prepareLockCandidate(lockDirectory, metadata);
  if (publishLockCandidate(candidate)) {
    return { lockDirectory, ownerId: candidate.ownerId };
  }

  // Publication lost to another complete candidate. Report its stable state,
  // never a raw operating-system error and never mutate an existing lock.
  const settled = inspectPublisherLock(lockDirectory);
  if (settled.state === "live") {
    fail("publisher-already-running", "Another publisher process owns the publisher lock.", {
      lockDirectory,
      ownerPid: settled.metadata.pid,
      ownerId: settled.metadata.ownerId,
      ownerHead: settled.metadata.approvedHead ?? null,
    });
  }
  if (settled.state === "stale") {
    fail("publisher-lock-stale", "Publisher lock belongs to a process that is no longer running.", {
      pid: settled.metadata.pid,
      startedAt: settled.metadata.startedAt,
      repository: settled.metadata.repository,
      approvedHead: settled.metadata.approvedHead,
      lockPath: lockDirectory,
    });
  }
  fail("publisher-lock-contended", "Publisher lock is contended; try again.", {
    lockDirectory,
  });
}

/**
 * Verify ownership and choose the unique sibling path this publisher will
 * rename its lock to. Returns null unless the lock is demonstrably ours: a
 * real directory (never a symlink) whose metadata parses and whose ownerId and
 * PID both match. Exported so a validator can hold the release open exactly at
 * the ownership-verified, pre-rename boundary.
 */
export function prepareLockRelease(lockDirectory, selfPid, ownerId) {
  if (typeof ownerId !== "string" || !ownerId) return null;
  let stat;
  try {
    stat = fs.lstatSync(lockDirectory);
  } catch {
    return null;
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) return null;
  let metadata;
  try {
    metadata = JSON.parse(fs.readFileSync(path.join(lockDirectory, LOCK_METADATA_FILE), "utf8"));
  } catch {
    return null;
  }
  if (!metadata || typeof metadata !== "object") return null;
  if (metadata.ownerId !== ownerId) return null;
  if (Number(metadata.pid) !== selfPid) return null;
  return {
    lockDirectory,
    releasedPath: path.join(
      path.dirname(lockDirectory),
      `${LOCK_RELEASED_PREFIX}${crypto.randomUUID()}`,
    ),
  };
}

/**
 * Retire the lock in ONE atomic step. After this rename the final lock path is
 * either present with complete metadata or absent — never a metadata-less
 * directory — so a contender arriving mid-release sees ordinary contention and
 * a new publisher may acquire immediately, while the released copy is still
 * being deleted. A rename that finds nothing there is a safe no-op.
 */
export function commitLockRelease(prepared) {
  if (!prepared) return "not-owned";
  try {
    fs.renameSync(prepared.lockDirectory, prepared.releasedPath);
    return "released";
  } catch (error) {
    if (["ENOENT", "EEXIST", "ENOTEMPTY", "EINVAL"].includes(error?.code)) return "absent";
    throw error;
  }
}

/** Delete the retired copy. Prefix- and symlink-checked before removal. */
export function purgeReleasedLock(prepared) {
  if (prepared?.releasedPath) {
    removeSupportDirectory(prepared.releasedPath, LOCK_RELEASED_PREFIX);
  }
}

export function releaseLock(lockDirectory, selfPid, ownerId) {
  try {
    const prepared = prepareLockRelease(lockDirectory, selfPid, ownerId);
    if (!prepared) return "not-owned";
    const outcome = commitLockRelease(prepared);
    if (outcome === "released") purgeReleasedLock(prepared);
    return outcome;
  } catch {
    // Releasing must never mask the original failure.
    return "error";
  }
}

// ─── source preflight ────────────────────────────────────────────────────────

/**
 * Working-tree cleanliness for one worktree root. Used for canonical in legacy
 * mode and always for the selected source worktree.
 */
function assertWorktreeClean(root, codes) {
  const staged = git(root, ["diff", "--cached", "--name-only"]);
  if (staged) {
    fail(codes.index, "Publisher requires an empty index.", { root, staged: staged.split("\n") });
  }
  const modified = git(root, ["diff", "--name-only", "HEAD", "--"]);
  if (modified) {
    fail(codes.tracked, "Publisher requires a clean tracked working tree.", {
      root, modified: modified.split("\n"),
    });
  }
  const untracked = git(root, ["ls-files", "--others", "--exclude-standard", "--"]);
  if (untracked) {
    fail(codes.untracked, "Publisher requires no untracked non-ignored source.", {
      root, untracked: untracked.split("\n"),
    });
  }
}

/** Real-aware git common directory for a worktree root. */
function gitCommonDir(root) {
  return realAware(git(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]));
}

/** Registered worktree roots, real-aware, as reported by the canonical repository. */
function registeredWorktreeRoots(root) {
  return git(root, ["worktree", "list", "--porcelain"])
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => realAware(line.slice("worktree ".length)));
}

/**
 * Canonical comparison authority. Identity, branch and foundation ancestry are
 * proved here for every mode; canonical working-copy cleanliness is proved by
 * the caller only when canonical is also the artifact source.
 */
function collectCanonicalAuthority() {
  const topLevel = realAware(git(REPO_ROOT, ["rev-parse", "--show-toplevel"]));
  if (topLevel !== realAware(REPO_ROOT)) {
    fail("unexpected-repository", "Publisher is not operating on its own repository worktree.", {
      expected: realAware(REPO_ROOT),
      observed: topLevel,
    });
  }

  for (const relative of GUARDED_WRITERS) {
    if (!fs.existsSync(path.join(REPO_ROOT, relative))) {
      fail("guarded-writer-missing", "A guarded canonical writer is missing.", { relative });
    }
  }

  const branch = git(REPO_ROOT, ["branch", "--show-current"]);
  if (branch !== "main") {
    fail("unexpected-branch", "Publisher requires branch main.", { branch });
  }

  const approvedHead = git(REPO_ROOT, ["rev-parse", "HEAD"]);
  for (const foundation of FOUNDATION_COMMITS) {
    if (!gitAllows(REPO_ROOT, ["cat-file", "-e", `${foundation}^{commit}`])) {
      fail("foundation-commit-absent", "Accepted safety foundation commit is not in this repository.", {
        foundation,
      });
    }
    if (!gitAllows(REPO_ROOT, ["merge-base", "--is-ancestor", foundation, approvedHead])) {
      fail("foundation-not-ancestor", "HEAD does not descend from the accepted safety foundation.", {
        foundation,
        approvedHead,
      });
    }
  }

  let remote = null;
  try {
    remote = git(REPO_ROOT, ["remote", "get-url", "origin"]);
  } catch {
    remote = null;
  }

  return Object.freeze({
    repository: realAware(REPO_ROOT),
    branch,
    approvedHead,
    remote,
    commonDir: gitCommonDir(REPO_ROOT),
  });
}

/**
 * Source artifact authority. Trust derives from canonical git common-dir
 * identity, registered-worktree membership, the exact source commit and tree,
 * and ancestry to canonical main — never from the supplied path alone. The path
 * is retained for generation and audit only.
 */
export function resolveSourceAuthority(canonical, requestedPath) {
  if (requestedPath === null || requestedPath === undefined) {
    assertWorktreeClean(REPO_ROOT, {
      index: "index-not-empty",
      tracked: "worktree-not-clean",
      untracked: "untracked-source-present",
    });
    return Object.freeze({
      mode: "canonical",
      commonDir: canonical.commonDir,
      root: canonical.repository,
      head: canonical.approvedHead,
      tree: git(REPO_ROOT, ["rev-parse", "HEAD^{tree}"]),
      branch: canonical.branch,
    });
  }

  let stat = null;
  try { stat = fs.statSync(requestedPath); } catch { stat = null; }
  if (!stat) {
    fail("source-worktree-missing", "Selected source worktree path does not exist.", { requestedPath });
  }
  if (!stat.isDirectory()) {
    fail("source-worktree-not-directory", "Selected source worktree path is not a directory.", { requestedPath });
  }

  const root = realAware(requestedPath);
  const observedTop = realAware(git(root, ["rev-parse", "--show-toplevel"]));
  if (observedTop !== root) {
    fail("source-worktree-not-worktree-root", "Selected source path is not a worktree root.", {
      requestedPath, root, observedTop,
    });
  }

  // Repository identity: the same shared object store as canonical. A foreign
  // repository with identical content fails here regardless of its bytes.
  const commonDir = gitCommonDir(root);
  if (commonDir !== canonical.commonDir) {
    fail("source-worktree-foreign-repository", "Selected source worktree belongs to another repository.", {
      expected: canonical.commonDir, observed: commonDir,
    });
  }

  // Registration: an unregistered copied checkout is rejected even when its
  // common-dir text matches, because canonical does not list it.
  const registered = registeredWorktreeRoots(REPO_ROOT);
  if (!registered.includes(root)) {
    fail("source-worktree-unregistered", "Selected source worktree is not a registered worktree of this repository.", {
      root, registered,
    });
  }

  assertWorktreeClean(root, {
    index: "source-index-not-empty",
    tracked: "source-worktree-not-clean",
    untracked: "source-untracked-present",
  });

  const head = git(root, ["rev-parse", "HEAD"]);
  const tree = git(root, ["rev-parse", "HEAD^{tree}"]);
  // Detached HEAD is permitted; the commit and tree carry the authority.
  const branchName = git(root, ["branch", "--show-current"]);
  const branch = branchName ? branchName : null;

  assertSourceAncestry(head, canonical.approvedHead);

  for (const foundation of FOUNDATION_COMMITS) {
    if (!gitAllows(REPO_ROOT, ["merge-base", "--is-ancestor", foundation, head])) {
      fail("source-foundation-not-ancestor", "Selected source HEAD does not descend from the accepted safety foundation.", {
        foundation, head,
      });
    }
  }

  return Object.freeze({ mode: "explicit-worktree", commonDir, root, head, tree, branch });
}

/** Source must be reachable from canonical main: ancestor-or-equal. */
function assertSourceAncestry(sourceHead, canonicalHead) {
  if (sourceHead === canonicalHead) return;
  if (!gitAllows(REPO_ROOT, ["merge-base", "--is-ancestor", sourceHead, canonicalHead])) {
    fail("source-not-ancestor-of-canonical", "Selected source HEAD is not ancestor-or-equal to canonical main HEAD.", {
      sourceHead, canonicalHead,
    });
  }
}

export function runSourcePreflight({ sourceWorktree = null } = {}) {
  const canonical = collectCanonicalAuthority();
  const selected = resolveSourceAuthority(canonical, sourceWorktree);

  return {
    // Canonical comparison authority (receipt: repository / branch / approvedHead).
    repository: canonical.repository,
    branch: canonical.branch,
    approvedHead: canonical.approvedHead,
    remote: canonical.remote,
    canonicalCommonDir: canonical.commonDir,
    // Source artifact authority. sourceRoot is where every builder reads from.
    sourceMode: selected.mode,
    sourceRoot: selected.root,
    sourceHead: selected.head,
    sourceTree: selected.tree,
    sourceBranch: selected.branch,
    sourceCommonDir: selected.commonDir,
  };
}

/**
 * Post-generation stability. Proves the selected source did not move or dirty
 * during the build, and that canonical remains valid comparison authority.
 * Canonical HEAD may advance while the source stays ancestor-or-equal.
 */
function assertSourceStillClean(source) {
  const topLevel = realAware(git(REPO_ROOT, ["rev-parse", "--show-toplevel"]));
  if (topLevel !== source.repository) {
    fail("canonical-identity-changed", "Canonical repository identity changed during the staging build.", {
      expected: source.repository, observed: topLevel,
    });
  }
  const canonicalBranch = git(REPO_ROOT, ["branch", "--show-current"]);
  if (canonicalBranch !== "main") {
    fail("canonical-branch-changed", "Canonical branch left main during the staging build.", {
      observed: canonicalBranch,
    });
  }
  const canonicalHead = git(REPO_ROOT, ["rev-parse", "HEAD"]);

  if (source.sourceMode === "explicit-worktree") {
    let stat = null;
    try { stat = fs.statSync(source.sourceRoot); } catch { stat = null; }
    if (!stat || !stat.isDirectory()) {
      fail("source-worktree-disappeared", "Selected source worktree vanished during the staging build.", {
        sourceRoot: source.sourceRoot,
      });
    }
    if (gitCommonDir(source.sourceRoot) !== source.sourceCommonDir) {
      fail("source-repository-identity-changed", "Selected source worktree changed repository identity during the build.", {
        sourceRoot: source.sourceRoot,
      });
    }
    if (!registeredWorktreeRoots(REPO_ROOT).includes(source.sourceRoot)) {
      fail("source-worktree-unregistered", "Selected source worktree is no longer registered.", {
        sourceRoot: source.sourceRoot,
      });
    }
  }

  const head = git(source.sourceRoot, ["rev-parse", "HEAD"]);
  if (head !== source.sourceHead) {
    fail("source-head-moved", "Source HEAD moved during the staging build.", {
      approvedHead: source.sourceHead, observed: head,
    });
  }
  const tree = git(source.sourceRoot, ["rev-parse", "HEAD^{tree}"]);
  if (tree !== source.sourceTree) {
    fail("source-tree-changed", "Source tree changed during the staging build.", {
      expected: source.sourceTree, observed: tree,
    });
  }

  const modified = git(source.sourceRoot, ["diff", "--name-only", "HEAD", "--"]);
  const staged = git(source.sourceRoot, ["diff", "--cached", "--name-only"]);
  const untracked = git(source.sourceRoot, ["ls-files", "--others", "--exclude-standard", "--"]);
  if (modified || staged || untracked) {
    fail("source-changed-during-build", "Source changed during the staging build.", {
      modified: modified ? modified.split("\n") : [],
      staged: staged ? staged.split("\n") : [],
      untracked: untracked ? untracked.split("\n") : [],
    });
  }

  // Canonical may advance; the source must remain reachable from it.
  assertSourceAncestry(source.sourceHead, canonicalHead);
}

// ─── staging + builders ──────────────────────────────────────────────────────

function temporaryBaseDirectory() {
  // macOS exposes /tmp and /var as symlinks to /private/*. make-aliases.mjs
  // writes RELATIVE symlinks computed with path.relative(), which the kernel
  // then resolves from the PHYSICAL directory. If the staging root is reached
  // through a symlinked prefix, those relative aliases resolve to the wrong
  // place. Anchoring staging at the resolved temporary directory keeps the
  // lexical and physical paths identical, so staged aliases resolve correctly
  // without changing the guarded writer.
  const base = os.tmpdir();
  try {
    return fs.realpathSync.native(base);
  } catch {
    try {
      return fs.realpathSync(base);
    } catch {
      return base;
    }
  }
}

export function createStagingRoot(targetId = DEV_CONTROLS_TARGET) {
  const policy = publisherTargetPolicy(targetId);
  const root = fs.mkdtempSync(path.join(temporaryBaseDirectory(), "h2o-publish-stage-"));
  const serverRoot = policy.targetId === DEV_CONTROLS_TARGET ? path.join(root, "server") : null;
  const extensionRoot = policy.targetId === STUDIO_LAUNCHER_TARGET
    ? path.join(root, "artifacts", policy.artifactBasename)
    : path.join(root, policy.artifactBasename);
  if (serverRoot) fs.mkdirSync(serverRoot, { recursive: true, mode: 0o700 });
  fs.mkdirSync(extensionRoot, { recursive: true, mode: 0o700 });
  return {
    root,
    targetId: policy.targetId,
    serverRoot,
    aliasDir: serverRoot ? path.join(serverRoot, "alias") : null,
    devOutputDir: serverRoot ? path.join(serverRoot, "dev_output") : null,
    proxyPackFile: serverRoot
      ? path.join(serverRoot, "dev_output", "proxy", "_paste-pack.ext.txt") : null,
    extensionRoot,
    receiptFile: path.join(root, RECEIPT_FILE),
  };
}

/**
 * Build a child environment with every inherited H2O_* variable removed, so a
 * parent shell cannot redirect a staged build into live output. The publisher
 * then sets exactly the destination variables it intends.
 */
/**
 * Every H2O_* variable is stripped before H2O_SRC_DIR is set, so no inherited
 * environment can redirect generation. `sourceRoot` defaults to REPO_ROOT,
 * preserving legacy behaviour for callers that pass no source authority.
 */
export function childEnvironment(extra, sourceRoot = REPO_ROOT) {
  const environment = { ...process.env };
  for (const name of Object.keys(environment)) {
    if (name.startsWith("H2O_")) delete environment[name];
  }
  return { ...environment, H2O_SRC_DIR: sourceRoot, ...extra };
}

function runBuilder(label, relativeScript, extra, sourceRoot = REPO_ROOT) {
  // Tool authority stays canonical: the builder script and its cwd come from
  // REPO_ROOT. Content authority is sourceRoot, carried only by H2O_SRC_DIR.
  const environment = childEnvironment(extra, sourceRoot);
  if (environment.H2O_SRC_DIR !== sourceRoot) {
    fail("source-pinning-violation", "Stage builder environment does not carry the selected source root.", {
      label, expected: sourceRoot, observed: environment.H2O_SRC_DIR ?? null,
    });
  }
  const script = path.join(REPO_ROOT, relativeScript);
  const result = spawnSync(process.execPath, [script], {
    cwd: REPO_ROOT,
    env: environment,
    encoding: "utf8",
    timeout: CHILD_TIMEOUT_MS,
    killSignal: "SIGTERM",
  });
  if (result.error || result.signal || result.status !== 0) {
    fail("builder-failed", `Staged builder failed: ${label}`, {
      label,
      script: relativeScript,
      status: result.status ?? null,
      signal: result.signal ?? null,
      stderr: String(result.stderr || "").trim().split("\n").filter(Boolean).slice(-8),
    });
  }
  return { label, script: relativeScript };
}

function stageAliases(stage, buildTimestamp, sourceRoot) {
  return runBuilder("aliases", "tools/loader/make-aliases.mjs", {
    H2O_SERVER_DIR: stage.serverRoot,
    H2O_ALIAS_SCOPE: "all",
    H2O_BUILD_TS: buildTimestamp,
  }, sourceRoot);
}

function stageDevOutput(stage, buildTimestamp, sourceRoot) {
  return runBuilder("dev-output", "tools/loader/make-ext-proxy-pack.mjs", {
    H2O_SERVER_DIR: stage.serverRoot,
    H2O_DEV_DIR_NAME: "dev_output",
    H2O_BUILD_TS: buildTimestamp,
  }, sourceRoot);
}

function stageExtension(stage, buildTimestamp, sourceRoot, policy = publisherTargetPolicy(stage.targetId)) {
  if (policy.targetId === STUDIO_LAUNCHER_TARGET) {
    return runBuilder("studio-launcher", "tools/product/extensions/chatgpt/chrome/build-chrome-live-extension.mjs", {
      H2O_EXT_OUT_DIR: stage.extensionRoot,
      H2O_EXT_DEV_VARIANT: STUDIO_LAUNCHER_TARGET,
      H2O_BUILD_TS: buildTimestamp,
    }, sourceRoot);
  }
  return runBuilder("extension", "tools/product/extensions/chatgpt/chrome/build-chrome-live-extension.mjs", {
    H2O_EXT_OUT_DIR: stage.extensionRoot,
    H2O_EXT_DEV_VARIANT: "controls",
    H2O_IDENTITY_PHASE_NETWORK: "request_otp",
    H2O_IDENTITY_OAUTH_PROVIDER: "google",
    H2O_BUILD_TS: buildTimestamp,
  }, sourceRoot);
}

// ─── lightweight validation ──────────────────────────────────────────────────

function listFilesRecursive(root) {
  const found = [];
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name, "en"))) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else found.push(absolute);
    }
  };
  if (fs.existsSync(root)) walk(root);
  return found;
}

export function validateStagedAliases(stage, source, worktreeRoots) {
  if (!fs.existsSync(stage.aliasDir) || !fs.statSync(stage.aliasDir).isDirectory()) {
    fail("staged-alias-directory-missing", "Staged alias directory is missing.");
  }
  const entries = fs.readdirSync(stage.aliasDir).filter((name) => name !== ".DS_Store").sort();
  if (entries.length === 0) {
    fail("staged-alias-empty", "Staged alias directory contains no aliases.");
  }
  const approvedWorktree = realAware(source.sourceRoot ?? source.repository);
  const stagedAliasRoot = realAware(stage.aliasDir);
  const foreignWorktrees = worktreeRoots.filter((root) => root !== approvedWorktree);
  let regularFileCount = 0;
  let symlinkCount = 0;
  for (const name of entries) {
    const aliasPath = path.join(stage.aliasDir, name);
    const stat = fs.lstatSync(aliasPath);
    if (!stat.isSymbolicLink()) {
      if (!stat.isFile()) {
        fail("staged-alias-entry-type", "Staged alias entries must be regular files or symlinks.", {
          alias: name,
        });
      }
      regularFileCount += 1;
      continue;
    }
    symlinkCount += 1;
    let resolved;
    try {
      resolved = realAware(fs.realpathSync(aliasPath));
    } catch {
      fail("staged-alias-broken-symlink", "Staged alias is a broken symlink.", { alias: name });
    }
    if (!isWithin(stagedAliasRoot, resolved) && !isWithin(approvedWorktree, resolved)) {
      fail("staged-alias-target-outside-source", "Staged alias target escapes the staged alias tree and approved source worktree.", {
        alias: name,
        resolved,
      });
    }
    for (const foreign of foreignWorktrees) {
      if (isWithin(foreign, resolved)) {
        fail("staged-alias-foreign-worktree-target", "Staged alias points into another registered worktree.", {
          alias: name,
          resolved,
        });
      }
    }
    if (isWithin(path.join(approvedWorktree, "apps", "dev-server"), resolved) ||
        isWithin(path.join(approvedWorktree, "apps", "extensions"), resolved)) {
      fail("staged-alias-generated-target", "Staged alias points into a generated-output tree.", {
        alias: name,
        resolved,
      });
    }
  }
  return { aliasCount: entries.length, regularFileCount, symlinkCount };
}

export function validateStagedDevOutput(stage, buildTimestamp) {
  const proxyDirectory = path.dirname(stage.proxyPackFile);
  if (!fs.existsSync(proxyDirectory)) {
    fail("staged-proxy-directory-missing", "Staged proxy directory is missing.");
  }
  const packs = listFilesRecursive(stage.devOutputDir)
    .filter((file) => path.basename(file) === "_paste-pack.ext.txt");
  if (packs.length !== 1) {
    fail("staged-proxy-pack-count", "Expected exactly one staged proxy pack.", { count: packs.length });
  }
  if (packs[0] !== stage.proxyPackFile) {
    fail("staged-proxy-pack-path", "Staged proxy pack is not at the expected path.", { observed: packs[0] });
  }
  const bytes = fs.statSync(stage.proxyPackFile).size;
  if (bytes <= 0) fail("staged-proxy-pack-empty", "Staged proxy pack is empty.");

  const leftovers = listFilesRecursive(stage.devOutputDir)
    .filter((file) => path.basename(file).startsWith("."))
    .filter((file) => path.basename(file).includes(".tmp-"));
  if (leftovers.length) {
    fail("staged-proxy-temp-file", "A temporary atomic-write file remains in staged dev output.", {
      leftovers: leftovers.map((file) => path.relative(stage.root, file)),
    });
  }

  const text = fs.readFileSync(stage.proxyPackFile, "utf8");
  const marker = (text.match(/^\/\/ buildTs=(\d+)$/mu) || [])[1] || null;
  if (marker !== buildTimestamp) {
    fail("staged-proxy-build-marker-mismatch", "Staged proxy pack build marker does not match this publisher run.", {
      expected: buildTimestamp,
      observed: marker,
    });
  }
  return { proxyPackBytes: bytes, buildMarker: marker };
}

export function validateStagedExtension(stage, source, buildTimestamp, worktreeRoots) {
  for (const relative of REQUIRED_EXTENSION_FILES) {
    const absolute = path.join(stage.extensionRoot, relative);
    if (!fs.existsSync(absolute)) {
      fail("staged-extension-file-missing", "Required staged extension file is missing.", { relative });
    }
    if (fs.statSync(absolute).size <= 0) {
      fail("staged-extension-file-empty", "Required staged extension file is empty.", { relative });
    }
  }

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(stage.extensionRoot, "manifest.json"), "utf8"));
  } catch (error) {
    fail("staged-extension-manifest-unparsable", "Staged extension manifest does not parse.", {
      reason: String(error?.message || error).slice(0, 200),
    });
  }
  if (!manifest || typeof manifest !== "object" || !manifest.manifest_version) {
    fail("staged-extension-manifest-invalid", "Staged extension manifest is not a valid manifest object.");
  }

  const loader = fs.readFileSync(path.join(stage.extensionRoot, "loader.js"), "utf8");
  if (!loader.includes(buildTimestamp)) {
    fail("staged-extension-build-marker-mismatch", "Staged extension loader does not embed this publisher build marker.", {
      expected: buildTimestamp,
    });
  }

  // Artifact provenance root: the worktree the staged bytes were generated
  // from. Falls back to the canonical repository for legacy callers.
  const approvedWorktree = realAware(source.sourceRoot ?? source.repository);
  const foreignWorktrees = worktreeRoots.filter((root) => root !== approvedWorktree);
  for (const file of listFilesRecursive(stage.extensionRoot)) {
    if (!/\.(js|json|txt|html|css)$/u.test(file)) continue;
    const text = fs.readFileSync(file, "utf8");
    for (const foreign of foreignWorktrees) {
      if (text.includes(foreign)) {
        fail("staged-extension-foreign-worktree-path", "Staged extension embeds a foreign worktree path.", {
          relative: path.relative(stage.root, file),
          foreign,
        });
      }
    }
  }

  return { manifestVersion: manifest.manifest_version, requiredFiles: [...REQUIRED_EXTENSION_FILES] };
}

function extensionIdFromManifestKey(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  let bytes;
  try { bytes = Buffer.from(value, "base64"); } catch { return null; }
  if (!bytes.length) return null;
  const alphabet = "abcdefghijklmnop";
  const digest = crypto.createHash("sha256").update(bytes).digest().subarray(0, 16);
  return [...digest].map((byte) => alphabet[byte >> 4] + alphabet[byte & 15]).join("");
}

function relativeArtifactFiles(root) {
  return listFilesRecursive(root)
    .map((file) => path.relative(root, file).split(path.sep).join("/"))
    .sort((left, right) => left.localeCompare(right, "en"));
}

export function validateStagedStudioLauncher(stage, source, worktreeRoots) {
  const policy = publisherTargetPolicy(STUDIO_LAUNCHER_TARGET);
  if (path.basename(stage.extensionRoot) !== policy.artifactBasename) {
    fail("studio-stage-basename", "Studio stage basename must preserve stable extension identity.", {
      expected: policy.artifactBasename,
      observed: path.basename(stage.extensionRoot),
    });
  }

  const expectedFiles = [...STUDIO_LAUNCHER_SHELL_FILES,
    ...ARCHIVE_WORKBENCH_OUT_FILES.map((name) => `surfaces/studio/${name}`)]
    .sort((left, right) => left.localeCompare(right, "en"));
  const actualFiles = relativeArtifactFiles(stage.extensionRoot);
  for (const relative of actualFiles) {
    const absolute = path.join(stage.extensionRoot, ...relative.split("/"));
    const stat = fs.lstatSync(absolute);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      fail("studio-stage-unsafe-entry", "Studio stage contains a non-regular artifact entry.", { relative });
    }
    if (relative.split("/").some((segment) => segment.startsWith("."))) {
      fail("studio-stage-dotfile", "Studio stage contains dotfile contamination.", { relative });
    }
  }
  if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) {
    const expected = new Set(expectedFiles);
    const actual = new Set(actualFiles);
    fail("studio-stage-file-set", "Studio stage file set differs from the pinned launcher and pack allowlists.", {
      missing: expectedFiles.filter((name) => !actual.has(name)),
      unexpected: actualFiles.filter((name) => !expected.has(name)),
    });
  }

  const manifestPath = path.join(stage.extensionRoot, "manifest.json");
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")); } catch (error) {
    fail("studio-stage-manifest", "Studio launcher manifest is not valid JSON.", {
      reason: String(error?.message || error).slice(0, 200),
    });
  }
  if (manifest?.manifest_version !== 3 || manifest?.background?.service_worker !== "bg.js") {
    fail("studio-stage-manifest", "Studio launcher must be an MV3 extension with the pinned service worker.");
  }
  if (Object.prototype.hasOwnProperty.call(manifest, "content_scripts")) {
    fail("studio-stage-manifest", "Studio launcher must not inject content scripts.");
  }
  const configuredId = getExtensionId(STUDIO_LAUNCHER_TARGET);
  const derivedId = extensionIdFromManifestKey(manifest.key);
  if (configuredId !== policy.expectedExtensionId || derivedId !== policy.expectedExtensionId) {
    fail("studio-stage-extension-id", "Studio launcher manifest key does not derive the pinned extension ID.", {
      expected: policy.expectedExtensionId,
      configured: configuredId,
      derived: derivedId,
    });
  }

  const packed = compareArchiveWorkbenchToSource(source.sourceRoot ?? source.repository, stage.extensionRoot);
  if (!packed.matches) {
    fail("studio-stage-source-drift", "Packed Studio files differ from the authorized source allowlist.", {
      mismatches: packed.files.filter((entry) => !entry.sourceExists || !entry.outExists || !entry.equal)
        .map((entry) => entry.name),
    });
  }
  const studioHtml = fs.readFileSync(path.join(stage.extensionRoot, "surfaces", "studio", "studio.html"), "utf8");
  const refs = parseStudioHtmlScriptRefs(studioHtml);
  const positions = STUDIO_REQUIRED_ORDER.map((name) => refs.indexOf(name));
  if (positions.some((index) => index < 0) || positions.some((index, offset) => offset > 0 && index <= positions[offset - 1])) {
    fail("studio-stage-load-order", "Studio selectors, sanitizer, Renderer and orchestration load order is invalid.", {
      required: [...STUDIO_REQUIRED_ORDER], positions,
    });
  }

  const approvedWorktree = realAware(source.sourceRoot ?? source.repository);
  const foreignWorktrees = worktreeRoots.filter((root) => root !== approvedWorktree);
  for (const relative of actualFiles) {
    if (!/\.(?:js|json|txt|html|css)$/u.test(relative)) continue;
    const text = fs.readFileSync(path.join(stage.extensionRoot, ...relative.split("/")), "utf8");
    for (const foreign of foreignWorktrees) {
      if (text.includes(foreign)) {
        fail("studio-stage-foreign-worktree-path", "Studio artifact embeds a foreign worktree path.", {
          relative, foreign,
        });
      }
    }
  }

  return Object.freeze({
    manifestVersion: 3,
    extensionId: derivedId,
    requiredLoadOrder: [...STUDIO_REQUIRED_ORDER],
    packedFileCount: packed.files.length,
    exactFileSet: true,
  });
}

function sha256Bytes(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function knownStudioReceipt(anchorRoot, treeDigest) {
  const directory = path.join(anchorRoot, "activations");
  let names;
  try { names = fs.readdirSync(directory).filter((name) => name.endsWith(".json")).sort().reverse(); } catch { return null; }
  for (const name of names) {
    const receiptPath = path.join(directory, name);
    try {
      const stat = fs.lstatSync(receiptPath);
      if (!stat.isFile() || stat.isSymbolicLink()) continue;
      const bytes = fs.readFileSync(receiptPath);
      const receipt = JSON.parse(bytes.toString("utf8"));
      const observedDigest = receipt?.promotedCanonicalIdentities?.studio_launcher?.treeDigest ??
        receipt?.promotedCanonicalIdentities?.extension?.treeDigest ?? null;
      if (receipt?.publicationTarget === STUDIO_LAUNCHER_TARGET && observedDigest === treeDigest) {
        return Object.freeze({
          provenanceStatus: "governed-receipt",
          publicationReceiptPath: receiptPath,
          publicationReceiptSha256: sha256Bytes(bytes),
          generationId: receipt.generationId ?? null,
        });
      }
    } catch {}
  }
  return null;
}

export function captureStudioCanonicalBaseline(repository, anchorRoot) {
  const canonicalPath = path.join(repository, "apps", "extensions", "chatgpt", "chrome", STUDIO_LAUNCHER_TARGET);
  let stat;
  try { stat = fs.lstatSync(canonicalPath); } catch (error) {
    if (error?.code === "ENOENT") {
      return Object.freeze({ state: "absent", canonicalPath, treeDigest: null, fileCount: 0,
        manifest: Object.freeze([]), generationId: null, provenanceStatus: "absent" });
    }
    throw error;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    fail("studio-canonical-baseline-invalid", "Canonical Studio launcher must be a real directory or absent.", {
      canonicalPath,
    });
  }
  const manifest = buildManifest(canonicalPath, canonicalPath);
  const known = knownStudioReceipt(anchorRoot, manifest.treeDigest);
  return Object.freeze({
    state: "present",
    canonicalPath,
    treeDigest: manifest.treeDigest,
    fileCount: manifest.fileCount,
    manifest: Object.freeze(manifest.entries.map((entry) => Object.freeze({ ...entry }))),
    generationId: known?.generationId ?? null,
    provenanceStatus: known?.provenanceStatus ?? "legacy-unreceipted",
    publicationReceiptPath: known?.publicationReceiptPath ?? null,
    publicationReceiptSha256: known?.publicationReceiptSha256 ?? null,
  });
}

function studioGenerationId({ source, artifactManifest, buildTimestamp }) {
  return sha256Bytes(JSON.stringify({
    targetId: STUDIO_LAUNCHER_TARGET,
    sourceCommit: source.sourceHead,
    sourceTree: source.sourceTree,
    artifactTreeDigest: artifactManifest.treeDigest,
    buildMarker: buildTimestamp,
  }));
}

export function validateCrossOutput(stage) {
  const stagingRoot = realAware(stage.root);
  const required = [stage.aliasDir, stage.devOutputDir, stage.proxyPackFile, stage.extensionRoot];
  for (const target of required) {
    if (!fs.existsSync(target)) {
      fail("staged-output-missing", "A required staged output is missing.", {
        relative: path.relative(stage.root, target),
      });
    }
  }
  const everything = [
    ...listFilesRecursive(stage.aliasDir),
    ...listFilesRecursive(stage.devOutputDir),
    ...listFilesRecursive(stage.extensionRoot),
  ];
  for (const file of everything) {
    if (!isWithin(stagingRoot, realAware(path.dirname(file)))) {
      fail("staged-output-escaped", "A staged output path escapes the staging root.", { file });
    }
  }
  return { stagedFileCount: everything.length };
}

// ─── manifests + receipt ─────────────────────────────────────────────────────

export function buildManifest(root, stagingRoot) {
  const entries = [];
  for (const file of listFilesRecursive(root)) {
    const relative = path.relative(stagingRoot, file).split(path.sep).join("/");
    const stat = fs.lstatSync(file);
    entries.push(stat.isSymbolicLink()
      ? { path: relative, type: "symlink", target: fs.readlinkSync(file) }
      : { path: relative, type: "file", bytes: stat.size, sha256: sha256File(file) });
  }
  // Symlinked aliases are listed via lstat above; readdir order is normalised.
  const aliasLinks = fs.existsSync(root)
    ? fs.readdirSync(root).filter((name) => {
      try { return fs.lstatSync(path.join(root, name)).isSymbolicLink(); } catch { return false; }
    }).map((name) => ({
      path: path.relative(stagingRoot, path.join(root, name)).split(path.sep).join("/"),
      type: "symlink",
      target: fs.readlinkSync(path.join(root, name)),
    }))
    : [];
  const merged = [...entries, ...aliasLinks]
    .filter((entry, index, all) => all.findIndex((other) => other.path === entry.path) === index)
    .sort((a, b) => a.path.localeCompare(b.path, "en"));
  const digest = crypto.createHash("sha256")
    .update(merged.map((entry) => JSON.stringify(entry)).join("\n"))
    .digest("hex");
  return { fileCount: merged.length, treeDigest: digest, entries: merged };
}

function writeReceipt(stage, receipt) {
  const temporary = path.join(stage.root, `.${RECEIPT_FILE}.tmp`);
  fs.writeFileSync(temporary, `${JSON.stringify(receipt, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporary, stage.receiptFile);
  return stage.receiptFile;
}

// ─── main ────────────────────────────────────────────────────────────────────

/**
 * Batch 2A-R.1 argument surface: --stage-only, plus one optional
 * --source-worktree <path>. No destination argument exists and none may be
 * added here; source selection changes artifact authority only.
 */
export function parsePublisherArguments(argv) {
  const args = argv.slice();
  let stageOnly = false;
  let sourceWorktree = null;
  let targetId = DEV_CONTROLS_TARGET;
  let targetSupplied = false;
  let authorizedHead = null;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--stage-only") {
      if (stageOnly) fail("invalid-arguments", "--stage-only may be supplied only once.", { args });
      stageOnly = true;
      continue;
    }
    if (arg === "--source-worktree") {
      if (sourceWorktree !== null) {
        fail("invalid-arguments", "--source-worktree may be supplied only once.", { args });
      }
      const value = args[index + 1];
      if (typeof value !== "string" || !value || value.startsWith("--")) {
        fail("invalid-arguments", "--source-worktree requires exactly one path value.", { args });
      }
      sourceWorktree = value;
      index += 1;
      continue;
    }
    if (arg === "--target") {
      if (targetSupplied) fail("invalid-arguments", "--target may be supplied only once.", { args });
      const value = args[index + 1];
      if (typeof value !== "string" || !value || value.startsWith("--")) {
        fail("invalid-arguments", "--target requires exactly one target ID.", { args });
      }
      publisherTargetPolicy(value);
      targetId = value;
      targetSupplied = true;
      index += 1;
      continue;
    }
    if (arg === "--authorized-head") {
      if (authorizedHead !== null) fail("invalid-arguments", "--authorized-head may be supplied only once.", { args });
      const value = args[index + 1];
      if (typeof value !== "string" || !/^[a-f0-9]{40}$/u.test(value)) {
        fail("invalid-arguments", "--authorized-head requires one full lowercase Git object ID.", { args });
      }
      authorizedHead = value;
      index += 1;
      continue;
    }
    fail("invalid-arguments", "Lean publisher accepts --stage-only, target authority and optional source selection only.", { args });
  }

  if (!stageOnly) {
    fail("invalid-arguments", "Lean publisher requires --stage-only.", { args });
  }
  const policy = publisherTargetPolicy(targetId);
  if (policy.exactCanonicalHeadRequired && authorizedHead === null) {
    fail("authorized-head-required", "Studio staging requires an explicitly authorized exact canonical HEAD.");
  }
  if (!policy.exactCanonicalHeadRequired && authorizedHead !== null) {
    fail("authorized-head-not-applicable", "Legacy Dev Controls staging does not accept Studio head authority.");
  }
  return Object.freeze({ stageOnly, sourceWorktree, targetId, authorizedHead });
}

export async function runLeanPublisher({ argv = [] } = {}) {
  const parsed = parsePublisherArguments(argv);
  const policy = publisherTargetPolicy(parsed.targetId);

  const startedAt = new Date().toISOString();
  const buildTimestamp = String(Date.now());
  const source = runSourcePreflight({ sourceWorktree: parsed.sourceWorktree });
  if (policy.exactCanonicalHeadRequired &&
      (source.sourceHead !== parsed.authorizedHead || source.approvedHead !== parsed.authorizedHead)) {
    fail("authorized-head-mismatch", "Studio source, authorized HEAD and canonical main must be exactly equal.", {
      sourceHead: source.sourceHead,
      canonicalHead: source.approvedHead,
      authorizedHead: parsed.authorizedHead,
    });
  }

  const anchor = deriveSharedAnchor({ cwd: REPO_ROOT, env: {}, allowOverride: false });
  // Sibling of the canonical anchor: this publisher never creates that anchor.
  const lockDirectory = path.join(anchor.cockpitProRoot, LOCK_DIR_NAME);
  const worktreeRoots = [...anchor.registeredWorktreeRoots].map(realAware);

  const lock = acquireLock(lockDirectory, {
    pid: process.pid,
    repository: source.repository,
    approvedHead: source.approvedHead,
    startedAt,
  });

  let stage = null;
  try {
    const canonicalBaselineBefore = policy.targetId === STUDIO_LAUNCHER_TARGET
      ? captureStudioCanonicalBaseline(source.repository, anchor.root) : null;
    stage = createStagingRoot(policy.targetId);

    if (policy.targetId === DEV_CONTROLS_TARGET) {
      stageAliases(stage, buildTimestamp, source.sourceRoot);
      stageDevOutput(stage, buildTimestamp, source.sourceRoot);
    }
    stageExtension(stage, buildTimestamp, source.sourceRoot, policy);

    assertSourceStillClean(source);
    if (policy.exactCanonicalHeadRequired) {
      const currentCanonicalHead = git(REPO_ROOT, ["rev-parse", "HEAD"]);
      if (currentCanonicalHead !== parsed.authorizedHead || source.sourceHead !== parsed.authorizedHead) {
        fail("authorized-head-drift", "Canonical or source HEAD changed during Studio staging.", {
          authorizedHead: parsed.authorizedHead,
          currentCanonicalHead,
          sourceHead: source.sourceHead,
        });
      }
    }

    const aliasResult = policy.targetId === DEV_CONTROLS_TARGET
      ? validateStagedAliases(stage, source, worktreeRoots) : null;
    const devOutputResult = policy.targetId === DEV_CONTROLS_TARGET
      ? validateStagedDevOutput(stage, buildTimestamp) : null;
    const extensionResult = policy.targetId === STUDIO_LAUNCHER_TARGET
      ? validateStagedStudioLauncher(stage, source, worktreeRoots)
      : validateStagedExtension(stage, source, buildTimestamp, worktreeRoots);
    const crossResult = policy.targetId === DEV_CONTROLS_TARGET
      ? validateCrossOutput(stage)
      : { stagedFileCount: relativeArtifactFiles(stage.extensionRoot).length };

    const manifests = policy.targetId === DEV_CONTROLS_TARGET
      ? {
          alias: buildManifest(stage.aliasDir, stage.root),
          devOutput: buildManifest(stage.devOutputDir, stage.root),
          extension: buildManifest(stage.extensionRoot, stage.root),
        }
      : { extension: buildManifest(stage.extensionRoot, stage.root) };

    const canonicalBaseline = policy.targetId === STUDIO_LAUNCHER_TARGET
      ? captureStudioCanonicalBaseline(source.repository, anchor.root) : null;
    if (canonicalBaselineBefore &&
        (canonicalBaselineBefore.state !== canonicalBaseline.state ||
         canonicalBaselineBefore.treeDigest !== canonicalBaseline.treeDigest)) {
      fail("studio-canonical-baseline-drift", "Canonical Studio launcher changed during isolated staging.", {
        before: canonicalBaselineBefore.treeDigest,
        after: canonicalBaseline.treeDigest,
      });
    }

    const completedAt = new Date().toISOString();
    const fileCounts = policy.targetId === DEV_CONTROLS_TARGET
      ? {
          alias: manifests.alias.fileCount,
          devOutput: manifests.devOutput.fileCount,
          extension: manifests.extension.fileCount,
          total: crossResult.stagedFileCount,
        }
      : { extension: manifests.extension.fileCount, total: crossResult.stagedFileCount };
    const treeDigests = policy.targetId === DEV_CONTROLS_TARGET
      ? {
          alias: manifests.alias.treeDigest,
          devOutput: manifests.devOutput.treeDigest,
          extension: manifests.extension.treeDigest,
        }
      : { extension: manifests.extension.treeDigest };
    const outputPaths = policy.targetId === DEV_CONTROLS_TARGET
      ? {
          alias: stage.aliasDir,
          devOutput: stage.devOutputDir,
          proxyPack: stage.proxyPackFile,
          extension: stage.extensionRoot,
        }
      : { extension: stage.extensionRoot };
    const receipt = {
      schemaVersion: policy.receiptSchemaVersion,
      mode: "stage-only",
      publicationTarget: policy.targetId,
      outputFamilies: [...policy.outputFamilies],
      repository: source.repository,
      remote: source.remote,
      branch: source.branch,
      approvedHead: source.approvedHead,
      // Artifact-generation authority. repository/branch/approvedHead above stay
      // canonical comparison authority; commonDir + head + tree are the durable
      // identity here and worktreeRoot is audit metadata, not a trust anchor.
      sourceAuthority: {
        mode: source.sourceMode,
        commonDir: source.sourceCommonDir,
        head: source.sourceHead,
        tree: source.sourceTree,
        branch: source.sourceBranch,
        worktreeRoot: source.sourceRoot,
      },
      stagedExtensionVariant: policy.extensionVariant,
      authorizedHead: parsed.authorizedHead,
      expectedExtensionId: policy.expectedExtensionId,
      buildTimestamp,
      startedAt,
      completedAt,
      stagingRoot: stage.root,
      outputPaths,
      fileCounts,
      treeDigests,
      manifests,
      validatorResult: {
        ok: true,
        alias: aliasResult,
        devOutput: devOutputResult,
        extension: extensionResult,
        crossOutput: crossResult,
      },
      lock: {
        directory: lockDirectory,
        ownerId: lock.ownerId,
      },
      activationPerformed: false,
      runtimeActivationPerformed: false,
      browserReloadPerformed: false,
      browserCanaryPerformed: false,
      deploymentPerformed: false,
      releasePerformed: false,
      pushPerformed: false,
    };

    if (policy.targetId === STUDIO_LAUNCHER_TARGET) {
      receipt.generationId = studioGenerationId({ source, artifactManifest: manifests.extension, buildTimestamp });
      receipt.canonicalBaseline = canonicalBaseline;
      receipt.validatorResult.packReference = Object.freeze({ ok: true, sourceMatches: true });
    } else {
      // Preserve the accepted v1 Dev Controls receipt surface exactly. Target-aware
      // fields belong only to schema v2 and are never retrofitted onto legacy bytes.
      for (const field of ["publicationTarget", "outputFamilies", "authorizedHead",
        "expectedExtensionId", "runtimeActivationPerformed", "deploymentPerformed", "releasePerformed"]) {
        delete receipt[field];
      }
    }

    const receiptFile = writeReceipt(stage, receipt);
    return { ok: true, stagingRoot: stage.root, receiptFile, receipt };
  } catch (error) {
    // Remove only the staging root this invocation created; never live output.
    if (stage) {
      try {
        const stat = fs.lstatSync(stage.root);
        if (!stat.isSymbolicLink() && isWithin(realAware(os.tmpdir()), realAware(stage.root))) {
          fs.rmSync(stage.root, { recursive: true, force: true });
        }
      } catch {
        // Cleanup failure must not mask the original error.
      }
    }
    throw error;
  } finally {
    releaseLock(lockDirectory, process.pid, lock.ownerId);
  }
}

const invokedDirectly = process.argv[1] &&
  realAware(process.argv[1]) === realAware(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  runLeanPublisher({ argv: process.argv.slice(2) })
    .then((result) => {
      console.log("[H2O] lean publisher: stage-only build complete");
      console.log(`[H2O]   approved HEAD : ${result.receipt.approvedHead}`);
      console.log(`[H2O]   build marker  : ${result.receipt.buildTimestamp}`);
      console.log(`[H2O]   staging root  : ${result.stagingRoot}`);
      console.log(`[H2O]   receipt       : ${result.receiptFile}`);
      console.log("[H2O]   activation, Chrome reload, browser canary and push: NOT performed");
    })
    .catch((error) => {
      const body = {
        ok: false,
        error: typeof error?.code === "string" ? error.code : "lean-publisher-failed",
        message: typeof error?.message === "string" ? error.message : "Lean publisher failed.",
      };
      if (error?.details !== undefined) body.details = error.details;
      process.stderr.write(`[H2O] lean publisher rejected: ${JSON.stringify(body)}\n`);
      process.exitCode = 1;
    });
}
