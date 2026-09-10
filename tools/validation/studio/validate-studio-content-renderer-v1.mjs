#!/usr/bin/env node
// M03 P2 S2B T5 - typed ContentRenderer registry and canonical semantic rendering.
//
// Tier 1 (always runs): registry contract plus source inspection of the
// canonical Markdown path.
// Tier 2 (real browser): the actual DOM the renderers build, including the URL
// admission boundary. An unavailable browser SKIPs loudly - it is never
// reported as evidence.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), '..', '..', '..');
const STUDIO = path.join(REPO_ROOT, 'src-surfaces-base/studio');
const CONTENT_REL = 'renderer/content/content-renderer.v1.js';
const RENDERER_REL = 'renderer/chat-renderer.studio.js';

const STRICT = /^(1|true|yes)$/i.test(String(process.env.H2O_REQUIRE_CONTENT_RENDERER_TIER2 || ''));

const checks = [];
const failures = [];
function check(label, fn) {
  try { fn(); checks.push(label); console.log(`✓ ${label}`); }
  catch (e) { failures.push(label); console.log(`✗ ${label}\n    ${e.message}`); }
}
const read = (rel) => fs.readFileSync(path.join(STUDIO, rel), 'utf8');

/* ------------------------------------------------------------ Tier 1 */

function loadRegistry() {
  const sandbox = vm.createContext({ console });
  sandbox.globalThis = sandbox;
  vm.runInContext(read(CONTENT_REL), sandbox, { filename: 'content-renderer.v1.js' });
  return sandbox.H2O.Studio.Renderer.contentRenderer;
}

check('registry exposes the small typed API and registers the core kinds once', () => {
  const cr = loadRegistry();
  for (const fn of ['register', 'has', 'renderBlock', 'renderBlocks', 'registeredKinds']) {
    assert.equal(typeof cr[fn], 'function', `missing ${fn}`);
  }
  for (const kind of cr.coreKinds) assert.equal(cr.has(kind), true, `core kind not registered: ${kind}`);
  /* Both sides are spread into THIS realm first: values built inside the vm
   * sandbox carry the sandbox's intrinsics, which deepStrictEqual compares. */
  assert.deepEqual([...cr.registeredKinds()], [...cr.coreKinds].sort(),
    'registered kinds must be exactly the core kinds');
});

check('duplicate registration fails rather than silently replacing', () => {
  const cr = loadRegistry();
  assert.throws(() => cr.register('paragraph', () => null), /already has a renderer/i);
  /* A new kind still registers, so the guard is about duplicates, not writes. */
  assert.equal(cr.register('citation', () => null), 'citation');
  assert.equal(cr.has('citation'), true);
  assert.throws(() => cr.register('citation', () => null), /already has a renderer/i);
});

check('reserved extension kinds are unregistered and fail deterministically', () => {
  const cr = loadRegistry();
  for (const kind of cr.extensionKinds) {
    assert.equal(cr.has(kind), false, `${kind} must not be registered in T5`);
    assert.throws(() => cr.renderBlock({ kind }, {}), new RegExp(`no renderer registered for kind: ${kind}`),
      `${kind} must fail deterministically rather than be faked as paragraph/text`);
  }
});

check('the canonical Markdown body path builds no HTML string', () => {
  const source = read(RENDERER_REL);
  assert.doesNotMatch(source, /innerHTML\s*=\s*renderTextAsChatGPTBlocks/,
    'the canonical body must not be assigned through innerHTML');
  /* Both canonical message-body call sites, named exactly. */
  assert.match(source, /\n\s*renderSemanticBody\(bodyEl, role === "user" \? cleanReaderUserText\(text\) : text\);/,
    'buildCanonicalMessage must render semantically');
  assert.match(source, /\n\s*renderSemanticBody\(bodyEl, text\);/,
    'applyEditedMessageBody must render semantically');
  /* The retired parser must not be reachable from this file at all. */
  assert.doesNotMatch(source, /renderTextAsChatGPTBlocks|renderInlineMarkdown|renderMarkdownTable/,
    'the retired Web bespoke parser must be absent');
});

check('the content renderer never routes semantic content through an HTML sink', () => {
  const source = read(CONTENT_REL);
  assert.doesNotMatch(source, /\.innerHTML\s*=/, 'content renderer must not assign innerHTML');
  assert.doesNotMatch(source, /\.outerHTML\s*=/, 'content renderer must not assign outerHTML');
  assert.doesNotMatch(source, /insertAdjacentHTML\s*\(/, 'content renderer must not use insertAdjacentHTML');
  /* Text always enters the DOM as text data. */
  assert.match(source, /createTextNode/, 'content renderer must build text nodes');
});

check('sanitizerPolicy.classifyUrl is the only URL admission authority', () => {
  const source = read(CONTENT_REL);
  assert.match(source, /classifyUrl\(value, urlContext\)/, 'must call classifyUrl');
  assert.match(source, /classify\(context, mark\.href, "link"\)/, 'link marks must classify with the link context');
  assert.match(source, /classify\(context, block\.src, "image"\)/, 'images must classify with the image context');
  /* No second allowlist and no independent URL parsing as a security decision. */
  assert.doesNotMatch(source, /new URL\(/, 'URL() must not be an independent security decision');
  assert.doesNotMatch(source, /normalizeSafeMarkdownHref/, 'the legacy href decision must not return');
  assert.doesNotMatch(source, /https?:\s*\[|allowedSchemes\s*=/, 'must not define a second scheme allowlist');
  /* Fail closed when the policy is unreachable. */
  assert.match(source, /url-policy-unavailable/, 'a missing policy must deny, not admit');
});

/* ------------------------------------------------------------ Tier 2 */

async function resolvePlaywright() {
  const override = process.env.H2O_PLAYWRIGHT_MODULE;
  try {
    if (override) {
      if (!fs.existsSync(override)) return null;
      const entry = fs.statSync(override).isDirectory() ? path.join(override, 'index.js') : override;
      const mod = await import(pathToFileURL(entry).href);
      return mod?.chromium || mod?.default?.chromium || null;
    }
    const mod = await import('playwright');
    return mod?.chromium || mod?.default?.chromium || null;
  } catch { return null; }
}

const chromium = await resolvePlaywright();
if (!chromium) {
  console.log('SKIP real-browser DOM oracle unavailable (set H2O_PLAYWRIGHT_MODULE)');
  console.log('SKIP is not PASS: the rendered DOM was not inspected.');
  if (STRICT) { console.error('FAIL H2O_REQUIRE_CONTENT_RENDERER_TIER2 is set'); process.exit(1); }
} else {
  const MIME = { '.js': 'text/javascript', '.html': 'text/html' };
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '');
    if (rel === '__harness__') {
      const tags = [
        'renderer/safety/sanitizer-policy.v1.js',
        'renderer/markdown/vendor/markdown-it/markdown-it.umd.min.js',
        'renderer/markdown/h2o-gfm.v1.js',
        'renderer/markdown/markdown-engine.v1.js',
        'renderer/markdown/markdown-ir-adapter.v1.js',
        'renderer/semantic/render-ir.v1.js',
        CONTENT_REL,
      ].map((r) => `<script src="./${r}"></script>`).join('\n');
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`<!doctype html><meta charset="utf-8"><title>t5</title>\n${tags}\n<div id="host"></div>`);
      return;
    }
    const file = path.join(STUDIO, rel);
    if (!file.startsWith(STUDIO) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end('nf'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(fs.readFileSync(file));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  await page.goto(`${base}/__harness__`, { waitUntil: 'load' });

  const SOURCE = [
    '## Heading two',
    '',
    'Body **strong** *emphasis* `code` ~~struck~~ [safe](https://example.test/a) [unsafe](javascript:alert(1)).',
    '',
    '- bullet',
    '- [x] done',
    '- [ ] todo',
    '',
    '3. three',
    '4. four',
    '',
    '> quoted',
    '',
    '```js',
    'const x = 1;',
    '```',
    '',
    '| a | b |',
    '|:--|--:|',
    '| 1 | 2 |',
    '',
    '![ok](https://example.test/i.png)',
    '',
    '![bad](http://example.test/i.png)',
    '',
    '---',
    '',
    'line one  ',
    'line two',
  ].join('\n');

  const dom = await page.evaluate((src) => {
    const R = globalThis.H2O.Studio.Renderer;
    const md = R.markdownEngine.formalBaseEngine();
    const parsed = R.markdownIrAdapter.markdownToBlocks(md, src);
    const host = document.getElementById('host');
    host.appendChild(R.contentRenderer.renderBlocks(parsed.blocks, { document }));
    const q = (sel) => Array.from(host.querySelectorAll(sel));
    return {
      fallback: parsed.fallback,
      h2: q('h2').map((n) => n.textContent),
      strong: q('strong').map((n) => n.textContent),
      em: q('em').map((n) => n.textContent),
      code: q('code').map((n) => n.textContent),
      struck: q('s').map((n) => n.textContent),
      anchors: q('a').map((n) => ({ href: n.getAttribute('href'), text: n.textContent, rel: n.getAttribute('rel') })),
      deniedLinks: q('[data-h2o-link-denied]').map((n) => ({ reason: n.getAttribute('data-h2o-link-denied'), text: n.textContent })),
      ul: q('ul').length, ol: q('ol').length,
      olStart: q('ol').map((n) => n.getAttribute('start')),
      tasks: q('[data-h2o-task]').map((n) => n.getAttribute('data-h2o-task')),
      inputs: q('input, button').length,
      blockquote: q('blockquote').map((n) => n.textContent.trim()),
      codeBlock: q('div.wbCodeBlock pre code').map((n) => n.textContent),
      codeLang: q('div.wbCodeLang').map((n) => n.textContent),
      th: q('th').map((n) => ({ text: n.textContent, align: n.style.textAlign, scope: n.getAttribute('scope') })),
      td: q('td').map((n) => ({ text: n.textContent, align: n.style.textAlign })),
      images: q('img').map((n) => ({ src: n.getAttribute('src'), alt: n.getAttribute('alt') })),
      deniedImages: q('[data-h2o-image-denied]').map((n) => ({ reason: n.getAttribute('data-h2o-image-denied'), text: n.textContent })),
      hr: q('hr').length, br: q('br').length,
      htmlHasScript: /<script/i.test(host.innerHTML),
    };
  }, SOURCE);

  check('representative Markdown renders as semantic DOM without fallback', () => {
    assert.deepEqual(pageErrors, [], `page errors: ${pageErrors.join(' | ')}`);
    assert.equal(dom.fallback, false, 'valid Markdown must not fall back');
    assert.deepEqual(dom.h2, ['Heading two']);
    assert.deepEqual(dom.strong, ['strong']);
    assert.deepEqual(dom.em, ['emphasis']);
    assert.deepEqual(dom.code, ['code', 'const x = 1;\n']);
    assert.deepEqual(dom.struck, ['struck']);
    assert.deepEqual(dom.blockquote, ['quoted']);
    assert.deepEqual(dom.codeBlock, ['const x = 1;\n']);
    assert.deepEqual(dom.codeLang, ['js']);
    assert.equal(dom.ul, 1);
    assert.equal(dom.ol, 1);
    assert.deepEqual(dom.olStart, ['3'], 'an explicit ordered start must reach the DOM');
    assert.equal(dom.hr, 1);
    assert.equal(dom.br, 1);
    assert.equal(dom.htmlHasScript, false);
  });

  check('task state is accessible and non-interactive', () => {
    assert.deepEqual(dom.tasks, ['checked', 'unchecked']);
    assert.equal(dom.inputs, 0, 'task items must not create an actionable control');
  });

  check('table structure and normalized alignment reach the DOM', () => {
    assert.deepEqual(dom.th, [
      { text: 'a', align: 'left', scope: 'col' },
      { text: 'b', align: 'right', scope: 'col' },
    ]);
    assert.deepEqual(dom.td, [{ text: '1', align: 'left' }, { text: '2', align: 'right' }]);
  });

  check('only an admitted link destination becomes a live href', () => {
    assert.deepEqual(dom.anchors, [
      { href: 'https://example.test/a', text: 'safe', rel: 'noopener noreferrer' },
    ], 'exactly one live anchor is expected');
    assert.equal(dom.deniedLinks.length, 1, 'the javascript: destination must be denied');
    assert.equal(dom.deniedLinks[0].reason, 'scheme-not-allowed');
    assert.equal(dom.deniedLinks[0].text, 'unsafe', 'denied links must keep their author text');
  });

  check('only an admitted image source becomes a live src', () => {
    assert.deepEqual(dom.images, [{ src: 'https://example.test/i.png', alt: 'ok' }]);
    assert.equal(dom.deniedImages.length, 1, 'the http image must be denied');
    assert.equal(dom.deniedImages[0].reason, 'scheme-not-allowed');
    assert.equal(dom.deniedImages[0].text, 'bad', 'denied images must degrade to alt text');
  });

  const adversarial = await page.evaluate(() => {
    const R = globalThis.H2O.Studio.Renderer;
    const md = R.markdownEngine.formalBaseEngine();
    const out = {};
    for (const [name, src] of Object.entries({
      dataText: '[x](data:text/html;base64,PHNjcmlwdD4=)',
      relative: '[x](/etc/passwd)',
      fragment: '[x](#anchor)',
      protocolRelative: '[x](//evil.test/a)',
      vbscript: '[x](vbscript:msgbox(1))',
      imageJs: '![x](javascript:alert(1))',
    })) {
      const host = document.createElement('div');
      host.appendChild(R.contentRenderer.renderBlocks(R.markdownIrAdapter.markdownToBlocks(md, src).blocks, { document }));
      out[name] = {
        liveHrefs: Array.from(host.querySelectorAll('a[href]')).map((n) => n.getAttribute('href')),
        liveSrcs: Array.from(host.querySelectorAll('img[src]')).map((n) => n.getAttribute('src')),
      };
    }
    return out;
  });

  check('no adversarial destination becomes live', () => {
    for (const [name, result] of Object.entries(adversarial)) {
      assert.deepEqual(result.liveHrefs, [], `${name} produced a live href`);
      assert.deepEqual(result.liveSrcs, [], `${name} produced a live src`);
    }
  });

  const fallbackProof = await page.evaluate(() => {
    const R = globalThis.H2O.Studio.Renderer;
    /* An unregistered extension kind must make the whole message fall back,
     * never render a partial tree. */
    const host = document.createElement('div');
    let threw = false;
    try {
      host.appendChild(R.contentRenderer.renderBlocks(
        [{ kind: 'paragraph', children: [{ kind: 'text', text: 'kept' }] }, { kind: 'math', text: 'x' }],
        { document },
      ));
    } catch { threw = true; }
    return { threw, hostChildren: host.childNodes.length };
  });

  check('an unregistered kind fails whole-message rather than rendering partially', () => {
    assert.equal(fallbackProof.threw, true, 'an unregistered kind must throw');
    assert.equal(fallbackProof.hostChildren, 0, 'no partial tree may reach the host');
  });

  await browser.close();
  server.close();
}

console.log(failures.length ? `FAIL ${failures.length} (passed ${checks.length})` : `PASS ${checks.length}`);
process.exit(failures.length ? 1 : 0);
