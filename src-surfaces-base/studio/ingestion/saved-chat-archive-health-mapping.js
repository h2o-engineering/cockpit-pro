/* H2O Studio — Saved Chat Archive Health mapping (M10 P2)
 *
 * PURE PRESENTATION LOGIC. It maps facts that other authorities already
 * established onto the six existing Saved-Chat operator states:
 *
 *   trusted h2o.savedChatArchiveIntegrity envelope (M10 P1)
 * + separate, existing non-integrity presentation facts (DB drift, renderer
 *   detail, and other warnings this layer does not own)
 * → presentation model
 *
 * What it deliberately does NOT do — every one of these already has an owner:
 *
 *   no hashing, no contentHash derivation, no manifest or snapshot parsing,
 *   no gzip handling, no schema admission, no package-validity decision,
 *   no filesystem read, no Tauri invoke, no mutation, no persistent state,
 *   no retention/reclaimability judgement, no repair/recovery/delete/quarantine
 *   action, and no FormatStale inference.
 *
 * No package bytes ever enter this module: validity is already decided by the
 * trusted class/reason it is handed, and blocker codes only explain WHY.
 *
 * NOT WIRED INTO PRODUCTION HEALTH. P2 ships this module unused; repointing the
 * operator surface is P3's decision, and retiring the current JS verifier is
 * P4's. Until then `diagnoseSavedChatArchiveV1` remains the Health authority.
 *
 * Public API (H2O.Studio.archiveHealthMapping):
 *   AGGREGATE_STATES
 *   mapArchiveHealth({ integrity, presentation }) -> presentation model
 *   selectAggregateState(counts) -> one of AGGREGATE_STATES
 *   explainBlockerCode(code) -> { code, text }
 *   partitionOccupants(occupants) -> { packageOccupants, strays, infrastructure }
 */
(function (global) {
  'use strict';

  var H2O = global.H2O = global.H2O || {};
  H2O.Studio = H2O.Studio || {};
  if (H2O.Studio.archiveHealthMapping && H2O.Studio.archiveHealthMapping.__installed) return;

  var MODULE_VERSION = '0.1.0-m10-p2';

  /* The SIX existing operator states. There is deliberately no seventh, and no
   * `unknown`: an unrecognised input must fail closed rather than borrow
   * healthy copy (the pre-P2 formatter's unknown-status fallback did exactly
   * that, pairing a neutral pill with the healthy headline). */
  var AGGREGATE_STATES = Object.freeze({
    PARTIAL_SCAN: 'partial-scan',
    EMPTY: 'empty',
    HEALTHY: 'healthy',
    HEALTHY_WITH_DRIFT: 'healthy-with-drift',
    MIXED: 'mixed',
    INTEGRITY_PROBLEMS: 'integrity-problems',
  });

  var ALL_STATES = Object.freeze([
    AGGREGATE_STATES.PARTIAL_SCAN,
    AGGREGATE_STATES.EMPTY,
    AGGREGATE_STATES.HEALTHY,
    AGGREGATE_STATES.HEALTHY_WITH_DRIFT,
    AGGREGATE_STATES.MIXED,
    AGGREGATE_STATES.INTEGRITY_PROBLEMS,
  ]);

  /* Trusted occupant classes, exactly as the P1 wire spells them. */
  var CLASS_VERIFIED = 'verified-generation';
  var CLASS_LEGACY = 'legacy-package';
  var CLASS_INDETERMINATE = 'indeterminate';
  var CLASS_RESERVED = 'reserved-infrastructure';

  /* Canonical IndeterminateReason, as the P1 wire spells it. */
  var REASON_NOT_A_PACKAGE = 'not-a-package-name';
  var REASON_IDENTITY_MISMATCH = 'identity-mismatch';

  var STATUS_OK = 'ok';
  var STATUS_WARNING = 'warning';
  var STATUS_BLOCKED = 'blocked';

  function contractError(message) {
    var error = new Error('[archive-health-mapping] ' + message);
    error.name = 'ArchiveHealthMappingContractError';
    return error;
  }

  function isObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
  }

  function asArray(value) {
    return Array.isArray(value) ? value : [];
  }

  function asString(value) {
    return typeof value === 'string' ? value : '';
  }

  function asCount(value) {
    return (typeof value === 'number' && isFinite(value) && value >= 0) ? value : 0;
  }

  /* ---------------------------------------------------------------------
   * Blocker humanization.
   *
   * Codes are NEVER renamed, reclassified or suppressed, and explaining one
   * never changes severity: the broad trusted `reason` already decided that.
   * Strategy is exact overrides for a few high-signal codes, then semantic
   * family prefixes, then a safe generic fallback that still shows the code.
   * ------------------------------------------------------------------- */

  var EXACT_BLOCKER_TEXT = Object.freeze({
    'generation-v3-gzip-decode-failed':
      'The compressed snapshot could not be decoded.',
    'generation-content-hash-mismatch':
      'The package contents do not match the identity recorded for it.',
    'generation-v3-persistent-renderer-forbidden':
      'The package stores a rendered copy that this format does not allow.',
  });

  /* Ordered MOST SPECIFIC FIRST, so a v3-scoped family is never swallowed by a
   * broader one that happens to share a prefix fragment. */
  var BLOCKER_FAMILIES = Object.freeze([
    ['generation-v3-gzip-', 'The compressed snapshot failed verification.'],
    ['generation-v3-snapshot-', 'The snapshot did not match what this format requires.'],
    ['generation-v3-manifest-', 'The package manifest did not match what this format requires.'],
    ['generation-v3-identity-', 'The stored snapshot did not match its recorded identity.'],
    ['generation-v3-content-hash-', 'The package identity could not be established.'],
    ['generation-manifest-', 'The package manifest failed verification.'],
    ['generation-snapshot-', 'The snapshot failed verification.'],
    ['generation-package-', 'The package structure failed verification.'],
    ['generation-asset-', 'A stored attachment failed verification.'],
    ['generation-member-', 'A file inside the package failed verification.'],
    ['generation-chat-id-', 'The package does not belong to the chat it is stored under.'],
  ]);

  var GENERIC_BLOCKER_TEXT = 'Trusted verification refused this package.';

  /* Pure: explain one canonical blocker code without ever hiding it. */
  function explainBlockerCode(code) {
    var value = asString(code);
    if (!value) throw contractError('a blocker must carry a code');
    if (Object.prototype.hasOwnProperty.call(EXACT_BLOCKER_TEXT, value)) {
      return { code: value, text: EXACT_BLOCKER_TEXT[value] };
    }
    for (var i = 0; i < BLOCKER_FAMILIES.length; i += 1) {
      if (value.indexOf(BLOCKER_FAMILIES[i][0]) === 0) {
        return { code: value, text: BLOCKER_FAMILIES[i][1] };
      }
    }
    /* An unrecognised future code stays fully visible and stays non-healthy;
     * the trusted reason, not this text, is what keeps it non-healthy. */
    return { code: value, text: GENERIC_BLOCKER_TEXT };
  }

  /* ---------------------------------------------------------------------
   * Occupant partition.
   * ------------------------------------------------------------------- */

  /* Pure: split trusted occupants into the three presentation populations.
   *
   * ReservedInfrastructure is HIDDEN — it is trusted infrastructure, never a
   * package, so it produces no row, no total, no warning and no integrity
   * problem. A NotAPackageName occupant is a stray: an archive-level drift
   * observation, but never a package row. */
  function partitionOccupants(occupants) {
    var packageOccupants = [];
    var strays = [];
    var infrastructure = [];

    asArray(occupants).forEach(function (occupant) {
      if (!isObject(occupant)) throw contractError('each occupant must be an object');
      var klass = asString(occupant.class);
      if (klass === CLASS_RESERVED) { infrastructure.push(occupant); return; }
      if (klass === CLASS_VERIFIED || klass === CLASS_LEGACY) { packageOccupants.push(occupant); return; }
      if (klass === CLASS_INDETERMINATE) {
        if (asString(occupant.reason) === REASON_NOT_A_PACKAGE) { strays.push(occupant); return; }
        packageOccupants.push(occupant);
        return;
      }
      throw contractError('unrecognised trusted occupant class: ' + (klass || '(missing)'));
    });

    return { packageOccupants: packageOccupants, strays: strays, infrastructure: infrastructure };
  }

  /* ---------------------------------------------------------------------
   * Compatibility shaping.
   * ------------------------------------------------------------------- */

  var NAME_CLASSIFICATION = Object.freeze({
    generation: 'generation',
    legacy: 'legacy',
    mismatch: 'mismatch',
    unclassified: 'unclassified',
  });

  function nameClassificationFor(occupant) {
    var klass = asString(occupant.class);
    if (klass === CLASS_VERIFIED) return NAME_CLASSIFICATION.generation;
    if (klass === CLASS_LEGACY) return NAME_CLASSIFICATION.legacy;
    if (asString(occupant.reason) === REASON_IDENTITY_MISMATCH) return NAME_CLASSIFICATION.mismatch;
    return NAME_CLASSIFICATION.unclassified;
  }

  /* Deprecated compatibility only. Deliberately NOT added back to the trusted
   * Rust wire, which carries the construction family instead. */
  var SCHEMA_VERSION_BY_FAMILY = Object.freeze({ v1: 1, v2: 2, v3: 3 });

  /* Factual family label only. `stale`, `old`, `needs migration`, `obsolete`
   * and `reclaimable` are judgements no current authority supplies, so this
   * layer never invents them. */
  function formatLabelFor(family) {
    var value = asString(family);
    if (!value) return '';
    return 'Format ' + value;
  }

  /* ---------------------------------------------------------------------
   * Aggregate precedence — the binding contract.
   * ------------------------------------------------------------------- */

  /* Pure and TOTAL over valid input: returns exactly one of the six states, or
   * throws. It can never fall through to healthy. */
  function selectAggregateState(input) {
    if (!isObject(input)) throw contractError('aggregate input must be an object');
    if (typeof input.complete !== 'boolean') {
      throw contractError('`complete` must be a boolean; an unknown scan state cannot be presented');
    }

    /* 1. Completeness FIRST, over everything. An incomplete enumeration can
     *    never be presented as absence, and trusted archive-level blockers are
     *    incomplete-scan evidence rather than a separate corruption state. */
    if (input.complete === false) return AGGREGATE_STATES.PARTIAL_SCAN;

    var total = asCount(input.packagesTotal);
    var blocked = asCount(input.packagesBlocked);
    var warning = asCount(input.packagesWarning);
    var archiveWarnings = asCount(input.archiveWarnings);

    if (blocked > total || warning > total) {
      throw contractError('package sub-counts cannot exceed packagesTotal');
    }

    /* 2. Empty wins over drift and strays, exactly as production does today. */
    if (total === 0) return AGGREGATE_STATES.EMPTY;

    /* 3/4. Integrity precedence. */
    if (blocked === total) return AGGREGATE_STATES.INTEGRITY_PROBLEMS;
    if (blocked > 0) return AGGREGATE_STATES.MIXED;

    /* 5. Warning-only mix. This preserves the existing behaviour — including
     *    the Mixed copy quirk, whose wording P2 deliberately does not fix. */
    if (warning > 0 && warning < total) return AGGREGATE_STATES.MIXED;

    /* 6. Drift across the board, or archive-level drift. `total > 0` is
     *    already guaranteed above, so 0 === 0 cannot force drift here. */
    if (warning === total || archiveWarnings > 0) return AGGREGATE_STATES.HEALTHY_WITH_DRIFT;

    /* 7. Nothing observed to report. */
    return AGGREGATE_STATES.HEALTHY;
  }

  /* ---------------------------------------------------------------------
   * The mapper.
   * ------------------------------------------------------------------- */

  function packageRowFor(occupant, warnings) {
    var klass = asString(occupant.class);
    var isPackage = klass === CLASS_VERIFIED || klass === CLASS_LEGACY;
    var blockerExplanations = asArray(occupant.blockers).map(function (blocker) {
      if (!isObject(blocker)) throw contractError('each blocker must be an object');
      return explainBlockerCode(blocker.code);
    });

    /* Status comes from the TRUSTED class, never from parsing or from reading
     * meaning into a blocker code. */
    var status;
    if (!isPackage) status = STATUS_BLOCKED;
    else if (warnings.length) status = STATUS_WARNING;
    else status = STATUS_OK;

    var family = asString(occupant.constructionFamily);
    return {
      packagePath: asString(occupant.path),
      chatId: asString(occupant.chatId) || null,
      snapshotId: asString(occupant.snapshotId) || null,
      contentHash: asString(occupant.contentHash) || null,
      savedAt: asString(occupant.savedAt) || null,
      constructionFamily: family || null,
      formatLabel: formatLabelFor(family),
      trustedClass: klass,
      trustedReason: asString(occupant.reason) || null,
      status: status,
      nameClassification: nameClassificationFor(occupant),
      schemaVersion: Object.prototype.hasOwnProperty.call(SCHEMA_VERSION_BY_FAMILY, family)
        ? SCHEMA_VERSION_BY_FAMILY[family]
        : null,
      blockerExplanations: blockerExplanations,
      warnings: warnings.slice(),
    };
  }

  /* Pure: trusted integrity facts + separate presentation facts -> model.
   *
   * `presentation` stays structurally separate from `integrity` so a drift fact
   * can never be mistaken for a trusted integrity classification. */
  function mapArchiveHealth(input) {
    if (!isObject(input)) throw contractError('mapArchiveHealth requires an input object');
    var integrity = input.integrity;
    if (!isObject(integrity)) throw contractError('a trusted integrity envelope is required');
    if (typeof integrity.complete !== 'boolean') {
      throw contractError('the trusted envelope must state `complete`');
    }
    var presentation = isObject(input.presentation) ? input.presentation : {};

    var partition = partitionOccupants(integrity.occupants);
    var warningsByPath = isObject(presentation.packageWarnings) ? presentation.packageWarnings : {};

    var rows = partition.packageOccupants.map(function (occupant) {
      var warnings = asArray(warningsByPath[asString(occupant.path)]).map(asString).filter(Boolean);
      return packageRowFor(occupant, warnings);
    });

    var packagesBlocked = rows.filter(function (row) { return row.status === STATUS_BLOCKED; }).length;
    var packagesWarning = rows.filter(function (row) { return row.status === STATUS_WARNING; }).length;
    var packagesOk = rows.filter(function (row) { return row.status === STATUS_OK; }).length;

    /* Archive-level drift: separate existing warnings, plus stray non-package
     * occupants. Hidden infrastructure contributes NOTHING here — that is the
     * authorized reduction in visible warnings versus the current JS path. */
    var archiveWarnings = asArray(presentation.archiveWarnings).map(asString).filter(Boolean);
    partition.strays.forEach(function (stray) {
      archiveWarnings.push('Unrecognised entry in the archive: ' + asString(stray.name));
    });

    var observedCounts = isObject(integrity.observed) ? integrity.observed : {};
    var families = isObject(observedCounts.byConstructionFamily) ? observedCounts.byConstructionFamily : {};

    var aggregateState = selectAggregateState({
      complete: integrity.complete,
      packagesTotal: rows.length,
      packagesBlocked: packagesBlocked,
      packagesWarning: packagesWarning,
      archiveWarnings: archiveWarnings.length,
    });

    /* Counts are OBSERVED facts. When the scan is incomplete the notice says so
     * explicitly, so no caller can read them as whole-archive totals. */
    var partialScanNotice = integrity.complete
      ? null
      : {
        complete: false,
        observedPackages: rows.length,
        text: 'Scan incomplete — ' + rows.length + ' packages observed.',
        blockers: asArray(integrity.blockers).map(asString).filter(Boolean),
      };

    return {
      aggregateState: aggregateState,
      complete: integrity.complete,
      observed: {
        packagesTotal: rows.length,
        packagesOk: packagesOk,
        packagesWarning: packagesWarning,
        packagesBlocked: packagesBlocked,
        v1: asCount(families.v1),
        v2: asCount(families.v2),
        v3: asCount(families.v3),
      },
      liveGenerationFamily: asString(integrity.liveGenerationFamily) || null,
      partialScanNotice: partialScanNotice,
      packageRows: rows,
      archiveWarnings: archiveWarnings,
      driftFacts: isObject(presentation.driftFacts) ? presentation.driftFacts : {},
    };
  }

  H2O.Studio.archiveHealthMapping = {
    __installed: true,
    MODULE_VERSION: MODULE_VERSION,
    AGGREGATE_STATES: AGGREGATE_STATES,
    ALL_STATES: ALL_STATES,
    mapArchiveHealth: mapArchiveHealth,
    selectAggregateState: selectAggregateState,
    explainBlockerCode: explainBlockerCode,
    partitionOccupants: partitionOccupants,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
