// @version 1.1.0  (Phase 8A-1: EXTENSION_KEY parameter — injects stable
//                  manifest "key" so Chrome derives the extension ID from
//                  the public key instead of the load-path string. The
//                  build orchestrator looks up the per-variant key from
//                  config/extension-keys.json.)
const STUDIO_LAUNCHER_EXTENSION_ID = "bpobkkppdlldlkccaehmpfclmkhiemhg";

export function makeChromeLiveManifest({
  PROXY_PACK_URL,
  CHAT_MATCH,
  PAGE_FOLDER_BRIDGE_FILE,
  PAGE_PILOT_OBSERVER_FILE,
  DEV_HAS_CONTROLS,
  DEV_TITLE,
  DEV_ACTION_TITLE,
  DEV_NAME,
  DEV_VERSION,
  DEV_DESCRIPTION,
  MANIFEST_PROFILE = "development",
  IDENTITY_PROVIDER_OPTIONAL_HOST_PERMISSIONS = [],
  IDENTITY_PROVIDER_REQUEST_OTP_ARMED = false,
  IDENTITY_PROVIDER_OAUTH_PROVIDER = null,
  TITLE_DIAGNOSTIC_ENABLED = false,
  TITLE_CONTRACT_BRIDGE_FILE = null,
  STUDIO_ONLY = false,
  EXTENSION_KEY = null,
}) {
  function originWildcard(urlStr) {
    try {
      const u = new URL(urlStr);
      return `${u.protocol}//${u.host}/*`;
    } catch {
      return "http://127.0.0.1:5500/*";
    }
  }

  const manifestProfile = String(MANIFEST_PROFILE || "development").trim().toLowerCase() === "production"
    ? "production"
    : "development";
  const hostPerm = originWildcard(PROXY_PACK_URL);
  const extraHostPerms = String(process.env.H2O_EXT_HOST_PERMS || "*://*/*")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const requestOtpArmed = IDENTITY_PROVIDER_REQUEST_OTP_ARMED === true;
  const oauthProvider = String(IDENTITY_PROVIDER_OAUTH_PROVIDER || "").trim().toLowerCase();
  const oauthGoogleEnabled = oauthProvider === "google";
  // Studio Launcher: no content_scripts and no dev-proxy host_permission. It
  // does keep a narrow chatgpt.com host permission so the Studio page can ask
  // the service worker to refresh metadata for imported ChatGPT URL rows
  // without direct extension-page fetches that CORS will block.
  const hostPermissions = STUDIO_ONLY
    ? [CHAT_MATCH]
    : (manifestProfile === "production"
      ? [CHAT_MATCH]
      : (requestOtpArmed
        ? Array.from(new Set([CHAT_MATCH, hostPerm].filter(Boolean)))
        : Array.from(new Set([hostPerm, ...extraHostPerms]))));
  const optionalHostPermissions = Array.from(new Set(
    (Array.isArray(IDENTITY_PROVIDER_OPTIONAL_HOST_PERMISSIONS) ? IDENTITY_PROVIDER_OPTIONAL_HOST_PERMISSIONS : [])
      .map((value) => String(value || "").trim().toLowerCase())
      .filter((value) => /^https:\/\/[a-z0-9-]+\.supabase\.co\/\*$/.test(value)),
  ));
  const action = {
    default_title: DEV_ACTION_TITLE || DEV_TITLE,
    default_icon: {
      "16": "icon16.png",
      "32": "icon32.png",
    },
  };
  if (DEV_HAS_CONTROLS) action.default_popup = "popup.html";
  const permissions = DEV_HAS_CONTROLS || STUDIO_ONLY
    ? ["storage", "tabs", "contextMenus"]
    : ["storage", "contextMenus"];
  if (oauthGoogleEnabled) permissions.push("identity");
  // Accepted object-sync: the alarm-driven background reconcile owner is a production-profile capability only.
  if (manifestProfile === "production") permissions.push("alarms");
  if (TITLE_DIAGNOSTIC_ENABLED === true) permissions.push("webNavigation", "scripting");
  const manifest = {
    manifest_version: 3,
    name: DEV_NAME,
    version: DEV_VERSION,
    description: DEV_DESCRIPTION,
    ...(EXTENSION_KEY ? { key: EXTENSION_KEY } : {}),
    permissions,
    icons: {
      "16": "icon16.png",
      "32": "icon32.png",
      "48": "icon48.png",
      "128": "icon128.png",
    },
    action,
    background: {
      service_worker: "bg.js",
    },
    host_permissions: hostPermissions,
    // Studio Launcher: NO content_scripts. The whole point of this variant is
    // to expose Studio without injecting anything into chatgpt.com (which
    // would race the Dev Controls / Cockpit Pro loader).
    ...(STUDIO_ONLY ? {} : {
      content_scripts: [
        {
          matches: [CHAT_MATCH],
          js: ["loader.js"],
          run_at: "document_start",
        },
      ],
    }),
    // Studio Launcher: empty web_accessible_resources. Both the folder bridge
    // and the pilot observer are content-script support files for the chatgpt
    // injection path; with no content_scripts they have nothing to talk to.
    // (The build script also omits these files from the studio-launcher
    // output entirely.)
    web_accessible_resources: STUDIO_ONLY ? [] : [
      {
        resources: [PAGE_FOLDER_BRIDGE_FILE, TITLE_CONTRACT_BRIDGE_FILE].filter(Boolean),
        matches: [CHAT_MATCH],
      },
      // P3-pilot WAR observer (loaded only when the pilot flag is on; harmless
      // to expose unconditionally — it's no-op without the flag-checked
      // injection from the loader).
      ...(PAGE_PILOT_OBSERVER_FILE ? [{
        resources: [PAGE_PILOT_OBSERVER_FILE],
        matches: [CHAT_MATCH],
      }] : []),
    ],
  };
  if (optionalHostPermissions.length) {
    manifest.optional_host_permissions = optionalHostPermissions;
  }
  if (DEV_HAS_CONTROLS && manifestProfile !== "production" && !requestOtpArmed) {
    manifest.externally_connectable = { ids: ["*"] };
  } else if (!STUDIO_ONLY) {
    manifest.externally_connectable = { ids: [STUDIO_LAUNCHER_EXTENSION_ID] };
  }
  return manifest;
}
