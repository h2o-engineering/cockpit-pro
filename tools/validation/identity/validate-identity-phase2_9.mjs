// Phase 2.9 validation — mock provider adapter skeleton.
// Verifies: loader allow-list, background ASM handlers, Identity Core bridge routing,
// token boundary, local fallback, no real Supabase/provider code.
// Uses hard failures: if (!condition) throw new Error(...) — execution halts on first fail.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RUNTIME_BASE_DIR, extensionBuildDir } from '../../paths.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const CHROME_TOOL_DIR = path.join(REPO_ROOT, 'tools', 'product', 'extensions', 'chatgpt', 'chrome');

const LOADER_SRC     = fs.readFileSync(path.join(CHROME_TOOL_DIR, 'chrome-live-loader.mjs'), 'utf8');
const BG_SRC         = fs.readFileSync(path.join(CHROME_TOOL_DIR, 'chrome-live-background.mjs'), 'utf8');
const BUILD_SRC      = fs.readFileSync(path.join(CHROME_TOOL_DIR, 'build-chrome-live-extension.mjs'), 'utf8');
const GITIGNORE_SRC  = fs.readFileSync(path.join(REPO_ROOT, '.gitignore'), 'utf8');
const IDENTITY_SCRIPT = path.join(RUNTIME_BASE_DIR, '0D4a.⬛️🔐 Identity Core 🔐.js');
const IDENTITY_SRC   = fs.readFileSync(IDENTITY_SCRIPT, 'utf8');
const CHUB_SRC       = fs.readFileSync(path.join(RUNTIME_BASE_DIR, '0Z1a.⬛️🕹️ Control Hub 🕹️.js'), 'utf8');
const CHUB_ACCOUNT_SRC = fs.readFileSync(path.join(RUNTIME_BASE_DIR, '0Z1e.⚫️🔐 Account Tab (Control Hub 🔌 Plugin) 🔐.js'), 'utf8');
const CHUB_ACCOUNT_SURFACE = `${CHUB_SRC}\n${CHUB_ACCOUNT_SRC}`;
const FIRST_RUN_SRC  = fs.readFileSync(path.join(RUNTIME_BASE_DIR, '0D4b.⚫️🔐 Identity First-Run Prompt 🚪🔐.js'), 'utf8');

// Built-extension reads use the central path authority so H2O_EXT_BUILD_ROOT
// naturally redirects this validator to source-safe disposable artifacts.
const BUILT_LOADER = fs.readFileSync(path.join(extensionBuildDir('dev-controls'), 'loader.js'), 'utf8');
const BUILT_BG     = fs.readFileSync(path.join(extensionBuildDir('dev-controls'), 'bg.js'), 'utf8');

function assert(condition, message) {
  if (!condition) throw new Error(`FAIL: ${message}`);
}

const PHASE_2_9_ACTIONS = [
  'identity:get-derived-state',
  'identity:request-email-otp',
  'identity:verify-email-otp',
  'identity:create-profile',
  'identity:create-workspace',
  'identity:complete-onboarding',
  'identity:attach-local-profile',
  'identity:migrate-local-workspace',
  'identity:refresh-session',
  'identity:sign-out',
];

const LEGACY_ACTIONS = [
  'identity:get-snapshot',
  'identity:set-snapshot',
  'identity:clear-snapshot',
  'identity:get-onboarding-url',
  'identity:open-onboarding',
];

// ── Suite A: loader allow-list ─────────────────────────────────────────────────
console.log('\n── Suite A: loader allow-list ────────────────────────────────────');

for (const action of [...PHASE_2_9_ACTIONS, ...LEGACY_ACTIONS]) {
  assert(LOADER_SRC.includes(`"${action}"`), `A: loader source ALLOW_ACTIONS includes "${action}"`);
  assert(BUILT_LOADER.includes(`"${action}"`), `A: built loader includes "${action}"`);
}
console.log('  all Phase 2.9 + legacy actions in loader ALLOW_ACTIONS ✓');

// ── Suite B: background AuthSessionManager boundary ──────────────────────────
console.log('\n── Suite B: background AuthSessionManager boundary ───────────────');

assert(BG_SRC.includes('h2oIdentityProviderMockRuntimeV1'), 'B1: IDENTITY_MOCK_RUNTIME_KEY defined in source');
assert(BUILT_BG.includes('h2oIdentityProviderMockRuntimeV1'), 'B1: IDENTITY_MOCK_RUNTIME_KEY in built bg.js');
console.log('  mock runtime key defined ✓');

const BOUNDARY_FUNCTIONS = [
  'identityProviderConfig_get',
  'identityProviderConfig_normalizeSourceName',
  'identityProviderConfig_getSource',
  'identityProviderConfig_getDevOnlySource',
  'identityProviderConfig_getSourceStatus',
  'identityProviderConfig_resolve',
  'identityProviderConfig_cleanStatusList',
  'identityProviderConfig_isRedactedStatus',
  'identityProviderConfig_normalizeInjectedStatus',
  'identityProviderConfig_validatePublicClientConfig',
  'identityProviderConfig_validateSupabaseShape',
  'identityProviderConfig_classifyConfig',
  'identityProviderConfig_validateShape',
  'identityProviderConfig_missingFields',
  'identityProviderConfig_getMode',
  'identityProviderConfig_isMock',
  'identityProviderConfig_isSupabaseConfigured',
  'identityProviderPermission_getReadiness',
  'identityProviderConfig_safeStatus',
  'identityProviderConfig_redact',
  'identityProviderConfig_diag',
  'identityProviderConfig_getInjectedSource',
  'identityRuntime_get',
  'identityRuntime_set',
  'identityRuntime_clear',
  'identityRuntime_enforceConsistency',
  'identitySnapshot_derivedFromRuntime',
  'identitySnapshot_fromRuntime',
  'identitySnapshot_toRuntime',
  'identitySnapshot_hasReadyShape',
  'identitySnapshot_sanitize',
  'identityMockProvider_requestEmailOtp',
  'identityMockProvider_verifyEmailOtp',
  'identityMockProvider_completeOnboarding',
  'identityAuthManager_getSnapshot',
  'identityAuthManager_setSnapshot',
  'identityAuthManager_getDerivedState',
  'identityAuthManager_getProviderAdapter',
  'identityAuthManager_completeOnboarding',
  'identityAuthManager_signOut',
];
for (const name of BOUNDARY_FUNCTIONS) {
  assert(BG_SRC.includes(`function ${name}(`) || BG_SRC.includes(`async function ${name}(`), `B2: ${name} defined in source`);
  assert(BUILT_BG.includes(name), `B2: ${name} present in built bg.js`);
}
assert(BG_SRC.includes('const identityMockProviderAdapter = Object.freeze('), 'B2: mock provider adapter object defined');
console.log('  runtime/snapshot/provider/auth-manager boundary functions defined ✓');

const providerConfigBlock = BG_SRC.slice(
  BG_SRC.indexOf('const IDENTITY_PROVIDER_CONFIG_SCHEMA_VERSION'),
  BG_SRC.indexOf('const IDENTITY_PROVIDER_OTP_ALLOWED_ERROR_CODES')
);
assert(providerConfigBlock.includes('providerKind: "mock"'), 'B2c: provider config defaults to mock');
assert(providerConfigBlock.includes('providerMode: "local_dev"'), 'B2c: provider config defaults to local_dev');
assert(providerConfigBlock.includes('providerConfigured: true'), 'B2c: mock provider config is configured');
assert(providerConfigBlock.includes('configSource: "built_in_mock"'), 'B2c: provider config source defaults to built_in_mock');
assert(providerConfigBlock.includes('"dev_empty_invalid"'), 'B2c: dev empty invalid config source is declared');
assert(providerConfigBlock.includes('"dev_elevated_invalid"'), 'B2c: dev elevated invalid config source is declared');
assert(providerConfigBlock.includes('"dev_env"'), 'B2c: dev env config source is declared');
assert(providerConfigBlock.includes('"dev_local_file"'), 'B2c: dev local file config source is declared');
assert(providerConfigBlock.includes('IDENTITY_PROVIDER_CONFIG_INJECTED_STATUS'), 'B2c: redacted injected config status constant is present');
assert(providerConfigBlock.includes('IDENTITY_PROVIDER_CONFIG_SCHEMA_VERSION = "3.0N"'), 'B2c: provider config schema version is 3.0N');
assert(providerConfigBlock.includes('identityProviderConfig_getSource'), 'B2c: config source resolver defined');
assert(providerConfigBlock.includes('identityProviderConfig_getDevOnlySource'), 'B2c: dev-only config source helper defined');
assert(providerConfigBlock.includes('identityProviderConfig_getInjectedSource'), 'B2c: redacted injected config source helper defined');
assert(providerConfigBlock.includes('identityProviderConfig_normalizeInjectedStatus'), 'B2c: redacted injected config status normalizer defined');
assert(providerConfigBlock.includes('identityProviderConfig_validateShape'), 'B2c: config shape validator defined');
assert(providerConfigBlock.includes('identityProviderConfig_validateSupabaseShape'), 'B2c: future provider config validator stub defined');
assert(providerConfigBlock.includes('provider_project'), 'B2c: future provider project requirement uses generic label');
assert(providerConfigBlock.includes('public_client'), 'B2c: future public client requirement uses generic label');
assert(providerConfigBlock.includes('identity/config-missing-required'), 'B2c: missing config error code is generic');
assert(providerConfigBlock.includes('identity/config-elevated-access-forbidden'), 'B2c: elevated access rejection code is generic');
assert(providerConfigBlock.includes('IDENTITY_PROVIDER_PERMISSION_READINESS_DEFERRED'), 'B2c: deferred permission readiness constant is present');
assert(providerConfigBlock.includes('permissionRequired: "deferred"'), 'B2c: permission readiness is deferred');
assert(providerConfigBlock.includes('permissionReady: false'), 'B2c: permission readiness is false');
assert(providerConfigBlock.includes('permissionSource: "deferred_until_project_host"'), 'B2c: permission source is deferred until project host');
assert(providerConfigBlock.includes('permissionHostKind: "none"'), 'B2c: permission host kind is none');
assert(providerConfigBlock.includes('permissionStatus: "deferred"'), 'B2c: permission status is deferred');
assert(providerConfigBlock.includes('networkReady: false'), 'B2c: network readiness is false');
assert(providerConfigBlock.includes('IDENTITY_PROVIDER_PHASE_NETWORK_ENABLED = IDENTITY_PROVIDER_PHASE_NETWORK === "request_otp"'),
  'B2c: phase network gate is controlled only by request_otp build flag');
assert(BUILD_SRC.includes('H2O_IDENTITY_PHASE_NETWORK'), 'B2c: build recognizes explicit provider network phase flag');
assert(providerConfigBlock.includes('identityProviderNetwork_getReadiness'), 'B2c: network readiness gate helper is present');
assert(providerConfigBlock.includes('networkStatus'), 'B2c: network status diagnostic is present');
assert(providerConfigBlock.includes('networkBlockReason'), 'B2c: network block reason diagnostic is present');
assert(providerConfigBlock.includes('identityProviderPermission_getReadiness'), 'B2c: permission readiness helper is present');
assert(providerConfigBlock.includes('identityProviderConfig_safeStatus'), 'B2c: config status redactor defined');
assert(providerConfigBlock.includes('emailOtp: true'), 'B2c: mock config advertises email OTP capability');
assert(providerConfigBlock.includes('magicLink: false'), 'B2c: magic link disabled in config status');
assert(providerConfigBlock.includes('oauth: false'), 'B2c: OAuth disabled in config status');
assert(!/(projectUrl|anonKey|serviceRole|serviceKey|url|key|secret|token|session|credential)\s*:/i.test(providerConfigBlock),
  'B2c: provider config runtime block must not expose raw provider config fields');
assert(BUILD_SRC.includes('resolveIdentityProviderBuildStatus'), 'B2c: build discovers redacted identity provider config status');
assert(BUILD_SRC.includes('H2O_IDENTITY_PROVIDER_PROJECT_URL'), 'B2c: build supports dev env project source');
assert(BUILD_SRC.includes('H2O_IDENTITY_PROVIDER_PUBLIC_CLIENT'), 'B2c: build supports dev env public client source');
assert(BUILD_SRC.includes('config/local/identity-provider.local.json') || BUILD_SRC.includes('identity-provider.local.json'),
  'B2c: build supports ignored local identity provider config file');
assert(GITIGNORE_SRC.includes('config/local/identity-provider.local.json'),
  'B2c: local identity provider config file is ignored');
assert(BG_SRC.includes('sanitizeIdentityProviderConfigStatusForBackground'), 'B2c: background generator sanitizes injected status before bg.js');
console.log('  inert provider config source defaults are mock/local and redacted ✓');

const derivedStateManagerBlock = BG_SRC.slice(
  BG_SRC.indexOf('async function identityAuthManager_getDerivedState('),
  BG_SRC.indexOf('async function identityAuthManager_getDerivedState(') + 500
);
assert(derivedStateManagerBlock.includes('providerConfigStatus'), 'B2d: get-derived-state includes providerConfigStatus diagnostic');
assert(derivedStateManagerBlock.includes('identityProviderConfig_diagAsync()'), 'B2d: providerConfigStatus comes from async redacted diag helper');
const providerAdapterSelectorBlock = BG_SRC.slice(
  BG_SRC.indexOf('function identityAuthManager_getProviderAdapter('),
  BG_SRC.indexOf('function identityAuthManager_getProviderAdapter(') + 500
);
assert(providerAdapterSelectorBlock.includes('identityProviderConfig_isMock'), 'B2d: provider adapter selection consults provider config boundary');
assert(providerAdapterSelectorBlock.includes('identityMockProviderAdapter'), 'B2d: Phase 3.0B provider adapter remains mock');
console.log('  get-derived-state exposes safe providerConfigStatus and manager selects mock adapter ✓');

assert(BG_SRC.includes('function identityProviderBundle_loadProbe('), 'B2e: background bundle probe loader defined');
assert(BG_SRC.includes('importScripts(IDENTITY_PROVIDER_BUNDLE_PATH)'), 'B2e: background bundle retains conditional importScripts path');
assert(BG_SRC.includes('function identityProviderBundle_shouldLoadProbe('), 'B2e: background bundle load is gated by provider config readiness');
assert(BG_SRC.includes('function identityProviderBundle_ensureProbeLoaded('), 'B2e: background bundle load is lazy from probe status path');
assert(!BG_SRC.includes('}\n\nidentityProviderBundle_loadProbe();\n\nconst MODE_LIVE_FIRST'),
  'B2e: background bundle must not load unconditionally at service-worker boot');
assert(BG_SRC.includes('function identityProviderBundle_getProbeStatus('), 'B2e: safe background bundle probe status helper defined');
assert(BUILT_BG.includes('provider/identity-provider-supabase.js'), 'B2e: built bg.js references background provider bundle');
assert(BUILT_BG.includes('bundleProbe'), 'B2e: built bg.js includes safe bundleProbe diagnostic');
console.log('  background provider bundle probe is present and conditionally loaded ✓');

// Compatibility aliases remain for older probes while the manager owns the flow.
assert(BG_SRC.includes('function asm_getRuntime('), 'B2b: asm_getRuntime compatibility alias defined');
assert(BG_SRC.includes('function asm_derivedFromRuntime('), 'B2b: asm_derivedFromRuntime compatibility alias defined');
console.log('  Phase 2.9 ASM compatibility aliases retained ✓');

for (const action of PHASE_2_9_ACTIONS) {
  const needle = `action === "${action}"`;
  assert(BG_SRC.includes(needle), `B3: background source handles "${action}"`);
  assert(BUILT_BG.includes(needle), `B3: built bg.js handles "${action}"`);
}
console.log('  all Phase 2.9 action handlers in background ✓');

// Legacy actions still present
for (const action of LEGACY_ACTIONS) {
  const needle = `action === "${action}"`;
  assert(BG_SRC.includes(needle), `B4: legacy action "${action}" still handled`);
}
console.log('  all legacy actions still present ✓');

// identitySnapshot_sanitize strips token-like keys
assert(BG_SRC.includes('/token|secret|password|refresh|credential/i'), 'B5: identitySnapshot_sanitize strips token-like keys');
console.log('  identitySnapshot_sanitize has token-strip pattern ✓');

// identity:sign-out clears both runtime and snapshot
const signOutBlock = BG_SRC.slice(BG_SRC.indexOf('"identity:sign-out"'), BG_SRC.indexOf('"identity:sign-out"') + 300);
const signOutManagerBlock = BG_SRC.slice(BG_SRC.indexOf('async function identityAuthManager_signOut('), BG_SRC.indexOf('async function identityAuthManager_signOut(') + 1200);
const signOutCleanupBlock = BG_SRC.slice(BG_SRC.indexOf('async function identityAuthManager_clearSignOutLocalState('), BG_SRC.indexOf('async function identityAuthManager_clearSignOutLocalState(') + 3600);
assert(signOutBlock.includes('identityAuthManager_signOut'), 'B6: sign-out routes to auth manager');
assert(signOutManagerBlock.includes('identityAuthManager_clearSignOutLocalState'), 'B6: auth manager sign-out always reaches local cleanup');
assert(signOutCleanupBlock.includes('identityAuthManager_clearRuntime'), 'B6: auth manager sign-out clears mock runtime');
assert(signOutCleanupBlock.includes('identityAuthManager_clearStoredSnapshot'), 'B6: auth manager sign-out removes snapshot key');
assert(signOutCleanupBlock.includes('broadcastIdentityPush(null)'), 'B6: auth manager sign-out broadcasts reset');
console.log('  identity:sign-out routes through manager and clears runtime + snapshot ✓');

// ── Suite C: no real Supabase / token / secret fields ─────────────────────────
console.log('\n── Suite C: token boundary / no real auth ────────────────────────');

// Check for actual Supabase SDK import (not just comments)
const supabaseImport = /import\s+.*from\s+['"]@supabase\/supabase-js['"]/;
assert(!supabaseImport.test(BG_SRC), 'C1: no supabase-js import in background source');
assert(!supabaseImport.test(BUILT_BG), 'C1: no supabase-js import in built bg.js');
console.log('  no supabase-js SDK import ✓');

// No production credentials
const credentialPatterns = [
  /SUPABASE_URL\s*=\s*["']https?:/,
  /SUPABASE_ANON_KEY\s*=\s*["']/,
  /SUPABASE_SERVICE(_ROLE)?_KEY\s*=\s*["']/,
  /https:\/\/[a-z0-9-]+\.supabase\.co/i,
  /\bsupabase(ProjectUrl|AnonKey|ServiceKey)\s*[:=]/i,
  /eyJ[A-Za-z0-9_-]{40,}/,   // JWT-like string
];
const stripAllowedExactOptionalHostPermission = (src) =>
  String(src || "").replace(/https:\/\/[a-z0-9-]+\.supabase\.co\/\*/gi, "");
for (const pattern of credentialPatterns) {
  for (const [label, src] of [
    ['background', BG_SRC],
    ['built bg.js', BUILT_BG],
    ['loader', LOADER_SRC],
    ['built loader.js', BUILT_LOADER],
    ['Identity Core', IDENTITY_SRC],
  ]) {
    assert(!pattern.test(stripAllowedExactOptionalHostPermission(src)), `C2: no credential pattern ${pattern} in ${label}`);
  }
}
console.log('  no credentials or JWT tokens ✓');

const providerAuthCallPatterns = [
  /signInWithOtp\s*\(/,
  /verifyOtp\s*\(/,
  /createClient\s*\(/,
];
for (const pattern of providerAuthCallPatterns) {
  for (const [label, src] of [
    ['background', BG_SRC],
    ['built bg.js', BUILT_BG],
    ['loader', LOADER_SRC],
    ['built loader.js', BUILT_LOADER],
    ['Identity Core', IDENTITY_SRC],
  ]) {
    assert(!pattern.test(src), `C2b: no real provider auth call ${pattern} in ${label}`);
  }
}
assert(!BG_SRC.includes('identity:get-provider-config-status'), 'C2b: no new provider-config bridge action in source');
assert(!BUILT_BG.includes('identity:get-provider-config-status'), 'C2b: no new provider-config bridge action in built bg.js');
console.log('  no real provider auth calls and no new config bridge action ✓');

// No token field names in derived state output
const asmBlock = BG_SRC.slice(BG_SRC.indexOf('function identitySnapshot_derivedFromRuntime('), BG_SRC.indexOf('function identitySnapshot_fromRuntime('));
const forbiddenFields = ['access_token', 'refresh_token', 'id_token', 'provider_token', 'auth_code', 'otp_token_hash'];
for (const field of forbiddenFields) {
  assert(!asmBlock.includes(`"${field}"`), `C3: "${field}" not in identitySnapshot_derivedFromRuntime`);
  assert(!asmBlock.includes(`'${field}'`), `C3: '${field}' not in identitySnapshot_derivedFromRuntime`);
}
console.log('  no forbidden token fields in derived snapshot mapping ✓');

const snapshotBlock = BG_SRC.slice(
  BG_SRC.indexOf('function identitySnapshot_fromRuntime('),
  BG_SRC.indexOf('function identitySnapshot_toRuntime(')
);
assert(!snapshotBlock.includes('providerConfigStatus'), 'C3b: providerConfigStatus is not added to public snapshot mapping');
console.log('  public snapshot mapping unchanged by provider config diagnostic ✓');

// Identity Core snapshot: noTokenSurface check preserved
assert(IDENTITY_SRC.includes("noTokenSurface: !JSON.stringify(snapshot).toLowerCase().includes('token')"), 'C4: noTokenSurface check in selfCheck()');
console.log('  noTokenSurface check preserved ✓');

// No token fields in sanitizeForBridge
assert(IDENTITY_SRC.includes('sanitizeForBridge'), 'C5: sanitizeForBridge exists');
assert(IDENTITY_SRC.includes('/token|secret|password|refresh/i'), 'C5: sanitizeForBridge strips token-like keys');
console.log('  sanitizeForBridge token-strip pattern preserved ✓');

// Control Hub and FirstRunPrompt have no token fields
assert(!CHUB_ACCOUNT_SURFACE.includes('access_token') && !CHUB_ACCOUNT_SURFACE.includes('refresh_token'), 'C6: no token fields in Control Hub Account surface');
assert(!FIRST_RUN_SRC.includes('access_token') && !FIRST_RUN_SRC.includes('refresh_token'), 'C6: no token fields in FirstRunPrompt');
console.log('  Control Hub and FirstRunPrompt are token-free ✓');

// ── Suite D: Identity Core bridge routing ─────────────────────────────────────
console.log('\n── Suite D: Identity Core bridge routing ─────────────────────────');

assert(IDENTITY_SRC.includes("sendBridge('identity:request-email-otp'"), 'D1: signInWithEmail routes identity:request-email-otp');
assert(IDENTITY_SRC.includes("sendBridge('identity:verify-email-otp'"), 'D2: verifyEmailCode routes identity:verify-email-otp');
assert(IDENTITY_SRC.includes("sendBridge('identity:complete-onboarding'"), 'D3: createInitialWorkspace uses atomic identity:complete-onboarding');
assert(!IDENTITY_SRC.includes("sendBridge('identity:create-profile'"), 'D3b: createInitialWorkspace no longer calls identity:create-profile separately');
assert(!IDENTITY_SRC.includes("sendBridge('identity:create-workspace'"), 'D4: createInitialWorkspace no longer calls identity:create-workspace separately');
assert(IDENTITY_SRC.includes("sendBridge('identity:refresh-session')"), 'D5: refreshSession routes identity:refresh-session');
assert(IDENTITY_SRC.includes("sendBridge('identity:sign-out')"), 'D6: signOut routes identity:sign-out');
console.log('  all bridge routing calls present ✓');

// Existing public API still exported
const PUBLIC_API = ['getState', 'getSnapshot', 'onChange', 'signInWithEmail', 'resendVerification',
  'verifyEmailCode', 'handleVerificationCallback', 'createInitialWorkspace', 'enterLocalMode',
  'refreshSession', 'signOut', 'getProfile', 'updateProfile', 'getWorkspace', 'openOnboarding',
  'diag', 'selfCheck'];
for (const name of PUBLIC_API) {
  assert(IDENTITY_SRC.includes(name), `D7: public API "${name}" still present`);
}
console.log('  full public API preserved ✓');

// signInWithEmail note changed to "Mock OTP requested"
assert(IDENTITY_SRC.includes("Mock OTP requested for"), 'D8: signInWithEmail updated note');
console.log('  signInWithEmail note updated ✓');

// signOut now awaits identity:sign-out before local reset
const signOutFn = IDENTITY_SRC.slice(IDENTITY_SRC.indexOf('async function signOut()'), IDENTITY_SRC.indexOf('async function updateProfile'));
assert(signOutFn.includes("await sendBridge('identity:sign-out')"), 'D9: signOut awaits identity:sign-out');
// identity:clear-snapshot no longer called separately (sign-out handles it)
assert(!signOutFn.includes("identity:clear-snapshot"), 'D10: signOut does not redundantly call identity:clear-snapshot');
console.log('  signOut awaits identity:sign-out ✓');

// ── Suite E: legacy paths / local fallback still work ─────────────────────────
console.log('\n── Suite E: functional — local fallback (no bridge) ─────────────');

function makeGlobal(opts = {}) {
  const ls = {};
  const listeners = {};
  const g = {
    H2O: undefined,
    dispatchEvent(ev) {
      const fns = listeners[ev.type] || [];
      for (const fn of fns) try { fn(ev); } catch (_) {}
    },
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    removeEventListener(type, fn) {
      listeners[type] = (listeners[type] || []).filter(f => f !== fn);
    },
    postMessage() {},
    CustomEvent: class CustomEvent {
      constructor(type, init) { this.type = type; this.detail = init?.detail; }
    },
    location: opts.location || { protocol: 'https:' },
    open: opts.open || (() => null),
    console,
    localStorage: {
      _store: ls,
      getItem: k => Object.prototype.hasOwnProperty.call(ls, k) ? ls[k] : null,
      setItem: (k, v) => { ls[k] = String(v); },
      removeItem: k => { delete ls[k]; },
    },
    setTimeout, clearTimeout, Date, JSON, Object, Array, Math, Promise, Error, Set, Map,
    crypto: { randomUUID: () => 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => { const r = Math.random() * 16 | 0; return (c === 'x' ? r : r & 3 | 8).toString(16); }) },
    structuredClone: v => JSON.parse(JSON.stringify(v)),
  };
  if (opts.chrome) g.chrome = opts.chrome;
  return g;
}

function bootIdentity(g) {
  const src = fs.readFileSync(IDENTITY_SCRIPT, 'utf8');
  const fn = new Function('unsafeWindow', src + '\n//# sourceURL=0D4a-identity.js');
  fn.call(g, g);
  return g.H2O.Identity;
}

async function flush(ms = 50) {
  await new Promise(r => setTimeout(r, ms));
}

// E1: boot without chrome.runtime — no crash, anonymous_local state
{
  const g = makeGlobal();
  const id = bootIdentity(g);
  assert(id.getState() === 'anonymous_local', 'E1: starts in anonymous_local');
  assert(typeof id.signInWithEmail === 'function', 'E1: signInWithEmail is a function');
  assert(typeof id.verifyEmailCode === 'function', 'E1: verifyEmailCode is a function');
  console.log('  boots without chrome.runtime ✓');
}

// E2: local fallback flow: anonymous_local → email_pending → verified_no_profile → profile_ready → sign-out → anonymous_local
{
  const g = makeGlobal();
  // Simulate bridge timing out (no relay): postMessage echoes back nothing, bridge returns null.
  const id = bootIdentity(g);
  await flush(20);

  let snap = await id.signInWithEmail('test@example.com');
  assert(snap.status === 'email_pending', `E2: email_pending after signInWithEmail (got ${snap.status})`);
  assert(!snap.pendingEmail || snap.pendingEmail === 'test@example.com', 'E2: pendingEmail set');

  snap = await id.verifyEmailCode({ code: 'local-mock' });
  assert(snap.status === 'verified_no_profile', `E2: verified_no_profile after verifyEmailCode (got ${snap.status})`);
  assert(snap.emailVerified === true, 'E2: emailVerified true');

  snap = await id.createInitialWorkspace({ displayName: 'Test User', workspaceName: 'Test WS' });
  assert(snap.status === 'profile_ready', `E2: profile_ready after createInitialWorkspace (got ${snap.status})`);
  assert(snap.profile?.displayName === 'Test User', 'E2: profile displayName set');
  assert(snap.workspace?.name === 'Test WS', 'E2: workspace name set');

  snap = await id.signOut();
  assert(snap.status === 'anonymous_local', `E2: anonymous_local after signOut (got ${snap.status})`);
  assert(snap.profile === null, 'E2: profile cleared after signOut');
  console.log('  full local fallback flow ✓');
}

// E3: snapshot never contains token fields
{
  const g = makeGlobal();
  const id = bootIdentity(g);
  await flush(20);
  await id.signInWithEmail('user@domain.com');
  await id.verifyEmailCode({ code: 'any' });
  await id.createInitialWorkspace({ displayName: 'Alice' });
  const snap = id.getSnapshot();
  const str = JSON.stringify(snap).toLowerCase();
  const tokenFields = ['access_token', 'refresh_token', 'id_token', 'provider_token', 'auth_code', 'otp_token_hash'];
  for (const field of tokenFields) {
    assert(!str.includes(field), `E3: snapshot does not contain "${field}"`);
  }
  // selfCheck noTokenSurface
  const sc = id.selfCheck();
  assert(sc.ok, `E3: selfCheck ok (checks: ${JSON.stringify(sc.checks)})`);
  assert(sc.checks.noTokenSurface === true, 'E3: noTokenSurface check passes');
  console.log('  snapshot is token-free, selfCheck passes ✓');
}

// E4: enterLocalMode still works (local/dev mode preserved)
{
  const g = makeGlobal();
  const id = bootIdentity(g);
  await flush(20);
  const snap = await id.enterLocalMode({ displayName: 'Dev User', workspaceName: 'Dev WS' });
  assert(snap.status === 'profile_ready', `E4: profile_ready from enterLocalMode (got ${snap.status})`);
  assert(snap.mode === 'local_dev', 'E4: mode is local_dev');
  assert(snap.provider === 'mock_local', 'E4: provider is mock_local');
  console.log('  enterLocalMode (local/dev mode) preserved ✓');
}

// E5: mock bridge adapter flow — bridge returns Phase 2.9 responses
{
  const g = makeGlobal();
  const MSG_REQ = 'h2o-ext-identity:v1:req';
  const MSG_RES = 'h2o-ext-identity:v1:res';

  // Simulate a loader that handles Phase 2.9 actions
  const mockRuntime = { status: 'anonymous_local' };

  // We need to re-wire postMessage so the listener round-trips correctly
  const origListeners = {};
  const mockG = Object.assign({}, g, {
    addEventListener(type, fn, capture) {
      origListeners[type] = origListeners[type] || [];
      origListeners[type].push(fn);
      g.addEventListener(type, fn, capture);
    },
    postMessage(data) {
      // Simulate loader relay for Phase 2.9 actions
      const req = data?.req;
      if (!req) return;
      const action = req.action || '';
      let resp = null;
      if (action === 'identity:request-email-otp') {
        const email = req.email || '';
        const local = email.split('@')[0] || '';
        const visible = local.length <= 2 ? (local[0] || '*') : local[0] + local[local.length - 1];
        resp = { ok: true, emailMasked: visible + '***@' + email.split('@')[1], nextStatus: 'email_pending' };
      } else if (action === 'identity:verify-email-otp') {
        resp = { ok: true, nextStatus: 'verified_no_profile' };
      } else if (action === 'identity:create-profile') {
        resp = { ok: true, nextStatus: 'profile_ready' };
      } else if (action === 'identity:create-workspace') {
        resp = { ok: true, nextStatus: 'sync_ready' };
      } else if (action === 'identity:refresh-session') {
        resp = { ok: true, updatedAt: new Date().toISOString() };
      } else if (action === 'identity:sign-out') {
        resp = { ok: true, nextStatus: 'anonymous_local' };
      } else if (action === 'identity:get-snapshot') {
        resp = { ok: true, snapshot: null };
      }
      if (resp && data.id) {
        setTimeout(() => {
          const ev = Object.assign(new g.CustomEvent('message'), {
            source: g,
            data: { type: MSG_RES, id: data.id, ...resp }
          });
          g.dispatchEvent(ev);
        }, 5);
      }
    }
  });

  const id = bootIdentity(mockG);
  await flush(20);

  // signInWithEmail sends request-email-otp (fire-and-forget), local state still transitions
  let snap = await id.signInWithEmail('bridge@test.com');
  assert(snap.status === 'email_pending', `E5: email_pending after bridge signInWithEmail (got ${snap.status})`);

  snap = await id.verifyEmailCode({ code: 'bridge-code' });
  assert(snap.status === 'verified_no_profile', `E5: verified_no_profile after bridge verifyEmailCode (got ${snap.status})`);

  snap = await id.createInitialWorkspace({ displayName: 'Bridge User' });
  assert(snap.status === 'profile_ready', `E5: profile_ready after bridge createInitialWorkspace (got ${snap.status})`);

  snap = await id.signOut();
  assert(snap.status === 'anonymous_local', `E5: anonymous_local after bridge signOut (got ${snap.status})`);
  console.log('  bridge mock adapter flow ✓');
}

// ── Suite F: build outputs consistent ─────────────────────────────────────────
console.log('\n── Suite F: build output consistency ─────────────────────────────');

for (const action of PHASE_2_9_ACTIONS) {
  assert(BUILT_LOADER.includes(`"${action}"`), `F1: built loader has "${action}"`);
  assert(BUILT_BG.includes(`"${action}"`), `F2: built bg.js has "${action}"`);
}
console.log('  built outputs include all Phase 2.9 actions ✓');

assert(BUILT_BG.includes('h2oIdentityProviderMockRuntimeV1'), 'F3: built bg.js has mock runtime key');
assert(BUILT_BG.includes('identitySnapshot_derivedFromRuntime'), 'F4: built bg.js has identitySnapshot_derivedFromRuntime');
assert(BUILT_BG.includes('identityAuthManager_completeOnboarding'), 'F4: built bg.js has identityAuthManager_completeOnboarding');
console.log('  mock AuthSessionManager boundary in built bg.js ✓');

// No real provider SDK import in any built output
const sdkImport = /import\s+.*from\s+['"]@supabase\/supabase-js['"]/;
assert(!sdkImport.test(BUILT_BG), 'F5: no supabase-js import in built bg.js');
assert(!sdkImport.test(BUILT_LOADER), 'F5: no supabase-js import in built loader.js');
console.log('  no provider SDK import in build outputs ✓');

// ── Suite G: consuming scripts unchanged ───────────────────────────────────────
console.log('\n── Suite G: consuming scripts (no auth ownership added) ──────────');

// FirstRunPrompt: only reads H2O.Identity, no bridge actions
assert(!FIRST_RUN_SRC.includes('identity:request-email-otp'), 'G1: FirstRunPrompt does not call OTP actions');
assert(!FIRST_RUN_SRC.includes('identity:sign-out'), 'G1: FirstRunPrompt does not call sign-out');
assert(FIRST_RUN_SRC.includes('evaluate'), 'G1: FirstRunPrompt evaluate() still present');
console.log('  FirstRunPrompt unchanged ✓');

// Control Hub: no auth ownership, no token fields
assert(!CHUB_ACCOUNT_SURFACE.includes('identity:request-email-otp'), 'G2: Control Hub Account surface does not call OTP actions');
assert(!CHUB_ACCOUNT_SURFACE.includes('access_token'), 'G2: no access_token in Control Hub Account surface');
assert(CHUB_ACCOUNT_SRC.includes('function identityApi()'), 'G2: Account tab plugin remains an H2O.Identity consumer');
console.log('  Control Hub Account surface remains consumer-only ✓');

// openOnboarding still goes to extension-owned page
assert(IDENTITY_SRC.includes("sendBridge('identity:open-onboarding')"), 'G3: openOnboarding still bridges to extension page');
assert(!IDENTITY_SRC.includes("return '/surfaces/identity/identity.html'"), 'G3: no bare relative URL fallback');
console.log('  openOnboarding still uses extension-owned page ✓');

// dev-order.tsv not changed (unchanged if this file exists and has expected content)
const devOrderPath = path.join(REPO_ROOT, 'config', 'dev-order.tsv');
const devOrderSrc = fs.readFileSync(devOrderPath, 'utf8');
assert(devOrderSrc.includes('0D4a'), 'G4: dev-order.tsv still has 0D4a entry');
assert(devOrderSrc.includes('0D4b'), 'G4: dev-order.tsv still has 0D4b entry');
console.log('  dev-order.tsv not changed ✓');

// ── Suite H: complete-onboarding atomic handler + consistency ───────────────
console.log('\n── Suite H: identity:complete-onboarding atomic handler ───────────');

// Runtime/snapshot consistency helpers in source + build
assert(BG_SRC.includes('function identitySnapshot_fromRuntime('), 'H1: identitySnapshot_fromRuntime defined');
assert(BG_SRC.includes('function identitySnapshot_toRuntime('), 'H1: identitySnapshot_toRuntime defined');
assert(BG_SRC.includes('function identityRuntime_enforceConsistency('), 'H1: identityRuntime_enforceConsistency defined');
assert(BUILT_BG.includes('identitySnapshot_fromRuntime'), 'H1: identitySnapshot_fromRuntime in built bg.js');
assert(BUILT_BG.includes('identitySnapshot_toRuntime'), 'H1: identitySnapshot_toRuntime in built bg.js');
assert(BUILT_BG.includes('identityRuntime_enforceConsistency'), 'H1: identityRuntime_enforceConsistency in built bg.js');
console.log('  identitySnapshot_fromRuntime / identitySnapshot_toRuntime / identityRuntime_enforceConsistency defined ✓');

// complete-onboarding: atomic, single handler creates both profile and workspace
const completeOnboardingBlock = BG_SRC.slice(
  BG_SRC.indexOf('"identity:complete-onboarding"'),
  BG_SRC.indexOf('"identity:complete-onboarding"') + 350
);
const completeManagerStart = BG_SRC.indexOf('async function identityAuthManager_completeOnboarding(');
const completeManagerEnd = BG_SRC.indexOf('async function identityAuthManager_attachLocalProfile(', completeManagerStart);
const completeManagerBlock = BG_SRC.slice(completeManagerStart, completeManagerEnd);
const completeProviderBlock = BG_SRC.slice(
  BG_SRC.indexOf('function identityMockProvider_completeOnboarding('),
  BG_SRC.indexOf('function identityMockProvider_completeOnboarding(') + 900
);
assert(completeOnboardingBlock.includes('identityAuthManager_completeOnboarding'), 'H2: bridge routes complete-onboarding to auth manager');
assert(completeProviderBlock.includes('identityRuntime_makeMockId("mock_profile")'), 'H2: mock provider creates profile');
assert(completeProviderBlock.includes('identityRuntime_makeMockId("mock_workspace")'), 'H2: mock provider creates workspace');
assert(completeProviderBlock.includes('onboardingCompleted: true'), 'H2: mock provider sets onboardingCompleted');
assert(completeManagerBlock.includes('identityAuthManager_publishSnapshotFromRuntime'), 'H2: manager publishes snapshot');
assert(completeManagerBlock.includes('nextStatus: "sync_ready"'), 'H2: manager returns sync_ready');
console.log('  complete-onboarding routes through manager and atomically creates profile+workspace ✓');

// Identity Core createInitialWorkspace uses complete-onboarding
assert(IDENTITY_SRC.includes("sendBridge('identity:complete-onboarding'"), 'H3: Identity Core uses complete-onboarding');
assert(!IDENTITY_SRC.includes("sendBridge('identity:create-profile'"), 'H3: Identity Core no longer splits create-profile');
assert(!IDENTITY_SRC.includes("sendBridge('identity:create-workspace'"), 'H3: Identity Core no longer splits create-workspace');
console.log('  Identity Core createInitialWorkspace uses atomic complete-onboarding ✓');

// get-snapshot falls back to runtime when stored snapshot is null
const getSnapshotBlock = BG_SRC.slice(
  BG_SRC.indexOf('"identity:get-snapshot"'),
  BG_SRC.indexOf('"identity:get-snapshot"') + 300
);
const getSnapshotManagerBlock = BG_SRC.slice(
  BG_SRC.indexOf('async function identityAuthManager_getSnapshot('),
  BG_SRC.indexOf('async function identityAuthManager_setSnapshot(')
);
assert(getSnapshotBlock.includes('identityAuthManager_getSnapshot'), 'H4: bridge routes get-snapshot to auth manager');
assert(getSnapshotManagerBlock.includes('identityAuthManager_getRuntime()'), 'H4: manager reads runtime as fallback');
assert(getSnapshotManagerBlock.includes('identitySnapshot_fromRuntime('), 'H4: manager synthesizes from runtime');
console.log('  identity:get-snapshot falls back to runtime through auth manager ✓');

// set-snapshot also updates runtime for consistency
const setSnapshotBlock = BG_SRC.slice(
  BG_SRC.indexOf('"identity:set-snapshot"'),
  BG_SRC.indexOf('"identity:set-snapshot"') + 300
);
const setSnapshotManagerBlock = BG_SRC.slice(
  BG_SRC.indexOf('async function identityAuthManager_setSnapshot('),
  BG_SRC.indexOf('async function identityAuthManager_clearSnapshot(')
);
assert(setSnapshotBlock.includes('identityAuthManager_setSnapshot'), 'H5: bridge routes set-snapshot to auth manager');
assert(setSnapshotManagerBlock.includes('identitySnapshot_toRuntime('), 'H5: manager syncs runtime via identitySnapshot_toRuntime');
assert(setSnapshotManagerBlock.includes('identityAuthManager_setRuntime('), 'H5: manager stores compatible runtime');
console.log('  identity:set-snapshot syncs runtime through auth manager ✓');

// asm_enforceRuntimeConsistency: profile_ready/sync_ready requires profile and,
// for provider-backed Supabase identity, completed credential setup.
const enforceBlock = BG_SRC.slice(
  BG_SRC.indexOf('function identityRuntime_enforceConsistency('),
  BG_SRC.indexOf('function identityRuntime_enforceConsistency(') + 1400
);
assert(enforceBlock.includes('profile_ready') && enforceBlock.includes('sync_ready'), 'H6: enforceRuntimeConsistency guards ready states');
assert(enforceBlock.includes('password_update_required'), 'H6: enforceRuntimeConsistency clamps provider ready state to password_update_required when credentials are incomplete');
assert(enforceBlock.includes('verified_no_profile'), 'H6: enforceRuntimeConsistency still clamps profile-less ready state to verified_no_profile');
assert(enforceBlock.includes('credentialState') && enforceBlock.includes('"complete"'), 'H6: enforceRuntimeConsistency requires complete credentialState for provider ready state');
assert(enforceBlock.includes('!rt.onboardingCompleted'), 'H6: enforceRuntimeConsistency requires onboardingCompleted');
console.log('  identityRuntime_enforceConsistency guards ready states require credentials + profile + onboarding ✓');

// asm_derivedFromRuntime also enforces consistency in output
const derivedBlock = BG_SRC.slice(
  BG_SRC.indexOf('function identitySnapshot_derivedFromRuntime('),
  BG_SRC.indexOf('function identitySnapshot_derivedFromRuntime(') + 1200
);
assert(derivedBlock.includes('identityRuntime_enforceConsistency'), 'H7: derivedFromRuntime uses consistency helper');
console.log('  identitySnapshot_derivedFromRuntime enforces status/profile consistency ✓');

// ── Suite I: functional — pull correctness simulation ───────────────────────
console.log('\n── Suite I: functional — pull correctness (split-brain fix) ────────');

// Simulate background storage + message handler in Node
{
  const mockSession = {};
  const mockLocal = {};

  const mockStorage = {
    session: {
      get: async (keys) => {
        const res = {};
        for (const k of keys) if (Object.prototype.hasOwnProperty.call(mockSession, k)) res[k] = mockSession[k];
        return res;
      },
      set: async (items) => { Object.assign(mockSession, items); },
      remove: async (keys) => { for (const k of keys) delete mockSession[k]; }
    },
    local: {
      get: async (keys) => {
        const res = {};
        for (const k of keys) if (Object.prototype.hasOwnProperty.call(mockLocal, k)) res[k] = mockLocal[k];
        return res;
      },
      set: async (items) => { Object.assign(mockLocal, items); },
      remove: async (keys) => { for (const k of keys) delete mockLocal[k]; }
    }
  };

  // Extract and evaluate the Phase 3.0A manager boundary from the source.
  const helperSrc = `
    const IDENTITY_MOCK_RUNTIME_KEY = "h2oIdentityProviderMockRuntimeV1";
    const IDENTITY_STORAGE_KEY = "h2oIdentityMockSnapshotV1";
    const _mockStorage = mockStorage;
    function storageSessionGet(keys) { return _mockStorage.session.get(keys); }
    function storageSessionSet(items) { return _mockStorage.session.set(items); }
    function storageSessionRemove(keys) { return _mockStorage.session.remove(keys); }
    function storageGet(keys) { return _mockStorage.local.get(keys); }
    function storageSet(items) { return _mockStorage.local.set(items); }
    function storageRemove(keys) { return _mockStorage.local.remove(keys); }
    function broadcastIdentityPush() {}
    function identityProviderBundle_getProbeStatus() {
      return {
        expected: false,
        loaded: false,
        kind: "skipped",
        phase: "3.0X",
        skipReason: "provider_config_inactive",
        clientSmokeAvailable: false,
        clientCreatedAtImport: false,
        clientCreated: false,
        networkEnabled: false,
        networkObserved: false,
        authCallsObserved: false,
        otpEnabled: false,
        smokeRun: false,
        clientSmokeErrorCode: null,
        realConfigSmokeAvailable: false,
        realConfigSmokeRun: false,
        realConfigClientCreated: false,
        realConfigNetworkObserved: false,
        realConfigAuthCallsObserved: false,
        realConfigOtpEnabled: false,
        realConfigSmokeErrorCode: null,
        clientReady: false,
        errorCode: null
      };
    }
  `;

  // Pull out helper function source text
  function extractFn(src, name) {
    const asyncIdx = src.indexOf('async function ' + name + '(');
    const syncIdx = src.indexOf('function ' + name + '(');
    const start = (asyncIdx >= 0 && (syncIdx < 0 || asyncIdx < syncIdx)) ? asyncIdx : syncIdx;
    if (start < 0) throw new Error(`Cannot find ${name}`);
    let bodyStart = -1;
    let parenDepth = 0;
    let seenParams = false;
    for (let i = start; i < src.length; i++) {
      if (src[i] === '(') { parenDepth++; seenParams = true; }
      else if (src[i] === ')') parenDepth = Math.max(0, parenDepth - 1);
      else if (src[i] === '{' && seenParams && parenDepth === 0) {
        bodyStart = i;
        break;
      }
    }
    if (bodyStart < 0) throw new Error(`Cannot find body for ${name}`);
    let depth = 0, i = bodyStart;
    while (i < src.length) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
      i++;
    }
    throw new Error(`Cannot find end of ${name}`);
  }

  const providerConfigConstSrc = BG_SRC.slice(
    BG_SRC.indexOf('const IDENTITY_PROVIDER_CONFIG_SCHEMA_VERSION'),
    BG_SRC.indexOf('function identityProviderConfig_get(')
  ).replace(
    /const IDENTITY_PROVIDER_CONFIG_INJECTED_STATUS = \$\{JSON\.stringify\(IDENTITY_PROVIDER_CONFIG_STATUS_SAFE\)\};/,
    'const IDENTITY_PROVIDER_CONFIG_INJECTED_STATUS = null;'
  );
  const providerOptionalHostConstSrc = [
    'const IDENTITY_PROVIDER_PHASE_NETWORK = null;',
    'const IDENTITY_PROVIDER_OPTIONAL_HOST_PATTERN = null;',
    'const IDENTITY_PROVIDER_OAUTH_PROVIDER = null;',
    'function identityProviderPermission_getExactHostPattern() { return ""; }',
    ''
  ].join('\n');
  const providerOtpSrc = BG_SRC.slice(
    BG_SRC.indexOf('const IDENTITY_PROVIDER_OTP_ALLOWED_ERROR_CODES'),
    BG_SRC.indexOf('async function identityRuntime_get(')
  );
  assert(providerOtpSrc.includes('identityProviderOtp_failure'), 'I0: provider OTP safe response helpers extracted');

  const runtimeFns = [
    'identityRuntime_nowIso',
    'identityRuntime_makeMockId',
    'identityRuntime_maskEmail',
    'identitySnapshot_sanitize',
    'identityProviderConfig_get',
    'identityProviderConfig_normalizeSourceName',
    'identityProviderConfig_getSource',
    'identityProviderConfig_getDevOnlySource',
    'identityProviderConfig_getSourceStatus',
    'identityProviderConfig_resolve',
    'identityProviderConfig_cleanStatusList',
    'identityProviderConfig_isRedactedStatus',
    'identityProviderConfig_normalizeInjectedStatus',
    'identityProviderConfig_validatePublicClientConfig',
    'identityProviderConfig_validateSupabaseShape',
    'identityProviderConfig_classifyConfig',
    'identityProviderConfig_missingFields',
    'identityProviderConfig_validateShape',
    'identityProviderConfig_getMode',
    'identityProviderConfig_isMock',
    'identityProviderConfig_isSupabaseConfigured',
    'identityProviderPermission_hasExactHostConfig',
    'identityProviderPermission_makeExactReadiness',
    'identityProviderPermission_getReadiness',
    'identityProviderPermission_containsExactHost',
    'identityProviderPermission_getReadinessAsync',
    'identityProviderNetwork_getReadiness',
    'identityProviderConfig_safeStatus',
    'identityProviderConfig_redact',
    'identityProviderConfig_diag',
    'identityProviderConfig_diagAsync',
    'identityProviderConfig_getInjectedSource',
    'identityRuntime_get',
    'identityRuntime_set',
    'identityRuntime_enforceConsistency',
    'identityRuntime_clear',
    'identitySnapshot_derivedFromRuntime',
    'identitySnapshot_fromRuntime',
    'identitySnapshot_toRuntime',
    'identitySnapshot_normalizeDisplayName',
    'identitySnapshot_normalizeWorkspaceName',
    'identitySnapshot_normalizeAvatarColor',
    'identitySnapshot_isReadyStatus',
    'identitySnapshot_hasReadyShape',
    'identityMockProvider_requestEmailOtp',
    'identityMockProvider_verifyEmailOtp',
    'identityMockProvider_createProfile',
    'identityMockProvider_createWorkspace',
    'identityMockProvider_completeOnboarding',
    'identityMockProvider_attachLocalProfile',
    'identityMockProvider_migrateLocalWorkspace',
    'identityMockProvider_refreshSession',
  ].map(name => extractFn(BG_SRC, name)).join('\n');

  const providerAdapterSrc = `
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
  `;
  const providerSessionStubSrc = `
    const IDENTITY_PROVIDER_SESSION_KEY = "h2oIdentityProviderSessionV1";
    async function providerSessionRemove() { return false; }
    async function identityProviderSession_hydrateOnWake() { return { ok: false }; }
    async function identityProviderSession_readRaw() { return null; }
    async function identityProviderSignOut_tryBestEffort() { return undefined; }
  `;

  const managerFns = [
    'identityAuthManager_getRuntime',
    'identityAuthManager_setRuntime',
    'identityAuthManager_clearRuntime',
    'identityAuthManager_getStoredSnapshot',
    'identityAuthManager_storeSnapshot',
    'identityAuthManager_clearStoredSnapshot',
    'identityAuthManager_publishSnapshotFromRuntime',
    'identityAuthManager_getSnapshot',
    'identityAuthManager_setSnapshot',
    'identityAuthManager_clearSnapshot',
    'identityAuthManager_getDerivedState',
    'identityAuthManager_getProviderAdapter',
    'identityAuthManager_requestEmailOtp',
    'identityAuthManager_verifyEmailOtp',
    'identityAuthManager_createProfile',
    'identityAuthManager_createWorkspace',
    'identityAuthManager_completeOnboarding',
    'identityAuthManager_attachLocalProfile',
    'identityAuthManager_migrateLocalWorkspace',
    'identityAuthManager_refreshSession',
    'identityAuthManager_clearSignOutLocalState',
    'identityAuthManager_signOut',
  ].map(name => extractFn(BG_SRC, name)).join('\n');

  const handlers = new Function('mockStorage', helperSrc + '\n' + providerOptionalHostConstSrc + '\n' + providerConfigConstSrc + '\n' + runtimeFns + '\n' + providerOtpSrc + '\n' + providerAdapterSrc + '\n' + providerSessionStubSrc + '\n' + managerFns + `
    async function handleGetSnapshot() {
      const res = await identityAuthManager_getSnapshot();
      return res.snapshot;
    }
    async function handleCompleteOnboarding(displayName, workspaceName) {
      await identityAuthManager_completeOnboarding({ displayName, workspaceName });
      return handleGetSnapshot();
    }
    async function handleSetSnapshot(snapshot) {
      return identityAuthManager_setSnapshot(snapshot);
    }
    async function handleClearSnapshot() {
      return identityAuthManager_clearSnapshot();
    }
    async function handleGetDerivedState() {
      const res = await identityAuthManager_getDerivedState();
      return res.derivedState;
    }
    return {
      handleGetSnapshot,
      handleCompleteOnboarding,
      handleSetSnapshot,
      handleClearSnapshot,
      handleGetDerivedState,
      identityProviderConfig_validateShape,
      identityProviderConfig_safeStatus,
      identityProviderConfig_getDevOnlySource,
      identityProviderConfig_getSourceStatus,
      identityProviderConfig_normalizeInjectedStatus,
      identityProviderConfig_isSupabaseConfigured,
      identityAuthManager_getRuntime,
      identityAuthManager_setRuntime,
      identityAuthManager_clearRuntime,
      identityAuthManager_signOut,
      storageRemove
    };
  `)(mockStorage);

  // I1: complete-onboarding → get-snapshot returns sync_ready with profile+workspace
  const snap = await handlers.handleCompleteOnboarding("Test User", "Test Workspace");
  assert(snap, 'I1: complete-onboarding returns a snapshot');
  assert(snap.status === "sync_ready", `I1: snapshot status should be sync_ready, got ${snap?.status}`);
  assert(snap.profile !== null, 'I1: snapshot must have profile');
  assert(snap.workspace !== null, 'I1: snapshot must have workspace');
  assert(snap.onboardingCompleted === true, 'I1: snapshot onboardingCompleted must be true');
  assert(!Object.prototype.hasOwnProperty.call(snap, 'providerConfigStatus'), 'I1: public snapshot must not include providerConfigStatus');
  console.log('  complete-onboarding snapshot: sync_ready + profile + workspace ✓');

  // I2: get-snapshot returns sync_ready (not null) after complete-onboarding
  const pulled = await handlers.handleGetSnapshot();
  assert(pulled, 'I2: get-snapshot must not return null after complete-onboarding');
  assert(pulled.status === "sync_ready", `I2: get-snapshot status should be sync_ready, got ${pulled?.status}`);
  assert(pulled.profile !== null, 'I2: get-snapshot must include profile');
  assert(pulled.workspace !== null, 'I2: get-snapshot must include workspace');
  console.log('  identity:get-snapshot returns sync_ready after complete-onboarding ✓');

  // I3: get-derived-state returns sync_ready with profile (not null, not inconsistent)
  const derived = await handlers.handleGetDerivedState();
  assert(derived.status === "sync_ready", `I3: derivedState status should be sync_ready, got ${derived?.status}`);
  assert(derived.profile !== null, 'I3: derivedState profile must not be null when sync_ready');
  assert(derived.onboardingCompleted === true, 'I3: derivedState onboardingCompleted must be true');
  assert(derived.syncReady === true, 'I3: derivedState syncReady must be true');
  console.log('  identity:get-derived-state returns sync_ready + profile (not null) ✓');

  // I3b: get-derived-state exposes only a safe, inert provider config status.
  const providerConfigStatus = derived.providerConfigStatus;
  assert(providerConfigStatus && typeof providerConfigStatus === "object", 'I3b: providerConfigStatus object present');
  assert(providerConfigStatus.providerKind === "mock", `I3b: providerKind must default to mock, got ${providerConfigStatus.providerKind}`);
  assert(providerConfigStatus.providerMode === "local_dev", `I3b: providerMode must default to local_dev, got ${providerConfigStatus.providerMode}`);
  assert(providerConfigStatus.providerConfigured === true, 'I3b: mock provider config must be configured');
  assert(providerConfigStatus.configSource === "built_in_mock", `I3b: configSource must default to built_in_mock, got ${providerConfigStatus.configSource}`);
  assert(providerConfigStatus.schemaVersion === "3.0N", `I3b: schemaVersion must be 3.0N, got ${providerConfigStatus.schemaVersion}`);
  assert(providerConfigStatus.valid === true, 'I3b: mock provider config must be valid');
  assert(providerConfigStatus.validationState === "valid", `I3b: validationState must be valid, got ${providerConfigStatus.validationState}`);
  assert(Array.isArray(providerConfigStatus.missingFields) && providerConfigStatus.missingFields.length === 0,
    'I3b: mock provider config must not report missing fields');
  assert(Array.isArray(providerConfigStatus.errorCodes) && providerConfigStatus.errorCodes.length === 0,
    'I3b: mock provider config must not report error codes');
  assert(providerConfigStatus.capabilities?.emailOtp === true, 'I3b: emailOtp capability true');
  assert(providerConfigStatus.capabilities?.magicLink === false, 'I3b: magicLink capability false');
  assert(providerConfigStatus.capabilities?.oauth === false, 'I3b: oauth capability false');
  assert(providerConfigStatus.permissionRequired === "deferred", `I3b: permissionRequired must be deferred, got ${providerConfigStatus.permissionRequired}`);
  assert(providerConfigStatus.permissionReady === false, 'I3b: permissionReady must be false');
  assert(providerConfigStatus.permissionSource === "deferred_until_project_host", `I3b: permissionSource must be deferred_until_project_host, got ${providerConfigStatus.permissionSource}`);
  assert(providerConfigStatus.permissionHostKind === "none", `I3b: permissionHostKind must be none, got ${providerConfigStatus.permissionHostKind}`);
  assert(providerConfigStatus.permissionStatus === "deferred", `I3b: permissionStatus must be deferred, got ${providerConfigStatus.permissionStatus}`);
  assert(providerConfigStatus.permissionErrorCode === null, 'I3b: permissionErrorCode must be null');
  assert(providerConfigStatus.phaseNetworkEnabled === false, 'I3b: phaseNetworkEnabled must be false');
  assert(providerConfigStatus.networkReady === false, 'I3b: networkReady must be false');
  assert(providerConfigStatus.networkStatus === "blocked", `I3b: networkStatus must be blocked, got ${providerConfigStatus.networkStatus}`);
  assert(providerConfigStatus.networkBlockReason === "phase_not_enabled", `I3b: networkBlockReason must be phase_not_enabled, got ${providerConfigStatus.networkBlockReason}`);
  assert(providerConfigStatus.clientReady === false, 'I3b: clientReady must be false in default mock/no-config mode');
  assert(providerConfigStatus.bundleProbe?.kind === "skipped", 'I3b: bundleProbe kind skipped in default mock/no-config mode');
  assert(providerConfigStatus.bundleProbe?.phase === "3.0X", 'I3b: bundleProbe phase 3.0X in default mock/no-config mode');
  assert(providerConfigStatus.bundleProbe?.skipReason === "provider_config_inactive", 'I3b: bundleProbe skipReason provider_config_inactive');
  assert(providerConfigStatus.bundleProbe?.expected === false, 'I3b: bundleProbe expected false in default mock/no-config mode');
  assert(providerConfigStatus.bundleProbe?.loaded === false, 'I3b: bundleProbe loaded false in default mock/no-config mode');
  assert(providerConfigStatus.bundleProbe?.smokeRun === false, 'I3b: bundleProbe smokeRun false in default mock/no-config mode');
  assert(providerConfigStatus.bundleProbe?.clientCreated === false, 'I3b: bundleProbe clientCreated false in default mock/no-config mode');
  assert(providerConfigStatus.bundleProbe?.networkObserved === false, 'I3b: bundleProbe networkObserved false');
  assert(providerConfigStatus.bundleProbe?.authCallsObserved === false, 'I3b: bundleProbe authCallsObserved false');
  assert(providerConfigStatus.bundleProbe?.otpEnabled === false, 'I3b: bundleProbe otpEnabled false');
  assert(providerConfigStatus.bundleProbe?.clientReady === false, 'I3b: bundleProbe clientReady false');
  assert(providerConfigStatus.bundleProbe?.realConfigSmokeRun === false, 'I3b: bundleProbe realConfigSmokeRun false');
  assert(providerConfigStatus.bundleProbe?.realConfigClientCreated === false, 'I3b: bundleProbe realConfigClientCreated false');
  const providerConfigStatusKeys = Object.keys(providerConfigStatus).sort().join(',');
  assert(providerConfigStatusKeys === 'bundleProbe,capabilities,clientReady,configSource,errorCodes,missingFields,networkBlockReason,networkReady,networkStatus,permissionErrorCode,permissionHostKind,permissionReady,permissionRequired,permissionSource,permissionStatus,phaseNetworkEnabled,providerConfigured,providerKind,providerMode,schemaVersion,valid,validationState',
    `I3b: providerConfigStatus exposes only safe keys, got ${providerConfigStatusKeys}`);
  const providerConfigStatusStr = JSON.stringify(providerConfigStatus).toLowerCase();
  for (const forbidden of ['access_token', 'refresh_token', 'id_token', 'provider_token', 'auth_code', 'otp_token_hash', 'password', 'secret', 'session', 'credential', 'projecturl', 'anonkey', 'servicekey']) {
    assert(!providerConfigStatusStr.includes(forbidden), `I3b: providerConfigStatus must not expose ${forbidden}`);
  }
  assert(!providerConfigStatusStr.includes('supabase'), 'I3b: mock providerConfigStatus must not expose Supabase raw config');
  const emptyDevSource = handlers.identityProviderConfig_getDevOnlySource("dev_empty_invalid");
  assert(emptyDevSource?.configSource === "dev_empty_invalid", 'I3b: dev empty invalid source descriptor available');
  const missingProviderConfigStatus = handlers.identityProviderConfig_getSourceStatus("dev_empty_invalid");
  assert(missingProviderConfigStatus.providerKind === "supabase", 'I3b: future provider status can classify provider-backed config');
  assert(missingProviderConfigStatus.providerMode === "provider_backed", 'I3b: future provider mode is provider_backed');
  assert(missingProviderConfigStatus.configSource === "dev_empty_invalid", 'I3b: missing future provider config reports dev_empty_invalid source');
  assert(missingProviderConfigStatus.providerConfigured === false, 'I3b: missing future provider config is not configured');
  assert(missingProviderConfigStatus.valid === false, 'I3b: missing future provider config is invalid');
  assert(missingProviderConfigStatus.validationState === "missing_config", 'I3b: missing future provider config reports missing_config');
  assert(missingProviderConfigStatus.missingFields.includes("provider_project"), 'I3b: missing future provider project uses generic label');
  assert(missingProviderConfigStatus.missingFields.includes("public_client"), 'I3b: missing future public client uses generic label');
  assert(missingProviderConfigStatus.errorCodes.includes("identity/config-missing-required"), 'I3b: missing future config reports generic missing error');
  assert(missingProviderConfigStatus.permissionRequired === "deferred", 'I3b: future missing config keeps permissionRequired deferred');
  assert(missingProviderConfigStatus.permissionReady === false, 'I3b: future missing config keeps permissionReady false');
  assert(missingProviderConfigStatus.phaseNetworkEnabled === false, 'I3b: future missing config keeps phaseNetworkEnabled false');
  assert(missingProviderConfigStatus.networkReady === false, 'I3b: future missing config keeps networkReady false');
  assert(missingProviderConfigStatus.networkStatus === "blocked", 'I3b: future missing config keeps networkStatus blocked');
  assert(missingProviderConfigStatus.networkBlockReason === "phase_not_enabled", 'I3b: future missing config keeps phase_not_enabled block reason');
  const elevatedDevSource = handlers.identityProviderConfig_getDevOnlySource("dev_elevated_invalid");
  assert(elevatedDevSource?.configSource === "dev_elevated_invalid", 'I3b: dev elevated invalid source descriptor available');
  const rejectedProviderConfigStatus = handlers.identityProviderConfig_getSourceStatus("dev_elevated_invalid");
  assert(rejectedProviderConfigStatus.configSource === "dev_elevated_invalid", 'I3b: rejected future provider config reports dev_elevated_invalid source');
  assert(rejectedProviderConfigStatus.valid === false, 'I3b: elevated future provider config is invalid');
  assert(rejectedProviderConfigStatus.validationState === "rejected", 'I3b: elevated future provider config reports rejected');
  assert(rejectedProviderConfigStatus.errorCodes.includes("identity/config-elevated-access-forbidden"),
    'I3b: elevated future provider config is rejected with generic code');
  const redactedValidInjectedStatus = handlers.identityProviderConfig_normalizeInjectedStatus({
    schemaVersion: "3.0N",
    providerKind: "supabase",
    providerMode: "provider_backed",
    providerConfigured: true,
    configSource: "dev_env",
    valid: true,
    validationState: "valid",
    missingFields: [],
    errorCodes: [],
    capabilities: { emailOtp: true, magicLink: false, oauth: false }
  });
  assert(redactedValidInjectedStatus?.configSource === "dev_env", 'I3b: redacted valid injected status reports dev_env source');
  assert(redactedValidInjectedStatus.providerKind === "supabase", 'I3b: redacted valid injected status is provider-backed');
  assert(redactedValidInjectedStatus.providerConfigured === true, 'I3b: redacted valid injected status can be configured');
  assert(redactedValidInjectedStatus.valid === true, 'I3b: redacted valid injected status is valid');
  assert(redactedValidInjectedStatus.validationState === "valid", 'I3b: redacted valid injected status reports valid');
  assert(handlers.identityProviderConfig_isSupabaseConfigured(redactedValidInjectedStatus) === true,
    'I3b: redacted valid injected status can pass config readiness without raw values');
  const redactedValidInjectedSafeStatus = handlers.identityProviderConfig_safeStatus(redactedValidInjectedStatus);
  assert(redactedValidInjectedSafeStatus.permissionRequired === "deferred", 'I3b: redacted valid injected status keeps permissionRequired deferred');
  assert(redactedValidInjectedSafeStatus.permissionReady === false, 'I3b: redacted valid injected status keeps permissionReady false');
  assert(redactedValidInjectedSafeStatus.phaseNetworkEnabled === false, 'I3b: redacted valid injected status keeps phaseNetworkEnabled false');
  assert(redactedValidInjectedSafeStatus.networkReady === false, 'I3b: redacted valid injected status keeps networkReady false');
  assert(redactedValidInjectedSafeStatus.networkStatus === "blocked", 'I3b: redacted valid injected status keeps networkStatus blocked');
  assert(redactedValidInjectedSafeStatus.networkBlockReason === "phase_not_enabled", 'I3b: redacted valid injected status keeps phase_not_enabled block reason');
  assert(redactedValidInjectedSafeStatus.clientReady === false,
    'I3b: redacted valid injected status has no clientReady in unit harness without private config smoke');
  const futureProviderConfigStatusStr = JSON.stringify([missingProviderConfigStatus, rejectedProviderConfigStatus, redactedValidInjectedStatus]).toLowerCase();
  for (const forbidden of ['access_token', 'refresh_token', 'id_token', 'provider_token', 'auth_code', 'otp_token_hash', 'password', 'secret', 'session', 'credential', 'projecturl', 'anonkey', 'servicekey']) {
    assert(!futureProviderConfigStatusStr.includes(forbidden), `I3b: future providerConfigStatus must not expose ${forbidden}`);
  }
  console.log('  providerConfigStatus is mock/local, inert, and token-free ✓');

  // I4: get-snapshot and get-derived-state agree on status and profile readiness
  assert(pulled.status === derived.status, `I4: get-snapshot (${pulled.status}) and get-derived-state (${derived.status}) must agree on status`);
  assert(Boolean(pulled.profile) === Boolean(derived.profile), 'I4: get-snapshot and get-derived-state must agree on profile presence');
  assert(Boolean(pulled.workspace) === Boolean(derived.workspace), 'I4: get-snapshot and get-derived-state must agree on workspace presence');
  console.log('  get-snapshot and get-derived-state agree on status + profile + workspace ✓');

  // I5: set-snapshot (from popup scheduleBridgeWrite) also updates runtime
  const fullPopupSnapshot = {
    version: "0.1.0", status: "sync_ready",
    mode: "local_dev", provider: "mock_local",
    pendingEmail: null, emailVerified: true,
    profile: { id: "profile_xyz", userId: "user_xyz", email: "test@example.com", emailVerified: true, displayName: "Full User", avatarColor: "#059669", workspaceId: "ws_xyz", onboardingCompleted: true, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:01Z" },
    workspace: { id: "ws_xyz", ownerUserId: "user_xyz", name: "Full Workspace", origin: "local_mock", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:01Z" },
    onboardingCompleted: true, lastError: null, updatedAt: "2026-01-01T00:00:01Z"
  };
  await handlers.handleSetSnapshot(fullPopupSnapshot);
  const afterSet = await handlers.handleGetSnapshot();
  const afterSetDerived = await handlers.handleGetDerivedState();
  assert(afterSet?.status === "sync_ready", 'I5: after set-snapshot, get-snapshot still returns sync_ready');
  assert(afterSetDerived.status === "sync_ready", 'I5: after set-snapshot, get-derived-state still returns sync_ready');
  assert(afterSetDerived.profile !== null, 'I5: after set-snapshot, derivedState has profile');
  console.log('  identity:set-snapshot keeps runtime in sync → get-derived-state still correct ✓');

  // I6: sign-out clears both runtime and snapshot to anonymous_local
  await handlers.identityAuthManager_signOut();
  const afterSignOut = await handlers.handleGetSnapshot();
  const afterSignOutDerived = await handlers.handleGetDerivedState();
  assert(!afterSignOut || afterSignOut.status === "anonymous_local", `I6: after sign-out, get-snapshot must be null or anonymous_local (got ${afterSignOut?.status})`);
  assert(afterSignOutDerived.status === "anonymous_local", `I6: after sign-out, get-derived-state must be anonymous_local (got ${afterSignOutDerived?.status})`);
  console.log('  sign-out clears to anonymous_local in both endpoints ✓');

  // I7: consistency invariant — derivedState never reports profile_ready/sync_ready with profile:null
  const inconsistentRt = { status: "sync_ready", syncReady: true, onboardingCompleted: false, profile: null, workspace: null };
  await handlers.identityAuthManager_setRuntime(inconsistentRt);
  const clamped = await handlers.handleGetDerivedState();
  assert(clamped.status !== "sync_ready" || clamped.profile !== null,
    `I7: inconsistent runtime (sync_ready+no profile) must be clamped, got status=${clamped.status} profile=${JSON.stringify(clamped.profile)}`);
  console.log('  consistency invariant: profile_ready/sync_ready with profile:null is clamped ✓');

  // I8: clear-snapshot does not split readiness; get-snapshot recovers from runtime
  await handlers.handleCompleteOnboarding("Clear Snap User", "Clear Snap Workspace");
  await handlers.handleClearSnapshot();
  const afterClearSnapshot = await handlers.handleGetSnapshot();
  const afterClearDerived = await handlers.handleGetDerivedState();
  assert(afterClearSnapshot, 'I8: get-snapshot recovers from runtime after snapshot clear');
  assert(afterClearSnapshot.status === afterClearDerived.status, 'I8: snapshot and derived status agree after snapshot clear');
  assert(Boolean(afterClearSnapshot.profile) === Boolean(afterClearDerived.profile), 'I8: snapshot and derived profile presence agree after snapshot clear');
  assert(Boolean(afterClearSnapshot.workspace) === Boolean(afterClearDerived.workspace), 'I8: snapshot and derived workspace presence agree after snapshot clear');
  console.log('  clear-snapshot keeps endpoints consistent via runtime synthesis ✓');

  // I9: ready derived states always have profile and onboardingCompleted
  await handlers.identityAuthManager_setRuntime({ status: "profile_ready", onboardingCompleted: false, profile: { id: "p1" }, workspace: null });
  const notReadyWithoutOnboarding = await handlers.handleGetDerivedState();
  assert(
    !(["profile_ready", "sync_ready"].includes(notReadyWithoutOnboarding.status) && !notReadyWithoutOnboarding.onboardingCompleted),
    'I9: derived ready states must have onboardingCompleted true'
  );
  console.log('  consistency invariant: ready derived states require onboardingCompleted ✓');

  // I10: set-snapshot clamps inconsistent ready snapshots so endpoints cannot split
  await handlers.handleSetSnapshot({
    version: "0.1.0",
    status: "sync_ready",
    mode: "local_dev",
    provider: "mock_local",
    pendingEmail: null,
    emailVerified: true,
    profile: null,
    workspace: { id: "ws_bad", name: "Bad Workspace", role: "owner" },
    onboardingCompleted: false,
    lastError: null,
    updatedAt: "2026-01-01T00:00:00Z"
  });
  const afterBadSetSnapshot = await handlers.handleGetSnapshot();
  const afterBadSetDerived = await handlers.handleGetDerivedState();
  assert(!(afterBadSetSnapshot?.status === "sync_ready" && !afterBadSetSnapshot.profile),
    'I10: get-snapshot must not return sync_ready with profile:null after bad set-snapshot');
  assert(afterBadSetSnapshot?.status === afterBadSetDerived.status,
    'I10: snapshot and derived status agree after bad set-snapshot');
  console.log('  set-snapshot clamps inconsistent ready snapshots ✓');
}

console.log('\n══════════════════════════════════════════════════════════');
console.log('Identity Phase 2.9/3.0C validation PASSED — all checks ✓');
console.log('Mock provider adapter/AuthSessionManager/provider config source boundary in place.');
console.log('No real Supabase/provider auth, network, keys, or config values implemented.');
console.log('══════════════════════════════════════════════════════════\n');
