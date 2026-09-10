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

function parsePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const config = {
  canonicalTurns: parsePositiveInteger(process.env.H2O_RENDERER_MEMORY_CANONICAL_TURNS, 2000),
  richTurns: parsePositiveInteger(process.env.H2O_RENDERER_MEMORY_RICH_TURNS, 1000),
  cycles: parsePositiveInteger(process.env.H2O_RENDERER_MEMORY_CYCLES, 12),
  batchSize: parsePositiveInteger(process.env.H2O_RENDERER_MEMORY_BATCH_SIZE, 2),
  warmups: parsePositiveInteger(process.env.H2O_RENDERER_MEMORY_WARMUPS, 2),
  fastRefreshCycles: parsePositiveInteger(process.env.H2O_RENDERER_MEMORY_FAST_CYCLES, 30),
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
  throw new Error("No installed Chromium/Chrome executable is available for the Renderer memory benchmark");
}

function roundMiB(bytes) {
  return Math.round((Number(bytes || 0) / (1024 * 1024)) * 1000) / 1000;
}

const executablePath = await resolveChromiumExecutable();
const browser = await chromium.launch({
  headless: true,
  executablePath,
  args: [
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-default-apps",
    "--enable-precise-memory-info",
    "--js-flags=--expose-gc",
  ],
});

try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const client = await page.context().newCDPSession(page);
  await Promise.all([
    client.send("Runtime.enable"),
    client.send("Performance.enable"),
    client.send("HeapProfiler.enable"),
  ]);

  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(String(error?.stack || error)));
  await page.setContent(`<!doctype html>
    <html>
      <head><meta charset="utf-8"><title>Studio Renderer memory benchmark</title></head>
      <body><main id="viewReader"></main></body>
    </html>`);
  await page.addStyleTag({ path: files.css });
  await page.addScriptTag({ path: files.selectors });
  await page.addScriptTag({ path: files.sanitizer });
  // M03 P1 S1A T1: rich replay consumes Renderer sanitizer v2.
  await page.addScriptTag({ path: files.sanitizerPolicyV2 });
  await page.addScriptTag({ path: files.sanitizerEngineV2 });
  await page.addScriptTag({ path: files.sanitizerV2 });
  await page.addScriptTag({ path: files.renderer });

  await page.evaluate(() => {
    const queues = { raf: [], timers: [], nextId: 1 };
    window.__h2oMemoryQueues = queues;
    window.requestAnimationFrame = (callback) => {
      const id = queues.nextId++;
      queues.raf.push({ id, callback });
      return id;
    };
    window.cancelAnimationFrame = (id) => {
      queues.raf = queues.raf.filter((entry) => entry.id !== id);
    };
    window.setTimeout = (callback, delay = 0, ...args) => {
      const id = queues.nextId++;
      queues.timers.push({ id, callback: () => callback(...args), delay: Number(delay) });
      return id;
    };
    window.clearTimeout = (id) => {
      queues.timers = queues.timers.filter((entry) => entry.id !== id);
    };

    window.H2O = window.H2O || {};
    window.H2O.obs = {
      ensureRoot() {},
      markDirty() {},
      flush() {},
      withSuppressed(_reason, callback) { if (typeof callback === "function") callback(); },
    };
    window.H2O.index = { refresh() {} };
  });
  await page.addScriptTag({ path: files.host });

  const studioSource = await fs.readFile(files.studio, "utf8");
  const studioFunctions = [
    "studioHostUnmount",
    "getStudioChatRenderer",
    "isCurrentReaderRoot",
    "getReusableReaderMount",
    "isReusableReaderMountCurrent",
    "collectRendererEditOverrides",
    "haveEquivalentRendererEditOverrides",
    "canReuseReaderDOM",
    "refreshReaderOverlay",
    "buildReaderDOM",
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
    function syncReaderTopOffset(){}
    function __inlineRender_apply(){}
    function __mountOverlayEditorOnTurn(){}
    ${studioFunctions}
    window.__h2oMemoryStudio = {
      state,
      studioHostUnmount,
      getReusableReaderMount,
      collectRendererEditOverrides,
      canReuseReaderDOM,
      refreshReaderOverlay,
      buildReaderDOM,
    };
  ` });

  await page.evaluate(() => {
    "use strict";

    const studio = window.__h2oMemoryStudio;
    const renderer = window.H2O.Studio.chatRenderer;
    const host = window.H2O.studioHost;
    const viewReader = document.getElementById("viewReader");
    const probes = [];
    let fixtureSequence = 0;
    let pendingOverlayResolve = null;

    function roleFor(index) {
      if (index % 47 === 0) return "system";
      if (index % 43 === 0) return "tool";
      return index % 2 === 0 ? "user" : "assistant";
    }

    function canonicalText(index, role, variant) {
      switch (index % 5) {
        case 0:
          return `# ${role} ${index + 1}\n\nRepresentative paragraph ${variant} with **bold**, *italic*, Unicode مرحبا 🚀, and a [link](https://example.com/${index + 1}).`;
        case 1:
          return `- item ${index + 1}\n  - nested item\n  - nested **formatting**\n\n1. first\n2. second`;
        case 2:
          return `\`\`\`javascript\nconst value = "<script data-index=\\"${index}\\">";\nreturn value;\n\`\`\``;
        case 3:
          return `| Field | Value |\n|:--|--:|\n| Role | ${role} |\n| Variant | ${variant} |`;
        default:
          return `> quoted context ${index + 1}\n\nOrdinary saved-chat prose ${variant} remains deterministic across cycles.`;
      }
    }

    function richHtml(index, role, variant, turnId, messageId) {
      const body = index % 3 === 0
        ? `<h2>${role} ${index + 1}</h2><p>Rich ${variant} with <strong>formatting</strong>.</p>`
        : index % 3 === 1
          ? `<ul><li>Rich item ${index + 1}</li><li>${variant}</li></ul>`
          : `<pre><code>const value = &quot;&lt;rich-${index}&gt;&quot;;</code></pre>`;
      return `<article data-testid="conversation-turn-${index + 1}" data-turn-id="${turnId}"><div data-message-author-role="${role}" data-message-id="${messageId}">${body}</div></article>`;
    }

    function makeSnapshot(turnCount, options = {}) {
      fixtureSequence += 1;
      const variant = String(options.variant ?? fixtureSequence);
      const snapshotId = String(options.snapshotId || `${options.rich ? "rich" : "canonical"}-${variant}`);
      const chatId = String(options.chatId || `chat-${snapshotId}`);
      const messages = [];
      const richTurns = [];
      for (let index = 0; index < turnCount; index += 1) {
        const role = roleFor(index);
        const turnId = `turn-${variant}-${index + 1}`;
        const messageId = `message-${variant}-${index + 1}`;
        messages.push({
          role,
          text: canonicalText(index, role, variant),
          turnId,
          messageId,
          createTime: 1_700_000_000 + index,
        });
        if (options.rich) {
          richTurns.push({
            turnIdx: index + 1,
            role,
            turnId,
            messageId,
            createTime: 1_700_000_000 + index,
            outerHTML: richHtml(index, role, variant, turnId, messageId),
          });
        }
      }
      return {
        snapshotId,
        chatId,
        metadata: { title: `Memory ${variant}`, projectId: "renderer-memory" },
        messages,
        ...(options.rich ? { richTurns } : {}),
      };
    }

    function track(kind, value, label = "") {
      if (value && (typeof value === "object" || typeof value === "function")) {
        probes.push({ kind, label, ref: new WeakRef(value) });
      }
    }

    function resetProbes() {
      probes.length = 0;
    }

    function probeSummary() {
      const summary = {};
      for (const probe of probes) {
        const row = summary[probe.kind] || (summary[probe.kind] = { total: 0, alive: 0, labels: [] });
        row.total += 1;
        if (probe.ref.deref()) {
          row.alive += 1;
          if (row.labels.length < 8) row.labels.push(probe.label);
        }
      }
      return summary;
    }

    function drainQueues() {
      const queues = window.__h2oMemoryQueues;
      let guard = 0;
      while ((queues.raf.length || queues.timers.length) && guard < 1000) {
        while (queues.raf.length) {
          const entry = queues.raf.shift();
          entry.callback(performance.now());
        }
        while (queues.timers.length) {
          const entry = queues.timers.shift();
          entry.callback();
        }
        guard += 1;
      }
      if (guard >= 1000) throw new Error("Lifecycle queues did not settle");
    }

    function teardown(trackCurrent = false) {
      if (trackCurrent) {
        track("root", host.getReaderRoot(), "teardown-root");
        track("snapshot", studio.state.currentReaderSnapshot, "teardown-snapshot");
      }
      studio.state.currentReaderSnapshot = null;
      studio.studioHostUnmount("memory:teardown");
      viewReader.replaceChildren();
      drainQueues();
    }

    function installSnapshot(snapshot) {
      const previousRoot = host.getReaderRoot();
      const previousSnapshot = studio.state.currentReaderSnapshot;
      if (previousRoot) track("root", previousRoot, "replaced-root");
      if (previousSnapshot) track("snapshot", previousSnapshot, "replaced-snapshot");
      studio.state.currentReaderSnapshot = null;
      studio.studioHostUnmount("memory:replace");
      viewReader.replaceChildren();
      const input = renderer.normalizeInput(snapshot);
      const overrides = studio.collectRendererEditOverrides(input);
      studio.state.currentReaderSnapshot = snapshot;
      const root = studio.buildReaderDOM(snapshot, input);
      viewReader.replaceChildren(root);
      studio.state.currentReaderEditOverrides = overrides;
      drainQueues();
      return root;
    }

    function installHostOnly(snapshot) {
      teardown(false);
      const input = renderer.normalizeInput(snapshot);
      const result = renderer.render(input);
      host.mount({
        readerRoot: result.root,
        turnsEl: result.turnsEl,
        scrollEl: result.scrollEl,
        snapshot,
        assistantTurnEls: result.assistantTurnEls,
      });
      viewReader.replaceChildren(result.root);
      studio.state.currentReaderSnapshot = snapshot;
      studio.state.currentReaderEditOverrides = [];
      drainQueues();
      return result.root;
    }

    function fastRefresh(snapshot) {
      const previousSnapshot = studio.state.currentReaderSnapshot;
      const previousOverrides = studio.state.currentReaderEditOverrides;
      const mount = studio.getReusableReaderMount(previousSnapshot);
      const input = renderer.normalizeInput(snapshot);
      const nextOverrides = studio.collectRendererEditOverrides(input);
      const eligible = studio.canReuseReaderDOM({
        mount,
        token: studio.state.renderToken,
        previousSnapshot,
        rendererInput: input,
        previousEditOverrides: previousOverrides,
        nextEditOverrides: nextOverrides,
      });
      if (!eligible) throw new Error("Equivalent snapshot did not qualify for memory fast-refresh scenario");
      track("snapshot", previousSnapshot, "fast-refresh-snapshot");
      studio.state.currentReaderSnapshot = snapshot;
      studio.state.currentReaderEditOverrides = nextOverrides;
      if (host.updateSnapshot(snapshot) !== true) {
        throw new Error("Fast refresh could not publish the fresh snapshot to the mounted Studio host");
      }
      drainQueues();
      return mount.root;
    }

    function replacementBatch({ turns, rich = false, count, sameId = false }) {
      for (let index = 0; index < count; index += 1) {
        const variant = `replacement-${rich ? "rich" : "canonical"}-${fixtureSequence + 1}`;
        installSnapshot(makeSnapshot(turns, {
          rich,
          variant,
          snapshotId: sameId ? "same-id" : `${rich ? "rich" : "canonical"}-${index % 2 ? "B" : "A"}`,
          chatId: sameId ? "same-chat" : `chat-${index % 2 ? "B" : "A"}`,
        }));
      }
    }

    function leaveReturnBatch({ turns, count }) {
      for (let index = 0; index < count; index += 1) {
        installSnapshot(makeSnapshot(turns, { variant: `leave-${fixtureSequence + 1}`, snapshotId: "leave-A", chatId: "leave-chat" }));
        teardown(true);
      }
    }

    function fastRefreshBatch({ turns, count }) {
      if (!host.getReaderRoot()) {
        installSnapshot(makeSnapshot(turns, { variant: "fast-equivalent", snapshotId: "fast-A", chatId: "fast-chat" }));
      }
      for (let index = 0; index < count; index += 1) {
        const fresh = structuredClone(studio.state.currentReaderSnapshot);
        fastRefresh(fresh);
      }
    }

    function hostOnlyPublishFresh({ turns }) {
      const initial = makeSnapshot(turns, { variant: "host-only", snapshotId: "host-only", chatId: "host-only-chat" });
      installHostOnly(initial);
      track("hostSnapshot", initial, "host-before-refresh");
      const fresh = structuredClone(initial);
      studio.state.currentReaderSnapshot = fresh;
      if (host.updateSnapshot(fresh) !== true) throw new Error("Host snapshot diagnostic could not publish");
      return true;
    }

    function listenerOnlyPublishFresh({ turns }) {
      const initial = makeSnapshot(turns, { variant: "listener-only", snapshotId: "listener-only", chatId: "listener-chat" });
      installSnapshot(initial);
      track("listenerSnapshot", initial, "listener-before-refresh");
      const fresh = structuredClone(initial);
      studio.state.currentReaderSnapshot = fresh;
      studio.state.currentReaderEditOverrides = [];
      if (host.updateSnapshot(fresh) !== true) throw new Error("Listener snapshot diagnostic could not publish");
      host.unmount("memory:listener-diagnostic");
      drainQueues();
      return true;
    }

    function removeListenerDiagnosticRoot() {
      viewReader.replaceChildren();
      drainQueues();
    }

    function beginPendingOverlay({ turns }) {
      let resolvePending;
      const promise = new Promise((resolve) => { resolvePending = resolve; });
      pendingOverlayResolve = resolvePending;
      window.H2O.Studio.store = { editOverlay: { get: () => promise } };
      window.H2O.Studio.overlay = { applyOverlay() {} };
      const snapshot = makeSnapshot(turns, { variant: "pending-overlay", snapshotId: "overlay-A", chatId: "overlay-chat" });
      installSnapshot(snapshot);
      track("asyncRoot", host.getReaderRoot(), "pending-overlay-root");
      track("asyncSnapshot", snapshot, "pending-overlay-snapshot");
      window.H2O.Studio.store = null;
      window.H2O.Studio.overlay = null;
      teardown(false);
    }

    async function resolvePendingOverlay() {
      pendingOverlayResolve?.(null);
      pendingOverlayResolve = null;
      await Promise.resolve();
      await Promise.resolve();
      drainQueues();
    }

    window.__h2oRendererMemory = {
      resetProbes,
      probeSummary,
      drainQueues,
      teardown,
      replacementBatch,
      leaveReturnBatch,
      fastRefreshBatch,
      hostOnlyPublishFresh,
      listenerOnlyPublishFresh,
      removeListenerDiagnosticRoot,
      beginPendingOverlay,
      resolvePendingOverlay,
      current: () => ({
        root: !!host.getReaderRoot(),
        turns: host.getTurnsRoot()?.children.length || 0,
        snapshotId: studio.state.currentReaderSnapshot?.snapshotId || "",
      }),
    };
  });

  async function collectGarbage() {
    await page.evaluate(() => window.__h2oRendererMemory.drainQueues());
    await page.evaluate(() => Promise.resolve());
    for (let index = 0; index < 3; index += 1) {
      await client.send("HeapProfiler.collectGarbage");
    }
  }

  async function measure(label) {
    await collectGarbage();
    const [heap, dom, metrics, probes, current] = await Promise.all([
      client.send("Runtime.getHeapUsage"),
      client.send("Memory.getDOMCounters"),
      client.send("Performance.getMetrics"),
      page.evaluate(() => window.__h2oRendererMemory.probeSummary()),
      page.evaluate(() => window.__h2oRendererMemory.current()),
    ]);
    const metricMap = Object.fromEntries(metrics.metrics.map((entry) => [entry.name, entry.value]));
    return {
      label,
      usedJSHeapMiB: roundMiB(heap.usedSize),
      embedderHeapMiB: roundMiB(heap.embedderHeapUsedSize),
      backingStorageMiB: roundMiB(heap.backingStorageSize),
      nodes: dom.nodes,
      documents: dom.documents,
      jsEventListeners: dom.jsEventListeners,
      layoutObjects: Math.round(metricMap.LayoutObjects || 0),
      probes,
      current,
    };
  }

  async function resetScenario() {
    await page.evaluate(() => {
      window.__h2oRendererMemory.teardown(false);
      window.__h2oRendererMemory.resetProbes();
    });
    await collectGarbage();
  }

  async function runBatchedScenario(name, method, options, totalCycles, batchSize) {
    await resetScenario();
    for (let index = 0; index < config.warmups; index += 1) {
      await page.evaluate(({ methodName, methodOptions }) => {
        window.__h2oRendererMemory[methodName](methodOptions);
      }, { methodName: method, methodOptions: { ...options, count: 1 } });
    }
    await page.evaluate(() => window.__h2oRendererMemory.resetProbes());
    const trend = [await measure(`${name}:warm`)];
    let completed = 0;
    while (completed < totalCycles) {
      const count = Math.min(batchSize, totalCycles - completed);
      await page.evaluate(({ methodName, methodOptions }) => {
        window.__h2oRendererMemory[methodName](methodOptions);
      }, { methodName: method, methodOptions: { ...options, count } });
      completed += count;
      trend.push(await measure(`${name}:${completed}`));
    }
    await page.evaluate(() => window.__h2oRendererMemory.teardown(true));
    trend.push(await measure(`${name}:settled`));
    return trend;
  }

  const scenarios = {};
  scenarios.canonicalReplacement = await runBatchedScenario(
    "canonical-replacement",
    "replacementBatch",
    { turns: config.canonicalTurns, rich: false },
    config.cycles,
    config.batchSize,
  );
  scenarios.readerLeaveReturn = await runBatchedScenario(
    "reader-leave-return",
    "leaveReturnBatch",
    { turns: config.canonicalTurns },
    config.cycles,
    config.batchSize,
  );
  scenarios.fastRefresh = await runBatchedScenario(
    "fast-refresh",
    "fastRefreshBatch",
    { turns: config.canonicalTurns },
    config.fastRefreshCycles,
    Math.max(config.batchSize, 5),
  );
  scenarios.changedSameId = await runBatchedScenario(
    "changed-same-id",
    "replacementBatch",
    { turns: config.canonicalTurns, rich: false, sameId: true },
    config.cycles,
    config.batchSize,
  );
  scenarios.richReplacement = await runBatchedScenario(
    "rich-replacement",
    "replacementBatch",
    { turns: config.richTurns, rich: true },
    config.cycles,
    config.batchSize,
  );

  await resetScenario();
  await page.evaluate((turns) => window.__h2oRendererMemory.hostOnlyPublishFresh({ turns }), config.canonicalTurns);
  scenarios.hostSnapshotDiagnostic = [await measure("host-snapshot:mounted")];
  await page.evaluate(() => window.__h2oRendererMemory.teardown(false));
  scenarios.hostSnapshotDiagnostic.push(await measure("host-snapshot:unmounted"));

  await resetScenario();
  await page.evaluate((turns) => window.__h2oRendererMemory.listenerOnlyPublishFresh({ turns }), config.canonicalTurns);
  scenarios.listenerSnapshotDiagnostic = [await measure("listener-snapshot:host-unmounted")];
  await page.evaluate(() => window.__h2oRendererMemory.removeListenerDiagnosticRoot());
  scenarios.listenerSnapshotDiagnostic.push(await measure("listener-snapshot:root-removed"));

  await resetScenario();
  await page.evaluate((turns) => window.__h2oRendererMemory.beginPendingOverlay({ turns }), Math.min(1000, config.canonicalTurns));
  scenarios.asyncOverlayDiagnostic = [await measure("async-overlay:pending")];
  await page.evaluate(() => window.__h2oRendererMemory.resolvePendingOverlay());
  scenarios.asyncOverlayDiagnostic.push(await measure("async-overlay:settled"));

  await resetScenario();

  console.log(JSON.stringify({
    generatedAt: new Date().toISOString(),
    environment: {
      browserExecutable: executablePath,
      userAgent: await page.evaluate(() => navigator.userAgent),
      forcedGc: "HeapProfiler.collectGarbage x3 per sample",
      cssLoaded: true,
      downstreamHooks: "no-op attribution hooks",
    },
    methodology: {
      ...config,
      statistic: "post-settlement, post-GC trend sampled after each batch",
      reachability: "WeakRef probes checked only after out-of-job CDP garbage collection",
    },
    scenarios,
    pageErrors,
  }, null, 2));
} finally {
  await browser.close();
}
