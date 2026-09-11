/*
 * P02 Wave 1 / Z2 deterministic proof chassis.
 *
 * Boundary: this is an isolated, disposable future-contract adapter. It uses
 * the real accepted reconcileOneObject() transition core and the real Z1 v2
 * contract validator, but it does not implement or mutate the future Chrome
 * IDB/Desktop SQLite branch stores, production scheduler, or live transport.
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import vm from 'node:vm';
import {
  P02_SYNC_CONTRACT_V2,
  objectKeyHex,
  serializeContractDocument,
  validateContractDocument
} from '../../../../packages/browser-adapters/chrome/sync-contract-v2.mjs';
import {
  classifyObjectState
} from '../../../../packages/core/sync-object-classifier-v2.mjs';
import {
  buildWriterHeadsSnapshot
} from '../../../../packages/browser-adapters/chrome/sync-writer-transport-v2.mjs';
import {
  P02ObjectScheduler,
  P02_RUNNABILITY
} from '../../../../packages/core/sync-object-scheduler-v2.mjs';

const reconcileSource = fs.readFileSync(new URL(
  '../../../../src-surfaces-base/studio/sync/sync-linear-reconcile-core.js',
  import.meta.url
), 'utf8');
const coreContext = { console };
coreContext.globalThis = coreContext;
vm.createContext(coreContext);
vm.runInContext(reconcileSource, coreContext, {
  filename: 'sync-linear-reconcile-core.js'
});
const { reconcileOneObject } = coreContext.H2OSyncLinearReconcileCore;

export const INVARIANT = Object.freeze({
  IMMUTABLE_EVIDENCE: 'Z2-I01',
  REPLAY_IDEMPOTENT: 'Z2-I02',
  APPLY_REQUIRES_PROOF: 'Z2-I03',
  CANONICAL_APPLY_NEVER_REGRESSES: 'Z2-I04',
  MISSING_ANCESTRY_NOT_DELETION: 'Z2-I05',
  SUPERSESSION_NOT_DELETION: 'Z2-I06',
  SELECTED_REFERENCE_NOT_AUTHORITY: 'Z2-I07',
  REMOTE_APPLY_NO_SELF_ECHO: 'Z2-I08',
  REFERENCE_REQUIRES_IMMUTABLE: 'Z2-I09',
  RESTART_FABRICATES_NOTHING: 'Z2-I10',
  OBJECT_ISOLATION: 'Z2-I11',
  BLOCKED_OBJECT_DOES_NOT_STARVE: 'Z2-I12',
  MANUAL_IS_NON_MUTATING: 'Z2-I13',
  CLASSIFICATION_DETERMINISTIC: 'Z2-I14',
  DUPLICATE_WAKE_NO_DUPLICATE_EFFECT: 'Z2-I15'
});

export class HarnessInvariantError extends Error {
  constructor(invariant, detail = '') {
    super(detail ? `${invariant}:${detail}` : invariant);
    this.name = 'HarnessInvariantError';
    this.invariant = invariant;
  }
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const clone = (value) => structuredClone(value);
const sortedValues = (object) => Object.keys(object).sort().map((key) => object[key]);
const evidenceKey = (peerId, objectId) => `${peerId}\u0000${objectId}`;

function failInvariant(invariant, detail) {
  throw new HarnessInvariantError(invariant, detail);
}

function emptyTransport() {
  return {
    revisionBlobs: {},
    corruptRevisionBlobs: {},
    delayedRevisionBlobs: {},
    snapshots: {},
    pointers: {},
    advertisedByWriter: {},
    commitLog: []
  };
}

function emptyObjectState(descriptor) {
  return {
    descriptor: clone(descriptor),
    evidence: {},
    quarantined: [],
    canonical: null,
    canonicalHistory: [],
    appliedReceipts: {},
    effectCounts: {},
    remoteApplyAudit: {},
    consumedRemoteBlobSha256: null,
    publishedBlobSha256: {},
    capacityBlocked: false,
    blockReason: null,
    refusedAtCapacity: [],
    manualEffectBaseline: null,
    syntheticContinuousEligibility: false
  };
}

function emptyPeer(peerId, configuredPeers) {
  return {
    peerId,
    configuredPeers: [...configuredPeers],
    authorityMode: 'auto',
    objects: {}
  };
}

function totalEffects(state) {
  return Object.values(state.effectCounts).reduce((sum, count) => sum + count, 0);
}

function isClosure(document) {
  return document.closureType === 'branch-superseded' ||
    document.closureType === 'object-deleted';
}

function isContent(document) {
  return !isClosure(document);
}

function tipFor(record) {
  return {
    revisionId: record.document.revisionId,
    payloadSha256: record.document.payloadSha256,
    revisionBlobSha256: record.blobSha256,
    previousRevisionId: record.document.previousRevisionId,
    previousRevisionBlobSha256: record.document.previousRevisionBlobSha256,
    sourceUpdatedAtIso: record.sourceUpdatedAtIso
  };
}

function recordForEvidence(evidence) {
  return {
    document: clone(evidence.document),
    blobSha256: evidence.blobSha256,
    canonicalBytes: evidence.canonicalBytes,
    objectKey: evidence.objectKey,
    sourceUpdatedAtIso: evidence.sourceUpdatedAtIso
  };
}

export async function makeRevision({
  objectDomain = 'studio.test.multi-object.v1',
  objectId,
  revisionId,
  writerSyncPeerId,
  parent = null,
  payloadValue = revisionId,
  closureType = null,
  selectedRevision = null,
  sourceUpdatedAtIso = '2026-08-24T00:00:00.000Z'
}) {
  const payload = closureType
    ? { schema: P02_SYNC_CONTRACT_V2.SCHEMA.CLOSURE_PAYLOAD }
    : { schema: 'h2o.studio.syncHarnessPayload.v1', value: payloadValue };
  const payloadBytes = encoder.encode(JSON.stringify(
    Object.fromEntries(Object.entries(payload).sort(([left], [right]) =>
      left.localeCompare(right)))
  ));
  const value = {
    schema: P02_SYNC_CONTRACT_V2.SCHEMA.REVISION,
    objectDomain,
    objectId,
    revisionId,
    previousRevisionId: parent?.document.revisionId ?? null,
    previousRevisionBlobSha256: parent?.blobSha256 ?? null,
    payloadSha256: sha256(payloadBytes),
    writerSyncPeerId,
    payload
  };
  if (closureType) value.closureType = closureType;
  if (closureType === 'branch-superseded') {
    assert.ok(selectedRevision, 'branch-superseded requires selected revision');
    value.selectedRevision = {
      revisionId: selectedRevision.document.revisionId,
      revisionBlobSha256: selectedRevision.blobSha256
    };
  }
  const serialized = await serializeContractDocument({
    kind: P02_SYNC_CONTRACT_V2.DOCUMENT_KIND.REVISION,
    value,
    cryptoImplementation: crypto.webcrypto
  });
  return Object.freeze({
    document: clone(serialized.value),
    bytes: new Uint8Array(serialized.bytes),
    canonicalBytes: decoder.decode(serialized.bytes),
    blobSha256: serialized.blobSha256,
    objectKey: await objectKeyHex(objectDomain, objectId, crypto.webcrypto),
    sourceUpdatedAtIso
  });
}

function deriveIndex(state) {
  const evidence = sortedValues(state.evidence);
  const byRevision = Object.fromEntries(evidence.map((item) => [item.revisionId, item]));
  const proven = new Set();
  let changed = true;
  while (changed) {
    changed = false;
    for (const item of evidence) {
      if (proven.has(item.revisionId)) continue;
      const parentId = item.document.previousRevisionId;
      const parentBlob = item.document.previousRevisionBlobSha256;
      if (parentId === null && parentBlob === null) {
        proven.add(item.revisionId);
        changed = true;
        continue;
      }
      const parent = byRevision[parentId];
      if (parent && proven.has(parentId) && parent.blobSha256 === parentBlob) {
        proven.add(item.revisionId);
        changed = true;
      }
    }
  }

  const children = {};
  for (const item of evidence) children[item.revisionId] = [];
  for (const item of evidence) {
    const parentId = item.document.previousRevisionId;
    if (parentId && children[parentId]) children[parentId].push(item.revisionId);
  }
  for (const values of Object.values(children)) values.sort();

  const nodes = evidence.map((item) => {
    let disposition;
    if (!proven.has(item.revisionId)) {
      disposition = 'retained-unproven-parent';
    } else if (isClosure(item.document)) {
      disposition = 'admitted-closure';
    } else {
      const parentId = item.document.previousRevisionId;
      const contentSiblings = parentId
        ? (children[parentId] || []).filter((revisionId) =>
          isContent(byRevision[revisionId].document))
        : [];
      disposition = contentSiblings.length > 1
        ? 'retained-divergent'
        : 'accepted-linear';
    }
    return {
      revisionId: item.revisionId,
      blobSha256: item.blobSha256,
      document: item.document,
      sourceWriter: item.sourceWriter,
      proven: proven.has(item.revisionId),
      validated: item.validated,
      disposition,
      children: children[item.revisionId] || []
    };
  });
  return {
    nodes,
    byRevision: Object.fromEntries(nodes.map((node) => [node.revisionId, node])),
    provenRevisionIds: [...proven].sort()
  };
}

function classifyObject(state, faults = {}) {
  const index = deriveIndex(state);
  const unproven = index.nodes.filter((node) => !node.proven);
  if (faults.missingMeansDeleted && unproven.length > 0) {
    return { classification: 'object-deleted', reason: 'fault-missing-means-deleted' };
  }
  const canonical = state.canonical ? {
    revisionId: state.canonical.revisionId,
    revisionBlobSha256: state.canonical.blobSha256,
    deleted: state.canonical.deleted === true
  } : null;
  const dirty = !!canonical &&
    state.publishedBlobSha256[canonical.revisionBlobSha256] !== true &&
    state.consumedRemoteBlobSha256 !== canonical.revisionBlobSha256;
  return classifyObjectState({
    canonicalLocalHead: canonical,
    retainedEvidence: sortedValues(state.evidence).map((evidence) => ({
      document: evidence.document,
      revisionBlobSha256: evidence.blobSha256,
      validated: evidence.validated === true
    })),
    advertisedTips: [],
    dirty,
    publishable: dirty,
    blockReason: state.capacityBlocked ? 'capacity' : state.blockReason,
    integrityQuarantined: state.quarantined.length > 0
  });
}

export class DeterministicMultiObjectWorld {
  constructor({
    peerIds = ['harness-peer-a', 'harness-peer-b'],
    durable = null,
    faults = {}
  } = {}) {
    this.faults = { ...faults };
    this.durable = durable ? clone(durable) : {
      peers: {},
      transport: emptyTransport()
    };
    if (!durable) {
      for (const peerId of peerIds) {
        this.durable.peers[peerId] = emptyPeer(
          peerId,
          peerIds.filter((candidate) => candidate !== peerId)
        );
      }
    }
    this.rebuildable = {
      branchIndexes: {},
      schedulerCursor: {},
      schedulerTrace: [],
      schedulers: {},
      clockMs: 0
    };
    this.rebuildAllIndexes();
  }

  rebuildAllIndexes() {
    this.rebuildable.branchIndexes = {};
    for (const peer of Object.values(this.durable.peers)) {
      for (const state of Object.values(peer.objects)) {
        this.rebuildable.branchIndexes[evidenceKey(peer.peerId, state.descriptor.objectId)] =
          deriveIndex(state);
      }
    }
  }

  peer(peerId) {
    const peer = this.durable.peers[peerId];
    assert.ok(peer, `unknown peer ${peerId}`);
    return peer;
  }

  object(peerId, objectId) {
    const state = this.peer(peerId).objects[objectId];
    assert.ok(state, `unknown object ${peerId}/${objectId}`);
    return state;
  }

  async addObject(peerId, {
    objectDomain = 'studio.test.multi-object.v1',
    objectId
  }) {
    const peer = this.peer(peerId);
    if (!peer.objects[objectId]) {
      peer.objects[objectId] = emptyObjectState({
        objectDomain,
        objectId,
        objectKey: await objectKeyHex(objectDomain, objectId, crypto.webcrypto)
      });
    }
    return clone(peer.objects[objectId].descriptor);
  }

  setAuthorityMode(peerId, mode) {
    assert.ok(['auto', 'manual', 'notify'].includes(mode));
    const peer = this.peer(peerId);
    peer.authorityMode = mode;
    for (const state of Object.values(peer.objects)) {
      state.manualEffectBaseline = mode === 'auto' ? null : totalEffects(state);
    }
  }

  setCapacityBlocked(peerId, objectId, blocked = true) {
    this.object(peerId, objectId).capacityBlocked = blocked;
  }

  governedSyntheticCapacityRelief(peerId, objectId) {
    // Harness-only theoretical V9 recovery hook. It changes no limit and
    // deletes no evidence; production policy remains unresolved.
    this.object(peerId, objectId).capacityBlocked = false;
  }

  setBlockReason(peerId, objectId, reason) {
    this.object(peerId, objectId).blockReason = reason;
  }

  setSyntheticContinuousEligibility(peerId, objectId, enabled = true) {
    this.object(peerId, objectId).syntheticContinuousEligibility = enabled;
  }

  async admitRevision(peerId, objectId, record, { sourceWriter = 'remote-peer' } = {}) {
    const state = this.object(peerId, objectId);
    if (state.capacityBlocked) {
      state.refusedAtCapacity.push(record.blobSha256);
      return Object.freeze({
        ok: false,
        verdict: 'blocked(capacity)',
        admitted: false,
        blobSha256: record.blobSha256
      });
    }
    let validated;
    try {
      validated = await validateContractDocument({
        kind: P02_SYNC_CONTRACT_V2.DOCUMENT_KIND.REVISION,
        bytes: record.bytes || encoder.encode(record.canonicalBytes),
        expectedBlobSha256: record.blobSha256,
        cryptoImplementation: crypto.webcrypto
      });
    } catch (error) {
      state.quarantined.push({
        blobSha256: record.blobSha256,
        rejectionClass: error?.code || 'p02-z1-schema-invalid'
      });
      return Object.freeze({
        ok: false,
        verdict: 'quarantined',
        admitted: false,
        errorCode: error?.code || 'p02-z1-schema-invalid'
      });
    }
    const document = validated.value;
    if (document.objectDomain !== state.descriptor.objectDomain ||
        document.objectId !== state.descriptor.objectId ||
        record.objectKey !== state.descriptor.objectKey) {
      state.quarantined.push({
        blobSha256: record.blobSha256,
        rejectionClass: 'p02-z2-object-scope-mismatch'
      });
      return Object.freeze({ ok: false, verdict: 'quarantined', admitted: false });
    }
    const canonicalBytes = record.canonicalBytes || decoder.decode(record.bytes);
    const existing = state.evidence[document.revisionId];
    if (existing) {
      if (existing.blobSha256 !== record.blobSha256 ||
          existing.canonicalBytes !== canonicalBytes) {
        failInvariant(INVARIANT.IMMUTABLE_EVIDENCE, document.revisionId);
      }
      return Object.freeze({
        ok: true,
        verdict: 'identical-replay',
        admitted: true,
        unchangedNoOp: true,
        disposition: deriveIndex(state).byRevision[document.revisionId].disposition
      });
    }
    state.evidence[document.revisionId] = {
      revisionId: document.revisionId,
      blobSha256: record.blobSha256,
      canonicalBytes,
      originalCanonicalBytes: canonicalBytes,
      objectKey: record.objectKey,
      document: clone(document),
      sourceWriter,
      sourceUpdatedAtIso: record.sourceUpdatedAtIso || '2026-08-24T00:00:00.000Z',
      validated: true
    };
    const index = deriveIndex(state);
    this.rebuildable.branchIndexes[evidenceKey(peerId, objectId)] = index;
    return Object.freeze({
      ok: true,
      verdict: 'evidence-retained',
      admitted: true,
      unchangedNoOp: false,
      disposition: index.byRevision[document.revisionId].disposition
    });
  }

  async seedCanonical(peerId, objectId, record, { published = false } = {}) {
    const admitted = await this.admitRevision(peerId, objectId, record, {
      sourceWriter: peerId
    });
    assert.equal(admitted.admitted, true);
    const state = this.object(peerId, objectId);
    state.canonical = {
      revisionId: record.document.revisionId,
      blobSha256: record.blobSha256,
      deleted: false
    };
    state.canonicalHistory.push({
      revisionId: record.document.revisionId,
      blobSha256: record.blobSha256,
      kind: 'seed'
    });
    if (published) state.publishedBlobSha256[record.blobSha256] = true;
  }

  classify(peerId, objectId) {
    return clone(classifyObject(this.object(peerId, objectId), this.faults));
  }

  async publishRecords(writerSyncPeerId, records, {
    referenceBeforeImmutable = false
  } = {}) {
    const transport = this.durable.transport;
    transport.advertisedByWriter[writerSyncPeerId] ||= {};
    const groupedRecords = new Map();
    for (const record of records) {
      const group = groupedRecords.get(record.objectKey) || [];
      group.push(record);
      groupedRecords.set(record.objectKey, group);
    }
    for (const [objectKey, group] of groupedRecords.entries()) {
      const [first] = group;
      transport.advertisedByWriter[writerSyncPeerId][objectKey] = {
        objectDomain: first.document.objectDomain,
        objectId: first.document.objectId,
        objectKey,
        headSchema: P02_SYNC_CONTRACT_V2.SCHEMA.HEAD,
        tips: group.map((record) => tipFor(record))
          .sort((left, right) => left.revisionId.localeCompare(right.revisionId))
      };
    }

    const writeImmutables = () => {
      for (const record of records) {
        const existing = transport.revisionBlobs[record.blobSha256];
        if (existing !== undefined && existing !== record.canonicalBytes) {
          failInvariant(INVARIANT.IMMUTABLE_EVIDENCE, record.blobSha256);
        }
        transport.revisionBlobs[record.blobSha256] = record.canonicalBytes;
        transport.commitLog.push(`immutable:${record.blobSha256}`);
      }
    };

    if (!referenceBeforeImmutable) writeImmutables();
    const snapshot = await buildWriterHeadsSnapshot({
      writerSyncPeerId,
      heads: Object.values(transport.advertisedByWriter[writerSyncPeerId])
        .flatMap((group) => group.tips.map((tip) => ({
          schema: group.headSchema,
          objectDomain: group.objectDomain,
          objectId: group.objectId,
          objectKey: group.objectKey,
          writerSyncPeerId,
          ...clone(tip)
        }))),
      cryptoImplementation: crypto.webcrypto
    });
    transport.snapshots[snapshot.headsSnapshotSha256] = decoder.decode(snapshot.bytes);
    transport.commitLog.push(`snapshot:${snapshot.headsSnapshotSha256}`);
    const pointer = await serializeContractDocument({
      kind: P02_SYNC_CONTRACT_V2.DOCUMENT_KIND.WRITER_STATE,
      value: {
        schema: P02_SYNC_CONTRACT_V2.SCHEMA.WRITER_STATE,
        writerSyncPeerId,
        currentHeadsSnapshotSha256: snapshot.headsSnapshotSha256
      },
      cryptoImplementation: crypto.webcrypto
    });
    transport.pointers[writerSyncPeerId] = {
      blobSha256: pointer.blobSha256,
      canonicalBytes: decoder.decode(pointer.bytes),
      currentHeadsSnapshotSha256: snapshot.headsSnapshotSha256
    };
    transport.commitLog.push(`pointer:${pointer.blobSha256}`);
    if (referenceBeforeImmutable) {
      // Deliberately leave the reference dangling for anti-degeneracy/Spike-3 A.
      return {
        snapshotSha256: snapshot.headsSnapshotSha256,
        pointerSha256: pointer.blobSha256
      };
    }
    return {
      snapshotSha256: snapshot.headsSnapshotSha256,
      pointerSha256: pointer.blobSha256
    };
  }

  delayRevisionBlob(blobSha256) {
    const transport = this.durable.transport;
    transport.delayedRevisionBlobs[blobSha256] = transport.revisionBlobs[blobSha256];
    delete transport.revisionBlobs[blobSha256];
  }

  releaseDelayedRevisionBlob(blobSha256) {
    const transport = this.durable.transport;
    if (transport.delayedRevisionBlobs[blobSha256] !== undefined) {
      transport.revisionBlobs[blobSha256] = transport.delayedRevisionBlobs[blobSha256];
      delete transport.delayedRevisionBlobs[blobSha256];
    }
  }

  corruptRevisionBlob(blobSha256, replacement = '{"corrupt":true}') {
    this.durable.transport.corruptRevisionBlobs[blobSha256] = replacement;
  }

  async receiveAdvertised(peerId, objectId) {
    const peer = this.peer(peerId);
    const state = this.object(peerId, objectId);
    let retained = 0;
    let missing = false;
    for (const writer of peer.configuredPeers) {
      const pointer = this.durable.transport.pointers[writer];
      if (!pointer) continue;
      const snapshotBytes = this.durable.transport.snapshots[
        pointer.currentHeadsSnapshotSha256
      ];
      if (!snapshotBytes) {
        missing = true;
        continue;
      }
      const snapshot = await validateContractDocument({
        kind: P02_SYNC_CONTRACT_V2.DOCUMENT_KIND.HEADS_SNAPSHOT,
        bytes: encoder.encode(snapshotBytes),
        expectedBlobSha256: pointer.currentHeadsSnapshotSha256,
        cryptoImplementation: crypto.webcrypto
      });
      const group = snapshot.value.objects.find((candidate) =>
        candidate.objectKey === state.descriptor.objectKey);
      if (!group) continue;
      for (const tip of group.tips) {
        const blobText = this.durable.transport.corruptRevisionBlobs[
          tip.revisionBlobSha256
        ] ?? this.durable.transport.revisionBlobs[tip.revisionBlobSha256];
        if (blobText === undefined) {
          missing = true;
          continue;
        }
        const parsed = JSON.parse(blobText);
        const result = await this.admitRevision(peerId, objectId, {
          document: parsed,
          bytes: encoder.encode(blobText),
          canonicalBytes: blobText,
          blobSha256: tip.revisionBlobSha256,
          objectKey: group.objectKey,
          sourceUpdatedAtIso: tip.sourceUpdatedAtIso
        }, { sourceWriter: writer });
        if (result.admitted) retained += 1;
      }
    }
    if (missing) state.blockReason = 'transport';
    else if (state.blockReason === 'transport') state.blockReason = null;
    return {
      ok: true,
      verdict: retained > 0 ? 'evidence-retained' : 'no-advertised-change',
      objectId,
      retained,
      missing
    };
  }

  applyNext(peerId, objectId) {
    const peer = this.peer(peerId);
    const state = this.object(peerId, objectId);
    if (peer.authorityMode !== 'auto') {
      return { ok: true, verdict: 'authority-suppressed' };
    }
    const classification = classifyObject(state, this.faults);
    const index = deriveIndex(state);
    let candidate = null;
    let effectKind = 'content-apply';
    if (classification.classification === 'remote-ahead') {
      candidate = index.byRevision[classification.liveRevisionIds[0]];
    } else if (classification.classification === 'object-deleted') {
      candidate = index.byRevision[classification.applyCandidateRevisionId];
      effectKind = 'soft-delete';
    }
    if (!candidate) return { ok: true, verdict: 'no-eligible-revision' };
    if (!candidate.validated || !candidate.proven) {
      failInvariant(INVARIANT.APPLY_REQUIRES_PROOF, candidate.revisionId);
    }
    if (effectKind === 'content-apply' && isClosure(candidate.document)) {
      failInvariant(INVARIANT.SUPERSESSION_NOT_DELETION, candidate.revisionId);
    }
    if (state.appliedReceipts[candidate.blobSha256]) {
      return { ok: true, verdict: 'identical-apply-replay', unchangedNoOp: true };
    }
    state.effectCounts[candidate.blobSha256] =
      (state.effectCounts[candidate.blobSha256] || 0) + 1;
    state.appliedReceipts[candidate.blobSha256] = {
      revisionId: candidate.revisionId,
      effectKind,
      sourceWriter: candidate.sourceWriter
    };
    state.remoteApplyAudit[candidate.blobSha256] = true;
    state.consumedRemoteBlobSha256 = candidate.blobSha256;
    state.canonical = {
      revisionId: candidate.revisionId,
      blobSha256: candidate.blobSha256,
      deleted: effectKind === 'soft-delete'
    };
    state.canonicalHistory.push({
      revisionId: candidate.revisionId,
      blobSha256: candidate.blobSha256,
      kind: effectKind
    });
    return { ok: true, verdict: 'applied', revisionId: candidate.revisionId, effectKind };
  }

  resolveAnchor(peerId, objectId) {
    const state = this.object(peerId, objectId);
    if (!state.canonical) return null;
    return {
      classification: state.consumedRemoteBlobSha256 === state.canonical.blobSha256
        ? 'KNOWN_CANONICAL_REMOTE_APPLIED'
        : 'LOCAL_UNPUBLISHED_CHANGE',
      revisionId: state.canonical.revisionId,
      localPublishedMatch: state.publishedBlobSha256[state.canonical.blobSha256] === true,
      remoteAppliedMatch:
        state.consumedRemoteBlobSha256 === state.canonical.blobSha256
    };
  }

  async publishCanonical(peerId, objectId) {
    const state = this.object(peerId, objectId);
    const evidence = state.evidence[state.canonical.revisionId];
    assert.ok(evidence, 'canonical publication requires retained revision bytes');
    const record = recordForEvidence(evidence);
    await this.publishRecords(peerId, [record]);
    state.publishedBlobSha256[state.canonical.blobSha256] = true;
    return { ok: true, verdict: 'published', revisionId: state.canonical.revisionId };
  }

  async reconcileObject(peerId, objectId) {
    const peer = this.peer(peerId);
    return reconcileOneObject({
      objectId,
      mayMutate: async () => peer.authorityMode === 'auto',
      receive: async () => this.receiveAdvertised(peerId, objectId),
      apply: async () => this.applyNext(peerId, objectId),
      resolveAnchor: async () => this.resolveAnchor(peerId, objectId),
      publish: async () => this.publishCanonical(peerId, objectId)
    });
  }

  /* Injected deterministic clock: no wall clock reaches a scheduling decision. */
  advanceClock(deltaMs) {
    this.rebuildable.clockMs += deltaMs;
    return this.rebuildable.clockMs;
  }

  /*
   * The real Z5 production scheduler is the system under test. Y-1 enumeration
   * and Y-9 classification arrive through narrow injected seams; the scheduler
   * owns selection, fairness, retry timing and wake coalescing, and nothing
   * else. Atomic per-object work still runs through reconcileOneObject().
   */
  scheduler(peerId) {
    const existing = this.rebuildable.schedulers[peerId];
    if (existing) return existing;
    const peer = this.peer(peerId);
    const scheduler = new P02ObjectScheduler({
      peerId,
      clock: () => this.rebuildable.clockMs,
      enumerate: async () => Object.values(peer.objects).map((state) => ({
        objectDomain: state.descriptor.objectDomain,
        objectId: state.descriptor.objectId,
        objectKey: state.descriptor.objectKey
      })),
      classify: async (descriptor) => {
        const state = this.object(peerId, descriptor.objectId);
        const verdict = classifyObject(state, this.faults);
        /*
         * Harness-only continuous-eligibility injection for the promoted
         * Spike-3 C fairness regression: an object that always has work again.
         * It never masks a blocked, indeterminate or integrity verdict.
         */
        if (state.syntheticContinuousEligibility &&
            verdict.classification === 'converged') {
          return {
            ...verdict,
            classification: 'local-ahead',
            reason: 'synthetic-continuous-eligibility'
          };
        }
        return verdict;
      },
      authority: async () => ({ mode: peer.authorityMode, valid: true }),
      execute: async (candidate) => {
        this.rebuildable.schedulerTrace.push({ peerId, objectId: candidate.objectId });
        return this.reconcileObject(peerId, candidate.objectId);
      }
    });
    this.rebuildable.schedulers[peerId] = scheduler;
    return scheduler;
  }

  async eligibleDescriptors(peerId) {
    const candidates = await this.scheduler(peerId).buildCandidates();
    return candidates.filter((candidate) =>
      candidate.runnability === P02_RUNNABILITY.RUNNABLE);
  }

  async runNextEligible(peerId) {
    const outcome = await this.scheduler(peerId).runOnce();
    if (!outcome.dispatched) return null;
    this.rebuildable.schedulerCursor[peerId] = outcome.candidate.orderingKey;
    return { candidate: outcome.candidate, result: outcome.result, outcome };
  }

  async runEligibleSteps(peerId, maximumSteps) {
    const results = [];
    for (let index = 0; index < maximumSteps; index += 1) {
      const result = await this.runNextEligible(peerId);
      if (!result) break;
      results.push(result);
    }
    return results;
  }

  restart({
    dropApplyDurability = false,
    dropRemoteApplyProvenance = false
  } = {}) {
    const durable = clone(this.durable);
    for (const peer of Object.values(durable.peers)) {
      for (const state of Object.values(peer.objects)) {
        if (dropApplyDurability) state.appliedReceipts = {};
        if (dropRemoteApplyProvenance) state.consumedRemoteBlobSha256 = null;
      }
    }
    return new DeterministicMultiObjectWorld({ durable, faults: this.faults });
  }

  objectSnapshot(peerId, objectId) {
    const state = this.object(peerId, objectId);
    return {
      descriptor: clone(state.descriptor),
      canonical: clone(state.canonical),
      evidenceRevisionIds: Object.keys(state.evidence).sort(),
      evidenceHashes: Object.values(state.evidence).map((item) => item.blobSha256).sort(),
      classification: this.classify(peerId, objectId),
      effectCounts: clone(state.effectCounts),
      publishedHashes: Object.keys(state.publishedBlobSha256).sort(),
      refusedAtCapacity: [...state.refusedAtCapacity]
    };
  }

  async assertTransportReferences() {
    const transport = this.durable.transport;
    for (const [writer, pointer] of Object.entries(transport.pointers)) {
      const pointerValidated = await validateContractDocument({
        kind: P02_SYNC_CONTRACT_V2.DOCUMENT_KIND.WRITER_STATE,
        bytes: encoder.encode(pointer.canonicalBytes),
        expectedBlobSha256: pointer.blobSha256,
        cryptoImplementation: crypto.webcrypto
      });
      const snapshotHash = pointerValidated.value.currentHeadsSnapshotSha256;
      const snapshotBytes = transport.snapshots[snapshotHash];
      if (!snapshotBytes) failInvariant(INVARIANT.REFERENCE_REQUIRES_IMMUTABLE, writer);
      const snapshot = await validateContractDocument({
        kind: P02_SYNC_CONTRACT_V2.DOCUMENT_KIND.HEADS_SNAPSHOT,
        bytes: encoder.encode(snapshotBytes),
        expectedBlobSha256: snapshotHash,
        cryptoImplementation: crypto.webcrypto
      });
      for (const group of snapshot.value.objects) {
        for (const tip of group.tips) {
          if (transport.revisionBlobs[tip.revisionBlobSha256] === undefined) {
            failInvariant(
              INVARIANT.REFERENCE_REQUIRES_IMMUTABLE,
              tip.revisionBlobSha256
            );
          }
        }
      }
    }
  }

  async assertInvariants() {
    const checked = new Set(Object.values(INVARIANT));
    for (const peer of Object.values(this.durable.peers)) {
      for (const state of Object.values(peer.objects)) {
        const index = deriveIndex(state);
        const classification = classifyObject(state, this.faults);
        const secondClassification = classifyObject(state, this.faults);
        if (JSON.stringify(classification) !== JSON.stringify(secondClassification)) {
          failInvariant(INVARIANT.CLASSIFICATION_DETERMINISTIC, state.descriptor.objectId);
        }
        for (const evidence of Object.values(state.evidence)) {
          if (evidence.canonicalBytes !== evidence.originalCanonicalBytes ||
              sha256(encoder.encode(evidence.canonicalBytes)) !== evidence.blobSha256) {
            failInvariant(INVARIANT.IMMUTABLE_EVIDENCE, evidence.revisionId);
          }
        }
        for (const [blobSha256, receipt] of Object.entries(state.appliedReceipts)) {
          const node = index.byRevision[receipt.revisionId];
          if (!node || !node.validated || !node.proven || node.blobSha256 !== blobSha256) {
            failInvariant(INVARIANT.APPLY_REQUIRES_PROOF, receipt.revisionId);
          }
        }
        const unproven = index.nodes.some((node) => !node.proven);
        if (unproven && classification.classification === 'object-deleted') {
          failInvariant(INVARIANT.MISSING_ANCESTRY_NOT_DELETION, state.descriptor.objectId);
        }
        if (classification.classification === 'object-deleted') {
          const deletion = index.byRevision[classification.applyCandidateRevisionId];
          if (!deletion || deletion.document.closureType !== 'object-deleted') {
            failInvariant(INVARIANT.SUPERSESSION_NOT_DELETION, state.descriptor.objectId);
          }
        }
        for (const node of index.nodes.filter((candidate) =>
          candidate.document.closureType === 'branch-superseded')) {
          const target = index.byRevision[node.document.selectedRevision.revisionId];
          if ((!target || !target.proven) && state.appliedReceipts[
            node.document.selectedRevision.revisionBlobSha256
          ]) {
            failInvariant(INVARIANT.SELECTED_REFERENCE_NOT_AUTHORITY, node.revisionId);
          }
        }
        for (const blobSha256 of Object.keys(state.publishedBlobSha256)) {
          if (state.remoteApplyAudit[blobSha256]) {
            failInvariant(INVARIANT.REMOTE_APPLY_NO_SELF_ECHO, blobSha256);
          }
        }
        for (const [blobSha256, count] of Object.entries(state.effectCounts)) {
          if (count > 1) {
            failInvariant(INVARIANT.DUPLICATE_WAKE_NO_DUPLICATE_EFFECT, blobSha256);
          }
        }
        if (peer.authorityMode !== 'auto' && state.manualEffectBaseline !== null &&
            totalEffects(state) !== state.manualEffectBaseline) {
          failInvariant(INVARIANT.MANUAL_IS_NON_MUTATING, state.descriptor.objectId);
        }
      }
    }
    for (const item of this.rebuildable.schedulerTrace) {
      const classification = this.classify(item.peerId, item.objectId).classification;
      if (classification.startsWith('blocked(')) {
        failInvariant(INVARIANT.BLOCKED_OBJECT_DOES_NOT_STARVE, item.objectId);
      }
    }
    await this.assertTransportReferences();
    return [...checked].sort();
  }
}

export function representativePermutations(items) {
  if (items.length === 0) return [[]];
  const output = [];
  const visit = (prefix, remaining) => {
    if (remaining.length === 0) {
      output.push(prefix);
      return;
    }
    for (let index = 0; index < remaining.length; index += 1) {
      visit(
        [...prefix, remaining[index]],
        [...remaining.slice(0, index), ...remaining.slice(index + 1)]
      );
    }
  };
  visit([], items);
  return output;
}

export const ACCEPTED_CORE_IDENTITY = Object.freeze({
  operation: 'reconcileOneObject',
  sourceBlobSha1: '7ca418a18dae7a5a405f5ef4159bba0d5a80d97f'
});
