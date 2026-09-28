#!/usr/bin/env node

import assert from "node:assert/strict";
import vm from "node:vm";
import { makeChromeLivePopupJs } from "../../product/extensions/chatgpt/chrome/popup/chrome-live-popup-js.mjs";

const popup = makeChromeLivePopupJs({
  PROXY_PACK_URL: "http://127.0.0.1:5500/dev_output/proxy/_paste-pack.ext.txt",
  STORAGE_KEY: "h2oExtDevToggles",
  STORAGE_ORDER_OVERRIDES_KEY: "h2oExtDevOrderOverrides",
  DEV_ORDER_SECTIONS_SNAPSHOT: [],
  DEV_ALIAS_FILENAME_MAP: {},
});

function emittedBetween(startMarker, endMarker) {
  const start = popup.indexOf(startMarker);
  const end = popup.indexOf(endMarker, start);
  assert(start > 0 && end > start, `emitted popup section missing: ${startMarker}`);
  return popup.slice(start, end);
}

const permissionSource = emittedBetween("  function sendIdentityRequest(action, extra = {}) {", "  function applyLeftbarCollapsed(");
const guardSource = emittedBetween("  const controlActionsInFlight = new Set();", "  async function saveCurrentToSlot(");
const bindingSource = emittedBetween("  async function setChatBinding(", "  async function resetToggles(");
const tabActionSource = emittedBetween("  async function reloadActiveTab(", "  async function setSetClickReload(");

class FakeElement {
  constructor() { this.hidden = true; this.disabled = false; this.textContent = ""; }
  setAttribute() {}
  removeAttribute() {}
}
class FakeButton extends FakeElement {}

async function assertProviderPermissionRequest() {
  const panel = new FakeElement();
  const button = new FakeButton();
  const status = new FakeElement();
  let requestResponse;
  let derivedResponse;
  let rejection = "";
  const actions = [];
  const runtime = {
    lastError: null,
    sendMessage(message, callback) {
      const action = message.req.action;
      actions.push(action);
      if (action === "identity:request-provider-permission" && rejection) {
        this.lastError = { message: rejection };
        callback(undefined);
        this.lastError = null;
      } else {
        callback(action === "identity:request-provider-permission" ? requestResponse : derivedResponse);
      }
    },
  };
  const context = {
    chrome: { runtime },
    MSG_IDENTITY: "h2o-ext-identity:v1",
    IDENTITY_GET_DERIVED_STATE_ACTION: "identity:get-derived-state",
    IDENTITY_REQUEST_PROVIDER_PERMISSION_ACTION: "identity:request-provider-permission",
    elProviderPermissionPanel: panel,
    elProviderPermissionButton: button,
    elProviderPermissionStatus: status,
    HTMLElement: FakeElement,
    HTMLButtonElement: FakeButton,
  };
  vm.runInNewContext(permissionSource + guardSource + `
    globalThis.requestPermission = requestProviderPermissionFromPopup;
    globalThis.refreshPermission = refreshProviderPermissionUi;
  `, context, { filename: "emitted-popup-provider-permission.js" });

  const providerStatus = {
    providerKind: "supabase",
    providerMode: "provider_backed",
    providerConfigured: true,
    valid: true,
    permissionRequired: true,
    permissionReady: false,
    permissionHostKind: "exact_supabase_project",
    phaseNetworkEnabled: true,
  };
  const unready = { ok: true, derivedState: { providerConfigStatus: providerStatus } };
  const ready = { ok: true, derivedState: { providerConfigStatus: { ...providerStatus, permissionReady: true } } };
  const checkActions = (offset) => assert.deepEqual(actions.slice(offset), [
    "identity:request-provider-permission", "identity:get-derived-state",
  ]);

  requestResponse = { ok: true, permissionReady: true };
  derivedResponse = ready;
  let offset = actions.length;
  await context.requestPermission();
  checkActions(offset);
  assert.equal(panel.hidden, true, "granted permission must hide the panel");
  assert.equal(button.disabled, true, "granted permission must disable the button");
  assert.equal(status.textContent, "Provider permission granted.");

  requestResponse = { ok: false, errorCode: "permission/denied" };
  derivedResponse = unready;
  offset = actions.length;
  await context.requestPermission();
  checkActions(offset);
  assert.equal(panel.hidden, false, "refusal must retain the reconciled grant panel");
  assert.equal(button.disabled, false, "refusal must permit a retry when permission is still required");
  assert.equal(status.textContent, "Provider permission not granted: permission/denied",
    "refresh erased the actionable refusal");
  await context.refreshPermission();
  assert.equal(status.textContent, "Exact provider permission is required.",
    "a later explicit refresh must still reconcile status");

  derivedResponse = ready;
  await context.requestPermission();
  assert.equal(panel.hidden, true, "a concurrent grant must take precedence over stale refusal feedback");
  assert.equal(button.disabled, true);
  assert.equal(status.textContent, "Provider permission granted.");
  derivedResponse = unready;

  requestResponse = { ok: false, errorCode: "denied\n" + "x".repeat(500) };
  await context.requestPermission();
  assert(status.textContent.startsWith("Provider permission not granted: denied "));
  assert(status.textContent.length <= 235 && !status.textContent.includes("\n"),
    "refusal error code must remain bounded and single-line");

  rejection = "message rejected\n" + "x".repeat(500);
  offset = actions.length;
  await context.requestPermission();
  checkActions(offset);
  assert(status.textContent.startsWith("Provider permission request failed: message rejected "),
    "runtime rejection must retain a useful failure reason after refresh");
  assert(status.textContent.length <= 237 && !status.textContent.includes("\n"),
    "runtime rejection must remain bounded and single-line");
  assert.equal(panel.hidden, false);
  assert.equal(button.disabled, false);
  rejection = "";
  await context.refreshPermission();
  assert.equal(status.textContent, "Exact provider permission is required.");
}

async function assertGuardedActions() {
  const hint = { textContent: "" };
  const calls = [];
  let failOn = "";
  const fail = (operation) => {
    if (failOn === operation) throw new Error("operation rejected\n" + "x".repeat(500));
  };
  const context = {
    elHint: hint,
    HTMLButtonElement: FakeButton,
    HTMLInputElement: FakeButton,
    HTMLSelectElement: FakeButton,
    syncControlValues() {},
    syncPageSetStatus() {},
    currentTabId: 7,
    currentChatUrl: "https://chatgpt.com/c/test",
    getActiveTab: async () => ({ id: 7, url: "https://chatgpt.com/c/test" }),
    normalizeSetSlot: (value) => Number(value) || 0,
    getSetRecord: () => ({}),
    async sendPageSetLink(action) { fail("link"); calls.push(action); },
    async loadCurrentPageSetLink() { calls.push("load-link"); },
    render() { calls.push("render"); },
    async sendPageDisableOnce() { fail("disable"); calls.push("disable"); },
    chrome: { tabs: {
      query: async () => [{ id: 7 }],
      async reload() { fail("reload"); calls.push("reload"); },
    } },
  };
  vm.runInNewContext(guardSource + bindingSource + tabActionSource + `
    globalThis.actions = {
      runControlAction, setChatBinding, setGlobalDefaultBinding, setChatBypass,
      reloadActiveTab, disableCurrentPageOnce,
    };
  `, context, { filename: "emitted-popup-guarded-actions.js" });

  const cases = [
    ["This Chat binding", "setChatBinding", 1, "link", "This Chat now points to Set 1. Reload the page to apply.", ["set-chat-binding", "load-link", "render"]],
    ["Global binding", "setGlobalDefaultBinding", 1, "link", "Global default now points to Set 1. Reload unbound chats to apply.", ["set-global-default", "load-link", "render"]],
    ["All-off reload toggle", "setChatBypass", true, "link", "This Chat will reload with all scripts off.", ["set-chat-bypass", "load-link", "render"]],
    ["Reload Tab", "reloadActiveTab", undefined, "reload", "Active tab reloaded.", ["reload"]],
    ["This Page Off", "disableCurrentPageOnce", undefined, "disable", "Active tab reloaded with H2O scripts disabled for this load only.", ["disable", "reload"]],
  ];
  for (const [label, name, input, failurePoint, successText, successCalls] of cases) {
    assert.equal(popup.split(`runControlAction("${label}"`).length - 1, 1,
      `${label} must retain exactly one shared-guard binding`);
    const button = new FakeButton();
    const invoke = () => context.actions[name](input);
    hint.textContent = "";
    failOn = failurePoint;
    assert.equal(await context.actions.runControlAction(label, button, invoke), false,
      `${label} must pass rejection to the shared guard`);
    assert(hint.textContent.startsWith(`${label} failed: operation rejected `),
      `${label} did not use the shared bounded failure presentation`);
    assert(hint.textContent.length <= 240 && !hint.textContent.includes("\n"),
      `${label} failure feedback is unbounded`);
    assert.equal(button.disabled, false, `${label} must release its busy button after failure`);

    hint.textContent = "";
    calls.length = 0;
    failOn = "";
    assert.equal(await context.actions.runControlAction(label, button, invoke), true,
      `${label} success must remain successful`);
    assert.equal(hint.textContent, successText, `${label} success feedback changed`);
    assert.deepEqual(calls, successCalls, `${label} success operation sequence changed`);
    assert.equal(button.disabled, false, `${label} must release its busy button after success`);
  }
}

await assertProviderPermissionRequest();
await assertGuardedActions();
console.log(JSON.stringify({ ok: true, check: "dev-controls-popup-failure-feedback" }));
