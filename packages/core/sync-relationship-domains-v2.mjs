/*
 * P02 folder-relationship families — domain registration and strict payload
 * contracts (Mission p02-folder-relationship-synchronization, T01).
 *
 * Two ADDITIVE object families join the saved-chat family on the unchanged v2
 * protocol (envelope, heads layout, repository format, protocolVersion,
 * formatVersion, layoutEpoch and writer generation are all untouched):
 *
 *   studio.folder.v1               payload h2o.studio.folderCatalogState.v1
 *   studio.chat-folder-binding.v1  payload h2o.studio.chatFolderBinding.v1
 *
 * The saved-chat family (studio.chat.saved-state.v1 / h2o.studio.fullBundle.v2)
 * is referenced here for domain separation only; its payload contract lives
 * in sync-object-projection.mjs and is not redefined.
 *
 * Identity (HDA folder identity ruling, 2026-09-14): a folder objectId is the
 * H2O folder catalog id minted once by the creating surface (f_…,
 * fold_chrome_…, fold_<uuid>), adopted verbatim, grammar
 * ^[A-Za-z0-9_.:-]{1,160}$. Names are metadata and never identity. A binding
 * objectId is the canonical chatId — the same objectId STRING as the chat
 * family — and the two objectKeys differ because
 * objectKey = SHA-256(objectDomain ‖ 0x00 ‖ objectId).
 *
 * Validation here is STRICT and NEVER normalizes: a payload whose bytes are
 * not already canonical is a typed refusal, because a receiving surface that
 * "fixed" a value would fabricate a revision. `canonicalFolderName` is offered
 * to PROJECTORS (the source side) so they can emit the canonical form; the
 * validators require that form and refuse anything else.
 *
 * TIMESTAMPS NEVER ENTER A CANONICAL PAYLOAD (T05, RC-P02-T05-D1-01, Library
 * owner decision 2026-09-21). The folder payload is exactly
 * schema/folderId/name; `createdAt` is PROHIBITED and refused like any other
 * unknown key. Authoritative source `updatedAt` (with the authoritative
 * `createdAt` as fallback) may contribute ONLY to the head's
 * sourceUpdatedAtIso metadata, and receiver-local created_at/updated_at are
 * local persistence metadata that must never become payload bytes: a payload
 * carrying a timestamp would give byte-identical relationship state a new
 * digest after every Apply and produce a false echo.
 *
 * COLOR_ADMISSION=DEFERRED_PENDING_SHARED_COLOR_VOCABULARY: colour is not a
 * payload key in this slice and is rejected like any other unknown key.
 *
 * Pure module: no store, no transport, no platform detection.
 */

const CHAT_OBJECT_DOMAIN = 'studio.chat.saved-state.v1';
const FOLDER_OBJECT_DOMAIN = 'studio.folder.v1';
const FOLDER_PAYLOAD_SCHEMA = 'h2o.studio.folderCatalogState.v1';
const BINDING_OBJECT_DOMAIN = 'studio.chat-folder-binding.v1';
const BINDING_PAYLOAD_SCHEMA = 'h2o.studio.chatFolderBinding.v1';

const FOLDER_ID_RE = /^[A-Za-z0-9_.:-]{1,160}$/;
const FOLDER_ID_MAX_LENGTH = 160;
const FOLDER_NAME_MAX_CODE_POINTS = 200;
/* Same identity grammar the v2 envelope contract already enforces for every
 * objectId (sync-contract-v2.mjs strict identifier): 1..512 code points,
 * trimmed, no Unicode control character. */
const CHAT_ID_MAX_LENGTH = 512;
const CONTROL_RE = /\p{Cc}/u;
const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
/* Keys that are timestamps or provenance on some source surface and are
 * therefore the most likely to be projected into a payload by mistake. They
 * are refused exactly like any other unknown key; the list exists only so the
 * contract can NAME the prohibition (D1) rather than rely on omission. */
const FOLDER_PROHIBITED_KEYS = Object.freeze(['createdAt', 'updatedAt', 'created_at', 'updated_at']);

export const P02_RELATIONSHIP_DOMAINS_V2 = Object.freeze({
  SCHEMA: 'h2o.studio.syncRelationshipDomains.p02.v1',
  CHAT_OBJECT_DOMAIN,
  FOLDER: Object.freeze({
    OBJECT_DOMAIN: FOLDER_OBJECT_DOMAIN,
    PAYLOAD_SCHEMA: FOLDER_PAYLOAD_SCHEMA,
    REQUIRED_KEYS: Object.freeze(['schema', 'folderId', 'name']),
    /* T05 D1: the exact key set IS the required set. Nothing is optional. */
    OPTIONAL_KEYS: Object.freeze([]),
    PROHIBITED_KEYS: FOLDER_PROHIBITED_KEYS,
    /* Where source time may go: the head, never the payload. */
    SOURCE_TIMESTAMP_RULE: 'updatedAt-then-createdAt-to-sourceUpdatedAtIso-head-metadata-only',
    ID_GRAMMAR: FOLDER_ID_RE.source,
    ID_MAX_LENGTH: FOLDER_ID_MAX_LENGTH,
    NAME_MAX_CODE_POINTS: FOLDER_NAME_MAX_CODE_POINTS
  }),
  BINDING: Object.freeze({
    OBJECT_DOMAIN: BINDING_OBJECT_DOMAIN,
    PAYLOAD_SCHEMA: BINDING_PAYLOAD_SCHEMA,
    REQUIRED_KEYS: Object.freeze(['schema', 'chatId', 'folderId']),
    OPTIONAL_KEYS: Object.freeze([]),
    /* folderId: null is the Unfile LIVE state — not deletion, not a tombstone. */
    UNFILED_FOLDER_ID: null
  }),
  RELATIONSHIP_OBJECT_DOMAINS: Object.freeze([FOLDER_OBJECT_DOMAIN, BINDING_OBJECT_DOMAIN]),
  COLOR_ADMISSION: 'DEFERRED_PENDING_SHARED_COLOR_VOCABULARY'
});

export const P02_RELATIONSHIP_DOMAIN_ERROR = Object.freeze({
  DOMAIN_UNREGISTERED: 'p02-rel-domain-unregistered',
  FOLDER_PAYLOAD_SHAPE_INVALID: 'p02-rel-folder-payload-shape-invalid',
  FOLDER_PAYLOAD_KEY_REJECTED: 'p02-rel-folder-payload-key-rejected',
  FOLDER_SCHEMA_MISMATCH: 'p02-rel-folder-schema-mismatch',
  FOLDER_ID_INVALID: 'p02-rel-folder-id-invalid',
  FOLDER_ID_OBJECT_ID_MISMATCH: 'p02-rel-folder-id-object-id-mismatch',
  FOLDER_NAME_INVALID: 'p02-rel-folder-name-invalid',
  BINDING_PAYLOAD_SHAPE_INVALID: 'p02-rel-binding-payload-shape-invalid',
  BINDING_PAYLOAD_KEY_REJECTED: 'p02-rel-binding-payload-key-rejected',
  BINDING_SCHEMA_MISMATCH: 'p02-rel-binding-schema-mismatch',
  BINDING_CHAT_ID_INVALID: 'p02-rel-binding-chat-id-invalid',
  BINDING_CHAT_ID_OBJECT_ID_MISMATCH: 'p02-rel-binding-chat-id-object-id-mismatch',
  BINDING_FOLDER_ID_INVALID: 'p02-rel-binding-folder-id-invalid'
});

export class P02RelationshipDomainError extends Error {
  constructor(code, detail = null) {
    super(code);
    this.name = 'P02RelationshipDomainError';
    this.code = code;
    if (detail && typeof detail === 'object') Object.assign(this, detail);
  }
}

function fail(code, detail) {
  throw new P02RelationshipDomainError(code, detail);
}

function isPlainObject(value) {
  return value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.prototype.toString.call(value) === '[object Object]';
}

function own(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

/* Exact-key check that names the offending key: unknown keys are refused
 * one at a time with the key attached, missing required keys are a shape
 * refusal. Both are typed; neither is repaired. */
function requireExactKeys(payload, required, optional, shapeCode, keyCode) {
  if (!isPlainObject(payload)) fail(shapeCode);
  const admitted = new Set([...required, ...optional]);
  for (const key of Object.keys(payload)) {
    if (!admitted.has(key)) fail(keyCode, { key });
  }
  for (const key of required) {
    if (!own(payload, key)) fail(shapeCode, { key });
  }
}

export function isFolderObjectId(value) {
  return typeof value === 'string' && FOLDER_ID_RE.test(value);
}

/* The envelope objectId rule, restated exactly (the binding objectId IS the
 * chat family's objectId string). */
export function isChatObjectId(value) {
  if (typeof value !== 'string') return false;
  const codePoints = Array.from(value).length;
  return codePoints > 0 &&
    codePoints <= CHAT_ID_MAX_LENGTH &&
    value.trim() === value &&
    !CONTROL_RE.test(value);
}

/* Canonical name form for PROJECTORS: Unicode whitespace runs collapse to one
 * space, then trim. Returns '' for a value with no visible content. Not a
 * validator - validators require the output of this function verbatim. */
export function canonicalFolderName(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/gu, ' ').trim();
}

export function isCanonicalFolderName(value) {
  if (typeof value !== 'string' || value.length === 0) return false;
  if (/\p{Cc}/u.test(value)) return false;
  if (canonicalFolderName(value) !== value) return false;
  return Array.from(value).length <= FOLDER_NAME_MAX_CODE_POINTS;
}

/* ISO-8601 UTC milliseconds, calendar-valid: the string must round-trip
 * through the platform date parser unchanged. */
export function isUtcMillisecondTimestamp(value) {
  if (typeof value !== 'string' || !TIMESTAMP_RE.test(value)) return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

export function validateFolderCatalogStatePayload(payload, objectId) {
  const E = P02_RELATIONSHIP_DOMAIN_ERROR;
  const F = P02_RELATIONSHIP_DOMAINS_V2.FOLDER;
  requireExactKeys(payload, F.REQUIRED_KEYS, F.OPTIONAL_KEYS,
    E.FOLDER_PAYLOAD_SHAPE_INVALID, E.FOLDER_PAYLOAD_KEY_REJECTED);
  if (payload.schema !== FOLDER_PAYLOAD_SCHEMA) fail(E.FOLDER_SCHEMA_MISMATCH);
  if (!isFolderObjectId(payload.folderId)) fail(E.FOLDER_ID_INVALID);
  if (payload.folderId !== objectId) fail(E.FOLDER_ID_OBJECT_ID_MISMATCH);
  if (!isCanonicalFolderName(payload.name)) fail(E.FOLDER_NAME_INVALID);
  return Object.freeze({
    objectDomain: FOLDER_OBJECT_DOMAIN,
    objectId,
    folderId: payload.folderId,
    name: payload.name
  });
}

export function validateChatFolderBindingPayload(payload, objectId) {
  const E = P02_RELATIONSHIP_DOMAIN_ERROR;
  const B = P02_RELATIONSHIP_DOMAINS_V2.BINDING;
  requireExactKeys(payload, B.REQUIRED_KEYS, B.OPTIONAL_KEYS,
    E.BINDING_PAYLOAD_SHAPE_INVALID, E.BINDING_PAYLOAD_KEY_REJECTED);
  if (payload.schema !== BINDING_PAYLOAD_SCHEMA) fail(E.BINDING_SCHEMA_MISMATCH);
  if (!isChatObjectId(payload.chatId)) fail(E.BINDING_CHAT_ID_INVALID);
  if (payload.chatId !== objectId) fail(E.BINDING_CHAT_ID_OBJECT_ID_MISMATCH);
  if (payload.folderId !== null && !isFolderObjectId(payload.folderId)) {
    fail(E.BINDING_FOLDER_ID_INVALID);
  }
  return Object.freeze({
    objectDomain: BINDING_OBJECT_DOMAIN,
    objectId,
    chatId: payload.chatId,
    folderId: payload.folderId,
    unfiled: payload.folderId === null
  });
}

export function isRelationshipObjectDomain(objectDomain) {
  return P02_RELATIONSHIP_DOMAINS_V2.RELATIONSHIP_OBJECT_DOMAINS.includes(objectDomain);
}

/* Registry lookup: the chat family is registered (so callers can dispatch on
 * every known domain) but its payload contract is owned elsewhere. */
export function relationshipDomainDescriptor(objectDomain) {
  switch (objectDomain) {
    case FOLDER_OBJECT_DOMAIN:
      return Object.freeze({
        objectDomain,
        payloadSchema: FOLDER_PAYLOAD_SCHEMA,
        family: 'folder',
        validatePayload: validateFolderCatalogStatePayload
      });
    case BINDING_OBJECT_DOMAIN:
      return Object.freeze({
        objectDomain,
        payloadSchema: BINDING_PAYLOAD_SCHEMA,
        family: 'chat-folder-binding',
        validatePayload: validateChatFolderBindingPayload
      });
    case CHAT_OBJECT_DOMAIN:
      return Object.freeze({
        objectDomain,
        payloadSchema: 'h2o.studio.fullBundle.v2',
        family: 'chat',
        validatePayload: null
      });
    default:
      fail(P02_RELATIONSHIP_DOMAIN_ERROR.DOMAIN_UNREGISTERED, { objectDomain });
  }
}

export function validateRelationshipPayload(objectDomain, payload, objectId) {
  const descriptor = relationshipDomainDescriptor(objectDomain);
  if (typeof descriptor.validatePayload !== 'function') {
    fail(P02_RELATIONSHIP_DOMAIN_ERROR.DOMAIN_UNREGISTERED, { objectDomain });
  }
  return descriptor.validatePayload(payload, objectId);
}
