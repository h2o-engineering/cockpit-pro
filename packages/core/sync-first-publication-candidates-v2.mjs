/*
 * P02 V8-C2 — first-publication candidate governance.
 *
 * Read-only throughout. This layer prepares the eligible set the canonical work
 * authority already computed, gives each eligible candidate an opaque
 * object-scoped selection key, and lets an operator bind exactly one of them.
 * It performs no publication, opens no write authority, and touches no store.
 *
 * The governing rule it exists to enforce: there is NO automatic or default
 * first-publication candidate. Preparation always returns `selected: null`, and
 * a candidate becomes selected only when a caller presents a selection key that
 * this preparation itself produced.
 *
 * Eligibility is not recomputed here. Classification comes from the frozen
 * classifier via the work authority; this layer only filters to what that
 * authority already declared publishable, and refuses to hand a selection key
 * to anything else.
 *
 * Domain-generic: `objectDomain` is data. Nothing here knows about chats,
 * notes, folders, labels or tags, and a future domain enters unchanged by
 * supplying descriptors plus, optionally, its own presentation metadata.
 */

import { canonicalJson } from './sync-object-projection.mjs';
import {
  P02_CLASSIFICATION,
  classifyObjectState,
  sortReadOnlyObjectDescriptors
} from './sync-object-classifier-v2.mjs';

export const P02_FIRST_PUBLICATION_V2 = Object.freeze({
  PREPARATION_SCHEMA: 'h2o.studio.syncFirstPublicationPreparation.p02.v1',
  BINDING_SCHEMA: 'h2o.studio.syncFirstPublicationSelectionBinding.p02.v1',
  PLAN_SCHEMA: 'h2o.studio.syncFirstPublicationSelectionPlan.p02.v1',
  /* Stated as a constant so "no default" is a contract, not an omission. */
  DEFAULT_SELECTION: null
});

export const P02_FIRST_PUBLICATION_ERROR = Object.freeze({
  PREPARATION_INPUT_INVALID: 'p02-v8c2-preparation-input-invalid',
  PREPARATION_INVALID: 'p02-v8c2-preparation-invalid',
  SELECTION_KEY_INVALID: 'p02-v8c2-selection-key-invalid',
  SELECTION_KEY_UNKNOWN: 'p02-v8c2-selection-key-unknown',
  SELECTION_AMBIGUOUS: 'p02-v8c2-selection-ambiguous',
  SELECTION_STALE: 'p02-v8c2-selection-stale',
  PLAN_INVALID: 'p02-v8c2-selection-plan-invalid',
  CRYPTO_UNAVAILABLE: 'p02-v8c2-crypto-unavailable'
});

export class P02FirstPublicationError extends Error {
  constructor(code) {
    super(code);
    this.name = 'P02FirstPublicationError';
    this.code = code;
  }
}

function fail(code) {
  throw new P02FirstPublicationError(code);
}

const SHA256_RE = /^[0-9a-f]{64}$/;
const encoder = new TextEncoder();

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function sha256Hex(text, cryptoImplementation) {
  if (!cryptoImplementation?.subtle ||
      typeof cryptoImplementation.subtle.digest !== 'function') {
    fail(P02_FIRST_PUBLICATION_ERROR.CRYPTO_UNAVAILABLE);
  }
  let digest;
  try {
    digest = await cryptoImplementation.subtle.digest('SHA-256', encoder.encode(text));
  } catch (_) {
    fail(P02_FIRST_PUBLICATION_ERROR.CRYPTO_UNAVAILABLE);
  }
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0')).join('');
}

/*
 * The authoritative binding: only fields that decide WHAT would be published.
 *
 * Deliberately object-scoped. It carries nothing about the rest of the eligible
 * set, so an unrelated object changing cannot invalidate this selection - and
 * it carries no presentation field, so renaming something a human reads cannot
 * change publication authority either.
 */
function selectionBinding(descriptor, classification) {
  const head = descriptor.canonicalLocalHead;
  return {
    schema: P02_FIRST_PUBLICATION_V2.BINDING_SCHEMA,
    objectDomain: descriptor.objectDomain,
    objectId: descriptor.objectId,
    objectKey: descriptor.objectKey,
    syncPeerId: descriptor.syncPeerId,
    classification,
    sourceRevisionId: head?.revisionId ?? null,
    sourceRevisionBlobSha256: head?.revisionBlobSha256 ?? null,
    sourcePayloadSha256: head?.payloadSha256 ?? null
  };
}

function eligibleForFirstPublication(descriptor, classification) {
  return classification === P02_CLASSIFICATION.LOCAL_AHEAD &&
    descriptor.publishable === true &&
    descriptor.integrityQuarantined !== true &&
    descriptor.blockReason === null &&
    isPlainObject(descriptor.canonicalLocalHead);
}

/*
 * Prepare the operator-facing candidate set. Returns three read-only
 * categories - selectable, classified-but-not-selectable, and
 * projection-blocked - so nothing is hidden and only the first is selectable.
 */
export async function prepareFirstPublicationCandidates({
  enumeration,
  presentation = null,
  classify = classifyObjectState,
  cryptoImplementation = globalThis.crypto
} = {}) {
  if (!isPlainObject(enumeration) || !Array.isArray(enumeration.descriptors)) {
    fail(P02_FIRST_PUBLICATION_ERROR.PREPARATION_INPUT_INVALID);
  }
  if (presentation !== null && typeof presentation !== 'function') {
    fail(P02_FIRST_PUBLICATION_ERROR.PREPARATION_INPUT_INVALID);
  }
  const ordered = sortReadOnlyObjectDescriptors(enumeration.descriptors);
  const candidates = [];
  const nonEligible = [];
  const seen = new Set();

  for (const descriptor of ordered) {
    const verdict = classify(descriptor);
    const classification = verdict?.classification ?? null;
    if (!eligibleForFirstPublication(descriptor, classification)) {
      nonEligible.push(Object.freeze({
        objectDomain: descriptor.objectDomain,
        objectId: descriptor.objectId,
        classification,
        reason: verdict?.reason ?? null,
        selectable: false
      }));
      continue;
    }
    const binding = selectionBinding(descriptor, classification);
    const selectionKey = await sha256Hex(canonicalJson(binding), cryptoImplementation);
    /* Two candidates cannot share a key; if they ever did, fail closed rather
     * than let a selection resolve ambiguously later. */
    if (seen.has(selectionKey)) fail(P02_FIRST_PUBLICATION_ERROR.SELECTION_AMBIGUOUS);
    seen.add(selectionKey);
    candidates.push(Object.freeze({
      selectionKey,
      binding: Object.freeze(binding),
      orderingKey: descriptor.orderingKey,
      /* Optional, non-authoritative, and never part of the binding. */
      presentation: presentation ? Object.freeze(presentation(descriptor) ?? null) : null
    }));
  }

  return Object.freeze({
    schema: P02_FIRST_PUBLICATION_V2.PREPARATION_SCHEMA,
    /* No automatic choice, ever. The operator must select explicitly. */
    selected: P02_FIRST_PUBLICATION_V2.DEFAULT_SELECTION,
    candidates: Object.freeze(candidates),
    nonEligible: Object.freeze(nonEligible),
    projectionBlocked: Object.freeze([...(enumeration.blockedObjects ?? [])]),
    counts: Object.freeze({
      selectable: candidates.length,
      nonEligible: nonEligible.length,
      projectionBlocked: (enumeration.blockedObjects ?? []).length,
      total: ordered.length + (enumeration.blockedObjects ?? []).length
    })
  });
}

/*
 * Bind exactly one prepared candidate.
 *
 * Selection authority is the opaque key this preparation produced - never an
 * object id. There is no id lookup and no fallback, so a caller cannot name an
 * object that was never offered, and cannot reach a blocked or non-eligible
 * object at all: those never received a key.
 */
export function selectFirstPublicationCandidate({ preparation, selectionKey } = {}) {
  if (!isPlainObject(preparation) ||
      preparation.schema !== P02_FIRST_PUBLICATION_V2.PREPARATION_SCHEMA ||
      !Array.isArray(preparation.candidates)) {
    fail(P02_FIRST_PUBLICATION_ERROR.PREPARATION_INVALID);
  }
  if (typeof selectionKey !== 'string' || !SHA256_RE.test(selectionKey)) {
    fail(P02_FIRST_PUBLICATION_ERROR.SELECTION_KEY_INVALID);
  }
  const matches = preparation.candidates.filter(
    (candidate) => candidate.selectionKey === selectionKey
  );
  if (matches.length === 0) fail(P02_FIRST_PUBLICATION_ERROR.SELECTION_KEY_UNKNOWN);
  if (matches.length > 1) fail(P02_FIRST_PUBLICATION_ERROR.SELECTION_AMBIGUOUS);
  const candidate = matches[0];
  return Object.freeze({
    schema: P02_FIRST_PUBLICATION_V2.PLAN_SCHEMA,
    selectionKey,
    binding: candidate.binding,
    orderingKey: candidate.orderingKey,
    presentation: candidate.presentation
  });
}

/*
 * Fresh revalidation for the later governed step.
 *
 * The question is deliberately narrow: does this exact binding still name a
 * currently eligible candidate? Lookup is by selection key, so a candidate
 * whose publication-relevant identity moved produces a different key and is
 * simply not found - a changed candidate is never silently accepted under the
 * old selection, and requires a fresh preparation and a fresh operator choice.
 */
export async function revalidateFirstPublicationSelection({
  plan,
  enumeration,
  presentation = null,
  classify = classifyObjectState,
  cryptoImplementation = globalThis.crypto
} = {}) {
  if (!isPlainObject(plan) ||
      plan.schema !== P02_FIRST_PUBLICATION_V2.PLAN_SCHEMA ||
      typeof plan.selectionKey !== 'string' ||
      !SHA256_RE.test(plan.selectionKey) ||
      !isPlainObject(plan.binding)) {
    fail(P02_FIRST_PUBLICATION_ERROR.PLAN_INVALID);
  }
  const fresh = await prepareFirstPublicationCandidates({
    enumeration, presentation, classify, cryptoImplementation
  });
  const matches = fresh.candidates.filter(
    (candidate) => candidate.selectionKey === plan.selectionKey
  );
  if (matches.length > 1) fail(P02_FIRST_PUBLICATION_ERROR.SELECTION_AMBIGUOUS);
  if (matches.length === 0) fail(P02_FIRST_PUBLICATION_ERROR.SELECTION_STALE);
  const candidate = matches[0];
  /* Belt and braces: the key is derived from the binding, so a mismatch here
   * would mean a digest collision or a forged plan. */
  if (canonicalJson(candidate.binding) !== canonicalJson(plan.binding)) {
    fail(P02_FIRST_PUBLICATION_ERROR.SELECTION_STALE);
  }
  return Object.freeze({
    ok: true,
    selectionKey: plan.selectionKey,
    candidate,
    preparation: fresh
  });
}
