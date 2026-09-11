/*
 * P02 evidence-capacity policy (Wave 1 / Z7) implementing Decision Point V9.
 *
 * Authority: P02-V9-EVIDENCE-CAPACITY-POLICY.md, SHA-256
 * 34607b0147c217bc9e6c3dfcf7b48afdcc82df225f34e630ed64ac8b0bb6a564, which
 * supplements frozen N1 G.6 for capacity policy only.
 *
 * Platform-neutral by construction: Desktop and Chrome evaluate this same
 * logical policy so equivalent evidence accounts identically even though the
 * physical stores differ. SQLite/IndexedDB storage overhead is deliberately
 * NOT part of the accounting.
 *
 * Nothing here deletes, compacts or evicts. Exhaustion is a recoverable
 * fail-closed state, never a licence to discard evidence (G.6).
 */

export const P02_CAPACITY_V9 = Object.freeze({
  SCHEMA: 'h2o.studio.syncEvidenceCapacity.p02.v1',
  DECISION: 'P02-V9-EVIDENCE-CAPACITY-POLICY',
  DECISION_SHA256:
    '34607b0147c217bc9e6c3dfcf7b48afdcc82df225f34e630ed64ac8b0bb6a564'
});

const MIB = 1024 * 1024;

/* Exact V9 thresholds, per (peer, object). */
export const P02_CAPACITY_LIMITS = Object.freeze({
  normalItems: 256,
  normalBytes: 128 * MIB,
  reserveItems: 64,
  reserveBytes: 32 * MIB,
  hardItems: 320,
  hardBytes: 160 * MIB
});

export const P02_CAPACITY_VERDICT = Object.freeze({
  ADMIT_NORMAL: 'admit-normal',
  ADMIT_RESERVE: 'admit-reserve',
  REPLAY: 'admit-replay',
  BLOCKED: 'blocked(capacity)',
  INTEGRITY: 'integrity-conflict'
});

/* The three V9 recovery-critical classes. Nothing else reaches the reserve. */
export const P02_RECOVERY_CLASS = Object.freeze({
  MISSING_ANCESTOR: 'missing-ancestor',
  UNRESOLVED_LEAF_CLOSURE: 'unresolved-leaf-closure',
  ABSENT_SELECTED_TARGET: 'absent-selected-target'
});

const SHA256_RE = /^[0-9a-f]{64}$/;

function isPlainObject(value) {
  return value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.prototype.toString.call(value) === '[object Object]';
}

function freezeDeep(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Object.isFrozen(value)) return value;
  if (Array.isArray(value)) return Object.freeze(value.map(freezeDeep));
  if (isPlainObject(value)) {
    for (const key of Object.keys(value)) value[key] = freezeDeep(value[key]);
    return Object.freeze(value);
  }
  return value;
}

function nonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0;
}

/*
 * V9 accounting. One item is one UNIQUE retained revision, keyed by
 * revisionId. Bytes are canonical revision bytes plus canonical head bytes.
 * Replay observations, derived branch-index rows, scheduler memos, wake
 * records and counters are explicitly excluded.
 */
export function measureRetainedEvidence(records = []) {
  if (!Array.isArray(records)) {
    throw new TypeError('p02-capacity-records-invalid');
  }
  const seen = new Map();
  let bytes = 0;
  for (const record of records) {
    const revisionId = record?.revisionId;
    if (typeof revisionId !== 'string' || revisionId.length === 0) {
      throw new TypeError('p02-capacity-record-invalid');
    }
    const revisionBytes = record?.revisionBytes ?? 0;
    const headBytes = record?.headBytes ?? 0;
    if (!nonNegativeInteger(revisionBytes) || !nonNegativeInteger(headBytes)) {
      throw new TypeError('p02-capacity-record-invalid');
    }
    if (seen.has(revisionId)) continue;   /* replay consumes nothing */
    seen.set(revisionId, true);
    bytes += revisionBytes + headBytes;
  }
  return freezeDeep({
    schema: P02_CAPACITY_V9.SCHEMA,
    items: seen.size,
    bytes
  });
}

/*
 * Recovery-critical classification (V9 §9 clauses 1-3).
 *
 * Eligibility is derived ONLY from already-retained local evidence, never
 * from anything the candidate asserts, so a peer cannot mint eligibility by
 * labelling an ordinary revision. Once the normal budget is exhausted no new
 * fork can be admitted, so the eligible set is frozen and finite.
 */
export function classifyRecoveryCriticality({ index, candidate } = {}) {
  if (!isPlainObject(index) || !isPlainObject(candidate)) {
    return freezeDeep({ recoveryCritical: false, recoveryClass: null });
  }
  const candidateId = candidate.revisionId;
  if (typeof candidateId !== 'string' || candidateId.length === 0) {
    return freezeDeep({ recoveryCritical: false, recoveryClass: null });
  }
  const nodes = Array.isArray(index.nodes) ? index.nodes : [];
  const proven = new Set(index.provenRevisionIds || []);

  /* 1. An ancestor named as previousRevisionId by retained-but-unproven evidence. */
  const neededAncestors = new Set(nodes
    .filter((node) => !proven.has(node.revisionId) && node.previousRevisionId)
    .map((node) => node.previousRevisionId));
  if (neededAncestors.has(candidateId)) {
    return freezeDeep({
      recoveryCritical: true,
      recoveryClass: P02_RECOVERY_CLASS.MISSING_ANCESTOR
    });
  }

  /* 2. A closure whose exact parent is a currently-unresolved live leaf. */
  const liveLeaves = new Set(index.liveLeafRevisionIds || []);
  if (candidate.closureType && liveLeaves.size > 1 &&
      liveLeaves.has(candidate.previousRevisionId)) {
    return freezeDeep({
      recoveryCritical: true,
      recoveryClass: P02_RECOVERY_CLASS.UNRESOLVED_LEAF_CLOSURE
    });
  }

  /* 3. The selectedRevision target of an admitted closure whose target is absent. */
  const absentTargets = new Set(nodes
    .filter((node) => node.closureType === 'branch-superseded' && node.selectedRevision)
    .map((node) => node.selectedRevision.revisionId)
    .filter((revisionId) => !nodes.some((node) => node.revisionId === revisionId)));
  if (absentTargets.has(candidateId)) {
    return freezeDeep({
      recoveryCritical: true,
      recoveryClass: P02_RECOVERY_CLASS.ABSENT_SELECTED_TARGET
    });
  }
  return freezeDeep({ recoveryCritical: false, recoveryClass: null });
}

/*
 * The admission predicate. Pure: it decides, it never writes and never
 * deletes. Callers persist only on an admit verdict.
 */
export function evaluateCapacity({
  retained = [],
  candidate,
  index = null,
  limits = P02_CAPACITY_LIMITS
} = {}) {
  if (!isPlainObject(candidate) ||
      typeof candidate.revisionId !== 'string' ||
      candidate.revisionId.length === 0) {
    throw new TypeError('p02-capacity-candidate-invalid');
  }
  const current = measureRetainedEvidence(retained);
  const existing = retained.find((record) => record.revisionId === candidate.revisionId);

  if (existing) {
    /*
     * Same identity: replay if the canonical bytes match, integrity failure if
     * they do not. Neither path consumes capacity and neither overwrites.
     */
    const sameBytes =
      (existing.revisionBlobSha256 ?? null) === (candidate.revisionBlobSha256 ?? null) &&
      (!SHA256_RE.test(candidate.revisionBlobSha256 || '') ||
        existing.revisionBlobSha256 === candidate.revisionBlobSha256);
    return freezeDeep({
      verdict: sameBytes
        ? P02_CAPACITY_VERDICT.REPLAY
        : P02_CAPACITY_VERDICT.INTEGRITY,
      admitted: sameBytes,
      consumesCapacity: false,
      recoveryCritical: false,
      recoveryClass: null,
      blockedReason: null,
      usage: current,
      limits
    });
  }

  const candidateBytes =
    (candidate.revisionBytes ?? 0) + (candidate.headBytes ?? 0);
  const nextItems = current.items + 1;
  const nextBytes = current.bytes + candidateBytes;

  if (nextItems <= limits.normalItems && nextBytes <= limits.normalBytes) {
    return freezeDeep({
      verdict: P02_CAPACITY_VERDICT.ADMIT_NORMAL,
      admitted: true,
      consumesCapacity: true,
      recoveryCritical: false,
      recoveryClass: null,
      blockedReason: null,
      usage: current,
      limits
    });
  }

  const recovery = classifyRecoveryCriticality({ index: index || {}, candidate });
  if (recovery.recoveryCritical &&
      nextItems <= limits.hardItems &&
      nextBytes <= limits.hardBytes) {
    return freezeDeep({
      verdict: P02_CAPACITY_VERDICT.ADMIT_RESERVE,
      admitted: true,
      consumesCapacity: true,
      recoveryCritical: true,
      recoveryClass: recovery.recoveryClass,
      blockedReason: null,
      usage: current,
      limits
    });
  }

  /*
   * Fail closed. Everything already retained stays; canonical content is
   * untouched; nothing is evicted. Recoverable once a governed action clears
   * the condition - the predicate is simply recomputed on the next read.
   */
  return freezeDeep({
    verdict: P02_CAPACITY_VERDICT.BLOCKED,
    admitted: false,
    consumesCapacity: false,
    recoveryCritical: recovery.recoveryCritical,
    recoveryClass: recovery.recoveryClass,
    blockedReason: 'capacity',
    usage: current,
    limits
  });
}

/*
 * Capacity as a pure predicate over current evidence, per V9: there is no
 * stored "blocked" or "unblocked" transition to write, migrate or repair.
 */
export function capacityBlockReason({ retained = [], limits = P02_CAPACITY_LIMITS } = {}) {
  const usage = measureRetainedEvidence(retained);
  return (usage.items >= limits.hardItems || usage.bytes >= limits.hardBytes)
    ? 'capacity'
    : null;
}

/*
 * Native storage exhaustion (Chrome QuotaExceededError, Desktop disk/SQLite
 * full) is a RESOURCE failure, not the logical V9 threshold. It maps onto the
 * same fail-closed posture without claiming the two are identical, and it
 * never deletes or mutates anything.
 */
export function mapNativeStorageFailure(error) {
  const name = error?.name || '';
  const message = String(error?.message || error?.code || '');
  const exhausted =
    name === 'QuotaExceededError' ||
    /quota|disk (is )?full|database or disk is full|SQLITE_FULL|ENOSPC/i.test(message);
  if (!exhausted) return null;
  return freezeDeep({
    verdict: P02_CAPACITY_VERDICT.BLOCKED,
    admitted: false,
    consumesCapacity: false,
    blockedReason: 'capacity',
    source: 'native-storage-exhaustion',
    logicalThresholdReached: false,
    evidenceDeleted: false
  });
}
