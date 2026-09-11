/*
 * O1-T16 — descendant parent selection, first-P02 onboarding, and recovery.
 *
 * Three decisions that all turn on the same discipline: only what the
 * REPOSITORY proves may shape a publication, and a temporary inability to read
 * the repository must never be promoted into a permanent verdict.
 *
 * PARENT SELECTION (A1 §9). A P02 revision may parent only on a
 * repository-verified id+blob pair. When the published and applied anchors are
 * both proven and distinct, one of them descends from the other and that one is
 * the parent - which requires an ancestry probe, and the probe is TRI-STATE.
 * Proven descent decides. Two complete chains that prove no descent are a real
 * fork and refuse publication. Anything incomplete - a missing blob, an
 * unreadable folder, a partial sync - is blocked(transport) and retried.
 *
 * The failure this exists to prevent is subtle and destructive: treating an
 * incomplete probe as "no descent found" would turn a folder that is still
 * syncing into a permanent conflict, and treating an unreadable anchor as "no
 * anchor" would mint a SECOND root for an object that already has one. Both
 * convert a transient condition into durable damage, so both are refused.
 *
 * `last_converged_direction` orders the probe and nothing else. It says which
 * anchor is LIKELY newer, so probing that one first usually succeeds on the
 * first attempt. It is a hint recorded by our own writer, not repository proof,
 * and it never decides ancestry.
 *
 * ROOT is gated on the REPOSITORY, not on local columns. An object may publish
 * a v2 root only when no verified P02 anchor exists AND the writer's own heads
 * snapshot advertises no group for it. Column state alone is not enough: a P01
 * rollback can clobber a convergence row while the repository still holds the
 * subtree, and minting a root then would fork the object against itself.
 * Repository presence outranks local absence.
 *
 * ONBOARDING is its own lane. A P01-converged object is not "dirty" - its
 * content matches what P01 published - so widening the dirty predicate to
 * catch it would also catch things that must not publish. It gets a presence
 * predicate instead: the writer's own heads snapshot has no group for it.
 *
 * RECOVERY only accepts VERIFIED evidence as disproof. A read error is not
 * absence, and absence is only disproof when the pointer itself was verified.
 */

export const P02_DESCENDANT_V2 = Object.freeze({
  SCHEMA: 'h2o.studio.syncP02DescendantSelection.v1',
  DIRECTION: Object.freeze({ PUBLISHED: 'published', APPLIED: 'applied' })
});

export const P02_PARENT_SELECTION = Object.freeze({
  /* Publish as a v2 ROOT. Only when the repository agrees there is nothing. */
  ROOT: 'root',
  /* Parent on the named verified pair. */
  DESCENDANT: 'descendant',
  /* Two proven anchors, neither descending from the other. A real fork. */
  CONFLICT: 'conflict',
  /* The repository could not answer yet. Retry; decide nothing. */
  BLOCKED_TRANSPORT: 'blocked(transport)',
  /* The repository answered with a contradiction. */
  INTEGRITY: 'integrity'
});

export const P02_ONBOARDING = Object.freeze({
  ELIGIBLE: 'onboarding-eligible',
  ALREADY_ADVERTISED: 'already-advertised',
  PENDING: 'pending-operation',
  BLOCKED: 'blocked',
  INTEGRITY_QUARANTINED: 'integrity-quarantined',
  POINTER_UNREADABLE: 'pointer-unreadable',
  SNAPSHOT_MISSING: 'snapshot-missing'
});

export const P02_RECOVERY_DISPOSITION = Object.freeze({
  /* The repository proves the intended revision exists: adopt and complete. */
  ADOPT_AND_COMPLETE: 'adopt-and-complete',
  /* Verified evidence disproves it: abandon and re-plan with a fresh mint. */
  ABANDON_AND_REPLAN: 'abandon-and-replan',
  /* A pending row with no intent to recover: abandonable, nothing to adopt. */
  ABANDON_EMPTY_INTENT: 'abandon-empty-intent',
  /* We could not read. NOT disproof. */
  ABORT_UNREADABLE: 'abort-unreadable'
});

const HEX64 = /^[0-9a-f]{64}$/;
const hex64 = (value) => typeof value === 'string' && HEX64.test(value);
const clean = (value) => (typeof value === 'string' ? value.trim() : '');
const isPlainObject = (value) =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const samePair = (left, right) =>
  clean(left?.revisionId) === clean(right?.revisionId) &&
  clean(left?.revisionBlobSha256) === clean(right?.revisionBlobSha256);

function validPair(pair) {
  return isPlainObject(pair) && clean(pair.revisionId).length > 0 &&
    hex64(clean(pair.revisionBlobSha256));
}

/*
 * A pair is usable only if the repository VERIFIED it. `proveAnchor` returns a
 * tri-state so an unreadable anchor stays distinct from an absent one - the
 * difference between "retry" and "there is nothing here".
 */
async function proveBoth({ published, applied, proveAnchor }) {
  const prove = async (pair, origin) => {
    if (!validPair(pair)) return { origin, state: 'absent', pair: null };
    let proof;
    try {
      proof = await proveAnchor(pair);
    } catch (_) {
      return { origin, state: 'unreadable', pair };
    }
    const state = clean(proof?.status);
    if (state === 'verified') return { origin, state: 'verified', pair };
    if (state === 'absent') return { origin, state: 'absent-verified', pair };
    if (state === 'identity-conflict') return { origin, state: 'integrity', pair };
    return { origin, state: 'unreadable', pair };
  };
  return {
    published: await prove(published, P02_DESCENDANT_V2.DIRECTION.PUBLISHED),
    applied: await prove(applied, P02_DESCENDANT_V2.DIRECTION.APPLIED)
  };
}

export async function selectPublicationParent({
  protocolState = {},
  convergedDirection = null,
  /* (pair) -> {status:'verified'|'absent'|'identity-conflict'} or throws. */
  proveAnchor,
  /* (from, seed) -> {outcome:'proven-chain'|'retained-unproven-parent'|'quarantined',
   *                  descendsFromSeed: boolean} */
  probeDescent,
  /* The writer's OWN heads snapshot group for this object, from a verified
   * read. `null` means the pointer said nothing; undefined means unread. */
  ownHeadsGroup = undefined,
  ownPointerStatus = null
} = {}) {
  if (typeof proveAnchor !== 'function' || typeof probeDescent !== 'function') {
    throw new TypeError('p02-descendant-dependency-invalid');
  }
  const proofs = await proveBoth({
    published: protocolState.lastPublished,
    applied: protocolState.lastApplied,
    proveAnchor
  });

  if (proofs.published.state === 'integrity' || proofs.applied.state === 'integrity') {
    return Object.freeze({
      schema: P02_DESCENDANT_V2.SCHEMA,
      selection: P02_PARENT_SELECTION.INTEGRITY,
      reason: 'anchor-identity-conflict', parent: null
    });
  }
  /* An anchor we could not read is not an absent anchor. Deciding anything on
   * it - especially ROOT - would let a transient read failure fork the object. */
  if (proofs.published.state === 'unreadable' || proofs.applied.state === 'unreadable') {
    return Object.freeze({
      schema: P02_DESCENDANT_V2.SCHEMA,
      selection: P02_PARENT_SELECTION.BLOCKED_TRANSPORT,
      reason: 'anchor-proof-unreadable', parent: null, retry: true
    });
  }

  const provenPublished = proofs.published.state === 'verified';
  const provenApplied = proofs.applied.state === 'verified';

  /* (i) only published proven. (ii) only applied proven. */
  if (provenPublished && !provenApplied) {
    return Object.freeze({
      schema: P02_DESCENDANT_V2.SCHEMA,
      selection: P02_PARENT_SELECTION.DESCENDANT,
      parent: proofs.published.pair,
      parentOrigin: P02_DESCENDANT_V2.DIRECTION.PUBLISHED, reason: null
    });
  }
  if (provenApplied && !provenPublished) {
    return Object.freeze({
      schema: P02_DESCENDANT_V2.SCHEMA,
      selection: P02_PARENT_SELECTION.DESCENDANT,
      parent: proofs.applied.pair,
      parentOrigin: P02_DESCENDANT_V2.DIRECTION.APPLIED, reason: null
    });
  }

  if (provenPublished && provenApplied) {
    /* The same pair under both origins is not a fork. */
    if (samePair(proofs.published.pair, proofs.applied.pair)) {
      return Object.freeze({
        schema: P02_DESCENDANT_V2.SCHEMA,
        selection: P02_PARENT_SELECTION.DESCENDANT,
        parent: proofs.published.pair,
        parentOrigin: P02_DESCENDANT_V2.DIRECTION.PUBLISHED, reason: null
      });
    }
    /*
     * Both proven and distinct. The direction column says which is LIKELY the
     * descendant, so probe that one first and usually stop after one probe.
     * It orders the work; it never decides the answer.
     */
    const direction = clean(convergedDirection);
    const order = direction === P02_DESCENDANT_V2.DIRECTION.APPLIED
      ? [proofs.applied, proofs.published]
      : [proofs.published, proofs.applied];

    let sawIncomplete = false;
    for (const [candidate, seed] of [[order[0], order[1]], [order[1], order[0]]]) {
      let probe;
      try {
        probe = await probeDescent(candidate.pair, seed.pair);
      } catch (_) {
        sawIncomplete = true;
        continue;
      }
      const outcome = clean(probe?.outcome);
      if (outcome === 'proven-chain' && probe?.descendsFromSeed === true) {
        return Object.freeze({
          schema: P02_DESCENDANT_V2.SCHEMA,
          selection: P02_PARENT_SELECTION.DESCENDANT,
          parent: candidate.pair,
          parentOrigin: candidate.origin,
          probeOrderHint: direction || null,
          reason: null
        });
      }
      /*
       * Incomplete evidence is NOT "no descent". A partial folder sync heals
       * itself; a conflict verdict does not.
       */
      if (outcome !== 'proven-chain') sawIncomplete = true;
    }
    if (sawIncomplete) {
      return Object.freeze({
        schema: P02_DESCENDANT_V2.SCHEMA,
        selection: P02_PARENT_SELECTION.BLOCKED_TRANSPORT,
        reason: 'descent-probe-incomplete', parent: null, retry: true
      });
    }
    /* Two COMPLETE chains, neither descending from the other. A real fork. */
    return Object.freeze({
      schema: P02_DESCENDANT_V2.SCHEMA,
      selection: P02_PARENT_SELECTION.CONFLICT,
      reason: 'published-and-applied-diverged', parent: null
    });
  }

  /*
   * (iii) Neither proven. ROOT is permitted only if the REPOSITORY also says
   * this object has never been advertised by us. A P01 rollback can clobber a
   * convergence column while the subtree still exists, and minting a root then
   * would fork the object against its own history.
   */
  if (ownHeadsGroup === undefined) {
    return Object.freeze({
      schema: P02_DESCENDANT_V2.SCHEMA,
      selection: P02_PARENT_SELECTION.BLOCKED_TRANSPORT,
      reason: 'own-heads-group-unread', parent: null, retry: true
    });
  }
  if (clean(ownPointerStatus) && clean(ownPointerStatus) !== 'verified' &&
      clean(ownPointerStatus) !== 'absent') {
    return Object.freeze({
      schema: P02_DESCENDANT_V2.SCHEMA,
      selection: P02_PARENT_SELECTION.BLOCKED_TRANSPORT,
      reason: 'own-pointer-unproven', parent: null, retry: true
    });
  }
  if (ownHeadsGroup !== null) {
    /*
     * The repository advertises a group we hold no anchor for. Our columns and
     * the repository disagree about our own history, which is an integrity
     * statement, not a licence to start over.
     */
    return Object.freeze({
      schema: P02_DESCENDANT_V2.SCHEMA,
      selection: P02_PARENT_SELECTION.INTEGRITY,
      reason: 'own-heads-group-present-without-anchor', parent: null
    });
  }
  return Object.freeze({
    schema: P02_DESCENDANT_V2.SCHEMA,
    selection: P02_PARENT_SELECTION.ROOT, parent: null, reason: 'p02-cutover-root'
  });
}

/*
 * First-P02 onboarding eligibility.
 *
 * Deliberately NOT a widening of the dirty predicate: a P01-converged object's
 * content already matches what P01 published, so it is not dirty, and making
 * the dirty rule catch it would also catch objects that must not publish.
 *
 * Ordering matters. Intent recovery runs FIRST, because an object with a
 * retained publish intent is not an onboarding candidate - it is a publication
 * already in flight, and onboarding it would mint a competing revision.
 */
export function evaluateOnboardingEligibility({
  ownPointer = {},
  ownHeadsGroup = undefined,
  pending = false,
  blockReason = null,
  integrityQuarantined = false,
  intentRecoveryComplete = false
} = {}) {
  const disqualify = (state, reason) => Object.freeze({
    schema: P02_DESCENDANT_V2.SCHEMA, eligible: false, state, reason
  });

  if (intentRecoveryComplete !== true) {
    return disqualify(P02_ONBOARDING.PENDING, 'intent-recovery-must-run-first');
  }
  /* The pointer is re-read every pass: a memoized pointer could name a
   * snapshot that has since moved, and onboarding turns on its content. */
  const status = clean(ownPointer?.status);
  if (status === 'unreadable' || status === 'quarantined' || status === '') {
    return disqualify(P02_ONBOARDING.POINTER_UNREADABLE, status || 'pointer-unread');
  }
  if (status === 'verified' && ownHeadsGroup === undefined) {
    /* Verified pointer, but the snapshot it names could not be read. The
     * pointer promised something the repository did not deliver. */
    return disqualify(P02_ONBOARDING.SNAPSHOT_MISSING, 'pointer-verified-snapshot-missing');
  }
  if (integrityQuarantined === true) {
    return disqualify(P02_ONBOARDING.INTEGRITY_QUARANTINED, 'integrity-quarantined');
  }
  if (pending === true) return disqualify(P02_ONBOARDING.PENDING, 'pending-operation');
  if (clean(blockReason)) return disqualify(P02_ONBOARDING.BLOCKED, clean(blockReason));
  if (ownHeadsGroup !== null && ownHeadsGroup !== undefined) {
    return disqualify(P02_ONBOARDING.ALREADY_ADVERTISED, 'own-heads-group-present');
  }
  return Object.freeze({
    schema: P02_DESCENDANT_V2.SCHEMA,
    eligible: true, state: P02_ONBOARDING.ELIGIBLE, reason: null
  });
}

/*
 * Publish-intent recovery.
 *
 * The asymmetry is the whole contract: only VERIFIED evidence may disprove an
 * intent. A read error looks exactly like absence to a naive caller, and
 * treating it as absence would abandon an intent whose revision is sitting in
 * the repository - stranding a mint that another peer can already see.
 */
export function classifyIntentRecovery({
  pendingOperation = null,
  intendedRevisionId = null,
  intendedRevisionBlobSha256 = null,
  adoptIntent = null,
  pointerProof = {}
} = {}) {
  const decide = (disposition, reason, extra = {}) => Object.freeze({
    schema: P02_DESCENDANT_V2.SCHEMA, disposition, reason, ...extra
  });

  /*
   * adoptIntent.resumed === false means the acquisition created a FRESH empty
   * row rather than resuming ours. There is nothing to recover, and the row and
   * its in-memory slot must both be released or the object is pinned forever.
   */
  if (isPlainObject(adoptIntent) && adoptIntent.resumed === false) {
    return decide(P02_RECOVERY_DISPOSITION.ABANDON_EMPTY_INTENT,
      'acquisition-did-not-resume',
      { abandonFreshRow: true, releaseMemorySlot: true, retain: false });
  }
  /* A pending publish row carrying no intent cannot be adopted: there is no
   * revision to look for. Abandonable, and not an error. */
  if (clean(pendingOperation) === 'publish' &&
      (!clean(intendedRevisionId) || !hex64(clean(intendedRevisionBlobSha256)))) {
    return decide(P02_RECOVERY_DISPOSITION.ABANDON_EMPTY_INTENT,
      'pending-publish-with-empty-intent',
      { abandonFreshRow: true, releaseMemorySlot: true, retain: false });
  }

  const status = clean(pointerProof?.status);
  /* A read error is NOT disproof. Abort and try again; change nothing. */
  if (status !== 'verified' && status !== 'absent-verified') {
    return decide(P02_RECOVERY_DISPOSITION.ABORT_UNREADABLE,
      status ? `pointer-${status}` : 'pointer-unread',
      { retain: true, disproved: false });
  }

  if (status === 'absent-verified') {
    /* Verified ABSENCE really is disproof: the pointer was read and names
     * nothing, so the intended revision was never referenced. */
    return decide(P02_RECOVERY_DISPOSITION.ABANDON_AND_REPLAN,
      'pointer-verified-absent',
      { retain: false, disproved: true, freshMintRequired: true });
  }

  const named = clean(pointerProof?.namesRevisionId);
  if (named === clean(intendedRevisionId) &&
      clean(pointerProof?.namesRevisionBlobSha256) === clean(intendedRevisionBlobSha256)) {
    return decide(P02_RECOVERY_DISPOSITION.ADOPT_AND_COMPLETE,
      'repository-proves-intended-revision',
      { retain: true, republished: false });
  }
  /*
   * The pointer verified and does NOT name our intended revision. That is
   * proof the publication did not land, so the mint is dead and unreferenced:
   * abandon without retaining, and re-plan with a fresh mint that cannot
   * collide with the abandoned one.
   */
  return decide(P02_RECOVERY_DISPOSITION.ABANDON_AND_REPLAN,
    'verified-pointer-does-not-name-intent',
    { retain: false, disproved: true, freshMintRequired: true });
}
