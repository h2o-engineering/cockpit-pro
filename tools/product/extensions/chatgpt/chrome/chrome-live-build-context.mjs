// @version 1.1.0  (Phase 0G-2 migration: path constants imported from tools/paths.mjs)
//
// Phase 0G-2 note: SRC, OUT_DIR fallback, PROXY_PACK_URL fallback, and
// DEV_ORDER_FILE are now sourced from tools/paths.mjs. All env-var overrides
// preserved unchanged (H2O_SRC_DIR, H2O_EXT_OUT_DIR, H2O_EXT_DEV_VARIANT,
// H2O_EXT_PROXY_PACK_URL, H2O_EXT_MATCH). Behavior verified by file-by-file
// shasum comparison of the chrome-ext-controls build with locked H2O_BUILD_TS;
// the only inter-run variance is in loader.js's LOADER_BUILD_TS line (sourced
// from Date.now() inside chrome-live-loader.mjs, not from this file) — diff
// with `-I 'LOADER_BUILD_'` returns empty.
import path from "node:path";

import {
  REPO_ROOT,
  BUILD_DIR,
  DEV_ORDER_TSV,
  PROXY_PACK_URL as PATHS_PROXY_PACK_URL,
  extensionBuildDir,
} from "../../../../paths.mjs";
import { resolveChromeBuildStamp } from "./chrome-live-build-stamp.mjs";
import { deriveVariantFromOutDir, getExtensionId } from "./chrome-extension-keys.mjs";

export function createChromeLiveBuildContext() {
  // paths.REPO_ROOT honors H2O_SRC_DIR identically to the previous inline
  // `process.env.H2O_SRC_DIR || SRC_DEFAULT` compute. Under standard
  // invocation (no env override), SRC === <repo>/ matches pre-Phase-0G-2.
  const SRC = REPO_ROOT;
  const DEV_VARIANT_RAW = String(process.env.H2O_EXT_DEV_VARIANT || "controls").trim().toLowerCase();
  const DEV_VARIANT = DEV_VARIANT_RAW === "lean"
    ? "lean"
    : (DEV_VARIANT_RAW === "production" || DEV_VARIANT_RAW === "prod"
      ? "production"
      : (DEV_VARIANT_RAW === "studio-launcher" || DEV_VARIANT_RAW === "studio" || DEV_VARIANT_RAW === "launcher"
        ? "studio-launcher"
        : "controls"));
  const DEV_HAS_CONTROLS = DEV_VARIANT === "controls";
  // STUDIO_ONLY = Studio launcher variant. Reuses MANIFEST_PROFILE="production"
  // so the bg.js STUDIO_HOSTED_HERE gate activates the action.onClicked handler
  // and Studio assets are copied. The new STUDIO_ONLY flag adds a second gate
  // (read by chrome-live-manifest.mjs + build-chrome-live-extension.mjs) that
  // strips everything chatgpt.com-related: content_scripts, host_permissions,
  // loader.js, folder-bridge-page.js, pilot-observer-page.js, and the
  // identity-surface web_accessible_resources entry.
  const STUDIO_ONLY = DEV_VARIANT === "studio-launcher";
  const MANIFEST_PROFILE = (DEV_VARIANT === "production" || STUDIO_ONLY) ? "production" : "development";
  // Resolve every deterministic artifact identity field once. Production-
  // profile artifacts publicly claim this exact commit at runtime, so source
  // admission must prove tracked index/worktree bytes match HEAD before any
  // source snapshot or output write can occur. Development variants retain
  // their existing dirty-worktree workflow.
  const CHROME_BUILD_IDENTITY = resolveChromeBuildStamp({
    requireCommittedSource: MANIFEST_PROFILE === "production",
  });

  // OUT_DIR fallback now resolves via paths.extensionBuildDir(<variant>),
  // which composes paths.BUILD_DIR (= REPO_ROOT/build, env-overridable via
  // H2O_SRC_DIR through paths.mjs) with the canonical "chrome-ext-<variant>"
  // basename. Behavior is byte-identical to the pre-Phase-4B-1 inline
  // path.join compute. H2O_EXT_OUT_DIR override preserved as the highest-
  // precedence source — unchanged from pre-Phase-0G-2 semantics.
  const OUT_DIR =
    process.env.H2O_EXT_OUT_DIR ||
    extensionBuildDir(
      STUDIO_ONLY
        ? "studio-launcher"
        : (DEV_VARIANT === "production" ? "prod" : "dev-controls"),
    );

  // PROXY_PACK_URL: paths.PROXY_PACK_URL already encapsulates the
  // H2O_EXT_PROXY_PACK_URL env override + default URL composition. Under the
  // standard invocation this resolves to exactly the same string the inline
  // fallback used to produce.
  const PROXY_PACK_URL = PATHS_PROXY_PACK_URL;

  const CHAT_MATCH =
    process.env.H2O_EXT_MATCH ||
    "https://chatgpt.com/*";

  const STORAGE_KEY = "h2oExtDevToggleMapV1";
  const STORAGE_ORDER_OVERRIDES_KEY = "h2oExtDevOrderOverridesV1";
  const DEV_VERSION = "1.3.0";
  const DEV_TITLE = STUDIO_ONLY
    ? "H2O Studio Launcher"
    : (DEV_VARIANT === "production"
      ? "H2O Cockpit Pro"
      : (DEV_HAS_CONTROLS ? "H2O Dev Controls" : "H2O Dev Loader (Lean)"));
  const DEV_ACTION_TITLE = (STUDIO_ONLY || DEV_VARIANT === "production")
    ? "Open H2O Studio"
    : DEV_TITLE;
  const DEV_NAME = STUDIO_ONLY
    ? "H2O Studio Launcher (Unpacked)"
    : (DEV_VARIANT === "production"
      ? "H2O Cockpit Pro"
      : (DEV_HAS_CONTROLS ? "H2O Dev Controls (Unpacked)" : "H2O Dev Loader (Lean, Unpacked)"));
  const DEV_DESCRIPTION = STUDIO_ONLY
    ? "Opens H2O Studio. Does not inject anything into chatgpt.com — safe to run beside the H2O loader extension."
    : (DEV_VARIANT === "production"
      ? "Production-safe H2O Cockpit Pro extension profile for chatgpt.com."
      : (DEV_HAS_CONTROLS
        ? "Dev-only local loader with per-script toggles for H2O scripts on chatgpt.com."
        : "Dev-only local loader for H2O scripts on chatgpt.com (lean mode, no popup toggles)."));
  const DEV_TAG = STUDIO_ONLY
    ? "[H2O STUDIO]"
    : (DEV_VARIANT === "production"
      ? "[H2O PROD]"
      : (DEV_HAS_CONTROLS ? "[H2O DEV CTRL]" : "[H2O DEV LEAN]"));
  // DEV_ORDER_FILE: paths.DEV_ORDER_TSV honors H2O_ORDER_FILE additionally
  // (the pre-Phase-0G-2 inline compute did not honor any env override for this
  // path). Under the standard invocation (no env override), the resolved path
  // is byte-identical: <REPO_ROOT>/config/dev-order.tsv.
  const DEV_ORDER_FILE = DEV_ORDER_TSV;
  const PAGE_FOLDER_BRIDGE_FILE = "folder-bridge-page.js";
  // P3-pilot WAR observer (CSP-safe; replaces inline-textContent injection
  // that ChatGPT CSP blocked). Loaded via chrome.runtime.getURL when
  // localStorage.H2O_LOADER_V3_DISPATCHER_PILOT === "1".
  const PAGE_PILOT_OBSERVER_FILE = "pilot-observer-page.js";

  // T03 build visibility (additive; see resolveChromeBuildVisibility below). Resolved
  // from the same source-revision stamp so no second git/clock read is involved.
  const BUILD_VISIBILITY = resolveChromeBuildVisibility({
    manifestProfile: MANIFEST_PROFILE,
    studioOnly: STUDIO_ONLY,
    devHasControls: DEV_HAS_CONTROLS,
    devVersion: DEV_VERSION,
    variant: deriveVariantFromOutDir(OUT_DIR),
    sourceRevision: CHROME_BUILD_IDENTITY.sourceRevision,
  });

  return {
    SRC,
    CHROME_BUILD_IDENTITY,
    BUILD_VISIBILITY,
    OUT_DIR,
    PROXY_PACK_URL,
    CHAT_MATCH,
    STORAGE_KEY,
    STORAGE_ORDER_OVERRIDES_KEY,
    DEV_VARIANT,
    DEV_HAS_CONTROLS,
    STUDIO_ONLY,
    MANIFEST_PROFILE,
    DEV_VERSION,
    DEV_TITLE,
    DEV_ACTION_TITLE,
    DEV_NAME,
    DEV_DESCRIPTION,
    DEV_TAG,
    DEV_ORDER_FILE,
    PAGE_FOLDER_BRIDGE_FILE,
    PAGE_PILOT_OBSERVER_FILE,
  };
}

// ---------------------------------------------------------------------------
// T03 build visibility — leased additive input (semantic owner L-DEVELOPER-CONTROLS,
// implementing Lane L-DEVELOPER-BROWSER-TEST-ENVIRONMENT; Mission
// establish-governed-lane-browser-test-profiles-and-build-visibility, T03).
//
// Opt-in only: nothing is emitted unless H2O_EXT_BUILD_CHANNEL is set AND the
// build is either a development-profile Developer Controls family build or the
// exact studio-launcher variant. Production and other variants remain unchanged.
// Studio Launcher opts in only through its canonical publisher so its governed
// candidate can carry the same deterministic source/version identity without
// changing Host behavior.
// Every value derives from the deterministic source-revision stamp — never from
// the wall clock — so version_name is a fact about the committed source:
//   version_name = <DEV_VERSION>-<channel>+g<sha8>
// Optional environment identity (lane / surface / BTP / role) describes the
// environment this artifact was BUILT FOR; consumers still display runtime facts
// (chrome.runtime.getManifest(), chrome.runtime.id) as the loaded truth.
export const CHROME_BUILD_VISIBILITY = Object.freeze({
  CHANNEL_ENV: "H2O_EXT_BUILD_CHANNEL",
  LANE_KEY_ENV: "H2O_EXT_ENV_LANE_KEY",
  SURFACE_SET_ENV: "H2O_EXT_ENV_SURFACE_SET",
  BTP_KEY_ENV: "H2O_EXT_ENV_BTP_KEY",
  PROFILE_ROLE_ENV: "H2O_EXT_ENV_PROFILE_ROLE",
  NOT_ESTABLISHED: "NOT_ESTABLISHED",
  CHANNEL_PATTERN: /^[a-z][a-z0-9-]{0,23}$/,
  LANE_KEY_PATTERN: /^L-[A-Z0-9]+(?:-[A-Z0-9]+)*$/,
  SURFACE_SETS: Object.freeze(["CHAT", "STUDIO", "DUAL"]),
  BTP_KEY_PATTERN: /^BTP:L-[A-Z0-9]+(?:-[A-Z0-9]+)*:(?:PRIMARY|ALT\d{2}|ACCEPTANCE\d{2})$/,
  PROFILE_ROLE_PATTERN: /^(?:PRIMARY|ALT\d{2}|ACCEPTANCE\d{2})$/,
  FULL_COMMIT_SHA: /^[0-9a-f]{40}$/,
  PROMOTION_STATE_NOTE: "REGISTRY_SIDE_NOT_EMBEDDED",
});

function readOptionalIdentityInput(environment, envName, pattern, label) {
  const raw = String(environment?.[envName] || "").trim();
  if (!raw || raw === CHROME_BUILD_VISIBILITY.NOT_ESTABLISHED) return CHROME_BUILD_VISIBILITY.NOT_ESTABLISHED;
  if (!pattern.test(raw)) {
    throw new Error(`[H2O] ${envName} is not a valid ${label}: ${JSON.stringify(raw)}`);
  }
  return raw;
}

export function resolveChromeBuildVisibility({
  environment = process.env,
  manifestProfile = "development",
  studioOnly = false,
  devHasControls = false,
  devVersion = "1.3.0",
  variant = null,
  sourceRevision = null,
} = {}) {
  const channel = String(environment?.[CHROME_BUILD_VISIBILITY.CHANNEL_ENV] || "").trim();
  const studioLauncherIdentity = studioOnly === true && variant === "studio-launcher";
  const developmentIdentity = manifestProfile === "development" && studioOnly !== true;
  const enabled = channel !== "" && (developmentIdentity || studioLauncherIdentity);
  const disabled = Object.freeze({
    enabled: false,
    channel: null,
    version: devVersion,
    versionName: null,
    sourceRevision: null,
    sourceRevisionShort: null,
    variant: variant || null,
    registeredExtensionId: variant ? getExtensionId(variant) : null,
    manifestProfile,
    devHasControls,
    laneKey: CHROME_BUILD_VISIBILITY.NOT_ESTABLISHED,
    surfaceSet: CHROME_BUILD_VISIBILITY.NOT_ESTABLISHED,
    btpKey: CHROME_BUILD_VISIBILITY.NOT_ESTABLISHED,
    profileRole: CHROME_BUILD_VISIBILITY.NOT_ESTABLISHED,
    promotionState: CHROME_BUILD_VISIBILITY.PROMOTION_STATE_NOTE,
  });
  if (!enabled) return disabled;
  if (!CHROME_BUILD_VISIBILITY.CHANNEL_PATTERN.test(channel)) {
    throw new Error(
      `[H2O] ${CHROME_BUILD_VISIBILITY.CHANNEL_ENV} must match ${CHROME_BUILD_VISIBILITY.CHANNEL_PATTERN}: ${JSON.stringify(channel)}`,
    );
  }
  const revision = String(sourceRevision || resolveChromeBuildStamp().sourceRevision || "").trim().toLowerCase();
  if (!CHROME_BUILD_VISIBILITY.FULL_COMMIT_SHA.test(revision)) {
    throw new Error("[H2O] build visibility requires the exact full source revision from the build stamp");
  }
  const V = CHROME_BUILD_VISIBILITY;
  return Object.freeze({
    ...disabled,
    enabled: true,
    channel,
    versionName: `${devVersion}-${channel}+g${revision.slice(0, 8)}`,
    sourceRevision: revision,
    sourceRevisionShort: revision.slice(0, 8),
    laneKey: readOptionalIdentityInput(environment, V.LANE_KEY_ENV, V.LANE_KEY_PATTERN, "canonical Lane key"),
    surfaceSet: (() => {
      const raw = String(environment?.[V.SURFACE_SET_ENV] || "").trim();
      if (!raw || raw === V.NOT_ESTABLISHED) return V.NOT_ESTABLISHED;
      if (!V.SURFACE_SETS.includes(raw)) throw new Error(`[H2O] ${V.SURFACE_SET_ENV} must be one of ${V.SURFACE_SETS.join("|")}: ${JSON.stringify(raw)}`);
      return raw;
    })(),
    btpKey: readOptionalIdentityInput(environment, V.BTP_KEY_ENV, V.BTP_KEY_PATTERN, "BTP key"),
    profileRole: readOptionalIdentityInput(environment, V.PROFILE_ROLE_ENV, V.PROFILE_ROLE_PATTERN, "profile role"),
  });
}

// Convenience for the leased generator modules (manifest, README, popup), which
// receive no orchestrator plumbing: resolve the same context the orchestrator
// resolved and hand back its BUILD_VISIBILITY.
export function resolveChromeBuildVisibilityFromEnvironment() {
  return createChromeLiveBuildContext().BUILD_VISIBILITY;
}
