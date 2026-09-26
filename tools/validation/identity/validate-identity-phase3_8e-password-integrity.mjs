// Identity Phase 3.8E validation - password integrity gate.
// Static only; no Supabase/network access and no storage mutation.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SURFACES_BASE_REL } from "../../paths.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const MIGRATION_REL = "supabase/migrations/202605010003_identity_password_status.sql";
const LOAD_IDENTITY_CREDENTIAL_FIX_REL = "supabase/migrations/202605010004_identity_load_identity_state_credential_gate_fix.sql";
const PROVIDER_REL = "tools/product/identity/identity-provider-supabase.entry.mjs";
const BACKGROUND_REL = "tools/product/extensions/chatgpt/chrome/chrome-live-background.mjs";
const LOADER_REL = "tools/product/extensions/chatgpt/chrome/chrome-live-loader.mjs";
const IDENTITY_CORE_REL = "src-runtime-base/0D4a.⬛️🔐 Identity Core 🔐.js";
const IDENTITY_SURFACE_JS_REL = `${SURFACES_BASE_REL}/identity/identity.js`;
const IDENTITY_SURFACE_HTML_REL = `${SURFACES_BASE_REL}/identity/identity.html`;
const CONTROL_HUB_REL = "src-runtime-base/0Z1a.⬛️🕹️ Control Hub 🕹️.js";
const CONTROL_HUB_ACCOUNT_REL = "src-runtime-base/0Z1e.⚫️🔐 Account Tab (Control Hub 🔌 Plugin) 🔐.js";
const RELEASE_RUNNER_REL = "tools/validation/identity/run-identity-release-gate.mjs";
const DOC_REL = "docs/identity/IDENTITY_PHASE_3_0_SUPABASE_PREP.md";

function read(rel) {
  return fs.readFileSync(path.join(REPO_ROOT, rel), "utf8");
}

function assert(condition, message) {
  if (!condition) throw new Error(`FAIL: ${message}`);
}

function extractFunction(source, name) {
  const syncIndex = source.indexOf(`function ${name}(`);
  const asyncIndex = source.indexOf(`async function ${name}(`);
  const sqlIndex = source.toLowerCase().indexOf(`function public.${name.toLowerCase()}`);
  const start = sqlIndex >= 0
    ? sqlIndex
    : ((asyncIndex >= 0 && (syncIndex < 0 || asyncIndex < syncIndex)) ? asyncIndex : syncIndex);
  if (start === -1) return "";
  if (sqlIndex >= 0) {
    const end = source.indexOf("$$;", start);
    return end > start ? source.slice(start, end + 3) : "";
  }
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

function assertNoPageProviderOwnership(label, source) {
  assert(!/@supabase\/supabase-js|@supabase\//i.test(source),
    `${label}: must not import Supabase SDK`);
  assert(!/identity-provider-supabase|H2O_IDENTITY_PROVIDER_BUNDLE_PROBE/.test(source),
    `${label}: must not import or probe provider bundle`);
  assert(!/\.rpc\s*\(|\.from\s*\(\s*['"`](profiles|workspaces|workspace_memberships|identity_password_status)['"`]/.test(source),
    `${label}: must not call Supabase directly`);
  assert(!/\b(service_role|service-role|serviceRoleKey)\b/i.test(source),
    `${label}: must not contain service-role strings`);
}

function stripJsComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

function assertNoUiLeakFields(label, source) {
  assert(!/\b(access_token|refresh_token|rawSession|rawUser|owner_user_id|deleted_at)\b/.test(source),
    `${label}: must not contain token/session/raw-user or unsafe DB field names`);

  // Phase 3.8E integrity is about actual secret persistence, not textual
  // proximity. Strip comments first, then inspect only storage WRITE calls.
  // This keeps harmless diagnostics such as "...localStorage...pilotPlan..."
  // from matching "otp" inside an unrelated identifier while remaining
  // fail-closed for password / OTP / code material passed to storage APIs.
  const executable = stripJsComments(source);
  const pageStorageSecretWrite =
    /(?:localStorage|sessionStorage)\s*\.\s*setItem\s*\([\s\S]{0,600}?(?:\bpassword\b|\botp\b|\bcode\b|Password\b|Otp\b|Code\b)[\s\S]{0,600}?\)/.test(executable);
  const chromeStorageSecretWrite =
    /chrome\.storage\.(?:local|session|sync)\s*\.\s*set\s*\([\s\S]{0,1200}?(?:\bpassword\b|\botp\b|\bcode\b|Password\b|Otp\b|Code\b)[\s\S]{0,1200}?\)/.test(executable);

  assert(!pageStorageSecretWrite && !chromeStorageSecretWrite,
    `${label}: password/code values must not be written to storage`);
}

console.log("\n-- Identity Phase 3.8E password integrity validation -----------");

const migration = read(MIGRATION_REL);
const loadIdentityCredentialFix = read(LOAD_IDENTITY_CREDENTIAL_FIX_REL);
const provider = read(PROVIDER_REL);
const background = read(BACKGROUND_REL);
const loader = read(LOADER_REL);
const identityCore = read(IDENTITY_CORE_REL);
const identitySurfaceJs = read(IDENTITY_SURFACE_JS_REL);
const identitySurfaceHtml = read(IDENTITY_SURFACE_HTML_REL);
const controlHub = read(CONTROL_HUB_REL);
const controlHubAccount = read(CONTROL_HUB_ACCOUNT_REL);
const controlHubAccountSurface = `${controlHub}\n${controlHubAccount}`;
const releaseRunner = read(RELEASE_RUNNER_REL);
const docs = read(DOC_REL);
const normalizedSql = migration.replace(/--.*$/gm, "").replace(/\s+/g, " ").toLowerCase();

assert(/create\s+table\s+if\s+not\s+exists\s+public\.identity_password_status/i.test(migration),
  "migration must create separate password status table");
assert(/user_id\s+uuid\s+primary\s+key\s+references\s+auth\.users\s*\(\s*id\s*\)\s+on\s+delete\s+cascade/i.test(migration),
  "password status table must be keyed by auth user");
assert(/password_setup_completed\s+boolean\s+not\s+null\s+default\s+false/i.test(migration),
  "password status table must default incomplete");
assert(normalizedSql.includes("alter table public.identity_password_status enable row level security") &&
  normalizedSql.includes("alter table public.identity_password_status force row level security"),
  "password status table must enable and force RLS");
assert(/revoke\s+all\s+on\s+table\s+public\.identity_password_status\s+from\s+anon\s*,\s*authenticated\s*,\s*public/i.test(migration),
  "normal roles must not have direct password status table access");
assert(!/grant\s+[^;]*\b(?:insert|update|delete)\b[^;]*public\.identity_password_status[^;]*to\s+authenticated/i.test(migration),
  "normal authenticated users must not receive direct password status write grants");
assert(/create\s+or\s+replace\s+function\s+public\.mark_password_setup_completed\s*\(\s*p_source\s+text\s*\)/i.test(migration) &&
  /security\s+definer/i.test(extractFunction(migration, "mark_password_setup_completed")) &&
  /v_uid\s+uuid\s*:=\s*auth\.uid\s*\(\s*\)/i.test(extractFunction(migration, "mark_password_setup_completed")) &&
  /insert\s+into\s+public\.identity_password_status/i.test(extractFunction(migration, "mark_password_setup_completed")),
  "password setup completion must be changed only through authenticated SECURITY DEFINER RPC");
assert(/revoke\s+all\s+on\s+function\s+public\.mark_password_setup_completed\s*\(\s*text\s*\)\s+from\s+anon\s*,\s*public/i.test(migration) &&
  /grant\s+execute\s+on\s+function\s+public\.mark_password_setup_completed\s*\(\s*text\s*\)\s+to\s+authenticated/i.test(migration),
  "password setup RPC must deny anon/public and grant authenticated execute");
const loadIdentityStateSql = extractFunction(migration, "load_identity_state");
assert(loadIdentityStateSql.includes("identity_password_status") &&
  loadIdentityStateSql.includes("'credential_state'") &&
  !/'owner_user_id'|'deleted_at'/.test(loadIdentityStateSql),
  "load_identity_state must return safe credential_state without raw private rows");
const latestLoadIdentityStateSql = extractFunction(loadIdentityCredentialFix, "load_identity_state");
assert(latestLoadIdentityStateSql.includes("identity_password_status") &&
  latestLoadIdentityStateSql.includes("'credential_state'") &&
  latestLoadIdentityStateSql.includes("coalesce(") &&
  latestLoadIdentityStateSql.includes("'required'") &&
  !/'owner_user_id'|'deleted_at'/.test(latestLoadIdentityStateSql),
  "latest load_identity_state fix must explicitly return credential_state required for missing password status without raw private rows");

const providerMark = extractFunction(provider, "markPasswordSetupCompleted");
assert(providerMark.includes('client.rpc("mark_password_setup_completed"') &&
  providerMark.includes("normalizeProviderCredentialState") &&
  !/return\s+\{[\s\S]*rawSession\s*:/.test(providerMark) &&
  !/return\s+\{[\s\S]*user\s*:/.test(providerMark),
  "provider must own mark_password_setup_completed RPC and return no raw session/user");
assert(extractFunction(provider, "normalizeProviderIdentityStateResult").includes("credentialState"),
  "provider identity restore sanitizer must include safe credentialState");
assert((provider.match(/\.rpc\s*\(/g) || []).length === 7 &&
  provider.includes('client.rpc("mark_oauth_credential_completed"') &&
  provider.includes('client.rpc("register_device_session"'),
  "provider source must have only approved identity RPC helpers, including Google OAuth credential completion");
assert(provider.includes('client.rpc("update_identity_profile"') &&
  provider.includes('client.rpc("rename_identity_workspace"'),
  "provider source must include only approved account-security RPC helpers for profile/workspace edits");
assert(!/\.from\s*\(/.test(provider), "provider must not use direct table access");

assert(background.includes("function identityCredentialState_normalize(") &&
  background.includes("identitySnapshot_sanitize") &&
  background.includes('k !== "credentialState"'),
  "background must allow only safe credentialState through public sanitization");
assert(background.includes("identityProviderCredentialState_markCompleteForSession") &&
  background.includes("identityProviderBundle_markPasswordSetupCompleted") &&
  background.includes("markPasswordSetupCompletedRunner"),
  "background must mark password setup only through provider RPC helper");
for (const source of ["password_sign_up", "signup_confirmation", "password_sign_in", "password_recovery_update"]) {
  assert(background.includes(source), `background must mark completion source: ${source}`);
}
const normalVerify = extractFunction(background, "identityAuthManager_verifyEmailOtp");
assert(normalVerify.includes("identityProviderSession_publishSafeRuntime") &&
  !normalVerify.includes("identityProviderOnboarding_runtime("),
  "normal email-code verification must route through credential-gated cloud restore, not directly to ready");
const cloudRestore = extractFunction(background, "identityProviderSession_tryCloudIdentityRestore");
assert(cloudRestore.includes("identityCredentialState_isComplete") &&
  cloudRestore.includes("identityProviderPasswordUpdateRequired_storeReason(\"credential_required\")") &&
  cloudRestore.includes("password_update_required"),
  "cloud restore must block sync_ready unless credentialState is complete");
const completeOnboarding = extractFunction(background, "identityAuthManager_completeOnboarding");
assert(completeOnboarding.includes("identityCredentialState_isComplete(rt.credentialState)") &&
  completeOnboarding.includes("identity/onboarding-password-update-required") &&
  completeOnboarding.indexOf("identityCredentialState_isComplete(rt.credentialState)") <
    completeOnboarding.indexOf("identityProviderBundle_completeOnboarding"),
  "complete-onboarding must fail closed before RPC when credentialState is not complete");
const runtimeConsistency = extractFunction(background, "identityRuntime_enforceConsistency");
assert(runtimeConsistency.includes("credentialState !== \"complete\"") &&
  runtimeConsistency.includes("password_update_required"),
  "runtime consistency must prevent provider-backed ready states without complete credentials");

assert(identityCore.includes("credentialState") &&
  identityCore.includes("normalizeCredentialState") &&
  identityCore.includes("currentCredentialState !== 'complete'") &&
  identityCore.includes("identity/password-update-required") &&
  identityCore.includes("isProviderOwnedSnapshot") &&
  identityCore.includes("bridgeIsAnonymous && localIsProviderOwned") &&
  identityCore.includes("incomingIsAnonymous && localIsProviderOwned"),
  "Identity Core must expose only safe credentialState, block onboarding while required/unknown, and clear stale provider-owned setup state when bridge is signed out");
assert(controlHubAccountSurface.includes("credentialState") && controlHubAccountSurface.includes("Password setup required"),
  "Account tab must display safe credential status only");

for (const [label, source] of [
  ["Identity Core", identityCore],
  ["identity.js", identitySurfaceJs],
  ["identity.html", identitySurfaceHtml],
  ["loader", loader],
  ["Control Hub Account plugin", controlHubAccount],
]) {
  assertNoPageProviderOwnership(label, source);
  assertNoUiLeakFields(label, source);
}

assert(releaseRunner.includes("tools/validation/identity/validate-identity-phase3_8e-password-integrity.mjs"),
  "release runner must include the 3.8E password integrity validator");
assert(docs.includes("Phase 3.8E - Password Integrity Gate") &&
  docs.includes("credentialState") &&
  docs.includes("identity_password_status") &&
  docs.includes("mark_password_setup_completed"),
  "docs must document the Phase 3.8E password integrity gate");

console.log("Identity Phase 3.8E password integrity validation passed.");
