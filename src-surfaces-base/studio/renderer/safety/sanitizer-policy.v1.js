// @version 0.1.0-m03-s1a
"use strict";

/*
 * H2O Studio Renderer - sanitization policy v1 (pure).
 *
 * Renderer-owned, DOM-free, engine-free, deterministic and frozen. This module
 * decides WHAT is allowed; it never touches a DOM and never learns which
 * sanitization engine enforces the decision. The Renderer adapter
 * (html-sanitizer.v2.js) is the only code that maps these plain-data decisions
 * onto an engine configuration.
 *
 * Policy version and engine version are deliberately independent: a policy
 * change must be reviewable without an engine bump, and an engine bump must
 * not silently move policy.
 *
 * Posture: this is not a "preserve as much provider HTML as possible" policy.
 * Truthful content degradation is preferred over unsafe fidelity. CSP is
 * defense in depth, never the sanitizer's authority.
 */
(function installRendererSanitizerPolicy(global) {
  const H2O = global.H2O = global.H2O || {};
  const Studio = H2O.Studio = H2O.Studio || {};
  const Renderer = Studio.Renderer = Studio.Renderer || {};
  if (Renderer.sanitizerPolicy && Renderer.sanitizerPolicy.__installed) return;

  const POLICY_ID = "h2o.renderer.html-sanitizer-policy";
  const POLICY_VERSION = 1;
  const API_VERSION = "0.1.0-m03-s1a";

  /* One profile is implemented. The parameter exists so a later replayCompat
   * profile is a policy addition rather than an API change; an unknown profile
   * fails closed instead of silently falling back. */
  const PROFILE_CONTENT = "content";
  const PROFILES = Object.freeze([PROFILE_CONTENT]);

  /* Semantic structure only. No script/style/form/frame/object/embed surface,
   * no SVG or MathML subtrees, no custom elements. */
  const ALLOWED_TAGS = Object.freeze([
    "p", "br", "hr", "div", "span", "wbr",
    "h1", "h2", "h3", "h4", "h5", "h6",
    "strong", "b", "em", "i", "u", "s", "del", "ins", "mark", "small", "sub", "sup",
    "code", "pre", "kbd", "samp", "var",
    "blockquote", "q", "cite", "abbr", "time",
    "ul", "ol", "li", "dl", "dt", "dd",
    "table", "thead", "tbody", "tfoot", "tr", "th", "td", "caption", "colgroup", "col",
    "a", "img", "figure", "figcaption", "details", "summary",
  ]);

  const GLOBAL_ATTRIBUTES = Object.freeze(["class", "dir", "lang", "title", "translate"]);

  const TAG_ATTRIBUTES = Object.freeze({
    a: Object.freeze(["href", "target", "rel"]),
    img: Object.freeze(["src", "alt", "width", "height", "loading"]),
    blockquote: Object.freeze(["cite"]),
    q: Object.freeze(["cite"]),
    time: Object.freeze(["datetime"]),
    ol: Object.freeze(["start", "reversed", "type"]),
    li: Object.freeze(["value"]),
    th: Object.freeze(["colspan", "rowspan", "headers", "scope", "abbr"]),
    td: Object.freeze(["colspan", "rowspan", "headers"]),
    col: Object.freeze(["span"]),
    colgroup: Object.freeze(["span"]),
    details: Object.freeze(["open"]),
  });

  /*
   * Never admitted, even if some future profile widens the allowlists.
   * `id`/`name` are stripped so provider content cannot clobber DOM lookups or
   * collide with H2O-issued identity; `style` is not trusted presentation
   * authority.
   */
  const BLOCKED_ATTRIBUTES = Object.freeze([
    "id", "name", "style", "srcdoc", "action", "formaction", "background",
    "ping", "http-equiv", "xmlns", "is", "srcset", "usemap", "profile", "codebase",
  ]);

  const BLOCKED_TAGS = Object.freeze([
    "script", "style", "iframe", "object", "embed", "base", "meta", "form",
    "input", "button", "select", "option", "textarea", "label", "fieldset",
    "svg", "math", "template", "noscript", "frame", "frameset", "applet",
    "link", "portal", "audio", "video", "source", "track", "canvas", "dialog",
  ]);

  /* URI contexts. Anything not listed here is not treated as a URI attribute. */
  const URI_CONTEXT_LINK = "link";
  const URI_CONTEXT_IMAGE = "image";
  const URI_ATTRIBUTES = Object.freeze({
    "a.href": URI_CONTEXT_LINK,
    "blockquote.cite": URI_CONTEXT_LINK,
    "q.cite": URI_CONTEXT_LINK,
    "img.src": URI_CONTEXT_IMAGE,
  });

  const ALLOWED_SCHEMES = Object.freeze({
    [URI_CONTEXT_LINK]: Object.freeze(["https", "http", "mailto", "tel"]),
    [URI_CONTEXT_IMAGE]: Object.freeze(["https", "http", "data"]),
  });

  /*
   * Enforcement is allowlist-based, so every scheme absent from ALLOWED_SCHEMES
   * is already rejected. This list is the explicit, testable record of schemes
   * that must never be admitted in a link context - including the digit-bearing
   * custom schemes an engine default protocol handling has been observed to
   * retain. "data" appears here because it is never a link scheme; the image
   * context admits only the raster form checked below.
   */
  const DENIED_SCHEMES = Object.freeze([
    "javascript", "vbscript", "file", "filesystem", "chrome", "chrome-extension",
    "tauri", "asset", "ipc", "ws", "wss", "ftp", "h2o", "h2oapp", "blob",
    "about", "data",
  ]);

  /* Only raster data: images, and only in an image context. SVG and text/html
   * are excluded because both are script-bearing document types. */
  const DATA_IMAGE_RASTER = /^data:image\/(?:png|jpe?g|gif|webp);base64,[a-z0-9+/]+=*$/i;

  const SCHEME_PATTERN = /^[a-z][a-z0-9+.\-]*:/i;
  const SCHEME_CAPTURE = /^([a-z][a-z0-9+.\-]*):/i;
  const CUSTOM_ELEMENT_PATTERN = /^[a-z][a-z0-9._]*-[a-z0-9._\-]*$/i;
  const H2O_IDENTITY_ATTRIBUTE = /^data-h2o-/i;
  const EVENT_HANDLER_ATTRIBUTE = /^on/i;
  const DATA_ATTRIBUTE = /^data-/i;

  /* Removed before scheme detection so separators cannot hide a scheme:
   * C0/C1 controls, DEL, every Unicode space form, zero-width marks and BOM. */
  const CLASSIFICATION_NOISE = /[\u0000-\u0020\u007F-\u00A0\u1680\u2000-\u200D\u2028\u2029\u202F\u205F\u3000\uFEFF]/g;

  /* Guard only, not a product performance budget. The measured cost of the
   * chosen engine is roughly linear in input size; a real budget belongs with
   * the future rich-replay consumer switch. */
  const MAX_INPUT_BYTES = 2 * 1024 * 1024;

  function asString(value) {
    return value == null ? "" : String(value);
  }

  function lower(value) {
    return asString(value).trim().toLowerCase();
  }

  function freezeDeep(value) {
    if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
    Object.freeze(value);
    for (const child of Object.values(value)) freezeDeep(child);
    return value;
  }

  /*
   * Scheme detection runs on a copy with the noise characters removed, so an
   * embedded tab or space cannot hide a scheme. The caller original value is
   * never rewritten here.
   */
  function normalizeForClassification(value) {
    return asString(value).replace(CLASSIFICATION_NOISE, "");
  }

  function hasScheme(value) {
    return SCHEME_PATTERN.test(normalizeForClassification(value));
  }

  function schemeOf(value) {
    const match = SCHEME_CAPTURE.exec(normalizeForClassification(value));
    return match ? match[1].toLowerCase() : "";
  }

  function isProfile(profile) {
    return PROFILES.includes(lower(profile) || PROFILE_CONTENT);
  }

  function requireProfile(profile) {
    const name = lower(profile) || PROFILE_CONTENT;
    if (!PROFILES.includes(name)) {
      throw new TypeError(`sanitizer-policy: unsupported profile: ${lower(profile) || "<empty>"}`);
    }
    return name;
  }

  function isCustomElementName(tag) {
    return CUSTOM_ELEMENT_PATTERN.test(lower(tag));
  }

  function isIdentityAttribute(attr) {
    const name = lower(attr);
    return name === "id" || name === "name" || H2O_IDENTITY_ATTRIBUTE.test(name);
  }

  function isEventHandlerAttribute(attr) {
    return EVENT_HANDLER_ATTRIBUTE.test(lower(attr));
  }

  function isAllowedTag(tag, profile) {
    requireProfile(profile);
    const name = lower(tag);
    if (!name || isCustomElementName(name)) return false;
    if (BLOCKED_TAGS.includes(name)) return false;
    return ALLOWED_TAGS.includes(name);
  }

  function isAllowedAttribute(tag, attr, profile) {
    requireProfile(profile);
    const tagName = lower(tag);
    const attrName = lower(attr);
    if (!attrName) return false;
    if (isEventHandlerAttribute(attrName)) return false;
    if (DATA_ATTRIBUTE.test(attrName)) return false;
    if (BLOCKED_ATTRIBUTES.includes(attrName)) return false;
    if (isIdentityAttribute(attrName)) return false;
    if (GLOBAL_ATTRIBUTES.includes(attrName)) return true;
    const perTag = TAG_ATTRIBUTES[tagName];
    return Array.isArray(perTag) && perTag.includes(attrName);
  }

  function uriContextFor(tag, attr) {
    return URI_ATTRIBUTES[`${lower(tag)}.${lower(attr)}`] || "";
  }

  /*
   * Contextual URI decision. This is the source of truth: an engine coarse URI
   * regexp is a backstop, never the boundary.
   */
  function classifyUrl(value, context) {
    const contextName = lower(context) || URI_CONTEXT_LINK;
    const allowed = ALLOWED_SCHEMES[contextName];
    if (!allowed) return freezeDeep({ ok: false, reason: "unsupported-context", scheme: "", context: contextName });

    const normalized = normalizeForClassification(value);
    if (!normalized) return freezeDeep({ ok: false, reason: "empty", scheme: "", context: contextName });

    /* Protocol-relative values inherit the host page scheme, so they are not a
     * decision this policy can make safely. */
    if (normalized.startsWith("//")) {
      return freezeDeep({ ok: false, reason: "protocol-relative", scheme: "", context: contextName });
    }

    if (!SCHEME_PATTERN.test(normalized)) {
      /* No scheme at all: a relative path or fragment. */
      return freezeDeep({ ok: true, reason: "relative", scheme: "", context: contextName });
    }

    const scheme = schemeOf(normalized);
    if (!allowed.includes(scheme)) {
      return freezeDeep({ ok: false, reason: "scheme-not-allowed", scheme, context: contextName });
    }

    if (scheme === "data") {
      if (contextName !== URI_CONTEXT_IMAGE || !DATA_IMAGE_RASTER.test(normalized)) {
        return freezeDeep({ ok: false, reason: "data-uri-not-allowed", scheme, context: contextName });
      }
      return freezeDeep({ ok: true, reason: "data-image-raster", scheme, context: contextName });
    }

    return freezeDeep({ ok: true, reason: "scheme-allowed", scheme, context: contextName });
  }

  function isWithinBudget(input) {
    return asString(input).length <= MAX_INPUT_BYTES;
  }

  /*
   * Plain-data description of the policy. The adapter translates this into an
   * engine configuration; nothing engine-shaped appears here.
   */
  function describe(profile) {
    const name = requireProfile(profile);
    const attributes = new Set(GLOBAL_ATTRIBUTES);
    for (const list of Object.values(TAG_ATTRIBUTES)) for (const attr of list) attributes.add(attr);
    const schemes = new Set();
    for (const list of Object.values(ALLOWED_SCHEMES)) for (const scheme of list) schemes.add(scheme);

    return freezeDeep({
      policyId: POLICY_ID,
      policyVersion: POLICY_VERSION,
      profile: name,
      allowedTags: [...ALLOWED_TAGS],
      allowedAttributes: [...attributes].sort(),
      blockedTags: [...BLOCKED_TAGS],
      blockedAttributes: [...BLOCKED_ATTRIBUTES],
      allowDataAttributes: false,
      allowAriaAttributes: false,
      allowUnknownProtocols: false,
      allowCustomElements: false,
      sanitizeDom: true,
      sanitizeNamedProps: true,
      allowedUriSchemes: [...schemes].sort(),
      uriContexts: { ...URI_ATTRIBUTES },
      maxInputBytes: MAX_INPUT_BYTES,
    });
  }

  Renderer.sanitizerPolicy = freezeDeep({
    __installed: true,
    __version: API_VERSION,
    policyId: POLICY_ID,
    policyVersion: POLICY_VERSION,
    profiles: PROFILES,
    defaultProfile: PROFILE_CONTENT,
    allowedTags: ALLOWED_TAGS,
    globalAttributes: GLOBAL_ATTRIBUTES,
    tagAttributes: TAG_ATTRIBUTES,
    blockedTags: BLOCKED_TAGS,
    blockedAttributes: BLOCKED_ATTRIBUTES,
    allowedSchemes: ALLOWED_SCHEMES,
    deniedSchemes: DENIED_SCHEMES,
    uriContexts: URI_ATTRIBUTES,
    maxInputBytes: MAX_INPUT_BYTES,
    isProfile,
    hasScheme,
    schemeOf,
    isCustomElementName,
    isIdentityAttribute,
    isEventHandlerAttribute,
    isAllowedTag,
    isAllowedAttribute,
    uriContextFor,
    classifyUrl,
    isWithinBudget,
    describe,
  });
})(typeof window !== "undefined" ? window : globalThis);
