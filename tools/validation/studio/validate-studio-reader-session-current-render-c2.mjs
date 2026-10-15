#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const BASE = '75066cf0b005a265205c5467c427957597332cae';
const STUDIO = path.join(ROOT, 'src-surfaces-base/studio');
const READER_REL = 'reader/reader-session-current-render.studio.js';
const READER_ABS = path.join(STUDIO, READER_REL);
const STUDIO_ABS = path.join(STUDIO, 'studio.js');
const HTML_ABS = path.join(STUDIO, 'studio.html');
const PACK_ABS = path.join(ROOT, 'tools/product/studio/pack-studio.mjs');
const ALLOWED = new Set([
  'src-surfaces-base/studio/reader/reader-session-current-render.studio.js',
  'src-surfaces-base/studio/studio.js',
  'src-surfaces-base/studio/studio.html',
  'tools/product/studio/pack-studio.mjs',
  'tools/validation/studio/validate-studio-reader-session-current-render-c2.mjs',
  'tools/validation/studio/validate-studio-reader-resume-continuity-m02.mjs',
  'tools/validation/studio/validate-studio-reader-session-navigation-m01.mjs',
  'tools/validation/studio/validate-studio-renderer-lifecycle-idempotence.mjs',
  'tools/validation/studio/validate-studio-renderer-presentation-registry-v1.mjs',
  'tools/validation/studio/validate-studio-content-renderer-v1.mjs',
  'tools/validation/studio/validate-studio-renderer-contract-repair.mjs',
  'tools/validation/studio/validate-saved-chat-recovered-asset-hydration-rf-v1.mjs',
  'tools/validation/studio/benchmark-studio-renderer-memory.mjs',
  'tools/validation/studio/benchmark-studio-renderer-long-chat.mjs',
  'tools/validation/studio/validate-stab-p0-t03-library-folder-integration.mjs',
  'tools/validation/reader-notes/validate-reader-notes-mvp-a2a_4-highlight-resolution-consumer.mjs',
]);
const MOVED = Object.freeze([
  'bindReaderSemanticIndex','getReaderSemanticIndex','getReaderDecorationContributions','disposeReaderRenderDecorations',
  'createReaderResumeController','isCurrentReaderRoot','getReusableReaderMount','isReusableReaderMountCurrent',
  'isReaderPresentationCurrent','canReuseReaderDOM','refreshReaderPresentation','subscribeReaderToPresentationPreference',
  'resolveReaderNavigationTarget','getReaderNavigationTarget','publishReaderTurnSelection','readerNearestScrollDelta',
  'goToReaderTarget','stepReaderTarget','nextReaderTarget','previousReaderTarget',
]);
const OWNED_STATE = Object.freeze(['currentReaderSnapshot','currentReaderRender','currentReaderNavigationTarget','readerResume','readerPresentationUnsubscribe']);
const reader = fs.readFileSync(READER_ABS, 'utf8');
const studio = fs.readFileSync(STUDIO_ABS, 'utf8');
const html = fs.readFileSync(HTML_ABS, 'utf8');
const checks = [];
function check(label, fn) {
  fn(); checks.push(label); console.log(`PASS ${label}`);
}
function extract(source, name) {
  const m = new RegExp(`\\b(?:async\\s+)?function\\s+${name}\\s*\\(`).exec(source);
  assert.ok(m, `missing ${name}`);
  let p = source.indexOf(')', m.index), open = source.indexOf('{', p), depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}' && --depth === 0) return source.slice(m.index, i + 1);
  }
  throw new Error(`unterminated ${name}`);
}
function git(args) {
  const r = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`); return r.stdout.trim();
}

check('contract + owner are explicit', () => {
  assert.match(reader, /contract:\s*"h2o\.studio\.reader-session-current-render\.v1"/);
  assert.match(reader, /owner:\s*"L-STUDIO-READER"/);
  assert.equal((reader.match(/H2O\.Studio\.readerSessionCurrentRender\s*=\s*api/g) || []).length, 1);
});
check('Reader owns exactly the five page-lifetime state fields through Shell accessors', () => {
  for (const key of OWNED_STATE) {
    assert.match(reader, new RegExp(`\\b${key}: null,`), `${key} initial owner state`);
    assert.doesNotMatch(studio, new RegExp(`^\\s*${key}:\\s*null,`, 'm'), `${key} must not remain Shell-owned`);
  }
  assert.match(reader, /Object\.defineProperty\(shellState, key/);
});
check('all 20 implementations live in Reader; studio.js contains only thin delegates', () => {
  for (const name of MOVED) {
    assert.equal((reader.match(new RegExp(`function\\s+${name}\\s*\\(`, 'g')) || []).length, 1, `${name} Reader implementation`);
    assert.match(studio, new RegExp(`function ${name}\\(\\.\\.\\.args\\)\\{ return readerSessionCurrentRender\\.${name}\\(\\.\\.\\.args\\); \\}`), `${name} thin adapter`);
  }
});
check('resume state stays private, bounded, root-free and non-durable', () => {
  const controller = extract(reader, 'createReaderResumeController');
  assert.match(controller, /CAPACITY = 16/); assert.match(controller, /TOMBSTONE_CAPACITY = 16/);
  assert.match(controller, /return Object\.freeze\(\{ remember: capture, restore, forget \}\)/);
  assert.doesNotMatch(reader, /H2O\.Studio\.readerResume\s*=/);
  assert.doesNotMatch(controller, /localStorage|sessionStorage|chrome\.storage|indexedDB|postMessage|fetch\(|XMLHttpRequest|H2O\.MM|MiniMap/i);
});
check('Shell retains route/host/render orchestration and delegates Reader policy', () => {
  const unmount = extract(studio, 'studioHostUnmount');
  assert.ok(unmount.indexOf('state.readerResume?.remember?.(reason)') < unmount.indexOf('disposeReaderRenderDecorations(reason)'));
  assert.ok(unmount.indexOf('disposeReaderRenderDecorations(reason)') < unmount.indexOf('state.currentReaderRender = null'));
  const build = extract(studio, 'buildReaderDOM'); assert.match(build, /bindReaderSemanticIndex\(rendererResult\);/);
  const render = extract(studio, 'renderReader'); assert.match(render, /canReuseReaderDOM\(/); assert.match(render, /state\.readerResume\?\.restore\?\.\(\)/);
  assert.match(studio, /H2O\.Studio\.getReaderSemanticIndex = getReaderSemanticIndex;/);
  assert.match(studio, /H2O\.Studio\.getReaderDecorationContributions = getReaderDecorationContributions;/);
  assert.match(studio, /H2O\.Studio\.readerNavigation = Object\.freeze/);
});
check('Reader navigation uses only Shell .wbMain scroll context and no MiniMap authority', () => {
  const go = extract(reader, 'goToReaderTarget');
  assert.match(go, /root\.closest\('\.wbMain'\)/); assert.match(go, /scrollRoot\.scrollTo\(/);
  assert.doesNotMatch(go, /window\.scroll|scrollIntoView/);
  const readerCode = reader.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/.*$/gm, ' ');
  assert.doesNotMatch(readerCode, /H2O\.MM|MiniMap|miniMap|localStorage|sessionStorage|indexedDB|chrome\.storage/i);
});
check('Renderer lifecycle authority is consumed but never created or registered by Reader', () => {
  assert.doesNotMatch(reader, /createLifecycle\(|decorationContributions\??\.register\(|Renderer\.decorationContribution\b/);
  assert.match(extract(reader, 'disposeReaderRenderDecorations'), /lifecycle\.disposeAll\(\)/);
});
check('Candidate-3 Library and Candidate-1 Authoring boundaries remain in studio.js', () => {
  assert.match(studio, /H2O\?\.Library\?\.Maintenance\?\.folderOperatorMode/);
  assert.match(studio, /H2O\.Studio\.authoring\.editOverrideCompat\.configure\(/);
  assert.match(studio, /editOverrideCompat\.(?:get|set|hydrate|updateFromOverlay|removeSnapshot)/);
  assert.doesNotMatch(reader, /folderOperatorMode|editOverrideCompat|editOverlay/);
});
check('classic Reader module is admitted exactly once immediately before final studio.js', () => {
  const tag = '<script src="./reader/reader-session-current-render.studio.js"></script>';
  const final = '<script src="./studio.js?v=2.5.81"></script>';
  assert.equal((html.match(/reader\/reader-session-current-render\.studio\.js/g) || []).length, 1);
  assert.ok(html.indexOf(tag) >= 0 && html.indexOf(tag) < html.indexOf(final));
  assert.equal(html.slice(html.indexOf(tag) + tag.length, html.indexOf(final)).trim(), '');
});
check('paired Studio package inventories are 389/389 with exact Reader admission parity', async () => {
  const pack = await import(`${pathToFileURL(PACK_ABS).href}?c2=${Date.now()}`);
  const a = pack.ARCHIVE_WORKBENCH_SOURCE_FILES, b = pack.ARCHIVE_WORKBENCH_OUT_FILES;
  assert.equal(a.length, 389); assert.equal(b.length, 389); assert.equal(a.length, b.length);
  assert.equal(a.filter(x => x === READER_REL).length, 1); assert.equal(b.filter(x => x === READER_REL).length, 1);
  assert.equal(a.indexOf(READER_REL), b.indexOf(READER_REL));
  assert.equal(a.indexOf(READER_REL) + 1, a.indexOf('studio.js')); assert.equal(b.indexOf(READER_REL) + 1, b.indexOf('studio.js'));
});
check('exact 16-path authority is not exceeded', () => {
  const changed = new Set(git(['diff','--name-only',BASE] ).split('\n').filter(Boolean));
  const statusRun = spawnSync('git', ['status','--porcelain=v1','-uall'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  assert.equal(statusRun.status, 0, statusRun.stderr || 'git status failed');
  const status = statusRun.stdout.split('\n').filter(Boolean).map(line => line.slice(3));
  for (const rel of status) changed.add(rel);
  const extra = [...changed].filter(rel => !ALLOWED.has(rel));
  assert.deepEqual(extra, []);
  assert.ok(changed.size <= 16, `changed path count ${changed.size}`);
});
check('negative controls detect missing admission and non-thin adapter', () => {
  const tag = '<script src="./reader/reader-session-current-render.studio.js"></script>';
  assert.equal((html.replace(tag, '').match(/reader\/reader-session-current-render\.studio\.js/g) || []).length, 0);
  const mutated = studio.replace('return readerSessionCurrentRender.getReaderSemanticIndex(...args);', 'return null;');
  assert.doesNotMatch(mutated, /function getReaderSemanticIndex\(\.\.\.args\)\{ return readerSessionCurrentRender\.getReaderSemanticIndex\(\.\.\.args\); \}/);
});
console.log(`C2_T02_FOCUSED=PASS checks=${checks.length}`);
