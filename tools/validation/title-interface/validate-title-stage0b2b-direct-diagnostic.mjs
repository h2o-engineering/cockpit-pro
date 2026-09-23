#!/usr/bin/env node

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

import {
  TITLE_DIAGNOSTIC_CONSTANTS as C,
  TITLE_DIAGNOSTIC_FILES,
  isTitleDiagnosticBuildEnabled,
  makeTitleNavigationDiagnosticIsolatedJs,
  makeTitleNavigationDiagnosticMainJs,
  makeTitleNavigationDiagnosticPopupJs,
  makeTitleNavigationDiagnosticServiceWorkerJs,
} from "../../product/extensions/chatgpt/chrome/title-diagnostic/chrome-live-title-navigation-diagnostic.mjs";
import { makeChromeLiveManifest } from "../../product/extensions/chatgpt/chrome/chrome-live-manifest.mjs";
import { getExtensionId, getExtensionKey } from "../../product/extensions/chatgpt/chrome/chrome-extension-keys.mjs";
import { makeChromeLivePopupCss } from "../../product/extensions/chatgpt/chrome/popup/chrome-live-popup-css.mjs";
import { makeChromeLivePopupHtml } from "../../product/extensions/chatgpt/chrome/popup/chrome-live-popup-html.mjs";
import { makeChromeLivePopupJs } from "../../product/extensions/chatgpt/chrome/popup/chrome-live-popup-js.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const GENERATED = process.argv.includes("--generated");
const EXPECTED_ID = "ogcjkeaiicglflamhjaaimdhphjlgkbb";
const TARGET_VARIANT = "dev-controls-oauth-google";
const OUT = path.join(ROOT, "apps/extensions/chatgpt/chrome/dev-controls-oauth-google");
const PROXY = path.join(ROOT, "apps/dev-server/dev_output/proxy/_paste-pack.ext.txt");
const ALLOWED_TRACKED = new Set([
  "tools/product/extensions/chatgpt/chrome/popup/chrome-live-popup-css.mjs",
  "tools/product/extensions/chatgpt/chrome/popup/chrome-live-popup-html.mjs",
  "tools/product/extensions/chatgpt/chrome/popup/chrome-live-popup-js.mjs",
  "tools/product/extensions/chatgpt/chrome/title-diagnostic/chrome-live-title-navigation-diagnostic.mjs",
  "tools/validation/title-interface/validate-title-stage0b2b-direct-diagnostic.mjs",
]);
const TITLE_PREFIXES = ["9B0a", "9B1a", "9C1a", "9D1a"];

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: ROOT, encoding: "utf8", ...options });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed\n${result.stderr || result.stdout}`);
  return result.stdout;
}

function read(relative) {
  return fs.readFileSync(path.join(ROOT, relative), "utf8");
}

function syntax(source, label) {
  const result = spawnSync(process.execPath, ["--check", "-"], { input: source, encoding: "utf8" });
  assert.equal(result.status, 0, `${label} syntax failed: ${result.stderr}`);
}

function exactlyOneTitle(prefix) {
  const names = fs.readdirSync(path.join(ROOT, "src-runtime-base")).filter((name) => name.startsWith(prefix));
  assert.equal(names.length, 1, `${prefix} must resolve to exactly one source file`);
  return path.join("src-runtime-base", names[0]);
}

function assertFileScope() {
  const tracked = run("git", ["diff", "--name-only", "--diff-filter=ACMRTUXB", "HEAD", "--"])
    .split("\n").filter(Boolean);
  for (const relative of tracked) assert(ALLOWED_TRACKED.has(relative), `out-of-scope tracked diff: ${relative}`);
  const staged = run("git", ["diff", "--cached", "--name-only", "--"]);
  assert.equal(staged.trim(), "", "staged files are forbidden");
  const untracked = run("git", ["ls-files", "--others", "--exclude-standard", "--"])
    .split("\n").filter(Boolean);
  for (const relative of untracked) {
    assert(relative.startsWith("chrome/") || ALLOWED_TRACKED.has(relative), `out-of-scope untracked path: ${relative}`);
  }
}

function assertTitleState() {
  for (const prefix of TITLE_PREFIXES) {
    const relative = exactlyOneTitle(prefix);
    const worktreeBlob = run("git", ["hash-object", "--no-filters", "--", relative]).trim();
    const headBlob = run("git", ["rev-parse", `HEAD:${relative}`]).trim();
    assert.equal(worktreeBlob, headBlob, `${relative} differs from HEAD`);
    syntax(read(relative), relative);
  }
  assert.equal(run("git", ["diff", "--name-only", "HEAD", "--", "config/dev-order.tsv"]).trim(), "", "dev-order.tsv changed");
  const order = read("config/dev-order.tsv");
  // 9D1a joined the enabled set in a594c87d (feat(title): add auto emoji and
  // sidebar emoji controls, 2026-08-12), which shipped Auto Emoji Title and
  // flipped this exact toggle; it has stayed enabled through every later
  // dev-order change. The pin moves with it rather than being dropped, so the
  // canonical toggle state is still asserted here.
  for (const prefix of ["9B0a", "9B1a", "9C1a", "9D1a"]) assert(new RegExp(`^🟢\\t${prefix}\\.`, "m").test(order), `${prefix} must remain enabled`);
}

function manifestFor(enabled, options = {}) {
  return makeChromeLiveManifest({
    PROXY_PACK_URL: "http://127.0.0.1:5500/dev_output/proxy/_paste-pack.ext.txt",
    CHAT_MATCH: "https://chatgpt.com/*",
    PAGE_FOLDER_BRIDGE_FILE: "folder-bridge-page.js",
    PAGE_PILOT_OBSERVER_FILE: "pilot-observer-page.js",
    DEV_HAS_CONTROLS: options.controls !== false,
    DEV_TITLE: "H2O Dev Controls",
    DEV_ACTION_TITLE: "H2O Dev Controls",
    DEV_NAME: "H2O Dev Controls (Unpacked)",
    DEV_VERSION: "1.3.0",
    DEV_DESCRIPTION: "validation",
    MANIFEST_PROFILE: options.production ? "production" : "development",
    IDENTITY_PROVIDER_REQUEST_OTP_ARMED: options.armed === true,
    IDENTITY_PROVIDER_OAUTH_PROVIDER: options.oauth ? "google" : null,
    TITLE_DIAGNOSTIC_ENABLED: enabled,
    STUDIO_ONLY: options.studio === true,
    EXTENSION_KEY: getExtensionKey(TARGET_VARIANT),
  });
}

function assertVariantIsolation() {
  const variants = ["production", "dev-lean", "studio-launcher", "dev-controls", "dev-controls-armed", TARGET_VARIANT];
  for (const variant of variants) {
    for (const envValue of [undefined, "0", "1"]) {
      const enabled = isTitleDiagnosticBuildEnabled({ envValue, outVariant: variant });
      assert.equal(enabled, envValue === "1" && variant === TARGET_VARIANT, `bad gate for ${variant}/${envValue}`);
    }
  }
  const profiles = {
    production: { controls: false, production: true },
    "dev-lean": { controls: false },
    "studio-launcher": { controls: false, production: true, studio: true },
    "dev-controls": {},
    "dev-controls-armed": { armed: true },
    [TARGET_VARIANT]: { armed: true, oauth: true },
  };
  for (const variant of variants) {
    const enabled = isTitleDiagnosticBuildEnabled({ envValue: "1", outVariant: variant });
    const generatedManifest = manifestFor(enabled, profiles[variant]);
    const hasDiagnosticPermissions = generatedManifest.permissions.includes("webNavigation") || generatedManifest.permissions.includes("scripting");
    assert.equal(hasDiagnosticPermissions, variant === TARGET_VARIANT, `manifest diagnostic leakage for ${variant}`);
    const generatedPopup = makeChromeLivePopupHtml({ titleDiagnosticEnabled: enabled });
    assert.equal(generatedPopup.includes("Title navigation diagnostic"), variant === TARGET_VARIANT, `popup diagnostic leakage for ${variant}`);
  }
  const off = manifestFor(false, profiles[TARGET_VARIANT]);
  const on = manifestFor(true, profiles[TARGET_VARIANT]);
  const delta = on.permissions.filter((permission) => !off.permissions.includes(permission)).sort();
  assert.deepEqual(delta, ["scripting", "webNavigation"], "permission delta must be exact");
  assert(!on.permissions.includes("downloads"), "downloads permission is forbidden");
  assert.deepEqual(on.host_permissions, off.host_permissions, "host permissions must not change");
  assert.deepEqual(on.content_scripts, off.content_scripts, "no static diagnostic content script is allowed");
  const wars = JSON.stringify(on.web_accessible_resources || []);
  assert(!wars.includes(TITLE_DIAGNOSTIC_FILES.main), "MAIN collector must not be web-accessible");
  const htmlOff = makeChromeLivePopupHtml({ titleDiagnosticEnabled: false });
  const htmlOn = makeChromeLivePopupHtml({ titleDiagnosticEnabled: true });
  assert(!htmlOff.includes("title-navigation-diagnostic"), "diagnostic popup controls leaked into disabled output");
  // The yellow Diagnostics control must share the gate that emits its workspace and
  // binding script. It once rendered unconditionally, so a build without the
  // diagnostic shipped a dead button: present in markup, bound by nothing.
  assert(!htmlOff.includes('data-popup-action="open-diagnostics"') && !htmlOff.includes("project-color-dot is-yellow"),
    "yellow Diagnostics control must not render when the diagnostic is disabled");
  assert(!htmlOff.includes('id="diagnostics-workspace"'),
    "diagnostics workspace must not render when the diagnostic is disabled");
  assert.equal((htmlOn.match(/data-popup-action="open-diagnostics"/g) || []).length, 1,
    "enabled popup must emit exactly one yellow Diagnostics action");
  assert.equal((htmlOn.match(/project-color-dot is-yellow/g) || []).length, 1,
    "enabled popup must emit exactly one yellow control");
  assert(htmlOn.includes('id="diagnostics-workspace"'),
    "enabled popup must emit the yellow control together with its diagnostics workspace target");
  for (const dot of ["is-blue", "is-red", "is-green"]) {
    const dotPattern = new RegExp("project-color-dot " + dot, "g");
    assert.equal((htmlOff.match(dotPattern) || []).length, 1,
      `unrelated project colour dot ${dot} must remain exactly once in the disabled build`);
    assert.equal((htmlOn.match(dotPattern) || []).length, 1,
      `unrelated project colour dot ${dot} must remain exactly once in the enabled build`);
  }
  assert(htmlOn.includes("Title navigation diagnostic") && htmlOn.includes(TITLE_DIAGNOSTIC_FILES.popup), "enabled popup controls missing");
  assert(!/<script(?![^>]*src=)[^>]*>/i.test(htmlOn), "inline popup JavaScript is forbidden");
  assert.equal(getExtensionId(TARGET_VARIANT), EXPECTED_ID, "stable extension ID changed");
}

const GUARDED_CONTROL_ACTIONS = [
  "All On", "All Off", "This Page Off", "Reset", "Reset Layout", "Reload Tab",
  "Save", "Clear", "This Chat binding", "Global binding", "All-off reload toggle",
];

function emittedPopupJs() {
  return makeChromeLivePopupJs({
    PROXY_PACK_URL: "http://127.0.0.1:5500/dev_output/proxy/_paste-pack.ext.txt",
    STORAGE_KEY: "h2oExtDevToggles",
    STORAGE_ORDER_OVERRIDES_KEY: "h2oExtDevOrderOverrides",
    DEV_ORDER_SECTIONS_SNAPSHOT: [],
    DEV_ALIAS_FILENAME_MAP: {},
  });
}

// Developer-facing async controls once launched floating promises: a rejection was
// silent and a rapid second click could race the first. They now go through one
// shared presentation guard. This proves the wiring AND executes the emitted guard.
async function assertControlActionGuard() {
  const popupJs = emittedPopupJs();
  for (const label of GUARDED_CONTROL_ACTIONS) {
    const needle = 'runControlAction("' + label + '"';
    assert.equal(popupJs.split(needle).length - 1, 1,
      "developer control action " + label + " must reach the shared guard exactly once");
  }
  const start = popupJs.indexOf("  const controlActionsInFlight = new Set();");
  const end = popupJs.indexOf("  async function saveCurrentToSlot(");
  assert(start > 0 && end > start, "emitted control-action guard not found");

  class FakeControl {
    constructor() { this.disabled = false; this.attrs = {}; }
    setAttribute(key, value) { this.attrs[key] = value; }
    removeAttribute(key) { delete this.attrs[key]; }
  }
  const elHint = { textContent: "" };
  const context = {
    elHint, Promise, Set, String, console,
    HTMLButtonElement: FakeControl, HTMLInputElement: FakeControl, HTMLSelectElement: FakeControl,
  };
  vm.runInNewContext(
    popupJs.slice(start, end) + "\nglobalThis.__runControlAction = runControlAction;",
    context,
    { filename: "generated-dev-controls-action-guard.js" },
  );
  const runControlAction = context.__runControlAction;
  assert.equal(typeof runControlAction, "function", "emitted guard did not expose runControlAction");
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // a rejecting operation must surface bounded feedback, not fail silently
  const failButton = new FakeControl();
  elHint.textContent = "";
  const failed = await runControlAction("All Off", failButton, async () => { throw new Error("storage write denied"); });
  assert.equal(failed, false, "a rejected control action must report failure");
  assert.equal(elHint.textContent, "All Off failed: storage write denied",
    "a rejected control action must surface bounded developer feedback");
  assert.equal(failButton.disabled, false, "the initiating control must be restored after a rejection");

  // the failure text stays bounded and single-lined
  elHint.textContent = "";
  await runControlAction("Clear", new FakeControl(), async () => { throw new Error("a\nb " + "x".repeat(500)); });
  assert(!elHint.textContent.includes("\n") && elHint.textContent.length <= 220,
    "control action failure text must stay bounded and single-lined");

  // a rapid repeat cannot launch the same action twice
  const busyButton = new FakeControl();
  let runs = 0;
  const op = async () => { runs += 1; await sleep(20); };
  const outcomes = await Promise.all([
    runControlAction("All On", busyButton, op),
    runControlAction("All On", busyButton, op),
    runControlAction("All On", busyButton, op),
  ]);
  assert.equal(runs, 1, "a repeated control action must execute exactly once while in flight");
  assert.deepEqual(outcomes, [true, false, false], "duplicate invocations must report as not-run");
  assert.equal(busyButton.disabled, false, "the initiating control must be re-enabled in finally");

  // an existing success message is never replaced, and the guard releases
  elHint.textContent = "Toggles reset to default (all on). Reload the page to apply.";
  assert.equal(await runControlAction("Reset", new FakeControl(), async () => {}), true, "guard must release after completion");
  assert.equal(elHint.textContent, "Toggles reset to default (all on). Reload the page to apply.",
    "the guard must preserve an operation's own success message");

  // independent actions stay usable: the guard is per-action, not a popup-wide lock
  let first = 0;
  let second = 0;
  await Promise.all([
    runControlAction("All On", new FakeControl(), async () => { first += 1; await sleep(20); }),
    runControlAction("Reset Layout", new FakeControl(), async () => { second += 1; }),
  ]);
  assert(first === 1 && second === 1, "independent control actions must not block each other");
}

function assertWorkspaceContract() {
  const htmlSourcePath = "tools/product/extensions/chatgpt/chrome/popup/chrome-live-popup-html.mjs";
  const popupJsPath = "tools/product/extensions/chatgpt/chrome/popup/chrome-live-popup-js.mjs";
  const currentHtmlSource = read(htmlSourcePath);
  const currentPopupJs = read(popupJsPath);
  const headHtmlSource = run("git", ["show", "HEAD:" + htmlSourcePath]);
  const headPopupJs = run("git", ["show", "HEAD:" + popupJsPath]);
  const html = makeChromeLivePopupHtml({ titleDiagnosticEnabled: true });
  const popup = makeTitleNavigationDiagnosticPopupJs();
  const css = makeChromeLivePopupCss();

  for (const color of ["blue", "red", "green"]) {
    const pattern = new RegExp("^.*project-color-dot is-" + color + ".*$", "m");
    assert.equal(currentHtmlSource.match(pattern)?.[0], headHtmlSource.match(pattern)?.[0],
      color + " header button markup changed");
  }
  const oldDoubleClick = headPopupJs.slice(
    headPopupJs.indexOf('elBrandTitleToggle.addEventListener("dblclick"'),
    headPopupJs.indexOf('elBrandTitleToggle.addEventListener("keydown"')
  );
  assert(oldDoubleClick.includes("setHeaderUtilityOpen(!headerUtilityOpen)"),
    "authoritative Settings double-click path missing from HEAD");
  assert(currentPopupJs.includes(oldDoubleClick), "existing title double-click Settings handler changed");
  assert.equal((currentPopupJs.match(/elBrandTitleToggle\.addEventListener\("dblclick"/g) || []).length, 1,
    "authoritative Settings double-click handler must remain singular");
  assert(!popup.includes("setHeaderUtilityOpen"), "diagnostic popup must not duplicate Settings behavior");
  assert.equal((currentHtmlSource.match(/data-popup-action="open-diagnostics"/g) || []).length, 1,
    "yellow Diagnostics action must have one semantic selector");
  assert(currentHtmlSource.includes("project-color-dot is-yellow") &&
    currentHtmlSource.includes('data-popup-action="open-diagnostics"'),
    "yellow button Diagnostics action missing");

  const infoStart = html.indexOf('id="controls-page-info"');
  const infoEnd = html.indexOf('id="controls-page-hidden"');
  const infoPage = html.slice(infoStart, infoEnd);
  assert(!infoPage.includes("title-diag-reset") && !infoPage.includes('id="title-navigation-diagnostic"'),
    "old Info-tab diagnostic card remains");
  for (const token of [
    'id="diagnostics-workspace"', 'class="diagnostics-sidebar"', 'class="diagnostics-detail"',
    'id="diagnostics-module-list"', 'class="diagnostics-summary-grid"',
    'id="title-diag-documents"', 'id="title-diag-events"', 'id="title-diag-warnings-panel"',
    '<details class="diagnostics-raw"', "Raw sanitized evidence"
  ]) {
    assert(html.includes(token), "workspace structure missing " + token);
  }
  assert(!/<script(?![^>]*src=)[^>]*>/i.test(html), "inline popup JavaScript is forbidden");
  assert(css.includes("grid-template-columns: minmax(250px, 28%) minmax(0, 1fr)") &&
    css.includes(".diagnostics-detail") && css.includes("min-width: 0"),
    "two-pane diagnostics layout is missing");
  assert(css.includes("@media (prefers-reduced-motion: reduce)") &&
    css.includes(":focus-visible"), "focus or reduced-motion treatment missing");

  assert(popup.includes('id: "title-navigation"') &&
    popup.includes('renderer: "title-navigation-detail-v1"') &&
    popup.includes('availability: "available"'), "registry-driven title diagnostic module missing");
  assert(popup.includes('workspaceMode: "normal"') && popup.includes("lastNormalView") &&
    popup.includes("selectedModuleId"), "popup-lifetime workspace state missing");
  assert(popup.includes('app.dataset.workspaceMode = "diagnostics"') &&
    popup.includes("delete app.dataset.workspaceMode"), "workspace enter/return model missing");
  assert(popup.includes("event.detail >= 2") && popup.includes("cancelPendingTitleClick") &&
    popup.includes('titleText?.addEventListener("dblclick", cancelPendingTitleClick)'),
    "title click disambiguation missing");
  assert.equal((popup.match(/leaveDiagnostics\(\);/g) || []).length, 1,
    "workspace return must be owned only by the title single-click path");
  assert(!popup.includes('logo?.addEventListener("click"') &&
    currentPopupJs.includes("h2o:title-diagnostics-workspace-toggle-sidebar") &&
    currentPopupJs.includes("setLeftbarCollapsed(!leftbarCollapsed)"),
    "logo collapse ownership was not preserved");
  assert(!popup.includes("setInterval("), "diagnostic popup must not poll");
  assert(!popup.includes("void refreshSnapshot()") && !popup.includes("void refresh()"),
    "diagnostic status must not load before workspace entry");
  assert(popup.includes('runOperation("Refreshing status…", () => refreshSnapshot())') &&
    popup.includes("[ids.status]"), "workspace-entry and explicit status refresh paths missing");
  assert(popup.includes("ui.commandInFlight") && popup.includes("button.disabled = ui.commandInFlight"),
    "diagnostic command race protection missing");
  assert(popup.includes("aria-current") && html.includes('aria-live="polite"') &&
    html.includes('role="alert"'), "diagnostic accessibility semantics missing");
}

function assertTitleClickTimingContract() {
  const popup = makeTitleNavigationDiagnosticPopupJs();
  const delayMatches = [...popup.matchAll(/const TITLE_SINGLE_CLICK_DELAY_MS = (\d+);/g)];
  assert.equal(delayMatches.length, 1, "generated popup must define one named title-click delay");
  const delayMs = Number(delayMatches[0][1]);
  assert(delayMs >= 500, "title single-click confirmation delay must be at least 500 ms");

  class FakeClassList {
    constructor() { this.values = new Set(); }
    add(...items) { for (const item of items) this.values.add(item); }
    remove(...items) { for (const item of items) this.values.delete(item); }
    contains(item) { return this.values.has(item); }
    toggle(item, force) {
      const next = force === undefined ? !this.values.has(item) : Boolean(force);
      if (next) this.values.add(item); else this.values.delete(item);
      return next;
    }
  }
  class FakeElement {
    constructor(tag = "div", id = "") {
      this.tagName = tag.toUpperCase();
      this.id = id;
      this.dataset = {};
      this.classList = new FakeClassList();
      this.children = [];
      this.listeners = new Map();
      this.attributes = new Map();
      this.hidden = false;
      this.disabled = false;
      this.textContent = "";
      this.title = "";
      this.parentNode = null;
    }
    get firstChild() { return this.children[0] || null; }
    addEventListener(type, handler) {
      const list = this.listeners.get(type) || [];
      list.push(handler);
      this.listeners.set(type, list);
    }
    emit(type, init = {}) {
      const event = { type, detail: 0, target: this, currentTarget: this, ...init };
      for (const handler of this.listeners.get(type) || []) handler(event);
    }
    setAttribute(name, value) {
      this.attributes.set(name, String(value));
      if (name === "aria-current") this.ariaCurrent = String(value);
    }
    append(...nodes) { for (const node of nodes) this.appendChild(node); }
    appendChild(node) {
      node.parentNode = this;
      this.children.push(node);
      return node;
    }
    removeChild(node) {
      const index = this.children.indexOf(node);
      if (index >= 0) this.children.splice(index, 1);
      node.parentNode = null;
      return node;
    }
    remove() { this.parentNode?.removeChild(this); }
    focus() { this.focused = true; }
    querySelector() { return null; }
  }
  class FakeButton extends FakeElement {
    constructor(id = "") { super("button", id); this.type = "button"; }
    click() { this.emit("click", { detail: 1 }); }
  }
  class FakeDocument extends FakeElement {
    constructor() {
      super("document");
      this.body = new FakeElement("body", "body");
      this.nodes = new Map();
      this.buttonIds = new Set([
        "title-diag-reset", "title-diag-arm", "title-diag-status", "title-diag-export",
        "title-diag-clear", "title-diag-copy-raw"
      ]);
      this.app = this.node("app");
      this.workspace = this.node("diagnostics-workspace");
      this.detail = this.node("diagnostics-detail");
      this.titleText = new FakeElement("span", "brand-title");
      this.logo = new FakeButton("logo-toggle");
      this.yellow = new FakeButton("diagnostics-yellow");
      this.normalTab = new FakeButton("controls-tab-main");
      this.normalTab.dataset.controlsTab = "main";
      this.normalTab.setAttribute("aria-selected", "true");
    }
    node(id) {
      if (!this.nodes.has(id)) {
        this.nodes.set(id, this.buttonIds?.has(id) ? new FakeButton(id) : new FakeElement("div", id));
      }
      return this.nodes.get(id);
    }
    getElementById(id) { return this.node(id); }
    createElement(tag) { return tag === "button" || tag === "a" ? new FakeButton() : new FakeElement(tag); }
    querySelector(selector) {
      if (selector === "#brand-title-toggle .brand-title") return this.titleText;
      if (selector === '[data-popup-action="open-diagnostics"]') return this.yellow;
      if (selector === '[data-controls-tab][aria-selected="true"]') return this.normalTab;
      if (selector.startsWith('[data-controls-tab="')) return this.normalTab;
      return null;
    }
  }
  class FakeClock {
    constructor() { this.now = 0; this.nextId = 1; this.tasks = new Map(); }
    setTimeout(handler, delay) {
      const id = this.nextId++;
      this.tasks.set(id, { at: this.now + Number(delay || 0), handler });
      return id;
    }
    clearTimeout(id) { this.tasks.delete(id); }
    tick(amount) {
      const end = this.now + amount;
      for (;;) {
        const due = [...this.tasks.entries()]
          .filter(([, task]) => task.at <= end)
          .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!due) break;
        this.now = due[1].at;
        this.tasks.delete(due[0]);
        due[1].handler();
      }
      this.now = end;
    }
  }

  const document = new FakeDocument();
  const clock = new FakeClock();
  const context = {
    document,
    HTMLElement: FakeElement,
    HTMLButtonElement: FakeButton,
    Blob: globalThis.Blob,
    URL: { createObjectURL: () => "blob:test", revokeObjectURL: () => {} },
    navigator: { clipboard: { writeText: async () => {} } },
    chrome: { runtime: { sendMessage: async () => ({ ok: true, data: { state: "idle" } }) } },
    setTimeout: (handler, delay) => clock.setTimeout(handler, delay),
    clearTimeout: (id) => clock.clearTimeout(id),
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init?.detail; } },
    console,
  };
  const instrumentedPopup = popup.replace(
    "  const shortRef = (value) => {",
    "  globalThis.__h2oTitleDiagnosticFormatters = Object.freeze({ timeLabel, durationLabel });\n  const shortRef = (value) => {"
  );
  assert.notEqual(instrumentedPopup, popup, "popup formatter instrumentation point missing");
  vm.runInNewContext(instrumentedPopup, context, { filename: "generated-title-diagnostic-popup.js" });

  const formatters = context.__h2oTitleDiagnosticFormatters;
  assert.equal(formatters.timeLabel(null), "—", "null timestamp rendered as epoch zero");
  assert.equal(formatters.timeLabel(undefined), "—", "undefined timestamp must be missing");
  assert.equal(formatters.timeLabel(""), "—", "empty timestamp must be missing");
  assert.equal(formatters.durationLabel(100, null), "—", "null duration end rendered as zero");
  assert.equal(formatters.durationLabel(undefined, 100), "—", "missing duration start must be missing");
  assert(!formatters.timeLabel(null).includes("1970"), "missing timestamp exposed Unix epoch");
  assert(!formatters.durationLabel(100, null).includes("0 ms"), "missing duration exposed false zero");

  const isDiagnostics = () => document.app.dataset.workspaceMode === "diagnostics";
  document.yellow.emit("click", { detail: 1 });
  assert(isDiagnostics(), "yellow button did not enter Diagnostics in timing harness");
  document.titleText.emit("click", { detail: 1 });
  clock.tick(delayMs - 1);
  assert(isDiagnostics(), "single click returned before the named confirmation delay");
  clock.tick(1);
  assert(!isDiagnostics(), "single click did not return after the full confirmation delay");

  document.yellow.emit("click", { detail: 1 });
  document.titleText.emit("click", { detail: 1 });
  clock.tick(Math.floor(delayMs / 2));
  document.titleText.emit("click", { detail: 2 });
  clock.tick(delayMs);
  assert(isDiagnostics(), "second click did not cancel the pending single-click return");

  document.titleText.emit("click", { detail: 1 });
  clock.tick(delayMs);
  assert(!isDiagnostics(), "timing harness could not restore normal workspace");
  document.yellow.emit("click", { detail: 1 });
  document.titleText.emit("click", { detail: 1 });
  clock.tick(Math.floor(delayMs / 2));
  document.titleText.emit("dblclick", { detail: 2 });
  clock.tick(delayMs);
  assert(isDiagnostics(), "dblclick did not cancel the pending single-click return");
}

class FakeEventTarget {
  constructor() { this.listeners = new Map(); }
  addEventListener(type, handler) {
    const list = this.listeners.get(type) || [];
    list.push(handler);
    this.listeners.set(type, list);
  }
  removeEventListener(type, handler) {
    const list = this.listeners.get(type) || [];
    this.listeners.set(type, list.filter((item) => item !== handler));
  }
  emit(type, init = {}) {
    const event = { type, target: this, currentTarget: this, ...init };
    for (const handler of this.listeners.get(type) || []) handler(event);
  }
}

async function flushAsync() {
  for (let index = 0; index < 6; index += 1) await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
}

async function assertMainCollectorChangeDriven() {
  const messages = [];
  const intervals = new Map();
  let intervalId = 0;
  let loaderReads = 0;
  const window = new FakeEventTarget();
  window.postMessage = (message) => { if (message?.direction === "main-to-isolated") messages.push(message); };
  const makeChatTitle = () => ({
    subscribe: () => () => {},
    getState: () => ({ baseTitle: "private title not emitted", durable: true }),
    selfCheck: () => ({ ok: true }),
  });
  const context = {
    window,
    location: { pathname: "/c/source" },
    crypto: crypto.webcrypto,
    TextEncoder,
    performance: { timeOrigin: 1234 },
    setInterval: (handler) => { const id = ++intervalId; intervals.set(id, handler); return id; },
    clearInterval: (id) => intervals.delete(id),
    H2O: {
      ChatTitle: makeChatTitle(),
      TabTitle: {},
      archiveBoot: { _getExtensionBridge: () => ({ __loaderInfo: async () => {
        loaderReads += 1;
        return { loaderBuildTs: 123456789, loaderBuildIso: "2026-07-21T00:00:00.000Z", source: "page-bridge-loader" };
      } }) },
    },
    __h2oTitleUnderInputRuntime_v4: {},
    console,
  };
  vm.runInNewContext(makeTitleNavigationDiagnosticMainJs(), context, { filename: "generated-main-change-driven.js" });
  window.emit("message", { source: window, data: {
    marker: C.bridgeMarker, direction: "isolated-to-main", messageType: "activate",
    runId: "run-main-test", nonce: "12345678-1234-1234-1234-123456789abc"
  } });
  await flushAsync();
  assert.equal(loaderReads, 1, "concurrent loader-marker paths did not share one bridge read");
  assert.equal(messages.filter((item) => item.messageType === "runtime.loader-marker").length, 1,
    "loader marker was emitted more than once");
  assert.equal(messages.filter((item) => item.messageType === "runtime.availability").length, 1,
    "initial availability must emit exactly once");
  assert.equal(messages.filter((item) => item.messageType === "bridge.h2o-ready").length, 1,
    "initial ready transition must emit exactly once");

  const poll = [...intervals.values()][0];
  assert.equal(typeof poll, "function", "API identity polling was not installed");
  for (let index = 0; index < 360; index += 1) poll();
  await flushAsync();
  assert.equal(messages.filter((item) => item.messageType === "runtime.availability").length, 1,
    "stable 180-second API polling emitted availability heartbeats");
  assert.equal(messages.filter((item) => item.messageType === "bridge.h2o-ready").length, 1,
    "stable 180-second API polling emitted ready heartbeats");

  context.H2O.ChatTitle = makeChatTitle();
  poll(); poll();
  assert.equal(messages.filter((item) => item.messageType === "bridge.h2o-replaced" && item.data?.name === "ChatTitle").length, 1,
    "one ChatTitle identity replacement must emit exactly once");
  assert.equal(messages.filter((item) => item.messageType === "runtime.availability").length, 1,
    "identity-only replacement must not duplicate an unchanged availability fingerprint");
}

async function assertIsolatedDomSuppression() {
  const sent = [];
  let mutationCallback = null;
  class FakeElement extends FakeEventTarget {
    constructor(selectors = []) {
      super(); this.selectors = new Set(selectors); this.parentElement = null;
      this.attributes = new Map(); this.hidden = false; this.textContent = "";
      this.styleDisplay = "block"; this.styleVisibility = "visible";
    }
    matches(selector) { return String(selector).split(",").some((item) => this.selectors.has(item.trim())); }
    closest(selector) { return this.matches(selector) ? this : null; }
    querySelector(selector) { return this.matches(selector) ? this : null; }
    getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
    setAttribute(name, value) { this.attributes.set(name, String(value)); }
  }
  const titleNode = new FakeElement(["title"]);
  const root = new FakeElement();
  const initialUnderInput = new FakeElement([".ho-tab-title-under-input"]);
  initialUnderInput.textContent = "Initial title";
  const underInputNodes = [initialUnderInput];
  const counts = new Map([
    [".ho-title-action-menu", 0], [".ho-emoji-badge", 0]
  ]);
  const document = {
    title: "Initial private title",
    documentElement: root,
    querySelector: (selector) => selector === "title" ? titleNode : null,
    querySelectorAll: (selector) => selector === ".ho-tab-title-under-input"
      ? underInputNodes : Array.from({ length: counts.get(selector) || 0 }, () => ({})),
  };
  const window = new FakeEventTarget();
  window.postMessage = () => {};
  const runtimeListeners = new Set();
  const context = {
    window,
    document,
    location: { pathname: "/c/source" },
    Element: FakeElement,
    getComputedStyle: (node) => ({ display: node.styleDisplay, visibility: node.styleVisibility }),
    crypto: crypto.webcrypto,
    TextEncoder,
    MutationObserver: class {
      constructor(callback) { mutationCallback = callback; }
      observe() {}
      disconnect() {}
    },
    PerformanceObserver: class { observe() {} disconnect() {} },
    setTimeout: () => 1,
    clearTimeout: () => {},
    chrome: {
      runtime: {
        sendMessage: async (message) => {
          if (message.op === "collector-boot") return { ok: true, data: {
            active: true, runId: "run-isolated-test", nonce: "12345678-1234-1234-1234-123456789abc",
            route: "/c/#hash", expiresAt: Date.now() + 10000
          } };
          if (message.op === "collector-event") sent.push(message);
          return { ok: true, data: true };
        },
        onMessage: { addListener: (handler) => runtimeListeners.add(handler), removeListener: (handler) => runtimeListeners.delete(handler) },
      },
    },
    console,
  };
  vm.runInNewContext(makeTitleNavigationDiagnosticIsolatedJs(), context, { filename: "generated-isolated-dom.js" });
  await flushAsync();
  const countType = (type) => sent.filter((item) => item.type === type).length;
  assert.equal(countType("document.title"), 1);
  assert.equal(countType("dom.under-input"), 1);
  assert.equal(countType("dom.title-menu-count"), 1);
  assert.equal(countType("dom.emoji-badge-count"), 1);

  for (let index = 0; index < 30; index += 1) {
    mutationCallback([{ type: "attributes", target: initialUnderInput, attributeName: "class",
      addedNodes: [], removedNodes: [] }]);
  }
  assert.equal(countType("dom.under-input"), 1,
    "class-only churn with unchanged semantics repeated under-input evidence");

  mutationCallback([{ type: "childList", target: new FakeElement(), addedNodes: [], removedNodes: [] }]);
  assert.equal(countType("dom.title-menu-count"), 1, "unrelated mutation repeated unchanged menu count");
  assert.equal(countType("dom.emoji-badge-count"), 1, "unrelated mutation repeated unchanged emoji count");

  counts.set(".ho-title-action-menu", 1);
  mutationCallback([{ type: "childList", target: root, addedNodes: [new FakeElement([".ho-title-action-menu"])], removedNodes: [] }]);
  assert.equal(countType("dom.title-menu-count"), 2, "actual menu-count change was not emitted");
  assert.equal(countType("dom.emoji-badge-count"), 1, "unchanged emoji count repeated beside menu change");

  document.title = "Changed private title";
  mutationCallback([{ type: "childList", target: titleNode, addedNodes: [], removedNodes: [] }]);
  mutationCallback([{ type: "childList", target: titleNode, addedNodes: [], removedNodes: [] }]);
  assert.equal(countType("document.title"), 2, "title snapshot must emit once per actual title value change");

  const addedUnderInput = new FakeElement([".ho-tab-title-under-input"]);
  underInputNodes.push(addedUnderInput);
  mutationCallback([{ type: "childList", target: root, addedNodes: [addedUnderInput], removedNodes: [] }]);
  assert.equal(countType("dom.under-input"), 2, "actual under-input count change was not emitted");

  initialUnderInput.textContent = "Changed title length";
  mutationCallback([{ type: "characterData", target: { parentElement: initialUnderInput }, addedNodes: [], removedNodes: [] }]);
  assert.equal(countType("dom.under-input"), 3, "actual under-input text metadata change was not emitted");

  initialUnderInput.hidden = true;
  mutationCallback([{ type: "attributes", target: initialUnderInput, attributeName: "hidden",
    addedNodes: [], removedNodes: [] }]);
  assert.equal(countType("dom.under-input"), 4, "actual under-input semantic visibility change was not emitted");
}

class FakeClock {
  constructor(now = 1000000) { this.now = now; this.nextId = 1; this.tasks = new Map(); }
  setTimeout(handler, delay) {
    const id = this.nextId++;
    this.tasks.set(id, { at: this.now + Math.max(0, Number(delay) || 0), handler });
    return id;
  }
  clearTimeout(id) { this.tasks.delete(id); }
  async tick(amount) {
    const end = this.now + amount;
    for (;;) {
      const due = [...this.tasks.entries()].filter(([, task]) => task.at <= end)
        .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!due) break;
      this.now = due[1].at;
      this.tasks.delete(due[0]);
      await due[1].handler();
      await flushAsync();
    }
    this.now = end;
    await flushAsync();
  }
}

function listenerSlot() {
  return { listeners: [], addListener(handler) { this.listeners.push(handler); } };
}

function makeWorkerHarness() {
  const clock = new FakeClock();
  const values = new Map();
  let registrations = [];
  const teardownRequests = [];
  const clone = (value) => value === undefined ? undefined : structuredClone(value);
  const storage = {
    get: async (keys) => Object.fromEntries(keys.filter((key) => values.has(key)).map((key) => [key, clone(values.get(key))])),
    set: async (items) => { for (const [key, value] of Object.entries(items)) values.set(key, clone(value)); },
    remove: async (keys) => { for (const key of keys) values.delete(key); },
  };
  const chrome = {
    storage: { local: storage },
    scripting: {
      getRegisteredContentScripts: async ({ ids }) => registrations.filter((item) => ids.includes(item.id)).map(clone),
      unregisterContentScripts: async ({ ids }) => { registrations = registrations.filter((item) => !ids.includes(item.id)); },
      registerContentScripts: async (items) => { registrations.push(...items.map(clone)); },
      executeScript: async () => [],
    },
    tabs: { query: async () => [], sendMessage: async (tabId, message) => {
      const evidence = values.get(C.storage.evidence);
      teardownRequests.push({
        at: clock.now, tabId, message: clone(message), evidenceState: evidence?.state || null,
        completedEvents: evidence?.events?.filter((event) => event.type === "run.completed").length || 0
      });
      return null;
    } },
    runtime: { onMessage: listenerSlot(), onStartup: listenerSlot(), onInstalled: listenerSlot() },
    webNavigation: {
      onBeforeNavigate: listenerSlot(), onCommitted: listenerSlot(), onDOMContentLoaded: listenerSlot(),
      onCompleted: listenerSlot(), onErrorOccurred: listenerSlot(), onHistoryStateUpdated: listenerSlot(),
      onReferenceFragmentUpdated: listenerSlot(),
    },
  };
  const FakeDate = class extends Date { static now() { return clock.now; } };
  const source = makeTitleNavigationDiagnosticServiceWorkerJs();
  const marker = '  void reconcile("worker-wake");';
  const instrumented = source.replace(marker, `  globalThis.__h2oTitleStage0B2BTest = Object.freeze({
    bytes, emptyEvidence, makeEvent, retainEvent, appendEvent, navigationEvent, collectorBoot,
    collectorEvent, maybeSettle, reconcile, completeRun, clearTimers, routeShape,
    scheduleSettle, scheduleTimeout, settleDeadline
  });`);
  assert.notEqual(instrumented, source, "service-worker test instrumentation point missing");
  const context = {
    chrome, crypto: crypto.webcrypto, TextEncoder, URL, structuredClone, Date: FakeDate,
    setTimeout: (handler, delay) => clock.setTimeout(handler, delay),
    clearTimeout: (id) => clock.clearTimeout(id), console,
  };
  vm.runInNewContext(instrumented, context, { filename: "generated-service-worker-runtime.js" });
  return { clock, values, storage, chrome, teardownRequests, hook: context.__h2oTitleStage0B2BTest };
}

async function seedWorkerRun(harness, options = {}) {
  const runId = options.runId || "run-worker-test";
  const nonce = options.nonce || "12345678-1234-1234-1234-123456789abc";
  const tabId = options.tabId || 77;
  const documentId = options.documentId || "doc-source";
  const sourceUrl = options.sourceUrl || "https://chatgpt.com/c/source-chat";
  const sourceRoute = await harness.hook.routeShape(sourceUrl, nonce);
  const control = {
    schema: C.schema, state: "armed", runId, nonce, createdAt: harness.clock.now, armedAt: harness.clock.now,
    expiresAt: harness.clock.now + C.limits.runTimeoutMs, targetTabId: tabId,
    sourceDocumentId: documentId, destinationDocumentId: null, sourceRoute, destinationRoute: null,
    transitionKind: null, destinationRouteChangedAt: null, routeStableDeadline: null,
    quietDeadline: null, teardownStartedAt: null
  };
  const evidence = harness.hook.emptyEvidence(runId, "armed", harness.clock.now);
  evidence.armedAt = harness.clock.now;
  evidence.targetTabId = tabId;
  evidence.summary.sourceRoute = sourceRoute;
  evidence.documents.push({ documentId, tabId, frameId: 0, firstSeenAt: harness.clock.now,
    route: sourceRoute, isolatedReady: true, mainReady: true });
  await harness.storage.set({ [C.storage.control]: control, [C.storage.evidence]: evidence });
  return { runId, nonce, tabId, documentId, sourceRoute };
}

async function assertEvidenceAndNavigationStateMachine() {
  {
    const harness = makeWorkerHarness();
    const seeded = await seedWorkerRun(harness);
    const evidence = (await harness.storage.get([C.storage.evidence]))[C.storage.evidence];
    for (let index = 0; index < 700; index += 1) {
      const event = harness.hook.makeEvent(evidence, {
        eventId: "optional:" + index, atEpochMs: harness.clock.now + index,
        source: "isolated", category: "performance", type: "performance.longtask",
        priorityClass: "optional", tabId: seeded.tabId, frameId: 0, documentId: seeded.documentId,
        route: seeded.sourceRoute, data: { message: "x".repeat(200), duration: index }
      });
      harness.hook.retainEvent(evidence, event);
    }
    evidence.summary.destinationRoute = "/c/#destination";
    evidence.state = "settling";
    const control = (await harness.storage.get([C.storage.control]))[C.storage.control];
    control.state = "settling";
    control.destinationRoute = evidence.summary.destinationRoute;
    control.destinationDocumentId = seeded.documentId;
    control.quietDeadline = harness.clock.now;
    await harness.storage.set({ [C.storage.control]: control, [C.storage.evidence]: evidence });
    await harness.hook.completeRun("destination-settled");
    const result = (await harness.storage.get([C.storage.evidence]))[C.storage.evidence];
    assert.equal(result.state, "complete", "completion state was starved by optional saturation");
    assert.equal(result.summary.destinationRoute, "/c/#destination", "destination summary was starved");
    assert(result.events.some((event) => event.type === "run.completed" && event.priorityClass === "critical"),
      "critical completion timeline event was not retained");
    assert(harness.hook.bytes(result) <= C.limits.maxStoredBytes, "saturated evidence exceeded 128 KB");
    assert(result.droppedBySizeCount > 0, "optional saturation did not record bounded drops");
  }

  {
    const harness = makeWorkerHarness();
    const seeded = await seedWorkerRun(harness);
    await harness.hook.navigationEvent("history-state", {
      tabId: seeded.tabId, frameId: 0, url: "https://chatgpt.com/c/destination-chat", timeStamp: harness.clock.now
    });
    let all = await harness.storage.get([C.storage.control, C.storage.evidence]);
    assert.equal(all[C.storage.control].transitionKind, "same-document");
    assert.equal(all[C.storage.control].destinationDocumentId, seeded.documentId,
      "same-document navigation fabricated or lost its trusted document identity");
    assert.notEqual(all[C.storage.control].destinationRoute, seeded.sourceRoute,
      "same-document chats were not distinguished by salted routes");
    assert.equal(all[C.storage.evidence].documents.length, 1, "same-document navigation created a second document");
    assert.equal(all[C.storage.control].state, "settling", "same-document navigation did not reach settling");
    const deadline = all[C.storage.control].quietDeadline;
    const routeStableDeadline = all[C.storage.control].routeStableDeadline;
    assert(routeStableDeadline - harness.clock.now >= 5000,
      "same-document route stability interval must be at least 5000 ms");
    await harness.hook.collectorEvent({
      runId: seeded.runId, nonce: seeded.nonce, eventId: "optional:availability", atEpochMs: harness.clock.now + 10,
      source: "main", category: "runtime", type: "runtime.availability", route: "/c/#id",
      data: { chatTitle: true, tabTitle: true, underInput: true, autoEmojiAbsent: true }
    }, { tab: { id: seeded.tabId }, frameId: 0, documentId: seeded.documentId });
    all = await harness.storage.get([C.storage.control]);
    assert.equal(all[C.storage.control].quietDeadline, deadline, "optional telemetry postponed the quiet deadline");
    await harness.clock.tick(C.limits.settleMs + 25);
    all = await harness.storage.get([C.storage.control]);
    assert.equal(all[C.storage.control].state, "settling", "same-document navigation completed before route stability");
    await harness.clock.tick(routeStableDeadline - harness.clock.now + 25);
    all = await harness.storage.get([C.storage.control, C.storage.evidence]);
    assert.equal(all[C.storage.control].state, "complete", "same-document navigation did not complete");
    assert.equal(all[C.storage.evidence].completionReason, "destination-settled");
  }

  {
    const harness = makeWorkerHarness();
    const seeded = await seedWorkerRun(harness, { runId: "run-late-canonical-route" });
    await harness.hook.navigationEvent("history-state", {
      tabId: seeded.tabId, frameId: 0, url: "https://chatgpt.com/c/provisional-chat", timeStamp: harness.clock.now
    });
    let all = await harness.storage.get([C.storage.control, C.storage.evidence]);
    const provisionalRoute = all[C.storage.control].destinationRoute;
    await harness.clock.tick(C.limits.settleMs + 500);
    all = await harness.storage.get([C.storage.control, C.storage.evidence]);
    assert.equal(all[C.storage.control].state, "settling", "provisional route completed after only the quiet window");
    assert.equal(all[C.storage.evidence].events.filter((event) => event.type === "run.completed").length, 0,
      "provisional route emitted completion");

    await harness.hook.navigationEvent("history-state", {
      tabId: seeded.tabId, frameId: 0, url: "https://chatgpt.com/c/final-chat", timeStamp: harness.clock.now
    });
    all = await harness.storage.get([C.storage.control, C.storage.evidence]);
    const finalRoute = all[C.storage.control].destinationRoute;
    const finalStableDeadline = all[C.storage.control].routeStableDeadline;
    assert.notEqual(finalRoute, provisionalRoute, "late canonical route did not replace the provisional candidate");
    await harness.clock.tick(finalStableDeadline - harness.clock.now + 24);
    all = await harness.storage.get([C.storage.control, C.storage.evidence]);
    assert.equal(all[C.storage.control].state, "settling", "final route completed before its stability deadline");
    await harness.clock.tick(1);
    all = await harness.storage.get([C.storage.control, C.storage.evidence]);
    assert.equal(all[C.storage.control].state, "complete", "stable final route did not complete");
    assert.equal(all[C.storage.control].destinationRoute, finalRoute);
    assert.equal(all[C.storage.evidence].summary.destinationRoute, finalRoute);
    assert.equal(all[C.storage.evidence].events.filter((event) => event.type === "run.completed").length, 1,
      "final route emitted duplicate completion");
    assert.equal(harness.teardownRequests.length, 1, "completion did not initiate exactly one teardown");
    assert.equal(harness.teardownRequests[0].evidenceState, "complete",
      "collector teardown began before terminal evidence was stored");
    assert.equal(harness.teardownRequests[0].completedEvents, 1,
      "collector teardown began before run.completed was retained");

    const terminal = structuredClone(all[C.storage.control]);
    const terminalEvidence = structuredClone(all[C.storage.evidence]);
    const navigationCount = all[C.storage.evidence].events.filter((event) => event.category === "navigation").length;
    await harness.hook.navigationEvent("history-state", {
      tabId: seeded.tabId, frameId: 0, url: "https://chatgpt.com/c/too-late", timeStamp: harness.clock.now
    });
    await harness.hook.completeRun("destination-settled", seeded.runId);
    await harness.hook.reconcile("late-terminal-reconcile");
    await harness.hook.collectorEvent({
      runId: seeded.runId, nonce: seeded.nonce, eventId: "late:collector", atEpochMs: harness.clock.now,
      source: "main", category: "runtime", type: "runtime.availability", route: "/c/#id", data: { present: true }
    }, { tab: { id: seeded.tabId }, frameId: 0, documentId: seeded.documentId });
    all = await harness.storage.get([C.storage.control, C.storage.evidence]);
    for (const key of ["state", "completedAt", "destinationRoute", "destinationDocumentId", "transitionKind"]) {
      assert.equal(all[C.storage.control][key], terminal[key], `terminal field changed after completion: ${key}`);
    }
    assert.equal(all[C.storage.evidence].completedAt, terminalEvidence.completedAt,
      "terminal evidence timestamp changed after completion");
    assert.equal(all[C.storage.evidence].summary.destinationRoute, terminalEvidence.summary.destinationRoute,
      "terminal destination summary changed after completion");
    assert.equal(all[C.storage.evidence].completionReason, "destination-settled");
    assert.equal(all[C.storage.evidence].events.filter((event) => event.type === "run.completed").length, 1);
    assert.equal(all[C.storage.evidence].events.filter((event) => event.category === "navigation").length, navigationCount,
      "late navigation was accepted after teardown");
    assert.equal(harness.teardownRequests.length, 1, "terminal paths initiated a second teardown");

    const stoppedMessage = (eventId) => ({
      runId: seeded.runId, nonce: seeded.nonce, eventId, atEpochMs: harness.clock.now,
      source: "isolated", category: "lifecycle", type: "content.stopped", route: "/c/#id",
      data: { reason: "service-worker" }
    });
    const sender = { tab: { id: seeded.tabId }, frameId: 0, documentId: seeded.documentId };
    await harness.hook.collectorEvent(stoppedMessage("stop:one"), sender);
    await harness.hook.collectorEvent(stoppedMessage("stop:two"), sender);
    all = await harness.storage.get([C.storage.evidence]);
    assert.equal(all[C.storage.evidence].events.filter((event) => event.type === "content.stopped").length, 1,
      "collector teardown evidence was duplicated");
    const completedIndex = all[C.storage.evidence].events.findIndex((event) => event.type === "run.completed");
    const stoppedIndex = all[C.storage.evidence].events.findIndex((event) => event.type === "content.stopped");
    assert(completedIndex >= 0 && stoppedIndex > completedIndex, "teardown evidence preceded terminal completion");
  }

  {
    const harness = makeWorkerHarness();
    const seeded = await seedWorkerRun(harness, { runId: "run-terminal-race" });
    await harness.hook.navigationEvent("history-state", {
      tabId: seeded.tabId, frameId: 0, url: "https://chatgpt.com/c/race-destination", timeStamp: harness.clock.now
    });
    const settling = (await harness.storage.get([C.storage.control]))[C.storage.control];
    harness.clock.now = Math.max(settling.quietDeadline, settling.routeStableDeadline) + 25;
    await Promise.all([
      harness.hook.completeRun("destination-settled", seeded.runId),
      harness.hook.navigationEvent("history-state", {
        tabId: seeded.tabId, frameId: 0, url: "https://chatgpt.com/c/race-late", timeStamp: harness.clock.now
      }),
      harness.hook.completeRun("timeout", seeded.runId),
      harness.hook.reconcile("race-reconcile"),
    ]);
    const all = await harness.storage.get([C.storage.control, C.storage.evidence]);
    assert(["complete", "error"].includes(all[C.storage.control].state), "completion race produced no terminal winner");
    assert.equal(all[C.storage.evidence].events.filter((event) => event.type === "run.completed").length, 1,
      "completion race produced multiple terminal events");
    assert.equal(harness.teardownRequests.length, 1, "completion race initiated multiple teardowns");
  }

  {
    const harness = makeWorkerHarness();
    const seeded = await seedWorkerRun(harness, { runId: "run-full-document" });
    const destinationDocumentId = "doc-destination";
    const destinationUrl = "https://chatgpt.com/c/full-destination";
    await harness.hook.navigationEvent("committed", {
      tabId: seeded.tabId, frameId: 0, documentId: destinationDocumentId,
      url: destinationUrl, timeStamp: harness.clock.now
    });
    await harness.hook.collectorBoot({ eventId: "boot:destination", contentInstanceId: "content-destination" }, {
      tab: { id: seeded.tabId, url: destinationUrl }, frameId: 0, documentId: destinationDocumentId,
      documentLifecycle: "active", url: destinationUrl
    });
    for (const [type, eventId] of [["content.activated", "destination:isolated"], ["bridge.main-ready", "destination:main"]]) {
      await harness.hook.collectorEvent({
        runId: seeded.runId, nonce: seeded.nonce, eventId, atEpochMs: harness.clock.now,
        source: type === "bridge.main-ready" ? "main" : "isolated", category: "lifecycle", type,
        route: "/c/#id", data: {}
      }, { tab: { id: seeded.tabId }, frameId: 0, documentId: destinationDocumentId });
    }
    let all = await harness.storage.get([C.storage.control, C.storage.evidence]);
    assert.equal(all[C.storage.control].transitionKind, "full-document");
    assert.equal(all[C.storage.evidence].documents.length, 2, "full-document navigation did not retain two documents");
    await harness.clock.tick(C.limits.settleMs + 25);
    all = await harness.storage.get([C.storage.control]);
    assert.equal(all[C.storage.control].state, "complete", "full-document navigation did not complete");
  }

  for (const expired of [false, true]) {
    const harness = makeWorkerHarness();
    const seeded = await seedWorkerRun(harness, { runId: expired ? "run-restart-expired" : "run-restart-future" });
    const all = await harness.storage.get([C.storage.control, C.storage.evidence]);
    all[C.storage.control].state = "settling";
    all[C.storage.control].destinationDocumentId = seeded.documentId;
    all[C.storage.control].destinationRoute = "/c/#restart";
    all[C.storage.control].transitionKind = "same-document";
    all[C.storage.control].destinationRouteChangedAt = harness.clock.now - (expired ? 5001 : 3500);
    all[C.storage.control].routeStableDeadline = harness.clock.now + (expired ? -1 : 1500);
    all[C.storage.control].quietDeadline = harness.clock.now + (expired ? -1 : 1000);
    all[C.storage.evidence].state = "settling";
    all[C.storage.evidence].summary.destinationRoute = "/c/#restart";
    await harness.storage.set({ [C.storage.control]: all[C.storage.control], [C.storage.evidence]: all[C.storage.evidence] });
    harness.hook.clearTimers();
    await harness.hook.reconcile("test-restart");
    if (!expired) await harness.clock.tick(1525);
    const finalControl = (await harness.storage.get([C.storage.control]))[C.storage.control];
    assert.equal(finalControl.state, "complete", expired
      ? "expired persisted quiet deadline did not complete during reconciliation"
      : "future persisted quiet deadline was not reconstructed after restart");
  }
}

function assertRuntimeContract() {
  const isolated = makeTitleNavigationDiagnosticIsolatedJs();
  const main = makeTitleNavigationDiagnosticMainJs();
  const popup = makeTitleNavigationDiagnosticPopupJs();
  const worker = makeTitleNavigationDiagnosticServiceWorkerJs();
  for (const [label, source] of Object.entries({ isolated, main, popup, worker })) syntax(source, label);

  const passive = isolated + "\n" + main + "\n" + worker;
  const forbiddenExecutable = [
    /\.setTitle\s*\(/, /\.setEmoji\s*\(/, /\.renameNative\s*\(/, /\bPATCH\b/,
    /\blocalStorage\b/, /\bsessionStorage\b/, /document\.cookie/,
    /location\.(?:assign|replace)\s*\(/, /(?:window\.)?location(?:\.href)?\s*=/,
    /history\s*\.\s*(?:pushState|replaceState)\s*=/,
    /history\s*\[\s*["'](?:pushState|replaceState)["']\s*\]\s*=/,
    /\.click\s*\(/, /dispatchEvent\s*\(\s*new\s+(?:Mouse|Input|Keyboard)Event/,
  ];
  for (const pattern of forbiddenExecutable) assert(!pattern.test(passive), `passivity violation: ${pattern}`);
  assert.equal((popup.match(/anchor\.click\(\)/g) || []).length, 1, "popup export must use one temporary anchor click");
  assert(!/\blocalStorage\b|\bsessionStorage\b|document\.cookie/.test(popup), "popup must not access page storage");
  assert(!/history\s*\.\s*(?:pushState|replaceState)/.test(isolated + main), "history APIs must not be wrapped or read");

  for (const key of Object.values(C.storage)) assert(worker.includes(key), `missing storage key ${key}`);
  const foundKeys = [...worker.matchAll(/h2o:dev:title-stage0b2b:v1:[a-z-]+/g)].map((match) => match[0]);
  assert.deepEqual(new Set(foundKeys), new Set(Object.values(C.storage)), "unexpected diagnostic storage key");
  assert.equal(C.limits.maxEvents, 500);
  assert.equal(C.limits.maxDocuments, 20);
  assert.equal(C.limits.maxStoredBytes, 128 * 1024);
  assert.equal(C.limits.maxEventPayloadBytes, 2 * 1024);
  assert(C.limits.criticalReserveEvents > 0 && C.limits.criticalReserveEvents < C.limits.maxEvents,
    "critical event reserve must be bounded within maxEvents");
  assert(C.limits.criticalReserveBytes > 0 && C.limits.criticalReserveBytes < C.limits.maxStoredBytes,
    "critical byte reserve must be bounded within maxStoredBytes");
  assert.equal(C.limits.maxTitleLengthMetadata, 128);
  assert.equal(C.limits.maxErrorMessage, 200);
  assert.equal(C.limits.maxStackFrames, 5);
  assert.equal(C.limits.maxStackChars, 500);
  assert(C.limits.maxStatusTtlMs <= 24 * 60 * 60 * 1000);
  assert(C.limits.sameDocumentRouteStableMs >= 5000,
    "same-document route stability interval must be at least 5000 ms");

  for (const id of Object.values(C.registrationIds)) assert.equal((worker.match(new RegExp(id, "g")) || []).length >= 1, true, `missing registration ID ${id}`);
  assert(worker.includes("persistAcrossSessions: false") && worker.includes('runAt: "document_start"'), "dynamic registration lifecycle missing");
  assert(worker.includes('world: "MAIN"') && worker.includes('world: "ISOLATED"'), "world isolation missing");
  assert(worker.includes("executeScript") && worker.includes("registerContentScripts") && worker.includes("getRegisteredContentScripts"), "current/future injection missing");
  assert(worker.includes("writeChain") && worker.includes("dedupSuppressedCount") && worker.includes("maxStoredBytes"), "serialized bounded reducer missing");
  assert(worker.includes("priorityClass") && worker.includes("criticalReserveEvents") && worker.includes("trimToHardLimit"),
    "critical/optional bounded retention policy missing");
  assert(worker.includes('kind === "history-state" || kind === "fragment"') &&
    worker.includes('"same-document"') && worker.includes('"full-document"'),
    "same-document/full-document destination paths missing");
  assert(worker.includes("scheduleSettle(control)") && worker.includes("settleDeadline(control)"),
    "persisted settle-deadline reconstruction missing");
  assert(worker.includes("sameDocumentRouteStableMs") && worker.includes("routeStableDeadline") &&
    worker.includes("destinationRouteChangedAt"), "same-document route stabilization missing");
  assert(worker.includes("ACTIVE_STATES.has(control.state)") && worker.includes("teardownStartedAt") &&
    worker.includes('eventId: "run:completed:" + control.runId'),
    "serialized terminal-state ownership missing");
  assert(main.includes("lastAvailabilityFingerprint") && main.includes("loaderMarkerPromise") &&
    main.includes("availabilityFingerprint !== lastAvailabilityFingerprint"),
    "change-driven API readiness or loader-marker concurrency guard missing");
  assert(isolated.includes("lastTitleValue") && isolated.includes("lastTitleMenuCount") &&
    isolated.includes("lastEmojiBadgeCount") && isolated.includes("lastUnderInputFingerprint") &&
    isolated.includes("underInputMetadata"), "isolated DOM snapshot suppression missing");
  assert(worker.includes('throw new Error("Unknown diagnostic message operation.")'), "unknown service-worker operations must be rejected");
  assert(worker.includes('throw new Error("Unknown diagnostic operation.")'), "unknown popup operations must be rejected");
  assert(worker.includes("worker-wake") && worker.includes("unregisterOwned") && worker.includes("reconcile"), "restart reconciliation missing");
  assert(worker.includes("ownedRegistrationHealth") &&
    worker.includes("if (!registrationHealth.healthy) await registerOwned()") &&
    worker.includes("if (!timeoutTimer) scheduleTimeout(control)") &&
    worker.includes("repaired: !registrationHealth.healthy"),
    "read-only status registration health check missing");
  assert(worker.includes("collector-teardown") && isolated.includes("removeListener") && main.includes("unsubscribe"), "idempotent teardown ownership missing");
  assert(isolated.includes("event.source !== window") && isolated.includes("ALLOWED_MAIN_TYPES") && isolated.includes("maxEventPayloadBytes"), "bridge validation missing");
  assert(main.includes('direction: "main-to-isolated"') && !main.includes("chrome.runtime"), "MAIN collector must be evidence-only");
  assert(worker.includes("onHistoryStateUpdated") && worker.includes("onReferenceFragmentUpdated"), "safe history navigation evidence missing");
  assert(isolated.includes("MutationObserver") && isolated.includes("PerformanceObserver"), "DOM/performance observation missing");
  assert(main.includes("ChatTitle.subscribe") || main.includes("current.subscribe"), "direct title subscription missing");
  assert(popup.includes("URL.createObjectURL") && popup.includes("URL.revokeObjectURL"), "bounded popup export missing");
}

function assertBuildIntegration() {
  const build = read("tools/product/extensions/chatgpt/chrome/build-chrome-live-extension.mjs");
  const manifest = read("tools/product/extensions/chatgpt/chrome/chrome-live-manifest.mjs");
  assert(build.includes("H2O_TITLE_DIAGNOSTIC") && build.includes("OUTPUT_VARIANT"), "exact diagnostic build gate missing");
  assert(build.includes("makeTitleNavigationDiagnosticServiceWorkerJs") && build.includes("checkGeneratedJavaScript(file)"), "diagnostic generation/syntax check missing");
  assert(build.includes("Duplicate Stage 0B-2B diagnostic service-worker snippet"), "duplicate snippet guard missing");
  assert(build.includes("fs.unlinkSync(path.join(OUT_DIR, name))"), "disabled stale-file removal missing");
  assert(manifest.includes('permissions.push("webNavigation", "scripting")'), "permission gate missing");
}

function assertGenerated() {
  assert(fs.existsSync(OUT) && fs.statSync(OUT).isDirectory(), "generated target extension is missing");
  const manifest = JSON.parse(fs.readFileSync(path.join(OUT, "manifest.json"), "utf8"));
  assert.equal(manifest.manifest_version, 3, "manifest must remain MV3");
  for (const permission of ["webNavigation", "scripting"]) assert(manifest.permissions.includes(permission), `generated permission missing: ${permission}`);
  assert(!manifest.permissions.includes("downloads"), "generated downloads permission forbidden");
  assert(!(manifest.content_scripts || []).some((entry) => (entry.js || []).some((name) => name.includes("title-navigation-diagnostic"))), "static diagnostic content scripts forbidden");
  assert(!JSON.stringify(manifest.web_accessible_resources || []).includes(TITLE_DIAGNOSTIC_FILES.main), "generated MAIN collector exposed through WAR");
  assert.equal(getExtensionId(TARGET_VARIANT), EXPECTED_ID, "generated variant extension ID changed");
  for (const name of Object.values(TITLE_DIAGNOSTIC_FILES)) {
    const file = path.join(OUT, name);
    assert(fs.existsSync(file) && fs.statSync(file).isFile(), `missing generated ${name}`);
    syntax(fs.readFileSync(file, "utf8"), name);
  }
  assert.equal(fs.readFileSync(path.join(OUT, TITLE_DIAGNOSTIC_FILES.isolated), "utf8"), makeTitleNavigationDiagnosticIsolatedJs(), "generated isolated collector drifted from source");
  assert.equal(fs.readFileSync(path.join(OUT, TITLE_DIAGNOSTIC_FILES.main), "utf8"), makeTitleNavigationDiagnosticMainJs(), "generated MAIN collector drifted from source");
  assert.equal(fs.readFileSync(path.join(OUT, TITLE_DIAGNOSTIC_FILES.popup), "utf8"), makeTitleNavigationDiagnosticPopupJs(), "generated popup controller drifted from source");
  const bg = fs.readFileSync(path.join(OUT, "bg.js"), "utf8");
  const popup = fs.readFileSync(path.join(OUT, "popup.html"), "utf8");
  const popupJs = fs.readFileSync(path.join(OUT, "popup.js"), "utf8");
  const popupCss = fs.readFileSync(path.join(OUT, "popup.css"), "utf8");
  const loader = fs.readFileSync(path.join(OUT, "loader.js"), "utf8");
  assert.equal((bg.match(/H2O_TITLE_STAGE0B2B_SERVICE_WORKER_V1/g) || []).length, 1, "service-worker snippet count must be one");
  assert(bg.endsWith(makeTitleNavigationDiagnosticServiceWorkerJs()), "generated service-worker snippet drifted from source");
  assert.equal(popup, makeChromeLivePopupHtml({ titleDiagnosticEnabled: true }), "generated popup HTML drifted from source");
  assert.equal(popupCss, makeChromeLivePopupCss(), "generated popup CSS drifted from source");
  assert(popupJs.includes("h2o:title-diagnostics-workspace-toggle-sidebar") &&
    popupJs.includes('elApp?.dataset.workspaceMode === "diagnostics"'),
    "generated popup interaction ownership missing");
  assert(popup.includes("Title navigation diagnostic") && popup.includes(TITLE_DIAGNOSTIC_FILES.popup),
    "generated popup controls missing");
  const generatedInfo = popup.slice(popup.indexOf('id="controls-page-info"'), popup.indexOf('id="controls-page-hidden"'));
  assert(!generatedInfo.includes("title-diag-reset"), "old Info-tab diagnostic card leaked into generated output");
  assert(popup.includes('id="diagnostics-workspace"') && popup.includes('data-popup-action="open-diagnostics"'),
    "generated full diagnostics workspace missing");
  assert(!JSON.stringify(manifest).includes("h2o-cp-title-stage0b") && !bg.includes("h2o-cp-title-stage0b") && !loader.includes("h2o-cp-title-stage0b"), "temporary worktree path leaked");
  for (const prefix of ["9B0a", "9B1a", "9C1a"]) {
    assert(loader.includes(prefix), `loader title delivery missing ${prefix}`);
    assert(fs.readFileSync(PROXY, "utf8").includes(prefix), `proxy title delivery missing ${prefix}`);
  }
  const proxy = fs.readFileSync(PROXY, "utf8");
  assert(!proxy.includes("9D1a"), "disabled 9D1a leaked into active proxy");
  syntax(bg, "generated bg.js"); syntax(loader, "generated loader.js");
}

assertFileScope();
assertTitleState();
assertVariantIsolation();
assertWorkspaceContract();
assertTitleClickTimingContract();
await assertControlActionGuard();
await assertMainCollectorChangeDriven();
await assertIsolatedDomSuppression();
await assertEvidenceAndNavigationStateMachine();
assertRuntimeContract();
assertBuildIntegration();
if (GENERATED) assertGenerated();

const generated = {
  isolatedBytes: Buffer.byteLength(makeTitleNavigationDiagnosticIsolatedJs()),
  mainBytes: Buffer.byteLength(makeTitleNavigationDiagnosticMainJs()),
  popupBytes: Buffer.byteLength(makeTitleNavigationDiagnosticPopupJs()),
  serviceWorkerBytes: Buffer.byteLength(makeTitleNavigationDiagnosticServiceWorkerJs()),
};
console.log(JSON.stringify({
  ok: true,
  validator: "title-stage0b2b-direct-diagnostic",
  mode: GENERATED ? "generated" : "source",
  schema: C.schema,
  extensionId: EXPECTED_ID,
  sha256: crypto.createHash("sha256").update(JSON.stringify(generated)).digest("hex"),
  generated,
}, null, 2));
