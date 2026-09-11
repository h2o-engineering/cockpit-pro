/*
 * P02 read-only object discovery and classification contracts.
 *
 * This module is deliberately pure: no store, transport, filesystem, UI,
 * scheduler, Apply, publication, or platform capability is imported here.
 */

import { requireP02AnchorSet } from './sync-p02-anchor-set-v2.mjs';

export const P02_READ_ONLY_DESCRIPTOR_SCHEMA =
  'h2o.studio.syncObjectDescriptor.p02.v1';

export const P02_CLASSIFICATION = Object.freeze({
  CONVERGED: 'converged',
  LOCAL_AHEAD: 'local-ahead',
  REMOTE_AHEAD: 'remote-ahead',
  DIVERGED_UNRESOLVED: 'diverged-unresolved',
  RESOLUTION_TARGET_MISSING: 'resolution-target-missing',
  RESOLUTION_CONFLICT: 'resolution-conflict',
  OBJECT_DELETED: 'object-deleted',
  INTEGRITY_QUARANTINED: 'integrity-quarantined',
  UNSUPPORTED_FORMAT: 'unsupported-format'
});

export const P02_EVIDENCE_POSTURE = Object.freeze({
  BRANCH_SUPERSEDED: 'branch-superseded-evidence',
  RETAINED_DIVERGENT: 'retained-divergent',
  RETAINED_UNPROVEN_PARENT: 'retained-unproven-parent',
  STALE_RESOLUTION: 'stale-resolution'
});

export const P02_BLOCK_REASONS = Object.freeze([
  'asset',
  'permission',
  'transport',
  'format',
  'capacity'
]);

const SHA256_RE = /^[0-9a-f]{64}$/;
const CLOSURE_TYPES = new Set(['branch-superseded', 'object-deleted']);

function isPlainObject(value) {
  return value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.prototype.toString.call(value) === '[object Object]';
}

function strictIdentifier(value) {
  return typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 512 &&
    value.trim() === value &&
    !/[\u0000-\u001f\u007f]/.test(value);
}

function lowerHex64(value) {
  return typeof value === 'string' && SHA256_RE.test(value);
}

function freezeDeep(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const item of Object.values(value)) freezeDeep(item);
  return Object.freeze(value);
}

function clone(value) {
  return value == null ? value : structuredClone(value);
}

function protocolReference(value) {
  if (value == null) return null;
  if (!isPlainObject(value) ||
      !strictIdentifier(value.revisionId) ||
      !lowerHex64(value.revisionBlobSha256)) {
    throw new TypeError('p02-read-only-protocol-reference-invalid');
  }
  const output = {
    revisionId: value.revisionId,
    revisionBlobSha256: value.revisionBlobSha256
  };
  if (value.payloadSha256 != null) {
    if (!lowerHex64(value.payloadSha256)) {
      throw new TypeError('p02-read-only-protocol-reference-invalid');
    }
    output.payloadSha256 = value.payloadSha256;
  }
  return output;
}

function canonicalHead(value) {
  if (value == null) return null;
  const reference = protocolReference(value);
  return {
    ...reference,
    deleted: value.deleted === true
  };
}

function normalizeProtocolState(value = {}) {
  if (!isPlainObject(value)) {
    throw new TypeError('p02-read-only-protocol-state-invalid');
  }
  const retainedObservationRevisionIds = Array.isArray(
    value.retainedObservationRevisionIds
  ) ? value.retainedObservationRevisionIds : [];
  if (!retainedObservationRevisionIds.every(strictIdentifier)) {
    throw new TypeError('p02-read-only-protocol-state-invalid');
  }
  const consumed = value.consumedRevisionBlobSha256 == null
    ? null
    : value.consumedRevisionBlobSha256;
  if (consumed !== null && !lowerHex64(consumed)) {
    throw new TypeError('p02-read-only-protocol-state-invalid');
  }
  let pendingApply = null;
  if (value.pendingApply != null) {
    const candidate = value.pendingApply;
    if (!isPlainObject(candidate) ||
        candidate.referenceKind !== 'branch-evidence-v2' ||
        !strictIdentifier(candidate.revisionId) ||
        !lowerHex64(candidate.revisionBlobSha256) ||
        !strictIdentifier(candidate.selectedLeafRevisionId) ||
        !lowerHex64(candidate.selectedLeafRevisionBlobSha256)) {
      throw new TypeError('p02-read-only-protocol-state-invalid');
    }
    pendingApply = {
      referenceKind: candidate.referenceKind,
      revisionId: candidate.revisionId,
      revisionBlobSha256: candidate.revisionBlobSha256,
      selectedLeafRevisionId: candidate.selectedLeafRevisionId,
      selectedLeafRevisionBlobSha256:
        candidate.selectedLeafRevisionBlobSha256
    };
  }
  return {
    lastPublished: protocolReference(value.lastPublished),
    lastApplied: protocolReference(value.lastApplied),
    consumedRevisionBlobSha256: consumed,
    pendingOperation: value.pendingOperation == null
      ? null
      : String(value.pendingOperation),
    pendingApply,
    operationPhase: value.operationPhase == null
      ? null
      : String(value.operationPhase),
    retainedObservationRevisionIds: [...new Set(retainedObservationRevisionIds)]
      .sort()
  };
}

function sortEvidence(values) {
  return values.map((value) => clone(value)).sort((left, right) =>
    String(left?.revisionId || left?.document?.revisionId || '').localeCompare(
      String(right?.revisionId || right?.document?.revisionId || '')
    ) || String(left?.revisionBlobSha256 || left?.blobSha256 || '').localeCompare(
      String(right?.revisionBlobSha256 || right?.blobSha256 || '')
    ));
}

function sortTips(values) {
  return values.map((value) => clone(value)).sort((left, right) =>
    String(left?.revisionId || '').localeCompare(String(right?.revisionId || '')) ||
      String(left?.revisionBlobSha256 || '').localeCompare(
        String(right?.revisionBlobSha256 || '')
      ));
}

export function createReadOnlyObjectDescriptor({
  objectDomain,
  objectId,
  objectKey,
  syncPeerId,
  canonicalLocalHead = null,
  /*
   * Amended anchor (A1 §8), assembled by the PLATFORM ADAPTER and passed in.
   *
   * It is deliberately not derived from `protocolState` here. The columns
   * alone cannot say whether a row is in the P02 regime or the legacy one -
   * that is what the direction column decides - so deriving an anchor set from
   * them would tag a legacy v1 pair as a `v2-envelope` anchor and promote
   * exactly the unproven ancestry this contract exists to refuse. Only the
   * adapter that read the direction knows, so only the adapter may assemble.
   */
  p02AnchorSet = null,
  protocolState = {},
  retainedEvidence = [],
  advertisedTips = [],
  /* Platform adapters may set this only after a configured peer's canonical
   * writer-state/heads advertisement has been verified. It is scheduling
   * authority to enter the canonical Receive reader, not admission evidence. */
  trustedPeerAdvertisementPending = false,
  dirty = false,
  publishable = false,
  pending = false,
  blockReason = null,
  /* Generic durable-integrity signal. classifyObjectState already consumes
   * `descriptor.integrityQuarantined`; the factory simply had no way to set it,
   * so the frozen integrity-quarantined branch was unreachable from a real
   * enumerator. Accepting it here changes no classifier semantics - it makes an
   * existing frozen class reachable. What counts as integrity state is decided
   * by the platform work-authority adapter, never here. */
  integrityQuarantined = false
} = {}) {
  if (!strictIdentifier(objectDomain) ||
      !strictIdentifier(objectId) ||
      !lowerHex64(objectKey) ||
      !strictIdentifier(syncPeerId) ||
      !Array.isArray(retainedEvidence) ||
      !Array.isArray(advertisedTips) ||
      typeof trustedPeerAdvertisementPending !== 'boolean' ||
      (blockReason !== null && !P02_BLOCK_REASONS.includes(blockReason))) {
    throw new TypeError('p02-read-only-object-descriptor-invalid');
  }
  const descriptor = {
    schema: P02_READ_ONLY_DESCRIPTOR_SCHEMA,
    objectDomain,
    objectId,
    objectKey,
    syncPeerId,
    canonicalLocalHead: canonicalHead(canonicalLocalHead),
    p02AnchorSet: requireP02AnchorSet(p02AnchorSet),
    protocolState: normalizeProtocolState(protocolState),
    retainedEvidence: sortEvidence(retainedEvidence),
    advertisedTips: sortTips(advertisedTips),
    trustedPeerAdvertisementPending,
    dirty: dirty === true,
    publishable: publishable === true,
    pending: pending === true,
    blockReason,
    integrityQuarantined: integrityQuarantined === true,
    orderingKey: `${objectDomain}\u0000${objectId}\u0000${syncPeerId}`
  };
  return freezeDeep(descriptor);
}

export function sortReadOnlyObjectDescriptors(descriptors) {
  if (!Array.isArray(descriptors)) {
    throw new TypeError('p02-read-only-object-descriptors-invalid');
  }
  return Object.freeze([...descriptors].sort((left, right) =>
    left.orderingKey.localeCompare(right.orderingKey) ||
      left.objectKey.localeCompare(right.objectKey)));
}

function normalizedEvidence(raw) {
  const source = isPlainObject(raw?.document) ? raw.document : raw;
  if (!isPlainObject(source) ||
      !strictIdentifier(source.revisionId) ||
      !lowerHex64(raw?.revisionBlobSha256 || raw?.blobSha256)) {
    throw new TypeError('p02-classifier-evidence-invalid');
  }
  const previousRevisionId = source.previousRevisionId;
  const previousRevisionBlobSha256 = source.previousRevisionBlobSha256;
  const root = previousRevisionId === null && previousRevisionBlobSha256 === null;
  const child = strictIdentifier(previousRevisionId) &&
    lowerHex64(previousRevisionBlobSha256);
  if (!root && !child) throw new TypeError('p02-classifier-parent-pair-invalid');
  const closureType = source.closureType ?? null;
  if (closureType !== null && !CLOSURE_TYPES.has(closureType)) {
    throw new TypeError('p02-classifier-closure-invalid');
  }
  let selectedRevision = null;
  if (closureType === 'branch-superseded') {
    const selected = source.selectedRevision;
    if (!isPlainObject(selected) ||
        !strictIdentifier(selected.revisionId) ||
        !lowerHex64(selected.revisionBlobSha256)) {
      throw new TypeError('p02-classifier-closure-invalid');
    }
    selectedRevision = {
      revisionId: selected.revisionId,
      revisionBlobSha256: selected.revisionBlobSha256
    };
  } else if (source.selectedRevision != null) {
    throw new TypeError('p02-classifier-closure-invalid');
  }
  return {
    revisionId: source.revisionId,
    revisionBlobSha256: raw.revisionBlobSha256 || raw.blobSha256,
    previousRevisionId,
    previousRevisionBlobSha256,
    validated: raw.validated === true,
    closureType,
    selectedRevision
  };
}

function normalizeEvidenceSet(values) {
  if (!Array.isArray(values)) throw new TypeError('p02-classifier-evidence-invalid');
  const byRevision = new Map();
  for (const raw of values) {
    const node = normalizedEvidence(raw);
    const prior = byRevision.get(node.revisionId);
    if (prior) {
      if (JSON.stringify(prior) !== JSON.stringify(node)) {
        throw new TypeError('p02-classifier-duplicate-revision-conflict');
      }
      continue;
    }
    byRevision.set(node.revisionId, node);
  }
  return [...byRevision.values()].sort((left, right) =>
    left.revisionId.localeCompare(right.revisionId));
}

function deriveGraph(nodes) {
  const byRevision = new Map(nodes.map((node) => [node.revisionId, node]));
  const proven = new Set();
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of nodes) {
      if (!node.validated || proven.has(node.revisionId)) continue;
      if (node.previousRevisionId === null) {
        proven.add(node.revisionId);
        changed = true;
        continue;
      }
      const parent = byRevision.get(node.previousRevisionId);
      if (parent && proven.has(parent.revisionId) &&
          parent.revisionBlobSha256 === node.previousRevisionBlobSha256) {
        proven.add(node.revisionId);
        changed = true;
      }
    }
  }
  return { byRevision, proven };
}

function isClosure(node) {
  return node.closureType !== null;
}

function isContent(node) {
  return !isClosure(node);
}

function isAncestor(graph, ancestorId, descendantId) {
  let cursor = graph.byRevision.get(descendantId);
  const seen = new Set();
  while (cursor && cursor.previousRevisionId !== null) {
    if (seen.has(cursor.revisionId)) return false;
    seen.add(cursor.revisionId);
    if (cursor.previousRevisionId === ancestorId) return true;
    cursor = graph.byRevision.get(cursor.previousRevisionId);
  }
  return false;
}

function normalizedAdvertisedTips(values) {
  if (!Array.isArray(values)) throw new TypeError('p02-classifier-tips-invalid');
  return values.map((tip) => {
    if (!isPlainObject(tip) ||
        !strictIdentifier(tip.revisionId) ||
        !lowerHex64(tip.revisionBlobSha256)) {
      throw new TypeError('p02-classifier-tips-invalid');
    }
    return {
      revisionId: tip.revisionId,
      revisionBlobSha256: tip.revisionBlobSha256
    };
  }).sort((left, right) =>
    left.revisionId.localeCompare(right.revisionId) ||
      left.revisionBlobSha256.localeCompare(right.revisionBlobSha256));
}

function output(classification, {
  reason = null,
  liveRevisionIds = [],
  applyCandidateRevisionId = null,
  applyEligibleByEvidence = false,
  publishable = false,
  evidencePostures = [],
  staleClosureRevisionIds = [],
  unprovenRevisionIds = []
} = {}) {
  return freezeDeep({
    classification,
    reason,
    liveRevisionIds: [...new Set(liveRevisionIds)].sort(),
    applyCandidateRevisionId,
    applyEligibleByEvidence,
    publishable,
    evidencePostures: [...new Set(evidencePostures)].sort(),
    staleClosureRevisionIds: [...new Set(staleClosureRevisionIds)].sort(),
    unprovenRevisionIds: [...new Set(unprovenRevisionIds)].sort()
  });
}

function integrity(reason) {
  return output(P02_CLASSIFICATION.INTEGRITY_QUARANTINED, { reason });
}

export function classifyObjectState(input = {}) {
  if (!isPlainObject(input)) return integrity('classifier-input-invalid');
  const descriptor = input.descriptor || input;
  if (!isPlainObject(descriptor)) return integrity('classifier-input-invalid');
  if (descriptor.gateState === 'unsupported') {
    return output(P02_CLASSIFICATION.UNSUPPORTED_FORMAT, {
      reason: 'unsupported-format'
    });
  }
  if (descriptor.integrityQuarantined === true) {
    return integrity('retained-evidence-quarantined');
  }
  const blockReason = descriptor.blockReason ?? null;
  if (blockReason !== null) {
    if (!P02_BLOCK_REASONS.includes(blockReason)) {
      return integrity('block-reason-invalid');
    }
    return output(`blocked(${blockReason})`, { reason: blockReason });
  }

  let canonical;
  let nodes;
  let advertisedTips;
  try {
    canonical = canonicalHead(descriptor.canonicalLocalHead ?? null);
    nodes = normalizeEvidenceSet(descriptor.retainedEvidence || []);
    advertisedTips = normalizedAdvertisedTips(descriptor.advertisedTips || []);
  } catch (error) {
    return integrity(error?.message || 'classifier-input-invalid');
  }

  const graph = deriveGraph(nodes);
  const unproven = nodes.filter((node) => !graph.proven.has(node.revisionId));
  const proven = nodes.filter((node) => graph.proven.has(node.revisionId));

  /*
   * A durable branch-backed Apply intent is an uncertainty record, not retry
   * authority. It may nevertheless re-enter the same classifier-selected
   * manual W-3 route so that the Apply owner can perform its mandatory
   * read-back-first recovery. Both the staged hop and originally selected leaf
   * must still be exact proven evidence; otherwise this is integrity state.
   * The Apply owner will then either commit already-converged content without
   * import or block the unresolved intent. It never blindly imports again.
   */
  const pendingApply = descriptor.protocolState?.pendingApply ?? null;
  if (pendingApply !== null) {
    const hop = graph.byRevision.get(pendingApply.revisionId);
    const leaf = graph.byRevision.get(pendingApply.selectedLeafRevisionId);
    if (descriptor.protocolState?.pendingOperation !== 'apply' ||
        !hop || !leaf ||
        !graph.proven.has(hop.revisionId) ||
        !graph.proven.has(leaf.revisionId) ||
        hop.revisionBlobSha256 !== pendingApply.revisionBlobSha256 ||
        leaf.revisionBlobSha256 !==
          pendingApply.selectedLeafRevisionBlobSha256) {
      return integrity('pending-apply-evidence-invalid');
    }
    return output(P02_CLASSIFICATION.REMOTE_AHEAD, {
      reason: 'pending-apply-recovery',
      liveRevisionIds: [leaf.revisionId],
      applyCandidateRevisionId: leaf.revisionId,
      applyEligibleByEvidence: true
    });
  }
  const contentChildrenByParent = new Map();
  for (const node of proven) {
    if (!isContent(node) || node.previousRevisionId === null) continue;
    const children = contentChildrenByParent.get(node.previousRevisionId) || [];
    children.push(node.revisionId);
    contentChildrenByParent.set(node.previousRevisionId, children);
  }

  const closures = proven.filter(isClosure);
  const activeClosures = closures.filter((closure) =>
    (contentChildrenByParent.get(closure.previousRevisionId) || []).length === 0);
  const staleClosures = closures.filter((closure) => !activeClosures.includes(closure));
  const branchClosures = activeClosures.filter((closure) =>
    closure.closureType === 'branch-superseded');
  const postures = [];
  if (closures.some((closure) => closure.closureType === 'branch-superseded')) {
    postures.push(P02_EVIDENCE_POSTURE.BRANCH_SUPERSEDED);
  }
  if (staleClosures.length > 0) {
    postures.push(P02_EVIDENCE_POSTURE.STALE_RESOLUTION);
  }

  for (const closure of branchClosures) {
    const target = graph.byRevision.get(closure.selectedRevision.revisionId);
    if (!target || !graph.proven.has(target.revisionId) ||
        target.revisionBlobSha256 !== closure.selectedRevision.revisionBlobSha256) {
      return output(P02_CLASSIFICATION.RESOLUTION_TARGET_MISSING, {
        reason: 'selected-revision-absent-or-unproven',
        evidencePostures: postures,
        staleClosureRevisionIds: staleClosures.map((node) => node.revisionId),
        unprovenRevisionIds: unproven.map((node) => node.revisionId)
      });
    }
  }

  for (const left of branchClosures) {
    for (const right of branchClosures) {
      if (left.revisionId === right.revisionId) continue;
      if (left.previousRevisionId === right.selectedRevision.revisionId &&
          left.selectedRevision.revisionId === right.previousRevisionId) {
        return output(P02_CLASSIFICATION.RESOLUTION_CONFLICT, {
          reason: 'opposite-resolutions',
          evidencePostures: postures,
          staleClosureRevisionIds: staleClosures.map((node) => node.revisionId)
        });
      }
    }
  }

  const missingAdvertised = advertisedTips.filter((tip) => {
    if (canonical && canonical.revisionId === tip.revisionId &&
        canonical.revisionBlobSha256 === tip.revisionBlobSha256) return false;
    const retained = graph.byRevision.get(tip.revisionId);
    return !retained || retained.revisionBlobSha256 !== tip.revisionBlobSha256;
  });
  if (unproven.length === 0 && missingAdvertised.length > 0 &&
      descriptor.trustedPeerAdvertisementPending === true) {
    return output(P02_CLASSIFICATION.REMOTE_AHEAD, {
      reason: 'trusted-peer-advertisement-pending-admission',
      liveRevisionIds: missingAdvertised.map((tip) => tip.revisionId),
      applyCandidateRevisionId: null,
      applyEligibleByEvidence: false,
      evidencePostures: postures,
      staleClosureRevisionIds: staleClosures.map((node) => node.revisionId)
    });
  }
  if (unproven.length > 0 || missingAdvertised.length > 0) {
    if (unproven.length > 0) {
      postures.push(P02_EVIDENCE_POSTURE.RETAINED_UNPROVEN_PARENT);
    }
    return output('blocked(transport)', {
      reason: unproven.length > 0
        ? P02_EVIDENCE_POSTURE.RETAINED_UNPROVEN_PARENT
        : 'advertised-tip-bytes-missing',
      evidencePostures: postures,
      staleClosureRevisionIds: staleClosures.map((node) => node.revisionId),
      unprovenRevisionIds: unproven.map((node) => node.revisionId)
    });
  }

  const contentLeaves = proven.filter((node) =>
    isContent(node) &&
    (contentChildrenByParent.get(node.revisionId) || []).length === 0);
  const closedParentIds = new Set(activeClosures.map((closure) =>
    closure.previousRevisionId));
  const liveLeaves = contentLeaves.filter((node) =>
    !closedParentIds.has(node.revisionId));
  const liveRevisionIds = liveLeaves.map((node) => node.revisionId).sort();
  const selectedIds = new Set(branchClosures.map((closure) =>
    closure.selectedRevision.revisionId));

  if (liveLeaves.length > 1) {
    postures.push(P02_EVIDENCE_POSTURE.RETAINED_DIVERGENT);
    return output(P02_CLASSIFICATION.DIVERGED_UNRESOLVED, {
      reason: staleClosures.length > 0 ? 'stale-resolution' : 'multiple-live-leaves',
      liveRevisionIds,
      evidencePostures: postures,
      staleClosureRevisionIds: staleClosures.map((node) => node.revisionId)
    });
  }

  if (liveLeaves.length === 0) {
    const deletions = activeClosures.filter((closure) =>
      closure.closureType === 'object-deleted');
    if (deletions.length > 0) {
      const candidate = [...deletions].sort((left, right) =>
        left.revisionId.localeCompare(right.revisionId)).at(-1);
      return output(P02_CLASSIFICATION.OBJECT_DELETED, {
        reason: 'typed-object-deletion',
        applyCandidateRevisionId: candidate.revisionId,
        applyEligibleByEvidence: true,
        evidencePostures: postures,
        staleClosureRevisionIds: staleClosures.map((node) => node.revisionId)
      });
    }
    if (canonical?.deleted) {
      return output(P02_CLASSIFICATION.OBJECT_DELETED, {
        reason: 'canonical-soft-delete',
        evidencePostures: postures,
        staleClosureRevisionIds: staleClosures.map((node) => node.revisionId)
      });
    }
    if (canonical && descriptor.dirty === true) {
      return output(P02_CLASSIFICATION.LOCAL_AHEAD, {
        reason: 'canonical-local-change',
        publishable: descriptor.publishable === true,
        evidencePostures: postures,
        staleClosureRevisionIds: staleClosures.map((node) => node.revisionId)
      });
    }
    return output(P02_CLASSIFICATION.CONVERGED, {
      reason: canonical ? 'canonical-known' : 'empty-object',
      evidencePostures: postures,
      staleClosureRevisionIds: staleClosures.map((node) => node.revisionId)
    });
  }

  const live = liveLeaves[0];
  const common = {
    liveRevisionIds,
    evidencePostures: postures,
    staleClosureRevisionIds: staleClosures.map((node) => node.revisionId)
  };
  if (!canonical) {
    return output(P02_CLASSIFICATION.REMOTE_AHEAD, {
      ...common,
      reason: 'admitted-live-content',
      applyCandidateRevisionId: live.revisionId,
      applyEligibleByEvidence: true
    });
  }
  if (canonical.revisionId === live.revisionId &&
      canonical.revisionBlobSha256 === live.revisionBlobSha256) {
    if (descriptor.dirty === true) {
      return output(P02_CLASSIFICATION.LOCAL_AHEAD, {
        ...common,
        reason: 'canonical-local-change',
        publishable: descriptor.publishable === true
      });
    }
    return output(P02_CLASSIFICATION.CONVERGED, {
      ...common,
      reason: canonical.deleted ? 'canonical-soft-delete' : 'canonical-live-match'
    });
  }
  const lastApplied = descriptor.protocolState?.lastApplied ?? null;
  const postApplyBridge = canonical.deleted !== true &&
    lastApplied?.revisionId === live.revisionId &&
    lastApplied?.revisionBlobSha256 === live.revisionBlobSha256;
  if (postApplyBridge) {
    if (descriptor.dirty === true) {
      return output(P02_CLASSIFICATION.LOCAL_AHEAD, {
        ...common,
        reason: 'canonical-local-change-after-post-apply-bridge',
        publishable: descriptor.publishable === true
      });
    }
    return output(P02_CLASSIFICATION.CONVERGED, {
      ...common,
      reason: 'post-apply-v1-v2-identity-bridge'
    });
  }
  if (canonical.deleted ||
      selectedIds.has(live.revisionId) ||
      isAncestor(graph, canonical.revisionId, live.revisionId)) {
    return output(P02_CLASSIFICATION.REMOTE_AHEAD, {
      ...common,
      reason: canonical.deleted ? 'normal-revival' : 'proven-descendant',
      applyCandidateRevisionId: live.revisionId,
      applyEligibleByEvidence: true
    });
  }
  if (isAncestor(graph, live.revisionId, canonical.revisionId)) {
    return output(P02_CLASSIFICATION.LOCAL_AHEAD, {
      ...common,
      reason: 'canonical-descends-retained-tip',
      publishable: descriptor.publishable === true
    });
  }
  postures.push(P02_EVIDENCE_POSTURE.RETAINED_DIVERGENT);
  return output(P02_CLASSIFICATION.DIVERGED_UNRESOLVED, {
    reason: 'canonical-and-retained-branches-diverge',
    liveRevisionIds: [live.revisionId, canonical.revisionId],
    evidencePostures: postures,
    staleClosureRevisionIds: staleClosures.map((node) => node.revisionId)
  });
}
