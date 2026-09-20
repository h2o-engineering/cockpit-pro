#!/usr/bin/env node
// C5-D focused validator — Studio Library folder-maintenance review model boundary.
//
// Executes the production `S0F1f. 🎬 Library Maintenance - Studio.js` inside a
// vm sandbox with a mocked FolderParity provider and access-recording stand-ins
// for every other Product surface, reads `studio.js` statically, and proves the
// owner-accepted C5-D freeze (Section 9):
//   V1  S0F1f is the C5-D home; studio.html / pack-studio admission unchanged
//   V2  both C5-D APIs exist on H2O.Library.Maintenance and are read-only
//   V3  buildFolderReviewPlan preserves classification / group semantics (oracle)
//   V4  getFolderReviewPlan consumes FolderParity selfCheck + getDisplayModel only
//   V5  canonical folders remain protected
//   V6  same-name conflicts remain review-only
//   V7  bound rows remain review-only
//   V8  orphan memberships remain review-only, never folder-delete candidates
//   V9  safe-empty is a review classification, not mutation authority
//   V10 Shell no longer computes Library classification semantics (thin delegation)
//   V11 destructive C5-F functions remain outside the Maintenance API
//   V12 no Chrome storage / SQLite / binding mutation through the C5-D APIs
//   V13 no Sync / mirror propagation through C5-D
//   V14 no Candidate-3 Folder Operator controller movement
//   V15 no studio.html / pack / admission surface change required
//   V18 an F5D/Desktop row with zero binding/known counts cannot be safe-empty
//   V19 plan.selfCheckSeverity preserves the FolderParity self-check input
//   V20 read-only assertions target only the two C5-D APIs
//   V21 review metadata fields carry no mutation authority
//   NC-1..NC-6 negative controls prove each boundary check detects a break
//
// Fixture equivalence (V3) is proven against an embedded verbatim copy of the
// pre-move Shell cluster taken from Product main 6ba6b607 (studio.js lines
// 9750-9957, sha256 c2f36b39fac0b597829974b0e46e69aaf1659306e2041f5885cc25670c01a93f).
//
// Run: node tools/validation/studio/validate-studio-library-folder-maintenance-boundary-c5-d.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), '..', '..', '..');

const REL = {
  maintenance: 'src-surfaces-base/studio/S0F1f. 🎬 Library Maintenance - Studio.js',
  studio: 'src-surfaces-base/studio/studio.js',
  studioHtml: 'src-surfaces-base/studio/studio.html',
  packStudio: 'tools/product/studio/pack-studio.mjs',
};

const CLASSIFICATIONS = [
  'safe-empty',
  'same-name-conflict',
  'bound-review',
  'orphan-membership',
  'canonical-protected',
  'unsafe-to-delete',
];

const GROUP_KEYS = [
  'safeEmptyCandidates',
  'sameNameConflicts',
  'boundReviewCandidates',
  'orphanMemberships',
  'canonicalProtected',
  'unsafeToDelete',
];

const COUNT_KEYS = [
  'safeEmpty', 'conflicts', 'boundReview', 'orphanMemberships', 'canonicalProtected', 'unsafeToDelete',
];

/* Frozen candidate record field set (freeze Section 3). */
const CANDIDATE_KEYS = [
  'folderId', 'name', 'normalizedName', 'classification', 'source', 'kind', 'surface',
  'isCanonical', 'isExtra', 'isTestCandidate', 'isConflict',
  'bindingCount', 'canonicalCount', 'nativeMembershipCount', 'knownCount', 'localBindingCount',
  'savedCount', 'linkedCount', 'orphanCount', 'badges', 'displayCountLabel', 'nativePresence',
  'proposedAction', 'riskLevel', 'requiresApproval', 'reversible', 'warnings',
];

/* Frozen top-level plan field set (freeze Section 3 + retained diagnostic-copy fields). */
const PLAN_KEYS = [
  'readOnly', 'noMutation', 'generatedAt', 'surface', 'selfCheckSummary', 'selfCheckSeverity',
  'counts', 'groups', 'safetyRules',
];

/* Fields that would read as mutation authority if they ever appeared on a review record. */
const AUTHORITY_LIKE_KEYS = [
  'approved', 'approval', 'authorized', 'authorised', 'mutationAuthorized', 'applyAllowed',
  'deleteEligible', 'deletable', 'eligible', 'canDelete', 'canApply', 'apply', 'execute',
];

/* C5-F destructive owners (freeze Section 5): must stay in Shell, never in S0F1f. */
const C5F_FUNCTIONS = [
  'settingsFolderCleanupValidateDeletionSelection',
  'settingsFolderCleanupBuildDeletionPreview',
  'settingsFolderCleanupAppendAudit',
  'settingsFolderCleanupBuildNextState',
  'previewSettingsFolderCleanupDeletion',
  'deleteSelectedSafeChromeMirrorFolders',
  'previewSettingsFolderConflictDeletion',
  'deleteSelectedEmptyDuplicateConflictFolders',
  'previewSettingsFolderDesktopOrphanBindingRemoval',
  'removeSelectedOrphanDesktopBinding',
  'previewSettingsFolderDesktopDeletion',
  'deleteSelectedEmptyDesktopFolders',
];

/* C5-E Sync / convergence owners (freeze Section 6). */
const C5E_FUNCTIONS = [
  'previewSettingsFolderMirrorRefresh',
  'refreshDesktopFolderMirror',
  'refreshSettingsSync',
  'bindSettingsSyncControls',
];

/* Candidate-3 Folder Operator controller markers (freeze Section 7). */
const CANDIDATE3_MARKERS = [
  'settingsFolderOperatorMode',
];

/* C5-D API bodies in S0F1f. */
const C5D_LIBRARY_FUNCTIONS = [
  'folderReviewCount',
  'folderReviewRowBindingCount',
  'folderReviewIsF5DReviewCandidate',
  'buildFolderReviewCandidate',
  'buildFolderReviewPlan',
  'getFolderReviewPlan',
];

/* Tokens that must never appear inside the C5-D API bodies (mutation / foreign sources). */
const FORBIDDEN_IN_C5D_BODIES = [
  'chrome.', 'storage', 'localStorage', 'sessionStorage', 'indexedDB', '__TAURI__', 'invoke(',
  'fetch(', 'XMLHttpRequest', 'getStore', 'getRegistry', 'getIndex', 'getWorkspace', 'getCore',
  'importSnapshot', 'rebuildIndex', 'cleanupStaleRegistryEntries', 'upsert', 'markDeleted',
  '.remove(', '.delete(', '.set(', '.write', 'Sync', 'mirror', 'Mirror', 'refresh(',
  'dispatchEvent', 'postMessage', 'sendMessage', 'diagnose(', 'FolderParityS0F1bProvider',
  'localStorage', 'Operator',
];

/* FolderParity members getFolderReviewPlan may touch. */
const ALLOWED_FOLDER_PARITY_MEMBERS = ['selfCheck', 'getDisplayModel'];

/* Tokens whose presence in studio.js would mean Shell-local classification came back. */
const SHELL_FORBIDDEN_TOKENS = [
  'function settingsFolderCleanupReviewCandidate(',
  'isSafeEmpty',
  'rowCandidate(',
  'P8i-c1 is review-only',
  'Protected canonical folder. Never a cleanup candidate.',
  'Future P8i cleanup candidate',
  'Canonical orphan memberships',
  'folder.binding.orphan',
];

const SHELL_CLUSTER_START = 'function settingsFolderCleanupNumber(';
const SHELL_CLUSTER_END = 'function settingsFolderCleanupIsChromeSurface(';

// ---------------------------------------------------------------------------
// Pre-move oracle: verbatim Shell cluster from Product main 6ba6b607.
// ---------------------------------------------------------------------------
const ORACLE_SOURCE = String.raw`
function settingsFolderCleanupNumber(value){
  const n = Number(value || 0);
  return Number.isFinite(n) ? n : 0;
}

function settingsFolderCleanupRowBindingCount(row){
  return Math.max(
    settingsFolderCleanupNumber(row?.bindingCount),
    settingsFolderCleanupNumber(row?.localBindingCount)
  );
}

function settingsFolderCleanupIsF5DReviewCandidate(row){
  const src = row && typeof row === "object" ? row : {};
  const parts = [
    src.folderId,
    src.id,
    src.name,
    src.normalizedName,
  ].map((value) => String(value || ""));
  return parts.some((value) => /f5d/i.test(value));
}

function settingsFolderCleanupReviewCandidate(row, classification, opts = {}){
  const src = row && typeof row === "object" ? row : {};
  const folderId = String(src.folderId || src.id || opts.folderId || "").trim();
  const name = String(src.name || opts.name || folderId || "Folder review item").trim();
  const knownCount = settingsFolderCleanupNumber(src.knownCount ?? src.knownStudioCount);
  const localBindingCount = settingsFolderCleanupRowBindingCount(src);
  const bindingCount = Math.max(localBindingCount, knownCount);
  const canonicalCount = settingsFolderCleanupNumber(src.canonicalCount ?? src.nativeMembershipCount);
  const orphanCount = settingsFolderCleanupNumber(src.orphanCount || opts.orphanCount);
  const warnings = Array.isArray(opts.warnings) ? opts.warnings.slice() : [];
  const badges = Array.isArray(src.badges) ? src.badges.map((badge) => String(badge || "").trim()).filter(Boolean) : [];
  const isCanonical = !!src.isCanonical || !!opts.isCanonical;
  const isConflict = !!src.isConflict || classification === "same-name-conflict";
  const isTestCandidate = !!src.isTestCandidate;
  const isExtra = !!src.isExtra;
  const nativePresence = isCanonical || !!opts.nativePresence;

  if (isCanonical) warnings.push("Protected canonical folder. Never a cleanup candidate.");
  if (isConflict) warnings.push("Same-name/different-ID conflict. Review-only; no automatic merge.");
  if (bindingCount > 0 && !isCanonical) warnings.push("Folder has local bindings or known rows. Review-only.");
  if (orphanCount > 0) warnings.push("Native memberships are not represented by known Studio rows.");
  if (settingsFolderCleanupIsF5DReviewCandidate(src)) {
    warnings.push("Desktop/F5D review required.");
    warnings.push("Not eligible for Chrome mirror P7b deletion.");
  }

  let proposedAction = "Review only. No P7a mutation is available.";
  let riskLevel = "review";
  let requiresApproval = true;
  if (classification === "safe-empty") {
    proposedAction = "Future P8i cleanup candidate only after explicit preview and typed approval.";
    riskLevel = "low-review-required";
  } else if (classification === "orphan-membership") {
    proposedAction = "Review membership coverage. Not a folder removal candidate.";
    riskLevel = "review-required";
  } else if (classification === "canonical-protected") {
    proposedAction = "Preserve canonical folder.";
    riskLevel = "protected";
    requiresApproval = false;
  } else if (classification === "bound-review") {
    proposedAction = "Inspect bindings before any future action.";
    riskLevel = "high-review-required";
  } else if (classification === "same-name-conflict") {
    proposedAction = "Resolve only through a future conflict review plan.";
    riskLevel = "high-review-required";
  } else if (classification === "unsafe-to-delete") {
    proposedAction = "Keep review-only until a later plan explains exact ownership and blockers.";
    riskLevel = "high-review-required";
  }

  return {
    folderId,
    name,
    normalizedName: String(src.normalizedName || name).trim().toLowerCase(),
    classification,
    source: String(src.source || opts.source || "").trim(),
    kind: String(src.kind || opts.kind || "").trim(),
    surface: String(opts.surface || src.surface || ""),
    isCanonical,
    isExtra,
    isTestCandidate,
    isConflict,
    bindingCount,
    canonicalCount,
    nativeMembershipCount: canonicalCount,
    knownCount,
    localBindingCount,
    savedCount: settingsFolderCleanupNumber(src.savedCount),
    linkedCount: settingsFolderCleanupNumber(src.linkedCount),
    orphanCount,
    badges,
    displayCountLabel: String(src.displayCountLabel || opts.displayCountLabel || "").trim(),
    nativePresence,
    proposedAction,
    riskLevel,
    requiresApproval,
    reversible: false,
    warnings: Array.from(new Set(warnings.filter(Boolean))),
  };
}

function settingsFolderCleanupBuildReviewPlan(selfCheck, displayModel){
  const rows = Array.isArray(displayModel?.rows) ? displayModel.rows : [];
  const surface = String(selfCheck?.surface || displayModel?.surface || "");
  const rowCandidate = (row, classification, opts = {}) => settingsFolderCleanupReviewCandidate(row, classification, { ...opts, surface });
  const isSafeEmpty = (row) => {
    const bindingCount = settingsFolderCleanupRowBindingCount(row);
    const knownCount = settingsFolderCleanupNumber(row?.knownCount);
    return !row?.isCanonical
      && (!!row?.isExtra || !!row?.isTestCandidate)
      && !row?.isConflict
      && !settingsFolderCleanupIsF5DReviewCandidate(row)
      && bindingCount === 0
      && knownCount === 0;
  };
  const safeEmptyCandidates = rows
    .filter(isSafeEmpty)
    .map((row) => rowCandidate(row, "safe-empty", { nativePresence: false }));
  const sameNameConflicts = rows
    .filter((row) => !row?.isCanonical && !!row?.isConflict)
    .map((row) => rowCandidate(row, "same-name-conflict", { nativePresence: false }));
  const boundReviewCandidates = rows
    .filter((row) => {
      const bindingCount = settingsFolderCleanupRowBindingCount(row);
      const knownCount = settingsFolderCleanupNumber(row?.knownCount);
      return !row?.isCanonical
        && (!!row?.isExtra || !!row?.isTestCandidate)
        && !row?.isConflict
        && (bindingCount > 0 || knownCount > 0 || settingsFolderCleanupIsF5DReviewCandidate(row));
    })
    .map((row) => rowCandidate(row, "bound-review", { nativePresence: false }));
  const orphanRows = rows
    .filter((row) => !!row?.isCanonical && settingsFolderCleanupNumber(row?.orphanCount) > 0)
    .map((row) => rowCandidate(row, "orphan-membership", {
      isCanonical: true,
      nativePresence: true,
      orphanCount: settingsFolderCleanupNumber(row?.orphanCount),
    }));
  const orphanCheck = (Array.isArray(selfCheck?.checks) ? selfCheck.checks : [])
    .find((check) => String(check?.id || "") === "folder.binding.orphan");
  const orphanCount = settingsFolderCleanupNumber(selfCheck?.summary?.orphanMembershipCount || orphanCheck?.details?.orphanMembershipCount);
  const orphanMemberships = orphanRows.length || orphanCount === 0
    ? orphanRows
    : [settingsFolderCleanupReviewCandidate({
      name: "Canonical orphan memberships",
      orphanCount,
      knownCount: settingsFolderCleanupNumber(orphanCheck?.details?.knownStudioRowTotal),
    }, "orphan-membership", {
      surface,
      orphanCount,
      nativePresence: true,
      warnings: ["Aggregate self-check item. It is not a folder deletion candidate."],
    })];
  const canonicalProtected = rows
    .filter((row) => !!row?.isCanonical)
    .map((row) => rowCandidate(row, "canonical-protected", { isCanonical: true, nativePresence: true }));
  const groupedIds = new Set([
    ...safeEmptyCandidates,
    ...sameNameConflicts,
    ...boundReviewCandidates,
  ].map((candidate) => String(candidate.folderId || "").trim()).filter(Boolean));
  const unsafeToDelete = rows
    .filter((row) => {
      const id = String(row?.folderId || row?.id || "").trim();
      return !row?.isCanonical && id && !groupedIds.has(id);
    })
    .map((row) => rowCandidate(row, "unsafe-to-delete", {
      nativePresence: false,
      warnings: ["Review row does not meet empty-test cleanup requirements."],
    }));

  const groups = {
    safeEmptyCandidates,
    sameNameConflicts,
    boundReviewCandidates,
    orphanMemberships,
    canonicalProtected,
    unsafeToDelete,
  };
  return {
    readOnly: true,
    noMutation: true,
    generatedAt: new Date().toISOString(),
    surface,
    selfCheckSummary: selfCheck?.summary || null,
    selfCheckSeverity: selfCheck?.severity || "",
    counts: {
      safeEmpty: safeEmptyCandidates.length,
      conflicts: sameNameConflicts.length,
      boundReview: boundReviewCandidates.length,
      orphanMemberships: orphanMemberships.length,
      canonicalProtected: canonicalProtected.length,
      unsafeToDelete: unsafeToDelete.length,
    },
    groups,
    safetyRules: [
      "P8i-c1 is review-only.",
      "No folder cleanup is performed.",
      "No Chrome storage, SQLite, or native folder-state writes are performed.",
      "Canonical f_* folders are protected.",
      "Conflicts and bound folders are review-only.",
      "Desktop/F5D test folders are review-only in P8i-c1.",
    ],
  };
}
`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function readRepo(rel) {
  return fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
}

/* Comments removed and string-literal contents blanked: a code-only view. */
function codeOnly(src) {
  return String(src)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``');
}

/* Extract one `[async ]function <name>(` definition by brace balance. */
function sliceFunction(src, name) {
  const re = new RegExp(`(^|\\n)[ \\t]*(async[ \\t]+)?function[ \\t]+${name}[ \\t]*\\(`);
  const m = re.exec(src);
  if (!m) return null;
  const start = m.index + m[1].length;
  const paramsOpen = src.indexOf('(', start);
  let parens = 0;
  let paramsClose = -1;
  for (let i = paramsOpen; i < src.length; i += 1) {
    if (src[i] === '(') parens += 1;
    if (src[i] === ')') {
      parens -= 1;
      if (parens === 0) { paramsClose = i; break; }
    }
  }
  if (paramsClose < 0) throw new Error(`function ${name} has an unterminated parameter list`);
  const open = src.indexOf('{', paramsClose);
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === '{') depth += 1;
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`function ${name} is unterminated`);
}

function countOccurrences(haystack, needle) {
  if (!needle) return 0;
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx >= 0) {
    count += 1;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return count;
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function stripGeneratedAt(plan) {
  const copy = clone(plan);
  if (copy && typeof copy === 'object') delete copy.generatedAt;
  return copy;
}

/* Access-recording stand-in for a Product surface the C5-D APIs must not touch. */
function makeSpy(name, log, armed) {
  const handler = {
    get(_target, key) {
      if (typeof key === 'symbol') return undefined;
      if (key === 'then') return undefined;
      if (armed.on) log.push(`${name}.${String(key)}`);
      return makeSpy(`${name}.${String(key)}`, log, armed);
    },
    set(_target, key) {
      if (armed.on) log.push(`${name}.${String(key)}=`);
      return true;
    },
    apply() {
      if (armed.on) log.push(`${name}()`);
      return makeSpy(`${name}()`, log, armed);
    },
    has() { return true; },
  };
  const fn = function spy() {};
  return new Proxy(fn, handler);
}

/* Execute S0F1f in a sandbox. Returns the Maintenance API plus the access log. */
function loadMaintenance(maintenanceSrc, { folderParity } = {}) {
  const log = [];
  const armed = { on: false };
  const H2O = {
    Library: {
      Store: makeSpy('H2O.Library.Store', log, armed),
      Sync: makeSpy('H2O.Library.Sync', log, armed),
      FolderParityS0F1bProvider: makeSpy('H2O.Library.FolderParityS0F1bProvider', log, armed),
    },
    ChatRegistry: makeSpy('H2O.ChatRegistry', log, armed),
    LibraryIndex: makeSpy('H2O.LibraryIndex', log, armed),
    LibraryWorkspace: makeSpy('H2O.LibraryWorkspace', log, armed),
    Studio: makeSpy('H2O.Studio', log, armed),
  };
  if (folderParity) H2O.Library.FolderParity = folderParity;
  const sandbox = {
    H2O,
    console: { log() {}, warn() {}, error() {}, info() {}, debug() {} },
    performance: { now: () => 0 },
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent: makeSpy('window.dispatchEvent', log, armed),
    chrome: makeSpy('chrome', log, armed),
    localStorage: makeSpy('localStorage', log, armed),
    sessionStorage: makeSpy('sessionStorage', log, armed),
    indexedDB: makeSpy('indexedDB', log, armed),
    __TAURI__: makeSpy('__TAURI__', log, armed),
    __TAURI_INTERNALS__: makeSpy('__TAURI_INTERNALS__', log, armed),
    fetch: makeSpy('fetch', log, armed),
    Date,
    Number,
    String,
    Array,
    Object,
    Set,
    Math,
    Promise,
    Error,
    JSON,
    RegExp,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  const context = vm.createContext(sandbox);
  vm.runInContext(maintenanceSrc, context, { filename: 'S0F1f.js' });
  const api = sandbox.H2O.Library.Maintenance;
  return { api, log, armed, sandbox };
}

/* Evaluate the pre-move oracle cluster and return its buildReviewPlan. */
function loadOracle() {
  const sandbox = { Date, Number, String, Array, Object, Set, Math, JSON, RegExp };
  const context = vm.createContext(sandbox);
  vm.runInContext(`${ORACLE_SOURCE}\nthis.__oracle = settingsFolderCleanupBuildReviewPlan;`, context, { filename: 'oracle.js' });
  return sandbox.__oracle;
}

// ---------------------------------------------------------------------------
// Fixtures — every accepted classification plus the frozen safety edge cases
// ---------------------------------------------------------------------------
function fixtureRows() {
  return [
    { folderId: 'f_canon01', name: 'Work', normalizedName: 'work', isCanonical: true, source: 'native', kind: 'folder', badges: ['native'], displayCountLabel: '4', savedCount: 4, linkedCount: 4, knownCount: 4, canonicalCount: 4, orphanCount: 0 },
    { folderId: 'f_canon02', name: 'Research', isCanonical: true, source: 'native', kind: 'folder', canonicalCount: 6, orphanCount: 2, knownCount: 4 },
    { folderId: 'x_empty01', name: 'Empty Test', isExtra: true, source: 'chrome-mirror', kind: 'test', bindingCount: 0, knownCount: 0, badges: ['extra', ''] },
    { id: 'x_empty02', name: 'Empty Test 2', isTestCandidate: true, source: 'chrome-mirror', bindingCount: '0', knownCount: null },
    { folderId: 'x_f5d_desktop', name: 'F5D Desktop Final', isTestCandidate: true, source: 'desktop', bindingCount: 0, knownCount: 0, localBindingCount: 0 },
    { folderId: 'x_f5d_by_id', name: 'Desktop review row', normalizedName: 'desktop review row', isExtra: true, bindingCount: 0, knownCount: 0 },
    { folderId: 'x_bound01', name: 'Bound A', isExtra: true, localBindingCount: 3, knownCount: 0 },
    { folderId: 'x_bound02', name: 'Bound B', isTestCandidate: true, bindingCount: 0, knownCount: 1, savedCount: '2', linkedCount: 'nope' },
    { folderId: 'x_conflict01', name: 'Work', normalizedName: 'work', isExtra: true, isConflict: true, bindingCount: 0, knownCount: 0 },
    { folderId: 'x_conflict02', name: 'Research', isConflict: true, isExtra: false, localBindingCount: 5 },
    { folderId: 'x_unsafe01', name: 'Unknown origin', source: 'unknown', bindingCount: 0, knownCount: 0 },
    { folderId: 'x_unsafe02', name: '', kind: 'mystery', bindingCount: 2 },
    { name: 'No id row', isExtra: true, bindingCount: 0, knownCount: 0 },
    { folderId: '   ', name: 'Blank id row', isExtra: false },
    null,
    'not-a-row',
    { folderId: 'x_f5d_name_only', name: 'contains f5d marker', isExtra: true, isConflict: false, bindingCount: 0, knownCount: 0, knownStudioCount: 0 },
  ];
}

function fixtureCases() {
  const rows = fixtureRows();
  return [
    {
      label: 'full-mixed-warning',
      selfCheck: { surface: 'studio', severity: 'warning', summary: { orphanMembershipCount: 2, checks: 5 }, checks: [{ id: 'folder.binding.orphan', details: { orphanMembershipCount: 2, knownStudioRowTotal: 8 } }] },
      displayModel: { surface: 'chrome', rows },
    },
    {
      label: 'aggregate-orphan-no-canonical-orphan-rows',
      selfCheck: { surface: '', severity: 'critical', summary: { orphanMembershipCount: 0 }, checks: [{ id: 'folder.binding.orphan', details: { orphanMembershipCount: 3, knownStudioRowTotal: 11 } }, { id: 'other' }] },
      displayModel: { surface: 'desktop', rows: rows.filter((row) => !(row && row.folderId === 'f_canon02')) },
    },
    {
      label: 'summary-orphan-count-without-check',
      selfCheck: { severity: 'ok', summary: { orphanMembershipCount: '4' }, checks: 'not-an-array' },
      displayModel: { rows: rows.filter((row) => !(row && row.folderId === 'f_canon02')) },
    },
    {
      label: 'no-severity-no-surface',
      selfCheck: { summary: null },
      displayModel: { rows: rows.slice(0, 5) },
    },
    {
      label: 'null-inputs',
      selfCheck: null,
      displayModel: null,
    },
    {
      label: 'rows-not-array',
      selfCheck: { surface: 'studio', severity: 'warning' },
      displayModel: { rows: { length: 3 } },
    },
    {
      label: 'only-canonical',
      selfCheck: { surface: 'studio', severity: 'ok', summary: { orphanMembershipCount: 0 } },
      displayModel: { rows: rows.filter((row) => row && row.isCanonical) },
    },
    {
      label: 'only-safe-empty',
      selfCheck: { surface: 'studio', severity: 'ok' },
      displayModel: { rows: rows.filter((row) => row && (row.folderId === 'x_empty01' || row.id === 'x_empty02')) },
    },
  ];
}

function allCandidates(plan) {
  return GROUP_KEYS.flatMap((key) => (Array.isArray(plan?.groups?.[key]) ? plan.groups[key] : []));
}

function findCandidate(plan, groupKey, folderId) {
  return (plan?.groups?.[groupKey] || []).find((candidate) => candidate.folderId === folderId) || null;
}

// ---------------------------------------------------------------------------
// Check suite — runs against (maintenanceSrc, studioSrc); reused by the NCs
// ---------------------------------------------------------------------------
async function runSuite({ maintenanceSrc, studioSrc, studioHtml, packStudio, quiet = false, oracle }) {
  const pass = [];
  const fail = [];
  const report = (label, ok, message) => {
    if (ok) pass.push(label); else fail.push({ label, message });
    if (!quiet) {
      console.log(`  ${ok ? 'PASS' : 'FAIL'} ${label}`);
      if (!ok) console.log(`       ${message}`);
    }
  };
  const check = (label, fn) => {
    try { fn(); report(label, true); } catch (err) { report(label, false, err && err.message ? err.message : String(err)); }
  };
  const checkAsync = async (label, fn) => {
    try { await fn(); report(label, true); } catch (err) { report(label, false, err && err.message ? err.message : String(err)); }
  };

  const maintenanceCode = codeOnly(maintenanceSrc);
  const studioCode = codeOnly(studioSrc);

  // ── V1 / V15: admission surface ────────────────────────────────────────────
  check('V1 S0F1f is admitted in studio.html before studio.js', () => {
    const tagIdx = studioHtml.indexOf('<script src="./S0F1f. 🎬 Library Maintenance - Studio.js"');
    const shellIdx = studioHtml.search(/<script src="\.\/studio\.js(\?v=[^"]*)?"/);
    assert.ok(tagIdx >= 0, 'S0F1f script tag missing from studio.html');
    assert.ok(shellIdx > tagIdx, 'studio.js must load after S0F1f');
  });
  check('V1 S0F1f is listed in both pack-studio lists', () => {
    assert.equal(countOccurrences(packStudio, '"S0F1f. 🎬 Library Maintenance - Studio.js"'), 2, 'S0F1f must appear in exactly the two pack lists');
  });
  check('V15 C5-D introduces no new runtime module or admission tag', () => {
    for (const fn of ['buildFolderReviewPlan', 'getFolderReviewPlan']) {
      assert.ok(sliceFunction(maintenanceSrc, fn), `${fn} must be defined inside S0F1f`);
      assert.equal(sliceFunction(studioSrc, fn), null, `${fn} must not be defined by studio.js`);
    }
    assert.equal(countOccurrences(studioHtml, '<script src="./S0F1f. 🎬 Library Maintenance - Studio.js"'), 1, 'exactly one S0F1f admission tag');
  });

  // ── V2: API existence / read-only shape ────────────────────────────────────
  let loaded = null;
  check('V2 H2O.Library.Maintenance exposes buildFolderReviewPlan + getFolderReviewPlan', () => {
    loaded = loadMaintenance(maintenanceSrc);
    assert.ok(loaded.api, 'Maintenance API missing');
    assert.equal(typeof loaded.api.buildFolderReviewPlan, 'function');
    assert.equal(typeof loaded.api.getFolderReviewPlan, 'function');
    assert.equal(loaded.api.getFolderReviewPlan.constructor.name, 'AsyncFunction', 'getFolderReviewPlan must be async');
    assert.notEqual(loaded.api.buildFolderReviewPlan.constructor.name, 'AsyncFunction', 'buildFolderReviewPlan must be synchronous');
  });
  check('V2 buildFolderReviewPlan is synchronous, pure over frozen inputs and touches no other surface', () => {
    const { api, log, armed } = loadMaintenance(maintenanceSrc);
    const fixture = fixtureCases()[0];
    const selfCheck = deepFreeze(clone(fixture.selfCheck));
    const displayModel = deepFreeze(clone(fixture.displayModel));
    const before = JSON.stringify([selfCheck, displayModel]);
    armed.on = true;
    const plan = api.buildFolderReviewPlan(selfCheck, displayModel);
    armed.on = false;
    assert.ok(plan && typeof plan === 'object' && typeof plan.then !== 'function', 'plan must be a plain object, not a promise');
    assert.equal(JSON.stringify([selfCheck, displayModel]), before, 'inputs must not be mutated');
    assert.deepEqual(log, [], `no foreign surface may be touched: ${log.join(', ')}`);
    assert.equal(plan.readOnly, true);
    assert.equal(plan.noMutation, true);
    assert.deepEqual(Object.keys(plan).sort(), [...PLAN_KEYS].sort(), 'plan key set must match the frozen shape');
    assert.deepEqual(Object.keys(plan.counts).sort(), [...COUNT_KEYS].sort());
    assert.deepEqual(Object.keys(plan.groups).sort(), [...GROUP_KEYS].sort());
    assert.ok(/^\d{4}-\d{2}-\d{2}T/.test(String(plan.generatedAt)), 'generatedAt must be an ISO timestamp');
  });
  check('V2 buildFolderReviewPlan tolerates null / malformed inputs without reading anything else', () => {
    const { api, log, armed } = loadMaintenance(maintenanceSrc);
    armed.on = true;
    const plans = [
      api.buildFolderReviewPlan(null, null),
      api.buildFolderReviewPlan(undefined, undefined),
      api.buildFolderReviewPlan('x', 7),
      api.buildFolderReviewPlan({ checks: 'nope' }, { rows: 'nope' }),
    ];
    armed.on = false;
    for (const plan of plans) {
      assert.equal(plan.readOnly, true);
      for (const key of GROUP_KEYS) assert.deepEqual(clone(plan.groups[key]), []);
      for (const key of COUNT_KEYS) assert.equal(plan.counts[key], 0);
    }
    assert.deepEqual(clone(log), []);
  });

  // ── V3: fixture equivalence against the pre-move Shell oracle ──────────────
  check('V3 buildFolderReviewPlan matches the pre-move Shell review plan across all fixtures', () => {
    const { api } = loadMaintenance(maintenanceSrc);
    const cases = fixtureCases();
    const seen = new Set();
    for (const fixture of cases) {
      const expected = stripGeneratedAt(oracle(clone(fixture.selfCheck), clone(fixture.displayModel)));
      const actual = stripGeneratedAt(api.buildFolderReviewPlan(clone(fixture.selfCheck), clone(fixture.displayModel)));
      assert.deepEqual(actual, expected, `fixture ${fixture.label} diverges from the pre-move plan`);
      for (const candidate of allCandidates(actual)) seen.add(candidate.classification);
    }
    for (const classification of CLASSIFICATIONS) {
      assert.ok(seen.has(classification), `fixtures must exercise classification ${classification}`);
    }
  });
  check('V3 oracle is the accepted pre-move cluster (not a trivial stub)', () => {
    for (const name of ['settingsFolderCleanupNumber', 'settingsFolderCleanupRowBindingCount', 'settingsFolderCleanupIsF5DReviewCandidate', 'settingsFolderCleanupReviewCandidate', 'settingsFolderCleanupBuildReviewPlan']) {
      assert.ok(sliceFunction(ORACLE_SOURCE, name), `oracle must define ${name}`);
    }
    const plan = oracle(fixtureCases()[0].selfCheck, fixtureCases()[0].displayModel);
    assert.ok(allCandidates(plan).length >= 10, 'oracle must classify the mixed fixture');
  });

  // ── V4 / V12 / V13: getFolderReviewPlan orchestration ──────────────────────
  await checkAsync('V4 getFolderReviewPlan reads only FolderParity.selfCheck + getDisplayModel and returns { selfCheck, displayModel, plan }', async () => {
    const calls = [];
    const selfCheckResult = { surface: 'studio', severity: 'warning', summary: { orphanMembershipCount: 0 }, checks: [] };
    const displayModelResult = { surface: 'studio', rows: fixtureRows() };
    const folderParityLog = [];
    const folderParityArmed = { on: false };
    const folderParity = new Proxy({
      selfCheck: async (opts) => { calls.push(['selfCheck', clone(opts)]); return selfCheckResult; },
      getDisplayModel: async (opts) => { calls.push(['getDisplayModel', clone(opts)]); return displayModelResult; },
    }, {
      get(target, key) {
        if (typeof key === 'string' && folderParityArmed.on && !ALLOWED_FOLDER_PARITY_MEMBERS.includes(key) && key !== 'then') {
          folderParityLog.push(`FolderParity.${key}`);
        }
        return target[key];
      },
    });
    const { api, log, armed } = loadMaintenance(maintenanceSrc, { folderParity });
    armed.on = true;
    folderParityArmed.on = true;
    const result = await api.getFolderReviewPlan({ fresh: true });
    armed.on = false;
    folderParityArmed.on = false;
    assert.deepEqual(calls, [['selfCheck', { fresh: true }], ['getDisplayModel', { fresh: true }]], 'exactly the two FolderParity reads, in order, with fresh passed through');
    assert.deepEqual(folderParityLog, [], `only selfCheck/getDisplayModel may be read from FolderParity: ${folderParityLog.join(', ')}`);
    assert.deepEqual(log, [], `no storage / Sync / native / registry surface may be touched: ${log.join(', ')}`);
    assert.equal(result.selfCheck, selfCheckResult, 'selfCheck must be returned as produced by FolderParity');
    assert.equal(result.displayModel, displayModelResult, 'displayModel must be returned as produced by FolderParity');
    assert.deepEqual(Object.keys(result).sort(), ['displayModel', 'plan', 'selfCheck']);
    assert.deepEqual(stripGeneratedAt(result.plan), stripGeneratedAt(api.buildFolderReviewPlan(selfCheckResult, displayModelResult)), 'plan must be buildFolderReviewPlan(selfCheck, displayModel)');
    assert.equal(result.plan.selfCheckSeverity, 'warning');
  });
  await checkAsync('V4 getFolderReviewPlan defaults fresh=true and forwards fresh=false', async () => {
    const calls = [];
    const folderParity = {
      selfCheck: async (opts) => { calls.push(['selfCheck', clone(opts)]); return { severity: 'ok' }; },
      getDisplayModel: async (opts) => { calls.push(['getDisplayModel', clone(opts)]); return { rows: [] }; },
    };
    const { api } = loadMaintenance(maintenanceSrc, { folderParity });
    await api.getFolderReviewPlan();
    await api.getFolderReviewPlan({});
    await api.getFolderReviewPlan({ fresh: false });
    assert.deepEqual(calls, [
      ['selfCheck', { fresh: true }], ['getDisplayModel', { fresh: true }],
      ['selfCheck', { fresh: true }], ['getDisplayModel', { fresh: true }],
      ['selfCheck', { fresh: false }], ['getDisplayModel', { fresh: false }],
    ]);
  });
  await checkAsync('V4 getFolderReviewPlan fails closed when FolderParity is unavailable', async () => {
    const { api, log, armed } = loadMaintenance(maintenanceSrc);
    armed.on = true;
    await assert.rejects(() => api.getFolderReviewPlan({ fresh: true }), /FolderParity review APIs unavailable/);
    armed.on = false;
    assert.deepEqual(log, [], 'no fallback to storage / Sync / native sources');
    const partial = loadMaintenance(maintenanceSrc, { folderParity: { selfCheck: async () => ({}) } });
    await assert.rejects(() => partial.api.getFolderReviewPlan({ fresh: true }), /FolderParity review APIs unavailable/);
  });
  check('V4 getFolderReviewPlan source names only FolderParity.selfCheck / getDisplayModel / buildFolderReviewPlan', () => {
    const body = codeOnly(sliceFunction(maintenanceSrc, 'getFolderReviewPlan'));
    assert.ok(body.includes('H2O.Library?.FolderParity') || body.includes('H2O.Library.FolderParity'), 'must read H2O.Library.FolderParity');
    assert.ok(body.includes('.selfCheck({ fresh })'), 'must call selfCheck({ fresh })');
    assert.ok(body.includes('.getDisplayModel({ fresh })'), 'must call getDisplayModel({ fresh })');
    assert.ok(body.includes('buildFolderReviewPlan(selfCheck, displayModel)'), 'must delegate to buildFolderReviewPlan');
    const memberReads = [...body.matchAll(/parity\.([A-Za-z0-9_]+)/g)].map((m) => m[1]);
    for (const member of memberReads) assert.ok(ALLOWED_FOLDER_PARITY_MEMBERS.includes(member), `FolderParity.${member} is not an accepted C5-D input`);
    assert.equal(countOccurrences(body, 'await '), 2, 'exactly two awaited FolderParity reads');
  });
  check('V12/V13 C5-D API bodies contain no storage / SQLite / binding / Sync / mirror / native code paths', () => {
    for (const name of C5D_LIBRARY_FUNCTIONS) {
      const body = sliceFunction(maintenanceSrc, name);
      assert.ok(body, `${name} must exist in S0F1f`);
      const code = codeOnly(body);
      for (const token of FORBIDDEN_IN_C5D_BODIES) {
        assert.ok(!code.includes(token), `${name} must not contain ${JSON.stringify(token)}`);
      }
      assert.ok(!/\bawait\b/.test(code) || name === 'getFolderReviewPlan', `${name} must be synchronous`);
    }
  });

  // ── V5..V9 / V18 / V19 / V21: frozen classification safety ────────────────
  let mixedPlan = null;
  check('V5 canonical folders remain protected', () => {
    const { api } = loadMaintenance(maintenanceSrc);
    const fixture = fixtureCases()[0];
    mixedPlan = api.buildFolderReviewPlan(fixture.selfCheck, fixture.displayModel);
    const canonicalIds = ['f_canon01', 'f_canon02'];
    for (const id of canonicalIds) {
      const protectedRow = findCandidate(mixedPlan, 'canonicalProtected', id);
      assert.ok(protectedRow, `${id} must be canonical-protected`);
      assert.equal(protectedRow.classification, 'canonical-protected');
      assert.equal(protectedRow.riskLevel, 'protected');
      assert.equal(protectedRow.isCanonical, true);
      assert.ok(protectedRow.warnings.includes('Protected canonical folder. Never a cleanup candidate.'));
      for (const group of ['safeEmptyCandidates', 'sameNameConflicts', 'boundReviewCandidates', 'unsafeToDelete']) {
        assert.equal(findCandidate(mixedPlan, group, id), null, `${id} must not appear in ${group}`);
      }
    }
    assert.equal(mixedPlan.counts.canonicalProtected, 2);
  });
  check('V6 same-name conflicts remain review-only and never safe-empty', () => {
    for (const id of ['x_conflict01', 'x_conflict02']) {
      const row = findCandidate(mixedPlan, 'sameNameConflicts', id);
      assert.ok(row, `${id} must be a same-name conflict`);
      assert.equal(row.classification, 'same-name-conflict');
      assert.equal(row.isConflict, true);
      assert.equal(row.requiresApproval, true);
      assert.equal(row.reversible, false);
      assert.equal(row.riskLevel, 'high-review-required');
      assert.ok(row.warnings.includes('Same-name/different-ID conflict. Review-only; no automatic merge.'));
      assert.equal(findCandidate(mixedPlan, 'safeEmptyCandidates', id), null);
      assert.equal(findCandidate(mixedPlan, 'boundReviewCandidates', id), null);
    }
    assert.equal(mixedPlan.counts.conflicts, 2);
  });
  check('V7 bound rows (bindings or known rows) remain review-only', () => {
    for (const id of ['x_bound01', 'x_bound02']) {
      const row = findCandidate(mixedPlan, 'boundReviewCandidates', id);
      assert.ok(row, `${id} must be bound-review`);
      assert.equal(row.classification, 'bound-review');
      assert.ok(row.bindingCount > 0, 'bindingCount must reflect bindings or known rows');
      assert.equal(row.requiresApproval, true);
      assert.equal(row.riskLevel, 'high-review-required');
      assert.ok(row.warnings.includes('Folder has local bindings or known rows. Review-only.'));
      assert.equal(findCandidate(mixedPlan, 'safeEmptyCandidates', id), null);
    }
    const boundA = findCandidate(mixedPlan, 'boundReviewCandidates', 'x_bound01');
    assert.equal(boundA.localBindingCount, 3);
    assert.equal(boundA.bindingCount, 3);
    const boundB = findCandidate(mixedPlan, 'boundReviewCandidates', 'x_bound02');
    assert.equal(boundB.knownCount, 1);
    assert.equal(boundB.savedCount, 2);
    assert.equal(boundB.linkedCount, 0, 'non-numeric counts coerce to 0');
  });
  check('V8 orphan memberships remain review-only and are never folder-delete candidates', () => {
    const { api } = loadMaintenance(maintenanceSrc);
    const orphan = findCandidate(mixedPlan, 'orphanMemberships', 'f_canon02');
    assert.ok(orphan, 'canonical row with orphanCount>0 must produce an orphan-membership review item');
    assert.equal(orphan.classification, 'orphan-membership');
    assert.equal(orphan.isCanonical, true);
    assert.equal(orphan.nativePresence, true);
    assert.equal(orphan.orphanCount, 2);
    assert.equal(orphan.proposedAction, 'Review membership coverage. Not a folder removal candidate.');
    assert.ok(orphan.warnings.includes('Native memberships are not represented by known Studio rows.'));
    for (const group of ['safeEmptyCandidates', 'sameNameConflicts', 'boundReviewCandidates', 'unsafeToDelete']) {
      assert.equal(findCandidate(mixedPlan, group, 'f_canon02'), null, `orphan row must not appear in ${group}`);
    }
    const aggregateCase = fixtureCases()[1];
    const aggregatePlan = api.buildFolderReviewPlan(aggregateCase.selfCheck, aggregateCase.displayModel);
    assert.equal(aggregatePlan.groups.orphanMemberships.length, 1, 'aggregate self-check orphan item expected');
    const aggregate = aggregatePlan.groups.orphanMemberships[0];
    assert.equal(aggregate.name, 'Canonical orphan memberships');
    assert.equal(aggregate.folderId, '');
    assert.equal(aggregate.orphanCount, 3);
    assert.equal(aggregate.knownCount, 11);
    assert.ok(aggregate.warnings.includes('Aggregate self-check item. It is not a folder deletion candidate.'));
    assert.equal(aggregatePlan.counts.orphanMemberships, 1);
  });
  check('V9 safe-empty is a review classification only (approval required, not reversible, no authority field)', () => {
    for (const id of ['x_empty01', 'x_empty02']) {
      const row = findCandidate(mixedPlan, 'safeEmptyCandidates', id);
      assert.ok(row, `${id} must be safe-empty`);
      assert.equal(row.classification, 'safe-empty');
      assert.equal(row.requiresApproval, true, 'safe-empty still requires approval');
      assert.equal(row.reversible, false);
      assert.equal(row.riskLevel, 'low-review-required');
      assert.equal(row.proposedAction, 'Future P8i cleanup candidate only after explicit preview and typed approval.');
      assert.equal(row.bindingCount, 0);
      assert.equal(row.knownCount, 0);
      assert.equal(row.nativePresence, false);
    }
    const idLess = mixedPlan.groups.safeEmptyCandidates.find((candidate) => candidate.name === 'No id row');
    assert.ok(idLess, 'an id-less extra row keeps its pre-move safe-empty review classification');
    assert.equal(idLess.folderId, '');
    assert.equal(idLess.requiresApproval, true);
    assert.equal(mixedPlan.counts.safeEmpty, 3);
    assert.ok(mixedPlan.safetyRules.includes('No folder cleanup is performed.'));
    assert.ok(mixedPlan.safetyRules.includes('No Chrome storage, SQLite, or native folder-state writes are performed.'));
  });
  check('V9 rows outside every accepted group classify unsafe-to-delete; id-less rows never reach that group', () => {
    for (const id of ['x_unsafe01', 'x_unsafe02']) {
      const row = findCandidate(mixedPlan, 'unsafeToDelete', id);
      assert.ok(row, `${id} must be unsafe-to-delete`);
      assert.equal(row.classification, 'unsafe-to-delete');
      assert.equal(row.riskLevel, 'high-review-required');
      assert.ok(row.warnings.includes('Review row does not meet empty-test cleanup requirements.'));
    }
    assert.equal(findCandidate(mixedPlan, 'unsafeToDelete', 'x_unsafe02').name, 'x_unsafe02', 'missing name falls back to folderId');
    assert.equal(mixedPlan.counts.unsafeToDelete, 2);
    assert.equal(mixedPlan.groups.unsafeToDelete.some((candidate) => candidate.name === 'No id row'), false);
    assert.equal(allCandidates(mixedPlan).some((candidate) => candidate.name === 'Blank id row'), false, 'a blank-id non-extra row is not classified at all');
  });
  check('V18 an F5D/Desktop review row with zero binding/known counts cannot classify safe-empty', () => {
    for (const id of ['x_f5d_desktop', 'x_f5d_by_id', 'x_f5d_name_only']) {
      assert.equal(findCandidate(mixedPlan, 'safeEmptyCandidates', id), null, `${id} must never be safe-empty`);
      const row = findCandidate(mixedPlan, 'boundReviewCandidates', id);
      assert.ok(row, `${id} must be bound-review (review-only equivalent)`);
      assert.equal(row.bindingCount, 0);
      assert.equal(row.knownCount, 0);
      assert.equal(row.requiresApproval, true);
      assert.ok(row.warnings.includes('Desktop/F5D review required.'));
      assert.ok(row.warnings.includes('Not eligible for Chrome mirror P7b deletion.'));
    }
    const { api } = loadMaintenance(maintenanceSrc);
    const lone = api.buildFolderReviewPlan({ severity: 'ok' }, { rows: [{ folderId: 'x_f5d_lone', name: 'lone', isExtra: true, bindingCount: 0, knownCount: 0, localBindingCount: 0 }] });
    assert.equal(lone.counts.safeEmpty, 0);
    assert.equal(lone.counts.boundReview, 1);
    const f5dPredicate = codeOnly(sliceFunction(maintenanceSrc, 'buildFolderReviewPlan'));
    const safeEmptyBlock = f5dPredicate.slice(f5dPredicate.indexOf('const isSafeEmpty'), f5dPredicate.indexOf('const safeEmptyCandidates'));
    assert.ok(safeEmptyBlock.includes('!folderReviewIsF5DReviewCandidate(row)'), 'safe-empty predicate must exclude F5D rows');
  });
  check('V19 plan.selfCheckSeverity preserves the FolderParity self-check input', () => {
    const { api } = loadMaintenance(maintenanceSrc);
    for (const severity of ['ok', 'warning', 'critical', 'error', 'custom-severity']) {
      const plan = api.buildFolderReviewPlan({ severity, surface: 'studio' }, { rows: [] });
      assert.equal(plan.selfCheckSeverity, severity, `severity ${severity} must be preserved`);
    }
    assert.equal(api.buildFolderReviewPlan({}, { rows: [] }).selfCheckSeverity, '');
    assert.equal(api.buildFolderReviewPlan(null, null).selfCheckSeverity, '');
    const summary = { orphanMembershipCount: 1, extra: 'kept' };
    assert.deepEqual(api.buildFolderReviewPlan({ severity: 'warning', summary }, { rows: [] }).selfCheckSummary, summary);
    assert.equal(api.buildFolderReviewPlan({ severity: 'warning', surface: 'a' }, { surface: 'b', rows: [] }).surface, 'a');
    assert.equal(api.buildFolderReviewPlan({ severity: 'warning' }, { surface: 'b', rows: [] }).surface, 'b');
  });
  check('V21 review metadata is the frozen field set and carries no mutation authority', () => {
    const candidates = allCandidates(mixedPlan);
    assert.ok(candidates.length >= 10);
    for (const candidate of candidates) {
      assert.deepEqual(Object.keys(candidate).sort(), [...CANDIDATE_KEYS].sort(), `candidate ${candidate.folderId || candidate.name} key set must match the frozen shape`);
      assert.equal(candidate.reversible, false, 'no review record is reversible');
      assert.equal(typeof candidate.requiresApproval, 'boolean');
      if (candidate.classification !== 'canonical-protected') assert.equal(candidate.requiresApproval, true, `${candidate.classification} requires approval`);
      assert.ok(CLASSIFICATIONS.includes(candidate.classification));
      assert.equal(typeof candidate.proposedAction, 'string');
      assert.ok(candidate.proposedAction.length > 0);
      for (const key of AUTHORITY_LIKE_KEYS) assert.ok(!(key in candidate), `authority-like field ${key} must not exist`);
    }
    for (const key of AUTHORITY_LIKE_KEYS) assert.ok(!(key in mixedPlan), `authority-like plan field ${key} must not exist`);
    const rawBody = sliceFunction(maintenanceSrc, 'buildFolderReviewCandidate');
    const code = codeOnly(rawBody);
    assert.ok(code.includes('reversible: false'), 'reversible is hard-coded false');
    assert.equal(countOccurrences(code, 'requiresApproval = false'), 1, 'requiresApproval may be cleared exactly once');
    const protectedBranchStart = rawBody.indexOf("classification === 'canonical-protected'");
    const protectedBranchEnd = rawBody.indexOf('} else if', protectedBranchStart);
    assert.ok(protectedBranchStart >= 0 && protectedBranchEnd > protectedBranchStart, 'canonical-protected branch must exist');
    assert.ok(rawBody.slice(protectedBranchStart, protectedBranchEnd).includes('requiresApproval = false'), 'only canonical-protected clears requiresApproval');
  });

  // ── V10: Shell is a thin consumer ──────────────────────────────────────────
  check('V10 studio.js cluster delegates buildReviewPlan / loadReviewInputs to H2O.Library.Maintenance', () => {
    const buildBody = sliceFunction(studioSrc, 'settingsFolderCleanupBuildReviewPlan');
    const loadBody = sliceFunction(studioSrc, 'settingsFolderCleanupLoadReviewInputs');
    assert.ok(buildBody, 'settingsFolderCleanupBuildReviewPlan must remain callable for Shell consumers');
    assert.ok(loadBody, 'settingsFolderCleanupLoadReviewInputs must remain callable for Shell consumers');
    const buildCode = codeOnly(buildBody);
    const loadCode = codeOnly(loadBody);
    assert.ok(buildCode.includes('Library?.Maintenance') || buildCode.includes('Library.Maintenance'), 'build must resolve H2O.Library.Maintenance');
    assert.ok(buildCode.includes('.buildFolderReviewPlan(selfCheck, displayModel)'), 'build must delegate with the frozen signature');
    assert.ok(loadCode.includes('Library?.Maintenance') || loadCode.includes('Library.Maintenance'), 'load must resolve H2O.Library.Maintenance');
    assert.ok(loadCode.includes('.getFolderReviewPlan({ fresh: true })'), 'load must delegate to getFolderReviewPlan({ fresh: true })');
    for (const forbidden of ['.filter(', '.map(', 'FolderParity', '.selfCheck(', '.getDisplayModel(', 'isCanonical', 'isConflict', 'isExtra', 'isTestCandidate', 'orphanCount', 'bindingCount', 'knownCount', 'warnings', 'proposedAction', 'requiresApproval', 'riskLevel', 'groups', 'counts', 'settingsFolderCleanupReviewCandidate', 'settingsFolderCleanupIsF5DReviewCandidate', 'settingsFolderCleanupRowBindingCount']) {
      assert.ok(!buildCode.includes(forbidden), `Shell build delegator must not contain ${forbidden}`);
      assert.ok(!loadCode.includes(forbidden), `Shell load delegator must not contain ${forbidden}`);
    }
    assert.ok(buildBody.split('\n').length <= 12, 'build delegator must stay thin');
    assert.ok(loadBody.split('\n').length <= 16, 'load delegator must stay thin');
  });
  check('V10 studio.js no longer carries Library classification logic', () => {
    for (const token of SHELL_FORBIDDEN_TOKENS) {
      assert.equal(countOccurrences(studioSrc, token), 0, `Shell must not contain ${JSON.stringify(token)}`);
    }
    const start = studioSrc.indexOf(SHELL_CLUSTER_START);
    const end = studioSrc.indexOf(SHELL_CLUSTER_END);
    assert.ok(start >= 0 && end > start, 'Shell cleanup cluster region must exist');
    const region = codeOnly(studioSrc.slice(start, end));
    for (const classification of CLASSIFICATIONS) {
      assert.ok(!region.includes(classification), `cluster region must not classify ${classification}`);
    }
    assert.ok(!region.includes('.filter('), 'cluster region must not filter rows');
    assert.ok(!region.includes('groups'), 'cluster region must not assemble groups');
    const fnCount = (region.match(/\n(async )?function /g) || []).length + 1;
    assert.ok(fnCount <= 5, `cluster region must hold only the numeric/F5D helpers and two delegators (found ${fnCount})`);
  });
  check('V10 Shell consumers still reach the review plan only through the delegators', () => {
    const refresh = sliceFunction(studioSrc, 'refreshSettingsFolderCleanupReview');
    assert.ok(refresh && refresh.includes('settingsFolderCleanupBuildReviewPlan(loaded.selfCheck, loaded.displayModel)'), 'refresh must classify only through the Shell delegator');
    for (const consumer of ['refreshSettingsFolderCleanupReview', 'previewSettingsFolderCleanupDeletion', 'deleteSelectedSafeChromeMirrorFolders']) {
      const body = sliceFunction(studioSrc, consumer);
      assert.ok(body, `${consumer} must exist`);
      assert.ok(body.includes('settingsFolderCleanupLoadReviewInputs()'), `${consumer} must load review inputs through the Shell delegator`);
      const code = codeOnly(body);
      for (const token of ['isSafeEmpty', 'safeEmptyCandidates =', 'boundReviewCandidates =', 'sameNameConflicts =', 'canonicalProtected =', 'unsafeToDelete =', 'orphanMemberships =']) {
        assert.ok(!code.includes(token), `${consumer} must not assemble review groups itself (${token})`);
      }
    }
  });

  await checkAsync('V10 Shell delegators execute end-to-end against the loaded S0F1f API', async () => {
    const calls = [];
    const folderParity = {
      selfCheck: async (opts) => { calls.push(['selfCheck', clone(opts)]); return { surface: 'studio', severity: 'warning', summary: { orphanMembershipCount: 0 } }; },
      getDisplayModel: async (opts) => { calls.push(['getDisplayModel', clone(opts)]); return { surface: 'studio', rows: fixtureRows() }; },
    };
    const { sandbox, log, armed } = loadMaintenance(maintenanceSrc, { folderParity });
    const shellSlice = [
      'const STUDIO_BOOT_AUX_TIMEOUT_MS = 2500;',
      'const W = window;',
      'function studioTimeoutError(label, ms){ return new Error(String(label) + " timed out after " + ms + "ms"); }',
      sliceFunction(studioSrc, 'promiseWithTimeout'),
      sliceFunction(studioSrc, 'settingsFolderCleanupBuildReviewPlan'),
      sliceFunction(studioSrc, 'settingsFolderCleanupLoadReviewInputs'),
      'this.__shell = { settingsFolderCleanupBuildReviewPlan, settingsFolderCleanupLoadReviewInputs };',
    ].join('\n');
    sandbox.setTimeout = setTimeout;
    sandbox.clearTimeout = clearTimeout;
    vm.runInContext(shellSlice, vm.createContext(sandbox), { filename: 'studio-shell-slice.js' });
    const shell = sandbox.__shell;
    armed.on = true;
    const loaded = await shell.settingsFolderCleanupLoadReviewInputs();
    const rebuilt = shell.settingsFolderCleanupBuildReviewPlan(loaded.selfCheck, loaded.displayModel);
    armed.on = false;
    assert.deepEqual(calls, [['selfCheck', { fresh: true }], ['getDisplayModel', { fresh: true }]]);
    assert.deepEqual(clone(log), [], `Shell delegation must not touch other surfaces: ${log.join(', ')}`);
    assert.deepEqual(Object.keys(loaded).sort(), ['displayModel', 'plan', 'selfCheck']);
    assert.deepEqual(stripGeneratedAt(rebuilt), stripGeneratedAt(loaded.plan));
    assert.equal(loaded.plan.selfCheckSeverity, 'warning');
    assert.ok(loaded.plan.counts.safeEmpty > 0 && loaded.plan.counts.boundReview > 0);
    sandbox.H2O.Library.Maintenance = null;
    await assert.rejects(() => shell.settingsFolderCleanupLoadReviewInputs(), /Library\.Maintenance folder review APIs unavailable/);
    assert.throws(() => shell.settingsFolderCleanupBuildReviewPlan({}, {}), /Library\.Maintenance folder review APIs unavailable/);
  });

  // ── V11 / V13 / V14: excluded owners untouched by C5-D ─────────────────────
  check('V11 destructive C5-F functions remain in Shell and outside the Maintenance API', () => {
    for (const name of C5F_FUNCTIONS) {
      assert.ok(sliceFunction(studioSrc, name), `${name} must remain defined in studio.js`);
      assert.ok(!maintenanceSrc.includes(name), `${name} must not move into S0F1f`);
    }
    const { api } = loadMaintenance(maintenanceSrc);
    for (const key of Object.keys(api)) {
      assert.ok(!/delete|remove|purge|apply|repair|tombstone/i.test(key) || ['cleanupStaleRegistryEntries'].includes(key), `Maintenance API key ${key} looks destructive`);
    }
    assert.ok(!('deleteFolder' in api) && !('applyFolderReviewPlan' in api) && !('applyReviewPlan' in api));
  });
  check('V13 C5-E Sync / mirror owners remain in Shell and outside C5-D', () => {
    for (const name of C5E_FUNCTIONS) {
      assert.ok(sliceFunction(studioSrc, name), `${name} must remain defined in studio.js`);
      assert.ok(!maintenanceSrc.includes(name), `${name} must not move into S0F1f`);
    }
  });
  check('V14 Candidate-3 Folder Operator controller is not moved', () => {
    for (const marker of CANDIDATE3_MARKERS) {
      assert.ok(studioCode.includes(marker), `${marker} must remain in studio.js`);
      assert.ok(!maintenanceCode.includes(marker), `${marker} must not appear in S0F1f`);
    }
  });
  check('V20 pre-existing mutative Maintenance routines are untouched (read-only claim covers only the two C5-D APIs)', () => {
    const { api } = loadMaintenance(maintenanceSrc);
    for (const key of ['inspectStore', 'inspectRegistry', 'inspectIndex', 'inspectWorkspace', 'inspectCore', 'exportSnapshot', 'importSnapshot', 'rebuildIndex', 'cleanupStaleRegistryEntries', 'diagnose']) {
      assert.equal(typeof api[key], 'function', `${key} must remain on the Maintenance API`);
    }
    assert.ok(sliceFunction(maintenanceSrc, 'importSnapshot').includes('upsertMany'), 'importSnapshot is unchanged (still mutative, outside C5-D)');
  });

  return { pass, fail };
}

// ---------------------------------------------------------------------------
// Negative controls — each mutation must make at least one named check fail
// ---------------------------------------------------------------------------
function replaceOnce(src, from, to, label) {
  const idx = src.indexOf(from);
  assert.ok(idx >= 0, `${label}: mutation anchor not found: ${from}`);
  assert.equal(src.indexOf(from, idx + from.length), -1, `${label}: mutation anchor must be unique`);
  return src.slice(0, idx) + to + src.slice(idx + from.length);
}

function negativeControls(base) {
  return [
    {
      id: 'NC-1',
      title: 'destructive/apply behavior inside the Library review API',
      expect: ['V2 ', 'V12/V13'],
      mutate: () => ({
        ...base,
        maintenanceSrc: replaceOnce(
          base.maintenanceSrc,
          "    const rows = Array.isArray(displayModel?.rows) ? displayModel.rows : [];\n",
          "    const rows = Array.isArray(displayModel?.rows) ? displayModel.rows : [];\n    try { W.chrome.storage.local.remove(['h2o:folders:extra']); } catch {}\n",
          'NC-1',
        ),
      }),
    },
    {
      id: 'NC-2',
      title: 'Shell-local classification logic reintroduced',
      expect: ['V10 '],
      mutate: () => ({
        ...base,
        studioSrc: replaceOnce(
          base.studioSrc,
          '  return maintenance.buildFolderReviewPlan(selfCheck, displayModel);\n',
          '  const rows = Array.isArray(displayModel?.rows) ? displayModel.rows : [];\n  const isSafeEmpty = (row) => !row?.isCanonical && !!row?.isExtra && !row?.isConflict;\n  const safeEmptyCandidates = rows.filter(isSafeEmpty).map((row) => ({ ...row, classification: "safe-empty" }));\n  return { ...maintenance.buildFolderReviewPlan(selfCheck, displayModel), groups: { safeEmptyCandidates } };\n',
          'NC-2',
        ),
      }),
    },
    {
      id: 'NC-3',
      title: 'F5D-like zero-binding candidate becoming safe-empty',
      expect: ['V18 ', 'V3 '],
      mutate: () => ({
        ...base,
        maintenanceSrc: replaceOnce(
          base.maintenanceSrc,
          "        && !folderReviewIsF5DReviewCandidate(row)\n        && bindingCount === 0",
          "        && bindingCount === 0",
          'NC-3',
        ),
      }),
    },
    {
      id: 'NC-4',
      title: 'review metadata used as mutation authority',
      expect: ['V21 ', 'V9 '],
      mutate: () => ({
        ...base,
        maintenanceSrc: replaceOnce(
          base.maintenanceSrc,
          "      reversible: false,\n      warnings: Array.from(new Set(warnings.filter(Boolean))),\n    };\n  }\n\n  function buildFolderReviewPlan",
          "      reversible: false,\n      deleteEligible: classification === 'safe-empty' && !requiresApproval,\n      warnings: Array.from(new Set(warnings.filter(Boolean))),\n    };\n  }\n\n  function buildFolderReviewPlan",
          'NC-4',
        ).replace(
          "      proposedAction = 'Future P8i cleanup candidate only after explicit preview and typed approval.';\n      riskLevel = 'low-review-required';\n",
          "      proposedAction = 'Future P8i cleanup candidate only after explicit preview and typed approval.';\n      riskLevel = 'low-review-required';\n      requiresApproval = false;\n",
        ),
      }),
    },
    {
      id: 'NC-5',
      title: 'plan.selfCheckSeverity not preserving the selfCheck input',
      expect: ['V19 ', 'V3 '],
      mutate: () => ({
        ...base,
        maintenanceSrc: replaceOnce(
          base.maintenanceSrc,
          "      selfCheckSeverity: selfCheck?.severity || '',\n",
          "      selfCheckSeverity: 'ok',\n",
          'NC-5',
        ),
      }),
    },
    {
      id: 'NC-6',
      title: 'getFolderReviewPlan reading storage/native/Sync sources outside FolderParity',
      expect: ['V4 ', 'V12/V13'],
      mutate: () => ({
        ...base,
        maintenanceSrc: replaceOnce(
          base.maintenanceSrc,
          "    const displayModel = await parity.getDisplayModel({ fresh });\n    return {\n      selfCheck,\n      displayModel,\n      plan: buildFolderReviewPlan(selfCheck, displayModel),",
          "    const displayModel = await parity.getDisplayModel({ fresh });\n    const storeKeys = await getStore()?.listKeys?.('h2o:');\n    const mirror = H2O.Library.Sync?.diagnose?.();\n    return {\n      selfCheck,\n      displayModel,\n      storeKeys,\n      mirror,\n      plan: buildFolderReviewPlan(selfCheck, displayModel),",
          'NC-6',
        ),
      }),
    },
  ];
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const base = {
    maintenanceSrc: readRepo(REL.maintenance),
    studioSrc: readRepo(REL.studio),
    studioHtml: readRepo(REL.studioHtml),
    packStudio: readRepo(REL.packStudio),
    oracle: loadOracle(),
  };

  console.log('C5-D validator — Studio Library folder-maintenance review model boundary');
  console.log('Positive checks:');
  const positive = await runSuite({ ...base, quiet: false });

  console.log('Negative controls:');
  const ncResults = [];
  for (const control of negativeControls(base)) {
    let outcome;
    try {
      const mutated = control.mutate();
      const result = await runSuite({ ...mutated, quiet: true });
      const failedLabels = result.fail.map((entry) => entry.label);
      const hit = control.expect.filter((prefix) => failedLabels.some((label) => label.startsWith(prefix)));
      const ok = result.fail.length > 0 && hit.length > 0;
      outcome = { id: control.id, ok, failedLabels, hit };
    } catch (err) {
      outcome = { id: control.id, ok: false, failedLabels: [], hit: [], error: err && err.message ? err.message : String(err) };
    }
    ncResults.push(outcome);
    console.log(`  ${outcome.ok ? 'PASS' : 'FAIL'} ${control.id} ${control.title} → ${outcome.ok ? `rejected by ${outcome.failedLabels.length} check(s): ${outcome.failedLabels.map((label) => label.split(' ')[0]).join(', ')}` : (outcome.error || 'mutation was NOT rejected')}`);
  }

  const ncFailed = ncResults.filter((entry) => !entry.ok);
  console.log('');
  console.log(`Summary: positive ${positive.pass.length} PASS / ${positive.fail.length} FAIL; negative controls ${ncResults.length - ncFailed.length}/${ncResults.length} rejected`);
  const ok = positive.fail.length === 0 && ncFailed.length === 0;
  console.log(`C5_D_VALIDATOR=${ok ? 'PASS' : 'FAIL'}`);
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : String(err));
  process.exit(1);
});
