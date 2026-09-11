/*
 * O1-T07 — Y-2 verified advertised-tip memo (durable).
 *
 * When a pass re-reads a peer's writer state it almost always finds the same
 * verified heads snapshot it saw last time. Re-walking that snapshot to
 * rediscover the same advertised tip set is pure repetition, and this memo
 * exists to skip THAT - the re-derivation of the advertised set - and nothing
 * else.
 *
 * IT IS NOT EVIDENCE AUTHORITY. This is the load-bearing property, and the API
 * is shaped so it cannot be violated by accident. The memo answers "what did
 * this verified snapshot advertise", never "is this tip already done". Whether
 * a tip still needs processing is decided by ADMITTED EVIDENCE, which the
 * caller supplies on every decision; the memo can only ever hand back the
 * advertised set it recorded, and every advertised tip not covered by admitted
 * evidence comes back as pending work.
 *
 * That is why a stale memo is harmless in every direction:
 *   snapshot hash changed        -> process normally, memo ignored
 *   same hash, tip not admitted  -> that tip is processed anyway
 *   capacity-refused tip         -> not in admitted evidence, so still pending
 *   loss / corruption / absence  -> process normally
 * Memo presence is never converted into proof of anything.
 *
 * DURABLE, through an EXISTING store. The record survives restart because
 * re-deriving it costs a heads-snapshot read per object per boot, which is the
 * cost the memo exists to avoid. Durability is safe precisely because the memo
 * is not authority: the worst a stale durable record can do is hand back an
 * advertised set that admitted evidence then re-expands into work.
 *
 * The store is injected. This module knows nothing about SQLite, IndexedDB or
 * chrome.storage - the platform adapters supply a small read/write/remove port
 * over a substrate that already exists, so no table, migration or database
 * version is added anywhere.
 *
 * WRITE ORDERING. A record is written only after the writer state verified,
 * the heads snapshot verified, AND the admission processing for that snapshot
 * reached its contract boundary. A crash before the write costs one
 * re-derivation. A crash after it costs nothing, because admitted evidence
 * still controls the work.
 *
 * POINTER FAILURE RETAINS. An unreadable or unproven pointer is evidence about
 * the READ, not about the peer's advertisement, so the last verified record is
 * kept. Replacing it with unverified advertised data would let a transport
 * failure rewrite what we believe a peer published.
 */

export const P02_TIP_MEMO_V2 = Object.freeze({
  SCHEMA: 'h2o.studio.syncP02VerifiedTipMemo.v1',
  /* Namespaced so the pair it binds is unambiguous in any shared keyspace. */
  KEY_PREFIX: 'h2o:studio:sync:p02:y2:v1',
  keyFor: (peerWriterKey, objectKey) =>
    `${P02_TIP_MEMO_V2.KEY_PREFIX}:${peerWriterKey}:${objectKey}`
});

export const P02_TIP_MEMO_VERDICT = Object.freeze({
  /* The same verified snapshot: its advertised set may be reused. Whether any
   * work remains is still decided by admitted evidence. */
  REUSE_ADVERTISED_SET: 'reuse-advertised-set',
  /* No record for this pair. */
  NO_RECORD: 'no-record',
  /* A different snapshot: different advertisement, so re-derive it. */
  SNAPSHOT_CHANGED: 'snapshot-changed',
  /* A record that cannot be trusted. Treated exactly like no record. */
  RECORD_MALFORMED: 'record-malformed',
  /* The store could not be read. Never a claim about convergence. */
  STORE_UNREADABLE: 'store-unreadable',
  /* The caller did not supply enough to decide. */
  INPUT_INSUFFICIENT: 'input-insufficient'
});

const HEX64 = /^[0-9a-f]{64}$/;
const hex64 = (value) => typeof value === 'string' && HEX64.test(value);
const clean = (value) => (typeof value === 'string' ? value.trim() : '');
const isPlainObject = (value) =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function requireFunction(value, code) {
  if (typeof value !== 'function') throw new TypeError(code);
  return value;
}

/*
 * A tip's identity is the full protocol pair plus its object. Keying on the
 * revisionId alone would let a same-id/different-blob squat look like a tip we
 * already know about, which is the one thing a memo must never help with.
 */
function tipIdentity(tip) {
  if (!isPlainObject(tip)) return null;
  const revisionId = clean(tip.revisionId);
  const revisionBlobSha256 = clean(tip.revisionBlobSha256);
  if (!revisionId || !hex64(revisionBlobSha256)) return null;
  return `${clean(tip.objectId)} ${revisionId} ${revisionBlobSha256}`;
}

function normalizeTip(tip) {
  const identity = tipIdentity(tip);
  if (identity === null) return null;
  return Object.freeze({
    objectDomain: clean(tip.objectDomain) || null,
    objectId: clean(tip.objectId) || null,
    revisionId: clean(tip.revisionId),
    revisionBlobSha256: clean(tip.revisionBlobSha256)
  });
}

/* A record read back from a shared keyspace is untrusted input like any other. */
function parseRecord(value, { peerWriterKey, objectKey }) {
  const record = typeof value === 'string'
    ? (() => { try { return JSON.parse(value); } catch (_) { return null; } })()
    : value;
  if (!isPlainObject(record) ||
      record.schema !== P02_TIP_MEMO_V2.SCHEMA ||
      record.peerWriterKey !== peerWriterKey ||
      record.objectKey !== objectKey ||
      !hex64(clean(record.lastVerifiedSnapshotSha256)) ||
      !Array.isArray(record.tips)) {
    return null;
  }
  const tips = [];
  for (const tip of record.tips) {
    const normalized = normalizeTip(tip);
    /* One unreadable tip makes the whole record untrustworthy: a partially
     * parsed advertised set would UNDER-report what the peer advertised, and
     * under-reporting is the direction that loses work. */
    if (normalized === null) return null;
    tips.push(normalized);
  }
  return Object.freeze({
    lastVerifiedSnapshotSha256: clean(record.lastVerifiedSnapshotSha256),
    tips: Object.freeze(tips)
  });
}

export function createP02VerifiedTipMemo({ store } = {}) {
  if (!isPlainObject(store)) throw new TypeError('p02-tip-memo-store-invalid');
  requireFunction(store.read, 'p02-tip-memo-store-invalid');
  requireFunction(store.write, 'p02-tip-memo-store-invalid');

  const counters = { reuse: 0, rederive: 0, records: 0, storeErrors: 0 };

  /*
   * The complete advertised set from a VERIFIED heads snapshot, regardless of
   * what each individual tip's admission decided.
   *
   * Filtering by admission outcome here would be a category error: the record
   * describes what the PEER advertised, which is a fact about the snapshot, not
   * about our processing of it. A record holding only the admitted subset would
   * also silently shrink the advertised set on the next pass, which is exactly
   * how a memo starts suppressing work.
   */
  async function record({
    peerWriterKey,
    objectKey,
    snapshotSha256,
    tips = [],
    writerStateVerified = false,
    headsSnapshotVerified = false,
    admissionBoundaryComplete = false
  } = {}) {
    const peer = clean(peerWriterKey);
    const object = clean(objectKey);
    const snapshot = clean(snapshotSha256);
    if (!hex64(peer) || !hex64(object) || !hex64(snapshot) || !Array.isArray(tips)) {
      return Object.freeze({ recorded: false, reason: 'input-invalid' });
    }
    if (writerStateVerified !== true) {
      return Object.freeze({ recorded: false, reason: 'writer-state-not-verified' });
    }
    if (headsSnapshotVerified !== true) {
      return Object.freeze({ recorded: false, reason: 'heads-snapshot-not-verified' });
    }
    if (admissionBoundaryComplete !== true) {
      /* Writing before the boundary would let a crash mid-processing leave a
       * record claiming a snapshot was handled when it was only started. */
      return Object.freeze({ recorded: false, reason: 'admission-boundary-incomplete' });
    }
    const normalized = [];
    for (const tip of tips) {
      const value = normalizeTip(tip);
      if (value === null) {
        return Object.freeze({ recorded: false, reason: 'tip-identity-invalid' });
      }
      normalized.push(value);
    }
    const document = {
      schema: P02_TIP_MEMO_V2.SCHEMA,
      peerWriterKey: peer,
      objectKey: object,
      lastVerifiedSnapshotSha256: snapshot,
      tips: normalized
    };
    try {
      await store.write(P02_TIP_MEMO_V2.keyFor(peer, object), JSON.stringify(document));
    } catch (error) {
      /* A memo that could not be written costs a re-derivation next pass. It
       * is never allowed to fail the operation that produced it. */
      counters.storeErrors += 1;
      return Object.freeze({
        recorded: false, reason: clean(error?.code) || 'store-write-failed'
      });
    }
    counters.records += 1;
    return Object.freeze({ recorded: true, reason: null });
  }

  /*
   * The only question this module answers, and it deliberately answers it in
   * two parts: what was advertised, and what of that is still outstanding.
   *
   * `admittedRevisionIds` is the caller's view of admitted evidence and is the
   * ONLY thing that decides whether a tip is done. Omit it and every advertised
   * tip comes back pending, which is the safe direction.
   */
  async function decide({
    peerWriterKey,
    objectKey,
    snapshotSha256,
    admittedRevisionIds = []
  } = {}) {
    const peer = clean(peerWriterKey);
    const object = clean(objectKey);
    const snapshot = clean(snapshotSha256);
    const nothing = (verdict) => Object.freeze({
      reuse: false, fastPath: false, verdict,
      advertisedTips: Object.freeze([]), pendingTips: Object.freeze([])
    });

    if (!hex64(peer) || !hex64(object) || !hex64(snapshot)) {
      counters.rederive += 1;
      return nothing(P02_TIP_MEMO_VERDICT.INPUT_INSUFFICIENT);
    }

    let raw;
    try {
      raw = await store.read(P02_TIP_MEMO_V2.keyFor(peer, object));
    } catch (_) {
      /* A store that cannot be read says nothing about the repository. It must
       * never be reported as convergence, so it reads as "re-derive". */
      counters.storeErrors += 1;
      counters.rederive += 1;
      return nothing(P02_TIP_MEMO_VERDICT.STORE_UNREADABLE);
    }
    if (raw === null || raw === undefined) {
      counters.rederive += 1;
      return nothing(P02_TIP_MEMO_VERDICT.NO_RECORD);
    }
    const parsed = parseRecord(raw, { peerWriterKey: peer, objectKey: object });
    if (parsed === null) {
      counters.rederive += 1;
      return nothing(P02_TIP_MEMO_VERDICT.RECORD_MALFORMED);
    }
    if (parsed.lastVerifiedSnapshotSha256 !== snapshot) {
      counters.rederive += 1;
      return nothing(P02_TIP_MEMO_VERDICT.SNAPSHOT_CHANGED);
    }

    /*
     * The same verified snapshot. Its advertised set is reusable - and every
     * tip of it that admitted evidence does not cover is still work.
     */
    const admitted = new Set(
      (Array.isArray(admittedRevisionIds) ? admittedRevisionIds : []).map(clean).filter(Boolean)
    );
    const pendingTips = parsed.tips.filter((tip) => !admitted.has(tip.revisionId));
    counters.reuse += 1;
    return Object.freeze({
      reuse: true,
      /* True only when nothing at all is outstanding. Still not a proof of
       * convergence - it is the absence of advertised work, which the caller
       * combines with its own state. */
      fastPath: pendingTips.length === 0,
      verdict: P02_TIP_MEMO_VERDICT.REUSE_ADVERTISED_SET,
      advertisedTips: parsed.tips,
      pendingTips: Object.freeze(pendingTips)
    });
  }

  /*
   * An unreadable or unproven pointer RETAINS the last verified record. There
   * is deliberately no code path here that clears a record on a failed read:
   * a transport failure must not be able to rewrite what we believe a peer
   * published.
   */
  async function noteUnverifiedPointer({ peerWriterKey, objectKey, reason = null } = {}) {
    return Object.freeze({
      retainedLastVerified: true,
      cleared: false,
      reason: clean(reason) || 'pointer-unverified',
      key: P02_TIP_MEMO_V2.keyFor(clean(peerWriterKey), clean(objectKey))
    });
  }

  /*
   * The reader seam the enumerators already expect. Returns the advertised set
   * for a verified snapshot and an empty list otherwise - never a guess.
   */
  function advertisedTipReader({ snapshotSha256For } = {}) {
    requireFunction(snapshotSha256For, 'p02-tip-memo-snapshot-resolver-invalid');
    return async (scope) => {
      const snapshot = clean(await snapshotSha256For(scope));
      if (!hex64(snapshot)) return [];
      const decision = await decide({
        peerWriterKey: scope?.peerWriterKey,
        objectKey: scope?.objectKey,
        snapshotSha256: snapshot
      });
      return decision.reuse ? decision.advertisedTips : [];
    };
  }

  return Object.freeze({
    schema: P02_TIP_MEMO_V2.SCHEMA,
    durable: true,
    record,
    decide,
    noteUnverifiedPointer,
    advertisedTipReader,
    /* Diagnosis only: counters, never protocol pairs. */
    inspect: () => Object.freeze({
      schema: P02_TIP_MEMO_V2.SCHEMA,
      durable: true,
      counters: Object.freeze({ ...counters })
    })
  });
}
