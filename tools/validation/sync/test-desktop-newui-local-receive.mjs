#!/usr/bin/env node
/* New UI Chrome -> Desktop Receive.
 *
 * The governed native command h2o_local_publication_receive existed and was
 * registered, but no New UI surface routed to it: Browser Delivery's Desktop
 * branch offered only Prepare, Destination settings and Refresh. That made a
 * real acceptance step reachable from Legacy only, which is not allowed — New
 * must be the complete operational surface.
 *
 * This drives the REAL panel and the REAL Desktop producer, and asserts the
 * properties that make the control safe to hand an operator: one activation is
 * exactly one invocation, nothing receives on mount or refresh, nothing
 * retries, noApply/noNetwork are contract rather than decoration, and a staged
 * fork never renders like an accepted admission. */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const panelRel = "src-surfaces-base/studio/settings/browser-delivery.panel.js";
const producerRel = "src-surfaces-base/studio/sync/browser-delivery-producer.tauri.js";
const panelSource = fs.readFileSync(path.join(repoRoot, panelRel), "utf8");
const producerSource = fs.readFileSync(path.join(repoRoot, producerRel), "utf8");

let assertions = 0;
const check = (value, message) => { assert.ok(value, message); assertions += 1; };
const equal = (a, b, message) => { assert.deepEqual(a, b, message); assertions += 1; };

const RECEIVE_SCHEMA = "h2o.studio.local-publication-receive-result.v1";
const divergentNative = () => ({
  schema: RECEIVE_SCHEMA,
  ok: true,
  verdict: "revision-staged-divergent",
  reason: "sibling-fork",
  objectId: "6a7dd257-3e34-83eb-9645-6d20a6f22610",
  revisionId: "snap_1786915231908_ih529cch",
  historicalAdmission: "divergent-staged",
  unchangedNoOp: false,
  observationCount: 1,
  noApply: true,
  noNetwork: true,
});
const admittedNative = () => ({
  ...divergentNative(),
  verdict: "revision-admitted",
  reason: "fast-forward",
  historicalAdmission: "accepted-linear",
});

/* ── the REAL producer, with only the native call substituted ──────────── */
function loadProducer(nativeLocalReceive) {
  const calls = [];
  const H2O = { Desktop: {}, Studio: { sync: {} } };
  const sandbox = {
    console, Promise, Object, Array, String, Number, Boolean, JSON, Math,
    Set, Map, Error, RegExp, Date, TextEncoder, crypto: globalThis.crypto,
    H2O,
    /* The producer is Tauri-only by design and returns early otherwise. */
    __TAURI_INTERNALS__: { invoke: () => { throw new Error("no real invoke in this harness"); } },
  };
  sandbox.globalThis = sandbox;
  sandbox.window = sandbox;
  vm.runInNewContext(producerSource, sandbox, { filename: producerRel });
  const api = sandbox.H2O.Desktop.SyncObjectDelivery;
  api.__test.setDependencies({
    nativeLocalReceive: (...args) => {
      calls.push(args);
      return nativeLocalReceive();
    },
  });
  return { api, calls };
}

/* ── the REAL panel, mounted in Desktop mode ───────────────────────────── */
function makeView() {
  const clean = (v) => String(v == null ? "" : v).trim();
  return {
    clean,
    escapeHtml: (v) => String(v == null ? "" : v)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"),
    valueText: (v, fallback = "Not available") => (clean(v) || fallback),
    statusRows: (rows) => (rows || []).map(([l, v]) => `${l}: ${v}`).join("\n"),
    card: (title, body) => `<section data-card="${title}">${body}</section>`,
    action: (id, label, options = {}) =>
      `<button data-domain-action="${id}"${options.disabled ? " disabled" : ""}>${label}</button>`,
    link: (href, label) => `<a href="${href}">${label}</a>`,
    frame: null,
    listen: null,
    setBody: (root, html) => { root.html = html; },
  };
}

async function mountDesktopPanel(desktopApi, loads) {
  const view = makeView();
  const listeners = [];
  let root = null;
  view.frame = () => (root = { html: "", contains: () => true });
  view.listen = (_r, type, handler) => { listeners.push({ type, handler }); return () => {}; };

  let registration = null;
  /* Desktop mode is the ABSENCE of the Chrome delivery API — exactly the gate
   * the panel itself uses. */
  const H2O = {
    Desktop: { SyncObjectDelivery: desktopApi },
    Studio: {
      sync: { folder: {} },
      platform: { storage: { get: async () => null, set: async () => {} } },
      settings: {
        domainPanels: {
          view,
          register: (spec) => { registration = spec; },
          loadScriptOnce: async (rel, ready) => { loads.push(rel); return ready(); },
        },
      },
    },
  };
  const sandbox = {
    console, Promise, Object, Array, String, Number, Boolean, JSON, Math,
    Set, Map, Error, RegExp, Date, H2O,
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(panelSource, sandbox, { filename: panelRel });
  check(!!registration, "the real Browser Delivery panel registers");
  await registration.mount({});
  const fire = async (type, action) => {
    for (const l of listeners.filter((x) => x.type === type)) {
      await l.handler({
        target: {
          closest: (sel) => (sel === "[data-domain-action]"
            ? { dataset: { domainAction: action }, disabled: false }
            : null),
          matches: () => false,
        },
        preventDefault() {},
      });
    }
  };
  return { get html() { return root.html; }, click: (a) => fire("click", a) };
}

/* ── A. the control exists in New, in the Desktop surface ──────────────── */
{
  const { api, calls } = loadProducer(divergentNative);
  const loads = [];
  const panel = await mountDesktopPanel(api, loads);
  check(panel.html.includes('data-domain-action="receive-local"'),
    "A: New UI Browser Delivery exposes the Chrome -> Desktop Receive control");
  check(panel.html.includes("Receive from Chrome"),
    "A: the control names its direction unambiguously");
  check(panel.html.includes('data-browser-delivery-receive-card="1"'),
    "A: an intake result surface is rendered");

  // B/C: nothing received on mount, and nothing on refresh or re-render.
  equal(calls.length, 0, "B: mounting the panel performs no Receive");
  await panel.click("refresh");
  equal(calls.length, 0, "C: Refresh performs no Receive");
  check(panel.html.includes("No revision received yet"),
    "C: before any activation the panel says nothing was received");
}

/* ── D. one activation is exactly one governed invocation ──────────────── */
{
  const { api, calls } = loadProducer(divergentNative);
  const loads = [];
  const panel = await mountDesktopPanel(api, loads);
  await panel.click("receive-local");
  equal(calls.length, 1, "D: one explicit activation performs exactly one Receive");
  equal(calls[0].length, 0, "D: the command is invoked with no arguments — the native side owns the folder");
  check(loads.includes("./sync/browser-delivery-producer.tauri.js"),
    "D: intake routes through the existing Desktop producer, not a second implementation");
  await panel.click("receive-local");
  equal(calls.length, 2, "D: a second activation is a second invocation, never a silent retry of the first");
}

/* ── E. a staged fork must not read like an admission ──────────────────── */
{
  const { api } = loadProducer(divergentNative);
  const panel = await mountDesktopPanel(api, []);
  await panel.click("receive-local");
  check(panel.html.includes("Staged as divergent"),
    "E: divergent-staged is surfaced in the operator-visible headline");
  check(panel.html.includes("not adopted"),
    "E: the headline states the revision was not adopted");
  check(panel.html.includes("divergent-staged"),
    "E: the raw admission disposition is reported verbatim");
  check(panel.html.includes("snap_1786915231908_ih529cch"),
    "E: the admitted revision identity is reported");
  check(panel.html.includes("sibling-fork"),
    "E: the native admission reason is reported verbatim");
  check(panel.html.includes("Not applied"),
    "E: no-apply is reported to the operator");
  check(!panel.html.includes("Admitted — accepted-linear"),
    "E: a staged fork never renders the accepted-linear headline");
}
{
  const { api } = loadProducer(admittedNative);
  const panel = await mountDesktopPanel(api, []);
  await panel.click("receive-local");
  check(panel.html.includes("Admitted — accepted-linear"),
    "E: an accepted-linear admission renders its own distinct headline");
  check(!panel.html.includes("Staged as divergent"),
    "E: an accepted admission never renders as divergent");
}

/* ── F. noApply / noNetwork are contract, not decoration ───────────────── */
for (const [field, label] of [["noApply", "F: a native result that does not assert noApply is refused"],
                              ["noNetwork", "F: a native result that does not assert noNetwork is refused"]]) {
  const { api } = loadProducer(() => ({ ...divergentNative(), [field]: false }));
  const panel = await mountDesktopPanel(api, []);
  const result = await api.receiveLocalPublication();
  equal(result.ok, false, label);
  equal(result.errorCode, "round2-item11-local-publication-receive-failed",
    `${label} with the governed error code`);
  await panel.click("receive-local");
  check(panel.html.includes("Blocked"), `${label} and the panel says Blocked`);
}
{
  const { api } = loadProducer(() => ({ verdict: "revision-admitted", ok: true, noApply: true, noNetwork: true }));
  const result = await api.receiveLocalPublication();
  equal(result.ok, false, "F: a result carrying a foreign schema is refused rather than rendered as an admission");
}

/* ── G. no transport, no apply, no polling anywhere in the bridge ──────── */
{
  const start = producerSource.indexOf("function invokeNativeLocalReceive");
  const end = producerSource.indexOf("async function setExistingSyncConfigFolder");
  check(start >= 0 && end > start, "G: the receive bridge is present in the producer");
  const bridge = producerSource.slice(start, end);
  for (const forbidden of ["fetch(", "XMLHttpRequest", "WebSocket", "webdav", "relay",
    "setInterval", "setTimeout", "http://", "https://"]) {
    check(!bridge.toLowerCase().includes(forbidden.toLowerCase()),
      `G: the receive bridge contains no ${forbidden}`);
  }
  check(bridge.includes("invoke('h2o_local_publication_receive')"),
    "G: the bridge calls the existing governed native command");
  check(!/invoke\('h2o_local_publication_receive',/.test(bridge),
    "G: no argument is ever passed to the native receive command");
  check(bridge.includes("localReceiveInFlight"),
    "G: a concurrent activation cannot start a second overlapping intake");
}

/* ── H. Desktop -> Chrome preparation and Local Folder are not regressed ─ */
{
  const { api, calls } = loadProducer(divergentNative);
  const panel = await mountDesktopPanel(api, []);
  check(panel.html.includes('data-domain-action="prepare"'),
    "H: Desktop -> Chrome Prepare remains present");
  check(panel.html.includes('data-browser-delivery-object-id="1"'),
    "H: the Prepare object-ID authority remains present");
  check(panel.html.includes("#/settings/sync-new/local-folder"),
    "H: the Local Folder authorization route remains reachable");
  await panel.click("prepare");
  equal(calls.length, 0, "H: Prepare does not invoke the receive command");
  for (const fn of ["prepareBrowserDelivery", "prepareLocalBrowserDelivery", "readLineage", "selectDeliveryFolder", "diagnose"]) {
    check(typeof api[fn] === "function", `H: pre-existing producer authority ${fn} survives`);
  }
}

/* ── I. New is sufficient: no Legacy dependency on the intake path ─────── */
{
  const desktopBranch = panelSource.slice(
    panelSource.indexOf('const actions = chrome'),
    panelSource.indexOf('const lineage = projectLineage'),
  );
  check(desktopBranch.includes('receive-local'), "I: the Desktop action set owns the intake control");
  check(!/manual-sync|legacy/i.test(desktopBranch),
    "I: the New UI intake path references no Legacy surface");
  const intakeAt = panelSource.indexOf('action === "receive-local"');
  const objectGuardAt = panelSource.indexOf('if (!objectId) throw');
  check(intakeAt >= 0 && objectGuardAt > intakeAt,
    "I: intake is decided before the Prepare-only object-ID guard, so Receive needs no object ID");
}

/* ── J. an older frozen producer must not strand the panel ─────────────── */
{
  /* The producer freezes its export object and returns early on re-entry, so a
   * producer registered before this panel loaded can never gain a new member.
   * Readiness must therefore not depend on intake. */
  const readiness = panelSource.slice(
    panelSource.indexOf("panels.loadScriptOnce(\"./sync/browser-delivery-producer.tauri.js\""),
    panelSource.indexOf("return W.H2O.Desktop.SyncObjectDelivery;"),
  ).replace(/\/\*[\s\S]*?\*\//g, "");   // the predicate itself, not its rationale
  check(!readiness.includes("receiveLocalPublication"),
    "J: Desktop API readiness does not require the intake bridge");
  check(readiness.includes("prepareLocalBrowserDelivery") && readiness.includes("readLineage"),
    "J: readiness keeps its pre-existing contract");

  // A producer without intake still mounts, and every other control survives.
  const legacyApi = { ...loadProducer(divergentNative).api };
  delete legacyApi.receiveLocalPublication;
  const panel = await mountDesktopPanel(legacyApi, []);
  check(panel.html.includes('data-domain-action="prepare"'),
    "J: Prepare survives a Desktop runtime without the intake bridge");
  check(panel.html.includes('data-domain-action="receive-local"'),
    "J: the intake control is still rendered");

  // K: clicking it reports, never hangs.
  const settled = await Promise.race([
    panel.click("receive-local").then(() => "settled"),
    new Promise((r) => setTimeout(() => r("HUNG"), 2000)),
  ]);
  equal(settled, "settled", "K: intake on a runtime without the bridge settles rather than hanging");
  check(panel.html.includes("no Chrome intake bridge") || panel.html.includes("receive-unavailable"),
    "K: the missing bridge is reported to the operator");
}

/* ── L. loadScriptOnce must never strand a caller ──────────────────────── */
{
  const runtime = fs.readFileSync(
    path.join(repoRoot, "src-surfaces-base/studio/settings/domain-panel-runtime.studio.js"), "utf8");
  const fn = runtime.slice(runtime.indexOf("function loadScriptOnce"), runtime.indexOf("function register("));
  check(fn.includes("h2oSettingsModuleSettled"),
    "L: an already-settled script element is recognised");
  check(/h2oSettingsModuleSettled[\s\S]{0,220}reject\(/.test(fn),
    "L: a settled script with a failing predicate rejects instead of waiting for an event that can never fire");
  const existingBranch = fn.slice(fn.indexOf("if (existing)"), fn.indexOf("const script = document.createElement"));
  check(existingBranch.includes("reject("),
    "L: the existing-script path has a terminating outcome");
}

/* ── M. one activation is one invocation, across remounts ──────────────── */
{
  /* Live evidence from the Desktop candidate: one trusted activation produced
   * 12 backend executions once. The Rust command performs exactly one
   * observation_count + 1 per execution, so the multiplier had to be upstream —
   * multiple listeners surviving across mounts is the shape that produces it.
   * This models the real DOM faithfully: listeners belong to the root they were
   * attached to, and only the CURRENT root is live, because frame() replaces the
   * host's children on every mount. A panel that attached its handler to a
   * persistent element instead of its own root would fail here. */
  const { api, calls } = loadProducer(divergentNative);
  const view = makeView();
  const listeners = [];              // {root, type, handler} across ALL mounts
  let currentRoot = null;
  view.frame = () => (currentRoot = { html: "", contains: () => true });
  view.listen = (root, type, handler) => {
    const entry = { root, type, handler, removed: false };
    listeners.push(entry);
    return () => { entry.removed = true; };
  };

  const H2O = {
    Desktop: { SyncObjectDelivery: api },
    Studio: {
      sync: { folder: {} },
      platform: { storage: { get: async () => null, set: async () => {} } },
      settings: { domainPanels: { view, register: (s) => { H2O.__spec = s; },
        loadScriptOnce: async (_r, ready) => ready() } },
    },
  };
  const sandbox = { console, Promise, Object, Array, String, Number, Boolean, JSON, Math,
    Set, Map, Error, RegExp, Date, H2O };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(panelSource, sandbox, { filename: panelRel });
  const spec = H2O.__spec;

  // Mount / dispose repeatedly, as route changes and re-entry to Browser Delivery do.
  const disposers = [];
  for (let i = 0; i < 6; i += 1) {
    const dispose = await spec.mount({});
    if (i < 5) { await dispose?.(); disposers.push(dispose); }   // all but the last are torn down
  }
  check(listeners.length >= 6, "M: each mount registered its own listeners");

  // Fire ONE click the way the DOM would: only listeners on the live root, not removed.
  const live = listeners.filter((l) => l.type === "click" && l.root === currentRoot && !l.removed);
  equal(live.length, 1, "M: exactly one live click listener exists after six mounts");
  const stale = listeners.filter((l) => l.type === "click" && l.root !== currentRoot && !l.removed);
  equal(stale.length, 0, "M: no listener from a superseded mount survives undisposed");

  calls.length = 0;
  for (const l of live) {
    await l.handler({
      target: {
        closest: (sel) => (sel === "[data-domain-action]"
          ? { dataset: { domainAction: "receive-local" }, disabled: false } : null),
        matches: () => false,
      },
      preventDefault() {},
    });
  }
  equal(calls.length, 1, "M: one activation after six mounts performs exactly ONE backend invocation");

  // A second, separate activation is exactly one more — never a batch.
  for (const l of live) {
    await l.handler({
      target: {
        closest: (sel) => (sel === "[data-domain-action]"
          ? { dataset: { domainAction: "receive-local" }, disabled: false } : null),
        matches: () => false,
      },
      preventDefault() {},
    });
  }
  equal(calls.length, 2, "M: a second activation adds exactly one more invocation");
}

console.log("DESKTOP_NEWUI_LOCAL_RECEIVE_PASS assertions=" + assertions
  + " receiveOnMount=0 receiveOnRefresh=0 autoRetry=0 transportCalls=0 nativeArgs=0");
