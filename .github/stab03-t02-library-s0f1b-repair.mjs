#!/usr/bin/env node
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const BASE = 'c0bcee76b9ccf241a85b738dcc2b9ba482c3e4dd';
const path = 'src-surfaces-base/studio/S0F1b. 🎬 Library Workspace - Studio.js';
const original = execFileSync('git', ['show', `${BASE}:${path}`], { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
const oldBlock = `  // ── Layout persistence ─────────────────────────────────────────────────────
  function loadLayout() {
    if (cache.layout) return cache.layout;
    try {
      const raw = W.localStorage.getItem(LAYOUT_KEY);
      cache.layout = raw ? JSON.parse(raw) : { sidebarExpanded: true, view: 'saved' };
    } catch (e) { err('loadLayout', e); cache.layout = { sidebarExpanded: true, view: 'saved' }; }
    return cache.layout;
  }
  function saveLayout(patch) {
    try {
      const next = { ...loadLayout(), ...(patch || {}) };
      cache.layout = next;
      W.localStorage.setItem(LAYOUT_KEY, JSON.stringify(next));
      step('saveLayout', JSON.stringify(next));
      return true;
    } catch (e) { err('saveLayout', e); return false; }
  }`;
const newBlock = `  // ── Layout persistence ─────────────────────────────────────────────────────
  let layoutStoreHydrationStarted = false;
  function getLibraryStore() {
    try { return H2O.Library?.Store || null; } catch { return null; }
  }
  function readLegacyLayout() {
    try {
      const raw = W.localStorage.getItem(LAYOUT_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { err('loadLayout.legacy-read', e); return null; }
  }
  function hydrateLayoutFromStore() {
    if (layoutStoreHydrationStarted) return;
    layoutStoreHydrationStarted = true;
    const store = getLibraryStore();
    if (!store || typeof store.get !== 'function') return;
    Promise.resolve(store.get(LAYOUT_KEY)).then((stored) => {
      if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return;
      cache.layout = { sidebarExpanded: true, view: 'saved', ...stored };
      emitUpdated('layout-store-hydrate', { layout: { ...cache.layout } });
    }).catch((e) => err('loadLayout.store-read', e));
  }
  function loadLayout() {
    if (!cache.layout) {
      const legacy = readLegacyLayout();
      cache.layout = legacy && typeof legacy === 'object'
        ? { sidebarExpanded: true, view: 'saved', ...legacy }
        : { sidebarExpanded: true, view: 'saved' };
    }
    hydrateLayoutFromStore();
    return cache.layout;
  }
  function saveLayout(patch) {
    try {
      const next = { ...loadLayout(), ...(patch || {}) };
      cache.layout = next;
      const store = getLibraryStore();
      if (!store || typeof store.set !== 'function') throw new Error('Library Store unavailable');
      Promise.resolve(store.set(LAYOUT_KEY, next)).catch((e) => err('saveLayout.store-write', e));
      step('saveLayout', JSON.stringify(next));
      return true;
    } catch (e) { err('saveLayout', e); return false; }
  }`;
if (!original.includes(oldBlock)) throw new Error('baseline S0F1b layout block not found');
const repaired = original.replace(oldBlock, newBlock);
if (repaired === original) throw new Error('S0F1b repair made no change');
fs.writeFileSync(path, repaired);
console.log('STAB03_T02_LIBRARY_S0F1B_NARROW_REPAIR=PASS');
