#!/usr/bin/env node
// Studio Desktop layout contract guard.
//
// This is a static source guard for the fragile Desktop/Tauri layout rules
// around the macOS overlay titlebar, ribbon menu, sidebar top area, route
// topbars, and Desktop CSS zoom fallback.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), '..', '..', '..');

const FILES = {
  css: 'src-surfaces-base/studio/studio.css',
  html: 'src-surfaces-base/studio/studio.html',
  studio: 'src-surfaces-base/studio/studio.js',
  ribbon: 'src-surfaces-base/studio/S0Y1a. 🎬 Studio Ribbon - Studio.js',
  tauri: 'src-surfaces-base/studio/platform/platform.tauri.js',
  contract: 'src-surfaces-base/studio/STUDIO_DESKTOP_LAYOUT_CONTRACT.md',
  handoff: 'src-surfaces-base/studio/STUDIO_DESKTOP_LAYOUT_HANDOFF_REPORT.md',
};

function abs(rel) {
  return path.join(REPO_ROOT, rel);
}

function read(rel) {
  return fs.readFileSync(abs(rel), 'utf8');
}

function cssBlock(src, selector) {
  const i = src.indexOf(selector);
  if (i < 0) return '';
  const open = src.indexOf('{', i);
  if (open < 0) return '';
  let depth = 0;
  for (let j = open; j < src.length; j += 1) {
    if (src[j] === '{') depth += 1;
    else if (src[j] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(open + 1, j);
    }
  }
  return '';
}

function compact(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

const PASS = [];
const FAIL = [];

function check(label, fn) {
  try {
    fn();
    PASS.push(label);
  } catch (err) {
    FAIL.push({ label, err: err?.message || String(err) });
  }
}

for (const [name, rel] of Object.entries(FILES)) {
  check(`file exists: ${name}`, () => {
    assert.ok(fs.existsSync(abs(rel)), `${rel} missing`);
  });
}

const css = fs.existsSync(abs(FILES.css)) ? read(FILES.css) : '';
const html = fs.existsSync(abs(FILES.html)) ? read(FILES.html) : '';
const studio = fs.existsSync(abs(FILES.studio)) ? read(FILES.studio) : '';
const ribbon = fs.existsSync(abs(FILES.ribbon)) ? read(FILES.ribbon) : '';
const tauri = fs.existsSync(abs(FILES.tauri)) ? read(FILES.tauri) : '';
const contract = fs.existsSync(abs(FILES.contract)) ? read(FILES.contract) : '';
const handoff = fs.existsSync(abs(FILES.handoff)) ? read(FILES.handoff) : '';

check('contract has explicit change-control gate', () => {
  assert.match(contract, /## Change Control Gate/);
  assert.match(contract, /explicit user permission/);
  assert.match(contract, /Permission is required again for each separate structural step/);
});

check('handoff report instructs future chats to preserve layout contract', () => {
  assert.match(handoff, /Mandatory Instruction For The Next Chat/);
  assert.match(handoff, /Do not change the Studio Desktop interface structure/);
  assert.match(handoff, /validate-studio-desktop-layout-contract\.mjs/);
});

check('Tauri runtime marker is installed by platform.tauri.js', () => {
  assert.match(tauri, /data-h2o-runtime['"],\s*['"]tauri/);
});

check('Tauri desktop chrome host is overlay-only', () => {
  const block = cssBlock(css, 'html[data-h2o-runtime="tauri"] .wbTauriDesktopChrome');
  assert.ok(block, 'missing .wbTauriDesktopChrome block');
  assert.match(block, /display\s*:\s*block/);
  assert.match(block, /position\s*:\s*fixed/);
  assert.match(block, /top\s*:\s*0/);
  assert.match(block, /left\s*:\s*0/);
  assert.match(block, /right\s*:\s*0/);
  assert.match(block, /background\s*:\s*transparent/);
  assert.match(block, /pointer-events\s*:\s*none/);
});

check('Tauri drag strip remains invisible and draggable', () => {
  const block = cssBlock(css, 'html[data-h2o-runtime="tauri"] .wbTauriDragStrip');
  assert.ok(block, 'missing .wbTauriDragStrip block');
  assert.match(block, /background\s*:\s*transparent/);
  assert.match(block, /border-bottom\s*:\s*0/);
  assert.match(block, /box-shadow\s*:\s*none/);
  assert.match(block, /-webkit-app-region\s*:\s*drag/);
});

check('Tauri shell starts at the window top and owns full height', () => {
  const block = cssBlock(css, 'html[data-h2o-runtime="tauri"] .wbShell');
  assert.ok(block, 'missing Tauri .wbShell block');
  assert.match(block, /height\s*:\s*100vh\s*!important/);
  assert.match(block, /height\s*:\s*100dvh\s*!important/);
  assert.match(block, /margin-top\s*:\s*0/);
});

check('CSS zoom fallback compensates viewport size with inverse variable', () => {
  assert.match(css, /data-h2o-desktop-view-zoom-mode="css"/);
  assert.match(css, /--h2o-desktop-view-zoom-inverse/);
  assert.match(css, /height:calc\(100vh \* var\(--h2o-desktop-view-zoom-inverse, 1\)\)/);
  assert.match(css, /height:calc\(100dvh \* var\(--h2o-desktop-view-zoom-inverse, 1\)\)/);
  assert.match(tauri, /--h2o-desktop-view-zoom-inverse/);
});

check('stage reserves the top safe band structurally', () => {
  const block = cssBlock(css, 'html[data-h2o-runtime="tauri"] .wbStage');
  assert.ok(block, 'missing Tauri .wbStage block');
  assert.match(css, /--wb-tauri-ribbon-expanded-h\s*:\s*0px/);
  assert.match(css, /--wb-tauri-safe-h\s*:\s*calc\(var\(--wb-tauri-drag-h\) \+ var\(--wb-tauri-ribbon-expanded-h, 0px\)\)/);
  assert.match(compact(block), /grid-template-rows:var\(--wb-tauri-safe-h\) var\(--wb-tauri-titlebar-h\) minmax\(0,1fr\)/);
  assert.match(block, /padding-top\s*:\s*0/);
  assert.match(block, /height\s*:\s*100%\s*!important/);
});

check('non-reader routes hide titlebar but keep top safe row', () => {
  const topBlock = cssBlock(css, 'html[data-h2o-runtime="tauri"] body:not([data-dock-eligible="true"]) .wbTop');
  const stageBlock = cssBlock(css, 'html[data-h2o-runtime="tauri"] body:not([data-dock-eligible="true"]) .wbStage');
  const mainBlock = cssBlock(css, 'html[data-h2o-runtime="tauri"] body:not([data-dock-eligible="true"]) .wbMain');
  assert.match(topBlock, /display\s*:\s*none/);
  assert.match(compact(stageBlock), /grid-template-rows:var\(--wb-tauri-safe-h\) minmax\(0,1fr\)/);
  assert.match(mainBlock, /grid-row\s*:\s*2/);
});

check('sidebar and rail own the same top safe area', () => {
  const railBlock = cssBlock(css, 'html[data-h2o-runtime="tauri"] .wbRail');
  const sideBlock = cssBlock(css, 'html[data-h2o-runtime="tauri"] .wbSide--sidebar');
  assert.match(compact(railBlock), /padding-top:calc\(var\(--wb-tauri-safe-h\) \+ 10px\)/);
  assert.match(compact(sideBlock), /padding-top:calc\(var\(--wb-tauri-safe-h\) \+ 10px\)/);
});

check('expanded Desktop ribbon body publishes shared safe height', () => {
  assert.match(ribbon, /function syncTauriRibbonLayout/);
  assert.match(ribbon, /getBoundingClientRect/);
  assert.match(ribbon, /--wb-tauri-ribbon-expanded-h/);
  assert.match(ribbon, /document\.body\.style\.setProperty\('--wb-tauri-ribbon-expanded-h'/);
  assert.match(ribbon, /data-h2o-tauri-ribbon-expanded/);
  assert.match(ribbon, /data-library-ribbon-hidden/);
  assert.match(ribbon, /data-reader-ribbon-hidden/);
});

check('Library ribbon exposes only Library-specific tab catalogue', () => {
  const libraryChatTypeUses = ribbon.match(/chatTypes:\s*\['library/g) || [];
  assert.equal(libraryChatTypeUses.length, 1);
  assert.match(ribbon, /id:\s*'library-home'[\s\S]*?chatTypes:\s*\['library'\]/);
});

check('reader ribbon hide resets collapsed ribbon layout state', () => {
  assert.match(studio, /function setDesktopReaderRibbonHidden/);
  assert.match(studio, /ribbon\.setCollapsed\(true\)/);
});

check('hidden ribbon menus do not occupy hit area', () => {
  assert.match(css, /#studioDesktopChrome\[data-library-ribbon-hidden="true"\] #studioRibbon/);
  assert.match(css, /#studioDesktopChrome\[data-reader-ribbon-hidden="true"\] #studioRibbon/);
  assert.match(css, /opacity\s*:\s*0\s*!important/);
  assert.match(css, /pointer-events\s*:\s*none\s*!important/);
});

check('Library right pane background covers top safe area', () => {
  const block = cssBlock(css, 'html[data-h2o-runtime="tauri"] body[data-route="library"] .wbStage');
  assert.ok(block, 'missing Library .wbStage background block');
  assert.match(block, /radial-gradient/);
  assert.match(block, /var\(--wb-page\)/);
});

check('interactive top controls are protected from drag', () => {
  assert.match(css, /-webkit-app-region\s*:\s*no-drag/);
  assert.match(css, /\.wbTopGroup--actions/);
  assert.match(css, /\.wbAppearanceBtn/);
  assert.match(css, /\.wbRibbon/);
  assert.match(css, /\.wbRail/);
  assert.match(css, /\.wbSide--sidebar/);
});

check('source HTML carries current cache markers', () => {
  assert.match(html, /@version 2\.5\.48/);
  assert.match(html, /studio\.css\?v=2\.5\.48/);
  assert.match(html, /studio\.js\?v=2\.5\.80/);
  assert.match(html, /platform\.tauri\.js\?v=2\.5\.37/);
});

console.log('Studio Desktop layout contract guard');
console.log(`PASS ${PASS.length}`);

if (FAIL.length) {
  console.error(`FAIL ${FAIL.length}`);
  for (const item of FAIL) {
    console.error(`- ${item.label}: ${item.err}`);
  }
  process.exit(1);
}

console.log('OK');
