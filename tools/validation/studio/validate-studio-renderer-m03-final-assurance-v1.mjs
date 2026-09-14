#!/usr/bin/env node
// M03 P5 S5C T10 slice A — Studio Renderer final assurance guard (orchestrator).
//
// One entry point that exercises the FINAL accepted M03 Renderer chain across
// every assurance family and reports one verdict plus an acceptance matrix:
//
//   SECURITY              sanitizer v1/v2 validators (5)
//   SEMANTIC_PARITY       contract repair + content renderer + S5B cross-surface
//   ACCESSIBILITY         static contract + one real-Chromium AX-tree smoke (CDP)
//   VISUAL_FIDELITY       S5A deterministic visual regression matrix
//   PERFORMANCE           modernized long-chat benchmark vs the committed budget
//   MEMORY_COLLECTABILITY modernized memory benchmark (M03 probes + heap ceilings)
//   LIFECYCLE             lifecycle idempotence + disposal invariants
//   EXACT_EQUIVALENCE_REUSE fast-refresh / changed-refresh behavioral invariants
//   PERFORMANCE_BUDGETS   the budget manifest itself (schema, calibration, env)
//   VIRTUALIZATION_DECISION DEFERRED unless measured evidence says otherwise
//   HDA_ACCEPTANCE_PACKAGE_READY all rows PASS
//
// Every family has a negative control that must go red (performance: a real
// measured slowdown through the benchmark's ACTUAL pipeline seam; memory: a
// real in-browser retention of a discarded Semantic Index + lifecycle;
// accessibility: an in-browser aria-label removal). Sub-validators run as child
// processes; nothing here re-implements Product logic.
//
// Normal execution is READ-ONLY against the committed budget manifest
// tools/validation/studio/baselines/m03-s5c-v1/performance-budget.json. The
// manifest is rewritten only with --update-performance-budget (or
// H2O_RENDERER_PERF_UPDATE=1): the benchmarks are then run >= 3 times and the
// ceilings are derived as max(ref*1.20, ref+3*MAD, ref+resolutionFloor). Visual
// baselines are never updated from here.
//
// Verdicts: PASS | PERFORMANCE_REGRESSION | MEMORY_REGRESSION |
//           ACCESSIBILITY_REGRESSION | SECURITY_REGRESSION | SEMANTIC_REGRESSION |
//           VISUAL_REGRESSION | BASELINE_ENVIRONMENT_MISMATCH |
//           PERFORMANCE_ENVIRONMENT_MISMATCH | BLOCKED
// Exit codes: 0 PASS, 1 regression, 2 BLOCKED, 3 environment mismatch.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), '..', '..', '..');
const STUDIO_DIR = path.join(REPO_ROOT, 'src-surfaces-base/studio');
const VALIDATION_DIR = 'tools/validation/studio';
const BUDGET_REL = 'tools/validation/studio/baselines/m03-s5c-v1/performance-budget.json';
const BUDGET_PATH = path.join(REPO_ROOT, BUDGET_REL);
const ARTIFACT_DIR = path.join(REPO_ROOT, 'artifacts/renderer-final-assurance');

const BUDGET_SCHEMA = 'h2o.renderer.performance-budget';
const BUDGET_SCHEMA_VERSION = 1;
const BUDGET_VERSION = 'm03-s5c-v1';
/* The accepted Product state the committed budget was calibrated from. */
const PRODUCT_BASELINE_COMMIT = 'e786d920ec3aa287d38197db54270c0b8ae64e1b';

const UPDATE_MODE = process.argv.includes('--update-performance-budget')
  || /^(1|true|yes)$/i.test(String(process.env.H2O_RENDERER_PERF_UPDATE || ''));
const CALIBRATION_RUNS = Math.max(3, Number.parseInt(String(process.env.H2O_RENDERER_PERF_CALIBRATION_RUNS || '3'), 10) || 3);
/* Development aid only: skipping any step can never produce PASS. */
const SKIP = new Set(String(process.env.H2O_RENDERER_ASSURANCE_SKIP || '').split(',').map((s) => s.trim()).filter(Boolean));

/* ----------------------------------------------------------- definitions -- */

const SECURITY_VALIDATORS = Object.freeze([
  'validate-html-sanitizer.mjs',
  'validate-html-sanitizer-v1-compat.mjs',
  'validate-studio-sanitizer-v2-dom.mjs',
  'validate-studio-sanitizer-v2-policy.mjs',
  'validate-studio-sanitizer-v2-vendor-pin.mjs',
]);
const CONTRACT_REPAIR_VALIDATOR = 'validate-studio-renderer-contract-repair.mjs';
const CONTENT_RENDERER_VALIDATOR = 'validate-studio-content-renderer-v1.mjs';
const LIFECYCLE_VALIDATOR = 'validate-studio-renderer-lifecycle-idempotence.mjs';
const CROSS_SURFACE_VALIDATOR = 'validate-studio-renderer-cross-surface-semantic-conformance-v1.mjs';
const VISUAL_VALIDATOR = 'validate-studio-renderer-visual-regression-v1.mjs';
const LONG_CHAT_BENCHMARK = 'benchmark-studio-renderer-long-chat.mjs';
const MEMORY_BENCHMARK = 'benchmark-studio-renderer-memory.mjs';

/* Budgeted long-chat metrics (per size). `key` is a path into one size row of
 * the benchmark JSON; the median of the run is compared with the ceiling. */
const LONG_CHAT_METRICS = Object.freeze([
  { key: 'canonical.normalizeMs', stage: 'NORMALIZE', measurementKind: 'ISOLATED_STAGE', additivity: 'EXCLUSIVE', unit: 'ms' },
  { key: 'canonical.parseAdapterMs', stage: 'PARSE_ADAPTER', measurementKind: 'ACTUAL_PIPELINE', additivity: 'INCLUSIVE_WITHIN_END_TO_END', unit: 'ms' },
  { key: 'canonical.renderIrMs', stage: 'RENDER_IR', measurementKind: 'ACTUAL_PIPELINE', additivity: 'INCLUSIVE_WITHIN_END_TO_END', unit: 'ms' },
  { key: 'canonical.contentRendererMs', stage: 'RENDERER_PROFILE', measurementKind: 'ACTUAL_PIPELINE', additivity: 'INCLUSIVE_WITHIN_END_TO_END', unit: 'ms' },
  { key: 'canonical.semanticIndexMs', stage: 'SEMANTIC_INDEX', measurementKind: 'ACTUAL_PIPELINE', additivity: 'INCLUSIVE_WITHIN_END_TO_END', unit: 'ms' },
  { key: 'canonical.renderMs', stage: 'END_TO_END_RENDER', measurementKind: 'ACTUAL_PIPELINE', additivity: 'NON_ADDITIVE', unit: 'ms' },
  { key: 'canonical.insertionMs', stage: 'DOM_INSERTION_AND_LAYOUT', measurementKind: 'ISOLATED_STAGE', additivity: 'EXCLUSIVE', unit: 'ms' },
  { key: 'rich.sanitizerMs', stage: 'SANITIZER_V2', measurementKind: 'ACTUAL_PIPELINE', additivity: 'INCLUSIVE_WITHIN_END_TO_END', unit: 'ms' },
  { key: 'rich.renderMs', stage: 'END_TO_END_RENDER_RICH', measurementKind: 'ACTUAL_PIPELINE', additivity: 'NON_ADDITIVE', unit: 'ms' },
  { key: 'fastRefresh.immediateTotalMs', stage: 'EXACT_EQUIVALENCE_REFRESH', measurementKind: 'ACTUAL_PIPELINE', additivity: 'NON_ADDITIVE', unit: 'ms' },
  { key: 'changedRefresh.immediateTotalMs', stage: 'CHANGED_CONTENT_REFRESH', measurementKind: 'ACTUAL_PIPELINE', additivity: 'NON_ADDITIVE', unit: 'ms' },
]);
/* Behavioral invariants measured by the same run (min === max === expected). */
const LONG_CHAT_INVARIANTS = Object.freeze([
  { key: 'canonical.parseAdapterCalls', expect: (turns) => turns, label: 'one IR adapter parse per canonical message' },
  { key: 'rich.sanitizerCalls', expect: (turns) => turns, label: 'one sanitizer v2 fragment per rich turn (NB-1 seam)' },
  { key: 'fastRefresh.rootPreserved', expect: () => 1, label: 'exact-equivalence refresh preserves the mounted root' },
  { key: 'fastRefresh.fullRenderAvoided', expect: () => 1, label: 'exact-equivalence refresh avoids the full render' },
  { key: 'fastRefresh.indexBuilds', expect: () => 0, label: 'exact-equivalence refresh builds no Semantic Index' },
  { key: 'fastRefresh.lifecycleBuilds', expect: () => 0, label: 'exact-equivalence refresh creates no decoration lifecycle' },
  { key: 'changedRefresh.rootReplaced', expect: () => 1, label: 'changed-content refresh replaces the root' },
  { key: 'changedRefresh.fullRenderPerformed', expect: () => 1, label: 'changed-content refresh performs the full render' },
  { key: 'changedRefresh.indexBuilds', expect: () => 1, label: 'changed-content refresh builds exactly one Semantic Index' },
  { key: 'changedRefresh.previousLifecycleDisposed', expect: () => 1, label: 'changed-content refresh disposes the previous lifecycle once' },
]);

const MEMORY_SCENARIOS = Object.freeze(['canonicalReplacement', 'readerLeaveReturn', 'fastRefresh', 'changedSameId', 'richReplacement']);
const MEMORY_METRICS = Object.freeze([
  { key: 'settledUsedJSHeapMiB', unit: 'MiB', floor: 1.0, note: 'used JS heap after the scenario is torn down and GC has run' },
  { key: 'trendGrowthMiB', unit: 'MiB', floor: 1.0, note: 'used JS heap at the last batch minus the warm sample (leak trend)' },
  { key: 'settledNodes', unit: 'nodes', floor: 8, note: 'DOM node count after teardown' },
  { key: 'settledJsEventListeners', unit: 'listeners', floor: 2, note: 'JS event listener count after teardown' },
]);
const MEMORY_DIAGNOSTICS = Object.freeze(['hostSnapshotDiagnostic', 'listenerSnapshotDiagnostic', 'asyncOverlayDiagnostic']);

const DERIVATION = Object.freeze({
  reference: 'median of the per-run medians',
  dispersion: 'median absolute deviation (MAD) of the per-run medians',
  ceilingFormula: 'max(reference * 1.20, reference + 3 * MAD, reference + resolutionFloor)',
  relativeMargin: 1.2,
  madMultiplier: 3,
  resolutionFloorMs: 0.5,
});
const STRICT_ENV_KEYS = Object.freeze(['browserFamily', 'browserVersion', 'platform', 'arch', 'osMajor', 'cpuModel', 'hardwareConcurrency']);

/* Measured-evidence thresholds for the virtualization decision. */
const VIRTUALIZATION_EVIDENCE = Object.freeze({
  turns: 2000,
  endToEndRenderPlusInsertionMs: 1000,
  settledHeapGrowthMiB: 8,
});

/* ---------------------------------------------------------------- helpers -- */

const results = [];
let failures = 0;
function check(label, ok, detail = '') {
  results.push({ label, ok: !!ok, detail });
  if (!ok) failures += 1;
  console.log(`${ok ? '✓' : '✗'} ${label}${ok || !detail ? '' : `  -> ${detail}`}`);
  return !!ok;
}
function info(line) { console.log(`  ${line}`); }
function round(value, digits = 3) { const f = 10 ** digits; return Math.round(Number(value) * f) / f; }
function median(values) {
  const sorted = values.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return NaN;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
function mad(values, reference) { return median(values.map((v) => Math.abs(v - reference))); }
function ceilingOf(reference, dispersion, floor) {
  return round(Math.max(reference * DERIVATION.relativeMargin, reference + DERIVATION.madMultiplier * dispersion, reference + floor));
}
function getPath(object, dotted) { return dotted.split('.').reduce((o, k) => (o == null ? undefined : o[k]), object); }
function writeArtifact(name, content) {
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  const target = path.join(ARTIFACT_DIR, name);
  fs.writeFileSync(target, content);
  return path.relative(REPO_ROOT, target);
}

/* ------------------------------------------------------------- playwright -- */

async function resolvePlaywright() {
  const candidates = [];
  const override = process.env.H2O_PLAYWRIGHT_MODULE;
  if (override) candidates.push(override);
  try { candidates.push(path.dirname(createRequire(import.meta.url).resolve('playwright/package.json'))); } catch {}
  for (const candidate of candidates) {
    try {
      if (!fs.existsSync(candidate)) continue;
      const dir = fs.statSync(candidate).isDirectory() ? candidate : path.dirname(candidate);
      const entry = fs.statSync(candidate).isDirectory() ? path.join(candidate, 'index.js') : candidate;
      const mod = await import(pathToFileURL(entry).href);
      const chromium = mod?.chromium || mod?.default?.chromium || null;
      if (!chromium) continue;
      let version = null;
      try { version = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version || null; } catch {}
      return { chromium, version, dir };
    } catch {}
  }
  return null;
}
function resolveChromiumExecutable(chromium) {
  const candidates = [process.env.H2O_RENDERER_ASSURANCE_CHROMIUM, process.env.H2O_RENDERER_BENCH_CHROMIUM, chromium.executablePath()].filter(Boolean);
  for (const candidate of candidates) { try { fs.accessSync(candidate); return candidate; } catch {} }
  return null;
}
function environmentOf(playwrightVersion, browserVersion) {
  const release = os.release();
  const cpu = os.cpus()[0]?.model || 'unknown';
  return {
    browserFamily: 'chromium',
    browserVersion,
    playwrightVersion,
    platform: process.platform,
    arch: process.arch,
    osRelease: release,
    osMajor: String(release).split('.')[0],
    cpuModel: cpu,
    hardwareConcurrency: os.cpus().length,
  };
}

/* ----------------------------------------------------------- child runs -- */

function childEnv(pw) {
  const env = { ...process.env };
  if (pw?.dir) {
    env.H2O_PLAYWRIGHT_MODULE = env.H2O_PLAYWRIGHT_MODULE || pw.dir;
    const nodeModules = path.dirname(pw.dir);
    env.NODE_PATH = [nodeModules, env.NODE_PATH].filter(Boolean).join(path.delimiter);
  }
  /* Never let this orchestrator's own switches leak into sub-validators. */
  delete env.H2O_RENDERER_VISUAL_UPDATE;
  delete env.H2O_RENDERER_PERF_UPDATE;
  delete env.H2O_RENDERER_BENCH_SLOWDOWN_MS;
  return env;
}
function runNode(rel, { env, extraEnv = {}, args = [], timeoutMs = 600_000, logName }) {
  const started = Date.now();
  const child = spawnSync(process.execPath, [path.join(REPO_ROOT, rel), ...args], {
    cwd: REPO_ROOT,
    env: { ...env, ...extraEnv },
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    timeout: timeoutMs,
  });
  const durationMs = Date.now() - started;
  const stdout = child.stdout || '';
  const stderr = child.stderr || '';
  const status = child.error ? (child.error.code === 'ETIMEDOUT' ? 'TIMEOUT' : String(child.error.message)) : child.status;
  if (logName) writeArtifact(logName, `# ${rel} ${args.join(' ')}\n# exit=${status} durationMs=${durationMs}\n\n## stdout\n${stdout}\n\n## stderr\n${stderr}\n`);
  return { rel, status, stdout, stderr, durationMs };
}
function lastVerdict(stdout) {
  const match = [...String(stdout).matchAll(/^VERDICT:\s*(\S+)/gm)].pop();
  return match ? match[1] : null;
}
function lastSummary(stdout) {
  const match = [...String(stdout).matchAll(/^SUMMARY (\{.*\})\s*$/gm)].pop();
  if (!match) return null;
  try { return JSON.parse(match[1]); } catch { return null; }
}

/* ------------------------------------------------------- budget manifest -- */

function longChatRow(result, turns) {
  return (result?.results || []).find((row) => Number(row.turns) === Number(turns)) || null;
}
function memoryScenarioFacts(trend) {
  if (!Array.isArray(trend) || trend.length < 2) return null;
  const warm = trend[0];
  const settled = trend[trend.length - 1];
  const lastBatch = trend.length >= 3 ? trend[trend.length - 2] : warm;
  return {
    settledUsedJSHeapMiB: settled.usedJSHeapMiB,
    trendGrowthMiB: round(lastBatch.usedJSHeapMiB - warm.usedJSHeapMiB),
    settledNodes: settled.nodes,
    settledJsEventListeners: settled.jsEventListeners,
    settledProbes: settled.probes || {},
    settledLabel: settled.label,
  };
}
function buildBudget({ longChatRuns, memoryRuns, environment }) {
  const first = longChatRuns[0];
  const sizes = first.methodology.sizes;
  const longChat = {};
  for (const turns of sizes) {
    const row = {};
    for (const metric of LONG_CHAT_METRICS) {
      const samples = longChatRuns.map((run) => Number(getPath(longChatRow(run, turns), `${metric.key}.median`)));
      const reference = round(median(samples));
      const dispersion = round(mad(samples, reference));
      row[metric.key] = { reference, mad: dispersion, ceiling: ceilingOf(reference, dispersion, DERIVATION.resolutionFloorMs), runMedians: samples.map((v) => round(v)) };
    }
    const fixtureBytes = longChatRow(first, turns).fixtureBytes;
    longChat[String(turns)] = { fixtureBytes, metrics: row };
  }
  const memory = {};
  for (const scenario of MEMORY_SCENARIOS) {
    const row = {};
    for (const metric of MEMORY_METRICS) {
      const samples = memoryRuns.map((run) => Number(memoryScenarioFacts(run.scenarios[scenario])[metric.key]));
      const reference = round(median(samples));
      const dispersion = round(mad(samples, reference));
      row[metric.key] = { reference, mad: dispersion, ceiling: ceilingOf(reference, dispersion, metric.floor), runValues: samples.map((v) => round(v)) };
    }
    memory[scenario] = row;
  }
  const memoryMethodology = memoryRuns[0].methodology;
  return {
    schema: BUDGET_SCHEMA,
    schemaVersion: BUDGET_SCHEMA_VERSION,
    budgetVersion: BUDGET_VERSION,
    productBaselineCommit: PRODUCT_BASELINE_COMMIT,
    generatedAt: new Date().toISOString(),
    environment,
    strictEnvironmentKeys: [...STRICT_ENV_KEYS],
    derivation: { ...DERIVATION, calibrationRuns: longChatRuns.length, memoryFloors: Object.fromEntries(MEMORY_METRICS.map((m) => [m.key, m.floor])) },
    fixture: {
      longChat: {
        benchmark: `${VALIDATION_DIR}/${LONG_CHAT_BENCHMARK}`,
        sizes,
        warmups: first.methodology.warmups,
        samples: first.methodology.samples,
        statistic: first.methodology.statistic,
        fixture: first.methodology.fixture,
        chain: first.methodology.chain,
        stages: first.methodology.stages,
      },
      memory: {
        benchmark: `${VALIDATION_DIR}/${MEMORY_BENCHMARK}`,
        canonicalTurns: memoryMethodology.canonicalTurns,
        richTurns: memoryMethodology.richTurns,
        cycles: memoryMethodology.cycles,
        batchSize: memoryMethodology.batchSize,
        warmups: memoryMethodology.warmups,
        fastRefreshCycles: memoryMethodology.fastRefreshCycles,
        chain: memoryMethodology.chain,
        m03Probes: memoryMethodology.m03Probes,
      },
    },
    metricDefinitions: {
      longChat: Object.fromEntries(LONG_CHAT_METRICS.map((m) => [m.key, { stage: m.stage, measurementKind: m.measurementKind, additivity: m.additivity, unit: m.unit }])),
      memory: Object.fromEntries(MEMORY_METRICS.map((m) => [m.key, { unit: m.unit, floor: m.floor, note: m.note }])),
    },
    invariants: LONG_CHAT_INVARIANTS.map((inv) => ({ key: inv.key, label: inv.label })),
    longChat,
    memory,
    calibration: {
      runs: longChatRuns.map((run, index) => ({ index: index + 1, longChatGeneratedAt: run.generatedAt, memoryGeneratedAt: memoryRuns[index]?.generatedAt || null })),
    },
  };
}
function validateBudgetShape(budget) {
  const problems = [];
  if (budget?.schema !== BUDGET_SCHEMA) problems.push(`schema ${budget?.schema}`);
  if (budget?.schemaVersion !== BUDGET_SCHEMA_VERSION) problems.push(`schemaVersion ${budget?.schemaVersion}`);
  if (budget?.budgetVersion !== BUDGET_VERSION) problems.push(`budgetVersion ${budget?.budgetVersion}`);
  if (!/^[0-9a-f]{40}$/.test(String(budget?.productBaselineCommit || ''))) problems.push('productBaselineCommit');
  if (!(Number(budget?.derivation?.calibrationRuns) >= 3)) problems.push('calibrationRuns < 3');
  if (budget?.derivation?.ceilingFormula !== DERIVATION.ceilingFormula) problems.push('ceilingFormula');
  for (const key of STRICT_ENV_KEYS) if (budget?.environment?.[key] == null) problems.push(`environment.${key}`);
  if (!Array.isArray(budget?.fixture?.longChat?.sizes) || !budget.fixture.longChat.sizes.length) problems.push('fixture.longChat.sizes');
  for (const turns of budget?.fixture?.longChat?.sizes || []) {
    const row = budget?.longChat?.[String(turns)];
    if (!row?.metrics) { problems.push(`longChat.${turns}`); continue; }
    for (const metric of LONG_CHAT_METRICS) {
      const cell = row.metrics[metric.key];
      if (!cell || !Number.isFinite(cell.reference) || !Number.isFinite(cell.ceiling) || cell.ceiling < cell.reference) problems.push(`longChat.${turns}.${metric.key}`);
    }
  }
  for (const scenario of MEMORY_SCENARIOS) {
    for (const metric of MEMORY_METRICS) {
      const cell = budget?.memory?.[scenario]?.[metric.key];
      if (!cell || !Number.isFinite(cell.reference) || !Number.isFinite(cell.ceiling) || cell.ceiling < cell.reference) problems.push(`memory.${scenario}.${metric.key}`);
    }
  }
  return problems;
}

/* Evaluate one long-chat run against a budget. Returns per-metric rows. */
function evaluateLongChat(run, budget) {
  const rows = [];
  for (const turns of budget.fixture.longChat.sizes) {
    const result = longChatRow(run, turns);
    const row = budget.longChat[String(turns)];
    if (!result) { rows.push({ turns, key: '*', ok: false, detail: 'size missing from run' }); continue; }
    for (const metric of LONG_CHAT_METRICS) {
      const observed = Number(getPath(result, `${metric.key}.median`));
      const cell = row.metrics[metric.key];
      const ok = Number.isFinite(observed) && observed <= cell.ceiling;
      rows.push({ turns, key: metric.key, stage: metric.stage, observed, reference: cell.reference, ceiling: cell.ceiling, ok, margin: round(cell.ceiling - observed) });
    }
  }
  return rows;
}
function evaluateLongChatInvariants(run, sizes) {
  const rows = [];
  for (const turns of sizes) {
    const result = longChatRow(run, turns);
    for (const inv of LONG_CHAT_INVARIANTS) {
      const stat = getPath(result, inv.key);
      const expected = inv.expect(Number(turns));
      const ok = !!stat && stat.min === expected && stat.max === expected && stat.median === expected;
      rows.push({ turns, key: inv.key, label: inv.label, expected, observed: stat ? `${stat.min}/${stat.median}/${stat.max}` : 'missing', ok });
    }
  }
  return rows;
}
function evaluateMemory(run, budget) {
  const rows = [];
  for (const scenario of MEMORY_SCENARIOS) {
    const facts = memoryScenarioFacts(run.scenarios?.[scenario]);
    if (!facts) { rows.push({ scenario, key: '*', ok: false, detail: 'scenario missing from run' }); continue; }
    for (const metric of MEMORY_METRICS) {
      const observed = Number(facts[metric.key]);
      const cell = budget.memory[scenario][metric.key];
      const ok = Number.isFinite(observed) && observed <= cell.ceiling;
      rows.push({ scenario, key: metric.key, observed, reference: cell.reference, ceiling: cell.ceiling, ok, margin: round(cell.ceiling - observed) });
    }
  }
  return rows;
}
/* Collectability: every discarded probe kind must be dead at the settled sample. */
function evaluateCollectability(run) {
  const rows = [];
  for (const scenario of [...MEMORY_SCENARIOS, ...MEMORY_DIAGNOSTICS]) {
    const trend = run.scenarios?.[scenario];
    const settled = Array.isArray(trend) ? trend[trend.length - 1] : null;
    if (!settled) { rows.push({ scenario, kind: '*', ok: false, detail: 'scenario missing' }); continue; }
    const probes = settled.probes || {};
    const kinds = Object.keys(probes);
    if (!kinds.length) { rows.push({ scenario, kind: '*', ok: false, detail: 'no probes recorded' }); continue; }
    for (const kind of kinds) rows.push({ scenario, kind, total: probes[kind].total, alive: probes[kind].alive, ok: probes[kind].alive === 0 && probes[kind].total > 0 });
  }
  return rows;
}
function evaluateM03ProbeCoverage(run) {
  /* The M03 kinds must actually be probed on every scenario that discards a render. */
  const required = ['semanticIndex', 'decorationLifecycle', 'decorationHandle', 'decorationNode', 'root', 'snapshot'];
  const rows = [];
  for (const scenario of MEMORY_SCENARIOS) {
    const trend = run.scenarios?.[scenario];
    const settled = Array.isArray(trend) ? trend[trend.length - 1] : null;
    const probes = settled?.probes || {};
    for (const kind of required) rows.push({ scenario, kind, total: probes[kind]?.total || 0, ok: (probes[kind]?.total || 0) > 0 });
  }
  return rows;
}

/* ------------------------------------------------------------- AX smoke -- */

const PHOTO_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAABP0lEQVR42u3ayU1DQRCEYQdWcbKZxew7Bgw5+OwMyKBCIABsaTRdPfWwWvqO7+D/YI2me2aL5Xqr9eZnq6l9P6uACqiACqiAUMB/+aG7vq+APQvgJVpMLoBX6OMP4DXibAG8gYohgLfQ6gzo+DPxDnnST2LeI1tywAOyJQbwEWOkBPAJI4kD+IzxpAEvGE8WwFe4aO4DfIOL5iTmEi6CAL7DKxzwAa9wwCe8wgEreIUDvuAVDviGV/Q+wAN4RU9iHsIrHHAEr3DAMbzCASfwCgfM4RUOOIWX4j5wBhfRfeAcLqL7wAVcZKNFLjCecjbaOPjXEg93u5cAfVKm05JtQIvE8bpwJ7BL7n5Avhb4q/YDbZsS+VrA8NRAuBOwvZWQbAP8jz26lwCTe63SPviv5zb1Xqie21RABVRABexDwC89PM9bFZpv0gAAAABJRU5ErkJggg==';
const T0 = 1757664000;
const AX_INPUT = Object.freeze({
  chatId: 'chat-ax-smoke',
  snapshotId: 'snap-ax-smoke',
  meta: { title: 'Renderer accessibility smoke' },
  messages: [
    {
      role: 'user', messageId: 'ax-u1', turnId: 'ax-t1', createTime: T0,
      text: 'Please summarise the **quarterly report** and describe the attached chart.',
      attachments: [
        { kind: 'image', thumbnailSrc: PHOTO_PNG, alt: 'Attached photo', captureStatus: 'captured', naturalWidth: 64, naturalHeight: 64 },
        { kind: 'image', thumbnailSrc: PHOTO_PNG, alt: '', captureStatus: 'captured', naturalWidth: 64, naturalHeight: 64 },
      ],
    },
    {
      role: 'assistant', messageId: 'ax-a1', turnId: 'ax-t1', createTime: T0 + 60,
      text: [
        '## Quarterly summary',
        '',
        'Revenue grew **12.4%**; the `net-margin` metric is documented in the [reporting guide](https://example.test/reports/guide).',
        '',
        '- EMEA — steady growth',
        '- APAC — new markets',
        '',
        '1. Close the books',
        '2. Publish the report',
        '',
        '```js',
        'const margin = (revenue, costs) => (revenue - costs) / revenue;',
        '```',
        '',
        '| Region | Q1 | Q2 |',
        '|:-------|---:|---:|',
        '| EMEA | 410 | 462 |',
        '| APAC | 285 | 331 |',
      ].join('\n'),
    },
    { role: 'system', messageId: 'ax-s1', createTime: T0 + 120, text: 'System notice: this transcript was captured for the accessibility smoke.' },
    { role: 'tool', messageId: 'ax-x1', createTime: T0 + 180, text: 'Tool result: `{"status":"ok"}` — verified.' },
  ],
});
const AX_RENDERER_CHAIN = Object.freeze([
  'platform/selectors.contract.js',
  'platform/html-sanitizer.js',
  'renderer/safety/sanitizer-policy.v1.js',
  'renderer/safety/vendor/dompurify/purify.js',
  'renderer/safety/html-sanitizer.v2.js',
  'renderer/markdown/vendor/markdown-it/markdown-it.umd.min.js',
  'renderer/markdown/h2o-gfm.v1.js',
  'renderer/markdown/markdown-engine.v1.js',
  'renderer/markdown/markdown-ir-adapter.v1.js',
  'renderer/semantic/render-ir.v1.js',
  'renderer/semantic/semantic-ingress.v1.js',
  'renderer/semantic/semantic-index.v1.js',
  'renderer/decoration/decoration-contribution.v1.js',
  'renderer/presentation/presentation-profile.v1.js',
  'renderer/content/content-renderer.v1.js',
  'renderer/chat-renderer.studio.js',
]);
const AX_STYLESHEETS = Object.freeze(['studio.css', 'renderer/presentation/chatgpt-reference.v1.css']);

function AX_RENDER_IN_PAGE(input) {
  const cr = globalThis.H2O && globalThis.H2O.Studio && globalThis.H2O.Studio.chatRenderer;
  if (!cr || typeof cr.render !== 'function') throw new Error('H2O.Studio.chatRenderer is not installed');
  const host = document.getElementById('viewReader');
  const r = cr.render(JSON.parse(JSON.stringify(input)), { getEditOverride: () => null });
  host.appendChild(r.root);
  const attachmentImgs = Array.from(r.root.querySelectorAll('.cgUserAttachmentCard img, [role="group"][aria-label="Attached images"] img'));
  return {
    renderMode: r.renderMode,
    messages: r.semanticIndex.messages().length,
    articles: r.root.querySelectorAll('article[aria-label]').length,
    attachmentImgCount: attachmentImgs.length,
    emptyAltCount: attachmentImgs.filter((img) => img.getAttribute('alt') === '').length,
    links: r.root.querySelectorAll('a[href]').length,
  };
}
function AX_NEGATIVE_CONTROL_IN_PAGE() {
  const article = document.querySelector('article[aria-label="Assistant message"]');
  if (!article) throw new Error('assistant article not found for the negative control');
  article.removeAttribute('aria-label');
  return true;
}
function summarizeAxTree(nodes) {
  const exposed = nodes.filter((node) => !node.ignored);
  const roleOf = (node) => String(node.role?.value || '');
  const nameOf = (node) => String(node.name?.value || '');
  const propOf = (node, key) => (node.properties || []).find((p) => p.name === key)?.value?.value;
  const byRole = {};
  for (const node of exposed) byRole[roleOf(node)] = (byRole[roleOf(node)] || 0) + 1;
  return {
    exposedCount: exposed.length,
    byRole,
    articles: exposed.filter((n) => roleOf(n) === 'article').map((n) => ({ name: nameOf(n) })),
    regions: exposed.filter((n) => ['region', 'section', 'Section'].includes(roleOf(n))).map((n) => nameOf(n)),
    named: exposed.filter((n) => nameOf(n)).map((n) => ({ role: roleOf(n), name: nameOf(n) })),
    headings: exposed.filter((n) => roleOf(n) === 'heading').map((n) => ({ name: nameOf(n), level: propOf(n, 'level') })),
    links: exposed.filter((n) => roleOf(n) === 'link').map((n) => ({ name: nameOf(n) })),
    images: exposed.filter((n) => ['image', 'img'].includes(roleOf(n))).map((n) => ({ name: nameOf(n) })),
    groups: exposed.filter((n) => roleOf(n) === 'group').map((n) => nameOf(n)),
    lists: byRole.list || 0,
    listItems: byRole.listitem || 0,
    tables: byRole.table || 0,
    rows: byRole.row || 0,
    cells: (byRole.cell || 0) + (byRole.gridcell || 0),
    columnHeaders: byRole.columnheader || 0,
    codes: (byRole.code || 0) + (byRole.Code || 0),
  };
}
/* The AX assertions, reusable for the real tree and the negative-control tree. */
function assessAxSummary(summary, rendered) {
  const expectedArticleNames = ['User message', 'Assistant message', 'System message', 'Tool message'];
  const articleNames = summary.articles.map((a) => a.name);
  const findings = [];
  const expect = (label, ok, detail = '') => findings.push({ label, ok: !!ok, detail });
  expect('transcript region "Conversation transcript" is exposed', summary.named.some((n) => n.name === 'Conversation transcript'), JSON.stringify(summary.regions));
  expect('exactly four message articles are exposed', summary.articles.length === 4, `articles=${summary.articles.length}`);
  expect('every exposed article has an accessible role label', summary.articles.length > 0 && summary.articles.every((a) => expectedArticleNames.includes(a.name)), JSON.stringify(articleNames));
  expect('all four role labels are present (user/assistant/system/tool)', expectedArticleNames.every((name) => articleNames.includes(name)), JSON.stringify(articleNames));
  expect('assistant Markdown heading is exposed as a level-2 heading', summary.headings.some((h) => h.name === 'Quarterly summary' && Number(h.level) === 2), JSON.stringify(summary.headings));
  expect('lists and list items are exposed', summary.lists >= 2 && summary.listItems >= 4, `lists=${summary.lists} items=${summary.listItems}`);
  expect('table with rows, column headers and cells is exposed', summary.tables >= 1 && summary.rows >= 3 && summary.columnHeaders >= 3 && summary.cells >= 6, `tables=${summary.tables} rows=${summary.rows} headers=${summary.columnHeaders} cells=${summary.cells}`);
  expect('code is exposed', summary.codes >= 1, `codes=${summary.codes}`);
  expect('every exposed link has an accessible name', summary.links.length >= 1 && summary.links.every((l) => l.name.trim().length > 0), JSON.stringify(summary.links));
  expect('the Markdown link exposes its text ("reporting guide")', summary.links.some((l) => l.name === 'reporting guide'), JSON.stringify(summary.links));
  expect('attachment grid is exposed as the group "Attached images"', summary.groups.includes('Attached images'), JSON.stringify(summary.groups));
  expect('the labeled attachment image is exposed by its alt text', summary.images.some((i) => i.name === 'Attached photo'), JSON.stringify(summary.images));
  expect('no exposed image lacks an accessible name (the alt="" attachment is presentational)', rendered.attachmentImgCount === 2 && rendered.emptyAltCount === 1 && summary.images.every((i) => i.name.trim().length > 0), `attachments=${rendered.attachmentImgCount} emptyAlt=${rendered.emptyAltCount} images=${JSON.stringify(summary.images)}`);
  return findings;
}
async function runAccessibilitySmoke(pw, executable) {
  const browser = await pw.chromium.launch({ headless: true, executablePath: executable, args: ['--disable-background-networking', '--disable-component-update', '--disable-default-apps', '--disable-gpu'] });
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'en-US', timezoneId: 'UTC', reducedMotion: 'reduce', offline: true });
    await context.route('**/*', (route) => route.abort());
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(String(error)));
    await page.setContent('<!doctype html><html lang="en" data-h2o-theme="light"><head><meta charset="utf-8"><title>Renderer accessibility smoke</title></head><body data-h2o-studio-mode="1" data-route="reader"><main class="wbMain"><section id="viewReader" class="wbReader"></section></main></body></html>', { waitUntil: 'load' });
    for (const rel of AX_STYLESHEETS) await page.addStyleTag({ path: path.join(STUDIO_DIR, rel) });
    for (const rel of AX_RENDERER_CHAIN) await page.addScriptTag({ path: path.join(STUDIO_DIR, rel) });
    const rendered = await page.evaluate(AX_RENDER_IN_PAGE, AX_INPUT);
    const client = await context.newCDPSession(page);
    await client.send('Accessibility.enable');
    const fetchTree = async () => summarizeAxTree((await client.send('Accessibility.getFullAXTree')).nodes || []);
    const summary = await fetchTree();
    const findings = assessAxSummary(summary, rendered);
    /* Negative control: an in-browser aria-label removal must be detected. */
    await page.evaluate(AX_NEGATIVE_CONTROL_IN_PAGE);
    const mutatedSummary = await fetchTree();
    const mutatedFindings = assessAxSummary(mutatedSummary, rendered);
    return { rendered, summary, findings, mutatedFindings, pageErrors, browserVersion: browser.version() };
  } finally {
    await browser.close();
  }
}

/* ------------------------------------------------------------------ main -- */

const matrix = {};
function row(name, status, detail = '') { matrix[name] = { status, detail }; }

async function main() {
  console.log(`PERFORMANCE_BUDGET_UPDATE_MODE: ${UPDATE_MODE ? 'ENABLED' : 'DISABLED'}`);
  console.log('VISUAL_BASELINE_UPDATE_MODE: DISABLED');
  if (SKIP.size) console.log(`SKIPPED_STEPS (development aid; verdict cannot be PASS): ${[...SKIP].join(',')}`);
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });

  const pw = await resolvePlaywright();
  if (!pw) {
    console.log('BLOCKED: Playwright is unavailable (set H2O_PLAYWRIGHT_MODULE or NODE_PATH to a runtime carrying the playwright package).');
    return finish('BLOCKED', { reason: 'playwright-unavailable' }, 2);
  }
  const executable = resolveChromiumExecutable(pw.chromium);
  if (!executable) {
    console.log('BLOCKED: no installed Chromium executable (H2O_RENDERER_ASSURANCE_CHROMIUM or the Playwright chromium build).');
    return finish('BLOCKED', { reason: 'chromium-unavailable' }, 2);
  }
  const env = childEnv(pw);
  const timings = {};
  const report = { generatedAt: new Date().toISOString(), updateMode: UPDATE_MODE, skipped: [...SKIP], steps: {} };

  /* ---- SECURITY ---- */
  let securityOk = true;
  if (!SKIP.has('security')) {
    for (const rel of SECURITY_VALIDATORS) {
      const run = runNode(`${VALIDATION_DIR}/${rel}`, { env, timeoutMs: 120_000, logName: `${rel}.log` });
      timings[rel] = run.durationMs;
      report.steps[rel] = { status: run.status, durationMs: run.durationMs };
      if (!check(`security: ${rel} exit 0`, run.status === 0, `exit=${run.status} ${run.stderr.trim().split('\n').pop() || ''}`)) securityOk = false;
    }
    row('SECURITY', securityOk ? 'PASS' : 'FAIL', `${SECURITY_VALIDATORS.length} sanitizer validators`);
  } else row('SECURITY', 'NOT_EVALUATED', 'skipped');

  /* ---- SEMANTIC_PARITY (+ static accessibility contract, + lifecycle pins) ---- */
  let contractOk = false; let contentOk = false; let crossOk = false; let crossVerdict = null;
  if (!SKIP.has('semantic')) {
    const contract = runNode(`${VALIDATION_DIR}/${CONTRACT_REPAIR_VALIDATOR}`, { env, timeoutMs: 120_000, logName: `${CONTRACT_REPAIR_VALIDATOR}.log` });
    timings[CONTRACT_REPAIR_VALIDATOR] = contract.durationMs;
    report.steps[CONTRACT_REPAIR_VALIDATOR] = { status: contract.status, durationMs: contract.durationMs };
    contractOk = check(`semantic: ${CONTRACT_REPAIR_VALIDATOR} exit 0 (renderer contracts incl. accessibility contract)`, contract.status === 0, `exit=${contract.status} ${contract.stderr.trim().split('\n').pop() || ''}`);
    const content = runNode(`${VALIDATION_DIR}/${CONTENT_RENDERER_VALIDATOR}`, { env, timeoutMs: 300_000, logName: `${CONTENT_RENDERER_VALIDATOR}.log` });
    timings[CONTENT_RENDERER_VALIDATOR] = content.durationMs;
    report.steps[CONTENT_RENDERER_VALIDATOR] = { status: content.status, durationMs: content.durationMs };
    contentOk = check(`semantic: ${CONTENT_RENDERER_VALIDATOR} exit 0`, content.status === 0 && /^PASS \d+/m.test(content.stdout), `exit=${content.status} ${content.stdout.trim().split('\n').pop() || ''}`);
    const cross = runNode(`${VALIDATION_DIR}/${CROSS_SURFACE_VALIDATOR}`, { env, timeoutMs: 300_000, logName: `${CROSS_SURFACE_VALIDATOR}.log` });
    timings[CROSS_SURFACE_VALIDATOR] = cross.durationMs;
    /* S5B finishes with `PASS <n>` / `FAIL <n>` (no VERDICT line). */
    const crossFinal = cross.stdout.trim().split('\n').pop() || '';
    crossVerdict = /^PASS \d+$/.test(crossFinal) ? 'PASS' : (/^FAIL \d+/.test(crossFinal) ? 'FAIL' : null);
    report.steps[CROSS_SURFACE_VALIDATOR] = { status: cross.status, verdict: crossVerdict, durationMs: cross.durationMs };
    crossOk = check(`semantic: ${CROSS_SURFACE_VALIDATOR} PASS`, cross.status === 0 && crossVerdict === 'PASS', `exit=${cross.status} final=${crossFinal}`);
    const crossSummary = lastSummary(cross.stdout) || {};
    report.steps[CROSS_SURFACE_VALIDATOR].facts = { webFormalPass: crossSummary.webFormalPass, mobileFormalPass: crossSummary.mobileFormalPass, crossSurfaceMismatchCount: crossSummary.crossSurfaceMismatchCount };
    const parityOk = check('semantic: cross-surface conformance is 40/40 Web, 40/40 Mobile, 0 mismatches', crossSummary.webFormalPass === '40/40' && crossSummary.mobileFormalPass === '40/40' && crossSummary.crossSurfaceMismatchCount === 0, JSON.stringify(report.steps[CROSS_SURFACE_VALIDATOR].facts));
    crossOk = crossOk && parityOk;
    row('SEMANTIC_PARITY', contractOk && contentOk && crossOk ? 'PASS' : 'FAIL', `contract=${contractOk} content=${contentOk} cross-surface=${crossVerdict} web=${crossSummary.webFormalPass} mobile=${crossSummary.mobileFormalPass} mismatches=${crossSummary.crossSurfaceMismatchCount}`);
  } else row('SEMANTIC_PARITY', 'NOT_EVALUATED', 'skipped');

  /* ---- LIFECYCLE (validator half; benchmark half joins below) ---- */
  let lifecycleValidatorOk = false;
  if (!SKIP.has('lifecycle')) {
    const lifecycle = runNode(`${VALIDATION_DIR}/${LIFECYCLE_VALIDATOR}`, { env, timeoutMs: 120_000, logName: `${LIFECYCLE_VALIDATOR}.log` });
    timings[LIFECYCLE_VALIDATOR] = lifecycle.durationMs;
    report.steps[LIFECYCLE_VALIDATOR] = { status: lifecycle.status, durationMs: lifecycle.durationMs };
    lifecycleValidatorOk = check(`lifecycle: ${LIFECYCLE_VALIDATOR} exit 0`, lifecycle.status === 0, `exit=${lifecycle.status} ${lifecycle.stderr.trim().split('\n').pop() || ''}`);
  }

  /* ---- ACCESSIBILITY (real-Chromium AX tree) ---- */
  let a11yOk = false;
  if (!SKIP.has('a11y')) {
    try {
      const ax = await runAccessibilitySmoke(pw, executable);
      report.steps.accessibilitySmoke = { rendered: ax.rendered, summary: { byRole: ax.summary.byRole, articles: ax.summary.articles, headings: ax.summary.headings, links: ax.summary.links, images: ax.summary.images, groups: ax.summary.groups }, findings: ax.findings, negativeControl: ax.mutatedFindings.filter((f) => !f.ok).map((f) => f.label), pageErrors: ax.pageErrors };
      writeArtifact('accessibility-smoke.json', JSON.stringify(report.steps.accessibilitySmoke, null, 2));
      let smokeOk = check('a11y: transcript rendered through the real chain without page errors', ax.rendered.renderMode === 'canonical' && ax.rendered.messages === 4 && ax.pageErrors.length === 0, `mode=${ax.rendered.renderMode} messages=${ax.rendered.messages} errors=${ax.pageErrors.length}`);
      for (const finding of ax.findings) if (!check(`a11y: ${finding.label}`, finding.ok, finding.detail)) smokeOk = false;
      const controlFailures = ax.mutatedFindings.filter((f) => !f.ok);
      const controlOk = check('a11y negative control: removing an article aria-label in the browser is detected', controlFailures.some((f) => /accessible role label|all four role labels/.test(f.label)), JSON.stringify(controlFailures.map((f) => f.label)));
      a11yOk = smokeOk && controlOk && (SKIP.has('semantic') ? false : contractOk);
      row('ACCESSIBILITY', a11yOk ? 'PASS' : 'FAIL', `AX-tree smoke (${ax.findings.length} assertions) + negative control + static contract`);
    } catch (error) {
      check('a11y: AX-tree smoke completed', false, String(error?.stack || error));
      row('ACCESSIBILITY', 'FAIL', 'smoke crashed');
    }
  } else row('ACCESSIBILITY', 'NOT_EVALUATED', 'skipped');

  /* ---- VISUAL_FIDELITY (S5A, read-only) ---- */
  let visualVerdict = null; let visualStatus = null;
  if (!SKIP.has('visual')) {
    const visual = runNode(`${VALIDATION_DIR}/${VISUAL_VALIDATOR}`, { env, timeoutMs: 600_000, logName: `${VISUAL_VALIDATOR}.log` });
    timings[VISUAL_VALIDATOR] = visual.durationMs;
    visualVerdict = lastVerdict(visual.stdout);
    visualStatus = visual.status;
    report.steps[VISUAL_VALIDATOR] = { status: visual.status, verdict: visualVerdict, durationMs: visual.durationMs };
    check('visual: S5A matrix executed read-only', /BASELINE_UPDATE_MODE: DISABLED/.test(visual.stdout), 'update mode line missing');
    const visualSummary = lastSummary(visual.stdout) || {};
    const cells = visualSummary.cells || {};
    const differing = Object.fromEntries(Object.entries(cells).map(([id, cell]) => [id, cell.baselineDifferingPixels]));
    report.steps[VISUAL_VALIDATOR].differingPixels = differing;
    if (visual.status === 3 || visualVerdict === 'BASELINE_ENVIRONMENT_MISMATCH') {
      check('visual: S5A verdict PASS', false, `verdict=${visualVerdict} (environment mismatch; exact-pixel comparison is informational here)`);
      row('VISUAL_FIDELITY', 'INFORMATIONAL', 'baseline environment mismatch');
    } else {
      const ok = check('visual: S5A verdict PASS', visual.status === 0 && visualVerdict === 'PASS', `exit=${visual.status} verdict=${visualVerdict}`);
      const zero = check('visual: every matrix cell differs from its baseline by 0 pixels', Object.keys(differing).length === 4 && Object.values(differing).every((n) => n === 0), JSON.stringify(differing));
      row('VISUAL_FIDELITY', ok && zero ? 'PASS' : (visual.status === 2 ? 'BLOCKED' : 'FAIL'), `verdict=${visualVerdict} differingPixels=${JSON.stringify(differing)}`);
    }
  } else row('VISUAL_FIDELITY', 'NOT_EVALUATED', 'skipped');

  /* ---- PERFORMANCE + MEMORY benchmarks ---- */
  let budget = null; let budgetProblems = []; let budgetWritten = false;
  let longChatRun = null; let memoryRun = null;
  const benchmarkEnv = { ...env };
  const runLongChat = (label, extraEnv = {}) => {
    const run = runNode(`${VALIDATION_DIR}/${LONG_CHAT_BENCHMARK}`, { env: benchmarkEnv, extraEnv, timeoutMs: 900_000, logName: `${label}.log` });
    let json = null;
    try { json = JSON.parse(run.stdout); } catch {}
    if (json) writeArtifact(`${label}.json`, JSON.stringify(json, null, 2));
    return { run, json };
  };
  const runMemory = (label) => {
    const run = runNode(`${VALIDATION_DIR}/${MEMORY_BENCHMARK}`, { env: benchmarkEnv, timeoutMs: 900_000, logName: `${label}.log` });
    let json = null;
    try { json = JSON.parse(run.stdout); } catch {}
    if (json) writeArtifact(`${label}.json`, JSON.stringify(json, null, 2));
    return { run, json };
  };

  if (!SKIP.has('benchmarks')) {
    if (UPDATE_MODE) {
      const longChatRuns = []; const memoryRuns = [];
      for (let index = 1; index <= CALIBRATION_RUNS; index += 1) {
        const lc = runLongChat(`long-chat-calibration-${index}`);
        const ok = check(`calibration ${index}/${CALIBRATION_RUNS}: long-chat benchmark exit 0 with JSON`, lc.run.status === 0 && lc.json && !(lc.json.pageErrors || []).length, `exit=${lc.run.status} ${lc.run.stderr.trim().split('\n').pop() || ''}`);
        if (ok) longChatRuns.push(lc.json);
        const mem = runMemory(`memory-calibration-${index}`);
        const memOk = check(`calibration ${index}/${CALIBRATION_RUNS}: memory benchmark exit 0 with JSON`, mem.run.status === 0 && mem.json && !(mem.json.pageErrors || []).length, `exit=${mem.run.status} ${mem.run.stderr.trim().split('\n').pop() || ''}`);
        if (memOk) memoryRuns.push(mem.json);
        timings[`calibration-${index}`] = lc.run.durationMs + mem.run.durationMs;
      }
      if (longChatRuns.length >= 3 && memoryRuns.length >= 3) {
        const environment = environmentOf(pw.version, longChatRuns[0].environment.browserVersion);
        budget = buildBudget({ longChatRuns, memoryRuns, environment });
        budgetProblems = validateBudgetShape(budget);
        if (!budgetProblems.length) {
          fs.mkdirSync(path.dirname(BUDGET_PATH), { recursive: true });
          fs.writeFileSync(BUDGET_PATH, `${JSON.stringify(budget, null, 2)}\n`);
          budgetWritten = true;
          console.log(`BUDGET_WRITTEN: ${BUDGET_REL}`);
        }
        longChatRun = longChatRuns[longChatRuns.length - 1];
        memoryRun = memoryRuns[memoryRuns.length - 1];
      } else {
        check('calibration: at least three complete long-chat and memory runs', false, `long-chat=${longChatRuns.length} memory=${memoryRuns.length}`);
      }
    } else {
      const lc = runLongChat('long-chat');
      check('performance: long-chat benchmark exit 0 with JSON and no page errors', lc.run.status === 0 && lc.json && !(lc.json.pageErrors || []).length, `exit=${lc.run.status} ${lc.run.stderr.trim().split('\n').pop() || ''}`);
      longChatRun = lc.json;
      timings[LONG_CHAT_BENCHMARK] = lc.run.durationMs;
      const mem = runMemory('memory');
      check('memory: memory benchmark exit 0 with JSON and no page errors', mem.run.status === 0 && mem.json && !(mem.json.pageErrors || []).length, `exit=${mem.run.status} ${mem.run.stderr.trim().split('\n').pop() || ''}`);
      memoryRun = mem.json;
      timings[MEMORY_BENCHMARK] = mem.run.durationMs;
      try { budget = JSON.parse(fs.readFileSync(BUDGET_PATH, 'utf8')); } catch (error) { budget = null; budgetProblems = [`unreadable: ${error.message}`]; }
      if (budget) budgetProblems = validateBudgetShape(budget);
    }
  }

  /* ---- PERFORMANCE_BUDGETS (manifest) ---- */
  let budgetsOk = false; let perfEnvMismatch = [];
  if (!SKIP.has('benchmarks')) {
    const manifestText = fs.existsSync(BUDGET_PATH) ? fs.readFileSync(BUDGET_PATH, 'utf8') : '';
    const present = check(`budgets: manifest present at ${BUDGET_REL}`, !!manifestText, 'missing');
    const shapeOk = check('budgets: manifest schema/version/baseline commit/derivation/environment/ceilings are well-formed', present && !budgetProblems.length, budgetProblems.join('; '));
    const noAbsolute = check('budgets: manifest carries no absolute paths', present && !/(\/Users\/|\/Volumes\/|\/home\/|\/private\/|[A-Za-z]:\\)/.test(manifestText));
    const commitOk = check(`budgets: manifest productBaselineCommit is the S5C Product baseline ${PRODUCT_BASELINE_COMMIT.slice(0, 8)}`, budget?.productBaselineCommit === PRODUCT_BASELINE_COMMIT, String(budget?.productBaselineCommit));
    let fixtureOk = false; let envOk = false;
    if (budget && longChatRun) {
      const sizesOk = JSON.stringify(budget.fixture.longChat.sizes) === JSON.stringify(longChatRun.methodology.sizes);
      const bytesOk = budget.fixture.longChat.sizes.every((turns) => JSON.stringify(budget.longChat[String(turns)]?.fixtureBytes) === JSON.stringify(longChatRow(longChatRun, turns)?.fixtureBytes));
      const shapeSame = budget.fixture.longChat.warmups === longChatRun.methodology.warmups && budget.fixture.longChat.samples === longChatRun.methodology.samples && Number(longChatRun.methodology.slowdownMs || 0) === 0;
      fixtureOk = check('budgets: measured fixture identity (sizes, fixture bytes, warmups, samples, no slowdown) matches the manifest', sizesOk && bytesOk && shapeSame, `sizes=${sizesOk} bytes=${bytesOk} shape=${shapeSame}`);
      const memShapeOk = memoryRun && ['canonicalTurns', 'richTurns', 'cycles', 'batchSize', 'warmups', 'fastRefreshCycles'].every((key) => budget.fixture.memory[key] === memoryRun.methodology[key]);
      fixtureOk = check('budgets: memory workload shape matches the manifest', !!memShapeOk, JSON.stringify(memoryRun?.methodology && Object.fromEntries(['canonicalTurns', 'richTurns', 'cycles', 'batchSize', 'warmups', 'fastRefreshCycles'].map((k) => [k, memoryRun.methodology[k]])))) && fixtureOk;
      const environment = environmentOf(pw.version, longChatRun.environment.browserVersion);
      perfEnvMismatch = (budget.strictEnvironmentKeys || STRICT_ENV_KEYS).filter((key) => String(budget.environment?.[key]) !== String(environment[key]));
      envOk = perfEnvMismatch.length === 0;
      if (!envOk) console.log(`PERFORMANCE_ENVIRONMENT_MISMATCH: ${perfEnvMismatch.map((key) => `${key} expected=${budget.environment?.[key]} actual=${environment[key]}`).join('; ')}`);
      check('budgets: benchmark environment matches the calibration environment (strict keys)', envOk, perfEnvMismatch.join(','));
      report.environment = environment;
    }
    budgetsOk = present && shapeOk && noAbsolute && commitOk && fixtureOk && envOk;
    row('PERFORMANCE_BUDGETS', budgetsOk ? 'PASS' : 'FAIL', `${budgetWritten ? 'written' : 'read-only'}; calibrationRuns=${budget?.derivation?.calibrationRuns ?? 'n/a'}`);
  } else row('PERFORMANCE_BUDGETS', 'NOT_EVALUATED', 'skipped');

  /* ---- PERFORMANCE ---- */
  let perfOk = false; let perfViolations = []; let perfEvaluated = false;
  if (!SKIP.has('benchmarks') && budget && !budgetProblems.length && longChatRun) {
    perfEvaluated = true;
    const rows = evaluateLongChat(longChatRun, budget);
    report.steps.performance = rows;
    for (const r of rows) {
      const ok = check(`perf ${String(r.turns).padStart(4)} ${r.key} (${r.stage}) ${r.observed} ms ≤ ceiling ${r.ceiling} ms (ref ${r.reference})`, r.ok, r.detail || `over by ${round(r.observed - r.ceiling)} ms`);
      if (!ok) perfViolations.push(r);
    }
    /* Negative control 1 (comparator): one parsed ceiling lowered in memory below
     * the measured value must be reported as a violation. */
    const largest = Math.max(...budget.fixture.longChat.sizes);
    const loweredBudget = JSON.parse(JSON.stringify(budget));
    const measuredRender = Number(getPath(longChatRow(longChatRun, largest), 'canonical.renderMs.median'));
    loweredBudget.longChat[String(largest)].metrics['canonical.renderMs'].ceiling = round(measuredRender * 0.5);
    const loweredRows = evaluateLongChat(longChatRun, loweredBudget);
    const loweredHit = loweredRows.find((r) => r.turns === largest && r.key === 'canonical.renderMs');
    const comparatorDetected = !!loweredHit && !loweredHit.ok && loweredRows.filter((r) => !r.ok).length === perfViolations.length + 1;
    check(`perf negative control (comparator): lowering the ${largest}-turn END_TO_END_RENDER ceiling to ${loweredBudget.longChat[String(largest)].metrics['canonical.renderMs'].ceiling} ms in memory is reported as a violation`, comparatorDetected, JSON.stringify(loweredHit));
    /* Negative control 2 (measured): a real slowdown through the ACTUAL pipeline seam. */
    const smallest = Math.min(...budget.fixture.longChat.sizes);
    const control = runLongChat('long-chat-negative-control', { H2O_RENDERER_BENCH_SIZES: String(smallest), H2O_RENDERER_BENCH_WARMUPS: '1', H2O_RENDERER_BENCH_SAMPLES: '3', H2O_RENDERER_BENCH_SLOWDOWN_MS: '1' });
    timings['long-chat-negative-control'] = control.run.durationMs;
    let controlDetected = false;
    if (control.json) {
      const controlRows = evaluateLongChat({ results: control.json.results }, { ...budget, fixture: { ...budget.fixture, longChat: { ...budget.fixture.longChat, sizes: [smallest] } } });
      const parseRow = controlRows.find((r) => r.key === 'canonical.parseAdapterMs');
      const renderRow = controlRows.find((r) => r.key === 'canonical.renderMs');
      controlDetected = !!(parseRow && renderRow && !parseRow.ok && !renderRow.ok);
      report.steps.performanceNegativeControl = { turns: smallest, slowdownMs: control.json.methodology.slowdownMs, parseAdapterMs: parseRow?.observed, parseCeiling: parseRow?.ceiling, renderMs: renderRow?.observed, renderCeiling: renderRow?.ceiling };
      check(`perf negative control: a 1 ms per-parse slowdown at ${smallest} turns breaches the PARSE_ADAPTER and END_TO_END_RENDER ceilings`, controlDetected, `parse=${parseRow?.observed}>${parseRow?.ceiling} render=${renderRow?.observed}>${renderRow?.ceiling}`);
    } else {
      check('perf negative control: slowdown run produced JSON', false, control.run.stderr.trim().split('\n').pop() || '');
    }
    perfOk = perfViolations.length === 0 && controlDetected && comparatorDetected && perfEnvMismatch.length === 0;
    row('PERFORMANCE', perfEnvMismatch.length ? 'INFORMATIONAL' : (perfOk ? 'PASS' : 'FAIL'), `${rows.length} budgeted medians, ${perfViolations.length} over ceiling; negative controls comparator=${comparatorDetected ? 'fired' : 'DID NOT FIRE'} measured-slowdown=${controlDetected ? 'fired' : 'DID NOT FIRE'}`);
  } else row('PERFORMANCE', SKIP.has('benchmarks') ? 'NOT_EVALUATED' : 'BLOCKED', budget ? 'benchmark did not complete' : 'no usable budget manifest');

  /* ---- MEMORY_COLLECTABILITY ---- */
  let memoryOk = false; let memoryEvaluated = false; let collectabilityFailures = 0;
  if (!SKIP.has('benchmarks') && memoryRun) {
    memoryEvaluated = true;
    const coverage = evaluateM03ProbeCoverage(memoryRun);
    let coverageOk = true;
    for (const c of coverage) if (!c.ok) coverageOk = false;
    check('memory: M03 probes (semanticIndex, decorationLifecycle, decorationHandle, decorationNode, root, snapshot) recorded on every discard scenario', coverageOk, JSON.stringify(coverage.filter((c) => !c.ok)));
    const collect = evaluateCollectability(memoryRun);
    report.steps.collectability = collect;
    for (const scenario of MEMORY_SCENARIOS) {
      const trend = memoryRun.scenarios?.[scenario] || [];
      const live = trend.length >= 3 ? trend[trend.length - 2] : null;
      if (live) info(`memory ${scenario} CURRENT_LIVE at ${live.label}: root=${live.current?.root} bound=${live.current?.bound} turns=${live.current?.turns} registeredDecorations=${live.current?.registeredDecorations} (never expected to disappear while mounted); DISCARDED_EXPECTED_COLLECTIBLE probes are asserted at ${trend[trend.length - 1]?.label}`);
    }
    for (const c of collect) {
      if (!check(`memory ${c.scenario} DISCARDED_${String(c.kind).replace(/([a-z])([A-Z])/g, '$1_$2').toUpperCase()}_ALIVE ${c.alive ?? '?'} of ${c.total ?? '?'} → 0`, c.ok, c.detail || '')) collectabilityFailures += 1;
    }
    /* Retention negative control (real in-browser retention of a discarded index + lifecycle). */
    const control = memoryRun.scenarios?.retentionNegativeControl || [];
    const retained = control[0]?.probes || {}; const released = control[1]?.probes || {};
    const controlOk = check('memory negative control: retained discarded Semantic Index + lifecycle are reported ALIVE, then collected once released',
      (retained.semanticIndex?.alive || 0) >= 1 && (retained.decorationLifecycle?.alive || 0) >= 1 && (retained.decorationHandle?.alive || 0) >= 1
      && released.semanticIndex?.alive === 0 && released.decorationLifecycle?.alive === 0 && released.decorationHandle?.alive === 0 && released.decorationNode?.alive === 0,
      `retained=${JSON.stringify(Object.fromEntries(Object.entries(retained).map(([k, v]) => [k, v.alive])))} released=${JSON.stringify(Object.fromEntries(Object.entries(released).map(([k, v]) => [k, v.alive])))}`);
    let heapOk = true;
    if (budget && !budgetProblems.length) {
      const rows = evaluateMemory(memoryRun, budget);
      report.steps.memoryBudget = rows;
      for (const r of rows) if (!check(`memory ${r.scenario} ${r.key} ${r.observed} ≤ ceiling ${r.ceiling} (ref ${r.reference})`, r.ok, r.detail || `over by ${round(r.observed - r.ceiling)}`)) heapOk = false;
    } else {
      heapOk = check('memory: heap ceilings evaluated against the budget manifest', false, 'no usable budget manifest');
    }
    memoryOk = coverageOk && collectabilityFailures === 0 && controlOk && heapOk;
    row('MEMORY_COLLECTABILITY', memoryOk ? 'PASS' : 'FAIL', `${collect.length} probe kinds, ${collectabilityFailures} alive; heap ceilings ${heapOk ? 'within' : 'exceeded'}; negative control ${controlOk ? 'fired' : 'DID NOT FIRE'}`);
  } else row('MEMORY_COLLECTABILITY', SKIP.has('benchmarks') ? 'NOT_EVALUATED' : 'BLOCKED', 'memory benchmark did not complete');

  /* ---- LIFECYCLE + EXACT_EQUIVALENCE_REUSE (benchmark invariants) ---- */
  let invariantsOk = false;
  if (!SKIP.has('benchmarks') && longChatRun) {
    const rows = evaluateLongChatInvariants(longChatRun, longChatRun.methodology.sizes);
    report.steps.invariants = rows;
    invariantsOk = true;
    for (const r of rows) if (!check(`invariant ${String(r.turns).padStart(4)} ${r.key}: ${r.label} (expected ${r.expected}, min/median/max ${r.observed})`, r.ok)) invariantsOk = false;
  }
  const nb1Resolved = !!longChatRun && longChatRun.methodology.sizes.every((turns) => { const s = getPath(longChatRow(longChatRun, turns), 'rich.sanitizerCalls'); return s && s.min === Number(turns) && s.max === Number(turns); });
  if (!SKIP.has('lifecycle') && !SKIP.has('benchmarks')) {
    const disposalOk = invariantsOk && memoryEvaluated && collectabilityFailures === 0;
    row('LIFECYCLE', lifecycleValidatorOk && disposalOk ? 'PASS' : 'FAIL', `idempotence validator=${lifecycleValidatorOk}; disposal invariants=${invariantsOk}; discarded lifecycles collectable=${memoryEvaluated && collectabilityFailures === 0}`);
    row('EXACT_EQUIVALENCE_REUSE', invariantsOk ? 'PASS' : 'FAIL', 'fast refresh: root preserved, 0 index builds, 0 lifecycles; changed refresh: root replaced, 1 index build, previous lifecycle disposed');
  } else { row('LIFECYCLE', 'NOT_EVALUATED', 'skipped'); row('EXACT_EQUIVALENCE_REUSE', 'NOT_EVALUATED', 'skipped'); }

  /* ---- VIRTUALIZATION_DECISION ---- */
  let virtualization = { decision: 'DEFERRED', required: 'NO', basis: null };
  if (longChatRun && memoryRun) {
    const top = longChatRow(longChatRun, VIRTUALIZATION_EVIDENCE.turns);
    const renderMs = Number(getPath(top, 'canonical.renderMs.median'));
    const insertionMs = Number(getPath(top, 'canonical.insertionMs.median'));
    const growth = memoryScenarioFacts(memoryRun.scenarios?.canonicalReplacement)?.trendGrowthMiB;
    const basis = { turns: VIRTUALIZATION_EVIDENCE.turns, endToEndRenderMs: renderMs, insertionMs, renderPlusInsertionMs: round(renderMs + insertionMs, 1), settledHeapGrowthMiB: growth, collectabilityFailures, thresholds: VIRTUALIZATION_EVIDENCE };
    /* Measured evidence only: representative 2000-turn cost within budget, reuse
     * intact, collectability intact -> DEFERRED; otherwise REQUIRED_REVIEW (never
     * an implementation task). */
    const evidence = (renderMs + insertionMs) >= VIRTUALIZATION_EVIDENCE.endToEndRenderPlusInsertionMs || Number(growth) > VIRTUALIZATION_EVIDENCE.settledHeapGrowthMiB || collectabilityFailures > 0 || perfViolations.length > 0 || !invariantsOk;
    virtualization = { decision: evidence ? 'REQUIRED_REVIEW' : 'DEFERRED', required: evidence ? 'REVIEW' : 'NO', basis: { ...basis, budgetViolations: perfViolations.length, exactEquivalenceReuse: invariantsOk } };
    check(`virtualization: decision recorded from measured evidence (${virtualization.decision})`, Number.isFinite(renderMs) && Number.isFinite(insertionMs) && Number.isFinite(Number(growth)), JSON.stringify(basis));
    row('VIRTUALIZATION_DECISION', virtualization.decision, `${VIRTUALIZATION_EVIDENCE.turns} turns render+insertion ${basis.renderPlusInsertionMs} ms (threshold ${VIRTUALIZATION_EVIDENCE.endToEndRenderPlusInsertionMs}), heap growth ${growth} MiB (threshold ${VIRTUALIZATION_EVIDENCE.settledHeapGrowthMiB}), budget violations ${perfViolations.length}, collectability failures ${collectabilityFailures}`);
  } else row('VIRTUALIZATION_DECISION', 'BLOCKED', 'no measured evidence (benchmarks incomplete)');
  console.log(`VIRTUALIZATION_REQUIRED: ${virtualization.required || 'REVIEW'}`);
  console.log(`VIRTUALIZATION_STATUS: ${virtualization.decision}${virtualization.basis ? ` ${JSON.stringify(virtualization.basis)}` : ''}`);
  console.log(`NB1_STATUS: ${nb1Resolved ? 'RESOLVED_BY_REQUIRED_S5C_ASSURANCE' : 'OPEN'} (rich replay sub-metric instruments Renderer.htmlSanitizer.sanitizeToFragment; one v2 fragment per rich turn ${nb1Resolved ? 'proven' : 'NOT proven'})`);

  /* ---- verdict ---- */
  const rowsPass = Object.entries(matrix).filter(([name]) => name !== 'HDA_ACCEPTANCE_PACKAGE_READY');
  const rowAcceptable = (name, r) => (name === 'VIRTUALIZATION_DECISION' ? r.status === 'DEFERRED' : r.status === 'PASS');
  const allPass = rowsPass.every(([name, r]) => rowAcceptable(name, r));
  row('HDA_ACCEPTANCE_PACKAGE_READY', allPass ? 'YES' : 'NO', allPass ? 'all acceptance rows PASS and virtualization DEFERRED' : rowsPass.filter(([name, r]) => !rowAcceptable(name, r)).map(([name, r]) => `${name}=${r.status}`).join(', '));

  let verdict = 'PASS'; let exitCode = 0;
  const statusOf = (name) => matrix[name]?.status;
  const notEvaluated = Object.values(matrix).some((r) => r.status === 'NOT_EVALUATED' || r.status === 'BLOCKED');
  if (notEvaluated) { verdict = 'BLOCKED'; exitCode = 2; }
  else if (statusOf('SECURITY') !== 'PASS') { verdict = 'SECURITY_REGRESSION'; exitCode = 1; }
  else if (statusOf('SEMANTIC_PARITY') !== 'PASS' || statusOf('EXACT_EQUIVALENCE_REUSE') !== 'PASS') { verdict = 'SEMANTIC_REGRESSION'; exitCode = 1; }
  else if (statusOf('ACCESSIBILITY') !== 'PASS') { verdict = 'ACCESSIBILITY_REGRESSION'; exitCode = 1; }
  else if (statusOf('VISUAL_FIDELITY') === 'FAIL') { verdict = 'VISUAL_REGRESSION'; exitCode = 1; }
  else if (statusOf('MEMORY_COLLECTABILITY') !== 'PASS' || statusOf('LIFECYCLE') !== 'PASS') { verdict = 'MEMORY_REGRESSION'; exitCode = 1; }
  else if (statusOf('PERFORMANCE') === 'FAIL' || statusOf('PERFORMANCE_BUDGETS') === 'FAIL') { verdict = perfEnvMismatch.length ? 'PERFORMANCE_ENVIRONMENT_MISMATCH' : 'PERFORMANCE_REGRESSION'; exitCode = perfEnvMismatch.length ? 3 : 1; }
  else if (statusOf('VISUAL_FIDELITY') === 'INFORMATIONAL') { verdict = 'BASELINE_ENVIRONMENT_MISMATCH'; exitCode = 3; }
  else if (statusOf('PERFORMANCE') === 'INFORMATIONAL') { verdict = 'PERFORMANCE_ENVIRONMENT_MISMATCH'; exitCode = 3; }
  else if (statusOf('VIRTUALIZATION_DECISION') !== 'DEFERRED') { verdict = 'PERFORMANCE_REGRESSION'; exitCode = 1; }
  else if (failures) { verdict = 'BLOCKED'; exitCode = 2; }

  console.log('ACCEPTANCE_MATRIX:');
  for (const [name, r] of Object.entries(matrix)) console.log(`  ROW ${name}: ${r.status}${r.detail ? ` — ${r.detail}` : ''}`);
  console.log(`HDA_ACCEPTANCE_PACKAGE_READY: ${allPass && verdict === 'PASS' ? 'YES' : 'NO'}`);
  console.log('HDA_ACCEPTANCE: PENDING (human decision; never set here)');
  report.matrix = matrix; report.verdict = verdict; report.timingsMs = timings; report.virtualization = virtualization; report.nb1Resolved = nb1Resolved; report.checks = results;
  console.log(`REPORT_WRITTEN: ${writeArtifact('final-assurance-report.json', JSON.stringify(report, null, 2))}`);
  finish(verdict, { matrix: Object.fromEntries(Object.entries(matrix).map(([k, v]) => [k, v.status])), virtualization: virtualization.decision, nb1: nb1Resolved ? 'RESOLVED_BY_REQUIRED_S5C_ASSURANCE' : 'OPEN', budgetWritten, perfEvaluated, crossVerdict, visualVerdict, visualStatus }, exitCode);
}

function finish(verdict, summary, exitCode) {
  console.log(`PERFORMANCE_BUDGET_UPDATE_MODE: ${UPDATE_MODE ? 'ENABLED' : 'DISABLED'}`);
  console.log('VISUAL_BASELINE_UPDATE_MODE: DISABLED');
  console.log(`VERDICT: ${verdict}`);
  console.log(`SUMMARY ${JSON.stringify({ verdict, ...summary })}`);
  console.log(`CHECKS passed=${results.length - failures} failed=${failures}`);
  console.log(verdict === 'PASS' ? `PASS ${results.length}` : `NOT PASS (${verdict})`);
  process.exit(exitCode);
}

main().catch((error) => {
  console.error(error?.stack || String(error));
  check('orchestrator completed without an internal error', false, String(error?.message || error));
  finish('BLOCKED', { reason: 'orchestrator-crash' }, 2);
});
