/* Saved-Chat archive presentation adapter (M05 Phase 4).
 *
 * ONE place where the governed archive authorities are turned into the labels
 * operator surfaces show. Archive Health, the Inspector, the action card and
 * the export/import/restore/relink flows would otherwise each invent the same
 * mapping — and each get a chance to invent it slightly differently, which is
 * exactly how "latest wins" or "newest file is current" creeps back in.
 *
 * It is PURE PRESENTATION. It never:
 *   - recomputes a contentHash (the governed verifier owns that);
 *   - re-parses a generation basename (§D classification owns that);
 *   - consults a filesystem mtime, manifest.generatedAt or queue timestamp;
 *   - keeps a persistent index or any state at all;
 *   - decides what to publish, restore, relink or export.
 *
 * The single freshness rule it presents is the frozen one: a VALID package
 * whose RECOMPUTED contentHash equals the current authoritative projection.
 * Everything else is history.
 *
 * Contracts: docs/systems/archive/saved-chat-generations.md §D §E §F §G
 */
(function (global) {
  'use strict';

  var H2O = global.H2O = global.H2O || {};
  H2O.Studio = H2O.Studio || {};
  H2O.Studio.ingestion = H2O.Studio.ingestion || {};

  var MODULE_VERSION = '1.0.0-m05-p4';

  function safeObject(v) { return v && typeof v === 'object' ? v : {}; }
  function asArray(v) { return Array.isArray(v) ? v : []; }
  function cleanString(v) { return typeof v === 'string' ? v.trim() : ''; }

  /* contentHash REPRESENTATION normalization only.
   *
   * M10 P3.5a moved archive package identity to the trusted Rust authority,
   * whose wire carries a BARE lowercase hex digest, while the current-projection
   * probe still carries the writer's `sha256-<hex>` form. The two sides of the
   * freshness comparison below therefore arrive in different representations,
   * and comparing them literally makes every genuinely current package render as
   * `content-stale` — the exact "correctly refuses, renders Current anyway"
   * failure inverted. Coverage already normalizes with the same helper; this
   * adapter was missed.
   *
   * This is REPRESENTATION only. Nothing is recomputed, and the frozen freshness
   * RULE is unchanged: a VALID package whose RECOMPUTED contentHash equals the
   * current authoritative projection. */
  function bareHash(v) {
    var text = cleanString(v).toLowerCase();
    return text.indexOf('sha256-') === 0 ? text.slice(7) : text;
  }

  /* Package kind, from the VERIFIED classification only. A basename is never
   * consulted here — §D already did that join against recomputed identity. */
  function packageKindV1(classification) {
    var c = cleanString(classification);
    if (c === 'generation') return 'generation';
    if (c === 'legacy') return 'legacy';
    return 'unusable';
  }

  var KIND_LABEL = {
    generation: 'Immutable generation',
    legacy: 'Legacy package',
    unusable: 'Unusable package',
  };

  /* Freshness label for ONE verified package against the current projection.
   *
   * `projectionStatus` is load-bearing: when the current projection is not
   * authoritative there is no comparison to make, so the honest answer is
   * "unknown", NOT "stale". Labelling a package stale because the store was
   * briefly unready would tell an operator their archive is out of date when
   * nothing of the sort was established. */
  function freshnessLabelV1(entry, coverage) {
    var e = safeObject(entry);
    var cov = safeObject(coverage);
    var projectionStatus = cleanString(safeObject(cov.projection).status);
    if (packageKindV1(e.classification) === 'unusable') return 'unusable';
    if (projectionStatus !== 'ok') return 'freshness-unknown';
    var currentHash = bareHash(safeObject(cov.projection).contentHash);
    if (!currentHash) return 'freshness-unknown';
    var entryHash = bareHash(e.contentHash);
    if (entryHash && entryHash === currentHash) return 'fresh';
    /* §F: the coverage authority already decided which kind of stale. Never
     * re-derive it here. */
    var kind = cleanString(e.staleKind);
    return kind === 'format-stale' ? 'format-stale' : 'content-stale';
  }

  var FRESHNESS_LABEL = {
    'fresh': 'Current',
    'content-stale': 'Historical (content changed)',
    'format-stale': 'Historical (different package format)',
    'freshness-unknown': 'Current state unknown',
    'unusable': 'Unusable',
  };

  function entryPresentationV1(entry, coverage) {
    var e = safeObject(entry);
    var freshness = freshnessLabelV1(e, coverage);
    var kind = packageKindV1(e.classification);
    return {
      kind: kind,
      kindLabel: KIND_LABEL[kind],
      freshness: freshness,
      freshnessLabel: FRESHNESS_LABEL[freshness],
      /* True only for the frozen positive rule. */
      isCurrent: freshness === 'fresh',
      /* Explicitly historical: shown so a surface can never render a
       * BEST-HISTORICAL candidate as though it were current. */
      isHistoricalOnly: freshness === 'content-stale' || freshness === 'format-stale',
      chatId: cleanString(e.chatId),
      snapshotId: cleanString(e.snapshotId),
      /* The RECOMPUTED verified hash the governed validator produced. */
      contentHash: cleanString(e.contentHash),
      schemaVersion: typeof e.schemaVersion === 'number' ? e.schemaVersion : null,
      payloadVersion: typeof e.payloadVersion === 'number' ? e.payloadVersion : null,
      /* Recorded location, never identity or freshness authority. */
      packagePath: cleanString(e.packagePath),
      packageDirName: cleanString(e.packageDirName),
      blockers: asArray(e.blockers).map(cleanString).filter(Boolean),
      advisories: asArray(e.advisories).map(cleanString).filter(Boolean),
    };
  }

  /* Whole-chat archive state for an operator surface.
   *
   * `covered` deliberately passes through null: Phase 2 reports null (not
   * false) when a truncated scan or an indeterminate projection makes the
   * negative unprovable, and collapsing that to false here would manufacture
   * exactly the authoritative absence the engine refused to claim. */
  function describeSavedChatArchiveStateV1(coverage) {
    var cov = safeObject(coverage);
    var projection = safeObject(cov.projection);
    var projectionStatus = cleanString(projection.status) || 'indeterminate';
    var complete = cov.complete === true;

    var legacy = asArray(cov.legacy).map(function (e) { return entryPresentationV1(e, cov); });
    var generations = asArray(cov.generations).map(function (e) { return entryPresentationV1(e, cov); });
    var unusable = asArray(cov.unusable).map(function (e) { return entryPresentationV1(e, cov); });
    var stale = asArray(cov.stale).map(function (e) { return entryPresentationV1(e, cov); });
    var fresh = asArray(cov.fresh).map(function (e) { return entryPresentationV1(e, cov); });

    var coverageState;
    if (cov.covered === true) coverageState = 'covered';
    else if (cov.covered === false) coverageState = 'not-covered';
    else coverageState = 'coverage-unknown';

    var best = cov.bestHistorical ? entryPresentationV1(cov.bestHistorical, cov) : null;

    return {
      chatId: cleanString(cov.chatId),
      /* Historical presence and current coverage are SEPARATE facts: a chat
       * can be fully preserved and not currently covered. */
      preserved: cov.preserved,
      preservedLabel: cov.preserved === true ? 'Preserved'
        : (cov.preserved === false ? 'No package' : 'Preservation unknown'),
      coverageState: coverageState,
      coverageLabel: coverageState === 'covered' ? 'Current archive is up to date'
        : (coverageState === 'not-covered' ? 'No package matches the current chat'
          : 'Current coverage cannot be determined'),
      /* Never presented as absence when discovery could not enumerate. */
      complete: complete,
      discoveryNote: complete ? '' : 'Archive discovery was incomplete; absence cannot be concluded.',
      projectionStatus: projectionStatus,
      projectionNote: projectionStatus === 'ok' ? ''
        : (projectionStatus === 'undefined-no-snapshot'
          ? 'No current Desktop snapshot; historical packages are not stale.'
          : 'Current Desktop state is indeterminate; freshness is not asserted.'),
      legacy: legacy,
      generations: generations,
      unusable: unusable,
      fresh: fresh,
      stale: stale,
      /* The coverage authority's selection — populated only when a FRESH
       * package exists. */
      selected: cov.selected ? entryPresentationV1(cov.selected, cov) : null,
      /* PRESENTATION ONLY (§G). Always carries isHistoricalOnly, is never
       * `selected`, and must never be used as a destructive-action target. */
      bestHistorical: best ? Object.assign({}, best, { presentationOnly: true }) : null,
      bestHistoricalTies: asArray(cov.bestHistoricalTies).map(function (e) {
        return Object.assign({}, entryPresentationV1(e, cov), { presentationOnly: true });
      }),
    };
  }

  /* Labels a materializer/publication result as RECORDED OPERATION HISTORY.
   * It is what happened at write time, never present-tense truth: if the
   * recorded path no longer verifies, the coverage/verifier result controls. */
  var OUTCOME_LABEL = {
    'created': 'New generation created',
    'deduped': 'Identical generation already present',
    'already-fresh': 'Archive was already up to date',
    'recovered-package-present': 'Recovered: publication had completed',
  };

  function describeMaterializationOutcomeV1(result) {
    var r = safeObject(result);
    var pkg = safeObject(r.package);
    var outcome = cleanString(pkg.outcome);
    var status = cleanString(r.status);
    if (!outcome && status === 'deferred') {
      var reason = cleanString(safeObject(r.deferred).reason);
      return {
        outcome: 'deferred',
        label: reason === 'discovery-incomplete'
          ? 'Deferred: archive could not be fully read'
          : 'Deferred: current Desktop state is indeterminate',
        recordedOnly: true, wrotePackage: false, reason: reason,
      };
    }
    if (status === 'failed') {
      return {
        outcome: 'failed',
        label: 'Publication failed',
        recordedOnly: true, wrotePackage: false,
        reason: cleanString(r.error),
      };
    }
    return {
      outcome: outcome || status || 'unknown',
      label: OUTCOME_LABEL[outcome] || 'Publication recorded',
      /* Only `created` actually wrote a package. */
      wrotePackage: outcome === 'created',
      /* Everything below is history, not present truth. */
      recordedOnly: true,
      recordedPackagePath: cleanString(pkg.packagePath),
      recordedContentHash: cleanString(pkg.contentHash),
      advisories: asArray(pkg.advisories).map(cleanString).filter(Boolean),
      durabilityComplete: pkg.durabilityComplete === true,
    };
  }

  function diagnoseSavedChatArchivePresentationV1() {
    return {
      installed: true,
      version: MODULE_VERSION,
      pure: true,
      recomputesContentHash: false,
      parsesGenerationNames: false,
      usesTimestamps: false,
      persistentIndex: false,
      freshnessRule: 'coverage authority only',
    };
  }

  H2O.Studio.ingestion.describeSavedChatArchiveStateV1 = describeSavedChatArchiveStateV1;
  H2O.Studio.ingestion.describeMaterializationOutcomeV1 = describeMaterializationOutcomeV1;
  H2O.Studio.ingestion.savedChatArchivePresentationV1 = {
    packageKind: packageKindV1,
    freshnessLabel: freshnessLabelV1,
    entryPresentation: entryPresentationV1,
    diagnose: diagnoseSavedChatArchivePresentationV1,
  };
})(typeof window !== 'undefined' ? window : globalThis);
