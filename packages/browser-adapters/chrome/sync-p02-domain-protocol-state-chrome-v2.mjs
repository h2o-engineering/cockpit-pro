/*
 * P02 Chrome publication-side DOMAIN-QUALIFIED protocol-state derivation
 * (Mission p02-folder-relationship-synchronization, T01; R12 / C10).
 *
 * The Chrome sync-object store predates object families. Its publication
 * ledger is keyed by objectKey - SHA-256(objectDomain || 0x00 || objectId) -
 * and is therefore already domain-qualified, but its observation / apply
 * state is keyed by objectId ALONE (identityKeys() hashes the bare objectId).
 * A chat-folder-binding object shares the saved chat's objectId string, so a
 * descriptor for the binding that read `readApplySnapshot(objectId)` would
 * inherit the CHAT object's applied anchor, pending Apply and retained
 * observations, and could publish a "descendant" of a revision the binding
 * family never had.
 *
 * This module is the single seam every NEW-domain publication descriptor
 * reads protocol state through:
 *
 *   chat domain      -> exactly the reads the accepted chat enumerator makes
 *                       (readApplySnapshot(objectId) + objectKey-keyed ledger);
 *   folder / binding -> objectKey-keyed publication ledger ONLY. The
 *                       objectId-keyed apply store is NEVER consulted. Apply
 *                       state is reported as absent with a typed source, and
 *                       Chrome RECEIVE/APPLY of these families stays disabled
 *                       until domain-qualified IDB state lands (T05).
 *
 * It migrates nothing, opens no IDB upgrade, and writes nothing.
 */

import { objectKeyHex } from './sync-contract-v2.mjs';
import {
  P02_RELATIONSHIP_DOMAINS_V2,
  isRelationshipObjectDomain
} from '../../core/sync-relationship-domains-v2.mjs';

const CHAT_OBJECT_DOMAIN = P02_RELATIONSHIP_DOMAINS_V2.CHAT_OBJECT_DOMAIN;
const SHA256_RE = /^[0-9a-f]{64}$/;

export const P02_CHROME_DOMAIN_PROTOCOL_STATE_V2 = Object.freeze({
  SCHEMA: 'h2o.studio.syncChromeDomainProtocolState.p02.v1',
  CHAT_OBJECT_DOMAIN,
  APPLY_STATE_SOURCE: Object.freeze({
    /* The accepted objectId-keyed IDB apply/observation store; chat only. */
    CHAT_OBJECT_ID_STORE: 'chat-object-id-apply-store',
    /* Non-chat families: no apply state exists and none is read. */
    NONE_UNTIL_DOMAIN_QUALIFIED_IDB: 'none-until-domain-qualified-idb'
  }),
  NON_CHAT_RECEIVE: 'disabled-until-domain-qualified-idb-state',
  DIRECTION_COVERAGE: 'RELATIONSHIP_SYNC_DIRECTION_COVERAGE=CHROME_TO_DESKTOP_ONLY'
});

export const P02_CHROME_DOMAIN_PROTOCOL_STATE_ERROR = Object.freeze({
  DOMAIN_UNREGISTERED: 'p02-chrome-domain-protocol-state-domain-unregistered',
  OBJECT_ID_INVALID: 'p02-chrome-domain-protocol-state-object-id-invalid',
  STORE_INVALID: 'p02-chrome-domain-protocol-state-store-invalid',
  PROTOCOL_READ_INVALID: 'p02-chrome-domain-protocol-state-read-invalid'
});

export class P02ChromeDomainProtocolStateError extends Error {
  constructor(code) {
    super(code);
    this.name = 'P02ChromeDomainProtocolStateError';
    this.code = code;
  }
}

const fail = (code) => { throw new P02ChromeDomainProtocolStateError(code); };

function strictIdentifier(value) {
  return typeof value === 'string' &&
    Array.from(value).length > 0 &&
    Array.from(value).length <= 512 &&
    value.trim() === value &&
    !/\p{Cc}/u.test(value);
}

function reference(value) {
  if (value == null) return null;
  const revisionBlobSha256 = value.revisionBlobSha256 || value.revisionBlobSha256Hex;
  if (!strictIdentifier(value.revisionId) || !SHA256_RE.test(revisionBlobSha256 || '')) {
    fail(P02_CHROME_DOMAIN_PROTOCOL_STATE_ERROR.PROTOCOL_READ_INVALID);
  }
  return Object.freeze({ revisionId: value.revisionId, revisionBlobSha256 });
}

function requireStore(syncStore) {
  if (!syncStore ||
      typeof syncStore.readApplySnapshot !== 'function' ||
      typeof syncStore.readLocalPublicationTip !== 'function' ||
      typeof syncStore.resolveLocalPublicationPending !== 'function') {
    fail(P02_CHROME_DOMAIN_PROTOCOL_STATE_ERROR.STORE_INVALID);
  }
}

export function isRegisteredPublicationDomain(objectDomain) {
  return objectDomain === CHAT_OBJECT_DOMAIN || isRelationshipObjectDomain(objectDomain);
}

/*
 * Publication-side reads, keyed by objectKey. Identical for every family: the
 * ledger already separates domains because the key embeds the domain.
 */
async function readPublicationSide(syncStore, objectKey) {
  const [publication, localPending] = await Promise.all([
    typeof syncStore.readLocalPublicationConvergence === 'function'
      ? syncStore.readLocalPublicationConvergence(objectKey)
      : syncStore.readLocalPublicationTip(objectKey).then((tip) => ({
        tip, convergedDirection: null
      })),
    syncStore.resolveLocalPublicationPending(objectKey)
  ]);
  if (!localPending || typeof localPending.state !== 'string') {
    fail(P02_CHROME_DOMAIN_PROTOCOL_STATE_ERROR.PROTOCOL_READ_INVALID);
  }
  const tip = publication?.tip ?? null;
  return Object.freeze({
    lastPublished: reference(tip),
    publishedPayloadSha256: SHA256_RE.test(tip?.payloadSha256Hex || '')
      ? tip.payloadSha256Hex
      : null,
    convergedDirection: typeof publication?.convergedDirection === 'string'
      ? publication.convergedDirection
      : null,
    publicationPendingState: localPending.state
  });
}

/* Apply-side reads for the CHAT family only: the accepted objectId-keyed
 * store, read exactly as the chat enumerator reads it. */
async function readChatApplySide(syncStore, objectId) {
  const applySnapshot = await syncStore.readApplySnapshot(objectId);
  if (!applySnapshot || !Array.isArray(applySnapshot.observations)) {
    fail(P02_CHROME_DOMAIN_PROTOCOL_STATE_ERROR.PROTOCOL_READ_INVALID);
  }
  const applyState = applySnapshot.applyState || null;
  const lastApplied = reference(applyState?.lastApplied || null);
  const pending = applyState?.pending || null;
  return Object.freeze({
    applyStateSource: P02_CHROME_DOMAIN_PROTOCOL_STATE_V2.APPLY_STATE_SOURCE.CHAT_OBJECT_ID_STORE,
    lastApplied,
    appliedPayloadSha256: SHA256_RE.test(applyState?.lastApplied?.payloadSha256Hex || '')
      ? applyState.lastApplied.payloadSha256Hex
      : null,
    applyPending: pending !== null,
    pendingApply: pending?.referenceKind === 'branch-evidence-v2'
      ? Object.freeze({
        referenceKind: 'branch-evidence-v2',
        revisionId: pending.revisionId,
        revisionBlobSha256: pending.revisionBlobSha256Hex,
        selectedLeafRevisionId: pending.selectedLeafRevisionId,
        selectedLeafRevisionBlobSha256: pending.selectedLeafRevisionBlobSha256Hex
      })
      : null,
    retainedObservationRevisionIds: Object.freeze(
      applySnapshot.observations.map((observation) => observation.revisionId)
    )
  });
}

/* Apply-side for NON-chat families: nothing is read, nothing is inherited. */
function emptyApplySide() {
  return Object.freeze({
    applyStateSource:
      P02_CHROME_DOMAIN_PROTOCOL_STATE_V2.APPLY_STATE_SOURCE.NONE_UNTIL_DOMAIN_QUALIFIED_IDB,
    lastApplied: null,
    appliedPayloadSha256: null,
    applyPending: false,
    pendingApply: null,
    retainedObservationRevisionIds: Object.freeze([])
  });
}

/*
 * Read the protocol state one publication descriptor needs, for one
 * (objectDomain, objectId). The result shape is the descriptor's
 * `protocolState` plus the identity cells the convergence comparator reads,
 * so T02's folder/binding descriptors and the accepted chat descriptor can be
 * composed the same way.
 */
export async function readChromeDomainProtocolState({
  objectDomain,
  objectId,
  syncStore,
  cryptoImplementation = globalThis.crypto
} = {}) {
  if (!isRegisteredPublicationDomain(objectDomain)) {
    fail(P02_CHROME_DOMAIN_PROTOCOL_STATE_ERROR.DOMAIN_UNREGISTERED);
  }
  if (!strictIdentifier(objectId)) {
    fail(P02_CHROME_DOMAIN_PROTOCOL_STATE_ERROR.OBJECT_ID_INVALID);
  }
  requireStore(syncStore);
  const objectKey = await objectKeyHex(objectDomain, objectId, cryptoImplementation);
  const publication = await readPublicationSide(syncStore, objectKey);
  const apply = objectDomain === CHAT_OBJECT_DOMAIN
    ? await readChatApplySide(syncStore, objectId)
    : emptyApplySide();
  const pendingOperation = apply.applyPending
    ? 'apply'
    : (publication.publicationPendingState === 'Clean' ? null : 'publish');
  return Object.freeze({
    schema: P02_CHROME_DOMAIN_PROTOCOL_STATE_V2.SCHEMA,
    objectDomain,
    objectId,
    objectKey,
    applyStateSource: apply.applyStateSource,
    nonChatReceive: objectDomain === CHAT_OBJECT_DOMAIN
      ? null
      : P02_CHROME_DOMAIN_PROTOCOL_STATE_V2.NON_CHAT_RECEIVE,
    protocolState: Object.freeze({
      lastPublished: publication.lastPublished,
      lastApplied: apply.lastApplied,
      consumedRevisionBlobSha256: apply.lastApplied?.revisionBlobSha256 ?? null,
      pendingOperation,
      pendingApply: apply.pendingApply,
      operationPhase: publication.publicationPendingState === 'Clean'
        ? null
        : publication.publicationPendingState,
      retainedObservationRevisionIds: apply.retainedObservationRevisionIds
    }),
    identity: Object.freeze({
      direction: publication.convergedDirection,
      publishedPayloadSha256: publication.publishedPayloadSha256,
      appliedPayloadSha256: apply.appliedPayloadSha256
    }),
    pending: apply.applyPending || publication.publicationPendingState !== 'Clean'
  });
}
