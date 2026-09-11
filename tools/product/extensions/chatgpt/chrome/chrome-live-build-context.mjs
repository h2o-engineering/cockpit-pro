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

  return {
    SRC,
    CHROME_BUILD_IDENTITY,
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
