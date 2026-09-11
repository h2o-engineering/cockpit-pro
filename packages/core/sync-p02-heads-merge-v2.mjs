/*
 * O1-T15 — heads snapshot merge.
 *
 * A writer publishes ONE object at a time, but its pointer names ONE snapshot
 * that advertises ALL of its objects. So every publication is a merge, and
 * getting the merge wrong is how a writer silently unpublishes everything else
 * it holds.
 *
 * That is not hypothetical. Building a snapshot from only the heads of the
 * object being published produces a valid, verifiable snapshot that advertises
 * exactly one object - and a peer reading it cannot tell "these objects were
 * withdrawn" from "the writer forgot to carry them". Absence is not a
 * withdrawal, and this module exists so it can never be mistaken for one: an
 * object leaves advertisement through the protocol's closure semantics, never
 * by omission.
 *
 * THE BASE IS A SPECIFIC READ, NOT "the current state". Everything here - the
 * carried groups, the superset check, and the CAS token - comes from ONE
 * readWriterState performed in THIS publication attempt. Re-reading later to
 * "refresh" would silently rebaseline the plan onto a pointer that moved after
 * the merge was decided, and the CAS would then confirm a state nobody
 * inspected. That is why the token travels WITH the plan.
 *
 * CARRIED GROUPS ARE NOT RE-PROVEN. The base snapshot is verified, and a
 * verified snapshot is the transitive proof of everything it advertises. Only
 * the group being replaced needs current proof. Re-proving the rest would make
 * publication cost grow with library size for no additional guarantee.
 *
 * ONLY PROVEN TIPS MAY BE ADVERTISED. A retained-unproven tip is evidence we
 * are holding, not a head we are claiming; advertising one would tell peers to
 * chain onto ancestry we could not establish ourselves.
 */

export const P02_HEADS_MERGE_V2 = Object.freeze({
  SCHEMA: 'h2o.studio.syncP02HeadsMergePlan.v1',
  groupKey: (objectDomain, objectId) => `${objectDomain}\u0000${objectId}`
});

export const P02_HEADS_MERGE_ERROR = Object.freeze({
  BASE_INVALID: 'p02-heads-merge-base-invalid',
  BASE_UNPROVEN: 'p02-heads-merge-base-unproven',
  TARGET_INVALID: 'p02-heads-merge-target-invalid',
  REPLACEMENT_EMPTY: 'p02-heads-merge-replacement-empty',
  REPLACEMENT_UNPROVEN: 'p02-heads-merge-replacement-unproven',
  REPLACEMENT_FOREIGN: 'p02-heads-merge-replacement-foreign-object',
  SOURCE_TIMESTAMP_MISSING: 'p02-heads-merge-source-timestamp-missing',
  WRITER_IDENTITY_MISMATCH: 'p02-heads-merge-writer-identity-mismatch',
  SUPERSET_VIOLATED: 'p02-heads-merge-superset-violated',
  CAS_TOKEN_MISSING: 'p02-heads-merge-cas-token-missing'
});

const HEX64 = /^[0-9a-f]{64}$/;
const hex64 = (value) => typeof value === 'string' && HEX64.test(value);
const clean = (value) => (typeof value === 'string' ? value.trim() : '');
const isPlainObject = (value) =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function fail(code, detail = null) {
  const error = new Error(code);
  error.code = code;
  if (detail !== null) error.detail = detail;
  throw error;
}

/*
 * A head carried forward is copied field for field from the verified base.
 * Recomputing any part of it - including re-deriving a timestamp - would let a
 * carried group's bytes drift, and byte-stability of untouched groups is the
 * property that makes "the rest is unchanged" checkable rather than asserted.
 */
function carryHead(head) {
  return Object.freeze({
    objectDomain: head.objectDomain,
    objectId: head.objectId,
    objectKey: head.objectKey,
    revisionId: head.revisionId,
    payloadSha256: head.payloadSha256,
    revisionBlobSha256: head.revisionBlobSha256,
    previousRevisionId: head.previousRevisionId ?? null,
    previousRevisionBlobSha256: head.previousRevisionBlobSha256 ?? null,
    sourceUpdatedAtIso: head.sourceUpdatedAtIso,
    writerSyncPeerId: head.writerSyncPeerId
  });
}

/*
 * Plan the merge. Pure: it reads nothing and writes nothing, so the plan can be
 * inspected, asserted on, and handed to the transport unchanged.
 */
export function planHeadsMerge({
  baseWriterState,
  ownedWriterSyncPeerId,
  objectDomain,
  objectId,
  objectKey,
  /* The COMPLETE advertised group for the target after this publication. */
  replacementTips = []
} = {}) {
  const writer = clean(ownedWriterSyncPeerId);
  const domain = clean(objectDomain);
  const id = clean(objectId);
  const key = clean(objectKey);
  if (!writer || !domain || !id || !hex64(key)) {
    fail(P02_HEADS_MERGE_ERROR.TARGET_INVALID);
  }
  if (!isPlainObject(baseWriterState)) fail(P02_HEADS_MERGE_ERROR.BASE_INVALID);

  /*
   * Only two base states are publishable. A quarantined or unproven pointer is
   * not a starting point that happens to be empty - it is a repository we
   * cannot describe, and publishing from it would advertise a snapshot built on
   * an unread base.
   */
  const status = clean(baseWriterState.status);
  const firstOwnPublication = status === 'absent';
  if (status !== 'verified' && !firstOwnPublication) {
    fail(P02_HEADS_MERGE_ERROR.BASE_UNPROVEN, status || 'unknown');
  }

  /* An empty replacement would withdraw the target by omission. */
  if (!Array.isArray(replacementTips) || replacementTips.length === 0) {
    fail(P02_HEADS_MERGE_ERROR.REPLACEMENT_EMPTY);
  }

  const targetKey = P02_HEADS_MERGE_V2.groupKey(domain, id);
  const replacement = [];
  for (const tip of replacementTips) {
    if (!isPlainObject(tip)) fail(P02_HEADS_MERGE_ERROR.REPLACEMENT_UNPROVEN);
    /* A retained-unproven tip is evidence, not a head. Advertising one would
     * invite peers to chain onto ancestry we could not establish. */
    if (tip.proven !== true) {
      fail(P02_HEADS_MERGE_ERROR.REPLACEMENT_UNPROVEN, clean(tip.revisionId) || null);
    }
    if (clean(tip.objectDomain) !== domain || clean(tip.objectId) !== id ||
        clean(tip.objectKey) !== key) {
      fail(P02_HEADS_MERGE_ERROR.REPLACEMENT_FOREIGN, clean(tip.objectId) || null);
    }
    if (clean(tip.writerSyncPeerId) !== writer) {
      fail(P02_HEADS_MERGE_ERROR.WRITER_IDENTITY_MISMATCH);
    }
    /*
     * The timestamp must come from durable canonical/source data. A wall clock
     * would make two publications of identical content produce different bytes,
     * which destroys idempotent replay at a content address.
     */
    const sourceUpdatedAtIso = clean(tip.sourceUpdatedAtIso);
    if (!sourceUpdatedAtIso || !Number.isFinite(Date.parse(sourceUpdatedAtIso))) {
      fail(P02_HEADS_MERGE_ERROR.SOURCE_TIMESTAMP_MISSING, clean(tip.revisionId) || null);
    }
    replacement.push(Object.freeze({
      objectDomain: domain,
      objectId: id,
      objectKey: key,
      revisionId: clean(tip.revisionId),
      payloadSha256: clean(tip.payloadSha256),
      revisionBlobSha256: clean(tip.revisionBlobSha256),
      previousRevisionId: tip.previousRevisionId ?? null,
      previousRevisionBlobSha256: tip.previousRevisionBlobSha256 ?? null,
      sourceUpdatedAtIso,
      writerSyncPeerId: writer
    }));
  }

  const baseHeads = firstOwnPublication
    ? []
    : (Array.isArray(baseWriterState.snapshot?.heads) ? baseWriterState.snapshot.heads : []);
  const baseGroupKeys = new Set();
  const carried = [];
  for (const head of baseHeads) {
    const groupKey = P02_HEADS_MERGE_V2.groupKey(
      clean(head?.objectDomain), clean(head?.objectId)
    );
    baseGroupKeys.add(groupKey);
    /* The target's ENTIRE existing group is replaced, not merged into. A
     * partial replacement would leave a tip nobody planned for. */
    if (groupKey === targetKey) continue;
    carried.push(carryHead(head));
  }

  const heads = [...carried, ...replacement];
  const newGroupKeys = new Set(heads.map((head) =>
    P02_HEADS_MERGE_V2.groupKey(head.objectDomain, head.objectId)));

  /*
   * Superset rule. Every group the verified base advertised must still be
   * advertised. This is the structural guard against withdrawal by omission,
   * and it is checked on the PLAN so a violation cannot reach the transport.
   */
  for (const groupKey of baseGroupKeys) {
    if (!newGroupKeys.has(groupKey)) {
      fail(P02_HEADS_MERGE_ERROR.SUPERSET_VIOLATED, groupKey);
    }
  }

  /*
   * The CAS token travels with the plan, taken from the SAME read that supplied
   * the carried groups. null means "the pointer was absent when we looked", not
   * "do not check" - the transport turns it into a create-if-absent precondition.
   */
  const expectedCurrentHeadsSnapshotSha256 = firstOwnPublication
    ? null
    : clean(baseWriterState.pointer?.currentHeadsSnapshotSha256) || null;
  if (!firstOwnPublication && !hex64(expectedCurrentHeadsSnapshotSha256)) {
    fail(P02_HEADS_MERGE_ERROR.CAS_TOKEN_MISSING);
  }

  return Object.freeze({
    schema: P02_HEADS_MERGE_V2.SCHEMA,
    firstOwnPublication,
    targetGroupKey: targetKey,
    heads: Object.freeze(heads),
    replacedTipCount: replacement.length,
    carriedHeadCount: carried.length,
    baseGroupKeys: Object.freeze([...baseGroupKeys].sort()),
    newGroupKeys: Object.freeze([...newGroupKeys].sort()),
    /* Carried groups are covered by the verified base and are NOT re-proven. */
    groupsRequiringCurrentProof: Object.freeze([targetKey]),
    baseHeadsSnapshotSha256: firstOwnPublication
      ? null
      : clean(baseWriterState.snapshot?.headsSnapshotSha256) || null,
    expectedCurrentHeadsSnapshotSha256
  });
}

/*
 * Convenience for the assertion callers actually want to make: did this plan
 * preserve everything it was supposed to, byte for byte?
 */
export function carriedHeadsAreByteStable(plan, baseWriterState) {
  if (!isPlainObject(plan) || !isPlainObject(baseWriterState)) return false;
  const baseHeads = Array.isArray(baseWriterState.snapshot?.heads)
    ? baseWriterState.snapshot.heads : [];
  const expected = baseHeads
    .filter((head) => P02_HEADS_MERGE_V2.groupKey(head.objectDomain, head.objectId)
      !== plan.targetGroupKey)
    .map((head) => JSON.stringify(carryHead(head)))
    .sort();
  const actual = plan.heads
    .filter((head) => P02_HEADS_MERGE_V2.groupKey(head.objectDomain, head.objectId)
      !== plan.targetGroupKey)
    .map((head) => JSON.stringify(carryHead(head)))
    .sort();
  return expected.length === actual.length &&
    expected.every((value, index) => value === actual[index]);
}
