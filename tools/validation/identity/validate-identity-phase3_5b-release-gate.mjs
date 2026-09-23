// Identity Phase 3.5B validation - release-gate checklist.
// Static only; no Supabase/network access and no repo mutation.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extensionBuildDir, SURFACES_BASE_REL } from "../../paths.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

// Phase 4B-1b: CWD-relative path string for an extension build artifact.
// Byte-identical to legacy "build/chrome-ext-<variant>/<segments>" form.
//
// THIS ONE FOLLOWS THE ENVIRONMENT, AND MUST: `extensionBuildDir()` honours
// H2O_EXT_BUILD_ROOT so the source-safe release gate can send build OUTPUT to a
// per-run temporary root, and the manifest reads below have to inspect what the
// current execution actually built.
function extBuildRel(variant, ...segments) {
  return path.relative(REPO_ROOT, path.join(extensionBuildDir(variant), ...segments));
}

// THIS ONE MUST NOT. A documented build command states the Extension's canonical
// layout, not where one run happened to write, so a relocated build root cannot
// be allowed to redefine what static documentation is required to advertise -
// that is how this gate came to demand an ephemeral per-run path from a correct
// document. The canonical answer still comes from the one authority that owns
// the layout, with the relocation input neutralised for the length of the call,
// rather than restated here where it would drift the next time the Extension
// moves.
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
const IDENTITY_CORE_REL = "src-runtime-base/0D4a.⬛️🔐 Identity Core 🔐.js";
const IDENTITY_SURFACE_JS_REL = `${SURFACES_BASE_REL}/identity/identity.js`;
const IDENTITY_SURFACE_HTML_REL = `${SURFACES_BASE_REL}/identity/identity.html`;
const IDENTITY_SURFACE_CSS_REL = `${SURFACES_BASE_REL}/identity/identity.css`;
const CONTROL_HUB_REL = "src-runtime-base/0Z1a.⬛️🕹️ Control Hub 🕹️.js";
const CONTROL_HUB_ACCOUNT_REL = "src-runtime-base/0Z1e.⚫️🔐 Account Tab (Control Hub 🔌 Plugin) 🔐.js";
const RELEASE_RUNNER_REL = "tools/validation/identity/run-identity-release-gate.mjs";
const ARMED_MANIFEST_REL = extBuildRel("dev-controls-armed", "manifest.json");
const PROD_MANIFEST_REL = extBuildRel("prod", "manifest.json");

const ACTIVE_BUILDS = [
  "node tools/product/extensions/chatgpt/chrome/build-chrome-live-extension.mjs",
  `env H2O_EXT_DEV_VARIANT=lean H2O_EXT_OUT_DIR=${canonicalExtBuildRel("dev-lean")} node tools/product/extensions/chatgpt/chrome/build-chrome-live-extension.mjs`,
  `env H2O_EXT_DEV_VARIANT=production H2O_EXT_OUT_DIR=${canonicalExtBuildRel("prod")} node tools/product/extensions/chatgpt/chrome/build-chrome-live-extension.mjs`,
  `env H2O_IDENTITY_PHASE_NETWORK=request_otp H2O_EXT_OUT_DIR=${canonicalExtBuildRel("dev-controls-armed")} node tools/product/extensions/chatgpt/chrome/build-chrome-live-extension.mjs`,
  `env H2O_IDENTITY_PHASE_NETWORK=request_otp H2O_IDENTITY_OAUTH_PROVIDER=google H2O_EXT_OUT_DIR=${canonicalExtBuildRel("dev-controls-oauth-google")} node tools/product/extensions/chatgpt/chrome/build-chrome-live-extension.mjs`,
  "node tools/product/extensions/chatgpt/chrome/pack-ops-panel.mjs",
];

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

const SYNTAX_COMMANDS = [
  "node --check tools/validation/identity/validate-identity-phase3_5b-release-gate.mjs",
  "node --check tools/validation/identity/validate-identity-phase3_7a-persistent-signin.mjs",
  "node --check tools/validation/identity/validate-identity-phase3_7b-production-polish.mjs",
  "node --check tools/validation/identity/validate-identity-phase3_8a-password-auth.mjs",
  "node --check tools/validation/identity/validate-identity-phase3_8b-auth-ux-separation.mjs",
  "node --check tools/validation/identity/validate-identity-phase3_8c-account-verification.mjs",
  "node --check tools/validation/identity/validate-identity-phase3_8d-email-code-recovery.mjs",
  "node --check tools/validation/identity/validate-identity-phase3_8e-password-integrity.mjs",
  "node --check tools/validation/identity/validate-identity-phase3_8f-password-auth-release-gate.mjs",
  "node --check tools/validation/identity/validate-identity-phase3_9b-google-oauth.mjs",
  "node --check tools/validation/identity/validate-identity-phase3_9c-google-oauth-release-gate.mjs",
  "node --check tools/validation/identity/validate-identity-phase4_0b-account-security-mvp.mjs",
  "node --check src-runtime-base/0Z1e.⚫️🔐 Account Tab (Control Hub 🔌 Plugin) 🔐.js",
  `node --check ${canonicalExtBuildRel("dev-controls", "bg.js")}`,
  `node --check ${canonicalExtBuildRel("dev-controls", "loader.js")}`,
  `node --check ${canonicalExtBuildRel("dev-controls", "popup.js")}`,
  `node --check ${canonicalExtBuildRel("dev-controls", "provider/identity-provider-supabase.js")}`,
  `node --check ${canonicalExtBuildRel("dev-lean", "bg.js")}`,
  `node --check ${canonicalExtBuildRel("dev-lean", "loader.js")}`,
  `node --check ${canonicalExtBuildRel("dev-lean", "provider/identity-provider-supabase.js")}`,
  `node --check ${canonicalExtBuildRel("prod", "bg.js")}`,
  `node --check ${canonicalExtBuildRel("prod", "loader.js")}`,
  `node --check ${canonicalExtBuildRel("prod", "provider/identity-provider-supabase.js")}`,
  `node --check ${canonicalExtBuildRel("dev-controls-armed", "bg.js")}`,
  `node --check ${canonicalExtBuildRel("dev-controls-armed", "loader.js")}`,
  `node --check ${canonicalExtBuildRel("dev-controls-armed", "popup.js")}`,
  `node --check ${canonicalExtBuildRel("dev-controls-armed", "provider/identity-provider-supabase.js")}`,
  `node --check ${canonicalExtBuildRel("dev-controls-oauth-google", "bg.js")}`,
  `node --check ${canonicalExtBuildRel("dev-controls-oauth-google", "loader.js")}`,
  `node --check ${canonicalExtBuildRel("dev-controls-oauth-google", "popup.js")}`,
  `node --check ${canonicalExtBuildRel("dev-controls-oauth-google", "provider/identity-provider-supabase.js")}`,
  `node --check ${canonicalExtBuildRel("ops-panel", "panel.js")}`,
];

const LIVE_RLS_ENV = [
  "H2O_SUPABASE_RLS_LIVE=1",
  "H2O_SUPABASE_TEST_URL",
  "H2O_SUPABASE_TEST_ANON_KEY",
  "H2O_SUPABASE_TEST_SERVICE_ROLE_KEY",
  "H2O_SUPABASE_RLS_LIVE_REQUIRED=1",
  "H2O_SUPABASE_RLS_PRIVILEGE_FALLBACK_CONFIRMED=1",
  "H2O_SUPABASE_RLS_ANON_CAN_EXECUTE=false",
  "H2O_SUPABASE_RLS_AUTHENTICATED_CAN_EXECUTE=true",
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

function extractSection(source, heading, nextHeadingPattern) {
  const start = source.indexOf(heading);
  if (start < 0) return "";
  const rest = source.slice(start);
  const next = rest.search(nextHeadingPattern);
  return next > 0 ? rest.slice(0, next) : rest;
}

function arrayEquals(actual, expected) {
  return Array.isArray(actual) &&
    actual.length === expected.length &&
    actual.every((value, index) => value === expected[index]);
}

function assertNoBroadHosts(label, manifest) {
  const hosts = [
    ...(manifest.host_permissions || []),
    ...(manifest.optional_host_permissions || []),
  ];
  assert(!hosts.includes("*://*/*"), `${label}: broad all-host permission must not appear`);
  assert(!hosts.includes("<all_urls>"), `${label}: <all_urls> permission must not appear`);
}

function assertNoPageProviderOwnership(label, source) {
  assert(!/@supabase\/supabase-js|@supabase\//i.test(source),
    `${label}: must not import Supabase SDK`);
  assert(!/identity-provider-supabase|H2O_IDENTITY_PROVIDER_BUNDLE_PROBE/.test(source),
    `${label}: must not import or probe provider bundle`);
  assert(!/\.rpc\s*\(/.test(source),
    `${label}: must not call Supabase RPC`);
  assert(!/\.from\s*\(\s*['"`](profiles|workspaces|workspace_memberships)['"`]/.test(source),
    `${label}: must not call identity tables`);
  assert(!/\b(service_role|service-role|serviceRoleKey)\b/i.test(source),
    `${label}: must not contain service-role strings`);
  assert(!/\b(access_token|refresh_token|rawSession|rawUser|owner_user_id|deleted_at)\b/.test(source),
    `${label}: must not contain raw token/session/user or unsafe DB fields`);
}

function assertNoPagePersistentInternals(label, source) {
  assert(!/h2oIdentityProviderPersistentRefreshV1|persistentRefresh|rememberDevice|remember-device|\brefresh_token\b/i.test(source),
    `${label}: persistent refresh-token internals must not exist outside background`);
  assert(!/keep me signed in/i.test(source),
    `${label}: keep-me-signed-in UI/behavior must not exist`);
}

console.log("\n-- Identity Phase 3.5B release-gate validation ------------------");

const docs = read(DOC_REL);
const phase35b = extractSection(docs, "## 15.16 Phase 3.5B - Identity Release Gate", /\n## 16\./);
const phase36a = extractSection(docs, "## 15.17 Phase 3.6A - Production Readiness Review Outcome", /\n## 15\.18/);
const phase36b = extractSection(docs, "## 15.18 Phase 3.6B - Identity Release Runner", /\n## 16\./);
const gitignore = read(GITIGNORE_REL);
const background = read(BACKGROUND_REL);
const loader = read(LOADER_REL);
const identityCore = read(IDENTITY_CORE_REL);
const identitySurfaceJs = read(IDENTITY_SURFACE_JS_REL);
const identitySurfaceHtml = read(IDENTITY_SURFACE_HTML_REL);
const identitySurfaceCss = read(IDENTITY_SURFACE_CSS_REL);
const controlHub = read(CONTROL_HUB_REL);
const controlHubAccount = read(CONTROL_HUB_ACCOUNT_REL);
const releaseRunner = read(RELEASE_RUNNER_REL);
const armedManifest = readJson(ARMED_MANIFEST_REL);
const prodManifest = readJson(PROD_MANIFEST_REL);

assert(phase35b, "docs must include Phase 3.5B Identity Release Gate section");
assert(phase35b.includes("release-gate checklist") && phase35b.includes("Phase 4.0B"),
  "3.5B docs must state the release gate covers the current Phase 4.0B account/security policy");
assert(phase35b.includes("Final release-gate build commands"),
  "3.5B docs must include build command checklist");
assert(phase35b.includes("Final release-gate validator commands"),
  "3.5B docs must include validator command checklist");
assert(phase35b.includes("Generated syntax-check commands"),
  "3.5B docs must include syntax-check checklist");

for (const command of ACTIVE_BUILDS) {
  assert(phase35b.includes(command), `3.5B docs must list build command: ${command}`);
}
for (const rel of ACTIVE_VALIDATORS) {
  assert(exists(rel), `${rel} must exist`);
  assert(phase35b.includes(`node ${rel}`), `3.5B docs must list validator command for ${rel}`);
}
for (const command of SYNTAX_COMMANDS) {
  assert(phase35b.includes(command), `3.5B docs must list syntax command: ${command}`);
}
for (const envName of LIVE_RLS_ENV) {
  assert(phase35b.includes(envName), `3.5B docs must list live RLS env: ${envName}`);
}

assert(phase35b.includes("skips by default") && phase35b.includes("dev or disposable Supabase project"),
  "3.5B docs must document live RLS as skip-by-default and dev/disposable only");
assert(phase35b.includes("service-role key is allowed only in this live harness environment"),
  "3.5B docs must confine service-role key to live harness env");
assert(phase35b.includes("validate-onboarding-url.mjs") && phase35b.includes("legacy reference only"),
  "3.5B docs must classify validate-onboarding-url.mjs as legacy only");
assert(!docs.includes("node tools/validation/onboarding/validate-onboarding-url.mjs"),
  "legacy validate-onboarding-url.mjs must not appear as an active command");
assert(phase35b.includes("system-connectors") && phase35b.includes("QuotaExceededError") && phase35b.includes("separate follow-up"),
  "3.5B docs must keep system-connectors QuotaExceededError separate");
assert(phase35b.includes("Persistent sign-in is implemented in Phase 3.7A"),
  "3.5B docs must identify Phase 3.7A persistent sign-in as the current policy");
assert(phase35b.includes("refresh token only") && phase35b.includes("no access token"),
  "3.5B docs must list refresh-token-only persistence boundaries");
assert(phase36a.includes("ready as a stable milestone with conditions"),
  "3.6A docs must record ready-with-conditions outcome");
assert(phase36a.includes("not product-complete"),
  "3.6A docs must clarify identity is not product-complete");
assert(phase36a.includes("Persistent sign-in was implemented in Phase 3.7A"),
  "3.6A docs must identify persistent sign-in as implemented after the review");
assert(docs.includes("Phase 3.7B - Persistent Sign-In Production Polish") &&
  /public bridge responses are production-minimal/i.test(docs),
  "docs must document Phase 3.7B production-minimal public bridge responses");
assert(docs.includes("Phase 3.8A - Email and Password Auth") &&
  docs.includes("Password reset is request-only"),
  "docs must document Phase 3.8A password auth boundaries");
assert(docs.includes("Phase 3.8B - Auth UX Separation") &&
  docs.includes("shouldCreateUser:false"),
  "docs must document Phase 3.8B auth UX separation boundaries");
assert(docs.includes("Phase 3.8C - Account Creation Verification") &&
  docs.includes("type:\"email\"") &&
  docs.includes("type:\"signup\""),
  "docs must document Phase 3.8C signup confirmation boundaries");
assert(docs.includes("Phase 3.8D - Email-Code Recovery and Set Password") &&
  docs.includes("password_update_required") &&
  docs.includes("h2oIdentityProviderPasswordUpdateRequiredV1"),
  "docs must document Phase 3.8D recovery-code password update boundaries");
assert(docs.includes("Phase 3.8E - Password Integrity Gate") &&
  docs.includes("identity_password_status") &&
  docs.includes("credentialState") &&
  docs.includes("mark_password_setup_completed"),
  "docs must document Phase 3.8E password integrity boundaries");
assert(docs.includes("Phase 3.8F - Password Auth Release Gate") &&
  docs.includes("Reset password remains request-only") &&
  docs.includes("Microsoft/GitHub/Apple OAuth/social login remains deferred") &&
  docs.includes("MFA remains deferred") &&
  docs.includes("credentialState is the only public password status field"),
  "docs must document Phase 3.8F final password-auth release-gate boundaries");
assert(docs.includes("Phase 3.9B - Google OAuth") &&
  docs.includes("chrome.identity.getRedirectURL(\"identity/oauth/google\")") &&
  docs.includes("provider_token") &&
  docs.includes("provider_refresh_token") &&
  docs.includes("Account linking remains deferred"),
  "docs must document Phase 3.9B Google OAuth release boundaries");
assert(docs.includes("Phase 3.9C - Google OAuth Release Gate") &&
  docs.includes("https://ogcjkeaiicglflamhjaaimdhphjlgkbb.chromiumapp.org/identity/oauth/google") &&
  docs.includes("https://kjwrrkqqtxyxtuigianr.supabase.co/auth/v1/callback") &&
  docs.includes("Google Cloud OAuth client type") &&
  docs.includes("Web application") &&
  docs.includes("Production rollout requires a separate deployment gate"),
  "docs must document Phase 3.9C Google OAuth release-gate boundaries");
assert(docs.includes("Phase 4.0B - Account & Security MVP") &&
  docs.includes("update_identity_profile") &&
  docs.includes("rename_identity_workspace") &&
  docs.includes("current_password") &&
  docs.includes("password_account_change") &&
  docs.includes("Add password is deferred"),
  "docs must document Phase 4.0B Account & Security MVP boundaries");
assert(phase36b.includes("node tools/validation/identity/run-identity-release-gate.mjs"),
  "3.6B docs must list the release-runner command");
assert(/does not edit source files/i.test(phase36b) && /does not require live Supabase credentials/i.test(phase36b),
  "3.6B docs must document runner as non-mutating and credential-free by default");
assert(releaseRunner.includes("Identity release-gate runner"),
  "release runner must identify itself as identity release gate");
assert(releaseRunner.includes("spawnSync"),
  "release runner must execute commands explicitly");
assert(releaseRunner.includes("tools/validation/identity/validate-identity-phase3_2c-rls-live.mjs"),
  "release runner must include live RLS validator with its skip-by-default behavior");
assert(releaseRunner.includes("tools/validation/identity/validate-identity-phase3_7b-production-polish.mjs"),
  "release runner must include the Phase 3.7B production polish validator");
assert(releaseRunner.includes("tools/validation/identity/validate-identity-phase3_8a-password-auth.mjs"),
  "release runner must include the Phase 3.8A password auth validator");
assert(releaseRunner.includes("tools/validation/identity/validate-identity-phase3_8b-auth-ux-separation.mjs"),
  "release runner must include the Phase 3.8B auth UX separation validator");
assert(releaseRunner.includes("tools/validation/identity/validate-identity-phase3_8c-account-verification.mjs"),
  "release runner must include the Phase 3.8C account verification validator");
assert(releaseRunner.includes("tools/validation/identity/validate-identity-phase3_8d-email-code-recovery.mjs"),
  "release runner must include the Phase 3.8D email-code recovery validator");
assert(releaseRunner.includes("tools/validation/identity/validate-identity-phase3_8e-password-integrity.mjs"),
  "release runner must include the Phase 3.8E password integrity validator");
assert(releaseRunner.includes("tools/validation/identity/validate-identity-phase3_8f-password-auth-release-gate.mjs"),
  "release runner must include the Phase 3.8F password auth release-gate validator");
assert(releaseRunner.includes("tools/validation/identity/validate-identity-phase3_9b-google-oauth.mjs"),
  "release runner must include the Phase 3.9B Google OAuth validator");
assert(releaseRunner.includes("tools/validation/identity/validate-identity-phase3_9c-google-oauth-release-gate.mjs"),
  "release runner must include the Phase 3.9C Google OAuth release-gate validator");
assert(releaseRunner.includes("tools/validation/identity/validate-identity-phase4_0b-account-security-mvp.mjs"),
  "release runner must include the Phase 4.0B Account & Security MVP validator");
/*
 * The source-safe repository-safety invariant.
 *
 * The old form of this check rejected the runner if its source contained
 * `writeFile` at all. That was a true statement about a runner that wrote
 * nothing, and it stopped being a safety property the moment the runner earned a
 * governed temporary root: it now legitimately materialises icon fixtures and
 * transformed validator copies beneath that root, and a literal ban could only
 * be satisfied by removing the containment machinery or by lying about it.
 *
 * What actually matters is not whether bytes are written but WHERE, and whether
 * the runner can still reach the repository. So each rule below is checked
 * against the destination of every write, the containment logic that bounds
 * them, and the cleanup that removes them - and each one fails closed: an
 * unrecognised write sink is a failure, not an exemption.
 */
{
  const stripped = releaseRunner
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

  // 1. No Product/repository mutation: every write sink must resolve to a
  //    SOURCE_SAFE_* destination, directly or through a local binding.
  const WRITE_SINKS = [
    "writeFileSync", "appendFileSync", "createWriteStream", "copyFileSync",
    "renameSync", "truncateSync", "openSync", "cpSync", "writeFile", "appendFile",
  ];
  const sinkPattern = new RegExp(
    `fs\\.(${WRITE_SINKS.join("|")})\\(\\s*([\\s\\S]{0,200}?)[,)]`,
    "g",
  );
  const sourceSafeBindings = new Set();
  for (const match of stripped.matchAll(
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*path\.(?:join|resolve)\(\s*SOURCE_SAFE_[\w$]*/g,
  )) {
    sourceSafeBindings.add(match[1]);
  }
  // The build-destination helper is itself containment-checked below, so a
  // destination derived from it is bounded by the same root.
  sourceSafeBindings.add("extBuildRel");
  const unboundedWrites = [];
  for (const match of stripped.matchAll(sinkPattern)) {
    const destination = match[2];
    const bounded = /SOURCE_SAFE_[\w$]*/.test(destination) ||
      [...sourceSafeBindings].some((name) =>
        new RegExp(`\\b${name}\\b`).test(destination));
    if (!bounded) unboundedWrites.push(`${match[1]}(${destination.trim().slice(0, 80)}`);
  }
  assert(unboundedWrites.length === 0,
    `release runner write destinations must be source-safe rooted; unbounded: ${unboundedWrites.join(" | ")}`);
  assert(!/fs\.(?:writeFileSync|appendFileSync|copyFileSync|createWriteStream)\(\s*path\.(?:join|resolve)\(\s*REPO_ROOT/
    .test(stripped),
    "release runner must not write into the repository source tree");

  // 2. No temp-root escape: the governed root, and an explicit refusal when a
  //    derived destination would leave it.
  assert(/const\s+SOURCE_SAFE_TEMP_ROOT\s*=\s*fs\.mkdtempSync\(/.test(stripped) &&
    /os\.tmpdir\(\)/.test(stripped),
    "release runner must create its own governed temporary root under the OS temp directory");
  assert(/path\.relative\(\s*SOURCE_SAFE_TEMP_ROOT[\s\S]{0,240}?relative\.startsWith\("\.\."\)[\s\S]{0,160}?throw new Error/
    .test(stripped),
    "release runner must refuse a source-safe destination that escapes the temporary root");

  // 3. No destructive filesystem/shell commands. `fs.rmSync` is admitted only
  //    for the runner's own governed root, and only under its own containment.
  assert(!/rm\s+-[rf]|rmdir\s+\/s|\bunlink\s+-|shred\s+|\bdd\s+if=/.test(stripped),
    "release runner must not execute destructive shell commands");
  const removalTargets = [...stripped.matchAll(/fs\.(?:rmSync|rmdirSync|unlinkSync)\(\s*([^,)]+)/g)]
    .map((match) => match[1].trim());
  assert(removalTargets.length > 0 &&
    removalTargets.every((target) => target === "SOURCE_SAFE_TEMP_ROOT"),
    `release runner may remove only its own temporary root; found: ${removalTargets.join(", ") || "none"}`);

  // 4. No Git/VCS invocation.
  assert(!/spawnSync\(\s*["'`]git|execSync\(\s*["'`]git|["'`]git\s+(?:rev-parse|status|checkout|add|commit|clean|reset)/
    .test(stripped),
    "release runner must not invoke Git/VCS commands");

  // 5. No credential-material use or capture; the live harness keeps its own
  //    skip-by-default separation.
  assert(!/\b(?:service_role|service-role|serviceRoleKey|access_token|refresh_token|provider_token)\b/
    .test(stripped),
    "release runner must not use or capture credential material");
  assert(releaseRunner.includes("Live RLS keeps its own skip-by-default behavior"),
    "release runner must preserve skip-by-default live-harness separation");

  // 6. Required cleanup, under its own containment check, and reported.
  assert(/function\s+cleanupSourceSafeRoot\s*\(/.test(stripped) &&
    /path\.relative\(\s*os\.tmpdir\(\)\s*,\s*SOURCE_SAFE_TEMP_ROOT/.test(stripped) &&
    /Refusing unsafe temporary cleanup/.test(releaseRunner),
    "release runner must remove its temporary root only under an explicit containment check");
  assert(/cleanupCompleted\s*=\s*!fs\.existsSync\(\s*SOURCE_SAFE_TEMP_ROOT/.test(stripped) &&
    /ok:[\s\S]{0,120}?cleanupCompleted/.test(stripped),
    "release-gate summary must require completed cleanup");
}

assert(gitignore.split(/\r?\n/).includes("build/**"),
  ".gitignore must ignore generated build outputs");
assert(gitignore.split(/\r?\n/).includes("config/local/identity-provider.local.json"),
  ".gitignore must ignore local identity provider config");

assert(!armedManifest.content_security_policy,
  "armed manifest must not add CSP");
assert(!prodManifest.content_security_policy,
  "production manifest must not add CSP");
assertNoBroadHosts("armed manifest", armedManifest);
assertNoBroadHosts("production manifest", prodManifest);
assert(arrayEquals(armedManifest.host_permissions, ["https://chatgpt.com/*", "http://127.0.0.1:5500/*"]),
  "armed manifest host_permissions must be ChatGPT plus local proxy only");
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

for (const [label, source] of [
  ["identity surface JS", identitySurfaceJs],
  ["identity surface HTML", identitySurfaceHtml],
  ["identity surface CSS", identitySurfaceCss],
  ["loader", loader],
  ["Control Hub Account plugin", controlHubAccount],
]) {
  assertNoPageProviderOwnership(label, source);
}

for (const [label, source] of [
  ["loader", loader],
  ["Identity Core", identityCore],
  ["identity surface JS", identitySurfaceJs],
  ["identity surface HTML", identitySurfaceHtml],
  ["identity surface CSS", identitySurfaceCss],
  ["Control Hub", controlHub],
  ["Control Hub Account plugin", controlHubAccount],
]) {
  assertNoPagePersistentInternals(label, source);
}

assert(background.includes('const IDENTITY_PROVIDER_SESSION_KEY = "h2oIdentityProviderSessionV1"'),
  "background must keep active provider session key explicit");
assert(background.includes('const IDENTITY_PROVIDER_PERSISTENT_REFRESH_KEY = "h2oIdentityProviderPersistentRefreshV1"'),
  "background must define the approved persistent refresh key");
assert(background.includes("providerSessionStorageStrict"),
  "background must keep strict provider session storage helper");
assert(background.includes("chrome.storage.session"),
  "background must keep provider session storage session-owned");
assert(background.includes("providerPersistentRefreshStorageStrict") &&
  background.includes("chrome.storage.local"),
  "background must own the approved persistent refresh storage.local helper");
assert(!/chrome\.storage\.local[^\n;]*(access_token|h2oIdentityProviderSessionV1)/i.test(background),
  "background must not persist active provider session or access token to chrome.storage.local");

console.log("  release-gate docs and command checklist present");
console.log("  live RLS instructions remain opt-in and dev/disposable only");
console.log("  armed and production manifests remain narrow");
console.log("  page/UI/loader provider boundaries remain enforced");
console.log("  persistent refresh storage is background-owned and page-free");
console.log("\nIdentity Phase 3.5B release-gate validation PASSED");
