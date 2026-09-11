/*
 * P02 envelope revision identity (A1 §4/§10 — engine-minted).
 *
 * Until the identity amendment, a v2 envelope borrowed its revisionId from the
 * domain: for saved chats, the canonical snapshot id. That coupling caused two
 * distinct problems, and the mint fixes both at the source.
 *
 * It was not CONTENT-UNIQUE. The same snapshot id names the canonical state
 * before and after an edit that rewrites it in place, so two envelopes with
 * different bytes could carry the same revisionId - which is precisely the
 * identity conflict every downstream contract exists to refuse. Worse, an
 * A -> B -> A edit cycle could re-mint an id that already names a different
 * revision, making self-parenthood and cycles reachable for an honest writer.
 *
 * It also made every future domain responsible for issuing sync identity. A
 * domain that has no natural revision id would have had to invent edit tokens
 * and write-path hooks just to be syncable. Issuing envelope identity is ENGINE
 * work, so domains supply content and nothing else.
 *
 * The mint is `p02-` plus 32 lowercase hex characters from the platform CSPRNG:
 * 128 bits, which makes collision between honest writers not worth reasoning
 * about, and the prefix makes a minted id recognisable on sight in a database
 * row or a log line.
 *
 * SCOPE: envelope only. The PAYLOAD keeps its own domain-derived source
 * identity, because that is what canonical state is keyed by and what apply has
 * to converge against. Nothing here ever writes into canonical state.
 */

export const P02_REVISION_MINT = Object.freeze({
  SCHEMA: 'h2o.studio.syncP02RevisionMint.v1',
  PREFIX: 'p02-',
  /* 16 CSPRNG bytes rendered as 32 lowercase hex characters. */
  BYTE_LENGTH: 16,
  PATTERN: /^p02-[0-9a-f]{32}$/
});

export const P02_REVISION_MINT_ERROR = Object.freeze({
  CRYPTO_UNAVAILABLE: 'p02-revision-mint-crypto-unavailable',
  MINT_INVALID: 'p02-revision-mint-invalid'
});

export class P02RevisionMintError extends Error {
  constructor(code) {
    super(code);
    this.name = 'P02RevisionMintError';
    this.code = code;
  }
}
const fail = (code) => { throw new P02RevisionMintError(code); };

/*
 * A cryptographically secure source is required, not preferred. A predictable
 * id would let one writer guess another's next revision address, and a weak
 * source would reintroduce exactly the collisions this exists to remove, so
 * there is deliberately no Math.random fallback.
 */
export function mintP02RevisionId(cryptoImplementation = globalThis.crypto) {
  if (typeof cryptoImplementation?.getRandomValues !== 'function') {
    fail(P02_REVISION_MINT_ERROR.CRYPTO_UNAVAILABLE);
  }
  const bytes = new Uint8Array(P02_REVISION_MINT.BYTE_LENGTH);
  cryptoImplementation.getRandomValues(bytes);
  let hex = '';
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
  const minted = `${P02_REVISION_MINT.PREFIX}${hex}`;
  /* A getRandomValues that returned nothing usable must not pass silently. */
  if (!P02_REVISION_MINT.PATTERN.test(minted)) {
    fail(P02_REVISION_MINT_ERROR.MINT_INVALID);
  }
  return minted;
}

export function isMintedP02RevisionId(value) {
  return typeof value === 'string' && P02_REVISION_MINT.PATTERN.test(value);
}

/*
 * The payload's own identity, read from the payload rather than assumed.
 *
 * `chatIndex.lastSnapshotId` and `snapshots[0].snapshotId` are two independent
 * statements of the same fact, so requiring them to agree before trusting
 * either turns a silently-wrong payload into a refusal. Returns null rather
 * than throwing: callers decide which error code the disagreement deserves in
 * their own vocabulary.
 */
export function payloadSourceRevisionId(payload) {
  const chat = payload?.chatArchive?.chats?.[0];
  const snapshot = chat?.snapshots?.[0];
  const indexed = typeof chat?.chatIndex?.lastSnapshotId === 'string'
    ? chat.chatIndex.lastSnapshotId.trim() : '';
  const captured = typeof snapshot?.snapshotId === 'string'
    ? snapshot.snapshotId.trim() : '';
  if (!indexed || indexed !== captured) return null;
  return indexed;
}
