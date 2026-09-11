// @version 0.1.0-m03-foundation
"use strict";

/*
 * H2O Studio Renderer — PresentationProfile v1.
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
 * Structural vocabulary stays with the Renderer and is profile-independent:
 *   cgFrame cgBody cgThread cgScroll cgTurn cgTurn--<role> cgMsg cgMsgBody
 *   cgBubble cgBubble--user cgBubbleRail
 * Structural node existence, role attributes, identity attributes and
 * accessibility are Renderer decisions, not profile decisions.
 *
 * The built-in `chatgpt-reference` profile maps the accepted ChatGPT-compatible
 * class vocabulary exactly as the Renderer emitted it before this contract
 * existed (S3A), so adopting the profile changes no effective class output.
 * Migrating those hooks out of global studio.css is S3C, not this module.
 *
 * Load order: after render-ir/semantic-ingress (no dependency on them; placed
 * there so later content-level consumption needs no load-order redesign) and
 * before content-renderer and chat-renderer, which consume it.
 */
(function installRendererPresentationProfile(global) {
  const H2O = global.H2O = global.H2O || {};
  const Studio = H2O.Studio = H2O.Studio || {};
  const Renderer = Studio.Renderer = Studio.Renderer || {};
  if (Renderer.presentationProfile && Renderer.presentationProfile.__installed) return;

  const SCHEMA = "h2o.renderer.presentation-profile";
  const SCHEMA_VERSION = 1;
  const API_VERSION = "0.1.0-m03-foundation";
  const REFERENCE_ID = "chatgpt-reference";

  /* Bounded inputs: the canonical roles and shell modes the Renderer already
   * normalizes to. Helpers reject anything else instead of manufacturing class
   * names from unconstrained strings. */
  const ROLES = Object.freeze(["user", "assistant", "system", "tool"]);
  const MODES = Object.freeze(["canonical", "rich"]);

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

  /*
   * Hook table shape (every value is a frozen array of class tokens):
   *   transcript[mode]        classes on the transcript root for the render mode
   *   turn.base / turn[mode] / turn.role[role]   turn shell presentation classes
   *   message[mode][role]     message host presentation modifier
   *   userBubble.compat       compatibility classes on the H2O rich user bubble
   *   userBubble.providerMarker   the provider class that locates a captured
   *                               bubble inside sanitized content
   */
  function defineProfile(definition) {
    const hooks = deepFreeze(definition.hooks);
    const profile = {
      id: definition.id,
      provider: definition.provider,
      displayName: definition.displayName,
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
      userBubbleMarkerClass() {
        return hooks.userBubble.providerMarker;
      },
    };
    return Object.freeze(profile);
  }

  const CHATGPT_REFERENCE = defineProfile({
    id: REFERENCE_ID,
    provider: "chatgpt",
    displayName: "ChatGPT reference presentation",
    hooks: {
      transcript: {
        canonical: ["wbRichRoot"],
        rich: ["wbRichRoot", "is-rich"],
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
        providerMarker: "user-message-bubble-color",
      },
    },
  });

  const PROFILES = Object.freeze({ [REFERENCE_ID]: CHATGPT_REFERENCE });

  function ids() {
    return Object.freeze(Object.keys(PROFILES));
  }

  /* Unknown ids resolve to null: a profile exists only if it is built in. */
  function get(id) {
    const key = typeof id === "string" ? id : "";
    return Object.prototype.hasOwnProperty.call(PROFILES, key) ? PROFILES[key] : null;
  }

  function reference() {
    return CHATGPT_REFERENCE;
  }

  Renderer.presentationProfile = Object.freeze({
    __installed: true,
    __version: API_VERSION,
    schema: SCHEMA,
    schemaVersion: SCHEMA_VERSION,
    referenceId: REFERENCE_ID,
    roles: ROLES,
    modes: MODES,
    ids,
    get,
    reference,
  });
})(typeof window !== "undefined" ? window : globalThis);
