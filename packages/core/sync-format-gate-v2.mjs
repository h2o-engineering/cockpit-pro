/*
 * P02 repository format gate (Wave 1 / Z7) implementing frozen Y-10 and the
 * N.3 behaviour table.
 *
 * READ-ONLY in all normal operation. This module decides whether P02 may
 * read, and whether P02 may write. It answers "may write" with false for
 * every state except an explicitly activated, supported repository - and the
 * activation write path itself lives only inside the governed V7/V8 ceremony,
 * which is NOT part of Wave 1.
 *
 * N.4 honesty: this gate protects P02 readers and writers. It cannot and does
 * not claim to disable a pre-gate binary that never reads it; quiescing old
 * writers is an operational prerequisite (§O.1), not something metadata does.
 */

export const P02_FORMAT_GATE_V2 = Object.freeze({
  SCHEMA: 'h2o.studio.syncLibraryInfo.p02.v1',
  AUTHORITY_FILE: 'library.info.json',
  PROTOCOL_VERSION: 2,
  MINIMUM_COMPATIBLE_PROTOCOL_VERSION: 2
});

/* Frozen N.3 conditions, named so callers never invent their own. */
export const P02_GATE_STATE = Object.freeze({
  ABSENT_EMPTY: 'absent-empty-repository',
  ABSENT_WITH_CONTENT: 'absent-with-legacy-or-unknown-content',
  SUPPORTED: 'supported',
  UNSUPPORTED_FORMAT: 'unsupported-format',
  MALFORMED: 'malformed',
  PROTOCOL_TOO_NEW: 'reader-protocol-too-old',
  LEGACY_ARTIFACT_CHANGED: 'legacy-artifact-changed'
});

/* What P02 is permitted to do in each state. */
const CAPABILITY = Object.freeze({
  [P02_GATE_STATE.ABSENT_EMPTY]:
    { mayRead: true, mayWrite: false, initializationEligible: true, classification: null },
  [P02_GATE_STATE.ABSENT_WITH_CONTENT]:
    { mayRead: true, mayWrite: false, initializationEligible: false, classification: null },
  [P02_GATE_STATE.SUPPORTED]:
    { mayRead: true, mayWrite: true, initializationEligible: false, classification: null },
  [P02_GATE_STATE.UNSUPPORTED_FORMAT]:
    { mayRead: false, mayWrite: false, initializationEligible: false, classification: 'unsupported-format' },
  [P02_GATE_STATE.MALFORMED]:
    { mayRead: false, mayWrite: false, initializationEligible: false, classification: 'unsupported-format' },
  [P02_GATE_STATE.PROTOCOL_TOO_NEW]:
    { mayRead: true, mayWrite: false, initializationEligible: false, classification: 'unsupported-format' },
  [P02_GATE_STATE.LEGACY_ARTIFACT_CHANGED]:
    { mayRead: true, mayWrite: false, initializationEligible: false, classification: 'integrity-quarantined' }
});

function isPlainObject(value) {
  return value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.prototype.toString.call(value) === '[object Object]';
}

function freezeDeep(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Object.isFrozen(value)) return value;
  if (Array.isArray(value)) return Object.freeze(value.map(freezeDeep));
  if (isPlainObject(value)) {
    for (const key of Object.keys(value)) value[key] = freezeDeep(value[key]);
    return Object.freeze(value);
  }
  return value;
}

function decide(state, detail = {}) {
  const capability = CAPABILITY[state];
  return freezeDeep({
    schema: P02_FORMAT_GATE_V2.SCHEMA,
    state,
    ...capability,
    ...detail
  });
}

/*
 * Strict parse of the repository authority document. Unknown keys and wrong
 * types are malformed, not "repairable" - forward compatibility is the gate's
 * job, never lenient parsing (E.3).
 */
export function parseLibraryInfo(raw) {
  if (raw === null || raw === undefined) return { ok: false, reason: 'absent' };
  if (!isPlainObject(raw)) return { ok: false, reason: 'not-an-object' };
  const allowed = new Set([
    'schema', 'formatVersion', 'minimumCompatibleProtocolVersion', 'layoutEpoch',
    'activatedAt', 'activatedByWriterSyncPeerId', 'legacyBaselineReceipt'
  ]);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) return { ok: false, reason: `unknown-key:${key}` };
  }
  for (const key of ['schema', 'formatVersion', 'minimumCompatibleProtocolVersion', 'layoutEpoch']) {
    if (!(key in raw)) return { ok: false, reason: `missing-key:${key}` };
  }
  if (typeof raw.schema !== 'string' ||
      !Number.isInteger(raw.formatVersion) ||
      !Number.isInteger(raw.minimumCompatibleProtocolVersion) ||
      !Number.isInteger(raw.layoutEpoch)) {
    return { ok: false, reason: 'field-type-invalid' };
  }
  return { ok: true, value: raw };
}

/*
 * Y-10 reader. Pure over the observed repository facts; performs no I/O and
 * writes nothing anywhere, in any state.
 */
export function evaluateFormatGate({
  libraryInfo = null,
  repositoryHasContent = false,
  readerProtocolVersion = P02_FORMAT_GATE_V2.PROTOCOL_VERSION,
  legacyBaselineMatches = true
} = {}) {
  const parsed = parseLibraryInfo(libraryInfo);

  if (!parsed.ok && parsed.reason === 'absent') {
    /* Missing authority is never deletion (N.3 final row). */
    return repositoryHasContent
      ? decide(P02_GATE_STATE.ABSENT_WITH_CONTENT, { reason: 'legacy-or-unknown-content-present' })
      : decide(P02_GATE_STATE.ABSENT_EMPTY, { reason: 'empty-repository' });
  }
  if (!parsed.ok) {
    return decide(P02_GATE_STATE.MALFORMED, { reason: parsed.reason });
  }

  const info = parsed.value;
  if (info.schema !== P02_FORMAT_GATE_V2.SCHEMA) {
    return decide(P02_GATE_STATE.UNSUPPORTED_FORMAT, { reason: 'schema-unsupported' });
  }
  if (readerProtocolVersion < info.minimumCompatibleProtocolVersion) {
    return decide(P02_GATE_STATE.PROTOCOL_TOO_NEW, {
      reason: 'reader-below-minimum-compatible-protocol',
      minimumCompatibleProtocolVersion: info.minimumCompatibleProtocolVersion
    });
  }
  if (info.formatVersion > P02_FORMAT_GATE_V2.PROTOCOL_VERSION) {
    return decide(P02_GATE_STATE.UNSUPPORTED_FORMAT, { reason: 'format-version-ahead-of-reader' });
  }
  if (legacyBaselineMatches !== true) {
    /* N.3: a changed legacy artifact quarantines and raises an integrity event. */
    return decide(P02_GATE_STATE.LEGACY_ARTIFACT_CHANGED, {
      reason: 'legacy-writer-artifact-changed-after-activation',
      integrityEvent: 'legacy-writer-integrity'
    });
  }
  return decide(P02_GATE_STATE.SUPPORTED, {
    reason: 'activated',
    layoutEpoch: info.layoutEpoch
  });
}

/*
 * Activation ceremony hook. Wave 1 deliberately supplies NO writer: the hook
 * exists so the governed V7/V8 campaign has a single, auditable place to
 * attach one. Calling it without an explicitly authorized writer refuses.
 */
export function createActivationCeremonyHook({
  authorizedWriter = null,
  authorization = null
} = {}) {
  return Object.freeze({
    /* True only inside a governed campaign that supplied both. */
    isArmed() {
      return typeof authorizedWriter === 'function' &&
        authorization?.governedCampaign === true;
    },
    async activate(request) {
      if (typeof authorizedWriter !== 'function' ||
          authorization?.governedCampaign !== true) {
        throw new Error('p02-format-gate-activation-not-authorized');
      }
      return authorizedWriter(request);
    }
  });
}
