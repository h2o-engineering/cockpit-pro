#!/usr/bin/env node

import fs from "node:fs/promises";
import os from "node:os";
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
  studio: path.join(studioRoot, "studio.js"),
  host: path.join(studioRoot, "S0D3e. 🎬 Transcript Studio Host - Studio.js"),
  css: path.join(studioRoot, "studio.css"),
  profileCss: path.join(studioRoot, "renderer/presentation/chatgpt-reference.v1.css"),
};
/* M03 P5 S5C T10: the accepted Renderer chain in production order (studio.html /
 * pack lists). The benchmark loads the real modules; nothing is copied or
 * reimplemented here. */
const RENDERER_CHAIN = Object.freeze([
  "platform/selectors.contract.js",
  "platform/html-sanitizer.js",
  "renderer/safety/sanitizer-policy.v1.js",
  "renderer/safety/vendor/dompurify/purify.js",
  "renderer/safety/html-sanitizer.v2.js",
  "renderer/markdown/vendor/markdown-it/markdown-it.umd.min.js",
  "renderer/markdown/h2o-gfm.v1.js",
  "renderer/markdown/markdown-engine.v1.js",
  "renderer/markdown/markdown-ir-adapter.v1.js",
  "renderer/semantic/render-ir.v1.js",
  "renderer/semantic/semantic-ingress.v1.js",
  "renderer/semantic/semantic-index.v1.js",
  "renderer/decoration/decoration-contribution.v1.js",
  "renderer/presentation/presentation-profile.v1.js",
  "renderer/content/content-renderer.v1.js",
  "renderer/chat-renderer.studio.js",
]);

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
  /* Negative control only (S5C): artificial per-parse busy wait, default 0. */
  slowdownMs: Math.max(0, Number.parseFloat(String(process.env.H2O_RENDERER_BENCH_SLOWDOWN_MS || "0")) || 0),
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
  await page.addStyleTag({ path: files.profileCss });
  for (const rel of RENDERER_CHAIN) {
    await page.addScriptTag({ path: path.join(studioRoot, rel) });
  }

  /* M03 stage-timing seam (benchmark-only). The chat renderer resolves these
   * module entries from H2O.Studio.Renderer on every call, so replacing the
   * namespace entries with timing delegates measures the ACTUAL calls made on
   * the production-faithful path. Every delegate forwards to the frozen real
   * module unchanged; only wall time and call counts are recorded. The stage
   * intervals are disjoint from one another and nested INSIDE render() - they
   * are inclusive within END_TO_END_RENDER and must never be added to it. */
  await page.evaluate((slowdownMs) => {
    const Renderer = window.H2O?.Studio?.Renderer;
    if (!Renderer) throw new Error("Renderer namespace missing after chain load");
    const stages = { parseAdapterMs: 0, parseAdapterCalls: 0, renderIrMs: 0, renderIrCalls: 0, contentRendererMs: 0, contentRendererCalls: 0, semanticIndexMs: 0, semanticIndexCalls: 0, decorationLifecycleMs: 0, decorationLifecycleCalls: 0, sanitizerV2Ms: 0, sanitizerV2Calls: 0, disposeAllCalls: 0 };
    window.__h2oRendererStages = stages;
    const timed = (msKey, callsKey, fn) => function timedDelegate(...args) {
      const start = performance.now();
      try { return fn.apply(this, args); }
      finally { stages[msKey] += performance.now() - start; stages[callsKey] += 1; }
    };
    const wrap = (key, methods) => {
      const original = Renderer[key];
      if (!original) throw new Error(`Renderer.${key} missing after chain load`);
      const delegate = { ...original };
      for (const [method, msKey, callsKey, after] of methods) {
        if (typeof original[method] !== "function") throw new Error(`Renderer.${key}.${method} is not a function`);
        const inner = original[method].bind(original);
        delegate[method] = timed(msKey, callsKey, after ? (...args) => after(inner(...args)) : inner);
      }
      Renderer[key] = Object.freeze(delegate);
    };
    /* Negative-control seam (H2O_RENDERER_BENCH_SLOWDOWN_MS > 0 only): an
     * artificial per-parse busy wait on the ACTUAL pipeline so a budget
     * comparator can be proven to fire on a real measured slowdown. */
    const slowdown = slowdownMs > 0
      ? (result) => { const until = performance.now() + slowdownMs; while (performance.now() < until) { /* busy */ } return result; }
      : null;
    wrap("markdownIrAdapter", [["markdownToBlocks", "parseAdapterMs", "parseAdapterCalls", slowdown]]);
    wrap("renderIR", [["createConversation", "renderIrMs", "renderIrCalls"], ["validate", "renderIrMs", "renderIrCalls"]]);
    wrap("contentRenderer", [["renderBlocks", "contentRendererMs", "contentRendererCalls"]]);
    wrap("semanticIndex", [["createShellIndex", "semanticIndexMs", "semanticIndexCalls"]]);
    wrap("decorationContribution", [["createLifecycle", "decorationLifecycleMs", "decorationLifecycleCalls", (controller) => Object.freeze({
      ...controller,
      disposeAll(...args) { stages.disposeAllCalls += 1; return controller.disposeAll(...args); },
    })]]);
    /* NB-1 resolution: the rich path consumes sanitizer v2 (sanitizeToFragment); the
     * sub-metric now instruments that seam instead of the retired v1 seam. */
    wrap("htmlSanitizer", [["sanitizeToFragment", "sanitizerV2Ms", "sanitizerV2Calls"]]);
    window.__h2oResetRendererStages = () => { for (const key of Object.keys(stages)) stages[key] = 0; };
    window.__h2oReadRendererStages = () => ({ ...stages });
  }, config.slowdownMs);

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
    /* M03 S4C: the Reader current-render bridge and its unmount seam are part of
     * the production refresh/teardown path (bind on build, disposeAll + clear
     * on discard). Extracted verbatim so the benchmark exercises them. */
    "bindReaderSemanticIndex",
    "getReaderSemanticIndex",
    "getReaderDecorationContributions",
    "disposeReaderRenderDecorations",
    "studioHostUnmount",
  ].map((name) => extractFunction(studioSource, name)).join("\n");
  await page.addScriptTag({ content: `
    const W = window;
    const $ = (selector) => document.querySelector(selector);
    const state = {
      currentReaderSnapshot: null,
      currentReaderEditOverrides: null,
      currentReaderRender: null,
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
      getCurrentRender(){ return state.currentReaderRender; },
      bind(rendererResult){ bindReaderSemanticIndex(rendererResult); },
      unmount(reason){ studioHostUnmount(reason); },
      getReusableReaderMount,
      collectRendererEditOverrides,
      canReuseReaderDOM,
    };
  ` });

  const result = await page.evaluate(async (benchmarkConfig) => {
    "use strict";

    const renderer = window.H2O?.Studio?.chatRenderer;
    const host = window.H2O?.studioHost;
    const refreshBench = window.__h2oStudioRefreshBenchmark;
    const resetStages = window.__h2oResetRendererStages;
    const readStages = window.__h2oReadRendererStages;
    const viewReader = document.getElementById("viewReader");
    const Renderer = window.H2O?.Studio?.Renderer;
    if (!renderer || !host || !refreshBench || !resetStages || !readStages || !viewReader || !Renderer?.semanticIndex || !Renderer?.decorationContribution) {
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
      try { refreshBench.unmount("benchmark:reset"); } catch {}
      viewReader.replaceChildren();
      refreshBench.clearState();
      clearLifecycleQueues();
    }

    /* Mount exactly the way buildReaderDOM + renderReader do: bind the render's
     * Semantic Index / DecorationContribution lifecycle, then publish to the host. */
    function mountRendered(rendered, snapshot) {
      refreshBench.bind(rendered);
      host.mount({
        readerRoot: rendered.root,
        turnsEl: rendered.turnsEl,
        scrollEl: rendered.scrollEl,
        snapshot,
        assistantTurnEls: rendered.assistantTurnEls,
      });
    }

    function assertBound(rendered) {
      const current = refreshBench.getCurrentRender();
      if (!current || current.root !== rendered.root || current.semanticIndex !== rendered.semanticIndex || current.decorationContributions !== rendered.decorationContributions) {
        throw new Error("Reader current-render bridge is not bound to the mounted render");
      }
      if (rendered.decorationContributions.list().length !== 0) throw new Error("benchmark render carries unexpected decoration contributions");
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

      resetStages();
      start = performance.now();
      const rendered = renderer.render(normalized);
      const renderMs = performance.now() - start;
      const stages = readStages();
      assertRender(rendered, "canonical", snapshot.messages.length);
      if (stages.semanticIndexCalls !== 1 || stages.decorationLifecycleCalls !== 1) {
        throw new Error(`Expected one Semantic Index build and one decoration lifecycle per render, received ${stages.semanticIndexCalls}/${stages.decorationLifecycleCalls}`);
      }
      if (stages.parseAdapterCalls !== snapshot.messages.length) {
        throw new Error(`Expected ${snapshot.messages.length} adapter parses on the canonical path, received ${stages.parseAdapterCalls}`);
      }

      clearLifecycleQueues();
      start = performance.now();
      mountRendered(rendered, snapshot);
      const mountMs = performance.now() - start;
      assertBound(rendered);

      start = performance.now();
      viewReader.replaceChildren(rendered.root);
      forceLayout();
      const insertionMs = performance.now() - start;
      const deferred = drainDeferredLifecycle();
      const nodeCount = rendered.root.querySelectorAll("*").length + 1;
      const indexed = rendered.semanticIndex;

      return {
        normalizeMs,
        parseAdapterMs: stages.parseAdapterMs,
        parseAdapterCalls: stages.parseAdapterCalls,
        renderIrMs: stages.renderIrMs,
        renderIrCalls: stages.renderIrCalls,
        contentRendererMs: stages.contentRendererMs,
        contentRendererCalls: stages.contentRendererCalls,
        semanticIndexMs: stages.semanticIndexMs,
        decorationLifecycleMs: stages.decorationLifecycleMs,
        shellCompositionResidualMs: renderMs - (stages.parseAdapterMs + stages.renderIrMs + stages.contentRendererMs + stages.semanticIndexMs + stages.decorationLifecycleMs),
        renderMs,
        insertionMs,
        mountMs,
        deferredRaf1Ms: deferred.raf1Ms,
        deferredRaf2Ms: deferred.raf2Ms,
        deferredLateMs: deferred.lateMs,
        lifecycleHookCalls: deferred.hookCallCount,
        nodeCount,
        indexedMessages: indexed.messages().length,
        indexedBlocks: indexed.blocks().length,
        indexedTexts: indexed.texts().length,
      };
    }

    function measureRichOnce(snapshot) {
      resetMountedState();
      maybeGc();

      let start = performance.now();
      const normalized = renderer.normalizeInput(snapshot);
      const normalizeMs = performance.now() - start;

      resetStages();
      start = performance.now();
      const rendered = renderer.render(normalized);
      const renderMs = performance.now() - start;
      const stages = readStages();
      assertRender(rendered, "rich", snapshot.messages.length);
      if (stages.sanitizerV2Calls !== snapshot.messages.length) {
        throw new Error(`Expected ${snapshot.messages.length} sanitizer v2 fragments on the rich path, received ${stages.sanitizerV2Calls}`);
      }
      if (stages.semanticIndexCalls !== 1) throw new Error("Expected one Semantic Index build per rich render");

      clearLifecycleQueues();
      start = performance.now();
      mountRendered(rendered, snapshot);
      const mountMs = performance.now() - start;
      assertBound(rendered);

      start = performance.now();
      viewReader.replaceChildren(rendered.root);
      forceLayout();
      const insertionMs = performance.now() - start;
      const deferred = drainDeferredLifecycle();
      const nodeCount = rendered.root.querySelectorAll("*").length + 1;

      return {
        normalizeMs,
        sanitizerMs: stages.sanitizerV2Ms,
        sanitizerCalls: stages.sanitizerV2Calls,
        semanticIndexMs: stages.semanticIndexMs,
        decorationLifecycleMs: stages.decorationLifecycleMs,
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
      mountRendered(rendered, snapshot);
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
      const previousRender = refreshBench.getCurrentRender();
      const freshSnapshot = structuredClone(snapshot);
      resetStages();

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
      const stages = readStages();
      if (host.getReaderRoot() !== previousRoot) throw new Error("Fast refresh replaced the mounted Reader root");
      /* Exact-equivalence reuse is a behavioral invariant: no Renderer rebuild, no
       * new Semantic Index, no new decoration lifecycle, no disposal. */
      if (stages.semanticIndexCalls !== 0 || stages.decorationLifecycleCalls !== 0 || stages.parseAdapterCalls !== 0 || stages.disposeAllCalls !== 0) {
        throw new Error(`Fast refresh performed render work: index=${stages.semanticIndexCalls} lifecycle=${stages.decorationLifecycleCalls} parse=${stages.parseAdapterCalls} disposeAll=${stages.disposeAllCalls}`);
      }
      const currentRender = refreshBench.getCurrentRender();
      if (!currentRender || currentRender !== previousRender || currentRender.semanticIndex !== previousRender.semanticIndex) {
        throw new Error("Fast refresh replaced the bound current-render Semantic Index / lifecycle");
      }

      return {
        immediateTotalMs,
        normalizeMs,
        equivalenceGateMs,
        rootPreserved: 1,
        fullRenderAvoided: 1,
        indexBuilds: stages.semanticIndexCalls,
        lifecycleBuilds: stages.decorationLifecycleCalls,
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

      const previousRender = refreshBench.getCurrentRender();
      resetStages();
      refreshBench.unmount("benchmark:changed-snapshot-refresh");
      viewReader.replaceChildren();
      clearLifecycleQueues();
      start = performance.now();
      const rendered = renderer.render(rendererInput);
      const renderMs = performance.now() - start;
      assertRender(rendered, "canonical", changedSnapshot.messages.length);
      mountRendered(rendered, changedSnapshot);
      viewReader.replaceChildren(rendered.root);
      forceLayout();
      refreshBench.setState(changedSnapshot, nextEditOverrides, 1);
      const immediateTotalMs = performance.now() - totalStart;
      const stages = readStages();
      drainDeferredLifecycle();
      if (previousRoot?.isConnected) throw new Error("Changed refresh left the previous Reader root connected");
      if (stages.disposeAllCalls !== 1) throw new Error(`Changed refresh must dispose the previous decoration lifecycle exactly once (received ${stages.disposeAllCalls})`);
      if (stages.semanticIndexCalls !== 1 || stages.decorationLifecycleCalls !== 1) throw new Error("Changed refresh must build exactly one new Semantic Index and lifecycle");
      const currentRender = refreshBench.getCurrentRender();
      if (!currentRender || currentRender === previousRender || currentRender.root !== rendered.root) throw new Error("Changed refresh did not rebind the new render");

      return {
        immediateTotalMs,
        equivalenceGateMs,
        renderMs,
        rootReplaced: 1,
        fullRenderPerformed: 1,
        indexBuilds: stages.semanticIndexCalls,
        previousLifecycleDisposed: stages.disposeAllCalls,
      };
    }

    function measureCanonicalRefreshOnce(snapshot) {
      installCanonicalSnapshot(snapshot);
      maybeGc();

      const totalStart = performance.now();
      let start = performance.now();
      refreshBench.unmount("benchmark:same-snapshot-refresh");
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
      mountRendered(rendered, snapshot);
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
          canonicalShellCompositionResidualMs: round(canonical.shellCompositionResidualMs.median),
          richSanitizerShareOfRenderMs: round(rich.sanitizerMs.median),
          richNonSanitizerResidualMs: round(rich.renderMs.median - rich.sanitizerMs.median),
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
        slowdownMs: benchmarkConfig.slowdownMs,
        statistic: "median with min/max",
        fixture: "deterministic mixed-role saved-chat content with paragraphs, Markdown, lists, code, tables, links, Unicode, and sparse image attachments",
        insertion: "replaceChildren plus forced layout with Studio CSS + reference profile CSS loaded",
        refresh: "T14 full-rebuild baseline plus T15 exact-equivalence fast refresh and changed-content full fallback through the S4C Reader bridge/unmount seam, all excluding archive retrieval",
        chain: "accepted M03 Renderer chain in production order (sanitizer policy/engine/v2, markdown-it, H2O GFM, markdown engine, IR adapter, Render IR, semantic ingress, Semantic Index, DecorationContribution, PresentationProfile, ContentRenderer, chat renderer)",
        stages: {
          NORMALIZE: { metric: "normalizeMs", measurementKind: "ISOLATED_STAGE", additivity: "EXCLUSIVE", note: "renderer.normalizeInput() called before render(), exactly as renderReader does" },
          PARSE_ADAPTER: { metric: "parseAdapterMs", measurementKind: "ACTUAL_PIPELINE", additivity: "INCLUSIVE_WITHIN_END_TO_END", note: "markdownIrAdapter.markdownToBlocks calls made by renderSemanticBody during render()" },
          RENDER_IR: { metric: "renderIrMs", measurementKind: "ACTUAL_PIPELINE", additivity: "INCLUSIVE_WITHIN_END_TO_END", note: "renderIR.createConversation + validate calls during render()" },
          RENDERER_PROFILE: { metric: "contentRendererMs", measurementKind: "ACTUAL_PIPELINE", additivity: "INCLUSIVE_WITHIN_END_TO_END", note: "contentRenderer.renderBlocks (content DOM through PresentationProfile hooks); shell composition is only measurable inside END_TO_END (shellCompositionResidualMs = renderMs minus the measured stages) without Product instrumentation" },
          SEMANTIC_INDEX: { metric: "semanticIndexMs", measurementKind: "ACTUAL_PIPELINE", additivity: "INCLUSIVE_WITHIN_END_TO_END", note: "semanticIndex.createShellIndex during render()" },
          DECORATION_LIFECYCLE: { metric: "decorationLifecycleMs", measurementKind: "ACTUAL_PIPELINE", additivity: "INCLUSIVE_WITHIN_END_TO_END", note: "decorationContribution.createLifecycle during render()" },
          SANITIZER_V2: { metric: "rich.sanitizerMs", measurementKind: "ACTUAL_PIPELINE", additivity: "INCLUSIVE_WITHIN_END_TO_END", note: "htmlSanitizer.sanitizeToFragment on the rich replay path (replaces the retired v1 seam; NB-1)" },
          END_TO_END_RENDER: { metric: "renderMs", measurementKind: "ACTUAL_PIPELINE", additivity: "NON_ADDITIVE", note: "chatRenderer.render() wall time; the stage intervals above are disjoint sub-intervals of it" },
          EXACT_EQUIVALENCE_REFRESH: { metric: "fastRefresh.immediateTotalMs", measurementKind: "ACTUAL_PIPELINE", additivity: "NON_ADDITIVE", note: "normalize + canReuseReaderDOM gate + host.updateSnapshot with the mounted root, index and lifecycle preserved (0 index builds, 0 disposals)" },
          CHANGED_CONTENT_REFRESH: { metric: "changedRefresh.immediateTotalMs", measurementKind: "ACTUAL_PIPELINE", additivity: "NON_ADDITIVE", note: "gate rejection + studioHostUnmount (disposeAll) + full render + bind + mount + insertion" },
        },
      },
      results,
    };
  }, config);

  result.environment.browserExecutable = chromiumExecutable;
  result.environment.browserFamily = "chromium";
  result.environment.browserVersion = browser.version();
  result.environment.playwrightVersion = (() => { try { return require("playwright/package.json").version; } catch { return null; } })();
  result.environment.nodePlatform = process.platform;
  result.environment.arch = process.arch;
  result.environment.osRelease = os.release();
  result.environment.osMajor = String(os.release()).split(".")[0];

  if (pageErrors.length) {
    result.pageErrors = pageErrors;
  }
  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser.close();
}
