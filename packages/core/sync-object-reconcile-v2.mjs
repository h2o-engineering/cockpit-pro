/*
 * O1-T13 — generic receive composition core.
 *
 * This is the frozen receive loop and nothing else. It owns no semantics: the
 * gate, the anchor contract, admission, capacity, classification and the memo
 * all live elsewhere and are injected. What lives HERE is the order in which
 * they are consulted, and the discipline that one peer's or one object's
 * failure cannot become another's.
 *
 * DOMAIN-BLIND, TRANSPORT-BLIND, PLATFORM-NEUTRAL. It imports nothing from
 * Desktop, Chrome, a filesystem, a database or a clock, and it knows no chat
 * schema. `objectDomain` flows through as DATA - it is compared and carried,
 * never interpreted - so a second domain needs an adapter, not a fork of this
 * file. A static validator pins that boundary, because a boundary nobody checks
 * is a boundary that erodes on the first convenient import.
 *
 * TWO AUTHORITIES, NEVER CONFUSED.
 *
 *   Y-2 says what a verified snapshot ADVERTISED. It saves a re-derivation and
 *   decides nothing.
 *
 *   ADMITTED EVIDENCE says what has been PROCESSED. It alone decides whether a
 *   tip still needs work.
 *
 * So a matching snapshot hash never suppresses a tip that admitted evidence
 * does not cover - not one that is missing, not one refused for capacity, not
 * one that failed last pass. The memo can only ever cause more work.
 *
 * ONE RESULT LANGUAGE. Every stage maps into the accepted T03 outcome taxonomy.
 * A stage that invented its own shape would force every caller to learn a
 * second vocabulary and would make the retry policy stage-dependent, which is
 * exactly how transient failures start being retried like permanent ones.
 *
 * ADMISSION IS NOT APPLY. The core never mutates canonical content. It hands
 * off an Apply candidate only when every condition below holds, and the
 * platform still gets the final refusal.
 */

import {
  P02_ATTEMPT_OUTCOME,
  P02_SCHEDULER_DIRECTION
} from './sync-object-scheduler-v2.mjs';
import { P02_CLASSIFICATION } from './sync-object-classifier-v2.mjs';
import { P02_ADMISSION_DISPOSITION } from './sync-branch-evidence-v2.mjs';

export const P02_RECEIVE_V2 = Object.freeze({
  SCHEMA: 'h2o.studio.syncObjectReceive.p02.v1',
  /* Bounded so one peer advertising an enormous group cannot make a pass
   * unbounded. Correctness never depends on the value: every pass re-reads. */
  DEFAULT_MAX_TIPS_PER_PASS: 64
});

/* Per-stage reasons, all of which reduce to a T03 outcome. */
export const P02_RECEIVE_STAGE = Object.freeze({
  WRITER_STATE: 'writer-state',
  HEADS_SNAPSHOT: 'heads-snapshot',
  ADVERTISED_TIPS: 'advertised-tips',
  REVISION_READ: 'revision-read',
  ANCESTRY: 'ancestry',
  ADMISSION: 'admission',
  CLASSIFICATION: 'classification',
  APPLY_HANDOFF: 'apply-handoff'
});

export const P02_RECEIVE_PEER_STATE = Object.freeze({
  /* The peer has never published. Not a failure. */
  ABSENT: 'absent',
  PROCESSED: 'processed',
  BLOCKED: 'blocked',
  INTEGRITY: 'integrity'
});

const clean = (value) => (typeof value === 'string' ? value.trim() : '');
const isPlainObject = (value) =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const HEX64 = /^[0-9a-f]{64}$/;
const hex64 = (value) => typeof value === 'string' && HEX64.test(value);

function requireFunction(value, code) {
  if (typeof value !== 'function') throw new TypeError(code);
  return value;
}

/*
 * Every stage failure becomes one of these, so the caller reads one vocabulary
 * and the retry policy is a property of the CLASS, not of which stage happened
 * to fail.
 */
function outcome(kind, { stage, reason, blockReason = null, extra = {} }) {
  return Object.freeze({
    outcome: kind,
    stage,
    reason: clean(reason) || null,
    blockReason,
    ...extra
  });
}
const transportBlocked = (stage, reason, extra) =>
  outcome(P02_ATTEMPT_OUTCOME.BLOCKED, {
    stage, reason, blockReason: 'transport', extra
  });
const capacityBlocked = (stage, reason, extra) =>
  outcome(P02_ATTEMPT_OUTCOME.BLOCKED, {
    stage, reason, blockReason: 'capacity', extra
  });
const integrity = (stage, reason, extra) =>
  outcome(P02_ATTEMPT_OUTCOME.INTEGRITY, { stage, reason, extra });
const noEffect = (stage, reason, extra) =>
  outcome(P02_ATTEMPT_OUTCOME.NO_EFFECT, { stage, reason, extra });
const progress = (stage, reason, extra) =>
  outcome(P02_ATTEMPT_OUTCOME.PROGRESS, { stage, reason, extra });

/* A tip's identity is the full protocol pair. A bare revisionId would let a
 * same-id/different-blob squat look like a tip we already hold. */
const tipKey = (tip) =>
  `${clean(tip?.revisionId)} ${clean(tip?.revisionBlobSha256)}`;

function normalizeTip(tip, objectDomain) {
  if (!isPlainObject(tip)) return null;
  const revisionId = clean(tip.revisionId);
  const revisionBlobSha256 = clean(tip.revisionBlobSha256);
  const objectKey = clean(tip.objectKey);
  const objectId = clean(tip.objectId);
  if (!revisionId || !hex64(revisionBlobSha256) || !hex64(objectKey) || !objectId) {
    return null;
  }
  return Object.freeze({
    /* Carried as data. This module never interprets a domain. */
    objectDomain: clean(tip.objectDomain) || objectDomain,
    objectId,
    objectKey,
    revisionId,
    revisionBlobSha256,
    payloadSha256: clean(tip.payloadSha256) || null,
    previousRevisionId: tip.previousRevisionId ?? null,
    previousRevisionBlobSha256: tip.previousRevisionBlobSha256 ?? null
  });
}

export function createP02ReceiveComposition({
  /* --- ports. Every capability is injected; none is imported. --- */
  configuredPeers,
  readWriterState,
  readRevisionBytes,
  fetchAncestry,
  readAdmittedEvidence,
  admitRevision,
  classifyObject,
  anchorSetFor,
  readTipMemo,
  writeTipMemo,
  applyAuthority = null,
  protocolStateFor,
  onTrace = null,
  maxTipsPerPass = P02_RECEIVE_V2.DEFAULT_MAX_TIPS_PER_PASS
} = {}) {
  requireFunction(configuredPeers, 'p02-receive-peers-invalid');
  requireFunction(readWriterState, 'p02-receive-writer-state-invalid');
  requireFunction(readRevisionBytes, 'p02-receive-revision-reader-invalid');
  requireFunction(fetchAncestry, 'p02-receive-ancestry-invalid');
  requireFunction(readAdmittedEvidence, 'p02-receive-evidence-reader-invalid');
  requireFunction(admitRevision, 'p02-receive-admission-invalid');
  requireFunction(classifyObject, 'p02-receive-classifier-invalid');
  requireFunction(anchorSetFor, 'p02-receive-anchor-invalid');
  requireFunction(readTipMemo, 'p02-receive-memo-reader-invalid');
  requireFunction(writeTipMemo, 'p02-receive-memo-writer-invalid');
  requireFunction(protocolStateFor, 'p02-receive-protocol-state-invalid');
  if (applyAuthority !== null) {
    requireFunction(applyAuthority, 'p02-receive-apply-authority-invalid');
  }
  const trace = onTrace === null ? null : requireFunction(onTrace, 'p02-receive-trace-invalid');
  const emit = (record) => { if (trace) trace(record); };

  /*
   * STEP 1. Read the peer's writer state.
   *
   * The three failure shapes are kept apart because they mean different things
   * to the memo. An unreadable or unproven pointer must RETAIN the last
   * verified memo - inventing an empty remote state from a failed read would
   * let a transport hiccup rewrite what we believe a peer published.
   */
  async function readPeer(syncPeerId) {
    let state;
    try {
      state = await readWriterState({ syncPeerId });
    } catch (error) {
      return {
        state: P02_RECEIVE_PEER_STATE.BLOCKED,
        result: transportBlocked(P02_RECEIVE_STAGE.WRITER_STATE,
          clean(error?.code) || 'writer-state-read-failed'),
        retainMemo: true
      };
    }
    const status = clean(state?.status);
    if (status === 'absent') {
      return {
        state: P02_RECEIVE_PEER_STATE.ABSENT,
        result: noEffect(P02_RECEIVE_STAGE.WRITER_STATE, 'peer-has-never-published'),
        retainMemo: true
      };
    }
    if (status === 'quarantined') {
      return {
        state: P02_RECEIVE_PEER_STATE.INTEGRITY,
        result: integrity(P02_RECEIVE_STAGE.WRITER_STATE,
          clean(state?.reason) || 'writer-state-quarantined'),
        retainMemo: true
      };
    }
    if (status !== 'verified') {
      /* retained-unproven-pointer and anything else unreadable. */
      return {
        state: P02_RECEIVE_PEER_STATE.BLOCKED,
        result: transportBlocked(P02_RECEIVE_STAGE.WRITER_STATE,
          clean(state?.reason) || status || 'writer-state-unproven'),
        retainMemo: true
      };
    }
    /*
     * STEP 2. Only VERIFIED bytes may become advertised input. A verified
     * pointer naming a snapshot we could not read promised something the
     * repository did not deliver, which is a transport fact, not an empty
     * advertisement.
     */
    const snapshotSha256 = clean(state?.snapshot?.headsSnapshotSha256);
    if (!hex64(snapshotSha256) || !Array.isArray(state?.snapshot?.heads)) {
      return {
        state: P02_RECEIVE_PEER_STATE.BLOCKED,
        result: transportBlocked(P02_RECEIVE_STAGE.HEADS_SNAPSHOT,
          'verified-pointer-snapshot-unavailable'),
        retainMemo: true
      };
    }
    return { state: 'verified', snapshotSha256, heads: state.snapshot.heads };
  }

  /*
   * STEP 3. Group advertised tips per (peer, objectKey).
   *
   * Peers are kept separate deliberately. Flattening two writers into one
   * advertisement would make peer A's tip look like evidence about peer B's
   * lane, and one peer's fork would become everyone's fork.
   */
  function groupAdvertised(heads, objectDomain) {
    const groups = new Map();
    for (const head of heads) {
      const tip = normalizeTip(head, objectDomain);
      if (tip === null) continue;
      const group = groups.get(tip.objectKey) || {
        objectDomain: tip.objectDomain, objectId: tip.objectId,
        objectKey: tip.objectKey, tips: []
      };
      group.tips.push(tip);
      groups.set(tip.objectKey, group);
    }
    return groups;
  }

  /*
   * STEPS 4-8 for one (peer, object). Every failure returns rather than throws,
   * so one object cannot abort the peer's other objects.
   */
  async function receiveObject({ syncPeerId, peerWriterKey, snapshotSha256, group }) {
    const scope = {
      syncPeerId, peerWriterKey,
      objectDomain: group.objectDomain, objectId: group.objectId, objectKey: group.objectKey
    };

    /* STEP 4. The memo may only skip RE-DERIVATION. Admitted evidence decides
     * what still needs work, and it is read regardless of what the memo says. */
    let admitted;
    try {
      admitted = await readAdmittedEvidence(scope);
    } catch (error) {
      return { ...scope, result: transportBlocked(P02_RECEIVE_STAGE.ADMISSION,
        clean(error?.code) || 'admitted-evidence-unreadable') };
    }
    const admittedPairs = new Set(
      (Array.isArray(admitted) ? admitted : []).map(tipKey)
    );

    let memo = null;
    try {
      memo = await readTipMemo({ ...scope, snapshotSha256 });
    } catch (_) {
      /* A memo that cannot be read costs a re-derivation, nothing more. */
      memo = null;
    }
    const memoReusable = memo?.reuse === true;

    /* The outstanding set is computed from ADMITTED EVIDENCE, never from the
     * memo. A tip the memo lists but evidence does not cover is outstanding. */
    const outstanding = group.tips.filter((tip) => !admittedPairs.has(tipKey(tip)));
    const bounded = outstanding.slice(0, maxTipsPerPass);
    const deferred = outstanding.length - bounded.length;

    const anchorSet = await anchorSetFor(scope);
    const protocolState = await protocolStateFor(scope);
    const stageResults = [];

    for (const tip of bounded) {
      /* STEP 5. Read the immutable revision. No admission from metadata. */
      let read;
      try {
        read = await readRevisionBytes({ ...scope, ...tip });
      } catch (error) {
        stageResults.push(transportBlocked(P02_RECEIVE_STAGE.REVISION_READ,
          clean(error?.code) || 'revision-read-failed', { tip }));
        continue;
      }
      const readStatus = clean(read?.status);
      if (readStatus === 'absent' || readStatus === 'missing') {
        stageResults.push(transportBlocked(P02_RECEIVE_STAGE.REVISION_READ,
          'revision-not-yet-available', { tip }));
        continue;
      }
      if (readStatus === 'blocked(permission)') {
        stageResults.push(outcome(P02_ATTEMPT_OUTCOME.BLOCKED, {
          stage: P02_RECEIVE_STAGE.REVISION_READ,
          reason: 'permission', blockReason: 'permission', extra: { tip }
        }));
        continue;
      }
      if (readStatus !== 'verified') {
        /* integrity, malformed, hash mismatch: the bytes are wrong, not late. */
        stageResults.push(integrity(P02_RECEIVE_STAGE.REVISION_READ,
          clean(read?.reason) || readStatus || 'revision-unverified', { tip }));
        continue;
      }

      /* STEP 6. Ancestry, seeded with the accepted anchor set. */
      let ancestry;
      try {
        ancestry = await fetchAncestry({ ...scope, ...tip, p02AnchorSet: anchorSet });
      } catch (error) {
        stageResults.push(transportBlocked(P02_RECEIVE_STAGE.ANCESTRY,
          clean(error?.code) || 'ancestry-probe-failed', { tip }));
        continue;
      }
      const ancestryOutcome = clean(ancestry?.outcome);
      if (ancestryOutcome === 'retained-unproven-parent') {
        /* Incomplete, not contradictory. A partial sync heals itself. */
        stageResults.push(transportBlocked(P02_RECEIVE_STAGE.ANCESTRY,
          'ancestry-incomplete', { tip, retainedEvidence: true }));
        continue;
      }
      if (ancestryOutcome === 'quarantined') {
        stageResults.push(integrity(P02_RECEIVE_STAGE.ANCESTRY,
          clean(ancestry?.reason) || 'ancestry-quarantined', { tip }));
        continue;
      }
      if (ancestryOutcome !== 'proven-chain') {
        stageResults.push(transportBlocked(P02_RECEIVE_STAGE.ANCESTRY,
          ancestryOutcome || 'ancestry-unknown', { tip }));
        continue;
      }

      /* STEP 7. Platform v2 admission. Parent pairs are mandatory there. */
      let admission;
      try {
        admission = await admitRevision({
          ...scope, ...tip,
          revisionBlobBytes: read.bytes, revision: read.value,
          protocolState, p02AnchorSet: anchorSet
        });
      } catch (error) {
        stageResults.push(transportBlocked(P02_RECEIVE_STAGE.ADMISSION,
          clean(error?.code) || 'admission-failed', { tip }));
        continue;
      }
      if (clean(admission?.blockedReason) === 'capacity' || admission?.admitted === false) {
        if (clean(admission?.blockedReason) === 'capacity') {
          /* Refused, therefore NOT complete. The memo must never suppress its
           * retry - which it cannot, because evidence still lacks it. */
          stageResults.push(capacityBlocked(P02_RECEIVE_STAGE.ADMISSION,
            'evidence-capacity-exhausted', { tip, retryable: true }));
          continue;
        }
        stageResults.push(integrity(P02_RECEIVE_STAGE.ADMISSION,
          clean(admission?.reason) || 'admission-refused', { tip }));
        continue;
      }
      if (admission?.disposition === P02_ADMISSION_DISPOSITION.QUARANTINED) {
        stageResults.push(integrity(P02_RECEIVE_STAGE.ADMISSION,
          clean(admission?.reason) || 'quarantined', { tip }));
        continue;
      }
      if (admission?.disposition === P02_ADMISSION_DISPOSITION.RETAINED_UNPROVEN_PARENT) {
        stageResults.push(transportBlocked(P02_RECEIVE_STAGE.ADMISSION,
          'retained-unproven-parent', { tip, retainedEvidence: true }));
        continue;
      }
      stageResults.push(progress(P02_RECEIVE_STAGE.ADMISSION,
        clean(admission?.disposition) || 'admitted',
        { tip, replay: admission?.replay === true }));
    }

    /* STEP 8. Classify from the object's OWN state. CR1: nothing about another
     * object or another peer's candidates enters here. */
    let classification;
    try {
      classification = await classifyObject({
        ...scope, advertisedTips: group.tips, protocolState, p02AnchorSet: anchorSet
      });
    } catch (error) {
      return { ...scope, result: integrity(P02_RECEIVE_STAGE.CLASSIFICATION,
        clean(error?.code) || 'classification-failed'), stageResults };
    }

    /* STEP 9. Apply eligibility. Admission alone never implies Apply. */
    const handoff = await selectApplyCandidate({
      scope, classification, group, stageResults, protocolState, anchorSet,
      admittedPairs: new Set([
        ...admittedPairs,
        ...stageResults
          .filter((r) => r.outcome === P02_ATTEMPT_OUTCOME.PROGRESS && r.tip)
          .map((r) => tipKey(r.tip))
      ])
    });

    /* The object's own result is the most severe thing that happened TO IT. */
    const result = summarize(stageResults, {
      deferred, handoff, memoReusable, outstanding: outstanding.length
    });
    emit({ ...scope, result, classification: classification?.classification ?? null });
    return {
      ...scope, result, stageResults, handoff,
      classification: classification?.classification ?? null,
      outstandingTipCount: outstanding.length
    };
  }

  /*
   * Apply eligibility. Every condition must hold; the platform authority still
   * gets the last word, because only it knows whether a write window exists.
   */
  async function selectApplyCandidate({
    scope, classification, group, protocolState, anchorSet, admittedPairs
  }) {
    const verdict = clean(classification?.classification);
    const eligibleClass = verdict === P02_CLASSIFICATION.REMOTE_AHEAD ||
      verdict === P02_CLASSIFICATION.OBJECT_DELETED;
    if (!eligibleClass) {
      return Object.freeze({ eligible: false, reason: verdict || 'not-remote-ahead', candidate: null });
    }
    if (classification?.integrityQuarantined === true ||
        verdict === P02_CLASSIFICATION.INTEGRITY_QUARANTINED) {
      return Object.freeze({ eligible: false, reason: 'integrity-quarantined', candidate: null });
    }
    /* Every advertised tip must be admitted. An object with outstanding work
     * has unproven ancestry somewhere in its graph by definition. */
    const unadmitted = group.tips.filter((tip) => !admittedPairs.has(tipKey(tip)));
    if (unadmitted.length > 0) {
      return Object.freeze({
        eligible: false, reason: 'advertised-tip-not-admitted', candidate: null,
        outstanding: unadmitted.length
      });
    }
    /* Exactly one live leaf, or there is nothing unambiguous to apply. */
    const leaves = Array.isArray(classification?.applyCandidates)
      ? classification.applyCandidates
      : group.tips;
    if (leaves.length !== 1) {
      return Object.freeze({
        eligible: false, reason: 'ambiguous-apply-candidate', candidate: null,
        leafCount: leaves.length
      });
    }
    const candidate = leaves[0];
    if (applyAuthority === null) {
      return Object.freeze({ eligible: false, reason: 'no-apply-authority', candidate: null });
    }
    let permitted;
    try {
      permitted = await applyAuthority({ ...scope, candidate, protocolState, p02AnchorSet: anchorSet });
    } catch (error) {
      return Object.freeze({
        eligible: false, reason: clean(error?.code) || 'apply-authority-failed', candidate: null
      });
    }
    if (permitted?.permitted !== true) {
      return Object.freeze({
        eligible: false, reason: clean(permitted?.reason) || 'apply-not-permitted',
        blockReason: clean(permitted?.blockReason) || null, candidate: null
      });
    }
    return Object.freeze({
      eligible: true, reason: null, candidate,
      direction: P02_SCHEDULER_DIRECTION.RECEIVE
    });
  }

  /*
   * The object's outcome is the most severe stage result. Severity order is
   * deliberate: an integrity contradiction outranks a transport miss, because
   * the miss might heal and the contradiction will not.
   */
  function summarize(stageResults, { deferred, handoff, memoReusable, outstanding }) {
    const severity = [
      P02_ATTEMPT_OUTCOME.INTEGRITY,
      P02_ATTEMPT_OUTCOME.BLOCKED,
      P02_ATTEMPT_OUTCOME.INDETERMINATE,
      P02_ATTEMPT_OUTCOME.TRANSIENT,
      P02_ATTEMPT_OUTCOME.PROGRESS,
      P02_ATTEMPT_OUTCOME.NO_EFFECT
    ];
    let worst = null;
    for (const kind of severity) {
      const found = stageResults.find((item) => item.outcome === kind);
      if (found) { worst = found; break; }
    }
    if (worst === null) {
      return Object.freeze({
        outcome: outstanding === 0 && memoReusable
          ? P02_ATTEMPT_OUTCOME.NO_EFFECT
          : P02_ATTEMPT_OUTCOME.NO_EFFECT,
        stage: P02_RECEIVE_STAGE.ADVERTISED_TIPS,
        reason: outstanding === 0 ? 'nothing-outstanding' : 'no-tips-processed',
        blockReason: null,
        applyEligible: handoff?.eligible === true,
        fastPath: outstanding === 0 && memoReusable
      });
    }
    return Object.freeze({
      ...worst,
      deferredTipCount: deferred,
      applyEligible: handoff?.eligible === true,
      fastPath: false
    });
  }

  /*
   * One receive pass over every configured peer.
   *
   * Peer isolation is structural: each peer is processed in its own try, and a
   * peer's failure produces that peer's result. Only a failure of the roster
   * itself - which is a genuine global authority failure - stops the pass.
   */
  async function receivePass({ objectDomain = null } = {}) {
    let peers;
    try {
      peers = await configuredPeers();
    } catch (error) {
      return Object.freeze({
        schema: P02_RECEIVE_V2.SCHEMA,
        peers: Object.freeze([]),
        objects: Object.freeze([]),
        applyCandidates: Object.freeze([]),
        globalFailure: transportBlocked(P02_RECEIVE_STAGE.WRITER_STATE,
          clean(error?.code) || 'peer-roster-unavailable')
      });
    }

    const peerReports = [];
    const objectReports = [];
    for (const peer of Array.isArray(peers) ? peers : []) {
      const syncPeerId = clean(peer?.syncPeerId);
      const peerWriterKey = clean(peer?.writerKey);
      if (!syncPeerId) continue;

      const read = await readPeer(syncPeerId);
      if (read.state !== 'verified') {
        /* An unreadable peer RETAINS its memo: nothing here clears one. */
        peerReports.push(Object.freeze({
          syncPeerId, state: read.state, result: read.result,
          retainedLastVerifiedMemo: read.retainMemo === true, objectCount: 0
        }));
        continue;
      }

      const groups = groupAdvertised(read.heads, objectDomain);
      const perObject = [];
      for (const group of groups.values()) {
        let report;
        try {
          report = await receiveObject({
            syncPeerId, peerWriterKey, snapshotSha256: read.snapshotSha256, group
          });
        } catch (error) {
          /* CR1: one object's failure is that object's result. */
          report = {
            syncPeerId, peerWriterKey,
            objectDomain: group.objectDomain, objectId: group.objectId,
            objectKey: group.objectKey,
            result: integrity(P02_RECEIVE_STAGE.CLASSIFICATION,
              clean(error?.code) || 'object-processing-failed'),
            stageResults: [], handoff: { eligible: false, reason: 'object-failed', candidate: null }
          };
        }
        perObject.push(report);
        objectReports.push(report);
      }

      /*
       * The memo is written only after the whole peer's admission processing
       * reached its boundary, and it records the COMPLETE advertised set
       * regardless of individual outcomes - it describes the advertisement, not
       * our processing of it. A failed write costs a re-derivation, never the
       * pass.
       */
      for (const group of groups.values()) {
        try {
          await writeTipMemo({
            syncPeerId, peerWriterKey,
            objectDomain: group.objectDomain, objectId: group.objectId,
            objectKey: group.objectKey,
            snapshotSha256: read.snapshotSha256,
            tips: group.tips,
            writerStateVerified: true,
            headsSnapshotVerified: true,
            admissionBoundaryComplete: true
          });
        } catch (_) { /* Memo loss is harmless by construction. */ }
      }

      peerReports.push(Object.freeze({
        syncPeerId,
        state: P02_RECEIVE_PEER_STATE.PROCESSED,
        snapshotSha256: read.snapshotSha256,
        objectCount: perObject.length,
        result: noEffect(P02_RECEIVE_STAGE.ADVERTISED_TIPS, 'peer-processed'),
        retainedLastVerifiedMemo: false
      }));
    }

    return Object.freeze({
      schema: P02_RECEIVE_V2.SCHEMA,
      peers: Object.freeze(peerReports),
      objects: Object.freeze(objectReports.map((report) => Object.freeze({
        syncPeerId: report.syncPeerId,
        objectDomain: report.objectDomain,
        objectId: report.objectId,
        objectKey: report.objectKey,
        classification: report.classification ?? null,
        result: report.result,
        applyEligible: report.handoff?.eligible === true,
        applyRefusedBecause: report.handoff?.eligible === true
          ? null : (report.handoff?.reason ?? null),
        outstandingTipCount: report.outstandingTipCount ?? 0
      }))),
      /* The handoff. This core mutates no canonical content; the platform
       * Apply adapter takes it from here and may still refuse. */
      applyCandidates: Object.freeze(objectReports
        .filter((report) => report.handoff?.eligible === true)
        .map((report) => Object.freeze({
          syncPeerId: report.syncPeerId,
          objectDomain: report.objectDomain,
          objectId: report.objectId,
          objectKey: report.objectKey,
          candidate: report.handoff.candidate
        }))),
      globalFailure: null
    });
  }

  return Object.freeze({
    schema: P02_RECEIVE_V2.SCHEMA,
    receivePass,
    /* Exposed for per-object drive loops; same rules, one object. */
    receiveObject
  });
}
