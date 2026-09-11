/*
 * P02 Desktop local-object enumeration (Y-1).
 *
 * This inactive Wave-1 seam accepts only injected read authorities. It issues
 * SELECT statements and calls the accepted canonical projection reader; it
 * has no execute, Apply, publication, transport, migration, or UI capability.
 */

import {
  createReadOnlyObjectDescriptor,
  sortReadOnlyObjectDescriptors
} from '../core/sync-object-classifier-v2.mjs';

export const P02_DESKTOP_ENUMERATION_SCHEMA =
  'h2o.studio.desktopSyncObjectEnumeration.p02.v1';

export const P02_DESKTOP_READ_QUERIES = Object.freeze({
  CONTENT: `SELECT
    id AS object_id,
    last_snapshot_id AS canonical_revision_id,
    updated_at AS canonical_updated_at,
    is_deleted AS canonical_deleted
  FROM chats
  ORDER BY id`,
  PROTOCOL: `SELECT
    sync_peer_id,
    object_id,
    last_published_revision_id,
    last_published_revision_blob_sha256,
    last_applied_revision_id,
    last_applied_revision_blob_sha256,
    consumed_revision_blob_sha256,
    pending_operation,
    operation_phase,
    last_conflict_class,
    last_error_code,
    last_published_payload_sha256,
    last_applied_payload_sha256,
    last_converged_direction
  FROM sync_object_state
  ORDER BY sync_peer_id, object_id`,
  OBSERVATIONS: `SELECT
    object_id,
    revision_id,
    parent_revision_id,
    revision_blob_sha256_hex,
    payload_sha256_hex,
    admission_disposition,
    apply_state
  FROM sync_inbound_revision_observations
  ORDER BY object_id, revision_id`
});

const CHAT_OBJECT_DOMAIN = 'studio.chat.saved-state.v1';
const SHA256_RE = /^[0-9a-f]{64}$/;

function clean(value) {
  return String(value == null ? '' : value).trim();
}

function strictIdentifier(value) {
  return typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 512 &&
    value.trim() === value &&
    !/[\u0000-\u001f\u007f]/.test(value);
}

function hash(value) {
  return typeof value === 'string' && SHA256_RE.test(value);
}

function reference(revisionId, revisionBlobSha256) {
  if (revisionId == null && revisionBlobSha256 == null) return null;
  if (!strictIdentifier(revisionId) || !hash(revisionBlobSha256)) {
    throw new TypeError('p02-desktop-protocol-state-invalid');
  }
  return { revisionId, revisionBlobSha256 };
}

function blockReasonFromError(errorCode) {
  const value = clean(errorCode).toLowerCase();
  if (!value) return null;
  for (const reason of ['capacity', 'permission', 'asset', 'format', 'transport']) {
    if (value.includes(reason)) return reason;
  }
  return null;
}

/*
 * Exact recognized durable integrity/conflict error codes. Membership is typed:
 * a code blocks because it is listed, never because its text happens to contain
 * a word. Broad substring matching is what let
 * `local-revision-identity-conflict` slip through as publishable.
 */
export const P02_DESKTOP_INTEGRITY_ERROR_CODES = Object.freeze([
  'local-revision-identity-conflict',
  'local-publication-revision-identity-conflict',
  'p02-branch-evidence-identity-conflict',
  'p02-z4-object-identity-conflict',
  'integrity-conflict'
]);

/* Reason reported for a canonical object that cannot currently be projected. */
export const P02_DESKTOP_BLOCKED_REASON = Object.freeze({
  PROJECTION_UNAVAILABLE: 'canonical-projection-unavailable'
});

/*
 * Durable integrity state, normalized for the generic work authority.
 *
 * `last_error_code` is matched by exact membership. `last_conflict_class` is a
 * column whose entire purpose is to record that the last operation ended in a
 * conflict, so any non-empty value counts - presence on a typed column, not
 * text matching. Either one leaves the object integrity-quarantined and thus
 * never publishable, whatever its identity.
 */
export function isDurableIntegrityState({ lastErrorCode, lastConflictClass } = {}) {
  if (clean(lastConflictClass) !== '') return true;
  return P02_DESKTOP_INTEGRITY_ERROR_CODES.includes(clean(lastErrorCode));
}

/*
 * Convergence has two regimes, and which one applies is recorded in the row
 * itself rather than inferred.
 *
 * A row carrying a direction was anchored by identity-amendment machinery,
 * which stored the payload identity of that anchor alongside it. Payload
 * identity is the only identity shared across representations - the canonical
 * projection, the published v2 envelope and the applied transport envelope all
 * embed the same payload hash - so it is the only sound thing to compare.
 * Comparing envelope hashes across those domains is precisely what left a
 * successfully published object permanently `local-ahead`.
 *
 * A row without a direction predates the amendment and is decided by the exact
 * legacy formula, unchanged: for P01 both sides genuinely are the same
 * representation, and that decision is already accepted.
 */
const P02_CONVERGED_DIRECTION = Object.freeze({ PUBLISHED: 'published', APPLIED: 'applied' });

function convergenceVerdict(canonical, state, lastPublished, lastApplied) {
  const direction = clean(state.last_converged_direction);
  if (!direction) {
    return Object.freeze({
      dirty: !!canonical &&
        !sameRevision(canonical, lastPublished) &&
        !sameRevision(canonical, lastApplied),
      integrity: false,
      regime: 'legacy'
    });
  }
  const anchorPayload = direction === P02_CONVERGED_DIRECTION.PUBLISHED
    ? clean(state.last_published_payload_sha256)
    : direction === P02_CONVERGED_DIRECTION.APPLIED
      ? clean(state.last_applied_payload_sha256)
      : '';
  /* A direction with no payload beside it, or an unrecognised direction, is a
   * half-written identity: not "probably converged", not "probably dirty", but
   * unclassifiable. It fails closed as an integrity state. */
  if (!SHA256_RE.test(anchorPayload)) {
    return Object.freeze({ dirty: false, integrity: true, regime: 'p02-corrupt' });
  }
  if (!canonical) return Object.freeze({ dirty: false, integrity: false, regime: 'p02' });
  return Object.freeze({
    dirty: clean(canonical.payloadSha256) !== anchorPayload,
    integrity: false,
    regime: 'p02'
  });
}

function sameRevision(left, right) {
  return !!left && !!right &&
    left.revisionId === right.revisionId &&
    left.revisionBlobSha256 === right.revisionBlobSha256;
}

function asRows(value, code) {
  if (!Array.isArray(value)) throw new TypeError(code);
  return value;
}

async function optionalRead(reader, input, fallback) {
  if (typeof reader !== 'function') return fallback;
  const value = await reader(input);
  return value == null ? fallback : value;
}

export function createDesktopReadOnlyObjectEnumerator({
  sql,
  projection,
  configuredSyncPeerIds,
  advertisedTipReader = null,
  branchEvidenceReader = null,
  blockStateReader = null
} = {}) {
  if (!sql || typeof sql.select !== 'function' ||
      !projection || typeof projection.projectObject !== 'function' ||
      typeof projection.objectKeyHex !== 'function' ||
      !Array.isArray(configuredSyncPeerIds) ||
      configuredSyncPeerIds.length === 0 ||
      !configuredSyncPeerIds.every(strictIdentifier)) {
    throw new TypeError('p02-desktop-enumerator-dependency-invalid');
  }
  const peers = [...new Set(configuredSyncPeerIds)].sort();

  async function enumerate() {
    const [contentRows, protocolRows, observationRows] = await Promise.all([
      sql.select(P02_DESKTOP_READ_QUERIES.CONTENT, []),
      sql.select(P02_DESKTOP_READ_QUERIES.PROTOCOL, []),
      sql.select(P02_DESKTOP_READ_QUERIES.OBSERVATIONS, [])
    ]);
    const content = asRows(contentRows, 'p02-desktop-content-read-invalid');
    const protocol = asRows(protocolRows, 'p02-desktop-protocol-read-invalid');
    const observations = asRows(
      observationRows,
      'p02-desktop-observation-read-invalid'
    );

    const contentByObject = new Map();
    const objectIds = new Set();
    for (const row of content) {
      const objectId = clean(row?.object_id);
      if (!strictIdentifier(objectId) || contentByObject.has(objectId)) {
        throw new TypeError('p02-desktop-content-read-invalid');
      }
      contentByObject.set(objectId, row);
      objectIds.add(objectId);
    }

    const protocolByScope = new Map();
    for (const row of protocol) {
      const syncPeerId = clean(row?.sync_peer_id);
      const objectId = clean(row?.object_id);
      if (!peers.includes(syncPeerId)) continue;
      const key = `${syncPeerId}\u0000${objectId}`;
      if (!strictIdentifier(objectId) || protocolByScope.has(key)) {
        throw new TypeError('p02-desktop-protocol-read-invalid');
      }
      protocolByScope.set(key, row);
      objectIds.add(objectId);
    }

    const observationsByObject = new Map();
    for (const row of observations) {
      const objectId = clean(row?.object_id);
      const revisionId = clean(row?.revision_id);
      if (!strictIdentifier(objectId) || !strictIdentifier(revisionId)) {
        throw new TypeError('p02-desktop-observation-read-invalid');
      }
      const values = observationsByObject.get(objectId) || [];
      values.push(revisionId);
      observationsByObject.set(objectId, values);
      objectIds.add(objectId);
    }

    /*
     * Projection failure is isolated per object. One canonical object that
     * cannot produce a valid revision identity must not terminate enumeration
     * of every other object, and must never be given a synthesized identity:
     * it is reported as a blocked entry instead, so it stays visible in
     * read-only diagnostics while remaining impossible to publish.
     */
    const projectionByObject = new Map();
    const blockedObjects = [];
    for (const objectId of [...contentByObject.keys()].sort()) {
      let value = null;
      let failure = null;
      try {
        value = await projection.projectObject(objectId);
      } catch (error) {
        failure = clean(error?.code || error?.message) || 'projection-threw';
      }
      const usable = !failure && !!value && value.objectId === objectId &&
        strictIdentifier(value.revisionId) &&
        hash(value.revisionBlobSha256Hex) &&
        hash(value.payloadSha256Hex) &&
        hash(value.objectKeyHex);
      if (usable) {
        projectionByObject.set(objectId, value);
        continue;
      }
      blockedObjects.push(Object.freeze({
        objectDomain: CHAT_OBJECT_DOMAIN,
        objectId,
        reason: P02_DESKTOP_BLOCKED_REASON.PROJECTION_UNAVAILABLE,
        detail: failure || (value ? 'projection-incomplete' : 'projection-absent'),
        publishable: false,
        eligible: false
      }));
      objectIds.delete(objectId);
    }

    const descriptors = [];
    for (const objectId of [...objectIds].sort()) {
      const canonicalProjection = projectionByObject.get(objectId) || null;
      const objectKey = canonicalProjection
        ? canonicalProjection.objectKeyHex
        : await projection.objectKeyHex(objectId);
      if (!hash(objectKey)) {
        throw new TypeError('p02-desktop-object-key-invalid');
      }
      for (const syncPeerId of peers) {
        const scope = { objectDomain: CHAT_OBJECT_DOMAIN, objectId, objectKey, syncPeerId };
        const state = protocolByScope.get(`${syncPeerId}\u0000${objectId}`) || {};
        const lastPublished = reference(
          state.last_published_revision_id,
          state.last_published_revision_blob_sha256
        );
        const lastApplied = reference(
          state.last_applied_revision_id,
          state.last_applied_revision_blob_sha256
        );
        const canonical = canonicalProjection ? {
          revisionId: canonicalProjection.revisionId,
          revisionBlobSha256: canonicalProjection.revisionBlobSha256Hex,
          payloadSha256: canonicalProjection.payloadSha256Hex,
          deleted: Number(contentByObject.get(objectId)?.canonical_deleted) === 1
        } : null;
        const pending = clean(state.pending_operation) !== '';
        const externallyBlocked = await optionalRead(blockStateReader, scope, null);
        const blockReason = externallyBlocked || blockReasonFromError(state.last_error_code);
        const convergence = convergenceVerdict(canonical, state, lastPublished, lastApplied);
        const dirty = convergence.dirty;
        const integrityQuarantined = isDurableIntegrityState({
          lastErrorCode: state.last_error_code,
          lastConflictClass: state.last_conflict_class
        }) || convergence.integrity;
        const retainedEvidence = await optionalRead(branchEvidenceReader, scope, []);
        const advertisedTips = await optionalRead(advertisedTipReader, scope, []);
        descriptors.push(createReadOnlyObjectDescriptor({
          ...scope,
          canonicalLocalHead: canonical,
          protocolState: {
            lastPublished,
            lastApplied,
            consumedRevisionBlobSha256:
              state.consumed_revision_blob_sha256 ?? null,
            pendingOperation: state.pending_operation ?? null,
            operationPhase: state.operation_phase ?? null,
            retainedObservationRevisionIds:
              observationsByObject.get(objectId) || []
          },
          retainedEvidence,
          advertisedTips,
          dirty,
          publishable: dirty && !pending && blockReason === null && !integrityQuarantined,
          pending,
          blockReason,
          integrityQuarantined
        }));
      }
    }

    return Object.freeze({
      schema: P02_DESKTOP_ENUMERATION_SCHEMA,
      platform: 'desktop-tauri',
      descriptors: sortReadOnlyObjectDescriptors(descriptors),
      blockedObjects: Object.freeze([...blockedObjects].sort((left, right) =>
        left.objectId.localeCompare(right.objectId))),
      conformanceBoundary: Object.freeze({
        branchEvidence: branchEvidenceReader
          ? 'read-only-v2-evidence-reader'
          : 'p02-desktop-branch-store-deferred-to-z6',
        advertisedTips: advertisedTipReader
          ? 'read-only-advertised-tip-reader'
          : 'p02-advertised-tip-store-not-active'
      })
    });
  }

  return Object.freeze({ enumerate });
}
