/* H2O Studio — Appearance Keys
 *
 * Studio-local constants for the Appearance / View Options panel. Mirrors
 * the dock/ribbon module pattern (see dock/dock-keys.js, ribbon/ribbon-keys.js):
 * passive — loading this file has no side effects beyond attaching frozen
 * objects to H2O.Studio.appearance.
 *
 * Storage keys are all Studio-local under the `h2o:studio:appearance:` prefix.
 * They are written through H2O.Studio.platform.storage (same backend as
 * store/prefs.js) so they persist across reload and restart for both the
 * Tauri desktop app and the MV3 extension Studio surface.
 *
 * Loads BEFORE appearance-store.studio.js and appearance-panel.studio.js
 * (both depend on these constants). Loads AFTER platform/index.js so the
 * store can route through the platform adapter.
 *
 * Contracts: src-surfaces-base/studio/STUDIO_DEVELOPMENT_RULES.md
 */
(function (global) {
  'use strict';

  var H2O = global.H2O = global.H2O || {};
  H2O.Studio = H2O.Studio || {};

  if (H2O.Studio.appearance && H2O.Studio.appearance.__keysInstalled) return;

  var VERSION = '0.1.0';

  var KEYS = Object.freeze({
    theme:        'h2o:studio:appearance:theme:v1',         /* 'dark' | 'light' | 'sepia' */
    typography:   'h2o:studio:appearance:typography:v1',    /* 'sans' | 'serif' | 'mono'  */
    fontSize:     'h2o:studio:appearance:fontSize:v1',      /* integer px, FONT_SIZE_MIN..MAX */
    contentWidth: 'h2o:studio:appearance:contentWidth:v1',  /* integer rem, WIDTH_MIN..MAX */
    showFolders:  'h2o:studio:appearance:showFolders:v1',   /* boolean */
    showNotes:    'h2o:studio:appearance:showNotes:v1',     /* boolean */
    plainText:    'h2o:studio:appearance:plainText:v1',     /* boolean */
    alwaysOnTop:  'h2o:studio:appearance:alwaysOnTop:v1',   /* boolean — Tauri only */
    /* M04 P2 T4 (HDA decision D): Reader-owned consumption preference — the
     * requested Renderer presentation profile id, kept verbatim (unknown ids
     * and '' included); the Renderer resolves the effective profile. */
    presentationProfile: 'h2o:studio:appearance:presentationProfile:v1', /* string profile id */
  });

  var THEMES = Object.freeze(['dark', 'light', 'sepia']);
  var TYPOGRAPHIES = Object.freeze(['sans', 'serif', 'mono']);

  /* Bounds for the +/- controls. Stored value is always clamped on read+write. */
  var FONT_SIZE_MIN = 13;
  var FONT_SIZE_MAX = 22;
  var FONT_SIZE_STEP = 1;
  var WIDTH_MIN = 36;   /* rem */
  var WIDTH_MAX = 72;   /* rem */
  var WIDTH_STEP = 4;   /* rem */

  var DEFAULTS = Object.freeze({
    theme: 'dark',
    typography: 'sans',
    fontSize: 16,
    contentWidth: 48,
    showFolders: true,
    showNotes: true,
    plainText: false,
    alwaysOnTop: false,
    presentationProfile: 'chatgpt-reference',
  });

  var EVENTS = Object.freeze({
    changed: 'evt:h2o:studio:appearance:changed',
    ready:   'evt:h2o:studio:appearance:ready',
  });

  H2O.Studio.appearance = H2O.Studio.appearance || {};
  H2O.Studio.appearance.__keysInstalled = true;
  H2O.Studio.appearance.version = VERSION;
  H2O.Studio.appearance.keys = KEYS;
  H2O.Studio.appearance.themes = THEMES;
  H2O.Studio.appearance.typographies = TYPOGRAPHIES;
  H2O.Studio.appearance.defaults = DEFAULTS;
  H2O.Studio.appearance.events = EVENTS;
  H2O.Studio.appearance.bounds = Object.freeze({
    fontSize: Object.freeze({ min: FONT_SIZE_MIN, max: FONT_SIZE_MAX, step: FONT_SIZE_STEP }),
    contentWidth: Object.freeze({ min: WIDTH_MIN, max: WIDTH_MAX, step: WIDTH_STEP }),
  });
})(typeof window !== 'undefined' ? window : this);
