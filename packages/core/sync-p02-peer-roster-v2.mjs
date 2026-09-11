/*
 * O1-T08 — configured peer roster, M.4 discovery, and pointer-lineage observation.
 *
 * Two things live here that are easy to conflate and must not be:
 *
 *   the ROSTER   which peers P02 is configured to look at. It is supplied by
 *                the caller from the configuration that already exists; this
 *                module stores no trust of its own and creates no database.
 *                An unknown writer found in the repository is REPORTED and
 *                nothing else - not adopted, not trusted, not applied, and
 *                never written back into configuration.
 *
 *   the OBSERVER which records what a writer's pointer looked like last time
 *                and says whether the current pointer moved forward, repeated,
 *                or went backwards. It is integrity EVIDENCE. It repairs
 *                nothing and rolls nothing back, because a peer's pointer is
 *                that peer's to write.
 *
 * DISCOVERY IS NARROW BY CONSTRUCTION. A configured peer's writer root is
 * derivable from its identity, so finding it needs no directory listing at all:
 * derive the key, read one pointer. Listing is required only to notice writers
 * nobody configured, so it is optional, injected, and its absence simply means
 * unknown-writer reporting is unavailable rather than empty - which are very
 * different statements and must not be confused.
 *
 * The pointer document is exactly three keys - schema, writerSyncPeerId,
 * currentHeadsSnapshotSha256 - with no previous-pointer field and no
 * generation counter. Lineage therefore cannot be read out of a single
 * pointer; it only exists in the eye of an observer that remembers. That is why
 * this is observation rather than validation, and why a fresh observer reports
 * "no history" instead of guessing.
 *
 * Observation history is in-memory for the life of the process, for the same
 * reason as the Y-2 memo: a durable record of what a peer used to advertise
 * would be a second authority that can disagree with the repository, and
 * losing it must be harmless. Losing it means the next regression is missed,
 * not that a false one is reported.
 */

export const P02_PEER_ROSTER_V2 = Object.freeze({
  SCHEMA: 'h2o.studio.syncP02PeerRoster.v1',
  OBSERVER_SCHEMA: 'h2o.studio.syncP02PointerLineageObserver.v1'
});

export const P02_PEER_STATUS = Object.freeze({
  /* Configured, pointer read and verified. */
  VERIFIED: 'verified',
  /* Configured, but this writer has never published a pointer. */
  ABSENT: 'absent',
  /* Configured, pointer present but not trustworthy. */
  QUARANTINED: 'quarantined',
  /* Configured, pointer readable but the snapshot it names is not there yet. */
  RETAINED_UNPROVEN_POINTER: 'retained-unproven-pointer',
  /* Configured, and the read itself failed. Says nothing about the writer. */
  UNREADABLE: 'unreadable'
});

export const P02_WRITER_ORIGIN = Object.freeze({
  CONFIGURED: 'configured',
  /* Present in the repository, named by nobody. Reported, never used. */
  UNKNOWN_REPORTED: 'unknown-reported'
});

export const P02_LINEAGE = Object.freeze({
  /* No prior observation. Not an anomaly - just the first look. */
  NO_HISTORY: 'no-history',
  /* Identical pointer. Nothing happened. */
  REPLAY: 'replay',
  /* A new pointer that keeps everything previously advertised. */
  FORWARD: 'forward',
  /* A new pointer that drops an object, or returns an object to a head that
   * had already been superseded. Reported; never repaired. */
  REGRESSED: 'regressed',
  /* The pointer could not be read this time. Says nothing about lineage. */
  UNREADABLE: 'unreadable'
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

const headPair = (head) =>
  `${clean(head?.revisionId)} ${clean(head?.revisionBlobSha256)}`;

/*
 * The roster. `configuredSyncPeerIds` comes from the configuration that
 * already exists - this module neither reads nor writes it.
 */
export function createP02PeerRoster({
  configuredSyncPeerIds = [],
  writerKeyFor,
  readWriterState,
  /* Optional. Absent means unknown-writer reporting is UNAVAILABLE, which is
   * not the same as "there are none". */
  listWriterRoots = null
} = {}) {
  requireFunction(writerKeyFor, 'p02-peer-roster-writer-key-invalid');
  requireFunction(readWriterState, 'p02-peer-roster-reader-invalid');
  if (!Array.isArray(configuredSyncPeerIds)) {
    throw new TypeError('p02-peer-roster-configuration-invalid');
  }
  const configured = [...new Set(configuredSyncPeerIds.map(clean).filter(Boolean))].sort();
  if (listWriterRoots !== null) {
    requireFunction(listWriterRoots, 'p02-peer-roster-listing-invalid');
  }

  /* Derived, not stored: the roster holds no trust database of its own. */
  async function configuredWriterKeys() {
    const rows = [];
    for (const syncPeerId of configured) {
      rows.push({ syncPeerId, writerKey: clean(await writerKeyFor(syncPeerId)) });
    }
    return rows;
  }

  function statusOf(state) {
    if (!isPlainObject(state)) return P02_PEER_STATUS.UNREADABLE;
    switch (state.status) {
      case 'verified': return P02_PEER_STATUS.VERIFIED;
      case 'absent': return P02_PEER_STATUS.ABSENT;
      case 'quarantined': return P02_PEER_STATUS.QUARANTINED;
      case 'retained-unproven-pointer': return P02_PEER_STATUS.RETAINED_UNPROVEN_POINTER;
      default: return P02_PEER_STATUS.UNREADABLE;
    }
  }

  /*
   * One read per configured peer, at a path derived from its identity. No
   * listing, no traversal, no discovery of anything that was not asked for.
   */
  async function discoverConfigured() {
    const peers = [];
    for (const { syncPeerId, writerKey } of await configuredWriterKeys()) {
      let state = null;
      let readError = null;
      try {
        state = await readWriterState({ writerSyncPeerId: syncPeerId });
      } catch (error) {
        readError = clean(error?.code) || 'p02-peer-roster-read-failed';
      }
      const status = readError ? P02_PEER_STATUS.UNREADABLE : statusOf(state);
      peers.push(Object.freeze({
        syncPeerId,
        writerKey: hex64(writerKey) ? writerKey : null,
        origin: P02_WRITER_ORIGIN.CONFIGURED,
        status,
        currentHeadsSnapshotSha256: status === P02_PEER_STATUS.VERIFIED
          ? clean(state.snapshot?.headsSnapshotSha256) || null
          : null,
        reason: readError || clean(state?.reason) || null
      }));
    }
    return Object.freeze({
      schema: P02_PEER_ROSTER_V2.SCHEMA,
      peers: Object.freeze(peers)
    });
  }

  /*
   * Unknown writers. This is a REPORT and nothing more: the returned rows carry
   * no pointer content, no tips, and no way to act on them. Nothing here reads
   * an unknown writer's documents, because reading them is the first step
   * towards treating them as real.
   */
  async function reportUnknownWriters() {
    if (listWriterRoots === null) {
      return Object.freeze({
        schema: P02_PEER_ROSTER_V2.SCHEMA,
        available: false,
        reason: 'no-listing-capability',
        unknownWriterKeys: Object.freeze([])
      });
    }
    const known = new Set(
      (await configuredWriterKeys()).map((row) => row.writerKey).filter(hex64)
    );
    let listed;
    try {
      listed = await listWriterRoots();
    } catch (error) {
      return Object.freeze({
        schema: P02_PEER_ROSTER_V2.SCHEMA,
        available: false,
        reason: clean(error?.code) || 'p02-peer-roster-listing-failed',
        unknownWriterKeys: Object.freeze([])
      });
    }
    const unknown = [...new Set(
      (Array.isArray(listed) ? listed : []).map(clean).filter(hex64)
    )].filter((key) => !known.has(key)).sort();
    return Object.freeze({
      schema: P02_PEER_ROSTER_V2.SCHEMA,
      available: true,
      reason: null,
      /* Keys only. Deliberately not peers, not pointers, not candidates. */
      unknownWriterKeys: Object.freeze(unknown),
      adopted: false,
      trusted: false,
      configurationMutated: false
    });
  }

  return Object.freeze({
    schema: P02_PEER_ROSTER_V2.SCHEMA,
    configuredSyncPeerIds: Object.freeze(configured),
    discoverConfigured,
    reportUnknownWriters
  });
}

/*
 * M.4 pointer-lineage observation.
 *
 * A pointer names one snapshot and says nothing about what it replaced, so
 * regression is only visible to something that remembers. This remembers, per
 * writer, the pointer hashes it has seen and the head pair each object was last
 * advertised at - enough to notice two distinct regressions:
 *
 *   an object that WAS advertised has vanished from the snapshot;
 *   an object has returned to a head pair that had already been superseded.
 *
 * Both are reported as evidence. Neither triggers repair, rollback, or any
 * write: another peer's pointer is that peer's to move, and a regression may be
 * an operator's deliberate restore. Deciding that is not this module's job.
 */
export function createP02PointerLineageObserver() {
  /* writerKey -> { pointers: Set, lastHeads: Map(objectKey -> pair),
   *                seenPairs: Map(objectKey -> Set(pair)) } */
  const history = new Map();

  function historyFor(writerKey) {
    let entry = history.get(writerKey);
    if (!entry) {
      entry = { pointers: new Set(), lastHeads: new Map(), seenPairs: new Map() };
      history.set(writerKey, entry);
    }
    return entry;
  }

  function observe({ writerKey, status, currentHeadsSnapshotSha256, heads = [] } = {}) {
    const key = clean(writerKey);
    if (!hex64(key)) {
      return Object.freeze({
        lineage: P02_LINEAGE.UNREADABLE, writerKey: null,
        reason: 'writer-key-invalid', repaired: false
      });
    }
    if (status !== P02_PEER_STATUS.VERIFIED || !hex64(clean(currentHeadsSnapshotSha256))) {
      /* An unreadable or unverified pointer is evidence about the READ, never
       * about lineage, so it must not disturb the recorded history. */
      return Object.freeze({
        lineage: P02_LINEAGE.UNREADABLE, writerKey: key,
        reason: clean(status) || 'pointer-unreadable', repaired: false
      });
    }
    const pointer = clean(currentHeadsSnapshotSha256);
    const entry = historyFor(key);

    if (entry.pointers.size === 0) {
      entry.pointers.add(pointer);
      for (const head of heads) {
        const objectKey = clean(head?.objectKey);
        if (!objectKey) continue;
        entry.lastHeads.set(objectKey, headPair(head));
        entry.seenPairs.set(objectKey, new Set([headPair(head)]));
      }
      return Object.freeze({
        lineage: P02_LINEAGE.NO_HISTORY, writerKey: key,
        pointer, reason: null, repaired: false
      });
    }

    const previousPointer = entry.lastPointer;
    if (pointer === previousPointer) {
      /* Identical pointer: nothing moved, so nothing is recorded. */
      return Object.freeze({
        lineage: P02_LINEAGE.REPLAY, writerKey: key,
        pointer, reason: null, repaired: false
      });
    }

    const incoming = new Map();
    for (const head of heads) {
      const objectKey = clean(head?.objectKey);
      if (!objectKey) continue;
      incoming.set(objectKey, headPair(head));
    }

    const dropped = [];
    const reverted = [];
    for (const [objectKey, lastPair] of entry.lastHeads) {
      if (!incoming.has(objectKey)) {
        dropped.push(objectKey);
        continue;
      }
      const nowPair = incoming.get(objectKey);
      if (nowPair === lastPair) continue;
      /* Returning to a pair this writer had already moved past. */
      if (entry.seenPairs.get(objectKey)?.has(nowPair)) reverted.push(objectKey);
    }

    /* Record the observation either way: the point is to describe what the
     * writer is doing, including when what it is doing looks wrong. */
    entry.pointers.add(pointer);
    entry.lastPointer = pointer;
    for (const [objectKey, pair] of incoming) {
      entry.lastHeads.set(objectKey, pair);
      const seen = entry.seenPairs.get(objectKey) || new Set();
      seen.add(pair);
      entry.seenPairs.set(objectKey, seen);
    }

    if (dropped.length > 0 || reverted.length > 0) {
      return Object.freeze({
        lineage: P02_LINEAGE.REGRESSED,
        writerKey: key,
        pointer,
        droppedObjectKeys: Object.freeze(dropped.sort()),
        revertedObjectKeys: Object.freeze(reverted.sort()),
        reason: dropped.length > 0 ? 'advertised-object-dropped' : 'head-returned-to-superseded-pair',
        /* Stated in the result so a consumer cannot read this as an action. */
        repaired: false,
        rolledBack: false
      });
    }
    return Object.freeze({
      lineage: P02_LINEAGE.FORWARD, writerKey: key,
      pointer, reason: null, repaired: false
    });
  }

  /* Seed the first observation's pointer so REPLAY works from the very first
   * look, without treating the first look itself as movement. */
  function observeFirstThen(entryKey, pointer) {
    const entry = historyFor(entryKey);
    entry.lastPointer = pointer;
  }

  return Object.freeze({
    schema: P02_PEER_ROSTER_V2.OBSERVER_SCHEMA,
    durable: false,
    observe(input) {
      const result = observe(input);
      if (result.lineage === P02_LINEAGE.NO_HISTORY) {
        observeFirstThen(clean(input?.writerKey), result.pointer);
      }
      return result;
    },
    /* Losing observation history is supported: it costs a missed regression,
     * never a false one. */
    clear() { history.clear(); },
    inspect() {
      return Object.freeze({
        schema: P02_PEER_ROSTER_V2.OBSERVER_SCHEMA,
        writers: history.size
      });
    }
  });
}
