/* H2O Studio — Saved Chat Archive Health UI (Desktop read-only, Phase C6.3)
 *
 * Read-only operator surface shell that renders the existing C5 archive
 * diagnostics into a Settings -> Diagnostics card. C6.2 adds compact summary
 * cards/counts and Copy report JSON. C6.3 adds a collapsed read-only package
 * details list. No runtime evidence (C6.4).
 *
 * Strictly read-only. It only calls the read-only diagnostic API
 * H2O.Studio.ingestion.diagnoseSavedChatArchiveV1 (injected by the caller). It
 * never mutates the DB, packages, CAS, sync, Chrome, or import/recovery state,
 * never repairs/imports/deletes/overwrites, and renders only into the provided
 * container (no full Settings repaint). On non-Desktop (API absent) it shows an
 * "available in Desktop Studio only" message instead of crashing.
 *
 * Public API (H2O.Studio.archiveHealthUi):
 *   renderArchiveHealthCard(container, { diagnose, diagnoseOptions })
 *   formatArchiveHealthSummary(result) -> pure { state, status, pill, headline, explanation }
 *   formatArchiveHealthSections(result) -> pure [{ key, title, note, counts }]
 *   renderArchiveHealthCounts(sections) -> html
 *   formatPackageDetailsRows(result) -> pure [{ packagePath, status, ... }]
 *   renderPackageDetails(result, state) -> html
 *   copyArchiveHealthReport(result) -> Promise<{ ok, message }>
 *
 * Contracts: docs/decisions/ADR-0009-chat-saving-architecture.md
 *            release-evidence/2026-06-24/saved-chat-archive-diagnostics-c5-closure.md
 */
(function (global) {
  'use strict';

  var H2O = global.H2O = global.H2O || {};
  H2O.Studio = H2O.Studio || {};
  if (H2O.Studio.archiveHealthUi && H2O.Studio.archiveHealthUi.__installed) return;

  var MODULE_VERSION = '0.3.0-phase-c-c6.3';

  var TEXT = {
    title: 'Saved Chat Archive Health',
    idle: 'Run diagnostics to check saved chat package health.',
    loading: 'Reading saved chat archive diagnostics…',
    unavailable: 'Archive diagnostics are available in Desktop Studio only.',
    empty: 'No saved chat packages found yet.',
    ok: 'Archive diagnostics completed.',
    warning: 'Archive diagnostics completed with warnings. Saved packages may still be portable.',
    blocked: 'Archive diagnostics found package integrity problems.',
    error: 'Could not run archive diagnostics.',
    runButton: 'Run diagnostics',
    copyButton: 'Copy report JSON',
    copied: 'Report JSON copied.',
    copyError: 'Could not copy report JSON.',
    showDetails: 'Show package details',
    hideDetails: 'Hide package details',
  };

  /* Non-scary explanations: drift/warnings are not corruption. */
  var EXPLAIN = {
    ok: 'All saved chat packages are structurally valid.',
    warning: 'Warnings are database or asset-cache drift. The saved packages remain valid and portable.',
    partial: 'Some packages have integrity problems; others are healthy and portable.',
    blocked: 'One or more saved chat packages are corrupt or unreadable and need attention.',
    empty: 'Save a chat to a folder to create a package.',
    warningHygiene: 'Warnings include renderer residue left inside otherwise valid packages. The saved packages remain valid and portable.',
    partialHygiene: 'Some packages have integrity problems; others are healthy and portable, though some carry cosmetic renderer residue.',
  };

  /* The label the package-details renderer already uses for an absent value;
   * reused so the card speaks one vocabulary for "we did not measure this". */
  var UNAVAILABLE_LABEL = 'n/a';

  var PILL_TONES = {
    ok: 'background:rgba(46,160,67,.18);color:#3fb950;border:1px solid rgba(46,160,67,.35)',
    warn: 'background:rgba(210,153,34,.18);color:#d29922;border:1px solid rgba(210,153,34,.35)',
    block: 'background:rgba(248,81,73,.16);color:#f85149;border:1px solid rgba(248,81,73,.35)',
    neutral: 'background:rgba(255,255,255,.06);color:inherit;border:1px solid rgba(255,255,255,.14)',
  };

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function nowIso() {
    try { return new Date().toISOString(); }
    catch (_) { return ''; }
  }

  /* M10 P3.5b: cause-aware drift copy. Renderer hygiene introduces a THIRD
   * drift cause alongside DB and asset-cache drift, and it is the only one that
   * is purely cosmetic — a package carrying renderer residue is valid and
   * portable. Saying so is a copy refinement, NOT a seventh operator state: the
   * state, pill and tone are unchanged, and hygiene never moves severity. The
   * unqualified drift wording would now be actively misleading, since it names
   * two causes that may not be the ones that fired. */
  function hygieneFindingCount(result) {
    var hygiene = safeObject(result && result.rendererHygiene);
    if (hygiene.observed !== true) return 0;
    return (hygiene.dataImageResidue || 0) + (hygiene.assetRefDrift || 0);
  }

  function explanationFor(status, result) {
    var base = EXPLAIN[status] || '';
    if (status !== 'warning' && status !== 'partial') return base;
    if (!hygieneFindingCount(result)) return base;
    if (status === 'warning') return EXPLAIN.warningHygiene;
    return EXPLAIN.partialHygiene;
  }

  /* Pure: map a diagnoseSavedChatArchiveV1 result to a status-only summary. */
  function formatArchiveHealthSummary(result) {
    var status = result && typeof result === 'object' ? String(result.status || '') : '';
    /* M05: an incomplete enumeration can never be presented as "nothing is
     * here". `empty` and every absence-flavoured verdict below assume the scan
     * saw the whole archive; when it did not, say so instead. */
    var scanComplete = !(result && typeof result === 'object') || result.complete !== false;
    if (!scanComplete) {
      return {
        state: 'ready',
        status: 'incomplete',
        pill: { label: 'Partial scan', tone: 'warn' },
        headline: 'Archive discovery was incomplete.',
        explanation: 'Only part of the archive could be enumerated, so absence '
          + 'cannot be concluded: packages may exist that this scan did not see. '
          + 'Existing findings below remain valid for the packages that WERE read.',
        complete: false,
      };
    }
    if (status === 'empty') {
      return { state: 'empty', status: 'empty', pill: { label: 'Empty', tone: 'neutral' }, headline: TEXT.empty, explanation: EXPLAIN.empty };
    }
    if (status === 'ok') {
      return { state: 'ready', status: 'ok', pill: { label: 'Healthy', tone: 'ok' }, headline: TEXT.ok, explanation: EXPLAIN.ok };
    }
    if (status === 'warning') {
      return { state: 'ready', status: 'warning', pill: { label: 'Healthy with drift', tone: 'warn' }, headline: TEXT.warning, explanation: explanationFor('warning', result) };
    }
    if (status === 'partial') {
      return { state: 'ready', status: 'partial', pill: { label: 'Mixed', tone: 'block' }, headline: TEXT.blocked, explanation: explanationFor('partial', result) };
    }
    if (status === 'blocked') {
      return { state: 'ready', status: 'blocked', pill: { label: 'Integrity problems', tone: 'block' }, headline: TEXT.blocked, explanation: EXPLAIN.blocked };
    }
    return { state: 'ready', status: status || 'unknown', pill: { label: 'Completed', tone: 'neutral' }, headline: TEXT.ok, explanation: '' };
  }

  function safeObject(value) {
    return value && typeof value === 'object' ? value : {};
  }

  function countValue(source, key) {
    var value = safeObject(source)[key];
    return (typeof value === 'number' && isFinite(value)) ? value : 0;
  }

  function listCount(value) {
    if (Array.isArray(value)) return value.length;
    return (typeof value === 'number' && isFinite(value)) ? value : 0;
  }

  function formatCount(label, key, value) {
    return { label: label, key: key, value: value, available: true };
  }

  /* M10 P3: a metric that was NOT OBSERVED. Deliberately distinct from a
   * measured zero — publishing `0` for something nothing measured is the exact
   * false-healthy shape this migration exists to remove. `countValue` and
   * `listCount` are untouched, so every measured metric is unaffected. */
  function unavailableCount(label, key) {
    return { label: label, key: key, value: null, available: false };
  }

  /* Absent -> the repository's existing explicit unavailable label. */
  function countDisplayValue(item) {
    if (!item || item.available === false || item.value == null) return UNAVAILABLE_LABEL;
    return item.value;
  }

  /* An optional LIST metric: a real array counts, an absent field is
   * unavailable. `listCount` still returns 0 for its own callers. */
  function listCountOrUnavailable(value) {
    if (Array.isArray(value)) return value.length;
    if (typeof value === 'number' && isFinite(value)) return value;
    return null;
  }

  /* M10 P3.5b: renderer hygiene is now OBSERVED, but only for packages the
   * observation could actually reach. Anything not observed stays `n/a` rather
   * than becoming a clean zero, and an observation that reached no package at
   * all publishes no counts — only its own unavailability. Hygiene is drift:
   * its findings already reached the aggregate as package warnings, so these
   * counts are a readout, never a second severity input. */
  function rendererHygieneCounts(result) {
    var hygiene = safeObject(result && result.rendererHygiene);
    if (hygiene.observed !== true) {
      return [unavailableCount('rendererHygiene', 'rendererHygiene')];
    }
    var counts = [
      formatCount('dataImageResidue', 'rendererHygiene.dataImageResidue',
        listCountOrUnavailable(hygiene.dataImageResidue)),
      formatCount('rendererAssetRefDrift', 'rendererHygiene.assetRefDrift',
        listCountOrUnavailable(hygiene.assetRefDrift)),
    ];
    /* Partial coverage is stated, not hidden: some packages were observed and
     * others could not be, so the counts above are not archive-wide. */
    if (hygiene.packagesUnavailable > 0) {
      counts.push(formatCount('hygieneUnobservedPackages', 'rendererHygiene.packagesUnavailable',
        hygiene.packagesUnavailable));
    }
    return counts;
  }

  /* Pure: groups the diagnostic result into C6.2 summary sections. */
  function formatArchiveHealthSections(result) {
    var counts = safeObject(result && result.counts);
    var dbChecks = safeObject(result && result.dbChecks);
    return [
      {
        key: 'archive-health',
        title: 'Archive health',
        note: 'Saved chat package inventory by current diagnostic status.',
        tone: 'neutral',
        counts: [
          formatCount('packagesTotal', 'packagesTotal', countValue(counts, 'packagesTotal')),
          formatCount('packagesOk', 'packagesOk', countValue(counts, 'packagesOk')),
          formatCount('packagesWarning', 'packagesWarning', countValue(counts, 'packagesWarning')),
          formatCount('packagesBlocked', 'packagesBlocked', countValue(counts, 'packagesBlocked')),
          formatCount('v1', 'v1', countValue(counts, 'v1')),
          formatCount('v2', 'v2', countValue(counts, 'v2')),
        ],
      },
      {
        /* M10 P3: integrity severity now comes only from trusted verification.
         * `brokenPackageAssets` and the conflated `assetRefMismatches` are
         * retired: the canonical verifier is fail-fast, so an exact broken-asset
         * total does not exist, and the old mismatch count mixed integrity with
         * renderer hygiene. Which packages failed, and which trusted rule each
         * one broke, is shown per package below. */
        key: 'integrity',
        title: 'Integrity',
        note: 'Blocked packages failed trusted verification. The exact rule that failed is listed with each package below.',
        tone: 'block',
        counts: [
          formatCount('packagesBlocked', 'packagesBlocked', countValue(counts, 'packagesBlocked')),
        ],
      },
      {
        key: 'drift',
        title: 'Drift / informational warnings',
        note: 'Drift does not automatically mean a saved package is broken; the package may still be portable.',
        tone: 'warn',
        counts: [
          formatCount('missingLiveCasAssets', 'missingLiveCasAssets', countValue(counts, 'missingLiveCasAssets')),
          formatCount('missingDbChats', 'missingDbChats', countValue(counts, 'missingDbChats')),
          formatCount('missingDbSnapshots', 'missingDbSnapshots', countValue(counts, 'missingDbSnapshots')),
          formatCount('orphanedPackages', 'orphanedPackages', countValue(counts, 'orphanedPackages')),
          formatCount('stalePackages', 'stalePackages', countValue(counts, 'stalePackages')),
          formatCount('storeAssetMismatches', 'storeAssetMismatches', countValue(counts, 'storeAssetMismatches')),
        ].concat(rendererHygieneCounts(result)),
      },
      {
        key: 'db-checks',
        title: 'DB checks summary',
        note: 'Read-only comparison between package identities and Desktop store rows.',
        tone: 'neutral',
        counts: [
          formatCount('dbChecks passed', 'dbChecks.passed', countValue(dbChecks, 'passed')),
          formatCount('dbChecks warnings', 'dbChecks.warnings', countValue(dbChecks, 'warnings')),
          formatCount('dbChecks failed', 'dbChecks.failed', countValue(dbChecks, 'failed')),
        ],
      },
    ];
  }

  function renderArchiveHealthCounts(sections) {
    var list = Array.isArray(sections) ? sections : [];
    if (!list.length) return '';
    var out = '<div data-archive-health-counts="1" style="display:flex;flex-direction:column;gap:12px;margin-top:8px">';
    list.forEach(function (section) {
      var toneBorder = section.tone === 'block'
        ? 'rgba(248,81,73,.25)'
        : section.tone === 'warn' ? 'rgba(210,153,34,.22)' : 'rgba(255,255,255,.12)';
      out += '<section data-archive-health-section="' + escapeHtml(section.key) + '" style="border:1px solid ' + toneBorder + ';border-radius:8px;padding:10px;background:rgba(255,255,255,.025)">'
        + '<div style="font-weight:600;font-size:13px">' + escapeHtml(section.title) + '</div>'
        + '<div style="opacity:.68;font-size:12px;margin-top:3px">' + escapeHtml(section.note) + '</div>'
        + '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px;margin-top:9px">';
      (section.counts || []).forEach(function (item) {
        out += '<div data-archive-health-count="' + escapeHtml(item.key) + '" style="border:1px solid rgba(255,255,255,.10);border-radius:6px;padding:8px;background:rgba(0,0,0,.12)">'
          + '<div style="font-size:18px;font-weight:700;line-height:1.15">' + escapeHtml(countDisplayValue(item)) + '</div>'
          + '<div style="opacity:.68;font-size:11px;word-break:break-word">' + escapeHtml(item.label) + '</div>'
          + '</div>';
      });
      out += '</div></section>';
    });
    out += '</div>';
    return out;
  }

  function summarizePackageDbChecks(packageDiagnostic) {
    var db = safeObject(packageDiagnostic && packageDiagnostic.dbChecks);
    return {
      chatExists: db.chatExists === true,
      snapshotExists: db.snapshotExists === true,
      packageIsLatest: db.packageIsLatest === true ? true : db.packageIsLatest === false ? false : null,
      storeAssetCount: typeof db.storeAssetCount === 'number' && isFinite(db.storeAssetCount) ? db.storeAssetCount : null,
    };
  }

  function summarizePackageAssetChecks(packageDiagnostic) {
    var assets = safeObject(packageDiagnostic && packageDiagnostic.assetChecks);
    return {
      manifestAssetCount: countValue(assets, 'manifestAssetCount'),
      packageAssetCount: countValue(assets, 'packageAssetCount'),
      missingPackageAssets: listCount(assets.missingPackageAssets),
      missingLiveCasAssets: listCount(assets.missingLiveCasAssets),
      /* Absent on the trusted path (renderer hygiene deferred to P3.5), so these
       * stay null and render as the existing unavailable label. */
      dataImageResidue: listCountOrUnavailable(assets.dataImageResidue),
      assetRefMismatches: listCountOrUnavailable(assets.assetRefMismatches),
    };
  }

  function packageSeverity(status) {
    status = String(status || '').toLowerCase();
    if (status === 'blocked') return 0;
    if (status === 'warning' || status === 'partial') return 1;
    if (status === 'ok') return 2;
    if (status === 'empty') return 3;
    return 4;
  }

  function formatPackageDetailsRows(result) {
    var packages = Array.isArray(result && result.packages) ? result.packages : [];
    return packages.map(function (pkg, index) {
      pkg = safeObject(pkg);
      var blockers = Array.isArray(pkg.blockers) ? pkg.blockers : [];
      var warnings = Array.isArray(pkg.warnings) ? pkg.warnings : [];
      /* M05 §D verified classification. Every package is listed on its own
       * row: multiple generations of one chat are distinct preservation
       * artifacts and must never be collapsed into a single "package" for
       * display compatibility. */
      var classification = String(pkg.nameClassification || 'unclassified');
      var kind = classification === 'generation' ? 'generation'
        : (classification === 'legacy' ? 'legacy' : 'unusable');
      return {
        index: index,
        packagePath: String(pkg.packagePath || ''),
        schemaVersion: pkg.schemaVersion == null ? '' : String(pkg.schemaVersion),
        status: String(pkg.status || 'unknown'),
        kind: kind,
        kindLabel: kind === 'generation' ? 'generation'
          : (kind === 'legacy' ? 'legacy' : 'unusable'),
        blockersCount: blockers.length,
        /* M10 P3: the trusted verification rules that actually failed. With the
         * approximate integrity counts retired, this IS the operator's account
         * of WHY a package is blocked, so the code is shown verbatim beside its
         * explanation. Read-only text; capped so one pathological package
         * cannot dominate the card. */
        blockerDetails: blockers.slice(0, 5).map(function (issue) {
          var entry = safeObject(issue);
          return {
            code: String(entry.code || ''),
            message: String(entry.message || ''),
          };
        }).filter(function (entry) { return entry.code || entry.message; }),
        warningsCount: warnings.length,
        chatId: String(pkg.chatId || ''),
        snapshotId: String(pkg.snapshotId || ''),
        dbChecks: summarizePackageDbChecks(pkg),
        assetChecks: summarizePackageAssetChecks(pkg),
      };
    }).sort(function (a, b) {
      var severity = packageSeverity(a.status) - packageSeverity(b.status);
      if (severity) return severity;
      if (b.blockersCount !== a.blockersCount) return b.blockersCount - a.blockersCount;
      if (b.warningsCount !== a.warningsCount) return b.warningsCount - a.warningsCount;
      return a.index - b.index;
    });
  }

  function renderBool(value) {
    if (value === true) return 'yes';
    if (value === false) return 'no';
    return 'n/a';
  }

  function renderPackageDetailsCell(label, value) {
    return '<span data-archive-health-detail-field="' + escapeHtml(label) + '" style="display:flex;flex-direction:column;gap:2px;min-width:0">'
      + '<span style="opacity:.58;font-size:10px">' + escapeHtml(label) + '</span>'
      + '<span style="font-size:12px;word-break:break-word">' + escapeHtml(value == null || value === '' ? 'n/a' : value) + '</span>'
      + '</span>';
  }

  /* Read-only presentation of the trusted verification failures. No action, no
   * affordance, no severity of its own: it explains the status the trusted
   * authority already decided. */
  function renderPackageBlockerDetails(entries) {
    var list = Array.isArray(entries) ? entries : [];
    if (!list.length) return '';
    var out = '<div data-archive-health-package-blockers="1" style="margin-top:8px;display:flex;flex-direction:column;gap:4px">';
    list.forEach(function (entry) {
      out += '<div data-archive-health-blocker-code="' + escapeHtml(entry.code) + '" style="font-size:11px;line-height:1.45">'
        + '<span style="opacity:.82">' + escapeHtml(entry.message) + '</span> '
        + '<span style="opacity:.55;font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;user-select:text">' + escapeHtml(entry.code) + '</span>'
        + '</div>';
    });
    return out + '</div>';
  }

  function renderPackageDetails(result, state) {
    var rows = formatPackageDetailsRows(result);
    if (!rows.length) return '';
    var view = safeObject(state);
    var expanded = view.detailsExpanded === true;
    var limit = typeof view.visibleLimit === 'number' && isFinite(view.visibleLimit) ? Math.max(1, view.visibleLimit) : 50;
    var visible = expanded ? rows.slice(0, limit) : [];
    var capped = expanded && rows.length > visible.length;
    var toggleLabel = expanded ? TEXT.hideDetails : TEXT.showDetails;
    var out = '<section data-archive-health-package-details="1" style="border:1px solid rgba(255,255,255,.12);border-radius:8px;padding:10px;background:rgba(255,255,255,.025);margin-top:8px">'
      + '<div style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px;flex-wrap:wrap">'
      + '<div>'
      + '<div style="font-weight:600;font-size:13px">Package details</div>'
      + '<div style="opacity:.68;font-size:12px;margin-top:3px">Show saved package status, warnings, blockers, and read-only DB/asset check summaries.</div>'
      + '<div style="opacity:.68;font-size:12px;margin-top:5px">Warnings usually mean DB/CAS drift. The saved package may still be portable. Blockers mean package integrity problems.</div>'
      + '</div>'
      + '<button type="button" data-archive-health-details-toggle="1" aria-expanded="' + (expanded ? 'true' : 'false') + '" style="padding:7px 12px;border-radius:6px;cursor:pointer;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.12);color:inherit;font:inherit">' + escapeHtml(toggleLabel) + '</button>'
      + '</div>';
    if (expanded) {
      out += '<div style="opacity:.6;font-size:12px;margin-top:8px">Showing ' + escapeHtml(visible.length) + ' of ' + escapeHtml(rows.length) + ' packages' + (capped ? ' (capped)' : '') + '.</div>'
        + '<div role="list" data-archive-health-package-list="1" style="display:flex;flex-direction:column;gap:8px;margin-top:8px">';
      visible.forEach(function (row) {
        var db = row.dbChecks;
        var assets = row.assetChecks;
        out += '<article role="listitem" data-archive-health-package-row="1" data-archive-health-package-status="' + escapeHtml(row.status) + '" style="border:1px solid rgba(255,255,255,.10);border-radius:7px;padding:9px;background:rgba(0,0,0,.12)">'
          + '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px;align-items:start">'
          + renderPackageDetailsCell('status', row.status)
          + renderPackageDetailsCell('schemaVersion', row.schemaVersion)
          + renderPackageDetailsCell('blockers', row.blockersCount)
          + renderPackageDetailsCell('warnings', row.warningsCount)
          + renderPackageDetailsCell('chatId', row.chatId)
          + renderPackageDetailsCell('snapshotId', row.snapshotId)
          + renderPackageDetailsCell('chatExists', renderBool(db.chatExists))
          + renderPackageDetailsCell('snapshotExists', renderBool(db.snapshotExists))
          + renderPackageDetailsCell('packageIsLatest', renderBool(db.packageIsLatest))
          + renderPackageDetailsCell('storeAssetCount', db.storeAssetCount)
          + renderPackageDetailsCell('manifestAssetCount', assets.manifestAssetCount)
          + renderPackageDetailsCell('packageAssetCount', assets.packageAssetCount)
          + renderPackageDetailsCell('missingPackageAssets', assets.missingPackageAssets)
          + renderPackageDetailsCell('missingLiveCasAssets', assets.missingLiveCasAssets)
          + renderPackageDetailsCell('dataImageResidue', assets.dataImageResidue)
          + renderPackageDetailsCell('assetRefMismatches', assets.assetRefMismatches)
          + '</div>'
          + renderPackageBlockerDetails(row.blockerDetails)
          + '<div data-archive-health-package-path="1" style="margin-top:8px;font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;font-size:11px;line-height:1.45;word-break:break-all;user-select:text;opacity:.82">'
          + '<span style="opacity:.58">packagePath</span> ' + escapeHtml(row.packagePath || 'n/a')
          + '</div>'
          + '</article>';
      });
      out += '</div>';
    }
    out += '</section>';
    return out;
  }

  function copyArchiveHealthReport(result) {
    return Promise.resolve().then(function () {
      if (!result || typeof result !== 'object') return { ok: false, message: TEXT.copyError };
      var nav = global.navigator;
      var clipboard = nav && nav.clipboard;
      if (!clipboard || typeof clipboard.writeText !== 'function') return { ok: false, message: TEXT.copyError };
      return clipboard.writeText(JSON.stringify(result, null, 2)).then(function () {
        return { ok: true, message: TEXT.copied };
      });
    }).catch(function () {
      return { ok: false, message: TEXT.copyError };
    });
  }

  function resolveDiagnose(options) {
    var opts = options || {};
    if (typeof opts.diagnose === 'function') return opts.diagnose;
    try {
      var ing = H2O.Studio && H2O.Studio.ingestion;
      if (ing && typeof ing.diagnoseSavedChatArchiveV1 === 'function') {
        return function (o) { return ing.diagnoseSavedChatArchiveV1(o); };
      }
    } catch (_) { /* ignore */ }
    return null;
  }

  function renderArchiveHealthCard(container, options) {
    if (!container || typeof container !== 'object') return null;
    if (typeof document === 'undefined') return null;
    var opts = options || {};
    var diagnose = resolveDiagnose(opts);
    var diagnoseOptions = opts.diagnoseOptions || { includeCasChecks: true, includeRendererChecks: true, includeDbChecks: true, limit: 500 };

    var card = {
      state: diagnose ? 'idle' : 'unavailable',
      lastResult: null,
      lastRunAt: null,
      error: null,
      busy: false,
      copyStatus: 'idle',
      detailsExpanded: false,
      visibleLimit: 50,
    };

    function pillHtml(label, tone) {
      var style = PILL_TONES[tone] || PILL_TONES.neutral;
      return '<span style="display:inline-block;padding:2px 10px;border-radius:999px;font-size:12px;font-weight:600;' + style + '">' + escapeHtml(label) + '</span>';
    }

    function bodyHtml() {
      if (card.state === 'unavailable') {
        return '<div style="opacity:.7;font-size:12px">' + escapeHtml(TEXT.unavailable) + '</div>';
      }
      if (card.state === 'idle') {
        return '<div style="opacity:.7;font-size:12px">' + escapeHtml(TEXT.idle) + '</div>';
      }
      if (card.state === 'loading') {
        return '<div style="opacity:.7;font-size:12px">' + escapeHtml(TEXT.loading) + '</div>';
      }
      if (card.state === 'error') {
        return '<div style="display:flex;flex-direction:column;gap:4px">'
          + '<div>' + pillHtml('Error', 'block') + '</div>'
          + '<div style="font-size:13px">' + escapeHtml(TEXT.error) + '</div>'
          + (card.error ? '<div style="opacity:.6;font-size:12px;font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace">' + escapeHtml(card.error) + '</div>' : '')
          + '</div>';
      }
      // ready / empty
      var summary = formatArchiveHealthSummary(card.lastResult);
      var countsHtml = summary.state === 'ready' ? renderArchiveHealthCounts(formatArchiveHealthSections(card.lastResult)) : '';
      var packageDetailsHtml = summary.state === 'ready' ? renderPackageDetails(card.lastResult, card) : '';
      return '<div style="display:flex;flex-direction:column;gap:6px">'
        + '<div>' + pillHtml(summary.pill.label, summary.pill.tone) + '</div>'
        + '<div style="font-size:13px">' + escapeHtml(summary.headline) + '</div>'
        + (summary.explanation ? '<div style="opacity:.7;font-size:12px">' + escapeHtml(summary.explanation) + '</div>' : '')
        + countsHtml
        + packageDetailsHtml
        + '</div>';
    }

    function render() {
      var lastRunLine = card.lastRunAt
        ? '<div style="opacity:.55;font-size:11px">Last run: ' + escapeHtml(card.lastRunAt) + '</div>'
        : '';
      var disabled = (card.busy || card.state === 'unavailable') ? ' disabled' : '';
      var copyDisabled = (!card.lastResult || card.busy) ? ' disabled' : '';
      var btnStyle = 'padding:8px 14px;border-radius:6px;cursor:pointer;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.12);color:inherit;font:inherit;'
        + ((card.busy || card.state === 'unavailable') ? 'opacity:.5;cursor:default;' : '');
      var copyBtnStyle = 'padding:8px 14px;border-radius:6px;cursor:pointer;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.12);color:inherit;font:inherit;'
        + ((!card.lastResult || card.busy) ? 'opacity:.5;cursor:default;' : '');
      var copyStatusHtml = card.copyStatus === 'copied'
        ? '<div data-archive-health-copy-status="1" style="opacity:.72;font-size:12px">' + escapeHtml(TEXT.copied) + '</div>'
        : card.copyStatus === 'error'
          ? '<div data-archive-health-copy-status="1" style="opacity:.72;font-size:12px">' + escapeHtml(TEXT.copyError) + '</div>'
          : '';
      var copyButtonHtml = card.lastResult
        ? '<button type="button" data-archive-health-copy="1" style="' + copyBtnStyle + '"' + copyDisabled + '>' + escapeHtml(TEXT.copyButton) + '</button>'
        : '';
      container.innerHTML = ''
        + '<div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap">'
        +   '<div style="font-weight:600">' + escapeHtml(TEXT.title) + '</div>'
        +   '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">'
        +     copyButtonHtml
        +     '<button type="button" data-archive-health-run="1" style="' + btnStyle + '"' + disabled + '>' + escapeHtml(TEXT.runButton) + '</button>'
        +   '</div>'
        + '</div>'
        + '<div data-archive-health-body="1">' + bodyHtml() + '</div>'
        + copyStatusHtml
        + lastRunLine;
      var btn = container.querySelector('[data-archive-health-run="1"]');
      if (btn && !(card.busy || card.state === 'unavailable')) {
        btn.addEventListener('click', run, { once: true });
      }
      var copyBtn = container.querySelector('[data-archive-health-copy="1"]');
      if (copyBtn && card.lastResult && !card.busy) {
        copyBtn.addEventListener('click', copyReport, { once: true });
      }
      var detailsBtn = container.querySelector('[data-archive-health-details-toggle="1"]');
      if (detailsBtn && card.lastResult && !card.busy) {
        detailsBtn.addEventListener('click', toggleDetails, { once: true });
      }
    }

    function run() {
      if (card.busy || card.state === 'unavailable' || !diagnose) return;
      card.busy = true;
      card.state = 'loading';
      card.error = null;
      card.copyStatus = 'idle';
      card.detailsExpanded = false;
      render();
      var p;
      try { p = diagnose(diagnoseOptions); }
      catch (err) { onError(err); return; }
      if (!p || typeof p.then !== 'function') { onResult(p); return; }
      p.then(onResult, onError);
    }

    function onResult(result) {
      card.busy = false;
      card.lastResult = result || null;
      card.lastRunAt = nowIso();
      var status = result && typeof result === 'object' ? String(result.status || '') : '';
      card.state = status === 'empty' ? 'empty' : 'ready';
      render();
    }

    function copyReport() {
      if (!card.lastResult || card.busy) return;
      card.copyStatus = 'idle';
      copyArchiveHealthReport(card.lastResult).then(function (out) {
        card.copyStatus = out && out.ok ? 'copied' : 'error';
        render();
      });
    }

    function toggleDetails() {
      if (!card.lastResult || card.busy) return;
      card.detailsExpanded = !card.detailsExpanded;
      render();
    }

    function onError(err) {
      card.busy = false;
      card.error = String((err && (err.message || err)) || 'unknown error');
      card.state = 'error';
      card.lastRunAt = nowIso();
      render();
    }

    render();

    // Phase F.2: mount the clearly-separated, Desktop-only operator action card
    // (its own module) as a sibling beneath this read-only diagnostics card. This
    // read-only card is unchanged and performs no mutation; it only delegates to
    // the operator action module, which owns the materializer call and its gate.
    try {
      var actionApi = H2O.Studio && H2O.Studio.archiveMaterializerAction;
      if (actionApi && typeof actionApi.mountArchiveMaterializerActionCard === 'function') {
        actionApi.mountArchiveMaterializerActionCard(container);
      }
    } catch (_) { /* operator action card must never break the read-only health card */ }

    // Phase H.2: mount the Desktop-only, READ-ONLY package inspector card (its own
    // module) as a sibling beneath this read-only diagnostics card. This card is
    // unchanged and performs no mutation; it only delegates a mount call to the
    // inspector module, which owns the read-only verification and its Desktop gate.
    try {
      var inspectorApi = H2O.Studio && H2O.Studio.archiveInspector;
      if (inspectorApi && typeof inspectorApi.mountArchiveInspectorCard === 'function') {
        inspectorApi.mountArchiveInspectorCard(container);
      }
    } catch (_) { /* inspector card must never break the read-only health card */ }

    // Phase H.4: mount the Desktop-only, verification-gated import/recovery card
    // (its own module) as a sibling beneath this read-only diagnostics card. This
    // card is unchanged and performs no mutation; it only delegates a mount call
    // to the importer module, which owns the dry-run + the single no-overwrite
    // write and its Desktop gate.
    try {
      var importerApi = H2O.Studio && H2O.Studio.archiveImporter;
      if (importerApi && typeof importerApi.mountArchiveImporterCard === 'function') {
        importerApi.mountArchiveImporterCard(container);
      }
    } catch (_) { /* importer card must never break the read-only health card */ }

    // Phase J.2: mount the Desktop-only, verification-gated export/share card
    // (its own module) as a sibling beneath this read-only diagnostics card. The
    // health card remains read-only; the exporter module owns the bounded
    // $HOME/H2O Studio Exports write and no-overwrite gate.
    try {
      var exporterApi = H2O.Studio && H2O.Studio.archiveExporter;
      if (exporterApi && typeof exporterApi.mountArchiveExporterCard === 'function') {
        exporterApi.mountArchiveExporterCard(container);
      }
    } catch (_) { /* exporter card must never break the read-only health card */ }

    // M06 T2.4: mount the New-UI-only, READ-ONLY storage/reclamation overview
    // as a sibling beneath this card. It exposes exactly one action, Analyze,
    // and no destructive control; this health card is unchanged and still
    // performs no mutation.
    try {
      var reclamationApi = H2O.Studio && H2O.Studio.reclamationUi;
      if (reclamationApi && typeof reclamationApi.mountReclamationCard === 'function') {
        reclamationApi.mountReclamationCard(container);
      }
    } catch (_) { /* reclamation card must never break the read-only health card */ }

    // Recovery Center T02: mount the New-UI-only, READ-ONLY per-chat version
    // timeline as a sibling beneath this card. It exposes no action beyond
    // Refresh and selection, and no destructive control of any kind; this
    // health card is unchanged and still performs no mutation.
    try {
      var recoveryCenterApi = H2O.Studio && H2O.Studio.recoveryCenterUi;
      if (recoveryCenterApi && typeof recoveryCenterApi.mountRecoveryCenterCard === 'function') {
        recoveryCenterApi.mountRecoveryCenterCard(container);
      }
    } catch (_) { /* recovery center card must never break the read-only health card */ }

    return { run: run, getState: function () { return card.state; } };
  }

  H2O.Studio.archiveHealthUi = {
    __installed: true,
    __version: MODULE_VERSION,
    renderArchiveHealthCard: renderArchiveHealthCard,
    formatArchiveHealthSummary: formatArchiveHealthSummary,
    formatArchiveHealthSections: formatArchiveHealthSections,
    renderArchiveHealthCounts: renderArchiveHealthCounts,
    formatPackageDetailsRows: formatPackageDetailsRows,
    renderPackageDetails: renderPackageDetails,
    summarizePackageDbChecks: summarizePackageDbChecks,
    summarizePackageAssetChecks: summarizePackageAssetChecks,
    copyArchiveHealthReport: copyArchiveHealthReport,
  };
})(typeof window !== 'undefined' ? window : globalThis);
