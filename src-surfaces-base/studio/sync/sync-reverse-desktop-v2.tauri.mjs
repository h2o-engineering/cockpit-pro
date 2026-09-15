/*
 * Minimal Desktop endpoint for Chrome -> Desktop P02.
 *
 * This module composes existing configured-peer storage, the shared v2 reader
 * and Receive core, Desktop branch admission, and the existing canonical
 * Desktop pull/import/proof/commit runtime. Receive and Apply are separate
 * trusted Human operations; importing the module starts neither.
 *
 * DOMAIN DISPATCH (P02 folder-relationship synchronization, T03). Every object
 * is identified by objectDomain + objectId, never objectId alone. Three
 * families are received here, each through its own branch-evidence admission
 * instance, its own domain-qualified sync_object_state row and its own
 * canonical anchor:
 *
 *   studio.chat.saved-state.v1     -> the accepted canonical chat runtime
 *                                     (projection anchor, importer, proof).
 *                                     Unchanged.
 *   studio.folder.v1               -> the relationship materializer, which
 *   studio.chat-folder-binding.v1     invokes only h2o_p02_relationship_apply.
 *
 * A chat object never reaches the relationship command; a folder or binding
 * object never reaches the chat importer. Any other advertised domain is
 * refused as unsupported and cannot influence the objects beside it.
 *
 * APPLY SEQUENCING. The historical endpoint required exactly one admitted
 * leaf in the whole repository. With three independent object families that
 * posture is replaced by the existing P02 scheduler: every admitted object is
 * enumerated and classified from its own state, exactly one runnable object is
 * selected per Apply attempt in the scheduler's deterministic order, the
 * selection is revalidated against fresh state, and only then is the one
 * domain-specific Apply executed. Ordering is a reproducibility device, never
 * conflict authority: a diverged object stays diverged-unresolved, a
 * dependency-blocked binding stays blocked(dependency), and neither can
 * corrupt another object's state.
 */
import { createP02ReceiveComposition }
  from '../core/sync-object-reconcile-v2.mjs';
import { classifyObjectState }
  from '../core/sync-object-classifier-v2.mjs';
import { createP02AnchorSet } from '../core/sync-p02-anchor-set-v2.mjs';
import { P02_ADMISSION_DISPOSITION } from '../core/sync-branch-evidence-v2.mjs';
import { evaluateFormatGate } from '../core/sync-format-gate-v2.mjs';
import { createLocalReaderTransportPrimitives }
  from '../browser-adapters/chrome/sync-reader-transport-v2.mjs';
import { objectKeyHex, writerKeyHex }
  from '../browser-adapters/chrome/sync-contract-v2.mjs';
import { createDesktopLocalWriterStorage }
  from './sync-writer-storage-desktop-v2.tauri.mjs';
import { createDesktopBranchEvidenceAdmission }
  from './sync-branch-evidence-desktop-v2.tauri.mjs';
import { createDesktopVerifiedTipMemo }
  from './sync-p02-tip-memo-desktop-v2.tauri.mjs';
import { P02ObjectScheduler, P02_RUNNABILITY, blockReasonOf, classificationRunnability }
  from '../core/sync-object-scheduler-v2.mjs';
import { P02_RELATIONSHIP_DOMAINS_V2, isRelationshipObjectDomain,
  validateRelationshipPayload }
  from '../core/sync-relationship-domains-v2.mjs';
import { P02_DESKTOP_RELATIONSHIP_V2,
  createDesktopRelationshipDependencyReader,
  createDesktopRelationshipMaterializer, createLibraryRefreshRequestPort }
  from './sync-relationship-materialization-desktop-v2.tauri.mjs';

export const P02_DESKTOP_REVERSE_V2 = Object.freeze({
  SCHEMA: 'h2o.studio.syncDesktopReverse.p02.v1',
  CONFIG_RESULT_SCHEMA: 'h2o.studio.syncConfiguredPeerWriteResult.v1',
  RECEIVE_RESULT_SCHEMA: 'h2o.studio.syncDesktopP02ReceiveResult.v1',
  APPLY_RESULT_SCHEMA: 'h2o.studio.syncDesktopP02ApplyResult.v1',
  CHAT_OBJECT_DOMAIN: 'studio.chat.saved-state.v1',
  FOLDER_OBJECT_DOMAIN: P02_RELATIONSHIP_DOMAINS_V2.FOLDER.OBJECT_DOMAIN,
  BINDING_OBJECT_DOMAIN: P02_RELATIONSHIP_DOMAINS_V2.BINDING.OBJECT_DOMAIN,
  /* Every family this endpoint receives and applies. Anything else advertised
   * by the peer is refused per object, never admitted as chat. */
  SUPPORTED_OBJECT_DOMAINS: Object.freeze([
    'studio.chat.saved-state.v1',
    P02_RELATIONSHIP_DOMAINS_V2.FOLDER.OBJECT_DOMAIN,
    P02_RELATIONSHIP_DOMAINS_V2.BINDING.OBJECT_DOMAIN
  ]),
  APPLY_SEQUENCING: 'deterministic-one-object-per-attempt',
  APPLY_SEQUENCER: 'p02-object-scheduler',
  RELATIONSHIP_COMMAND: P02_DESKTOP_RELATIONSHIP_V2.COMMAND,
  LIBRARY_REFRESH_PORT: P02_DESKTOP_RELATIONSHIP_V2.LIBRARY_REFRESH_EVENT,
  DB_URL: 'sqlite:studio-v1.db',
  /* The DEDICATED generation-authority reader. generation.json is not a J.1
   * generic-storage shape and must never be routed through one. */
  READ_GENERATION_AUTHORITY_COMMAND: 'h2o_p02_read_writer_generation_authority',
  GENERATION_AUTHORITY_SCHEMA: 'h2o.studio.syncWriterGenerationAuthority.p02.v1'
});

const HEX64 = /^[0-9a-f]{64}$/;
const clean = (value) => String(value == null ? '' : value).trim();
const strictId = (value) => typeof value === 'string' && value.length > 0 &&
  value.length <= 512 && value.trim() === value &&
  !/[\u0000-\u001f\u007f]/.test(value);
const fail = (code, detail = null) => {
  const error = new Error(code); error.code = code;
  /* RECEIVE_ERROR_OBSERVABILITY: a bounded predicate name only — never a
   * writer key, path, credential or raw configuration value. */
  if (detail) error.detail = String(detail);
  throw error;
};
const SYNC_MODE_OFF = 'off';
const SYNC_PEER_MODES = Object.freeze(['manual', 'notify', 'auto']);

function invokeFrom(scope) {
  if (typeof scope?.__TAURI_INTERNALS__?.invoke === 'function') {
    return scope.__TAURI_INTERNALS__.invoke.bind(scope.__TAURI_INTERNALS__);
  }
  if (typeof scope?.__TAURI__?.core?.invoke === 'function') {
    return scope.__TAURI__.core.invoke.bind(scope.__TAURI__.core);
  }
  if (typeof scope?.__TAURI__?.invoke === 'function') {
    return scope.__TAURI__.invoke.bind(scope.__TAURI__);
  }
  return null;
}

async function sha256HexText(value, cryptoImplementation) {
  const bytes = new TextEncoder().encode(value);
  const digest = await cryptoImplementation.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function configResult(outcome, extra = {}) {
  return Object.freeze({
    schema: P02_DESKTOP_REVERSE_V2.CONFIG_RESULT_SCHEMA,
    ok: outcome === 'configured' || outcome === 'already-configured',
    outcome, ...extra
  });
}

export function createDesktopP02ReverseRuntime({
  invoke,
  configOwner,
  localIdentity,
  canonicalApply,
  cryptoImplementation = globalThis.crypto,
  clock = () => new Date().toISOString(),
  /* T03 seams. The Library refresh port is the one canonical Library-owned
   * refresh request; the dependency reader is the blockStateReader-shaped
   * seam consulted at classification time and again at Apply time. Both
   * default to the production adapters below and are injectable so a
   * disposable proof can observe them without a window or a live store. */
  libraryRefresh = null,
  dependencyReader = null,
  relationshipMaterializer = null
} = {}) {
  if (typeof invoke !== 'function' ||
      typeof configOwner?.getConfig !== 'function' ||
      typeof configOwner?.setConfig !== 'function' ||
      typeof configOwner?.mutateCanonicalConfig !== 'function' ||
      typeof localIdentity !== 'function' ||
      typeof canonicalApply?.applyNextAdmittedP02Revision !== 'function' ||
      typeof cryptoImplementation?.subtle?.digest !== 'function') {
    fail('p02-desktop-reverse-dependency-invalid');
  }
  const sql = Object.freeze({
    select: (query, values = []) => invoke('plugin:sql|select', {
      db: P02_DESKTOP_REVERSE_V2.DB_URL, query, values
    }),
    execute: (query, values = []) => invoke('plugin:sql|execute', {
      db: P02_DESKTOP_REVERSE_V2.DB_URL, query, values
    })
  });
  const storage = createDesktopLocalWriterStorage({ invoke, capability: null });
  const reader = createLocalReaderTransportPrimitives({
    storage, cryptoImplementation
  });
  const tipMemo = createDesktopVerifiedTipMemo({ sql, clock: () => Date.now() });
  let configInFlight = false;
  let receiveInFlight = false;
  let applyInFlight = false;
  let applySelection = null;
  let lastReceive = null;
  let lastApply = null;

  async function localPeerId() {
    /* Any failure to RESOLVE the local identity - unavailable, malformed, or a
     * rejection from the identity owner - is one typed boundary, so callers can
     * report it as such instead of guessing. Validation is unchanged: the peer
     * id must still be a strict, non-empty identifier. */
    let value;
    try {
      value = await localIdentity();
    } catch (_) {
      fail('p02-desktop-local-identity-invalid');
    }
    const id = clean(value?.syncPeerId);
    if (!strictId(id)) fail('p02-desktop-local-identity-invalid');
    return id;
  }

  /* RECEIVE_ERROR_OBSERVABILITY: the outcome code is unchanged; each refusal
   * now names the failing predicate as a redacted `detail`.
   * MODE_VOCABULARY_ALIGNMENT: an explicit `off` mode is reported as its
   * own fail-closed outcome instead of masquerading as a peer defect. */
  const PEER_INVALID = 'p02-desktop-configured-chrome-peer-invalid';
  async function configuredChromePeer() {
    const config = await configOwner.getConfig();
    if (!config) fail(PEER_INVALID, 'config-absent');
    if (config.schemaVersion !== 1) fail(PEER_INVALID, 'config-schema-version');
    if (config.mode === SYNC_MODE_OFF) fail('sync-mode-off', 'config-mode-off');
    if (!SYNC_PEER_MODES.includes(config.mode)) fail(PEER_INVALID, 'config-mode-invalid');
    if (!Array.isArray(config.configuredPeers)) fail(PEER_INVALID, 'configured-peers-shape');
    if (config.configuredPeers.length !== 1) fail(PEER_INVALID,
      config.configuredPeers.length === 0 ? 'configured-peers-empty' : 'configured-peers-count');
    const peer = config.configuredPeers[0];
    if (!peer || Object.keys(peer).sort().join(',') !== 'syncPeerId,writerKey') {
      fail(PEER_INVALID, 'peer-shape');
    }
    if (!strictId(peer.syncPeerId)) fail(PEER_INVALID, 'peer-sync-peer-id');
    if (!HEX64.test(peer.writerKey || '')) fail(PEER_INVALID, 'peer-writer-key-format');
    if (peer.syncPeerId === await localPeerId()) fail(PEER_INVALID, 'peer-is-self');
    if (peer.writerKey !== await writerKeyHex(peer.syncPeerId, cryptoImplementation)) {
      fail(PEER_INVALID, 'peer-writer-key-mismatch');
    }
    return Object.freeze({ syncPeerId: peer.syncPeerId, writerKey: peer.writerKey });
  }

  async function configureChromePeer({ syncPeerId, writerKey } = {}) {
    if (configInFlight) return configResult('busy');
    configInFlight = true;
    try {
      if (!strictId(syncPeerId)) return configResult('invalid-peer');
      if (!HEX64.test(writerKey || '')) return configResult('invalid-writer-key');
      if (syncPeerId === await localPeerId()) return configResult('self-peer');
      if (writerKey !== await writerKeyHex(syncPeerId, cryptoImplementation)) {
        return configResult('writer-key-mismatch');
      }
      const mutation = await configOwner.mutateCanonicalConfig(async (before) => {
        if (before && before.schemaVersion === 1 && before.mode === SYNC_MODE_OFF) {
          return { write: false, outcome: 'sync-mode-off' };
        }
        if (!before || before.schemaVersion !== 1 ||
            !SYNC_PEER_MODES.includes(before.mode) ||
            !Array.isArray(before.configuredPeers)) {
          return { write: false, outcome: 'authority-unavailable' };
        }
        if (before.configuredPeers.length > 0) {
          const same = before.configuredPeers.length === 1 &&
            before.configuredPeers[0]?.syncPeerId === syncPeerId &&
            before.configuredPeers[0]?.writerKey === writerKey;
          return { write: false,
            outcome: same ? 'already-configured' : 'authority-conflict' };
        }
        /* Repeat identity authority inside the shared decision boundary so a
         * queued action never relies on pre-boundary trust state. */
        if (syncPeerId === await localPeerId() ||
            writerKey !== await writerKeyHex(syncPeerId, cryptoImplementation)) {
          return { write: false, outcome: 'authority-conflict' };
        }
        return { write: true, outcome: 'configured',
          patch: { configuredPeers: [{ syncPeerId, writerKey }] } };
      });
      return configResult(mutation?.outcome || 'persistence-failed',
        mutation?.outcome === 'configured' ? { syncPeerId, writerKey } : {});
    } catch (error) {
      const code = error?.code;
      /* A local-identity resolution failure is not a persistence failure. The
       * panel already speaks this outcome; collapsing it into persistence-failed
       * is what made a pure identity defect look like a failed config write.
       * Only the typed identity boundary maps here - nothing else. */
      if (code === 'p02-desktop-local-identity-invalid') {
        return configResult('local-identity-unavailable');
      }
      /* The CAS read-back is raised by the canonical storage layer as
       * canonical-storage-cas-readback-mismatch; the other config owner raises
       * canonical-sync-config-readback-mismatch. Either is the same condition
       * for this caller, and neither taxonomy is renamed. */
      return configResult(
        code === 'canonical-storage-cas-readback-mismatch' ||
        code === 'canonical-sync-config-readback-mismatch'
          ? 'readback-mismatch' : 'persistence-failed'
      );
    } finally { configInFlight = false; }
  }

  async function libraryInfo() {
    const observed = await invoke('h2o_p02_read_library_authority', {});
    if (observed?.present !== true || observed?.readable !== true ||
        typeof observed.canonicalBytes !== 'string') {
      fail('p02-desktop-library-authority-invalid');
    }
    let value;
    try { value = JSON.parse(observed.canonicalBytes); }
    catch (_) { fail('p02-desktop-library-authority-invalid'); }
    const gate = evaluateFormatGate({ libraryInfo: value, repositoryHasContent: true });
    if (gate.mayRead !== true) fail('p02-desktop-library-authority-invalid');
    return value;
  }

  /*
   * The peer's generation record, read through its DEDICATED authority command.
   *
   * It must NOT go through the generic storage reader: the frozen J.1 path
   * whitelist admits only state.json and its pending form, so
   * writers/<writerKey>/generation.json was rejected outright - before Receive
   * could compose anything - and the untyped refusal collapsed to a bare
   * `receive-failed`. Routing the document type at its own reader fixes that
   * without touching the J.1 contract.
   *
   * The acceptance set is exactly what the generic-reader path enforced.
   * `state === 'p02'` is the reader's verdict over the same two constants this
   * function used to assert itself (schema h2o.studio.syncWriterGeneration.p02.v1
   * and generation p02), and `documentWriterKey` is what the RECORD declares
   * about itself. The response's own `writerKey` is only the echoed request
   * argument, so it is evidence about the caller and never about the document -
   * comparing it here would assert nothing.
   *
   * documentWriterKey is compared STRICTLY. The generic-reader path this
   * replaced tested the parsed document's field with ===, so a declaration of
   * " <key> " was a mismatch and refused. Normalising it here - trimming, or
   * lowercasing - would admit records the parent rejected, which is an
   * acceptance-set widening however cosmetic the difference looks. A writer key
   * is a 64-character lowercase hex identity, not free text: the record either
   * declares exactly the configured writer or it does not.
   */
  async function requirePeerGeneration(peer) {
    let authority;
    try {
      authority = await invoke(
        P02_DESKTOP_REVERSE_V2.READ_GENERATION_AUTHORITY_COMMAND,
        { writerKey: peer.writerKey });
    } catch (_) {
      fail('p02-desktop-peer-generation-invalid');
    }
    if (clean(authority?.schema) !== P02_DESKTOP_REVERSE_V2.GENERATION_AUTHORITY_SCHEMA ||
        clean(authority?.state) !== 'p02' ||
        authority?.documentWriterKey !== peer.writerKey) {
      fail('p02-desktop-peer-generation-invalid');
    }
    return authority;
  }

  const peerObjectKeyFor = (writerSyncPeerId, objectKey) =>
    sha256HexText(`${writerSyncPeerId}\u0000${objectKey}`, cryptoImplementation);

  /*
   * Branch admission is DOMAIN-DISPATCHED. The Desktop admission adapter tags
   * every retained document with the domain it was constructed for, so one
   * instance per supported family keeps a folder revision from ever being
   * labelled chat evidence. Evidence rows stay object-scoped by
   * peer_object_key, which already encodes the domain through the objectKey.
   */
  const { SUPPORTED_OBJECT_DOMAINS, CHAT_OBJECT_DOMAIN } = P02_DESKTOP_REVERSE_V2;
  const admissions = new Map();
  function admissionFor(objectDomain) {
    const domain = clean(objectDomain);
    if (!SUPPORTED_OBJECT_DOMAINS.includes(domain)) {
      fail('p02-desktop-object-domain-unsupported', domain || 'object-domain-absent');
    }
    let admission = admissions.get(domain);
    if (!admission) {
      admission = createDesktopBranchEvidenceAdmission({
        sql, clock, peerObjectKeyFor, objectDomain: domain
      });
      admissions.set(domain, admission);
    }
    return admission;
  }
  const branchAdmission = admissionFor(CHAT_OBJECT_DOMAIN);

  /* T03 relationship adapters: the dependency reader (blockStateReader seam)
   * and the materializer that invokes the one ratified command. */
  const dependencies = dependencyReader || createDesktopRelationshipDependencyReader({ sql });
  const materializer = relationshipMaterializer || createDesktopRelationshipMaterializer({
    invoke, sql, localPeerId, dependencyReader: dependencies, libraryRefresh, clock
  });
  if (typeof dependencies?.readDependencyState !== 'function' ||
      typeof materializer?.applyRelationshipRevision !== 'function') {
    fail('p02-desktop-reverse-dependency-invalid');
  }

  /*
   * The canonical local head, by domain. Chat: the accepted v1 projection
   * anchor. Relationship families have no Desktop projection in this slice
   * (direction coverage is Chrome -> Desktop only), so their canonical head IS
   * the applied P02 anchor recorded in the domain-qualified protocol row: an
   * object with no applied anchor is remote-first, an object whose admitted
   * leaf equals its applied anchor is converged, and a proven descendant of
   * the anchor is remote-ahead.
   */
  async function canonicalLocalHeadFor(objectDomain, objectId) {
    if (objectDomain === CHAT_OBJECT_DOMAIN) {
      try {
        const canonical = await canonicalApply.resolveCanonicalAnchor(objectId);
        if (canonical?.revisionId && canonical?.revisionBlobSha256Hex) {
          return {
            revisionId: canonical.revisionId,
            revisionBlobSha256: canonical.revisionBlobSha256Hex,
            ...(canonical.payloadSha256Hex
              ? { payloadSha256: canonical.payloadSha256Hex } : {}),
            deleted: false
          };
        }
      } catch (_) { /* Absent canonical content is a valid remote-first case. */ }
      return null;
    }
    const state = await protocolState(objectId, objectDomain);
    const applied = state?.lastApplied;
    if (applied && strictId(applied.revisionId) && HEX64.test(applied.revisionBlobSha256 || '')) {
      return {
        revisionId: applied.revisionId,
        revisionBlobSha256: applied.revisionBlobSha256,
        ...(HEX64.test(applied.payloadSha256 || '') ? { payloadSha256: applied.payloadSha256 } : {}),
        deleted: false
      };
    }
    return null;
  }

  /*
   * Read and validate the admitted leaf a relationship object would apply.
   * Verified bytes from the repository, the exact admitted address, and the
   * strict T01 payload contract - or a typed refusal, never a guess.
   */
  async function readRelationshipLeaf({ peer, objectDomain, objectId, objectKey, revisionId }) {
    const retained = await admissionFor(objectDomain).retainedFor({
      writerSyncPeerId: peer.syncPeerId, objectKey
    });
    const record = retained.find((item) => item.document.revisionId === revisionId) || null;
    if (!record) return { status: 'leaf-not-retained' };
    let revision;
    try {
      revision = await reader.readRevision({
        objectDomain, objectId, objectKey, revisionBlobSha256: record.revisionBlobSha256
      });
    } catch (error) {
      return { status: 'revision-unreadable', reason: clean(error?.code) || 'revision-read-failed' };
    }
    if (revision?.status !== 'verified' ||
        revision.value?.writerSyncPeerId !== peer.syncPeerId ||
        revision.value?.revisionId !== revisionId) {
      return { status: 'revision-unreadable', reason: 'admitted-revision-invalid' };
    }
    let canonical;
    try {
      canonical = validateRelationshipPayload(objectDomain, revision.value.payload, objectId);
    } catch (error) {
      return { status: 'payload-invalid', reason: clean(error?.code) || 'relationship-payload-invalid' };
    }
    return {
      status: 'verified',
      leaf: Object.freeze({
        revisionId,
        revisionBlobSha256: record.revisionBlobSha256,
        payloadSha256: revision.value.payloadSha256
      }),
      revision: revision.value,
      canonical
    };
  }

  /*
   * Dependency readiness for one relationship object's apply candidate. This
   * is the classification-time consultation of the blockStateReader seam; the
   * materializer repeats it immediately before the command runs.
   */
  async function relationshipDependencyFor({ peer, objectDomain, objectId, objectKey, revisionId }) {
    const read = await readRelationshipLeaf({ peer, objectDomain, objectId, objectKey, revisionId });
    if (read.status !== 'verified') return { status: read.status, reason: read.reason ?? null };
    const dependency = await dependencies.readDependencyState({
      objectDomain, objectId, canonical: read.canonical
    });
    return { status: 'evaluated', dependency, leaf: read.leaf, canonical: read.canonical };
  }

  /*
   * One classifier for every family. Graph semantics stay in the canonical
   * classifier; this adapter supplies the domain's evidence, the domain's
   * canonical head and - for relationship objects that would otherwise be
   * runnable - the dependency block reason. The scheduler-visible class is
   * exactly blocked(dependency); the typed detail rides beside it.
   */
  async function classifyDomainObject({
    peer, objectDomain, objectId, objectKey, advertisedTips, protocolState: state, p02AnchorSet
  }) {
    const retained = await admissionFor(objectDomain).retainedFor({
      writerSyncPeerId: peer.syncPeerId, objectKey
    });
    const canonicalLocalHead = await canonicalLocalHeadFor(objectDomain, objectId);
    /*
     * Evidence validity, by family. The accepted chat mapping is unchanged:
     * only accepted-linear and admitted-closure rows count as validated. A
     * relationship record is validated by its immutable verified bytes - the
     * same rule the shared branch index applies - so that a retained sibling
     * fork is classified as what it is, two live leaves = diverged-unresolved,
     * and never as a transport gap. Quarantined records are never validated.
     */
    const validatedFor = (record) => objectDomain === CHAT_OBJECT_DOMAIN
      ? (record.disposition === P02_ADMISSION_DISPOSITION.ACCEPTED_LINEAR ||
          record.disposition === P02_ADMISSION_DISPOSITION.ADMITTED_CLOSURE)
      : record.disposition !== P02_ADMISSION_DISPOSITION.QUARANTINED;
    const descriptor = {
      canonicalLocalHead,
      p02AnchorSet,
      protocolState: state,
      retainedEvidence: retained.map((record) => ({
        ...record,
        validated: validatedFor(record)
      })),
      advertisedTips,
      dirty: false,
      publishable: false,
      pending: false,
      integrityQuarantined: retained.some((record) =>
        record.disposition === P02_ADMISSION_DISPOSITION.QUARANTINED)
    };
    const verdict = classifyObjectState(descriptor);
    if (!isRelationshipObjectDomain(objectDomain) ||
        verdict.classification !== 'remote-ahead' ||
        !strictId(verdict.applyCandidateRevisionId || '')) {
      return Object.freeze({ ...verdict, objectDomain, objectId, dependency: null });
    }
    const evaluated = await relationshipDependencyFor({
      peer, objectDomain, objectId, objectKey, revisionId: verdict.applyCandidateRevisionId
    });
    if (evaluated.status === 'payload-invalid') {
      return Object.freeze({
        ...classifyObjectState({ ...descriptor, integrityQuarantined: true }),
        reason: evaluated.reason, objectDomain, objectId, dependency: null
      });
    }
    if (evaluated.status !== 'evaluated') {
      return Object.freeze({
        ...classifyObjectState({ ...descriptor, blockReason: 'transport' }),
        reason: evaluated.reason || evaluated.status, objectDomain, objectId, dependency: null
      });
    }
    if (evaluated.dependency.ready !== true) {
      return Object.freeze({
        ...classifyObjectState({ ...descriptor, blockReason: P02_DESKTOP_RELATIONSHIP_V2.BLOCK_REASON }),
        objectDomain, objectId,
        applyCandidateRevisionId: verdict.applyCandidateRevisionId,
        dependency: evaluated.dependency,
        dependencyDetail: evaluated.dependency.detail
      });
    }
    return Object.freeze({ ...verdict, objectDomain, objectId, dependency: evaluated.dependency });
  }

  /* v23: sync_object_state is keyed by (sync_peer_id, object_domain,
   * object_id). This composition receives the saved-chat family, so the
   * protocol row defaults to the chat domain and a chat-folder-binding row
   * that shares the objectId string is never read as chat anchors. */
  async function protocolState(objectId, objectDomain = P02_DESKTOP_REVERSE_V2.CHAT_OBJECT_DOMAIN) {
    const rows = await sql.select(
      'SELECT last_published_revision_id, last_published_revision_blob_sha256, '
      + 'last_published_payload_sha256, last_applied_revision_id, '
      + 'last_applied_revision_blob_sha256, last_applied_payload_sha256, '
      + 'last_converged_direction FROM sync_object_state '
      + 'WHERE sync_peer_id = ? AND object_domain = ? AND object_id = ? LIMIT 1',
      [await localPeerId(), objectDomain, objectId]);
    const row = Array.isArray(rows) ? rows[0] : null;
    if (!row) return {};
    return {
      convergedDirection: clean(row.last_converged_direction) || null,
      lastPublished: clean(row.last_published_revision_id) ? {
        revisionId: clean(row.last_published_revision_id),
        revisionBlobSha256: clean(row.last_published_revision_blob_sha256),
        payloadSha256: clean(row.last_published_payload_sha256)
      } : null,
      lastApplied: clean(row.last_applied_revision_id) ? {
        revisionId: clean(row.last_applied_revision_id),
        revisionBlobSha256: clean(row.last_applied_revision_blob_sha256),
        payloadSha256: clean(row.last_applied_payload_sha256)
      } : null
    };
  }

  async function buildReceive(peer, authority) {
    return createP02ReceiveComposition({
      configuredPeers: async () => [peer],
      readWriterState: () => reader.readWriterState({ writerSyncPeerId: peer.syncPeerId }),
      readRevisionBytes: (input) => reader.readRevision(input),
      fetchAncestry: (input) => reader.fetchAncestry(input),
      /* Every port below dispatches on the tip's own objectDomain. The core
       * carries the domain as data; this composition is where it is bound to
       * the domain's admission, anchor and protocol row. */
      readAdmittedEvidence: async ({ objectDomain, objectKey }) => {
        const rows = await admissionFor(objectDomain).retainedFor({
          writerSyncPeerId: peer.syncPeerId, objectKey
        });
        return rows.map((row) => ({
          revisionId: row.document.revisionId,
          revisionBlobSha256: row.revisionBlobSha256,
          disposition: row.disposition
        }));
      },
      admitRevision: async (input) => admissionFor(input.objectDomain).admitRevision({
        objectId: input.objectId,
        objectKey: input.objectKey,
        writerSyncPeerId: peer.syncPeerId,
        revision: input.revision,
        revisionBlobSha256: input.revisionBlobSha256,
        revisionBytes: input.revisionBlobBytes?.byteLength ?? 0,
        protocolState: input.protocolState,
        libraryInfo: authority,
        repositoryHasContent: true,
        legacyBaselineMatches: true
      }),
      /* Keep graph semantics in the canonical classifier. This adapter only
       * supplies the domain's Desktop evidence, canonical anchor and - for
       * relationship objects - dependency readiness. */
      classifyObject: (input) => classifyDomainObject({
        peer,
        objectDomain: input.objectDomain,
        objectId: input.objectId,
        objectKey: input.objectKey,
        advertisedTips: input.advertisedTips,
        protocolState: input.protocolState,
        p02AnchorSet: input.p02AnchorSet
      }),
      anchorSetFor: async ({ objectDomain, objectId }) => createP02AnchorSet({
        objectDomain,
        objectId,
        protocolState: await protocolState(objectId, objectDomain)
      }),
      readTipMemo: (input) => tipMemo.read(input),
      writeTipMemo: (input) => tipMemo.record(input),
      /*
       * The receive-side apply authority. Apply itself stays a separate Human
       * operation (receivePass executes nothing); this seam only decides
       * whether the handoff is ELIGIBLE. Chat objects are eligible as before;
       * a relationship object is eligible only when its dependencies exist,
       * and otherwise refuses with the canonical dependency block.
       */
      applyAuthority: async ({ objectDomain, objectId, objectKey, candidate }) => {
        if (!isRelationshipObjectDomain(objectDomain)) {
          return Object.freeze({ permitted: true, reason: null });
        }
        const evaluated = await relationshipDependencyFor({
          peer, objectDomain, objectId, objectKey, revisionId: clean(candidate?.revisionId)
        });
        if (evaluated.status !== 'evaluated') {
          return Object.freeze({
            permitted: false,
            reason: evaluated.reason || evaluated.status,
            blockReason: evaluated.status === 'payload-invalid' ? null : 'transport'
          });
        }
        if (evaluated.dependency.ready !== true) {
          return Object.freeze({
            permitted: false,
            reason: `dependency-${evaluated.dependency.detail}`,
            blockReason: evaluated.dependency.blockReason,
            dependencyDetail: evaluated.dependency.detail
          });
        }
        return Object.freeze({ permitted: true, reason: null });
      },
      protocolStateFor: ({ objectDomain, objectId }) => protocolState(objectId, objectDomain)
    });
  }

  const SELECT_RETAINED_LEAVES =
    'SELECT object_id, revision_id, revision_blob_sha256_hex, '
    + 'parent_revision_id, parent_revision_blob_sha256_hex, peer_object_key, '
    + 'branch_disposition, proven '
    + "FROM sync_branch_evidence_state WHERE branch_disposition <> 'quarantined' "
    + 'ORDER BY object_id, revision_id';
  const isProvenLinear = (row) =>
    clean(row.branch_disposition) === P02_ADMISSION_DISPOSITION.ACCEPTED_LINEAR &&
    Number(row.proven) === 1;

  /*
   * Every admitted object the configured peer currently advertises, grouped
   * by (objectDomain, objectId) and matched to the retained Desktop evidence
   * rows that carry its advertised tips (every non-quarantined disposition;
   * the proven accepted-linear subset is kept beside them). This replaces the
   * historical single-leaf posture: several independently admitted objects
   * are normal, each stays isolated, the canonical classifier decides what
   * each one is, and the scheduler decides which ONE runs. A head whose
   * objectKey does not equal the key derived from its own domain and id is an
   * identity mismatch and is ignored; a head in a domain this endpoint does
   * not support is reported and never admitted as anything else.
   */
  async function enumerateAdmittedObjects(peer) {
    const state = await reader.readWriterState({ writerSyncPeerId: peer.syncPeerId });
    if (state?.status !== 'verified') fail('p02-desktop-chrome-writer-state-invalid');
    const rows = await sql.select(SELECT_RETAINED_LEAVES, []);
    const groups = new Map();
    const unsupported = [];
    for (const head of state.snapshot?.heads || []) {
      if (head.writerSyncPeerId !== peer.syncPeerId) continue;
      const objectDomain = clean(head.objectDomain);
      const objectId = clean(head.objectId);
      if (!SUPPORTED_OBJECT_DOMAINS.includes(objectDomain)) {
        unsupported.push(Object.freeze({ objectDomain, objectId }));
        continue;
      }
      const objectKey = await objectKeyHex(objectDomain, objectId, cryptoImplementation);
      if (head.objectKey !== objectKey) continue;
      const groupKey = `${objectDomain}\u0000${objectId}`;
      const group = groups.get(groupKey) || {
        objectDomain, objectId, objectKey,
        peerObjectKey: await peerObjectKeyFor(peer.syncPeerId, objectKey),
        heads: [], leaves: []
      };
      group.heads.push(head);
      groups.set(groupKey, group);
    }
    const objects = [];
    const unadmitted = [];
    for (const group of groups.values()) {
      group.leaves = (Array.isArray(rows) ? rows : []).filter((row) =>
        row.peer_object_key === group.peerObjectKey &&
        group.heads.some((head) => head.revisionId === row.revision_id &&
          head.revisionBlobSha256 === row.revision_blob_sha256_hex));
      if (group.leaves.length === 0) {
        unadmitted.push(Object.freeze({ objectDomain: group.objectDomain, objectId: group.objectId }));
        continue;
      }
      const leaves = group.leaves.map((row) => Object.freeze({ ...row }));
      objects.push(Object.freeze({
        ...group,
        heads: Object.freeze(group.heads.map((head) => Object.freeze({ ...head }))),
        leaves: Object.freeze(leaves),
        /* The proven accepted-linear subset: the leaf authority the operator
         * report counts, and the leaf a converged object is reported by. */
        provenLeaves: Object.freeze(leaves.filter(isProvenLinear))
      }));
    }
    /* Deterministic, reproducible order: domain, then objectId, then key. */
    objects.sort((left, right) =>
      left.objectDomain.localeCompare(right.objectDomain) ||
      left.objectId.localeCompare(right.objectId) ||
      left.objectKey.localeCompare(right.objectKey));
    return Object.freeze({
      state,
      objects: Object.freeze(objects),
      unadmitted: Object.freeze(unadmitted),
      unsupported: Object.freeze(unsupported)
    });
  }

  /* DESKTOP_APPLY_CANDIDATE_REPORTING: the operator-facing candidate list is
   * the proven accepted-linear Desktop leaf authority - the same selection
   * Apply itself sequences - not the core handoff's eligibility list. One
   * entry per admitted object, in the deterministic Apply order. */
  async function provenApplyCandidates(peer) {
    let enumeration;
    try {
      enumeration = await enumerateAdmittedObjects(peer);
    } catch (error) {
      if (clean(error?.code) === 'p02-desktop-chrome-writer-state-invalid') return Object.freeze([]);
      throw error;
    }
    return Object.freeze(enumeration.objects
      .filter((object) => object.provenLeaves.length > 0)
      .map((object) => Object.freeze({
        objectDomain: object.objectDomain,
        objectId: object.objectId,
        objectKey: object.objectKey,
        revisionId: object.provenLeaves[0].revision_id,
        revisionBlobSha256Hex: object.provenLeaves[0].revision_blob_sha256_hex,
        leafCount: object.provenLeaves.length,
        retainedLeafCount: object.leaves.length,
        branchDisposition: P02_ADMISSION_DISPOSITION.ACCEPTED_LINEAR,
        proven: true
      })));
  }

  /*
   * The scheduler descriptor for one admitted object. It carries identity and
   * the object's advertised tips; everything the classifier needs beyond that
   * is re-read from canonical state at classification time.
   */
  function schedulerDescriptor(object) {
    return Object.freeze({
      objectDomain: object.objectDomain,
      objectId: object.objectId,
      objectKey: object.objectKey,
      advertisedTips: object.heads.map((head) => Object.freeze({
        revisionId: head.revisionId, revisionBlobSha256: head.revisionBlobSha256
      })),
      leaves: object.leaves
    });
  }

  async function classifyDescriptor(peer, descriptor) {
    const state = await protocolState(descriptor.objectId, descriptor.objectDomain);
    return classifyDomainObject({
      peer,
      objectDomain: descriptor.objectDomain,
      objectId: descriptor.objectId,
      objectKey: descriptor.objectKey,
      advertisedTips: descriptor.advertisedTips,
      protocolState: state,
      p02AnchorSet: createP02AnchorSet({
        objectDomain: descriptor.objectDomain,
        objectId: descriptor.objectId,
        protocolState: state
      })
    });
  }

  /* Scheduler outcome vocabulary for the accepted chat runtime's result. */
  function chatAttemptResult(result) {
    if (result?.ok === true && result?.unchangedNoOp === true) {
      return { outcome: 'no-effect', reason: 'already-applied', blockReason: null, chat: result };
    }
    if (result?.ok === true) return { outcome: 'progress', reason: null, blockReason: null, chat: result };
    return { ...result, chat: result };
  }

  /* A thrown Apply keeps its typed identity for the operator result; the
   * scheduler records it as a transient (or integrity) attempt. */
  function thrownAttemptResult(error) {
    const code = clean(error?.code || error?.message) || 'apply-failed';
    return {
      outcome: code === 'canonical-state-contradiction' ? 'integrity' : 'transient',
      reason: code,
      blockReason: null,
      thrown: error
    };
  }

  /*
   * Execute exactly one selected object. Domain dispatch is the ONLY branch
   * here: chat goes to the accepted canonical runtime, relationship families
   * go to the materializer. Neither path can reach the other.
   */
  async function executeSelected(peer, candidate, fresh) {
    const objectDomain = clean(candidate.objectDomain);
    try {
      if (objectDomain === CHAT_OBJECT_DOMAIN) {
        const result = await canonicalApply.applyNextAdmittedP02Revision(candidate.objectId);
        return chatAttemptResult(result);
      }
      if (!isRelationshipObjectDomain(objectDomain)) {
        fail('p02-desktop-object-domain-unsupported', objectDomain);
      }
      const revisionId = clean(fresh?.applyCandidateRevisionId);
      if (!revisionId) fail('p02-desktop-relationship-candidate-missing');
      const read = await readRelationshipLeaf({
        peer, objectDomain, objectId: candidate.objectId, objectKey: candidate.objectKey, revisionId
      });
      if (read.status !== 'verified') {
        return {
          outcome: read.status === 'payload-invalid' ? 'integrity' : 'blocked',
          reason: read.reason || read.status,
          blockReason: read.status === 'payload-invalid' ? null : 'transport'
        };
      }
      const result = await materializer.applyRelationshipRevision({
        objectDomain, objectId: candidate.objectId, objectKey: candidate.objectKey,
        leaf: read.leaf, revision: read.revision
      });
      return { ...result.attempt, relationship: result };
    } catch (error) {
      return thrownAttemptResult(error);
    }
  }

  function thrownApplyResult({ objectDomain, objectId, thrown, applySequencing }) {
    const invoked = thrown?.importerInvoked === true;
    return applyResult({
      ok: false,
      outcome: clean(thrown?.code) || 'apply-failed',
      detail: clean(thrown?.detail) || null,
      objectDomain,
      objectId,
      canonicalImportAttempts: invoked ? 1 : 0,
      importerInvoked: invoked,
      convergedDirection: null,
      applySequencing
    });
  }

  const applyResult = (fields) => Object.freeze({
    schema: P02_DESKTOP_REVERSE_V2.APPLY_RESULT_SCHEMA,
    publicationReachable: false,
    repositoryWrites: 0,
    webdavReachable: false,
    ...fields
  });

  /* The accepted chat Apply result shape, unchanged, plus the domain. */
  function chatApplyResult({ objectId, revisionId, result }) {
    const ok = result?.ok === true && result?.convergenceVerified === true;
    const outcome = ok
      ? (result.unchangedNoOp ? 'already-applied' : 'applied')
      : clean(result?.errorCode) || 'apply-failed';
    return applyResult({
      ok,
      outcome,
      objectDomain: CHAT_OBJECT_DOMAIN,
      objectId,
      revisionId,
      /* APPLY_RESULT_REPORTING: attempts count importer invocations, never
       * successes; importerInvoked is the runtime's own truthful flag. */
      canonicalImportAttempts: result?.importerInvoked === true ? 1 : 0,
      importerInvoked: result?.importerInvoked === true,
      convergedDirection: ok ? 'applied' : null,
      result
    });
  }

  function relationshipApplyResult({ objectDomain, objectId, result }) {
    const ok = result?.ok === true;
    return applyResult({
      ok,
      outcome: ok ? result.outcome : (clean(result?.outcome) || 'apply-failed'),
      detail: result?.dependencyDetail ?? result?.errorCode ?? null,
      objectDomain,
      objectId,
      revisionId: result?.revisionId ?? null,
      canonicalImportAttempts: 0,
      importerInvoked: false,
      convergedDirection: ok ? 'applied' : null,
      relationshipCommand: P02_DESKTOP_RELATIONSHIP_V2.COMMAND,
      commandInvoked: result?.commandInvoked === true,
      kind: result?.kind ?? null,
      materialization: result?.materialization ?? null,
      relationshipSqliteWrites: result?.relationshipSqliteWrites ?? 0,
      bookkeepingWrites: result?.bookkeepingWrites ?? 0,
      blockReason: result?.blockReason ?? null,
      dependencyDetail: result?.dependencyDetail ?? null,
      libraryRefresh: result?.libraryRefresh ?? null,
      result
    });
  }

  async function receiveFromChrome() {
    if (receiveInFlight || applyInFlight) return Object.freeze({
      schema: P02_DESKTOP_REVERSE_V2.RECEIVE_RESULT_SCHEMA,
      ok: false, outcome: 'busy'
    });
    receiveInFlight = true;
    try {
      const peer = await configuredChromePeer();
      await requirePeerGeneration(peer);
      const authority = await libraryInfo();
      const report = await (await buildReceive(peer, authority)).receivePass({
        objectDomain: P02_DESKTOP_REVERSE_V2.CHAT_OBJECT_DOMAIN
      });
      const integrity = report.objects?.some((item) => item.result?.outcome === 'integrity');
      const blocked = report.globalFailure ||
        report.objects?.some((item) => ['blocked', 'indeterminate', 'transient']
          .includes(item.result?.outcome));
      const applyCandidates = await provenApplyCandidates(peer);
      const outcome = integrity ? 'integrity' : blocked ? 'blocked' : 'completed';
      lastReceive = Object.freeze({ outcome, detail: null });
      return Object.freeze({
        schema: P02_DESKTOP_REVERSE_V2.RECEIVE_RESULT_SCHEMA,
        ok: !integrity && !blocked,
        outcome,
        detail: null,
        peerSyncPeerId: peer.syncPeerId,
        admittedCount: (report.objects || []).filter((item) =>
          item.result?.outcome === 'progress').length,
        /* Domain coverage of this pass: every received object keeps its own
         * objectDomain beside its objectId in the report. */
        receivedObjectDomains: Object.freeze([...new Set((report.objects || [])
          .map((item) => clean(item.objectDomain)).filter(Boolean))].sort()),
        report: Object.freeze({ ...report, applyCandidates }),
        applyExecuted: false,
        webdavReachable: false
      });
    } catch (error) {
      const outcome = clean(error?.code) || 'receive-failed';
      const detail = clean(error?.detail) || null;
      lastReceive = Object.freeze({ outcome, detail });
      return Object.freeze({
        schema: P02_DESKTOP_REVERSE_V2.RECEIVE_RESULT_SCHEMA,
        ok: false, outcome, detail,
        applyExecuted: false, webdavReachable: false
      });
    } finally { receiveInFlight = false; }
  }

  async function selectedAdmittedLeaf(peer, objectId = null) {
    const values = [];
    let where = "WHERE branch_disposition = 'accepted-linear' AND proven = 1";
    if (objectId) { where += ' AND object_id = ?'; values.push(objectId); }
    const rows = await sql.select(
      'SELECT object_id, revision_id, revision_blob_sha256_hex, '
      + 'parent_revision_id, parent_revision_blob_sha256_hex, peer_object_key '
      + `FROM sync_branch_evidence_state ${where} ORDER BY object_id, revision_id`, values);
    const state = await reader.readWriterState({ writerSyncPeerId: peer.syncPeerId });
    if (state?.status !== 'verified') fail('p02-desktop-chrome-writer-state-invalid');
    const candidates = [];
    for (const row of Array.isArray(rows) ? rows : []) {
      const objectKey = await objectKeyHex(
        P02_DESKTOP_REVERSE_V2.CHAT_OBJECT_DOMAIN,
        row.object_id,
        cryptoImplementation);
      const expectedPeerObjectKey = await peerObjectKeyFor(
        peer.syncPeerId, objectKey);
      if (row.peer_object_key !== expectedPeerObjectKey) continue;
      const head = (state.snapshot?.heads || []).find((tip) =>
        tip.objectId === row.object_id && tip.objectKey === objectKey &&
        tip.writerSyncPeerId === peer.syncPeerId &&
        tip.revisionId === row.revision_id &&
        tip.revisionBlobSha256 === row.revision_blob_sha256_hex);
      if (head) candidates.push({ row, head });
    }
    if (candidates.length !== 1) fail(candidates.length === 0
      ? 'p02-desktop-no-admitted-chrome-leaf'
      : 'p02-desktop-ambiguous-admitted-chrome-leaf');
    return candidates[0];
  }

  async function readP02Candidate(request) {
    const peer = await configuredChromePeer();
    await requirePeerGeneration(peer);
    const selected = await selectedAdmittedLeaf(peer, request?.objectId);
    const objectKey = await objectKeyHex(
      P02_DESKTOP_REVERSE_V2.CHAT_OBJECT_DOMAIN,
      selected.row.object_id,
      cryptoImplementation);
    if (request?.objectKeyHex !== objectKey) fail('p02-desktop-object-key-mismatch');
    const revision = await reader.readRevision({
      objectDomain: P02_DESKTOP_REVERSE_V2.CHAT_OBJECT_DOMAIN,
      objectId: selected.row.object_id,
      objectKey,
      revisionBlobSha256: selected.row.revision_blob_sha256_hex
    });
    if (revision?.status !== 'verified' ||
        revision.value?.writerSyncPeerId !== peer.syncPeerId ||
        revision.value?.revisionId !== selected.row.revision_id) {
      fail('p02-desktop-admitted-revision-invalid');
    }
    return Object.freeze({
      ok: true,
      verdict: 'p02-local-admission-verified',
      headPresent: true,
      head: selected.head,
      headCanonicalText: null,
      headStrongEtag: null,
      revisionBlobText: new TextDecoder().decode(revision.bytes),
      revisionValue: revision.value,
      sourceKind: 'p02-admitted-local',
      sourceStrongVersion:
        `local-p02:revision-sha256:${selected.row.revision_blob_sha256_hex}`,
      sourceVerified: true,
      transportVerified: true
    });
  }

  /*
   * One Apply attempt = one object, chosen by the existing P02 scheduler.
   *
   * The scheduler is constructed fresh for the attempt (a trusted Human retry
   * must never be parked by an earlier attempt's rebuildable retry memo - the
   * same posture the Chrome composition takes by dropping its retry index),
   * enumerates every admitted object, classifies each from its own canonical
   * state, selects one runnable object in deterministic order, revalidates it
   * and executes exactly one domain-specific Apply. Objects that are not
   * runnable are reported beside the result, never treated as a fatal
   * ambiguity: a converged object is already applied, a dependency-blocked
   * binding waits for its dependency, a diverged object waits for resolution.
   */
  async function sequenceOneApply(peer) {
    /* The selection snapshot: the first classification of every object in
     * this attempt, which is exactly what the scheduler selected from. */
    const snapshot = new Map();
    const keyOf = (item) => `${clean(item?.objectDomain)}\u0000${clean(item?.objectId)}`;
    const descriptorsFor = async () => {
      const enumeration = await enumerateAdmittedObjects(peer);
      return enumeration.objects.map(schedulerDescriptor);
    };
    const classify = async (input) => {
      const isDescriptor = Array.isArray(input?.advertisedTips);
      let descriptor = isDescriptor ? input : null;
      if (descriptor === null) {
        /* The pre-dispatch recheck passes a bare triple: answer it from a
         * fresh enumeration so the decision is re-derived, never carried. */
        const fresh = await descriptorsFor();
        descriptor = fresh.find((item) => keyOf(item) === keyOf(input)) || null;
        if (descriptor === null) {
          return { classification: 'converged', reason: 'object-absent-on-recheck' };
        }
      }
      const verdict = await classifyDescriptor(peer, descriptor);
      if (!snapshot.has(keyOf(descriptor))) snapshot.set(keyOf(descriptor), { descriptor, verdict });
      return verdict;
    };
    const scheduler = new P02ObjectScheduler({
      peerId: peer.syncPeerId,
      clock: () => Date.now(),
      enumerate: descriptorsFor,
      classify,
      execute: (candidate, fresh) => executeSelected(peer, candidate, fresh),
      /* A trusted Human Apply: one-call authority, never a persisted mode. */
      authority: async () => ({ mode: 'manual', valid: true, manualApply: true })
    });
    const step = await scheduler.runOnce();
    const candidates = [...snapshot.values()]
      .map(({ descriptor, verdict }) => {
        const classification = clean(verdict?.classification);
        return Object.freeze({
          objectDomain: descriptor.objectDomain,
          objectId: descriptor.objectId,
          classification,
          runnability: classificationRunnability(classification),
          reason: verdict?.reason ?? null,
          blockClass: blockReasonOf(classification),
          dependencyDetail: verdict?.dependencyDetail ?? null,
          applyCandidateRevisionId: verdict?.applyCandidateRevisionId ?? null
        });
      })
      .sort((left, right) =>
        left.objectDomain.localeCompare(right.objectDomain) ||
        left.objectId.localeCompare(right.objectId));
    return { step, candidates };
  }

  function sequencingSummary({ candidates, selected = null, enumeration = null }) {
    return Object.freeze({
      sequencing: P02_DESKTOP_REVERSE_V2.APPLY_SEQUENCING,
      sequencer: P02_DESKTOP_REVERSE_V2.APPLY_SEQUENCER,
      candidateCount: candidates.length,
      runnableCount: candidates.filter((item) => item.runnability === P02_RUNNABILITY.RUNNABLE).length,
      blockedCount: candidates.filter((item) => item.runnability === P02_RUNNABILITY.BLOCKED).length,
      indeterminateCount: candidates.filter((item) => item.runnability === P02_RUNNABILITY.INDETERMINATE).length,
      selected,
      candidates,
      unadmitted: enumeration?.unadmitted ?? Object.freeze([]),
      unsupported: enumeration?.unsupported ?? Object.freeze([])
    });
  }

  async function applyAdmittedFromChrome() {
    if (applyInFlight || receiveInFlight) return Object.freeze({
      schema: P02_DESKTOP_REVERSE_V2.APPLY_RESULT_SCHEMA,
      ok: false, outcome: 'busy'
    });
    applyInFlight = true;
    let result = null;
    try {
      const peer = await configuredChromePeer();
      await requirePeerGeneration(peer);
      const enumeration = await enumerateAdmittedObjects(peer);
      if (enumeration.objects.length === 0) fail('p02-desktop-no-admitted-chrome-leaf');
      const { step, candidates } = await sequenceOneApply(peer);
      applySelection = step.dispatched ? step.candidate : null;

      if (step.dispatched === true) {
        const selected = Object.freeze({
          objectDomain: step.candidate.objectDomain, objectId: step.candidate.objectId,
          classification: step.candidate.classification
        });
        const sequencing = sequencingSummary({ candidates, selected, enumeration });
        if (step.result?.thrown) {
          result = thrownApplyResult({
            objectDomain: step.candidate.objectDomain, objectId: step.candidate.objectId,
            thrown: step.result.thrown, applySequencing: sequencing
          });
        } else if (step.candidate.objectDomain === CHAT_OBJECT_DOMAIN) {
          const object = enumeration.objects.find((item) =>
            item.objectDomain === CHAT_OBJECT_DOMAIN && item.objectId === step.candidate.objectId);
          const chat = step.result?.chat ?? step.result;
          result = Object.freeze({
            ...chatApplyResult({
              objectId: step.candidate.objectId,
              revisionId: (object?.provenLeaves?.[0] ?? object?.leaves?.[0])?.revision_id ?? null,
              result: chat
            }),
            applySequencing: sequencing
          });
        } else {
          const relationship = step.result?.relationship ?? null;
          result = relationship === null
            ? applyResult({
              ok: false,
              outcome: step.result?.outcome === 'integrity' ? 'integrity' : 'blocked(transport)',
              detail: clean(step.result?.reason) || null,
              objectDomain: step.candidate.objectDomain, objectId: step.candidate.objectId,
              canonicalImportAttempts: 0, importerInvoked: false, convergedDirection: null,
              applySequencing: sequencing
            })
            : Object.freeze({
              ...relationshipApplyResult({
                objectDomain: step.candidate.objectDomain,
                objectId: step.candidate.objectId,
                result: relationship
              }),
              applySequencing: sequencing
            });
        }
      } else {
        /*
         * Nothing runnable. The most actionable non-runnable object is
         * reported first (blocked, then indeterminate, then integrity); when
         * every object is converged the deterministic first object is
         * reported as already applied - for a chat through the accepted
         * canonical runtime (which owns the already-applied posture and its
         * bounded metadata reconciliation), for a relationship object through
         * the materializer's zero-write replay path.
         */
        const severity = [P02_RUNNABILITY.BLOCKED, P02_RUNNABILITY.INDETERMINATE, P02_RUNNABILITY.INTEGRITY];
        const stalled = severity
          .map((level) => candidates.find((item) => item.runnability === level))
          .find((item) => !!item) || null;
        if (step.reason === 'stale-decision-revalidated') {
          /* The selection was superseded between snapshot and dispatch: the
           * scheduler refused to run it and nothing mutated. Report the fresh
           * verdict; the next Apply re-reads everything from scratch. */
          result = applyResult({
            ok: false,
            outcome: clean(step.freshClassification) || 'stale-decision-revalidated',
            detail: 'stale-decision-revalidated',
            objectDomain: null,
            objectId: null,
            canonicalImportAttempts: 0,
            importerInvoked: false,
            convergedDirection: null,
            applySequencing: sequencingSummary({ candidates, selected: null, enumeration })
          });
        } else if (stalled) {
          result = applyResult({
            ok: false,
            outcome: stalled.classification,
            detail: stalled.dependencyDetail ?? stalled.reason ?? null,
            objectDomain: stalled.objectDomain,
            objectId: stalled.objectId,
            canonicalImportAttempts: 0,
            importerInvoked: false,
            convergedDirection: null,
            blockReason: stalled.blockClass ?? null,
            dependencyDetail: stalled.dependencyDetail ?? null,
            applySequencing: sequencingSummary({ candidates, selected: null, enumeration })
          });
        } else {
          const first = candidates[0] ?? null;
          const object = first === null ? null : enumeration.objects.find((item) =>
            item.objectDomain === first.objectDomain && item.objectId === first.objectId) || null;
          if (object === null) fail('p02-desktop-no-admitted-chrome-leaf');
          const selected = Object.freeze({
            objectDomain: object.objectDomain, objectId: object.objectId,
            classification: first.classification
          });
          const sequencing = sequencingSummary({ candidates, selected, enumeration });
          if (object.objectDomain === CHAT_OBJECT_DOMAIN) {
            const chat = await canonicalApply.applyNextAdmittedP02Revision(object.objectId);
            result = Object.freeze({
              ...chatApplyResult({
                objectId: object.objectId,
                revisionId: (object.provenLeaves[0] ?? object.leaves[0]).revision_id,
                result: chat
              }),
              applySequencing: sequencing
            });
          } else {
            const read = await readRelationshipLeaf({
              peer, objectDomain: object.objectDomain, objectId: object.objectId,
              objectKey: object.objectKey,
              revisionId: (object.provenLeaves[0] ?? object.leaves[0]).revision_id
            });
            if (read.status !== 'verified') fail('p02-desktop-admitted-revision-invalid', read.reason || read.status);
            const relationship = await materializer.applyRelationshipRevision({
              objectDomain: object.objectDomain, objectId: object.objectId,
              objectKey: object.objectKey, leaf: read.leaf, revision: read.revision
            });
            result = Object.freeze({
              ...relationshipApplyResult({
                objectDomain: object.objectDomain, objectId: object.objectId, result: relationship
              }),
              applySequencing: sequencing
            });
          }
        }
      }
      lastApply = Object.freeze({
        outcome: result.outcome,
        detail: result.detail ?? null,
        objectDomain: result.objectDomain ?? null,
        objectId: result.objectId ?? null
      });
      return result;
    } catch (error) {
      const invoked = error?.importerInvoked === true;
      lastApply = Object.freeze({ outcome: clean(error?.code) || 'apply-failed', detail: clean(error?.detail) || null });
      return Object.freeze({
        schema: P02_DESKTOP_REVERSE_V2.APPLY_RESULT_SCHEMA,
        ok: false, outcome: clean(error?.code) || 'apply-failed',
        detail: clean(error?.detail) || null,
        canonicalImportAttempts: invoked ? 1 : 0,
        importerInvoked: invoked,
        publicationReachable: false, repositoryWrites: 0,
        webdavReachable: false
      });
    } finally { applySelection = null; applyInFlight = false; }
  }

  const localSource = Object.freeze({
    schema: 'h2o.studio.syncObjectP02LocalSource.v1',
    sourceKind: 'p02-admitted-local',
    readCandidate: readP02Candidate
  });

  return Object.freeze({
    schema: P02_DESKTOP_REVERSE_V2.SCHEMA,
    configureChromePeer,
    receiveFromChrome,
    applyAdmittedFromChrome,
    localSource,
    diagnose: () => Object.freeze({
      configInFlight, receiveInFlight, applyInFlight,
      lastReceive, lastApply,
      receiveAutonomous: false, applyAutonomous: false,
      p01RouteUsed: false, webdavReachable: false,
      supportedObjectDomains: SUPPORTED_OBJECT_DOMAINS,
      applySequencing: P02_DESKTOP_REVERSE_V2.APPLY_SEQUENCING,
      relationshipCommand: P02_DESKTOP_RELATIONSHIP_V2.COMMAND,
      libraryRefreshPort: P02_DESKTOP_RELATIONSHIP_V2.LIBRARY_REFRESH_EVENT,
      libraryRefreshAvailable: libraryRefresh !== null
    })
  });
}

/*
 * Round 2A projection dependency of the canonical Apply runtime.
 *
 * sync-object-runtime.tauri.js resolves H2O.Desktop.SyncObjectProjection
 * lazily and fails closed (round2a-projection-unavailable) when it is absent.
 * The Legacy operator entrypoint preloaded that module at boot and published
 * H2O.Desktop.Sync.round2aReady; the New UI Local Folder panel loads only the
 * runtime script and then imports this module, so on the canonical surface
 * nothing else guarantees the projection. This facade owns that guarantee for
 * the runtime members it consumes: await round2aReady when a loader already
 * owns it, otherwise attach the canonical packed module once from the governed
 * root asset namespace - exactly how the runtime attaches its own local source
 * - and verify the API before delegating. Loading only attaches an API: no
 * store, SQL, repository or importer call occurs. A load that cannot produce
 * the API stays the same typed failure the runtime would have raised.
 */
const ROUND2A_PROJECTION_ASSET = '/sync/sync-object-projection.tauri.js';
const projectionUnavailable = (detail) => {
  const error = new Error('round2a-projection-unavailable');
  error.code = 'round2a-projection-unavailable';
  error.detail = detail;
  return error;
};
const round2aProjectionLoads = new WeakMap();
export function ensureRound2AProjection(scope) {
  const H2O = scope?.H2O;
  const present = () => !!H2O?.Desktop?.SyncObjectProjection;
  if (present()) return Promise.resolve();
  const ready = H2O?.Desktop?.Sync?.round2aReady;
  if (ready && typeof ready.then === 'function') {
    return Promise.resolve(ready).then(() => {
      if (!present()) throw projectionUnavailable('round2a-ready-without-projection');
    });
  }
  const memoized = scope && typeof scope === 'object';
  let load = memoized ? round2aProjectionLoads.get(scope) : null;
  if (!load) {
    load = new Promise((resolve, reject) => {
      const document = scope?.document;
      if (!document || typeof document.createElement !== 'function') {
        reject(projectionUnavailable('projection-document-unavailable'));
        return;
      }
      const script = document.createElement('script');
      script.src = ROUND2A_PROJECTION_ASSET;
      script.async = false;
      script.onload = () => {
        if (present()) resolve();
        else reject(projectionUnavailable('projection-api-missing-after-load'));
      };
      script.onerror = () => {
        reject(projectionUnavailable('projection-asset-load-failed'));
      };
      const parent = document.head || document.documentElement;
      if (!parent || typeof parent.appendChild !== 'function') {
        reject(projectionUnavailable('projection-document-unavailable'));
        return;
      }
      parent.appendChild(script);
    }).catch((error) => {
      if (memoized) round2aProjectionLoads.delete(scope);
      throw error;
    });
    if (memoized) round2aProjectionLoads.set(scope, load);
  }
  return load.then(() => {
    if (!present()) throw projectionUnavailable('projection-api-missing-after-load');
  });
}

/* The canonical runtime members this facade consumes, each guaranteed its
 * projection dependency immediately before the runtime is invoked. Order and
 * arguments are unchanged; the runtime itself is untouched. */
export function projectionGuardedRuntime(scope, canonicalRuntime) {
  return Object.freeze({
    resolveCanonicalAnchor: async (objectId, options) => {
      await ensureRound2AProjection(scope);
      return canonicalRuntime.resolveCanonicalAnchor(objectId, options);
    },
    applyNextAdmittedP02Revision: async (objectId) => {
      await ensureRound2AProjection(scope);
      return canonicalRuntime.applyNextAdmittedP02Revision(objectId);
    }
  });
}

export function installDesktopP02Reverse(globalScope = globalThis) {
  const scope = globalScope || {};
  /* Packaged on both Studio surfaces, activated only by the native invoke
   * authority. Chrome must not grow a Desktop Receive/Apply facade. */
  if (!invokeFrom(scope)) return null;
  const H2O = scope.H2O = scope.H2O || {};
  H2O.Studio = H2O.Studio || {};
  H2O.Studio.sync = H2O.Studio.sync || {};
  H2O.Desktop = H2O.Desktop || {};
  if (H2O.Studio.sync.p02Reverse) return H2O.Studio.sync.p02Reverse;
  let runtime = null;
  function current() {
    if (runtime) return runtime;
    const invoke = invokeFrom(scope);
    const sync = H2O.Studio.sync;
    const canonicalRuntime = H2O.Desktop.SyncObjectRuntime;
    if (!invoke || typeof sync.getConfig !== 'function' ||
        typeof sync.setConfig !== 'function' ||
        typeof sync.mutateCanonicalConfig !== 'function' ||
        typeof canonicalRuntime?.applyNextAdmittedP02Revision !== 'function') {
      fail('p02-desktop-reverse-runtime-unavailable');
    }
    const canonicalApply = projectionGuardedRuntime(scope, canonicalRuntime);
    runtime = createDesktopP02ReverseRuntime({
      invoke,
      configOwner: sync,
      localIdentity: async () => {
        const identity = H2O.Studio.identity;
        /*
         * whenSyncReady() is documented, and implemented, as the CHROME sync
         * readiness boundary: it hard-requires studio-chrome / mv3-chrome /
         * idb-archive and throws identity-classification-unsupported for
         * anything else. This runtime IS the Desktop side, so asking that
         * question rejected the Desktop's own perfectly valid
         * studio-desktop / tauri-desktop / sqlite identity - before any config
         * mutation was even attempted, which is why a failed Configure left the
         * canonical config byte-identical and reported persistence-failed.
         *
         * whenReady() is the classification-neutral canonical read: it awaits
         * the same init(), returns the validated identity, and imposes no
         * surface class. get() remains only a synchronous fallback, because it
         * is documented to return null until whenReady resolves. Chrome
         * identity semantics are untouched - nothing here changes what
         * whenSyncReady() means for the Chrome surface.
         */
        if (typeof identity?.whenReady === 'function') return identity.whenReady();
        if (typeof identity?.get === 'function') return identity.get();
        fail('p02-desktop-local-identity-invalid');
      },
      canonicalApply,
      /* The one Library-owned refresh request port, bound to this window. */
      libraryRefresh: createLibraryRefreshRequestPort(scope)
    });
    H2O.Desktop.SyncObjectP02LocalSource = runtime.localSource;
    return runtime;
  }
  const api = Object.freeze({
    schema: P02_DESKTOP_REVERSE_V2.SCHEMA,
    configureChromePeer: (input) => current().configureChromePeer(input),
    receiveFromChrome: () => current().receiveFromChrome(),
    applyAdmittedFromChrome: () => current().applyAdmittedFromChrome(),
    diagnose: () => runtime
      ? runtime.diagnose()
      : Object.freeze({ installed: true, initialized: false,
        receiveAutonomous: false, applyAutonomous: false, webdavReachable: false })
  });
  H2O.Studio.sync.p02Reverse = api;
  return api;
}

installDesktopP02Reverse();
