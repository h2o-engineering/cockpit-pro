/*
 * P02 anchor contract (A1 §8, supersedes F0-O1-T05 as written).
 *
 * An "anchor" is the pair an evidence graph is allowed to chain to when the
 * parent revision itself is not among the retained records. Before the identity
 * amendment that anchor was a bare revision id - `canonicalAnchorRevisionId` -
 * taken from the v1 canonical projection, and two things were wrong with it.
 *
 * It was ID-ONLY. A node claiming `previousRevisionId === anchorId` was proven
 * without anyone checking that the parent BYTES it recorded were the anchor's
 * bytes, so a record naming the right ancestor with the wrong content proved
 * itself. Z4 already settled the polarity for exactly this question: key on the
 * blob, cross-check the id, and treat id-match-blob-differ as an identity
 * conflict rather than a match.
 *
 * It was also CROSS-DOMAIN. A v1 projection head and a v2 envelope revision are
 * different representations of different things; the only bridge between the
 * domains is the payload hash, and a payload hash may never mint, select or
 * promote ancestry. So a v1 head is barred from anchoring by TYPE here, not by
 * convention: an anchor set carries a schema tag, and anything without it is
 * refused rather than quietly coerced.
 *
 * REPOSITORY-READ DISCIPLINE. Pairs assemble from protocol-state columns with
 * ZERO repository reads, so a converged steady pass reads nothing. The
 * repository PROOF that a pair really exists at those bytes is separate, lazy
 * on first use, and memoized ONLY when verified - forever, because an immutable
 * address never changes. A missing file or a read error is never cached: both
 * are transient conditions a later pass must be free to re-ask.
 */

export const P02_ANCHOR_SET_V2 = Object.freeze({
  SCHEMA: 'h2o.studio.syncP02AnchorSet.v1',
  /* The only representation that may anchor a P02 evidence graph. */
  REPRESENTATION: 'v2-envelope',
  ORIGIN: Object.freeze({
    PUBLISHED: 'last-published',
    APPLIED: 'last-applied'
  })
});

export const P02_ANCHOR_MATCH = Object.freeze({
  /* The pair is an anchor, bytes and id agreeing. */
  PROVEN: 'proven',
  /* Right id, wrong bytes: a claim about ancestry that the anchor contradicts. */
  IDENTITY_CONFLICT: 'identity-conflict',
  /* Not an anchor at all. Says nothing either way. */
  ABSENT: 'absent'
});

export const P02_ANCHOR_ERROR = Object.freeze({
  SET_INVALID: 'p02-anchor-set-invalid',
  PAIR_INVALID: 'p02-anchor-pair-invalid',
  REPRESENTATION_BARRED: 'p02-anchor-representation-barred',
  ANCHOR_SOURCE_CONFLICT: 'p02-anchor-source-conflict',
  PROOF_READER_INVALID: 'p02-anchor-proof-reader-invalid'
});

const HEX64 = /^[0-9a-f]{64}$/;
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

function strictId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 512 &&
    !CONTROL_RE.test(value);
}
const hex64 = (value) => typeof value === 'string' && HEX64.test(value);
const isPlainObject = (value) =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export class P02AnchorError extends Error {
  constructor(code) {
    super(code);
    this.name = 'P02AnchorError';
    this.code = code;
  }
}
const fail = (code) => { throw new P02AnchorError(code); };

function normalizePair(value, origin) {
  if (value == null) return null;
  if (!isPlainObject(value) || !strictId(value.revisionId) ||
      !hex64(value.revisionBlobSha256)) {
    fail(P02_ANCHOR_ERROR.PAIR_INVALID);
  }
  const pair = {
    origin,
    representation: P02_ANCHOR_SET_V2.REPRESENTATION,
    revisionId: value.revisionId,
    revisionBlobSha256: value.revisionBlobSha256
  };
  /*
   * Carried for content-equality decisions only. It is deliberately NOT part
   * of anchor matching: a payload hash never mints, selects or promotes
   * ancestry (A1 §8, trap guard).
   */
  if (value.payloadSha256 != null) {
    if (!hex64(value.payloadSha256)) fail(P02_ANCHOR_ERROR.PAIR_INVALID);
    pair.payloadSha256 = value.payloadSha256;
  }
  return Object.freeze(pair);
}

/*
 * Assemble the anchor set from protocol-state COLUMNS. Zero repository reads:
 * this is the whole reason a converged steady pass costs nothing.
 *
 * An object with neither column set yields an empty-but-valid set, which is a
 * real answer - "this object has no proven P02 ancestry" - and not the same as
 * having no anchor set at all.
 */
export function createP02AnchorSet({
  objectDomain = null,
  objectId = null,
  protocolState = {}
} = {}) {
  if (!isPlainObject(protocolState)) fail(P02_ANCHOR_ERROR.SET_INVALID);
  const pairs = [];
  const published = normalizePair(
    protocolState.lastPublished, P02_ANCHOR_SET_V2.ORIGIN.PUBLISHED
  );
  const applied = normalizePair(
    protocolState.lastApplied, P02_ANCHOR_SET_V2.ORIGIN.APPLIED
  );
  if (published) pairs.push(published);
  /*
   * Published and applied are frequently the SAME pair - an apply this peer
   * then republished unchanged. Listing it twice would double-count provenance
   * without adding an anchor, so the duplicate is dropped and the published
   * origin, which is the stronger claim, is the one kept.
   */
  if (applied && !(published &&
      published.revisionId === applied.revisionId &&
      published.revisionBlobSha256 === applied.revisionBlobSha256)) {
    pairs.push(applied);
  }
  return Object.freeze({
    schema: P02_ANCHOR_SET_V2.SCHEMA,
    representation: P02_ANCHOR_SET_V2.REPRESENTATION,
    objectDomain: objectDomain ?? null,
    objectId: objectId ?? null,
    pairs: Object.freeze(pairs)
  });
}

/* An anchor set is recognised by TYPE. This is what bars a v1 projection head. */
export function isP02AnchorSet(value) {
  return isPlainObject(value) &&
    value.schema === P02_ANCHOR_SET_V2.SCHEMA &&
    value.representation === P02_ANCHOR_SET_V2.REPRESENTATION &&
    Array.isArray(value.pairs);
}

export function requireP02AnchorSet(value) {
  if (value == null) return null;
  if (!isP02AnchorSet(value)) fail(P02_ANCHOR_ERROR.REPRESENTATION_BARRED);
  return value;
}

/*
 * Z4 polarity: key on the BLOB, cross-check the id.
 *
 * A hop whose recorded parent bytes match an anchor's bytes but whose recorded
 * parent id does not is the same contradiction seen from the other side, so
 * both asymmetries land on identity-conflict rather than one of them passing.
 */
export function matchAnchorPair(anchorSet, {
  revisionId = null,
  revisionBlobSha256 = null
} = {}) {
  const set = requireP02AnchorSet(anchorSet);
  if (!set || set.pairs.length === 0) return P02_ANCHOR_MATCH.ABSENT;
  /* An incomplete claim cannot be proven; it also cannot conflict. */
  if (!strictId(revisionId) || !hex64(revisionBlobSha256)) {
    return P02_ANCHOR_MATCH.ABSENT;
  }
  let conflict = false;
  for (const pair of set.pairs) {
    const sameId = pair.revisionId === revisionId;
    const sameBlob = pair.revisionBlobSha256 === revisionBlobSha256;
    if (sameId && sameBlob) return P02_ANCHOR_MATCH.PROVEN;
    if (sameId !== sameBlob) conflict = true;
  }
  return conflict ? P02_ANCHOR_MATCH.IDENTITY_CONFLICT : P02_ANCHOR_MATCH.ABSENT;
}

export function anchorSetPairs(anchorSet) {
  const set = requireP02AnchorSet(anchorSet);
  return set ? set.pairs : [];
}

/*
 * The lazy repository proof.
 *
 * `readRevision` is Z4's verified reader: it returns a status, and only
 * 'verified' means the bytes at that immutable address really are what the
 * pair claims. Everything else - absent, unreadable, mismatched - is not proof
 * and is not remembered, so a folder that is still syncing heals by itself on
 * the next pass instead of being permanently recorded as broken.
 */
export function createP02AnchorProof({ readRevision, objectDomain = null } = {}) {
  if (typeof readRevision !== 'function') fail(P02_ANCHOR_ERROR.PROOF_READER_INVALID);
  /* Verified answers only, forever, keyed by the immutable address. */
  const verified = new Map();
  let reads = 0;

  async function proveAnchorPair({ objectId = null, objectKey = null, pair } = {}) {
    if (!isPlainObject(pair) || !strictId(pair.revisionId) ||
        !hex64(pair.revisionBlobSha256)) {
      fail(P02_ANCHOR_ERROR.PAIR_INVALID);
    }
    const memoKey = `${objectKey ?? objectId ?? ''} ${pair.revisionBlobSha256}`;
    if (verified.has(memoKey)) return verified.get(memoKey);
    reads += 1;
    let revision = null;
    try {
      revision = await readRevision({
        objectDomain: objectDomain ?? pair.objectDomain ?? null,
        objectId,
        objectKey,
        revisionBlobSha256: pair.revisionBlobSha256
      });
    } catch (_) {
      /* A read error is a statement about the channel, never about ancestry. */
      return null;
    }
    if (!revision || revision.status !== 'verified') return null;
    /*
     * The address proves the bytes; cross-check the id so a verified read can
     * never be attributed to a revision the caller did not ask about.
     */
    const seenId = revision.value?.revisionId ?? revision.revisionId ?? null;
    if (strictId(seenId) && seenId !== pair.revisionId) {
      const conflict = Object.freeze({
        status: P02_ANCHOR_MATCH.IDENTITY_CONFLICT,
        revisionId: seenId,
        revisionBlobSha256: pair.revisionBlobSha256
      });
      /* Immutable bytes carrying a different id will say so forever. */
      verified.set(memoKey, conflict);
      return conflict;
    }
    const proof = Object.freeze({
      status: P02_ANCHOR_MATCH.PROVEN,
      revisionId: pair.revisionId,
      revisionBlobSha256: pair.revisionBlobSha256,
      payloadSha256: revision.value?.payloadSha256 ?? null
    });
    verified.set(memoKey, proof);
    return proof;
  }

  return Object.freeze({
    schema: P02_ANCHOR_SET_V2.SCHEMA,
    proveAnchorPair,
    __test: Object.freeze({
      verifiedCount: () => verified.size,
      readCount: () => reads
    })
  });
}
