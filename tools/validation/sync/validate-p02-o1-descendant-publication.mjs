#!/usr/bin/env node
/*
 * O1-T16 — descendant parent selection, onboarding, and recovery.
 *
 * Every test here is written against the same failure mode: a TEMPORARY
 * inability to read the repository being promoted into a PERMANENT verdict.
 * That failure has three faces and all three are destructive.
 *
 *   an incomplete descent probe read as "no descent"  -> permanent conflict
 *   an unreadable anchor read as "no anchor"          -> a second v2 root
 *   a failed pointer read treated as absence          -> a stranded mint
 *
 * A partial folder sync heals itself. A conflict verdict, a forked root and an
 * abandoned-but-published revision do not. So the tests below spend most of
 * their effort proving that each transient condition produces a retry rather
 * than a decision.
 *
 * Pure decision cores, driven with injected probes. Disposable: no repository,
 * no canonical state, no processes.
 */
import crypto from 'node:crypto';
import {
  P02_DESCENDANT_V2,
  P02_ONBOARDING,
  P02_PARENT_SELECTION,
  P02_RECOVERY_DISPOSITION,
  classifyIntentRecovery,
  evaluateOnboardingEligibility,
  selectPublicationParent
} from '../../../packages/core/sync-p02-descendant-publication-v2.mjs';

let assertions = 0;
const failures = [];
const check = (condition, label) => {
  assertions += 1;
  if (condition !== true) failures.push(label);
};
const equal = (actual, expected, label) =>
  check(actual === expected, `${label} (expected ${String(expected)}, got ${String(actual)})`);

const hex = (seed) => crypto.createHash('sha256').update(String(seed)).digest('hex');
const PUBLISHED = { revisionId: 'p02-published', revisionBlobSha256: hex('pub') };
const APPLIED = { revisionId: 'p02-applied', revisionBlobSha256: hex('app') };

const verifiedAll = async () => ({ status: 'verified' });
const select = (over = {}) => selectPublicationParent({
  protocolState: { lastPublished: PUBLISHED, lastApplied: APPLIED },
  proveAnchor: verifiedAll,
  probeDescent: async () => ({ outcome: 'proven-chain', descendsFromSeed: false }),
  ownHeadsGroup: null,
  ...over
});

/* ===== 1. Only one anchor proven ===== */
{
  const publishedOnly = await select({
    protocolState: { lastPublished: PUBLISHED, lastApplied: null }
  });
  equal(publishedOnly.selection, P02_PARENT_SELECTION.DESCENDANT,
    'P1-1 published proven alone parents on published');
  equal(publishedOnly.parent.revisionId, PUBLISHED.revisionId, 'P1-2 by pair');
  equal(publishedOnly.parentOrigin, 'published', 'P1-3 attributed');

  const appliedOnly = await select({
    protocolState: { lastPublished: null, lastApplied: APPLIED }
  });
  equal(appliedOnly.selection, P02_PARENT_SELECTION.DESCENDANT,
    'P1-4 applied proven alone parents on applied');
  equal(appliedOnly.parentOrigin, 'applied', 'P1-5 attributed');

  /* A column value the repository cannot verify is not an anchor. */
  const unverifiable = await select({
    protocolState: { lastPublished: PUBLISHED, lastApplied: null },
    proveAnchor: async () => ({ status: 'absent' })
  });
  check(unverifiable.selection !== P02_PARENT_SELECTION.DESCENDANT,
    'P1-6 a column the repository cannot verify never becomes a parent');
}

/* ===== 2. Both proven and distinct: tri-state mutual descent ===== */
{
  /* Proven descent decides, and the direction hint only orders the probe. */
  const appliedDescends = await select({
    convergedDirection: 'applied',
    probeDescent: async (candidate) => ({
      outcome: 'proven-chain',
      descendsFromSeed: candidate.revisionId === APPLIED.revisionId
    })
  });
  equal(appliedDescends.selection, P02_PARENT_SELECTION.DESCENDANT,
    'P2-1 proven descent selects the descendant');
  equal(appliedDescends.parent.revisionId, APPLIED.revisionId, 'P2-2 the applied pair');
  equal(appliedDescends.probeOrderHint, 'applied',
    'P2-3 with the direction recorded as a probe-order hint');

  /* The hint does NOT decide: with the hint pointing the wrong way, the probe
   * still finds the true descendant. */
  const hintWrong = await select({
    convergedDirection: 'applied',
    probeDescent: async (candidate) => ({
      outcome: 'proven-chain',
      descendsFromSeed: candidate.revisionId === PUBLISHED.revisionId
    })
  });
  equal(hintWrong.parent.revisionId, PUBLISHED.revisionId,
    'P2-4 a misleading direction hint changes the ORDER, never the answer');

  /* Two complete chains, no descent: a real fork, refuse. */
  const forked = await select({
    probeDescent: async () => ({ outcome: 'proven-chain', descendsFromSeed: false })
  });
  equal(forked.selection, P02_PARENT_SELECTION.CONFLICT,
    'P2-5 two complete chains proving no descent is a conflict');
  equal(forked.parent, null, 'P2-6 and refuses publication');

  /* The same pair under both origins is not a fork at all. */
  const same = await select({
    protocolState: { lastPublished: PUBLISHED, lastApplied: { ...PUBLISHED } }
  });
  equal(same.selection, P02_PARENT_SELECTION.DESCENDANT,
    'P2-7 an apply this peer republished is one anchor, not two');
}

/* ===== 3. Incomplete evidence NEVER becomes a conflict ===== */
{
  for (const [outcome, description] of [
    ['retained-unproven-parent', 'a partially synced chain'],
    ['quarantined', 'a chain that could not be walked']
  ]) {
    const blocked = await select({ probeDescent: async () => ({ outcome, descendsFromSeed: false }) });
    equal(blocked.selection, P02_PARENT_SELECTION.BLOCKED_TRANSPORT,
      `P3-1 ${description} is blocked(transport), NOT a conflict`);
    equal(blocked.retry, true, `P3-2 and is retried (${outcome})`);
  }
  const threw = await select({ probeDescent: async () => { throw new Error('io'); } });
  equal(threw.selection, P02_PARENT_SELECTION.BLOCKED_TRANSPORT,
    'P3-3 a probe that throws is blocked, never a conflict');

  /* One complete probe finding no descent plus one incomplete probe is still
   * incomplete: the missing half might have contained the descent. */
  let call = 0;
  const half = await select({
    probeDescent: async () => {
      call += 1;
      return call === 1
        ? { outcome: 'proven-chain', descendsFromSeed: false }
        : { outcome: 'retained-unproven-parent', descendsFromSeed: false };
    }
  });
  equal(half.selection, P02_PARENT_SELECTION.BLOCKED_TRANSPORT,
    'P3-4 one complete and one incomplete probe is incomplete, not a conflict');
}

/* ===== 4. An unreadable anchor never produces a ROOT ===== */
{
  const unreadable = await select({
    protocolState: { lastPublished: PUBLISHED, lastApplied: null },
    proveAnchor: async () => { throw Object.assign(new Error('io'), { code: 'read-failed' }); }
  });
  equal(unreadable.selection, P02_PARENT_SELECTION.BLOCKED_TRANSPORT,
    'R1-1 an unreadable anchor is blocked, never treated as absent');
  check(unreadable.selection !== P02_PARENT_SELECTION.ROOT,
    'R1-2 and crucially never mints a second root');

  const conflicted = await select({
    proveAnchor: async () => ({ status: 'identity-conflict' })
  });
  equal(conflicted.selection, P02_PARENT_SELECTION.INTEGRITY,
    'R1-3 an anchor whose bytes contradict its id is an integrity statement');
}

/* ===== 5. ROOT is gated on the repository, not on local columns ===== */
{
  const genuineRoot = await select({
    protocolState: {}, ownHeadsGroup: null, ownPointerStatus: 'absent'
  });
  equal(genuineRoot.selection, P02_PARENT_SELECTION.ROOT,
    'R2-1 no anchor and no advertised group is a genuine v2 ROOT');

  /*
   * The P01-rollback case. Columns say "no anchor" but the repository still
   * advertises a group for this object. Minting a root here would fork the
   * object against its own published history, so repository presence outranks
   * column absence.
   */
  const clobbered = await select({
    protocolState: {},
    ownHeadsGroup: { objectKey: hex('obj'), tips: [{ revisionId: 'p02-existing' }] },
    ownPointerStatus: 'verified'
  });
  equal(clobbered.selection, P02_PARENT_SELECTION.INTEGRITY,
    'R2-2 an advertised group with no anchor is integrity, NOT a licence to re-root');
  equal(clobbered.reason, 'own-heads-group-present-without-anchor', 'R2-3 named exactly');

  /* An unread group cannot authorise a root either. */
  const unread = await select({ protocolState: {}, ownHeadsGroup: undefined });
  equal(unread.selection, P02_PARENT_SELECTION.BLOCKED_TRANSPORT,
    'R2-4 an unread heads group blocks rather than assuming absence');
  const unproven = await select({
    protocolState: {}, ownHeadsGroup: null, ownPointerStatus: 'quarantined'
  });
  equal(unproven.selection, P02_PARENT_SELECTION.BLOCKED_TRANSPORT,
    'R2-5 and an unproven own pointer blocks too');
}

/* ===== 6. First-P02 onboarding is its own lane ===== */
{
  const base = {
    ownPointer: { status: 'verified' }, ownHeadsGroup: null,
    pending: false, blockReason: null, integrityQuarantined: false,
    intentRecoveryComplete: true
  };
  equal(evaluateOnboardingEligibility(base).eligible, true,
    'O1-1 a P01-converged object with no advertised group is onboarding-eligible');
  equal(evaluateOnboardingEligibility(base).state, P02_ONBOARDING.ELIGIBLE, 'O1-2 named');

  /* Intent recovery runs FIRST: an object with work in flight is not a
   * candidate, and onboarding it would mint a competing revision. */
  const beforeRecovery = evaluateOnboardingEligibility({
    ...base, intentRecoveryComplete: false
  });
  equal(beforeRecovery.eligible, false, 'O1-3 onboarding waits for intent recovery');
  equal(beforeRecovery.reason, 'intent-recovery-must-run-first', 'O1-4 explicitly');

  for (const [over, reason, state] of [
    [{ pending: true }, 'pending-operation', P02_ONBOARDING.PENDING],
    [{ blockReason: 'capacity' }, 'capacity', P02_ONBOARDING.BLOCKED],
    [{ integrityQuarantined: true }, 'integrity-quarantined', P02_ONBOARDING.INTEGRITY_QUARANTINED],
    [{ ownHeadsGroup: { tips: [] } }, 'own-heads-group-present', P02_ONBOARDING.ALREADY_ADVERTISED]
  ]) {
    const result = evaluateOnboardingEligibility({ ...base, ...over });
    equal(result.eligible, false, `O1-5 ${reason} disqualifies onboarding`);
    equal(result.state, state, `O1-6 as ${state}`);
  }

  /* The pointer is re-read every pass; a failed read aborts the attempt. */
  for (const status of ['unreadable', 'quarantined', '']) {
    const result = evaluateOnboardingEligibility({ ...base, ownPointer: { status } });
    equal(result.state, P02_ONBOARDING.POINTER_UNREADABLE,
      `O1-7 a ${status || 'missing'} pointer aborts the attempt`);
  }
  /* Verified pointer naming a snapshot we cannot read is INTEGRITY-shaped:
   * the pointer promised something the repository did not deliver. */
  const snapshotGone = evaluateOnboardingEligibility({
    ...base, ownPointer: { status: 'verified' }, ownHeadsGroup: undefined
  });
  equal(snapshotGone.state, P02_ONBOARDING.SNAPSHOT_MISSING,
    'O1-8 a verified pointer whose snapshot is missing is distinct from unreadable');
}

/* ===== 7. Recovery: only VERIFIED evidence disproves ===== */
{
  const intent = {
    pendingOperation: 'publish',
    intendedRevisionId: 'p02-intended',
    intendedRevisionBlobSha256: hex('intended')
  };

  const adopted = classifyIntentRecovery({
    ...intent,
    pointerProof: {
      status: 'verified',
      namesRevisionId: 'p02-intended',
      namesRevisionBlobSha256: hex('intended')
    }
  });
  equal(adopted.disposition, P02_RECOVERY_DISPOSITION.ADOPT_AND_COMPLETE,
    'C1-1 a verified pointer naming the intent adopts and completes');
  equal(adopted.republished, false, 'C1-2 without republishing');

  const disproved = classifyIntentRecovery({
    ...intent,
    pointerProof: {
      status: 'verified',
      namesRevisionId: 'p02-something-else',
      namesRevisionBlobSha256: hex('other')
    }
  });
  equal(disproved.disposition, P02_RECOVERY_DISPOSITION.ABANDON_AND_REPLAN,
    'C1-3 a verified pointer NOT naming the intent disproves it');
  equal(disproved.retain, false, 'C1-4 abandoning with retain=false');
  equal(disproved.freshMintRequired, true,
    'C1-5 and re-planning with a fresh mint that cannot collide');

  const verifiedAbsent = classifyIntentRecovery({
    ...intent, pointerProof: { status: 'absent-verified' }
  });
  equal(verifiedAbsent.disposition, P02_RECOVERY_DISPOSITION.ABANDON_AND_REPLAN,
    'C1-6 verified ABSENCE is disproof');

  /* A read error is not absence. This is the asymmetry that stops a transient
   * failure abandoning an intent whose revision is already in the repository. */
  for (const status of ['unreadable', 'quarantined', 'retained-unproven-pointer', '']) {
    const aborted = classifyIntentRecovery({ ...intent, pointerProof: { status } });
    equal(aborted.disposition, P02_RECOVERY_DISPOSITION.ABORT_UNREADABLE,
      `C1-7 a ${status || 'missing'} pointer read aborts`);
    equal(aborted.retain, true, `C1-8 retaining the intent (${status || 'missing'})`);
    equal(aborted.disproved, false, `C1-9 and disproving nothing (${status || 'missing'})`);
  }
}

/* ===== 8. Recovery corrections: resumed=false and empty intent ===== */
{
  const notResumed = classifyIntentRecovery({
    pendingOperation: 'publish',
    intendedRevisionId: 'p02-intended',
    intendedRevisionBlobSha256: hex('intended'),
    adoptIntent: { resumed: false },
    pointerProof: { status: 'verified', namesRevisionId: 'p02-intended' }
  });
  equal(notResumed.disposition, P02_RECOVERY_DISPOSITION.ABANDON_EMPTY_INTENT,
    'C2-1 an acquisition that did not resume has nothing to recover');
  equal(notResumed.abandonFreshRow, true, 'C2-2 the fresh empty row is abandoned');
  equal(notResumed.releaseMemorySlot, true,
    'C2-3 and the in-memory slot released - otherwise the object is pinned forever');

  const emptyIntent = classifyIntentRecovery({
    pendingOperation: 'publish',
    intendedRevisionId: null, intendedRevisionBlobSha256: null,
    pointerProof: { status: 'verified' }
  });
  equal(emptyIntent.disposition, P02_RECOVERY_DISPOSITION.ABANDON_EMPTY_INTENT,
    'C2-4 a pending publish row with no intent is abandonable');
  equal(emptyIntent.reason, 'pending-publish-with-empty-intent', 'C2-5 by name');
  equal(emptyIntent.retain, false, 'C2-6 and is not retained');

  /* resumed=false outranks even a pointer that would otherwise adopt: there is
   * no OUR row to adopt into. */
  check(notResumed.disposition !== P02_RECOVERY_DISPOSITION.ADOPT_AND_COMPLETE,
    'C2-7 resumed=false is decided before any pointer evidence is consulted');
}

/* ===== 9. The permanently-unpublishable object, and its recovery ===== */
{
  /*
   * The regression. An object reaches a state where every pass refuses it and
   * nothing ever changes: a pending publish row whose acquisition never
   * resumes, holding a memory slot, while the pointer is unreadable. Without
   * the corrections above, such an object publishes never again.
   */
  const stuck = {
    pendingOperation: 'publish',
    intendedRevisionId: 'p02-orphan',
    intendedRevisionBlobSha256: hex('orphan'),
    adoptIntent: { resumed: false },
    pointerProof: { status: 'unreadable' }
  };
  const freed = classifyIntentRecovery(stuck);
  equal(freed.disposition, P02_RECOVERY_DISPOSITION.ABANDON_EMPTY_INTENT,
    'U1 the stuck row is abandonable even while the pointer is unreadable');
  equal(freed.releaseMemorySlot, true, 'U2 releasing the slot that pinned it');

  /* With the row abandoned and the slot released, the object is a normal
   * onboarding candidate again once recovery has run. */
  const recovered = evaluateOnboardingEligibility({
    ownPointer: { status: 'verified' }, ownHeadsGroup: null,
    pending: false, blockReason: null, integrityQuarantined: false,
    intentRecoveryComplete: true
  });
  equal(recovered.eligible, true, 'U3 and the object becomes publishable again');

  /* And it selects a real parent rather than re-rooting. */
  const parented = await selectPublicationParent({
    protocolState: { lastPublished: PUBLISHED },
    proveAnchor: verifiedAll,
    probeDescent: async () => ({ outcome: 'proven-chain', descendsFromSeed: true }),
    ownHeadsGroup: null
  });
  equal(parented.selection, P02_PARENT_SELECTION.DESCENDANT,
    'U4 parenting on its proven anchor rather than minting a second root');
  equal(parented.parent.revisionId, PUBLISHED.revisionId, 'U5 at the proven pair');

  /* The recovery is repeatable: running it twice changes nothing. */
  const again = classifyIntentRecovery(stuck);
  equal(again.disposition, freed.disposition, 'U6 and the recovery is idempotent');
}

const verdict = failures.length === 0
  ? 'P02_O1_DESCENDANT_PUBLICATION_PASS' : 'P02_O1_DESCENDANT_PUBLICATION_FAIL';
console.log(JSON.stringify({
  verdict, assertions, failures,
  parentSelection: {
    directionColumnRole: 'probe ORDER only; never proves ancestry',
    incompleteProbe: 'blocked(transport) + retry, never conflict',
    unreadableAnchor: 'blocked(transport), never ROOT',
    rootGate: 'no verified anchor AND no own advertised group; repository '
      + 'presence outranks local column absence'
  },
  onboarding: 'its own eligibility lane; the dirty predicate is NOT widened; '
    + 'intent recovery runs first; the pointer is re-read every pass',
  recovery: 'only VERIFIED pointer evidence or verified absence may disprove; '
    + 'a read error is never disproof',
  realRepositoryTouched: false, canonicalStateTouched: false, processesLaunched: 0
}, null, 2));
process.exit(failures.length === 0 ? 0 : 1);
