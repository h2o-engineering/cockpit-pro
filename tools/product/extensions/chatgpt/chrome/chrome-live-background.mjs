// @version 1.1.2
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";

import { resolveChromeBuildStamp } from "./chrome-live-build-stamp.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const CATEGORY_CLASSIFIER_SOURCE_FILE = path.resolve(SCRIPT_DIR, "../../../../../packages/studio-core/src/categories/classifier.ts");
const BILLING_PROVIDER_SOURCE_FILE = path.resolve(SCRIPT_DIR, "../../../billing/billing-provider-supabase.entry.mjs");
const SYNC_BACKGROUND_RUNTIME_SOURCE_FILE = path.resolve(
  SCRIPT_DIR,
  "../../../../../packages/browser-adapters/chrome/sync-background-reconcile.mjs",
);
const SYNC_LINEAR_RECONCILE_CORE_SOURCE_FILE = path.resolve(
  SCRIPT_DIR,
  "../../../../../src-surfaces-base/studio/sync/sync-linear-reconcile-core.js",
);

function readCategoryClassifierRuntimeSource() {
  const source = fs.readFileSync(CATEGORY_CLASSIFIER_SOURCE_FILE, "utf8");
  return source
    .replace(/^\/\/ @ts-nocheck\s*\n/u, "")
    .replace(/^export\s+/gm, "");
}

const CATEGORY_CLASSIFIER_RUNTIME_SOURCE = readCategoryClassifierRuntimeSource();

function readBillingProviderRuntimeSource() {
  return fs.readFileSync(BILLING_PROVIDER_SOURCE_FILE, "utf8");
}

const BILLING_PROVIDER_RUNTIME_SOURCE = readBillingProviderRuntimeSource();

function buildSyncBackgroundRuntimeSource() {
  const result = buildSync({
    entryPoints: [SYNC_BACKGROUND_RUNTIME_SOURCE_FILE],
    bundle: true,
    format: "iife",
    globalName: "H2OChromeBackgroundSyncBundle",
    platform: "browser",
    target: ["chrome120"],
    write: false,
    legalComments: "none",
  });
  const output = result.outputFiles && result.outputFiles[0];
  if (!output || !output.text) {
    throw new Error("Chrome background Sync bundle produced no JavaScript");
  }
  return output.text;
}

const SYNC_BACKGROUND_RUNTIME_SOURCE = buildSyncBackgroundRuntimeSource();
const SYNC_LINEAR_RECONCILE_CORE_SOURCE = fs.readFileSync(
  SYNC_LINEAR_RECONCILE_CORE_SOURCE_FILE,
  "utf8",
);
function sanitizeIdentityProviderOAuthProviderForBackground(value) {
  return String(value || "").trim().toLowerCase() === "google" ? "google" : null;
}

function sanitizeIdentityProviderConfigStatusForBackground(status, oauthProvider = null) {
  const src = status && typeof status === "object" && !Array.isArray(status) ? status : null;
  if (!src) return null;
  const configSource = String(src.configSource || "").trim().toLowerCase().replace(/[^a-z0-9_-]/g, "");
  if (configSource !== "dev_env" && configSource !== "dev_local_file") return null;
  const missingFields = Array.isArray(src.missingFields)
    ? src.missingFields.map((field) => String(field || "").replace(/[^a-z0-9_-]/gi, "").slice(0, 64)).filter(Boolean)
    : [];
  const errorCodes = Array.isArray(src.errorCodes)
    ? src.errorCodes.map((code) => String(code || "").replace(/[^a-z0-9_/-]/gi, "").slice(0, 96)).filter(Boolean)
    : [];
  const valid = src.valid === true && missingFields.length === 0 && errorCodes.length === 0;
  const oauthGoogleEnabled = valid === true && oauthProvider === "google";
  return {
    schemaVersion: "3.0N",
    providerKind: "supabase",
    providerMode: "provider_backed",
    providerConfigured: valid,
    configSource,
    valid,
    validationState: valid
      ? "valid"
      : String(src.validationState || "rejected").replace(/[^a-z0-9_-]/gi, "").slice(0, 64) || "rejected",
    missingFields,
    errorCodes,
    capabilities: {
      emailOtp: true,
      magicLink: false,
      oauth: oauthGoogleEnabled,
      oauthProviders: oauthGoogleEnabled ? ["google"] : [],
    },
  };
}

function sanitizeIdentityProviderOptionalHostPatternForBackground(pattern) {
  const value = String(pattern || "").trim().toLowerCase();
  return /^https:\/\/[a-z0-9-]+\.supabase\.co\/\*$/.test(value) ? value : null;
}

function sanitizeIdentityProviderPhaseNetworkForBackground(value) {
  return String(value || "").trim().toLowerCase() === "request_otp" ? "request_otp" : null;
}

export function makeChromeLiveBackgroundJs({
  H2O_BUILD_STAMP = resolveChromeBuildStamp().h2oBuildStamp,
  DEV_TAG,
  CHAT_MATCH,
  DEV_HAS_CONTROLS,
  MANIFEST_PROFILE = "development",
  IDENTITY_PROVIDER_BUNDLE_PATH = "provider/identity-provider-supabase.js",
  IDENTITY_PROVIDER_PRIVATE_CONFIG_PATH = "provider/identity-provider-private-config.js",
  IDENTITY_PROVIDER_OPTIONAL_HOST_PATTERN = null,
  IDENTITY_PROVIDER_CONFIG_STATUS = null,
  IDENTITY_PROVIDER_PHASE_NETWORK = null,
  IDENTITY_PROVIDER_OAUTH_PROVIDER = null,
  STUDIO_AUTO_RESTORE_ENABLED = true,
}) {
  const H2O_BUILD_STAMP_SAFE = String(H2O_BUILD_STAMP || "").trim();
  if (!/^h2o-runtime-v1:[0-9a-f]{40}$/.test(H2O_BUILD_STAMP_SAFE)) {
    throw new Error(`invalid H2O_BUILD_STAMP for background: ${JSON.stringify(H2O_BUILD_STAMP_SAFE)}`);
  }
  // Studio is hosted in chrome-ext-prod ONLY. Non-prod builds ship without
  // surfaces/studio/* (the build script calls removeArchiveWorkbenchFromOut)
  // AND disable every code path that would try to open / focus / restore
  // Studio at runtime. ARCHIVE_WORKBENCH_ENABLED gates all those paths.
  const STUDIO_HOSTED_HERE = String(MANIFEST_PROFILE || "").trim().toLowerCase() === "production";
  // Auto-restore is the "if Studio was open before an extension reload, bring
  // it back on its own" path. Studio Launcher disables this because its
  // single-purpose toolbar button is enough — and because two presence-restore
  // wakes (sw-boot top-level + onInstalled) can race the cooldown marker and
  // create duplicate Studio tabs.
  const STUDIO_AUTO_RESTORE_ON = STUDIO_HOSTED_HERE && STUDIO_AUTO_RESTORE_ENABLED !== false;
  const IDENTITY_PROVIDER_OAUTH_PROVIDER_SAFE = sanitizeIdentityProviderOAuthProviderForBackground(IDENTITY_PROVIDER_OAUTH_PROVIDER);
  const IDENTITY_PROVIDER_CONFIG_STATUS_SAFE = sanitizeIdentityProviderConfigStatusForBackground(
    IDENTITY_PROVIDER_CONFIG_STATUS,
    IDENTITY_PROVIDER_OAUTH_PROVIDER_SAFE,
  );
  const IDENTITY_PROVIDER_OPTIONAL_HOST_PATTERN_SAFE = sanitizeIdentityProviderOptionalHostPatternForBackground(
    IDENTITY_PROVIDER_OPTIONAL_HOST_PATTERN,
  );
  const IDENTITY_PROVIDER_PHASE_NETWORK_SAFE = sanitizeIdentityProviderPhaseNetworkForBackground(
    IDENTITY_PROVIDER_PHASE_NETWORK,
  );
  return `const TAG = ${JSON.stringify(DEV_TAG)};
const H2O_BUILD_STAMP = ${JSON.stringify(H2O_BUILD_STAMP_SAFE)};
${STUDIO_HOSTED_HERE ? SYNC_LINEAR_RECONCILE_CORE_SOURCE : ""}
${STUDIO_HOSTED_HERE ? SYNC_BACKGROUND_RUNTIME_SOURCE : ""}
const MSG_FETCH_TEXT = "h2o-ext-live:fetch-text";
const MSG_HTTP = "h2o-ext-live:http";
const MSG_PAGE_DISABLE_ONCE = "h2o-ext-live:page-disable-once";
const MSG_PAGE_SET_LINK = "h2o-ext-live:page-set-link";
const MSG_ARCHIVE = "h2o-ext-archive:v1";
/* W-2b. A DEDICATED type for one operation: observe the governed P02
 * repository, read-only. It is deliberately NOT part of the archive family -
 * archive ops are reachable from page-world JavaScript through the content
 * script relay, and this must not be. It carries no operation selector, so the
 * type itself is the entire capability. */
const MSG_P02_OBSERVE = "h2o-ext-p02-observe:v1";
/* W-2c. Fixed-purpose trusted Studio request: exactly one bounded manual
 * Receive/admission pass. The message carries no peer, repository, object or
 * authority selector; those remain governed configuration/runtime concerns. */
const MSG_P02_RECEIVE_ADMIT = "h2o-ext-p02-receive-admit:v1";
const P02_W2C_RESULT_SCHEMA = "h2o.studio.syncW2cReceiveAdmissionResult.v1";
/* W-3. Fixed-purpose trusted Human content Apply. Like Receive, provenance is
 * the whole request; selection and every authority value stay worker-owned. */
const MSG_P02_APPLY = "h2o-ext-p02-apply:v1";
const P02_W3_RESULT_SCHEMA = "h2o.studio.syncW3ApplyResult.v1";
/* Reverse P02. One fixed-purpose local publication request. The page supplies
 * provenance only; the worker owns local identity, candidate, mint, parent,
 * repository and destination. */
const MSG_P02_PUBLISH_LOCAL = "h2o-ext-p02-publish-local:v1";
const MSG_P02_RETIRE_FOREIGN_INTENT = "h2o-ext-p02-retire-foreign-intent:v1";
const P02_PUBLISH_RESULT_SCHEMA =
  "h2o.studio.syncChromePublicationResult.p02.v1";
/* Fixed-purpose Human ceremony: retire Chrome-local P01 mutation authority.
 * The request contains provenance only; the worker resolves every authority
 * field and owns the only generation-key persistence route. */
const MSG_P01_WRITER_STANDDOWN = "h2o-ext-p02-standdown-p01-writer:v1";
const P01_WRITER_STANDDOWN_RESULT_SCHEMA =
  "h2o.studio.syncP01WriterStanddownResult.v1";
/* W-2b readiness has two alternative success signals: the existing Port ACK
 * and one post-start worker announcement. They share the same base wire value;
 * the Port alone carries the explicit ":port" transport suffix. */
const P02_OBSERVE_READY_ANNOUNCE = "h2o-ext-p02-observe-ready:v1";
const P02_OBSERVE_READY_PORT = "h2o-ext-p02-observe-ready:v1:port";
/* The only document permitted to ask for it. */
const P02_OBSERVE_STUDIO_PATHNAME = "/surfaces/studio/studio.html";
const MSG_ARCHIVE_PORT = "h2o-ext-archive:v1:port";
const MSG_FOLDERS = "h2o-ext-folders:v1";
const MSG_STUDIO_BROADCAST = "h2o:library:studio-broadcast:v1";
const MSG_NATIVE_FOLDER_STATE = "h2o:library:native-folder-state:v1";
/* Phase K-2.6 — cross-extension linked-records bridge. Parallel of the
 * folder-state cross-extension message above. The receiver merges
 * msg.linkedRecords into Studio Launcher's NATIVE_BROADCAST_KEY so
 * S0F1c's existing readNativeChatRegistryRecords() can pick up
 * linked-only records propagated from prod Cockpit Pro's native broadcast. */
const MSG_NATIVE_LINKED_RECORDS = "h2o:library:native-linked-records:v1";
const MSG_NATIVE_SNAPSHOT_PAYLOADS = "h2o:library:native-snapshot-payloads:v1";
/* F10.5.3 — count-safe capture mirror: cross-extension message type +
 * the chrome.storage.local key the Studio Launcher reads (F10.5 bridge). */
const MSG_NATIVE_CAPTURE_MIRROR = "h2o:capture:native-mirror:v1";
const NATIVE_CAPTURE_MIRROR_KEY = "h2o:prm:cgx:capture:mirror:v1";
const MSG_FOLDER_METADATA_OPERATION_RESULTS = "h2o:library:folder-metadata-operation-results:v1";
const FOLDER_METADATA_OPERATION_REQUEST_SCHEMA = "h2o.folder-metadata-operation-request.v1";
const FOLDER_METADATA_OPERATION_SCHEMA = "h2o.folder-metadata-operation.v1";
const FOLDER_METADATA_OPERATION_RESULT_SCHEMA = "h2o.folder-metadata-operation-result.v1";
const STUDIO_BROADCAST_KEY = "h2o:library:cross-surface:broadcast:v1";
const NATIVE_BROADCAST_KEY = "h2o:library:cross-surface:broadcast:native:v1";
const NATIVE_FOLDER_STATE_EXTERNAL_MERGE_DIAG_KEY = "h2o:library:native-folder-state:external-merge:diagnostic:v1";
const STUDIO_LAUNCHER_EXTENSION_ID = "bpobkkppdlldlkccaehmpfclmkhiemhg";
const MSG_CONTROL_HUB_OPEN = "h2o-ext-live:control-hub-open";
const MSG_IDENTITY = "h2o-ext-identity:v1";
const MSG_IDENTITY_FIRST_RUN_PROMPT = "h2o-ext-identity-first-run:v1";
const MSG_IDENTITY_PUSH = "h2o-ext-identity:v1:push";
const MSG_BILLING = "h2o-ext-billing:v1";
const IDENTITY_STORAGE_KEY = "h2oIdentityMockSnapshotV1";
const IDENTITY_MOCK_RUNTIME_KEY = "h2oIdentityProviderMockRuntimeV1";
const IDENTITY_PROVIDER_SESSION_KEY = "h2oIdentityProviderSessionV1";
const IDENTITY_PROVIDER_PERSISTENT_REFRESH_KEY = "h2oIdentityProviderPersistentRefreshV1";
const IDENTITY_PROVIDER_PASSWORD_UPDATE_REQUIRED_KEY = "h2oIdentityProviderPasswordUpdateRequiredV1";
const IDENTITY_PROVIDER_OAUTH_FLOW_KEY = "h2oIdentityProviderOAuthFlowV1";
const IDENTITY_PROVIDER_BUNDLE_PATH = ${JSON.stringify(IDENTITY_PROVIDER_BUNDLE_PATH)};
const IDENTITY_PROVIDER_PRIVATE_CONFIG_PATH = ${JSON.stringify(IDENTITY_PROVIDER_PRIVATE_CONFIG_PATH)};
const IDENTITY_PROVIDER_PRIVATE_CONFIG_GLOBAL = "H2O_IDENTITY_PROVIDER_PRIVATE_CONFIG";
const IDENTITY_PROVIDER_OPTIONAL_HOST_PATTERN = ${JSON.stringify(IDENTITY_PROVIDER_OPTIONAL_HOST_PATTERN_SAFE)};
const IDENTITY_PROVIDER_PHASE_NETWORK = ${JSON.stringify(IDENTITY_PROVIDER_PHASE_NETWORK_SAFE)};
const IDENTITY_PROVIDER_OAUTH_PROVIDER = ${JSON.stringify(IDENTITY_PROVIDER_OAUTH_PROVIDER_SAFE)};
const NATIVE_FOLDER_STATE_EXTERNAL_SENDER_IDS = new Set([
  "bgdapdcjckbiejckpfeinlmcdnijifpg",
  "bkijejgemjjolmdnkgcimoaniocegkij",
  "ceenhihlkfdfjdolchjffpeejblnejdb",
  "ogcjkeaiicglflamhjaaimdhphjlgkbb",
  "eeebgndgehjalflefaldogahaklnlahi",
]);
const CHAT_MATCH = ${JSON.stringify(CHAT_MATCH)};
// Studio (a.k.a. "archive workbench") is the user-facing surface and lives in
// chrome-ext-prod ONLY. Flag is true for production builds and false for
// dev-controls / dev-lean. When false, every Studio launch / restore code
// path is short-circuited so the bg.js never tries to navigate a tab to
// surfaces/studio/studio.html which does not exist in non-prod outputs.
const ARCHIVE_WORKBENCH_ENABLED = ${JSON.stringify(STUDIO_HOSTED_HERE)};
const STUDIO_AUTO_RESTORE_ENABLED = ${JSON.stringify(STUDIO_AUTO_RESTORE_ON)};
const STUDIO_SERVICE_WORKER_BOOT_AT = Date.now();
// In-flight guards prevent racing creates. Both openOrFocusStudio (toolbar
// click) and scheduleStudioPresenceRestore (sw-boot / onInstalled / onStartup)
// can fire concurrently; without these, two queries can race the tabs API
// before either chrome.tabs.create completes, producing duplicate Studio tabs.
let __studioOpenInFlight = null;
let __studioRestoreInFlight = null;
const PAGE_DISABLE_ONCE_MAX_AGE_MS = 10 * 60 * 1000;
const DEV_SET_SLOTS = [1, 2, 3, 4, 5, 6];
const STORAGE_TOGGLE_SETS_KEY = "h2oExtDevToggleSetsV1";
const CHAT_SET_BINDINGS_KEY = "h2oExtDevChatSetBindingsV1";
const CHAT_SET_BYPASS_KEY = "h2oExtDevChatSetBypassV1";
const GLOBAL_DEFAULT_SET_KEY = "h2oExtDevGlobalDefaultSetV1";

${BILLING_PROVIDER_RUNTIME_SOURCE}

const identityProviderBundleProbeState = {
  expected: false,
  loaded: false,
  kind: "skipped",
  phase: "3.0X",
  adapter: null,
  sdkImport: null,
  clientSmoke: null,
  clientSmokeRunner: null,
  realConfigSmoke: null,
  realConfigSmokeRunner: null,
  requestEmailOtpRunner: null,
  verifyEmailOtpRunner: null,
  verifySignupEmailCodeRunner: null,
  refreshProviderSessionRunner: null,
  signOutProviderSessionRunner: null,
  signUpWithPasswordRunner: null,
  resendSignupConfirmationRunner: null,
  signInWithPasswordRunner: null,
  requestPasswordResetRunner: null,
  updatePasswordAfterRecoveryRunner: null,
  changePasswordRunner: null,
  completeOnboardingRunner: null,
  updateIdentityProfileRunner: null,
  renameIdentityWorkspaceRunner: null,
  loadIdentityStateRunner: null,
  registerDeviceSessionRunner: null,
  markPasswordSetupCompletedRunner: null,
  beginOAuthSignInRunner: null,
  completeOAuthSignInRunner: null,
  markOAuthCredentialCompletedRunner: null,
  skipReason: "provider_config_inactive",
  loadAttempted: false,
  errorCode: null,
};
let identityProviderBundlePrivateConfigCache = null;
let identityProviderBundlePrivateConfigErrorCode = null;

function identityProviderBundle_sanitizePhase(value) {
  const text = String(value || "").trim();
  return /^3\\.0[HKLRX]$/.test(text) ? text : null;
}

function identityProviderBundle_sanitizeKind(value) {
  const text = String(value || "").trim();
  if (text === "skipped"
    || text === "dummy"
    || text === "supabase-sdk-import-probe"
    || text === "supabase-adapter-import-smoke"
    || text === "supabase-client-create-smoke") return text;
  return "unknown";
}

const IDENTITY_PROVIDER_BUNDLE_ALLOWED_OPS = Object.freeze([
  "requestEmailOtp",
  "verifyEmailOtp",
  "verifySignupEmailCode",
  "refreshProviderSession",
  "signOutProviderSession",
  "signUpWithPassword",
  "resendSignupConfirmation",
  "signInWithPassword",
  "requestPasswordReset",
  "updatePasswordAfterRecovery",
  "changePassword",
  "completeOnboarding",
  "updateIdentityProfile",
  "renameIdentityWorkspace",
  "loadIdentityState",
  "registerDeviceSession",
  "markPasswordSetupCompleted",
  "beginOAuthSignIn",
  "completeOAuthSignIn",
  "markOAuthCredentialCompleted",
]);

function identityProviderBundle_sanitizeAdapter(value) {
  const src = value && typeof value === "object" ? value : null;
  if (!src) return null;
  const rawOps = Array.isArray(src.supportedPlannedOps) ? src.supportedPlannedOps : [];
  const supportedPlannedOps = [];
  for (const raw of rawOps) {
    const op = String(raw || "").trim();
    if (!IDENTITY_PROVIDER_BUNDLE_ALLOWED_OPS.includes(op)) continue;
    if (supportedPlannedOps.includes(op)) continue;
    supportedPlannedOps.push(op);
  }
  return {
    providerKind: src.providerKind === "supabase" ? "supabase" : "unknown",
    adapterLoaded: src.adapterLoaded === true,
    clientFactoryPresent: src.clientFactoryPresent === true,
    clientCreated: src.clientCreated === true,
    clientCreatedAtImport: src.clientCreatedAtImport === true,
    clientSmokeAvailable: src.clientSmokeAvailable === true,
    configPresent: src.configPresent === true,
    networkEnabled: src.networkEnabled === true,
    networkObserved: src.networkObserved === true,
    authCallsObserved: src.authCallsObserved === true,
    otpEnabled: src.otpEnabled === true,
    supportedPlannedOps,
  };
}

function identityProviderBundle_sanitizeSmokeError(value) {
  const text = String(value || "").trim().toLowerCase().replace(/[^a-z0-9_/-]/g, "");
  return text ? text.slice(0, 96) : null;
}

function identityProviderBundle_importErrorCode(error, fallback = "bundle_probe_load_failed") {
  const name = String(error && error.name || "").trim().toLowerCase();
  const message = String(error && error.message || "").trim().toLowerCase();
  const text = name + " " + message;
  if (/syntax/.test(text)) return "bundle_probe_syntax_error";
  if (/security/.test(text)) return "bundle_probe_security_error";
  if (/network|importscripts|script/.test(text)) return "bundle_probe_import_failed";
  return fallback;
}

function identityProviderBundle_sanitizeClientSmoke(value) {
  const src = value && typeof value === "object" ? value : null;
  if (!src) return null;
  return {
    clientSmokeAvailable: src.clientSmokeAvailable === true,
    clientCreatedAtImport: src.clientCreatedAtImport === true,
    clientCreated: src.clientCreated === true,
    networkEnabled: src.networkEnabled === true,
    networkObserved: src.networkObserved === true,
    authCallsObserved: src.authCallsObserved === true,
    otpEnabled: src.otpEnabled === true,
    smokeRun: src.smokeRun === true,
    errorCode: identityProviderBundle_sanitizeSmokeError(src.errorCode),
  };
}

function identityProviderBundle_sanitizeRealConfigSmoke(value) {
  const src = value && typeof value === "object" ? value : null;
  if (!src) return null;
  return {
    realConfigSmokeAvailable: src.realConfigSmokeAvailable === true,
    realConfigSmokeRun: src.realConfigSmokeRun === true,
    realConfigClientCreated: src.realConfigClientCreated === true,
    realConfigNetworkObserved: src.realConfigNetworkObserved === true,
    realConfigAuthCallsObserved: src.realConfigAuthCallsObserved === true,
    realConfigOtpEnabled: src.realConfigOtpEnabled === true,
    errorCode: identityProviderBundle_sanitizeSmokeError(src.errorCode),
  };
}

function identityProviderBundle_sanitizeSdkImport(value) {
  const src = value && typeof value === "object" ? value : null;
  if (!src) return null;
  return {
    package: "provider-sdk",
    importOk: src.importOk === true,
    clientCreated: src.clientCreated === true,
    networkEnabled: src.networkEnabled === true,
    networkObserved: src.networkObserved === true,
    authCallsObserved: src.authCallsObserved === true,
    otpEnabled: src.otpEnabled === true,
  };
}

function identityProviderBundle_defaultClientSmoke() {
  return {
    clientSmokeAvailable: false,
    clientCreatedAtImport: false,
    clientCreated: false,
    networkEnabled: false,
    networkObserved: false,
    authCallsObserved: false,
    otpEnabled: false,
    smokeRun: false,
    errorCode: null,
  };
}

function identityProviderBundle_defaultRealConfigSmoke() {
  return {
    realConfigSmokeAvailable: false,
    realConfigSmokeRun: false,
    realConfigClientCreated: false,
    realConfigNetworkObserved: false,
    realConfigAuthCallsObserved: false,
    realConfigOtpEnabled: false,
    errorCode: null,
  };
}

function identityProviderBundle_markSkipped(reason = "provider_config_inactive") {
  identityProviderBundleProbeState.expected = false;
  identityProviderBundleProbeState.loaded = false;
  identityProviderBundleProbeState.kind = "skipped";
  identityProviderBundleProbeState.phase = "3.0X";
  identityProviderBundleProbeState.adapter = null;
  identityProviderBundleProbeState.sdkImport = null;
  identityProviderBundleProbeState.clientSmoke = identityProviderBundle_defaultClientSmoke();
  identityProviderBundleProbeState.clientSmokeRunner = null;
  identityProviderBundleProbeState.realConfigSmoke = identityProviderBundle_defaultRealConfigSmoke();
  identityProviderBundleProbeState.realConfigSmokeRunner = null;
  identityProviderBundleProbeState.requestEmailOtpRunner = null;
  identityProviderBundleProbeState.verifyEmailOtpRunner = null;
  identityProviderBundleProbeState.verifySignupEmailCodeRunner = null;
  identityProviderBundleProbeState.refreshProviderSessionRunner = null;
  identityProviderBundleProbeState.signOutProviderSessionRunner = null;
  identityProviderBundleProbeState.signUpWithPasswordRunner = null;
  identityProviderBundleProbeState.resendSignupConfirmationRunner = null;
  identityProviderBundleProbeState.signInWithPasswordRunner = null;
  identityProviderBundleProbeState.requestPasswordResetRunner = null;
  identityProviderBundleProbeState.updatePasswordAfterRecoveryRunner = null;
  identityProviderBundleProbeState.changePasswordRunner = null;
  identityProviderBundleProbeState.completeOnboardingRunner = null;
  identityProviderBundleProbeState.updateIdentityProfileRunner = null;
  identityProviderBundleProbeState.renameIdentityWorkspaceRunner = null;
  identityProviderBundleProbeState.loadIdentityStateRunner = null;
  identityProviderBundleProbeState.registerDeviceSessionRunner = null;
  identityProviderBundleProbeState.markPasswordSetupCompletedRunner = null;
  identityProviderBundleProbeState.beginOAuthSignInRunner = null;
  identityProviderBundleProbeState.completeOAuthSignInRunner = null;
  identityProviderBundleProbeState.markOAuthCredentialCompletedRunner = null;
  identityProviderBundleProbeState.skipReason = reason;
  identityProviderBundleProbeState.errorCode = null;
  identityProviderBundlePrivateConfigCache = null;
  identityProviderBundlePrivateConfigErrorCode = null;
}

function identityProviderBundle_runClientSmoke() {
  if (!identityProviderBundleProbeState.clientSmokeRunner) {
    return;
  }
  if (identityProviderBundleProbeState.clientSmoke
    && identityProviderBundleProbeState.clientSmoke.smokeRun === true) {
    return;
  }
  try {
    identityProviderBundleProbeState.clientSmoke = identityProviderBundle_sanitizeClientSmoke(
      identityProviderBundleProbeState.clientSmokeRunner()
    ) || {
      clientSmokeAvailable: false,
      clientCreatedAtImport: false,
      clientCreated: false,
      networkEnabled: false,
      networkObserved: false,
      authCallsObserved: false,
      otpEnabled: false,
      smokeRun: false,
      errorCode: "client_smoke_missing",
    };
  } catch (_) {
    identityProviderBundleProbeState.clientSmoke = {
      clientSmokeAvailable: true,
      clientCreatedAtImport: false,
      clientCreated: false,
      networkEnabled: false,
      networkObserved: false,
      authCallsObserved: false,
      otpEnabled: false,
      smokeRun: true,
      errorCode: "client_smoke_failed",
    };
  }
}

function identityProviderBundle_sanitizePrivateConfig(value) {
  const src = value && typeof value === "object" ? value : null;
  if (!src) return null;
  const configSource = String(src.configSource || "").trim().toLowerCase().replace(/[^a-z0-9_-]/g, "");
  const projectUrl = String(src.projectUrl || "").trim();
  const publicClient = String(src.publicClient || "").trim();
  let parsed = null;
  try {
    parsed = new URL(projectUrl);
  } catch {
    return null;
  }
  if (src.kind !== "identity-provider-private-config") return null;
  if (src.phase !== "3.0Y") return null;
  if (src.providerKind !== "supabase") return null;
  if (configSource !== "dev_env" && configSource !== "dev_local_file") return null;
  if (parsed.protocol !== "https:") return null;
  if (!publicClient) return null;
  return { projectUrl, publicClient, configSource };
}

function identityProviderBundle_loadPrivateConfig() {
  if (identityProviderBundlePrivateConfigCache) {
    return { ok: true, privateConfig: identityProviderBundlePrivateConfigCache };
  }
  if (identityProviderBundlePrivateConfigErrorCode) {
    return { ok: false, errorCode: identityProviderBundlePrivateConfigErrorCode };
  }
  if (!IDENTITY_PROVIDER_PRIVATE_CONFIG_PATH || typeof importScripts !== "function") {
    identityProviderBundlePrivateConfigErrorCode = "private_config_unavailable";
    return { ok: false, errorCode: "private_config_unavailable" };
  }
  try {
    try {
      delete globalThis[IDENTITY_PROVIDER_PRIVATE_CONFIG_GLOBAL];
    } catch {}
    importScripts(IDENTITY_PROVIDER_PRIVATE_CONFIG_PATH);
    const privateConfig = identityProviderBundle_sanitizePrivateConfig(
      globalThis[IDENTITY_PROVIDER_PRIVATE_CONFIG_GLOBAL]
    );
    if (privateConfig) {
      identityProviderBundlePrivateConfigCache = Object.freeze({ ...privateConfig });
      identityProviderBundlePrivateConfigErrorCode = null;
      return { ok: true, privateConfig: identityProviderBundlePrivateConfigCache };
    }
    identityProviderBundlePrivateConfigErrorCode = "private_config_missing";
    return { ok: false, errorCode: "private_config_missing" };
  } catch (error) {
    identityProviderBundlePrivateConfigErrorCode = identityProviderBundle_importErrorCode(
      error,
      "private_config_load_failed"
    ).replace(/^bundle_probe_/, "private_config_");
    return { ok: false, errorCode: identityProviderBundlePrivateConfigErrorCode };
  } finally {
    try {
      delete globalThis[IDENTITY_PROVIDER_PRIVATE_CONFIG_GLOBAL];
    } catch {}
  }
}

function identityProviderBundle_runRealConfigSmoke() {
  if (!identityProviderBundleProbeState.realConfigSmokeRunner) {
    return;
  }
  if (identityProviderBundleProbeState.realConfigSmoke
    && identityProviderBundleProbeState.realConfigSmoke.realConfigSmokeRun === true) {
    return;
  }
  const loadedPrivateConfig = identityProviderBundle_loadPrivateConfig();
  if (!loadedPrivateConfig.ok) {
    identityProviderBundleProbeState.realConfigSmoke = {
      realConfigSmokeAvailable: true,
      realConfigSmokeRun: false,
      realConfigClientCreated: false,
      realConfigNetworkObserved: false,
      realConfigAuthCallsObserved: false,
      realConfigOtpEnabled: false,
      errorCode: loadedPrivateConfig.errorCode || "private_config_unavailable",
    };
    return;
  }
  try {
    identityProviderBundleProbeState.realConfigSmoke = identityProviderBundle_sanitizeRealConfigSmoke(
      identityProviderBundleProbeState.realConfigSmokeRunner(loadedPrivateConfig.privateConfig)
    ) || {
      realConfigSmokeAvailable: false,
      realConfigSmokeRun: false,
      realConfigClientCreated: false,
      realConfigNetworkObserved: false,
      realConfigAuthCallsObserved: false,
      realConfigOtpEnabled: false,
      errorCode: "real_config_smoke_missing",
    };
  } catch (_) {
    identityProviderBundleProbeState.realConfigSmoke = {
      realConfigSmokeAvailable: true,
      realConfigSmokeRun: true,
      realConfigClientCreated: false,
      realConfigNetworkObserved: false,
      realConfigAuthCallsObserved: false,
      realConfigOtpEnabled: false,
      errorCode: "real_config_smoke_failed",
    };
  }
}

function identityProviderBundle_loadProbe() {
  identityProviderBundleProbeState.expected = true;
  identityProviderBundleProbeState.loadAttempted = true;
  identityProviderBundleProbeState.skipReason = null;
  if (!IDENTITY_PROVIDER_BUNDLE_PATH || typeof importScripts !== "function") {
    identityProviderBundleProbeState.errorCode = "bundle_probe_unavailable";
    return;
  }
  try {
    importScripts(IDENTITY_PROVIDER_BUNDLE_PATH);
    const probe = globalThis.H2O_IDENTITY_PROVIDER_BUNDLE_PROBE;
    const kind = identityProviderBundle_sanitizeKind(probe && probe.kind);
    const loaded = !!(probe && probe.ok === true && kind !== "unknown");
    identityProviderBundleProbeState.loaded = loaded;
    identityProviderBundleProbeState.kind = loaded ? kind : "unknown";
    identityProviderBundleProbeState.phase = loaded
      ? (identityProviderBundle_sanitizePhase(probe.phase) || identityProviderBundle_sanitizePhase(probe.version))
      : null;
    identityProviderBundleProbeState.adapter = loaded ? identityProviderBundle_sanitizeAdapter(probe.adapter) : null;
    identityProviderBundleProbeState.sdkImport = loaded ? identityProviderBundle_sanitizeSdkImport(probe.sdkImport) : null;
    identityProviderBundleProbeState.clientSmoke = loaded ? identityProviderBundle_sanitizeClientSmoke(probe.clientSmoke) : null;
    identityProviderBundleProbeState.clientSmokeRunner = loaded && typeof probe.runClientSmoke === "function"
      ? probe.runClientSmoke
      : null;
    identityProviderBundleProbeState.realConfigSmoke = loaded
      ? identityProviderBundle_sanitizeRealConfigSmoke(probe.realConfigSmoke)
      : null;
    identityProviderBundleProbeState.realConfigSmokeRunner = loaded && typeof probe.runRealConfigClientSmoke === "function"
      ? probe.runRealConfigClientSmoke
      : null;
    identityProviderBundleProbeState.requestEmailOtpRunner = loaded && typeof probe.requestEmailOtp === "function"
      ? probe.requestEmailOtp
      : null;
    identityProviderBundleProbeState.verifyEmailOtpRunner = loaded && typeof probe.verifyEmailOtp === "function"
      ? probe.verifyEmailOtp
      : null;
    identityProviderBundleProbeState.verifySignupEmailCodeRunner = loaded && typeof probe.verifySignupEmailCode === "function"
      ? probe.verifySignupEmailCode
      : null;
    identityProviderBundleProbeState.refreshProviderSessionRunner = loaded && typeof probe.refreshProviderSession === "function"
      ? probe.refreshProviderSession
      : null;
    identityProviderBundleProbeState.signOutProviderSessionRunner = loaded && typeof probe.signOutProviderSession === "function"
      ? probe.signOutProviderSession
      : null;
    identityProviderBundleProbeState.signUpWithPasswordRunner = loaded && typeof probe.signUpWithPassword === "function"
      ? probe.signUpWithPassword
      : null;
    identityProviderBundleProbeState.resendSignupConfirmationRunner = loaded && typeof probe.resendSignupConfirmation === "function"
      ? probe.resendSignupConfirmation
      : null;
    identityProviderBundleProbeState.signInWithPasswordRunner = loaded && typeof probe.signInWithPassword === "function"
      ? probe.signInWithPassword
      : null;
    identityProviderBundleProbeState.requestPasswordResetRunner = loaded && typeof probe.requestPasswordReset === "function"
      ? probe.requestPasswordReset
      : null;
    identityProviderBundleProbeState.updatePasswordAfterRecoveryRunner = loaded && typeof probe.updatePasswordAfterRecovery === "function"
      ? probe.updatePasswordAfterRecovery
      : null;
    identityProviderBundleProbeState.changePasswordRunner = loaded && typeof probe.changePassword === "function"
      ? probe.changePassword
      : null;
    identityProviderBundleProbeState.completeOnboardingRunner = loaded && typeof probe.completeOnboarding === "function"
      ? probe.completeOnboarding
      : null;
    identityProviderBundleProbeState.updateIdentityProfileRunner = loaded && typeof probe.updateIdentityProfile === "function"
      ? probe.updateIdentityProfile
      : null;
    identityProviderBundleProbeState.renameIdentityWorkspaceRunner = loaded && typeof probe.renameIdentityWorkspace === "function"
      ? probe.renameIdentityWorkspace
      : null;
    identityProviderBundleProbeState.loadIdentityStateRunner = loaded && typeof probe.loadIdentityState === "function"
      ? probe.loadIdentityState
      : null;
    identityProviderBundleProbeState.registerDeviceSessionRunner = loaded && typeof probe.registerDeviceSession === "function"
      ? probe.registerDeviceSession
      : null;
    identityProviderBundleProbeState.markPasswordSetupCompletedRunner = loaded && typeof probe.markPasswordSetupCompleted === "function"
      ? probe.markPasswordSetupCompleted
      : null;
    identityProviderBundleProbeState.beginOAuthSignInRunner = loaded && typeof probe.beginOAuthSignIn === "function"
      ? probe.beginOAuthSignIn
      : null;
    identityProviderBundleProbeState.completeOAuthSignInRunner = loaded && typeof probe.completeOAuthSignIn === "function"
      ? probe.completeOAuthSignIn
      : null;
    identityProviderBundleProbeState.markOAuthCredentialCompletedRunner = loaded && typeof probe.markOAuthCredentialCompleted === "function"
      ? probe.markOAuthCredentialCompleted
      : null;
    identityProviderBundleProbeState.errorCode = loaded ? null : "bundle_probe_missing";
  } catch (error) {
    identityProviderBundleProbeState.loaded = false;
    identityProviderBundleProbeState.kind = "unknown";
    identityProviderBundleProbeState.phase = null;
    identityProviderBundleProbeState.adapter = null;
    identityProviderBundleProbeState.sdkImport = null;
    identityProviderBundleProbeState.clientSmoke = null;
    identityProviderBundleProbeState.clientSmokeRunner = null;
    identityProviderBundleProbeState.realConfigSmoke = null;
    identityProviderBundleProbeState.realConfigSmokeRunner = null;
    identityProviderBundleProbeState.requestEmailOtpRunner = null;
    identityProviderBundleProbeState.verifyEmailOtpRunner = null;
    identityProviderBundleProbeState.verifySignupEmailCodeRunner = null;
    identityProviderBundleProbeState.refreshProviderSessionRunner = null;
    identityProviderBundleProbeState.signOutProviderSessionRunner = null;
    identityProviderBundleProbeState.signUpWithPasswordRunner = null;
    identityProviderBundleProbeState.resendSignupConfirmationRunner = null;
    identityProviderBundleProbeState.signInWithPasswordRunner = null;
    identityProviderBundleProbeState.requestPasswordResetRunner = null;
    identityProviderBundleProbeState.updatePasswordAfterRecoveryRunner = null;
    identityProviderBundleProbeState.changePasswordRunner = null;
    identityProviderBundleProbeState.completeOnboardingRunner = null;
    identityProviderBundleProbeState.updateIdentityProfileRunner = null;
    identityProviderBundleProbeState.renameIdentityWorkspaceRunner = null;
    identityProviderBundleProbeState.loadIdentityStateRunner = null;
    identityProviderBundleProbeState.markPasswordSetupCompletedRunner = null;
    identityProviderBundleProbeState.beginOAuthSignInRunner = null;
    identityProviderBundleProbeState.completeOAuthSignInRunner = null;
    identityProviderBundleProbeState.markOAuthCredentialCompletedRunner = null;
    identityProviderBundleProbeState.skipReason = null;
    identityProviderBundleProbeState.errorCode = identityProviderBundle_importErrorCode(error, "bundle_probe_load_failed");
  }
}

function identityProviderBundle_shouldLoadProbe() {
  const injected = identityProviderConfig_getInjectedSource();
  return Boolean(injected && identityProviderConfig_isSupabaseConfigured(injected));
}

function identityProviderBundle_ensureProbeLoaded() {
  if (identityProviderBundleProbeState.loaded === true
    || identityProviderBundleProbeState.loadAttempted === true) {
    return;
  }
  if (!identityProviderBundle_shouldLoadProbe()) {
    identityProviderBundle_markSkipped("provider_config_inactive");
    return;
  }
  identityProviderBundle_loadProbe();
}

function identityProviderBundle_bootstrapConfiguredProbe() {
  if (!identityProviderBundle_shouldLoadProbe()) {
    identityProviderBundle_markSkipped("provider_config_inactive");
    return;
  }
  identityProviderBundle_ensureProbeLoaded();
  if (identityProviderBundleProbeState.loaded === true) {
    identityProviderBundle_loadPrivateConfig();
  }
}

function identityProviderBundle_getProbeStatus() {
  identityProviderBundle_ensureProbeLoaded();
  if (identityProviderBundleProbeState.loaded === true) {
    identityProviderBundle_runClientSmoke();
    identityProviderBundle_runRealConfigSmoke();
  }
  const smoke = identityProviderBundleProbeState.clientSmoke || identityProviderBundle_defaultClientSmoke();
  const realSmoke = identityProviderBundleProbeState.realConfigSmoke || identityProviderBundle_defaultRealConfigSmoke();
  const out = {
    expected: identityProviderBundleProbeState.expected === true,
    loaded: identityProviderBundleProbeState.loaded === true,
    kind: identityProviderBundleProbeState.kind || "unknown",
    phase: identityProviderBundleProbeState.phase || null,
    skipReason: identityProviderBundleProbeState.skipReason || null,
    errorCode: identityProviderBundleProbeState.errorCode || null,
  };
  if (identityProviderBundleProbeState.adapter) {
    out.adapter = {
      ...identityProviderBundleProbeState.adapter,
      supportedPlannedOps: [...identityProviderBundleProbeState.adapter.supportedPlannedOps],
    };
  }
  if (identityProviderBundleProbeState.sdkImport) {
    out.sdkImport = { ...identityProviderBundleProbeState.sdkImport };
  }
  out.clientSmokeAvailable = smoke.clientSmokeAvailable === true;
  out.clientCreatedAtImport = smoke.clientCreatedAtImport === true;
  out.clientCreated = smoke.clientCreated === true;
  out.networkEnabled = smoke.networkEnabled === true;
  out.networkObserved = smoke.networkObserved === true;
  out.authCallsObserved = smoke.authCallsObserved === true;
  out.otpEnabled = smoke.otpEnabled === true;
  out.smokeRun = smoke.smokeRun === true;
  out.clientSmokeErrorCode = smoke.errorCode || null;
  out.realConfigSmokeAvailable = realSmoke.realConfigSmokeAvailable === true;
  out.realConfigSmokeRun = realSmoke.realConfigSmokeRun === true;
  out.realConfigClientCreated = realSmoke.realConfigClientCreated === true;
  out.realConfigNetworkObserved = realSmoke.realConfigNetworkObserved === true;
  out.realConfigAuthCallsObserved = realSmoke.realConfigAuthCallsObserved === true;
  out.realConfigOtpEnabled = realSmoke.realConfigOtpEnabled === true;
  out.realConfigSmokeErrorCode = realSmoke.errorCode || null;
  out.privateConfigErrorCode = identityProviderBundlePrivateConfigErrorCode || null;
  out.clientReady = out.realConfigClientCreated === true
    && out.realConfigNetworkObserved !== true
    && out.realConfigAuthCallsObserved !== true
    && out.realConfigOtpEnabled !== true;
  return out;
}

const BILLING_ALLOWED_ACTIONS = Object.freeze([
  "billing:create-checkout-session",
  "billing:get-current-entitlement",
  "billing:create-customer-portal-session",
]);
const BILLING_SAFE_ERROR_CODES = new Set([
  "billing/invalid-plan-key",
  "billing/session-required",
  "billing/provider-unavailable",
  "billing/checkout-failed",
  "billing/checkout-url-invalid",
  "billing/checkout-already-pending",
  "billing/entitlement-failed",
  "billing/subscription-already-active",
  "billing/customer-not-found",
  "billing/portal-failed",
  "billing/portal-url-invalid",
]);
const BILLING_CHECKOUT_URL_PREFIX = "https://checkout.stripe.com/";
const BILLING_PORTAL_URL_PREFIX = "https://billing.stripe.com/";

function billingSafeError(errorCode, errorMessage = "") {
  const code = BILLING_SAFE_ERROR_CODES.has(String(errorCode || "").trim())
    ? String(errorCode || "").trim()
    : "billing/checkout-failed";
  const out = { ok: false, errorCode: code };
  const message = String(errorMessage || "").trim();
  if (message) out.errorMessage = message.slice(0, 180);
  return out;
}

function billingNormalizePlanKey(value) {
  const planKey = String(value || "").trim();
  return planKey === "pro_monthly" || planKey === "pro_yearly" ? planKey : "";
}

function billingNormalizeCheckoutUrl(value) {
  const url = String(value || "").trim();
  return url.startsWith(BILLING_CHECKOUT_URL_PREFIX) ? url : "";
}

function billingNormalizePortalUrl(value) {
  const url = String(value || "").trim();
  return url.startsWith(BILLING_PORTAL_URL_PREFIX) ? url : "";
}

function billingProviderRunner() {
  const probe = globalThis.H2O_BILLING_PROVIDER_BUNDLE_PROBE;
  return probe && probe.ok === true && typeof probe.createCheckoutSession === "function"
    ? probe.createCheckoutSession
    : null;
}

function billingProviderEntitlementRunner() {
  const probe = globalThis.H2O_BILLING_PROVIDER_BUNDLE_PROBE;
  return probe && probe.ok === true && typeof probe.getCurrentEntitlement === "function"
    ? probe.getCurrentEntitlement
    : null;
}

function billingProviderPortalRunner() {
  const probe = globalThis.H2O_BILLING_PROVIDER_BUNDLE_PROBE;
  return probe && probe.ok === true && typeof probe.createCustomerPortalSession === "function"
    ? probe.createCustomerPortalSession
    : null;
}

function billingNormalizeNullableIso(value) {
  if (value == null || value === "") return null;
  const text = String(value || "").trim();
  const ms = Date.parse(text);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function billingNormalizeEntitlement(input) {
  const src = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  return {
    tier: String(src.tier || "free").trim() === "pro" ? "pro" : "free",
    premiumEnabled: src.premiumEnabled === true,
    subscriptionStatus: src.subscriptionStatus == null
      ? null
      : String(src.subscriptionStatus || "").trim().replace(/[^a-z0-9_:-]/gi, "").slice(0, 64) || null,
    currentPeriodEnd: billingNormalizeNullableIso(src.currentPeriodEnd),
    cancelAtPeriodEnd: src.cancelAtPeriodEnd === true,
    validUntil: billingNormalizeNullableIso(src.validUntil),
    syncedAt: billingNormalizeNullableIso(src.syncedAt),
  };
}

async function billingHandleCreateCheckoutSession(req = {}) {
  const action = String(req && req.action || "").trim();
  if (!BILLING_ALLOWED_ACTIONS.includes(action)) {
    return billingSafeError("billing/provider-unavailable", "billing-stage/background-action-blocked");
  }
  const planKey = billingNormalizePlanKey(req && req.planKey);
  if (!planKey) return billingSafeError("billing/invalid-plan-key");

  const runner = billingProviderRunner();
  if (!runner) return billingSafeError("billing/provider-unavailable", "billing-stage/background-provider-runner-missing");

  const loadedPrivateConfig = identityProviderBundle_loadPrivateConfig();
  if (!loadedPrivateConfig.ok || !loadedPrivateConfig.privateConfig) {
    return billingSafeError("billing/provider-unavailable", "billing-stage/background-private-config-missing");
  }

  await identityProviderSession_hydrateOnWake({
    reason: "billing-checkout",
    broadcast: true,
    allowRefresh: true,
  });
  const sessionResult = await identityProviderSession_readRpcSessionForOnboarding(null);
  if (!sessionResult || sessionResult.ok !== true || !sessionResult.rawSession) {
    return billingSafeError("billing/session-required", "billing-stage/background-session-missing");
  }
  const accessToken = identityProviderSession_accessToken(sessionResult.rawSession);
  if (!accessToken) return billingSafeError("billing/session-required", "billing-stage/background-access-token-missing");

  let providerResult = null;
  try {
    providerResult = await runner({
      action,
      planKey,
      projectUrl: loadedPrivateConfig.privateConfig.projectUrl,
      publicClient: loadedPrivateConfig.privateConfig.publicClient,
      accessToken,
    });
  } catch (_) {
    return billingSafeError("billing/checkout-failed", "billing-stage/background-provider-threw");
  }

  if (!providerResult || providerResult.ok !== true) {
    return billingSafeError(providerResult && providerResult.errorCode, providerResult && providerResult.errorMessage);
  }
  const url = billingNormalizeCheckoutUrl(providerResult.url);
  if (!url) return billingSafeError("billing/checkout-url-invalid");
  return { ok: true, url };
}

async function billingHandleGetCurrentEntitlement(req = {}) {
  const action = String(req && req.action || "").trim();
  if (!BILLING_ALLOWED_ACTIONS.includes(action)) {
    return billingSafeError("billing/provider-unavailable", "billing-stage/background-action-blocked");
  }

  const runner = billingProviderEntitlementRunner();
  if (!runner) return billingSafeError("billing/provider-unavailable", "billing-stage/background-provider-runner-missing");

  const loadedPrivateConfig = identityProviderBundle_loadPrivateConfig();
  if (!loadedPrivateConfig.ok || !loadedPrivateConfig.privateConfig) {
    return billingSafeError("billing/provider-unavailable", "billing-stage/background-private-config-missing");
  }

  await identityProviderSession_hydrateOnWake({
    reason: "billing-entitlement",
    broadcast: true,
    allowRefresh: true,
  });
  const sessionResult = await identityProviderSession_readRpcSessionForOnboarding(null);
  if (!sessionResult || sessionResult.ok !== true || !sessionResult.rawSession) {
    return billingSafeError("billing/session-required", "billing-stage/background-session-missing");
  }
  const accessToken = identityProviderSession_accessToken(sessionResult.rawSession);
  if (!accessToken) return billingSafeError("billing/session-required", "billing-stage/background-access-token-missing");

  let providerResult = null;
  try {
    providerResult = await runner({
      action,
      projectUrl: loadedPrivateConfig.privateConfig.projectUrl,
      publicClient: loadedPrivateConfig.privateConfig.publicClient,
      accessToken,
    });
  } catch (_) {
    return billingSafeError("billing/entitlement-failed", "billing-stage/background-provider-threw");
  }

  if (!providerResult || providerResult.ok !== true) {
    return billingSafeError(providerResult && providerResult.errorCode, providerResult && providerResult.errorMessage);
  }
  return {
    ok: true,
    entitlement: billingNormalizeEntitlement(providerResult.entitlement),
  };
}

async function billingHandleCreateCustomerPortalSession(req = {}) {
  const action = String(req && req.action || "").trim();
  if (!BILLING_ALLOWED_ACTIONS.includes(action)) {
    return billingSafeError("billing/provider-unavailable", "billing-stage/background-action-blocked");
  }

  const runner = billingProviderPortalRunner();
  if (!runner) return billingSafeError("billing/provider-unavailable", "billing-stage/background-provider-runner-missing");

  const loadedPrivateConfig = identityProviderBundle_loadPrivateConfig();
  if (!loadedPrivateConfig.ok || !loadedPrivateConfig.privateConfig) {
    return billingSafeError("billing/provider-unavailable", "billing-stage/background-private-config-missing");
  }

  await identityProviderSession_hydrateOnWake({
    reason: "billing-portal",
    broadcast: true,
    allowRefresh: true,
  });
  const sessionResult = await identityProviderSession_readRpcSessionForOnboarding(null);
  if (!sessionResult || sessionResult.ok !== true || !sessionResult.rawSession) {
    return billingSafeError("billing/session-required", "billing-stage/background-session-missing");
  }
  const accessToken = identityProviderSession_accessToken(sessionResult.rawSession);
  if (!accessToken) return billingSafeError("billing/session-required", "billing-stage/background-access-token-missing");

  let providerResult = null;
  try {
    providerResult = await runner({
      action,
      projectUrl: loadedPrivateConfig.privateConfig.projectUrl,
      publicClient: loadedPrivateConfig.privateConfig.publicClient,
      accessToken,
    });
  } catch (_) {
    return billingSafeError("billing/portal-failed", "billing-stage/background-provider-threw");
  }

  if (!providerResult || providerResult.ok !== true) {
    return billingSafeError(providerResult && providerResult.errorCode, providerResult && providerResult.errorMessage);
  }
  const url = billingNormalizePortalUrl(providerResult.url);
  if (!url) return billingSafeError("billing/portal-url-invalid");
  return { ok: true, url };
}

const MODE_LIVE_FIRST = "live_first";
const MODE_ARCHIVE_FIRST = "archive_first";
const MODE_ARCHIVE_ONLY = "archive_only";
const DEFAULT_NS_DISK = "h2o:prm:cgx:h2odata";
const RETENTION_KEEP_LATEST = 30;
const CHUNK_SIZE = 100;
const LABEL_CATALOG_CREATED_AT = "2026-01-01T00:00:00.000Z";
const DEFAULT_LABEL_CATALOG = Object.freeze([
  { id: "wf_draft", name: "Draft", type: "workflow_status", color: "#64748b", sortOrder: 10, createdAt: LABEL_CATALOG_CREATED_AT },
  { id: "wf_in_progress", name: "In Progress", type: "workflow_status", color: "#2563eb", sortOrder: 20, createdAt: LABEL_CATALOG_CREATED_AT },
  { id: "wf_waiting", name: "Waiting", type: "workflow_status", color: "#ca8a04", sortOrder: 30, createdAt: LABEL_CATALOG_CREATED_AT },
  { id: "wf_done", name: "Done", type: "workflow_status", color: "#16a34a", sortOrder: 40, createdAt: LABEL_CATALOG_CREATED_AT },
  { id: "wf_blocked", name: "Blocked", type: "workflow_status", color: "#dc2626", sortOrder: 50, createdAt: LABEL_CATALOG_CREATED_AT },
  { id: "wf_needs_review", name: "Needs Review", type: "workflow_status", color: "#7c3aed", sortOrder: 60, createdAt: LABEL_CATALOG_CREATED_AT },
  { id: "pr_urgent", name: "Urgent", type: "priority", color: "#dc2626", sortOrder: 110, createdAt: LABEL_CATALOG_CREATED_AT },
  { id: "pr_important", name: "Important", type: "priority", color: "#ca8a04", sortOrder: 120, createdAt: LABEL_CATALOG_CREATED_AT },
  { id: "pr_low", name: "Low Priority", type: "priority", color: "#64748b", sortOrder: 130, createdAt: LABEL_CATALOG_CREATED_AT },
  { id: "ac_read_later", name: "Read Later", type: "action", color: "#0d9488", sortOrder: 210, createdAt: LABEL_CATALOG_CREATED_AT },
  { id: "ac_come_back", name: "Come Back", type: "action", color: "#0891b2", sortOrder: 220, createdAt: LABEL_CATALOG_CREATED_AT },
  { id: "ac_follow_up", name: "Follow Up", type: "action", color: "#db2777", sortOrder: 230, createdAt: LABEL_CATALOG_CREATED_AT },
  { id: "ct_reference", name: "Reference", type: "context", color: "#475569", sortOrder: 310, createdAt: LABEL_CATALOG_CREATED_AT },
  { id: "ct_decision", name: "Decision", type: "context", color: "#059669", sortOrder: 320, createdAt: LABEL_CATALOG_CREATED_AT },
  { id: "ct_research", name: "Research", type: "context", color: "#4f46e5", sortOrder: 330, createdAt: LABEL_CATALOG_CREATED_AT },
]);
const LABEL_TYPES = Object.freeze(["workflow_status", "priority", "action", "context", "custom"]);
const CATEGORY_CATALOG_CREATED_AT = "2026-04-21T00:00:00.000Z";
const DEFAULT_CATEGORY_CATALOG = Object.freeze([
  { id: "cat_software_development", name: "Software Development", description: "Programming, debugging, architecture, developer tools, infrastructure, and code workflows.", color: "#2563eb", sortOrder: 10, createdAt: CATEGORY_CATALOG_CREATED_AT, updatedAt: CATEGORY_CATALOG_CREATED_AT, status: "active", replacementCategoryId: null, aliases: ["software", "development", "programming", "coding", "code"] },
  { id: "cat_product_ux_design", name: "Product & UX Design", description: "Product thinking, user experience, interface design, prototyping, and usability decisions.", color: "#7c3aed", sortOrder: 20, createdAt: CATEGORY_CATALOG_CREATED_AT, updatedAt: CATEGORY_CATALOG_CREATED_AT, status: "active", replacementCategoryId: null, aliases: ["product", "ux", "ui", "design", "product design"] },
  { id: "cat_writing_communication", name: "Writing & Communication", description: "Drafting, editing, messaging, documentation, summaries, and communication planning.", color: "#db2777", sortOrder: 30, createdAt: CATEGORY_CATALOG_CREATED_AT, updatedAt: CATEGORY_CATALOG_CREATED_AT, status: "active", replacementCategoryId: null, aliases: ["writing", "communication", "email", "copywriting", "docs"] },
  { id: "cat_research_analysis", name: "Research & Analysis", description: "Research, synthesis, investigation, comparison, data analysis, and evidence review.", color: "#4f46e5", sortOrder: 40, createdAt: CATEGORY_CATALOG_CREATED_AT, updatedAt: CATEGORY_CATALOG_CREATED_AT, status: "active", replacementCategoryId: null, aliases: ["research", "analysis", "analytics", "investigation"] },
  { id: "cat_learning_study", name: "Learning & Study", description: "Teaching, tutoring, study support, explanations, practice, and educational planning.", color: "#0891b2", sortOrder: 50, createdAt: CATEGORY_CATALOG_CREATED_AT, updatedAt: CATEGORY_CATALOG_CREATED_AT, status: "active", replacementCategoryId: null, aliases: ["learning", "study", "education", "course"] },
  { id: "cat_engineering_science", name: "Engineering & Science", description: "Technical engineering, science, mathematics, experiments, systems, and applied problem solving.", color: "#0d9488", sortOrder: 60, createdAt: CATEGORY_CATALOG_CREATED_AT, updatedAt: CATEGORY_CATALOG_CREATED_AT, status: "active", replacementCategoryId: null, aliases: ["engineering", "science", "math", "physics"] },
  { id: "cat_legal_administrative", name: "Legal & Administrative", description: "Legal, policy, compliance, forms, administrative processes, and procedural records.", color: "#475569", sortOrder: 70, createdAt: CATEGORY_CATALOG_CREATED_AT, updatedAt: CATEGORY_CATALOG_CREATED_AT, status: "active", replacementCategoryId: null, aliases: ["legal", "administrative", "admin", "compliance"] },
  { id: "cat_business_operations", name: "Business & Operations", description: "Business planning, operations, sales, finance, strategy, workflows, and organizational work.", color: "#059669", sortOrder: 80, createdAt: CATEGORY_CATALOG_CREATED_AT, updatedAt: CATEGORY_CATALOG_CREATED_AT, status: "active", replacementCategoryId: null, aliases: ["business", "operations", "ops", "strategy"] },
  { id: "cat_personal_planning", name: "Personal Planning", description: "Personal organization, scheduling, decisions, travel planning, goals, and life administration.", color: "#ca8a04", sortOrder: 90, createdAt: CATEGORY_CATALOG_CREATED_AT, updatedAt: CATEGORY_CATALOG_CREATED_AT, status: "active", replacementCategoryId: null, aliases: ["personal", "planning", "life admin", "schedule"] },
  { id: "cat_health_fitness", name: "Health & Fitness", description: "Health, fitness, wellness, nutrition, habits, and non-diagnostic personal care topics.", color: "#16a34a", sortOrder: 100, createdAt: CATEGORY_CATALOG_CREATED_AT, updatedAt: CATEGORY_CATALOG_CREATED_AT, status: "active", replacementCategoryId: null, aliases: ["health", "fitness", "wellness", "nutrition"] },
  { id: "cat_shopping_products", name: "Shopping & Products", description: "Shopping, product research, comparisons, buying decisions, reviews, and recommendations.", color: "#ea580c", sortOrder: 110, createdAt: CATEGORY_CATALOG_CREATED_AT, updatedAt: CATEGORY_CATALOG_CREATED_AT, status: "active", replacementCategoryId: null, aliases: ["shopping", "products", "buying", "reviews"] },
  { id: "cat_general_misc", name: "General / Misc", description: "Broad, mixed, casual, or uncategorized conversations that do not fit another stable category.", color: "#64748b", sortOrder: 120, createdAt: CATEGORY_CATALOG_CREATED_AT, updatedAt: CATEGORY_CATALOG_CREATED_AT, status: "active", replacementCategoryId: null, aliases: ["general", "misc", "miscellaneous", "other"] },
]);

${CATEGORY_CLASSIFIER_RUNTIME_SOURCE}

const DB_NAME = "h2o_chat_archive";
const DB_VERSION = 1;
const STORE_SNAPSHOTS = "snapshots";
const STORE_CHUNKS = "chunks";
const LIBRARY_STORAGE_DIAG_OP = "h2o:library-storage:diagnose";
const LIBRARY_STORAGE_CREATE_EMPTY_SCHEMA_OP = "h2o:library-storage:create-empty-schema";
const LIBRARY_STORAGE_INSPECT_SCHEMA_OP = "h2o:library-storage:inspect-schema";
const LIBRARY_STORAGE_WRITE_CHAT_REGISTRY_MIRROR_OP = "h2o:library-storage:write-chat-registry-mirror";
const LIBRARY_STORAGE_REFRESH_CHAT_REGISTRY_MIRROR_OP = "h2o:library-storage:refresh-chat-registry-mirror";
const LIBRARY_STORAGE_VERIFY_CHAT_REGISTRY_MIRROR_OP = "h2o:library-storage:verify-chat-registry-mirror";
const LIBRARY_STORAGE_READ_CHAT_REGISTRY_RECORD_DIAG_OP = "h2o:library-storage:read-chat-registry-record-diagnostic";
const LIBRARY_STORAGE_READ_CHAT_REGISTRY_MIRROR_ALL_DIAG_OP = "h2o:library-storage:read-chat-registry-mirror-all-diagnostic";
const LIBRARY_SHARED_DB_NAME = "h2o.library.shared";
const LIBRARY_SHARED_DB_VERSION = 1;
const LIBRARY_SHARED_EMPTY_SCHEMA_APPROVAL = "CREATE_EMPTY_H2O_LIBRARY_SHARED_V1";
const LIBRARY_SHARED_CHAT_REGISTRY_MIRROR_WRITE_APPROVAL = "WRITE_CHAT_REGISTRY_MIRROR_V1";
const LIBRARY_SHARED_CHAT_REGISTRY_MIRROR_REFRESH_APPROVAL = "REFRESH_CHAT_REGISTRY_MIRROR_V1";
const LIBRARY_SHARED_MINIMAL_SCHEMA_STORES = Object.freeze([
  "chatRegistry",
  "migrationState",
  "syncState",
]);
const FOLDER_BRIDGE_MESSAGE_TIMEOUT_MS = 3500;
const LIBRARY_SHARED_PLANNED_STORES = Object.freeze([
  "chatRegistry",
  "folders",
  "folderBindings",
  "categories",
  "categoryAssignments",
  "tags",
  "tagSummaries",
  "labels",
  "labelBindings",
  "projects",
  "archiveRefs",
  "syncState",
  "migrationState",
]);
const ARCHIVE_RUNTIME_OPS = Object.freeze([
  "ping",
  LIBRARY_STORAGE_DIAG_OP,
  LIBRARY_STORAGE_CREATE_EMPTY_SCHEMA_OP,
  LIBRARY_STORAGE_INSPECT_SCHEMA_OP,
  LIBRARY_STORAGE_WRITE_CHAT_REGISTRY_MIRROR_OP,
  LIBRARY_STORAGE_VERIFY_CHAT_REGISTRY_MIRROR_OP,
  LIBRARY_STORAGE_READ_CHAT_REGISTRY_RECORD_DIAG_OP,
  LIBRARY_STORAGE_READ_CHAT_REGISTRY_MIRROR_ALL_DIAG_OP,
  "getBootMode",
  "setBootMode",
  "getMigratedFlag",
  "setMigratedFlag",
  "getChatIndex",
  "setChatIndex",
  "captureSnapshot",
  "loadLatestSnapshot",
  "loadSnapshot",
  "listSnapshots",
  "listAllChatIds",
  "listChatIds",
  "listWorkbenchRows",
  "getFoldersList",
  "resolveFolderBindings",
  "setFolderBinding",
  "setFolderIconColor",
  "upsertLatestSnapshotMeta",
  "getLabelsCatalog",
  "getCategoriesCatalog",
  "renameCategory",
  "deleteCategory",
  "setSnapshotCategory",
  "reclassifySnapshotCategory",
  "pinSnapshot",
  "deleteSnapshot",
  "applyRetention",
  "openWorkbench",
  "libraryKvGet",
  "libraryKvSet",
  "libraryKvDel",
  "libraryKvListKeys",
  "libraryKvEstimate",
  "exportBundle",
  "importBundle",
  "fetchPageMetadata",
  // v2 full-bundle migration (chat archive + chrome.storage.local + library-kv).
  // See exportFullBundle / dryRunImportFullBundle / importFullBundle below.
  "exportFullBundle",
  "dryRunImportFullBundle",
  "importFullBundle",
]);

function normHeaders(h) {
  if (!h || typeof h !== "object") return {};
  const out = {};
  for (const [k, v] of Object.entries(h)) {
    if (v == null) continue;
    out[String(k)] = String(v);
  }
  return out;
}

function nowIso() {
  return new Date().toISOString();
}

function normalizeChatId(raw) {
  return String(raw || "").trim();
}

function normalizeMode(raw) {
  const m = String(raw || "").trim().toLowerCase();
  if (m === MODE_ARCHIVE_FIRST) return MODE_ARCHIVE_FIRST;
  if (m === MODE_ARCHIVE_ONLY) return MODE_ARCHIVE_ONLY;
  return MODE_LIVE_FIRST;
}

function normalizeNsDisk(raw) {
  const ns = String(raw || "").trim();
  return ns || DEFAULT_NS_DISK;
}

function modeKey(nsDisk, chatId) {
  return normalizeNsDisk(nsDisk) + ":chatBootMode:" + String(chatId || "");
}

function indexKey(nsDisk, chatId) {
  return normalizeNsDisk(nsDisk) + ":chatIndex:" + String(chatId || "");
}

function migratedKey(nsDisk, chatId) {
  return normalizeNsDisk(nsDisk) + ":chatMigrated:" + String(chatId || "") + ":v1";
}

function legacyModeKey(chatId) {
  return "h2o:chatBootMode:" + String(chatId || "");
}

function legacyIndexKey(chatId) {
  return "h2o:chatIndex:" + String(chatId || "");
}

function legacyMigratedKey(chatId) {
  return "h2o:chatMigrated:" + String(chatId || "") + ":v1";
}

function uniqStringList(list) {
  const seen = new Set();
  const out = [];
  const src = Array.isArray(list) ? list : [];
  for (const item of src) {
    const v = String(item || "").trim();
    if (!v || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}


function normalizeOriginSource(raw) {
  const value = String(raw || "").trim().toLowerCase();
  if (value === "mobile") return "mobile";
  if (value === "browser") return "browser";
  return "unknown";
}

function normalizeProjectRef(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  const id = String(src.id || src.projectId || "").trim();
  if (!id) return null;
  const name = String(src.name || src.projectName || id).trim() || id;
  return { id, name };
}

function normalizeHexColor(raw) {
  const value = String(raw || "").trim();
  return /^#[0-9a-f]{6}$/i.test(value) ? value.toUpperCase() : "";
}

function normalizeCategoryAssignment(raw) {
  return normalizeCategoryRecord(raw, DEFAULT_CATEGORY_CATALOG);
}

function normalizeCategoryStatus(raw) {
  const value = String(raw || "").trim().toLowerCase();
  if (value === "deprecated" || value === "retired") return value;
  return "active";
}

function normalizeCategoryRecordCatalog(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  const id = String(src.id || "").trim();
  if (!id) return null;
  const sortOrderRaw = Number(src.sortOrder);
  const replacementCategoryId = String(src.replacementCategoryId || "").trim();
  const description = String(src.description || "").trim();
  const color = String(src.color || "").trim();
  const updatedAt = String(src.updatedAt || "").trim();
  return {
    ...src,
    id,
    name: String(src.name || src.title || id).trim() || id,
    ...(description ? { description } : {}),
    ...(color ? { color } : {}),
    sortOrder: Number.isFinite(sortOrderRaw) ? Math.floor(sortOrderRaw) : 0,
    createdAt: String(src.createdAt || CATEGORY_CATALOG_CREATED_AT).trim() || CATEGORY_CATALOG_CREATED_AT,
    ...(updatedAt ? { updatedAt } : {}),
    status: normalizeCategoryStatus(src.status),
    replacementCategoryId: replacementCategoryId || null,
    aliases: normalizeStringArray(src.aliases),
  };
}

function normalizeCategoryCatalog(raw) {
  const src = Array.isArray(raw) ? raw : [];
  const out = [];
  const seen = new Set();
  for (const item of src) {
    const record = normalizeCategoryRecordCatalog(item);
    if (!record || seen.has(record.id)) continue;
    seen.add(record.id);
    out.push(record);
  }
  out.sort((a, b) => (
    Number(a.sortOrder || 0) - Number(b.sortOrder || 0)
    || String(a.name || a.id).localeCompare(String(b.name || b.id))
    || String(a.id).localeCompare(String(b.id))
  ));
  return out;
}

function mergeCategoryCatalogs(...catalogs) {
  const out = [];
  const seen = new Set();
  for (const catalog of catalogs) {
    for (const record of normalizeCategoryCatalog(catalog)) {
      if (seen.has(record.id)) continue;
      seen.add(record.id);
      out.push(record);
    }
  }
  return normalizeCategoryCatalog(out);
}

function seedDefaultCategoryCatalog(records) {
  return mergeCategoryCatalogs(records, DEFAULT_CATEGORY_CATALOG);
}

function categoryCatalogIndex(catalogRaw) {
  const records = seedDefaultCategoryCatalog(catalogRaw);
  const byId = new Map();
  const aliasToId = new Map();
  for (const record of records) {
    byId.set(record.id, record);
    for (const alias of record.aliases || []) {
      const key = String(alias || "").trim().toLowerCase();
      if (key && !aliasToId.has(key)) aliasToId.set(key, record.id);
    }
  }
  return { records, byId, aliasToId };
}

function resolveCategoryAlias(raw, catalogRaw) {
  const id = String(raw || "").trim();
  if (!id) return "";
  const index = categoryCatalogIndex(catalogRaw);
  if (index.byId.has(id)) return id;
  return index.aliasToId.get(id.toLowerCase()) || "";
}

function resolveActiveCategoryId(raw, index, seen = new Set()) {
  const resolved = resolveCategoryAlias(raw, index.records);
  if (!resolved || seen.has(resolved)) return null;
  seen.add(resolved);
  const record = index.byId.get(resolved);
  if (!record) return null;
  if (record.status === "active") return record.id;
  if (record.status === "deprecated" && record.replacementCategoryId) {
    return resolveActiveCategoryId(record.replacementCategoryId, index, seen);
  }
  return null;
}

function isRetiredUserPrimaryCategoryRecord(raw, catalogRaw = DEFAULT_CATEGORY_CATALOG) {
  const src = raw && typeof raw === "object" ? raw : {};
  if (normalizeCategorySource(src.source) !== "user") return false;
  const index = categoryCatalogIndex(catalogRaw);
  const primary = resolveCategoryAlias(src.primaryCategoryId || src.primary, index.records);
  return !!(primary && index.byId.get(primary) && index.byId.get(primary).status === "retired");
}

function normalizeCategorySource(raw) {
  const value = String(raw || "").trim().toLowerCase();
  if (value === "user" || value === "manual_override") return "user";
  if (value === "system" || value === "auto") return "system";
  return "";
}

function normalizeCategoryConfidence(raw) {
  const n = Number(raw);
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : null;
}

function normalizeCategoryRecord(raw, catalogRaw = DEFAULT_CATEGORY_CATALOG) {
  const src = raw && typeof raw === "object" ? raw : {};
  const index = categoryCatalogIndex(catalogRaw);
  const primaryCategoryId = resolveActiveCategoryId(src.primaryCategoryId || src.primary, index);
  if (!primaryCategoryId) return null;
  const secondaryRaw = String(src.secondaryCategoryId || src.secondary || "").trim();
  const secondaryCategoryId = secondaryRaw ? resolveActiveCategoryId(secondaryRaw, index) : null;
  if (secondaryRaw && !secondaryCategoryId) return null;
  if (secondaryCategoryId && secondaryCategoryId === primaryCategoryId) return null;
  const source = normalizeCategorySource(src.source);
  if (!source) return null;
  if (source === "user") {
    return {
      primaryCategoryId,
      secondaryCategoryId,
      source,
      algorithmVersion: null,
      classifiedAt: null,
      overriddenAt: String(src.overriddenAt || src.classifiedAt || "").trim() || null,
      confidence: null,
    };
  }
  const algorithmVersion = String(src.algorithmVersion || "").trim();
  const classifiedAt = String(src.classifiedAt || "").trim();
  if (!algorithmVersion || !classifiedAt) return null;
  return {
    primaryCategoryId,
    secondaryCategoryId,
    source,
    algorithmVersion,
    classifiedAt,
    overriddenAt: null,
    confidence: normalizeCategoryConfidence(src.confidence),
  };
}

function mergeCategoryRecords(localRaw, incomingRaw, catalogRaw = DEFAULT_CATEGORY_CATALOG) {
  const local = normalizeCategoryRecord(localRaw, catalogRaw);
  const incoming = normalizeCategoryRecord(incomingRaw, catalogRaw);
  if (!local && isRetiredUserPrimaryCategoryRecord(localRaw, catalogRaw)) return null;
  if (!local) return incoming;
  if (!incoming) return local;
  if (local.source === "user" && incoming.source === "system") return local;
  if (local.source === "system" && incoming.source === "user") return incoming;
  if (local.source === "system" && incoming.source === "system") return local;
  const localOverriddenAt = String(local.overriddenAt || "").trim();
  const incomingOverriddenAt = String(incoming.overriddenAt || "").trim();
  return incomingOverriddenAt && incomingOverriddenAt > localOverriddenAt ? incoming : local;
}

function normalizeStringArray(raw) {
  return uniqStringList(Array.isArray(raw) ? raw : []);
}

function normalizeLabelAssignments(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  return {
    workflowStatusLabelId: String(src.workflowStatusLabelId || "").trim(),
    priorityLabelId: String(src.priorityLabelId || "").trim(),
    actionLabelIds: normalizeStringArray(src.actionLabelIds),
    contextLabelIds: normalizeStringArray(src.contextLabelIds),
    customLabelIds: normalizeStringArray(src.customLabelIds),
  };
}

function normalizeKeywords(raw) {
  return normalizeStringArray(raw);
}

function normalizeTags(raw) {
  return normalizeStringArray(raw);
}

function normalizeSnapshotMetaCategory(src, out, categoryCatalog, classificationInput = null) {
  const existing = normalizeCategoryRecord(src.category, categoryCatalog);
  if (existing) return existing;
  if (!classificationInput || !Array.isArray(classificationInput.messages)) return null;
  return normalizeCategoryRecord(classifySnapshotCategory(
    {
      meta: out,
      messages: classificationInput.messages,
    },
    {
      classifiedAt: String(classificationInput.classifiedAt || ""),
    },
  ), categoryCatalog);
}

function normalizeLabelType(raw) {
  const value = String(raw || "").trim();
  return LABEL_TYPES.includes(value) ? value : "custom";
}

function normalizeLabelRecord(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  const id = String(src.id || "").trim();
  if (!id) return null;
  const sortOrderRaw = Number(src.sortOrder);
  return {
    ...src,
    id,
    name: String(src.name || src.title || id).trim() || id,
    type: normalizeLabelType(src.type),
    color: String(src.color || "").trim(),
    sortOrder: Number.isFinite(sortOrderRaw) ? Math.floor(sortOrderRaw) : 0,
    createdAt: String(src.createdAt || LABEL_CATALOG_CREATED_AT).trim() || LABEL_CATALOG_CREATED_AT,
  };
}

function normalizeLabelCatalog(raw) {
  const src = Array.isArray(raw) ? raw : [];
  const out = [];
  const seen = new Set();
  for (const item of src) {
    const record = normalizeLabelRecord(item);
    if (!record || seen.has(record.id)) continue;
    seen.add(record.id);
    out.push(record);
  }
  out.sort((a, b) => (
    String(a.type || "").localeCompare(String(b.type || ""))
    || Number(a.sortOrder || 0) - Number(b.sortOrder || 0)
    || String(a.name || a.id).localeCompare(String(b.name || b.id))
    || String(a.id).localeCompare(String(b.id))
  ));
  return out;
}

function mergeLabelCatalogs(...catalogs) {
  const out = [];
  const seen = new Set();
  for (const catalog of catalogs) {
    for (const record of normalizeLabelCatalog(catalog)) {
      if (seen.has(record.id)) continue;
      seen.add(record.id);
      out.push(record);
    }
  }
  return normalizeLabelCatalog(out);
}

function seedDefaultLabelCatalog(records) {
  return mergeLabelCatalogs(records, DEFAULT_LABEL_CATALOG);
}

function normalizeSnapshotMeta(raw, categoryCatalog = DEFAULT_CATEGORY_CATALOG, classificationInput = null) {
  const src = raw && typeof raw === "object" ? raw : {};
  const out = { ...src };
  const folderId = String(src.folderId || src.folder || "").trim();
  if (folderId) out.folderId = folderId;
  else delete out.folderId;
  const folderName = String(src.folderName || "").trim();
  if (folderName) out.folderName = folderName;
  else delete out.folderName;
  out.originSource = normalizeOriginSource(src.originSource);
  out.originProjectRef = normalizeProjectRef(src.originProjectRef);
  out.labels = normalizeLabelAssignments(src.labels);
  out.tags = normalizeTags(src.tags);
  out.keywords = normalizeKeywords(src.keywords);
  out.category = normalizeSnapshotMetaCategory(src, out, categoryCatalog, classificationInput);
  return out;
}

function normalizeSnapshotMetaPatch(raw = {}) {
  const src = raw && typeof raw === "object" ? raw : {};
  const out = {};
  if (Object.prototype.hasOwnProperty.call(src, "folderId") || Object.prototype.hasOwnProperty.call(src, "folder")) {
    out.folderId = String(src.folderId || src.folder || "").trim();
  }
  if (Object.prototype.hasOwnProperty.call(src, "folderName")) out.folderName = String(src.folderName || "").trim();
  return out;
}

function mergeSnapshotMetaPatch(baseMetaRaw, patchRaw = {}, opts = {}, categoryCatalog = DEFAULT_CATEGORY_CATALOG) {
  const base = normalizeSnapshotMeta(baseMetaRaw, categoryCatalog);
  const patch = normalizeSnapshotMetaPatch(patchRaw);
  const next = { ...base, ...patch, updatedAt: nowIso() };
  const source = String(opts && opts.source || "").trim();
  if (source) next.source = source;
  return normalizeSnapshotMeta(next, categoryCatalog);
}

function normalizeRetentionPolicy(raw) {
  const n = Number(raw && raw.keepLatest);
  const keepLatest = Number.isFinite(n) ? Math.max(1, Math.min(1000, Math.floor(n))) : RETENTION_KEEP_LATEST;
  return { keepLatest };
}

function makeDefaultChatIndex() {
  return {
    lastSnapshotId: "",
    lastCapturedAt: "",
    pinnedSnapshotIds: [],
    retentionPolicy: { keepLatest: RETENTION_KEEP_LATEST },
    lastDigest: "",
  };
}

function normalizeChatIndex(raw) {
  const base = makeDefaultChatIndex();
  const obj = raw && typeof raw === "object" ? raw : {};
  return {
    lastSnapshotId: String(obj.lastSnapshotId || ""),
    lastCapturedAt: String(obj.lastCapturedAt || ""),
    pinnedSnapshotIds: uniqStringList(obj.pinnedSnapshotIds),
    retentionPolicy: normalizeRetentionPolicy(obj.retentionPolicy),
    lastDigest: String(obj.lastDigest || ""),
  };
}

function storageGet(keys) {
  return new Promise((resolve, reject) => {
    try {
      chrome.storage.local.get(keys, (res) => {
        const le = chrome.runtime.lastError;
        if (le) return reject(new Error(String(le.message || le)));
        resolve(res || {});
      });
    } catch (e) {
      reject(e);
    }
  });
}

function storageSet(items) {
  return new Promise((resolve, reject) => {
    try {
      chrome.storage.local.set(items || {}, () => {
        const le = chrome.runtime.lastError;
        if (le) return reject(new Error(String(le.message || le)));
        resolve(true);
      });
    } catch (e) {
      reject(e);
    }
  });
}

function storageRemove(keys) {
  return new Promise((resolve, reject) => {
    try {
      chrome.storage.local.remove(keys, () => {
        const le = chrome.runtime.lastError;
        if (le) return reject(new Error(String(le.message || le)));
        resolve(true);
      });
    } catch (e) {
      reject(e);
    }
  });
}

function storageSessionArea() {
  try {
    if (chrome.storage && chrome.storage.session) return chrome.storage.session;
  } catch {}
  return chrome.storage.local;
}

function storageSessionGet(keys) {
  return new Promise((resolve, reject) => {
    try {
      storageSessionArea().get(keys, (res) => {
        const le = chrome.runtime.lastError;
        if (le) return reject(new Error(String(le.message || le)));
        resolve(res || {});
      });
    } catch (e) {
      reject(e);
    }
  });
}

function storageSessionSet(items) {
  return new Promise((resolve, reject) => {
    try {
      storageSessionArea().set(items || {}, () => {
        const le = chrome.runtime.lastError;
        if (le) return reject(new Error(String(le.message || le)));
        resolve(true);
      });
    } catch (e) {
      reject(e);
    }
  });
}

function storageSessionRemove(keys) {
  return new Promise((resolve, reject) => {
    try {
      storageSessionArea().remove(keys, () => {
        const le = chrome.runtime.lastError;
        if (le) return reject(new Error(String(le.message || le)));
        resolve(true);
      });
    } catch (e) {
      reject(e);
    }
  });
}

function providerSessionStorageStrict() {
  try {
    if (chrome.storage && chrome.storage.session) return chrome.storage.session;
  } catch {}
  return null;
}

function providerSessionSet(items) {
  return new Promise((resolve, reject) => {
    const area = providerSessionStorageStrict();
    if (!area) {
      reject(new Error("identity-provider-session-storage-unavailable"));
      return;
    }
    try {
      area.set(items || {}, () => {
        const le = chrome.runtime.lastError;
        if (le) return reject(new Error(String(le.message || le)));
        resolve(true);
      });
    } catch (e) {
      reject(e);
    }
  });
}

function providerSessionGet(keys) {
  return new Promise((resolve, reject) => {
    const area = providerSessionStorageStrict();
    if (!area) {
      reject(new Error("identity-provider-session-storage-unavailable"));
      return;
    }
    try {
      area.get(keys, (res) => {
        const le = chrome.runtime.lastError;
        if (le) return reject(new Error(String(le.message || le)));
        resolve(res || {});
      });
    } catch (e) {
      reject(e);
    }
  });
}

function providerSessionRemove(keys) {
  return new Promise((resolve, reject) => {
    const area = providerSessionStorageStrict();
    if (!area) {
      resolve(false);
      return;
    }
    try {
      area.remove(keys, () => {
        const le = chrome.runtime.lastError;
        if (le) return reject(new Error(String(le.message || le)));
        resolve(true);
      });
    } catch (e) {
      reject(e);
    }
  });
}

function providerPersistentRefreshStorageStrict() {
  try {
    if (chrome.storage && chrome.storage.local) return chrome.storage.local;
  } catch {}
  return null;
}

function providerPersistentRefreshSet(items) {
  return new Promise((resolve, reject) => {
    const area = providerPersistentRefreshStorageStrict();
    if (!area) {
      reject(new Error("identity-provider-persistent-refresh-storage-unavailable"));
      return;
    }
    try {
      area.set(items || {}, () => {
        const le = chrome.runtime.lastError;
        if (le) return reject(new Error(String(le.message || le)));
        resolve(true);
      });
    } catch (e) {
      reject(e);
    }
  });
}

function providerPersistentRefreshGet(keys) {
  return new Promise((resolve, reject) => {
    const area = providerPersistentRefreshStorageStrict();
    if (!area) {
      reject(new Error("identity-provider-persistent-refresh-storage-unavailable"));
      return;
    }
    try {
      area.get(keys, (res) => {
        const le = chrome.runtime.lastError;
        if (le) return reject(new Error(String(le.message || le)));
        resolve(res || {});
      });
    } catch (e) {
      reject(e);
    }
  });
}

function providerPersistentRefreshRemove(keys) {
  return new Promise((resolve, reject) => {
    const area = providerPersistentRefreshStorageStrict();
    if (!area) {
      resolve(false);
      return;
    }
    try {
      area.remove(keys, () => {
        const le = chrome.runtime.lastError;
        if (le) return reject(new Error(String(le.message || le)));
        resolve(true);
      });
    } catch (e) {
      reject(e);
    }
  });
}

function normalizeTabId(raw) {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function normalizeSetSlot(raw) {
  const n = Number(raw);
  return DEV_SET_SLOTS.includes(n) ? n : 0;
}

function pageDisableOnceKey(tabIdRaw) {
  const tabId = normalizeTabId(tabIdRaw);
  return tabId ? ("h2oExtDevPageDisableOnceTab:" + String(tabId)) : "";
}

function pageSetLinkKey(tabIdRaw) {
  const tabId = normalizeTabId(tabIdRaw);
  return tabId ? ("h2oExtDevPageSetLinkTab:" + String(tabId)) : "";
}

function previewSetOnceKey(tabIdRaw) {
  const tabId = normalizeTabId(tabIdRaw);
  return tabId ? ("h2oExtDevPreviewSetOnceTab:" + String(tabId)) : "";
}

function chatSetBindingsStorageKey() {
  return CHAT_SET_BINDINGS_KEY;
}

function globalDefaultSetStorageKey() {
  return GLOBAL_DEFAULT_SET_KEY;
}

function chatSetBypassStorageKey() {
  return CHAT_SET_BYPASS_KEY;
}

function normalizePageDisableOnceRecord(raw) {
  if (raw === true) return { armedAt: 0 };
  const armedAt = Number(raw && raw.armedAt);
  return {
    armedAt: Number.isFinite(armedAt) && armedAt > 0 ? Math.floor(armedAt) : 0,
  };
}

function normalizeChatUrlKey(rawUrl) {
  const raw = String(rawUrl || "").trim();
  if (!raw) return "";
  try {
    const u = new URL(raw);
    const origin = String(u.origin || "").trim();
    if (!origin) return "";
    const parts = String(u.pathname || "/")
      .split("/")
      .filter(Boolean)
      .map((part) => String(part || "").trim())
      .filter(Boolean);
    const cIdx = parts.lastIndexOf("c");
    let pathParts = parts;
    if (cIdx >= 0 && parts[cIdx + 1]) {
      pathParts = parts.slice(0, cIdx + 2);
    }
    const pathname = "/" + pathParts.join("/");
    return origin + (pathname === "/" ? "" : pathname.replace(/\\/+$/, ""));
  } catch {}
  return "";
}

function normalizeChatSetBindings(raw) {
  const out = {};
  const src = raw && typeof raw === "object" ? raw : {};
  for (const [k, v] of Object.entries(src)) {
    const key = String(k || "").trim();
    const slot = normalizeSetSlot(v);
    if (!key || !slot) continue;
    out[key] = slot;
  }
  return out;
}

function normalizeChatSetBypassMap(raw) {
  const out = {};
  const src = raw && typeof raw === "object" ? raw : {};
  for (const [k, v] of Object.entries(src)) {
    const key = String(k || "").trim();
    if (!key || v !== true) continue;
    out[key] = true;
  }
  return out;
}

function normalizeToggleSets(rawSets) {
  const out = {};
  const src = rawSets && typeof rawSets === "object" ? rawSets : {};
  for (const [slot, rawRec] of Object.entries(src)) {
    const slotNum = normalizeSetSlot(slot);
    if (!slotNum || !rawRec || typeof rawRec !== "object") continue;
    const maybeMap = rawRec && typeof rawRec.map === "object" ? rawRec.map : rawRec;
    if (!maybeMap || typeof maybeMap !== "object") continue;
    out[String(slotNum)] = { map: maybeMap };
  }
  return out;
}

async function hasSavedSetSlot(slotRaw) {
  const slot = normalizeSetSlot(slotRaw);
  if (!slot) return false;
  const res = await storageGet([STORAGE_TOGGLE_SETS_KEY]);
  const sets = normalizeToggleSets(res && res[STORAGE_TOGGLE_SETS_KEY]);
  return !!sets[String(slot)];
}

async function getChatBindingsMap() {
  const key = chatSetBindingsStorageKey();
  const res = await storageGet([key]);
  return normalizeChatSetBindings(res && res[key]);
}

async function setChatBindingsMap(mapRaw) {
  const key = chatSetBindingsStorageKey();
  const map = normalizeChatSetBindings(mapRaw);
  await storageSet({ [key]: map });
  return map;
}

async function getChatSetBypassMap() {
  const key = chatSetBypassStorageKey();
  const res = await storageGet([key]);
  return normalizeChatSetBypassMap(res && res[key]);
}

async function setChatSetBypassMap(mapRaw) {
  const key = chatSetBypassStorageKey();
  const map = normalizeChatSetBypassMap(mapRaw);
  await storageSet({ [key]: map });
  return map;
}

async function getChatBypassByUrl(urlRaw) {
  const urlKey = normalizeChatUrlKey(urlRaw);
  if (!urlKey) return false;
  const map = await getChatSetBypassMap();
  return map[urlKey] === true;
}

async function setChatBypassByUrl(urlRaw) {
  const urlKey = normalizeChatUrlKey(urlRaw);
  if (!urlKey) throw new Error("missing chat url");
  const map = await getChatSetBypassMap();
  map[urlKey] = true;
  await setChatSetBypassMap(map);
  return { ok: true, urlKey, enabled: true };
}

async function clearChatBypassByUrl(urlRaw) {
  const urlKey = normalizeChatUrlKey(urlRaw);
  if (!urlKey) return { ok: true, urlKey: "", enabled: false };
  const map = await getChatSetBypassMap();
  if (Object.prototype.hasOwnProperty.call(map, urlKey)) {
    delete map[urlKey];
    await setChatSetBypassMap(map);
  }
  return { ok: true, urlKey, enabled: false };
}

async function getChatBindingByUrl(urlRaw) {
  const urlKey = normalizeChatUrlKey(urlRaw);
  if (!urlKey) return 0;
  const map = await getChatBindingsMap();
  return normalizeSetSlot(map[urlKey]);
}

async function setChatBindingByUrl(urlRaw, slotRaw) {
  const urlKey = normalizeChatUrlKey(urlRaw);
  const slot = normalizeSetSlot(slotRaw);
  if (!urlKey) throw new Error("missing chat url");
  if (!slot) throw new Error("missing slot");
  const map = await getChatBindingsMap();
  map[urlKey] = slot;
  await setChatBindingsMap(map);
  return { ok: true, urlKey, slot };
}

async function clearChatBindingByUrl(urlRaw) {
  const urlKey = normalizeChatUrlKey(urlRaw);
  if (!urlKey) return { ok: true, urlKey: "", slot: 0 };
  const map = await getChatBindingsMap();
  if (Object.prototype.hasOwnProperty.call(map, urlKey)) {
    delete map[urlKey];
    await setChatBindingsMap(map);
  }
  return { ok: true, urlKey, slot: 0 };
}

async function getGlobalDefaultSet() {
  const key = globalDefaultSetStorageKey();
  const res = await storageGet([key]);
  return normalizeSetSlot(res && res[key]);
}

async function setGlobalDefaultSet(slotRaw) {
  const slot = normalizeSetSlot(slotRaw);
  if (!slot) throw new Error("missing slot");
  await storageSet({ [globalDefaultSetStorageKey()]: slot });
  return { ok: true, slot };
}

async function clearGlobalDefaultSet() {
  await storageRemove([globalDefaultSetStorageKey()]);
  return { ok: true, slot: 0 };
}

async function getPreviewSetOnce(tabIdRaw) {
  const key = previewSetOnceKey(tabIdRaw);
  if (!key) return 0;
  const res = await storageSessionGet([key]);
  return normalizeSetSlot(res && res[key]);
}

async function armPreviewSetOnce(tabIdRaw, slotRaw) {
  const tabId = normalizeTabId(tabIdRaw);
  const slot = normalizeSetSlot(slotRaw);
  if (!tabId) throw new Error("missing tabId");
  if (!slot) throw new Error("missing slot");
  await storageSessionSet({ [previewSetOnceKey(tabId)]: slot });
  return { ok: true, tabId, slot };
}

async function clearPreviewSetOnce(tabIdRaw) {
  const key = previewSetOnceKey(tabIdRaw);
  if (!key) return false;
  await storageSessionRemove([key]);
  return true;
}

async function consumePreviewSetOnce(tabIdRaw) {
  const key = previewSetOnceKey(tabIdRaw);
  if (!key) return 0;
  const res = await storageSessionGet([key]);
  const slot = normalizeSetSlot(res && res[key]);
  if (slot) await storageSessionRemove([key]);
  return slot;
}

async function clearSlotReferences(slotRaw, opts = null) {
  const slot = normalizeSetSlot(slotRaw);
  const tabId = normalizeTabId(opts && opts.tabId);
  let removedChatBindings = 0;
  let clearedGlobalDefault = false;
  let clearedPreviewOnce = false;
  if (!slot) {
    return { ok: true, slot: 0, removedChatBindings, clearedGlobalDefault, clearedPreviewOnce };
  }

  const bindings = await getChatBindingsMap();
  let bindingsChanged = false;
  for (const [urlKey, boundSlot] of Object.entries(bindings)) {
    if (normalizeSetSlot(boundSlot) !== slot) continue;
    delete bindings[urlKey];
    removedChatBindings += 1;
    bindingsChanged = true;
  }
  if (bindingsChanged) await setChatBindingsMap(bindings);

  if (normalizeSetSlot(await getGlobalDefaultSet()) === slot) {
    await clearGlobalDefaultSet();
    clearedGlobalDefault = true;
  }

  if (tabId && normalizeSetSlot(await getPreviewSetOnce(tabId)) === slot) {
    await clearPreviewSetOnce(tabId);
    clearedPreviewOnce = true;
  }

  return { ok: true, slot, removedChatBindings, clearedGlobalDefault, clearedPreviewOnce };
}

async function resolveSetState({ tabId: tabIdRaw, url: urlRaw, consumePreview = false } = {}) {
  const tabId = normalizeTabId(tabIdRaw);
  const url = String(urlRaw || "").trim();
  const urlKey = normalizeChatUrlKey(url);
  let previewPendingSlot = tabId
    ? (consumePreview ? await consumePreviewSetOnce(tabId) : await getPreviewSetOnce(tabId))
    : 0;
  if (previewPendingSlot && !(await hasSavedSetSlot(previewPendingSlot))) {
    if (tabId) await clearPreviewSetOnce(tabId);
    previewPendingSlot = 0;
  }

  let chatBindingSlot = urlKey ? await getChatBindingByUrl(urlKey) : 0;
  if (chatBindingSlot && !(await hasSavedSetSlot(chatBindingSlot))) {
    if (urlKey) await clearChatBindingByUrl(urlKey);
    chatBindingSlot = 0;
  }

  const chatBypassEnabled = urlKey ? await getChatBypassByUrl(urlKey) : false;

  let globalDefaultSlot = await getGlobalDefaultSet();
  if (globalDefaultSlot && !(await hasSavedSetSlot(globalDefaultSlot))) {
    await clearGlobalDefaultSet();
    globalDefaultSlot = 0;
  }

  let slot = 0;
  let source = "global-toggles";
  if (previewPendingSlot) {
    slot = previewPendingSlot;
    source = "preview";
  } else if (chatBypassEnabled) {
    slot = 0;
    source = "all-off";
  } else if (chatBindingSlot) {
    slot = chatBindingSlot;
    source = "chat";
  } else if (globalDefaultSlot) {
    slot = globalDefaultSlot;
    source = "global-set";
  }

  return {
    ok: true,
    tabId,
    url,
    urlKey,
    slot,
    source,
    resolvedSetSlot: slot,
    resolvedSource: source,
    chatBindingSlot,
    chatBypassEnabled,
    globalDefaultSlot,
    previewPendingSlot,
  };
}

async function armPageDisableOnce(tabIdRaw) {
  const tabId = normalizeTabId(tabIdRaw);
  if (!tabId) throw new Error("missing tabId");
  const key = pageDisableOnceKey(tabId);
  await storageSessionSet({
    [key]: {
      armedAt: Date.now(),
    },
  });
  return { ok: true, tabId };
}

async function clearPageDisableOnce(tabIdRaw) {
  const key = pageDisableOnceKey(tabIdRaw);
  if (!key) return false;
  await storageSessionRemove([key]);
  return true;
}

async function consumePageDisableOnce(tabIdRaw) {
  const key = pageDisableOnceKey(tabIdRaw);
  if (!key) return false;
  const res = await storageSessionGet([key]);
  if (!Object.prototype.hasOwnProperty.call(res || {}, key)) return false;
  const rec = normalizePageDisableOnceRecord(res[key]);
  await storageSessionRemove([key]);
  const age = rec.armedAt > 0 ? Math.max(0, Date.now() - rec.armedAt) : 0;
  return !(rec.armedAt > 0 && age > PAGE_DISABLE_ONCE_MAX_AGE_MS);
}

async function getPageSetLink(tabIdRaw, urlRaw = "") {
  const resolved = await resolveSetState({ tabId: tabIdRaw, url: urlRaw, consumePreview: false });
  return normalizeSetSlot(resolved && resolved.slot);
}

async function setPageSetLink(tabIdRaw, slotRaw, urlRaw = "") {
  const tabId = normalizeTabId(tabIdRaw);
  const slot = normalizeSetSlot(slotRaw);
  if (!tabId) throw new Error("missing tabId");
  if (!slot) throw new Error("missing slot");
  const result = await setChatBindingByUrl(urlRaw, slot);
  return { ok: true, tabId, slot, urlKey: result.urlKey };
}

async function clearPageSetLink(tabIdRaw, urlRaw = "") {
  const tabId = normalizeTabId(tabIdRaw);
  const key = pageSetLinkKey(tabId);
  if (key) {
    try { await storageSessionRemove([key]); } catch {}
  }
  const result = await clearChatBindingByUrl(urlRaw);
  return { ok: true, tabId, slot: 0, urlKey: result.urlKey };
}

async function migrateStorageKey(newKey, legacyKey, normalizeFn = null) {
  const keys = [newKey, legacyKey];
  const res = await storageGet(keys);
  if (Object.prototype.hasOwnProperty.call(res || {}, newKey) && res[newKey] != null) {
    return res[newKey];
  }
  if (!Object.prototype.hasOwnProperty.call(res || {}, legacyKey)) return undefined;
  if (res[legacyKey] == null) return undefined;
  const migrated = (typeof normalizeFn === "function") ? normalizeFn(res[legacyKey]) : res[legacyKey];
  await storageSet({ [newKey]: migrated });
  try { await storageRemove([legacyKey]); } catch {}
  return migrated;
}

async function getBootMode(chatId, nsDisk = DEFAULT_NS_DISK) {
  const id = normalizeChatId(chatId);
  if (!id) return MODE_LIVE_FIRST;
  const k = modeKey(nsDisk, id);
  const legacy = legacyModeKey(id);
  const migrated = await migrateStorageKey(k, legacy, normalizeMode);
  if (migrated != null) return normalizeMode(migrated);
  const res = await storageGet([k]);
  return normalizeMode(res[k]);
}

async function setBootMode(chatId, mode, nsDisk = DEFAULT_NS_DISK) {
  const id = normalizeChatId(chatId);
  if (!id) throw new Error("missing chatId");
  const m = normalizeMode(mode);
  await storageSet({ [modeKey(nsDisk, id)]: m });
  try { await storageRemove([legacyModeKey(id)]); } catch {}
  return m;
}

async function getMigratedFlag(chatId, nsDisk = DEFAULT_NS_DISK) {
  const id = normalizeChatId(chatId);
  if (!id) return false;
  const k = migratedKey(nsDisk, id);
  const legacy = legacyMigratedKey(id);
  const migrated = await migrateStorageKey(k, legacy, (v) => !!v);
  if (migrated != null) return !!migrated;
  const res = await storageGet([k]);
  return !!res[k];
}

async function setMigratedFlag(chatId, migrated = true, nsDisk = DEFAULT_NS_DISK) {
  const id = normalizeChatId(chatId);
  if (!id) throw new Error("missing chatId");
  const k = migratedKey(nsDisk, id);
  await storageSet({ [k]: !!migrated });
  try { await storageRemove([legacyMigratedKey(id)]); } catch {}
  return !!migrated;
}

async function getChatIndex(chatId, nsDisk = DEFAULT_NS_DISK) {
  const id = normalizeChatId(chatId);
  if (!id) return makeDefaultChatIndex();
  const k = indexKey(nsDisk, id);
  const legacy = legacyIndexKey(id);
  const migrated = await migrateStorageKey(k, legacy, normalizeChatIndex);
  if (migrated != null) return normalizeChatIndex(migrated);
  const res = await storageGet([k]);
  return normalizeChatIndex(res[k]);
}

async function setChatIndex(chatId, nextIndex, nsDisk = DEFAULT_NS_DISK) {
  const id = normalizeChatId(chatId);
  if (!id) throw new Error("missing chatId");
  const k = indexKey(nsDisk, id);
  const norm = normalizeChatIndex(nextIndex);
  await storageSet({ [k]: norm });
  try { await storageRemove([legacyIndexKey(id)]); } catch {}
  return norm;
}

function normalizeMessageRole(raw) {
  const v = String(raw || "").trim().toLowerCase();
  if (v === "user") return "user";
  if (v === "assistant") return "assistant";
  return "assistant";
}

function normalizeAttachmentRecord(raw, idx = 0, roleRaw = "user") {
  const src = raw && typeof raw === "object" ? raw : {};
  const kind = String(src.kind || src.type || "").trim().toLowerCase() || "image";
  if (kind !== "image") return null;
  const thumbnailSrc = String(src.thumbnailSrc || src.thumbnail || src.src || "").trim();
  const originalSrc = String(src.originalSrc || src.original || src.url || src.href || thumbnailSrc || "").trim();
  const captureStatus = String(src.captureStatus || src.status || (thumbnailSrc ? "linked" : "failed")).trim() || "failed";
  if (!thumbnailSrc && !originalSrc && captureStatus !== "failed") return null;
  return {
    kind: "image",
    role: normalizeMessageRole(src.role || roleRaw || "user"),
    thumbnailSrc,
    originalSrc,
    alt: String(src.alt || "").trim(),
    width: Math.max(0, Math.round(Number(src.width || 0) || 0)),
    height: Math.max(0, Math.round(Number(src.height || 0) || 0)),
    naturalWidth: Math.max(0, Math.round(Number(src.naturalWidth || 0) || 0)),
    naturalHeight: Math.max(0, Math.round(Number(src.naturalHeight || 0) || 0)),
    captureStatus,
    source: String(src.source || "dom").trim() || "dom",
    order: Math.max(0, Math.floor(Number(src.order ?? idx) || idx)),
  };
}

function normalizeAttachments(raw, roleRaw = "user") {
  const src = Array.isArray(raw) ? raw : [];
  const out = [];
  for (let i = 0; i < src.length; i += 1) {
    const item = normalizeAttachmentRecord(src[i], i, roleRaw);
    if (item) out.push(item);
  }
  out.sort((a, b) => Number(a.order) - Number(b.order));
  return out;
}

function normalizeMessages(messages) {
  const src = Array.isArray(messages) ? messages : [];
  const out = [];
  for (let i = 0; i < src.length; i += 1) {
    const m = src[i] && typeof src[i] === "object" ? src[i] : {};
    const role = normalizeMessageRole(m.role);
    const attachments = normalizeAttachments(m.attachments, role);
    const orderRaw = Number(m.order);
    const createdAtRaw = Number(m.createdAt);
    const row = {
      role,
      text: String(m.text || ""),
      order: Number.isFinite(orderRaw) ? Math.floor(orderRaw) : i,
      createdAt: Number.isFinite(createdAtRaw) ? createdAtRaw : null,
    };
    if (attachments.length) row.attachments = attachments;
    if (typeof m.editedAt === "string" && m.editedAt) row.editedAt = m.editedAt;
    if (typeof m.originalText === "string") row.originalText = m.originalText;
    out.push(row);
  }
  out.sort((a, b) => a.order - b.order);
  for (let i = 0; i < out.length; i += 1) {
    out[i].order = i;
  }
  return out;
}

function canonicalMessagesJson(messages) {
  const norm = normalizeMessages(messages);
  const rows = norm.map((m) => ({
    role: m.role,
    text: m.text,
    order: m.order,
    createdAt: m.createdAt == null ? null : m.createdAt,
    ...(Array.isArray(m.attachments) && m.attachments.length ? { attachments: m.attachments } : {}),
  }));
  return JSON.stringify(rows);
}

async function sha256Hex(text) {
  const raw = String(text || "");
  try {
    const enc = new TextEncoder();
    const buf = enc.encode(raw);
    const dig = await crypto.subtle.digest("SHA-256", buf);
    return Array.from(new Uint8Array(dig)).map((b) => b.toString(16).padStart(2, "0")).join("");
  } catch {
    let h = 0;
    for (let i = 0; i < raw.length; i += 1) h = ((h << 5) - h) + raw.charCodeAt(i), h |= 0;
    return "weak:" + String(Math.abs(h));
  }
}

function makeSnapshotId() {
  return "snap_" + String(Date.now()) + "_" + Math.random().toString(36).slice(2, 10);
}

function makeChunkId(snapshotId, idx) {
  return String(snapshotId || "") + ":chunk:" + String(idx);
}

let dbPromise = null;

function openArchiveDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      let snapshots = null;
      if (!db.objectStoreNames.contains(STORE_SNAPSHOTS)) {
        snapshots = db.createObjectStore(STORE_SNAPSHOTS, { keyPath: "snapshotId" });
      } else {
        snapshots = req.transaction.objectStore(STORE_SNAPSHOTS);
      }
      if (snapshots && !snapshots.indexNames.contains("chatId")) snapshots.createIndex("chatId", "chatId", { unique: false });
      if (snapshots && !snapshots.indexNames.contains("createdAt")) snapshots.createIndex("createdAt", "createdAt", { unique: false });
      if (snapshots && !snapshots.indexNames.contains("chatId_createdAt")) snapshots.createIndex("chatId_createdAt", ["chatId", "createdAt"], { unique: false });

      let chunks = null;
      if (!db.objectStoreNames.contains(STORE_CHUNKS)) {
        chunks = db.createObjectStore(STORE_CHUNKS, { keyPath: "chunkId" });
      } else {
        chunks = req.transaction.objectStore(STORE_CHUNKS);
      }
      if (chunks && !chunks.indexNames.contains("snapshotId")) chunks.createIndex("snapshotId", "snapshotId", { unique: false });
      if (chunks && !chunks.indexNames.contains("snapshotId_idx")) chunks.createIndex("snapshotId_idx", ["snapshotId", "idx"], { unique: true });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error("IndexedDB open failed"));
  });
  return dbPromise;
}

function reqAsPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error("IndexedDB request failed"));
  });
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error || new Error("IndexedDB transaction failed"));
    tx.onabort = () => reject(tx.error || new Error("IndexedDB transaction aborted"));
  });
}

async function listSnapshotHeadersByChat(chatId) {
  const id = normalizeChatId(chatId);
  if (!id) return [];
  const db = await openArchiveDb();
  const tx = db.transaction([STORE_SNAPSHOTS], "readonly");
  const store = tx.objectStore(STORE_SNAPSHOTS);
  const idx = store.index("chatId");
  const rows = await reqAsPromise(idx.getAll(id));
  await txDone(tx);
  const list = Array.isArray(rows) ? rows.slice() : [];
  list.sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
  return list;
}

async function listAllSnapshotHeaders() {
  const db = await openArchiveDb();
  const tx = db.transaction([STORE_SNAPSHOTS], "readonly");
  const rows = await reqAsPromise(tx.objectStore(STORE_SNAPSHOTS).getAll());
  await txDone(tx);
  return Array.isArray(rows) ? rows : [];
}

async function loadSnapshotById(snapshotId) {
  const sid = String(snapshotId || "").trim();
  if (!sid) return null;
  const db = await openArchiveDb();
  const tx = db.transaction([STORE_SNAPSHOTS, STORE_CHUNKS], "readonly");
  const snapStore = tx.objectStore(STORE_SNAPSHOTS);
  const chunkStore = tx.objectStore(STORE_CHUNKS);
  const header = await reqAsPromise(snapStore.get(sid));
  if (!header) {
    await txDone(tx);
    return null;
  }
  const chunks = await reqAsPromise(chunkStore.index("snapshotId").getAll(sid));
  await txDone(tx);
  const ordered = (Array.isArray(chunks) ? chunks : []).slice().sort((a, b) => Number(a.idx || 0) - Number(b.idx || 0));
  const messages = [];
  for (const chunk of ordered) {
    const rows = Array.isArray(chunk.messages) ? chunk.messages : [];
    for (const row of rows) messages.push(row);
  }
  return { header, messages };
}

async function removeSnapshotAndChunks(snapshotId) {
  const sid = String(snapshotId || "").trim();
  if (!sid) return false;
  const db = await openArchiveDb();
  const tx = db.transaction([STORE_SNAPSHOTS, STORE_CHUNKS], "readwrite");
  const snapStore = tx.objectStore(STORE_SNAPSHOTS);
  const chunkStore = tx.objectStore(STORE_CHUNKS);
  const idx = chunkStore.index("snapshotId");
  await new Promise((resolve, reject) => {
    const cursorReq = idx.openCursor(IDBKeyRange.only(sid));
    cursorReq.onsuccess = () => {
      const c = cursorReq.result;
      if (!c) return resolve(true);
      c.delete();
      c.continue();
    };
    cursorReq.onerror = () => reject(cursorReq.error || new Error("chunk cursor failed"));
  });
  snapStore.delete(sid);
  await txDone(tx);
  return true;
}

async function pruneOrphanChunks() {
  const db = await openArchiveDb();
  const tx = db.transaction([STORE_SNAPSHOTS, STORE_CHUNKS], "readwrite");
  const snapStore = tx.objectStore(STORE_SNAPSHOTS);
  const chunkStore = tx.objectStore(STORE_CHUNKS);
  const validSnapshotIds = new Set();

  await new Promise((resolve, reject) => {
    const req = snapStore.openCursor();
    req.onsuccess = () => {
      const c = req.result;
      if (!c) return resolve(true);
      validSnapshotIds.add(String(c.value && c.value.snapshotId || ""));
      c.continue();
    };
    req.onerror = () => reject(req.error || new Error("snapshot cursor failed"));
  });

  await new Promise((resolve, reject) => {
    const req = chunkStore.openCursor();
    req.onsuccess = () => {
      const c = req.result;
      if (!c) return resolve(true);
      const sid = String(c.value && c.value.snapshotId || "");
      if (!validSnapshotIds.has(sid)) c.delete();
      c.continue();
    };
    req.onerror = () => reject(req.error || new Error("chunk cursor failed"));
  });
  await txDone(tx);
  return true;
}

function chunkMessages(messages) {
  const out = [];
  const rows = Array.isArray(messages) ? messages : [];
  for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
    out.push(rows.slice(i, i + CHUNK_SIZE));
  }
  return out;
}

const chatQueue = new Map();

function withChatLock(chatId, fn) {
  const id = normalizeChatId(chatId) || "__global__";
  const prev = chatQueue.get(id) || Promise.resolve();
  const next = prev.then(() => fn());
  const safe = next.catch(() => {});
  chatQueue.set(id, safe);
  return next.finally(() => {
    if (chatQueue.get(id) === safe) chatQueue.delete(id);
  });
}

async function captureSnapshotInternalUnlocked(id, messages, meta = {}, opts = {}, ns = DEFAULT_NS_DISK) {
  const norm = normalizeMessages(messages);
  const canonical = canonicalMessagesJson(norm);
  const digest = await sha256Hex(canonical);
  const index = await getChatIndex(id, ns);
  const forceNew = !!opts.forceNew;
  if (!forceNew && digest && digest === index.lastDigest) {
    return {
      ok: true,
      deduped: true,
      snapshotId: String(index.lastSnapshotId || ""),
      messageCount: norm.length,
      digest,
    };
  }

  const snapshotId = String(opts.snapshotId || makeSnapshotId());
  const createdAt = String(opts.createdAt || nowIso());
  const categoryCatalog = Array.isArray(opts.categoryCatalog) ? opts.categoryCatalog : await readCategoryCatalog(ns);
  const groups = chunkMessages(norm);
  const chunkIds = [];

  const db = await openArchiveDb();
  const tx = db.transaction([STORE_CHUNKS, STORE_SNAPSHOTS], "readwrite");
  const chunkStore = tx.objectStore(STORE_CHUNKS);
  const snapStore = tx.objectStore(STORE_SNAPSHOTS);

  for (let i = 0; i < groups.length; i += 1) {
    const chunkId = makeChunkId(snapshotId, i);
    chunkIds.push(chunkId);
    chunkStore.put({
      chunkId,
      snapshotId,
      idx: i,
      messages: groups[i],
    });
  }

  snapStore.put({
    snapshotId,
    chatId: id,
    createdAt,
    schemaVersion: 1,
    messageCount: norm.length,
    digest,
    chunkIds,
    meta: normalizeSnapshotMeta(meta, categoryCatalog, {
      messages: norm,
      classifiedAt: createdAt,
    }),
  });
  await txDone(tx);

  const nextIndex = normalizeChatIndex({
    ...index,
    lastSnapshotId: snapshotId,
    lastCapturedAt: createdAt,
    lastDigest: digest,
  });
  await setChatIndex(id, nextIndex, ns);
  await applyRetentionUnlocked(id, ns);

  return {
    ok: true,
    deduped: false,
    snapshotId,
    messageCount: norm.length,
    digest,
    createdAt,
  };
}

async function captureSnapshotInternal(chatId, messages, meta = {}, opts = {}, nsDisk = DEFAULT_NS_DISK) {
  const id = normalizeChatId(chatId);
  if (!id) throw new Error("missing chatId");
  const ns = normalizeNsDisk(nsDisk);
  return withChatLock(id, () => captureSnapshotInternalUnlocked(id, messages, meta, opts, ns));
}

async function clearChatSnapshotsUnlocked(id, ns = DEFAULT_NS_DISK) {
  const headers = await listSnapshotHeadersByChat(id);
  for (const h of headers) {
    await removeSnapshotAndChunks(h.snapshotId);
  }
  await setChatIndex(id, makeDefaultChatIndex(), ns);
  return headers.length;
}

async function clearChatSnapshots(chatId, nsDisk = DEFAULT_NS_DISK) {
  const id = normalizeChatId(chatId);
  if (!id) return 0;
  const ns = normalizeNsDisk(nsDisk);
  return withChatLock(id, () => clearChatSnapshotsUnlocked(id, ns));
}

async function applyRetentionUnlocked(id, ns = DEFAULT_NS_DISK) {
  const index = await getChatIndex(id, ns);
  const keepLatest = Number(index.retentionPolicy && index.retentionPolicy.keepLatest || RETENTION_KEEP_LATEST);
  const pinned = new Set(uniqStringList(index.pinnedSnapshotIds));
  const headers = await listSnapshotHeadersByChat(id);

  const keepSet = new Set();
  let nonPinnedCount = 0;
  for (const h of headers) {
    const sid = String(h.snapshotId || "");
    if (!sid) continue;
    if (pinned.has(sid)) {
      keepSet.add(sid);
      continue;
    }
    if (nonPinnedCount < keepLatest) {
      keepSet.add(sid);
      nonPinnedCount += 1;
    }
  }

  let deleted = 0;
  for (const h of headers) {
    const sid = String(h.snapshotId || "");
    if (!sid || keepSet.has(sid)) continue;
    await removeSnapshotAndChunks(sid);
    deleted += 1;
  }

  if (deleted > 0) await pruneOrphanChunks();

  const after = await listSnapshotHeadersByChat(id);
  const validPinned = uniqStringList(index.pinnedSnapshotIds).filter((sid) => after.some((h) => String(h.snapshotId || "") === sid));
  const first = after[0] || null;
  const next = normalizeChatIndex({
    ...index,
    pinnedSnapshotIds: validPinned,
    lastSnapshotId: first ? String(first.snapshotId || "") : "",
    lastCapturedAt: first ? String(first.createdAt || "") : "",
    lastDigest: first ? String(first.digest || "") : "",
  });
  await setChatIndex(id, next, ns);
  return { ok: true, deleted, kept: after.length };
}

async function applyRetention(chatId, nsDisk = DEFAULT_NS_DISK) {
  const id = normalizeChatId(chatId);
  if (!id) throw new Error("missing chatId");
  const ns = normalizeNsDisk(nsDisk);
  return withChatLock(id, () => applyRetentionUnlocked(id, ns));
}

async function listSnapshots(chatId, nsDisk = DEFAULT_NS_DISK) {
  const id = normalizeChatId(chatId);
  if (!id) throw new Error("missing chatId");
  const ns = normalizeNsDisk(nsDisk);
  const [headers, index] = await Promise.all([
    listSnapshotHeadersByChat(id),
    getChatIndex(id, ns),
  ]);
  const pinned = new Set(uniqStringList(index.pinnedSnapshotIds));
  return headers.map((h) => ({
    snapshotId: String(h.snapshotId || ""),
    chatId: String(h.chatId || ""),
    createdAt: String(h.createdAt || ""),
    schemaVersion: Number(h.schemaVersion || 1),
    messageCount: Number(h.messageCount || 0),
    digest: String(h.digest || ""),
    chunkIds: Array.isArray(h.chunkIds) ? h.chunkIds.slice() : [],
    pinned: pinned.has(String(h.snapshotId || "")),
  }));
}

function buildLoadedSnapshotResponse(loaded, categoryCatalog = DEFAULT_CATEGORY_CATALOG) {
  if (!loaded || !loaded.header) return null;
  const messages = Array.isArray(loaded.messages) ? loaded.messages : [];
  return {
    snapshotId: loaded.header.snapshotId,
    chatId: loaded.header.chatId,
    createdAt: loaded.header.createdAt,
    schemaVersion: loaded.header.schemaVersion || 1,
    messageCount: loaded.header.messageCount || messages.length,
    digest: loaded.header.digest || "",
    messages,
    meta: normalizeSnapshotMeta(loaded.header.meta, categoryCatalog, {
      messages,
      classifiedAt: String(loaded.header.createdAt || nowIso()),
    }),
  };
}

async function loadLatestSnapshot(chatId, nsDisk = DEFAULT_NS_DISK) {
  const id = normalizeChatId(chatId);
  if (!id) throw new Error("missing chatId");
  const ns = normalizeNsDisk(nsDisk);
  const list = await listSnapshotHeadersByChat(id);
  if (!list.length) return null;
  const loaded = await loadSnapshotById(list[0].snapshotId);
  if (!loaded) return null;
  return buildLoadedSnapshotResponse(loaded, await readCategoryCatalog(ns));
}

async function upsertLatestSnapshotMeta(chatId, patchRaw = {}, opts = {}, nsDisk = DEFAULT_NS_DISK) {
  const id = normalizeChatId(chatId);
  if (!id) throw new Error("missing chatId");
  const patch = normalizeSnapshotMetaPatch(patchRaw);
  if (!Object.keys(patch).length) {
    return { ok: false, status: "empty-patch", chatId: id, patch: {} };
  }
  const ns = normalizeNsDisk(nsDisk);
  return withChatLock(id, async () => {
    const headers = await listSnapshotHeadersByChat(id);
    const latestHeader = headers[0] || null;
    if (!latestHeader) return { ok: false, status: "snapshot-not-found", chatId: id, patch };
    const loaded = await loadSnapshotById(latestHeader.snapshotId);
    if (!loaded || !loaded.header) return { ok: false, status: "snapshot-not-found", chatId: id, patch };
    const categoryCatalog = await readCategoryCatalog(ns);
    const nextHeader = {
      ...loaded.header,
      meta: mergeSnapshotMetaPatch(loaded.header.meta, patch, opts, categoryCatalog),
    };
    const db = await openArchiveDb();
    const tx = db.transaction([STORE_SNAPSHOTS], "readwrite");
    tx.objectStore(STORE_SNAPSHOTS).put(nextHeader);
    await txDone(tx);
    return {
      ok: true,
      status: "ok",
      chatId: id,
      patch,
      snapshotId: String(nextHeader.snapshotId || ""),
    };
  });
}

async function replaceSnapshotCategory(snapshotId, categoryRecord, nsDisk = DEFAULT_NS_DISK) {
  const sid = String(snapshotId || "").trim();
  if (!sid) throw new Error("missing snapshotId");
  const ns = normalizeNsDisk(nsDisk);
  const categoryCatalog = await readCategoryCatalog(ns);
  const loaded = await loadSnapshotById(sid);
  if (!loaded || !loaded.header) throw new Error("snapshot not found");
  const chatId = normalizeChatId(loaded.header.chatId);
  if (!chatId) throw new Error("missing chatId");
  const messages = Array.isArray(loaded.messages) ? loaded.messages : [];
  const meta = loaded.header.meta && typeof loaded.header.meta === "object" ? { ...loaded.header.meta } : {};
  const normalizedCategory = normalizeCategoryRecord(categoryRecord, categoryCatalog);
  if (!normalizedCategory) throw new Error("invalid category");
  meta.category = normalizedCategory;
  meta.updatedAt = nowIso();
  await captureSnapshotInternal(
    chatId,
    messages,
    meta,
    {
      forceNew: true,
      snapshotId: sid,
      createdAt: String(loaded.header.createdAt || nowIso()),
      categoryCatalog,
    },
    ns,
  );
  return buildLoadedSnapshotResponse(await loadSnapshotById(sid), categoryCatalog);
}

async function setSnapshotCategory(snapshotId, primaryCategoryId, nsDisk = DEFAULT_NS_DISK) {
  const ns = normalizeNsDisk(nsDisk);
  const categoryCatalog = await readCategoryCatalog(ns);
  const primary = resolveActiveCategoryId(primaryCategoryId, categoryCatalogIndex(categoryCatalog));
  if (!primary) throw new Error("invalid category");
  const loaded = await loadSnapshotById(snapshotId);
  const currentCategory = normalizeCategoryRecord(loaded && loaded.header && loaded.header.meta && loaded.header.meta.category, categoryCatalog);
  if (loaded && currentCategory && currentCategory.primaryCategoryId === primary) {
    return buildLoadedSnapshotResponse(loaded, categoryCatalog);
  }
  const at = nowIso();
  return replaceSnapshotCategory(snapshotId, {
    primaryCategoryId: primary,
    secondaryCategoryId: null,
    source: "user",
    algorithmVersion: null,
    classifiedAt: null,
    overriddenAt: at,
    confidence: null,
  }, ns);
}

async function reclassifySnapshotCategory(snapshotId, nsDisk = DEFAULT_NS_DISK) {
  const sid = String(snapshotId || "").trim();
  if (!sid) throw new Error("missing snapshotId");
  const ns = normalizeNsDisk(nsDisk);
  const loaded = await loadSnapshotById(sid);
  if (!loaded || !loaded.header) throw new Error("snapshot not found");
  const messages = Array.isArray(loaded.messages) ? loaded.messages : [];
  const meta = loaded.header.meta && typeof loaded.header.meta === "object" ? { ...loaded.header.meta } : {};
  delete meta.category;
  const category = classifySnapshotCategory({ meta, messages }, { classifiedAt: nowIso() });
  return replaceSnapshotCategory(sid, category, ns);
}

async function pinSnapshot(chatId, snapshotId, pinned = true, nsDisk = DEFAULT_NS_DISK) {
  const id = normalizeChatId(chatId);
  const sid = String(snapshotId || "").trim();
  if (!id || !sid) throw new Error("missing chatId/snapshotId");
  const ns = normalizeNsDisk(nsDisk);
  return withChatLock(id, async () => {
    const idx = await getChatIndex(id, ns);
    const set = new Set(uniqStringList(idx.pinnedSnapshotIds));
    if (pinned) set.add(sid);
    else set.delete(sid);
    idx.pinnedSnapshotIds = Array.from(set);
    const next = await setChatIndex(id, idx, ns);
    return { ok: true, pinned: next.pinnedSnapshotIds.slice() };
  });
}

async function deleteSnapshot(chatId, snapshotId, nsDisk = DEFAULT_NS_DISK) {
  const id = normalizeChatId(chatId);
  const sid = String(snapshotId || "").trim();
  if (!id || !sid) throw new Error("missing chatId/snapshotId");
  const ns = normalizeNsDisk(nsDisk);
  return withChatLock(id, async () => {
    await removeSnapshotAndChunks(sid);
    const idx = await getChatIndex(id, ns);
    idx.pinnedSnapshotIds = uniqStringList(idx.pinnedSnapshotIds).filter((v) => v !== sid);
    const headers = await listSnapshotHeadersByChat(id);
    const first = headers[0] || null;
    idx.lastSnapshotId = first ? String(first.snapshotId || "") : "";
    idx.lastCapturedAt = first ? String(first.createdAt || "") : "";
    idx.lastDigest = first ? String(first.digest || "") : "";
    await setChatIndex(id, idx, ns);
    await pruneOrphanChunks();
    return { ok: true, remaining: headers.length };
  });
}

async function listAllChatIds(nsDisk = DEFAULT_NS_DISK) {
  const headers = await listAllSnapshotHeaders();
  const ids = new Set();
  for (const h of headers) {
    const id = normalizeChatId(h && h.chatId);
    if (id) ids.add(id);
  }
  const allLocal = await storageGet(null);
  const nsPrefix = normalizeNsDisk(nsDisk) + ":";
  for (const k of Object.keys(allLocal || {})) {
    if (k.startsWith(nsPrefix + "chatIndex:")) ids.add(normalizeChatId(k.slice((nsPrefix + "chatIndex:").length)));
    if (k.startsWith(nsPrefix + "chatBootMode:")) ids.add(normalizeChatId(k.slice((nsPrefix + "chatBootMode:").length)));
    if (k.startsWith("h2o:chatIndex:")) ids.add(normalizeChatId(k.slice("h2o:chatIndex:".length)));
    if (k.startsWith("h2o:chatBootMode:")) ids.add(normalizeChatId(k.slice("h2o:chatBootMode:".length)));
  }
  return Array.from(ids).filter(Boolean).sort();
}

function workbenchHeaderSortKey(header) {
  const meta = header && header.meta && typeof header.meta === "object" ? header.meta : {};
  return String(meta.updatedAt || header && header.createdAt || "");
}

function buildWorkbenchRowFromHeader(header, chatIndex = null, categoryCatalog = DEFAULT_CATEGORY_CATALOG) {
  const row = header && typeof header === "object" ? header : null;
  if (!row) return null;

  const snapshotId = String(row.snapshotId || "").trim();
  const chatId = normalizeChatId(row.chatId);
  if (!snapshotId || !chatId) return null;

  const meta = normalizeSnapshotMeta(row.meta, categoryCatalog);
  const pinnedSet = new Set(uniqStringList(chatIndex && chatIndex.pinnedSnapshotIds));
  const messageCountRaw = Number(meta.messageCount);
  const headerCountRaw = Number(row.messageCount);
  const answerCountRaw = Number(meta.answerCount);

  return {
    snapshotId,
    chatId,
    createdAt: String(row.createdAt || ""),
    updatedAt: String(meta.updatedAt || row.createdAt || ""),
    title: String(meta.title || chatId),
    excerpt: String(meta.excerpt || ""),
    messageCount: Number.isFinite(messageCountRaw) ? Math.max(0, Math.floor(messageCountRaw)) : (Number.isFinite(headerCountRaw) ? Math.max(0, Math.floor(headerCountRaw)) : 0),
    answerCount: Number.isFinite(answerCountRaw) ? Math.max(0, Math.floor(answerCountRaw)) : 0,
    pinned: pinnedSet.has(snapshotId),
    archived: meta.archived === true || String(meta.state || "").trim().toLowerCase() === "archived",
    folderId: String(meta.folderId || ""),
    folderName: String(meta.folderName || ""),
    tags: normalizeTags(meta.tags),
    originSource: normalizeOriginSource(meta.originSource),
    originProjectRef: normalizeProjectRef(meta.originProjectRef),
    category: normalizeCategoryRecord(meta.category, categoryCatalog),
    labels: normalizeLabelAssignments(meta.labels),
    keywords: normalizeKeywords(meta.keywords),
  };
}

async function listWorkbenchRows(nsDisk = DEFAULT_NS_DISK) {
  const ns = normalizeNsDisk(nsDisk);
  const headers = await listAllSnapshotHeaders();
  const latestByChat = new Map();

  for (const header of headers) {
    const chatId = normalizeChatId(header && header.chatId);
    if (!chatId) continue;
    const prev = latestByChat.get(chatId);
    if (!prev || workbenchHeaderSortKey(header).localeCompare(workbenchHeaderSortKey(prev)) > 0) {
      latestByChat.set(chatId, header);
    }
  }

  const chatIds = Array.from(latestByChat.keys());
  const categoryCatalog = await readCategoryCatalog(ns);
  const indexes = await Promise.all(chatIds.map((chatId) => getChatIndex(chatId, ns)));
  const rows = [];

  for (let i = 0; i < chatIds.length; i += 1) {
    const row = buildWorkbenchRowFromHeader(latestByChat.get(chatIds[i]), indexes[i], categoryCatalog);
    if (row) rows.push(row);
  }

  rows.sort((a, b) => {
    if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
    return String(b.updatedAt || b.createdAt || "").localeCompare(String(a.updatedAt || a.createdAt || ""));
  });
  return rows;
}

function normalizeFolderEntry(raw) {
  const id = String(raw && (raw.id || raw.folderId) || "").trim();
  if (!id) return null;
  const kindRaw = String(raw && raw.kind || "").trim().toLowerCase();
  const meta = raw && raw.meta && typeof raw.meta === "object" && !Array.isArray(raw.meta) ? raw.meta : {};
  const out = {
    id,
    name: String(raw && (raw.name || raw.title || id) || id).trim() || id,
    kind: kindRaw === "project_backed" ? "project_backed" : "local",
    projectRef: normalizeProjectRef(raw && raw.projectRef),
    parentId: String(raw && (raw.parentId || raw.parent_id) || "").trim(),
    source: String(raw && raw.source || "").trim(),
    sortOrder: Number.isFinite(Number(raw && (raw.sortOrder ?? raw.sort_order)))
      ? Math.floor(Number(raw && (raw.sortOrder ?? raw.sort_order)))
      : 0,
    createdAt: String(raw && raw.createdAt || "").trim(),
    updatedAt: String(raw && raw.updatedAt || "").trim(),
  };
  const iconColor = normalizeHexColor(raw && (raw.iconColor || raw.color || raw.folderColor || raw.accentColor || raw.appearance && raw.appearance.color));
  if (iconColor) {
    out.iconColor = iconColor;
    out.color = iconColor;
  }
  const icon = String(raw && (raw.icon || raw.iconKey || raw.appearance && raw.appearance.icon) || "").trim();
  if (icon) out.icon = icon;
  const rawKindAsSource = kindRaw && kindRaw !== "local" && kindRaw !== "project_backed" ? kindRaw : "";
  const sourceKind = String(raw && raw.sourceKind || meta.sourceKind || meta.kind || rawKindAsSource || "").trim();
  if (sourceKind) out.sourceKind = sourceKind;
  const folderMetadataPatchType = String(raw && (raw.folderMetadataPatchType || raw.patchType) || meta.folderMetadataPatchType || meta.patchType || "").trim();
  if (folderMetadataPatchType) out.folderMetadataPatchType = folderMetadataPatchType;
  if ((raw && raw.userCreated === true) || meta.userCreated === true) out.userCreated = true;
  if ((raw && raw.materializedUserFolder === true) || meta.materializedUserFolder === true) out.materializedUserFolder = true;
  if ((raw && raw.trustedFolderDisplay === true) || meta.trustedFolderDisplay === true) out.trustedFolderDisplay = true;
  if ((raw && raw.shownInNormalMode === true) || meta.shownInNormalMode === true) out.shownInNormalMode = true;
  if (sourceKind || folderMetadataPatchType || out.userCreated === true || out.materializedUserFolder === true || out.trustedFolderDisplay === true || out.shownInNormalMode === true) {
    out.meta = {
      ...(sourceKind ? { sourceKind } : {}),
      ...(folderMetadataPatchType ? { folderMetadataPatchType } : {}),
      ...(out.userCreated === true ? { userCreated: true } : {}),
      ...(out.materializedUserFolder === true ? { materializedUserFolder: true } : {}),
      ...(out.trustedFolderDisplay === true ? { trustedFolderDisplay: true } : {}),
      ...(out.shownInNormalMode === true ? { shownInNormalMode: true } : {}),
    };
  }
  return out;
}

function normalizeFolderList(raw) {
  const src = Array.isArray(raw) ? raw : [];
  const out = [];
  const seen = new Set();
  for (const row of src) {
    const item = normalizeFolderEntry(row);
    if (!item || seen.has(item.id)) continue;
    out.push(item);
    seen.add(item.id);
  }
  return out;
}

function folderCatalogRowTimestampMs(row) {
  const value = row && (row.updatedAt || row.updated_at || row.modifiedAt || row.modified_at || row.createdAt || row.created_at);
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  const text = String(value || "").trim();
  if (!text) return 0;
  const ms = Date.parse(text);
  return Number.isFinite(ms) ? ms : 0;
}

function isFolderMetadataColorOnlyPatch(row) {
  const meta = row && row.meta && typeof row.meta === "object" && !Array.isArray(row.meta) ? row.meta : {};
  const type = String(row && (row.folderMetadataPatchType || row.patchType) || meta.folderMetadataPatchType || meta.patchType || "").trim();
  return type === "change-folder-color";
}

function mergeFolderCatalogRowByFreshness(prevRaw, itemRaw) {
  const prev = prevRaw && typeof prevRaw === "object" ? prevRaw : {};
  const item = itemRaw && typeof itemRaw === "object" ? itemRaw : {};
  const prevMeta = prev.meta && typeof prev.meta === "object" && !Array.isArray(prev.meta) ? prev.meta : {};
  const itemMeta = item.meta && typeof item.meta === "object" && !Array.isArray(item.meta) ? item.meta : {};
  const prevMs = folderCatalogRowTimestampMs(prev);
  const itemMs = folderCatalogRowTimestampMs(item);
  let base = prev;
  let winner = item;
  if (prev.id && prevMs && (!itemMs || itemMs < prevMs)) {
    base = item;
    winner = prev;
  }
  const colorOnlyPatchPreservesIdentity = isFolderMetadataColorOnlyPatch(item) && !!base.id && winner === item;
  const identity = colorOnlyPatchPreservesIdentity ? base : winner;
  const colorSource = colorOnlyPatchPreservesIdentity ? item : winner;
  const id = String(winner.id || base.id || "").trim();
  const winnerKindAsSource = String(identity.kind || "").trim();
  const baseKindAsSource = String(base.kind || "").trim();
  const sourceKind = String(
    identity.sourceKind
    || itemMeta.sourceKind
    || itemMeta.kind
    || base.sourceKind
    || prevMeta.sourceKind
    || prevMeta.kind
    || (winnerKindAsSource && winnerKindAsSource !== "local" && winnerKindAsSource !== "project_backed" ? winnerKindAsSource : "")
    || (baseKindAsSource && baseKindAsSource !== "local" && baseKindAsSource !== "project_backed" ? baseKindAsSource : "")
    || ""
  ).trim();
  const userCreated = winner.userCreated === true || itemMeta.userCreated === true || base.userCreated === true || prevMeta.userCreated === true;
  const materializedUserFolder = winner.materializedUserFolder === true || itemMeta.materializedUserFolder === true || base.materializedUserFolder === true || prevMeta.materializedUserFolder === true;
  const trustedFolderDisplay = winner.trustedFolderDisplay === true || itemMeta.trustedFolderDisplay === true || base.trustedFolderDisplay === true || prevMeta.trustedFolderDisplay === true;
  const shownInNormalMode = winner.shownInNormalMode === true || itemMeta.shownInNormalMode === true || base.shownInNormalMode === true || prevMeta.shownInNormalMode === true;
  const meta = {
    ...(sourceKind ? { sourceKind } : {}),
    ...(userCreated ? { userCreated: true } : {}),
    ...(materializedUserFolder ? { materializedUserFolder: true } : {}),
    ...(trustedFolderDisplay ? { trustedFolderDisplay: true } : {}),
    ...(shownInNormalMode ? { shownInNormalMode: true } : {}),
  };
  return {
    ...base,
    ...winner,
    id,
    name: String(identity.name || base.name || winner.name || id).trim() || id,
    kind: String(identity.kind || base.kind || winner.kind || "local").trim() || "local",
    projectRef: identity.projectRef || base.projectRef || winner.projectRef || null,
    parentId: String(identity.parentId || base.parentId || winner.parentId || "").trim(),
    source: String(identity.source || base.source || winner.source || "").trim(),
    sortOrder: Number.isFinite(Number(identity.sortOrder)) ? Math.floor(Number(identity.sortOrder))
      : Number.isFinite(Number(winner.sortOrder)) ? Math.floor(Number(winner.sortOrder))
      : Number.isFinite(Number(base.sortOrder)) ? Math.floor(Number(base.sortOrder)) : 0,
    iconColor: String(colorSource.iconColor || colorSource.color || base.iconColor || "").trim(),
    color: String(colorSource.color || colorSource.iconColor || base.color || base.iconColor || "").trim(),
    icon: String(identity.icon || base.icon || winner.icon || "").trim(),
    createdAt: String(identity.createdAt || base.createdAt || winner.createdAt || "").trim(),
    updatedAt: String(winner.updatedAt || base.updatedAt || "").trim(),
    ...(colorOnlyPatchPreservesIdentity ? {
      colorPreservedName: true,
      colorSourceRowName: String(item.name || "").trim(),
      colorLatestRowName: String(base.name || "").trim(),
    } : {}),
    ...(sourceKind ? { sourceKind } : {}),
    ...(userCreated ? { userCreated: true } : {}),
    ...(materializedUserFolder ? { materializedUserFolder: true } : {}),
    ...(trustedFolderDisplay ? { trustedFolderDisplay: true } : {}),
    ...(shownInNormalMode ? { shownInNormalMode: true } : {}),
    ...(Object.keys(meta).length ? { meta } : {}),
  };
}

function mergeFolderCatalogLists(...lists) {
  const byId = new Map();
  for (const rawList of lists) {
    const list = normalizeFolderList(rawList);
    for (const item of list) {
      const id = String(item && item.id || "").trim();
      if (!id) continue;
      const prev = byId.get(id) || {};
      byId.set(id, mergeFolderCatalogRowByFreshness(prev, item));
    }
  }
  return Array.from(byId.values()).sort((a, b) => (
    String(a.name || a.id).localeCompare(String(b.name || b.id))
    || String(a.id).localeCompare(String(b.id))
  ));
}

function normalizeFolderBinding(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  const out = {
    folderId: String(raw && (raw.folderId || raw.id) || "").trim(),
    folderName: String(raw && (raw.folderName || raw.name || raw.title) || "").trim(),
  };
  if (Object.prototype.hasOwnProperty.call(src, "ok")) out.ok = src.ok !== false;
  if (Object.prototype.hasOwnProperty.call(src, "status")) out.status = String(src.status || "").trim();
  if (Object.prototype.hasOwnProperty.call(src, "reason")) out.reason = String(src.reason || "").trim();
  if (Object.prototype.hasOwnProperty.call(src, "chatId")) out.chatId = normalizeChatId(src.chatId);
  if (Object.prototype.hasOwnProperty.call(src, "href")) out.href = String(src.href || "").trim();
  return out;
}

const FOLDER_STATE_DATA_KEY = "h2o:prm:cgx:fldrs:state:data:v1";

function folderCatalogCacheKey(nsDisk = DEFAULT_NS_DISK) {
  return normalizeNsDisk(nsDisk) + ":folderCatalogCache:v1";
}

function folderBindingCacheKey(chatId, nsDisk = DEFAULT_NS_DISK) {
  return normalizeNsDisk(nsDisk) + ":folderBindingCache:" + normalizeChatId(chatId) + ":v1";
}

function labelCatalogKey(nsDisk = DEFAULT_NS_DISK) {
  return normalizeNsDisk(nsDisk) + ":labelCatalog:v1";
}

function categoryCatalogKey(nsDisk = DEFAULT_NS_DISK) {
  return normalizeNsDisk(nsDisk) + ":categoryCatalog:v1";
}

async function readLabelCatalog(nsDisk = DEFAULT_NS_DISK) {
  const key = labelCatalogKey(nsDisk);
  const res = await storageGet([key]);
  const row = res && res[key];
  const labels = seedDefaultLabelCatalog(row && typeof row === "object" && Array.isArray(row.labels) ? row.labels : row);
  try {
    await storageSet({
      [key]: {
        labels,
        updatedAt: nowIso(),
      },
    });
  } catch {}
  return labels;
}

async function readCategoryCatalog(nsDisk = DEFAULT_NS_DISK) {
  const key = categoryCatalogKey(nsDisk);
  const res = await storageGet([key]);
  const row = res && res[key];
  const categories = seedDefaultCategoryCatalog(row && typeof row === "object" && Array.isArray(row.categories) ? row.categories : row);
  try {
    await storageSet({
      [key]: {
        categories,
        updatedAt: nowIso(),
      },
    });
  } catch {}
  return categories;
}

async function mergeCategoryCatalog(categories, nsDisk = DEFAULT_NS_DISK) {
  const key = categoryCatalogKey(nsDisk);
  const existing = await readCategoryCatalog(nsDisk);
  const merged = seedDefaultCategoryCatalog([
    ...existing,
    ...(Array.isArray(categories) ? categories : []),
  ]);
  await storageSet({
    [key]: {
      categories: merged,
      updatedAt: nowIso(),
    },
  });
  return merged;
}

async function writeCategoryCatalog(categories, nsDisk = DEFAULT_NS_DISK) {
  const key = categoryCatalogKey(nsDisk);
  const normalized = normalizeCategoryCatalog(categories);
  await storageSet({
    [key]: {
      categories: normalized,
      updatedAt: nowIso(),
    },
  });
  return normalized;
}

async function renameCategory(categoryId, nextNameRaw, nsDisk = DEFAULT_NS_DISK) {
  const id = String(categoryId || "").trim();
  const nextName = String(nextNameRaw || "").trim();
  if (!id || !nextName) throw new Error("missing category id or name");
  const current = await readCategoryCatalog(nsDisk);
  const idx = current.findIndex((item) => String(item && item.id || "") === id);
  if (idx < 0) throw new Error("category not found");
  const next = current.slice();
  next[idx] = { ...next[idx], name: nextName, updatedAt: nowIso() };
  await writeCategoryCatalog(next, nsDisk);
  return next[idx];
}

async function deleteCategory(categoryId, nsDisk = DEFAULT_NS_DISK) {
  const id = String(categoryId || "").trim();
  if (!id) throw new Error("missing category id");
  const current = await readCategoryCatalog(nsDisk);
  const target = current.find((item) => String(item && item.id || "") === id);
  if (!target) return false;
  const next = target.custom === true
    ? current.filter((item) => String(item && item.id || "") !== id)
    : current.map((item) => (
      String(item && item.id || "") === id
        ? { ...item, status: "retired", updatedAt: nowIso() }
        : item
    ));
  await writeCategoryCatalog(next, nsDisk);
  return true;
}

async function mergeLabelCatalog(labels, nsDisk = DEFAULT_NS_DISK) {
  const key = labelCatalogKey(nsDisk);
  const existing = await readLabelCatalog(nsDisk);
  const merged = seedDefaultLabelCatalog([
    ...existing,
    ...(Array.isArray(labels) ? labels : []),
  ]);
  await storageSet({
    [key]: {
      labels: merged,
      updatedAt: nowIso(),
    },
  });
  return merged;
}

async function readFolderCatalogCache(nsDisk = DEFAULT_NS_DISK) {
  const key = folderCatalogCacheKey(nsDisk);
  const res = await storageGet([key]);
  const row = res && res[key];
  return normalizeFolderList(row && typeof row === "object" && Array.isArray(row.folders) ? row.folders : row);
}

async function readImportedFolderStateCatalog() {
  const res = await storageGet([FOLDER_STATE_DATA_KEY]);
  const row = res && res[FOLDER_STATE_DATA_KEY];
  const folders = row && typeof row === "object" && Array.isArray(row.folders) ? row.folders : row;
  return normalizeFolderList(folders);
}

async function deriveFolderCatalogFromArchiveRows(nsDisk = DEFAULT_NS_DISK) {
  const rows = await listWorkbenchRows(nsDisk);
  const out = [];
  const seen = new Set();
  for (const row of Array.isArray(rows) ? rows : []) {
    const id = String(row && (row.folderId || row.folder) || "").trim();
    if (!id || seen.has(id)) continue;
    const name = String(row && (row.folderName || row.folderLabel || row.folderTitle) || id).trim() || id;
    out.push({
      id,
      name,
      kind: "local",
      projectRef: null,
      createdAt: "",
      updatedAt: String(row && (row.updatedAt || row.createdAt) || "").trim(),
    });
    seen.add(id);
  }
  return normalizeFolderList(out);
}

async function writeFolderCatalogCache(folders, nsDisk = DEFAULT_NS_DISK) {
  const key = folderCatalogCacheKey(nsDisk);
  await storageSet({
    [key]: {
      folders: normalizeFolderList(folders),
      updatedAt: nowIso(),
    },
  });
}

async function readFolderBindingCache(chatIds, nsDisk = DEFAULT_NS_DISK) {
  const ids = uniqStringList(chatIds).map((id) => normalizeChatId(id)).filter(Boolean);
  if (!ids.length) return { map: {}, count: 0 };

  const keys = ids.map((id) => folderBindingCacheKey(id, nsDisk));
  const res = await storageGet(keys);
  const map = {};
  let count = 0;
  for (const id of ids) {
    const key = folderBindingCacheKey(id, nsDisk);
    if (!res || !Object.prototype.hasOwnProperty.call(res, key)) continue;
    map[id] = normalizeFolderBinding(res[key]);
    count += 1;
  }
  return { map, count };
}

async function writeFolderBindingCache(chatId, binding, nsDisk = DEFAULT_NS_DISK) {
  const id = normalizeChatId(chatId);
  if (!id) return;
  const key = folderBindingCacheKey(id, nsDisk);
  await storageSet({
    [key]: {
      ...normalizeFolderBinding(binding),
      updatedAt: nowIso(),
    },
  });
}

function sendFolderBridgeMessage(tabId, message, timeoutMs = FOLDER_BRIDGE_MESSAGE_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = 0;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      fn(value);
    };

    try {
      const op = String(message?.req?.op || "folder bridge");
      timer = setTimeout(() => {
        finish(reject, new Error(op + " timed out waiting for ChatGPT tab folder bridge"));
      }, timeoutMs);
      chrome.tabs.sendMessage(tabId, message, (resp) => {
        const le = chrome.runtime.lastError;
        if (le) return finish(reject, new Error(String(le.message || le)));
        if (!resp || resp.ok === false) {
          return finish(reject, new Error(String(resp && resp.error || "folder bridge failed")));
        }
        finish(resolve, resp.result);
      });
    } catch (error) {
      finish(reject, error);
    }
  });
}

async function queryFolderBridge(op, payload = {}, nsDisk = DEFAULT_NS_DISK) {
  const tabs = await new Promise((resolve, reject) => {
    chrome.tabs.query({ url: [CHAT_MATCH] }, (rows) => {
      const le = chrome.runtime.lastError;
      if (le) return reject(new Error(String(le.message || le)));
      resolve(Array.isArray(rows) ? rows : []);
    });
  });

  const sorted = tabs.slice().sort((a, b) => Number(!!b.active) - Number(!!a.active));
  let lastError = null;

  for (const tab of sorted) {
    const tabId = Number(tab && tab.id || 0);
    if (!tabId) continue;

    try {
      const result = await sendFolderBridgeMessage(tabId, {
        type: MSG_FOLDERS,
        req: { op, payload, nsDisk },
      });
      return result;
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error("open a ChatGPT tab to access folders");
}

async function getFoldersListBridge(nsDisk = DEFAULT_NS_DISK) {
  try {
    const bridgeList = normalizeFolderList(await queryFolderBridge("getFoldersList", {}, nsDisk));
    let importedList = [];
    let archiveList = [];
    try { importedList = await readImportedFolderStateCatalog(); } catch {}
    try { archiveList = await deriveFolderCatalogFromArchiveRows(nsDisk); } catch {}
    const list = mergeFolderCatalogLists(archiveList, importedList, bridgeList);
    await writeFolderCatalogCache(list, nsDisk);
    return list;
  } catch (error) {
    let cached = [];
    let importedList = [];
    let archiveList = [];
    try { cached = await readFolderCatalogCache(nsDisk); } catch {}
    try { importedList = await readImportedFolderStateCatalog(); } catch {}
    try { archiveList = await deriveFolderCatalogFromArchiveRows(nsDisk); } catch {}
    const list = mergeFolderCatalogLists(archiveList, importedList, cached);
    if (list.length) return list;
    throw error;
  }
}

async function resolveFolderBindingsBridge(chatIds, nsDisk = DEFAULT_NS_DISK) {
  const ids = uniqStringList(chatIds).map((id) => normalizeChatId(id)).filter(Boolean);
  if (!ids.length) return {};

  try {
    const raw = await queryFolderBridge("resolveFolderBindings", { chatIds: ids }, nsDisk);
    const out = {};
    for (const id of ids) {
      out[id] = normalizeFolderBinding(raw && raw[id]);
      await writeFolderBindingCache(id, out[id], nsDisk);
    }
    return out;
  } catch (error) {
    const cached = await readFolderBindingCache(ids, nsDisk);
    if (cached.count > 0) return cached.map;
    throw error;
  }
}

async function setFolderBindingBridge(chatId, folderId, nsDisk = DEFAULT_NS_DISK) {
  const id = normalizeChatId(chatId);
  if (!id) throw new Error("missing chatId");
  try {
    const result = normalizeFolderBinding(await queryFolderBridge("setFolderBinding", {
      chatId: id,
      folderId: String(folderId || ""),
    }, nsDisk));
    if (result.ok === false) {
      return {
        ok: false,
        status: String(result.status || result.reason || "rejected"),
        reason: String(result.reason || result.status || "rejected"),
        chatId: id,
        folderId: String(result.folderId || ""),
        folderName: String(result.folderName || ""),
      };
    }
    await writeFolderBindingCache(id, result, nsDisk);
    return result;
  } catch (error) {
    return {
      ok: false,
      status: "folder-bridge-unavailable",
      reason: String(error && (error.message || error) || "folder bridge unavailable"),
      chatId: id,
      folderId: "",
      folderName: "",
    };
  }
}

async function setFolderIconColorBridge(folderId, iconColor, nsDisk = DEFAULT_NS_DISK) {
  const id = String(folderId || "").trim();
  if (!id) throw new Error("missing folderId");
  const color = normalizeHexColor(iconColor || "");
  const result = await queryFolderBridge("setFolderIconColor", {
    folderId: id,
    iconColor: color,
  }, nsDisk);
  try {
    const list = normalizeFolderList(await queryFolderBridge("getFoldersList", {}, nsDisk));
    await writeFolderCatalogCache(list, nsDisk);
  } catch {}
  return result && typeof result === "object" ? result : { ok: true, folderId: id, iconColor: color };
}

function normalizeWorkbenchRoute(routeRaw) {
  const raw = String(routeRaw || "").trim();
  if (!raw) return "#/saved";
  if (raw.startsWith("#")) return raw;
  return "#" + (raw.startsWith("/") ? raw : ("/" + raw));
}

async function openWorkbench(routeRaw = "/saved") {
  if (!ARCHIVE_WORKBENCH_ENABLED) {
    throw new Error("archive workbench is hosted only by H2O Dev Controls");
  }
  const url = chrome.runtime.getURL("surfaces/studio/studio.html") + normalizeWorkbenchRoute(routeRaw);
  return new Promise((resolve, reject) => {
    try {
      chrome.tabs.create({ url }, (tab) => {
        const le = chrome.runtime.lastError;
        if (le) return reject(new Error(String(le.message || le)));
        resolve({
          ok: true,
          tabId: Number(tab && tab.id || 0),
          url,
        });
      });
    } catch (err) {
      reject(err);
    }
  });
}

const STUDIO_LAST_HASH_KEY = "h2o:studio:lastHash";

function getStoredStudioLastHash() {
  return new Promise((resolve) => {
    try {
      if (!chrome.storage || !chrome.storage.local || typeof chrome.storage.local.get !== "function") {
        resolve("");
        return;
      }
      chrome.storage.local.get(STUDIO_LAST_HASH_KEY, (result) => {
        void chrome.runtime.lastError;
        const raw = result && typeof result === "object" ? result[STUDIO_LAST_HASH_KEY] : "";
        const trimmed = String(raw || "").trim();
        resolve(trimmed.startsWith("#") ? trimmed : "");
      });
    } catch {
      resolve("");
    }
  });
}

function shouldRefreshExistingStudioTab() {
  return new Promise((resolve) => {
    try {
      if (!chrome.storage || !chrome.storage.local || typeof chrome.storage.local.get !== "function") {
        resolve(false);
        return;
      }
      chrome.storage.local.get(STUDIO_PRESENCE_KEY, (result) => {
        void chrome.runtime.lastError;
        const presence = result && typeof result === "object" ? result[STUDIO_PRESENCE_KEY] : null;
        const lastSeen = Number(presence && presence.lastSeenAt || 0);
        resolve(!(Number.isFinite(lastSeen) && lastSeen >= STUDIO_SERVICE_WORKER_BOOT_AT));
      });
    } catch {
      resolve(false);
    }
  });
}

// Open Studio in a new tab, OR focus the existing Studio tab if one is already
// open. This is the fast path bound to chrome.action.onClicked in profiles
// without a popup (prod, dev-lean). Behavior:
//   - explicit routeRaw  : normalize it and use that as the hash
//   - no routeRaw        : read last-saved hash from chrome.storage.local;
//                           fall back to "#/saved" if missing/invalid
//   - existing tab found : focus tab + focus window; rewrite only for an
//                           explicit route, or reload the current Studio URL
//                           if the page has not heartbeated since this
//                           service worker booted (extension-reload recovery)
//   - no existing tab    : chrome.tabs.create at the resolved URL
async function openOrFocusStudio(routeRaw = "") {
  if (!ARCHIVE_WORKBENCH_ENABLED) {
    throw new Error("Studio is not hosted in this extension build (chrome-ext-prod only).");
  }
  // In-flight guard: if a previous call (toolbar click or auto-restore) is
  // mid-query-or-create, reuse its promise instead of racing a second
  // chrome.tabs.create. The guard clears in finally so subsequent clicks
  // (after the first resolves) work normally.
  if (__studioOpenInFlight) return __studioOpenInFlight;
  __studioOpenInFlight = (async () => {
  const baseUrl = chrome.runtime.getURL("surfaces/studio/studio.html");
  const callerProvidedRoute = typeof routeRaw === "string" && routeRaw.trim() !== "";
  let hash = "";
  if (callerProvidedRoute) {
    hash = normalizeWorkbenchRoute(routeRaw);
  } else {
    const stored = await getStoredStudioLastHash();
    hash = stored || "#/saved";
  }
  const url = baseUrl + hash;

  // Query all tabs and filter to our Studio surface URL prefix. The Studio
  // launcher grants "tabs" specifically because this focus/reload path needs
  // to see extension-page URLs reliably after an unpacked-extension reload.
  const existing = await new Promise((resolve) => {
    try {
      chrome.tabs.query({}, (rows) => {
        void chrome.runtime.lastError;
        const all = Array.isArray(rows) ? rows : [];
        resolve(all.filter((tab) => typeof tab?.url === "string" && tab.url.startsWith(baseUrl)));
      });
    } catch {
      resolve([]);
    }
  });

  if (existing.length) {
    const tab = existing.slice().sort((a, b) => Number(!!b.active) - Number(!!a.active))[0];
    const tabId = Number(tab && tab.id || 0);
    const winId = Number(tab && tab.windowId || 0);
    try { if (tabId) chrome.tabs.update(tabId, { active: true }); } catch {}
    try { if (winId) chrome.windows.update(winId, { focused: true }); } catch {}
    if (callerProvidedRoute && tabId) {
      try {
        const existingHash = (() => {
          try { return new URL(tab.url).hash || ""; } catch { return ""; }
        })();
        const refreshExisting = await shouldRefreshExistingStudioTab();
        if (existingHash !== hash || refreshExisting) {
          chrome.tabs.update(tabId, { url: refreshExisting && !callerProvidedRoute ? (baseUrl + (existingHash || hash)) : url });
        }
      } catch {}
    } else if (tabId && await shouldRefreshExistingStudioTab()) {
      try {
        const existingHash = (() => {
          try { return new URL(tab.url).hash || ""; } catch { return ""; }
        })();
        chrome.tabs.update(tabId, { url: baseUrl + (existingHash || hash) });
      } catch {}
    }
    return { ok: true, tabId, source: "existing-tab", url: (tab && tab.url) || url };
  }

  return new Promise((resolve, reject) => {
    try {
      chrome.tabs.create({ url }, (tab) => {
        const le = chrome.runtime.lastError;
        if (le) return reject(new Error(String(le.message || le)));
        resolve({ ok: true, tabId: Number(tab && tab.id || 0), source: "new-tab", url });
      });
    } catch (err) {
      reject(err);
    }
  });
  })();
  try {
    return await __studioOpenInFlight;
  } finally {
    __studioOpenInFlight = null;
  }
}

// ─── Studio auto-restore after extension reload ────────────────────────────
//
// When the user reloads the extension from chrome://extensions, Chrome:
//   - terminates the SW
//   - invalidates every chrome-extension://<id>/* page in tabs (the tab usually
//     stays but its document context is dead until navigated again)
//   - respawns the SW and fires chrome.runtime.onInstalled
//
// If the Studio tab was alive within the freshness window before the reload,
// we want it back at its last route. The Studio page writes a heartbeat to
// chrome.storage.local["h2o:studio:presence:v1"] every 10s (plus on boot /
// hashchange / visibilitychange). On SW respawn we read that record:
//   - if missing or stale → do nothing (user closed Studio long ago)
//   - if fresh            → reload the existing Studio tab (force navigation
//                           to clear the invalidated context) OR open a new
//                           background tab if none exists
// A cooldown marker prevents repeat restores from multiple SW wake events.

const STUDIO_PRESENCE_KEY = "h2o:studio:presence:v1";
/* Accepted object-sync composition input: the background Sync runtime is
 * handed this read-only Studio-context query as findActiveStudioContexts
 * so a wake can defer to an open Studio surface instead of racing it. It
 * queries extension contexts only; it never opens, focuses or remembers a
 * tab. */
async function findExistingStudioContexts() {
  const studioBaseUrl = chrome.runtime.getURL("surfaces/studio/studio.html");
  const getContexts = chrome.runtime && chrome.runtime.getContexts;
  if (typeof getContexts !== "function") return null;
  try {
    const contexts = await chrome.runtime.getContexts({ contextTypes: ["TAB"] });
    void chrome.runtime.lastError;
    if (!Array.isArray(contexts)) return null;
    return contexts.filter((context) =>
      typeof context?.documentUrl === "string" &&
      context.documentUrl.startsWith(studioBaseUrl));
  } catch {
    return null;
  }
}

const STUDIO_LAST_AUTO_RESTORE_KEY = "h2o:studio:lastAutoRestoreAt";
const STUDIO_PRESENCE_FRESHNESS_MS = 3 * 60 * 1000;       // 3 min: "alive recently"
const STUDIO_AUTO_RESTORE_COOLDOWN_MS = 30 * 1000;        // 30 s: avoid duplicate restores

async function restoreStudioTabAfterReload(hashRaw) {
  const baseUrl = chrome.runtime.getURL("surfaces/studio/studio.html");
  const hash = normalizeWorkbenchRoute(hashRaw);
  const url = baseUrl + hash;
  const existing = await new Promise((resolve) => {
    try {
      chrome.tabs.query({}, (rows) => {
        void chrome.runtime.lastError;
        const all = Array.isArray(rows) ? rows : [];
        resolve(all.filter((t) => typeof t?.url === "string" && t.url.startsWith(baseUrl)));
      });
    } catch { resolve([]); }
  });
  if (existing.length) {
    // Page context was invalidated by the extension reload; navigating to the
    // same URL forces a fresh load that picks up the new SW context. We do
    // NOT call chrome.tabs.update({active:true}) on purpose — we don't want
    // to steal focus from chrome://extensions while the user is mid-reload.
    const tab = existing[0];
    try {
      await new Promise((resolve) => {
        chrome.tabs.update(tab.id, { url }, () => { void chrome.runtime.lastError; resolve(); });
      });
    } catch {}
    return { source: "reload-existing", tabId: Number(tab.id || 0) };
  }
  // No surviving tab. Open a new one in the background (active:false) so the
  // user's current focus (likely chrome://extensions) stays put. The user can
  // switch to it manually when ready.
  return new Promise((resolve) => {
    try {
      chrome.tabs.create({ url, active: false }, (tab) => {
        void chrome.runtime.lastError;
        resolve({ source: "new-tab", tabId: Number(tab && tab.id || 0) });
      });
    } catch {
      resolve({ source: "error", tabId: 0 });
    }
  });
}

async function scheduleStudioPresenceRestore(reason) {
  if (!ARCHIVE_WORKBENCH_ENABLED) {
    // Studio is not hosted in this build; nothing to restore. Returning
    // silently here is intentional — non-prod profiles should never even
    // try to read presence (the storage namespace is per-extension-ID, so
    // any stale presence belongs to a previous prod-ish identity anyway).
    return { ok: false, skipped: "studio-not-hosted", reason };
  }
  if (!STUDIO_AUTO_RESTORE_ENABLED) {
    // Auto-restore disabled by build profile (e.g. Studio Launcher). The
    // toolbar button (openOrFocusStudio) is the only Studio entry point.
    return { ok: false, skipped: "auto-restore-disabled", reason };
  }
  // In-flight guard: sw-boot top-level + chrome.runtime.onInstalled fire
  // within milliseconds of each other on extension reload. Both pass the
  // chrome.storage cooldown check before either writes the marker (TOCTOU),
  // and the resulting two restoreStudioTabAfterReload calls can each create
  // a new tab. Reusing the in-flight promise serializes them.
  if (__studioRestoreInFlight) return __studioRestoreInFlight;
  __studioRestoreInFlight = (async () => {
  try {
    const result = await new Promise((resolve) => {
      try {
        chrome.storage.local.get([STUDIO_PRESENCE_KEY, STUDIO_LAST_AUTO_RESTORE_KEY], (rows) => {
          void chrome.runtime.lastError;
          resolve(rows || {});
        });
      } catch { resolve({}); }
    });
    const presence = result[STUDIO_PRESENCE_KEY];
    if (!presence || typeof presence !== "object") {
      return { ok: false, skipped: "no-presence", reason };
    }
    const lastSeen = Number(presence.lastSeenAt || 0);
    const ageMs = Date.now() - lastSeen;
    if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > STUDIO_PRESENCE_FRESHNESS_MS) {
      return { ok: false, skipped: "stale", ageMs, reason };
    }
    const lastRestore = Number(result[STUDIO_LAST_AUTO_RESTORE_KEY] || 0);
    if (Date.now() - lastRestore < STUDIO_AUTO_RESTORE_COOLDOWN_MS) {
      return { ok: false, skipped: "cooldown", reason };
    }
    const lastHash = String(presence.lastHash || "").trim() || "#/saved";
    const restoreResult = await restoreStudioTabAfterReload(lastHash);
    try {
      chrome.storage.local.set({ [STUDIO_LAST_AUTO_RESTORE_KEY]: Date.now() }, () => {
        void chrome.runtime.lastError;
      });
    } catch {}
    console.log(TAG, "studio auto-restored", { reason, lastHash, ageMs, ...restoreResult });
    return { ok: true, reason, lastHash, ageMs, ...restoreResult };
  } catch (e) {
    console.warn(TAG, "studio auto-restore failed", e && (e.message || e));
    return { ok: false, error: String(e && (e.message || e)), reason };
  }
  })();
  try {
    return await __studioRestoreInFlight;
  } finally {
    __studioRestoreInFlight = null;
  }
}

async function openControlHubPanel() {
  const tabs = await new Promise((resolve, reject) => {
    chrome.tabs.query({ url: [CHAT_MATCH] }, (rows) => {
      const le = chrome.runtime.lastError;
      if (le) return reject(new Error(String(le.message || le)));
      resolve(Array.isArray(rows) ? rows : []);
    });
  });

  const sorted = tabs.slice().sort((a, b) => Number(!!b.active) - Number(!!a.active));
  for (const tab of sorted) {
    const tabId = Number(tab && tab.id || 0);
    if (!tabId) continue;
    try {
      const result = await new Promise((resolve, reject) => {
        chrome.tabs.sendMessage(tabId, {
          type: MSG_CONTROL_HUB_OPEN,
          timeoutMs: 12000,
        }, (resp) => {
          const le = chrome.runtime.lastError;
          if (le) return reject(new Error(String(le.message || le)));
          resolve(resp || { ok: false });
        });
      });

      if (result && result.ok) {
        try { chrome.tabs.update(tabId, { active: true }); } catch {}
        try {
          const winId = Number(tab && tab.windowId || 0);
          if (winId) chrome.windows.update(winId, { focused: true });
        } catch {}
        return { ok: true, tabId, source: "existing-chat-tab" };
      }
    } catch {}
  }

  const url = "https://chatgpt.com/?h2o_open_control_hub=1";
  return new Promise((resolve, reject) => {
    try {
      chrome.tabs.create({ url }, (tab) => {
        const le = chrome.runtime.lastError;
        if (le) return reject(new Error(String(le.message || le)));
        resolve({
          ok: true,
          tabId: Number(tab && tab.id || 0),
          source: "new-chat-tab-fallback",
          url,
        });
      });
    } catch (err) {
      reject(err);
    }
  });
}

async function exportBundle(scope, chatId, nsDisk = DEFAULT_NS_DISK) {
  const ns = normalizeNsDisk(nsDisk);
  const mode = String(scope || "chat").trim().toLowerCase();
  let chatIds = [];
  if (mode === "chat") {
    const id = normalizeChatId(chatId);
    if (!id) throw new Error("missing chatId");
    chatIds = [id];
  } else if (mode === "all") {
    chatIds = await listAllChatIds(ns);
  } else {
    throw new Error("invalid scope");
  }

  const chats = [];
  for (const id of chatIds) {
    const bootMode = await getBootMode(id, ns);
    const chatIndex = await getChatIndex(id, ns);
    const headers = await listSnapshotHeadersByChat(id);
    const snapshots = [];
    for (const h of headers) {
      const full = await loadSnapshotById(h.snapshotId);
      if (!full) continue;
      snapshots.push({
        snapshotId: String(h.snapshotId || ""),
        createdAt: String(h.createdAt || ""),
        schemaVersion: Number(h.schemaVersion || 1),
        messageCount: Number(h.messageCount || 0),
        digest: String(h.digest || ""),
        meta: h.meta && typeof h.meta === "object" ? h.meta : {},
        messages: Array.isArray(full.messages) ? full.messages : [],
      });
    }
    chats.push({
      chatId: id,
      bootMode,
      chatIndex,
      migrated: await getMigratedFlag(id, ns),
      snapshots,
    });
  }

  return {
    schema: "h2o.chatArchive.bundle.v1",
    exportedAt: nowIso(),
    scope: mode,
    chatCount: chats.length,
    chats,
    catalogs: {
      categories: await readCategoryCatalog(ns),
      labels: await readLabelCatalog(ns),
    },
  };
}

async function importBundle(bundle, modeRaw = "merge", nsDisk = DEFAULT_NS_DISK) {
  const ns = normalizeNsDisk(nsDisk);
  const mode = String(modeRaw || "merge").trim().toLowerCase() === "overwrite" ? "overwrite" : "merge";
  const src = bundle && typeof bundle === "object" ? bundle : null;
  if (!src || src.schema !== "h2o.chatArchive.bundle.v1" || !Array.isArray(src.chats)) {
    throw new Error("invalid bundle");
  }

  const categoryCatalog = src.catalogs && typeof src.catalogs === "object" && Array.isArray(src.catalogs.categories)
    ? await mergeCategoryCatalog(src.catalogs.categories, ns)
    : await readCategoryCatalog(ns);

  if (src.catalogs && typeof src.catalogs === "object" && Array.isArray(src.catalogs.labels)) {
    await mergeLabelCatalog(src.catalogs.labels, ns);
  } else {
    await readLabelCatalog(ns);
  }

  let importedChats = 0;
  let importedSnapshots = 0;
  for (const chat of src.chats) {
    const chatId = normalizeChatId(chat && chat.chatId);
    if (!chatId) continue;

    await withChatLock(chatId, async () => {
      if (mode === "overwrite") {
        await clearChatSnapshotsUnlocked(chatId, ns);
      }

      if (chat && Object.prototype.hasOwnProperty.call(chat, "bootMode")) {
        await setBootMode(chatId, chat.bootMode, ns);
      }

      const snaps = Array.isArray(chat && chat.snapshots) ? chat.snapshots.slice() : [];
      snaps.sort((a, b) => String(a && a.createdAt || "").localeCompare(String(b && b.createdAt || "")));
      for (const snap of snaps) {
        const messages = Array.isArray(snap && snap.messages) ? snap.messages : [];
        const snapshotId = String(snap && snap.snapshotId || "");
        const importedMeta = snap && typeof snap.meta === "object" ? { ...snap.meta } : {};
        const existingLoaded = snapshotId ? await loadSnapshotById(snapshotId) : null;
        if (existingLoaded && existingLoaded.header && existingLoaded.header.meta && typeof existingLoaded.header.meta === "object") {
          importedMeta.category = mergeCategoryRecords(
            existingLoaded.header.meta.category,
            importedMeta.category,
            categoryCatalog,
          );
        }
        await captureSnapshotInternalUnlocked(
          chatId,
          messages,
          importedMeta,
          {
            forceNew: true,
            snapshotId: snapshotId || undefined,
            createdAt: String(snap && snap.createdAt || "") || undefined,
            categoryCatalog,
          },
          ns,
        );
        importedSnapshots += 1;
      }

      const idx = await getChatIndex(chatId, ns);
      if (chat && chat.chatIndex && typeof chat.chatIndex === "object") {
        const wantedPinned = uniqStringList(chat.chatIndex.pinnedSnapshotIds);
        if (wantedPinned.length) idx.pinnedSnapshotIds = wantedPinned;
        if (chat.chatIndex.retentionPolicy) idx.retentionPolicy = normalizeRetentionPolicy(chat.chatIndex.retentionPolicy);
      }
      await setChatIndex(chatId, idx, ns);
      await applyRetentionUnlocked(chatId, ns);

      if (chat && Object.prototype.hasOwnProperty.call(chat, "migrated")) {
        await setMigratedFlag(chatId, !!chat.migrated, ns);
      }
      importedChats += 1;
    });
  }
  return { ok: true, mode, importedChats, importedSnapshots };
}

// ─── v2 Full-bundle migration (chat archive + chrome.storage.local + library-kv) ─
//
// One-shot migration tool used when the user needs to move all Studio data from
// one extension ID to another (e.g. moving from chrome-ext-dev-controls to
// chrome-ext-prod after the Studio launcher was wired to a new build path).
// Chrome isolates chrome.storage.local + IndexedDB by extension ID, so the
// destination extension starts with empty user data even though the code is
// identical. This pipeline produces a portable JSON bundle on the source side
// and applies it (with dry-run + auto-backup + merge semantics) on the dest.
//
// Schema versions:
//   v1: "h2o.chatArchive.bundle.v1"  ← existing exportBundle / importBundle
//   v2: "h2o.studio.fullBundle.v2"   ← embeds v1 + chrome.storage.local + library-kv
// v2 is backward compatible: dryRunImportFullBundle / importFullBundle accept
// a v1 bundle as a degraded input (no storage / kv sections).
//
// SECURITY: identity tokens, dev-control toggles, ephemeral broadcast keys, and
// the studio-route hint are never exported (see STORAGE_KEY_*).

const FULL_BUNDLE_SCHEMA_V2 = "h2o.studio.fullBundle.v2";

// Allowlist + denylist for chrome.storage.local. We export only keys matching
// the allowlist AND not matching the denylist. Tested in this order — denylist
// wins on overlap.
const STORAGE_KEY_DENYLIST_PREFIXES = Object.freeze([
  // Identity / auth: NEVER export tokens, snapshots, refresh keys, OAuth flow.
  "h2oIdentity",
  "h2oIdentityProvider",
  "H2O_IDENTITY_",
  // Dev-control toggles + sets + chat bindings — extension-local, not user data.
  "h2oExtDev",
  // Ephemeral cross-surface heartbeats — pure runtime sync signal, not state.
  "h2o:library:cross-surface:broadcast",
  // Studio-route hint — extension-local route restore, not user data.
  "h2o:studio:lastHash",
]);

const STORAGE_KEY_ALLOWLIST_PREFIXES = Object.freeze([
  // Studio UI prefs + edit overrides
  "h2o:archiveWorkbench:",
  // Folders, projects, expanded state, see-more state, projects cache
  "h2o:prm:cgx:fldrs:",
  // Inline highlights (canonical v3 disk format)
  "h2o:prm:cgx:nlnhghlghtr:",
  // Library workspace metadata (chat-title state, interface-meta, chat-registry)
  "h2o:prm:cgx:library:",
  // Answer numbering / config
  "h2o:prm:cgx:ansn:",
  // MiniMap state (inline-dot map, badge visibility, etc.)
  "h2o:prm:cgx:mnmp:",
  // Legacy "ho:" chat metadata (pin / heat / row tint / chat-meta)
  "ho:chat-",
  "ho:chat-meta-",
]);

function isExportableStorageKey(key) {
  const k = String(key || "");
  if (!k) return false;
  for (const deny of STORAGE_KEY_DENYLIST_PREFIXES) {
    if (k.startsWith(deny)) return false;
  }
  for (const allow of STORAGE_KEY_ALLOWLIST_PREFIXES) {
    if (k.startsWith(allow)) return true;
  }
  return false;
}

function dumpChromeStorageLocalFiltered() {
  return new Promise((resolve, reject) => {
    try {
      chrome.storage.local.get(null, (all) => {
        const le = chrome.runtime.lastError;
        if (le) return reject(new Error(String(le.message || le)));
        const out = {};
        const rows = all && typeof all === "object" ? all : {};
        for (const [k, v] of Object.entries(rows)) {
          if (isExportableStorageKey(k)) out[k] = v;
        }
        resolve(out);
      });
    } catch (err) {
      reject(err);
    }
  });
}

async function dumpLibraryKvAll() {
  const db = await libraryKvOpenDb();
  return new Promise((resolve, reject) => {
    let tx;
    try { tx = db.transaction(LIBRARY_KV_STORE, "readonly"); }
    catch (e) { reject(e); return; }
    const store = tx.objectStore(LIBRARY_KV_STORE);
    const keysReq = store.getAllKeys();
    const valsReq = store.getAll();
    let keys = null;
    let vals = null;
    keysReq.onsuccess = () => { keys = keysReq.result; if (vals !== null) finish(); };
    valsReq.onsuccess = () => { vals = valsReq.result; if (keys !== null) finish(); };
    keysReq.onerror = () => reject(keysReq.error || new Error("library kv: getAllKeys failed"));
    valsReq.onerror = () => reject(valsReq.error || new Error("library kv: getAll failed"));
    function finish() {
      const out = [];
      const ks = Array.isArray(keys) ? keys : [];
      const vs = Array.isArray(vals) ? vals : [];
      const n = Math.min(ks.length, vs.length);
      for (let i = 0; i < n; i++) {
        const k = ks[i];
        if (typeof k !== "string") continue;
        out.push({ key: k, value: vs[i] });
      }
      resolve(out);
    }
  });
}

async function writeLibraryKvBatchMerge(rows, modeRaw) {
  const mode = String(modeRaw || "merge").trim().toLowerCase() === "overwrite" ? "overwrite" : "merge";
  if (!Array.isArray(rows) || !rows.length) return { written: 0, skipped: 0, errors: [] };
  const db = await libraryKvOpenDb();

  // Snapshot existing keys once for merge-mode skip decisions.
  const existingKeys = new Set();
  if (mode === "merge") {
    await new Promise((resolve, reject) => {
      let tx;
      try { tx = db.transaction(LIBRARY_KV_STORE, "readonly"); }
      catch (e) { reject(e); return; }
      const req = tx.objectStore(LIBRARY_KV_STORE).getAllKeys();
      req.onsuccess = () => {
        for (const k of (req.result || [])) if (typeof k === "string") existingKeys.add(k);
        resolve();
      };
      req.onerror = () => reject(req.error || new Error("library kv: getAllKeys failed"));
    });
  }

  return new Promise((resolve, reject) => {
    let tx;
    try { tx = db.transaction(LIBRARY_KV_STORE, "readwrite"); }
    catch (e) { reject(e); return; }
    const store = tx.objectStore(LIBRARY_KV_STORE);
    let written = 0;
    let skipped = 0;
    const errors = [];
    for (const row of rows) {
      const k = row && typeof row.key === "string" ? row.key : "";
      if (!k) { skipped += 1; continue; }
      const keyCheck = libraryKvValidateKey(k);
      if (!keyCheck.ok) {
        errors.push({ key: k, code: keyCheck.code, error: keyCheck.error });
        skipped += 1;
        continue;
      }
      if (mode === "merge" && existingKeys.has(k)) { skipped += 1; continue; }
      try {
        store.put(row.value, k);
        written += 1;
      } catch (e) {
        errors.push({ key: k, code: "PUT_FAILED", error: String(e && (e.message || e)) });
        skipped += 1;
      }
    }
    tx.oncomplete = () => resolve({ written, skipped, errors });
    tx.onerror = () => reject(tx.error || new Error("library kv: tx error"));
    tx.onabort = () => reject(tx.error || new Error("library kv: tx aborted"));
  });
}

function normalizeFolderStateItems(rawItems) {
  const src = rawItems && typeof rawItems === "object" && !Array.isArray(rawItems) ? rawItems : {};
  const out = {};
  for (const [folderIdRaw, chatIdsRaw] of Object.entries(src)) {
    const folderId = String(folderIdRaw || "").trim();
    if (!folderId) continue;
    const chatIds = uniqStringList(Array.isArray(chatIdsRaw) ? chatIdsRaw : []);
    out[folderId] = chatIds.map((id) => normalizeChatId(id)).filter(Boolean);
  }
  return out;
}

function normalizeFolderStateData(raw) {
  const src = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const schemaVersion = Number(src.schemaVersion || src.version || 1) || 1;
  return {
    ...src,
    schemaVersion,
    folders: normalizeFolderList(Array.isArray(src.folders) ? src.folders : []),
    items: normalizeFolderStateItems(src.items),
  };
}

function mergeFolderStateItems(existingItems, incomingItems) {
  const out = normalizeFolderStateItems(existingItems);
  const incoming = normalizeFolderStateItems(incomingItems);
  for (const [folderId, chatIds] of Object.entries(incoming)) {
    out[folderId] = uniqStringList([...(out[folderId] || []), ...chatIds])
      .map((id) => normalizeChatId(id))
      .filter(Boolean);
  }
  return out;
}

function folderStateMetadataMergeStats(existingRaw, incomingRaw) {
  const existing = normalizeFolderStateData(existingRaw);
  const incoming = normalizeFolderStateData(incomingRaw);
  const existingById = new Map(existing.folders.map((folder) => [String(folder && folder.id || "").trim(), folder]));
  const stats = {
    incoming: incoming.folders.length,
    created: 0,
    refreshed: 0,
    skippedStale: 0,
    missingIncomingUpdatedAt: 0,
    missingExistingUpdatedAt: 0,
  };
  for (const folder of incoming.folders) {
    const id = String(folder && folder.id || "").trim();
    if (!id) continue;
    const prior = existingById.get(id);
    if (!prior) {
      stats.created += 1;
      continue;
    }
    const incomingMs = folderCatalogRowTimestampMs(folder);
    const existingMs = folderCatalogRowTimestampMs(prior);
    if (!incomingMs) stats.missingIncomingUpdatedAt += 1;
    if (incomingMs && !existingMs) stats.missingExistingUpdatedAt += 1;
    if (existingMs && (!incomingMs || incomingMs < existingMs)) stats.skippedStale += 1;
    else stats.refreshed += 1;
  }
  return stats;
}

function isNativeOwnedFolderStateRow(folder) {
  const source = String(folder && folder.source || "").trim().toLowerCase();
  const kind = String(folder && folder.kind || "").trim().toLowerCase();
  if (source === "native-folder-catalog") return true;
  if (source === "native-folder-state") return true;
  if (source === "native-broadcast") return true;
  if (source === "native-h2o-folder-state") return true;
  if (source.includes("native") && (source.includes("folder") || source.includes("catalog"))) return true;
  if (kind === "native-folder-catalog" || kind === "native-folder-state") return true;
  return false;
}

function mergeAuthoritativeNativeFolderState(existing, incoming, incomingRaw) {
  const source = String(incomingRaw && incomingRaw.source || "native-folder-catalog").trim() || "native-folder-catalog";
  const incomingFolders = incoming.folders.map((folder) => ({
    ...folder,
    source: String(folder && folder.source || source).trim() || source,
  }));
  const incomingIds = new Set(incomingFolders.map((folder) => String(folder && folder.id || "").trim()).filter(Boolean));
  const removedNativeFolderIds = [];
  let preservedLocalFolderCount = 0;
  const existingFolders = [];
  for (const folder of existing.folders) {
    const id = String(folder && folder.id || "").trim();
    if (!id) continue;
    if (incomingIds.has(id)) {
      existingFolders.push(folder);
      continue;
    }
    if (isNativeOwnedFolderStateRow(folder)) {
      removedNativeFolderIds.push(id);
      continue;
    }
    preservedLocalFolderCount += 1;
    existingFolders.push(folder);
  }
  const folders = mergeFolderCatalogLists(existingFolders, incomingFolders);
  const items = {};
  for (const folder of folders) {
    const id = String(folder && folder.id || "").trim();
    if (!id) continue;
    const sourceItems = incomingIds.has(id) ? incoming.items : existing.items;
    items[id] = normalizeFolderStateItems(sourceItems)[id] || [];
  }
  return {
    ...existing,
    ...incoming,
    schemaVersion: incoming.schemaVersion || existing.schemaVersion || 1,
    folders,
    items,
    updatedAt: nowIso(),
    __h2oMergeStats: {
      removedNativeFolderIds: removedNativeFolderIds.slice(0, 64),
      preservedLocalFolderCount,
    },
  };
}

function mergeFolderStateData(existingRaw, incomingRaw, modeRaw, opts = {}) {
  const mode = String(modeRaw || "merge").trim().toLowerCase() === "overwrite" ? "overwrite" : "merge";
  const existing = normalizeFolderStateData(existingRaw);
  const incoming = normalizeFolderStateData(incomingRaw);
  const hasAuthoritativeFolderList = !!(opts && opts.nativeFolderStateAuthoritative && incomingRaw && Array.isArray(incomingRaw.folders));
  if (!incoming.folders.length && !Object.keys(incoming.items || {}).length && !hasAuthoritativeFolderList) return existing;
  if (mode === "overwrite") {
    return {
      ...incoming,
      schemaVersion: incoming.schemaVersion || existing.schemaVersion || 1,
      updatedAt: nowIso(),
    };
  }
  if (opts && opts.nativeFolderStateAuthoritative) {
    return mergeAuthoritativeNativeFolderState(existing, incoming, incomingRaw);
  }
  return {
    ...existing,
    ...incoming,
    schemaVersion: incoming.schemaVersion || existing.schemaVersion || 1,
    folders: mergeFolderCatalogLists(existing.folders, incoming.folders),
    items: mergeFolderStateItems(existing.items, incoming.items),
    updatedAt: nowIso(),
  };
}

function stableJson(value) {
  try { return JSON.stringify(value); } catch { return ""; }
}

function checksumFolderState(value) {
  const text = stableJson(value || null);
  let hash = 5381;
  for (let i = 0; i < text.length; i += 1) hash = ((hash << 5) + hash) ^ text.charCodeAt(i);
  return "h2o-folder-" + ((hash >>> 0).toString(16));
}

function comparableFolderStateData(raw) {
  const next = normalizeFolderStateData(raw);
  delete next.updatedAt;
  delete next.exportedAt;
  return next;
}

function countFolderStateBindings(itemsRaw) {
  const items = normalizeFolderStateItems(itemsRaw);
  return Object.values(items).reduce((sum, rows) => sum + (Array.isArray(rows) ? rows.length : 0), 0);
}

function findFolderDuplicateNameDifferentIdCandidates(existingFoldersRaw, incomingFoldersRaw) {
  const byName = new Map();
  const add = (folder, source) => {
    const id = String(folder && folder.id || "").trim();
    const name = String(folder && (folder.name || folder.title || folder.label) || "").trim().toLowerCase();
    if (!id || !name) return;
    const row = byName.get(name) || {
      name: String(folder.name || folder.title || folder.label || name).trim(),
      ids: new Set(),
      sources: new Set(),
    };
    row.ids.add(id);
    row.sources.add(String(source || ""));
    byName.set(name, row);
  };
  normalizeFolderList(existingFoldersRaw).forEach((folder) => add(folder, "existing"));
  normalizeFolderList(incomingFoldersRaw).forEach((folder) => add(folder, "incoming"));
  return Array.from(byName.values())
    .filter((row) => row.ids.size > 1)
    .map((row) => ({
      name: String(row.name || ""),
      ids: Array.from(row.ids).slice(0, 8),
      sources: Array.from(row.sources).filter(Boolean),
    }));
}

async function writeChromeStorageLocalMerge(entries, modeRaw, opts = {}) {
  const mode = String(modeRaw || "merge").trim().toLowerCase() === "overwrite" ? "overwrite" : "merge";
  const obj = entries && typeof entries === "object" && !Array.isArray(entries) ? entries : {};
  const incomingKeys = Object.keys(obj);
  if (!incomingKeys.length) return { written: 0, skipped: 0 };

  // Whitelist enforcement on the import side too — never write a denylisted
  // key even if a hand-edited bundle tries to.
  const safeIncoming = {};
  for (const [k, v] of Object.entries(obj)) {
    if (isExportableStorageKey(k)) safeIncoming[k] = v;
  }
  const safeKeys = Object.keys(safeIncoming);
  if (!safeKeys.length) return { written: 0, skipped: incomingKeys.length };

  let existing = {};
  if (mode === "merge") {
    existing = await new Promise((resolve, reject) => {
      try {
        chrome.storage.local.get(safeKeys, (rows) => {
          const le = chrome.runtime.lastError;
          if (le) return reject(new Error(String(le.message || le)));
          resolve(rows || {});
        });
      } catch (e) { reject(e); }
    });
  }

  const writes = {};
  let written = 0;
  let skipped = incomingKeys.length - safeKeys.length;
  const folderStateMergeStats = {};
  for (const k of safeKeys) {
    if (k === FOLDER_STATE_DATA_KEY) {
      const merged = mergeFolderStateData(existing[k], safeIncoming[k], mode, opts);
      const nativeMergeStats = merged && typeof merged === "object" ? merged.__h2oMergeStats : null;
      const freshnessStats = folderStateMetadataMergeStats(existing[k], safeIncoming[k]);
      if (merged && typeof merged === "object") delete merged.__h2oMergeStats;
      if (mode === "merge" && stableJson(comparableFolderStateData(existing[k])) === stableJson(comparableFolderStateData(merged))) {
        folderStateMergeStats[k] = freshnessStats;
        skipped += 1;
        continue;
      }
      folderStateMergeStats[k] = nativeMergeStats && typeof nativeMergeStats === "object"
        ? { ...freshnessStats, ...nativeMergeStats }
        : freshnessStats;
      writes[k] = merged;
      written += 1;
      continue;
    }
    if (mode === "merge" && Object.prototype.hasOwnProperty.call(existing, k)) {
      skipped += 1;
      continue;
    }
    writes[k] = safeIncoming[k];
    written += 1;
  }
  if (written > 0) {
    await new Promise((resolve, reject) => {
      try {
        chrome.storage.local.set(writes, () => {
          const le = chrome.runtime.lastError;
          if (le) return reject(new Error(String(le.message || le)));
          resolve();
        });
      } catch (e) { reject(e); }
    });
  }
  return { written, skipped, folderStateMergeStats };
}

async function handleExternalStudioBroadcastMessage(msg, sender) {
  const senderId = String(sender && sender.id || "");
  if (senderId !== STUDIO_LAUNCHER_EXTENSION_ID) {
    return { ok: false, status: "sender-not-allowed", senderId };
  }
  const key = String(msg && msg.key || "");
  if (key !== STUDIO_BROADCAST_KEY) {
    return { ok: false, status: "invalid-broadcast-key", senderId, key };
  }
  const value = msg && msg.value && typeof msg.value === "object" && !Array.isArray(msg.value)
    ? msg.value
    : null;
  if (!value) {
    return { ok: false, status: "invalid-broadcast-value", senderId, key };
  }
  try {
    await storageSet({ [STUDIO_BROADCAST_KEY]: value });
    let directRelay = { ok: false, status: "not-attempted", sent: 0, errors: [] };
    try {
      directRelay = await forwardStudioBroadcastToChatTabs(value);
    } catch (e) {
      directRelay = { ok: false, status: "relay-error", sent: 0, errors: [String(e && (e.message || e))] };
    }
    const backgroundFallback = await backgroundFolderMetadataOperationFallback(value, directRelay);
    const fallbackResults = Array.isArray(backgroundFallback && backgroundFallback.results)
      ? backgroundFallback.results
      : [];
    if (fallbackResults.length) {
      const fallbackPreviewCount = fallbackResults.filter((result) => String(result && result.requestMode || "") === "preview").length;
      const fallbackApplyCount = fallbackResults.filter((result) => String(result && result.requestMode || "") === "apply").length;
      const fallbackRenameCount = fallbackResults.filter((result) => String(result && result.operationType || "") === "rename-folder").length;
      const fallbackColorCount = fallbackResults.filter((result) => String(result && result.operationType || "") === "change-folder-color").length;
      directRelay = {
        ...directRelay,
        ok: true,
        status: directRelay && directRelay.sent > 0 ? String(directRelay.status || "relayed") : String(backgroundFallback.status || "background-folder-metadata-fallback"),
        pageReceiverStatus: directRelay && directRelay.sent > 0 ? "listener-reached" : String(directRelay.pageReceiverStatus || "listener-absent"),
        receiverInstalled: !!(directRelay && directRelay.sent > 0),
        listenerReached: !!(directRelay && directRelay.sent > 0),
        resultCount: Number(directRelay && directRelay.resultCount || 0) + fallbackResults.length,
        fallbackPreviewStatus: fallbackPreviewCount ? "background-preview-fallback" : "",
        fallbackPreviewResultCount: fallbackPreviewCount,
        fallbackPreviewReason: fallbackPreviewCount ? "native-owner-page-receiver-unavailable" : "",
        applyFallbackStatus: fallbackApplyCount ? "background-apply-fallback" : "",
        applyResultCount: fallbackApplyCount,
        applyFallbackReason: fallbackApplyCount ? "native-owner-page-receiver-unavailable" : "",
        renameFallbackStatus: fallbackRenameCount ? "background-rename-fallback" : "",
        renameResultCount: fallbackRenameCount,
        renameFallbackReason: fallbackRenameCount ? "native-owner-page-receiver-unavailable" : "",
        colorFallbackStatus: fallbackColorCount ? "background-color-fallback" : "",
        colorResultCount: fallbackColorCount,
        colorFallbackReason: fallbackColorCount ? "native-owner-page-receiver-unavailable" : "",
        folderStateForwardStatus: String((fallbackResults.find((result) => String(result && result.requestMode || "") === "apply") || {}).folderStateForwardStatus || ""),
        folderStateForwardedToStudio: fallbackResults.some((result) => result && result.folderStateForwardedToStudio === true),
        errors: Array.isArray(directRelay && directRelay.errors)
          ? directRelay.errors.map(classifyDirectRelayError).filter(Boolean).slice(0, 8)
          : [],
        folderMetadataOperationResults: [
          ...(Array.isArray(directRelay && directRelay.folderMetadataOperationResults) ? directRelay.folderMetadataOperationResults : []),
          ...fallbackResults,
        ].slice(0, 16),
      };
    }
    const payload = value && value.payload && typeof value.payload === "object" ? value.payload : {};
    return {
      ok: true,
      status: "written",
      senderId,
      key: STUDIO_BROADCAST_KEY,
      payloadKeys: Object.keys(payload).slice(0, 16),
      directRelay,
      folderMetadataOperationResults: Array.isArray(directRelay && directRelay.folderMetadataOperationResults)
        ? directRelay.folderMetadataOperationResults.slice(0, 16)
        : [],
      snapshotPayloadRequestCount: Number(directRelay && directRelay.snapshotPayloadRequestCount || 0) || 0,
      snapshotPayloadResponseCount: Number(directRelay && directRelay.snapshotPayloadResponseCount || 0) || 0,
      snapshotPayloadForwardedCount: Number(directRelay && directRelay.snapshotPayloadForwardedCount || 0) || 0,
      ts: Date.now(),
    };
  } catch (e) {
    return {
      ok: false,
      status: "write-failed",
      senderId,
      key: STUDIO_BROADCAST_KEY,
      error: String((e && (e.stack || e.message || e)) || "write-failed"),
    };
  }
}

async function forwardStudioBroadcastToChatTabs(value) {
  if (!chrome.tabs || typeof chrome.tabs.query !== "function" || typeof chrome.tabs.sendMessage !== "function") {
    return { ok: false, status: "tabs-api-unavailable", sent: 0, errors: ["chrome.tabs unavailable"] };
  }
  const tabs = await new Promise((resolve, reject) => {
    try {
      chrome.tabs.query({ url: [CHAT_MATCH] }, (rows) => {
        const le = chrome.runtime.lastError;
        if (le) return reject(new Error(String(le.message || le)));
        resolve(Array.isArray(rows) ? rows : []);
      });
    } catch (e) { reject(e); }
  });
  const tabIds = tabs
    .map((tab) => Number(tab && tab.id))
    .filter((id) => Number.isFinite(id) && id > 0);
  if (!tabIds.length) return { ok: true, status: "no-chatgpt-tabs", sent: 0, errors: [] };

  let sent = 0;
  const errors = [];
  const folderMetadataOperationResults = [];
  let snapshotPayloadRequestCount = 0;
  let snapshotPayloadResponseCount = 0;
  let snapshotPayloadForwardedCount = 0;
  await Promise.all(tabIds.map((tabId) => new Promise((resolve) => {
    try {
      chrome.tabs.sendMessage(tabId, {
        type: MSG_STUDIO_BROADCAST,
        key: STUDIO_BROADCAST_KEY,
        value,
        source: "native-background-direct-relay",
        ts: Date.now(),
      }, (resp) => {
        const le = chrome.runtime.lastError;
        if (le) {
          errors.push(String(tabId) + ":" + String(le.message || le));
        } else if (resp && resp.ok !== false) {
          sent += 1;
          if (Array.isArray(resp.folderMetadataOperationResults)) {
            folderMetadataOperationResults.push(...resp.folderMetadataOperationResults);
          }
          snapshotPayloadRequestCount += Number(resp.snapshotPayloadRequestCount || 0) || 0;
          snapshotPayloadResponseCount += Number(resp.snapshotPayloadResponseCount || 0) || 0;
          snapshotPayloadForwardedCount += Number(resp.snapshotPayloadForwardedCount || 0) || 0;
        } else {
          errors.push(String(tabId) + ":" + String((resp && (resp.status || resp.error)) || "no-response"));
        }
        resolve();
      });
    } catch (e) {
      errors.push(String(tabId) + ":" + String(e && (e.message || e)));
      resolve();
    }
  })));
  return {
    ok: sent > 0,
    status: sent > 0 ? "relayed" : "not-relayed",
    sent,
    tabCount: tabIds.length,
    pageReceiverStatus: sent > 0 ? "listener-reached" : (tabIds.length ? "listener-absent" : "no-chatgpt-tabs"),
    receiverInstalled: sent > 0,
    listenerReached: sent > 0,
    resultCount: folderMetadataOperationResults.length,
    folderMetadataOperationResults: folderMetadataOperationResults.slice(0, 16),
    snapshotPayloadRequestCount,
    snapshotPayloadResponseCount,
    snapshotPayloadForwardedCount,
    errors: errors.slice(0, 8),
  };
}

function folderMetadataOperationRequestsFromStudioBroadcast(value) {
  const payload = value && typeof value === "object" ? value.payload : null;
  const requests = payload && payload.folderMetadataOperationRequests;
  if (Array.isArray(requests)) return requests.filter(Boolean).slice(0, 8);
  if (requests && typeof requests === "object") return [requests];
  return [];
}

function cleanFolderMetadataName(value) {
  return String(value || "").replace(/\\s+/g, " ").trim();
}

function folderMetadataNameKey(value) {
  return cleanFolderMetadataName(value).toLowerCase();
}

function isReservedFolderMetadataName(value) {
  const key = folderMetadataNameKey(value);
  return key === "all"
    || key === "saved"
    || key === "link"
    || key === "links"
    || key === "linked"
    || key === "archive"
    || key === "archived"
    || key === "recent"
    || key === "recents"
    || key === "unfiled";
}

const PROTECTED_CANONICAL_FOLDER_NAME_KEYS = new Set([
  "study",
  "case",
  "dev",
  "code",
  "tech",
  "english",
]);
const STUDIO_USER_FOLDER_ACTION_SOURCES = new Set([
  "studio-actions",
  "desktop-user-folder-create",
  "chrome-user-folder-create",
]);

function cleanFolderMetadataId(value) {
  return String(value || "").trim().replace(/[^a-zA-Z0-9_.:-]/g, "-").slice(0, 160);
}

function randomFolderMetadataIdToken() {
  try {
    if (self.crypto && typeof self.crypto.randomUUID === "function") {
      return String(self.crypto.randomUUID()).replace(/-/g, "").slice(0, 10);
    }
  } catch {}
  return Math.random().toString(36).slice(2, 12);
}

function makeChromeUserFolderId(name, existingIds) {
  const base = folderMetadataNameKey(name).replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "folder";
  const ids = existingIds instanceof Set ? existingIds : new Set();
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const id = "fold_chrome_" + base + "_" + Date.now().toString(36) + "_" + randomFolderMetadataIdToken();
    if (!ids.has(id)) return id;
  }
  return "fold_chrome_" + base + "_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 12);
}

function folderMetadataRowId(row) {
  return String(row && (row.id || row.folderId) || "").trim();
}

function folderMetadataRowName(row) {
  return cleanFolderMetadataName(row && (row.name || row.title || row.label || ""));
}

function folderMetadataRowMeta(row) {
  return row && row.meta && typeof row.meta === "object" && !Array.isArray(row.meta) ? row.meta : {};
}

function folderMetadataRowColor(row) {
  const meta = folderMetadataRowMeta(row);
  return normalizeHexColor(row && (row.iconColor || row.color || meta.iconColor || meta.color || ""));
}

function isBackgroundColorSafeFolder(row) {
  if (!row || typeof row !== "object") return false;
  const id = folderMetadataRowId(row);
  const nameKey = folderMetadataNameKey(folderMetadataRowName(row));
  if (!id || !nameKey || nameKey === "unfiled") return false;
  if (PROTECTED_CANONICAL_FOLDER_NAME_KEYS.has(nameKey)) return false;
  const meta = folderMetadataRowMeta(row);
  if (row.userCreated === true || meta.userCreated === true) return true;
  if (row.materializedUserFolder === true || meta.materializedUserFolder === true) return true;
  if (row.trustedFolderDisplay === true || meta.trustedFolderDisplay === true) return true;
  return [
    row.source,
    row.sourceKind,
    row.kind,
    meta.source,
    meta.sourceKind,
    meta.kind,
  ].map((value) => String(value || "").trim().toLowerCase()).some((source) => STUDIO_USER_FOLDER_ACTION_SOURCES.has(source));
}

function folderMetadataResultBase(request, code) {
  const req = request && typeof request === "object" ? request : {};
  const operation = req.operation && typeof req.operation === "object" ? req.operation : {};
  return {
    schema: FOLDER_METADATA_OPERATION_RESULT_SCHEMA,
    requestId: String(req.requestId || "").trim(),
    requestMode: String(req.requestMode || "").trim(),
    ok: false,
    applied: false,
    noMutation: true,
    readOnly: true,
    canApply: false,
    operationType: String(operation.operationType || "").trim(),
    folderId: String(operation.folderId || "").trim(),
    before: null,
    after: null,
    blockers: code ? [{ code: String(code) }] : [],
    warnings: [],
  };
}

async function createFolderMetadataOperationContextInBackground(request, expectedMode) {
  const req = request && typeof request === "object" ? request : {};
  const operation = req.operation && typeof req.operation === "object" ? req.operation : {};
  const result = folderMetadataResultBase(req, "");
  const mode = String(req.requestMode || "").trim();
  result.warnings = [{ code: "native-owner-page-receiver-unavailable" }];
  if (req.schema !== FOLDER_METADATA_OPERATION_REQUEST_SCHEMA) result.blockers.push({ code: "invalid-request-schema" });
  if (mode !== String(expectedMode || "").trim()) result.blockers.push({ code: "background-" + String(expectedMode || "unknown") + "-only" });
  if (operation.schema !== FOLDER_METADATA_OPERATION_SCHEMA) result.blockers.push({ code: "invalid-folder-metadata-operation" });
  if (String(operation.operationType || "").trim() !== "create-folder") result.blockers.push({ code: "background-" + String(expectedMode || "unknown") + "-unsupported-operation" });

  const after = operation.after && typeof operation.after === "object" ? operation.after : {};
  const nextName = cleanFolderMetadataName(after.name || after.title || operation.name || operation.title);
  const requestedId = cleanFolderMetadataId(operation.folderId || after.folderId || after.id || operation.id || "");
  const rows = await storageGet([FOLDER_STATE_DATA_KEY]);
  const data = normalizeFolderStateData(rows && rows[FOLDER_STATE_DATA_KEY]);
  const sourceHash = checksumFolderState({ folders: data.folders, items: data.items });
  const staleGuard = operation.staleGuard && typeof operation.staleGuard === "object" && !Array.isArray(operation.staleGuard)
    ? operation.staleGuard
    : {};

  if (!nextName) result.blockers.push({ code: "invalid-folder-name" });
  if (nextName && isReservedFolderMetadataName(nextName)) result.blockers.push({ code: "reserved-folder-name" });
  const nextKey = folderMetadataNameKey(nextName);
  if (nextKey && PROTECTED_CANONICAL_FOLDER_NAME_KEYS.has(nextKey)) {
    result.blockers.push({ code: "protected-canonical-folder-name" });
  }
  if (nextKey && data.folders.some((folder) => folderMetadataNameKey(folder && (folder.name || folder.title)) === nextKey)) {
    result.blockers.push({ code: "same-name-conflict" });
  }
  if (requestedId && data.folders.some((folder) => String(folder && folder.id || "").trim() === requestedId)) {
    result.blockers.push({ code: "folder-id-conflict" });
  }
  if (expectedMode === "apply") {
    const guardSourceHash = String(staleGuard.sourceHash || "").trim();
    if (!guardSourceHash) {
      result.blockers.push({ code: "stale-guard-required" });
    } else if (guardSourceHash !== sourceHash) {
      result.blockers.push({ code: "stale-source-hash" });
    }
  }

  result.folderId = requestedId;
  result.before = {
    sourceHash,
    folderCount: data.folders.length,
    membershipCount: 0,
    previewHash: checksumFolderState({ operationType: "create-folder", name: nextName, sourceHash }),
  };
  result.after = {
    id: requestedId || "",
    folderId: requestedId || "",
    proposedFolderId: requestedId || null,
    name: nextName,
    membershipCount: 0,
    sourceHash,
  };
  result.staleGuard = {
    sourceHash,
    previewHash: result.before.previewHash,
  };
  return { req, operation, result, data, nextName, requestedId, sourceHash };
}

async function renameFolderMetadataOperationContextInBackground(request, expectedMode) {
  const req = request && typeof request === "object" ? request : {};
  const operation = req.operation && typeof req.operation === "object" ? req.operation : {};
  const result = folderMetadataResultBase(req, "");
  const mode = String(req.requestMode || "").trim();
  result.warnings = [{ code: "native-owner-page-receiver-unavailable" }];
  if (req.schema !== FOLDER_METADATA_OPERATION_REQUEST_SCHEMA) result.blockers.push({ code: "invalid-request-schema" });
  if (mode !== String(expectedMode || "").trim()) result.blockers.push({ code: "background-" + String(expectedMode || "unknown") + "-only" });
  if (operation.schema !== FOLDER_METADATA_OPERATION_SCHEMA) result.blockers.push({ code: "invalid-folder-metadata-operation" });
  if (String(operation.operationType || "").trim() !== "rename-folder") result.blockers.push({ code: "background-" + String(expectedMode || "unknown") + "-unsupported-operation" });

  const folderId = cleanFolderMetadataId(operation.folderId || operation.id || "");
  const after = operation.after && typeof operation.after === "object" ? operation.after : {};
  const nextName = cleanFolderMetadataName(after.name || after.title || operation.name || operation.title);
  const rows = await storageGet([FOLDER_STATE_DATA_KEY]);
  const data = normalizeFolderStateData(rows && rows[FOLDER_STATE_DATA_KEY]);
  const sourceHash = checksumFolderState({ folders: data.folders, items: data.items });
  const targetFolder = data.folders.find((folder) => folderMetadataRowId(folder) === folderId) || null;
  const previousName = folderMetadataRowName(targetFolder);
  const staleGuard = operation.staleGuard && typeof operation.staleGuard === "object" && !Array.isArray(operation.staleGuard)
    ? operation.staleGuard
    : {};

  if (!folderId) result.blockers.push({ code: "folder-id-required" });
  if (folderId && !targetFolder) result.blockers.push({ code: "folder-not-found" });
  if (!nextName) result.blockers.push({ code: "invalid-folder-name" });
  if (nextName && isReservedFolderMetadataName(nextName)) result.blockers.push({ code: "reserved-folder-name" });
  const nextKey = folderMetadataNameKey(nextName);
  if (nextKey && PROTECTED_CANONICAL_FOLDER_NAME_KEYS.has(nextKey)) {
    result.blockers.push({ code: "protected-canonical-folder-name" });
  }
  if (nextKey && data.folders.some((folder) => folderMetadataRowId(folder) !== folderId && folderMetadataNameKey(folderMetadataRowName(folder)) === nextKey)) {
    result.blockers.push({ code: "same-name-conflict" });
  }

  const previewHash = checksumFolderState({
    operationType: "rename-folder",
    folderId,
    beforeName: previousName,
    name: nextName,
    sourceHash,
  });
  if (expectedMode === "apply") {
    const guardSourceHash = String(staleGuard.sourceHash || "").trim();
    const guardPreviewHash = String(staleGuard.previewHash || "").trim();
    if (!guardSourceHash || !guardPreviewHash) {
      result.blockers.push({ code: "stale-guard-required" });
    } else {
      if (guardSourceHash !== sourceHash) result.blockers.push({ code: "stale-source-hash" });
      if (guardPreviewHash !== previewHash) result.blockers.push({ code: "stale-preview-hash" });
    }
  }

  result.folderId = folderId;
  result.before = {
    id: folderId,
    folderId,
    name: previousName,
    sourceHash,
    folderCount: data.folders.length,
    membershipCount: Array.isArray(data.items && data.items[folderId]) ? data.items[folderId].length : 0,
    previewHash,
  };
  result.after = {
    id: folderId,
    folderId,
    name: nextName,
    sourceHash,
  };
  result.staleGuard = {
    sourceHash,
    previewHash,
  };
  return { req, operation, result, data, folderId, targetFolder, previousName, nextName, sourceHash, previewHash };
}

async function colorFolderMetadataOperationContextInBackground(request, expectedMode) {
  const req = request && typeof request === "object" ? request : {};
  const operation = req.operation && typeof req.operation === "object" ? req.operation : {};
  const result = folderMetadataResultBase(req, "");
  const mode = String(req.requestMode || "").trim();
  result.warnings = [{ code: "native-owner-page-receiver-unavailable" }];
  if (req.schema !== FOLDER_METADATA_OPERATION_REQUEST_SCHEMA) result.blockers.push({ code: "invalid-request-schema" });
  if (mode !== String(expectedMode || "").trim()) result.blockers.push({ code: "background-" + String(expectedMode || "unknown") + "-only" });
  if (operation.schema !== FOLDER_METADATA_OPERATION_SCHEMA) result.blockers.push({ code: "invalid-folder-metadata-operation" });
  if (String(operation.operationType || "").trim() !== "change-folder-color") result.blockers.push({ code: "background-" + String(expectedMode || "unknown") + "-unsupported-operation" });

  const folderId = cleanFolderMetadataId(operation.folderId || operation.id || "");
  const after = operation.after && typeof operation.after === "object" ? operation.after : {};
  const nextColor = normalizeHexColor(after.color || after.iconColor || operation.color || operation.iconColor || "");
  const rows = await storageGet([FOLDER_STATE_DATA_KEY]);
  const data = normalizeFolderStateData(rows && rows[FOLDER_STATE_DATA_KEY]);
  const sourceHash = checksumFolderState({ folders: data.folders, items: data.items });
  const targetFolder = data.folders.find((folder) => folderMetadataRowId(folder) === folderId) || null;
  const previousColor = folderMetadataRowColor(targetFolder);
  const staleGuard = operation.staleGuard && typeof operation.staleGuard === "object" && !Array.isArray(operation.staleGuard)
    ? operation.staleGuard
    : {};

  if (!folderId) result.blockers.push({ code: "folder-id-required" });
  if (folderId && !targetFolder) result.blockers.push({ code: "folder-not-found" });
  if (targetFolder && !isBackgroundColorSafeFolder(targetFolder)) result.blockers.push({ code: "folder-color-not-allowed" });
  if (!nextColor) result.blockers.push({ code: "invalid-folder-color" });

  const previewHash = checksumFolderState({
    operationType: "change-folder-color",
    folderId,
    beforeColor: previousColor,
    color: nextColor,
    sourceHash,
  });
  if (expectedMode === "apply") {
    const guardSourceHash = String(staleGuard.sourceHash || "").trim();
    const guardPreviewHash = String(staleGuard.previewHash || "").trim();
    if (!guardSourceHash || !guardPreviewHash) {
      result.blockers.push({ code: "stale-guard-required" });
    } else {
      if (guardSourceHash !== sourceHash) result.blockers.push({ code: "stale-source-hash" });
      if (guardPreviewHash !== previewHash) result.blockers.push({ code: "stale-preview-hash" });
    }
  }

  result.folderId = folderId;
  result.before = {
    id: folderId,
    folderId,
    color: previousColor,
    iconColor: previousColor,
    sourceHash,
    folderCount: data.folders.length,
    membershipCount: Array.isArray(data.items && data.items[folderId]) ? data.items[folderId].length : 0,
    previewHash,
  };
  result.after = {
    id: folderId,
    folderId,
    color: nextColor,
    iconColor: nextColor,
    sourceHash,
  };
  result.staleGuard = {
    sourceHash,
    previewHash,
  };
  return { req, operation, result, data, folderId, targetFolder, previousColor, nextColor, sourceHash, previewHash };
}

async function previewCreateFolderMetadataOperationInBackground(request) {
  const ctx = await createFolderMetadataOperationContextInBackground(request, "preview");
  const result = ctx.result;
  result.previewSource = "native-owner-background-storage-fallback";
  result.proposed = {
    create: true,
    folderName: ctx.nextName,
    requestedFolderId: ctx.requestedId || null,
    createEmptyItemBucket: true,
    membershipCount: 0,
  };
  result.ok = result.blockers.length === 0;
  result.canApply = result.ok;
  return result;
}

async function previewRenameFolderMetadataOperationInBackground(request) {
  const ctx = await renameFolderMetadataOperationContextInBackground(request, "preview");
  const result = ctx.result;
  result.previewSource = "native-owner-background-storage-fallback";
  result.proposed = {
    rename: true,
    folderId: ctx.folderId,
    beforeName: ctx.previousName,
    afterName: ctx.nextName,
    membershipCount: Array.isArray(ctx.data.items && ctx.data.items[ctx.folderId]) ? ctx.data.items[ctx.folderId].length : 0,
  };
  result.ok = result.blockers.length === 0;
  result.canApply = result.ok;
  return result;
}

async function previewColorFolderMetadataOperationInBackground(request) {
  const ctx = await colorFolderMetadataOperationContextInBackground(request, "preview");
  const result = ctx.result;
  result.previewSource = "native-owner-background-storage-fallback";
  result.colorSource = "native-owner-background-storage-fallback";
  result.proposed = {
    color: true,
    folderId: ctx.folderId,
    beforeColor: ctx.previousColor,
    afterColor: ctx.nextColor,
    membershipCount: Array.isArray(ctx.data.items && ctx.data.items[ctx.folderId]) ? ctx.data.items[ctx.folderId].length : 0,
  };
  result.ok = result.blockers.length === 0;
  result.canApply = result.ok;
  return result;
}

function makeChromeUserCreatedFolderRow(name, folderId, now) {
  const source = "chrome-user-folder-create";
  return {
    id: folderId,
    folderId,
    name,
    kind: "local",
    source,
    sourceKind: source,
    sourceSurface: "chrome-studio",
    userCreated: true,
    materializedUserFolder: true,
    trustedFolderDisplay: true,
    shownInNormalMode: true,
    parentId: "",
    sortOrder: 0,
    createdAt: now,
    updatedAt: now,
    meta: {
      source,
      sourceKind: source,
      sourceSurface: "chrome-studio",
      userCreated: true,
      materializedUserFolder: true,
      trustedFolderDisplay: true,
      shownInNormalMode: true,
      createdBy: "chrome-studio",
      updatedAt: now,
    },
  };
}

async function forwardBackgroundFolderStateToStudioLauncher(folderState, sourceLabel) {
  if (!chrome.runtime || typeof chrome.runtime.sendMessage !== "function") {
    return { ok: false, status: "chrome-runtime-sendMessage-unavailable" };
  }
  const ownId = String(chrome.runtime.id || "");
  if (!STUDIO_LAUNCHER_EXTENSION_ID || ownId === STUDIO_LAUNCHER_EXTENSION_ID) {
    return { ok: false, status: "studio-launcher-target-unavailable" };
  }
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(STUDIO_LAUNCHER_EXTENSION_ID, {
        type: MSG_NATIVE_FOLDER_STATE,
        key: FOLDER_STATE_DATA_KEY,
        source: "native-owner-background-folder-metadata-apply-fallback",
        sourceExtensionId: ownId,
        sourceLabel: String(sourceLabel || "folder-create-apply-background-fallback"),
        ts: Date.now(),
        folderState,
      }, (resp) => {
        const le = chrome.runtime && chrome.runtime.lastError;
        if (le) {
          resolve({ ok: false, status: "send-failed", error: classifyDirectRelayError(String(le.message || le)) });
          return;
        }
        resolve(resp && typeof resp === "object" ? {
          ok: resp.ok !== false,
          status: String(resp.status || (resp.ok === false ? "failed" : "ok")),
          mergedFolderCount: Number(resp.mergedFolderCount || resp.afterFolderCount || 0) || 0,
          colorPreservedName: resp.colorPreservedName === true,
          colorSourceRowName: String(resp.colorSourceRowName || ""),
          colorLatestRowName: String(resp.colorLatestRowName || ""),
          staleIncomingNameIgnored: resp.staleIncomingNameIgnored === true,
        } : { ok: false, status: "no-response" });
      });
    } catch (e) {
      resolve({ ok: false, status: "send-threw", error: String(e && (e.message || e) || "send-threw").slice(0, 160) });
    }
  });
}

async function writeBackgroundFolderStateAndForward(nextState, result, reason) {
  await storageSet({
    [FOLDER_STATE_DATA_KEY]: nextState,
    [NATIVE_BROADCAST_KEY]: {
      ts: Date.now(),
      surface: "native",
      source: String(nextState && nextState.source || "native-owner-background-folder-metadata-apply-fallback"),
      sourceExtensionId: String(chrome.runtime && chrome.runtime.id || ""),
      reasons: [String(reason || "folder-metadata-apply-background-fallback")],
      folderState: nextState,
      folderMetadataOperationResults: [result],
    },
  });
  const forward = await forwardBackgroundFolderStateToStudioLauncher(nextState, reason);
  result.folderStateForwardedToStudio = forward.ok === true;
  result.folderStateForwardStatus = String(forward.status || "");
  if (forward.colorPreservedName === true) result.colorPreservedName = true;
  if (forward.colorSourceRowName) result.colorSourceRowName = forward.colorSourceRowName;
  if (forward.colorLatestRowName) result.colorLatestRowName = forward.colorLatestRowName;
  if (forward.staleIncomingNameIgnored === true) result.staleIncomingNameIgnored = true;
  if (!forward.ok) {
    result.warnings.push({ code: "studio-folder-state-forward-failed", status: String(forward.status || "failed") });
  }
  return result;
}

async function applyCreateFolderMetadataOperationInBackground(request) {
  const ctx = await createFolderMetadataOperationContextInBackground(request, "apply");
  const result = ctx.result;
  result.applySource = "native-owner-background-storage-fallback";
  result.readOnly = false;
  result.noMutation = true;
  if (result.blockers.length) {
    result.ok = false;
    result.readOnly = true;
    result.noMutation = true;
    return result;
  }
  const now = nowIso();
  const existingIds = new Set(ctx.data.folders.map((folder) => String(folder && folder.id || "").trim()).filter(Boolean));
  const folderId = ctx.requestedId || makeChromeUserFolderId(ctx.nextName, existingIds);
  const folder = makeChromeUserCreatedFolderRow(ctx.nextName, folderId, now);
  const folders = mergeFolderCatalogLists(ctx.data.folders, [folder]);
  const items = normalizeFolderStateItems(ctx.data.items);
  if (!Array.isArray(items[folderId])) items[folderId] = [];
  const nextState = {
    ...ctx.data,
    schemaVersion: ctx.data.schemaVersion || 1,
    source: "native-owner-background-folder-metadata-apply-fallback",
    sourceKind: "chrome-user-folder-create",
    sourceSurface: "chrome-studio",
    folders,
    items,
    updatedAt: now,
  };
  nextState.checksum = checksumFolderState({ folders: nextState.folders, items: nextState.items });
  result.folderId = folderId;
  result.after = {
    ...folder,
    sourceHash: checksumFolderState({ folders, items }),
  };
  result.applied = true;
  result.noMutation = false;
  result.readOnly = false;
  result.ok = true;
  result.canApply = false;
  result.writesPerformed = 1;
  return writeBackgroundFolderStateAndForward(nextState, result, "folder-create-apply-background-fallback");
}

async function applyRenameFolderMetadataOperationInBackground(request) {
  const ctx = await renameFolderMetadataOperationContextInBackground(request, "apply");
  const result = ctx.result;
  result.applySource = "native-owner-background-storage-fallback";
  result.renameSource = "native-owner-background-storage-fallback";
  result.readOnly = false;
  result.noMutation = true;
  if (result.blockers.length) {
    result.ok = false;
    result.readOnly = true;
    result.noMutation = true;
    return result;
  }
  const now = nowIso();
  const targetMeta = ctx.targetFolder && ctx.targetFolder.meta && typeof ctx.targetFolder.meta === "object" && !Array.isArray(ctx.targetFolder.meta)
    ? ctx.targetFolder.meta
    : {};
  const updatedFolder = normalizeFolderEntry({
    ...ctx.targetFolder,
    name: ctx.nextName,
    title: ctx.nextName,
    updatedAt: now,
    meta: {
      ...targetMeta,
      updatedAt: now,
    },
  });
  const folders = ctx.data.folders.map((folder) => (
    folderMetadataRowId(folder) === ctx.folderId ? updatedFolder : folder
  )).filter(Boolean);
  const items = normalizeFolderStateItems(ctx.data.items);
  const nextState = {
    ...ctx.data,
    schemaVersion: ctx.data.schemaVersion || 1,
    source: "native-owner-background-folder-metadata-rename-fallback",
    sourceKind: String(updatedFolder.sourceKind || updatedFolder.kind || ctx.targetFolder.sourceKind || ctx.targetFolder.kind || ctx.targetFolder.source || "chrome-user-folder-create"),
    sourceSurface: "chrome-studio",
    folders,
    items,
    updatedAt: now,
  };
  nextState.checksum = checksumFolderState({ folders: nextState.folders, items: nextState.items });
  result.folderId = ctx.folderId;
  result.before = {
    ...result.before,
    name: ctx.previousName,
  };
  result.after = {
    ...updatedFolder,
    sourceHash: checksumFolderState({ folders, items }),
  };
  result.applied = true;
  result.noMutation = false;
  result.readOnly = false;
  result.ok = true;
  result.canApply = false;
  result.writesPerformed = 1;
  return writeBackgroundFolderStateAndForward(nextState, result, "folder-rename-apply-background-fallback");
}

async function applyColorFolderMetadataOperationInBackground(request) {
  const ctx = await colorFolderMetadataOperationContextInBackground(request, "apply");
  const result = ctx.result;
  result.applySource = "native-owner-background-storage-fallback";
  result.colorSource = "native-owner-background-storage-fallback";
  result.readOnly = false;
  result.noMutation = true;
  if (result.blockers.length) {
    result.ok = false;
    result.readOnly = true;
    result.noMutation = true;
    return result;
  }
  const now = nowIso();
  const targetMeta = ctx.targetFolder && ctx.targetFolder.meta && typeof ctx.targetFolder.meta === "object" && !Array.isArray(ctx.targetFolder.meta)
    ? ctx.targetFolder.meta
    : {};
  const updatedFolder = normalizeFolderEntry({
    ...ctx.targetFolder,
    color: ctx.nextColor,
    iconColor: ctx.nextColor,
    folderMetadataPatchType: "change-folder-color",
    updatedAt: now,
    meta: {
      ...targetMeta,
      color: ctx.nextColor,
      iconColor: ctx.nextColor,
      folderMetadataPatchType: "change-folder-color",
      updatedAt: now,
    },
  });
  updatedFolder.folderMetadataPatchType = "change-folder-color";
  updatedFolder.meta = {
    ...(updatedFolder.meta || {}),
    folderMetadataPatchType: "change-folder-color",
  };
  const folders = ctx.data.folders.map((folder) => (
    folderMetadataRowId(folder) === ctx.folderId ? updatedFolder : folder
  )).filter(Boolean);
  const items = normalizeFolderStateItems(ctx.data.items);
  const nextState = {
    ...ctx.data,
    schemaVersion: ctx.data.schemaVersion || 1,
    source: "native-owner-background-folder-metadata-color-fallback",
    sourceKind: String(updatedFolder.sourceKind || updatedFolder.kind || ctx.targetFolder.sourceKind || ctx.targetFolder.kind || ctx.targetFolder.source || "chrome-user-folder-create"),
    sourceSurface: "chrome-studio",
    folders,
    items,
    updatedAt: now,
  };
  nextState.checksum = checksumFolderState({ folders: nextState.folders, items: nextState.items });
  const color = folderMetadataRowColor(updatedFolder) || ctx.nextColor;
  result.folderId = ctx.folderId;
  result.before = {
    ...result.before,
    color: ctx.previousColor,
    iconColor: ctx.previousColor,
  };
  result.after = {
    ...updatedFolder,
    color,
    iconColor: color,
    sourceHash: checksumFolderState({ folders, items }),
  };
  result.colorPreservedName = false;
  result.colorSourceRowName = String(ctx.targetFolder && ctx.targetFolder.name || "");
  result.colorLatestRowName = String(ctx.targetFolder && ctx.targetFolder.name || "");
  result.applied = true;
  result.noMutation = false;
  result.readOnly = false;
  result.ok = true;
  result.canApply = false;
  result.writesPerformed = 1;
  return writeBackgroundFolderStateAndForward(nextState, result, "folder-color-apply-background-fallback");
}

function classifyDirectRelayError(error) {
  const text = String(error || "");
  if (/Receiving end does not exist|Could not establish connection/i.test(text)) return "native-owner-page-receiver-unavailable";
  if (/Extension context invalidated|context invalidated/i.test(text)) return "native-owner-page-context-invalidated";
  return text.replace(new RegExp("chrome-extension://[a-z]+", "gi"), "chrome-extension://<redacted>").slice(0, 160);
}

async function backgroundFolderMetadataOperationFallback(value, directRelay) {
  const requests = folderMetadataOperationRequestsFromStudioBroadcast(value);
  if (!requests.length) return { results: [], status: "no-folder-metadata-requests" };
  const directResults = Array.isArray(directRelay && directRelay.folderMetadataOperationResults)
    ? directRelay.folderMetadataOperationResults
    : [];
  const handled = new Set(directResults.map((result) => String(result && result.requestId || "").trim()).filter(Boolean));
  const results = [];
  for (const request of requests) {
    const requestId = String(request && request.requestId || "").trim();
    if (!requestId || handled.has(requestId)) continue;
    const mode = String(request && request.requestMode || "").trim();
    const operationType = String(request && request.operation && request.operation.operationType || "").trim();
    if ((mode !== "preview" && mode !== "apply") || (operationType !== "create-folder" && operationType !== "rename-folder" && operationType !== "change-folder-color")) continue;
    try {
      if (operationType === "rename-folder") {
        results.push(mode === "apply"
          ? await applyRenameFolderMetadataOperationInBackground(request)
          : await previewRenameFolderMetadataOperationInBackground(request));
      } else if (operationType === "change-folder-color") {
        results.push(mode === "apply"
          ? await applyColorFolderMetadataOperationInBackground(request)
          : await previewColorFolderMetadataOperationInBackground(request));
      } else {
        results.push(mode === "apply"
          ? await applyCreateFolderMetadataOperationInBackground(request)
          : await previewCreateFolderMetadataOperationInBackground(request));
      }
    } catch (e) {
      const failed = folderMetadataResultBase(request, mode === "apply" ? "native-owner-background-apply-error" : "native-owner-background-preview-error");
      failed.error = String(e && (e.message || e) || "native-owner-background-folder-metadata-error").slice(0, 160);
      results.push(failed);
    }
  }
  const previewCount = results.filter((result) => String(result && result.requestMode || "") === "preview").length;
  const applyCount = results.filter((result) => String(result && result.requestMode || "") === "apply").length;
  const renameCount = results.filter((result) => String(result && result.operationType || "") === "rename-folder").length;
  const colorCount = results.filter((result) => String(result && result.operationType || "") === "change-folder-color").length;
  return {
    results,
    status: colorCount ? "background-color-fallback" : (renameCount ? "background-rename-fallback" : (applyCount ? "background-apply-fallback" : (previewCount ? "background-preview-fallback" : "unsupported-background-folder-metadata-fallback"))),
    previewCount,
    applyCount,
    renameCount,
    colorCount,
  };
}

async function handleExternalNativeFolderStateMessage(msg, sender) {
  const senderId = String(sender && sender.id || "");
  if (!senderId || !NATIVE_FOLDER_STATE_EXTERNAL_SENDER_IDS.has(senderId)) {
    return { ok: false, status: "sender-not-allowed", senderId };
  }
  const folderState = msg && msg.folderState && typeof msg.folderState === "object" ? msg.folderState : null;
  if (!folderState || !Array.isArray(folderState.folders)) {
    return { ok: false, status: "invalid-folder-state", senderId };
  }
  const before = await storageGet([FOLDER_STATE_DATA_KEY]);
  const beforeState = normalizeFolderStateData(before && before[FOLDER_STATE_DATA_KEY]);
  const result = await writeChromeStorageLocalMerge({ [FOLDER_STATE_DATA_KEY]: folderState }, "merge", {
    nativeFolderStateAuthoritative: true,
  });
  const after = await storageGet([FOLDER_STATE_DATA_KEY]);
  const afterState = normalizeFolderStateData(after && after[FOLDER_STATE_DATA_KEY]);
  const incomingState = normalizeFolderStateData(folderState);
  const status = result.written > 0 ? "merged" : "unchanged";
  const mergeStats = result.folderStateMergeStats && result.folderStateMergeStats[FOLDER_STATE_DATA_KEY]
    ? result.folderStateMergeStats[FOLDER_STATE_DATA_KEY]
    : {};
  const removedNativeFolderIds = Array.isArray(mergeStats.removedNativeFolderIds)
    ? mergeStats.removedNativeFolderIds.map((id) => String(id || "").trim()).filter(Boolean).slice(0, 16)
    : [];
  const duplicateNameDifferentIdSample = findFolderDuplicateNameDifferentIdCandidates(beforeState.folders, incomingState.folders).slice(0, 8);
  const incomingChecksum = String(folderState.checksum || checksumFolderState({ folders: incomingState.folders, items: incomingState.items }));
  const mergedChecksum = checksumFolderState({ folders: afterState.folders, items: afterState.items });
  const beforeById = new Map(beforeState.folders.map((folder) => [String(folder && folder.id || "").trim(), folder]));
  const afterById = new Map(afterState.folders.map((folder) => [String(folder && folder.id || "").trim(), folder]));
  const colorPatchDiagnostics = incomingState.folders
    .filter((folder) => isFolderMetadataColorOnlyPatch(folder))
    .map((folder) => {
      const id = String(folder && folder.id || "").trim();
      const beforeFolder = beforeById.get(id) || null;
      const afterFolder = afterById.get(id) || null;
      const incomingName = String(folder && folder.name || "").trim();
      const beforeName = String(beforeFolder && beforeFolder.name || "").trim();
      const afterName = String(afterFolder && afterFolder.name || "").trim();
      return {
        id,
        incomingName,
        beforeName,
        afterName,
        preservedName: !!afterName && (!beforeName || afterName === beforeName),
        staleIncomingNameIgnored: !!(incomingName && afterName && incomingName !== afterName),
      };
    })
    .filter((entry) => entry.id)
    .slice(0, 8);
  const firstColorPatch = colorPatchDiagnostics[0] || null;
  const diagnostic = {
    key: FOLDER_STATE_DATA_KEY,
    diagnosticKey: NATIVE_FOLDER_STATE_EXTERNAL_MERGE_DIAG_KEY,
    at: Date.now(),
    status,
    error: "",
    senderId,
    source: String(msg.source || "native-content-bridge"),
    sourceExtensionId: String(msg.sourceExtensionId || senderId),
    sourceLabel: String(msg.sourceLabel || ""),
    incomingChecksum,
    beforeChecksum: checksumFolderState({ folders: beforeState.folders, items: beforeState.items }),
    mergedChecksum,
    incomingFolderCount: incomingState.folders.length,
    incomingBindingCount: countFolderStateBindings(incomingState.items),
    beforeFolderCount: beforeState.folders.length,
    beforeBindingCount: countFolderStateBindings(beforeState.items),
    mergedFolderCount: afterState.folders.length,
    mergedBindingCount: countFolderStateBindings(afterState.items),
    removedNativeFolderCount: removedNativeFolderIds.length,
    removedNativeFolderIds,
    preservedLocalFolderCount: Number(mergeStats.preservedLocalFolderCount || 0),
    written: result.written,
    skipped: result.skipped,
    duplicateNameDifferentIdCount: duplicateNameDifferentIdSample.length,
    duplicateNameDifferentIdSample,
    colorPatchDiagnostics,
    colorPreservedName: !!(firstColorPatch && firstColorPatch.preservedName),
    colorSourceRowName: firstColorPatch ? firstColorPatch.incomingName : "",
    colorLatestRowName: firstColorPatch ? firstColorPatch.afterName : "",
    staleIncomingNameIgnored: !!(firstColorPatch && firstColorPatch.staleIncomingNameIgnored),
    caseArrived: incomingState.folders.some((folder) => String(folder && folder.name || "").trim().toLowerCase() === "case"),
    emptyFolderCount: afterState.folders.filter((folder) => {
      const id = String(folder && folder.id || "").trim();
      return id && !(Array.isArray(afterState.items[id]) && afterState.items[id].length);
    }).length,
  };
  try {
    await storageSet({ [NATIVE_FOLDER_STATE_EXTERNAL_MERGE_DIAG_KEY]: diagnostic });
  } catch (e) {
    diagnostic.diagnosticWriteError = String(e && (e.message || e) || "diagnostic-write-failed");
  }
  return {
    ok: true,
    status,
    senderId,
    key: FOLDER_STATE_DATA_KEY,
    incomingFolderCount: incomingState.folders.length,
    incomingBindingCount: diagnostic.incomingBindingCount,
    beforeFolderCount: beforeState.folders.length,
    afterFolderCount: afterState.folders.length,
    mergedFolderCount: diagnostic.mergedFolderCount,
    mergedBindingCount: diagnostic.mergedBindingCount,
    removedNativeFolderCount: diagnostic.removedNativeFolderCount,
    removedNativeFolderIds: diagnostic.removedNativeFolderIds,
    preservedLocalFolderCount: diagnostic.preservedLocalFolderCount,
    incomingChecksum,
    mergedChecksum,
    caseArrived: diagnostic.caseArrived,
    colorPreservedName: diagnostic.colorPreservedName,
    colorSourceRowName: diagnostic.colorSourceRowName,
    colorLatestRowName: diagnostic.colorLatestRowName,
    staleIncomingNameIgnored: diagnostic.staleIncomingNameIgnored,
    written: result.written,
    skipped: result.skipped,
    source: String(msg.source || "native-content-bridge"),
    sourceExtensionId: String(msg.sourceExtensionId || senderId),
    diagnosticKey: NATIVE_FOLDER_STATE_EXTERNAL_MERGE_DIAG_KEY,
    diagnosticWriteError: diagnostic.diagnosticWriteError || "",
  };
}

/* Phase K-2.6 — receiver for cross-extension linked-records messages
 * forwarded by the prod Cockpit Pro content-script (chrome-live-loader's
 * forwardNativeLinkedRecordsToStudioLauncher). Merges msg.linkedRecords
 * into Studio Launcher's own NATIVE_BROADCAST_KEY value (chrome.storage
 * is per-extension; the prod-side key is never directly readable here).
 * S0F1h's chrome.storage.onChanged listener then fires, dispatches
 * evt:h2o:library:cross-surface-sync, and K-2.5's S0F1c listener
 * re-runs refreshFromArchive — which pulls the merged linkedRecords
 * via readNativeChatRegistryRecords() and populates the LibraryIndex.
 *
 * Sender allowlist reuses NATIVE_FOLDER_STATE_EXTERNAL_SENDER_IDS so
 * only the prod Cockpit Pro extension can write into the Studio
 * Launcher's namespace.
 *
 * Merge strategy: spread { ...prev } then overlay linkedRecords / ts /
 * surface / source fields. This preserves the folder-state subtree if
 * a future forward writes one (today folder-state lives at a separate
 * FOLDER_STATE_DATA_KEY, but the merge is forward-compat). Empty
 * arrays are accepted and propagated (D2) so unlink removals surface
 * in Studio. No diagnostic key written this phase (D3). */
async function handleExternalNativeLinkedRecordsMessage(msg, sender) {
  const senderId = String(sender && sender.id || "");
  if (!senderId || !NATIVE_FOLDER_STATE_EXTERNAL_SENDER_IDS.has(senderId)) {
    return { ok: false, status: "sender-not-allowed", senderId };
  }
  const linkedRecords = msg && Array.isArray(msg.linkedRecords) ? msg.linkedRecords : null;
  if (linkedRecords === null) {
    return { ok: false, status: "invalid-linked-records", senderId };
  }
  const source = String((msg && msg.source) || "native-content-bridge");
  const sourceExtensionId = String((msg && msg.sourceExtensionId) || senderId);
  try {
    const before = await storageGet([NATIVE_BROADCAST_KEY]);
    const prev = (before && before[NATIVE_BROADCAST_KEY] && typeof before[NATIVE_BROADCAST_KEY] === "object" && !Array.isArray(before[NATIVE_BROADCAST_KEY]))
      ? before[NATIVE_BROADCAST_KEY]
      : {};
    const next = {
      ...prev,
      linkedRecords,
      ts: Date.now(),
      surface: "native",
      source,
      sourceExtensionId,
    };
    await storageSet({ [NATIVE_BROADCAST_KEY]: next });
    return {
      ok: true,
      status: linkedRecords.length ? "merged" : "merged-empty",
      senderId,
      key: NATIVE_BROADCAST_KEY,
      linkedRecordsCount: linkedRecords.length,
    };
  } catch (e) {
    return {
      ok: false,
      status: "merge-failed",
      senderId,
      error: String((e && (e.stack || e.message || e)) || "merge-failed"),
      linkedRecordsCount: linkedRecords.length,
    };
  }
}

async function handleExternalNativeSnapshotPayloadsMessage(msg, sender) {
  const senderId = String(sender && sender.id || "");
  if (!senderId || !NATIVE_FOLDER_STATE_EXTERNAL_SENDER_IDS.has(senderId)) {
    return { ok: false, status: "sender-not-allowed", senderId };
  }
  const snapshotPayloads = msg && Array.isArray(msg.snapshotPayloads) ? msg.snapshotPayloads : null;
  if (snapshotPayloads === null) {
    return { ok: false, status: "invalid-snapshot-payloads", senderId };
  }
  const source = String((msg && msg.source) || "native-content-bridge");
  const sourceExtensionId = String((msg && msg.sourceExtensionId) || senderId);
  const payloadHasBodyCount = snapshotPayloads.filter((item) => {
    const src = item && typeof item === "object" ? item : {};
    const meta = src.meta && typeof src.meta === "object" ? src.meta : {};
    return (Array.isArray(src.messages) && src.messages.length > 0)
      || (Array.isArray(meta.richTurns) && meta.richTurns.length > 0);
  }).length;
  try {
    const before = await storageGet([NATIVE_BROADCAST_KEY]);
    const prev = (before && before[NATIVE_BROADCAST_KEY] && typeof before[NATIVE_BROADCAST_KEY] === "object" && !Array.isArray(before[NATIVE_BROADCAST_KEY]))
      ? before[NATIVE_BROADCAST_KEY]
      : {};
    const next = {
      ...prev,
      snapshotPayloads: snapshotPayloads.slice(0, 8),
      ts: Date.now(),
      surface: "native",
      source,
      sourceExtensionId,
    };
    await storageSet({ [NATIVE_BROADCAST_KEY]: next });
    return {
      ok: true,
      status: snapshotPayloads.length ? "merged" : "merged-empty",
      senderId,
      key: NATIVE_BROADCAST_KEY,
      snapshotPayloadCount: snapshotPayloads.length,
      payloadHasBodyCount,
    };
  } catch (e) {
    return {
      ok: false,
      status: "merge-failed",
      senderId,
      error: String((e && (e.stack || e.message || e)) || "merge-failed"),
      snapshotPayloadCount: snapshotPayloads.length,
      payloadHasBodyCount,
    };
  }
}

/* F10.5.3 — receive the count-safe capture mirror digest forwarded from
 * prod Cockpit Pro and persist it to the Studio Launcher's own
 * chrome.storage.local so the F10.5 evidence bridge can read it. The
 * digest is written verbatim — no raw payload transformation. */
async function handleExternalNativeCaptureMirrorMessage(msg, sender) {
  const senderId = String(sender && sender.id || "");
  if (!senderId || !NATIVE_FOLDER_STATE_EXTERNAL_SENDER_IDS.has(senderId)) {
    return { ok: false, status: "sender-not-allowed", senderId };
  }
  const mirror = (msg && msg.mirror && typeof msg.mirror === "object" && !Array.isArray(msg.mirror))
    ? msg.mirror
    : null;
  if (mirror === null) {
    return { ok: false, status: "invalid-capture-mirror", senderId };
  }
  try {
    await storageSet({ [NATIVE_CAPTURE_MIRROR_KEY]: mirror });
    return { ok: true, status: "written", senderId, key: NATIVE_CAPTURE_MIRROR_KEY };
  } catch (e) {
    return {
      ok: false,
      status: "write-failed",
      senderId,
      error: String((e && (e.stack || e.message || e)) || "write-failed"),
    };
  }
}

async function handleExternalNativeFolderMetadataOperationResultsMessage(msg, sender) {
  const senderId = String(sender && sender.id || "");
  if (!senderId || !NATIVE_FOLDER_STATE_EXTERNAL_SENDER_IDS.has(senderId)) {
    return { ok: false, status: "sender-not-allowed", senderId };
  }
  const results = msg && Array.isArray(msg.folderMetadataOperationResults) ? msg.folderMetadataOperationResults : null;
  if (results === null) {
    return { ok: false, status: "invalid-folder-metadata-operation-results", senderId };
  }
  const source = String((msg && msg.source) || "native-content-bridge");
  const sourceExtensionId = String((msg && msg.sourceExtensionId) || senderId);
  try {
    const before = await storageGet([NATIVE_BROADCAST_KEY]);
    const prev = (before && before[NATIVE_BROADCAST_KEY] && typeof before[NATIVE_BROADCAST_KEY] === "object" && !Array.isArray(before[NATIVE_BROADCAST_KEY]))
      ? before[NATIVE_BROADCAST_KEY]
      : {};
    const next = {
      ...prev,
      folderMetadataOperationResults: results.slice(0, 16),
      ts: Date.now(),
      surface: "native",
      source,
      sourceExtensionId,
    };
    await storageSet({ [NATIVE_BROADCAST_KEY]: next });
    return {
      ok: true,
      status: results.length ? "merged" : "merged-empty",
      senderId,
      key: NATIVE_BROADCAST_KEY,
      folderMetadataOperationResultCount: results.length,
    };
  } catch (e) {
    return {
      ok: false,
      status: "merge-failed",
      senderId,
      error: String((e && (e.stack || e.message || e)) || "merge-failed"),
      folderMetadataOperationResultCount: results.length,
    };
  }
}

function validateFullBundleShape(bundleRaw) {
  if (!bundleRaw || typeof bundleRaw !== "object") {
    throw new Error("bundle: not an object");
  }
  // Accept v1 as degraded input (no chromeStorageLocal / libraryKv).
  if (bundleRaw.schema === "h2o.chatArchive.bundle.v1") {
    return {
      schema: FULL_BUNDLE_SCHEMA_V2,
      chatArchive: bundleRaw,
      chromeStorageLocal: {},
      libraryKv: [],
      sourceVersion: "v1",
    };
  }
  if (bundleRaw.schema !== FULL_BUNDLE_SCHEMA_V2) {
    throw new Error("bundle: unsupported schema " + JSON.stringify(bundleRaw.schema));
  }
  const chatArchive = bundleRaw.chatArchive;
  if (!chatArchive || chatArchive.schema !== "h2o.chatArchive.bundle.v1" || !Array.isArray(chatArchive.chats)) {
    throw new Error("bundle: missing or invalid chatArchive section");
  }
  return {
    schema: FULL_BUNDLE_SCHEMA_V2,
    chatArchive,
    chromeStorageLocal:
      bundleRaw.chromeStorageLocal && typeof bundleRaw.chromeStorageLocal === "object" && !Array.isArray(bundleRaw.chromeStorageLocal)
        ? bundleRaw.chromeStorageLocal
        : {},
    libraryKv: Array.isArray(bundleRaw.libraryKv) ? bundleRaw.libraryKv : [],
    sourceVersion: "v2",
  };
}

async function exportFullBundle(optsRaw = {}, nsDisk = DEFAULT_NS_DISK) {
  const ns = normalizeNsDisk((optsRaw && optsRaw.nsDisk) || nsDisk);
  const chatArchive = await exportBundle("all", null, ns);
  let chromeStorageLocal = {};
  let libraryKv = [];
  let chromeStorageError = null;
  let libraryKvError = null;
  try { chromeStorageLocal = await dumpChromeStorageLocalFiltered(); }
  catch (e) { chromeStorageError = String(e && (e.message || e)); }
  try { libraryKv = await dumpLibraryKvAll(); }
  catch (e) { libraryKvError = String(e && (e.message || e)); }

  const snapshotCount = chatArchive.chats.reduce(
    (sum, c) => sum + (Array.isArray(c && c.snapshots) ? c.snapshots.length : 0),
    0,
  );

  return {
    schema: FULL_BUNDLE_SCHEMA_V2,
    exportedAt: nowIso(),
    exportedFromExtensionId: (chrome && chrome.runtime && chrome.runtime.id) || "",
    exportedFromExtensionName: (chrome && chrome.runtime && chrome.runtime.getManifest && chrome.runtime.getManifest().name) || "",
    exportedFromVersion: (chrome && chrome.runtime && chrome.runtime.getManifest && chrome.runtime.getManifest().version) || "",
    chatArchive,
    chromeStorageLocal,
    libraryKv,
    diagnostics: {
      chromeStorageError,
      libraryKvError,
    },
    summary: {
      chatCount: chatArchive.chatCount || chatArchive.chats.length,
      snapshotCount,
      categoryCount: ((chatArchive.catalogs && chatArchive.catalogs.categories) || []).length,
      labelCount: ((chatArchive.catalogs && chatArchive.catalogs.labels) || []).length,
      chromeStorageKeyCount: Object.keys(chromeStorageLocal).length,
      libraryKvKeyCount: libraryKv.length,
    },
  };
}

async function dryRunImportFullBundle(bundleRaw, nsDisk = DEFAULT_NS_DISK) {
  const ns = normalizeNsDisk(nsDisk);
  const src = validateFullBundleShape(bundleRaw);

  const prodChatIds = await listAllChatIds(ns);
  const prodChatIdSet = new Set(prodChatIds);
  const incomingChatIds = src.chatArchive.chats.map((c) => normalizeChatId(c && c.chatId)).filter(Boolean);
  const newChatIds = [];
  const dupChatIds = [];
  for (const id of incomingChatIds) {
    if (prodChatIdSet.has(id)) dupChatIds.push(id);
    else newChatIds.push(id);
  }
  const incomingSnapshots = src.chatArchive.chats.reduce(
    (sum, c) => sum + (Array.isArray(c && c.snapshots) ? c.snapshots.length : 0),
    0,
  );

  let currentStorage = {};
  try { currentStorage = await dumpChromeStorageLocalFiltered(); } catch {}
  const incomingStorage = src.chromeStorageLocal || {};
  const storageKeysToWrite = [];
  const storageKeysSkipped = [];
  const storageKeysDenied = [];
  for (const k of Object.keys(incomingStorage)) {
    if (!isExportableStorageKey(k)) { storageKeysDenied.push(k); continue; }
    if (k === FOLDER_STATE_DATA_KEY && Object.prototype.hasOwnProperty.call(currentStorage, k)) {
      const merged = mergeFolderStateData(currentStorage[k], incomingStorage[k], "merge");
      if (stableJson(comparableFolderStateData(currentStorage[k])) === stableJson(comparableFolderStateData(merged))) storageKeysSkipped.push(k);
      else storageKeysToWrite.push(k);
    } else if (Object.prototype.hasOwnProperty.call(currentStorage, k)) storageKeysSkipped.push(k);
    else storageKeysToWrite.push(k);
  }

  let currentKvKeys = new Set();
  try {
    const rows = await dumpLibraryKvAll();
    currentKvKeys = new Set(rows.map((r) => r.key));
  } catch {}
  const kvIncoming = Array.isArray(src.libraryKv) ? src.libraryKv : [];
  const kvKeysToWrite = [];
  const kvKeysSkipped = [];
  const kvKeysDenied = [];
  for (const row of kvIncoming) {
    const k = row && typeof row.key === "string" ? row.key : "";
    if (!k) { kvKeysDenied.push(""); continue; }
    const check = libraryKvValidateKey(k);
    if (!check.ok) { kvKeysDenied.push(k); continue; }
    if (currentKvKeys.has(k)) kvKeysSkipped.push(k);
    else kvKeysToWrite.push(k);
  }

  return {
    schema: FULL_BUNDLE_SCHEMA_V2,
    mode: "dry-run",
    sourceVersion: src.sourceVersion,
    plan: {
      chats: {
        incoming: incomingChatIds.length,
        incomingSnapshots,
        willImport: newChatIds.length,
        willSkipDuplicates: dupChatIds.length,
      },
      chromeStorageLocal: {
        incoming: Object.keys(incomingStorage).length,
        willImport: storageKeysToWrite.length,
        willSkipDuplicates: storageKeysSkipped.length,
        deniedByPolicy: storageKeysDenied.length,
      },
      libraryKv: {
        incoming: kvIncoming.length,
        willImport: kvKeysToWrite.length,
        willSkipDuplicates: kvKeysSkipped.length,
        deniedByPolicy: kvKeysDenied.length,
      },
    },
    sample: {
      newChatIds: newChatIds.slice(0, 10),
      dupChatIds: dupChatIds.slice(0, 10),
      storageKeysToWrite: storageKeysToWrite.slice(0, 20),
      storageKeysSkipped: storageKeysSkipped.slice(0, 20),
      storageKeysDenied: storageKeysDenied.slice(0, 20),
      kvKeysToWrite: kvKeysToWrite.slice(0, 20),
      kvKeysSkipped: kvKeysSkipped.slice(0, 20),
      kvKeysDenied: kvKeysDenied.slice(0, 20),
    },
  };
}

async function importFullBundle(bundleRaw, modeRaw = "merge", nsDisk = DEFAULT_NS_DISK) {
  const ns = normalizeNsDisk(nsDisk);
  const mode = String(modeRaw || "merge").trim().toLowerCase() === "overwrite" ? "overwrite" : "merge";
  const src = validateFullBundleShape(bundleRaw);

  const chatResult = await importBundle(src.chatArchive, mode, ns);
  const storageResult = await writeChromeStorageLocalMerge(src.chromeStorageLocal || {}, mode);
  const kvResult = await writeLibraryKvBatchMerge(src.libraryKv || [], mode);

  return {
    schema: FULL_BUNDLE_SCHEMA_V2,
    mode,
    sourceVersion: src.sourceVersion,
    chats: chatResult,
    chromeStorageLocal: storageResult,
    libraryKv: kvResult,
  };
}

async function httpRequest(req) {
  const method = String(req?.method || "GET").toUpperCase();
  const url = String(req?.url || "");
  if (!url) return { ok: false, status: 0, error: "missing url" };

  const timeoutRaw = Number(req?.timeoutMs || 20000);
  const timeoutMs = Number.isFinite(timeoutRaw) ? Math.max(1000, Math.min(120000, timeoutRaw)) : 20000;
  const headers = normHeaders(req?.headers);
  const hasBody = Object.prototype.hasOwnProperty.call(req || {}, "body");
  const body = hasBody && req.body != null ? String(req.body) : undefined;

  const ac = (typeof AbortController !== "undefined") ? new AbortController() : null;
  const timer = ac ? setTimeout(() => { try { ac.abort(); } catch {} }, timeoutMs) : 0;

  try {
    const res = await fetch(url, {
      method,
      headers,
      body,
      cache: "no-store",
      redirect: "follow",
      signal: ac ? ac.signal : undefined,
    });
    const text = await res.text();
    return {
      ok: true,
      status: Number(res.status || 0),
      statusText: String(res.statusText || ""),
      responseText: String(text || ""),
      finalUrl: String(res.url || url),
      responseURL: String(res.url || url),
      method,
      url,
    };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      error: String(err && (err.stack || err.message || err)),
      method,
      url,
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function pageMetadataDecodeEntities(value) {
  return String(value || "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\\d+);/g, (_m, n) => {
      const code = Number(n);
      return Number.isFinite(code) ? String.fromCharCode(code) : "";
    });
}

function pageMetadataExtractTitle(html) {
  const text = String(html || "");
  const meta = text.match(/<meta\\s+[^>]*(?:property|name)=["'](?:og:title|twitter:title)["'][^>]*content=["']([^"']+)["'][^>]*>/i)
    || text.match(/<meta\\s+[^>]*content=["']([^"']+)["'][^>]*(?:property|name)=["'](?:og:title|twitter:title)["'][^>]*>/i);
  const titleMatch = meta || text.match(/<title[^>]*>([\\s\\S]*?)<\\/title>/i);
  return pageMetadataDecodeEntities(titleMatch && titleMatch[1]).replace(/\\s+/g, " ").trim();
}

function pageMetadataOriginPattern(url) {
  try {
    const parsed = new URL(String(url || ""));
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";
    return parsed.origin + "/*";
  } catch {
    return "";
  }
}

function pageMetadataPermissionContains(originPattern) {
  if (!originPattern) return Promise.resolve({ granted: false, reason: "invalid-url" });
  if (typeof chrome === "undefined" || !chrome.permissions || typeof chrome.permissions.contains !== "function") {
    return Promise.resolve({ granted: false, reason: "permission-api-unavailable" });
  }
  return new Promise((resolve) => {
    try {
      chrome.permissions.contains({ origins: [originPattern] }, (granted) => {
        const lastError = chrome.runtime && chrome.runtime.lastError;
        resolve({
          granted: granted === true && !lastError,
          reason: lastError ? "permission-check-failed" : (granted === true ? "" : "permission-denied"),
        });
      });
    } catch {
      resolve({ granted: false, reason: "permission-check-failed" });
    }
  });
}

function pageMetadataNormalizeUrlForTabMatch(value) {
  try {
    const parsed = new URL(String(value || "").trim());
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";
    parsed.hash = "";
    parsed.search = "";
    parsed.pathname = parsed.pathname.replace(/\\/+$/g, "") || "/";
    return parsed.toString();
  } catch {
    return "";
  }
}

function pageMetadataNormalizeChatConversationUrl(value) {
  try {
    const parsed = new URL(String(value || "").trim());
    const host = parsed.hostname.toLowerCase();
    if (parsed.protocol !== "https:" || (host !== "chatgpt.com" && !host.endsWith(".chatgpt.com"))) return "";
    const match = parsed.pathname.match(/^\\/c\\/([^/?#\\/]+)\\/?$/i);
    if (!match) return "";
    return "https://chatgpt.com/c/" + match[1];
  } catch {
    return "";
  }
}

function pageMetadataLooksLikeGenericTitle(value) {
  const title = pageMetadataDecodeEntities(value).replace(/\\s+/g, " ").trim();
  if (!title) return true;
  const lower = title.toLowerCase();
  if (lower === "chatgpt" || lower === "link" || lower === "imported chat") return true;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(title)) return true;
  return false;
}

function pageMetadataQueryTabs(queryInfo) {
  if (typeof chrome === "undefined" || !chrome.tabs || typeof chrome.tabs.query !== "function") {
    return Promise.resolve({ ok: false, reason: "tabs-api-unavailable", tabs: [] });
  }
  return new Promise((resolve) => {
    try {
      chrome.tabs.query(queryInfo, (rows) => {
        const lastError = chrome.runtime && chrome.runtime.lastError;
        if (lastError) {
          resolve({ ok: false, reason: "tabs-query-failed", tabs: [] });
          return;
        }
        resolve({ ok: true, reason: "", tabs: Array.isArray(rows) ? rows : [] });
      });
    } catch {
      resolve({ ok: false, reason: "tabs-query-failed", tabs: [] });
    }
  });
}

async function pageMetadataTitleFromOpenTab(url) {
  const targetChat = pageMetadataNormalizeChatConversationUrl(url);
  const targetUrl = pageMetadataNormalizeUrlForTabMatch(url);
  if (!targetUrl) return { ok: false, reason: "invalid-url", source: "open-tab" };
  const query = targetChat ? { url: ["https://chatgpt.com/c/*", "https://chatgpt.com/g/*/c/*"] } : {};
  const queried = await pageMetadataQueryTabs(query);
  if (!queried.ok) return { ok: false, reason: queried.reason || "tabs-query-failed", source: "open-tab" };
  const candidates = queried.tabs.filter((tab) => {
    const tabUrl = String(tab && tab.url || "");
    if (!tabUrl) return false;
    if (targetChat) return pageMetadataNormalizeChatConversationUrl(tabUrl) === targetChat;
    return pageMetadataNormalizeUrlForTabMatch(tabUrl) === targetUrl;
  });
  if (!candidates.length) return { ok: false, reason: "source-tab-not-open", source: "open-tab" };
  const sorted = candidates.slice().sort((a, b) => Number(!!b.active) - Number(!!a.active));
  for (const tab of sorted) {
    const title = pageMetadataDecodeEntities(tab && tab.title).replace(/\\s+/g, " ").trim();
    if (title && !pageMetadataLooksLikeGenericTitle(title)) {
      return {
        ok: true,
        reason: "",
        source: "open-tab",
        title,
        displayTitle: title,
        sourceTitle: title,
        pageTitle: title,
        matchedOpenTab: true,
      };
    }
  }
  return { ok: false, reason: "open-tab-title-generic", source: "open-tab", matchedOpenTab: true };
}

async function fetchPageMetadata(payload = {}) {
  const url = String(payload && payload.url || "").trim();
  const originPattern = pageMetadataOriginPattern(url);
  if (!originPattern) {
    return { ok: false, reason: "invalid-url", permission: "not-applicable" };
  }
  const openTabTitle = await pageMetadataTitleFromOpenTab(url);
  if (openTabTitle && openTabTitle.ok === true) {
    return {
      ...openTabTitle,
      permission: "not-required",
      originPattern,
      finalUrl: pageMetadataNormalizeUrlForTabMatch(url) || url,
    };
  }
  const permission = await pageMetadataPermissionContains(originPattern);
  if (!permission.granted) {
    return {
      ok: false,
      reason: permission.reason || "permission-denied",
      permission: "denied",
      originPattern,
    };
  }
  const response = await httpRequest({
    method: "GET",
    url,
    timeoutMs: 15000,
    headers: { accept: "text/html,application/xhtml+xml,text/plain;q=0.8,*/*;q=0.5" },
  });
  if (!response || !response.ok) {
    return {
      ok: false,
      reason: "network-error",
      status: Number(response && response.status || 0),
      permission: "granted",
      originPattern,
    };
  }
  const status = Number(response.status || 0);
  if (status < 200 || status >= 300) {
    return {
      ok: false,
      reason: "source-unavailable",
      status,
      permission: "granted",
      originPattern,
    };
  }
  const title = pageMetadataExtractTitle(response.responseText);
  if (!title) {
    const noTitleReason = openTabTitle && openTabTitle.reason === "source-tab-not-open"
      ? "source-tab-not-open"
      : (openTabTitle && openTabTitle.reason === "open-tab-title-generic" ? "open-tab-title-generic" : "no-title-found");
    return {
      ok: false,
      reason: noTitleReason,
      status,
      permission: "granted",
      originPattern,
      finalUrl: String(response.finalUrl || response.responseURL || url),
      openTabTitleReason: openTabTitle && openTabTitle.reason || "",
    };
  }
  return {
    ok: true,
    reason: "",
    status,
    permission: "granted",
    originPattern,
    title,
    displayTitle: title,
    sourceTitle: title,
    pageTitle: title,
    finalUrl: String(response.finalUrl || response.responseURL || url),
  };
}

// ─── Library KV (Phase 1.6 — durable backend for H2O.Library.Store) ─────────
// A dedicated IndexedDB database isolated from the archive's h2o_chat_archive DB.
// All keys MUST start with "h2o:prm:cgx:library:" (enforced by libraryKvValidateKey).
// Errors are returned as structured { ok:false, error, code } — the bridge never throws.
// Designed so a future move to chrome.storage.local or a different backend can happen
// inside this section without changing the wire protocol or H2O.Library.Store callers.

const LIBRARY_KV_DB = "h2o_library_kv";
const LIBRARY_KV_DB_VERSION = 1;
const LIBRARY_KV_STORE = "kv";
const LIBRARY_KV_KEY_PREFIX = "h2o:prm:cgx:library:";
const LIBRARY_KV_MAX_VALUE_BYTES = 5 * 1024 * 1024;
const LIBRARY_KV_MAX_KEY_LENGTH = 512;
const LIBRARY_KV_OP_SET = Object.freeze({
  libraryKvGet: 1,
  libraryKvSet: 1,
  libraryKvDel: 1,
  libraryKvListKeys: 1,
  libraryKvEstimate: 1,
});

let _libraryKvDbPromise = null;

function libraryKvOpenDb() {
  if (_libraryKvDbPromise) return _libraryKvDbPromise;
  _libraryKvDbPromise = new Promise((resolve, reject) => {
    let req;
    try { req = indexedDB.open(LIBRARY_KV_DB, LIBRARY_KV_DB_VERSION); }
    catch (e) { reject(e); return; }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(LIBRARY_KV_STORE)) {
        db.createObjectStore(LIBRARY_KV_STORE);
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      // Allow reopen on next call if the connection closes (SW respawn, version bump, etc.).
      db.onclose = () => { _libraryKvDbPromise = null; };
      db.onversionchange = () => { try { db.close(); } catch (_e) {} _libraryKvDbPromise = null; };
      resolve(db);
    };
    req.onerror = () => reject(req.error || new Error("library kv: open failed"));
    req.onblocked = () => reject(new Error("library kv: open blocked"));
  });
  return _libraryKvDbPromise;
}

function libraryKvValidateKey(key) {
  if (typeof key !== "string") return { ok: false, code: "INVALID_KEY_TYPE", error: "key must be a string" };
  if (key.length === 0) return { ok: false, code: "INVALID_KEY_EMPTY", error: "key must not be empty" };
  if (key.length > LIBRARY_KV_MAX_KEY_LENGTH) return { ok: false, code: "INVALID_KEY_LENGTH", error: "key exceeds max length " + LIBRARY_KV_MAX_KEY_LENGTH };
  if (!key.startsWith(LIBRARY_KV_KEY_PREFIX)) return { ok: false, code: "INVALID_KEY_PREFIX", error: "key must start with " + LIBRARY_KV_KEY_PREFIX };
  return { ok: true };
}

function libraryKvValidatePrefix(prefix) {
  if (typeof prefix !== "string") return { ok: false, code: "INVALID_PREFIX_TYPE", error: "prefix must be a string" };
  if (!prefix.startsWith(LIBRARY_KV_KEY_PREFIX)) return { ok: false, code: "INVALID_PREFIX", error: "prefix must start with " + LIBRARY_KV_KEY_PREFIX };
  return { ok: true };
}

function libraryKvValidateValue(value) {
  const t = typeof value;
  if (t === "function" || t === "symbol") return { ok: false, code: "INVALID_VALUE_TYPE", error: "value type " + t + " not supported" };
  if (t === "string" && value.length > LIBRARY_KV_MAX_VALUE_BYTES) {
    return { ok: false, code: "OVERSIZE", error: "value exceeds " + LIBRARY_KV_MAX_VALUE_BYTES + " bytes" };
  }
  // Cyclic objects and other unsupported structured-clone types throw inside libraryKvSet
  // (DataCloneError) and are reported as { code: "INVALID_VALUE" } by the handler.
  return { ok: true };
}

async function libraryKvGet(key) {
  const db = await libraryKvOpenDb();
  return new Promise((resolve, reject) => {
    let tx;
    try { tx = db.transaction(LIBRARY_KV_STORE, "readonly"); }
    catch (e) { reject(e); return; }
    const store = tx.objectStore(LIBRARY_KV_STORE);
    const req = store.get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error("library kv: get failed"));
  });
}

async function libraryKvSet(key, value) {
  const db = await libraryKvOpenDb();
  return new Promise((resolve, reject) => {
    let tx;
    try { tx = db.transaction(LIBRARY_KV_STORE, "readwrite"); }
    catch (e) { reject(e); return; }
    const store = tx.objectStore(LIBRARY_KV_STORE);
    let req;
    try { req = store.put(value, key); }
    catch (e) { reject(e); return; }
    req.onsuccess = () => resolve(true);
    req.onerror = () => reject(req.error || new Error("library kv: set failed"));
  });
}

async function libraryKvDel(key) {
  const db = await libraryKvOpenDb();
  return new Promise((resolve, reject) => {
    let tx;
    try { tx = db.transaction(LIBRARY_KV_STORE, "readwrite"); }
    catch (e) { reject(e); return; }
    const store = tx.objectStore(LIBRARY_KV_STORE);
    const req = store.delete(key);
    req.onsuccess = () => resolve(true);
    req.onerror = () => reject(req.error || new Error("library kv: del failed"));
  });
}

async function libraryKvListKeys(prefix) {
  const db = await libraryKvOpenDb();
  return new Promise((resolve, reject) => {
    let tx;
    try { tx = db.transaction(LIBRARY_KV_STORE, "readonly"); }
    catch (e) { reject(e); return; }
    const store = tx.objectStore(LIBRARY_KV_STORE);
    const req = store.getAllKeys();
    req.onsuccess = () => {
      const all = Array.isArray(req.result) ? req.result : [];
      resolve(all.filter((k) => typeof k === "string" && k.startsWith(prefix)));
    };
    req.onerror = () => reject(req.error || new Error("library kv: listKeys failed"));
  });
}

async function libraryKvEstimate() {
  try {
    if (typeof navigator !== "undefined" && navigator.storage && typeof navigator.storage.estimate === "function") {
      const e = await navigator.storage.estimate();
      if (e && Number.isFinite(e.usage) && Number.isFinite(e.quota) && e.quota > 0) {
        return { used: e.usage, quota: e.quota, percent: e.usage / e.quota, source: "navigator.storage" };
      }
    }
  } catch (_e) {}
  return { used: null, quota: null, percent: null, source: "unsupported" };
}

async function libraryKvHandle(op, payload) {
  try {
    const p = (payload && typeof payload === "object" && !Array.isArray(payload)) ? payload : {};
    if (op === "libraryKvGet") {
      const k = String(p.key != null ? p.key : "");
      const v = libraryKvValidateKey(k);
      if (!v.ok) return { ok: false, error: v.error, code: v.code };
      const result = await libraryKvGet(k);
      return { ok: true, result };
    }
    if (op === "libraryKvSet") {
      const k = String(p.key != null ? p.key : "");
      const v = libraryKvValidateKey(k);
      if (!v.ok) return { ok: false, error: v.error, code: v.code };
      const value = p.value;
      const vv = libraryKvValidateValue(value);
      if (!vv.ok) return { ok: false, error: vv.error, code: vv.code };
      try {
        await libraryKvSet(k, value);
        return { ok: true, result: true };
      } catch (e) {
        const name = e && e.name ? String(e.name) : "Error";
        const msg = e && (e.message || String(e)) || "library kv: set failed";
        const code = (name === "QuotaExceededError") ? "QUOTA_EXCEEDED"
                   : (name === "DataCloneError") ? "INVALID_VALUE"
                   : "SET_FAILED";
        return { ok: false, error: msg, code };
      }
    }
    if (op === "libraryKvDel") {
      const k = String(p.key != null ? p.key : "");
      const v = libraryKvValidateKey(k);
      if (!v.ok) return { ok: false, error: v.error, code: v.code };
      await libraryKvDel(k);
      return { ok: true, result: true };
    }
    if (op === "libraryKvListKeys") {
      const prefix = String(p.prefix != null ? p.prefix : LIBRARY_KV_KEY_PREFIX);
      const v = libraryKvValidatePrefix(prefix);
      if (!v.ok) return { ok: false, error: v.error, code: v.code };
      const keys = await libraryKvListKeys(prefix);
      return { ok: true, result: keys };
    }
    if (op === "libraryKvEstimate") {
      const est = await libraryKvEstimate();
      return { ok: true, result: est };
    }
    return { ok: false, error: "unsupported library kv op", code: "UNSUPPORTED_OP" };
  } catch (e) {
    return { ok: false, error: String(e && (e.message || e)) || "library kv: handler error", code: "HANDLER_ERROR" };
  }
}

async function libraryStorageDiagnose() {
  const indexedDbAvailable = typeof indexedDB !== "undefined";
  const databasesApiAvailable = indexedDbAvailable && typeof indexedDB.databases === "function";
  const now = new Date().toISOString();
  let databases = [];
  let databasesError = "";
  if (databasesApiAvailable) {
    try {
      const rows = await indexedDB.databases();
      databases = Array.isArray(rows) ? rows : [];
    } catch (e) {
      databasesError = String(e && (e.message || e)) || "indexedDB.databases failed";
    }
  }
  const canDetermineDbExistence = databasesApiAvailable && !databasesError;
  const current = canDetermineDbExistence ? (databases.find((row) => row && row.name === LIBRARY_SHARED_DB_NAME) || null) : null;
  const dbExists = canDetermineDbExistence ? !!current : null;
  const stores = {};
  for (const name of LIBRARY_SHARED_PLANNED_STORES) {
    stores[name] = {
      planned: true,
      exists: null,
      status: dbExists === true
        ? "not-inspected-without-db-open"
        : (dbExists === false ? "not-created" : "unknown-db-existence"),
    };
  }
  return {
    ok: true,
    phase: "8B",
    mode: "diagnostics-only",
    service: "library-storage",
    background: {
      reachable: true,
      context: "chrome-extension-background",
      at: now,
    },
    indexedDB: {
      available: indexedDbAvailable,
      databasesApiAvailable,
      databasesError,
    },
    schema: {
      dbName: LIBRARY_SHARED_DB_NAME,
      plannedVersion: LIBRARY_SHARED_DB_VERSION,
      currentVersion: dbExists === true ? Number(current.version || 0) || null : null,
      dbExists,
      dbCreatedByThisCheck: false,
      objectStoreInspection: dbExists
        ? "skipped-to-avoid-db-open-side-effects"
        : (dbExists === false ? "skipped-db-absent" : "skipped-db-existence-unknown"),
      plannedStores: LIBRARY_SHARED_PLANNED_STORES.slice(),
      stores,
    },
    flags: {
      migration: false,
      dualWrite: false,
      canonicalRead: false,
    },
    health: {
      ok: indexedDbAvailable,
      status: indexedDbAvailable ? "ready-for-future-schema" : "indexeddb-unavailable",
      reason: databasesError || "",
    },
  };
}

function getLibrarySchemaStoreRequest(raw) {
  const requested = Array.isArray(raw) ? raw.map((v) => String(v || "").trim()).filter(Boolean) : [];
  const allowed = LIBRARY_SHARED_MINIMAL_SCHEMA_STORES.slice();
  const seen = new Set();
  const stores = [];
  const duplicateStores = [];
  const invalidStores = [];
  for (const name of requested) {
    if (!allowed.includes(name)) {
      invalidStores.push(name);
      continue;
    }
    if (seen.has(name)) {
      duplicateStores.push(name);
      continue;
    }
    seen.add(name);
    stores.push(name);
  }
  const exact = requested.length === allowed.length
    && invalidStores.length === 0
    && duplicateStores.length === 0
    && allowed.every((name) => stores.includes(name));
  return { requested, stores, invalidStores, duplicateStores, exact };
}

async function getLibrarySharedDbListing() {
  const indexedDbAvailable = typeof indexedDB !== "undefined";
  const databasesApiAvailable = indexedDbAvailable && typeof indexedDB.databases === "function";
  let databases = [];
  let databasesError = "";
  if (databasesApiAvailable) {
    try {
      const rows = await indexedDB.databases();
      databases = Array.isArray(rows) ? rows : [];
    } catch (e) {
      databasesError = String(e && (e.message || e)) || "indexedDB.databases failed";
    }
  }
  const canDetermineDbExistence = databasesApiAvailable && !databasesError;
  const current = canDetermineDbExistence ? (databases.find((row) => row && row.name === LIBRARY_SHARED_DB_NAME) || null) : null;
  const dbExists = canDetermineDbExistence ? !!current : null;
  const currentVersion = dbExists === true ? Number(current && current.version || 0) || null : null;
  return {
    indexedDbAvailable,
    databasesApiAvailable,
    databasesError,
    canDetermineDbExistence,
    dbExists,
    currentVersion,
  };
}

function createLibrarySharedStore(db, name) {
  if (!db || !name || db.objectStoreNames.contains(name)) return false;
  if (name === "chatRegistry") {
    db.createObjectStore(name, { keyPath: "chatId" });
    return true;
  }
  if (name === "migrationState") {
    db.createObjectStore(name, { keyPath: "domain" });
    return true;
  }
  if (name === "syncState") {
    db.createObjectStore(name, { keyPath: "key" });
    return true;
  }
  return false;
}

function countLibrarySharedStore(db, storeName) {
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(storeName, "readonly");
      const req = tx.objectStore(storeName).count();
      req.onsuccess = () => resolve({ ok: true, count: Number(req.result || 0) || 0 });
      req.onerror = () => {
        const err = req.error;
        resolve({
          ok: false,
          status: "object-store-count-failed",
          reason: String(err && (err.message || err.name || err)) || "object store count failed",
        });
      };
      tx.onerror = () => {
        const err = tx.error;
        resolve({
          ok: false,
          status: "object-store-transaction-failed",
          reason: String(err && (err.message || err.name || err)) || "object store transaction failed",
        });
      };
    } catch (e) {
      resolve({
        ok: false,
        status: "object-store-count-threw",
        reason: String(e && (e.message || e)) || "object store count threw",
      });
    }
  });
}

async function inspectLibrarySharedSchemaCounts(db, requiredStores) {
  const existingStores = Array.from(db.objectStoreNames || []);
  const stores = {};
  for (const name of requiredStores) {
    const exists = db.objectStoreNames.contains(name);
    stores[name] = {
      exists,
      count: exists ? null : null,
    };
    if (!exists) continue;
    const counted = await countLibrarySharedStore(db, name);
    if (!counted.ok) {
      stores[name] = {
        ...stores[name],
        count: null,
        error: counted.reason || counted.status || "count failed",
      };
      return {
        ok: false,
        status: counted.status || "object-store-count-failed",
        reason: counted.reason || ("failed to count " + name),
        stores,
        existingStores,
      };
    }
    stores[name].count = counted.count;
  }
  return { ok: true, stores, existingStores };
}

async function libraryStorageCreateEmptySchema(payload = {}) {
  const src = payload && typeof payload === "object" ? payload : {};
  const domain = String(src.domain || "").trim();
  const mode = String(src.mode || "").trim();
  const explicitApproval = String(src.explicitApproval || "").trim();
  const storeRequest = getLibrarySchemaStoreRequest(src.stores);
  const requestedStores = storeRequest.stores;
  const requiredStores = LIBRARY_SHARED_MINIMAL_SCHEMA_STORES.slice();
  const now = new Date().toISOString();
  const base = {
    phase: "8I",
    mode,
    dryRun: mode === "dry-run",
    dbName: LIBRARY_SHARED_DB_NAME,
    version: LIBRARY_SHARED_DB_VERSION,
    domain,
    storesRequested: requestedStores.slice(),
    requestedStores: requestedStores.slice(),
    requiredStores: requiredStores.slice(),
    recordsWritten: 0,
    canonicalReadsEnabled: false,
    canonicalReadEnabled: false,
    dualReadExecutionEnabled: false,
    dualWriteEnabled: false,
    migrationEnabled: false,
    at: now,
  };
  if (domain !== "chatRegistry") {
    return { ...base, ok: false, status: "unsupported-domain", reason: "only chatRegistry empty schema creation is allowed in phase 8I" };
  }
  if (mode !== "empty-schema-only" && mode !== "dry-run") {
    return { ...base, ok: false, status: "invalid-mode", reason: "mode must be empty-schema-only or dry-run" };
  }
  if (explicitApproval !== LIBRARY_SHARED_EMPTY_SCHEMA_APPROVAL) {
    return { ...base, ok: false, status: "missing-explicit-approval", reason: "explicit approval token is required" };
  }
  if (!storeRequest.exact) {
    return {
      ...base,
      ok: false,
      status: "invalid-store-list",
      reason: "stores must exactly match chatRegistry, migrationState, syncState",
      rawStoresRequested: storeRequest.requested,
      invalidStores: storeRequest.invalidStores,
      duplicateStores: storeRequest.duplicateStores,
    };
  }
  if (typeof indexedDB === "undefined") {
    return { ...base, ok: false, status: "indexeddb-unavailable", reason: "IndexedDB is unavailable in background context" };
  }
  const listing = await getLibrarySharedDbListing();
  if (listing.currentVersion && listing.currentVersion > LIBRARY_SHARED_DB_VERSION) {
    return {
      ...base,
      ok: false,
      status: "existing-db-version-too-new",
      reason: "existing h2o.library.shared version is newer than phase 8I schema version",
      currentVersion: listing.currentVersion,
      dbExists: listing.dbExists,
    };
  }
  if (mode === "dry-run") {
    if (listing.dbExists === null) {
      return {
        ...base,
        ok: false,
        dryRun: true,
        status: "db-existence-undetermined",
        reason: listing.databasesError || "indexedDB.databases unavailable; dry-run refuses to open DB",
        dbExists: null,
        wouldCreate: null,
      };
    }
    return {
      ...base,
      ok: true,
      dryRun: true,
      status: listing.dbExists ? "empty-schema-presence-uninspected" : "would-create-empty-schema",
      dbExists: listing.dbExists,
      currentVersion: listing.currentVersion,
      wouldCreate: listing.dbExists === false,
      storesCreated: [],
    };
  }

  return new Promise((resolve) => {
    let created = false;
    const storesCreated = [];
    let req = null;
    try {
      req = indexedDB.open(LIBRARY_SHARED_DB_NAME, LIBRARY_SHARED_DB_VERSION);
    } catch (e) {
      resolve({ ...base, ok: false, status: "indexeddb-open-failed", reason: String(e && (e.message || e)) || "IndexedDB open failed" });
      return;
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      created = true;
      for (const name of requiredStores) {
        if (createLibrarySharedStore(db, name)) storesCreated.push(name);
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      const existingStores = Array.from(db.objectStoreNames || []);
      const missingStores = requiredStores.filter((name) => !db.objectStoreNames.contains(name));
      const unexpectedStores = existingStores.filter((name) => !requiredStores.includes(name));
      const currentVersion = Number(db.version || 0) || null;
      try { db.close(); } catch {}
      if (currentVersion && currentVersion > LIBRARY_SHARED_DB_VERSION) {
        resolve({
          ...base,
          ok: false,
          dryRun: false,
          status: "existing-db-version-too-new",
          reason: "existing h2o.library.shared version is newer than phase 8I schema version",
          currentVersion,
          created,
          storesCreated,
          existingStores,
        });
        return;
      }
      if (unexpectedStores.length) {
        resolve({
          ...base,
          ok: false,
          dryRun: false,
          status: "existing-schema-has-unexpected-stores",
          reason: "existing h2o.library.shared has stores outside the approved phase 8I minimal schema",
          currentVersion,
          created,
          storesCreated,
          existingStores,
          unexpectedStores,
        });
        return;
      }
      if (missingStores.length) {
        resolve({
          ...base,
          ok: false,
          dryRun: false,
          status: "existing-schema-missing-required-stores",
          reason: "existing h2o.library.shared schema cannot be expanded without an explicit versioned upgrade phase",
          currentVersion,
          created,
          storesCreated,
          existingStores,
          missingStores,
        });
        return;
      }
      resolve({
        ...base,
        ok: true,
        dryRun: false,
        status: created ? "created-empty-schema" : "empty-schema-already-present",
        created,
        dbCreatedByThisCall: created,
        storesCreated,
        existingStores,
        missingStores: [],
      });
    };
    req.onerror = () => {
      const err = req.error;
      resolve({
        ...base,
        ok: false,
        dryRun: false,
        status: "indexeddb-open-failed",
        reason: String(err && (err.message || err.name || err)) || "IndexedDB open failed",
      });
    };
    req.onblocked = () => {
      resolve({
        ...base,
        ok: false,
        dryRun: false,
        status: "indexeddb-open-blocked",
        reason: "opening h2o.library.shared was blocked by another connection",
      });
    };
  });
}

async function libraryStorageInspectSchema(payload = {}) {
  const src = payload && typeof payload === "object" ? payload : {};
  const domain = String(src.domain || "").trim();
  const mode = String(src.mode || "").trim();
  const requiredStores = LIBRARY_SHARED_MINIMAL_SCHEMA_STORES.slice();
  const now = new Date().toISOString();
  const base = {
    phase: "8J",
    mode,
    dbName: LIBRARY_SHARED_DB_NAME,
    version: LIBRARY_SHARED_DB_VERSION,
    plannedVersion: LIBRARY_SHARED_DB_VERSION,
    domain,
    requiredStores: requiredStores.slice(),
    approvedStores: requiredStores.slice(),
    recordsWritten: 0,
    canonicalReadsEnabled: false,
    canonicalReadEnabled: false,
    dualReadExecutionEnabled: false,
    dualWriteEnabled: false,
    migrationEnabled: false,
    inspected: false,
    at: now,
  };
  if (domain !== "chatRegistry") {
    return { ...base, ok: false, status: "unsupported-domain", reason: "only chatRegistry schema inspection is allowed in phase 8J" };
  }
  if (mode !== "inspect-schema-only") {
    return { ...base, ok: false, status: "invalid-mode", reason: "mode must be inspect-schema-only" };
  }
  if (typeof indexedDB === "undefined") {
    return { ...base, ok: false, status: "indexeddb-unavailable", reason: "IndexedDB is unavailable in background context" };
  }
  const listing = await getLibrarySharedDbListing();
  if (!listing.canDetermineDbExistence) {
    return {
      ...base,
      ok: false,
      status: "db-existence-undetermined",
      reason: listing.databasesError || "indexedDB.databases unavailable; inspection refuses to open DB",
      dbExists: null,
      indexedDbAvailable: listing.indexedDbAvailable,
      databasesApiAvailable: listing.databasesApiAvailable,
    };
  }
  if (listing.dbExists !== true) {
    return {
      ...base,
      ok: false,
      status: "db-missing",
      reason: "h2o.library.shared does not exist; phase 8J will not create it",
      dbExists: false,
      currentVersion: null,
    };
  }
  if (listing.currentVersion !== LIBRARY_SHARED_DB_VERSION) {
    return {
      ...base,
      ok: false,
      status: "db-version-not-1",
      reason: "h2o.library.shared version does not match the approved phase 8I schema version",
      dbExists: true,
      currentVersion: listing.currentVersion,
    };
  }

  return new Promise((resolve) => {
    let settled = false;
    let req = null;
    const done = (out) => {
      if (settled) return;
      settled = true;
      resolve(out);
    };
    try {
      req = indexedDB.open(LIBRARY_SHARED_DB_NAME);
    } catch (e) {
      done({ ...base, ok: false, status: "indexeddb-open-failed", reason: String(e && (e.message || e)) || "IndexedDB open failed", dbExists: true, currentVersion: listing.currentVersion });
      return;
    }
    req.onupgradeneeded = () => {
      try {
        const tx = req.transaction;
        if (tx && typeof tx.abort === "function") tx.abort();
      } catch {}
      try {
        const db = req.result;
        if (db && typeof db.close === "function") db.close();
      } catch {}
      done({
        ...base,
        ok: false,
        status: "indexeddb-upgrade-attempted",
        reason: "schema inspection aborted because IndexedDB attempted to create or upgrade h2o.library.shared",
        dbExists: true,
        currentVersion: listing.currentVersion,
      });
    };
    req.onsuccess = async () => {
      const db = req.result;
      try {
        const currentVersion = Number(db.version || 0) || null;
        const existingStores = Array.from(db.objectStoreNames || []);
        const missingStores = requiredStores.filter((name) => !db.objectStoreNames.contains(name));
        const unexpectedStores = existingStores.filter((name) => !requiredStores.includes(name));
        if (currentVersion !== LIBRARY_SHARED_DB_VERSION) {
          done({
            ...base,
            ok: false,
            status: "db-version-not-1",
            reason: "opened h2o.library.shared version does not match the approved phase 8I schema version",
            dbExists: true,
            currentVersion,
            existingStores,
            unexpectedStores,
          });
          return;
        }
        const counted = await inspectLibrarySharedSchemaCounts(db, requiredStores);
        const stores = counted.stores || {};
        if (!counted.ok) {
          done({
            ...base,
            ok: false,
            status: counted.status || "object-store-count-failed",
            reason: counted.reason || "failed to count an approved object store",
            dbExists: true,
            inspected: true,
            currentVersion,
            version: currentVersion,
            existingStores,
            unexpectedStores,
            missingStores,
            stores,
          });
          return;
        }
        if (missingStores.length) {
          done({
            ...base,
            ok: false,
            status: "required-stores-missing",
            reason: "h2o.library.shared is missing required phase 8I stores",
            dbExists: true,
            inspected: true,
            currentVersion,
            version: currentVersion,
            existingStores,
            unexpectedStores,
            missingStores,
            stores,
          });
          return;
        }
        done({
          ...base,
          ok: true,
          status: unexpectedStores.length ? "schema-inspected-with-unexpected-stores" : "schema-inspected",
          reason: unexpectedStores.length ? "h2o.library.shared contains stores outside the approved phase 8I minimal schema" : "",
          dbExists: true,
          inspected: true,
          currentVersion,
          version: currentVersion,
          existingStores,
          unexpectedStores,
          missingStores: [],
          stores,
        });
      } catch (e) {
        done({
          ...base,
          ok: false,
          status: "schema-inspection-failed",
          reason: String(e && (e.message || e)) || "schema inspection failed",
          dbExists: true,
          currentVersion: listing.currentVersion,
        });
      } finally {
        try { db.close(); } catch {}
      }
    };
    req.onerror = () => {
      const err = req.error;
      done({
        ...base,
        ok: false,
        status: "indexeddb-open-failed",
        reason: String(err && (err.message || err.name || err)) || "IndexedDB open failed",
        dbExists: true,
        currentVersion: listing.currentVersion,
      });
    };
    req.onblocked = () => {
      done({
        ...base,
        ok: false,
        status: "indexeddb-open-blocked",
        reason: "opening h2o.library.shared was blocked by another connection",
        dbExists: true,
        currentVersion: listing.currentVersion,
      });
    };
  });
}

function libraryStorageHashString(value) {
  const raw = String(value || "");
  let hash = 2166136261;
  for (let i = 0; i < raw.length; i += 1) {
    hash ^= raw.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return "fnv1a32:" + (hash >>> 0).toString(16).padStart(8, "0");
}

function libraryStorageStableJson(value) {
  const seen = new WeakSet();
  const normalize = (input) => {
    if (input === null || typeof input !== "object") return input;
    if (seen.has(input)) return "[Circular]";
    seen.add(input);
    if (Array.isArray(input)) return input.map(normalize);
    const out = {};
    Object.keys(input).sort().forEach((key) => {
      const val = input[key];
      if (typeof val === "undefined" || typeof val === "function") return;
      out[key] = normalize(val);
    });
    return out;
  };
  try {
    return JSON.stringify(normalize(value));
  } catch {
    try { return JSON.stringify(value); } catch { return ""; }
  }
}

function summarizeChatRegistryRecordForDiagnostic(record) {
  const rec = record && typeof record === "object" && !Array.isArray(record) ? record : null;
  if (!rec) {
    return {
      present: false,
      chatId: "",
      title: "",
      normalizedHref: "",
      updatedAt: "",
      topLevelKeys: [],
      stateKeys: [],
      stateFlags: {},
      recordHash: "",
      jsonBytes: 0,
    };
  }
  const stableJson = libraryStorageStableJson(rec);
  const state = rec.state && typeof rec.state === "object" && !Array.isArray(rec.state) ? rec.state : {};
  return {
    present: true,
    chatId: String(rec.chatId || "").trim(),
    title: String(rec.title || rec.chatTitle || rec.name || "").trim(),
    normalizedHref: String(rec.normalizedHref || "").trim(),
    updatedAt: String(rec.updatedAt || "").trim(),
    topLevelKeys: Object.keys(rec).sort(),
    stateKeys: Object.keys(state).sort(),
    stateFlags: {
      isSaved: state.isSaved === true,
      isLinked: state.isLinked === true,
      isImported: state.isImported === true,
      isPinned: state.isPinned === true,
      isArchived: state.isArchived === true,
      isDeleted: state.isDeleted === true,
    },
    recordHash: stableJson ? libraryStorageHashString(stableJson) : "",
    jsonBytes: stableJson.length,
  };
}

function normalizeChatRegistryMirrorRecords(records, candidateKeys) {
  const rawRecords = Array.isArray(records) ? records : [];
  const rawKeys = Array.isArray(candidateKeys) ? candidateKeys : [];
  const normalized = [];
  const keys = [];
  const seenChatIds = new Set();
  const errors = [];
  for (let index = 0; index < rawRecords.length; index += 1) {
    const rec = rawRecords[index];
    if (!rec || typeof rec !== "object" || Array.isArray(rec)) {
      errors.push("record-not-object:" + index);
      continue;
    }
    const chatId = String(rec.chatId || "").trim();
    if (!chatId) {
      errors.push("record-missing-chatId:" + index);
      continue;
    }
    if (seenChatIds.has(chatId)) {
      errors.push("duplicate-chatId:" + chatId);
      continue;
    }
    seenChatIds.add(chatId);
    normalized.push(rec);
    keys.push(String(rawKeys[index] || ("chatId:" + chatId)));
  }
  return { records: normalized, candidateKeys: keys, errors };
}

function checksumChatRegistryMirrorPayload(records, candidateKeys) {
  const checksumInput = (records || []).map((rec, index) => [
    candidateKeys[index] || "",
    rec && rec.chatId || "",
    rec && rec.normalizedHref || "",
    rec && rec.updatedAt || "",
    rec && rec.state && rec.state.isSaved ? "saved" : "",
    rec && rec.state && rec.state.isLinked ? "linked" : "",
    rec && rec.state && rec.state.isImported ? "imported" : "",
  ].join(":")).join("|");
  return records && records.length ? libraryStorageHashString(checksumInput) : "";
}

function chatRegistryMirrorRecordKey(record) {
  const rec = record && typeof record === "object" && !Array.isArray(record) ? record : {};
  const chatId = String(rec.chatId || "").trim();
  if (chatId) return "chatId:" + chatId;
  const href = String(rec.normalizedHref || "").trim();
  if (href) return "href:" + href;
  const latest = String(rec.latestSnapshotId || "").trim();
  if (latest) return "snap:" + latest;
  return "";
}

function readChatRegistryMirrorRecords(db, maxRecords = 5000, phaseLabel = "8l") {
  return new Promise((resolve) => {
    let tx = null;
    const records = [];
    const done = (out) => resolve(out);
    try {
      tx = db.transaction("chatRegistry", "readonly");
      const store = tx.objectStore("chatRegistry");
      const req = store.openCursor();
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) {
          done({ ok: true, records });
          return;
        }
        if (records.length >= maxRecords) {
          done({
            ok: false,
            status: "canonical-store-too-large-for-phase-" + String(phaseLabel || "diagnostic").toLowerCase(),
            reason: "chatRegistry mirror diagnostic is bounded and refuses to read more than " + maxRecords + " records",
            records,
          });
          return;
        }
        const value = cursor.value;
        if (value && typeof value === "object" && !Array.isArray(value)) {
          records.push(value);
        }
        cursor.continue();
      };
      req.onerror = () => {
        const err = req.error;
        done({
          ok: false,
          status: "canonical-record-read-failed",
          reason: String(err && (err.message || err.name || err)) || "canonical record read failed",
          records,
        });
      };
      tx.onerror = () => {
        const err = tx.error;
        done({
          ok: false,
          status: "canonical-record-transaction-failed",
          reason: String(err && (err.message || err.name || err)) || "canonical record transaction failed",
          records,
        });
      };
    } catch (e) {
      done({
        ok: false,
        status: "canonical-record-read-threw",
        reason: String(e && (e.message || e)) || "canonical record read threw",
        records,
      });
    }
  });
}

function readChatRegistryMirrorRecord(db, chatId) {
  return new Promise((resolve) => {
    let tx = null;
    try {
      tx = db.transaction("chatRegistry", "readonly");
      const req = tx.objectStore("chatRegistry").get(chatId);
      req.onsuccess = () => {
        const record = req.result && typeof req.result === "object" && !Array.isArray(req.result)
          ? req.result
          : null;
        resolve({
          ok: true,
          found: !!record,
          recordSummary: summarizeChatRegistryRecordForDiagnostic(record),
        });
      };
      req.onerror = () => {
        const err = req.error;
        resolve({
          ok: false,
          status: "canonical-record-read-failed",
          reason: String(err && (err.message || err.name || err)) || "canonical record read failed",
        });
      };
      tx.onerror = () => {
        const err = tx.error;
        resolve({
          ok: false,
          status: "canonical-record-transaction-failed",
          reason: String(err && (err.message || err.name || err)) || "canonical record transaction failed",
        });
      };
    } catch (e) {
      resolve({
        ok: false,
        status: "canonical-record-read-threw",
        reason: String(e && (e.message || e)) || "canonical record read threw",
      });
    }
  });
}

function summarizeChatRegistryMirrorRecords(records) {
  const byKey = Object.create(null);
  const duplicateChatIds = [];
  const invalidRecords = [];
  const seenChatIds = new Set();
  (Array.isArray(records) ? records : []).forEach((record, index) => {
    const key = chatRegistryMirrorRecordKey(record);
    const chatId = String(record && record.chatId || "").trim();
    if (!key) {
      invalidRecords.push("missing-key:" + index);
      return;
    }
    if (chatId) {
      if (seenChatIds.has(chatId)) duplicateChatIds.push(chatId);
      seenChatIds.add(chatId);
    }
    if (!byKey[key]) byKey[key] = record;
  });
  const canonicalKeys = Object.keys(byKey).sort();
  const canonicalRecords = canonicalKeys.map((key) => byKey[key]);
  const canonicalChatIds = canonicalRecords
    .map((record) => String(record && record.chatId || "").trim())
    .filter(Boolean);
  return {
    canonicalCount: canonicalRecords.length,
    canonicalKeys,
    canonicalChatIds,
    sampleCanonicalChatIds: canonicalChatIds.slice(0, 8),
    canonicalChecksum: checksumChatRegistryMirrorPayload(canonicalRecords, canonicalKeys),
    duplicateChatIds: Array.from(new Set(duplicateChatIds)).slice(0, 20),
    invalidRecords: invalidRecords.slice(0, 20),
  };
}

function writeChatRegistryMirrorRecords(db, records) {
  return new Promise((resolve) => {
    let settled = false;
    let tx = null;
    const done = (out) => {
      if (settled) return;
      settled = true;
      resolve(out);
    };
    try {
      tx = db.transaction("chatRegistry", "readwrite");
      const store = tx.objectStore("chatRegistry");
      for (const record of records) {
        try {
          store.put(record);
        } catch (e) {
          try { tx.abort(); } catch {}
          done({
            ok: false,
            status: "mirror-write-record-put-failed",
            reason: String(e && (e.message || e)) || "mirror record put failed",
            recordsWritten: 0,
          });
          return;
        }
      }
      tx.oncomplete = () => done({ ok: true, recordsWritten: records.length });
      tx.onabort = () => {
        const err = tx.error;
        done({
          ok: false,
          status: "mirror-write-transaction-aborted",
          reason: String(err && (err.message || err.name || err)) || "mirror write transaction aborted",
          recordsWritten: 0,
        });
      };
      tx.onerror = () => {
        const err = tx.error;
        done({
          ok: false,
          status: "mirror-write-transaction-failed",
          reason: String(err && (err.message || err.name || err)) || "mirror write transaction failed",
          recordsWritten: 0,
        });
      };
    } catch (e) {
      done({
        ok: false,
        status: "mirror-write-threw",
        reason: String(e && (e.message || e)) || "mirror write threw",
        recordsWritten: 0,
      });
    }
  });
}

function replaceChatRegistryMirrorRecords(db, records) {
  return new Promise((resolve) => {
    let settled = false;
    let tx = null;
    const done = (out) => {
      if (settled) return;
      settled = true;
      resolve(out);
    };
    try {
      tx = db.transaction("chatRegistry", "readwrite");
      const store = tx.objectStore("chatRegistry");
      const clearReq = store.clear();
      clearReq.onsuccess = () => {
        for (const record of records) {
          try {
            store.put(record);
          } catch (e) {
            try { tx.abort(); } catch {}
            done({
              ok: false,
              status: "mirror-refresh-record-put-failed",
              reason: String(e && (e.message || e)) || "mirror refresh record put failed",
              recordsWritten: 0,
            });
            return;
          }
        }
      };
      clearReq.onerror = () => {
        const err = clearReq.error;
        try { tx.abort(); } catch {}
        done({
          ok: false,
          status: "mirror-refresh-clear-failed",
          reason: String(err && (err.message || err.name || err)) || "mirror refresh clear failed",
          recordsWritten: 0,
        });
      };
      tx.oncomplete = () => done({ ok: true, recordsWritten: records.length });
      tx.onabort = () => {
        const err = tx.error;
        done({
          ok: false,
          status: "mirror-refresh-transaction-aborted",
          reason: String(err && (err.message || err.name || err)) || "mirror refresh transaction aborted",
          recordsWritten: 0,
        });
      };
      tx.onerror = () => {
        const err = tx.error;
        done({
          ok: false,
          status: "mirror-refresh-transaction-failed",
          reason: String(err && (err.message || err.name || err)) || "mirror refresh transaction failed",
          recordsWritten: 0,
        });
      };
    } catch (e) {
      done({
        ok: false,
        status: "mirror-refresh-threw",
        reason: String(e && (e.message || e)) || "mirror refresh threw",
        recordsWritten: 0,
      });
    }
  });
}

async function libraryStorageWriteChatRegistryMirror(payload = {}) {
  const src = payload && typeof payload === "object" ? payload : {};
  const domain = String(src.domain || "").trim();
  const mode = String(src.mode || "").trim();
  const explicitApproval = String(src.explicitApproval || "").trim();
  const expectedChecksum = String(src.expectedChecksum || "").trim();
  const checksum = String(src.checksum || "").trim();
  const expectedCandidateCount = Number(src.expectedCandidateCount);
  const candidateCount = Number(src.candidateCount);
  const batchSize = Number(src.batchSize);
  const now = new Date().toISOString();
  const base = {
    ok: false,
    phase: "8K",
    domain,
    mode,
    dbName: LIBRARY_SHARED_DB_NAME,
    store: "chatRegistry",
    recordsWritten: 0,
    expectedCandidateCount: Number.isFinite(expectedCandidateCount) ? expectedCandidateCount : null,
    checksum: checksum || expectedChecksum,
    canonicalReadsEnabled: false,
    canonicalReadEnabled: false,
    dualReadExecutionEnabled: false,
    dualWriteEnabled: false,
    legacyMutated: false,
    migrationStateWritten: false,
    syncStateWritten: false,
    at: now,
  };
  if (domain !== "chatRegistry") {
    return { ...base, status: "unsupported-domain", reason: "only chatRegistry mirror writes are allowed in phase 8K" };
  }
  if (mode !== "mirror-write-bounded") {
    return { ...base, status: "invalid-mode", reason: "mode must be mirror-write-bounded" };
  }
  if (explicitApproval !== LIBRARY_SHARED_CHAT_REGISTRY_MIRROR_WRITE_APPROVAL) {
    return { ...base, status: "missing-explicit-approval", reason: "explicit mirror write approval token is required" };
  }
  if (!expectedChecksum || !checksum || checksum !== expectedChecksum) {
    return { ...base, status: "checksum-mismatch", reason: "expected checksum must match the current mirror candidate checksum" };
  }
  if (!Number.isFinite(expectedCandidateCount) || expectedCandidateCount <= 0) {
    return { ...base, status: "invalid-expected-candidate-count", reason: "expectedCandidateCount must be a positive number" };
  }
  if (!Number.isFinite(candidateCount) || candidateCount !== expectedCandidateCount) {
    return { ...base, status: "candidate-count-mismatch", reason: "candidateCount must match expectedCandidateCount", candidateCount: Number.isFinite(candidateCount) ? candidateCount : null };
  }
  if (batchSize !== 50) {
    return { ...base, status: "invalid-batch-size", reason: "batchSize must be 50 for phase 8K" };
  }
  const normalized = normalizeChatRegistryMirrorRecords(src.records, src.candidateKeys);
  if (normalized.errors.length) {
    return { ...base, status: "invalid-records", reason: "mirror payload contains invalid records", errors: normalized.errors.slice(0, 10), candidateCount: normalized.records.length };
  }
  if (normalized.records.length !== expectedCandidateCount) {
    return { ...base, status: "record-count-mismatch", reason: "records length must match expectedCandidateCount", candidateCount: normalized.records.length };
  }
  const payloadChecksum = checksumChatRegistryMirrorPayload(normalized.records, normalized.candidateKeys);
  if (payloadChecksum !== expectedChecksum) {
    return { ...base, status: "payload-checksum-mismatch", reason: "mirror payload checksum does not match expected checksum", payloadChecksum };
  }
  const inspection = await libraryStorageInspectSchema({ domain: "chatRegistry", mode: "inspect-schema-only" });
  if (!inspection.ok) {
    return { ...base, status: "schema-inspection-failed", reason: inspection.reason || inspection.status || "schema inspection failed", inspection };
  }
  const stores = inspection.stores || {};
  const missingStores = LIBRARY_SHARED_MINIMAL_SCHEMA_STORES.filter((name) => !stores[name] || stores[name].exists !== true);
  if (inspection.currentVersion !== LIBRARY_SHARED_DB_VERSION && inspection.version !== LIBRARY_SHARED_DB_VERSION) {
    return { ...base, status: "db-version-not-1", reason: "h2o.library.shared version must be 1", inspection };
  }
  if (missingStores.length) {
    return { ...base, status: "required-stores-missing", reason: "required phase 8I stores are missing", missingStores, inspection };
  }
  if (Array.isArray(inspection.unexpectedStores) && inspection.unexpectedStores.length) {
    return { ...base, status: "unexpected-stores-present", reason: "unexpected stores block the first mirror write", unexpectedStores: inspection.unexpectedStores.slice(), inspection };
  }
  if (!stores.chatRegistry || stores.chatRegistry.count !== 0) {
    return { ...base, status: "chatregistry-store-not-empty", reason: "chatRegistry store must be empty before the first mirror write", canonicalExistingCount: stores.chatRegistry ? stores.chatRegistry.count : null, inspection };
  }
  if (stores.migrationState && stores.migrationState.count !== 0) {
    return { ...base, status: "migration-state-not-empty", reason: "migrationState is expected to remain empty in phase 8K", inspection };
  }
  if (stores.syncState && stores.syncState.count !== 0) {
    return { ...base, status: "sync-state-not-empty", reason: "syncState is expected to remain empty in phase 8K", inspection };
  }

  return new Promise((resolve) => {
    let settled = false;
    let req = null;
    const done = (out) => {
      if (settled) return;
      settled = true;
      resolve(out);
    };
    try {
      req = indexedDB.open(LIBRARY_SHARED_DB_NAME);
    } catch (e) {
      done({ ...base, status: "indexeddb-open-failed", reason: String(e && (e.message || e)) || "IndexedDB open failed" });
      return;
    }
    req.onupgradeneeded = () => {
      try {
        const tx = req.transaction;
        if (tx && typeof tx.abort === "function") tx.abort();
      } catch {}
      try {
        const db = req.result;
        if (db && typeof db.close === "function") db.close();
      } catch {}
      done({ ...base, status: "indexeddb-upgrade-attempted", reason: "mirror write aborted because IndexedDB attempted to create or upgrade h2o.library.shared" });
    };
    req.onsuccess = async () => {
      const db = req.result;
      try {
        const currentVersion = Number(db.version || 0) || null;
        if (currentVersion !== LIBRARY_SHARED_DB_VERSION) {
          done({ ...base, status: "db-version-not-1", reason: "opened h2o.library.shared version must be 1", currentVersion });
          return;
        }
        const beforeCount = await countLibrarySharedStore(db, "chatRegistry");
        if (!beforeCount.ok) {
          done({ ...base, status: beforeCount.status || "chatregistry-count-failed", reason: beforeCount.reason || "failed to count chatRegistry before write" });
          return;
        }
        if (beforeCount.count !== 0) {
          done({ ...base, status: "chatregistry-store-not-empty", reason: "chatRegistry store must be empty before write", canonicalExistingCount: beforeCount.count });
          return;
        }
        const written = await writeChatRegistryMirrorRecords(db, normalized.records);
        if (!written.ok) {
          done({ ...base, ...written, ok: false, checksum: expectedChecksum });
          return;
        }
        const afterCount = await countLibrarySharedStore(db, "chatRegistry");
        if (!afterCount.ok) {
          done({ ...base, status: afterCount.status || "post-write-count-failed", reason: afterCount.reason || "failed to count chatRegistry after write", recordsWritten: written.recordsWritten });
          return;
        }
        if (afterCount.count !== expectedCandidateCount) {
          done({ ...base, status: "post-write-count-mismatch", reason: "chatRegistry count after write does not match expected candidate count", recordsWritten: written.recordsWritten, canonicalExistingCount: afterCount.count });
          return;
        }
        done({
          ...base,
          ok: true,
          status: "mirror-write-complete",
          recordsWritten: written.recordsWritten,
          candidateCount: expectedCandidateCount,
          expectedCandidateCount,
          checksum: expectedChecksum,
          canonicalExistingCount: afterCount.count,
        });
      } catch (e) {
        done({ ...base, status: "mirror-write-failed", reason: String(e && (e.message || e)) || "mirror write failed" });
      } finally {
        try { db.close(); } catch {}
      }
    };
    req.onerror = () => {
      const err = req.error;
      done({ ...base, status: "indexeddb-open-failed", reason: String(err && (err.message || err.name || err)) || "IndexedDB open failed" });
    };
    req.onblocked = () => {
      done({ ...base, status: "indexeddb-open-blocked", reason: "opening h2o.library.shared was blocked by another connection" });
    };
  });
}

async function libraryStorageRefreshChatRegistryMirror(payload = {}) {
  const src = payload && typeof payload === "object" ? payload : {};
  const domain = String(src.domain || "").trim();
  const mode = String(src.mode || "").trim();
  const explicitApproval = String(src.explicitApproval || "").trim();
  const expectedChecksum = String(src.expectedChecksum || "").trim();
  const checksum = String(src.checksum || "").trim();
  const expectedCandidateCount = Number(src.expectedCandidateCount);
  const candidateCount = Number(src.candidateCount);
  const batchSize = Number(src.batchSize);
  const now = new Date().toISOString();
  const base = {
    ok: false,
    phase: "8Q",
    domain,
    mode,
    dbName: LIBRARY_SHARED_DB_NAME,
    store: "chatRegistry",
    recordsWritten: 0,
    recordsCleared: 0,
    expectedCandidateCount: Number.isFinite(expectedCandidateCount) ? expectedCandidateCount : null,
    checksum: checksum || expectedChecksum,
    canonicalReadsEnabled: false,
    canonicalReadEnabled: false,
    dualReadExecutionEnabled: false,
    dualWriteEnabled: false,
    genericReadEnabled: false,
    genericWriteEnabled: false,
    legacyMutated: false,
    migrationStateWritten: false,
    syncStateWritten: false,
    at: now,
  };
  if (domain !== "chatRegistry") {
    return { ...base, status: "unsupported-domain", reason: "only chatRegistry mirror refreshes are allowed in phase 8Q" };
  }
  if (mode !== "mirror-refresh-bounded") {
    return { ...base, status: "invalid-mode", reason: "mode must be mirror-refresh-bounded" };
  }
  if (explicitApproval !== LIBRARY_SHARED_CHAT_REGISTRY_MIRROR_REFRESH_APPROVAL) {
    return { ...base, status: "missing-explicit-approval", reason: "explicit mirror refresh approval token is required" };
  }
  if (!expectedChecksum || !checksum || checksum !== expectedChecksum) {
    return { ...base, status: "checksum-mismatch", reason: "expected checksum must match the current mirror candidate checksum" };
  }
  if (!Number.isFinite(expectedCandidateCount) || expectedCandidateCount <= 0) {
    return { ...base, status: "invalid-expected-candidate-count", reason: "expectedCandidateCount must be a positive number" };
  }
  if (!Number.isFinite(candidateCount) || candidateCount !== expectedCandidateCount) {
    return { ...base, status: "candidate-count-mismatch", reason: "candidateCount must match expectedCandidateCount", candidateCount: Number.isFinite(candidateCount) ? candidateCount : null };
  }
  if (batchSize !== 50) {
    return { ...base, status: "invalid-batch-size", reason: "batchSize must be 50 for phase 8Q" };
  }
  const normalized = normalizeChatRegistryMirrorRecords(src.records, src.candidateKeys);
  if (normalized.errors.length) {
    return { ...base, status: "invalid-records", reason: "mirror refresh payload contains invalid records", errors: normalized.errors.slice(0, 10), candidateCount: normalized.records.length };
  }
  if (normalized.records.length !== expectedCandidateCount) {
    return { ...base, status: "record-count-mismatch", reason: "records length must match expectedCandidateCount", candidateCount: normalized.records.length };
  }
  const payloadChecksum = checksumChatRegistryMirrorPayload(normalized.records, normalized.candidateKeys);
  if (payloadChecksum !== expectedChecksum) {
    return { ...base, status: "payload-checksum-mismatch", reason: "mirror refresh payload checksum does not match expected checksum", payloadChecksum };
  }
  const inspection = await libraryStorageInspectSchema({ domain: "chatRegistry", mode: "inspect-schema-only" });
  if (!inspection.ok) {
    return { ...base, status: "schema-inspection-failed", reason: inspection.reason || inspection.status || "schema inspection failed", inspection };
  }
  const stores = inspection.stores || {};
  const missingStores = LIBRARY_SHARED_MINIMAL_SCHEMA_STORES.filter((name) => !stores[name] || stores[name].exists !== true);
  const schemaVersion = inspection.currentVersion || inspection.version || null;
  if (schemaVersion !== LIBRARY_SHARED_DB_VERSION) {
    return { ...base, status: "db-version-not-1", reason: "h2o.library.shared version must be 1", inspection };
  }
  if (missingStores.length) {
    return { ...base, status: "required-stores-missing", reason: "required phase 8I stores are missing", missingStores, inspection };
  }
  if (Array.isArray(inspection.unexpectedStores) && inspection.unexpectedStores.length) {
    return { ...base, status: "unexpected-stores-present", reason: "unexpected stores block mirror refresh", unexpectedStores: inspection.unexpectedStores.slice(), inspection };
  }

  return new Promise((resolve) => {
    let settled = false;
    let req = null;
    const done = (out) => {
      if (settled) return;
      settled = true;
      resolve(out);
    };
    try {
      req = indexedDB.open(LIBRARY_SHARED_DB_NAME);
    } catch (e) {
      done({ ...base, status: "indexeddb-open-failed", reason: String(e && (e.message || e)) || "IndexedDB open failed", inspection });
      return;
    }
    req.onupgradeneeded = () => {
      try {
        const tx = req.transaction;
        if (tx && typeof tx.abort === "function") tx.abort();
      } catch {}
      try {
        const db = req.result;
        if (db && typeof db.close === "function") db.close();
      } catch {}
      done({ ...base, status: "indexeddb-upgrade-attempted", reason: "mirror refresh aborted because IndexedDB attempted to create or upgrade h2o.library.shared", inspection });
    };
    req.onsuccess = async () => {
      const db = req.result;
      try {
        const currentVersion = Number(db.version || 0) || null;
        if (currentVersion !== LIBRARY_SHARED_DB_VERSION) {
          done({ ...base, status: "db-version-not-1", reason: "opened h2o.library.shared version must be 1", currentVersion, inspection });
          return;
        }
        const existing = await readChatRegistryMirrorRecords(db, 5000, "8q");
        if (!existing.ok) {
          done({ ...base, status: existing.status || "existing-mirror-read-failed", reason: existing.reason || "failed to read existing chatRegistry mirror", inspection });
          return;
        }
        const existingSummary = summarizeChatRegistryMirrorRecords(existing.records || []);
        if (existingSummary.invalidRecords.length) {
          done({ ...base, status: "invalid-existing-canonical-records", reason: "existing canonical chatRegistry mirror contains invalid records", invalidCanonicalRecords: existingSummary.invalidRecords.slice(), inspection });
          return;
        }
        if (existingSummary.duplicateChatIds.length) {
          done({ ...base, status: "duplicate-existing-canonical-chatIds", reason: "existing canonical chatRegistry mirror contains duplicate chatIds", duplicateCanonicalChatIds: existingSummary.duplicateChatIds.slice(), inspection });
          return;
        }
        const migrationBefore = await countLibrarySharedStore(db, "migrationState");
        if (!migrationBefore.ok) {
          done({ ...base, status: migrationBefore.status || "migration-state-count-failed", reason: migrationBefore.reason || "failed to count migrationState before refresh", inspection });
          return;
        }
        const syncBefore = await countLibrarySharedStore(db, "syncState");
        if (!syncBefore.ok) {
          done({ ...base, status: syncBefore.status || "sync-state-count-failed", reason: syncBefore.reason || "failed to count syncState before refresh", inspection });
          return;
        }
        const refreshed = await replaceChatRegistryMirrorRecords(db, normalized.records);
        if (!refreshed.ok) {
          done({ ...base, ...refreshed, ok: false, checksum: expectedChecksum, recordsCleared: 0, inspection });
          return;
        }
        const after = await readChatRegistryMirrorRecords(db, 5000, "8q");
        if (!after.ok) {
          done({ ...base, status: after.status || "post-refresh-read-failed", reason: after.reason || "failed to read chatRegistry after refresh", recordsWritten: refreshed.recordsWritten, recordsCleared: existingSummary.canonicalCount, inspection });
          return;
        }
        const afterSummary = summarizeChatRegistryMirrorRecords(after.records || []);
        if (afterSummary.canonicalCount !== expectedCandidateCount) {
          done({ ...base, status: "post-refresh-count-mismatch", reason: "chatRegistry count after refresh does not match expected candidate count", recordsWritten: refreshed.recordsWritten, recordsCleared: existingSummary.canonicalCount, canonicalExistingCount: afterSummary.canonicalCount, inspection });
          return;
        }
        if (afterSummary.canonicalChecksum !== expectedChecksum) {
          done({ ...base, status: "post-refresh-checksum-mismatch", reason: "chatRegistry checksum after refresh does not match expected checksum", recordsWritten: refreshed.recordsWritten, recordsCleared: existingSummary.canonicalCount, canonicalChecksum: afterSummary.canonicalChecksum, inspection });
          return;
        }
        if (afterSummary.invalidRecords.length || afterSummary.duplicateChatIds.length) {
          done({ ...base, status: "post-refresh-invalid-canonical-records", reason: "chatRegistry mirror contains invalid or duplicate records after refresh", recordsWritten: refreshed.recordsWritten, recordsCleared: existingSummary.canonicalCount, invalidCanonicalRecords: afterSummary.invalidRecords.slice(), duplicateCanonicalChatIds: afterSummary.duplicateChatIds.slice(), inspection });
          return;
        }
        const migrationAfter = await countLibrarySharedStore(db, "migrationState");
        const syncAfter = await countLibrarySharedStore(db, "syncState");
        if (!migrationAfter.ok || migrationAfter.count !== migrationBefore.count) {
          done({ ...base, status: "migration-state-count-changed", reason: "migrationState count changed during mirror refresh", recordsWritten: refreshed.recordsWritten, recordsCleared: existingSummary.canonicalCount, migrationStateBeforeCount: migrationBefore.count, migrationStateAfterCount: migrationAfter.ok ? migrationAfter.count : null, inspection });
          return;
        }
        if (!syncAfter.ok || syncAfter.count !== syncBefore.count) {
          done({ ...base, status: "sync-state-count-changed", reason: "syncState count changed during mirror refresh", recordsWritten: refreshed.recordsWritten, recordsCleared: existingSummary.canonicalCount, syncStateBeforeCount: syncBefore.count, syncStateAfterCount: syncAfter.ok ? syncAfter.count : null, inspection });
          return;
        }
        done({
          ...base,
          ok: true,
          status: "mirror-refresh-complete",
          recordsWritten: refreshed.recordsWritten,
          recordsCleared: existingSummary.canonicalCount,
          candidateCount: expectedCandidateCount,
          expectedCandidateCount,
          checksum: expectedChecksum,
          canonicalExistingCount: afterSummary.canonicalCount,
          canonicalChecksum: afterSummary.canonicalChecksum,
          migrationStateBeforeCount: migrationBefore.count,
          migrationStateAfterCount: migrationAfter.count,
          syncStateBeforeCount: syncBefore.count,
          syncStateAfterCount: syncAfter.count,
        });
      } catch (e) {
        done({ ...base, status: "mirror-refresh-failed", reason: String(e && (e.message || e)) || "mirror refresh failed", inspection });
      } finally {
        try { db.close(); } catch {}
      }
    };
    req.onerror = () => {
      const err = req.error;
      done({ ...base, status: "indexeddb-open-failed", reason: String(err && (err.message || err.name || err)) || "IndexedDB open failed", inspection });
    };
    req.onblocked = () => {
      done({ ...base, status: "indexeddb-open-blocked", reason: "opening h2o.library.shared was blocked by another connection", inspection });
    };
  });
}

async function libraryStorageVerifyChatRegistryMirror(payload = {}) {
  const src = payload && typeof payload === "object" ? payload : {};
  const domain = String(src.domain || "").trim();
  const mode = String(src.mode || "").trim();
  const now = new Date().toISOString();
  const base = {
    ok: false,
    phase: "8L",
    domain,
    mode,
    dbName: LIBRARY_SHARED_DB_NAME,
    store: "chatRegistry",
    canonicalReadsEnabled: false,
    canonicalReadEnabled: false,
    dualReadExecutionEnabled: false,
    dualWriteEnabled: false,
    genericReadEnabled: false,
    genericWriteEnabled: false,
    recordsWritten: 0,
    legacyMutated: false,
    migrationStateWritten: false,
    syncStateWritten: false,
    at: now,
  };
  if (domain !== "chatRegistry") {
    return { ...base, status: "unsupported-domain", reason: "only chatRegistry mirror verification is allowed in phase 8L" };
  }
  if (mode && mode !== "mirror-verification") {
    return { ...base, status: "invalid-mode", reason: "mode must be mirror-verification when provided" };
  }
  const inspection = await libraryStorageInspectSchema({ domain: "chatRegistry", mode: "inspect-schema-only" });
  if (!inspection.ok) {
    return { ...base, status: "schema-inspection-failed", reason: inspection.reason || inspection.status || "schema inspection failed", schema: inspection };
  }
  const stores = inspection.stores || {};
  const missingStores = LIBRARY_SHARED_MINIMAL_SCHEMA_STORES.filter((name) => !stores[name] || stores[name].exists !== true);
  if (missingStores.length) {
    return { ...base, status: "required-stores-missing", reason: "required phase 8I stores are missing", missingStores, schema: inspection };
  }
  if (Array.isArray(inspection.unexpectedStores) && inspection.unexpectedStores.length) {
    return { ...base, status: "unexpected-stores-present", reason: "unexpected stores block mirror verification", unexpectedStores: inspection.unexpectedStores.slice(), schema: inspection };
  }
  const schemaVersion = inspection.currentVersion || inspection.version || null;
  if (schemaVersion !== LIBRARY_SHARED_DB_VERSION) {
    return { ...base, status: "db-version-not-1", reason: "h2o.library.shared version must be 1", schema: inspection };
  }

  return new Promise((resolve) => {
    let settled = false;
    let req = null;
    const done = (out) => {
      if (settled) return;
      settled = true;
      resolve(out);
    };
    try {
      req = indexedDB.open(LIBRARY_SHARED_DB_NAME);
    } catch (e) {
      done({ ...base, status: "indexeddb-open-failed", reason: String(e && (e.message || e)) || "IndexedDB open failed", schema: inspection });
      return;
    }
    req.onupgradeneeded = () => {
      try {
        const tx = req.transaction;
        if (tx && typeof tx.abort === "function") tx.abort();
      } catch {}
      try {
        const db = req.result;
        if (db && typeof db.close === "function") db.close();
      } catch {}
      done({ ...base, status: "indexeddb-upgrade-attempted", reason: "mirror verification aborted because IndexedDB attempted to create or upgrade h2o.library.shared", schema: inspection });
    };
    req.onsuccess = async () => {
      const db = req.result;
      try {
        const currentVersion = Number(db.version || 0) || null;
        if (currentVersion !== LIBRARY_SHARED_DB_VERSION) {
          done({ ...base, status: "db-version-not-1", reason: "opened h2o.library.shared version must be 1", currentVersion, schema: inspection });
          return;
        }
        if (!db.objectStoreNames.contains("chatRegistry")) {
          done({ ...base, status: "required-store-missing", reason: "chatRegistry store is missing", currentVersion, schema: inspection });
          return;
        }
        const read = await readChatRegistryMirrorRecords(db);
        if (!read.ok) {
          done({ ...base, status: read.status || "canonical-record-read-failed", reason: read.reason || "failed to read canonical chatRegistry mirror records", currentVersion, schema: inspection });
          return;
        }
        const summary = summarizeChatRegistryMirrorRecords(read.records);
        done({
          ...base,
          ok: true,
          status: "canonical-mirror-read",
          reason: "",
          mode: "mirror-verification",
          currentVersion,
          schema: inspection,
          canonicalCount: summary.canonicalCount,
          canonicalChecksum: summary.canonicalChecksum,
          canonicalChatIds: summary.canonicalChatIds.slice(0, 5000),
          canonicalKeys: summary.canonicalKeys.slice(0, 5000),
          sampleCanonicalChatIds: summary.sampleCanonicalChatIds,
          duplicateChatIds: summary.duplicateChatIds,
          invalidRecords: summary.invalidRecords,
        });
      } catch (e) {
        done({ ...base, status: "mirror-verification-failed", reason: String(e && (e.message || e)) || "mirror verification failed", schema: inspection });
      } finally {
        try { db.close(); } catch {}
      }
    };
    req.onerror = () => {
      const err = req.error;
      done({ ...base, status: "indexeddb-open-failed", reason: String(err && (err.message || err.name || err)) || "IndexedDB open failed", schema: inspection });
    };
    req.onblocked = () => {
      done({ ...base, status: "indexeddb-open-blocked", reason: "opening h2o.library.shared was blocked by another connection", schema: inspection });
    };
  });
}

async function libraryStorageReadChatRegistryRecordDiagnostic(payload = {}) {
  const src = payload && typeof payload === "object" ? payload : {};
  const domain = String(src.domain || "").trim();
  const mode = String(src.mode || "").trim();
  const chatId = String(src.chatId || "").trim();
  const now = new Date().toISOString();
  const base = {
    ok: false,
    phase: "8M",
    domain,
    mode,
    chatId,
    dbName: LIBRARY_SHARED_DB_NAME,
    store: "chatRegistry",
    canonicalReadsEnabled: false,
    canonicalReadEnabled: false,
    dualReadExecutionEnabled: false,
    dualWriteEnabled: false,
    genericReadEnabled: false,
    genericWriteEnabled: false,
    recordsWritten: 0,
    legacyMutated: false,
    migrationStateWritten: false,
    syncStateWritten: false,
    at: now,
  };
  if (domain !== "chatRegistry") {
    return { ...base, status: "unsupported-domain", reason: "only chatRegistry record diagnostics are allowed in phase 8M" };
  }
  if (mode && mode !== "single-record-diagnostic") {
    return { ...base, status: "invalid-mode", reason: "mode must be single-record-diagnostic when provided" };
  }
  if (!chatId) {
    return { ...base, status: "missing-chatId", reason: "chatId is required for single-record canonical diagnostics" };
  }

  const inspection = await libraryStorageInspectSchema({ domain: "chatRegistry", mode: "inspect-schema-only" });
  if (!inspection.ok) {
    return { ...base, status: "schema-inspection-failed", reason: inspection.reason || inspection.status || "schema inspection failed", schema: inspection };
  }
  const stores = inspection.stores || {};
  const missingStores = LIBRARY_SHARED_MINIMAL_SCHEMA_STORES.filter((name) => !stores[name] || stores[name].exists !== true);
  if (missingStores.length) {
    return { ...base, status: "required-stores-missing", reason: "required phase 8I stores are missing", missingStores, schema: inspection };
  }
  const schemaVersion = inspection.currentVersion || inspection.version || null;
  if (schemaVersion !== LIBRARY_SHARED_DB_VERSION) {
    return { ...base, status: "db-version-not-1", reason: "h2o.library.shared version must be 1", schema: inspection };
  }

  return new Promise((resolve) => {
    let settled = false;
    let req = null;
    const done = (out) => {
      if (settled) return;
      settled = true;
      resolve(out);
    };
    try {
      req = indexedDB.open(LIBRARY_SHARED_DB_NAME);
    } catch (e) {
      done({ ...base, status: "indexeddb-open-failed", reason: String(e && (e.message || e)) || "IndexedDB open failed", schema: inspection });
      return;
    }
    req.onupgradeneeded = () => {
      try {
        const tx = req.transaction;
        if (tx && typeof tx.abort === "function") tx.abort();
      } catch {}
      try {
        const db = req.result;
        if (db && typeof db.close === "function") db.close();
      } catch {}
      done({ ...base, status: "indexeddb-upgrade-attempted", reason: "record diagnostic aborted because IndexedDB attempted to create or upgrade h2o.library.shared", schema: inspection });
    };
    req.onsuccess = async () => {
      const db = req.result;
      try {
        const currentVersion = Number(db.version || 0) || null;
        if (currentVersion !== LIBRARY_SHARED_DB_VERSION) {
          done({ ...base, status: "db-version-not-1", reason: "opened h2o.library.shared version must be 1", currentVersion, schema: inspection });
          return;
        }
        if (!db.objectStoreNames.contains("chatRegistry")) {
          done({ ...base, status: "required-store-missing", reason: "chatRegistry store is missing", currentVersion, schema: inspection });
          return;
        }
        const read = await readChatRegistryMirrorRecord(db, chatId);
        if (!read.ok) {
          done({ ...base, status: read.status || "canonical-record-read-failed", reason: read.reason || "failed to read canonical chatRegistry mirror record", currentVersion, schema: inspection });
          return;
        }
        done({
          ...base,
          ok: true,
          status: read.found ? "canonical-record-read" : "canonical-record-missing",
          mode: "single-record-diagnostic",
          currentVersion,
          schema: inspection,
          canonicalFound: read.found === true,
          canonicalRecordSummary: read.recordSummary || summarizeChatRegistryRecordForDiagnostic(null),
        });
      } catch (e) {
        done({ ...base, status: "canonical-record-diagnostic-failed", reason: String(e && (e.message || e)) || "canonical record diagnostic failed", schema: inspection });
      } finally {
        try { db.close(); } catch {}
      }
    };
    req.onerror = () => {
      const err = req.error;
      done({ ...base, status: "indexeddb-open-failed", reason: String(err && (err.message || err.name || err)) || "IndexedDB open failed", schema: inspection });
    };
    req.onblocked = () => {
      done({ ...base, status: "indexeddb-open-blocked", reason: "opening h2o.library.shared was blocked by another connection", schema: inspection });
    };
  });
}

async function libraryStorageReadChatRegistryMirrorAllDiagnostic(payload = {}) {
  const src = payload && typeof payload === "object" ? payload : {};
  const domain = String(src.domain || "").trim();
  const mode = String(src.mode || "").trim();
  const maxRecordsRaw = Number(src.maxRecords);
  const maxRecords = Number.isFinite(maxRecordsRaw) && maxRecordsRaw > 0
    ? Math.min(100, Math.floor(maxRecordsRaw))
    : 100;
  const now = new Date().toISOString();
  const base = {
    ok: false,
    phase: "8N",
    domain,
    mode,
    dbName: LIBRARY_SHARED_DB_NAME,
    store: "chatRegistry",
    maxRecords,
    canonicalReadsEnabled: false,
    canonicalReadEnabled: false,
    dualReadExecutionEnabled: false,
    dualWriteEnabled: false,
    genericReadEnabled: false,
    genericWriteEnabled: false,
    recordsWritten: 0,
    legacyMutated: false,
    migrationStateWritten: false,
    syncStateWritten: false,
    at: now,
  };
  if (domain !== "chatRegistry") {
    return { ...base, status: "unsupported-domain", reason: "only chatRegistry full mirror diagnostics are allowed in phase 8N" };
  }
  if (mode && mode !== "full-mirror-read-diagnostic") {
    return { ...base, status: "invalid-mode", reason: "mode must be full-mirror-read-diagnostic when provided" };
  }

  const inspection = await libraryStorageInspectSchema({ domain: "chatRegistry", mode: "inspect-schema-only" });
  if (!inspection.ok) {
    return { ...base, status: "schema-inspection-failed", reason: inspection.reason || inspection.status || "schema inspection failed", schema: inspection };
  }
  const stores = inspection.stores || {};
  const missingStores = LIBRARY_SHARED_MINIMAL_SCHEMA_STORES.filter((name) => !stores[name] || stores[name].exists !== true);
  if (missingStores.length) {
    return { ...base, status: "required-stores-missing", reason: "required phase 8I stores are missing", missingStores, schema: inspection };
  }
  if (Array.isArray(inspection.unexpectedStores) && inspection.unexpectedStores.length) {
    return { ...base, status: "unexpected-stores-present", reason: "unexpected stores block full mirror diagnostics", unexpectedStores: inspection.unexpectedStores.slice(), schema: inspection };
  }
  const schemaVersion = inspection.currentVersion || inspection.version || null;
  if (schemaVersion !== LIBRARY_SHARED_DB_VERSION) {
    return { ...base, status: "db-version-not-1", reason: "h2o.library.shared version must be 1", schema: inspection };
  }
  const chatRegistryCount = stores.chatRegistry && typeof stores.chatRegistry.count === "number" ? stores.chatRegistry.count : null;
  if (typeof chatRegistryCount === "number" && chatRegistryCount > maxRecords) {
    return {
      ...base,
      status: "canonical-store-too-large-for-phase-8n",
      reason: "chatRegistry full mirror read diagnostic is bounded and refuses to read more than " + maxRecords + " records",
      canonicalCount: chatRegistryCount,
      schema: inspection,
    };
  }

  return new Promise((resolve) => {
    let settled = false;
    let req = null;
    const done = (out) => {
      if (settled) return;
      settled = true;
      resolve(out);
    };
    try {
      req = indexedDB.open(LIBRARY_SHARED_DB_NAME);
    } catch (e) {
      done({ ...base, status: "indexeddb-open-failed", reason: String(e && (e.message || e)) || "IndexedDB open failed", schema: inspection });
      return;
    }
    req.onupgradeneeded = () => {
      try {
        const tx = req.transaction;
        if (tx && typeof tx.abort === "function") tx.abort();
      } catch {}
      try {
        const db = req.result;
        if (db && typeof db.close === "function") db.close();
      } catch {}
      done({ ...base, status: "indexeddb-upgrade-attempted", reason: "full mirror diagnostic aborted because IndexedDB attempted to create or upgrade h2o.library.shared", schema: inspection });
    };
    req.onsuccess = async () => {
      const db = req.result;
      try {
        const currentVersion = Number(db.version || 0) || null;
        if (currentVersion !== LIBRARY_SHARED_DB_VERSION) {
          done({ ...base, status: "db-version-not-1", reason: "opened h2o.library.shared version must be 1", currentVersion, schema: inspection });
          return;
        }
        if (!db.objectStoreNames.contains("chatRegistry")) {
          done({ ...base, status: "required-store-missing", reason: "chatRegistry store is missing", currentVersion, schema: inspection });
          return;
        }
        const read = await readChatRegistryMirrorRecords(db, maxRecords, "8n");
        if (!read.ok) {
          done({ ...base, status: read.status || "canonical-record-read-failed", reason: read.reason || "failed to read canonical chatRegistry mirror records", currentVersion, schema: inspection, canonicalRecordSummaries: (read.records || []).map(summarizeChatRegistryRecordForDiagnostic) });
          return;
        }
        const summary = summarizeChatRegistryMirrorRecords(read.records);
        done({
          ...base,
          ok: true,
          status: "canonical-mirror-all-read",
          reason: "",
          mode: "full-mirror-read-diagnostic",
          currentVersion,
          schema: inspection,
          canonicalCount: summary.canonicalCount,
          canonicalChecksum: summary.canonicalChecksum,
          canonicalChatIds: summary.canonicalChatIds.slice(0, maxRecords),
          canonicalKeys: summary.canonicalKeys.slice(0, maxRecords),
          sampleCanonicalChatIds: summary.sampleCanonicalChatIds,
          duplicateChatIds: summary.duplicateChatIds,
          invalidRecords: summary.invalidRecords,
          canonicalRecordSummaries: read.records.map(summarizeChatRegistryRecordForDiagnostic),
        });
      } catch (e) {
        done({ ...base, status: "full-mirror-read-diagnostic-failed", reason: String(e && (e.message || e)) || "full mirror read diagnostic failed", schema: inspection });
      } finally {
        try { db.close(); } catch {}
      }
    };
    req.onerror = () => {
      const err = req.error;
      done({ ...base, status: "indexeddb-open-failed", reason: String(err && (err.message || err.name || err)) || "IndexedDB open failed", schema: inspection });
    };
    req.onblocked = () => {
      done({ ...base, status: "indexeddb-open-blocked", reason: "opening h2o.library.shared was blocked by another connection", schema: inspection });
    };
  });
}

async function handleArchiveMessage(msg) {
  const req = msg && msg.req && typeof msg.req === "object" ? msg.req : {};
  const op = String(req.op || "").trim();
  const payload = req.payload && typeof req.payload === "object" ? req.payload : {};
  const nsDisk = normalizeNsDisk(payload.nsDisk || req.nsDisk);

  // Library KV ops are namespace-isolated from archive snapshots and skip the rest of
  // the archive-specific routing (nsDisk, snapshot helpers, etc.). One-line dispatch.
  if (LIBRARY_KV_OP_SET[op]) return libraryKvHandle(op, payload);

  if (op === LIBRARY_STORAGE_DIAG_OP || op === "libraryStorageDiagnose") {
    return { ok: true, result: await libraryStorageDiagnose() };
  }
  if (op === LIBRARY_STORAGE_CREATE_EMPTY_SCHEMA_OP || op === "libraryStorageCreateEmptySchema") {
    return { ok: true, result: await libraryStorageCreateEmptySchema(payload) };
  }
  if (op === LIBRARY_STORAGE_INSPECT_SCHEMA_OP || op === "libraryStorageInspectSchema") {
    return { ok: true, result: await libraryStorageInspectSchema(payload) };
  }
  if (op === LIBRARY_STORAGE_WRITE_CHAT_REGISTRY_MIRROR_OP || op === "libraryStorageWriteChatRegistryMirror") {
    return { ok: true, result: await libraryStorageWriteChatRegistryMirror(payload) };
  }
  if (op === LIBRARY_STORAGE_REFRESH_CHAT_REGISTRY_MIRROR_OP || op === "libraryStorageRefreshChatRegistryMirror") {
    return { ok: true, result: await libraryStorageRefreshChatRegistryMirror(payload) };
  }
  if (op === LIBRARY_STORAGE_VERIFY_CHAT_REGISTRY_MIRROR_OP || op === "libraryStorageVerifyChatRegistryMirror") {
    return { ok: true, result: await libraryStorageVerifyChatRegistryMirror(payload) };
  }
  if (op === LIBRARY_STORAGE_READ_CHAT_REGISTRY_RECORD_DIAG_OP || op === "libraryStorageReadChatRegistryRecordDiagnostic") {
    return { ok: true, result: await libraryStorageReadChatRegistryRecordDiagnostic(payload) };
  }
  if (op === LIBRARY_STORAGE_READ_CHAT_REGISTRY_MIRROR_ALL_DIAG_OP || op === "libraryStorageReadChatRegistryMirrorAllDiagnostic") {
    return { ok: true, result: await libraryStorageReadChatRegistryMirrorAllDiagnostic(payload) };
  }

  if (op === "ping") {
    return {
      ok: true,
      result: {
        ok: true,
        source: "sw",
        db: DB_NAME,
        version: DB_VERSION,
        supportedOps: ARCHIVE_RUNTIME_OPS.slice(),
      },
    };
  }
  if (op === "getBootMode") {
    return { ok: true, result: { mode: await getBootMode(payload.chatId, nsDisk) } };
  }
  if (op === "setBootMode") {
    return { ok: true, result: { mode: await setBootMode(payload.chatId, payload.mode, nsDisk) } };
  }
  if (op === "getMigratedFlag") {
    return { ok: true, result: { migrated: await getMigratedFlag(payload.chatId, nsDisk) } };
  }
  if (op === "setMigratedFlag") {
    return { ok: true, result: { migrated: await setMigratedFlag(payload.chatId, payload.migrated !== false, nsDisk) } };
  }
  if (op === "getChatIndex") {
    return { ok: true, result: { chatIndex: await getChatIndex(payload.chatId, nsDisk) } };
  }
  if (op === "setChatIndex") {
    return { ok: true, result: { chatIndex: await setChatIndex(payload.chatId, payload.chatIndex, nsDisk) } };
  }
  if (op === "captureSnapshot") {
    const res = await captureSnapshotInternal(payload.chatId, payload.messages, payload.meta, {}, nsDisk);
    return { ok: true, result: res };
  }
  if (op === "loadLatestSnapshot") {
    return { ok: true, result: await loadLatestSnapshot(payload.chatId, nsDisk) };
  }
  if (op === "loadSnapshot") {
    const loaded = await loadSnapshotById(payload.snapshotId);
    if (!loaded) return { ok: true, result: null };
    return { ok: true, result: buildLoadedSnapshotResponse(loaded, await readCategoryCatalog(nsDisk)) };
  }
  if (op === "listSnapshots") {
    return { ok: true, result: await listSnapshots(payload.chatId, nsDisk) };
  }
  if (op === "listAllChatIds" || op === "listChatIds") {
    return { ok: true, result: await listAllChatIds(nsDisk) };
  }
  if (op === "listWorkbenchRows") {
    return { ok: true, result: await listWorkbenchRows(nsDisk) };
  }
  if (op === "getFoldersList") {
    return { ok: true, result: await getFoldersListBridge(nsDisk) };
  }
  if (op === "resolveFolderBindings") {
    return { ok: true, result: await resolveFolderBindingsBridge(payload.chatIds, nsDisk) };
  }
  if (op === "setFolderBinding") {
    return { ok: true, result: await setFolderBindingBridge(payload.chatId, payload.folderId, nsDisk) };
  }
  if (op === "setFolderIconColor") {
    return { ok: true, result: await setFolderIconColorBridge(payload.folderId, payload.iconColor || payload.color || "", nsDisk) };
  }
  if (op === "upsertLatestSnapshotMeta") {
    return { ok: true, result: await upsertLatestSnapshotMeta(payload.chatId, payload.patch, payload.opts, nsDisk) };
  }
  if (op === "getLabelsCatalog") {
    return { ok: true, result: await readLabelCatalog(nsDisk) };
  }
  if (op === "getCategoriesCatalog") {
    return { ok: true, result: await readCategoryCatalog(nsDisk) };
  }
  if (op === "renameCategory") {
    return { ok: true, result: await renameCategory(payload.categoryId || payload.id, payload.name || payload.nextName, nsDisk) };
  }
  if (op === "deleteCategory") {
    return { ok: true, result: await deleteCategory(payload.categoryId || payload.id, nsDisk) };
  }
  if (op === "setSnapshotCategory") {
    return { ok: true, result: await setSnapshotCategory(payload.snapshotId, payload.primaryCategoryId, nsDisk) };
  }
  if (op === "reclassifySnapshotCategory") {
    return { ok: true, result: await reclassifySnapshotCategory(payload.snapshotId, nsDisk) };
  }
  if (op === "pinSnapshot") {
    return { ok: true, result: await pinSnapshot(payload.chatId, payload.snapshotId, payload.pinned !== false, nsDisk) };
  }
  if (op === "deleteSnapshot") {
    return { ok: true, result: await deleteSnapshot(payload.chatId, payload.snapshotId, nsDisk) };
  }
  if (op === "applyRetention") {
    return { ok: true, result: await applyRetention(payload.chatId, nsDisk) };
  }
  if (op === "openWorkbench") {
    return { ok: true, result: await openWorkbench(payload.route) };
  }
  if (op === "exportBundle") {
    return { ok: true, result: await exportBundle(payload.scope, payload.chatId, nsDisk) };
  }
  if (op === "importBundle") {
    return { ok: true, result: await importBundle(payload.bundle, payload.mode, nsDisk) };
  }
  if (op === "fetchPageMetadata") {
    return { ok: true, result: await fetchPageMetadata(payload || {}) };
  }
  if (op === "exportFullBundle") {
    return { ok: true, result: await exportFullBundle(payload || {}, nsDisk) };
  }
  if (op === "dryRunImportFullBundle") {
    return { ok: true, result: await dryRunImportFullBundle(payload && payload.bundle, nsDisk) };
  }
  if (op === "importFullBundle") {
    return { ok: true, result: await importFullBundle(payload && payload.bundle, payload && payload.mode, nsDisk) };
  }

  return { ok: false, error: "unsupported op" };
}

async function handleExternalArchiveMessage(msg) {
  const req = msg && typeof msg.req === "object" ? msg.req : {};
  const op = String(req.op || "").trim();
  const payload = req.payload && typeof req.payload === "object" ? req.payload : {};
  const nsDisk = normalizeNsDisk(payload.nsDisk || req.nsDisk);

  if (op === "ping") {
    return {
      ok: true,
      result: {
        ok: true,
        source: "sw",
        external: true,
        supportedOps: ["ping", "exportBundle"],
      },
    };
  }

  if (op === "exportBundle") {
    return {
      ok: true,
      result: await exportBundle(payload.scope || "all", payload.chatId, nsDisk),
    };
  }

  return { ok: false, error: "unsupported external op" };
}

// ── Identity Phase 3.0A: AuthSessionManager boundary (mock-only) ───────────
// Background-owned identity runtime with three explicit internal layers:
// - identityRuntime_*: storage and consistency for the mock runtime
// - identityMockProvider_*: provider-shaped mock operations, no network
// - identityAuthManager_*: bridge orchestration, snapshot sync, and publishing

function identityRuntime_nowIso() { return new Date().toISOString(); }

function identityRuntime_makeMockId(prefix) {
  const s = String(prefix || "id").replace(/[^a-z0-9_-]/gi, "").toLowerCase() || "id";
  return s + "_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 9);
}

function identityRuntime_maskEmail(email) {
  const e = String(email || "").trim().toLowerCase();
  const at = e.indexOf("@");
  if (at < 1) return "***@***";
  const local = e.slice(0, at);
  const domain = e.slice(at + 1);
  const visible = local.length <= 2 ? (local[0] || "*") : local[0] + local[local.length - 1];
  return visible + "***@" + domain;
}

function identitySnapshot_sanitize(obj) {
  if (!obj || typeof obj !== "object") return obj;
  const clean = {};
  for (const [k, v] of Object.entries(obj)) {
    if (k !== "credentialState" && k !== "credentialProvider" && /token|secret|password|refresh|credential/i.test(k)) continue;
    clean[k] = v;
  }
  return clean;
}

const IDENTITY_PROVIDER_CONFIG_SCHEMA_VERSION = "3.0N";
const IDENTITY_PROVIDER_CONFIG_INJECTED_STATUS = ${JSON.stringify(IDENTITY_PROVIDER_CONFIG_STATUS_SAFE)};

const IDENTITY_PROVIDER_CONFIG_DEFAULT = Object.freeze({
  schemaVersion: IDENTITY_PROVIDER_CONFIG_SCHEMA_VERSION,
  providerKind: "mock",
  providerMode: "local_dev",
  providerConfigured: true,
  configSource: "built_in_mock",
  valid: true,
  validationState: "valid",
  missingFields: Object.freeze([]),
  errorCodes: Object.freeze([]),
  capabilities: Object.freeze({
    emailOtp: true,
    magicLink: false,
    oauth: false,
    oauthProviders: Object.freeze([])
  })
});

const IDENTITY_PROVIDER_CONFIG_SAFE_SOURCES = Object.freeze([
  "built_in_mock",
  "dev_empty_invalid",
  "dev_elevated_invalid",
  "dev_env",
  "dev_local_file"
]);

const IDENTITY_PROVIDER_CONFIG_DEV_ONLY_SOURCES = Object.freeze({
  dev_empty_invalid: Object.freeze({
    configSource: "dev_empty_invalid",
    providerKind: "supabase",
    providerMode: "provider_backed"
  }),
  dev_elevated_invalid: Object.freeze({
    configSource: "dev_elevated_invalid",
    providerKind: "supabase",
    providerMode: "provider_backed",
    accessClass: "server_side"
  })
});

const IDENTITY_PROVIDER_CONFIG_GENERIC_REQUIREMENTS = Object.freeze({
  supabase: Object.freeze(["provider_project", "public_client"])
});

const IDENTITY_PROVIDER_CONFIG_REJECTION_CODES = Object.freeze({
  missingRequired: "identity/config-missing-required",
  elevatedAccess: "identity/config-elevated-access-forbidden"
});

const IDENTITY_PROVIDER_PERMISSION_READINESS_DEFERRED = Object.freeze({
  permissionRequired: "deferred",
  permissionReady: false,
  permissionSource: "deferred_until_project_host",
  permissionHostKind: "none",
  permissionStatus: "deferred",
  permissionErrorCode: null,
  networkReady: false
});
const IDENTITY_PROVIDER_PHASE_NETWORK_ENABLED = IDENTITY_PROVIDER_PHASE_NETWORK === "request_otp";
const IDENTITY_PROVIDER_OAUTH_GOOGLE_ENABLED = IDENTITY_PROVIDER_OAUTH_PROVIDER === "google";
const IDENTITY_PROVIDER_OAUTH_REDIRECT_PATH = "identity/oauth/google";
const IDENTITY_PROVIDER_OAUTH_FLOW_MAX_AGE_MS = 10 * 60 * 1000;

const IDENTITY_PROVIDER_CONFIG_ELEVATED_MARKERS = Object.freeze([
  "server_side",
  "admin_client",
  "privileged_access"
]);

function identityProviderConfig_cleanStatusList(items) {
  return Array.isArray(items)
    ? items.map(item => String(item || "").replace(/[^a-z0-9_/-]/gi, "").slice(0, 96)).filter(Boolean)
    : [];
}

function identityProviderConfig_isRedactedStatus(config) {
  return Boolean(config && typeof config === "object"
    && config.schemaVersion === IDENTITY_PROVIDER_CONFIG_SCHEMA_VERSION
    && Object.prototype.hasOwnProperty.call(config, "valid")
    && Array.isArray(config.missingFields)
    && Array.isArray(config.errorCodes));
}

function identityProviderConfig_normalizeInjectedStatus(status) {
  const src = status && typeof status === "object" ? status : null;
  if (!identityProviderConfig_isRedactedStatus(src)) return null;
  const configSource = identityProviderConfig_normalizeSourceName(src.configSource);
  if (configSource !== "dev_env" && configSource !== "dev_local_file") return null;
  const missingFields = identityProviderConfig_cleanStatusList(src.missingFields)
    .map(field => field.replace(/[^a-z0-9_-]/gi, "").slice(0, 64))
    .filter(Boolean);
  const errorCodes = identityProviderConfig_cleanStatusList(src.errorCodes);
  const valid = src.valid === true && missingFields.length === 0 && errorCodes.length === 0;
  const caps = src.capabilities && typeof src.capabilities === "object" ? src.capabilities : {};
  return {
    schemaVersion: IDENTITY_PROVIDER_CONFIG_SCHEMA_VERSION,
    providerKind: "supabase",
    providerMode: "provider_backed",
    providerConfigured: valid,
    configSource,
    valid,
    validationState: valid
      ? "valid"
      : String(src.validationState || "rejected").replace(/[^a-z0-9_-]/gi, "").slice(0, 64) || "rejected",
    missingFields,
    errorCodes,
    capabilities: {
      emailOtp: true,
      magicLink: Boolean(caps.magicLink) && false,
      oauth: Boolean(caps.oauth) && IDENTITY_PROVIDER_OAUTH_GOOGLE_ENABLED,
      oauthProviders: Boolean(caps.oauth) && IDENTITY_PROVIDER_OAUTH_GOOGLE_ENABLED ? ["google"] : []
    }
  };
}

function identityProviderConfig_validatePublicClientConfig(config) {
  const cfg = (config && typeof config === "object") ? config : {};
  const missingFields = identityProviderConfig_missingFields({ ...cfg, providerKind: "supabase" });
  const markers = [
    cfg.accessClass,
    cfg.providerAccess,
    cfg.elevatedAccess
  ].map(value => String(value || "").trim().toLowerCase()).filter(Boolean);
  const errorCodes = [];
  const hasElevatedMarker = markers.some(value => IDENTITY_PROVIDER_CONFIG_ELEVATED_MARKERS.includes(value));
  if (missingFields.length) errorCodes.push(IDENTITY_PROVIDER_CONFIG_REJECTION_CODES.missingRequired);
  if (hasElevatedMarker) {
    errorCodes.push(IDENTITY_PROVIDER_CONFIG_REJECTION_CODES.elevatedAccess);
  }
  return {
    valid: errorCodes.length === 0 && missingFields.length === 0,
    validationState: errorCodes.length
      ? (hasElevatedMarker ? "rejected" : "missing_config")
      : "valid",
    missingFields,
    errorCodes: identityProviderConfig_cleanStatusList(errorCodes)
  };
}

function identityProviderConfig_validateSupabaseShape(config) {
  return identityProviderConfig_validatePublicClientConfig(config);
}

function identityProviderConfig_classifyConfig(config) {
  const cfg = (config && typeof config === "object") ? config : {};
  const providerKind = cfg.providerKind === "supabase" ? "supabase" : "mock";
  if (providerKind !== "supabase") {
    return {
      providerKind: "mock",
      providerMode: "local_dev",
      providerConfigured: true,
      valid: true,
      validationState: "valid",
      missingFields: [],
      errorCodes: []
    };
  }
  const validation = identityProviderConfig_validateSupabaseShape({ ...cfg, providerKind });
  return {
    providerKind,
    providerMode: "provider_backed",
    providerConfigured: validation.valid === true && validation.missingFields.length === 0,
    valid: validation.valid === true,
    validationState: validation.validationState || "rejected",
    missingFields: identityProviderConfig_cleanStatusList(validation.missingFields),
    errorCodes: identityProviderConfig_cleanStatusList(validation.errorCodes)
  };
}

function identityProviderConfig_get() {
  return identityProviderConfig_resolve();
}

function identityProviderConfig_normalizeSourceName(input) {
  const value = String(input || "").trim().toLowerCase().replace(/[^a-z0-9_-]/g, "");
  return IDENTITY_PROVIDER_CONFIG_SAFE_SOURCES.includes(value) ? value : "built_in_mock";
}

function identityProviderConfig_getSource() {
  const injected = identityProviderConfig_getInjectedSource();
  if (injected) return injected;
  return {
    configSource: "built_in_mock",
    providerKind: "mock",
    providerMode: "local_dev"
  };
}

function identityProviderConfig_getDevOnlySource(kind) {
  const sourceName = identityProviderConfig_normalizeSourceName(kind);
  const source = IDENTITY_PROVIDER_CONFIG_DEV_ONLY_SOURCES[sourceName];
  return source ? { ...source } : null;
}

function identityProviderConfig_getInjectedSource() {
  return identityProviderConfig_normalizeInjectedStatus(IDENTITY_PROVIDER_CONFIG_INJECTED_STATUS);
}

function identityProviderConfig_getSourceStatus(source = identityProviderConfig_getSource()) {
  return identityProviderConfig_safeStatus(identityProviderConfig_resolve(source));
}

function identityProviderConfig_resolve(source = identityProviderConfig_getSource()) {
  const sourceName = typeof source === "string" ? identityProviderConfig_normalizeSourceName(source) : "";
  const devSource = sourceName ? identityProviderConfig_getDevOnlySource(sourceName) : null;
  const src = devSource || ((source && typeof source === "object") ? source : {});
  if (identityProviderConfig_isRedactedStatus(src)) {
    return identityProviderConfig_safeStatus(src);
  }
  return identityProviderConfig_validateShape({
    ...IDENTITY_PROVIDER_CONFIG_DEFAULT,
    providerKind: src.providerKind || IDENTITY_PROVIDER_CONFIG_DEFAULT.providerKind,
    providerMode: src.providerMode || IDENTITY_PROVIDER_CONFIG_DEFAULT.providerMode,
    configSource: src.configSource || IDENTITY_PROVIDER_CONFIG_DEFAULT.configSource,
    accessClass: src.accessClass
  });
}

function identityProviderConfig_missingFields(config) {
  const cfg = (config && typeof config === "object") ? config : {};
  if (cfg.providerKind !== "supabase") return [];
  return [...IDENTITY_PROVIDER_CONFIG_GENERIC_REQUIREMENTS.supabase];
}

function identityProviderConfig_validateShape(config) {
  const cfg = (config && typeof config === "object") ? config : {};
  const redacted = identityProviderConfig_normalizeInjectedStatus(cfg);
  if (redacted) return redacted;
  const classified = identityProviderConfig_classifyConfig(cfg);
  const providerKind = classified.providerKind;
  const providerMode = classified.providerMode;
  const caps = (cfg.capabilities && typeof cfg.capabilities === "object") ? cfg.capabilities : {};
  return {
    schemaVersion: IDENTITY_PROVIDER_CONFIG_SCHEMA_VERSION,
    providerKind,
    providerMode,
    providerConfigured: Boolean(classified.providerConfigured),
    configSource: identityProviderConfig_normalizeSourceName(cfg.configSource),
    valid: classified.valid === true,
    validationState: classified.validationState || "rejected",
    missingFields: identityProviderConfig_cleanStatusList(classified.missingFields),
    errorCodes: identityProviderConfig_cleanStatusList(classified.errorCodes),
    capabilities: {
      emailOtp: providerKind === "supabase" ? true : Boolean(caps.emailOtp),
      magicLink: false,
      oauth: providerKind === "supabase" && IDENTITY_PROVIDER_OAUTH_GOOGLE_ENABLED && Boolean(caps.oauth),
      oauthProviders: providerKind === "supabase" && IDENTITY_PROVIDER_OAUTH_GOOGLE_ENABLED && Boolean(caps.oauth)
        ? ["google"]
        : []
    }
  };
}

function identityProviderConfig_getMode() {
  return identityProviderConfig_get().providerMode || "local_dev";
}

function identityProviderConfig_isMock(config = identityProviderConfig_get()) {
  return identityProviderConfig_validateShape(config).providerKind === "mock";
}

function identityProviderConfig_isSupabaseConfigured(config = identityProviderConfig_get()) {
  const cfg = identityProviderConfig_validateShape(config);
  return cfg.providerKind === "supabase"
    && cfg.providerConfigured === true
    && cfg.valid === true
    && cfg.missingFields.length === 0
    && cfg.errorCodes.length === 0;
}

function identityProviderPermission_getExactHostPattern() {
  const value = String(IDENTITY_PROVIDER_OPTIONAL_HOST_PATTERN || "").trim().toLowerCase();
  return /^https:\\/\\/[a-z0-9-]+\\.supabase\\.co\\/\\*$/.test(value) ? value : "";
}

function identityProviderPermission_hasExactHostConfig() {
  const injected = identityProviderConfig_getInjectedSource();
  return Boolean(injected
    && identityProviderConfig_isSupabaseConfigured(injected)
    && identityProviderPermission_getExactHostPattern());
}

function identityProviderPermission_makeExactReadiness(permissionReady, errorCode = null) {
  const ready = permissionReady === true;
  return {
    permissionRequired: true,
    permissionReady: ready,
    permissionSource: "optional_host_permission",
    permissionHostKind: "exact_supabase_project",
    permissionStatus: ready ? "granted" : "not_granted",
    permissionErrorCode: identityProviderBundle_sanitizeSmokeError(errorCode),
    networkReady: false
  };
}

function identityProviderPermission_getReadiness() {
  if (identityProviderPermission_hasExactHostConfig()) {
    return identityProviderPermission_makeExactReadiness(false);
  }
  return {
    permissionRequired: IDENTITY_PROVIDER_PERMISSION_READINESS_DEFERRED.permissionRequired,
    permissionReady: IDENTITY_PROVIDER_PERMISSION_READINESS_DEFERRED.permissionReady,
    permissionSource: IDENTITY_PROVIDER_PERMISSION_READINESS_DEFERRED.permissionSource,
    permissionHostKind: IDENTITY_PROVIDER_PERMISSION_READINESS_DEFERRED.permissionHostKind,
    permissionStatus: IDENTITY_PROVIDER_PERMISSION_READINESS_DEFERRED.permissionStatus,
    permissionErrorCode: IDENTITY_PROVIDER_PERMISSION_READINESS_DEFERRED.permissionErrorCode,
    networkReady: IDENTITY_PROVIDER_PERMISSION_READINESS_DEFERRED.networkReady
  };
}

function identityProviderPermission_containsExactHost() {
  const origin = identityProviderPermission_getExactHostPattern();
  if (!origin || !identityProviderPermission_hasExactHostConfig()) {
    return Promise.resolve(identityProviderPermission_getReadiness());
  }
  if (typeof chrome === "undefined" || !chrome.permissions || typeof chrome.permissions.contains !== "function") {
    return Promise.resolve(identityProviderPermission_makeExactReadiness(false, "identity/permission-api-unavailable"));
  }
  return new Promise((resolve) => {
    try {
      chrome.permissions.contains({ origins: [origin] }, (granted) => {
        const lastError = chrome.runtime && chrome.runtime.lastError;
        resolve(identityProviderPermission_makeExactReadiness(
          granted === true,
          lastError ? "identity/permission-check-failed" : null
        ));
      });
    } catch (_) {
      resolve(identityProviderPermission_makeExactReadiness(false, "identity/permission-check-failed"));
    }
  });
}

async function identityProviderPermission_getReadinessAsync() {
  if (!identityProviderPermission_hasExactHostConfig()) return identityProviderPermission_getReadiness();
  return identityProviderPermission_containsExactHost();
}

async function identityProviderPermission_requestExactHost() {
  const origin = identityProviderPermission_getExactHostPattern();
  if (!origin || !identityProviderPermission_hasExactHostConfig()) {
    return {
      ok: false,
      ...identityProviderPermission_getReadiness(),
      errorCode: "identity/permission-exact-host-unavailable"
    };
  }
  if (typeof chrome === "undefined" || !chrome.permissions || typeof chrome.permissions.request !== "function") {
    return {
      ok: false,
      ...identityProviderPermission_makeExactReadiness(false, "identity/permission-api-unavailable"),
      errorCode: "identity/permission-api-unavailable"
    };
  }
  return new Promise((resolve) => {
    try {
      chrome.permissions.request({ origins: [origin] }, (granted) => {
        const lastError = chrome.runtime && chrome.runtime.lastError;
        const readiness = identityProviderPermission_makeExactReadiness(
          granted === true,
          lastError ? "identity/permission-request-failed" : null
        );
        resolve({
          ok: granted === true && !lastError,
          ...readiness,
          errorCode: readiness.permissionErrorCode
        });
      });
    } catch (_) {
      const readiness = identityProviderPermission_makeExactReadiness(false, "identity/permission-request-failed");
      resolve({ ok: false, ...readiness, errorCode: readiness.permissionErrorCode });
    }
  });
}

function identityProviderPermission_isPopupSender(sender) {
  try {
    const expected = chrome.runtime.getURL("popup.html");
    const actual = String(sender && sender.url || "");
    return actual === expected || actual.startsWith(expected + "?") || actual.startsWith(expected + "#");
  } catch (_) {
    return false;
  }
}

function identityProviderPermission_makeRequestResponse(result, fallbackCode = null) {
  const src = result && typeof result === "object" ? result : {};
  const permissionReady = src.permissionReady === true;
  const status = src.permissionStatus === "granted"
    ? "granted"
    : (src.permissionStatus === "not_granted" ? "not_granted" : "deferred");
  const hostKind = src.permissionHostKind === "exact_supabase_project"
    ? "exact_supabase_project"
    : "none";
  const errorCode = identityProviderBundle_sanitizeSmokeError(
    src.errorCode || src.permissionErrorCode || fallbackCode
  );
  return {
    ok: src.ok === true && permissionReady === true,
    permissionReady,
    permissionStatus: status,
    permissionHostKind: hostKind,
    errorCode
  };
}

async function identityProviderPermission_requestExactHostFromPopup(sender) {
  if (!identityProviderPermission_isPopupSender(sender)) {
    return identityProviderPermission_makeRequestResponse(null, "identity/permission-popup-required");
  }
  if (IDENTITY_PROVIDER_PHASE_NETWORK_ENABLED !== true) {
    return identityProviderPermission_makeRequestResponse({
      ok: false,
      ...identityProviderPermission_getReadiness(),
      errorCode: "identity/network-not-enabled"
    });
  }
  if (!identityProviderPermission_hasExactHostConfig()) {
    return identityProviderPermission_makeRequestResponse({
      ok: false,
      ...identityProviderPermission_getReadiness(),
      errorCode: "identity/permission-exact-host-unavailable"
    });
  }
  return identityProviderPermission_makeRequestResponse(await identityProviderPermission_requestExactHost());
}

function identityProviderNetwork_getReadiness(input = {}) {
  const src = input && typeof input === "object" ? input : {};
  const phaseNetworkEnabled = IDENTITY_PROVIDER_PHASE_NETWORK_ENABLED === true;
  const networkReady = Boolean(
    src.providerConfigured === true
      && src.clientReady === true
      && src.permissionReady === true
      && phaseNetworkEnabled
  );
  return {
    phaseNetworkEnabled,
    networkReady,
    networkStatus: networkReady ? "ready" : "blocked",
    networkBlockReason: networkReady
      ? null
      : (phaseNetworkEnabled ? "readiness_incomplete" : "phase_not_enabled")
  };
}

function identityProviderConfig_safeStatus(config, permissionOverride = null) {
  const input = (config && typeof config === "object") ? config : {};
  const cfg = input.schemaVersion === IDENTITY_PROVIDER_CONFIG_SCHEMA_VERSION
    && Object.prototype.hasOwnProperty.call(input, "valid")
    && Array.isArray(input.missingFields)
    && Array.isArray(input.errorCodes)
      ? input
      : identityProviderConfig_validateShape(input);
  const caps = (cfg.capabilities && typeof cfg.capabilities === "object") ? cfg.capabilities : {};
  const permission = permissionOverride || identityProviderPermission_getReadiness();
  const bundleProbe = identityProviderBundle_getProbeStatus();
  const providerConfigured = Boolean(cfg.providerConfigured);
  const clientReady = bundleProbe.clientReady === true;
  const network = identityProviderNetwork_getReadiness({
    providerConfigured,
    clientReady,
    permissionReady: permission.permissionReady === true
  });
  return {
    schemaVersion: cfg.schemaVersion || IDENTITY_PROVIDER_CONFIG_SCHEMA_VERSION,
    providerKind: cfg.providerKind,
    providerMode: cfg.providerMode,
    providerConfigured,
    configSource: identityProviderConfig_normalizeSourceName(cfg.configSource),
    valid: cfg.valid === true,
    validationState: String(cfg.validationState || "rejected").replace(/[^a-z0-9_-]/gi, "").slice(0, 64) || "rejected",
    missingFields: Array.isArray(cfg.missingFields)
      ? cfg.missingFields.map(field => String(field || "").replace(/[^a-z0-9_-]/gi, "").slice(0, 64)).filter(Boolean)
      : [],
    errorCodes: identityProviderConfig_cleanStatusList(cfg.errorCodes),
    capabilities: {
      emailOtp: Boolean(caps.emailOtp),
      magicLink: Boolean(caps.magicLink),
      oauth: Boolean(caps.oauth) && IDENTITY_PROVIDER_OAUTH_GOOGLE_ENABLED,
      oauthProviders: Boolean(caps.oauth) && IDENTITY_PROVIDER_OAUTH_GOOGLE_ENABLED ? ["google"] : []
    },
    permissionRequired: permission.permissionRequired,
    permissionReady: permission.permissionReady,
    permissionSource: permission.permissionSource,
    permissionHostKind: permission.permissionHostKind,
    permissionStatus: permission.permissionStatus,
    permissionErrorCode: permission.permissionErrorCode,
    phaseNetworkEnabled: network.phaseNetworkEnabled,
    networkReady: network.networkReady,
    networkStatus: network.networkStatus,
    networkBlockReason: network.networkBlockReason,
    clientReady,
    bundleProbe
  };
}

function identityProviderConfig_redact(config) {
  return identityProviderConfig_safeStatus(config);
}

function identityProviderConfig_diag() {
  return identityProviderConfig_safeStatus(identityProviderConfig_get());
}

async function identityProviderConfig_diagAsync() {
  const permission = await identityProviderPermission_getReadinessAsync();
  return identityProviderConfig_safeStatus(identityProviderConfig_get(), permission);
}

identityProviderBundle_bootstrapConfiguredProbe();

const IDENTITY_PROVIDER_OTP_ALLOWED_ERROR_CODES = Object.freeze([
  "identity/invalid-email",
  "identity/provider-not-configured",
  "identity/client-not-ready",
  "identity/permission-not-ready",
  "identity/network-not-enabled",
  "identity/network-not-ready",
  "identity/provider-auth-unavailable",
  "identity/provider-request-failed",
  "identity/provider-rate-limited",
  "identity/provider-network-failed",
  "identity/account-not-found",
  "identity/provider-rejected",
  "identity/unknown-provider-error",
]);

const IDENTITY_PROVIDER_OTP_ERROR_MESSAGES = Object.freeze({
  "identity/invalid-email": "Enter a valid email address.",
  "identity/provider-not-configured": "Provider sign-in is not configured.",
  "identity/client-not-ready": "Provider client is not ready.",
  "identity/permission-not-ready": "Provider permission is not granted.",
  "identity/network-not-enabled": "Provider network is not enabled for this build.",
  "identity/network-not-ready": "Provider network is not ready.",
  "identity/provider-auth-unavailable": "Provider auth is unavailable.",
  "identity/provider-request-failed": "Provider request failed.",
  "identity/provider-rate-limited": "Provider request is rate limited.",
  "identity/provider-network-failed": "Provider network request failed.",
  "identity/account-not-found": "No account found. Create an account first.",
  "identity/provider-rejected": "Provider rejected the request.",
  "identity/unknown-provider-error": "Provider request failed.",
});

const IDENTITY_PROVIDER_VERIFY_ALLOWED_ERROR_CODES = Object.freeze([
  "identity/invalid-otp-code",
  "identity/otp-invalid",
  "identity/otp-expired",
  "identity/email-mismatch",
  "identity/provider-unavailable",
  "identity/provider-rejected",
  "identity/provider-response-malformed",
  "identity/network-failed",
  "identity/unknown-provider-error",
  "identity/operation-not-permitted-in-phase",
]);

const IDENTITY_PROVIDER_VERIFY_ERROR_MESSAGES = Object.freeze({
  "identity/invalid-otp-code": "Enter a valid verification code.",
  "identity/otp-invalid": "Verification code is invalid.",
  "identity/otp-expired": "Verification code expired.",
  "identity/email-mismatch": "Verification email does not match the pending request.",
  "identity/provider-unavailable": "Provider verification is unavailable.",
  "identity/provider-rejected": "Provider rejected the verification request.",
  "identity/provider-response-malformed": "Provider verification response was not usable.",
  "identity/network-failed": "Provider network request failed.",
  "identity/unknown-provider-error": "Provider verification failed.",
  "identity/operation-not-permitted-in-phase": "Verification is not permitted in this phase.",
});

const IDENTITY_PROVIDER_PASSWORD_ALLOWED_ERROR_CODES = Object.freeze([
  "identity/invalid-email",
  "identity/password-invalid",
  "identity/password-weak",
  "identity/password-current-invalid",
  "identity/password-update-session-missing",
  "identity/password-update-failed",
  "identity/password-update-requires-recent-code",
  "identity/password-update-marker-unavailable",
  "identity/credential-status-session-missing",
  "identity/credential-status-provider-unavailable",
  "identity/credential-status-invalid-source",
  "identity/credential-status-invalid-provider",
  "identity/credential-status-response-malformed",
  "identity/credential-status-update-failed",
  "identity/email-not-confirmed",
  "identity/account-already-exists",
  "identity/provider-auth-unavailable",
  "identity/provider-not-configured",
  "identity/client-not-ready",
  "identity/permission-not-ready",
  "identity/network-not-enabled",
  "identity/network-not-ready",
  "identity/provider-rate-limited",
  "identity/provider-network-failed",
  "identity/provider-request-failed",
  "identity/provider-rejected",
  "identity/provider-response-malformed",
  "identity/account-update-invalid-input",
  "identity/account-update-session-missing",
  "identity/account-update-provider-unavailable",
  "identity/account-update-response-malformed",
  "identity/account-update-network-failed",
  "identity/account-update-rejected",
  "identity/account-update-not-found",
  "identity/account-update-failed",
  "identity/oauth-not-enabled",
  "identity/oauth-provider-unavailable",
  "identity/oauth-permission-unavailable",
  "identity/oauth-redirect-invalid",
  "identity/oauth-cancelled",
  "identity/oauth-callback-invalid",
  "identity/oauth-callback-missing-code",
  "identity/oauth-response-malformed",
  "identity/oauth-exchange-failed",
  "identity/oauth-failed",
  "identity/operation-not-permitted-in-phase",
  "identity/unknown-provider-error",
]);

const IDENTITY_PROVIDER_PASSWORD_ERROR_MESSAGES = Object.freeze({
  "identity/invalid-email": "Enter a valid email address.",
  "identity/password-invalid": "Email or password did not match.",
  "identity/password-weak": "Use a stronger password.",
  "identity/password-current-invalid": "Current password or new password was not accepted.",
  "identity/password-update-session-missing": "Your recovery session is missing. Request a new code.",
  "identity/password-update-failed": "Could not update password. Try again.",
  "identity/password-update-requires-recent-code": "Request a new code, then set your password again.",
  "identity/password-update-marker-unavailable": "Could not preserve recovery state. Request a new code.",
  "identity/credential-status-session-missing": "Your verified session is missing. Sign in again.",
  "identity/credential-status-provider-unavailable": "Password setup status is unavailable. Try again.",
  "identity/credential-status-invalid-source": "Password setup status could not be updated.",
  "identity/credential-status-invalid-provider": "Credential status provider was not approved.",
  "identity/credential-status-response-malformed": "Password setup status response was not usable.",
  "identity/credential-status-update-failed": "Could not confirm password setup. Try again.",
  "identity/email-not-confirmed": "Confirm your email, then sign in.",
  "identity/account-already-exists": "Account already exists. Sign in instead.",
  "identity/provider-auth-unavailable": "Provider password authentication is unavailable.",
  "identity/provider-not-configured": "Provider configuration is not available.",
  "identity/client-not-ready": "Provider client is not ready.",
  "identity/permission-not-ready": "Provider permission is not granted.",
  "identity/network-not-enabled": "Provider network is not enabled for this build.",
  "identity/network-not-ready": "Provider network is not ready.",
  "identity/provider-rate-limited": "Too many requests. Wait a bit before trying again.",
  "identity/provider-network-failed": "Provider network request failed.",
  "identity/provider-request-failed": "Provider password request failed.",
  "identity/provider-rejected": "Provider rejected the password request.",
  "identity/provider-response-malformed": "Provider password response was not usable.",
  "identity/account-update-invalid-input": "Account details were not valid.",
  "identity/account-update-session-missing": "Your verified session is missing. Sign in again.",
  "identity/account-update-provider-unavailable": "Account update is unavailable.",
  "identity/account-update-response-malformed": "Account update response was not usable.",
  "identity/account-update-network-failed": "Provider network request failed.",
  "identity/account-update-rejected": "Provider rejected the account update.",
  "identity/account-update-not-found": "Account profile or workspace was not found.",
  "identity/account-update-failed": "Account update failed. Try again.",
  "identity/oauth-not-enabled": "Google sign-in is not enabled for this build.",
  "identity/oauth-provider-unavailable": "Google sign-in is unavailable.",
  "identity/oauth-permission-unavailable": "Chrome identity permission is unavailable.",
  "identity/oauth-redirect-invalid": "Google sign-in redirect is not configured.",
  "identity/oauth-cancelled": "Google sign-in was cancelled.",
  "identity/oauth-callback-invalid": "Google sign-in callback was not usable.",
  "identity/oauth-callback-missing-code": "Google sign-in did not return a code.",
  "identity/oauth-response-malformed": "Google sign-in response was not usable.",
  "identity/oauth-exchange-failed": "Google sign-in could not complete.",
  "identity/oauth-failed": "Google sign-in failed.",
  "identity/operation-not-permitted-in-phase": "Password authentication is not permitted in this phase.",
  "identity/unknown-provider-error": "Provider password authentication failed.",
});

const IDENTITY_PROVIDER_ONBOARDING_ALLOWED_ERROR_CODES = Object.freeze([
  "identity/onboarding-invalid-input",
  "identity/onboarding-session-missing",
  "identity/onboarding-password-update-required",
  "identity/network-not-ready",
  "identity/onboarding-rejected",
  "identity/onboarding-conflict",
  "identity/onboarding-network-failed",
  "identity/onboarding-provider-unavailable",
  "identity/onboarding-response-malformed",
  "identity/onboarding-failed",
]);

const IDENTITY_PROVIDER_ONBOARDING_ERROR_MESSAGES = Object.freeze({
  "identity/onboarding-invalid-input": "Onboarding details are invalid.",
  "identity/onboarding-session-missing": "Provider session is missing.",
  "identity/onboarding-password-update-required": "Set a new password before continuing.",
  "identity/network-not-ready": "Provider network is not ready.",
  "identity/onboarding-rejected": "Provider rejected onboarding.",
  "identity/onboarding-conflict": "Onboarding data conflicts with existing records.",
  "identity/onboarding-network-failed": "Provider network request failed.",
  "identity/onboarding-provider-unavailable": "Provider onboarding is unavailable.",
  "identity/onboarding-response-malformed": "Provider onboarding response was not usable.",
  "identity/onboarding-failed": "Onboarding failed.",
});

const IDENTITY_PROVIDER_CLOUD_LOAD_ALLOWED_ERROR_CODES = Object.freeze([
  "identity/cloud-load-session-missing",
  "identity/cloud-load-network-failed",
  "identity/cloud-load-rejected",
  "identity/cloud-load-provider-unavailable",
  "identity/cloud-load-response-malformed",
  "identity/cloud-load-failed",
]);

const IDENTITY_PROVIDER_CLOUD_LOAD_ERROR_MESSAGES = Object.freeze({
  "identity/cloud-load-session-missing": "Provider session is missing.",
  "identity/cloud-load-network-failed": "Provider network request failed.",
  "identity/cloud-load-rejected": "Provider rejected identity restore.",
  "identity/cloud-load-provider-unavailable": "Provider identity restore is unavailable.",
  "identity/cloud-load-response-malformed": "Provider identity restore response was not usable.",
  "identity/cloud-load-failed": "Provider identity restore failed.",
});

function identityProviderOtp_normalizeEmail(input) {
  const email = String(input || "").trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) ? email : "";
}

function identityProviderOtp_normalizeErrorCode(input) {
  const code = String(input || "").trim().toLowerCase().replace(/[^a-z0-9_/-]/g, "").slice(0, 96);
  return IDENTITY_PROVIDER_OTP_ALLOWED_ERROR_CODES.includes(code) ? code : "identity/unknown-provider-error";
}

function identityProviderOtp_normalizeSeconds(input) {
  const seconds = Number(input);
  if (!Number.isFinite(seconds) || seconds < 0 || seconds > 86400) return null;
  return Math.floor(seconds);
}

function identityProviderOtp_failure(errorCode) {
  const code = identityProviderOtp_normalizeErrorCode(errorCode);
  return {
    ok: false,
    nextStatus: "auth_error",
    errorCode: code,
    errorMessage: IDENTITY_PROVIDER_OTP_ERROR_MESSAGES[code] || IDENTITY_PROVIDER_OTP_ERROR_MESSAGES["identity/unknown-provider-error"],
  };
}

function identityProviderOtp_success(email, providerResult = {}) {
  const retryAfterSeconds = identityProviderOtp_normalizeSeconds(providerResult.retryAfterSeconds);
  const cooldownSeconds = identityProviderOtp_normalizeSeconds(providerResult.cooldownSeconds);
  const emailMasked = identityRuntime_maskEmail(email);
  return {
    ok: true,
    nextStatus: "email_pending",
    emailMasked,
    pendingEmailMasked: emailMasked,
    retryAfterSeconds,
    cooldownSeconds,
  };
}

function identityProviderOtp_pendingRuntime(email) {
  const now = identityRuntime_nowIso();
  return {
    status: "email_pending",
    mode: "provider_backed",
    provider: "supabase",
    providerKind: "supabase",
    credentialState: "unknown",
    emailVerified: false,
    emailMasked: null,
    pendingEmail: email,
    pendingEmailMasked: identityRuntime_maskEmail(email),
    onboardingCompleted: false,
    syncReady: false,
    profile: null,
    workspace: null,
    lastError: null,
    updatedAt: now,
  };
}

function identityProviderOtp_sanitizeProviderResult(email, result) {
  const src = result && typeof result === "object" ? result : {};
  if (src.ok === true) return identityProviderOtp_success(email, src);
  return identityProviderOtp_failure(src.errorCode || "identity/provider-request-failed");
}

function identityProviderVerify_normalizeCode(input) {
  const code = String(input || "").trim();
  return /^[0-9]{6,10}$/.test(code) ? code : "";
}

function identityProviderPassword_normalize(input) {
  const value = typeof input === "string" ? input : "";
  if (value.length < 6 || value.length > 1024) return "";
  return value;
}

function identityProviderPassword_normalizeErrorCode(input) {
  const code = String(input || "").trim().toLowerCase().replace(/[^a-z0-9_/-]/g, "").slice(0, 96);
  return IDENTITY_PROVIDER_PASSWORD_ALLOWED_ERROR_CODES.includes(code) ? code : "identity/unknown-provider-error";
}

function identityProviderPassword_failure(errorCode) {
  const code = identityProviderPassword_normalizeErrorCode(errorCode);
  return {
    ok: false,
    nextStatus: "auth_error",
    errorCode: code,
    errorMessage: IDENTITY_PROVIDER_PASSWORD_ERROR_MESSAGES[code] || IDENTITY_PROVIDER_PASSWORD_ERROR_MESSAGES["identity/unknown-provider-error"],
  };
}

function identityProviderPassword_confirmationPending(email) {
  return {
    ok: true,
    nextStatus: "email_confirmation_pending",
    emailMasked: identityRuntime_maskEmail(email),
    pendingEmailMasked: identityRuntime_maskEmail(email),
    message: "Check your email to confirm your account.",
  };
}

function identityProviderPassword_confirmationPendingRuntime(email) {
  const now = identityRuntime_nowIso();
  const emailMasked = identityRuntime_maskEmail(email);
  return {
    status: "email_confirmation_pending",
    mode: "provider_backed",
    provider: "supabase",
    providerKind: "supabase",
    credentialState: "unknown",
    emailVerified: false,
    emailMasked,
    pendingEmail: email,
    pendingEmailMasked: emailMasked,
    onboardingCompleted: false,
    syncReady: false,
    profile: null,
    workspace: null,
    lastError: null,
    updatedAt: now,
  };
}

function identityProviderPassword_resetRequested(email) {
  return {
    ok: true,
    nextStatus: "password_reset_email_sent",
    emailMasked: identityRuntime_maskEmail(email),
  };
}

function identityProviderPasswordRecovery_pending(email, providerResult = {}) {
  const base = identityProviderOtp_success(email, providerResult);
  return {
    ...base,
    nextStatus: "recovery_code_pending",
  };
}

function identityProviderPasswordRecovery_pendingRuntime(email) {
  const runtime = identityProviderOtp_pendingRuntime(email);
  return {
    ...runtime,
    status: "recovery_code_pending",
    updatedAt: identityRuntime_nowIso(),
  };
}

function identityProviderPasswordUpdate_normalizeNewPassword(input) {
  const value = typeof input === "string" ? input : "";
  if (value.length < 12 || value.length > 1024 || !value.trim()) return "";
  return value;
}

function identityProviderVerify_normalizeErrorCode(input) {
  const code = String(input || "").trim().toLowerCase().replace(/[^a-z0-9_/-]/g, "").slice(0, 96);
  return IDENTITY_PROVIDER_VERIFY_ALLOWED_ERROR_CODES.includes(code) ? code : "identity/unknown-provider-error";
}

function identityProviderVerify_failure(errorCode) {
  const code = identityProviderVerify_normalizeErrorCode(errorCode);
  return {
    ok: false,
    nextStatus: "auth_error",
    errorCode: code,
    errorMessage: IDENTITY_PROVIDER_VERIFY_ERROR_MESSAGES[code] || IDENTITY_PROVIDER_VERIFY_ERROR_MESSAGES["identity/unknown-provider-error"],
    retryAfterSeconds: null,
  };
}

function identityProviderVerify_maskUserId(input) {
  const text = String(input || "").trim();
  if (!text) return null;
  if (new RegExp("^[A-Za-z0-9_-]{1,12}\\\\*{3,}[A-Za-z0-9_-]{0,12}$").test(text)) return text.slice(0, 80);
  if (text.length <= 10) return text.slice(0, 2) + "***";
  return text.slice(0, 6) + "***" + text.slice(-4);
}

function identityProviderVerify_normalizeExpiresAt(input) {
  if (typeof input === "string" && input) return input;
  const seconds = Number(input);
  if (Number.isFinite(seconds) && seconds > 0) return new Date(Math.floor(seconds) * 1000).toISOString();
  return null;
}

function identityProviderVerify_success(email, providerResult = {}) {
  const emailMasked = identityRuntime_maskEmail(email);
  const verifiedAt = identityRuntime_nowIso();
  return {
    ok: true,
    nextStatus: "verified_no_profile",
    emailMasked,
    pendingEmailMasked: emailMasked,
    userIdMasked: identityProviderVerify_maskUserId(providerResult.userIdMasked),
    emailVerified: true,
    sessionExpiresAt: identityProviderVerify_normalizeExpiresAt(providerResult.sessionExpiresAt),
    verifiedAt,
  };
}

function identityProviderVerify_runtime(email, providerResult = {}) {
  const now = identityRuntime_nowIso();
  const emailMasked = identityRuntime_maskEmail(email);
  return {
    status: "verified_no_profile",
    mode: "provider_backed",
    provider: "supabase",
    providerKind: "supabase",
    credentialState: "unknown",
    pendingEmail: null,
    emailVerified: true,
    emailMasked,
    pendingEmailMasked: emailMasked,
    userIdMasked: identityProviderVerify_maskUserId(providerResult.userIdMasked),
    sessionExpiresAt: identityProviderVerify_normalizeExpiresAt(providerResult.sessionExpiresAt),
    onboardingCompleted: false,
    syncReady: false,
    profile: null,
    workspace: null,
    lastError: null,
    updatedAt: now,
  };
}

const IDENTITY_PROVIDER_SESSION_EXPIRY_SKEW_MS = 60 * 1000;
const IDENTITY_PROVIDER_SESSION_REFRESH_WINDOW_MS = 5 * 60 * 1000;
const IDENTITY_PROVIDER_SIGN_OUT_EXPIRY_SKEW_MS = 120 * 1000;
let identityProviderSessionHydrationPromise = null;
let identityProviderSessionRefreshPromise = null;
let identityProviderSessionRestoreSuppressedUntilMs = 0;
let identityProviderSessionRestoreSuppressionToken = 0;

function identityProviderSession_restoreSuppressedDuringSignOut() {
  return Date.now() < identityProviderSessionRestoreSuppressedUntilMs;
}

function identityProviderSession_suppressRestoreForSignOut() {
  identityProviderSessionRestoreSuppressionToken += 1;
  identityProviderSessionRestoreSuppressedUntilMs = Date.now() + 15 * 1000;
  return identityProviderSessionRestoreSuppressionToken;
}

function identityProviderSession_keepRestoreSuppressedAfterSignOut(token) {
  if (token === identityProviderSessionRestoreSuppressionToken) {
    identityProviderSessionRestoreSuppressedUntilMs = Date.now() + 5 * 1000;
  }
}

function identityProviderSession_unwrapStoredSession(input) {
  const src = input && typeof input === "object" ? input : null;
  if (!src) return null;
  if (src.access_token || src.accessToken) return src;
  for (const key of ["rawSession", "session", "currentSession"]) {
    const nested = src[key] && typeof src[key] === "object" ? src[key] : null;
    if (nested && (nested.access_token || nested.accessToken)) return nested;
  }
  return src;
}

function identityProviderSession_unwrapResultKind(input) {
  const src = input && typeof input === "object" ? input : null;
  if (!src) return "missing";
  if (src.access_token || src.accessToken) return "direct";
  for (const key of ["rawSession", "session", "currentSession"]) {
    const nested = src[key] && typeof src[key] === "object" ? src[key] : null;
    if (nested && (nested.access_token || nested.accessToken)) return key;
  }
  return "object_without_access_token";
}

function identityProviderSession_safeTopLevelKeys(input) {
  const src = input && typeof input === "object" && !Array.isArray(input) ? input : null;
  if (!src) return [];
  return Object.keys(src)
    .map((key) => String(key || "").replace(/[^A-Za-z0-9_.-]/g, "").slice(0, 64))
    .filter(Boolean)
    .slice(0, 32);
}

function identityProviderSession_normalizeStoredSession(input) {
  const src = identityProviderSession_unwrapStoredSession(input);
  if (!src || typeof src !== "object") return null;
  const accessToken = String(src.access_token || src.accessToken || "").trim();
  const refreshToken = String(src.refresh_token || src.refreshToken || "").trim();
  const expiresMs = identityProviderSession_expiryMs(src);
  const {
    provider_token,
    provider_refresh_token,
    providerToken,
    providerRefreshToken,
    provider_id_token,
    providerIdToken,
    ...rest
  } = src;
  return {
    ...rest,
    access_token: accessToken || src.access_token,
    refresh_token: refreshToken || src.refresh_token,
    expires_at: expiresMs ? Math.floor(expiresMs / 1000) : src.expires_at,
  };
}

function identityProviderSession_expiryMs(session) {
  const src = identityProviderSession_unwrapStoredSession(session);
  const raw = src && typeof src === "object"
    ? (src.expires_at ?? src.sessionExpiresAt ?? src.expiresAt)
    : null;
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) return Math.floor(raw) * 1000;
  const text = String(raw || "").trim();
  if (!text) return 0;
  if (/^[0-9]+$/.test(text)) {
    const seconds = Number(text);
    return Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) * 1000 : 0;
  }
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function identityProviderSession_isExpired(session, nowMs = Date.now()) {
  const expiresMs = identityProviderSession_expiryMs(session);
  return !expiresMs || expiresMs <= nowMs + IDENTITY_PROVIDER_SESSION_EXPIRY_SKEW_MS;
}

function identityProviderSession_refreshIsDue(session, nowMs = Date.now()) {
  const expiresMs = identityProviderSession_expiryMs(session);
  return Boolean(expiresMs && expiresMs <= nowMs + IDENTITY_PROVIDER_SESSION_REFRESH_WINDOW_MS);
}

function identityProviderSession_refreshToken(session) {
  const src = identityProviderSession_unwrapStoredSession(session);
  const token = src && typeof src === "object" ? String(src.refresh_token || src.refreshToken || "").trim() : "";
  if (!token || token.length > 8192 || /[\\s<>]/.test(token)) return "";
  return token;
}

function identityProviderSession_accessToken(session) {
  const src = identityProviderSession_unwrapStoredSession(session);
  const token = src && typeof src === "object" ? String(src.access_token || src.accessToken || "").trim() : "";
  if (!token || token.length > 16384 || /[\\s<>]/.test(token)) return "";
  return token;
}

function identityProviderSession_makeRpcSessionForOnboarding(input) {
  const src = identityProviderSession_normalizeStoredSession(input);
  if (!src) return null;
  const accessToken = identityProviderSession_accessToken(src);
  const expiresMs = identityProviderSession_expiryMs(src);
  if (!accessToken || !expiresMs) return null;
  return {
    ...src,
    access_token: accessToken,
    expires_at: Math.floor(expiresMs / 1000),
  };
}

function identityProviderSession_onboardingDiagnostics(storedValue, rpcSession, providerState) {
  const raw = identityProviderSession_unwrapStoredSession(storedValue);
  const normalized = identityProviderSession_normalizeStoredSession(storedValue);
  const rpc = rpcSession && typeof rpcSession === "object"
    ? identityProviderSession_unwrapStoredSession(rpcSession)
    : null;
  const state = providerState && typeof providerState === "object" ? providerState : {};
  return {
    providerSessionKeyExists: Boolean(storedValue && typeof storedValue === "object"),
    providerSessionTopLevelKeys: identityProviderSession_safeTopLevelKeys(storedValue),
    rawHasAccessToken: Boolean(identityProviderSession_accessToken(raw)),
    rawHasRefreshToken: Boolean(identityProviderSession_refreshToken(raw)),
    rawHasExpiresAt: Boolean(identityProviderSession_expiryMs(raw)),
    rawHasUser: Boolean(raw && raw.user && typeof raw.user === "object"),
    unwrapResultKind: identityProviderSession_unwrapResultKind(storedValue),
    normalizedHasAccessToken: Boolean(identityProviderSession_accessToken(normalized)),
    normalizedHasRefreshToken: Boolean(identityProviderSession_refreshToken(normalized)),
    normalizedHasExpiresAt: Boolean(identityProviderSession_expiryMs(normalized)),
    normalizedExpired: Boolean(normalized && identityProviderSession_isExpired(normalized)),
    rpcSessionBuilt: Boolean(rpc),
    callerSawAccessToken: Boolean(identityProviderSession_accessToken(rpc)),
    providerStateStatus: String(state.status || "").replace(/[^a-z0-9_-]/gi, "").slice(0, 64),
    providerStateMode: String(state.mode || "").replace(/[^a-z0-9_-]/gi, "").slice(0, 64),
    providerStateProvider: String(state.provider || "").replace(/[^a-z0-9_-]/gi, "").slice(0, 64),
  };
}

function identityProviderSession_signOutUsable(session, nowMs = Date.now()) {
  if (!identityProviderSession_accessToken(session) || !identityProviderSession_refreshToken(session)) return false;
  const expiresMs = identityProviderSession_expiryMs(session);
  return Boolean(expiresMs && expiresMs > nowMs + IDENTITY_PROVIDER_SIGN_OUT_EXPIRY_SKEW_MS);
}

function identityProviderSession_extractSafeRuntime(rawSession) {
  const session = identityProviderSession_unwrapStoredSession(rawSession);
  const user = session && session.user && typeof session.user === "object" ? session.user : null;
  const email = identityProviderOtp_normalizeEmail(user && user.email);
  const userIdMasked = identityProviderVerify_maskUserId(user && user.id);
  const expiresMs = identityProviderSession_expiryMs(session);
  if (!session || !user || !email || !userIdMasked || identityProviderSession_isExpired(session)) {
    return null;
  }
  return identityProviderVerify_runtime(email, {
    userIdMasked,
    sessionExpiresAt: new Date(expiresMs).toISOString(),
  });
}

function identityProviderPersistentRefresh_normalizeProjectOrigin(input) {
  try {
    const parsed = new URL(String(input || "").trim());
    if (parsed.protocol !== "https:" || !/^[a-z0-9-]+\.supabase\.co$/i.test(parsed.hostname)) return "";
    return parsed.origin.toLowerCase();
  } catch (_) {
    return "";
  }
}

function identityProviderPersistentRefresh_projectOriginFromOptionalHost() {
  const pattern = identityProviderPermission_getExactHostPattern();
  const match = String(pattern || "").match(new RegExp("^(https://[a-z0-9-]+[.]supabase[.]co)/[*]$", "i"));
  return match ? match[1].toLowerCase() : "";
}

function identityProviderPersistentRefresh_getSupabaseContext() {
  const providerConfig = identityProviderConfig_get();
  const configShape = identityProviderConfig_validateShape(providerConfig);
  if (configShape.providerKind !== "supabase"
    || configShape.providerMode !== "provider_backed"
    || !identityProviderConfig_isSupabaseConfigured(providerConfig)) {
    return { ok: false, errorCode: "identity/provider-config-inactive", projectOrigin: "" };
  }
  const injected = identityProviderConfig_getInjectedSource();
  if (!injected
    || injected.providerKind !== "supabase"
    || injected.providerMode !== "provider_backed"
    || !identityProviderConfig_isSupabaseConfigured(injected)) {
    return { ok: false, errorCode: "identity/provider-config-inactive", projectOrigin: "" };
  }
  const loadedPrivateConfig = identityProviderBundle_loadPrivateConfig();
  if (!loadedPrivateConfig.ok) {
    return { ok: false, errorCode: "identity/provider-config-unavailable", projectOrigin: "" };
  }
  const projectOrigin = identityProviderPersistentRefresh_normalizeProjectOrigin(
    loadedPrivateConfig.privateConfig && loadedPrivateConfig.privateConfig.projectUrl
  );
  const optionalOrigin = identityProviderPersistentRefresh_projectOriginFromOptionalHost();
  if (!projectOrigin || (optionalOrigin && optionalOrigin !== projectOrigin)) {
    return { ok: false, errorCode: "identity/provider-project-origin-mismatch", projectOrigin: "" };
  }
  return { ok: true, projectOrigin };
}

async function identityProviderPersistentRefresh_getRestoreContext() {
  const context = identityProviderPersistentRefresh_getSupabaseContext();
  if (!context.ok) return context;
  const status = await identityProviderConfig_diagAsync();
  if (status.providerKind !== "supabase"
    || status.providerMode !== "provider_backed"
    || status.providerConfigured !== true
    || status.clientReady !== true
    || status.permissionReady !== true
    || status.phaseNetworkEnabled !== true
    || status.networkReady !== true) {
    return { ok: false, errorCode: "identity/provider-persistent-restore-not-ready", projectOrigin: context.projectOrigin };
  }
  return context;
}

function identityProviderPersistentRefresh_normalizeIso(input) {
  const text = String(input || "").trim();
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) && parsed > 0 ? new Date(parsed).toISOString() : null;
}

function identityProviderPersistentRefresh_normalizeRecord(input) {
  const src = input && typeof input === "object" && !Array.isArray(input) ? input : null;
  if (!src || src.version !== 1) return null;
  if (src.provider !== "supabase" || src.providerKind !== "supabase") return null;
  const projectOrigin = identityProviderPersistentRefresh_normalizeProjectOrigin(src.projectOrigin);
  const refreshToken = identityProviderSession_refreshToken({ refresh_token: src.refresh_token });
  const createdAt = identityProviderPersistentRefresh_normalizeIso(src.createdAt);
  const updatedAt = identityProviderPersistentRefresh_normalizeIso(src.updatedAt);
  const lastRotatedAt = src.lastRotatedAt == null || src.lastRotatedAt === ""
    ? null
    : identityProviderPersistentRefresh_normalizeIso(src.lastRotatedAt);
  if (!projectOrigin || !refreshToken || !createdAt || !updatedAt) return null;
  if (src.lastRotatedAt != null && src.lastRotatedAt !== "" && !lastRotatedAt) return null;
  return {
    version: 1,
    provider: "supabase",
    providerKind: "supabase",
    projectOrigin,
    refresh_token: refreshToken,
    createdAt,
    updatedAt,
    lastRotatedAt,
  };
}

function identityProviderPersistentRefresh_makeDiagnostics(input = {}) {
  const src = input && typeof input === "object" ? input : {};
  const reason = String(src.persistentWriteSkippedReason || src.errorCode || "")
    .replace(/[^a-z0-9_/-]/gi, "")
    .slice(0, 96);
  return {
    persistentWriteAttempted: src.persistentWriteAttempted === true,
    persistentWriteSkippedReason: reason || null,
    rawSessionHasRefreshToken: src.rawSessionHasRefreshToken === true,
    persistentRecordBuilt: src.persistentRecordBuilt === true,
    persistentWriteOk: src.persistentWriteOk === true,
    providerOriginMatched: src.providerOriginMatched === true,
  };
}

function identityProviderPersistentRefresh_buildRecordResult(rawSession, options = {}) {
  const context = identityProviderPersistentRefresh_getSupabaseContext();
  const rawSessionHasRefreshToken = Boolean(identityProviderSession_refreshToken(rawSession));
  const baseDiagnostics = {
    persistentWriteAttempted: true,
    rawSessionHasRefreshToken,
    persistentRecordBuilt: false,
    persistentWriteOk: false,
    providerOriginMatched: context.ok === true,
    persistentWriteSkippedReason: null,
  };
  if (!context.ok) {
    return {
      ok: false,
      errorCode: context.errorCode || "identity/provider-persistent-refresh-unavailable",
      record: null,
      diagnostics: identityProviderPersistentRefresh_makeDiagnostics({
        ...baseDiagnostics,
        persistentWriteSkippedReason: context.errorCode || "identity/provider-persistent-refresh-unavailable",
      }),
    };
  }
  const refreshToken = identityProviderSession_refreshToken(rawSession);
  if (!refreshToken) {
    return {
      ok: false,
      errorCode: "identity/provider-persistent-refresh-token-missing",
      record: null,
      diagnostics: identityProviderPersistentRefresh_makeDiagnostics({
        ...baseDiagnostics,
        persistentWriteSkippedReason: "identity/provider-persistent-refresh-token-missing",
      }),
    };
  }
  const opts = options && typeof options === "object" ? options : {};
  const existing = identityProviderPersistentRefresh_normalizeRecord(opts.existingRecord);
  if (opts.existingRecord && !existing) {
    return {
      ok: false,
      errorCode: "identity/provider-persistent-refresh-existing-record-invalid",
      record: null,
      diagnostics: identityProviderPersistentRefresh_makeDiagnostics({
        ...baseDiagnostics,
        persistentWriteSkippedReason: "identity/provider-persistent-refresh-existing-record-invalid",
      }),
    };
  }
  if (existing && existing.projectOrigin !== context.projectOrigin) {
    return {
      ok: false,
      errorCode: "identity/provider-project-origin-mismatch",
      record: null,
      diagnostics: identityProviderPersistentRefresh_makeDiagnostics({
        ...baseDiagnostics,
        providerOriginMatched: false,
        persistentWriteSkippedReason: "identity/provider-project-origin-mismatch",
      }),
    };
  }
  const now = identityRuntime_nowIso();
  const record = {
    version: 1,
    provider: "supabase",
    providerKind: "supabase",
    projectOrigin: context.projectOrigin,
    refresh_token: refreshToken,
    createdAt: existing ? existing.createdAt : now,
    updatedAt: now,
    lastRotatedAt: opts.rotate === true ? now : (existing ? existing.lastRotatedAt : null),
  };
  return {
    ok: true,
    errorCode: null,
    record,
    diagnostics: identityProviderPersistentRefresh_makeDiagnostics({
      ...baseDiagnostics,
      persistentRecordBuilt: true,
    }),
  };
}

async function identityProviderPersistentRefresh_readStoredRecord() {
  const res = await providerPersistentRefreshGet([IDENTITY_PROVIDER_PERSISTENT_REFRESH_KEY]);
  return res[IDENTITY_PROVIDER_PERSISTENT_REFRESH_KEY] || null;
}

async function identityProviderPersistentRefresh_remove() {
  try {
    await providerPersistentRefreshRemove([IDENTITY_PROVIDER_PERSISTENT_REFRESH_KEY]);
    return true;
  } catch (_) {
    return false;
  }
}

function identityProviderPersistentRefresh_recordFromSession(rawSession, options = {}) {
  const result = identityProviderPersistentRefresh_buildRecordResult(rawSession, options);
  return result.ok ? result.record : null;
}

async function identityProviderPersistentRefresh_storeFromSession(rawSession, options = {}) {
  if (identityProviderSession_restoreSuppressedDuringSignOut()) {
    return {
      ok: false,
      errorCode: "identity/sign-out-in-progress",
      diagnostics: identityProviderPersistentRefresh_makeDiagnostics({
        persistentWriteAttempted: true,
        persistentWriteSkippedReason: "identity/sign-out-in-progress",
      }),
    };
  }
  const built = identityProviderPersistentRefresh_buildRecordResult(rawSession, options);
  if (!built.ok || !built.record) return built;
  try {
    await providerPersistentRefreshSet({ [IDENTITY_PROVIDER_PERSISTENT_REFRESH_KEY]: built.record });
    return {
      ok: true,
      diagnostics: identityProviderPersistentRefresh_makeDiagnostics({
        ...built.diagnostics,
        persistentWriteOk: true,
      }),
    };
  } catch (_) {
    await identityProviderPersistentRefresh_remove();
    return {
      ok: false,
      errorCode: "identity/provider-persistent-refresh-storage-unavailable",
      diagnostics: identityProviderPersistentRefresh_makeDiagnostics({
        ...built.diagnostics,
        persistentWriteSkippedReason: "identity/provider-persistent-refresh-storage-unavailable",
      }),
    };
  }
}

async function identityProviderPersistentRefresh_rotateFromSessionIfPresent(rawSession) {
  const context = identityProviderPersistentRefresh_getSupabaseContext();
  if (!context.ok) return { ok: false, errorCode: context.errorCode };
  let storedRecord = null;
  try {
    storedRecord = await identityProviderPersistentRefresh_readStoredRecord();
  } catch (_) {
    return { ok: false, errorCode: "identity/provider-persistent-refresh-storage-unavailable" };
  }
  const existing = identityProviderPersistentRefresh_normalizeRecord(storedRecord);
  if (!existing) {
    if (storedRecord) await identityProviderPersistentRefresh_remove();
    return { ok: false, errorCode: "identity/provider-persistent-refresh-missing" };
  }
  if (existing.projectOrigin !== context.projectOrigin) {
    await identityProviderPersistentRefresh_remove();
    return { ok: false, errorCode: "identity/provider-project-origin-mismatch" };
  }
  return identityProviderPersistentRefresh_storeFromSession(rawSession, {
    existingRecord: existing,
    rotate: true,
  });
}

function identityProviderPersistentRefresh_shouldClearForRefreshError(errorCode) {
  const code = String(errorCode || "").trim();
  return code !== "identity/provider-network-failed"
    && code !== "identity/provider-refresh-unavailable"
    && code !== "identity/provider-persistent-restore-not-ready";
}

function identityProviderPasswordUpdateRequired_normalizeRecord(input) {
  const src = input && typeof input === "object" && !Array.isArray(input) ? input : null;
  if (!src || src.version !== 1) return null;
  if (src.provider !== "supabase" || src.providerKind !== "supabase") return null;
  const reason = src.reason === "credential_required" ? "credential_required" : src.reason;
  if (reason !== "password_recovery" && reason !== "credential_required") return null;
  const projectOrigin = identityProviderPersistentRefresh_normalizeProjectOrigin(src.projectOrigin);
  const createdAt = identityProviderPersistentRefresh_normalizeIso(src.createdAt);
  const updatedAt = identityProviderPersistentRefresh_normalizeIso(src.updatedAt);
  if (!projectOrigin || !createdAt || !updatedAt) return null;
  return {
    version: 1,
    provider: "supabase",
    providerKind: "supabase",
    projectOrigin,
    reason,
    createdAt,
    updatedAt,
  };
}

async function identityProviderPasswordUpdateRequired_readStoredRecord() {
  const res = await providerPersistentRefreshGet([IDENTITY_PROVIDER_PASSWORD_UPDATE_REQUIRED_KEY]);
  return res[IDENTITY_PROVIDER_PASSWORD_UPDATE_REQUIRED_KEY] || null;
}

async function identityProviderPasswordUpdateRequired_remove() {
  try {
    await providerPersistentRefreshRemove([IDENTITY_PROVIDER_PASSWORD_UPDATE_REQUIRED_KEY]);
    return true;
  } catch (_) {
    return false;
  }
}

async function identityProviderPasswordUpdateRequired_readActiveForCurrentProject() {
  const context = identityProviderPersistentRefresh_getSupabaseContext();
  if (!context.ok) return null;
  let storedRecord = null;
  try {
    storedRecord = await identityProviderPasswordUpdateRequired_readStoredRecord();
  } catch (_) {
    return null;
  }
  const record = identityProviderPasswordUpdateRequired_normalizeRecord(storedRecord);
  if (!record) {
    if (storedRecord) await identityProviderPasswordUpdateRequired_remove();
    return null;
  }
  if (record.projectOrigin !== context.projectOrigin) {
    await identityProviderPasswordUpdateRequired_remove();
    return null;
  }
  return record;
}

async function identityProviderPasswordUpdateRequired_store() {
  return identityProviderPasswordUpdateRequired_storeReason("password_recovery");
}

async function identityProviderPasswordUpdateRequired_storeReason(reason = "password_recovery") {
  const context = identityProviderPersistentRefresh_getSupabaseContext();
  if (!context.ok) return { ok: false, errorCode: context.errorCode || "identity/provider-config-inactive" };
  const now = identityRuntime_nowIso();
  const existing = await identityProviderPasswordUpdateRequired_readActiveForCurrentProject();
  const safeReason = String(reason || "").trim() === "credential_required"
    ? "credential_required"
    : "password_recovery";
  const record = {
    version: 1,
    provider: "supabase",
    providerKind: "supabase",
    projectOrigin: context.projectOrigin,
    reason: safeReason,
    createdAt: existing ? existing.createdAt : now,
    updatedAt: now,
  };
  try {
    await providerPersistentRefreshSet({ [IDENTITY_PROVIDER_PASSWORD_UPDATE_REQUIRED_KEY]: record });
    return { ok: true, record };
  } catch (_) {
    return { ok: false, errorCode: "identity/password-update-marker-unavailable" };
  }
}

async function identityProviderPasswordUpdateRequired_isActive() {
  return Boolean(await identityProviderPasswordUpdateRequired_readActiveForCurrentProject());
}

function identityProviderPasswordUpdateRequired_runtimeFromSession(rawSession) {
  const safeRuntime = identityProviderSession_extractSafeRuntime(rawSession);
  if (!safeRuntime) return null;
  return {
    ...safeRuntime,
    status: "password_update_required",
    credentialState: "required",
    onboardingCompleted: false,
    syncReady: false,
    profile: null,
    workspace: null,
    lastError: null,
    updatedAt: identityRuntime_nowIso(),
  };
}

function identityProviderPasswordUpdateRequired_response(providerResult = {}) {
  const session = identityProviderSession_unwrapStoredSession(providerResult.rawSession);
  const user = session && session.user && typeof session.user === "object" ? session.user : null;
  const email = identityProviderOtp_normalizeEmail(user && user.email);
  const base = identityProviderVerify_success(email, providerResult);
  return {
    ...base,
    nextStatus: "password_update_required",
    credentialState: "required",
    onboardingCompleted: false,
    syncReady: false,
    profile: null,
    workspace: null,
  };
}

async function identityProviderSession_readRaw() {
  const res = await providerSessionGet([IDENTITY_PROVIDER_SESSION_KEY]);
  const rawSession = identityProviderSession_normalizeStoredSession(res[IDENTITY_PROVIDER_SESSION_KEY]);
  return rawSession && typeof rawSession === "object" ? rawSession : null;
}

async function identityProviderSession_readStoredValueForOnboarding() {
  const res = await providerSessionGet([IDENTITY_PROVIDER_SESSION_KEY]);
  return res[IDENTITY_PROVIDER_SESSION_KEY] || null;
}

async function identityProviderSession_readRpcSessionForOnboarding(providerState = null) {
  if (!providerSessionStorageStrict()) {
    return {
      ok: false,
      errorCode: "identity/onboarding-session-missing",
      rawSession: null,
      diagnostics: identityProviderSession_onboardingDiagnostics(null, null, providerState),
    };
  }
  let storedValue = null;
  let rawSession = null;
  try {
    storedValue = await identityProviderSession_readStoredValueForOnboarding();
    rawSession = identityProviderSession_normalizeStoredSession(storedValue);
  } catch (_) {
    return {
      ok: false,
      errorCode: "identity/onboarding-session-missing",
      rawSession: null,
      diagnostics: identityProviderSession_onboardingDiagnostics(storedValue, null, providerState),
    };
  }
  let rpcSession = identityProviderSession_makeRpcSessionForOnboarding(rawSession);
  if (rpcSession && !identityProviderSession_isExpired(rpcSession)) {
    return {
      ok: true,
      rawSession: rpcSession,
      diagnostics: identityProviderSession_onboardingDiagnostics(storedValue, rpcSession, providerState),
    };
  }
  if (rawSession && identityProviderSession_isExpired(rawSession) && identityProviderSession_refreshToken(rawSession)) {
    const refreshed = await identityProviderSession_hydrateOnWake({
      reason: "complete-onboarding-expired-session",
      broadcast: true,
      allowRefresh: true,
    });
    if (!refreshed || refreshed.ok !== true) {
      return {
        ok: false,
        errorCode: "identity/onboarding-session-missing",
        rawSession: null,
        diagnostics: identityProviderSession_onboardingDiagnostics(storedValue, rpcSession, providerState),
      };
    }
    try {
      storedValue = await identityProviderSession_readStoredValueForOnboarding();
      rawSession = identityProviderSession_normalizeStoredSession(storedValue);
    } catch (_) {
      rawSession = null;
    }
    rpcSession = identityProviderSession_makeRpcSessionForOnboarding(rawSession);
    if (rpcSession && !identityProviderSession_isExpired(rpcSession)) {
      return {
        ok: true,
        rawSession: rpcSession,
        diagnostics: identityProviderSession_onboardingDiagnostics(storedValue, rpcSession, providerState),
      };
    }
  }
  return {
    ok: false,
    errorCode: "identity/onboarding-session-missing",
    rawSession: null,
    diagnostics: identityProviderSession_onboardingDiagnostics(storedValue, rpcSession, providerState),
  };
}

async function identityProviderSession_clearExpired(reason = "identity/session-expired", shouldBroadcast = true) {
  try { await providerSessionRemove([IDENTITY_PROVIDER_SESSION_KEY]); } catch {}
  try { await identityProviderPasswordUpdateRequired_remove(); } catch {}
  await identityAuthManager_clearRuntime();
  await identityAuthManager_clearStoredSnapshot();
  if (shouldBroadcast) broadcastIdentityPush(null);
  return { ok: false, errorCode: reason };
}

async function identityProviderSession_preserveReadyRuntime(safeRuntime) {
  if (!safeRuntime || safeRuntime.status !== "verified_no_profile") return safeRuntime;
  let existingRt = null;
  try {
    existingRt = await identityAuthManager_getRuntime();
  } catch (_) {
    existingRt = null;
  }
  const src = existingRt && typeof existingRt === "object" ? existingRt : null;
  if (!src
    || src.mode !== "provider_backed"
    || src.provider !== "supabase"
    || src.providerKind !== "supabase"
    || src.status !== "sync_ready"
    || !identityCredentialState_isComplete(src.credentialState)
    || src.emailVerified !== true
    || src.userIdMasked !== safeRuntime.userIdMasked) {
    return safeRuntime;
  }
  const profile = identityProviderOnboarding_sanitizeProfile(src.profile);
  const workspace = identityProviderOnboarding_sanitizeWorkspace(src.workspace);
  if (!profile || !workspace) return safeRuntime;
  return {
    ...safeRuntime,
    credentialState: "complete",
    status: "sync_ready",
    onboardingCompleted: true,
    syncReady: true,
    profile,
    workspace,
    lastError: null,
    updatedAt: identityRuntime_nowIso(),
  };
}

function identityProviderCloudLoad_normalizeErrorCode(input) {
  const code = String(input || "").trim().toLowerCase().replace(/[^a-z0-9_/-]/g, "").slice(0, 96);
  return IDENTITY_PROVIDER_CLOUD_LOAD_ALLOWED_ERROR_CODES.includes(code) ? code : "identity/cloud-load-failed";
}

function identityProviderCloudLoad_safeError(errorCode) {
  const code = identityProviderCloudLoad_normalizeErrorCode(errorCode);
  return {
    code,
    message: IDENTITY_PROVIDER_CLOUD_LOAD_ERROR_MESSAGES[code] || IDENTITY_PROVIDER_CLOUD_LOAD_ERROR_MESSAGES["identity/cloud-load-failed"],
  };
}

function identityCredentialState_normalize(input) {
  const value = String(input || "").trim().toLowerCase();
  if (value === "complete" || value === "required" || value === "unknown") return value;
  return "unknown";
}

function identityCredentialProvider_normalize(input) {
  const value = String(input || "").trim().toLowerCase();
  if (value === "password" || value === "google" || value === "multiple" || value === "unknown") return value;
  return "unknown";
}

function identityCredentialState_isComplete(input) {
  return identityCredentialState_normalize(input) === "complete";
}

function identityCredentialState_fromProviderResult(result) {
  const src = result && typeof result === "object" ? result : {};
  return identityCredentialState_normalize(src.credentialState || src.credential_state);
}

function identityCredentialProvider_fromProviderResult(result) {
  const src = result && typeof result === "object" ? result : {};
  return identityCredentialProvider_normalize(src.credentialProvider || src.credential_provider);
}

function identityProviderCloudLoad_sanitizeProviderResult(result) {
  const src = result && typeof result === "object" ? result : {};
  const credentialState = identityCredentialState_fromProviderResult(src);
  const credentialProvider = identityCredentialProvider_fromProviderResult(src);
  if (src.ok !== true) {
    return {
      ok: false,
      errorCode: identityProviderCloudLoad_normalizeErrorCode(src.errorCode || "identity/cloud-load-failed"),
      profile: null,
      workspace: null,
      complete: false,
      credentialState,
      credentialProvider,
    };
  }
  if (src.complete !== true) {
    return { ok: true, profile: null, workspace: null, complete: false, credentialState, credentialProvider };
  }
  const profile = identityProviderOnboarding_sanitizeProfile(src.profile);
  const workspace = identityProviderOnboarding_sanitizeWorkspace(src.workspace);
  if (!profile || !workspace) {
    return {
      ok: false,
      errorCode: "identity/cloud-load-response-malformed",
      profile: null,
      workspace: null,
      complete: false,
      credentialState,
      credentialProvider,
    };
  }
  return { ok: true, profile, workspace, complete: true, credentialState, credentialProvider };
}

async function identityProviderBundle_loadIdentityState(req = {}) {
  identityProviderBundle_ensureProbeLoaded();
  if (identityProviderBundleProbeState.loaded !== true
    || typeof identityProviderBundleProbeState.loadIdentityStateRunner !== "function") {
    return { ok: false, errorCode: "identity/cloud-load-provider-unavailable", profile: null, workspace: null, complete: false };
  }
  const rawSession = req.rawSession && typeof req.rawSession === "object" ? req.rawSession : null;
  if (!rawSession) {
    return { ok: false, errorCode: "identity/cloud-load-session-missing", profile: null, workspace: null, complete: false };
  }
  const loadedPrivateConfig = identityProviderBundle_loadPrivateConfig();
  if (!loadedPrivateConfig.ok) {
    return { ok: false, errorCode: "identity/cloud-load-provider-unavailable", profile: null, workspace: null, complete: false };
  }
  try {
    return identityProviderCloudLoad_sanitizeProviderResult(
      await identityProviderBundleProbeState.loadIdentityStateRunner(
        loadedPrivateConfig.privateConfig,
        { rawSession }
      )
    );
  } catch (_) {
    return { ok: false, errorCode: "identity/cloud-load-failed", profile: null, workspace: null, complete: false };
  }
}

async function identityProviderBundle_markPasswordSetupCompleted(req = {}) {
  identityProviderBundle_ensureProbeLoaded();
  if (identityProviderBundleProbeState.loaded !== true
    || typeof identityProviderBundleProbeState.markPasswordSetupCompletedRunner !== "function") {
    return { ok: false, errorCode: "identity/credential-status-provider-unavailable", credentialState: "unknown" };
  }
  const rawSession = req.rawSession && typeof req.rawSession === "object" ? req.rawSession : null;
  const source = String(req.source || "").trim();
  if (!rawSession) {
    return { ok: false, errorCode: "identity/credential-status-session-missing", credentialState: "unknown" };
  }
  if (!/^(password_sign_up|signup_confirmation|password_sign_in|password_recovery_update|password_account_change)$/.test(source)) {
    return { ok: false, errorCode: "identity/credential-status-invalid-source", credentialState: "unknown" };
  }
  const loadedPrivateConfig = identityProviderBundle_loadPrivateConfig();
  if (!loadedPrivateConfig.ok) {
    return { ok: false, errorCode: "identity/credential-status-provider-unavailable", credentialState: "unknown" };
  }
  try {
    const result = await identityProviderBundleProbeState.markPasswordSetupCompletedRunner(
      loadedPrivateConfig.privateConfig,
      { rawSession, source }
    );
    const credentialState = identityCredentialState_fromProviderResult(result);
    if (!result || result.ok !== true || credentialState !== "complete") {
      return {
        ok: false,
        errorCode: result?.errorCode || "identity/credential-status-update-failed",
        credentialState,
      };
    }
    return { ok: true, credentialState: "complete" };
  } catch (_) {
    return { ok: false, errorCode: "identity/credential-status-update-failed", credentialState: "unknown" };
  }
}

async function identityProviderCredentialState_markCompleteForSession(rawSession, source) {
  const rpcSession = identityProviderSession_makeRpcSessionForOnboarding(rawSession);
  if (!rpcSession || identityProviderSession_isExpired(rpcSession)) {
    return { ok: false, errorCode: "identity/credential-status-session-missing", credentialState: "unknown" };
  }
  const result = await identityProviderBundle_markPasswordSetupCompleted({
    rawSession: rpcSession,
    source,
  });
  return result && result.ok === true
    ? { ok: true, credentialState: "complete" }
    : {
      ok: false,
      errorCode: result?.errorCode || "identity/credential-status-update-failed",
      credentialState: identityCredentialState_fromProviderResult(result),
    };
}

function identityProviderOAuth_normalizeFlowState(input) {
  const src = input && typeof input === "object" && !Array.isArray(input) ? input : null;
  if (!src || src.version !== 1 || src.provider !== "google") return null;
  const redirectTo = String(src.redirectTo || "").trim();
  let parsed = null;
  try {
    parsed = new URL(redirectTo);
  } catch (_) {
    return null;
  }
  if (parsed.protocol !== "https:" || !/^[a-z0-9-]+\.chromiumapp\.org$/i.test(parsed.hostname) || parsed.pathname !== "/identity/oauth/google") {
    return null;
  }
  const createdAt = identityProviderPersistentRefresh_normalizeIso(src.createdAt);
  if (!createdAt || Date.now() - Date.parse(createdAt) > IDENTITY_PROVIDER_OAUTH_FLOW_MAX_AGE_MS) return null;
  const storage = src.storage && typeof src.storage === "object" && !Array.isArray(src.storage) ? src.storage : {};
  const cleanStorage = {};
  for (const [rawKey, rawValue] of Object.entries(storage)) {
    const key = String(rawKey || "").replace(/[^A-Za-z0-9_.:-]/g, "").slice(0, 256);
    const value = String(rawValue || "");
    if (!key || value.length > 8192) continue;
    if (/(?:access|refresh|id|provider)[_-]?token|provider[_-]?refresh[_-]?token|session|user|email|password|secret/i.test(key)) continue;
    if (/(?:access|refresh|id|provider)[_-]?token|provider[_-]?refresh[_-]?token|password|secret/i.test(value)) continue;
    cleanStorage[key] = value;
  }
  return {
    version: 1,
    provider: "google",
    redirectTo: parsed.toString(),
    storage: cleanStorage,
    createdAt,
  };
}

async function identityProviderOAuth_storeFlowState(flowState) {
  const safe = identityProviderOAuth_normalizeFlowState(flowState);
  if (!safe) return false;
  try {
    await storageSessionSet({ [IDENTITY_PROVIDER_OAUTH_FLOW_KEY]: safe });
    return true;
  } catch (_) {
    return false;
  }
}

async function identityProviderOAuth_readFlowState() {
  try {
    const res = await storageSessionGet([IDENTITY_PROVIDER_OAUTH_FLOW_KEY]);
    const safe = identityProviderOAuth_normalizeFlowState(res && res[IDENTITY_PROVIDER_OAUTH_FLOW_KEY]);
    if (!safe && res && res[IDENTITY_PROVIDER_OAUTH_FLOW_KEY]) {
      try { await storageSessionRemove([IDENTITY_PROVIDER_OAUTH_FLOW_KEY]); } catch {}
    }
    return safe;
  } catch (_) {
    return null;
  }
}

async function identityProviderOAuth_removeFlowState() {
  try {
    await storageSessionRemove([IDENTITY_PROVIDER_OAUTH_FLOW_KEY]);
    return true;
  } catch (_) {
    return false;
  }
}

function identityProviderOAuth_getRedirectUrl() {
  if (typeof chrome === "undefined"
    || !chrome.identity
    || typeof chrome.identity.getRedirectURL !== "function") {
    return "";
  }
  try {
    const url = String(chrome.identity.getRedirectURL(IDENTITY_PROVIDER_OAUTH_REDIRECT_PATH) || "").trim();
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || !/^[a-z0-9-]+\.chromiumapp\.org$/i.test(parsed.hostname)) return "";
    if (parsed.pathname !== "/" + IDENTITY_PROVIDER_OAUTH_REDIRECT_PATH) return "";
    return parsed.toString();
  } catch (_) {
    return "";
  }
}

function identityProviderOAuth_launchWebAuthFlow(url) {
  if (typeof chrome === "undefined"
    || !chrome.identity
    || typeof chrome.identity.launchWebAuthFlow !== "function") {
    return Promise.resolve({ ok: false, errorCode: "identity/oauth-permission-unavailable", callbackUrl: null });
  }
  return new Promise((resolve) => {
    try {
      chrome.identity.launchWebAuthFlow({ url, interactive: true }, (callbackUrl) => {
        const lastError = chrome.runtime && chrome.runtime.lastError;
        if (lastError) {
          const message = String(lastError.message || "").toLowerCase();
          resolve({
            ok: false,
            errorCode: /cancel|close|abort/.test(message) ? "identity/oauth-cancelled" : "identity/oauth-failed",
            callbackUrl: null,
          });
          return;
        }
        const safeUrl = String(callbackUrl || "").trim();
        resolve(safeUrl
          ? { ok: true, callbackUrl: safeUrl }
          : { ok: false, errorCode: "identity/oauth-callback-invalid", callbackUrl: null });
      });
    } catch (_) {
      resolve({ ok: false, errorCode: "identity/oauth-failed", callbackUrl: null });
    }
  });
}

async function identityProviderBundle_beginOAuthSignIn(req = {}) {
  identityProviderBundle_ensureProbeLoaded();
  if (identityProviderBundleProbeState.loaded !== true
    || typeof identityProviderBundleProbeState.beginOAuthSignInRunner !== "function") {
    return { ok: false, errorCode: "identity/oauth-provider-unavailable" };
  }
  const loadedPrivateConfig = identityProviderBundle_loadPrivateConfig();
  if (!loadedPrivateConfig.ok) return { ok: false, errorCode: "identity/provider-not-configured" };
  try {
    const result = await identityProviderBundleProbeState.beginOAuthSignInRunner(
      loadedPrivateConfig.privateConfig,
      { provider: "google", redirectTo: req.redirectTo }
    );
    return result && typeof result === "object" ? result : { ok: false, errorCode: "identity/oauth-response-malformed" };
  } catch (_) {
    return { ok: false, errorCode: "identity/oauth-failed" };
  }
}

async function identityProviderBundle_completeOAuthSignIn(req = {}) {
  identityProviderBundle_ensureProbeLoaded();
  if (identityProviderBundleProbeState.loaded !== true
    || typeof identityProviderBundleProbeState.completeOAuthSignInRunner !== "function") {
    return { ok: false, errorCode: "identity/oauth-provider-unavailable", rawSession: null };
  }
  const loadedPrivateConfig = identityProviderBundle_loadPrivateConfig();
  if (!loadedPrivateConfig.ok) return { ok: false, errorCode: "identity/provider-not-configured", rawSession: null };
  try {
    const result = await identityProviderBundleProbeState.completeOAuthSignInRunner(
      loadedPrivateConfig.privateConfig,
      {
        provider: "google",
        callbackUrl: req.callbackUrl,
        flowState: req.flowState,
      }
    );
    const rawSession = result && result.rawSession && typeof result.rawSession === "object" ? result.rawSession : null;
    return result && result.ok === true && rawSession
      ? { ...result, rawSession }
      : { ok: false, errorCode: result?.errorCode || "identity/oauth-exchange-failed", rawSession: null };
  } catch (_) {
    return { ok: false, errorCode: "identity/oauth-exchange-failed", rawSession: null };
  }
}

async function identityProviderBundle_markOAuthCredentialCompleted(req = {}) {
  identityProviderBundle_ensureProbeLoaded();
  if (identityProviderBundleProbeState.loaded !== true
    || typeof identityProviderBundleProbeState.markOAuthCredentialCompletedRunner !== "function") {
    return { ok: false, errorCode: "identity/credential-status-provider-unavailable", credentialState: "unknown", credentialProvider: "unknown" };
  }
  const rawSession = req.rawSession && typeof req.rawSession === "object" ? req.rawSession : null;
  if (!rawSession) {
    return { ok: false, errorCode: "identity/credential-status-session-missing", credentialState: "unknown", credentialProvider: "unknown" };
  }
  const loadedPrivateConfig = identityProviderBundle_loadPrivateConfig();
  if (!loadedPrivateConfig.ok) {
    return { ok: false, errorCode: "identity/credential-status-provider-unavailable", credentialState: "unknown", credentialProvider: "unknown" };
  }
  try {
    const result = await identityProviderBundleProbeState.markOAuthCredentialCompletedRunner(
      loadedPrivateConfig.privateConfig,
      { rawSession, provider: "google" }
    );
    const credentialState = identityCredentialState_fromProviderResult(result);
    const credentialProvider = identityCredentialProvider_fromProviderResult(result);
    if (!result || result.ok !== true || credentialState !== "complete" || credentialProvider !== "google") {
      return {
        ok: false,
        errorCode: result?.errorCode || "identity/credential-status-update-failed",
        credentialState,
        credentialProvider,
      };
    }
    return { ok: true, credentialState: "complete", credentialProvider: "google" };
  } catch (_) {
    return { ok: false, errorCode: "identity/credential-status-update-failed", credentialState: "unknown", credentialProvider: "unknown" };
  }
}

async function identityProviderCredentialState_markOAuthCompleteForSession(rawSession) {
  const rpcSession = identityProviderSession_makeRpcSessionForOnboarding(rawSession);
  if (!rpcSession || identityProviderSession_isExpired(rpcSession)) {
    return { ok: false, errorCode: "identity/credential-status-session-missing", credentialState: "unknown", credentialProvider: "unknown" };
  }
  const result = await identityProviderBundle_markOAuthCredentialCompleted({ rawSession: rpcSession });
  return result && result.ok === true
    ? { ok: true, credentialState: "complete", credentialProvider: "google" }
    : {
      ok: false,
      errorCode: result?.errorCode || "identity/credential-status-update-failed",
      credentialState: identityCredentialState_fromProviderResult(result),
      credentialProvider: identityCredentialProvider_fromProviderResult(result),
    };
}

async function identityProviderSession_tryCloudIdentityRestore(runtime, rawSession) {
  if (!runtime
    || (runtime.status !== "verified_no_profile" && runtime.status !== "sync_ready")
    || runtime.mode !== "provider_backed"
    || runtime.provider !== "supabase"
    || runtime.providerKind !== "supabase") {
    return runtime;
  }
  const rpcSession = identityProviderSession_makeRpcSessionForOnboarding(rawSession);
  if (!rpcSession || identityProviderSession_isExpired(rpcSession)) return runtime;
  const status = await identityProviderConfig_diagAsync();
  if (status.providerConfigured !== true
    || status.clientReady !== true
    || status.permissionReady !== true
    || status.phaseNetworkEnabled !== true
    || status.networkReady !== true) {
    return runtime;
  }
  const providerResult = await identityProviderBundle_loadIdentityState({ rawSession: rpcSession });
  if (providerResult && providerResult.ok === true) {
    const credentialState = identityCredentialState_fromProviderResult(providerResult);
    const credentialProvider = identityCredentialProvider_fromProviderResult(providerResult);
    if (!identityCredentialState_isComplete(credentialState)) {
      await identityProviderPasswordUpdateRequired_storeReason("credential_required");
      return identityProviderPasswordUpdateRequired_runtimeFromSession(rawSession) || {
        ...runtime,
        status: "password_update_required",
        credentialState: "required",
        credentialProvider,
        onboardingCompleted: false,
        syncReady: false,
        profile: null,
        workspace: null,
        lastError: null,
        updatedAt: identityRuntime_nowIso(),
      };
    }
    if (providerResult.complete === true) {
      return identityProviderOnboarding_runtime(runtime, providerResult.profile, providerResult.workspace, {
        credentialState: "complete",
        credentialProvider,
      });
    }
    const baseRuntime = identityProviderSession_extractSafeRuntime(rawSession);
    return {
      ...(baseRuntime || runtime),
      status: "verified_no_profile",
      credentialState: "complete",
      credentialProvider,
      onboardingCompleted: false,
      syncReady: false,
      profile: null,
      workspace: null,
      updatedAt: identityRuntime_nowIso(),
    };
  }
  return {
    ...runtime,
    lastError: identityProviderCloudLoad_safeError(providerResult && providerResult.errorCode),
    updatedAt: identityRuntime_nowIso(),
  };
}

// ─── Device sessions (Phase 5.0E browser registration) ─────────────────────
// The plain device token lives ONLY in chrome.storage.local under
// IDENTITY_DEVICE_TOKEN_KEY and is never sent to the server. The server stores
// only its SHA-256 hash. Helpers below never console.* the plain token or the
// full hash. signOut intentionally leaves the token in place so the same row
// is upserted on the next sign-in (idempotent register).

const IDENTITY_DEVICE_TOKEN_KEY = "h2o.identity.device.token.v1";
const IDENTITY_DEVICE_LABEL_KEY = "h2o.identity.device.label.v1";

function identityDeviceSession_bytesToHex(bytes) {
  let out = "";
  for (let i = 0; i < bytes.length; i += 1) {
    out += bytes[i].toString(16).padStart(2, "0");
  }
  return out;
}

function identityDeviceSession_storageGetLocal(keys) {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get(keys, (data) => {
        if (chrome.runtime && chrome.runtime.lastError) {
          resolve(null);
          return;
        }
        resolve(data && typeof data === "object" ? data : null);
      });
    } catch (_) {
      resolve(null);
    }
  });
}

function identityDeviceSession_storageSetLocal(items) {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.set(items || {}, () => {
        if (chrome.runtime && chrome.runtime.lastError) {
          resolve(false);
          return;
        }
        resolve(true);
      });
    } catch (_) {
      resolve(false);
    }
  });
}

async function identityDeviceSession_ensureToken() {
  // Read from chrome.storage.local. If absent or malformed, generate a fresh
  // 64-char hex token and persist. Same token reused across sign-ins so the
  // server-side row is upserted, not duplicated.
  const stored = await identityDeviceSession_storageGetLocal([IDENTITY_DEVICE_TOKEN_KEY]);
  const existing = stored && typeof stored[IDENTITY_DEVICE_TOKEN_KEY] === "string"
    ? stored[IDENTITY_DEVICE_TOKEN_KEY]
    : "";
  if (/^[0-9a-f]{64}$/.test(existing)) return existing;
  const buf = new Uint8Array(32);
  crypto.getRandomValues(buf);
  const fresh = identityDeviceSession_bytesToHex(buf);
  await identityDeviceSession_storageSetLocal({ [IDENTITY_DEVICE_TOKEN_KEY]: fresh });
  return fresh;
}

async function identityDeviceSession_hashToken(tokenHex) {
  // SHA-256 of UTF-8 bytes of the hex string. Matches mobile's hashing strategy.
  const utf8 = new TextEncoder().encode(tokenHex);
  const digest = await crypto.subtle.digest("SHA-256", utf8);
  return identityDeviceSession_bytesToHex(new Uint8Array(digest));
}

async function identityDeviceSession_deriveLabel() {
  // Cached label is preferred so it stays stable even if Chrome relaunches
  // under a different OS user. First call derives a coarse platform tag.
  const cached = await identityDeviceSession_storageGetLocal([IDENTITY_DEVICE_LABEL_KEY]);
  const cachedLabel = cached && typeof cached[IDENTITY_DEVICE_LABEL_KEY] === "string"
    ? cached[IDENTITY_DEVICE_LABEL_KEY].trim()
    : "";
  if (cachedLabel.length > 0 && cachedLabel.length <= 64) return cachedLabel;
  let platformCoarse = "Browser";
  try {
    const uad = (typeof navigator !== "undefined" && navigator) ? navigator.userAgentData : null;
    const platform = uad && typeof uad.platform === "string" ? uad.platform : "";
    if (platform) {
      if (/mac/i.test(platform)) platformCoarse = "Mac";
      else if (/win/i.test(platform)) platformCoarse = "Windows";
      else if (/linux|chromeos|cros/i.test(platform)) platformCoarse = "Linux";
    } else if (typeof navigator !== "undefined" && typeof navigator.userAgent === "string") {
      const ua = navigator.userAgent;
      if (/mac/i.test(ua)) platformCoarse = "Mac";
      else if (/win/i.test(ua)) platformCoarse = "Windows";
      else if (/linux|cros/i.test(ua)) platformCoarse = "Linux";
    }
  } catch (_) {
    // Fall through to default "Browser".
  }
  // Plain string concat. This emitted bg.js source lives inside the build-time
  // template literal at the top of makeChromeLiveBackgroundJs, so a runtime
  // template literal here would close the outer one early. Same reason no
  // dollar-brace interpolations appear in the rest of this block.
  const label = platformCoarse + " — Chrome";
  await identityDeviceSession_storageSetLocal({ [IDENTITY_DEVICE_LABEL_KEY]: label });
  return label;
}

async function identityDeviceSession_register(rawSession) {
  // Best-effort: never throws, never blocks auth flow, never logs sensitive data.
  // Idempotent server-side via the (user_id, device_token_hash) UNIQUE upsert.
  try {
    if (!rawSession || typeof rawSession !== "object") return;
    const accessToken = typeof rawSession.access_token === "string" ? rawSession.access_token : "";
    if (!accessToken) return;
    identityProviderBundle_ensureProbeLoaded();
    if (identityProviderBundleProbeState.loaded !== true
      || typeof identityProviderBundleProbeState.registerDeviceSessionRunner !== "function") {
      return;
    }
    const loadedPrivateConfig = identityProviderBundle_loadPrivateConfig();
    if (!loadedPrivateConfig.ok) return;
    const tokenHex = await identityDeviceSession_ensureToken();
    if (!/^[0-9a-f]{64}$/.test(tokenHex)) return;
    const deviceTokenHash = await identityDeviceSession_hashToken(tokenHex);
    const label = await identityDeviceSession_deriveLabel();
    await identityProviderBundleProbeState.registerDeviceSessionRunner(
      loadedPrivateConfig.privateConfig,
      accessToken,
      { surface: "chrome_extension", label, deviceTokenHash }
    );
  } catch (_) {
    // Best-effort — never raise.
  }
}

async function identityProviderSession_publishSafeRuntime(safeRuntime, shouldBroadcast = true, options = {}) {
  const opts = options && typeof options === "object" ? options : {};
  // Phase 5.0E (browser): fire-and-forget device-session registration whenever
  // a fresh rawSession is being published. Runs concurrent with cloud-load /
  // snapshot persistence; idempotent server-side; failures swallowed.
  if (opts.rawSession) {
    void identityDeviceSession_register(opts.rawSession);
  }
  let runtime = await identityProviderSession_preserveReadyRuntime(safeRuntime);
  if (opts.honorPasswordUpdateRequired !== false && opts.rawSession) {
    const markerActive = await identityProviderPasswordUpdateRequired_isActive();
    if (markerActive) {
      runtime = identityProviderPasswordUpdateRequired_runtimeFromSession(opts.rawSession) || runtime;
      await identityAuthManager_setRuntime(runtime);
      const markerSnapshot = identitySnapshot_fromRuntime(runtime);
      if (markerSnapshot) {
        await identityAuthManager_storeSnapshot(markerSnapshot);
        if (shouldBroadcast) broadcastIdentityPush(markerSnapshot);
      }
      return { ok: true, runtime, snapshot: markerSnapshot };
    }
  }
  if (opts.allowCloudLoad !== false && opts.rawSession) {
    runtime = await identityProviderSession_tryCloudIdentityRestore(runtime, opts.rawSession);
  }
  await identityAuthManager_setRuntime(runtime);
  const safeSnapshot = identitySnapshot_fromRuntime(runtime);
  if (safeSnapshot) {
    await identityAuthManager_storeSnapshot(safeSnapshot);
    if (shouldBroadcast) broadcastIdentityPush(safeSnapshot);
  }
  return { ok: true, runtime, snapshot: safeSnapshot };
}

function identityProviderRefresh_errorMessage(errorCode) {
  switch (String(errorCode || "")) {
    case "identity/refresh-token-missing":
      return "Session refresh is unavailable.";
    case "identity/provider-refresh-unavailable":
      return "Session refresh is not available.";
    case "identity/provider-network-failed":
      return "The provider could not be reached.";
    case "identity/provider-session-storage-unavailable":
      return "Session storage is unavailable.";
    case "identity/provider-response-malformed":
      return "The provider returned an invalid refresh response.";
    case "identity/provider-rejected":
    case "identity/session-refresh-failed":
      return "Session refresh failed.";
    default:
      return "Session refresh failed.";
  }
}

function identityProviderRefresh_failure(errorCode) {
  const code = String(errorCode || "identity/session-refresh-failed");
  return {
    ok: false,
    nextStatus: "auth_error",
    errorCode: code,
    errorMessage: identityProviderRefresh_errorMessage(code),
  };
}

function identityProviderRefresh_success(runtime) {
  const now = identityRuntime_nowIso();
  const status = String(runtime && runtime.status || "verified_no_profile");
  return {
    ok: true,
    nextStatus: status === "password_update_required" || status === "sync_ready" ? status : "verified_no_profile",
    sessionExpiresAt: runtime?.sessionExpiresAt || null,
    updatedAt: runtime?.updatedAt || now,
  };
}

async function identityProviderPersistentRefresh_restoreOnWake(shouldBroadcast = true) {
  if (identityProviderSession_restoreSuppressedDuringSignOut()) {
    return { ok: false, errorCode: "identity/provider-restore-suppressed" };
  }
  const context = await identityProviderPersistentRefresh_getRestoreContext();
  if (!context.ok) {
    return { ok: false, errorCode: context.errorCode || "identity/provider-session-missing" };
  }
  let storedRecord = null;
  try {
    storedRecord = await identityProviderPersistentRefresh_readStoredRecord();
  } catch (_) {
    return { ok: false, errorCode: "identity/provider-session-missing" };
  }
  if (!storedRecord) {
    return { ok: false, errorCode: "identity/provider-session-missing" };
  }
  const record = identityProviderPersistentRefresh_normalizeRecord(storedRecord);
  if (!record || record.projectOrigin !== context.projectOrigin) {
    await identityProviderPersistentRefresh_remove();
    return identityProviderSession_clearExpired("identity/provider-persistent-refresh-invalid", shouldBroadcast);
  }
  const providerResult = await identityProviderBundle_refreshProviderSession({ refreshToken: record.refresh_token });
  if (identityProviderSession_restoreSuppressedDuringSignOut()) {
    return { ok: false, errorCode: "identity/provider-restore-suppressed" };
  }
  if (!providerResult || providerResult.ok !== true || !providerResult.rawSession) {
    const errorCode = providerResult?.errorCode || "identity/session-refresh-failed";
    if (identityProviderPersistentRefresh_shouldClearForRefreshError(errorCode)) {
      await identityProviderPersistentRefresh_remove();
      return identityProviderSession_clearExpired(errorCode, shouldBroadcast);
    }
    return { ok: false, errorCode };
  }
  const safeRuntime = identityProviderSession_extractSafeRuntime(providerResult.rawSession);
  if (!safeRuntime) {
    await identityProviderPersistentRefresh_remove();
    return identityProviderSession_clearExpired("identity/provider-response-malformed", shouldBroadcast);
  }
  try {
    await providerSessionSet({ [IDENTITY_PROVIDER_SESSION_KEY]: providerResult.rawSession });
  } catch (_) {
    return { ok: false, errorCode: "identity/provider-session-storage-unavailable" };
  }
  await identityProviderPersistentRefresh_storeFromSession(providerResult.rawSession, {
    existingRecord: record,
    rotate: true,
  });
  const published = await identityProviderSession_publishSafeRuntime(safeRuntime, shouldBroadcast, {
    rawSession: providerResult.rawSession,
  });
  return { ...published, refreshed: true, persistentRestore: true };
}

async function identityProviderSession_refreshRaw(rawSession, shouldBroadcast = true) {
  if (identityProviderSessionRefreshPromise) return identityProviderSessionRefreshPromise;
  identityProviderSessionRefreshPromise = (async () => {
    if (identityProviderSession_restoreSuppressedDuringSignOut()) {
      return { ok: false, errorCode: "identity/provider-restore-suppressed" };
    }
    if (!providerSessionStorageStrict()) {
      return identityProviderSession_clearExpired("identity/provider-session-storage-unavailable", shouldBroadcast);
    }
    const refreshToken = identityProviderSession_refreshToken(rawSession);
    if (!refreshToken) {
      return identityProviderSession_clearExpired("identity/refresh-token-missing", shouldBroadcast);
    }
    const providerResult = await identityProviderBundle_refreshProviderSession({ refreshToken });
    if (identityProviderSession_restoreSuppressedDuringSignOut()) {
      return { ok: false, errorCode: "identity/provider-restore-suppressed" };
    }
    if (!providerResult || providerResult.ok !== true || !providerResult.rawSession) {
      if (identityProviderPersistentRefresh_shouldClearForRefreshError(providerResult?.errorCode)) {
        await identityProviderPersistentRefresh_remove();
      }
      return identityProviderSession_clearExpired(
        providerResult?.errorCode || "identity/session-refresh-failed",
        shouldBroadcast
      );
    }
    const safeRuntime = identityProviderSession_extractSafeRuntime(providerResult.rawSession);
    if (!safeRuntime) {
      return identityProviderSession_clearExpired("identity/provider-response-malformed", shouldBroadcast);
    }
    try {
      await providerSessionSet({ [IDENTITY_PROVIDER_SESSION_KEY]: providerResult.rawSession });
    } catch (_) {
      return identityProviderSession_clearExpired("identity/provider-session-storage-unavailable", shouldBroadcast);
    }
    await identityProviderPersistentRefresh_rotateFromSessionIfPresent(providerResult.rawSession);
    const published = await identityProviderSession_publishSafeRuntime(safeRuntime, shouldBroadcast, {
      rawSession: providerResult.rawSession,
    });
    return { ...published, refreshed: true };
  })();
  try {
    return await identityProviderSessionRefreshPromise;
  } finally {
    identityProviderSessionRefreshPromise = null;
  }
}

async function identityProviderSession_hydrateOnWake(options = {}) {
  if (identityProviderSessionHydrationPromise) return identityProviderSessionHydrationPromise;
  const shouldBroadcast = options.broadcast !== false;
  const allowRefresh = options.allowRefresh === true;
  identityProviderSessionHydrationPromise = (async () => {
    if (identityProviderSession_restoreSuppressedDuringSignOut()) {
      return { ok: false, errorCode: "identity/provider-restore-suppressed" };
    }
    if (!providerSessionStorageStrict()) return { ok: false, errorCode: "identity/provider-session-storage-unavailable" };
    let rawSession = null;
    try {
      rawSession = await identityProviderSession_readRaw();
    } catch (_) {
      return { ok: false, errorCode: "identity/provider-session-storage-unavailable" };
    }
    if (!rawSession) {
      if (allowRefresh) return identityProviderPersistentRefresh_restoreOnWake(shouldBroadcast);
      return { ok: false, errorCode: "identity/provider-session-missing" };
    }
    if (identityProviderSession_refreshIsDue(rawSession)) {
      if (allowRefresh) {
        return identityProviderSession_refreshRaw(rawSession, shouldBroadcast);
      }
      if (identityProviderSession_isExpired(rawSession) && !identityProviderSession_refreshToken(rawSession)) {
        return identityProviderSession_clearExpired("identity/refresh-token-missing", shouldBroadcast);
      }
      if (identityProviderSession_isExpired(rawSession)) {
        return { ok: false, errorCode: "identity/session-refresh-required" };
      }
    }
    const safeRuntime = identityProviderSession_extractSafeRuntime(rawSession);
    if (!safeRuntime) {
      const expiresMs = identityProviderSession_expiryMs(rawSession);
      let reason = "identity/provider-response-malformed";
      if (expiresMs && identityProviderSession_isExpired(rawSession)) {
        reason = identityProviderSession_refreshToken(rawSession)
          ? "identity/session-refresh-required"
          : "identity/session-expired";
      }
      return reason === "identity/session-refresh-required"
        ? { ok: false, errorCode: reason }
        : identityProviderSession_clearExpired(reason, shouldBroadcast);
    }
    return identityProviderSession_publishSafeRuntime(safeRuntime, shouldBroadcast, { rawSession });
  })();
  try {
    return await identityProviderSessionHydrationPromise;
  } finally {
    identityProviderSessionHydrationPromise = null;
  }
}

function identityProviderSession_scheduleWakeHydration(reason = "boot") {
  identityProviderSession_hydrateOnWake({ reason, broadcast: true, allowRefresh: false }).catch(() => {});
}

async function identityProviderSession_storeRaw(providerResult = {}) {
  if (identityProviderSession_restoreSuppressedDuringSignOut()) {
    return { ok: false, errorCode: "identity/sign-out-in-progress" };
  }
  const rawSession = providerResult && typeof providerResult === "object"
    ? identityProviderSession_normalizeStoredSession(providerResult.rawSession)
    : null;
  if (!rawSession || typeof rawSession !== "object") {
    return { ok: false, errorCode: "identity/provider-response-malformed" };
  }
  try {
    await providerSessionSet({ [IDENTITY_PROVIDER_SESSION_KEY]: rawSession });
    return { ok: true };
  } catch (_) {
    return { ok: false, errorCode: "identity/operation-not-permitted-in-phase" };
  }
}

async function identityProviderBundle_requestEmailOtp(req = {}) {
  identityProviderBundle_ensureProbeLoaded();
  if (identityProviderBundleProbeState.loaded !== true || typeof identityProviderBundleProbeState.requestEmailOtpRunner !== "function") {
    return identityProviderOtp_failure("identity/provider-auth-unavailable");
  }
  const loadedPrivateConfig = identityProviderBundle_loadPrivateConfig();
  if (!loadedPrivateConfig.ok) {
    return identityProviderOtp_failure("identity/provider-not-configured");
  }
  try {
    const providerResult = await identityProviderBundleProbeState.requestEmailOtpRunner(
      loadedPrivateConfig.privateConfig,
      { email: req.email }
    );
    return identityProviderOtp_sanitizeProviderResult(req.email, providerResult);
  } catch (_) {
    return identityProviderOtp_failure("identity/provider-request-failed");
  }
}

function identityProviderVerify_sanitizeProviderResult(email, result) {
  const src = result && typeof result === "object" ? result : {};
  if (src.ok === true) return identityProviderVerify_success(email, src);
  return identityProviderVerify_failure(src.errorCode || "identity/provider-rejected");
}

async function identityProviderBundle_verifyEmailOtp(req = {}) {
  identityProviderBundle_ensureProbeLoaded();
  if (identityProviderBundleProbeState.loaded !== true || typeof identityProviderBundleProbeState.verifyEmailOtpRunner !== "function") {
    return { response: identityProviderVerify_failure("identity/provider-unavailable"), providerResult: null };
  }
  const loadedPrivateConfig = identityProviderBundle_loadPrivateConfig();
  if (!loadedPrivateConfig.ok) {
    return { response: identityProviderVerify_failure("identity/provider-unavailable"), providerResult: null };
  }
  try {
    const providerResult = await identityProviderBundleProbeState.verifyEmailOtpRunner(
      loadedPrivateConfig.privateConfig,
      { email: req.email, code: req.code }
    );
    return {
      response: identityProviderVerify_sanitizeProviderResult(req.email, providerResult),
      providerResult: providerResult && typeof providerResult === "object" ? providerResult : null,
    };
  } catch (_) {
    return { response: identityProviderVerify_failure("identity/provider-rejected"), providerResult: null };
  }
}

function identityProviderPassword_sanitizeAuthProviderResult(email, result, { allowConfirmationPending = false } = {}) {
  const src = result && typeof result === "object" ? result : {};
  if (src.ok === true && src.rawSession && typeof src.rawSession === "object") {
    return {
      response: identityProviderVerify_success(email, src),
      providerResult: src,
      confirmationPending: false,
    };
  }
  if (allowConfirmationPending && src.ok === true && src.confirmationRequired === true) {
    return {
      response: identityProviderPassword_confirmationPending(email),
      providerResult: null,
      confirmationPending: true,
    };
  }
  return {
    response: identityProviderPassword_failure(src.errorCode || "identity/provider-rejected"),
    providerResult: null,
    confirmationPending: false,
  };
}

function identityProviderSignupConfirmation_sanitizeProviderResult(email, result) {
  const src = result && typeof result === "object" ? result : {};
  if (src.ok === true && src.rawSession && typeof src.rawSession === "object") {
    return {
      response: identityProviderVerify_success(email, src),
      providerResult: src,
      confirmationPending: false,
    };
  }
  if (src.ok === true && src.confirmationRequired === true) {
    return {
      response: identityProviderPassword_confirmationPending(email),
      providerResult: null,
      confirmationPending: true,
    };
  }
  return {
    response: identityProviderVerify_failure(src.errorCode || "identity/provider-rejected"),
    providerResult: null,
    confirmationPending: false,
  };
}

async function identityProviderBundle_signUpWithPassword(req = {}) {
  identityProviderBundle_ensureProbeLoaded();
  if (identityProviderBundleProbeState.loaded !== true
    || typeof identityProviderBundleProbeState.signUpWithPasswordRunner !== "function") {
    return { response: identityProviderPassword_failure("identity/provider-auth-unavailable"), providerResult: null, confirmationPending: false };
  }
  const loadedPrivateConfig = identityProviderBundle_loadPrivateConfig();
  if (!loadedPrivateConfig.ok) {
    return { response: identityProviderPassword_failure("identity/provider-not-configured"), providerResult: null, confirmationPending: false };
  }
  try {
    const providerResult = await identityProviderBundleProbeState.signUpWithPasswordRunner(
      loadedPrivateConfig.privateConfig,
      { email: req.email, password: req.password }
    );
    return identityProviderPassword_sanitizeAuthProviderResult(req.email, providerResult, {
      allowConfirmationPending: true,
    });
  } catch (_) {
    return { response: identityProviderPassword_failure("identity/provider-rejected"), providerResult: null, confirmationPending: false };
  }
}

async function identityProviderBundle_verifySignupEmailCode(req = {}) {
  identityProviderBundle_ensureProbeLoaded();
  if (identityProviderBundleProbeState.loaded !== true
    || typeof identityProviderBundleProbeState.verifySignupEmailCodeRunner !== "function") {
    return { response: identityProviderVerify_failure("identity/provider-unavailable"), providerResult: null, confirmationPending: false };
  }
  const loadedPrivateConfig = identityProviderBundle_loadPrivateConfig();
  if (!loadedPrivateConfig.ok) {
    return { response: identityProviderVerify_failure("identity/provider-unavailable"), providerResult: null, confirmationPending: false };
  }
  try {
    const providerResult = await identityProviderBundleProbeState.verifySignupEmailCodeRunner(
      loadedPrivateConfig.privateConfig,
      { email: req.email, code: req.code }
    );
    return identityProviderSignupConfirmation_sanitizeProviderResult(req.email, providerResult);
  } catch (_) {
    return { response: identityProviderVerify_failure("identity/provider-rejected"), providerResult: null, confirmationPending: false };
  }
}

async function identityProviderBundle_resendSignupConfirmation(req = {}) {
  identityProviderBundle_ensureProbeLoaded();
  if (identityProviderBundleProbeState.loaded !== true
    || typeof identityProviderBundleProbeState.resendSignupConfirmationRunner !== "function") {
    return identityProviderPassword_failure("identity/provider-auth-unavailable");
  }
  const loadedPrivateConfig = identityProviderBundle_loadPrivateConfig();
  if (!loadedPrivateConfig.ok) {
    return identityProviderPassword_failure("identity/provider-not-configured");
  }
  try {
    const providerResult = await identityProviderBundleProbeState.resendSignupConfirmationRunner(
      loadedPrivateConfig.privateConfig,
      { email: req.email }
    );
    if (providerResult && providerResult.ok === true) return identityProviderPassword_confirmationPending(req.email);
    return identityProviderPassword_failure(providerResult && providerResult.errorCode || "identity/provider-request-failed");
  } catch (_) {
    return identityProviderPassword_failure("identity/provider-request-failed");
  }
}

async function identityProviderBundle_signInWithPassword(req = {}) {
  identityProviderBundle_ensureProbeLoaded();
  if (identityProviderBundleProbeState.loaded !== true
    || typeof identityProviderBundleProbeState.signInWithPasswordRunner !== "function") {
    return { response: identityProviderPassword_failure("identity/provider-auth-unavailable"), providerResult: null, confirmationPending: false };
  }
  const loadedPrivateConfig = identityProviderBundle_loadPrivateConfig();
  if (!loadedPrivateConfig.ok) {
    return { response: identityProviderPassword_failure("identity/provider-not-configured"), providerResult: null, confirmationPending: false };
  }
  try {
    const providerResult = await identityProviderBundleProbeState.signInWithPasswordRunner(
      loadedPrivateConfig.privateConfig,
      { email: req.email, password: req.password }
    );
    return identityProviderPassword_sanitizeAuthProviderResult(req.email, providerResult);
  } catch (_) {
    return { response: identityProviderPassword_failure("identity/provider-rejected"), providerResult: null, confirmationPending: false };
  }
}

async function identityProviderBundle_requestPasswordReset(req = {}) {
  identityProviderBundle_ensureProbeLoaded();
  if (identityProviderBundleProbeState.loaded !== true
    || typeof identityProviderBundleProbeState.requestPasswordResetRunner !== "function") {
    return identityProviderPassword_failure("identity/provider-auth-unavailable");
  }
  const loadedPrivateConfig = identityProviderBundle_loadPrivateConfig();
  if (!loadedPrivateConfig.ok) {
    return identityProviderPassword_failure("identity/provider-not-configured");
  }
  try {
    const providerResult = await identityProviderBundleProbeState.requestPasswordResetRunner(
      loadedPrivateConfig.privateConfig,
      { email: req.email }
    );
    if (providerResult && providerResult.ok === true) return identityProviderPassword_resetRequested(req.email);
    return identityProviderPassword_failure(providerResult && providerResult.errorCode || "identity/provider-request-failed");
  } catch (_) {
    return identityProviderPassword_failure("identity/provider-request-failed");
  }
}

async function identityProviderBundle_updatePasswordAfterRecovery(req = {}) {
  identityProviderBundle_ensureProbeLoaded();
  if (identityProviderBundleProbeState.loaded !== true
    || typeof identityProviderBundleProbeState.updatePasswordAfterRecoveryRunner !== "function") {
    return identityProviderPassword_failure("identity/provider-auth-unavailable");
  }
  const loadedPrivateConfig = identityProviderBundle_loadPrivateConfig();
  if (!loadedPrivateConfig.ok) {
    return identityProviderPassword_failure("identity/provider-not-configured");
  }
  try {
    const providerResult = await identityProviderBundleProbeState.updatePasswordAfterRecoveryRunner(
      loadedPrivateConfig.privateConfig,
      { rawSession: req.rawSession, password: req.password }
    );
    if (providerResult && providerResult.ok === true) return { ok: true, nextStatus: "sync_ready" };
    return identityProviderPassword_failure(providerResult && providerResult.errorCode || "identity/password-update-failed");
  } catch (_) {
    return identityProviderPassword_failure("identity/password-update-failed");
  }
}

async function identityProviderBundle_changePassword(req = {}) {
  identityProviderBundle_ensureProbeLoaded();
  if (identityProviderBundleProbeState.loaded !== true
    || typeof identityProviderBundleProbeState.changePasswordRunner !== "function") {
    return identityProviderPassword_failure("identity/provider-auth-unavailable");
  }
  const loadedPrivateConfig = identityProviderBundle_loadPrivateConfig();
  if (!loadedPrivateConfig.ok) {
    return identityProviderPassword_failure("identity/provider-not-configured");
  }
  try {
    const providerResult = await identityProviderBundleProbeState.changePasswordRunner(
      loadedPrivateConfig.privateConfig,
      {
        rawSession: req.rawSession,
        currentPassword: req.currentPassword,
        password: req.password,
      }
    );
    if (providerResult && providerResult.ok === true) return { ok: true, nextStatus: "sync_ready" };
    return identityProviderPassword_failure(providerResult && providerResult.errorCode || "identity/password-update-failed");
  } catch (_) {
    return identityProviderPassword_failure("identity/password-update-failed");
  }
}

function identityProviderRefresh_sanitizeProviderResult(result) {
  const src = result && typeof result === "object" ? result : {};
  if (src.ok !== true) {
    return {
      ok: false,
      errorCode: String(src.errorCode || "identity/session-refresh-failed"),
      rawSession: null,
    };
  }
  const rawSession = src.rawSession && typeof src.rawSession === "object" ? src.rawSession : null;
  if (!rawSession) {
    return {
      ok: false,
      errorCode: "identity/provider-response-malformed",
      rawSession: null,
    };
  }
  return {
    ok: true,
    rawSession,
  };
}

async function identityProviderBundle_refreshProviderSession(req = {}) {
  identityProviderBundle_ensureProbeLoaded();
  if (identityProviderBundleProbeState.loaded !== true
    || typeof identityProviderBundleProbeState.refreshProviderSessionRunner !== "function") {
    return { ok: false, errorCode: "identity/provider-refresh-unavailable", rawSession: null };
  }
  const loadedPrivateConfig = identityProviderBundle_loadPrivateConfig();
  if (!loadedPrivateConfig.ok) {
    return { ok: false, errorCode: "identity/provider-refresh-unavailable", rawSession: null };
  }
  try {
    return identityProviderRefresh_sanitizeProviderResult(
      await identityProviderBundleProbeState.refreshProviderSessionRunner(
        loadedPrivateConfig.privateConfig,
        req.refreshToken
      )
    );
  } catch (_) {
    return { ok: false, errorCode: "identity/session-refresh-failed", rawSession: null };
  }
}

function identityProviderSignOut_sanitizeProviderResult(result) {
  const src = result && typeof result === "object" ? result : {};
  if (src.ok === true) return { ok: true };
  return {
    ok: false,
    errorCode: String(src.errorCode || "identity/provider-sign-out-failed"),
  };
}

async function identityProviderBundle_signOutProviderSession(req = {}) {
  identityProviderBundle_ensureProbeLoaded();
  if (identityProviderBundleProbeState.loaded !== true
    || typeof identityProviderBundleProbeState.signOutProviderSessionRunner !== "function") {
    return { ok: false, errorCode: "identity/provider-sign-out-unavailable" };
  }
  const rawSession = req.rawSession && typeof req.rawSession === "object" ? req.rawSession : null;
  if (!rawSession) return { ok: false, errorCode: "identity/provider-sign-out-skipped" };
  const loadedPrivateConfig = identityProviderBundle_loadPrivateConfig();
  if (!loadedPrivateConfig.ok) {
    return { ok: false, errorCode: "identity/provider-sign-out-unavailable" };
  }
  try {
    return identityProviderSignOut_sanitizeProviderResult(
      await identityProviderBundleProbeState.signOutProviderSessionRunner(
        loadedPrivateConfig.privateConfig,
        { rawSession }
      )
    );
  } catch (_) {
    return { ok: false, errorCode: "identity/provider-sign-out-failed" };
  }
}

function identityProviderOnboarding_normalizeErrorCode(input) {
  const code = String(input || "").trim().toLowerCase().replace(/[^a-z0-9_/-]/g, "").slice(0, 96);
  return IDENTITY_PROVIDER_ONBOARDING_ALLOWED_ERROR_CODES.includes(code) ? code : "identity/onboarding-failed";
}

function identityProviderOnboarding_sanitizeDiagnostics(input) {
  const src = input && typeof input === "object" && !Array.isArray(input) ? input : null;
  if (!src) return null;
  const keys = Array.isArray(src.providerSessionTopLevelKeys)
    ? src.providerSessionTopLevelKeys
      .map((key) => String(key || "").replace(/[^A-Za-z0-9_.-]/g, "").slice(0, 64))
      .filter(Boolean)
      .slice(0, 32)
    : [];
  return {
    providerSessionKeyExists: src.providerSessionKeyExists === true,
    providerSessionTopLevelKeys: keys,
    rawHasAccessToken: src.rawHasAccessToken === true,
    rawHasRefreshToken: src.rawHasRefreshToken === true,
    rawHasExpiresAt: src.rawHasExpiresAt === true,
    rawHasUser: src.rawHasUser === true,
    unwrapResultKind: String(src.unwrapResultKind || "").replace(/[^a-z0-9_-]/gi, "").slice(0, 64),
    normalizedHasAccessToken: src.normalizedHasAccessToken === true,
    normalizedHasRefreshToken: src.normalizedHasRefreshToken === true,
    normalizedHasExpiresAt: src.normalizedHasExpiresAt === true,
    normalizedExpired: src.normalizedExpired === true,
    rpcSessionBuilt: src.rpcSessionBuilt === true,
    callerSawAccessToken: src.callerSawAccessToken === true,
    providerStateStatus: String(src.providerStateStatus || "").replace(/[^a-z0-9_-]/gi, "").slice(0, 64),
    providerStateMode: String(src.providerStateMode || "").replace(/[^a-z0-9_-]/gi, "").slice(0, 64),
    providerStateProvider: String(src.providerStateProvider || "").replace(/[^a-z0-9_-]/gi, "").slice(0, 64),
  };
}

function identityProviderOnboarding_failure(errorCode, diagnostics = null) {
  const code = identityProviderOnboarding_normalizeErrorCode(errorCode);
  void diagnostics;
  return {
    ok: false,
    nextStatus: "auth_error",
    errorCode: code,
    errorMessage: IDENTITY_PROVIDER_ONBOARDING_ERROR_MESSAGES[code] || IDENTITY_PROVIDER_ONBOARDING_ERROR_MESSAGES["identity/onboarding-failed"],
  };
}

function identityProviderOnboarding_normalizeDisplayName(input) {
  const text = String(input || "").trim();
  return text.length >= 1 && text.length <= 64 ? text : "";
}

function identityProviderOnboarding_normalizeWorkspaceName(input) {
  const text = String(input || "").trim();
  return text.length >= 1 && text.length <= 64 ? text : "";
}

function identityProviderOnboarding_normalizeAvatarColor(input) {
  const text = String(input || "").trim().toLowerCase();
  const palette = ["violet", "blue", "cyan", "green", "amber", "pink"];
  const legacyHex = {
    "#7c3aed": "violet",
    "#2563eb": "blue",
    "#0891b2": "cyan",
    "#059669": "green",
    "#d97706": "amber",
    "#db2777": "pink",
  };
  if (palette.includes(text)) return text;
  return legacyHex[text] || "";
}

function identityProviderOnboarding_normalizeInput(input = {}) {
  const src = input && typeof input === "object" ? input : {};
  const displayName = identityProviderOnboarding_normalizeDisplayName(src.displayName);
  const avatarColor = identityProviderOnboarding_normalizeAvatarColor(src.avatarColor);
  const workspaceName = identityProviderOnboarding_normalizeWorkspaceName(src.workspaceName);
  return displayName && avatarColor && workspaceName
    ? { displayName, avatarColor, workspaceName }
    : null;
}

function identityProviderOnboarding_hasProviderSessionStatus(rt) {
  const status = String(rt && rt.status || "");
  return status === "verified_no_profile" || status === "profile_ready" || status === "sync_ready";
}

function identityProviderOnboarding_normalizeId(input) {
  const text = String(input || "").trim();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(text)
    ? text
    : "";
}

function identityProviderOnboarding_normalizeTimestamp(input) {
  const text = String(input || "").trim();
  if (!text) return null;
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function identityProviderOnboarding_sanitizeProfile(input) {
  const src = input && typeof input === "object" ? input : null;
  if (!src) return null;
  const profile = {
    id: identityProviderOnboarding_normalizeId(src.id),
    displayName: identityProviderOnboarding_normalizeDisplayName(src.displayName),
    avatarColor: identityProviderOnboarding_normalizeAvatarColor(src.avatarColor),
    onboardingCompleted: src.onboardingCompleted === true,
    createdAt: identityProviderOnboarding_normalizeTimestamp(src.createdAt),
    updatedAt: identityProviderOnboarding_normalizeTimestamp(src.updatedAt),
  };
  return profile.id && profile.displayName && profile.avatarColor && profile.onboardingCompleted && profile.createdAt && profile.updatedAt
    ? profile
    : null;
}

function identityProviderOnboarding_sanitizeWorkspace(input) {
  const src = input && typeof input === "object" ? input : null;
  if (!src) return null;
  const role = String(src.role || "").trim();
  const workspace = {
    id: identityProviderOnboarding_normalizeId(src.id),
    name: identityProviderOnboarding_normalizeWorkspaceName(src.name),
    role: role === "owner" ? "owner" : "",
    createdAt: identityProviderOnboarding_normalizeTimestamp(src.createdAt),
    updatedAt: identityProviderOnboarding_normalizeTimestamp(src.updatedAt),
  };
  return workspace.id && workspace.name && workspace.role === "owner" && workspace.createdAt && workspace.updatedAt
    ? workspace
    : null;
}

function identityProviderOnboarding_sanitizeProviderResult(result) {
  const src = result && typeof result === "object" ? result : {};
  if (src.ok !== true) {
    return {
      ok: false,
      errorCode: identityProviderOnboarding_normalizeErrorCode(src.errorCode || "identity/onboarding-failed"),
      profile: null,
      workspace: null,
    };
  }
  const profile = identityProviderOnboarding_sanitizeProfile(src.profile);
  const workspace = identityProviderOnboarding_sanitizeWorkspace(src.workspace);
  if (!profile || !workspace) {
    return { ok: false, errorCode: "identity/onboarding-response-malformed", profile: null, workspace: null };
  }
  return { ok: true, profile, workspace };
}

function identityProviderOnboarding_success(profile, workspace) {
  return {
    ok: true,
    nextStatus: "sync_ready",
    credentialState: "complete",
    credentialProvider: "password",
    profile: { ...profile },
    workspace: { ...workspace },
  };
}

function identityProviderOnboarding_runtime(rt, profile, workspace, options = {}) {
  const now = identityRuntime_nowIso();
  const credentialState = identityCredentialState_normalize(options.credentialState || rt?.credentialState);
  const credentialProvider = identityCredentialProvider_normalize(options.credentialProvider || rt?.credentialProvider);
  return {
    ...(rt || {}),
    status: "sync_ready",
    mode: "provider_backed",
    provider: "supabase",
    providerKind: "supabase",
    pendingEmail: null,
    pendingEmailMasked: null,
    credentialState,
    credentialProvider,
    emailVerified: true,
    onboardingCompleted: true,
    syncReady: true,
    profile: { ...profile },
    workspace: { ...workspace },
    lastError: null,
    updatedAt: now,
  };
}

async function identityProviderBundle_completeOnboarding(req = {}) {
  identityProviderBundle_ensureProbeLoaded();
  if (identityProviderBundleProbeState.loaded !== true
    || typeof identityProviderBundleProbeState.completeOnboardingRunner !== "function") {
    return { ok: false, errorCode: "identity/onboarding-provider-unavailable", profile: null, workspace: null };
  }
  const loadedPrivateConfig = identityProviderBundle_loadPrivateConfig();
  if (!loadedPrivateConfig.ok) {
    return { ok: false, errorCode: "identity/onboarding-provider-unavailable", profile: null, workspace: null };
  }
  try {
    return identityProviderOnboarding_sanitizeProviderResult(
      await identityProviderBundleProbeState.completeOnboardingRunner(
        loadedPrivateConfig.privateConfig,
        {
          displayName: req.displayName,
          avatarColor: req.avatarColor,
          workspaceName: req.workspaceName,
          rawSession: req.rawSession,
        }
      )
    );
  } catch (_) {
    return { ok: false, errorCode: "identity/onboarding-failed", profile: null, workspace: null };
  }
}

async function identityProviderBundle_updateIdentityProfile(req = {}) {
  identityProviderBundle_ensureProbeLoaded();
  if (identityProviderBundleProbeState.loaded !== true
    || typeof identityProviderBundleProbeState.updateIdentityProfileRunner !== "function") {
    return { ok: false, errorCode: "identity/account-update-provider-unavailable", profile: null };
  }
  const loadedPrivateConfig = identityProviderBundle_loadPrivateConfig();
  if (!loadedPrivateConfig.ok) {
    return { ok: false, errorCode: "identity/account-update-provider-unavailable", profile: null };
  }
  try {
    const providerResult = await identityProviderBundleProbeState.updateIdentityProfileRunner(
      loadedPrivateConfig.privateConfig,
      {
        rawSession: req.rawSession,
        displayName: req.displayName,
        avatarColor: req.avatarColor,
      }
    );
    const profile = identityProviderOnboarding_sanitizeProfile(providerResult && providerResult.profile);
    if (!providerResult || providerResult.ok !== true || !profile) {
      return { ok: false, errorCode: providerResult?.errorCode || "identity/account-update-failed", profile: null };
    }
    return { ok: true, profile };
  } catch (_) {
    return { ok: false, errorCode: "identity/account-update-failed", profile: null };
  }
}

async function identityProviderBundle_renameIdentityWorkspace(req = {}) {
  identityProviderBundle_ensureProbeLoaded();
  if (identityProviderBundleProbeState.loaded !== true
    || typeof identityProviderBundleProbeState.renameIdentityWorkspaceRunner !== "function") {
    return { ok: false, errorCode: "identity/account-update-provider-unavailable", workspace: null };
  }
  const loadedPrivateConfig = identityProviderBundle_loadPrivateConfig();
  if (!loadedPrivateConfig.ok) {
    return { ok: false, errorCode: "identity/account-update-provider-unavailable", workspace: null };
  }
  try {
    const providerResult = await identityProviderBundleProbeState.renameIdentityWorkspaceRunner(
      loadedPrivateConfig.privateConfig,
      {
        rawSession: req.rawSession,
        workspaceName: req.workspaceName,
      }
    );
    const workspace = identityProviderOnboarding_sanitizeWorkspace(providerResult && providerResult.workspace);
    if (!providerResult || providerResult.ok !== true || !workspace) {
      return { ok: false, errorCode: providerResult?.errorCode || "identity/account-update-failed", workspace: null };
    }
    return { ok: true, workspace };
  } catch (_) {
    return { ok: false, errorCode: "identity/account-update-failed", workspace: null };
  }
}

async function identityRuntime_get() {
  try {
    const res = await storageSessionGet([IDENTITY_MOCK_RUNTIME_KEY]);
    const rt = res[IDENTITY_MOCK_RUNTIME_KEY];
    return (rt && typeof rt === "object") ? rt : null;
  } catch { return null; }
}

async function identityRuntime_set(state) {
  try { await storageSessionSet({ [IDENTITY_MOCK_RUNTIME_KEY]: identityRuntime_enforceConsistency(state) }); } catch {}
}

function identityRuntime_enforceConsistency(rt) {
  if (!rt) return rt;
  const status = rt.status || "anonymous_local";
  const providerBackedSupabase = rt.mode === "provider_backed" && rt.provider === "supabase";
  const credentialState = identityCredentialState_normalize(rt.credentialState);
  if (providerBackedSupabase && status === "password_update_required" && credentialState !== "required") {
    return { ...rt, credentialState: "required", onboardingCompleted: false, syncReady: false, profile: null, workspace: null };
  }
  if (providerBackedSupabase
    && (status === "profile_ready" || status === "sync_ready")
    && credentialState !== "complete") {
    return {
      ...rt,
      status: "password_update_required",
      credentialState: credentialState === "unknown" ? "unknown" : "required",
      onboardingCompleted: false,
      syncReady: false,
      profile: null,
      workspace: null,
    };
  }
  // Ready states require a profile and completed onboarding.
  if ((status === "profile_ready" || status === "sync_ready") && (!rt.profile || !rt.onboardingCompleted)) {
    return { ...rt, status: "verified_no_profile", onboardingCompleted: false, syncReady: false };
  }
  if (status === "sync_ready" && !rt.workspace) {
    return { ...rt, status: "profile_ready", syncReady: false };
  }
  return rt;
}

async function identityRuntime_clear() {
  try { await storageSessionRemove([IDENTITY_MOCK_RUNTIME_KEY]); } catch {}
}

function identitySnapshot_derivedFromRuntime(rt) {
  if (!rt) {
    return {
      status: "anonymous_local", mode: "local_dev", provider: "mock_local",
      providerKind: "none", emailVerified: false, emailMasked: null,
      pendingEmailMasked: null, onboardingCompleted: false, syncReady: false,
      credentialState: "unknown", credentialProvider: "unknown", profile: null, workspace: null, lastError: null, updatedAt: identityRuntime_nowIso()
    };
  }
  const cleanRt = identityRuntime_enforceConsistency(rt) || {};
  const status = cleanRt.status || "anonymous_local";
  const derived = {
    status,
    mode: cleanRt.mode || "local_dev",
    provider: cleanRt.provider || "mock_local",
    providerKind: cleanRt.providerKind || "none",
    emailVerified: Boolean(cleanRt.emailVerified),
    emailMasked: cleanRt.emailMasked || null,
    pendingEmailMasked: cleanRt.pendingEmailMasked || null,
    userIdMasked: cleanRt.userIdMasked || null,
    sessionExpiresAt: cleanRt.sessionExpiresAt || null,
    credentialState: identityCredentialState_normalize(cleanRt.credentialState),
    credentialProvider: identityCredentialProvider_normalize(cleanRt.credentialProvider),
    onboardingCompleted: (status === "profile_ready" || status === "sync_ready") ? Boolean(cleanRt.onboardingCompleted) : false,
    syncReady: status === "sync_ready" && Boolean(cleanRt.syncReady),
    profile: cleanRt.profile ? {
      id: cleanRt.profile.id,
      displayName: cleanRt.profile.displayName || "",
      avatarColor: cleanRt.profile.avatarColor || "",
      createdAt: cleanRt.profile.createdAt || cleanRt.updatedAt,
      updatedAt: cleanRt.profile.updatedAt || cleanRt.updatedAt
    } : null,
    workspace: cleanRt.workspace ? {
      id: cleanRt.workspace.id,
      name: cleanRt.workspace.name || "",
      role: cleanRt.workspace.role || "owner",
      createdAt: cleanRt.workspace.createdAt || cleanRt.updatedAt,
      updatedAt: cleanRt.workspace.updatedAt || cleanRt.updatedAt
    } : null,
    lastError: cleanRt.lastError
      ? { code: String(cleanRt.lastError.code || ""), message: String(cleanRt.lastError.message || "") }
      : null,
    updatedAt: cleanRt.updatedAt || identityRuntime_nowIso()
  };
  return identitySnapshot_sanitize(derived);
}

function identitySnapshot_fromRuntime(rt) {
  const cleanRt = identityRuntime_enforceConsistency(rt);
  if (!cleanRt) return null;
  return {
    version: "0.1.0",
    status: cleanRt.status || "anonymous_local",
    mode: cleanRt.mode || "local_dev",
    provider: cleanRt.provider || "mock_local",
    pendingEmail: null,
    emailVerified: Boolean(cleanRt.emailVerified),
    emailMasked: cleanRt.emailMasked || null,
    pendingEmailMasked: cleanRt.pendingEmailMasked || null,
    userIdMasked: cleanRt.userIdMasked || null,
    sessionExpiresAt: cleanRt.sessionExpiresAt || null,
    credentialState: identityCredentialState_normalize(cleanRt.credentialState),
    credentialProvider: identityCredentialProvider_normalize(cleanRt.credentialProvider),
    profile: cleanRt.profile ? {
      id: cleanRt.profile.id,
      displayName: cleanRt.profile.displayName || "",
      avatarColor: cleanRt.profile.avatarColor || "",
      onboardingCompleted: Boolean(cleanRt.onboardingCompleted),
      createdAt: cleanRt.profile.createdAt || cleanRt.updatedAt,
      updatedAt: cleanRt.profile.updatedAt || cleanRt.updatedAt
    } : null,
    workspace: cleanRt.workspace ? {
      id: cleanRt.workspace.id,
      name: cleanRt.workspace.name || "",
      role: cleanRt.workspace.role || "owner",
      createdAt: cleanRt.workspace.createdAt || cleanRt.updatedAt,
      updatedAt: cleanRt.workspace.updatedAt || cleanRt.updatedAt
    } : null,
    onboardingCompleted: Boolean(cleanRt.onboardingCompleted),
    lastError: cleanRt.lastError
      ? { code: String(cleanRt.lastError.code || ""), message: String(cleanRt.lastError.message || "") }
      : null,
    updatedAt: cleanRt.updatedAt || identityRuntime_nowIso()
  };
}

function identitySnapshot_toRuntime(snap, existingRt) {
  if (!snap || typeof snap !== "object") return existingRt || null;
  const rt = existingRt || {};
  const status = snap.status || rt.status || "anonymous_local";
  const providerKind = snap.providerKind || rt.providerKind || "none";
  if (providerKind === "supabase" || snap.provider === "supabase" || rt.provider === "supabase") {
    const keepsPendingEmail = status === "email_pending"
      || status === "recovery_code_pending"
      || status === "email_confirmation_pending";
    return identityRuntime_enforceConsistency({
      status: status === "sync_ready" || status === "profile_ready" ? "verified_no_profile" : status,
      mode: "provider_backed",
      provider: "supabase",
      providerKind: "supabase",
      pendingEmail: keepsPendingEmail ? (rt.pendingEmail || null) : null,
      emailVerified: Boolean(snap.emailVerified || rt.emailVerified),
      emailMasked: rt.emailMasked || snap.emailMasked || null,
      pendingEmailMasked: keepsPendingEmail ? (snap.pendingEmailMasked || rt.pendingEmailMasked || null) : null,
      userIdMasked: rt.userIdMasked || snap.userIdMasked || null,
      sessionExpiresAt: rt.sessionExpiresAt || snap.sessionExpiresAt || null,
      credentialState: identityCredentialState_normalize(snap.credentialState || rt.credentialState),
      credentialProvider: identityCredentialProvider_normalize(snap.credentialProvider || rt.credentialProvider),
      onboardingCompleted: false,
      syncReady: false,
      profile: null,
      workspace: null,
      lastError: snap.lastError
        ? { code: String(snap.lastError.code || ""), message: String(snap.lastError.message || "") }
        : null,
      updatedAt: identityRuntime_nowIso(),
    });
  }
  return identityRuntime_enforceConsistency({
    status,
    mode: snap.mode || rt.mode || "local_dev",
    provider: snap.provider || rt.provider || "mock_local",
    providerKind,
    credentialState: identityCredentialState_normalize(snap.credentialState || rt.credentialState),
    emailVerified: Boolean(snap.emailVerified),
    emailMasked: snap.profile?.email
      ? identityRuntime_maskEmail(snap.profile.email)
      : (snap.emailMasked || rt.emailMasked || null),
    pendingEmailMasked: snap.pendingEmail
      ? identityRuntime_maskEmail(snap.pendingEmail)
      : (snap.pendingEmailMasked || rt.pendingEmailMasked || null),
    userIdMasked: snap.userIdMasked || rt.userIdMasked || null,
    sessionExpiresAt: snap.sessionExpiresAt || rt.sessionExpiresAt || null,
    onboardingCompleted: Boolean(snap.onboardingCompleted),
    credentialProvider: identityCredentialProvider_normalize(snap.credentialProvider || rt.credentialProvider),
    syncReady: status === "sync_ready",
    profile: snap.profile ? {
      id: snap.profile.id || rt.profile?.id || identityRuntime_makeMockId("mock_profile"),
      displayName: snap.profile.displayName || rt.profile?.displayName || "",
      avatarColor: snap.profile.avatarColor || rt.profile?.avatarColor || "",
      createdAt: snap.profile.createdAt || rt.profile?.createdAt || snap.updatedAt,
      updatedAt: snap.profile.updatedAt || rt.profile?.updatedAt || snap.updatedAt
    } : (rt.profile || null),
    workspace: snap.workspace ? {
      id: snap.workspace.id || rt.workspace?.id || identityRuntime_makeMockId("mock_workspace"),
      name: snap.workspace.name || rt.workspace?.name || "",
      role: snap.workspace.role || rt.workspace?.role || "owner",
      createdAt: snap.workspace.createdAt || rt.workspace?.createdAt || snap.updatedAt,
      updatedAt: snap.workspace.updatedAt || rt.workspace?.updatedAt || snap.updatedAt
    } : (rt.workspace || null),
    lastError: snap.lastError
      ? { code: String(snap.lastError.code || ""), message: String(snap.lastError.message || "") }
      : null,
    updatedAt: snap.updatedAt || identityRuntime_nowIso()
  });
}

function identitySnapshot_normalizeDisplayName(input) {
  return String(input || "").trim().slice(0, 80) || "H2O User";
}

function identitySnapshot_normalizeWorkspaceName(input) {
  return String(input || "").trim().slice(0, 80) || "H2O Workspace";
}

function identitySnapshot_normalizeAvatarColor(input) {
  const avatarColor = String(input || "").trim().toLowerCase();
  const palette = ["violet", "blue", "cyan", "green", "amber", "pink"];
  const legacyHex = {
    "#7c3aed": "violet",
    "#2563eb": "blue",
    "#0891b2": "cyan",
    "#059669": "green",
    "#d97706": "amber",
    "#db2777": "pink",
  };
  if (palette.includes(avatarColor)) return avatarColor;
  return legacyHex[avatarColor] || "violet";
}

function identitySnapshot_isReadyStatus(status) {
  return status === "profile_ready" || status === "sync_ready";
}

function identitySnapshot_hasReadyShape(snapshot) {
  if (!snapshot || typeof snapshot !== "object") return true;
  if (!identitySnapshot_isReadyStatus(snapshot.status)) return true;
  if (!snapshot.profile || !snapshot.onboardingCompleted) return false;
  if (snapshot.status === "sync_ready" && !snapshot.workspace) return false;
  return true;
}

async function identityAuthManager_getRuntime() {
  return identityRuntime_get();
}

async function identityAuthManager_setRuntime(rt) {
  await identityRuntime_set(rt);
}

async function identityAuthManager_clearRuntime() {
  await identityRuntime_clear();
}

async function identityAuthManager_getStoredSnapshot() {
  const res = await storageGet([IDENTITY_STORAGE_KEY]);
  return res[IDENTITY_STORAGE_KEY] || null;
}

async function identityAuthManager_storeSnapshot(snapshot) {
  await storageSet({ [IDENTITY_STORAGE_KEY]: snapshot });
}

async function identityAuthManager_clearStoredSnapshot() {
  await storageRemove([IDENTITY_STORAGE_KEY]);
}

async function identityAuthManager_publishSnapshotFromRuntime(rt) {
  const snap = identitySnapshot_fromRuntime(rt);
  if (snap) {
    await identityAuthManager_storeSnapshot(snap);
    broadcastIdentityPush(snap);
  }
  return snap;
}

async function identityAuthManager_getSnapshot() {
  try {
    if (typeof identityProviderSession_hydrateOnWake === "function") {
      await identityProviderSession_hydrateOnWake({ reason: "get-snapshot", broadcast: true, allowRefresh: true });
    }
  } catch {}
  let snapshot = await identityAuthManager_getStoredSnapshot();
  // If stored snapshot is null/anonymous but runtime has richer state, synthesize from runtime.
  // This covers the window between popup completion and identity:set-snapshot arriving.
  if (!snapshot || snapshot.status === "anonymous_local" || !identitySnapshot_hasReadyShape(snapshot)) {
    const rt = await identityAuthManager_getRuntime();
    if (rt && rt.status && rt.status !== "anonymous_local") {
      snapshot = identitySnapshot_fromRuntime(rt);
    }
  }
  return { ok: true, snapshot };
}

async function identityAuthManager_setSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    return { ok: false, error: "invalid snapshot payload" };
  }
  const hydrated = await identityProviderSession_hydrateOnWake({ reason: "set-snapshot", broadcast: false, allowRefresh: false });
  if (hydrated && hydrated.ok === true && hydrated.snapshot) {
    broadcastIdentityPush(hydrated.snapshot);
    return { ok: true };
  }
  if (hydrated && hydrated.errorCode === "identity/session-expired") {
    broadcastIdentityPush(null);
    return { ok: true };
  }
  // Keep runtime in sync so get-derived-state agrees with get-snapshot.
  const existingRt = await identityAuthManager_getRuntime();
  const nextRt = identitySnapshot_toRuntime(snapshot, existingRt);
  await identityAuthManager_setRuntime(nextRt);
  const compatibleSnapshot = identitySnapshot_hasReadyShape(snapshot)
    ? snapshot
    : (identitySnapshot_fromRuntime(nextRt) || snapshot);
  await identityAuthManager_storeSnapshot(compatibleSnapshot);
  broadcastIdentityPush(compatibleSnapshot);
  return { ok: true };
}

async function identityAuthManager_clearSnapshot() {
  await identityAuthManager_clearStoredSnapshot();
  return { ok: true };
}

async function identityAuthManager_getDerivedState() {
  try {
    if (typeof identityProviderSession_hydrateOnWake === "function") {
      await identityProviderSession_hydrateOnWake({ reason: "get-derived-state", broadcast: true, allowRefresh: true });
    }
  } catch {}
  const rt = await identityAuthManager_getRuntime();
  const derivedState = identitySnapshot_derivedFromRuntime(rt);
  derivedState.providerConfigStatus = await identityProviderConfig_diagAsync();
  return { ok: true, derivedState };
}

function identityMockProvider_requestEmailOtp(email) {
  const cleanEmail = String(email || "").trim().toLowerCase();
  if (!cleanEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(cleanEmail)) {
    return { ok: false, response: identityProviderOtp_failure("identity/invalid-email") };
  }
  const now = identityRuntime_nowIso();
  const pendingEmailMasked = identityRuntime_maskEmail(cleanEmail);
  return {
    ok: true,
    runtime: {
      status: "email_pending", mode: "local_dev", provider: "mock_local", providerKind: "none",
      emailVerified: false, emailMasked: null, pendingEmailMasked,
      onboardingCompleted: false, syncReady: false, profile: null, workspace: null,
      lastError: null, updatedAt: now
    },
    response: {
      ok: true,
      nextStatus: "email_pending",
      emailMasked: pendingEmailMasked,
      pendingEmailMasked,
      retryAfterSeconds: null,
      cooldownSeconds: null
    }
  };
}

function identityMockProvider_verifyEmailOtp(rt, code) {
  const cleanCode = String(code || "").trim();
  if (!cleanCode) {
    return { ok: false, response: { ok: false, errorCode: "identity/missing-code", nextStatus: "auth_error" } };
  }
  const now = identityRuntime_nowIso();
  return {
    ok: true,
    runtime: {
      ...(rt || {}),
      status: "verified_no_profile", emailVerified: true,
      emailMasked: rt?.pendingEmailMasked || rt?.emailMasked || null,
      pendingEmailMasked: null, lastError: null, updatedAt: now
    },
    response: { ok: true, nextStatus: "verified_no_profile" }
  };
}

function identityMockProvider_createProfile(rt, input = {}) {
  const now = identityRuntime_nowIso();
  const profile = {
    id: identityRuntime_makeMockId("mock_profile"),
    displayName: identitySnapshot_normalizeDisplayName(input.displayName),
    avatarColor: identitySnapshot_normalizeAvatarColor(input.avatarColor),
    createdAt: now, updatedAt: now
  };
  return {
    runtime: {
      ...(rt || {}), status: "profile_ready", onboardingCompleted: true,
      profile, lastError: null, updatedAt: now
    },
    profile
  };
}

function identityMockProvider_createWorkspace(rt, input = {}) {
  const now = identityRuntime_nowIso();
  const workspace = {
    id: identityRuntime_makeMockId("mock_workspace"),
    name: identitySnapshot_normalizeWorkspaceName(input.name || input.workspaceName),
    role: "owner", createdAt: now, updatedAt: now
  };
  return {
    runtime: {
      ...(rt || {}), status: "sync_ready", syncReady: true,
      workspace, lastError: null, updatedAt: now
    },
    workspace
  };
}

function identityMockProvider_completeOnboarding(rt, input = {}) {
  const now = identityRuntime_nowIso();
  const profile = {
    id: identityRuntime_makeMockId("mock_profile"),
    displayName: identitySnapshot_normalizeDisplayName(input.displayName),
    avatarColor: identitySnapshot_normalizeAvatarColor(input.avatarColor),
    createdAt: now, updatedAt: now
  };
  const workspace = {
    id: identityRuntime_makeMockId("mock_workspace"),
    name: identitySnapshot_normalizeWorkspaceName(input.workspaceName),
    role: "owner", createdAt: now, updatedAt: now
  };
  return {
    runtime: {
      ...(rt || {}), status: "sync_ready", syncReady: true, onboardingCompleted: true,
      profile, workspace, lastError: null, updatedAt: now
    },
    profile,
    workspace
  };
}

function identityMockProvider_attachLocalProfile(rt, input = {}) {
  const now = identityRuntime_nowIso();
  const profile = {
    id: identityRuntime_makeMockId("mock_profile"),
    displayName: identitySnapshot_normalizeDisplayName(input.displayName),
    avatarColor: "#7c3aed", createdAt: now, updatedAt: now
  };
  return {
    runtime: {
      ...(rt || {}), status: "profile_ready", onboardingCompleted: true,
      profile, lastError: null, updatedAt: now
    },
    profile
  };
}

function identityMockProvider_migrateLocalWorkspace(rt, input = {}) {
  const now = identityRuntime_nowIso();
  const workspace = {
    id: identityRuntime_makeMockId("mock_workspace"),
    name: identitySnapshot_normalizeWorkspaceName(input.name),
    role: "owner", createdAt: now, updatedAt: now
  };
  return {
    runtime: {
      ...(rt || {}), status: "sync_ready", syncReady: true,
      workspace, lastError: null, updatedAt: now
    },
    workspace
  };
}

function identityMockProvider_refreshSession(rt) {
  const now = identityRuntime_nowIso();
  return { runtime: rt ? { ...rt, updatedAt: now } : null, updatedAt: now };
}

const identityMockProviderAdapter = Object.freeze({
  requestEmailOtp: identityMockProvider_requestEmailOtp,
  verifyEmailOtp: identityMockProvider_verifyEmailOtp,
  createProfile: identityMockProvider_createProfile,
  createWorkspace: identityMockProvider_createWorkspace,
  completeOnboarding: identityMockProvider_completeOnboarding,
  attachLocalProfile: identityMockProvider_attachLocalProfile,
  migrateLocalWorkspace: identityMockProvider_migrateLocalWorkspace,
  refreshSession: identityMockProvider_refreshSession
});

function identityAuthManager_getProviderAdapter() {
  if (identityProviderConfig_isMock() || !identityProviderConfig_isSupabaseConfigured()) {
    return identityMockProviderAdapter;
  }
  return identityMockProviderAdapter;
}

async function identityAuthManager_requestEmailOtp(req = {}) {
  const cleanEmail = identityProviderOtp_normalizeEmail(req.email);
  if (!cleanEmail) return identityProviderOtp_failure("identity/invalid-email");
  const providerConfig = identityProviderConfig_get();
  const providerKind = identityProviderConfig_validateShape(providerConfig).providerKind;
  if (providerKind === "supabase") {
    if (!identityProviderConfig_isSupabaseConfigured(providerConfig)) {
      return identityProviderOtp_failure("identity/provider-not-configured");
    }
    const status = await identityProviderConfig_diagAsync();
    if (status.providerConfigured !== true) return identityProviderOtp_failure("identity/provider-not-configured");
    if (status.clientReady !== true) return identityProviderOtp_failure("identity/client-not-ready");
    if (status.permissionReady !== true) return identityProviderOtp_failure("identity/permission-not-ready");
    if (status.phaseNetworkEnabled !== true) return identityProviderOtp_failure("identity/network-not-enabled");
    if (status.networkReady !== true) return identityProviderOtp_failure("identity/network-not-ready");
    const providerResponse = await identityProviderBundle_requestEmailOtp({ email: cleanEmail });
    if (!providerResponse.ok) return providerResponse;
    const pendingRuntime = identityProviderOtp_pendingRuntime(cleanEmail);
    await identityAuthManager_setRuntime(pendingRuntime);
    await identityAuthManager_publishSnapshotFromRuntime(pendingRuntime);
    return providerResponse;
  }
  const providerAdapter = identityAuthManager_getProviderAdapter();
  const result = providerAdapter.requestEmailOtp(cleanEmail);
  if (!result.ok) return result.response || identityProviderOtp_failure(result.errorCode);
  await identityAuthManager_setRuntime(result.runtime);
  return result.response;
}

async function identityAuthManager_verifyEmailOtp(req = {}) {
  const rt = await identityAuthManager_getRuntime() || {};
  const providerConfig = identityProviderConfig_get();
  const providerKind = identityProviderConfig_validateShape(providerConfig).providerKind;
  if (providerKind === "supabase") {
    if (!identityProviderConfig_isSupabaseConfigured(providerConfig)) {
      return identityProviderVerify_failure("identity/operation-not-permitted-in-phase");
    }
    const pendingEmail = identityProviderOtp_normalizeEmail(rt.pendingEmail);
    if (rt.status !== "email_pending" || !pendingEmail) {
      return identityProviderVerify_failure("identity/operation-not-permitted-in-phase");
    }
    const callerEmailRaw = String(req.email || "").trim();
    if (callerEmailRaw) {
      const callerEmail = identityProviderOtp_normalizeEmail(callerEmailRaw);
      if (callerEmail !== pendingEmail) return identityProviderVerify_failure("identity/email-mismatch");
    }
    const cleanCode = identityProviderVerify_normalizeCode(req.code);
    if (!cleanCode) return identityProviderVerify_failure("identity/invalid-otp-code");
    if (!providerSessionStorageStrict()) return identityProviderVerify_failure("identity/operation-not-permitted-in-phase");
    const status = await identityProviderConfig_diagAsync();
    if (status.providerConfigured !== true
      || status.clientReady !== true
      || status.permissionReady !== true
      || status.phaseNetworkEnabled !== true
      || status.networkReady !== true) {
      return identityProviderVerify_failure("identity/operation-not-permitted-in-phase");
    }
    const providerVerify = await identityProviderBundle_verifyEmailOtp({ email: pendingEmail, code: cleanCode });
    if (!providerVerify.response || providerVerify.response.ok !== true) {
      return providerVerify.response || identityProviderVerify_failure("identity/provider-rejected");
    }
    const stored = await identityProviderSession_storeRaw(providerVerify.providerResult);
    if (!stored.ok) return identityProviderVerify_failure(stored.errorCode);
    const rawSession = providerVerify.providerResult && providerVerify.providerResult.rawSession;
    const persistentWrite = await identityProviderPersistentRefresh_storeFromSession(
      rawSession
    );
    void persistentWrite;
    await identityProviderPasswordUpdateRequired_remove();
    const nextRuntime = identityProviderVerify_runtime(pendingEmail, providerVerify.providerResult);
    const published = await identityProviderSession_publishSafeRuntime(nextRuntime, true, {
      rawSession,
    });
    const runtime = published && published.runtime ? published.runtime : nextRuntime;
    return identityProviderPassword_responseFromRuntime(pendingEmail, providerVerify.providerResult, runtime);
  }
  const providerAdapter = identityAuthManager_getProviderAdapter();
  const result = providerAdapter.verifyEmailOtp(rt, req.code);
  if (!result.ok) return result.response;
  await identityAuthManager_setRuntime(result.runtime);
  return result.response;
}

async function identityAuthManager_requireSupabasePasswordReady() {
  const providerConfig = identityProviderConfig_get();
  const providerKind = identityProviderConfig_validateShape(providerConfig).providerKind;
  if (providerKind !== "supabase") return identityProviderPassword_failure("identity/operation-not-permitted-in-phase");
  if (!identityProviderConfig_isSupabaseConfigured(providerConfig)) return identityProviderPassword_failure("identity/provider-not-configured");
  if (!providerSessionStorageStrict()) return identityProviderPassword_failure("identity/operation-not-permitted-in-phase");
  const status = await identityProviderConfig_diagAsync();
  if (status.providerConfigured !== true) return identityProviderPassword_failure("identity/provider-not-configured");
  if (status.clientReady !== true) return identityProviderPassword_failure("identity/client-not-ready");
  if (status.permissionReady !== true) return identityProviderPassword_failure("identity/permission-not-ready");
  if (status.phaseNetworkEnabled !== true) return identityProviderPassword_failure("identity/network-not-enabled");
  if (status.networkReady !== true) return identityProviderPassword_failure("identity/network-not-ready");
  return null;
}

async function identityAuthManager_requireSupabaseGoogleOAuthReady() {
  if (IDENTITY_PROVIDER_OAUTH_GOOGLE_ENABLED !== true) return identityProviderPassword_failure("identity/oauth-not-enabled");
  const providerConfig = identityProviderConfig_get();
  const providerKind = identityProviderConfig_validateShape(providerConfig).providerKind;
  if (providerKind !== "supabase") return identityProviderPassword_failure("identity/operation-not-permitted-in-phase");
  if (!identityProviderConfig_isSupabaseConfigured(providerConfig)) return identityProviderPassword_failure("identity/provider-not-configured");
  if (!providerSessionStorageStrict()) return identityProviderPassword_failure("identity/operation-not-permitted-in-phase");
  if (typeof chrome === "undefined"
    || !chrome.identity
    || typeof chrome.identity.getRedirectURL !== "function"
    || typeof chrome.identity.launchWebAuthFlow !== "function") {
    return identityProviderPassword_failure("identity/oauth-permission-unavailable");
  }
  const status = await identityProviderConfig_diagAsync();
  if (status.providerConfigured !== true) return identityProviderPassword_failure("identity/provider-not-configured");
  if (status.clientReady !== true) return identityProviderPassword_failure("identity/client-not-ready");
  if (status.permissionReady !== true) return identityProviderPassword_failure("identity/permission-not-ready");
  if (status.phaseNetworkEnabled !== true) return identityProviderPassword_failure("identity/network-not-enabled");
  if (status.networkReady !== true) return identityProviderPassword_failure("identity/network-not-ready");
  if (status.capabilities?.oauth !== true) return identityProviderPassword_failure("identity/oauth-not-enabled");
  return null;
}

function identityProviderPassword_responseFromRuntime(email, providerResult, runtime) {
  const base = identityProviderVerify_success(email, providerResult);
  const rt = runtime && typeof runtime === "object" ? runtime : {};
  const profile = identityProviderOnboarding_sanitizeProfile(rt.profile);
  const workspace = identityProviderOnboarding_sanitizeWorkspace(rt.workspace);
  const credentialState = identityCredentialState_normalize(rt.credentialState);
  const credentialProvider = identityCredentialProvider_normalize(rt.credentialProvider || providerResult?.credentialProvider);
  const nextStatus = rt.status === "sync_ready" && profile && workspace && credentialState === "complete"
    ? "sync_ready"
    : (rt.status === "password_update_required" ? "password_update_required" : "verified_no_profile");
  return {
    ...base,
    nextStatus,
    credentialState,
    credentialProvider,
    onboardingCompleted: nextStatus === "sync_ready",
    syncReady: nextStatus === "sync_ready",
    profile: nextStatus === "sync_ready" ? profile : null,
    workspace: nextStatus === "sync_ready" ? workspace : null,
  };
}

async function identityAuthManager_publishPasswordSession(email, providerResult, source) {
  const rawSession = providerResult && providerResult.rawSession && typeof providerResult.rawSession === "object"
    ? providerResult.rawSession
    : null;
  if (!rawSession) return identityProviderPassword_failure("identity/provider-response-malformed");
  const stored = await identityProviderSession_storeRaw({ rawSession });
  if (!stored.ok) return identityProviderPassword_failure(stored.errorCode);
  const persistentWrite = await identityProviderPersistentRefresh_storeFromSession(rawSession);
  void persistentWrite;
  const credentialMark = await identityProviderCredentialState_markCompleteForSession(rawSession, source);
  if (!credentialMark.ok) {
    return identityProviderPassword_failure(credentialMark.errorCode || "identity/credential-status-update-failed");
  }
  await identityProviderPasswordUpdateRequired_remove();
  const safeRuntime = {
    ...identityProviderVerify_runtime(email, providerResult),
    credentialState: "complete",
    credentialProvider: "password",
  };
  const published = await identityProviderSession_publishSafeRuntime(safeRuntime, true, {
    rawSession,
  });
  const runtime = published && published.runtime ? published.runtime : safeRuntime;
  return identityProviderPassword_responseFromRuntime(email, providerResult, runtime);
}

async function identityAuthManager_signUpWithPassword(req = {}) {
  const cleanEmail = identityProviderOtp_normalizeEmail(req.email);
  if (!cleanEmail) return identityProviderPassword_failure("identity/invalid-email");
  const cleanPassword = identityProviderPassword_normalize(req.password);
  if (!cleanPassword) return identityProviderPassword_failure("identity/password-invalid");
  const notReady = await identityAuthManager_requireSupabasePasswordReady();
  if (notReady) return notReady;
  const providerSignUp = await identityProviderBundle_signUpWithPassword({
    email: cleanEmail,
    password: cleanPassword,
  });
  if (providerSignUp.confirmationPending === true) {
    const pendingRuntime = identityProviderPassword_confirmationPendingRuntime(cleanEmail);
    await identityAuthManager_setRuntime(pendingRuntime);
    await identityAuthManager_publishSnapshotFromRuntime(pendingRuntime);
    return providerSignUp.response;
  }
  if (!providerSignUp.response || providerSignUp.response.ok !== true) {
    return providerSignUp.response || identityProviderPassword_failure("identity/provider-rejected");
  }
  return identityAuthManager_publishPasswordSession(cleanEmail, providerSignUp.providerResult, "password_sign_up");
}

async function identityAuthManager_verifySignupEmailCode(req = {}) {
  const rt = await identityAuthManager_getRuntime() || {};
  const pendingEmail = identityProviderOtp_normalizeEmail(rt.pendingEmail);
  if (rt.status !== "email_confirmation_pending" || !pendingEmail) {
    return identityProviderVerify_failure("identity/operation-not-permitted-in-phase");
  }
  const callerEmailRaw = String(req.email || "").trim();
  if (callerEmailRaw) {
    const callerEmail = identityProviderOtp_normalizeEmail(callerEmailRaw);
    if (callerEmail !== pendingEmail) return identityProviderVerify_failure("identity/email-mismatch");
  }
  const cleanCode = identityProviderVerify_normalizeCode(req.code);
  if (!cleanCode) return identityProviderVerify_failure("identity/invalid-otp-code");
  const notReady = await identityAuthManager_requireSupabasePasswordReady();
  if (notReady) return notReady;
  const providerConfirm = await identityProviderBundle_verifySignupEmailCode({
    email: pendingEmail,
    code: cleanCode,
  });
  if (providerConfirm.confirmationPending === true) {
    const pendingRuntime = identityProviderPassword_confirmationPendingRuntime(pendingEmail);
    await identityAuthManager_setRuntime(pendingRuntime);
    await identityAuthManager_publishSnapshotFromRuntime(pendingRuntime);
    return providerConfirm.response;
  }
  if (!providerConfirm.response || providerConfirm.response.ok !== true) {
    return providerConfirm.response || identityProviderVerify_failure("identity/provider-rejected");
  }
  return identityAuthManager_publishPasswordSession(pendingEmail, providerConfirm.providerResult, "signup_confirmation");
}

async function identityAuthManager_resendSignupConfirmation(req = {}) {
  const rt = await identityAuthManager_getRuntime() || {};
  const pendingEmail = identityProviderOtp_normalizeEmail(rt.pendingEmail || req.email);
  if (rt.status !== "email_confirmation_pending" || !pendingEmail) {
    return identityProviderPassword_failure("identity/operation-not-permitted-in-phase");
  }
  const notReady = await identityAuthManager_requireSupabasePasswordReady();
  if (notReady) return notReady;
  const response = await identityProviderBundle_resendSignupConfirmation({ email: pendingEmail });
  if (response && response.ok === true) {
    const pendingRuntime = identityProviderPassword_confirmationPendingRuntime(pendingEmail);
    await identityAuthManager_setRuntime(pendingRuntime);
    await identityAuthManager_publishSnapshotFromRuntime(pendingRuntime);
    return response;
  }
  return response || identityProviderPassword_failure("identity/provider-request-failed");
}

async function identityAuthManager_signInWithPassword(req = {}) {
  const cleanEmail = identityProviderOtp_normalizeEmail(req.email);
  if (!cleanEmail) return identityProviderPassword_failure("identity/invalid-email");
  const cleanPassword = identityProviderPassword_normalize(req.password);
  if (!cleanPassword) return identityProviderPassword_failure("identity/password-invalid");
  const notReady = await identityAuthManager_requireSupabasePasswordReady();
  if (notReady) return notReady;
  const providerSignIn = await identityProviderBundle_signInWithPassword({
    email: cleanEmail,
    password: cleanPassword,
  });
  if (!providerSignIn.response || providerSignIn.response.ok !== true) {
    return providerSignIn.response || identityProviderPassword_failure("identity/provider-rejected");
  }
  return identityAuthManager_publishPasswordSession(cleanEmail, providerSignIn.providerResult, "password_sign_in");
}

async function identityAuthManager_signInWithGoogle() {
  const notReady = await identityAuthManager_requireSupabaseGoogleOAuthReady();
  if (notReady) return notReady;
  const redirectTo = identityProviderOAuth_getRedirectUrl();
  if (!redirectTo) return identityProviderPassword_failure("identity/oauth-redirect-invalid");
  const begin = await identityProviderBundle_beginOAuthSignIn({ redirectTo });
  if (!begin || begin.ok !== true || !begin.url || !begin.flowState) {
    return identityProviderPassword_failure(begin?.errorCode || "identity/oauth-provider-unavailable");
  }
  const flowStored = await identityProviderOAuth_storeFlowState(begin.flowState);
  if (!flowStored) return identityProviderPassword_failure("identity/oauth-response-malformed");
  const launched = await identityProviderOAuth_launchWebAuthFlow(begin.url);
  if (!launched || launched.ok !== true || !launched.callbackUrl) {
    await identityProviderOAuth_removeFlowState();
    return identityProviderPassword_failure(launched?.errorCode || "identity/oauth-failed");
  }
  const flowState = await identityProviderOAuth_readFlowState();
  if (!flowState) {
    await identityProviderOAuth_removeFlowState();
    return identityProviderPassword_failure("identity/oauth-callback-invalid");
  }
  const completed = await identityProviderBundle_completeOAuthSignIn({
    callbackUrl: launched.callbackUrl,
    flowState,
  });
  await identityProviderOAuth_removeFlowState();
  if (!completed || completed.ok !== true || !completed.rawSession) {
    return identityProviderPassword_failure(completed?.errorCode || "identity/oauth-exchange-failed");
  }
  const rawSession = completed.rawSession;
  const stored = await identityProviderSession_storeRaw({ rawSession });
  if (!stored.ok) return identityProviderPassword_failure(stored.errorCode);
  const persistentWrite = await identityProviderPersistentRefresh_storeFromSession(rawSession);
  void persistentWrite;
  const credentialMark = await identityProviderCredentialState_markOAuthCompleteForSession(rawSession);
  if (!credentialMark.ok) {
    return identityProviderPassword_failure(credentialMark.errorCode || "identity/credential-status-update-failed");
  }
  await identityProviderPasswordUpdateRequired_remove();
  const email = identityProviderOtp_normalizeEmail(rawSession?.user?.email);
  const safeRuntime = {
    ...identityProviderVerify_runtime(email, completed),
    credentialState: "complete",
    credentialProvider: "google",
  };
  const published = await identityProviderSession_publishSafeRuntime(safeRuntime, true, { rawSession });
  const runtime = published && published.runtime ? published.runtime : safeRuntime;
  return identityProviderPassword_responseFromRuntime(email, completed, runtime);
}

async function identityAuthManager_requestPasswordReset(req = {}) {
  const cleanEmail = identityProviderOtp_normalizeEmail(req.email);
  if (!cleanEmail) return identityProviderPassword_failure("identity/invalid-email");
  const notReady = await identityAuthManager_requireSupabasePasswordReady();
  if (notReady) return notReady;
  return identityProviderBundle_requestPasswordReset({ email: cleanEmail });
}

async function identityAuthManager_requestPasswordRecoveryCode(req = {}) {
  const cleanEmail = identityProviderOtp_normalizeEmail(req.email);
  if (!cleanEmail) return identityProviderOtp_failure("identity/invalid-email");
  const providerConfig = identityProviderConfig_get();
  const providerKind = identityProviderConfig_validateShape(providerConfig).providerKind;
  if (providerKind !== "supabase") return identityProviderOtp_failure("identity/provider-not-configured");
  if (!identityProviderConfig_isSupabaseConfigured(providerConfig)) return identityProviderOtp_failure("identity/provider-not-configured");
  const status = await identityProviderConfig_diagAsync();
  if (status.providerConfigured !== true) return identityProviderOtp_failure("identity/provider-not-configured");
  if (status.clientReady !== true) return identityProviderOtp_failure("identity/client-not-ready");
  if (status.permissionReady !== true) return identityProviderOtp_failure("identity/permission-not-ready");
  if (status.phaseNetworkEnabled !== true) return identityProviderOtp_failure("identity/network-not-enabled");
  if (status.networkReady !== true) return identityProviderOtp_failure("identity/network-not-ready");
  const providerResponse = await identityProviderBundle_requestEmailOtp({ email: cleanEmail });
  if (!providerResponse.ok) return providerResponse;
  const pendingRuntime = identityProviderPasswordRecovery_pendingRuntime(cleanEmail);
  await identityAuthManager_setRuntime(pendingRuntime);
  await identityAuthManager_publishSnapshotFromRuntime(pendingRuntime);
  return identityProviderPasswordRecovery_pending(cleanEmail, providerResponse);
}

async function identityAuthManager_verifyPasswordRecoveryCode(req = {}) {
  const rt = await identityAuthManager_getRuntime() || {};
  const pendingEmail = identityProviderOtp_normalizeEmail(rt.pendingEmail);
  if (rt.status !== "recovery_code_pending" || !pendingEmail) {
    return identityProviderVerify_failure("identity/operation-not-permitted-in-phase");
  }
  const cleanCode = identityProviderVerify_normalizeCode(req.code);
  if (!cleanCode) return identityProviderVerify_failure("identity/invalid-otp-code");
  const notReady = await identityAuthManager_requireSupabasePasswordReady();
  if (notReady) return notReady;
  const providerVerify = await identityProviderBundle_verifyEmailOtp({ email: pendingEmail, code: cleanCode });
  if (!providerVerify.response || providerVerify.response.ok !== true) {
    return providerVerify.response || identityProviderVerify_failure("identity/provider-rejected");
  }
  const rawSession = providerVerify.providerResult && providerVerify.providerResult.rawSession;
  const stored = await identityProviderSession_storeRaw(providerVerify.providerResult);
  if (!stored.ok) return identityProviderVerify_failure(stored.errorCode);
  const persistentWrite = await identityProviderPersistentRefresh_storeFromSession(rawSession);
  void persistentWrite;
  const marker = await identityProviderPasswordUpdateRequired_store();
  if (!marker.ok) {
    return identityProviderPassword_failure(marker.errorCode || "identity/password-update-marker-unavailable");
  }
  const nextRuntime = identityProviderPasswordUpdateRequired_runtimeFromSession(rawSession);
  if (!nextRuntime) return identityProviderVerify_failure("identity/provider-response-malformed");
  await identityAuthManager_setRuntime(nextRuntime);
  await identityAuthManager_publishSnapshotFromRuntime(nextRuntime);
  return identityProviderPasswordUpdateRequired_response(providerVerify.providerResult);
}

async function identityAuthManager_updatePasswordAfterRecovery(req = {}) {
  const rt = await identityAuthManager_getRuntime() || {};
  if (rt.status !== "password_update_required") {
    return identityProviderPassword_failure("identity/operation-not-permitted-in-phase");
  }
  const cleanPassword = identityProviderPasswordUpdate_normalizeNewPassword(req.password);
  if (!cleanPassword) return identityProviderPassword_failure("identity/password-weak");
  const notReady = await identityAuthManager_requireSupabasePasswordReady();
  if (notReady) return notReady;
  let rawSession = null;
  try {
    rawSession = await identityProviderSession_readRaw();
  } catch (_) {
    rawSession = null;
  }
  if (!rawSession) return identityProviderPassword_failure("identity/password-update-session-missing");
  if (identityProviderSession_refreshIsDue(rawSession)) {
    const refreshed = await identityProviderSession_refreshRaw(rawSession, true);
    if (!refreshed || refreshed.ok !== true) {
      return identityProviderPassword_failure(refreshed?.errorCode || "identity/password-update-session-missing");
    }
    try {
      rawSession = await identityProviderSession_readRaw();
    } catch (_) {
      rawSession = null;
    }
    if (!rawSession) return identityProviderPassword_failure("identity/password-update-session-missing");
  }
  const response = await identityProviderBundle_updatePasswordAfterRecovery({
    rawSession,
    password: cleanPassword,
  });
  if (!response || response.ok !== true) {
    const failure = response || identityProviderPassword_failure("identity/password-update-failed");
    return { ...failure, nextStatus: "password_update_required" };
  }
  const credentialMark = await identityProviderCredentialState_markCompleteForSession(rawSession, "password_recovery_update");
  if (!credentialMark.ok) {
    const failure = identityProviderPassword_failure(credentialMark.errorCode || "identity/credential-status-update-failed");
    return { ...failure, nextStatus: "password_update_required" };
  }
  await identityProviderPasswordUpdateRequired_remove();
  const extractedRuntime = identityProviderSession_extractSafeRuntime(rawSession);
  if (!extractedRuntime) return identityProviderPassword_failure("identity/provider-response-malformed");
  const safeRuntime = {
    ...extractedRuntime,
    credentialState: "complete",
    credentialProvider: "password",
  };
  const published = await identityProviderSession_publishSafeRuntime(safeRuntime, true, {
    rawSession,
    honorPasswordUpdateRequired: false,
  });
  const runtime = published && published.runtime ? published.runtime : safeRuntime;
  return identityProviderPassword_responseFromRuntime(
    identityProviderOtp_normalizeEmail(rawSession?.user?.email),
    {
      userIdMasked: runtime.userIdMasked,
      sessionExpiresAt: runtime.sessionExpiresAt,
    },
    runtime
  );
}

async function identityAuthManager_readFreshProviderSessionForAccountUpdate() {
  if (identityProviderSession_restoreSuppressedDuringSignOut()) {
    return { ok: false, errorCode: "identity/account-update-session-missing", rawSession: null };
  }
  let rawSession = null;
  try {
    rawSession = await identityProviderSession_readRaw();
  } catch (_) {
    rawSession = null;
  }
  if (!rawSession) return { ok: false, errorCode: "identity/account-update-session-missing", rawSession: null };
  if (identityProviderSession_refreshIsDue(rawSession)) {
    const refreshed = await identityProviderSession_refreshRaw(rawSession, true);
    if (!refreshed || refreshed.ok !== true) {
      return { ok: false, errorCode: refreshed?.errorCode || "identity/account-update-session-missing", rawSession: null };
    }
    try {
      rawSession = await identityProviderSession_readRaw();
    } catch (_) {
      rawSession = null;
    }
    if (!rawSession) return { ok: false, errorCode: "identity/account-update-session-missing", rawSession: null };
  }
  const rpcSession = identityProviderSession_makeRpcSessionForOnboarding(rawSession);
  if (!rpcSession || identityProviderSession_isExpired(rpcSession)) {
    return { ok: false, errorCode: "identity/account-update-session-missing", rawSession: null };
  }
  return { ok: true, rawSession: rpcSession };
}

function identityAuthManager_canEditProviderAccount(rt) {
  return Boolean(rt
    && rt.mode === "provider_backed"
    && rt.provider === "supabase"
    && identityCredentialState_isComplete(rt.credentialState)
    && (rt.status === "sync_ready" || rt.status === "profile_ready" || rt.status === "verified_no_profile"));
}

async function identityAuthManager_updateProfile(req = {}) {
  const rt = await identityAuthManager_getRuntime() || {};
  if (!identityAuthManager_canEditProviderAccount(rt) || !rt.profile) {
    return identityProviderPassword_failure("identity/account-update-not-found");
  }
  const displayName = identityProviderOnboarding_normalizeDisplayName(req.displayName);
  const avatarColor = identityProviderOnboarding_normalizeAvatarColor(req.avatarColor);
  if (!displayName || !avatarColor) return identityProviderPassword_failure("identity/account-update-invalid-input");
  const notReady = await identityAuthManager_requireSupabasePasswordReady();
  if (notReady) return notReady;
  const session = await identityAuthManager_readFreshProviderSessionForAccountUpdate();
  if (!session.ok) return identityProviderPassword_failure(session.errorCode);
  const providerResult = await identityProviderBundle_updateIdentityProfile({
    rawSession: session.rawSession,
    displayName,
    avatarColor,
  });
  if (!providerResult || providerResult.ok !== true || !providerResult.profile) {
    return identityProviderPassword_failure(providerResult?.errorCode || "identity/account-update-failed");
  }
  const nextRuntime = {
    ...rt,
    profile: providerResult.profile,
    updatedAt: identityRuntime_nowIso(),
  };
  const published = await identityProviderSession_publishSafeRuntime(nextRuntime, true, { allowCloudLoad: false });
  const runtime = published && published.runtime ? published.runtime : nextRuntime;
  return {
    ok: true,
    nextStatus: runtime.status || "sync_ready",
    credentialState: identityCredentialState_normalize(runtime.credentialState),
    credentialProvider: identityCredentialProvider_normalize(runtime.credentialProvider),
    profile: identityProviderOnboarding_sanitizeProfile(runtime.profile),
    workspace: identityProviderOnboarding_sanitizeWorkspace(runtime.workspace),
    onboardingCompleted: runtime.onboardingCompleted === true,
    syncReady: runtime.syncReady === true,
  };
}

async function identityAuthManager_renameWorkspace(req = {}) {
  const rt = await identityAuthManager_getRuntime() || {};
  if (!identityAuthManager_canEditProviderAccount(rt) || !rt.workspace) {
    return identityProviderPassword_failure("identity/account-update-not-found");
  }
  const workspaceName = identityProviderOnboarding_normalizeWorkspaceName(req.workspaceName);
  if (!workspaceName) return identityProviderPassword_failure("identity/account-update-invalid-input");
  const notReady = await identityAuthManager_requireSupabasePasswordReady();
  if (notReady) return notReady;
  const session = await identityAuthManager_readFreshProviderSessionForAccountUpdate();
  if (!session.ok) return identityProviderPassword_failure(session.errorCode);
  const providerResult = await identityProviderBundle_renameIdentityWorkspace({
    rawSession: session.rawSession,
    workspaceName,
  });
  if (!providerResult || providerResult.ok !== true || !providerResult.workspace) {
    return identityProviderPassword_failure(providerResult?.errorCode || "identity/account-update-failed");
  }
  const nextRuntime = {
    ...rt,
    workspace: providerResult.workspace,
    updatedAt: identityRuntime_nowIso(),
  };
  const published = await identityProviderSession_publishSafeRuntime(nextRuntime, true, { allowCloudLoad: false });
  const runtime = published && published.runtime ? published.runtime : nextRuntime;
  return {
    ok: true,
    nextStatus: runtime.status || "sync_ready",
    credentialState: identityCredentialState_normalize(runtime.credentialState),
    credentialProvider: identityCredentialProvider_normalize(runtime.credentialProvider),
    profile: identityProviderOnboarding_sanitizeProfile(runtime.profile),
    workspace: identityProviderOnboarding_sanitizeWorkspace(runtime.workspace),
    onboardingCompleted: runtime.onboardingCompleted === true,
    syncReady: runtime.syncReady === true,
  };
}

async function identityAuthManager_changePassword(req = {}) {
  const rt = await identityAuthManager_getRuntime() || {};
  const credentialProvider = identityCredentialProvider_normalize(rt.credentialProvider);
  if (credentialProvider !== "password" && credentialProvider !== "multiple") {
    return identityProviderPassword_failure("identity/operation-not-permitted-in-phase");
  }
  const currentPassword = identityProviderPassword_normalize(req.currentPassword);
  const cleanPassword = identityProviderPasswordUpdate_normalizeNewPassword(req.password);
  if (!currentPassword || !cleanPassword) return identityProviderPassword_failure("identity/password-weak");
  const notReady = await identityAuthManager_requireSupabasePasswordReady();
  if (notReady) return notReady;
  const session = await identityAuthManager_readFreshProviderSessionForAccountUpdate();
  if (!session.ok) return identityProviderPassword_failure("identity/password-update-session-missing");
  const response = await identityProviderBundle_changePassword({
    rawSession: session.rawSession,
    currentPassword,
    password: cleanPassword,
  });
  if (!response || response.ok !== true) {
    return identityProviderPassword_failure(response?.errorCode || "identity/password-current-invalid");
  }
  const credentialMark = await identityProviderCredentialState_markCompleteForSession(session.rawSession, "password_account_change");
  if (!credentialMark.ok) {
    return identityProviderPassword_failure(credentialMark.errorCode || "identity/credential-status-update-failed");
  }
  const extractedRuntime = identityProviderSession_extractSafeRuntime(session.rawSession);
  if (!extractedRuntime) return identityProviderPassword_failure("identity/provider-response-malformed");
  const safeRuntime = {
    ...extractedRuntime,
    credentialState: "complete",
    credentialProvider,
  };
  const published = await identityProviderSession_publishSafeRuntime(safeRuntime, true, {
    rawSession: session.rawSession,
    honorPasswordUpdateRequired: false,
  });
  const runtime = published && published.runtime ? published.runtime : safeRuntime;
  return identityProviderPassword_responseFromRuntime(
    identityProviderOtp_normalizeEmail(session.rawSession?.user?.email),
    {
      userIdMasked: runtime.userIdMasked,
      sessionExpiresAt: runtime.sessionExpiresAt,
      credentialProvider,
    },
    runtime
  );
}

async function identityAuthManager_createProfile(req = {}) {
  const rt = await identityAuthManager_getRuntime() || {};
  const providerAdapter = identityAuthManager_getProviderAdapter();
  const result = providerAdapter.createProfile(rt, req);
  await identityAuthManager_setRuntime(result.runtime);
  await identityAuthManager_publishSnapshotFromRuntime(result.runtime);
  return { ok: true, nextStatus: "profile_ready", profile: { ...result.profile } };
}

async function identityAuthManager_createWorkspace(req = {}) {
  const rt = await identityAuthManager_getRuntime() || {};
  const providerAdapter = identityAuthManager_getProviderAdapter();
  const result = providerAdapter.createWorkspace(rt, req);
  await identityAuthManager_setRuntime(result.runtime);
  await identityAuthManager_publishSnapshotFromRuntime(result.runtime);
  return { ok: true, nextStatus: "sync_ready", workspace: { ...result.workspace } };
}

async function identityAuthManager_completeOnboarding(req = {}) {
  const rt = await identityAuthManager_getRuntime() || {};
  const providerConfig = identityProviderConfig_get();
  const providerKind = identityProviderConfig_validateShape(providerConfig).providerKind;
  if (providerKind === "supabase") {
    const onboardingInput = identityProviderOnboarding_normalizeInput(req);
    if (!onboardingInput) return identityProviderOnboarding_failure("identity/onboarding-invalid-input");
    if (!identityProviderConfig_isSupabaseConfigured(providerConfig)) {
      return identityProviderOnboarding_failure("identity/onboarding-provider-unavailable");
    }
    if (rt.status === "password_update_required" || await identityProviderPasswordUpdateRequired_isActive()) {
      return identityProviderOnboarding_failure("identity/onboarding-password-update-required");
    }
    if (!identityCredentialState_isComplete(rt.credentialState)) {
      return identityProviderOnboarding_failure("identity/onboarding-password-update-required");
    }
    if (!providerSessionStorageStrict()) {
      return identityProviderOnboarding_failure(
        "identity/onboarding-session-missing",
        identityProviderSession_onboardingDiagnostics(null, null, rt),
      );
    }
    const rpcSession = await identityProviderSession_readRpcSessionForOnboarding(rt);
    if (!rpcSession.ok || !rpcSession.rawSession) {
      return identityProviderOnboarding_failure(rpcSession.errorCode, rpcSession.diagnostics);
    }
    let latestRt = await identityAuthManager_getRuntime() || rt;
    if (!identityCredentialState_isComplete(latestRt.credentialState)) {
      return identityProviderOnboarding_failure("identity/onboarding-password-update-required");
    }
    if (!identityProviderOnboarding_hasProviderSessionStatus(latestRt)) {
      const safeRuntime = identityProviderSession_extractSafeRuntime(rpcSession.rawSession);
      if (safeRuntime) {
        const published = await identityProviderSession_publishSafeRuntime(safeRuntime, true, { allowCloudLoad: false });
        latestRt = published && published.runtime ? published.runtime : safeRuntime;
      }
    }
    const status = await identityProviderConfig_diagAsync();
    if (status.providerConfigured !== true
      || status.clientReady !== true
      || status.permissionReady !== true
      || status.phaseNetworkEnabled !== true
      || status.networkReady !== true) {
      return identityProviderOnboarding_failure("identity/network-not-ready");
    }
    const providerResult = await identityProviderBundle_completeOnboarding({
      ...onboardingInput,
      rawSession: rpcSession.rawSession,
    });
    if (!providerResult || providerResult.ok !== true) {
      return identityProviderOnboarding_failure(providerResult && providerResult.errorCode);
    }
    const nextRuntime = identityProviderOnboarding_runtime(latestRt, providerResult.profile, providerResult.workspace, {
      credentialState: "complete",
      credentialProvider: latestRt.credentialProvider,
    });
    await identityAuthManager_setRuntime(nextRuntime);
    await identityAuthManager_publishSnapshotFromRuntime(nextRuntime);
    return identityProviderOnboarding_success(providerResult.profile, providerResult.workspace);
  }
  const providerAdapter = identityAuthManager_getProviderAdapter();
  const result = providerAdapter.completeOnboarding(rt, req);
  await identityAuthManager_setRuntime(result.runtime);
  await identityAuthManager_publishSnapshotFromRuntime(result.runtime);
  return { ok: true, nextStatus: "sync_ready", profile: { ...result.profile }, workspace: { ...result.workspace } };
}

async function identityAuthManager_attachLocalProfile(req = {}) {
  const rt = await identityAuthManager_getRuntime() || {};
  const providerAdapter = identityAuthManager_getProviderAdapter();
  const result = providerAdapter.attachLocalProfile(rt, req);
  await identityAuthManager_setRuntime(result.runtime);
  return { ok: true, migrated: true, nextStatus: "profile_ready", profile: { ...result.profile } };
}

async function identityAuthManager_migrateLocalWorkspace(req = {}) {
  const rt = await identityAuthManager_getRuntime() || {};
  const providerAdapter = identityAuthManager_getProviderAdapter();
  const result = providerAdapter.migrateLocalWorkspace(rt, req);
  await identityAuthManager_setRuntime(result.runtime);
  return { ok: true, migrated: true, nextStatus: "sync_ready", workspace: { ...result.workspace } };
}

async function identityAuthManager_refreshSession() {
  const providerConfig = identityProviderConfig_get();
  const providerKind = identityProviderConfig_validateShape(providerConfig).providerKind;
  if (providerKind === "supabase" && identityProviderConfig_isSupabaseConfigured(providerConfig)) {
    const result = await identityProviderSession_hydrateOnWake({
      reason: "refresh-session",
      broadcast: true,
      allowRefresh: true,
    });
    if (result && result.ok === true) return identityProviderRefresh_success(result.runtime);
    return identityProviderRefresh_failure(result?.errorCode || "identity/session-refresh-failed");
  }
  const rt = await identityAuthManager_getRuntime();
  const providerAdapter = identityAuthManager_getProviderAdapter();
  const result = providerAdapter.refreshSession(rt);
  if (result.runtime) await identityAuthManager_setRuntime(result.runtime);
  return { ok: true, updatedAt: result.updatedAt };
}

async function identityProviderSignOut_tryBestEffort(rawSession) {
  try {
    if (!rawSession || !identityProviderSession_signOutUsable(rawSession)) return;
    const providerConfig = identityProviderConfig_get();
    const providerKind = identityProviderConfig_validateShape(providerConfig).providerKind;
    if (providerKind !== "supabase" || !identityProviderConfig_isSupabaseConfigured(providerConfig)) return;
    const status = await identityProviderConfig_diagAsync();
    if (status.providerConfigured !== true
      || status.clientReady !== true
      || status.permissionReady !== true
      || status.phaseNetworkEnabled !== true
      || status.networkReady !== true) {
      return;
    }
    await identityProviderBundle_signOutProviderSession({ rawSession });
  } catch (_) {
    // Provider sign-out is best-effort only; local cleanup remains authoritative.
  }
}

async function identityAuthManager_clearSignOutLocalState() {
  let ok = true;
  const diagnostics = {
    activeSessionRemoveAttempted: false,
    activeSessionRemoveOk: false,
    persistentRemoveAttempted: false,
    persistentRemoveOk: false,
    passwordUpdateMarkerRemoveAttempted: false,
    passwordUpdateMarkerRemoveOk: false,
    oauthFlowRemoveAttempted: false,
    oauthFlowRemoveOk: false,
    restoreSuppressedDuringSignOut: identityProviderSession_restoreSuppressedDuringSignOut(),
  };
  try { await identityAuthManager_clearRuntime(); } catch (_) { ok = false; }
  try { await identityAuthManager_clearStoredSnapshot(); } catch (_) { ok = false; }
  try {
    diagnostics.activeSessionRemoveAttempted = true;
    const removed = await providerSessionRemove([IDENTITY_PROVIDER_SESSION_KEY]);
    const check = providerSessionStorageStrict()
      ? await providerSessionGet([IDENTITY_PROVIDER_SESSION_KEY])
      : {};
    diagnostics.activeSessionRemoveOk = removed === true && !check[IDENTITY_PROVIDER_SESSION_KEY];
    if (!diagnostics.activeSessionRemoveOk) ok = false;
  } catch (_) {
    ok = false;
  }
  try {
    diagnostics.persistentRemoveAttempted = true;
    const removed = await providerPersistentRefreshRemove([IDENTITY_PROVIDER_PERSISTENT_REFRESH_KEY]);
    const check = providerPersistentRefreshStorageStrict()
      ? await providerPersistentRefreshGet([IDENTITY_PROVIDER_PERSISTENT_REFRESH_KEY])
      : {};
    diagnostics.persistentRemoveOk = removed === true && !check[IDENTITY_PROVIDER_PERSISTENT_REFRESH_KEY];
    if (!diagnostics.persistentRemoveOk) ok = false;
  } catch (_) {
    ok = false;
  }
  try {
    diagnostics.passwordUpdateMarkerRemoveAttempted = true;
    const removed = await providerPersistentRefreshRemove([IDENTITY_PROVIDER_PASSWORD_UPDATE_REQUIRED_KEY]);
    const check = providerPersistentRefreshStorageStrict()
      ? await providerPersistentRefreshGet([IDENTITY_PROVIDER_PASSWORD_UPDATE_REQUIRED_KEY])
      : {};
    diagnostics.passwordUpdateMarkerRemoveOk = removed === true && !check[IDENTITY_PROVIDER_PASSWORD_UPDATE_REQUIRED_KEY];
    if (!diagnostics.passwordUpdateMarkerRemoveOk) ok = false;
  } catch (_) {
    ok = false;
  }
  try {
    diagnostics.oauthFlowRemoveAttempted = true;
    await storageSessionRemove([IDENTITY_PROVIDER_OAUTH_FLOW_KEY]);
    const check = await storageSessionGet([IDENTITY_PROVIDER_OAUTH_FLOW_KEY]);
    diagnostics.oauthFlowRemoveOk = !check[IDENTITY_PROVIDER_OAUTH_FLOW_KEY];
    if (!diagnostics.oauthFlowRemoveOk) ok = false;
  } catch (_) {
    ok = false;
  }
  try { broadcastIdentityPush(null); } catch {}
  return { ok, diagnostics };
}

async function identityAuthManager_signOut() {
  const suppressionToken = identityProviderSession_suppressRestoreForSignOut();
  let rawSession = null;
  try {
    rawSession = await identityProviderSession_readRaw();
  } catch (_) {
    rawSession = null;
  }
  let localCleanupOk = false;
  try {
    await identityProviderSignOut_tryBestEffort(rawSession);
  } catch (_) {
    // Provider errors are intentionally non-public in Phase 3.1E.
  } finally {
    const cleanup = await identityAuthManager_clearSignOutLocalState();
    localCleanupOk = cleanup && cleanup.ok === true;
    identityProviderSession_keepRestoreSuppressedAfterSignOut(suppressionToken);
  }
  if (!localCleanupOk) {
    return {
      ok: false,
      nextStatus: "auth_error",
      errorCode: "identity/sign-out-failed",
      errorMessage: "Sign out failed.",
    };
  }
  return { ok: true, nextStatus: "anonymous_local" };
}

// Compatibility aliases for older Phase 2.9 validators and built-output probes.
function asm_nowIso() { return identityRuntime_nowIso(); }
function asm_makeMockId(prefix) { return identityRuntime_makeMockId(prefix); }
function asm_maskEmail(email) { return identityRuntime_maskEmail(email); }
function asm_sanitize(obj) { return identitySnapshot_sanitize(obj); }
async function asm_getRuntime() { return identityRuntime_get(); }
async function asm_setRuntime(state) { return identityRuntime_set(state); }
function asm_enforceRuntimeConsistency(rt) { return identityRuntime_enforceConsistency(rt); }
async function asm_clearRuntime() { return identityRuntime_clear(); }
function asm_derivedFromRuntime(rt) { return identitySnapshot_derivedFromRuntime(rt); }
function asm_runtimeToSnapshot(rt) { return identitySnapshot_fromRuntime(rt); }
function asm_snapshotToRuntime(snap, existingRt) { return identitySnapshot_toRuntime(snap, existingRt); }

/*
 * W-2b sender authorization.
 *
 * The repository observation is the one message op in this router that must
 * know who is asking. chrome.runtime.onMessage fires for content scripts and
 * extension pages alike, and the content script forwards page-world archive
 * requests, so "an extension message arrived" is not evidence of a trusted
 * caller. Only the extension's own Studio document may ask.
 *
 * Checked positively, not by exclusion: the sender must be this extension, the
 * URL must parse, its scheme must be chrome-extension:, its host must be this
 * extension id, and its pathname must be exactly the Studio document. Query and
 * hash are ignored because Studio routes through the hash. A content script on
 * https://chatgpt.com fails at the scheme, a foreign extension at the id, and
 * any other extension-owned page at the pathname.
 *
 * A Studio document opened in an ordinary browser tab legitimately carries
 * sender.tab. Tab presence is therefore neither authority nor a reason to
 * reject: the exact own-extension document identity above is the authority.
 * The reverse worker -> Studio startup announcement keeps its separate exact
 * bg.js/no-tab predicate in the Studio panel.
 */
function isTrustedP02StudioSender(sender) {
  if (!sender || sender.id !== chrome.runtime.id) return false;
  const raw = typeof sender.url === "string" ? sender.url : "";
  if (!raw) return false;
  let parsed;
  try { parsed = new URL(raw); } catch { return false; }
  return parsed.protocol === "chrome-extension:"
    && parsed.hostname === chrome.runtime.id
    && parsed.pathname === P02_OBSERVE_STUDIO_PATHNAME;
}

const P02_W2C_RUNTIME_STATUSES = new Set([
  "gate-inactive", "gate-fail-closed", "authority-non-mutating",
  "dual-writer-excluded", "idle", "progressed",
]);
const P02_W2C_ERRORS = new Set([
  "p02-w2c-request-invalid", "p02-w2c-sender-forbidden",
  "p02-w2c-build-mismatch", "p02-w2c-busy",
  "p02-w2c-runtime-unavailable", "p02-w2c-runtime-status-invalid",
  "p02-w2c-drain-bound-exhausted", "p02-w2c-receive-admission-failed",
  "p02-w2c-peer-roster-config-invalid", "p02-w2c-peer-roster-row-invalid",
  "p02-w2c-peer-roster-self-target", "p02-w2c-peer-roster-duplicate",
  "p02-w2c-peer-roster-ambiguous", "p02-w2c-peer-roster-writer-key-mismatch",
  "p02-fsa-read-permission-blocked", "reauthorization-required",
]);
const P01_WRITER_STANDDOWN_OUTCOMES = new Set([
  "stood-down", "already-stood-down", "p01-not-quiescent",
  "configured-peer-authority-invalid", "generation-state-invalid", "busy",
  "sender-forbidden", "build-mismatch", "serialization-unavailable",
  "persistence-failed", "readback-mismatch", "request-invalid",
  "runtime-unavailable",
]);
function p01WriterStanddownFixedResult(outcome, source = null) {
  const safeOutcome = P01_WRITER_STANDDOWN_OUTCOMES.has(outcome)
    ? outcome : "persistence-failed";
  const success = safeOutcome === "stood-down" ||
    safeOutcome === "already-stood-down";
  const result = {
    schema: P01_WRITER_STANDDOWN_RESULT_SCHEMA,
    ok: success,
    outcome: safeOutcome,
    storageWrites: Number(source && source.storageWrites) === 1 ? 1 : 0,
    verified: success && source && source.verified === true,
  };
  if (success && source && source.generation === "p02" &&
      source.p01MayMutate === false) {
    result.generation = "p02";
    result.p01MayMutate = false;
  }
  return result;
}
function p02W2cOutcomeCounts(dispatched) {
  const counts = {
    progress: 0, noEffect: 0, blocked: 0,
    indeterminate: 0, integrity: 0, transient: 0,
  };
  for (const row of Array.isArray(dispatched) ? dispatched : []) {
    if (row && row.outcome === "progress") counts.progress += 1;
    else if (row && row.outcome === "no-effect") counts.noEffect += 1;
    else if (row && row.outcome === "blocked") counts.blocked += 1;
    else if (row && row.outcome === "indeterminate") counts.indeterminate += 1;
    else if (row && row.outcome === "integrity") counts.integrity += 1;
    else if (row && row.outcome === "transient") counts.transient += 1;
  }
  return counts;
}
function p02W2cFixedResult(report, error = null, runPasses = report ? 1 : 0) {
  const dispatched = Array.isArray(report && report.dispatched)
    ? report.dispatched : [];
  const runtimeStatus = P02_W2C_RUNTIME_STATUSES.has(report && report.status)
    ? report.status : "gate-fail-closed";
  const result = {
    ok: error === null,
    schema: P02_W2C_RESULT_SCHEMA,
    verdict: "receive-admission-pass",
    runPasses,
    runtimeStatus,
    exhausted: report && report.exhausted === true,
    dispatchedCount: dispatched.length,
    outcomes: p02W2cOutcomeCounts(dispatched),
    applyEnabled: false,
    publicationReachable: false,
    repositoryByteWrites: 0,
    webdavMutations: 0,
  };
  if (error !== null) result.error = P02_W2C_ERRORS.has(error)
    ? error : "p02-w2c-receive-admission-failed";
  return result;
}

const P02_W3_OUTCOMES = new Set([
  "applied", "already-applied", "pending-recovered", "no-eligible-apply",
  "multiple-eligible-apply", "pending-conflict", "anchor-mismatch",
  "trusted-peer-authority-invalid", "branch-evidence-invalid",
  "revision-integrity-failed", "archive-import-failed", "readback-mismatch",
  "pending-unresolved", "busy", "sender-forbidden", "build-mismatch",
  "request-invalid", "runtime-unavailable", "apply-failed",
  "p01-active", "authority-invalid",
]);
function p02W3PublicOutcome(source, fallback = "apply-failed") {
  const verdict = String(source && source.verdict || "");
  if (P02_W3_OUTCOMES.has(verdict)) return verdict;
  const reason = String(source && source.reason || "");
  if (reason.includes("pending-unresolved")) return "pending-unresolved";
  if (reason.includes("pending")) return "pending-conflict";
  if (reason.includes("anchor") || reason.includes("precondition")) return "anchor-mismatch";
  if (reason.includes("peer-authority") || reason.includes("peer-roster")) {
    return "trusted-peer-authority-invalid";
  }
  if (reason.includes("branch-evidence") || reason.includes("candidate-ineligible")) {
    return "branch-evidence-invalid";
  }
  if (reason.includes("blob") || reason.includes("integrity") || reason.includes("bytes")) {
    return "revision-integrity-failed";
  }
  if (reason.includes("archive-import") || reason.includes("canonical-import")) {
    return "archive-import-failed";
  }
  if (reason.includes("readback")) return "readback-mismatch";
  return P02_W3_OUTCOMES.has(fallback) ? fallback : "apply-failed";
}
function p02W3FixedResult(report = null, fixedOutcome = null, runPasses = report ? 1 : 0) {
  const source = report && report.manualApplyResult;
  const runtimeRefusal = report && report.status === "dual-writer-excluded"
    ? "p01-active"
    : report && ["gate-inactive", "gate-fail-closed", "authority-non-mutating"].includes(report.status)
      ? "authority-invalid"
      : null;
  const outcome = fixedOutcome || runtimeRefusal || p02W3PublicOutcome(
    source, report && report.status === "idle" ? "no-eligible-apply" : "apply-failed");
  const success = outcome === "applied" || outcome === "already-applied" ||
    outcome === "pending-recovered";
  return {
    ok: success,
    schema: P02_W3_RESULT_SCHEMA,
    outcome,
    runPasses,
    runtimeStatus: P02_W2C_RUNTIME_STATUSES.has(report && report.status)
      ? report.status : "gate-fail-closed",
    applied: source && source.applied === true,
    canonicalMutated: source && source.canonicalMutated === true,
    publicationReachable: false,
    repositoryByteWrites: 0,
    webdavMutations: 0,
  };
}

/* W-2b cold-start ownership. The observer route is registered here, near the
 * top of the worker, but the Sync runtime is composed much further down. A
 * message that arrives while the worker is still starting must therefore never
 * read that binding directly: the route waits on this promise instead, and the
 * composition settles it exactly once on every path - with the runtime, or with
 * null when there is none. One click still yields one eventual response; no
 * retry, no queue, no scheduler. */
let __h2oBackgroundSyncRuntimeReadySettle = null;
let __h2oW2cReceiveAdmissionInFlight = false;
let __h2oW3ManualApplyInFlight = false;
let __h2oP02PublicationInFlight = false;
let __h2oManualP02StageInFlight = null;
let __h2oP01WriterStanddownInFlight = false;
let __h2oW2cManualStageCapability = null;
const __h2oBackgroundSyncRuntimeReady = new Promise((resolve) => {
  __h2oBackgroundSyncRuntimeReadySettle = resolve;
});
function whenBackgroundSyncRuntimeReady() {
  return __h2oBackgroundSyncRuntimeReady;
}

/* One syntactic runPass site for both trusted manual stages. The capability is
 * already installed by the owning route and is removed in that route's
 * finally. maxSteps=1 binds one Human activation to one object attempt. */
function runTrustedManualP02Stage(runtime, stage) {
  return runtime.p02.runPass(stage === "manual-apply"
    ? { maxSteps: 1, singlePass: true }
    : { singlePass: true });
}

/* Bounded first result. Reports only what the operator needs to see: which row
 * matched, the exact state transition, the exact identity, and explicit zeros
 * for publication, repository mutation and deletion. */
function p02ForeignIntentFixedResult(result, errorCode) {
  if (!result) {
    return {
      schema: "h2o.studio.syncP02ForeignIntentRetirementResult.v1",
      ok: false,
      matched: false,
      errorCode: errorCode || "foreign-intent-retirement-failed",
      repositoryMutated: false,
      published: false,
      rowsDeleted: 0
    };
  }
  return {
    schema: "h2o.studio.syncP02ForeignIntentRetirementResult.v1",
    ok: result.ok === true,
    matched: result.matched === true,
    objectId: result.objectId,
    objectKey: result.objectKey,
    revisionId: result.revisionId,
    priorState: result.priorState,
    retiredState: result.retiredState,
    stagedAt: result.stagedAt,
    retiredAt: result.retiredAt,
    stagedBytes: result.stagedBytes,
    evidenceRetained: result.evidenceRetained === true,
    repositoryMutated: false,
    published: false,
    rowsDeleted: 0,
    errorCode: null
  };
}

function p02PublishFixedResult(source = null, outcome = null) {
  const selected = String(outcome || source?.outcome || "publication-failed");
  const ok = selected === "published" || selected === "recovered" ||
    selected === "no-eligible-local-change";
  return {
    ok,
    schema: P02_PUBLISH_RESULT_SCHEMA,
    outcome: selected,
    published: selected === "published",
    recovered: selected === "recovered",
    repositoryMutated: source?.repositoryMutated === true,
    eligibleCount: Number.isSafeInteger(source?.eligibleCount)
      ? source.eligibleCount : 0,
    revisionId: typeof source?.mintedRevisionId === "string"
      ? source.mintedRevisionId : null,
    publicationOwner: "chrome-p02-publication-owner",
    webdavReachable: false,
  };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== "string") return;

  /*
   * W-2b: observe the governed P02 repository, read-only. One operation, no
   * parameters - nothing in the message beyond its type selects behaviour, so
   * there is no dispatch surface to widen. The accessor it calls is the
   * verified zero-store-touch one; a fail-closed observation (handle-absent,
   * permission-absent, malformed format, a generation or legacy block) is a
   * SUCCESSFUL observation carrying its own typed state, and is returned as
   * such rather than flattened into an error.
   */
  if (msg.type === MSG_P02_OBSERVE) {
    /* The port is claimed by the synchronous return true below, so from here on
     * every outcome owes the caller exactly one answer. respondOnce is what
     * makes that true even if a later throw would otherwise leave the port
     * claimed and silent, which is how the first live invocation failed. A
     * sendResponse that throws means the caller is already gone; there is
     * nobody left to tell. */
    let p02ObserveAnswered = false;
    const respondOnceToP02Observe = (value) => {
      if (p02ObserveAnswered) return;
      p02ObserveAnswered = true;
      try { sendResponse(value); } catch (_) { /* caller gone */ }
    };
    (async () => {
      try {
        if (!isTrustedP02StudioSender(sender)) {
          respondOnceToP02Observe({ ok: false, error: "p02-observe-sender-forbidden" });
          return;
        }
        const runtime = await whenBackgroundSyncRuntimeReady();
        if (!runtime || !runtime.p02 ||
            typeof runtime.p02.observeRepository !== "function") {
          respondOnceToP02Observe({ ok: false, error: "p02-observe-runtime-unavailable" });
          return;
        }
        respondOnceToP02Observe({
          ok: true, observation: await runtime.p02.observeRepository() });
      } catch (_) {
        /* Stable code only: a rejection must not describe the repository. */
        respondOnceToP02Observe({ ok: false, error: "p02-observe-failed" });
      }
    })();
    return true;
  }

  if (msg.type === MSG_P02_RECEIVE_ADMIT) {
    let p02W2cAnswered = false;
    const respondOnceToP02W2c = (value) => {
      if (p02W2cAnswered) return;
      p02W2cAnswered = true;
      try { sendResponse(value); } catch (_) { /* caller gone */ }
    };
    (async () => {
      let capability = null;
      let ownsInFlight = false;
      let runPassStarted = false;
      try {
        if (Object.keys(msg).sort().join(",") !== "build,type") {
          respondOnceToP02W2c(p02W2cFixedResult(null, "p02-w2c-request-invalid"));
          return;
        }
        if (!isTrustedP02StudioSender(sender)) {
          respondOnceToP02W2c(p02W2cFixedResult(null, "p02-w2c-sender-forbidden"));
          return;
        }
        if (msg.build !== H2O_BUILD_STAMP) {
          respondOnceToP02W2c(p02W2cFixedResult(null, "p02-w2c-build-mismatch"));
          return;
        }
        if (__h2oManualP02StageInFlight !== null ||
            __h2oP02PublicationInFlight ||
            __h2oW2cReceiveAdmissionInFlight) {
          respondOnceToP02W2c(p02W2cFixedResult(null, "p02-w2c-busy"));
          return;
        }
        __h2oW2cReceiveAdmissionInFlight = true;
        __h2oManualP02StageInFlight = "receive-admit";
        ownsInFlight = true;
        const runtime = await whenBackgroundSyncRuntimeReady();
        if (!runtime || !runtime.p02 || typeof runtime.p02.runPass !== "function") {
          respondOnceToP02W2c(p02W2cFixedResult(null, "p02-w2c-runtime-unavailable"));
          return;
        }
        capability = Object.freeze({
          schema: "h2o.studio.syncW2cManualReceiveCapability.v1",
          stage: "receive-admission",
        });
        __h2oW2cManualStageCapability = capability;
        runPassStarted = true;
        const report = await runTrustedManualP02Stage(runtime, "receive-admission");
        if (!P02_W2C_RUNTIME_STATUSES.has(report && report.status)) {
          respondOnceToP02W2c(p02W2cFixedResult(report, "p02-w2c-runtime-status-invalid"));
          return;
        }
        if (report && report.exhausted === true) {
          respondOnceToP02W2c(p02W2cFixedResult(report, "p02-w2c-drain-bound-exhausted"));
          return;
        }
        respondOnceToP02W2c(p02W2cFixedResult(report));
      } catch (error) {
        const typedError = P02_W2C_ERRORS.has(error && error.code)
          ? error.code : "p02-w2c-receive-admission-failed";
        respondOnceToP02W2c(p02W2cFixedResult(
          null, typedError, runPassStarted ? 1 : 0));
      } finally {
        if (ownsInFlight && __h2oW2cManualStageCapability === capability) {
          __h2oW2cManualStageCapability = null;
        }
        if (ownsInFlight) {
          __h2oW2cReceiveAdmissionInFlight = false;
          if (__h2oManualP02StageInFlight === "receive-admit") {
            __h2oManualP02StageInFlight = null;
          }
        }
      }
    })();
    return true;
  }

  if (msg.type === MSG_P02_APPLY) {
    let answered = false;
    const respondOnce = (value) => {
      if (answered) return;
      answered = true;
      try { sendResponse(value); } catch (_) { /* caller gone */ }
    };
    (async () => {
      let capability = null;
      let ownsInFlight = false;
      let runPassStarted = false;
      try {
        if (Object.keys(msg).sort().join(",") !== "build,type") {
          respondOnce(p02W3FixedResult(null, "request-invalid"));
          return;
        }
        if (!isTrustedP02StudioSender(sender)) {
          respondOnce(p02W3FixedResult(null, "sender-forbidden"));
          return;
        }
        if (msg.build !== H2O_BUILD_STAMP) {
          respondOnce(p02W3FixedResult(null, "build-mismatch"));
          return;
        }
        if (__h2oManualP02StageInFlight !== null ||
            __h2oP02PublicationInFlight || __h2oW3ManualApplyInFlight) {
          respondOnce(p02W3FixedResult(null, "busy"));
          return;
        }
        __h2oW3ManualApplyInFlight = true;
        __h2oManualP02StageInFlight = "manual-apply";
        ownsInFlight = true;
        const runtime = await whenBackgroundSyncRuntimeReady();
        if (!runtime || !runtime.p02 || typeof runtime.p02.runPass !== "function") {
          respondOnce(p02W3FixedResult(null, "runtime-unavailable"));
          return;
        }
        capability = Object.freeze({
          schema: "h2o.studio.syncW3ManualApplyCapability.v1",
          stage: "manual-apply",
        });
        __h2oW2cManualStageCapability = capability;
        runPassStarted = true;
        const report = await runTrustedManualP02Stage(runtime, "manual-apply");
        respondOnce(p02W3FixedResult(report));
      } catch (error) {
        respondOnce(p02W3FixedResult(
          null,
          p02W3PublicOutcome({ reason: String(error && (error.code || error.message) || "") }),
          runPassStarted ? 1 : 0));
      } finally {
        if (ownsInFlight && __h2oW2cManualStageCapability === capability) {
          __h2oW2cManualStageCapability = null;
        }
        if (ownsInFlight) {
          __h2oW3ManualApplyInFlight = false;
          if (__h2oManualP02StageInFlight === "manual-apply") {
            __h2oManualP02StageInFlight = null;
          }
        }
      }
    })();
    return true;
  }

  if (msg.type === MSG_P02_PUBLISH_LOCAL) {
    let answered = false;
    const respondOnce = (value) => {
      if (answered) return;
      answered = true;
      try { sendResponse(value); } catch (_) { /* caller gone */ }
    };
    (async () => {
      let ownsInFlight = false;
      try {
        if (Object.keys(msg).sort().join(",") !== "build,type") {
          respondOnce(p02PublishFixedResult(null, "request-invalid"));
          return;
        }
        if (!isTrustedP02StudioSender(sender)) {
          respondOnce(p02PublishFixedResult(null, "sender-forbidden"));
          return;
        }
        if (msg.build !== H2O_BUILD_STAMP) {
          respondOnce(p02PublishFixedResult(null, "build-mismatch"));
          return;
        }
        if (__h2oP02PublicationInFlight ||
            __h2oManualP02StageInFlight !== null ||
            __h2oW2cReceiveAdmissionInFlight ||
            __h2oW3ManualApplyInFlight ||
            __h2oP01WriterStanddownInFlight) {
          respondOnce(p02PublishFixedResult(null, "busy"));
          return;
        }
        __h2oP02PublicationInFlight = true;
        ownsInFlight = true;
        const runtime = await whenBackgroundSyncRuntimeReady();
        if (!runtime || typeof runtime.publishLocalP02Revision !== "function") {
          respondOnce(p02PublishFixedResult(null, "runtime-unavailable"));
          return;
        }
        respondOnce(p02PublishFixedResult(
          await runtime.publishLocalP02Revision()));
      } catch (error) {
        respondOnce(p02PublishFixedResult(null,
          String(error && (error.code || error.message) || "publication-failed")));
      } finally {
        if (ownsInFlight) __h2oP02PublicationInFlight = false;
      }
    })();
    return true;
  }

  /*
   * Governed retirement of ONE foreign-lane publication intent.
   *
   * Same sender, build and busy guards as the P02 publication operation, and the
   * same exact-request discipline: the message must carry precisely the three
   * binding values plus build and type, and they are passed straight through to
   * the ledger owner, which checks each one against the stored row. There is no
   * object discovery, no wildcard, and nothing here can delete a row.
   */
  if (msg.type === MSG_P02_RETIRE_FOREIGN_INTENT) {
    let answered = false;
    const respondOnce = (value) => {
      if (answered) return;
      answered = true;
      try { sendResponse(value); } catch (_) { /* caller gone */ }
    };
    (async () => {
      let ownsInFlight = false;
      try {
        if (Object.keys(msg).sort().join(",") !==
            "build,expectedStagedAt,objectKey,revisionId,type") {
          respondOnce(p02ForeignIntentFixedResult(null, "request-invalid"));
          return;
        }
        if (!isTrustedP02StudioSender(sender)) {
          respondOnce(p02ForeignIntentFixedResult(null, "sender-forbidden"));
          return;
        }
        if (msg.build !== H2O_BUILD_STAMP) {
          respondOnce(p02ForeignIntentFixedResult(null, "build-mismatch"));
          return;
        }
        if (typeof msg.objectKey !== "string" ||
            !/^[0-9a-f]{64}$/.test(msg.objectKey) ||
            typeof msg.revisionId !== "string" || msg.revisionId.trim() === "" ||
            typeof msg.expectedStagedAt !== "string" ||
            msg.expectedStagedAt.trim() === "") {
          respondOnce(p02ForeignIntentFixedResult(null, "request-invalid"));
          return;
        }
        if (__h2oP02PublicationInFlight ||
            __h2oManualP02StageInFlight !== null ||
            __h2oW2cReceiveAdmissionInFlight ||
            __h2oW3ManualApplyInFlight ||
            __h2oP01WriterStanddownInFlight) {
          respondOnce(p02ForeignIntentFixedResult(null, "busy"));
          return;
        }
        __h2oP02PublicationInFlight = true;
        ownsInFlight = true;
        const runtime = await whenBackgroundSyncRuntimeReady();
        if (!runtime ||
            typeof runtime.retireLocalPublicationForeignIntent !== "function") {
          respondOnce(p02ForeignIntentFixedResult(null, "runtime-unavailable"));
          return;
        }
        respondOnce(p02ForeignIntentFixedResult(
          await runtime.retireLocalPublicationForeignIntent(
            msg.objectKey,
            msg.revisionId,
            msg.expectedStagedAt
          )));
      } catch (error) {
        respondOnce(p02ForeignIntentFixedResult(null,
          String(error && (error.code || error.message) ||
            "foreign-intent-retirement-failed")));
      } finally {
        if (ownsInFlight) __h2oP02PublicationInFlight = false;
      }
    })();
    return true;
  }

  if (msg.type === MSG_P01_WRITER_STANDDOWN) {
    let answered = false;
    const respondOnce = (value) => {
      if (answered) return;
      answered = true;
      try { sendResponse(value); } catch (_) { /* caller gone */ }
    };
    (async () => {
      let ownsInFlight = false;
      try {
        if (Object.keys(msg).sort().join(",") !== "build,type") {
          respondOnce(p01WriterStanddownFixedResult("request-invalid"));
          return;
        }
        if (!isTrustedP02StudioSender(sender)) {
          respondOnce(p01WriterStanddownFixedResult("sender-forbidden"));
          return;
        }
        if (msg.build !== H2O_BUILD_STAMP) {
          respondOnce(p01WriterStanddownFixedResult("build-mismatch"));
          return;
        }
        if (__h2oP01WriterStanddownInFlight ||
            __h2oP02PublicationInFlight ||
            __h2oManualP02StageInFlight !== null ||
            __h2oW2cReceiveAdmissionInFlight ||
            __h2oW3ManualApplyInFlight) {
          respondOnce(p01WriterStanddownFixedResult("busy"));
          return;
        }
        __h2oP01WriterStanddownInFlight = true;
        ownsInFlight = true;
        const runtime = await whenBackgroundSyncRuntimeReady();
        if (!runtime || typeof runtime.standDownP01Writer !== "function") {
          respondOnce(p01WriterStanddownFixedResult("runtime-unavailable"));
          return;
        }
        const result = await runtime.standDownP01Writer();
        respondOnce(p01WriterStanddownFixedResult(result && result.outcome, result));
      } catch (_) {
        respondOnce(p01WriterStanddownFixedResult("persistence-failed"));
      } finally {
        if (ownsInFlight) __h2oP01WriterStanddownInFlight = false;
      }
    })();
    return true;
  }

  if (msg.type === MSG_PAGE_DISABLE_ONCE) {
    (async () => {
      try {
        const op = String(msg.op || "").trim().toLowerCase();
        if (op === "arm") {
          sendResponse(await armPageDisableOnce(msg.tabId));
          return;
        }
        if (op === "clear") {
          const tabId = normalizeTabId(msg.tabId) || normalizeTabId(sender && sender.tab && sender.tab.id);
          await clearPageDisableOnce(tabId);
          sendResponse({ ok: true, tabId });
          return;
        }
        if (op === "consume") {
          const tabId = normalizeTabId(sender && sender.tab && sender.tab.id) || normalizeTabId(msg.tabId);
          const armed = await consumePageDisableOnce(tabId);
          sendResponse({ ok: true, tabId, armed });
          return;
        }
        sendResponse({ ok: false, error: "unsupported page-disable op" });
      } catch (e) {
        sendResponse({ ok: false, error: String(e && (e.stack || e.message || e)) });
      }
    })();
    return true;
  }

  if (msg.type === MSG_PAGE_SET_LINK) {
    (async () => {
      try {
        const op = String(msg.op || "").trim().toLowerCase();
        const tabId = normalizeTabId(msg.tabId) || normalizeTabId(sender && sender.tab && sender.tab.id);
        const url = String(msg.url || (sender && sender.tab && sender.tab.url) || "");
        if (op === "resolve" || op === "resolve-consume") {
          sendResponse(await resolveSetState({ tabId, url, consumePreview: op === "resolve-consume" }));
          return;
        }
        if (op === "get-chat-binding") {
          const slot = await getChatBindingByUrl(url);
          sendResponse({ ok: true, tabId, url, urlKey: normalizeChatUrlKey(url), slot });
          return;
        }
        if (op === "set-chat-binding") {
          sendResponse({ ok: true, tabId, ...(await setChatBindingByUrl(url, msg.slot)) });
          return;
        }
        if (op === "clear-chat-binding") {
          sendResponse({ ok: true, tabId, ...(await clearChatBindingByUrl(url)) });
          return;
        }
        if (op === "get-chat-bypass") {
          const enabled = await getChatBypassByUrl(url);
          sendResponse({ ok: true, tabId, url, urlKey: normalizeChatUrlKey(url), enabled });
          return;
        }
        if (op === "set-chat-bypass") {
          sendResponse({ ok: true, tabId, ...(await setChatBypassByUrl(url)) });
          return;
        }
        if (op === "clear-chat-bypass") {
          sendResponse({ ok: true, tabId, ...(await clearChatBypassByUrl(url)) });
          return;
        }
        if (op === "get-global-default") {
          const slot = await getGlobalDefaultSet();
          sendResponse({ ok: true, slot });
          return;
        }
        if (op === "set-global-default") {
          sendResponse(await setGlobalDefaultSet(msg.slot));
          return;
        }
        if (op === "clear-global-default") {
          sendResponse(await clearGlobalDefaultSet());
          return;
        }
        if (op === "arm-preview-once") {
          sendResponse(await armPreviewSetOnce(tabId, msg.slot));
          return;
        }
        if (op === "clear-preview-once") {
          await clearPreviewSetOnce(tabId);
          sendResponse({ ok: true, tabId, slot: 0 });
          return;
        }
        if (op === "clear-slot-references") {
          sendResponse(await clearSlotReferences(msg.slot, { tabId, url }));
          return;
        }
        if (op === "get") {
          const resolved = await resolveSetState({ tabId, url, consumePreview: false });
          sendResponse({ ok: true, tabId, slot: resolved.slot, source: resolved.source, url, urlKey: resolved.urlKey });
          return;
        }
        if (op === "set") {
          sendResponse(await setPageSetLink(tabId, msg.slot, url));
          return;
        }
        if (op === "clear") {
          sendResponse(await clearPageSetLink(tabId, url));
          return;
        }
        sendResponse({ ok: false, error: "unsupported page-set op" });
      } catch (e) {
        sendResponse({ ok: false, error: String(e && (e.stack || e.message || e)) });
      }
    })();
    return true;
  }

  if (msg.type === MSG_FETCH_TEXT && typeof msg.url === "string") {
    (async () => {
      const r = await httpRequest({
        method: "GET",
        url: String(msg.url),
        timeoutMs: 15000,
      });
      if (!r.ok) {
        sendResponse({
          ok: false,
          status: Number(r.status || 0),
          error: String(r.error || "request failed"),
          url: String(msg.url),
        });
        return;
      }
      sendResponse({
        ok: Number(r.status || 0) >= 200 && Number(r.status || 0) < 300,
        status: Number(r.status || 0),
        text: String(r.responseText || ""),
        url: String(msg.url),
      });
    })();
    return true;
  }

  if (msg.type === MSG_HTTP && msg.req && typeof msg.req.url === "string") {
    (async () => {
      const r = await httpRequest(msg.req);
      sendResponse(r);
    })();
    return true;
  }

  if (msg.type === MSG_ARCHIVE && msg.req && typeof msg.req.op === "string") {
    (async () => {
      try {
        const out = await handleArchiveMessage(msg);
        sendResponse(out);
      } catch (e) {
        sendResponse({ ok: false, error: String(e && (e.stack || e.message || e)) });
      }
    })();
    return true;
  }


  if (msg.type === MSG_IDENTITY_FIRST_RUN_PROMPT) {
    (async () => {
      try {
        sendResponse(await openIdentityFirstRunPrompt(msg.action || "force-show"));
      } catch (e) {
        sendResponse({ ok: false, error: String(e && (e.stack || e.message || e)) });
      }
    })();
    return true;
  }

  if (msg.type === MSG_CONTROL_HUB_OPEN) {
    (async () => {
      try {
        sendResponse(await openControlHubPanel());
      } catch (e) {
        sendResponse({ ok: false, error: String(e && (e.stack || e.message || e)) });
      }
    })();
    return true;
  }

  if (msg.type === MSG_BILLING && msg.req && typeof msg.req.action === "string") {
    (async () => {
      let action = "";
      try {
        action = String(msg.req.action || "").trim();
        if (action === "billing:create-checkout-session") {
          sendResponse(await billingHandleCreateCheckoutSession(msg.req));
          return;
        }
        if (action === "billing:get-current-entitlement") {
          sendResponse(await billingHandleGetCurrentEntitlement(msg.req));
          return;
        }
        if (action === "billing:create-customer-portal-session") {
          sendResponse(await billingHandleCreateCustomerPortalSession(msg.req));
          return;
        }
        sendResponse(billingSafeError("billing/provider-unavailable", "billing-stage/background-action-unsupported"));
      } catch (_) {
        const errorCode = action === "billing:create-checkout-session"
          ? "billing/checkout-failed"
          : (action === "billing:create-customer-portal-session" ? "billing/portal-failed" : "billing/entitlement-failed");
        sendResponse(billingSafeError(
          errorCode,
          "billing-stage/background-handler-threw"
        ));
      }
    })();
    return true;
  }

  if (msg.type === MSG_IDENTITY && msg.req && typeof msg.req.action === "string") {
    (async () => {
      try {
        const action = String(msg.req.action).trim();
        if (action === "identity:get-snapshot") {
          sendResponse(await identityAuthManager_getSnapshot());
          return;
        }
        if (action === "identity:set-snapshot") {
          sendResponse(await identityAuthManager_setSnapshot(msg.req.snapshot));
          return;
        }
        if (action === "identity:clear-snapshot") {
          sendResponse(await identityAuthManager_clearSnapshot());
          return;
        }
        if (action === "identity:get-onboarding-url") {
          const url = chrome.runtime.getURL("surfaces/identity/identity.html");
          sendResponse({ ok: true, url });
          return;
        }
        if (action === "identity:open-onboarding") {
          // Background opens the window via chrome.windows.create, which has no
          // popup-blocker restriction. This is safer than window.open() in the
          // page context after an async await.
          const url = chrome.runtime.getURL("surfaces/identity/identity.html");
          const win = await chrome.windows.create({
            url,
            type: "popup",
            width: 980,
            height: 760,
            focused: true,
          });
          sendResponse({ ok: true, windowId: win?.id });
          return;
        }
        // ── Phase 2.9 mock adapter actions ───────────────────────────────
        if (action === "identity:get-derived-state") {
          sendResponse(await identityAuthManager_getDerivedState());
          return;
        }
        if (action === "identity:request-provider-permission") {
          sendResponse(await identityProviderPermission_requestExactHostFromPopup(sender));
          return;
        }
        if (action === "identity:request-email-otp") {
          sendResponse(await identityAuthManager_requestEmailOtp(msg.req));
          return;
        }
        if (action === "identity:verify-email-otp") {
          sendResponse(await identityAuthManager_verifyEmailOtp(msg.req));
          return;
        }
        if (action === "identity:sign-up-with-password") {
          sendResponse(await identityAuthManager_signUpWithPassword(msg.req));
          return;
        }
        if (action === "identity:verify-signup-email-code") {
          sendResponse(await identityAuthManager_verifySignupEmailCode(msg.req));
          return;
        }
        if (action === "identity:resend-signup-confirmation") {
          sendResponse(await identityAuthManager_resendSignupConfirmation(msg.req));
          return;
        }
        if (action === "identity:sign-in-with-password") {
          sendResponse(await identityAuthManager_signInWithPassword(msg.req));
          return;
        }
        if (action === "identity:sign-in-with-google") {
          sendResponse(await identityAuthManager_signInWithGoogle());
          return;
        }
        if (action === "identity:request-password-reset") {
          sendResponse(await identityAuthManager_requestPasswordReset(msg.req));
          return;
        }
        if (action === "identity:request-password-recovery-code") {
          sendResponse(await identityAuthManager_requestPasswordRecoveryCode(msg.req));
          return;
        }
        if (action === "identity:verify-password-recovery-code") {
          sendResponse(await identityAuthManager_verifyPasswordRecoveryCode(msg.req));
          return;
        }
        if (action === "identity:update-password-after-recovery") {
          sendResponse(await identityAuthManager_updatePasswordAfterRecovery(msg.req));
          return;
        }
        if (action === "identity:update-profile") {
          sendResponse(await identityAuthManager_updateProfile(msg.req));
          return;
        }
        if (action === "identity:rename-workspace") {
          sendResponse(await identityAuthManager_renameWorkspace(msg.req));
          return;
        }
        if (action === "identity:change-password") {
          sendResponse(await identityAuthManager_changePassword(msg.req));
          return;
        }
        if (action === "identity:create-profile") {
          sendResponse(await identityAuthManager_createProfile(msg.req));
          return;
        }
        if (action === "identity:create-workspace") {
          sendResponse(await identityAuthManager_createWorkspace(msg.req));
          return;
        }
        if (action === "identity:complete-onboarding") {
          sendResponse(await identityAuthManager_completeOnboarding(msg.req));
          return;
        }
        if (action === "identity:attach-local-profile") {
          sendResponse(await identityAuthManager_attachLocalProfile(msg.req));
          return;
        }
        if (action === "identity:migrate-local-workspace") {
          sendResponse(await identityAuthManager_migrateLocalWorkspace(msg.req));
          return;
        }
        if (action === "identity:refresh-session") {
          sendResponse(await identityAuthManager_refreshSession());
          return;
        }
        if (action === "identity:sign-out") {
          sendResponse(await identityAuthManager_signOut());
          return;
        }
        sendResponse({ ok: false, error: "unsupported identity action: " + action });
      } catch (e) {
        sendResponse({ ok: false, error: String(e && (e.stack || e.message || e)) });
      }
    })();
    return true;
  }
});

/* W-2b readiness Port. Its whole job is to answer one question - is this worker
 * up and far enough along that the observer route can answer - and then get out
 * of the way. It reads no repository, opens no database or handle, composes
 * nothing and stores nothing; it is strictly less capable than the observation
 * it precedes.
 *
 * Registered synchronously at top level, so a connection arriving against a
 * dormant worker is delivered once this script has evaluated rather than racing
 * it. Every path answers exactly once and then disconnects, so the caller always
 * gets either an acknowledgement or a disconnect and can never hang - which is
 * what lets the Studio panel bound this gesture without owning a timer.
 *
 * Deliberately its own listener: no MSG_ARCHIVE coupling, and no keepalive - the
 * Port closes the moment it has answered. */
chrome.runtime.onConnect.addListener((port) => {
  if (!port || port.name !== P02_OBSERVE_READY_PORT) return;
  let answered = false;
  const finishReadiness = (payload) => {
    if (answered) return;
    answered = true;
    try { port.postMessage({ ...payload, build: H2O_BUILD_STAMP }); } catch (_) { /* caller gone */ }
    try { port.disconnect(); } catch (_) { /* already closed */ }
  };
  (async () => {
    try {
      if (!isTrustedP02StudioSender(port.sender)) {
        finishReadiness({ ok: false, error: "p02-observe-ready-sender-forbidden" });
        return;
      }
      /* The same readiness the observer itself waits on, awaited and discarded:
       * this Port never touches the runtime it is waiting for. */
      await whenBackgroundSyncRuntimeReady();
      finishReadiness({ ok: true, readiness: "p02-observe-ready" });
    } catch (_) {
      finishReadiness({ ok: false, error: "p02-observe-ready-failed" });
    }
  })();
});

chrome.runtime.onConnect.addListener((port) => {
  if (!port || port.name !== MSG_ARCHIVE_PORT) return;
  let handled = false;
  let disconnected = false;
  let keepAliveTimer = 0;
  const clearKeepAlive = () => {
    if (!keepAliveTimer) return;
    try { clearInterval(keepAliveTimer); } catch {}
    keepAliveTimer = 0;
  };
  const safePost = (payload) => {
    if (disconnected) return false;
    try {
      port.postMessage(payload);
      return true;
    } catch {
      disconnected = true;
      clearKeepAlive();
      return false;
    }
  };
  port.onDisconnect.addListener(() => {
    disconnected = true;
    clearKeepAlive();
  });
  port.onMessage.addListener((msg) => {
    if (handled) return;
    handled = true;
    (async () => {
      try {
        if (!msg || msg.type !== MSG_ARCHIVE || !msg.req || typeof msg.req.op !== "string") {
          safePost({ ok: false, error: "invalid archive port request" });
          return;
        }
        safePost({ type: "archive-accepted" });
        keepAliveTimer = setInterval(() => {
          safePost({ type: "archive-keepalive", at: Date.now() });
        }, 5000);
        safePost(await handleArchiveMessage(msg));
      } catch (e) {
        safePost({ ok: false, error: String(e && (e.stack || e.message || e)) });
      } finally {
        clearKeepAlive();
      }
    })();
  });
});


function findActiveChatTab() {
  return new Promise((resolve, reject) => {
    try {
      chrome.tabs.query({ active: true, lastFocusedWindow: true, url: [CHAT_MATCH] }, (activeRows) => {
        const le = chrome.runtime.lastError;
        if (le) return reject(new Error(String(le.message || le)));
        const active = Array.isArray(activeRows) ? activeRows.find((tab) => tab && Number(tab.id) > 0) : null;
        if (active) return resolve(active);
        chrome.tabs.query({ url: [CHAT_MATCH] }, (rows) => {
          const le2 = chrome.runtime.lastError;
          if (le2) return reject(new Error(String(le2.message || le2)));
          const tab = Array.isArray(rows) ? rows.find((item) => item && Number(item.id) > 0) : null;
          resolve(tab || null);
        });
      });
    } catch (error) {
      reject(error);
    }
  });
}

function sendIdentityFirstRunPromptToTab(tabId, actionRaw = "force-show") {
  const action = String(actionRaw || "force-show").trim().toLowerCase() || "force-show";
  return new Promise((resolve, reject) => {
    try {
      chrome.tabs.sendMessage(Number(tabId), { type: MSG_IDENTITY_FIRST_RUN_PROMPT, action }, (resp) => {
        const le = chrome.runtime.lastError;
        if (le) return reject(new Error(String(le.message || le)));
        if (!resp || resp.ok === false) return reject(new Error(String(resp?.error || "Identity first-run prompt request failed")));
        resolve({ ok: true, action, response: resp });
      });
    } catch (error) {
      reject(error);
    }
  });
}

async function openIdentityFirstRunPrompt(actionRaw = "force-show") {
  const tab = await findActiveChatTab();
  if (!tab || !Number(tab.id)) {
    return { ok: false, error: "No active ChatGPT tab found. Open chatgpt.com first." };
  }
  const result = await sendIdentityFirstRunPromptToTab(tab.id, actionRaw);
  return { ok: true, tabId: tab.id, action: result.action };
}

chrome.runtime.onMessageExternal.addListener((msg, _sender, sendResponse) => {
  if (!msg || typeof msg.type !== "string") return;

  if (msg.type === MSG_ARCHIVE && msg.req && typeof msg.req.op === "string") {
    (async () => {
      try {
        sendResponse(await handleExternalArchiveMessage(msg));
      } catch (e) {
        sendResponse({ ok: false, error: String(e && (e.stack || e.message || e)) });
      }
    })();
    return true;
  }

  if (msg.type === MSG_STUDIO_BROADCAST) {
    (async () => {
      try {
        sendResponse(await handleExternalStudioBroadcastMessage(msg, _sender));
      } catch (e) {
        sendResponse({ ok: false, error: String(e && (e.stack || e.message || e)) });
      }
    })();
    return true;
  }

  if (msg.type === MSG_NATIVE_FOLDER_STATE) {
    (async () => {
      try {
        sendResponse(await handleExternalNativeFolderStateMessage(msg, _sender));
      } catch (e) {
        sendResponse({ ok: false, error: String(e && (e.stack || e.message || e)) });
      }
    })();
    return true;
  }

  /* Phase K-2.6 — parallel dispatch arm for cross-extension linked-records
   * messages. Same async sendResponse pattern as the folder-state arm. */
  if (msg.type === MSG_NATIVE_LINKED_RECORDS) {
    (async () => {
      try {
        sendResponse(await handleExternalNativeLinkedRecordsMessage(msg, _sender));
      } catch (e) {
        sendResponse({ ok: false, error: String(e && (e.stack || e.message || e)) });
      }
    })();
    return true;
  }

  if (msg.type === MSG_NATIVE_SNAPSHOT_PAYLOADS) {
    (async () => {
      try {
        sendResponse(await handleExternalNativeSnapshotPayloadsMessage(msg, _sender));
      } catch (e) {
        sendResponse({ ok: false, error: String(e && (e.stack || e.message || e)) });
      }
    })();
    return true;
  }

  /* F10.5.3 — dispatch arm for the cross-extension capture-mirror message.
   * Same async sendResponse pattern as the linked-records arm. */
  if (msg.type === MSG_NATIVE_CAPTURE_MIRROR) {
    (async () => {
      try {
        sendResponse(await handleExternalNativeCaptureMirrorMessage(msg, _sender));
      } catch (e) {
        sendResponse({ ok: false, error: String(e && (e.stack || e.message || e)) });
      }
    })();
    return true;
  }

  if (msg.type === MSG_FOLDER_METADATA_OPERATION_RESULTS) {
    (async () => {
      try {
        sendResponse(await handleExternalNativeFolderMetadataOperationResultsMessage(msg, _sender));
      } catch (e) {
        sendResponse({ ok: false, error: String(e && (e.stack || e.message || e)) });
      }
    })();
    return true;
  }

  if (msg.type === MSG_IDENTITY_FIRST_RUN_PROMPT) {
    (async () => {
      try {
        sendResponse(await openIdentityFirstRunPrompt(msg.action || "force-show"));
      } catch (e) {
        sendResponse({ ok: false, error: String(e && (e.stack || e.message || e)) });
      }
    })();
    return true;
  }

  if (msg.type === MSG_CONTROL_HUB_OPEN) {
    (async () => {
      try {
        sendResponse(await openControlHubPanel());
      } catch (e) {
        sendResponse({ ok: false, error: String(e && (e.stack || e.message || e)) });
      }
    })();
    return true;
  }
});

if (chrome.tabs && chrome.tabs.onRemoved && typeof chrome.tabs.onRemoved.addListener === "function") {
  chrome.tabs.onRemoved.addListener((tabId) => {
    clearPageDisableOnce(tabId).catch(() => {});
    clearPreviewSetOnce(tabId).catch(() => {});
    clearPageSetLink(tabId).catch(() => {});
  });
}

const HIGHLIGHT_CONTEXT_MENU_POPUP_ID = "h2o-highlight-popup";
const HIGHLIGHT_CONTEXT_MENU_QUICK_ID = "h2o-highlight-quick";
const HIGHLIGHT_CONTEXT_MENU_COLORS = Object.freeze([
  { id: "gold", title: "Gold" },
  { id: "blue", title: "Blue" },
  { id: "red", title: "Red" },
  { id: "green", title: "Green" },
  { id: "sky", title: "Sky" },
  { id: "pink", title: "Pink" },
  { id: "purple", title: "Purple" },
  { id: "orange", title: "Orange" }
]);

function ensureHighlightContextMenu() {
  if (!chrome.contextMenus || typeof chrome.contextMenus.create !== "function") return;
  try {
    chrome.contextMenus.removeAll(() => {
      const removeErr = chrome.runtime?.lastError;
      if (removeErr) {
        console.warn(TAG, "context menu reset failed", removeErr.message || String(removeErr));
      }

      chrome.contextMenus.create({
        id: HIGHLIGHT_CONTEXT_MENU_POPUP_ID,
        title: "Highlight...",
        contexts: ["selection"],
        documentUrlPatterns: [CHAT_MATCH]
      }, () => {
        const createErr = chrome.runtime?.lastError;
        if (createErr) {
          console.warn(TAG, "context menu create failed", createErr.message || String(createErr));
        }
      });

      chrome.contextMenus.create({
        id: HIGHLIGHT_CONTEXT_MENU_QUICK_ID,
        title: "Highlight Color",
        contexts: ["selection"],
        documentUrlPatterns: [CHAT_MATCH]
      }, () => {
        const createErr = chrome.runtime?.lastError;
        if (createErr) {
          console.warn(TAG, "context menu create failed", createErr.message || String(createErr));
        }
      });

      for (const item of HIGHLIGHT_CONTEXT_MENU_COLORS) {
        chrome.contextMenus.create({
          id: HIGHLIGHT_CONTEXT_MENU_QUICK_ID + ":" + item.id,
          parentId: HIGHLIGHT_CONTEXT_MENU_QUICK_ID,
          title: item.title,
          contexts: ["selection"],
          documentUrlPatterns: [CHAT_MATCH]
        }, () => {
          const createErr = chrome.runtime?.lastError;
          if (createErr) {
            console.warn(TAG, "context menu create failed", createErr.message || String(createErr));
          }
        });
      }
    });
  } catch (err) {
    console.warn(TAG, "ensureHighlightContextMenu failed", err);
  }
}

chrome.runtime.onInstalled.addListener((details) => {
  ensureHighlightContextMenu();
  identityProviderSession_scheduleWakeHydration("installed");
  // onInstalled fires on install / update / browser-update / "Reload" from
  // chrome://extensions. We only restore if presence is fresh; cold installs
  // and post-update wakes are filtered out by the staleness check inside
  // scheduleStudioPresenceRestore.
  scheduleStudioPresenceRestore("onInstalled:" + String(details && details.reason || "unknown")).catch(() => {});
});

if (chrome.runtime.onStartup && typeof chrome.runtime.onStartup.addListener === "function") {
  chrome.runtime.onStartup.addListener(() => {
    ensureHighlightContextMenu();
    identityProviderSession_scheduleWakeHydration("startup");
    scheduleStudioPresenceRestore("onStartup").catch(() => {});
  });
}

ensureHighlightContextMenu();
identityProviderSession_scheduleWakeHydration("boot");
// Top-level boot path also tries a restore — covers the unpacked-reload case
// where Chrome respawns the SW without firing onInstalled (rare, but
// observed in practice depending on Chrome version). The cooldown guard
// prevents double-fires when onInstalled does fire.
scheduleStudioPresenceRestore("sw-boot").catch(() => {});

// Toolbar-icon entry point for Studio. ONLY registered in chrome-ext-prod
// (ARCHIVE_WORKBENCH_ENABLED). Dev-controls / dev-lean bg.js does not bind
// this listener at all — dev-controls has a popup that intercepts the click
// anyway, but the explicit gate makes intent obvious and prevents a future
// change (e.g. removing the popup) from accidentally exposing Studio launch
// from a build that doesn't ship the Studio surface. Registered at top level
// so the service worker can replay queued click events after cold start.
if (ARCHIVE_WORKBENCH_ENABLED && chrome.action && typeof chrome.action.onClicked?.addListener === "function") {
  chrome.action.onClicked.addListener(() => {
    openOrFocusStudio().catch((err) => {
      console.warn(TAG, "studio launch failed", err && (err.message || err));
    });
  });
}

function broadcastIdentityPush(snapshot) {
  const safeSnap = snapshot ? identitySnapshot_sanitize(snapshot) : null;
  try {
    if (chrome.runtime && typeof chrome.runtime.sendMessage === "function") {
      chrome.runtime.sendMessage({ type: MSG_IDENTITY_PUSH, snapshot: safeSnap }, () => {
        void chrome.runtime.lastError;
      });
    }
  } catch {}
  if (!chrome.tabs || typeof chrome.tabs.sendMessage !== "function") return;
  chrome.tabs.query({ url: [CHAT_MATCH] }, (tabs) => {
    if (chrome.runtime.lastError || !Array.isArray(tabs)) return;
    for (const tab of tabs) {
      const tabId = Number(tab && tab.id || 0);
      if (!tabId) continue;
      try {
        chrome.tabs.sendMessage(tabId, { type: MSG_IDENTITY_PUSH, snapshot: safeSnap }, () => {
          void chrome.runtime.lastError;
        });
      } catch {}
    }
  });
}

function sendHighlightTrigger(tabId, payload = {}) {
  if (!chrome.tabs || typeof chrome.tabs.sendMessage !== "function") return;
  const id = Number(tabId);
  if (!Number.isFinite(id) || id <= 0) return;
  try {
    chrome.tabs.sendMessage(id, { type: "h2o-highlight-trigger", ...payload }, () => {
      const sendErr = chrome.runtime?.lastError;
      if (sendErr) {
        console.warn(TAG, "highlight trigger failed", sendErr.message || String(sendErr));
      }
    });
  } catch (err) {
    console.warn(TAG, "highlight trigger failed", err);
  }
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab) return;

  if (info.menuItemId === HIGHLIGHT_CONTEXT_MENU_POPUP_ID) {
    sendHighlightTrigger(tab.id, { action: "popup" });
    return;
  }

  const quickPrefix = HIGHLIGHT_CONTEXT_MENU_QUICK_ID + ":";
  if (typeof info.menuItemId === "string" && info.menuItemId.startsWith(quickPrefix)) {
    const color = info.menuItemId.slice(quickPrefix.length).trim().toLowerCase();
    if (!color) return;
    sendHighlightTrigger(tab.id, { action: "apply", color });
  }
});

/* Default-deny terminal for Ports. Every onConnect listener above ignores a
 * name it does not serve by returning, so a port whose name matches none of them
 * would sit open with no message and no disconnect - and a caller that waits for
 * "an acknowledgement or a disconnect" would wait forever. Version skew between
 * a Studio panel and this worker is exactly how that happens. Registered last,
 * so it only ever sees what nothing else claimed: anything unrecognised is
 * disconnected, which is what makes the caller-side wait bounded without a
 * timer. */
chrome.runtime.onConnect.addListener((port) => {
  if (!port) return;
  if (port.name === P02_OBSERVE_READY_PORT || port.name === MSG_ARCHIVE_PORT) return;
  try { port.disconnect(); } catch (_) { /* already gone */ }
});

/* W-2b post-start liveness announcement. setTimeout(0) puts this in one new
 * worker task after the initial synchronous evaluation/listener-registration
 * task. It runs once per worker startup, carries no authority or state, and a
 * missing Studio listener is the expected rejected-Promise path: swallowed,
 * never retried or rescheduled. */
setTimeout(() => {
  chrome.runtime.sendMessage({
    type: P02_OBSERVE_READY_ANNOUNCE,
    ready: true,
    build: H2O_BUILD_STAMP,
  }).then(() => {}, () => {});
}, 0);

/* P01 T07 — direct service-worker object-protocol reconciliation. The bundle
 * composes the same durable admission, Apply, projection and publication
 * modules as Studio. The worker supplies only its existing canonical archive
 * authority and lifecycle/context seams. */
let __h2oBackgroundSyncRuntime = null;
if (ARCHIVE_WORKBENCH_ENABLED &&
    typeof H2OChromeBackgroundSyncBundle !== "undefined" &&
    H2OChromeBackgroundSyncBundle &&
    typeof H2OChromeBackgroundSyncBundle.createChromeBackgroundSyncRuntime === "function") {
  try {
    __h2oBackgroundSyncRuntime =
      H2OChromeBackgroundSyncBundle.createChromeBackgroundSyncRuntime({
        chromeApi: chrome,
        indexedDBFactory: indexedDB,
        cryptoImplementation: crypto,
        manualReceiveAuthority: () =>
          __h2oW2cManualStageCapability?.stage === "receive-admission",
        manualApplyAuthority: () =>
          __h2oW2cManualStageCapability?.stage === "manual-apply",
        reconcileCore: globalThis.H2OSyncLinearReconcileCore,
        findActiveStudioContexts: findExistingStudioContexts,
        archiveAuthority: Object.freeze({
          listWorkbenchRows: () => listWorkbenchRows(),
          listSnapshots: (chatId) => listSnapshots(chatId),
          loadSnapshot: async (snapshotId) => {
            const loaded = await loadSnapshotById(snapshotId);
            if (!loaded) return null;
            return buildLoadedSnapshotResponse(
              loaded,
              await readCategoryCatalog(DEFAULT_NS_DISK),
            );
          },
          importFullBundle: ({ bundle, mode = "merge" } = {}) =>
            importFullBundle(bundle, mode),
        }),
      });
    __h2oBackgroundSyncRuntime.install();
  } catch (error) {
    console.warn(TAG, "background Sync unavailable", String(error && (error.code || error.message || error)));
  }
}
/* Unconditional, and after both the composed and the not-composed paths: a
 * waiter that is never settled is the same silent port close by another route. */
__h2oBackgroundSyncRuntimeReadySettle(__h2oBackgroundSyncRuntime);

console.log(TAG, "background ready", H2O_BUILD_STAMP);
`;
}
