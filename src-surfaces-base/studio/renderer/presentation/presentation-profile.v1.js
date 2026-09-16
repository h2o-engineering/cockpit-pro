// @version 1.0.0-m04-p1
"use strict";

/*
 * H2O Studio Renderer — PresentationProfile v1 (governed registry, M04 P1 T1).
 *
 * Authority boundary:
 *   Render IR / H2O structural shells (Renderer) -> PresentationProfile -> presentation class hooks
 *
 * A PresentationProfile decides how the accepted H2O structure LOOKS: which
 * presentation / compatibility class hooks are layered onto Renderer-owned
 * structural nodes. It never decides which nodes exist, their role, identity,
 * accessibility or security policy, and it never reads or changes Render IR,
 * touches the DOM, persists anything or observes Reader behaviour. Semantic
 * content is therefore identical under every profile by construction.
 *
 * Structural and compatibility vocabulary stays with the Renderer and is
 * profile-independent; a profile hook may not carry it:
 *   cgFrame cgBody cgThread cgScroll cgTurn cgTurn--<role> cgMsg cgMsgBody
 *   cgBubble cgBubble--user cgBubbleRail
 *   cgUserAttachmentGrid cgUserAttachmentCard cgTurn--has-attachments
 *   wbReaderScroll (the Reader scroll surface, not a look)
 *   wbRichRoot (rich-replay compatibility root the global stylesheet keys on;
 *               emitted by the Renderer in both modes since M04 P1 T1)
 * Structural node existence, role attributes, identity attributes,
 * accessibility, edit semantics, Reader scroll behaviour and provider capture
 * recognition are Renderer decisions, not profile decisions; the profile only
 * names the class hooks that make an accepted structure or state look a
 * certain way.
 *
 * Registry lifetime (M04): registration is append-only from installation until
 * the registry is sealed. `seal()` is public and idempotent; `sealed()` reports
 * the state; registration after sealing fails deterministically
 * (`registry-sealed`). Duplicate ids fail. There is no dispose, unregister,
 * replacement or re-registration; every admitted definition and its metadata
 * are immutable for the document lifetime. Sealing forms a deterministic
 * evidence token (`registryDigest()`) from the unambiguously serialized, sorted
 * registry identities, owners and versions. It is evidence of the admitted
 * set, not a security digest and not a cross-document cache guarantee. The
 * Renderer decides WHEN the registry is sealed (its first render in the
 * document); this module never seals itself at installation.
 *
 * The built-in `chatgpt-reference` profile is defined and registered here at
 * install through the same public `define()` / `register()` path any other
 * profile uses. It remains the default and reference presentation; that
 * choice is not mutable. Presentation stylesheets are NOT loaded by this
 * module: `stylesheet` is admission metadata only (relative href + version).
 *
 * Load order: after render-ir/semantic-ingress (no dependency on them) and
 * before content-renderer and chat-renderer, which consume it.
 */
(function installRendererPresentationProfile(global) {
  const H2O = global.H2O = global.H2O || {};
  const Studio = H2O.Studio = H2O.Studio || {};
  const Renderer = Studio.Renderer = Studio.Renderer || {};
  if (Renderer.presentationProfile && Renderer.presentationProfile.__installed) return;

  const SCHEMA = "h2o.renderer.presentation-profile";
  const SCHEMA_VERSION = 1;
  const API_VERSION = "1.0.0-m04-p1";
  const REFERENCE_ID = "chatgpt-reference";
  const REGISTRY_ID = "presentation-profile";

  /* Bounded inputs: the canonical roles and shell modes the Renderer already
   * normalizes to. Helpers reject anything else instead of manufacturing class
   * names from unconstrained strings. */
  const ROLES = Object.freeze(["user", "assistant", "system", "tool"]);
  const MODES = Object.freeze(["canonical", "rich"]);

  /* Renderer-owned vocabulary a presentation hook may never claim. Exact
   * tokens plus the structural prefixes (role modifiers, bubble modifiers and
   * the attachment family). `cgMsg--*` stays admissible: message presentation
   * modifiers are the profile's decision (the reference profile emits them). */
  const RESERVED_TOKENS = Object.freeze([
    "cgFrame", "cgBody", "cgThread", "cgScroll", "cgTurn", "cgMsg", "cgMsgBody",
    "cgBubble", "cgBubbleRail", "cgTurn--has-attachments", "wbReaderScroll", "wbRichRoot",
  ]);
  const RESERVED_PREFIXES = Object.freeze(["cgUserAttachment", "cgBubble--", "cgTurn--"]);

  const RESOLUTION_REASONS = Object.freeze(["explicit", "default", "unknown-profile-fallback"]);

  const ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
  /* SemVer 2.0.0 items 2, 9 and 10: numeric identifiers (core and prerelease)
   * carry no leading zeroes; alphanumeric prerelease identifiers may; build
   * metadata identifiers may. (M04-P1-R02) */
  const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*)?(?:\+[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*)?$/;
  const CLASS_TOKEN_PATTERN = /^-?[_a-zA-Z][_a-zA-Z0-9-]*$/;
  const SLOT_NAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9]*$/;

  /* ------------------------------------------------------------ failures */

  function failure(ErrorType, code, message) {
    const error = new ErrorType(`presentation-profile: ${code}: ${message}`);
    try { Object.defineProperty(error, "code", { value: code, enumerable: true }); } catch {}
    return error;
  }
  const invalid = (message) => failure(TypeError, "invalid-definition", message);

  function deepFreeze(value) {
    if (value && typeof value === "object" && !Object.isFrozen(value)) {
      Object.freeze(value);
      for (const key of Object.keys(value)) deepFreeze(value[key]);
    }
    return value;
  }

  function requireOneOf(value, allowed, label) {
    const text = typeof value === "string" ? value : "";
    if (!allowed.includes(text)) {
      throw new TypeError(`presentation-profile: unknown ${label} "${String(value)}" (expected one of ${allowed.join(", ")})`);
    }
    return text;
  }

  const EMPTY = Object.freeze([]);
  const isPlainObject = (value) => !!value && typeof value === "object" && !Array.isArray(value);
  const nonBlank = (value) => typeof value === "string" && value.trim().length > 0;

  /* -------------------------------------------------------- definition */

  function validateClassTokens(value, path) {
    if (!Array.isArray(value)) throw invalid(`${path} must be an array of class tokens`);
    const seen = new Set();
    for (const token of value) {
      if (typeof token !== "string" || !CLASS_TOKEN_PATTERN.test(token)) {
        throw invalid(`${path} carries an invalid class token ${JSON.stringify(token)}`);
      }
      if (RESERVED_TOKENS.includes(token) || RESERVED_PREFIXES.some((prefix) => token.startsWith(prefix))) {
        throw invalid(`${path} may not claim Renderer structural/compatibility vocabulary ${JSON.stringify(token)}`);
      }
      if (seen.has(token)) throw invalid(`${path} repeats the class token ${JSON.stringify(token)}`);
      seen.add(token);
    }
    return Object.freeze(value.slice());
  }

  function validateModeTable(value, path) {
    if (!isPlainObject(value)) throw invalid(`${path} must be an object keyed by mode`);
    const out = {};
    for (const mode of MODES) out[mode] = validateClassTokens(value[mode], `${path}.${mode}`);
    for (const key of Object.keys(value)) if (!MODES.includes(key)) throw invalid(`${path} has an unknown mode "${key}"`);
    return Object.freeze(out);
  }

  function validateRoleTable(value, path) {
    if (!isPlainObject(value)) throw invalid(`${path} must be an object keyed by role`);
    const out = {};
    for (const role of ROLES) out[role] = validateClassTokens(value[role], `${path}.${role}`);
    for (const key of Object.keys(value)) if (!ROLES.includes(key)) throw invalid(`${path} has an unknown role "${key}"`);
    return Object.freeze(out);
  }

  /*
   * Hook table shape (every leaf is a frozen array of class tokens):
   *   transcript[mode]        classes on the transcript root for the render mode
   *   turn.base / turn[mode] / turn.role[role]   turn shell presentation classes
   *   message[mode][role]     message host presentation modifier
   *   userBubble.compat       compatibility classes on the H2O rich user bubble
   *   content[kind][slot]     content presentation per content kind and slot
   *                           (undeclared kinds/slots resolve to [])
   *   state.edited.turn / .message   edit-state presentation on turn and host
   */
  function validateHooks(value) {
    if (!isPlainObject(value)) throw invalid("hooks must be an object");
    const known = ["transcript", "turn", "message", "userBubble", "content", "state"];
    for (const key of Object.keys(value)) if (!known.includes(key)) throw invalid(`hooks.${key} is not a known hook family`);

    const turn = value.turn;
    if (!isPlainObject(turn)) throw invalid("hooks.turn must be an object");
    for (const key of Object.keys(turn)) if (!["base", ...MODES, "role"].includes(key)) throw invalid(`hooks.turn.${key} is not a known turn hook`);

    const message = value.message;
    if (!isPlainObject(message)) throw invalid("hooks.message must be an object keyed by mode");
    for (const key of Object.keys(message)) if (!MODES.includes(key)) throw invalid(`hooks.message has an unknown mode "${key}"`);

    const userBubble = value.userBubble;
    if (!isPlainObject(userBubble)) throw invalid("hooks.userBubble must be an object");
    for (const key of Object.keys(userBubble)) if (key !== "compat") throw invalid(`hooks.userBubble.${key} is not a known bubble hook (provider capture recognition is Renderer-owned)`);

    const content = value.content === undefined ? {} : value.content;
    if (!isPlainObject(content)) throw invalid("hooks.content must be an object keyed by content kind");
    const contentOut = {};
    for (const kind of Object.keys(content)) {
      if (!SLOT_NAME_PATTERN.test(kind) || !isPlainObject(content[kind])) throw invalid(`hooks.content.${kind} must be an object keyed by slot`);
      const slots = {};
      for (const slot of Object.keys(content[kind])) {
        if (!SLOT_NAME_PATTERN.test(slot)) throw invalid(`hooks.content.${kind}.${slot} is not a valid slot name`);
        slots[slot] = validateClassTokens(content[kind][slot], `hooks.content.${kind}.${slot}`);
      }
      contentOut[kind] = Object.freeze(slots);
    }

    const state = value.state;
    if (!isPlainObject(state) || !isPlainObject(state.edited)) throw invalid("hooks.state.edited must be an object");
    for (const key of Object.keys(state)) if (key !== "edited") throw invalid(`hooks.state.${key} is not a known state hook`);
    for (const key of Object.keys(state.edited)) if (!["turn", "message"].includes(key)) throw invalid(`hooks.state.edited.${key} is not a known edit-state hook`);

    return deepFreeze({
      transcript: validateModeTable(value.transcript, "hooks.transcript"),
      turn: Object.freeze({
        base: validateClassTokens(turn.base, "hooks.turn.base"),
        canonical: validateClassTokens(turn.canonical, "hooks.turn.canonical"),
        rich: validateClassTokens(turn.rich, "hooks.turn.rich"),
        role: validateRoleTable(turn.role, "hooks.turn.role"),
      }),
      message: Object.freeze({
        canonical: validateRoleTable(message.canonical, "hooks.message.canonical"),
        rich: validateRoleTable(message.rich, "hooks.message.rich"),
      }),
      userBubble: Object.freeze({ compat: validateClassTokens(userBubble.compat, "hooks.userBubble.compat") }),
      content: Object.freeze(contentOut),
      state: Object.freeze({
        edited: Object.freeze({
          turn: validateClassTokens(state.edited.turn, "hooks.state.edited.turn"),
          message: validateClassTokens(state.edited.message, "hooks.state.edited.message"),
        }),
      }),
    });
  }

  function validateStylesheet(value) {
    if (value === null || value === undefined) return null;
    if (!isPlainObject(value)) throw invalid("stylesheet must be null or { href, version } metadata");
    for (const key of Object.keys(value)) if (!["href", "version"].includes(key)) throw invalid(`stylesheet.${key} is not stylesheet metadata`);
    const href = value.href;
    if (!nonBlank(href) || /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("/") || href.startsWith("\\")
      || href.split(/[\\/]/).some((segment) => segment === "..") || /[\s"'<>?#]/.test(href)) {
      throw invalid("stylesheet.href must be a relative path without scheme, root, traversal or query");
    }
    if (value.version !== undefined && !nonBlank(value.version)) throw invalid("stylesheet.version must be a non-blank string when present");
    return Object.freeze({ href, version: value.version === undefined ? null : value.version });
  }

  function validateModes(value) {
    if (!Array.isArray(value)) throw invalid("modes must be exactly the canonical and rich modes");
    const sorted = value.slice().sort();
    const expected = MODES.slice().sort();
    if (sorted.length !== expected.length || sorted.some((mode, index) => mode !== expected[index])) {
      throw invalid("modes must be exactly the canonical and rich modes");
    }
    return MODES;
  }

  /* Admitted (define()'d) profiles are branded privately; register() admits
   * only these or a plain definition it validates itself. */
  const admitted = new WeakSet();

  function define(definition) {
    if (!isPlainObject(definition)) throw invalid("a profile definition must be an object");
    const known = ["id", "owner", "version", "displayName", "provider", "stylesheet", "modes", "hooks"];
    for (const key of Object.keys(definition)) if (!known.includes(key)) throw invalid(`unknown definition field "${key}"`);
    if (!nonBlank(definition.id) || !ID_PATTERN.test(definition.id)) throw invalid("id must be a lowercase kebab-case identifier");
    if (!nonBlank(definition.owner)) throw invalid("owner must be a non-blank string");
    if (!nonBlank(definition.version) || !SEMVER_PATTERN.test(definition.version)) throw invalid("version must be a semver string");
    if (!nonBlank(definition.displayName)) throw invalid("displayName must be a non-blank string");
    if (definition.provider !== null && !nonBlank(definition.provider)) throw invalid("provider must be a non-blank string or null");
    const stylesheet = validateStylesheet(definition.stylesheet);
    const modes = validateModes(definition.modes);
    const hooks = validateHooks(definition.hooks);

    const profile = {
      id: definition.id,
      owner: definition.owner,
      version: definition.version,
      displayName: definition.displayName,
      provider: definition.provider,
      stylesheet,
      modes,
      hooks,
      transcriptClasses(mode) {
        return hooks.transcript[requireOneOf(mode, MODES, "mode")];
      },
      turnClasses(role, mode) {
        const r = requireOneOf(role, ROLES, "role");
        const m = requireOneOf(mode, MODES, "mode");
        return Object.freeze([...hooks.turn.base, ...hooks.turn[m], ...hooks.turn.role[r]]);
      },
      messageClasses(role, mode) {
        const r = requireOneOf(role, ROLES, "role");
        const m = requireOneOf(mode, MODES, "mode");
        return hooks.message[m][r];
      },
      userBubbleClasses() {
        return hooks.userBubble.compat;
      },
      /* Content presentation by content kind and slot; undeclared -> []. */
      contentClasses(kind, slot) {
        const byKind = typeof kind === "string" && Object.prototype.hasOwnProperty.call(hooks.content, kind) ? hooks.content[kind] : null;
        if (!byKind || typeof slot !== "string" || !Object.prototype.hasOwnProperty.call(byKind, slot)) return EMPTY;
        return byKind[slot];
      },
      /* Compatibility wrappers over contentClasses(): the code-block hooks
       * consumers already read (S3B). */
      codeBlockClasses() {
        return profile.contentClasses("codeBlock", "container");
      },
      codeLanguageClasses() {
        return profile.contentClasses("codeBlock", "language");
      },
      editedTurnClasses() {
        return hooks.state.edited.turn;
      },
      editedMessageClasses() {
        return hooks.state.edited.message;
      },
    };
    Object.freeze(profile);
    admitted.add(profile);
    return profile;
  }

  /* ---------------------------------------------------------- registry */

  const registry = new Map();
  let sealedToken = null;

  function register(input) {
    if (sealedToken !== null) {
      throw failure(Error, "registry-sealed", "the presentation-profile registry is sealed; registration is closed for this document");
    }
    const profile = admitted.has(input) ? input : define(input);
    if (registry.has(profile.id)) {
      throw failure(TypeError, "duplicate-id", `a profile with id "${profile.id}" is already registered`);
    }
    registry.set(profile.id, profile);
    return profile;
  }

  function ids() {
    return Object.freeze(Array.from(registry.keys()));
  }

  function list() {
    return Object.freeze(Array.from(registry.values()));
  }

  /* Unknown ids resolve to null: a profile exists only if it is registered. */
  function get(id) {
    const key = typeof id === "string" ? id : "";
    return registry.has(key) ? registry.get(key) : null;
  }

  function reference() {
    return registry.get(REFERENCE_ID);
  }

  /* The default is the reference profile; not a mutable preference. */
  function defaultProfile() {
    return reference();
  }

  /* Safe selection, never throws for a bad request:
   *   absent (undefined / null / "")     -> default,  requestedId null, reason "default"
   *   known string                       -> explicit, requestedId as given, reason "explicit"
   *   unknown string                     -> default,  requestedId as given, reason "unknown-profile-fallback"
   *   malformed (any non-string value)   -> default,  requestedId null,     reason "unknown-profile-fallback"
   * A non-string request is never coerced: no toString / valueOf /
   * Symbol.toPrimitive of the caller's value runs here (M04-P1-R01), so a
   * null-prototype object or a throwing coercion hook cannot break selection. */
  function resolve(requestedId) {
    if (requestedId === undefined || requestedId === null || requestedId === "") {
      return Object.freeze({ requestedId: null, effectiveId: REFERENCE_ID, profile: reference(), reason: "default" });
    }
    if (typeof requestedId !== "string") {
      return Object.freeze({ requestedId: null, effectiveId: REFERENCE_ID, profile: reference(), reason: "unknown-profile-fallback" });
    }
    const found = get(requestedId);
    if (found) {
      return Object.freeze({ requestedId, effectiveId: found.id, profile: found, reason: "explicit" });
    }
    return Object.freeze({ requestedId, effectiveId: REFERENCE_ID, profile: reference(), reason: "unknown-profile-fallback" });
  }

  /* Deterministic evidence token: sorted identities, unambiguously serialized. */
  function evidenceToken() {
    const entries = Array.from(registry.values())
      .map((profile) => ({ id: profile.id, owner: profile.owner, version: profile.version }))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return JSON.stringify({ schema: SCHEMA, schemaVersion: SCHEMA_VERSION, registry: REGISTRY_ID, apiVersion: API_VERSION, entries });
  }

  function seal() {
    if (sealedToken === null) sealedToken = evidenceToken();
    return sealedToken;
  }

  function sealed() {
    return sealedToken !== null;
  }

  function registryDigest() {
    return sealedToken;
  }

  /* -------------------------------------------- built-in reference profile */

  /*
   * The ChatGPT reference profile maps the accepted ChatGPT-compatible class
   * vocabulary exactly as the Renderer emitted it before the profile contract
   * existed (S3A), so the default output is unchanged. `wbRichRoot` and the
   * provider bubble capture marker are not here: both are Renderer vocabulary
   * (compatibility root / capture recognition), emitted or read by the Renderer
   * itself in both modes.
   */
  register(define({
    id: REFERENCE_ID,
    owner: "L-STUDIO-RENDERER",
    version: "1.0.0",
    displayName: "ChatGPT reference presentation",
    provider: "chatgpt",
    stylesheet: { href: "renderer/presentation/chatgpt-reference.v1.css", version: "1.0.6" },
    modes: ["canonical", "rich"],
    hooks: {
      transcript: {
        canonical: [],
        rich: ["is-rich"],
      },
      turn: {
        base: ["wbTurn"],
        canonical: ["wbTurn--fallback"],
        rich: ["wbTurn--rich"],
        role: {
          user: ["wbTurn--user"],
          assistant: ["wbTurn--assistant"],
          system: ["wbTurn--system"],
          tool: ["wbTurn--tool"],
        },
      },
      message: {
        /* Canonical hosts carry the bubble skin themselves. Rich hosts stay a
         * neutral cgMsg: the rich user bubble is a separate H2O element that
         * carries the skin through the compatibility class below. */
        canonical: {
          user: ["cgMsg--user"],
          assistant: ["cgMsg--assistant"],
          system: ["cgMsg--system"],
          tool: ["cgMsg--tool"],
        },
        rich: { user: [], assistant: [], system: [], tool: [] },
      },
      userBubble: {
        compat: ["user-message-bubble-color"],
      },
      content: {
        codeBlock: {
          container: ["wbCodeBlock"],
          language: ["wbCodeLang"],
        },
      },
      state: {
        edited: {
          turn: ["wbTurn--edited"],
          message: ["cgMsg--edited"],
        },
      },
    },
  }));

  Renderer.presentationProfile = Object.freeze({
    __installed: true,
    __version: API_VERSION,
    schema: SCHEMA,
    schemaVersion: SCHEMA_VERSION,
    referenceId: REFERENCE_ID,
    roles: ROLES,
    modes: MODES,
    resolutionReasons: RESOLUTION_REASONS,
    define,
    register,
    get,
    ids,
    list,
    reference,
    default: defaultProfile,
    resolve,
    seal,
    sealed,
    registryDigest,
  });
})(typeof window !== "undefined" ? window : globalThis);
