// ==UserScript==
// @h2o-id             s0f0a.library_surface_host.studio
// @name               S0F0a. 🎬 Library Surface Host - Studio
// @namespace          H2O.Premium.CGX.library_surface_host.studio
// @author             HumamDev
// @version            1.1.0
// @revision           001
// @build              260915-010001
// @description        Studio surface declaration for the Library subsystem. Registers Studio implementations of ui-shell, page-host, native-sidebar, route, chat-list, and the STAB-P0 T02B Shell-owned Folder/sidebar contribution seam on Library Core BEFORE feature owners boot. This is the single seam where Studio differs from native.
// @match              https://chatgpt.com/*
// @run-at             document-idle
// @grant              none
// ==/UserScript==

(() => {
  'use strict';

  console.log('H2O DEV LOAD ✅ S0F0a Library Surface Host', Date.now());

  const W = window;
  const D = document;

  const H2O = (W.H2O = W.H2O || {});
  H2O.Library = H2O.Library || {};
  H2O.Studio = H2O.Studio || {};

  const HOST_KEY = 'LibrarySurfaceHost';
  const host = (H2O.Library[HOST_KEY] = H2O.Library[HOST_KEY] || {});

  // ── Diagnostics ────────────────────────────────────────────────────────────
  const diag = (host.diag = host.diag || {
    t0: performance.now(),
    steps: [],
    errors: [],
    bufMax: 120,
    errMax: 30,
  });
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

  host.meta = host.meta || {
    owner: 's0f0a.library_surface_host.studio',
    label: 'Library Surface Host (Studio)',
    surface: 'studio',
    suite: 'prm',
    host: 'cgx',
  };

  // ── Studio surface detection ───────────────────────────────────────────────
  // We boot inside studio.html, which sets data-h2o-studio-mode="1" on <body>.
  // We never want to register Studio services into a native page accidentally.
  function isStudioDocument() {
    try {
      if (W.H2O_STUDIO_MODE === true) return true;
      if (D.documentElement?.getAttribute?.('data-h2o-studio-mode') === '1') return true;
      if (D.body?.getAttribute?.('data-h2o-studio-mode') === '1') return true;
    } catch {}
    return false;
  }

  if (!isStudioDocument()) {
    step('boot-skip', 'not-studio-document');
    return;
  }

  // ── Studio DOM helpers (cached selectors) ──────────────────────────────────
  const SEL = {
    sidebar:        '#studioSidebar',
    sidebarRail:    '.wbRail',
    folderHost:     '#folderList',
    categoryHost:   '#categoryList',
    chatListHost:   '#sidebarChatList',
    chatListLabel:  '#sidebarChatsLabel',
    chatListMeta:   '#sidebarChatsMeta',
    folderSection: '.wbSidebarSection--folders',
    categorySection: '.wbSidebarSection--categories',
    stage:          '.wbStage',
    main:           '.wbMain',
    listPanel:      '#viewListPanel',
    reader:         '#viewReader',
    routeEyebrow:   '#routeEyebrow',
    routeTitle:     '#routeTitle',
    routeSummary:   '#routeSummary',
    folderAssignWrap:   '#folderAssignWrap',
    folderAssignSelect: '#folderAssignSelect',
    categoryAssignWrap: '#categoryAssignWrap',
    refreshBtn:     '#refreshBtn',
    openReaderBtn:  '#openReaderTabBtn',
    closeBtn:       '#closeBtn',
  };

  const $ = (sel, root = D) => { try { return root.querySelector(sel); } catch { return null; } };

  // ── Service: ui-shell ──────────────────────────────────────────────────────
  // Creates DOM panels/shells that match Studio's existing wb* class system.
  // Library Workspace + Insights + feature owners use these to render content.
  const uiShellService = {
    makePanel({ title, subtitle, body, footer } = {}) {
      const panel = D.createElement('section');
      panel.className = 'wbPanel wbPanel--library';
      if (title || subtitle) {
        const head = D.createElement('header');
        head.className = 'wbPanelHead';
        const titles = D.createElement('div');
        titles.className = 'wbPanelTitles';
        if (title) {
          const t = D.createElement('div');
          t.className = 'wbPanelTitle';
          t.textContent = String(title);
          titles.appendChild(t);
        }
        if (subtitle) {
          const s = D.createElement('div');
          s.className = 'wbPanelSubtitle';
          s.textContent = String(subtitle);
          titles.appendChild(s);
        }
        head.appendChild(titles);
        panel.appendChild(head);
      }
      if (body instanceof HTMLElement) panel.appendChild(body);
      if (footer instanceof HTMLElement) {
        const f = D.createElement('footer');
        f.className = 'wbPanelFoot';
        f.appendChild(footer);
        panel.appendChild(f);
      }
      return panel;
    },

    makePageShell(title, contentEl) {
      const wrap = D.createElement('div');
      wrap.className = 'wbLibraryPage';
      if (title) {
        const h = D.createElement('header');
        h.className = 'wbLibraryPageHead';
        const t = D.createElement('div');
        t.className = 'wbLibraryPageTitle';
        t.textContent = String(title);
        h.appendChild(t);
        wrap.appendChild(h);
      }
      if (contentEl instanceof HTMLElement) wrap.appendChild(contentEl);
      return wrap;
    },

    setRouteMeta(eyebrow, title, summary) {
      const e = $(SEL.routeEyebrow);
      const t = $(SEL.routeTitle);
      const s = $(SEL.routeSummary);
      if (e) e.textContent = String(eyebrow || '');
      if (t) t.textContent = String(title || '');
      if (s) s.textContent = String(summary || '');
    },

    surface() { return 'studio'; },
  };

  // ── Service: page-host ─────────────────────────────────────────────────────
  // Studio's page area is .wbStage; the list/reader are pre-existing children.
  // Library Workspace mounts its content into a dedicated Library page region
  // (created on demand) that does NOT collide with studio.js's list/reader.
  const pageHostService = {
    getRoot() { return $(SEL.stage); },
    getMain() { return $(SEL.main); },
    getListPanel() { return $(SEL.listPanel); },
    getReader() { return $(SEL.reader); },

    // Ensures a Library overlay region exists inside .wbMain. We render into
    // this region instead of replacing the list/reader so studio.js semantics
    // remain unchanged. Visibility is toggled by Library Workspace.
    ensureLibraryRegion() {
      let region = D.querySelector('#wbLibraryRegion');
      if (region instanceof HTMLElement) return region;
      const main = $(SEL.main);
      if (!main) return null;
      region = D.createElement('section');
      region.id = 'wbLibraryRegion';
      region.className = 'wbPanel wbPanel--libraryRegion';
      region.hidden = true;
      main.appendChild(region);
      return region;
    },

    showLibraryRegion(show) {
      const region = pageHostService.ensureLibraryRegion();
      if (!region) return;
      region.hidden = !show;
      try {
        const listPanel = $(SEL.listPanel);
        const reader = $(SEL.reader);
        if (show) {
          if (listPanel) listPanel.dataset.libraryOverlay = '1';
          if (reader) reader.dataset.libraryOverlay = '1';
        } else {
          if (listPanel) delete listPanel.dataset.libraryOverlay;
          if (reader) delete reader.dataset.libraryOverlay;
        }
      } catch {}
    },

    surface() { return 'studio'; },
  };

  // ── Service: native-sidebar ────────────────────────────────────────────────
  // In Studio, the "native sidebar" service points to Studio's own sidebar.
  // Folders/Categories/Chat list rendering hosts are pre-defined in studio.html.
  const nativeSidebarService = {
    getRoot() { return $(SEL.sidebar); },
    getRail() { return $(SEL.sidebarRail); },
    getFolderHost() { return $(SEL.folderHost); },
    getCategoryHost() { return $(SEL.categoryHost); },
    getCategorySection() { return $(SEL.categorySection); },
    getFolderSection() { return $(SEL.folderSection); },
    getChatListHost() { return $(SEL.chatListHost); },
    getChatListLabel() { return $(SEL.chatListLabel); },
    getChatListMeta() { return $(SEL.chatListMeta); },

    // Show/hide sidebar sections that are conditionally rendered.
    setCategoriesVisible(visible) {
      const sec = nativeSidebarService.getCategorySection();
      if (sec) sec.hidden = !visible;
    },

    observe(fn) {
      const root = nativeSidebarService.getRoot();
      if (!root || typeof fn !== 'function') return () => {};
      const mo = new MutationObserver((muts) => { try { fn(muts); } catch (e) { err('sidebar.observe', e); } });
      mo.observe(root, { childList: true, subtree: true, attributes: false });
      return () => { try { mo.disconnect(); } catch {} };
    },

    surface() { return 'studio'; },
  };

  // ── Service: Folder/sidebar contribution seam (STAB-P0 T02B) ─────────────
  // Shell owns the structural slot and the one durable destructive host lifecycle.
  // Library contributes Folder row/action intent through this bounded single slot.
  // This service never writes #folderList and never becomes Folder business authority.
  const FOLDER_SIDEBAR_CONTRIBUTION_CONTRACT = 'h2o.studio.folder-sidebar-contribution.v1';
  const LIBRARY_FOLDER_COMMAND_CONTRACT = 'h2o.library.folder-commands.v1';
  const SHELL_OWNER = 'L-STUDIO-APPLICATION-SHELL';
  const LIBRARY_FOLDER_OWNER = 'L-COCKPIT-LIBRARY';
  const SHELL_DESTRUCTIVE_HOST_SYMBOL = 'studio.js::renderFolderSidebar';
  let currentFolderContribution = null;

  function getLibraryFolderCommandAuthority() {
    try {
      const commands = H2O.Library?.FolderCommands || null;
      if (!commands || commands.contract !== LIBRARY_FOLDER_COMMAND_CONTRACT) return null;
      if (commands.owner !== LIBRARY_FOLDER_OWNER) return null;
      if (typeof commands.execute !== 'function') return null;
      return commands;
    } catch {
      return null;
    }
  }

  function normalizeFolderContribution(input = {}) {
    const source = input && typeof input === 'object' ? input : {};
    const rows = Array.isArray(source.rows) ? source.rows.slice() : [];
    const actions = Array.isArray(source.actions)
      ? source.actions.map((entry) => {
          const action = entry && typeof entry === 'object' ? entry : {};
          return Object.freeze({
            command: String(action.command || '').trim(),
            input: action.input && typeof action.input === 'object' ? { ...action.input } : {},
          });
        }).filter((action) => action.command)
      : [];

    return Object.freeze({
      contract: FOLDER_SIDEBAR_CONTRIBUTION_CONTRACT,
      sourceOwner: LIBRARY_FOLDER_OWNER,
      rows: Object.freeze(rows),
      actions: Object.freeze(actions),
    });
  }

  const folderSidebarContributionService = Object.freeze({
    contract: FOLDER_SIDEBAR_CONTRIBUTION_CONTRACT,
    version: '1.0.0',
    owner: SHELL_OWNER,
    contributor: LIBRARY_FOLDER_OWNER,
    libraryCommandContract: LIBRARY_FOLDER_COMMAND_CONTRACT,
    slot: Object.freeze({
      selector: SEL.folderHost,
      structuralOwner: SHELL_OWNER,
      destructiveHostLifecycleOwner: SHELL_OWNER,
      destructiveHostLifecycleSymbol: SHELL_DESTRUCTIVE_HOST_SYMBOL,
    }),
    invariants: Object.freeze([
      'ONE_SHELL_DESTRUCTIVE_FOLDER_HOST_LIFECYCLE',
      'LIBRARY_ROWS_ARE_CONTRIBUTIONS_NOT_HOST_WRITERS',
      'LIBRARY_ACTIONS_USE_LIBRARY_FOLDER_COMMAND_AUTHORITY',
      'NO_FOLDER_BUSINESS_AUTHORITY_IN_SHELL',
      'T03_SECONDARY_WRITER_RETIREMENT_NOT_EXECUTED',
      'NO_GENERIC_PLUGIN_FRAMEWORK',
    ]),

    setContribution(input = {}) {
      const commands = getLibraryFolderCommandAuthority();
      if (!commands) {
        return {
          ok: false,
          status: 'library-folder-command-contract-unavailable',
          requiredContract: LIBRARY_FOLDER_COMMAND_CONTRACT,
          requiredOwner: LIBRARY_FOLDER_OWNER,
        };
      }
      currentFolderContribution = normalizeFolderContribution(input);
      step('folder-sidebar-contribution.set', `${currentFolderContribution.rows.length}:${currentFolderContribution.actions.length}`);
      return {
        ok: true,
        status: 'accepted',
        contract: FOLDER_SIDEBAR_CONTRIBUTION_CONTRACT,
        contribution: currentFolderContribution,
      };
    },

    getContribution() {
      return currentFolderContribution;
    },

    getCommandAuthority() {
      return getLibraryFolderCommandAuthority();
    },

    getSlot() {
      return {
        selector: SEL.folderHost,
        structuralOwner: SHELL_OWNER,
        destructiveHostLifecycleOwner: SHELL_OWNER,
        destructiveHostLifecycleSymbol: SHELL_DESTRUCTIVE_HOST_SYMBOL,
      };
    },

    diagnose() {
      return {
        contract: FOLDER_SIDEBAR_CONTRIBUTION_CONTRACT,
        owner: SHELL_OWNER,
        contributor: LIBRARY_FOLDER_OWNER,
        libraryCommandContract: LIBRARY_FOLDER_COMMAND_CONTRACT,
        commandAuthorityReady: !!getLibraryFolderCommandAuthority(),
        hostPresent: !!nativeSidebarService.getFolderHost(),
        hasContribution: !!currentFolderContribution,
        destructiveWritesPerformedByService: false,
        destructiveHostLifecycleOwner: SHELL_OWNER,
        destructiveHostLifecycleSymbol: SHELL_DESTRUCTIVE_HOST_SYMBOL,
      };
    },

    surface() { return 'studio'; },
  });

  H2O.Studio.FolderSidebarContribution = folderSidebarContributionService;

  // ── Service: route (Studio hash router) ────────────────────────────────────
  // studio.js owns the canonical route parsing; we mirror its parser so Library
  // modules can read the route without depending on studio.js being booted yet.
  // Studio routes: #/saved, #/pinned, #/archive[?folder=...&chat=...&snapshot=...],
  // #/read/<snapshotId>. Library will add: #/library/<view>, #/library/folder/<id>, etc.
  const routeService = {
    parse(hashStr) {
      const raw = String(hashStr ?? W.location.hash ?? '');
      const trimmed = raw.startsWith('#') ? raw.slice(1) : raw;
      if (!trimmed && W.history?.state?.h2oStudioReader) {
        return { name: 'read', snapshotId: '' };
      }
      const [pathRaw = '/saved', searchRaw = ''] = (trimmed || '/saved').split('?');
      const parts = pathRaw.split('/').filter(Boolean);
      const search = new URLSearchParams(searchRaw);

      // /read/<snapshotId>
      if (parts[0] === 'read') {
        let id = '';
        try { id = decodeURIComponent(parts[1] || ''); } catch { id = parts[1] || ''; }
        return { name: 'read', snapshotId: id };
      }

      // /library/<view>[/<id>]  — Library deep-links (NEW)
      if (parts[0] === 'library') {
        let view = '';
        let id = '';
        try { view = decodeURIComponent(parts[1] || 'dashboard'); } catch { view = parts[1] || 'dashboard'; }
        try { id = decodeURIComponent(parts.slice(2).join('/')); } catch { id = parts.slice(2).join('/'); }
        return { name: 'library', view, id, folderId: '', chatId: '', snapshotId: '' };
      }

      // Default: /saved | /pinned | /archive (existing studio.js routes)
      const view = ['saved', 'pinned', 'archive'].includes(parts[0]) ? parts[0] : 'saved';
      return {
        name: 'list',
        view,
        folderId: String(search.get('folder') || '').trim(),
        chatId: String(search.get('chat') || '').trim(),
        snapshotId: String(search.get('snapshot') || '').trim(),
      };
    },

    current() { return routeService.parse(W.location.hash); },

    isLibraryRoute(route) { return route?.name === 'library'; },

    buildLibraryHash(view, id) {
      const v = String(view || '').trim() || 'dashboard';
      const i = String(id || '').trim();
      return i ? `#/library/${encodeURIComponent(v)}/${encodeURIComponent(i)}` : `#/library/${encodeURIComponent(v)}`;
    },

    push(hash) {
      if (!hash) return;
      try { W.location.hash = String(hash).startsWith('#') ? String(hash) : `#${hash}`; }
      catch (e) { err('route.push', e); }
    },

    on(fn) {
      if (typeof fn !== 'function') return () => {};
      const handler = () => { try { fn(routeService.current()); } catch (e) { err('route.on', e); } };
      W.addEventListener('hashchange', handler);
      W.addEventListener('evt:h2o:route:changed', handler);
      return () => {
        try { W.removeEventListener('hashchange', handler); } catch {}
        try { W.removeEventListener('evt:h2o:route:changed', handler); } catch {}
      };
    },

    surface() { return 'studio'; },
  };

  // ── Service: chat-list (Studio data source) ────────────────────────────────
  // Studio reads chats from the archive bridge, NEVER from sidebar DOM.
  // Routes through H2O.Studio.platform.messaging.send — the required boundary
  // for the future Tauri port. The envelope ({ type: MSG_ARCHIVE, req: { op,
  // payload, nsDisk } }) is preserved exactly so the service-worker receiver
  // (bg.js) continues to dispatch by type unchanged. The 'archive' target is
  // informational today (MV3 routes by envelope.type) and becomes the Tauri
  // command name at port time. Falls back to direct chrome.runtime.sendMessage
  // if the platform adapter is unavailable. See
  // surfaces/studio/STUDIO_PLATFORM_ADAPTER_GUIDE.md.
  const MSG_ARCHIVE = 'h2o-ext-archive:v1';

  function getPlatformMessaging() {
    const p = W.H2O && W.H2O.Studio && W.H2O.Studio.platform && W.H2O.Studio.platform.messaging;
    if (!p || typeof p.send !== 'function') return null;
    const env = W.H2O && W.H2O.Studio && W.H2O.Studio.platform && W.H2O.Studio.platform.env;
    if (env && env.adapter === 'fallback') return null;
    return p;
  }

  async function callArchive(op, payload = {}, nsDisk) {
    const message = { type: MSG_ARCHIVE, req: { op, payload, nsDisk } };
    try {
      const pm = getPlatformMessaging();
      const res = pm
        ? await pm.send('archive', message)
        : await chrome.runtime.sendMessage(message);
      if (!res?.ok) throw new Error(res?.error || `Archive op failed: ${op}`);
      return res.result;
    } catch (e) {
      err(`archive.${op}`, e);
      throw e;
    }
  }

  async function tryArchive(ops, payload = {}, nsDisk) {
    const list = Array.isArray(ops) ? ops : [ops];
    let lastErr = null;
    for (const op of list) {
      try { return await callArchive(op, payload, nsDisk); }
      catch (e) { lastErr = e; }
    }
    throw lastErr || new Error('All archive ops failed');
  }

  const chatListService = {
    async listAll() {
      return tryArchive(['listWorkbenchRows'], {});
    },
    async listByView(view) {
      const rows = await chatListService.listAll();
      const want = String(view || 'saved').toLowerCase();
      if (!Array.isArray(rows)) return [];
      return rows.filter((row) => String(row?.view || row?.state || 'saved').toLowerCase() === want);
    },
    async listAllChatIds() {
      try { return await tryArchive(['listAllChatIds', 'listChatIds'], {}); }
      catch { return []; }
    },
    async getFoldersList() {
      try { return await tryArchive(['getFoldersList'], {}); }
      catch { return []; }
    },
    async getCategoriesCatalog() {
      try { return await tryArchive(['getCategoriesCatalog'], {}); }
      catch { return []; }
    },
    async renameCategory(categoryId, nextName) {
      return tryArchive(['renameCategory'], {
        categoryId: String(categoryId || ''),
        name: String(nextName || ''),
      });
    },
    async deleteCategory(categoryId) {
      return tryArchive(['deleteCategory'], {
        categoryId: String(categoryId || ''),
      });
    },
    async getLabelsCatalog() {
      try { return await tryArchive(['getLabelsCatalog'], {}); }
      catch { return []; }
    },
    async resolveFolderBindings(chatIds) {
      try {
        return await tryArchive(['resolveFolderBindings'], { chatIds: Array.isArray(chatIds) ? chatIds : [] });
      } catch { return {}; }
    },
    async setFolderBinding(chatId, folderId, opts = {}) {
      // The native archive bridge accepts an optional `folderBindingSource`
      // tag — studio.js sends 'user' for direct UI mutations. Pass it through
      // when callers provide it so attribution stays consistent across surfaces.
      const payload = {
        chatId: String(chatId || ''),
        folderId: String(folderId || ''),
      };
      if (opts && opts.source) payload.folderBindingSource = String(opts.source);
      return tryArchive(['setFolderBinding'], payload);
    },
    async setFolderIconColor(folderId, iconColor) {
      return tryArchive(['setFolderIconColor'], {
        folderId: String(folderId || ''),
        iconColor: String(iconColor || ''),
      });
    },
    async setSnapshotCategory(snapshotId, chatId, categoryId) {
      // The native archive bridge expects `primaryCategoryId` (matching the
      // snapshot-metadata `category.primaryCategoryId` shape). studio.js's
      // proven mutation path uses this key; we mirror it so the Workspace
      // facade and studio.js converge on the same payload contract — and so
      // S0F1d's Organize tab batch operations actually land on the backend.
      // `chatId` is accepted by the bridge as a hint; studio.js omits it, we
      // keep the parameter for caller convenience but don't forward by default.
      return tryArchive(['setSnapshotCategory'], {
        snapshotId: String(snapshotId || ''),
        primaryCategoryId: String(categoryId || ''),
      });
    },
    async reclassifySnapshotCategory(snapshotId) {
      // Re-runs the auto-classifier on a snapshot. Mirrors studio.js's
      // handleCategoryReclassify payload shape exactly.
      return tryArchive(['reclassifySnapshotCategory'], {
        snapshotId: String(snapshotId || ''),
      });
    },
    callArchive,
    tryArchive,

    subscribe(fn) {
      // Studio currently has no archive-change broadcast channel. Library modules
      // poll lazily via getKnownChats(); this subscribe() is a noop placeholder so
      // future cross-surface sync (Phase 3) can wire here without API churn.
      step('chat-list.subscribe', 'no-op (no archive change channel yet)');
      return () => {};
    },

    surface() { return 'studio'; },
  };

  // ── Service: command-bar (Studio diagnostics surface) ──────────────────────
  // Studio has no Command Bar UI yet. We expose a registration API that captures
  // commands into a list — Library Maintenance and other diagnostics can register
  // here, and a future S0X1a Command Bar - Studio.js can read the registry.
  const commandBarService = (() => {
    const groups = Object.create(null);
    return {
      registerGroup(groupId, def) {
        const id = String(groupId || '').trim();
        if (!id) return false;
        groups[id] = { ...(def || {}), id, registeredAt: Date.now() };
        step('cmdBar.registerGroup', id);
        return true;
      },
      registerCommand(groupId, cmd) {
        const id = String(groupId || '').trim();
        if (!id) return false;
        const group = groups[id] = groups[id] || { id, controls: [] };
        group.controls = Array.isArray(group.controls) ? group.controls : [];
        group.controls.push({ ...(cmd || {}), registeredAt: Date.now() });
        step('cmdBar.registerCommand', `${id}:${cmd?.id || ''}`);
        return true;
      },
      listGroups() { return Object.keys(groups); },
      getGroup(id) { return groups[String(id || '').trim()] || null; },
      surface() { return 'studio'; },
    };
  })();

  // ── Surface registration ───────────────────────────────────────────────────
  // We register Studio service implementations onto Library Core. Library Core
  // itself may not exist yet (S0F1a loads after us); we publish the service set
  // on H2O.Library so S0F1a picks them up at boot.
  const studioSurfaceServices = {
    'ui-shell':                   uiShellService,
    'page-host':                  pageHostService,
    'native-sidebar':             nativeSidebarService,
    'folder-sidebar-contribution': folderSidebarContributionService,
    'route':                      routeService,
    'chat-list':                  chatListService,
    'command-bar':                commandBarService,
  };

  host.surfaceName = 'studio';
  host.services = studioSurfaceServices;
  host.uiShellService = uiShellService;
  host.pageHostService = pageHostService;
  host.nativeSidebarService = nativeSidebarService;
  host.folderSidebarContributionService = folderSidebarContributionService;
  host.routeService = routeService;
  host.chatListService = chatListService;
  host.commandBarService = commandBarService;

  // Helper for S0F1a to call once it has registered LibraryCore.
  host.registerOnCore = function registerOnCore(core) {
    if (!core || typeof core.registerService !== 'function') return false;
    let ok = true;
    for (const [name, impl] of Object.entries(studioSurfaceServices)) {
      try {
        core.registerService(name, impl, { replace: true });
        step('register-service', name);
      } catch (e) {
        err(`register-service:${name}`, e);
        ok = false;
      }
    }
    try {
      if (typeof core.registerSurface === 'function') {
        core.registerSurface('studio', { services: studioSurfaceServices, label: 'Studio' });
      }
      if (typeof core.setCurrentSurface === 'function') {
        core.setCurrentSurface('studio');
      } else {
        core.currentSurface = 'studio';
      }
    } catch (e) { err('register-surface', e); ok = false; }
    return ok;
  };

  // If Library Core is already present at this point, register immediately.
  if (H2O.LibraryCore && typeof H2O.LibraryCore.registerService === 'function') {
    host.registerOnCore(H2O.LibraryCore);
  }

  // Diagnose helper
  host.diagnose = function diagnose() {
    return {
      surface: 'studio',
      isStudioDocument: isStudioDocument(),
      services: Object.keys(studioSurfaceServices),
      sidebarRoot: !!nativeSidebarService.getRoot(),
      folderHost: !!nativeSidebarService.getFolderHost(),
      folderSidebarContribution: folderSidebarContributionService.diagnose(),
      categoryHost: !!nativeSidebarService.getCategoryHost(),
      chatListHost: !!nativeSidebarService.getChatListHost(),
      pageHostStage: !!pageHostService.getRoot(),
      route: routeService.current(),
      hasArchive: typeof chrome?.runtime?.sendMessage === 'function',
      steps: diag.steps.slice(-20),
      errors: diag.errors.slice(-10),
    };
  };

  step('boot', 'studio-surface-host-ready');

  try {
    W.dispatchEvent(new CustomEvent('evt:h2o:library:surface-host-ready', {
      detail: { surface: 'studio', t: Date.now() },
    }));
  } catch {}
})();
