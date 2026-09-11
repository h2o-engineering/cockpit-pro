/* H2O Studio Sync — active-surface one-object automatic reconciliation.
 *
 * This coordinator owns scheduling only. Canonical projection, publication,
 * Receive/admission, Apply, convergence, and their durable recovery state stay
 * in their existing authorities. The lifecycle worker delegates here when an
 * active context owns reconciliation; both contexts compose the same core.
 * No interval, WebDAV, latest.json, object enumeration, or scheduler ledger.
 */
(function (global) {
  'use strict';

  var H2O = global.H2O = global.H2O || {};
  H2O.Studio = H2O.Studio || {};
  H2O.Studio.sync = H2O.Studio.sync || {};
  if (H2O.Studio.sync.objectAutoReconcile) return;

  var CONFIG_KEY = 'h2o:studio:sync:config:v1';
  var CONFIGURED_PEER_RESULT_SCHEMA =
    'h2o.studio.syncConfiguredPeerWriteResult.v1';
  var CANONICAL_MODES = Object.freeze(['manual', 'notify', 'auto']);
  /* MODE_VOCABULARY_ALIGNMENT: `off` is represented explicitly on read so an
   * unconfigured/off record is never reported as `manual`; it is not a
   * selectable or automatic-eligible mode and is never written here. */
  var OFF_MODE = 'off';
  var LOWER_HEX_64 = /^[0-9a-f]{64}$/;
  var CONFIG_MUTATION_LOCK_NAME = CONFIG_KEY + ':write';
  var MUTATION_LOCK_NAME = 'h2o:studio:sync:object-protocol:p01';
  var MAINTENANCE_SUPPRESSION_COMMAND = 'h2o_sync_maintenance_suppression';
  var BACKGROUND_RECONCILE_MESSAGE =
    'h2o:studio:sync:background-reconcile-request:v1';
  var DEBOUNCE_MS = 160;
  var generation = 0;
  var timer = null;
  var inFlight = null;
  var queued = false;
  var destroyed = false;
  var lastResult = null;
  var lastReason = '';
  var unsubscribeMode = null;
  var unsubscribeStores = [];
  var listeners = [];
  var desktopDeliveryReady = null;
  var peerContractReady = null;

  function clean(value) {
    return String(value == null ? '' : value).trim();
  }

  function isTauri() {
    try {
      return typeof global.__TAURI_INTERNALS__ !== 'undefined' ||
        typeof global.__TAURI__ !== 'undefined' ||
        H2O.Studio.platform?.env?.isTauri === true;
    } catch (_) {
      return false;
    }
  }

  function isChromeStudio() {
    try {
      return !isTauri() && global.location?.protocol === 'chrome-extension:' &&
        !!global.chrome?.runtime?.id;
    } catch (_) {
      return false;
    }
  }

  function clearTimer() {
    if (timer === null) return;
    global.clearTimeout(timer);
    timer = null;
  }

  function invalidate() {
    generation += 1;
    clearTimer();
    queued = false;
  }

  /* Governed Desktop maintenance suppression (ephemeral, process-local).
   *
   * A state-integrity campaign launches the governed binary with the exact
   * maintenance token so the runtime can start - to apply a pending migration,
   * for example - while the accepted P01 automatic writer stays incapable of
   * mutating anything. Persisted Sync configuration is never read, written or
   * reinterpreted by this: `auto` keeps its canonical meaning, it simply has
   * no mutation capability for the lifetime of that one process.
   *
   * Resolution is positive-signal and resolved once:
   *   - native seam absent (Chrome Studio, or a build without the command)
   *     -> NOT suppressed, so accepted behaviour is bit-for-bit unchanged;
   *   - command answers -> its answer is authoritative;
   *   - command exists but fails -> SUPPRESSED (fail closed), because we
   *     cannot prove a maintenance window is not in progress.
   */
  var maintenanceSuppressionPromise = null;

  function tauriInvoke() {
    try {
      var internals = global.__TAURI_INTERNALS__;
      return internals && typeof internals.invoke === 'function'
        ? internals.invoke
        : null;
    } catch (_) {
      return null;
    }
  }

  async function readMaintenanceSuppression() {
    if (maintenanceSuppressionPromise) return maintenanceSuppressionPromise;
    maintenanceSuppressionPromise = (async function () {
      if (!isTauri()) return false;
      var invoke = tauriInvoke();
      /* No native seam at all: the concept does not exist for this runtime. */
      if (!invoke) return false;
      try {
        var decision = await invoke(MAINTENANCE_SUPPRESSION_COMMAND, {});
        return decision?.suppressed === true;
      } catch (_) {
        return true;
      }
    })();
    return maintenanceSuppressionPromise;
  }

  /*
   * O1-T19. When the gate SURFACE is not installed at all, this runtime
   * predates T19 and P01 behaves exactly as it did before - that is the
   * compatibility position the contract requires, and studio.html plus the
   * packer prove the surface always ships in a real build, so this branch is
   * unreachable in the product.
   *
   * That is NOT the same as an unreadable STORE. Once the gate is present its
   * four-state observation governs, and an unreadable store refuses: a build
   * condition and a storage failure are different facts.
   */
  async function p01GenerationVerdict() {
    var gate = H2O.Studio && H2O.Studio.sync && H2O.Studio.sync.writerGeneration;
    /* No gate surface AT ALL is a pre-T19 build, and P01 behaves as before. */
    if (!gate) return { permitted: true, reason: null };
    /*
     * O1-B2.1. A gate that is PRESENT but does not answer this name is a broken
     * gate, not an absent one, and the two must not share an answer. Permitting
     * here would be a silent fail-open in the one place built to prevent one.
     */
    if (typeof gate.p01MayMutate !== 'function') {
      return { permitted: false, reason: 'generation-unobserved' };
    }
    try { return await gate.p01MayMutate(); }
    catch (_) { return { permitted: false, reason: 'generation-unobserved' }; }
  }

  async function generationPermitsP01Mutation() {
    var gate = H2O.Studio && H2O.Studio.sync && H2O.Studio.sync.writerGeneration;
    if (!gate) return true;
    if (typeof gate.p01MayMutateBoolean !== 'function') return false;
    return await gate.p01MayMutateBoolean();
  }

  function p01MutationAdmissionSurface() {
    var admission = H2O.Studio && H2O.Studio.sync &&
      H2O.Studio.sync.p01MutationAdmission;
    if (!admission || typeof admission.run !== 'function') {
      throw new Error('p01-mutation-admission-serialization-unavailable');
    }
    return admission;
  }

  async function readAutoAuthority() {
    /* Single centralized gate: every automatic scheduling and mutation path
     * in this module reaches mutation only through here, so suppression here
     * covers bootstrap, focus, visibility, library/index events, publication
     * wake, mode-change, and every coalesced or timer-delayed retry. */
    if (!await generationPermitsP01Mutation()) return false;
    if (await readMaintenanceSuppression()) return false;
    if (isTauri()) {
      var sync = H2O.Studio.sync;
      var owner = typeof sync.getAutomaticModeAuthority === 'function'
        ? sync
        : sync.folder;
      if (!owner || typeof owner.getAutomaticModeAuthority !== 'function') {
        return false;
      }
      var authority = await owner.getAutomaticModeAuthority();
      return !!authority && authority.loaded === true &&
        authority.valid === true && authority.mode === 'auto' &&
        authority.automaticExportEnabled === true;
    }
    if (isChromeStudio()) {
      try {
        var stored = await global.chrome.storage.local.get(CONFIG_KEY);
        var config = stored && stored[CONFIG_KEY];
        return !!config && config.schemaVersion === 1 && config.mode === 'auto';
      } catch (_) {
        return false;
      }
    }
    return false;
  }

  function canonicalChromeConfig(value) {
    var record = value && typeof value === 'object' && !Array.isArray(value)
      ? value
      : null;
    var mode = clean(record?.mode).toLowerCase();
    if (record && record.schemaVersion === 1 && mode === OFF_MODE) {
      return Object.freeze(Object.assign({}, record, { schemaVersion: 1, mode: OFF_MODE }));
    }
    if (!record || record.schemaVersion !== 1 ||
        CANONICAL_MODES.indexOf(mode) < 0) {
      return Object.freeze({ schemaVersion: 1, mode: 'manual' });
    }
    return Object.freeze(Object.assign({}, record, { schemaVersion: 1, mode: mode }));
  }

  function configuredPeerError(code, details) {
    var error = new Error(code);
    error.code = code;
    if (details && typeof details === 'object') {
      Object.keys(details).forEach(function (key) { error[key] = details[key]; });
    }
    return error;
  }

  async function peerContract() {
    var installed = H2O.Studio.sync?.p02;
    if (typeof installed?.strictSyncIdentifier === 'function' &&
        typeof installed?.writerKeyHex === 'function') {
      return installed;
    }
    var attempt = peerContractReady;
    if (!attempt) {
      attempt = import('../browser-adapters/chrome/sync-contract-v2.mjs')
        .then(function (module) {
          if (typeof module?.strictSyncIdentifier !== 'function' ||
              typeof module?.writerKeyHex !== 'function') {
            throw configuredPeerError('canonical-sync-peer-contract-unavailable');
          }
          return module;
        });
      peerContractReady = attempt;
    }
    try {
      return await attempt;
    } catch (error) {
      if (peerContractReady === attempt) peerContractReady = null;
      throw error;
    }
  }

  async function localChromeSyncPeerId(contract) {
    var identityOwner = H2O.Studio.identity;
    if (!identityOwner || typeof identityOwner.whenSyncReady !== 'function') {
      throw configuredPeerError('canonical-sync-local-identity-unavailable');
    }
    var identity;
    try {
      identity = await identityOwner.whenSyncReady();
    } catch (_) {
      throw configuredPeerError('canonical-sync-local-identity-unavailable');
    }
    if (!contract.strictSyncIdentifier(identity?.syncPeerId)) {
      throw configuredPeerError('canonical-sync-local-identity-unavailable');
    }
    return identity.syncPeerId;
  }

  async function canonicalConfiguredPeers(value) {
    if (!Array.isArray(value)) throw new Error('canonical-sync-configured-peers-invalid');
    var contract = await peerContract();
    var localSyncPeerId = await localChromeSyncPeerId(contract);
    var peerToWriter = new Map();
    var writerToPeer = new Map();
    var accepted = [];
    for (var index = 0; index < value.length; index += 1) {
      var row = value[index];
      if (!row || typeof row !== 'object' || Array.isArray(row) ||
          Object.keys(row).sort().join(',') !== 'syncPeerId,writerKey' ||
          !contract.strictSyncIdentifier(row.syncPeerId)) {
        throw configuredPeerError('canonical-sync-configured-peer-invalid');
      }
      if (typeof row.writerKey !== 'string' ||
          !LOWER_HEX_64.test(row.writerKey)) {
        throw configuredPeerError('canonical-sync-configured-writer-key-invalid');
      }
      if (row.syncPeerId === localSyncPeerId) {
        throw configuredPeerError('canonical-sync-configured-peer-self');
      }
      if (peerToWriter.has(row.syncPeerId) || writerToPeer.has(row.writerKey)) {
        var exactDuplicate = peerToWriter.get(row.syncPeerId) === row.writerKey &&
          writerToPeer.get(row.writerKey) === row.syncPeerId;
        throw configuredPeerError(exactDuplicate
          ? 'canonical-sync-configured-peer-duplicate'
          : 'canonical-sync-configured-peer-ambiguous');
      }
      var derived;
      try {
        derived = await contract.writerKeyHex(row.syncPeerId, global.crypto);
      } catch (_) {
        throw configuredPeerError('canonical-sync-peer-contract-unavailable');
      }
      if (derived !== row.writerKey) {
        throw configuredPeerError('canonical-sync-configured-writer-key-mismatch');
      }
      peerToWriter.set(row.syncPeerId, row.writerKey);
      writerToPeer.set(row.writerKey, row.syncPeerId);
      accepted.push({ syncPeerId: row.syncPeerId, writerKey: row.writerKey });
    }
    return accepted;
  }

  async function getChromeCanonicalConfig() {
    if (!isChromeStudio() || typeof global.chrome?.storage?.local?.get !== 'function') {
      throw new Error('canonical-sync-mode-authority-unavailable');
    }
    var stored = await global.chrome.storage.local.get(CONFIG_KEY);
    return canonicalChromeConfig(stored && stored[CONFIG_KEY]);
  }

  function proposedChromeCanonicalConfig(current, patch) {
    var hasMode = !!patch && Object.prototype.hasOwnProperty.call(patch, 'mode');
    var requestedMode = hasMode ? clean(patch.mode).toLowerCase() : '';
    if (!hasMode) requestedMode = current.mode;
    if (CANONICAL_MODES.indexOf(requestedMode) < 0) {
      throw new Error('canonical-sync-mode-invalid');
    }
    var next = Object.assign({}, current, {
      schemaVersion: 1,
      mode: requestedMode,
      updatedAt: new Date().toISOString()
    });
    if (patch && Object.prototype.hasOwnProperty.call(patch, 'configuredPeers')) {
      next.configuredPeers = patch.configuredPeers;
    }
    return next;
  }

  async function validateFinalChromeCanonicalConfig(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
        value.schemaVersion !== 1 || CANONICAL_MODES.indexOf(value.mode) < 0) {
      throw configuredPeerError('canonical-sync-config-final-invalid');
    }
    var accepted = Object.assign({}, value, { schemaVersion: 1, mode: value.mode });
    /* Validate the COMPLETE final candidate, including a roster retained by a
     * mode-only patch. No owner may silently preserve and re-persist malformed
     * or ambiguous configured-peer authority. */
    if (Object.prototype.hasOwnProperty.call(accepted, 'configuredPeers')) {
      accepted.configuredPeers = await canonicalConfiguredPeers(accepted.configuredPeers);
    }
    return accepted;
  }

  async function withCanonicalConfigMutation(callback) {
    var locks = global.navigator?.locks;
    if (!isChromeStudio() || !locks || typeof locks.request !== 'function') {
      throw configuredPeerError(
        'canonical-sync-config-mutation-serialization-unavailable');
    }
    return locks.request(
      CONFIG_MUTATION_LOCK_NAME,
      { mode: 'exclusive' },
      callback
    );
  }

  /* The sole Chrome writer to CONFIG_KEY. The Web Lock is origin-scoped, so
   * separate extension-owned Studio pages serialize through the same boundary.
   * Operation-specific authority decisions consume the in-lock snapshot; the
   * lock remains held through the optional write and exact read-back. */
  async function mutateCanonicalSyncConfig(operation) {
    if (!isChromeStudio() ||
        typeof global.chrome?.storage?.local?.get !== 'function' ||
        typeof global.chrome?.storage?.local?.set !== 'function' ||
        typeof operation !== 'function') {
      throw configuredPeerError('canonical-sync-mode-authority-unavailable');
    }
    return withCanonicalConfigMutation(async function () {
      var current;
      try {
        current = await getChromeCanonicalConfig();
      } catch (_) {
        throw configuredPeerError('canonical-sync-config-persistence-failed', {
          storageWrites: 0
        });
      }
      var decision = await operation(current);
      if (!decision || (decision.action !== 'write' && decision.action !== 'none')) {
        throw configuredPeerError('canonical-sync-config-mutation-invalid');
      }
      if (decision.action === 'none') {
        var unchanged;
        try {
          unchanged = await getChromeCanonicalConfig();
        } catch (_) {
          throw configuredPeerError('canonical-sync-config-readback-mismatch', {
            storageWrites: 0
          });
        }
        if (!sameJsonValue(unchanged, current)) {
          throw configuredPeerError('canonical-sync-config-readback-mismatch', {
            storageWrites: 0
          });
        }
        return Object.freeze({
          decision: decision,
          current: current,
          readback: unchanged,
          storageWrites: 0
        });
      }

      var next = await validateFinalChromeCanonicalConfig(decision.next);
      var item = {};
      item[CONFIG_KEY] = next;
      try {
        await global.chrome.storage.local.set(item);
      } catch (_) {
        throw configuredPeerError('canonical-sync-config-persistence-failed', {
          storageWrites: 1
        });
      }
      var readback;
      try {
        readback = await getChromeCanonicalConfig();
      } catch (_) {
        throw configuredPeerError('canonical-sync-config-readback-mismatch', {
          storageWrites: 1
        });
      }
      if (!sameJsonValue(readback, next)) {
        throw configuredPeerError('canonical-sync-config-readback-mismatch', {
          storageWrites: 1
        });
      }
      return Object.freeze({
        decision: decision,
        current: current,
        readback: readback,
        storageWrites: 1
      });
    });
  }

  async function setChromeCanonicalConfig(patch) {
    var mutation = await mutateCanonicalSyncConfig(async function (current) {
      return Object.freeze({
        action: 'write',
        next: proposedChromeCanonicalConfig(current, patch)
      });
    });
    return mutation.readback;
  }

  function configuredPeerResult(outcome, details) {
    return Object.freeze(Object.assign({
      schema: CONFIGURED_PEER_RESULT_SCHEMA,
      ok: outcome === 'configured' || outcome === 'already-configured',
      outcome: outcome,
      storageWrites: 0,
      verified: false
    }, details || {}));
  }

  function sameJsonValue(left, right) {
    if (left === right) return true;
    if (Array.isArray(left) || Array.isArray(right)) {
      if (!Array.isArray(left) || !Array.isArray(right) ||
          left.length !== right.length) return false;
      for (var index = 0; index < left.length; index += 1) {
        if (!sameJsonValue(left[index], right[index])) return false;
      }
      return true;
    }
    if (!left || !right || typeof left !== 'object' || typeof right !== 'object') {
      return false;
    }
    var leftKeys = Object.keys(left).sort();
    var rightKeys = Object.keys(right).sort();
    if (leftKeys.join(',') !== rightKeys.join(',')) return false;
    for (var keyIndex = 0; keyIndex < leftKeys.length; keyIndex += 1) {
      var key = leftKeys[keyIndex];
      if (!sameJsonValue(left[key], right[key])) return false;
    }
    return true;
  }

  function configuredPeerOutcome(error) {
    var code = clean(error?.code || error?.message);
    if (code === 'canonical-sync-configured-peer-invalid') return 'invalid-peer';
    if (code === 'canonical-sync-configured-writer-key-invalid') {
      return 'invalid-writer-key';
    }
    if (code === 'canonical-sync-configured-writer-key-mismatch') {
      return 'writer-key-mismatch';
    }
    if (code === 'canonical-sync-configured-peer-self') return 'self-peer';
    if (code === 'canonical-sync-local-identity-unavailable') {
      return 'local-identity-unavailable';
    }
    if (code === 'canonical-sync-configured-peer-duplicate' ||
        code === 'canonical-sync-configured-peer-ambiguous') {
      return 'authority-conflict';
    }
    return 'authority-unavailable';
  }

  async function setTrustedDesktopPeer(candidate) {
    var exactCandidate = candidate && typeof candidate === 'object' &&
      !Array.isArray(candidate) &&
      Object.keys(candidate).sort().join(',') === 'syncPeerId,writerKey';
    var row = exactCandidate
      ? { syncPeerId: candidate.syncPeerId, writerKey: candidate.writerKey }
      : { syncPeerId: undefined, writerKey: undefined };
    var accepted;
    try {
      accepted = await canonicalConfiguredPeers([row]);
    } catch (error) {
      return configuredPeerResult(configuredPeerOutcome(error));
    }
    var mutation;
    try {
      mutation = await mutateCanonicalSyncConfig(async function (current) {
        if (current.mode === 'auto') {
          return Object.freeze({ action: 'none', outcome: 'authority-conflict' });
        }
        var existing = [];
        if (Object.prototype.hasOwnProperty.call(current, 'configuredPeers')) {
          try {
            existing = await canonicalConfiguredPeers(current.configuredPeers);
          } catch (_) {
            return Object.freeze({ action: 'none', outcome: 'authority-conflict' });
          }
        }
        if (existing.length > 0) {
          return Object.freeze({
            action: 'none',
            outcome: existing.length === 1 && sameJsonValue(existing[0], accepted[0])
              ? 'already-configured'
              : 'authority-conflict'
          });
        }
        return Object.freeze({
          action: 'write',
          outcome: 'configured',
          next: proposedChromeCanonicalConfig(current, {
            configuredPeers: accepted
          })
        });
      });
    } catch (error) {
      var code = clean(error?.code || error?.message);
      var storageWrites = Number.isSafeInteger(error?.storageWrites)
        ? error.storageWrites : 0;
      if (code === 'canonical-sync-config-readback-mismatch') {
        return configuredPeerResult('readback-mismatch', { storageWrites: storageWrites });
      }
      if (code === 'canonical-sync-config-persistence-failed' ||
          code === 'canonical-sync-mode-authority-unavailable') {
        return configuredPeerResult('persistence-failed', { storageWrites: storageWrites });
      }
      return configuredPeerResult(configuredPeerOutcome(error), {
        storageWrites: storageWrites
      });
    }
    if (mutation.decision.outcome === 'authority-conflict') {
      return configuredPeerResult('authority-conflict');
    }
    if (mutation.decision.outcome === 'already-configured') {
      return configuredPeerResult('already-configured', {
        verified: true,
        effect: 'none'
      });
    }
    return configuredPeerResult('configured', {
      storageWrites: mutation.storageWrites,
      verified: true,
      effect: 'written'
    });
  }

  async function generationMayMutate(expectedGeneration) {
    return !destroyed && expectedGeneration === generation &&
      await readAutoAuthority() === true && expectedGeneration === generation;
  }

  function currentTarget() {
    try {
      var target = typeof H2O.Studio.getPublicationTarget === 'function'
        ? H2O.Studio.getPublicationTarget()
        : null;
      var objectId = clean(target?.chatId || target?.objectId);
      return objectId ? Object.freeze({ objectId: objectId }) : null;
    } catch (_) {
      return null;
    }
  }

  function reconcileCore() {
    var core = global.H2OSyncLinearReconcileCore;
    if (!core || typeof core.reconcileOneObject !== 'function') {
      throw new Error('automatic-runtime-unavailable');
    }
    return core;
  }

  async function withMutationOwnership(callback) {
    if (!isChromeStudio()) return callback();
    var locks = global.navigator && global.navigator.locks;
    if (!locks || typeof locks.request !== 'function') {
      throw new Error('automatic-cross-context-ownership-unavailable');
    }
    return locks.request(
      MUTATION_LOCK_NAME,
      { mode: 'exclusive' },
      callback
    );
  }

  function runtimeError(code) {
    var error = new Error(code);
    error.code = code;
    return error;
  }

  function loadDesktopScript(relativePath, expected, errorCodes) {
    var codes = errorCodes || {};
    var loadFailed = clean(codes.loadFailed) || 'automatic-runtime-unavailable';
    var unavailableAfterLoad = clean(codes.unavailableAfterLoad) ||
      'automatic-runtime-unavailable';
    if (expected()) return Promise.resolve();
    return new Promise(function (resolve, reject) {
      var script = global.document?.createElement?.('script');
      if (!script) { reject(runtimeError(loadFailed)); return; }
      /* The Reader host projects saved-chat identity into the pathname with
       * history.replaceState(`/c/<id>`). A document-relative `./sync/...`
       * URL then resolves under `/c/` even though Desktop Sync assets are
       * packaged at the application root. WKWebView can report that fallback
       * response as loaded without executing this module, leaving the public
       * runtime absent. Keep lazy Desktop modules anchored to the governed
       * root asset namespace regardless of the current Studio route. */
      script.src = '/sync/' + relativePath;
      script.async = false;
      script.onload = function () {
        if (expected()) resolve();
        else reject(runtimeError(unavailableAfterLoad));
      };
      script.onerror = function () { reject(runtimeError(loadFailed)); };
      var parent = global.document.head || global.document.documentElement;
      if (!parent || typeof parent.appendChild !== 'function') {
        reject(runtimeError(loadFailed));
        return;
      }
      parent.appendChild(script);
    });
  }

  function usableDesktopDeliveryRuntime(delivery) {
    return !!delivery &&
      typeof delivery.rehydrateDestinationAuthorization === 'function' &&
      typeof delivery.destinationAuthorizationSnapshot === 'function';
  }

  async function ensureDesktopDeliveryRuntime() {
    var attempt = desktopDeliveryReady;
    if (!attempt) {
      attempt = loadDesktopScript(
        'browser-delivery-producer.tauri.js',
        function () {
          return usableDesktopDeliveryRuntime(H2O.Desktop?.SyncObjectDelivery);
        },
        {
          loadFailed: 'automatic-delivery-script-load-failed',
          unavailableAfterLoad: 'automatic-delivery-runtime-unavailable-after-load'
        }
      ).then(function () {
        var delivery = H2O.Desktop?.SyncObjectDelivery;
        if (!usableDesktopDeliveryRuntime(delivery)) {
          throw runtimeError('automatic-delivery-runtime-unavailable-after-load');
        }
        return delivery;
      });
      desktopDeliveryReady = attempt;
    }
    try {
      var delivery = await attempt;
      var current = H2O.Desktop?.SyncObjectDelivery;
      if (current !== delivery || !usableDesktopDeliveryRuntime(current)) {
        throw runtimeError('automatic-delivery-runtime-unavailable-after-load');
      }
      return current;
    } catch (error) {
      if (desktopDeliveryReady === attempt) desktopDeliveryReady = null;
      throw error;
    }
  }

  async function ensureDesktopRuntime() {
    if (H2O.Desktop?.Sync?.round2aReady) {
      await H2O.Desktop.Sync.round2aReady;
    } else {
      await loadDesktopScript('sync-object-projection.tauri.js', function () {
        return !!H2O.Desktop?.SyncObjectProjection;
      });
      await loadDesktopScript('sync-object-runtime.tauri.js', function () {
        return !!H2O.Desktop?.SyncObjectRuntime;
      });
    }
    var delivery = await ensureDesktopDeliveryRuntime();
    await delivery.rehydrateDestinationAuthorization();
    var authorization = delivery.destinationAuthorizationSnapshot();
    if (!authorization || authorization.valid !== true ||
        authorization.status !== 'authorized') {
      throw new Error(
        clean(authorization?.status) || 'automatic-delivery-authorization-unavailable'
      );
    }
  }

  async function desktopAnchor(objectId) {
    var delivery = H2O.Desktop.SyncObjectDelivery;
    var lineage = await delivery.readLineage(objectId);
    var localTip = lineage?.ok === true && lineage.currentRevisionId
      ? {
        revisionId: lineage.currentRevisionId,
        revisionBlobSha256Hex: lineage.currentRevisionBlobSha256Hex
      }
      : null;
    return H2O.Desktop.SyncObjectRuntime.resolveCanonicalAnchor(objectId, {
      localPublicationTip: localTip
    });
  }

  async function reconcileDesktop(expectedGeneration) {
    await ensureDesktopRuntime();
    var delivery = H2O.Desktop.SyncObjectDelivery;
    var runtime = H2O.Desktop.SyncObjectRuntime;
    var target = currentTarget();
    var objectId = target?.objectId || null;

    return reconcileCore().reconcileOneObject({
      objectId: objectId,
      mayMutate: function () {
        return generationMayMutate(expectedGeneration);
      },
      receive: function () { return delivery.receiveLocalPublication(); },
      apply: function (selectedObjectId) {
        return runtime.applyNextAdmittedLocalRevision(selectedObjectId);
      },
      resolveAnchor: desktopAnchor,
      publish: function (selectedObjectId) {
        return delivery.prepareLocalBrowserDelivery(selectedObjectId);
      }
    });
  }

  async function reconcileChrome(expectedGeneration, admissionLease) {
    var delivery = H2O.Studio.sync.item9Delivery;
    var apply = H2O.Studio.sync.revisionApply;
    var publication = H2O.Studio.sync.localPublication;
    if (!delivery || !apply || !publication ||
        typeof delivery.deliverFromSyncFolderAutomatically !== 'function' ||
        typeof apply.applyNextAdmittedRevision !== 'function' ||
        typeof publication.resolveCanonicalAnchor !== 'function' ||
        typeof publication.publishAutomatically !== 'function') {
      throw new Error('automatic-runtime-unavailable');
    }
    var target = currentTarget();
    var objectId = target?.objectId || null;
    return reconcileCore().reconcileOneObject({
      objectId: objectId,
      mayMutate: function () {
        return generationMayMutate(expectedGeneration);
      },
      allowedReceiveAbsentCodes: new Set([
        'round2-item9-delivery-file-missing'
      ]),
      receive: function () {
        return delivery.deliverFromSyncFolderAutomatically();
      },
      apply: function (selectedObjectId) {
        return apply.applyNextAdmittedRevision(selectedObjectId);
      },
      resolveAnchor: function (selectedObjectId) {
        return publication.resolveCanonicalAnchor(selectedObjectId);
      },
      publish: function (selectedObjectId, revisionId) {
        return publication.publishAutomatically(
          selectedObjectId,
          revisionId,
          admissionLease
        );
      }
    });
  }

  async function run(reason, expectedGeneration) {
    if (!await generationMayMutate(expectedGeneration)) {
      return Object.freeze({ ok: true, verdict: 'automatic-disabled' });
    }
    var result;
    if (isTauri()) {
      result = await withMutationOwnership(function () {
        return reconcileDesktop(expectedGeneration);
      });
    } else {
      /* Canonical lock order: admission(shared) before the existing P01
       * object-protocol(exclusive) lock. Standdown never takes the latter. */
      result = await p01MutationAdmissionSurface().run({
        label: 'chrome-foreground-auto-reconcile',
        generationCheck: p01GenerationVerdict,
        operation: function (admissionLease) {
          return withMutationOwnership(function () {
            return reconcileChrome(expectedGeneration, admissionLease);
          });
        }
      });
    }
    return Object.freeze({ ok: true, reason: clean(reason), ...result });
  }

  function begin(reason, expectedGeneration) {
    if (destroyed || expectedGeneration !== generation) return;
    if (inFlight) { queued = true; return; }
    inFlight = run(reason, expectedGeneration)
      .then(function (result) { lastResult = result; return result; })
      .catch(function (error) {
        lastResult = Object.freeze({
          ok: false,
          verdict: 'blocked',
          errorCode: clean(error?.code || error?.message) || 'automatic-reconcile-failed'
        });
        return lastResult;
      })
      .finally(function () {
        inFlight = null;
        if (queued && !destroyed && expectedGeneration === generation) {
          queued = false;
          scheduleReconcile('coalesced');
        }
      });
  }

  function scheduleReconcile(reason) {
    if (destroyed) return false;
    lastReason = clean(reason) || 'unspecified';
    if (inFlight) { queued = true; return true; }
    clearTimer();
    var expectedGeneration = generation;
    timer = global.setTimeout(function () {
      timer = null;
      begin(lastReason, expectedGeneration);
    }, DEBOUNCE_MS);
    return true;
  }

  function addListener(target, eventName, listener) {
    if (!target?.addEventListener) return;
    target.addEventListener(eventName, listener);
    listeners.push(function () { target.removeEventListener(eventName, listener); });
  }

  function wireStoreSignals() {
    if (!isTauri()) return;
    ['chats', 'snapshots', 'turns'].forEach(function (name) {
      var store = H2O.Studio.store?.[name];
      if (!store || typeof store.subscribe !== 'function') return;
      var unsubscribe = store.subscribe(function () {
        scheduleReconcile('canonical-store:' + name);
      });
      if (typeof unsubscribe === 'function') unsubscribeStores.push(unsubscribe);
    });
  }

  function wireDesktopPublicationWake() {
    if (!isTauri()) return;
    var folder = H2O.Studio.sync?.folder;
    if (!folder || typeof folder.subscribe !== 'function') return;
    var unsubscribe = folder.subscribe(function (event) {
      if (event?.kind !== 'object-local-publication-available') return;
      scheduleReconcile('local-publication-folder-change');
    });
    if (typeof unsubscribe === 'function') unsubscribeStores.push(unsubscribe);
  }

  function authorityChanged(authority) {
    var automatic = isTauri()
      ? !!authority && authority.loaded === true && authority.valid === true &&
        authority.mode === 'auto' && authority.automaticExportEnabled === true
      : !!authority && authority.schemaVersion === 1 && authority.mode === 'auto';
    invalidate();
    if (automatic) scheduleReconcile('mode-auto');
  }

  function wireAuthority() {
    if (isTauri()) {
      var sync = H2O.Studio.sync;
      var owner = typeof sync.subscribeAutomaticModeAuthority === 'function'
        ? sync
        : sync.folder;
      if (owner && typeof owner.subscribeAutomaticModeAuthority === 'function') {
        unsubscribeMode = owner.subscribeAutomaticModeAuthority(authorityChanged);
      }
      return;
    }
    if (isChromeStudio() && global.chrome?.storage?.onChanged?.addListener) {
      var listener = function (changes, area) {
        if (area === 'local' && changes &&
            Object.prototype.hasOwnProperty.call(changes, CONFIG_KEY)) {
          authorityChanged(changes[CONFIG_KEY].newValue || null);
        }
      };
      global.chrome.storage.onChanged.addListener(listener);
      listeners.push(function () {
        global.chrome.storage.onChanged.removeListener(listener);
      });
    }
  }

  function wireBackgroundDelegation() {
    if (!isChromeStudio() || !global.chrome?.runtime?.onMessage?.addListener) {
      return;
    }
    var listener = function (message, sender, sendResponse) {
      if (!message || message.type !== BACKGROUND_RECONCILE_MESSAGE) return;
      scheduleReconcile('background-delegated:' + clean(message.reason));
      try {
        sendResponse({ ok: true, accepted: true });
      } catch (_) { /* sender may have already gone away */ }
      return false;
    };
    global.chrome.runtime.onMessage.addListener(listener);
    listeners.push(function () {
      global.chrome.runtime.onMessage.removeListener(listener);
    });
  }

  function teardown() {
    if (destroyed) return Promise.resolve();
    var draining = inFlight;
    destroyed = true;
    invalidate();
    if (typeof unsubscribeMode === 'function') unsubscribeMode();
    unsubscribeMode = null;
    unsubscribeStores.splice(0).forEach(function (unsubscribe) {
      try { unsubscribe(); } catch (_) { /* teardown only */ }
    });
    listeners.splice(0).forEach(function (remove) {
      try { remove(); } catch (_) { /* teardown only */ }
    });
    return draining
      ? Promise.resolve(draining).then(function () {}, function () {})
      : Promise.resolve();
  }

  function diagnose() {
    return Object.freeze({
      ok: true,
      verdict: 'object-protocol-auto-reconcile-diagnostic',
      platform: isTauri() ? 'desktop' : (isChromeStudio() ? 'chrome' : 'other'),
      generation: generation,
      scheduled: timer !== null,
      inFlight: !!inFlight,
      queued: queued,
      destroyed: destroyed,
      lastReason: lastReason,
      lastResult: lastResult,
      canonicalAuthorityKey: CONFIG_KEY,
      mutationLockName: MUTATION_LOCK_NAME,
      configMutationLockName: CONFIG_MUTATION_LOCK_NAME,
      latestJsonUsed: false,
      webdavRequired: false,
      backgroundAlarmUsed: isChromeStudio()
    });
  }

  H2O.Studio.sync.objectAutoReconcile = Object.freeze({
    scheduleReconcile: scheduleReconcile,
    teardown: teardown,
    diagnose: diagnose,
    __test: Object.freeze({
      invalidate: invalidate,
      run: run,
      readAutoAuthority: readAutoAuthority,
      readMaintenanceSuppression: readMaintenanceSuppression
    })
  });

  /* Chrome composition of the same canonical config API that Desktop exposes
   * through folder-sync.tauri.js. The object reconciler already owns the MV3
   * read/listen seam for CONFIG_KEY; this adds the missing governed product
   * writer without interpreting the older folder-import Auto Sync boolean. */
  if (isChromeStudio()) {
    if (typeof H2O.Studio.sync.getConfig !== 'function') {
      H2O.Studio.sync.getConfig = getChromeCanonicalConfig;
    }
    if (typeof H2O.Studio.sync.setConfig !== 'function') {
      H2O.Studio.sync.setConfig = setChromeCanonicalConfig;
    }
    if (typeof H2O.Studio.sync.setTrustedDesktopPeer !== 'function') {
      H2O.Studio.sync.setTrustedDesktopPeer = setTrustedDesktopPeer;
    }
  }

  function bootstrap() {
    if (!isTauri() && !isChromeStudio()) return;
    wireAuthority();
    wireBackgroundDelegation();
    wireStoreSignals();
    wireDesktopPublicationWake();
    ['focus', 'evt:h2o:studio:reader-refresh-requested',
      'evt:h2o:library-index:updated', 'h2o:library-index:updated',
      'evt:h2o:library:cross-surface-sync'].forEach(function (eventName) {
      addListener(global, eventName, function () {
        scheduleReconcile('event:' + eventName);
      });
    });
    addListener(global.document, 'visibilitychange', function () {
      if (global.document.visibilityState === 'visible') {
        scheduleReconcile('visibility');
      }
    });
    addListener(global, 'pagehide', teardown);
    readAutoAuthority().then(function (automatic) {
      if (automatic) scheduleReconcile('bootstrap');
    }).catch(function () { /* fail closed */ });
  }

  if (global.document?.readyState === 'loading') {
    global.document.addEventListener('DOMContentLoaded', bootstrap, { once: true });
  } else {
    global.setTimeout(bootstrap, 0);
  }
})(globalThis);
