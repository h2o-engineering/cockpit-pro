/*
 * O1-R3 B2 — the production Desktop composition for the bounded steady pass.
 *
 * This is an ASSEMBLY POINT and owns no protocol decision. Eligibility, parent
 * selection, intent recovery, the CAS plan and the publication ordering all
 * belong to packages/core; the durable I/O belongs to the native P02 commands;
 * the canonical reads belong to the Desktop projection and the read-only
 * enumerator. Everything here is construction, injection and shape adaptation
 * between two existing contracts.
 *
 * IT IS THE REAL CHAIN. The steady publication and steady driver constructed
 * here are the accepted ones, over the same production adapters the governed
 * first-publication surface uses: the same enumerator, the same writer storage,
 * the same transport primitives, the same publication lease commands and the
 * same publication evidence. Nothing here is a stand-in, and no synthetic port
 * from a validator appears in this file.
 *
 * IMPORTING THIS MODULE STARTS NOTHING. Every export is a factory; no timer,
 * listener, pass or repository read happens at load.
 *
 * THE SHAPES DIFFER, AND THAT IS THIS FILE'S JOB. The core publication calls
 * `completePublication(oneObject)` and `abandonIntent(oneObject)`, while the
 * Desktop evidence surface takes `(acquisition, input)`. The acquisition is
 * therefore tracked here, per object, between recordIntent and its completion -
 * and when there is none, because the intent was written by an earlier process,
 * the row is adopted through the evidence surface's own adopt protocol rather
 * than by writing to it directly.
 */

import { createBoundedSteadyActivation } from '../core/sync-steady-activation-v2.mjs';
import { createP02SteadyPublication } from '../core/sync-steady-publication-v2.mjs';
import { createP02SteadyDriver } from '../core/sync-steady-driver-v2.mjs';
import { createDesktopP01MutationGate }
  from './sync-writer-generation-desktop-v2.tauri.mjs';
import { evaluateFormatGate } from '../core/sync-format-gate-v2.mjs';
import { classifyObjectState } from '../core/sync-object-classifier-v2.mjs';
import { createDesktopReadOnlyObjectEnumerator }
  from './sync-object-enumerator-v2.tauri.mjs';
import { mintP02RevisionId } from '../core/sync-p02-revision-mint-v2.mjs';
import { produceChatRevisionV2 }
  from '../browser-adapters/chrome/sync-revision-domain-chat-v2.mjs';
import { createLocalWriterTransportPrimitives }
  from '../browser-adapters/chrome/sync-writer-transport-v2.mjs';
import { writerKeyHex, P02_SYNC_CONTRACT_V2 }
  from '../browser-adapters/chrome/sync-contract-v2.mjs';
import { createDesktopLocalWriterStorage }
  from './sync-writer-storage-desktop-v2.tauri.mjs';
import { createDesktopFirstPublication }
  from './sync-first-publication-desktop-v2.tauri.mjs';

const DB_URL = 'sqlite:studio-v1.db';
const CHAT_OBJECT_DOMAIN = 'studio.chat.saved-state.v1';

export const P02_DESKTOP_STEADY = Object.freeze({
  SCHEMA: 'h2o.studio.syncSteadyActivationDesktop.p02.v1',
  COMMAND: Object.freeze({
    RESOLVE_ROOT: 'h2o_p02_resolve_repository_root',
    READ_GENERATION_AUTHORITY: 'h2o_p02_read_writer_generation_authority',
    READ_LIBRARY_AUTHORITY: 'h2o_p02_read_library_authority',
    /*
     * THE STEADY WRITE WINDOW, not the first-writer one.
     *
     * `h2o_p02_publication_begin` is the V8-D FIRST-publication lease: it
     * refuses outright once writers/<key>/state.json exists, so it can never
     * serve a steady republication. The steady window is `steady_begin_core` /
     * `steady_finish_core` in p02_steady_authority.rs - fully implemented, and
     * governed by boot session, container hash, activated epoch, the p02
     * writer-generation record and the expected CAS pointer.
     *
     * Those two were unreachable until the authorized B2 closure exposed them
     * as narrow wrappers that delegate to those cores and decide nothing. They
     * are reachable, never autonomous: this composition is their only caller,
     * and it runs only for an explicitly authorized operator request.
     */
    BEGIN: 'h2o_p02_steady_begin',
    FINISH: 'h2o_p02_steady_finish',
    RUNTIME_SESSION: 'h2o_sync_object_runtime_session'
  }),
  PROTOCOL_ROW: `SELECT
    pending_operation, operation_phase, last_conflict_class, last_error_code,
    last_published_revision_id, last_published_revision_blob_sha256,
    last_published_payload_sha256, last_applied_revision_id,
    last_applied_revision_blob_sha256, last_applied_payload_sha256,
    last_converged_direction, intended_revision_id,
    intended_revision_blob_sha256, intended_payload_sha256
  FROM sync_object_state WHERE sync_peer_id = ? AND object_id = ? LIMIT 1`,
  /* A publication chain is walked backwards to answer descent. The bound is a
   * refusal, not a truncation: an unfinished walk reports incomplete evidence,
   * which the parent selector treats as "blocked", never as "no descent". */
  MAX_DESCENT_STEPS: 64
});

export const P02_DESKTOP_STEADY_ERROR = Object.freeze({
  RUNTIME_UNAVAILABLE: 'p02-steady-desktop-runtime-unavailable',
  IDENTITY_UNAVAILABLE: 'p02-steady-desktop-writer-identity-unavailable',
  PROJECTION_UNAVAILABLE: 'p02-steady-desktop-projection-unavailable',
  EVIDENCE_UNAVAILABLE: 'p02-steady-desktop-publication-evidence-unavailable',
  REPOSITORY_UNAVAILABLE: 'p02-steady-desktop-repository-unavailable'
});

const clean = (value) => String(value == null ? '' : value).trim();
const HEX64 = /^[0-9a-f]{64}$/;
const hex64 = (value) => HEX64.test(clean(value));

class P02DesktopSteadyError extends Error {
  constructor(code) { super(code); this.name = 'P02DesktopSteadyError'; this.code = code; }
}
const fail = (code) => { throw new P02DesktopSteadyError(code); };

/*
 * The production composition.
 *
 * Every dependency is injected, exactly as the first-publication adapter does
 * it, so this surface holds no ambient authority and can be exercised without
 * reaching for globals.
 */
export function createDesktopSteadyActivation({
  invoke,
  projection,
  identity,
  evidence,
  cryptoImplementation = globalThis.crypto,
  onTrace = null
} = {}) {
  if (typeof invoke !== 'function') fail(P02_DESKTOP_STEADY_ERROR.RUNTIME_UNAVAILABLE);
  if (!projection || typeof projection.projectObject !== 'function') {
    fail(P02_DESKTOP_STEADY_ERROR.PROJECTION_UNAVAILABLE);
  }
  if (!evidence || typeof evidence.recordIntent !== 'function' ||
      typeof evidence.readState !== 'function') {
    fail(P02_DESKTOP_STEADY_ERROR.EVIDENCE_UNAVAILABLE);
  }

  /*
   * Preserves the native refusal code across the IPC boundary. A Tauri
   * rejection arrives as a STRING, and the publication core reads `error.code`;
   * without this the native refusal - which names exactly which of the steady
   * window's checks said no - is flattened to a generic "lease refused", and an
   * operator cannot tell a stale CAS base from a wrong container or a missing
   * generation record.
   */
  const invokeWithCode = async (command, args) => {
    try { return await invoke(command, args); }
    catch (error) {
      const code = clean(typeof error === 'string' ? error : error?.message || error) ||
        'native-refused';
      const wrapped = new Error(code);
      wrapped.code = code;
      throw wrapped;
    }
  };

  const select = (query, values = []) =>
    invoke('plugin:sql|select', { db: DB_URL, query, values });
  const sql = { select: (query, values) => select(query, values) };

  /* The production DB-side gate. Its refusal is the authority, not a string. */
  const p01Gate = createDesktopP01MutationGate({ sql, seamName: 'p02-steady-activation' });

  async function writerIdentity() {
    const value = identity && typeof identity.get === 'function' ? identity.get() : null;
    const syncPeerId = clean(value?.syncPeerId);
    if (!syncPeerId) fail(P02_DESKTOP_STEADY_ERROR.IDENTITY_UNAVAILABLE);
    return { syncPeerId, writerKey: await writerKeyHex(syncPeerId, cryptoImplementation) };
  }

  /* ---------------- activation ports ---------------- */

  /* The DB record, read through the production gate so the answer is the
   * PREDICATE's ("may P01 mutate?"), never a string comparison of our own. */
  const observeDatabaseGeneration = () => p01Gate.observe();

  async function resolveBinding() {
    const target = await invoke(P02_DESKTOP_STEADY.COMMAND.RESOLVE_ROOT, {});
    const repositoryRoot = clean(target?.repositoryRoot);
    const containerPathSha256Hex = clean(target?.containerPathSha256Hex);
    if (!repositoryRoot || !hex64(containerPathSha256Hex)) {
      return Object.freeze({ valid: false });
    }
    const writer = await writerIdentity();
    return Object.freeze({
      valid: true,
      repositoryRoot,
      containerPathSha256Hex,
      writerKey: writer.writerKey,
      syncPeerId: writer.syncPeerId,
      authorityPresent: target?.authorityPresent === true
    });
  }

  /*
   * The repository lease record, through the narrow native semantic reader.
   * It takes no path: the repository is the binding's, resolved natively.
   */
  async function observeRepositoryGeneration(binding) {
    const observation = await invoke(
      P02_DESKTOP_STEADY.COMMAND.READ_GENERATION_AUTHORITY,
      { writerKey: clean(binding?.writerKey) }
    );
    return Object.freeze({ state: clean(observation?.state) || 'unreadable' });
  }

  /* ---------------- driver ports ---------------- */

  /*
   * The format gate, from the authority document the V7 ceremony wrote. The
   * bytes come from the narrow native read; the MEANING comes from the shared
   * evaluateFormatGate that every other P02 surface consults. An unreadable or
   * malformed document yields a null libraryInfo, which fails closed.
   */
  async function readFormatGate() {
    let observation;
    try {
      observation = await invoke(P02_DESKTOP_STEADY.COMMAND.READ_LIBRARY_AUTHORITY, {});
    } catch (_) {
      return evaluateFormatGate({ libraryInfo: null, repositoryHasContent: true });
    }
    if (observation?.present !== true || observation?.readable !== true) {
      return evaluateFormatGate({ libraryInfo: null, repositoryHasContent: true });
    }
    let libraryInfo = null;
    try { libraryInfo = JSON.parse(observation.canonicalBytes); }
    catch (_) { libraryInfo = null; }
    return evaluateFormatGate({ libraryInfo, repositoryHasContent: true });
  }

  function readOnlyTransport(writerSyncPeerId) {
    return createLocalWriterTransportPrimitives({
      storage: createDesktopLocalWriterStorage({ invoke, capability: null }),
      ownedWriterSyncPeerId: writerSyncPeerId
    });
  }

  async function protocolRow(syncPeerId, objectId) {
    const rows = await select(P02_DESKTOP_STEADY.PROTOCOL_ROW, [syncPeerId, objectId]);
    return (Array.isArray(rows) ? rows[0] : null) || {};
  }

  /*
   * The pointer proof recovery needs: does the writer's own pointer name the
   * intended revision? Read-only, and it distinguishes a verified absence from
   * an unread pointer, because only the first is disproof.
   */
  async function pointerProofFor({ writerSyncPeerId, objectKey, intended }) {
    if (!clean(intended?.revisionId) || !hex64(intended?.revisionBlobSha256)) {
      return { status: 'unread' };
    }
    let state;
    try { state = await readOnlyTransport(writerSyncPeerId).readWriterState({ writerSyncPeerId }); }
    catch (_) { return { status: 'unreadable' }; }
    const status = clean(state?.status);
    if (status === 'absent') return { status: 'absent-verified' };
    if (status !== 'verified') return { status: status || 'unreadable' };
    const head = (state.snapshot?.heads ?? []).find((candidate) =>
      clean(candidate?.objectKey) === clean(objectKey) &&
      clean(candidate?.revisionBlobSha256) === clean(intended.revisionBlobSha256)) ?? null;
    if (head === null) {
      /* The pointer was read and does not name it. Verified, and not an error. */
      return { status: 'verified', namesRevisionId: null, namesRevisionBlobSha256: null };
    }
    return {
      status: 'verified',
      namesRevisionId: clean(head.revisionId),
      namesRevisionBlobSha256: clean(head.revisionBlobSha256)
    };
  }

  /* One revision at an immutable address, read-only. */
  async function readRevisionAt({ writerSyncPeerId, objectDomain, objectId, objectKey,
    revisionBlobSha256 }) {
    const revision = await readOnlyTransport(writerSyncPeerId).readRevision({
      objectDomain, objectId, objectKey, revisionBlobSha256
    });
    return revision?.status === 'verified' ? revision.value ?? null : null;
  }

  /* The accepted V8-D adapter, constructed lazily and only to borrow its
   * published-side heal. Constructing it starts nothing; no publication path
   * of its own is reachable from here. */
  let firstPublicationAdapter = null;
  const firstPublication = () => {
    if (firstPublicationAdapter === null) {
      firstPublicationAdapter = createDesktopFirstPublication({
        invoke, projection, identity, cryptoImplementation
      });
    }
    return firstPublicationAdapter;
  };

  function buildSteadyPublication({ writer }) {
    /* Acquisitions live only between recordIntent and its completion. */
    const acquisitions = new Map();
    const keyFor = (scope) => `${clean(scope.writerSyncPeerId)}\u0000${clean(scope.objectId)}`;

    async function ownAcquisition(scope) {
      const existing = acquisitions.get(keyFor(scope));
      if (existing) return existing;
      /* No acquisition in this process: the intent belongs to an earlier run.
       * Adopt the row through the evidence surface's own protocol - it applies
       * the stale-owner and same-boot rules this file must not restate. */
      if (typeof evidence.adoptIntent !== 'function') return null;
      return evidence.adoptIntent({
        syncPeerId: scope.writerSyncPeerId, objectId: scope.objectId
      });
    }

    return createP02SteadyPublication({
      onTrace,

      readWriterState: ({ writerSyncPeerId }) =>
        readOnlyTransport(writerSyncPeerId).readWriterState({ writerSyncPeerId }),

      /* Canonical eligibility, from the same read-only projection the governed
       * first publication uses. Never a cached projection. */
      readCanonicalProjection: async ({ objectId }) => {
        const projected = await projection.projectObject(objectId);
        if (!projected) return null;
        return {
          revisionId: projected.revisionId,
          revisionBlobSha256: projected.revisionBlobSha256Hex,
          payloadSha256: projected.payloadSha256Hex,
          objectKey: projected.objectKeyHex,
          sourceUpdatedAtIso: projected.sourceUpdatedAtIso,
          payload: projected.payload
        };
      },

      /* The protocol state in the DOMAIN's shape, not the table's. */
      readProtocolState: async (scope) => {
        const row = await protocolRow(scope.writerSyncPeerId, scope.objectId);
        const intended = {
          revisionId: clean(row.intended_revision_id),
          revisionBlobSha256: clean(row.intended_revision_blob_sha256)
        };
        const publishedPayload = clean(row.last_published_payload_sha256);
        const publishedRevision = clean(row.last_published_revision_id);
        return {
          pendingOperation: row.pending_operation ?? null,
          operationPhase: row.operation_phase ?? null,
          intendedRevisionId: row.intended_revision_id ?? null,
          intendedRevisionBlobSha256: row.intended_revision_blob_sha256 ?? null,
          intendedPayloadSha256: row.intended_payload_sha256 ?? null,
          adoptIntent: null,
          convergedDirection: clean(row.last_converged_direction) || null,
          publishedPayloadSha256: row.last_published_payload_sha256 ?? null,
          appliedPayloadSha256: row.last_applied_payload_sha256 ?? null,
          lastPublished: publishedRevision ? {
            revisionId: publishedRevision,
            revisionBlobSha256: clean(row.last_published_revision_blob_sha256)
          } : null,
          lastApplied: clean(row.last_applied_revision_id) ? {
            revisionId: clean(row.last_applied_revision_id),
            revisionBlobSha256: clean(row.last_applied_revision_blob_sha256)
          } : null,
          /* A published anchor with no payload identity beside it is the exact
           * state heal-on-proof exists to repair. */
          publishedPayloadMissing: publishedRevision !== '' && publishedPayload === '',
          integrityQuarantined: clean(row.last_conflict_class) !== '',
          blockReason: null,
          divergedUnresolved: false,
          retainedUnprovenParent: false,
          foreignLanePublicationActive: false,
          pointerProof: await pointerProofFor({
            writerSyncPeerId: scope.writerSyncPeerId,
            objectKey: scope.objectKey,
            intended
          })
        };
      },

      /* Is this anchor pair actually in the repository? */
      proveAnchor: async ({ objectDomain, objectId, objectKey, writerSyncPeerId, pair }) => {
        if (!pair || !hex64(pair.revisionBlobSha256)) return { status: 'absent' };
        let value;
        try {
          value = await readRevisionAt({
            writerSyncPeerId, objectDomain: objectDomain || CHAT_OBJECT_DOMAIN,
            objectId, objectKey, revisionBlobSha256: pair.revisionBlobSha256
          });
        } catch (_) { return { status: 'unreadable' }; }
        if (value === null) return { status: 'absent' };
        /* The address is content-addressed, so a revision that does not carry
         * the expected id is an identity conflict, not a miss. */
        if (clean(pair.revisionId) && clean(value.revisionId) !== clean(pair.revisionId)) {
          return { status: 'identity-conflict' };
        }
        return { status: 'verified' };
      },

      /*
       * Does `candidate` descend from `seed`? Walk the immutable chain back
       * from the candidate. A walk that cannot be completed reports anything
       * other than 'proven-chain', which the parent selector reads as
       * incomplete evidence and blocks on - never as proof of no descent.
       */
      probeDescent: async ({ objectDomain, objectId, objectKey, writerSyncPeerId,
        candidate, seed }) => {
        if (!candidate || !seed || !hex64(candidate.revisionBlobSha256) ||
            !hex64(seed.revisionBlobSha256)) {
          return { outcome: 'incomplete' };
        }
        if (clean(candidate.revisionBlobSha256) === clean(seed.revisionBlobSha256)) {
          return { outcome: 'proven-chain', descendsFromSeed: true };
        }
        let cursor = clean(candidate.revisionBlobSha256);
        for (let step = 0; step < P02_DESKTOP_STEADY.MAX_DESCENT_STEPS; step += 1) {
          let value;
          try {
            value = await readRevisionAt({
              writerSyncPeerId, objectDomain: objectDomain || CHAT_OBJECT_DOMAIN,
              objectId, objectKey, revisionBlobSha256: cursor
            });
          } catch (_) { return { outcome: 'unreadable' }; }
          if (value === null) return { outcome: 'unreadable' };
          const previous = clean(value.previousRevisionBlobSha256);
          if (!previous) {
            /* A complete walk that reached the root without meeting the seed. */
            return { outcome: 'proven-chain', descendsFromSeed: false };
          }
          if (previous === clean(seed.revisionBlobSha256)) {
            return { outcome: 'proven-chain', descendsFromSeed: true };
          }
          cursor = previous;
        }
        return { outcome: 'incomplete' };
      },

      mintRevisionId: () => mintP02RevisionId(cryptoImplementation),

      produceRevision: async ({ objectDomain, objectId, objectKey, p02Parent, revisionId }) => {
        const projected = await projection.projectObject(objectId);
        if (!projected) fail(P02_DESKTOP_STEADY_ERROR.PROJECTION_UNAVAILABLE);
        const produced = await produceChatRevisionV2({
          canonicalObject: {
            objectId,
            revisionId,
            payload: projected.payload
          },
          writerSyncPeerId: writer.syncPeerId,
          p02Parent: p02Parent ?? null,
          cryptoImplementation
        });
        return {
          ...produced,
          /* The head timestamp must be the projection's durable value, never a
           * clock: identical content must produce identical bytes. */
          sourceUpdatedAtIso: projected.sourceUpdatedAtIso,
          /*
           * The Z4 revision input, named explicitly. The producer returns the
           * serialized bytes as `canonicalBytes`, while publishBatch expects a
           * record addressing the revision and carrying `bytes`. Passing the
           * producer's own object through instead fails validation as
           * `p02-z1-schema-invalid` - correctly, since it is not that shape.
           * The bytes are the producer's, never a re-serialization, which
           * could differ from the hash the address was derived from.
           */
          revisionInput: {
            objectDomain: objectDomain || CHAT_OBJECT_DOMAIN,
            objectId,
            objectKey,
            revisionBlobSha256: produced.revisionBlobSha256,
            bytes: produced.canonicalBytes
          }
        };
      },

      /*
       * PUBLISHED-SIDE HEAL, reusing the ACCEPTED mechanism verbatim.
       *
       * A profile carried across the v21->v22 migration can hold an object
       * whose published anchor pair is recorded but whose two new columns -
       * `last_published_payload_sha256` and `last_converged_direction` - are
       * still NULL. The comparator needs both to call the object converged, so
       * a genuinely settled object classifies `local-ahead` forever and is
       * dispatched on every pass. The applied side is already healed by the
       * accepted convergence path; the published side was not.
       *
       * This does NOT introduce a second content authority. It is the V8-D
       * adapter's own `healPublishedIdentity`, which already requires the whole
       * proof: the recorded pair must be present and the row idle, the
       * revision must resolve and verify at its immutable address, the payload
       * identity must come from that verified envelope, and - the part that
       * matters most - the CURRENT canonical projection payload must equal it.
       * A canonical edit after publication yields `canonical-diverged` and no
       * heal, so the object stays dirty and remains publishable.
       *
       * The durable write is the evidence surface's single guarded UPDATE,
       * which sets both fields together and only while the row is idle and
       * still names that exact pair with a NULL payload - so it is atomic,
       * replay-safe, and a second observation affects no rows.
       */
      healPublishedIdentity: async (scope) => firstPublication().healPublishedIdentity({
        syncPeerId: scope.writerSyncPeerId,
        objectId: scope.objectId,
        evidence
      }),

      recordIntent: async (input) => {
        const acquisition = await evidence.recordIntent({
          syncPeerId: input.writerSyncPeerId,
          objectId: input.objectId,
          objectKey: input.objectKey,
          revisionId: input.intendedRevisionId,
          revisionBlobSha256: input.intendedRevisionBlobSha256,
          payloadSha256: input.intendedPayloadSha256
        });
        acquisitions.set(keyFor(input), acquisition);
        return acquisition;
      },

      completePublication: async (input) => {
        const acquisition = input.acquisition ?? await ownAcquisition(input);
        if (!acquisition) fail(P02_DESKTOP_STEADY_ERROR.EVIDENCE_UNAVAILABLE);
        try {
          await evidence.completePublication(acquisition, {
            syncPeerId: input.writerSyncPeerId,
            objectId: input.objectId,
            revisionId: input.revisionId,
            revisionBlobSha256: input.revisionBlobSha256,
            payloadSha256: input.payloadSha256
          });
        } finally { acquisitions.delete(keyFor(input)); }
      },

      abandonIntent: async (input) => {
        const acquisition = await ownAcquisition(input);
        if (!acquisition) return;
        try {
          await evidence.abandonIntent(acquisition, {
            syncPeerId: input.writerSyncPeerId,
            objectId: input.objectId,
            /* `retain` means "the repository may already hold it", which is
             * exactly what retainIntent means on the evidence side. */
            retainIntent: input.retain === true,
            errorCode: clean(input.reason) || 'steady-abandoned'
          });
        } finally { acquisitions.delete(keyFor(input)); }
      },

      /*
       * The write window. The capability comes from the native lease and is
       * handed straight into the storage adapter closure; no raw storage
       * command is ever issued from here.
       */
      beginSteadyLease: async (request) => {
        const session = await invoke(P02_DESKTOP_STEADY.COMMAND.RUNTIME_SESSION, {});
        const bootId = clean(session?.bootId);
        if (!bootId) fail(P02_DESKTOP_STEADY_ERROR.RUNTIME_UNAVAILABLE);
        const target = await invoke(P02_DESKTOP_STEADY.COMMAND.RESOLVE_ROOT, {});
        /*
         * The steady window's full request. Every field is required by
         * `steady_begin_core`, which validates them all before it decides
         * anything - the writer key it will look the generation record up
         * under, the container it must match, the layout epoch it must find
         * activated, and the CAS base this publication planned against.
         *
         * `expectedCurrentHeadsSnapshotSha256` is passed through exactly as the
         * plan produced it. A first own publication legitimately has none, and
         * the native side then refuses: steady does not onboard writers, and
         * that refusal is the boundary doing its job rather than a defect.
         */
        return invokeWithCode(P02_DESKTOP_STEADY.COMMAND.BEGIN, {
          request: {
            writerSyncPeerId: request.writerSyncPeerId,
            writerKey: writer.writerKey,
            expectedContainerPathSha256Hex: clean(target?.containerPathSha256Hex),
            expectedLayoutEpoch: 1,
            objectDomain: request.objectDomain || CHAT_OBJECT_DOMAIN,
            objectId: request.objectId,
            objectKey: request.objectKey,
            revisionId: request.revisionId,
            revisionBlobSha256: request.revisionBlobSha256,
            expectedCurrentHeadsSnapshotSha256:
              request.expectedCurrentHeadsSnapshotSha256 ?? null,
            bootId
          }
        });
      },
      finishSteadyLease: (capability, outcome) =>
        invokeWithCode(P02_DESKTOP_STEADY.COMMAND.FINISH, { capability, outcome }),

      /*
       * The transport, with ONE shape adaptation on the way in.
       *
       * The heads-merge plan describes tips in the PLANNER's vocabulary: it
       * carries `proven` and omits `schema`, because inside the planner those
       * are the useful facts. The Z4 head document is a strict contract - 11
       * keys exactly, `schema` among them, `proven` not - and a plan tip handed
       * straight through is rejected as `p02-z1-schema-invalid`.
       *
       * So the tips are projected onto the contract shape here. Nothing is
       * decided: every value comes from the plan, and a head missing anything
       * the contract requires still fails validation rather than being
       * patched into acceptability.
       */
      createTransport: (capability) => {
        const primitives = createLocalWriterTransportPrimitives({
          storage: createDesktopLocalWriterStorage({ invoke, capability }),
          ownedWriterSyncPeerId: writer.syncPeerId
        });
        const asContractHead = (head) => ({
          schema: P02_SYNC_CONTRACT_V2.SCHEMA.HEAD,
          objectDomain: head.objectDomain,
          objectId: head.objectId,
          objectKey: head.objectKey,
          revisionId: head.revisionId,
          revisionBlobSha256: head.revisionBlobSha256,
          payloadSha256: head.payloadSha256,
          previousRevisionId: head.previousRevisionId ?? null,
          previousRevisionBlobSha256: head.previousRevisionBlobSha256 ?? null,
          writerSyncPeerId: head.writerSyncPeerId || writer.syncPeerId,
          sourceUpdatedAtIso: head.sourceUpdatedAtIso
        });
        return Object.freeze({
          ...primitives,
          publishBatch: (input) => primitives.publishBatch({
            ...input,
            heads: (input?.heads ?? []).map(asContractHead)
          })
        });
      },

      /*
       * Authority, re-observed on demand. The publication asks twice per
       * attempt - once at the start and once immediately before the mutating
       * call - and BOTH reads land here, uncached, on purpose.
       */
      observeAuthority: async () => {
        let verdict;
        try { verdict = await p01Gate.p01MayMutate(); }
        catch (_) { return { permitted: false, reason: 'database-unreadable',
          blockReason: 'transport' }; }
        if (verdict?.permitted !== false) {
          return { permitted: false, reason: 'p01-writer-still-permitted',
            blockReason: 'permission' };
        }
        if (clean(verdict.reason) !== 'p01-writer-stood-down') {
          return { permitted: false, reason: clean(verdict.reason) || 'authority-unknown',
            blockReason: 'permission' };
        }
        let repository;
        try {
          repository = await invoke(P02_DESKTOP_STEADY.COMMAND.READ_GENERATION_AUTHORITY,
            { writerKey: writer.writerKey });
        } catch (_) { return { permitted: false, reason: 'repository-unreadable',
          blockReason: 'transport' }; }
        if (clean(repository?.state) !== 'p02') {
          return { permitted: false, reason: `repository-${clean(repository?.state) || 'unreadable'}`,
            blockReason: 'permission' };
        }
        return { permitted: true };
      }
    });
  }

  /* One enumeration path, used by both the enumerate port and the classifier's
   * re-read. Not memoized: the recheck's value is that it is fresh. */
  let enumerateDescriptors = async () => [];

  async function buildDriver(binding) {
    const writer = { syncPeerId: clean(binding?.syncPeerId), writerKey: clean(binding?.writerKey) };
    if (!writer.syncPeerId) fail(P02_DESKTOP_STEADY_ERROR.IDENTITY_UNAVAILABLE);

    enumerateDescriptors = async () => {
      const enumeration = await createDesktopReadOnlyObjectEnumerator({
        sql, projection, configuredSyncPeerIds: [writer.syncPeerId]
      }).enumerate();
      return enumeration?.descriptors ?? [];
    };

    return createP02SteadyDriver({
      steadyPublication: buildSteadyPublication({ writer }),
      peerId: writer.syncPeerId,
      /* Durable timestamps come from the projection; the runtime's clock is
       * used only for its own bookkeeping. */
      clock: () => Date.now(),
      onTrace,

      /* The real read-only enumerator, over the real canonical tables. The
       * runtime wants an ARRAY of descriptors. */
      enumerate: async () => [...(await enumerateDescriptors())],

      /*
       * THE CLASSIFIER IS CALLED WITH TWO DIFFERENT SHAPES, and that is the
       * whole reason this adapter exists.
       *
       * buildCandidates passes a full read-only descriptor. But the scheduler's
       * pre-dispatch completion-race recheck (`revalidate`) passes only
       * { objectDomain, objectId, objectKey } - deliberately, so the decision
       * is re-derived rather than carried. Handing that bare triple straight to
       * classifyObjectState yields a non-runnable verdict for EVERY object,
       * because none of the state it classifies is present, and the scheduler
       * then reports a runnable candidate it never dispatches.
       *
       * So a bare triple is answered by re-enumerating and classifying the
       * matching descriptor. That is exactly what the recheck asks for - a
       * fresh read - and the verdict still comes from the one production
       * classifier.
       */
      classify: async (input) => {
        const isDescriptor = input && (input.protocolState !== undefined ||
          input.canonicalLocalHead !== undefined || input.dirty !== undefined);
        if (isDescriptor) return classifyObjectState(input);
        const objectId = clean(input?.objectId);
        const objectDomain = clean(input?.objectDomain);
        const descriptors = await enumerateDescriptors();
        const match = descriptors.find((candidate) =>
          clean(candidate?.objectId) === objectId &&
          clean(candidate?.objectDomain) === objectDomain) ?? null;
        /* An object that has vanished between selection and recheck is not
         * runnable, which is precisely what the recheck is protecting. */
        if (match === null) return { classification: 'converged', reason: 'object-absent-on-recheck' };
        return classifyObjectState(match);
      },

      /* Mutation is permitted for a governed bounded pass; the gate and the
       * per-step authority above are what actually decide anything. */
      authority: async () => ({ mode: 'auto', valid: true }),
      gate: readFormatGate,

      /*
       * The structural dual-writer guard. It reports whether the accepted P01
       * writer may still mutate - so a repository whose DB record still permits
       * P01 stops the pass here, before any object is even classified.
       */
      p01WriterActive: async () => {
        try {
          const verdict = await p01Gate.p01MayMutate();
          return verdict?.permitted !== false;
        } catch (_) {
          /* Unknown is not "inactive". */
          return true;
        }
      }
    });
  }

  const activation = createBoundedSteadyActivation({
    observeDatabaseGeneration,
    observeRepositoryGeneration,
    resolveBinding,
    buildDriver,
    onTrace
  });

  return Object.freeze({
    schema: P02_DESKTOP_STEADY.SCHEMA,
    check: (request) => activation.check(request),
    runBoundedPass: (request) => activation.runBoundedPass(request),
    /* Exposed for the operator surface's preflight reporting only. */
    observeDatabaseGeneration,
    observeRepositoryGeneration,
    resolveBinding,
    readFormatGate
  });
}

export { P02DesktopSteadyError };
