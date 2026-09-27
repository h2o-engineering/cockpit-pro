// ==UserScript==
// @h2o-id             s0z1f.library_sidebar_tab.studio
// @name               S0Z1f. 🎬 Library Sidebar Tab - Studio
// @namespace          H2O.Premium.CGX.library_sidebar_tab.studio
// @author             HumamDev
// @version            1.2.1
// @revision           004
// @build              260511-000030
// @description        Studio Library sidebar entry v1.2: a SINGLE "Library" nav item (no sub-navigation, no badges, no inline actions). Clicking opens the full Library page (#/library/dashboard); Dashboard / Explorer / Analytics live as tabs inside the page, not in the sidebar. Matches Studio's wbNavItem style so it sits cleanly next to the existing Saved / Pinned / Archive items.
// @match              https://chatgpt.com/*
// @run-at             document-idle
// @grant              none
// ==/UserScript==

(() => {
  'use strict';

  console.log('H2O DEV LOAD ✅ S0Z1f Library Sidebar Tab v1.2 (Studio)', Date.now());

  const W = window;
  const D = document;
  const H2O = (W.H2O = W.H2O || {});
  H2O.Library = H2O.Library || {};

  // Default landing route for the Library page. Dashboard is the canonical
  // overview view; users can switch to Explorer/Analytics from page-level tabs.
  const LIBRARY_DEFAULT_HASH = '#/library/dashboard';

  // The injected DOM lives inside a section we own. We re-use the previous
  // SECTION_ID so any leftover instance from v1.1 is replaced cleanly.
  const SECTION_ID = 'wbLibrarySection';
  const FOLDER_ICON_SVG = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" aria-hidden="true"><path d="M3 6.5A2.5 2.5 0 0 1 5.5 4H10l2 2h6.5A2.5 2.5 0 0 1 21 8.5v9A2.5 2.5 0 0 1 18.5 20h-13A2.5 2.5 0 0 1 3 17.5v-11Z"/></svg>';
  const UNFILED_ICON_SVG = '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M5.2 10.8h13.6l-1.1 6.1A2.6 2.6 0 0 1 15.1 19H8.9a2.6 2.6 0 0 1-2.6-2.1l-1.1-6.1Z" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linejoin="round"/><path d="M7.4 10.8 8.3 7a2.1 2.1 0 0 1 2-1.6h3.4a2.1 2.1 0 0 1 2 1.6l.9 3.8" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"/><path d="M8.8 14h1.6a1.8 1.8 0 0 0 3.2 0h1.6" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"/><path d="M12 7.2 13.8 9 12 10.8 10.2 9 12 7.2Z" fill="currentColor" stroke="none"/></svg>';

  const diag = { t0: performance.now(), steps: [], errors: [], bufMax: 40, errMax: 15 };
  const step = (s, o = '') => { try { diag.steps.push({ t: Math.round(performance.now() - diag.t0), s: String(s), o: String(o) }); if (diag.steps.length > diag.bufMax) diag.steps.splice(0, diag.steps.length - diag.bufMax); } catch {} };
  const err = (s, e) => { try { diag.errors.push({ t: Math.round(performance.now() - diag.t0), s: String(s), e: String(e?.stack || e) }); if (diag.errors.length > diag.errMax) diag.errors.splice(0, diag.errors.length - diag.errMax); } catch {} };

  function getCore()     { return H2O.LibraryCore || null; }
  function getSidebar()  { return getCore()?.getService?.('native-sidebar') || null; }
  function getRoute()    { return getCore()?.getService?.('route') || null; }
  function getInsights() { return H2O.LibraryInsights || null; }
  function getPageHost() { return getCore()?.getService?.('page-host') || null; }
  function getIndex() { return H2O.LibraryIndex || null; }

  function folderOperatorModeEnabled() {
    try {
      const api = W.H2O?.Library?.Maintenance?.folderOperatorMode;
      return !!(api
        && api.contract === 'h2o.library.folder-operator-mode.v1'
        && api.owner === 'L-COCKPIT-LIBRARY'
        && typeof api.isEnabled === 'function'
        && api.isEnabled() === true);
    } catch {}
    return false;
  }

  function folderLocalReviewAppearanceAllowed() {
    try {
      const appearance = W.H2O?.Studio?.appearance;
      if (appearance && typeof appearance.get === 'function') return appearance.get('showLocalReview') !== false;
    } catch {}
    return true;
  }

  function folderLocalReviewUiEnabled() {
    return folderOperatorModeEnabled() && folderLocalReviewAppearanceAllowed();
  }

  function folderPageDebugDetailsVisible() {
    return folderOperatorModeEnabled();
  }

  function folderPageChatCountLabel(value) {
    const count = Number(value || 0) || 0;
    return `${count} ${count === 1 ? 'chat' : 'chats'}`;
  }

  function folderPageSimpleCountLabel(row) {
    const count = Number(row?.nativeMembershipCount ?? row?.canonicalCount ?? row?.count ?? row?.knownStudioCount ?? row?.knownCount ?? 0) || 0;
    return folderPageChatCountLabel(count);
  }

  let folderPageRecoveryToken = 0;

  function makeEl(tag, attrs = {}, children) {
    const node = D.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') node.className = String(v);
      else if (k === 'html') node.innerHTML = String(v);
      else if (k === 'text') node.textContent = String(v);
      else node.setAttribute(k, String(v));
    }
    if (children != null) for (const c of (Array.isArray(children) ? children : [children])) {
      if (c == null || c === false) continue;
      if (c instanceof Node) node.appendChild(c);
      else node.appendChild(D.createTextNode(String(c)));
    }
    return node;
  }

  // ── Build (idempotent) ────────────────────────────────────────────────────
  function buildSection() {
    // If an older (v1.1) section is in the DOM, scrub it so we don't end up
    // with two Library blocks. The id is the same, so getElementById finds it.
    const existing = D.getElementById(SECTION_ID);
    if (existing) {
      // Replace its contents rather than the section node so any references
      // (e.g. observers) stay valid. We rebuild from scratch each boot.
      try { existing.innerHTML = ''; existing.className = 'wbSidebarSection wbSidebarSection--libraryLink'; }
      catch (e) { err('reset.existing', e); }
    }

    const sidebar = getSidebar();
    if (!sidebar) return null;
    const root = sidebar.getRoot();
    if (!root) return null;

    const sec = existing || makeEl('section', {
      id: SECTION_ID,
      class: 'wbSidebarSection wbSidebarSection--libraryLink',
    });

    // A single nav-style anchor. No subtitle, no badge — kept minimal to match
    // the native ChatGPT sidebar Library entry. The wbSidebarNav wrapper exists
    // only so .wbNavItem inherits the shared grid/gap rules. The leading folder
    // icon comes from the .wbSidebarNav .wbNavItem::before background.
    const nav = makeEl('nav', {
      class: 'wbSidebarNav',
      'aria-label': 'Library',
    });
    const link = makeEl('a', {
      class: 'wbNavItem wbNavItem--library',
      href: LIBRARY_DEFAULT_HASH,
      'data-view': 'library',
      'aria-label': 'Open Library',
      title: 'Open Library',
    }, [
      makeEl('span', { class: 'wbNavGlyph' }, 'Library'),
    ]);
    nav.appendChild(link);
    sec.appendChild(nav);

    // Insertion order: pin Library above the lower sidebar scroll region.
    // Search chats and every section below it live inside .wbSidebarScroll,
    // so inserting before that wrapper keeps the logo/title and Library row
    // fixed while the rest of the sidebar scrolls underneath.
    const scroll = root.querySelector('.wbSidebarScroll');
    if (scroll && scroll.parentElement === root) {
      if (sec.parentElement !== root || sec.nextElementSibling !== scroll) {
        root.insertBefore(sec, scroll);
      }
    } else if (!sec.isConnected) {
      const topNav = root.querySelector('.wbSidebarTopNav');
      if (topNav && topNav.parentElement === root) {
        root.insertBefore(sec, topNav);
      } else {
        const folderSec = sidebar.getFolderSection?.();
        if (folderSec && folderSec.parentElement === root) {
          root.insertBefore(sec, folderSec);
        } else {
          const folderHost = sidebar.getFolderHost?.();
          const ancestor = folderHost?.closest?.('.wbSidebarSection');
          if (ancestor && ancestor.parentElement === root) root.insertBefore(sec, ancestor);
          else root.appendChild(sec);
        }
      }
    }
    step('section.built');
    return sec;
  }

  // ── Active-state mirror (matches existing Saved/Pinned/Archive convention) ──
  // The base Studio sidebar uses the .active class on .wbNavItem; we follow it.
  function updateActiveFromRoute() {
    const route = getRoute()?.current?.();
    const sec = D.getElementById(SECTION_ID);
    if (!sec) return;
    const link = sec.querySelector('.wbNavItem--library');
    if (!link) return;
    link.classList.toggle('active', route?.name === 'library');
  }

  function isFoldersLibraryRoute(route = getRoute()?.current?.()) {
    return route?.name === 'library' && String(route?.view || '').toLowerCase() === 'folders';
  }

  function folderPageHasRows(region) {
    if (!region) return false;
    return !!region.querySelector('[data-h2o-folder-page-row="1"], .wbFolderPageRow[data-folder-id]');
  }

  function normalizeFolderPageRow(row, canonical) {
    const folderId = String(row?.folderId || row?.id || '').trim();
    const name = String(row?.name || row?.label || row?.title || folderId).trim() || folderId;
    return folderId ? {
      ...row,
      id: folderId,
      folderId,
      name,
      color: String(row?.iconColor || row?.color || '').trim(),
      iconColor: String(row?.iconColor || row?.color || '').trim(),
      displayCountLabel: String(row?.displayCountLabel || '').trim(),
      nativeMembershipCount: Number(row?.nativeMembershipCount ?? row?.canonicalCount ?? 0) || 0,
      knownCount: Number(row?.knownStudioCount ?? row?.knownCount ?? 0) || 0,
      isCanonical: canonical === true,
    } : null;
  }

  function countKnownUnfiledRows() {
    try {
      const rows = getIndex()?.getAll?.();
      if (!Array.isArray(rows)) return 0;
      return rows.filter((row) => {
        const folderId = String(row?.folderId || row?.folder || '').trim();
        const folderIds = Array.isArray(row?.folderIds)
          ? row.folderIds.map((id) => String(id || '').trim()).filter(Boolean)
          : [];
        return !folderId && folderIds.length === 0;
      }).length;
    } catch {
      return 0;
    }
  }

  function folderPageCountLabel(row) {
    if (!folderPageDebugDetailsVisible()) return folderPageSimpleCountLabel(row);
    const explicit = String(row?.displayCountLabel || '').trim();
    if (explicit) return explicit;
    if (row?.isUnfiled) return `${Number(row?.knownCount || 0) || 0} known here`;
    const nativeCount = Number(row?.nativeMembershipCount ?? row?.canonicalCount ?? 0) || 0;
    const knownCount = Number(row?.knownStudioCount ?? row?.knownCount ?? 0) || 0;
    return row?.isCanonical ? `${nativeCount} native · ${knownCount} known here` : `${knownCount} known here`;
  }

  function folderPageHref(folderId) {
    const id = String(folderId || '').trim();
    return getRoute()?.buildLibraryHash?.('folder', id) || `#/library/folder/${encodeURIComponent(id)}`;
  }

  function makeFolderPageActionButton(row) {
    const button = makeEl('button', {
      class: 'wbFolderPageActionButton',
      type: 'button',
      title: row.isCanonical ? `More options for ${row.name}` : 'Local Review rows are protected',
      'aria-label': row.isCanonical ? `More options for ${row.name}` : 'Local Review rows are protected',
      'aria-haspopup': row.isCanonical ? 'menu' : null,
      'aria-expanded': 'false',
      'aria-disabled': row.isCanonical ? null : 'true',
      'data-h2o-folder-page-action-button': '1',
      'data-h2o-folder-id': row.folderId,
      'data-folder-id': row.folderId,
      style: [
        'display:inline-flex',
        'align-items:center',
        'justify-content:center',
        'width:30px',
        'height:30px',
        'min-width:30px',
        'max-width:30px',
        'padding:0',
        'border:1px solid rgba(255,255,255,.12)',
        'border-radius:8px',
        'background:rgba(255,255,255,.045)',
        'color:rgba(255,255,255,.78)',
        'font:700 14px/1 ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
        `cursor:${row.isCanonical ? 'pointer' : 'not-allowed'}`,
        row.isCanonical ? '' : 'opacity:.52',
      ].filter(Boolean).join(';'),
    }, '...');
    if (row.isCanonical) {
      button.addEventListener('pointerdown', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
      });
      button.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        const openMenu = H2O.Library?.SidebarSections?.openRowMenu;
        if (typeof openMenu === 'function') {
          openMenu(button, {
            ...row,
            id: row.folderId,
            folderId: row.folderId,
            name: row.name,
            label: row.name,
            kind: 'folders',
            section: 'folders',
            color: row.iconColor || row.color || '',
            iconColor: row.iconColor || row.color || '',
            isCanonical: true,
          });
        }
      });
    } else {
      button.disabled = true;
    }
    return button;
  }

  function makeFallbackFolderPageRow(row) {
    const label = folderPageCountLabel(row);
    const color = String(row.iconColor || row.color || '').trim() || 'currentColor';
    const showDebugDetails = folderPageDebugDetailsVisible();
    const icon = makeEl('span', {
      class: 'wbFolderPageIcon',
      'aria-hidden': 'true',
      style: `display:inline-flex;align-items:center;justify-content:center;width:36px;height:36px;border-radius:8px;border:1px solid rgba(255,255,255,.10);color:${color};background:rgba(255,255,255,.035);flex:0 0 auto`,
      html: row.isUnfiled ? UNFILED_ICON_SVG : FOLDER_ICON_SVG,
    });
    const titleChildren = [
      makeEl('span', { style: 'font-weight:650;font-size:14px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap' }, row.name),
    ];
    if (showDebugDetails) {
      titleChildren.push(makeEl('span', {
        style: 'display:inline-flex;align-items:center;border:1px solid rgba(255,255,255,.12);border-radius:999px;padding:2px 7px;font-size:10.5px;line-height:1.2;color:rgba(255,255,255,.78);background:rgba(255,255,255,.045)',
      }, row.isCanonical ? 'canonical' : (row.isUnfiled ? 'system' : 'review-required')));
    }
    const detailChildren = [
      makeEl('div', { style: 'display:flex;align-items:center;gap:8px;min-width:0;flex-wrap:wrap' }, titleChildren),
    ];
    if (showDebugDetails && row.folderId) {
      detailChildren.push(makeEl('div', { style: 'margin-top:5px;color:rgba(255,255,255,.55);font-size:11.5px;line-height:1.35;word-break:break-all' }, `ID ${row.folderId}`));
    }
    const link = makeEl('a', {
      class: 'wbFolderPageRowLink',
      href: folderPageHref(row.folderId),
      title: `${row.name} — ${label}`,
      'data-folder-id': row.folderId,
      'data-h2o-folder-id': row.folderId,
      style: 'display:grid;grid-template-columns:auto minmax(0,1fr) auto;gap:14px;align-items:center;min-width:0;color:inherit;text-decoration:none',
    }, [
      icon,
      makeEl('div', { style: 'min-width:0' }, detailChildren),
      makeEl('div', { style: 'text-align:right;color:rgba(255,255,255,.78);font-size:12px;line-height:1.25;max-width:180px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis' }, label),
    ]);
    return makeEl('div', {
      class: 'wbFolderPageRow',
      role: 'listitem',
      title: `${row.name} — ${label}`,
      'data-h2o-folder-page-row': '1',
      'data-h2o-folder-id': row.folderId,
      'data-folder-id': row.folderId,
      'data-canonical': row.isCanonical ? 'true' : 'false',
      style: 'display:grid;grid-template-columns:minmax(0,1fr) auto;gap:10px;align-items:center;padding:14px 14px 14px 16px;border-bottom:1px solid rgba(255,255,255,.08);color:inherit',
    }, [
      link,
      row.isUnfiled ? makeEl('span', { 'aria-hidden': 'true', style: 'display:inline-block;width:30px;height:30px' }) : makeFolderPageActionButton(row),
    ]);
  }

  async function renderFoldersPageFallback(region, reason = '') {
    if (!(region instanceof HTMLElement) || !isFoldersLibraryRoute()) return false;
    const parity = H2O.Library?.FolderParity;
    const loading = makeEl('div', {
      class: 'wbLibraryPage',
      'data-h2o-folder-page': '1',
      'data-h2o-folder-page-owner': 'sidebar-tab-fallback',
      'data-h2o-folder-page-status': 'loading',
    }, [
      makeEl('section', { class: 'wbDetailBodyWrap wbFolderPage', 'data-h2o-folder-page': '1' }, [
        makeEl('section', { class: 'wbDetailHead' }, [
          makeEl('div', { class: 'wbDetailEyebrow' }, 'folders'),
          makeEl('h2', { class: 'wbDetailTitle' }, 'Folders'),
          makeEl('div', { class: 'wbDetailMeta' }, 'Loading folder parity model'),
        ]),
        makeEl('section', { class: 'wbDetailBody' }, [
          makeEl('div', { class: 'wbExpEmpty' }, 'Loading folders...'),
        ]),
      ]),
    ]);
    region.innerHTML = '';
    region.appendChild(loading);
    if (typeof parity?.getDisplayModel !== 'function') {
      loading.querySelector('.wbDetailMeta').textContent = 'FolderParity unavailable';
      return false;
    }
    let model = null;
    try {
      model = await parity.getDisplayModel({ fresh: true });
    } catch (e) {
      err('foldersPageFallback.model', e);
    }
    if (!isFoldersLibraryRoute()) return false;
    const canonicalRows = (Array.isArray(model?.canonicalRows) ? model.canonicalRows : [])
      .map((row) => normalizeFolderPageRow(row, true))
      .filter(Boolean);
    const showLocalReview = folderLocalReviewUiEnabled();
    const rawReviewRows = Array.isArray(model?.localReviewRows) ? model.localReviewRows : [];
    const reviewRows = (showLocalReview ? rawReviewRows : [])
      .map((row) => normalizeFolderPageRow(row, false))
      .filter(Boolean);
    const knownUnfiled = countKnownUnfiledRows();
    const allRows = canonicalRows.concat({
      id: '__none__',
      folderId: '__none__',
      name: 'Unfiled',
      displayCountLabel: `${knownUnfiled} known here`,
      knownCount: knownUnfiled,
      isCanonical: false,
      isUnfiled: true,
    });
    const body = makeEl('section', {
      class: 'wbDetailBody',
    }, [
      makeEl('h3', {
        class: 'wbFolderPageSectionTitle',
        style: 'margin:0 0 8px;padding:0;font-size:13px;font-weight:650;color:rgba(255,255,255,.82);text-transform:uppercase;letter-spacing:.04em',
      }, `${showLocalReview ? 'Canonical folders' : 'Folders'} · ${canonicalRows.length}`),
      makeEl('div', {
        class: 'wbFolderPageList',
        role: 'list',
        style: 'border:1px solid rgba(255,255,255,.10);border-radius:8px;overflow:hidden;background:rgba(255,255,255,.025)',
      }, allRows.map(makeFallbackFolderPageRow)),
    ]);
    if (reviewRows.length) {
      body.appendChild(makeEl('h3', {
        class: 'wbFolderPageSectionTitle wbFolderPageSectionTitle--review',
        style: 'margin:24px 0 8px;padding:0;font-size:13px;font-weight:650;color:rgba(255,255,255,.82);text-transform:uppercase;letter-spacing:.04em',
      }, `Local Review · ${reviewRows.length}`));
      body.appendChild(makeEl('div', {
        class: 'wbFolderPageLocalReviewExplanation',
        style: 'margin:0 0 10px;color:rgba(255,255,255,.55);font-size:11.5px;line-height:1.45',
      }, 'Read-only. Local Review rows are protected.'));
      body.appendChild(makeEl('div', {
        class: 'wbFolderPageList wbFolderPageList--review',
        role: 'list',
        style: 'border:1px solid rgba(255,255,255,.10);border-radius:8px;overflow:hidden;background:rgba(255,255,255,.015);opacity:0.82',
      }, reviewRows.map(makeFallbackFolderPageRow)));
    }
    const shell = makeEl('div', {
      class: 'wbLibraryPage',
      'data-h2o-folder-page': '1',
      'data-h2o-folder-page-owner': 'sidebar-tab-fallback',
      'data-h2o-folder-local-review': showLocalReview ? 'operator' : 'hidden',
      'data-h2o-folder-hidden-review-rows': showLocalReview ? '0' : String(rawReviewRows.length),
      'data-h2o-folder-page-reason': reason,
    }, [
      makeEl('header', { class: 'wbLibraryPageHeader' }, [
        makeEl('div', { class: 'wbLibraryPageBrand' }, [
          makeEl('div', { class: 'wbLibraryPageBrandIcon', 'aria-hidden': 'true' }, 'F'),
          makeEl('div', { class: 'wbLibraryPageBrandText' }, [
            makeEl('h1', { class: 'wbLibraryPageTitle' }, 'Folders'),
            makeEl('div', { class: 'wbLibraryPageStats' }, [
              showLocalReview ? `${canonicalRows.length} canonical` : `${canonicalRows.length} folders`,
              showLocalReview ? `${reviewRows.length} review` : '',
              model?.surface || 'studio',
            ].filter(Boolean).join(' · ')),
          ]),
        ]),
      ]),
      makeEl('section', { class: 'wbLibraryPageBody' }, [
        makeEl('div', {
          class: 'wbDetailBodyWrap wbFolderPage',
          'data-h2o-folder-page': '1',
          'data-h2o-folder-page-owner': 'sidebar-tab-fallback',
        }, [
          makeEl('section', { class: 'wbDetailHead' }, [
            makeEl('a', { class: 'wbDetailBack', href: '#/library/explorer' }, '← Back to Explorer'),
            makeEl('div', { class: 'wbDetailEyebrow' }, 'folders'),
            makeEl('h2', { class: 'wbDetailTitle' }, 'Folders'),
            makeEl('div', { class: 'wbDetailMeta' }, 'Read-only. No cleanup performed.'),
          ]),
          body,
        ]),
      ]),
    ]);
    region.innerHTML = '';
    region.appendChild(shell);
    step('folders-page-fallback.rendered', `${canonicalRows.length}/${reviewRows.length}`);
    return true;
  }

  function scheduleFoldersPageBodyCheck(reason = '') {
    const token = ++folderPageRecoveryToken;
    const delays = [80, 260, 720];
    const check = (index) => {
      if (token !== folderPageRecoveryToken || !isFoldersLibraryRoute()) return;
      const region = getPageHost()?.ensureLibraryRegion?.();
      if (folderPageHasRows(region)) return;
      try { getInsights()?.render?.(); } catch (e) { err('foldersPageCheck.render', e); }
      if (index < delays.length - 1) {
        W.setTimeout(() => check(index + 1), delays[index + 1]);
        return;
      }
      if (!folderPageHasRows(region)) {
        renderFoldersPageFallback(region, reason).catch((e) => err('foldersPageFallback', e));
      }
    };
    W.setTimeout(() => check(0), delays[0]);
  }

  // ── Overlay visibility (route → show/hide Library page) ───────────────────
  function applyRouteVisibility() {
    const route = getRoute()?.current?.();
    const isLib = route?.name === 'library';
    const insights = getInsights();
    if (isLib) {
      if (insights?.show) insights.show();
      else getPageHost()?.showLibraryRegion?.(true);
      if (isFoldersLibraryRoute(route)) scheduleFoldersPageBodyCheck('library-route-folders');
    } else {
      if (insights?.hide) insights.hide();
      else getPageHost()?.showLibraryRegion?.(false);
    }
  }

  // ── Boot ──────────────────────────────────────────────────────────────────
  function boot() {
    if (!buildSection()) { W.requestAnimationFrame(boot); return; }
    updateActiveFromRoute();
    applyRouteVisibility();

    const routeSvc = getRoute();
    if (routeSvc?.on) {
      routeSvc.on(() => {
        updateActiveFromRoute();
        applyRouteVisibility();
      });
    }
    step('boot.ok');
  }

  function registerOnCore() {
    const core = getCore();
    if (!core || typeof core.registerOwner !== 'function') return false;
    try {
      core.registerOwner('library-sidebar-tab', { surface: 'studio', version: '1.2.0' }, { replace: true });
      step('register-on-core', 'library-sidebar-tab');
      return true;
    } catch (e) { err('register-on-core', e); return false; }
  }

  if (D.readyState === 'loading') {
    D.addEventListener('DOMContentLoaded', () => { registerOnCore(); boot(); }, { once: true });
  } else {
    registerOnCore();
    boot();
  }

  step('boot', 'studio-library-sidebar-tab-v1.2-ready');

  H2O.Library.SidebarTab = {
    surface: 'studio',
    refresh: () => H2O.LibraryIndex?.refresh?.('sidebar-tab.api'),
    defaultHash: LIBRARY_DEFAULT_HASH,
    diagnose() {
      return {
        surface: 'studio',
        version: '1.2.0',
        sectionExists: !!D.getElementById(SECTION_ID),
        defaultHash: LIBRARY_DEFAULT_HASH,
        steps: diag.steps.slice(-10),
        errors: diag.errors.slice(-8),
      };
    },
  };
})();
