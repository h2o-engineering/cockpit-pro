// @version 1.0.0
"use strict";

/*
 * H2O Studio Renderer — H2O Clean Reader PresentationProfile (M04 P2 T3).
 *
 * Owner:   L-STUDIO-RENDERER
 * Profile: h2o-clean-reader (H2O.Studio.Renderer.presentationProfile)
 *
 * The first non-reference profile admitted through the governed registry.
 * It decides only how the accepted H2O structure LOOKS in a quiet,
 * reading-first presentation: no provider bubble skin, no provider utility or
 * design-token bridge, calm typography over the shared --wb-* theme tokens.
 * Which nodes exist, their role, identity, accessibility, edit semantics and
 * security policy stay Renderer decisions; the sanitizer, Markdown, semantic
 * ingress and the Semantic Index never see a profile. Semantic content is
 * therefore identical to the reference profile by construction.
 *
 * Hooks: the transcript, turn, message and bubble presentation hooks are
 * deliberately EMPTY - the stylesheet keys on Renderer structural vocabulary
 * (cgTurn--<role>, cgMsg[data-message-author-role], cgMsgBody, cgBubble--user)
 * beneath the profile root marker instead of adding presentation classes.
 * Only the content hooks (code block container / language badge) and the
 * edit-state hooks are profile-local class tokens, so the stylesheet can skin
 * those slots without claiming Renderer vocabulary.
 *
 * Runtime contract (EXT-RUNTIME-ADMISSION, HDA decision A): this classic script
 * loads synchronously immediately after presentation-profile.v1.js and before
 * content-renderer.v1.js / chat-renderer.studio.js, and registers during its
 * own evaluation while registration is still open. There is no async or
 * deferred registration, no self-sealing and no loader; the first
 * chatRenderer.render() in the document remains the sealing boundary. A
 * missing or incompatible registry API, or a rejected registration, throws
 * here and surfaces through the ordinary script failure mechanism: the profile
 * is then simply not registered, and an explicit selection of it resolves to
 * the reference profile with reason "unknown-profile-fallback", which is NOT
 * evidence of admission.
 *
 * Accepted limitation (Clean Reader v1): captured ChatGPT rich content
 * receives the global compatibility baseline (studio.css .wbRichRoot rules)
 * plus this profile's element rules only. It carries no provider utility
 * classes, token aliases or prose bridge, so provider-fidelity presentation of
 * captured markup is not promised by this profile.
 */
(function installH2OCleanReaderPresentationProfile(global) {
  const PROFILE_ID = "h2o-clean-reader";
  const REGISTRY_SCHEMA = "h2o.renderer.presentation-profile";
  const REGISTRY_SCHEMA_VERSION = 1;

  function admissionFailure(message) {
    return new Error(`h2o-clean-reader: ${message}`);
  }

  const registry = global.H2O && global.H2O.Studio && global.H2O.Studio.Renderer
    ? global.H2O.Studio.Renderer.presentationProfile
    : null;
  if (!registry || registry.__installed !== true) {
    throw admissionFailure("the PresentationProfile registry is not installed; renderer/presentation/presentation-profile.v1.js must load first");
  }
  if (registry.schema !== REGISTRY_SCHEMA || registry.schemaVersion !== REGISTRY_SCHEMA_VERSION
    || typeof registry.define !== "function" || typeof registry.register !== "function"
    || typeof registry.get !== "function" || typeof registry.sealed !== "function") {
    throw admissionFailure(`incompatible PresentationProfile registry API (${String(registry.schema)} v${String(registry.schemaVersion)}, ${String(registry.__version)})`);
  }
  if (registry.sealed() === true) {
    throw admissionFailure("the PresentationProfile registry is already sealed; this script must load before the first render");
  }

  /* Empty presentation tables: no class hook on any transcript / turn /
   * message shell or on the H2O rich user bubble. */
  const NO_ROLE_CLASSES = { user: [], assistant: [], system: [], tool: [] };

  /* register() throws on a duplicate id, a rejected definition or a sealed
   * registry; none of those is caught here (see the runtime contract above). */
  const profile = registry.register(registry.define({
    id: PROFILE_ID,
    owner: "L-STUDIO-RENDERER",
    version: "1.0.0",
    displayName: "H2O Clean Reader",
    provider: null,
    stylesheet: { href: "renderer/presentation/h2o-clean-reader.v1.css", version: "1.0.1" },
    modes: ["canonical", "rich"],
    hooks: {
      transcript: { canonical: [], rich: [] },
      turn: { base: [], canonical: [], rich: [], role: NO_ROLE_CLASSES },
      message: { canonical: NO_ROLE_CLASSES, rich: NO_ROLE_CLASSES },
      userBubble: { compat: [] },
      content: {
        codeBlock: {
          container: ["h2oCleanCode"],
          language: ["h2oCleanCodeLang"],
        },
      },
      state: {
        edited: {
          turn: ["h2oCleanTurn--edited"],
          message: ["h2oCleanMsg--edited"],
        },
      },
    },
  }));

  if (registry.get(PROFILE_ID) !== profile) {
    throw admissionFailure("the registered profile is not observable through the registry");
  }
})(typeof window !== "undefined" ? window : globalThis);
