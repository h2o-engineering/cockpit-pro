/*
 * Chrome P02 publication owner.
 *
 * One fixed-purpose composition joins the existing enumerator, steady
 * publisher/driver, durable local-publication-ledger and Z4 writer transport.
 * It is the sole place where Chrome receives a writable repository adapter.
 * Importing this module starts nothing and acquires no filesystem authority.
 */
import { P02_GENERATION_STATE, P02_WRITER_GENERATION }
  from '../../core/sync-writer-generation-v2.mjs';
import { classifyObjectState } from '../../core/sync-object-classifier-v2.mjs';
import { createP02SteadyPublication } from '../../core/sync-steady-publication-v2.mjs';
import { createP02SteadyDriver } from '../../core/sync-steady-driver-v2.mjs';
import { mintP02RevisionId } from '../../core/sync-p02-revision-mint-v2.mjs';
import { produceChatRevisionV2, P02_CHAT_DOMAIN_V2 }
  from './sync-revision-domain-chat-v2.mjs';
import { createChromeReadOnlyObjectEnumerator }
  from './sync-object-enumerator-v2.mjs';
import {
  buildWriterHeadsSnapshot,
  createLocalWriterTransportPrimitives
} from './sync-writer-transport-v2.mjs';
import { reconstructWriterHeadsSnapshot }
  from './sync-reader-transport-v2.mjs';
import { P02_SYNC_CONTRACT_V2, writerKeyHex } from './sync-contract-v2.mjs';
import { createChromeFsaWriteTransport, P02_FSA_WRITE_V2 }
  from './sync-fsa-write-transport-v2.mjs';

export const P02_CHROME_PUBLICATION_V2 = Object.freeze({
  SCHEMA: 'h2o.studio.syncChromePublication.p02.v1',
  RESULT_SCHEMA: 'h2o.studio.syncChromePublicationResult.p02.v1',
  LOCK_NAME: 'h2o:studio:sync:p02-chrome-publication:v1',
  FIRST_PUBLICATION: 'trusted-human-manual-only',
  AUTOMATIC_PUBLICATION: 'auto-mode-descendants-only'
});

const HEX64 = /^[0-9a-f]{64}$/;
const clean = (value) => String(value == null ? '' : value).trim();
const fail = (code) => { const error = new Error(code); error.code = code; throw error; };

function asContractHead(head, writerSyncPeerId) {
  return {
    schema: P02_SYNC_CONTRACT_V2.SCHEMA.HEAD,
    objectDomain: head.objectDomain,
    objectId: head.objectId,
    objectKey: head.objectKey,
    revisionId: head.revisionId,
    revisionBlobSha256: head.revisionBlobSha256,
    payloadSha256: head.payloadSha256,
    previousRevisionId: head.previousRevisionId ?? null,
    previousRevisionBlobSha256: head.previousRevisionBlobSha256 ?? null,
    writerSyncPeerId,
    sourceUpdatedAtIso: head.sourceUpdatedAtIso
  };
}

function fixed(outcome, extra = {}) {
  const ok = outcome === 'published' || outcome === 'recovered' ||
    outcome === 'no-eligible-local-change';
  return Object.freeze({
    schema: P02_CHROME_PUBLICATION_V2.RESULT_SCHEMA,
    ok, outcome, repositoryMutated: outcome === 'published',
    webdavReachable: false, ...extra
  });
}

export function createChromeP02PublicationOwner({
  loadContainerHandle,
  identityProvider,
  configProvider,
  writerGenerationGate,
  archiveAuthority,
  projection,
  syncStore,
  observeFormat,
  lockManager = globalThis.navigator?.locks,
  cryptoImplementation = globalThis.crypto,
  clock = () => new Date().toISOString(),
  onTrace = null
} = {}) {
  for (const port of [loadContainerHandle, configProvider, observeFormat]) {
    if (typeof port !== 'function') fail('p02-chrome-publication-dependency-invalid');
  }
  if (!identityProvider || typeof identityProvider.whenSyncReady !== 'function' ||
      !writerGenerationGate || typeof writerGenerationGate.p01MayMutate !== 'function' ||
      !archiveAuthority || !projection || !syncStore ||
      !lockManager || typeof lockManager.request !== 'function') {
    fail('p02-chrome-publication-dependency-invalid');
  }

  let active = null;
  let runContext = null;
  const trace = typeof onTrace === 'function' ? onTrace : () => {};

  async function localWriter() {
    const identity = await identityProvider.whenSyncReady();
    const syncPeerId = clean(identity?.syncPeerId);
    if (!syncPeerId) fail('p02-chrome-publication-local-identity-invalid');
    return Object.freeze({
      syncPeerId,
      writerKey: await writerKeyHex(syncPeerId, cryptoImplementation)
    });
  }

  async function requireP02LocalAuthority(manual) {
    const observation = await writerGenerationGate.observe();
    const verdict = await writerGenerationGate.p01MayMutate();
    /* Canonical recorded state, not a token the producer never emits. Both the
     * state AND the generation must be right; every other state - malformed,
     * unobserved, absent-observed - and every other generation still fail
     * closed here exactly as before. */
    if (observation?.state !== P02_GENERATION_STATE.RECORDED ||
        observation?.generation !== P02_WRITER_GENERATION.P02 ||
        verdict?.permitted !== false || verdict?.reason !== 'p01-writer-stood-down') {
      fail('p02-chrome-publication-p01-not-stood-down');
    }
    const config = await configProvider();
    /* MODE_VOCABULARY_ALIGNMENT: `off` is an explicit, named refusal for both
     * manual and automatic publication; it never becomes automatic-eligible. */
    if (config && config.schemaVersion === 1 && config.mode === 'off') {
      fail('p02-chrome-publication-sync-mode-off');
    }
    if (!config || config.schemaVersion !== 1 ||
        !['manual', 'notify', 'auto'].includes(config.mode)) {
      fail('p02-chrome-publication-config-invalid');
    }
    if (!manual && config.mode !== 'auto') {
      fail('p02-chrome-publication-automatic-disabled');
    }
    return { observation, config };
  }

  function generationRecord(writer, localObservation) {
    const source = localObservation?.record;
    const standdownAt = clean(source?.standdownAt);
    const decidedBy = clean(source?.decidedByWriterSyncPeerId);
    if (!standdownAt || !Number.isFinite(Date.parse(standdownAt)) || !decidedBy) {
      fail('p02-chrome-publication-generation-provenance-invalid');
    }
    return Object.freeze({
      schema: P02_FSA_WRITE_V2.GENERATION_SCHEMA,
      generation: 'p02',
      standdownAt,
      decidedByWriterSyncPeerId: decidedBy,
      reason: 'human-authorized-chrome-p02-publication',
      writerKey: writer.writerKey
    });
  }

  async function descriptorSnapshot(writer, manual) {
    const enumerator = createChromeReadOnlyObjectEnumerator({
      archiveAuthority,
      canonicalProjection: projection,
      syncStore,
      /* Local publication scopes are intentionally local. A remote configured
       * peer can make work visible, but can never become this writer. */
      configuredSyncPeerIds: [writer.syncPeerId],
      cryptoImplementation
    });
    const listed = await enumerator.enumerate();
    const eligible = [];
    for (const descriptor of listed.descriptors) {
      const verdict = classifyObjectState(descriptor);
      if (verdict.classification !== 'local-ahead' || descriptor.publishable !== true) continue;
      /* First publication is manual. Automatic wakes may advance only a chain
       * already committed by this same local writer. */
      if (!manual && !descriptor.protocolState?.lastPublished) continue;
      eligible.push(descriptor);
    }
    eligible.sort((left, right) =>
      left.objectId.localeCompare(right.objectId) ||
      left.objectKey.localeCompare(right.objectKey));
    return Object.freeze({ listed, eligible: Object.freeze(eligible) });
  }

  async function execute(manual) {
    const authority = await requireP02LocalAuthority(manual);
    const writer = await localWriter();
    const [snapshot, recoveryObjects] = await Promise.all([
      descriptorSnapshot(writer, manual),
      syncStore.listLocalPublicationRecoveryObjects()
    ]);
    if (recoveryObjects.length > 1) {
      return fixed('ambiguous-pending-publications', {
        manual, eligibleCount: snapshot.eligible.length,
        pendingCount: recoveryObjects.length, repositoryGeneration: null
      });
    }
    if (recoveryObjects.length === 0 && snapshot.eligible.length === 0) {
      return fixed('no-eligible-local-change', {
        manual, eligibleCount: 0, repositoryGeneration: null
      });
    }
    if (recoveryObjects.length === 0 && snapshot.eligible.length !== 1) {
      return fixed('ambiguous-local-candidates', {
        manual, eligibleCount: snapshot.eligible.length, repositoryGeneration: null
      });
    }
    const containerHandle = await loadContainerHandle();
    const fsa = createChromeFsaWriteTransport({ containerHandle, cryptoImplementation });
    /* Format authority precedes every repository mutation, including the
     * bounded first-writer generation record. This preflight permits only
     * that local generation record to be absent; all later gates require it. */
    const preflight = await observeFormat({
      writer, fsa, allowWriterGenerationAbsent: true
    });
    const preflightGate = preflight?.gate ?? preflight;
    if (preflightGate?.mayWrite !== true) {
      return fixed(clean(preflightGate?.reason) || 'format-authority-invalid', {
        manual, eligibleCount: 1, repositoryGeneration: null
      });
    }
    /* This bounded initialization is within the same cross-context lock as the
     * publication and after exact candidate selection. Existing malformed or
     * non-p02 records are never repaired. */
    const repositoryGeneration = await fsa.ensureWriterGeneration({
      writerKey: writer.writerKey,
      record: generationRecord(writer, authority.observation)
    });
    const transport = createLocalWriterTransportPrimitives({
      storage: fsa.storage,
      ownedWriterSyncPeerId: writer.syncPeerId,
      cryptoImplementation
    });

    async function recoverPendingPublication(recovery) {
      const observed = await syncStore.resolveLocalPublicationPending(
        recovery.objectKey);
      const request = observed?.pending?.request;
      /*
       * A pending row carrying NO p02Plan was never produced by this lane: it is
       * residue from the retired local-publication slot lane, which staged
       * intents without one. Reporting it as `pending-publication-invalid` said
       * the row was malformed, which is wrong and actionless - it is a perfectly
       * well-formed intent belonging to a lane that P02 has retired.
       *
       * It is typed, never adopted and never auto-retired: converting it here
       * would silently launder a foreign-lane intent into a P02 revision, and
       * retiring it here would destroy evidence outside an authorized operation.
       * Clearing it is the governed foreign-intent retirement's job.
       */
      if (request && request.p02Plan == null &&
          request.objectId === recovery.objectId &&
          request.revisionId === recovery.revisionId) {
        return fixed('foreign-lane-residue', {
          manual,
          eligibleCount: 0,
          foreignLaneResidue: true,
          objectId: request.objectId,
          objectKey: recovery.objectKey,
          revisionId: request.revisionId,
          pendingState: observed.state
        });
      }
      if (!request || request.objectId !== recovery.objectId ||
          request.revisionId !== recovery.revisionId ||
          request.p02Plan?.writerSyncPeerId !== writer.syncPeerId) {
        return fixed('pending-publication-invalid', {
          manual, eligibleCount: 0, reusedMint: recovery.revisionId
        });
      }
      let heads;
      try {
        heads = await reconstructWriterHeadsSnapshot({
          bytes: request.headBytes,
          expectedHeadsSnapshotSha256: request.headSha256Hex,
          cryptoImplementation
        });
      } catch (_) {
        return fixed('pending-heads-invalid', {
          manual, eligibleCount: 0, reusedMint: request.revisionId
        });
      }
      if (heads.writerSyncPeerId !== writer.syncPeerId ||
          !heads.heads.some((head) =>
            head.objectId === request.objectId &&
            head.objectKey === request.objectKey &&
            head.revisionId === request.revisionId &&
            head.revisionBlobSha256 === request.revisionBlobSha256Hex)) {
        return fixed('pending-heads-invalid', {
          manual, eligibleCount: 0, reusedMint: request.revisionId
        });
      }
      const current = await transport.readWriterState({
        writerSyncPeerId: writer.syncPeerId
      });
      if (current?.status === 'verified' &&
          current.pointer?.currentHeadsSnapshotSha256 === request.headSha256Hex) {
        await syncStore.commitLocalPublicationIntent(
          request.objectKey, request.revisionId);
        return fixed('recovered', {
          manual, eligibleCount: 1, reusedMint: request.revisionId,
          mintedRevisionId: request.revisionId,
          repositoryMutated: false,
          recovery: 'verified-state-pointer-adopted'
        });
      }
      const actualBase = current?.status === 'verified'
        ? current.pointer?.currentHeadsSnapshotSha256
        : current?.status === 'absent' ? null : undefined;
      if (actualBase === undefined ||
          actualBase !== request.p02Plan.expectedCurrentHeadsSnapshotSha256) {
        return fixed('pending-pointer-unresolved', {
          manual, eligibleCount: 0, reusedMint: request.revisionId
        });
      }
      /* Re-use the exact durable mint, immutable bytes, complete heads and CAS
       * token. A crash before any of the repository phases never creates a
       * second revision identity. */
      await requireP02LocalAuthority(manual);
      const format = await observeFormat({ writer, fsa });
      if ((format?.gate ?? format)?.mayWrite !== true) {
        return fixed('pending-authority-refused', {
          manual, eligibleCount: 0, reusedMint: request.revisionId
        });
      }
      const batch = await transport.publishBatch({
        revisions: [{
          objectDomain: P02_CHAT_DOMAIN_V2.OBJECT_DOMAIN,
          objectId: request.objectId,
          objectKey: request.objectKey,
          revisionBlobSha256: request.revisionBlobSha256Hex,
          bytes: request.revisionBlobBytes
        }],
        heads: heads.heads,
        expectedCurrentHeadsSnapshotSha256:
          request.p02Plan.expectedCurrentHeadsSnapshotSha256
      });
      if (batch?.ok !== true) {
        return fixed('pending-publication-blocked', {
          manual, eligibleCount: 0, reusedMint: request.revisionId
        });
      }
      await syncStore.commitLocalPublicationIntent(
        request.objectKey, request.revisionId);
      return fixed('recovered', {
        manual, eligibleCount: 1, reusedMint: request.revisionId,
        mintedRevisionId: request.revisionId,
        repositoryMutated: true,
        recovery: 'durable-attempt-resumed'
      });
    }

    if (recoveryObjects.length === 1) {
      return recoverPendingPublication(recoveryObjects[0]);
    }
    const selected = snapshot.eligible[0];
    const descriptorFor = async (scope) => {
      const current = await descriptorSnapshot(writer, manual);
      return current.listed.descriptors.find((item) =>
        item.objectId === scope.objectId && item.syncPeerId === writer.syncPeerId) ?? null;
    };

    async function pointerProof(pending) {
      let state;
      try { state = await transport.readWriterState({ writerSyncPeerId: writer.syncPeerId }); }
      catch (_) { return { status: 'unreadable' }; }
      if (state?.status === 'absent') return { status: 'absent-verified' };
      if (state?.status !== 'verified') return { status: clean(state?.status) || 'unreadable' };
      const request = pending?.request;
      const head = (state.snapshot?.heads || []).find((item) =>
        item.objectKey === request?.objectKey &&
        item.revisionId === request?.revisionId);
      return {
        status: 'verified',
        namesRevisionId: head?.revisionId ?? null,
        namesRevisionBlobSha256: head?.revisionBlobSha256 ?? null
      };
    }

    const steady = createP02SteadyPublication({
      onTrace: trace,
      readWriterState: () =>
        transport.readWriterState({ writerSyncPeerId: writer.syncPeerId }),
      readCanonicalProjection: async ({ objectId }) => {
        const value = await projection.projectCurrent(objectId);
        return value ? {
          revisionId: value.revisionId,
          revisionBlobSha256: value.revisionBlobSha256Hex,
          payloadSha256: value.payloadSha256Hex,
          objectKey: value.objectKeyHex,
          sourceUpdatedAtIso: value.sourceUpdatedAtIso,
          payload: value.payload
        } : null;
      },
      readProtocolState: async (scope) => {
        const descriptor = await descriptorFor(scope);
        const [pending, convergence, applySnapshot] = await Promise.all([
          syncStore.resolveLocalPublicationPending(scope.objectKey),
          syncStore.readLocalPublicationConvergence(scope.objectKey),
          syncStore.readApplySnapshot(scope.objectId)
        ]);
        const request = pending?.pending?.request ?? null;
        return {
          ...(descriptor?.protocolState ?? {}),
          convergedDirection: convergence?.convergedDirection ?? null,
          publishedPayloadSha256: convergence?.tip?.payloadSha256Hex ?? null,
          appliedPayloadSha256:
            applySnapshot?.applyState?.lastApplied?.payloadSha256Hex ?? null,
          intendedRevisionId: request?.revisionId ?? null,
          intendedRevisionBlobSha256: request?.revisionBlobSha256Hex ?? null,
          intendedPayloadSha256: request?.payloadSha256Hex ?? null,
          pendingOperation: request
            ? 'publish'
            : (descriptor?.protocolState?.pendingOperation ?? null),
          pointerProof: request ? await pointerProof(pending) : {}
        };
      },
      proveAnchor: async ({ objectDomain, objectId, objectKey, pair }) => {
        if (!pair || !HEX64.test(clean(pair.revisionBlobSha256))) return { status: 'absent' };
        try {
          const found = await transport.readRevision({
            objectDomain, objectId, objectKey,
            revisionBlobSha256: pair.revisionBlobSha256
          });
          return found?.status === 'verified' &&
            (!pair.revisionId || found.value?.revisionId === pair.revisionId)
            ? { status: 'verified' }
            : { status: clean(found?.status) || 'unreadable' };
        } catch (_) { return { status: 'unreadable' }; }
      },
      probeDescent: async ({ objectDomain, objectId, objectKey, candidate, seed }) => {
        if (!candidate || !seed || !HEX64.test(candidate.revisionBlobSha256 || '') ||
            !HEX64.test(seed.revisionBlobSha256 || '')) return { outcome: 'incomplete' };
        if (candidate.revisionBlobSha256 === seed.revisionBlobSha256) {
          return { outcome: 'proven-chain', descendsFromSeed: true };
        }
        let cursor = candidate.revisionBlobSha256;
        for (let step = 0; step < 64; step += 1) {
          const read = await transport.readRevision({
            objectDomain, objectId, objectKey, revisionBlobSha256: cursor
          });
          if (read?.status !== 'verified') return { outcome: 'unreadable' };
          const previous = read.value?.previousRevisionBlobSha256;
          if (previous === null) return { outcome: 'proven-chain', descendsFromSeed: false };
          if (previous === seed.revisionBlobSha256) {
            return { outcome: 'proven-chain', descendsFromSeed: true };
          }
          cursor = previous;
        }
        return { outcome: 'incomplete' };
      },
      mintRevisionId: () => mintP02RevisionId(cryptoImplementation),
      produceRevision: async ({ objectDomain, objectId, objectKey, p02Parent, revisionId }) => {
        const projected = await projection.projectCurrent(objectId);
        if (!projected) fail('p02-chrome-publication-canonical-unavailable');
        const produced = await produceChatRevisionV2({
          canonicalObject: { objectId, revisionId, payload: projected.payload },
          writerSyncPeerId: writer.syncPeerId,
          p02Parent: p02Parent ?? null,
          cryptoImplementation
        });
        return {
          ...produced,
          sourceUpdatedAtIso: projected.sourceUpdatedAtIso,
          revisionInput: {
            objectDomain: objectDomain || P02_CHAT_DOMAIN_V2.OBJECT_DOMAIN,
            objectId, objectKey,
            revisionBlobSha256: produced.revisionBlobSha256,
            bytes: produced.canonicalBytes
          }
        };
      },
      recordIntent: async (input) => {
        const heads = input.heads.map((head) => asContractHead(head, writer.syncPeerId));
        const headsSnapshot = await buildWriterHeadsSnapshot({
          writerSyncPeerId: writer.syncPeerId, heads, cryptoImplementation
        });
        const canonical = input.canonicalAnchor ?? {};
        const staged = await syncStore.stageLocalPublicationIntent({
          objectId: input.objectId,
          objectKey: input.objectKey,
          revisionId: input.intendedRevisionId,
          previousRevisionId: input.produced?.revision?.previousRevisionId ?? null,
          revisionBlobSha256Hex: input.intendedRevisionBlobSha256,
          payloadSha256Hex: input.intendedPayloadSha256,
          headSha256Hex: headsSnapshot.headsSnapshotSha256,
          revisionBlobBytes: input.produced?.canonicalBytes,
          headBytes: headsSnapshot.bytes,
          p02Plan: {
            writerSyncPeerId: writer.syncPeerId,
            expectedCurrentHeadsSnapshotSha256:
              input.expectedCurrentHeadsSnapshotSha256 ?? null,
            anchorRevisionId: clean(canonical.revisionId) || null,
            anchorRevisionBlobSha256:
              HEX64.test(clean(canonical.revisionBlobSha256))
                ? canonical.revisionBlobSha256 : null,
            anchorPayloadSha256: HEX64.test(clean(canonical.payloadSha256))
              ? canonical.payloadSha256 : null
          }
        });
        const readback = await syncStore.resolveLocalPublicationPending(input.objectKey);
        if (!readback?.pending ||
            readback.pending.request.revisionId !== input.intendedRevisionId ||
            readback.pending.request.headSha256Hex !== headsSnapshot.headsSnapshotSha256 ||
            readback.pending.request.p02Plan?.writerSyncPeerId !== writer.syncPeerId) {
          fail('p02-chrome-publication-intent-readback-mismatch');
        }
        return staged;
      },
      completePublication: (input) =>
        syncStore.commitLocalPublicationIntent(input.objectKey, input.revisionId),
      abandonIntent: async (input) => {
        const pending = await syncStore.resolveLocalPublicationPending(input.objectKey);
        const revisionId = pending?.pending?.request?.revisionId;
        if (!revisionId) return Object.freeze({ ok: true, verdict: 'nothing-pending' });
        /* The owner resolves every pending row before fresh eligibility, so
         * this port only retains an uncertain/stale fresh attempt. Reuse the
         * existing durable retry transition: never clear or re-mint it. */
        return syncStore.markLocalPublicationRetry(input.objectKey, revisionId);
      },
      beginSteadyLease: async () => {
        if (runContext?.locked !== true) fail('p02-chrome-publication-lock-lost');
        await requireP02LocalAuthority(manual);
        return { capability: runContext.capability };
      },
      finishSteadyLease: async () => undefined,
      createTransport: () => Object.freeze({
        ...transport,
        publishBatch: (input) => transport.publishBatch({
          ...input,
          heads: (input.heads || []).map((head) =>
            asContractHead(head, writer.syncPeerId))
        })
      }),
      observeAuthority: async () => {
        try {
          await requireP02LocalAuthority(manual);
          const generation = await fsa.storage.read(
            `writers/${writer.writerKey}/generation.json`);
          if (generation === null) return { permitted: false, reason: 'repository-generation-absent' };
          const parsed = JSON.parse(new TextDecoder().decode(generation));
          return parsed?.schema === P02_FSA_WRITE_V2.GENERATION_SCHEMA &&
            parsed?.generation === 'p02' && parsed?.writerKey === writer.writerKey
            ? { permitted: true }
            : { permitted: false, reason: 'repository-generation-invalid' };
        } catch (error) {
          return { permitted: false, reason: clean(error?.code) || 'authority-unreadable',
            blockReason: 'permission' };
        }
      }
    });

    async function currentSelectedDescriptor() {
      const current = await descriptorSnapshot(writer, manual);
      return current.eligible.find((item) => item.objectKey === selected.objectKey) ?? null;
    }

    const driver = createP02SteadyDriver({
      steadyPublication: steady,
      enumerate: async () => {
        const current = await currentSelectedDescriptor();
        return Object.freeze(current ? [current] : []);
      },
      /* Scheduler revalidation deliberately passes identity only. Re-read the
       * canonical descriptor so the decision cannot depend on a stale page or
       * on the richer shape of the initial enumeration row. */
      classify: async () => {
        const current = await currentSelectedDescriptor();
        return current
          ? classifyObjectState(current)
          : { classification: 'unclassified', reason: 'object-no-longer-present' };
      },
      authority: async () => ({
        valid: true,
        mode: manual ? 'manual' : 'auto',
        manualPublication: manual
      }),
      gate: async () => {
        const observation = await observeFormat({ writer, fsa });
        return observation?.gate ?? observation;
      },
      peerId: writer.syncPeerId,
      clock: () => Date.now(),
      p01WriterActive: async () =>
        (await writerGenerationGate.p01MayMutate()).permitted === true
    });

    const report = await driver.runtime.runPass({ maxSteps: 1, singlePass: true });
    const result = report?.dispatched?.[0]?.result?.steady ?? null;
    const outcome = result?.outcome === 'committed' ? 'published'
      : result?.outcome === 'recovered' ? 'recovered'
        : result?.outcome === 'not-eligible' ? 'no-eligible-local-change'
          : clean(result?.reason) || clean(report?.status) || 'publication-failed';
    return fixed(outcome, {
      manual,
      eligibleCount: 1,
      selectedObjectId: selected.objectId,
      localWriterSyncPeerId: writer.syncPeerId,
      localWriterKey: writer.writerKey,
      mintedRevisionId: result?.revisionId ?? null,
      repositoryGeneration,
      report
    });
  }

  function run({ manual = false } = {}) {
    if (active) return Promise.resolve(fixed('busy'));
    active = lockManager.request(
      P02_CHROME_PUBLICATION_V2.LOCK_NAME,
      { mode: 'exclusive' },
      async () => {
        const seed = new Uint8Array(32);
        cryptoImplementation.getRandomValues(seed);
        runContext = {
          locked: true,
          capability: [...seed].map((byte) => byte.toString(16).padStart(2, '0')).join('')
        };
        try { return await execute(manual === true); }
        finally { runContext = null; }
      }
    ).catch((error) => fixed(clean(error?.code) || 'publication-failed'))
      .finally(() => { active = null; });
    return active;
  }

  return Object.freeze({
    schema: P02_CHROME_PUBLICATION_V2.SCHEMA,
    publishManual: () => run({ manual: true }),
    publishAutomaticDescendant: () => run({ manual: false }),
    diagnose: () => Object.freeze({ active: active !== null, webdavReachable: false })
  });
}
