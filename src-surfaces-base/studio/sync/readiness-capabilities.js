/* Sync Settings M2 — read-only readiness/capability derivation.
 *
 * This module owns no runtime or persistence state. It accepts facts from the
 * existing platform, folder, browser-delivery, WebDAV and automation owners,
 * derives truthful domain-local capability snapshots, and deep-freezes the
 * result. WebDAV can therefore be blocked without changing Local Folder or
 * Browser Delivery, and a configured automation flag is never mistaken for an
 * effective scheduler.
 */
(function (global) {
  'use strict';

  var H2O = global.H2O = global.H2O || {};
  H2O.Studio = H2O.Studio || {};
  H2O.Studio.sync = H2O.Studio.sync || {};

  function object(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  }

  function clean(value) {
    return String(value == null ? '' : value).trim();
  }

  function deepFreeze(value) {
    if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
    Object.keys(value).forEach(function (key) { deepFreeze(value[key]); });
    return Object.freeze(value);
  }

  function operation(value) {
    var source = object(value);
    var state = clean(source.state || 'idle');
    if (['idle', 'in-flight', 'success', 'blocked', 'error'].indexOf(state) < 0) state = 'idle';
    return {
      state: state,
      reason: clean(source.reason),
      lastActivity: clean(source.lastActivity) || null,
    };
  }

  function foundation(value) {
    var source = object(value);
    var storage = object(source.storage);
    var identity = object(source.identity);
    var backend = clean(storage.backend || 'unavailable');
    var storageReady = storage.ready === true &&
      (backend === 'sqlite' || backend === 'chrome');
    var identityRequired = identity.required !== false;
    var identityReady = !identityRequired ||
      (identity.ready === true && identity.canonical === true);
    return {
      uiMounted: source.uiMounted === true,
      runtimeLoaded: source.runtimeLoaded === true,
      persistentBackend: {
        ready: storageReady,
        backend: backend,
        status: clean(storage.status || (storageReady ? 'ready' : 'unavailable')),
      },
      canonicalAuthority: {
        required: identityRequired,
        ready: identity.ready === true,
        canonical: identity.canonical === true,
        status: clean(identity.status || (identityRequired ? 'unavailable' : 'not-applicable')),
      },
      ready: source.uiMounted === true && source.runtimeLoaded === true &&
        storageReady && identityReady,
    };
  }

  function localFolder(value, base) {
    var source = object(value);
    var configValid = source.configValid === true;
    var authorizationValid = source.authorizationValid === true;
    var backendReady = base.persistentBackend.ready === true;
    var reason = '';
    if (!backendReady) reason = 'backend-not-ready';
    else if (!configValid) reason = 'folder-not-configured';
    else if (!authorizationValid) reason = clean(source.authorizationStatus) || 'authorization-not-checked';
    return {
      configured: configValid,
      configValid: configValid,
      authorizationValid: authorizationValid,
      authorizationStatus: clean(source.authorizationStatus || 'not-checked'),
      available: backendReady && configValid,
      ready: backendReady && configValid && authorizationValid,
      reason: reason,
      operation: operation(source.operation),
    };
  }

  function normalizePermission(value) {
    var permission = clean(value || 'not-checked').toLowerCase();
    if (permission === 'unknown') return 'unavailable';
    if (['not-checked', 'granted', 'prompt', 'denied', 'unavailable'].indexOf(permission) < 0) {
      return 'unavailable';
    }
    return permission;
  }

  function browserDelivery(value) {
    var source = object(value);
    var handlePresent = source.handlePresent === true;
    var permission = normalizePermission(source.permission);
    var publishingPermission = normalizePermission(source.publishingPermission);
    var livePermission = source.livePermission !== false;
    var deliveryAvailable = source.deliveryAvailable !== false;
    var reason = '';
    if (!handlePresent) reason = 'folder-not-connected';
    else if (permission !== 'granted') reason = permission === 'prompt'
      ? 'permission-required'
      : (permission === 'not-checked' ? 'permission-not-checked' : 'permission-' + permission);
    else if (!deliveryAvailable) reason = clean(source.reason) || 'delivery-unavailable';
    return {
      handlePresent: handlePresent,
      connected: handlePresent,
      permission: permission,
      permissionSource: livePermission ? 'live-query'
        : (handlePresent ? 'unavailable' : 'not-checked'),
      publishingPermission: publishingPermission,
      publishingAuthorized: handlePresent && publishingPermission === 'granted',
      publishingPermissionSource: livePermission ? 'live-query'
        : (handlePresent ? 'unavailable' : 'not-checked'),
      deliveryAvailable: deliveryAvailable,
      ready: handlePresent && permission === 'granted' && deliveryAvailable,
      reason: reason,
      operation: operation(source.operation),
    };
  }

  function webdav(value) {
    var source = object(value);
    var descriptorValid = source.descriptorValid === true;
    var credentialsReady = source.credentialsReady === true;
    var reachabilityReady = source.reachabilityReady === true;
    var reason = '';
    if (!descriptorValid) reason = clean(source.reason) || 'descriptor-not-ready';
    else if (!credentialsReady) reason = 'credentials-not-ready';
    else if (!reachabilityReady) reason = clean(source.reason) || 'reachability-not-ready';
    return {
      configured: descriptorValid && credentialsReady,
      descriptorValid: descriptorValid,
      credentialsReady: credentialsReady,
      reachabilityReady: reachabilityReady,
      ready: descriptorValid && credentialsReady && reachabilityReady,
      reason: reason,
      operation: operation(source.operation),
    };
  }

  function automationCapability(value) {
    var source = object(value);
    var configured = source.configured === true;
    var prerequisitesSatisfied = source.prerequisitesSatisfied === true;
    var schedulerActive = source.schedulerActive === true;
    var effective = configured && prerequisitesSatisfied && schedulerActive;
    var reason = '';
    if (!configured) reason = clean(source.reason) || 'not-configured';
    else if (!prerequisitesSatisfied) reason = clean(source.reason) || 'prerequisites-not-satisfied';
    else if (!schedulerActive) reason = clean(source.reason) || 'scheduler-not-running';
    return {
      configured: configured,
      prerequisitesSatisfied: prerequisitesSatisfied,
      schedulerActive: schedulerActive,
      effective: effective,
      reason: reason,
      lastActivity: clean(source.lastActivity) || null,
      operation: operation(source.operation),
    };
  }

  function automation(value) {
    var source = object(value);
    var out = {};
    Object.keys(source).sort().forEach(function (key) {
      out[key] = automationCapability(source[key]);
    });
    return out;
  }

  function archiveRecovery(value) {
    var source = object(value);
    return {
      available: source.available === true,
      ready: source.ready === true,
      reason: clean(source.reason),
      operation: operation(source.operation),
    };
  }

  function deriveSnapshot(input) {
    var source = object(input);
    var base = foundation(source.foundation);
    return deepFreeze({
      schema: 'h2o.studio.sync.readiness.v1',
      foundation: base,
      localFolder: localFolder(source.localFolder, base),
      browserDelivery: browserDelivery(source.browserDelivery),
      webdav: webdav(source.webdav),
      automation: automation(source.automation),
      archiveRecovery: archiveRecovery(source.archiveRecovery),
    });
  }

  H2O.Studio.sync.readiness = Object.freeze({
    schema: 'h2o.studio.sync.readiness.v1',
    deriveSnapshot: deriveSnapshot,
    normalizePermission: normalizePermission,
  });
})(typeof window !== 'undefined' ? window : globalThis);
