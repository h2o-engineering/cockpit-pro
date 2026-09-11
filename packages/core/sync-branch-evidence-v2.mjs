/*
 * P02 branch-evidence normalization and the derived per-object branch index
 * (Wave 1 / Z6, frozen Y-8 + G.1/G.4).
 *
 * Authority boundary, load-bearing:
 *   - CANONICAL truth is the immutable retained revision evidence plus the
 *     canonical local content/protocol state. This module owns neither.
 *   - Everything this module produces is DERIVED, REBUILDABLE and
 *     NONCANONICAL. Delete the index and rebuild it from retained evidence
 *     and the same graph and the same Y-9 classification come back.
 *   - It is not a conflict authority: it emits structural graph facts and
 *     admission dispositions only. Semantic classification (H.2) belongs to
 *     the Y-9 classifier, which consumes the output of
 *     branchIndexToClassifierInput().
 *   - It is not a queue and not an Apply authority. Retaining bytes is never
 *     accepting them for Apply (G.5).
 *
 * Platform-neutral: no storage, no transport, no crypto, no I/O. Desktop and
 * Chrome both normalize through here so equivalent evidence yields identical
 * graph facts regardless of physical schema.
 */

import {
  P02_ANCHOR_MATCH,
  matchAnchorPair,
  requireP02AnchorSet
} from './sync-p02-anchor-set-v2.mjs';

export const P02_BRANCH_EVIDENCE_V2 = Object.freeze({
  RECORD_SCHEMA: 'h2o.studio.syncBranchEvidence.p02.v1',
  INDEX_SCHEMA: 'h2o.studio.syncBranchIndex.p02.v1'
});

/* Frozen G.1 admission outcomes. Accepted P01 strings keep their meaning. */
export const P02_ADMISSION_DISPOSITION = Object.freeze({
  ACCEPTED_LINEAR: 'accepted-linear',
  RETAINED_DIVERGENT: 'retained-divergent',
  RETAINED_UNPROVEN_PARENT: 'retained-unproven-parent',
  QUARANTINED: 'quarantined',
  ADMITTED_CLOSURE: 'admitted-closure'
});

/* Dispositions that retain evidence but are never Apply-eligible (G.5). */
export const P02_NON_APPLY_DISPOSITIONS = Object.freeze(new Set([
  P02_ADMISSION_DISPOSITION.RETAINED_DIVERGENT,
  P02_ADMISSION_DISPOSITION.RETAINED_UNPROVEN_PARENT,
  P02_ADMISSION_DISPOSITION.QUARANTINED
]));

export const P02_CLOSURE_TYPE = Object.freeze({
  BRANCH_SUPERSEDED: 'branch-superseded',
  OBJECT_DELETED: 'object-deleted'
});

export const P02_BRANCH_EVIDENCE_ERROR = Object.freeze({
  RECORD_INVALID: 'p02-branch-evidence-record-invalid',
  PARENT_PAIR_INVALID: 'p02-branch-evidence-parent-pair-invalid',
  CLOSURE_INVALID: 'p02-branch-evidence-closure-invalid',
  IDENTITY_CONFLICT: 'p02-branch-evidence-identity-conflict',
  OBJECT_SCOPE_INVALID: 'p02-branch-evidence-object-scope-invalid',
  INDEX_INVALID: 'p02-branch-evidence-index-invalid',
  /* Two different representations both claiming to be the anchor. */
  ANCHOR_SOURCE_CONFLICT: 'p02-branch-evidence-anchor-source-conflict'
});

const SHA256_RE = /^[0-9a-f]{64}$/;
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const CLOSURE_TYPES = new Set(Object.values(P02_CLOSURE_TYPE));

export class P02BranchEvidenceError extends Error {
  constructor(code) {
    super(code);
    this.name = 'P02BranchEvidenceError';
    this.code = code;
  }
}

function fail(code) {
  throw new P02BranchEvidenceError(code);
}

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
    !CONTROL_RE.test(value);
}

function lowerHex64(value) {
  return typeof value === 'string' && SHA256_RE.test(value);
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

/*
 * Normalize one retained evidence record into a platform-neutral graph fact.
 *
 * Strict and fail-closed: a malformed ancestry pair is NEVER silently read as
 * a root (frozen E.2/E.6 paired-null rule), and an unknown closure type is
 * rejected rather than downgraded to ordinary content.
 */
export function normalizeRetainedEvidence(raw, {
  allowUnresolvedParentHash = false
} = {}) {
  const document = isPlainObject(raw?.document) ? raw.document : raw;
  if (!isPlainObject(document)) fail(P02_BRANCH_EVIDENCE_ERROR.RECORD_INVALID);
  const revisionBlobSha256 = raw?.revisionBlobSha256 ?? raw?.blobSha256 ?? null;
  if (!strictIdentifier(document.revisionId) || !lowerHex64(revisionBlobSha256)) {
    fail(P02_BRANCH_EVIDENCE_ERROR.RECORD_INVALID);
  }
  /*
   * Required-nullable ancestry: both fields must be PRESENT. Absent is not
   * null, and a mixed pair is malformed - never a valid root (E.6).
   */
  const hasParentId = Object.prototype.hasOwnProperty.call(
    document, 'previousRevisionId'
  );
  const hasParentHash = Object.prototype.hasOwnProperty.call(
    document, 'previousRevisionBlobSha256'
  );
  const previousRevisionId = document.previousRevisionId;
  /*
   * Legacy projection mode. Accepted P01 Chrome observations record the parent
   * revision id but not the parent blob hash, so a v1 record whose parent is
   * not itself retained cannot express the v2 pair. Rather than fabricate a
   * hash or relax the rule, such a node is marked parentHashUnresolved and is
   * therefore NEVER counted as proven - which is exactly the truth: without
   * the parent bytes its ancestry is not proven. Off by default.
   */
  const unresolvedParent = allowUnresolvedParentHash &&
    hasParentId &&
    strictIdentifier(previousRevisionId) &&
    (!hasParentHash || document.previousRevisionBlobSha256 === undefined);
  if (!unresolvedParent && (!hasParentId || !hasParentHash)) {
    fail(P02_BRANCH_EVIDENCE_ERROR.PARENT_PAIR_INVALID);
  }
  const previousRevisionBlobSha256 = unresolvedParent
    ? null
    : document.previousRevisionBlobSha256;
  const root = !unresolvedParent &&
    previousRevisionId === null &&
    previousRevisionBlobSha256 === null;
  const child = unresolvedParent || (strictIdentifier(previousRevisionId) &&
    lowerHex64(previousRevisionBlobSha256));
  if (!root && !child) fail(P02_BRANCH_EVIDENCE_ERROR.PARENT_PAIR_INVALID);

  const closureType = document.closureType ?? null;
  if (closureType !== null && !CLOSURE_TYPES.has(closureType)) {
    fail(P02_BRANCH_EVIDENCE_ERROR.CLOSURE_INVALID);
  }
  let selectedRevision = null;
  if (closureType === P02_CLOSURE_TYPE.BRANCH_SUPERSEDED) {
    const selected = document.selectedRevision;
    if (!isPlainObject(selected) ||
        !strictIdentifier(selected.revisionId) ||
        !lowerHex64(selected.revisionBlobSha256)) {
      fail(P02_BRANCH_EVIDENCE_ERROR.CLOSURE_INVALID);
    }
    selectedRevision = {
      revisionId: selected.revisionId,
      revisionBlobSha256: selected.revisionBlobSha256
    };
  } else if (closureType === P02_CLOSURE_TYPE.OBJECT_DELETED &&
      document.selectedRevision != null) {
    /* Whole-object deletion carries no selected-revision reference (F.2). */
    fail(P02_BRANCH_EVIDENCE_ERROR.CLOSURE_INVALID);
  }
  /* Closure revisions can never be a source of canonical live content (F.3). */
  return freezeDeep({
    schema: P02_BRANCH_EVIDENCE_V2.RECORD_SCHEMA,
    objectDomain: document.objectDomain ?? null,
    objectId: document.objectId ?? null,
    revisionId: document.revisionId,
    revisionBlobSha256,
    previousRevisionId: root ? null : previousRevisionId,
    previousRevisionBlobSha256: root ? null : previousRevisionBlobSha256,
    parentHashUnresolved: unresolvedParent === true,
    isRoot: root,
    closureType,
    selectedRevision,
    isClosure: closureType !== null,
    isContent: closureType === null,
    validated: raw?.validated !== false,
    disposition: raw?.disposition ?? null,
    sourceWriter: raw?.sourceWriter ?? null,
    document
  });
}

/*
 * Anchor-hop resolution (A1 §8).
 *
 * `p02AnchorSet` is the amended, typed anchor: repository-proven v2 protocol
 * pairs, matched blob-keyed and id-cross-checked. `canonicalAnchorRevisionId`
 * is the LEGACY v1-lane anchor and is id-only by construction; it is kept so
 * the accepted P01 path stays byte-identical, and it is barred from ever
 * standing in for a P02 anchor - supplying both is a contradiction about which
 * representation is anchoring, so it is refused rather than silently ranked.
 */
function resolveAnchorHop({ anchorSet, legacyAnchorRevisionId, node }) {
  if (anchorSet && legacyAnchorRevisionId !== null) {
    fail(P02_BRANCH_EVIDENCE_ERROR.ANCHOR_SOURCE_CONFLICT);
  }
  if (anchorSet) {
    return matchAnchorPair(anchorSet, {
      revisionId: node.previousRevisionId,
      revisionBlobSha256: node.previousRevisionBlobSha256
    });
  }
  if (legacyAnchorRevisionId !== null &&
      node.previousRevisionId === legacyAnchorRevisionId) {
    return P02_ANCHOR_MATCH.PROVEN;
  }
  return P02_ANCHOR_MATCH.ABSENT;
}

/*
 * Build the derived per-object branch index from retained immutable evidence.
 *
 * Pure and total: the same record set always yields the same index, so the
 * index is a cache of the evidence and never an independent truth.
 */
export function buildBranchIndex({
  objectDomain = null,
  objectId = null,
  records = [],
  /* Amended anchor (A1 §8): repository-proven v2 pairs, blob-keyed. */
  p02AnchorSet = null,
  /*
   * CR1 identity-squat hardening, opt-in.
   *
   * By default a revisionId appearing twice with divergent bytes throws, which
   * is right when the caller controls every record: the set is incoherent and
   * there is nothing to salvage. It is wrong when records arrive from a peer,
   * because then ONE hostile or corrupted record destroys the index for every
   * honest record beside it - a denial of service by insertion.
   *
   * With this set, the conflicting node is quarantined and excluded, and the
   * rest of the object's evidence indexes normally. The default is unchanged
   * so the accepted callers keep their exact behaviour.
   */
  quarantineIdentityConflicts = false,
  /* Legacy v1-lane anchor, id-only. Never a P02 anchor; see resolveAnchorHop. */
  canonicalAnchorRevisionId = null,
  allowUnresolvedParentHash = false
} = {}) {
  if (!Array.isArray(records)) fail(P02_BRANCH_EVIDENCE_ERROR.INDEX_INVALID);
  const anchorSet = requireP02AnchorSet(p02AnchorSet);
  const nodes = records.map((record) =>
    normalizeRetainedEvidence(record, { allowUnresolvedParentHash }));

  const byRevision = new Map();
  /* Revision ids claimed by two records with different bytes (CR1). */
  const squatted = new Set();
  for (const node of nodes) {
    if (objectId !== null && node.objectId !== null && node.objectId !== objectId) {
      fail(P02_BRANCH_EVIDENCE_ERROR.OBJECT_SCOPE_INVALID);
    }
    const existing = byRevision.get(node.revisionId);
    if (existing) {
      /* Same revision identity with divergent bytes is an integrity failure. */
      if (existing.revisionBlobSha256 !== node.revisionBlobSha256) {
        if (!quarantineIdentityConflicts) {
          fail(P02_BRANCH_EVIDENCE_ERROR.IDENTITY_CONFLICT);
        }
        /*
         * Both claimants are excluded, not just the later one. Keeping the
         * first-seen record would make admission order decide which of two
         * contradictory claims wins, and arrival order is exactly what an
         * attacker controls.
         */
        squatted.add(node.revisionId);
        continue;
      }
      continue;
    }
    byRevision.set(node.revisionId, node);
  }

  for (const revisionId of squatted) byRevision.delete(revisionId);

  const childrenByParent = new Map();
  for (const node of [...byRevision.values()]) {
    if (node.previousRevisionId === null) continue;
    const bucket = childrenByParent.get(node.previousRevisionId) || [];
    bucket.push(node.revisionId);
    childrenByParent.set(node.previousRevisionId, bucket);
  }
  for (const bucket of childrenByParent.values()) bucket.sort();

  /*
   * Proven parenthood: a node is proven when it chains to a retained root or
   * to the canonical anchor without a cycle and without a missing hop. Parent
   * bytes must match the child's recorded parent hash - a hash mismatch keeps
   * the child unproven rather than silently accepting a different ancestor.
   */
  const proven = new Set();
  /* Nodes whose anchor claim is contradicted by the anchor's own bytes. */
  const identityConflicts = new Set();
  const provenOf = (node, seen) => {
    if (proven.has(node.revisionId)) return true;
    if (seen.has(node.revisionId)) return false;
    seen.add(node.revisionId);
    if (node.isRoot) return true;
    /* No parent bytes means no proof of parenthood. */
    if (node.parentHashUnresolved) return false;
    if (!byRevision.has(node.previousRevisionId)) {
      const hop = resolveAnchorHop({
        anchorSet, legacyAnchorRevisionId: canonicalAnchorRevisionId, node
      });
      /*
       * Right id, wrong bytes. The node claims descent from the anchor while
       * recording parent content the anchor does not have, so the claim is not
       * merely unproven - it contradicts proven state, and quarantines.
       */
      if (hop === P02_ANCHOR_MATCH.IDENTITY_CONFLICT) {
        identityConflicts.add(node.revisionId);
        return false;
      }
      if (hop === P02_ANCHOR_MATCH.PROVEN) return true;
    }
    const parent = byRevision.get(node.previousRevisionId);
    if (!parent) return false;
    if (parent.revisionBlobSha256 !== node.previousRevisionBlobSha256) return false;
    return provenOf(parent, seen);
  };
  for (const node of [...byRevision.values()]) {
    if (provenOf(node, new Set())) proven.add(node.revisionId);
  }

  const all = [...byRevision.values()]
    .sort((left, right) => left.revisionId.localeCompare(right.revisionId));
  const provenNodes = all.filter((node) => proven.has(node.revisionId));
  const unprovenNodes = all.filter((node) => !proven.has(node.revisionId));

  const contentChildrenByParent = new Map();
  for (const node of provenNodes) {
    if (!node.isContent || node.previousRevisionId === null) continue;
    const bucket = contentChildrenByParent.get(node.previousRevisionId) || [];
    bucket.push(node.revisionId);
    contentChildrenByParent.set(node.previousRevisionId, bucket);
  }

  const closures = provenNodes.filter((node) => node.isClosure);
  /*
   * A closure governs only its exact parent leaf (F.4). If that parent has
   * gained a content child elsewhere, the closure is stale diagnostic
   * evidence and closes nothing - descendants are never silently closed.
   */
  const activeClosures = closures.filter((closure) =>
    (contentChildrenByParent.get(closure.previousRevisionId) || []).length === 0);
  const staleClosures = closures.filter((closure) => !activeClosures.includes(closure));
  const closedParentIds = new Set(activeClosures.map((c) => c.previousRevisionId));

  const contentLeaves = provenNodes.filter((node) =>
    node.isContent &&
    (contentChildrenByParent.get(node.revisionId) || []).length === 0);
  const liveLeaves = contentLeaves.filter((node) => !closedParentIds.has(node.revisionId));

  return freezeDeep({
    schema: P02_BRANCH_EVIDENCE_V2.INDEX_SCHEMA,
    derived: true,
    rebuildableFrom: 'retained-immutable-evidence',
    objectDomain,
    objectId,
    revisionIds: all.map((node) => node.revisionId),
    parentByRevision: Object.fromEntries(
      all.map((node) => [node.revisionId, node.previousRevisionId])
    ),
    childrenByParent: Object.fromEntries([...childrenByParent.entries()].sort()),
    provenRevisionIds: provenNodes.map((node) => node.revisionId),
    unprovenRevisionIds: unprovenNodes.map((node) => node.revisionId),
    /*
     * Unproven for a REASON, not merely for lack of evidence: these nodes name
     * an anchor whose bytes contradict what they recorded. Kept separate so a
     * consumer can quarantine them instead of waiting forever for a parent
     * that is already present and already disagrees.
     */
    identityConflictRevisionIds: [...identityConflicts].sort(),
    /* CR1: ids excluded because two records claimed them with different bytes. */
    identitySquattedRevisionIds: [...squatted].sort(),
    closureRevisionIds: closures.map((node) => node.revisionId),
    activeClosureRevisionIds: activeClosures.map((node) => node.revisionId),
    staleClosureRevisionIds: staleClosures.map((node) => node.revisionId),
    liveLeafRevisionIds: liveLeaves.map((node) => node.revisionId).sort(),
    closedParentRevisionIds: [...closedParentIds].sort(),
    nodes: all
  });
}

/*
 * G.1 admission disposition for one candidate against retained evidence.
 *
 * This decides HOW to retain, never what the object's state MEANS - H.2
 * semantics stay with Y-9. Nothing here authorizes Apply.
 */
export function classifyAdmission({
  index,
  candidate,
  p02AnchorSet = null,
  canonicalAnchorRevisionId = null,
  capacityAvailable = true,
  allowUnresolvedParentHash = false
} = {}) {
  if (!isPlainObject(index) || index.schema !== P02_BRANCH_EVIDENCE_V2.INDEX_SCHEMA) {
    fail(P02_BRANCH_EVIDENCE_ERROR.INDEX_INVALID);
  }
  let node;
  try {
    node = normalizeRetainedEvidence(candidate, { allowUnresolvedParentHash });
  } catch (error) {
    /* Malformed candidates quarantine; they are never deleted (G.1). */
    return freezeDeep({
      disposition: P02_ADMISSION_DISPOSITION.QUARANTINED,
      reason: error?.code || P02_BRANCH_EVIDENCE_ERROR.RECORD_INVALID,
      applyEligible: false,
      retained: true
    });
  }

  const known = index.nodes.find((item) => item.revisionId === node.revisionId);
  if (known) {
    if (known.revisionBlobSha256 !== node.revisionBlobSha256) {
      /* Same identity, divergent bytes: fail closed, retain what we had. */
      return freezeDeep({
        disposition: P02_ADMISSION_DISPOSITION.QUARANTINED,
        reason: P02_BRANCH_EVIDENCE_ERROR.IDENTITY_CONFLICT,
        applyEligible: false,
        retained: true,
        replay: false
      });
    }
    return freezeDeep({
      disposition: known.isClosure
        ? P02_ADMISSION_DISPOSITION.ADMITTED_CLOSURE
        : (known.disposition || P02_ADMISSION_DISPOSITION.ACCEPTED_LINEAR),
      reason: 'identical-replay',
      applyEligible: false,
      retained: true,
      replay: true
    });
  }

  /*
   * Capacity refusal (G.6): nothing already retained is touched, no canonical
   * content changes, and the new item is simply not admitted. Recoverable.
   */
  if (capacityAvailable !== true) {
    return freezeDeep({
      disposition: null,
      reason: 'capacity-exhausted',
      applyEligible: false,
      retained: false,
      admitted: false,
      blockedReason: 'capacity'
    });
  }

  if (node.previousRevisionId === node.revisionId) {
    return freezeDeep({
      disposition: P02_ADMISSION_DISPOSITION.QUARANTINED,
      reason: 'self-parent',
      applyEligible: false,
      retained: true
    });
  }

  const anchorSet = requireP02AnchorSet(p02AnchorSet);
  const anchorHop = node.isRoot ? P02_ANCHOR_MATCH.ABSENT : resolveAnchorHop({
    anchorSet, legacyAnchorRevisionId: canonicalAnchorRevisionId, node
  });
  if (anchorHop === P02_ANCHOR_MATCH.IDENTITY_CONFLICT) {
    /*
     * The candidate names an anchor pair and records parent bytes the anchor
     * does not have. Retaining it as merely unproven would leave it waiting
     * for a parent that is present and disagrees, so it fails closed here -
     * retained, never Apply-eligible, never deleted (G.1).
     */
    return freezeDeep({
      disposition: P02_ADMISSION_DISPOSITION.QUARANTINED,
      reason: P02_BRANCH_EVIDENCE_ERROR.IDENTITY_CONFLICT,
      applyEligible: false,
      retained: true,
      anchorConflict: true
    });
  }
  const parentKnown = node.isRoot ||
    index.provenRevisionIds.includes(node.previousRevisionId) ||
    anchorHop === P02_ANCHOR_MATCH.PROVEN;
  if (!parentKnown) {
    /*
     * Structurally valid, ancestry not yet proven. Retain durably, never
     * Apply-eligible, and never treat as deletion. When the parent arrives
     * the rebuilt index promotes it with no operator action (frozen L.3).
     */
    return freezeDeep({
      disposition: P02_ADMISSION_DISPOSITION.RETAINED_UNPROVEN_PARENT,
      reason: 'parent-not-yet-proven',
      applyEligible: false,
      retained: true
    });
  }

  if (node.isClosure) {
    return freezeDeep({
      disposition: P02_ADMISSION_DISPOSITION.ADMITTED_CLOSURE,
      reason: node.closureType,
      closureType: node.closureType,
      /*
       * branch-superseded updates evidence and index only. object-deleted may
       * later stage a canonical soft-delete Apply through the EXISTING
       * authorization path - never through this module (G.4).
       */
      stagesCanonicalApply: node.closureType === P02_CLOSURE_TYPE.OBJECT_DELETED,
      applyEligible: false,
      retained: true
    });
  }

  const siblings = index.childrenByParent[node.previousRevisionId] || [];
  if (node.isRoot) {
    const competingRoots = index.nodes.filter((item) => item.isRoot);
    if (competingRoots.length > 0) {
      return freezeDeep({
        disposition: P02_ADMISSION_DISPOSITION.RETAINED_DIVERGENT,
        reason: 'competing-root',
        applyEligible: false,
        retained: true
      });
    }
  } else if (siblings.length > 0) {
    /*
     * The P02 fork case. P01 Chrome terminally rejected this; P02 retains the
     * branch as immutable evidence, leaves the object unresolved for Y-9, and
     * authorizes no Apply of either side.
     */
    return freezeDeep({
      disposition: P02_ADMISSION_DISPOSITION.RETAINED_DIVERGENT,
      reason: 'sibling-fork',
      siblingRevisionIds: [...siblings].sort(),
      applyEligible: false,
      retained: true
    });
  }

  return freezeDeep({
    disposition: P02_ADMISSION_DISPOSITION.ACCEPTED_LINEAR,
    reason: 'fast-forward',
    applyEligible: false,
    retained: true
  });
}

/*
 * Bridge to the Y-9 classifier. Storage produces normalized facts; Y-9 alone
 * decides H.2 semantics, so no database-specific code becomes a second public
 * semantic taxonomy.
 */
export function branchIndexToClassifierInput({
  index,
  objectDomain = null,
  objectId = null,
  objectKey = null,
  syncPeerId = null,
  canonicalLocalHead = null,
  /*
   * The amended anchor rides on the descriptor so the classifier sees exactly
   * the pairs the index was built against. `canonicalLocalHead` travels beside
   * it and is NOT interchangeable with it: one is a v1 projection head, the
   * other is a set of v2 protocol pairs.
   */
  p02AnchorSet = null,
  advertisedTips = [],
  dirty = false,
  publishable = false,
  blockReason = null,
  integrityQuarantined = false,
  gateState = null
} = {}) {
  if (!isPlainObject(index) || index.schema !== P02_BRANCH_EVIDENCE_V2.INDEX_SCHEMA) {
    fail(P02_BRANCH_EVIDENCE_ERROR.INDEX_INVALID);
  }
  return freezeDeep({
    objectDomain: objectDomain ?? index.objectDomain,
    objectId: objectId ?? index.objectId,
    objectKey,
    syncPeerId,
    canonicalLocalHead,
    p02AnchorSet: requireP02AnchorSet(p02AnchorSet),
    retainedEvidence: index.nodes.map((node) => ({
      document: node.document,
      revisionBlobSha256: node.revisionBlobSha256,
      validated: node.validated
    })),
    advertisedTips,
    dirty,
    publishable,
    blockReason,
    integrityQuarantined,
    gateState
  });
}

/*
 * Rebuild proof helper: two index builds over the same evidence must be
 * structurally identical. Used by tests to show the index is a cache.
 */
export function branchIndexFingerprint(index) {
  if (!isPlainObject(index) || index.schema !== P02_BRANCH_EVIDENCE_V2.INDEX_SCHEMA) {
    fail(P02_BRANCH_EVIDENCE_ERROR.INDEX_INVALID);
  }
  return JSON.stringify({
    revisionIds: index.revisionIds,
    parentByRevision: index.parentByRevision,
    childrenByParent: index.childrenByParent,
    provenRevisionIds: index.provenRevisionIds,
    unprovenRevisionIds: index.unprovenRevisionIds,
    identityConflictRevisionIds: index.identityConflictRevisionIds ?? [],
    identitySquattedRevisionIds: index.identitySquattedRevisionIds ?? [],
    closureRevisionIds: index.closureRevisionIds,
    activeClosureRevisionIds: index.activeClosureRevisionIds,
    staleClosureRevisionIds: index.staleClosureRevisionIds,
    liveLeafRevisionIds: index.liveLeafRevisionIds,
    closedParentRevisionIds: index.closedParentRevisionIds
  });
}
