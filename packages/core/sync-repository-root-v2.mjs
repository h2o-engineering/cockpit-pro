/*
 * P02 repository-root contract and V7 activation document shapes.
 *
 * Two things live here, both platform-neutral so Desktop (the canonical
 * local-folder mutation owner) and Chrome (read-only verifier) agree
 * byte-for-byte:
 *
 *   1. the deterministic child namespace that turns an already-configured
 *      transport container into the P02 repository root;
 *   2. the canonical bytes of the V7 format authority, which embeds the
 *      generic N.2 legacy-compatibility baseline as one document.
 *
 * Nothing here touches a filesystem. Resolution is pure string work and the
 * document builders are pure functions over caller-supplied pre-state, so
 * importing or calling this module can never create or mutate state.
 */

export const P02_REPOSITORY_V2 = Object.freeze({
  /*
   * Frozen child namespace. The P02 repository is a deterministic subordinate
   * directory INSIDE the already-configured transport container owned by the
   * accepted P01 folder authority - never a second folder picker, never an
   * arbitrary caller-supplied path. Verified unused across the accepted
   * repository before being frozen here.
   */
  CHILD_NAME: 'h2o-object-sync',
  AUTHORITY_FILE: 'library.info.json',
  BASELINE_SCHEMA: 'h2o.studio.syncLegacyBaseline.p02.v1',
  LIBRARY_INFO_SCHEMA: 'h2o.studio.syncLibraryInfo.p02.v1',
  FORMAT_VERSION: 2,
  MINIMUM_COMPATIBLE_PROTOCOL_VERSION: 2,
  INITIAL_LAYOUT_EPOCH: 1
});

/*
 * Frozen N.2 instantiation: the known legacy writer artifacts whose
 * hash-or-absence the activation receipt records. They live in the PARENT
 * transport container and are never moved, rewritten, or copied into the P02
 * child repository. The generic concept is the contract; these names are
 * instance data.
 */
export const P02_LEGACY_BASELINE_ARTIFACTS = Object.freeze([
  'round2-item9-delivery.json',
  'h2o-local-publication.v1.json'
]);

export const P02_ACTIVATION_ERROR = Object.freeze({
  CONTAINER_UNRESOLVED: 'p02-activation-container-unresolved',
  BASELINE_INVALID: 'p02-activation-baseline-invalid',
  DOCUMENT_INVALID: 'p02-activation-document-invalid',
  AUTHORITY_DIVERGENT: 'p02-activation-authority-divergent'
});

const SHA256_RE = /^[0-9a-f]{64}$/;

function isPlainObject(value) {
  return value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.prototype.toString.call(value) === '[object Object]';
}

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

/* Deterministic canonical JSON: sorted keys, no incidental whitespace. */
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

/*
 * Pure resolver. Given the canonical container the accepted folder authority
 * already owns, derive the P02 repository root and the parent scope the
 * legacy baseline is captured from. Creates nothing and touches nothing.
 */
export function resolveRepositoryRoot({ containerPath = null } = {}) {
  if (typeof containerPath !== 'string' || containerPath.length === 0) {
    fail(P02_ACTIVATION_ERROR.CONTAINER_UNRESOLVED);
  }
  const normalized = containerPath.replace(/\/+$/, '');
  if (normalized.length === 0) fail(P02_ACTIVATION_ERROR.CONTAINER_UNRESOLVED);
  return Object.freeze({
    containerPath: normalized,
    repositoryRoot: `${normalized}/${P02_REPOSITORY_V2.CHILD_NAME}`,
    authorityPath:
      `${normalized}/${P02_REPOSITORY_V2.CHILD_NAME}/${P02_REPOSITORY_V2.AUTHORITY_FILE}`,
    /* The legacy artifacts stay in the parent and are never relocated. */
    legacyScopePath: normalized,
    legacyArtifacts: P02_LEGACY_BASELINE_ARTIFACTS
  });
}

/*
 * Build the N.2 baseline from ACTUAL observed pre-state. Hashes are never
 * baked in: the caller passes what it just read from the parent container.
 */
export function buildLegacyBaseline({ observed = [], capturedAt } = {}) {
  if (!Array.isArray(observed) || typeof capturedAt !== 'string' || !capturedAt) {
    fail(P02_ACTIVATION_ERROR.BASELINE_INVALID);
  }
  const byPath = new Map();
  for (const entry of observed) {
    if (!isPlainObject(entry) || typeof entry.path !== 'string' || !entry.path) {
      fail(P02_ACTIVATION_ERROR.BASELINE_INVALID);
    }
    const present = entry.present === true;
    if (present && !SHA256_RE.test(entry.sha256 || '')) {
      fail(P02_ACTIVATION_ERROR.BASELINE_INVALID);
    }
    if (!present && entry.sha256 != null) {
      fail(P02_ACTIVATION_ERROR.BASELINE_INVALID);
    }
    /* A duplicate path used to be silently deduped by the map, so two
     * contradictory observations of the same artifact could be supplied and the
     * last one would quietly win. The receipt is evidence, so a duplicate is a
     * malformed receipt, not a merge. */
    if (byPath.has(entry.path)) {
      fail(P02_ACTIVATION_ERROR.BASELINE_INVALID);
    }
    byPath.set(entry.path, {
      path: entry.path,
      present,
      sha256: present ? entry.sha256 : null
    });
  }
  /* Every frozen artifact must be accounted for: present or explicitly absent. */
  for (const name of P02_LEGACY_BASELINE_ARTIFACTS) {
    if (!byPath.has(name)) fail(P02_ACTIVATION_ERROR.BASELINE_INVALID);
  }
  return Object.freeze({
    schema: P02_REPOSITORY_V2.BASELINE_SCHEMA,
    capturedAt,
    artifacts: [...byPath.values()].sort((left, right) =>
      left.path.localeCompare(right.path))
  });
}

/*
 * The V7 format authority. Authority and baseline are ONE canonical document,
 * so a partially-created activation can never appear as a valid supported
 * repository: either the single file exists and verifies, or it does not.
 */
export function buildLibraryInfo({
  activatedAt,
  activatedByWriterSyncPeerId,
  legacyBaseline
} = {}) {
  if (typeof activatedAt !== 'string' || !activatedAt ||
      typeof activatedByWriterSyncPeerId !== 'string' || !activatedByWriterSyncPeerId ||
      !isPlainObject(legacyBaseline) ||
      legacyBaseline.schema !== P02_REPOSITORY_V2.BASELINE_SCHEMA) {
    fail(P02_ACTIVATION_ERROR.DOCUMENT_INVALID);
  }
  return Object.freeze({
    schema: P02_REPOSITORY_V2.LIBRARY_INFO_SCHEMA,
    formatVersion: P02_REPOSITORY_V2.FORMAT_VERSION,
    minimumCompatibleProtocolVersion:
      P02_REPOSITORY_V2.MINIMUM_COMPATIBLE_PROTOCOL_VERSION,
    layoutEpoch: P02_REPOSITORY_V2.INITIAL_LAYOUT_EPOCH,
    activatedAt,
    activatedByWriterSyncPeerId,
    legacyBaselineReceipt: legacyBaseline
  });
}

export function serializeLibraryInfo(document) {
  return canonicalJson(document);
}

/*
 * Replay rule. An activation is idempotent ONLY when the already-present
 * authority matches the requested one apart from provenance timestamps.
 * Anything else fails closed: V7 never overwrites a different authority and
 * never silently updates formatVersion, epoch or baseline.
 */
export function compareExistingAuthority({ existing, requested } = {}) {
  if (!isPlainObject(existing) || !isPlainObject(requested)) {
    fail(P02_ACTIVATION_ERROR.DOCUMENT_INVALID);
  }
  const material = (document) => canonicalJson({
    schema: document.schema,
    formatVersion: document.formatVersion,
    minimumCompatibleProtocolVersion: document.minimumCompatibleProtocolVersion,
    layoutEpoch: document.layoutEpoch,
    legacyBaselineReceipt: document.legacyBaselineReceipt
      ? {
        schema: document.legacyBaselineReceipt.schema,
        artifacts: document.legacyBaselineReceipt.artifacts
      }
      : null
  });
  const identical = material(existing) === material(requested);
  return Object.freeze({
    identical,
    verdict: identical ? 'safe-replay' : 'divergent-authority',
    /* Divergence is fail-closed; the caller must not write. */
    mayWrite: false
  });
}

/*
 * V8 exclusion. V7 creates exactly one file. Any writer/heads/revision object
 * appearing under the repository root during V7 is a contract violation.
 */
export const P02_V8_FORBIDDEN_DURING_V7 = Object.freeze([
  'writers', 'objects'
]);

export function assertNoV8Artifacts(entries = []) {
  const offending = entries.filter((name) =>
    P02_V8_FORBIDDEN_DURING_V7.includes(name));
  return Object.freeze({
    clean: offending.length === 0,
    offending
  });
}
