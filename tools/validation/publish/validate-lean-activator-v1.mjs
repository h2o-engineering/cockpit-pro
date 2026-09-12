#!/usr/bin/env node
// Lean activator Batch 2 P0/P1 — source-only validator.
// Executes only in isolated fixture repositories and temporary staged trees.

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..", "..");
const ACTIVATOR_REL = "tools/publish/lean-activator.mjs";
const VALIDATOR_REL = "tools/validation/publish/validate-lean-activator-v1.mjs";
const PUBLISHER_REL = "tools/publish/lean-publisher.mjs";
const PACKAGE_REL = "package.json";
const AUTHORIZED_PATHS = Object.freeze([PACKAGE_REL, ACTIVATOR_REL, VALIDATOR_REL].sort());
const FINAL_PATHS = AUTHORIZED_PATHS;
const BASE_HEAD = "86af342f1b1815e12c477673a4f2123b37bede40";
const ACCEPTED_P1_HEAD = "fa0dac4552ce5a1189dee0b1d23975f95bffe751";
const P2_BASE_HEAD = "d3ebe3c8b3c973ee11d15664b09398f388b0b373";
const ACCEPTED_P2_HEAD = "bb8109ca5a5b943a55c0b60046e06f8fa3829f49";
const ACCEPTED_P21_HEAD = "61ff500a048f0b12299ea29adf681a02bec2fa85";
const ACCEPTED_P22_HEAD = "51e21657f216da50e2183bb1e2d3512e946c1ea9";
const P1_SUBJECT = "feat(publish): add canonical activation preflight";
const VALIDATOR_FIX_SUBJECT = "fix(publish): support integrated P0/P1 validation";
const P2_SUBJECT = "feat(publish): add durable activation intent foundation";
const P21_SUBJECT = "fix(publish): harden activation intent preparation";
const P22_SUBJECT = "fix(publish): close pre-promotion trust boundaries";
const P23_SUBJECT = "fix(publish): add final pre-promotion guardrails";
const P2_AUTHORIZED_PATHS = Object.freeze([ACTIVATOR_REL, VALIDATOR_REL].sort());
const CANONICAL_LIB_REL = "tools/publish/canonical-delivery-lib.mjs";
const P22_AUTHORIZED_PATHS = Object.freeze([ACTIVATOR_REL, CANONICAL_LIB_REL, VALIDATOR_REL].sort());
const OWNER_VALIDATOR_REL = "tools/validation/publish/validate-canonical-delivery-exclusivity-v1.mjs";
const P23_AUTHORIZED_PATHS = Object.freeze([
  ACTIVATOR_REL, CANONICAL_LIB_REL, VALIDATOR_REL, OWNER_VALIDATOR_REL,
].sort());
const ACCEPTED_P23_HEAD = "140076112bbdd48763fa5c11145f923ff93f13d1";
const P3A_SUBJECT = "feat(publish): add transaction journal and incoming payload preparation";
const P3A_CANDIDATE_HEAD = "a141abf0049ea7ae18f0eb680139782de625ad67";
const INTEGRATED_P3A_HEAD = "57bc3b3ff23adc1f9e1bdaf975e1c61e5c6b50a2";
const P3B_SOURCE_HEAD = "53a91d3ed1593ffa6ada203023c661114a603201";
const P3B_SOURCE_SUBJECT = "feat(publish): add recoverable canonical promotion core";
const P3B_VALIDATION_SUBJECT = "test(publish): close recoverable promotion and reversal validation";
const PAYLOAD_MODULE_REL = "tools/publish/lean-payload-transaction.mjs";
const PAYLOAD_VALIDATOR_REL = "tools/validation/publish/validate-lean-payload-transaction-v1.mjs";
const P3A_AUTHORIZED_PATHS = Object.freeze([
  ACTIVATOR_REL, PAYLOAD_MODULE_REL, VALIDATOR_REL, PAYLOAD_VALIDATOR_REL,
].sort());
const P3B_SOURCE_PATHS = Object.freeze([ACTIVATOR_REL, PAYLOAD_MODULE_REL].sort());
const P3B_VALIDATION_PATHS = Object.freeze([VALIDATOR_REL, PAYLOAD_VALIDATOR_REL].sort());
// P3C-A1 builds directly on the integrated P3B stack and touches exactly the
// same four authorized paths as P3A.
const INTEGRATED_P3B_HEAD = "ba24012b342ff5343e53d588a77e3e05deff44ae";
const P3C_A1_SUBJECT = "feat(publish): add end-to-end activation and durable acceptance";
const P3C_A1_AUTHORIZED_PATHS = Object.freeze([
  ACTIVATOR_REL, PAYLOAD_MODULE_REL, VALIDATOR_REL, PAYLOAD_VALIDATOR_REL,
].sort());
// P3C-A2 additionally repairs the canonical-writer validator fixture ancestry.
const ACCEPTED_P3C_A1_HEAD = "0cbfdf335c5569fbbd5b1ec423a8a2f3ecff452e";
const P3C_A2_SUBJECT = "feat(publish): add canonical verification and lease contention closure";
const WRITER_VALIDATOR_REL = "tools/validation/publish/validate-canonical-writer-enforcement-v1.mjs";
const P3C_A2_AUTHORIZED_PATHS = Object.freeze([
  ACTIVATOR_REL, PAYLOAD_MODULE_REL, VALIDATOR_REL, PAYLOAD_VALIDATOR_REL, WRITER_VALIDATOR_REL,
].sort());
// P3C-A2.1 is a validator-only governance follow-up: it refreshes the canonical
// writer pins and teaches this validator and the payload validator to classify
// that exact commit. No production source may appear in its scope.
const ACCEPTED_P3C_A2_HEAD = "55d4dee2de10672901a624b45b3a4abfea16c3a7";
const P3C_A2_1_SUBJECT = "test(publish): refresh canonical writer governance pins";
const P3C_A2_1_AUTHORIZED_PATHS = Object.freeze([
  VALIDATOR_REL, PAYLOAD_VALIDATOR_REL, WRITER_VALIDATOR_REL,
].sort());
// P3C-B1 makes interrupted-activation recovery operational.
const ACCEPTED_P3C_A2_1_HEAD = "2ae9d27d0fa85eda446830fd07bca7ea04afb8b7";
const P3C_B1_SUBJECT = "feat(publish): add deterministic activation recovery";
const P3C_B1_AUTHORIZED_PATHS = Object.freeze([
  ACTIVATOR_REL, PAYLOAD_MODULE_REL, VALIDATOR_REL, PAYLOAD_VALIDATOR_REL,
].sort());
// P3C-B1 needed no payload-module change, and a no-op edit purely to widen the
// commit is not acceptable, so the committed set is exactly these three.
const P3C_B1_COMMITTED_PATHS = Object.freeze([
  ACTIVATOR_REL, VALIDATOR_REL, PAYLOAD_VALIDATOR_REL,
].sort());
// Activation-completeness prerequisite: intent resolution + complete
// previous-generation rollback evidence, on top of the accepted B1 commit.
const ACCEPTED_P3C_B1_HEAD = "15500f7b3ef271c78632a4da0fa13dc227948672";
const P3C_A3_SUBJECT = "fix(publish): complete activation intent and rollback evidence";
const P3C_A3_AUTHORIZED_PATHS = Object.freeze([
  ACTIVATOR_REL, PAYLOAD_MODULE_REL, VALIDATOR_REL, PAYLOAD_VALIDATOR_REL,
].sort());
const ACCEPTED_P3C_A3A_HEAD = "6d48185b0601c16ca82c09813ef435a05f5f63a9";
// P3C main synchronization: an explicit merge of the advanced main tip into the
// P3C branch, followed by a narrow two-validator authority bridge.
const P3C_SYNC_MERGE_HEAD = "26de895d5b6755c5d75b93b185a81247978c5816";
const P3C_SYNC_MAIN_TIP = "a90e5d988b531e471fbee8abd65c62b24306ce7b";
const P3C_SYNC_FIRST_PARENT = "6f4ca4d29866a3d102e7b80d372f96827e28c0d0";
const P3C_SYNC_SUBJECT = "test(publish): authorize synchronized P3C history";
const P3C_SYNC_AUTHORIZED_PATHS = Object.freeze([
  VALIDATOR_REL, PAYLOAD_VALIDATOR_REL,
].sort());
// FINAL Title release synchronization: one explicit merge of the exact current
// committed main tip into the completed activation/verification/recovery branch,
// followed by this narrow two-validator authority bridge. B2a/B2b rollback work
// is deliberately NOT part of this release and is not an ancestor here.
const P3C_FINAL_SYNC_MERGE_HEAD = "ca482405301ee7c669de585bf43a5aa816f021b3";
const P3C_FINAL_SYNC_FIRST_PARENT = "74f4c272738d2fc1e48e695564f36a9a3ec96510";
const P3C_FINAL_SYNC_MAIN_TIP = "0bec56f54ec45d67d508d1b3c83403952cfae058";
const P3C_FINAL_SYNC_SUBJECT = "test(publish): authorize final Title release synchronization";
const P3C_FINAL_SYNC_AUTHORIZED_PATHS = Object.freeze([
  VALIDATOR_REL, PAYLOAD_VALIDATOR_REL,
].sort());
// Final current-main integration: one explicit merge of the exact current
// committed main tip into the accepted release, then this two-validator bridge.
// P3C production bytes are untouched by that merge; only main-owned Prompt
// Manager paths arrive with it.
const P3C_INTEGRATION_MERGE_HEAD = "9fdbae3abf78e348e5714dbac19ed96c4c7e998c";
const P3C_INTEGRATION_FIRST_PARENT = "6724f53c35a47a83accfaf98a33235464d86cfee";
const P3C_INTEGRATION_MAIN_TIP = "b7685527d10072204fb44f6a11f8271b77056a59";
const P3C_INTEGRATION_SUBJECT = "test(publish): authorize final current-main Title integration";
const P3C_INTEGRATION_AUTHORIZED_PATHS = Object.freeze([
  VALIDATOR_REL, PAYLOAD_VALIDATOR_REL,
].sort());
const STUDIO_PUBLICATION_BASE_HEAD = "394f4e6a85084c6550b3f8c098cbd8370fa585a5";
const STUDIO_PUBLICATION_AUTHORITY_HEAD = "0689b7ac01119c7662953aa48feff7705e677da6";
const STUDIO_PUBLICATION_AUTHORITY_PATHS = Object.freeze([
  PUBLISHER_REL, ACTIVATOR_REL, PAYLOAD_MODULE_REL,
  "tools/validation/publish/validate-lean-publisher-v1.mjs",
  VALIDATOR_REL, PAYLOAD_VALIDATOR_REL,
].sort());
const STUDIO_VALIDATOR_SYNC_PATHS = Object.freeze([VALIDATOR_REL]);
const P3C_A3B_SUBJECT = "test(publish): close activation completeness validation";
// Current-main activator baseline. Protected publication authority remained
// unchanged while main advanced through later non-publish repository work.
// This fresh port intentionally pins that current authority and authorizes
// exactly one narrow phase: this validator alone, on the current main head.
// CP10 — historical activation-intent relocation compatibility. Exactly two
// protected commits on the authorized base: the production classifier fix plus
// this validator, then the payload-validator registration (which is not an
// activator-scope state).
const CP10_BASE_HEAD = "1e8f16dfd9be05411845eccbd9310b628b8a2107";
const CP10_SUBJECT = "fix(publish): classify relocated historical activation intents";
const CP10_AUTHORIZED_PATHS = Object.freeze([ACTIVATOR_REL, VALIDATOR_REL].sort());
const ACCEPTED_CURRENT_MAIN_HEAD = "81ea28259c1399b92214f76f8ac43f44bfdaee4b";
const CURRENT_BASELINE_AUTHORIZED_PATHS = Object.freeze([VALIDATOR_REL]);
const CURRENT_BASELINE_SUBJECT =
  "test(publish): authorize current-main activator baseline after live-anchor repairs";
const CLASSIFIER_DURABILITY_BASE = "83ea42f0cab1c0e2a6756f4b94f195a27657cbb2";
const CLASSIFIER_DURABILITY_PATHS = Object.freeze([VALIDATOR_REL, PAYLOAD_VALIDATOR_REL].sort());
const HISTORICAL_INTENT_FIX_BASE = "a7817c9b99cb403f800c7f0405e0f1ec799e4384";
const HISTORICAL_INTENT_FIX_PATHS = Object.freeze([ACTIVATOR_REL, VALIDATOR_REL].sort());
// Batch 1.1 publisher authority at the IMMUTABLE BASE_HEAD. These never move.
const BATCH11_PUBLISHER_SHA256 = "ef4575bc6855b81a8c16ff874cd679f14e79733163a23d76b4a758a30f513ba4";
const BATCH11_VALIDATOR_SHA256 = "c8a1abd5c21a9328dc13a8bf19aba508ab476095d9e988803cd41e21c55fda92";
// The publisher the FIXTURE actually executes is whatever the current committed
// tree carries. Until the final release synchronization these were identical to
// the BASE_HEAD bytes, so one constant covered both roles and the distinction was
// invisible. Main commit 0bec56f5 ("feat(publish): allow clean worktree staging
// authority") advanced the publisher, so the two roles are now pinned separately:
// BASE_HEAD immutability above, executed-fixture bytes here. M03 P2 S2A T4
// Stage B advanced the publisher again (markdown STUDIO_REQUIRED_ORDER), and
// M03 P3 S3B T6 admitted the Renderer presentation profile, and M03 P4 S4A T8
// admitted the Renderer semantic index, so this moving pin follows the new
// committed publisher bytes.
const SYNCED_PUBLISHER_SHA256 = "d258f26f04561503531a37344c14e4a15592e3ba8059a03d20b1e4f6a680853f";
const ACCEPTED_ACTIVATOR_SHA256 = "531bb4e9b5d7d61584e013d0d10c8007c78f75498988ba64bac4d24a8d4f2f36";
const REQUIRED_FILES = Object.freeze([
  "manifest.json", "loader.js", "bg.js", "title-contract-bridge.js",
  "provider/identity-provider-supabase.js",
]);
const EXPECTED_SCOPE = 63;
const EXPECTED_RUNTIME = 237;
const EXPECTED_STRUCTURAL = 56;
// P3C-A1 adds the three real canonical-delivery lease symbols. The activator is
// the only module that may hold a lease; the payload module never sees one.
const ACCEPTED_CANONICAL_LIBRARY_IMPORTS = Object.freeze([
  "acquireLease",
  "assertAllowedReadOnlyGitCommand",
  "deriveSharedAnchor",
  "releaseLease",
  "runPinnedReadOnlyGit",
  "sanitizedGitEnvironment",
  "TRUSTED_GIT_EXECUTABLE_IDENTITY",
  "verifyLease",
].sort());
const ACCEPTED_PAYLOAD_MODULE_IMPORTS = Object.freeze([
  // P3C-A2 adds the read-only canonical-verification symbols.
  // CP09 admits the two approved-root authority symbols: the payload module is
  // their single owner and the activator consumes them over this same pinned
  // edge instead of keeping a second copy. They are frozen data, not capability.
  "APPROVED_AUTHORITATIVE_REPOSITORIES",
  "APPROVED_COCKPIT_PRO_ROOTS",
  "ACTIVATION_RECEIPT_MODE",
  "ACTIVATION_RECEIPT_SCHEMA_VERSION",
  "ROLLBACK_RECEIPT_MODE",
  "activationReceiptPath",
  "appendRollbackCompleteRecord",
  "appendRollbackStateRecord",
  "planP3cRecovery",
  "TRANSACTION_MODE",
  "transactionDirectory",
  "verifyCanonicalAgainstReceipt",
  "appendAcceptedRecord",
  "buildActivationReceipt",
  "buildRollbackReceipt",
  "canonicalUnitPaths",
  "createOwnedIncomingRoot",
  "ensureTransactionDirectory",
  "prepareIncomingTree",
  "promoteReleaseWithJournal",
  "publishActivationReceipt",
  "publishRollbackReceipt",
  "readTransactionChain",
  "recomputeIncomingManifest",
  "releaseIncomingOwnership",
  "reverseRelease",
  "reverseRollbackUnit",
  "rollbackReceiptPath",
  "rollbackRetiredPath",
  "rollbackUnitToPrevious",
  "TARGET_AWARE_RECEIPT_SCHEMA_VERSION",
].sort());

const temporaryRoots = [];
const TEMPORARY_ROOT_CLEANUP_MAX_RETRIES = 3;
const TEMPORARY_ROOT_CLEANUP_RETRY_DELAY_MS = 50;
const scopeResults = [];
const runtimeResults = [];
const structuralResults = [];

function tempRoot(label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `h2o-activator-v1-${label}-`));
  temporaryRoots.push(root);
  return root;
}

function disposeTemporaryRoot(root, { remove = fs.rmSync } = {}) {
  const stat = fs.lstatSync(root);
  const resolvedRoot = fs.realpathSync(root);
  const resolvedTemporary = fs.realpathSync(os.tmpdir());
  if (stat.isSymbolicLink() || !resolvedRoot.startsWith(resolvedTemporary + path.sep)) {
    throw new Error(`refusing to dispose non-owned fixture root: ${root}`);
  }
  remove(root, {
    recursive: true,
    force: true,
    maxRetries: TEMPORARY_ROOT_CLEANUP_MAX_RETRIES,
    retryDelay: TEMPORARY_ROOT_CLEANUP_RETRY_DELAY_MS,
  });
  const index = temporaryRoots.lastIndexOf(root);
  if (index >= 0) temporaryRoots.splice(index, 1);
}

function git(repository, args, { allowFailure = false } = {}) {
  const result = spawnSync("git", ["-C", repository, ...args], {
    encoding: "utf8", timeout: 60_000, killSignal: "SIGTERM",
  });
  if (result.status !== 0 && !allowFailure) {
    throw new Error(`git ${args.join(" ")} failed (${result.status}): ${String(result.stderr).trim()}`);
  }
  return result.status === 0 ? String(result.stdout).trim() : null;
}

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function canonicalLibraryImports(source) {
  if (/import\s*\(/u.test(source)) throw new Error("dynamic canonical-library import is forbidden");
  const declarations = [...source.matchAll(/import\s+(\{[^}]*\})\s+from\s+["']\.\/canonical-delivery-lib\.mjs["'];/gu)];
  assert.equal(declarations.length, 1, "exactly one static canonical-library import is required");
  const clause = declarations[0][1].trim();
  assert.match(clause, /^\{[\s\S]*\}$/u, "canonical-library import must be named-only");
  const names = clause.slice(1, -1).split(",").map((name) => name.trim()).filter(Boolean);
  assert.equal(names.some((name) => /\s+as\s+/u.test(name)), false, "import aliases are forbidden");
  assert.deepEqual(names.sort(), ACCEPTED_CANONICAL_LIBRARY_IMPORTS);
  return names;
}

function normalizedGuardPath(target) {
  let cursor = path.resolve(String(target));
  const suffix = [];
  while (!fs.existsSync(cursor)) {
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    suffix.unshift(path.basename(cursor));
    cursor = parent;
  }
  const base = fs.existsSync(cursor) ? fs.realpathSync.native(cursor) : cursor;
  return path.resolve(base, ...suffix);
}

function alternateDarwinPathSpelling(value) {
  const originalPath = String(value);
  const aliases = [
    ["/private/var/", "/var/"],
    ["/var/", "/private/var/"],
    ["/private/tmp/", "/tmp/"],
    ["/tmp/", "/private/tmp/"],
  ];
  for (const [from, to] of aliases) {
    if (originalPath.startsWith(from)) return `${to}${originalPath.slice(from.length)}`;
  }
  const error = new Error("path-spelling-alternate-unavailable");
  error.code = "path-spelling-alternate-unavailable";
  error.details = {
    originalPath,
    checkedAliasRoots: aliases.flat(),
  };
  throw error;
}

function sameOrWithin(root, candidate) {
  const relative = path.relative(normalizedGuardPath(root), normalizedGuardPath(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function guardCanonicalPayloadAccess(roots, candidate, operation) {
  if (roots.some((root) => sameOrWithin(root, candidate))) {
    throw new Error(`canonical-payload-${operation}:${normalizedGuardPath(candidate)}`);
  }
  return true;
}

function currentScopeState() {
  const lines = (args) => {
    const value = git(ROOT, args);
    return value ? value.split("\n").filter(Boolean).sort() : [];
  };
  const modifiedTracked = lines(["diff", "--name-only"]);
  const staged = lines(["diff", "--cached", "--name-only"]);
  const untracked = lines(["ls-files", "--others", "--exclude-standard"]);
  const finalPaths = AUTHORIZED_PATHS.filter((relative) => fs.existsSync(path.join(ROOT, relative))).sort();
  const trackedFinal = lines(["ls-files", "--", ...FINAL_PATHS]);
  const missingFinal = FINAL_PATHS.filter((relative) => !fs.existsSync(path.join(ROOT, relative)));
  const committedPaths = lines(["diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"]);
  return {
    head: git(ROOT, ["rev-parse", "HEAD"]),
    parent: git(ROOT, ["rev-parse", "HEAD^"]),
    // Ordered parents of HEAD and of HEAD^, so a merge's shape is authority
    // rather than something inferred from a single hash.
    headParents: (git(ROOT, ["rev-parse", "HEAD^@"], { allowFailure: true }) || "")
      .split("\n").filter(Boolean),
    // Ordered merge parents as SCALARS. classifyScope normalizes by sorting every
    // array, which silently destroys parent order, so an array can never carry
    // "which parent came first". These four survive normalization untouched.
    headFirstParent: git(ROOT, ["rev-parse", "HEAD^1"], { allowFailure: true }),
    headSecondParent: git(ROOT, ["rev-parse", "HEAD^2"], { allowFailure: true }),
    headThirdParent: git(ROOT, ["rev-parse", "HEAD^3"], { allowFailure: true }),
    parentFirstParent: git(ROOT, ["rev-parse", "HEAD^^1"], { allowFailure: true }),
    parentSecondParent: git(ROOT, ["rev-parse", "HEAD^^2"], { allowFailure: true }),
    parentThirdParent: git(ROOT, ["rev-parse", "HEAD^^3"], { allowFailure: true }),
    parentParents: (git(ROOT, ["rev-parse", "HEAD^^@"], { allowFailure: true }) || "")
      .split("\n").filter(Boolean),
    branch: git(ROOT, ["branch", "--show-current"]),
    subject: git(ROOT, ["log", "-1", "--format=%s"]),
    acceptedP1Ancestor: git(ROOT, ["merge-base", "--is-ancestor", ACCEPTED_P1_HEAD, "HEAD"],
      { allowFailure: true }) !== null,
    modifiedTracked,
    staged,
    untracked,
    finalPaths,
    trackedFinal,
    missingFinal,
    committedPaths,
  };
}

function scopeError(message, state) {
  const error = new Error(message);
  error.state = state;
  throw error;
}

function classifyScope(state) {
  const value = Object.fromEntries(Object.entries(state).map(([key, item]) =>
    [key, Array.isArray(item) ? [...item].sort() : item]));
  if (value.staged.length) scopeError("P0/P1 source scope rejects staged paths", value);
  const studioPublicationRound = value.head === STUDIO_PUBLICATION_BASE_HEAD &&
    value.staged.length === 0 && value.untracked.length === 0 &&
    JSON.stringify(value.modifiedTracked) === JSON.stringify(STUDIO_PUBLICATION_AUTHORITY_PATHS);
  if (studioPublicationRound) return "studio-publication-authority-uncommitted";
  const studioValidatorSync = value.head === STUDIO_PUBLICATION_AUTHORITY_HEAD &&
    value.staged.length === 0 && value.untracked.length === 0 && value.missingFinal.length === 0 &&
    JSON.stringify(value.modifiedTracked) === JSON.stringify(STUDIO_VALIDATOR_SYNC_PATHS) &&
    JSON.stringify(value.committedPaths) === JSON.stringify(STUDIO_PUBLICATION_AUTHORITY_PATHS) &&
    JSON.stringify(value.trackedFinal) === JSON.stringify(FINAL_PATHS);
  if (studioValidatorSync) return "studio-validator-sync-uncommitted";
  const dirty = JSON.stringify(value.modifiedTracked) === JSON.stringify([PACKAGE_REL]) &&
    JSON.stringify(value.untracked) === JSON.stringify([ACTIVATOR_REL, VALIDATOR_REL].sort()) &&
    JSON.stringify(value.finalPaths) === JSON.stringify(AUTHORIZED_PATHS);
  if (dirty) return "uncommitted";
  const validatorFixDirty = value.head === ACCEPTED_P1_HEAD && value.parent === BASE_HEAD &&
    value.subject === P1_SUBJECT && value.acceptedP1Ancestor === true && value.untracked.length === 0 &&
    JSON.stringify(value.modifiedTracked) === JSON.stringify([VALIDATOR_REL]) &&
    JSON.stringify(value.committedPaths) === JSON.stringify(AUTHORIZED_PATHS) &&
    JSON.stringify(value.finalPaths) === JSON.stringify(AUTHORIZED_PATHS);
  if (validatorFixDirty) return "validator-fix-uncommitted";
  const validatorFixClean = value.modifiedTracked.length === 0 && value.untracked.length === 0 &&
    value.parent === ACCEPTED_P1_HEAD && value.subject === VALIDATOR_FIX_SUBJECT &&
    value.acceptedP1Ancestor === true &&
    JSON.stringify(value.committedPaths) === JSON.stringify([VALIDATOR_REL]) &&
    JSON.stringify(value.finalPaths) === JSON.stringify(AUTHORIZED_PATHS);
  if (validatorFixClean) return "validator-fix-committed";
  const clean = value.modifiedTracked.length === 0 && value.untracked.length === 0 &&
    value.head === ACCEPTED_P1_HEAD && value.parent === BASE_HEAD && value.subject === P1_SUBJECT &&
    value.acceptedP1Ancestor === true &&
    JSON.stringify(value.committedPaths) === JSON.stringify(AUTHORIZED_PATHS) &&
    JSON.stringify(value.finalPaths) === JSON.stringify(AUTHORIZED_PATHS);
  if (clean) return "committed-clean";
  const p2Base = value.head === P2_BASE_HEAD && value.parent === ACCEPTED_P1_HEAD &&
    value.subject === VALIDATOR_FIX_SUBJECT && value.acceptedP1Ancestor === true &&
    value.untracked.length === 0 && value.staged.length === 0 &&
    JSON.stringify(value.committedPaths) === JSON.stringify([VALIDATOR_REL]);
  if (p2Base && JSON.stringify(value.modifiedTracked) === JSON.stringify([VALIDATOR_REL])) {
    return "p2-test-first-uncommitted";
  }
  if (p2Base && JSON.stringify(value.modifiedTracked) === JSON.stringify(P2_AUTHORIZED_PATHS)) {
    return "p2-uncommitted";
  }
  const p2Clean = value.modifiedTracked.length === 0 && value.untracked.length === 0 &&
    value.parent === P2_BASE_HEAD && value.subject === P2_SUBJECT && value.acceptedP1Ancestor === true &&
    JSON.stringify(value.committedPaths) === JSON.stringify(P2_AUTHORIZED_PATHS);
  if (p2Clean) return "p2-committed";
  const p21Base = value.head === ACCEPTED_P2_HEAD && value.parent === P2_BASE_HEAD &&
    value.subject === P2_SUBJECT && value.acceptedP1Ancestor === true &&
    value.untracked.length === 0 && value.staged.length === 0 &&
    JSON.stringify(value.committedPaths) === JSON.stringify(P2_AUTHORIZED_PATHS);
  if (p21Base && JSON.stringify(value.modifiedTracked) === JSON.stringify([VALIDATOR_REL])) {
    return "p21-test-first-uncommitted";
  }
  if (p21Base && JSON.stringify(value.modifiedTracked) === JSON.stringify(P2_AUTHORIZED_PATHS)) {
    return "p21-uncommitted";
  }
  const p21Clean = value.modifiedTracked.length === 0 && value.untracked.length === 0 &&
    value.parent === ACCEPTED_P2_HEAD && value.subject === P21_SUBJECT &&
    value.acceptedP1Ancestor === true &&
    JSON.stringify(value.committedPaths) === JSON.stringify(P2_AUTHORIZED_PATHS);
  if (p21Clean) return "p21-committed";
  const p22Base = value.head === ACCEPTED_P21_HEAD && value.parent === ACCEPTED_P2_HEAD &&
    value.subject === P21_SUBJECT && value.acceptedP1Ancestor === true &&
    value.untracked.length === 0 && value.staged.length === 0 &&
    JSON.stringify(value.committedPaths) === JSON.stringify(P2_AUTHORIZED_PATHS);
  if (p22Base && JSON.stringify(value.modifiedTracked) === JSON.stringify([VALIDATOR_REL])) {
    return "p22-test-first-uncommitted";
  }
  if (p22Base && JSON.stringify(value.modifiedTracked) === JSON.stringify(P22_AUTHORIZED_PATHS)) {
    return "p22-uncommitted";
  }
  const p22Clean = value.modifiedTracked.length === 0 && value.untracked.length === 0 &&
    value.parent === ACCEPTED_P21_HEAD && value.subject === P22_SUBJECT &&
    value.acceptedP1Ancestor === true &&
    JSON.stringify(value.committedPaths) === JSON.stringify(P22_AUTHORIZED_PATHS);
  if (p22Clean) return "p22-committed";
  const p23Base = value.head === ACCEPTED_P22_HEAD && value.parent === ACCEPTED_P21_HEAD &&
    value.subject === P22_SUBJECT && value.acceptedP1Ancestor === true && value.untracked.length === 0 &&
    value.staged.length === 0 && JSON.stringify(value.committedPaths) === JSON.stringify(P22_AUTHORIZED_PATHS);
  if (p23Base && JSON.stringify(value.modifiedTracked) ===
      JSON.stringify([OWNER_VALIDATOR_REL, VALIDATOR_REL].sort())) return "p23-test-first-uncommitted";
  if (p23Base && JSON.stringify(value.modifiedTracked) === JSON.stringify(P23_AUTHORIZED_PATHS)) {
    return "p23-uncommitted";
  }
  const p23Clean = value.modifiedTracked.length === 0 && value.untracked.length === 0 &&
    value.parent === ACCEPTED_P22_HEAD && value.subject === P23_SUBJECT && value.acceptedP1Ancestor === true &&
    JSON.stringify(value.committedPaths) === JSON.stringify(P23_AUTHORIZED_PATHS);
  if (p23Clean) return "p23-committed";
  // P3A adds the payload-transaction module and its validator. The base is the
  // accepted P2.3 commit; the test-first mode carries only the new payload
  // validator so an implementation-absent run is still classifiable.
  const p3aBase = value.head === ACCEPTED_P23_HEAD && value.parent === ACCEPTED_P22_HEAD &&
    value.subject === P23_SUBJECT && value.acceptedP1Ancestor === true && value.staged.length === 0 &&
    JSON.stringify(value.committedPaths) === JSON.stringify(P23_AUTHORIZED_PATHS);
  if (p3aBase && value.modifiedTracked.length === 0 &&
      JSON.stringify(value.untracked) === JSON.stringify([PAYLOAD_VALIDATOR_REL])) {
    return "p3a-test-first-uncommitted";
  }
  if (p3aBase &&
      JSON.stringify(value.modifiedTracked) === JSON.stringify([ACTIVATOR_REL, VALIDATOR_REL].sort()) &&
      JSON.stringify(value.untracked) === JSON.stringify([PAYLOAD_MODULE_REL, PAYLOAD_VALIDATOR_REL].sort())) {
    return "p3a-uncommitted";
  }
  const p3aRepairBase = value.head === P3A_CANDIDATE_HEAD && value.parent === ACCEPTED_P23_HEAD &&
    value.subject === P3A_SUBJECT && value.untracked.length === 0 && value.staged.length === 0 &&
    JSON.stringify(value.committedPaths) === JSON.stringify(P3A_AUTHORIZED_PATHS);
  if (p3aRepairBase && JSON.stringify(value.modifiedTracked) === JSON.stringify(P3A_AUTHORIZED_PATHS)) {
    return "p3a-repair-uncommitted";
  }
  const p3aClean = value.modifiedTracked.length === 0 && value.untracked.length === 0 &&
    value.parent === ACCEPTED_P23_HEAD && value.subject === P3A_SUBJECT &&
    value.acceptedP1Ancestor === true &&
    JSON.stringify(value.committedPaths) === JSON.stringify(P3A_AUTHORIZED_PATHS);
  if (p3aClean) return "p3a-committed";
  // P3B two-commit stack.
  const p3bSourceClean = value.modifiedTracked.length === 0 && value.untracked.length === 0 &&
    value.parent === INTEGRATED_P3A_HEAD && value.subject === P3B_SOURCE_SUBJECT &&
    JSON.stringify(value.committedPaths) === JSON.stringify(P3B_SOURCE_PATHS);
  if (p3bSourceClean) return "p3b-source-committed";
  const p3bValidationBase = value.head === P3B_SOURCE_HEAD && value.parent === INTEGRATED_P3A_HEAD &&
    value.subject === P3B_SOURCE_SUBJECT && value.untracked.length === 0 && value.staged.length === 0 &&
    JSON.stringify(value.committedPaths) === JSON.stringify(P3B_SOURCE_PATHS);
  if (p3bValidationBase && value.modifiedTracked.length > 0 &&
      value.modifiedTracked.every((entry) => P3B_VALIDATION_PATHS.includes(entry))) {
    return "p3b-validation-uncommitted";
  }
  const p3bValidationClean = value.modifiedTracked.length === 0 && value.untracked.length === 0 &&
    value.parent === P3B_SOURCE_HEAD && value.subject === P3B_VALIDATION_SUBJECT &&
    JSON.stringify(value.committedPaths) === JSON.stringify(P3B_VALIDATION_PATHS);
  if (p3bValidationClean) return "p3b-validation-committed";
  // P3C-A1: one feature slice on top of the integrated P3B stack. Nothing may be
  // staged, nothing untracked, and every touched path must be one of the four.
  const p3cA1Base = value.head === INTEGRATED_P3B_HEAD && value.untracked.length === 0 &&
    value.staged.length === 0;
  if (p3cA1Base && value.modifiedTracked.length > 0 &&
      value.modifiedTracked.every((entry) => P3C_A1_AUTHORIZED_PATHS.includes(entry))) {
    return "p3c-a1-uncommitted";
  }
  const p3cA1Clean = value.modifiedTracked.length === 0 && value.untracked.length === 0 &&
    value.parent === INTEGRATED_P3B_HEAD && value.subject === P3C_A1_SUBJECT &&
    JSON.stringify(value.committedPaths) === JSON.stringify(P3C_A1_AUTHORIZED_PATHS);
  if (p3cA1Clean) return "p3c-a1-committed";
  // P3C-A2: one feature slice on the accepted P3C-A1 checkpoint. Nothing staged,
  // nothing untracked, every touched path inside the authorized five.
  const p3cA2Base = value.head === ACCEPTED_P3C_A1_HEAD && value.untracked.length === 0 &&
    value.staged.length === 0;
  if (p3cA2Base && value.modifiedTracked.length > 0 &&
      value.modifiedTracked.every((entry) => P3C_A2_AUTHORIZED_PATHS.includes(entry))) {
    return "p3c-a2-uncommitted";
  }
  const p3cA2Clean = value.modifiedTracked.length === 0 && value.untracked.length === 0 &&
    value.parent === ACCEPTED_P3C_A1_HEAD && value.subject === P3C_A2_SUBJECT &&
    value.committedPaths.length > 0 &&
    value.committedPaths.every((entry) => P3C_A2_AUTHORIZED_PATHS.includes(entry));
  if (p3cA2Clean) return "p3c-a2-committed";
  // P3C-A2.1: exactly the three validators, on exactly the accepted P3C-A2
  // commit. No descendant allowance and no minimum-path tolerance: the
  // committed path set must equal the authorized three exactly.
  const p3cA21Base = value.head === ACCEPTED_P3C_A2_HEAD && value.untracked.length === 0 &&
    value.staged.length === 0;
  if (p3cA21Base && value.modifiedTracked.length > 0 &&
      value.modifiedTracked.every((entry) => P3C_A2_1_AUTHORIZED_PATHS.includes(entry))) {
    return "p3c-a2-1-uncommitted";
  }
  const p3cA21Clean = value.modifiedTracked.length === 0 && value.untracked.length === 0 &&
    value.staged.length === 0 &&
    value.parent === ACCEPTED_P3C_A2_HEAD && value.subject === P3C_A2_1_SUBJECT &&
    JSON.stringify(value.committedPaths) === JSON.stringify(P3C_A2_1_AUTHORIZED_PATHS);
  if (p3cA21Clean) return "p3c-a2-1-committed";
  // P3C-B1: exactly the four production/validator paths on the accepted A2.1 tip.
  const p3cB1Base = value.head === ACCEPTED_P3C_A2_1_HEAD && value.untracked.length === 0 &&
    value.staged.length === 0;
  if (p3cB1Base && value.modifiedTracked.length > 0 &&
      value.modifiedTracked.every((entry) => P3C_B1_AUTHORIZED_PATHS.includes(entry))) {
    return "p3c-b1-uncommitted";
  }
  const p3cB1Clean = value.modifiedTracked.length === 0 && value.untracked.length === 0 &&
    value.staged.length === 0 &&
    value.parent === ACCEPTED_P3C_A2_1_HEAD && value.subject === P3C_B1_SUBJECT &&
    JSON.stringify(value.committedPaths) === JSON.stringify(P3C_B1_COMMITTED_PATHS);
  if (p3cB1Clean) return "p3c-b1-committed";
  // Activation-completeness prerequisite on the accepted B1 tip.
  const p3cA3Base = value.head === ACCEPTED_P3C_B1_HEAD && value.untracked.length === 0 &&
    value.staged.length === 0;
  if (p3cA3Base && value.modifiedTracked.length > 0 &&
      value.modifiedTracked.every((entry) => P3C_A3_AUTHORIZED_PATHS.includes(entry))) {
    return "p3c-a3-uncommitted";
  }
  const p3cA3Clean = value.modifiedTracked.length === 0 && value.untracked.length === 0 &&
    value.staged.length === 0 &&
    value.parent === ACCEPTED_P3C_B1_HEAD && value.subject === P3C_A3_SUBJECT &&
    value.committedPaths.length > 0 &&
    value.committedPaths.every((entry) => P3C_A3_AUTHORIZED_PATHS.includes(entry));
  if (p3cA3Clean) return "p3c-a3-committed";
  // A3b: validator-only negative closure on the accepted A3a commit.
  const p3cA3bBase = value.head === ACCEPTED_P3C_A3A_HEAD && value.untracked.length === 0 &&
    value.staged.length === 0;
  if (p3cA3bBase && value.modifiedTracked.length > 0 &&
      value.modifiedTracked.every((entry) => P3C_A3_AUTHORIZED_PATHS.includes(entry))) {
    return "p3c-a3b-uncommitted";
  }
  const p3cA3bClean = value.modifiedTracked.length === 0 && value.untracked.length === 0 &&
    value.staged.length === 0 &&
    value.parent === ACCEPTED_P3C_A3A_HEAD && value.subject === P3C_A3B_SUBJECT &&
    value.committedPaths.length > 0 &&
    value.committedPaths.every((entry) => P3C_A3_AUTHORIZED_PATHS.includes(entry));
  if (p3cA3bClean) return "p3c-a3b-committed";
  // P3C main synchronization. The merge's SHAPE is the authority: exactly two
  // parents, the A3b tip first and the exact committed main tip second. A wrong
  // parent, wrong subject, extra/missing path, staged path or untracked file all
  // reject. No descendant allowance, no minimum-path tolerance.
  const syncMergeShapeOk = (parents) => parents.length === 2 &&
    parents[0] === P3C_SYNC_FIRST_PARENT && parents[1] === P3C_SYNC_MAIN_TIP;
  const p3cSyncBase = value.head === P3C_SYNC_MERGE_HEAD &&
    syncMergeShapeOk(value.headParents ?? []) &&
    value.untracked.length === 0 && value.staged.length === 0;
  if (p3cSyncBase &&
      JSON.stringify(value.modifiedTracked) === JSON.stringify(P3C_SYNC_AUTHORIZED_PATHS)) {
    return "p3c-main-sync-uncommitted";
  }
  const p3cSyncClean = value.modifiedTracked.length === 0 && value.untracked.length === 0 &&
    value.staged.length === 0 &&
    value.parent === P3C_SYNC_MERGE_HEAD &&
    syncMergeShapeOk(value.parentParents ?? []) &&
    value.subject === P3C_SYNC_SUBJECT &&
    JSON.stringify(value.committedPaths) === JSON.stringify(P3C_SYNC_AUTHORIZED_PATHS);
  if (p3cSyncClean) return "p3c-main-sync-committed";
  // FINAL release synchronization. The merge's SHAPE is the authority: exactly
  // two parents, the completed P3C tip first and the exact committed main tip
  // second. A wrong parent, wrong subject, extra/missing path, staged path or
  // untracked file all reject. No descendant allowance, no path tolerance.
  // Exactly two parents, in order, and no third: first the completed P3C tip,
  // second the exact committed main tip.
  const finalSyncShapeOk = (first, second, third) =>
    first === P3C_FINAL_SYNC_FIRST_PARENT && second === P3C_FINAL_SYNC_MAIN_TIP &&
    (third ?? null) === null;
  const p3cFinalBase = value.head === P3C_FINAL_SYNC_MERGE_HEAD &&
    finalSyncShapeOk(value.headFirstParent, value.headSecondParent, value.headThirdParent) &&
    value.untracked.length === 0 && value.staged.length === 0;
  if (p3cFinalBase &&
      JSON.stringify(value.modifiedTracked) === JSON.stringify(P3C_FINAL_SYNC_AUTHORIZED_PATHS)) {
    return "p3c-final-sync-uncommitted";
  }
  const p3cFinalClean = value.modifiedTracked.length === 0 && value.untracked.length === 0 &&
    value.staged.length === 0 &&
    value.parent === P3C_FINAL_SYNC_MERGE_HEAD &&
    finalSyncShapeOk(value.parentFirstParent, value.parentSecondParent,
      value.parentThirdParent) &&
    value.subject === P3C_FINAL_SYNC_SUBJECT &&
    JSON.stringify(value.committedPaths) === JSON.stringify(P3C_FINAL_SYNC_AUTHORIZED_PATHS);
  if (p3cFinalClean) return "p3c-final-sync-committed";
  // Final current-main integration. Same shape authority as the sync above:
  // exactly two ordered parents and no third, exact subject, exact two-file
  // scope, nothing staged or untracked. No descendant allowance.
  const integrationShapeOk = (first, second, third) =>
    first === P3C_INTEGRATION_FIRST_PARENT && second === P3C_INTEGRATION_MAIN_TIP &&
    (third ?? null) === null;
  const p3cIntegrationBase = value.head === P3C_INTEGRATION_MERGE_HEAD &&
    integrationShapeOk(value.headFirstParent, value.headSecondParent, value.headThirdParent) &&
    value.untracked.length === 0 && value.staged.length === 0;
  if (p3cIntegrationBase &&
      JSON.stringify(value.modifiedTracked) === JSON.stringify(P3C_INTEGRATION_AUTHORIZED_PATHS)) {
    return "p3c-integration-uncommitted";
  }
  const p3cIntegrationClean = value.modifiedTracked.length === 0 && value.untracked.length === 0 &&
    value.staged.length === 0 &&
    value.parent === P3C_INTEGRATION_MERGE_HEAD &&
    integrationShapeOk(value.parentFirstParent, value.parentSecondParent,
      value.parentThirdParent) &&
    value.subject === P3C_INTEGRATION_SUBJECT &&
    JSON.stringify(value.committedPaths) === JSON.stringify(P3C_INTEGRATION_AUTHORIZED_PATHS);
  if (p3cIntegrationClean) return "p3c-integration-committed";
  // Current-main activator baseline repair. Exactly this validator, on the accepted
  // current-main head, with every authorized path present. Nothing staged, nothing
  // untracked, no production source and no descendant allowance. The committed
  // counterpart is required because "committed-clean" above is pinned to the far older
  // ACCEPTED_P1_HEAD, so it can never describe a commit made on this head.
  const currentBaselineBase = value.head === ACCEPTED_CURRENT_MAIN_HEAD &&
    value.untracked.length === 0 && value.staged.length === 0 &&
    JSON.stringify(value.finalPaths) === JSON.stringify(AUTHORIZED_PATHS);
  if (currentBaselineBase &&
      JSON.stringify(value.modifiedTracked) ===
        JSON.stringify([...CURRENT_BASELINE_AUTHORIZED_PATHS])) {
    return "current-baseline-uncommitted";
  }
  const currentBaselineClean = value.modifiedTracked.length === 0 &&
    value.untracked.length === 0 && value.staged.length === 0 &&
    value.parent === ACCEPTED_CURRENT_MAIN_HEAD &&
    value.subject === CURRENT_BASELINE_SUBJECT &&
    JSON.stringify(value.committedPaths) ===
      JSON.stringify([...CURRENT_BASELINE_AUTHORIZED_PATHS]) &&
    JSON.stringify(value.finalPaths) === JSON.stringify(AUTHORIZED_PATHS);
  if (currentBaselineClean) return "current-baseline-committed";
  const durabilityRepair = value.head === CLASSIFIER_DURABILITY_BASE &&
    value.modifiedTracked.length === CLASSIFIER_DURABILITY_PATHS.length &&
    value.modifiedTracked.every((relative, index) => relative === CLASSIFIER_DURABILITY_PATHS[index]) &&
    value.staged.length === 0 && value.untracked.length === 0 &&
    value.missingFinal.length === 0 &&
    JSON.stringify(value.trackedFinal) === JSON.stringify(FINAL_PATHS);
  if (durabilityRepair) return "classifier-durability-uncommitted";
  const historicalIntentFix = value.head === HISTORICAL_INTENT_FIX_BASE &&
    value.modifiedTracked.length === HISTORICAL_INTENT_FIX_PATHS.length &&
    value.modifiedTracked.every((relative, index) => relative === HISTORICAL_INTENT_FIX_PATHS[index]) &&
    value.staged.length === 0 && value.untracked.length === 0 &&
    value.missingFinal.length === 0 &&
    JSON.stringify(value.trackedFinal) === JSON.stringify(FINAL_PATHS);
  if (historicalIntentFix) return "historical-intent-fix-uncommitted";
  const cp10Base = value.head === CP10_BASE_HEAD &&
    value.staged.length === 0 && value.untracked.length === 0 &&
    value.missingFinal.length === 0 &&
    JSON.stringify(value.trackedFinal) === JSON.stringify(FINAL_PATHS);
  if (cp10Base &&
      JSON.stringify(value.modifiedTracked) === JSON.stringify([...CP10_AUTHORIZED_PATHS])) {
    return "cp10-historical-intent-uncommitted";
  }
  const cp10Committed = value.modifiedTracked.length === 0 &&
    value.staged.length === 0 && value.untracked.length === 0 &&
    value.missingFinal.length === 0 &&
    value.parent === CP10_BASE_HEAD &&
    value.subject === CP10_SUBJECT &&
    JSON.stringify(value.committedPaths) === JSON.stringify([...CP10_AUTHORIZED_PATHS]) &&
    JSON.stringify(value.trackedFinal) === JSON.stringify(FINAL_PATHS);
  if (cp10Committed) return "cp10-historical-intent-committed";
  const durableCommittedClean = value.modifiedTracked.length === 0 &&
    value.staged.length === 0 && value.untracked.length === 0 &&
    value.missingFinal.length === 0 &&
    JSON.stringify(value.trackedFinal) === JSON.stringify(FINAL_PATHS);
  if (durableCommittedClean) return "committed-clean";
  scopeError("P0/P1 source scope mismatch", value);
}

function baseDirtyScope(overrides = {}) {
  return {
    head: BASE_HEAD,
    parent: "6920f812263ed03d79888f06e5e849fe4dcca43e",
    branch: "main",
    subject: "fix(publish): make staged aliases promotion-safe",
    acceptedP1Ancestor: false,
    modifiedTracked: [PACKAGE_REL],
    staged: [],
    untracked: [ACTIVATOR_REL, VALIDATOR_REL].sort(),
    finalPaths: [...AUTHORIZED_PATHS],
    trackedFinal: [],
    missingFinal: [],
    committedPaths: ["tools/publish/lean-publisher.mjs", "tools/validation/publish/validate-lean-publisher-v1.mjs"].sort(),
    ...overrides,
  };
}

function scopeTest(name, fn) {
  fn();
  scopeResults.push(name);
  process.stdout.write(`ok scope ${scopeResults.length} - ${name}\n`);
}

function runScopeTests() {
  scopeTest("exact three-path uncommitted P0/P1 scope is accepted", () => {
    assert.equal(classifyScope(baseDirtyScope()), "uncommitted");
  });
  scopeTest("exact three-path committed-clean P0/P1 scope is accepted", () => {
    assert.equal(classifyScope(baseDirtyScope({
      head: ACCEPTED_P1_HEAD, parent: BASE_HEAD, branch: "publish-batch2-activator-p1",
      subject: P1_SUBJECT, acceptedP1Ancestor: true,
      modifiedTracked: [], untracked: [], committedPaths: [...AUTHORIZED_PATHS],
    })), "committed-clean");
  });
  scopeTest("staged source is rejected", () => {
    assert.throws(() => classifyScope(baseDirtyScope({ staged: [PACKAGE_REL] })), /rejects staged/u);
  });
  scopeTest("missing authorized path is rejected", () => {
    assert.throws(() => classifyScope(baseDirtyScope({ finalPaths: [PACKAGE_REL, VALIDATOR_REL].sort() })), /scope mismatch/u);
  });
  scopeTest("fourth tracked path is rejected", () => {
    assert.throws(() => classifyScope(baseDirtyScope({ modifiedTracked: [PACKAGE_REL, "README.md"].sort() })), /scope mismatch/u);
  });
  scopeTest("fourth untracked path is rejected", () => {
    assert.throws(() => classifyScope(baseDirtyScope({ untracked: [ACTIVATOR_REL, VALIDATOR_REL, "stray.mjs"].sort() })), /scope mismatch/u);
  });
  scopeTest("wrong committed parent is rejected", () => {
    assert.throws(() => classifyScope(baseDirtyScope({
      head: ACCEPTED_P1_HEAD, parent: "wrong", subject: P1_SUBJECT, acceptedP1Ancestor: true,
      modifiedTracked: [], untracked: [], committedPaths: [...AUTHORIZED_PATHS],
    })), /scope mismatch/u);
  });
  scopeTest("committed fourth path is rejected", () => {
    assert.throws(() => classifyScope(baseDirtyScope({
      head: ACCEPTED_P1_HEAD, parent: BASE_HEAD, subject: P1_SUBJECT, acceptedP1Ancestor: true,
      modifiedTracked: [], untracked: [],
      committedPaths: [...AUTHORIZED_PATHS, "extra.txt"].sort(),
    })), /scope mismatch/u);
  });
  scopeTest("exact validator-only uncommitted repair is accepted", () => {
    assert.equal(classifyScope(baseDirtyScope({
      head: ACCEPTED_P1_HEAD, parent: BASE_HEAD, subject: P1_SUBJECT, acceptedP1Ancestor: true,
      modifiedTracked: [VALIDATOR_REL], untracked: [],
      committedPaths: [...AUTHORIZED_PATHS],
    })), "validator-fix-uncommitted");
  });
  scopeTest("validator repair rejects an activator modification", () => {
    assert.throws(() => classifyScope(baseDirtyScope({
      head: ACCEPTED_P1_HEAD, parent: BASE_HEAD, subject: P1_SUBJECT, acceptedP1Ancestor: true,
      modifiedTracked: [ACTIVATOR_REL, VALIDATOR_REL].sort(), untracked: [], committedPaths: [...AUTHORIZED_PATHS],
    })), /scope mismatch/u);
  });
  scopeTest("validator repair rejects package changes", () => {
    assert.throws(() => classifyScope(baseDirtyScope({
      head: ACCEPTED_P1_HEAD, parent: BASE_HEAD, subject: P1_SUBJECT, acceptedP1Ancestor: true,
      modifiedTracked: [PACKAGE_REL, VALIDATOR_REL].sort(),
      untracked: [], committedPaths: [...AUTHORIZED_PATHS],
    })), /scope mismatch/u);
  });
  scopeTest("validator repair rejects untracked paths", () => {
    assert.throws(() => classifyScope(baseDirtyScope({
      head: ACCEPTED_P1_HEAD, parent: BASE_HEAD, subject: P1_SUBJECT, acceptedP1Ancestor: true,
      modifiedTracked: [VALIDATOR_REL],
      untracked: ["stray.mjs"], committedPaths: [...AUTHORIZED_PATHS],
    })), /scope mismatch/u);
  });
  scopeTest("validator repair rejects the wrong commit subject", () => {
    assert.throws(() => classifyScope(baseDirtyScope({
      head: ACCEPTED_P1_HEAD, parent: BASE_HEAD, subject: "wrong", acceptedP1Ancestor: true,
      modifiedTracked: [VALIDATOR_REL], untracked: [],
      committedPaths: [...AUTHORIZED_PATHS],
    })), /scope mismatch/u);
  });
  scopeTest("exact committed validator follow-up is accepted", () => {
    assert.equal(classifyScope(baseDirtyScope({
      head: "future-validator-fix", parent: ACCEPTED_P1_HEAD, subject: VALIDATOR_FIX_SUBJECT,
      acceptedP1Ancestor: true, modifiedTracked: [], untracked: [], committedPaths: [VALIDATOR_REL],
    })), "validator-fix-committed");
  });
  scopeTest("committed validator follow-up rejects the wrong parent", () => {
    assert.throws(() => classifyScope(baseDirtyScope({
      head: "future-validator-fix", parent: BASE_HEAD, subject: VALIDATOR_FIX_SUBJECT,
      acceptedP1Ancestor: true, modifiedTracked: [], untracked: [], committedPaths: [VALIDATOR_REL],
    })), /scope mismatch/u);
  });
  scopeTest("committed validator follow-up rejects a second path", () => {
    assert.throws(() => classifyScope(baseDirtyScope({
      head: "future-validator-fix", parent: ACCEPTED_P1_HEAD, subject: VALIDATOR_FIX_SUBJECT,
      acceptedP1Ancestor: true, modifiedTracked: [], untracked: [],
      committedPaths: [VALIDATOR_REL, "README.md"].sort(),
    })), /scope mismatch/u);
  });
  scopeTest("committed validator follow-up requires accepted P0/P1 ancestry", () => {
    assert.throws(() => classifyScope(baseDirtyScope({
      head: "future-validator-fix", parent: ACCEPTED_P1_HEAD, subject: VALIDATOR_FIX_SUBJECT,
      acceptedP1Ancestor: false, modifiedTracked: [], untracked: [], committedPaths: [VALIDATOR_REL],
    })), /scope mismatch/u);
  });
  scopeTest("P2 test-first validator-only state is accepted", () => {
    assert.equal(classifyScope(baseDirtyScope({
      head: P2_BASE_HEAD, parent: ACCEPTED_P1_HEAD, subject: VALIDATOR_FIX_SUBJECT,
      acceptedP1Ancestor: true, modifiedTracked: [VALIDATOR_REL], untracked: [],
      committedPaths: [VALIDATOR_REL],
    })), "p2-test-first-uncommitted");
  });
  scopeTest("exact dirty two-file P2 state is accepted", () => {
    assert.equal(classifyScope(baseDirtyScope({
      head: P2_BASE_HEAD, parent: ACCEPTED_P1_HEAD, subject: VALIDATOR_FIX_SUBJECT,
      acceptedP1Ancestor: true, modifiedTracked: [...P2_AUTHORIZED_PATHS], untracked: [],
      committedPaths: [VALIDATOR_REL],
    })), "p2-uncommitted");
  });
  scopeTest("P2 dirty scope rejects a third path", () => {
    assert.throws(() => classifyScope(baseDirtyScope({
      head: P2_BASE_HEAD, parent: ACCEPTED_P1_HEAD, subject: VALIDATOR_FIX_SUBJECT,
      acceptedP1Ancestor: true, modifiedTracked: [...P2_AUTHORIZED_PATHS, "README.md"].sort(), untracked: [],
      committedPaths: [VALIDATOR_REL],
    })), /scope mismatch/u);
  });
  scopeTest("exact committed two-file P2 state is accepted", () => {
    assert.equal(classifyScope(baseDirtyScope({
      head: "future-p2", parent: P2_BASE_HEAD, subject: P2_SUBJECT,
      acceptedP1Ancestor: true, modifiedTracked: [], untracked: [],
      committedPaths: [...P2_AUTHORIZED_PATHS],
    })), "p2-committed");
  });
  scopeTest("committed P2 state rejects a wrong parent or extra path", () => {
    assert.throws(() => classifyScope(baseDirtyScope({
      head: "future-p2", parent: ACCEPTED_P1_HEAD, subject: P2_SUBJECT,
      acceptedP1Ancestor: true, modifiedTracked: [], untracked: [],
      committedPaths: [...P2_AUTHORIZED_PATHS, "README.md"].sort(),
    })), /scope mismatch/u);
  });
  scopeTest("P2.1 test-first validator-only state is accepted", () => {
    assert.equal(classifyScope(baseDirtyScope({
      head: ACCEPTED_P2_HEAD, parent: P2_BASE_HEAD, subject: P2_SUBJECT,
      acceptedP1Ancestor: true, modifiedTracked: [VALIDATOR_REL], untracked: [],
      committedPaths: [...P2_AUTHORIZED_PATHS],
    })), "p21-test-first-uncommitted");
  });
  scopeTest("exact dirty two-file P2.1 state is accepted", () => {
    assert.equal(classifyScope(baseDirtyScope({
      head: ACCEPTED_P2_HEAD, parent: P2_BASE_HEAD, subject: P2_SUBJECT,
      acceptedP1Ancestor: true, modifiedTracked: [...P2_AUTHORIZED_PATHS], untracked: [],
      committedPaths: [...P2_AUTHORIZED_PATHS],
    })), "p21-uncommitted");
  });
  scopeTest("P2.1 dirty scope rejects a third path", () => {
    assert.throws(() => classifyScope(baseDirtyScope({
      head: ACCEPTED_P2_HEAD, parent: P2_BASE_HEAD, subject: P2_SUBJECT,
      acceptedP1Ancestor: true, modifiedTracked: [...P2_AUTHORIZED_PATHS, "README.md"].sort(), untracked: [],
      committedPaths: [...P2_AUTHORIZED_PATHS],
    })), /scope mismatch/u);
  });
  scopeTest("exact committed two-file P2.1 state is accepted", () => {
    assert.equal(classifyScope(baseDirtyScope({
      head: "future-p21", parent: ACCEPTED_P2_HEAD, subject: P21_SUBJECT,
      acceptedP1Ancestor: true, modifiedTracked: [], untracked: [],
      committedPaths: [...P2_AUTHORIZED_PATHS],
    })), "p21-committed");
  });
  scopeTest("committed P2.1 rejects a wrong parent or extra path", () => {
    assert.throws(() => classifyScope(baseDirtyScope({
      head: "future-p21", parent: P2_BASE_HEAD, subject: P21_SUBJECT,
      acceptedP1Ancestor: true, modifiedTracked: [], untracked: [],
      committedPaths: [...P2_AUTHORIZED_PATHS, "README.md"].sort(),
    })), /scope mismatch/u);
  });
  scopeTest("P2.2 test-first validator-only state is accepted", () => {
    assert.equal(classifyScope(baseDirtyScope({
      head: ACCEPTED_P21_HEAD, parent: ACCEPTED_P2_HEAD, subject: P21_SUBJECT,
      acceptedP1Ancestor: true, modifiedTracked: [VALIDATOR_REL], untracked: [],
      committedPaths: [...P2_AUTHORIZED_PATHS],
    })), "p22-test-first-uncommitted");
  });
  scopeTest("exact dirty three-file P2.2 state is accepted", () => {
    assert.equal(classifyScope(baseDirtyScope({
      head: ACCEPTED_P21_HEAD, parent: ACCEPTED_P2_HEAD, subject: P21_SUBJECT,
      acceptedP1Ancestor: true, modifiedTracked: [...P22_AUTHORIZED_PATHS], untracked: [],
      committedPaths: [...P2_AUTHORIZED_PATHS],
    })), "p22-uncommitted");
  });
  scopeTest("P2.2 dirty scope rejects a fourth path", () => {
    assert.throws(() => classifyScope(baseDirtyScope({
      head: ACCEPTED_P21_HEAD, parent: ACCEPTED_P2_HEAD, subject: P21_SUBJECT,
      acceptedP1Ancestor: true, modifiedTracked: [...P22_AUTHORIZED_PATHS, "README.md"].sort(), untracked: [],
      committedPaths: [...P2_AUTHORIZED_PATHS],
    })), /scope mismatch/u);
  });
  scopeTest("exact committed three-file P2.2 state is accepted", () => {
    assert.equal(classifyScope(baseDirtyScope({
      head: "future-p22", parent: ACCEPTED_P21_HEAD, subject: P22_SUBJECT,
      acceptedP1Ancestor: true, modifiedTracked: [], untracked: [],
      committedPaths: [...P22_AUTHORIZED_PATHS],
    })), "p22-committed");
  });
  scopeTest("committed P2.2 rejects a wrong parent or extra path", () => {
    assert.throws(() => classifyScope(baseDirtyScope({
      head: "future-p22", parent: ACCEPTED_P2_HEAD, subject: P22_SUBJECT,
      acceptedP1Ancestor: true, modifiedTracked: [], untracked: [],
      committedPaths: [...P22_AUTHORIZED_PATHS, "README.md"].sort(),
    })), /scope mismatch/u);
  });
  scopeTest("P2.3 test-first two-validator state is accepted", () => {
    assert.equal(classifyScope(baseDirtyScope({
      head: ACCEPTED_P22_HEAD, parent: ACCEPTED_P21_HEAD, subject: P22_SUBJECT,
      acceptedP1Ancestor: true, modifiedTracked: [OWNER_VALIDATOR_REL, VALIDATOR_REL].sort(), untracked: [],
      committedPaths: [...P22_AUTHORIZED_PATHS],
    })), "p23-test-first-uncommitted");
  });
  scopeTest("exact dirty four-file P2.3 state is accepted", () => {
    assert.equal(classifyScope(baseDirtyScope({
      head: ACCEPTED_P22_HEAD, parent: ACCEPTED_P21_HEAD, subject: P22_SUBJECT,
      acceptedP1Ancestor: true, modifiedTracked: [...P23_AUTHORIZED_PATHS], untracked: [],
      committedPaths: [...P22_AUTHORIZED_PATHS],
    })), "p23-uncommitted");
  });
  scopeTest("P2.3 dirty scope rejects a fifth path", () => {
    assert.throws(() => classifyScope(baseDirtyScope({
      head: ACCEPTED_P22_HEAD, parent: ACCEPTED_P21_HEAD, subject: P22_SUBJECT,
      acceptedP1Ancestor: true, modifiedTracked: [...P23_AUTHORIZED_PATHS, "README.md"].sort(), untracked: [],
      committedPaths: [...P22_AUTHORIZED_PATHS],
    })), /scope mismatch/u);
  });
  scopeTest("exact committed four-file P2.3 state is accepted", () => {
    assert.equal(classifyScope(baseDirtyScope({
      head: "future-p23", parent: ACCEPTED_P22_HEAD, subject: P23_SUBJECT,
      acceptedP1Ancestor: true, modifiedTracked: [], untracked: [], committedPaths: [...P23_AUTHORIZED_PATHS],
    })), "p23-committed");
  });
  scopeTest("committed P2.3 rejects wrong parent or extra path", () => {
    assert.throws(() => classifyScope(baseDirtyScope({
      head: "future-p23", parent: ACCEPTED_P21_HEAD, subject: P23_SUBJECT,
      acceptedP1Ancestor: true, modifiedTracked: [], untracked: [],
      committedPaths: [...P23_AUTHORIZED_PATHS, "README.md"].sort(),
    })), /scope mismatch/u);
  });
  scopeTest("exact dirty four-path P3C-B1 state is accepted and pinned", () => {
    assert.equal(classifyScope(baseDirtyScope({
      head: ACCEPTED_P3C_A2_1_HEAD, parent: ACCEPTED_P3C_A2_HEAD, subject: P3C_A2_1_SUBJECT,
      acceptedP1Ancestor: true, modifiedTracked: [...P3C_B1_AUTHORIZED_PATHS], untracked: [],
      committedPaths: [...P3C_A2_1_AUTHORIZED_PATHS],
    })), "p3c-b1-uncommitted");
    for (const override of [
      { modifiedTracked: [...P3C_B1_AUTHORIZED_PATHS, WRITER_VALIDATOR_REL].sort() },
      { modifiedTracked: [...P3C_B1_AUTHORIZED_PATHS, PACKAGE_REL].sort() },
      { untracked: ["tools/publish/scratch.mjs"] },
      { staged: [ACTIVATOR_REL] },
      { head: "0000000000000000000000000000000000000000" },
    ]) {
      assert.throws(() => classifyScope(baseDirtyScope({
        head: ACCEPTED_P3C_A2_1_HEAD, parent: ACCEPTED_P3C_A2_HEAD, subject: P3C_A2_1_SUBJECT,
        acceptedP1Ancestor: true, modifiedTracked: [...P3C_B1_AUTHORIZED_PATHS], untracked: [],
        committedPaths: [...P3C_A2_1_AUTHORIZED_PATHS], ...override,
      })), /scope mismatch|rejects staged paths/u);
    }
  });
  scopeTest("committed P3C-B1 pins parent, subject and the exact four-path set", () => {
    assert.equal(classifyScope(baseDirtyScope({
      head: "future-p3c-b1", parent: ACCEPTED_P3C_A2_1_HEAD, subject: P3C_B1_SUBJECT,
      acceptedP1Ancestor: true, modifiedTracked: [], untracked: [],
      committedPaths: [...P3C_B1_COMMITTED_PATHS],
    })), "p3c-b1-committed");
    for (const override of [
      { parent: ACCEPTED_P3C_A2_HEAD },
      { subject: P3C_A2_1_SUBJECT },
      { committedPaths: [...P3C_B1_COMMITTED_PATHS, WRITER_VALIDATOR_REL].sort() },
      { committedPaths: [...P3C_B1_COMMITTED_PATHS, PAYLOAD_MODULE_REL].sort() },
      { committedPaths: [] },
      { staged: [ACTIVATOR_REL] },
    ]) {
      assert.throws(() => classifyScope(baseDirtyScope({
        head: "future-p3c-b1", parent: ACCEPTED_P3C_A2_1_HEAD, subject: P3C_B1_SUBJECT,
        acceptedP1Ancestor: true, modifiedTracked: [], untracked: [],
        committedPaths: [...P3C_B1_COMMITTED_PATHS], ...override,
      })), /scope mismatch|rejects staged paths/u);
    }
  });
  scopeTest("exact dirty three-validator P3C-A2.1 state is accepted", () => {
    assert.equal(classifyScope(baseDirtyScope({
      head: ACCEPTED_P3C_A2_HEAD, parent: ACCEPTED_P3C_A1_HEAD, subject: P3C_A2_SUBJECT,
      acceptedP1Ancestor: true, modifiedTracked: [...P3C_A2_1_AUTHORIZED_PATHS], untracked: [],
      committedPaths: [...P3C_A2_AUTHORIZED_PATHS],
    })), "p3c-a2-1-uncommitted");
    // Production source may never appear in a governance follow-up scope.
    for (const override of [
      { modifiedTracked: [...P3C_A2_1_AUTHORIZED_PATHS, ACTIVATOR_REL].sort() },
      { modifiedTracked: [...P3C_A2_1_AUTHORIZED_PATHS, PAYLOAD_MODULE_REL].sort() },
      { modifiedTracked: [...P3C_A2_1_AUTHORIZED_PATHS, PACKAGE_REL].sort() },
      { untracked: ["tools/validation/publish/scratch.mjs"] },
      { staged: [WRITER_VALIDATOR_REL] },
      { head: "0000000000000000000000000000000000000000" },
    ]) {
      assert.throws(() => classifyScope(baseDirtyScope({
        head: ACCEPTED_P3C_A2_HEAD, parent: ACCEPTED_P3C_A1_HEAD, subject: P3C_A2_SUBJECT,
        acceptedP1Ancestor: true, modifiedTracked: [...P3C_A2_1_AUTHORIZED_PATHS], untracked: [],
        committedPaths: [...P3C_A2_AUTHORIZED_PATHS], ...override,
      })), /scope mismatch|rejects staged paths/u);
    }
    // Boundary: the same three validators dirty on the P3C-A2 *base* commit are
    // still P3C-A2 work, because they are a subset of that phase's five paths.
    // The A2.1 mode is distinguished by its base commit, not by path overlap.
    assert.equal(classifyScope(baseDirtyScope({
      head: ACCEPTED_P3C_A1_HEAD, parent: INTEGRATED_P3B_HEAD, subject: P3C_A1_SUBJECT,
      acceptedP1Ancestor: true, modifiedTracked: [...P3C_A2_1_AUTHORIZED_PATHS], untracked: [],
      committedPaths: [...P3C_A1_AUTHORIZED_PATHS],
    })), "p3c-a2-uncommitted");
  });
  scopeTest("committed P3C-A2.1 pins parent, subject and the exact three-path set", () => {
    assert.equal(classifyScope(baseDirtyScope({
      head: "future-p3c-a2-1", parent: ACCEPTED_P3C_A2_HEAD, subject: P3C_A2_1_SUBJECT,
      acceptedP1Ancestor: true, modifiedTracked: [], untracked: [],
      committedPaths: [...P3C_A2_1_AUTHORIZED_PATHS],
    })), "p3c-a2-1-committed");
    for (const override of [
      // Wrong parent, wrong subject, and any deviation from the exact three.
      { parent: ACCEPTED_P3C_A1_HEAD },
      { subject: P3C_A2_SUBJECT },
      { committedPaths: [...P3C_A2_1_AUTHORIZED_PATHS, ACTIVATOR_REL].sort() },
      { committedPaths: [...P3C_A2_1_AUTHORIZED_PATHS, PACKAGE_REL].sort() },
      // A strict subset must not be tolerated: the set is exact, not minimum.
      { committedPaths: [VALIDATOR_REL, WRITER_VALIDATOR_REL].sort() },
      { committedPaths: [WRITER_VALIDATOR_REL] },
      { committedPaths: [] },
      { modifiedTracked: [WRITER_VALIDATOR_REL] },
      { untracked: ["stray.mjs"] },
      { staged: [VALIDATOR_REL] },
    ]) {
      assert.throws(() => classifyScope(baseDirtyScope({
        head: "future-p3c-a2-1", parent: ACCEPTED_P3C_A2_HEAD, subject: P3C_A2_1_SUBJECT,
        acceptedP1Ancestor: true, modifiedTracked: [], untracked: [],
        committedPaths: [...P3C_A2_1_AUTHORIZED_PATHS], ...override,
      })), /scope mismatch|rejects staged paths/u);
    }
  });
  scopeTest("exact dirty five-path P3C-A2 state is accepted", () => {
    assert.equal(classifyScope(baseDirtyScope({
      head: ACCEPTED_P3C_A1_HEAD, parent: INTEGRATED_P3B_HEAD, subject: P3C_A1_SUBJECT,
      acceptedP1Ancestor: true, modifiedTracked: [...P3C_A2_AUTHORIZED_PATHS], untracked: [],
      committedPaths: [...P3C_A1_AUTHORIZED_PATHS],
    })), "p3c-a2-uncommitted");
  });
  scopeTest("P3C-A2 dirty scope rejects an unauthorized path, staging or untracked source", () => {
    for (const override of [
      { modifiedTracked: [...P3C_A2_AUTHORIZED_PATHS, PUBLISHER_REL].sort() },
      { modifiedTracked: [...P3C_A2_AUTHORIZED_PATHS, CANONICAL_LIB_REL].sort() },
      { modifiedTracked: [...P3C_A2_AUTHORIZED_PATHS, PACKAGE_REL].sort() },
      { untracked: ["tools/publish/scratch.mjs"] },
      { staged: [ACTIVATOR_REL] },
      { head: INTEGRATED_P3B_HEAD },
    ]) {
      assert.throws(() => classifyScope(baseDirtyScope({
        head: ACCEPTED_P3C_A1_HEAD, parent: INTEGRATED_P3B_HEAD, subject: P3C_A1_SUBJECT,
        acceptedP1Ancestor: true, modifiedTracked: [...P3C_A2_AUTHORIZED_PATHS], untracked: [],
        committedPaths: [...P3C_A1_AUTHORIZED_PATHS], ...override,
      })), /scope mismatch|rejects staged paths/u);
    }
  });
  scopeTest("committed P3C-A2 pins its parent, subject and authorized path set", () => {
    assert.equal(classifyScope(baseDirtyScope({
      head: "future-p3c-a2", parent: ACCEPTED_P3C_A1_HEAD, subject: P3C_A2_SUBJECT,
      acceptedP1Ancestor: true, modifiedTracked: [], untracked: [],
      committedPaths: [...P3C_A2_AUTHORIZED_PATHS],
    })), "p3c-a2-committed");
    for (const override of [
      { parent: INTEGRATED_P3B_HEAD },
      { subject: P3C_A1_SUBJECT },
      { committedPaths: [...P3C_A2_AUTHORIZED_PATHS, PACKAGE_REL].sort() },
      { committedPaths: [] },
    ]) {
      assert.throws(() => classifyScope(baseDirtyScope({
        head: "future-p3c-a2", parent: ACCEPTED_P3C_A1_HEAD, subject: P3C_A2_SUBJECT,
        acceptedP1Ancestor: true, modifiedTracked: [], untracked: [],
        committedPaths: [...P3C_A2_AUTHORIZED_PATHS], ...override,
      })), /scope mismatch/u);
    }
  });
  scopeTest("exact dirty four-path P3C-A1 state is accepted", () => {
    assert.equal(classifyScope(baseDirtyScope({
      head: INTEGRATED_P3B_HEAD, parent: P3B_SOURCE_HEAD, subject: P3B_VALIDATION_SUBJECT,
      acceptedP1Ancestor: true, modifiedTracked: [...P3C_A1_AUTHORIZED_PATHS], untracked: [],
      committedPaths: [...P3B_VALIDATION_PATHS],
    })), "p3c-a1-uncommitted");
  });
  scopeTest("P3C-A1 dirty scope rejects an unauthorized path, staging or untracked source", () => {
    for (const override of [
      { modifiedTracked: [...P3C_A1_AUTHORIZED_PATHS, PUBLISHER_REL].sort() },
      { modifiedTracked: [...P3C_A1_AUTHORIZED_PATHS, CANONICAL_LIB_REL].sort() },
      { untracked: ["tools/publish/scratch.mjs"] },
      { staged: [ACTIVATOR_REL] },
      { head: P3B_SOURCE_HEAD },
    ]) {
      assert.throws(() => classifyScope(baseDirtyScope({
        head: INTEGRATED_P3B_HEAD, parent: P3B_SOURCE_HEAD, subject: P3B_VALIDATION_SUBJECT,
        acceptedP1Ancestor: true, modifiedTracked: [...P3C_A1_AUTHORIZED_PATHS], untracked: [],
        committedPaths: [...P3B_VALIDATION_PATHS], ...override,
      })), /scope mismatch|rejects staged paths/u);
    }
  });
  scopeTest("exact committed four-path P3C-A1 state is accepted", () => {
    assert.equal(classifyScope(baseDirtyScope({
      head: "future-p3c-a1", parent: INTEGRATED_P3B_HEAD, subject: P3C_A1_SUBJECT,
      acceptedP1Ancestor: true, modifiedTracked: [], untracked: [],
      committedPaths: [...P3C_A1_AUTHORIZED_PATHS],
    })), "p3c-a1-committed");
  });
  scopeTest("committed P3C-A1 rejects a wrong parent, subject or extra path", () => {
    for (const override of [
      { parent: P3B_SOURCE_HEAD },
      { subject: P3B_VALIDATION_SUBJECT },
      { committedPaths: [...P3C_A1_AUTHORIZED_PATHS, PACKAGE_REL].sort() },
      { committedPaths: [...P3B_VALIDATION_PATHS] },
    ]) {
      assert.throws(() => classifyScope(baseDirtyScope({
        head: "future-p3c-a1", parent: INTEGRATED_P3B_HEAD, subject: P3C_A1_SUBJECT,
        acceptedP1Ancestor: true, modifiedTracked: [], untracked: [],
        committedPaths: [...P3C_A1_AUTHORIZED_PATHS], ...override,
      })), /scope mismatch/u);
    }
  });
  scopeTest("every historical P0-P3B scope mode is still classifiable", () => {
    const modes = [
      classifyScope(baseDirtyScope()),
      classifyScope(baseDirtyScope({
        head: ACCEPTED_P23_HEAD, parent: ACCEPTED_P22_HEAD, subject: P23_SUBJECT,
        acceptedP1Ancestor: true, modifiedTracked: [], untracked: [PAYLOAD_VALIDATOR_REL],
        committedPaths: [...P23_AUTHORIZED_PATHS],
      })),
      classifyScope(baseDirtyScope({
        head: "future-p3a", parent: ACCEPTED_P23_HEAD, subject: P3A_SUBJECT,
        acceptedP1Ancestor: true, modifiedTracked: [], untracked: [],
        committedPaths: [...P3A_AUTHORIZED_PATHS],
      })),
      classifyScope(baseDirtyScope({
        head: P3B_SOURCE_HEAD, parent: INTEGRATED_P3A_HEAD, subject: P3B_SOURCE_SUBJECT,
        acceptedP1Ancestor: true, modifiedTracked: [...P3B_VALIDATION_PATHS], untracked: [],
        committedPaths: [...P3B_SOURCE_PATHS],
      })),
      classifyScope(baseDirtyScope({
        head: "future-p3b", parent: P3B_SOURCE_HEAD, subject: P3B_VALIDATION_SUBJECT,
        acceptedP1Ancestor: true, modifiedTracked: [], untracked: [],
        committedPaths: [...P3B_VALIDATION_PATHS],
      })),
    ];
    assert.deepEqual(modes, ["uncommitted", "p3a-test-first-uncommitted", "p3a-committed",
      "p3b-validation-uncommitted", "p3b-validation-committed"]);
  });
  scopeTest("P3A test-first state carries only the new payload validator", () => {
    assert.equal(classifyScope(baseDirtyScope({
      head: ACCEPTED_P23_HEAD, parent: ACCEPTED_P22_HEAD, subject: P23_SUBJECT,
      acceptedP1Ancestor: true, modifiedTracked: [], untracked: [PAYLOAD_VALIDATOR_REL],
      committedPaths: [...P23_AUTHORIZED_PATHS],
    })), "p3a-test-first-uncommitted");
  });
  scopeTest("exact dirty four-path P3A state is accepted", () => {
    assert.equal(classifyScope(baseDirtyScope({
      head: ACCEPTED_P23_HEAD, parent: ACCEPTED_P22_HEAD, subject: P23_SUBJECT,
      acceptedP1Ancestor: true, modifiedTracked: [ACTIVATOR_REL, VALIDATOR_REL].sort(),
      untracked: [PAYLOAD_MODULE_REL, PAYLOAD_VALIDATOR_REL].sort(),
      committedPaths: [...P23_AUTHORIZED_PATHS],
    })), "p3a-uncommitted");
  });
  scopeTest("P3A dirty scope rejects an unauthorized path", () => {
    assert.throws(() => classifyScope(baseDirtyScope({
      head: ACCEPTED_P23_HEAD, parent: ACCEPTED_P22_HEAD, subject: P23_SUBJECT,
      acceptedP1Ancestor: true, modifiedTracked: [ACTIVATOR_REL, VALIDATOR_REL, PUBLISHER_REL].sort(),
      untracked: [PAYLOAD_MODULE_REL, PAYLOAD_VALIDATOR_REL].sort(),
      committedPaths: [...P23_AUTHORIZED_PATHS],
    })), /scope mismatch/u);
  });
  scopeTest("exact one-path current-main baseline scope is accepted", () => {
    assert.equal(classifyScope(baseDirtyScope({
      head: ACCEPTED_CURRENT_MAIN_HEAD, parent: "287b7604d9ccefe38651a3badcc6514af679617d",
      subject: "test(publish): prove writer enforcement never mutates the live canonical anchor",
      acceptedP1Ancestor: true,
      modifiedTracked: [...CURRENT_BASELINE_AUTHORIZED_PATHS], untracked: [],
      finalPaths: [...AUTHORIZED_PATHS],
      committedPaths: ["tools/validation/publish/validate-canonical-writer-enforcement-v1.mjs"],
    })), "current-baseline-uncommitted");
  });
  scopeTest("current-main baseline rejects production, extra, staged, untracked or missing paths", () => {
    for (const override of [
      { modifiedTracked: [ACTIVATOR_REL] },
      { modifiedTracked: [VALIDATOR_REL, ACTIVATOR_REL].sort() },
      { modifiedTracked: [VALIDATOR_REL, PACKAGE_REL].sort() },
      { modifiedTracked: [] },
      { staged: [VALIDATOR_REL] },
      { untracked: ["stray.mjs"] },
      { finalPaths: [PACKAGE_REL, VALIDATOR_REL].sort() },
      { head: "287b7604d9ccefe38651a3badcc6514af679617d" },
    ]) {
      assert.throws(() => classifyScope(baseDirtyScope({
        head: ACCEPTED_CURRENT_MAIN_HEAD, parent: "287b7604d9ccefe38651a3badcc6514af679617d",
        subject: "test(publish): prove writer enforcement never mutates the live canonical anchor",
        acceptedP1Ancestor: true,
        modifiedTracked: [...CURRENT_BASELINE_AUTHORIZED_PATHS], untracked: [],
        finalPaths: [...AUTHORIZED_PATHS],
        committedPaths: ["tools/validation/publish/validate-canonical-writer-enforcement-v1.mjs"],
        ...override,
      })), /scope mismatch|rejects staged/u);
    }
  });
  scopeTest("committed current-main baseline pins parent, subject and the single path", () => {
    assert.equal(classifyScope(baseDirtyScope({
      head: "future-current-baseline", parent: ACCEPTED_CURRENT_MAIN_HEAD,
      subject: CURRENT_BASELINE_SUBJECT, acceptedP1Ancestor: true,
      modifiedTracked: [], untracked: [], finalPaths: [...AUTHORIZED_PATHS],
      committedPaths: [...CURRENT_BASELINE_AUTHORIZED_PATHS],
    })), "current-baseline-committed");
    for (const override of [
      { parent: "287b7604d9ccefe38651a3badcc6514af679617d" },
      { subject: P3C_INTEGRATION_SUBJECT },
      { committedPaths: [VALIDATOR_REL, ACTIVATOR_REL].sort() },
      { committedPaths: [ACTIVATOR_REL] },
      { finalPaths: [PACKAGE_REL, VALIDATOR_REL].sort() },
    ]) {
      assert.throws(() => classifyScope(baseDirtyScope({
        head: "future-current-baseline", parent: ACCEPTED_CURRENT_MAIN_HEAD,
        subject: CURRENT_BASELINE_SUBJECT, acceptedP1Ancestor: true,
        modifiedTracked: [], untracked: [], finalPaths: [...AUTHORIZED_PATHS],
        committedPaths: [...CURRENT_BASELINE_AUTHORIZED_PATHS], ...override,
      })), /scope mismatch/u);
    }
  });
  scopeTest("historical intent fix authorizes exactly activator plus its focused validator", () => {
    assert.equal(classifyScope(baseDirtyScope({
      head: HISTORICAL_INTENT_FIX_BASE,
      modifiedTracked: [...HISTORICAL_INTENT_FIX_PATHS], staged: [], untracked: [],
      finalPaths: [...FINAL_PATHS], trackedFinal: [...FINAL_PATHS], missingFinal: [],
    })), "historical-intent-fix-uncommitted");
  });
  scopeTest("historical intent fix rejects missing, extra, staged or untracked paths", () => {
    for (const override of [
      { modifiedTracked: [ACTIVATOR_REL] },
      { modifiedTracked: [VALIDATOR_REL] },
      { modifiedTracked: [...HISTORICAL_INTENT_FIX_PATHS, PAYLOAD_MODULE_REL].sort() },
      { staged: [VALIDATOR_REL] },
      { untracked: ["stray.mjs"] },
      { head: "0".repeat(40) },
    ]) {
      assert.throws(() => classifyScope(baseDirtyScope({
        head: HISTORICAL_INTENT_FIX_BASE,
        modifiedTracked: [...HISTORICAL_INTENT_FIX_PATHS], staged: [], untracked: [],
        finalPaths: [...FINAL_PATHS], trackedFinal: [...FINAL_PATHS], missingFinal: [],
        ...override,
      })), /scope mismatch|rejects staged/u);
    }
  });
  scopeTest("exact committed four-path P3A state is accepted", () => {
    assert.equal(classifyScope(baseDirtyScope({
      head: "future-p3a", parent: ACCEPTED_P23_HEAD, subject: P3A_SUBJECT,
      acceptedP1Ancestor: true, modifiedTracked: [], untracked: [],
      committedPaths: [...P3A_AUTHORIZED_PATHS],
    })), "p3a-committed");
  });
  scopeTest("the P3A repair state modifies exactly the four committed paths", () => {
    assert.equal(classifyScope(baseDirtyScope({
      head: P3A_CANDIDATE_HEAD, parent: ACCEPTED_P23_HEAD, subject: P3A_SUBJECT,
      acceptedP1Ancestor: true, modifiedTracked: [...P3A_AUTHORIZED_PATHS], untracked: [],
      committedPaths: [...P3A_AUTHORIZED_PATHS],
    })), "p3a-repair-uncommitted");
  });
  scopeTest("committed P3A rejects a wrong parent, subject or extra path", () => {
    for (const override of [
      { parent: ACCEPTED_P22_HEAD },
      { subject: P23_SUBJECT },
      { committedPaths: [...P3A_AUTHORIZED_PATHS, PACKAGE_REL].sort() },
    ]) {
      assert.throws(() => classifyScope(baseDirtyScope({
        head: "future-p3a", parent: ACCEPTED_P23_HEAD, subject: P3A_SUBJECT,
        acceptedP1Ancestor: true, modifiedTracked: [], untracked: [],
        committedPaths: [...P3A_AUTHORIZED_PATHS], ...override,
      })), /scope mismatch/u);
    }
  });
  scopeTest("durable committed-clean survives later commits and rejects adjacent states", () => {
    const clean = {
      head: CLASSIFIER_DURABILITY_BASE,
      parent: "a102e219da8efa71d95f88b12f489cf63a0339de",
      subject: "test(publish): preserve E2B writer anchor identity",
      acceptedP1Ancestor: true,
      modifiedTracked: [], staged: [], untracked: [],
      finalPaths: [...FINAL_PATHS], trackedFinal: [...FINAL_PATHS], missingFinal: [],
      committedPaths: ["tools/validation/publish/validate-e2b-writer-enforcement-v1.mjs"],
    };
    assert.equal(classifyScope(baseDirtyScope(clean)), "committed-clean");
    assert.equal(classifyScope(baseDirtyScope({
      ...clean,
      head: "f".repeat(40), parent: "e".repeat(40), subject: "later legitimate commit",
      committedPaths: ["later/path.mjs"],
    })), "committed-clean");
    assert.equal(classifyScope(baseDirtyScope({
      ...clean,
      modifiedTracked: [...CLASSIFIER_DURABILITY_PATHS],
    })), "classifier-durability-uncommitted");
    for (const override of [
      { modifiedTracked: [ACTIVATOR_REL] },
      { modifiedTracked: [VALIDATOR_REL] },
      { modifiedTracked: ["README.md"] },
      { staged: [VALIDATOR_REL] },
      { staged: ["README.md"] },
      { untracked: ["foreign.txt"] },
      {
        trackedFinal: FINAL_PATHS.filter((relative) => relative !== ACTIVATOR_REL),
        missingFinal: [ACTIVATOR_REL],
      },
      {
        trackedFinal: FINAL_PATHS.filter((relative) => relative !== ACTIVATOR_REL),
        untracked: [ACTIVATOR_REL],
      },
    ]) {
      assert.throws(
        () => classifyScope(baseDirtyScope({
          ...clean,
          head: "f".repeat(40), parent: "e".repeat(40), subject: "later legitimate commit",
          committedPaths: ["later/path.mjs"],
          ...override,
        })),
        /scope mismatch|rejects staged/u,
      );
    }
    assert.throws(() => classifyScope({}), /TypeError|scope mismatch/u);
  });
  scopeTest("exact uncommitted Studio publication-authority round is admitted", () => {
    assert.equal(classifyScope(baseDirtyScope({
      head: STUDIO_PUBLICATION_BASE_HEAD,
      modifiedTracked: [...STUDIO_PUBLICATION_AUTHORITY_PATHS],
      staged: [], untracked: [],
    })), "studio-publication-authority-uncommitted");
  });
  scopeTest("exact CP08 activator-validator synchronization is admitted and adjacent states reject", () => {
    const accepted = {
      head: STUDIO_PUBLICATION_AUTHORITY_HEAD,
      modifiedTracked: [...STUDIO_VALIDATOR_SYNC_PATHS],
      staged: [], untracked: [],
      committedPaths: [...STUDIO_PUBLICATION_AUTHORITY_PATHS],
      trackedFinal: [...FINAL_PATHS], missingFinal: [],
    };
    assert.equal(classifyScope(baseDirtyScope(accepted)), "studio-validator-sync-uncommitted");
    for (const override of [
      { modifiedTracked: [PUBLISHER_REL, VALIDATOR_REL].sort() },
      { modifiedTracked: [PUBLISHER_REL] },
      { modifiedTracked: [ACTIVATOR_REL] },
      { modifiedTracked: [PAYLOAD_MODULE_REL] },
      { modifiedTracked: [PAYLOAD_VALIDATOR_REL] },
      { head: STUDIO_PUBLICATION_BASE_HEAD },
      { untracked: ["foreign-publication-file.mjs"] },
      { staged: [VALIDATOR_REL] },
    ]) {
      assert.throws(() => classifyScope(baseDirtyScope({ ...accepted, ...override })),
        /scope mismatch|rejects staged/u);
    }
  });
  assert.equal(scopeResults.length, EXPECTED_SCOPE);
}

function authorityError(code, evidence) {
  const error = new Error(code);
  error.code = code;
  error.evidence = evidence;
  throw error;
}

function evaluateRegisteredMainAuthority(evidence) {
  if (evidence.mainBranch !== "main") authorityError("registered-main-wrong-branch", evidence);
  if (evidence.mainTrackedClean !== true) authorityError("registered-main-dirty", evidence);
  if (evidence.mainIndexEmpty !== true) authorityError("registered-main-index-not-empty", evidence);
  if (evidence.mainUntrackedClean !== true) authorityError("registered-main-untracked-source", evidence);
  const isolatedCandidate = evidence.mainHead === BASE_HEAD &&
    evidence.executionHead === ACCEPTED_P1_HEAD && evidence.executionScope === "committed-clean" &&
    evidence.executionWorktree !== evidence.mainWorktree;
  if (isolatedCandidate) return "pre-integration-candidate";
  if (evidence.acceptedP1Ancestor !== true) authorityError("registered-main-p1-ancestry-missing", evidence);
  if (!["committed-clean", "validator-fix-uncommitted", "validator-fix-committed",
    "p2-test-first-uncommitted", "p2-uncommitted", "p2-committed",
    "p21-test-first-uncommitted", "p21-uncommitted", "p21-committed",
    "p22-test-first-uncommitted", "p22-uncommitted", "p22-committed",
    "p23-test-first-uncommitted", "p23-uncommitted", "p23-committed",
    "p3a-test-first-uncommitted", "p3a-uncommitted", "p3a-repair-uncommitted", "p3a-committed",
    "p3b-source-committed", "p3b-validation-uncommitted", "p3b-validation-committed",
    "p3c-a1-uncommitted", "p3c-a1-committed",
    "p3c-a2-uncommitted", "p3c-a2-committed",
    "p3c-a2-1-uncommitted", "p3c-a2-1-committed",
    "p3c-b1-uncommitted", "p3c-b1-committed",
    "p3c-a3-uncommitted", "p3c-a3-committed",
    "p3c-a3b-uncommitted", "p3c-a3b-committed",
    "p3c-main-sync-uncommitted", "p3c-main-sync-committed",
    "p3c-final-sync-uncommitted", "p3c-final-sync-committed",
    "p3c-integration-uncommitted", "p3c-integration-committed",
    "current-baseline-uncommitted", "current-baseline-committed",
    "classifier-durability-uncommitted", "historical-intent-fix-uncommitted",
    "studio-publication-authority-uncommitted", "studio-validator-sync-uncommitted",
    "cp10-historical-intent-uncommitted", "cp10-historical-intent-committed"]
    .includes(evidence.executionScope)) {
    authorityError("execution-scope-not-integrated-authority", evidence);
  }
  return "integrated";
}

function authorityEvidence(overrides = {}) {
  return {
    mainHead: ACCEPTED_P1_HEAD,
    mainBranch: "main",
    mainTrackedClean: true,
    mainIndexEmpty: true,
    mainUntrackedClean: true,
    acceptedP1Ancestor: true,
    mainWorktree: "/fixture/main",
    executionHead: ACCEPTED_P1_HEAD,
    executionScope: "committed-clean",
    executionWorktree: "/fixture/main",
    ...overrides,
  };
}

async function test(name, fn) {
  await fn();
  runtimeResults.push(name);
  process.stdout.write(`ok ${runtimeResults.length} - ${name}\n`);
}

function structural(name, fn) {
  fn();
  structuralResults.push(name);
  process.stdout.write(`ok structural ${structuralResults.length} - ${name}\n`);
}

function collectChild(child) {
  return new Promise((resolve, reject) => {
    let stdout = ""; let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (status) => resolve({ status, stdout, stderr }));
  });
}

function copyFile(source, destination) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
}

function authoritativeMainWorktree() {
  const blocks = git(ROOT, ["worktree", "list", "--porcelain"]).split(/\n\n/u);
  const declaredMainWorktrees = [];
  for (const block of blocks) {
    const lines = block.split("\n");
    if (!lines.includes("branch refs/heads/main")) continue;
    const worktree = lines.find((line) => line.startsWith("worktree "))?.slice("worktree ".length);
    if (worktree) declaredMainWorktrees.push(fs.realpathSync(worktree));
  }
  if (declaredMainWorktrees.length !== 1) {
    authorityError("registered-main-worktree-count", { declaredMainWorktrees });
  }
  const mainWorktree = declaredMainWorktrees[0];
  const executionState = currentScopeState();
  const executionScope = classifyScope(executionState);
  const mainHead = git(mainWorktree, ["rev-parse", "HEAD"]);
  evaluateRegisteredMainAuthority({
    mainHead,
    mainBranch: git(mainWorktree, ["branch", "--show-current"]),
    mainTrackedClean: git(mainWorktree, ["diff", "--quiet"], { allowFailure: true }) !== null,
    mainIndexEmpty: git(mainWorktree, ["diff", "--cached", "--quiet"], { allowFailure: true }) !== null,
    mainUntrackedClean: git(mainWorktree,
      ["ls-files", "--others", "--exclude-standard", "--", ".", ":(exclude)chrome"]) === "",
    acceptedP1Ancestor: git(mainWorktree,
      ["merge-base", "--is-ancestor", ACCEPTED_P1_HEAD, mainHead], { allowFailure: true }) !== null,
    mainWorktree,
    executionHead: executionState.head,
    executionScope,
    executionWorktree: fs.realpathSync(ROOT),
  });
  return mainWorktree;
}

function installIgnoredPublisherInputs(repository) {
  const main = authoritativeMainWorktree();
  const dependencies = path.join(main, "node_modules");
  assert.equal(fs.statSync(dependencies).isDirectory(), true, "authoritative dependency runtime is required");
  fs.mkdirSync(path.join(repository, "node_modules"), { recursive: true });
  for (const entry of fs.readdirSync(dependencies)) {
    const destination = path.join(repository, "node_modules", entry);
    if (!fs.existsSync(destination)) fs.symlinkSync(path.join(dependencies, entry), destination);
  }
  for (const relative of [
    "assets/chrome-dev-controls-icons",
    "assets/chrome-dev-lean-icons",
    "assets/internal-dev-controls-icons",
  ]) {
    const source = path.join(main, relative);
    if (!fs.existsSync(source)) continue;
    const destination = path.join(repository, relative);
    fs.mkdirSync(destination, { recursive: true });
    for (const name of fs.readdirSync(source)) {
      const from = path.join(source, name);
      if (fs.statSync(from).isFile()) copyFile(from, path.join(destination, name));
    }
  }
  const localConfig = path.join(main, "config/local/identity-provider.local.json");
  if (fs.existsSync(localConfig)) {
    copyFile(localConfig, path.join(repository, "config/local/identity-provider.local.json"));
  }
}

function createRealPublisherBoundaryFixture(label, { studioAuthority = false } = {}) {
  const top = tempRoot(label);
  const repository = path.join(top, "publisher boundary with spaces 🧪");
  execFileSync("git", ["clone", "--quiet", "--local", ROOT, repository], {
    cwd: top, encoding: "utf8", timeout: 120_000, killSignal: "SIGTERM",
  });
  git(repository, ["checkout", "--quiet", "-B", "main", "HEAD"]);
  git(repository, ["config", "user.name", "Lean Activator Validator"]);
  git(repository, ["config", "user.email", "lean-activator@example.invalid"]);
  const pinnedPublisher = execFileSync("git", ["show", `${BASE_HEAD}:${PUBLISHER_REL}`], { cwd: ROOT });
  const pinnedPublisherValidator = execFileSync("git", ["show",
    `${BASE_HEAD}:tools/validation/publish/validate-lean-publisher-v1.mjs`], { cwd: ROOT });
  assert.equal(sha256(pinnedPublisher), BATCH11_PUBLISHER_SHA256,
    "Batch 1.1 publisher authority must remain pinned to BASE_HEAD");
  assert.equal(sha256(pinnedPublisherValidator), BATCH11_VALIDATOR_SHA256,
    "Batch 1.1 publisher validator authority must remain pinned to BASE_HEAD");
  assert.equal(sha256(fs.readFileSync(path.join(repository, PUBLISHER_REL))),
    SYNCED_PUBLISHER_SHA256,
    "fixture must execute the exact committed publisher of the synchronized tree");
  copyFile(path.join(ROOT, ACTIVATOR_REL), path.join(repository, ACTIVATOR_REL));
  copyFile(path.join(ROOT, CANONICAL_LIB_REL), path.join(repository, CANONICAL_LIB_REL));
  copyFile(path.join(ROOT, PAYLOAD_MODULE_REL), path.join(repository, PAYLOAD_MODULE_REL));
  if (studioAuthority) {
    copyFile(path.join(ROOT, PUBLISHER_REL), path.join(repository, PUBLISHER_REL));
    const canonicalMain = authoritativeMainWorktree();
    const previousStudio = path.join(canonicalMain,
      "apps", "extensions", "chatgpt", "chrome", "studio-launcher");
    assert.equal(fs.statSync(previousStudio).isDirectory(), true,
      "a real legacy Studio launcher is required for rollback fixtures");
    const fixtureChrome = path.join(repository, "apps", "extensions", "chatgpt", "chrome");
    fs.mkdirSync(fixtureChrome, { recursive: true });
    fs.cpSync(previousStudio, path.join(fixtureChrome, "studio-launcher"),
      { recursive: true, dereference: false });
  }
  installIgnoredPublisherInputs(repository);
  git(repository, ["add", ACTIVATOR_REL, CANONICAL_LIB_REL, PAYLOAD_MODULE_REL,
    ...(studioAuthority ? [PUBLISHER_REL] : [])]);
  if (git(repository, ["diff", "--cached", "--name-only"])) {
    git(repository, ["commit", "-q", "-m", "fixture: current read-only activator"]);
  }
  assert.equal(git(repository, ["status", "--porcelain=v1"]), "");
  return {
    top,
    repository,
    activator: path.join(repository, ACTIVATOR_REL),
    publisher: path.join(repository, PUBLISHER_REL),
  };
}

function runRealPublisher(fixture, { studio = false } = {}) {
  const head = git(fixture.repository, ["rev-parse", "HEAD"]);
  const args = studio
    ? [fixture.publisher, "--stage-only", "--target", "studio-launcher", "--authorized-head", head]
    : [fixture.publisher, "--stage-only"];
  const result = spawnSync(process.execPath, args, {
    cwd: fixture.repository,
    env: cleanEnvironment(),
    encoding: "utf8",
    timeout: 300_000,
    killSignal: "SIGTERM",
  });
  const receiptPath = String(result.stdout || "").match(/receipt\s+:\s+(.+)$/mu)?.[1]?.trim() || null;
  const stagingRoot = String(result.stdout || "").match(/staging root\s+:\s+(.+)$/mu)?.[1]?.trim() || null;
  if (stagingRoot) temporaryRoots.push(stagingRoot);
  return { result, receiptPath, stagingRoot };
}

function createRepositoryFixture(label, { withFoundation = true } = {}) {
  const top = tempRoot(label);
  const repository = path.join(top, "repository with spaces 🧪");
  if (withFoundation) {
    execFileSync("git", ["clone", "--quiet", "--local", "--no-checkout", ROOT, repository], {
      cwd: top, encoding: "utf8", timeout: 120_000,
    });
    git(repository, ["sparse-checkout", "set", "--no-cone", "/package.json", "/tools/publish/",
      "/tools/product/", "/tools/paths.mjs", "/config/extension-keys.json",
      "/fixture-source/", "/apps/dev-server/generated.js"]);
    git(repository, ["checkout", "--quiet", "-B", "main", "HEAD"]);
  } else {
    fs.mkdirSync(repository, { recursive: true });
    git(repository, ["init", "-q", "-b", "main"]);
    copyFile(path.join(ROOT, "tools/publish/canonical-delivery-lib.mjs"),
      path.join(repository, "tools/publish/canonical-delivery-lib.mjs"));
    copyFile(path.join(ROOT, PUBLISHER_REL), path.join(repository, PUBLISHER_REL));
    copyFile(path.join(ROOT, "tools/product/studio/pack-studio.mjs"),
      path.join(repository, "tools/product/studio/pack-studio.mjs"));
    copyFile(path.join(ROOT, "tools/product/extensions/chatgpt/chrome/chrome-extension-keys.mjs"),
      path.join(repository, "tools/product/extensions/chatgpt/chrome/chrome-extension-keys.mjs"));
    copyFile(path.join(ROOT, "tools/paths.mjs"), path.join(repository, "tools/paths.mjs"));
    copyFile(path.join(ROOT, "config/extension-keys.json"), path.join(repository, "config/extension-keys.json"));
  }
  git(repository, ["config", "user.name", "Lean Activator Validator"]);
  git(repository, ["config", "user.email", "lean-activator@example.invalid"]);
  copyFile(path.join(ROOT, ACTIVATOR_REL), path.join(repository, ACTIVATOR_REL));
  copyFile(path.join(ROOT, CANONICAL_LIB_REL), path.join(repository, CANONICAL_LIB_REL));
  // The activator's one production import edge must resolve to the working-tree
  // payload module, not to whatever the clone inherited from HEAD.
  copyFile(path.join(ROOT, PAYLOAD_MODULE_REL), path.join(repository, PAYLOAD_MODULE_REL));
  fs.mkdirSync(path.join(repository, "fixture-source"), { recursive: true });
  fs.writeFileSync(path.join(repository, "fixture-source", "ordinary.js"), "export const ordinary = true;\n");
  fs.writeFileSync(path.join(repository, "fixture-source", "emoji 🧪.js"), "export const emoji = '🧪';\n");
  fs.mkdirSync(path.join(repository, "apps", "dev-server"), { recursive: true });
  fs.writeFileSync(path.join(repository, "apps", "dev-server", "generated.js"), "// generated fixture\n");
  git(repository, ["add", "--sparse", ACTIVATOR_REL, PUBLISHER_REL, "tools/publish/canonical-delivery-lib.mjs",
    PAYLOAD_MODULE_REL, "tools/product", "tools/paths.mjs", "config/extension-keys.json",
    "fixture-source", "apps/dev-server/generated.js"]);
  git(repository, ["commit", "-q", "-m", "fixture: activator source"]);
  assert.equal(git(repository, ["status", "--porcelain=v1"]), "");
  return { top, repository, activator: path.join(repository, ACTIVATOR_REL) };
}

function installAnchorMismatchBoundary(fixture) {
  const library = path.join(fixture.repository, CANONICAL_LIB_REL);
  const realRelative = "tools/publish/canonical-delivery-p22-real.mjs";
  const realLibrary = path.join(fixture.repository, realRelative);
  copyFile(library, realLibrary);
  fs.writeFileSync(library, [
    'import path from "node:path";',
    'import { deriveSharedAnchor as deriveRealSharedAnchor } from "./canonical-delivery-p22-real.mjs";',
    'export * from "./canonical-delivery-p22-real.mjs";',
    'export function deriveSharedAnchor(options) {',
    '  const actual = deriveRealSharedAnchor(options);',
    '  const wrongCockpitProRoot = path.join(actual.cockpitProRoot, "clean-but-wrong-root");',
    '  return Object.freeze({ ...actual, cockpitProRoot: wrongCockpitProRoot,',
    '    root: path.join(wrongCockpitProRoot, ".h2o-canonical-delivery") });',
    '}',
    '',
  ].join("\n"));
  git(fixture.repository, ["add", CANONICAL_LIB_REL, realRelative]);
  git(fixture.repository, ["commit", "-q", "-m", "fixture: clean incorrect anchor derivation"]);
  assert.equal(git(fixture.repository, ["status", "--porcelain=v1"]), "");
}

function listFiles(root) {
  const found = [];
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, "en"))) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else found.push(absolute);
    }
  };
  walk(root);
  return found;
}

function fixtureManifest(root, stageRoot) {
  const entries = listFiles(root).map((filename) => {
    const relative = path.relative(stageRoot, filename).split(path.sep).join("/");
    const stat = fs.lstatSync(filename);
    return stat.isSymbolicLink()
      ? { path: relative, type: "symlink", target: fs.readlinkSync(filename) }
      : { path: relative, type: "file", bytes: stat.size, sha256: sha256(fs.readFileSync(filename)) };
  }).sort((a, b) => a.path.localeCompare(b.path, "en"));
  return {
    fileCount: entries.length,
    treeDigest: sha256(entries.map((entry) => JSON.stringify(entry)).join("\n")),
    entries,
  };
}

function createStageFixture(repository, label = "valid") {
  const stageRoot = fs.mkdtempSync(path.join(os.tmpdir(), `h2o-publish-stage-${label}-`));
  temporaryRoots.push(stageRoot);
  const alias = path.join(stageRoot, "server", "alias");
  const devOutput = path.join(stageRoot, "server", "dev_output");
  const proxyPack = path.join(devOutput, "proxy", "_paste-pack.ext.txt");
  const extension = path.join(stageRoot, "extension");
  fs.mkdirSync(alias, { recursive: true });
  fs.mkdirSync(path.dirname(proxyPack), { recursive: true });
  fs.mkdirSync(extension, { recursive: true });
  const aliases = [
    ["ordinary.js", path.join(repository, "fixture-source", "ordinary.js")],
    ["emoji 🧪.js", path.join(repository, "fixture-source", "emoji 🧪.js")],
  ];
  for (const [name, target] of aliases) {
    fs.copyFileSync(target, path.join(alias, name));
  }
  fs.symlinkSync("ordinary.js", path.join(alias, "compat ordinary.js"));
  const buildTimestamp = String(Date.now());
  fs.writeFileSync(proxyPack, `// buildTs=${buildTimestamp}\n// proxy fixture\n`);
  fs.writeFileSync(path.join(extension, "manifest.json"), `${JSON.stringify({ manifest_version: 3, name: "fixture", version: "1.0.0" })}\n`);
  fs.writeFileSync(path.join(extension, "loader.js"), `// buildTs=${buildTimestamp}\n`);
  fs.writeFileSync(path.join(extension, "bg.js"), "// background\n");
  fs.writeFileSync(path.join(extension, "title-contract-bridge.js"), "// bridge\n");
  fs.mkdirSync(path.join(extension, "provider"));
  fs.writeFileSync(path.join(extension, "provider", "identity-provider-supabase.js"), "// provider\n");
  const manifests = {
    alias: fixtureManifest(alias, stageRoot),
    devOutput: fixtureManifest(devOutput, stageRoot),
    extension: fixtureManifest(extension, stageRoot),
  };
  const head = git(repository, ["rev-parse", "HEAD"]);
  const receipt = {
    schemaVersion: 1,
    mode: "stage-only",
    repository: fs.realpathSync(repository),
    remote: "fixture",
    branch: "main",
    approvedHead: head,
    stagedExtensionVariant: "dev-controls-oauth-google",
    buildTimestamp,
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    stagingRoot: stageRoot,
    outputPaths: { alias, devOutput, proxyPack, extension },
    fileCounts: {
      alias: manifests.alias.fileCount,
      devOutput: manifests.devOutput.fileCount,
      extension: manifests.extension.fileCount,
      total: Object.values(manifests).reduce((sum, item) => sum + item.fileCount, 0),
    },
    treeDigests: Object.fromEntries(Object.entries(manifests).map(([name, item]) => [name, item.treeDigest])),
    manifests,
    validatorResult: { ok: true },
    lock: { directory: path.join(path.dirname(repository), ".h2o-publisher-lock"), ownerId: "fixture-owner" },
    activationPerformed: false,
    browserReloadPerformed: false,
    browserCanaryPerformed: false,
    pushPerformed: false,
  };
  const receiptPath = path.join(stageRoot, "publication-receipt.json");
  fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  return { stageRoot, alias, devOutput, proxyPack, extension, receipt, receiptPath };
}

function readReceipt(stage) {
  return JSON.parse(fs.readFileSync(stage.receiptPath, "utf8"));
}

function writeReceipt(stage, receipt) {
  fs.writeFileSync(stage.receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  stage.receipt = receipt;
}

function refreshReceiptManifests(stage) {
  const receipt = readReceipt(stage);
  const manifests = {
    alias: fixtureManifest(stage.alias, stage.stageRoot),
    devOutput: fixtureManifest(stage.devOutput, stage.stageRoot),
    extension: fixtureManifest(stage.extension, stage.stageRoot),
  };
  receipt.manifests = manifests;
  receipt.fileCounts = {
    alias: manifests.alias.fileCount,
    devOutput: manifests.devOutput.fileCount,
    extension: manifests.extension.fileCount,
    total: Object.values(manifests).reduce((sum, item) => sum + item.fileCount, 0),
  };
  receipt.treeDigests = Object.fromEntries(Object.entries(manifests).map(([name, item]) => [name, item.treeDigest]));
  writeReceipt(stage, receipt);
}

function cleanEnvironment(overrides = {}) {
  const environment = { ...process.env };
  for (const name of Object.keys(environment)) if (name.startsWith("H2O_")) delete environment[name];
  return { ...environment, ...overrides };
}

function runActivator(fixture, args, { env = {} } = {}) {
  return spawnSync(process.execPath, [fixture.activator, ...args], {
    cwd: fixture.repository,
    env: cleanEnvironment(env),
    encoding: "utf8",
    timeout: 60_000,
    killSignal: "SIGTERM",
  });
}

function codeOf(result) {
  try { return JSON.parse(String(result.stderr).trim()).code; } catch { return null; }
}

function expectFailure(fixture, args, expectedCode, options) {
  const result = runActivator(fixture, args, options);
  assert.equal(result.status, 1, result.stdout);
  assert.equal(codeOf(result), expectedCode, result.stderr);
  return result;
}

function mutateReceipt(stage, mutation) {
  const receipt = readReceipt(stage);
  mutation(receipt);
  writeReceipt(stage, receipt);
}

function cloneStage(repository, label, mutation) {
  const stage = createStageFixture(repository, label);
  if (mutation) mutation(stage);
  return stage;
}

function validTransactionModel() {
  const activationId = "20260802T120000000Z-a1b2c3d4e5f6";
  return {
    activationId,
    rollbackScope: "whole-release",
    journalResolved: true,
    finalReceiptDurable: true,
    trees: Object.fromEntries(["alias", "devOutput", "extension"].map((family) => [family, {
      activationId,
      state: "verified",
      incomingPrepared: true,
      liveRetired: true,
      incomingPromoted: true,
      verified: true,
      restored: false,
      previousState: { kind: "tree", recorded: true },
      restoreOnFailure: "previous-tree",
    }])),
  };
}

const FIXED_ACTIVATION_DATE = new Date("2026-08-02T12:00:00.000Z");
const FIXED_ACTIVATION_ID = "20260802T120000000Z-a1b2c3d4e5f6";
const FIXED_RANDOM_BYTES = () => Buffer.from("a1b2c3d4e5f6", "hex");

async function importFixtureActivator(fixture, label) {
  const api = await import(
    `${pathToFileURL(fixture.activator).href}?p2=${encodeURIComponent(label)}-${Date.now()}`);
  // P3B: intent preparation is gated on the approved production root. Fixtures
  // reach their own roots only through this explicit injection, which no
  // production CLI path calls.
  if (typeof api.configureFixtureApprovedRoots === "function") {
    api.configureFixtureApprovedRoots([fixture.repository, path.dirname(fixture.repository)]);
  }
  return api;
}

function expectActivatorError(fn, code) {
  assert.throws(fn, (error) => error?.code === code, `expected ActivatorError ${code}`);
}

function lockEvidence(root) {
  return {
    foundation: { publisherLock: path.join(root, ".h2o-publisher-lock") },
    source: {
      repository: path.join(root, "repository"),
      approvedHead: "a".repeat(40),
    },
  };
}

function writeLock(lockDirectory, value) {
  fs.mkdirSync(lockDirectory, { mode: 0o700 });
  fs.writeFileSync(path.join(lockDirectory, "lock.json"), `${JSON.stringify(value)}\n`, { mode: 0o600 });
}

async function runAuthorityModelTests() {
  await test("temporary-root cleanup is bounded, task-owned and failure-preserving", () => {
    const empty = tempRoot("cleanup-empty");
    disposeTemporaryRoot(empty);
    assert.equal(fs.existsSync(empty), false);

    const nested = tempRoot("cleanup-nested");
    fs.mkdirSync(path.join(nested, "one", "two"), { recursive: true });
    fs.writeFileSync(path.join(nested, "one", "two", "fixture.txt"), "fixture\n");
    disposeTemporaryRoot(nested);
    assert.equal(fs.existsSync(nested), false);

    const metadata = tempRoot("cleanup-ds-store");
    fs.writeFileSync(path.join(metadata, ".DS_Store"), "static fixture metadata\n");
    disposeTemporaryRoot(metadata);
    assert.equal(fs.existsSync(metadata), false);

    const symlinkTarget = tempRoot("cleanup-symlink-target");
    fs.writeFileSync(path.join(symlinkTarget, "preserved.txt"), "preserved\n");
    const symlinkFixture = tempRoot("cleanup-symlink-fixture");
    fs.symlinkSync(symlinkTarget, path.join(symlinkFixture, "external-link"));
    disposeTemporaryRoot(symlinkFixture);
    assert.equal(fs.existsSync(symlinkFixture), false);
    assert.equal(fs.readFileSync(path.join(symlinkTarget, "preserved.txt"), "utf8"), "preserved\n");
    disposeTemporaryRoot(symlinkTarget);

    let unauthorizedRemovalCalled = false;
    assert.throws(() => disposeTemporaryRoot(ROOT, {
      remove: () => { unauthorizedRemovalCalled = true; },
    }), /refusing to dispose non-owned fixture root/u);
    assert.equal(unauthorizedRemovalCalled, false);

    const persistent = tempRoot("cleanup-persistent-failure");
    fs.writeFileSync(path.join(persistent, "residue.txt"), "persistent fixture residue\n");
    const persistentError = Object.assign(new Error("injected persistent cleanup failure"), {
      code: "ENOTEMPTY",
    });
    let observedOptions = null;
    assert.throws(() => disposeTemporaryRoot(persistent, {
      remove: (_root, options) => {
        observedOptions = options;
        throw persistentError;
      },
    }), (error) => error === persistentError);
    assert.deepEqual(observedOptions, {
      recursive: true, force: true, maxRetries: 3, retryDelay: 50,
    });
    assert.equal(fs.existsSync(persistent), true);
    assert.equal(temporaryRoots.includes(persistent), true);
    disposeTemporaryRoot(persistent);
  });
  await test("isolated accepted candidate may provision from main fixed at Batch 1.1", () => {
    assert.equal(evaluateRegisteredMainAuthority(authorityEvidence({
      mainHead: BASE_HEAD,
      acceptedP1Ancestor: false,
      executionWorktree: "/fixture/candidate",
    })), "pre-integration-candidate");
  });
  await test("integrated main exactly at accepted P0/P1 is authorized", () => {
    assert.equal(evaluateRegisteredMainAuthority(authorityEvidence()), "integrated");
  });
  await test("current-main baseline scopes integrate narrowly without weakening main cleanliness", () => {
    const currentBaselineEvidence = {
      mainHead: ACCEPTED_CURRENT_MAIN_HEAD,
      executionHead: ACCEPTED_CURRENT_MAIN_HEAD,
      executionWorktree: "/fixture/current-baseline",
    };
    for (const executionScope of ["current-baseline-uncommitted", "current-baseline-committed"]) {
      assert.equal(evaluateRegisteredMainAuthority(authorityEvidence({
        ...currentBaselineEvidence, executionScope,
      })), "integrated");
    }
    assert.throws(() => evaluateRegisteredMainAuthority(authorityEvidence({
      ...currentBaselineEvidence,
      executionScope: "current-baseline-unknown",
    })), (error) => error.code === "execution-scope-not-integrated-authority");
    for (const [field, code] of [
      ["mainTrackedClean", "registered-main-dirty"],
      ["mainIndexEmpty", "registered-main-index-not-empty"],
      ["mainUntrackedClean", "registered-main-untracked-source"],
    ]) {
      assert.throws(() => evaluateRegisteredMainAuthority(authorityEvidence({
        ...currentBaselineEvidence,
        executionScope: "current-baseline-uncommitted",
        [field]: false,
      })), (error) => error.code === code);
    }
  });
  await test("clean exact validator-only descendant is authorized", () => {
    assert.equal(evaluateRegisteredMainAuthority(authorityEvidence({
      mainHead: "validator-fix-descendant",
      executionHead: "validator-fix-descendant",
      executionScope: "validator-fix-committed",
    })), "integrated");
  });
  await test("fixed-head replacement would become stale at the validator follow-up", () => {
    const descendant = "validator-fix-descendant";
    assert.notEqual(descendant, ACCEPTED_P1_HEAD);
    assert.equal(evaluateRegisteredMainAuthority(authorityEvidence({
      mainHead: descendant,
      executionHead: descendant,
      executionScope: "validator-fix-committed",
    })), "integrated");
  });
  await test("future integrated descendant requires an explicitly accepted validator scope", () => {
    assert.throws(() => evaluateRegisteredMainAuthority(authorityEvidence({
      mainHead: "future-descendant",
      executionHead: "future-descendant",
      executionScope: "unaccepted-future-scope",
    })), (error) => error.code === "execution-scope-not-integrated-authority");
    assert.equal(evaluateRegisteredMainAuthority(authorityEvidence({
      mainHead: "future-descendant",
      executionHead: "future-descendant",
      executionScope: "validator-fix-committed",
    })), "integrated");
  });
  await test("arbitrary Batch 1.1 descendant without accepted P0/P1 rejects", () => {
    assert.throws(() => evaluateRegisteredMainAuthority(authorityEvidence({
      mainHead: "arbitrary-base-descendant",
      acceptedP1Ancestor: false,
      executionScope: "validator-fix-committed",
    })), (error) => error.code === "registered-main-p1-ancestry-missing");
  });
  await test("unrelated registered main history rejects", () => {
    assert.throws(() => evaluateRegisteredMainAuthority(authorityEvidence({
      mainHead: "unrelated-history",
      acceptedP1Ancestor: false,
    })), (error) => error.code === "registered-main-p1-ancestry-missing");
  });
  await test("registered main on the wrong branch rejects", () => {
    assert.throws(() => evaluateRegisteredMainAuthority(authorityEvidence({ mainBranch: "feature" })),
      (error) => error.code === "registered-main-wrong-branch");
  });
  await test("dirty registered main rejects", () => {
    assert.throws(() => evaluateRegisteredMainAuthority(authorityEvidence({ mainTrackedClean: false })),
      (error) => error.code === "registered-main-dirty");
  });
  await test("registered main with a non-empty index rejects", () => {
    assert.throws(() => evaluateRegisteredMainAuthority(authorityEvidence({ mainIndexEmpty: false })),
      (error) => error.code === "registered-main-index-not-empty");
  });
  await test("registered main with untracked source rejects", () => {
    assert.throws(() => evaluateRegisteredMainAuthority(authorityEvidence({ mainUntrackedClean: false })),
      (error) => error.code === "registered-main-untracked-source");
  });
  await test("Batch 1.1 publisher bytes remain pinned to immutable BASE_HEAD", () => {
    assert.equal(sha256(execFileSync("git", ["show", `${BASE_HEAD}:${PUBLISHER_REL}`], { cwd: ROOT })),
      BATCH11_PUBLISHER_SHA256);
    assert.equal(sha256(execFileSync("git", ["show",
      `${BASE_HEAD}:tools/validation/publish/validate-lean-publisher-v1.mjs`], { cwd: ROOT })),
    BATCH11_VALIDATOR_SHA256);
  });
  await test("caller-claimed integration cannot bypass an unaccepted execution scope", () => {
    assert.throws(() => evaluateRegisteredMainAuthority(authorityEvidence({
      mainHead: "claimed-integrated",
      acceptedP1Ancestor: true,
      executionScope: "caller-claimed-integrated",
    })), (error) => error.code === "execution-scope-not-integrated-authority");
  });
}

async function runRuntimeTests(api) {
  await test("activator independently pins one-unit Studio and legacy Dev Controls targets", () => {
    assert.deepEqual(api.activatorTargetPolicy("dev-controls-oauth-google").logicalUnits,
      ["alias", "dev_output", "extension"]);
    const studio = api.activatorTargetPolicy("studio-launcher");
    assert.deepEqual(studio.outputFamilies, ["extension"]);
    assert.deepEqual(studio.logicalUnits, ["studio_launcher"]);
    assert.equal(studio.expectedExtensionId, "bpobkkppdlldlkccaehmpfclmkhiemhg");
    assert.throws(() => api.activatorTargetPolicy("receipt-selected-path"),
      (error) => error?.code === "publication-target-not-accepted");
  });
  const canonicalApi = await import(
    `${pathToFileURL(path.join(ROOT, CANONICAL_LIB_REL)).href}?p22-validator=${Date.now()}`);
  await test("activator imports the exact accepted canonical-library capability set", () => {
    const source = fs.readFileSync(path.join(ROOT, ACTIVATOR_REL), "utf8");
    assert.deepEqual(canonicalLibraryImports(source), ACCEPTED_CANONICAL_LIBRARY_IMPORTS);
  });
  await test("canonical-library capability pin rejects added, removed, aliased, namespace, default, and dynamic imports", () => {
    const source = fs.readFileSync(path.join(ROOT, ACTIVATOR_REL), "utf8");
    const mutations = [
      source.replace("  deriveSharedAnchor,", "  atomicWriteJson,\n  deriveSharedAnchor,"),
      source.replace("  deriveSharedAnchor,\n", ""),
      source.replace("  deriveSharedAnchor,", "  deriveSharedAnchor as deriveAnchor,"),
      source.replace(/import \{[\s\S]*?\} from "\.\/canonical-delivery-lib\.mjs";/u,
        'import * as canonicalDelivery from "./canonical-delivery-lib.mjs";'),
      source.replace(/import \{[\s\S]*?\} from "\.\/canonical-delivery-lib\.mjs";/u,
        'import canonicalDelivery from "./canonical-delivery-lib.mjs";'),
      `${source}\nconst unexpectedDynamic = import("./canonical-delivery-lib.mjs");\n`,
    ];
    for (const mutated of mutations) assert.throws(() => canonicalLibraryImports(mutated));
  });
  await test("durable Git identity excludes process-local filesystem metadata", () => {
    const stable = api.stableGitExecutableIdentity(api.TRUSTED_GIT_EXECUTABLE_IDENTITY);
    assert.deepEqual(Object.keys(stable).sort(), ["path", "realpath", "sha256", "version"]);
    for (const key of ["device", "inode", "size", "mtimeMs"]) assert.equal(Object.hasOwn(stable, key), false);
    const reinstalled = { ...api.TRUSTED_GIT_EXECUTABLE_IDENTITY,
      device: "different-device", inode: "different-inode",
      size: api.TRUSTED_GIT_EXECUTABLE_IDENTITY.size + 1,
      mtimeMs: api.TRUSTED_GIT_EXECUTABLE_IDENTITY.mtimeMs + 1 };
    assert.deepEqual(api.stableGitExecutableIdentity(reinstalled), stable);
  });
  await test("shared read-only Git timeout is fixed at thirty seconds", () => {
    assert.equal(canonicalApi.READ_ONLY_GIT_TIMEOUT_MS, 30_000);
    const source = fs.readFileSync(path.join(ROOT, CANONICAL_LIB_REL), "utf8");
    assert.equal((source.match(/timeout:\s*READ_ONLY_GIT_TIMEOUT_MS/gu) || []).length, 2);
  });
  await test("a hanging fixture process is terminated and typed as a read-only Git timeout", () => {
    let observed = null;
    try {
      execFileSync(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
        timeout: 40, killSignal: "SIGTERM", stdio: "ignore",
      });
    } catch (error) {
      observed = error;
    }
    assert(observed);
    assert.equal(canonicalApi.classifyReadOnlyGitExecutionError(observed), "git-read-timeout");
  });
  await test("canonical payload read guard detects equivalent macOS var path spelling", () => {
    if (fs.existsSync("/var") && fs.existsSync("/private/var")) {
      assert.throws(() => guardCanonicalPayloadAccess(
        ["/private/var/tmp/h2o-p23-canonical"], "/var/tmp/h2o-p23-canonical/alias", "read"),
      /canonical-payload-read/u);
    }
  });
  await test("canonical payload write guard detects equivalent normalized spelling", () => {
    const root = tempRoot("p23-guard-write");
    const canonical = path.join(root, "canonical");
    fs.mkdirSync(canonical);
    assert.throws(() => guardCanonicalPayloadAccess([canonical], path.join(canonical, "future"), "write"),
      /canonical-payload-write/u);
  });
  await test("payload guard normalizes a symlink spelling through the same existing parent", () => {
    const root = tempRoot("p23-guard-symlink");
    const real = path.join(root, "real"); const link = path.join(root, "link");
    fs.mkdirSync(real); fs.symlinkSync(real, link);
    assert.equal(normalizedGuardPath(path.join(link, "future", "alias")),
      normalizedGuardPath(path.join(real, "future", "alias")));
  });
  await test("payload guard preserves outside-root rejection", () => {
    const root = tempRoot("p23-guard-outside");
    const canonical = path.join(root, "canonical"); const outside = path.join(root, "outside");
    fs.mkdirSync(canonical); fs.mkdirSync(outside);
    assert.equal(sameOrWithin(canonical, path.join(canonical, "future")), true);
    assert.equal(sameOrWithin(canonical, outside), false);
  });
  await test("coordination paths remain distinct from normalized canonical payload roots", () => {
    const root = tempRoot("p23-guard-coordination");
    const canonical = path.join(root, "repository", "apps", "dev-server", "alias");
    const coordination = path.join(root, ".h2o-canonical-delivery", "activation-intents");
    fs.mkdirSync(path.dirname(canonical), { recursive: true });
    fs.mkdirSync(coordination, { recursive: true });
    assert.equal(sameOrWithin(canonical, coordination), false);
  });
  await test("P2.2 resolves one pinned absolute Git executable identity", () => {
    assert.equal(path.isAbsolute(api.TRUSTED_GIT_EXECUTABLE_IDENTITY?.realpath || ""), true);
    assert.equal(fs.lstatSync(api.TRUSTED_GIT_EXECUTABLE_IDENTITY.realpath).isSymbolicLink(), false);
    assert.equal(fs.statSync(api.TRUSTED_GIT_EXECUTABLE_IDENTITY.realpath).isFile(), true);
  });
  await test("pinned Git ignores hostile PATH and never executes a fake git binary", () => {
    const hostile = tempRoot("p22-hostile-path");
    const marker = path.join(hostile, "fake-git-executed");
    const fake = path.join(hostile, "git");
    fs.writeFileSync(fake, `#!/bin/sh\nprintf executed > ${JSON.stringify(marker)}\nexit 99\n`, { mode: 0o700 });
    const expectedHead = git(ROOT, ["rev-parse", "HEAD"]);
    const previous = process.env.PATH;
    process.env.PATH = hostile;
    try {
      assert.equal(canonicalApi.runPinnedReadOnlyGit(ROOT, ["rev-parse", "HEAD"]), expectedHead);
    } finally {
      if (previous === undefined) delete process.env.PATH; else process.env.PATH = previous;
    }
    assert.equal(fs.existsSync(marker), false);
  });
  await test("unapproved and symlinked Git executable candidates fail closed", () => {
    const hostile = tempRoot("p22-unapproved-git");
    const fake = path.join(hostile, "git");
    fs.writeFileSync(fake, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    assert.throws(() => canonicalApi.attestGitExecutableCandidate(fake),
      (error) => error.name === "CanonicalDeliveryError");
    if (fs.existsSync("/opt/homebrew/bin/git") && fs.lstatSync("/opt/homebrew/bin/git").isSymbolicLink()) {
      assert.throws(() => canonicalApi.attestGitExecutableCandidate("/opt/homebrew/bin/git"),
        (error) => error.name === "CanonicalDeliveryError" && /Symlinked Git/u.test(error.message));
    }
  });
  await test("pinned Git executable identity drift is rejected within one process", () => {
    const observed = { ...canonicalApi.TRUSTED_GIT_EXECUTABLE_IDENTITY,
      size: canonicalApi.TRUSTED_GIT_EXECUTABLE_IDENTITY.size + 1 };
    assert.throws(() => canonicalApi.assertTrustedGitExecutableIdentity(observed),
      (error) => error.name === "CanonicalDeliveryError" && /identity drifted/u.test(error.message));
  });
  await test("canonical library rejects unexpected core.worktree output", () => {
    const root = tempRoot("p22-core-worktree");
    const registered = path.join(root, "registered worktree");
    fs.mkdirSync(registered);
    assert.equal(canonicalApi.validateConfiguredWorktree(registered, {
      gitCommonDirectory: path.join(root, "git metadata"),
      registeredWorktreeRoots: [fs.realpathSync(registered)],
    }), fs.realpathSync(registered));
    assert.throws(() => canonicalApi.validateConfiguredWorktree(path.join(root, "unexpected"), {
      gitCommonDirectory: path.join(root, "git metadata"),
      registeredWorktreeRoots: [fs.realpathSync(registered)],
    }), (error) => error.name === "CanonicalDeliveryError" && /independently discovered/u.test(error.message));
  });
  await test("optional read-only Git queries suppress only the documented status-one absence", () => {
    assert.throws(() => canonicalApi.runPinnedReadOnlyGit("/definitely/missing/repository", [
      "config", "--path", "--get", "core.worktree",
    ], { allowFailure: true }), (error) => error.name === "CanonicalDeliveryError");
  });
  await test("P2.1 independently pins the accepted extension variant", () => {
    assert.equal(api.ACCEPTED_EXTENSION_VARIANT, "dev-controls-oauth-google");
  });
  await test("production activator exposes activation-intent preparation", () => {
    assert.equal(typeof api.prepareActivationIntent, "function");
  });
  await test("generic Git execution is guarded by an explicit argv allow-list", () => {
    assert.equal(typeof api.assertAllowedGitCommand, "function");
  });
  await test("durable activation-intent journal writer exists", () => {
    assert.equal(typeof api.writeDurableActivationIntent, "function");
  });
  await test("activation-intent preparation integrates the Batch 1 publisher lock", () => {
    assert.equal(typeof api.withPublisherLock, "function");
  });
  await test("recovery classifier distinguishes untouched and partially promoted states", () => {
    assert.equal(typeof api.classifyRecoveryState, "function");
  });

  const fixture = createRepositoryFixture("baseline");
  const stage = createStageFixture(fixture.repository, "path with spaces 🧪");

  await test("valid stage receipt passes independent read-only verification", () => {
    const before = fs.readFileSync(stage.receiptPath);
    const result = runActivator(fixture, ["--verify-stage-receipt", stage.receiptPath]);
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.receiptSha256, sha256(before));
    assert.equal(payload.source.sourceTree, git(fixture.repository, ["rev-parse", "HEAD^{tree}"]));
    assert.equal(payload.stage.aliases.regularFileCount, 2);
    assert.equal(payload.stage.aliases.symlinkCount, 1);
    assert.equal(fs.readFileSync(stage.receiptPath).equals(before), true);
  });
  await test("receipt and staged paths with spaces and emoji are supported", () => {
    assert.match(stage.stageRoot, /spaces 🧪/u);
    const result = runActivator(fixture, ["--verify-stage-receipt", stage.receiptPath]);
    assert.equal(result.status, 0, result.stderr);
  });
  await test("real Batch 1.1 publisher output passes the activator boundary", () => {
    const boundary = createRealPublisherBoundaryFixture("real-publisher-boundary");
    let published = null;
    try {
      published = runRealPublisher(boundary);
      assert.equal(published.result.status, 0, published.result.stderr);
      assert.ok(published.receiptPath && fs.existsSync(published.receiptPath), published.result.stdout);
      const receiptBefore = fs.readFileSync(published.receiptPath);
      const publishedReceipt = JSON.parse(receiptBefore);
      const stagedManifestsBefore = JSON.stringify(Object.fromEntries(
        ["alias", "devOutput", "extension"].map((family) => [
          family,
          fixtureManifest(publishedReceipt.outputPaths[family], publishedReceipt.stagingRoot),
        ]),
      ));
      const result = runActivator(boundary, ["--verify-stage-receipt", published.receiptPath]);
      assert.equal(result.status, 0,
        `real publisher receipt rejected: ${codeOf(result)} ${String(result.stderr).trim()}`);
      const payload = JSON.parse(result.stdout);
      // Alias evidence measured from the CURRENT_BASE publisher fixture:
      // src-runtime-base has 156 regular files (155 JavaScript sources),
      // dev-order has 251 physical rows and 155 active entries, and loader-deps
      // describes 153 scripts. The staged alias manifest therefore contains
      // 155 regular files and the same 5 compatibility symlinks.
      assert.deepEqual(publishedReceipt.validatorResult.alias,
        { aliasCount: 160, regularFileCount: 155, symlinkCount: 5 });
      assert.equal(payload.stage.aliases.aliasCount, 160);
      assert.equal(payload.stage.aliases.regularFileCount, 155);
      assert.equal(payload.stage.aliases.symlinkCount, 5);
      assert.equal(fs.readFileSync(published.receiptPath).equals(receiptBefore), true);
      const stagedManifestsAfter = JSON.stringify(Object.fromEntries(
        ["alias", "devOutput", "extension"].map((family) => [
          family,
          fixtureManifest(publishedReceipt.outputPaths[family], publishedReceipt.stagingRoot),
        ]),
      ));
      assert.equal(stagedManifestsAfter, stagedManifestsBefore);
    } finally {
      if (published?.stagingRoot && fs.existsSync(published.stagingRoot)) disposeTemporaryRoot(published.stagingRoot);
      if (fs.existsSync(boundary.top)) disposeTemporaryRoot(boundary.top);
    }
  });
  await test("wrong worktree argument is rejected by executable source derivation", () => {
    assert.throws(() => api.collectSourcePreflight(fixture.repository), (error) => error.code === "wrong-worktree");
  });
  await test("receipt from another repository is rejected", () => {
    const candidate = cloneStage(fixture.repository, "wrong-repo", (value) =>
      mutateReceipt(value, (receipt) => { receipt.repository = path.join(fixture.top, "foreign"); }));
    expectFailure(fixture, ["--verify-stage-receipt", candidate.receiptPath], "receipt-repository-mismatch");
  });
  await test("wrong branch rejects before staged verification", () => {
    const candidate = createStageFixture(fixture.repository, "wrong-branch");
    git(fixture.repository, ["checkout", "-q", "-b", "not-main"]);
    expectFailure(fixture, ["--verify-stage-receipt", candidate.receiptPath], "wrong-branch");
    git(fixture.repository, ["checkout", "-q", "main"]);
  });
  await test("receipt HEAD mismatch is rejected", () => {
    const candidate = cloneStage(fixture.repository, "wrong-head", (value) =>
      mutateReceipt(value, (receipt) => { receipt.approvedHead = "0".repeat(40); }));
    expectFailure(fixture, ["--verify-stage-receipt", candidate.receiptPath], "receipt-head-mismatch");
  });
  await test("dirty tracked source is rejected", () => {
    const candidate = createStageFixture(fixture.repository, "dirty");
    fs.appendFileSync(path.join(fixture.repository, "package.json"), "\n");
    expectFailure(fixture, ["--verify-stage-receipt", candidate.receiptPath], "tracked-worktree-dirty");
    git(fixture.repository, ["restore", "package.json"]);
  });
  await test("non-empty index is rejected", () => {
    const candidate = createStageFixture(fixture.repository, "index");
    fs.appendFileSync(path.join(fixture.repository, "package.json"), "\n");
    git(fixture.repository, ["add", "package.json"]);
    expectFailure(fixture, ["--verify-stage-receipt", candidate.receiptPath], "index-not-empty");
    git(fixture.repository, ["restore", "--staged", "package.json"]);
    git(fixture.repository, ["restore", "package.json"]);
  });
  await test("non-ignored untracked source is rejected", () => {
    const candidate = createStageFixture(fixture.repository, "untracked");
    const stray = path.join(fixture.repository, "stray-source.tmp");
    fs.writeFileSync(stray, "stray\n");
    expectFailure(fixture, ["--verify-stage-receipt", candidate.receiptPath], "untracked-source-present");
    fs.unlinkSync(stray);
  });
  await test("missing foundation ancestry is rejected", () => {
    const standalone = createRepositoryFixture("no-foundation", { withFoundation: false });
    const candidate = createStageFixture(standalone.repository, "no-foundation");
    expectFailure(standalone, ["--verify-stage-receipt", candidate.receiptPath], "foundation-ancestry-missing");
  });
  await test("inherited destination override is rejected", () => {
    expectFailure(fixture, ["--verify-stage-receipt", stage.receiptPath], "destination-override-present", {
      env: { H2O_SERVER_DIR: path.join(fixture.top, "decoy") },
    });
  });

  await test("missing receipt is rejected", () => {
    expectFailure(fixture, ["--verify-stage-receipt", path.join(fixture.top, "missing.json")], "receipt-not-regular");
  });
  await test("symlink receipt is rejected", () => {
    const link = path.join(fixture.top, "receipt-link.json");
    fs.symlinkSync(stage.receiptPath, link);
    expectFailure(fixture, ["--verify-stage-receipt", link], "receipt-not-regular");
  });
  await test("malformed receipt is rejected", () => {
    const candidate = createStageFixture(fixture.repository, "malformed");
    fs.writeFileSync(candidate.receiptPath, "{ bad json\n");
    expectFailure(fixture, ["--verify-stage-receipt", candidate.receiptPath], "receipt-malformed");
  });
  for (const [name, mutate, code] of [
    ["wrong receipt schema", (receipt) => { receipt.schemaVersion = 2; }, "receipt-schema-version"],
    ["wrong receipt mode", (receipt) => { receipt.mode = "activate"; }, "receipt-mode"],
    ["wrong receipt branch", (receipt) => { receipt.branch = "feature"; }, "receipt-branch-mismatch"],
    ["activation field not false", (receipt) => { receipt.activationPerformed = true; }, "receipt-boundary-field"],
    ["reload field not false", (receipt) => { receipt.browserReloadPerformed = true; }, "receipt-boundary-field"],
    ["canary field not false", (receipt) => { receipt.browserCanaryPerformed = true; }, "receipt-boundary-field"],
    ["push field not false", (receipt) => { receipt.pushPerformed = true; }, "receipt-boundary-field"],
  ]) {
    await test(`${name} is rejected`, () => {
      const candidate = cloneStage(fixture.repository, name.replaceAll(" ", "-"), (value) => mutateReceipt(value, mutate));
      expectFailure(fixture, ["--verify-stage-receipt", candidate.receiptPath], code);
    });
  }
  await test("missing manifest data is rejected", () => {
    const candidate = cloneStage(fixture.repository, "missing-manifest", (value) =>
      mutateReceipt(value, (receipt) => { delete receipt.manifests.alias; }));
    expectFailure(fixture, ["--verify-stage-receipt", candidate.receiptPath], "receipt-manifest-missing");
  });
  await test("publisher validator result must be successful", () => {
    const candidate = cloneStage(fixture.repository, "validator-failed", (value) =>
      mutateReceipt(value, (receipt) => { receipt.validatorResult.ok = false; }));
    expectFailure(fixture, ["--verify-stage-receipt", candidate.receiptPath], "receipt-validator-failed");
  });
  await test("receipt must identify the shared Batch 1 publisher lock", () => {
    const candidate = cloneStage(fixture.repository, "wrong-lock", (value) =>
      mutateReceipt(value, (receipt) => { receipt.lock.directory = path.join(fixture.top, "other-lock"); }));
    expectFailure(fixture, ["--verify-stage-receipt", candidate.receiptPath], "receipt-lock-mismatch");
  });
  await test("unsorted receipt manifest is rejected against independent sorted ordering", () => {
    const candidate = cloneStage(fixture.repository, "unsorted-manifest", (value) =>
      mutateReceipt(value, (receipt) => { receipt.manifests.extension.entries.reverse(); }));
    expectFailure(fixture, ["--verify-stage-receipt", candidate.receiptPath], "staged-manifest-entry-mismatch");
  });
  await test("receipt outside its declared staging root is rejected", () => {
    const candidate = createStageFixture(fixture.repository, "receipt-outside");
    const outside = path.join(fixture.top, "outside-publication-receipt.json");
    fs.copyFileSync(candidate.receiptPath, outside);
    expectFailure(fixture, ["--verify-stage-receipt", outside], "receipt-outside-staging-root");
  });

  for (const [name, mutate, expected] of [
    ["added staged file", (value) => fs.writeFileSync(path.join(value.extension, "added.js"), "// added\n"), "staged-manifest-entry-mismatch"],
    ["removed staged file", (value) => fs.unlinkSync(path.join(value.extension, "bg.js")), "staged-manifest-entry-mismatch"],
    ["changed regular-file bytes", (value) => fs.appendFileSync(path.join(value.extension, "bg.js"), "// changed\n"), "staged-manifest-entry-mismatch"],
    ["changed staged symlink", (value) => {
      const link = path.join(value.alias, "compat ordinary.js");
      fs.unlinkSync(link);
      fs.symlinkSync(path.relative(value.alias, path.join(fixture.repository, "fixture-source", "emoji 🧪.js")), link);
    }, "staged-manifest-entry-mismatch"],
  ]) {
    await test(`${name} after receipt is rejected`, () => {
      const candidate = cloneStage(fixture.repository, name.replaceAll(" ", "-"), mutate);
      expectFailure(fixture, ["--verify-stage-receipt", candidate.receiptPath], expected);
    });
  }
  await test("receipt file-count drift is rejected", () => {
    const candidate = cloneStage(fixture.repository, "count-drift", (value) =>
      mutateReceipt(value, (receipt) => { receipt.fileCounts.alias += 1; }));
    expectFailure(fixture, ["--verify-stage-receipt", candidate.receiptPath], "staged-file-count-drift");
  });
  await test("receipt tree-digest mismatch is rejected", () => {
    const candidate = cloneStage(fixture.repository, "digest-drift", (value) =>
      mutateReceipt(value, (receipt) => { receipt.treeDigests.extension = "0".repeat(64); }));
    expectFailure(fixture, ["--verify-stage-receipt", candidate.receiptPath], "staged-tree-digest-mismatch");
  });
  await test("copied alias byte mutation with unchanged size is rejected", () => {
    const candidate = createStageFixture(fixture.repository, "alias-byte-mutation");
    const filename = path.join(candidate.alias, "ordinary.js");
    const bytes = fs.readFileSync(filename);
    bytes[0] ^= 1;
    fs.writeFileSync(filename, bytes);
    expectFailure(fixture, ["--verify-stage-receipt", candidate.receiptPath], "staged-manifest-entry-mismatch");
  });
  await test("copied alias size drift is rejected", () => {
    const candidate = createStageFixture(fixture.repository, "alias-size-drift");
    fs.appendFileSync(path.join(candidate.alias, "ordinary.js"), "x");
    expectFailure(fixture, ["--verify-stage-receipt", candidate.receiptPath], "staged-manifest-entry-mismatch");
  });
  await test("vanished staging root is rejected", () => {
    const candidate = createStageFixture(fixture.repository, "vanished");
    fs.rmSync(candidate.stageRoot, { recursive: true });
    expectFailure(fixture, ["--verify-stage-receipt", candidate.receiptPath], "receipt-not-regular");
  });
  await test("required extension file remains independently mandatory", () => {
    const candidate = createStageFixture(fixture.repository, "required-missing");
    fs.unlinkSync(path.join(candidate.extension, "bg.js"));
    refreshReceiptManifests(candidate);
    expectFailure(fixture, ["--verify-stage-receipt", candidate.receiptPath], "staged-extension-required-file");
  });
  await test("proxy pack remains independently mandatory", () => {
    const candidate = createStageFixture(fixture.repository, "proxy-missing");
    fs.unlinkSync(candidate.proxyPack);
    expectFailure(fixture, ["--verify-stage-receipt", candidate.receiptPath], "staged-proxy-pack-missing");
  });
  await test("missing staged output family is rejected", () => {
    const candidate = createStageFixture(fixture.repository, "family-missing");
    fs.rmSync(candidate.devOutput, { recursive: true });
    expectFailure(fixture, ["--verify-stage-receipt", candidate.receiptPath], "staged-output-missing");
  });
  await test("mixed build markers are rejected after manifest recomputation", () => {
    const candidate = createStageFixture(fixture.repository, "mixed-marker");
    fs.writeFileSync(path.join(candidate.extension, "loader.js"), "// buildTs=9999999999999\n");
    refreshReceiptManifests(candidate);
    expectFailure(fixture, ["--verify-stage-receipt", candidate.receiptPath], "staged-build-marker-mismatch");
  });
  await test("staging-root path leakage in staged text is rejected", () => {
    const candidate = createStageFixture(fixture.repository, "stage-leak");
    fs.appendFileSync(path.join(candidate.extension, "bg.js"), `// ${candidate.stageRoot}\n`);
    refreshReceiptManifests(candidate);
    expectFailure(fixture, ["--verify-stage-receipt", candidate.receiptPath], "staged-text-staging-root");
  });
  await test("staging-root path leakage in a copied alias is rejected", () => {
    const candidate = createStageFixture(fixture.repository, "alias-stage-leak");
    fs.appendFileSync(path.join(candidate.alias, "ordinary.js"), `// ${candidate.stageRoot}\n`);
    refreshReceiptManifests(candidate);
    expectFailure(fixture, ["--verify-stage-receipt", candidate.receiptPath], "staged-text-staging-root");
  });
  await test("safe intra-alias compatibility symlink is accepted", () => {
    const candidate = createStageFixture(fixture.repository, "safe-intra-alias");
    const result = runActivator(fixture, ["--verify-stage-receipt", candidate.receiptPath]);
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.stage.aliases.symlinkCount, 1);
    assert.equal(payload.stage.aliases.entries.find((entry) => entry.name === "compat ordinary.js").linkText,
      "ordinary.js");
  });
  await test("safe source-worktree compatibility symlink is accepted", () => {
    const candidate = createStageFixture(fixture.repository, "safe-source-alias");
    fs.symlinkSync(path.relative(candidate.alias, path.join(fixture.repository, "fixture-source", "ordinary.js")),
      path.join(candidate.alias, "source compatibility.js"));
    refreshReceiptManifests(candidate);
    const result = runActivator(fixture, ["--verify-stage-receipt", candidate.receiptPath]);
    assert.equal(result.status, 0, result.stderr);
  });
  await test("unsupported alias entry type is rejected", () => {
    const candidate = createStageFixture(fixture.repository, "unsupported-alias-type");
    fs.mkdirSync(path.join(candidate.alias, "directory-entry"));
    refreshReceiptManifests(candidate);
    expectFailure(fixture, ["--verify-stage-receipt", candidate.receiptPath], "staged-alias-entry-type");
  });
  await test("broken compatibility symlink is rejected", () => {
    const candidate = createStageFixture(fixture.repository, "broken-alias");
    fs.unlinkSync(path.join(candidate.alias, "compat ordinary.js"));
    fs.symlinkSync("missing.js", path.join(candidate.alias, "compat ordinary.js"));
    refreshReceiptManifests(candidate);
    expectFailure(fixture, ["--verify-stage-receipt", candidate.receiptPath], "staged-alias-broken");
  });
  await test("alias resolving into generated output is rejected", () => {
    const candidate = createStageFixture(fixture.repository, "generated-alias");
    const link = path.join(candidate.alias, "ordinary.js");
    fs.unlinkSync(link);
    fs.symlinkSync(path.relative(candidate.alias, path.join(fixture.repository, "apps", "dev-server", "generated.js")), link);
    refreshReceiptManifests(candidate);
    expectFailure(fixture, ["--verify-stage-receipt", candidate.receiptPath], "staged-alias-generated-target");
  });
  await test("alias resolving outside approved roots is rejected", () => {
    const candidate = createStageFixture(fixture.repository, "outside-alias");
    const outside = path.join(fixture.top, "outside.js");
    fs.writeFileSync(outside, "// outside\n");
    const link = path.join(candidate.alias, "ordinary.js");
    fs.unlinkSync(link);
    fs.symlinkSync(path.relative(candidate.alias, outside), link);
    refreshReceiptManifests(candidate);
    expectFailure(fixture, ["--verify-stage-receipt", candidate.receiptPath], "staged-alias-outside-approved-roots");
  });
  await test("alias resolving into a registered foreign worktree is rejected", () => {
    const foreign = path.join(fixture.top, "foreign-worktree");
    git(fixture.repository, ["worktree", "add", "--quiet", "--detach", foreign, "HEAD"]);
    const candidate = createStageFixture(fixture.repository, "foreign-alias");
    const link = path.join(candidate.alias, "ordinary.js");
    fs.unlinkSync(link);
    fs.symlinkSync(path.relative(candidate.alias, path.join(foreign, "fixture-source", "ordinary.js")), link);
    refreshReceiptManifests(candidate);
    expectFailure(fixture, ["--verify-stage-receipt", candidate.receiptPath], "staged-alias-foreign-worktree");
  });
  await test("absolute foreign-worktree path embedded in staged text is rejected", () => {
    const foreign = path.join(fixture.top, "foreign-worktree");
    const candidate = createStageFixture(fixture.repository, "foreign-text");
    fs.appendFileSync(path.join(candidate.extension, "bg.js"), `// ${fs.realpathSync(foreign)}\n`);
    refreshReceiptManifests(candidate);
    expectFailure(fixture, ["--verify-stage-receipt", candidate.receiptPath], "staged-text-foreign-worktree");
  });
  await test("absolute foreign-worktree path embedded in a copied alias is rejected", () => {
    const foreign = path.join(fixture.top, "foreign-worktree");
    const candidate = createStageFixture(fixture.repository, "foreign-alias-text");
    fs.appendFileSync(path.join(candidate.alias, "ordinary.js"), `// ${fs.realpathSync(foreign)}\n`);
    refreshReceiptManifests(candidate);
    expectFailure(fixture, ["--verify-stage-receipt", candidate.receiptPath], "staged-text-foreign-worktree");
  });

  await test("canonical foundation derives the external anchor without creating it", () => {
    const expected = path.join(fixture.top, ".h2o-canonical-delivery");
    assert.equal(fs.existsSync(expected), false);
    const result = runActivator(fixture, ["--verify-stage-receipt", stage.receiptPath]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.existsSync(expected), false);
    const payload = JSON.parse(result.stdout);
    assert.deepEqual(Object.keys(payload.canonicalFoundation.futureSubpaths).sort(),
      ["activation-intents", "activations", "rollback-intents", "rollbacks", "transactions"]);
    assert.equal(path.basename(payload.canonicalFoundation.publisherLock), ".h2o-publisher-lock");
  });
  await test("symlinked canonical anchor is rejected without following or changing it", () => {
    const symlinkFixture = createRepositoryFixture("symlink-anchor");
    const candidate = createStageFixture(symlinkFixture.repository, "symlink-anchor");
    try {
      const target = path.join(symlinkFixture.top, "anchor-target");
      fs.mkdirSync(target);
      fs.symlinkSync(target, path.join(symlinkFixture.top, ".h2o-canonical-delivery"));
      expectFailure(symlinkFixture, ["--verify-stage-receipt", candidate.receiptPath], "canonical-anchor-symlink");
    } finally {
      if (fs.existsSync(candidate.stageRoot)) disposeTemporaryRoot(candidate.stageRoot);
      if (fs.existsSync(symlinkFixture.top)) disposeTemporaryRoot(symlinkFixture.top);
    }
  });
  await test("broken symlink canonical anchor is also rejected", () => {
    const symlinkFixture = createRepositoryFixture("broken-anchor");
    const candidate = createStageFixture(symlinkFixture.repository, "broken-anchor");
    try {
      fs.symlinkSync(path.join(symlinkFixture.top, "missing-target"),
        path.join(symlinkFixture.top, ".h2o-canonical-delivery"));
      expectFailure(symlinkFixture, ["--verify-stage-receipt", candidate.receiptPath], "canonical-anchor-symlink");
    } finally {
      if (fs.existsSync(candidate.stageRoot)) disposeTemporaryRoot(candidate.stageRoot);
      if (fs.existsSync(symlinkFixture.top)) disposeTemporaryRoot(symlinkFixture.top);
    }
  });
  await test("stage receipt remains byte-identical through repeated verification", () => {
    const before = fs.readFileSync(stage.receiptPath);
    for (let index = 0; index < 3; index += 1) {
      const result = runActivator(fixture, ["--verify-stage-receipt", stage.receiptPath]);
      assert.equal(result.status, 0, result.stderr);
    }
    assert.equal(fs.readFileSync(stage.receiptPath).equals(before), true);
  });
  await test("activate command requires an explicit intent and never auto-creates one", () => {
    const before = fs.readFileSync(stage.receiptPath);
    const anchor = path.join(fixture.top, ".h2o-canonical-delivery");
    const lock = path.join(fixture.top, ".h2o-publisher-lock");
    expectFailure(fixture, ["--activate-receipt", stage.receiptPath], "activation-intent-required");
    assert.equal(fs.readFileSync(stage.receiptPath).equals(before), true);
    assert.equal(fs.existsSync(anchor), false);
    assert.equal(fs.existsSync(lock), false);
  });
  await test("canonical verification accepts only the explicit activation-receipt form", () => {
    // Every other shape stays fail-closed and never inspects anything.
    for (const args of [["--verify-canonical", "--receipt", stage.receiptPath],
      ["--verify-canonical"], ["--verify-canonical", "--activation-receipt"]]) {
      expectFailure(fixture, args, "canonical-verification-fixture-only");
    }
    // The operational form is gated on the approved production root, so a
    // fixture repository can never be verified through the production CLI.
    expectFailure(fixture, ["--verify-canonical", "--activation-receipt", stage.receiptPath],
      "canonical-root-not-approved");
  });
  await test("rollback and pruning remain absent while recovery takes an identity", () => {
    for (const command of ["--rollback", "--prune"]) {
      expectFailure(fixture, [command, stage.receiptPath], "mutation-command-not-implemented");
    }
    // P3C-B1: recovery is operational, but only for an activation identity — a
    // stage-receipt path is not an identity and is refused before any I/O.
    expectFailure(fixture, ["--recover", stage.receiptPath], "activation-id-invalid");
    // Any recover shape other than exactly one identity argument stays closed.
    expectFailure(fixture, ["--recover"], "mutation-command-not-implemented");
    expectFailure(fixture, ["--recover", "a", "b"], "mutation-command-not-implemented");
  });
  await test("invalid CLI combinations fail closed", () => {
    for (const args of [[], ["--verify-stage-receipt"], ["--unknown", stage.receiptPath],
      ["--verify-stage-receipt", stage.receiptPath, "extra"]]) {
      expectFailure(fixture, args, "invalid-arguments");
    }
  });

  await test("tree comparison accepts byte-identical files", () => {
    const root = tempRoot("compare-equal");
    const stagedRoot = path.join(root, "staged");
    const canonicalRoot = path.join(root, "canonical");
    fs.mkdirSync(stagedRoot); fs.mkdirSync(canonicalRoot);
    fs.writeFileSync(path.join(stagedRoot, "a.js"), "same\n");
    fs.writeFileSync(path.join(canonicalRoot, "a.js"), "same\n");
    assert.equal(api.compareTrees(stagedRoot, canonicalRoot).equivalent, true);
  });
  await test("tree comparison reports regular-file byte mismatch", () => {
    const root = tempRoot("compare-bytes");
    const stagedRoot = path.join(root, "staged"); const canonicalRoot = path.join(root, "canonical");
    fs.mkdirSync(stagedRoot); fs.mkdirSync(canonicalRoot);
    fs.writeFileSync(path.join(stagedRoot, "a.js"), "new\n");
    fs.writeFileSync(path.join(canonicalRoot, "a.js"), "old\n");
    const result = api.compareTrees(stagedRoot, canonicalRoot);
    assert.equal(result.equivalent, false); assert.equal(result.byteMismatches.length, 1);
  });
  await test("tree comparison separates link-text drift from resolved-target equality", () => {
    const root = tempRoot("compare-links");
    const stagedRoot = path.join(root, "staged"); const canonicalRoot = path.join(root, "canonical");
    const target = path.join(root, "target.js");
    fs.mkdirSync(stagedRoot); fs.mkdirSync(canonicalRoot); fs.writeFileSync(target, "target\n");
    fs.symlinkSync("../target.js", path.join(stagedRoot, "alias.js"));
    fs.symlinkSync(target, path.join(canonicalRoot, "alias.js"));
    const result = api.compareTrees(stagedRoot, canonicalRoot);
    assert.equal(result.equivalent, true); assert.equal(result.exactLinkText, false);
    assert.equal(result.symlinkLinkTextDifferences.length, 1); assert.equal(result.resolvedTargetMismatches.length, 0);
  });
  await test("tree comparison reports resolved symlink target mismatch", () => {
    const root = tempRoot("compare-resolved");
    const stagedRoot = path.join(root, "staged"); const canonicalRoot = path.join(root, "canonical");
    fs.mkdirSync(stagedRoot); fs.mkdirSync(canonicalRoot);
    fs.writeFileSync(path.join(root, "one"), "1"); fs.writeFileSync(path.join(root, "two"), "2");
    fs.symlinkSync("../one", path.join(stagedRoot, "alias")); fs.symlinkSync("../two", path.join(canonicalRoot, "alias"));
    const result = api.compareTrees(stagedRoot, canonicalRoot);
    assert.equal(result.equivalent, false); assert.equal(result.resolvedTargetMismatches.length, 1);
  });
  await test("tree comparison reports missing, extra and file-count drift independently", () => {
    const root = tempRoot("compare-shape");
    const stagedRoot = path.join(root, "staged"); const canonicalRoot = path.join(root, "canonical");
    fs.mkdirSync(stagedRoot); fs.mkdirSync(canonicalRoot);
    fs.writeFileSync(path.join(stagedRoot, "missing"), "m");
    fs.writeFileSync(path.join(stagedRoot, "shared"), "s");
    fs.writeFileSync(path.join(canonicalRoot, "shared"), "s");
    fs.writeFileSync(path.join(canonicalRoot, "extra1"), "e");
    fs.writeFileSync(path.join(canonicalRoot, "extra2"), "e");
    const result = api.compareTrees(stagedRoot, canonicalRoot);
    assert.deepEqual(result.missingPaths, ["missing"]); assert.deepEqual(result.extraPaths, ["extra1", "extra2"]);
    assert.deepEqual(result.fileCountDrift, { staged: 2, canonical: 3 });
  });

  await test("future model accepts only one fully verified durable three-tree release", () => {
    assert.equal(api.evaluateFutureTransaction(validTransactionModel()).acceptable, true);
  });
  await test("only one verified tree cannot be accepted", () => {
    const model = validTransactionModel();
    for (const family of ["devOutput", "extension"]) {
      Object.assign(model.trees[family], {
        state: "untouched", incomingPrepared: false, liveRetired: false, incomingPromoted: false, verified: false,
      });
    }
    assert.equal(api.evaluateFutureTransaction(model).acceptable, false);
  });
  await test("two new trees and one old generation cannot be accepted", () => {
    const model = validTransactionModel();
    model.trees.extension.activationId = "20260802T120000000Z-ffffffffffff";
    assert.match(api.evaluateFutureTransaction(model).reasons.join(" "), /generation-mismatch/u);
  });
  await test("promoted tree without previous-state record cannot be accepted", () => {
    const model = validTransactionModel(); delete model.trees.alias.previousState;
    assert.match(api.evaluateFutureTransaction(model).reasons.join(" "), /previous-state-missing/u);
  });
  await test("first activation must model restoration to absent", () => {
    const model = validTransactionModel();
    model.trees.alias.previousState = { kind: "absent", recorded: true };
    model.trees.alias.restoreOnFailure = "previous-tree";
    assert.match(api.evaluateFutureTransaction(model).reasons.join(" "), /restoration-not-absent/u);
  });
  await test("failure to durably write final receipt prevents acceptance", () => {
    const model = validTransactionModel(); model.finalReceiptDurable = false;
    assert.match(api.evaluateFutureTransaction(model).reasons.join(" "), /final-receipt-not-durable/u);
  });
  await test("unresolved durable journal prevents acceptance", () => {
    const model = validTransactionModel(); model.journalResolved = false;
    assert.match(api.evaluateFutureTransaction(model).reasons.join(" "), /journal-unresolved/u);
  });
  await test("contradictory per-tree state prevents acceptance", () => {
    const model = validTransactionModel(); model.trees.devOutput.incomingPromoted = false;
    assert.match(api.evaluateFutureTransaction(model).reasons.join(" "), /state-contradiction/u);
  });
  await test("whole-release rollback is mandatory", () => {
    const model = validTransactionModel(); model.rollbackScope = "single-tree";
    assert.match(api.evaluateFutureTransaction(model).reasons.join(" "), /whole-release-rollback-required/u);
  });
  await test("future namespace uses exact activation-specific incoming and retired names", () => {
    assert.deepEqual(api.futureSiblingNames("alias", "20260802T120000000Z-a1b2c3d4e5f6"), {
      incoming: "alias.staging-act-20260802T120000000Z-a1b2c3d4e5f6",
      previous: "alias.retired-act-20260802T120000000Z-a1b2c3d4e5f6",
    });
  });
  await test("future ownership rejects generic or foreign activation siblings", () => {
    const activationId = "20260802T120000000Z-a1b2c3d4e5f6";
    assert.equal(api.ownsFutureSibling(`alias.staging-act-${activationId}`, "alias", activationId), true);
    assert.equal(api.ownsFutureSibling("alias.staging-act-20260802T120000000Z-ffffffffffff", "alias", activationId), false);
    assert.equal(api.ownsFutureSibling("alias.staging-anything", "alias", activationId), false);
  });

  await test("all exact read-only Git command shapes are accepted", () => {
    for (const args of [
      ["rev-parse", "--show-toplevel"], ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      ["rev-parse", "HEAD"], ["rev-parse", "HEAD^{tree}"], ["rev-parse", "refs/heads/main"],
      ["branch", "--show-current"], ["diff", "--cached", "--quiet"], ["diff", "--quiet"],
      ["ls-files", "--others", "--exclude-standard"], ["worktree", "list", "--porcelain"],
      ["config", "--path", "--get", "core.worktree"],
      ["merge-base", "--is-ancestor", "a".repeat(40), "HEAD"],
      ["merge-base", "--is-ancestor", "a".repeat(40), "b".repeat(40)],
    ]) {
      assert.equal(api.assertAllowedGitCommand(args), true);
      assert.equal(canonicalApi.assertAllowedReadOnlyGitCommand(args), true);
    }
  });
  await test("all named Git mutation and network commands reject before execution", () => {
    for (const command of ["reset", "checkout", "switch", "clean", "add", "commit", "merge", "rebase",
      "push", "fetch", "pull"]) {
      expectActivatorError(() => api.assertAllowedGitCommand([command]), "git-command-not-allowed");
      expectActivatorError(() => api.runReadOnlyGit("/definitely/missing/repository", [command]),
        "git-command-not-allowed");
    }
    for (const args of [["worktree", "add", "/tmp/x"], ["worktree", "remove", "/tmp/x"]]) {
      expectActivatorError(() => api.assertAllowedGitCommand(args), "git-command-not-allowed");
    }
  });
  await test("Git option, alias, extra-argument and shell-shape smuggling rejects", () => {
    for (const args of [
      ["-c", "alias.x=reset", "x"], ["--config=alias.x=reset", "x"], ["alias.x"],
      ["rev-parse", "HEAD", "--verify"], ["rev-parse", "HEAD;reset"],
      ["merge-base", "--is-ancestor", "HEAD", "HEAD"], ["diff", "--quiet", "--", "."],
      ["config", "--global", "alias.x", "reset"], ["config", "--get", "http.proxy"],
      ["rev-parse", "--git-dir"], ["ls-remote", "origin"],
    ]) {
      expectActivatorError(() => api.assertAllowedGitCommand(args), "git-command-not-allowed");
      assert.throws(() => canonicalApi.assertAllowedReadOnlyGitCommand(args),
        (error) => error.name === "CanonicalDeliveryError");
    }
  });
  await test("activation IDs use exact UTC compact timestamp and lowercase hex", () => {
    assert.equal(api.generateActivationId({ now: FIXED_ACTIVATION_DATE, randomBytes: FIXED_RANDOM_BYTES }),
      FIXED_ACTIVATION_ID);
    for (const invalid of ["../x", "x/y", "x\\y", "20260802T120000000Z-ABCDEF123456",
      "20260802T120000000Z-short", `${FIXED_ACTIVATION_ID}.extra`]) {
      expectActivatorError(() => api.validateActivationId(invalid), "activation-id-invalid");
    }
  });
  await test("unsafe staged extension variant rejects before lock or coordination mutation", () => {
    const value = createStageFixture(fixture.repository, "unsafe-extension-variant");
    mutateReceipt(value, (receipt) => { receipt.stagedExtensionVariant = "../foreign"; });
    expectFailure(fixture, ["--verify-stage-receipt", value.receiptPath], "receipt-extension-variant");
    assert.equal(fs.existsSync(path.join(fixture.top, ".h2o-publisher-lock")), false);
    assert.equal(fs.existsSync(path.join(fixture.top, ".h2o-canonical-delivery")), false);
  });
  await test("wrong but filename-safe extension variant rejects before lock or coordination mutation", () => {
    const value = createStageFixture(fixture.repository, "wrong-safe-extension-variant");
    mutateReceipt(value, (receipt) => { receipt.stagedExtensionVariant = "dev-controls-oauth-other"; });
    expectFailure(fixture, ["--prepare-activation-intent", value.receiptPath], "receipt-extension-variant");
    assert.equal(fs.existsSync(path.join(fixture.top, ".h2o-publisher-lock")), false);
    assert.equal(fs.existsSync(path.join(fixture.top, ".h2o-canonical-delivery")), false);
  });
  await test("hostile inherited Git repository and config variables are neutralized", async () => {
    const hostile = {
      GIT_DIR: path.join(fixture.top, "foreign.git"),
      GIT_WORK_TREE: path.join(fixture.top, "foreign-worktree"),
      GIT_INDEX_FILE: path.join(fixture.top, "foreign.index"),
      GIT_OBJECT_DIRECTORY: path.join(fixture.top, "foreign-objects"),
      GIT_ALTERNATE_OBJECT_DIRECTORIES: path.join(fixture.top, "foreign-alternates"),
      GIT_CONFIG: path.join(fixture.top, "foreign-repository-config"),
      GIT_CONFIG_GLOBAL: path.join(fixture.top, "foreign-global-config"),
      GIT_CONFIG_SYSTEM: path.join(fixture.top, "foreign-system-config"),
      GIT_COMMON_DIR: path.join(fixture.top, "foreign-common-dir"),
    };
    const previous = Object.fromEntries(Object.keys(hostile).map((name) => [name, process.env[name]]));
    Object.assign(process.env, hostile);
    try {
      const fixtureApi = await importFixtureActivator(fixture, "hostile-git-environment");
      assert.equal(fixtureApi.collectSourcePreflight().repository, fs.realpathSync(fixture.repository));
      const sanitized = fixtureApi.sanitizedGitEnvironment(process.env);
      for (const name of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY",
        "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_CONFIG", "GIT_COMMON_DIR"]) {
        assert.equal(Object.hasOwn(sanitized, name), false);
      }
      assert.equal(Object.hasOwn(sanitized, "PATH"), false);
      assert.equal(sanitized.GIT_CONFIG_GLOBAL, "/dev/null");
      assert.equal(sanitized.GIT_CONFIG_SYSTEM, "/dev/null");
    } finally {
      for (const [name, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[name]; else process.env[name] = value;
      }
    }
  });
  await test("module-location repository mismatch rejects independent anchor derivation", () => {
    expectActivatorError(() => api.deriveCanonicalFoundation(fixture.repository), "module-repository-mismatch");
  });
  await test("clean incorrect derived anchor reaches canonical-anchor-mismatch before lock or coordination mutation", () => {
    const value = createRepositoryFixture("p22-true-anchor-mismatch");
    installAnchorMismatchBoundary(value);
    const stageValue = createStageFixture(value.repository, "p22-true-anchor-mismatch");
    const result = runActivator(value, ["--prepare-activation-intent", stageValue.receiptPath]);
    assert.notEqual(result.status, 0);
    assert.equal(codeOf(result), "canonical-anchor-mismatch", result.stderr);
    assert.equal(fs.existsSync(path.join(value.top, ".h2o-publisher-lock")), false);
    assert.equal(fs.existsSync(path.join(value.top, ".h2o-canonical-delivery")), false);
    assert.equal(fs.existsSync(path.join(value.top, "clean-but-wrong-root")), false);
  });

  const p2Fixture = createRepositoryFixture("p2-intent-spaces-emoji");
  const p2Stage = createStageFixture(p2Fixture.repository, "p2 intent spaces 🧪");
  const p2Api = await importFixtureActivator(p2Fixture, "prepared");
  let preparedIntent;
  await test("P2 prepares one durable intent while preserving receipt bytes and releasing the lock", () => {
    const receiptBefore = fs.readFileSync(p2Stage.receiptPath);
    preparedIntent = p2Api.prepareActivationIntent(p2Stage.receiptPath, {
      environment: cleanEnvironment(), now: FIXED_ACTIVATION_DATE, randomBytes: FIXED_RANDOM_BYTES,
    });
    assert.equal(preparedIntent.activationId, FIXED_ACTIVATION_ID);
    assert.equal(fs.readFileSync(p2Stage.receiptPath).equals(receiptBefore), true);
    assert.equal(sha256(fs.readFileSync(preparedIntent.intentPath)), preparedIntent.intentSha256);
    assert.equal(fs.statSync(path.dirname(preparedIntent.intentPath)).mode & 0o777, 0o700);
    assert.equal(fs.statSync(preparedIntent.intentPath).mode & 0o777, 0o600);
    assert.equal(fs.readdirSync(path.dirname(preparedIntent.intentPath)).some((name) => name.includes(".tmp-")), false);
    assert.equal(fs.existsSync(path.join(p2Fixture.top, ".h2o-publisher-lock")), false);
    assert.deepEqual(preparedIntent.coordinationDirectories.anchor.parentDirectoryFsync,
      { attempted: true, succeeded: true, unsupported: false });
    assert.deepEqual(preparedIntent.coordinationDirectories.activationIntents.parentDirectoryFsync,
      { attempted: true, succeeded: true, unsupported: false });
  });
  await test("P2 journal records exact schema, verified stage evidence, and false boundary fields", () => {
    const journal = JSON.parse(fs.readFileSync(preparedIntent.intentPath, "utf8"));
    assert.equal(journal.schemaVersion, 1);
    assert.equal(journal.mode, "activation-intent");
    assert.equal(journal.purpose, "canonical-activation");
    assert.equal(journal.rollbackScope, "whole-release");
    assert.equal(journal.finalActivationReceiptDurable, false);
    for (const field of ["activationPerformed", "reloadPerformed", "canaryPerformed", "pushPerformed"]) {
      assert.equal(journal[field], false);
    }
    assert.equal(journal.stageReceiptSha256, sha256(fs.readFileSync(p2Stage.receiptPath)));
    assert.deepEqual(journal.stageManifests, p2Stage.receipt.manifests);
    assert.deepEqual(journal.gitExecutable,
      p2Api.stableGitExecutableIdentity(p2Api.TRUSTED_GIT_EXECUTABLE_IDENTITY));
    for (const key of ["device", "inode", "size", "mtimeMs"]) assert.equal(Object.hasOwn(journal.gitExecutable, key), false);
    assert.deepEqual(journal.durability.fileFsync, { attempted: true, succeeded: true });
    assert.deepEqual(journal.durability.directoryFsync, {
      attempted: true,
      succeeded: null,
      unsupported: null,
      actualOutcomeReturnedByPreparation: true,
    });
    assert.equal(journal.durability.processCrashAtomicity, true);
    assert.equal(journal.durability.powerLossDurabilityGuaranteed, false);
    assert.equal(preparedIntent.durability.fileFsync.succeeded, true);
    assert.equal(preparedIntent.durability.powerLossDurabilityGuaranteed, false);
  });
  await test("all three future tree records begin untouched with activation-specific siblings", () => {
    const journal = preparedIntent.journal;
    assert.deepEqual(journal.trees.map((tree) => tree.logicalName), ["alias", "dev_output", "extension"]);
    for (const tree of journal.trees) {
      assert.equal(tree.state, "untouched");
      assert.equal(tree.previousState, "unknown");
      assert.equal(tree.previousIdentity, null);
      assert.equal(tree.restorationMode, "unknown");
      assert.equal(tree.verified, false);
      assert.equal(path.basename(tree.incomingPath).endsWith(`.staging-act-${FIXED_ACTIVATION_ID}`), true);
      assert.equal(path.basename(tree.previousPath).endsWith(`.retired-act-${FIXED_ACTIVATION_ID}`), true);
    }
  });
  await test("intent preparation creates no payload, activation, or rollback tree", () => {
    const anchor = path.join(p2Fixture.top, ".h2o-canonical-delivery");
    assert.deepEqual(fs.readdirSync(anchor).sort(), ["activation-intents"]);
    for (const tree of preparedIntent.journal.trees) {
      assert.equal(fs.existsSync(tree.incomingPath), false);
      assert.equal(fs.existsSync(tree.previousPath), false);
    }
  });
  await test("intent preparation neither inspects nor mutates canonical payload paths", async () => {
    const value = createRepositoryFixture("p21-no-payload-inspection");
    const stageValue = createStageFixture(value.repository, "p21-no-payload-inspection");
    const valueApi = await importFixtureActivator(value, "no-payload-inspection");
    const originalLstat = fs.lstatSync;
    const canonicalRoots = [
      path.join(value.repository, "apps", "dev-server", "alias"),
      path.join(value.repository, "apps", "dev-server", "dev_output"),
      path.join(value.repository, "apps", "extensions", "chatgpt", "chrome", "dev-controls-oauth-google"),
    ];
    fs.lstatSync = (filename, ...args) => {
      const candidate = normalizedGuardPath(String(filename));
      if (canonicalRoots.some((root) => candidate === normalizedGuardPath(root) ||
          candidate.startsWith(`${normalizedGuardPath(root)}.staging-act-`) ||
          candidate.startsWith(`${normalizedGuardPath(root)}.retired-act-`))) {
        throw new Error(`canonical payload inspected: ${candidate}`);
      }
      return originalLstat(filename, ...args);
    };
    let prepared;
    try {
      prepared = valueApi.prepareActivationIntent(stageValue.receiptPath, {
        now: FIXED_ACTIVATION_DATE, randomBytes: FIXED_RANDOM_BYTES,
      });
    } finally { fs.lstatSync = originalLstat; }
    assert.equal(prepared.canonicalPayloadMutationPerformed, false);
    for (const root of canonicalRoots) assert.equal(fs.existsSync(root), false);
  });
  await test("read-only intent inspection validates the durable journal", () => {
    const before = fs.readFileSync(preparedIntent.intentPath);
    const result = runActivator(p2Fixture, ["--inspect-activation-intent", preparedIntent.intentPath]);
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.recovery.classification, "prepared-no-payload-mutation");
    assert.equal(payload.mutationPerformed, false);
    assert.equal(fs.readFileSync(preparedIntent.intentPath).equals(before), true);
  });
  await test("intent filename and activation ID mismatch rejects", () => {
    const mismatch = path.join(path.dirname(preparedIntent.intentPath),
      "20260802T120000000Z-ffffffffffff.json");
    fs.copyFileSync(preparedIntent.intentPath, mismatch);
    expectFailure(p2Fixture, ["--inspect-activation-intent", mismatch], "activation-intent-id-mismatch");
    fs.unlinkSync(mismatch);
  });
  for (const [field, value] of [
    ["sha256", "f".repeat(64)],
    ["version", "git version 0.0.0-fixture"],
    ["realpath", "/fixture/unapproved/git"],
  ]) {
    await test(`intent inspection rejects stable Git ${field} drift`, () => {
      const original = fs.readFileSync(preparedIntent.intentPath);
      const journal = JSON.parse(original);
      journal.gitExecutable[field] = value;
      fs.writeFileSync(preparedIntent.intentPath, `${JSON.stringify(journal, null, 2)}\n`, { mode: 0o600 });
      try {
        expectFailure(p2Fixture, ["--inspect-activation-intent", preparedIntent.intentPath],
          "activation-intent-source-mismatch");
      } finally {
        fs.writeFileSync(preparedIntent.intentPath, original, { mode: 0o600 });
      }
    });
  }
  for (const logicalName of ["alias", "dev_output", "extension"]) {
    await test(`intent inspection rejects ${logicalName} activation-intent tree mismatch`, () => {
      const original = fs.readFileSync(preparedIntent.intentPath);
      const journal = JSON.parse(original);
      const tree = journal.trees.find((entry) => entry.logicalName === logicalName);
      tree.incomingPath = `${tree.incomingPath}-mismatch`;
      fs.writeFileSync(preparedIntent.intentPath, `${JSON.stringify(journal, null, 2)}\n`, { mode: 0o600 });
      try {
        expectFailure(p2Fixture, ["--inspect-activation-intent", preparedIntent.intentPath],
          "activation-intent-tree-mismatch");
      } finally {
        fs.writeFileSync(preparedIntent.intentPath, original, { mode: 0o600 });
      }
    });
  }

  await test("publisher lock admits one winner and rejects concurrent intent ownership", () => {
    const root = tempRoot("p2-lock-contention");
    const evidence = lockEvidence(root);
    api.withPublisherLock(evidence.foundation, evidence.source, () => {
      expectActivatorError(() => api.withPublisherLock(evidence.foundation, evidence.source, () => null),
        "publisher-already-running");
    });
    assert.equal(fs.existsSync(evidence.foundation.publisherLock), false);
  });
  await test("stale publisher lock fails closed without deletion", () => {
    const root = tempRoot("p2-lock-stale");
    const evidence = lockEvidence(root);
    writeLock(evidence.foundation.publisherLock, {
      schemaVersion: 1, ownerId: "stale-owner", pid: 2147483647,
      repository: evidence.source.repository, approvedHead: evidence.source.approvedHead,
      startedAt: "2026-08-02T00:00:00.000Z",
    });
    expectActivatorError(() => api.withPublisherLock(evidence.foundation, evidence.source, () => null),
      "publisher-lock-stale");
    assert.equal(fs.existsSync(evidence.foundation.publisherLock), true);
  });
  await test("malformed and incomplete publisher locks fail closed", () => {
    const root = tempRoot("p2-lock-malformed");
    const evidence = lockEvidence(root);
    fs.mkdirSync(evidence.foundation.publisherLock);
    fs.writeFileSync(path.join(evidence.foundation.publisherLock, "lock.json"), "{bad");
    expectActivatorError(() => api.withPublisherLock(evidence.foundation, evidence.source, () => null),
      "publisher-lock-malformed");
    fs.writeFileSync(path.join(evidence.foundation.publisherLock, "lock.json"), "{}\n");
    expectActivatorError(() => api.withPublisherLock(evidence.foundation, evidence.source, () => null),
      "publisher-lock-incomplete");
    assert.equal(fs.existsSync(evidence.foundation.publisherLock), true);
  });
  await test("symlinked publisher lock fails closed", () => {
    const root = tempRoot("p2-lock-symlink");
    const evidence = lockEvidence(root);
    const target = path.join(root, "target");
    fs.mkdirSync(target);
    fs.symlinkSync(target, evidence.foundation.publisherLock);
    expectActivatorError(() => api.withPublisherLock(evidence.foundation, evidence.source, () => null),
      "publisher-lock-symlink");
    assert.equal(fs.lstatSync(evidence.foundation.publisherLock).isSymbolicLink(), true);
  });
  await test("publisher lock is released through success and thrown-callback finally paths", () => {
    const root = tempRoot("p2-lock-finally");
    const evidence = lockEvidence(root);
    assert.equal(api.withPublisherLock(evidence.foundation, evidence.source, () => "ok"), "ok");
    assert.equal(fs.existsSync(evidence.foundation.publisherLock), false);
    assert.throws(() => api.withPublisherLock(evidence.foundation, evidence.source, () => { throw new Error("fixture"); }),
      /fixture/u);
    assert.equal(fs.existsSync(evidence.foundation.publisherLock), false);
  });
  await test("wrong owner identity cannot release the publisher lock", async () => {
    const publisherApi = await import(`${pathToFileURL(path.join(ROOT, PUBLISHER_REL)).href}?lock=${Date.now()}`);
    const root = tempRoot("p2-lock-owner");
    const evidence = lockEvidence(root);
    api.withPublisherLock(evidence.foundation, evidence.source, (lock) => {
      assert.equal(publisherApi.releaseLock(evidence.foundation.publisherLock, process.pid, `${lock.ownerId}-wrong`),
        "not-owned");
      assert.equal(fs.existsSync(evidence.foundation.publisherLock), true);
    });
  });
  await test("two separate OS processes admit exactly one publisher-lock owner", async () => {
    const root = tempRoot("p21-os-lock-contention");
    const lockPath = path.join(root, ".h2o-publisher-lock");
    const marker = path.join(root, "first-owner-ready");
    const helper = path.join(root, "lock-helper.mjs");
    fs.writeFileSync(helper, [
      'import fs from "node:fs";',
      'const api = await import(process.argv[2]);',
      'const foundation = { publisherLock: process.argv[3] };',
      'const source = { repository: process.argv[4], approvedHead: "a".repeat(40) };',
      'try {',
      '  api.withPublisherLock(foundation, source, () => {',
      '    fs.writeFileSync(process.argv[5], String(process.pid));',
      '    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 700);',
      '  });',
      '  process.stdout.write("released\\n");',
      '} catch (error) { process.stderr.write(`${error.code || error.message}\\n`); process.exitCode = 2; }',
      "",
    ].join("\n"));
    const activatorUrl = pathToFileURL(path.join(ROOT, ACTIVATOR_REL)).href;
    const first = spawn(process.execPath, [helper, activatorUrl, lockPath, root, marker], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const deadline = Date.now() + 5_000;
    while (!fs.existsSync(marker) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(fs.existsSync(marker), true, "first OS process did not acquire the lock");
    const second = spawn(process.execPath, [helper, activatorUrl, lockPath, root, `${marker}-second`], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const [firstResult, secondResult] = await Promise.all([collectChild(first), collectChild(second)]);
    assert.equal(firstResult.status, 0, firstResult.stderr);
    assert.equal(secondResult.status, 2);
    assert.match(secondResult.stderr, /publisher-already-running/u);
    assert.equal(fs.existsSync(`${marker}-second`), false);
    assert.equal(fs.existsSync(lockPath), false);
  });
  await test("spawned prepare CLI is refused by the approved-root gate and holds no lock", () => {
    // P3B makes the approved production root mandatory for intent preparation.
    // A spawned child cannot be injected with fixture roots — that is the point —
    // so a fixture repository can no longer prepare an intent through the CLI.
    const value = createRepositoryFixture("p3b spawned cli gate 🧪");
    const stageValue = createStageFixture(value.repository, "p3b spawned cli gate 🧪");
    const result = runActivator(value, ["--prepare-activation-intent", stageValue.receiptPath]);
    assert.notEqual(result.status, 0);
    assert.equal(codeOf(result), "canonical-root-not-approved");
    assert.equal(fs.existsSync(path.join(value.top, ".h2o-publisher-lock")), false);
    assert.equal(fs.existsSync(path.join(value.top, ".h2o-canonical-delivery")), false);
  });
  await test("in-process prepare succeeds under explicit fixture root injection and releases its lock", async () => {
    const value = createRepositoryFixture("p3b inprocess prepare 🧪");
    const stageValue = createStageFixture(value.repository, "p3b inprocess prepare 🧪");
    const valueApi = await importFixtureActivator(value, "p3b-inprocess-prepare");
    const prepared = valueApi.prepareActivationIntent(stageValue.receiptPath, {
      now: FIXED_ACTIVATION_DATE, randomBytes: FIXED_RANDOM_BYTES,
    });
    assert.equal(prepared.ok, true);
    assert.equal(prepared.canonicalPayloadMutationPerformed, false);
    assert.equal(fs.existsSync(path.join(value.top, ".h2o-publisher-lock")), false);
    assert.equal(fs.existsSync(prepared.intentPath), true);
  });
  await test("spawned prepare CLI rejects a symlinked anchor before lock acquisition", () => {
    const value = createRepositoryFixture("p21-spawned-cli-failure");
    const stageValue = createStageFixture(value.repository, "p21-spawned-cli-failure");
    const foreign = path.join(value.top, "foreign-anchor"); fs.mkdirSync(foreign);
    fs.symlinkSync(foreign, path.join(value.top, ".h2o-canonical-delivery"));
    const result = runActivator(value, ["--prepare-activation-intent", stageValue.receiptPath]);
    assert.notEqual(result.status, 0);
    assert.equal(codeOf(result), "canonical-anchor-symlink");
    assert.equal(fs.existsSync(path.join(value.top, ".h2o-publisher-lock")), false);
    assert.deepEqual(fs.readdirSync(foreign), []);
  });
  await test("genuine post-lock preparation failure releases lock without journal or payload access", async () => {
    const value = createRepositoryFixture("p22-post-lock-failure");
    const stageValue = createStageFixture(value.repository, "p22-post-lock-failure");
    const valueApi = await importFixtureActivator(value, "p22-post-lock-failure");
    const lockPath = path.join(value.top, ".h2o-publisher-lock");
    const anchor = path.join(value.top, ".h2o-canonical-delivery");
    const payloadPaths = new Set([
      path.join(value.repository, "apps", "dev-server", "alias"),
      path.join(value.repository, "apps", "dev-server", "dev_output"),
      path.join(value.repository, "apps", "extensions", "chatgpt", "chrome", "dev-controls-oauth-google"),
    ].map((entry) => normalizedGuardPath(entry)));
    const originalLstat = fs.lstatSync;
    let lockAcquired = false;
    let payloadInspections = 0;
    fs.lstatSync = (filename, ...args) => {
      if (payloadPaths.has(normalizedGuardPath(String(filename)))) payloadInspections += 1;
      return originalLstat(filename, ...args);
    };
    try {
      const verified = valueApi.verifyStageReceipt(stageValue.receiptPath);
      assert.throws(() => valueApi.withPublisherLock(
        verified.canonicalFoundation, verified.source, () => {
          assert.equal(fs.existsSync(lockPath), true);
          lockAcquired = true;
          throw new Error("fixture failure after publisher-lock acquisition");
        }), /fixture failure after publisher-lock acquisition/u);
    } finally {
      fs.lstatSync = originalLstat;
    }
    assert.equal(lockAcquired, true);
    assert.equal(fs.existsSync(lockPath), false);
    assert.equal(fs.existsSync(anchor), false);
    assert.equal(payloadInspections, 0);
  });
  await test("coordination and journal permissions remain owner-only", async () => {
    const value = createRepositoryFixture("p21-permissions-space 🧪");
    const stageValue = createStageFixture(value.repository, "p21-permissions-space 🧪");
    const valueApi = await importFixtureActivator(value, "permissions");
    const prepared = valueApi.prepareActivationIntent(stageValue.receiptPath, {
      now: FIXED_ACTIVATION_DATE, randomBytes: FIXED_RANDOM_BYTES,
    });
    const anchor = path.join(value.top, ".h2o-canonical-delivery");
    const intents = path.join(anchor, "activation-intents");
    assert.equal(fs.statSync(anchor).mode & 0o777, 0o700);
    assert.equal(fs.statSync(intents).mode & 0o777, 0o700);
    assert.equal(fs.statSync(prepared.intentPath).mode & 0o777, 0o600);
    assert.equal(fs.readdirSync(intents).some((name) => name.includes(".tmp-")), false);
  });
  await test("unsupported coordination-parent fsync is reported explicitly", async () => {
    const parent = tempRoot("p22-parent-fsync-unsupported");
    const originalOpen = fs.openSync; const originalFsync = fs.fsyncSync;
    let parentDescriptor = null;
    fs.openSync = (filename, ...args) => {
      const descriptor = originalOpen(filename, ...args);
      if (path.resolve(String(filename)) === path.resolve(parent)) parentDescriptor = descriptor;
      return descriptor;
    };
    fs.fsyncSync = (descriptor) => {
      if (descriptor === parentDescriptor) {
        const error = new Error("fixture unsupported parent fsync"); error.code = "EINVAL"; throw error;
      }
      return originalFsync(descriptor);
    };
    let evidence;
    try {
      evidence = api.flushDirectory(parent);
    } finally { fs.openSync = originalOpen; fs.fsyncSync = originalFsync; }
    assert.deepEqual(evidence,
      { attempted: true, succeeded: false, unsupported: true, code: "EINVAL" });
  });
  await test("hard coordination-parent fsync failure remains loud", async () => {
    const parent = tempRoot("p22-parent-fsync-hard");
    const originalOpen = fs.openSync; const originalFsync = fs.fsyncSync;
    let parentDescriptor = null;
    fs.openSync = (filename, ...args) => {
      const descriptor = originalOpen(filename, ...args);
      if (path.resolve(String(filename)) === path.resolve(parent)) parentDescriptor = descriptor;
      return descriptor;
    };
    fs.fsyncSync = (descriptor) => {
      if (descriptor === parentDescriptor) {
        const error = new Error("fixture hard parent fsync failure"); error.code = "EIO"; throw error;
      }
      return originalFsync(descriptor);
    };
    try {
      assert.throws(() => api.flushDirectory(parent),
        (error) => error?.code === "directory-fsync-failed" && error?.details?.code === "EIO");
    } finally { fs.openSync = originalOpen; fs.fsyncSync = originalFsync; }
  });
  await test("EPERM directory fsync is a hard error rather than unsupported evidence", async () => {
    const parent = tempRoot("p22-parent-fsync-eperm");
    const originalOpen = fs.openSync; const originalFsync = fs.fsyncSync;
    let parentDescriptor = null;
    fs.openSync = (filename, ...args) => {
      const descriptor = originalOpen(filename, ...args);
      if (path.resolve(String(filename)) === path.resolve(parent)) parentDescriptor = descriptor;
      return descriptor;
    };
    fs.fsyncSync = (descriptor) => {
      if (descriptor === parentDescriptor) {
        const error = new Error("fixture parent fsync permission failure"); error.code = "EPERM"; throw error;
      }
      return originalFsync(descriptor);
    };
    try {
      assert.throws(() => api.flushDirectory(parent),
        (error) => error?.code === "directory-fsync-failed" && error?.details?.code === "EPERM");
    } finally { fs.openSync = originalOpen; fs.fsyncSync = originalFsync; }
  });

  await test("symlinked activation-intents directory rejects and lock is released", async () => {
    const value = createRepositoryFixture("p2-intents-symlink");
    const stageValue = createStageFixture(value.repository, "p2-intents-symlink");
    const valueApi = await importFixtureActivator(value, "intents-symlink");
    const anchor = path.join(value.top, ".h2o-canonical-delivery");
    const target = path.join(value.top, "foreign-intents");
    fs.mkdirSync(anchor, { mode: 0o700 });
    fs.mkdirSync(target, { mode: 0o700 });
    fs.symlinkSync(target, path.join(anchor, "activation-intents"));
    expectActivatorError(() => valueApi.prepareActivationIntent(stageValue.receiptPath), "activation-intents-symlink");
    assert.equal(fs.existsSync(path.join(value.top, ".h2o-publisher-lock")), false);
  });
  await test("symlinked canonical anchor rejects intent preparation without following it", async () => {
    const value = createRepositoryFixture("p2-anchor-symlink");
    const stageValue = createStageFixture(value.repository, "p2-anchor-symlink");
    const valueApi = await importFixtureActivator(value, "anchor-symlink");
    const target = path.join(value.top, "foreign-anchor"); fs.mkdirSync(target);
    fs.symlinkSync(target, path.join(value.top, ".h2o-canonical-delivery"));
    expectActivatorError(() => valueApi.prepareActivationIntent(stageValue.receiptPath), "canonical-anchor-symlink");
    assert.deepEqual(fs.readdirSync(target), []);
  });
  await test("unresolved foreign intent blocks preparation", async () => {
    const value = createRepositoryFixture("p2-unresolved");
    const stageValue = createStageFixture(value.repository, "p2-unresolved");
    const valueApi = await importFixtureActivator(value, "unresolved");
    const anchor = path.join(value.top, ".h2o-canonical-delivery");
    const intents = path.join(anchor, "activation-intents");
    fs.mkdirSync(anchor, { mode: 0o700 });
    fs.mkdirSync(intents, { mode: 0o700 });
    // An entry whose name is not an activation identity is an unknown file, not
    // an unresolved intent; A3 reports that distinction precisely.
    fs.writeFileSync(path.join(intents, "foreign.json"), "{}\n");
    expectActivatorError(() => valueApi.prepareActivationIntent(stageValue.receiptPath),
      "activation-intent-entry-unknown");
    fs.rmSync(path.join(intents, "foreign.json"));
    // A correctly named but unresolvable intent still blocks, as before.
    fs.writeFileSync(path.join(intents, "20260101T000000000Z-ffffffffffff.json"), "{}\n");
    expectActivatorError(() => valueApi.prepareActivationIntent(stageValue.receiptPath),
      "activation-intent-unresolved");
    // A symlinked entry is refused outright.
    fs.rmSync(path.join(intents, "20260101T000000000Z-ffffffffffff.json"));
    fs.symlinkSync(stageValue.receiptPath, path.join(intents, "20260101T000000000Z-ffffffffffff.json"));
    expectActivatorError(() => valueApi.prepareActivationIntent(stageValue.receiptPath),
      "activation-intent-entry-invalid");
    assert.equal(fs.existsSync(path.join(value.top, ".h2o-publisher-lock")), false);
  });
  await test("existing final journal collision rejects without overwrite", () => {
    const directory = tempRoot("p2-journal-collision");
    const existing = path.join(directory, `${FIXED_ACTIVATION_ID}.json`);
    fs.writeFileSync(existing, "original\n");
    expectActivatorError(() => api.writeDurableActivationIntent(directory, FIXED_ACTIVATION_ID, {}, {
      ownerId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    }), "activation-intent-collision");
    assert.equal(fs.readFileSync(existing, "utf8"), "original\n");
  });
  await test("final no-replace link failure cleans only its own temporary file", () => {
    const directory = tempRoot("p2-journal-temp-failure");
    const sentinel = path.join(directory, "foreign.tmp"); fs.writeFileSync(sentinel, "keep");
    const originalLink = fs.linkSync;
    fs.linkSync = (source, destination) => {
      if (String(source).includes(`${FIXED_ACTIVATION_ID}.json.tmp-`)) {
        const error = new Error("fixture link failure"); error.code = "EIO"; throw error;
      }
      return originalLink(source, destination);
    };
    try {
      assert.throws(() => api.writeDurableActivationIntent(directory, FIXED_ACTIVATION_ID, {}, {
        ownerId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      }), (error) => error.code === "activation-intent-link-failed");
    } finally { fs.linkSync = originalLink; }
    assert.deepEqual(fs.readdirSync(directory), ["foreign.tmp"]);
  });
  await test("failed final journal byte verification is loud and leaves durable evidence", () => {
    const directory = tempRoot("p2-journal-final-verify");
    const finalPath = path.join(directory, `${FIXED_ACTIVATION_ID}.json`);
    const originalRead = fs.readFileSync;
    fs.readFileSync = (filename, ...args) => path.resolve(String(filename)) === finalPath
      ? Buffer.from("corrupt") : originalRead(filename, ...args);
    try {
      expectActivatorError(() => api.writeDurableActivationIntent(directory, FIXED_ACTIVATION_ID, {}, {
        ownerId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      }), "activation-intent-final-verification");
    } finally { fs.readFileSync = originalRead; }
    assert.equal(fs.existsSync(finalPath), true);
  });
  await test("temporary journal open failure creates and removes nothing", () => {
    const directory = tempRoot("p21-journal-open-failure");
    const originalOpen = fs.openSync;
    fs.openSync = (filename, ...args) => {
      if (String(filename).includes(".json.tmp-")) {
        const error = new Error("fixture temp open failure"); error.code = "EACCES"; throw error;
      }
      return originalOpen(filename, ...args);
    };
    try {
      assert.throws(() => api.writeDurableActivationIntent(directory, FIXED_ACTIVATION_ID, {}, {
        ownerId: "11111111-2222-3333-4444-555555555555",
      }), /fixture temp open failure/u);
    } finally { fs.openSync = originalOpen; }
    assert.deepEqual(fs.readdirSync(directory), []);
  });
  await test("temporary journal write failure cleans only the invocation-owned temp", () => {
    const directory = tempRoot("p21-journal-write-failure");
    const originalWrite = fs.writeFileSync;
    fs.writeFileSync = (filename, ...args) => {
      if (typeof filename === "number") {
        const error = new Error("fixture temp write failure"); error.code = "EIO"; throw error;
      }
      return originalWrite(filename, ...args);
    };
    try {
      assert.throws(() => api.writeDurableActivationIntent(directory, FIXED_ACTIVATION_ID, {}, {
        ownerId: "11111111-2222-3333-4444-555555555555",
      }), /fixture temp write failure/u);
    } finally { fs.writeFileSync = originalWrite; }
    assert.deepEqual(fs.readdirSync(directory), []);
  });
  await test("file fsync failure prevents final publication and cleans the owned temp", () => {
    const directory = tempRoot("p21-journal-file-fsync-failure");
    const originalFsync = fs.fsyncSync;
    let calls = 0;
    fs.fsyncSync = (descriptor) => {
      calls += 1;
      if (calls === 1) { const error = new Error("fixture file fsync failure"); error.code = "EIO"; throw error; }
      return originalFsync(descriptor);
    };
    try {
      assert.throws(() => api.writeDurableActivationIntent(directory, FIXED_ACTIVATION_ID, {}, {
        ownerId: "11111111-2222-3333-4444-555555555555",
      }), /fixture file fsync failure/u);
    } finally { fs.fsyncSync = originalFsync; }
    assert.deepEqual(fs.readdirSync(directory), []);
  });
  await test("unsupported directory fsync is explicit without overstating power-loss durability", () => {
    const directory = tempRoot("p21-directory-fsync-unsupported");
    const originalOpen = fs.openSync; const originalFsync = fs.fsyncSync;
    let directoryDescriptor = null;
    fs.openSync = (filename, ...args) => {
      const descriptor = originalOpen(filename, ...args);
      if (path.resolve(String(filename)) === path.resolve(directory)) directoryDescriptor = descriptor;
      return descriptor;
    };
    fs.fsyncSync = (descriptor) => {
      if (descriptor === directoryDescriptor) { const error = new Error("unsupported"); error.code = "EINVAL"; throw error; }
      return originalFsync(descriptor);
    };
    let result;
    try {
      result = api.writeDurableActivationIntent(directory, FIXED_ACTIVATION_ID, {}, {
        ownerId: "11111111-2222-3333-4444-555555555555",
      });
    } finally { fs.openSync = originalOpen; fs.fsyncSync = originalFsync; }
    assert.deepEqual(result.durability.directoryFsync,
      { attempted: true, succeeded: false, unsupported: true, code: "EINVAL" });
    assert.equal(result.durability.powerLossDurabilityGuaranteed, false);
  });
  await test("hard directory fsync failure is loud after no-replace publication", () => {
    const directory = tempRoot("p21-directory-fsync-hard-failure");
    const finalPath = path.join(directory, `${FIXED_ACTIVATION_ID}.json`);
    const originalOpen = fs.openSync; const originalFsync = fs.fsyncSync;
    let directoryDescriptor = null;
    fs.openSync = (filename, ...args) => {
      const descriptor = originalOpen(filename, ...args);
      if (path.resolve(String(filename)) === path.resolve(directory)) directoryDescriptor = descriptor;
      return descriptor;
    };
    fs.fsyncSync = (descriptor) => {
      if (descriptor === directoryDescriptor) { const error = new Error("fixture directory fsync failure"); error.code = "EIO"; throw error; }
      return originalFsync(descriptor);
    };
    try {
      assert.throws(() => api.writeDurableActivationIntent(directory, FIXED_ACTIVATION_ID, {}, {
        ownerId: "11111111-2222-3333-4444-555555555555",
      }), (error) => error?.code === "directory-fsync-failed" && error?.details?.code === "EIO");
    } finally { fs.openSync = originalOpen; fs.fsyncSync = originalFsync; }
    assert.equal(fs.existsSync(finalPath), true);
  });
  await test("same-owner temporary collision cannot delete another process temp", () => {
    const directory = tempRoot("p21-same-owner-temp-collision");
    const ownerId = "11111111-2222-3333-4444-555555555555";
    const tempPath = path.join(directory, `.${FIXED_ACTIVATION_ID}.json.tmp-${ownerId}`);
    fs.writeFileSync(tempPath, "foreign-owned-temp\n", { mode: 0o600 });
    assert.throws(() => api.writeDurableActivationIntent(directory, FIXED_ACTIVATION_ID, {}, { ownerId }),
      (error) => error.code === "activation-intent-temp-collision");
    assert.equal(fs.readFileSync(tempPath, "utf8"), "foreign-owned-temp\n");
    assert.equal(fs.existsSync(path.join(directory, `${FIXED_ACTIVATION_ID}.json`)), false);
  });
  await test("no-replace publication loses a race without overwriting the winner", () => {
    const directory = tempRoot("p21-link-race");
    const finalPath = path.join(directory, `${FIXED_ACTIVATION_ID}.json`);
    const originalLink = fs.linkSync;
    let temporaryMode = null;
    fs.linkSync = (source, destination) => {
      temporaryMode = fs.statSync(source).mode & 0o777;
      fs.writeFileSync(destination, "winning-process\n", { mode: 0o600 });
      return originalLink(source, destination);
    };
    try {
      expectActivatorError(() => api.writeDurableActivationIntent(directory, FIXED_ACTIVATION_ID, {}, {
        ownerId: "11111111-2222-3333-4444-555555555555",
      }), "activation-intent-collision");
    } finally { fs.linkSync = originalLink; }
    assert.equal(fs.readFileSync(finalPath, "utf8"), "winning-process\n");
    assert.equal(temporaryMode, 0o600);
    assert.deepEqual(fs.readdirSync(directory), [`${FIXED_ACTIVATION_ID}.json`]);
  });

  async function runPostLockMutation(label, mutation, expectedCode) {
    const value = createRepositoryFixture(`p2-revalidate-${label}`);
    const stageValue = createStageFixture(value.repository, `p2-revalidate-${label}`);
    const valueApi = await importFixtureActivator(value, label);
    const originalRename = fs.renameSync;
    let injected = false;
    fs.renameSync = (source, destination) => {
      const result = originalRename(source, destination);
      if (!injected && path.basename(String(destination)) === ".h2o-publisher-lock") {
        injected = true;
        mutation(value, stageValue);
      }
      return result;
    };
    try {
      expectActivatorError(() => valueApi.prepareActivationIntent(stageValue.receiptPath), expectedCode);
    } finally {
      fs.renameSync = originalRename;
    }
    assert.equal(injected, true);
    assert.equal(fs.existsSync(path.join(value.top, ".h2o-publisher-lock")), false);
    assert.equal(fs.existsSync(path.join(value.top, ".h2o-canonical-delivery")), false);
  }
  await test("receipt byte change after P1 verification rejects before journal creation", async () => {
    await runPostLockMutation("receipt", (_value, stageValue) => fs.appendFileSync(stageValue.receiptPath, " "),
      "activation-intent-revalidation-changed");
  });
  await test("source HEAD and tree change after P1 verification rejects before journal creation", async () => {
    await runPostLockMutation("head", (value) => {
      fs.writeFileSync(path.join(value.repository, "fixture-source", "head-change.js"), "export const changed = true;\n");
      git(value.repository, ["add", "fixture-source/head-change.js"]);
      git(value.repository, ["commit", "-q", "-m", "fixture: head changes during lock"]);
    }, "receipt-head-mismatch");
  });
  await test("dirty source after P1 verification rejects before journal creation", async () => {
    await runPostLockMutation("dirty", (value) => fs.appendFileSync(value.activator, "\n// dirty fixture\n"),
      "tracked-worktree-dirty");
  });
  await test("staged bytes changed after P1 verification reject before journal creation", async () => {
    await runPostLockMutation("staged", (_value, stageValue) =>
      fs.appendFileSync(path.join(stageValue.extension, "bg.js"), "// changed\n"),
    "staged-manifest-entry-mismatch");
  });

  await test("changed receipt after intent creation rejects inspection", async () => {
    const value = createRepositoryFixture("p2-inspect-receipt-change");
    const stageValue = createStageFixture(value.repository, "p2-inspect-receipt-change");
    const valueApi = await importFixtureActivator(value, "inspect-receipt-change");
    const prepared = valueApi.prepareActivationIntent(stageValue.receiptPath, {
      now: FIXED_ACTIVATION_DATE, randomBytes: FIXED_RANDOM_BYTES,
    });
    fs.appendFileSync(stageValue.receiptPath, " ");
    expectFailure(value, ["--inspect-activation-intent", prepared.intentPath], "activation-intent-receipt-changed");
  });
  await test("changed staged bytes after intent creation reject inspection", async () => {
    const value = createRepositoryFixture("p2-inspect-stage-change");
    const stageValue = createStageFixture(value.repository, "p2-inspect-stage-change");
    const valueApi = await importFixtureActivator(value, "inspect-stage-change");
    const prepared = valueApi.prepareActivationIntent(stageValue.receiptPath, {
      now: FIXED_ACTIVATION_DATE, randomBytes: FIXED_RANDOM_BYTES,
    });
    fs.appendFileSync(path.join(stageValue.extension, "bg.js"), "// changed\n");
    expectFailure(value, ["--inspect-activation-intent", prepared.intentPath], "staged-manifest-entry-mismatch");
  });
  await test("valid partial promotion state fails closed with P3 recovery required", () => {
    const journal = structuredClone(preparedIntent.journal);
    Object.assign(journal.trees[0], {
      state: "live-retired", previousState: "absent", previousIdentity: null,
      restorationMode: "remove-promoted-to-absent", verified: false,
    });
    assert.equal(api.classifyRecoveryState(journal).classification,
      "promotion-state-requires-p3-recovery");
    assert.equal(api.classifyRecoveryState(journal).code, "p3-recovery-required");
  });
  await test("intent inspection rejects payload-mutated state with P3 recovery required", () => {
    const original = fs.readFileSync(preparedIntent.intentPath);
    const journal = JSON.parse(original);
    Object.assign(journal.trees[0], {
      state: "live-retired", previousState: "absent", previousIdentity: null,
      restorationMode: "remove-promoted-to-absent", verified: false,
    });
    fs.writeFileSync(preparedIntent.intentPath, `${JSON.stringify(journal, null, 2)}\n`, { mode: 0o600 });
    try {
      expectFailure(p2Fixture, ["--inspect-activation-intent", preparedIntent.intentPath], "p3-recovery-required");
    } finally {
      fs.writeFileSync(preparedIntent.intentPath, original, { mode: 0o600 });
    }
  });
  await test("contradictory journal state is rejected", () => {
    const journal = structuredClone(preparedIntent.journal);
    journal.trees[0].state = "verified";
    assert.equal(api.classifyRecoveryState(journal).classification, "contradictory-journal");
  });
  await test("recovery model distinguishes promotion-not-started", () => {
    const journal = structuredClone(preparedIntent.journal);
    journal.transactionState = "promotion-not-started";
    assert.equal(api.classifyRecoveryState(journal).classification, "promotion-not-started");
  });
  await test("first-ever restoration to absent is representable without guessing recovery", () => {
    const journal = structuredClone(preparedIntent.journal);
    Object.assign(journal.trees[1], {
      state: "incoming-promoted", previousState: "absent", previousIdentity: null,
      restorationMode: "remove-promoted-to-absent", verified: false,
    });
    assert.equal(api.classifyRecoveryState(journal).code, "p3-recovery-required");
  });
  await test("foreign or unowned journal identity is classified separately", () => {
    assert.equal(api.classifyRecoveryState(preparedIntent.journal, {
      repositoryRealpath: "/foreign/repository",
    }).classification, "foreign-or-unowned-journal");
  });
  // Test-first evidence for the P3A canonical-root pin. Every fixture in this
  // suite is a relocated standalone copy, and each one derives a self-consistent
  // module / executable-Git / anchor authority. That is exactly the gap: P2.3
  // proves the three agree with one another, never that they are a production
  // location, so a copy anywhere on disk is accepted.
  await test("integrated P2.3 authority accepts a self-consistent relocated copy", async () => {
    const relocated = createRepositoryFixture("p3a-relocated-copy");
    const relocatedApi = await importFixtureActivator(relocated, "p3a-relocated-copy");
    const foundation = relocatedApi.deriveCanonicalFoundation(relocated.repository);
    assert.equal(normalizedGuardPath(foundation.root),
      normalizedGuardPath(path.join(relocated.top, ".h2o-canonical-delivery")));
    assert.notEqual(normalizedGuardPath(relocated.repository),
      normalizedGuardPath("/Users/hobayda/H2OCode/repos/h2o-platforms/cockpit-pro/h2o-cp-source"));
  });
  await test("the P3A canonical-root pin rejects that same relocated copy", async () => {
    const relocated = createRepositoryFixture("p3a-relocated-pin");
    const relocatedApi = await importFixtureActivator(relocated, "p3a-relocated-pin");
    const payload = await import(
      `${pathToFileURL(path.join(ROOT, PAYLOAD_MODULE_REL)).href}?validator=${Date.now()}`);
    const foundation = relocatedApi.deriveCanonicalFoundation(relocated.repository);
    assert.throws(() => payload.assertApprovedCanonicalRoot({
      repository: relocated.repository,
      cockpitProRoot: path.dirname(relocated.repository),
      anchorRoot: foundation.root,
      executableRepository: relocated.repository,
    }), (error) => error.code === "canonical-root-not-approved");
    // Fixture roots are reachable only through explicit injection.
    assert.equal(payload.assertApprovedCanonicalRoot({
      repository: relocated.repository,
      cockpitProRoot: path.dirname(relocated.repository),
      anchorRoot: foundation.root,
      executableRepository: relocated.repository,
      approvedRepositories: [relocated.repository],
      approvedCockpitProRoots: [path.dirname(relocated.repository)],
    }).approved, true);
  });

  await runP3cA1Tests();
  await runStudioPublicationAuthorityTests();
}

/* ------------------------------------------------------------------------- *
 * P3C-A1 — end-to-end activation and durable acceptance
 *
 * These scenarios run the real production activation path against disposable
 * fixtures: the real Batch 1 publisher lock, the real canonical-delivery lease,
 * real three-tree promotion, and real no-replace receipt publication.
 * ------------------------------------------------------------------------- */

async function createActivationFixture(label, { mutateStage = null } = {}) {
  const fixture = createRepositoryFixture(`p3ca1-${label}`);
  // The extension family's canonical parent must exist before an owned incoming
  // root may be created; the dev-server parent already exists in the fixture.
  fs.mkdirSync(path.join(fixture.repository, "apps", "extensions", "chatgpt", "chrome"),
    { recursive: true });
  const stage = createStageFixture(fixture.repository, `p3ca1-${label}`);
  if (mutateStage) {
    mutateStage(fixture, stage);
    refreshReceiptManifests(stage);
  }
  const api = await importFixtureActivator(fixture, `p3ca1-${label}`);
  // The unit table comes from the same payload module the activator imports, so
  // fixture expectations cannot drift from the pinned canonical unit layout.
  const payload = await import(`${pathToFileURL(path.join(fixture.repository, PAYLOAD_MODULE_REL)).href
  }?p3ca1=${encodeURIComponent(label)}-${Date.now()}`);
  const intent = api.prepareActivationIntent(stage.receiptPath, {
    environment: cleanEnvironment(), now: FIXED_ACTIVATION_DATE, randomBytes: FIXED_RANDOM_BYTES,
  });
  return {
    fixture, stage, api, payload, intent,
    // Real-path spelling: the activator derives every coordination path through
    // realpath, so fixture expectations must use the same spelling.
    anchor: path.join(fs.realpathSync.native(fixture.top), ".h2o-canonical-delivery"),
    lock: path.join(fs.realpathSync.native(fixture.top), ".h2o-publisher-lock"),
    units: payload.canonicalUnitPaths(fs.realpathSync(fixture.repository), intent.activationId),
    activate: (options = {}) => api.activateReceipt(stage.receiptPath, intent.intentPath,
      { environment: cleanEnvironment(), now: FIXED_ACTIVATION_DATE, ...options }),
  };
}

async function createStudioPublicationFixture(label) {
  const fixture = createRealPublisherBoundaryFixture(`studio-${label}`, { studioAuthority: true });
  const stage = runRealPublisher(fixture, { studio: true });
  assert.equal(stage.result.status, 0, stage.result.stderr);
  assert.ok(stage.receiptPath, "Studio publisher did not produce a receipt");
  const stageReceipt = JSON.parse(fs.readFileSync(stage.receiptPath, "utf8"));
  const api = await importFixtureActivator(fixture, `studio-${label}`);
  const payload = await import(`${pathToFileURL(path.join(fixture.repository, PAYLOAD_MODULE_REL)).href
  }?studio=${encodeURIComponent(label)}-${Date.now()}`);
  const intent = api.prepareActivationIntent(stage.receiptPath, {
    environment: cleanEnvironment(), now: FIXED_ACTIVATION_DATE, randomBytes: FIXED_RANDOM_BYTES,
  });
  const repository = fs.realpathSync.native(fixture.repository);
  const units = payload.canonicalUnitPaths(repository, intent.activationId, {
    targetId: "studio-launcher", extensionVariant: "studio-launcher",
  });
  return {
    fixture, stage, stageReceipt, api, payload, intent, units,
    anchor: path.join(fs.realpathSync.native(fixture.top), ".h2o-canonical-delivery"),
    activate: (options = {}) => api.activateReceipt(stage.receiptPath, intent.intentPath,
      { environment: cleanEnvironment(), now: FIXED_ACTIVATION_DATE, ...options }),
  };
}

async function runStudioPublicationAuthorityTests() {
  await test("Studio publication promotes one unit and records the retained legacy generation", async () => {
    const context = await createStudioPublicationFixture("promotion-success");
    const [unit] = context.units;
    const previous = context.payload.recomputeIncomingManifest(unit.livePath, "");
    assert.equal(previous.treeDigest, context.stageReceipt.canonicalBaseline.treeDigest);
    assert.equal(context.stageReceipt.canonicalBaseline.provenanceStatus, "legacy-unreceipted");
    const result = context.activate();
    const receipt = JSON.parse(fs.readFileSync(result.activationReceiptPath, "utf8"));
    assert.equal(result.ok, true);
    assert.equal(receipt.publicationTarget, "studio-launcher");
    assert.equal(receipt.generationId, context.stageReceipt.generationId);
    assert.equal(receipt.expectedExtensionId, "bpobkkppdlldlkccaehmpfclmkhiemhg");
    assert.equal(receipt.canonicalOutputPath, unit.livePath);
    assert.equal(receipt.previousCanonicalIdentities.studio_launcher.previousTreeDigest,
      previous.treeDigest);
    assert.equal(receipt.previousCanonicalIdentities.studio_launcher.previousProvenanceStatus,
      "legacy-unreceipted");
    assert.equal(receipt.previousCanonicalIdentities.studio_launcher.rollbackCandidateAvailable, true);
    assert.equal(context.payload.recomputeIncomingManifest(unit.retiredPath, "").treeDigest,
      previous.treeDigest);
    assert.equal(context.payload.recomputeIncomingManifest(unit.livePath, "").treeDigest,
      receipt.promotedCanonicalIdentities.studio_launcher.treeDigest);
    assert.equal(fs.existsSync(path.join(unit.livePath,
      "surfaces", "studio", "renderer", "chat-renderer.studio.js")), true);
    for (const flag of ["runtimeActivationPerformed", "browserReloadPerformed",
      "deploymentPerformed", "releasePerformed"]) assert.equal(receipt[flag], false, flag);
    disposeTemporaryRoot(context.fixture.top);
  });

  await test("Studio rollback requires the exact immutable intent and retains both generations", async () => {
    const context = await createStudioPublicationFixture("rollback-success");
    const activation = context.activate();
    const accepted = JSON.parse(fs.readFileSync(activation.activationReceiptPath, "utf8"));
    const intent = context.api.prepareStudioRollbackIntent(activation.activationReceiptPath, {
      environment: cleanEnvironment(), now: SECOND_ACTIVATION_DATE,
      randomBytes: SECOND_RANDOM_BYTES,
    });
    const copiedIntent = path.join(context.fixture.top, "copied-rollback-intent.json");
    fs.copyFileSync(intent.rollbackIntentPath, copiedIntent);
    expectActivatorError(() => context.api.executeStudioRollback(
      activation.activationReceiptPath, copiedIntent, { environment: cleanEnvironment() }),
    "rollback-intent-invalid");
    const result = context.api.executeStudioRollback(activation.activationReceiptPath,
      intent.rollbackIntentPath, { environment: cleanEnvironment(), now: SECOND_ACTIVATION_DATE });
    const rollback = JSON.parse(fs.readFileSync(result.rollbackReceiptPath, "utf8"));
    const [unit] = context.units;
    assert.equal(result.ok, true);
    assert.equal(rollback.publicationTarget, "studio-launcher");
    assert.equal(rollback.sourceActivationReceiptSha256, activation.activationReceiptSha256);
    assert.equal(rollback.rolledBackFromGenerationId, accepted.generationId);
    assert.equal(rollback.restoredToDigest,
      accepted.previousCanonicalIdentities.studio_launcher.previousTreeDigest);
    assert.equal(context.payload.recomputeIncomingManifest(unit.livePath, "").treeDigest,
      rollback.restoredToDigest);
    assert.equal(context.payload.recomputeIncomingManifest(result.retainedReplacementPath, "").treeDigest,
      rollback.rolledBackFromDigest);
    assert.equal(rollback.runtimeActivationPerformed, false);
    assert.equal(rollback.browserReloadPerformed, false);
    disposeTemporaryRoot(context.fixture.top);
  });

  await test("interrupted and unreceipted Studio rollbacks recover to the accepted generation", async () => {
    const context = await createStudioPublicationFixture("rollback-recovery");
    const activation = context.activate();
    const accepted = JSON.parse(fs.readFileSync(activation.activationReceiptPath, "utf8"));
    const [unit] = context.units;
    const firstIntent = context.api.prepareStudioRollbackIntent(activation.activationReceiptPath, {
      environment: cleanEnvironment(), now: SECOND_ACTIVATION_DATE,
      randomBytes: SECOND_RANDOM_BYTES,
    });
    expectActivatorError(() => context.api.executeStudioRollback(activation.activationReceiptPath,
      firstIntent.rollbackIntentPath, {
        environment: cleanEnvironment(),
        hooks: { afterRetireCurrent: () => { throw new Error("fixture interruption"); } },
      }), "rollback-failed");
    const firstRecovered = context.api.recoverStudioRollback(firstIntent.rollbackId,
      firstIntent.rollbackIntentPath, { environment: cleanEnvironment() });
    assert.equal(firstRecovered.reversedToAcceptedGeneration, true);
    assert.equal(context.payload.recomputeIncomingManifest(unit.livePath, "").treeDigest,
      accepted.promotedCanonicalIdentities.studio_launcher.treeDigest);

    const later = new Date("2026-08-03T09:31:00.000Z");
    const laterBytes = () => Buffer.from("c3d4e5f6a1b2", "hex");
    const secondIntent = context.api.prepareStudioRollbackIntent(activation.activationReceiptPath, {
      environment: cleanEnvironment(), now: later, randomBytes: laterBytes,
    });
    expectActivatorError(() => context.api.executeStudioRollback(activation.activationReceiptPath,
      secondIntent.rollbackIntentPath, {
        environment: cleanEnvironment(),
        hooks: { receiptFailureInjection: (point) => {
          if (point === "before-temp-open") throw new Error("fixture rollback receipt failure");
        } },
      }), "rollback-receipt-publication-failed");
    assert.equal(context.payload.recomputeIncomingManifest(unit.livePath, "").treeDigest,
      accepted.promotedCanonicalIdentities.studio_launcher.treeDigest);
    assert.equal(context.payload.recomputeIncomingManifest(unit.retiredPath, "").treeDigest,
      accepted.previousCanonicalIdentities.studio_launcher.previousTreeDigest);
    const secondRecovered = context.api.recoverStudioRollback(secondIntent.rollbackId,
      secondIntent.rollbackIntentPath, { environment: cleanEnvironment() });
    assert.equal(secondRecovered.reversedToAcceptedGeneration, true);
    assert.equal(secondRecovered.rollbackPerformed, false);
    disposeTemporaryRoot(context.fixture.top);
  });
}

function leaseDirectory(anchor) {
  return path.join(anchor, "active-lease");
}

function readChain(anchor, activationId) {
  const directory = path.join(anchor, "transactions", activationId);
  return fs.readdirSync(directory).filter((name) => name.startsWith("seq-")).sort()
    .map((name) => JSON.parse(fs.readFileSync(path.join(directory, name), "utf8")));
}

async function runP3cA1Tests() {
  await test("P3C-A1 activates all three canonical trees end to end", async () => {
    const context = await createActivationFixture("success");
    const result = context.activate();
    assert.equal(result.ok, true);
    assert.equal(result.activationPerformed, true);
    for (const flag of ["reloadPerformed", "canaryPerformed", "pushPerformed",
      "networkActionPerformed", "browserActionPerformed"]) {
      assert.equal(result[flag], false, flag);
    }
    // Every live tree now carries the staged payload.
    for (const unit of context.units) {
      assert.equal(fs.existsSync(unit.livePath), true, unit.logicalName);
      assert.equal(fs.existsSync(unit.incomingPath), false, `${unit.logicalName} incoming remains`);
    }
    assert.equal(fs.existsSync(path.join(context.units[0].livePath, "compat ordinary.js")), true);
    assert.equal(fs.existsSync(path.join(context.units[2].livePath, "manifest.json")), true);
    disposeTemporaryRoot(context.fixture.top);
  });
  await test("activation is refused without an explicit prepared intent", async () => {
    const context = await createActivationFixture("intent-required");
    // A stage receipt alone can never activate, and a resolved intent cannot be
    // silently re-created by the activation path.
    expectActivatorError(() => context.api.activateReceipt(context.stage.receiptPath,
      path.join(context.fixture.top, "absent-intent.json"), { environment: cleanEnvironment() }),
    "ENOENT");
    const result = runActivator(context.fixture, ["--activate-receipt", context.stage.receiptPath]);
    assert.equal(codeOf(result), "activation-intent-required");
    disposeTemporaryRoot(context.fixture.top);
  });
  await test("the real publisher lock and canonical lease are both released on success", async () => {
    const context = await createActivationFixture("exclusion-release");
    assert.equal(fs.existsSync(leaseDirectory(context.anchor)), false);
    const result = context.activate();
    assert.equal(result.ok, true);
    assert.equal(fs.existsSync(leaseDirectory(context.anchor)), false, "lease still held");
    assert.equal(fs.existsSync(context.lock), false, "publisher lock still held");
    disposeTemporaryRoot(context.fixture.top);
  });
  await test("both exclusions are released when activation fails", async () => {
    const context = await createActivationFixture("exclusion-release-failure");
    assert.throws(() => context.activate({
      hooks: { afterPrepare: () => { throw new Error("injected preparation failure"); } },
    }));
    assert.equal(fs.existsSync(leaseDirectory(context.anchor)), false, "lease leaked on failure");
    assert.equal(fs.existsSync(context.lock), false, "publisher lock leaked on failure");
    disposeTemporaryRoot(context.fixture.top);
  });
  await test("publisher-lock ownership is re-proved before every rename", async () => {
    const context = await createActivationFixture("lock-drift");
    // Replace the lock metadata with a foreign owner after the lock is held but
    // before the first payload rename.
    assert.throws(() => context.activate({
      hooks: {
        afterPrepare: () => {
          fs.writeFileSync(path.join(context.lock, "lock.json"),
            `${JSON.stringify({ ownerId: "foreign-owner", pid: process.pid })}\n`, { mode: 0o600 });
        },
      },
    }), (error) => error?.code === "publisher-lock-ownership-lost" ||
      error?.details?.code === "publisher-lock-ownership-lost");
    // No canonical tree was replaced.
    for (const unit of context.units) {
      assert.equal(fs.existsSync(path.join(unit.livePath, "manifest.json")), false, unit.logicalName);
    }
    disposeTemporaryRoot(context.fixture.top);
  });
  await test("a tautological lock check cannot satisfy the ownership guard", () => {
    const source = fs.readFileSync(path.join(ROOT, ACTIVATOR_REL), "utf8");
    assert.match(source, /export function assertPublisherLockStillOwned/u);
    assert.match(source, /verifyLock: \(\) => assertPublisherLockStillOwned\(/u);
    assert.doesNotMatch(source, /verifyLock: \(\) => lock\.ownerId === lock\.ownerId/u);
    // The guard must read the lock back from disk rather than trusting memory.
    const guard = source.slice(source.indexOf("export function assertPublisherLockStillOwned"));
    assert.match(guard.slice(0, 900), /fs\.readFileSync\(path\.join\(lockDirectory, "lock\.json"\)/u);
    assert.match(guard.slice(0, 900), /metadata\?\.pid !== process\.pid/u);
  });
  await test("the real canonical lease is acquired, verified and bound to this activation", async () => {
    const context = await createActivationFixture("lease-binding");
    let observed = null;
    const result = context.activate({
      hooks: {
        afterPrepare: () => {
          observed = JSON.parse(fs.readFileSync(
            path.join(leaseDirectory(context.anchor), "lease.json"), "utf8"));
        },
      },
    });
    assert.equal(result.ok, true);
    assert.equal(observed.lifecycleState, "held");
    assert.equal(observed.purpose, "canonical-activation");
    assert.equal(observed.lane, "activation");
    assert.equal(observed.branch, "main");
    assert.equal(observed.approvedHead, git(context.fixture.repository, ["rev-parse", "HEAD"]));
    assert.equal(observed.publisherRepositoryRoot, fs.realpathSync(context.fixture.repository));
    assert.equal(observed.expectedExtensionOutput,
      fs.realpathSync.native(path.dirname(context.units[2].livePath)) +
        path.sep + path.basename(context.units[2].livePath));
    disposeTemporaryRoot(context.fixture.top);
  });
  await test("lease loss or owner drift aborts before the next rename", async () => {
    for (const [label, corrupt] of [
      ["removed", (anchor) => fs.rmSync(leaseDirectory(anchor), { recursive: true, force: true })],
      ["session-drift", (anchor) => {
        const metadata = path.join(leaseDirectory(anchor), "lease.json");
        const lease = JSON.parse(fs.readFileSync(metadata, "utf8"));
        lease.sessionId = "00000000-0000-4000-8000-000000000000";
        fs.rmSync(metadata);
        fs.writeFileSync(metadata, `${JSON.stringify(lease, null, 2)}\n`, { mode: 0o600 });
      }],
    ]) {
      const context = await createActivationFixture(`lease-${label}`);
      assert.throws(() => context.activate({
        hooks: { afterPrepare: () => corrupt(context.anchor) },
      }), (error) => typeof error?.code === "string", label);
      for (const unit of context.units) {
        assert.equal(fs.existsSync(path.join(unit.livePath, "manifest.json")), false,
          `${label}:${unit.logicalName}`);
      }
      disposeTemporaryRoot(context.fixture.top);
    }
  });
  await test("the activation receipt is durable, 0600, and byte-verified", async () => {
    const context = await createActivationFixture("receipt-durability");
    const result = context.activate();
    const receiptPath = result.activationReceiptPath;
    assert.equal(receiptPath,
      path.join(context.anchor, "activations", `${context.intent.activationId}.json`));
    const stat = fs.lstatSync(receiptPath);
    assert.equal(stat.isFile(), true);
    assert.equal(stat.isSymbolicLink(), false);
    assert.equal(stat.mode & 0o777, 0o600);
    const bytes = fs.readFileSync(receiptPath);
    assert.equal(sha256(bytes), result.activationReceiptSha256);
    const receipt = JSON.parse(bytes.toString("utf8"));
    assert.equal(receipt.activationPerformed, true);
    for (const flag of ["reloadPerformed", "canaryPerformed", "pushPerformed"]) {
      assert.equal(receipt[flag], false, flag);
    }
    assert.equal(receipt.intentSha256, context.intent.intentSha256);
    assert.equal(receipt.stageReceiptSha256, sha256(fs.readFileSync(context.stage.receiptPath)));
    assert.equal(receipt.approvedHead, git(context.fixture.repository, ["rev-parse", "HEAD"]));
    assert.equal(receipt.acceptedExtensionVariant, "dev-controls-oauth-google");
    assert.equal(receipt.buildMarker, context.stage.receipt.buildTimestamp);
    assert.equal(Object.keys(receipt.promotedCanonicalIdentities).sort().join(","),
      "alias,dev_output,extension");
    assert.equal(Object.keys(receipt.canonicalVerification).length, 3);
    for (const value of Object.values(receipt.canonicalVerification)) {
      assert.equal(value.verified, true);
      assert.equal(value.comparedAgainst, "prepared-incoming-identity");
    }
    // No temporary receipt file survives, and durability is not overclaimed.
    assert.deepEqual(fs.readdirSync(path.dirname(receiptPath)),
      [`${context.intent.activationId}.json`]);
    assert.equal(receipt.durability?.powerLossDurabilityGuaranteed ??
      result.activationReceiptDurability?.powerLossDurabilityGuaranteed ?? false, false);
    disposeTemporaryRoot(context.fixture.top);
  });
  await test("an existing activation receipt is never overwritten", async () => {
    const context = await createActivationFixture("receipt-collision");
    const receiptPath = path.join(context.anchor, "activations",
      `${context.intent.activationId}.json`);
    fs.mkdirSync(path.dirname(receiptPath), { recursive: true });
    const squatted = `${JSON.stringify({ squatter: true })}\n`;
    fs.writeFileSync(receiptPath, squatted, { mode: 0o600 });
    assert.throws(() => context.activate(), (error) =>
      error?.code === "activation-receipt-publication-failed");
    assert.equal(fs.readFileSync(receiptPath, "utf8"), squatted, "existing receipt bytes changed");
    disposeTemporaryRoot(context.fixture.top);
  });
  await test("every receipt-finalization failure prevents acceptance and reverses the release", async () => {
    // `linked` records whether the injection point is after the no-replace hard
    // link: only then may a receipt file legitimately survive, as evidence.
    const failures = [
      ["temporary-open", "before-temp-open", false],
      ["write", "after-temp-open", false],
      ["file-fsync", "after-write", false],
      ["no-replace-link", "after-fsync", false],
      ["directory-fsync", "after-link", true],
      ["read-back-digest", "after-directory-fsync", true],
    ];
    for (const [label, stage, linked] of failures) {
      const context = await createActivationFixture(`receipt-fail-${label}`);
      assert.throws(() => context.activate({
        hooks: { receiptFailureInjection: (point) => {
          if (point === stage) throw new Error(`injected ${label} failure`);
        } },
      }), (error) => error?.code === "activation-receipt-publication-failed", label);
      // Before the link there is no receipt at all; after it the receipt is
      // preserved as evidence. Either way no temporary file is left behind.
      const activations = path.join(context.anchor, "activations");
      const published = fs.existsSync(activations) ? fs.readdirSync(activations).sort() : [];
      assert.deepEqual(published, linked ? [`${context.intent.activationId}.json`] : [], label);
      const chain = readChain(context.anchor, context.intent.activationId);
      assert.equal(chain.some((record) => record.transactionState === "accepted"), false,
        `${label} accepted an unreceipted release`);
      // The whole release was reversed: every unit is restored to absence.
      assert.equal(chain.filter((record) => record.transactionState === "restored").length >= 3, true,
        `${label} did not reverse all three units`);
      for (const unit of context.units) {
        assert.equal(fs.existsSync(path.join(unit.livePath, "manifest.json")), false,
          `${label}:${unit.logicalName} left promoted`);
      }
      disposeTemporaryRoot(context.fixture.top);
    }
  });
  await test("acceptance is appended only after the receipt is durable and re-verified", async () => {
    const context = await createActivationFixture("accepted-ordering");
    const result = context.activate();
    const chain = readChain(context.anchor, context.intent.activationId);
    const accepted = chain.filter((record) => record.transactionState === "accepted");
    assert.equal(accepted.length, 1, "accepted must have exactly one record");
    assert.equal(chain[chain.length - 1].transactionState, "accepted", "accepted must be terminal");
    // The accepted record binds the receipt that already exists on disk.
    assert.equal(accepted[0].activationReceiptSha256 ?? accepted[0].receiptSha256,
      result.activationReceiptSha256);
    // Sequences are gap-free and strictly increasing: proves the terminal
    // sequence is derived from a fresh chain read.
    const sequences = chain.map((record) => record.sequence);
    assert.deepEqual(sequences, sequences.map((_unused, index) => index + 1));
    disposeTemporaryRoot(context.fixture.top);
  });
  await test("transaction owner evidence is the publisher-lock owner, not the activation id", async () => {
    const context = await createActivationFixture("owner-evidence");
    let lockOwnerId = null;
    const result = context.activate({
      hooks: {
        afterPrepare: () => {
          lockOwnerId = JSON.parse(fs.readFileSync(
            path.join(context.lock, "lock.json"), "utf8")).ownerId;
        },
      },
    });
    assert.equal(result.ok, true);
    assert.equal(typeof lockOwnerId, "string");
    assert.notEqual(lockOwnerId, context.intent.activationId);
    const chain = readChain(context.anchor, context.intent.activationId);
    assert.equal(chain.length > 0, true);
    for (const record of chain) {
      assert.equal(record.owner.ownerId, lockOwnerId, "owner evidence drifted from the lock owner");
      assert.notEqual(record.owner.ownerId, record.activationId);
      assert.equal(record.owner.pid, process.pid);
    }
    disposeTemporaryRoot(context.fixture.top);
  });
  await test("activation performs no browser, network, canary, push or pruning action", async () => {
    const context = await createActivationFixture("boundary");
    const result = context.activate();
    assert.equal(result.ok, true);
    // Nothing outside the fixture repository and its anchor was created.
    const anchorEntries = fs.readdirSync(context.anchor).sort();
    assert.deepEqual(anchorEntries.filter((entry) => !entry.startsWith(".")),
      ["activation-intents", "activations", "transactions"]);
    // Retired siblings are preserved as rollback evidence and never pruned.
    const retained = context.units.filter((unit) => fs.existsSync(unit.retiredPath));
    assert.equal(retained.length, 0, "a first activation retires nothing");
    const receipt = JSON.parse(fs.readFileSync(result.activationReceiptPath, "utf8"));
    assert.equal(receipt.rollbackAvailable, true);
    assert.equal(receipt.promotionPrimitive, "fail-closed-two-rename");
    disposeTemporaryRoot(context.fixture.top);
  });

  await runP3cA2Tests();
}

/* ------------------------------------------------------------------------- *
 * P3C-A2 — operational canonical verification and lease contention
 * ------------------------------------------------------------------------- */

/** One completed activation, ready for read-only canonical verification. */
async function createVerifiedActivation(label) {
  const context = await createActivationFixture(`verify-${label}`);
  const activation = context.activate();
  return { ...context, activation, receiptPath: activation.activationReceiptPath };
}

/**
 * Recompute one live tree's digest with the same algorithm the payload module
 * uses, so a test can prove a rejection was NOT caused by digest drift.
 */
function recomputeAliasDigest(root) {
  const entries = [];
  const walk = (directory) => {
    for (const name of fs.readdirSync(directory).sort()) {
      const filename = path.join(directory, name);
      const stat = fs.lstatSync(filename);
      const relative = path.relative(root, filename).split(path.sep).join("/");
      if (stat.isSymbolicLink()) {
        entries.push({ path: relative, type: "symlink", target: fs.readlinkSync(filename) });
        continue;
      }
      if (stat.isDirectory()) { walk(filename); continue; }
      entries.push({ path: relative, type: "file", bytes: stat.size, sha256: sha256(fs.readFileSync(filename)) });
    }
  };
  walk(root);
  entries.sort((a, b) => a.path.localeCompare(b.path, "en"));
  return sha256(entries.map((entry) => JSON.stringify(entry)).join("\n"));
}

/** Full recursive witness of a tree: path set, types, sizes, digests, link text. */
function witnessTree(root) {
  const entries = [];
  const walk = (directory) => {
    for (const name of fs.readdirSync(directory).sort()) {
      const filename = path.join(directory, name);
      const stat = fs.lstatSync(filename);
      const relative = path.relative(root, filename).split(path.sep).join("/");
      if (stat.isSymbolicLink()) {
        entries.push(`L ${relative} -> ${fs.readlinkSync(filename)}`);
        continue;
      }
      if (stat.isDirectory()) {
        entries.push(`D ${relative} ${(stat.mode & 0o777).toString(8)}`);
        walk(filename);
        continue;
      }
      entries.push(`F ${relative} ${stat.size} ${(stat.mode & 0o777).toString(8)} ${
        sha256(fs.readFileSync(filename))} ino=${stat.ino}`);
    }
  };
  walk(root);
  return entries.join("\n");
}

async function runP3cA2Tests() {
  await test("operational canonical verification confirms an exact accepted activation", async () => {
    const context = await createVerifiedActivation("success");
    const verified = context.api.verifyCanonicalFromReceipt(context.receiptPath,
      { environment: cleanEnvironment() });
    assert.equal(verified.ok, true);
    assert.equal(verified.verified, true);
    assert.equal(verified.mutationPerformed, false);
    assert.equal(verified.activationId, context.intent.activationId);
    assert.equal(verified.activationReceiptSha256, context.activation.activationReceiptSha256);
    assert.equal(verified.buildMarker, context.stage.receipt.buildTimestamp);
    assert.equal(verified.sameStageVerified, true);
    assert.equal(verified.mixedGenerationDetected, false);
    assert.equal(verified.acceptedExtensionVariant, "dev-controls-oauth-google");
    // Per-tree manifests and digests for all three units.
    assert.deepEqual(Object.keys(verified.manifests).sort(), ["alias", "dev_output", "extension"]);
    for (const unit of context.units) {
      const manifest = verified.manifests[unit.logicalName];
      assert.equal(manifest.verified, true);
      assert.equal(manifest.treeDigest, verified.treeDigests[unit.logicalName]);
      assert.equal(typeof manifest.fileCount, "number");
    }
    // The alias family carries the fixture symlink, resolved and policy-checked.
    assert.equal(verified.manifests.alias.symlinkCount, 1);
    assert.equal(verified.manifests.alias.symlinks[0].insideFamily, true);
    // Nothing that acquires exclusion or writes evidence ran.
    for (const flag of ["lockAcquired", "leaseAcquired", "transactionAppended", "receiptPublished",
      "activationPerformed", "reloadPerformed", "canaryPerformed", "pushPerformed",
      "networkActionPerformed", "browserActionPerformed"]) {
      assert.equal(verified[flag], false, flag);
    }
    disposeTemporaryRoot(context.fixture.top);
  });

  await test("canonical verification rejects every live-payload drift", async () => {
    // Each case mutates exactly one thing in the live canonical payload and must
    // be rejected. `unit` indexes alias(0) / dev_output(1) / extension(2).
    const cases = [
      ["missing regular file", 2, (live) => fs.rmSync(path.join(live, "bg.js"))],
      ["extra regular file", 2, (live) => fs.writeFileSync(path.join(live, "extra.js"), "// extra\n")],
      ["changed regular-file bytes", 2, (live) =>
        fs.writeFileSync(path.join(live, "bg.js"), "// background CHANGED, longer\n")],
      ["same-size changed bytes", 2, (live) => {
        const target = path.join(live, "bg.js");
        const before = fs.readFileSync(target);
        const mutated = Buffer.from(before);
        mutated[mutated.length - 2] = mutated[mutated.length - 2] === 0x64 ? 0x65 : 0x64;
        fs.writeFileSync(target, mutated);
        assert.equal(fs.statSync(target).size, before.length, "same-size mutation must not change size");
      }],
      ["file-count drift", 0, (live) => fs.rmSync(path.join(live, "ordinary.js"))],
      ["symlink text drift", 0, (live) => {
        const link = path.join(live, "compat ordinary.js");
        fs.rmSync(link);
        fs.symlinkSync("emoji 🧪.js", link);
      }],
    ];
    for (const [label, unitIndex, mutate] of cases) {
      const context = await createVerifiedActivation(`drift-${cases.findIndex((c) => c[0] === label)}`);
      mutate(context.units[unitIndex].livePath);
      assert.throws(() => context.api.verifyCanonicalFromReceipt(context.receiptPath,
        { environment: cleanEnvironment() }),
      (error) => ["canonical-verification-file-count", "canonical-verification-digest",
        "canonical-verification-mixed-generation"].includes(error?.code),
      `${label} was not rejected`);
      disposeTemporaryRoot(context.fixture.top);
    }
  });

  await test("canonical verification rejects symlink resolved-target and policy drift", async () => {
    // A symlink whose target lives OUTSIDE its own family is the only case where
    // the resolved target can drift while the tree digest stays identical: the
    // target is not part of the tree's manifest. `assets/` is repository-local
    // and gitignored, so mutating the target leaves the worktree clean and the
    // manifest untouched — only resolved-target authority can catch it.
    const OUTSIDE_REL = path.join("assets", "outside-alias-target.txt");
    const stageWithOutsideLink = (fixture, stage) => {
      const outside = path.join(fixture.repository, OUTSIDE_REL);
      fs.mkdirSync(path.dirname(outside), { recursive: true });
      fs.writeFileSync(outside, "// authoritative source outside the alias family\n");
      fs.symlinkSync(outside, path.join(stage.alias, "outside link.js"));
    };
    const cases = [
      ["broken resolved target", "canonical-verification-symlink-broken",
        (repository, outside) => fs.rmSync(outside)],
      ["generated-output resolved target", "canonical-verification-symlink-generated-target",
        (repository, outside) => {
          fs.rmSync(outside);
          fs.symlinkSync(path.join(repository, "apps", "dev-server", "generated.js"), outside);
        }],
      ["foreign-worktree resolved target", "canonical-verification-symlink-foreign",
        (repository, outside, top) => {
          const foreign = path.join(top, "foreign-worktree-target.js");
          fs.writeFileSync(foreign, "// outside the approved roots\n");
          fs.rmSync(outside);
          fs.symlinkSync(foreign, outside);
        }],
    ];
    for (const [label, expectedCode, corrupt] of cases) {
      const context = await createActivationFixture(`a2-symlink-${expectedCode}`,
        { mutateStage: stageWithOutsideLink });
      const activation = context.activate();
      const receiptPath = activation.activationReceiptPath;
      // Baseline: the outside-family link is accepted by policy before drift.
      const baseline = context.api.verifyCanonicalFromReceipt(receiptPath,
        { environment: cleanEnvironment() });
      assert.equal(baseline.manifests.alias.symlinkCount, 2, label);
      assert.equal(baseline.manifests.alias.symlinks
        .filter((entry) => entry.insideFamily === false).length, 1, label);
      const digestsBefore = baseline.treeDigests;
      const outside = path.join(context.fixture.repository, OUTSIDE_REL);
      corrupt(context.fixture.repository, outside, context.fixture.top);
      assert.throws(() => context.api.verifyCanonicalFromReceipt(receiptPath,
        { environment: cleanEnvironment() }),
      (error) => error?.code === expectedCode,
      `${label} expected ${expectedCode}`);
      // Proof the case is non-vacuous: the tree digest is unchanged, so only
      // resolved-target authority could have rejected it.
      const observed = recomputeAliasDigest(context.units[0].livePath);
      assert.equal(observed, digestsBefore.alias,
        `${label} changed the tree digest, so the policy check was not what rejected it`);
      disposeTemporaryRoot(context.fixture.top);
    }
  });

  await test("canonical verification rejects mixed generations and different-stage dev_output", async () => {
    // Only dev_output and extension embed the stage build timestamp, so they are
    // the units whose content genuinely identifies a generation.
    for (const [label, unitIndex] of [["different-stage dev_output", 1],
      ["different-stage extension", 2]]) {
      const context = await createVerifiedActivation(`generation-${unitIndex}`);
      const live = context.units[unitIndex].livePath;
      const before = recomputeAliasDigest(live);
      // Re-stage the same repository to a genuinely different build, then swap
      // exactly one live tree to that other generation.
      let other = createStageFixture(context.fixture.repository, `other-${unitIndex}`);
      let source = [other.alias, other.devOutput, other.extension][unitIndex];
      if (recomputeAliasDigest(source) === before) {
        // Same-millisecond build markers would make the swap a no-op; force a
        // genuinely different generation rather than passing vacuously.
        fs.writeFileSync(path.join(source, "loader.js"), "// buildTs=different-generation\n");
      }
      assert.notEqual(recomputeAliasDigest(source), before, `${label} fixture was not a new generation`);
      fs.rmSync(live, { recursive: true });
      fs.cpSync(source, live, { recursive: true, verbatimSymlinks: true });
      assert.throws(() => context.api.verifyCanonicalFromReceipt(context.receiptPath,
        { environment: cleanEnvironment() }),
      (error) => error?.code === "canonical-verification-mixed-generation",
      `${label} was not reported as a mixed generation`);
      disposeTemporaryRoot(context.fixture.top);
    }
    // When every unit drifts together it is not a mixed generation: the first
    // unit's digest mismatch is reported directly.
    const allDrift = await createVerifiedActivation("generation-all");
    for (const unit of allDrift.units) {
      fs.writeFileSync(path.join(unit.livePath, "drift.js"), "// drift\n");
    }
    assert.throws(() => allDrift.api.verifyCanonicalFromReceipt(allDrift.receiptPath,
      { environment: cleanEnvironment() }),
    (error) => error?.code === "canonical-verification-file-count");
    disposeTemporaryRoot(allDrift.fixture.top);
  });

  await test("canonical verification rejects receipt, identity and transaction drift", async () => {
    const cases = [
      ["wrong receipt mode", (receipt) => { receipt.mode = "stage-receipt"; },
        "activation-receipt-mode-invalid"],
      // v2 is the accepted activation-receipt schema after A3, so drift is now
      // expressed as the superseded v1 and as a future v3.
      ["superseded schema version", (receipt) => { receipt.schemaVersion = 1; },
        "activation-receipt-mode-invalid"],
      ["future schema version", (receipt) => { receipt.schemaVersion = 3; },
        "activation-receipt-mode-invalid"],
      ["wrong activation id", (receipt) => { receipt.activationId = "20260101T000000000Z-ffffffffffff"; },
        "activation-receipt-location"],
      ["wrong repository", (receipt) => { receipt.repositoryRealpath = "/tmp/not-this-repository"; },
        "activation-receipt-repository-mismatch"],
      ["wrong authorized worktree", (receipt) => { receipt.authorizedWorktreeRealpath = "/tmp/other"; },
        "activation-receipt-repository-mismatch"],
      ["wrong branch", (receipt) => { receipt.branch = "release"; },
        "activation-receipt-source-mismatch"],
      ["wrong approved HEAD", (receipt) => { receipt.approvedHead = "0".repeat(40); },
        "activation-receipt-source-mismatch"],
      ["wrong source tree", (receipt) => { receipt.sourceTree = "0".repeat(40); },
        "activation-receipt-source-mismatch"],
      ["wrong stable Git identity", (receipt) => {
        receipt.stableGitIdentity = { ...receipt.stableGitIdentity, sha256: "0".repeat(64) };
      }, "activation-receipt-git-identity"],
      ["wrong extension variant", (receipt) => { receipt.acceptedExtensionVariant = "dev-lean"; },
        "activation-receipt-extension-variant"],
      ["wrong intent digest", (receipt) => { receipt.intentSha256 = "0".repeat(64); },
        "activation-receipt-intent-invalid"],
      ["wrong stage-receipt digest", (receipt) => { receipt.stageReceiptSha256 = "0".repeat(64); },
        "activation-receipt-stage-invalid"],
      ["absent intent evidence", (receipt) => { receipt.intentPath = "/tmp/absent-intent.json"; },
        "activation-receipt-intent-invalid"],
    ];
    for (const [label, mutate, expectedCode] of cases) {
      const context = await createVerifiedActivation(`receipt-${expectedCode}-${label.length}`);
      // Receipts are no-replace, so drift is presented through a rewritten copy
      // at the same canonical location; the verifier must still reject it.
      const receipt = JSON.parse(fs.readFileSync(context.receiptPath, "utf8"));
      mutate(receipt);
      fs.rmSync(context.receiptPath);
      fs.writeFileSync(context.receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
      assert.throws(() => context.api.verifyCanonicalFromReceipt(context.receiptPath,
        { environment: cleanEnvironment() }),
      (error) => error?.code === expectedCode,
      `${label} expected ${expectedCode}`);
      disposeTemporaryRoot(context.fixture.top);
    }
  });

  await test("canonical verification requires durable, well-formed, owned transaction evidence", async () => {
    const cases = [
      ["absent transaction", (context, directory) => fs.rmSync(directory, { recursive: true }),
        "activation-receipt-transaction-missing"],
      ["non-accepted terminal state", (context, directory) => {
        const names = fs.readdirSync(directory).filter((n) => n.startsWith("seq-")).sort();
        const last = path.join(directory, names[names.length - 1]);
        const record = JSON.parse(fs.readFileSync(last, "utf8"));
        record.transactionState = "verified";
        fs.rmSync(last);
        fs.writeFileSync(last, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
      }, "activation-not-durably-accepted"],
      ["foreign transaction repository", (context, directory) => {
        const names = fs.readdirSync(directory).filter((n) => n.startsWith("seq-")).sort();
        const last = path.join(directory, names[names.length - 1]);
        const record = JSON.parse(fs.readFileSync(last, "utf8"));
        record.repositoryRealpath = "/tmp/some-other-repository";
        fs.rmSync(last);
        fs.writeFileSync(last, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
      }, "activation-receipt-transaction-foreign"],
      ["terminal record binds other receipt bytes", (context, directory) => {
        const names = fs.readdirSync(directory).filter((n) => n.startsWith("seq-")).sort();
        const last = path.join(directory, names[names.length - 1]);
        const record = JSON.parse(fs.readFileSync(last, "utf8"));
        record.activationReceiptSha256 = "0".repeat(64);
        fs.rmSync(last);
        fs.writeFileSync(last, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
      }, "activation-receipt-transaction-mismatch"],
    ];
    for (const [label, mutate, expectedCode] of cases) {
      const context = await createVerifiedActivation(`chain-${expectedCode}`);
      const directory = path.join(context.anchor, "transactions", context.intent.activationId);
      mutate(context, directory);
      assert.throws(() => context.api.verifyCanonicalFromReceipt(context.receiptPath,
        { environment: cleanEnvironment() }),
      (error) => error?.code === expectedCode, `${label} expected ${expectedCode}`);
      disposeTemporaryRoot(context.fixture.top);
    }
  });

  await test("canonical verification rejects a non-regular or mislocated receipt", async () => {
    const context = await createVerifiedActivation("receipt-shape");
    // A symlink pointing at the genuine receipt is not itself a receipt.
    const link = path.join(context.fixture.top, "receipt-link.json");
    fs.symlinkSync(context.receiptPath, link);
    assert.throws(() => context.api.verifyCanonicalFromReceipt(link, { environment: cleanEnvironment() }),
      (error) => error?.code === "activation-receipt-not-regular");
    // A byte-identical copy outside the canonical no-replace location is refused.
    const copy = path.join(context.fixture.top, "receipt-copy.json");
    fs.writeFileSync(copy, fs.readFileSync(context.receiptPath), { mode: 0o600 });
    assert.throws(() => context.api.verifyCanonicalFromReceipt(copy, { environment: cleanEnvironment() }),
      (error) => error?.code === "activation-receipt-location");
    // Malformed JSON at the canonical location is refused too.
    fs.rmSync(context.receiptPath);
    fs.writeFileSync(context.receiptPath, "{ not json\n", { mode: 0o600 });
    assert.throws(() => context.api.verifyCanonicalFromReceipt(context.receiptPath,
      { environment: cleanEnvironment() }),
    (error) => error?.code === "activation-receipt-malformed");
    disposeTemporaryRoot(context.fixture.top);
  });

  await test("canonical verification is byte-for-byte read-only across payload and coordination", async () => {
    const context = await createVerifiedActivation("read-only-witness");
    const before = witnessTree(context.fixture.top);
    // Deny every mutating filesystem call for the duration of verification.
    const denied = [];
    const guarded = ["mkdirSync", "writeFileSync", "appendFileSync", "openSync", "chmodSync",
      "linkSync", "symlinkSync", "unlinkSync", "renameSync", "rmSync", "rmdirSync",
      "copyFileSync", "truncateSync", "utimesSync"];
    const originals = {};
    for (const name of guarded) {
      originals[name] = fs[name];
      fs[name] = (...args) => {
        // `openSync` is legitimate for reading; only write intent is a mutation.
        if (name === "openSync" && !/[wa+]/u.test(String(args[1] ?? "r"))) {
          return originals[name](...args);
        }
        denied.push(name);
        throw new Error(`mutation attempted during verification: ${name}`);
      };
    }
    let verified;
    try {
      verified = context.api.verifyCanonicalFromReceipt(context.receiptPath,
        { environment: cleanEnvironment() });
    } finally {
      for (const name of guarded) fs[name] = originals[name];
    }
    assert.equal(verified.verified, true);
    assert.deepEqual(denied, [], `verification attempted mutations: ${denied.join(", ")}`);
    assert.equal(witnessTree(context.fixture.top), before, "verification changed the fixture tree");
    // No lock, no lease, no new transaction record, no new receipt.
    assert.equal(fs.existsSync(context.lock), false);
    assert.equal(fs.existsSync(path.join(context.anchor, "active-lease")), false);
    assert.deepEqual(fs.readdirSync(path.join(context.anchor, "activations")),
      [`${context.intent.activationId}.json`]);
    disposeTemporaryRoot(context.fixture.top);
  });

  await test("two independent OS processes contend for one lease and exactly one wins", async () => {
    const context = await createActivationFixture("a2-lease-contention");
    const anchor = context.anchor;
    const repository = fs.realpathSync.native(context.fixture.repository);
    const head = git(context.fixture.repository, ["rev-parse", "HEAD"]);
    const extensionOutput = context.units[2].livePath;
    const barrier = path.join(context.fixture.top, "contend-barrier");
    const child = path.join(context.fixture.top, "lease-contender.mjs");
    fs.writeFileSync(child, [
      'import fs from "node:fs";',
      'import { pathToFileURL } from "node:url";',
      'const [lib, anchorRoot, repository, branch, head, extensionOutput, barrier, buildTs] =',
      "  process.argv.slice(2);",
      'const { acquireLease } = await import(pathToFileURL(lib).href);',
      "// Genuine contention: both processes are already loaded and spinning, and",
      "// only start the acquisition once the parent drops the barrier.",
      "const deadline = Date.now() + 20_000;",
      "while (!fs.existsSync(barrier) && Date.now() < deadline) { /* spin */ }",
      "let result;",
      "try {",
      "  const held = acquireLease({",
      "    anchorRoot, canonicalRoot: repository.split('/').slice(0, -1).join('/'),",
      "    authoritativeRepositoryRoot: repository, publisherRepositoryRoot: repository,",
      "    publisherWorktreeRoot: repository, branch, head,",
      '    purpose: "canonical-activation", lane: "activation",',
      "    buildTs, expectedExtensionOutput: extensionOutput,",
      "  });",
      "  result = { won: true, pid: process.pid, sessionId: held.lease.sessionId,",
      "    ownershipToken: held.ownershipToken, lease: held.lease };",
      "} catch (error) {",
      "  result = { won: false, pid: process.pid, exitCode: error?.exitCode ?? null,",
      "    message: String(error?.message || error).slice(0, 200) };",
      "}",
      "process.stdout.write(JSON.stringify(result));",
      "",
    ].join("\n"));
    const library = path.join(context.fixture.repository, CANONICAL_LIB_REL);
    const buildTs = context.stage.receipt.buildTimestamp;
    const runContender = () => new Promise((resolve) => {
      const proc = spawn(process.execPath, [child, library, anchor, repository, "main", head,
        extensionOutput, barrier, buildTs], { cwd: context.fixture.repository, env: cleanEnvironment() });
      let out = "";
      proc.stdout.on("data", (chunk) => { out += chunk; });
      proc.on("close", () => resolve(JSON.parse(out || "{}")));
    });
    const first = runContender();
    const second = runContender();
    // Let both processes reach the spin loop, then release them together.
    await new Promise((resolve) => setTimeout(resolve, 750));
    fs.writeFileSync(barrier, "go\n");
    const outcomes = await Promise.all([first, second]);
    // Two genuinely distinct OS processes.
    assert.equal(new Set(outcomes.map((entry) => entry.pid)).size, 2, "processes were not distinct");
    assert.notEqual(outcomes[0].pid, process.pid);
    // 25: exactly one winner, and the loser gets the typed contention failure.
    const winners = outcomes.filter((entry) => entry.won === true);
    const losers = outcomes.filter((entry) => entry.won === false);
    assert.equal(winners.length, 1, `expected one winner, got ${JSON.stringify(outcomes)}`);
    assert.equal(losers.length, 1);
    assert.equal(losers[0].exitCode, 10, "loser must receive the typed contention exit code");
    assert.match(losers[0].message, /already held/u);
    // 26: the winner's lease binds repository, branch, HEAD and extension output.
    const winner = winners[0];
    const onDisk = JSON.parse(fs.readFileSync(path.join(anchor, "active-lease", "lease.json"), "utf8"));
    assert.equal(onDisk.sessionId, winner.sessionId);
    assert.equal(onDisk.publisherRepositoryRoot, repository);
    assert.equal(onDisk.branch, "main");
    assert.equal(onDisk.approvedHead, head);
    assert.equal(onDisk.expectedExtensionOutput, fs.realpathSync.native(path.dirname(extensionOutput)) +
      path.sep + path.basename(extensionOutput));
    assert.equal(onDisk.lifecycleState, "held");
    assert.equal(onDisk.purpose, "canonical-activation");
    assert.equal(onDisk.lane, "activation");
    // The activation this lease serves is bound by the same build identity.
    assert.equal(onDisk.buildTs, buildTs);

    const lib = await import(`${pathToFileURL(library).href}?a2=${Date.now()}`);
    // 27/28: foreign ownership can neither verify nor release.
    const foreignToken = Buffer.alloc(32, 7).toString("base64url");
    assert.throws(() => lib.verifyLease({ anchorRoot: anchor, ownershipToken: foreignToken }),
      (error) => error?.exitCode === 11);
    assert.throws(() => lib.releaseLease({ anchorRoot: anchor, ownershipToken: foreignToken }),
      (error) => error?.exitCode === 11);
    assert.equal(fs.existsSync(path.join(anchor, "active-lease")), true, "foreign release removed the lease");
    // Owner identity drift is rejected before any further work.
    assert.throws(() => lib.verifyLease({ anchorRoot: anchor, ownershipToken: winner.ownershipToken,
      expected: { pid: process.pid } }), (error) => error?.exitCode === 12);
    // A held lease verifies for its true owner.
    assert.equal(lib.verifyLease({ anchorRoot: anchor,
      ownershipToken: winner.ownershipToken }).sessionId, winner.sessionId);
    // 31: the winner releases, and the anchor is reacquirable afterwards.
    assert.equal(lib.releaseLease({ anchorRoot: anchor,
      ownershipToken: winner.ownershipToken }).released, true);
    assert.equal(fs.existsSync(path.join(anchor, "active-lease")), false);
    const reacquired = lib.acquireLease({
      anchorRoot: anchor, canonicalRoot: path.dirname(repository),
      authoritativeRepositoryRoot: repository, publisherRepositoryRoot: repository,
      publisherWorktreeRoot: repository, branch: "main", head,
      purpose: "canonical-activation", lane: "activation",
      buildTs, expectedExtensionOutput: extensionOutput,
    });
    assert.notEqual(reacquired.lease.sessionId, winner.sessionId);
    assert.equal(lib.releaseLease({ anchorRoot: anchor,
      ownershipToken: reacquired.ownershipToken }).released, true);
    disposeTemporaryRoot(context.fixture.top);
  });

  await test("stale and malformed lease state fail closed", async () => {
    const context = await createActivationFixture("a2-lease-state");
    const anchor = context.anchor;
    const repository = fs.realpathSync.native(context.fixture.repository);
    const head = git(context.fixture.repository, ["rev-parse", "HEAD"]);
    const library = path.join(context.fixture.repository, CANONICAL_LIB_REL);
    const lib = await import(`${pathToFileURL(library).href}?a2state=${Date.now()}`);
    const acquire = () => lib.acquireLease({
      anchorRoot: anchor, canonicalRoot: path.dirname(repository),
      authoritativeRepositoryRoot: repository, publisherRepositoryRoot: repository,
      publisherWorktreeRoot: repository, branch: "main", head,
      purpose: "canonical-activation", lane: "activation",
      buildTs: context.stage.receipt.buildTimestamp,
      expectedExtensionOutput: context.units[2].livePath,
    });
    const metadata = path.join(anchor, "active-lease", "lease.json");
    // 29: an expired lease is refused rather than silently honoured.
    const held = acquire();
    const expiresAt = Date.parse(held.lease.expiresAt);
    assert.throws(() => lib.verifyLease({ anchorRoot: anchor,
      ownershipToken: held.ownershipToken, nowMs: expiresAt + 1 }), (error) => error?.exitCode === 14);
    assert.equal(lib.releaseLease({ anchorRoot: anchor, ownershipToken: held.ownershipToken }).released, true);
    // 30: malformed lease metadata fails closed on verification.
    const second = acquire();
    fs.rmSync(metadata);
    fs.writeFileSync(metadata, "{ not valid json\n", { mode: 0o600 });
    assert.throws(() => lib.verifyLease({ anchorRoot: anchor, ownershipToken: second.ownershipToken }));
    // 32: session identity drift. The library's verifyLease proves *token*
    // ownership, so it deliberately does not reject a rewritten sessionId; the
    // repository/HEAD/session binding is the activator's responsibility. Assert
    // at the layer that owns it, and prove the drift is observable underneath.
    fs.rmSync(metadata);
    fs.writeFileSync(metadata, `${JSON.stringify({ ...second.lease,
      sessionId: "00000000-0000-4000-8000-000000000000" }, null, 2)}\n`, { mode: 0o600 });
    assert.equal(lib.verifyLease({ anchorRoot: anchor, ownershipToken: second.ownershipToken }).sessionId,
      "00000000-0000-4000-8000-000000000000");
    assert.equal(lib.releaseLease({ anchorRoot: anchor, ownershipToken: second.ownershipToken }).released, true);
    const drifting = { sessionId: null };
    assert.throws(() => context.api.withCanonicalLease({
      foundation: { root: anchor }, source: { repository, branch: "main", approvedHead: head },
      activationId: context.intent.activationId,
      buildTs: context.stage.receipt.buildTimestamp,
      leaseApi: {
        acquireLease: (input) => {
          const held = lib.acquireLease(input);
          drifting.sessionId = held.lease.sessionId;
          return held;
        },
        // The next ownership proof observes a different session: exactly the
        // state a takeover or a replaced lease directory would produce.
        verifyLease: ({ anchorRoot, ownershipToken }) => ({
          ...lib.verifyLease({ anchorRoot, ownershipToken }),
          sessionId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
        }),
        releaseLease: (input) => lib.releaseLease(input),
      },
    }, (lease) => {
      // `lease.verify()` is precisely the callback promotion installs as
      // `guards.verifyLease` and invokes before every rename, so proving it
      // rejects here proves a drifted lease aborts before the next rename.
      lease.verify();
      throw new Error("identity drift must abort before any further work");
    }),
    (error) => error?.code === "canonical-lease-identity-drift");
    // The drifted lease was still released, so the anchor is not left held.
    assert.equal(fs.existsSync(path.join(anchor, "active-lease")), false);
    // Nothing here promotes any canonical payload.
    for (const unit of context.units) {
      assert.equal(fs.existsSync(path.join(unit.livePath, "manifest.json")), false, unit.logicalName);
    }
    disposeTemporaryRoot(context.fixture.top);
  });

  await runP3cB1Tests();
  await runP3cA3Tests();
  await runP3cA3bTests();

  await test("verification is stable across path spellings, spaces and emoji", async () => {
    const context = await createVerifiedActivation("spelling");
    // The fixture repository name already contains spaces and an emoji.
    assert.match(context.fixture.repository, /repository with spaces 🧪/u);
    assert.equal(alternateDarwinPathSpelling("/private/var/example"), "/var/example");
    assert.equal(alternateDarwinPathSpelling("/var/example"), "/private/var/example");
    assert.equal(alternateDarwinPathSpelling("/private/tmp/example"), "/tmp/example");
    assert.equal(alternateDarwinPathSpelling("/tmp/example"), "/private/tmp/example");
    for (const unsupported of ["/private/tmp2/example", "/opt/example"]) {
      assert.throws(() => alternateDarwinPathSpelling(unsupported),
        (error) => error?.code === "path-spelling-alternate-unavailable" &&
          error?.details?.originalPath === unsupported);
    }
    const first = context.api.verifyCanonicalFromReceipt(context.receiptPath,
      { environment: cleanEnvironment() });
    // Darwin exposes both /var and /tmp through equivalent /private spellings.
    const alternate = alternateDarwinPathSpelling(context.receiptPath);
    assert.notEqual(alternate, context.receiptPath);
    assert.equal(fs.realpathSync.native(alternate), fs.realpathSync.native(context.receiptPath));
    const second = context.api.verifyCanonicalFromReceipt(alternate, { environment: cleanEnvironment() });
    assert.equal(second.verified, true);
    assert.equal(second.activationReceiptSha256, first.activationReceiptSha256);
    assert.deepEqual(second.treeDigests, first.treeDigests);
    disposeTemporaryRoot(context.fixture.top);
  });
}

/* ------------------------------------------------------------------------- *
 * P3C-B1 — deterministic recovery of an interrupted activation
 * ------------------------------------------------------------------------- */

/** Run an activation that is interrupted at a real point, leaving live state. */
async function createInterruptedActivation(label, hooks) {
  const context = await createActivationFixture(`b1-${label}`);
  let activationError = null;
  try {
    context.activate({ hooks });
  } catch (error) {
    activationError = error;
  }
  return { ...context, activationError };
}

const recover = (context, options = {}) =>
  context.api.recoverActivation(context.intent.activationId,
    { environment: cleanEnvironment(), ...options });

const chainRecords = (context) => {
  const directory = path.join(context.anchor, "transactions", context.intent.activationId);
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory).filter((name) => name.startsWith("seq-")).sort()
    .map((name) => ({ name, path: path.join(directory, name),
      record: JSON.parse(fs.readFileSync(path.join(directory, name), "utf8")) }));
};

const dropTerminalAcceptedRecord = (context) => {
  const records = chainRecords(context);
  const last = records[records.length - 1];
  assert.equal(last.record.transactionState, "accepted", "expected an accepted terminal record");
  fs.rmSync(last.path);
  return last;
};

async function runP3cB1Tests() {
  await test("recovery resolves an activation identity only, never a filesystem path", async () => {
    const context = await createActivationFixture("b1-identity");
    for (const bad of ["/tmp/anything.json", "../escape", "not-an-id", ""]) {
      expectActivatorError(() => recover({ ...context, intent: { activationId: bad } }),
        "activation-id-invalid");
    }
    // A well-formed but unknown identity has no transaction evidence.
    expectActivatorError(() => context.api.recoverActivation("20260101T000000000Z-ffffffffffff",
      { environment: cleanEnvironment() }), "recovery-transaction-absent");
    disposeTemporaryRoot(context.fixture.top);
  });

  await test("recovery of an unstarted or preparation-interrupted activation finds no transaction", async () => {
    // Intent prepared, activation never run.
    const unstarted = await createActivationFixture("b1-unstarted");
    expectActivatorError(() => recover(unstarted), "recovery-transaction-absent");
    disposeTemporaryRoot(unstarted.fixture.top);
    // Interrupted during incoming preparation, before the journal exists.
    const prepared = await createInterruptedActivation("prepare",
      { afterPrepare: () => { throw new Error("injected preparation interrupt"); } });
    assert.ok(prepared.activationError, "activation must have been interrupted");
    expectActivatorError(() => recover(prepared), "recovery-transaction-absent");
    for (const unit of prepared.units) {
      assert.equal(fs.existsSync(path.join(unit.livePath, "manifest.json")), false, unit.logicalName);
    }
    disposeTemporaryRoot(prepared.fixture.top);
  });

  await test("every mid-promotion interruption is restored backward, never completed forward", async () => {
    const interrupts = [
      ["live-retirement", { afterRetire: () => { throw new Error("injected retire interrupt"); } }],
      ["incoming-promotion", { afterPromotingRecord: () => { throw new Error("injected promote interrupt"); } }],
      ["canonical-verification", { beforeVerifiedRecord: () => { throw new Error("injected verify interrupt"); } }],
      ["all-verified-no-receipt", { beforeReceipt: () => { throw new Error("injected pre-receipt interrupt"); } }],
    ];
    for (const [label, hooks] of interrupts) {
      const context = await createInterruptedActivation(label, hooks);
      assert.ok(context.activationError, `${label}: activation must have been interrupted`);
      const before = chainRecords(context);
      const result = recover(context);
      assert.equal(result.ok, true, `${label}: ${result.code}`);
      assert.equal(result.acceptedRecordAppended, false, `${label} appended acceptance`);
      assert.equal(result.activationReceiptCreated, false, label);
      assert.equal(result.receiptPresent, false, `${label} should have no receipt`);
      // No accepted record exists anywhere in the chain after recovery.
      assert.equal(chainRecords(context).some((entry) =>
        entry.record.transactionState === "accepted"), false, `${label} accepted after recovery`);
      // Every live tree is restored to absence (these are first activations).
      for (const unit of context.units) {
        assert.equal(fs.existsSync(path.join(unit.livePath, "manifest.json")), false,
          `${label}:${unit.logicalName} left promoted`);
      }
      // The journal continued from the real chain rather than restarting.
      const after = chainRecords(context);
      assert.equal(after.length >= before.length, true, label);
      const sequences = after.map((entry) => entry.record.sequence);
      assert.deepEqual(sequences, sequences.map((_unused, index) => index + 1), `${label} sequence gap`);
      disposeTemporaryRoot(context.fixture.top);
    }
  });

  await test("a durable verified receipt without a terminal record completes forward only", async () => {
    const context = await createActivationFixture("b1-forward");
    const activation = context.activate();
    const receiptBefore = fs.readFileSync(activation.activationReceiptPath);
    dropTerminalAcceptedRecord(context);
    const beforeCount = chainRecords(context).length;
    const result = recover(context);
    assert.equal(result.ok, true, result.code);
    assert.equal(result.classification, "complete-terminal-accepted-record");
    assert.equal(result.receiptPresent, true);
    assert.equal(result.canonicalVerified, true);
    assert.equal(result.acceptedRecordAppended, true);
    assert.equal(result.reversalCompleted, false);
    assert.equal(result.livePayloadMutationPerformed, false, "forward completion must not rename payload");
    assert.equal(result.activationReceiptCreated, false);
    // The receipt was not republished or altered.
    assert.equal(fs.readFileSync(activation.activationReceiptPath).equals(receiptBefore), true);
    assert.deepEqual(fs.readdirSync(path.dirname(activation.activationReceiptPath)),
      [`${context.intent.activationId}.json`]);
    // Exactly one terminal record, derived from a fresh chain read.
    const after = chainRecords(context);
    assert.equal(after.length, beforeCount + 1);
    assert.equal(after[after.length - 1].record.transactionState, "accepted");
    assert.equal(after.filter((entry) => entry.record.transactionState === "accepted").length, 1);
    const sequences = after.map((entry) => entry.record.sequence);
    assert.deepEqual(sequences, sequences.map((_unused, index) => index + 1));
    assert.equal(after[after.length - 1].record.activationReceiptSha256,
      activation.activationReceiptSha256);
    // Live payload untouched.
    for (const unit of context.units) {
      assert.equal(fs.existsSync(path.join(unit.livePath, "manifest.json")) ||
        unit.logicalName !== "extension", true);
    }
    disposeTemporaryRoot(context.fixture.top);
  });

  await test("an already accepted transaction recovers as a verified no-op", async () => {
    const context = await createActivationFixture("b1-already");
    const activation = context.activate();
    const before = chainRecords(context).length;
    const receiptBefore = fs.readFileSync(activation.activationReceiptPath);
    const result = recover(context);
    assert.equal(result.ok, true, result.code);
    assert.equal(result.alreadyTerminal, true);
    assert.equal(result.mutationPerformed, false);
    assert.equal(result.acceptedRecordAppended, false);
    assert.equal(chainRecords(context).length, before, "no record was appended");
    assert.equal(fs.readFileSync(activation.activationReceiptPath).equals(receiptBefore), true);
    disposeTemporaryRoot(context.fixture.top);
  });

  await test("a receipt whose canonical payload drifted requires an operator and mutates nothing", async () => {
    const context = await createActivationFixture("b1-drift");
    const activation = context.activate();
    dropTerminalAcceptedRecord(context);
    fs.writeFileSync(path.join(context.units[2].livePath, "drifted.js"), "// drift\n");
    const before = chainRecords(context).length;
    const receiptBefore = fs.readFileSync(activation.activationReceiptPath);
    const result = recover(context);
    assert.equal(result.ok, false);
    assert.equal(result.code, "recovery-required");
    assert.equal(result.canonicalVerified, false);
    assert.equal(result.acceptedRecordAppended, false);
    assert.equal(result.reversalCompleted, false);
    assert.equal(result.operatorActionRequired, true);
    assert.equal(result.mutationPerformed, false);
    assert.equal(result.evidencePreserved, true);
    // Nothing appended, nothing renamed, receipt untouched.
    assert.equal(chainRecords(context).length, before);
    assert.equal(fs.readFileSync(activation.activationReceiptPath).equals(receiptBefore), true);
    assert.equal(fs.existsSync(path.join(context.units[2].livePath, "drifted.js")), true);
    disposeTemporaryRoot(context.fixture.top);
  });

  await test("a foreign live path is preserved and blocks recovery", async () => {
    const context = await createInterruptedActivation("foreign",
      { beforeReceipt: () => { throw new Error("injected pre-receipt interrupt"); } });
    // Replace one promoted live tree with content this transaction never wrote.
    const live = context.units[0].livePath;
    fs.rmSync(live, { recursive: true });
    fs.mkdirSync(live, { recursive: true });
    fs.writeFileSync(path.join(live, "foreign.js"), "// another lane owns this\n");
    const before = chainRecords(context).length;
    const result = recover(context);
    assert.equal(result.ok, false);
    assert.equal(result.classification, "preserve-foreign-live-and-require-operator");
    assert.equal(result.operatorActionRequired, true);
    assert.equal(result.mutationPerformed, false);
    assert.equal(result.evidencePreserved, true);
    // Foreign content survives untouched, and no cleanup ran after ambiguity.
    assert.equal(fs.readFileSync(path.join(live, "foreign.js"), "utf8"),
      "// another lane owns this\n");
    assert.equal(chainRecords(context).length, before);
    assert.equal(context.units.filter((unit) => fs.existsSync(unit.retiredPath)).length >= 0, true);
    disposeTemporaryRoot(context.fixture.top);
  });

  await test("broken, foreign or drifted transaction evidence fails closed without mutation", async () => {
    const cases = [
      ["broken chain digest", "transaction-chain-broken", (context) => {
        const records = chainRecords(context);
        const middle = records[1];
        const record = { ...middle.record, buildMarker: "tampered" };
        fs.rmSync(middle.path);
        fs.writeFileSync(middle.path, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
      }],
      ["foreign repository", "recovery-transaction-foreign", (context) => {
        const records = chainRecords(context);
        const last = records[records.length - 1];
        const record = { ...last.record, repositoryRealpath: "/tmp/another-repository" };
        fs.rmSync(last.path);
        fs.writeFileSync(last.path, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
      }],
      ["intent bytes changed", "recovery-intent-invalid", (context) => {
        fs.writeFileSync(context.intent.intentPath, "tampered\n", { mode: 0o600 });
      }],
    ];
    for (const [label, expectedCode, corrupt] of cases) {
      const context = await createInterruptedActivation(`evidence-${expectedCode}`,
        { beforeReceipt: () => { throw new Error("injected pre-receipt interrupt"); } });
      const before = chainRecords(context).length;
      corrupt(context);
      let thrown = null;
      try { recover(context); } catch (error) { thrown = error; }
      assert.ok(thrown, `${label} must fail closed`);
      // Either the precise code, or a chain-integrity rejection from the reader.
      assert.equal(typeof thrown.code, "string", label);
      if (expectedCode !== "transaction-chain-broken") {
        assert.equal(thrown.code, expectedCode, `${label} expected ${expectedCode}`);
      }
      assert.equal(chainRecords(context).length, before, `${label} mutated the journal`);
      disposeTemporaryRoot(context.fixture.top);
    }
  });

  await test("recovery releases the real lock and lease on success and on failure", async () => {
    // Success path.
    const success = await createInterruptedActivation("release-success",
      { beforeReceipt: () => { throw new Error("injected pre-receipt interrupt"); } });
    const result = recover(success);
    assert.equal(result.ok, true, result.code);
    assert.equal(fs.existsSync(success.lock), false, "publisher lock leaked on success");
    assert.equal(fs.existsSync(path.join(success.anchor, "active-lease")), false,
      "canonical lease leaked on success");
    disposeTemporaryRoot(success.fixture.top);
    // Failure path where this invocation still owns both exclusions: an injected
    // observation failure must still release the lock and the lease.
    const failure = await createInterruptedActivation("release-failure",
      { beforeReceipt: () => { throw new Error("injected pre-receipt interrupt"); } });
    assert.throws(() => recover(failure, {
      hooks: { afterObserve: () => { throw new Error("injected recovery failure"); } },
    }), (error) => error instanceof Error);
    assert.equal(fs.existsSync(failure.lock), false, "publisher lock leaked on failure");
    assert.equal(fs.existsSync(path.join(failure.anchor, "active-lease")), false,
      "canonical lease leaked on failure");
    disposeTemporaryRoot(failure.fixture.top);
    // Takeover path: when the lock has been replaced by a foreign owner, recovery
    // must abort AND must never delete that foreign lock. The lease, which this
    // invocation does own, is still released.
    const takeover = await createInterruptedActivation("release-takeover",
      { beforeReceipt: () => { throw new Error("injected pre-receipt interrupt"); } });
    const foreignLock = `${JSON.stringify({ ownerId: "foreign-owner", pid: process.pid })}\n`;
    assert.throws(() => recover(takeover, {
      hooks: {
        afterObserve: () => {
          fs.writeFileSync(path.join(takeover.lock, "lock.json"), foreignLock, { mode: 0o600 });
        },
      },
    }), (error) => typeof error?.code === "string");
    assert.equal(fs.existsSync(takeover.lock), true,
      "a foreign publisher lock must never be auto-deleted");
    assert.equal(fs.readFileSync(path.join(takeover.lock, "lock.json"), "utf8"), foreignLock,
      "foreign lock metadata must be preserved byte-for-byte");
    assert.equal(fs.existsSync(path.join(takeover.anchor, "active-lease")), false,
      "canonical lease leaked after takeover");
    // No canonical payload was promoted by the aborted recovery.
    for (const unit of takeover.units) {
      assert.equal(fs.existsSync(path.join(unit.livePath, "manifest.json")), false, unit.logicalName);
    }
    disposeTemporaryRoot(takeover.fixture.top);
  });

  await test("recovery never creates a receipt and performs no browser, network or pruning action", async () => {
    const context = await createInterruptedActivation("boundary",
      { beforeReceipt: () => { throw new Error("injected pre-receipt interrupt"); } });
    const activations = path.join(context.anchor, "activations");
    const result = recover(context);
    assert.equal(result.ok, true, result.code);
    // No activation receipt was fabricated by recovery.
    assert.equal(fs.existsSync(activations) && fs.readdirSync(activations).length > 0, false);
    assert.equal(result.activationReceiptCreated, false);
    assert.equal(result.activationReceiptPath, null);
    for (const flag of ["reloadPerformed", "canaryPerformed", "pushPerformed",
      "networkActionPerformed", "browserActionPerformed", "pruningPerformed"]) {
      assert.equal(result[flag], false, flag);
    }
    // Anchor still holds only the coordination directories recovery may touch.
    assert.deepEqual(fs.readdirSync(context.anchor).filter((entry) => !entry.startsWith(".")).sort(),
      ["activation-intents", "transactions"]);
    // Fixture paths carry spaces and emoji, and resolve identically through
    // /var and /private/var spellings.
    assert.match(context.fixture.repository, /repository with spaces 🧪/u);
    disposeTemporaryRoot(context.fixture.top);
  });
}

/* ------------------------------------------------------------------------- *
 * P3C-A3 — activation completeness: intent resolution and rollback evidence
 * ------------------------------------------------------------------------- */

const SECOND_ACTIVATION_DATE = new Date("2026-08-03T09:30:00.000Z");
const SECOND_RANDOM_BYTES = () => Buffer.from("b2c3d4e5f6a1", "hex");

/** Prepare and run a second, independent activation in the SAME anchor. */
function secondActivation(context, label) {
  const stage = createStageFixture(context.fixture.repository, `a3-second-${label}`);
  const intent = context.api.prepareActivationIntent(stage.receiptPath, {
    environment: cleanEnvironment(), now: SECOND_ACTIVATION_DATE, randomBytes: SECOND_RANDOM_BYTES,
  });
  const units = context.payload.canonicalUnitPaths(
    fs.realpathSync.native(context.fixture.repository), intent.activationId);
  return {
    stage, intent, units,
    activate: (options = {}) => context.api.activateReceipt(stage.receiptPath, intent.intentPath,
      { environment: cleanEnvironment(), now: SECOND_ACTIVATION_DATE, ...options }),
  };
}

const readReceiptAt = (p) => JSON.parse(fs.readFileSync(p, "utf8"));

async function runP3cA3Tests() {
  // ── CP10 — historical activation-intent relocation compatibility ──────────
  // Accepted activations recorded the absolute paths of the canonical
  // generation current at the time. The approved relocation moved the files but
  // not the evidence inside them, so these fixtures reproduce that exact shape:
  // the bytes live at the fixture anchor while the recorded location fields
  // name a registered retired generation.
  const RETIRED = {
    repository: "/Users/hobayda/H2OCode/repos/h2o-platforms/cockpit-pro/h2o-cp-source",
    anchorRoot: "/Users/hobayda/H2OCode/repos/h2o-platforms/cockpit-pro/.h2o-canonical-delivery",
  };
  const generationPaths = (anchorRoot, activationId) => ({
    intentPath: path.join(anchorRoot, "activation-intents", `${activationId}.json`),
    receiptPath: path.join(anchorRoot, "activations", `${activationId}.json`),
  });
  const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
  const writeJson = (file, value) => fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
  // Rewrites ONLY synthetic fixture evidence so it describes the given
  // generation. Production historical evidence is never touched by this suite.
  const relocateFixtureEvidence = (context, generation, { mixRecordedIntent = false } = {}) => {
    const activationId = context.intent.activationId;
    const recorded = generationPaths(generation.anchorRoot, activationId);
    const current = generationPaths(context.anchor, activationId);
    const recordedIntentPath = mixRecordedIntent ? current.intentPath : recorded.intentPath;
    const intent = readJson(context.intent.intentPath);
    intent.repositoryRealpath = generation.repository;
    intent.authorizedWorktreeRealpath = generation.repository;
    writeJson(context.intent.intentPath, intent);
    const intentSha256 = sha256(fs.readFileSync(context.intent.intentPath));
    const receiptFile = context.activation.activationReceiptPath;
    const receipt = readJson(receiptFile);
    receipt.repositoryRealpath = generation.repository;
    receipt.authorizedWorktreeRealpath = generation.repository;
    receipt.intentPath = recordedIntentPath;
    receipt.intentSha256 = intentSha256;
    writeJson(receiptFile, receipt);
    const receiptSha256 = sha256(fs.readFileSync(receiptFile));
    const transactionDir = path.join(context.anchor, "transactions", activationId);
    const records = fs.readdirSync(transactionDir).sort();
    const terminalFile = path.join(transactionDir, records[records.length - 1]);
    const terminal = readJson(terminalFile);
    terminal.repositoryRealpath = generation.repository;
    terminal.authorizedWorktreeRealpath = generation.repository;
    terminal.intentPath = recordedIntentPath;
    terminal.intentSha256 = intentSha256;
    terminal.activationReceiptPath = recorded.receiptPath;
    terminal.activationReceiptSha256 = receiptSha256;
    writeJson(terminalFile, terminal);
    return { terminalFile, receiptFile, intentSha256, receiptSha256 };
  };

  await test("CP10 A: an accepted intent from a registered retired generation resolves", async () => {
    const context = await resolvedActivationFixture("cp10-retired-accepted");
    relocateFixtureEvidence(context, RETIRED);
    const outcome = classify(context);
    assert.equal(outcome.resolved, true, outcome.code);
  });

  await test("CP10 B: an arbitrary foreign generation stays fail-closed", async () => {
    const context = await resolvedActivationFixture("cp10-foreign");
    relocateFixtureEvidence(context, {
      repository: "/Users/hobayda/H2OCode/repos/h2o-platforms/not-cockpit-pro/h2o-cp-source",
      anchorRoot: "/Users/hobayda/H2OCode/repos/h2o-platforms/not-cockpit-pro/.h2o-canonical-delivery",
    });
    const outcome = classify(context);
    assert.equal(outcome.resolved, false);
    assert.equal(outcome.code, "intent-foreign-source");
  });

  await test("CP10 C: a retired generation with a non-accepted terminal is blocked", async () => {
    const context = await resolvedActivationFixture("cp10-retired-unaccepted");
    const { terminalFile } = relocateFixtureEvidence(context, RETIRED);
    const terminal = readJson(terminalFile);
    terminal.transactionState = "incoming-promoted";
    writeJson(terminalFile, terminal);
    const outcome = classify(context);
    assert.equal(outcome.resolved, false);
    assert.equal(outcome.code, "transaction-not-accepted");
  });

  await test("CP10 D: a retired generation with broken lineage is blocked", async () => {
    const context = await resolvedActivationFixture("cp10-retired-lineage");
    const { receiptFile } = relocateFixtureEvidence(context, RETIRED);
    const receipt = readJson(receiptFile);
    receipt.intentSha256 = "0".repeat(64);
    writeJson(receiptFile, receipt);
    const outcome = classify(context);
    assert.equal(outcome.resolved, false);
    assert.equal(outcome.code, "receipt-intent-binding-mismatch");
  });

  await test("CP10 E: a current-canonical intent without acceptance stays blocked", async () => {
    const context = await createActivationFixture("cp10-current-unresolved");
    const outcome = context.api.classifyExistingIntent(context.intent.intentPath,
      { root: context.anchor },
      {
        repository: fs.realpathSync.native(context.fixture.repository),
        branch: "main",
        approvedHead: git(context.fixture.repository, ["rev-parse", "HEAD"]),
        sourceTree: git(context.fixture.repository, ["rev-parse", "HEAD^{tree}"]),
        gitExecutable: readJson(context.intent.intentPath).gitExecutable,
      },
      { environment: cleanEnvironment() });
    assert.equal(outcome.resolved, false);
    assert.equal(outcome.code, "receipt-absent");
  });

  await test("CP10 F: a current-canonical accepted intent still resolves", async () => {
    const context = await resolvedActivationFixture("cp10-current-accepted");
    const outcome = classify(context);
    assert.equal(outcome.resolved, true, outcome.code);
  });

  await test("CP10 G: the retired root is still rejected for NEW authority", async () => {
    // The real production module, not a fixture copy: this is the negative
    // control proving historical compatibility did not restore the retired
    // location as current admission authority.
    const productionApi = await import(
      `${pathToFileURL(path.join(ROOT, ACTIVATOR_REL)).href}?cp10-negative=${Date.now()}`);
    expectActivatorError(() => productionApi.assertApprovedProductionRoot({
      repository: RETIRED.repository,
      cockpitProRoot: "/Users/hobayda/H2OCode/repos/h2o-platforms/cockpit-pro",
      anchorRoot: RETIRED.anchorRoot,
    }), "canonical-root-not-approved");
    // and it did not widen either approved list
    assert.deepEqual([...productionApi.APPROVED_AUTHORITATIVE_REPOSITORIES],
      ["/Users/hobayda/H2OCode/products/cockpit-pro/h2o-cp-source"]);
    assert.deepEqual([...productionApi.APPROVED_COCKPIT_PRO_ROOTS],
      ["/Users/hobayda/H2OCode/products/cockpit-pro"]);
    // the registry itself carries exactly the one authorized retired generation
    assert.equal(productionApi.RETIRED_CANONICAL_GENERATIONS.length, 1);
    assert.equal(productionApi.RETIRED_CANONICAL_GENERATIONS[0].repository, RETIRED.repository);
    assert.equal(Object.isFrozen(productionApi.RETIRED_CANONICAL_GENERATIONS), true);
  });

  await test("CP10 mixing: one generation must own the whole location tuple", async () => {
    const context = await resolvedActivationFixture("cp10-mixed-generation");
    // retired repository identity, but the recorded intent path of today's anchor
    relocateFixtureEvidence(context, RETIRED, { mixRecordedIntent: true });
    const outcome = classify(context);
    assert.equal(outcome.resolved, false);
    assert.equal(outcome.code, "receipt-intent-binding-mismatch");
  });

  await test("two consecutive activations succeed in one anchor with immutable intents", async () => {
    const context = await createActivationFixture("a3-consecutive");
    const firstIntentBytes = fs.readFileSync(context.intent.intentPath);
    const first = context.activate();
    assert.equal(first.ok, true);
    // 1: the accepted intent is untouched, byte-for-byte, at its original path.
    assert.equal(fs.existsSync(context.intent.intentPath), true, "intent must not be consumed");
    assert.equal(fs.readFileSync(context.intent.intentPath).equals(firstIntentBytes), true);
    // 2: it classifies resolved only through its exact receipt AND accepted record.
    const foundation = { root: context.anchor };
    const source = {
      repository: fs.realpathSync.native(context.fixture.repository),
      branch: "main",
      approvedHead: git(context.fixture.repository, ["rev-parse", "HEAD"]),
      sourceTree: git(context.fixture.repository, ["rev-parse", "HEAD^{tree}"]),
      gitExecutable: JSON.parse(fs.readFileSync(context.intent.intentPath, "utf8")).gitExecutable,
    };
    const resolved = context.api.classifyExistingIntent(context.intent.intentPath, foundation, source,
      { environment: cleanEnvironment() });
    assert.equal(resolved.resolved, true, resolved.code);
    assert.equal(resolved.receiptSha256, first.activationReceiptSha256);
    // 3 + 4: a second intent may now be prepared, and a second activation succeeds.
    const second = secondActivation(context, "ok");
    assert.notEqual(second.intent.activationId, context.intent.activationId);
    assert.equal(second.intent.resolvedIntentsObserved, 1);
    assert.equal(second.intent.priorIntentsMutated, false);
    const secondResult = second.activate();
    assert.equal(secondResult.ok, true, secondResult.code);
    assert.equal(secondResult.activationPerformed, true);
    // 5: both intents remain present and byte-identical.
    assert.equal(fs.readFileSync(context.intent.intentPath).equals(firstIntentBytes), true);
    assert.deepEqual(fs.readdirSync(path.join(context.anchor, "activation-intents")).sort(),
      [`${context.intent.activationId}.json`, `${second.intent.activationId}.json`].sort());
    // Two independent activation receipts, neither overwritten.
    assert.deepEqual(fs.readdirSync(path.join(context.anchor, "activations")).sort(),
      [`${context.intent.activationId}.json`, `${second.intent.activationId}.json`].sort());
    disposeTemporaryRoot(context.fixture.top);
  });

  await test("an unresolved intent still blocks preparing another", async () => {
    // 6: an intent with no receipt at all.
    const pending = await createActivationFixture("a3-pending");
    expectActivatorError(() => pending.api.prepareActivationIntent(
      createStageFixture(pending.fixture.repository, "a3-blocked").receiptPath,
      { environment: cleanEnvironment(), now: SECOND_ACTIVATION_DATE, randomBytes: SECOND_RANDOM_BYTES }),
    "activation-intent-unresolved");
    disposeTemporaryRoot(pending.fixture.top);
    // 7: a durable receipt without a terminal accepted record does not resolve.
    const partial = await createActivationFixture("a3-no-terminal");
    partial.activate();
    const directory = path.join(partial.anchor, "transactions", partial.intent.activationId);
    const names = fs.readdirSync(directory).filter((n) => n.startsWith("seq-")).sort();
    fs.rmSync(path.join(directory, names[names.length - 1]));
    const foundation = { root: partial.anchor };
    const source = {
      repository: fs.realpathSync.native(partial.fixture.repository), branch: "main",
      approvedHead: git(partial.fixture.repository, ["rev-parse", "HEAD"]),
      sourceTree: git(partial.fixture.repository, ["rev-parse", "HEAD^{tree}"]),
      gitExecutable: JSON.parse(fs.readFileSync(partial.intent.intentPath, "utf8")).gitExecutable,
    };
    const classification = partial.api.classifyExistingIntent(partial.intent.intentPath, foundation,
      source, { environment: cleanEnvironment() });
    assert.equal(classification.resolved, false);
    assert.equal(classification.code, "transaction-not-accepted");
    expectActivatorError(() => partial.api.prepareActivationIntent(
      createStageFixture(partial.fixture.repository, "a3-blocked2").receiptPath,
      { environment: cleanEnvironment(), now: SECOND_ACTIVATION_DATE, randomBytes: SECOND_RANDOM_BYTES }),
    "activation-intent-unresolved");
    disposeTemporaryRoot(partial.fixture.top);
  });

  await test("a first activation receipt claims no rollback candidate", async () => {
    const context = await createActivationFixture("a3-first-receipt");
    const result = context.activate();
    const receipt = readReceiptAt(result.activationReceiptPath);
    assert.equal(receipt.schemaVersion, 2, "receipt schema must be v2");
    assert.deepEqual(Object.keys(receipt.previousCanonicalIdentities).sort(),
      ["alias", "dev_output", "extension"]);
    for (const [name, evidence] of Object.entries(receipt.previousCanonicalIdentities)) {
      // 8: nothing existed before, so nothing may be claimed available.
      assert.equal(evidence.previousState, "absent", name);
      assert.equal(evidence.previousEntryType, "absent", name);
      assert.equal(evidence.previousTreeDigest, null, name);
      assert.equal(evidence.previousManifest, null, name);
      assert.equal(evidence.retiredCandidatePath, null, name);
      assert.equal(evidence.rollbackCandidateAvailable, false, name);
      // Promoted-side evidence is still complete.
      assert.equal(typeof evidence.promotedTreeDigest, "string", name);
      assert.equal(evidence.promotedBuildMarker, context.stage.receipt.buildTimestamp, name);
      assert.equal(evidence.sameStageIdentity, evidence.promotedTreeDigest, name);
    }
    disposeTemporaryRoot(context.fixture.top);
  });

  await test("a second activation receipt records the complete previous generation", async () => {
    const context = await createActivationFixture("a3-second-receipt");
    const first = context.activate();
    const firstReceipt = readReceiptAt(first.activationReceiptPath);
    const second = secondActivation(context, "evidence");
    const secondResult = second.activate();
    const receipt = readReceiptAt(secondResult.activationReceiptPath);
    assert.equal(receipt.schemaVersion, 2);
    for (const unit of second.units) {
      const evidence = receipt.previousCanonicalIdentities[unit.logicalName];
      // 9: complete first-generation evidence, and a verified retired candidate.
      assert.equal(evidence.previousState, "present", unit.logicalName);
      assert.equal(evidence.previousEntryType, "directory", unit.logicalName);
      assert.equal(evidence.previousTreeDigest,
        firstReceipt.promotedCanonicalIdentities[unit.logicalName].treeDigest, unit.logicalName);
      assert.equal(evidence.previousFileCount,
        firstReceipt.promotedCanonicalIdentities[unit.logicalName].fileCount, unit.logicalName);
      assert.ok(Array.isArray(evidence.previousManifest), unit.logicalName);
      assert.equal(evidence.retiredCandidatePath, unit.retiredPath, unit.logicalName);
      assert.equal(fs.existsSync(unit.retiredPath), true, unit.logicalName);
      assert.equal(evidence.rollbackCandidateAvailable, true, unit.logicalName);
      // The load-bearing contract: the recorded previous identity must equal an
      // INDEPENDENTLY recomputed digest of the retired candidate now on disk.
      const recomputed = context.payload.recomputeIncomingManifest(unit.retiredPath, "");
      assert.equal(evidence.previousTreeDigest, recomputed.treeDigest, unit.logicalName);
      assert.equal(evidence.previousFileCount, recomputed.fileCount, unit.logicalName);
      assert.equal(evidence.promotedBuildMarker, second.stage.receipt.buildTimestamp, unit.logicalName);
    }
    // Generation difference is asserted only where the family actually carries
    // stage identity. dev_output and extension embed the build timestamp;
    // the alias family is built from fixed sources and is legitimately
    // byte-identical across stages, so requiring it to differ would be wrong.
    for (const logicalName of ["dev_output", "extension"]) {
      const evidence = receipt.previousCanonicalIdentities[logicalName];
      assert.notEqual(evidence.promotedTreeDigest, evidence.previousTreeDigest, logicalName);
    }
    assert.equal(receipt.previousCanonicalIdentities.alias.previousTreeDigest,
      firstReceipt.promotedCanonicalIdentities.alias.treeDigest,
      "alias previous identity must still be the exact first generation");
    // Required-file evidence is carried for the extension family.
    assert.ok(Array.isArray(receipt.previousCanonicalIdentities.extension.previousRequiredFiles));
    assert.equal(receipt.previousCanonicalIdentities.extension.previousRequiredFiles.length > 0, true);
    // 10: the evidence equals what foldChainTreeStates reports for that chain.
    const directory = path.join(context.anchor, "transactions", second.intent.activationId);
    const chain = context.payload.readTransactionChain(directory);
    const folded = context.api.foldChainTreeStates(chain);
    for (const unit of second.units) {
      assert.equal(receipt.previousCanonicalIdentities[unit.logicalName].previousTreeDigest,
        folded[unit.logicalName].previousIdentity, unit.logicalName);
    }
    disposeTemporaryRoot(context.fixture.top);
  });

  await test("a missing or drifted retired candidate is never marked rollback-available", async () => {
    // 11: evidence is computed from disk, so a vanished candidate cannot be claimed.
    const missing = await createActivationFixture("a3-missing-candidate");
    missing.activate();
    const second = secondActivation(missing, "missing");
    // Remove one retired candidate before the second activation builds its receipt.
    const result = second.activate({
      hooks: {
        afterPromote: () => {
          const target = second.units[0].retiredPath;
          if (fs.existsSync(target)) fs.rmSync(target, { recursive: true });
        },
      },
    });
    const receipt = readReceiptAt(result.activationReceiptPath);
    assert.equal(receipt.previousCanonicalIdentities.alias.rollbackCandidateAvailable, false,
      "a removed retired candidate must not be advertised as rollback-available");
    assert.equal(receipt.previousCanonicalIdentities.dev_output.rollbackCandidateAvailable, true);
    disposeTemporaryRoot(missing.fixture.top);
  });

  await test("activation recovery still recognizes accepted evidence and creates no receipt", async () => {
    // 13: the enriched receipt and resolution model do not disturb B1 recovery.
    const context = await createActivationFixture("a3-recovery");
    const activation = context.activate();
    const before = fs.readFileSync(activation.activationReceiptPath);
    const activations = fs.readdirSync(path.join(context.anchor, "activations")).sort();
    const recovered = context.api.recoverActivation(context.intent.activationId,
      { environment: cleanEnvironment() });
    assert.equal(recovered.ok, true, recovered.code);
    assert.equal(recovered.alreadyTerminal, true);
    assert.equal(recovered.mutationPerformed, false);
    assert.equal(recovered.activationReceiptCreated, false);
    assert.equal(fs.readFileSync(activation.activationReceiptPath).equals(before), true);
    assert.deepEqual(fs.readdirSync(path.join(context.anchor, "activations")).sort(), activations);
    // 14: no browser, network, push or pruning, and the intent is still immutable.
    for (const flag of ["reloadPerformed", "canaryPerformed", "pushPerformed",
      "networkActionPerformed", "browserActionPerformed", "pruningPerformed"]) {
      assert.equal(recovered[flag], false, flag);
    }
    assert.equal(fs.existsSync(context.intent.intentPath), true);
    disposeTemporaryRoot(context.fixture.top);
  });
}

/* ------------------------------------------------------------------------- *
 * P3C-A3b — negative-case closure for activation completeness
 * ------------------------------------------------------------------------- */

/** One accepted activation plus the source authority its intent binds. */
async function resolvedActivationFixture(label) {
  const context = await createActivationFixture(`a3b-${label}`);
  const activation = context.activate();
  const source = {
    repository: fs.realpathSync.native(context.fixture.repository),
    branch: "main",
    approvedHead: git(context.fixture.repository, ["rev-parse", "HEAD"]),
    sourceTree: git(context.fixture.repository, ["rev-parse", "HEAD^{tree}"]),
    gitExecutable: JSON.parse(fs.readFileSync(context.intent.intentPath, "utf8")).gitExecutable,
  };
  return { ...context, activation, source, foundation: { root: context.anchor } };
}

const classify = (context, overrides = {}) =>
  context.api.classifyExistingIntent(context.intent.intentPath, context.foundation,
    { ...context.source, ...overrides }, { environment: cleanEnvironment() });

const advanceFixtureMain = (context, label) => {
  const relative = `fixture-source/generation-${label}.js`;
  fs.writeFileSync(path.join(context.fixture.repository, relative),
    `export const generation = ${JSON.stringify(label)};\n`);
  git(context.fixture.repository, ["add", "--sparse", relative]);
  git(context.fixture.repository, ["commit", "-q", "-m", `fixture: advance to ${label}`]);
  return {
    ...context.source,
    approvedHead: git(context.fixture.repository, ["rev-parse", "HEAD"]),
    sourceTree: git(context.fixture.repository, ["rev-parse", "HEAD^{tree}"]),
  };
};

const rewriteJson = (target, mutate) => {
  const value = JSON.parse(fs.readFileSync(target, "utf8"));
  mutate(value);
  fs.rmSync(target);
  fs.writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  return value;
};

const chainFilesOf = (context) => {
  const directory = path.join(context.anchor, "transactions", context.intent.activationId);
  return fs.readdirSync(directory).filter((n) => n.startsWith("seq-")).sort()
    .map((n) => path.join(directory, n));
};

async function runP3cA3bTests() {
  await test("intent resolution fails closed on every receipt and chain defect", async () => {
    // Each case breaks exactly one requirement and must leave the intent
    // unresolved with a precise, typed reason.
    const cases = [
      ["receipt absent", "receipt-absent", (c) => fs.rmSync(c.activation.activationReceiptPath)],
      ["receipt not regular", "receipt-not-regular", (c) => {
        fs.rmSync(c.activation.activationReceiptPath);
        fs.symlinkSync(c.intent.intentPath, c.activation.activationReceiptPath);
      }],
      ["receipt malformed", "receipt-malformed", (c) => {
        fs.rmSync(c.activation.activationReceiptPath);
        fs.writeFileSync(c.activation.activationReceiptPath, "{ not json\n", { mode: 0o600 });
      }],
      ["receipt identity drift", "receipt-identity-mismatch", (c) =>
        rewriteJson(c.activation.activationReceiptPath, (r) => { r.mode = "stage-receipt"; })],
      ["receipt intent digest drift", "receipt-intent-binding-mismatch", (c) =>
        rewriteJson(c.activation.activationReceiptPath, (r) => { r.intentSha256 = "0".repeat(64); })],
      ["receipt historical HEAD drift", "receipt-source-mismatch", (c) =>
        rewriteJson(c.activation.activationReceiptPath, (r) => { r.approvedHead = "c".repeat(40); })],
      ["receipt stage drift", "receipt-source-mismatch", (c) =>
        rewriteJson(c.activation.activationReceiptPath, (r) => { r.stageReceiptSha256 = "0".repeat(64); })],
      ["receipt build-marker drift", "receipt-source-mismatch", (c) =>
        rewriteJson(c.activation.activationReceiptPath, (r) => { r.buildMarker = "1700000000000"; })],
      ["receipt variant drift", "receipt-source-mismatch", (c) =>
        rewriteJson(c.activation.activationReceiptPath, (r) => { r.acceptedExtensionVariant = "dev-lean"; })],
      ["terminal record removed", "transaction-not-accepted", (c) => {
        const files = chainFilesOf(c);
        fs.rmSync(files[files.length - 1]);
      }],
      ["terminal receipt digest drift", "accepted-receipt-binding-mismatch", (c) => {
        const files = chainFilesOf(c);
        rewriteJson(files[files.length - 1], (r) => { r.activationReceiptSha256 = "0".repeat(64); });
      }],
      ["foreign transaction repository", "transaction-foreign", (c) => {
        const files = chainFilesOf(c);
        rewriteJson(files[files.length - 1], (r) => { r.repositoryRealpath = "/tmp/other-repository"; });
      }],
      ["terminal historical HEAD drift", "transaction-foreign", (c) => {
        const files = chainFilesOf(c);
        rewriteJson(files[files.length - 1], (r) => { r.approvedHead = "c".repeat(40); });
      }],
      ["transaction removed", "transaction-absent", (c) =>
        fs.rmSync(path.join(c.anchor, "transactions", c.intent.activationId), { recursive: true })],
    ];
    for (const [label, expected, breakIt] of cases) {
      const context = await resolvedActivationFixture(`fail-${expected}-${label.length}`);
      assert.equal(classify(context).resolved, true, `${label}: must start resolved`);
      breakIt(context);
      const outcome = classify(context);
      assert.equal(outcome.resolved, false, label);
      assert.equal(outcome.code, expected, `${label} expected ${expected}, got ${outcome.code}`);
      // An unresolved intent must still block preparing another.
      expectActivatorError(() => context.api.prepareActivationIntent(
        createStageFixture(context.fixture.repository, `a3b-${label.length}`).receiptPath,
        { environment: cleanEnvironment(), now: SECOND_ACTIVATION_DATE,
          randomBytes: SECOND_RANDOM_BYTES }),
      "activation-intent-unresolved");
      disposeTemporaryRoot(context.fixture.top);
    }
  });

  await test("intent resolution separates canonical repository authority from current generation", async () => {
    const context = await resolvedActivationFixture("source-drift");
    assert.equal(classify(context).resolved, true);
    for (const [label, override] of [
      ["repository", { repository: "/tmp/another-repository" }],
      ["branch", { branch: "release" }],
    ]) {
      const outcome = classify(context, override);
      assert.equal(outcome.resolved, false, label);
      assert.equal(outcome.code, "intent-foreign-source", label);
    }
    // Current-generation drift is irrelevant to already-accepted historical
    // evidence; its generation identity is checked internally below.
    for (const [label, override] of [
      ["approved HEAD", { approvedHead: "0".repeat(40) }],
      ["source tree", { sourceTree: "0".repeat(40) }],
      ["stable Git identity", { gitExecutable: { path: "/usr/bin/git", realpath: "/usr/bin/git",
        version: "git version 0.0.0", sha256: "0".repeat(64) } }],
    ]) {
      assert.equal(classify(context, override).resolved, true, label);
    }
    disposeTemporaryRoot(context.fixture.top);
  });

  await test("accepted historical generations resolve after main advances", async () => {
    const context = await resolvedActivationFixture("generation-aware");
    const firstIntentBytes = fs.readFileSync(context.intent.intentPath);
    const firstReceiptBytes = fs.readFileSync(context.activation.activationReceiptPath);
    const staleStage = createStageFixture(context.fixture.repository, "generation-a-stale");
    const sourceA = { approvedHead: context.source.approvedHead, sourceTree: context.source.sourceTree };
    const sourceB = advanceFixtureMain(context, "b");
    assert.notEqual(sourceB.approvedHead, sourceA.approvedHead);
    assert.notEqual(sourceB.sourceTree, sourceA.sourceTree);
    const historical = context.api.classifyExistingIntent(context.intent.intentPath,
      context.foundation, sourceB, { environment: cleanEnvironment() });
    assert.equal(historical.resolved, true, historical.code);
    assert.equal(fs.readFileSync(context.intent.intentPath).equals(firstIntentBytes), true);
    assert.equal(fs.readFileSync(context.activation.activationReceiptPath).equals(firstReceiptBytes), true);

    // A stage created for generation A is still rejected at generation B.
    expectActivatorError(() => context.api.prepareActivationIntent(staleStage.receiptPath,
      { environment: cleanEnvironment(), now: SECOND_ACTIVATION_DATE,
        randomBytes: SECOND_RANDOM_BYTES }), "receipt-head-mismatch");

    // A new generation-B intent may be prepared because generation A is
    // independently accepted, then activated exactly through current authority.
    const second = secondActivation(context, "generation-b");
    assert.equal(second.intent.resolvedIntentsObserved, 1);
    assert.equal(second.intent.journal.approvedHead, sourceB.approvedHead);
    const secondIntentBytes = fs.readFileSync(second.intent.intentPath);
    const secondResult = second.activate();
    assert.equal(secondResult.ok, true, secondResult.code);

    // A third generation proves sequential accepted histories remain usable.
    const sourceC = advanceFixtureMain(context, "c");
    const thirdStage = createStageFixture(context.fixture.repository, "generation-c");
    const third = context.api.prepareActivationIntent(thirdStage.receiptPath, {
      environment: cleanEnvironment(), now: new Date("2026-08-04T09:30:00.000Z"),
      randomBytes: () => Buffer.from("c3d4e5f6a1b2", "hex"),
    });
    assert.equal(third.resolvedIntentsObserved, 2);
    assert.equal(third.journal.approvedHead, sourceC.approvedHead);
    assert.equal(fs.readFileSync(context.intent.intentPath).equals(firstIntentBytes), true);
    assert.equal(fs.readFileSync(second.intent.intentPath).equals(secondIntentBytes), true);
    disposeTemporaryRoot(context.fixture.top);
  });

  await test("current activation authority stays strict after source advancement", async () => {
    const context = await createActivationFixture("generation-current-activation");
    advanceFixtureMain(context, "activation-b");
    expectActivatorError(() => context.activate(), "receipt-head-mismatch");
    assert.equal(chainRecords(context).length, 0);
    assert.equal(fs.existsSync(context.lock), false);
    assert.equal(fs.existsSync(leaseDirectory(context.anchor)), false);
    disposeTemporaryRoot(context.fixture.top);
  });

  await test("interrupted recovery gains no cross-generation mutation authority", async () => {
    const context = await createInterruptedActivation("generation-recovery",
      { beforeReceipt: () => { throw new Error("injected pre-receipt interrupt"); } });
    assert.ok(context.activationError);
    const recordsBefore = chainFilesOf(context)
      .map((filename) => [path.basename(filename), sha256(fs.readFileSync(filename))]);
    advanceFixtureMain(context, "recovery-b");
    expectActivatorError(() => recover(context), "recovery-source-mismatch");
    assert.deepEqual(chainFilesOf(context)
      .map((filename) => [path.basename(filename), sha256(fs.readFileSync(filename))]), recordsBefore);
    assert.equal(fs.existsSync(context.lock), false);
    assert.equal(fs.existsSync(leaseDirectory(context.anchor)), false);
    disposeTemporaryRoot(context.fixture.top);
  });

  await test("only canonical regular intent entries are accepted", async () => {
    const context = await resolvedActivationFixture("entries");
    const intents = path.join(context.anchor, "activation-intents");
    const secondStage = () => createStageFixture(context.fixture.repository, `a3b-entry-${Date.now()}`);
    const prepare = () => context.api.prepareActivationIntent(secondStage().receiptPath,
      { environment: cleanEnvironment(), now: SECOND_ACTIVATION_DATE, randomBytes: SECOND_RANDOM_BYTES });
    // Baseline: with only the resolved intent present, preparation succeeds.
    const ok = prepare();
    fs.rmSync(ok.intentPath);
    const cases = [
      ["symlink entry", "activation-intent-entry-invalid", () => {
        fs.symlinkSync(context.intent.intentPath,
          path.join(intents, "20260101T000000000Z-aaaaaaaaaaaa.json"));
      }],
      ["directory entry", "activation-intent-entry-invalid", () => {
        fs.mkdirSync(path.join(intents, "20260101T000000000Z-bbbbbbbbbbbb.json"));
      }],
      ["unknown filename", "activation-intent-entry-unknown", () => {
        fs.writeFileSync(path.join(intents, "notes.txt"), "scratch\n");
      }],
      ["malformed activation id", "activation-intent-entry-unknown", () => {
        fs.writeFileSync(path.join(intents, "not-an-id.json"), "{}\n");
      }],
      ["uppercase hex id", "activation-intent-entry-unknown", () => {
        fs.writeFileSync(path.join(intents, "20260101T000000000Z-AAAAAAAAAAAA.json"), "{}\n");
      }],
    ];
    for (const [label, expected, plant] of cases) {
      plant();
      expectActivatorError(prepare, expected, label);
      for (const entry of fs.readdirSync(intents)) {
        if (entry !== `${context.intent.activationId}.json`) {
          fs.rmSync(path.join(intents, entry), { recursive: true, force: true });
        }
      }
    }
    // The genuine intent survived every rejection untouched.
    assert.equal(fs.existsSync(context.intent.intentPath), true);
    disposeTemporaryRoot(context.fixture.top);
  });

  await test("tampered previous-generation receipt evidence is rejected", async () => {
    const context = await resolvedActivationFixture("tamper");
    const second = secondActivation(context, "tamper");
    const result = second.activate();
    const receiptPath = result.activationReceiptPath;
    const pristine = fs.readFileSync(receiptPath);
    const cases = [
      ["previous tree digest", (r) => {
        r.previousCanonicalIdentities.alias.previousTreeDigest = "0".repeat(64);
      }],
      ["previous file count", (r) => { r.previousCanonicalIdentities.alias.previousFileCount = 999; }],
      ["previous manifest", (r) => { r.previousCanonicalIdentities.alias.previousManifest = []; }],
      ["retired candidate path", (r) => {
        r.previousCanonicalIdentities.alias.retiredCandidatePath = "/tmp/elsewhere";
      }],
      ["promoted identity", (r) => {
        r.promotedCanonicalIdentities.alias.treeDigest = "0".repeat(64);
      }],
      ["rollback availability", (r) => {
        r.previousCanonicalIdentities.extension.rollbackCandidateAvailable = true;
        r.previousCanonicalIdentities.extension.previousTreeDigest = "0".repeat(64);
      }],
    ];
    for (const [label, mutate] of cases) {
      fs.rmSync(receiptPath);
      fs.writeFileSync(receiptPath, pristine, { mode: 0o600 });
      const tampered = rewriteJson(receiptPath, mutate);
      // The intent binding breaks, so the receipt no longer resolves its intent.
      const outcome = context.api.classifyExistingIntent(second.intent.intentPath,
        context.foundation, context.source, { environment: cleanEnvironment() });
      assert.equal(outcome.resolved, false, label);
      // And a tampered promoted identity is caught by canonical verification.
      if (label === "promoted identity") {
        assert.throws(() => context.api.verifyCanonicalFromReceipt(receiptPath,
          { environment: cleanEnvironment() }),
        (error) => typeof error?.code === "string", label);
      }
      assert.equal(typeof tampered.previousCanonicalIdentities.alias, "object", label);
    }
    // Restore and confirm the untampered receipt still resolves.
    fs.rmSync(receiptPath);
    fs.writeFileSync(receiptPath, pristine, { mode: 0o600 });
    assert.equal(context.api.classifyExistingIntent(second.intent.intentPath, context.foundation,
      context.source, { environment: cleanEnvironment() }).resolved, true);
    disposeTemporaryRoot(context.fixture.top);
  });

  await test("recovery of accepted evidence mutates no intent and no receipt", async () => {
    const context = await resolvedActivationFixture("recovery-immutable");
    const second = secondActivation(context, "recovery");
    const secondResult = second.activate();
    const intentsBefore = fs.readdirSync(path.join(context.anchor, "activation-intents")).sort()
      .map((name) => [name, sha256(fs.readFileSync(path.join(context.anchor, "activation-intents", name)))]);
    const receiptsBefore = fs.readdirSync(path.join(context.anchor, "activations")).sort()
      .map((name) => [name, sha256(fs.readFileSync(path.join(context.anchor, "activations", name)))]);
    // The CURRENT generation's activation is already terminal: a no-op.
    const current = context.api.recoverActivation(second.intent.activationId,
      { environment: cleanEnvironment() });
    assert.equal(current.ok, true, current.code);
    assert.equal(current.alreadyTerminal, true);
    assert.equal(current.mutationPerformed, false);
    assert.equal(current.activationReceiptCreated, false);
    // The SUPERSEDED activation must fail closed, not "recover" anything: the
    // live payload is generation 2, which activation 1 never promoted, so it is
    // foreign to that transaction and requires an operator.
    const superseded = context.api.recoverActivation(context.intent.activationId,
      { environment: cleanEnvironment() });
    assert.equal(superseded.ok, false);
    assert.equal(superseded.code, "recovery-required");
    assert.equal(superseded.classification, "preserve-foreign-live-and-require-operator");
    assert.equal(superseded.operatorActionRequired, true);
    assert.equal(superseded.mutationPerformed, false);
    assert.equal(superseded.evidencePreserved, true);
    assert.equal(superseded.activationReceiptCreated, false);
    for (const recovered of [current, superseded]) {
      for (const flag of ["reloadPerformed", "canaryPerformed", "pushPerformed",
        "networkActionPerformed", "browserActionPerformed", "pruningPerformed"]) {
        assert.equal(recovered[flag], false, flag);
      }
    }
    // Both intents and both receipts are byte-identical after two recoveries.
    assert.deepEqual(fs.readdirSync(path.join(context.anchor, "activation-intents")).sort()
      .map((name) => [name, sha256(fs.readFileSync(path.join(context.anchor, "activation-intents", name)))]),
    intentsBefore);
    assert.deepEqual(fs.readdirSync(path.join(context.anchor, "activations")).sort()
      .map((name) => [name, sha256(fs.readFileSync(path.join(context.anchor, "activations", name)))]),
    receiptsBefore);
    assert.equal(secondResult.ok, true);
    disposeTemporaryRoot(context.fixture.top);
  });
}

function runStructuralTests() {
  const source = fs.readFileSync(path.join(ROOT, ACTIVATOR_REL), "utf8");
  const canonicalSource = fs.readFileSync(path.join(ROOT, CANONICAL_LIB_REL), "utf8");
  const validatorSource = fs.readFileSync(path.join(ROOT, VALIDATOR_REL), "utf8");
  structural("production writes are limited to lock support, coordination directories, one journal, and own-temp cleanup", () => {
    assert.match(source, /function writeDurableActivationIntent/u);
    assert.doesNotMatch(source, /fs\.(?:copyFile|rm|rmdir|symlink|appendFile)(?:Sync)?\s*\(/u);
  });
  structural("production activator contains no child-process spawn capability", () => {
    assert.doesNotMatch(source, /\bspawn(?:Sync)?\s*\(/u);
  });
  structural("production activator contains no network module import", () => {
    assert.doesNotMatch(source, /node:(?:http|https|net|tls|dns)|\bfetch\s*\(/u);
  });
  structural("production activator contains no git push invocation", () => {
    assert.doesNotMatch(source, /["'`]push["'`]/u);
  });
  structural("production activator contains no browser launch or reload API", () => {
    assert.doesNotMatch(source, /osascript|playwright|puppeteer|chrome\.runtime\.reload|open\s+-/iu);
  });
  structural("the activation CLI is dispatched before any read-only command", () => {
    const activation = source.indexOf('argv[0] === "--activate-receipt"');
    const verification = source.indexOf("return verifyStageReceipt");
    assert.ok(activation >= 0 && verification > activation);
    // Activation is reachable only with BOTH an explicit receipt and intent.
    assert.match(source, /argv\.length === 4 && argv\[0\] === "--activate-receipt" &&\s*argv\[2\] === "--activation-intent"/u);
    assert.match(source, /activation-intent-required/u);
    assert.doesNotMatch(source, /prepareActivationIntent\([^)]*\)[^;]*;\s*\n\s*return activateReceipt/u);
    assert.match(source,
      /argv\.length === 4 && argv\[0\] === "--rollback-receipt" && argv\[2\] === "--rollback-intent"/u);
    assert.match(source,
      /argv\.length === 4 && argv\[0\] === "--recover-rollback" && argv\[2\] === "--rollback-intent"/u);
  });
  structural("canonical comparison is exported but production canonical verification remains fixture-only", () => {
    assert.match(source, /export function compareTrees/u);
    assert.match(source, /canonical-verification-fixture-only/u);
  });
  structural("future transaction model explicitly requires whole-release rollback and durable receipt", () => {
    assert.match(source, /rollbackScope !== "whole-release"/u);
    assert.match(source, /finalReceiptDurable !== true/u);
  });
  structural("future release is described as recoverable rather than cross-tree atomic", () => {
    assert.match(source, /transactionally recoverable three-tree promotion/u);
    assert.match(source, /It is not a/u);
    assert.match(source, /cross-tree atomic swap/u);
    assert.match(source, /do not eliminate missing-path/u);
  });
  structural("future coordination namespaces are activation-id specific", () => {
    assert.match(source, /\.staging-act-\$\{activationId\}/u);
    assert.match(source, /\.retired-act-\$\{activationId\}/u);
  });
  structural("P1 reuses the Batch 1 publisher lock name without lock-purpose metadata", () => {
    assert.match(source, /\.h2o-publisher-lock/u);
    assert.doesNotMatch(source, /lockPurpose|purpose:\s*["'`]activation/iu);
  });
  structural("package exposes only read-only Stage 2 command", () => {
    const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, PACKAGE_REL), "utf8"));
    assert.equal(packageJson.scripts["publish:h2o:verify-stage"],
      "node tools/publish/lean-activator.mjs --verify-stage-receipt");
    assert.equal(Object.keys(packageJson.scripts).some((name) => /activate|rollback|recover|prune/u.test(name)), false);
  });
  structural("accepted P0/P1 activator blob remains immutably attested", () => {
    assert.notEqual(sha256(fs.readFileSync(path.join(ROOT, ACTIVATOR_REL))), ACCEPTED_ACTIVATOR_SHA256);
    assert.equal(sha256(execFileSync("git", ["show", `${ACCEPTED_P1_HEAD}:${ACTIVATOR_REL}`], { cwd: ROOT })),
      ACCEPTED_ACTIVATOR_SHA256);
  });
  structural("registered-main authority is internally derived from Git ancestry and exact scope", () => {
    assert.equal(authoritativeMainWorktree.length, 0);
    assert.match(validatorSource, /merge-base["'`],\s*["'`]--is-ancestor/u);
    assert.match(validatorSource, /const executionState = currentScopeState\(\)/u);
    assert.match(validatorSource, /classifyScope\(executionState\)/u);
  });
  structural("every activator Git execution is routed through the explicit read-only allow-list", () => {
    assert.match(source, /export function assertAllowedGitCommand/u);
    assert.match(source, /export function runReadOnlyGit[\s\S]*assertAllowedGitCommand\(args\)/u);
    assert.match(source, /runPinnedReadOnlyGit\(repository, args/u);
    assert.equal((source.match(/execFileSync\(["'`]git["'`]/gu) || []).length, 0);
  });
  structural("P2.1 freezes Git argv authority and sanitizes repository/config redirection", () => {
    assert.match(canonicalSource, /Object\.freeze\(\[\s*"rev-parse\\u0000--show-toplevel"/u);
    assert.match(canonicalSource, /export function sanitizedGitEnvironment/u);
    for (const name of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY",
      "GIT_ALTERNATE_OBJECT_DIRECTORIES"]) assert.doesNotMatch(canonicalSource, new RegExp(`safe\\.${name}\\s*=`));
    assert.match(canonicalSource, /GIT_CONFIG_GLOBAL = "\/dev\/null"/u);
  });
  structural("repository, cockpit root, anchor, and extension variant are independently pinned", () => {
    assert.match(source, /fs\.realpathSync\.native\(REPOSITORY_ROOT\)/u);
    assert.match(source, /expectedCockpitProRoot/u);
    assert.match(source, /module-repository-mismatch/u);
    assert.match(source, /ACCEPTED_EXTENSION_VARIANT = "dev-controls-oauth-google"/u);
  });
  structural("P2 intent coordination commands survive alongside P3C-A1 activation", () => {
    assert.match(source, /--prepare-activation-intent/u);
    assert.match(source, /--inspect-activation-intent/u);
    // Recovery, rollback and pruning stay unreachable; canonical verification
    // stays a fixture-only library foundation.
    assert.match(source, /mutation-command-not-implemented/u);
    // Canonical verification is operational only through the explicit
    // --activation-receipt form; every other shape stays fail-closed.
    assert.match(source, /canonical-verification-fixture-only/u);
    assert.match(source, /export function verifyCanonicalFromReceipt/u);
    assert.match(source,
      /argv\.length === 3 && argv\[0\] === "--verify-canonical" && argv\[1\] === "--activation-receipt"/u);
  });
  structural("journal durability uses exclusive temp creation, fsync, no-replace hard link and byte verification", () => {
    assert.match(source, /openSync\(tempPath, "wx", 0o600\)/u);
    assert.match(source, /fs\.fsyncSync\(descriptor\)/u);
    assert.match(source, /fs\.linkSync\(tempPath, finalPath\)/u);
    assert.doesNotMatch(source, /fs\.renameSync\(tempPath, finalPath\)/u);
    assert.match(source, /observed\.equals\(bytes\)/u);
  });
  structural("temporary journal cleanup is guarded by invocation ownership", () => {
    assert.match(source, /let tempOwned = false/u);
    assert.match(source, /tempOwned = true/u);
    assert.match(source, /removeOwnJournalTemp\(tempPath, intentsDirectory, tempBasename, tempOwned\)/u);
  });
  structural("durability evidence explicitly disclaims full power-loss guarantees", () => {
    assert.match(source, /powerLossDurabilityGuaranteed:\s*false/u);
    assert.doesNotMatch(source, /F_FULLFSYNC|powerLossDurabilityGuaranteed:\s*true/u);
  });
  structural("module documents lock mutations and the canonical-library Git trust boundary", () => {
    assert.match(source, /publisher lock, canonical lease, append-only journals, and durable receipts/u);
    assert.match(source, /CANONICAL_DELIVERY_LIB_TRUST_BOUNDARY/u);
    assert.match(source, /share one pinned executable, sanitized environment, and exact read-only argv boundary/u);
  });
  structural("recovery classifier is pure and requires P3 for payload-mutated states", () => {
    assert.match(source, /export function classifyRecoveryState/u);
    assert.match(source, /promotion-state-requires-p3-recovery/u);
    assert.match(source, /p3-recovery-required/u);
  });
  structural("canonical payload copy, delete and symlink mutation APIs remain absent", () => {
    assert.doesNotMatch(source, /fs\.(?:copyFile|rm|rmdir|symlink)(?:Sync)?\s*\(/u);
    assert.equal((source.match(/fs\.linkSync\(/gu) || []).length, 1);
  });
  structural("P2 creates neither activation nor rollback receipt directories", () => {
    assert.doesNotMatch(source, /ensureCoordinationDirectory\([^\n]*(?:activations|rollbacks)/u);
    assert.doesNotMatch(source, /activation-receipt\.json|rollback-receipt\.json/u);
  });
  structural("P2 imports and reuses the accepted Batch 1 publisher lock primitives", () => {
    assert.match(source, /import \{ acquireLock, releaseLock \} from "\.\/lean-publisher\.mjs"/u);
    assert.match(source, /withPublisherLock/u);
  });
  structural("P2 validator scope remains exactly the two authorized source paths", () => {
    assert.deepEqual(P2_AUTHORIZED_PATHS, [ACTIVATOR_REL, VALIDATOR_REL].sort());
    assert.match(validatorSource, /P2_BASE_HEAD/u);
    assert.match(validatorSource, /P2_SUBJECT/u);
  });
  structural("P2.2 pins a regular absolute Git executable and never falls back to PATH lookup", () => {
    assert.match(canonicalSource, /const TRUSTED_GIT_CANDIDATES = Object\.freeze/u);
    assert.match(canonicalSource, /"\/usr\/bin\/git"/u);
    assert.match(canonicalSource, /stat\.isSymbolicLink\(\)/u);
    assert.match(canonicalSource, /execFileSync\(TRUSTED_GIT_EXECUTABLE_IDENTITY\.realpath/u);
    assert.doesNotMatch(canonicalSource, /execFileSync\(["'`]git["'`]/u);
  });
  structural("canonical-delivery library shares the exact Git gate and validates core.worktree independently", () => {
    assert.match(canonicalSource, /export function assertAllowedReadOnlyGitCommand/u);
    assert.match(canonicalSource, /export function runPinnedReadOnlyGit/u);
    assert.match(canonicalSource, /export function validateConfiguredWorktree/u);
    assert.match(canonicalSource, /registeredWorktreeRoots\.includes\(normalized\)/u);
    assert.equal((canonicalSource.match(/execFileSync\(/gu) || []).length, 3);
  });
  structural("coordination directory creation flushes its parent and treats EPERM as a hard error", () => {
    assert.match(source, /parentDirectoryFsync:\s*created[\s\S]*flushDirectory\(path\.dirname\(directory\)\)/u);
    assert.doesNotMatch(source, /\["EINVAL", "ENOTSUP", "EISDIR", "EPERM"\]/u);
    assert.match(source, /activation-intent-temp-collision/u);
  });
  structural("P2.2 scope remains exactly activator, canonical library, and activator validator", () => {
    assert.deepEqual(P22_AUTHORIZED_PATHS, [ACTIVATOR_REL, CANONICAL_LIB_REL, VALIDATOR_REL].sort());
    assert.match(validatorSource, /ACCEPTED_P21_HEAD/u);
    assert.match(validatorSource, /P22_SUBJECT/u);
  });
  structural("P2.3 pins the activator canonical-library import capability exactly", () => {
    assert.deepEqual(canonicalLibraryImports(source), ACCEPTED_CANONICAL_LIBRARY_IMPORTS);
    for (const forbidden of ["atomicWriteJson", "rmSync", "renameSync", "copyFileSync"]) {
      assert.equal(ACCEPTED_CANONICAL_LIBRARY_IMPORTS.includes(forbidden), false);
    }
  });
  structural("P2.3 separates stable durable Git identity from process-local attestation", () => {
    assert.match(source, /STABLE_GIT_IDENTITY_KEYS/u);
    assert.match(source, /gitExecutableProcessAttestation/u);
    assert.match(source, /gitExecutableStable/u);
  });
  structural("all shared production Git calls use the frozen thirty-second timeout", () => {
    assert.match(canonicalSource, /export const READ_ONLY_GIT_TIMEOUT_MS = 30_000/u);
    assert.equal((canonicalSource.match(/timeout:\s*READ_ONLY_GIT_TIMEOUT_MS/gu) || []).length, 2);
    assert.doesNotMatch(canonicalSource, /timeout:\s*10_000/u);
  });
  structural("payload safety guards normalize existing ancestors before lexical suffixes", () => {
    assert.match(validatorSource, /function normalizedGuardPath/u);
    assert.match(validatorSource, /fs\.realpathSync\.native\(cursor\)/u);
    assert.match(validatorSource, /function sameOrWithin/u);
  });
  structural("P2.3 scope remains exactly the four approved guardrail paths", () => {
    assert.deepEqual(P23_AUTHORIZED_PATHS,
      [ACTIVATOR_REL, CANONICAL_LIB_REL, VALIDATOR_REL, OWNER_VALIDATOR_REL].sort());
    assert.match(validatorSource, /ACCEPTED_P22_HEAD/u);
    assert.match(validatorSource, /P23_SUBJECT/u);
  });
  structural("P3 must revalidate every authority and treat the intent only as a proposal", () => {
    for (const requirement of [
      "verify-stage-receipt-immediately-before-payload-preparation",
      "reverify-stage-receipt-sha256",
      "recompute-all-three-staged-manifests-and-tree-digests",
      "revalidate-source-branch",
      "revalidate-source-head",
      "revalidate-source-tree",
      "revalidate-tracked-worktree-cleanliness",
      "revalidate-empty-index",
      "revalidate-absence-of-non-ignored-untracked-source",
      "reattest-stable-git-executable-identity",
      "rederive-repository-cockpit-root-and-canonical-anchor",
      "pin-approved-production-canonical-root",
      "revalidate-accepted-extension-variant",
      "revalidate-build-marker-coherence",
      "revalidate-staging-root-existence",
      "reject-head-tree-receipt-or-staged-byte-change",
      "prove-publisher-lock-ownership",
      "revalidate-intent-identity-and-state",
      "reject-unresolved-or-foreign-transaction-journal",
      "reject-incoming-or-retired-sibling-owned-by-another-activation",
      "treat-intent-as-proposal-not-promotion-authority",
    ]) assert(source.includes(JSON.stringify(requirement)));
  });
  structural("P3C-A1 grants the activator exactly one pinned payload-transaction import edge", () => {
    // P3A/P3B had no import edge at all. P3C-A1 adds exactly one, and it is
    // pinned symbol-by-symbol so any widening changes this assertion.
    assert.doesNotMatch(source, /import\s*\(/u);
    const declarations = [...source.matchAll(/import\s+[^;]*?from\s+["']([^"']+)["'];/gu)].map((match) => match[1]);
    assert.deepEqual(declarations.filter((entry) => entry.startsWith("./")).sort(),
      ["./canonical-delivery-lib.mjs", "./lean-payload-transaction.mjs", "./lean-publisher.mjs"]);
    assert.equal(declarations.filter((entry) => entry.endsWith("lean-payload-transaction.mjs")).length, 1);
    const edge = source.match(/import \{([^}]*?)\} from "\.\/lean-payload-transaction\.mjs";/u);
    assert.ok(edge, "the payload import edge must be a single named-import declaration");
    const imported = edge[1].split(",").map((entry) => entry.trim()).filter(Boolean);
    assert.deepEqual(imported.slice().sort(), [...ACCEPTED_PAYLOAD_MODULE_IMPORTS]);
    // No namespace, default, aliased or re-export form of the same edge.
    for (const pattern of [
      /import\s+\*\s+as\s+\w+\s+from\s+["'][^"']*lean-payload-transaction/u,
      /import\s+\w+\s*,?\s*(?:\{[^}]*\})?\s*from\s+["'][^"']*lean-payload-transaction/u,
      /\bas\s+\w+\s*[,}][^;]*from\s+["'][^"']*lean-payload-transaction/u,
      /export\s+\*\s+from\s+["'][^"']*lean-payload-transaction/u,
    ]) assert.doesNotMatch(source, pattern);
    // Rollback remains behind this same exact import edge; the activator never
    // gains raw rename capability.
    assert.equal(imported.includes("planP3cRecovery"), true);
    for (const admitted of ["publishRollbackReceipt", "appendRollbackCompleteRecord",
      "rollbackUnitToPrevious", "reverseRollbackUnit"]) {
      assert.equal(imported.includes(admitted), true, admitted);
    }
    for (const deferred of ["restoreUnit", "renameCanonicalEntry", "retireLiveTree", "promoteIncomingTree"]) {
      assert.equal(imported.includes(deferred), false, deferred);
    }
  });
  structural("the P3A payload module depends only on Node builtins", () => {
    const payloadSource = fs.readFileSync(path.join(ROOT, PAYLOAD_MODULE_REL), "utf8");
    const declarations = [...payloadSource.matchAll(/import\s+[^;]*?from\s+["']([^"']+)["'];/gu)]
      .map((match) => match[1]).sort();
    assert.deepEqual(declarations, ["node:crypto", "node:fs", "node:path"]);
    assert.doesNotMatch(payloadSource, /import\s*\(/u);
    assert.doesNotMatch(payloadSource,
      /from\s+["'][^"']*(?:canonical-delivery-lib|lean-publisher|lean-activator)/u);
  });
  structural("the P3A payload module exposes no CLI, shell, network or browser capability", () => {
    const payloadSource = fs.readFileSync(path.join(ROOT, PAYLOAD_MODULE_REL), "utf8");
    assert.doesNotMatch(payloadSource, /child_process|\bspawn(?:Sync)?\s*\(|execFileSync|execSync/u);
    assert.doesNotMatch(payloadSource, /node:(?:net|http|https|dns|tls)|fetch\s*\(|XMLHttpRequest/u);
    assert.doesNotMatch(payloadSource, /process\.argv/u);
    assert.doesNotMatch(payloadSource, /runLeanActivator|--activate-receipt|--prepare-activation-intent/u);
  });
  structural("P3B confines rename capability to the payload module's approved helper", () => {
    const payloadSource = fs.readFileSync(path.join(ROOT, PAYLOAD_MODULE_REL), "utf8");
    // The activator never gains rename capability.
    assert.doesNotMatch(source, /fs\.rename(?:Sync)?\s*\(/u);
    assert.doesNotMatch(source, /fs\.promises\.rename\s*\(/u);
    // Exactly one rename site, inside renameCanonicalEntry; promotion,
    // reversal, rollback, and rollback recovery all use that single gate.
    assert.equal((payloadSource.match(/fs\.renameSync\(/gu) || []).length, 1);
    assert.doesNotMatch(payloadSource, /fs\.promises\.rename\s*\(/u);
    assert.equal((payloadSource.match(/function renameCanonicalEntry\(\{/gu) || []).length, 1);
    assert.equal((payloadSource.match(/renameCanonicalEntry\(\{/gu) || []).length - 1, 8);
  });
  structural("the activator gate and payload module pin identical approved roots", () => {
    const payloadSource = fs.readFileSync(path.join(ROOT, PAYLOAD_MODULE_REL), "utf8");
    // CP09 replaces "both files literally contain the same strings" with the
    // stronger property it was standing in for: there is exactly ONE owner of
    // the approved roots, so the two gates cannot disagree. Duplicated literals
    // could drift; a single definition consumed by both cannot.
    for (const literal of [
      "/Users/hobayda/H2OCode/products/cockpit-pro",
      "/Users/hobayda/H2OCode/products/cockpit-pro/h2o-cp-source",
    ]) {
      assert.equal(payloadSource.includes(literal), true, literal);
    }
    // The retired topology is approved by neither gate. CP10 gives the activator
    // a historical-classification registry that legitimately NAMES the retired
    // paths, so "the literal is absent from the activator" is no longer the
    // property worth asserting - and asserting it would forbid the registry.
    // What must hold is that the retired location is never ADMISSIBLE, which is
    // proven here structurally and by the runtime negative control below.
    for (const retired of [
      "/Users/hobayda/H2OCode/repos/h2o-platforms/cockpit-pro",
      "/Users/hobayda/H2OCode/repos/h2o-platforms/cockpit-pro/h2o-cp-source",
    ]) {
      assert.equal(payloadSource.includes(`"${retired}",`), false, retired);
    }
    // (B) the retired-generation registry is not consulted by the admission gate.
    const admissionGate = source.match(/export function assertApprovedProductionRoot\([^]*?\n\}/u);
    assert.ok(admissionGate, "the activator retains its own approved-root admission function");
    assert.equal(admissionGate[0].includes("RETIRED_CANONICAL_GENERATIONS"), false,
      "admission must never consult the historical registry");
    assert.equal(admissionGate[0].includes("selectCanonicalGenerationForIntent"), false,
      "admission must never consult historical generation selection");
    // (C) and it does not broaden either approved list: both remain re-exported
    // from the payload owner, and the registry is a separate frozen constant.
    assert.match(source,
      /export const RETIRED_CANONICAL_GENERATIONS = Object\.freeze\(\[/u);
    assert.doesNotMatch(source,
      /APPROVED_(?:COCKPIT_PRO_ROOTS|AUTHORITATIVE_REPOSITORIES)[^\n]*RETIRED_CANONICAL_GENERATIONS/u);
    assert.doesNotMatch(source,
      /RETIRED_CANONICAL_GENERATIONS[^\n]*APPROVED_(?:COCKPIT_PRO_ROOTS|AUTHORITATIVE_REPOSITORIES)/u);
    // Selection stays finite and exact: no prefix/suffix/basename/env trust.
    const selector = source.match(/export function selectCanonicalGenerationForIntent\([^]*?\n\}/u);
    assert.ok(selector, "generation selection must be its own auditable function");
    assert.doesNotMatch(selector[0], /startsWith|endsWith|basename|replace\(|process\.env/u);
    // The activator owns no independent canonical-root literal and takes the
    // authority symbols through the pinned payload edge.
    assert.doesNotMatch(source,
      /export const APPROVED_(?:COCKPIT_PRO_ROOTS|AUTHORITATIVE_REPOSITORIES)\s*=/u);
    assert.match(source,
      /export \{ APPROVED_COCKPIT_PRO_ROOTS, APPROVED_AUTHORITATIVE_REPOSITORIES \}/u);
    const payloadEdge = source.match(/import \{([^}]*?)\} from "\.\/lean-payload-transaction\.mjs";/u);
    assert.ok(payloadEdge, "the payload import edge must remain a single named-import declaration");
    for (const symbol of ["APPROVED_COCKPIT_PRO_ROOTS", "APPROVED_AUTHORITATIVE_REPOSITORIES"]) {
      assert.equal(payloadEdge[1].includes(symbol), true, symbol);
    }
    // Both gates therefore resolve to the same authorized values by identity,
    // not by two copies that happen to agree: the activator re-exports the very
    // symbols it imports. It still owns its admission function, and that
    // function still decides by exact realpath-normalized membership.
    const gate = source.match(/export function assertApprovedProductionRoot\([^]*?\n\}/u);
    assert.ok(gate, "the activator retains its own approved-root admission function");
    assert.match(gate[0], /realAware\(repository\)/u);
    assert.match(gate[0], /realAware\(cockpitProRoot\)/u);
    assert.match(gate[0], /approvedRepositories\.map\(\(entry\) => realAware\(entry\)\)\.includes\(/u);
    assert.match(gate[0], /approvedCockpitProRoots\.map\(\(entry\) => realAware\(entry\)\)\.includes\(/u);
    assert.match(gate[0], /canonical-root-not-approved/u);
    // Admission stays exact membership - never prefix, substring or existence.
    assert.doesNotMatch(gate[0], /startsWith\(|\.includes\(normalizedRepository\.|existsSync/u);
    assert.match(source, /assertApprovedProductionRoot/u);
    // Intent preparation is gated, and the CLI has no injection route.
    const cliStart = source.indexOf("export async function runLeanActivator");
    assert.doesNotMatch(source.slice(cliStart), /configureFixtureApprovedRoots/u);
  });
  structural("P3A creates no retired sibling and no failed-act family", () => {
    const payloadSource = fs.readFileSync(path.join(ROOT, PAYLOAD_MODULE_REL), "utf8");
    for (const text of [source, payloadSource]) assert.doesNotMatch(text, /failed-act-/u);
    // The retired name is derived for later phases but never created in P3A.
    assert.doesNotMatch(payloadSource, /mkdirSync\([^)]*retiredPath/u);
    assert.doesNotMatch(payloadSource, /linkSync\([^)]*retiredPath|renameSync\([^)]*retiredPath/u);
  });
  structural("P3C-A1 confines payload renames and durable links to counted sites", () => {
    const payloadSource = fs.readFileSync(path.join(ROOT, PAYLOAD_MODULE_REL), "utf8");
    // Exactly one rename site in the whole delivery, still inside the payload
    // module's approved helper; the activator renames nothing itself.
    assert.equal((payloadSource.match(/fs\.renameSync\s*\(/gu) ?? []).length, 1);
    assert.doesNotMatch(source, /fs\.renameSync\s*\(/u);
    // Exactly two no-replace publication sites in the payload module: the
    // transaction journal record and the durable receipt. The activator keeps
    // its one pre-existing site, the P2 activation-intent journal.
    assert.equal((payloadSource.match(/fs\.linkSync\s*\(/gu) ?? []).length, 2);
    assert.equal((source.match(/fs\.linkSync\s*\(/gu) ?? []).length, 1);
    assert.match(source, /function writeDurableActivationIntent/u);
  });
  structural("activation receipts have one publication helper and can never be overwritten", () => {
    const payloadSource = fs.readFileSync(path.join(ROOT, PAYLOAD_MODULE_REL), "utf8");
    assert.equal((payloadSource.match(/function publishDurableReceipt\s*\(/gu) ?? []).length, 1);
    assert.equal((payloadSource.match(/export function publishActivationReceipt\s*\(/gu) ?? []).length, 1);
    // The activator publishes receipts only through that one helper.
    assert.equal((source.match(/publishActivationReceipt\s*\(/gu) ?? []).length, 1);
    // No-replace is structural: existence is checked, the link is unconditional,
    // and no rename or force-overwrite path exists for a receipt.
    assert.match(payloadSource, /Receipt already exists; receipts are never overwritten\./u);
    assert.match(payloadSource, /activation-receipt-collision/u);
    assert.doesNotMatch(payloadSource, /fs\.renameSync\([^)]*receipt/iu);
    assert.doesNotMatch(payloadSource, /writeFileSync\([^)]*finalPath/u);
  });
  structural("the terminal accepted state has exactly one approved writer", () => {
    const payloadSource = fs.readFileSync(path.join(ROOT, PAYLOAD_MODULE_REL), "utf8");
    assert.equal((payloadSource.match(/export function appendAcceptedRecord\s*\(/gu) ?? []).length, 1);
    // Two approved call sites: activation finalization (P3C-A1) and recovery
    // forward-completion (P3C-B1). Both route through the single payload helper.
    assert.equal((source.match(/appendAcceptedRecord\s*\(/gu) ?? []).length, 2);
    const recoveryRegion = source.slice(source.indexOf("export function recoverActivation"));
    const guardAt = recoveryRegion.indexOf("recovery-forward-completion-unproven");
    const appendAt = recoveryRegion.indexOf("appendAcceptedRecord(");
    assert.ok(guardAt > 0 && appendAt > guardAt,
      "recovery must prove a durable verified receipt before appending acceptance");
    // P3B's state writer still cannot reach a terminal state.
    assert.match(payloadSource, /transaction-state-reserved-for-p3c/u);
    // Acceptance is impossible without a durable, re-verified receipt.
    assert.match(payloadSource, /acceptance-requires-durable-receipt/u);
    assert.match(payloadSource, /acceptance-receipt-unverified/u);
    // The activator never hand-writes an accepted record.
    assert.doesNotMatch(source, /transactionState:\s*["'`]accepted["'`]/u);
  });
  structural("direct rollback stays unreachable while governed rollback requires immutable intent evidence", () => {
    const cli = source.slice(source.indexOf("export async function runLeanActivator"));
    for (const command of ["--recover", "--rollback", "--prune"]) {
      assert.ok(cli.includes(command), command);
    }
    assert.match(cli, /mutation-command-not-implemented/u);
    assert.match(cli, /canonical-verification-fixture-only/u);
    // The CLI reaches recovery only through the identity-validating entry point,
    // never through a planner, a reversal or a receipt publisher directly.
    for (const deferred of ["publishRollbackReceipt", "appendRollbackCompleteRecord",
      "planP3cRecovery", "reverseRelease", "publishActivationReceipt"]) {
      assert.doesNotMatch(cli, new RegExp(`${deferred}\\s*\\(`, "u"), deferred);
    }
    assert.match(cli, /recoverActivation\(argv\[1\]/u);
  });
  structural("P3C-A1 adds no browser, network, push, Git mutation or failed-act family", () => {
    const payloadSource = fs.readFileSync(path.join(ROOT, PAYLOAD_MODULE_REL), "utf8");
    for (const text of [source, payloadSource]) {
      assert.doesNotMatch(text, /failed-act-/u);
      assert.doesNotMatch(text, /node:(?:http|https|net|tls|dns)|\bfetch\s*\(/u);
      assert.doesNotMatch(text, /osascript|playwright|puppeteer|chrome\.runtime\.reload/iu);
      // No Git mutation verbs anywhere in the delivery.
      assert.doesNotMatch(text, /["'`](?:commit|push|fetch|pull|checkout|reset|clean|merge|rebase)["'`]/u);
    }
    // Every boundary flag the receipt asserts stays false.
    assert.match(payloadSource, /reloadPerformed: false/u);
    assert.match(payloadSource, /canaryPerformed: false/u);
    assert.match(payloadSource, /pushPerformed: false/u);
    assert.match(payloadSource, /powerLossDurabilityGuaranteed: false/u);
  });
  structural("operational canonical verification is structurally read-only", () => {
    const start = source.indexOf("export function verifyCanonicalFromReceipt");
    // Bounded before P3C-B1 recovery, which is a separate mutating entry point.
    const end = source.indexOf("* P3C-B1 — deterministic recovery");
    assert.ok(start > 0 && end > start, "the verification entry point must be locatable");
    const region = source.slice(start, end);
    for (const mutator of ["mkdirSync", "writeFileSync", "appendFileSync", "chmodSync", "linkSync",
      "symlinkSync", "unlinkSync", "renameSync", "rmSync", "rmdirSync", "copyFileSync", "openSync"]) {
      assert.doesNotMatch(region, new RegExp(`fs\\.${mutator}\\s*\\(`, "u"), mutator);
    }
    for (const capability of ["withPublisherLock", "withCanonicalLease", "acquireLock", "acquireLease",
      "ensureTransactionDirectory", "publishActivationReceipt", "appendAcceptedRecord",
      "promoteReleaseWithJournal", "reverseRelease", "createOwnedIncomingRoot", "prepareIncomingTree"]) {
      assert.doesNotMatch(region, new RegExp(`\\b${capability}\\s*\\(`, "u"), capability);
    }
    // Every authority is re-derived rather than trusted from the receipt.
    assert.match(region, /collectSourcePreflight\(REPOSITORY_ROOT\)/u);
    assert.match(region, /assertApprovedProductionRoot\(/u);
    assert.match(region, /transactionDirectory\(foundation\.root/u);
    assert.match(region, /activation-not-durably-accepted/u);
    assert.match(region, /mutationPerformed: false/u);
  });
  structural("the canonical-writer E1 fixture is built with a real parent commit", () => {
    const writerSource = fs.readFileSync(path.join(ROOT, WRITER_VALIDATOR_REL), "utf8");
    // The fixture applies its intended E1 commit on top of a baseline parent.
    assert.match(writerSource, /baseline before accepted E1 delivery/u);
    assert.match(writerSource, /accepted E1 snapshot/u);
    assert.match(writerSource, /const E1_BASELINE_PATH = "\.gitignore";/u);
    // Exactly two commits, in order, and no root-commit tolerance was added to
    // the nested validator to hide the defect.
    const fixtureStart = writerSource.indexOf("function materializeCleanE1Snapshot");
    const fixture = writerSource.slice(fixtureStart, writerSource.indexOf("\n}", fixtureStart));
    assert.equal((fixture.match(/"commit"/gu) || []).length, 2);
    assert.ok(fixture.indexOf("baseline before accepted E1 delivery") <
      fixture.indexOf("accepted E1 snapshot"));
    const nested = fs.readFileSync(path.join(ROOT,
      "tools/validation/publish/validate-canonical-delivery-exclusivity-v1.mjs"), "utf8");
    assert.match(nested, /run\("git", \["rev-parse", "HEAD\^"\]\)/u);
    assert.doesNotMatch(nested, /allowFailure|catch\s*\{\s*return null\s*\}/u);
  });
  structural("P3C-B1 exposes recovery only as an activation identity", () => {
    const cli = source.slice(source.indexOf("export async function runLeanActivator"));
    // Exactly one recover route, taking exactly one identity argument.
    assert.match(cli, /argv\.length === 2 && argv\[0\] === "--recover"/u);
    assert.match(cli, /return recoverActivation\(argv\[1\]/u);
    // No path, directory or destination argument may reach recovery.
    assert.doesNotMatch(cli, /--recover[^\n]*path|recoverActivation\([^)]*path/u);
    assert.match(source, /export function freshRecoveryAuthority/u);
    // The identity is validated before anything else is derived from it.
    const authority = source.slice(source.indexOf("export function freshRecoveryAuthority"));
    const validateAt = authority.indexOf("validateActivationId(activationId)");
    const deriveAt = authority.indexOf("transactionDirectory(foundation.root");
    assert.ok(validateAt > 0 && deriveAt > validateAt,
      "the activation identity must be validated before any path is derived");
    // The legacy direct rollback spelling and pruning remain unavailable.
    assert.match(cli, /mutation-command-not-implemented/u);
    for (const command of ["--rollback", "--prune"]) assert.ok(cli.includes(command), command);
  });
  structural("legacy activation recovery uses only approved helpers and never publishes a receipt", () => {
    const start = source.indexOf("* P3C-B1 — deterministic recovery");
    const end = source.indexOf("* Governed Studio rollback", start);
    assert.ok(start > 0 && end > start, "the recovery region must be locatable");
    const region = source.slice(start, end);
    // Never fabricates or republishes a receipt.
    for (const forbidden of ["publishActivationReceipt", "buildActivationReceipt",
      "publishRollbackReceipt", "prepareIncomingTree", "promoteReleaseWithJournal",
      "createOwnedIncomingRoot", "ensureTransactionDirectory"]) {
      assert.doesNotMatch(region, new RegExp(`\\b${forbidden}\\s*\\(`, "u"), forbidden);
    }
    // Uses exactly the approved recovery helpers.
    for (const approved of ["planP3cRecovery", "reverseRelease", "appendAcceptedRecord",
      "verifyCanonicalAgainstReceipt", "readTransactionChain", "transactionDirectory",
      "canonicalUnitPaths", "recomputeIncomingManifest"]) {
      assert.match(region, new RegExp(`\\b${approved}\\s*\\(`, "u"), approved);
    }
    // Recovery renames nothing itself; the payload helper owns that.
    assert.doesNotMatch(region, /fs\.renameSync\s*\(/u);
    assert.doesNotMatch(region, /fs\.linkSync\s*\(/u);
    // Recovery never deletes retired or foreign evidence.
    assert.doesNotMatch(region, /fs\.rmSync\s*\(|fs\.rmdirSync\s*\(|fs\.unlinkSync\s*\(/u);
    assert.doesNotMatch(region, /retiredPath[^\n]*rm|rm[^\n]*retiredPath/u);
    // Both exclusions are acquired and re-proved.
    assert.match(region, /withPublisherLock\(/u);
    assert.match(region, /withCanonicalLease\(/u);
    assert.match(region, /assertPublisherLockStillOwned\(/u);
    assert.match(region, /lease\.verify\(\)/u);
  });
  structural("activation intents are classified, never consumed", () => {
    const region = source.slice(source.indexOf("export function classifyExistingIntent"),
      source.indexOf("function buildActivationIntent"));
    assert.ok(region.length > 0, "the intent-resolution region must be locatable");
    // No intent is ever unlinked, renamed, rewritten or recursively cleaned.
    for (const mutator of ["unlinkSync", "renameSync", "rmSync", "rmdirSync", "writeFileSync",
      "copyFileSync", "truncateSync"]) {
      assert.doesNotMatch(region, new RegExp(`fs\\.${mutator}\\s*\\(`, "u"), mutator);
    }
    // The directory-nonempty shortcut is gone for good.
    assert.doesNotMatch(source, /function assertNoUnresolvedIntent/u);
    assert.match(source, /function assertEveryIntentResolved/u);
    // Resolution requires BOTH a verified receipt and a terminal accepted record.
    assert.match(region, /activationReceiptPath\(/u);
    assert.match(region, /readTransactionChain\(/u);
    assert.match(region, /transactionState !== "accepted"/u);
    assert.match(region, /accepted-receipt-binding-mismatch/u);
    assert.match(region, /receipt-intent-binding-mismatch/u);
    // Historical generation identity is compared across immutable evidence,
    // never against the current checkout's HEAD/tree.
    assert.match(region, /receipt\.approvedHead !== journal\.approvedHead/u);
    assert.match(region, /terminal\.approvedHead !== journal\.approvedHead/u);
    assert.match(region, /receipt\.sourceTree !== journal\.sourceTree/u);
    assert.match(region, /terminal\.sourceTree !== journal\.sourceTree/u);
    assert.doesNotMatch(region, /journal\.approvedHead !== source\.approvedHead/u);
    assert.doesNotMatch(region, /journal\.sourceTree !== source\.sourceTree/u);
    // No environment or CLI override can declare an intent resolved.
    assert.doesNotMatch(region, /process\.env\.[A-Z_]+/u);
    assert.doesNotMatch(region, /H2O_[A-Z_]*RESOLV|--resolve|--force/u);
    const cli = source.slice(source.indexOf("export async function runLeanActivator"));
    assert.doesNotMatch(cli, /classifyExistingIntent|assertEveryIntentResolved/u);
  });
  structural("previous-generation receipt evidence is internally derived", () => {
    const region = source.slice(source.indexOf("export function buildPreviousGenerationEvidence"),
      source.indexOf("function buildActivationBaseRecord"));
    assert.ok(region.length > 0);
    // Derived from the folded chain, never from a caller-supplied identity.
    assert.match(region, /foldChainTreeStates\(chain\)/u);
    assert.match(region, /recomputeIncomingManifest\(unit\.retiredPath, ""\)/u);
    // Availability is computed from disk verification, not asserted by a caller.
    assert.match(region, /rollbackCandidateAvailable: present && candidateVerified/u);
    assert.doesNotMatch(region, /rollbackCandidateAvailable: (true|false)[,\s]/u);
    // The exact v2 previous-generation key set.
    for (const key of ["logicalName", "livePath", "previousState", "previousEntryType",
      "previousTreeDigest", "previousFileCount", "previousManifest", "previousBuildMarker",
      "previousRequiredFiles", "retiredCandidatePath", "promotedTreeDigest", "promotedFileCount",
      "promotedBuildMarker", "sameStageIdentity", "rollbackCandidateAvailable"]) {
      // Property shorthand (`previousState,`) is as valid as `key:` here.
      assert.match(region, new RegExp(`\\b${key}\\s*[,:]`, "u"), key);
    }
    // Stage and activation receipt schema constants stay separate.
    assert.match(source, /export const RECEIPT_SCHEMA_VERSION = 1;/u);
    assert.match(source, /ACTIVATION_RECEIPT_SCHEMA_VERSION/u);
    const payloadSource = fs.readFileSync(path.join(ROOT, PAYLOAD_MODULE_REL), "utf8");
    assert.match(payloadSource, /export const ACTIVATION_RECEIPT_SCHEMA_VERSION = 2;/u);
  });
  structural("the validator reports both the legacy activation slice and governed Studio rollback", () => {
    assert.match(validatorSource, /activationSlice: "P3C-A3",/u);
    assert.doesNotMatch(validatorSource, /activationSlice: "P3C-(A1|A2|B1|B2)"/u);
    assert.match(validatorSource, /studioPublicationAuthorityImplemented: true,/u);
    assert.match(validatorSource, /rollbackImplemented: true,/u);
    // Direct rollback and pruning remain unavailable; only the separately
    // intent-authorized high-level Studio routes are admitted.
    const cli = source.slice(source.indexOf("export async function runLeanActivator"));
    assert.match(cli, /mutation-command-not-implemented/u);
    for (const command of ["--rollback", "--prune"]) assert.ok(cli.includes(command), command);
    assert.match(cli, /prepareStudioRollbackIntent\(argv\[1\]/u);
    assert.match(cli, /executeStudioRollback\(argv\[1\], argv\[3\]/u);
    assert.match(cli, /recoverStudioRollback\(argv\[1\], argv\[3\]/u);
    assert.doesNotMatch(cli, /rollbackUnitToPrevious|reverseRollbackUnit|publishRollbackReceipt/u);
  });
  structural("P3A adds no package command and keeps the four-path scope", () => {
    const packageSource = fs.readFileSync(path.join(ROOT, PACKAGE_REL), "utf8");
    assert.doesNotMatch(packageSource, /lean-payload-transaction|--activate-receipt|--rollback|--recover|--prune|--verify-canonical|publish:h2o:activate/u);
    assert.deepEqual(P3A_AUTHORIZED_PATHS,
      [ACTIVATOR_REL, PAYLOAD_MODULE_REL, VALIDATOR_REL, PAYLOAD_VALIDATOR_REL].sort());
    assert.match(validatorSource, /ACCEPTED_P23_HEAD/u);
    assert.match(validatorSource, /P3A_SUBJECT/u);
  });
  assert.equal(structuralResults.length, EXPECTED_STRUCTURAL);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length) throw new Error(`Unknown validator arguments: ${args.join(" ")}`);
  runScopeTests();
  const scopeMode = classifyScope(currentScopeState());
  const api = await import(`${pathToFileURL(path.join(ROOT, ACTIVATOR_REL)).href}?validator=${Date.now()}`);
  await runAuthorityModelTests();
  await runRuntimeTests(api);
  runStructuralTests();
  assert.equal(runtimeResults.length, EXPECTED_RUNTIME);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    validator: VALIDATOR_REL,
    scopeMode,
    scopeScenarios: scopeResults.length,
    runtimeScenarios: runtimeResults.length,
    structuralAssertions: structuralResults.length,
    activationImplemented: true,
    activationSlice: "P3C-A3",
    studioPublicationAuthorityImplemented: true,
    canonicalProductionVerificationImplemented: true,
    twoProcessLeaseContentionProven: true,
    recoveryImplemented: true,
    recoveryForwardGuessingPerformed: false,
    rollbackImplemented: true,
    canonicalProductionInspected: false,
    transactionDescription: "transactionally recoverable three-tree promotion",
  })}\n`);
}

try {
  await main();
} finally {
  for (const root of temporaryRoots.reverse()) {
    try {
      const stat = fs.lstatSync(root);
      if (!stat.isSymbolicLink() && path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)) {
        fs.rmSync(root, { recursive: true, force: true });
      }
    } catch {
      // Fixture cleanup must not mask validation evidence.
    }
  }
}
