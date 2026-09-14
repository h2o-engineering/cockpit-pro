/*
 * P02 T02 — folder and chat-folder-binding domain adapters (Chrome projection).
 *
 * Same shape as the first domain adapter (sync-revision-domain-chat-v2.mjs):
 * each adapter knows exactly its objectDomain, its objectId rule and the
 * canonical payload of its family, and hands an already-canonical payload to
 * the generic revision core. Envelope, parent-pair rule, canonical bytes,
 * hashes, objectKey, heads and transport stay in the frozen core; nothing
 * here is a second Sync engine.
 *
 * SOURCE. The projections take the owner-designated page-world authority as
 * READ by the strict Chrome bridge (`H2O.folders.list()` records and
 * `H2O.folders.getBinding(chatId)` results). They never read chrome.storage,
 * the legacy FOLDER_STATE mirror, caches, archive-derived catalogs or any
 * fallback helper output; those are not accepted as input shapes at all.
 * The archive row of the subject chat is consulted for ONE thing: a
 * consistency cross-check of the stamped folderId. Disagreement is a typed
 * ineligibility, never a guessed winner.
 *
 * DETERMINISM. Same authoritative source state -> byte-identical canonical
 * payload (canonical JSON of an exact-key set). Timestamps never enter the
 * payload except folder `createdAt` (provenance only, derived from the
 * authoritative source epoch); the head's sourceUpdatedAtIso is derived from
 * durable source data, never a wall clock.
 *
 * COLOR_ADMISSION=DEFERRED_PENDING_SHARED_COLOR_VOCABULARY: colour is never
 * projected. Nothing here writes anything.
 */

import {
  P02_RELATIONSHIP_DOMAINS_V2,
  canonicalFolderName,
  isChatObjectId,
  isFolderObjectId,
  validateChatFolderBindingPayload,
  validateFolderCatalogStatePayload
} from '../../core/sync-relationship-domains-v2.mjs';
import { canonicalJson, objectKeyHex } from './sync-contract-v2.mjs';
import {
  P02_REVISION_PRODUCTION_ERROR,
  descendantParent,
  produceRevisionV2,
  rootParent
} from './sync-revision-production-v2.mjs';

const FOLDER = P02_RELATIONSHIP_DOMAINS_V2.FOLDER;
const BINDING = P02_RELATIONSHIP_DOMAINS_V2.BINDING;

export const P02_RELATIONSHIP_DOMAIN_V2 = Object.freeze({
  SCHEMA: 'h2o.studio.syncRevisionDomainAdapter.relationship.p02.v1',
  FOLDER: Object.freeze({
    OBJECT_DOMAIN: FOLDER.OBJECT_DOMAIN,
    PAYLOAD_SCHEMA: FOLDER.PAYLOAD_SCHEMA,
    ADAPTER_SCHEMA: 'h2o.studio.syncRevisionDomainAdapter.folder.p02.v1'
  }),
  BINDING: Object.freeze({
    OBJECT_DOMAIN: BINDING.OBJECT_DOMAIN,
    PAYLOAD_SCHEMA: BINDING.PAYLOAD_SCHEMA,
    ADAPTER_SCHEMA: 'h2o.studio.syncRevisionDomainAdapter.chatFolderBinding.p02.v1'
  }),
  /* The only admitted canonical source, as tagged by the strict bridge. */
  SOURCE_AUTHORITY: 'H2O.folders',
  /* Reserved folder view keys (0F3a CFG_RESERVED_FOLDER_VIEW_NAMES plus the
   * unfiled pseudo-folder); matched case-insensitively against id and name. */
  RESERVED_FOLDER_KEYS: Object.freeze(['unfiled', 'pinned', 'archive']),
  /* Deterministic local-source identity of a relationship state: the hash of
   * its own canonical payload, so identical state always names itself the
   * same way and never collides with an engine mint (`p02-…`). */
  LOCAL_SOURCE_REVISION_PREFIX: 'relstate-',
  COLOR_ADMISSION: P02_RELATIONSHIP_DOMAINS_V2.COLOR_ADMISSION,
  DIRECTION_COVERAGE: 'RELATIONSHIP_SYNC_DIRECTION_COVERAGE=CHROME_TO_DESKTOP_ONLY'
});

export const P02_RELATIONSHIP_ELIGIBILITY = Object.freeze({
  ELIGIBLE: 'eligible',
  NOT_ELIGIBLE_PROJECT_BACKED: 'not-eligible(project-backed)',
  NOT_ELIGIBLE_SYSTEM: 'not-eligible(system)',
  NOT_ELIGIBLE_RESERVED: 'not-eligible(reserved)',
  NOT_ELIGIBLE_BINDING_SOURCE_DISAGREEMENT: 'not-eligible(binding-source-disagreement)',
  SOURCE_UNAVAILABLE: 'source-unavailable',
  INVALID_SOURCE_RECORD: 'invalid-source-record',
  CONTRACT_INVALID: 'contract-invalid'
});

export const P02_RELATIONSHIP_DOMAIN_ERROR = Object.freeze({
  DOMAIN_UNREGISTERED: 'p02-t02-relationship-domain-unregistered',
  CANONICAL_STATE_INVALID: 'p02-t02-relationship-canonical-state-invalid',
  OBJECT_NOT_ELIGIBLE: 'p02-t02-relationship-object-not-eligible',
  PAYLOAD_NOT_CANONICAL: 'p02-t02-relationship-payload-not-canonical'
});

export class P02RelationshipDomainAdapterError extends Error {
  constructor(code, detail = null) {
    super(code);
    this.name = 'P02RelationshipDomainAdapterError';
    this.code = code;
    if (detail) this.detail = detail;
  }
}

const fail = (code, detail) => { throw new P02RelationshipDomainAdapterError(code, detail); };
const isPlainObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const clean = (value) => String(value == null ? '' : value).trim();
const encoder = new TextEncoder();

const ineligible = (objectDomain, objectId, eligibility, detail) => Object.freeze({
  eligible: false, eligibility, detail: detail ?? null, objectDomain, objectId: objectId ?? null
});

/* ISO-8601 UTC milliseconds from an authoritative epoch: a finite positive
 * millisecond number or a parseable timestamp string. Anything else is
 * "absent" - never coerced, never invented. */
export function isoFromSourceEpoch(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value > 0 ? new Date(value).toISOString() : null;
  }
  const text = clean(value);
  if (!text) return null;
  const milliseconds = Date.parse(text);
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : null;
}

function reservedKey(value) {
  return P02_RELATIONSHIP_DOMAIN_V2.RESERVED_FOLDER_KEYS.includes(clean(value).toLowerCase());
}

async function sha256Hex(bytes, cryptoImplementation) {
  if (!cryptoImplementation?.subtle || typeof cryptoImplementation.subtle.digest !== 'function') {
    fail(P02_REVISION_PRODUCTION_ERROR.CRYPTO_UNAVAILABLE);
  }
  const digest = await cryptoImplementation.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function finishProjection({ objectDomain, objectId, payload, sourceUpdatedAtIso, cryptoImplementation }) {
  const payloadText = canonicalJson(payload);
  const payloadCanonicalBytes = encoder.encode(payloadText);
  const payloadSha256Hex = await sha256Hex(payloadCanonicalBytes, cryptoImplementation);
  return Object.freeze({
    eligible: true,
    eligibility: P02_RELATIONSHIP_ELIGIBILITY.ELIGIBLE,
    detail: null,
    objectDomain,
    objectId,
    objectKeyHex: await objectKeyHex(objectDomain, objectId, cryptoImplementation),
    payload: Object.freeze(JSON.parse(payloadText)),
    payloadText,
    payloadSha256Hex,
    /* The local canonical identity of this relationship state. */
    revisionId: `${P02_RELATIONSHIP_DOMAIN_V2.LOCAL_SOURCE_REVISION_PREFIX}${payloadSha256Hex}`,
    revisionBlobSha256Hex: payloadSha256Hex,
    sourceUpdatedAtIso,
    sourceAuthority: P02_RELATIONSHIP_DOMAIN_V2.SOURCE_AUTHORITY
  });
}

/*
 * studio.folder.v1 from one authoritative `H2O.folders.list()` record.
 * Eligibility (first slice): local user-created folders only.
 */
export async function projectFolderCatalogState(record, {
  cryptoImplementation = globalThis.crypto
} = {}) {
  const domain = FOLDER.OBJECT_DOMAIN;
  const E = P02_RELATIONSHIP_ELIGIBILITY;
  if (!isPlainObject(record)) return ineligible(domain, null, E.INVALID_SOURCE_RECORD, 'record-not-object');
  const id = record.id ?? record.folderId;
  if (typeof id !== 'string' || clean(id) === '') {
    return ineligible(domain, null, E.INVALID_SOURCE_RECORD, 'folder-id-missing');
  }
  const objectId = id;
  const kind = clean(record.kind).toLowerCase();
  const projectRef = record.projectRef;
  if (kind === 'project_backed' || (projectRef !== undefined && projectRef !== null && projectRef !== '')) {
    return ineligible(domain, objectId, E.NOT_ELIGIBLE_PROJECT_BACKED, 'project-backed');
  }
  if (record.system === true || record.virtual === true || record.view === true ||
      ['system', 'virtual', 'view', 'smart'].includes(kind) ||
      ['system', 'virtual', 'view', 'smart'].includes(clean(record.sourceKind).toLowerCase())) {
    return ineligible(domain, objectId, E.NOT_ELIGIBLE_SYSTEM, 'system-or-virtual-view');
  }
  if (kind !== '' && kind !== 'local') {
    return ineligible(domain, objectId, E.NOT_ELIGIBLE_SYSTEM, `unknown-kind:${kind}`);
  }
  const parentId = clean(record.parentId ?? record.parent_id);
  if (parentId) {
    return ineligible(domain, objectId, E.NOT_ELIGIBLE_SYSTEM, 'hierarchy-entry');
  }
  const name = canonicalFolderName(typeof record.name === 'string' ? record.name
    : typeof record.title === 'string' ? record.title : '');
  if (reservedKey(objectId) || reservedKey(name)) {
    return ineligible(domain, objectId, E.NOT_ELIGIBLE_RESERVED, 'reserved-folder-key');
  }
  if (!isFolderObjectId(objectId)) {
    return ineligible(domain, objectId, E.CONTRACT_INVALID, 'p02-rel-folder-id-invalid');
  }
  const sourceUpdatedAtIso = isoFromSourceEpoch(record.updatedAt) ?? isoFromSourceEpoch(record.createdAt);
  if (!sourceUpdatedAtIso) {
    return ineligible(domain, objectId, E.INVALID_SOURCE_RECORD, 'source-timestamp-missing');
  }
  const createdAt = isoFromSourceEpoch(record.createdAt);
  const payload = { schema: FOLDER.PAYLOAD_SCHEMA, folderId: objectId, name };
  if (createdAt) payload.createdAt = createdAt;
  try {
    validateFolderCatalogStatePayload(payload, objectId);
  } catch (error) {
    return ineligible(domain, objectId, E.CONTRACT_INVALID, clean(error?.code) || 'contract-invalid');
  }
  return finishProjection({ objectDomain: domain, objectId, payload, sourceUpdatedAtIso, cryptoImplementation });
}

/*
 * studio.chat-folder-binding.v1 for one subject chat.
 *
 *   chatId               canonical chat objectId (same string as the chat family)
 *   authoritativeBinding strict `H2O.folders.getBinding(chatId)` result
 *                        ({ folderId: '' | id, folderName }); '' = unfiled
 *   archiveRow           the accepted archive row of the subject chat; its
 *                        stamped folderId is a consistency CROSS-CHECK only
 *   folderCatalog        the authoritative folder records read in the same
 *                        pass (eligibility of the referenced folder)
 */
export async function projectChatFolderBinding({
  chatId,
  authoritativeBinding,
  archiveRow = null,
  folderCatalog = null,
  cryptoImplementation = globalThis.crypto
} = {}) {
  const domain = BINDING.OBJECT_DOMAIN;
  const E = P02_RELATIONSHIP_ELIGIBILITY;
  if (!isChatObjectId(chatId)) return ineligible(domain, null, E.INVALID_SOURCE_RECORD, 'chat-id-invalid');
  const objectId = chatId;
  if (!isPlainObject(authoritativeBinding) || clean(authoritativeBinding.error)) {
    return ineligible(domain, objectId, E.INVALID_SOURCE_RECORD,
      clean(authoritativeBinding?.error) || 'binding-record-not-object');
  }
  if (authoritativeBinding.folderId !== null && authoritativeBinding.folderId !== undefined &&
      typeof authoritativeBinding.folderId !== 'string') {
    return ineligible(domain, objectId, E.INVALID_SOURCE_RECORD, 'binding-folder-id-not-string');
  }
  const authoritativeFolderId = clean(authoritativeBinding.folderId);

  /* Cross-check: the archive row's stamped folderId must agree exactly with
   * the authority. A row without a string stamp offers no cross-check. */
  if (isPlainObject(archiveRow) && typeof archiveRow.folderId === 'string' &&
      clean(archiveRow.folderId) !== authoritativeFolderId) {
    return ineligible(domain, objectId, E.NOT_ELIGIBLE_BINDING_SOURCE_DISAGREEMENT,
      `archive:${clean(archiveRow.folderId) || '(unfiled)'}!=authority:${authoritativeFolderId || '(unfiled)'}`);
  }

  if (authoritativeFolderId) {
    if (!isFolderObjectId(authoritativeFolderId)) {
      return ineligible(domain, objectId, E.CONTRACT_INVALID, 'p02-rel-binding-folder-id-invalid');
    }
    if (Array.isArray(folderCatalog)) {
      const referenced = folderCatalog.find((record) =>
        isPlainObject(record) && clean(record.id ?? record.folderId) === authoritativeFolderId) ?? null;
      if (!referenced) {
        return ineligible(domain, objectId, E.INVALID_SOURCE_RECORD, 'referenced-folder-unknown');
      }
      const folderProjection = await projectFolderCatalogState(referenced, { cryptoImplementation });
      if (!folderProjection.eligible) {
        return ineligible(domain, objectId, folderProjection.eligibility,
          `referenced-folder:${folderProjection.detail || folderProjection.eligibility}`);
      }
    }
  }

  /* Head provenance from the accepted archive authority's durable row data;
   * the page binding model carries no per-binding timestamp of its own. */
  const sourceUpdatedAtIso = isoFromSourceEpoch(archiveRow?.updatedAt) ??
    isoFromSourceEpoch(archiveRow?.createdAt);
  if (!sourceUpdatedAtIso) {
    return ineligible(domain, objectId, E.INVALID_SOURCE_RECORD, 'source-timestamp-missing');
  }
  const payload = {
    schema: BINDING.PAYLOAD_SCHEMA,
    chatId: objectId,
    folderId: authoritativeFolderId || null
  };
  try {
    validateChatFolderBindingPayload(payload, objectId);
  } catch (error) {
    return ineligible(domain, objectId, E.CONTRACT_INVALID, clean(error?.code) || 'contract-invalid');
  }
  return finishProjection({ objectDomain: domain, objectId, payload, sourceUpdatedAtIso, cryptoImplementation });
}

export function isRelationshipDomain(objectDomain) {
  return objectDomain === FOLDER.OBJECT_DOMAIN || objectDomain === BINDING.OBJECT_DOMAIN;
}

function validatePayloadFor(objectDomain, payload, objectId) {
  if (objectDomain === FOLDER.OBJECT_DOMAIN) return validateFolderCatalogStatePayload(payload, objectId);
  if (objectDomain === BINDING.OBJECT_DOMAIN) return validateChatFolderBindingPayload(payload, objectId);
  fail(P02_RELATIONSHIP_DOMAIN_ERROR.DOMAIN_UNREGISTERED, objectDomain);
}

/*
 * Map a projected relationship state onto the generic production input,
 * exactly as the chat adapter does: the envelope revisionId is the engine
 * mint supplied by the caller; the payload is validated strictly against the
 * T01 contract before the core sees it; a non-null parent must name a
 * proven immutable P02 revision.
 */
export async function produceRelationshipRevisionV2({
  objectDomain,
  canonicalObject,
  writerSyncPeerId,
  p02Parent = null,
  cryptoImplementation = globalThis.crypto
} = {}) {
  if (!isRelationshipDomain(objectDomain)) {
    fail(P02_RELATIONSHIP_DOMAIN_ERROR.DOMAIN_UNREGISTERED, objectDomain);
  }
  if (!isPlainObject(canonicalObject) || !isPlainObject(canonicalObject.payload) ||
      !clean(canonicalObject.objectId) || !clean(canonicalObject.revisionId)) {
    fail(P02_RELATIONSHIP_DOMAIN_ERROR.CANONICAL_STATE_INVALID);
  }
  const objectId = clean(canonicalObject.objectId);
  const revisionId = clean(canonicalObject.revisionId);
  const payload = canonicalObject.payload;
  try {
    validatePayloadFor(objectDomain, payload, objectId);
  } catch (error) {
    if (error?.code === P02_RELATIONSHIP_DOMAIN_ERROR.DOMAIN_UNREGISTERED) throw error;
    fail(P02_RELATIONSHIP_DOMAIN_ERROR.PAYLOAD_NOT_CANONICAL, clean(error?.code) || null);
  }
  const parent = p02Parent === null
    ? rootParent()
    : descendantParent({
      previousRevisionId: p02Parent.previousRevisionId,
      previousRevisionBlobSha256: p02Parent.previousRevisionBlobSha256,
      provenP02Parent: p02Parent.provenP02Parent
    });
  const produced = await produceRevisionV2({
    objectDomain,
    objectId,
    revisionId,
    writerSyncPeerId,
    payload,
    parent,
    cryptoImplementation
  });
  return Object.freeze({
    ...produced,
    adapterSchema: objectDomain === FOLDER.OBJECT_DOMAIN
      ? P02_RELATIONSHIP_DOMAIN_V2.FOLDER.ADAPTER_SCHEMA
      : P02_RELATIONSHIP_DOMAIN_V2.BINDING.ADAPTER_SCHEMA
  });
}

export { P02_REVISION_PRODUCTION_ERROR };
