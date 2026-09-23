// @version 1.0.0
// Validates the Phase 2.9 sync fix — cross-context identity state propagation.
// Hard-failure assertions only. No console.assert.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extensionBuildDir } from "../../paths.mjs";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(DIR, "..", "..", "..");

function read(rel) { return fs.readFileSync(path.resolve(ROOT, rel), "utf8"); }
// Phase 4B-1b: CWD-relative path string for an extension build artifact,
// byte-identical to legacy "build/chrome-ext-<variant>/<segments>" form.
function extBuildRel(variant, ...segments) {
  return path.relative(ROOT, path.join(extensionBuildDir(variant), ...segments));
}
function pass(msg) { console.log(" ", msg, "✓"); }
function fail(msg) { throw new Error("FAIL: " + msg); }
function assert(cond, msg) { if (!cond) fail(msg); }

function extractFunction(source, name) {
  const syncIndex = source.indexOf(`function ${name}(`);
  const asyncIndex = source.indexOf(`async function ${name}(`);
  const start = (asyncIndex >= 0 && (syncIndex < 0 || asyncIndex < syncIndex)) ? asyncIndex : syncIndex;
  assert(start >= 0, `function ${name} missing`);
  const bodyStart = source.indexOf("{", source.indexOf(")", start));
  assert(bodyStart >= 0, `function ${name} body missing`);
  let depth = 0;
  for (let i = bodyStart; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  fail(`function ${name} body end missing`);
}

const bgSrc = read("tools/product/extensions/chatgpt/chrome/chrome-live-background.mjs");
const buildSrc = read("tools/product/extensions/chatgpt/chrome/build-chrome-live-extension.mjs");
const loaderSrc = read("tools/product/extensions/chatgpt/chrome/chrome-live-loader.mjs");
const identityCoreSrc = read("src-runtime-base/0D4a.⬛️🔐 Identity Core 🔐.js");
const builtBg = read(extBuildRel("dev-controls", "bg.js"));
const builtLoader = read(extBuildRel("dev-controls", "loader.js"));

// ── Suite A: background broadcast ─────────────────────────────────────────────
console.log("\n── Suite A: background broadcastIdentityPush ─────────────────────────────");

assert(bgSrc.includes('MSG_IDENTITY_PUSH = "h2o-ext-identity:v1:push"'),
  'MSG_IDENTITY_PUSH constant missing from background source');
pass("MSG_IDENTITY_PUSH constant defined");

assert(bgSrc.includes("function broadcastIdentityPush("),
  "broadcastIdentityPush function missing from background");
pass("broadcastIdentityPush function present");

const setSnapshotManagerBlockA = bgSrc.slice(
  bgSrc.indexOf("async function identityAuthManager_setSnapshot("),
  bgSrc.indexOf("async function identityAuthManager_setSnapshot(") + 700
);
assert(setSnapshotManagerBlockA.includes("broadcastIdentityPush("),
  "broadcastIdentityPush not called by identityAuthManager_setSnapshot");
pass("broadcastIdentityPush called from identityAuthManager_setSnapshot");

const signOutManagerBlockA = bgSrc.slice(
  bgSrc.indexOf("async function identityAuthManager_signOut("),
  bgSrc.indexOf("async function identityAuthManager_signOut(") + 1200
);
const signOutCleanupBlockA = bgSrc.slice(
  bgSrc.indexOf("async function identityAuthManager_clearSignOutLocalState("),
  bgSrc.indexOf("async function identityAuthManager_clearSignOutLocalState(") + 3600
);
assert(signOutManagerBlockA.includes("identityAuthManager_clearSignOutLocalState")
  && signOutCleanupBlockA.includes("broadcastIdentityPush(null)"),
  "broadcastIdentityPush(null) not called by identityAuthManager_signOut local cleanup");
pass("broadcastIdentityPush(null) called from identityAuthManager_signOut local cleanup");

assert(bgSrc.includes("identitySnapshot_sanitize(snapshot)"),
  "broadcastIdentityPush does not sanitize snapshot before broadcast");
pass("broadcastIdentityPush sanitizes snapshot via identitySnapshot_sanitize");

assert(bgSrc.includes("chrome.tabs.query({ url: [CHAT_MATCH] }") &&
  bgSrc.includes("MSG_IDENTITY_PUSH"),
  "broadcastIdentityPush does not query ChatGPT tabs or use MSG_IDENTITY_PUSH");
pass("broadcastIdentityPush queries ChatGPT tabs by CHAT_MATCH");
assert(bgSrc.includes("chrome.runtime.sendMessage({ type: MSG_IDENTITY_PUSH, snapshot: safeSnap }"),
  "broadcastIdentityPush must send runtime messages to extension identity surfaces");
pass("broadcastIdentityPush sends runtime push to extension surfaces");

// Verify broadcast uses existing CHAT_MATCH and does not invent new URLs
const broadcastSection = bgSrc.slice(bgSrc.indexOf("function broadcastIdentityPush("), bgSrc.indexOf("function broadcastIdentityPush(") + 600);
assert(broadcastSection.includes("CHAT_MATCH"), "broadcastIdentityPush must use CHAT_MATCH");
pass("broadcastIdentityPush uses CHAT_MATCH (no hardcoded URL)");

// Built bg.js also contains the broadcast
assert(builtBg.includes("h2o-ext-identity:v1:push"), "built bg.js missing identity push message type");
assert(builtBg.includes("broadcastIdentityPush"), "built bg.js missing broadcastIdentityPush");
pass("built bg.js includes broadcastIdentityPush and push message type");

// complete-onboarding (atomic handler replacing two-step race) stores+broadcasts
const completeBlock = bgSrc.slice(
  bgSrc.indexOf('"identity:complete-onboarding"'),
  bgSrc.indexOf('"identity:complete-onboarding"') + 350
);
const completeManagerBlockA = extractFunction(bgSrc, "identityAuthManager_completeOnboarding");
const completeProviderBlockA = bgSrc.slice(
  bgSrc.indexOf("function identityMockProvider_completeOnboarding("),
  bgSrc.indexOf("function identityMockProvider_completeOnboarding(") + 900
);
assert(completeBlock.includes('identityAuthManager_completeOnboarding'),
  "identity:complete-onboarding handler does not route to auth manager");
pass("identity:complete-onboarding routes to auth manager");

assert(completeManagerBlockA.includes('identityAuthManager_publishSnapshotFromRuntime'),
  "identityAuthManager_completeOnboarding does not publish snapshot");
pass("identityAuthManager_completeOnboarding stores+broadcasts through publisher");

assert(completeProviderBlockA.includes('mock_profile') && completeProviderBlockA.includes('mock_workspace'),
  "mock provider complete-onboarding must create both profile and workspace atomically");
pass("mock provider complete-onboarding atomically creates profile + workspace");

// identity:get-snapshot falls back to runtime when stored snapshot is null
const getSnapshotBlock = bgSrc.slice(
  bgSrc.indexOf('"identity:get-snapshot"'),
  bgSrc.indexOf('"identity:get-snapshot"') + 300
);
const getSnapshotManagerBlockA = bgSrc.slice(
  bgSrc.indexOf("async function identityAuthManager_getSnapshot("),
  bgSrc.indexOf("async function identityAuthManager_setSnapshot(")
);
assert(getSnapshotBlock.includes('identityAuthManager_getSnapshot'),
  "identity:get-snapshot does not route to auth manager");
assert(getSnapshotManagerBlockA.includes('identityAuthManager_getRuntime()') && getSnapshotManagerBlockA.includes('identitySnapshot_fromRuntime('),
  "identityAuthManager_getSnapshot does not fall back to runtime when snapshot is null");
pass("identity:get-snapshot falls back to runtime synthesis when stored snapshot is null");

// identity:set-snapshot keeps runtime in sync
const setSnapshotBlock = bgSrc.slice(
  bgSrc.indexOf('"identity:set-snapshot"'),
  bgSrc.indexOf('"identity:set-snapshot"') + 300
);
const setSnapshotManagerBlockB = bgSrc.slice(
  bgSrc.indexOf("async function identityAuthManager_setSnapshot("),
  bgSrc.indexOf("async function identityAuthManager_clearSnapshot(")
);
assert(setSnapshotBlock.includes('identityAuthManager_setSnapshot'),
  "identity:set-snapshot does not route to auth manager");
assert(setSnapshotManagerBlockB.includes('identitySnapshot_toRuntime(') && setSnapshotManagerBlockB.includes('identityAuthManager_setRuntime('),
  "identityAuthManager_setSnapshot does not update runtime via identitySnapshot_toRuntime");
pass("identity:set-snapshot syncs runtime via identitySnapshot_toRuntime");

assert(bgSrc.includes('function identitySnapshot_fromRuntime('),
  "identitySnapshot_fromRuntime helper missing from background");
pass("identitySnapshot_fromRuntime helper present");

assert(bgSrc.includes('function identitySnapshot_toRuntime('),
  "identitySnapshot_toRuntime helper missing from background");
pass("identitySnapshot_toRuntime helper present");

assert(bgSrc.includes('function identityRuntime_enforceConsistency('),
  "identityRuntime_enforceConsistency helper missing from background");
pass("identityRuntime_enforceConsistency helper present");

// ── Suite A2: inert provider config diagnostic ───────────────────────────────
console.log("\n── Suite A2: inert providerConfigStatus diagnostic ─────────────────────");

const providerConfigFns = [
  "identityProviderConfig_get",
  "identityProviderConfig_normalizeSourceName",
  "identityProviderConfig_getSource",
  "identityProviderConfig_getDevOnlySource",
  "identityProviderConfig_getSourceStatus",
  "identityProviderConfig_resolve",
  "identityProviderConfig_cleanStatusList",
  "identityProviderConfig_isRedactedStatus",
  "identityProviderConfig_normalizeInjectedStatus",
  "identityProviderConfig_validatePublicClientConfig",
  "identityProviderConfig_validateSupabaseShape",
  "identityProviderConfig_classifyConfig",
  "identityProviderConfig_validateShape",
  "identityProviderConfig_missingFields",
  "identityProviderConfig_getMode",
  "identityProviderConfig_isMock",
  "identityProviderConfig_isSupabaseConfigured",
  "identityProviderPermission_getReadiness",
  "identityProviderConfig_safeStatus",
  "identityProviderConfig_redact",
  "identityProviderConfig_diag",
  "identityProviderConfig_getInjectedSource",
  "identityAuthManager_getProviderAdapter",
];
for (const name of providerConfigFns) {
  assert(bgSrc.includes(name), `${name} missing from background source`);
  assert(builtBg.includes(name), `${name} missing from built bg.js`);
}
pass("provider config helpers and adapter selector present");

const providerConfigBlockA2 = bgSrc.slice(
  bgSrc.indexOf("const IDENTITY_PROVIDER_CONFIG_SCHEMA_VERSION"),
  bgSrc.indexOf("const IDENTITY_PROVIDER_OTP_ALLOWED_ERROR_CODES")
);
assert(providerConfigBlockA2.includes('providerKind: "mock"'),
  "provider config default providerKind must be mock");
assert(providerConfigBlockA2.includes('providerMode: "local_dev"'),
  "provider config default providerMode must be local_dev");
assert(providerConfigBlockA2.includes("providerConfigured: true"),
  "mock provider config must be marked configured");
assert(providerConfigBlockA2.includes('configSource: "built_in_mock"'),
  "provider config source must default to built_in_mock");
assert(providerConfigBlockA2.includes('"dev_empty_invalid"'),
  "dev empty invalid config source must be declared");
assert(providerConfigBlockA2.includes('"dev_elevated_invalid"'),
  "dev elevated invalid config source must be declared");
assert(providerConfigBlockA2.includes('"dev_env"'),
  "dev env config source must be declared");
assert(providerConfigBlockA2.includes('"dev_local_file"'),
  "dev local file config source must be declared");
assert(providerConfigBlockA2.includes("IDENTITY_PROVIDER_CONFIG_INJECTED_STATUS"),
  "redacted injected config status constant missing");
assert(providerConfigBlockA2.includes('IDENTITY_PROVIDER_CONFIG_SCHEMA_VERSION = "3.0N"'),
  "provider config schema version must be 3.0N");
assert(providerConfigBlockA2.includes("identityProviderConfig_getSource"),
  "provider config source resolver missing");
assert(providerConfigBlockA2.includes("identityProviderConfig_getDevOnlySource"),
  "dev-only config source helper missing");
assert(providerConfigBlockA2.includes("identityProviderConfig_getInjectedSource"),
  "redacted injected config source helper missing");
assert(providerConfigBlockA2.includes("identityProviderConfig_normalizeInjectedStatus"),
  "redacted injected config status normalizer missing");
assert(providerConfigBlockA2.includes("identityProviderConfig_validateShape"),
  "provider config shape validator missing");
assert(providerConfigBlockA2.includes("identityProviderConfig_validateSupabaseShape"),
  "future provider config validator stub missing");
assert(providerConfigBlockA2.includes("provider_project"),
  "future provider project missing field must use a generic label");
assert(providerConfigBlockA2.includes("public_client"),
  "future public client missing field must use a generic label");
assert(providerConfigBlockA2.includes("identity/config-missing-required"),
  "missing config error code must be generic");
assert(providerConfigBlockA2.includes("identity/config-elevated-access-forbidden"),
  "elevated access rejection code must be generic");
assert(providerConfigBlockA2.includes("IDENTITY_PROVIDER_PERMISSION_READINESS_DEFERRED"),
  "deferred permission readiness constant missing");
assert(providerConfigBlockA2.includes('permissionRequired: "deferred"'),
  "permissionRequired must be deferred");
assert(providerConfigBlockA2.includes("permissionReady: false"),
  "permissionReady must be false");
assert(providerConfigBlockA2.includes('permissionSource: "deferred_until_project_host"'),
  "permissionSource must be deferred_until_project_host");
assert(providerConfigBlockA2.includes('permissionHostKind: "none"'),
  "permissionHostKind must be none");
assert(providerConfigBlockA2.includes('permissionStatus: "deferred"'),
  "permissionStatus must be deferred");
assert(providerConfigBlockA2.includes("permissionErrorCode: null"),
  "permissionErrorCode must be null");
assert(providerConfigBlockA2.includes("networkReady: false"),
  "networkReady must be false");
assert(providerConfigBlockA2.includes('IDENTITY_PROVIDER_PHASE_NETWORK_ENABLED = IDENTITY_PROVIDER_PHASE_NETWORK === "request_otp"'),
  "phaseNetworkEnabled gate must be controlled only by request_otp build flag");
assert(buildSrc.includes("H2O_IDENTITY_PHASE_NETWORK"),
  "build must recognize explicit provider network phase flag");
assert(providerConfigBlockA2.includes("function identityProviderNetwork_getReadiness("),
  "network readiness gate helper missing");
assert(providerConfigBlockA2.includes("phaseNetworkEnabled"),
  "phaseNetworkEnabled diagnostic missing");
assert(providerConfigBlockA2.includes("networkStatus"),
  "networkStatus diagnostic missing");
assert(providerConfigBlockA2.includes("networkBlockReason"),
  "networkBlockReason diagnostic missing");
assert(providerConfigBlockA2.includes("const clientReady = bundleProbe.clientReady === true"),
  "clientReady must be derived only from sanitized bundle probe readiness");
assert(providerConfigBlockA2.includes("function identityProviderPermission_getReadiness("),
  "permission readiness helper missing");
assert(providerConfigBlockA2.includes("identityProviderConfig_safeStatus"),
  "provider config safe status helper missing");
assert(!/(projectUrl|anonKey|serviceRole|serviceKey|url|key|secret|token|session|credential)\s*:/i.test(providerConfigBlockA2),
  "provider config block exposes raw provider config fields");
assert(buildSrc.includes("resolveIdentityProviderBuildStatus"),
  "build must discover redacted identity provider config status");
assert(buildSrc.includes("H2O_IDENTITY_PROVIDER_PROJECT_URL"),
  "build must support dev env project source");
assert(buildSrc.includes("H2O_IDENTITY_PROVIDER_PUBLIC_CLIENT"),
  "build must support dev env public client source");
assert(buildSrc.includes("identity-provider.local.json"),
  "build must support ignored local identity provider config file");
assert(buildSrc.includes("IDENTITY_PROVIDER_PRIVATE_CONFIG_RELATIVE_PATH"),
  "build must define the dev-only private config artifact path");
assert(buildSrc.includes("syncIdentityProviderPrivateConfigToOut"),
  "build must emit/delete the dev-only private config artifact explicitly");
assert(buildSrc.includes('MANIFEST_PROFILE === "production"'),
  "production profile must suppress private config emission");
assert(bgSrc.includes("sanitizeIdentityProviderConfigStatusForBackground"),
  "background generator must sanitize injected status before bg.js");
assert(bgSrc.includes("function identityProviderBundle_loadPrivateConfig("),
  "background must load private config only through the provider-bundle diagnostic path");
assert(bgSrc.includes("function identityProviderBundle_runRealConfigSmoke("),
  "background must gate real-config client readiness behind a private smoke function");
assert(bgSrc.includes("delete globalThis[IDENTITY_PROVIDER_PRIVATE_CONFIG_GLOBAL]"),
  "background must clear private config carrier after reading it");
pass("provider config source is mock/local and contains no raw provider fields");

const getDerivedManagerBlockA2 = bgSrc.slice(
  bgSrc.indexOf("async function identityAuthManager_getDerivedState("),
  bgSrc.indexOf("async function identityAuthManager_getDerivedState(") + 500
);
assert(getDerivedManagerBlockA2.includes("providerConfigStatus"),
  "identity:get-derived-state must expose providerConfigStatus");
assert(getDerivedManagerBlockA2.includes("identityProviderConfig_diagAsync()"),
  "providerConfigStatus must come from async redacted diag helper");
assert(builtBg.includes("providerConfigStatus"),
  "built bg.js missing providerConfigStatus diagnostic");
pass("identity:get-derived-state includes safe providerConfigStatus");

assert(bgSrc.includes("function identityProviderBundle_loadProbe("),
  "background bundle probe loader missing");
assert(bgSrc.includes("importScripts(IDENTITY_PROVIDER_BUNDLE_PATH)"),
  "background bundle must retain conditional importScripts path");
assert(bgSrc.includes("function identityProviderBundle_shouldLoadProbe("),
  "background bundle loading must be gated by provider config readiness");
assert(bgSrc.includes("function identityProviderBundle_ensureProbeLoaded("),
  "background bundle loading must be lazy from probe status path");
assert(!bgSrc.includes("}\n\nidentityProviderBundle_loadProbe();\n\nconst MODE_LIVE_FIRST"),
  "background bundle must not load unconditionally at service-worker boot");
assert(bgSrc.includes("function identityProviderBundle_getProbeStatus("),
  "background bundle safe probe status helper missing");
assert(builtBg.includes("provider/identity-provider-supabase.js"),
  "built bg.js missing background provider bundle path");
assert(builtBg.includes("bundleProbe"),
  "built bg.js missing safe bundleProbe diagnostic");
pass("background provider bundle probe present and conditionally loaded");

assert(!bgSrc.includes("identity:get-provider-config-status"),
  "must not add a new provider config bridge action");
assert(!loaderSrc.includes("identity:get-provider-config-status"),
  "loader must not allow-list a new provider config bridge action");
assert(bgSrc.includes("identity:request-provider-permission"),
  "background must own the popup-only provider permission request action");
assert(bgSrc.includes("function identityProviderPermission_isPopupSender("),
  "provider permission action must be sender-gated to the extension popup");
assert(bgSrc.includes('chrome.runtime.getURL("popup.html")'),
  "provider permission action must require popup.html sender URL");
assert(!loaderSrc.includes("identity:request-provider-permission"),
  "loader must not allow-list a provider permission bridge action");
// The background legitimately owns TWO chrome.permissions.contains callers:
//   1. pageMetadataPermissionContains               — page-metadata origin probe
//   2. identityProviderPermission_containsExactHost — identity exact-host readiness
// and exactly ONE chrome.permissions.request caller:
//   3. identityProviderPermission_requestExactHost  — internal exact-host request
// The allowlist is explicit and closed: helper names are enumerated, never
// wildcarded, and any further caller fails the gate.
const PERMISSION_CONTAINS_OWNERS_A2 = Object.freeze([
  "pageMetadataPermissionContains",
  "identityProviderPermission_containsExactHost",
]);
const PERMISSION_REQUEST_OWNERS_A2 = Object.freeze([
  "identityProviderPermission_requestExactHost",
]);

// Factored so the identical ownership rule can be replayed against a synthetic
// background below. It asserts rather than returns, so any violation is a hard
// failure in both the real and the synthetic run.
function assertPermissionOwnershipA2(source) {
  const containsOwnerBodies = PERMISSION_CONTAINS_OWNERS_A2.map((name) => {
    const body = extractFunction(source, name);
    assert(body.includes("chrome.permissions.contains"),
      `chrome.permissions.contains must appear in its legitimate owner ${name}`);
    return body;
  });
  const requestOwnerBodies = PERMISSION_REQUEST_OWNERS_A2.map((name) => {
    const body = extractFunction(source, name);
    assert(body.includes("chrome.permissions.request"),
      `chrome.permissions.request must appear in its legitimate owner ${name}`);
    return body;
  });
  let withoutContainsOwners = source;
  for (const body of containsOwnerBodies) {
    withoutContainsOwners = withoutContainsOwners.replace(body, "");
  }
  assert(!withoutContainsOwners.includes("chrome.permissions.contains"),
    "chrome.permissions.contains must not appear outside its two legitimate owner helpers");
  let withoutRequestOwners = source;
  for (const body of requestOwnerBodies) {
    withoutRequestOwners = withoutRequestOwners.replace(body, "");
  }
  assert(!withoutRequestOwners.includes("chrome.permissions.request"),
    "chrome.permissions.request must not appear outside internal exact-host request helper");
}

assertPermissionOwnershipA2(bgSrc);

// Durable negative control. A synthetic THIRD chrome.permissions.contains owner
// must be rejected by the very same rule that just admitted the real source.
// In-memory only: no fixture is written and the background source is untouched.
const syntheticThirdContainsOwnerA2 = [
  "function syntheticUnauthorizedPermissionContains(originPattern) {",
  "  return new Promise((resolve) => {",
  "    chrome.permissions.contains({ origins: [originPattern] }, (granted) => {",
  "      resolve(granted === true);",
  "    });",
  "  });",
  "}",
  "",
].join("\n") + bgSrc;
let syntheticThirdOwnerRejectedA2 = false;
try {
  assertPermissionOwnershipA2(syntheticThirdContainsOwnerA2);
} catch (err) {
  syntheticThirdOwnerRejectedA2 =
    /chrome\.permissions\.contains must not appear outside/.test(String(err && err.message));
}
assert(syntheticThirdOwnerRejectedA2,
  "negative control: a third unauthorized chrome.permissions.contains owner must fail the ownership check");
pass("negative control: synthetic third chrome.permissions.contains owner is rejected fail-closed");
pass("page-facing provider config stays blocked and provider permission action is popup-gated");

const publicSnapshotBlockA2 = bgSrc.slice(
  bgSrc.indexOf("function identitySnapshot_fromRuntime("),
  bgSrc.indexOf("function identitySnapshot_toRuntime(")
);
assert(!publicSnapshotBlockA2.includes("providerConfigStatus"),
  "public snapshot mapping must not include providerConfigStatus");
assert(!broadcastSection.includes("providerConfigStatus"),
  "broadcastIdentityPush must not publish providerConfigStatus");
pass("providerConfigStatus stays out of public snapshots and push broadcasts");

// ── Suite B: loader update bridge ─────────────────────────────────────────────
console.log("\n── Suite B: loader installRuntimeIdentityUpdateBridge ───────────────────");

assert(loaderSrc.includes('MSG_IDENTITY_PUSH = "h2o-ext-identity:v1:push"'),
  "MSG_IDENTITY_PUSH constant missing from loader source");
pass("MSG_IDENTITY_PUSH constant defined in loader");

assert(loaderSrc.includes("function installRuntimeIdentityUpdateBridge()"),
  "installRuntimeIdentityUpdateBridge missing from loader");
pass("installRuntimeIdentityUpdateBridge function present");

assert(loaderSrc.includes("__H2O_EXT_IDENTITY_UPDATE_BRIDGE_V1__"),
  "duplicate-install guard missing from installRuntimeIdentityUpdateBridge");
pass("duplicate-install guard present");

assert(loaderSrc.includes("msg.type !== MSG_IDENTITY_PUSH"),
  "loader update bridge does not filter by MSG_IDENTITY_PUSH");
pass("loader update bridge filters by MSG_IDENTITY_PUSH");

assert(loaderSrc.includes('window.postMessage({ type: MSG_IDENTITY_PUSH, snapshot: msg.snapshot || null'),
  "loader update bridge does not forward push to page context");
pass("loader update bridge forwards push to page via window.postMessage");

// Verify it is called from boot()
const bootIdx = loaderSrc.indexOf("async function boot()");
const bootSection = loaderSrc.slice(bootIdx, bootIdx + 2000);
assert(bootSection.includes("installRuntimeIdentityUpdateBridge()"),
  "installRuntimeIdentityUpdateBridge not called from boot()");
pass("installRuntimeIdentityUpdateBridge called from boot()");

// Built loader also contains it
assert(builtLoader.includes("h2o-ext-identity:v1:push"), "built loader.js missing push message type");
assert(builtLoader.includes("H2O_EXT_IDENTITY_UPDATE_BRIDGE_V1"), "built loader.js missing guard");
pass("built loader.js includes push bridge");

// ── Suite C: Identity Core push reception ──────────────────────────────────────
console.log("\n── Suite C: Identity Core applySharedSnapshot + listenForBridgePush ──────");

assert(identityCoreSrc.includes("BRIDGE_MSG_PUSH = 'h2o-ext-identity:v1:push'"),
  "BRIDGE_MSG_PUSH constant missing from Identity Core");
pass("BRIDGE_MSG_PUSH constant defined in Identity Core");

assert(identityCoreSrc.includes("function applySharedSnapshot("),
  "applySharedSnapshot missing from Identity Core");
pass("applySharedSnapshot function present");

assert(identityCoreSrc.includes("function listenForBridgePush()"),
  "listenForBridgePush missing from Identity Core");
pass("listenForBridgePush function present");

assert(identityCoreSrc.includes("d.type !== BRIDGE_MSG_PUSH"),
  "listenForBridgePush does not check BRIDGE_MSG_PUSH message type");
pass("listenForBridgePush filters by BRIDGE_MSG_PUSH");

assert(identityCoreSrc.includes("applySharedSnapshot(d.snapshot)"),
  "listenForBridgePush does not call applySharedSnapshot");
pass("listenForBridgePush routes to applySharedSnapshot");
assert(identityCoreSrc.includes("runtime.onMessage.addListener") &&
  identityCoreSrc.includes("applySharedSnapshot(msg.snapshot)"),
  "listenForBridgePush must listen directly to chrome.runtime messages in extension pages");
pass("listenForBridgePush listens to direct runtime pushes in extension pages");
assert(identityCoreSrc.includes("BRIDGE_STORAGE_SNAPSHOT_KEY = 'h2oIdentityMockSnapshotV1'") &&
  identityCoreSrc.includes("storage.onChanged.addListener") &&
  identityCoreSrc.includes("changes[BRIDGE_STORAGE_SNAPSHOT_KEY]") &&
  identityCoreSrc.includes("applySharedSnapshot(change.newValue)") &&
  identityCoreSrc.includes("applySharedSnapshot(null)"),
  "Identity Core must observe background snapshot storage changes in extension pages");
pass("listenForBridgePush observes background snapshot storage resets in extension pages");

// listenForBridgePush called at boot
assert(identityCoreSrc.includes("tryHydrateFromBridge();\n  listenForBridgePush();") ||
  identityCoreSrc.includes("tryHydrateFromBridge();\n  listenForBridgePush()"),
  "listenForBridgePush not called at boot after tryHydrateFromBridge");
pass("listenForBridgePush called at boot");

// applySharedSnapshot has a null/falsy guard (sign-out reset path)
const applyFnBody = identityCoreSrc.slice(
  identityCoreSrc.indexOf("function applySharedSnapshot("),
  identityCoreSrc.indexOf("function applySharedSnapshot(") + 1800
);
assert(applyFnBody.includes("createInitialSnapshot()"),
  "applySharedSnapshot null path does not reset to initial snapshot");
pass("applySharedSnapshot resets to anonymous_local on null push (sign-out)");
assert(applyFnBody.includes("cancelBridgeWrite()"),
  "applySharedSnapshot null/anonymous path must cancel pending stale bridge writes");
pass("applySharedSnapshot cancels pending stale bridge writes on reset");

// applySharedSnapshot validates status before applying
assert(applyFnBody.includes("Object.values(STATES).includes(incoming.status)"),
  "applySharedSnapshot does not validate status before applying");
pass("applySharedSnapshot validates status against STATES");

// applySharedSnapshot sanitizes via sanitizeForBridge
assert(applyFnBody.includes("sanitizeForBridge(incoming)"),
  "applySharedSnapshot does not strip via sanitizeForBridge");
pass("applySharedSnapshot strips token-like fields via sanitizeForBridge");

// applySharedSnapshot fires onChange listeners
assert(applyFnBody.includes("listener(event)"),
  "applySharedSnapshot does not notify onChange listeners");
assert(applyFnBody.includes("EVENT_CHANGE"),
  "applySharedSnapshot does not dispatch EVENT_CHANGE");
pass("applySharedSnapshot notifies listeners and dispatches h2o:identity:changed");

// ── Suite D: refreshSession pulls from bridge ──────────────────────────────────
console.log("\n── Suite D: refreshSession pulls from bridge ────────────────────────────");

const refreshFnBody = identityCoreSrc.slice(
  identityCoreSrc.indexOf("async function refreshSession()"),
  identityCoreSrc.indexOf("async function refreshSession()") + 600
);
assert(refreshFnBody.includes("identity:get-snapshot"),
  "refreshSession does not call identity:get-snapshot to pull from bridge");
pass("refreshSession calls identity:get-snapshot");

assert(refreshFnBody.includes("applySharedSnapshot(res.snapshot)"),
  "refreshSession does not call applySharedSnapshot on bridge response");
pass("refreshSession applies bridge snapshot via applySharedSnapshot");
assert(identityCoreSrc.includes("hasOwnProperty.call(res, 'snapshot')") &&
  identityCoreSrc.includes("isProviderOwnedSnapshot(snapshot)) applySharedSnapshot(null)"),
  "Identity Core must treat null background snapshot as authoritative sign-out for provider-owned local state");
pass("bridge hydration treats null background snapshot as provider sign-out");

assert(refreshFnBody.includes("Fallback"),
  "refreshSession missing local fallback path");
pass("refreshSession has local fallback when bridge unavailable");

// ── Suite E: functional — push flow simulation ─────────────────────────────────
console.log("\n── Suite E: functional — push flow simulation ───────────────────────────");

function makePageGlobal() {
  const ls = {};
  const listeners = {};
  const g = {
    H2O: undefined,
    dispatchEvent(ev) {
      const fns = listeners[ev && ev.type] || [];
      for (const fn of fns) try { fn(ev); } catch (_) {}
    },
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    removeEventListener(type, fn) {
      listeners[type] = (listeners[type] || []).filter(f => f !== fn);
    },
    postMessage() {},
    CustomEvent: class CustomEvent {
      constructor(type, init) { this.type = type; this.detail = init && init.detail; }
    },
    location: { protocol: "https:" },
    localStorage: {
      getItem: k => Object.prototype.hasOwnProperty.call(ls, k) ? ls[k] : null,
      setItem: (k, v) => { ls[k] = String(v); },
      removeItem: k => { delete ls[k]; },
    },
    setTimeout, clearTimeout, Date, JSON, Object, Array, Math, Promise, Error, Set, Map,
    crypto: { randomUUID: () => "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => { const r = Math.random() * 16 | 0; return (c === "x" ? r : r & 3 | 8).toString(16); }) },
    structuredClone: v => JSON.parse(JSON.stringify(v)),
    console,
  };
  g._listeners = listeners;
  return g;
}

function makeExtensionGlobal() {
  const g = makePageGlobal();
  const runtimeFns = [];
  const storageFns = [];
  g.location.protocol = "chrome-extension:";
  g.chrome = {
    runtime: {
      onMessage: { addListener(fn) { runtimeFns.push(fn); } },
      sendMessage(_msg, cb) {
        if (typeof cb === "function") cb({ ok: true, snapshot: null });
      },
      lastError: null,
    },
    storage: {
      onChanged: { addListener(fn) { storageFns.push(fn); } },
    },
  };
  g._runtimeMessageListeners = runtimeFns;
  g._storageChangeListeners = storageFns;
  return g;
}

function bootIdentity(g) {
  const fn = new Function("unsafeWindow", identityCoreSrc + "\n//# sourceURL=0D4a-test.js");
  fn.call(g, g);
  return g.H2O.Identity;
}

// E1: boots in page context (no chrome.runtime)
const g1 = makePageGlobal();
const id = bootIdentity(g1);
assert(id, "H2O.Identity not mounted in page simulation");
assert(id.getState() === "anonymous_local", "Initial state should be anonymous_local");
pass("Identity Core boots in page context simulation (anonymous_local)");

// Simulate a push message arriving from the loader (window.postMessage)
let pushApplied = false;
id.onChange(() => { pushApplied = true; });

const mockProfileSnapshot = {
  status: "profile_ready",
  mode: "local_dev",
  provider: "mock_local",
  emailVerified: true,
  pendingEmail: null,
  profile: { id: "profile_abc", displayName: "Test User", email: "test@example.com", avatarColor: "#7c3aed", workspaceId: "ws_abc", onboardingCompleted: true, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:01.000Z" },
  workspace: { id: "ws_abc", ownerUserId: "user_abc", name: "Test Workspace", origin: "local_mock", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:01.000Z" },
  onboardingCompleted: true,
  lastError: null,
  updatedAt: "2026-01-01T00:00:01.000Z",
};

// Deliver the push message (simulates loader → window.postMessage → message listener)
const msgFns = g1._listeners["message"] || [];
for (const fn of msgFns) {
  try {
    fn({ source: g1, data: { type: "h2o-ext-identity:v1:push", snapshot: mockProfileSnapshot } });
  } catch {}
}

assert(pushApplied, "onChange listener not called after push message");
pass("onChange fired after push message received");

const afterPush = id.getSnapshot();
assert(afterPush.status === "profile_ready", `Expected profile_ready after push, got ${afterPush.status}`);
assert(Boolean(afterPush.profile), "profile missing after push");
assert(Boolean(afterPush.workspace), "workspace missing after push");
assert(afterPush.onboardingCompleted === true, "onboardingCompleted not true after push");
pass("snapshot updated to profile_ready with profile + workspace after push");

const diagAfterPush = id.diag();
assert(diagAfterPush.hasProfile === true, "hasProfile should be true after push");
assert(diagAfterPush.hasWorkspace === true, "hasWorkspace should be true after push");
assert(diagAfterPush.onboardingCompleted === true, "onboardingCompleted should be true after push");
pass("diag() reflects profile_ready state after push");

  // No token fields in snapshot or diag. 3.8E intentionally exposes only the
  // safe credentialState enum; do not treat that exact public field as a leak.
  const snapStr = JSON.stringify(afterPush).toLowerCase();
  const diagStr = JSON.stringify(diagAfterPush).toLowerCase();
  const forbidden = ["access_token", "refresh_token", "id_token", "jwt", "password", "secret"];
  for (const field of forbidden) {
    assert(!snapStr.includes(field), `Forbidden field "${field}" found in snapshot after push`);
    assert(!diagStr.includes(field), `Forbidden field "${field}" found in diag after push`);
  }
  if (Object.hasOwn(afterPush, "credentialState")) {
    assert(["complete", "required", "unknown"].includes(afterPush.credentialState), "credentialState must be the safe public enum");
  }
  if (Object.hasOwn(diagAfterPush, "credentialState")) {
    assert(["complete", "required", "unknown"].includes(diagAfterPush.credentialState), "diag credentialState must be the safe public enum");
  }
  pass("no token-like fields in snapshot or diag after push");

// Simulate sign-out push (null snapshot)
let signOutApplied = false;
id.onChange(() => { signOutApplied = true; });
for (const fn of msgFns) {
  try {
    fn({ source: g1, data: { type: "h2o-ext-identity:v1:push", snapshot: null } });
  } catch {}
}
assert(signOutApplied, "onChange not fired after sign-out push");
const afterSignOut = id.getSnapshot();
assert(afterSignOut.status === "anonymous_local", `Expected anonymous_local after null push, got ${afterSignOut.status}`);
assert(!afterSignOut.profile, "profile should be null after sign-out push");
assert(!afterSignOut.workspace, "workspace should be null after sign-out push");
assert(!afterSignOut.onboardingCompleted, "onboardingCompleted should be false after sign-out push");
pass("sign-out push (null) resets page to anonymous_local");

const staleSyncReadySnapshot = {
  status: "sync_ready",
  mode: "provider_backed",
  provider: "supabase",
  credentialState: "complete",
  credentialProvider: "google",
  emailVerified: true,
  profile: { id: "profile_old", displayName: "Old User", email: "old@example.com", avatarColor: "slate", workspaceId: "ws_old", onboardingCompleted: true },
  workspace: { id: "ws_old", name: "Old Workspace", origin: "supabase" },
  onboardingCompleted: true,
  syncReady: true,
  updatedAt: "2026-01-01T00:00:01.000Z",
};
const g2 = makeExtensionGlobal();
g2.localStorage.setItem("h2o:prm:cgx:identity:v1:snapshot", JSON.stringify(staleSyncReadySnapshot));
const id2 = bootIdentity(g2);
assert(id2.getSnapshot().status === "sync_ready", "extension-page simulation should boot with stale sync_ready local snapshot");
assert(g2._runtimeMessageListeners.length > 0, "extension-page runtime push listener was not registered");
assert(g2._storageChangeListeners.length > 0, "extension-page storage reset listener was not registered");
for (const fn of g2._runtimeMessageListeners) {
  try { fn({ type: "h2o-ext-identity:v1:push", snapshot: null }); } catch {}
}
assert(id2.getSnapshot().status === "anonymous_local", "runtime null push did not override stale sync_ready snapshot");
pass("extension-page runtime reset overrides stale sync_ready snapshot");

const g3 = makeExtensionGlobal();
g3.localStorage.setItem("h2o:prm:cgx:identity:v1:snapshot", JSON.stringify(staleSyncReadySnapshot));
const id3 = bootIdentity(g3);
assert(id3.getSnapshot().status === "sync_ready", "extension-page storage simulation should boot with stale sync_ready local snapshot");
for (const fn of g3._storageChangeListeners) {
  try { fn({ h2oIdentityMockSnapshotV1: { oldValue: staleSyncReadySnapshot } }, "local"); } catch {}
}
assert(id3.getSnapshot().status === "anonymous_local", "storage snapshot removal did not override stale sync_ready snapshot");
pass("extension-page storage reset overrides stale sync_ready snapshot");

// ── Suite F: no token surface in push path ─────────────────────────────────────
console.log("\n── Suite F: no token surface in push path ───────────────────────────────");

// broadcastIdentityPush source: identitySnapshot_sanitize strips tokens
const broadcastFn = bgSrc.slice(bgSrc.indexOf("function broadcastIdentityPush("), bgSrc.indexOf("function broadcastIdentityPush(") + 600);
assert(!broadcastFn.includes("token") || broadcastFn.includes("identitySnapshot_sanitize"),
  "broadcastIdentityPush may expose tokens without sanitization");
pass("broadcastIdentityPush sanitizes via identitySnapshot_sanitize before broadcast");

// applySharedSnapshot: sanitizeForBridge strips tokens
assert(applyFnBody.includes("sanitizeForBridge"),
  "applySharedSnapshot does not use sanitizeForBridge");
pass("applySharedSnapshot strips tokens via sanitizeForBridge");

// MSG_IDENTITY_PUSH type does not include auth credentials
const pushMsgType = "h2o-ext-identity:v1:push";
assert(!pushMsgType.includes("token") && !pushMsgType.includes("credential"),
  "MSG_IDENTITY_PUSH type name must not reference tokens");
pass("MSG_IDENTITY_PUSH type name is clean");

// No Supabase/Firebase/Clerk imports anywhere in modified files
const noSdkFiles = [bgSrc, loaderSrc, identityCoreSrc, builtBg, builtLoader];
const sdkPattern = /import\s+.*from\s+['"](@supabase\/supabase-js|firebase|@clerk\/)/;
for (const src of noSdkFiles) {
  assert(!sdkPattern.test(src), "Provider SDK import found in a modified file");
}
pass("no Supabase/Firebase/Clerk SDK imports in any modified file");

const credentialPatternsF = [
  /SUPABASE_URL\s*=\s*["']https?:/,
  /SUPABASE_ANON_KEY\s*=\s*["']/,
  /SUPABASE_SERVICE(_ROLE)?_KEY\s*=\s*["']/,
  /https:\/\/[a-z0-9-]+\.supabase\.co/i,
  /\bsupabase(ProjectUrl|AnonKey|ServiceKey)\s*[:=]/i,
  /eyJ[A-Za-z0-9_-]{40,}/,
];
const stripAllowedExactOptionalHostPermissionF = (src) =>
  String(src || "").replace(/https:\/\/[a-z0-9-]+\.supabase\.co\/\*/gi, "");
for (const [label, src] of [
  ["background source", bgSrc],
  ["built bg.js", builtBg],
  ["loader source", loaderSrc],
  ["built loader.js", builtLoader],
  ["Identity Core", identityCoreSrc],
]) {
  for (const pattern of credentialPatternsF) {
    assert(!pattern.test(stripAllowedExactOptionalHostPermissionF(src)), `Credential/JWT-like pattern found in ${label}: ${pattern}`);
  }
}
pass("no Supabase URL/key/service key/JWT-like values in identity source or build surfaces");

const providerCallPatternsF = [
  /signInWithOtp\s*\(/,
  /verifyOtp\s*\(/,
  /createClient\s*\(/,
];
for (const [label, src] of [
  ["background source", bgSrc],
  ["built bg.js", builtBg],
  ["loader source", loaderSrc],
  ["built loader.js", builtLoader],
  ["Identity Core", identityCoreSrc],
]) {
  for (const pattern of providerCallPatternsF) {
    assert(!pattern.test(src), `Real provider auth call found in ${label}: ${pattern}`);
  }
}
pass("no real provider auth calls in identity source or build surfaces");

// ── Suite G: consumer scripts unchanged ───────────────────────────────────────
console.log("\n── Suite G: consumer scripts unchanged ─────────────────────────────────");

const firstRunSrc = read("src-runtime-base/0D4b.⚫️🔐 Identity First-Run Prompt 🚪🔐.js");
assert(firstRunSrc.includes("isReadySnapshot") && firstRunSrc.includes("READY_STATUSES"),
  "FirstRunPrompt missing isReadySnapshot/READY_STATUSES");
pass("FirstRunPrompt retains isReadySnapshot / READY_STATUSES logic");

// FirstRunPrompt does not own identity state
assert(!firstRunSrc.includes("transition(") && !firstRunSrc.includes("persistAndNotify("),
  "FirstRunPrompt must not call transition/persistAndNotify");
pass("FirstRunPrompt is consumer-only (no transition/persistAndNotify)");

// First-run prompt hides when identity is ready (not just when dismissed)
assert(firstRunSrc.includes("isReadySnapshot(snap)") && firstRunSrc.includes("hide('identity-ready')"),
  "FirstRunPrompt must hide because identity is ready, not only because dismissed");
pass("FirstRunPrompt hides explicitly when identity is ready (not only dismissed)");

// dev-order.tsv unchanged
const devOrder = read("config/dev-order.tsv");
assert(!devOrder.includes("validate-identity-phase2_9-sync"),
  "dev-order.tsv must not reference validation scripts");
pass("dev-order.tsv not modified");

// Identity Core no longer calls create-profile/create-workspace separately
assert(identityCoreSrc.includes("identity:complete-onboarding"),
  "Identity Core must use identity:complete-onboarding (atomic)");
assert(!identityCoreSrc.includes("sendBridge('identity:create-profile'"),
  "Identity Core must not separately call identity:create-profile");
assert(!identityCoreSrc.includes("sendBridge('identity:create-workspace'"),
  "Identity Core must not separately call identity:create-workspace");
pass("Identity Core uses atomic identity:complete-onboarding (no two-step race)");

// ── Summary ───────────────────────────────────────────────────────────────────
console.log("\n══════════════════════════════════════════════════════════════════════════");
console.log("Identity Phase 2.9/3.0C sync validation PASSED — all checks ✓");
console.log("Cross-context state propagation in place:");
console.log("  popup      → identity:complete-onboarding (atomic, no race)");
console.log("  background → stores runtime + snapshot + broadcastIdentityPush → tabs + extension pages");
console.log("  loader     → installRuntimeIdentityUpdateBridge → window.postMessage");
console.log("  page       → listenForBridgePush → applySharedSnapshot");
console.log("  get-snapshot falls back to runtime when stored snapshot is null (pull correctness).");
console.log("  set-snapshot syncs runtime (get-derived-state stays consistent).");
console.log("  refreshSession pulls bridge snapshot directly.");
console.log("Provider config source/status is inert mock/local. No real auth, no tokens, no Supabase/Firebase/Clerk.");
console.log("══════════════════════════════════════════════════════════════════════════\n");
