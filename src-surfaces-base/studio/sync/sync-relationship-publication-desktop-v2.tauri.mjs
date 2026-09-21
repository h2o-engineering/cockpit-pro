/*
 * P02 T05 — Desktop -> Chrome relationship PUBLICATION (D2).
 *
 * WHAT THIS MODULE IS. The single Sync-owned Desktop publisher of the two
 * admitted relationship families, studio.folder.v1 and
 * studio.chat-folder-binding.v1. It projects the local `folders` and
 * `folder_bindings` tables into the exact D1 canonical payloads
 * (folder: schema/folderId/name; binding: schema/chatId/folderId), reads the
 * DOMAIN-QUALIFIED `sync_object_state` row of each object, and publishes ONE
 * explicitly operator-selected candidate per attempt through the accepted
 * steady publication chain: the shared steady core (parent selection through
 * the shared descendant/anchor proof rules, heads-merge planning, durable
 * intent, CAS-guarded batch), the existing relationship revision adapter
 * (produceRelationshipRevisionV2), the existing writer identity, the
 * existing native steady write window (h2o_p02_steady_begin / _finish), the
 * existing Desktop writer storage and Z4 transport, and the existing
 * writer-generation / P01-standdown authority. Nothing here is a second Sync
 * engine and no new Tauri command exists.
 *
 * WHAT THIS MODULE IS NOT. It never writes `folders` or `folder_bindings`
 * (no relationship mutation, no schema migration, no receive/apply from
 * Chrome). Its only SQL writes are the relationship-domain
 * `sync_object_state` bookkeeping rows the writer-authority contract §6
 * assigns to Sync (publish intent / completion / abandonment), always keyed
 * (sync_peer_id, object_domain, object_id). The chat-domain rows and the
 * accepted chat publication chain are never touched.
 *
 * ROOT / DESCENDANT. An object with a proven anchor (its applied or published
 * pair, verified in the repository) publishes as a DESCENDANT of that anchor.
 * ROOT is permitted only when the shared parent selector proves there is no
 * anchor AND the writer's own heads advertise no group for the object; in
 * addition, an object that a configured trusted peer already advertises while
 * this writer holds no anchor for it is refused (`foreign-root-present-
 * receive-first`): the only correct next step is to Receive/Apply the peer's
 * root, never to mint a second one. Divergent anchors, incomplete proof and
 * missing dependencies fail closed through the steady core's typed refusals.
 *
 * TIMESTAMPS. Local `updated_at` / `assigned_at` / `created_at` feed ONLY the
 * head's sourceUpdatedAtIso (D1); they never enter a payload.
 *
 * Importing this module starts nothing. The installer binds an operator
 * surface only when a native invoke authority exists (Desktop), so Chrome
 * never grows a Desktop publication facade.
 */

import {
  P02_RELATIONSHIP_DOMAINS_V2,
  canonicalFolderName,
  isCanonicalFolderName,
  isChatObjectId,
  isFolderObjectId,
  validateRelationshipPayload
} from '../core/sync-relationship-domains-v2.mjs';
import { classifyObjectState, createReadOnlyObjectDescriptor }
  from '../core/sync-object-classifier-v2.mjs';
import { createP02AnchorSet } from '../core/sync-p02-anchor-set-v2.mjs';
import { createP02SteadyPublication, P02_STEADY_OUTCOME }
  from '../core/sync-steady-publication-v2.mjs';
import { createP02SteadyDriver } from '../core/sync-steady-driver-v2.mjs';
import { evaluateFormatGate } from '../core/sync-format-gate-v2.mjs';
import { mintP02RevisionId } from '../core/sync-p02-revision-mint-v2.mjs';
import { P02_PARENT_SELECTION } from '../core/sync-p02-descendant-publication-v2.mjs';
import {
  P02_RELATIONSHIP_DOMAIN_V2,
  isoFromSourceEpoch,
  produceRelationshipRevisionV2
} from '../browser-adapters/chrome/sync-revision-domain-relationship-v2.mjs';
import { createLocalWriterTransportPrimitives }
  from '../browser-adapters/chrome/sync-writer-transport-v2.mjs';
import { createLocalReaderTransportPrimitives }
  from '../browser-adapters/chrome/sync-reader-transport-v2.mjs';
import { P02_SYNC_CONTRACT_V2, canonicalJson, objectKeyHex, writerKeyHex }
  from '../browser-adapters/chrome/sync-contract-v2.mjs';
import { createDesktopLocalWriterStorage }
  from './sync-writer-storage-desktop-v2.tauri.mjs';
import { createDesktopP01MutationGate }
  from './sync-writer-generation-desktop-v2.tauri.mjs';

const FOLDER_DOMAIN = P02_RELATIONSHIP_DOMAINS_V2.FOLDER.OBJECT_DOMAIN;
const BINDING_DOMAIN = P02_RELATIONSHIP_DOMAINS_V2.BINDING.OBJECT_DOMAIN;
const DB_URL = 'sqlite:studio-v1.db';

export const P02_DESKTOP_RELATIONSHIP_PUBLICATION = Object.freeze({
  SCHEMA: 'h2o.studio.syncDesktopRelationshipPublication.p02.v1',
  RESULT_SCHEMA: 'h2o.studio.syncDesktopRelationshipPublicationResult.p02.v1',
  DB_URL,
  FOLDER_OBJECT_DOMAIN: FOLDER_DOMAIN,
  BINDING_OBJECT_DOMAIN: BINDING_DOMAIN,
  /* Referent before referrer: every folder candidate precedes every binding
   * candidate; within a family by objectId. Reproducibility only. */
  CANDIDATE_FAMILY_ORDER: Object.freeze([FOLDER_DOMAIN, BINDING_DOMAIN]),
  CANDIDATE_SEQUENCING: 'deterministic-one-object-per-attempt',
  FIRST_PUBLICATION: 'trusted-human-manual-only',
  AUTOMATIC_PUBLICATION: 'none',
  FOLDER_SOURCE_USER: 'user',
  COMMAND: Object.freeze({
    RESOLVE_ROOT: 'h2o_p02_resolve_repository_root',
    READ_GENERATION_AUTHORITY: 'h2o_p02_read_writer_generation_authority',
    READ_LIBRARY_AUTHORITY: 'h2o_p02_read_library_authority',
    /* The EXISTING steady write window; no new command. */
    BEGIN: 'h2o_p02_steady_begin',
    FINISH: 'h2o_p02_steady_finish',
    RUNTIME_SESSION: 'h2o_sync_object_runtime_session'
  }),
  MAX_DESCENT_STEPS: 64,
  DIRECTION_COVERAGE: P02_RELATIONSHIP_DOMAIN_V2.DIRECTION_COVERAGE,
  LOCAL_SOURCE_REVISION_PREFIX: P02_RELATIONSHIP_DOMAIN_V2.LOCAL_SOURCE_REVISION_PREFIX,
  RESERVED_FOLDER_KEYS: P02_RELATIONSHIP_DOMAIN_V2.RESERVED_FOLDER_KEYS
});

export const P02_DESKTOP_RELATIONSHIP_PUBLICATION_ELIGIBILITY = Object.freeze({
  ELIGIBLE: 'eligible',
  NOT_ELIGIBLE_FOLDER_SOURCE: 'not-eligible(folder-source)',
  NOT_ELIGIBLE_RESERVED: 'not-eligible(reserved)',
  NOT_ELIGIBLE_FOLDER_MISSING: 'not-eligible(folder-missing)',
  /* An unfiled chat with no relationship anchor expresses the default state;
   * it becomes a candidate only once it was anchored (an Unfile is then a
   * proven descendant of the applied/published binding). */
  NOT_ELIGIBLE_UNFILED_UNANCHORED: 'not-eligible(unfiled-unanchored)',
  INVALID_SOURCE_RECORD: 'invalid-source-record',
  CONTRACT_INVALID: 'contract-invalid'
});

export const P02_DESKTOP_RELATIONSHIP_PUBLICATION_ERROR = Object.freeze({
  RUNTIME_UNAVAILABLE: 'p02-t05-desktop-relationship-publication-runtime-unavailable',
  IDENTITY_UNAVAILABLE: 'p02-t05-desktop-relationship-publication-identity-unavailable',
  REPOSITORY_UNAVAILABLE: 'p02-t05-desktop-relationship-publication-repository-unavailable',
  BOOKKEEPING_FAILED: 'p02-t05-desktop-relationship-publication-bookkeeping-failed',
  BOOKKEEPING_BUSY: 'p02-t05-desktop-relationship-publication-bookkeeping-busy',
  PROJECTION_UNAVAILABLE: 'p02-t05-desktop-relationship-publication-projection-unavailable',
  FOREIGN_ROOT_PRESENT: 'foreign-root-present-receive-first',
  BUSY: 'busy'
});

/* Fixed read statements, every sync_object_state access domain-qualified. */
export const P02_DESKTOP_RELATIONSHIP_PUBLICATION_QUERIES = Object.freeze({
  FOLDERS: 'SELECT id, name, source, created_at, updated_at FROM folders ORDER BY id',
  BINDINGS: 'SELECT c.id AS chat_id, c.created_at AS chat_created_at, c.updated_at AS chat_updated_at, '
    + 'b.folder_id AS folder_id, b.assigned_at AS assigned_at '
    + 'FROM chats c LEFT JOIN folder_bindings b ON b.chat_id = c.id '
    + 'WHERE c.is_deleted = 0 ORDER BY c.id',
  PROTOCOL: 'SELECT pending_operation, operation_phase, last_conflict_class, last_error_code, '
    + 'last_published_revision_id, last_published_revision_blob_sha256, last_published_payload_sha256, '
    + 'last_applied_revision_id, last_applied_revision_blob_sha256, last_applied_payload_sha256, '
    + 'last_converged_direction, intended_revision_id, intended_revision_blob_sha256, intended_payload_sha256 '
    + 'FROM sync_object_state WHERE sync_peer_id = ? AND object_domain = ? AND object_id = ? LIMIT 1',
  /* Sync bookkeeping (writer-authority contract §6): relationship rows only. */
  INTENT_INSERT: 'INSERT INTO sync_object_state (sync_peer_id, object_domain, object_id, '
    + 'pending_operation, operation_phase, intended_object_key, intended_revision_id, '
    + 'intended_revision_blob_sha256, intended_payload_sha256, last_error_code, created_at, updated_at) '
    + "VALUES (?, ?, ?, 'publish', 'transport', ?, ?, ?, ?, NULL, ?, ?) "
    + 'ON CONFLICT(sync_peer_id, object_domain, object_id) DO UPDATE SET '
    + "pending_operation = 'publish', operation_phase = 'transport', "
    + 'intended_object_key = excluded.intended_object_key, '
    + 'intended_revision_id = excluded.intended_revision_id, '
    + 'intended_revision_blob_sha256 = excluded.intended_revision_blob_sha256, '
    + 'intended_payload_sha256 = excluded.intended_payload_sha256, '
    + 'last_error_code = NULL, updated_at = excluded.updated_at '
    + 'WHERE sync_object_state.pending_operation IS NULL',
  COMPLETE: 'UPDATE sync_object_state SET last_published_revision_id = ?, '
    + 'last_published_revision_blob_sha256 = ?, last_published_payload_sha256 = ?, '
    + "last_converged_direction = 'published', pending_operation = NULL, operation_phase = NULL, "
    + 'intended_object_key = NULL, intended_revision_id = NULL, intended_revision_blob_sha256 = NULL, '
    + 'intended_payload_sha256 = NULL, last_conflict_class = NULL, last_error_code = NULL, updated_at = ? '
    + "WHERE sync_peer_id = ? AND object_domain = ? AND object_id = ? AND pending_operation = 'publish' "
    + 'AND intended_revision_id = ?',
  ABANDON_RETAIN: 'UPDATE sync_object_state SET last_error_code = ?, updated_at = ? '
    + "WHERE sync_peer_id = ? AND object_domain = ? AND object_id = ? AND pending_operation = 'publish'",
  ABANDON_CLEAR: 'UPDATE sync_object_state SET pending_operation = NULL, operation_phase = NULL, '
    + 'intended_object_key = NULL, intended_revision_id = NULL, intended_revision_blob_sha256 = NULL, '
    + 'intended_payload_sha256 = NULL, last_error_code = ?, updated_at = ? '
    + "WHERE sync_peer_id = ? AND object_domain = ? AND object_id = ? AND pending_operation = 'publish'"
});

const HEX64 = /^[0-9a-f]{64}$/;
const clean = (value) => String(value == null ? '' : value).trim();
const hex64 = (value) => typeof value === 'string' && HEX64.test(value);
const isPlainObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const rows = (value) => (Array.isArray(value) ? value : []);

class P02DesktopRelationshipPublicationError extends Error {
  constructor(code, detail = null) {
    super(code);
    this.name = 'P02DesktopRelationshipPublicationError';
    this.code = code;
    if (detail !== null && detail !== undefined) this.detail = String(detail);
  }
}
const fail = (code, detail) => { throw new P02DesktopRelationshipPublicationError(code, detail); };

function rowsAffected(result) {
  if (Array.isArray(result)) return Number(result[0]) || 0;
  if (isPlainObject(result)) return Number(result.rowsAffected ?? result.changes ?? 0) || 0;
  return Number(result) || 0;
}

const familyRank = (objectDomain) => {
  const rank = P02_DESKTOP_RELATIONSHIP_PUBLICATION.CANDIDATE_FAMILY_ORDER.indexOf(objectDomain);
  return rank < 0 ? P02_DESKTOP_RELATIONSHIP_PUBLICATION.CANDIDATE_FAMILY_ORDER.length : rank;
};
export function compareRelationshipCandidates(left, right) {
  return familyRank(left.objectDomain) - familyRank(right.objectDomain) ||
    left.objectDomain.localeCompare(right.objectDomain) ||
    left.objectId.localeCompare(right.objectId) ||
    left.objectKey.localeCompare(right.objectKey);
}

/* Same two-regime convergence rule the accepted enumerators apply. */
function convergenceVerdict(canonical, state) {
  const direction = clean(state.convergedDirection);
  if (direction) {
    const anchorPayload = direction === 'published' ? clean(state.publishedPayloadSha256)
      : direction === 'applied' ? clean(state.appliedPayloadSha256) : '';
    if (!hex64(anchorPayload)) return { dirty: false, integrity: true, regime: 'p02-corrupt' };
    return { dirty: canonical.payloadSha256 !== anchorPayload, integrity: false, regime: 'p02' };
  }
  return { dirty: true, integrity: false, regime: state.lastPublished ? 'legacy' : 'unpublished' };
}

function fixed(outcome, extra = {}) {
  const ok = outcome === 'published' || outcome === 'recovered' || outcome === 'no-eligible-local-change';
  return Object.freeze({
    schema: P02_DESKTOP_RELATIONSHIP_PUBLICATION.RESULT_SCHEMA,
    ok, outcome, repositoryMutated: outcome === 'published',
    relationshipSqliteWrites: 0, receiveExecuted: false, applyExecuted: false,
    webdavReachable: false, ...extra
  });
}

export function createDesktopRelationshipPublication({
  invoke,
  configOwner = null,
  localIdentity,
  cryptoImplementation = globalThis.crypto,
  clock = () => new Date().toISOString(),
  onTrace = null
} = {}) {
  const E = P02_DESKTOP_RELATIONSHIP_PUBLICATION_ERROR;
  const Q = P02_DESKTOP_RELATIONSHIP_PUBLICATION_QUERIES;
  const K = P02_DESKTOP_RELATIONSHIP_PUBLICATION;
  const EL = P02_DESKTOP_RELATIONSHIP_PUBLICATION_ELIGIBILITY;
  if (typeof invoke !== 'function' || typeof localIdentity !== 'function' ||
      typeof cryptoImplementation?.subtle?.digest !== 'function') {
    fail(E.RUNTIME_UNAVAILABLE);
  }
  if (configOwner !== null && typeof configOwner?.getConfig !== 'function') {
    fail(E.RUNTIME_UNAVAILABLE, 'config-owner');
  }
  const sql = Object.freeze({
    select: (query, values = []) => invoke('plugin:sql|select', { db: DB_URL, query, values }),
    execute: (query, values = []) => invoke('plugin:sql|execute', { db: DB_URL, query, values })
  });
  const p01Gate = createDesktopP01MutationGate({ sql, seamName: 'p02-relationship-publication' });
  const readOnlyStorage = createDesktopLocalWriterStorage({ invoke, capability: null });
  const reader = createLocalReaderTransportPrimitives({ storage: readOnlyStorage, cryptoImplementation });
  let inFlight = false;
  let lastResult = null;

  const invokeWithCode = async (command, args) => {
    try { return await invoke(command, args); }
    catch (error) {
      const code = clean(typeof error === 'string' ? error : error?.code || error?.message || error) || 'native-refused';
      const wrapped = new Error(code);
      wrapped.code = code;
      throw wrapped;
    }
  };

  async function writerIdentity() {
    let value;
    try { value = await localIdentity(); } catch (_) { fail(E.IDENTITY_UNAVAILABLE); }
    const syncPeerId = clean(value?.syncPeerId);
    if (!syncPeerId) fail(E.IDENTITY_UNAVAILABLE);
    return { syncPeerId, writerKey: await writerKeyHex(syncPeerId, cryptoImplementation) };
  }

  /* Configured trusted peers, from the canonical Sync config owner. Read-only;
   * an absent or malformed roster means no foreign writer is known. */
  async function configuredPeers(writer) {
    if (configOwner === null) return [];
    let config = null;
    try { config = await configOwner.getConfig(); } catch (_) { return []; }
    if (!config || config.schemaVersion !== 1 || !Array.isArray(config.configuredPeers)) return [];
    const peers = [];
    for (const peer of config.configuredPeers) {
      const syncPeerId = clean(peer?.syncPeerId);
      const writerKey = clean(peer?.writerKey);
      if (!syncPeerId || syncPeerId === writer.syncPeerId || !hex64(writerKey)) continue;
      if (writerKey !== await writerKeyHex(syncPeerId, cryptoImplementation)) continue;
      peers.push(Object.freeze({ syncPeerId, writerKey }));
    }
    return peers;
  }

  /* ---------------- canonical projection ---------------- */

  const sha256HexText = async (text) => {
    const digest = await cryptoImplementation.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  };

  async function finishProjection({ objectDomain, objectId, payload, sourceUpdatedAtIso }) {
    const payloadText = canonicalJson(payload);
    const payloadSha256Hex = await sha256HexText(payloadText);
    return Object.freeze({
      eligible: true, eligibility: EL.ELIGIBLE, detail: null,
      objectDomain, objectId,
      objectKeyHex: await objectKeyHex(objectDomain, objectId, cryptoImplementation),
      payload: Object.freeze(JSON.parse(payloadText)),
      payloadText, payloadSha256Hex,
      revisionId: `${K.LOCAL_SOURCE_REVISION_PREFIX}${payloadSha256Hex}`,
      revisionBlobSha256Hex: payloadSha256Hex,
      sourceUpdatedAtIso
    });
  }
  const ineligible = (objectDomain, objectId, eligibility, detail) => Object.freeze({
    eligible: false, eligibility, detail: detail ?? null, objectDomain, objectId
  });
  const reserved = (value) => K.RESERVED_FOLDER_KEYS.includes(clean(value).toLowerCase());

  async function projectFolderRow(row) {
    const objectId = clean(row?.id);
    if (!objectId) return ineligible(FOLDER_DOMAIN, null, EL.INVALID_SOURCE_RECORD, 'folder-id-missing');
    if (clean(row.source) !== K.FOLDER_SOURCE_USER) {
      return ineligible(FOLDER_DOMAIN, objectId, EL.NOT_ELIGIBLE_FOLDER_SOURCE, clean(row.source) || 'source-missing');
    }
    if (!isFolderObjectId(objectId)) return ineligible(FOLDER_DOMAIN, objectId, EL.CONTRACT_INVALID, 'p02-rel-folder-id-invalid');
    const name = canonicalFolderName(typeof row.name === 'string' ? row.name : '');
    if (reserved(objectId) || reserved(name)) return ineligible(FOLDER_DOMAIN, objectId, EL.NOT_ELIGIBLE_RESERVED, 'reserved-folder-key');
    if (!isCanonicalFolderName(name)) return ineligible(FOLDER_DOMAIN, objectId, EL.CONTRACT_INVALID, 'p02-rel-folder-name-invalid');
    /* Head metadata only (D1): updated_at, then created_at. */
    const sourceUpdatedAtIso = isoFromSourceEpoch(row.updated_at) ?? isoFromSourceEpoch(row.created_at);
    if (!sourceUpdatedAtIso) return ineligible(FOLDER_DOMAIN, objectId, EL.INVALID_SOURCE_RECORD, 'source-timestamp-missing');
    const payload = { schema: P02_RELATIONSHIP_DOMAINS_V2.FOLDER.PAYLOAD_SCHEMA, folderId: objectId, name };
    try { validateRelationshipPayload(FOLDER_DOMAIN, payload, objectId); }
    catch (error) { return ineligible(FOLDER_DOMAIN, objectId, EL.CONTRACT_INVALID, clean(error?.code) || 'contract-invalid'); }
    return finishProjection({ objectDomain: FOLDER_DOMAIN, objectId, payload, sourceUpdatedAtIso });
  }

  async function projectBindingRow(row, userFolders, anchored) {
    const objectId = clean(row?.chat_id);
    if (!isChatObjectId(objectId)) return ineligible(BINDING_DOMAIN, objectId || null, EL.INVALID_SOURCE_RECORD, 'chat-id-invalid');
    const folderId = clean(row.folder_id) || null;
    if (folderId !== null) {
      if (!isFolderObjectId(folderId)) return ineligible(BINDING_DOMAIN, objectId, EL.CONTRACT_INVALID, 'p02-rel-binding-folder-id-invalid');
      if (!userFolders.has(folderId)) return ineligible(BINDING_DOMAIN, objectId, EL.NOT_ELIGIBLE_FOLDER_MISSING, folderId);
    } else if (!anchored) {
      return ineligible(BINDING_DOMAIN, objectId, EL.NOT_ELIGIBLE_UNFILED_UNANCHORED, 'unfiled-default-state');
    }
    const sourceUpdatedAtIso = isoFromSourceEpoch(row.assigned_at) ??
      isoFromSourceEpoch(row.chat_updated_at) ?? isoFromSourceEpoch(row.chat_created_at);
    if (!sourceUpdatedAtIso) return ineligible(BINDING_DOMAIN, objectId, EL.INVALID_SOURCE_RECORD, 'source-timestamp-missing');
    const payload = { schema: P02_RELATIONSHIP_DOMAINS_V2.BINDING.PAYLOAD_SCHEMA, chatId: objectId, folderId };
    try { validateRelationshipPayload(BINDING_DOMAIN, payload, objectId); }
    catch (error) { return ineligible(BINDING_DOMAIN, objectId, EL.CONTRACT_INVALID, clean(error?.code) || 'contract-invalid'); }
    return finishProjection({ objectDomain: BINDING_DOMAIN, objectId, payload, sourceUpdatedAtIso });
  }

  /* ---------------- protocol state (domain-qualified) ---------------- */

  async function protocolRow(syncPeerId, objectDomain, objectId) {
    const row = rows(await sql.select(Q.PROTOCOL, [syncPeerId, objectDomain, objectId]))[0];
    return row || {};
  }

  function protocolStateOf(row) {
    const publishedRevision = clean(row.last_published_revision_id);
    const appliedRevision = clean(row.last_applied_revision_id);
    return {
      pendingOperation: row.pending_operation ?? null,
      operationPhase: row.operation_phase ?? null,
      intendedRevisionId: row.intended_revision_id ?? null,
      intendedRevisionBlobSha256: row.intended_revision_blob_sha256 ?? null,
      intendedPayloadSha256: row.intended_payload_sha256 ?? null,
      convergedDirection: clean(row.last_converged_direction) || null,
      publishedPayloadSha256: row.last_published_payload_sha256 ?? null,
      appliedPayloadSha256: row.last_applied_payload_sha256 ?? null,
      lastPublished: publishedRevision ? {
        revisionId: publishedRevision,
        revisionBlobSha256: clean(row.last_published_revision_blob_sha256),
        ...(hex64(clean(row.last_published_payload_sha256)) ? { payloadSha256: clean(row.last_published_payload_sha256) } : {})
      } : null,
      lastApplied: appliedRevision ? {
        revisionId: appliedRevision,
        revisionBlobSha256: clean(row.last_applied_revision_blob_sha256),
        ...(hex64(clean(row.last_applied_payload_sha256)) ? { payloadSha256: clean(row.last_applied_payload_sha256) } : {})
      } : null,
      integrityQuarantined: clean(row.last_conflict_class) !== ''
    };
  }

  /* ---------------- repository reads (read-only) ---------------- */

  function readOnlyTransport(writerSyncPeerId) {
    return createLocalWriterTransportPrimitives({
      storage: readOnlyStorage, ownedWriterSyncPeerId: writerSyncPeerId, cryptoImplementation
    });
  }

  async function readRevisionAt({ writerSyncPeerId, objectDomain, objectId, objectKey, revisionBlobSha256 }) {
    const revision = await readOnlyTransport(writerSyncPeerId).readRevision({
      objectDomain, objectId, objectKey, revisionBlobSha256
    });
    return revision?.status === 'verified' ? revision.value ?? null : null;
  }

  /* Foreign-root guard: which configured peers already advertise this object? */
  async function foreignGroups(peers, objectKey) {
    const present = [];
    for (const peer of peers) {
      let state;
      try { state = await reader.readWriterState({ writerSyncPeerId: peer.syncPeerId }); }
      catch (_) { present.push({ syncPeerId: peer.syncPeerId, status: 'unreadable' }); continue; }
      const status = clean(state?.status);
      if (status === 'absent') continue;
      if (status !== 'verified') { present.push({ syncPeerId: peer.syncPeerId, status: status || 'unreadable' }); continue; }
      const tips = rows(state.snapshot?.heads).filter((head) => clean(head?.objectKey) === objectKey);
      if (tips.length > 0) present.push({ syncPeerId: peer.syncPeerId, status: 'verified', tipCount: tips.length });
    }
    return present;
  }

  async function pointerProofFor({ writerSyncPeerId, objectKey, intended }) {
    if (!clean(intended?.revisionId) || !hex64(intended?.revisionBlobSha256)) return { status: 'unread' };
    let state;
    try { state = await readOnlyTransport(writerSyncPeerId).readWriterState({ writerSyncPeerId }); }
    catch (_) { return { status: 'unreadable' }; }
    const status = clean(state?.status);
    if (status === 'absent') return { status: 'absent-verified' };
    if (status !== 'verified') return { status: status || 'unreadable' };
    const head = rows(state.snapshot?.heads).find((candidate) =>
      clean(candidate?.objectKey) === clean(objectKey) &&
      clean(candidate?.revisionBlobSha256) === clean(intended.revisionBlobSha256)) ?? null;
    if (head === null) return { status: 'verified', namesRevisionId: null, namesRevisionBlobSha256: null };
    return { status: 'verified', namesRevisionId: clean(head.revisionId), namesRevisionBlobSha256: clean(head.revisionBlobSha256) };
  }

  /* ---------------- enumeration ---------------- */

  async function enumerate({ writer, peers }) {
    const [folderRows, bindingRows] = await Promise.all([sql.select(Q.FOLDERS), sql.select(Q.BINDINGS)]);
    const userFolders = new Set(rows(folderRows)
      .filter((row) => clean(row?.source) === K.FOLDER_SOURCE_USER)
      .map((row) => clean(row.id)));
    const projections = [];
    const ineligibleList = [];
    const record = (projection) => {
      if (projection.eligible) projections.push(projection);
      else ineligibleList.push(Object.freeze({
        objectDomain: projection.objectDomain, objectId: projection.objectId,
        eligibility: projection.eligibility, detail: projection.detail
      }));
    };
    for (const row of rows(folderRows)) record(await projectFolderRow(row));
    for (const row of rows(bindingRows)) {
      const chatId = clean(row?.chat_id);
      const state = chatId ? protocolStateOf(await protocolRow(writer.syncPeerId, BINDING_DOMAIN, chatId)) : {};
      const anchored = !!(state.lastPublished || state.lastApplied);
      record(await projectBindingRow(row, userFolders, anchored));
    }
    const descriptors = [];
    for (const projection of projections) {
      const state = protocolStateOf(await protocolRow(writer.syncPeerId, projection.objectDomain, projection.objectId));
      const canonical = {
        revisionId: projection.revisionId, revisionBlobSha256: projection.revisionBlobSha256Hex,
        payloadSha256: projection.payloadSha256Hex, deleted: false
      };
      const convergence = convergenceVerdict(canonical, state);
      const pending = state.pendingOperation != null;
      /* No anchor at all: a configured peer already rooting this object means
       * the next correct step is Receive/Apply, never a second root. */
      let blockReason = null;
      let foreign = [];
      if (!state.convergedDirection && !state.lastPublished && !state.lastApplied && convergence.dirty) {
        foreign = await foreignGroups(peers, projection.objectKeyHex);
        if (foreign.length > 0) blockReason = 'dependency';
      }
      const protocolState = {
        lastPublished: state.lastPublished, lastApplied: state.lastApplied,
        consumedRevisionBlobSha256: null,
        pendingOperation: state.pendingOperation, pendingApply: null,
        operationPhase: state.operationPhase, retainedObservationRevisionIds: []
      };
      descriptors.push(Object.freeze({
        ...createReadOnlyObjectDescriptor({
          objectDomain: projection.objectDomain, objectId: projection.objectId,
          objectKey: projection.objectKeyHex, syncPeerId: writer.syncPeerId,
          canonicalLocalHead: canonical,
          protocolState,
          p02AnchorSet: state.convergedDirection
            ? createP02AnchorSet({ objectDomain: projection.objectDomain, objectId: projection.objectId, protocolState })
            : null,
          retainedEvidence: [], advertisedTips: [],
          dirty: convergence.dirty,
          integrityQuarantined: convergence.integrity || state.integrityQuarantined === true,
          publishable: convergence.dirty && !pending && !convergence.integrity && blockReason === null,
          pending, blockReason
        }),
        foreignRoots: Object.freeze(foreign),
        projection
      }));
    }
    const eligible = descriptors.filter((descriptor) =>
      classifyObjectState(descriptor).classification === 'local-ahead' && descriptor.publishable === true);
    eligible.sort(compareRelationshipCandidates);
    return Object.freeze({
      descriptors: Object.freeze(descriptors), eligible: Object.freeze(eligible),
      ineligible: Object.freeze(ineligibleList)
    });
  }

  /* ---------------- bookkeeping (writer-authority contract section 6) ---------------- */

  async function recordIntentRow({ writerSyncPeerId, objectDomain, objectId, objectKey, revisionId, revisionBlobSha256, payloadSha256 }) {
    const now = clock();
    const result = await sql.execute(Q.INTENT_INSERT, [
      writerSyncPeerId, objectDomain, objectId, objectKey, revisionId, revisionBlobSha256, payloadSha256, now, now
    ]);
    if (rowsAffected(result) !== 1) fail(E.BOOKKEEPING_BUSY);
    /* Read back: the row must now carry exactly this intent. */
    const row = await protocolRow(writerSyncPeerId, objectDomain, objectId);
    if (clean(row.pending_operation) !== 'publish' || clean(row.intended_revision_id) !== revisionId) {
      fail(E.BOOKKEEPING_FAILED, 'intent-readback');
    }
    return Object.freeze({ writerSyncPeerId, objectDomain, objectId, revisionId });
  }

  async function completeRow({ writerSyncPeerId, objectDomain, objectId, revisionId, revisionBlobSha256, payloadSha256 }) {
    if (!hex64(payloadSha256)) fail(E.BOOKKEEPING_FAILED, 'payload-identity-required');
    const result = await sql.execute(Q.COMPLETE, [
      revisionId, revisionBlobSha256, payloadSha256, clock(),
      writerSyncPeerId, objectDomain, objectId, revisionId
    ]);
    if (rowsAffected(result) !== 1) fail(E.BOOKKEEPING_FAILED, 'complete');
  }

  async function abandonRow({ writerSyncPeerId, objectDomain, objectId, retain, reason }) {
    await sql.execute(retain ? Q.ABANDON_RETAIN : Q.ABANDON_CLEAR,
      [clean(reason) || 'relationship-publication-abandoned', clock(), writerSyncPeerId, objectDomain, objectId]);
  }

  /* ---------------- format gate / authority ---------------- */

  async function readFormatGate() {
    let observation;
    try { observation = await invoke(K.COMMAND.READ_LIBRARY_AUTHORITY, {}); }
    catch (_) { return evaluateFormatGate({ libraryInfo: null, repositoryHasContent: true }); }
    if (observation?.present !== true || observation?.readable !== true) {
      return evaluateFormatGate({ libraryInfo: null, repositoryHasContent: true });
    }
    let libraryInfo = null;
    try { libraryInfo = JSON.parse(observation.canonicalBytes); } catch (_) { libraryInfo = null; }
    return evaluateFormatGate({ libraryInfo, repositoryHasContent: true });
  }

  async function observeAuthority(writer) {
    let verdict;
    try { verdict = await p01Gate.p01MayMutate(); }
    catch (_) { return { permitted: false, reason: 'database-unreadable', blockReason: 'transport' }; }
    if (verdict?.permitted !== false) return { permitted: false, reason: 'p01-writer-still-permitted', blockReason: 'permission' };
    if (clean(verdict.reason) !== 'p01-writer-stood-down') {
      return { permitted: false, reason: clean(verdict.reason) || 'authority-unknown', blockReason: 'permission' };
    }
    let repository;
    try { repository = await invoke(K.COMMAND.READ_GENERATION_AUTHORITY, { writerKey: writer.writerKey }); }
    catch (_) { return { permitted: false, reason: 'repository-unreadable', blockReason: 'transport' }; }
    if (clean(repository?.state) !== 'p02') {
      return { permitted: false, reason: `repository-${clean(repository?.state) || 'unreadable'}`, blockReason: 'permission' };
    }
    return { permitted: true };
  }

  /* ---------------- the steady chain over relationship ports ---------------- */

  function buildSteadyPublication({ writer, peers, projectionFor }) {
    return createP02SteadyPublication({
      onTrace,
      readWriterState: ({ writerSyncPeerId }) =>
        readOnlyTransport(writerSyncPeerId).readWriterState({ writerSyncPeerId }),
      readCanonicalProjection: async ({ objectDomain, objectId }) => {
        const projected = await projectionFor({ objectDomain, objectId });
        if (!projected) return null;
        return {
          revisionId: projected.revisionId, revisionBlobSha256: projected.revisionBlobSha256Hex,
          payloadSha256: projected.payloadSha256Hex, objectKey: projected.objectKeyHex,
          sourceUpdatedAtIso: projected.sourceUpdatedAtIso, payload: projected.payload
        };
      },
      readProtocolState: async (scope) => {
        const row = await protocolRow(scope.writerSyncPeerId, scope.objectDomain, scope.objectId);
        const state = protocolStateOf(row);
        let blockReason = null;
        if (!state.convergedDirection && !state.lastPublished && !state.lastApplied) {
          const foreign = await foreignGroups(peers, scope.objectKey);
          if (foreign.length > 0) blockReason = E.FOREIGN_ROOT_PRESENT;
        }
        return {
          ...state,
          adoptIntent: null,
          /* Relationship rows are always written with their payload identity;
           * there is nothing to heal. */
          publishedPayloadMissing: false,
          blockReason,
          divergedUnresolved: false,
          retainedUnprovenParent: false,
          foreignLanePublicationActive: false,
          pointerProof: await pointerProofFor({
            writerSyncPeerId: scope.writerSyncPeerId, objectKey: scope.objectKey,
            intended: { revisionId: clean(row.intended_revision_id), revisionBlobSha256: clean(row.intended_revision_blob_sha256) }
          })
        };
      },
      proveAnchor: async ({ objectDomain, objectId, objectKey, writerSyncPeerId, pair }) => {
        if (!pair || !hex64(pair.revisionBlobSha256)) return { status: 'absent' };
        let value;
        try {
          value = await readRevisionAt({ writerSyncPeerId, objectDomain, objectId, objectKey, revisionBlobSha256: pair.revisionBlobSha256 });
        } catch (_) { return { status: 'unreadable' }; }
        if (value === null) return { status: 'absent' };
        if (clean(pair.revisionId) && clean(value.revisionId) !== clean(pair.revisionId)) return { status: 'identity-conflict' };
        return { status: 'verified' };
      },
      probeDescent: async ({ objectDomain, objectId, objectKey, writerSyncPeerId, candidate, seed }) => {
        if (!candidate || !seed || !hex64(candidate.revisionBlobSha256) || !hex64(seed.revisionBlobSha256)) {
          return { outcome: 'incomplete' };
        }
        if (clean(candidate.revisionBlobSha256) === clean(seed.revisionBlobSha256)) {
          return { outcome: 'proven-chain', descendsFromSeed: true };
        }
        let cursor = clean(candidate.revisionBlobSha256);
        for (let step = 0; step < K.MAX_DESCENT_STEPS; step += 1) {
          let value;
          try {
            value = await readRevisionAt({ writerSyncPeerId, objectDomain, objectId, objectKey, revisionBlobSha256: cursor });
          } catch (_) { return { outcome: 'unreadable' }; }
          if (value === null) return { outcome: 'unreadable' };
          const previous = clean(value.previousRevisionBlobSha256);
          if (!previous) return { outcome: 'proven-chain', descendsFromSeed: false };
          if (previous === clean(seed.revisionBlobSha256)) return { outcome: 'proven-chain', descendsFromSeed: true };
          cursor = previous;
        }
        return { outcome: 'incomplete' };
      },
      mintRevisionId: () => mintP02RevisionId(cryptoImplementation),
      produceRevision: async ({ objectDomain, objectId, objectKey, p02Parent, revisionId }) => {
        const projected = await projectionFor({ objectDomain, objectId });
        if (!projected) fail(E.PROJECTION_UNAVAILABLE);
        const produced = await produceRelationshipRevisionV2({
          objectDomain,
          canonicalObject: { objectId, revisionId, payload: projected.payload },
          writerSyncPeerId: writer.syncPeerId,
          p02Parent: p02Parent ?? null,
          cryptoImplementation
        });
        return {
          ...produced,
          sourceUpdatedAtIso: projected.sourceUpdatedAtIso,
          revisionInput: {
            objectDomain, objectId, objectKey,
            revisionBlobSha256: produced.revisionBlobSha256, bytes: produced.canonicalBytes
          }
        };
      },
      recordIntent: (input) => recordIntentRow({
        writerSyncPeerId: input.writerSyncPeerId, objectDomain: input.objectDomain,
        objectId: input.objectId, objectKey: input.objectKey,
        revisionId: input.intendedRevisionId, revisionBlobSha256: input.intendedRevisionBlobSha256,
        payloadSha256: input.intendedPayloadSha256
      }),
      completePublication: (input) => completeRow({
        writerSyncPeerId: input.writerSyncPeerId, objectDomain: input.objectDomain,
        objectId: input.objectId, revisionId: input.revisionId,
        revisionBlobSha256: input.revisionBlobSha256, payloadSha256: input.payloadSha256
      }),
      abandonIntent: (input) => abandonRow({
        writerSyncPeerId: input.writerSyncPeerId, objectDomain: input.objectDomain,
        objectId: input.objectId, retain: input.retain === true, reason: input.reason
      }),
      beginSteadyLease: async (request) => {
        const session = await invoke(K.COMMAND.RUNTIME_SESSION, {});
        const bootId = clean(session?.bootId);
        if (!bootId) fail(E.RUNTIME_UNAVAILABLE);
        const target = await invoke(K.COMMAND.RESOLVE_ROOT, {});
        return invokeWithCode(K.COMMAND.BEGIN, {
          request: {
            writerSyncPeerId: request.writerSyncPeerId,
            writerKey: writer.writerKey,
            expectedContainerPathSha256Hex: clean(target?.containerPathSha256Hex),
            expectedLayoutEpoch: 1,
            objectDomain: request.objectDomain,
            objectId: request.objectId,
            objectKey: request.objectKey,
            revisionId: request.revisionId,
            revisionBlobSha256: request.revisionBlobSha256,
            expectedCurrentHeadsSnapshotSha256: request.expectedCurrentHeadsSnapshotSha256 ?? null,
            bootId
          }
        });
      },
      finishSteadyLease: (capability, outcome) => invokeWithCode(K.COMMAND.FINISH, { capability, outcome }),
      createTransport: (capability) => {
        const primitives = createLocalWriterTransportPrimitives({
          storage: createDesktopLocalWriterStorage({ invoke, capability }),
          ownedWriterSyncPeerId: writer.syncPeerId, cryptoImplementation
        });
        const asContractHead = (head) => ({
          schema: P02_SYNC_CONTRACT_V2.SCHEMA.HEAD,
          objectDomain: head.objectDomain, objectId: head.objectId, objectKey: head.objectKey,
          revisionId: head.revisionId, revisionBlobSha256: head.revisionBlobSha256,
          payloadSha256: head.payloadSha256,
          previousRevisionId: head.previousRevisionId ?? null,
          previousRevisionBlobSha256: head.previousRevisionBlobSha256 ?? null,
          writerSyncPeerId: head.writerSyncPeerId || writer.syncPeerId,
          sourceUpdatedAtIso: head.sourceUpdatedAtIso
        });
        return Object.freeze({
          ...primitives,
          publishBatch: (input) => primitives.publishBatch({
            ...input, heads: rows(input?.heads).map(asContractHead)
          })
        });
      },
      observeAuthority: () => observeAuthority(writer)
    });
  }

  /* ---------------- the operator entry point ---------------- */

  async function publishOnce() {
    if (inFlight) return fixed(E.BUSY);
    inFlight = true;
    try {
      const writer = await writerIdentity();
      const peers = await configuredPeers(writer);
      const snapshot = await enumerate({ writer, peers });
      const summary = {
        localWriterSyncPeerId: writer.syncPeerId,
        eligibleCount: snapshot.eligible.length,
        deferredCandidates: snapshot.eligible.slice(1).map((item) => ({ objectDomain: item.objectDomain, objectId: item.objectId })),
        ineligible: snapshot.ineligible,
        foreignRootBlocked: snapshot.descriptors.filter((item) => item.blockReason !== null)
          .map((item) => ({ objectDomain: item.objectDomain, objectId: item.objectId, foreignRoots: item.foreignRoots }))
      };
      if (snapshot.eligible.length === 0) {
        lastResult = fixed('no-eligible-local-change', { ...summary, selectedObjectDomain: null, selectedObjectId: null });
        return lastResult;
      }
      const selected = snapshot.eligible[0];
      const projectionFor = async ({ objectDomain, objectId }) => {
        const current = await enumerate({ writer, peers });
        return current.descriptors.find((item) =>
          item.objectDomain === objectDomain && item.objectId === objectId)?.projection ?? null;
      };
      const currentSelected = async () => {
        const current = await enumerate({ writer, peers });
        return current.eligible.find((item) => item.objectKey === selected.objectKey) ?? null;
      };
      const driver = createP02SteadyDriver({
        steadyPublication: buildSteadyPublication({ writer, peers, projectionFor }),
        enumerate: async () => {
          const current = await currentSelected();
          return Object.freeze(current ? [current] : []);
        },
        classify: async () => {
          const current = await currentSelected();
          return current ? classifyObjectState(current)
            : { classification: 'unclassified', reason: 'object-no-longer-present' };
        },
        authority: async () => ({ valid: true, mode: 'manual', manualPublication: true }),
        gate: readFormatGate,
        peerId: writer.syncPeerId,
        clock: () => Date.now(),
        p01WriterActive: async () => {
          try { return (await p01Gate.p01MayMutate()).permitted !== false; }
          catch (_) { return true; }
        },
        onTrace
      });
      const report = await driver.runtime.runPass({ maxSteps: 1, singlePass: true });
      const steady = report?.dispatched?.[0]?.result?.steady ?? null;
      const outcome = steady?.outcome === P02_STEADY_OUTCOME.COMMITTED ? 'published'
        : steady?.outcome === P02_STEADY_OUTCOME.RECOVERED ? 'recovered'
          : steady?.outcome === P02_STEADY_OUTCOME.NOT_ELIGIBLE ? 'no-eligible-local-change'
            : clean(steady?.reason) || clean(report?.status) || 'publication-failed';
      lastResult = fixed(outcome, {
        ...summary,
        selectedObjectDomain: selected.objectDomain,
        selectedObjectId: selected.objectId,
        mintedRevisionId: steady?.revisionId ?? null,
        parentSelection: steady?.parentSelection ?? null,
        publishedAs: steady?.parentSelection === P02_PARENT_SELECTION.ROOT ? 'root'
          : steady?.parentSelection === P02_PARENT_SELECTION.DESCENDANT ? 'descendant' : null,
        steady, report
      });
      return lastResult;
    } catch (error) {
      lastResult = fixed(clean(error?.code || error?.message) || 'publication-failed',
        { detail: clean(error?.detail) || null });
      return lastResult;
    } finally {
      inFlight = false;
    }
  }

  function diagnose() {
    return Object.freeze({
      schema: K.SCHEMA,
      families: Object.freeze([FOLDER_DOMAIN, BINDING_DOMAIN]),
      candidateSequencing: K.CANDIDATE_SEQUENCING,
      candidateFamilyOrder: K.CANDIDATE_FAMILY_ORDER,
      firstPublication: K.FIRST_PUBLICATION,
      automaticPublication: K.AUTOMATIC_PUBLICATION,
      relationshipMutation: 'never',
      newTauriCommand: 'none',
      directionCoverage: K.DIRECTION_COVERAGE,
      inFlight,
      lastOutcome: lastResult?.outcome ?? null,
      webdavReachable: false
    });
  }

  return Object.freeze({
    schema: K.SCHEMA,
    publishOnce,
    diagnose,
    __test: Object.freeze({ enumerate, protocolStateOf, projectFolderRow, projectBindingRow })
  });
}

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

/*
 * Operator surface. Bound only where a native invoke authority exists; the
 * identity read is the classification-neutral canonical read the reverse
 * facade uses. Nothing runs at install: every publication is one explicit
 * operator call.
 */
export function installDesktopRelationshipPublication(globalScope = globalThis) {
  const scope = globalScope || {};
  if (!invokeFrom(scope)) return null;
  const H2O = scope.H2O = scope.H2O || {};
  H2O.Studio = H2O.Studio || {};
  H2O.Studio.sync = H2O.Studio.sync || {};
  if (H2O.Studio.sync.p02RelationshipPublication) return H2O.Studio.sync.p02RelationshipPublication;
  let runtime = null;
  function current() {
    if (runtime) return runtime;
    const invoke = invokeFrom(scope);
    const sync = H2O.Studio.sync;
    if (!invoke) fail(P02_DESKTOP_RELATIONSHIP_PUBLICATION_ERROR.RUNTIME_UNAVAILABLE);
    runtime = createDesktopRelationshipPublication({
      invoke,
      configOwner: typeof sync.getConfig === 'function' ? sync : null,
      localIdentity: async () => {
        const identity = H2O.Studio.identity;
        if (typeof identity?.whenReady === 'function') return identity.whenReady();
        if (typeof identity?.get === 'function') return identity.get();
        fail(P02_DESKTOP_RELATIONSHIP_PUBLICATION_ERROR.IDENTITY_UNAVAILABLE);
      }
    });
    return runtime;
  }
  const api = Object.freeze({
    schema: P02_DESKTOP_RELATIONSHIP_PUBLICATION.SCHEMA,
    publishOnce: () => current().publishOnce(),
    diagnose: () => runtime ? runtime.diagnose() : Object.freeze({
      schema: P02_DESKTOP_RELATIONSHIP_PUBLICATION.SCHEMA, installed: true, initialized: false,
      automaticPublication: 'none', webdavReachable: false
    })
  });
  H2O.Studio.sync.p02RelationshipPublication = api;
  return api;
}

installDesktopRelationshipPublication();

export { P02DesktopRelationshipPublicationError };
