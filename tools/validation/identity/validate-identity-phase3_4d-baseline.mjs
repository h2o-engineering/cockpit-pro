// Identity Phase 3.4D validation - stable baseline checklist.
// Static only; no Supabase/network access.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extensionBuildDir, SURFACES_BASE_REL } from "../../paths.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

// Phase 4B-1b: CWD-relative path string for an extension build artifact.
// Byte-identical to legacy "build/chrome-ext-<variant>/<segments>" form.
//
// THIS ONE FOLLOWS THE ENVIRONMENT, AND MUST. `extensionBuildDir()` honours
// H2O_EXT_BUILD_ROOT so a source-safe run can send build output to a per-run
// temporary root; artifact READS below have to look where the current
// execution actually built, so they keep using this helper.
function extBuildRel(variant, ...segments) {
  return path.relative(REPO_ROOT, path.join(extensionBuildDir(variant), ...segments));
}

// THIS ONE MUST NOT. A documented build command is a fact about the Extension's
// canonical layout, not about where one run happened to put its output, so a
// relocated build root cannot be allowed to redefine what static documentation
// is required to advertise - that is how the release gate came to demand an
// ephemeral per-run path from a correct document.
//
// The canonical layout is still read from the one authority that owns it
// (`extensionBuildDir`), with the relocation input neutralised for the length
// of the call, rather than restated here: a second copy of the layout would
// drift the day the Extension moves again, exactly as it moved in Phase 4C-B.
function canonicalExtBuildRel(variant, ...segments) {
  const relocated = process.env.H2O_EXT_BUILD_ROOT;
  if (relocated !== undefined) delete process.env.H2O_EXT_BUILD_ROOT;
  try {
    return path.relative(REPO_ROOT, path.join(extensionBuildDir(variant), ...segments));
  } finally {
    if (relocated !== undefined) process.env.H2O_EXT_BUILD_ROOT = relocated;
  }
}

const DOC_REL = "docs/identity/IDENTITY_PHASE_3_0_SUPABASE_PREP.md";
const GITIGNORE_REL = ".gitignore";
const BACKGROUND_REL = "tools/product/extensions/chatgpt/chrome/chrome-live-background.mjs";
const LOADER_REL = "tools/product/extensions/chatgpt/chrome/chrome-live-loader.mjs";
const IDENTITY_SURFACE_JS_REL = `${SURFACES_BASE_REL}/identity/identity.js`;
const IDENTITY_SURFACE_HTML_REL = `${SURFACES_BASE_REL}/identity/identity.html`;
const CONTROL_HUB_REL = "src-runtime-base/0Z1a.⬛️🕹️ Control Hub 🕹️.js";
const CONTROL_HUB_ACCOUNT_REL = "src-runtime-base/0Z1e.⚫️🔐 Account Tab (Control Hub 🔌 Plugin) 🔐.js";
const ARMED_MANIFEST_REL = extBuildRel("dev-controls-armed", "manifest.json");
const PROD_MANIFEST_REL = extBuildRel("prod", "manifest.json");

const ACTIVE_VALIDATORS = [
  "tools/validation/identity/validate-identity-background-bundle.mjs",
  "tools/validation/identity/validate-identity-phase3_0q.mjs",
  "tools/validation/identity/validate-identity-phase3_2b-schema.mjs",
  "tools/validation/identity/validate-identity-phase3_2c-rls-live.mjs",
  "tools/validation/identity/validate-identity-phase3_3a-ui.mjs",
  "tools/validation/identity/validate-identity-phase3_3b-ui.mjs",
  "tools/validation/identity/validate-identity-phase3_3c-ui-edge-cases.mjs",
  "tools/validation/identity/validate-identity-phase3_4c-session-ux.mjs",
  "tools/validation/identity/validate-identity-phase3_4d-baseline.mjs",
  "tools/validation/identity/validate-identity-phase3_5a-persistence-review.mjs",
  "tools/validation/identity/validate-identity-phase3_5b-release-gate.mjs",
  "tools/validation/identity/validate-identity-phase3_7a-persistent-signin.mjs",
  "tools/validation/identity/validate-identity-phase3_7b-production-polish.mjs",
  "tools/validation/identity/validate-identity-phase3_8a-password-auth.mjs",
  "tools/validation/identity/validate-identity-phase3_8b-auth-ux-separation.mjs",
  "tools/validation/identity/validate-identity-phase3_8c-account-verification.mjs",
  "tools/validation/identity/validate-identity-phase3_8d-email-code-recovery.mjs",
  "tools/validation/identity/validate-identity-phase3_8e-password-integrity.mjs",
  "tools/validation/identity/validate-identity-phase3_8f-password-auth-release-gate.mjs",
  "tools/validation/identity/validate-identity-phase3_9b-google-oauth.mjs",
  "tools/validation/identity/validate-identity-phase3_9c-google-oauth-release-gate.mjs",
  "tools/validation/identity/validate-identity-phase4_0b-account-security-mvp.mjs",
  "tools/validation/onboarding/validate-onboarding-open.mjs",
  "tools/validation/identity/validate-identity-phase2_9.mjs",
  "tools/validation/identity/validate-identity-phase2_9-sync.mjs",
];

const ACTIVE_BUILDS = [
  "node tools/product/extensions/chatgpt/chrome/build-chrome-live-extension.mjs",
  `env H2O_EXT_DEV_VARIANT=lean H2O_EXT_OUT_DIR=${canonicalExtBuildRel("dev-lean")} node tools/product/extensions/chatgpt/chrome/build-chrome-live-extension.mjs`,
  `env H2O_EXT_DEV_VARIANT=production H2O_EXT_OUT_DIR=${canonicalExtBuildRel("prod")} node tools/product/extensions/chatgpt/chrome/build-chrome-live-extension.mjs`,
  `env H2O_IDENTITY_PHASE_NETWORK=request_otp H2O_EXT_OUT_DIR=${canonicalExtBuildRel("dev-controls-armed")} node tools/product/extensions/chatgpt/chrome/build-chrome-live-extension.mjs`,
  `env H2O_IDENTITY_PHASE_NETWORK=request_otp H2O_IDENTITY_OAUTH_PROVIDER=google H2O_EXT_OUT_DIR=${canonicalExtBuildRel("dev-controls-oauth-google")} node tools/product/extensions/chatgpt/chrome/build-chrome-live-extension.mjs`,
  "node tools/product/extensions/chatgpt/chrome/pack-ops-panel.mjs",
];

function read(rel) {
  return fs.readFileSync(path.join(REPO_ROOT, rel), "utf8");
}

function readJson(rel) {
  return JSON.parse(read(rel));
}

function exists(rel) {
  return fs.existsSync(path.join(REPO_ROOT, rel));
}

function assert(condition, message) {
  if (!condition) throw new Error(`FAIL: ${message}`);
}

function arrayEquals(actual, expected) {
  return Array.isArray(actual) &&
    actual.length === expected.length &&
    actual.every((value, index) => value === expected[index]);
}

function assertNoAllHosts(label, manifest) {
  const hosts = [
    ...(manifest.host_permissions || []),
    ...(manifest.optional_host_permissions || []),
  ];
  assert(!hosts.includes("*://*/*"), `${label}: broad all-host permission must not appear`);
  assert(!hosts.includes("<all_urls>"), `${label}: <all_urls> permission must not appear`);
}

function extractFunction(source, name) {
  const marker = `function ${name}(`;
  const start = source.indexOf(marker);
  if (start === -1) return "";
  const bodyStart = source.indexOf("{", start);
  if (bodyStart === -1) return "";
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    const char = source[index];
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  return "";
}

console.log("\n-- Identity Phase 3.4D stable baseline validation ---------------");

const docs = read(DOC_REL);
const gitignore = read(GITIGNORE_REL);
const background = read(BACKGROUND_REL);
const loader = read(LOADER_REL);
const identitySurfaceJs = read(IDENTITY_SURFACE_JS_REL);
const identitySurfaceHtml = read(IDENTITY_SURFACE_HTML_REL);
const controlHub = read(CONTROL_HUB_REL);
const controlHubAccount = read(CONTROL_HUB_ACCOUNT_REL);
const armedManifest = readJson(ARMED_MANIFEST_REL);
const prodManifest = readJson(PROD_MANIFEST_REL);

assert(docs.includes("## 15.14 Phase 3.4D - Stable Baseline"),
  "docs must include Phase 3.4D stable baseline section");

for (const rel of ACTIVE_VALIDATORS) {
  assert(exists(rel), `${rel} must exist`);
  assert(docs.includes(`node ${rel}`), `docs must list active validator command for ${rel}`);
}
for (const command of ACTIVE_BUILDS) {
  assert(docs.includes(command), `docs must list active build command: ${command}`);
}

assert(docs.includes("validate-onboarding-url.mjs") && docs.includes("legacy reference"),
  "docs must classify validate-onboarding-url.mjs as legacy reference");
assert(!docs.includes("node tools/validation/onboarding/validate-onboarding-url.mjs"),
  "legacy validate-onboarding-url.mjs must not appear as an active command");
assert(docs.includes("identity:open-onboarding") && docs.includes("chrome.windows.create"),
  "docs must identify the active onboarding-open bridge path");

assert(gitignore.split(/\r?\n/).includes("build/**"),
  ".gitignore must ignore generated build outputs");
assert(gitignore.split(/\r?\n/).includes("config/local/identity-provider.local.json"),
  ".gitignore must ignore local identity provider config");

assert(!armedManifest.content_security_policy, "armed manifest must not add CSP");
assert(!prodManifest.content_security_policy, "production manifest must not add CSP");
assertNoAllHosts("armed manifest", armedManifest);
assertNoAllHosts("production manifest", prodManifest);

assert(arrayEquals(armedManifest.host_permissions, ["https://chatgpt.com/*", "http://127.0.0.1:5500/*"]),
  "armed manifest host_permissions must be ChatGPT plus the required local proxy only");
assert(Array.isArray(armedManifest.optional_host_permissions) &&
  armedManifest.optional_host_permissions.length === 1 &&
  /^https:\/\/[a-z0-9-]+\.supabase\.co\/\*$/.test(armedManifest.optional_host_permissions[0]),
  "armed manifest optional_host_permissions must be exactly one Supabase project origin");
assert(!(armedManifest.host_permissions || []).some((origin) => /supabase\.co/i.test(origin)),
  "armed manifest must not put Supabase in normal host_permissions");
assert(!armedManifest.externally_connectable?.ids?.includes("*"),
  "armed manifest must not expose wildcard externally_connectable ids");

assert(arrayEquals(prodManifest.host_permissions, ["https://chatgpt.com/*"]),
  "production manifest host_permissions must be ChatGPT only");
assert(!prodManifest.optional_host_permissions,
  "production manifest must not declare optional Supabase permissions");
assert(!prodManifest.externally_connectable?.ids?.includes("*"),
  "production manifest must not expose wildcard externally_connectable ids");

const providerSessionStorageStrict = extractFunction(background, "providerSessionStorageStrict");
assert(providerSessionStorageStrict.includes("chrome.storage.session"),
  "provider session strict storage helper must use chrome.storage.session");
assert(!providerSessionStorageStrict.includes("chrome.storage.local"),
  "provider session strict storage helper must not fall back to chrome.storage.local");
assert(!/chrome\.storage\.local[^\n]*(h2oIdentityProviderSessionV1|refresh_token|access_token)/i.test(background),
  "background must not persist provider token/session material in chrome.storage.local");

const runtimeSurface = [
  identitySurfaceJs,
  identitySurfaceHtml,
  controlHub,
  loader,
].join("\n");
assert(!/keep me signed in/i.test(runtimeSurface),
  "runtime/UI surfaces must not add keep-me-signed-in behavior");
assert(!/h2oIdentityProviderPersistentRefreshV1|persistentRefresh|rememberDevice|remember-device|\brefresh_token\b/i.test(runtimeSurface),
  "UI/page/loader surfaces must not expose persistent provider refresh internals");
assert(background.includes('const IDENTITY_PROVIDER_PERSISTENT_REFRESH_KEY = "h2oIdentityProviderPersistentRefreshV1"'),
  "background must define the approved persistent refresh key");
assert(background.includes("providerPersistentRefreshStorageStrict") && background.includes("chrome.storage.local"),
  "background must own the approved chrome.storage.local persistent refresh helper");
assert(!/chrome\.storage\.local[^\n]*(h2oIdentityProviderSessionV1|access_token)/i.test(background),
  "background must not persist active provider session or access token in chrome.storage.local");
const pageFacingUi = identitySurfaceJs + identitySurfaceHtml + loader + controlHubAccount;
assert(!/@supabase\/supabase-js|@supabase\//i.test(pageFacingUi),
  "UI/page/loader must not import Supabase SDK");
assert(!/\.rpc\s*\(/.test(pageFacingUi),
  "UI/page/loader must not call Supabase rpc");
assert(!/\.from\s*\(\s*['"`](profiles|workspaces|workspace_memberships)['"`]/.test(pageFacingUi),
  "UI/page/loader must not call Supabase identity tables");
assert(!/service_role|service-role|serviceRoleKey/i.test(pageFacingUi),
  "UI/page/loader must not expose service-role strings");
assert(docs.includes("safe boolean diagnostics") || docs.includes("safe diagnostic"),
  "docs must acknowledge safe token-free diagnostics remain validator-guarded");

console.log("  active validator and build checklist documented");
console.log("  legacy onboarding URL validator excluded from active checklist");
console.log("  ignore rules cover generated build and local identity config");
console.log("  armed and production manifests remain narrow");
console.log("  active session storage remains session-only and persistent refresh is background-owned");
console.log("\nIdentity Phase 3.4D stable baseline validation PASSED");
