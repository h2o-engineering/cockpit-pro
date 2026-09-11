/*
 * P02 Chrome local-object enumeration (Y-1).
 *
 * The adapter reads the accepted archive authority and Sync IDB reader APIs.
 * It does not open an archive write transaction, Apply, publish, schedule,
 * request folder permission, or mutate chrome.storage/Library state.
 */

import {
  createReadOnlyObjectDescriptor,
  sortReadOnlyObjectDescriptors
} from '../../core/sync-object-classifier-v2.mjs';
import { objectKeyHex, writerKeyHex } from './sync-contract-v2.mjs';
import { createP02AnchorSet } from '../../core/sync-p02-anchor-set-v2.mjs';

export const P02_CHROME_ENUMERATION_SCHEMA =
  'h2o.studio.chromeSyncObjectEnumeration.p02.v1';

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

function plainRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.prototype.toString.call(value) === '[object Object]';
}

function remoteScopeKey({ syncPeerId, objectDomain, objectId }) {
  return `${syncPeerId}\u0000${objectDomain}\u0000${objectId}`;
}

async function normalizeTrustedPeerAdvertisements({
  advertisements,
  peers,
  cryptoImplementation
}) {
  if (!Array.isArray(advertisements)) {
    throw new TypeError('p02-chrome-trusted-peer-advertisements-invalid');
  }
  const configured = new Set(peers);
  const byScope = new Map();
  for (const advertisement of advertisements) {
    if (!plainRecord(advertisement) ||
        !strictIdentifier(advertisement.syncPeerId) ||
        !hash(advertisement.writerKey) ||
        !Array.isArray(advertisement.heads) ||
        !configured.has(advertisement.syncPeerId) ||
        advertisement.writerKey !== await writerKeyHex(
          advertisement.syncPeerId, cryptoImplementation
        )) {
      throw new TypeError('p02-chrome-trusted-peer-advertisement-invalid');
    }
    for (const head of advertisement.heads) {
      if (!plainRecord(head) ||
          head.objectDomain !== CHAT_OBJECT_DOMAIN ||
          !strictIdentifier(head.objectId) ||
          !hash(head.objectKey) ||
          !strictIdentifier(head.revisionId) ||
          !hash(head.revisionBlobSha256) ||
          head.writerSyncPeerId !== advertisement.syncPeerId ||
          head.objectKey !== await objectKeyHex(
            head.objectDomain, head.objectId, cryptoImplementation
          )) {
        throw new TypeError('p02-chrome-trusted-peer-head-invalid');
      }
      const key = remoteScopeKey({
        syncPeerId: advertisement.syncPeerId,
        objectDomain: head.objectDomain,
        objectId: head.objectId
      });
      const scope = byScope.get(key) || {
        syncPeerId: advertisement.syncPeerId,
        objectDomain: head.objectDomain,
        objectId: head.objectId,
        objectKey: head.objectKey,
        tips: new Map()
      };
      if (scope.objectKey !== head.objectKey) {
        throw new TypeError('p02-chrome-trusted-peer-head-conflict');
      }
      const prior = scope.tips.get(head.revisionId);
      if (prior && prior.revisionBlobSha256 !== head.revisionBlobSha256) {
        throw new TypeError('p02-chrome-trusted-peer-head-conflict');
      }
      scope.tips.set(head.revisionId, {
        revisionId: head.revisionId,
        revisionBlobSha256: head.revisionBlobSha256
      });
      byScope.set(key, scope);
    }
  }
  return new Map([...byScope.entries()].map(([key, scope]) => [key, {
    ...scope,
    tips: [...scope.tips.values()].sort((left, right) =>
      left.revisionId.localeCompare(right.revisionId) ||
      left.revisionBlobSha256.localeCompare(right.revisionBlobSha256))
  }]));
}

function reference(value) {
  if (value == null) return null;
  const revisionBlobSha256 = value.revisionBlobSha256 ||
    value.revisionBlobSha256Hex;
  if (!strictIdentifier(value.revisionId) || !hash(revisionBlobSha256)) {
    throw new TypeError('p02-chrome-protocol-state-invalid');
  }
  return { revisionId: value.revisionId, revisionBlobSha256 };
}

/*
 * Convergence has two regimes, and the record says which one applies rather
 * than the comparator inferring it. Chrome mirrors the Desktop rule exactly.
 *
 * With a direction, the row was anchored by identity-amendment machinery which
 * stored the payload identity of that anchor. Payload identity is the only
 * identity shared across representations, so it is the only sound thing to
 * compare; comparing envelope hashes across domains is what left a published
 * object permanently local-ahead.
 *
 * Without a direction the record predates the amendment and is decided by the
 * exact prior id+blob formula, unchanged.
 */
const CHROME_CONVERGED_DIRECTION = Object.freeze({ PUBLISHED: 'published', APPLIED: 'applied' });
const CHROME_SHA256_RE = /^[0-9a-f]{64}$/;

function convergenceVerdict(canonical, identity, lastPublished, lastApplied) {
  const direction = typeof identity.direction === 'string' ? identity.direction : '';
  if (!direction) {
    return Object.freeze({
      dirty: !!canonical &&
        !sameRevision(canonical, lastPublished) &&
        !sameRevision(canonical, lastApplied),
      integrity: false,
      regime: 'legacy'
    });
  }
  const anchorPayload = direction === CHROME_CONVERGED_DIRECTION.PUBLISHED
    ? identity.publishedPayloadSha256
    : direction === CHROME_CONVERGED_DIRECTION.APPLIED
      ? identity.appliedPayloadSha256
      : null;
  /* A direction with no payload beside it, or an unrecognised direction, is a
   * half-written identity: unclassifiable, so it fails closed. */
  if (!CHROME_SHA256_RE.test(anchorPayload || '')) {
    return Object.freeze({ dirty: false, integrity: true, regime: 'p02-corrupt' });
  }
  if (!canonical) return Object.freeze({ dirty: false, integrity: false, regime: 'p02' });
  return Object.freeze({
    dirty: canonical.payloadSha256 !== anchorPayload,
    integrity: false,
    regime: 'p02'
  });
}

function sameRevision(left, right) {
  return !!left && !!right &&
    left.revisionId === right.revisionId &&
    left.revisionBlobSha256 === right.revisionBlobSha256;
}

async function optionalRead(reader, input, fallback) {
  if (typeof reader !== 'function') return fallback;
  const value = await reader(input);
  return value == null ? fallback : value;
}

export function createChromeReadOnlyObjectEnumerator({
  archiveAuthority,
  canonicalProjection,
  syncStore,
  configuredSyncPeerIds,
  trustedPeerAdvertisements = [],
  cryptoImplementation = globalThis.crypto,
  advertisedTipReader = null,
  branchEvidenceReader = null,
  blockStateReader = null
} = {}) {
  if (!archiveAuthority ||
      typeof archiveAuthority.listWorkbenchRows !== 'function' ||
      !canonicalProjection ||
      typeof canonicalProjection.projectCurrent !== 'function' ||
      !syncStore ||
      typeof syncStore.listReadOnlyObjectIds !== 'function' ||
      typeof syncStore.readApplySnapshot !== 'function' ||
      typeof syncStore.readLocalPublicationTip !== 'function' ||
      typeof syncStore.resolveLocalPublicationPending !== 'function' ||
      !Array.isArray(configuredSyncPeerIds) ||
      configuredSyncPeerIds.length === 0 ||
      !configuredSyncPeerIds.every(strictIdentifier)) {
    throw new TypeError('p02-chrome-enumerator-dependency-invalid');
  }
  const peers = [...new Set(configuredSyncPeerIds)].sort();

  async function enumerate() {
    const [rawArchiveRows, rawProtocolObjectIds] = await Promise.all([
      archiveAuthority.listWorkbenchRows(),
      syncStore.listReadOnlyObjectIds()
    ]);
    if (!Array.isArray(rawArchiveRows) || !Array.isArray(rawProtocolObjectIds)) {
      throw new TypeError('p02-chrome-object-discovery-invalid');
    }

    const archiveByObject = new Map();
    const objectIds = new Set();
    const localObjectIds = new Set();
    for (const row of rawArchiveRows) {
      const objectId = clean(row?.chatId || row?.id);
      if (!strictIdentifier(objectId) || archiveByObject.has(objectId)) {
        throw new TypeError('p02-chrome-archive-read-invalid');
      }
      archiveByObject.set(objectId, row);
      objectIds.add(objectId);
      localObjectIds.add(objectId);
    }
    for (const rawObjectId of rawProtocolObjectIds) {
      const objectId = clean(rawObjectId);
      if (!strictIdentifier(objectId)) {
        throw new TypeError('p02-chrome-protocol-read-invalid');
      }
      objectIds.add(objectId);
      localObjectIds.add(objectId);
    }

    const remoteScopes = await normalizeTrustedPeerAdvertisements({
      advertisements: trustedPeerAdvertisements,
      peers,
      cryptoImplementation
    });
    for (const scope of remoteScopes.values()) objectIds.add(scope.objectId);

    const descriptors = [];
    for (const objectId of [...objectIds].sort()) {
      const hasCanonicalArchiveObject = archiveByObject.has(objectId);
      const projection = hasCanonicalArchiveObject
        ? await canonicalProjection.projectCurrent(objectId)
        : null;
      if (projection &&
          (projection.objectId !== objectId ||
            !strictIdentifier(projection.revisionId) ||
            !hash(projection.revisionBlobSha256Hex) ||
            !hash(projection.payloadSha256Hex) ||
            !hash(projection.objectKeyHex))) {
        throw new TypeError('p02-chrome-canonical-projection-invalid');
      }
      const derivedObjectKey = await objectKeyHex(
        CHAT_OBJECT_DOMAIN,
        objectId,
        cryptoImplementation
      );
      const objectKey = projection?.objectKeyHex || derivedObjectKey;
      /* Prefer the convergence reader when the store offers it: it returns the
       * tip together with the direction cell that names which anchor is
       * current. Older stores expose only the tip, which reads as legacy. */
      const [applySnapshot, publication, localPending] = await Promise.all([
        syncStore.readApplySnapshot(objectId),
        typeof syncStore.readLocalPublicationConvergence === 'function'
          ? syncStore.readLocalPublicationConvergence(objectKey)
          : syncStore.readLocalPublicationTip(objectKey).then((tip) => ({
            tip, convergedDirection: null
          })),
        syncStore.resolveLocalPublicationPending(objectKey)
      ]);
      const localTip = publication?.tip ?? null;
      if (!applySnapshot || !Array.isArray(applySnapshot.observations) ||
          !localPending || typeof localPending.state !== 'string') {
        throw new TypeError('p02-chrome-protocol-read-invalid');
      }
      const lastPublished = reference(localTip);
      const lastApplied = reference(applySnapshot.applyState?.lastApplied || null);
      const canonical = projection ? {
        revisionId: projection.revisionId,
        revisionBlobSha256: projection.revisionBlobSha256Hex,
        payloadSha256: projection.payloadSha256Hex,
        deleted: archiveByObject.get(objectId)?.isDeleted === true
      } : null;
      const pending = localPending.state !== 'Clean' ||
        applySnapshot.applyState?.pending != null;

      const isLocalScope = localObjectIds.has(objectId);
      const scopedPeers = isLocalScope
        ? peers
        : peers.filter((syncPeerId) => remoteScopes.has(remoteScopeKey({
          syncPeerId, objectDomain: CHAT_OBJECT_DOMAIN, objectId
        })));
      for (const syncPeerId of scopedPeers) {
        const scope = { objectDomain: CHAT_OBJECT_DOMAIN, objectId, objectKey, syncPeerId };
        const remote = remoteScopes.get(remoteScopeKey(scope)) || null;
        if (remote && remote.objectKey !== objectKey) {
          throw new TypeError('p02-chrome-trusted-peer-object-key-conflict');
        }
        const blockReason = await optionalRead(blockStateReader, scope, null);
        const retainedEvidence = await optionalRead(branchEvidenceReader, scope, []);
        const legacyAdvertisedTips = await optionalRead(advertisedTipReader, scope, []);
        const advertisedTipsByIdentity = new Map();
        for (const tip of [...(remote?.tips || []), ...legacyAdvertisedTips]) {
          if (!plainRecord(tip) || !strictIdentifier(tip.revisionId) ||
              !hash(tip.revisionBlobSha256)) {
            throw new TypeError('p02-chrome-advertised-tip-invalid');
          }
          const prior = advertisedTipsByIdentity.get(tip.revisionId);
          if (prior && prior.revisionBlobSha256 !== tip.revisionBlobSha256) {
            throw new TypeError('p02-chrome-advertised-tip-conflict');
          }
          advertisedTipsByIdentity.set(tip.revisionId, {
            revisionId: tip.revisionId,
            revisionBlobSha256: tip.revisionBlobSha256
          });
        }
        const advertisedTips = [...advertisedTipsByIdentity.values()].sort((left, right) =>
          left.revisionId.localeCompare(right.revisionId) ||
          left.revisionBlobSha256.localeCompare(right.revisionBlobSha256));
        /* The direction is the ledger's; each payload identity is read from the
         * anchor that owns it, never duplicated into the cell. */
        const convergence = convergenceVerdict(canonical, {
          direction: publication?.convergedDirection ?? null,
          publishedPayloadSha256: localTip?.payloadSha256Hex ?? null,
          appliedPayloadSha256: applySnapshot.applyState?.lastApplied?.payloadSha256Hex ?? null
        }, lastPublished, lastApplied);
        const dirty = convergence.dirty;
        const protocolState = {
          lastPublished,
          lastApplied,
          consumedRevisionBlobSha256:
            lastApplied?.revisionBlobSha256 ?? null,
          pendingOperation: applySnapshot.applyState?.pending
            ? 'apply'
            : (localPending.state === 'Clean' ? null : 'publish'),
          pendingApply: applySnapshot.applyState?.pending?.referenceKind ===
              'branch-evidence-v2'
            ? {
              referenceKind: 'branch-evidence-v2',
              revisionId: applySnapshot.applyState.pending.revisionId,
              revisionBlobSha256:
                applySnapshot.applyState.pending.revisionBlobSha256Hex,
              selectedLeafRevisionId:
                applySnapshot.applyState.pending.selectedLeafRevisionId,
              selectedLeafRevisionBlobSha256:
                applySnapshot.applyState.pending.selectedLeafRevisionBlobSha256Hex
            }
            : null,
          operationPhase: localPending.state === 'Clean'
            ? null
            : localPending.state,
          retainedObservationRevisionIds: applySnapshot.observations
            .map((observation) => observation.revisionId)
        };
        /* A direction is the existing proof that these columns are P02
         * envelope anchors. Without it they remain legacy references and are
         * deliberately not promoted into the typed anchor set. */
        const anchorProtocolState = {
          ...protocolState,
          lastPublished: lastPublished && localTip?.payloadSha256Hex
            ? { ...lastPublished, payloadSha256: localTip.payloadSha256Hex }
            : lastPublished,
          lastApplied: lastApplied &&
              applySnapshot.applyState?.lastApplied?.payloadSha256Hex
            ? {
              ...lastApplied,
              payloadSha256:
                applySnapshot.applyState.lastApplied.payloadSha256Hex
            }
            : lastApplied
        };
        const p02AnchorSet = publication?.convergedDirection
          ? createP02AnchorSet({
            objectDomain: CHAT_OBJECT_DOMAIN,
            objectId,
            protocolState: anchorProtocolState
          })
          : (remote !== null || retainedEvidence.length > 0
            ? createP02AnchorSet({
            objectDomain: CHAT_OBJECT_DOMAIN,
            objectId,
            protocolState: {}
            })
            : null);
        descriptors.push(createReadOnlyObjectDescriptor({
          ...scope,
          canonicalLocalHead: canonical,
          protocolState,
          p02AnchorSet,
          retainedEvidence,
          advertisedTips,
          trustedPeerAdvertisementPending: remote !== null,
          dirty,
          /* A half-written identity is unclassifiable, so it is surfaced as an
           * integrity state and can never be published, exactly as on Desktop. */
          integrityQuarantined: convergence.integrity,
          publishable: dirty && !pending && blockReason === null &&
            !convergence.integrity,
          pending,
          blockReason
        }));
      }
    }

    return Object.freeze({
      schema: P02_CHROME_ENUMERATION_SCHEMA,
      platform: 'chrome-mv3',
      descriptors: sortReadOnlyObjectDescriptors(descriptors),
      conformanceBoundary: Object.freeze({
        branchEvidence: branchEvidenceReader
          ? 'read-only-v2-evidence-reader'
          : 'p02-chrome-branch-store-deferred-to-z6',
        advertisedTips: advertisedTipReader
          ? 'read-only-advertised-tip-reader+trusted-peer-advertisement'
          : 'trusted-peer-advertisement'
      })
    });
  }

  return Object.freeze({ enumerate });
}
