/* H2O Studio Saved Chat Archive Diagnostics (Desktop / Tauri)
 *
 * Read-only OBSERVATIONS beside the trusted verifier — DB drift, live-CAS
 * presence, write residue, capability reporting — plus the Archive Health
 * facade, which is sourced entirely from trusted Rust archive integrity.
 *
 * M10 P4 removed this module's duplicate JavaScript package verifier. It no
 * longer decides package validity in any form: it recomputes no member hash,
 * no contentHash and no schema/inventory verdict, and it reads no package
 * member. Package semantics belong to the trusted Rust verifier alone —
 * `h2o_saved_chat_archive_integrity` for the archive and
 * `h2o_saved_chat_portable_verify_*` for portable containers. Nothing here may
 * grow a second opinion about validity.
 *
 * Public API (H2O.Studio.ingestion):
 *   diagnoseSavedChatArchiveV1(options)            trusted Archive Health facade
 *   diagnoseSavedChatArchiveCapabilitiesV1()       capability report
 *   dbDriftForIdentityV1(identity, stores)         shared observation
 *   liveCasPresenceForShasV1(assets)               shared observation
 *
 * Boundaries: Desktop-only, AppLocalData only, read-only fs calls only. This
 * module does not touch DB/store rows, mutate live CAS, Sync, Chrome,
 * import/recovery, user export locations, package materialization, or UI.
 */
(function (global) {
  'use strict';

  function detectTauri() {
    try {
      if (typeof global.__TAURI_INTERNALS__ !== 'undefined') return true;
      if (typeof global.__TAURI__ !== 'undefined') return true;
    } catch (_) { /* ignore */ }
    return false;
  }
  if (!detectTauri()) return;

  var H2O = global.H2O = global.H2O || {};
  H2O.Studio = H2O.Studio || {};
  H2O.Studio.ingestion = H2O.Studio.ingestion || {};

  var APP_LOCAL_DATA = 15;
  var PACKAGE_ROOT = 'archive/packages';
  var LIVE_CAS_ROOT = 'archive/assets';
  var DIAGNOSTIC_SCHEMA = 'h2o.savedChatArchiveDiagnostic.v1';
  var STATUS_OK = 'ok';
  var STATUS_WARNING = 'warning';
  var STATUS_BLOCKED = 'blocked';
  var STATUS_EMPTY = 'empty';
  var STATUS_PARTIAL = 'partial';
  var state = {
    lastRunAt: null,
    errors: [],
  };

  function nowIso() {
    try { return new Date().toISOString(); }
    catch (_) { return String(Date.now()); }
  }

  function recordError(op, err) {
    state.errors.push({ t: Date.now(), op: String(op), error: String((err && err.message) || err || '') });
    if (state.errors.length > 20) state.errors.splice(0, state.errors.length - 20);
  }

  function isObject(value) { return !!value && typeof value === 'object' && !Array.isArray(value); }
  function safeObject(value) { return isObject(value) ? value : {}; }
  function asArray(value) { return Array.isArray(value) ? value : []; }
  function cleanString(value) { return String(value == null ? '' : value).trim(); }
  function isFiniteNumber(value) { return typeof value === 'number' && isFinite(value); }

  function joinPath() {
    var parts = [];
    for (var i = 0; i < arguments.length; i += 1) {
      var part = cleanString(arguments[i]).replace(/^\/+|\/+$/g, '');
      if (part) parts.push(part);
    }
    return parts.join('/');
  }

  function packageDirNameForPath(packagePath) {
    var path = cleanString(packagePath).replace(/[\/\\]+$/g, '');
    var idx = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
    return idx >= 0 ? path.slice(idx + 1) : path;
  }

  function packagePathForDirName(dirName) {
    return joinPath(PACKAGE_ROOT, dirName);
  }

  function fsOptions(extra) {
    var out = { baseDir: APP_LOCAL_DATA };
    var src = safeObject(extra);
    Object.keys(src).forEach(function (key) {
      if (key !== 'baseDir') out[key] = src[key];
    });
    return out;
  }

  function getInvoke() {
    try {
      var internals = global.__TAURI_INTERNALS__;
      if (internals && typeof internals.invoke === 'function') return internals.invoke.bind(internals);
    } catch (_) { /* ignore */ }
    try {
      var tauri = global.__TAURI__;
      if (tauri && tauri.core && typeof tauri.core.invoke === 'function') return tauri.core.invoke.bind(tauri.core);
      if (tauri && typeof tauri.invoke === 'function') return tauri.invoke.bind(tauri);
    } catch (_) { /* ignore */ }
    return null;
  }

  async function fsExists(path) {
    var invoke = getInvoke();
    if (!invoke) throw new Error('tauri invoke unavailable for fs exists');
    try { return !!(await invoke('plugin:fs|exists', { path: path, options: fsOptions() })); }
    catch (err) {
      var msg = String((err && err.message) || err).toLowerCase();
      if (msg.indexOf('not found') >= 0 || msg.indexOf('no such') >= 0) return false;
      throw err;
    }
  }

  async function fsReadDir(path) {
    var invoke = getInvoke();
    if (!invoke) throw new Error('tauri invoke unavailable for fs read_dir');
    return await invoke('plugin:fs|read_dir', { path: path, options: fsOptions() });
  }

  function makeIssue(code, message, detail) {
    var out = { code: code, message: message };
    if (typeof detail !== 'undefined') out.detail = detail;
    return out;
  }

  function rootResult(generatedAt) {
    return {
      ok: true,
      status: STATUS_OK,
      schema: DIAGNOSTIC_SCHEMA,
      generatedAt: generatedAt || nowIso(),
      baseDir: APP_LOCAL_DATA,
      roots: {
        packages: PACKAGE_ROOT,
        liveCas: LIVE_CAS_ROOT,
      },
      /* M05 G1: true only when every archive entry was enumerated. A consumer
       * must not infer absence from a result with complete:false. */
      complete: true,
      truncated: false,
      blockers: [],
      warnings: [],
      counts: {},
      assetChecks: {
        passed: 0,
        warnings: 0,
        failed: 0,
      },
      packages: [],
      /* M06 T1.3: read-only staging/temp residue evidence, closing the M05
       * gap recorded in saved-chat-generations.md: "diagnostics report residue
       * count and exact paths; no delete authority."
       *
       * `count` is DERIVED from `entries.length`, never tracked separately, so
       * the two cannot drift. `complete` says whether the enumerated scope was
       * fully walked; `scanned` and `unscanned` say what that scope IS, so a
       * `count: 0` is never mistaken for "no residue anywhere in the archive".
       * Paths are evidence only -- nothing here confers mutation authority. */
      residue: {
        complete: false,
        scanned: [],
        unscanned: [],
        sources: [],
        count: 0,
        entries: [],
      },
    };
  }

  /* The reserved trusted staging/temp families of M05 section R and M06 T1.2.
   * Deliberately NOT "anything that looks temporary": a foreign or stray file
   * is reported by the existing archive-entry-* warnings, not counted as
   * trusted-writer residue. The reserved instance lock and the reserved
   * quarantine namespace are infrastructure, never residue. */
  /* M06 T1.3: the durable CAS writer's temps live in archive/assets/<aa>/,
   * where this surface holds no read-dir grant. A narrow trusted read-only
   * command answers for that family instead of widening the renderer. */
  var DURABLE_TEMP_RESIDUE_COMMAND = 'h2o_archive_durable_temp_residue';
  var DURABLE_TEMP_ROOT = LIVE_CAS_ROOT;
  var DURABLE_TEMP_FAMILY = '.h2o-durable-*.tmp';

  async function probeDurableTempResidue() {
    var source = {
      root: DURABLE_TEMP_ROOT,
      family: DURABLE_TEMP_FAMILY,
      complete: false,
      entries: [],
      reason: '',
    };
    var invoke = getInvoke();
    if (!invoke) {
      source.reason = 'tauri-invoke-unavailable';
      return source;
    }
    try {
      var probe = await invoke(DURABLE_TEMP_RESIDUE_COMMAND);
      var payload = safeObject(probe);
      /* Completeness is only ever ADOPTED from an explicit true. A malformed or
       * partial payload stays incomplete. */
      source.complete = payload.complete === true;
      source.entries = asArray(payload.entries).map(function (entry) {
        var item = safeObject(entry);
        return {
          name: cleanString(item.name),
          path: cleanString(item.path),
          kind: cleanString(item.kind) || 'durable-temp',
        };
      });
      if (!source.complete) source.reason = 'probe-incomplete';
      return source;
    } catch (err) {
      recordError(DURABLE_TEMP_RESIDUE_COMMAND, err);
      source.reason = 'probe-failed';
      return source;
    }
  }

  var RESIDUE_STAGING_PREFIX = '.h2o-genstage-';
  var RESIDUE_TEMP_PREFIX = '.h2o-durable-';
  var RESIDUE_TEMP_SUFFIX = '.tmp';

  /* M10 P3b: read-only staging/temp residue evidence, observed independently of
   * package verification.
   *
   * The legacy aggregate collected residue while walking the archive to VERIFY
   * packages. Verification now lives in trusted Rust, so this walks the same
   * namespace for residue ALONE: it lists entry names, classifies the two
   * residue families by prefix, and reads nothing inside any package. It
   * creates nothing, deletes nothing, and reaches no conclusion about package
   * validity — exactly the M06 T1.3 contract, minus the verification it used to
   * ride along with. */
  async function residueObservationV1() {
    var carrier = { residue: rootResult().residue };
    var stagingSource = {
      root: PACKAGE_ROOT,
      family: RESIDUE_STAGING_PREFIX + '*',
      complete: false,
      entries: [],
      reason: '',
    };
    /* Probed on EVERY path: a result that skipped the probe must never present
     * itself as complete. */
    var durableSource = await probeDurableTempResidue();
    try {
      var rootExists = await fsExists(PACKAGE_ROOT);
      if (!rootExists) {
        /* A missing package root is a PROVEN absence of staging residue. */
        stagingSource.complete = true;
        finalizeResidue(carrier, [stagingSource, durableSource]);
        return carrier.residue;
      }
      var entries = asArray(await fsReadDir(PACKAGE_ROOT));
      for (var i = 0; i < entries.length; i += 1) {
        var name = entryName(entries[i] || {});
        if (!name) {
          stagingSource.reason = 'entry-name-unreadable';
          continue;
        }
        /* BOTH reserved families are captured here, exactly as the legacy walk
         * did: staging lands as a directory and durable temp as a file, and
         * either can sit in the package root. Filtering to staging alone would
         * silently shrink the residue evidence. */
        var residueKind = residueKindForName(name);
        if (residueKind) {
          stagingSource.entries.push({
            path: entryPath(entries[i] || {}, name),
            name: name,
            kind: residueKind,
          });
        }
      }
      stagingSource.complete = !stagingSource.reason;
    } catch (err) {
      stagingSource.complete = false;
      stagingSource.reason = String((err && err.message) || err) || 'staging-scan-failed';
    }
    finalizeResidue(carrier, [stagingSource, durableSource]);
    return carrier.residue;
  }

  function residueKindForName(name) {
    var text = cleanString(name);
    if (!text) return '';
    if (text.indexOf(RESIDUE_STAGING_PREFIX) === 0) return 'generation-staging';
    if (text.indexOf(RESIDUE_TEMP_PREFIX) === 0 && /\.tmp$/.test(text)) return 'durable-temp';
    return '';
  }

  function entryName(entry) {
    return cleanString(entry && (entry.name || entry.fileName || entry.basename || entry.path));
  }

  function entryPath(entry, fallbackName) {
    var path = cleanString(entry && entry.path);
    if (path) {
      var marker = PACKAGE_ROOT + '/';
      var idx = path.indexOf(marker);
      if (idx >= 0) return path.slice(idx);
      return path;
    }
    return packagePathForDirName(fallbackName);
  }

  function updateCounts(result) {
    var packages = result.packages || [];
    var counts = {
      packagesTotal: packages.length,
      packagesOk: 0,
      packagesWarning: 0,
      packagesBlocked: 0,
      v1: 0,
      v2: 0,
      v3: 0,
      missingLiveCasAssets: 0,
      brokenPackageAssets: 0,
      assetRefMismatches: 0,
      dataImageResidue: 0,
      orphanedPackages: 0,
      missingDbChats: 0,
      missingDbSnapshots: 0,
      stalePackages: 0,
      storeAssetMismatches: 0,
    };
    var assetSummary = {
      passed: 0,
      warnings: 0,
      failed: 0,
    };
    var dbSummary = {
      passed: 0,
      warnings: 0,
      failed: 0,
    };
    packages.forEach(function (pkg) {
      if (pkg.status === STATUS_BLOCKED) counts.packagesBlocked += 1;
      else if (pkg.status === STATUS_WARNING) counts.packagesWarning += 1;
      else if (pkg.status === STATUS_OK) counts.packagesOk += 1;
      if (pkg.schemaVersion === 1) counts.v1 += 1;
      if (pkg.schemaVersion === 2) counts.v2 += 1;
      if (pkg.schemaVersion === 3) counts.v3 += 1;
      var db = pkg.dbChecks || {};
      if (db.checked && db.available) {
        if (db.chatExists === false) counts.missingDbChats += 1;
        if (db.snapshotExists === false) counts.missingDbSnapshots += 1;
        if (db.packageIsLatest === false) counts.stalePackages += 1;
        if (db.packageAssetSetMatchesStore === false) counts.storeAssetMismatches += 1;
        if (db.chatExists === false && db.snapshotExists === false) counts.orphanedPackages += 1;
      }
      if (db.checked) {
        if (asArray(db.blockers).length) dbSummary.failed += 1;
        else if (asArray(db.warnings).length) dbSummary.warnings += 1;
        else if (db.available) dbSummary.passed += 1;
      }
      var checks = pkg.assetChecks || {};
      var broken =
        asArray(checks.missingPackageAssets).length +
        asArray(checks.unreadablePackageAssets).length +
        asArray(checks.hashMismatches).length +
        asArray(checks.byteLengthMismatches).length;
      var warnings =
        asArray(checks.extraPackageAssets).length +
        asArray(checks.unreferencedManifestAssets).length +
        asArray(checks.missingLiveCasAssets).length;
      counts.missingLiveCasAssets += asArray(checks.missingLiveCasAssets).length;
      counts.brokenPackageAssets += broken;
      counts.assetRefMismatches += asArray(checks.assetRefMismatches).length + asArray(checks.rendererAssetRefMismatches).length;
      counts.dataImageResidue += asArray(checks.dataImageResidue).length;
      if (broken || asArray(checks.assetRefMismatches).length || asArray(checks.rendererAssetRefMismatches).length || asArray(checks.dataImageResidue).length) {
        assetSummary.failed += 1;
      } else if (warnings || pkg.status === STATUS_WARNING) {
        assetSummary.warnings += 1;
      } else if (checks.packageAssetsOk === true || pkg.schemaVersion === 1 || pkg.schemaVersion === 2 || pkg.schemaVersion === 3) {
        assetSummary.passed += 1;
      }
    });
    /* Derived from the list itself so a count can never outlive its entries. */
    counts.residueTotal = asArray(result.residue && result.residue.entries).length;
    result.counts = Object.assign({}, result.counts || {}, counts);
    result.assetChecks = assetSummary;
    result.dbChecks = dbSummary;
    return result;
  }

  /* Seals the residue block: deterministic order, derived count, and an
   * explicit statement of what was NOT looked at.
   *
   * `.h2o-durable-*.tmp` is created by the trusted CAS writer inside the shard
   * directory `archive/assets/<aa>/`, and this surface holds fs:allow-read-dir
   * for archive/packages only. That family therefore cannot be enumerated from
   * here at all, so it is declared unscanned rather than silently contributing
   * zero. Reaching it would require a renderer capability change, which T1.3
   * is not authorized to make. */
  function finalizeResidue(result, sources) {
    var residue = result.residue;
    var entries = [];
    var list = asArray(sources);
    list.forEach(function (source) {
      asArray(source.entries).forEach(function (entry) { entries.push(entry); });
    });
    entries.sort(function (a, b) {
      if (a.path < b.path) return -1;
      if (a.path > b.path) return 1;
      return 0;
    });
    residue.entries = entries;
    /* DERIVED, both of them. `count` cannot outlive its list, and completeness
     * cannot be asserted independently of the sources that established it --
     * so "a failed probe plus an empty staging list" can never compose into an
     * authoritative zero. */
    residue.count = entries.length;
    residue.sources = list.map(function (source) {
      return {
        root: source.root,
        family: source.family,
        complete: source.complete === true,
        reason: source.complete === true ? '' : (source.reason || 'incomplete'),
      };
    });
    residue.scanned = residue.sources
      .filter(function (source) { return source.complete; })
      .map(function (source) { return source.root; });
    residue.unscanned = residue.sources.filter(function (source) { return !source.complete; });
    residue.complete = residue.unscanned.length === 0;
    return result;
  }

  function packageDiagnostic(packagePath) {
    var path = cleanString(packagePath);
    var dirName = packageDirNameForPath(path);
    return {
      ok: false,
      status: STATUS_BLOCKED,
      packagePath: path,
      packageDirName: dirName,
      /* M05 §D: 'legacy' | 'generation' | 'mismatch' | 'unclassified'.
       * Set only after verification, from the verified chatId and the
       * RECOMPUTED contentHash. */
      nameClassification: 'unclassified',
      /* Verified snapshot.savedAt; presentation ordering only (M05 §G). */
      savedAt: '',
      chatId: '',
      snapshotId: '',
      schemaVersion: null,
      payloadVersion: null,
      manifestPresent: false,
      snapshotPresent: false,
      markdownPresent: false,
      htmlPresent: false,
      assetsDirPresent: false,
      blockers: [],
      warnings: [],
      hashChecks: {
        snapshotShaOk: false,
        snapshotByteLengthOk: null,
        snapshotEncoding: '',
        logicalSnapshotSha: '',
        logicalSnapshotByteLength: null,
        contentHashOk: false,
        expectedContentHash: '',
        actualContentHash: '',
      },
      assetChecks: defaultAssetChecks(),
      dbChecks: defaultDbChecks(),
    };
  }

  function firstString() {
    for (var i = 0; i < arguments.length; i += 1) {
      var text = cleanString(arguments[i]);
      if (text) return text;
    }
    return '';
  }

  function defaultAssetChecks() {
    return {
      manifestAssetCount: 0,
      packageAssetCount: 0,
      packageAssetsOk: false,
      missingPackageAssets: [],
      unreadablePackageAssets: [],
      hashMismatches: [],
      byteLengthMismatches: [],
      extraPackageAssets: [],
      unreferencedManifestAssets: [],
      assetRefMismatches: [],
      dataImageResidue: [],
      rendererAssetRefMismatches: [],
      missingLiveCasAssets: [],
      liveCasChecked: false,
      liveCasAvailable: false,
    };
  }

  function getAssetCas() {
    try {
      var ingestion = H2O && H2O.Studio && H2O.Studio.ingestion;
      return ingestion && ingestion.assetCas ? ingestion.assetCas : null;
    } catch (_) {
      return null;
    }
  }

  function uniqStrings(values) {
    var seen = Object.create(null);
    var out = [];
    asArray(values).forEach(function (value) {
      var text = cleanString(value);
      if (text && !seen[text]) { seen[text] = true; out.push(text); }
    });
    return out;
  }

  function defaultDbChecks() {
    return {
      checked: false,
      available: false,
      chatExists: false,
      snapshotExists: false,
      latestSnapshotId: null,
      packageIsLatest: null,
      storeSnapshotCount: null,
      storeAssetCount: null,
      packageAssetSetMatchesStore: null,
      missingStoreAssets: [],
      extraStoreAssets: [],
      warnings: [],
      blockers: [],
    };
  }

  /* M10 P3a: the SAME C5.4A reconciliation, extracted so it can be driven by a
   * trusted identity instead of a re-parsed manifest.
   *
   * Read-only and package-centric. Uses ONLY store.chats.get /
   * store.snapshots.get / store.snapshots.listByChat / store.assets.listBySnapshot.
   * Never mutates the DB, never writes packages or CAS, never repairs/imports.
   * Missing rows / drift are WARNINGS, not blockers; a missing namespace,
   * missing method, or thrown read degrades to a warning.
   *
   * Decision-neutral: it reconciles the identity it is handed and reaches no
   * conclusion about package validity. `assetShas` is the package-side asset SHA
   * set — the legacy caller derives it from the verified manifest, the trusted
   * caller passes P1's already-verified `assetShas`. Neither re-verifies bytes.
   */
  async function dbDriftForIdentity(identity, stores) {
    var ident = safeObject(identity);
    var db = defaultDbChecks();
    var warnings = [];
    function warn(code, message, detail) {
      var issue = makeIssue(code, message, detail);
      db.warnings.push(issue);
      warnings.push(issue);
      return issue;
    }

    db.checked = true;
    if (!stores) {
      db.available = false;
      warn('db-api-missing', 'H2O.Studio.store is unavailable for DB reconciliation');
      return { dbChecks: db, warnings: warnings };
    }
    db.available = true;
    var chatId = cleanString(ident.chatId);
    var snapshotId = cleanString(ident.snapshotId);
    /* No identity to reconcile (an already-blocked package). */
    if (!chatId && !snapshotId) return { dbChecks: db, warnings: warnings };

    /* chat existence */
    if (chatId) {
      if (stores.chats && typeof stores.chats.get === 'function') {
        try {
          var chatRow = await stores.chats.get(chatId);
          db.chatExists = !!chatRow;
          if (!chatRow) warn('missing-db-chat', 'package chatId has no DB chat row', { chatId: chatId });
        } catch (err) {
          warn('db-check-failed', 'store.chats.get failed', { chatId: chatId, error: String((err && err.message) || err) });
        }
      } else {
        warn('db-api-missing', 'store.chats.get is unavailable');
      }
    }

    /* snapshot existence (store.snapshots.get returns { snapshot, turns } | row | null) */
    if (snapshotId) {
      if (stores.snapshots && typeof stores.snapshots.get === 'function') {
        try {
          var snapRow = await stores.snapshots.get(snapshotId);
          db.snapshotExists = !!(snapRow && (snapRow.snapshot || snapRow.snapshotId || snapRow.id));
          if (!db.snapshotExists) warn('missing-db-snapshot', 'package snapshotId has no DB snapshot row', { snapshotId: snapshotId });
        } catch (err) {
          warn('db-check-failed', 'store.snapshots.get failed', { snapshotId: snapshotId, error: String((err && err.message) || err) });
        }
      } else {
        warn('db-api-missing', 'store.snapshots.get is unavailable');
      }
    }

    /* latest-snapshot / stale-package: first row is treated as latest; an
     * indeterminate row shape is handled safely (packageIsLatest stays null). */
    if (chatId && stores.snapshots && typeof stores.snapshots.listByChat === 'function') {
      try {
        var rows = asArray(await stores.snapshots.listByChat(chatId));
        db.storeSnapshotCount = rows.length;
        if (rows.length) {
          var latestId = firstString(rows[0] && (rows[0].snapshotId || rows[0].id));
          db.latestSnapshotId = latestId || null;
          if (latestId && snapshotId) {
            db.packageIsLatest = latestId === snapshotId;
            if (!db.packageIsLatest) warn('stale-package', 'package snapshot is not the latest DB snapshot for this chat', { packageSnapshotId: snapshotId, latestSnapshotId: latestId });
          }
        }
      } catch (err) {
        warn('db-check-failed', 'store.snapshots.listByChat failed', { chatId: chatId, error: String((err && err.message) || err) });
      }
    } else if (chatId && (!stores.snapshots || typeof stores.snapshots.listByChat !== 'function')) {
      warn('db-api-missing', 'store.snapshots.listByChat is unavailable');
    }

    /* store asset registry vs the package-side asset SHA set */
    if (snapshotId) {
      if (stores.assets && typeof stores.assets.listBySnapshot === 'function') {
        try {
          var storeAssetRows = asArray(await stores.assets.listBySnapshot(snapshotId));
          var storeShas = uniqStrings(storeAssetRows.map(function (row) { return row && row.sha256; }));
          db.storeAssetCount = storeShas.length;
          var packageShas = uniqStrings(asArray(ident.assetShas));
          var missing = packageShas.filter(function (sha) { return storeShas.indexOf(sha) < 0; });
          var extra = storeShas.filter(function (sha) { return packageShas.indexOf(sha) < 0; });
          db.missingStoreAssets = missing;
          db.extraStoreAssets = extra;
          db.packageAssetSetMatchesStore = missing.length === 0 && extra.length === 0;
          if (!db.packageAssetSetMatchesStore) {
            warn('store-asset-registry-mismatch', 'store asset registry differs from package manifest assets', { missingStoreAssets: missing, extraStoreAssets: extra });
          }
        } catch (err) {
          warn('db-check-failed', 'store.assets.listBySnapshot failed', { snapshotId: snapshotId, error: String((err && err.message) || err) });
        }
      } else {
        warn('db-api-missing', 'store.assets.listBySnapshot is unavailable');
      }
    }

    return { dbChecks: db, warnings: warnings };
  }

  /* M10 P3a: the SAME read-only live-CAS presence observation, extracted so it
   * can be driven by a trusted asset SHA set.
   *
   * Presence only. It reads no package bytes, verifies nothing, and never
   * decides package validity: a missing CAS body is drift, because the package
   * itself remains portable. Unreferenced CAS content is NEVER called an
   * orphan, reclaimable, or safe to delete — no authority here says that.
   *
   * `assets` entries are `{ sha256, path? }`; `path` is warning DETAIL only. */
  async function liveCasPresenceForShas(assets) {
    var out = { checked: true, available: false, warnings: [] };
    function warn(code, message, detail) {
      out.warnings.push({ bucket: 'missingLiveCasAssets', issue: makeIssue(code, message, detail) });
    }
    var assetCas = getAssetCas();
    if (!assetCas || (typeof assetCas.exists !== 'function' && typeof assetCas.describe !== 'function')) {
      warn('live-cas-diagnostic-unavailable', 'live CAS read-only diagnostic helper is unavailable');
      return out;
    }
    out.available = true;
    var list = asArray(assets);
    for (var i = 0; i < list.length; i += 1) {
      var asset = safeObject(list[i]);
      var exists = false;
      try {
        if (typeof assetCas.exists === 'function') exists = !!(await assetCas.exists(asset.sha256));
        else {
          var desc = await assetCas.describe(asset.sha256);
          exists = !!(desc && desc.exists);
        }
      } catch (err) {
        warn('live-cas-check-failed', 'live CAS existence check failed', { sha256: asset.sha256, error: String((err && err.message) || err) });
        continue;
      }
      if (!exists) {
        warn('live-cas-missing-package-portable', 'live CAS asset is missing, but package remains portable when the package asset is valid', { sha256: asset.sha256, path: asset.path });
      }
    }
    return out;
  }

  /* M10 P3b: the six P2 operator states, expressed in the legacy status
   * vocabulary the unchanged Health formatter already consumes. No new status
   * key is introduced. `partial-scan` carries `complete:false`, and the
   * formatter's FIRST branch turns that into "Partial scan" whatever the
   * status says. */
  var LEGACY_STATUS_BY_AGGREGATE = {
    'healthy': STATUS_OK,
    'healthy-with-drift': STATUS_WARNING,
    'mixed': STATUS_PARTIAL,
    'integrity-problems': STATUS_BLOCKED,
    'empty': STATUS_EMPTY,
  };

  /* Projects ONE trusted presentation row into the legacy package shape real
   * consumers still read. Every identity fact comes from trusted Rust; status,
   * blockers and the deprecated compatibility names come from P2; warnings and
   * dbChecks come from the separate observations. Nothing is verified here. */
  function trustedRowToPackageDiagnostic(row, dbChecks) {
    var diag = packageDiagnostic(row.packagePath);
    diag.status = row.status;
    diag.ok = row.status === STATUS_OK;
    diag.nameClassification = row.nameClassification;
    diag.chatId = cleanString(row.chatId);
    diag.snapshotId = cleanString(row.snapshotId);
    diag.savedAt = cleanString(row.savedAt);
    diag.schemaVersion = row.schemaVersion;
    /* Blockers are the trusted verifier's own rule codes, humanized by P2. */
    diag.blockers = asArray(row.blockerExplanations).map(function (entry) {
      return makeIssue(entry.code, entry.text);
    });
    diag.warnings = asArray(row.warnings).map(function (text) {
      return makeIssue('package-drift', text);
    });
    /* The RECOMPUTED trusted contentHash. Kept on hashChecks for the existing
     * consumer that reads `expectedContentHash`; nothing is derived here. */
    var contentHash = cleanString(row.contentHash);
    diag.hashChecks.expectedContentHash = contentHash;
    diag.hashChecks.actualContentHash = contentHash;
    diag.hashChecks.contentHashOk = !!contentHash;
    if (isObject(dbChecks)) diag.dbChecks = dbChecks;
    /* The legacy asset/renderer buckets are NOT observed on the trusted path.
     * They are removed rather than left at their zero defaults so the UI can
     * tell "not measured" from "measured none". */
    delete diag.assetChecks.dataImageResidue;
    delete diag.assetChecks.assetRefMismatches;
    delete diag.assetChecks.rendererAssetRefMismatches;
    return diag;
  }

  /* M10 P3b — the production Archive Health facade, now sourced EXCLUSIVELY
   * from the trusted Rust integrity authority.
   *
   * There is deliberately NO runtime fallback: if the trusted read, the
   * trusted contract, or the presentation mapper fails, this rejects and the
   * Health UI's existing error lifecycle takes over. It never reaches for the
   * weaker JS verifier, and it never reports Healthy from legacy validation.
   * Operational rollback is reverting this commit, not a hidden second
   * authority.
   *
   * M10 P4 removed the duplicate JS verifier entirely: this module no longer
   * contains a package-validity implementation to fall back to. */
  function composeTrustedArchiveHealth() {
    var compose = H2O.Studio.ingestion.composeSavedChatArchiveHealthV1;
    if (typeof compose !== 'function') {
      throw new Error('[archive-health] the trusted composition is unavailable');
    }
    return compose;
  }

  async function diagnoseSavedChatArchiveV1(options) {
    var opts = safeObject(options);
    var composed = await composeTrustedArchiveHealth()({
      includeCasChecks: opts.includeCasChecks,
      includeRendererChecks: opts.includeRendererChecks,
      includeDbChecks: opts.includeDbChecks,
    });
    var model = composed.model;

    var result = rootResult();
    result.complete = model.complete;
    result.truncated = false;
    /* Residue is a SEPARATE read-only observation (M06 T1.3), not a package
     * verdict. It used to ride along with legacy enumeration; it is now
     * observed on its own so the aggregate still carries the evidence rather
     * than reporting an authoritative zero it never established. */
    result.residue = await residueObservationV1();
    /* Archive-level ENUMERATION blockers, distinct from per-package
     * verification blockers, exactly as the trusted envelope separates them. */
    result.blockers = asArray(composed.integrity && composed.integrity.blockers).map(function (code) {
      return makeIssue(cleanString(code), 'archive enumeration blocker');
    });
    result.warnings = asArray(model.archiveWarnings).map(function (text) {
      return makeIssue('archive-drift', text);
    });

    asArray(model.packageRows).forEach(function (row) {
      result.packages.push(
        trustedRowToPackageDiagnostic(row, composed.dbChecksByPath[row.packagePath]),
      );
    });

    updateCounts(result);
    /* M10 P3 metric correction. `updateCounts` is the SHARED legacy summariser,
     * so it still seeds these three keys from the legacy asset/renderer buckets
     * — buckets the trusted path deliberately does not populate. Emitting them
     * would publish a measured-looking zero for something this path never
     * measured, so the trusted result carries them not at all:
     *
     *   brokenPackageAssets  RETIRED. Canonical verification is fail-fast, so an
     *                        exact multi-error asset total does not exist. The
     *                        per-package trusted blocker explanations are the
     *                        authoritative account of what actually failed.
     *   assetRefMismatches   RETIRED. It conflated canonical package-integrity
     *                        mismatches with renderer-hygiene observations; the
     *                        integrity half is now a trusted blocker code.
     *   dataImageResidue     RETIRED as a legacy COUNT. Renderer hygiene is now
     *                        performed (P3.5b), but as a separate drift
     *                        observation reported under `rendererHygiene` with
     *                        its own availability. It is not folded back into
     *                        this legacy blocker-bucket total, whose semantics
     *                        were "package verification failures".
     */
    delete result.counts.brokenPackageAssets;
    delete result.counts.assetRefMismatches;
    delete result.counts.dataImageResidue;
    /* Renderer hygiene (P3.5b). Reported with its OWN availability rather than
     * implied by a missing key, and never a severity input of its own: its
     * findings already reached the aggregate as ordinary package drift
     * warnings, through the same presentation bucket every other observation
     * uses. Counts appear only for what was actually observed — a package that
     * could not be read contributes to `packagesUnavailable`, never a zero. */
    var hygiene = safeObject(composed.rendererHygiene);
    result.rendererHygiene = {
      observed: hygiene.packagesObserved > 0,
      attempted: hygiene.attempted === true,
      packagesObserved: hygiene.packagesObserved || 0,
      packagesUnavailable: hygiene.packagesUnavailable || 0,
      packagesSkipped: hygiene.packagesSkipped || 0,
    };
    if (result.rendererHygiene.observed) {
      result.rendererHygiene.dataImageResidue = hygiene.dataImageResidue || 0;
      result.rendererHygiene.assetRefDrift = hygiene.assetRefDrift || 0;
    }

    var status = LEGACY_STATUS_BY_AGGREGATE[model.aggregateState];
    if (!status) {
      /* partial-scan. `complete:false` already drives the formatter's first
       * branch; the status still describes what WAS observed, derived by the
       * same mapper rather than by a second rule here. */
      var observed = model.observed;
      status = LEGACY_STATUS_BY_AGGREGATE[
        H2O.Studio.archiveHealthMapping.selectAggregateState({
          complete: true,
          packagesTotal: observed.packagesTotal,
          packagesBlocked: observed.packagesBlocked,
          packagesWarning: observed.packagesWarning,
          archiveWarnings: asArray(model.archiveWarnings).length,
        })
      ] || STATUS_OK;
    }
    result.status = status;
    result.ok = status === STATUS_OK;
    state.lastRunAt = result.generatedAt;
    return result;
  }

  function diagnoseSavedChatArchiveCapabilitiesV1() {
    return {
      installed: true,
      schema: DIAGNOSTIC_SCHEMA,
      desktopOnly: true,
      readOnly: true,
      baseDir: APP_LOCAL_DATA,
      roots: {
        packages: PACKAGE_ROOT,
        liveCas: LIVE_CAS_ROOT,
      },
      requiredFs: ['exists', 'read_dir'],
      api: [
        'diagnoseSavedChatArchiveCapabilitiesV1',
        'diagnoseSavedChatArchiveV1',
      ],
      boundaries: {
        dbChecks: 'read-only-store-adapters',
        casChecks: 'read-only-exists-describe',
        sync: false,
        chrome: false,
        ui: false,
      },
      storeReads: [
        'chats.get',
        'snapshots.get',
        'snapshots.listByChat',
        'assets.listBySnapshot',
      ],
      lastRunAt: state.lastRunAt,
      errors: state.errors.slice(),
    };
  }

  /* M10 P3a: shared, decision-neutral observation helpers. Exported so the
   * trusted composition can reuse the EXISTING checks instead of restating
   * them. Neither decides package validity. */
  H2O.Studio.ingestion.dbDriftForIdentityV1 = dbDriftForIdentity;
  H2O.Studio.ingestion.liveCasPresenceForShasV1 = liveCasPresenceForShas;
  H2O.Studio.ingestion.diagnoseSavedChatArchiveCapabilitiesV1 = diagnoseSavedChatArchiveCapabilitiesV1;
  H2O.Studio.ingestion.diagnoseSavedChatArchiveV1 = function (options) {
    return diagnoseSavedChatArchiveV1(options);
  };
})(typeof window !== 'undefined' ? window : globalThis);
