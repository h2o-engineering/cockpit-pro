// ==UserScript==
// @h2o-id             s0f5a.tags.studio
// @name               S0F5a. 🎬 Tags - Studio
// @namespace          H2O.Premium.CGX.tags.studio
// @author             HumamDev
// @version            1.0.0
// @revision           001
// @build              260511-000011
// @description        Studio Tags facade. Derives tag pools from Library Index (which is fed by the chat-list service). Exposes counts, listing, and chat lookup by tag. Persists user tag prefs to Library Store under a Studio-isolated key.
// @match              https://chatgpt.com/*
// @run-at             document-idle
// @grant              none
// ==/UserScript==

(() => {
  'use strict';

  console.log('H2O DEV LOAD ✅ S0F5a Tags (Studio)', Date.now());

  const W = window;
  const H2O = (W.H2O = W.H2O || {});
  H2O.Library = H2O.Library || {};

  const PREFS_KEY = 'h2o:prm:cgx:library:tags:studio:prefs:v1';
  const diag = { t0: performance.now(), steps: [], errors: [], bufMax: 40, errMax: 15 };
  const step = (s, o = '') => { try { diag.steps.push({ t: Math.round(performance.now() - diag.t0), s: String(s), o: String(o) }); if (diag.steps.length > diag.bufMax) diag.steps.splice(0, diag.steps.length - diag.bufMax); } catch {} };
  const err = (s, e) => { try { diag.errors.push({ t: Math.round(performance.now() - diag.t0), s: String(s), e: String(e?.stack || e) }); if (diag.errors.length > diag.errMax) diag.errors.splice(0, diag.errors.length - diag.errMax); } catch {} };

  function getCore() { return H2O.LibraryCore || null; }
  function getIndex() { return H2O.LibraryIndex || null; }
  function getStore() { return H2O.Library?.Store || null; }
  function tagCore() {
    try {
      const api = H2O.Library?.TagProviderCore || null;
      return api && api.__phase === '5B' ? api : null;
    } catch {
      return null;
    }
  }

  let prefsStoreHydrationStarted = false;
  function loadPrefs() {
    try { return JSON.parse(W.localStorage.getItem(PREFS_KEY) || '{}') || {}; } catch { return {}; }
  }
  function hydratePrefsFromStore(target) {
    if (prefsStoreHydrationStarted) return;
    prefsStoreHydrationStarted = true;
    const store = getStore();
    if (!store || typeof store.get !== 'function') return;
    Promise.resolve(store.get(PREFS_KEY)).then((stored) => {
      if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return;
      Object.assign(target, stored);
    }).catch((e) => err('loadPrefs.store-read', e));
  }
  function savePrefs(p) {
    try {
      const store = getStore();
      if (!store || typeof store.set !== 'function') throw new Error('Library Store unavailable');
      Promise.resolve(store.set(PREFS_KEY, { ...(p || {}) })).catch((e) => err('savePrefs.store-write', e));
    } catch (e) { err('savePrefs', e); }
  }

  const prefs = loadPrefs();
  hydratePrefsFromStore(prefs);
  const state = { normalizationDiagnostics: [] };

  function rememberNormalization(diag) {
    try {
      if (!diag) return;
      state.normalizationDiagnostics.push({ ...diag, t: Date.now() });
      if (state.normalizationDiagnostics.length > 20) state.normalizationDiagnostics.splice(0, state.normalizationDiagnostics.length - 20);
    } catch {}
  }

  function normalizeTagFacetEntry(id, chatIds) {
    const rawId = String(id || '').trim();
    const ids = Array.isArray(chatIds) ? chatIds.slice() : [];
    const fallback = { id: rawId, chatIds: ids, count: ids.length };
    const api = tagCore();
    if (!api) return fallback;
    try {
      const valid = api.validateTagId?.(rawId);
      if (!valid?.ok) {
        rememberNormalization({ code: 'invalid-tag-id', tagId: rawId, reason: valid?.reason || 'invalid-tag-id' });
        return fallback;
      }
      const normalized = api.normalizeTag?.({ id: valid.tagId, label: rawId, usageCount: ids.length });
      if (!normalized?.id) return fallback;
      return { id: normalized.id, chatIds: ids, count: ids.length };
    } catch (e) {
      err('normalizeTagFacetEntry', e);
      return fallback;
    }
  }

  function normalizeTagQueryId(tagId) {
    const rawId = String(tagId || '').trim();
    if (!rawId) return '';
    const api = tagCore();
    if (!api) return rawId;
    try {
      const valid = api.validateTagId?.(rawId);
      if (valid?.ok) return valid.tagId;
      rememberNormalization({ code: 'invalid-tag-query', tagId: rawId, reason: valid?.reason || 'invalid-tag-id' });
      return rawId;
    } catch (e) {
      err('normalizeTagQueryId', e);
      return rawId;
    }
  }

  function listTags() {
    const idx = getIndex();
    if (!idx) return [];
    const f = idx.facets();
    return Object.entries(f.byTag || {})
      .map(([id, chatIds]) => normalizeTagFacetEntry(id, chatIds))
      .sort((a, b) => b.count - a.count);
  }

  function getChatsByTag(tagId) {
    const idx = getIndex();
    if (!idx) return [];
    return idx.query({ tag: normalizeTagQueryId(tagId) });
  }

  const Tags = {
    surface: 'studio',
    listTags,
    getChatsByTag,
    prefs: () => ({ ...prefs }),
    setPrefs(patch) { Object.assign(prefs, patch || {}); savePrefs(prefs); },
    diagnose() {
      const tags = listTags();
      const byTag = getIndex()?.facets?.().byTag || {};
      return {
        surface: 'studio',
        hasIndex: !!getIndex(),
        hasTagCore: !!tagCore(),
        tagCorePhase: tagCore()?.__phase || '',
        storeBackend: getStore()?.backend?.() || null,
        prefsKey: PREFS_KEY,
        prefs: { ...prefs },
        projection: {
          source: 'LibraryIndex.facets.byTag',
          facetCount: Object.keys(byTag || {}).length,
          tagCount: tags.length,
        },
        topTags: tags.slice(0, 12),
        normalizationDiagnostics: state.normalizationDiagnostics.slice(-8),
        steps: diag.steps.slice(-10),
        errors: diag.errors.slice(-5),
      };
    },
  };

  H2O.Tags = H2O.Tags || Tags;
  H2O.Library.Tags = Tags;

  function registerOnCore() {
    const core = getCore();
    if (!core) return false;
    try {
      core.registerOwner('tags', Tags, { replace: true });
      core.registerService('tags', Tags, { replace: true });
      core.registerRoute('tag',  async (route) => { step('route:tag', route?.id || ''); return true; }, { replace: true });
      core.registerRoute('tags', async () => { step('route:tags'); return true; }, { replace: true });
      step('register-on-core', 'tags');
      return true;
    } catch (e) { err('register-on-core', e); return false; }
  }
  if (!registerOnCore()) W.addEventListener('h2o.ev:prm:cgx:lib:ready:v1', () => registerOnCore(), { once: true });

  step('boot', 'studio-tags-ready');
})();
