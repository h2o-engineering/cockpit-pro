// @version 1.0.0  (Phase 0K: the loader build stamp is derived, never observed)
//
// Phase 0H made LOADER_BUILD_TS / LOADER_BUILD_ISO honor H2O_BUILD_TS, and
// Phase 0J removed the last path-dependent byte from README.txt. Together they
// made the Chrome artifact reproducible *when the caller remembered to lock the
// timestamp*. Nothing enforced that, so the governed production build - which
// sets no H2O_BUILD_TS - still fell through to `Date.now()`, and independent
// verification of one source revision produced a different whole-tree GATE-1 on
// every rebuild. That is the gap this module closes.
//
// The rule is: a build stamp is a fact about the SOURCE being built, not about
// the moment someone happened to run the build. Its loader timestamp is
// resolved from exactly two places, in order:
//
//   1. H2O_BUILD_TS, when explicitly supplied - the repository's existing lock,
//      reused rather than duplicated by a second SOURCE_DATE_EPOCH mechanism.
//      This is what makes a build reproducible across machines and checkouts.
//   2. Otherwise the committer timestamp of the source revision being built.
//      Same HEAD, same stamp; a different commit naturally gets a different one.
//
// There is deliberately no third timestamp case. In addition, runtime worker
// identity is always the exact full HEAD commit SHA, independent of the loader
// timestamp override. An unusable timestamp or undeterminable commit raises,
// because the failure this module exists to prevent is precisely a silent fall
// back to the wall clock or an unversioned runtime worker.

import { execFileSync } from "node:child_process";
import path from "node:path";

import { REPO_ROOT, RUNTIME_BASE_REL } from "../../../../paths.mjs";

export const CHROME_BUILD_STAMP = Object.freeze({
  ENV_VARIABLE: "H2O_BUILD_TS",
  RUNTIME_PREFIX: "h2o-runtime-v1:",
  SOURCE: Object.freeze({
    ENV: "h2o-build-ts",
    SOURCE_REVISION: "source-revision",
  }),
  ERROR: Object.freeze({
    ENV_INVALID: "chrome-build-stamp-env-invalid",
    SOURCE_REVISION_UNAVAILABLE: "chrome-build-stamp-source-revision-unavailable",
    SOURCE_ADMISSION_UNAVAILABLE: "H2O_BUILD_STAMP_SOURCE_ADMISSION_UNAVAILABLE",
    TRACKED_SOURCE_DIRTY: "H2O_BUILD_STAMP_TRACKED_SOURCE_DIRTY",
    UNTRACKED_SOURCE_INPUT: "H2O_BUILD_STAMP_UNTRACKED_SOURCE_INPUT",
  }),
});

export class ChromeBuildStampError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ChromeBuildStampError";
    this.code = code;
  }
}

const DIGITS = /^\d+$/;
const FULL_COMMIT_SHA = /^[0-9a-f]{40}$/;
// Date.parse is far too generous to be a validator: it reads "-1" as the year
// 2001 and "0" as 2000, so a lock that was actually a typo would be accepted as
// a date. The shape is checked first and Date.parse only decides whether a
// well-shaped instant is real (it rejects e.g. 2026-13-45T99:99:99Z).
const ISO_INSTANT =
  /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

function sourceAdmissionGit(repoRoot, args, action) {
  try {
    return execFileSync("git", ["-C", repoRoot, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (cause) {
    throw new ChromeBuildStampError(
      CHROME_BUILD_STAMP.ERROR.SOURCE_ADMISSION_UNAVAILABLE,
      `${CHROME_BUILD_STAMP.ERROR.SOURCE_ADMISSION_UNAVAILABLE}: Could not ${action} ` +
      `in ${repoRoot} (${String(cause?.message || cause).trim()}). A canonical ` +
      "production build cannot prove that its source bytes match committed HEAD.",
    );
  }
}

function trackedSourceStatusFromGit(repoRoot) {
  return sourceAdmissionGit(repoRoot, [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=no",
    "--ignore-submodules=none",
  ], "compare tracked working-tree and index bytes with HEAD");
}

function unsafeUntrackedSourceInputsFromGit(repoRoot) {
  const raw = sourceAdmissionGit(
    repoRoot,
    ["ls-files", "--others", "-z", "--", RUNTIME_BASE_REL],
    "inspect untracked enumerated runtime inputs",
  );
  const runtimeRoot = String(RUNTIME_BASE_REL).split(path.sep).join("/").replace(/\/+$/, "");
  return String(raw).split("\0").filter(Boolean).filter((relativePath) => {
    const normalized = relativePath.split(path.sep).join("/");
    return path.posix.dirname(normalized) === runtimeRoot && /(\.user)?\.js$/i.test(normalized);
  });
}

function boundedEntries(rawEntries) {
  return rawEntries.slice(0, 8).map((entry) => String(entry).replace(/[\r\n\0]+/g, " "));
}

// Canonical production artifacts claim the exact committed HEAD in their
// public runtime stamp. Admit such a build only when every tracked index and
// working-tree byte still agrees with that HEAD. Untracked state is not
// rejected globally: isolated builds legitimately use an untracked
// node_modules symlink. The only current production input discovered by
// directory enumeration is an immediate JavaScript file in RUNTIME_BASE_REL;
// reject those scoped untracked inputs because they change loader catalog
// bytes despite having no identity in HEAD.
export function assertChromeCanonicalProductionSourceAdmission({
  repoRoot = REPO_ROOT,
  sourceRevision,
  readTrackedSourceStatus = trackedSourceStatusFromGit,
  readUnsafeUntrackedSourceInputs = unsafeUntrackedSourceInputsFromGit,
} = {}) {
  const commit = String(sourceRevision ?? "").trim().toLowerCase();
  if (!FULL_COMMIT_SHA.test(commit)) {
    throw new ChromeBuildStampError(
      CHROME_BUILD_STAMP.ERROR.SOURCE_REVISION_UNAVAILABLE,
      "Canonical production source admission requires the exact full HEAD commit SHA.",
    );
  }

  let trackedStatus;
  try {
    trackedStatus = String(readTrackedSourceStatus(repoRoot) ?? "");
  } catch (cause) {
    if (cause instanceof ChromeBuildStampError) throw cause;
    throw new ChromeBuildStampError(
      CHROME_BUILD_STAMP.ERROR.SOURCE_ADMISSION_UNAVAILABLE,
      `${CHROME_BUILD_STAMP.ERROR.SOURCE_ADMISSION_UNAVAILABLE}: Could not compare ` +
      `tracked source with HEAD ${commit} (${String(cause?.message || cause).trim()}).`,
    );
  }
  const trackedEntries = trackedStatus.split("\0").filter(Boolean);
  if (trackedEntries.length > 0) {
    throw new ChromeBuildStampError(
      CHROME_BUILD_STAMP.ERROR.TRACKED_SOURCE_DIRTY,
      `${CHROME_BUILD_STAMP.ERROR.TRACKED_SOURCE_DIRTY}: HEAD ${commit} identifies ` +
      "one committed source revision, but tracked working-tree and/or index bytes " +
      `differ from that revision (${JSON.stringify(boundedEntries(trackedEntries))}). ` +
      "A runtime stamp for HEAD would therefore be untruthful. Commit, stash, or " +
      "revert tracked changes before a canonical production build.",
    );
  }

  let unsafeUntrackedInputs;
  try {
    unsafeUntrackedInputs = readUnsafeUntrackedSourceInputs(repoRoot) ?? [];
  } catch (cause) {
    if (cause instanceof ChromeBuildStampError) throw cause;
    throw new ChromeBuildStampError(
      CHROME_BUILD_STAMP.ERROR.SOURCE_ADMISSION_UNAVAILABLE,
      `${CHROME_BUILD_STAMP.ERROR.SOURCE_ADMISSION_UNAVAILABLE}: Could not inspect ` +
      `untracked source inputs for HEAD ${commit} (${String(cause?.message || cause).trim()}).`,
    );
  }
  const unsafeEntries = Array.from(unsafeUntrackedInputs, (entry) => String(entry)).filter(Boolean);
  if (unsafeEntries.length > 0) {
    throw new ChromeBuildStampError(
      CHROME_BUILD_STAMP.ERROR.UNTRACKED_SOURCE_INPUT,
      `${CHROME_BUILD_STAMP.ERROR.UNTRACKED_SOURCE_INPUT}: Untracked JavaScript in ` +
      `${RUNTIME_BASE_REL} is enumerated into canonical loader bytes but has no ` +
      `identity in HEAD ${commit} (${JSON.stringify(boundedEntries(unsafeEntries))}). ` +
      "Remove or commit the unsafe input before a canonical production build.",
    );
  }

  return Object.freeze({
    sourceRevision: commit,
    trackedSourceEntries: 0,
    unsafeUntrackedSourceInputs: 0,
  });
}

// Accepts the two forms already present in the repository: epoch milliseconds
// (what chrome-live-loader.mjs interpolated) and an ISO-8601 instant (what
// test-round2-item9-3a-packaged-chrome-smoke.mjs passes). The ISO form used to
// parse as NaN and silently degrade to wall-clock time, so that test only
// believed it had locked the stamp; accepting it here makes the lock real.
export function parseBuildTsEnvironmentValue(rawValue) {
  const raw = String(rawValue ?? "").trim();
  if (raw === "") return null;

  let milliseconds = Number.NaN;
  if (DIGITS.test(raw)) milliseconds = Number(raw);
  else if (ISO_INSTANT.test(raw)) milliseconds = Date.parse(raw);

  if (!Number.isFinite(milliseconds) || milliseconds <= 0) {
    throw new ChromeBuildStampError(
      CHROME_BUILD_STAMP.ERROR.ENV_INVALID,
      `${CHROME_BUILD_STAMP.ENV_VARIABLE}=${JSON.stringify(raw)} is not epoch ` +
      "milliseconds or an ISO-8601 instant. Supply a valid value or unset it " +
      "to derive the stamp from the source revision; the build will not fall " +
      "back to the current wall-clock time.",
    );
  }
  return Math.floor(milliseconds);
}

function readSourceRevisionSeconds(repoRoot) {
  let output;
  try {
    output = execFileSync("git", ["-C", repoRoot, "log", "-1", "--format=%ct", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (cause) {
    throw new ChromeBuildStampError(
      CHROME_BUILD_STAMP.ERROR.SOURCE_REVISION_UNAVAILABLE,
      `Could not read the source revision timestamp from ${repoRoot} ` +
      `(${String(cause?.message || cause).trim()}). Set ` +
      `${CHROME_BUILD_STAMP.ENV_VARIABLE} to build outside a checkout.`,
    );
  }

  const seconds = String(output).trim();
  if (!DIGITS.test(seconds)) {
    throw new ChromeBuildStampError(
      CHROME_BUILD_STAMP.ERROR.SOURCE_REVISION_UNAVAILABLE,
      `The source revision timestamp for ${repoRoot} was not a number ` +
      `(${JSON.stringify(seconds)}). Set ${CHROME_BUILD_STAMP.ENV_VARIABLE} ` +
      "to build outside a checkout.",
    );
  }
  return Number(seconds);
}

function readSourceRevisionCommitFromGit(repoRoot) {
  let output;
  try {
    output = execFileSync("git", ["-C", repoRoot, "rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (cause) {
    throw new ChromeBuildStampError(
      CHROME_BUILD_STAMP.ERROR.SOURCE_REVISION_UNAVAILABLE,
      `Could not read the source revision identity from ${repoRoot} ` +
      `(${String(cause?.message || cause).trim()}). Runtime worker identity ` +
      "requires an exact committed source revision.",
    );
  }

  const commit = String(output).trim().toLowerCase();
  if (!FULL_COMMIT_SHA.test(commit)) {
    throw new ChromeBuildStampError(
      CHROME_BUILD_STAMP.ERROR.SOURCE_REVISION_UNAVAILABLE,
      `The source revision identity for ${repoRoot} was not a full commit SHA ` +
      `(${JSON.stringify(commit)}). Runtime worker identity requires an exact ` +
      "committed source revision.",
    );
  }
  return commit;
}

function sourceRevisionCommit(readCommit, repoRoot) {
  let commit;
  try {
    commit = String(readCommit(repoRoot) ?? "").trim().toLowerCase();
  } catch (cause) {
    if (cause instanceof ChromeBuildStampError) throw cause;
    throw new ChromeBuildStampError(
      CHROME_BUILD_STAMP.ERROR.SOURCE_REVISION_UNAVAILABLE,
      `Could not determine the source revision identity in ${repoRoot} ` +
      `(${String(cause?.message || cause).trim()}). Runtime worker identity ` +
      "requires an exact committed source revision.",
    );
  }
  if (!FULL_COMMIT_SHA.test(commit)) {
    throw new ChromeBuildStampError(
      CHROME_BUILD_STAMP.ERROR.SOURCE_REVISION_UNAVAILABLE,
      `The source revision identity for ${repoRoot} was not usable ` +
      `(${JSON.stringify(commit)}). Runtime worker identity requires an exact ` +
      "committed source revision.",
    );
  }
  return commit;
}

// However the revision timestamp is obtained - the default `git log` reader or
// an injected one - a failure to obtain it is the same typed refusal, so no
// caller can mistake it for a reason to guess.
function sourceRevisionMilliseconds(readTimestampSeconds, repoRoot) {
  let seconds;
  try {
    seconds = readTimestampSeconds(repoRoot);
  } catch (cause) {
    if (cause instanceof ChromeBuildStampError) throw cause;
    throw new ChromeBuildStampError(
      CHROME_BUILD_STAMP.ERROR.SOURCE_REVISION_UNAVAILABLE,
      `Could not determine the source revision being built in ${repoRoot} ` +
      `(${String(cause?.message || cause).trim()}). Set ` +
      `${CHROME_BUILD_STAMP.ENV_VARIABLE} to build outside a checkout.`,
    );
  }
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new ChromeBuildStampError(
      CHROME_BUILD_STAMP.ERROR.SOURCE_REVISION_UNAVAILABLE,
      `The source revision timestamp for ${repoRoot} was not usable ` +
      `(${JSON.stringify(seconds)}). Set ${CHROME_BUILD_STAMP.ENV_VARIABLE} ` +
      "to build outside a checkout.",
    );
  }
  return Math.floor(seconds) * 1000;
}

// Both generated fields come from ONE instant, so LOADER_BUILD_TS and
// LOADER_BUILD_ISO can never disagree by a millisecond.
export function resolveChromeBuildStamp({
  environment = process.env,
  repoRoot = REPO_ROOT,
  readSourceRevisionTimestampSeconds = readSourceRevisionSeconds,
  readSourceRevisionCommit = readSourceRevisionCommitFromGit,
  requireCommittedSource = false,
  assertCommittedSource = assertChromeCanonicalProductionSourceAdmission,
} = {}) {
  const fromEnvironment = parseBuildTsEnvironmentValue(
    environment?.[CHROME_BUILD_STAMP.ENV_VARIABLE],
  );

  const buildTsMs = fromEnvironment === null
    ? sourceRevisionMilliseconds(readSourceRevisionTimestampSeconds, repoRoot)
    : fromEnvironment;
  const sourceRevision = sourceRevisionCommit(readSourceRevisionCommit, repoRoot);
  if (requireCommittedSource) {
    assertCommittedSource({ repoRoot, sourceRevision });
  }

  return Object.freeze({
    buildTsMs,
    buildIso: new Date(buildTsMs).toISOString(),
    sourceRevision,
    h2oBuildStamp: `${CHROME_BUILD_STAMP.RUNTIME_PREFIX}${sourceRevision}`,
    source: fromEnvironment === null
      ? CHROME_BUILD_STAMP.SOURCE.SOURCE_REVISION
      : CHROME_BUILD_STAMP.SOURCE.ENV,
  });
}
