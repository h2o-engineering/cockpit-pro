// ==UserScript==
// @h2o-id             s0f1d.library_insights.studio
// @name               S0F1d. 🎬 Library Insights - Studio
// @namespace          H2O.Premium.CGX.library_insights.studio
// @author             HumamDev
// @version            2.0.0
// @revision           002
// @build              260511-000020
// @description        Studio Library Insights v2: premium Dashboard / Explorer / Analytics surfaces with detail views for Folder, Category, Label, Tag. Renders into the Library overlay region; consumes Library Workspace + Library Index canonical models. Refined visual language with stat cards, sparklines, horizontal bar charts, time-bucketed chat lists, and filter chips.
// @match              https://chatgpt.com/*
// @run-at             document-idle
// @grant              none
// ==/UserScript==

(() => {
  'use strict';

  console.log('H2O DEV LOAD ✅ S0F1d Library Insights v2 (Studio)', Date.now());

  const W = window;
  const D = document;
  const H2O = (W.H2O = W.H2O || {});
  H2O.Library = H2O.Library || {};
  H2O.Studio = H2O.Studio || {};
  if (typeof H2O.Studio.libraryRibbonOpenSession !== 'boolean') {
    H2O.Studio.libraryRibbonOpenSession = false;
  }

  const PREFS_KEY = 'h2o:prm:cgx:library-insights:studio:prefs:v2';

  // ── Diagnostics ────────────────────────────────────────────────────────────
  const diag = { t0: performance.now(), steps: [], errors: [], bufMax: 80, errMax: 25 };
  const step = (s, o = '') => {
    try {
      diag.steps.push({ t: Math.round(performance.now() - diag.t0), s: String(s || ''), o: String(o || '') });
      if (diag.steps.length > diag.bufMax) diag.steps.splice(0, diag.steps.length - diag.bufMax);
    } catch {}
  };
  const err = (s, e) => {
    try {
      diag.errors.push({ t: Math.round(performance.now() - diag.t0), s: String(s || ''), e: String(e?.stack || e || '') });
      if (diag.errors.length > diag.errMax) diag.errors.splice(0, diag.errors.length - diag.errMax);
    } catch {}
  };

  // ── Service accessors ──────────────────────────────────────────────────────
  function getCore()      { return H2O.LibraryCore || null; }
  function getIndexCore() { return H2O.Library?.LibraryIndexCore || null; }
  function getIndex()     { return H2O.LibraryIndex || null; }
  function getWorkspace() { return H2O.LibraryWorkspace || null; }
  function getUIShell()   { return getCore()?.getService?.('ui-shell') || null; }
  function getPageHost()  { return getCore()?.getService?.('page-host') || null; }
  function getRouteSvc()  { return getCore()?.getService?.('route') || null; }
  function canonicalHeadlineCounts(rows) {
    const core = getIndexCore();
    if (core && typeof core.canonicalHeadlineCounts === 'function') {
      return core.canonicalHeadlineCounts(rows);
    }
    const total = Array.isArray(rows) ? rows.length : 0;
    return { total, saved: 0, link: 0, linked: 0, pinned: 0, archived: 0, folders: 0, labels: 0, categories: 0, projects: 0 };
  }
  function fallbackDedupeRows(rows) {
    const out = [];
    const seen = new Set();
    (Array.isArray(rows) ? rows : []).forEach((row, index) => {
      if (!row || typeof row !== 'object') return;
      const key = String(row.chatId || row.id || row.snapshotId || row.href || `row:${index}`);
      if (seen.has(key)) return;
      seen.add(key);
      out.push(row);
    });
    return out;
  }
  function canonicalActiveRows(rows) {
    const core = getIndexCore();
    if (core && typeof core.canonicalActiveRows === 'function') return core.canonicalActiveRows(rows);
    return fallbackDedupeRows(rows).filter((row) => {
      const st = getRowState(row);
      return !st.isDeleted && !st.isArchived;
    });
  }
  function canonicalArchivedRows(rows) {
    const core = getIndexCore();
    if (core && typeof core.canonicalArchivedRows === 'function') return core.canonicalArchivedRows(rows);
    return fallbackDedupeRows(rows).filter((row) => {
      const st = getRowState(row);
      return !st.isDeleted && st.isArchived;
    });
  }
  function canonicalActiveFacets(rows) {
    const core = getIndexCore();
    if (core && typeof core.canonicalActiveFacets === 'function') return core.canonicalActiveFacets(rows);
    if (core && typeof core.buildFacetsStudio === 'function') return core.buildFacetsStudio(canonicalActiveRows(rows));
    return { byView: {}, byFolder: {}, byCategory: {}, byProject: {}, byLabel: {}, byTag: {} };
  }
  function canonicalRowsForView(rows, view = 'all') {
    const core = getIndexCore();
    if (core && typeof core.canonicalRowsForView === 'function') return core.canonicalRowsForView(rows, view);
    const v = String(view || 'all').toLowerCase();
    if (v === 'archive' || v === 'archived') return canonicalArchivedRows(rows);
    const active = canonicalActiveRows(rows);
    if (v === 'all' || v === 'recent' || v === 'recents') return active;
    if (v === 'saved') return active.filter((row) => rowHasOpenableTranscriptContent(row) && getRowState(row).isSaved);
    if (v === 'linked' || v === 'link') return active.filter((row) => rowIsUrlOnlyLink(row));
    if (v === 'pinned') return active.filter((row) => getRowState(row).isPinned);
    return active.filter((row) => String(row.view || '').toLowerCase() === v);
  }
  function canonicalSortRows(rows, sort = 'recent') {
    const core = getIndexCore();
    if (core && typeof core.canonicalSortRows === 'function') return core.canonicalSortRows(rows, sort, 'best');
    return (Array.isArray(rows) ? rows : []).slice().sort((a, b) => {
      const dateCompare = asTs(b.updatedAt || b.capturedAt || b.createdAt) - asTs(a.updatedAt || a.capturedAt || a.createdAt);
      const titleCompare = String(a.title || '').localeCompare(String(b.title || ''));
      const idCompare = String(a.chatId || a.id || '').localeCompare(String(b.chatId || b.id || ''));
      if (sort === 'oldest') return -dateCompare || titleCompare || idCompare;
      if (sort === 'az') return titleCompare || dateCompare || idCompare;
      if (sort === 'mostTurns') return ((Number(b.messageCount) || 0) - (Number(a.messageCount) || 0)) || dateCompare || titleCompare || idCompare;
      return dateCompare || titleCompare || idCompare;
    });
  }
  function canonicalRecentRows(rows, limit = 20) {
    const core = getIndexCore();
    if (core && typeof core.canonicalRecentRows === 'function') return core.canonicalRecentRows(rows, limit, { dateField: 'best' });
    const sorted = canonicalSortRows(canonicalActiveRows(rows), 'recent');
    return Number.isFinite(Number(limit)) && Number(limit) >= 0 ? sorted.slice(0, Number(limit)) : sorted;
  }
  function savedRecentRowTime(row) {
    return asTs(row?.sortAt || row?.capturedAt || row?.lastCapturedAt || row?.snapshotCapturedAt || row?.savedAt || row?.createdAt || row?.lastMessageAt || row?.lastInteractionAt || row?.updatedAt || row?.lastSeenAt || row?.observedAt);
  }
  function canonicalSavedRecentRows(rows, limit = 20) {
    const core = getIndexCore();
    if (core && typeof core.canonicalSavedRecentRows === 'function') return core.canonicalSavedRecentRows(rows, limit, { dateField: 'savedRecent' });
    const saved = canonicalActiveRows(rows).filter((row) => rowHasOpenableTranscriptContent(row) && getRowState(row).isSaved);
    const sorted = saved.slice().sort((a, b) => {
      const dateCompare = savedRecentRowTime(b) - savedRecentRowTime(a);
      const titleCompare = String(a.title || '').localeCompare(String(b.title || ''));
      const idCompare = String(a.chatId || a.id || a.snapshotId || '').localeCompare(String(b.chatId || b.id || b.snapshotId || ''));
      return dateCompare || titleCompare || idCompare;
    });
    return Number.isFinite(Number(limit)) && Number(limit) >= 0 ? sorted.slice(0, Number(limit)) : sorted;
  }
  function canonicalRowTime(row) {
    const core = getIndexCore();
    if (core && typeof core.canonicalRowTime === 'function') return core.canonicalRowTime(row, 'best');
    return asTs(row?.updatedAt || row?.capturedAt || row?.createdAt);
  }

  // ── Preferences (persisted) ────────────────────────────────────────────────
  // Defaults are merged with whatever's in localStorage so old prefs survive a
  // schema bump (e.g. when we added folderFilter/categoryFilter/etc.).
  const PREF_DEFAULTS = {
    view: 'all',
    groupBy: 'date',
    sort: 'recent',
    search: '',
    folderFilter: '',
    categoryFilter: '',
    labelFilter: '',
    tagFilter: '',
    projectFilter: '',
  };
  let prefsStoreHydrationStarted = false;
  function getLibraryStore() {
    try { return H2O.Library?.Store || null; } catch { return null; }
  }
  function loadPrefs() {
    try { return Object.assign({}, PREF_DEFAULTS, JSON.parse(W.localStorage.getItem(PREFS_KEY) || '{}')); }
    catch { return Object.assign({}, PREF_DEFAULTS); }
  }
  function hydratePrefsFromStore(target) {
    if (prefsStoreHydrationStarted) return;
    prefsStoreHydrationStarted = true;
    const store = getLibraryStore();
    if (!store || typeof store.get !== 'function') return;
    Promise.resolve(store.get(PREFS_KEY)).then((stored) => {
      if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return;
      Object.assign(target, PREF_DEFAULTS, stored);
    }).catch((e) => err('loadPrefs.store-read', e));
  }
  function savePrefs(p) {
    try {
      const store = getLibraryStore();
      if (!store || typeof store.set !== 'function') throw new Error('Library Store unavailable');
      Promise.resolve(store.set(PREFS_KEY, { ...(p || {}) })).catch((e) => err('savePrefs.store-write', e));
    } catch (e) { err('savePrefs', e); }
  }

  const prefs = loadPrefs();
  hydratePrefsFromStore(prefs);

  // ── State ──────────────────────────────────────────────────────────────────
  const state = {
    rootEl: null,
    renderToken: 0,
    lastRoute: null,
    visible: false,
    activeLinkedRow: null,
    folderDisplay: {
      model: null,
      loading: false,
      error: '',
      ts: 0,
      requestId: 0,
    },
    showRefreshInFlight: null,
  };
  const LOCAL_REVIEW_EXPLANATION = 'These folders exist locally but are not in your native ChatGPT folder catalog. Read-only — no cleanup performed.';
  const LOCAL_REVIEW_BADGE_ORDER = Object.freeze(['extra', 'test', 'conflict', 'desktop-only', 'chrome-only', 'review-required']);

  // ── Pure helpers ───────────────────────────────────────────────────────────
  function esc(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;','\'':'&#39;' }[c])); }
  function el(tag, attrs = {}, children) {
    const node = D.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') node.className = String(v);
      else if (k === 'html') node.innerHTML = String(v);
      else if (k === 'text') node.textContent = String(v);
      else if (k === 'on' && v && typeof v === 'object') {
        for (const [ev, fn] of Object.entries(v)) if (typeof fn === 'function') node.addEventListener(ev, fn);
      }
      else if (k === 'data' && v && typeof v === 'object') {
        for (const [dk, dv] of Object.entries(v)) node.dataset[dk] = String(dv);
      }
      else node.setAttribute(k, String(v));
    }
    if (children != null) {
      const arr = Array.isArray(children) ? children : [children];
      for (const c of arr) {
        if (c == null || c === false) continue;
        if (c instanceof Node) node.appendChild(c);
        else node.appendChild(D.createTextNode(String(c)));
      }
    }
    return node;
  }
  function svg(viewBox, paths, opts = {}) {
    const ns = 'http://www.w3.org/2000/svg';
    const s = D.createElementNS(ns, 'svg');
    s.setAttribute('viewBox', viewBox);
    s.setAttribute('aria-hidden', 'true');
    s.setAttribute('focusable', 'false');
    if (opts.width) s.setAttribute('width', String(opts.width));
    if (opts.height) s.setAttribute('height', String(opts.height));
    if (opts.fill !== undefined) s.setAttribute('fill', String(opts.fill));
    for (const p of (Array.isArray(paths) ? paths : [paths])) {
      const path = D.createElementNS(ns, 'path');
      for (const [k, v] of Object.entries(p || {})) path.setAttribute(k, String(v));
      s.appendChild(path);
    }
    return s;
  }

  // ── Date / time helpers ────────────────────────────────────────────────────
  function asTs(value) {
    if (!value) return 0;
    if (typeof value === 'number' && Number.isFinite(value)) return value < 1e12 ? value * 1000 : value;
    const n = Date.parse(String(value));
    return Number.isFinite(n) ? n : 0;
  }
  function dayKey(ts) { const d = new Date(ts || 0); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; }
  function dayDiff(a, b) { return Math.floor((b - a) / 86400000); }
  function dateBucketLabel(ts) {
    if (!ts) return 'No date';
    const now = Date.now();
    const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
    const tsStart = new Date(ts); tsStart.setHours(0, 0, 0, 0);
    const diff = dayDiff(tsStart.getTime(), todayStart.getTime());
    if (diff === 0) return 'Today';
    if (diff === 1) return 'Yesterday';
    if (diff < 7) return 'This week';
    if (diff < 30) return 'This month';
    const sameYear = new Date(ts).getFullYear() === new Date(now).getFullYear();
    return sameYear
      ? new Intl.DateTimeFormat(undefined, { month: 'long' }).format(ts)
      : new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'long' }).format(ts);
  }
  function formatDateShort(ts) {
    if (!ts) return '';
    try { return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(ts); }
    catch { return ''; }
  }
  function formatNumber(n) {
    const v = Number(n) || 0;
    if (v >= 1000) return `${(v / 1000).toFixed(v >= 10000 ? 0 : 1)}k`;
    return String(v);
  }

  // ── Visual primitives ──────────────────────────────────────────────────────
  function Sparkline(values, { width = 168, height = 36, color = 'var(--wb-library-accent)' } = {}) {
    const ns = 'http://www.w3.org/2000/svg';
    const s = D.createElementNS(ns, 'svg');
    s.setAttribute('viewBox', `0 0 ${width} ${height}`);
    s.setAttribute('class', 'wbInsightsSparkline');
    s.setAttribute('aria-hidden', 'true');
    const data = (Array.isArray(values) && values.length ? values : [0, 0]).map((v) => Number(v) || 0);
    const max = Math.max(1, ...data);
    const step = data.length > 1 ? width / (data.length - 1) : width;
    const points = data.map((v, i) => `${(i * step).toFixed(2)},${(height - (v / max) * (height - 4) - 2).toFixed(2)}`);
    const lineD = `M ${points.join(' L ')}`;
    const areaD = `${lineD} L ${(width).toFixed(2)},${(height).toFixed(2)} L 0,${(height).toFixed(2)} Z`;
    const grad = D.createElementNS(ns, 'linearGradient');
    grad.setAttribute('id', 'wbSparkGrad');
    grad.setAttribute('x1', '0'); grad.setAttribute('y1', '0');
    grad.setAttribute('x2', '0'); grad.setAttribute('y2', '1');
    const stop1 = D.createElementNS(ns, 'stop');
    stop1.setAttribute('offset', '0%'); stop1.setAttribute('stop-color', color); stop1.setAttribute('stop-opacity', '0.42');
    const stop2 = D.createElementNS(ns, 'stop');
    stop2.setAttribute('offset', '100%'); stop2.setAttribute('stop-color', color); stop2.setAttribute('stop-opacity', '0');
    grad.append(stop1, stop2);
    const defs = D.createElementNS(ns, 'defs');
    defs.appendChild(grad);
    s.appendChild(defs);
    const area = D.createElementNS(ns, 'path');
    area.setAttribute('d', areaD); area.setAttribute('fill', 'url(#wbSparkGrad)'); area.setAttribute('stroke', 'none');
    s.appendChild(area);
    const line = D.createElementNS(ns, 'path');
    line.setAttribute('d', lineD); line.setAttribute('fill', 'none');
    line.setAttribute('stroke', color); line.setAttribute('stroke-width', '1.5');
    line.setAttribute('stroke-linejoin', 'round'); line.setAttribute('stroke-linecap', 'round');
    s.appendChild(line);
    return s;
  }

  function StatCard({ value, label, hint, accent }) {
    return el('div', { class: 'wbStatCard', data: accent ? { accent: 'true' } : undefined }, [
      el('div', { class: 'wbStatCardVal' }, formatNumber(value)),
      el('div', { class: 'wbStatCardLabel' }, label),
      hint ? el('div', { class: 'wbStatCardHint' }, hint) : null,
    ]);
  }

  function Pill({ label, count, active = false, onClick, accent }) {
    const node = el('button', {
      class: `wbPill${active ? ' is-active' : ''}`,
      type: 'button',
      data: accent ? { accent } : undefined,
      on: { click: onClick },
    }, [
      el('span', { class: 'wbPillLabel' }, label),
      (count != null) ? el('span', { class: 'wbPillCount' }, formatNumber(count)) : null,
    ]);
    return node;
  }

  function BarRow({ name, count, total, swatch }) {
    // A zero count must read as 0% — the previous Math.max(2, …) floor was
    // only meant to keep tiny but non-zero bars visible. Apply the visual
    // minimum only when count > 0; otherwise 0 stays 0.
    const rawPct = total > 0 ? Math.round((count / total) * 100) : 0;
    const pct = count > 0 ? Math.max(2, Math.min(100, rawPct)) : 0;
    return el('div', { class: 'wbBarRow' }, [
      swatch ? el('span', { class: 'wbBarSwatch', style: `background:${swatch}` }) : null,
      el('div', { class: 'wbBarRowBody' }, [
        el('div', { class: 'wbBarRowHead' }, [
          el('span', { class: 'wbBarRowName' }, name),
          el('span', { class: 'wbBarRowCount' }, [
            el('strong', {}, formatNumber(count)),
            el('span', { class: 'wbBarRowPct' }, ` · ${pct}%`),
          ]),
        ]),
        el('div', { class: 'wbBarRowTrack' }, [
          el('div', { class: 'wbBarRowFill', style: `width:${pct}%` }),
        ]),
      ]),
    ]);
  }

  // Resolve a row's snapshot id with defensive fallbacks. The Library Index
  // normalizer already checks the common keys, but if the archive ever
  // returns a shape it hasn't seen we fall back to row.raw so click-to-open
  // never silently fails. The route used (#/read/<snapshotId>) is exactly
  // the one studio.js's saved-list `button.addEventListener('click', ...)`
  // navigates to (studio.js line 2659) — same Studio reader is reused.
  function resolveSnapshotId(row) {
    if (!row) return '';
    const raw = row.raw || {};
    return String(
      row.snapshotId
      || row.lastSnapshotId
      || row.latestSnapshotId
      || raw.snapshotId
      || raw.lastSnapshotId
      || raw.latestSnapshotId
      || raw.snapId
      || raw.snapshot_id
      || raw.snapshot?.id
      || raw.snapshot?.snapshotId
      || raw.meta?.snapshotId
      || raw.meta?.lastSnapshotId
      || raw.meta?.latestSnapshotId
      || ''
    ).trim();
  }

  // Phase 5 — flatten state regardless of whether the row carries the new
  // normalized shape (state: { isLinked, isSaved, ... }) or the legacy shape
  // (state on raw only). Callers always go through this helper so the
  // upstream S0F1c pass-through can be tightened later without churn here.
  function getRowState(row) {
    if (!row) return { isLinked: false, isSaved: false, isImported: false };
    const a = (row.state && typeof row.state === 'object') ? row.state : null;
    const b = (row.raw && row.raw.state && typeof row.raw.state === 'object') ? row.raw.state : null;
    const raw = row.raw || {};
    const displayView = String(row.displayView || row.badgeKind || row.view || raw.displayView || raw.badgeKind || raw.view || '').toLowerCase();
    const displayIsLink = displayView === 'link' || displayView === 'linked';
    const displayIsSaved = displayView === 'saved';
    return {
      isLinked:   !!(a?.isLinked   || b?.isLinked   || row.isLinked   || raw.isLinked),
      isSaved:    displayIsLink ? false : !!(displayIsSaved || a?.isSaved || b?.isSaved || row.isSaved || raw.isSaved),
      isImported: !!(a?.isImported || b?.isImported || row.isImported || raw.isImported),
    };
  }

  // Phase 5 — produce a real chatgpt.com URL from the row's stored link
  // provenance. Returns '' for records with no source URL (imported-only).
  function resolveLinkedUrl(row) {
    if (!row) return '';
    const r = row.raw || {};
    const raw = String(
      row.linkSourceHref
      || row.href
      || row.normalizedHref
      || r.linkSourceHref
      || r.href
      || r.normalizedHref
      || ''
    ).trim();
    if (!raw) return '';
    if (raw.startsWith('http://') || raw.startsWith('https://')) return raw;
    if (raw.startsWith('/')) return `https://chatgpt.com${raw}`;
    return '';
  }

  function isLinkedOnlyRow(row) {
    if (!row || rowHasTranscriptContent(row)) return false;
    const raw = row.raw || {};
    const view = String(row.displayView || row.view || raw.displayView || raw.view || '').toLowerCase();
    const st = getRowState(row);
    return view === 'linked' || view === 'link' || !!st.isLinked || !!resolveLinkedUrl(row);
  }

  function rowHasTranscriptContent(row) {
    if (!row) return false;
    const raw = row.raw || {};
    if (resolveSnapshotId(row)) return true;
    const hasRawMessageCount = Object.prototype.hasOwnProperty.call(raw, 'messageCount')
      || Object.prototype.hasOwnProperty.call(raw, 'turnCount')
      || Object.prototype.hasOwnProperty.call(raw, 'userTurnCount')
      || Object.prototype.hasOwnProperty.call(raw, 'assistantTurnCount');
    const hasSnapshotArrayEvidence = Array.isArray(raw.snapshots)
      && raw.snapshots.some((snap) => {
        if (!snap || typeof snap !== 'object') return false;
        return !!(
          snap.snapshotId
          || snap.id
          || Number(snap.messageCount || 0) > 0
          || Number(snap.turnCount || 0) > 0
        );
      });
    const messageCount = Number(hasRawMessageCount
      ? (raw.messageCount ?? raw.turnCount ?? Math.max(Number(raw.userTurnCount) || 0, Number(raw.assistantTurnCount) || 0) ?? 0)
      : (row.messageCount ?? row.turnCount ?? Math.max(Number(row.userTurnCount) || 0, Number(row.assistantTurnCount) || 0) ?? 0)) || 0;
    const view = String(row.displayView || row.view || raw.displayView || raw.view || '').toLowerCase();
    const st = getRowState(row);
    if (!st.isSaved && (view === 'linked' || view === 'imported' || st.isLinked || st.isImported) && resolveLinkedUrl(row) && messageCount <= 0) {
      return false;
    }
    return hasSnapshotArrayEvidence || messageCount > 0;
  }

  function rowHasOpenableTranscriptContent(row) {
    return rowHasTranscriptContent(row);
  }

  async function resolveReaderSnapshotId(row) {
    const direct = resolveSnapshotId(row);
    if (direct) return direct;
    const raw = row?.raw || {};
    const chatId = String(row?.chatId || raw.chatId || '').trim();
    if (!chatId) return '';
    try {
      const snapshots = H2O.Studio?.store?.snapshots || null;
      if (snapshots && typeof snapshots.listByChat === 'function') {
        const list = await snapshots.listByChat(chatId);
        const first = Array.isArray(list) ? list.find((snap) => resolveSnapshotId(snap)) : null;
        const sid = resolveSnapshotId(first);
        if (sid) return sid;
      }
    } catch (e) { err('resolveReaderSnapshotId.snapshots', e); }
    try {
      const chatList = getCore()?.getService?.('chat-list') || null;
      if (chatList && typeof chatList.listAll === 'function') {
        const rows = await chatList.listAll();
        const match = Array.isArray(rows)
          ? rows.find((candidate) => String(candidate?.chatId || candidate?.id || '').trim() === chatId && resolveSnapshotId(candidate))
          : null;
        const sid = resolveSnapshotId(match);
        if (sid) return sid;
      }
    } catch (e) { err('resolveReaderSnapshotId.chat-list', e); }
    return '';
  }

  function rowIsUrlOnlyLink(row) {
    if (!row || rowHasOpenableTranscriptContent(row)) return false;
    const raw = row.raw || {};
    const st = getRowState(row);
    const view = String(row.displayView || row.view || raw.displayView || raw.view || '').toLowerCase();
    return !!resolveLinkedUrl(row) || view === 'linked' || view === 'link' || !!st.isLinked || isImportedShellRow(row);
  }

  function looksLikeOpaqueTitle(value, row) {
    const text = String(value == null ? '' : value).trim();
    if (!text) return true;
    const raw = row?.raw || {};
    const chatId = String(row?.chatId || raw.chatId || '').trim();
    if (chatId && text === chatId) return true;
    if (/^(imported chat|linked chat|untitled chat|link|chatgpt)$/i.test(text)) return true;
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(text)) return true;
    if (/^[0-9a-f][0-9a-f-]{23,}$/i.test(text)) return true;
    if (/^(imported|chat|conversation)[-_:][a-z0-9-]{12,}$/i.test(text)) return true;
    return false;
  }

  function isImportedShellRow(row) {
    if (!row || rowHasTranscriptContent(row)) return false;
    const raw = row.raw || {};
    const view = String(row.displayView || row.view || raw.displayView || raw.view || '').toLowerCase();
    const st = getRowState(row);
    return view === 'imported' || !!st.isImported;
  }

  function rowPlaceholderKind(row) {
    if (isImportedShellRow(row)) return 'imported';
    if (isLinkedOnlyRow(row)) return 'linked';
    return '';
  }

  function displayTitleForRow(row, fallback = 'Untitled chat') {
    const raw = row?.raw || {};
    const meta = (row?.meta && typeof row.meta === 'object') ? row.meta : {};
    const rawMeta = (raw.meta && typeof raw.meta === 'object') ? raw.meta : {};
    const source = (row?.source && typeof row.source === 'object') ? row.source : {};
    const rawSource = (raw.source && typeof raw.source === 'object') ? raw.source : {};
    const candidates = [
      row?.title, raw.title,
      row?.displayTitle, raw.displayTitle,
      row?.sourceTitle, raw.sourceTitle,
      row?.pageTitle, raw.pageTitle,
      row?.chatTitle, raw.chatTitle,
      row?.originalTitle, raw.originalTitle,
      row?.name, raw.name,
      meta.title, rawMeta.title,
      meta.displayTitle, rawMeta.displayTitle,
      meta.sourceTitle, rawMeta.sourceTitle,
      meta.pageTitle, rawMeta.pageTitle,
      meta.chatTitle, rawMeta.chatTitle,
      meta.originalTitle, rawMeta.originalTitle,
      source.title, rawSource.title,
      source.displayTitle, rawSource.displayTitle,
      source.sourceTitle, rawSource.sourceTitle,
      source.pageTitle, rawSource.pageTitle,
      source.chatTitle, rawSource.chatTitle,
      source.originalTitle, rawSource.originalTitle,
      row?.filename, raw.filename,
      row?.sourceLabel, raw.sourceLabel,
      source.filename, rawSource.filename,
      source.label, rawSource.label,
    ];
    for (const candidate of candidates) {
      const title = String(candidate || '').trim();
      if (title && !looksLikeOpaqueTitle(title, row)) return title;
    }
    const kind = rowPlaceholderKind(row);
    if (kind === 'imported') return 'Imported chat';
    if (kind === 'linked') return 'Link';
    return String(fallback || 'Untitled chat');
  }

  function sameChatRow(a, b) {
    const aChat = String(a?.chatId || a?.raw?.chatId || '').trim();
    const bChat = String(b?.chatId || b?.raw?.chatId || '').trim();
    if (aChat && bChat) return aChat === bChat;
    const aUrl = resolveLinkedUrl(a);
    const bUrl = resolveLinkedUrl(b);
    return !!(aUrl && bUrl && aUrl === bUrl);
  }

  function formatLinkedDetailDate(value) {
    const ts = asTs(value);
    return ts ? formatDateShort(ts) : String(value || '').trim();
  }

  function getSaveToFolderAction() {
    const actions = H2O.LibraryActions || H2O.Library?.Actions || H2O.Library?.actions || null;
    if (!actions || typeof actions.saveToFolder !== 'function') return null;
    try {
      const supported = actions.diagnose?.()?.supportedActions?.saveToFolder;
      if (supported === false) return null;
    } catch {}
    return actions.saveToFolder.bind(actions);
  }

  function openOriginalUrl(url, setStatus) {
    if (!url) return;
    try { setStatus?.('Opening original...'); } catch {}
    const runtime = H2O.Studio?.platform?.runtime || null;
    if (!runtime || typeof runtime.openUrl !== 'function') {
      try { setStatus?.('Could not open original: platform runtime unavailable'); } catch {}
      return;
    }
    Promise.resolve(runtime.openUrl(url)).then(
      () => { try { setStatus?.(''); } catch {} },
      (openErr) => {
        const msg = openErr?.message || openErr || 'unknown error';
        try { setStatus?.('Could not open original: ' + String(msg)); } catch {}
      }
    );
  }

  function extractTitleFromHtml(html) {
    try {
      const doc = new DOMParser().parseFromString(String(html || ''), 'text/html');
      const og = doc.querySelector('meta[property="og:title"],meta[name="twitter:title"]');
      const title = String(og?.getAttribute('content') || doc.querySelector('title')?.textContent || '').trim();
      return looksLikeOpaqueTitle(title, null) ? '' : title;
    } catch { return ''; }
  }

  function metadataFailureCopy(reason) {
    switch (String(reason || '').trim()) {
      case 'permission-denied':
      case 'permission-api-unavailable':
      case 'permission-check-failed':
        return 'Could not update from URL: permission/metadata unavailable';
      case 'host-permission-missing':
        return 'Could not update from URL: permission/metadata unavailable';
      case 'background-unavailable':
        return 'Could not update from URL: background unavailable';
      case 'cors-blocked':
        return 'Could not update from URL: CORS/fetch blocked';
      case 'source-unavailable':
        return 'Could not update from URL: source unavailable';
      case 'no-title-found':
      case 'metadata-title-missing':
        return 'Could not read title from URL: source page did not expose title';
      case 'source-tab-not-open':
        return 'Open the source tab first, then click Update from URL again';
      case 'open-tab-title-generic':
        return 'Could not read title from URL: open source tab title was not specific';
      case 'invalid-url':
      case 'unsupported-url':
        return 'Could not update from URL: invalid URL';
      case 'network-error':
      case 'metadata-fetch-failed':
        return 'Could not update from URL: network error';
      case 'metadata-store-unavailable':
        return 'Could not update from URL: metadata store unavailable';
      default:
        return 'Could not update from URL';
    }
  }

  function callArchiveMetadataFetch(url) {
    return new Promise((resolve) => {
      try {
        const messaging = H2O.Studio?.platform?.messaging || null;
        if (!messaging || typeof messaging.send !== 'function') { resolve(null); return; }
        const message = {
          type: 'h2o-ext-archive:v1',
          req: { op: 'fetchPageMetadata', payload: { url } },
        };
        Promise.resolve(messaging.send('h2o-ext-archive:v1', message))
          .then((response) => resolve(response && response.ok ? response.result : null))
          .catch(() => resolve(null));
      } catch (e) {
        err('callArchiveMetadataFetch', e);
        resolve(null);
      }
    });
  }

  function requiresBackgroundMetadataFetch(url) {
    try {
      const parsed = new URL(String(url || ''));
      const host = parsed.hostname.toLowerCase();
      return parsed.protocol === 'https:' && (host === 'chatgpt.com' || host.endsWith('.chatgpt.com'));
    } catch {
      return false;
    }
  }

  function classifyDirectMetadataFetchError(error) {
    const msg = String(error?.message || error || '').toLowerCase();
    if (msg.includes('unsupported-url')) return 'unsupported-url';
    if (msg.includes('metadata-title-missing')) return 'no-title-found';
    if (msg.includes('http 4') || msg.includes('http 5')) return 'source-unavailable';
    if (msg.includes('failed to fetch') || msg.includes('cors')) return 'cors-blocked';
    if (msg.includes('network')) return 'network-error';
    return 'network-error';
  }

  async function fetchTitleFromUrl(url) {
    const href = String(url || '').trim();
    if (!/^https?:\/\//i.test(href)) return { ok: false, reason: 'unsupported-url' };
    const archiveResult = await callArchiveMetadataFetch(href);
    if (archiveResult && archiveResult.ok === true) {
      const title = String(archiveResult.title || archiveResult.displayTitle || archiveResult.sourceTitle || '').trim();
      if (title && !looksLikeOpaqueTitle(title, null)) return { ok: true, title, source: 'background' };
      return { ok: false, reason: 'no-title-found', source: 'background' };
    }
    if (archiveResult && archiveResult.reason && archiveResult.reason !== 'permission-api-unavailable') {
      const reason = archiveResult.reason === 'permission-denied' ? 'host-permission-missing' : archiveResult.reason;
      return { ok: false, reason, source: 'background' };
    }
    if (requiresBackgroundMetadataFetch(href)) {
      return { ok: false, reason: archiveResult?.reason === 'permission-api-unavailable' ? 'host-permission-missing' : 'background-unavailable', source: 'background' };
    }
    try {
      const response = await fetch(href, { method: 'GET', credentials: 'omit', cache: 'no-store' });
      if (!response || !response.ok) {
        return { ok: false, reason: 'source-unavailable', status: Number(response?.status || 0), source: 'direct' };
      }
      const text = await response.text();
      const title = extractTitleFromHtml(text);
      if (!title) return { ok: false, reason: 'no-title-found', source: 'direct' };
      return { ok: true, title, source: 'direct' };
    } catch (error) {
      return { ok: false, reason: classifyDirectMetadataFetchError(error), source: 'direct' };
    }
  }

  function applyLocalTitleToRow(row, title, url) {
    if (!row) return;
    const raw = row.raw || {};
    const meta = row.meta && typeof row.meta === 'object' ? row.meta : {};
    const rawMeta = raw.meta && typeof raw.meta === 'object' ? raw.meta : {};
    row.title = title;
    row.displayTitle = title;
    row.sourceTitle = title;
    row.pageTitle = title;
    row.originalTitle = title;
    row.href = row.href || url;
    row.normalizedHref = row.normalizedHref || url;
    row.linkSourceHref = row.linkSourceHref || url;
    row.meta = Object.assign({}, meta, {
      displayTitle: title,
      sourceTitle: title,
      pageTitle: title,
      originalTitle: title,
      titleSource: 'title',
    });
    raw.title = title;
    raw.titleSource = 'title';
    raw.displayTitle = title;
    raw.sourceTitle = title;
    raw.pageTitle = title;
    raw.originalTitle = title;
    raw.href = raw.href || url;
    raw.normalizedHref = raw.normalizedHref || url;
    raw.linkSourceHref = raw.linkSourceHref || url;
    raw.meta = Object.assign({}, rawMeta, row.meta);
  }

  async function persistUrlMetadataTitle(row, title, url) {
    const raw = row?.raw || {};
    const chatId = String(row?.chatId || raw.chatId || '').trim();
    if (!chatId) throw new Error('chat-id-missing');
    const observedAt = new Date().toISOString();
    let wrote = false;
    const metaPatch = {
      displayTitle: title,
      sourceTitle: title,
      pageTitle: title,
      originalTitle: title,
      titleSource: 'title',
      f19UrlMetadataUpdatedAt: observedAt,
    };
    const chatStore = H2O.Studio?.store?.chats || null;
    if (chatStore && typeof chatStore.patch === 'function') {
      await chatStore.patch(chatId, {
        title,
        href: url,
        normalizedHref: url,
        linkSourceHref: url,
        meta: metaPatch,
      });
      wrote = true;
    }
    const registry = H2O.ChatRegistry || H2O.Library?.ChatRegistry || null;
    if (registry && typeof registry.upsertRecord === 'function') {
      const existing = typeof registry.getRecord === 'function' ? (registry.getRecord(chatId) || {}) : {};
      registry.upsertRecord({
        ...existing,
        chatId,
        title,
        titleSource: 'title',
        displayTitle: title,
        sourceTitle: title,
        pageTitle: title,
        originalTitle: title,
        href: url,
        normalizedHref: url,
        linkSourceHref: url,
        state: {
          ...(existing.state || {}),
          isLinked: true,
          isImported: !!(existing.state?.isImported || getRowState(row).isImported),
        },
        meta: {
          ...(existing.meta || {}),
          ...metaPatch,
        },
      }, {
        source: 'f19-url-metadata-refresh',
        observedAt,
      });
      wrote = true;
    }
    if (!wrote) throw new Error('metadata-store-unavailable');
    applyLocalTitleToRow(row, title, url);
    try { await H2O.LibraryIndex?.refresh?.('f19.6c-update-from-url'); } catch {}
  }

  async function updateRowMetadataFromUrl(row, url, setStatus) {
    try {
      setStatus?.('Updating from URL...');
      const metadata = await fetchTitleFromUrl(url);
      if (!metadata || metadata.ok !== true || !metadata.title || looksLikeOpaqueTitle(metadata.title, row)) {
        setStatus?.(metadataFailureCopy(metadata && metadata.reason));
        return;
      }
      await persistUrlMetadataTitle(row, metadata.title, url);
      setStatus?.('Updated title from URL.');
      render();
    } catch (error) {
      setStatus?.(metadataFailureCopy(error && error.message));
    }
  }

  function renderLinkedDetailsPanel(row) {
    const raw = row?.raw || {};
    const kind = rowPlaceholderKind(row);
    const imported = kind === 'imported';
    const title = displayTitleForRow(row, imported ? 'Imported chat' : 'Link');
    const url = resolveLinkedUrl(row);
    const linkedAt = formatLinkedDetailDate(row?.linkedAt || raw.linkedAt || row?.capturedAt || raw.capturedAt || row?.updatedAt || raw.updatedAt);
    const linkedFrom = String(row?.linkedFrom || raw.linkedFrom || '').trim();
    const chatId = String(row?.chatId || raw.chatId || '').trim();
    const saveToFolder = getSaveToFolderAction();
    const status = el('div', {
      class: 'wbLinkedDetailsStatus',
      style: 'min-height:16px;margin-top:12px;font-size:12px;opacity:.7',
      'aria-live': 'polite',
    });
    const setStatus = (msg) => { status.textContent = String(msg || ''); };

    const metaRows = [
      ['URL', el('code', { style: 'white-space:normal;word-break:break-all' }, url || 'Unavailable')],
      [imported ? 'Imported at' : 'Link at', linkedAt || 'Unavailable'],
      [imported ? 'Imported from' : 'Link from', linkedFrom || (imported ? 'sync-folder' : 'Unavailable')],
      ['Chat ID', el('code', { style: 'word-break:break-all' }, chatId || 'Unavailable')],
    ].map(([label, value]) => [
      el('div', { style: 'opacity:.58' }, label),
      value instanceof Node ? el('div', {}, value) : el('div', {}, value),
    ]).flat();

    const openBtn = el('button', {
      type: 'button',
      class: 'wbLinkedDetailsOpen',
      data: { linkedAction: 'open-original' },
      style: 'padding:8px 14px;border-radius:6px;border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.07);color:inherit;font:inherit;font-weight:600;cursor:pointer',
    }, imported ? 'Open source' : 'Open original');
    if (!url) openBtn.disabled = true;
    openBtn.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      openOriginalUrl(url, setStatus);
    });

    const updateBtn = el('button', {
      type: 'button',
      class: 'wbLinkedDetailsUpdateUrl',
      data: { linkedAction: 'update-from-url' },
      style: 'padding:8px 14px;border-radius:6px;border:1px solid rgba(255,255,255,.14);background:rgba(125,211,252,.10);color:inherit;font:inherit;font-weight:600;cursor:pointer',
    }, 'Update from URL');
    if (!url) updateBtn.disabled = true;
    updateBtn.addEventListener('click', async (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      updateBtn.disabled = true;
      try { await updateRowMetadataFromUrl(row, url, setStatus); }
      finally { updateBtn.disabled = !url; }
    });

    const closeBtn = el('button', {
      type: 'button',
      class: 'wbLinkedDetailsClose',
      data: { linkedAction: 'close' },
      style: 'padding:8px 14px;border-radius:6px;border:1px solid rgba(255,255,255,.10);background:transparent;color:inherit;font:inherit;cursor:pointer;opacity:.78',
    }, imported ? 'Back to Library' : 'Back to Link list');
    closeBtn.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      state.activeLinkedRow = null;
      render();
    });

    const actions = [openBtn, updateBtn];
    if (saveToFolder) {
      const saveBtn = el('button', {
        type: 'button',
        class: 'wbLinkedDetailsSave',
        data: { linkedAction: 'save-to-folder' },
        style: 'padding:8px 14px;border-radius:6px;border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.05);color:inherit;font:inherit;cursor:pointer',
      }, 'Save to Folder');
      saveBtn.addEventListener('click', async (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        setStatus('Requesting Save to Folder...');
        try {
          const result = await saveToFolder({ chatId, href: url, title });
          if (result?.ok === false) setStatus(`Save to Folder failed: ${String(result.reason || result.error || 'unknown')}`);
          else setStatus('Save to Folder requested.');
        } catch (e) {
          setStatus(`Save to Folder failed: ${String(e?.message || e || 'unknown')}`);
        }
      });
      actions.push(saveBtn);
    }
    actions.push(closeBtn);

    return el('section', {
      class: 'wbLinkedDetailsPanel',
      role: 'region',
      'aria-label': imported ? 'Imported chat placeholder details' : 'Link details',
      style: 'margin:0 0 14px;padding:18px 20px;border:1px solid rgba(255,255,255,.10);border-radius:8px;background:rgba(255,255,255,.035)',
      data: { chatId },
    }, [
      el('div', { style: 'font-size:11px;letter-spacing:.08em;text-transform:uppercase;opacity:.56;margin-bottom:6px' }, imported ? 'Imported placeholder' : 'Link placeholder'),
      el('h2', { style: 'margin:0 0 12px;font-size:20px;line-height:1.3;font-weight:650' }, title),
      el('p', { style: 'margin:0 0 14px;font-size:13px;line-height:1.45;opacity:.72' },
        imported
          ? 'This row was synced as metadata only. Transcript content is not present on this surface; use the source link when available or keep it as a Library placeholder.'
          : 'This row is URL metadata only. Transcript content is not present on this surface; open the source link or update its safe metadata from the URL.'
      ),
      el('div', {
        class: 'wbLinkedDetailsMeta',
        style: 'display:grid;grid-template-columns:max-content minmax(0,1fr);gap:6px 14px;margin:0 0 16px;font-size:13px;font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace',
      }, metaRows),
      el('div', { style: 'display:flex;gap:10px;flex-wrap:wrap' }, actions),
      status,
    ]);
  }

  function ChatRow(row, idx) {
    const sid = resolveSnapshotId(row);
    const st = getRowState(row);
    const linkedUrl = resolveLinkedUrl(row);
    const placeholderKind = rowPlaceholderKind(row);
    const opensLinkedDetails = !!placeholderKind;
    // Click target priority: saved+snapshot → Studio reader; linked/imported
    // metadata-only shell rows → in-page details; otherwise the row is inert.
    const opensReader = rowHasOpenableTranscriptContent(row) && !st.isDeleted;
    const displayTitle = displayTitleForRow(row);
    const hasTranscript = rowHasOpenableTranscriptContent(row);
    const urlOnlyLink = rowIsUrlOnlyLink(row);

    const meta = [];
    if (row.folderName) meta.push(`📁 ${row.folderName}`);
    else if (row.folderId) meta.push(`📁 ${row.folderId.slice(0, 8)}…`);
    if (row.categoryName) meta.push(`◆ ${row.categoryName}`);
    if (row.messageCount) meta.push(`${row.messageCount} turns`);
    const ts = asTs(row.updatedAt || row.capturedAt);
    if (ts) meta.push(formatDateShort(ts));

    const tags = (row.tags || []).slice(0, 3);
    const labels = (row.labels || []).slice(0, 3);

    // Saved means transcript-backed. URL-only imported/link shells use the
    // Link badge and carry their placeholder/imported state inside details.
    const chips = [];
    if (opensReader && hasTranscript && st.isSaved) chips.push(['Saved', 'wbRowChip--saved']);
    else if (urlOnlyLink || st.isLinked || opensLinkedDetails) chips.push(['Link', 'wbRowChip--linked']);
    if (st.isImported && !urlOnlyLink) chips.push(['Imported', 'wbRowChip--imported']);

    // Anchor href: prefer the reader hash for saved rows so cmd-click "open
    // in new tab" stays inside Studio; for linked-only rows keep the primary
    // click in Studio and expose the native URL through the details panel.
    const anchorHref = opensReader
      ? (sid ? `#/read/${encodeURIComponent(sid)}` : '#/library/explorer')
      : (opensLinkedDetails ? '#/library/explorer' : '#');
    const inertAria = (opensReader || opensLinkedDetails) ? null : 'true';

    const titleRow = el('div', { class: 'wbChatRowTitleRow' }, [
      el('div', { class: 'wbChatRowTitle' }, displayTitle),
      chips.length
        ? el('div', { class: 'wbChatRowChips' }, chips.map(([label, klass]) =>
            el('span', { class: `wbRowChip ${klass}`, 'aria-hidden': 'true' }, label)
          ))
        : null,
    ]);

    const children = [
      el('div', { class: 'wbChatRowMain' }, [
        titleRow,
        el('div', { class: 'wbChatRowMeta' }, meta.join(' · ') || ''),
      ]),
      ((tags.length + labels.length) > 0) ? el('div', { class: 'wbChatRowTags' }, [
        ...tags.map((t) => el('span', { class: 'wbChatRowTag', data: { kind: 'tag' } }, `#${t}`)),
        ...labels.map((l) => el('span', { class: 'wbChatRowTag', data: { kind: 'label' } }, l)),
      ]) : null,
    ];

    // Secondary action: a compact "Open original ChatGPT chat" button shown
    // when the row is a SAVED record that also has a source URL. Linked-only
    // rows expose the same action from their in-page details panel. Imported-
    // only saves with no source URL omit the button entirely.
    if (opensReader && linkedUrl) {
      const openExt = el('button', {
        type: 'button',
        class: 'wbChatRowOpenExternal',
        title: 'Open original ChatGPT chat',
        'aria-label': 'Open original ChatGPT chat',
        data: { url: linkedUrl },
      }, [
        el('span', { class: 'wbChatRowOpenExternalIcon', 'aria-hidden': 'true' }, '↗'),
      ]);
      openExt.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        try { W.open(linkedUrl, '_blank', 'noopener'); } catch {}
      });
      children.push(openExt);
    }

    const anchor = el('a', {
      class: 'wbChatRow',
      href: anchorHref,
      data: {
        chatId:     row.chatId || '',
        snapshotId: sid,
        view:       row.view || '',
        idx:        String(idx),
        linked:     (st.isLinked || opensLinkedDetails) ? '1' : '0',
        saved:      st.isSaved  ? '1' : '0',
        archived:   st.isArchived ? '1' : '0',
        deleted:    st.isDeleted ? '1' : '0',
        placeholder: placeholderKind,
        opens:      opensReader ? 'reader' : (opensLinkedDetails ? 'placeholder-details' : 'none'),
      },
      title: displayTitle,
      'aria-disabled': inertAria,
    }, children);

    anchor.addEventListener('click', (ev) => {
      // Inert rows: nothing to do.
      if (!opensReader && !opensLinkedDetails) { ev.preventDefault(); return; }

      if (opensLinkedDetails) {
        ev.preventDefault();
        state.activeLinkedRow = row;
        render();
        return;
      }

      // Preserve modifier/middle-click semantics when a concrete snapshot id is
      // already present. Rows proven transcript-backed by counts can arrive
      // before chats.last_snapshot_id is denormalized; those resolve the latest
      // snapshot at click time and then use the same reader route.
      if (sid && (ev.button !== 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey)) return;

      // Saved path — identical to the prior implementation. Anchor's default
      // navigation sets location.hash; studio.js's hashchange listener calls
      // renderRoute → renderReader(snapshotId). Microtask poll force-sets
      // the hash if a future click-delegation handler suppresses the default.
      ev.preventDefault();
      Promise.resolve(resolveReaderSnapshotId(row)).then((resolvedSid) => {
        if (!resolvedSid) return;
        const target = `#/read/${encodeURIComponent(resolvedSid)}`;
        const before = W.location.hash;
        W.location.hash = target;
        W.queueMicrotask(() => {
          if (W.location.hash === before && before !== target) {
            W.location.hash = target;
          }
        });
      }).catch((e) => err('ChatRow.resolveReaderSnapshotId', e));
      return;
    });

    return anchor;
  }

  // ── Activity helpers ───────────────────────────────────────────────────────
  function buildActivitySeries(rows, days = 30) {
    const buckets = new Array(days).fill(0);
    const today = new Date(); today.setHours(0, 0, 0, 0);
    for (const r of rows) {
      const ts = asTs(r.updatedAt || r.capturedAt);
      if (!ts) continue;
      const d = new Date(ts); d.setHours(0, 0, 0, 0);
      const offset = Math.floor((today.getTime() - d.getTime()) / 86400000);
      if (offset >= 0 && offset < days) buckets[days - 1 - offset] += 1;
    }
    return buckets;
  }

  // ── Top-N facet utility ────────────────────────────────────────────────────
  function topN(facetMap, n = 6) {
    return Object.entries(facetMap || {})
      .map(([k, v]) => [k, Array.isArray(v) ? v.length : Number(v) || 0])
      .sort((a, b) => b[1] - a[1])
      .slice(0, n);
  }

  // ── ID → display name resolution ───────────────────────────────────────────
  // Facets are keyed by canonical IDs (e.g. f_7050…, cat_research_analysis).
  // To render a human name we look up — in priority order:
  //   1. The pageData catalog (Workspace.getFolders / getLabels / getCategories
  //      results that show() prefetched).
  //   2. The Library Index rows, which carry folderName / categoryName for any
  //      chat that hit that facet.
  //   3. Fall back to the raw ID (better than blank).
  //
  // Tags are stored by name directly (no IDs); projects have only IDs today
  // and no catalog. labelFor() handles both cases gracefully.
  function buildFolderNameMap(idx) {
    const map = new Map();
    for (const f of (pageData.folders || [])) {
      const id = String(f?.id || f?.folderId || '').trim();
      const name = String(f?.name || f?.folderName || f?.label || '').trim();
      if (id && name) map.set(id, name);
    }
    if (idx) {
      for (const r of idx.getAll()) {
        if (r.folderId && r.folderName && !map.has(r.folderId)) {
          map.set(r.folderId, r.folderName);
        }
      }
    }
    return map;
  }
  function buildCategoryNameMap(idx) {
    const map = new Map();
    for (const c of (pageData.categories || [])) {
      const id = String(c?.id || c?.categoryId || '').trim();
      const name = String(c?.name || c?.categoryName || c?.label || '').trim();
      if (id && name) map.set(id, name);
    }
    if (idx) {
      for (const r of idx.getAll()) {
        if (r.categoryId && r.categoryName && !map.has(r.categoryId)) {
          map.set(r.categoryId, r.categoryName);
        }
      }
    }
    return map;
  }
  function buildLabelNameMap() {
    const map = new Map();
    for (const lb of (pageData.labels || [])) {
      const id = String(lb?.id || lb?.labelId || lb?.name || '').trim();
      const name = String(lb?.name || lb?.label || lb?.labelName || id).trim();
      if (id && name) map.set(id, name);
    }
    return map;
  }
  function labelFor(kind, id, idx) {
    const raw = String(id || '');
    if (!raw) return '';
    if (kind === 'folder')   return buildFolderNameMap(idx).get(raw)   || raw;
    if (kind === 'category') return buildCategoryNameMap(idx).get(raw) || raw;
    if (kind === 'label')    return buildLabelNameMap().get(raw)       || raw;
    // tags = name-keyed, projects = id-only (no catalog) — return raw.
    return raw;
  }

  // ── Filter chips row ───────────────────────────────────────────────────────
  // `opts.hideViewChips` is set by the Saved / Pinned / Archive tabs — those
  // tabs already lock the view via the route, so showing duplicate chips would
  // either be confusing or let the user desync the chip from the tab.
  function FilterChips(opts = {}) {
    const onSet = (key, value) => () => {
      prefs[key] = value; savePrefs(prefs);
      step('prefs', `${key}=${value}`);
      render();
    };
    // Linked pill is conditional: only render when there's at least one
    // linked-only record so the filter row stays clean on installs that
    // never used "Add to Library". Counts come from the shared canonical
    // headline projection.
    const linkedCount = (opts && opts.linkedCount) || 0;
    return el('div', { class: 'wbFilterChips' }, [
      opts.hideViewChips ? null : el('div', { class: 'wbFilterChipGroup' }, [
        Pill({ label: 'All',     count: opts.totalCount, active: prefs.view === 'all',     onClick: onSet('view', 'all') }),
        Pill({ label: 'Saved',   active: prefs.view === 'saved',   onClick: onSet('view', 'saved') }),
        Pill({ label: 'Pinned',  active: prefs.view === 'pinned',  onClick: onSet('view', 'pinned') }),
        Pill({ label: 'Archive', active: prefs.view === 'archive', onClick: onSet('view', 'archive') }),
        linkedCount > 0
          ? Pill({ label: 'Link', count: linkedCount, active: prefs.view === 'linked', onClick: onSet('view', 'linked') })
          : null,
      ]),
      opts.hideViewChips ? null : el('span', { class: 'wbFilterChipDivider' }),
      el('div', { class: 'wbFilterChipGroup' }, [
        el('span', { class: 'wbFilterChipLabel' }, 'Group by'),
        Pill({ label: 'Date',     active: prefs.groupBy === 'date',     onClick: onSet('groupBy', 'date') }),
        Pill({ label: 'Folder',   active: prefs.groupBy === 'folder',   onClick: onSet('groupBy', 'folder') }),
        Pill({ label: 'Category', active: prefs.groupBy === 'category', onClick: onSet('groupBy', 'category') }),
        Pill({ label: 'Label',    active: prefs.groupBy === 'label',    onClick: onSet('groupBy', 'label') }),
        Pill({ label: 'Project',  active: prefs.groupBy === 'project',  onClick: onSet('groupBy', 'project') }),
        Pill({ label: 'None',     active: prefs.groupBy === 'none',     onClick: onSet('groupBy', 'none') }),
      ]),
      opts.hideSortChips ? null : el('span', { class: 'wbFilterChipDivider' }),
      opts.hideSortChips ? null : el('div', { class: 'wbFilterChipGroup' }, [
        el('span', { class: 'wbFilterChipLabel' }, 'Sort'),
        Pill({ label: 'Recent',    active: prefs.sort === 'recent',    onClick: onSet('sort', 'recent') }),
        Pill({ label: 'Oldest',    active: prefs.sort === 'oldest',    onClick: onSet('sort', 'oldest') }),
        Pill({ label: 'A → Z',     active: prefs.sort === 'az',        onClick: onSet('sort', 'az') }),
        Pill({ label: 'Most turns', active: prefs.sort === 'mostTurns', onClick: onSet('sort', 'mostTurns') }),
      ]),
    ]);
  }

  function SearchBar() {
    const input = el('input', {
      type: 'search', class: 'wbInsightsSearch', placeholder: 'Search your library…',
      value: prefs.search || '', autocomplete: 'off', spellcheck: 'false',
      on: {
        input: (ev) => {
          prefs.search = String(ev.target.value || '');
          savePrefs(prefs);
          // Debounce a render
          if (state._searchTimer) clearTimeout(state._searchTimer);
          state._searchTimer = setTimeout(() => render(), 140);
        },
      },
    });
    const wrap = el('label', { class: 'wbInsightsSearchWrap' }, [
      el('span', { class: 'wbIco wbIco--search', html: '<svg viewBox="0 0 24 24" focusable="false" aria-hidden="true"><circle cx="11" cy="11" r="5.25" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="m15.1 15.1 3.15 3.15" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>' }),
      input,
      prefs.search ? el('button', {
        type: 'button', class: 'wbInsightsSearchClear', 'aria-label': 'Clear search',
        on: { click: () => { prefs.search = ''; savePrefs(prefs); render(); } },
      }, '×') : null,
    ]);
    return wrap;
  }

  function indexProjectionSources(idx) {
    try { return idx?.diagnose?.()?.projection?.sources || null; }
    catch { return null; }
  }

  function indexSyncStateText(idx) {
    const sources = indexProjectionSources(idx);
    const syncedShellRows = Number(sources?.durableBundleShellRowsProjected || sources?.fallbackRegistryShellRows || 0) || 0;
    if (!sources) return 'Sync metadata is loading; counts may settle after import hydration.';
    return syncedShellRows > 0
      ? `${formatNumber(syncedShellRows)} imported placeholder row(s) loaded from sync.`
      : '';
  }

  // ── Sort + group ───────────────────────────────────────────────────────────
  function sortRows(rows) {
    return canonicalSortRows(rows, prefs.sort || 'recent');
  }

  function groupRows(rows) {
    if (prefs.groupBy === 'none') return [{ key: '', label: '', rows }];
    if (prefs.groupBy === 'folder') {
      const buckets = new Map();
      for (const r of rows) {
        const key = r.folderId || '__unfiled__';
        const label = r.folderName || (r.folderId ? r.folderId : 'Unfiled');
        if (!buckets.has(key)) buckets.set(key, { key, label, rows: [] });
        buckets.get(key).rows.push(r);
      }
      return [...buckets.values()].sort((a, b) => b.rows.length - a.rows.length);
    }
    if (prefs.groupBy === 'category') {
      const buckets = new Map();
      for (const r of rows) {
        const key = r.categoryId || '__uncategorized__';
        const label = r.categoryName || (r.categoryId ? r.categoryId : 'Uncategorized');
        if (!buckets.has(key)) buckets.set(key, { key, label, rows: [] });
        buckets.get(key).rows.push(r);
      }
      return [...buckets.values()].sort((a, b) => b.rows.length - a.rows.length);
    }
    if (prefs.groupBy === 'label') {
      // Labels are multi-valued — a chat with two labels appears in both
      // buckets. Unlabeled chats go to a synthetic bucket so they remain visible.
      const buckets = new Map();
      for (const r of rows) {
        const labels = Array.isArray(r.labels) && r.labels.length ? r.labels : ['__unlabeled__'];
        for (const lab of labels) {
          const key = String(lab);
          const label = key === '__unlabeled__' ? 'Unlabeled' : key;
          if (!buckets.has(key)) buckets.set(key, { key, label, rows: [] });
          buckets.get(key).rows.push(r);
        }
      }
      return [...buckets.values()].sort((a, b) => b.rows.length - a.rows.length);
    }
    if (prefs.groupBy === 'project') {
      const buckets = new Map();
      for (const r of rows) {
        const key = r.projectId || '__unassigned__';
        const label = key === '__unassigned__' ? 'No project' : key;
        if (!buckets.has(key)) buckets.set(key, { key, label, rows: [] });
        buckets.get(key).rows.push(r);
      }
      return [...buckets.values()].sort((a, b) => b.rows.length - a.rows.length);
    }
    // Default: date bucket
    const buckets = new Map();
    for (const r of rows) {
      const rowTime = canonicalRowTime(r);
      const label = dateBucketLabel(rowTime);
      if (!buckets.has(label)) buckets.set(label, { key: label, label, rows: [], _orderTs: rowTime || 0 });
      const b = buckets.get(label);
      b.rows.push(r);
      b._orderTs = Math.max(b._orderTs, rowTime || 0);
    }
    return [...buckets.values()].sort((a, b) => b._orderTs - a._orderTs);
  }

  // Canonical row search predicate. Used by Explorer / Recents / Organize so
  // every search field stays consistent. Matches against:
  //   • title, folderName, folderId, categoryName, categoryId, projectId
  //   • labels[], tags[]
  //   • raw.excerpt / raw.snippet / raw.preview / raw.description / raw.summary
  //     (defensive — different archive ops use different keys; whichever is
  //     present gets searched)
  function rowMatchesSearch(r, needle) {
    if (!needle) return true;
    const q = String(needle || '').trim().toLowerCase();
    if (!q) return true;
    if (String(r.title || '').toLowerCase().includes(q)) return true;
    if (String(r.folderName || '').toLowerCase().includes(q)) return true;
    if (String(r.folderId || '').toLowerCase().includes(q)) return true;
    if (String(r.categoryName || '').toLowerCase().includes(q)) return true;
    if (String(r.categoryId || '').toLowerCase().includes(q)) return true;
    if (String(r.projectId || '').toLowerCase().includes(q)) return true;
    if ((r.tags || []).some((t) => String(t).toLowerCase().includes(q))) return true;
    if ((r.labels || []).some((l) => String(l).toLowerCase().includes(q))) return true;
    const raw = r.raw || {};
    const excerpt = String(raw.excerpt || raw.snippet || raw.preview || raw.description || raw.summary || '').toLowerCase();
    if (excerpt && excerpt.includes(q)) return true;
    return false;
  }

  // `opts.forceView` is set by the Saved / Pinned / Archive page tabs so the
  // route locks the view filter (the user can no longer accidentally diverge
  // chip selection from tab selection).
  function filterRowsForExplorer(rows, opts = {}) {
    const v = String(opts.forceView || prefs.view || 'all').toLowerCase();
    const activeRows = canonicalActiveRows(rows);
    let list;
    if (v === 'saved') list = activeRows.filter((r) => rowHasOpenableTranscriptContent(r) && getRowState(r).isSaved);
    else if (v === 'linked' || v === 'link') list = activeRows.filter((r) => rowIsUrlOnlyLink(r));
    else if (v === 'pinned') list = activeRows.filter((r) => getRowState(r).isPinned);
    else list = canonicalRowsForView(rows, v);

    // Dropdown-driven filters. Empty string in prefs = "All <thing>" (no filter).
    if (prefs.folderFilter)   list = list.filter((r) => String(r.folderId || '') === prefs.folderFilter);
    if (prefs.categoryFilter) list = list.filter((r) => String(r.categoryId || '') === prefs.categoryFilter);
    if (prefs.projectFilter)  list = list.filter((r) => String(r.projectId || '') === prefs.projectFilter);
    if (prefs.labelFilter)    list = list.filter((r) => (r.labels || []).includes(prefs.labelFilter));
    if (prefs.tagFilter)      list = list.filter((r) => (r.tags || []).includes(prefs.tagFilter));

    const q = String(prefs.search || '').trim().toLowerCase();
    if (q) list = list.filter((r) => rowMatchesSearch(r, q));
    return sortRows(list);
  }
  function explorerKnownRows(rows, opts = {}) {
    const v = String(opts.forceView || prefs.view || 'all').toLowerCase();
    return (v === 'archive' || v === 'archived') ? canonicalArchivedRows(rows) : canonicalActiveRows(rows);
  }

  // True when any dropdown filter is currently active. Used to enable the
  // Reset button and to label the chat-list summary.
  function hasActiveFilters() {
    return !!(prefs.folderFilter || prefs.categoryFilter || prefs.labelFilter
           || prefs.tagFilter || prefs.projectFilter);
  }
  function resetExplorerFilters() {
    prefs.folderFilter = '';
    prefs.categoryFilter = '';
    prefs.labelFilter = '';
    prefs.tagFilter = '';
    prefs.projectFilter = '';
    savePrefs(prefs);
  }

  // ── Renderers ──────────────────────────────────────────────────────────────
  function renderDashboard(idx) {
    const rows = idx.getAll();
    const activeRows = canonicalActiveRows(rows);
    const activeFacets = canonicalActiveFacets(rows);
    const headline = canonicalHeadlineCounts(rows);
    const syncStateText = indexSyncStateText(idx);
    const series = buildActivitySeries(activeRows, 30);
    const recent = canonicalSavedRecentRows(rows, 6);

    const total = headline.total;
    const saved = headline.saved;
    const pinned = headline.pinned;
    const archive = headline.archived;
    const linked = headline.link;

    const subParts = [
      `${formatNumber(saved)} saved`,
      `${formatNumber(pinned)} pinned`,
      `${formatNumber(archive)} archived`,
    ];
    if (linked > 0) subParts.push(`${formatNumber(linked)} link`);

    const hero = el('section', { class: 'wbDashHero' }, [
      el('div', { class: 'wbDashHeroLeft' }, [
        el('div', { class: 'wbDashHeroLabel' }, 'Library'),
        el('div', { class: 'wbDashHeroValue' }, formatNumber(total)),
        el('div', { class: 'wbDashHeroSub' }, subParts.join(' · ')),
        syncStateText ? el('div', { class: 'wbDashHeroSyncState', style: 'margin-top:6px;font-size:12px;opacity:.68' }, syncStateText) : null,
      ]),
      el('div', { class: 'wbDashHeroRight' }, [
        el('div', { class: 'wbDashHeroSparklineLabel' }, 'Activity · last 30 days'),
        Sparkline(series, { width: 280, height: 56 }),
      ]),
    ]);

    const distBars = [
      BarRow({ name: 'Saved',    count: saved,    total, swatch: '#7ab6ff' }),
      BarRow({ name: 'Pinned',   count: pinned,   total, swatch: '#f3c969' }),
      BarRow({ name: 'Archive',  count: archive,  total, swatch: '#a78bfa' }),
    ];
    if (linked > 0) {
      // Make the Link bar a clickable link into Explorer with the Link
      // pill pre-selected. Persists prefs.view='linked' first so the
      // Explorer renderer picks it up on the next render() pass.
      const linkedBar = BarRow({ name: 'Link', count: linked, total, swatch: '#7dd3fc' });
      const linkedAnchor = el('a', {
        class: 'wbBarRowLink',
        href: '#/library/explorer',
        'aria-label': `View ${linked} link chats`,
      }, [linkedBar]);
      linkedAnchor.addEventListener('click', (ev) => {
        // Programmatic prefs flip — the hash change handles the route, but
        // the view-pill state needs to land before render() fires.
        try { prefs.view = 'linked'; savePrefs(prefs); } catch {}
      });
      distBars.push(linkedAnchor);
    }

    const dist = el('section', { class: 'wbDashDist' }, [
      el('header', { class: 'wbDashSectionHead' }, [el('h3', {}, 'Distribution')]),
      el('div', { class: 'wbDashDistBars' }, distBars),
    ]);

    const topFolders    = topN(activeFacets.byFolder, 6);
    const topCategories = topN(activeFacets.byCategory, 6);
    const topLabels     = topN(activeFacets.byLabel, 6);

    const facetBlock = (titleStr, entries, kind) => {
      const items = entries.length
        ? entries.map(([id, count]) => el('a', {
            class: 'wbDashFacetItem',
            // The route still carries the canonical ID — only the visible name
            // is humanised via labelFor().
            href: getRouteSvc()?.buildLibraryHash?.(kind, id) || '#/library/explorer',
            title: id,
          }, [
            el('span', { class: 'wbDashFacetName' }, labelFor(kind, id, idx)),
            el('span', { class: 'wbDashFacetCount' }, formatNumber(count)),
          ]))
        : [el('div', { class: 'wbDashFacetEmpty' }, `No ${String(titleStr || '').toLowerCase().replace(/^top\s+/, '')} yet`)];
      return el('section', { class: 'wbDashFacet' }, [
        el('header', { class: 'wbDashSectionHead' }, [
          el('h3', {}, titleStr),
          el('a', { class: 'wbDashSectionMore', href: '#/library/explorer' }, 'See all →'),
        ]),
        el('div', { class: 'wbDashFacetList' }, items),
      ]);
    };

    const facetGrid = el('div', { class: 'wbDashFacetGrid' }, [
      facetBlock('Top folders',    topFolders,    'folder'),
      facetBlock('Top categories', topCategories, 'category'),
      facetBlock('Top labels',     topLabels,     'label'),
    ]);

    const recentBlock = el('section', { class: 'wbDashRecent' }, [
      el('header', { class: 'wbDashSectionHead' }, [
        el('h3', {}, 'Recent chats'),
        el('a', { class: 'wbDashSectionMore', href: '#/library/explorer' }, 'Open Explorer →'),
      ]),
      el('div', { class: 'wbDashRecentList' }, recent.length
        ? recent.map((r, i) => ChatRow(r, i))
        : [el('div', { class: 'wbDashRecentEmpty' }, 'No chats captured yet. Use the archive tools on chatgpt.com to capture a conversation.')]),
    ]);

    const activePlaceholder = state.activeLinkedRow ? renderLinkedDetailsPanel(state.activeLinkedRow) : null;

    return el('div', { class: 'wbDashBody' }, [hero, activePlaceholder, dist, facetGrid, recentBlock]);
  }

  // ── Explorer rich helpers ─────────────────────────────────────────────────
  // These render the native-screenshot-style elements (hero card, stat cards,
  // toolbar, dropdown grid) that distinguish the dedicated Explorer tab from
  // the simpler Saved/Pinned/Archive views.

  function renderExplorerHero(filteredCount, totalCount) {
    return el('section', { class: 'wbExpHero' }, [
      el('div', { class: 'wbExpHeroLabel' }, 'Library Explorer'),
      el('h2', { class: 'wbExpHeroTitle' }, 'Browse and classify known chats'),
      el('div', { class: 'wbExpHeroSub' },
        `Showing ${formatNumber(filteredCount)} filtered chats from ${formatNumber(totalCount)} known chats.`),
    ]);
  }

  function renderExplorerStatCards(idx, filteredCount, totalCount) {
    const groupLabel = (() => {
      switch (prefs.groupBy) {
        case 'folder':   return 'Folder';
        case 'category': return 'Category';
        case 'none':     return 'None';
        default:         return 'Date';
      }
    })();
    const cards = [
      { label: 'Shown',  val: filteredCount, hint: 'after current filters' },
      { label: 'Known',  val: totalCount,    hint: 'stored in Library registry' },
      { label: 'Group',  val: groupLabel,    hint: 'list grouping mode' },
      { label: 'Sort',   val: ({ recent: 'Newest', oldest: 'Oldest', az: 'A → Z', mostTurns: 'Most turns' })[prefs.sort] || 'Newest', hint: 'list ordering' },
    ];
    return el('section', { class: 'wbExpStatRow' }, cards.map((c) => el('div', { class: 'wbExpStatCard' }, [
      el('div', { class: 'wbExpStatLabel' }, c.label),
      el('div', { class: 'wbExpStatValue' }, String(c.val)),
      el('div', { class: 'wbExpStatHint' }, c.hint),
    ])));
  }

  function renderExplorerToolbar(idx) {
    const active = hasActiveFilters();
    const resetBtn = el('button', {
      type: 'button',
      class: `wbExpToolbarBtn${active ? ' is-armed' : ''}`,
      'aria-label': 'Reset all dropdown filters',
    }, 'Reset filters');
    if (!active) resetBtn.disabled = true;
    resetBtn.addEventListener('click', () => { resetExplorerFilters(); render(); });

    const refreshBtn = el('button', {
      type: 'button',
      class: 'wbExpToolbarBtn',
      'aria-label': 'Refresh Library Index from archive',
    }, 'Refresh index');
    refreshBtn.addEventListener('click', async () => {
      refreshBtn.disabled = true;
      refreshBtn.classList.add('is-spinning');
      try {
        await idx.refresh('explorer.toolbar');
        await refreshPageData();
      } catch (e) { err('explorer.refresh', e); }
      finally {
        refreshBtn.classList.remove('is-spinning');
        render();
      }
    });

    const filterCount = [
      prefs.folderFilter, prefs.categoryFilter, prefs.labelFilter,
      prefs.tagFilter, prefs.projectFilter,
    ].filter(Boolean).length;

    return el('div', { class: 'wbExpToolbar' }, [
      el('div', { class: 'wbExpToolbarLeft' }, [
        el('span', { class: `wbExpToolbarChip${filterCount ? ' is-active' : ''}` }, [
          el('span', {}, 'Filters'),
          el('span', { class: 'wbExpToolbarChipCount' }, formatNumber(filterCount)),
        ]),
        el('span', { class: 'wbExpToolbarChip' }, 'Dropdown grid'),
      ]),
      el('div', { class: 'wbExpToolbarRight' }, [resetBtn, refreshBtn]),
    ]);
  }

  function buildOption(value, label, selected) {
    const opt = el('option', { value: String(value) }, String(label));
    if (selected) opt.selected = true;
    return opt;
  }

  function renderExplorerDropdownGrid(idx) {
    const facets = canonicalActiveFacets(idx.getAll());
    const tagFacet     = facets.byTag     || {};
    const projectFacet = facets.byProject || {};

    // Build options: ['', 'All <thing> (N)'] + entries from cached catalog / facet.
    const folderOpts = [
      buildOption('', `All folders (${formatNumber(pageData.folders.length)})`, !prefs.folderFilter),
      ...pageData.folders.map((f) => {
        const v = String(f.id || f.folderId || '');
        const l = String(f.name || f.label || f.folderName || v);
        return v ? buildOption(v, l, v === prefs.folderFilter) : null;
      }).filter(Boolean),
    ];
    const categoryOpts = [
      buildOption('', `All categories (${formatNumber(pageData.categories.length)})`, !prefs.categoryFilter),
      ...pageData.categories.map((c) => {
        const v = String(c.id || c.categoryId || '');
        const l = String(c.name || c.label || c.categoryName || v);
        return v ? buildOption(v, l, v === prefs.categoryFilter) : null;
      }).filter(Boolean),
    ];
    const labelOpts = [
      buildOption('', `All labels (${formatNumber(pageData.labels.length)})`, !prefs.labelFilter),
      ...pageData.labels.map((lb) => {
        const v = String(lb.id || lb.labelId || lb.name || '');
        const l = String(lb.name || lb.label || v);
        return v ? buildOption(v, l, v === prefs.labelFilter) : null;
      }).filter(Boolean),
    ];
    const tagOpts = [
      buildOption('', `All tags (${formatNumber(Object.keys(tagFacet).length)})`, !prefs.tagFilter),
      ...Object.entries(tagFacet)
        .map(([t, ids]) => [t, Array.isArray(ids) ? ids.length : 0])
        .sort((a, b) => b[1] - a[1])
        .slice(0, 64)
        .map(([t, n]) => buildOption(t, `${t} (${formatNumber(n)})`, t === prefs.tagFilter)),
    ];
    const projectOpts = [
      buildOption('', `All projects (${formatNumber(Object.keys(projectFacet).length)})`, !prefs.projectFilter),
      ...Object.entries(projectFacet)
        .map(([p, ids]) => [p, Array.isArray(ids) ? ids.length : 0])
        .sort((a, b) => b[1] - a[1])
        .slice(0, 64)
        .map(([p, n]) => buildOption(p, `${p} (${formatNumber(n)})`, p === prefs.projectFilter)),
    ];
    const sortOpts = [
      buildOption('recent',    'Newest first',         prefs.sort === 'recent'),
      buildOption('oldest',    'Oldest first',         prefs.sort === 'oldest'),
      buildOption('az',        'A → Z by title',       prefs.sort === 'az'),
      buildOption('mostTurns', 'Most turns first',     prefs.sort === 'mostTurns'),
    ];

    const dropdown = (label, prefKey, options) => {
      const select = el('select', { class: 'wbExpDropdown', 'aria-label': label }, options);
      select.addEventListener('change', (ev) => {
        prefs[prefKey] = String(ev.target.value || '');
        savePrefs(prefs);
        render();
      });
      return el('label', { class: 'wbExpDropdownGroup' }, [
        el('span', { class: 'wbExpDropdownLabel' }, label),
        select,
      ]);
    };

    return el('div', { class: 'wbExpDropdownGrid' }, [
      dropdown('Folder',   'folderFilter',   folderOpts),
      dropdown('Category', 'categoryFilter', categoryOpts),
      dropdown('Label',    'labelFilter',    labelOpts),
      dropdown('Tag',      'tagFilter',      tagOpts),
      dropdown('Project',  'projectFilter',  projectOpts),
      dropdown('Sort',     'sort',           sortOpts),
    ]);
  }

  function renderExplorer(idx, opts = {}) {
    const rows = idx.getAll();
    const knownRows = explorerKnownRows(rows, opts);
    const filtered = filterRowsForExplorer(rows, opts);
    const grouped = groupRows(filtered);
    const activeView = String(opts.forceView || prefs.view || 'saved').toLowerCase();
    const syncStateText = indexSyncStateText(idx);
    let activeLinkedRow = null;
    if (state.activeLinkedRow) {
      activeLinkedRow = knownRows.find((row) => sameChatRow(row, state.activeLinkedRow)) || null;
      if (!activeLinkedRow) state.activeLinkedRow = null;
    }
    // "Rich" mode = dedicated Explorer tab. The Saved / Pinned / Archive tabs
    // (forceView set) keep the simpler chip-only layout.
    const rich = !opts.forceView;
    // Link count drives whether the Link pill renders. Saved/Pinned/
    // Archive tabs (forceView set) keep `hideViewChips:true` so they never
    // show a Link pill — the Saved tab must remain saved-transcript-only.
    const headline = canonicalHeadlineCounts(rows);
    const linkedCount = headline.link;

    // The page-level shell renders a unified search input above the tab nav,
    // so we hide the internal Explorer SearchBar to avoid a duplicate field.
    const head = el('section', { class: 'wbExpHead' }, [
      rich ? renderExplorerHero(filtered.length, knownRows.length) : null,
      rich ? renderExplorerStatCards(idx, filtered.length, knownRows.length) : null,
      rich ? renderExplorerToolbar(idx) : null,
      rich ? renderExplorerDropdownGrid(idx) : null,
      opts.hideInternalSearch ? null : SearchBar(),
      FilterChips({ hideViewChips: !!opts.forceView, hideSortChips: rich, linkedCount, totalCount: headline.total }),
      syncStateText ? el('div', { class: 'wbExpSyncState', style: 'font-size:12px;opacity:.68;margin-top:4px' }, syncStateText) : null,
      el('div', { class: 'wbExpSummary' },
        `${formatNumber(filtered.length)} of ${formatNumber(knownRows.length)} chats${
          rich && hasActiveFilters() ? ` · ${[
            prefs.folderFilter, prefs.categoryFilter, prefs.labelFilter,
            prefs.tagFilter, prefs.projectFilter,
          ].filter(Boolean).length} filter(s) active` : ''
        }`),
    ]);

    const body = el('section', { class: 'wbExpBody' });
    if (activeLinkedRow) body.appendChild(renderLinkedDetailsPanel(activeLinkedRow));
    if (grouped.length === 0 || grouped.every((g) => g.rows.length === 0)) {
      body.appendChild(el('div', { class: 'wbExpEmpty' }, [
        el('div', { class: 'wbExpEmptyTitle' }, 'No chats match'),
        el('div', { class: 'wbExpEmptySub' }, prefs.search
          ? `Nothing matches "${prefs.search}" in the ${activeView} view.`
          : `Nothing in the ${activeView} view yet.`),
      ]));
    } else {
      for (const group of grouped) {
        if (group.rows.length === 0) continue;
        body.appendChild(el('div', { class: 'wbExpGroup' }, [
          group.label ? el('header', { class: 'wbExpGroupHead' }, [
            el('span', { class: 'wbExpGroupLabel' }, group.label),
            el('span', { class: 'wbExpGroupCount' }, formatNumber(group.rows.length)),
          ]) : null,
          el('div', { class: 'wbExpGroupRows' }, group.rows.slice(0, 200).map((r, i) => ChatRow(r, i))),
        ]));
      }
    }
    return el('div', { class: 'wbExpBodyWrap' }, [head, body]);
  }

  function renderAnalytics(idx) {
    const allRows = idx.getAll();
    const counts = canonicalHeadlineCounts(allRows);
    const f = canonicalActiveFacets(allRows);
    const total = counts.total;

    // Map raw facet name → kind so the section helper knows whether to humanise
    // the bar labels and which catalog to consult. Caller passes the kind.
    function section(titleStr, facetMap, swatchSeed, kind) {
      const entries = Object.entries(facetMap || {})
        .map(([k, v]) => [k, Array.isArray(v) ? v.length : Number(v) || 0])
        .sort((a, b) => b[1] - a[1])
        .slice(0, 12);
      const palette = ['#7ab6ff','#a78bfa','#f3c969','#6ad28a','#fca5a5','#22d3ee','#fb923c','#f472b6','#94a3b8','#facc15','#34d399','#c084fc'];
      return el('section', { class: 'wbAnaSection' }, [
        el('header', { class: 'wbAnaSectionHead' }, [
          el('h3', {}, titleStr),
          el('span', { class: 'wbAnaSectionMeta' }, `${formatNumber(entries.length)} of ${formatNumber(Object.keys(facetMap || {}).length)}`),
        ]),
        entries.length ? el('div', { class: 'wbAnaBars' }, entries.map(([id, count], i) =>
          BarRow({ name: labelFor(kind, id, idx), count, total, swatch: palette[(swatchSeed + i) % palette.length] })
        )) : el('div', { class: 'wbAnaEmpty' }, `No ${String(titleStr || '').toLowerCase()} yet — capture some chats to populate this chart.`),
      ]);
    }

    const tagEntries = Object.entries(f.byTag || {})
      .map(([k, v]) => [k, Array.isArray(v) ? v.length : 0])
      .sort((a, b) => b[1] - a[1])
      .slice(0, 32);
    const maxTag = tagEntries[0]?.[1] || 1;
    const tagCloud = el('section', { class: 'wbAnaSection wbAnaSection--cloud' }, [
      el('header', { class: 'wbAnaSectionHead' }, [el('h3', {}, 'Top tags')]),
      tagEntries.length
        ? el('div', { class: 'wbAnaCloud' }, tagEntries.map(([name, count]) => {
            const weight = 0.5 + 0.5 * (count / maxTag);
            return el('a', {
              class: 'wbAnaCloudItem',
              href: getRouteSvc()?.buildLibraryHash?.('tag', name) || '#/library/explorer',
              style: `font-size:${(11 + weight * 7).toFixed(2)}px; opacity:${(0.65 + weight * 0.35).toFixed(2)}`,
            }, [`#${name}`, el('span', { class: 'wbAnaCloudCount' }, formatNumber(count))]);
          }))
        : el('div', { class: 'wbAnaEmpty' }, 'No tags yet'),
    ]);

    return el('div', { class: 'wbAnaBody' }, [
      section('Folders',    f.byFolder,    0, 'folder'),
      section('Categories', f.byCategory,  3, 'category'),
      section('Labels',     f.byLabel,     6, 'label'),
      tagCloud,
      section('Projects',   f.byProject,   9, 'project'),
    ]);
  }

  function renderDetail(idx, kind, id) {
    const filterKey = kind === 'tag' ? 'tag' : (kind === 'label' ? 'label' : (kind === 'category' ? 'categoryId' : 'folderId'));
    const decoded = (() => { try { return decodeURIComponent(id); } catch { return id; } })();
    const sourceRows = canonicalActiveRows(idx.getAll());
    let rows = sourceRows;
    if (kind === 'tag') rows = rows.filter((r) => (r.tags || []).includes(decoded));
    else if (kind === 'label') rows = rows.filter((r) => (r.labels || []).includes(decoded));
    else if (kind === 'category') rows = rows.filter((r) => String(r.categoryId || '') === decoded);
    else rows = rows.filter((r) => String(r.folderId || '') === decoded);
    rows = sortRows(rows);

    const backHref = '#/library/explorer';
    const grouped = groupRows(rows);

    // Show the human name in the title; expose the raw id in the tooltip
    // for power users who want to copy/paste it.
    const humanName = labelFor(kind, decoded, idx) || decoded;
    const head = el('section', { class: 'wbDetailHead' }, [
      el('a', { class: 'wbDetailBack', href: backHref }, '← Back to Explorer'),
      el('div', { class: 'wbDetailEyebrow' }, kind),
      el('h2', { class: 'wbDetailTitle', title: decoded }, humanName),
      el('div', { class: 'wbDetailMeta' }, `${formatNumber(rows.length)} ${rows.length === 1 ? 'chat' : 'chats'}`),
    ]);
    const body = el('section', { class: 'wbDetailBody' });
    if (!rows.length) body.appendChild(el('div', { class: 'wbExpEmpty' }, 'No chats here yet.'));
    else for (const group of grouped) {
      body.appendChild(el('div', { class: 'wbExpGroup' }, [
        group.label ? el('header', { class: 'wbExpGroupHead' }, [
          el('span', { class: 'wbExpGroupLabel' }, group.label),
          el('span', { class: 'wbExpGroupCount' }, formatNumber(group.rows.length)),
        ]) : null,
        el('div', { class: 'wbExpGroupRows' }, group.rows.map((r, i) => ChatRow(r, i))),
      ]));
    }
    return el('div', { class: 'wbDetailBodyWrap' }, [head, body]);
  }

  function libraryFolderOverviewRows(idx) {
    const rows = idx?.getAll?.() || [];
    const facets = idx?.facets?.()?.byFolder || {};
    const seen = new Set();
    const items = [];

    for (const folder of (pageData.folders || [])) {
      const id = String(folder?.id || folder?.folderId || '').trim();
      if (!id) continue;
      const name = String(folder?.name || folder?.folderName || folder?.label || id).trim();
      const count = Array.isArray(facets[id]) ? facets[id].length : 0;
      seen.add(id);
      items.push({
        id,
        name: name || id,
        count,
        color: String(folder?.iconColor || folder?.color || '').trim(),
      });
    }

    for (const [id, value] of Object.entries(facets)) {
      if (!id || seen.has(id)) continue;
      items.push({
        id,
        name: labelFor('folder', id, idx),
        count: Array.isArray(value) ? value.length : Number(value) || 0,
        color: '',
      });
    }

    const unfiledCount = rows.filter((row) => !String(row?.folderId || '').trim()).length;
    if (unfiledCount > 0) {
      items.push({
        id: '__unfiled__',
        name: 'Unfiled',
        count: unfiledCount,
        color: '',
        synthetic: true,
      });
    }

    return items.sort((a, b) => {
      if (a.synthetic && !b.synthetic) return 1;
      if (!a.synthetic && b.synthetic) return -1;
      return (b.count - a.count) || String(a.name).localeCompare(String(b.name));
    });
  }

  function renderLibraryFoldersOverview(idx) {
    const folders = libraryFolderOverviewRows(idx);
    const total = folders.reduce((sum, item) => sum + (Number(item.count) || 0), 0);
    const head = el('section', { class: 'wbDetailHead' }, [
      el('div', { class: 'wbDetailEyebrow' }, 'library folders'),
      el('h2', { class: 'wbDetailTitle' }, 'Folders'),
      el('div', { class: 'wbDetailMeta' },
        `${formatNumber(folders.length)} ${folders.length === 1 ? 'folder' : 'folders'} · ${formatNumber(total)} ${total === 1 ? 'chat' : 'chats'}`),
    ]);

    const body = el('section', { class: 'wbDetailBody' });
    if (!folders.length) {
      body.appendChild(el('div', { class: 'wbExpEmpty' }, [
        el('div', { class: 'wbExpEmptyTitle' }, 'No folders yet'),
        el('div', { class: 'wbExpEmptySub' }, 'Folder assignments will appear here after chats are saved into folders.'),
      ]));
    } else {
      body.appendChild(el('div', {
        class: 'wbLibraryFoldersOverviewList',
        role: 'list',
        style: 'border:1px solid var(--wb-border);border-radius:8px;overflow:hidden;background:var(--wb-card)',
      },
        folders.map((folder) => {
          const href = folder.synthetic
            ? '#/library/explorer'
            : (getRouteSvc()?.buildLibraryHash?.('folder', folder.id) || `#/library/folder/${encodeURIComponent(folder.id)}`);
          const color = /^#[0-9a-f]{3,8}$/i.test(String(folder.color || ''))
            ? String(folder.color)
            : 'var(--wb-library-accent)';
          return el('a', {
            class: 'wbLibraryFoldersOverviewRow',
            href,
            role: 'listitem',
            style: 'display:grid;grid-template-columns:36px minmax(0,1fr) auto;gap:14px;align-items:center;padding:14px 16px;border-bottom:1px solid var(--wb-border);color:inherit;text-decoration:none',
          }, [
            el('span', {
              class: `wbLibraryFoldersOverviewIcon${folder.synthetic ? ' is-unfiled' : ''}`,
              style: `display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;border-radius:8px;border:1px solid var(--wb-border);background:var(--wb-surface);color:${color}`,
              'aria-hidden': 'true',
              html: folder.synthetic
                ? '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 8h12l1 12H5L6 8Z"/><path d="M9 8V6a3 3 0 0 1 6 0v2"/><path d="M9 13h6"/></svg>'
                : '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H10l2 2h6.5A2.5 2.5 0 0 1 21 9.5v7A2.5 2.5 0 0 1 18.5 19h-13A2.5 2.5 0 0 1 3 16.5v-9Z"/></svg>',
            }),
            el('span', { class: 'wbLibraryFoldersOverviewName', style: 'font-weight:650;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap' }, folder.name),
            el('span', { class: 'wbLibraryFoldersOverviewCount', style: 'color:var(--wb-muted);font-size:12px;font-variant-numeric:tabular-nums' }, formatNumber(folder.count)),
          ]);
        })
      ));
    }

    return el('div', { class: 'wbDetailBodyWrap wbLibraryFoldersOverview' }, [head, body]);
  }

  function currentLibraryView() {
    const route = getRouteSvc()?.current?.() || null;
    return route?.name === 'library' ? String(route.view || 'dashboard').trim().toLowerCase() : '';
  }

  function invalidateFolderDisplayModel() {
    state.folderDisplay.model = null;
    state.folderDisplay.error = '';
    state.folderDisplay.ts = 0;
  }

  function loadFolderDisplayModel(force = false) {
    const bucket = state.folderDisplay;
    const stale = !bucket.model || (Date.now() - Number(bucket.ts || 0)) > 30_000;
    if (!force && !stale) return;
    if (bucket.loading) return;
    const api = H2O.Library?.FolderParity;
    if (typeof api?.getDisplayModel !== 'function') {
      bucket.error = 'Folder parity model unavailable';
      bucket.model = null;
      bucket.ts = Date.now();
      return;
    }
    const requestId = ++bucket.requestId;
    bucket.loading = true;
    bucket.error = '';
    Promise.resolve(api.getDisplayModel({ fresh: true })).then((model) => {
      if (requestId !== bucket.requestId) return;
      bucket.model = model && typeof model === 'object' ? model : null;
      bucket.error = bucket.model ? '' : 'Folder parity model returned no data';
      bucket.ts = Date.now();
    }).catch((e) => {
      if (requestId !== bucket.requestId) return;
      bucket.model = null;
      bucket.error = String(e?.message || e || 'Folder parity model failed');
      bucket.ts = Date.now();
      err('folderParity.displayModel', e);
    }).finally(() => {
      if (requestId !== bucket.requestId) return;
      bucket.loading = false;
      if (state.visible && ['folders', 'folder-groups', 'organize'].includes(currentLibraryView())) render();
    });
  }

  function canonicalAssignmentFolders() {
    const canonicalRows = Array.isArray(state.folderDisplay.model?.canonicalRows)
      ? state.folderDisplay.model.canonicalRows
      : [];
    const source = canonicalRows.length ? canonicalRows : pageData.folders.filter((folder) => {
      const folderId = String(folder?.id || folder?.folderId || '').trim();
      const badges = Array.isArray(folder?.badges)
        ? folder.badges.map((badge) => String(badge || '').trim().toLowerCase())
        : [];
      if (folder?.isCanonical === true) return true;
      if (folder?.isCanonical === false || folder?.isExtra || folder?.isTestCandidate || folder?.isConflict) return false;
      if (badges.some((badge) => ['extra', 'test', 'conflict', 'desktop-only', 'chrome-only', 'review-required'].includes(badge))) return false;
      return /^f_/.test(folderId);
    });
    return source.map((folder) => ({
      value: String(folder?.id || folder?.folderId || '').trim(),
      label: String(folder?.name || folder?.label || folder?.folderName || folder?.id || folder?.folderId || '').trim(),
    })).filter((item) => item.value && item.label);
  }

  function fallbackFolderDisplayRows(idx) {
    const facets = idx?.facets?.()?.byFolder || {};
    return (Array.isArray(pageData.folders) ? pageData.folders : []).map((folder) => {
      const folderId = String(folder?.id || folder?.folderId || '').trim();
      const name = String(folder?.name || folder?.label || folder?.folderName || folderId).trim();
      const knownCount = Array.isArray(facets[folderId]) ? facets[folderId].length : 0;
      return folderId ? {
        folderId,
        name: name || folderId,
        normalizedName: name.toLowerCase(),
        isCanonical: false,
        isExtra: false,
        isTestCandidate: false,
        isConflict: false,
        canonicalCount: 0,
        knownCount,
        savedCount: 0,
        linkedCount: 0,
        orphanCount: 0,
        localBindingCount: 0,
        badges: ['degraded'],
        displayCountLabel: `${formatNumber(knownCount)} known here`,
        color: String(folder?.color || folder?.iconColor || '').trim(),
        iconColor: String(folder?.iconColor || folder?.color || '').trim(),
      } : null;
    }).filter(Boolean);
  }

  function folderBadgeNodes(row) {
    const values = new Set((Array.isArray(row?.badges) ? row.badges : [])
      .map((badge) => String(badge || '').trim().toLowerCase())
      .filter(Boolean));
    if (row?.isCanonical) values.add('canonical');
    if (row?.isUnfiled || row?.isSystem) values.add('system');
    if (row?.isExtra) values.add('extra');
    if (row?.isTestCandidate) values.add('test');
    if (row?.isConflict) values.add('conflict');
    const reviewBucket = String(row?.reviewBucket || '').trim().toLowerCase();
    if (reviewBucket) values.add(reviewBucket);
    if (!row?.isCanonical && !row?.isUnfiled && !row?.isSystem) values.add('review-required');
    if (Number(row?.localBindingCount || 0) > 0 && values.has('test')) values.add('review-required');
    const ordered = [
      'canonical',
      ...LOCAL_REVIEW_BADGE_ORDER,
      ...Array.from(values).filter((badge) => badge !== 'canonical' && !LOCAL_REVIEW_BADGE_ORDER.includes(badge)),
    ].filter((badge, index, arr) => values.has(badge) && arr.indexOf(badge) === index);
    return ordered.map((badge) => el('span', {
      class: `wbFolderPageBadge wbFolderPageBadge--${badge}`,
      style: 'display:inline-flex;align-items:center;border:1px solid rgba(255,255,255,.12);border-radius:999px;padding:2px 7px;font-size:10.5px;line-height:1.2;color:rgba(255,255,255,.78);background:rgba(255,255,255,.045)',
    }, badge));
  }

  function folderIconNode(row) {
    const color = String(row?.iconColor || row?.color || '').trim();
    const icon = el('span', {
      class: 'wbFolderPageIcon',
      'aria-hidden': 'true',
      style: `display:inline-flex;align-items:center;justify-content:center;width:36px;height:36px;border-radius:8px;border:1px solid rgba(255,255,255,.10);color:${color || 'currentColor'};background:rgba(255,255,255,.035);flex:0 0 auto`,
    });
    icon.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" aria-hidden="true"><path d="M3 6.5A2.5 2.5 0 0 1 5.5 4H10l2 2h6.5A2.5 2.5 0 0 1 21 8.5v9A2.5 2.5 0 0 1 18.5 20h-13A2.5 2.5 0 0 1 3 17.5v-11Z"/></svg>';
    return icon;
  }

  function folderPageMenuItem(row) {
    const folderId = String(row?.folderId || row?.id || '').trim();
    const name = String(row?.name || row?.label || folderId).trim() || folderId;
    return {
      ...row,
      id: folderId,
      folderId,
      name,
      label: name,
      kind: 'folders',
      section: 'folders',
      color: String(row?.iconColor || row?.color || '').trim(),
      iconColor: String(row?.iconColor || row?.color || '').trim(),
      isCanonical: row?.isCanonical === true,
    };
  }

  function renderFolderPageActionButton(row) {
    const folderId = String(row?.folderId || row?.id || '').trim();
    const name = String(row?.name || row?.label || folderId).trim() || folderId;
    const isCanonical = row?.isCanonical === true;
    const isSystem = row?.isUnfiled === true || row?.isSystem === true;
    const canOpenMenu = !!folderId && isCanonical;
    const title = canOpenMenu
      ? `More options for ${name}`
      : (isSystem ? 'System folder row' : (isCanonical ? 'Folder actions are still loading' : 'Local Review rows are protected'));
    const button = el('button', {
      class: 'wbFolderPageActionButton',
      type: 'button',
      title,
      'aria-label': title,
      'aria-haspopup': 'menu',
      'aria-expanded': 'false',
      'aria-disabled': canOpenMenu ? null : 'true',
      disabled: canOpenMenu ? null : 'true',
      data: {
        folderId,
        h2oFolderId: folderId,
        h2oFolderPageActionButton: '1',
        h2oFolderName: name,
        h2oFolderCanonical: isCanonical ? 'true' : 'false',
        h2oFolderColor: String(row?.iconColor || row?.color || '').trim(),
      },
      style: 'display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;min-width:30px;max-width:30px;flex:0 0 auto;border:1px solid rgba(255,255,255,.12);border-radius:8px;background:rgba(255,255,255,.045);color:rgba(255,255,255,.76);font-size:15px;line-height:1;letter-spacing:0;padding:0;cursor:pointer',
    }, '...');
    if (canOpenMenu) {
      button.addEventListener('pointerdown', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
      });
      button.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        const openMenu = H2O.Library?.SidebarSections?.openRowMenu;
        if (typeof openMenu === 'function') openMenu(button, folderPageMenuItem(row));
      });
    } else {
      button.style.cursor = 'not-allowed';
      button.style.opacity = '0.55';
    }
    return button;
  }

  function renderFolderCatalogRow(row) {
    const folderId = String(row?.folderId || row?.id || '').trim();
    const name = String(row?.name || folderId).trim() || folderId;
    const href = getRouteSvc()?.buildLibraryHash?.('folder', folderId) || `#/library/folder/${encodeURIComponent(folderId)}`;
    const label = String(row?.displayCountLabel || '').trim() || `${formatNumber(row?.knownCount || 0)} known here`;
    const secondary = [
      folderId ? `ID ${folderId}` : '',
      Number(row?.orphanCount || 0) > 0 ? `${formatNumber(row.orphanCount)} orphan membership${Number(row.orphanCount) === 1 ? '' : 's'}` : '',
    ].filter(Boolean).join(' · ');
    const link = el('a', {
      class: 'wbFolderPageRowLink',
      href,
      title: `${name} — ${label}`,
      data: {
        folderId,
        h2oFolderId: folderId,
        canonical: row?.isCanonical === true ? 'true' : 'false',
      },
      style: 'display:grid;grid-template-columns:auto minmax(0,1fr) auto;gap:14px;align-items:center;min-width:0;color:inherit;text-decoration:none',
    }, [
      folderIconNode(row),
      el('div', { style: 'min-width:0' }, [
        el('div', { style: 'display:flex;align-items:center;gap:8px;min-width:0;flex-wrap:wrap' }, [
          el('span', { style: 'font-weight:650;font-size:14px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap' }, name),
          ...folderBadgeNodes(row),
        ]),
        el('div', { style: 'margin-top:5px;color:rgba(255,255,255,.55);font-size:11.5px;line-height:1.35;word-break:break-all' }, secondary),
      ]),
      el('div', { style: 'text-align:right;color:rgba(255,255,255,.78);font-size:12px;line-height:1.25;max-width:180px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis' }, label),
    ]);
    return el('div', {
      class: 'wbFolderPageRow',
      title: `${name} — ${label}`,
      data: {
        folderId,
        h2oFolderId: folderId,
        h2oFolderPageRow: '1',
        canonical: row?.isCanonical === true ? 'true' : 'false',
        badges: (Array.isArray(row?.badges) ? row.badges : []).join(','),
      },
      role: 'listitem',
      style: 'display:grid;grid-template-columns:minmax(0,1fr) auto;gap:10px;align-items:center;padding:14px 14px 14px 16px;border-bottom:1px solid rgba(255,255,255,.08);color:inherit',
    }, [
      link,
      renderFolderPageActionButton(row),
    ]);
  }

  function renderFoldersPage(idx) {
    loadFolderDisplayModel(false);
    const bucket = state.folderDisplay;
    const model = bucket.model;
    const canonicalRows = Array.isArray(model?.canonicalRows) ? model.canonicalRows : [];
    const localReviewRows = Array.isArray(model?.localReviewRows) ? model.localReviewRows : [];
    const fallbackRows = fallbackFolderDisplayRows(idx);
    const usingFallbackRows = !canonicalRows.length && fallbackRows.length > 0;
    const displayCanonicalRows = canonicalRows.length
      ? canonicalRows.map((row) => ({ ...row, isCanonical: true }))
      : fallbackRows;
    const displayLocalReviewRows = canonicalRows.length || localReviewRows.length ? localReviewRows : [];
    const unfiledRow = {
      id: '__none__',
      folderId: '__none__',
      name: 'Unfiled',
      label: 'Unfiled',
      isCanonical: false,
      isSystem: true,
      isUnfiled: true,
      badges: ['system'],
      displayCountLabel: 'system',
      knownCount: 0,
      nativeMembershipCount: 0,
      canonicalCount: 0,
      localBindingCount: 0,
    };
    const degraded = !displayCanonicalRows.length && !displayLocalReviewRows.length;
    const canonicalCount = Number(model?.canonicalFolderCount ?? canonicalRows.length) || (usingFallbackRows ? displayCanonicalRows.length : 0);
    const localCount = Number(model?.localFolderCount ?? localReviewRows.length) || displayLocalReviewRows.length;
    const membershipCount = Number(model?.canonicalBindingCount ?? displayCanonicalRows.reduce((sum, row) => sum + (Number(row?.nativeMembershipCount ?? row?.canonicalCount ?? 0) || 0), 0)) || 0;
    const localBindingCount = Number(model?.localBindingCount ?? 0) || 0;
    const summary = [
      `${formatNumber(canonicalCount)} canonical`,
      `${formatNumber(localCount)} local`,
      `${formatNumber(membershipCount)} memberships`,
      `${formatNumber(localBindingCount)} local bindings`,
    ].join(' · ');
    const warnings = Array.isArray(model?.warnings) ? model.warnings : [];
    const head = el('section', { class: 'wbDetailHead' }, [
      el('a', { class: 'wbDetailBack', href: '#/library/explorer' }, '← Back to Explorer'),
      el('div', { class: 'wbDetailEyebrow' }, degraded ? 'folders · degraded' : 'folders'),
      el('h2', { class: 'wbDetailTitle' }, 'Folders'),
      el('div', { class: 'wbDetailMeta' }, summary),
      el('div', { style: 'margin-top:10px;color:rgba(255,255,255,.64);font-size:12px;line-height:1.45' }, [
        'Read-only. No cleanup performed.',
        usingFallbackRows ? el('span', {}, ' Showing workspace folder rows while FolderParity catches up.') : null,
        degraded ? el('span', {}, ` ${bucket.loading ? 'Loading folder parity model.' : (bucket.error || 'Folder parity model unavailable.')}`) : null,
      ]),
    ]);

    const body = el('section', { class: 'wbDetailBody' });
    if (bucket.loading && degraded) {
      body.appendChild(el('div', { class: 'wbExpEmpty' }, [
        el('div', { class: 'wbExpEmptyTitle' }, 'Loading folders'),
        el('div', { class: 'wbExpEmptySub' }, 'Reading the folder parity display model.'),
      ]));
    } else if (degraded) {
      body.appendChild(el('div', { class: 'wbExpEmpty' }, [
        el('div', { class: 'wbExpEmptyTitle' }, 'No folders found'),
        el('div', { class: 'wbExpEmptySub' }, bucket.error || 'Folder parity model unavailable.'),
      ]));
    } else {
      body.appendChild(el('h3', {
        class: 'wbFolderPageSectionTitle',
        style: 'margin:0 0 8px;padding:0;font-size:13px;font-weight:650;color:rgba(255,255,255,.82);text-transform:uppercase;letter-spacing:.04em',
      }, `${usingFallbackRows ? 'Folders' : 'Canonical folders'} · ${formatNumber(displayCanonicalRows.length)}`));
      body.appendChild(el('div', {
        class: 'wbFolderPageList',
        role: 'list',
        style: 'border:1px solid rgba(255,255,255,.10);border-radius:8px;overflow:hidden;background:rgba(255,255,255,.025)',
      }, displayCanonicalRows.concat(unfiledRow).map(renderFolderCatalogRow)));

      if (displayLocalReviewRows.length) {
        body.appendChild(el('h3', {
          class: 'wbFolderPageSectionTitle wbFolderPageSectionTitle--review',
          style: 'margin:24px 0 8px;padding:0;font-size:13px;font-weight:650;color:rgba(255,255,255,.82);text-transform:uppercase;letter-spacing:.04em',
        }, `Local Review · ${formatNumber(displayLocalReviewRows.length)}`));
        body.appendChild(el('div', {
          class: 'wbFolderPageLocalReviewExplanation',
          style: 'margin:0 0 10px;color:rgba(255,255,255,.55);font-size:11.5px;line-height:1.45',
        }, [
          LOCAL_REVIEW_EXPLANATION,
          el('span', { style: 'display:block;margin-top:3px;color:rgba(255,255,255,.48)' }, 'Manage review details in Settings → Folder Parity.'),
        ]));
        body.appendChild(el('div', {
          class: 'wbFolderPageList wbFolderPageList--review',
          role: 'list',
          style: 'border:1px solid rgba(255,255,255,.10);border-radius:8px;overflow:hidden;background:rgba(255,255,255,.015);opacity:0.82',
        }, displayLocalReviewRows.map(renderFolderCatalogRow)));
      }

      if (warnings.length) {
        body.appendChild(el('div', {
          class: 'wbFolderPageWarnings',
          style: 'margin-top:12px;color:rgba(255,255,255,.58);font-size:11.5px;line-height:1.45',
        }, warnings.slice(0, 3).join(' ')));
      }
    }
    return el('div', {
      class: 'wbDetailBodyWrap wbFolderPage',
      data: {
        h2oFolderPage: '1',
        h2oFolderPageOwner: 'library-insights',
      },
    }, [head, body]);
  }

  // ── Mount / dispatch ───────────────────────────────────────────────────────
  // Tab catalog — declared once so the dispatch and the rendered tab nav can't
  // drift apart. Order matches the native ChatGPT Library page layout.
  const LIBRARY_TABS = [
    { key: 'dashboard', label: 'Dashboard' },
    { key: 'analytics', label: 'Analytics' },
    { key: 'explorer',  label: 'Explorer' },
    { key: 'recents',   label: 'Recents' },
    { key: 'saved',     label: 'Saved' },
    /* Phase K-2/F19.6c — URL-only rows still use the #/library/linked route
     * for compatibility, but the visible product label is "Link". */
    { key: 'linked',    label: 'Link' },
    { key: 'organize',  label: 'Organize' },
  ];

  // Page-data cache: folders/labels/categories counts shown in the header stats
  // line. The Library Workspace already caches these for ~30s; we copy the
  // resolved values into a sync-readable slot so the header can render without
  // awaiting on every paint.
  const pageData = {
    folders: [],
    labels: [],
    categories: [],
  };

  // In-flight dedup so multiple subscribers calling refreshPageData concurrently
  // (Workspace subscriber + cross-surface-sync subscriber + show()) coalesce
  // into one Promise → at most one fetch trio per microtask burst.
  let pageDataInFlight = null;
  async function refreshPageData() {
    if (pageDataInFlight) return pageDataInFlight;
    const ws = getWorkspace();
    if (!ws) return;
    pageDataInFlight = (async () => {
      try {
        const [folders, labels, categories] = await Promise.all([
          ws.getFolders().catch(() => []),
          ws.getLabels().catch(() => []),
          ws.getCategories().catch(() => []),
        ]);
        pageData.folders    = Array.isArray(folders)    ? folders    : [];
        pageData.labels     = Array.isArray(labels)     ? labels     : [];
        pageData.categories = Array.isArray(categories) ? categories : [];
        step('pageData.refreshed', `${pageData.folders.length}/${pageData.labels.length}/${pageData.categories.length}`);
      } catch (e) { err('refreshPageData', e); }
    })();
    try { return await pageDataInFlight; }
    finally { pageDataInFlight = null; }
  }

  function isTauriRuntime() {
    try {
      return !!(D.documentElement.dataset.h2oRuntime === 'tauri'
        || H2O.Studio?.platform?.env?.isTauri === true);
    } catch { return false; }
  }

  function getRibbonShell() {
    try { return H2O.Studio?.ribbon || null; }
    catch { return null; }
  }

  function setDesktopLibraryRibbonHidden(hidden) {
    if (!isTauriRuntime()) return false;
    const chrome = D.getElementById('studioDesktopChrome');
    if (!chrome) return false;
    if (hidden) chrome.setAttribute('data-library-ribbon-hidden', 'true');
    else chrome.removeAttribute('data-library-ribbon-hidden');
    return true;
  }

  function setLibraryRibbonContext(collapsed) {
    const ribbon = getRibbonShell();
    if (!ribbon || typeof ribbon.setContext !== 'function') return false;
    H2O.Studio.libraryRibbonOpenSession = true;
    setDesktopLibraryRibbonHidden(false);
    ribbon.setContext({
      route: 'library',
      chatType: 'library',
      snapshotId: null,
      chatId: null,
      title: 'Library',
      originalUrl: null,
      readOnly: true,
    });
    if (typeof ribbon.setCollapsed === 'function') {
      ribbon.setCollapsed(!!collapsed);
    }
    return true;
  }

  function hideLibraryRibbonContext() {
    const ribbon = getRibbonShell();
    if (!ribbon || typeof ribbon.setContext !== 'function') return false;
    H2O.Studio.libraryRibbonOpenSession = false;
    if (setDesktopLibraryRibbonHidden(true)) {
      if (typeof ribbon.setCollapsed === 'function') ribbon.setCollapsed(true);
      return true;
    }
    ribbon.setContext({
      route: 'library',
      chatType: null,
      snapshotId: null,
      chatId: null,
      title: 'Library',
      originalUrl: null,
      readOnly: true,
    });
    if (typeof ribbon.setCollapsed === 'function') {
      ribbon.setCollapsed(true);
    }
    return true;
  }

  function renderLibraryRibbonToggle() {
    const btn = el('button', {
      type: 'button',
      class: 'wbLibraryPageRefreshBtn wbLibraryRibbonToggleBtn',
      'aria-label': 'Toggle Library ribbon',
      title: 'Toggle Library ribbon',
      html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16"/><path d="M4 12h10"/><path d="M4 17h16"/></svg>',
    });
    btn.addEventListener('click', () => {
      const ribbon = getRibbonShell();
      const ctx = ribbon && typeof ribbon.getContext === 'function' ? ribbon.getContext() : null;
      const chrome = D.getElementById('studioDesktopChrome');
      const hiddenReserved = !!(chrome && chrome.getAttribute('data-library-ribbon-hidden') === 'true');
      if (ctx && ctx.chatType === 'library' && !hiddenReserved) {
        hideLibraryRibbonContext();
        return;
      }
      setLibraryRibbonContext(true);
    });
    return btn;
  }

  // ── Page-shell renderers (header / search / secondary nav / tabs) ──────────
  function renderPageHeader(idx) {
    const rows = idx.getAll();
    const headline = canonicalHeadlineCounts(rows);
    const savedCount   = headline.saved;
    const linkedCount  = headline.link;
    const folderCount  = headline.folders;
    const labelCount   = headline.labels;
    const catCount     = headline.categories;
    const projectCount = headline.projects;
    const statsLine = `${formatNumber(savedCount)} saved · ${formatNumber(linkedCount)} link · ${formatNumber(folderCount)} folders · ${formatNumber(labelCount)} labels · ${formatNumber(catCount)} categories · ${formatNumber(projectCount)} projects`;

    const refreshBtn = el('button', {
      type: 'button',
      class: 'wbLibraryPageRefreshBtn',
      'aria-label': 'Refresh Library',
      title: 'Refresh Library',
      html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-3.5-7.1"/><path d="M21 4v5h-5"/></svg>',
    });
    refreshBtn.addEventListener('click', async () => {
      refreshBtn.classList.add('is-spinning');
      try {
        await idx.refresh('page-header.refresh');
        await refreshPageData();
        render();
      } catch (e) { err('header-refresh', e); }
      finally { setTimeout(() => refreshBtn.classList.remove('is-spinning'), 400); }
    });

    const actions = [
      refreshBtn,
      renderLibraryRibbonToggle(),
      el('div', {
        class: 'wbLibraryPageAppearanceSlot',
        'data-role': 'library-ribbon-actions',
        'aria-label': 'Library appearance actions',
      }),
    ];

    return el('header', { class: 'wbLibraryPageHeader' }, [
      el('div', { class: 'wbLibraryPageBrand' }, [
        el('span', { class: 'wbLibraryPageBrandIcon', html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 6h6v14H4z"/><path d="M14 4h6v16h-6z"/><path d="M4 9h6"/><path d="M14 8h6"/></svg>' }),
        el('div', { class: 'wbLibraryPageBrandText' }, [
          el('h1', { class: 'wbLibraryPageTitle' }, 'Library'),
          el('div', { class: 'wbLibraryPageStats' }, statsLine),
        ]),
      ]),
      el('div', { class: 'wbLibraryPageActions' }, actions),
    ]);
  }

  function renderPageSearchRow() {
    const searchInput = el('input', {
      type: 'search',
      class: 'wbLibraryPageSearchInput',
      placeholder: 'Search chats, folders, labels, categories, projects…',
      value: prefs.search || '',
      autocomplete: 'off',
      spellcheck: 'false',
    });
    searchInput.addEventListener('input', (ev) => {
      prefs.search = String(ev.target.value || '');
      savePrefs(prefs);
      if (state._searchTimer) clearTimeout(state._searchTimer);
      state._searchTimer = setTimeout(() => render(), 140);
    });

    const clearBtn = prefs.search ? el('button', {
      type: 'button',
      class: 'wbLibraryPageSearchClear',
      'aria-label': 'Clear search',
    }, '×') : null;
    if (clearBtn) clearBtn.addEventListener('click', () => {
      prefs.search = '';
      savePrefs(prefs);
      render();
    });

    const search = el('label', { class: 'wbLibraryPageSearch' }, [
      el('span', { class: 'wbLibraryPageSearchIcon', html: '<svg viewBox="0 0 24 24" focusable="false" aria-hidden="true"><circle cx="11" cy="11" r="5.25" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="m15.1 15.1 3.15 3.15" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>' }),
      searchInput,
      clearBtn,
    ]);

    // Secondary nav: Folders opens the dedicated folders page; the remaining
    // facets group the Explorer view.
    const onFacet = (groupBy) => () => {
      prefs.groupBy = groupBy;
      savePrefs(prefs);
      W.location.hash = '#/library/explorer';
    };

    const secondaryNav = el('nav', { class: 'wbLibraryPageSecondaryNav', 'aria-label': 'Library sections' }, [
      el('a', {
        class: `wbLibraryPageSecondaryItem${currentLibraryView() === 'folder-groups' ? ' is-active' : ''}`,
        href: '#/library/folder-groups',
        'aria-current': currentLibraryView() === 'folder-groups' ? 'page' : null,
      }, 'Folders'),
      ...[
        ['Labels',     'label'],
        ['Categories', 'category'],
        ['Projects',   'project'],
      ].map(([label, gb]) => {
        const b = el('button', { type: 'button', class: 'wbLibraryPageSecondaryItem' }, label);
        b.addEventListener('click', onFacet(gb));
        return b;
      }),
    ]);

    return el('div', { class: 'wbLibraryPageSearchRow' }, [search, secondaryNav]);
  }

  function renderPageTabs(view) {
    return el('nav', { class: 'wbLibraryPageTabs', 'aria-label': 'Library views' },
      LIBRARY_TABS.map((t) => el('a', {
        class: `wbLibraryPageTab${view === t.key ? ' is-active' : ''}`,
        href: `#/library/${t.key}`,
      }, t.label))
    );
  }

  function renderRecents(idx) {
    // Recents is defined as "newest first" regardless of prefs.sort, so we
    // sort by the canonical saved-recents date and hide the Sort chip group
    // on this tab. View chips are hidden too — Recents shows saved transcripts.
    const all = idx.getAll();
    const sorted = canonicalSavedRecentRows(all, Infinity);
    const q = String(prefs.search || '').trim().toLowerCase();
    const filtered = q ? sorted.filter((r) => rowMatchesSearch(r, q)) : sorted;
    const grouped = groupRows(filtered);
    const activePlaceholder = state.activeLinkedRow
      ? sorted.find((row) => sameChatRow(row, state.activeLinkedRow)) || state.activeLinkedRow
      : null;

    const body = el('section', { class: 'wbExpBody' });
    if (activePlaceholder) body.appendChild(renderLinkedDetailsPanel(activePlaceholder));
    if (filtered.length === 0) {
      body.appendChild(el('div', { class: 'wbExpEmpty' }, [
        el('div', { class: 'wbExpEmptyTitle' }, 'No chats yet'),
        el('div', { class: 'wbExpEmptySub' }, 'Capture a chat from chatgpt.com to start populating your Library.'),
      ]));
    } else {
      for (const group of grouped) {
        if (group.rows.length === 0) continue;
        body.appendChild(el('div', { class: 'wbExpGroup' }, [
          group.label ? el('header', { class: 'wbExpGroupHead' }, [
            el('span', { class: 'wbExpGroupLabel' }, group.label),
            el('span', { class: 'wbExpGroupCount' }, formatNumber(group.rows.length)),
          ]) : null,
          el('div', { class: 'wbExpGroupRows' }, group.rows.slice(0, 200).map((r, i) => ChatRow(r, i))),
        ]));
      }
    }
    return el('div', { class: 'wbExpBodyWrap' }, [
      el('section', { class: 'wbExpHead' }, [
        // Recents is deliberately a "global" view — no view filter applies and
        // the sort is locked to newest-first inside the renderer. Hide both
        // View and Sort chip groups; keep Group-by chips so the user can still
        // slice the recent stream by folder/category/label/project/date.
        FilterChips({ hideViewChips: true, hideSortChips: true }),
        el('div', { class: 'wbExpSummary' }, `${formatNumber(filtered.length)} of ${formatNumber(sorted.length)} chats · active views`),
      ]),
      body,
    ]);
  }

  // ── Organize tab: multi-select + batch mutations ──────────────────────────
  // Selection state survives tab switches inside the Library page so the user
  // can build a selection across Saved/Explorer and finalize on Organize.
  // Pruning happens on data refresh: chats that no longer exist drop out.
  const organize = {
    selected: new Set(),
    pending: { folderId: '', categoryId: '' },
    busy: false,
  };

  function clearOrganizeSelection() {
    organize.selected.clear();
    organize.pending = { folderId: '', categoryId: '' };
  }

  function renderOrganize(idx) {
    loadFolderDisplayModel(false);
    const all = idx.getAll();
    // Prune stale selections against the full data set (not the filtered one)
    // so search/filter changes don't quietly destroy user intent.
    const allChatIds = new Set(all.map((r) => r.chatId));
    for (const id of Array.from(organize.selected)) {
      if (!allChatIds.has(id)) organize.selected.delete(id);
    }

    const sorted = sortRows(canonicalActiveRows(all));
    const q = String(prefs.search || '').trim().toLowerCase();
    const filtered = q ? sorted.filter((r) => rowMatchesSearch(r, q)) : sorted;
    // Cap visible rows for performance; selection state isn't bounded by this.
    const visible = filtered.slice(0, 200);
    const selectedCount = organize.selected.size;

    // ── Bulk action bar ──────────────────────────────────────────────────────
    const folderOpts = [
      { value: '', label: '— Folder: leave unchanged —' },
      { value: '__none__', label: 'Move to Unfiled' },
      ...canonicalAssignmentFolders(),
    ];
    if (organize.pending.folderId && !folderOpts.some((o) => o.value === organize.pending.folderId)) organize.pending.folderId = '';
    const categoryOpts = [
      { value: '', label: '— Category: leave unchanged —' },
      { value: '__none__', label: 'Clear category' },
      ...pageData.categories.map((c) => ({
        value: String(c.id || c.categoryId || ''),
        label: String(c.name || c.label || c.categoryName || c.id || ''),
      })).filter((o) => o.value && o.label),
    ];

    const folderSelect = el('select', { class: 'wbOrganizeSelect', 'aria-label': 'Bulk assign folder' },
      folderOpts.map((o) => el('option', { value: o.value }, o.label)));
    folderSelect.value = organize.pending.folderId;
    folderSelect.addEventListener('change', (ev) => {
      organize.pending.folderId = String(ev.target.value || '');
    });

    const categorySelect = el('select', { class: 'wbOrganizeSelect', 'aria-label': 'Bulk assign category' },
      categoryOpts.map((o) => el('option', { value: o.value }, o.label)));
    categorySelect.value = organize.pending.categoryId;
    categorySelect.addEventListener('change', (ev) => {
      organize.pending.categoryId = String(ev.target.value || '');
    });

    const canApply = !organize.busy
      && selectedCount > 0
      && (organize.pending.folderId || organize.pending.categoryId);
    const applyBtn = el('button', {
      type: 'button',
      class: 'wbOrganizeApply',
    }, organize.busy ? 'Applying…' : 'Apply to selected');
    if (!canApply) applyBtn.disabled = true;
    applyBtn.addEventListener('click', async () => {
      if (organize.busy || selectedCount === 0) return;
      const fId = organize.pending.folderId;
      const cId = organize.pending.categoryId;
      if (!fId && !cId) return;

      const ws = getWorkspace();
      if (!ws) { err('organize.apply', 'no workspace'); return; }

      organize.busy = true;
      render();

      try {
        const chatIds = Array.from(organize.selected);
        // Resolve snapshotId for category mutations from the cached row data.
        const rowByChatId = new Map(all.map((r) => [r.chatId, r]));
        const tasks = [];
        if (fId) {
          const target = fId === '__none__' ? '' : fId;
          for (const id of chatIds) {
            tasks.push(ws.setFolderBinding(id, target).catch((e) => err('apply.folder', e)));
          }
        }
        if (cId) {
          const target = cId === '__none__' ? '' : cId;
          for (const id of chatIds) {
            const row = rowByChatId.get(id);
            if (row?.snapshotId) {
              tasks.push(ws.setSnapshotCategory(row.snapshotId, id, target).catch((e) => err('apply.category', e)));
            }
          }
        }
        await Promise.allSettled(tasks);
        clearOrganizeSelection();
        // refreshPageData() refills folder/label/category catalogs after the
        // mutation; the Index refresh is already chained inside Workspace.
        await refreshPageData();
        step('organize.apply', `n=${chatIds.length}`);
      } catch (e) {
        err('organize.apply', e);
      } finally {
        organize.busy = false;
        render();
      }
    });

    const clearBtn = el('button', { type: 'button', class: 'wbOrganizeClear' }, 'Clear selection');
    if (selectedCount === 0 || organize.busy) clearBtn.disabled = true;
    clearBtn.addEventListener('click', () => { clearOrganizeSelection(); render(); });

    const bulkBar = el('div', {
      class: `wbOrganizeBulk${selectedCount > 0 ? ' is-active' : ''}${organize.busy ? ' is-busy' : ''}`,
    }, [
      el('div', { class: 'wbOrganizeBulkCount' }, [
        el('strong', {}, formatNumber(selectedCount)),
        el('span', {}, selectedCount === 1 ? ' chat selected' : ' chats selected'),
      ]),
      el('div', { class: 'wbOrganizeBulkControls' }, [
        el('label', { class: 'wbOrganizeBulkLabel' }, [el('span', {}, 'Folder'), folderSelect]),
        el('label', { class: 'wbOrganizeBulkLabel' }, [el('span', {}, 'Category'), categorySelect]),
        applyBtn,
        clearBtn,
      ]),
    ]);

    // ── Select-all + summary row ─────────────────────────────────────────────
    const allVisibleSelected = visible.length > 0 && visible.every((r) => organize.selected.has(r.chatId));
    const selectAllInput = el('input', {
      type: 'checkbox',
      class: 'wbOrganizeCheck',
      'aria-label': 'Select all visible chats',
      checked: allVisibleSelected ? 'checked' : null,
    });
    selectAllInput.addEventListener('change', () => {
      if (selectAllInput.checked) for (const r of visible) organize.selected.add(r.chatId);
      else for (const r of visible) organize.selected.delete(r.chatId);
      render();
    });
    const selectAllRow = el('div', { class: 'wbOrganizeSelectAll' }, [
      el('label', { class: 'wbOrganizeCheckLabel' }, [
        selectAllInput,
        el('span', {}, `Select all visible (${formatNumber(visible.length)})`),
      ]),
      el('span', { class: 'wbOrganizeSummary' },
        `${formatNumber(filtered.length)} of ${formatNumber(sorted.length)} chats`),
    ]);

    // ── Selectable rows ──────────────────────────────────────────────────────
    const list = el('div', { class: 'wbOrganizeList' });
    if (visible.length === 0) {
      list.appendChild(el('div', { class: 'wbExpEmpty' }, [
        el('div', { class: 'wbExpEmptyTitle' }, 'Nothing to organize'),
        el('div', { class: 'wbExpEmptySub' }, q
          ? `No chats matching "${prefs.search}"`
          : 'Capture a chat from chatgpt.com to start populating your Library.'),
      ]));
    } else {
      for (const row of visible) {
        const checked = organize.selected.has(row.chatId);
        const cb = el('input', {
          type: 'checkbox',
          class: 'wbOrganizeRowCheck',
          'aria-label': `Select ${row.title || row.chatId}`,
          checked: checked ? 'checked' : null,
        });
        const folderTxt = row.folderName ? `📁 ${row.folderName}` : '— Unfiled —';
        const catTxt = row.categoryName ? `◆ ${row.categoryName}` : '— Uncategorized —';
        const ts = asTs(row.updatedAt || row.capturedAt);
        const dateTxt = ts ? formatDateShort(ts) : '';
        const item = el('label', {
          class: `wbOrganizeRow${checked ? ' is-selected' : ''}`,
        }, [
          cb,
          el('div', { class: 'wbOrganizeRowMain' }, [
            el('div', { class: 'wbOrganizeRowTitle' }, row.title || row.chatId || 'Untitled chat'),
            el('div', { class: 'wbOrganizeRowMeta' },
              [folderTxt, catTxt, dateTxt].filter(Boolean).join(' · ')),
          ]),
        ]);
        cb.addEventListener('change', () => {
          if (cb.checked) organize.selected.add(row.chatId);
          else organize.selected.delete(row.chatId);
          render();
        });
        list.appendChild(item);
      }
    }

    return el('div', { class: 'wbOrganizeBody' }, [bulkBar, selectAllRow, list]);
  }

  function renderLibraryShell(view, idx) {
    const canShowPlaceholder = ['dashboard', 'explorer', 'recents', 'saved', 'pinned', 'archive', 'linked', 'all'].includes(String(view || '').toLowerCase());
    if (!canShowPlaceholder && state.activeLinkedRow) state.activeLinkedRow = null;
    let bodyContent;
    if (view === 'explorer')        bodyContent = renderExplorer(idx, { hideInternalSearch: true });
    else if (view === 'analytics')   bodyContent = renderAnalytics(idx);
    else if (view === 'recents')     bodyContent = renderRecents(idx);
    else if (view === 'organize')    bodyContent = renderOrganize(idx);
    else if (view === 'folder-groups') bodyContent = renderLibraryFoldersOverview(idx);
    else if (view === 'folders')     bodyContent = renderFoldersPage(idx);
    else if (view === 'all' || view === 'saved' || view === 'pinned' || view === 'archive' || view === 'linked') {
      /* Phase K-2 — 'linked' joins the saved/pinned/archive branch so
       * #/library/linked renders the same forceView Explorer view that
       * the existing Linked chip already drives. hideViewChips is set
       * by FilterChips when forceView is truthy, so the chip row hides
       * automatically and the active page tab carries the filter. */
      bodyContent = renderExplorer(idx, { forceView: view, hideInternalSearch: true });
    }
    else if (['folder','category','label','tag'].includes(view) && state.lastRoute?.id) {
      bodyContent = renderDetail(idx, view, state.lastRoute.id);
    }
    else                             bodyContent = renderDashboard(idx);

    return el('div', { class: 'wbLibraryPage' }, [
      renderPageHeader(idx),
      renderPageSearchRow(),
      renderPageTabs(view),
      el('section', { class: 'wbLibraryPageBody' }, bodyContent),
    ]);
  }

  function render() {
    const idx = getIndex();
    if (!idx) { step('render.skip', 'no-index'); return; }
    const pageHost = getPageHost();
    const routeSvc = getRouteSvc();
    if (!pageHost || !routeSvc) { step('render.skip', 'no-services'); return; }
    const region = pageHost.ensureLibraryRegion?.();
    if (!region) { step('render.skip', 'no-region'); return; }

    const route = routeSvc.current?.() || { name: 'library', view: 'dashboard', id: '' };
    state.lastRoute = route;
    const view = route.name === 'library' ? (route.view || 'dashboard') : 'dashboard';
    const token = ++state.renderToken;

    // Capture focus state BEFORE tearing down the DOM so a debounced search-
    // input re-render doesn't yank the caret out of the user's hands. We only
    // care about the page-level Library search box; other inputs aren't
    // affected because they're inside per-tab bodies that the user wouldn't
    // be typing into mid-render-cycle.
    const activeEl = D.activeElement;
    const restoreSearchFocus = !!(activeEl && activeEl.classList && activeEl.classList.contains('wbLibraryPageSearchInput'));
    const savedCaret = restoreSearchFocus
      ? { start: activeEl.selectionStart, end: activeEl.selectionEnd }
      : null;

    const shell = renderLibraryShell(view, idx);

    if (token !== state.renderToken) return;
    region.innerHTML = '';
    region.appendChild(shell);
    state.rootEl = region;

    if (restoreSearchFocus) {
      const newInput = region.querySelector('.wbLibraryPageSearchInput');
      if (newInput) {
        try {
          newInput.focus();
          // setSelectionRange may throw on input types it doesn't apply to.
          const len = String(newInput.value || '').length;
          const s = Math.min(savedCaret?.start ?? len, len);
          const e = Math.min(savedCaret?.end   ?? len, len);
          newInput.setSelectionRange(s, e);
        } catch {}
      }
    }
    step('render.ok', `${view}:${idx.diagnose().rows}`);
  }

  function show() {
    const pageHost = getPageHost();
    if (!pageHost) return;
    pageHost.showLibraryRegion(true);
    state.visible = true;
    render();
    const idx = getIndex();
    if (idx && typeof idx.refresh === 'function' && !state.showRefreshInFlight) {
      state.showRefreshInFlight = Promise.resolve(idx.ready)
        .catch(() => {})
        .then(() => idx.refresh('library-insights.show'))
        .then(() => { if (state.visible) render(); })
        .catch((e) => err('show.refresh-index', e))
        .finally(() => { state.showRefreshInFlight = null; });
    }
    // Refresh folder/label/category counts in the header asynchronously so the
    // stats line populates on first paint. The Workspace facade caches results
    // for ~30s; we re-render when fresh data lands.
    refreshPageData().then(() => { if (state.visible) render(); });
  }
  function hide() {
    const pageHost = getPageHost();
    if (!pageHost) return;
    pageHost.showLibraryRegion(false);
    state.visible = false;
  }

  // ── Public API ─────────────────────────────────────────────────────────────
  const Insights = {
    surface: 'studio',
    show, hide, render,
    prefs: () => ({ ...prefs }),
    setPrefs(patch) { Object.assign(prefs, patch || {}); savePrefs(prefs); render(); },
    diagnose() {
      return {
        surface: 'studio',
        version: '2.0.0',
        visible: state.visible,
        lastRoute: state.lastRoute,
        prefs: { ...prefs },
        hasIndex: !!getIndex(),
        hasPageHost: !!getPageHost(),
        hasUIShell: !!getUIShell(),
        hasRouteSvc: !!getRouteSvc(),
        steps: diag.steps.slice(-20),
        errors: diag.errors.slice(-10),
      };
    },
  };

  H2O.LibraryInsights = Insights;
  H2O.Library.Insights = Insights;

  // ── Subscriptions ──────────────────────────────────────────────────────────
  function bindUpdates() {
    const ws = getWorkspace();
    if (!ws || typeof ws.subscribe !== 'function') return false;
    // The set of Workspace reasons that signal underlying catalog data may
    // have changed (folder/label/category lists, not just bindings). For these
    // we refresh pageData first so Dashboard facet names + Explorer dropdowns
    // pick up fresh names and counts. Route changes etc. just re-render.
    const CATALOG_REASONS = new Set([
      'folder-binding-changed',
      'category-changed',
      'category-reclassified',
      'index-updated',
      'cache-bust',
      'cross-surface-sync',
    ]);
    ws.subscribe((evt) => {
      if (!state.visible) return;
      const reason = String(evt && evt.reason || '');
      if (CATALOG_REASONS.has(reason)) {
        invalidateFolderDisplayModel();
        refreshPageData().then(() => { if (state.visible) render(); });
      } else {
        render();
      }
    });
    const routeSvc = getRouteSvc();
    if (routeSvc?.on) routeSvc.on(() => { if (state.visible) render(); });
    // Cross-surface sync (S0F1h) fires its own custom event; mirror the same
    // refresh-then-render path so the Library page updates when a chatgpt.com
    // tab mutates state.
    W.addEventListener('evt:h2o:library:cross-surface-sync', () => {
      if (!state.visible) return;
      invalidateFolderDisplayModel();
      refreshPageData().then(() => { if (state.visible) render(); });
    });
    return true;
  }

  function registerOnCore() {
    const core = getCore();
    if (!core || typeof core.registerOwner !== 'function') return false;
    try {
      core.registerOwner('library-insights', Insights, { replace: true });
      core.registerService('library-insights', Insights, { replace: true });
      step('register-on-core', 'library-insights');
      return true;
    } catch (e) { err('register-on-core', e); return false; }
  }

  if (!registerOnCore()) {
    W.addEventListener('h2o.ev:prm:cgx:lib:ready:v1', () => { registerOnCore(); bindUpdates(); }, { once: true });
  } else {
    bindUpdates();
  }

  step('boot', 'studio-library-insights-v2-ready');
})();
