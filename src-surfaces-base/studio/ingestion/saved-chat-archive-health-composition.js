/* H2O Studio — trusted Archive Health composition (M10 P3a)
 *
 * Orchestration only. It joins three things that already have owners:
 *
 *   1. the TRUSTED integrity envelope (P1 Rust, via the thin client);
 *   2. SEPARATE existing observations that P1 does not own — DB drift, live-CAS
 *      presence, and V1/V2 renderer detail;
 *   3. the P2 presentation mapper.
 *
 * It decides no package validity of its own. It never calls the legacy package
 * verifier, never hashes, never derives a contentHash, never parses a manifest
 * to decide validity, and never infers FormatStale or a destructive
 * recommendation. Trusted class/reason is the only validity authority; the
 * separate observations can only add drift WARNINGS beside it.
 *
 * NO RUNTIME FALLBACK. If the trusted read fails, this composition rejects. It
 * must never reach for the weaker JS verifier to produce a verdict; operational
 * rollback is reverting the switch, not a hidden second authority.
 *
 * Family rule for renderer detail (M10 P3 §14):
 *   trusted V3, valid        -> SKIP  (persistent renderers are forbidden by V3
 *                                      semantics, so there is nothing to observe)
 *   trusted indeterminate    -> SKIP  (trusted integrity already refused it; a
 *                                      renderer read must not tell a second
 *                                      story about validity)
 *   trusted V1/V2, valid     -> MAY run, as separate DETAIL only
 *
 * Renderer HYGIENE (M10 P3.5b) is a DIFFERENT observation with a different
 * rule. The detail rule above concerns persistent renderer MEMBERS, which V3
 * forbids; hygiene concerns residue inside snapshot CONTENT, which V3 packages
 * still carry. So hygiene runs for every trusted-valid occupant regardless of
 * family, and skips only what trusted integrity already refused. Like every
 * observation here it can add drift warnings and nothing else.
 *
 * Public API (H2O.Studio.ingestion):
 *   composeSavedChatArchiveHealthV1(deps) -> Promise<presentation model + detail>
 */
(function (global) {
  'use strict';

  var H2O = global.H2O = global.H2O || {};
  H2O.Studio = H2O.Studio || {};
  H2O.Studio.ingestion = H2O.Studio.ingestion || {};
  if (H2O.Studio.ingestion.composeSavedChatArchiveHealthV1) return;

  var MODULE_VERSION = '0.1.0-m10-p3a';

  var CLASS_VERIFIED = 'verified-generation';
  var CLASS_LEGACY = 'legacy-package';

  function isObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
  }
  function asArray(value) { return Array.isArray(value) ? value : []; }
  function cleanString(value) { return String(value == null ? '' : value).trim(); }

  function compositionError(message) {
    var error = new Error('[archive-health-composition] ' + message);
    error.name = 'SavedChatArchiveHealthCompositionError';
    return error;
  }

  /* Resolve a collaborator: explicit injection first, then the installed
   * namespace. Nothing is invented when absent — the observation is simply
   * omitted, which is drift fidelity, never a validity claim. */
  function resolve(deps, key, fallbackPath) {
    var injected = isObject(deps) ? deps[key] : null;
    if (typeof injected === 'function') return injected;
    try {
      var value = H2O.Studio.ingestion[fallbackPath];
      return typeof value === 'function' ? value : null;
    } catch (_) { return null; }
  }

  function isTrustedValidPackage(occupant) {
    var klass = cleanString(occupant.class);
    return klass === CLASS_VERIFIED || klass === CLASS_LEGACY;
  }

  /* V3 is skipped because canonical V3 integrity FORBIDS persistent renderer
   * members, so there is no legitimate renderer observation to make. */
  function rendererObservationApplies(occupant) {
    if (!isTrustedValidPackage(occupant)) return false;
    return cleanString(occupant.constructionFamily) !== 'v3';
  }

  /* Hygiene applies to every trusted-VALID occupant, V3 included. The only
   * exclusion is an occupant trusted integrity refused. */
  function hygieneObservationApplies(occupant) {
    return isTrustedValidPackage(occupant);
  }

  async function composeSavedChatArchiveHealthV1(deps) {
    var options = isObject(deps) ? deps : {};

    var readIntegrity = resolve(options, 'readIntegrity', 'readSavedChatArchiveIntegrityV1');
    if (!readIntegrity) throw compositionError('the trusted integrity client is unavailable');

    var mapper = isObject(options.mapper)
      ? options.mapper
      : (H2O.Studio.archiveHealthMapping || null);
    if (!mapper || typeof mapper.mapArchiveHealth !== 'function') {
      throw compositionError('the presentation mapper is unavailable');
    }

    var dbDrift = resolve(options, 'dbDrift', 'dbDriftForIdentityV1');
    var casPresence = resolve(options, 'casPresence', 'liveCasPresenceForShasV1');
    var rendererDetail = typeof options.rendererDetail === 'function' ? options.rendererDetail : null;
    var rendererHygiene = resolve(options, 'rendererHygiene', 'observeSavedChatRendererHygieneV1');
    var stores = options.stores !== undefined ? options.stores : resolveStores();
    var includeDbChecks = options.includeDbChecks !== false;
    var includeCasChecks = options.includeCasChecks !== false;
    var includeRendererChecks = options.includeRendererChecks !== false;

    /* 1. TRUSTED read. A failure here propagates: no fallback exists. */
    var integrity = await readIntegrity();

    /* 2. Separate observations, bound to the TRUSTED row identity. */
    var packageWarnings = {};
    var dbChecksByPath = {};
    var detailByPath = {};
    /* Hygiene is summarised explicitly so consumers can tell "observed and
     * clean" from "not observed" without inferring it from a missing key. */
    var hygieneSummary = {
      attempted: false,
      packagesObserved: 0,
      packagesUnavailable: 0,
      packagesSkipped: 0,
      dataImageResidue: 0,
      assetRefDrift: 0,
    };

    var occupants = asArray(integrity && integrity.occupants);
    for (var i = 0; i < occupants.length; i += 1) {
      var occupant = isObject(occupants[i]) ? occupants[i] : {};
      var packagePath = cleanString(occupant.path);
      if (!packagePath) continue;
      var warnings = [];

      /* DB drift: reconciles the TRUSTED identity. Never runs for an occupant
       * that trusted integrity refused — there is no identity to reconcile. */
      if (includeDbChecks && dbDrift && isTrustedValidPackage(occupant)) {
        var drift = await dbDrift({
          chatId: occupant.chatId,
          snapshotId: occupant.snapshotId,
          assetShas: asArray(occupant.assetShas),
        }, stores);
        if (isObject(drift)) {
          dbChecksByPath[packagePath] = drift.dbChecks;
          asArray(drift.warnings).forEach(function (issue) {
            warnings.push(cleanString(issue && issue.message) || cleanString(issue && issue.code));
          });
        }
      }

      /* Live CAS presence, from the TRUSTED asset SHA set. Presence only: a
       * missing body is drift because the package itself stays portable. */
      if (includeCasChecks && casPresence && Array.isArray(occupant.assetShas) && occupant.assetShas.length) {
        var cas = await casPresence(occupant.assetShas.map(function (sha) { return { sha256: sha }; }));
        if (isObject(cas)) {
          detailByPath[packagePath] = detailByPath[packagePath] || {};
          detailByPath[packagePath].liveCas = { checked: cas.checked, available: cas.available };
          asArray(cas.warnings).forEach(function (entry) {
            var issue = isObject(entry) ? (entry.issue || entry) : {};
            warnings.push(cleanString(issue.message) || cleanString(issue.code));
          });
        }
      }

      /* V1/V2 renderer DETAIL. Skipped for V3 and for anything trusted
       * integrity refused. It may never change the trusted classification, in
       * either direction; if the read becomes unavailable the detail is simply
       * absent. */
      if (includeRendererChecks && rendererDetail && rendererObservationApplies(occupant)) {
        var detail = null;
        try {
          detail = await rendererDetail({
            packagePath: packagePath,
            constructionFamily: occupant.constructionFamily,
            contentHash: occupant.contentHash,
            chatId: occupant.chatId,
            snapshotId: occupant.snapshotId,
          });
        } catch (_) {
          detail = { inconclusive: true };
        }
        if (isObject(detail)) {
          detailByPath[packagePath] = detailByPath[packagePath] || {};
          detailByPath[packagePath].renderer = detail;
          asArray(detail.warnings).forEach(function (issue) {
            warnings.push(cleanString(issue && issue.message) || cleanString(issue && issue.code));
          });
        }
      }

      /* Renderer HYGIENE. Drift only: its warnings join the same presentation
       * bucket every other observation uses, so it can never produce a blocker
       * or alter the trusted classification. An unavailable observation
       * contributes no warning and is counted as unavailable, never as clean. */
      if (includeRendererChecks && rendererHygiene) {
        if (!hygieneObservationApplies(occupant)) {
          hygieneSummary.packagesSkipped += 1;
        } else {
          hygieneSummary.attempted = true;
          var hygiene = null;
          try {
            hygiene = await rendererHygiene({
              packagePath: packagePath,
              class: occupant.class,
              constructionFamily: occupant.constructionFamily,
              snapshotEncoding: occupant.snapshotEncoding,
              snapshotPhysicalByteLength: occupant.snapshotPhysicalByteLength,
              logicalSnapshotByteLength: occupant.logicalSnapshotByteLength,
              assetShas: occupant.assetShas,
            });
          } catch (_) {
            hygiene = { applicable: true, observed: false, reason: 'renderer-hygiene-threw', warnings: [] };
          }
          if (isObject(hygiene)) {
            detailByPath[packagePath] = detailByPath[packagePath] || {};
            detailByPath[packagePath].rendererHygiene = hygiene;
            if (hygiene.observed === true) {
              hygieneSummary.packagesObserved += 1;
              var findings = isObject(hygiene.findings) ? hygiene.findings : {};
              if (findings.dataImageResidue === true) hygieneSummary.dataImageResidue += 1;
              if (asArray(findings.assetRefDrift).length) hygieneSummary.assetRefDrift += 1;
              asArray(hygiene.warnings).forEach(function (entry) {
                warnings.push(cleanString(entry && entry.message) || cleanString(entry && entry.code));
              });
            } else if (hygiene.applicable === false) {
              hygieneSummary.packagesSkipped += 1;
            } else {
              hygieneSummary.packagesUnavailable += 1;
            }
          }
        }
      }

      var kept = warnings.filter(Boolean);
      if (kept.length) packageWarnings[packagePath] = kept;
    }

    /* 3. Presentation. The mapper owns state selection; a contract error from
     * it propagates rather than being softened into a healthy result. */
    var model = mapper.mapArchiveHealth({
      integrity: integrity,
      presentation: {
        packageWarnings: packageWarnings,
        archiveWarnings: asArray(options.archiveWarnings),
        driftFacts: { dbChecksByPath: dbChecksByPath },
      },
    });

    return {
      model: model,
      integrity: integrity,
      dbChecksByPath: dbChecksByPath,
      detailByPath: detailByPath,
      rendererHygiene: hygieneSummary,
    };
  }

  function resolveStores() {
    try { return (H2O.Studio && H2O.Studio.store) || null; } catch (_) { return null; }
  }

  H2O.Studio.ingestion.composeSavedChatArchiveHealthV1 = composeSavedChatArchiveHealthV1;
  H2O.Studio.ingestion.SAVED_CHAT_ARCHIVE_HEALTH_COMPOSITION_VERSION = MODULE_VERSION;
})(typeof globalThis !== 'undefined' ? globalThis : this);
