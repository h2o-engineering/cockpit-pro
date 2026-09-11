/* Chrome Studio — shared P01 mutation admission facade.
 *
 * Loading is inert. The production ESM owner is imported lazily only when a
 * Chrome P01 writer needs admission or a future standdown owner begins a hold.
 * Desktop/Tauri never receives this facade.
 */
(function installChromeP01MutationAdmission(global) {
  'use strict';

  var H2O = global.H2O = global.H2O || {};
  H2O.Studio = H2O.Studio || {};
  H2O.Studio.sync = H2O.Studio.sync || {};

  if (!global.chrome?.runtime?.id || global.__TAURI_INTERNALS__) return;

  var MODULE_PATH =
    'surfaces/studio/browser-adapters/chrome/' +
    'sync-p01-mutation-admission-chrome.mjs';
  var instancePromise = null;

  function instance() {
    if (instancePromise) return instancePromise;
    instancePromise = import(global.chrome.runtime.getURL(MODULE_PATH))
      .then(function (module) {
        return module.createChromeP01MutationAdmission({
          lockManager: global.navigator?.locks
        });
      });
    return instancePromise;
  }

  H2O.Studio.sync.p01MutationAdmission = Object.freeze({
    schema: 'h2o.studio.syncP01MutationAdmissionFacade.v1',
    run: function (options) {
      return instance().then(function (owner) { return owner.run(options); });
    },
    beginStanddownHold: function () {
      return instance().then(function (owner) {
        return owner.beginStanddownHold();
      });
    },
    diagnose: function () {
      return instance().then(function (owner) { return owner.diagnose(); });
    }
  });
})(typeof globalThis !== 'undefined' ? globalThis : this);
