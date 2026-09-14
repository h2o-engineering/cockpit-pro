// @version 0.1.0-m03-s1a
"use strict";

/*
 * H2O Studio Renderer - runtime HTML sanitizer v2 (DOM adapter).
 *
 * Increment: M03 P1 S1A T1.
 *
 * Why an external engine: correct sanitization requires real DOM-aware parsing,
 * because the browser parser - not a regex - decides the final tree, and
 * mutation-XSS lives in that gap. A hand-written H2O sanitizer/parser was
 * considered and rejected: it would have to track parser quirks and namespace
 * confusion indefinitely. DOMPurify is therefore pinned byte-verbatim under
 * vendor/dompurify and isolated behind this adapter, which is the only Renderer
 * code permitted to talk to it. WHAT is allowed stays in sanitizer-policy.v1.js.
 *
 * This module is unwired: nothing packages or loads it yet.
 *
 * Shared v1 (H2O.Studio.html.sanitize) is untouched and keeps serving
 * Saved-Chat projection. Saved-Chat `sanitized: true` is an ingress-admission
 * signal only; it never permits skipping v2 before a live DOM sink.
 */
(function installRendererHtmlSanitizerV2(global) {
  const H2O = global.H2O = global.H2O || {};
  const Studio = H2O.Studio = H2O.Studio || {};
  const Renderer = Studio.Renderer = Studio.Renderer || {};
  if (Renderer.htmlSanitizer && Renderer.htmlSanitizer.__installed) return;

  const policy = Renderer.sanitizerPolicy;
  if (!policy || !policy.__installed) {
    throw new Error("html-sanitizer.v2: requires H2O.Studio.Renderer.sanitizerPolicy (sanitizer-policy.v1.js) to be installed first");
  }

  const API_VERSION = "0.1.0-m03-s1a";
  const EXPECTED_ENGINE = "dompurify";
  const EXPECTED_ENGINE_VERSION = "3.4.15";

  function fail(message) {
    throw new Error(`html-sanitizer.v2: ${message}`);
  }

  /*
   * Engine capture. The vendored classic script publishes a UMD singleton; we
   * take that one instance and keep it privately. A second instance created via
   * DOMPurify(window) is deliberately NOT used: duplicate instances create
   * duplicate internal policies, which becomes hazardous under future Trusted
   * Types enforcement. Deleting the global afterwards is hygiene only - the
   * security boundary is this adapter plus the policy, never global absence.
   */
  const engineState = (function captureEngine() {
    const candidate = global.DOMPurify;
    if (!candidate) return { engine: null, available: false, reason: "engine-absent", version: "" };
    const version = String(candidate.version || "");
    if (version !== EXPECTED_ENGINE_VERSION) {
      return { engine: null, available: false, reason: "engine-version-mismatch", version };
    }
    if (candidate.isSupported !== true) {
      return { engine: null, available: false, reason: "engine-unsupported-environment", version };
    }
    try { delete global.DOMPurify; } catch (_) { /* hygiene only */ }
    return { engine: candidate, available: true, reason: "ready", version };
  })();

  const described = policy.describe(policy.defaultProfile);

  /*
   * Coarse URI backstop. It admits the policy schemes and any value with no
   * scheme at all, so ordinary non-URI attributes such as target/rel keep
   * working. Crucially it does NOT admit arbitrary schemes: the engine default
   * retains digit-bearing custom schemes (h2o:, h2oapp:, x2y:), which this
   * pattern rejects. The contextual decision still belongs to the pure policy
   * classifier in the attribute hook below.
   */
  const ALLOWED_URI_REGEXP = new RegExp(
    "^(?:(?:" + described.allowedUriSchemes.join("|") + "):|(?![a-z][a-z0-9+.\\-]*:))",
    "i"
  );

  function buildConfig(returnFragment) {
    return Object.freeze({
      ALLOWED_TAGS: Object.freeze(described.allowedTags.slice()),
      ALLOWED_ATTR: Object.freeze(described.allowedAttributes.slice()),
      FORBID_TAGS: Object.freeze(described.blockedTags.slice()),
      FORBID_ATTR: Object.freeze(described.blockedAttributes.slice()),
      ALLOW_DATA_ATTR: described.allowDataAttributes,
      ALLOW_ARIA_ATTR: described.allowAriaAttributes,
      ALLOW_UNKNOWN_PROTOCOLS: described.allowUnknownProtocols,
      ALLOWED_URI_REGEXP,
      SANITIZE_DOM: described.sanitizeDom,
      SANITIZE_NAMED_PROPS: described.sanitizeNamedProps,
      CUSTOM_ELEMENT_HANDLING: Object.freeze({
        tagNameCheck: null,
        attributeNameCheck: null,
        allowCustomizedBuiltInElements: described.allowCustomElements,
      }),
      KEEP_CONTENT: true,
      WHOLE_DOCUMENT: false,
      FORCE_BODY: false,
      IN_PLACE: false,
      RETURN_DOM: false,
      RETURN_DOM_FRAGMENT: returnFragment === true,
      RETURN_TRUSTED_TYPE: false,
    });
  }

  /*
   * The complete config is passed on EVERY sanitize() call. setConfig() is never
   * called anywhere in Renderer v2: after setConfig(), per-call config is
   * silently ignored by this engine version, which can turn a requested
   * RETURN_DOM_FRAGMENT into a String result without throwing.
   */
  const STRING_CONFIG = buildConfig(false);
  const FRAGMENT_CONFIG = buildConfig(true);

  let hooksInstalled = false;
  function installHooks(engine) {
    if (hooksInstalled) return;
    engine.addHook("uponSanitizeAttribute", function enforceRendererPolicy(node, data) {
      const tag = String(node && node.nodeName ? node.nodeName : "").toLowerCase();
      const attr = String(data.attrName || "").toLowerCase();

      if (policy.isIdentityAttribute(attr) || policy.isEventHandlerAttribute(attr)) {
        data.keepAttr = false;
        return;
      }
      if (!policy.isAllowedAttribute(tag, attr, described.profile)) {
        data.keepAttr = false;
        return;
      }
      const context = policy.uriContextFor(tag, attr);
      if (!context) return;
      /* Rejected URI attributes are removed outright. No placeholder value is
       * substituted: a neutralized "#" would falsely present as a real link. */
      if (!policy.classifyUrl(data.attrValue, context).ok) data.keepAttr = false;
    });
    hooksInstalled = true;
  }

  function requireEngine() {
    if (!engineState.available || !engineState.engine) {
      fail(`sanitization unavailable (${engineState.reason}); refusing to return unsanitized content`);
    }
    installHooks(engineState.engine);
    return engineState.engine;
  }

  function requireString(input) {
    if (typeof input !== "string") {
      throw new TypeError("html-sanitizer.v2: input must be a string");
    }
    if (!policy.isWithinBudget(input)) {
      fail(`input exceeds the sanitization guard of ${described.maxInputBytes} characters`);
    }
    return input;
  }

  function isSupported() {
    return engineState.available === true;
  }

  function classifyUrl(value, context) {
    return policy.classifyUrl(value, context);
  }

  /* Fail closed: an unsafe or unclassifiable URL yields empty, never a
   * placeholder and never the original value. */
  function sanitizeUrl(value, context) {
    const verdict = policy.classifyUrl(value, context);
    return verdict.ok ? String(value == null ? "" : value).trim() : "";
  }

  function sanitizeHtml(input) {
    const source = requireString(input);
    const engine = requireEngine();
    const result = engine.sanitize(source, STRING_CONFIG);
    if (typeof result !== "string") {
      fail("engine returned a non-string result for a string sanitization request");
    }
    return result;
  }

  function sanitizeToFragment(input) {
    const source = requireString(input);
    const engine = requireEngine();
    const result = engine.sanitize(source, FRAGMENT_CONFIG);
    /*
     * The engine builds the fragment in an inert foreign document, so
     * fragment.ownerDocument !== document. That is valid and safe: modern DOM
     * insertion adopts it. Requiring ownerDocument === document would be wrong,
     * so only the node type is checked.
     */
    if (!result || result.nodeType !== 11) {
      fail("engine did not return a DocumentFragment for a fragment sanitization request");
    }
    return result;
  }

  function diagnose() {
    return Object.freeze({
      installed: true,
      apiVersion: API_VERSION,
      policyId: policy.policyId,
      policyVersion: policy.policyVersion,
      profile: described.profile,
      engine: EXPECTED_ENGINE,
      engineVersion: engineState.version || "",
      engineExpectedVersion: EXPECTED_ENGINE_VERSION,
      engineAvailable: engineState.available,
      engineStatus: engineState.reason,
      usesSetConfig: false,
      trustedTypes: "not-implemented",
      maxInputBytes: described.maxInputBytes,
    });
  }

  Renderer.htmlSanitizer = Object.freeze({
    __installed: true,
    __version: API_VERSION,
    apiVersion: API_VERSION,
    policyId: policy.policyId,
    policyVersion: policy.policyVersion,
    engine: EXPECTED_ENGINE,
    engineVersion: EXPECTED_ENGINE_VERSION,
    isSupported,
    classifyUrl,
    sanitizeUrl,
    sanitizeHtml,
    sanitizeToFragment,
    diagnose,
  });
})(typeof window !== "undefined" ? window : globalThis);
