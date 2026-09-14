// @version 0.1.0-m03-p2-s1
"use strict";

/*
 * H2O Markdown engine factory (M03 P2 S2A T4 S1).
 *
 * One configuration authority for both surfaces. The formal base is frozen
 * here; a provider profile may differ only in the options this factory exposes,
 * never by installing a second parser or a second extension.
 *
 * The engine itself is markdown-it 15.0.1, vendored byte-verbatim under
 * vendor/markdown-it/. This module resolves it without choosing it: the Studio
 * classic-script environment supplies the UMD global, and Metro/Node supply the
 * module. There is no second semantic implementation.
 *
 * No DOM. No sanitization. No URL admission. Destinations produced here are
 * inert data for the Render IR; the S2B sink decides what may become live.
 */
(function (global) {
  const H2O = global.H2O = global.H2O || {};
  const Studio = H2O.Studio = H2O.Studio || {};
  const Renderer = Studio.Renderer = Studio.Renderer || {};

  const ENGINE_NAME = "markdown-it";
  const ENGINE_VERSION = "15.0.1";

  /*
   * Frozen formal base. Every option is deliberate:
   *   html       - raw Markdown HTML is never interpreted; it stays literal text
   *   typographer- no smart quotes/replacements; semantics only
   *   breaks     - a soft break stays a soft break
   *   linkify    - linkify-it stays off; the H2O closure owns the linkify slot
   */
  const FORMAL_BASE_OPTIONS = Object.freeze({
    html: false,
    typographer: false,
    breaks: false,
    linkify: false,
  });

  function resolveMarkdownIt(explicit) {
    if (typeof explicit === "function") return explicit;
    if (typeof global.markdownit === "function") return global.markdownit;
    if (typeof module === "object" && module && module.exports && typeof require === "function") {
      /* Metro/Node module path. Resolution only - selection is governed. */
      const required = require("markdown-it");
      if (typeof required === "function") return required;
      if (required && typeof required.default === "function") return required.default;
    }
    return null;
  }

  function resolveGfm(explicit) {
    if (explicit && typeof explicit.h2oGfm === "function") return explicit;
    if (Renderer.markdownGfm && typeof Renderer.markdownGfm.h2oGfm === "function") return Renderer.markdownGfm;
    if (typeof module === "object" && module && module.exports && typeof require === "function") {
      return require("./h2o-gfm.v1.js");
    }
    return null;
  }

  /*
   * Build the engine. `singleTilde` is the only semantic option a provider
   * profile may vary; it selects formal single-tilde strikethrough (the formal
   * base) or double-tilde only. Both use the same extension.
   */
  function createEngine(options) {
    const opts = options && typeof options === "object" ? options : {};
    const MarkdownIt = resolveMarkdownIt(opts.MarkdownIt);
    if (!MarkdownIt) throw new Error("markdown-engine: markdown-it 15.0.1 is not available in this environment");
    const gfm = resolveGfm(opts.gfm);
    if (!gfm) throw new Error("markdown-engine: the H2O GFM closure is not available");

    const md = new MarkdownIt({ ...FORMAL_BASE_OPTIONS });
    gfm.h2oGfm(md, { singleTilde: opts.singleTilde !== false });

    /*
     * LOAD-BEARING. markdown-it's default validateLink silently drops
     * destinations such as javascript:, vbscript: and data: before any consumer
     * sees them. That would make the parser a security authority and would hide
     * the destination from Render IR, violating the accepted S0 boundary.
     * The parser is a syntax authority only; sanitizerPolicy.classifyUrl at the
     * S2B sink remains the sole admission authority, and no S1 path turns these
     * destinations into a live sink.
     */
    md.validateLink = () => true;
    return md;
  }

  function formalBaseEngine(options) {
    return createEngine({ ...(options || {}), singleTilde: true });
  }

  /* Provider profiles differ only by option, never by implementation. */
  const PROVIDER_PROFILES = Object.freeze({
    "formal-base": Object.freeze({ singleTilde: true }),
    "chatgpt-web-dated": Object.freeze({ singleTilde: false }),
  });

  function providerProfileEngine(profileName, options) {
    const profile = PROVIDER_PROFILES[String(profileName || "")];
    if (!profile) throw new Error(`markdown-engine: unknown provider profile: ${String(profileName)}`);
    return createEngine({ ...(options || {}), singleTilde: profile.singleTilde });
  }

  const api = Object.freeze({
    __version: "0.1.0-m03-p2-s1",
    engineName: ENGINE_NAME,
    engineVersion: ENGINE_VERSION,
    formalBaseOptions: FORMAL_BASE_OPTIONS,
    providerProfiles: PROVIDER_PROFILES,
    createEngine,
    formalBaseEngine,
    providerProfileEngine,
  });

  Renderer.markdownEngine = api;
  if (typeof module === "object" && module && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
