/*
 * P02 T02 — Chrome relationship local-object enumeration.
 *
 * Discovers studio.folder.v1 and studio.chat-folder-binding.v1 objects from
 * the strict page-world source and describes them for the generic publication
 * machinery, beside (never instead of) the accepted saved-chat enumerator.
 *
 * Identity is (objectDomain, objectId) / objectKey throughout. A binding
 * shares the saved chat's objectId string, so every protocol-state read goes
 * through the T01 domain-qualified derivation: a relationship descriptor never
 * inherits the chat object's Apply/protocol state, and the objectId-keyed apply
 * store is never consulted for a relationship family (Chrome RECEIVE/APPLY of
 * non-chat families stays disabled until domain-qualified IDB state lands).
 *
 * FAIL CLOSED, BOUNDED. A strict-source failure yields zero relationship
 * descriptors and a typed `source-unavailable` status per family; it never
 * fabricates a descriptor from degraded state and it cannot touch the chat
 * enumeration, which runs separately. Per-object refusals are typed entries in
 * `ineligible`, never exceptions.
 *
 * Reads only. No Apply, no publication, no scheduling, no storage mutation.
 */

import {
  createReadOnlyObjectDescriptor,
  sortReadOnlyObjectDescriptors
} from '../../core/sync-object-classifier-v2.mjs';
import { createP02AnchorSet } from '../../core/sync-p02-anchor-set-v2.mjs';
import { readChromeDomainProtocolState } from './sync-p02-domain-protocol-state-chrome-v2.mjs';
import {
  P02_RELATIONSHIP_DOMAIN_V2,
  P02_RELATIONSHIP_ELIGIBILITY,
  projectChatFolderBinding,
  projectFolderCatalogState
} from './sync-revision-domain-relationship-v2.mjs';

export const P02_CHROME_RELATIONSHIP_ENUMERATION_V2 = Object.freeze({
  SCHEMA: 'h2o.studio.chromeRelationshipObjectEnumeration.p02.v1',
  SOURCE_AUTHORITY: P02_RELATIONSHIP_DOMAIN_V2.SOURCE_AUTHORITY,
  SOURCE_STATUS: Object.freeze({
    AVAILABLE: 'available',
    UNAVAILABLE: 'source-unavailable'
  }),
  ERROR: Object.freeze({
    DEPENDENCY_INVALID: 'p02-chrome-relationship-enumerator-dependency-invalid',
    ARCHIVE_READ_INVALID: 'p02-chrome-relationship-archive-read-invalid',
    SOURCE_UNAVAILABLE: 'relationship-source-unavailable',
    SOURCE_NOT_STRICT: 'relationship-source-not-strict'
  }),
  NON_CHAT_RECEIVE: 'disabled-until-domain-qualified-idb-state',
  DIRECTION_COVERAGE: P02_RELATIONSHIP_DOMAIN_V2.DIRECTION_COVERAGE
});

const FOLDER_DOMAIN = P02_RELATIONSHIP_DOMAIN_V2.FOLDER.OBJECT_DOMAIN;
const BINDING_DOMAIN = P02_RELATIONSHIP_DOMAIN_V2.BINDING.OBJECT_DOMAIN;
const SHA256_RE = /^[0-9a-f]{64}$/;
const clean = (value) => String(value == null ? '' : value).trim();
const isPlainObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

function strictIdentifier(value) {
  return typeof value === 'string' && Array.from(value).length > 0 &&
    Array.from(value).length <= 512 && value.trim() === value && !/\p{Cc}/u.test(value);
}

/* A strict source result is admitted only when the bridge tagged it as the
 * page-world authority read in strict mode. A merged, cached, fallback or
 * untagged result is refused as not-strict, which is a source failure. */
function strictEnvelope(value, listKey) {
  if (!isPlainObject(value) || value.strict !== true ||
      value.source !== P02_CHROME_RELATIONSHIP_ENUMERATION_V2.SOURCE_AUTHORITY ||
      !(listKey === 'folders' ? Array.isArray(value.folders) : isPlainObject(value.bindings))) {
    const error = new Error(P02_CHROME_RELATIONSHIP_ENUMERATION_V2.ERROR.SOURCE_NOT_STRICT);
    error.code = P02_CHROME_RELATIONSHIP_ENUMERATION_V2.ERROR.SOURCE_NOT_STRICT;
    throw error;
  }
  return value;
}

function unavailable(error) {
  return Object.freeze({
    status: P02_CHROME_RELATIONSHIP_ENUMERATION_V2.SOURCE_STATUS.UNAVAILABLE,
    authority: P02_CHROME_RELATIONSHIP_ENUMERATION_V2.SOURCE_AUTHORITY,
    code: clean(error?.code) || P02_CHROME_RELATIONSHIP_ENUMERATION_V2.ERROR.SOURCE_UNAVAILABLE,
    detail: clean(error?.message) || null
  });
}

const available = () => Object.freeze({
  status: P02_CHROME_RELATIONSHIP_ENUMERATION_V2.SOURCE_STATUS.AVAILABLE,
  authority: P02_CHROME_RELATIONSHIP_ENUMERATION_V2.SOURCE_AUTHORITY,
  code: null,
  detail: null
});

/* The same two-regime convergence rule the accepted enumerators apply. A
 * relationship family is born in the P02 regime, so in practice only the
 * direction branch and the never-published branch are reachable. */
function convergenceVerdict(canonical, identity, lastPublished) {
  const direction = clean(identity.direction);
  if (direction) {
    const anchorPayload = direction === 'published' ? clean(identity.publishedPayloadSha256)
      : direction === 'applied' ? clean(identity.appliedPayloadSha256) : '';
    if (!SHA256_RE.test(anchorPayload)) return { dirty: false, integrity: true, regime: 'p02-corrupt' };
    return { dirty: canonical.payloadSha256 !== anchorPayload, integrity: false, regime: 'p02' };
  }
  const same = !!lastPublished && lastPublished.revisionId === canonical.revisionId &&
    lastPublished.revisionBlobSha256 === canonical.revisionBlobSha256;
  return { dirty: !same, integrity: false, regime: lastPublished ? 'legacy' : 'unpublished' };
}

export function createChromeRelationshipObjectEnumerator({
  relationshipAuthority,
  archiveAuthority,
  syncStore,
  configuredSyncPeerIds,
  cryptoImplementation = globalThis.crypto
} = {}) {
  if (!relationshipAuthority ||
      typeof relationshipAuthority.listFolders !== 'function' ||
      typeof relationshipAuthority.resolveBindings !== 'function' ||
      !archiveAuthority || typeof archiveAuthority.listWorkbenchRows !== 'function' ||
      !syncStore || typeof syncStore.readLocalPublicationTip !== 'function' ||
      typeof syncStore.resolveLocalPublicationPending !== 'function' ||
      typeof syncStore.readApplySnapshot !== 'function' ||
      !Array.isArray(configuredSyncPeerIds) || configuredSyncPeerIds.length === 0 ||
      !configuredSyncPeerIds.every(strictIdentifier)) {
    throw new TypeError(P02_CHROME_RELATIONSHIP_ENUMERATION_V2.ERROR.DEPENDENCY_INVALID);
  }
  const peers = [...new Set(configuredSyncPeerIds)].sort();

  async function readFolderCatalog() {
    try {
      return { source: available(), folders: strictEnvelope(await relationshipAuthority.listFolders(), 'folders').folders };
    } catch (error) {
      return { source: unavailable(error), folders: null };
    }
  }

  async function readBindings(chatIds) {
    if (chatIds.length === 0) return { source: available(), bindings: {} };
    try {
      return { source: available(), bindings: strictEnvelope(await relationshipAuthority.resolveBindings(chatIds), 'bindings').bindings };
    } catch (error) {
      return { source: unavailable(error), bindings: null };
    }
  }

  async function subjectRows() {
    const rows = await archiveAuthority.listWorkbenchRows();
    if (!Array.isArray(rows)) {
      throw new TypeError(P02_CHROME_RELATIONSHIP_ENUMERATION_V2.ERROR.ARCHIVE_READ_INVALID);
    }
    const byChat = new Map();
    for (const row of rows) {
      const chatId = clean(row?.chatId || row?.id);
      if (!strictIdentifier(chatId) || byChat.has(chatId)) {
        throw new TypeError(P02_CHROME_RELATIONSHIP_ENUMERATION_V2.ERROR.ARCHIVE_READ_INVALID);
      }
      if (row?.isDeleted === true) continue;
      byChat.set(chatId, row);
    }
    return byChat;
  }

  async function describe(projection) {
    const descriptors = [];
    for (const syncPeerId of peers) {
      const state = await readChromeDomainProtocolState({
        objectDomain: projection.objectDomain,
        objectId: projection.objectId,
        syncStore,
        cryptoImplementation
      });
      if (state.objectKey !== projection.objectKeyHex) {
        throw new TypeError('p02-chrome-relationship-object-key-mismatch');
      }
      const canonical = {
        revisionId: projection.revisionId,
        revisionBlobSha256: projection.revisionBlobSha256Hex,
        payloadSha256: projection.payloadSha256Hex,
        deleted: false
      };
      const convergence = convergenceVerdict(canonical, state.identity, state.protocolState.lastPublished);
      const anchorProtocolState = state.protocolState.lastPublished && state.identity.publishedPayloadSha256
        ? { ...state.protocolState, lastPublished: { ...state.protocolState.lastPublished, payloadSha256: state.identity.publishedPayloadSha256 } }
        : state.protocolState;
      descriptors.push(createReadOnlyObjectDescriptor({
        objectDomain: projection.objectDomain,
        objectId: projection.objectId,
        objectKey: state.objectKey,
        syncPeerId,
        canonicalLocalHead: canonical,
        protocolState: state.protocolState,
        p02AnchorSet: state.identity.direction
          ? createP02AnchorSet({ objectDomain: projection.objectDomain, objectId: projection.objectId, protocolState: anchorProtocolState })
          : null,
        retainedEvidence: [],
        advertisedTips: [],
        dirty: convergence.dirty,
        integrityQuarantined: convergence.integrity,
        publishable: convergence.dirty && !state.pending && !convergence.integrity,
        pending: state.pending,
        blockReason: null
      }));
    }
    return descriptors;
  }

  async function projectAll() {
    const folderRead = await readFolderCatalog();
    const rows = await subjectRows();
    const chatIds = [...rows.keys()].sort();
    const bindingRead = folderRead.folders === null
      ? { source: folderRead.source, bindings: null }
      : await readBindings(chatIds);
    const projections = [];
    const ineligible = [];
    const record = (projection) => {
      if (projection.eligible) projections.push(projection);
      else ineligible.push(Object.freeze({
        objectDomain: projection.objectDomain,
        objectId: projection.objectId,
        eligibility: projection.eligibility,
        detail: projection.detail
      }));
    };
    if (folderRead.folders !== null) {
      for (const folder of folderRead.folders) {
        record(await projectFolderCatalogState(folder, { cryptoImplementation }));
      }
    }
    if (bindingRead.bindings !== null) {
      for (const chatId of chatIds) {
        record(await projectChatFolderBinding({
          chatId,
          authoritativeBinding: Object.prototype.hasOwnProperty.call(bindingRead.bindings, chatId)
            ? bindingRead.bindings[chatId]
            : { error: 'binding-not-resolved' },
          archiveRow: rows.get(chatId),
          folderCatalog: folderRead.folders,
          cryptoImplementation
        }));
      }
    }
    return { folderRead, bindingRead, projections, ineligible, subjectCount: chatIds.length };
  }

  async function enumerate() {
    const { folderRead, bindingRead, projections, ineligible, subjectCount } = await projectAll();
    const descriptors = [];
    for (const projection of projections) descriptors.push(...await describe(projection));
    const duplicates = new Set();
    for (const descriptor of descriptors) {
      const key = `${descriptor.syncPeerId}\u0000${descriptor.objectKey}`;
      if (duplicates.has(key)) throw new TypeError('p02-chrome-relationship-duplicate-object');
      duplicates.add(key);
    }
    return Object.freeze({
      schema: P02_CHROME_RELATIONSHIP_ENUMERATION_V2.SCHEMA,
      platform: 'chrome-mv3',
      source: Object.freeze({ folders: folderRead.source, bindings: bindingRead.source }),
      subjectChatCount: subjectCount,
      descriptors: sortReadOnlyObjectDescriptors(descriptors),
      ineligible: Object.freeze([...ineligible].sort((left, right) =>
        left.objectDomain.localeCompare(right.objectDomain) ||
        String(left.objectId).localeCompare(String(right.objectId)))),
      nonChatReceive: P02_CHROME_RELATIONSHIP_ENUMERATION_V2.NON_CHAT_RECEIVE,
      directionCoverage: P02_CHROME_RELATIONSHIP_ENUMERATION_V2.DIRECTION_COVERAGE
    });
  }

  /* Fresh canonical projection of ONE relationship object, re-read from the
   * strict source at call time (never a cached enumeration row). Returns null
   * when the object is currently ineligible or absent; throws with a typed
   * code when the source is unavailable. */
  async function projectObject({ objectDomain, objectId } = {}) {
    if (objectDomain !== FOLDER_DOMAIN && objectDomain !== BINDING_DOMAIN) return null;
    const { folderRead, bindingRead, projections } = await projectAll();
    const read = objectDomain === FOLDER_DOMAIN ? folderRead : bindingRead;
    if (read.source.status !== P02_CHROME_RELATIONSHIP_ENUMERATION_V2.SOURCE_STATUS.AVAILABLE) {
      const error = new Error(read.source.code);
      error.code = read.source.code;
      throw error;
    }
    return projections.find((projection) =>
      projection.objectDomain === objectDomain && projection.objectId === objectId) ?? null;
  }

  return Object.freeze({ enumerate, projectObject });
}
