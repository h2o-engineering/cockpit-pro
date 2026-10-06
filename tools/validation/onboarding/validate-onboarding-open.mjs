// Onboarding open fix validation (popup-blocker bypass via background windows.create).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RUNTIME_BASE_DIR, extensionBuildDir } from '../../paths.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const CHROME_TOOL_DIR = path.join(REPO_ROOT, 'tools', 'product', 'extensions', 'chatgpt', 'chrome');
const IDENTITY_SCRIPT = path.join(RUNTIME_BASE_DIR, '0D4a.⬛️🔐 Identity Core 🔐.js');
const LOADER_SRC   = fs.readFileSync(path.join(CHROME_TOOL_DIR, 'chrome-live-loader.mjs'), 'utf8');
const BG_SRC       = fs.readFileSync(path.join(CHROME_TOOL_DIR, 'chrome-live-background.mjs'), 'utf8');
const IDENTITY_SRC = fs.readFileSync(IDENTITY_SCRIPT, 'utf8');

function assert(condition, message) {
  if (!condition) throw new Error(`FAIL: ${message}`);
}

// ── Suite A: static checks ────────────────────────────────────────────────────
console.log('\n── Suite A: static source checks ────────────────────────────────');

// A1: openOnboarding calls sendBridge('identity:open-onboarding') for page context
assert(IDENTITY_SRC.includes("sendBridge('identity:open-onboarding')"), 'A1: uses identity:open-onboarding bridge');
console.log('  uses identity:open-onboarding bridge ✓');

// A2: openWindowDirect helper exists (synchronous window.open wrapper)
assert(IDENTITY_SRC.includes('function openWindowDirect('), 'A2: openWindowDirect helper defined');
console.log('  openWindowDirect helper defined ✓');

// A3: Extension-page path calls openWindowDirect before any await
const openFnStart = IDENTITY_SRC.indexOf('async function openOnboarding(');
const openFnEnd   = IDENTITY_SRC.indexOf('\n  function openWindowDirect(');
const openFnBody  = IDENTITY_SRC.slice(openFnStart, openFnEnd);
// openWindowDirect must appear before sendBridge in the function body
const directPos  = openFnBody.indexOf('openWindowDirect(url');
const bridgePos  = openFnBody.indexOf("sendBridge('identity:open-onboarding')");
assert(directPos !== -1, 'A3: openWindowDirect call found in openOnboarding');
assert(bridgePos !== -1, 'A3: bridge call found in openOnboarding');
assert(directPos < bridgePos, 'A3: openWindowDirect (sync) called before bridge (async)');
console.log('  sync path precedes async bridge path ✓');

// A4: No fallback to relative /surfaces/... URL
assert(!IDENTITY_SRC.includes("return '/surfaces/identity/identity.html'"), 'A4: no relative URL fallback');
console.log('  no relative URL fallback ✓');

// A5: background handles identity:open-onboarding with chrome.windows.create
assert(BG_SRC.includes('action === "identity:open-onboarding"'), 'A5: background handles identity:open-onboarding');
assert(BG_SRC.includes('chrome.windows.create'), 'A5: background uses chrome.windows.create');
assert(BG_SRC.includes('type: "popup"'), 'A5: popup type set');
assert(BG_SRC.includes('focused: true'), 'A5: focused:true set');
console.log('  background opens popup via chrome.windows.create ✓');

// A6: loader ALLOW_ACTIONS includes identity:open-onboarding
assert(LOADER_SRC.includes('"identity:open-onboarding"'), 'A6: loader allows identity:open-onboarding');
console.log('  loader ALLOW_ACTIONS includes identity:open-onboarding ✓');

// A7: built outputs include the new action
const builtLoader = fs.readFileSync(path.join(extensionBuildDir('dev-controls'), 'loader.js'), 'utf8');
const builtBg     = fs.readFileSync(path.join(extensionBuildDir('dev-controls'), 'bg.js'), 'utf8');
assert(builtLoader.includes('"identity:open-onboarding"'), 'A7: built loader includes identity:open-onboarding');
assert(builtBg.includes('identity:open-onboarding'), 'A7: built bg.js includes identity:open-onboarding');
console.log('  built outputs include identity:open-onboarding ✓');

// A8: the specific bad fallback — `return '/surfaces/...'` — is gone
assert(!IDENTITY_SRC.includes("return '/surfaces/identity/identity.html'"), 'A8: no bare relative URL return');
assert(!IDENTITY_SRC.includes('return "/surfaces/identity/identity.html"'), 'A8: no bare relative URL return (double quote)');
console.log('  no bare relative URL fallback return ✓');

console.log('Suite A PASSED ✓');

// ── Suite B: functional — page context (mock bridge relay) ────────────────────
console.log('\n── Suite B: functional — page context bridge-open path ───────────');

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
    postMessage(data) {
      const ev = Object.assign(new g.CustomEvent('message'), { source: g, data });
      setTimeout(() => g.dispatchEvent(ev), 0);
    },
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

async function flush(ms = 200) {
  await new Promise(r => setTimeout(r, ms));
}

const MSG_REQ = 'h2o-ext-identity:v1:req';
const MSG_RES = 'h2o-ext-identity:v1:res';

// B1: page context — window.open NOT called; bridge opens the window
{
  const g = makeGlobal({ location: { protocol: 'https:' } });
  let windowOpenCalled = false;
  g.open = () => { windowOpenCalled = true; return null; };

  // Simulate loader relay: respond ok to identity:open-onboarding
  g.addEventListener('message', (ev) => {
    if (ev.source !== g) return;
    const d = ev.data;
    if (!d || d.type !== MSG_REQ) return;
    if (d.req?.action === 'identity:open-onboarding') {
      setTimeout(() => {
        g.dispatchEvent(Object.assign(new g.CustomEvent('message'), {
          source: g,
          data: { type: MSG_RES, id: d.id, ok: true, windowId: 42 }
        }));
      }, 5);
    }
    // Let identity:get-snapshot time out (no snapshot in bridge)
  });

  const id = bootIdentity(g);
  await flush(300);

  const result = await id.openOnboarding();

  assert(!windowOpenCalled, 'B1: window.open NOT called in page context (background opens it)');
  assert(result === true, `B1: openOnboarding returns true when bridge succeeds (got: ${result})`);
  console.log('  page context: window.open skipped, bridge returns success ✓');
}

// B2: page context — bridge fails → returns null, window.open still not called
{
  const g = makeGlobal({ location: { protocol: 'https:' } });
  let windowOpenCalled = false;
  g.open = () => { windowOpenCalled = true; return null; };

  // Relay returns failure
  g.addEventListener('message', (ev) => {
    if (ev.source !== g) return;
    const d = ev.data;
    if (!d || d.type !== MSG_REQ || d.req?.action !== 'identity:open-onboarding') return;
    setTimeout(() => {
      g.dispatchEvent(Object.assign(new g.CustomEvent('message'), {
        source: g,
        data: { type: MSG_RES, id: d.id, ok: false, error: 'extension unavailable' }
      }));
    }, 5);
  });

  const id = bootIdentity(g);
  await flush(300);

  const result = await id.openOnboarding();

  assert(!windowOpenCalled, 'B2: window.open never called when bridge fails');
  assert(result === null, `B2: returns null when bridge fails (got: ${result})`);
  console.log('  bridge failure → null, window.open never called ✓');
}

// B3: extension-page context — window.open IS called directly (no bridge)
{
  const FAKE_EXT = 'chrome-extension://xyz999/surfaces/identity/identity.html';
  const g = makeGlobal({ location: { protocol: 'chrome-extension:' } });
  let openedUrl = null;
  let openOnboardingViaBridge = false;
  g.open = (url) => { openedUrl = url; return { _win: true }; };
  g.chrome = {
    runtime: {
      getURL: (p) => `chrome-extension://xyz999/${p}`,
      // sendMessage is used by the hydration bridge (get-snapshot); track only open-onboarding
      sendMessage: (msg, cb) => {
        if (msg?.req?.action === 'identity:open-onboarding') openOnboardingViaBridge = true;
        // Let hydration (get-snapshot) resolve to null
        setTimeout(() => cb && cb(null), 5);
      },
      lastError: undefined,
    },
  };

  const id = bootIdentity(g);
  await flush(300);

  const result = await id.openOnboarding();

  assert(openedUrl === FAKE_EXT, `B3: window.open called with chrome-extension:// URL (got: ${openedUrl})`);
  assert(!openOnboardingViaBridge, 'B3: identity:open-onboarding bridge NOT used in extension-page context');
  assert(result !== null, 'B3: returns non-null on success');
  console.log('  extension-page context: window.open called directly, no bridge ✓');
}

// B4: explicit URL option — window.open called with provided URL, no bridge
{
  const g = makeGlobal({ location: { protocol: 'https:' } });
  let openedUrl = null;
  let openOnboardingBridgeAttempted = false;
  g.open = (url) => { openedUrl = url; return { _win: true }; };
  g.addEventListener('message', (ev) => {
    const d = ev?.data;
    if (d?.type === MSG_REQ && d.req?.action === 'identity:open-onboarding') {
      openOnboardingBridgeAttempted = true;
    }
  });

  const id = bootIdentity(g);
  await flush(300);

  const result = await id.openOnboarding({ url: 'chrome-extension://explicit/surfaces/identity/identity.html' });

  assert(openedUrl === 'chrome-extension://explicit/surfaces/identity/identity.html', 'B4: explicit URL used directly');
  assert(!openOnboardingBridgeAttempted, 'B4: identity:open-onboarding bridge not called when explicit URL provided');
  console.log('  explicit URL option bypasses bridge ✓');
}

console.log('Suite B PASSED ✓');

// ── Suite C: Control Hub integration check ────────────────────────────────────
console.log('\n── Suite C: Control Hub integration ─────────────────────────────');

const CHUB_SRC = fs.readFileSync(
  path.join(RUNTIME_BASE_DIR, '0Z1a.⬛️🕹️ Control Hub 🕹️.js'), 'utf8'
);
const CHUB_ACCOUNT_SRC = fs.readFileSync(
  path.join(RUNTIME_BASE_DIR, '0Z1e.⚫️🔐 Account Tab (Control Hub 🔌 Plugin) 🔐.js'), 'utf8'
);
const CHUB_ACCOUNT_SURFACE = `${CHUB_SRC}\n${CHUB_ACCOUNT_SRC}`;

// C1: Control Hub checks win truthiness for message
assert(CHUB_ACCOUNT_SURFACE.includes("? { message: 'Onboarding page opened.' }"), 'C1: Control Hub Account surface reports success when win truthy');
assert(CHUB_ACCOUNT_SURFACE.includes('Could not open onboarding'), 'C1: Control Hub Account surface reports failure message');
console.log('  Control Hub win check in place ✓');

// C2: Control Hub may display safe provider labels, but must not own provider auth.
assert(!/@supabase\/supabase-js|identity-provider-supabase|H2O_IDENTITY_PROVIDER_BUNDLE_PROBE/.test(CHUB_ACCOUNT_SURFACE),
  'C2: no Supabase SDK/provider bundle ownership');
assert(!/\.rpc\s*\(|\.from\s*\(\s*['"`](profiles|workspaces|workspace_memberships|identity_password_status|identity_oauth_status)['"`]/.test(CHUB_ACCOUNT_SURFACE),
  'C2: no direct Supabase table/RPC calls');
assert(!CHUB_ACCOUNT_SURFACE.includes('firebase'), 'C2: no firebase');
assert(!CHUB_ACCOUNT_SURFACE.includes('clerk'), 'C2: no clerk');
console.log('  no provider-owned auth added ✓');

console.log('Suite C PASSED ✓');

console.log('\n═══════════════════════════════════════════════════════');
console.log('Onboarding open fix validation PASSED — all checks ✓');
console.log('═══════════════════════════════════════════════════════\n');
