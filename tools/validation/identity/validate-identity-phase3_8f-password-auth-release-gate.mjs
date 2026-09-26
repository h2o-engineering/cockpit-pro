// Identity Phase 3.8F validation - final password-auth release gate.
// Static only; no Supabase/network access and no storage mutation.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SURFACES_BASE_REL } from "../../paths.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const DOC_REL = "docs/identity/IDENTITY_PHASE_3_0_SUPABASE_PREP.md";
const PROVIDER_REL = "tools/product/identity/identity-provider-supabase.entry.mjs";
const BACKGROUND_REL = "tools/product/extensions/chatgpt/chrome/chrome-live-background.mjs";
const LOADER_REL = "tools/product/extensions/chatgpt/chrome/chrome-live-loader.mjs";
const IDENTITY_CORE_REL = "src-runtime-base/0D4a.⬛️🔐 Identity Core 🔐.js";
const IDENTITY_SURFACE_JS_REL = `${SURFACES_BASE_REL}/identity/identity.js`;
const IDENTITY_SURFACE_HTML_REL = `${SURFACES_BASE_REL}/identity/identity.html`;
const IDENTITY_SURFACE_CSS_REL = `${SURFACES_BASE_REL}/identity/identity.css`;
const CONTROL_HUB_REL = "src-runtime-base/0Z1a.⬛️🕹️ Control Hub 🕹️.js";
const CONTROL_HUB_ACCOUNT_REL = "src-runtime-base/0Z1e.⚫️🔐 Account Tab (Control Hub 🔌 Plugin) 🔐.js";
const RELEASE_RUNNER_REL = "tools/validation/identity/run-identity-release-gate.mjs";
const RELEASE_GATE_VALIDATOR_REL = "tools/validation/identity/validate-identity-phase3_5b-release-gate.mjs";
const BASELINE_VALIDATOR_REL = "tools/validation/identity/validate-identity-phase3_4d-baseline.mjs";

const VALIDATOR_REL = "tools/validation/identity/validate-identity-phase3_8f-password-auth-release-gate.mjs";
const SESSION_KEY = "h2oIdentityProviderSessionV1";
const PERSISTENT_KEY = "h2oIdentityProviderPersistentRefreshV1";
const PASSWORD_MARKER_KEY = "h2oIdentityProviderPasswordUpdateRequiredV1";

function read(rel) {
  return fs.readFileSync(path.join(REPO_ROOT, rel), "utf8");
}

function assert(condition, message) {
  if (!condition) throw new Error(`FAIL: ${message}`);
}

function extractFunction(source, name) {
  const syncIndex = source.indexOf(`function ${name}(`);
  const asyncIndex = source.indexOf(`async function ${name}(`);
  const start = (asyncIndex >= 0 && (syncIndex < 0 || asyncIndex < syncIndex)) ? asyncIndex : syncIndex;
  if (start === -1) return "";
  const bodyStart = source.indexOf("{", source.indexOf(")", start));
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

function assertPageBoundary(label, source) {
  assert(!/@supabase\/supabase-js|@supabase\//i.test(source),
    `${label}: must not import Supabase SDK`);
  assert(!/identity-provider-supabase|H2O_IDENTITY_PROVIDER_BUNDLE_PROBE/.test(source),
    `${label}: must not import or probe provider bundle`);
  assert(!/\.rpc\s*\(|\.from\s*\(\s*['"`](profiles|workspaces|workspace_memberships|identity_password_status)['"`]/.test(source),
    `${label}: must not call Supabase directly`);
  assert(!/\b(service_role|service-role|serviceRoleKey)\b/i.test(source),
    `${label}: must not contain service-role strings`);
  assert(!/\b(access_token|refresh_token|rawSession|rawUser|owner_user_id|deleted_at)\b/.test(source),
    `${label}: must not expose token/session/raw-user or unsafe DB fields`);
  assert(!/identity_password_status|mark_password_setup_completed/.test(source),
    `${label}: must not expose raw credential table or RPC names`);
}

function stripJsComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

function stripQuotedLiterals(source) {
  return source
    .replace(/'(?:\\.|[^'\\])*'/g, "''")
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/`(?:\\.|[^`\\])*`/g, "``");
}

function assertNoPasswordStorage(label, source) {
  const executable = stripJsComments(source);

  const pageStorageSecretWrite =
    /(?:localStorage|sessionStorage)\s*\.\s*setItem\s*\([\s\S]{0,600}?(?:\bpassword\b|\botp\b|\bcode\b|Password\b|Otp\b|Code\b)[\s\S]{0,600}?\)/.test(executable);
  const chromeStorageSecretWrite =
    /chrome\.storage\.(?:local|session|sync)\s*\.\s*set\s*\([\s\S]{0,1200}?(?:\bpassword\b|\botp\b|\bcode\b|Password\b|Otp\b|Code\b)[\s\S]{0,1200}?\)/.test(executable);

  assert(!pageStorageSecretWrite && !chromeStorageSecretWrite,
    `${label}: password/code values must not be written to storage`);

  const logCalls = executable.match(/console\.(?:log|warn|error|info|debug)\s*\([\s\S]{0,1200}?\)/g) || [];
  const secretLogged = logCalls.some((call) => {
    if (/\$\{[^}]*\b(?:password|otp|code)\b[^}]*\}/i.test(call)) return true;
    const withoutLiterals = stripQuotedLiterals(call);
    return /\b(?:password|otp|code)\b/i.test(withoutLiterals);
  });

  assert(!secretLogged,
    `${label}: password/code values must not be logged or diagnosed`);
}

console.log("\n-- Identity Phase 3.8F password-auth release-gate validation ----");

const docs = read(DOC_REL);
const provider = read(PROVIDER_REL);
const background = read(BACKGROUND_REL);
const loader = read(LOADER_REL);
const identityCore = read(IDENTITY_CORE_REL);
const identitySurfaceJs = read(IDENTITY_SURFACE_JS_REL);
const identitySurfaceHtml = read(IDENTITY_SURFACE_HTML_REL);
const identitySurfaceCss = read(IDENTITY_SURFACE_CSS_REL);
const controlHub = read(CONTROL_HUB_REL);
const controlHubAccount = read(CONTROL_HUB_ACCOUNT_REL);
const controlHubAccountSurface = `${controlHub}\n${controlHubAccount}`;
const releaseRunner = read(RELEASE_RUNNER_REL);
const releaseGateValidator = read(RELEASE_GATE_VALIDATOR_REL);
const baselineValidator = read(BASELINE_VALIDATOR_REL);

assert(docs.includes("Phase 3.8F - Password Auth Release Gate"),
  "docs must include the Phase 3.8F password auth release-gate section");
for (const phrase of [
  "Password sign-up",
  "Signup confirmation",
  "Password sign-in",
  "Existing-user email-code sign-in",
  "Wrong-password recovery",
  "password_update_required",
  "Persistent sign-in",
  "Sign-out cleanup",
  "credentialState is the only public password status field",
  "Reset password remains request-only",
  "reset-link completion remains deferred",
  "Change-password account settings UI remains deferred",
  "Microsoft/GitHub/Apple OAuth/social login remains deferred",
  "MFA remains deferred",
  "Account deletion/session management remains deferred",
  "Production migration rollout still needs an explicit deployment gate",
]) {
  assert(docs.includes(phrase), `docs must document final password-auth gate item: ${phrase}`);
}
for (const phrase of [
  "New email -> email-code sign-in -> \"No account found.\"",
  "Create account weak password -> local block.",
  "Create account mismatch -> local block.",
  "Create account strong password -> confirmation path.",
  "Password sign-in -> `sync_ready`.",
  "Wrong password -> safe error plus recovery action.",
  "Recovery code -> `password_update_required`.",
  "Strong new password -> `credentialState` complete plus `sync_ready`.",
  "Chrome restart -> `sync_ready` restored.",
  "Sign out -> all credential keys removed.",
  "Live RLS password-status checks pass.",
]) {
  assert(docs.includes(phrase), `docs must list manual password release check: ${phrase}`);
}
assert(docs.includes(`node ${VALIDATOR_REL}`) &&
  docs.includes(`node --check ${VALIDATOR_REL}`),
  "docs must list the 3.8F validator and syntax command");

assert(releaseRunner.includes(VALIDATOR_REL),
  "release runner must include the 3.8F validator");
assert(releaseGateValidator.includes(VALIDATOR_REL),
  "3.5B release-gate validator inventory must include the 3.8F validator");
assert(baselineValidator.includes(VALIDATOR_REL),
  "3.4D baseline validator inventory must include the 3.8F validator");

const requestEmailOtp = extractFunction(provider, "requestEmailOtp");
assert(requestEmailOtp.includes("client.auth.signInWithOtp") &&
  requestEmailOtp.includes("shouldCreateUser: false"),
  "email-code sign-in/recovery must stay existing-user-only with shouldCreateUser:false");

assert(provider.includes("client.auth.signUp({ email, password })"),
  "password sign-up must remain provider-owned");
assert(provider.includes("client.auth.signInWithPassword({ email, password })"),
  "password sign-in must remain provider-owned");
assert(provider.includes("client.auth.resetPasswordForEmail(email)"),
  "reset password must remain request-only in the provider");
assert(provider.includes('client.auth.verifyOtp({ email, token: code, type: "email" })'),
  "signup/recovery confirmation must use verifyOtp type:\"email\"");
assert(provider.includes('client.auth.resend({ type: "signup", email })'),
  "signup confirmation resend must use auth.resend type:\"signup\"");
assert(provider.includes("client.auth.updateUser({ password })"),
  "recovery set-password must be provider-owned");
assert((provider.match(/\bupdateUser\s*\(/g) || []).length === 2 &&
  provider.includes("async function changePassword(config, input = {})") &&
  provider.includes("current_password: currentPassword") &&
  !provider.includes("currentPassword:"),
  "updateUser may appear only in provider recovery and signed-in password-change helpers, using current_password casing");
assert(!/\bclient\.auth\.(signUp|signInWithPassword|resetPasswordForEmail|updateUser)\s*\(/.test(background),
  "background must not call Supabase password APIs directly");
assert(!/\bsignInWithIdToken\s*\(|\bgetSession\s*\(/.test(provider + background + loader + identityCore + identitySurfaceJs),
  "password release gate must not add ID-token auth or provider getSession");

const publishPasswordSession = extractFunction(background, "identityAuthManager_publishPasswordSession");
assert(publishPasswordSession.includes("identityProviderCredentialState_markCompleteForSession") &&
  publishPasswordSession.includes("identityProviderPasswordUpdateRequired_remove") &&
  publishPasswordSession.includes("identityProviderSession_publishSafeRuntime"),
  "password sign-up/sign-in success must mark credential complete before safe restore");
for (const source of ["password_sign_up", "signup_confirmation", "password_sign_in", "password_recovery_update"]) {
  assert(background.includes(source), `background must preserve approved credential completion source: ${source}`);
}

const verifyRecovery = extractFunction(background, "identityAuthManager_verifyPasswordRecoveryCode");
assert(verifyRecovery.includes('rt.status !== "recovery_code_pending"') &&
  verifyRecovery.includes("identityProviderPasswordUpdateRequired_store") &&
  verifyRecovery.includes("identityProviderPasswordUpdateRequired_runtimeFromSession") &&
  !verifyRecovery.includes("identityProviderSession_publishSafeRuntime"),
  "recovery-code verification must publish password_update_required before any ready restore");
const updateRecovery = extractFunction(background, "identityAuthManager_updatePasswordAfterRecovery");
assert(updateRecovery.includes('rt.status !== "password_update_required"') &&
  updateRecovery.includes("identityProviderBundle_updatePasswordAfterRecovery") &&
  updateRecovery.includes("identityProviderCredentialState_markCompleteForSession") &&
  updateRecovery.includes("identityProviderPasswordUpdateRequired_remove") &&
  updateRecovery.includes("honorPasswordUpdateRequired: false"),
  "set-password must be mandatory, mark credential complete, clear marker, then allow restore");
const cloudRestore = extractFunction(background, "identityProviderSession_tryCloudIdentityRestore");
assert(cloudRestore.includes("identityCredentialState_isComplete") &&
  cloudRestore.includes("password_update_required"),
  "persistent/cloud restore must not publish sync_ready when credentialState is required or unknown");
const completeOnboarding = extractFunction(background, "identityAuthManager_completeOnboarding");
assert(completeOnboarding.includes("identityProviderPasswordUpdateRequired_isActive()") &&
  completeOnboarding.includes("identityCredentialState_isComplete(rt.credentialState)") &&
  completeOnboarding.indexOf("identityProviderPasswordUpdateRequired_isActive()") <
    completeOnboarding.indexOf("identityProviderBundle_completeOnboarding"),
  "complete-onboarding must fail closed while password setup is required");
const signOutCleanup = extractFunction(background, "identityAuthManager_clearSignOutLocalState");
assert(background.includes(`"${SESSION_KEY}"`) &&
  signOutCleanup.includes("providerSessionRemove([IDENTITY_PROVIDER_SESSION_KEY]") &&
  signOutCleanup.includes("activeSessionRemoveOk"),
  `sign-out cleanup must remove credential key: ${SESSION_KEY}`);
assert(background.includes(`"${PERSISTENT_KEY}"`) &&
  signOutCleanup.includes("providerPersistentRefreshRemove([IDENTITY_PROVIDER_PERSISTENT_REFRESH_KEY]") &&
  signOutCleanup.includes("persistentRemoveOk"),
  `sign-out cleanup must remove credential key: ${PERSISTENT_KEY}`);
assert(background.includes(`"${PASSWORD_MARKER_KEY}"`) &&
  signOutCleanup.includes("providerPersistentRefreshRemove([IDENTITY_PROVIDER_PASSWORD_UPDATE_REQUIRED_KEY]") &&
  signOutCleanup.includes("passwordUpdateMarkerRemoveOk"),
  `sign-out cleanup must remove credential key: ${PASSWORD_MARKER_KEY}`);

assert(background.includes("identityRuntime_enforceConsistency") &&
  background.includes('credentialState !== "complete"') &&
  background.includes('status: "password_update_required"'),
  "runtime consistency must enforce password_update_required for incomplete credentials");
assert(background.includes("identitySnapshot_sanitize") &&
  background.includes('k !== "credentialState"'),
  "background public sanitizer must allow only safe credentialState credential field");
assert(!/\b(providerIdentities|identities|identity_password_status)\b/.test(identityCore + identitySurfaceJs + identitySurfaceHtml + controlHub),
  "public UI/Core surfaces must not expose raw provider identities or password status rows");

assert(identityCore.includes("credentialState") &&
  identityCore.includes("currentCredentialState !== 'complete'") &&
  identityCore.includes("identity/password-update-required"),
  "Identity Core must expose only safe credentialState and block onboarding when password setup is required");
const identitySurface = `${identitySurfaceJs}\n${identitySurfaceHtml}`;
assert(identitySurfaceJs.includes("api.verifyPasswordRecoveryCode") &&
  identitySurfaceJs.includes("api.updatePasswordAfterRecovery") &&
  identitySurfaceJs.includes("Verify recovery code") &&
  identitySurfaceJs.includes("Send new recovery code") &&
  identitySurface.includes("Set a new password for future sign-ins."),
  "identity UI must include separated recovery code and mandatory set-password panels");
assert(identitySurfaceJs.includes("clearPasswordFields") &&
  identitySurfaceJs.includes("refs.otpCode.value = ''"),
  "identity UI must clear password/code form state");
assert(controlHubAccountSurface.includes("credentialState") &&
  controlHubAccountSurface.includes("Password set"),
  "Account tab must show safe credential status only");

for (const [label, source] of [
  ["Identity Core", identityCore],
  ["identity.js", identitySurfaceJs],
  ["identity.html", identitySurfaceHtml],
  ["identity.css", identitySurfaceCss],
  ["loader", loader],
  ["Control Hub Account plugin", controlHubAccount],
]) {
  assertPageBoundary(label, source);
  assertNoPasswordStorage(label, source);
}

assert(background.includes('const IDENTITY_PROVIDER_PERSISTENT_REFRESH_KEY = "h2oIdentityProviderPersistentRefreshV1"') &&
  background.includes("identityProviderPersistentRefresh_storeFromSession") &&
  !/chrome\.storage\.local[^\n;]*(access_token|h2oIdentityProviderSessionV1)/i.test(background),
  "persistent sign-in must remain refresh-token-only and background-owned");
assert(docs.includes("No password values in localStorage, sessionStorage, chrome.storage, snapshots, diagnostics, bridge responses, or logs."),
  "docs must preserve password no-storage/no-log release assertion");
assert(docs.includes("No access_token, full session, or raw user in `chrome.storage.local`."),
  "docs must preserve persistent storage release assertion");
assert(docs.includes("Public state may expose only safe `credentialState`."),
  "docs must preserve public credentialState-only assertion");

console.log("Identity Phase 3.8F password auth release-gate validation passed.");
