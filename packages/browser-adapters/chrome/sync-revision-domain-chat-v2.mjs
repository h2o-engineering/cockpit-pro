/*
 * P02 V8-A — saved-chat domain adapter for generic v2 revision production.
 *
 * This is the FIRST domain adapter, not part of the revision core. It knows
 * exactly three chat-specific things:
 *
 *   objectDomain      = 'studio.chat.saved-state.v1'
 *   objectId          = chatId
 *   payload source id = snapshotId
 *
 * That third line used to read `revisionId = snapshotId`, and RATIFIED N1 v1.2
 * withdrew it: the envelope revisionId is engine-minted (§D.1) and is never
 * equal to a domain source id (§D.2). What this adapter still owns is the
 * PAYLOAD's own source identity - snapshotId - which is what canonical state is
 * keyed by. The code below has implemented the ratified rule since the mint
 * landed; this header had not caught up, and a stale contract reference at the
 * top of a domain adapter is exactly what a future family would copy.
 *
 * plus the accepted content-only payload shape for this family. Everything
 * else — envelope, parent-pair rule, canonical bytes, hashes, object key —
 * belongs to the generic core and the frozen contract module.
 *
 * A future family (chat-note, folder, folder-binding, label, tag, category,
 * asset, …) ships its own adapter of this shape and reuses the same core: it
 * supplies registered domain identity plus an already-canonical payload, and
 * changes no revision, writer, heads, pointer or transport logic.
 *
 * The adapter reads no database and no filesystem. Canonical durable state is
 * injected by the caller, so the work-authority boundary stays outside V8-A.
 */

import {
  CANONICAL_SYNC_OBJECT_PROJECTION_CONSTANTS,
  validateContentOnlyPayload
} from '../../core/sync-object-projection.mjs';
import { payloadSourceRevisionId } from '../../core/sync-p02-revision-mint-v2.mjs';
import {
  P02_REVISION_PRODUCTION_ERROR,
  descendantParent,
  produceRevisionV2,
  rootParent
} from './sync-revision-production-v2.mjs';

/* §D.2 chat saved-state binding. */
export const P02_CHAT_DOMAIN_V2 = Object.freeze({
  OBJECT_DOMAIN: CANONICAL_SYNC_OBJECT_PROJECTION_CONSTANTS.OBJECT_DOMAIN,
  PAYLOAD_SCHEMA: CANONICAL_SYNC_OBJECT_PROJECTION_CONSTANTS.PAYLOAD_SCHEMA,
  ADAPTER_SCHEMA: 'h2o.studio.syncRevisionDomainAdapter.chat.p02.v1'
});

export const P02_CHAT_DOMAIN_ERROR = Object.freeze({
  CANONICAL_STATE_INVALID: 'p02-v8a-chat-canonical-state-invalid',
  OBJECT_NOT_ELIGIBLE: 'p02-v8a-chat-object-not-eligible',
  PAYLOAD_NOT_CANONICAL: 'p02-v8a-chat-payload-not-canonical'
});

export class P02ChatDomainError extends Error {
  constructor(code) {
    super(code);
    this.name = 'P02ChatDomainError';
    this.code = code;
  }
}

function fail(code) {
  throw new P02ChatDomainError(code);
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const clean = (value) => String(value == null ? '' : value).trim();

/*
 * Eligibility is a domain/work-authority question, deliberately answered here
 * rather than in the core. A canonical row carrying an unresolved integrity or
 * conflict error is never a publication candidate merely because it exists.
 */
export function chatObjectEligibility(canonicalObject) {
  if (!isPlainObject(canonicalObject)) {
    return Object.freeze({ eligible: false, reason: P02_CHAT_DOMAIN_ERROR.CANONICAL_STATE_INVALID });
  }
  const objectId = clean(canonicalObject.objectId);
  const revisionId = clean(canonicalObject.revisionId);
  if (!objectId || !revisionId || !isPlainObject(canonicalObject.payload)) {
    return Object.freeze({ eligible: false, reason: P02_CHAT_DOMAIN_ERROR.CANONICAL_STATE_INVALID });
  }
  if (clean(canonicalObject.lastErrorCode)) {
    return Object.freeze({
      eligible: false,
      reason: P02_CHAT_DOMAIN_ERROR.OBJECT_NOT_ELIGIBLE,
      lastErrorCode: clean(canonicalObject.lastErrorCode)
    });
  }
  return Object.freeze({ eligible: true, reason: null, objectId, revisionId });
}

/*
 * Map canonical durable chat state onto the generic production input.
 *
 * `p02Parent` is null for the first P02 publication of this object — including
 * an object that already carries P01 history, which becomes a v2 ROOT under the
 * cutover rule. A non-null parent must name a proven immutable P02 revision;
 * P01 identifiers are never accepted here, because the core requires an
 * explicit proven-parent assertion to build a descendant.
 */
export async function produceChatRevisionV2({
  canonicalObject,
  writerSyncPeerId,
  p02Parent = null,
  cryptoImplementation = globalThis.crypto
} = {}) {
  const eligibility = chatObjectEligibility(canonicalObject);
  if (!eligibility.eligible) fail(eligibility.reason);

  const { objectId, revisionId } = eligibility;
  const payload = canonicalObject.payload;

  /*
   * A1 §4 call-site rule. The ENVELOPE revisionId is engine-minted and says
   * nothing about canonical state; the PAYLOAD keeps its own domain-derived
   * source identity, which is what canonical state is keyed by. Validating the
   * payload against the envelope's id would therefore demand that the payload
   * name an identity it has no reason to know.
   *
   * The source id is read from the payload and cross-checked against itself
   * first, so a payload whose two statements of its own identity disagree is
   * refused rather than validated against whichever one was read.
   *
   * The shared validator keeps its exact signature: this is a call-site rule,
   * not a contract change, and the v1 lane - where the two ids coincide -
   * behaves byte-identically.
   */
  const sourceRevisionId = payloadSourceRevisionId(payload);
  if (!sourceRevisionId) fail(P02_CHAT_DOMAIN_ERROR.PAYLOAD_NOT_CANONICAL);
  try {
    validateContentOnlyPayload(payload, objectId, sourceRevisionId);
  } catch (_) {
    fail(P02_CHAT_DOMAIN_ERROR.PAYLOAD_NOT_CANONICAL);
  }

  const parent = p02Parent === null
    ? rootParent()
    : descendantParent({
      previousRevisionId: p02Parent.previousRevisionId,
      previousRevisionBlobSha256: p02Parent.previousRevisionBlobSha256,
      provenP02Parent: p02Parent.provenP02Parent
    });

  const produced = await produceRevisionV2({
    objectDomain: P02_CHAT_DOMAIN_V2.OBJECT_DOMAIN,
    objectId,
    revisionId,
    writerSyncPeerId,
    payload,
    parent,
    cryptoImplementation
  });

  return Object.freeze({
    ...produced,
    adapterSchema: P02_CHAT_DOMAIN_V2.ADAPTER_SCHEMA
  });
}

export { P02_REVISION_PRODUCTION_ERROR };
