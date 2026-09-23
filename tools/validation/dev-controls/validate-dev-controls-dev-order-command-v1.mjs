#!/usr/bin/env node
// tools/validation/dev-controls/validate-dev-controls-dev-order-command-v1.mjs
// @version 1.0.0
//
// Step 3B boundary validator for L-DEVELOPER-CONTROLS.
//
// Canonical dev-order mutation belongs to L-RUNTIME-KERNEL-SCOPE-EXT. Developer
// Controls may express intent over a bounded localhost transport; it may not
// parse, patch or write dev-order files itself. This validator exercises the
// REAL implementation rather than restating it:
//
//   - the Runtime command in tools/loader/sync-dev-order.mjs is run as a real
//     child process against an isolated temporary fixture, reached through the
//     module's established H2O_SRC_DIR / H2O_ORDER_FILE environment seams. Those
//     seams are not reachable from the browser command surface;
//   - the Developer Controls transport in apps/dev-server/serve.py is started on
//     an ephemeral loopback port and driven with real HTTP requests;
//   - the popup boundary is asserted against the emitted popup JavaScript.
//
// config/dev-order.tsv is never read as a mutation target and never modified:
// every fixture lives under a temp directory that is removed on exit.

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { makeChromeLivePopupJs } from "../../product/extensions/chatgpt/chrome/popup/chrome-live-popup-js.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const COMMAND_SCRIPT = path.join(ROOT, "tools/loader/sync-dev-order.mjs");
const SERVE_PY = path.join(ROOT, "apps/dev-server/serve.py");
const POPUP_VIEW = path.join(ROOT, "tools/product/extensions/chatgpt/chrome/popup/chrome-live-popup-view.mjs");
const CANONICAL_MASTER = path.join(ROOT, "config/dev-order.tsv");
const RESULT_MARKER = "[H2O][dev-order-command]";
const COMMAND_ENDPOINT = "/__h2o/dev-order/command";
const PROJECTIONS = [
  "dev-order.txt", "dev-order.json", "scripts-list.tsv",
  "userscript-headers.tsv", "userscript-headers.html",
];

let PASS = 0;
const FAILURES = [];
function ok(name) { PASS += 1; }
function check(name, fn) {
  try { fn(); ok(name); } catch (error) { FAILURES.push(name + ": " + (error && error.message || error)); }
}
async function checkAsync(name, fn) {
  try { await fn(); ok(name); } catch (error) { FAILURES.push(name + ": " + (error && error.message || error)); }
}

const CANONICAL_BEFORE = fs.readFileSync(CANONICAL_MASTER);

/* ---------------------------------------------------------------- fixtures */

const STAGE = fs.mkdtempSync(path.join(os.tmpdir(), "h2o-dev-order-command-"));
function cleanup() { try { fs.rmSync(STAGE, { recursive: true, force: true }); } catch {} }

// A fixture is a miniature source tree: real script files plus a sectioned
// master, so the generator does real work instead of a mocked pass.
function makeFixture(name, { duplicate = false } = {}) {
  const root = path.join(STAGE, name);
  const scripts = path.join(root, "src-runtime-base");
  const config = path.join(root, "config");
  fs.mkdirSync(scripts, { recursive: true });
  fs.mkdirSync(config, { recursive: true });
  const files = ["0A1a.Core Alpha.js", "0A2b.Core Beta.js", "0C1a.Perf One.js", "0D1a.Data One.js"];
  for (const file of files) {
    fs.writeFileSync(path.join(scripts, file),
      "// ==H2O Module==\n// @name " + file + "\n// ==/H2O Module==\nconsole.log(1);\n", "utf8");
  }
  const lines = [
    "# H2O dev order (source filenames) — TSV (sectioned)",
    "# MASTER: dev-order.tsv",
    "# STATUS<TAB>FILENAME   (STATUS = 🟢/🔴; accepts ON/OFF, ✅/❌, 🟩/🟥 when reading)",
    "",
    "# =========================", "# 🧠 CORE", "# =========================",
    "🟢\t0A1a.Core Alpha.js", "🟢\t0A2b.Core Beta.js", "",
    "# =========================", "# 🚀 PERFORMANCE", "# =========================",
    "🔴\t0C1a.Perf One.js", "",
    "# =========================", "# 🗃️ DATA", "# =========================",
    "🟢\t0D1a.Data One.js", "",
  ];
  // An ambiguous identifier is representable by listing one file twice.
  if (duplicate) lines.splice(9, 0, "🟢\t0A1a.Core Alpha.js");
  fs.writeFileSync(path.join(config, "dev-order.tsv"), lines.join("\n"), "utf8");
  return { root, master: path.join(config, "dev-order.tsv"), config };
}

function runCommand(fixture, envelope, { extraEnv = {} } = {}) {
  const args = [COMMAND_SCRIPT];
  if (envelope !== null) args.push("--command-stdin");
  const result = spawnSync(process.execPath, args, {
    input: envelope === null ? "" : (typeof envelope === "string" ? envelope : JSON.stringify(envelope)),
    encoding: "utf8",
    cwd: ROOT,
    env: { ...process.env, H2O_SRC_DIR: fixture.root, H2O_ORDER_FILE: fixture.master, ...extraEnv },
  });
  let parsed = null;
  for (const line of String(result.stdout || "").split("\n")) {
    if (line.startsWith(RESULT_MARKER)) {
      try { parsed = JSON.parse(line.slice(RESULT_MARKER.length).trim()); } catch { parsed = null; }
    }
  }
  return { status: result.status, result: parsed, stdout: result.stdout || "" };
}

const readMaster = (fixture) => fs.readFileSync(fixture.master, "utf8");
const masterHash = (fixture) => crypto.createHash("sha256").update(fs.readFileSync(fixture.master)).digest("hex");
function statusOf(fixture, file) {
  for (const line of readMaster(fixture).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const parts = line.split("\t");
    if (parts.length < 2) continue;
    if (parts.slice(1).join("\t").trim() === file) return parts[0];
  }
  return null;
}

/* ------------------------------------------------------- runtime command */

check("plain no-command synchronization still regenerates every projection", () => {
  const fixture = makeFixture("plain");
  const run = runCommand(fixture, null);
  assert.equal(run.status, 0, "plain sync exited non-zero");
  assert.equal(run.result, null, "plain sync must not emit a command result");
  for (const projection of PROJECTIONS) {
    assert(fs.existsSync(path.join(fixture.config, projection)), "missing projection " + projection);
  }
});

check("set-enabled flips exactly the requested row and reports the projections", () => {
  const fixture = makeFixture("enable");
  assert.equal(statusOf(fixture, "0C1a.Perf One.js"), "🔴", "fixture precondition");
  const run = runCommand(fixture, { operation: "set-enabled", sourceFile: "0C1a.Perf One.js", enabled: true });
  assert.equal(run.result && run.result.ok, true, "command did not succeed");
  assert.equal(run.result.changed, true, "command did not report a change");
  assert.equal(run.result.canonicalId, "0C1a.Perf One.js", "wrong canonical identifier");
  assert.deepEqual(run.result.regenerated, PROJECTIONS, "projection list drifted");
  assert.equal(run.result.needsRebuild, true, "an admission change must report needsRebuild");
  assert.equal(statusOf(fixture, "0C1a.Perf One.js"), "🟢", "master row not flipped");
  assert.equal(statusOf(fixture, "0A1a.Core Alpha.js"), "🟢", "an unrelated row changed");
  const json = JSON.parse(fs.readFileSync(path.join(fixture.config, "dev-order.json"), "utf8"));
  assert(JSON.stringify(json).includes('"0C1a.Perf One.js","enabled":true'), "projection did not follow the master");
});

check("set-enabled is idempotent", () => {
  const fixture = makeFixture("idempotent");
  const first = runCommand(fixture, { operation: "set-enabled", sourceFile: "0C1a.Perf One.js", enabled: true });
  assert.equal(first.result.changed, true, "first request should change the master");
  const before = masterHash(fixture);
  const second = runCommand(fixture, { operation: "set-enabled", sourceFile: "0C1a.Perf One.js", enabled: true });
  assert.equal(second.result.ok, true, "repeat request must still succeed");
  assert.equal(second.result.changed, false, "repeat request must report no change");
  assert.equal(masterHash(fixture), before, "repeat request mutated the master");
});

check("an identifier resolves to exactly one canonical filename", () => {
  const fixture = makeFixture("alias");
  runCommand(fixture, null);
  const listed = fs.readFileSync(path.join(fixture.config, "scripts-list.tsv"), "utf8");
  assert(listed.includes("0C1a.Perf One.js"), "fixture precondition");
  const run = runCommand(fixture, { operation: "set-enabled", sourceFile: "0C1a.Perf One.js", enabled: true });
  assert.equal(run.result && run.result.ok, true, "resolution failed");
  assert.equal(run.result.canonicalId, "0C1a.Perf One.js", "canonical identifier must be the source filename");
});

check("an ambiguous identifier fails closed", () => {
  const fixture = makeFixture("ambiguous", { duplicate: true });
  const before = masterHash(fixture);
  const run = runCommand(fixture, { operation: "set-enabled", sourceFile: "0A1a.Core Alpha.js", enabled: false });
  assert.equal(run.result && run.result.ok, false, "an ambiguous row must be refused");
  assert.equal(run.result.code, "command/row-ambiguous", "wrong refusal code: " + run.result.code);
  assert.equal(masterHash(fixture), before, "an ambiguous request mutated the master");
});

check("set-section-title renames the section and survives a later plain sync", () => {
  const fixture = makeFixture("section");
  const run = runCommand(fixture, { operation: "set-section-title", sectionKey: "PERFORMANCE", title: "🚀 SPEED LAB" });
  assert.equal(run.result && run.result.ok, true, "section rename failed");
  assert.equal(run.result.needsRebuild, false, "a presentational rename must not demand a rebuild");
  assert(readMaster(fixture).includes("# 🚀 SPEED LAB"), "master header not renamed");
  assert(fs.readFileSync(path.join(fixture.config, "dev-order.txt"), "utf8").includes("🚀 SPEED LAB"),
    "projection did not follow the rename");
  runCommand(fixture, null);
  const occurrences = readMaster(fixture).split("🚀 SPEED LAB").length - 1;
  assert.equal(occurrences, 1, "rename did not survive a plain regeneration");
});

/* ------------------------------------------------------------ fail closed */

const REFUSALS = [
  ["unknown row", { operation: "set-enabled", sourceFile: "9Z9z.Nope.js", enabled: true }, "command/row-not-found"],
  ["path traversal identifier", { operation: "set-enabled", sourceFile: "../../etc/passwd", enabled: true }, "command/path-like-identifier"],
  ["path-like identifier", { operation: "set-enabled", sourceFile: "config/dev-order.tsv", enabled: true }, "command/path-like-identifier"],
  ["non-boolean enabled", { operation: "set-enabled", sourceFile: "0A1a.Core Alpha.js", enabled: "yes" }, "command/invalid-enabled"],
  ["missing source file", { operation: "set-enabled", enabled: true }, "command/invalid-source"],
  ["unsupported operation", { operation: "delete-row", sourceFile: "0A1a.Core Alpha.js" }, "command/unsupported-operation"],
  ["unknown section", { operation: "set-section-title", sectionKey: "NOPE", title: "X" }, "command/section-not-found"],
  ["path-like section", { operation: "set-section-title", sectionKey: "../CORE", title: "X" }, "command/invalid-section"],
  ["empty title", { operation: "set-section-title", sectionKey: "CORE", title: "   " }, "command/invalid-title"],
  ["oversize title", { operation: "set-section-title", sectionKey: "CORE", title: "A".repeat(200) }, "command/invalid-title"],
  ["reserved title", { operation: "set-section-title", sectionKey: "CORE", title: "MASTER: x" }, "command/invalid-title"],
  ["control-character title", { operation: "set-section-title", sectionKey: "CORE", title: "a\u0000b" }, "command/invalid-title"],
];

check("every rejected command fails closed and leaves the master byte-identical", () => {
  const fixture = makeFixture("refusals");
  const before = masterHash(fixture);
  for (const [label, envelope, code] of REFUSALS) {
    const run = runCommand(fixture, envelope);
    assert(run.result && run.result.ok === false, label + " was not refused");
    assert.equal(run.result.code, code, label + " gave code " + run.result.code);
  }
  for (const [label, body] of [["malformed envelope", "not-json"], ["array envelope", "[1,2,3]"]]) {
    const run = runCommand(fixture, body);
    assert(run.result && run.result.ok === false, label + " was not refused");
    assert.equal(run.result.code, "command/malformed", label + " gave code " + run.result.code);
  }
  assert.equal(masterHash(fixture), before, "a refused command mutated the canonical master");
});

check("a suppressed master write cannot be reported as success", () => {
  // Anti-degeneracy: neuter the actual write, keep the success path, and prove
  // the canonical readback still refuses to confirm the change.
  const fixture = makeFixture("readback");
  const original = fs.readFileSync(COMMAND_SCRIPT, "utf8");
  // The mutant must sit beside the real module so its relative imports resolve;
  // it is removed again in the finally below.
  const mutant = path.join(path.dirname(COMMAND_SCRIPT), ".sync-dev-order.readback-mutant.mjs");
  const needle = "    lines[index] = nextLine;\n    writeTextFileAtomic(OUT_TSV, lines.join(\"\\n\"));";
  assert(original.includes(needle), "could not locate the master write to neuter");
  let parsed = null;
  let raw = "";
  try {
    fs.writeFileSync(mutant, original.replace(needle, "    void nextLine;"), "utf8");
    const run = spawnSync(process.execPath, [mutant, "--command-stdin"], {
      input: JSON.stringify({ operation: "set-enabled", sourceFile: "0C1a.Perf One.js", enabled: true }),
      encoding: "utf8", cwd: ROOT,
      env: { ...process.env, H2O_SRC_DIR: fixture.root, H2O_ORDER_FILE: fixture.master },
    });
    raw = String(run.stdout || "") + String(run.stderr || "");
    for (const line of String(run.stdout || "").split("\n")) {
      if (line.startsWith(RESULT_MARKER)) { try { parsed = JSON.parse(line.slice(RESULT_MARKER.length).trim()); } catch {} }
    }
  } finally {
    try { fs.rmSync(mutant, { force: true }); } catch {}
  }
  assert(parsed, "the neutered command produced no structured result: " + raw.slice(0, 200));
  assert.equal(parsed.ok, false, "a suppressed write was reported as success");
  assert.equal(parsed.code, "command/readback-contradiction", "wrong refusal code: " + parsed.code);
});

/* -------------------------------------------------------------- transport */

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function request({ port, method, pathName, body, headers }) {
  return new Promise((resolve) => {
    const payload = body === undefined ? null : Buffer.from(body, "utf8");
    const req = http.request({
      host: "127.0.0.1", port, method, path: pathName,
      headers: { ...(headers || {}), ...(payload ? { "Content-Length": payload.length } : {}) },
    }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (c) => { text += c; });
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text }));
    });
    req.on("error", () => resolve({ status: 0, headers: {}, text: "" }));
    if (payload) req.write(payload);
    req.end();
  });
}

await checkAsync("the localhost transport is bounded, origin-restricted and write-free", async () => {
  const fixture = makeFixture("transport");
  const port = await freePort();
  const server = spawn("python3", [SERVE_PY, String(port)], {
    cwd: path.dirname(SERVE_PY),
    env: { ...process.env, H2O_SRC_DIR: fixture.root, H2O_ORDER_FILE: fixture.master },
    stdio: "ignore",
  });
  try {
    let up = false;
    for (let i = 0; i < 80 && !up; i += 1) {
      const probe = await request({ port, method: "GET", pathName: "/serve.py" });
      up = probe.status === 200;
      if (!up) await new Promise((r) => setTimeout(r, 100));
    }
    assert(up, "test transport did not start");

    const json = { "Content-Type": "application/json" };
    const good = JSON.stringify({ operation: "set-enabled", sourceFile: "0C1a.Perf One.js", enabled: true });

    const okRes = await request({ port, method: "POST", pathName: COMMAND_ENDPOINT, body: good, headers: json });
    assert.equal(okRes.status, 200, "the command endpoint did not accept a valid request");
    assert.equal(JSON.parse(okRes.text).ok, true, "the command endpoint did not report success");
    assert.notEqual(okRes.headers["access-control-allow-origin"], "*",
      "a mutation response must never carry wildcard CORS");
    assert.equal(statusOf(fixture, "0C1a.Perf One.js"), "🟢", "the transport did not reach the master");

    const stillReads = await request({ port, method: "GET", pathName: "/serve.py" });
    assert.equal(stillReads.status, 200, "static reads regressed");
    assert.equal(stillReads.headers["access-control-allow-origin"], "*", "static read CORS changed");
    const head = await request({ port, method: "HEAD", pathName: "/serve.py" });
    assert.equal(head.status, 200, "static HEAD regressed");

    // No browser-reachable shape may execute the command. A cross-origin POST
    // always carries Origin, including the simple-request shapes that skip a
    // preflight entirely, so each of these is refused before any work happens.
    const before = masterHash(fixture);
    const hostile = [
      ["simple text/plain", { "Content-Type": "text/plain", Origin: "https://evil.example" }],
      ["form-urlencoded", { "Content-Type": "application/x-www-form-urlencoded", Origin: "https://evil.example" }],
      ["multipart", { "Content-Type": "multipart/form-data; boundary=x", Origin: "https://evil.example" }],
      ["json https origin", { "Content-Type": "application/json", Origin: "https://evil.example" }],
      ["json http origin", { "Content-Type": "application/json", Origin: "http://evil.example" }],
      ["json loopback web origin", { "Content-Type": "application/json", Origin: "http://127.0.0.1:" + port }],
    ];
    for (const [label, headers] of hostile) {
      const res = await request({ port, method: "POST", pathName: COMMAND_ENDPOINT, body: good, headers });
      assert.equal(res.status, 403, label + " was not refused (HTTP " + res.status + ")");
    }
    const preflight = await request({
      port, method: "OPTIONS", pathName: COMMAND_ENDPOINT,
      headers: { Origin: "https://evil.example", "Access-Control-Request-Method": "POST" },
    });
    assert.equal(preflight.status, 403, "a hostile preflight was approved");
    assert.equal(masterHash(fixture), before, "a refused transport request mutated the master");

    const extensionPreflight = await request({
      port, method: "OPTIONS", pathName: COMMAND_ENDPOINT,
      headers: { Origin: "chrome-extension://abc", "Access-Control-Request-Method": "POST" },
    });
    assert.equal(extensionPreflight.status, 204, "the extension preflight was refused");
    assert.equal(extensionPreflight.headers["access-control-allow-origin"], "chrome-extension://abc",
      "the preflight must echo only the calling extension origin");

    const badShapes = [
      ["wrong endpoint", { method: "POST", pathName: "/anything", body: good, headers: json }, 404],
      ["malformed json", { method: "POST", pathName: COMMAND_ENDPOINT, body: "not-json", headers: json }, 400],
      ["wrong content type", { method: "POST", pathName: COMMAND_ENDPOINT, body: good, headers: { "Content-Type": "text/plain" } }, 415],
      ["unsupported operation", { method: "POST", pathName: COMMAND_ENDPOINT, body: JSON.stringify({ operation: "wipe" }), headers: json }, 400],
      ["oversized body", { method: "POST", pathName: COMMAND_ENDPOINT, body: JSON.stringify({ operation: "set-enabled", pad: "A".repeat(9000) }), headers: json }, 413],
      ["arbitrary PUT", { method: "PUT", pathName: "/config/dev-order.tsv", body: "x", headers: {} }, 501],
      ["arbitrary DELETE", { method: "DELETE", pathName: "/config/dev-order.tsv", body: undefined, headers: {} }, 501],
      ["POST to a file path", { method: "POST", pathName: "/config/dev-order.tsv", body: "{}", headers: json }, 404],
    ];
    for (const [label, spec, expected] of badShapes) {
      const res = await request({ port, ...spec });
      assert.equal(res.status, expected, label + " returned HTTP " + res.status + ", expected " + expected);
    }
  } finally {
    server.kill("SIGTERM");
  }
});

/* ----------------------------------------------------------- popup boundary */

check("developer controls carries no dev-order mutation authority", () => {
  const popupJs = makeChromeLivePopupJs({
    PROXY_PACK_URL: "http://127.0.0.1:5500/dev_output/proxy/_paste-pack.ext.txt",
    STORAGE_KEY: "h2oExtDevToggles",
    STORAGE_ORDER_OVERRIDES_KEY: "h2oExtDevOrderOverrides",
    DEV_ORDER_SECTIONS_SNAPSHOT: [],
    DEV_ALIAS_FILENAME_MAP: {},
  });
  for (const forbidden of [
    'method: "PUT"', "replaceEnabledInTsv", "replaceEnabledInTxt", "replaceEnabledInJson",
    "replaceSectionTitleInTsv", "replaceSectionTitleInTxt", "replaceSectionTitleInJson",
    "syncDevOrderFiles", "syncDevOrderSectionTitleFiles",
    'devConfigUrl("dev-order.txt")', 'devConfigUrl("dev-order.json")',
  ]) {
    assert.equal(popupJs.split(forbidden).length - 1, 0, "popup retains dev-order mutation logic: " + forbidden);
  }
  assert.equal(popupJs.split('"' + COMMAND_ENDPOINT + '"').length - 1, 1,
    "popup must address the bounded command endpoint exactly once");
  for (const op of ['operation: "set-enabled"', 'operation: "set-section-title"']) {
    assert.equal(popupJs.split(op).length - 1, 1, "popup must send exactly one " + op);
  }
  assert(popupJs.includes("Rebuild the extension to apply it"),
    "popup must tell the operator that source synchronization is not a rebuild");
  assert(popupJs.includes("canonical dev-order unchanged"),
    "popup must not claim canonical state changed when the command was refused");

  // The ordinary storage-map controls must stay independent of canonical source.
  const view = fs.readFileSync(POPUP_VIEW, "utf8");
  const setAliasEnabled = view.slice(view.indexOf("async function setAliasEnabled("));
  const body = setAliasEnabled.slice(0, setAliasEnabled.indexOf("\n  }\n") + 4);
  assert(!body.includes("sendDevOrderCommand"),
    "setAliasEnabled must remain a storage-map control, not a canonical mutation");
});

check("the transport exposes no general file-write surface", () => {
  const serve = fs.readFileSync(SERVE_PY, "utf8");
  assert(!serve.includes("def do_PUT"), "the dev server gained generic PUT");
  assert(!serve.includes("def do_DELETE"), "the dev server gained generic DELETE");
  assert(serve.includes("shell=False"), "the command must never be invoked through a shell");
  assert(serve.includes('DEV_ORDER_ALLOWED_OPERATIONS = ("set-enabled", "set-section-title")'),
    "the transport must allowlist exactly the two operations");
});

/* ------------------------------------------------------------------ report */

const canonicalUnchanged = Buffer.compare(CANONICAL_BEFORE, fs.readFileSync(CANONICAL_MASTER)) === 0;
if (!canonicalUnchanged) FAILURES.push("config/dev-order.tsv was modified by this validator");
else PASS += 1;

cleanup();

if (FAILURES.length) {
  for (const failure of FAILURES) console.error("  FAIL  " + failure);
  console.error(JSON.stringify({ ok: false, validator: "dev-controls-dev-order-command-v1", pass: PASS, fail: FAILURES.length }, null, 2));
  process.exit(1);
}
console.log(JSON.stringify({
  ok: true,
  validator: "dev-controls-dev-order-command-v1",
  checks: PASS,
  canonicalMasterUnchanged: true,
}, null, 2));
