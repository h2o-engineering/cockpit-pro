// Identity Phase 3.0Q through 3.1A validation — host permission, CSP,
// network/config, provider-bundle naming, conditional loading, real-config
// readiness, exact-host optional permission, network arming, and
// request-email-OTP-only provider gates.
// This validator is intentionally read-only. It verifies the current dev manifests
// remain dev-scoped, the production manifest profile is narrow, provider code remains
// background-owned, exact Supabase host permission is generated only from approved config,
// real dev config readiness is redacted, dev-only private config is not page-facing, and no provider auth or network behavior is introduced before
// the approved permission/client/OTP phases.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { extensionBuildDir } from "../../paths.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

// Phase 4B-1b: CWD-relative path string for an extension build artifact.
// Byte-identical to legacy "build/chrome-ext-<variant>/<segments>" form.
function extBuildRel(variant, ...segments) {
  return path.relative(REPO_ROOT, path.join(extensionBuildDir(variant), ...segments));
}

const VARIANTS = Object.freeze([
  { label: "controls", rel: extBuildRel("dev-controls"), profile: "development" },
  { label: "lean", rel: extBuildRel("dev-lean"), profile: "development" },
  { label: "production", rel: extBuildRel("prod"), profile: "production" },
]);

const PROVIDER_BUNDLE_NAME = "identity-provider-supabase";
const PROVIDER_BUNDLE_REL = `provider/${PROVIDER_BUNDLE_NAME}.js`;
const PRIVATE_CONFIG_REL = "provider/identity-provider-private-config.js";
const PRIVATE_CONFIG_GLOBAL = "H2O_IDENTITY_PROVIDER_PRIVATE_CONFIG";
const LEGACY_PROVIDER_BUNDLE_NAME = ["identity", "provider", "dummy"].join("-");
const LEGACY_PROVIDER_BUNDLE_REL = `provider/${LEGACY_PROVIDER_BUNDLE_NAME}.js`;
const PROBE_MARKER = "H2O_IDENTITY_PROVIDER_BUNDLE_PROBE";
const PROVIDER_SOURCE_REL = "tools/product/identity/identity-provider-supabase.entry.mjs";
const BACKGROUND_SOURCE_REL = "tools/product/extensions/chatgpt/chrome/chrome-live-background.mjs";
const MANIFEST_SOURCE_REL = "tools/product/extensions/chatgpt/chrome/chrome-live-manifest.mjs";
const BUILD_SOURCE_REL = "tools/product/extensions/chatgpt/chrome/build-chrome-live-extension.mjs";
const BUILD_CONTEXT_SOURCE_REL = "tools/product/extensions/chatgpt/chrome/chrome-live-build-context.mjs";
const GITIGNORE_REL = ".gitignore";
const LOCAL_IDENTITY_PROVIDER_CONFIG_REL = "config/local/identity-provider.local.json";
const SDK_PACKAGE_NAME = "@supabase/supabase-js";
const SDK_NAMESPACE = "@supabase/";
const REAL_CONFIG_SMOKE_PROVIDER_URL = "https://h2o-dev-config-readiness.invalid";
const REAL_CONFIG_SMOKE_PUBLIC_CLIENT = "phase3y-public-client";
const EXACT_HOST_PROJECT_REF = "h2o3zexact";
const EXACT_HOST_DOMAIN = ["supabase", "co"].join(".");
const EXACT_HOST_PROJECT_URL = `https://${EXACT_HOST_PROJECT_REF}.${EXACT_HOST_DOMAIN}`;
const EXACT_HOST_PERMISSION = `${EXACT_HOST_PROJECT_URL}/*`;
const EXACT_HOST_PUBLIC_CLIENT = "phase3z-public-client";
const TEXT_EXTENSIONS = new Set([".css", ".html", ".js", ".json", ".mjs", ".txt"]);
const WARNINGS = [];
const PROVIDER_CONFIG_SAFE_KEYS = "bundleProbe,capabilities,clientReady,configSource,errorCodes,missingFields,networkBlockReason,networkReady,networkStatus,permissionErrorCode,permissionHostKind,permissionReady,permissionRequired,permissionSource,permissionStatus,phaseNetworkEnabled,providerConfigured,providerKind,providerMode,schemaVersion,valid,validationState";
const DEFAULT_CHAT_HOST_PERMISSION = "https://chatgpt.com/*";
const DEFAULT_PROXY_HOST_PERMISSION = "http://127.0.0.1:5500/*";
const PROVIDER_PERMISSION_ACTION = "identity:request-provider-permission";

const REDACTED_COMPLETE_DEV_ENV_STATUS = Object.freeze({
  schemaVersion: "3.0N",
  providerKind: "supabase",
  providerMode: "provider_backed",
  providerConfigured: true,
  configSource: "dev_env",
  valid: true,
  validationState: "valid",
  missingFields: [],
  errorCodes: [],
  capabilities: {
    emailOtp: true,
    magicLink: false,
    oauth: false,
  },
});

const DANGEROUS_PERMISSIONS = new Set([
  "webRequest",
  "webRequestBlocking",
  "cookies",
  "identity",
]);

const REAL_CONFIG_PATTERNS = Object.freeze([
  ["Supabase project URL", /https:\/\/[a-z0-9-]+\.supabase\.co(?:\/|\b)/i],
  ["service role", /\b(service_role|service-role)\b/i],
  ["anon key label", /\banon[\s_-]*key\b/i],
  ["JWT-like value", /\beyJ[A-Za-z0-9_-]{40,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/],
]);

const REDACTED_STATUS_FORBIDDEN_PATTERNS = Object.freeze([
  ["raw provider project field", /\b(providerProject|provider_project|projectUrl|project_url|supabaseUrl|supabase_url)\b/i],
  ["raw public client field", /\b(publicClient|public_client|anonKey|anon_key|publishableKey|publishable_key)\b/i],
  ["server credential field", /\b(serviceRoleKey|service_role|service-role|secret|credential|password|private|admin)\b/i],
  ["token/session field", /\b(access_token|refresh_token|id_token|provider_token|auth_code|otp_token_hash|session)\b/i],
  ...REAL_CONFIG_PATTERNS,
]);

const PAGE_FACING_FORBIDDEN_PATTERNS = Object.freeze([
  ["provider SDK package", /@supabase\/supabase-js/i],
  ["provider SDK namespace", /@supabase\//i],
  ["Supabase provider text", /\bsupabase\b/i],
  ["provider bundle path", /provider\/identity-provider-supabase\.js/i],
  ["provider bundle name", /identity-provider-supabase/i],
  ["provider probe marker", /H2O_IDENTITY_PROVIDER_BUNDLE_PROBE/],
  ["token field", /\b(access_token|refresh_token|id_token|provider_token|auth_code|otp_token_hash)\b/i],
  ["auth call", /\b(signInWithOtp|verifyOtp|signInWithOAuth|signInWithIdToken|createClient|launchWebAuthFlow)\s*\(/],
  ...REAL_CONFIG_PATTERNS,
]);

const POPUP_FORBIDDEN_PATTERNS = Object.freeze([
  ["provider SDK package", /@supabase\/supabase-js/i],
  ["provider SDK namespace", /@supabase\//i],
  ["provider bundle path", /provider\/identity-provider-supabase\.js/i],
  ["provider bundle name", /identity-provider-supabase/i],
  ["provider probe marker", /H2O_IDENTITY_PROVIDER_BUNDLE_PROBE/],
  ["token field", /\b(access_token|refresh_token|id_token|provider_token|auth_code|otp_token_hash)\b/i],
  ["auth call", /\b(signInWithOtp|verifyOtp|signInWithOAuth|signInWithIdToken|createClient|launchWebAuthFlow)\s*\(/],
  ...REAL_CONFIG_PATTERNS,
]);

const LOADER_FORBIDDEN_PATTERNS = Object.freeze([
  ["Supabase provider text", /\bsupabase\b/i],
  ["request email OTP call", /\bsignInWithOtp\b/],
  ["verify OTP call", /\bverifyOtp\b/],
  ["provider client creation", /\bcreateClient\b/],
  ["provider bundle path", /provider\/identity-provider-supabase\.js/i],
  ["provider probe marker", /H2O_IDENTITY_PROVIDER_BUNDLE_PROBE/],
]);

const PROVIDER_SOURCE_FORBIDDEN_PATTERNS = Object.freeze([
  ["ID-token sign-in call", /\bsignInWithIdToken\s*\(/],
  ["provider network XMLHttpRequest", /\bXMLHttpRequest\s*\(/],
  ["provider network WebSocket", /\bWebSocket\s*\(/],
  ["provider network EventSource", /\bEventSource\s*\(/],
  ...REAL_CONFIG_PATTERNS,
]);

const PROVIDER_BUNDLE_DYNAMIC_CODE_PATTERNS = Object.freeze([
  ["eval", /\beval\s*\(/],
  ["new Function", /\bnew\s+Function\b/],
  ["Function constructor", /(^|[^\w$])Function\s*\(/],
]);

const PROVIDER_PROBE_AUTH_CALL_PATTERNS = Object.freeze([
  ["ID-token sign-in call", /\bsignInWithIdToken\s*\(/],
]);

function abs(rel) {
  return path.join(REPO_ROOT, rel);
}

function toRel(root, file) {
  return path.relative(root, file).split(path.sep).join("/");
}

function read(rel) {
  return fs.readFileSync(abs(rel), "utf8");
}

function readAbs(file) {
  return fs.readFileSync(file, "utf8");
}

function readJson(rel) {
  return JSON.parse(read(rel));
}

function existsAbs(file) {
  return fs.existsSync(file);
}

function assert(condition, message) {
  if (!condition) throw new Error(`FAIL: ${message}`);
}

function warn(message) {
  WARNINGS.push(message);
  console.warn(`  WARN: ${message}`);
}

function stringList(value) {
  return Array.isArray(value) ? value.map((item) => String(item || "")) : [];
}

function listFiles(root) {
  const out = [];
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const file = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(file);
      } else if (entry.isFile()) {
        out.push(file);
      }
    }
  }
  return out.sort();
}

function textFiles(root) {
  return listFiles(root).filter((file) => TEXT_EXTENSIONS.has(path.extname(file).toLowerCase()));
}

function flattenWarResources(manifest) {
  const entries = Array.isArray(manifest.web_accessible_resources)
    ? manifest.web_accessible_resources
    : [];
  return entries.flatMap((entry) => Array.isArray(entry.resources) ? entry.resources : []);
}

function assertNoPatterns(label, source, patterns) {
  for (const [name, pattern] of patterns) {
    assert(!pattern.test(source), `${label} contains forbidden ${name}: ${pattern}`);
  }
}

function assertOtpCodeNormalizer(label, source, functionName) {
  const index = source.indexOf(`function ${functionName}(input)`);
  assert(index >= 0, `${label}: ${functionName} helper missing`);
  const block = source.slice(index, index + 260);
  assert(block.includes('String(input || "").trim()'),
    `${label}: ${functionName} must trim caller OTP input`);
  const match = block.match(/return \/\^\[0-9\]\{(\d+),(\d+)\}\$\/\.test\(code\) \? code : "";/);
  assert(match, `${label}: ${functionName} must validate a bounded numeric OTP range`);
  const min = Number(match[1]);
  const max = Number(match[2]);
  assert(min === 6 && max === 10,
    `${label}: ${functionName} must accept numeric OTP codes from 6 to 10 digits`);
  const normalize = (input) => {
    const code = String(input || "").trim();
    return new RegExp(`^[0-9]{${min},${max}}$`).test(code) ? code : "";
  };
  assert(normalize("123456") === "123456",
    `${label}: ${functionName} must accept 6-digit OTP codes`);
  assert(normalize("67626320") === "67626320",
    `${label}: ${functionName} must accept Supabase 8-digit OTP codes`);
  assert(normalize(" 67626320 ") === "67626320",
    `${label}: ${functionName} must trim whitespace around OTP codes`);
  for (const bad of ["", "12345", "12345678901", "1234abcd", "123 456", "<script>67626320</script>"]) {
    assert(normalize(bad) === "",
      `${label}: ${functionName} must reject invalid OTP code ${JSON.stringify(bad)}`);
  }
}

function pageFacingRels(root, files) {
  const rels = new Set([
    "loader.js",
    "folder-bridge-page.js",
    "popup.html",
    "popup.js",
    "popup.css",
    "surfaces/identity/identity.html",
    "surfaces/identity/identity.js",
    "surfaces/identity/identity.css",
    "src-runtime-base/0D4a.⬛️🔐 Identity Core 🔐.js",
  ]);
  for (const file of files) {
    const rel = toRel(root, file);
    if (rel.startsWith("src-runtime-base/") || rel.startsWith("surfaces/")) rels.add(rel);
    if (/^popup\.(?:css|html|js)$/i.test(rel)) rels.add(rel);
  }
  return [...rels].filter((rel) => existsAbs(path.join(root, rel)));
}

function assertManifestBoundary(variant, profile, manifest) {
  const permissions = stringList(manifest.permissions);
  const hostPermissions = stringList(manifest.host_permissions);
  const optionalHostPermissions = stringList(manifest.optional_host_permissions);
  const externalIds = stringList(manifest.externally_connectable?.ids);
  const isProduction = profile === "production";

  assert(!Object.prototype.hasOwnProperty.call(manifest, "content_security_policy"),
    `${variant}: content_security_policy must not be added in Phase 3.0T`);
  if (Object.prototype.hasOwnProperty.call(manifest, "optional_host_permissions")) {
    assert(optionalHostPermissions.length > 0, `${variant}: optional_host_permissions must be a non-empty list when present`);
    for (const permission of optionalHostPermissions) {
      assert(/^https:\/\/[a-z0-9-]+\.supabase\.co\/\*$/.test(permission),
        `${variant}: optional_host_permissions must be exact Supabase project hosts only: ${permission}`);
      assert(permission !== "https://*.supabase.co/*",
        `${variant}: wildcard Supabase optional host permission is forbidden`);
    }
  }

  for (const permission of permissions) {
    assert(!DANGEROUS_PERMISSIONS.has(permission),
      `${variant}: manifest permission ${permission} is not approved before real auth`);
  }

  for (const permission of [...hostPermissions, ...optionalHostPermissions]) {
    if (hostPermissions.includes(permission)) {
      assert(!/supabase\.co/i.test(permission),
        `${variant}: normal Supabase host permission is forbidden: ${permission}`);
    }
  }

  if (isProduction) {
    assert(!hostPermissions.includes("*://*/*"),
      `${variant}: production host_permissions must not include *://*/*`);
    assert(!hostPermissions.includes("http://127.0.0.1:5500/*"),
      `${variant}: production host_permissions must not include the dev proxy`);
    assert(hostPermissions.includes("https://chatgpt.com/*"),
      `${variant}: production host_permissions must stay limited to chatgpt.com`);
    assert(!externalIds.includes("*"),
      `${variant}: production externally_connectable must not include [\"*\"]`);
  } else if (hostPermissions.includes("*://*/*")) {
    warn(`${variant}: *://*/* host permission is present as dev-only baseline and is production-unsafe`);
  }
  if (!isProduction && hostPermissions.includes("http://127.0.0.1:5500/*")) {
    warn(`${variant}: 127.0.0.1 host permission is present for the dev proxy only`);
  }

  const warResources = flattenWarResources(manifest);
  assert(!warResources.includes(PROVIDER_BUNDLE_REL),
    `${variant}: provider bundle must not be web-accessible`);
  assert(!warResources.includes(PRIVATE_CONFIG_REL),
    `${variant}: private config artifact must not be web-accessible`);
  assert(!warResources.includes(LEGACY_PROVIDER_BUNDLE_REL),
    `${variant}: legacy provider bundle must not be web-accessible`);
  assert(!warResources.some((resource) => String(resource || "").startsWith("provider/")),
    `${variant}: provider directory must not be web-accessible`);
  assert(!JSON.stringify(warResources).includes(PROBE_MARKER),
    `${variant}: provider probe marker must not appear in web_accessible_resources`);

  if (externalIds.includes("*")) {
    warn(`${variant}: externally_connectable ids [\"*\"] is present and must be tightened before real auth`);
  }

  return { permissions, hostPermissions, warResources };
}

function isBroadAllHostPermission(permission) {
  const value = String(permission || "").trim().toLowerCase();
  return value === "<all_urls>"
    || value === "*://*/*"
    || value === "http://*/*"
    || value === "https://*/*";
}

function assertArmedRequestOtpManifestBoundary(label, manifest) {
  const hostPermissions = stringList(manifest.host_permissions);
  const optionalHostPermissions = stringList(manifest.optional_host_permissions);
  const externalIds = stringList(manifest.externally_connectable?.ids);

  assert(!Object.prototype.hasOwnProperty.call(manifest, "content_security_policy"),
    `${label}: armed request_otp manifest must not add CSP`);
  assert(!hostPermissions.some(isBroadAllHostPermission),
    `${label}: armed request_otp host_permissions must not include broad all-host access`);
  assert(hostPermissions.length === 2
      && hostPermissions.includes(DEFAULT_CHAT_HOST_PERMISSION)
      && hostPermissions.includes(DEFAULT_PROXY_HOST_PERMISSION),
    `${label}: armed request_otp host_permissions must be limited to chatgpt.com and local proxy; got ${hostPermissions.join(", ")}`);
  assert(!hostPermissions.some((permission) => /supabase\.co/i.test(permission)),
    `${label}: armed request_otp must not put Supabase in normal host_permissions`);
  assert(optionalHostPermissions.length === 1 && optionalHostPermissions[0] === EXACT_HOST_PERMISSION,
    `${label}: armed request_otp optional_host_permissions must contain only ${EXACT_HOST_PERMISSION}`);
  assert(!externalIds.includes("*"),
    `${label}: armed request_otp externally_connectable must not include [\"*\"]`);
  assert(!flattenWarResources(manifest).some((resource) => String(resource || "").startsWith("provider/")),
    `${label}: armed request_otp provider/private artifacts must not be web-accessible`);
}

function assertLoaderClean(variant, loaderSource) {
  assertNoPatterns(`${variant} loader.js`, loaderSource, LOADER_FORBIDDEN_PATTERNS);
  assert(!loaderSource.includes(LEGACY_PROVIDER_BUNDLE_REL),
    `${variant} loader.js must not reference legacy provider bundle path`);
  assert(!loaderSource.includes(LEGACY_PROVIDER_BUNDLE_NAME),
    `${variant} loader.js must not reference legacy provider bundle name`);
}

function assertPageFacingClean(variant, root, files) {
  for (const rel of pageFacingRels(root, files)) {
    const source = readAbs(path.join(root, rel));
    let checks = /^popup\.(?:html|js|css)$/i.test(rel)
      ? POPUP_FORBIDDEN_PATTERNS
      : PAGE_FACING_FORBIDDEN_PATTERNS;
    if (rel === "src-runtime-base/0D4a.⬛️🔐 Identity Core 🔐.js") {
      checks = checks.filter(([name]) => name !== "Supabase provider text");
    }
    assertNoPatterns(`${variant} ${rel}`, source, checks);
    if (!/^popup\.(?:html|js)$/i.test(rel)) {
      assert(!source.includes(PROVIDER_PERMISSION_ACTION),
        `${variant} ${rel}: provider permission action may appear only in background or popup grant wiring`);
    }
    assert(!source.includes(LEGACY_PROVIDER_BUNDLE_REL),
      `${variant} ${rel}: page-facing output must not reference legacy provider bundle path`);
    assert(!source.includes(LEGACY_PROVIDER_BUNDLE_NAME),
      `${variant} ${rel}: page-facing output must not reference legacy provider bundle name`);
  }
}

function assertGeneratedProviderPermissionActionScope(variant, root, files) {
  for (const file of files) {
    const rel = toRel(root, file);
    const source = readAbs(file);
    if (!source.includes(PROVIDER_PERMISSION_ACTION)) continue;
    assert(rel === "bg.js" || rel === "popup.html" || rel === "popup.js",
      `${variant} ${rel}: provider permission action must stay confined to background and Dev Controls popup`);
  }
}

function assertGeneratedOutputsNoRealConfig(variant, root, files) {
  for (const file of files) {
    const rel = toRel(root, file);
    if (rel === PRIVATE_CONFIG_REL) continue;
    const source = (rel === "manifest.json" || rel === "bg.js")
      ? readAbs(file).replace(/https:\/\/[a-z0-9-]+\.supabase\.co\/\*/gi, "")
      : readAbs(file);
    assertNoPatterns(`${variant} ${rel}`, source, REAL_CONFIG_PATTERNS);
  }
}

function assertNoCreateClientOutsideProviderContext(variant, root, files) {
  for (const file of files) {
    const rel = toRel(root, file);
    if (rel === PROVIDER_BUNDLE_REL) continue;
    const source = readAbs(file);
    assert(!/\bcreateClient\s*\(/.test(source),
      `${variant} ${rel}: createClient call is not approved in Phase 3.0Q`);
  }
}

function assertProviderConfigStatusHasDeferredPermission(label, providerConfigStatus) {
  const status = providerConfigStatus && typeof providerConfigStatus === "object"
    ? providerConfigStatus
    : null;
  assert(status, `${label}: providerConfigStatus must be an object`);
  assert(status.providerKind === "mock", `${label}: providerKind must remain mock`);
  assert(status.providerMode === "local_dev", `${label}: providerMode must remain local_dev`);
  assert(status.configSource === "built_in_mock", `${label}: configSource must remain built_in_mock`);
  assert(status.valid === true, `${label}: provider config must remain valid`);
  assert(status.permissionRequired === "deferred", `${label}: permissionRequired must be deferred`);
  assert(status.permissionReady === false, `${label}: permissionReady must be false`);
  assert(status.permissionSource === "deferred_until_project_host", `${label}: permissionSource must be deferred_until_project_host`);
  assert(status.permissionHostKind === "none", `${label}: permissionHostKind must be none`);
  assert(status.permissionStatus === "deferred", `${label}: permissionStatus must be deferred`);
  assert(status.permissionErrorCode === null, `${label}: permissionErrorCode must be null`);
  assertNetworkArmingBlocked(label, status);
  assert(status.clientReady === false, `${label}: clientReady must be false`);
  assert(status.bundleProbe?.expected === false, `${label}: default bundleProbe expected must be false`);
  assert(status.bundleProbe?.loaded === false, `${label}: default bundleProbe loaded must be false`);
  assert(status.bundleProbe?.kind === "skipped", `${label}: default bundleProbe kind must be skipped`);
  assert(status.bundleProbe?.phase === "3.0X", `${label}: default bundleProbe phase must be 3.0X`);
  assert(status.bundleProbe?.skipReason === "provider_config_inactive", `${label}: default bundleProbe skipReason must be provider_config_inactive`);
  assert(status.bundleProbe?.smokeRun === false, `${label}: default bundleProbe smokeRun must be false`);
  assert(status.bundleProbe?.clientCreated === false, `${label}: default bundleProbe clientCreated must be false`);
  assert(status.bundleProbe?.networkObserved === false, `${label}: default bundleProbe networkObserved must be false`);
  assert(status.bundleProbe?.authCallsObserved === false, `${label}: default bundleProbe authCallsObserved must be false`);
  assert(status.bundleProbe?.otpEnabled === false, `${label}: default bundleProbe otpEnabled must be false`);
  assert(status.bundleProbe?.clientReady === false, `${label}: default bundleProbe clientReady must be false`);
  assert(status.bundleProbe?.realConfigSmokeRun === false, `${label}: default bundleProbe realConfigSmokeRun must be false`);
  assert(status.bundleProbe?.realConfigClientCreated === false, `${label}: default bundleProbe realConfigClientCreated must be false`);
  const keys = Object.keys(status).sort().join(",");
  assert(keys === PROVIDER_CONFIG_SAFE_KEYS,
    `${label}: providerConfigStatus safe keys mismatch: ${keys}`);
}

function assertNetworkArmingBlocked(label, status) {
  assert(status.phaseNetworkEnabled === false, `${label}: phaseNetworkEnabled must be false`);
  assert(status.networkReady === false, `${label}: networkReady must be false`);
  assert(status.networkStatus === "blocked", `${label}: networkStatus must be blocked`);
  assert(status.networkBlockReason === "phase_not_enabled", `${label}: networkBlockReason must be phase_not_enabled`);
}

function assertNetworkArmedReady(label, status) {
  assert(status.phaseNetworkEnabled === true, `${label}: phaseNetworkEnabled must be true`);
  assert(status.networkReady === true, `${label}: networkReady must be true only when every gate is ready`);
  assert(status.networkStatus === "ready", `${label}: networkStatus must be ready`);
  assert(status.networkBlockReason === null, `${label}: networkBlockReason must be null`);
}

function assertProviderConfigStatusHasRedactedDevConfigReadiness(label, providerConfigStatus) {
  const status = providerConfigStatus && typeof providerConfigStatus === "object"
    ? providerConfigStatus
    : null;
  assert(status, `${label}: providerConfigStatus must be an object`);
  assert(status.schemaVersion === "3.0N", `${label}: schemaVersion must stay 3.0N`);
  assert(status.providerKind === "supabase", `${label}: providerKind must be supabase for redacted dev readiness`);
  assert(status.providerMode === "provider_backed", `${label}: providerMode must be provider_backed for redacted dev readiness`);
  assert(status.configSource === "dev_env", `${label}: configSource must be redacted dev_env`);
  assert(status.providerConfigured === true, `${label}: providerConfigured must be true for structurally complete redacted config`);
  assert(status.valid === true, `${label}: redacted complete config must be valid`);
  assert(status.validationState === "valid", `${label}: validationState must be valid`);
  assert(Array.isArray(status.missingFields) && status.missingFields.length === 0,
    `${label}: redacted complete config must not expose missing fields`);
  assert(Array.isArray(status.errorCodes) && status.errorCodes.length === 0,
    `${label}: redacted complete config must not expose error codes`);
  assert(status.capabilities?.emailOtp === true, `${label}: email OTP capability may be advertised as readiness metadata`);
  assert(status.capabilities?.magicLink === false, `${label}: magic link must remain disabled`);
  assert(status.capabilities?.oauth === false, `${label}: OAuth must remain disabled`);
  assert(status.permissionRequired === "deferred", `${label}: permissionRequired must remain deferred`);
  assert(status.permissionReady === false, `${label}: permissionReady must remain false`);
  assert(status.permissionSource === "deferred_until_project_host", `${label}: permissionSource must remain deferred_until_project_host`);
  assert(status.permissionHostKind === "none", `${label}: permissionHostKind must remain none`);
  assert(status.permissionStatus === "deferred", `${label}: permissionStatus must remain deferred`);
  assert(status.permissionErrorCode === null, `${label}: permissionErrorCode must remain null`);
  assertNetworkArmingBlocked(label, status);
  assert(status.clientReady === true, `${label}: clientReady must be true after redacted private-config lazy smoke`);
  assert(status.bundleProbe?.expected === true, `${label}: redacted provider bundleProbe expected must be true`);
  assert(status.bundleProbe?.loaded === true, `${label}: redacted provider bundleProbe loaded must be true`);
  assert(status.bundleProbe?.kind === "supabase-client-create-smoke", `${label}: redacted provider bundleProbe kind must be client smoke`);
  assert(status.bundleProbe?.phase === "3.0R", `${label}: redacted provider bundleProbe phase must be 3.0R`);
  assert(status.bundleProbe?.skipReason === null, `${label}: redacted provider bundleProbe skipReason must be null`);
  assert(status.bundleProbe?.smokeRun === true, `${label}: redacted provider bundleProbe smokeRun must be true`);
  assert(status.bundleProbe?.clientCreated === true, `${label}: redacted provider bundleProbe clientCreated must be true`);
  assert(status.bundleProbe?.networkObserved === false, `${label}: redacted provider bundleProbe networkObserved must be false`);
  assert(status.bundleProbe?.authCallsObserved === false, `${label}: redacted provider bundleProbe authCallsObserved must be false`);
  assert(status.bundleProbe?.otpEnabled === false, `${label}: redacted provider bundleProbe otpEnabled must be false`);
  assert(status.bundleProbe?.clientReady === true, `${label}: redacted provider bundleProbe clientReady must be true`);
  assert(status.bundleProbe?.realConfigSmokeRun === true, `${label}: redacted provider bundleProbe realConfigSmokeRun must be true`);
  assert(status.bundleProbe?.realConfigClientCreated === true, `${label}: redacted provider bundleProbe realConfigClientCreated must be true`);
  assert(status.bundleProbe?.realConfigNetworkObserved === false, `${label}: redacted provider bundleProbe realConfigNetworkObserved must be false`);
  assert(status.bundleProbe?.realConfigAuthCallsObserved === false, `${label}: redacted provider bundleProbe realConfigAuthCallsObserved must be false`);
  assert(status.bundleProbe?.realConfigOtpEnabled === false, `${label}: redacted provider bundleProbe realConfigOtpEnabled must be false`);
  assertNoPatterns(`${label} providerConfigStatus`, JSON.stringify(status), REDACTED_STATUS_FORBIDDEN_PATTERNS);
  const keys = Object.keys(status).sort().join(",");
  assert(keys === PROVIDER_CONFIG_SAFE_KEYS,
    `${label}: providerConfigStatus safe keys mismatch: ${keys}`);
}

function extractFunction(source, name) {
  const syncIndex = source.indexOf(`function ${name}(`);
  const asyncIndex = source.indexOf(`async function ${name}(`);
  const start = (asyncIndex >= 0 && (syncIndex < 0 || asyncIndex < syncIndex)) ? asyncIndex : syncIndex;
  assert(start >= 0, `cannot find function ${name}`);
  let bodyStart = -1;
  let parenDepth = 0;
  let seenParams = false;
  for (let i = start; i < source.length; i += 1) {
    if (source[i] === "(") {
      parenDepth += 1;
      seenParams = true;
    } else if (source[i] === ")") {
      parenDepth = Math.max(0, parenDepth - 1);
    } else if (source[i] === "{" && seenParams && parenDepth === 0) {
      bodyStart = i;
      break;
    }
  }
  assert(bodyStart >= 0, `cannot find body for function ${name}`);
  let depth = 0;
  for (let i = bodyStart; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`FAIL: cannot find end for function ${name}`);
}

function assertBuiltOnboardingDirectSessionFixture(label, bgSource) {
  assert(!bgSource.includes("/[s<>]/.test(token)"),
    `${label}: built provider session token validators must reject whitespace, not the literal letter s`);
  assert(bgSource.includes("/[\\s<>]/.test(token)"),
    `${label}: built provider session token validators must preserve the whitespace escape`);
  const start = bgSource.indexOf("const IDENTITY_PROVIDER_SESSION_EXPIRY_SKEW_MS");
  const end = bgSource.indexOf("function identityProviderSession_signOutUsable(", start);
  assert(start >= 0 && end > start,
    `${label}: built provider session helper block must be extractable`);
  const block = bgSource.slice(start, end);
  const result = new Function(`${block}
    const storedValue = {
      access_token: "validator_token_with_safe_s_letter",
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      expires_in: 3600,
      refresh_token: "validator_refresh_with_safe_s_letter",
      token_type: "bearer",
      user: { id: "00000000-0000-4000-8000-000000000001", email: "validator@example.invalid" }
    };
    const rpcSession = identityProviderSession_makeRpcSessionForOnboarding(storedValue);
    const diagnostics = identityProviderSession_onboardingDiagnostics(storedValue, rpcSession, {
      status: "verified_no_profile",
      mode: "provider_backed",
      provider: "supabase"
    });
    return { rpcSession, diagnostics };
  `)();
  assert(result.rpcSession && result.rpcSession.access_token === "validator_token_with_safe_s_letter",
    `${label}: direct snake-case provider session must build an access_token RPC session`);
  assert(result.diagnostics.rawHasAccessToken === true,
    `${label}: diagnostics must report rawHasAccessToken for direct snake-case sessions`);
  assert(result.diagnostics.normalizedHasAccessToken === true,
    `${label}: diagnostics must report normalizedHasAccessToken for direct snake-case sessions`);
  assert(result.diagnostics.rpcSessionBuilt === true,
    `${label}: diagnostics must report rpcSessionBuilt for direct snake-case sessions`);
  assert(result.diagnostics.callerSawAccessToken === true,
    `${label}: diagnostics must report callerSawAccessToken for direct snake-case sessions`);
}

function makeBuiltProviderConfigEvalCode(variant, bgSource, injectedStatus, returnExpression, options = {}) {
  const start = bgSource.indexOf("const IDENTITY_PROVIDER_CONFIG_SCHEMA_VERSION");
  const end = bgSource.indexOf("async function identityRuntime_get(");
  assert(start >= 0 && end > start, `${variant}: cannot extract built provider config block`);
  let providerConfigBlock = bgSource.slice(start, end);
  const injectedStatusPattern = /const IDENTITY_PROVIDER_CONFIG_INJECTED_STATUS = [^\n]+;\n/;
  assert(injectedStatusPattern.test(providerConfigBlock),
    `${variant}: cannot replace built injected config status for validator simulation`);
  providerConfigBlock = providerConfigBlock.replace(
    injectedStatusPattern,
    `const IDENTITY_PROVIDER_CONFIG_INJECTED_STATUS = ${JSON.stringify(injectedStatus)};\n`,
  );
  const derivedStateFunction = extractFunction(bgSource, "identityAuthManager_getDerivedState");
  const bundleProbe = injectedStatus?.providerKind === "supabase"
    && injectedStatus?.providerConfigured === true
    && injectedStatus?.valid === true
      ? {
          expected: true,
          loaded: true,
          kind: "supabase-client-create-smoke",
          phase: "3.0R",
          skipReason: null,
          smokeRun: true,
          clientCreatedAtImport: false,
          clientCreated: true,
          networkEnabled: false,
          networkObserved: false,
          authCallsObserved: false,
          otpEnabled: false,
          clientSmokeErrorCode: null,
          realConfigSmokeAvailable: true,
          realConfigSmokeRun: true,
          realConfigClientCreated: true,
          realConfigNetworkObserved: false,
          realConfigAuthCallsObserved: false,
          realConfigOtpEnabled: false,
          realConfigSmokeErrorCode: null,
          clientReady: true,
          errorCode: null,
        }
      : {
          expected: false,
          loaded: false,
          kind: "skipped",
          phase: "3.0X",
          skipReason: "provider_config_inactive",
          smokeRun: false,
          clientCreatedAtImport: false,
          clientCreated: false,
          networkEnabled: false,
          networkObserved: false,
          authCallsObserved: false,
          otpEnabled: false,
          clientSmokeErrorCode: null,
          realConfigSmokeAvailable: false,
          realConfigSmokeRun: false,
          realConfigClientCreated: false,
          realConfigNetworkObserved: false,
          realConfigAuthCallsObserved: false,
          realConfigOtpEnabled: false,
          realConfigSmokeErrorCode: null,
          clientReady: false,
          errorCode: null,
        };
  const optionalHostPattern = options.optionalHostPattern || null;
  const permissionGranted = options.permissionGranted === true;
  const phaseNetwork = options.phaseNetwork === "request_otp" ? "request_otp" : null;
  return `
    const IDENTITY_PROVIDER_PHASE_NETWORK = ${JSON.stringify(phaseNetwork)};
    const IDENTITY_PROVIDER_OPTIONAL_HOST_PATTERN = ${JSON.stringify(optionalHostPattern)};
    const IDENTITY_PROVIDER_OAUTH_PROVIDER = null;
    const chrome = {
      runtime: { lastError: null },
      permissions: {
        contains(query, callback) {
          const origins = Array.isArray(query && query.origins) ? query.origins : [];
          if (${JSON.stringify(optionalHostPattern)} && JSON.stringify(origins) !== ${JSON.stringify(JSON.stringify(optionalHostPattern ? [optionalHostPattern] : []))}) {
            throw new Error("unexpected permission contains origins " + JSON.stringify(origins));
          }
          callback(${permissionGranted ? "true" : "false"});
        },
        request(query, callback) {
          const origins = Array.isArray(query && query.origins) ? query.origins : [];
          if (${JSON.stringify(optionalHostPattern)} && JSON.stringify(origins) !== ${JSON.stringify(JSON.stringify(optionalHostPattern ? [optionalHostPattern] : []))}) {
            throw new Error("unexpected permission request origins " + JSON.stringify(origins));
          }
          callback(false);
        }
      }
    };
    function identityProviderBundle_getProbeStatus() {
      return ${JSON.stringify(bundleProbe)};
    }
    function identityProviderBundle_bootstrapConfiguredProbe() {}
    function identityProviderBundle_sanitizeSmokeError(value) {
      const text = String(value || "").trim().toLowerCase().replace(/[^a-z0-9_/-]/g, "");
      return text ? text.slice(0, 96) : null;
    }
    function identitySnapshot_derivedFromRuntime() {
      return { status: "anonymous_local" };
    }
    async function identityAuthManager_getRuntime() {
      return null;
    }
    ${providerConfigBlock}
    ${derivedStateFunction}
    return ${returnExpression};
  `;
}

function assertProviderConfigStatusHasExactPermissionReadiness(label, providerConfigStatus, permissionReady) {
  assertProviderConfigStatusHasRedactedDevConfigReadiness(label, {
    ...providerConfigStatus,
    permissionRequired: "deferred",
    permissionReady: false,
    permissionSource: "deferred_until_project_host",
    permissionHostKind: "none",
    permissionStatus: "deferred",
    permissionErrorCode: null,
  });
  assert(providerConfigStatus.permissionRequired === true,
    `${label}: permissionRequired must be true for exact-host provider config`);
  assert(providerConfigStatus.permissionReady === permissionReady,
    `${label}: permissionReady must reflect chrome.permissions.contains result`);
  assert(providerConfigStatus.permissionSource === "optional_host_permission",
    `${label}: permissionSource must be optional_host_permission`);
  assert(providerConfigStatus.permissionHostKind === "exact_supabase_project",
    `${label}: permissionHostKind must be exact_supabase_project`);
  assert(providerConfigStatus.permissionStatus === (permissionReady ? "granted" : "not_granted"),
    `${label}: permissionStatus must reflect exact-host grant state`);
  assert(providerConfigStatus.permissionErrorCode === null,
    `${label}: permissionErrorCode must remain null for successful permission check`);
  assertNetworkArmingBlocked(label, providerConfigStatus);
  assertNoPatterns(`${label} providerConfigStatus`, JSON.stringify(providerConfigStatus), REDACTED_STATUS_FORBIDDEN_PATTERNS);
  assert(!JSON.stringify(providerConfigStatus).includes(EXACT_HOST_PROJECT_URL),
    `${label}: providerConfigStatus must not expose raw project URL`);
  assert(!JSON.stringify(providerConfigStatus).includes(EXACT_HOST_PERMISSION),
    `${label}: providerConfigStatus must not expose exact permission host`);
  assert(!JSON.stringify(providerConfigStatus).includes(EXACT_HOST_PUBLIC_CLIENT),
    `${label}: providerConfigStatus must not expose public client value`);
}

function assertBuiltProviderConfigStatusPath(variant, bgSource) {
  const code = makeBuiltProviderConfigEvalCode(
    variant,
    bgSource,
    null,
    "identityProviderConfig_diag()",
  );
  const directStatus = new Function(code)();
  assertProviderConfigStatusHasDeferredPermission(`${variant} built identityProviderConfig_diag()`, directStatus);

  const derivedCode = makeBuiltProviderConfigEvalCode(
    variant,
    bgSource,
    null,
    "identityAuthManager_getDerivedState()",
  );
  return Promise.resolve(new Function(derivedCode)()).then((result) => {
    assert(result && result.ok === true, `${variant}: built identityAuthManager_getDerivedState must return ok`);
    assertProviderConfigStatusHasDeferredPermission(`${variant} built identity:get-derived-state`, result.derivedState?.providerConfigStatus);

    const redactedReadinessCode = makeBuiltProviderConfigEvalCode(
      variant,
      bgSource,
      REDACTED_COMPLETE_DEV_ENV_STATUS,
      "identityProviderConfig_diag()",
    );
    const redactedDirectStatus = new Function(redactedReadinessCode)();
    assertProviderConfigStatusHasRedactedDevConfigReadiness(
      `${variant} built redacted complete dev config readiness`,
      redactedDirectStatus,
    );

    const redactedDerivedCode = makeBuiltProviderConfigEvalCode(
      variant,
      bgSource,
      REDACTED_COMPLETE_DEV_ENV_STATUS,
      "identityAuthManager_getDerivedState()",
    );
    return Promise.resolve(new Function(redactedDerivedCode)()).then((redactedResult) => {
      assert(redactedResult && redactedResult.ok === true,
        `${variant}: built redacted identityAuthManager_getDerivedState must return ok`);
      assertProviderConfigStatusHasRedactedDevConfigReadiness(
        `${variant} built redacted identity:get-derived-state`,
        redactedResult.derivedState?.providerConfigStatus,
      );
      const exactNotGrantedCode = makeBuiltProviderConfigEvalCode(
        variant,
        bgSource,
        REDACTED_COMPLETE_DEV_ENV_STATUS,
        "identityProviderConfig_diagAsync()",
        { optionalHostPattern: EXACT_HOST_PERMISSION, permissionGranted: false },
      );
      return Promise.resolve(new Function(exactNotGrantedCode)()).then((exactNotGrantedStatus) => {
        assertProviderConfigStatusHasExactPermissionReadiness(
          `${variant} built exact-host permission not granted`,
          exactNotGrantedStatus,
          false,
        );
        const exactGrantedDerivedCode = makeBuiltProviderConfigEvalCode(
          variant,
          bgSource,
          REDACTED_COMPLETE_DEV_ENV_STATUS,
          "identityAuthManager_getDerivedState()",
          { optionalHostPattern: EXACT_HOST_PERMISSION, permissionGranted: true },
        );
        return Promise.resolve(new Function(exactGrantedDerivedCode)()).then((exactGrantedResult) => {
          assert(exactGrantedResult && exactGrantedResult.ok === true,
            `${variant}: built exact-host granted derived-state must return ok`);
          assertProviderConfigStatusHasExactPermissionReadiness(
            `${variant} built exact-host permission granted`,
            exactGrantedResult.derivedState?.providerConfigStatus,
            true,
          );
        });
      });
    });
  });
}

function assertProviderSourceSafe() {
  const source = read(PROVIDER_SOURCE_REL);
  assert(source.includes(`from "${SDK_PACKAGE_NAME}"`),
    "provider source must continue importing the approved provider SDK only in the background-owned bundle entry");
  assert(source.includes('typeof ProviderSdk.createClient === "function"'),
    "provider source may inspect createClient only as metadata");
  assert(source.includes('const SMOKE_PROVIDER_URL = "https://h2o-provider-client-smoke.invalid"'),
    "provider source must use reserved .invalid smoke URL");
  assert(source.includes('const SMOKE_PUBLIC_CLIENT = "provider-client-smoke"'),
    "provider source must use non-token smoke public client");
  assert(source.includes("function runClientSmoke()"),
    "provider source must expose a named lazy runClientSmoke function");
  assert(source.includes("function guardedSmokeFetch()"),
    "provider source must use a local guarded fetch only inside the smoke path");
  assert(source.includes("fetch: guardedSmokeFetch"),
    "provider source must pass guarded fetch to createClient");
  assert(source.includes("function runRealConfigClientSmoke(config)"),
    "provider source must expose a named lazy real-config smoke function");
  assert(source.includes("function guardedRealConfigFetch()"),
    "provider source must use a local guarded fetch inside the real-config smoke path");
  assert(source.includes("fetch: guardedRealConfigFetch"),
    "provider source must pass guarded fetch to real-config createClient");
  assert(source.includes("async function requestEmailOtp(config, input = {})"),
    "provider source must expose a named request-email-OTP helper");
  assert(source.includes("client.auth.signInWithOtp"),
    "signInWithOtp must be confined to the provider request-email-OTP helper");
  assert(source.includes("async function verifyEmailOtp(config, input = {})"),
    "provider source must expose a named verify-email-OTP helper");
  assert(source.includes("client.auth.verifyOtp"),
    "verifyOtp must be confined to the provider verify-email-OTP helper");
  assert(source.includes("async function verifySignupEmailCode(config, input = {})"),
    "provider source must expose a named signup confirmation verify helper");
  assert(source.includes('client.auth.verifyOtp({ email, token: code, type: "email" })'),
    "signup confirmation must verify email OTP codes with type email");
  assert(source.includes("async function signUpWithPassword(config, input = {})"),
    "provider source must expose a named password sign-up helper");
  assert(source.includes("client.auth.signUp"),
    "signUp must be confined to the provider password sign-up helper");
  assert(source.includes("async function resendSignupConfirmation(config, input = {})"),
    "provider source must expose a named signup confirmation resend helper");
  assert(source.includes('client.auth.resend({ type: "signup", email })'),
    "signup confirmation resend must be confined to the provider helper");
  assert(source.includes("async function signInWithPassword(config, input = {})"),
    "provider source must expose a named password sign-in helper");
  assert(source.includes("client.auth.signInWithPassword"),
    "signInWithPassword must be confined to the provider password sign-in helper");
  assert(source.includes("async function requestPasswordReset(config, input = {})"),
    "provider source must expose a named password reset request helper");
  assert(source.includes("client.auth.resetPasswordForEmail"),
    "resetPasswordForEmail must be confined to the provider password reset helper");
  assert(source.includes("async function updatePasswordAfterRecovery(config, input = {})"),
    "provider source must expose a named password recovery update helper");
  assert(source.includes("client.auth.updateUser"),
    "updateUser must be confined to approved provider password helpers");
  assert(source.includes("async function changePassword(config, input = {})"),
    "provider source must expose a named signed-in password change helper");
  assert(source.includes("current_password: currentPassword"),
    "signed-in password change must use installed SDK current_password field");
  assert(!source.includes("currentPassword:"),
    "signed-in password change must not use unsupported currentPassword field casing");
  assert(source.includes("async function refreshProviderSession(config, refreshTokenInput)"),
    "provider source must expose a named refresh provider session helper");
  assert(source.includes("client.auth.refreshSession"),
    "refreshSession must be confined to the provider refresh helper");
  assert(source.includes("function normalizeProviderSessionForInternalStorage("),
    "provider source must normalize verify/refresh raw sessions into the hydration-compatible internal storage shape");
  assert(source.includes("normalizeProviderSessionForInternalStorage(rawSession, user, email)"),
    "verify helper must store a raw session shape that includes the verified user/email");
  assert(source.includes("normalizeProviderSessionForInternalStorage(rawSession, user)"),
    "refresh helper must store the same raw session shape used by verify");
  assert(source.includes("rawSession: providerSession"),
    "provider helpers must return the normalized raw session for background-only storage");
  assert(source.includes("async function signOutProviderSession(config, input = {})"),
    "provider source must expose a named sign-out provider session helper");
  assert(source.includes("client.auth.signOut"),
    "signOut must be confined to the provider sign-out helper");
  assert(source.includes('client.auth.signOut({ scope: "local" })'),
    "provider signOut must use local scope explicitly");
  assert(!/scope\s*:\s*["']global["']/.test(source),
    "provider signOut must never use global scope");
  assert(!/\bsetSession\s*\(/.test(source),
    "provider signOut must not use setSession");
  assert(source.includes("createEphemeralProviderStorage"),
    "provider signOut must use helper-local ephemeral storage");
  assert(source.includes("persistSession: true"),
    "provider signOut helper may use SDK persistence only with helper-local ephemeral storage");
  assert(source.includes("async function completeOnboarding(config, input = {})"),
    "provider source must expose a named complete-onboarding RPC helper");
  assert(source.includes('client.rpc("complete_onboarding"'),
    "complete_onboarding RPC call must be confined to the provider helper");
  assert(source.includes("async function updateIdentityProfile(config, input = {})"),
    "provider source must expose a named profile update RPC helper");
  assert(source.includes('client.rpc("update_identity_profile"'),
    "update_identity_profile RPC call must be confined to the provider helper");
  assert(source.includes("async function renameIdentityWorkspace(config, input = {})"),
    "provider source must expose a named workspace rename RPC helper");
  assert(source.includes('client.rpc("rename_identity_workspace"'),
    "rename_identity_workspace RPC call must be confined to the provider helper");
  assert(source.includes("async function loadIdentityState(config, input = {})"),
    "provider source must expose a named load-identity-state RPC helper");
  assert(source.includes('client.rpc("load_identity_state"'),
    "load_identity_state RPC call must be confined to the provider helper");
  assert(source.includes("async function markPasswordSetupCompleted(config, input = {})"),
    "provider source must expose a named mark-password-setup RPC helper");
  assert(source.includes('client.rpc("mark_password_setup_completed"'),
    "mark_password_setup_completed RPC call must be confined to the provider helper");
  assert(source.includes("Authorization: `Bearer ${accessToken}`"),
    "complete_onboarding helper must attach only the current access token as a request header");
  assert(!/\.from\s*\(/.test(source),
    "provider source must not use direct profile/workspace table access");
  const createClientIndices = [...source.matchAll(/ProviderSdk\.createClient\s*\(/g)].map((match) => match.index);
  const helperOrder = [
    ["runClientSmoke", "function runClientSmoke()"],
    ["runRealConfigClientSmoke", "function runRealConfigClientSmoke(config)"],
    ["requestEmailOtp", "async function requestEmailOtp(config, input = {})"],
    ["verifyEmailOtp", "async function verifyEmailOtp(config, input = {})"],
    ["verifySignupEmailCode", "async function verifySignupEmailCode(config, input = {})"],
    ["signUpWithPassword", "async function signUpWithPassword(config, input = {})"],
    ["resendSignupConfirmation", "async function resendSignupConfirmation(config, input = {})"],
    ["signInWithPassword", "async function signInWithPassword(config, input = {})"],
    ["requestPasswordReset", "async function requestPasswordReset(config, input = {})"],
    ["updatePasswordAfterRecovery", "async function updatePasswordAfterRecovery(config, input = {})"],
    ["changePassword", "async function changePassword(config, input = {})"],
    ["beginOAuthSignIn", "async function beginOAuthSignIn(config, input = {})"],
    ["completeOAuthSignIn", "async function completeOAuthSignIn(config, input = {})"],
    ["refreshProviderSession", "async function refreshProviderSession(config, refreshTokenInput)"],
    ["signOutProviderSession", "async function signOutProviderSession(config, input = {})"],
    ["completeOnboarding", "async function completeOnboarding(config, input = {})"],
    ["updateIdentityProfile", "async function updateIdentityProfile(config, input = {})"],
    ["renameIdentityWorkspace", "async function renameIdentityWorkspace(config, input = {})"],
    ["loadIdentityState", "async function loadIdentityState(config, input = {})"],
    ["registerDeviceSession", "async function registerDeviceSession(config, accessToken, input = {})"],
    ["markPasswordSetupCompleted", "async function markPasswordSetupCompleted(config, input = {})"],
    ["markOAuthCredentialCompleted", "async function markOAuthCredentialCompleted(config, input = {})"],
  ];
  assert(createClientIndices.length === helperOrder.length,
    "provider source may call ProviderSdk.createClient only in approved provider helpers");
  const helperIndices = helperOrder.map(([name, marker]) => {
    const index = source.indexOf(marker);
    assert(index >= 0, `provider source helper marker missing: ${name}`);
    return { name, index };
  });
  for (let i = 0; i < helperIndices.length; i += 1) {
    const helper = helperIndices[i];
    const next = helperIndices[i + 1];
    assert(createClientIndices[i] > helper.index,
      `ProviderSdk.createClient must be inside ${helper.name}`);
    if (next) {
      assert(createClientIndices[i] < next.index,
        `ProviderSdk.createClient must be confined to ${helper.name}`);
    }
  }
  const verifyEmailOtpIndex = source.indexOf("async function verifyEmailOtp(config, input = {})");
  const verifySignupEmailCodeIndex = source.indexOf("async function verifySignupEmailCode(config, input = {})");
  const signUpWithPasswordIndex = source.indexOf("async function signUpWithPassword(config, input = {})");
  const resendSignupConfirmationIndex = source.indexOf("async function resendSignupConfirmation(config, input = {})");
  const signInWithPasswordIndex = source.indexOf("async function signInWithPassword(config, input = {})");
  const requestPasswordResetIndex = source.indexOf("async function requestPasswordReset(config, input = {})");
  const updatePasswordAfterRecoveryIndex = source.indexOf("async function updatePasswordAfterRecovery(config, input = {})");
  const changePasswordIndex = source.indexOf("async function changePassword(config, input = {})");
  const beginOAuthSignInIndex = source.indexOf("async function beginOAuthSignIn(config, input = {})");
  const completeOAuthSignInIndex = source.indexOf("async function completeOAuthSignIn(config, input = {})");
  const refreshProviderSessionIndex = source.indexOf("async function refreshProviderSession(config, refreshTokenInput)");
  const signOutProviderSessionIndex = source.indexOf("async function signOutProviderSession(config, input = {})");
  const completeOnboardingIndex = source.indexOf("async function completeOnboarding(config, input = {})");
  const updateIdentityProfileIndex = source.indexOf("async function updateIdentityProfile(config, input = {})");
  const renameIdentityWorkspaceIndex = source.indexOf("async function renameIdentityWorkspace(config, input = {})");
  const loadIdentityStateIndex = source.indexOf("async function loadIdentityState(config, input = {})");
  const markPasswordSetupCompletedIndex = source.indexOf("async function markPasswordSetupCompleted(config, input = {})");
  const markOAuthCredentialCompletedIndex = source.indexOf("async function markOAuthCredentialCompleted(config, input = {})");
  const registerDeviceSessionIndex = source.indexOf("async function registerDeviceSession(config, accessToken, input = {})");
  const verifyOtpMatches = source.match(/\bverifyOtp\s*\(/g) || [];
  const verifyOtpCall = 'client.auth.verifyOtp({ email, token: code, type: "email" })';
  assert(verifyOtpMatches.length === 2 &&
    source.indexOf(verifyOtpCall, verifyEmailOtpIndex) > verifyEmailOtpIndex &&
    source.indexOf(verifyOtpCall, verifySignupEmailCodeIndex) > verifySignupEmailCodeIndex,
    "verifyOtp calls must appear only inside verifyEmailOtp and verifySignupEmailCode");
  const signUpMatches = source.match(/\bsignUp\s*\(/g) || [];
  assert(signUpMatches.length === 1 && source.indexOf("client.auth.signUp") > signUpWithPasswordIndex,
    "signUp call must appear exactly once inside signUpWithPassword");
  const resendMatches = source.match(/\bclient\.auth\.resend\s*\(/g) || [];
  assert(resendMatches.length === 1 && source.indexOf("client.auth.resend") > resendSignupConfirmationIndex,
    "auth.resend call must appear exactly once inside resendSignupConfirmation");
  const signInWithPasswordMatches = source.match(/\bclient\.auth\.signInWithPassword\s*\(/g) || [];
  assert(signInWithPasswordMatches.length === 1 && source.indexOf("client.auth.signInWithPassword") > signInWithPasswordIndex,
    "signInWithPassword call must appear exactly once inside signInWithPassword");
  const resetPasswordMatches = source.match(/\bresetPasswordForEmail\s*\(/g) || [];
  assert(resetPasswordMatches.length === 1 && source.indexOf("client.auth.resetPasswordForEmail") > requestPasswordResetIndex,
    "resetPasswordForEmail call must appear exactly once inside requestPasswordReset");
  const updateUserMatches = source.match(/\bupdateUser\s*\(/g) || [];
  const recoveryUpdateUserIndex = source.indexOf("client.auth.updateUser({ password })");
  const accountChangeUpdateUserIndex = source.indexOf("client.auth.updateUser({", changePasswordIndex);
  assert(updateUserMatches.length === 2 &&
      recoveryUpdateUserIndex > updatePasswordAfterRecoveryIndex &&
      recoveryUpdateUserIndex < changePasswordIndex &&
      accountChangeUpdateUserIndex > changePasswordIndex,
    "updateUser calls must appear only inside updatePasswordAfterRecovery and changePassword");
  const signInWithOAuthMatches = source.match(/\bsignInWithOAuth\s*\(/g) || [];
  assert(signInWithOAuthMatches.length === 1 && source.indexOf("client.auth.signInWithOAuth") > beginOAuthSignInIndex,
    "signInWithOAuth call must appear exactly once inside beginOAuthSignIn");
  const exchangeCodeMatches = source.match(/\bexchangeCodeForSession\s*\(/g) || [];
  assert(exchangeCodeMatches.length === 1 && source.indexOf("client.auth.exchangeCodeForSession") > completeOAuthSignInIndex,
    "exchangeCodeForSession call must appear exactly once inside completeOAuthSignIn");
  const refreshSessionMatches = source.match(/\brefreshSession\s*\(/g) || [];
  assert(refreshSessionMatches.length === 1 && source.indexOf("client.auth.refreshSession") > refreshProviderSessionIndex,
    "refreshSession call must appear exactly once inside refreshProviderSession");
  const signOutMatches = source.match(/\bsignOut\s*\(/g) || [];
  assert(signOutMatches.length === 1 && source.indexOf("client.auth.signOut") > signOutProviderSessionIndex,
    "signOut call must appear exactly once inside signOutProviderSession");
  const rpcMatches = source.match(/\.rpc\s*\(/g) || [];
  assert(rpcMatches.length === 7
      && source.indexOf('client.rpc("complete_onboarding"') > completeOnboardingIndex
      && source.indexOf('client.rpc("update_identity_profile"') > updateIdentityProfileIndex
      && source.indexOf('client.rpc("rename_identity_workspace"') > renameIdentityWorkspaceIndex
      && source.indexOf('client.rpc("load_identity_state"') > loadIdentityStateIndex
      && source.indexOf('client.rpc("mark_password_setup_completed"') > markPasswordSetupCompletedIndex
      && source.indexOf('client.rpc("mark_oauth_credential_completed"') > markOAuthCredentialCompletedIndex
      && source.indexOf('client.rpc("register_device_session"') > registerDeviceSessionIndex,
    "RPC calls must appear exactly once inside approved identity provider RPC helpers");
  assert(!/\bglobalThis\.fetch\s*=|\bself\.fetch\s*=|\bwindow\.fetch\s*=/.test(source),
    "provider source must not patch global fetch");
  assertNoPatterns(PROVIDER_SOURCE_REL, source, PROVIDER_SOURCE_FORBIDDEN_PATTERNS);
}

function assertProviderBundleRenameApplied() {
  const buildBundleSource = read("tools/product/identity/build-identity-provider-bundle.mjs");
  const backgroundSource = read(BACKGROUND_SOURCE_REL);
  assert(buildBundleSource.includes(PROVIDER_BUNDLE_REL),
    "provider bundle build helper must emit renamed Supabase bundle path");
  assert(buildBundleSource.includes("identity-provider-supabase.entry.mjs"),
    "provider bundle build helper must use renamed Supabase entry");
  assert(!existsAbs(abs(`tools/product/identity/${LEGACY_PROVIDER_BUNDLE_NAME}.entry.mjs`)),
    "legacy provider bundle source entry must be absent");
  assert(backgroundSource.includes(PROVIDER_BUNDLE_REL),
    "background default provider bundle path must use renamed Supabase bundle");
  assert(!backgroundSource.includes(LEGACY_PROVIDER_BUNDLE_REL),
    "background source must not reference legacy provider bundle path");
  assert(!backgroundSource.includes(LEGACY_PROVIDER_BUNDLE_NAME),
    "background source must not reference legacy provider bundle name");
}

function assertConditionalProviderBundleLoadingGate() {
  const source = read(BACKGROUND_SOURCE_REL);
  assert(source.includes("identityProviderBundle_shouldLoadProbe"),
    "background must gate provider bundle load on redacted injected provider config");
  assert(source.includes("identityProviderBundle_ensureProbeLoaded"),
    "background must lazy-load provider bundle only from the safe probe status path");
  assert(source.includes("function identityProviderBundle_bootstrapConfiguredProbe("),
    "background must conditionally bootstrap provider-backed imports during service-worker startup");
  assert(source.includes("identityProviderBundle_bootstrapConfiguredProbe();"),
    "background must run the conditional provider-backed bootstrap at service-worker startup");
  assert(source.includes("identityProviderBundlePrivateConfigCache"),
    "background must cache sanitized private config after startup import");
  assert(source.includes("privateConfigErrorCode"),
    "background must expose a safe private config load diagnostic");
  assert(source.includes("bundle_probe_import_failed"),
    "background must expose a safe provider bundle import failure diagnostic");
  assert(source.includes('kind: "skipped"'),
    "background must expose skipped bundle diagnostic for inactive config");
  assert(source.includes('phase: "3.0X"'),
    "background must expose Phase 3.0X skipped bundle diagnostic");
  assert(source.includes('skipReason: "provider_config_inactive"'),
    "background must expose inactive provider config skip reason");
  assert(!source.includes("}\n\nidentityProviderBundle_loadProbe();\n\nconst MODE_LIVE_FIRST"),
    "background must not load the provider bundle unconditionally at service-worker boot");
}

// Closed two-owner model for chrome.permissions in the generated background.
// Factored so the identical rule can be replayed against a synthetic background
// below; it asserts rather than returns, so a violation is a hard failure in
// both the real and the synthetic run.
const PERMISSION_CONTAINS_OWNERS_3_0Q = Object.freeze([
  "pageMetadataPermissionContains",
  "identityProviderPermission_containsExactHost",
]);
const PERMISSION_REQUEST_OWNERS_3_0Q = Object.freeze([
  "identityProviderPermission_requestExactHost",
]);

function assertPermissionOwnership3_0Q(source) {
  const containsOwnerBodies = PERMISSION_CONTAINS_OWNERS_3_0Q.map((name) => {
    const body = extractFunction(source, name);
    assert(body.includes("chrome.permissions.contains"),
      `chrome.permissions.contains must appear in its legitimate owner ${name}`);
    return body;
  });
  const requestOwnerBodies = PERMISSION_REQUEST_OWNERS_3_0Q.map((name) => {
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

// Durable negative control. A synthetic THIRD chrome.permissions.contains owner
// must be rejected by the very same rule that admits the real source. In-memory
// only: no fixture is written and no background source is touched.
function assertThirdPermissionOwnerRejected3_0Q(source) {
  const syntheticThirdContainsOwner = [
    "function syntheticUnauthorizedPermissionContains(originPattern) {",
    "  return new Promise((resolve) => {",
    "    chrome.permissions.contains({ origins: [originPattern] }, (granted) => {",
    "      resolve(granted === true);",
    "    });",
    "  });",
    "}",
    "",
  ].join("\n") + source;
  let rejected = false;
  try {
    assertPermissionOwnership3_0Q(syntheticThirdContainsOwner);
  } catch (err) {
    rejected = /chrome\.permissions\.contains must not appear outside/.test(
      String(err && err.message),
    );
  }
  assert(rejected,
    "negative control: a third unauthorized chrome.permissions.contains owner must fail the ownership check");
}

function assertBackgroundPermissionReadinessSafe() {
  const source = read(BACKGROUND_SOURCE_REL);
  assert(source.includes("IDENTITY_PROVIDER_PERMISSION_READINESS_DEFERRED"),
    "background must declare deferred provider permission readiness");
  assert(source.includes('permissionRequired: "deferred"'),
    "background permissionRequired must be deferred");
  assert(source.includes("permissionReady: false"),
    "background permissionReady must be false");
  assert(source.includes('permissionSource: "deferred_until_project_host"'),
    "background permissionSource must be deferred_until_project_host");
  assert(source.includes('permissionHostKind: "none"'),
    "background permissionHostKind must be none");
  assert(source.includes('permissionStatus: "deferred"'),
    "background permissionStatus must be deferred");
  assert(source.includes("permissionErrorCode: null"),
    "background permissionErrorCode must be null");
  assert(source.includes("networkReady: false"),
    "background networkReady must be false");
  assert(source.includes('IDENTITY_PROVIDER_PHASE_NETWORK_ENABLED = IDENTITY_PROVIDER_PHASE_NETWORK === "request_otp"'),
    "background must enable provider network only from the request_otp build phase flag");
  assert(source.includes("identity/network-not-enabled"),
    "background must expose a safe network-not-enabled request OTP error");
  assert(source.includes("function identityProviderNetwork_getReadiness("),
    "background must compute provider network readiness through a phase gate helper");
  assert(source.includes('networkStatus: networkReady ? "ready" : "blocked"'),
    "background must expose safe networkStatus diagnostics");
  assert(source.includes('phase_not_enabled'),
    "background must expose phase_not_enabled network block reason");
  assert(source.includes("function identityProviderPermission_getReadiness("),
    "background must expose permission readiness through a helper");
  assert(source.includes("function identityProviderPermission_containsExactHost("),
    "background must check exact optional host permission through a named helper");
  assert(source.includes("function identityProviderPermission_requestExactHost("),
    "background must define the internal exact-host request helper");
  // The background legitimately owns TWO chrome.permissions.contains callers:
  //   1. pageMetadataPermissionContains               — page-metadata origin probe
  //   2. identityProviderPermission_containsExactHost — identity exact-host readiness
  // and exactly ONE chrome.permissions.request caller:
  //   3. identityProviderPermission_requestExactHost  — internal exact-host request
  // The allowlist is explicit and closed: owner helpers are enumerated by name,
  // never wildcarded, so a THIRD unauthorized caller still fails this gate.
  assert(source.includes("function pageMetadataPermissionContains("),
    "background must probe page-metadata origins through a named helper");
  assertPermissionOwnership3_0Q(source);
  assert(source.includes("function identityProviderPermission_isPopupSender("),
    "background must sender-gate the dev-only provider permission action");
  assert(source.includes('chrome.runtime.getURL("popup.html")'),
    "provider permission action must be restricted to extension popup sender URLs");
  assert(source.includes("function identityProviderPermission_requestExactHostFromPopup("),
    "background must route popup permission grants through a named helper");
  assert(source.includes(PROVIDER_PERMISSION_ACTION),
    "background must handle the popup-only provider permission grant action");
  assert(!/\bsignInWithOtp\s*\(/.test(source),
    "background source must not contain a direct signInWithOtp call");
  assert(!/\bverifyOtp\s*\(/.test(source),
    "background source must not contain a direct verifyOtp call");
  assertNoPatterns(BACKGROUND_SOURCE_REL, source, PROVIDER_PROBE_AUTH_CALL_PATTERNS);
  assertThirdPermissionOwnerRejected3_0Q(source);
}

function assertPopupProviderPermissionActionScoped() {
  const backgroundSource = read(BACKGROUND_SOURCE_REL);
  const popupJsSource = read("tools/product/extensions/chatgpt/chrome/popup/chrome-live-popup-js.mjs");
  const popupHtmlSource = read("tools/product/extensions/chatgpt/chrome/popup/chrome-live-popup-html.mjs");
  const loaderSource = read("tools/product/extensions/chatgpt/chrome/chrome-live-loader.mjs");

  assert(backgroundSource.includes(PROVIDER_PERMISSION_ACTION),
    "background must own the provider permission request action");
  assert(popupJsSource.includes(PROVIDER_PERMISSION_ACTION),
    "Dev Controls popup JS must call the provider permission request action");
  assert(popupHtmlSource.includes("Grant Supabase Permission"),
    "Dev Controls popup must expose the explicit permission grant button");
  assert(!loaderSource.includes(PROVIDER_PERMISSION_ACTION),
    "loader must not allow-list or expose the provider permission request action");
  assert(!popupJsSource.includes("signInWithOtp"),
    "popup JS must not call provider OTP APIs");
  assert(!popupHtmlSource.includes("signInWithOtp"),
    "popup HTML must not contain provider OTP APIs");
}

function assertVerifyEmailOtpSessionBoundarySafe() {
  const backgroundSource = read(BACKGROUND_SOURCE_REL);
  const providerSource = read(PROVIDER_SOURCE_REL);
  const loaderSource = read("tools/product/extensions/chatgpt/chrome/chrome-live-loader.mjs");
  const identitySource = read("src-runtime-base/0D4a.⬛️🔐 Identity Core 🔐.js");

  assertOtpCodeNormalizer(PROVIDER_SOURCE_REL, providerSource, "normalizeProviderOtpCode");
  assertOtpCodeNormalizer(BACKGROUND_SOURCE_REL, backgroundSource, "identityProviderVerify_normalizeCode");
  assert(backgroundSource.includes('const IDENTITY_PROVIDER_SESSION_KEY = "h2oIdentityProviderSessionV1"'),
    "background must define the provider session key");
  assert(backgroundSource.includes("function providerSessionStorageStrict("),
    "background must use a strict provider session storage helper");
  assert(backgroundSource.includes("chrome.storage.session"),
    "provider session helper must target chrome.storage.session");
  assert(backgroundSource.includes("function providerSessionGet("),
    "background must read raw provider session only through a strict providerSessionGet helper");
  const providerSessionGetBlock = extractFunction(backgroundSource, "providerSessionGet");
  assert(providerSessionGetBlock.includes("providerSessionStorageStrict()"),
    "providerSessionGet must use the strict chrome.storage.session-only helper");
  assert(!/chrome\.storage\.local|storageSessionArea\(/.test(providerSessionGetBlock),
    "providerSessionGet must not fall back to chrome.storage.local or generic storage session helpers");
  for (const helperName of ["providerSessionSet", "providerSessionRemove"]) {
    const helperBlock = extractFunction(backgroundSource, helperName);
    assert(helperBlock.includes("providerSessionStorageStrict()"),
      `${helperName} must use the strict chrome.storage.session-only helper`);
    assert(!/chrome\.storage\.local|storageSessionArea\(/.test(helperBlock),
      `${helperName} must not fall back to chrome.storage.local or generic storage session helpers`);
  }
  assert(!/IDENTITY_PROVIDER_SESSION_KEY[\s\S]{0,240}chrome\.storage\.local/.test(backgroundSource),
    "provider session key must not be written through chrome.storage.local");
  assert(backgroundSource.includes("const IDENTITY_PROVIDER_SESSION_EXPIRY_SKEW_MS = 60 * 1000"),
    "background must use a conservative 60s provider session expiry skew");
  assert(backgroundSource.includes("const IDENTITY_PROVIDER_SESSION_REFRESH_WINDOW_MS = 5 * 60 * 1000"),
    "background must use a lazy 5-minute provider session refresh window");
  assert(backgroundSource.includes("let identityProviderSessionRefreshPromise = null"),
    "background must singleflight concurrent provider refresh attempts");
  assert(backgroundSource.includes("function identityProviderSession_extractSafeRuntime("),
    "background must derive safe public runtime from raw provider session");
  assert(backgroundSource.includes("function identityProviderSession_unwrapStoredSession("),
    "background must unwrap direct/wrapped provider session shapes from chrome.storage.session");
  assert(backgroundSource.includes("function identityProviderSession_normalizeStoredSession("),
    "background must normalize stored sessions before verify/refresh/signOut/onboarding reuse");
  assert(backgroundSource.includes("function identityProviderSession_makeRpcSessionForOnboarding("),
    "complete-onboarding must compact the stored provider session into an explicit access_token RPC session");
  assert(backgroundSource.includes("const accessToken = identityProviderSession_accessToken(src);"),
    "complete-onboarding RPC session compactor must require a usable access token");
  assert(backgroundSource.includes("/[\\\\s<>]/.test(token)"),
    "background generator must double-escape whitespace token validators before template emission");
  assert(backgroundSource.includes("src.access_token || src.accessToken"),
    "complete-onboarding session reader must accept the stored verify shape including camel-case accessToken fallback");
  assert(backgroundSource.includes("async function identityProviderSession_readRpcSessionForOnboarding("),
    "background must read complete-onboarding RPC session through a dedicated chrome.storage.session helper");
  const onboardingSessionHelper = extractFunction(backgroundSource, "identityProviderSession_readRpcSessionForOnboarding");
  assert(onboardingSessionHelper.includes("identityProviderSession_readStoredValueForOnboarding()"),
    "complete-onboarding RPC session helper must read the exact stored provider session key before normalization");
  assert(onboardingSessionHelper.includes("identityProviderSession_makeRpcSessionForOnboarding(rawSession)"),
    "complete-onboarding RPC session helper must pass the provider helper an explicit access_token RPC session");
  assert(!onboardingSessionHelper.includes("identityProviderSession_extractSafeRuntime"),
    "complete-onboarding RPC session helper must not require the public hydration/session shape");
  assert(onboardingSessionHelper.indexOf("identityProviderSession_refreshToken") < 0
      || onboardingSessionHelper.indexOf("identityProviderSession_refreshToken") > onboardingSessionHelper.indexOf("identityProviderSession_isExpired"),
    "complete-onboarding RPC session helper must not require a refresh token unless the access token is expired");
  assert(backgroundSource.includes("async function identityProviderSession_hydrateOnWake("),
    "background must hydrate safe state from chrome.storage.session on wake");
  assert(backgroundSource.includes('identityProviderSession_hydrateOnWake({ reason: "get-snapshot", broadcast: true, allowRefresh: true })'),
    "get-snapshot must run lazy provider session refresh/hydration before returning public state");
  assert(backgroundSource.includes('identityProviderSession_hydrateOnWake({ reason: "get-derived-state", broadcast: true, allowRefresh: true })'),
    "get-derived-state must run lazy provider session refresh/hydration before returning public state");
  assert(backgroundSource.includes('identityProviderSession_hydrateOnWake({ reason: "set-snapshot", broadcast: false, allowRefresh: false })'),
    "set-snapshot must not let stale page/local snapshots override a valid provider session");
  assert(backgroundSource.includes('reason: "refresh-session"'),
    "identity:refresh-session must route through the lazy provider refresh/hydration path");
  assert(backgroundSource.includes("async function identityProviderSession_refreshRaw("),
    "background must refresh raw provider session through a named helper");
  assert(backgroundSource.includes("identityProviderBundle_refreshProviderSession({ refreshToken })"),
    "background must call provider refresh only through the provider bundle helper");
  assert(backgroundSource.includes("providerSessionSet({ [IDENTITY_PROVIDER_SESSION_KEY]: providerResult.rawSession })"),
    "successful refresh must replace the whole raw provider session in chrome.storage.session");
  assert(backgroundSource.includes("identityProviderSession_refreshIsDue(rawSession)"),
    "background must refresh lazily only when the stored session is near expiry");
  assert(backgroundSource.includes('hydrated.errorCode === "identity/session-expired"'),
    "set-snapshot must not reintroduce stale page/local snapshots after expired provider session cleanup");
  assert(backgroundSource.includes('status === "sync_ready" || status === "profile_ready" ? "verified_no_profile" : status'),
    "provider-backed snapshot conversion must clamp local ready snapshots back to verified_no_profile");
  assert(backgroundSource.includes('providerKind: "supabase"'),
    "hydrated provider-backed state must preserve safe supabase providerKind");
  assert(backgroundSource.includes("profile: null") && backgroundSource.includes("workspace: null"),
    "hydrated provider-backed state must not preserve local profile/workspace fields");
  assert(backgroundSource.includes('identityProviderSession_scheduleWakeHydration("boot")'),
    "background boot must schedule local provider session hydration");
  assert(backgroundSource.includes("allowRefresh: false }).catch"),
    "background boot/startup hydration must not perform provider network refresh");
  assert(backgroundSource.includes('identityProviderSession_scheduleWakeHydration("startup")'),
    "runtime startup must schedule local provider session hydration");
  assert(backgroundSource.includes("identity/session-expired"),
    "expired provider sessions must be represented by a generic local cleanup code");
  assert(backgroundSource.includes("async function identityProviderBundle_verifyEmailOtp("),
    "background must call provider verify through a named bundle helper");
  assert(backgroundSource.includes("identityProviderBundleProbeState.verifyEmailOtpRunner"),
    "background must capture provider verify runner privately");
  assert(backgroundSource.includes("identityProviderBundleProbeState.verifySignupEmailCodeRunner"),
    "background must capture provider signup confirmation verify runner privately");
  assert(backgroundSource.includes("identityProviderBundleProbeState.signUpWithPasswordRunner"),
    "background must capture provider password sign-up runner privately");
  assert(backgroundSource.includes("identityProviderBundleProbeState.resendSignupConfirmationRunner"),
    "background must capture provider signup confirmation resend runner privately");
  assert(backgroundSource.includes("identityProviderBundleProbeState.signInWithPasswordRunner"),
    "background must capture provider password sign-in runner privately");
  assert(backgroundSource.includes("identityProviderBundleProbeState.requestPasswordResetRunner"),
    "background must capture provider password reset runner privately");
  assert(backgroundSource.includes("identityProviderBundleProbeState.refreshProviderSessionRunner"),
    "background must capture provider refresh runner privately");
  assert(backgroundSource.includes("identityProviderBundleProbeState.signOutProviderSessionRunner"),
    "background must capture provider sign-out runner privately");
  assert(backgroundSource.includes("identityProviderBundleProbeState.completeOnboardingRunner"),
    "background must capture complete-onboarding runner privately");
  assert(backgroundSource.includes("identityProviderBundleProbeState.loadIdentityStateRunner"),
    "background must capture load-identity-state runner privately");
  assert(backgroundSource.includes("identityProviderBundleProbeState.markPasswordSetupCompletedRunner"),
    "background must capture mark-password-setup runner privately");
  assert(backgroundSource.includes("async function identityProviderBundle_signOutProviderSession("),
    "background must call provider signOut through a named bundle helper");
  assert(backgroundSource.includes("identityProviderBundle_signOutProviderSession({ rawSession })"),
    "background must pass raw session to provider signOut only through the private bundle helper");
  assert(backgroundSource.includes("async function identityProviderBundle_completeOnboarding("),
    "background must call complete_onboarding only through a named provider bundle helper");
  assert(backgroundSource.includes("identityProviderBundle_completeOnboarding({"),
    "background complete-onboarding path must route through the provider bundle helper");
  assert(backgroundSource.includes("async function identityProviderBundle_loadIdentityState("),
    "background must call load_identity_state only through a named provider bundle helper");
  assert(backgroundSource.includes("async function identityProviderBundle_markPasswordSetupCompleted("),
    "background must call mark_password_setup_completed only through a named provider bundle helper");
  assert(backgroundSource.includes("identityProviderBundle_loadIdentityState({ rawSession: rpcSession })"),
    "background cloud restore path must pass only the compact raw session to the load_identity_state helper");
  assert(backgroundSource.includes("async function identityProviderSession_tryCloudIdentityRestore("),
    "background wake hydration must include a read-only cloud identity restore helper");
  assert(backgroundSource.includes("status.providerConfigured !== true")
      && backgroundSource.includes("status.networkReady !== true"),
    "background cloud restore must remain gated on provider config, permission, phase, and network readiness");
  assert(!backgroundSource.includes('reason: "wake-complete-onboarding"'),
    "background wake restore must not call complete_onboarding as a restore mechanism");
  assert(backgroundSource.includes("function identityProviderOnboarding_hasProviderSessionStatus("),
    "background complete-onboarding path must use an explicit provider session status helper");
  assert(backgroundSource.includes("function identityProviderOnboarding_sanitizeDiagnostics("),
    "background complete-onboarding path must retain internal safe diagnostics helpers for validation");
  assert(backgroundSource.includes("providerSessionTopLevelKeys"),
    "background complete-onboarding internal diagnostics must include safe top-level key names without values");
  const completeOnboardingManager = extractFunction(backgroundSource, "identityAuthManager_completeOnboarding");
  assert(completeOnboardingManager.indexOf("identityProviderSession_readRpcSessionForOnboarding(rt)")
      < completeOnboardingManager.indexOf("identityProviderOnboarding_hasProviderSessionStatus(latestRt)"),
    "background complete-onboarding path must read a valid raw provider session before considering stale runtime status");
  assert(completeOnboardingManager.includes("identityProviderSession_extractSafeRuntime(rpcSession.rawSession)"),
    "background complete-onboarding path must rebuild safe runtime from a valid raw provider session when runtime is stale");
  assert(!completeOnboardingManager.includes('return identityProviderOnboarding_failure("identity/onboarding-session-missing");'),
    "background complete-onboarding provider branch must route session-missing through the production-safe failure helper");
  assert(backgroundSource.includes('reason: "complete-onboarding-expired-session"'),
    "background complete-onboarding path must refresh only when the stored RPC access token is expired");
  assert(backgroundSource.includes("identityProviderOnboarding_sanitizeProviderResult"),
    "background must sanitize complete_onboarding provider results before public state");
  assert(backgroundSource.includes("identityProviderCloudLoad_sanitizeProviderResult"),
    "background must sanitize load_identity_state provider results before public state");
  assert(backgroundSource.includes("identityProviderCredentialState_markCompleteForSession"),
    "background must mark password setup completion only through the provider RPC helper");
  assert(backgroundSource.includes("async function identityProviderSignOut_tryBestEffort("),
    "background must isolate best-effort provider signOut from local cleanup");
  assert(backgroundSource.includes("async function identityAuthManager_clearSignOutLocalState("),
    "background must perform sign-out local cleanup through a dedicated helper");
  assert(backgroundSource.includes("finally")
      && backgroundSource.includes("const cleanup = await identityAuthManager_clearSignOutLocalState()")
      && backgroundSource.includes("localCleanupOk = cleanup && cleanup.ok === true"),
    "background sign-out must run local cleanup in finally");
  assert(backgroundSource.includes('errorCode: "identity/sign-out-failed"'),
    "background must expose only a generic local sign-out failure code");
  assert(backgroundSource.includes("identity/email-mismatch"),
    "background must enforce pending-email mismatch errors");
  assert(backgroundSource.includes("identity/invalid-otp-code"),
    "background must validate OTP code before provider verify");
  assert(backgroundSource.includes("providerSessionSet({ [IDENTITY_PROVIDER_SESSION_KEY]"),
    "background must store raw provider session only through providerSessionSet");
  assert(backgroundSource.includes("identityProviderSession_storeRaw(providerVerify.providerResult)"),
    "verify success path must store the provider result raw session before publishing verified state");
  assert(read(PROVIDER_SOURCE_REL).includes("normalizeProviderSessionForInternalStorage(rawSession, user, email)"),
    "verify success path must provide complete raw session shape for later hydration/onboarding reads");
  assert(backgroundSource.includes("providerSessionRemove([IDENTITY_PROVIDER_SESSION_KEY])"),
    "background sign-out must clear provider session locally");
  assert(!/\bverifyOtp\s*\(/.test(backgroundSource),
    "background must not contain direct provider verifyOtp calls");
  assert(!/\bclient\.auth\.refreshSession\s*\(/.test(backgroundSource),
    "background must not contain direct provider refreshSession calls");
  assert(!/\bclient\.auth\.signOut\s*\(/.test(backgroundSource),
    "background must not contain direct provider signOut calls");
  assert(!/\.rpc\s*\(/.test(backgroundSource),
    "background must not contain direct Supabase RPC calls");
  assert(!/\b(?:client|providerClient|supabase|supabaseClient)\.from\s*\(/.test(backgroundSource),
    "background must not contain direct Supabase table calls");
  assert(!/\bsetSession\s*\(/.test(backgroundSource),
    "background must not contain provider setSession calls");
  assert(!/\bchrome\.alarms\b/.test(backgroundSource),
    "background must not add alarm-based provider refresh in Phase 3.1D");
  assert(!loaderSource.includes("verifyOtp"),
    "loader must not contain provider verifyOtp calls");
  assert(!loaderSource.includes("refreshSession("),
    "loader must not contain provider refreshSession calls");
  assert(!identitySource.includes("verifyOtp"),
    "public Identity Core must not contain provider verifyOtp calls");
}

function assertExactHostPermissionGated() {
  const manifestSource = read(MANIFEST_SOURCE_REL);
  const buildSource = read(BUILD_SOURCE_REL);
  const buildContextSource = read(BUILD_CONTEXT_SOURCE_REL);
  const combined = `${manifestSource}\n${buildSource}\n${buildContextSource}`;
  assert(/\boptional_host_permissions\b/.test(manifestSource),
    "manifest generator must support exact optional_host_permissions in Phase 3.0Z");
  assert(manifestSource.includes("IDENTITY_PROVIDER_OPTIONAL_HOST_PERMISSIONS"),
    "manifest generator must receive exact optional provider host permissions explicitly");
  assert(manifestSource.includes("IDENTITY_PROVIDER_REQUEST_OTP_ARMED"),
    "manifest generator must receive the request_otp armed profile flag explicitly");
  assert(manifestSource.includes("!requestOtpArmed"),
    "manifest generator must suppress wildcard external connectivity for armed request_otp builds");
  assert(buildSource.includes("identityProviderRequestOtpArmed"),
    "build must derive an armed manifest profile from request_otp phase arming");
  assert(buildSource.includes("resolveIdentityProviderExactOptionalHostPattern"),
    "build must derive exact optional host permission from provider project URL");
  assert(buildSource.includes("IDENTITY_PROVIDER_EXACT_SUPABASE_HOST_RE"),
    "build must validate exact Supabase project hosts");
  assert(buildSource.includes("H2O_IDENTITY_PHASE_NETWORK"),
    "build must read the explicit provider network phase flag");
  assert(buildSource.includes("IDENTITY_PROVIDER_PHASE_NETWORK_REQUEST_OTP"),
    "build must name the request_otp provider network phase explicitly");
  assert(buildSource.includes("resolveIdentityProviderPhaseNetwork"),
    "build must validate provider network arming before generating bg.js");
  assert(buildSource.includes("IDENTITY_PROVIDER_PHASE_NETWORK: identityProviderPhaseNetwork"),
    "build must pass only a sanitized provider network phase into bg.js");
  assert(!/https:\/\/\*\.supabase\.co\/\*/i.test(combined),
    "wildcard Supabase optional host permission must not be introduced");
  assert(!/https:\/\/[a-z0-9-]+\.supabase\.co\/\*/i.test(combined),
    "exact Supabase host permission must not be hardcoded in committed sources");
  assert(!/identity:request-provider-permission/.test(combined),
    "Phase 3.0Z must not add a provider permission bridge action");
}

function assertRealDevConfigReadinessGateRedacted() {
  const gitignore = read(GITIGNORE_REL);
  const buildSource = read(BUILD_SOURCE_REL);
  const backgroundSource = read(BACKGROUND_SOURCE_REL);
  const gitignoreLines = gitignore.split(/\r?\n/).map((line) => line.trim());

  assert(gitignoreLines.includes(LOCAL_IDENTITY_PROVIDER_CONFIG_REL),
    "local real dev provider config file must remain ignored");
  assert(buildSource.includes("IDENTITY_PROVIDER_LOCAL_CONFIG_REL") && buildSource.includes("identity-provider.local.json"),
    "build must use the approved local provider config path");
  assert(buildSource.includes("function makeRedactedIdentityProviderStatus("),
    "build must convert dev config to redacted readiness metadata");
  assert(buildSource.includes("function resolveIdentityProviderEnvStatus("),
    "build must keep env config discovery inside the build boundary");
  assert(buildSource.includes("function readIdentityProviderLocalJsonStatus("),
    "build must keep local config discovery inside the build boundary");
  assert(buildSource.includes("function resolveIdentityProviderBuildStatus("),
    "build must keep provider config source precedence explicit");
  assert(buildSource.includes("H2O_IDENTITY_PROVIDER_PROJECT_URL"),
    "build must recognize the provider project env input without serializing its raw value");
  assert(buildSource.includes("H2O_IDENTITY_PROVIDER_PUBLIC_CLIENT"),
    "build must recognize the public client env input without serializing its raw value");
  assert(buildSource.includes("hasProviderProject"),
    "build must reduce provider project input to presence metadata");
  assert(buildSource.includes("hasPublicClient"),
    "build must reduce public client input to presence metadata");
  assert(buildSource.includes("IDENTITY_PROVIDER_CONFIG_STATUS: identityProviderConfigStatus"),
    "build must pass only redacted provider config status into the background generator");
  assert(buildSource.includes("IDENTITY_PROVIDER_PRIVATE_CONFIG_RELATIVE_PATH"),
    "build must define the dev-only private config artifact path");
  assert(buildSource.includes("syncIdentityProviderPrivateConfigToOut"),
    "build must emit/delete the dev-only private config artifact explicitly");
  assert(buildSource.includes('MANIFEST_PROFILE === "production"'),
    "build must disable private config emission for the production profile");
  assert(buildSource.includes("IDENTITY_PROVIDER_PRIVATE_CONFIG_PATH: IDENTITY_PROVIDER_PRIVATE_CONFIG_RELATIVE_PATH"),
    "build must pass only the private config artifact path into the background generator");
  assert(backgroundSource.includes("function sanitizeIdentityProviderConfigStatusForBackground("),
    "background generator must sanitize injected provider config status before serialization");
  assert(backgroundSource.includes("IDENTITY_PROVIDER_CONFIG_STATUS_SAFE"),
    "background generator must serialize only sanitized provider config status");
  assert(backgroundSource.includes("function identityProviderConfig_normalizeInjectedStatus("),
    "background runtime must normalize injected redacted config status");
  assert(backgroundSource.includes('configSource !== "dev_env" && configSource !== "dev_local_file"'),
    "background runtime must accept only approved redacted dev config sources");
  assert(backgroundSource.includes("function identityProviderBundle_loadPrivateConfig("),
    "background runtime must load private config only from the background-owned readiness path");
  assert(backgroundSource.includes("function identityProviderBundle_runRealConfigSmoke("),
    "background runtime must run real-config client readiness only through a private diagnostic path");
  assert(backgroundSource.includes("IDENTITY_PROVIDER_PRIVATE_CONFIG_GLOBAL"),
    "background runtime must use a private config carrier global only inside service-worker scope");
  assert(backgroundSource.includes("delete globalThis[IDENTITY_PROVIDER_PRIVATE_CONFIG_GLOBAL]"),
    "background runtime must clear the private config carrier after reading it");
  assert(!/IDENTITY_PROVIDER_CONFIG_STATUS\s*:\s*process\.env/.test(buildSource),
    "build must not pass raw env objects into generated bg.js");
  assert(!/JSON\.stringify\(process\.env/.test(`${buildSource}\n${backgroundSource}`),
    "build/background must not stringify raw process.env into extension output");
  assertNoPatterns("build/background config readiness plumbing", `${buildSource}\n${backgroundSource}`, REAL_CONFIG_PATTERNS);
}

function assertProviderBundleSafe(variant, bundleSource) {
  assert(bundleSource.includes(PROBE_MARKER), `${variant}: provider bundle probe marker missing`);
  assert(bundleSource.includes("supabase-client-create-smoke"), `${variant}: provider bundle must report 3.0R client smoke kind`);
  assert(bundleSource.includes("3.0R"), `${variant}: provider bundle must report 3.0R phase`);
  assert(bundleSource.includes("https://h2o-provider-client-smoke.invalid"), `${variant}: provider bundle missing reserved .invalid smoke URL`);
  assert(bundleSource.includes("provider-client-smoke"), `${variant}: provider bundle missing non-token smoke public client`);
  assert(bundleSource.includes("realConfigSmoke"), `${variant}: provider bundle missing real-config smoke metadata`);
  assert(bundleSource.includes("runRealConfigClientSmoke"), `${variant}: provider bundle missing lazy real-config smoke runner`);
  assert(bundleSource.includes("identity-provider-real-config-smoke-network-blocked"),
    `${variant}: provider bundle missing guarded real-config fetch error marker`);
  assert(bundleSource.includes("clientCreated:!1") || bundleSource.includes("clientCreated:false"),
    `${variant}: provider bundle must keep clientCreated false`);
  assert(bundleSource.includes("clientCreatedAtImport"), `${variant}: provider bundle missing clientCreatedAtImport metadata`);
  assert(bundleSource.includes("networkEnabled:!1") || bundleSource.includes("networkEnabled:false"),
    `${variant}: provider bundle must keep networkEnabled false`);
  assert(bundleSource.includes("networkObserved"), `${variant}: provider bundle missing networkObserved metadata`);
  assert(bundleSource.includes("authCallsObserved"), `${variant}: provider bundle missing authCallsObserved metadata`);
  assert(bundleSource.includes("otpEnabled"), `${variant}: provider bundle missing otpEnabled metadata`);
  assert(bundleSource.includes("signInWithOtp"), `${variant}: provider bundle must contain the approved request-email-OTP provider call`);
  assert(bundleSource.includes("verifyOtp"), `${variant}: provider bundle must contain the approved verify-email-OTP provider call`);
  assert(bundleSource.includes("signUp"), `${variant}: provider bundle must contain the approved password signUp call`);
  assert(bundleSource.includes("signInWithPassword"), `${variant}: provider bundle must contain the approved password signInWithPassword call`);
  assert(bundleSource.includes("resetPasswordForEmail"), `${variant}: provider bundle must contain the approved password reset request call`);
  assert(bundleSource.includes("refreshSession"), `${variant}: provider bundle must contain the approved provider refresh call`);
  assert(bundleSource.includes("signOut"), `${variant}: provider bundle must contain the approved best-effort provider signOut call`);
  assert(bundleSource.includes("local"), `${variant}: provider bundle must contain local sign-out scope`);
  assert(bundleSource.includes("complete_onboarding"), `${variant}: provider bundle must contain the approved complete_onboarding RPC call`);
  assert(bundleSource.includes("load_identity_state"), `${variant}: provider bundle must contain the approved load_identity_state RPC call`);
  assert(bundleSource.includes("mark_password_setup_completed"), `${variant}: provider bundle must contain the approved mark_password_setup_completed RPC call`);

  assertNoPatterns(`${variant} provider bundle`, bundleSource, PROVIDER_BUNDLE_DYNAMIC_CODE_PATTERNS);
  assertNoPatterns(`${variant} provider bundle`, bundleSource, REAL_CONFIG_PATTERNS);

  const markerIndex = bundleSource.lastIndexOf(PROBE_MARKER);
  const ownedProbeTail = markerIndex >= 0
    ? bundleSource.slice(Math.max(0, markerIndex - 1600))
    : bundleSource.slice(-2400);
  assertNoPatterns(`${variant} provider probe wrapper`, ownedProbeTail, PROVIDER_PROBE_AUTH_CALL_PATTERNS);
}

function validateVariant({ label, rel, profile }) {
  const root = abs(rel);
  assert(existsAbs(root), `${label}: build output missing at ${rel}`);
  const manifest = readJson(`${rel}/manifest.json`);
  const files = textFiles(root);
  const loaderSource = read(`${rel}/loader.js`);
  const bgSource = read(`${rel}/bg.js`);
  const providerBundle = read(`${rel}/${PROVIDER_BUNDLE_REL}`);
  const privateConfigPresent = existsAbs(abs(`${rel}/${PRIVATE_CONFIG_REL}`));
  if (profile === "production") {
    assert(!privateConfigPresent,
      `${label}: private config artifact must remain absent in production output`);
  }
  assert(!existsAbs(abs(`${rel}/${LEGACY_PROVIDER_BUNDLE_REL}`)),
    `${label}: legacy provider bundle output must be removed`);
  assert(bgSource.includes(PROVIDER_BUNDLE_REL),
    `${label}: built bg.js must reference renamed provider bundle path`);
  assert(!bgSource.includes(LEGACY_PROVIDER_BUNDLE_REL),
    `${label}: built bg.js must not reference legacy provider bundle path`);
  assert(!bgSource.includes(LEGACY_PROVIDER_BUNDLE_NAME),
    `${label}: built bg.js must not reference legacy provider bundle name`);

  const manifestFacts = assertManifestBoundary(label, profile, manifest);
  if (privateConfigPresent) {
    const optionalHostPermissions = stringList(manifest.optional_host_permissions);
    assert(profile !== "production",
      `${label}: private config artifact may be emitted only in non-production output`);
    assert(optionalHostPermissions.length === 1
        && /^https:\/\/[a-z0-9-]+\.supabase\.co\/\*$/.test(optionalHostPermissions[0])
        && optionalHostPermissions[0] !== "https://*.supabase.co/*",
      `${label}: dev config output must emit one exact Supabase optional host permission`);
    assert(!manifestFacts.hostPermissions.some((permission) => /supabase\.co/i.test(permission)),
      `${label}: dev config output must not put Supabase in normal host_permissions`);
  } else {
    assert(!Object.prototype.hasOwnProperty.call(manifest, "optional_host_permissions"),
      `${label}: default no-config output must not include optional_host_permissions`);
  }
  assertLoaderClean(label, loaderSource);
  assertPageFacingClean(label, root, files);
  assertGeneratedProviderPermissionActionScope(label, root, files);
  assertGeneratedOutputsNoRealConfig(label, root, files);
  assertNoCreateClientOutsideProviderContext(label, root, files);
  assertProviderBundleSafe(label, providerBundle);
  assertBuiltOnboardingDirectSessionFixture(label, bgSource);
  return assertBuiltProviderConfigStatusPath(label, bgSource).then(() => {
    console.log(`  ${label}: built derived providerConfigStatus includes deferred permission readiness`);

    console.log(`  ${label}: permissions = ${manifestFacts.permissions.join(", ") || "(none)"}`);
    console.log(`  ${label}: host_permissions = ${manifestFacts.hostPermissions.join(", ") || "(none)"}`);
    console.log(`  ${label}: web_accessible_resources = ${manifestFacts.warResources.join(", ") || "(none)"}`);
    console.log(`  ${label}: host/CSP/network gates passed`);
  });
}

function assertNoPageFacingExactHostLeak(root, label) {
  const files = listFiles(root);
  for (const rel of pageFacingRels(root, files)) {
    const source = readAbs(path.join(root, rel));
    assert(!source.includes(EXACT_HOST_PROJECT_URL),
      `${label} ${rel}: exact project URL must not appear in page-facing output`);
    assert(!source.includes(EXACT_HOST_PERMISSION),
      `${label} ${rel}: exact host permission must not appear in page-facing output`);
    assert(!source.includes(EXACT_HOST_PUBLIC_CLIENT),
      `${label} ${rel}: public client value must not appear in page-facing output`);
  }
}

async function validateExactHostOptionalPermissionSimulation() {
  const devOut = path.join("/tmp", `h2o-phase3z-dev-${process.pid}`);
  const armedDevOut = path.join("/tmp", `h2o-phase31a-armed-dev-${process.pid}`);
  const unconfiguredArmedOut = path.join("/tmp", `h2o-phase31a-unconfigured-${process.pid}`);
  const prodOut = path.join("/tmp", `h2o-phase3z-prod-${process.pid}`);
  const armedProdOut = path.join("/tmp", `h2o-phase31a-armed-prod-${process.pid}`);
  const commonEnv = {
    ...process.env,
    H2O_IDENTITY_PROVIDER_KIND: "supabase",
    H2O_IDENTITY_PROVIDER_PROJECT_URL: EXACT_HOST_PROJECT_URL,
    H2O_IDENTITY_PROVIDER_PUBLIC_CLIENT: EXACT_HOST_PUBLIC_CLIENT,
  };
  fs.rmSync(devOut, { recursive: true, force: true });
  fs.rmSync(armedDevOut, { recursive: true, force: true });
  fs.rmSync(unconfiguredArmedOut, { recursive: true, force: true });
  fs.rmSync(prodOut, { recursive: true, force: true });
  fs.rmSync(armedProdOut, { recursive: true, force: true });
  try {
    execFileSync(process.execPath, ["tools/product/extensions/chatgpt/chrome/build-chrome-live-extension.mjs"], {
      cwd: REPO_ROOT,
      env: {
        ...commonEnv,
        H2O_EXT_DEV_VARIANT: "controls",
        H2O_EXT_OUT_DIR: devOut,
      },
      stdio: "pipe",
    });
    const devManifest = JSON.parse(readAbs(path.join(devOut, "manifest.json")));
    const devOptional = stringList(devManifest.optional_host_permissions);
    assert(devOptional.length === 1 && devOptional[0] === EXACT_HOST_PERMISSION,
      `exact-host dev simulation: optional_host_permissions must contain only ${EXACT_HOST_PERMISSION}`);
    assert(!stringList(devManifest.host_permissions).some((permission) => /supabase\.co/i.test(permission)),
      "exact-host dev simulation: normal host_permissions must not contain Supabase");
    assert(!flattenWarResources(devManifest).some((resource) => String(resource || "").startsWith("provider/")),
      "exact-host dev simulation: provider directory must not be web-accessible");
    assert(existsAbs(path.join(devOut, PRIVATE_CONFIG_REL)),
      "exact-host dev simulation: private config artifact must be emitted for dev config");
    assert(readAbs(path.join(devOut, "bg.js")).includes(EXACT_HOST_PERMISSION),
      "exact-host dev simulation: background may carry exact optional host permission for chrome.permissions checks");
    assertGeneratedProviderPermissionActionScope("exact-host dev simulation", devOut, textFiles(devOut));
    assertNoPageFacingExactHostLeak(devOut, "exact-host dev simulation");

    execFileSync(process.execPath, ["tools/product/extensions/chatgpt/chrome/build-chrome-live-extension.mjs"], {
      cwd: REPO_ROOT,
      env: {
        ...commonEnv,
        H2O_EXT_DEV_VARIANT: "controls",
        H2O_EXT_OUT_DIR: armedDevOut,
        H2O_IDENTITY_PHASE_NETWORK: "request_otp",
      },
      stdio: "pipe",
    });
    const armedManifest = JSON.parse(readAbs(path.join(armedDevOut, "manifest.json")));
    assertArmedRequestOtpManifestBoundary("armed dev simulation", armedManifest);
    const armedBg = readAbs(path.join(armedDevOut, "bg.js"));
    assert(armedBg.includes('const IDENTITY_PROVIDER_PHASE_NETWORK = "request_otp";'),
      "armed dev simulation: bg.js must contain only the safe request_otp phase marker");
    assert(!armedBg.includes(EXACT_HOST_PUBLIC_CLIENT),
      "armed dev simulation: bg.js must not contain public client value");
    assertBuiltOnboardingDirectSessionFixture("armed dev simulation", armedBg);
    assertGeneratedProviderPermissionActionScope("armed dev simulation", armedDevOut, textFiles(armedDevOut));
    const armedGrantedCode = makeBuiltProviderConfigEvalCode(
      "armed dev simulation",
      armedBg,
      REDACTED_COMPLETE_DEV_ENV_STATUS,
      "identityAuthManager_getDerivedState()",
      { optionalHostPattern: EXACT_HOST_PERMISSION, permissionGranted: true, phaseNetwork: "request_otp" },
    );
    const armedGranted = await new Function(armedGrantedCode)();
    assert(armedGranted && armedGranted.ok === true,
      "armed dev simulation: derived state must evaluate");
    const armedStatus = armedGranted.derivedState?.providerConfigStatus;
    assertProviderConfigStatusHasExactPermissionReadiness(
      "armed dev simulation exact-host permission granted",
      {
        ...armedStatus,
        phaseNetworkEnabled: false,
        networkReady: false,
        networkStatus: "blocked",
        networkBlockReason: "phase_not_enabled",
      },
      true,
    );
    assertNetworkArmedReady("armed dev simulation exact-host permission granted", armedStatus);

    let unconfiguredFailed = false;
    try {
      execFileSync(process.execPath, ["tools/product/extensions/chatgpt/chrome/build-chrome-live-extension.mjs"], {
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          H2O_EXT_DEV_VARIANT: "controls",
          H2O_EXT_OUT_DIR: unconfiguredArmedOut,
          H2O_IDENTITY_PROVIDER_KIND: "supabase",
          H2O_IDENTITY_PROVIDER_PROJECT_URL: "",
          H2O_IDENTITY_PROVIDER_PUBLIC_CLIENT: "",
          H2O_IDENTITY_PHASE_NETWORK: "request_otp",
        },
        stdio: "pipe",
      });
    } catch {
      unconfiguredFailed = true;
    }
    assert(unconfiguredFailed,
      "request_otp phase flag must fail the build without complete provider config");

    execFileSync(process.execPath, ["tools/product/extensions/chatgpt/chrome/build-chrome-live-extension.mjs"], {
      cwd: REPO_ROOT,
      env: {
        ...commonEnv,
        H2O_EXT_DEV_VARIANT: "production",
        H2O_EXT_OUT_DIR: prodOut,
      },
      stdio: "pipe",
    });
    const prodManifest = JSON.parse(readAbs(path.join(prodOut, "manifest.json")));
    assert(!Object.prototype.hasOwnProperty.call(prodManifest, "optional_host_permissions"),
      "exact-host production simulation: optional_host_permissions must remain absent");
    assert(!existsAbs(path.join(prodOut, PRIVATE_CONFIG_REL)),
      "exact-host production simulation: private config artifact must remain absent");
    assertGeneratedProviderPermissionActionScope("exact-host production simulation", prodOut, textFiles(prodOut));
    for (const file of textFiles(prodOut)) {
      const rel = toRel(prodOut, file);
      const source = readAbs(file);
      assert(!source.includes(EXACT_HOST_PROJECT_URL) && !source.includes(EXACT_HOST_PERMISSION),
        `exact-host production simulation ${rel}: exact host must not appear in production output`);
      assert(!source.includes(EXACT_HOST_PUBLIC_CLIENT),
        `exact-host production simulation ${rel}: public client must not appear in production output`);
    }
    let prodArmedFailed = false;
    try {
      execFileSync(process.execPath, ["tools/product/extensions/chatgpt/chrome/build-chrome-live-extension.mjs"], {
        cwd: REPO_ROOT,
        env: {
          ...commonEnv,
          H2O_EXT_DEV_VARIANT: "production",
          H2O_EXT_OUT_DIR: armedProdOut,
          H2O_IDENTITY_PHASE_NETWORK: "request_otp",
        },
        stdio: "pipe",
      });
    } catch {
      prodArmedFailed = true;
    }
    assert(prodArmedFailed,
      "request_otp phase flag must fail production builds in Phase 3.1A");
  } finally {
    fs.rmSync(devOut, { recursive: true, force: true });
    fs.rmSync(armedDevOut, { recursive: true, force: true });
    fs.rmSync(unconfiguredArmedOut, { recursive: true, force: true });
    fs.rmSync(prodOut, { recursive: true, force: true });
    fs.rmSync(armedProdOut, { recursive: true, force: true });
  }
}

console.log("\n── Identity Phase 3.0Q/3.0S/3.0T/3.0U/3.0V/3.0W/3.0X/3.0Y/3.0Z/3.0AA host permission/CSP/network/config/bundle validation ───");

assertProviderSourceSafe();
console.log("  provider source confines createClient to lazy smoke with no auth/network calls");
assertProviderBundleRenameApplied();
console.log("  provider bundle artifact uses the Supabase name with legacy path removed");
assertConditionalProviderBundleLoadingGate();
console.log("  provider SDK bundle loading is conditional and skipped for default mock/no-config");
assertBackgroundPermissionReadinessSafe();
console.log("  background confines permissions API calls to exact-host internal helpers");
assertPopupProviderPermissionActionScoped();
console.log("  provider permission grant action is confined to background and Dev Controls popup");
assertVerifyEmailOtpSessionBoundarySafe();
console.log("  verify-email-OTP session boundary stays background/session-storage only");
assertExactHostPermissionGated();
console.log("  exact Supabase host optional permission is gated with no wildcard fallback");
assertRealDevConfigReadinessGateRedacted();
console.log("  real dev config readiness plumbing remains ignored, redacted, and non-networked");

for (const variant of VARIANTS) await validateVariant(variant);
await validateExactHostOptionalPermissionSimulation();
console.log("  exact-host optional permission and request_otp arming temp build simulations passed");

console.log(`\nIdentity Phase 3.0Q/3.0S/3.0T/3.0U/3.0V/3.0W/3.0X/3.0Y/3.0Z/3.0AA validation PASSED with ${WARNINGS.length} warning(s).`);
for (const warning of WARNINGS) {
  console.log(`  warning: ${warning}`);
}
console.log("");
