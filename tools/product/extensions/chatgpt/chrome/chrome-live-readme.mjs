// @version 1.1.0  (Phase 0J: README content is now deterministic — no longer embeds OUT_DIR absolute path)
import path from "node:path";

import { resolveChromeBuildVisibilityFromEnvironment } from "./chrome-live-build-context.mjs";

export function makeChromeLiveReadme({
  OUT_DIR,
  PROXY_PACK_URL,
  DEV_HAS_CONTROLS,
}) {
  // Phase 0J: was `path.resolve(OUT_DIR)`, which embedded the absolute build
  // path into README.txt. That made the README differ across builds into
  // different OUT_DIRs (e.g. /tmp/build-a vs /tmp/build-b vs each developer's
  // own checkout path) even when H2O_BUILD_TS was locked, blocking full
  // build determinism (the last remaining non-deterministic file after 0H).
  // Replaced with a constant string. OUT_DIR + `path` import are retained for
  // caller-signature compatibility and possible future use.
  const outAbs = "(the directory containing this README file)";
  // Suppress unused-import warnings under stricter lint tooling without
  // removing the legacy import. (`path` was previously used at this site.)
  void path; void OUT_DIR;
  if (!DEV_HAS_CONTROLS) {
    return appendBuildIdentityLines(`H2O Dev Loader Extension (Lean, Unpacked)
==========================================

This is the DEV-only lean loader extension button (no popup toggles).

How it works:
- Content script fetches:
  ${PROXY_PACK_URL}
- It parses the proxy pack, then merges with the local scripts catalog and loads by @run-at phase.
- It skips chrome.storage toggle reads for slightly faster startup.

IMPORTANT:
- Keep your local server running on 127.0.0.1:5500.
- Disable H2O Dev Controls if both point to the same page (avoid duplicate injection).

Install:
1) Open chrome://extensions
2) Enable Developer mode
3) Click Load unpacked
4) Select this folder:
   ${outAbs}

Daily workflow:
1) Run Common / 3
2) Run the lean DEV build task (or lean combined task)
3) Refresh chatgpt.com tab
`);
  }

  return appendBuildIdentityLines(`H2O Dev Controls Extension (Unpacked)
=====================================

This is the DEV-only extension button with per-script toggles.

How it works:
- Content script fetches:
  ${PROXY_PACK_URL}
- It reads per-script toggles from chrome.storage.local.
- It loads enabled scripts from proxy-pack + local scripts catalog (grouped by @run-at phase).
- Popup shows the visible scripts list and lets you toggle/hide per script.

IMPORTANT:
- Keep your local server running on 127.0.0.1:5500.
- Toggle changes apply on page reload.
- Disable old TM proxy scripts while using this extension.

Install:
1) Open chrome://extensions
2) Enable Developer mode
3) Click Load unpacked
4) Select this folder:
   ${outAbs}

Daily workflow:
1) Run Common / 3 (or the combined DEV workflow task)
2) Reload this extension (if loader changed)
3) Use the popup to toggle scripts
4) Refresh chatgpt.com tab
`);
}

// T03 (leased, additive; semantic owner L-DEVELOPER-CONTROLS): identity lines are
// appended only for opt-in development-profile Developer Controls family builds, so
// production / studio-launcher README bytes are unchanged. The artifact digest is
// deliberately NOT embedded (it would be self-referential); the Browser Testing
// artifact registry computes it over the emitted tree and records it beside the
// promotion state.
function appendBuildIdentityLines(readme) {
  const visibility = resolveChromeBuildVisibilityFromEnvironment();
  if (!visibility.enabled) return readme;
  return `${readme}
Build identity (T03 build visibility, opt-in):
- version:            ${visibility.version}
- version_name:       ${visibility.versionName}
- source_revision:    ${visibility.sourceRevision}
- variant:            ${visibility.variant} (manifest profile ${visibility.manifestProfile}, channel ${visibility.channel})
- registered_ext_id:  ${visibility.registeredExtensionId || "NOT_REGISTERED"}
- built_for_lane:     ${visibility.laneKey}
- built_for_btp:      ${visibility.btpKey} (role ${visibility.profileRole})
- built_for_surface:  ${visibility.surfaceSet}
- promotion_state:    ${visibility.promotionState}
- artifact_digest:    computed by the Browser Testing artifact registry as
                      sha256 over sorted "<relpath>\\0<sha256(file)>" lines of every
                      regular file in this directory (never embedded here)
`;
}
