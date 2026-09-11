/*
 * O1-T09 — N.3 legacy baseline observer.
 *
 * When P02 was activated, the ceremony recorded what the two protected P01
 * compatibility artifacts looked like at that moment, and embedded that receipt
 * in library.info. This module re-observes them and answers one question for
 * the Y-10 gate: are they still what the receipt says they were?
 *
 * It is an OBSERVER. It reads and hashes; it never writes, never repairs,
 * never restores, and never creates a P01 artifact. If an artifact changed,
 * that is a fact about the repository which the gate turns into a quarantine
 * and an integrity event - deciding what to do about it is an operator's
 * business, and silently putting the old bytes back would destroy the evidence
 * that something else is writing to this repository.
 *
 * FAIL CLOSED, WITH ATTRIBUTION. The gate accepts a single boolean, so every
 * non-match collapses to false there. That is correct - a repository whose
 * compatibility artifacts cannot be confirmed must not be treated as activated
 * - but "changed" and "could not be read" are different facts, and flattening
 * them at the observation layer too would leave an operator debugging a
 * permissions problem as though it were tampering. So the observation is
 * typed and the boolean is derived from it, never the other way round.
 *
 * ABSENCE IS AN OBSERVATION, NOT A FAILURE. The receipt can legitimately record
 * an artifact as absent, and an absent artifact that is still absent MATCHES.
 * What does not match is an artifact appearing where the receipt proved there
 * was none: something created it after activation, which is exactly the class
 * of event N.3 exists to notice.
 */

export const P02_LEGACY_OBSERVER_V2 = Object.freeze({
  SCHEMA: 'h2o.studio.syncP02LegacyBaselineObservation.v1',
  RECEIPT_SCHEMA: 'h2o.studio.syncLegacyBaseline.p02.v1'
});

export const P02_LEGACY_OBSERVATION = Object.freeze({
  /* Every protected artifact is exactly as the receipt recorded it. */
  MATCH: 'match',
  /* At least one artifact differs from what was recorded. */
  MISMATCH: 'mismatch',
  /* The receipt itself cannot be trusted, so nothing can be compared. */
  RECEIPT_MALFORMED: 'receipt-malformed',
  /* An artifact could not be read. Says nothing about whether it changed. */
  UNREADABLE: 'unreadable'
});

export const P02_LEGACY_ARTIFACT_FINDING = Object.freeze({
  PRESENT_MATCHING: 'present-matching',
  PRESENT_CHANGED: 'present-changed',
  EXPECTED_PRESENT_NOW_MISSING: 'expected-present-now-missing',
  ABSENT_AS_EXPECTED: 'absent-as-expected',
  EXPECTED_ABSENT_NOW_PRESENT: 'expected-absent-now-present',
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

/*
 * A receipt is only usable if every entry is internally coherent. A `present`
 * entry with no hash cannot be compared against anything, and an `absent` entry
 * carrying a hash is self-contradictory - both mean the receipt cannot be used
 * to decide, which is a malformed receipt rather than a mismatch.
 */
function parseReceipt(receipt) {
  if (!isPlainObject(receipt) ||
      receipt.schema !== P02_LEGACY_OBSERVER_V2.RECEIPT_SCHEMA ||
      !Array.isArray(receipt.artifacts) ||
      receipt.artifacts.length === 0) {
    return { ok: false, reason: 'receipt-shape-invalid' };
  }
  const expected = new Map();
  for (const entry of receipt.artifacts) {
    if (!isPlainObject(entry)) return { ok: false, reason: 'artifact-entry-invalid' };
    const path = clean(entry.path);
    if (!path) return { ok: false, reason: 'artifact-path-invalid' };
    if (expected.has(path)) return { ok: false, reason: 'artifact-path-duplicated' };
    const present = entry.present;
    if (present !== true && present !== false) {
      return { ok: false, reason: 'artifact-presence-invalid' };
    }
    const sha256 = entry.sha256 == null ? null : clean(entry.sha256);
    if (present === true && !hex64(sha256)) {
      return { ok: false, reason: 'artifact-present-without-hash' };
    }
    if (present === false && sha256 !== null) {
      return { ok: false, reason: 'artifact-absent-with-hash' };
    }
    expected.set(path, { path, present, sha256 });
  }
  return { ok: true, expected };
}

export function createP02LegacyBaselineObserver({
  readArtifactBytes,
  sha256HexBytes
} = {}) {
  requireFunction(readArtifactBytes, 'p02-legacy-observer-reader-invalid');
  requireFunction(sha256HexBytes, 'p02-legacy-observer-hash-invalid');

  /*
   * Returns a typed observation. The gate boolean is derived from it by
   * `legacyBaselineMatches` below, so a caller cannot accidentally consume the
   * boolean without the reason that produced it.
   */
  async function observe({ legacyBaselineReceipt } = {}) {
    const parsed = parseReceipt(legacyBaselineReceipt);
    if (!parsed.ok) {
      return Object.freeze({
        schema: P02_LEGACY_OBSERVER_V2.SCHEMA,
        observation: P02_LEGACY_OBSERVATION.RECEIPT_MALFORMED,
        matches: false,
        reason: parsed.reason,
        artifacts: Object.freeze([]),
        repaired: false, artifactsWritten: 0
      });
    }

    const findings = [];
    let unreadable = false;
    let mismatch = false;

    for (const [path, entry] of [...parsed.expected].sort(([a], [b]) => a.localeCompare(b))) {
      let bytes;
      try {
        bytes = await readArtifactBytes(path);
      } catch (error) {
        unreadable = true;
        findings.push(Object.freeze({
          path,
          finding: P02_LEGACY_ARTIFACT_FINDING.UNREADABLE,
          expectedPresent: entry.present,
          observedSha256: null,
          reason: clean(error?.code) || 'artifact-read-failed'
        }));
        continue;
      }

      if (bytes === null || bytes === undefined) {
        /* Proven absent - distinct from "the read failed". */
        const finding = entry.present
          ? P02_LEGACY_ARTIFACT_FINDING.EXPECTED_PRESENT_NOW_MISSING
          : P02_LEGACY_ARTIFACT_FINDING.ABSENT_AS_EXPECTED;
        if (entry.present) mismatch = true;
        findings.push(Object.freeze({
          path, finding, expectedPresent: entry.present, observedSha256: null, reason: null
        }));
        continue;
      }

      let observedSha256;
      try {
        observedSha256 = clean(await sha256HexBytes(bytes));
      } catch (error) {
        unreadable = true;
        findings.push(Object.freeze({
          path,
          finding: P02_LEGACY_ARTIFACT_FINDING.UNREADABLE,
          expectedPresent: entry.present,
          observedSha256: null,
          reason: clean(error?.code) || 'artifact-hash-failed'
        }));
        continue;
      }
      if (!hex64(observedSha256)) {
        unreadable = true;
        findings.push(Object.freeze({
          path,
          finding: P02_LEGACY_ARTIFACT_FINDING.UNREADABLE,
          expectedPresent: entry.present,
          observedSha256: null,
          reason: 'artifact-hash-invalid'
        }));
        continue;
      }

      if (!entry.present) {
        /* The receipt proved this absent, and now something is there. */
        mismatch = true;
        findings.push(Object.freeze({
          path,
          finding: P02_LEGACY_ARTIFACT_FINDING.EXPECTED_ABSENT_NOW_PRESENT,
          expectedPresent: false, observedSha256, reason: null
        }));
        continue;
      }
      const matching = observedSha256 === entry.sha256;
      if (!matching) mismatch = true;
      findings.push(Object.freeze({
        path,
        finding: matching
          ? P02_LEGACY_ARTIFACT_FINDING.PRESENT_MATCHING
          : P02_LEGACY_ARTIFACT_FINDING.PRESENT_CHANGED,
        expectedPresent: true,
        expectedSha256: entry.sha256,
        observedSha256,
        reason: null
      }));
    }

    /*
     * A real mismatch outranks an unreadable one: if we can already prove
     * something changed, that is the more specific and more actionable fact,
     * and reporting "unreadable" would understate what we know.
     */
    const observation = mismatch
      ? P02_LEGACY_OBSERVATION.MISMATCH
      : unreadable
        ? P02_LEGACY_OBSERVATION.UNREADABLE
        : P02_LEGACY_OBSERVATION.MATCH;

    return Object.freeze({
      schema: P02_LEGACY_OBSERVER_V2.SCHEMA,
      observation,
      matches: observation === P02_LEGACY_OBSERVATION.MATCH,
      reason: observation === P02_LEGACY_OBSERVATION.MATCH ? null : observation,
      artifacts: Object.freeze(findings),
      /* Stated in the result so no consumer can read this as an action. */
      repaired: false,
      artifactsWritten: 0
    });
  }

  /*
   * The production gate input. Only a full MATCH is true; everything else -
   * changed, missing, appeared, malformed receipt, unreadable - is false, so
   * the gate quarantines rather than assuming.
   */
  async function legacyBaselineMatches({ legacyBaselineReceipt } = {}) {
    const result = await observe({ legacyBaselineReceipt });
    return result.matches === true;
  }

  return Object.freeze({
    schema: P02_LEGACY_OBSERVER_V2.SCHEMA,
    observe,
    legacyBaselineMatches
  });
}

/*
 * Convenience for the real call shape: library.info carries the receipt
 * embedded, so a caller with a library.info should not have to remember which
 * key it lives under.
 */
export function legacyBaselineReceiptOf(libraryInfo) {
  return isPlainObject(libraryInfo) ? libraryInfo.legacyBaselineReceipt ?? null : null;
}
