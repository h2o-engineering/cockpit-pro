/*
 * P02 V8-D — Desktop wiring for the governed first-writer publication.
 *
 * This is the assembly point between the operator surface and the production
 * chain, and it owns no protocol decision of its own. Eligibility is C1's,
 * selection binding is C2's, revision bytes are V8-A's, ordering and recovery
 * are C3b's, the write window is C3a's, publication is Z4's and durable I/O is
 * V8-B's. Everything here is construction, injection and presentation.
 *
 * Presentation is deliberately quarantined. Titles are read read-only for the
 * sole purpose of letting a person tell candidates apart; they never enter a
 * selection key, a binding, a publication identity or any governance evidence,
 * and a title changing must not move publication authority. A future domain
 * supplies its own presentation through the same adapter shape.
 *
 * Importing this module starts nothing.
 */

import { createDesktopReadOnlyObjectEnumerator }
  from './sync-object-enumerator-v2.tauri.mjs';
import {
  prepareFirstPublicationCandidates,
  selectFirstPublicationCandidate
} from '../core/sync-first-publication-candidates-v2.mjs';
import {
  executeFirstPublication,
  prepareFirstPublication,
  recoverFirstPublication
} from '../core/sync-first-publication-composition-v2.mjs';
import { mintP02RevisionId } from '../core/sync-p02-revision-mint-v2.mjs';
import { produceChatRevisionV2 }
  from '../browser-adapters/chrome/sync-revision-domain-chat-v2.mjs';
import { createLocalWriterTransportPrimitives }
  from '../browser-adapters/chrome/sync-writer-transport-v2.mjs';
import { P02_SYNC_CONTRACT_V2, writerKeyHex }
  from '../browser-adapters/chrome/sync-contract-v2.mjs';
import { createDesktopLocalWriterStorage }
  from './sync-writer-storage-desktop-v2.tauri.mjs';

const DB_URL = 'sqlite:studio-v1.db';
const CHAT_OBJECT_DOMAIN = 'studio.chat.saved-state.v1';
const { SCHEMA } = P02_SYNC_CONTRACT_V2;

export const P02_DESKTOP_FIRST_PUBLICATION = Object.freeze({
  SCHEMA: 'h2o.studio.syncFirstPublicationDesktop.p02.v1',
  COMMAND: Object.freeze({
    BEGIN: 'h2o_p02_publication_begin',
    FINISH: 'h2o_p02_publication_finish',
    /* O1-T17: the live profile-lock session, proving the ceremony request came
     * from the process that holds the lock. */
    RUNTIME_SESSION: 'h2o_sync_object_runtime_session',
    RESOLVE_ROOT: 'h2o_p02_resolve_repository_root'
  }),
  /* Read-only, presentation only. Never part of any authority. */
  PRESENTATION_QUERY: 'SELECT id AS object_id, title AS presentation_title FROM chats ORDER BY id'
});

export const P02_DESKTOP_FIRST_PUBLICATION_ERROR = Object.freeze({
  RUNTIME_UNAVAILABLE: 'p02-v8d-desktop-runtime-unavailable',
  IDENTITY_UNAVAILABLE: 'p02-v8d-canonical-writer-identity-unavailable',
  REPOSITORY_UNAVAILABLE: 'p02-v8d-repository-unavailable',
  EVIDENCE_UNAVAILABLE: 'p02-v8d-publication-evidence-unavailable',
  SOURCE_DRIFTED: 'p02-v8d-canonical-source-drifted'
});

export class P02DesktopFirstPublicationError extends Error {
  constructor(code) {
    super(code);
    this.name = 'P02DesktopFirstPublicationError';
    this.code = code;
  }
}
const fail = (code) => { throw new P02DesktopFirstPublicationError(code); };
const clean = (value) => String(value == null ? '' : value).trim();

function resolveInvoke(global) {
  const internals = global.__TAURI_INTERNALS__;
  if (internals && typeof internals.invoke === 'function') return internals.invoke.bind(internals);
  const tauri = global.__TAURI__;
  if (tauri?.core && typeof tauri.core.invoke === 'function') return tauri.core.invoke.bind(tauri.core);
  if (tauri && typeof tauri.invoke === 'function') return tauri.invoke.bind(tauri);
  return null;
}

/*
 * All dependencies are injected so the surface stays testable and holds no
 * ambient authority. Production supplies the real Tauri invoke, the real
 * canonical identity and the real dynamically-loaded Desktop projection.
 */
export function createDesktopFirstPublication({
  invoke,
  projection,
  identity,
  cryptoImplementation = globalThis.crypto
} = {}) {
  if (typeof invoke !== 'function') fail(P02_DESKTOP_FIRST_PUBLICATION_ERROR.RUNTIME_UNAVAILABLE);
  if (!projection || typeof projection.projectObject !== 'function') {
    fail(P02_DESKTOP_FIRST_PUBLICATION_ERROR.RUNTIME_UNAVAILABLE);
  }

  const select = (query, values = []) => invoke('plugin:sql|select', { db: DB_URL, query, values });

  async function writerIdentity() {
    const value = identity && typeof identity.get === 'function' ? identity.get() : null;
    const syncPeerId = clean(value?.syncPeerId);
    if (!syncPeerId) fail(P02_DESKTOP_FIRST_PUBLICATION_ERROR.IDENTITY_UNAVAILABLE);
    return { syncPeerId, writerKey: await writerKeyHex(syncPeerId, cryptoImplementation) };
  }

  async function repositoryAuthority() {
    const target = await invoke(P02_DESKTOP_FIRST_PUBLICATION.COMMAND.RESOLVE_ROOT, {});
    const containerPathSha256Hex = clean(target?.containerPathSha256Hex);
    if (!/^[0-9a-f]{64}$/.test(containerPathSha256Hex)) {
      fail(P02_DESKTOP_FIRST_PUBLICATION_ERROR.REPOSITORY_UNAVAILABLE);
    }
    return { containerPathSha256Hex, layoutEpoch: 1, authorityPresent: target?.authorityPresent === true };
  }

  /* Durable source timestamps observed during projection, by object. */
  const sourceUpdatedAtIsoByObject = new Map();
  function requireSourceUpdatedAtIso(objectId) {
    const value = sourceUpdatedAtIsoByObject.get(objectId);
    if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
      /* Refuse rather than substitute: a head with a synthesized timestamp
       * would advertise a fact canonical state does not support. */
      fail(P02_DESKTOP_FIRST_PUBLICATION_ERROR.SOURCE_DRIFTED);
    }
    return value;
  }

  /* The domain presentation adapter: one read-only title lookup, nothing else. */
  async function presentationIndex() {
    const rows = await select(P02_DESKTOP_FIRST_PUBLICATION.PRESENTATION_QUERY);
    const index = new Map();
    for (const row of Array.isArray(rows) ? rows : []) {
      index.set(clean(row.object_id), clean(row.presentation_title));
    }
    return index;
  }
  const presentationFor = (index) => (descriptor) => Object.freeze({
    label: index.get(descriptor.objectId) || '(untitled)',
    objectTypeLabel: 'Saved chat',
    shortObjectId: `${descriptor.objectId.slice(0, 8)}…`,
    sourceRevisionId: descriptor.canonicalLocalHead?.revisionId ?? null
  });

  async function enumerate(peers) {
    return createDesktopReadOnlyObjectEnumerator({
      sql: { select: (query, values) => select(query, values) },
      projection,
      configuredSyncPeerIds: peers
    }).enumerate();
  }

  /* ---- Prepare: read-only, no default selection ---- */
  async function prepareCandidates() {
    const writer = await writerIdentity();
    const enumeration = await enumerate([writer.syncPeerId]);
    const index = await presentationIndex();
    const preparation = await prepareFirstPublicationCandidates({
      enumeration, presentation: presentationFor(index), cryptoImplementation
    });
    return Object.freeze({
      schema: P02_DESKTOP_FIRST_PUBLICATION.SCHEMA,
      writer, enumeration, preparation,
      selected: preparation.selected,
      counts: preparation.counts
    });
  }

  /* ---- Plan: read-only preview for one explicitly chosen candidate ---- */
  /*
   * The bytes that get published come from the same read-only projection that
   * produced the candidate, re-read at plan time and then pinned to the binding
   * the operator actually selected. Any disagreement means the object moved
   * under us between enumeration and review, so the plan is refused rather than
   * rebuilt: a first publication must describe a source the reviewer saw.
   */
  async function canonicalObjectFor(binding) {
    let projected;
    try {
      projected = await projection.projectObject(binding.objectId, binding.sourceRevisionId);
    } catch {
      fail(P02_DESKTOP_FIRST_PUBLICATION_ERROR.SOURCE_DRIFTED);
    }
    if (!projected ||
        projected.revisionId !== binding.sourceRevisionId ||
        projected.objectKeyHex !== binding.objectKey ||
        projected.payloadSha256Hex !== binding.sourcePayloadSha256 ||
        projected.revisionBlobSha256Hex !== binding.sourceRevisionBlobSha256) {
      fail(P02_DESKTOP_FIRST_PUBLICATION_ERROR.SOURCE_DRIFTED);
    }
    /*
     * O1-T15. The projection derives this from durable canonical state, and it
     * must be the value the head advertises. Stamping the head from the wall
     * clock instead - which is what this adapter did - makes two publications
     * of identical content produce different bytes, so an idempotent replay at
     * a content address becomes a new write every time.
     */
    sourceUpdatedAtIsoByObject.set(binding.objectId, projected.sourceUpdatedAtIso);
    return Object.freeze({
      objectId: binding.objectId,
      /*
       * A1 §4: the ENVELOPE identity is minted here, at prepare-for-publish,
       * and is deliberately not the canonical snapshot id. A snapshot id names
       * canonical state, which an in-place edit rewrites without changing the
       * id, so borrowing it made two different revisions collide on identity
       * and made an A -> B -> A cycle able to re-mint an id that already named
       * something else. The projected payload above keeps its own source
       * identity untouched; only the envelope gets the mint.
       *
       * Minting here rather than deeper also gives recovery the behaviour it
       * needs for free: the mint is recorded with the publish intent, so a
       * restart that PROVES the repository holds the revision reuses the
       * recorded mint, while one that disproves it abandons and re-plans with
       * a fresh mint that cannot collide with the abandoned one.
       */
      revisionId: mintP02RevisionId(cryptoImplementation),
      payload: projected.payload
    });
  }

  async function preparePlan({ prepared, selectionKey }) {
    const plan = selectFirstPublicationCandidate({
      preparation: prepared.preparation, selectionKey
    });
    const repository = await repositoryAuthority();
    const publication = await prepareFirstPublication({
      enumeration: prepared.enumeration,
      plan,
      produceRevision: async (binding) => produceChatRevisionV2({
        canonicalObject: await canonicalObjectFor(binding),
        writerSyncPeerId: prepared.writer.syncPeerId,
        /* V8-A ROOT ruling: the first P02 revision of a P01-history object has
         * no P02 parent. P01 ancestry is never imported or synthesised. */
        p02Parent: null,
        cryptoImplementation
      }),
      writer: prepared.writer,
      repository,
      cryptoImplementation
    });
    return Object.freeze({ plan, repository, publication });
  }

  /*
   * Read-only view of the repository, used to answer one question: does it
   * already prove a pending intent? Storage reads are ungated by design, so no
   * capability is created and no write path is reachable from here.
   */
  function repositoryProofReader(writerSyncPeerId) {
    const transport = createLocalWriterTransportPrimitives({
      storage: createDesktopLocalWriterStorage({ invoke, capability: null }),
      ownedWriterSyncPeerId: writerSyncPeerId
    });
    return async ({ objectKey, revisionBlobSha256 }) => {
      const state = await transport.readWriterState({ writerSyncPeerId });
      if (!state || state.status !== 'verified') return { pointerPresent: false };
      const head = (state.snapshot?.heads ?? []).find((candidate) =>
        candidate.objectKey === objectKey &&
        candidate.revisionBlobSha256 === revisionBlobSha256) ?? null;
      /* No head names this revision, so the pointer does not prove it and there
       * is no proven address to read a revision from. */
      if (head === null) {
        return { pointerPresent: true, headsNamesRevision: false, revisionPresent: false,
          revisionId: null, revisionBlobSha256: null };
      }
      /* The domain and id come from the proven head itself, never from the
       * caller: the head is what the pointer actually commits to. */
      const revision = await transport.readRevision({
        objectDomain: head.objectDomain, objectId: head.objectId,
        objectKey, revisionBlobSha256
      });
      return {
        pointerPresent: true,
        headsNamesRevision: true,
        revisionPresent: revision?.status === 'verified',
        revisionId: head.revisionId,
        revisionBlobSha256: head.revisionBlobSha256
      };
    };
  }

  /*
   * Heal-on-proof, reachable on its own rather than only from a publish attempt:
   * an object whose identity is missing is exactly the object that cannot be
   * offered for publication, so gating the repair behind publish eligibility
   * would make it unreachable for the rows that need it.
   *
   * The repository is the authority. Only when the published anchor is present
   * there AND its payload identity equals the current canonical payload is the
   * missing identity written back. A different payload is not healed - it is a
   * real divergence and must stay visible.
   */
  async function healPublishedIdentity({ syncPeerId, objectId, evidence }) {
    if (!evidence || typeof evidence.healPublishedPayloadIdentity !== 'function' ||
        typeof evidence.readState !== 'function') {
      return { healed: false, reason: 'evidence-unavailable' };
    }
    const state = await evidence.readState(syncPeerId, objectId);
    const revisionId = clean(state?.last_published_revision_id);
    const revisionBlobSha256 = clean(state?.last_published_revision_blob_sha256);
    const storedPayload = clean(state?.last_published_payload_sha256);
    if (!revisionId || !revisionBlobSha256) return { healed: false, reason: 'no-published-anchor' };
    if (storedPayload) return { healed: false, reason: 'already-identified' };
    if (clean(state?.pending_operation)) return { healed: false, reason: 'row-busy' };

    let projected;
    try {
      projected = await projection.projectObject(objectId);
    } catch {
      return { healed: false, reason: 'canonical-unavailable' };
    }
    const objectKey = clean(projected?.objectKeyHex);
    const canonicalPayload = clean(projected?.payloadSha256Hex);
    if (!objectKey || !canonicalPayload) return { healed: false, reason: 'canonical-unavailable' };

    const transport = createLocalWriterTransportPrimitives({
      storage: createDesktopLocalWriterStorage({ invoke, capability: null }),
      ownedWriterSyncPeerId: syncPeerId
    });
    let revision;
    try {
      revision = await transport.readRevision({
        objectDomain: CHAT_OBJECT_DOMAIN, objectId, objectKey, revisionBlobSha256
      });
    } catch {
      return { healed: false, reason: 'repository-unreadable' };
    }
    if (!revision || revision.status !== 'verified') {
      return { healed: false, reason: 'repository-anchor-unproven' };
    }
    /* The verified read returns the parsed envelope under `value`. */
    const provenPayload = clean(revision.value?.payloadSha256);
    if (!provenPayload) return { healed: false, reason: 'repository-anchor-unproven' };
    if (provenPayload !== canonicalPayload) {
      /* Real divergence: the repository holds different content than canonical
       * state does. That is a publishable difference, not a bookkeeping gap. */
      return { healed: false, reason: 'canonical-diverged' };
    }
    const outcome = await evidence.healPublishedPayloadIdentity({
      syncPeerId, objectId, revisionId, revisionBlobSha256, payloadSha256: provenPayload
    });
    return { healed: outcome?.healed === true, reason: outcome?.healed ? 'healed' : 'guard-refused' };
  }

  /*
   * Bounded pre-Execute recovery. It looks at exactly one object - the one the
   * operator selected - and only when a publish intent is already pending on
   * it. If the repository proves that intent, the interrupted publication is
   * finished by repairing local bookkeeping alone; nothing is republished. If
   * the repository contradicts it, the refusal propagates and Execute never
   * runs, because publishing over an unexplained pending intent is exactly the
   * divergence this whole protocol exists to prevent.
   */
  async function recoverInterruptedPublication({ prepared, planned, evidence }) {
    if (typeof evidence.readState !== 'function') return null;
    const syncPeerId = prepared.writer.syncPeerId;
    const objectId = planned.publication.objectId;
    const state = await evidence.readState(syncPeerId, objectId);
    const pendingOperation = state?.pending_operation ?? state?.pendingOperation ?? null;
    if (pendingOperation !== 'publish') return null;
    return recoverFirstPublication({
      syncPeerId,
      objectId,
      state,
      evidence,
      readRepositoryPublication: repositoryProofReader(syncPeerId)
    });
  }

  /*
   * Execute: the ONLY mutating path, and the only one the surface may call.
   * Raw V8-B storage commands are never invoked from here - the capability is
   * created by C3a and handed straight into the storage adapter closure.
   */
  async function execute({ prepared, planned, authority, evidence }) {
    if (!evidence || typeof evidence.recordIntent !== 'function') {
      fail(P02_DESKTOP_FIRST_PUBLICATION_ERROR.EVIDENCE_UNAVAILABLE);
    }
    const recovered = await recoverInterruptedPublication({ prepared, planned, evidence });
    if (recovered) return recovered;
    return executeFirstPublication({
      prepared: planned.publication,
      enumeration: (await enumerate([prepared.writer.syncPeerId])),
      authority,
      evidence,
      /* O1-T17: the ceremony request carries the LIVE session identity, read
       * at open time rather than cached, so a capability cannot be opened from
       * a webview that outlived a profile handover. */
      openLease: async (request) => {
        const session = await invoke(
          P02_DESKTOP_FIRST_PUBLICATION.COMMAND.RUNTIME_SESSION, {}
        );
        const bootId = clean(session?.bootId);
        if (!bootId) fail(P02_DESKTOP_FIRST_PUBLICATION_ERROR.RUNTIME_UNAVAILABLE);
        return invoke(P02_DESKTOP_FIRST_PUBLICATION.COMMAND.BEGIN, {
          request: { ...request, bootId }
        });
      },
      closeLease: (capability, outcome) =>
        invoke(P02_DESKTOP_FIRST_PUBLICATION.COMMAND.FINISH, { capability, outcome }),
      createTransport: (capability) => createLocalWriterTransportPrimitives({
        storage: createDesktopLocalWriterStorage({ invoke, capability }),
        ownedWriterSyncPeerId: prepared.writer.syncPeerId
      }),
      buildHead: (publication) => ({
        schema: SCHEMA.HEAD,
        objectDomain: publication.objectDomain,
        objectId: publication.objectId,
        objectKey: publication.objectKey,
        revisionId: publication.revisionId,
        revisionBlobSha256: publication.revisionBlobSha256,
        payloadSha256: publication.payloadSha256,
        previousRevisionId: publication.previousRevisionId,
        previousRevisionBlobSha256: publication.previousRevisionBlobSha256,
        writerSyncPeerId: prepared.writer.syncPeerId,
        /* Durable, from the projection. Never a clock: see canonicalObjectFor. */
        sourceUpdatedAtIso: requireSourceUpdatedAtIso(publication.objectId)
      }),
      cryptoImplementation
    });
  }

  return Object.freeze({ prepareCandidates, preparePlan, execute, healPublishedIdentity, resolveInvoke });
}

export { resolveInvoke };
