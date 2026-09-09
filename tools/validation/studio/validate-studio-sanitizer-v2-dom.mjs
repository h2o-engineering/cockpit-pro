#!/usr/bin/env node
// Tier 2 real-browser validation for the Renderer sanitizer v2.
//
// Tier 1 proves policy decisions with no DOM. Only a real browser can prove the
// parser-dependent properties: mutation-XSS, namespace confusion, DOM
// clobbering, fragment identity and actual non-execution.
//
// Playwright is NOT a repository dependency. Resolution order:
//   1. H2O_PLAYWRIGHT_MODULE - absolute path to a playwright module directory;
//   2. ordinary module resolution ("playwright");
//   3. SKIP with an exact reason and exit 0.
// A missing optional browser oracle must never be reported as PASS, and must
// never fail Tier 1.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), '..', '..', '..');
const SAFETY_DIR = path.join(REPO_ROOT, 'src-surfaces-base/studio/renderer/safety');
const CASES_PATH = path.join(REPO_ROOT, 'tools/validation/fixtures/studio-renderer-sanitizer/sanitizer-cases.v1.json');

function skip(reason) {
  console.log(`SKIP ${reason}`);
  console.log('SKIP is not PASS: the real-browser oracle did not run.');
  process.exit(0);
}

async function resolvePlaywright() {
  const override = process.env.H2O_PLAYWRIGHT_MODULE;
  if (override) {
    if (!fs.existsSync(override)) return { error: `H2O_PLAYWRIGHT_MODULE does not exist: ${override}` };
    try {
      const entry = fs.statSync(override).isDirectory() ? path.join(override, 'index.js') : override;
      return { mod: await import(pathToFileURL(entry).href), from: override };
    } catch (error) {
      return { error: `H2O_PLAYWRIGHT_MODULE could not be imported: ${error.message}` };
    }
  }
  try {
    return { mod: await import('playwright'), from: 'module resolution' };
  } catch (error) {
    return { error: `playwright is not resolvable (${error.code || error.message}); set H2O_PLAYWRIGHT_MODULE to an available install` };
  }
}

const resolved = await resolvePlaywright();
if (resolved.error) skip(resolved.error);
/* Playwright ships CommonJS, so an ESM import may surface it as the default
 * export rather than as named exports. */
const chromium = resolved.mod?.chromium || resolved.mod?.default?.chromium;
if (!chromium) skip('resolved playwright module exposes no chromium');

/*
 * Same-origin external-script load shape, matching how an MV3-style CSP admits
 * code: every module is served from this origin and loaded via <script src>,
 * never inline.
 *
 * The page deliberately does NOT set a restrictive script-src. Under one, an
 * unsanitized payload would be blocked by CSP rather than by the sanitizer, and
 * the non-execution assertion would be vacuous. A RED control below inserts an
 * unsanitized payload and REQUIRES the tripwire to fire, proving this oracle
 * can actually observe execution.
 */
const PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>sanitizer v2 oracle</title>
<script src="/tripwire.js"></script>
<script src="/purify.js"></script>
<script src="/sanitizer-policy.v1.js"></script>
<script src="/html-sanitizer.v2.js"></script>
</head><body><div id="sink"></div></body></html>`;

const TRIPWIRE = `window.__h2oExec = 0;
window.alert = function () { window.__h2oExec += 1; };
window.__h2oNote = function () { window.__h2oExec += 1; };
window.addEventListener('error', function () {}, true);`;

const FILES = {
  '/': { body: PAGE, type: 'text/html; charset=utf-8' },
  '/tripwire.js': { body: TRIPWIRE, type: 'text/javascript; charset=utf-8' },
  '/purify.js': { body: fs.readFileSync(path.join(SAFETY_DIR, 'vendor/dompurify/purify.js'), 'utf8'), type: 'text/javascript; charset=utf-8' },
  '/sanitizer-policy.v1.js': { body: fs.readFileSync(path.join(SAFETY_DIR, 'sanitizer-policy.v1.js'), 'utf8'), type: 'text/javascript; charset=utf-8' },
  '/html-sanitizer.v2.js': { body: fs.readFileSync(path.join(SAFETY_DIR, 'html-sanitizer.v2.js'), 'utf8'), type: 'text/javascript; charset=utf-8' },
};

const corpus = JSON.parse(fs.readFileSync(CASES_PATH, 'utf8'));

const server = http.createServer((req, res) => {
  const file = FILES[req.url.split('?')[0]];
  if (!file) { res.writeHead(404); res.end('not found'); return; }
  res.writeHead(200, { 'content-type': file.type });
  res.end(file.body);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

const checks = [];
function check(label, fn) {
  fn();
  checks.push(label);
  console.log(`✓ ${label}`);
}

let browser;
let exitCode = 0;
try {
  try {
    browser = await chromium.launch();
  } catch (error) {
    server.close();
    skip(`chromium could not launch: ${error.message}`);
  }
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(String(error)));
  await page.goto(origin, { waitUntil: 'load' });

  const boot = await page.evaluate(() => {
    const api = window.H2O && window.H2O.Studio && window.H2O.Studio.Renderer && window.H2O.Studio.Renderer.htmlSanitizer;
    return {
      installed: !!api,
      supported: api ? api.isSupported() : false,
      diagnose: api ? api.diagnose() : null,
      globalEngine: typeof window.DOMPurify,
      tripwire: window.__h2oExec,
    };
  });

  check('modules load as same-origin external scripts and the engine is live', () => {
    assert.deepEqual(pageErrors, [], `page errors during load: ${pageErrors.join(' | ')}`);
    assert.equal(boot.installed, true, 'sanitizer v2 did not install in the browser');
    assert.equal(boot.supported, true, 'engine reported unsupported in a real browser');
    assert.equal(boot.diagnose.engineVersion, '3.4.15');
    assert.equal(boot.diagnose.policyVersion, 1);
    assert.equal(boot.diagnose.usesSetConfig, false);
    assert.equal(boot.diagnose.trustedTypes, 'not-implemented');
  });

  check('the engine global is cleared after capture', () => {
    assert.equal(boot.globalEngine, 'undefined', 'window.DOMPurify should be cleared as hygiene');
  });

  /* RED control: this oracle must be able to see execution at all. */
  const control = await page.evaluate(() => {
    const before = window.__h2oExec;
    const sink = document.getElementById('sink');
    sink.innerHTML = '<img src="x" onerror="window.__h2oNote()">';
    return new Promise((resolve) => setTimeout(() => {
      const after = window.__h2oExec;
      sink.innerHTML = '';
      resolve({ before, after });
    }, 120));
  });

  check('RED control: an unsanitized payload does execute, so the oracle is not vacuous', () => {
    assert.equal(control.before, 0);
    assert.ok(control.after > control.before, 'unsanitized payload did not execute; the non-execution assertion would be vacuous');
  });

  const results = await page.evaluate(async (cases) => {
    const api = window.H2O.Studio.Renderer.htmlSanitizer;
    const sink = document.getElementById('sink');
    const out = [];
    const execBefore = window.__h2oExec;
    for (const c of cases) {
      const row = { id: c.id, ok: true, errors: [] };
      try {
        const sanitized = api.sanitizeHtml(c.input);
        row.output = sanitized;
        const lower = sanitized.toLowerCase();
        for (const needle of c.expect.mustContain) {
          if (!sanitized.includes(needle)) { row.ok = false; row.errors.push(`missing: ${needle}`); }
        }
        for (const needle of c.expect.mustNotContain) {
          if (lower.includes(needle.toLowerCase())) { row.ok = false; row.errors.push(`present: ${needle}`); }
        }
        if (c.expect.idempotent && api.sanitizeHtml(sanitized) !== sanitized) {
          row.ok = false; row.errors.push('not idempotent');
        }
        const fragment = api.sanitizeToFragment(c.input);
        row.nodeType = fragment.nodeType;
        row.foreignOwnerDocument = fragment.ownerDocument !== document;
        sink.appendChild(fragment);
        sink.innerHTML = '';
      } catch (error) {
        row.ok = false;
        row.errors.push(`threw: ${error.message}`);
      }
      out.push(row);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
    return { rows: out, execBefore, execAfter: window.__h2oExec };
  }, corpus.cases);

  check('every corpus case satisfies its security expectation in a real browser', () => {
    const failures = results.rows.filter((r) => !r.ok);
    assert.deepEqual(
      failures.map((f) => `${f.id}: ${f.errors.join('; ')}`),
      [],
      `${failures.length} of ${results.rows.length} cases failed`
    );
    assert.equal(results.rows.length, corpus.cases.length);
  });

  check('sanitizeToFragment returns a real DocumentFragment from a foreign inert document', () => {
    for (const row of results.rows) {
      assert.equal(row.nodeType, 11, `${row.id}: expected nodeType 11, got ${row.nodeType}`);
      assert.equal(row.foreignOwnerDocument, true, `${row.id}: fragment ownerDocument should be the engine inert document`);
    }
  });

  check('ZERO payload execution across the whole adversarial corpus', () => {
    assert.equal(results.execAfter, results.execBefore,
      `sanitized content executed ${results.execAfter - results.execBefore} payload(s)`);
  });

  const perCall = await page.evaluate(() => {
    const api = window.H2O.Studio.Renderer.htmlSanitizer;
    /* If setConfig had been used, this engine version silently ignores per-call
     * config and a fragment request comes back as a String. */
    const asString = api.sanitizeHtml('<p>x</p>');
    const asFragment = api.sanitizeToFragment('<p>x</p>');
    return {
      stringType: typeof asString,
      fragmentNodeType: asFragment ? asFragment.nodeType : null,
      stillString: typeof api.sanitizeHtml('<p>y</p>'),
      stillFragment: api.sanitizeToFragment('<p>y</p>').nodeType,
    };
  });

  check('policy-derived config is honoured per call, proving setConfig was never used', () => {
    assert.equal(perCall.stringType, 'string');
    assert.equal(perCall.fragmentNodeType, 11);
    assert.equal(perCall.stillString, 'string', 'a later string call must still return a String');
    assert.equal(perCall.stillFragment, 11, 'a later fragment call must still return a DocumentFragment');
  });

  const urls = await page.evaluate((urlCases) => {
    const api = window.H2O.Studio.Renderer.htmlSanitizer;
    return urlCases.map((c) => ({ id: c.id, ok: api.classifyUrl(c.input, c.context).ok, expected: c.allowed }));
  }, corpus.urlCases);

  check('URI policy agrees with Tier 1 inside the browser', () => {
    const wrong = urls.filter((u) => u.ok !== u.expected);
    assert.deepEqual(wrong.map((w) => w.id), [], 'URI classification diverged in the browser');
  });

  check('no uncaught page errors were produced by the corpus', () => {
    assert.deepEqual(pageErrors, [], `page errors: ${pageErrors.join(' | ')}`);
  });

  console.log(`PASS ${checks.length} (browser: chromium, cases: ${corpus.cases.length}, urls: ${corpus.urlCases.length})`);
} catch (error) {
  console.error(error && error.message ? error.message : error);
  exitCode = 1;
} finally {
  if (browser) await browser.close();
  server.close();
}
process.exit(exitCode);
