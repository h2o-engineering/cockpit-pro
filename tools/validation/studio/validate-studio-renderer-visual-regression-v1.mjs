#!/usr/bin/env node
// M03 P5 S5A T9 slice A — deterministic Renderer visual regression matrix.
//
// One dense fixture page (canonical/semantic example with all four roles +
// a rich-replay example) is rendered through the REAL accepted Studio Renderer
// chain (production script order, real studio.css + reference profile CSS) in
// headless Chromium under a pinned context, captured for exactly four matrix
// cells (wide/narrow × dark/light), and compared pixel-for-pixel (decoded RGBA,
// never PNG bytes) against the committed baselines in
// tools/validation/studio/baselines/m03-s5a-v1/.
//
//   SOURCE carrier : src-surfaces-base/studio  — 4 cells × 2 repeats (determinism)
//   PACKED carrier : temporary pack-studio out — 4 cells × 1 (carrier parity)
//   negative control: one in-memory CSS mutation must go red
//
// Normal execution is READ-ONLY against the committed baselines. Baselines are
// rewritten only with the explicit switch --update-baselines (or
// H2O_RENDERER_VISUAL_UPDATE=1), which prints every file it writes.
//
// Verdicts: PASS | VISUAL_REGRESSION | STRUCTURAL_SEMANTIC_DELTA |
//           BASELINE_ENVIRONMENT_MISMATCH | HARNESS_FAILURE | BLOCKED
// Exit codes: 0 PASS (or a completed baseline update), 1 regression/failure,
//             2 BLOCKED (no Playwright/Chromium), 3 environment mismatch.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import process from 'node:process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), '..', '..', '..');
const STUDIO_DIR = path.join(REPO_ROOT, 'src-surfaces-base/studio');
const STUDIO_HTML_REL = 'src-surfaces-base/studio/studio.html';
const PACK_STUDIO_REL = 'tools/product/studio/pack-studio.mjs';
const BASELINE_REL = 'tools/validation/studio/baselines/m03-s5a-v1';
const BASELINE_DIR = path.join(REPO_ROOT, BASELINE_REL);
const MANIFEST_PATH = path.join(BASELINE_DIR, 'manifest.json');
const ARTIFACT_DIR = path.join(REPO_ROOT, 'artifacts/renderer-visual-regression');

const SCHEMA = 'h2o.renderer.visual-regression-baseline';
const SCHEMA_VERSION = 1;
const MATRIX_VERSION = 'm03-s5a-v1';
const FIXTURE_VERSION = 'renderer-visual-matrix.v1';
const REFERENCE_PROFILE = 'chatgpt-reference';
/* The accepted Product state the committed baselines were captured from. */
const PRODUCT_BASELINE_COMMIT = '5438e34a2b392816d8679066e1cfe98bc7279636';

const UPDATE_MODE = process.argv.includes('--update-baselines')
  || /^(1|true|yes)$/i.test(String(process.env.H2O_RENDERER_VISUAL_UPDATE || ''));

/* ----------------------------------------------------------------- matrix -- */

const VIEWPORTS = Object.freeze({
  wide: Object.freeze({ width: 1280, baseHeight: 900 }),
  narrow: Object.freeze({ width: 480, baseHeight: 900 }),
});
const THEMES = Object.freeze({
  dark: Object.freeze({ htmlAttribute: 'dark', colorScheme: 'dark' }),
  light: Object.freeze({ htmlAttribute: 'light', colorScheme: 'light' }),
});
const CELLS = Object.freeze([
  Object.freeze({ id: 'wide-dark', viewport: 'wide', theme: 'dark' }),
  Object.freeze({ id: 'wide-light', viewport: 'wide', theme: 'light' }),
  Object.freeze({ id: 'narrow-dark', viewport: 'narrow', theme: 'dark' }),
  Object.freeze({ id: 'narrow-light', viewport: 'narrow', theme: 'light' }),
]);
const CONTEXT_PINS = Object.freeze({
  deviceScaleFactor: 1,
  locale: 'en-US',
  timezoneId: 'UTC',
  reducedMotion: 'reduce',
});
const MAX_FIT_PASSES = 4;

/* The accepted Renderer chain in production order (studio.html / pack lists). */
const RENDERER_CHAIN = Object.freeze([
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
const STYLESHEETS = Object.freeze([
  'studio.css',
  'renderer/presentation/chatgpt-reference.v1.css',
]);

/* Capture-only normalization: motion and caret are the only nondeterministic
 * presentation sources; nothing else of the Product presentation is touched. */
const CAPTURE_NORMALIZATION_CSS = [
  '*, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; scroll-behavior: auto !important; }',
].join('\n');

/* ---------------------------------------------------------------- fixture -- */

/* Deterministic raster fixtures (embedded; no network). */
const CHART_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAGAAAABACAIAAABqVuVZAAACL0lEQVR42u3Yu20DMQyAYU6SITJEhuAQadKo9gZpUqdOkw2ygTfIGulTHGAY96BIiuJRMg2VB0L+cDqff0DEP8nn0a6H1KGvh9Shr4fUoa+Hub/tR7kQizMf5r4XFECr+TD3SZECbefD3M8REdDufIj5bV/LJ7H48/lAR/uBmPdCI9BtPhOI2A/EPCktQPfzOUD0fiDmc0QNtJpfBaruB2I+ZXVA2/k0EGc/EPM3SAG0O1/3orgDFO0XWgp0NN8GKOD7iwiImG8AZPttX8oPsfjz+UD0fsyOmNW90Ah0m88Equ6nEci+B7UA3c/nAHH20wLUpQepgVbzq0DM/aiBevUgHdB2Pg00cA9SAO3Ob/+zGrQHSYGO5p8F1L0HiYCI+SZAEXsQH6i9B13KO7GC9iAmkEkPooGC9iAOkFUPsgJy7UFVIMMeZALk3YNoINse1A50Qg9q/7N6yjPIpgc9lyuxZgZi3jtuQMwe5ATEP1k+QPwe5HrEggCJepADkKwH9QaS9qDeQOIe1BVI0YO6Aml6kBUQlm9i8XtQPyBlD4oD1PWI6XvQIwA19aAqELMHuQF59yAaiN+DfID4PeirvBFL0INmPWJioKN36wSq/Gs1AULEUECIyAJ6Kr/EsgJa9OMALfsJBDTwEUsgCggRQwE596AK0HIO4wD596A8YgkUAciwB5kAGfYgA6C5e1AesQQaBWjQHuQENHkPyiOWQIMAZQ/KHpRHLIGyBwmA/gEPITOB7d/BWAAAAABJRU5ErkJggg==';
const PHOTO_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAABP0lEQVR42u3ayU1DQRCEYQdWcbKZxew7Bgw5+OwMyKBCIABsaTRdPfWwWvqO7+D/YI2me2aL5Xqr9eZnq6l9P6uACqiACqiAUMB/+aG7vq+APQvgJVpMLoBX6OMP4DXibAG8gYohgLfQ6gzo+DPxDnnST2LeI1tywAOyJQbwEWOkBPAJI4kD+IzxpAEvGE8WwFe4aO4DfIOL5iTmEi6CAL7DKxzwAa9wwCe8wgEreIUDvuAVDviGV/Q+wAN4RU9iHsIrHHAEr3DAMbzCASfwCgfM4RUOOIWX4j5wBhfRfeAcLqL7wAVcZKNFLjCecjbaOPjXEg93u5cAfVKm05JtQIvE8bpwJ7BL7n5Avhb4q/YDbZsS+VrA8NRAuBOwvZWQbAP8jz26lwCTe63SPviv5zb1Xqie21RABVRABexDwC89PM9bFZpv0gAAAABJRU5ErkJggg==';

const T0 = 1757664000; /* fixed epoch seconds (2026-09-12T08:00:00Z) */

/* A. canonical / semantic example: Studio-normalized input, Markdown bodies,
 * all four roles, one user image attachment. Rendered through normalize ->
 * Markdown engine -> Render IR -> ContentRenderer (renderMode "canonical"). */
const CANONICAL_INPUT = Object.freeze({
  chatId: 'chat-visual-matrix',
  snapshotId: 'snap-visual-matrix',
  meta: { title: 'Renderer visual matrix' },
  messages: [
    {
      role: 'user', messageId: 'vm-u1', turnId: 'vm-t1', createTime: T0,
      text: 'Can you summarise the **quarterly report**, show the numbers as a table, and describe the attached chart?',
      attachments: [{ kind: 'image', thumbnailSrc: PHOTO_PNG, alt: 'Attached photo', captureStatus: 'captured', naturalWidth: 64, naturalHeight: 64 }],
    },
    {
      role: 'assistant', messageId: 'vm-a1', turnId: 'vm-t1', createTime: T0 + 60,
      text: [
        '## Quarterly summary',
        '',
        'Revenue grew **12.4%** quarter over quarter while *operating costs* stayed flat; the `net-margin` metric is documented in the [reporting guide](https://example.test/reports/guide).',
        '',
        '- Regions',
        '  - EMEA — steady growth',
        '  - APAC — new markets',
        '    - Japan pilot',
        '  - Americas — flat',
        '- Products',
        '  - Studio',
        '  - Desktop',
        '',
        '1. Close the books',
        '2. Publish the report',
        '3. Brief the board',
        '',
        '> Guidance is unchanged for the second half; risks are listed below the table.',
        '',
        '---',
        '',
        '```js',
        'const margin = (revenue, costs) => (revenue - costs) / revenue;',
        'console.log(margin(1240, 980).toFixed(3)); // 0.210',
        '```',
        '',
        '| Region | Q1 | Q2 | Δ |',
        '|:-------|---:|---:|:-:|',
        '| EMEA | 410 | 462 | +12.7% |',
        '| APAC | 285 | 331 | +16.1% |',
        '| Americas | 545 | 547 | +0.4% |',
        '',
        '![Revenue by region](' + CHART_PNG + ')',
        '',
        'Multilingual check: Grüße aus Zürich · こんにちは世界 · مرحبا بالعالم · Привет, мир · 你好，世界 · 🚀 ✅',
        '',
        '- [x] Data reconciled',
        '- [ ] Board deck pending',
      ].join('\n'),
    },
    { role: 'system', messageId: 'vm-s1', createTime: T0 + 120, text: 'System notice: this transcript was captured on 2026-09-12 and rendered by the Studio Renderer visual matrix.' },
    { role: 'tool', messageId: 'vm-x1', createTime: T0 + 180, text: 'Tool result: `{"status":"ok","rows":3}` — table verified against the ledger.' },
    { role: 'user', messageId: 'vm-u2', turnId: 'vm-t2', createTime: T0 + 240, text: 'Thanks. Which region should we prioritise next quarter?' },
    {
      role: 'assistant', messageId: 'vm-a2', turnId: 'vm-t2', createTime: T0 + 300,
      text: ['**APAC**, because its growth rate and pipeline are the strongest:', '', '1. Fund the Japan pilot', '2. Hire two regional sellers', '', 'Estimated uplift: `+9%` next quarter.'].join('\n'),
    },
  ],
});

/* B. rich replay example: provider-shaped captured markup mounted through the
 * accepted rich replay path (sanitizer v2; whole-transcript coverage). Visual
 * coverage only; rich-replay semantics are not the subject of this matrix. */
const richTurn = (role, idx, inner, ids) => ({
  role, turnIdx: idx, messageId: ids.messageId, turnId: ids.turnId, createTime: T0 + 600 + idx * 60,
  outerHTML: '<article data-testid="conversation-turn-' + idx + '"><div class="group/turn-messages"><div data-message-author-role="' + role + '" data-message-id="prov-' + idx + '" dir="auto">' + inner + '</div></div></article>',
});
const richBubble = (text) => '<div class="flex w-full flex-col gap-1 items-end"><div class="relative rounded-3xl user-message-bubble-color"><div class="whitespace-pre-wrap">' + text + '</div></div></div>';
const RICH_PROSE_1 = '<div class="markdown prose w-full break-words dark"><h2>Replay heading</h2><p>Provider markup with <strong>strong</strong>, <em>emphasis</em> and <code>inline code</code> survives the accepted sanitizer.</p><ul><li>First item<ul><li>Nested item</li></ul></li><li>Second item</li></ul><ol><li>Step one</li><li>Step two</li></ol><blockquote><p>A quoted line inside rich replay.</p></blockquote><table><thead><tr><th>Key</th><th>Value</th></tr></thead><tbody><tr><td>mode</td><td>rich</td></tr><tr><td>sanitizer</td><td>v2</td></tr></tbody></table><pre><code class="language-js">const replay = true;</code></pre></div>';
const RICH_PROSE_2 = '<div class="markdown prose w-full break-words dark"><p>Short closing answer with a <a href="https://example.test/replay">safe link</a>.</p></div>';
const RICH_INPUT = Object.freeze({
  chatId: 'chat-visual-rich',
  snapshotId: 'snap-visual-rich',
  meta: { title: 'Renderer visual matrix — rich replay' },
  messages: [
    { role: 'user', text: 'Show me the replay.', messageId: 'vr-u1', turnId: 'vr-t1' },
    { role: 'assistant', text: 'Replay heading …', messageId: 'vr-a1', turnId: 'vr-t1' },
    { role: 'user', text: 'And a short one?', messageId: 'vr-u2', turnId: 'vr-t2' },
    { role: 'assistant', text: 'Short closing answer.', messageId: 'vr-a2', turnId: 'vr-t2' },
  ],
  richTurns: [
    richTurn('user', 1, richBubble('Show me the replay.'), { messageId: 'vr-u1', turnId: 'vr-t1' }),
    richTurn('assistant', 2, RICH_PROSE_1, { messageId: 'vr-a1', turnId: 'vr-t1' }),
    richTurn('user', 3, richBubble('And a short one?'), { messageId: 'vr-u2', turnId: 'vr-t2' }),
    richTurn('assistant', 4, RICH_PROSE_2, { messageId: 'vr-a2', turnId: 'vr-t2' }),
  ],
});

/* ---------------------------------------------------------------- helpers -- */

const results = [];
let failures = 0;
function check(label, ok, detail = '') {
  results.push({ label, ok, detail });
  if (!ok) failures += 1;
  console.log(`${ok ? '✓' : '✗'} ${label}${ok || !detail ? '' : `  -> ${detail}`}`);
}
function sha256(input) { return crypto.createHash('sha256').update(input).digest('hex'); }
function readRepo(rel) { return fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8'); }
function finish(verdict, summary, exitCode) {
  console.log(`BASELINE_UPDATE_MODE: ${UPDATE_MODE ? 'ENABLED' : 'DISABLED'}`);
  console.log(`VERDICT: ${verdict}`);
  console.log(`SUMMARY ${JSON.stringify({ verdict, ...summary })}`);
  console.log(`CHECKS passed=${results.length - failures} failed=${failures}`);
  console.log(verdict === 'PASS' ? `PASS ${results.length}` : `NOT PASS (${verdict})`);
  process.exit(exitCode);
}

/* ------------------------------------------------------------- playwright -- */

async function resolvePlaywright() {
  const override = process.env.H2O_PLAYWRIGHT_MODULE;
  if (override) {
    if (!fs.existsSync(override)) return null;
    const dir = fs.statSync(override).isDirectory() ? override : path.dirname(override);
    const entry = fs.statSync(override).isDirectory() ? path.join(override, 'index.js') : override;
    const mod = await import(pathToFileURL(entry).href);
    let version = null;
    try { version = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version || null; } catch {}
    return { chromium: mod?.chromium || mod?.default?.chromium || null, version };
  }
  try {
    const mod = await import('playwright');
    let version = null;
    try { version = JSON.parse(fs.readFileSync(createRequire(import.meta.url).resolve('playwright/package.json'), 'utf8')).version || null; } catch {}
    return { chromium: mod?.chromium || mod?.default?.chromium || null, version };
  } catch { return null; }
}

function resolveChromiumExecutable(chromium) {
  const candidates = [process.env.H2O_RENDERER_VISUAL_CHROMIUM, chromium.executablePath()].filter(Boolean);
  for (const candidate of candidates) {
    try { fs.accessSync(candidate); return candidate; } catch {}
  }
  return null;
}

/* ------------------------------------------------------------- fixture page -- */

/* The Reader-route container chain (body[data-route="reader"] > main.wbMain >
 * section.wbReader) is the production one. Each example gets its own Reader
 * host inside a harness-owned auto-height cell, and both cells sit in one
 * harness fixture block that occupies the Reader main's single grid row: the
 * app shell is what sizes a Reader host in production, and auto-height cells
 * let both transcripts take their natural height so the whole fixture fits one
 * fitted viewport (nothing overlaps, nothing is clipped). */
function fixtureHtml(theme) {
  return `<!doctype html><html lang="en" data-h2o-theme="${THEMES[theme].htmlAttribute}"><head><meta charset="utf-8"><title>Renderer visual matrix</title></head>`
    + '<body data-h2o-studio-mode="1" data-route="reader"><main class="wbMain"><div data-h2o-visual-fixture="1">'
    + '<div data-h2o-visual-cell="canonical"><section id="viewReader" class="wbReader"></section></div>'
    + '<div data-h2o-visual-cell="rich"><section id="viewReaderRich" class="wbReader"></section></div>'
    + '</div></main></body></html>';
}

/* Executed in the page: render both examples through H2O.Studio.chatRenderer,
 * mount them into the Reader host, and return the companion fingerprint inputs
 * plus the programmatic coverage facts. Nothing here re-implements Renderer
 * logic; it only calls the public Renderer API and reads the resulting DOM. */
function RENDER_IN_PAGE(inputs) {
  const cr = globalThis.H2O && globalThis.H2O.Studio && globalThis.H2O.Studio.chatRenderer;
  if (!cr || typeof cr.render !== 'function') throw new Error('H2O.Studio.chatRenderer is not installed');
  const results = [];
  for (const [label, input] of inputs) {
    const host = document.querySelector(`[data-h2o-visual-cell="${label}"] > .wbReader`);
    if (!host) throw new Error(`no Reader host for ${label}`);
    const r = cr.render(JSON.parse(JSON.stringify(input)), { getEditOverride: () => null });
    host.appendChild(r.root);
    const ix = r.semanticIndex;
    const roles = { user: 0, assistant: 0, system: 0, tool: 0 };
    for (const m of ix.messages()) roles[m.role] = (roles[m.role] || 0) + 1;
    const q = (sel) => r.root.querySelectorAll(sel).length;
    results.push({
      label,
      renderMode: r.renderMode,
      semanticSource: r.semanticSource,
      messageCount: ix.messages().length,
      roles,
      index: { conversation: 1, turns: ix.turns().length, messages: ix.messages().length, blocks: ix.blocks().length, texts: ix.texts().length },
      contributions: r.decorationContributions.list().length,
      outerHTML: r.root.outerHTML,
      textContent: r.root.textContent,
      coverage: {
        roleUser: q('.cgMsg[data-message-author-role="user"]'), roleAssistant: q('.cgMsg[data-message-author-role="assistant"]'), roleSystem: q('.cgMsg[data-message-author-role="system"]'), roleTool: q('.cgMsg[data-message-author-role="tool"]'),
        heading: q('h1, h2, h3'), paragraph: q('p'), strong: q('strong, b'), emphasis: q('em, i'), inlineCode: q(':not(pre) > code'), nestedList: q('ul li ul, ol li ul, ul li ol'), orderedList: q('ol'), blockquote: q('blockquote'),
        codeBlock: q('pre code, pre'), table: q('table'), link: q('a[href^="https://"]'), image: q('img'), attachmentImage: q('.cgUserAttachmentCard img'), thematicBreak: q('hr'), taskItem: q('[data-h2o-task-marker], input[type="checkbox"], .task-list-item, li[data-task]'),
        unicode: /こんにちは|مرحبا|Привет|你好|Grüße/.test(r.root.textContent) ? 1 : 0,
        userBubble: q('.user-message-bubble-color'),
      },
    });
  }
  return results;
}

/* Executed in the page after mount: wait for fonts + images, then report the
 * scroll extent of the Reader main so the viewport can be fitted to the whole
 * fixture (nothing is clipped; no scrollbars remain). */
async function SETTLE_IN_PAGE() {
  await document.fonts.ready;
  const images = Array.from(document.images);
  for (const img of images) { try { img.scrollIntoView({ block: 'center' }); } catch {} }
  await Promise.all(images.map((img) => (typeof img.decode === 'function' ? img.decode().catch(() => null) : Promise.resolve())));
  window.scrollTo(0, 0);
  const main = document.querySelector('.wbMain');
  main.scrollTop = 0;
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  return { scrollHeight: Math.ceil(main.scrollHeight), clientHeight: main.clientHeight, imageCount: images.length, imagesComplete: images.every((img) => img.complete && img.naturalWidth > 0) };
}

async function captureCell({ chromium, executable, studioDir, cell, negativeControlCss = null }) {
  const viewport = VIEWPORTS[cell.viewport];
  const theme = THEMES[cell.theme];
  const blockedRequests = [];
  const pageErrors = [];
  const browser = await chromium.launch({
    headless: true,
    executablePath: executable,
    args: ['--disable-background-networking', '--disable-component-update', '--disable-default-apps', '--hide-scrollbars', '--force-color-profile=srgb', '--disable-gpu'],
  });
  try {
    const context = await browser.newContext({
      viewport: { width: viewport.width, height: viewport.baseHeight },
      deviceScaleFactor: CONTEXT_PINS.deviceScaleFactor,
      locale: CONTEXT_PINS.locale,
      timezoneId: CONTEXT_PINS.timezoneId,
      reducedMotion: CONTEXT_PINS.reducedMotion,
      colorScheme: theme.colorScheme,
      offline: true,
    });
    /* No resource may leave the page: everything is inlined from the carrier. */
    await context.route('**/*', (route) => { blockedRequests.push(route.request().url()); route.abort(); });
    const page = await context.newPage();
    page.on('pageerror', (error) => pageErrors.push(String(error)));
    await page.setContent(fixtureHtml(cell.theme), { waitUntil: 'load' });
    for (const rel of STYLESHEETS) await page.addStyleTag({ path: path.join(studioDir, rel) });
    await page.addStyleTag({ content: CAPTURE_NORMALIZATION_CSS });
    for (const rel of RENDERER_CHAIN) await page.addScriptTag({ path: path.join(studioDir, rel) });
    const rendered = await page.evaluate(RENDER_IN_PAGE, [['canonical', CANONICAL_INPUT], ['rich', RICH_INPUT]]);
    /* Fit the viewport height to the full fixture extent (iterate until stable). */
    let settle = await page.evaluate(SETTLE_IN_PAGE);
    let height = viewport.baseHeight;
    for (let pass = 0; pass < MAX_FIT_PASSES && settle.scrollHeight > height; pass += 1) {
      height = settle.scrollHeight;
      await page.setViewportSize({ width: viewport.width, height });
      settle = await page.evaluate(SETTLE_IN_PAGE);
    }
    if (negativeControlCss) {
      await page.addStyleTag({ content: negativeControlCss });
      settle = await page.evaluate(SETTLE_IN_PAGE);
    }
    const png = await page.locator('[data-h2o-visual-fixture="1"]').screenshot({ type: 'png', animations: 'disabled', caret: 'hide', scale: 'css' });
    const browserVersion = browser.version();
    return { png, rendered, settle, height, width: viewport.width, blockedRequests, pageErrors, browserVersion };
  } finally {
    await browser.close();
  }
}

/* Decoded-RGBA comparison performed by Chromium itself (no image dependency). */
async function COMPARE_IN_PAGE([a, b, wantDiff]) {
  const decode = async (base64) => {
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
    const canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true, colorSpace: 'srgb' });
    ctx.drawImage(bitmap, 0, 0);
    return { width: bitmap.width, height: bitmap.height, data: ctx.getImageData(0, 0, bitmap.width, bitmap.height).data, canvas, ctx };
  };
  const A = await decode(a); const B = await decode(b);
  const out = { a: { width: A.width, height: A.height }, b: { width: B.width, height: B.height }, sameDimensions: A.width === B.width && A.height === B.height, differingPixels: 0, diffPng: null };
  if (!out.sameDimensions) return out;
  const n = A.width * A.height; const diff = wantDiff ? A.ctx.createImageData(A.width, A.height) : null;
  for (let i = 0; i < n; i += 1) {
    const o = i * 4;
    const same = A.data[o] === B.data[o] && A.data[o + 1] === B.data[o + 1] && A.data[o + 2] === B.data[o + 2] && A.data[o + 3] === B.data[o + 3];
    if (!same) out.differingPixels += 1;
    if (diff) { const g = same ? Math.round((A.data[o] + A.data[o + 1] + A.data[o + 2]) / 3) : 0; diff.data[o] = same ? g : 255; diff.data[o + 1] = same ? g : 0; diff.data[o + 2] = same ? g : 96; diff.data[o + 3] = 255; }
  }
  if (diff && out.differingPixels > 0) { A.ctx.putImageData(diff, 0, 0); out.diffPng = A.canvas.toDataURL('image/png').split(',')[1]; }
  return out;
}

async function openComparer(chromium, executable) {
  const browser = await chromium.launch({ headless: true, executablePath: executable, args: ['--disable-background-networking', '--force-color-profile=srgb', '--disable-gpu'] });
  const page = await browser.newPage();
  await page.setContent('<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>');
  return {
    async compare(pngA, pngB, wantDiff = false) { return page.evaluate(COMPARE_IN_PAGE, [pngA.toString('base64'), pngB.toString('base64'), !!wantDiff]); },
    async close() { await browser.close(); },
  };
}

/* ---------------------------------------------------------------- run -- */

function fingerprintOf(rendered) {
  return rendered.map((r) => ({
    label: r.label,
    renderMode: r.renderMode,
    semanticSource: r.semanticSource,
    messageCount: r.messageCount,
    roles: r.roles,
    index: r.index,
    contributions: r.contributions,
    outerHtmlSha256: sha256(r.outerHTML),
    textContentSha256: sha256(r.textContent),
  }));
}

function environmentOf(playwrightVersion, browserVersion, executable) {
  const release = os.release();
  return {
    browserFamily: 'chromium',
    browserVersion,
    browserExecutableName: path.basename(executable),
    browserBuildDir: path.basename(path.dirname(path.dirname(path.dirname(path.dirname(path.dirname(executable)))))),
    playwrightVersion,
    platform: process.platform,
    arch: process.arch,
    osRelease: release,
    osMajor: String(release).split('.')[0],
  };
}
const STRICT_ENV_KEYS = ['browserFamily', 'browserVersion', 'platform', 'arch', 'osMajor'];

function writeArtifact(name, bytes) {
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  const target = path.join(ARTIFACT_DIR, name);
  fs.writeFileSync(target, bytes);
  return path.relative(REPO_ROOT, target);
}

async function main() {
  console.log(`BASELINE_UPDATE_MODE: ${UPDATE_MODE ? 'ENABLED' : 'DISABLED'}`);
  const pw = await resolvePlaywright();
  if (!pw || !pw.chromium) {
    console.log('BLOCKED: Playwright is unavailable (set H2O_PLAYWRIGHT_MODULE or NODE_PATH to a runtime carrying the playwright package). jsdom is not a substitute for this real-browser matrix.');
    finish('BLOCKED', { reason: 'playwright-unavailable' }, 2);
  }
  const executable = resolveChromiumExecutable(pw.chromium);
  if (!executable) {
    console.log('BLOCKED: no installed Chromium executable (H2O_RENDERER_VISUAL_CHROMIUM or the Playwright chromium build).');
    finish('BLOCKED', { reason: 'chromium-unavailable' }, 2);
  }

  /* Chain consistency: the harness chain is the production order. */
  const html = readRepo(STUDIO_HTML_REL);
  const refs = [...html.matchAll(/<script src="\.\/([^"?]+)(?:\?[^"]*)?"><\/script>/g)].map((m) => m[1]);
  const chainInHtml = refs.filter((r) => RENDERER_CHAIN.includes(r));
  check('harness Renderer chain equals the production script order (studio.html)', JSON.stringify(chainInHtml) === JSON.stringify([...RENDERER_CHAIN]), JSON.stringify(chainInHtml));
  check('harness stylesheets are the production stylesheets (studio.css + reference profile)', html.includes('href="./studio.css?') && html.includes('href="./renderer/presentation/chatgpt-reference.v1.css?'));

  /* Packed carrier: a disposable pack-studio out directory (never a live path). */
  const packer = await import(pathToFileURL(path.join(REPO_ROOT, PACK_STUDIO_REL)).href);
  const tempOut = fs.mkdtempSync(path.join(os.tmpdir(), 'h2o-renderer-visual-'));
  let packedStudioDir = null;
  const summary = { matrixVersion: MATRIX_VERSION, cells: {}, captures: { source: 0, packed: 0, negativeControl: 0 } };
  const comparer = await openComparer(pw.chromium, executable);
  let manifest = null;
  let environment = null;
  let verdict = 'PASS';
  let exitCode = 0;
  try {
    packer.syncArchiveWorkbenchToOut(REPO_ROOT, tempOut);
    packedStudioDir = packer.archiveWorkbenchOutDir(tempOut);
    check('packed Studio carrier staged in a disposable temp directory', packedStudioDir.startsWith(os.tmpdir()) && fs.existsSync(path.join(packedStudioDir, 'renderer/chat-renderer.studio.js')), packedStudioDir);
    for (const rel of [...RENDERER_CHAIN, ...STYLESHEETS]) {
      const same = fs.readFileSync(path.join(STUDIO_DIR, rel)).equals(fs.readFileSync(path.join(packedStudioDir, rel)));
      if (!same) check(`packed carrier byte-identical: ${rel}`, false, 'bytes differ');
    }
    check('packed carrier Renderer chain + stylesheets byte-identical to source', true);

    /* Baseline manifest (read-only unless updating). */
    if (!UPDATE_MODE) {
      if (!fs.existsSync(MANIFEST_PATH)) {
        check('committed baseline manifest exists', false, `${path.relative(REPO_ROOT, MANIFEST_PATH)} missing (run with --update-baselines to create it)`);
        verdict = 'HARNESS_FAILURE'; exitCode = 1;
        return;
      }
      manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
      check('committed baseline manifest schema', manifest.schema === SCHEMA && manifest.schemaVersion === SCHEMA_VERSION && manifest.matrixVersion === MATRIX_VERSION, JSON.stringify({ schema: manifest.schema, schemaVersion: manifest.schemaVersion, matrixVersion: manifest.matrixVersion }));
    }

    const sourceCaptures = {};
    const packedCaptures = {};
    /* SOURCE: 4 cells × 2 repeats. */
    for (const cell of CELLS) {
      const first = await captureCell({ chromium: pw.chromium, executable, studioDir: STUDIO_DIR, cell });
      const second = await captureCell({ chromium: pw.chromium, executable, studioDir: STUDIO_DIR, cell });
      summary.captures.source += 2;
      sourceCaptures[cell.id] = first;
      if (!environment) environment = environmentOf(pw.version, first.browserVersion, executable);
      check(`${cell.id}: no page errors and no network requests (source, both repeats)`, first.pageErrors.length === 0 && second.pageErrors.length === 0 && first.blockedRequests.length === 0 && second.blockedRequests.length === 0, JSON.stringify({ errors: [...first.pageErrors, ...second.pageErrors], requests: [...first.blockedRequests, ...second.blockedRequests] }));
      check(`${cell.id}: fixture images decoded before capture (${first.settle.imageCount} images)`, first.settle.imagesComplete && second.settle.imagesComplete && first.settle.imageCount === second.settle.imageCount && first.settle.imageCount > 0, JSON.stringify([first.settle, second.settle]));
      check(`${cell.id}: viewport fitted to the whole fixture (no clipped transcript)`, first.settle.scrollHeight <= first.settle.clientHeight && second.settle.scrollHeight <= second.settle.clientHeight, JSON.stringify([first.settle, second.settle]));
      const repeat = await comparer.compare(first.png, second.png, false);
      check(`${cell.id}: SOURCE repeat determinism — identical dimensions and RGBA (${repeat.a.width}×${repeat.a.height})`, repeat.sameDimensions && repeat.differingPixels === 0, JSON.stringify(repeat));
      const fpA = fingerprintOf(first.rendered); const fpB = fingerprintOf(second.rendered);
      check(`${cell.id}: companion fingerprints deterministic across repeats`, JSON.stringify(fpA) === JSON.stringify(fpB));
      summary.cells[cell.id] = { width: repeat.a.width, height: repeat.a.height, repeatDifferingPixels: repeat.differingPixels, fingerprint: fpA };
    }
    /* Coverage assertions on the canonical + rich renders (source, first cell). */
    const coverageRender = sourceCaptures['wide-dark'].rendered;
    const canonical = coverageRender.find((r) => r.label === 'canonical');
    const rich = coverageRender.find((r) => r.label === 'rich');
    const c = canonical.coverage;
    check('coverage: four canonical roles rendered (user / assistant / system / tool)', c.roleUser >= 2 && c.roleAssistant >= 2 && c.roleSystem === 1 && c.roleTool === 1, JSON.stringify(c));
    check('coverage: canonical content — heading, paragraph, strong, emphasis, inline code, nested list, ordered list, blockquote, thematic break, code block, table, https link, Markdown image, image attachment, task items, multilingual text',
      c.heading >= 1 && c.paragraph >= 4 && c.strong >= 2 && c.emphasis >= 1 && c.inlineCode >= 2 && c.nestedList >= 2 && c.orderedList >= 2 && c.blockquote >= 1 && c.thematicBreak >= 1 && c.codeBlock >= 1 && c.table >= 1 && c.link >= 1 && c.image >= 2 && c.attachmentImage === 1 && c.taskItem >= 2 && c.unicode === 1, JSON.stringify(c));
    check('coverage: render modes — canonical/semantic (Render IR) and rich replay', canonical.renderMode === 'canonical' && canonical.index.blocks > 0 && canonical.index.texts > 0 && rich.renderMode === 'rich' && rich.coverage.userBubble >= 2 && rich.coverage.heading >= 1 && rich.coverage.table >= 1 && rich.coverage.blockquote >= 1 && rich.coverage.codeBlock >= 1, JSON.stringify({ canonical: { mode: canonical.renderMode, index: canonical.index }, rich: { mode: rich.renderMode, coverage: rich.coverage } }));
    check('coverage: no decoration consumer is loaded — zero contributions, Renderer output only', canonical.contributions === 0 && rich.contributions === 0);
    check('coverage: viewports wide (1280) + narrow (480); themes dark + light', CELLS.length === 4 && VIEWPORTS.wide.width === 1280 && VIEWPORTS.narrow.width === 480 && Object.keys(THEMES).join(',') === 'dark,light');

    /* PACKED: 4 cells × 1, compared to the source raster of the same cell. */
    for (const cell of CELLS) {
      const packed = await captureCell({ chromium: pw.chromium, executable, studioDir: packedStudioDir, cell });
      summary.captures.packed += 1;
      packedCaptures[cell.id] = packed;
      const parity = await comparer.compare(sourceCaptures[cell.id].png, packed.png, false);
      check(`${cell.id}: SOURCE vs PACKED carrier raster parity`, packed.pageErrors.length === 0 && packed.blockedRequests.length === 0 && parity.sameDimensions && parity.differingPixels === 0, JSON.stringify({ parity, errors: packed.pageErrors }));
      check(`${cell.id}: SOURCE vs PACKED companion fingerprints identical`, JSON.stringify(fingerprintOf(packed.rendered)) === JSON.stringify(summary.cells[cell.id].fingerprint));
      summary.cells[cell.id].packedDifferingPixels = parity.differingPixels;
    }

    if (UPDATE_MODE) {
      fs.mkdirSync(BASELINE_DIR, { recursive: true });
      const images = {};
      for (const cell of CELLS) {
        const target = path.join(BASELINE_DIR, `${cell.id}.png`);
        fs.writeFileSync(target, sourceCaptures[cell.id].png);
        console.log(`BASELINE_WRITTEN: ${path.relative(REPO_ROOT, target)}`);
        images[cell.id] = { file: `${cell.id}.png`, width: summary.cells[cell.id].width, height: summary.cells[cell.id].height, sha256: sha256(sourceCaptures[cell.id].png), fingerprint: summary.cells[cell.id].fingerprint };
      }
      const written = {
        schema: SCHEMA, schemaVersion: SCHEMA_VERSION, matrixVersion: MATRIX_VERSION, fixtureVersion: FIXTURE_VERSION,
        productBaselineCommit: PRODUCT_BASELINE_COMMIT, referenceProfile: REFERENCE_PROFILE,
        viewports: VIEWPORTS, themes: THEMES, context: CONTEXT_PINS, cells: CELLS.map((cell) => cell.id),
        environment, images,
      };
      fs.writeFileSync(MANIFEST_PATH, `${JSON.stringify(written, null, 2)}\n`);
      console.log(`BASELINE_WRITTEN: ${path.relative(REPO_ROOT, MANIFEST_PATH)}`);
      manifest = written;
    }

    /* Environment policy: an exact-pixel verdict is only trustworthy in the baseline environment. */
    const expectedEnv = manifest.environment || {};
    const envMismatch = STRICT_ENV_KEYS.filter((key) => String(expectedEnv[key]) !== String(environment[key]));
    summary.environment = { expected: expectedEnv, actual: environment, strictKeys: STRICT_ENV_KEYS, mismatch: envMismatch };
    if (envMismatch.length) {
      console.log(`BASELINE_ENVIRONMENT_MISMATCH: ${envMismatch.map((key) => `${key} expected=${expectedEnv[key]} actual=${environment[key]}`).join('; ')}`);
    }

    /* Baseline comparison: decoded RGBA of the committed PNG vs the source capture. */
    let visualDelta = false; let structuralDelta = false;
    for (const cell of CELLS) {
      const baselinePath = path.join(BASELINE_DIR, `${cell.id}.png`);
      const entry = manifest.images && manifest.images[cell.id];
      if (!entry || !fs.existsSync(baselinePath)) { check(`${cell.id}: committed baseline PNG present`, false, `${path.relative(REPO_ROOT, baselinePath)} missing`); visualDelta = true; continue; }
      const baselinePng = fs.readFileSync(baselinePath);
      check(`${cell.id}: committed baseline PNG bytes match the manifest SHA-256`, sha256(baselinePng) === entry.sha256, `manifest ${entry.sha256} vs file ${sha256(baselinePng)}`);
      const cmp = await comparer.compare(baselinePng, sourceCaptures[cell.id].png, true);
      const fingerprintSame = JSON.stringify(entry.fingerprint) === JSON.stringify(summary.cells[cell.id].fingerprint);
      summary.cells[cell.id].baselineDifferingPixels = cmp.sameDimensions ? cmp.differingPixels : -1;
      summary.cells[cell.id].baselineDimensions = { baseline: cmp.a, candidate: cmp.b };
      summary.cells[cell.id].fingerprintMatchesBaseline = fingerprintSame;
      const pixelOk = cmp.sameDimensions && cmp.differingPixels === 0;
      if (envMismatch.length) {
        console.log(`${cell.id}: informational (environment mismatch) DIFFERING_PIXELS=${cmp.sameDimensions ? cmp.differingPixels : 'dimensions differ'} fingerprint=${fingerprintSame ? 'same' : 'DIFFERENT'}`);
      } else {
        check(`${cell.id}: SOURCE vs committed baseline — same dimensions, DIFFERING_PIXELS=${cmp.sameDimensions ? cmp.differingPixels : 'n/a'}`, pixelOk, JSON.stringify({ a: cmp.a, b: cmp.b, differingPixels: cmp.differingPixels }));
        check(`${cell.id}: companion fingerprint matches the manifest (${fingerprintSame ? 'VISUAL_ONLY classification available' : 'STRUCTURAL_SEMANTIC_DELTA'})`, fingerprintSame, JSON.stringify({ expected: entry.fingerprint, actual: summary.cells[cell.id].fingerprint }));
      }
      if (!pixelOk) visualDelta = true;
      if (!fingerprintSame) structuralDelta = true;
      if (!pixelOk || !fingerprintSame) {
        const candidateRel = writeArtifact(`${cell.id}-candidate.png`, sourceCaptures[cell.id].png);
        const files = [candidateRel];
        if (cmp.diffPng) files.push(writeArtifact(`${cell.id}-diff.png`, Buffer.from(cmp.diffPng, 'base64')));
        files.push(writeArtifact(`${cell.id}-diagnostics.json`, JSON.stringify({ cell: cell.id, differingPixels: cmp.differingPixels, dimensions: { baseline: cmp.a, candidate: cmp.b }, fingerprintSame, expectedFingerprint: entry.fingerprint, actualFingerprint: summary.cells[cell.id].fingerprint, environment: summary.environment }, null, 2)));
        console.log(`FAILURE_ARTIFACTS: ${files.join(', ')}`);
      }
      const packedCmp = await comparer.compare(baselinePng, packedCaptures[cell.id].png, false);
      summary.cells[cell.id].packedBaselineDifferingPixels = packedCmp.sameDimensions ? packedCmp.differingPixels : -1;
      if (!envMismatch.length) check(`${cell.id}: PACKED vs committed baseline — DIFFERING_PIXELS=${packedCmp.sameDimensions ? packedCmp.differingPixels : 'n/a'}`, packedCmp.sameDimensions && packedCmp.differingPixels === 0);
    }

    /* Negative sensitivity control: one in-memory CSS mutation must go red. */
    const control = await captureCell({ chromium: pw.chromium, executable, studioDir: STUDIO_DIR, cell: CELLS[0], negativeControlCss: '[data-h2o-visual-negative-control], .cgMsg { outline: 3px solid #ff0066 !important; outline-offset: -3px !important; }' });
    summary.captures.negativeControl += 1;
    const controlBaseline = fs.existsSync(path.join(BASELINE_DIR, `${CELLS[0].id}.png`)) ? fs.readFileSync(path.join(BASELINE_DIR, `${CELLS[0].id}.png`)) : sourceCaptures[CELLS[0].id].png;
    const controlCmp = await comparer.compare(controlBaseline, control.png, false);
    summary.negativeControlDifferingPixels = controlCmp.sameDimensions ? controlCmp.differingPixels : -1;
    check(`negative visual control (${CELLS[0].id}, injected outline): DIFFERING_PIXELS=${summary.negativeControlDifferingPixels} > 0`, controlCmp.sameDimensions && controlCmp.differingPixels > 0, JSON.stringify(controlCmp));
    check('negative control never touched Product bytes or committed baselines', fs.readFileSync(path.join(STUDIO_DIR, 'studio.css')).length > 0 && (UPDATE_MODE || sha256(fs.readFileSync(path.join(BASELINE_DIR, `${CELLS[0].id}.png`))) === manifest.images[CELLS[0].id].sha256));

    if (envMismatch.length) { verdict = 'BASELINE_ENVIRONMENT_MISMATCH'; exitCode = 3; }
    else if (failures) { verdict = structuralDelta ? 'STRUCTURAL_SEMANTIC_DELTA' : (visualDelta ? 'VISUAL_REGRESSION' : 'HARNESS_FAILURE'); exitCode = 1; }
  } finally {
    await comparer.close();
    fs.rmSync(tempOut, { recursive: true, force: true });
  }
  summary.baselineDir = BASELINE_REL;
  summary.productBaselineCommit = manifest ? manifest.productBaselineCommit : null;
  finish(verdict, summary, exitCode);
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  finish('HARNESS_FAILURE', { error: String(error && error.message || error) }, 1);
});
