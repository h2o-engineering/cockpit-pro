/* H2O Studio Sync — Chrome local publication runtime composition.
 *
 * This entry contains no projection, ledger, or filesystem implementation.
 * It composes the accepted packaged authorities over the existing Sync folder
 * handle and exposes one explicit-gesture API to Browser Delivery.
 */
(function (global) {
  'use strict';

  function isTauri() {
    try {
      return typeof global.__TAURI_INTERNALS__ !== 'undefined' ||
        typeof global.__TAURI__ !== 'undefined';
    } catch (_) {
      return false;
    }
  }

  function isChromeStudio() {
    try {
      return !isTauri() &&
        global.location?.protocol === 'chrome-extension:' &&
        !!global.chrome?.runtime?.id;
    } catch (_) {
      return false;
    }
  }

  if (!isChromeStudio()) return;

  var H2O = global.H2O = global.H2O || {};
  H2O.Studio = H2O.Studio || {};
  H2O.Studio.sync = H2O.Studio.sync || {};
  if (H2O.Studio.sync.localPublication) return;

  var STORE_MODULE_PATH =
    'surfaces/studio/sync/item9-adapters/sync-object-store.mjs';
  var PROJECTION_MODULE_PATH =
    'surfaces/studio/sync/local-publication-adapters/browser-adapters/chrome/local-publication-projection.mjs';
  var WRITER_MODULE_PATH =
    'surfaces/studio/sync/local-publication-adapters/browser-adapters/chrome/local-publication-writer.mjs';
  var runtimeLoadState = 'idle';
  var runtimePromise = null;
  var runtimeFailureCode = null;
  var activeWriter = null;
  var activeProjection = null;
  var activeLedger = null;
  var inFlight = null;
  var lastResult = null;
  var CONFIG_KEY = 'h2o:studio:sync:config:v1';

  var ENTRY_ERROR = Object.freeze({
    RUNTIME_UNAVAILABLE: 'local-publication-runtime-unavailable',
    OBJECT_UNAVAILABLE: 'local-publication-object-unavailable',
    BUSY: 'local-publication-busy'
  });
  var safeErrorCodes = new Set(Object.values(ENTRY_ERROR));
  /* Owned by packages/browser-adapters/chrome/sync-p01-mutation-admission-chrome.mjs
   * (CHROME_P01_MUTATION_ADMISSION.ERROR). Listed rather than imported because
   * this entry composes that owner through the Studio facade, which exposes no
   * enum. */
  var ADMISSION_ERROR_CODES = Object.freeze([
    'p01-mutation-admission-serialization-unavailable',
    'p01-mutation-admission-held',
    'p01-mutation-admission-lease-invalid',
    'p01-mutation-admission-hold-busy',
    'p01-mutation-admission-hold-released',
    'p01-mutation-admission-input-invalid'
  ]);

  function clean(value) {
    return String(value == null ? '' : value).trim();
  }

  function blocked(code) {
    return Object.freeze({
      ok: false,
      verdict: 'blocked',
      errorCode: safeErrorCodes.has(code)
        ? code
        : ENTRY_ERROR.RUNTIME_UNAVAILABLE
    });
  }

  function safeResult(result) {
    if (!result || result.ok !== true) return blocked(result?.errorCode);
    return Object.freeze({
      ok: true,
      verdict: result.unchangedNoOp === true ? 'no-op' : 'published',
      disposition: clean(result.disposition),
      visibility: clean(result.visibility),
      slotPosture: clean(result.slotPosture),
      revisionId: clean(result.revisionId),
      previousRevisionId: result.previousRevisionId == null
        ? null
        : clean(result.previousRevisionId),
      ledgerAdvanced: result.advanceLedger === true,
      unchangedNoOp: result.unchangedNoOp === true
    });
  }

  function hasArchiveOps(candidate) {
    return !!candidate &&
      typeof candidate.listWorkbenchRows === 'function' &&
      typeof candidate.listSnapshots === 'function' &&
      typeof candidate.loadSnapshot === 'function';
  }

  /* The projection reads the saved-chat archive through exactly three ops. Two
   * legitimate runtimes provide them and both resolve to the SAME Cockpit Pro
   * archive database, so this is one truth reached two ways:
   *   - chatgpt.com: H2O.archiveBoot, installed by the transcript archive engine;
   *   - Studio: H2O.Studio.archiveAuthority, the narrow read-only surface over
   *     the established Studio↔service-worker archive path. The archive engine
   *     is deliberately not loaded in Studio, so without this the Browser
   *     Delivery panel could never project or publish at all. */
  function archiveAuthority() {
    if (hasArchiveOps(H2O.archiveBoot)) return H2O.archiveBoot;
    var studioArchive = H2O.Studio && H2O.Studio.archiveAuthority;
    if (hasArchiveOps(studioArchive)) return studioArchive;
    throw Object.assign(new Error(ENTRY_ERROR.RUNTIME_UNAVAILABLE), {
      code: ENTRY_ERROR.RUNTIME_UNAVAILABLE
    });
  }

  function folderAuthority() {
    return Object.freeze({
      getConnectedDirectoryHandle: function () {
        var folder = H2O.Studio.sync.folder;
        return folder && typeof folder.getConnectedDirectoryHandle === 'function'
          ? folder.getConnectedDirectoryHandle()
          : null;
      }
    });
  }

  async function automaticAuthority() {
    try {
      var stored = await global.chrome.storage.local.get(CONFIG_KEY);
      var config = stored && stored[CONFIG_KEY];
      return !!config && config.schemaVersion === 1 && config.mode === 'auto';
    } catch (_) {
      return false;
    }
  }

  /*
   * O1-B2.1. The installed P01 writer-generation gate, or undefined when this
   * build has none. Returning undefined is deliberate: it lets the writer's own
   * default parameter supply the pre-T19 compatibility position rather than
   * this module inventing a second, divergent one.
   */
  function writerGenerationSurface() {
    var gate = H2O.Studio && H2O.Studio.sync && H2O.Studio.sync.writerGeneration;
    return gate && typeof gate.p01MayMutate === 'function' ? gate : undefined;
  }

  function p01MutationAdmissionSurface() {
    var admission = H2O.Studio && H2O.Studio.sync &&
      H2O.Studio.sync.p01MutationAdmission;
    if (admission && typeof admission.run === 'function') return admission;
    return Object.freeze({
      run: function () {
        var error = new Error(
          'p01-mutation-admission-serialization-unavailable'
        );
        error.code = 'p01-mutation-admission-serialization-unavailable';
        return Promise.reject(error);
      }
    });
  }

  /*
   * Composition has three distinct outcomes and they are NOT interchangeable.
   *
   *   in flight - coalesced. Concurrent callers share one attempt, so readiness
   *               can never build a second writer or a second publication
   *               authority.
   *   succeeded - authoritative for the life of the page and never rebuilt.
   *   failed    - NOT retained. Studio installs H2O.Studio.archiveAuthority on
   *               its own schedule, and this module can load first. Memoising
   *               that rejection left the page permanently unpublishable even
   *               after the dependency arrived, because every later caller
   *               received the same settled rejection and no retry was ever
   *               attempted. A failed attempt is therefore discarded and the
   *               next call composes again.
   *
   * Nothing here publishes, and a retry is composition only: no store
   * operation, permission query, publication plan, ledger stage or folder
   * write happens on this path.
   */
  function loadRuntime() {
    if (runtimePromise) return runtimePromise;
    runtimeLoadState = 'pending';
    runtimeFailureCode = null;
    var urls;
    try {
      urls = [STORE_MODULE_PATH, PROJECTION_MODULE_PATH, WRITER_MODULE_PATH]
        .map(function (modulePath) {
          return global.chrome.runtime.getURL(modulePath);
        });
    } catch (_) {
      runtimeLoadState = 'failed';
      runtimeFailureCode = ENTRY_ERROR.RUNTIME_UNAVAILABLE;
      return Promise.reject(new Error(ENTRY_ERROR.RUNTIME_UNAVAILABLE));
    }
    var attempt = Promise.all(urls.map(function (url) { return import(url); }))
      .then(function (modules) {
        var storeModule = modules[0];
        var projectionModule = modules[1];
        var writerModule = modules[2];
        var ledger = storeModule.createChromeSyncObjectStore({
          identityProvider: H2O.Studio.identity,
          indexedDBFactory: global.indexedDB,
          cryptoImplementation: global.crypto
        });
        var archiveAdapter =
          projectionModule.createChromeArchiveProjectionAdapter({
            archiveAuthority: archiveAuthority()
          });
        var projection = projectionModule.createChromeLocalPublicationProjection({
          stores: archiveAdapter.stores,
          relationshipProbe: archiveAdapter.relationshipProbe,
          identityProvider: H2O.Studio.identity,
          cryptoImplementation: global.crypto
        });
        /* A superseded attempt never replaces a live publication authority. */
        if (runtimePromise !== attempt && runtimeLoadState === 'ready') {
          return activeWriter;
        }
        activeLedger = ledger;
        activeProjection = projection;
        activeWriter = writerModule.createChromeLocalPublicationWriter({
          projection: projection,
          ledger: ledger,
          folderAuthority: folderAuthority(),
          cryptoImplementation: global.crypto,
          userActivation: function () {
            return global.navigator?.userActivation?.isActive === true;
          },
          automaticAuthority: automaticAuthority,
          /*
           * O1-B2.1. The writer's default gate is a permissive stub, so a
           * composition that hands it nothing publishes ungated. This is the
           * manual publication lane - the one a button press reaches - and a
           * button press does not change who owns the data.
           *
           * The installed global gate is passed rather than a freshly built
           * one: it already reads THIS platform's record through this
           * platform's path, and it exposes p01MayMutate directly.
           *
           * An ABSENT gate surface leaves the writer's default in place, which
           * is the accepted compatibility position - a statement about the
           * BUILD, not about the store. Once the gate is installed, its
           * four-state observation governs, and an unreadable store refuses.
           */
          writerGenerationGate: writerGenerationSurface(),
          p01MutationAdmission: p01MutationAdmissionSurface()
        });
        Object.values(storeModule.ITEM9_1_CONSTANTS.ERROR_CODE)
          .forEach(function (code) { safeErrorCodes.add(code); });
        Object.values(projectionModule.LOCAL_PUBLICATION_PROVENANCE_ERROR)
          .forEach(function (code) { safeErrorCodes.add(code); });
        Object.values(projectionModule.LOCAL_PUBLICATION_PROJECTION_ERROR)
          .forEach(function (code) { safeErrorCodes.add(code); });
        Object.values(writerModule.LOCAL_PUBLICATION_WRITER_ERROR)
          .forEach(function (code) { safeErrorCodes.add(code); });
        /* Mutation-admission and generation refusals are legitimate, already
         * product-facing verdicts. Without them here, blocked() collapses a
         * real admission decision into runtime-unavailable and the operator is
         * shown the wrong failure class - which is exactly what masked this
         * defect. The generation reasons come from the installed authority
         * itself; the admission codes are the existing ones owned by
         * sync-p01-mutation-admission-chrome.mjs. No new taxonomy. */
        var installedGate = writerGenerationSurface();
        if (installedGate && installedGate.REASON) {
          Object.values(installedGate.REASON)
            .forEach(function (code) { safeErrorCodes.add(code); });
        }
        ADMISSION_ERROR_CODES.forEach(function (code) { safeErrorCodes.add(code); });
        runtimeLoadState = 'ready';
        runtimeFailureCode = null;
        return activeWriter;
      })
      .catch(function (error) {
        /* Only the CURRENT attempt may reset shared state. A superseded attempt
         * that settles late must not tear down a live writer. */
        if (runtimePromise !== attempt) throw new Error(ENTRY_ERROR.RUNTIME_UNAVAILABLE);
        activeWriter = null;
        activeProjection = null;
        activeLedger = null;
        runtimeLoadState = 'failed';
        /* Keep the underlying reason when it is already an allow-listed safe
         * code, so a genuine composition failure is not masked as a bare
         * runtime-unavailable in diagnose(). The thrown code is unchanged. */
        var code = clean(error && error.code);
        runtimeFailureCode = safeErrorCodes.has(code)
          ? code
          : ENTRY_ERROR.RUNTIME_UNAVAILABLE;
        /* Discard the rejected attempt so the next call composes again once the
         * missing dependency exists. */
        runtimePromise = null;
        throw new Error(ENTRY_ERROR.RUNTIME_UNAVAILABLE);
      });
    runtimePromise = attempt;
    return attempt;
  }

  /*
   * Readiness for panel lifecycle code, and deliberately NOT part of the
   * click-to-writer path. publish() must stay synchronous from the click so the
   * writer can capture transient navigator.userActivation before its first
   * await; a panel awaits this while rendering instead, so the Publish button
   * only becomes enabled once a composition has genuinely succeeded.
   */
  function ensureReady() {
    return loadRuntime().then(
      function () { return runtimeLoadState === 'ready' && !!activeWriter; },
      function () { return false; }
    );
  }

  /* Both arguments are authority the operator actually saw: the object, and the
   * revision the panel displayed and proved. Neither may be omitted — an
   * unbound publication would publish whatever the archive advanced to after
   * the operator looked at it. */
  function publish(objectId, expectedRevisionId) {
    if (arguments.length !== 2 || !clean(objectId) || !clean(expectedRevisionId)) {
      return Promise.resolve(blocked(ENTRY_ERROR.OBJECT_UNAVAILABLE));
    }
    if (!activeWriter || runtimeLoadState !== 'ready') {
      return Promise.resolve(blocked(ENTRY_ERROR.RUNTIME_UNAVAILABLE));
    }
    if (inFlight) return Promise.resolve(blocked(ENTRY_ERROR.BUSY));
    // Direct call is intentional: the writer captures transient activation
    // synchronously before its first await and owns all permission escalation.
    inFlight = activeWriter.publishLocalRevision(objectId, expectedRevisionId)
      .then(safeResult)
      .catch(function (error) { return blocked(error?.code); })
      .then(function (result) {
        lastResult = result;
        return result;
      })
      .finally(function () { inFlight = null; });
    return inFlight;
  }

  async function publishAutomatically(objectId, expectedRevisionId, admissionLease) {
    if (arguments.length < 2 || !clean(objectId) || !clean(expectedRevisionId)) {
      return blocked(ENTRY_ERROR.OBJECT_UNAVAILABLE);
    }
    try {
      await loadRuntime();
    } catch (_) {
      return blocked(ENTRY_ERROR.RUNTIME_UNAVAILABLE);
    }
    if (!activeWriter || runtimeLoadState !== 'ready' ||
        typeof activeWriter.publishLocalRevisionAutomatically !== 'function') {
      return blocked(ENTRY_ERROR.RUNTIME_UNAVAILABLE);
    }
    if (inFlight) return blocked(ENTRY_ERROR.BUSY);
    inFlight = activeWriter.publishLocalRevisionAutomatically(
      objectId,
      expectedRevisionId,
      admissionLease || null
    )
      .then(safeResult)
      .catch(function (error) { return blocked(error?.code); })
      .then(function (result) {
        lastResult = result;
        return result;
      })
      .finally(function () { inFlight = null; });
    return inFlight;
  }

  async function resolveCanonicalAnchor(objectId) {
    if (!clean(objectId)) throw new Error(ENTRY_ERROR.OBJECT_UNAVAILABLE);
    await loadRuntime();
    if (!activeProjection || !activeLedger) {
      throw new Error(ENTRY_ERROR.RUNTIME_UNAVAILABLE);
    }
    var rows = await archiveAuthority().listWorkbenchRows();
    var matching = (Array.isArray(rows) ? rows : []).filter(function (row) {
      return clean(row?.chatId) === clean(objectId);
    });
    if (matching.length === 0) return null;
    if (matching.length !== 1) throw new Error('canonical-state-contradiction');
    return activeProjection.resolveCanonicalAnchor({
      objectId: objectId,
      ledger: activeLedger
    });
  }

  function diagnose() {
    var folder = H2O.Studio.sync.folder;
    var connected = !!(folder &&
      typeof folder.getConnectedDirectoryHandle === 'function' &&
      folder.getConnectedDirectoryHandle());
    return Object.freeze({
      ok: true,
      verdict: 'local-publication-diagnostic',
      available: runtimeLoadState === 'ready',
      configured: connected,
      folderConnected: connected,
      permissionState: 'not-checked',
      identityReady: 'not-checked',
      ledgerReady: 'not-checked',
      busy: !!inFlight,
      /* Current readiness, not initialization history: any state other than
       * ready is reported as unavailable, and a recovered runtime reports no
       * blocked reason at all. */
      blockedReason: runtimeLoadState !== 'ready'
        ? (runtimeFailureCode || ENTRY_ERROR.RUNTIME_UNAVAILABLE)
        : (!connected ? 'local-publication-directory-handle-missing' : null),
      lastDisposition: lastResult?.ok === true ? lastResult.disposition : null,
      lastErrorCode: lastResult?.ok === false ? lastResult.errorCode : null,
      noNetwork: true
    });
  }

  /* Read-only proof that a remembered publication target is still
   * real. The projection already fails closed on a missing chat or a revision
   * that is not the current head, but that happens inside the writer — this
   * lets the panel reject a stale target BEFORE the writer is entered, so no
   * folder handle, permission prompt or filesystem activity is reached for a
   * target that no longer exists. Reads only; writes nothing. */
  async function validateTarget(target) {
    if (arguments.length !== 1 || !target || typeof target !== 'object') {
      return { ok: false, reason: 'target-invalid' };
    }
    var chatId = clean(target.chatId);
    var snapshotId = clean(target.snapshotId);
    if (!chatId || !snapshotId) return { ok: false, reason: 'target-invalid' };
    var archive;
    try {
      archive = archiveAuthority();
    } catch (_) {
      return { ok: false, reason: ENTRY_ERROR.RUNTIME_UNAVAILABLE };
    }
    try {
      var rows = await archive.listWorkbenchRows();
      var matches = (Array.isArray(rows) ? rows : []).filter(function (row) {
        return clean(row && row.chatId) === chatId;
      });
      if (matches.length !== 1) return { ok: false, reason: 'target-object-missing' };
      var headSnapshotId = clean(matches[0].snapshotId);
      if (!headSnapshotId) return { ok: false, reason: 'target-object-missing' };
      if (headSnapshotId !== snapshotId) {
        return { ok: false, reason: 'target-revision-moved', currentSnapshotId: headSnapshotId };
      }
      var headers = await archive.listSnapshots(chatId);
      var known = (Array.isArray(headers) ? headers : []).some(function (row) {
        return clean(row && row.snapshotId) === snapshotId;
      });
      if (!known) return { ok: false, reason: 'target-revision-missing' };
      return { ok: true, chatId: chatId, snapshotId: snapshotId };
    } catch (_) {
      return { ok: false, reason: 'target-unverifiable' };
    }
  }

  H2O.Studio.sync.localPublication = Object.freeze({
    ensureReady: ensureReady,
    publish: publish,
    publishAutomatically: publishAutomatically,
    resolveCanonicalAnchor: resolveCanonicalAnchor,
    validateTarget: validateTarget,
    diagnose: diagnose
  });

  // Imports and dependency composition only. No store operation, permission
  // query/request, publication plan, ledger stage, or folder write occurs.
  loadRuntime().catch(function () { /* diagnose reports redacted failure */ });
})(globalThis);
