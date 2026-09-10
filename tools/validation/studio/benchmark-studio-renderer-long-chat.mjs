#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require("playwright"));
} catch (error) {
  console.error("Playwright is required. Set NODE_PATH to a runtime containing the playwright package.");
  console.error(error?.message || error);
  process.exit(1);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const studioRoot = path.join(repoRoot, "src-surfaces-base/studio");
const files = {
  selectors: path.join(studioRoot, "platform/selectors.contract.js"),
  sanitizer: path.join(studioRoot, "platform/html-sanitizer.js"),
  sanitizerPolicyV2: path.join(studioRoot, "renderer/safety/sanitizer-policy.v1.js"),
  sanitizerEngineV2: path.join(studioRoot, "renderer/safety/vendor/dompurify/purify.js"),
  sanitizerV2: path.join(studioRoot, "renderer/safety/html-sanitizer.v2.js"),
  renderer: path.join(studioRoot, "renderer/chat-renderer.studio.js"),
  studio: path.join(studioRoot, "studio.js"),
  host: path.join(studioRoot, "S0D3e. 🎬 Transcript Studio Host - Studio.js"),
  css: path.join(studioRoot, "studio.css"),
};

function extractFunction(source, name) {
  const match = new RegExp(`\\bfunction\\s+${name}\\s*\\(`).exec(source);
  if (!match) throw new Error(`extractFunction: '${name}' not found`);
  const start = match.index;
  const braceOpen = source.indexOf("{", start);
  let depth = 0;
  for (let index = braceOpen; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    else if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(`extractFunction: unterminated '${name}'`);
}

function parsePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseSizes(value) {
  const parsed = String(value || "")
    .split(",")
    .map((entry) => Number.parseInt(entry.trim(), 10))
    .filter((entry) => Number.isFinite(entry) && entry > 0);
  return parsed.length ? [...new Set(parsed)] : [50, 250, 1000, 2000];
}

const config = {
  sizes: parseSizes(process.env.H2O_RENDERER_BENCH_SIZES),
  warmups: parsePositiveInteger(process.env.H2O_RENDERER_BENCH_WARMUPS, 2),
  samples: parsePositiveInteger(process.env.H2O_RENDERER_BENCH_SAMPLES, 7),
};

async function resolveChromiumExecutable() {
  const candidates = [
    process.env.H2O_RENDERER_BENCH_CHROMIUM,
    chromium.executablePath(),
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Google Chrome Dev.app/Contents/MacOS/Google Chrome Dev",
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {}
  }
  throw new Error("No installed Chromium/Chrome executable is available for the Renderer benchmark");
}

const chromiumExecutable = await resolveChromiumExecutable();

const browser = await chromium.launch({
  headless: true,
  executablePath: chromiumExecutable,
  args: [
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-default-apps",
    "--js-flags=--expose-gc",
  ],
});

try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(String(error?.stack || error)));

  await page.setContent(`<!doctype html>
    <html>
      <head><meta charset="utf-8"><title>Studio Renderer long-chat benchmark</title></head>
      <body><main id="viewReader"></main></body>
    </html>`);
  await page.addStyleTag({ path: files.css });
  await page.addScriptTag({ path: files.selectors });
  await page.addScriptTag({ path: files.sanitizer });
  // M03 P1 S1A T1: rich replay consumes Renderer sanitizer v2, so the accepted
  // load chain must be present or every rich turn correctly fails closed to the
  // canonical renderer.
  await page.addScriptTag({ path: files.sanitizerPolicyV2 });
  await page.addScriptTag({ path: files.sanitizerEngineV2 });
  await page.addScriptTag({ path: files.sanitizerV2 });

  let rendererSource = await fs.readFile(files.renderer, "utf8");
  const rendererInstallNeedle = "Studio.chatRenderer = Object.freeze({";
  if (!rendererSource.includes(rendererInstallNeedle)) {
    throw new Error("Renderer benchmark hook could not locate the public API installation point");
  }
  rendererSource = rendererSource.replace(
    rendererInstallNeedle,
    "Studio.__chatRendererBenchmark = Object.freeze({ renderTextAsChatGPTBlocks });\n" + rendererInstallNeedle,
  );
  await page.addScriptTag({ content: rendererSource });

  await page.evaluate(() => {
    const lifecycle = {
      rafQueue: [],
      timerQueue: [],
      hookCalls: [],
      nextId: 1,
    };
    window.__h2oRendererBenchLifecycle = lifecycle;

    const nativeSetTimeout = window.setTimeout.bind(window);
    window.requestAnimationFrame = (callback) => {
      const id = lifecycle.nextId++;
      lifecycle.rafQueue.push({ id, callback });
      return id;
    };
    window.cancelAnimationFrame = (id) => {
      lifecycle.rafQueue = lifecycle.rafQueue.filter((entry) => entry.id !== id);
    };
    window.setTimeout = (callback, delay = 0, ...args) => {
      if (Number(delay) === 120 && typeof callback === "function") {
        const id = lifecycle.nextId++;
        lifecycle.timerQueue.push({ id, callback: () => callback(...args), delay: Number(delay) });
        return id;
      }
      return nativeSetTimeout(callback, delay, ...args);
    };
    window.clearTimeout = (id) => {
      lifecycle.timerQueue = lifecycle.timerQueue.filter((entry) => entry.id !== id);
    };

    window.H2O = window.H2O || {};
    window.H2O.obs = {
      ensureRoot(reason) { lifecycle.hookCalls.push({ hook: "obs.ensureRoot", reason }); },
      markDirty(reason) { lifecycle.hookCalls.push({ hook: "obs.markDirty", reason }); },
      flush(reason) { lifecycle.hookCalls.push({ hook: "obs.flush", reason }); },
      withSuppressed(reason, callback) {
        lifecycle.hookCalls.push({ hook: "obs.withSuppressed", reason });
        if (typeof callback === "function") callback();
      },
    };
    window.H2O.index = {
      refresh(reason) { lifecycle.hookCalls.push({ hook: "index.refresh", reason }); },
    };
  });
  await page.addScriptTag({ path: files.host });

  const studioSource = await fs.readFile(files.studio, "utf8");
  const refreshHelpers = [
    "getStudioChatRenderer",
    "getReusableReaderMount",
    "isReusableReaderMountCurrent",
    "collectRendererEditOverrides",
    "haveEquivalentRendererEditOverrides",
    "canReuseReaderDOM",
  ].map((name) => extractFunction(studioSource, name)).join("\n");
  await page.addScriptTag({ content: `
    const W = window;
    const $ = (selector) => document.querySelector(selector);
    const state = {
      currentReaderSnapshot: null,
      currentReaderEditOverrides: null,
      activeRoute: "reader",
      renderToken: 1,
    };
    function getEditOverride(){ return null; }
    ${refreshHelpers}
    window.__h2oStudioRefreshBenchmark = {
      setState(snapshot, overrides, token = 1){
        state.currentReaderSnapshot = snapshot || null;
        state.currentReaderEditOverrides = Array.isArray(overrides) ? overrides : null;
        state.activeRoute = "reader";
        state.renderToken = token;
      },
      clearState(){
        state.currentReaderSnapshot = null;
        state.currentReaderEditOverrides = null;
        state.activeRoute = "reader";
        state.renderToken = 1;
      },
      getSnapshot(){ return state.currentReaderSnapshot; },
      getOverrides(){ return state.currentReaderEditOverrides; },
      getReusableReaderMount,
      collectRendererEditOverrides,
      canReuseReaderDOM,
    };
  ` });

  const result = await page.evaluate(async (benchmarkConfig) => {
    "use strict";

    const renderer = window.H2O?.Studio?.chatRenderer;
    const rendererBench = window.H2O?.Studio?.__chatRendererBenchmark;
    const sanitizer = window.H2O?.Studio?.html?.sanitize;
    const host = window.H2O?.studioHost;
    const refreshBench = window.__h2oStudioRefreshBenchmark;
    const viewReader = document.getElementById("viewReader");
    if (!renderer || !rendererBench || !sanitizer || !host || !refreshBench || !viewReader) {
      throw new Error("Studio Renderer benchmark dependencies did not initialize");
    }

    const PNG_DATA = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

    function escapeHtml(value) {
      return String(value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
    }

    function roleFor(index) {
      if (index % 47 === 0) return "system";
      if (index % 43 === 0) return "tool";
      return index % 2 === 0 ? "user" : "assistant";
    }

    function markdownFor(index, role) {
      const label = `${role} turn ${index + 1}`;
      switch (index % 8) {
        case 0:
          return `# ${label}\n\nA representative paragraph with **bold**, *italic*, \`inline code\`, Unicode Δοκιμή مرحبا 🚀, and a [safe link](https://example.com/archive/${index + 1}).`;
        case 1:
          return `## ${label}\n\nFirst paragraph keeps ordinary saved-chat prose long enough to exercise realistic inline parsing.\n\nSecond paragraph preserves multiline content and intentional separation.`;
        case 2:
          return `### ${label}\n\n- primary item ${index + 1}\n  - nested item with **formatting**\n  - nested item with \`code\`\n- closing item\n\n1. ordered first\n2. ordered second`;
        case 3:
          return `> ${label} quoted context\n> with a second line and *emphasis*.\n\n---\n\nFollow-up paragraph after a horizontal rule.`;
        case 4:
          return `Code sample for ${label}:\n\n\`\`\`javascript\nconst html = "<script data-turn=\\"${index + 1}\\">";\nfunction render(value) { return value.replace(/[<&]/g, "_"); }\n\`\`\``;
        case 5:
          return `| Field | Value | Notes |\n|:--|--:|:--|\n| Role | ${role} | row ${index + 1} |\n| Content | A long cell with **Markdown** and special characters & < > | deterministic fixture |`;
        case 6:
          return `${label}\ncontinues on another source line with spaces preserved by the current paragraph contract.\nA final line includes https://example.com as text and [documentation](https://example.com/docs?q=${index + 1}).`;
        default:
          return `${label}: mixed-language saved content שלום / hello / こんにちは 🌍. The remaining sentence provides a stable amount of prose for scaling measurements and DOM text-node creation.`;
      }
    }

    function attachmentsFor(index, role) {
      if (role !== "user" || index % 50 !== 2) return [];
      return [{
        kind: "image",
        thumbnailSrc: PNG_DATA,
        originalSrc: PNG_DATA,
        alt: `Fixture image ${index + 1}`,
        width: 1,
        height: 1,
        captureStatus: "captured",
        source: "benchmark",
        order: 0,
      }];
    }

    function richBodyFor(index, role) {
      const label = escapeHtml(`${role} turn ${index + 1}`);
      const unsafeExercise = index % 31 === 0
        ? `<span onclick="alert(1)">sanitizer attribute exercise</span><a href="javascript:alert(1)">unsafe link</a>`
        : "";
      switch (index % 6) {
        case 0:
          return `<h2>${label}</h2><p>Rich saved content with <strong>bold</strong>, <em>emphasis</em>, <code>inline code</code>, and <a href="https://example.com/rich/${index + 1}">a safe link</a>.</p>${unsafeExercise}`;
        case 1:
          return `<p>${label} contains representative prose and Unicode Δοκιμή مرحبا 🚀.</p><blockquote><p>Preserved quoted context.</p></blockquote>${unsafeExercise}`;
        case 2:
          return `<h3>${label}</h3><ul><li>primary item</li><li>second item<ul><li>nested item</li></ul></li></ul>${unsafeExercise}`;
        case 3:
          return `<pre><code>const html = "&lt;script data-turn=&#34;${index + 1}&#34;&gt;";\nreturn html;</code></pre><p>Code remains inert and readable.</p>${unsafeExercise}`;
        case 4:
          return `<table><thead><tr><th scope="col">Field</th><th scope="col">Value</th></tr></thead><tbody><tr><td>Role</td><td>${escapeHtml(role)}</td></tr><tr><td>Turn</td><td>${index + 1}</td></tr></tbody></table>${unsafeExercise}`;
        default:
          return `<p>${label} uses ordinary safe replay markup.</p><ol><li>first</li><li>second</li></ol><hr><p>Closing paragraph.</p>${unsafeExercise}`;
      }
    }

    function makeSnapshot(turnCount, rich) {
      const messages = [];
      const richTurns = [];
      for (let index = 0; index < turnCount; index += 1) {
        const role = roleFor(index);
        const messageId = `message-${turnCount}-${index + 1}`;
        const turnId = `turn-${turnCount}-${index + 1}`;
        messages.push({
          role,
          text: markdownFor(index, role),
          messageId,
          turnId,
          createTime: 1_700_000_000 + index,
          attachments: attachmentsFor(index, role),
        });
        if (rich) {
          richTurns.push({
            turnIdx: index + 1,
            role,
            messageId,
            turnId,
            createTime: 1_700_000_000 + index,
            outerHTML: `<article data-testid="conversation-turn-${index + 1}" data-turn-id="${turnId}"><div data-message-author-role="${role}" data-message-id="${messageId}">${richBodyFor(index, role)}</div></article>`,
          });
        }
      }
      return {
        snapshotId: `${rich ? "rich" : "canonical"}-${turnCount}`,
        chatId: `benchmark-${turnCount}`,
        metadata: {
          title: `${rich ? "Rich" : "Canonical"} benchmark ${turnCount}`,
          projectId: "renderer-performance",
        },
        messages,
        ...(rich ? { richTurns } : {}),
      };
    }

    function round(value) {
      return Math.round(Number(value) * 1000) / 1000;
    }

    function summarize(values) {
      const sorted = values.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
      const middle = Math.floor(sorted.length / 2);
      const median = sorted.length % 2
        ? sorted[middle]
        : (sorted[middle - 1] + sorted[middle]) / 2;
      return {
        median: round(median),
        min: round(sorted[0]),
        max: round(sorted[sorted.length - 1]),
      };
    }

    function summarizeRows(rows) {
      const output = {};
      for (const key of Object.keys(rows[0] || {})) {
        const values = rows.map((row) => row[key]);
        if (values.every((value) => Number.isFinite(Number(value)))) {
          output[key] = summarize(values);
        }
      }
      return output;
    }

    function maybeGc() {
      try { window.gc?.(); } catch {}
    }

    function clearLifecycleQueues() {
      const lifecycle = window.__h2oRendererBenchLifecycle;
      lifecycle.rafQueue.length = 0;
      lifecycle.timerQueue.length = 0;
      lifecycle.hookCalls.length = 0;
    }

    function resetMountedState() {
      try { host.unmount("benchmark:reset"); } catch {}
      viewReader.replaceChildren();
      refreshBench.clearState();
      clearLifecycleQueues();
    }

    function drainDeferredLifecycle() {
      const lifecycle = window.__h2oRendererBenchLifecycle;
      const rafDurations = [];
      while (lifecycle.rafQueue.length) {
        const entry = lifecycle.rafQueue.shift();
        const start = performance.now();
        entry.callback(performance.now());
        rafDurations.push(performance.now() - start);
      }
      const timerDurations = [];
      while (lifecycle.timerQueue.length) {
        const entry = lifecycle.timerQueue.shift();
        const start = performance.now();
        entry.callback();
        timerDurations.push(performance.now() - start);
      }
      return {
        raf1Ms: rafDurations[0] || 0,
        raf2Ms: rafDurations[1] || 0,
        lateMs: timerDurations.reduce((total, value) => total + value, 0),
        hookCallCount: lifecycle.hookCalls.length,
      };
    }

    function forceLayout() {
      return viewReader.getBoundingClientRect().height;
    }

    function assertRender(result, expectedMode, turnCount) {
      if (result.renderMode !== expectedMode) {
        throw new Error(`Expected ${expectedMode} mode, received ${result.renderMode}`);
      }
      if (result.mountedTurnCount !== turnCount || result.turnsEl.children.length !== turnCount) {
        throw new Error(`Expected ${turnCount} turns, received ${result.mountedTurnCount}`);
      }
    }

    function measureCanonicalOnce(snapshot) {
      resetMountedState();
      maybeGc();

      let start = performance.now();
      const normalized = renderer.normalizeInput(snapshot);
      const normalizeMs = performance.now() - start;

      start = performance.now();
      for (const message of normalized.messages) {
        rendererBench.renderTextAsChatGPTBlocks(message.text);
      }
      const markdownMs = performance.now() - start;

      start = performance.now();
      const rendered = renderer.render(normalized);
      const renderMs = performance.now() - start;
      assertRender(rendered, "canonical", snapshot.messages.length);

      clearLifecycleQueues();
      start = performance.now();
      host.mount({
        readerRoot: rendered.root,
        turnsEl: rendered.turnsEl,
        scrollEl: rendered.scrollEl,
        snapshot,
        assistantTurnEls: rendered.assistantTurnEls,
      });
      const mountMs = performance.now() - start;

      start = performance.now();
      viewReader.replaceChildren(rendered.root);
      forceLayout();
      const insertionMs = performance.now() - start;
      const deferred = drainDeferredLifecycle();
      const nodeCount = rendered.root.querySelectorAll("*").length + 1;

      return {
        normalizeMs,
        markdownMs,
        renderMs,
        insertionMs,
        mountMs,
        deferredRaf1Ms: deferred.raf1Ms,
        deferredRaf2Ms: deferred.raf2Ms,
        deferredLateMs: deferred.lateMs,
        lifecycleHookCalls: deferred.hookCallCount,
        nodeCount,
      };
    }

    function measureRichOnce(snapshot) {
      resetMountedState();
      maybeGc();

      let start = performance.now();
      const normalized = renderer.normalizeInput(snapshot);
      const normalizeMs = performance.now() - start;

      const originalSanitizeHtml = sanitizer.sanitizeHtml;
      let sanitizerMs = 0;
      let sanitizerCalls = 0;
      sanitizer.sanitizeHtml = function measuredSanitizeHtml(value) {
        const sanitizeStart = performance.now();
        try {
          return originalSanitizeHtml.call(this, value);
        } finally {
          sanitizerMs += performance.now() - sanitizeStart;
          sanitizerCalls += 1;
        }
      };

      let rendered;
      start = performance.now();
      try {
        rendered = renderer.render(normalized);
      } finally {
        sanitizer.sanitizeHtml = originalSanitizeHtml;
      }
      const renderMs = performance.now() - start;
      assertRender(rendered, "rich", snapshot.messages.length);

      clearLifecycleQueues();
      start = performance.now();
      host.mount({
        readerRoot: rendered.root,
        turnsEl: rendered.turnsEl,
        scrollEl: rendered.scrollEl,
        snapshot,
        assistantTurnEls: rendered.assistantTurnEls,
      });
      const mountMs = performance.now() - start;

      start = performance.now();
      viewReader.replaceChildren(rendered.root);
      forceLayout();
      const insertionMs = performance.now() - start;
      const deferred = drainDeferredLifecycle();
      const nodeCount = rendered.root.querySelectorAll("*").length + 1;

      return {
        normalizeMs,
        sanitizerMs,
        sanitizerCalls,
        renderMs,
        insertionMs,
        mountMs,
        deferredRaf1Ms: deferred.raf1Ms,
        deferredRaf2Ms: deferred.raf2Ms,
        deferredLateMs: deferred.lateMs,
        lifecycleHookCalls: deferred.hookCallCount,
        nodeCount,
      };
    }

    function installCanonicalSnapshot(snapshot) {
      resetMountedState();
      const normalized = renderer.normalizeInput(snapshot);
      const rendered = renderer.render(normalized);
      host.mount({
        readerRoot: rendered.root,
        turnsEl: rendered.turnsEl,
        scrollEl: rendered.scrollEl,
        snapshot,
        assistantTurnEls: rendered.assistantTurnEls,
      });
      viewReader.replaceChildren(rendered.root);
      forceLayout();
      drainDeferredLifecycle();
      refreshBench.setState(snapshot, refreshBench.collectRendererEditOverrides(normalized), 1);
      return rendered;
    }

    function measureFastCanonicalRefreshOnce(snapshot) {
      installCanonicalSnapshot(snapshot);
      maybeGc();

      const previousSnapshot = refreshBench.getSnapshot();
      const previousEditOverrides = refreshBench.getOverrides();
      const previousRoot = host.getReaderRoot();
      const freshSnapshot = structuredClone(snapshot);

      const totalStart = performance.now();
      const mount = refreshBench.getReusableReaderMount(previousSnapshot);
      let start = performance.now();
      const rendererInput = renderer.normalizeInput(freshSnapshot);
      const normalizeMs = performance.now() - start;
      const nextEditOverrides = refreshBench.collectRendererEditOverrides(rendererInput);
      start = performance.now();
      const eligible = refreshBench.canReuseReaderDOM({
        mount,
        token: 1,
        previousSnapshot,
        rendererInput,
        previousEditOverrides,
        nextEditOverrides,
      });
      const equivalenceGateMs = performance.now() - start;
      if (!eligible) throw new Error("Equivalent connected Reader did not qualify for the fast refresh path");
      if (host.updateSnapshot(freshSnapshot) !== true) {
        throw new Error("Fast refresh could not publish the fresh snapshot to the mounted Studio host");
      }
      refreshBench.setState(freshSnapshot, nextEditOverrides, 1);
      const immediateTotalMs = performance.now() - totalStart;
      if (host.getReaderRoot() !== previousRoot) throw new Error("Fast refresh replaced the mounted Reader root");

      return {
        immediateTotalMs,
        normalizeMs,
        equivalenceGateMs,
        rootPreserved: 1,
      };
    }

    function measureChangedCanonicalRefreshOnce(snapshot) {
      installCanonicalSnapshot(snapshot);
      maybeGc();

      const previousSnapshot = refreshBench.getSnapshot();
      const previousEditOverrides = refreshBench.getOverrides();
      const previousRoot = host.getReaderRoot();
      const changedSnapshot = structuredClone(snapshot);
      const changedIndex = Math.max(0, changedSnapshot.messages.length - 1);
      changedSnapshot.messages[changedIndex].text += "\nChanged refresh content.";

      const totalStart = performance.now();
      const mount = refreshBench.getReusableReaderMount(previousSnapshot);
      const rendererInput = renderer.normalizeInput(changedSnapshot);
      const nextEditOverrides = refreshBench.collectRendererEditOverrides(rendererInput);
      let start = performance.now();
      const eligible = refreshBench.canReuseReaderDOM({
        mount,
        token: 1,
        previousSnapshot,
        rendererInput,
        previousEditOverrides,
        nextEditOverrides,
      });
      const equivalenceGateMs = performance.now() - start;
      if (eligible) throw new Error("Changed canonical content incorrectly qualified for fast refresh");

      host.unmount("benchmark:changed-snapshot-refresh");
      viewReader.replaceChildren();
      clearLifecycleQueues();
      start = performance.now();
      const rendered = renderer.render(rendererInput);
      const renderMs = performance.now() - start;
      assertRender(rendered, "canonical", changedSnapshot.messages.length);
      host.mount({
        readerRoot: rendered.root,
        turnsEl: rendered.turnsEl,
        scrollEl: rendered.scrollEl,
        snapshot: changedSnapshot,
        assistantTurnEls: rendered.assistantTurnEls,
      });
      viewReader.replaceChildren(rendered.root);
      forceLayout();
      refreshBench.setState(changedSnapshot, nextEditOverrides, 1);
      const immediateTotalMs = performance.now() - totalStart;
      drainDeferredLifecycle();
      if (previousRoot?.isConnected) throw new Error("Changed refresh left the previous Reader root connected");

      return {
        immediateTotalMs,
        equivalenceGateMs,
        renderMs,
        rootReplaced: 1,
      };
    }

    function measureCanonicalRefreshOnce(snapshot) {
      installCanonicalSnapshot(snapshot);
      maybeGc();

      const totalStart = performance.now();
      let start = performance.now();
      host.unmount("benchmark:same-snapshot-refresh");
      viewReader.replaceChildren();
      const teardownMs = performance.now() - start;

      start = performance.now();
      const normalized = renderer.normalizeInput(snapshot);
      const normalizeMs = performance.now() - start;

      start = performance.now();
      const rendered = renderer.render(normalized);
      const renderMs = performance.now() - start;
      assertRender(rendered, "canonical", snapshot.messages.length);

      clearLifecycleQueues();
      start = performance.now();
      host.mount({
        readerRoot: rendered.root,
        turnsEl: rendered.turnsEl,
        scrollEl: rendered.scrollEl,
        snapshot,
        assistantTurnEls: rendered.assistantTurnEls,
      });
      const mountMs = performance.now() - start;

      start = performance.now();
      viewReader.replaceChildren(rendered.root);
      forceLayout();
      const replacementMs = performance.now() - start;
      const immediateTotalMs = performance.now() - totalStart;
      const deferred = drainDeferredLifecycle();

      return {
        immediateTotalMs,
        teardownMs,
        normalizeMs,
        renderMs,
        mountMs,
        replacementMs,
        deferredTotalMs: deferred.raf1Ms + deferred.raf2Ms + deferred.lateMs,
      };
    }

    function fixtureBytes(snapshot) {
      return new TextEncoder().encode(JSON.stringify(snapshot)).length;
    }

    const results = [];
    for (const turns of benchmarkConfig.sizes) {
      const canonicalSnapshot = makeSnapshot(turns, false);
      const richSnapshot = makeSnapshot(turns, true);

      for (let index = 0; index < benchmarkConfig.warmups; index += 1) {
        measureCanonicalOnce(canonicalSnapshot);
        measureRichOnce(richSnapshot);
        measureCanonicalRefreshOnce(canonicalSnapshot);
        measureFastCanonicalRefreshOnce(canonicalSnapshot);
        measureChangedCanonicalRefreshOnce(canonicalSnapshot);
      }

      const canonicalRows = [];
      const richRows = [];
      const refreshRows = [];
      const fastRefreshRows = [];
      const changedRefreshRows = [];
      for (let index = 0; index < benchmarkConfig.samples; index += 1) {
        canonicalRows.push(measureCanonicalOnce(canonicalSnapshot));
        richRows.push(measureRichOnce(richSnapshot));
        refreshRows.push(measureCanonicalRefreshOnce(canonicalSnapshot));
        fastRefreshRows.push(measureFastCanonicalRefreshOnce(canonicalSnapshot));
        changedRefreshRows.push(measureChangedCanonicalRefreshOnce(canonicalSnapshot));
      }

      const canonical = summarizeRows(canonicalRows);
      const rich = summarizeRows(richRows);
      const refresh = summarizeRows(refreshRows);
      const fastRefresh = summarizeRows(fastRefreshRows);
      const changedRefresh = summarizeRows(changedRefreshRows);
      results.push({
        turns,
        fixtureBytes: {
          canonical: fixtureBytes(canonicalSnapshot),
          rich: fixtureBytes(richSnapshot),
        },
        canonical,
        rich,
        refresh,
        fastRefresh,
        changedRefresh,
        derived: {
          canonicalDomConstructionResidualMs: round(canonical.renderMs.median - canonical.markdownMs.median),
          richParseCleanupDomResidualMs: round(rich.renderMs.median - rich.sanitizerMs.median),
        },
      });
    }

    resetMountedState();
    return {
      generatedAt: new Date().toISOString(),
      environment: {
        userAgent: navigator.userAgent,
        platform: navigator.platform,
        hardwareConcurrency: navigator.hardwareConcurrency,
        viewport: { width: window.innerWidth, height: window.innerHeight },
        cssLoaded: true,
        downstreamHooks: "no-op attribution hooks",
      },
      methodology: {
        sizes: benchmarkConfig.sizes,
        warmups: benchmarkConfig.warmups,
        samples: benchmarkConfig.samples,
        statistic: "median with min/max",
        fixture: "deterministic mixed-role saved-chat content with paragraphs, Markdown, lists, code, tables, links, Unicode, and sparse image attachments",
        insertion: "replaceChildren plus forced layout with Studio CSS loaded",
        refresh: "T14 full-rebuild baseline plus T15 exact-equivalence fast refresh and changed-content full fallback, all excluding archive retrieval",
      },
      results,
    };
  }, config);

  result.environment.browserExecutable = chromiumExecutable;

  if (pageErrors.length) {
    result.pageErrors = pageErrors;
  }
  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser.close();
}
