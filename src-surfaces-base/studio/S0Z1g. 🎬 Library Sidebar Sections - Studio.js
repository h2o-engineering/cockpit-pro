// ==UserScript==
// @h2o-id             s0z1g.library_sidebar_sections.studio
// @name               S0Z1g. 🎬 Library Sidebar Sections - Studio
// @namespace          H2O.Premium.CGX.library_sidebar_sections.studio
// @author             HumamDev
// @version            1.1.0
// @revision           001
// @build              260915-030001
// @description        Studio Library sidebar sections. STAB-P0 T03 publishes Folder rows/actions through the Shell-owned contribution seam and routes Folder business intent through the Library FolderCommands authority; Labels/Categories/Projects remain owner-local.
// @match              https://chatgpt.com/*
// @run-at             document-idle
// @grant              none
// ==/UserScript==

(() => {
  'use strict';

  console.log('H2O DEV LOAD ✅ S0Z1g Library Sidebar Sections (Studio)', Date.now());

  const W = window;
  const D = document;
  const H2O = (W.H2O = W.H2O || {});
  H2O.Library = H2O.Library || {};
  const FOLDER_SIDEBAR_ASSET_DIAGNOSTIC_VERSION = 'f19.7-folder-sidebar-asset-diagnostic-v1';
  const FOLDER_SIDEBAR_ASSET_DIAGNOSTIC_REGISTERED_AT = new Date().toISOString();

  // Persisted collapse state — per-section so toggling Labels doesn't affect Projects.
  const COLLAPSE_KEY = 'h2o:studio:sidebar:sections:collapse:v1';
  const FOLDER_FILTER_NONE = '__none__';
  const ITEM_LIMIT_DEFAULT = 8;
  const FOLDER_SIDEBAR_UI_STATE = {
    showFolderCountPills: false,
    showCountsBySection: {
      folders: false,
      labels: true,
      categories: true,
      projects: true,
    },
  };
  const FOLDER_CREATE_FLOW_STATE = {
    lastAt: 0,
    lastName: '',
    lastStage: '',
    lastStatus: '',
    lastPreview: null,
    lastApply: null,
    lastError: '',
  };
  const FOLDER_DELETE_REQUEST_UI_STATE = {
    pendingFolderIds: new Set(),
    lastLoadedAt: 0,
  };
  const FOLDER_STATE_KEY_LOCAL = 'h2o:prm:cgx:fldrs:state:data:v1';
  const FOLDER_SYNC_STATE_KEY_LOCAL = 'h2o:sync:folder-import:state:v1';
  const CHROME_PENDING_DELETE_HIDDEN_REASON = 'chrome-soft-delete-request-pending';
  const CHROME_PERMANENT_DELETE_BLOCKED_MESSAGE = 'Permanent delete is only available from Desktop Studio.';
  const CHROME_RESTORE_DEFERRED_MESSAGE = 'Restore is available from Desktop Studio.';
  const CHROME_RESTORE_DEFERRED_LEGACY_LABEL = 'Restore from Desktop Studio.';
  const CHROME_RESTORE_REQUEST_LABEL = 'Request Restore';
  const CHROME_RESTORE_REQUEST_EXPORT_DEFERRED_MESSAGE = 'Restore request export will be added in 6C.2.';
  const CHROME_RESTORE_REQUEST_EXPORT_DEFERRED_BLOCKER = 'chrome-restore-request-export-deferred-phase6c2';
  let folderActionDelegationBound = false;
  const FOLDERS_UI_KEYS = [
    'h2o:prm:cgx:fldrs:state:ui:v1',
    'h2o:folders:ui:v1',
  ];
  const FOLDERS_DATA_KEYS = [
    'h2o:prm:cgx:fldrs:state:data:v1',
    'h2o:folders:data:v1',
    'h2o:folders:v1',
  ];
  const SIDEBAR_APPEARANCE_KEY = 'h2o:studio:sidebar:row-appearance:v1';
  const TAG_CATEGORY_LINKS_KEY = 'h2o:prm:cgx:library:tag-category-links:v1';
  const FOLDER_LOCAL_REVIEW_OPERATOR_MODE_KEY = 'h2o:studio:folder-local-review:operator-mode:v1';
  const LOCAL_REVIEW_EXPLANATION = 'These folders exist locally but are not in your native ChatGPT folder catalog. Read-only — no cleanup performed.';
  const LOCAL_REVIEW_BADGE_ORDER = Object.freeze(['extra', 'test', 'conflict', 'desktop-only', 'chrome-only', 'review-required']);
  const FOLDER_METADATA_OPERATION_SCHEMA = 'h2o.folder-metadata-operation.v1';
  const FOLDER_METADATA_COLOR_REASON = 'Chrome Studio canonical folder color change';
  const FOLDER_METADATA_CREATE_REASON = 'Chrome Studio canonical folder create';
  const FOLDER_METADATA_RENAME_REASON = 'Chrome Studio canonical folder rename';
  const FOLDER_METADATA_DELETE_PREVIEW_REASON = 'Chrome Studio canonical folder delete preview';
  const FOLDER_METADATA_DELETE_APPLY_REASON = 'Chrome Studio canonical empty folder delete';
  const FOLDER_METADATA_DELETE_CONFIRMATION_TEXT = 'DELETE EMPTY FOLDER';
  const FOLDER_METADATA_COLOR_TIMEOUT_MS = 8000;
  const FOLDER_METADATA_CREATE_TIMEOUT_MS = 15000;
  const FOLDER_METADATA_CREATE_RECOVERY_ATTEMPTS = 8;
  const FOLDER_METADATA_CREATE_RECOVERY_DELAY_MS = 500;
  const FOLDER_METADATA_RENAME_POLL_MS = 700;
  const FOLDER_METADATA_DELETE_PREVIEW_MAX_AGE_MS = 12000;
  const SIDEBAR_MENU_COLORS = Object.freeze([
    { key: 'default', label: 'Default', color: '', value: '' },
    { key: 'blue', label: 'Blue', color: '#3B82F6', value: '#3B82F6' },
    { key: 'red', label: 'Red', color: '#FF4C4C', value: '#FF4C4C' },
    { key: 'green', label: 'Green', color: '#22C55E', value: '#22C55E' },
    { key: 'gold', label: 'Gold', color: '#FFD54F', value: '#FFD54F' },
    { key: 'sky', label: 'Sky', color: '#7DD3FC', value: '#7DD3FC' },
    { key: 'pink', label: 'Pink', color: '#F472B6', value: '#F472B6' },
    { key: 'purple', label: 'Purple', color: '#A855F7', value: '#A855F7' },
    { key: 'orange', label: 'Orange', color: '#FF914D', value: '#FF914D' },
  ]);
  const SIDEBAR_MENU_ICON_KEYS = Object.freeze([
    'hash',
    'folder',
    'briefcase',
    'code',
    'book',
    'pen',
    'scale',
    'heart',
    'cart',
    'globe',
    'wrench',
    'palette',
  ]);
  const SIDEBAR_MENU_ACTION_SVGS = Object.freeze({
    open: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 5.5A2.5 2.5 0 0 1 7.5 3H11l2 2h3.5A2.5 2.5 0 0 1 19 7.5v9A2.5 2.5 0 0 1 16.5 19h-9A2.5 2.5 0 0 1 5 16.5v-11Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M9 12h6m-2.5-2.5L15 12l-2.5 2.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    studio: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 5.5A2.5 2.5 0 0 1 7.5 3h9A2.5 2.5 0 0 1 19 5.5v13A2.5 2.5 0 0 1 16.5 21h-9A2.5 2.5 0 0 1 5 18.5v-13Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M8.5 7h7M8.5 11h7M8.5 15h4" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>',
    palette: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4a8 8 0 0 0 0 16h1.1a1.9 1.9 0 0 0 1.3-3.2 1.3 1.3 0 0 1 .9-2.2H17a3 3 0 0 0 3-3A7.6 7.6 0 0 0 12 4Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M7.7 11h.01M9.4 7.8h.01M13 7.4h.01" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>',
    rename: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m4 20 4.2-1 10-10a2.1 2.1 0 0 0-3-3l-10 10L4 20Zm11-13 3 3" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    delete: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14M9 7V5a1.5 1.5 0 0 1 1.5-1.5h3A1.5 1.5 0 0 1 15 5v2m-7 0v12.5A1.5 1.5 0 0 0 9.5 21h5A1.5 1.5 0 0 0 16 19.5V7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    copy: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="11" height="11" rx="2" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M5 15.5V6.5A1.5 1.5 0 0 1 6.5 5h9" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
    plus: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  });
  const SIDEBAR_ICON_SVGS = Object.freeze({
    label: `
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M4.5 5.5A2.5 2.5 0 0 1 7 3h6.1c.7 0 1.3.3 1.8.7l4.4 4.4a2.5 2.5 0 0 1 0 3.6l-7.6 7.6a2.5 2.5 0 0 1-3.6 0L4.2 15.4a2.5 2.5 0 0 1-.7-1.8V5.5Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>
        <circle cx="8.5" cy="7.5" r="1.25" fill="currentColor"/>
      </svg>
    `,
    hash: `
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <rect x="4" y="4" width="7" height="7" rx="2" stroke="currentColor" stroke-width="1.8"/>
        <rect x="13" y="4" width="7" height="7" rx="2" stroke="currentColor" stroke-width="1.8"/>
        <rect x="4" y="13" width="7" height="7" rx="2" stroke="currentColor" stroke-width="1.8"/>
        <rect x="13" y="13" width="7" height="7" rx="2" stroke="currentColor" stroke-width="1.8"/>
        <path d="M6.6 7.5H8.4" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>
        <path d="M7.5 6.6V8.4" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>
        <path d="M7.5 11V13" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
        <path d="M16.5 11V13" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
        <path d="M11 7.5H13" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
        <path d="M11 16.5H13" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
      </svg>
    `,
    folder: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6.5A2.5 2.5 0 0 1 5.5 4H10l2 2h6.5A2.5 2.5 0 0 1 21 8.5v9A2.5 2.5 0 0 1 18.5 20h-13A2.5 2.5 0 0 1 3 17.5v-11Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>',
    inbox: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 5.5h14l-1.8 8.2a2.5 2.5 0 0 1-2.4 2H9.2a2.5 2.5 0 0 1-2.4-2L5 5.5Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M8 15.5h1.7a2.3 2.3 0 0 0 4.6 0H16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M4 18.5h16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
    briefcase: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 7V5.8A1.8 1.8 0 0 1 10.8 4h2.4A1.8 1.8 0 0 1 15 5.8V7m-9.5 4.5h13M5 7h14a2 2 0 0 1 2 2v8.5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    code: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 7-5 5 5 5m6-10 5 5-5 5M13 5l-2 14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    book: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 5.5A2.5 2.5 0 0 1 7.5 3H20v16H7.5A2.5 2.5 0 0 0 5 21.5v-16Zm0 0v16M8 7h8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    pen: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m4 20 4.2-1 10-10a2.1 2.1 0 0 0-3-3l-10 10L4 20Zm11-13 3 3" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    scale: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v16M6 20h12M5 7h14M7 7l-3 6h6L7 7Zm10 0-3 6h6l-3-6Z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    heart: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20s-7-4.4-9-9.1C1.7 7.8 3.6 5 6.7 5c1.7 0 3.2.9 4.1 2.2C11.7 5.9 13.2 5 14.9 5c3.1 0 5 2.8 3.7 5.9C19 15.6 12 20 12 20Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>',
    cart: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 5h2l1.6 9.5a2 2 0 0 0 2 1.7h5.7a2 2 0 0 0 1.9-1.4L20 8H8M10 20h.01M17 20h.01" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    globe: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M3.5 12h17M12 3.5c2.2 2.3 3.2 5.1 3.2 8.5S14.2 18.2 12 20.5C9.8 18.2 8.8 15.4 8.8 12S9.8 5.8 12 3.5Z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
    wrench: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14.8 5.2a4.5 4.5 0 0 0 4.9 5L11 18.9a3 3 0 1 1-4.2-4.2l8.7-8.7ZM7.7 17.7h.01" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    palette: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4a8 8 0 0 0 0 16h1.1a1.9 1.9 0 0 0 1.3-3.2 1.3 1.3 0 0 1 .9-2.2H17a3 3 0 0 0 3-3A7.6 7.6 0 0 0 12 4Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M7.7 11h.01M9.4 7.8h.01M13 7.4h.01" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>',
  });
  const SIDEBAR_UNFILED_ICON_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5.2 10.8h13.6l-1.1 6.1A2.6 2.6 0 0 1 15.1 19H8.9a2.6 2.6 0 0 1-2.6-2.1l-1.1-6.1Z" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linejoin="round"/><path d="M7.4 10.8 8.3 7a2.1 2.1 0 0 1 2-1.6h3.4a2.1 2.1 0 0 1 2 1.6l.9 3.8" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"/><path d="M8.8 14h1.6a1.8 1.8 0 0 0 3.2 0h1.6" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"/><path d="M12 7.2 13.8 9 12 10.8 10.2 9 12 7.2Z" fill="currentColor" stroke="none"/></svg>';

  const diag = { t0: performance.now(), steps: [], errors: [], bufMax: 50, errMax: 15 };
  const step = (s, o = '') => { try { diag.steps.push({ t: Math.round(performance.now() - diag.t0), s: String(s), o: String(o) }); if (diag.steps.length > diag.bufMax) diag.steps.splice(0, diag.steps.length - diag.bufMax); } catch {} };
  const err = (s, e) => { try { diag.errors.push({ t: Math.round(performance.now() - diag.t0), s: String(s), e: String(e?.stack || e) }); if (diag.errors.length > diag.errMax) diag.errors.splice(0, diag.errors.length - diag.errMax); } catch {} };

  // ── Service accessors ──────────────────────────────────────────────────────
  function getCore()      { return H2O.LibraryCore || null; }
  function getWorkspace() { return H2O.LibraryWorkspace || null; }
  function getIndex()     { return H2O.LibraryIndex || null; }
  function getRouteSvc()  { return getCore()?.getService?.('route') || null; }
  function getChatListSvc() {
    return getCore()?.getService?.('chat-list') || H2O.Library?.LibrarySurfaceHost?.chatListService || null;
  }

  // STAB-P0 T03 — one Library Folder business-command authority plus the
  // Shell-owned contribution seam. Sync/Host adapters remain behind these
  // boundaries and are not re-owned here.
  const FOLDER_COMMAND_CONTRACT = 'h2o.library.folder-commands.v1';
  const FOLDER_COMMAND_OWNER = 'L-COCKPIT-LIBRARY';
  const FOLDER_CONTRIBUTION_CONTRACT = 'h2o.studio.folder-sidebar-contribution.v1';
  const FOLDER_CONTRIBUTION_OWNER = 'L-STUDIO-APPLICATION-SHELL';

  function folderCommandAuthority() {
    try {
      const commands = H2O.Library?.FolderCommands || null;
      if (!commands || commands.contract !== FOLDER_COMMAND_CONTRACT) return null;
      if (commands.owner !== FOLDER_COMMAND_OWNER) return null;
      return typeof commands.execute === 'function' ? commands : null;
    } catch {
      return null;
    }
  }

  function folderSidebarContribution() {
    try {
      const service = H2O.Studio?.FolderSidebarContribution || null;
      if (!service || service.contract !== FOLDER_CONTRIBUTION_CONTRACT) return null;
      if (service.owner !== FOLDER_CONTRIBUTION_OWNER) return null;
      if (service.contributor !== FOLDER_COMMAND_OWNER) return null;
      return typeof service.setContribution === 'function' ? service : null;
    } catch {
      return null;
    }
  }

  function folderContributionAction(item = {}, command = '') {
    const wanted = String(command || '').trim();
    const actions = Array.isArray(item?.folderContributionActions) ? item.folderContributionActions : [];
    return actions.find((action) => String(action?.command || '').trim() === wanted && typeof action?.execute === 'function') || null;
  }

  function folderCommandPayload(item = {}, extra = {}) {
    const row = item && typeof item === 'object' ? item : {};
    const patch = extra && typeof extra === 'object' ? extra : {};
    const folderId = String(patch.folderId || patch.id || row.folderId || row.id || '').trim();
    const name = String(patch.name || patch.folderName || row.name || row.folderName || row.label || row.title || '').trim();
    const color = normalizeHexColor(patch.color || patch.iconColor || row.color || row.iconColor || '');
    return {
      ...(folderId ? { id: folderId, folderId } : {}),
      ...(name ? { name, folderName: name } : {}),
      ...(color ? { color, iconColor: color } : (Object.prototype.hasOwnProperty.call(patch, 'color') ? { color: '', iconColor: '' } : {})),
      source: String(patch.source || row.source || '').trim(),
      stateSource: String(patch.stateSource || row.stateSource || '').trim(),
      sourceKind: String(patch.sourceKind || row.sourceKind || '').trim(),
      isCanonical: patch.isCanonical === true || row.isCanonical === true,
      materializedUserFolder: patch.materializedUserFolder === true || row.materializedUserFolder === true,
      trustedFolderDisplay: patch.trustedFolderDisplay === true || row.trustedFolderDisplay === true,
      protectedCanonicalFallback: patch.protectedCanonicalFallback === true || row.protectedCanonicalFallback === true,
      shownInNormalMode: patch.shownInNormalMode === true || row.shownInNormalMode === true,
      ...patch,
    };
  }

  async function executeFolderBusinessCommand(command, input = {}, item = null) {
    const action = item ? folderContributionAction(item, command) : null;
    const payload = folderCommandPayload(item || {}, { ...(action?.input || {}), ...(input || {}) });
    try {
      if (action) return await action.execute(payload);
      const authority = folderCommandAuthority();
      if (!authority) {
        return {
          ok: false,
          status: 'folder-command-contract-unavailable',
          contract: FOLDER_COMMAND_CONTRACT,
          owner: FOLDER_COMMAND_OWNER,
        };
      }
      return await authority.execute(command, payload);
    } catch (e) {
      err(`folderCommand.${String(command || 'unknown')}`, e);
      return {
        ok: false,
        status: 'folder-command-execution-threw',
        reason: String(e?.message || e || 'folder command failed'),
        contract: FOLDER_COMMAND_CONTRACT,
        owner: FOLDER_COMMAND_OWNER,
      };
    }
  }

  function shouldUseLegacyFolderAdapter(result) {
    const status = String(result?.status || result?.reason || '').trim();
    return [
      'tauri-only',
      'surface-adapter-unavailable',
      'actions-unavailable',
      'native-context-required',
    ].includes(status);
  }

  // ── Tiny DOM helper ────────────────────────────────────────────────────────
  function el(tag, attrs = {}, children) {
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

  function formatNumber(n) {
    const v = Number(n) || 0;
    if (v >= 1000) return `${(v / 1000).toFixed(v >= 10000 ? 0 : 1)}k`;
    return String(v);
  }

  function folderOperatorModeEnabled() {
    try {
      const api = W.H2O?.Studio?.folderOperatorMode;
      if (api && typeof api.isEnabled === 'function') return api.isEnabled() === true;
    } catch {}
    try {
      const explicit = W.H2O?.Studio?.folderLocalReviewOperatorMode;
      if (explicit === true) return true;
      if (explicit === false) return false;
    } catch {}
    try {
      const raw = W.localStorage?.getItem?.(FOLDER_LOCAL_REVIEW_OPERATOR_MODE_KEY);
      return raw === '1' || raw === 'true';
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

  function folderDestructiveActionsEnabled() {
    return folderOperatorModeEnabled();
  }

  function folderSidebarDebugDetailsVisible() {
    return folderOperatorModeEnabled();
  }

  function folderSidebarChatCountLabel(value) {
    const count = Number(value || 0) || 0;
    return `${formatNumber(count)} ${count === 1 ? 'chat' : 'chats'}`;
  }

  function folderSidebarSimpleCountLabel(item = {}) {
    const count = Number(item.nativeMembershipCount ?? item.canonicalCount ?? item.count ?? item.knownStudioCount ?? item.knownCount ?? 0) || 0;
    return folderSidebarChatCountLabel(count);
  }

  function countLabelForItem(item = {}) {
    const display = String(item.displayCountLabel || '').trim();
    if (display) return display;
    return item.count != null ? formatNumber(item.count) : '';
  }

  function sidebarSectionCountValue(item = {}) {
    const n = Number(item.count ?? item.nativeMembershipCount ?? item.canonicalCount ?? item.knownStudioCount ?? item.knownCount ?? 0) || 0;
    return formatNumber(n);
  }

  function sidebarSectionCountsVisible(kind) {
    const k = String(kind || '').trim();
    if (!k) return true;
    return FOLDER_SIDEBAR_UI_STATE.showCountsBySection[k] !== false;
  }

  function sidebarSectionHeaderButtonStyle(rightPx = 8) {
    return `position:absolute;top:8px;right:${Number(rightPx) || 8}px;z-index:2;display:inline-flex;align-items:center;justify-content:center;width:22px;height:20px;padding:0;border:0;border-radius:6px;background:transparent;color:rgba(255,255,255,.62);font:700 11px/1 ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;letter-spacing:0;text-transform:none;cursor:pointer`;
  }

  function folderCountDetailsText(item = {}) {
    if (!folderSidebarDebugDetailsVisible()) return folderSidebarSimpleCountLabel(item);
    const display = String(item.displayCountLabel || '').trim();
    if (display) return display;
    if (item.isUnfiled) {
      const known = Number(item.knownStudioCount ?? item.knownCount ?? item.count ?? 0) || 0;
      return `${formatNumber(known)} known here`;
    }
    const hasKnown = item.knownStudioCount != null || item.knownCount != null;
    const hasNative = item.nativeMembershipCount != null || item.canonicalCount != null || item.count != null;
    if (hasNative || hasKnown) {
      const nativeCount = Number(item.nativeMembershipCount ?? item.canonicalCount ?? item.count ?? 0) || 0;
      const knownCount = Number(item.knownStudioCount ?? item.knownCount ?? 0) || 0;
      const parts = [`${formatNumber(nativeCount)} native`, `${formatNumber(knownCount)} known here`];
      if (item.countMismatch === true || (Array.isArray(item.badges) && item.badges.includes('count-mismatch'))) {
        parts.push('count-mismatch');
      }
      return parts.join(' · ');
    }
    return countLabelForItem(item);
  }

  function localReviewBadgeValues(item = {}) {
    const values = new Set((Array.isArray(item.badges) ? item.badges : [])
      .map((badge) => String(badge || '').trim().toLowerCase())
      .filter(Boolean));
    if (item.isExtra) values.add('extra');
    if (item.isTestCandidate) values.add('test');
    if (item.isConflict) values.add('conflict');
    const bucket = String(item.reviewBucket || '').trim().toLowerCase();
    if (bucket) values.add(bucket);
    values.add('review-required');
    return LOCAL_REVIEW_BADGE_ORDER.filter((badge) => values.has(badge));
  }

  function localReviewBadgeNodes(item = {}) {
    const badges = localReviewBadgeValues(item);
    if (!badges.length) return null;
    return el('span', {
      class: 'wbSidebarLocalReviewBadges',
      style: 'display:flex;flex-wrap:wrap;gap:3px;margin-top:3px;min-width:0',
    }, badges.map((badge) => el('span', {
      class: `wbSidebarLocalReviewBadge wbSidebarLocalReviewBadge--${badge}`,
      style: 'display:inline-flex;align-items:center;max-width:100%;border:1px solid rgba(255,255,255,.12);border-radius:999px;padding:1px 5px;font-size:9.5px;line-height:1.25;color:rgba(255,255,255,.68);background:rgba(255,255,255,.045);text-transform:none;letter-spacing:0',
      title: badge,
    }, badge)));
  }

  function folderDeleteRequestBadgeNode(item = {}) {
    if (studioPlatformAdapter() === 'mv3') return null;
    const badges = new Set((Array.isArray(item.badges) ? item.badges : [])
      .map((badge) => String(badge || '').trim().toLowerCase())
      .filter(Boolean));
    if (item.deleteRequestPending === true) badges.add('delete-requested');
    if (!badges.has('delete-requested')) return null;
    return el('span', {
      class: 'wbSidebarFolderDeleteRequestBadge',
      style: 'display:inline-flex;align-items:center;max-width:100%;border:1px solid rgba(250,204,21,.22);border-radius:999px;padding:1px 5px;font-size:9.5px;line-height:1.25;color:rgba(254,240,138,.92);background:rgba(250,204,21,.08);text-transform:none;letter-spacing:0',
      title: 'Delete pending Desktop review',
    }, 'Delete pending');
  }

  function normalizeHexColor(raw = '') {
    const value = String(raw || '').trim();
    return /^#[0-9a-f]{6}$/i.test(value) ? value.toUpperCase() : '';
  }

  function readJson(key, fallback = null) {
    try {
      const raw = W.localStorage.getItem(key);
      return raw == null ? fallback : JSON.parse(raw);
    } catch {
      return fallback;
    }
  }

  function writeJson(key, value) {
    try {
      W.localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (e) {
      err(`writeJson:${key}`, e);
      return false;
    }
  }

  function plainObject(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  }

  function chromeStorageLocal() {
    try {
      const storage = W.chrome?.storage?.local;
      return storage && typeof storage.get === 'function' && typeof storage.set === 'function' ? storage : null;
    } catch {
      return null;
    }
  }

  function chromeStorageGet(key) {
    return new Promise((resolve) => {
      const storage = chromeStorageLocal();
      if (!storage) { resolve(null); return; }
      try {
        storage.get([key], (items) => {
          resolve(items && Object.prototype.hasOwnProperty.call(items, key) ? items[key] : null);
        });
      } catch {
        resolve(null);
      }
    });
  }

  function chromeStorageSet(key, value) {
    return new Promise((resolve) => {
      const storage = chromeStorageLocal();
      if (!storage) { resolve(false); return; }
      try {
        const item = {};
        item[key] = value;
        storage.set(item, () => resolve(true));
      } catch (e) {
        err(`chromeStorageSet:${key}`, e);
        resolve(false);
      }
    });
  }

  async function readChromeFolderStateMirror() {
    if (studioPlatformAdapter() !== 'mv3') return {};
    return (await readChromeFolderStateMirrorSources()).merged;
  }

  function mergeChromeFolderStateMirror(primary = {}, secondary = {}) {
    const next = {
      ...plainObject(secondary),
      ...plainObject(primary),
    };
    ['hiddenByChromePendingDelete', 'hiddenByDesktopReceipt', 'hiddenByDesktopVisibleSet'].forEach((key) => {
      next[key] = {
        ...plainObject(secondary?.[key]),
        ...plainObject(primary?.[key]),
      };
    });
    return next;
  }

  function hasChromeDesktopCanonicalRecentlyDeletedSnapshot(value) {
    const snapshot = plainObject(value);
    return !!(snapshot && Array.isArray(snapshot.rows));
  }

  function chromeDesktopCanonicalRecentlyDeletedRowCount(value) {
    const snapshot = plainObject(value);
    return Array.isArray(snapshot.rows) ? snapshot.rows.length : 0;
  }

  function hasChromeDesktopPurgedFolderSuppressionSnapshot(value) {
    const snapshot = plainObject(value);
    return !!(snapshot && Array.isArray(snapshot.rows));
  }

  function chromeDesktopPurgedFolderSuppressionRowCount(value) {
    const snapshot = plainObject(value);
    return Array.isArray(snapshot.rows) ? snapshot.rows.length : 0;
  }

  async function readChromeFolderStateMirrorSources() {
    if (studioPlatformAdapter() !== 'mv3') {
      return {
        merged: {},
        source: 'not-chrome-studio',
        chromeStorageAvailable: false,
        chromeStorageSource: 'unavailable',
        localStorageSource: 'skipped',
        hiddenByChromePendingDeleteChromeCount: 0,
        hiddenByChromePendingDeleteLocalCount: 0,
      };
    }
    const chromeValue = await chromeStorageGet(FOLDER_STATE_KEY_LOCAL);
    const chromeState = plainObject(chromeValue);
    const localState = plainObject(readJson(FOLDER_STATE_KEY_LOCAL, {}));
    const chromeSyncValue = await chromeStorageGet(FOLDER_SYNC_STATE_KEY_LOCAL);
    const chromeSyncState = plainObject(chromeSyncValue);
    const localSyncState = plainObject(readJson(FOLDER_SYNC_STATE_KEY_LOCAL, {}));
    const hasChrome = !!(chromeValue && typeof chromeValue === 'object' && !Array.isArray(chromeValue));
    const hasChromeSync = !!(chromeSyncValue && typeof chromeSyncValue === 'object' && !Array.isArray(chromeSyncValue));
    const localRawPresent = (() => {
      try { return W.localStorage?.getItem?.(FOLDER_STATE_KEY_LOCAL) != null; }
      catch { return false; }
    })();
    const localSyncRawPresent = (() => {
      try { return W.localStorage?.getItem?.(FOLDER_SYNC_STATE_KEY_LOCAL) != null; }
      catch { return false; }
    })();
    const merged = mergeChromeFolderStateMirror(hasChrome ? chromeState : {}, localState);
    const syncMerged = {
      ...localSyncState,
      ...chromeSyncState,
    };
    const folderMirrorHasCanonical = hasChromeDesktopCanonicalRecentlyDeletedSnapshot(merged.desktopCanonicalRecentlyDeleted);
    const syncStateHasCanonical = hasChromeDesktopCanonicalRecentlyDeletedSnapshot(syncMerged.desktopCanonicalRecentlyDeleted);
    if (!folderMirrorHasCanonical && syncStateHasCanonical) {
      merged.desktopCanonicalRecentlyDeleted = syncMerged.desktopCanonicalRecentlyDeleted;
    }
    const folderMirrorHasSuppression = hasChromeDesktopPurgedFolderSuppressionSnapshot(merged.desktopPurgedFolderSuppression);
    const syncStateHasSuppression = hasChromeDesktopPurgedFolderSuppressionSnapshot(syncMerged.desktopPurgedFolderSuppression);
    if (syncStateHasSuppression && (!folderMirrorHasSuppression ||
      chromeDesktopPurgedFolderSuppressionRowCount(syncMerged.desktopPurgedFolderSuppression) >=
        chromeDesktopPurgedFolderSuppressionRowCount(merged.desktopPurgedFolderSuppression))) {
      merged.desktopPurgedFolderSuppression = syncMerged.desktopPurgedFolderSuppression;
    }
    const chromePendingCount = Object.keys(plainObject(chromeState.hiddenByChromePendingDelete)).length;
    const localPendingCount = Object.keys(plainObject(localState.hiddenByChromePendingDelete)).length;
    const canonicalSource = hasChromeDesktopCanonicalRecentlyDeletedSnapshot(merged.desktopCanonicalRecentlyDeleted)
      ? (folderMirrorHasCanonical ? 'folder-state-mirror' : 'sync-import-state')
      : 'missing';
    const suppressionSource = hasChromeDesktopPurgedFolderSuppressionSnapshot(merged.desktopPurgedFolderSuppression)
      ? (folderMirrorHasSuppression ? 'folder-state-mirror' : 'sync-import-state')
      : 'missing';
    return {
      merged,
      source: hasChrome && localRawPresent ? 'chrome.storage.local+localStorage'
        : hasChrome ? 'chrome.storage.local'
        : localRawPresent ? 'localStorage'
        : 'empty',
      chromeStorageAvailable: !!chromeStorageLocal(),
      chromeStorageSource: hasChrome ? 'chrome.storage.local' : 'empty',
      localStorageSource: localRawPresent ? 'localStorage' : 'empty',
      syncStateSource: hasChromeSync && localSyncRawPresent ? 'chrome.storage.local+localStorage'
        : hasChromeSync ? 'chrome.storage.local'
        : localSyncRawPresent ? 'localStorage'
        : 'empty',
      desktopCanonicalRecentlyDeletedSource: canonicalSource,
      desktopCanonicalRecentlyDeletedFolderStateCount: chromeDesktopCanonicalRecentlyDeletedRowCount(merged.desktopCanonicalRecentlyDeleted),
      desktopCanonicalRecentlyDeletedSyncStateCount: chromeDesktopCanonicalRecentlyDeletedRowCount(syncMerged.desktopCanonicalRecentlyDeleted),
      desktopPurgedFolderSuppressionSource: suppressionSource,
      desktopPurgedFolderSuppressionFolderStateCount: chromeDesktopPurgedFolderSuppressionRowCount(merged.desktopPurgedFolderSuppression),
      desktopPurgedFolderSuppressionSyncStateCount: chromeDesktopPurgedFolderSuppressionRowCount(syncMerged.desktopPurgedFolderSuppression),
      hiddenByChromePendingDeleteChromeCount: chromePendingCount,
      hiddenByChromePendingDeleteLocalCount: localPendingCount,
      hiddenByChromePendingDeleteMergedCount: Object.keys(plainObject(merged.hiddenByChromePendingDelete)).length,
      desktopReceiptHiddenMergedCount: Object.keys(plainObject(merged.hiddenByDesktopReceipt)).length,
    };
  }

  async function writeChromeFolderStateMirror(next) {
    if (studioPlatformAdapter() !== 'mv3') return false;
    const payload = plainObject(next);
    const wroteChromeStorage = await chromeStorageSet(FOLDER_STATE_KEY_LOCAL, payload);
    const wroteLocalStorage = writeJson(FOLDER_STATE_KEY_LOCAL, payload);
    return wroteChromeStorage || wroteLocalStorage;
  }

  function chromePendingDeleteHiddenRowsFromState(state) {
    const bag = plainObject(state?.hiddenByChromePendingDelete);
    return Object.keys(bag).sort().map((folderId) => {
      const row = plainObject(bag[folderId]);
      return {
        ...row,
        id: String(row.id || row.folderId || folderId).trim(),
        folderId: String(row.folderId || row.id || folderId).trim(),
        name: String(row.name || row.folderName || row.title || folderId).trim(),
        folderName: String(row.folderName || row.name || row.title || folderId).trim(),
        hiddenByChromePendingDelete: true,
        pendingDeleteHidden: true,
        status: String(row.status || 'pending-delete').trim() || 'pending-delete',
      };
    }).filter((row) => row.folderId);
  }

  async function loadChromePendingDeleteHiddenRows() {
    if (studioPlatformAdapter() !== 'mv3') return [];
    try {
      return chromePendingDeleteHiddenRowsFromState(await readChromeFolderStateMirror());
    } catch (e) {
      err('chromePendingDeleteHidden.load', e);
      return [];
    }
  }

  function summarizeChromePendingDeleteHiddenRow(item = {}, result = {}) {
    const folderId = String(item?.id || item?.folderId || result?.folderId || '').trim();
    const name = String(item?.name || item?.folderName || item?.title || result?.folderName || folderId).trim();
    const color = normalizeHexColor(item?.color || item?.iconColor || '');
    const requestId = String(result?.requestId || result?.reviewId || '').trim();
    return {
      schema: 'h2o.studio.chrome-folder-pending-delete-hidden.v1',
      id: folderId,
      folderId,
      name,
      folderName: name,
      color,
      iconColor: color,
      requestId,
      reviewId: String(result?.reviewId || result?.requestId || '').trim(),
      requestedAt: String(result?.requestedAt || result?.createdAt || new Date().toISOString()).trim(),
      hiddenAt: new Date().toISOString(),
      status: 'pending-delete',
      source: 'chrome-folder-delete-request',
      sourceKind: 'chrome-pending-soft-delete',
      reason: CHROME_PENDING_DELETE_HIDDEN_REASON,
      hiddenByChromePendingDelete: true,
      pendingDeleteHidden: true,
      visibleStateOnly: true,
      desktopAuthorityRequired: true,
      noTombstoneApplyOnChrome: true,
      noChromeTombstoneApply: true,
      noHardDelete: true,
      noPurge: true,
      noChatDelete: true,
      noSnapshotDelete: true,
      noAssetDelete: true,
    };
  }

  async function markChromeFolderPendingDeleteHidden(item = {}, result = {}) {
    if (studioPlatformAdapter() !== 'mv3') return { ok: true, skipped: true, status: 'not-chrome-studio' };
    const row = summarizeChromePendingDeleteHiddenRow(item, result);
    if (!row.folderId) return { ok: false, status: 'folder-identity-missing', blockers: ['folder-identity-missing'] };
    const current = await readChromeFolderStateMirror();
    const next = { ...plainObject(current) };
    const hidden = { ...plainObject(next.hiddenByChromePendingDelete) };
    hidden[row.folderId] = {
      ...plainObject(hidden[row.folderId]),
      ...row,
    };
    next.hiddenByChromePendingDelete = hidden;
    next.updatedAt = new Date().toISOString();
    await writeChromeFolderStateMirror(next);
    return {
      ok: true,
      status: 'chrome-folder-pending-delete-hidden',
      folderId: row.folderId,
      hiddenByChromePendingDelete: true,
      visibleStateOnly: true,
      noTombstoneApplyOnChrome: true,
      noHardDelete: true,
      noPurge: true,
      noChatDelete: true,
      noSnapshotDelete: true,
      noAssetDelete: true,
    };
  }

  function chromePendingDeleteHiddenIdsFromRows(rows) {
    return new Set((Array.isArray(rows) ? rows : [])
      .map((row) => String(row?.folderId || row?.id || '').trim())
      .filter(Boolean));
  }

  function emitLibraryAppearanceChanged(detail = {}) {
    const payload = {
      ...detail,
      action: String(detail.action || 'appearance-changed'),
      source: String(detail.source || 'studio-sidebar-menu'),
      ts: Date.now(),
    };
    try { W.dispatchEvent(new CustomEvent('evt:h2o:folders:changed', { detail: payload })); } catch {}
    try { W.dispatchEvent(new CustomEvent('evt:h2o:labels:changed', { detail: payload })); } catch {}
    try { W.dispatchEvent(new CustomEvent('evt:h2o:library:cross-surface-sync', { detail: payload })); } catch {}
  }

  function readNativeCategoryPrefs() {
    for (const key of FOLDERS_UI_KEYS) {
      const ui = readJson(key, null);
      if (ui && typeof ui === 'object' && ui.categoryPrefs && typeof ui.categoryPrefs === 'object') {
        return ui.categoryPrefs;
      }
    }
    return {};
  }

  function writeNativeCategoryAppearance(categoryId, patch = {}) {
    const id = String(categoryId || '').trim();
    if (!id) return false;
    let wrote = false;
    for (const key of FOLDERS_UI_KEYS) {
      const ui = readJson(key, null);
      const nextUi = ui && typeof ui === 'object' ? { ...ui } : {};
      const prefs = nextUi.categoryPrefs && typeof nextUi.categoryPrefs === 'object' ? { ...nextUi.categoryPrefs } : {};
      const current = prefs[id] && typeof prefs[id] === 'object' ? { ...prefs[id] } : {};
      const next = { ...current };
      if (Object.prototype.hasOwnProperty.call(patch, 'icon')) {
        const icon = normalizeCategoryIcon(patch.icon);
        if (icon === 'hash') delete next.icon;
        else next.icon = icon;
      }
      if (Object.prototype.hasOwnProperty.call(patch, 'color')) {
        const color = normalizeHexColor(patch.color || '');
        if (color) next.color = color;
        else delete next.color;
      }
      if (Object.keys(next).length) prefs[id] = next;
      else delete prefs[id];
      nextUi.categoryPrefs = prefs;
      wrote = writeJson(key, nextUi) || wrote;
    }
    if (wrote) {
      emitLibraryAppearanceChanged({ action: 'category-appearance', categoryId: id });
      renderAllSections();
    }
    return wrote;
  }

  function writeNativeFolderColor(folderId, colorRaw = '') {
    const id = String(folderId || '').trim();
    if (!id) return false;
    const color = normalizeHexColor(colorRaw || '');
    let wrote = false;
    for (const key of FOLDERS_DATA_KEYS) {
      const data = readJson(key, null);
      const folders = Array.isArray(data) ? data : (data && typeof data === 'object' && Array.isArray(data.folders) ? data.folders : null);
      if (!folders) continue;
      let changed = false;
      const nextFolders = folders.map((row) => {
        const fid = String(row?.id || row?.folderId || '').trim();
        if (fid !== id || !row || typeof row !== 'object') return row;
        changed = true;
        const next = { ...row, updatedAt: new Date().toISOString() };
        if (color) next.iconColor = color;
        else delete next.iconColor;
        return next;
      });
      if (!changed) continue;
      const nextData = Array.isArray(data) ? nextFolders : { ...data, folders: nextFolders, updatedAt: new Date().toISOString() };
      wrote = writeJson(key, nextData) || wrote;
    }
    D.querySelectorAll('.wbFolderItem[data-folder-id]').forEach((node) => {
      if (String(node?.dataset?.folderId || '') !== id) return;
      if (color) {
        node.dataset.color = color;
        node.style.setProperty('--wb-sidebar-item-color', color);
      } else {
        delete node.dataset.color;
        node.style.removeProperty('--wb-sidebar-item-color');
      }
    });
    try {
      const chatList = getChatListSvc();
      if (typeof chatList?.setFolderIconColor === 'function') {
        wrote = true;
        Promise.resolve(chatList.setFolderIconColor(id, color)).then(() => {
          emitLibraryAppearanceChanged({ action: 'folder-appearance', folderId: id, iconColor: color });
        }).catch((e) => err('setFolderIconColor', e));
      }
    } catch (e) { err('setFolderIconColor.outer', e); }
    if (wrote) {
      emitLibraryAppearanceChanged({ action: 'folder-appearance', folderId: id, iconColor: color });
      try { W.H2O?.Studio?.refreshFolders?.(); } catch {}
    }
    return wrote;
  }

  function normalizeLocalAppearanceStore(raw) {
    const src = raw && typeof raw === 'object' ? raw : {};
    const out = { version: 1, updatedAt: Number(src.updatedAt || 0) || 0, folders: {}, labels: {}, projects: {} };
    ['folders', 'labels', 'projects'].forEach((kind) => {
      Object.entries(src[kind] || {}).forEach(([idRaw, prefRaw]) => {
        const id = String(idRaw || '').trim();
        const pref = prefRaw && typeof prefRaw === 'object' ? prefRaw : {};
        if (!id) return;
        const row = {};
        const color = normalizeHexColor(pref.color || '');
        const icon = String(pref.icon || '').trim().toLowerCase();
        const name = String(pref.name || '').trim();
        if (color) row.color = color;
        if (SIDEBAR_ICON_SVGS[icon]) row.icon = icon;
        if (name) row.name = name;
        if (pref.hidden === true) row.hidden = true;
        if (Object.keys(row).length) out[kind][id] = row;
      });
    });
    return out;
  }

  function readLocalAppearanceStore() {
    return normalizeLocalAppearanceStore(readJson(SIDEBAR_APPEARANCE_KEY, null));
  }

  function writeLocalAppearanceStore(storeRaw) {
    const next = normalizeLocalAppearanceStore(storeRaw);
    next.updatedAt = Date.now();
    writeJson(SIDEBAR_APPEARANCE_KEY, next);
    return next;
  }

  function writeLocalRowAppearance(item, patch = {}) {
    const kind = normalizeMenuKind(item?.kind || item?.section || item?.type || '');
    const id = String(item?.id || item?.folderId || item?.labelId || item?.projectId || '').trim();
    if (!id || !['folders', 'labels', 'projects'].includes(kind)) return null;
    const store = readLocalAppearanceStore();
    const current = store[kind][id] && typeof store[kind][id] === 'object' ? { ...store[kind][id] } : {};
    const next = { ...current };
    if (kind === 'folders') {
      delete next.icon;
      delete next.name;
      delete next.hidden;
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'color')) {
      const color = normalizeHexColor(patch.color || '');
      if (color) next.color = color;
      else delete next.color;
    }
    if (kind !== 'folders' && Object.prototype.hasOwnProperty.call(patch, 'icon')) {
      const icon = String(patch.icon || '').trim().toLowerCase();
      if (SIDEBAR_ICON_SVGS[icon]) next.icon = icon;
      else delete next.icon;
    }
    if (kind !== 'folders' && Object.prototype.hasOwnProperty.call(patch, 'name')) {
      const name = String(patch.name || '').trim();
      if (name) next.name = name;
      else delete next.name;
    }
    if (kind !== 'folders' && Object.prototype.hasOwnProperty.call(patch, 'hidden')) {
      if (patch.hidden === true) next.hidden = true;
      else delete next.hidden;
    }
    if (Object.keys(next).length) store[kind][id] = next;
    else delete store[kind][id];
    writeLocalAppearanceStore(store);
    emitLibraryAppearanceChanged({ action: `${kind}-appearance`, [`${kind.slice(0, -1)}Id`]: id });
    renderAllSections();
    return next;
  }

  function defaultIconForKind(kind) {
    if (kind === 'folders') return 'folder';
    if (kind === 'labels') return 'label';
    if (kind === 'projects') return 'briefcase';
    return 'hash';
  }

  function getRowAppearance(rawItem = {}) {
    const kind = normalizeMenuKind(rawItem.kind || rawItem.section || rawItem.type || '');
    const id = String(rawItem.id || rawItem.folderId || rawItem.categoryId || rawItem.labelId || rawItem.projectId || '').trim();
    const name = String(rawItem.name || rawItem.label || rawItem.title || '').trim();
    if (kind === 'categories') {
      const appearance = categoryAppearance({ ...rawItem, id, name });
      return {
        id,
        kind,
        name,
        color: appearance.color,
        icon: appearance.icon,
        iconSvg: iconSvg(appearance.icon),
        hidden: false,
      };
    }
    const store = readLocalAppearanceStore();
    const pref = kind === 'folders' && id && store[kind] && store[kind][id] && typeof store[kind][id] === 'object' ? store[kind][id] : {};
    const rawIcon = String(rawItem.iconKey || rawItem.icon || '').trim().toLowerCase();
    const fallbackIcon = SIDEBAR_ICON_SVGS[rawIcon] ? rawIcon : defaultIconForKind(kind);
    const icon = kind === 'folders' ? 'folder' : normalizeCategoryIcon(pref.icon || fallbackIcon);
    const isCanonicalFolder = kind === 'folders' && rawItem.isCanonical === true;
    const color = isCanonicalFolder
      ? normalizeHexColor(rawItem.iconColor || rawItem.color || rawItem.folderColor || rawItem.accentColor || '')
      : normalizeHexColor(pref.color || rawItem.color || rawItem.iconColor || rawItem.labelColor || rawItem.projectColor || '');
    return {
      id,
      kind,
      name: kind === 'folders' ? String(name || id).trim() : String(pref.name || name || id).trim(),
      color,
      icon,
      iconSvg: SIDEBAR_ICON_SVGS[icon] || SIDEBAR_ICON_SVGS[defaultIconForKind(kind)] || SIDEBAR_ICON_SVGS.hash,
      hidden: kind === 'folders' ? false : pref.hidden === true,
    };
  }

  function normalizeCategoryIcon(raw = '') {
    const key = String(raw || '').trim().toLowerCase();
    return SIDEBAR_ICON_SVGS[key] ? key : 'hash';
  }

  function defaultCategoryIconKey(id, name) {
    const key = `${id} ${name}`.toLowerCase();
    return /\b(writing|communication|docs?|copywriting)\b/.test(key) ? 'pen' : 'hash';
  }

  function categoryAppearance(row, prefs = readNativeCategoryPrefs()) {
    const id = String(row?.id || row?.categoryId || '').trim();
    const pref = id && prefs && typeof prefs === 'object' && prefs[id] && typeof prefs[id] === 'object' ? prefs[id] : {};
    const icon = normalizeCategoryIcon(
      pref.icon ||
      row?.icon ||
      row?.iconKey ||
      row?.categoryIcon ||
      row?.appearance?.icon ||
      defaultCategoryIconKey(id, row?.name || row?.label || row?.categoryName || '')
    );
    const color = normalizeHexColor(
      pref.color ||
      row?.color ||
      row?.iconColor ||
      row?.categoryColor ||
      row?.appearance?.color ||
      ''
    ) || '#3B82F6';
    return { icon, color };
  }

  function iconSvg(iconKey) {
    return SIDEBAR_ICON_SVGS[normalizeCategoryIcon(iconKey)] || SIDEBAR_ICON_SVGS.hash;
  }

  function makeItemIcon(item, kind) {
    const svg = item.iconSvg || (item.iconKey ? SIDEBAR_ICON_SVGS[item.iconKey] : '');
    const icon = el('span', { class: 'wbSidebarSectionItemIcon', 'aria-hidden': 'true' });
    if (svg) icon.innerHTML = svg;
    else if (item.icon) icon.textContent = String(item.icon);
    else if (kind === 'labels') icon.innerHTML = SIDEBAR_ICON_SVGS.label;
    else if (kind === 'categories') icon.innerHTML = SIDEBAR_ICON_SVGS.hash;
    return icon;
  }

  function normalizeTagKey(raw = '') {
    return String(raw?.id || raw?.label || raw?.name || raw || '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9\u0600-\u06ff]+/g, '-')
      .replace(/^-+|-+$/g, '');
  }

  function tagColorFor(tagId, explicit = '') {
    const color = normalizeHexColor(explicit || '');
    if (color) return color;
    const seed = String(tagId || '');
    let hash = 0;
    for (let i = 0; i < seed.length; i++) hash = ((hash << 5) - hash + seed.charCodeAt(i)) | 0;
    const colors = SIDEBAR_MENU_COLORS.map((row) => row.value).filter(Boolean);
    return colors[Math.abs(hash) % colors.length] || '#F472B6';
  }

  function normalizeTagLinksStore(raw) {
    const src = raw && typeof raw === 'object' ? raw : {};
    const out = { version: 1, updatedAt: Number(src.updatedAt || 0) || 0, tags: {} };
    Object.entries(src.tags || {}).forEach(([fallbackKey, row]) => {
      if (!row || typeof row !== 'object') return;
      const id = normalizeTagKey(row.id || row.key || fallbackKey);
      const categoryIds = Array.from(new Set((Array.isArray(row.categoryIds) ? row.categoryIds : [])
        .map((value) => String(value || '').trim())
        .filter(Boolean)));
      if (!id || !categoryIds.length) return;
      out.tags[id] = {
        id,
        label: String(row.label || row.name || id).trim() || id,
        color: normalizeHexColor(row.color || ''),
        categoryIds,
        updatedAt: Number(row.updatedAt || src.updatedAt || 0) || 0,
      };
    });
    return out;
  }

  function readTagLinksStore() {
    return normalizeTagLinksStore(readJson(TAG_CATEGORY_LINKS_KEY, null));
  }

  function writeTagLinksStore(store) {
    const next = normalizeTagLinksStore(store);
    next.updatedAt = Date.now();
    writeJson(TAG_CATEGORY_LINKS_KEY, next);
    return next;
  }

  function setTagCategoryLinked(tagRaw, categoryIdRaw, linked) {
    const categoryId = String(categoryIdRaw || '').trim();
    const id = normalizeTagKey(tagRaw);
    if (!categoryId || !id) return [];
    const label = String(tagRaw?.label || tagRaw?.name || tagRaw?.id || id).trim() || id;
    const color = tagColorFor(id, tagRaw?.color || '');
    const store = readTagLinksStore();
    const row = store.tags[id] || { id, label, color, categoryIds: [] };
    const selected = new Set(Array.isArray(row.categoryIds) ? row.categoryIds : []);
    if (linked === false) selected.delete(categoryId);
    else selected.add(categoryId);
    const categoryIds = Array.from(selected);
    if (categoryIds.length) {
      store.tags[id] = { ...row, id, label, color, categoryIds, updatedAt: Date.now() };
    } else {
      delete store.tags[id];
    }
    writeTagLinksStore(store);
    const detail = { tagKey: id, categoryIds, ts: Date.now(), source: 'studio-sidebar-menu' };
    try { W.dispatchEvent(new CustomEvent('evt:h2o:tags:category-links-changed', { detail })); } catch {}
    try { W.dispatchEvent(new CustomEvent('h2o:tags:category-links-changed', { detail })); } catch {}
    return categoryIds;
  }

  function collectMenuTags(categoryIdRaw) {
    const categoryId = String(categoryIdRaw || '').trim();
    const byId = new Map();
    try {
      const tags = H2O.Library?.Tags?.listTags?.() || H2O.Tags?.listTags?.() || [];
      (Array.isArray(tags) ? tags : []).forEach((tag) => {
        const id = normalizeTagKey(tag);
        if (!id) return;
        byId.set(id, {
          id,
          label: String(tag?.label || tag?.name || tag?.id || id).trim() || id,
          color: tagColorFor(id, tag?.color || ''),
          count: Math.max(0, Number(tag?.count || tag?.totalUsage || tag?.chatIds?.length || 0) || 0),
        });
      });
    } catch (e) { err('collectMenuTags:list', e); }
    const store = readTagLinksStore();
    const linkedIds = new Set();
    Object.values(store.tags || {}).forEach((row) => {
      const id = normalizeTagKey(row);
      if (!id) return;
      if (Array.isArray(row.categoryIds) && row.categoryIds.includes(categoryId)) linkedIds.add(id);
      if (!byId.has(id)) {
        byId.set(id, {
          id,
          label: String(row.label || id).trim() || id,
          color: tagColorFor(id, row.color || ''),
          count: 0,
        });
      }
    });
    return Array.from(byId.values())
      .map((tag) => ({ ...tag, linked: linkedIds.has(tag.id) }))
      .sort((a, b) => Number(b.linked) - Number(a.linked) || (b.count - a.count) || a.label.localeCompare(b.label));
  }

  function normalizeMenuKind(raw = '') {
    const kind = String(raw || '').trim().toLowerCase();
    if (kind === 'folder' || kind === 'folders') return 'folders';
    if (kind === 'category' || kind === 'categories') return 'categories';
    if (kind === 'label' || kind === 'labels') return 'labels';
    if (kind === 'project' || kind === 'projects') return 'projects';
    return kind || 'item';
  }

  function studioPlatformAdapter() {
    try {
      return String(W.H2O?.Studio?.platform?.env?.adapter || '').trim().toLowerCase();
    } catch { return ''; }
  }

  function studioIsTauri() {
    if (studioPlatformAdapter() === 'tauri') return true;
    try { if (W.H2O?.Studio?.platform?.env?.isTauri === true) return true; } catch {}
    try { if (typeof W.__TAURI_INTERNALS__ !== 'undefined' || typeof W.__TAURI__ !== 'undefined') return true; } catch {}
    return false;
  }

  function desktopFolderEditor() {
    try {
      const modals = W.H2O?.Studio?.OrganizationModals;
      return modals && typeof modals.openFolderEditor === 'function' ? modals : null;
    } catch { return null; }
  }

  function desktopFolderActions() {
    try {
      return W.H2O?.Studio?.actions?.folders || null;
    } catch { return null; }
  }

  function scheduleDesktopFolderEditorAutoExport(mode = '', folderId = '') {
    try {
      if (!studioIsTauri()) return false;
      const cleanMode = String(mode || '').trim();
      if (!['create', 'rename', 'color'].includes(cleanMode)) return false;
      const autoExport = W.H2O?.Studio?.sync?.autoExport;
      if (!autoExport || typeof autoExport.schedule !== 'function') return false;
      autoExport.schedule(`folder-metadata:desktop-sidebar-${cleanMode}`);
      return true;
    } catch (e) {
      err('desktopFolderEditor.autoExport', e);
      return false;
    }
  }

  function canUseDesktopFolderEditor(mode = '') {
    if (!studioIsTauri() || !folderCommandAuthority()) return false;
    const actions = desktopFolderActions();
    const m = String(mode || '').trim();
    if (m === 'create') return typeof actions?.create === 'function';
    if (m === 'rename') return typeof actions?.rename === 'function';
    if (m === 'color') return typeof actions?.update === 'function';
    return false;
  }

  function canUseDesktopFolderSoftDelete() {
    if (!studioIsTauri() || !folderCommandAuthority()) return false;
    const actions = desktopFolderActions();
    return typeof actions?.delete === 'function' || typeof actions?.remove === 'function';
  }

  function desktopFolderStore() {
    try {
      return W.H2O?.Studio?.store?.folders || null;
    } catch { return null; }
  }

  function canUseDesktopRecentlyDeletedFolders() {
    if (!studioIsTauri()) return false;
    const store = desktopFolderStore();
    return typeof store?.listRecentlyDeletedFolders === 'function' ||
      typeof store?.diagnoseRecentlyDeletedFolders === 'function';
  }

  function canUseDesktopFolderRestore() {
    if (!studioIsTauri() || !folderCommandAuthority()) return false;
    const actions = desktopFolderActions();
    return typeof actions?.restore === 'function' || typeof actions?.restoreTombstonedFolder === 'function';
  }

  function canUseDesktopFolderPurge() {
    if (!studioIsTauri()) return false;
    const store = desktopFolderStore();
    return typeof store?.previewRecentlyDeletedFolderPurge === 'function' &&
      typeof store?.purgeRecentlyDeletedFolders === 'function';
  }

  function canUseDesktopRestoredHistoryClear() {
    if (!studioIsTauri()) return false;
    const store = desktopFolderStore();
    return typeof store?.previewRecentlyDeletedRestoredHistoryClear === 'function' &&
      typeof store?.clearRecentlyDeletedRestoredHistory === 'function';
  }

  function chromeFolderDeleteRequestActions() {
    try {
      const actions = W.H2O?.Studio?.actions?.folders;
      if (actions && typeof actions.requestDelete === 'function') return actions;
    } catch {}
    return null;
  }

  function canUseChromeFolderDeleteRequest() {
    if (studioPlatformAdapter() !== 'mv3' || !folderCommandAuthority()) return false;
    const actions = chromeFolderDeleteRequestActions();
    if (actions && typeof actions.requestDelete === 'function') return true;
    try {
      return typeof W.H2O?.Studio?.store?.tombstoneReviews?.requestFolderDelete === 'function';
    } catch {
      return false;
    }
  }

  function folderMetadataOperationRequest() {
    try {
      const fn = W.H2O?.Studio?.sync?.folderMetadataOperations?.request;
      return typeof fn === 'function' ? fn : null;
    } catch { return null; }
  }

  function canRequestNativeCanonicalFolderColor(item) {
    return item?.isCanonical === true
      && studioPlatformAdapter() === 'mv3'
      && !!folderCommandAuthority()
      && !!folderMetadataOperationRequest();
  }

  function canRequestCanonicalFolderColor(item) {
    return canRequestNativeCanonicalFolderColor(item) || (item?.isCanonical === true && canUseDesktopFolderEditor('color'));
  }

  function canRequestNativeCanonicalFolderRename(item) {
    return item?.isCanonical === true
      && studioPlatformAdapter() === 'mv3'
      && !!folderCommandAuthority()
      && !!folderMetadataOperationRequest();
  }

  function canRequestCanonicalFolderRename(item) {
    return canRequestNativeCanonicalFolderRename(item) || (item?.isCanonical === true && canUseDesktopFolderEditor('rename'));
  }

  function canRequestCanonicalFolderCreate() {
    return (studioPlatformAdapter() === 'mv3' && !!folderCommandAuthority() && !!folderMetadataOperationRequest())
      || canUseDesktopFolderEditor('create');
  }

  function canRequestCanonicalFolderDeletePreview(item) {
    return item?.isCanonical === true
      && folderDestructiveActionsEnabled()
      && studioPlatformAdapter() === 'mv3'
      && !!folderMetadataOperationRequest();
  }

  function canRequestCanonicalFolderDeleteApply(item) {
    return canRequestCanonicalFolderDeletePreview(item);
  }

  function resultCodes(result, listName = 'blockers') {
    const rows = Array.isArray(result?.[listName]) ? result[listName] : [];
    return rows.map((entry) => {
      if (typeof entry === 'string') return entry.trim();
      return String(entry?.code || '').trim();
    }).filter(Boolean);
  }

  function firstResultCode(result, fallback = 'folder-color-request-failed') {
    return resultCodes(result, 'blockers')[0]
      || resultCodes(result, 'warnings')[0]
      || fallback;
  }

  function buildFolderMutationTargetSnapshot(item) {
    const folderId = String(item?.id || item?.folderId || '').trim();
    const name = normalizeFolderRenameInput(item?.name || item?.label || item?.title || '');
    const color = normalizeHexColor(item?.iconColor || item?.color || '');
    const sourceKind = String(item?.sourceKind || item?.kind || '').trim();
    const source = String(item?.source || '').trim();
    const snapshot = {
      id: folderId,
      folderId,
      name,
      title: name,
      color,
      iconColor: color,
      source,
      stateSource: String(item?.stateSource || '').trim(),
      sourceKind,
      kind: sourceKind || 'folders',
      isCanonical: item?.isCanonical === true,
      materializedUserFolder: item?.materializedUserFolder === true,
      trustedFolderDisplay: item?.trustedFolderDisplay === true,
      protectedCanonicalFallback: item?.protectedCanonicalFallback === true,
      shownInNormalMode: item?.shownInNormalMode === true,
      reviewBucket: String(item?.reviewBucket || '').trim(),
      hidden: item?.hidden === true,
    };
    Object.keys(snapshot).forEach((key) => {
      if (snapshot[key] === '' || snapshot[key] === false || snapshot[key] == null) delete snapshot[key];
    });
    return snapshot;
  }

  function buildFolderColorOperation(item, color, staleGuard = null) {
    const operation = {
      schema: FOLDER_METADATA_OPERATION_SCHEMA,
      operationType: 'change-folder-color',
      folderId: String(item?.id || item?.folderId || '').trim(),
      before: buildFolderMutationTargetSnapshot(item),
      after: { iconColor: normalizeHexColor(color || '') },
      sourceSurface: 'chrome-studio',
      reason: FOLDER_METADATA_COLOR_REASON,
    };
    if (staleGuard && typeof staleGuard === 'object' && Object.keys(staleGuard).length) {
      operation.staleGuard = staleGuard;
    }
    return operation;
  }

  function normalizeFolderRenameInput(value) {
    return String(value || '').trim().replace(/\s+/g, ' ');
  }

  function normalizeFolderCreateInput(value) {
    return normalizeFolderRenameInput(value);
  }

  function buildFolderCreateOperation(name, staleGuard = null) {
    const operation = {
      schema: FOLDER_METADATA_OPERATION_SCHEMA,
      operationType: 'create-folder',
      after: { name: normalizeFolderCreateInput(name) },
      sourceSurface: 'chrome-studio',
      reason: FOLDER_METADATA_CREATE_REASON,
    };
    if (staleGuard && typeof staleGuard === 'object' && Object.keys(staleGuard).length) {
      operation.staleGuard = staleGuard;
    }
    return operation;
  }

  function buildFolderRenameOperation(item, name, staleGuard = null) {
    const operation = {
      schema: FOLDER_METADATA_OPERATION_SCHEMA,
      operationType: 'rename-folder',
      folderId: String(item?.id || item?.folderId || '').trim(),
      after: { name: normalizeFolderRenameInput(name) },
      sourceSurface: 'chrome-studio',
      reason: FOLDER_METADATA_RENAME_REASON,
    };
    if (staleGuard && typeof staleGuard === 'object' && Object.keys(staleGuard).length) {
      operation.staleGuard = staleGuard;
    }
    return operation;
  }

  function buildFolderDeletePreviewOperation(item, staleGuard = null) {
    const expectedName = normalizeFolderRenameInput(item?.name || item?.label || item?.title || '');
    const operation = {
      schema: FOLDER_METADATA_OPERATION_SCHEMA,
      operationType: 'delete-folder',
      folderId: String(item?.id || item?.folderId || '').trim(),
      sourceSurface: 'chrome-studio',
      reason: FOLDER_METADATA_DELETE_PREVIEW_REASON,
    };
    // Native owner accepts `expectedName` as the per-folder identity confirmation
    // on the delete preview/apply contract. Studio rename/color/create already
    // pass identity via `after.name`; delete previously sent neither, which caused
    // the Native owner bridge to time out on the preview request (P8h-g4).
    if (expectedName) operation.expectedName = expectedName;
    if (staleGuard && typeof staleGuard === 'object' && Object.keys(staleGuard).length) {
      operation.staleGuard = staleGuard;
    }
    return operation;
  }

  function buildFolderDeleteOperation(item, staleGuard = null, confirmation = '') {
    const operation = buildFolderDeletePreviewOperation(item, staleGuard);
    operation.reason = FOLDER_METADATA_DELETE_APPLY_REASON;
    operation.confirmation = String(confirmation || '');
    return operation;
  }

  function shortFolderId(value) {
    const id = String(value || '').trim();
    if (!id) return '';
    if (id.length <= 14) return id;
    return `${id.slice(0, 8)}...${id.slice(-5)}`;
  }

  async function resolveFreshCanonicalFolderItem(item) {
    const folderId = String(item?.id || item?.folderId || '').trim();
    if (!folderId) return null;
    try {
      const model = await W.H2O?.Library?.FolderParity?.getDisplayModel?.({ fresh: true });
      const row = (Array.isArray(model?.canonicalRows) ? model.canonicalRows : [])
        .find((candidate) => String(candidate?.folderId || candidate?.id || '').trim() === folderId);
      if (!row) return null;
      return {
        ...item,
        ...row,
        id: folderId,
        folderId,
        kind: 'folders',
        section: 'folders',
        isCanonical: true,
        name: normalizeFolderRenameInput(row.name || row.title || item?.name || ''),
      };
    } catch (e) {
      err('folderRename.resolveFreshCanonicalItem', e);
      return null;
    }
  }

  async function confirmFreshCanonicalFolderColor(folderIdInput, expectedColorInput) {
    const folderId = String(folderIdInput || '').trim();
    const expectedColor = normalizeHexColor(expectedColorInput || '');
    if (!folderId) return { ok: false, status: 'folder-id-required', folderId, expectedColor };
    try {
      const model = await W.H2O?.Library?.FolderParity?.getDisplayModel?.({
        fresh: true,
        reason: 'desktop-folder-color-confirmation',
      });
      const row = (Array.isArray(model?.canonicalRows) ? model.canonicalRows : [])
        .find((candidate) => String(candidate?.folderId || candidate?.id || '').trim() === folderId);
      if (!row) {
        return {
          ok: false,
          status: 'folder-not-in-display-model',
          folderId,
          expectedColor,
          canonicalMirrorAvailable: model?.canonicalMirrorAvailable === true,
          displayModelAvailable: model?.displayModelAvailable === true,
        };
      }
      const actualColor = normalizeHexColor(row.iconColor || row.color || '');
      const ok = expectedColor ? actualColor === expectedColor : !actualColor;
      return {
        ok,
        status: ok ? 'confirmed' : 'display-color-not-confirmed',
        folderId,
        expectedColor,
        actualColor,
        colorSource: String(row.colorSource || '').trim(),
        canonicalMirrorAvailable: model?.canonicalMirrorAvailable === true,
        displayModelAvailable: model?.displayModelAvailable === true,
      };
    } catch (e) {
      err('folderColor.confirmFreshCanonicalColor', e);
      return {
        ok: false,
        status: 'display-model-confirmation-failed',
        folderId,
        expectedColor,
        reason: String(e?.message || e || ''),
      };
    }
  }

  async function resolveFreshCanonicalFolderItemByName(name) {
    const targetName = normalizeFolderCreateInput(name);
    const targetKey = targetName.toLowerCase();
    if (!targetKey) return null;
    try {
      const model = await W.H2O?.Library?.FolderParity?.getDisplayModel?.({ fresh: true });
      const row = (Array.isArray(model?.canonicalRows) ? model.canonicalRows : [])
        .find((candidate) => normalizeFolderCreateInput(candidate?.name || candidate?.title || '').toLowerCase() === targetKey);
      if (!row) return null;
      const folderId = String(row.folderId || row.id || '').trim();
      return {
        ...row,
        id: folderId,
        folderId,
        kind: 'folders',
        section: 'folders',
        isCanonical: true,
        name: normalizeFolderCreateInput(row.name || row.title || targetName),
      };
    } catch (e) {
      err('folderCreate.resolveFreshCanonicalItemByName', e);
      return null;
    }
  }

  function staleGuardFromPreview(preview) {
    const src = preview?.before && typeof preview.before === 'object' ? preview.before : {};
    const out = {};
    ['folderHash', 'sourceHash', 'membershipHash', 'previewHash'].forEach((key) => {
      const value = String(src[key] || preview?.staleGuard?.[key] || '').trim();
      if (value) out[key] = value;
    });
    return out;
  }

  function deletePreviewBlockers(preview) {
    return resultCodes(preview, 'blockers');
  }

  function deletePreviewHardBlockers(preview) {
    return deletePreviewBlockers(preview)
      .filter((code) => code !== 'delete-confirmation-required');
  }

  function deletePreviewMembershipCount(preview, item = {}) {
    const before = preview?.before && typeof preview.before === 'object' ? preview.before : {};
    const deps = preview?.dependencySummary && typeof preview.dependencySummary === 'object' ? preview.dependencySummary : {};
    return Number(deps.nativeMembershipCount ?? before.nativeMembershipCount ?? before.membershipCount ?? item?.nativeMembershipCount ?? item?.count ?? 0) || 0;
  }

  function deletePreviewItemBucketEmpty(preview) {
    const before = preview?.before && typeof preview.before === 'object' ? preview.before : {};
    const deps = preview?.dependencySummary && typeof preview.dependencySummary === 'object' ? preview.dependencySummary : {};
    if (deps.itemBucketEmpty === true || before.itemBucketEmpty === true) return true;
    if (deps.itemBucketExists === false || before.itemBucketExists === false) return true;
    return false;
  }

  function canApplyDeletePreview(preview, item = {}) {
    if (!preview || typeof preview !== 'object') return false;
    const hardBlockers = deletePreviewHardBlockers(preview);
    if (hardBlockers.length) return false;
    if (deletePreviewMembershipCount(preview, item) !== 0) return false;
    return deletePreviewItemBucketEmpty(preview);
  }

  function numericFolderMenuValue(item, keys = []) {
    for (const key of keys) {
      if (!key) continue;
      const raw = item?.[key];
      if (raw == null || raw === '') continue;
      const n = Number(raw);
      if (Number.isFinite(n)) return Math.max(0, n);
    }
    return 0;
  }

  function addFolderBlocker(blockers, code) {
    const clean = String(code || '').trim();
    if (clean && !blockers.includes(clean)) blockers.push(clean);
  }

  function desktopFolderSoftDeleteBlockers(item = {}) {
    const blockers = [];
    const folderId = String(item?.id || item?.folderId || '').trim();
    const name = String(item?.name || item?.label || item?.title || '').trim();
    const normalizedName = String(item?.normalizedName || name || folderId || '').trim().replace(/\s+/g, ' ').toLowerCase();
    const sourceKind = String(item?.sourceKind || item?.kind || '').trim().toLowerCase();
    const source = String(item?.source || '').trim().toLowerCase();
    const stateSource = String(item?.stateSource || '').trim().toLowerCase();
    if (!folderId) addFolderBlocker(blockers, 'folder-identity-missing');
    if (item?.isCanonical !== true) addFolderBlocker(blockers, 'local-review-folder-not-editable');
    if (folderId === 'unfiled' || normalizedName === 'unfiled') addFolderBlocker(blockers, 'unfiled-folder');
    if (['all', 'archive', 'archived', 'link', 'linked', 'links', 'recent', 'recents', 'saved'].includes(normalizedName)) {
      addFolderBlocker(blockers, 'system-folder');
    }
    if (item?.protectedCanonicalFallback === true || item?.protected === true || item?.isProtected === true) {
      addFolderBlocker(blockers, 'protected-folder');
    }
    if (sourceKind.includes('system') || source.includes('system') || stateSource.includes('system')) {
      addFolderBlocker(blockers, 'system-folder');
    }
    if (sourceKind.includes('local-review') || sourceKind.includes('cleanup-review') ||
        source.includes('local-review') || source.includes('cleanup-review') ||
        stateSource.includes('local-review') || item?.reviewBucket) {
      addFolderBlocker(blockers, 'local-review-folder-not-editable');
    }
    if (!canUseDesktopFolderSoftDelete()) addFolderBlocker(blockers, 'tombstone-store-unavailable');
    return blockers;
  }

  function desktopFolderSoftDeleteBlocker(item = {}) {
    return desktopFolderSoftDeleteBlockers(item)[0] || '';
  }

  function chromeFolderDeleteRequestBlockers(item = {}) {
    const blockers = [];
    const folderId = String(item?.id || item?.folderId || '').trim();
    const name = String(item?.name || item?.label || item?.title || '').trim();
    const normalizedName = String(item?.normalizedName || name || folderId || '').trim().replace(/\s+/g, ' ').toLowerCase();
    const sourceKind = String(item?.sourceKind || item?.kind || '').trim().toLowerCase();
    const source = String(item?.source || '').trim().toLowerCase();
    const stateSource = String(item?.stateSource || '').trim().toLowerCase();
    if (studioPlatformAdapter() !== 'mv3') addFolderBlocker(blockers, 'chrome-studio-required');
    if (!folderId) addFolderBlocker(blockers, 'folder-identity-missing');
    if (item?.isCanonical !== true) addFolderBlocker(blockers, 'local-review-folder-not-editable');
    if (folderId === 'unfiled' || normalizedName === 'unfiled') addFolderBlocker(blockers, 'unfiled-folder');
    if (['all', 'archive', 'archived', 'link', 'linked', 'links', 'recent', 'recents', 'saved'].includes(normalizedName)) {
      addFolderBlocker(blockers, 'system-folder');
    }
    if (item?.protectedCanonicalFallback === true || item?.protected === true || item?.isProtected === true || item?.isSystem === true) {
      addFolderBlocker(blockers, 'protected-folder');
    }
    if (sourceKind.includes('system') || source.includes('system') || stateSource.includes('system')) {
      addFolderBlocker(blockers, 'system-folder');
    }
    if (sourceKind.includes('local-review') || sourceKind.includes('cleanup-review') ||
        source.includes('local-review') || source.includes('cleanup-review') ||
        stateSource.includes('local-review') || item?.reviewBucket) {
      addFolderBlocker(blockers, 'local-review-folder-not-editable');
    }
    if (!canUseChromeFolderDeleteRequest()) addFolderBlocker(blockers, 'tombstone-review-store-unavailable');
    return blockers;
  }

  function chromeFolderDeleteRequestBlocker(item = {}) {
    return chromeFolderDeleteRequestBlockers(item)[0] || '';
  }

  function folderIdFromDeleteRequestReview(row) {
    const recordId = String(row?.recordId || '').trim();
    try {
      const payload = JSON.parse(String(row?.rawTombstoneJson || '{}'));
      const folderId = String(payload?.folderId || '').trim();
      if (folderId) return folderId;
    } catch {}
    return recordId;
  }

  function parseFolderDeleteRequestPayload(row = {}) {
    try {
      const payload = JSON.parse(String(row?.rawTombstoneJson || '{}'));
      return payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
    } catch {
      return {};
    }
  }

  function folderDeleteRequestRowToCompanionRow(row = {}) {
    const payload = parseFolderDeleteRequestPayload(row);
    const folderId = String(payload.folderId || folderIdFromDeleteRequestReview(row) || row.folderId || row.id || '').trim();
    if (!folderId) return null;
    const folderName = String(payload.folderName || payload.name || row.folderName || row.name || folderId).trim();
    return {
      schema: 'h2o.studio.chrome-folder-pending-delete-request-row.v1',
      id: folderId,
      folderId,
      name: folderName,
      folderName,
      status: 'pending-delete',
      companionStatusLabel: 'Delete pending',
      source: 'chrome-folder-delete-request-store',
      sourceKind: 'chrome-pending-soft-delete-request',
      requestId: String(payload.requestId || payload.reviewId || row.reviewId || '').trim(),
      reviewId: String(row.reviewId || payload.reviewId || payload.requestId || '').trim(),
      requestedAt: String(payload.requestedAt || row.receivedAt || row.firstSeenAt || '').trim(),
      pendingDeleteRequest: true,
      pendingDeleteHidden: false,
      visibleStateOnly: true,
      desktopAuthorityRequired: true,
      noTombstoneApplyOnChrome: true,
      noChromeTombstoneApply: true,
      noHardDelete: true,
      noPurge: true,
      noChatDelete: true,
      noSnapshotDelete: true,
      noAssetDelete: true,
    };
  }

  async function loadPendingChromeFolderDeleteRequestRows() {
    if (studioPlatformAdapter() !== 'mv3') return [];
    try {
      const store = W.H2O?.Studio?.store?.tombstoneReviews;
      const rows = typeof store?.listFolderDeleteRequests === 'function'
        ? await store.listFolderDeleteRequests({ status: 'pending', limit: 1000 })
        : [];
      return (Array.isArray(rows) ? rows : []).map(folderDeleteRequestRowToCompanionRow).filter(Boolean);
    } catch (e) {
      err('folderDeleteRequest.loadPendingRows', e);
      return [];
    }
  }

  async function loadPendingChromeFolderDeleteRequestIds() {
    if (studioPlatformAdapter() !== 'mv3') return FOLDER_DELETE_REQUEST_UI_STATE.pendingFolderIds;
    try {
      const store = W.H2O?.Studio?.store?.tombstoneReviews;
      const rows = typeof store?.listFolderDeleteRequests === 'function'
        ? await store.listFolderDeleteRequests({ status: 'pending', limit: 1000 })
        : [];
      const next = new Set((Array.isArray(rows) ? rows : [])
        .map(folderIdFromDeleteRequestReview)
        .filter(Boolean));
      FOLDER_DELETE_REQUEST_UI_STATE.pendingFolderIds = next;
      FOLDER_DELETE_REQUEST_UI_STATE.lastLoadedAt = Date.now();
      return next;
    } catch (e) {
      err('folderDeleteRequest.loadPending', e);
      return FOLDER_DELETE_REQUEST_UI_STATE.pendingFolderIds;
    }
  }

  async function requestChromeFolderDelete(item, controls = {}) {
    const setStatus = typeof controls.setStatus === 'function' ? controls.setStatus : () => {};
    const blocker = chromeFolderDeleteRequestBlocker(item);
    if (blocker) {
      setStatus(`Blocked: ${blocker}`, 'blocked');
      return { ok: false, status: blocker, blockers: [blocker] };
    }
    const folderId = String(item?.id || item?.folderId || '').trim();
    setStatus('Requesting Desktop review...', 'pending');
    let result = null;
    try {
      const commandPayload = folderCommandPayload(item, {
        folderId,
        folderName: String(item?.name || item?.title || '').trim(),
        sourceSurface: 'chrome-studio',
        reason: 'user-requested-folder-delete',
      });
      result = await executeFolderBusinessCommand('delete', commandPayload, item);
      if (shouldUseLegacyFolderAdapter(result)) {
        const actions = chromeFolderDeleteRequestActions();
        const store = W.H2O?.Studio?.store?.tombstoneReviews;
        const requestFn = typeof actions?.requestDelete === 'function'
          ? actions.requestDelete.bind(actions)
          : (typeof store?.requestFolderDelete === 'function' ? store.requestFolderDelete.bind(store) : null);
        if (!requestFn) {
          setStatus('Blocked: tombstone-review-store-unavailable', 'blocked');
          return { ok: false, status: 'tombstone-review-store-unavailable', blockers: ['tombstone-review-store-unavailable'] };
        }
        result = await requestFn(commandPayload, {
          sourceSurface: 'chrome-studio',
          reason: 'user-requested-folder-delete',
        });
      }
    } catch (e) {
      err('folderDeleteRequest.request', e);
      setStatus(`Blocked: ${String(e?.message || e || 'request-failed')}`, 'blocked');
      return { ok: false, status: 'folder-delete-request-threw', blockers: ['folder-delete-request-threw'] };
    }
    if (!result?.ok) {
      const code = firstResultCode(result, String(result?.status || 'folder-delete-request-failed'));
      setStatus(`Blocked: ${code}`, 'blocked');
      return result || { ok: false, status: code, blockers: [code] };
    }
    FOLDER_DELETE_REQUEST_UI_STATE.pendingFolderIds.add(folderId);
    const hideResult = await markChromeFolderPendingDeleteHidden(item, result);
    setStatus('');
    if (hideResult?.ok === true) {
      try { navigateAfterDeletedFolder(folderId); } catch {}
      try { closeRowMenu(); } catch {}
    }
    W.requestAnimationFrame(() => {
      try { renderFolders(); } catch (e) { err('folderDeleteRequest.renderPending', e); }
    });
    return Object.assign({}, result, {
      chromePendingDeleteHidden: hideResult?.ok === true,
      hiddenByChromePendingDelete: hideResult?.ok === true,
      visibleStateOnly: true,
      noTombstoneApplyOnChrome: true,
      noHardDelete: true,
      noPurge: true,
      noChatDelete: true,
      noSnapshotDelete: true,
      noAssetDelete: true,
    });
  }

  function navigateAfterDeletedFolder(folderId) {
    const id = String(folderId || '').trim();
    if (!id) return;
    const rawHash = String(W.location?.hash || '');
    const encodedId = encodeURIComponent(id);
    let decodedHash = rawHash;
    try { decodedHash = decodeURIComponent(rawHash); } catch {}
    const pointsToDeletedFolder = rawHash.includes(`/folder/${encodedId}`)
      || rawHash.includes(`folder=${encodedId}`)
      || decodedHash.includes(`/folder/${id}`)
      || decodedHash.includes(`folder=${id}`);
    if (pointsToDeletedFolder) W.location.hash = '#/library/folders';
  }

  function refreshNativeFolderState(reason = 'folder-metadata-apply') {
    const sync = W.H2O?.Library?.Sync || W.H2O?.Studio?.sync || {};
    const fn = typeof sync.refreshNativeFolderState === 'function'
      ? sync.refreshNativeFolderState
      : (typeof sync.refreshNativeBroadcast === 'function' ? sync.refreshNativeBroadcast : null);
    if (typeof fn !== 'function') return null;
    try {
      return fn.call(sync, reason);
    } catch (e) {
      err('refreshNativeFolderState.call', e);
      return null;
    }
  }

  function refreshAfterNativeFolderMetadataApply(reason = 'folder-metadata-apply') {
    let refreshed = false;
    try {
      const result = refreshNativeFolderState(reason);
      if (result && typeof result.finally === 'function') {
        refreshed = true;
        result.finally(() => {
          try { renderAllSections(); } catch (e) { err('renderAfterFolderMetadataApply', e); }
        });
      }
    } catch (e) { err('refreshNativeFolderState.folderMetadataApply', e); }
    if (!refreshed) {
      W.setTimeout(() => {
        try { renderAllSections(); } catch (e) { err('renderAfterFolderMetadataApply.timeout', e); }
      }, 650);
    }
  }

  function refreshAfterNativeFolderColorApply() {
    refreshAfterNativeFolderMetadataApply('folder-color-apply');
  }

  async function requestFolderMetadataOperationWithNativeRefresh(request, operation, options = {}) {
    const opts = options && typeof options === 'object' ? options : {};
    const pollReason = String(opts.pollReason || 'folder-metadata-result-poll');
    let stopped = false;
    let polling = false;
    const poll = () => {
      if (stopped || polling) return;
      const result = refreshNativeFolderState(pollReason);
      if (result && typeof result.finally === 'function') {
        polling = true;
        result.finally(() => { polling = false; });
      }
    };
    const timer = W.setInterval(poll, FOLDER_METADATA_RENAME_POLL_MS);
    W.setTimeout(poll, Math.min(250, FOLDER_METADATA_RENAME_POLL_MS));
    try {
      return await request(operation, opts);
    } finally {
      stopped = true;
      try { W.clearInterval(timer); } catch {}
    }
  }

  function resultHasBlocker(result, code) {
    return resultCodes(result, 'blockers').includes(String(code || '').trim());
  }

  function summarizeFolderMetadataResult(result) {
    if (!result || typeof result !== 'object') return null;
    return {
      requestId: String(result.requestId || ''),
      requestMode: String(result.requestMode || ''),
      operationType: String(result.operationType || ''),
      folderId: String(result.folderId || result.after?.folderId || result.after?.id || ''),
      ok: result.ok === true,
      applied: result.applied === true,
      canApply: result.canApply === true,
      blockers: resultCodes(result, 'blockers').slice(0, 8),
      warnings: resultCodes(result, 'warnings').slice(0, 8),
      afterName: String(result.after?.name || result.proposed?.folderName || ''),
    };
  }

  function recordFolderCreateFlow(stage, patch = {}) {
    FOLDER_CREATE_FLOW_STATE.lastAt = Date.now();
    FOLDER_CREATE_FLOW_STATE.lastStage = String(stage || '');
    Object.assign(FOLDER_CREATE_FLOW_STATE, patch);
  }

  function canApplyFolderCreatePreview(preview, name = '') {
    if (!preview || typeof preview !== 'object') return false;
    if (resultCodes(preview, 'blockers').length) return false;
    const opType = String(preview.operationType || 'create-folder').trim();
    if (opType && opType !== 'create-folder') return false;
    const previewName = normalizeFolderCreateInput(preview.after?.name || preview.proposed?.folderName || name);
    if (!previewName) return false;
    return preview.canApply === true || preview.ok === true || preview.readOnly === true;
  }

  function waitMs(ms) {
    return new Promise((resolve) => W.setTimeout(resolve, Math.max(0, Number(ms) || 0)));
  }

  async function recoverCreatedFolderFromNativeState(name, reason = 'folder-create-recover') {
    const targetName = normalizeFolderCreateInput(name);
    if (!targetName) return null;
    for (let attempt = 0; attempt < FOLDER_METADATA_CREATE_RECOVERY_ATTEMPTS; attempt += 1) {
      try {
        const refresh = refreshNativeFolderState(`${reason}:${attempt + 1}`);
        if (refresh && typeof refresh.then === 'function') await refresh;
      } catch (e) {
        err('folderCreate.recover.refresh', e);
      }
      const fresh = await resolveFreshCanonicalFolderItemByName(targetName);
      if (fresh?.folderId) return fresh;
      await waitMs(FOLDER_METADATA_CREATE_RECOVERY_DELAY_MS);
    }
    return null;
  }

  async function requestCanonicalFolderColor(item, color, controls = {}) {
    const setStatus = typeof controls.setStatus === 'function' ? controls.setStatus : () => {};
    if (canUseDesktopFolderEditor('color')) {
      const folderId = String(item?.id || item?.folderId || '').trim();
      if (!folderId || item?.isCanonical !== true) {
        setStatus('Blocked: target-not-canonical', 'blocked');
        return { ok: false, status: 'target-not-canonical' };
      }
      const nextColor = normalizeHexColor(color || '');
      setStatus('Applying...', 'pending');
      const result = await executeFolderBusinessCommand('color', folderCommandPayload(item, { folderId, color: nextColor, iconColor: nextColor }), item);
      if (result?.ok) {
        const confirmation = await confirmFreshCanonicalFolderColor(folderId, nextColor);
        if (confirmation.ok) {
          setStatus(nextColor ? 'Color updated' : 'Color cleared', 'ok');
          refreshAfterNativeFolderMetadataApply('desktop-folder-color-confirmed');
          return { ...result, applied: true, displayConfirmation: confirmation };
        }
        setStatus(`Blocked: ${confirmation.status || 'display-color-not-confirmed'}`, 'blocked');
        return {
          ...result,
          ok: false,
          applied: false,
          persistenceOk: true,
          status: confirmation.status || 'display-color-not-confirmed',
          displayConfirmation: confirmation,
        };
      }
      setStatus(`Blocked: ${String(result?.status || result?.reason || 'desktop-color-failed')}`, 'blocked');
      return result;
    }
    const request = folderMetadataOperationRequest();
    if (!request || studioPlatformAdapter() !== 'mv3') {
      setStatus('Blocked: native-owner-bridge-unavailable', 'blocked');
      return { ok: false, blockers: [{ code: 'native-owner-bridge-unavailable' }] };
    }
    const folderId = String(item?.id || item?.folderId || '').trim();
    if (!folderId || item?.isCanonical !== true) {
      setStatus('Blocked: target-not-canonical', 'blocked');
      return { ok: false, blockers: [{ code: 'target-not-canonical' }] };
    }

    const nextColor = normalizeHexColor(color || '');
    const commandAttempt = await executeFolderBusinessCommand('color', folderCommandPayload(item, { folderId, color: nextColor, iconColor: nextColor }), item);
    if (!shouldUseLegacyFolderAdapter(commandAttempt)) {
      if (!commandAttempt?.ok) {
        setStatus(`Blocked: ${String(commandAttempt?.status || commandAttempt?.reason || 'folder-color-command-failed')}`, 'blocked');
        return commandAttempt;
      }
      refreshAfterNativeFolderColorApply();
      const confirmation = await confirmFreshCanonicalFolderColor(folderId, nextColor);
      if (confirmation.ok) {
        setStatus(nextColor ? 'Color updated' : 'Color cleared', 'ok');
        return { ...commandAttempt, applied: true, displayConfirmation: confirmation };
      }
      setStatus(`Blocked: ${confirmation.status || 'display-color-not-confirmed'}`, 'blocked');
      return { ...commandAttempt, ok: false, applied: false, status: confirmation.status || 'display-color-not-confirmed', displayConfirmation: confirmation };
    }
    // Current MV3 physical apply remains the existing Sync/Host adapter until T04.
    const operation = buildFolderColorOperation(item, nextColor);
    setStatus('Previewing...', 'pending');
    let preview = null;
    try {
      preview = await request(operation, {
        requestMode: 'preview',
        timeoutMs: FOLDER_METADATA_COLOR_TIMEOUT_MS,
      });
    } catch (e) {
      err('folderColor.preview', e);
      setStatus(`Blocked: ${String(e?.message || e || 'preview-failed')}`, 'blocked');
      return { ok: false, blockers: [{ code: 'preview-request-threw' }] };
    }

    const previewBlocker = resultCodes(preview, 'blockers')[0];
    if (!preview?.ok || previewBlocker) {
      setStatus(`Blocked: ${previewBlocker || firstResultCode(preview)}`, 'blocked');
      return preview;
    }
    if (resultCodes(preview, 'warnings').includes('no-op-color-unchanged')) {
      setStatus('Color already current', 'ok');
      return preview;
    }
    if (preview.canApply !== true) {
      setStatus('Blocked: preview-not-applyable', 'blocked');
      return preview;
    }

    setStatus('Applying...', 'pending');
    let applied = null;
    try {
      applied = await request(buildFolderColorOperation(item, nextColor, staleGuardFromPreview(preview)), {
        requestMode: 'apply',
        timeoutMs: FOLDER_METADATA_COLOR_TIMEOUT_MS,
      });
    } catch (e) {
      err('folderColor.apply', e);
      setStatus(`Blocked: ${String(e?.message || e || 'apply-failed')}`, 'blocked');
      return { ok: false, blockers: [{ code: 'apply-request-threw' }] };
    }

    const applyBlocker = resultCodes(applied, 'blockers')[0];
    if (!applied?.ok || applyBlocker) {
      setStatus(`Blocked: ${applyBlocker || firstResultCode(applied, 'apply-failed')}`, 'blocked');
      return applied;
    }
    if (applied.applied !== true) {
      if (resultCodes(applied, 'warnings').includes('no-op-color-unchanged')) {
        setStatus('Color already current', 'ok');
      } else {
        setStatus('Color unchanged', 'ok');
      }
      return applied;
    }
    refreshAfterNativeFolderColorApply();
    try { renderAllSections(); } catch (e) { err('folderColor.renderBeforeConfirm', e); }
    const confirmation = await confirmFreshCanonicalFolderColor(folderId, nextColor);
    if (confirmation.ok) {
      setStatus(nextColor ? 'Color updated' : 'Color cleared', 'ok');
      return { ...applied, displayConfirmation: confirmation };
    }
    setStatus(`Blocked: ${confirmation.status || 'display-color-not-confirmed'}`, 'blocked');
    return {
      ...applied,
      ok: false,
      applied: false,
      persistenceOk: true,
      status: confirmation.status || 'display-color-not-confirmed',
      displayConfirmation: confirmation,
    };
  }

  async function requestCanonicalFolderCreate(name, controls = {}) {
    const setStatus = typeof controls.setStatus === 'function' ? controls.setStatus : () => {};
    const nextName = normalizeFolderCreateInput(name);
    if (!nextName) {
      setStatus('Blocked: invalid-folder-name', 'blocked');
      return { ok: false, blockers: [{ code: 'invalid-folder-name' }] };
    }
    if (canUseDesktopFolderEditor('create')) {
      recordFolderCreateFlow('desktop-create-start', {
        lastName: nextName,
        lastStatus: 'desktop-creating',
        lastPreview: null,
        lastApply: null,
        lastError: '',
      });
      setStatus('Creating...', 'pending');
      const result = await executeFolderBusinessCommand('create', { name: nextName });
      recordFolderCreateFlow(result?.ok ? 'desktop-created' : 'desktop-create-blocked', {
        lastStatus: result?.ok ? 'created' : String(result?.status || 'desktop-create-blocked'),
        lastApply: result && typeof result === 'object' ? { ok: result.ok === true, status: String(result.status || ''), folderId: String(result.folderId || '') } : null,
      });
      if (result?.ok) {
        setStatus('Folder created', 'ok');
        return { ...result, applied: true };
      }
      setStatus(`Blocked: ${String(result?.status || result?.reason || 'desktop-create-failed')}`, 'blocked');
      return result;
    }
    const request = folderMetadataOperationRequest();
    if (!request || studioPlatformAdapter() !== 'mv3') {
      setStatus('Blocked: native-owner-bridge-unavailable', 'blocked');
      return { ok: false, blockers: [{ code: 'native-owner-bridge-unavailable' }] };
    }

    const commandAttempt = await executeFolderBusinessCommand('create', { name: nextName });
    if (!shouldUseLegacyFolderAdapter(commandAttempt)) {
      recordFolderCreateFlow(commandAttempt?.ok ? 'created' : 'command-blocked', {
        lastName: nextName,
        lastStatus: String(commandAttempt?.status || (commandAttempt?.ok ? 'created' : 'folder-create-command-failed')),
        lastApply: commandAttempt && typeof commandAttempt === 'object' ? { ok: commandAttempt.ok === true, status: String(commandAttempt.status || ''), folderId: String(commandAttempt.folderId || '') } : null,
      });
      if (commandAttempt?.ok) {
        setStatus('Folder created', 'ok');
        refreshAfterNativeFolderMetadataApply('folder-create-command');
        return { ...commandAttempt, applied: commandAttempt.applied !== false };
      }
      setStatus(`Blocked: ${String(commandAttempt?.status || commandAttempt?.reason || 'folder-create-command-failed')}`, 'blocked');
      return commandAttempt;
    }
    // Current MV3 physical apply remains the existing Sync/Host adapter until T04.
    const operation = buildFolderCreateOperation(nextName);
    recordFolderCreateFlow('preview-start', {
      lastName: nextName,
      lastStatus: 'previewing',
      lastPreview: null,
      lastApply: null,
      lastError: '',
    });
    setStatus('Previewing...', 'pending');
    let preview = null;
    const requestCreatePreview = () => requestFolderMetadataOperationWithNativeRefresh(request, operation, {
      requestMode: 'preview',
      timeoutMs: FOLDER_METADATA_CREATE_TIMEOUT_MS,
      pollReason: 'folder-create-preview-result-poll',
    });
    try {
      preview = await requestCreatePreview();
      if (resultHasBlocker(preview, 'native-owner-timeout')) {
        recordFolderCreateFlow('preview-timeout-retry', {
          lastPreview: summarizeFolderMetadataResult(preview),
          lastStatus: 'preview-timeout-retry',
        });
        setStatus('Previewing...', 'pending');
        preview = await requestCreatePreview();
      }
    } catch (e) {
      err('folderCreate.preview', e);
      recordFolderCreateFlow('preview-error', {
        lastStatus: 'preview-error',
        lastError: String(e?.message || e || 'preview-failed'),
      });
      setStatus(`Blocked: ${String(e?.message || e || 'preview-failed')}`, 'blocked');
      return { ok: false, blockers: [{ code: 'preview-request-threw' }] };
    }
    recordFolderCreateFlow('preview-result', {
      lastStatus: 'preview-result',
      lastPreview: summarizeFolderMetadataResult(preview),
    });

    const previewBlocker = resultCodes(preview, 'blockers')[0];
    const previewSucceeded = preview?.ok === true || canApplyFolderCreatePreview(preview, nextName);
    if (!previewSucceeded || previewBlocker) {
      recordFolderCreateFlow('preview-blocked', {
        lastStatus: 'preview-blocked',
        lastPreview: summarizeFolderMetadataResult(preview),
      });
      setStatus(`Blocked: ${previewBlocker || firstResultCode(preview, 'folder-create-preview-failed')}`, 'blocked');
      return preview;
    }
    if (!canApplyFolderCreatePreview(preview, nextName)) {
      recordFolderCreateFlow('preview-not-applyable', {
        lastStatus: 'preview-not-applyable',
        lastPreview: summarizeFolderMetadataResult(preview),
      });
      setStatus('Blocked: preview-not-applyable', 'blocked');
      return preview;
    }

    recordFolderCreateFlow('apply-start', {
      lastStatus: 'applying',
      lastPreview: summarizeFolderMetadataResult(preview),
    });
    setStatus('Creating...', 'pending');
    let applied = null;
    try {
      applied = await requestFolderMetadataOperationWithNativeRefresh(request, buildFolderCreateOperation(nextName, staleGuardFromPreview(preview)), {
        requestMode: 'apply',
        timeoutMs: FOLDER_METADATA_CREATE_TIMEOUT_MS,
        pollReason: 'folder-create-apply-result-poll',
      });
    } catch (e) {
      err('folderCreate.apply', e);
      recordFolderCreateFlow('apply-error', {
        lastStatus: 'apply-error',
        lastError: String(e?.message || e || 'apply-failed'),
      });
      setStatus(`Blocked: ${String(e?.message || e || 'apply-failed')}`, 'blocked');
      return { ok: false, blockers: [{ code: 'apply-request-threw' }] };
    }
    recordFolderCreateFlow('apply-result', {
      lastStatus: 'apply-result',
      lastApply: summarizeFolderMetadataResult(applied),
    });

    if (resultHasBlocker(applied, 'native-owner-timeout')) {
      setStatus('Creating...', 'pending');
      const recovered = await recoverCreatedFolderFromNativeState(nextName, 'folder-create-apply-timeout-recover');
      if (recovered?.folderId) {
        applied = {
          schema: 'h2o.folder-metadata-operation-result.v1',
          requestId: String(applied?.requestId || ''),
          requestMode: 'apply',
          ok: true,
          applied: true,
          noMutation: false,
          writesPerformed: 1,
          operationType: 'create-folder',
          folderId: recovered.folderId,
          before: preview.before || null,
          after: recovered,
          blockers: [],
          warnings: [{ code: 'folder-create-result-recovered-from-canonical-state' }],
        };
        recordFolderCreateFlow('apply-recovered', {
          lastStatus: 'apply-recovered',
          lastApply: summarizeFolderMetadataResult(applied),
        });
      }
    }

    const applyBlocker = resultCodes(applied, 'blockers')[0];
    if (!applied?.ok || applyBlocker) {
      recordFolderCreateFlow('apply-blocked', {
        lastStatus: 'apply-blocked',
        lastApply: summarizeFolderMetadataResult(applied),
      });
      setStatus(`Blocked: ${applyBlocker || firstResultCode(applied, 'folder-create-apply-failed')}`, 'blocked');
      return applied;
    }
    if (applied.applied !== true) {
      recordFolderCreateFlow('apply-not-created', {
        lastStatus: 'apply-not-created',
        lastApply: summarizeFolderMetadataResult(applied),
      });
      setStatus('Folder not created', 'blocked');
      return applied;
    }
    recordFolderCreateFlow('created', {
      lastStatus: 'created',
      lastApply: summarizeFolderMetadataResult(applied),
    });
    setStatus('Folder created', 'ok');
    refreshAfterNativeFolderMetadataApply('folder-create-apply');
    W.setTimeout(() => {
      try { renderAllSections(); } catch (e) { err('folderCreate.renderAfterApply', e); }
    }, 250);
    return applied;
  }

  async function requestDesktopFolderEditor(mode, item = {}, options = {}) {
    const modals = desktopFolderEditor();
    if (!modals) return { ok: false, status: 'desktop-folder-editor-unavailable' };
    const folderId = String(item?.id || item?.folderId || '').trim();
    const payload = {
      mode,
      folderId,
      anchorEl: options.anchorEl || null,
    };
    if (Object.prototype.hasOwnProperty.call(options, 'name')) payload.name = String(options.name || '').trim();
    if (Object.prototype.hasOwnProperty.call(options, 'color')) {
      payload.color = normalizeHexColor(options.color || '');
      payload.iconColor = Object.prototype.hasOwnProperty.call(options, 'iconColor')
        ? normalizeHexColor(options.iconColor || '')
        : normalizeHexColor(options.color || '');
    }
    let result = null;
    try {
      result = await modals.openFolderEditor(payload);
    } catch (e) {
      err(`desktopFolderEditor.${mode}`, e);
      return { ok: false, status: `${mode || 'folder'}-failed`, reason: String(e?.message || e || '') };
    }
    if (result?.ok) {
      scheduleDesktopFolderEditorAutoExport(mode, result.folderId || result.result?.folderId || folderId);
      refreshAfterNativeFolderMetadataApply(`desktop-folder-${mode || 'edit'}`);
      W.setTimeout(() => {
        try { renderAllSections(); } catch (e) { err('desktopFolderEditor.renderAfterApply', e); }
      }, 250);
    }
    return result || { ok: false, status: `${mode || 'folder'}-no-result` };
  }

  async function requestCanonicalFolderRename(item, name, controls = {}) {
    const setStatus = typeof controls.setStatus === 'function' ? controls.setStatus : () => {};
    const folderId = String(item?.id || item?.folderId || '').trim();
    if (!folderId || item?.isCanonical !== true) {
      setStatus('Blocked: target-not-canonical', 'blocked');
      return { ok: false, blockers: [{ code: 'target-not-canonical' }] };
    }
    const nextName = normalizeFolderRenameInput(name);
    if (!nextName) {
      setStatus('Blocked: invalid-folder-name', 'blocked');
      return { ok: false, blockers: [{ code: 'invalid-folder-name' }] };
    }
    if (canUseDesktopFolderEditor('rename')) {
      setStatus('Renaming...', 'pending');
      const result = await executeFolderBusinessCommand('rename', folderCommandPayload(item, { folderId, name: nextName }), item);
      if (result?.ok) {
        setStatus('Folder renamed', 'ok');
        return { ...result, applied: true, after: { folderId, name: result.name || nextName } };
      }
      setStatus(`Blocked: ${String(result?.status || result?.reason || 'desktop-rename-failed')}`, 'blocked');
      return result;
    }
    const request = folderMetadataOperationRequest();
    if (!request || studioPlatformAdapter() !== 'mv3') {
      setStatus('Blocked: native-owner-bridge-unavailable', 'blocked');
      return { ok: false, blockers: [{ code: 'native-owner-bridge-unavailable' }] };
    }
    const freshItem = await resolveFreshCanonicalFolderItem(item);
    const requestItem = freshItem || item;
    const currentName = normalizeFolderRenameInput(requestItem?.name || requestItem?.title || '');
    if (currentName && nextName === currentName) {
      setStatus('Name already current', 'ok');
      return { ok: true, applied: false, noMutation: true, warnings: [{ code: 'no-op-name-unchanged' }] };
    }

    const commandAttempt = await executeFolderBusinessCommand('rename', folderCommandPayload(requestItem, { folderId, name: nextName }), item);
    if (!shouldUseLegacyFolderAdapter(commandAttempt)) {
      if (commandAttempt?.ok) {
        setStatus('Folder renamed', 'ok');
        refreshAfterNativeFolderMetadataApply('folder-rename-command');
        return { ...commandAttempt, applied: commandAttempt.applied !== false, after: { ...(commandAttempt.after || {}), folderId, name: commandAttempt.name || nextName } };
      }
      setStatus(`Blocked: ${String(commandAttempt?.status || commandAttempt?.reason || 'folder-rename-command-failed')}`, 'blocked');
      return commandAttempt;
    }
    // Current MV3 physical apply remains the existing Sync/Host adapter until T04.
    const operation = buildFolderRenameOperation(requestItem, nextName);
    setStatus('Previewing...', 'pending');
    let preview = null;
    try {
      preview = await requestFolderMetadataOperationWithNativeRefresh(request, operation, {
        requestMode: 'preview',
        timeoutMs: FOLDER_METADATA_COLOR_TIMEOUT_MS,
        pollReason: 'folder-rename-preview-result-poll',
      });
    } catch (e) {
      err('folderRename.preview', e);
      setStatus(`Blocked: ${String(e?.message || e || 'preview-failed')}`, 'blocked');
      return { ok: false, blockers: [{ code: 'preview-request-threw' }] };
    }

    const previewBlocker = resultCodes(preview, 'blockers')[0];
    if (!preview?.ok || previewBlocker) {
      setStatus(`Blocked: ${previewBlocker || firstResultCode(preview, 'folder-rename-preview-failed')}`, 'blocked');
      return preview;
    }
    if (resultCodes(preview, 'warnings').includes('no-op-name-unchanged')) {
      setStatus('Name already current', 'ok');
      return preview;
    }
    if (preview.canApply !== true) {
      setStatus('Blocked: preview-not-applyable', 'blocked');
      return preview;
    }

    setStatus('Applying...', 'pending');
    let applied = null;
    try {
      applied = await requestFolderMetadataOperationWithNativeRefresh(request, buildFolderRenameOperation(requestItem, nextName, staleGuardFromPreview(preview)), {
        requestMode: 'apply',
        timeoutMs: FOLDER_METADATA_COLOR_TIMEOUT_MS,
        pollReason: 'folder-rename-apply-result-poll',
      });
    } catch (e) {
      err('folderRename.apply', e);
      setStatus(`Blocked: ${String(e?.message || e || 'apply-failed')}`, 'blocked');
      return { ok: false, blockers: [{ code: 'apply-request-threw' }] };
    }

    const applyBlocker = resultCodes(applied, 'blockers')[0];
    if (!applied?.ok || applyBlocker) {
      setStatus(`Blocked: ${applyBlocker || firstResultCode(applied, 'folder-rename-apply-failed')}`, 'blocked');
      return applied;
    }
    if (applied.applied !== true) {
      if (resultCodes(applied, 'warnings').includes('no-op-name-unchanged')) {
        setStatus('Name already current', 'ok');
      } else {
        setStatus('Folder name unchanged', 'ok');
      }
      return applied;
    }
    setStatus('Folder renamed', 'ok');
    refreshAfterNativeFolderMetadataApply('folder-rename-apply');
    return applied;
  }

  async function requestCanonicalFolderDeletePreview(item, controls = {}) {
    const setStatus = typeof controls.setStatus === 'function' ? controls.setStatus : () => {};
    const request = folderMetadataOperationRequest();
    if (!request || studioPlatformAdapter() !== 'mv3') {
      setStatus('Native owner unavailable', 'blocked');
      return { ok: false, blockers: [{ code: 'native-owner-bridge-unavailable' }] };
    }
    const folderId = String(item?.id || item?.folderId || '').trim();
    if (!folderId || item?.isCanonical !== true) {
      setStatus('Blocked: target-not-canonical', 'blocked');
      return { ok: false, blockers: [{ code: 'target-not-canonical' }] };
    }

    const operation = buildFolderDeletePreviewOperation(item);
    setStatus('Previewing...', 'pending');
    let preview = null;
    try {
      preview = await requestFolderMetadataOperationWithNativeRefresh(request, operation, {
        requestMode: 'preview',
        timeoutMs: FOLDER_METADATA_COLOR_TIMEOUT_MS,
        pollReason: 'folder-delete-preview-result-poll',
      });
    } catch (e) {
      err('folderDelete.preview', e);
      setStatus(`Blocked: ${String(e?.message || e || 'preview-failed')}`, 'blocked');
      return { ok: false, blockers: [{ code: 'preview-request-threw' }] };
    }

    const blockers = resultCodes(preview, 'blockers');
    const hardBlockers = deletePreviewHardBlockers(preview);
    if (!preview || typeof preview !== 'object') {
      setStatus('Blocked: folder-delete-preview-failed', 'blocked');
      return preview;
    }
    if (!preview.ok && !blockers.includes('delete-confirmation-required') && !hardBlockers.length) {
      setStatus('Blocked: folder-delete-preview-failed', 'blocked');
      return preview;
    }
    if (!preview?.ok && hardBlockers.length) {
      setStatus(`Blocked: ${hardBlockers[0] || firstResultCode(preview, 'folder-delete-preview-failed')}`, 'blocked');
      return preview;
    }
    if (blockers.includes('delete-non-empty-folder-blocked')) {
      setStatus('Blocked: delete-non-empty-folder-blocked', 'blocked');
    } else if (hardBlockers.length) {
      setStatus(`Blocked: ${hardBlockers[0]}`, 'blocked');
    } else if (blockers.includes('delete-confirmation-required')) {
      setStatus('Type DELETE EMPTY FOLDER to enable delete', 'pending');
    } else {
      setStatus('Preview ready', 'ok');
    }
    return preview;
  }

  async function requestCanonicalFolderDeleteApply(item, preview, confirmation, controls = {}) {
    const setStatus = typeof controls.setStatus === 'function' ? controls.setStatus : () => {};
    const onPreview = typeof controls.onPreview === 'function' ? controls.onPreview : () => {};
    const request = folderMetadataOperationRequest();
    if (!request || studioPlatformAdapter() !== 'mv3') {
      setStatus('Blocked: native-owner-bridge-unavailable', 'blocked');
      return { ok: false, blockers: [{ code: 'native-owner-bridge-unavailable' }] };
    }
    const folderId = String(item?.id || item?.folderId || '').trim();
    if (!folderId || item?.isCanonical !== true) {
      setStatus('Blocked: target-not-canonical', 'blocked');
      return { ok: false, blockers: [{ code: 'target-not-canonical' }] };
    }
    if (String(confirmation || '') !== FOLDER_METADATA_DELETE_CONFIRMATION_TEXT) {
      setStatus('Type DELETE EMPTY FOLDER to enable delete', 'blocked');
      return { ok: false, blockers: [{ code: 'delete-confirmation-required' }] };
    }

    let previewForApply = preview && typeof preview === 'object' ? preview : null;
    const previewAgeMs = Math.max(0, Date.now() - Number(controls.previewAt || 0));
    if (!previewForApply || !String(previewForApply.folderId || '').trim() || previewAgeMs > FOLDER_METADATA_DELETE_PREVIEW_MAX_AGE_MS) {
      previewForApply = await requestCanonicalFolderDeletePreview(item, { setStatus });
      onPreview(previewForApply);
    }

    const hardBlockers = deletePreviewHardBlockers(previewForApply);
    if (hardBlockers.length) {
      setStatus(`Blocked: ${hardBlockers[0]}`, 'blocked');
      return previewForApply;
    }
    if (!canApplyDeletePreview(previewForApply, item)) {
      const blocker = deletePreviewBlockers(previewForApply)[0] || 'delete-preview-not-applyable';
      setStatus(`Blocked: ${blocker}`, 'blocked');
      return previewForApply;
    }

    const operation = buildFolderDeleteOperation(item, staleGuardFromPreview(previewForApply), confirmation);
    setStatus('Applying...', 'pending');
    let applied = null;
    try {
      applied = await requestFolderMetadataOperationWithNativeRefresh(request, operation, {
        requestMode: 'apply',
        timeoutMs: FOLDER_METADATA_COLOR_TIMEOUT_MS,
        pollReason: 'folder-delete-apply-result-poll',
      });
    } catch (e) {
      err('folderDelete.apply', e);
      setStatus(`Blocked: ${String(e?.message || e || 'apply-failed')}`, 'blocked');
      return { ok: false, blockers: [{ code: 'apply-request-threw' }] };
    }

    const applyBlocker = resultCodes(applied, 'blockers')[0];
    if (!applied?.ok || applyBlocker) {
      setStatus(`Blocked: ${applyBlocker || firstResultCode(applied, 'folder-delete-apply-failed')}`, 'blocked');
      return applied;
    }
    if (applied.applied !== true) {
      setStatus('Folder delete not applied', 'blocked');
      return applied;
    }
    setStatus('Folder deleted', 'ok');
    navigateAfterDeletedFolder(folderId);
    refreshAfterNativeFolderMetadataApply('folder-delete-apply');
    W.setTimeout(() => {
      try { closeRowMenu(); } catch {}
      try { renderAllSections(); } catch (e) { err('folderDelete.renderAfterApply', e); }
    }, 250);
    return applied;
  }

  async function requestDesktopFolderSoftDelete(item, controls = {}) {
    const setStatus = typeof controls.setStatus === 'function' ? controls.setStatus : () => {};
    const folderId = String(item?.id || item?.folderId || '').trim();
    const uiBlocker = desktopFolderSoftDeleteBlocker(item);
    if (uiBlocker) {
      setStatus(`Blocked: ${uiBlocker}`, 'blocked');
      return { ok: false, blockers: [uiBlocker], status: uiBlocker };
    }
    if (!folderCommandAuthority()) {
      setStatus('Blocked: folder-command-contract-unavailable', 'blocked');
      return { ok: false, blockers: ['folder-command-contract-unavailable'], status: 'folder-command-contract-unavailable' };
    }
    setStatus('Moving...', 'pending');
    let result = null;
    try {
      result = await executeFolderBusinessCommand('delete', folderCommandPayload(item, { folderId }), item);
    } catch (e) {
      err('desktopFolderSoftDelete.apply', e);
      setStatus(`Blocked: ${String(e?.message || e || 'folder-soft-delete-failed')}`, 'blocked');
      return { ok: false, blockers: ['folder-soft-delete-threw'], status: 'folder-soft-delete-threw' };
    }
    const storeResult = result?.result && typeof result.result === 'object' ? result.result : result;
    const blockers = resultCodes(result, 'blockers').concat(resultCodes(storeResult, 'blockers'));
    const status = String(storeResult?.status || result?.status || '').trim();
    if (storeResult?.ok !== true && result?.ok !== true) {
      const blocker = blockers[0] || status || 'folder-soft-delete-failed';
      setStatus(`Blocked: ${blocker}`, 'blocked');
      return result || { ok: false, blockers: [blocker], status: blocker };
    }
    setStatus('Moved to Recently Deleted', 'ok');
    navigateAfterDeletedFolder(folderId);
    W.setTimeout(() => {
      try { closeRowMenu(); } catch {}
      try { renderAllSections(); } catch (e) { err('desktopFolderSoftDelete.renderAfterApply', e); }
    }, 180);
    return Object.assign({}, result || {}, {
      ok: true,
      applied: true,
      folderId,
      tombstoneId: storeResult?.tombstoneId || result?.tombstoneId || '',
      noHardDelete: true,
      noChatDelete: true,
      crossPlatformSync: 'deferred',
    });
  }

  function recentlyDeletedText(value, fallback = '—') {
    const text = String(value ?? '').trim();
    return text || fallback;
  }

  function recentlyDeletedDateText(value) {
    const text = String(value || '').trim();
    if (!text) return '—';
    const d = new Date(text);
    if (!Number.isFinite(d.getTime())) return text;
    try {
      return d.toLocaleString([], {
        year: 'numeric',
        month: 'short',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      });
    } catch {
      return text;
    }
  }

  function recentlyDeletedBoolLabel(value) {
    return value === true ? 'true' : 'false';
  }

  function recentlyDeletedAggregateValue(source, key, fallback = 0) {
    const nested = source?.recentlyDeletedDiagnostics && typeof source.recentlyDeletedDiagnostics === 'object'
      ? source.recentlyDeletedDiagnostics
      : {};
    const n = Number(source?.[key] ?? nested?.[key]);
    return Number.isFinite(n) ? n : fallback;
  }

  function recentlyDeletedRowsFromResult(result) {
    const nested = result?.recentlyDeletedDiagnostics && typeof result.recentlyDeletedDiagnostics === 'object'
      ? result.recentlyDeletedDiagnostics
      : {};
    const rows = result?.rows || result?.items || result?.list || nested?.rows || nested?.items || nested?.list;
    return Array.isArray(rows) ? rows : [];
  }

  async function restoreRecentlyDeletedFolder(row, controls = {}) {
    const setStatus = typeof controls.setStatus === 'function' ? controls.setStatus : () => {};
    const target = String(row?.tombstoneId || row?.folderId || row?.id || '').trim();
    if (!target) {
      setStatus('Blocked: folder identity missing', 'blocked');
      return { ok: false, status: 'folder-identity-missing', blockers: ['folder-identity-missing'] };
    }
    if (!folderCommandAuthority()) {
      setStatus('Restore deferred: Folder command authority unavailable', 'blocked');
      return { ok: false, status: 'folder-command-contract-unavailable', blockers: ['folder-command-contract-unavailable'] };
    }
    const name = recentlyDeletedText(row?.folderName || row?.name || row?.folderId, 'this folder');
    const confirmed = W.confirm?.(`Restore "${name}" from Recently Deleted?\n\nThis restores the folder metadata and eligible bindings. It does not purge, hard-delete, or delete chats.`);
    if (!confirmed) {
      setStatus('Restore cancelled', '');
      return { ok: false, status: 'restore-cancelled', blockers: [] };
    }
    setStatus('Restoring...', 'pending');
    try {
      const result = await executeFolderBusinessCommand('restore', { tombstoneId: target, folderId: String(row?.folderId || row?.id || '').trim(), source: 'desktop-recently-deleted-ui' }, row);
      if (result?.ok === true) {
        setStatus('Folder restored', 'ok');
        refreshAfterNativeFolderMetadataApply('folder-recently-deleted-restore');
      } else {
        const code = firstResultCode(result, String(result?.status || 'folder-restore-failed'));
        setStatus(`Blocked: ${code}`, 'blocked');
      }
      return result || { ok: false, status: 'folder-restore-failed', blockers: ['folder-restore-failed'] };
    } catch (e) {
      err('recentlyDeleted.restore', e);
      const message = String(e?.message || e || 'folder-restore-threw');
      setStatus(`Blocked: ${message}`, 'blocked');
      return { ok: false, status: 'folder-restore-threw', blockers: ['folder-restore-threw'], reason: message };
    }
  }

  async function permanentlyDeleteRecentlyDeletedFolders(controls = {}) {
    const setStatus = typeof controls.setStatus === 'function' ? controls.setStatus : () => {};
    const refreshPanel = typeof controls.refresh === 'function' ? controls.refresh : null;
    const store = desktopFolderStore();
    const previewFn = store?.previewRecentlyDeletedFolderPurge;
    const commitFn = store?.purgeRecentlyDeletedFolders;
    const reason = 'recently-deleted-ui-delete-permanently';
    const logPurgeStep = (step, details = {}) => {
      try {
        if (typeof console !== 'undefined' && typeof console.info === 'function') {
          console.info('[H2O.Studio.RecentlyDeleted.purge]', { step, ...details });
        }
      } catch (_) {}
    };
    if (!canUseDesktopFolderPurge() || typeof previewFn !== 'function' || typeof commitFn !== 'function') {
      setStatus('Delete permanently unavailable on this surface', 'blocked');
      return { ok: false, status: 'folder-purge-api-unavailable', blockers: ['folder-purge-api-unavailable'] };
    }
    setStatus('Checking purge candidates...', 'pending');
    let preview = null;
    try {
      preview = await previewFn.call(store, { reason });
      logPurgeStep('preview', {
        ok: preview?.ok === true,
        candidateCount: Number(preview?.candidateCount) || 0,
        tokenPresent: Boolean(preview?.confirmationToken || preview?.previewToken),
      });
    } catch (e) {
      err('recentlyDeleted.purgePreview', e);
      const message = String(e?.message || e || 'folder-purge-preview-threw');
      setStatus(`Blocked: ${message}`, 'blocked');
      return { ok: false, status: 'folder-purge-preview-threw', blockers: ['folder-purge-preview-threw'], reason: message };
    }
    if (preview?.ok !== true) {
      const code = firstResultCode(preview, String(preview?.status || 'folder-purge-preview-failed'));
      setStatus(`Blocked: ${code}`, 'blocked');
      return preview || { ok: false, status: 'folder-purge-preview-failed', blockers: ['folder-purge-preview-failed'] };
    }
    const expectedCount = Number(preview?.candidateCount) || 0;
    if (!expectedCount) {
      setStatus('No purge-eligible deleted folders', '');
      return preview;
    }
    const confirmationToken = String(preview?.confirmationToken || preview?.previewToken || '').trim();
    if (!confirmationToken) {
      setStatus('Delete permanently failed: preview token missing', 'blocked');
      return { ok: false, status: 'preview-token-missing', blockers: ['preview-token-missing'] };
    }
    const confirmText = [
      `Delete permanently ${formatNumber(expectedCount)} folder${expectedCount === 1 ? '' : 's'} from Recently Deleted?`,
      '',
      'Restore will no longer be possible for those folder tombstones.',
      'Chats, snapshots, assets, active folders, and receipts will not be deleted.',
    ].join('\n');
    if (typeof window === 'undefined' || typeof window.confirm !== 'function') {
      setStatus('Delete permanently failed: native confirmation unavailable', 'blocked');
      return { ok: false, status: 'native-confirm-unavailable', blockers: ['native-confirm-unavailable'] };
    }
    const confirmResult = window.confirm(confirmText);
    logPurgeStep('confirm', { confirmResult });
    if (confirmResult === false) {
      setStatus('Delete permanently cancelled.', '');
      return { ok: false, status: 'folder-purge-cancelled', blockers: [] };
    }
    setStatus('Deleting permanently...', 'pending');
    try {
      const result = await commitFn.call(store, {
        dryRun: false,
        confirmationToken,
        expectedCount,
        reason,
        confirmationPhrase: 'DELETE PERMANENTLY',
        confirmPhrase: 'DELETE PERMANENTLY',
        typedConfirmation: 'DELETE PERMANENTLY',
        deleteChats: false,
        deleteSnapshots: false,
        deleteAssets: false,
      });
      logPurgeStep('commit', {
        ok: result?.ok === true,
        status: String(result?.status || ''),
        purgedCount: Number(result?.purgedCount ?? result?.purgedTombstoneCount) || 0,
        blockers: Array.isArray(result?.blockers) ? result.blockers : [],
      });
      if (result?.ok === true) {
        const purged = Number(result?.purgedCount ?? result?.purgedTombstoneCount) || 0;
        const skipped = Number(result?.skippedCount) || 0;
        setStatus(
          `Deleted permanently: ${formatNumber(purged)} · skipped ${formatNumber(skipped)} · chats ${formatNumber(Number(result?.chatDeletedCount) || 0)} · snapshots ${formatNumber(Number(result?.snapshotDeletedCount) || 0)} · hard rows ${formatNumber(Number(result?.hardDeletedFolderRowCount) || 0)}`,
          'ok'
        );
        refreshAfterNativeFolderMetadataApply('folder-recently-deleted-purge');
        if (refreshPanel) {
          W.setTimeout(() => {
            try { refreshPanel(); } catch (e) { err('recentlyDeleted.purgeRefresh', e); }
          }, 250);
        }
      } else {
        const code = firstResultCode(result, String(result?.status || 'folder-purge-failed'));
        setStatus(`Delete permanently failed: ${code}`, 'blocked');
      }
      return result || { ok: false, status: 'folder-purge-failed', blockers: ['folder-purge-failed'] };
    } catch (e) {
      err('recentlyDeleted.purgeCommit', e);
      const message = String(e?.message || e || 'folder-purge-threw');
      setStatus(`Blocked: ${message}`, 'blocked');
      return { ok: false, status: 'folder-purge-threw', blockers: ['folder-purge-threw'], reason: message };
    }
  }

  async function clearRecentlyDeletedRestoredHistory(controls = {}) {
    const setStatus = typeof controls.setStatus === 'function' ? controls.setStatus : () => {};
    const refreshPanel = typeof controls.refresh === 'function' ? controls.refresh : null;
    const store = desktopFolderStore();
    const previewFn = store?.previewRecentlyDeletedRestoredHistoryClear;
    const commitFn = store?.clearRecentlyDeletedRestoredHistory;
    if (!canUseDesktopRestoredHistoryClear() || typeof previewFn !== 'function' || typeof commitFn !== 'function') {
      setStatus('Clear restored history unavailable on this surface', 'blocked');
      return { ok: false, status: 'folder-restored-history-clear-api-unavailable', blockers: ['folder-restored-history-clear-api-unavailable'] };
    }
    setStatus('Checking restored history...', 'pending');
    let preview = null;
    try {
      preview = await previewFn.call(store, { reason: 'desktop-recently-deleted-ui-restored-history-preview' });
    } catch (e) {
      err('recentlyDeleted.restoredHistoryPreview', e);
      const message = String(e?.message || e || 'folder-restored-history-clear-preview-threw');
      setStatus(`Blocked: ${message}`, 'blocked');
      return { ok: false, status: 'folder-restored-history-clear-preview-threw', blockers: ['folder-restored-history-clear-preview-threw'], reason: message };
    }
    if (preview?.ok !== true) {
      const code = firstResultCode(preview, String(preview?.status || 'folder-restored-history-clear-preview-failed'));
      setStatus(`Blocked: ${code}`, 'blocked');
      return preview || { ok: false, status: 'folder-restored-history-clear-preview-failed', blockers: ['folder-restored-history-clear-preview-failed'] };
    }
    const expectedCount = Number(preview?.restoredHistoryCandidateCount ?? preview?.candidateCount) || 0;
    if (!expectedCount) {
      setStatus('No restored history entries to clear', '');
      return preview;
    }
    const confirmText = [
      `Clear ${formatNumber(expectedCount)} restored histor${expectedCount === 1 ? 'y entry' : 'y entries'} from Recently Deleted?`,
      '',
      'This only removes restored/history entries from Recently Deleted.',
      'Folders, chats, snapshots, assets, active folders, and receipts will not be deleted.',
      '',
      'Type CLEAR RESTORED HISTORY to continue.',
    ].join('\n');
    const typed = String(W.prompt?.(confirmText, '') || '').trim();
    if (typed !== 'CLEAR RESTORED HISTORY') {
      setStatus('Clear restored history cancelled', '');
      return { ok: false, status: 'folder-restored-history-clear-cancelled', blockers: [] };
    }
    setStatus('Clearing restored history...', 'pending');
    try {
      const result = await commitFn.call(store, {
        dryRun: false,
        confirmationToken: preview.previewToken,
        expectedCount,
        confirmationPhrase: 'CLEAR RESTORED HISTORY',
        reason: 'desktop-recently-deleted-ui-clear-restored-history',
        deleteChats: false,
        deleteSnapshots: false,
        deleteAssets: false,
      });
      if (result?.ok === true) {
        const cleared = Number(result?.clearedCount) || 0;
        const skipped = Number(result?.skippedCount) || 0;
        setStatus(
          `Cleared restored history ${formatNumber(cleared)} · skipped ${formatNumber(skipped)} · chats ${formatNumber(Number(result?.chatDeletedCount) || 0)} · snapshots ${formatNumber(Number(result?.snapshotDeletedCount) || 0)} · hard rows ${formatNumber(Number(result?.hardDeletedFolderRowCount) || 0)}`,
          'ok'
        );
        refreshAfterNativeFolderMetadataApply('folder-recently-deleted-restored-history-clear');
        if (refreshPanel) {
          W.setTimeout(() => {
            try { refreshPanel(); } catch (e) { err('recentlyDeleted.restoredHistoryClearRefresh', e); }
          }, 250);
        }
      } else {
        const code = firstResultCode(result, String(result?.status || 'folder-restored-history-clear-failed'));
        setStatus(`Blocked: ${code}`, 'blocked');
      }
      return result || { ok: false, status: 'folder-restored-history-clear-failed', blockers: ['folder-restored-history-clear-failed'] };
    } catch (e) {
      err('recentlyDeleted.restoredHistoryCommit', e);
      const message = String(e?.message || e || 'folder-restored-history-clear-threw');
      setStatus(`Blocked: ${message}`, 'blocked');
      return { ok: false, status: 'folder-restored-history-clear-threw', blockers: ['folder-restored-history-clear-threw'], reason: message };
    }
  }

  async function renderRecentlyDeletedFoldersPanel(host, opts = {}) {
    if (!host || !canUseDesktopRecentlyDeletedFolders()) return;
    const placement = String(opts?.placement || '').trim() === 'main' ? 'main' : 'sidebar';
    const isMainPlacement = placement === 'main';
    if (isMainPlacement) host.innerHTML = '';
    const persistKey = 'h2o:studio:sidebar:recently-deleted-folders:expanded:v1';
    const details = el('details', {
      class: `wbFolderRecentlyDeleted${isMainPlacement ? ' wbFolderRecentlyDeleted--main' : ''}`,
      'data-h2o-recently-deleted-folders': isMainPlacement ? 'main' : 'sidebar',
      style: isMainPlacement
        ? 'display:flex;flex-direction:column;gap:10px;border:1px solid rgba(255,255,255,.08);border-radius:10px;background:rgba(255,255,255,.018);padding:0;overflow:hidden;'
        : 'margin-top:8px;padding-top:8px;border-top:1px solid rgba(255,255,255,.08);',
    });
    if (isMainPlacement) {
      details.open = true;
    } else {
      try { details.open = W.localStorage.getItem(persistKey) === '1'; } catch {}
    }
    const summary = el('summary', {
      class: 'wbSidebarLocalReviewSummary',
      style: isMainPlacement
        ? 'cursor:default;list-style:none;padding:12px 14px;border-bottom:1px solid rgba(255,255,255,.07);font-size:11px;color:rgba(255,255,255,.64);letter-spacing:.04em;text-transform:uppercase;'
        : 'cursor:pointer;padding:6px 10px;font-size:11px;color:rgba(255,255,255,.62);letter-spacing:.04em;text-transform:uppercase;',
    }, 'Recently Deleted');
    details.appendChild(summary);
    const body = el('div', {
      class: 'wbFolderRecentlyDeletedBody',
      style: isMainPlacement
        ? 'display:flex;flex-direction:column;gap:10px;padding:12px 14px 14px;'
        : 'display:flex;flex-direction:column;gap:8px;padding:0 8px 4px;',
    });
    const status = el('div', {
      role: 'status',
      'aria-live': 'polite',
      style: 'font-size:10.5px;line-height:1.35;color:rgba(255,255,255,.62);',
    }, 'Loading recovery diagnostics...');
    body.appendChild(status);
    details.appendChild(body);
    if (!isMainPlacement) {
      details.addEventListener('toggle', () => {
        try { W.localStorage.setItem(persistKey, details.open ? '1' : '0'); } catch {}
      });
    }
    host.appendChild(details);

    const store = desktopFolderStore();
    const listFn = typeof store?.listRecentlyDeletedFolders === 'function'
      ? store.listRecentlyDeletedFolders
      : store?.diagnoseRecentlyDeletedFolders;
    let result = null;
    try {
      result = await listFn.call(store, { limit: 500, source: isMainPlacement ? 'desktop-recently-deleted-main-ui' : 'desktop-recently-deleted-ui' });
    } catch (e) {
      err('recentlyDeleted.list', e);
      body.innerHTML = '';
      body.appendChild(el('div', {
        class: 'wbSideEmpty',
        style: 'font-size:11px;line-height:1.4;color:rgba(255,255,255,.62);padding:4px 2px;',
      }, `Recently Deleted unavailable: ${String(e?.message || e || 'list failed')}`));
      return;
    }

    const rows = recentlyDeletedRowsFromResult(result);
    const restoreApiAvailable = canUseDesktopFolderRestore();
    const purgeApiAvailable = canUseDesktopFolderPurge();
    const restoredHistoryClearApiAvailable = canUseDesktopRestoredHistoryClear();
    const activeRetentionCount = recentlyDeletedAggregateValue(result, 'activeRetentionCount');
    const expiredRetentionCount = recentlyDeletedAggregateValue(result, 'expiredRetentionCount');
    const restoredRetentionCount = recentlyDeletedAggregateValue(result, 'restoredRetentionCount');
    const purgeEligibleCount = recentlyDeletedAggregateValue(result, 'purgeEligibleCount');
    const restoredHistoryClearableCount = recentlyDeletedAggregateValue(result, 'restoredHistoryClearableCount');
    const purgeBlockedCount = recentlyDeletedAggregateValue(result, 'purgeBlockedCount', rows.length);
    const retentionDays = recentlyDeletedAggregateValue(result, 'retentionDays', 30);
    const retentionEnforcement = recentlyDeletedText(result?.retentionEnforcement || result?.recentlyDeletedDiagnostics?.retentionEnforcement, 'deferred');
    summary.textContent = `Recently Deleted · ${formatNumber(rows.length)}`;
    body.innerHTML = '';
    const purgeEnabled = purgeEligibleCount > 0 && purgeApiAvailable;
    const purgeHelperText = purgeEligibleCount > 0
      ? 'Permanently removes restore records for eligible deleted folders. Chats and snapshots are not deleted.'
      : 'No purge-eligible deleted folders.';
    const purgeStatus = el('div', {
      role: 'status',
      'aria-live': 'polite',
      class: 'wbFolderRecentlyDeletedPurgeHelper',
      style: 'min-width:0;font-size:11px;line-height:1.45;color:rgba(255,255,255,.66);overflow-wrap:anywhere;',
    }, purgeHelperText);
    if (isMainPlacement) {
      const purgeHeader = el('div', {
        class: 'wbFolderRecentlyDeletedPurgeHeader',
        style: 'display:flex;align-items:flex-start;justify-content:space-between;gap:12px;flex-wrap:wrap;min-width:0;padding:12px;border:1px solid rgba(248,113,113,.18);border-radius:9px;background:linear-gradient(180deg,rgba(127,29,29,.13),rgba(255,255,255,.018));box-sizing:border-box;',
      });
      const purgeCopy = el('div', {
        class: 'wbFolderRecentlyDeletedPurgeCopy',
        style: 'flex:1 1 220px;min-width:0;display:flex;flex-direction:column;gap:4px;',
      });
      purgeCopy.appendChild(el('div', {
        style: 'font-size:10.5px;line-height:1.2;letter-spacing:.04em;text-transform:uppercase;font-weight:700;color:rgba(255,214,214,.82);',
      }, 'Permanent delete'));
      purgeCopy.appendChild(purgeStatus);
      const purgeBtn = el('button', {
        type: 'button',
        class: 'wbSidebarNativeAction wbSidebarNativeAction--danger',
        disabled: purgeEligibleCount > 0 && purgeApiAvailable ? null : 'disabled',
        title: purgeEligibleCount > 0 && purgeApiAvailable
          ? 'Preview and confirm permanent deletion for purge-eligible folder tombstones'
          : (purgeApiAvailable ? 'No purge-eligible deleted folders' : 'Desktop purge API unavailable'),
        style: `flex:0 1 auto;align-self:flex-start;max-width:100%;box-sizing:border-box;font-size:11px;font-weight:700;padding:7px 10px;border-radius:7px;white-space:normal;text-align:center;line-height:1.15;border:1px solid ${purgeEnabled ? 'rgba(248,113,113,.58)' : 'rgba(255,255,255,.13)'};background:${purgeEnabled ? 'linear-gradient(180deg,rgba(220,38,38,.36),rgba(127,29,29,.24))' : 'rgba(127,29,29,.12)'};color:${purgeEnabled ? 'rgba(255,245,245,.96)' : 'rgba(255,210,210,.58)'};`,
      }, `Delete permanently (${formatNumber(purgeEligibleCount)})`);
      if (!(purgeEligibleCount > 0 && purgeApiAvailable)) purgeBtn.classList.add('is-disabled');
      purgeBtn.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        if (purgeBtn.disabled) return;
        purgeBtn.disabled = true;
        purgeBtn.classList.add('is-disabled');
        Promise.resolve(permanentlyDeleteRecentlyDeletedFolders({
          setStatus: (message) => { purgeStatus.textContent = message; },
          refresh: () => renderRecentlyDeletedFoldersPanel(host, { placement: 'main' }).catch((e) => err('recentlyDeleted.renderMainAfterPurge', e)),
        })).finally(() => {
          W.setTimeout(() => {
            if (purgeBtn.isConnected) {
              purgeBtn.disabled = !(purgeEligibleCount > 0 && purgeApiAvailable);
              if (!purgeBtn.disabled) purgeBtn.classList.remove('is-disabled');
            }
          }, 350);
        });
      });
      purgeHeader.appendChild(purgeCopy);
      purgeHeader.appendChild(purgeBtn);
      body.appendChild(purgeHeader);
      const restoredHistoryClearEnabled = restoredHistoryClearableCount > 0 && restoredHistoryClearApiAvailable;
      const restoredHistoryClearStatus = el('div', {
        role: 'status',
        'aria-live': 'polite',
        class: 'wbFolderRecentlyDeletedRestoredHistoryHelper',
        style: 'min-width:0;font-size:11px;line-height:1.45;color:rgba(255,255,255,.66);overflow-wrap:anywhere;',
      }, restoredHistoryClearableCount > 0
        ? 'Clears restored/history entries from Recently Deleted only. Folders, chats, snapshots, assets, and receipts are not deleted.'
        : 'No restored history entries to clear.');
      const restoredHistoryHeader = el('div', {
        class: 'wbFolderRecentlyDeletedRestoredHistoryHeader',
        style: 'display:flex;align-items:flex-start;justify-content:space-between;gap:12px;flex-wrap:wrap;min-width:0;padding:12px;border:1px solid rgba(148,163,184,.16);border-radius:9px;background:linear-gradient(180deg,rgba(15,23,42,.34),rgba(255,255,255,.018));box-sizing:border-box;',
      });
      const restoredHistoryCopy = el('div', {
        class: 'wbFolderRecentlyDeletedRestoredHistoryCopy',
        style: 'flex:1 1 220px;min-width:0;display:flex;flex-direction:column;gap:4px;',
      });
      restoredHistoryCopy.appendChild(el('div', {
        style: 'font-size:10.5px;line-height:1.2;letter-spacing:.04em;text-transform:uppercase;font-weight:700;color:rgba(226,232,240,.82);',
      }, 'Restored history'));
      restoredHistoryCopy.appendChild(restoredHistoryClearStatus);
      const restoredHistoryBtn = el('button', {
        type: 'button',
        class: 'wbSidebarNativeAction wbSidebarNativeAction--secondary',
        disabled: restoredHistoryClearEnabled ? null : 'disabled',
        title: restoredHistoryClearEnabled
          ? 'Clear restored/history entries from Recently Deleted'
          : (restoredHistoryClearApiAvailable ? 'No restored history entries to clear' : 'Desktop restored history clear API unavailable'),
        style: `flex:0 1 auto;align-self:flex-start;max-width:100%;box-sizing:border-box;font-size:11px;font-weight:700;padding:7px 10px;border-radius:7px;white-space:normal;text-align:center;line-height:1.15;border:1px solid ${restoredHistoryClearEnabled ? 'rgba(148,163,184,.45)' : 'rgba(255,255,255,.12)'};background:${restoredHistoryClearEnabled ? 'linear-gradient(180deg,rgba(71,85,105,.38),rgba(30,41,59,.28))' : 'rgba(255,255,255,.035)'};color:${restoredHistoryClearEnabled ? 'rgba(248,250,252,.94)' : 'rgba(226,232,240,.52)'};`,
      }, `Clear restored history (${formatNumber(restoredHistoryClearableCount)})`);
      if (!restoredHistoryClearEnabled) restoredHistoryBtn.classList.add('is-disabled');
      restoredHistoryBtn.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        if (restoredHistoryBtn.disabled) return;
        restoredHistoryBtn.disabled = true;
        restoredHistoryBtn.classList.add('is-disabled');
        Promise.resolve(clearRecentlyDeletedRestoredHistory({
          setStatus: (message) => { restoredHistoryClearStatus.textContent = message; },
          refresh: () => renderRecentlyDeletedFoldersPanel(host, { placement: 'main' }).catch((e) => err('recentlyDeleted.renderMainAfterRestoredHistoryClear', e)),
        })).finally(() => {
          W.setTimeout(() => {
            if (restoredHistoryBtn.isConnected) {
              restoredHistoryBtn.disabled = !(restoredHistoryClearableCount > 0 && restoredHistoryClearApiAvailable);
              if (!restoredHistoryBtn.disabled) restoredHistoryBtn.classList.remove('is-disabled');
            }
          }, 350);
        });
      });
      restoredHistoryHeader.appendChild(restoredHistoryCopy);
      restoredHistoryHeader.appendChild(restoredHistoryBtn);
      body.appendChild(restoredHistoryHeader);
    }
    const statItems = [
      ['Active', activeRetentionCount, 'Active retention count'],
      ['Restored', restoredRetentionCount, 'Restored retention count'],
      ['Purge blocked', purgeBlockedCount, 'Purge blocked count'],
      ['Expired', expiredRetentionCount, 'Expired retention count'],
      ['Purge eligible', purgeEligibleCount, 'Purge eligible count'],
      ['Clearable history', restoredHistoryClearableCount, 'Restored history clearable count'],
      ['Retention', `${formatNumber(retentionDays)}d`, 'Retention days'],
    ];
    body.appendChild(el('div', {
      class: 'wbFolderRecentlyDeletedStatsGrid',
      style: 'display:grid;grid-template-columns:repeat(auto-fit,minmax(108px,1fr));gap:6px;font-size:10.5px;line-height:1.25;',
    }, statItems.map(([label, value, title]) => el('div', {
      title,
      style: 'min-width:0;padding:7px 8px;border:1px solid rgba(255,255,255,.07);border-radius:7px;background:rgba(255,255,255,.025);',
    }, [
      el('div', {
        style: 'font-size:9.5px;letter-spacing:.035em;text-transform:uppercase;color:rgba(255,255,255,.48);',
      }, label),
      el('div', {
        style: 'margin-top:2px;font-size:12px;font-weight:650;color:rgba(255,255,255,.82);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;',
      }, typeof value === 'number' ? formatNumber(value) : String(value)),
    ]))));
    body.appendChild(el('div', {
      class: 'wbFolderRecentlyDeletedPolicyChips',
      style: 'display:flex;flex-wrap:wrap;gap:6px;font-size:10px;line-height:1.2;',
    }, [
      el('span', {
        style: 'padding:3px 6px;border-radius:999px;background:rgba(255,255,255,.06);color:rgba(255,255,255,.72);',
      }, 'Purge deferred'),
      el('span', {
        style: 'padding:3px 6px;border-radius:999px;background:rgba(255,255,255,.06);color:rgba(255,255,255,.72);',
      }, 'Hard delete blocked'),
      el('span', {
        style: 'padding:3px 6px;border-radius:999px;background:rgba(255,255,255,.06);color:rgba(255,255,255,.72);',
      }, `Retention enforcement ${retentionEnforcement}`),
    ]));

    if (result?.ok === false) {
      const blocker = firstResultCode(result, String(result?.status || 'recently-deleted-list-failed'));
      body.appendChild(el('div', {
        class: 'wbSideEmpty',
        style: 'font-size:11px;line-height:1.4;color:rgba(255,255,255,.62);padding:4px 2px;',
      }, `Recently Deleted blocked: ${blocker}`));
      return;
    }
    if (!rows.length) {
      body.appendChild(el('div', {
        class: 'wbSideEmpty',
        style: 'font-size:11px;line-height:1.4;color:rgba(255,255,255,.62);padding:4px 2px;',
      }, 'No folder tombstones recorded.'));
      return;
    }

    const visibleRows = rows.slice(0, isMainPlacement ? 50 : 20);
    visibleRows.forEach((raw) => {
      const row = raw && typeof raw === 'object' ? raw : {};
      const folderName = recentlyDeletedText(row.folderName || row.name || row.folderId, 'Folder');
      const folderId = recentlyDeletedText(row.folderId || row.id, '');
      const restoreAvailable = row.restoreAvailable === true;
      const restoreStatus = recentlyDeletedText(row.restoreStatus, 'unknown');
      const restoreStatusLabel = restoreStatus === 'restored' ? 'Restored' :
        (restoreStatus === 'active' ? 'Active' : restoreStatus.charAt(0).toUpperCase() + restoreStatus.slice(1));
      const restoreDisabledReason = restoreApiAvailable
        ? (restoreAvailable ? '' : 'Restore is unavailable for this tombstone state')
        : 'Safe restore API unavailable';
      const card = el('div', {
        class: 'wbFolderRecentlyDeletedRow',
        'data-h2o-recently-deleted-folder-id': folderId || null,
        style: isMainPlacement
          ? 'display:flex;flex-direction:column;gap:10px;padding:12px;border:1px solid rgba(255,255,255,.08);border-radius:9px;background:linear-gradient(180deg,rgba(255,255,255,.035),rgba(255,255,255,.018));box-sizing:border-box;min-width:0;'
          : 'display:flex;flex-direction:column;gap:5px;padding:7px 8px;border:1px solid rgba(255,255,255,.08);border-radius:8px;background:rgba(255,255,255,.025);',
      });
      card.appendChild(el('div', {
        class: 'wbFolderRecentlyDeletedRowHeader',
        style: 'display:flex;align-items:flex-start;justify-content:space-between;gap:10px;min-width:0;flex-wrap:wrap;',
      }, [
        el('span', {
          style: 'flex:1 1 180px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12.5px;font-weight:650;color:rgba(255,255,255,.9);',
          title: folderName,
        }, folderName),
        el('span', {
          class: 'wbFolderRecentlyDeletedStatusPill',
          style: 'flex:0 0 auto;font-size:10px;line-height:1.2;padding:4px 7px;border-radius:999px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.08);color:rgba(255,255,255,.72);white-space:nowrap;',
        }, restoreStatusLabel),
      ]));
      const lines = [
        ['Folder ID', folderId],
        ['Deleted', recentlyDeletedDateText(row.deletedAt)],
        ['Restore available', recentlyDeletedBoolLabel(restoreAvailable)],
        ['Affected chats', formatNumber(Number(row.affectedChatCount) || 0)],
        ['Retention', recentlyDeletedText(row.retentionCountdownStatus, 'unknown')],
        ['Expires', recentlyDeletedDateText(row.retentionExpiresAt)],
        ['Enforcement', recentlyDeletedText(row.retentionEnforcement, 'deferred')],
        ['Purge blocked', recentlyDeletedBoolLabel(row.purgeBlocked !== false)],
        ['Hard delete blocked', recentlyDeletedBoolLabel(row.hardDeleteBlocked !== false)],
      ];
      const detailGrid = el('div', {
        class: 'wbFolderRecentlyDeletedDetailsGrid',
        style: 'display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:7px 10px;min-width:0;',
      });
      lines.forEach(([label, value]) => {
        detailGrid.appendChild(el('div', {
          style: 'min-width:0;display:flex;flex-direction:column;gap:2px;font-size:10.5px;line-height:1.25;color:rgba(255,255,255,.62);',
        }, [
          el('span', {
            style: 'font-size:9.5px;letter-spacing:.03em;text-transform:uppercase;color:rgba(255,255,255,.45);',
          }, label),
          el('span', {
            style: 'min-width:0;overflow-wrap:anywhere;color:rgba(255,255,255,.78);',
          }, value),
        ]));
      });
      card.appendChild(detailGrid);
      const actionRow = el('div', {
        class: 'wbFolderRecentlyDeletedActionRow',
        style: 'display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:1px;flex-wrap:wrap;padding-top:8px;border-top:1px solid rgba(255,255,255,.06);',
      });
      const rowStatus = el('span', {
        style: 'flex:1 1 160px;min-width:0;font-size:10.5px;line-height:1.3;color:rgba(255,255,255,.58);overflow-wrap:anywhere;',
      }, row.restoreAvailableReason || row.purgeBlockedReason || 'No purge action available');
      actionRow.appendChild(rowStatus);
      if (restoreStatus === 'restored') {
        actionRow.appendChild(el('span', {
          class: 'wbFolderRecentlyDeletedRestorePill',
          title: 'This folder tombstone has already been restored',
          style: 'flex:0 0 auto;font-size:10.5px;line-height:1.2;padding:5px 8px;border-radius:999px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.08);color:rgba(255,255,255,.72);white-space:nowrap;',
        }, 'Already restored'));
      } else {
        const restoreBtn = el('button', {
          type: 'button',
          class: 'wbSidebarNativeAction',
          disabled: restoreAvailable && restoreApiAvailable ? null : 'disabled',
          title: restoreAvailable && restoreApiAvailable ? 'Restore this folder safely' : restoreDisabledReason,
          style: 'flex:0 0 auto;font-size:10.5px;padding:4px 7px;white-space:nowrap;',
        }, 'Restore');
        if (!(restoreAvailable && restoreApiAvailable)) restoreBtn.classList.add('is-disabled');
        restoreBtn.addEventListener('click', (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          if (restoreBtn.disabled) return;
          restoreBtn.disabled = true;
          restoreBtn.classList.add('is-disabled');
          Promise.resolve(restoreRecentlyDeletedFolder(row, { setStatus: (message) => { rowStatus.textContent = message; } }))
            .finally(() => {
              W.setTimeout(() => {
                try {
                  if (isMainPlacement) {
                    renderRecentlyDeletedFoldersPanel(host, { placement: 'main' }).catch((e) => err('recentlyDeleted.renderMainAfterRestore', e));
                  } else {
                    renderFolders();
                  }
                } catch (e) { err('recentlyDeleted.renderAfterRestore', e); }
              }, 250);
            });
        });
        actionRow.appendChild(restoreBtn);
      }
      card.appendChild(actionRow);
      body.appendChild(card);
    });
    if (rows.length > visibleRows.length) {
      body.appendChild(el('div', {
        style: 'font-size:10.5px;color:rgba(255,255,255,.54);padding:0 2px;',
      }, `Showing ${formatNumber(visibleRows.length)} of ${formatNumber(rows.length)} folder tombstones.`));
    }
  }

  function chromeDesktopReceiptHiddenRowsFromState(state) {
    const bag = plainObject(state?.hiddenByDesktopReceipt);
    return Object.keys(bag).sort().map((folderId) => {
      const row = plainObject(bag[folderId]);
      return {
        ...row,
        id: String(row.id || row.folderId || folderId).trim(),
        folderId: String(row.folderId || row.id || folderId).trim(),
        name: String(row.name || row.folderName || row.title || folderId).trim(),
        folderName: String(row.folderName || row.name || row.title || folderId).trim(),
        status: 'deleted',
        hiddenByDesktopReceipt: true,
        deletedByDesktopReceipt: true,
        companionStatusLabel: 'Deleted on Desktop',
      };
    }).filter((row) => row.folderId);
  }

  function chromeDesktopPurgedFolderSuppressionSnapshotFromState(state) {
    const snapshot = plainObject(state?.desktopPurgedFolderSuppression);
    if (!snapshot || !Array.isArray(snapshot.rows)) return null;
    const ids = [];
    const rows = snapshot.rows.map((raw) => {
      const row = plainObject(raw);
      const folderId = String(row.folderId || row.id || '').trim();
      if (!folderId || ids.includes(folderId)) return null;
      ids.push(folderId);
      const folderName = String(row.folderName || row.name || row.title || folderId).trim();
      return {
        ...row,
        id: folderId,
        folderId,
        name: folderName,
        folderName,
        status: 'purged',
        source: 'desktop-purged-folder-suppression',
        sourceKind: 'desktop-purged-folder-suppression',
        phase6aPermanentlyPurged: true,
        permanentlySuppressed: true,
        noChromePurgeAuthority: true,
        noChromeTombstoneApply: true,
        noHardDelete: true,
        noChatDelete: true,
        noSnapshotDelete: true,
        noAssetDelete: true,
      };
    }).filter(Boolean);
    return {
      schema: String(snapshot.schema || 'h2o.studio.folder-purge-suppression.desktop.v1').trim(),
      source: String(snapshot.source || 'desktop-purged-folder-suppression').trim(),
      status: String(snapshot.status || 'imported').trim(),
      importedAt: String(snapshot.importedAt || '').trim(),
      sourceExportedAt: String(snapshot.sourceExportedAt || '').trim(),
      desktopPurgedFolderSuppressionCount: rows.length,
      desktopPurgedFolderSuppressionFolderIds: ids.sort(),
      rows: rows.sort((a, b) => String(b.purgedAt || '').localeCompare(String(a.purgedAt || '')) ||
        String(a.folderName || '').localeCompare(String(b.folderName || ''))),
    };
  }

  function chromeDesktopPurgedFolderSuppressedIdSet(state) {
    const snapshot = chromeDesktopPurgedFolderSuppressionSnapshotFromState(state);
    return new Set((snapshot?.rows || []).map((row) => String(row.folderId || row.id || '').trim()).filter(Boolean));
  }

  function filterRowsNotSuppressedByDesktopPurge(rows, suppressedIds) {
    const set = suppressedIds instanceof Set ? suppressedIds : new Set();
    return (Array.isArray(rows) ? rows : []).filter((row) => {
      const folderId = String(row?.folderId || row?.id || '').trim();
      return !folderId || !set.has(folderId);
    });
  }

  function chromeDesktopCanonicalRecentlyDeletedSnapshotFromState(state) {
    const snapshot = plainObject(state?.desktopCanonicalRecentlyDeleted);
    if (!snapshot || !Array.isArray(snapshot.rows)) return null;
    const suppressedIds = chromeDesktopPurgedFolderSuppressedIdSet(state);
    const ids = [];
    const rows = snapshot.rows.map((raw) => {
      const row = plainObject(raw);
      const folderId = String(row.folderId || row.id || '').trim();
      if (folderId && suppressedIds.has(folderId)) return null;
      if (!folderId || ids.includes(folderId)) return null;
      ids.push(folderId);
      const folderName = String(row.folderName || row.name || row.title || folderId).trim();
      return {
        ...row,
        id: folderId,
        folderId,
        name: folderName,
        folderName,
        status: 'deleted',
        source: 'desktop-canonical-recently-deleted',
        sourceKind: 'desktop-canonical-recently-deleted',
        desktopCanonicalRecentlyDeleted: true,
        companionStatusLabel: 'Deleted on Desktop',
        pendingDeleteHidden: false,
        hiddenByChromePendingDelete: false,
        pendingDeleteRequest: false,
        desktopReceiptHidden: true,
        noChromePurgeAuthority: true,
        noChromeTombstoneApply: true,
        noHardDelete: true,
        noChatDelete: true,
        noSnapshotDelete: true,
        noAssetDelete: true,
      };
    }).filter(Boolean);
    return {
      schema: String(snapshot.schema || 'h2o.studio.folder-recently-deleted.desktop-canonical.v1').trim(),
      source: String(snapshot.source || 'desktop-canonical-recently-deleted').trim(),
      status: String(snapshot.status || 'imported').trim(),
      importedAt: String(snapshot.importedAt || '').trim(),
      sourceExportedAt: String(snapshot.sourceExportedAt || '').trim(),
      desktopCanonicalRecentlyDeletedCount: rows.length,
      desktopCanonicalRecentlyDeletedFolderIds: ids.sort(),
      rows: rows.sort((a, b) => String(b.deletedAt || '').localeCompare(String(a.deletedAt || '')) ||
        String(a.folderName || '').localeCompare(String(b.folderName || ''))),
    };
  }

  function chromeDesktopCanonicalRecentlyDeletedRowsFromState(state) {
    const snapshot = chromeDesktopCanonicalRecentlyDeletedSnapshotFromState(state);
    return snapshot ? snapshot.rows : [];
  }

  async function chromeRecentlyDeletedCompanionRows(model = null) {
    if (studioPlatformAdapter() !== 'mv3') return [];
    const state = await readChromeFolderStateMirror();
    const suppressedIds = chromeDesktopPurgedFolderSuppressedIdSet(state);
    const desktopCanonical = chromeDesktopCanonicalRecentlyDeletedSnapshotFromState(state);
    if (desktopCanonical) return desktopCanonical.rows;
    const pendingRows = filterRowsNotSuppressedByDesktopPurge(chromePendingDeleteHiddenRowsFromState(state), suppressedIds).map((row) => ({
      ...row,
      companionStatusLabel: 'Delete pending',
    }));
    const requestRows = await loadPendingChromeFolderDeleteRequestRows();
    const activeRequestRows = filterRowsNotSuppressedByDesktopPurge(requestRows, suppressedIds);
    const confirmedRows = filterRowsNotSuppressedByDesktopPurge(chromeDesktopReceiptHiddenRowsFromState(state), suppressedIds);
    const byId = new Map();
    for (const row of confirmedRows) byId.set(row.folderId, row);
    for (const row of pendingRows) {
      const existing = byId.get(row.folderId);
      byId.set(row.folderId, existing ? { ...row, ...existing, companionStatusLabel: existing.companionStatusLabel || 'Deleted on Desktop' } : row);
    }
    for (const row of activeRequestRows) {
      const existing = byId.get(row.folderId);
      byId.set(row.folderId, existing ? { ...row, ...existing, pendingDeleteRequest: true } : row);
    }
    const modelRows = Array.isArray(model?.chromePendingDeleteHiddenRows) ? model.chromePendingDeleteHiddenRows : [];
    for (const row of filterRowsNotSuppressedByDesktopPurge(modelRows, suppressedIds)) {
      const folderId = String(row?.folderId || row?.id || '').trim();
      if (folderId && !byId.has(folderId)) byId.set(folderId, { ...row, folderId, companionStatusLabel: 'Delete pending' });
    }
    return Array.from(byId.values()).sort((a, b) => String(a.folderName || a.name || '').localeCompare(String(b.folderName || b.name || '')));
  }

  function chromeFolderRestoreRequestApi() {
    const reviews = H2O.Studio?.store?.tombstoneReviews;
    if (!reviews || typeof reviews !== 'object') return null;
    return reviews;
  }

  function chromeRestoreRequestUxAvailable() {
    const api = chromeFolderRestoreRequestApi();
    return !!(api &&
      typeof api.requestFolderRestore === 'function' &&
      typeof api.listFolderRestoreRequests === 'function');
  }

  async function loadPendingChromeFolderRestoreRequestRows() {
    const api = chromeFolderRestoreRequestApi();
    if (!api || typeof api.listFolderRestoreRequests !== 'function') return [];
    try {
      const rows = await api.listFolderRestoreRequests({ status: 'pending', limit: 1000 });
      return (Array.isArray(rows) ? rows : []).map((raw) => {
        const row = plainObject(raw);
        const payload = plainObject(row.payload);
        const folderId = String(payload.folderId || row.folderId || row.id || row.recordId || '').trim();
        if (!folderId) return null;
        return {
          ...row,
          ...payload,
          id: folderId,
          folderId,
          folderName: String(payload.folderName || row.folderName || row.name || folderId).trim(),
          requestId: String(payload.requestId || payload.reviewId || row.requestId || row.reviewId || '').trim(),
          status: String(payload.status || row.status || 'pending').trim(),
          source: 'chrome-folder-restore-request',
        };
      }).filter(Boolean);
    } catch (e) {
      err('chromeRestoreRequests.loadPending', e);
      return [];
    }
  }

  async function requestChromeFolderRestoreFromCompanion(row, controls = {}) {
    const setStatus = typeof controls.setStatus === 'function' ? controls.setStatus : () => {};
    const api = chromeFolderRestoreRequestApi();
    const folderId = String(row?.folderId || row?.id || '').trim();
    if (!folderId) {
      setStatus('Restore request blocked: folder identity missing', 'blocked');
      return { ok: false, status: 'folder-identity-missing', blockers: ['folder-identity-missing'] };
    }
    if (!api || typeof api.requestFolderRestore !== 'function') {
      setStatus(CHROME_RESTORE_REQUEST_EXPORT_DEFERRED_MESSAGE, 'blocked');
      return { ok: false, status: CHROME_RESTORE_REQUEST_EXPORT_DEFERRED_BLOCKER, blockers: [CHROME_RESTORE_REQUEST_EXPORT_DEFERRED_BLOCKER] };
    }
    if (row.phase6aPermanentlyPurged === true || row.permanentlySuppressed === true || String(row.status || '').trim() === 'purged') {
      setStatus('Restore request blocked: permanently deleted on Desktop', 'blocked');
      return { ok: false, status: 'folder-restore-request-blocked-purged', blockers: ['folder-restore-request-blocked-purged'] };
    }
    if (row.desktopCanonicalRecentlyDeleted !== true && String(row.source || row.sourceKind || '').trim() !== 'desktop-canonical-recently-deleted') {
      setStatus('Restore request blocked: Desktop canonical row required', 'blocked');
      return { ok: false, status: 'folder-restore-request-non-canonical-row', blockers: ['folder-restore-request-non-canonical-row'] };
    }
    setStatus('Requesting restore...', 'pending');
    try {
      const result = await api.requestFolderRestore({
        ...row,
        id: folderId,
        folderId,
        folderName: row.folderName || row.name || folderId,
        status: row.status || 'deleted',
        desktopCanonicalRecentlyDeleted: true,
      }, {
        sourceSurface: 'chrome-studio',
        reason: 'chrome-recently-deleted-request-restore',
      });
      if (result?.ok === true) {
        const duplicate = result.duplicate === true || result.status === 'pending-existing';
        setStatus(duplicate ? 'Restore already pending' : 'Restore pending', 'pending');
      } else {
        const code = firstResultCode(result, String(result?.status || 'folder-restore-request-failed'));
        setStatus(`Restore request blocked: ${code}`, 'blocked');
      }
      return result || { ok: false, status: 'folder-restore-request-failed', blockers: ['folder-restore-request-failed'] };
    } catch (e) {
      err('chromeRestoreRequests.request', e);
      const message = String(e?.message || e || 'folder-restore-request-threw');
      setStatus(`Restore request blocked: ${message}`, 'blocked');
      return { ok: false, status: 'folder-restore-request-threw', blockers: ['folder-restore-request-threw'], reason: message };
    }
  }

  async function diagnoseChromeRecentlyDeletedCompanion(options = {}) {
    const opts = options && typeof options === 'object' ? options : {};
    let model = opts.model && typeof opts.model === 'object' ? opts.model : null;
    if (!model) {
      try { model = await H2O.Library?.FolderParity?.getDisplayModel?.({ fresh: opts.fresh !== false }); }
      catch (e) { err('chromeRecentlyDeleted.diagnoseModel', e); }
    }
    const canonicalRows = Array.isArray(model?.canonicalRows) ? model.canonicalRows : [];
    const storageSources = await readChromeFolderStateMirrorSources();
    const purgedSuppressionSnapshot = chromeDesktopPurgedFolderSuppressionSnapshotFromState(storageSources.merged);
    const purgedSuppressedFolderIds = purgedSuppressionSnapshot
      ? purgedSuppressionSnapshot.desktopPurgedFolderSuppressionFolderIds.slice()
      : [];
    const purgedSuppressedIdSet = new Set(purgedSuppressedFolderIds);
    const rawHiddenPendingRows = chromePendingDeleteHiddenRowsFromState(storageSources.merged);
    const rawRequestRows = await loadPendingChromeFolderDeleteRequestRows();
    const receiptRows = chromeDesktopReceiptHiddenRowsFromState(storageSources.merged);
    const hiddenPendingRows = filterRowsNotSuppressedByDesktopPurge(rawHiddenPendingRows, purgedSuppressedIdSet);
    const requestRows = filterRowsNotSuppressedByDesktopPurge(rawRequestRows, purgedSuppressedIdSet);
    const restoreRequestRows = await loadPendingChromeFolderRestoreRequestRows();
    const restoreRequestPendingRows = filterRowsNotSuppressedByDesktopPurge(restoreRequestRows, purgedSuppressedIdSet);
    const restoreRequestUxAvailable = chromeRestoreRequestUxAvailable();
    const activeReceiptRows = filterRowsNotSuppressedByDesktopPurge(receiptRows, purgedSuppressedIdSet);
    const desktopCanonicalSnapshot = chromeDesktopCanonicalRecentlyDeletedSnapshotFromState(storageSources.merged);
    const desktopCanonicalRows = desktopCanonicalSnapshot ? desktopCanonicalSnapshot.rows : [];
    const companionRows = await chromeRecentlyDeletedCompanionRows(model);
    const resurrectedReceiptRows = receiptRows.filter((row) => {
      const folderId = String(row.folderId || row.id || '').trim();
      return folderId && purgedSuppressedIdSet.has(folderId);
    });
    const resurrectedPendingRows = rawHiddenPendingRows.filter((row) => {
      const folderId = String(row.folderId || row.id || '').trim();
      return folderId && purgedSuppressedIdSet.has(folderId);
    });
    const resurrectedCompanionRows = companionRows.filter((row) => {
      const folderId = String(row.folderId || row.id || '').trim();
      return folderId && purgedSuppressedIdSet.has(folderId);
    });
    const pendingDeleteHiddenCount = hiddenPendingRows.length;
    const desktopReceiptHiddenCount = activeReceiptRows.length;
    const requestFolderIds = new Set(requestRows.map((row) => String(row?.folderId || row?.id || '').trim()).filter(Boolean));
    const hiddenWithoutExportableRequestRows = hiddenPendingRows.filter((row) => {
      const folderId = String(row?.folderId || row?.id || '').trim();
      return folderId && !requestFolderIds.has(folderId);
    });
    const hiddenWithoutExportableRequestCount = hiddenWithoutExportableRequestRows.length;
    const diagnosticBlockers = [];
    const diagnosticWarnings = [];
    if (hiddenWithoutExportableRequestCount > 0) {
      diagnosticBlockers.push('pending-hide-without-exportable-delete-request');
      diagnosticWarnings.push('pending-hide-without-exportable-delete-request');
    }
    if (resurrectedCompanionRows.length > 0) {
      diagnosticBlockers.push('purged-folder-resurrected-in-chrome-companion');
      diagnosticWarnings.push('purged-folder-resurrected-in-chrome-companion');
    }
    if (!restoreRequestUxAvailable && companionRows.length > 0) {
      diagnosticBlockers.push(CHROME_RESTORE_REQUEST_EXPORT_DEFERRED_BLOCKER);
      diagnosticWarnings.push(CHROME_RESTORE_REQUEST_EXPORT_DEFERRED_BLOCKER);
    }
    const canonicalProjectionPresent = !!desktopCanonicalSnapshot;
    const canonicalIds = new Set(desktopCanonicalRows.map((row) => String(row.folderId || row.id || '').trim()).filter(Boolean));
    const companionIds = new Set(companionRows.map((row) => String(row.folderId || row.id || '').trim()).filter(Boolean));
    const extraChromeRows = canonicalProjectionPresent ? companionRows.filter((row) => {
      const folderId = String(row.folderId || row.id || '').trim();
      return folderId && !canonicalIds.has(folderId);
    }) : companionRows.slice();
    const missingChromeRows = desktopCanonicalRows.filter((row) => {
      const folderId = String(row.folderId || row.id || '').trim();
      return folderId && !companionIds.has(folderId);
    });
    const staleReceiptRows = canonicalProjectionPresent
      ? activeReceiptRows.filter((row) => {
        const folderId = String(row.folderId || row.id || '').trim();
        return folderId && !canonicalIds.has(folderId);
      })
      : receiptRows.slice().filter((row) => {
        const folderId = String(row.folderId || row.id || '').trim();
        return !folderId || !purgedSuppressedIdSet.has(folderId);
      });
    const mismatchedFolderIds = Array.from(new Set(extraChromeRows.concat(missingChromeRows).map((row) => String(row.folderId || row.id || '').trim()).filter(Boolean))).sort();
    const desktopChromeRecentlyDeletedParityOk = canonicalProjectionPresent &&
      extraChromeRows.length === 0 &&
      missingChromeRows.length === 0 &&
      resurrectedCompanionRows.length === 0 &&
      companionRows.length === desktopCanonicalRows.length;
    const probeName = String(opts.probeName || opts.folderName || 'chrome delete companion test').trim();
    const probeKey = probeName.toLowerCase();
    const probeFolderId = String(opts.folderId || opts.probeFolderId || '').trim();
    const probeRequestId = String(opts.requestId || opts.reviewId || opts.probeRequestId || '').trim();
    const rowMatchesProbe = (row = {}) => {
      const id = String(row.folderId || row.id || '').trim();
      const name = String(row.folderName || row.name || row.title || '').trim();
      const requestId = String(row.requestId || row.reviewId || row.receiptId || '').trim();
      const matchesName = !!probeKey && (id.toLowerCase() === probeKey || name.toLowerCase() === probeKey);
      const matchesFolderId = !!probeFolderId && id === probeFolderId;
      const matchesRequestId = !!probeRequestId && requestId === probeRequestId;
      return matchesName || matchesFolderId || matchesRequestId;
    };
    const normalProbeRows = canonicalRows.filter(rowMatchesProbe);
    const hiddenProbeRows = hiddenPendingRows.filter(rowMatchesProbe);
    const requestProbeRows = requestRows.filter(rowMatchesProbe);
    const receiptProbeRows = activeReceiptRows.filter(rowMatchesProbe);
    const companionProbeRows = companionRows.filter(rowMatchesProbe);
    let extensionId = '';
    try { extensionId = String(W.chrome?.runtime?.id || '').trim(); } catch {}
    const sidebarRecentlyDeletedEntryPresent = !!D.querySelector?.('[data-h2o-recently-deleted-folders-sidebar-entry]');
    return {
      ok: true,
      status: 'chrome-recently-deleted-companion-diagnosed',
      surface: studioPlatformAdapter() === 'mv3' ? 'chrome-studio' : 'non-chrome-surface',
      readOnly: true,
      chromeProfileSource: extensionId ? `chrome-extension:${extensionId}` : 'chrome-profile-page-context',
      extensionId,
      locationOrigin: String(W.location?.origin || '').trim(),
      locationHref: String(W.location?.href || '').trim(),
      storageNamespaceSource: storageSources.source,
      chromeStorageAvailable: storageSources.chromeStorageAvailable === true,
      chromeStorageSource: storageSources.chromeStorageSource,
      localStorageSource: storageSources.localStorageSource,
      syncStateSource: storageSources.syncStateSource,
      chromeNormalVisibleFolderCount: canonicalRows.length,
      chromeRecentlyDeletedCount: companionRows.length,
      chromeSidebarRecentlyDeletedEntryPresent: sidebarRecentlyDeletedEntryPresent,
      chromeSidebarRecentlyDeletedEntryRemoved: sidebarRecentlyDeletedEntryPresent === false,
      desktopCanonicalRecentlyDeletedCount: desktopCanonicalRows.length,
      chromeCanonicalRecentlyDeletedCount: desktopCanonicalRows.length,
      chromeCompanionRecentlyDeletedCount: companionRows.length,
      desktopCanonicalRecentlyDeletedSource: storageSources.desktopCanonicalRecentlyDeletedSource,
      desktopCanonicalRecentlyDeletedProjectionPresent: canonicalProjectionPresent,
      desktopPurgedFolderSuppressionCount: purgedSuppressedFolderIds.length,
      desktopPurgedFolderSuppressionSource: storageSources.desktopPurgedFolderSuppressionSource,
      purgedSuppressedFolderIds,
      resurrectedAfterPurgeCount: resurrectedCompanionRows.length,
      resurrectedAfterPurgeRows: resurrectedCompanionRows.slice(0, 80).map((row) => ({ folderId: row.folderId || row.id || '', folderName: row.folderName || row.name || '' })),
      desktopChromeRecentlyDeletedParityOk,
      mismatchedFolderIds,
      extraChromeRows: extraChromeRows.slice(0, 80).map((row) => ({ folderId: row.folderId || row.id || '', folderName: row.folderName || row.name || '' })),
      missingChromeRows: missingChromeRows.slice(0, 80).map((row) => ({ folderId: row.folderId || row.id || '', folderName: row.folderName || row.name || '' })),
      staleReceiptRowCount: staleReceiptRows.length,
      staleReceiptRows: staleReceiptRows.slice(0, 80).map((row) => ({ folderId: row.folderId || row.id || '', folderName: row.folderName || row.name || '', requestId: row.requestId || '' })),
      pendingLocalDeleteCount: pendingDeleteHiddenCount,
      stalePendingDeleteRowCount: resurrectedPendingRows.length,
      stalePendingDeleteRows: resurrectedPendingRows.slice(0, 80).map((row) => ({ folderId: row.folderId || row.id || '', folderName: row.folderName || row.name || '', requestId: row.requestId || '' })),
      hiddenByChromePendingDeleteCount: pendingDeleteHiddenCount,
      pendingDeleteHiddenCount,
      pendingDeleteRequestCount: requestRows.length,
      exportableFolderDeleteRequestCount: requestRows.length,
      chromeRestoreRequestUxAvailable: restoreRequestUxAvailable,
      chromeRestoreRequestExportAvailable: restoreRequestUxAvailable,
      chromeRestoreRequestExportDeferred: !restoreRequestUxAvailable,
      chromeRestoreRequestBlocker: restoreRequestUxAvailable ? '' : CHROME_RESTORE_REQUEST_EXPORT_DEFERRED_BLOCKER,
      chromeRestoreRequestPendingCount: restoreRequestPendingRows.length,
      pendingRestoreCount: restoreRequestPendingRows.length,
      folderRestoreRequestExportableCount: restoreRequestPendingRows.length,
      chromeRestoreDirectApplyBlocked: true,
      noChromeRestoreAuthority: true,
      hiddenWithoutExportableRequestCount,
      desktopReceiptHiddenCount,
      chromeReceiptImportedCount: desktopReceiptHiddenCount,
      receiptImportedCount: receiptRows.length,
      chromePendingStillWaitingCount: Math.max(0, pendingDeleteHiddenCount - desktopReceiptHiddenCount),
      companionStateSource: 'merged-folder-state-mirror+pending-delete-request-store',
      probeName,
      probeFolderId,
      probeRequestId,
      probe: {
        name: probeName,
        folderId: probeFolderId,
        requestId: probeRequestId,
        normalRows: normalProbeRows.map((row) => ({ folderId: row.folderId || row.id || '', folderName: row.name || row.folderName || '' })),
        hiddenPendingRows: hiddenProbeRows.map((row) => ({ folderId: row.folderId || row.id || '', folderName: row.folderName || row.name || '', source: row.source || '' })),
        requestStoreRows: requestProbeRows.map((row) => ({ folderId: row.folderId || row.id || '', folderName: row.folderName || row.name || '', requestId: row.requestId || '' })),
        receiptRows: receiptProbeRows.map((row) => ({ folderId: row.folderId || row.id || '', folderName: row.folderName || row.name || '', requestId: row.requestId || '', reviewId: row.reviewId || '', receiptId: row.receiptId || '', source: row.source || '', status: row.status || '' })),
        companionRows: companionProbeRows.map((row) => ({ folderId: row.folderId || row.id || '', folderName: row.folderName || row.name || '', requestId: row.requestId || '', reviewId: row.reviewId || '', receiptId: row.receiptId || '', source: row.source || '', status: row.status || '' })),
        existsInNormalRows: normalProbeRows.length > 0,
        existsInHiddenPendingRows: hiddenProbeRows.length > 0,
        existsInRequestStore: requestProbeRows.length > 0,
        existsInReceiptRows: receiptProbeRows.length > 0,
        existsInCompanionRows: companionProbeRows.length > 0,
      },
      rows: companionRows.slice(0, 80).map((row) => ({
        folderId: row.folderId || row.id || '',
        folderName: row.folderName || row.name || '',
        requestId: row.requestId || '',
        reviewId: row.reviewId || '',
        receiptId: row.receiptId || '',
        status: row.status || '',
        source: row.source || '',
        companionStatusLabel: row.companionStatusLabel || '',
        pendingDeleteHidden: row.pendingDeleteHidden === true || row.hiddenByChromePendingDelete === true,
        pendingDeleteRequest: row.pendingDeleteRequest === true,
        pendingRestoreRequest: restoreRequestPendingRows.some((restoreRow) => String(restoreRow.folderId || restoreRow.id || '').trim() === String(row.folderId || row.id || '').trim()),
        desktopReceiptHidden: row.hiddenByDesktopReceipt === true || row.deletedByDesktopReceipt === true,
        desktopCanonicalRecentlyDeleted: row.desktopCanonicalRecentlyDeleted === true,
      })),
      desktopCanonicalRecentlyDeletedRows: desktopCanonicalRows.slice(0, 80).map((row) => ({
        folderId: row.folderId || row.id || '',
        folderName: row.folderName || row.name || '',
        requestId: row.requestId || '',
        reviewId: row.reviewId || '',
        status: row.status || '',
        source: row.source || '',
        companionStatusLabel: row.companionStatusLabel || '',
      })),
      hiddenByChromePendingDeleteRows: hiddenPendingRows.slice(0, 80).map((row) => ({
        folderId: row.folderId || row.id || '',
        folderName: row.folderName || row.name || '',
        status: row.status || '',
        source: row.source || '',
      })),
      pendingDeleteRequestRows: requestRows.slice(0, 80).map((row) => ({
        folderId: row.folderId || row.id || '',
        folderName: row.folderName || row.name || '',
        requestId: row.requestId || '',
        status: row.status || '',
        source: row.source || '',
      })),
      receiptRows: receiptRows.slice(0, 80).map((row) => ({
        folderId: row.folderId || row.id || '',
        folderName: row.folderName || row.name || '',
        requestId: row.requestId || '',
        reviewId: row.reviewId || '',
        receiptId: row.receiptId || '',
        status: row.status || '',
        source: row.source || '',
        companionStatusLabel: row.companionStatusLabel || '',
        trustedDesktopReceiptWithoutLocalRequest: row.trustedDesktopReceiptWithoutLocalRequest === true,
        pendingDeleteConfirmedByDesktopReceipt: row.pendingDeleteConfirmedByDesktopReceipt === true,
      })),
      requestStoreRows: requestRows.slice(0, 80).map((row) => ({
        folderId: row.folderId || row.id || '',
        folderName: row.folderName || row.name || '',
        requestId: row.requestId || '',
        status: row.status || '',
        source: row.source || '',
      })),
      restoreRequestRows: restoreRequestPendingRows.slice(0, 80).map((row) => ({
        folderId: row.folderId || row.id || '',
        folderName: row.folderName || row.name || '',
        requestId: row.requestId || '',
        status: row.status || '',
        source: row.source || '',
      })),
      hiddenWithoutExportableRequestRows: hiddenWithoutExportableRequestRows.slice(0, 80).map((row) => ({
        folderId: row.folderId || row.id || '',
        folderName: row.folderName || row.name || '',
        status: row.status || '',
        source: row.source || '',
      })),
      storageDiagnostics: {
        source: storageSources.source,
        hiddenByChromePendingDeleteChromeCount: storageSources.hiddenByChromePendingDeleteChromeCount,
        hiddenByChromePendingDeleteLocalCount: storageSources.hiddenByChromePendingDeleteLocalCount,
        hiddenByChromePendingDeleteMergedCount: storageSources.hiddenByChromePendingDeleteMergedCount,
        desktopReceiptHiddenMergedCount: storageSources.desktopReceiptHiddenMergedCount,
        desktopCanonicalRecentlyDeletedSource: storageSources.desktopCanonicalRecentlyDeletedSource,
        desktopCanonicalRecentlyDeletedFolderStateCount: storageSources.desktopCanonicalRecentlyDeletedFolderStateCount,
        desktopCanonicalRecentlyDeletedSyncStateCount: storageSources.desktopCanonicalRecentlyDeletedSyncStateCount,
        desktopPurgedFolderSuppressionSource: storageSources.desktopPurgedFolderSuppressionSource,
        desktopPurgedFolderSuppressionFolderStateCount: storageSources.desktopPurgedFolderSuppressionFolderStateCount,
        desktopPurgedFolderSuppressionSyncStateCount: storageSources.desktopPurgedFolderSuppressionSyncStateCount,
        suppressedReceiptRowCount: resurrectedReceiptRows.length,
        suppressedPendingRowCount: resurrectedPendingRows.length,
      },
      chromePermanentDeleteBlocked: true,
      noChromePurgeAuthority: true,
      chromeRestoreDirectApplyBlocked: true,
      noChromeRestoreAuthority: true,
      noChromeTombstoneApply: true,
      noTombstoneApplyOnChrome: true,
      noTombstoneCreateOnChrome: true,
      noHardDelete: true,
      noPurge: true,
      noChatDelete: true,
      noSnapshotDelete: true,
      noAssetDelete: true,
      blockers: diagnosticBlockers,
      warnings: diagnosticWarnings,
    };
  }

  function setChromeRecentlyDeletedStatus(node, message, kind = '') {
    if (!node) return;
    node.textContent = String(message || '');
    node.dataset.kind = String(kind || '');
  }

  async function renderChromeRecentlyDeletedCompanionPanel(host, opts = {}) {
    if (!host || studioPlatformAdapter() !== 'mv3') return { ok: true, skipped: true, status: 'not-chrome-studio' };
    const model = opts?.model && typeof opts.model === 'object' ? opts.model : null;
    const rows = await chromeRecentlyDeletedCompanionRows(model);
    host.innerHTML = '';
    const section = el('section', {
      class: 'wbFolderRecentlyDeleted wbFolderRecentlyDeleted--chromeCompanion',
      'data-h2o-chrome-recently-deleted-companion': '1',
      style: 'display:flex;flex-direction:column;gap:10px;border:1px solid rgba(255,255,255,.08);border-radius:10px;background:rgba(255,255,255,.018);padding:12px 14px;min-width:0;',
    });
    section.appendChild(el('div', {
      style: 'display:flex;align-items:flex-start;justify-content:space-between;gap:10px;min-width:0;',
    }, [
      el('div', { style: 'display:flex;flex-direction:column;gap:2px;min-width:0;' }, [
        el('div', {
          style: 'font-size:11px;color:rgba(255,255,255,.72);letter-spacing:.04em;text-transform:uppercase;font-weight:700;',
        }, `Recently Deleted · ${formatNumber(rows.length)}`),
        el('div', {
          style: 'font-size:10.5px;line-height:1.35;color:rgba(255,255,255,.5);',
        }, 'Chrome companion status. Desktop Studio remains the delete, restore, and permanent delete authority.'),
      ]),
      el('span', {
        style: 'flex:0 0 auto;border:1px solid rgba(125,211,252,.18);border-radius:999px;padding:3px 7px;font-size:10px;line-height:1.2;color:rgba(186,230,253,.86);background:rgba(14,165,233,.08);',
      }, 'Companion'),
    ]));
    const status = el('div', {
      class: 'wbSidebarNativePickerStatus',
      role: 'status',
      'aria-live': 'polite',
      style: 'font-size:10.5px;line-height:1.35;color:rgba(255,255,255,.66);min-height:1em;',
    });
    section.appendChild(status);
    if (!rows.length) {
      section.appendChild(el('div', {
        class: 'wbState',
        style: 'padding:4px 0;text-align:left;color:rgba(255,255,255,.5);font-size:11px;',
      }, 'No Recently Deleted folders in Chrome.'));
      host.appendChild(section);
      return {
        ok: true,
        status: 'chrome-recently-deleted-companion-rendered',
        total: 0,
        chromeRestoreRequestUxAvailable: chromeRestoreRequestUxAvailable(),
        chromeRestoreRequestExportAvailable: chromeRestoreRequestUxAvailable(),
        chromeRestoreRequestPendingCount: 0,
        chromeRestoreDirectApplyBlocked: true,
        noChromeRestoreAuthority: true,
        chromePermanentDeleteBlocked: true,
        noChromePurgeAuthority: true,
        noChromeTombstoneApply: true,
        noChromeTombstoneCreate: true,
        noHardDelete: true,
        noChatDelete: true,
        noSnapshotDelete: true,
        noAssetDelete: true,
      };
    }
    const list = el('div', {
      class: 'wbFolderRecentlyDeletedChromeList',
      style: 'display:flex;flex-direction:column;gap:7px;min-width:0;',
    });
    const restoreRequestAvailable = chromeRestoreRequestUxAvailable();
    const pendingRestoreRows = restoreRequestAvailable ? await loadPendingChromeFolderRestoreRequestRows() : [];
    const pendingRestoreIds = new Set(pendingRestoreRows.map((row) => String(row.folderId || row.id || '').trim()).filter(Boolean));
    rows.forEach((row) => {
      const folderName = recentlyDeletedText(row.folderName || row.name || row.folderId, 'Folder');
      const folderId = recentlyDeletedText(row.folderId || row.id, '');
      const pending = row.pendingDeleteHidden === true || row.hiddenByChromePendingDelete === true;
      const restorePending = pendingRestoreIds.has(folderId);
      const restoreRequestEligible = restoreRequestAvailable &&
        !restorePending &&
        (row.desktopCanonicalRecentlyDeleted === true || String(row.source || row.sourceKind || '').trim() === 'desktop-canonical-recently-deleted') &&
        row.phase6aPermanentlyPurged !== true &&
        row.permanentlySuppressed !== true;
      const statusLabel = restorePending ? 'Restore pending' : (row.companionStatusLabel || (pending ? 'Delete pending' : 'Deleted on Desktop'));
      const item = el('article', {
        class: 'wbFolderRecentlyDeletedChromeRow',
        'data-h2o-chrome-recently-deleted-row': '1',
        'data-h2o-folder-id': folderId,
        style: 'display:flex;flex-direction:column;gap:8px;min-width:0;border:1px solid rgba(255,255,255,.075);border-radius:8px;background:rgba(255,255,255,.025);padding:9px 10px;',
      });
      item.appendChild(el('div', {
        style: 'display:flex;align-items:flex-start;justify-content:space-between;gap:8px;min-width:0;',
      }, [
        el('div', { style: 'min-width:0;display:flex;flex-direction:column;gap:2px;' }, [
          el('div', {
            title: folderName,
            style: 'font-size:12px;font-weight:650;color:rgba(255,255,255,.84);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%;',
          }, folderName),
          el('div', {
            title: folderId,
            style: 'font-size:10px;color:rgba(255,255,255,.42);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%;',
          }, folderId),
        ]),
        el('span', {
          style: 'flex:0 0 auto;border-radius:999px;padding:3px 7px;font-size:10px;line-height:1.2;background:rgba(250,204,21,.08);color:rgba(254,240,138,.9);border:1px solid rgba(250,204,21,.18);',
        }, statusLabel),
      ]));
      const actions = el('div', {
        style: 'display:flex;flex-wrap:wrap;gap:6px;align-items:center;',
      });
      const restoreTitle = restoreRequestAvailable
        ? 'Request restore from Desktop Studio'
        : `${CHROME_RESTORE_REQUEST_EXPORT_DEFERRED_MESSAGE} ${CHROME_RESTORE_DEFERRED_MESSAGE}`;
      const restore = el('button', {
        type: 'button',
        class: 'wbFolderRecentlyDeletedChromeRestoreRequest wbFolderRecentlyDeletedChromeRestoreBlocked',
        'data-h2o-chrome-restore-request-only': '1',
        'data-h2o-chrome-restore-blocked': restoreRequestEligible ? null : '1',
        'data-h2o-chrome-restore-request-deferred': restoreRequestAvailable ? null : '1',
        'data-h2o-chrome-restore-direct-apply-blocked': '1',
        disabled: restoreRequestEligible ? null : 'disabled',
        title: restoreTitle,
        style: restoreRequestEligible
          ? 'border:1px solid rgba(125,211,252,.22);border-radius:7px;background:rgba(14,165,233,.10);color:rgba(186,230,253,.92);font-size:10.5px;line-height:1.2;padding:6px 8px;cursor:pointer;'
          : 'border:1px solid rgba(255,255,255,.12);border-radius:7px;background:rgba(255,255,255,.035);color:rgba(255,255,255,.54);font-size:10.5px;line-height:1.2;padding:6px 8px;cursor:not-allowed;',
      }, restorePending ? 'Restore pending' : CHROME_RESTORE_REQUEST_LABEL);
      if (restoreRequestEligible) {
        restore.addEventListener('click', (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          if (restore.disabled) return;
          restore.disabled = true;
          restore.textContent = 'Restore pending';
          Promise.resolve(requestChromeFolderRestoreFromCompanion(row, { setStatus: (message, kind) => setChromeRecentlyDeletedStatus(status, message, kind) }))
            .finally(() => {
              W.setTimeout(() => {
                renderChromeRecentlyDeletedCompanionPanel(host, { model }).catch((e) => err('chromeRestoreRequests.renderAfterRequest', e));
              }, 250);
            });
        });
      }
      const permanentDelete = el('button', {
        type: 'button',
        class: 'wbFolderRecentlyDeletedChromePermanentDeleteBlocked',
        'data-h2o-chrome-permanent-delete-blocked': '1',
        disabled: 'disabled',
        title: CHROME_PERMANENT_DELETE_BLOCKED_MESSAGE,
        style: 'border:1px solid rgba(248,113,113,.18);border-radius:7px;background:rgba(127,29,29,.08);color:rgba(254,202,202,.58);font-size:10.5px;line-height:1.2;padding:6px 8px;cursor:not-allowed;',
      }, CHROME_PERMANENT_DELETE_BLOCKED_MESSAGE);
      actions.appendChild(restore);
      actions.appendChild(permanentDelete);
      item.appendChild(actions);
      item.appendChild(el('div', {
        class: 'wbFolderRecentlyDeletedChromeRestoreRequestNote',
        'data-h2o-chrome-restore-request-6c2-blocker': restoreRequestAvailable ? null : '1',
        style: 'font-size:10.5px;line-height:1.35;color:rgba(255,255,255,.52);overflow-wrap:anywhere;',
      }, restoreRequestAvailable
        ? (restorePending ? 'Restore pending. Desktop Studio must apply it before this folder returns.' : 'Request-only. Desktop Studio must apply restore before this folder returns.')
        : CHROME_RESTORE_REQUEST_EXPORT_DEFERRED_MESSAGE));
      list.appendChild(item);
    });
    section.appendChild(list);
    host.appendChild(section);
    return {
      ok: true,
      status: 'chrome-recently-deleted-companion-rendered',
      total: rows.length,
      chromeRestoreRequestUxAvailable: restoreRequestAvailable,
      chromeRestoreRequestExportAvailable: restoreRequestAvailable,
      chromeRestoreRequestPendingCount: pendingRestoreRows.length,
      chromeRestoreDirectApplyBlocked: true,
      noChromeRestoreAuthority: true,
      chromePermanentDeleteBlocked: true,
      noChromePurgeAuthority: true,
      noChromeTombstoneApply: true,
      noChromeTombstoneCreate: true,
      noHardDelete: true,
      noChatDelete: true,
      noSnapshotDelete: true,
      noAssetDelete: true,
    };
  }

  async function renderRecentlyDeletedFoldersSidebarEntry(host) {
    if (studioPlatformAdapter() === 'mv3') return;
    if (!host || !canUseDesktopRecentlyDeletedFolders()) return;
    const entry = el('a', {
      class: 'wbSidebarSectionMore wbFolderRecentlyDeletedSidebarEntry',
      href: '#/library/folders',
      'data-h2o-recently-deleted-folders-sidebar-entry': '1',
      style: 'margin-top:6px',
      title: 'Open Recently Deleted in the main Folders page',
    }, 'Recently Deleted');
    host.appendChild(entry);

    const store = desktopFolderStore();
    const listFn = typeof store?.listRecentlyDeletedFolders === 'function'
      ? store.listRecentlyDeletedFolders
      : store?.diagnoseRecentlyDeletedFolders;
    try {
      const result = await listFn.call(store, { limit: 500, source: 'desktop-recently-deleted-sidebar-counter' });
      const rows = recentlyDeletedRowsFromResult(result);
      entry.textContent = `Recently Deleted · ${formatNumber(rows.length)}`;
    } catch (e) {
      err('recentlyDeleted.sidebarEntry', e);
      entry.title = `Recently Deleted diagnostics unavailable: ${String(e?.message || e || 'list failed')}`;
    }
    entry.addEventListener('click', () => {
      W.setTimeout(() => {
        try {
          D.querySelector('[data-h2o-recently-deleted-folders="main"]')?.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
        } catch {}
      }, 160);
    });
  }

  function menuTitleForKind(kind) {
    if (kind === 'folders') return 'Folder actions';
    if (kind === 'categories') return 'Category appearance';
    if (kind === 'labels') return 'Label appearance';
    if (kind === 'projects') return 'Project appearance';
    return 'Item options';
  }

  let activeRowMenu = null;
  let activeRowMenuOff = null;

  function closeRowMenu() {
    if (typeof activeRowMenuOff === 'function') {
      try { activeRowMenuOff(); } catch {}
    }
    activeRowMenuOff = null;
    if (activeRowMenu) {
      try { activeRowMenu.remove(); } catch {}
    }
    activeRowMenu = null;
    D.querySelectorAll('.wbSidebarSectionItemMenu[aria-expanded="true"], .wbFolderMenuBtn[aria-expanded="true"], [data-h2o-folder-create-button="1"][aria-expanded="true"]')
      .forEach((btn) => btn.setAttribute('aria-expanded', 'false'));
  }

  function positionRowMenu(pop, anchorEl) {
    if (!pop?.isConnected || !anchorEl?.isConnected) return;
    const pad = 8;
    const gap = 6;
    const vw = Math.max(320, W.innerWidth || D.documentElement.clientWidth || 0);
    const vh = Math.max(240, W.innerHeight || D.documentElement.clientHeight || 0);
    const rA = anchorEl.getBoundingClientRect();
    let rP = pop.getBoundingClientRect();
    const width = Math.min(rP.width || 320, vw - pad * 2);
    let left = Math.min(rA.right - width, vw - width - pad);
    left = Math.max(pad, left);
    const spaceBelow = Math.max(0, vh - rA.bottom - gap - pad);
    const spaceAbove = Math.max(0, rA.top - gap - pad);
    const preferAbove = spaceBelow < Math.min(rP.height || 360, 320) && spaceAbove > spaceBelow;
    pop.style.maxHeight = `${Math.max(160, Math.min(vh - pad * 2, preferAbove ? spaceAbove : Math.max(spaceBelow, spaceAbove)))}px`;
    rP = pop.getBoundingClientRect();
    let top = preferAbove ? (rA.top - gap - rP.height) : (rA.bottom + gap);
    if (top + rP.height > vh - pad) top = vh - rP.height - pad;
    if (top < pad) top = pad;
    pop.style.left = `${left}px`;
    pop.style.top = `${top}px`;
  }

  function applyMenuColor(item, color) {
    const kind = normalizeMenuKind(item.kind || item.section);
    if (kind === 'categories') return writeNativeCategoryAppearance(item.id, { color });
    if (kind === 'folders') {
      if (item.isCanonical === true) return false;
      writeLocalRowAppearance(item, { color });
      return writeNativeFolderColor(item.id, color);
    }
    return false;
  }

  function applyMenuIcon(item, icon) {
    const kind = normalizeMenuKind(item.kind || item.section);
    if (kind === 'categories') return writeNativeCategoryAppearance(item.id, { icon });
    return false;
  }

  function makeMenuColorPicker(item, currentColor = '', opts = {}) {
    const current = normalizeHexColor(currentColor || '');
    const onSelect = typeof opts.onSelect === 'function' ? opts.onSelect : null;
    const keepOpen = opts.keepOpen === true;
    const section = el('div', { class: 'wbSidebarNativePickerSection' }, [
      el('div', { class: 'wbSidebarNativePickerLabel' }, String(opts.label || 'Color')),
    ]);
    const grid = el('div', { class: 'wbSidebarNativeColorGrid' });
    const status = opts.status
      ? el('div', {
        class: 'wbSidebarNativePickerStatus',
        role: 'status',
        'aria-live': 'polite',
        style: 'display:none;margin-top:6px;font-size:10.5px;line-height:1.35;color:rgba(255,255,255,.62)',
      })
      : null;
    const setStatus = (message, kind = '') => {
      if (!status) return;
      const text = String(message || '');
      status.textContent = text;
      status.dataset.kind = String(kind || '');
      status.style.display = text ? 'block' : 'none';
    };
    SIDEBAR_MENU_COLORS.forEach((option) => {
      const value = normalizeHexColor(option.value || option.color || '');
      const btn = el('button', {
        class: `wbSidebarNativeSwatch${value ? '' : ' is-default'}`,
        type: 'button',
        title: option.label,
        'aria-label': option.label,
        'aria-pressed': value === current ? 'true' : 'false',
      });
      btn.style.setProperty('--swatch-color', value || 'transparent');
      if (!value) btn.appendChild(el('span', { class: 'wbSidebarNativeSwatchSlash', 'aria-hidden': 'true' }));
      btn.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        if (onSelect) {
          Promise.resolve(onSelect(value, { setStatus, statusEl: status, button: btn }))
            .catch((e) => {
              err('menuColorPicker.onSelect', e);
              setStatus(`Blocked: ${String(e?.message || e || 'color-request-failed')}`, 'blocked');
            });
          return;
        }
        if (!keepOpen) closeRowMenu();
        applyMenuColor(item, value);
      });
      grid.appendChild(btn);
    });
    section.appendChild(grid);
    if (status) section.appendChild(status);
    return section;
  }

  function makeCanonicalFolderColorPicker(item, currentColor, pop, anchorEl) {
    const picker = makeMenuColorPicker(item, currentColor, {
      label: 'Color',
      status: true,
      keepOpen: true,
      onSelect: (value, controls) => requestCanonicalFolderColor(item, value, controls),
    });
    picker.hidden = true;
    picker.dataset.menuItem = 'canonical-folder-color-picker';
    const action = makeMenuAction('Change color', SIDEBAR_MENU_ACTION_SVGS.palette, () => {
      picker.hidden = !picker.hidden;
      action.setAttribute('aria-expanded', picker.hidden ? 'false' : 'true');
      if (!picker.hidden) {
        W.requestAnimationFrame(() => {
          try { positionRowMenu(pop, anchorEl); } catch {}
          try { picker.querySelector('button')?.focus?.(); } catch {}
        });
      }
    }, {
      keepOpen: true,
      title: 'Change folder color',
    });
    action.setAttribute('aria-haspopup', 'true');
    action.setAttribute('aria-expanded', 'false');
    return [action, picker];
  }

  function makeCanonicalFolderRenamePanel(item, pop, anchorEl) {
    let currentName = normalizeFolderRenameInput(item?.name || '');
    let currentItem = item;
    let currentNameRequestSeq = 0;
    const panel = el('div', {
      class: 'wbSidebarNativePickerSection',
      style: 'display:none;flex-direction:column;gap:7px;min-width:220px',
      'data-menu-item': 'canonical-folder-rename-panel',
    });
    panel.appendChild(el('div', { class: 'wbSidebarNativePickerLabel' }, 'Rename folder'));
    const input = el('input', {
      type: 'text',
      value: currentName,
      'aria-label': 'Folder name',
      autocomplete: 'off',
      spellcheck: 'false',
      style: 'width:100%;box-sizing:border-box;padding:6px 8px;border-radius:6px;border:1px solid rgba(255,255,255,.16);background:rgba(0,0,0,.20);color:inherit;font:inherit;font-size:12px;outline:none',
    });
    const status = el('div', {
      class: 'wbSidebarNativePickerStatus',
      role: 'status',
      'aria-live': 'polite',
      style: 'display:none;font-size:10.5px;line-height:1.35;color:rgba(255,255,255,.62)',
    });
    const setStatus = (message, kind = '') => {
      const text = String(message || '');
      status.textContent = text;
      status.dataset.kind = String(kind || '');
      status.style.display = text ? 'block' : 'none';
    };
    const buttonRow = el('div', {
      style: 'display:flex;gap:6px;justify-content:flex-end;align-items:center',
    });
    const cancel = el('button', {
      type: 'button',
      style: 'padding:5px 8px;border-radius:6px;border:1px solid rgba(255,255,255,.13);background:rgba(255,255,255,.05);color:inherit;font:inherit;font-size:12px;cursor:pointer',
    }, 'Cancel');
    const submit = el('button', {
      type: 'button',
      style: 'padding:5px 9px;border-radius:6px;border:1px solid rgba(125,211,252,.34);background:rgba(59,130,246,.18);color:inherit;font:inherit;font-size:12px;cursor:pointer',
    }, 'Rename');
    buttonRow.appendChild(cancel);
    buttonRow.appendChild(submit);
    panel.appendChild(input);
    panel.appendChild(buttonRow);
    panel.appendChild(status);

    let pendingRename = false;
    const syncSubmit = () => {
      const nextName = normalizeFolderRenameInput(input.value);
      input.disabled = pendingRename;
      cancel.disabled = pendingRename;
      submit.disabled = pendingRename || !nextName || nextName === currentName;
      submit.style.opacity = submit.disabled ? '.55' : '1';
      submit.style.cursor = submit.disabled ? 'not-allowed' : 'pointer';
      cancel.style.opacity = pendingRename ? '.55' : '1';
      cancel.style.cursor = pendingRename ? 'not-allowed' : 'pointer';
    };
    const refreshPanelCurrentName = async () => {
      const seq = ++currentNameRequestSeq;
      const previousName = currentName;
      const inputNameAtStart = normalizeFolderRenameInput(input.value);
      const freshItem = await resolveFreshCanonicalFolderItem(currentItem);
      if (seq !== currentNameRequestSeq || pendingRename || panel.style.display === 'none') return currentItem;
      if (freshItem) currentItem = freshItem;
      const freshName = normalizeFolderRenameInput(currentItem?.name || currentItem?.title || currentName);
      if (freshName) {
        currentName = freshName;
        if (!inputNameAtStart || inputNameAtStart === previousName) input.value = freshName;
      }
      syncSubmit();
      try { positionRowMenu(pop, anchorEl); } catch {}
      return currentItem;
    };
    const showPanel = () => {
      panel.style.display = panel.style.display === 'none' ? 'flex' : 'none';
      action.setAttribute('aria-expanded', panel.style.display === 'none' ? 'false' : 'true');
      if (panel.style.display !== 'none') {
        input.value = currentName;
        setStatus('', '');
        syncSubmit();
        refreshPanelCurrentName().catch((e) => err('folderRename.refreshPanelCurrentName', e));
        W.requestAnimationFrame(() => {
          try { positionRowMenu(pop, anchorEl); } catch {}
          try { input.focus(); input.select(); } catch {}
        });
      }
    };
    const submitRename = () => {
      const nextName = normalizeFolderRenameInput(input.value);
      if (!nextName) {
        setStatus('Blocked: invalid-folder-name', 'blocked');
        syncSubmit();
        return;
      }
      pendingRename = true;
      syncSubmit();
      Promise.resolve(resolveFreshCanonicalFolderItem(currentItem))
        .then((freshItem) => {
          if (freshItem) currentItem = freshItem;
          const freshName = normalizeFolderRenameInput(currentItem?.name || currentItem?.title || currentName);
          if (freshName) currentName = freshName;
          if (freshName && nextName === freshName) {
            setStatus('Name already current', 'ok');
            return { ok: true, applied: false, noMutation: true, warnings: [{ code: 'no-op-name-unchanged' }] };
          }
          return requestCanonicalFolderRename(currentItem, nextName, { setStatus });
        })
        .then((result) => {
          pendingRename = false;
          const resultName = normalizeFolderRenameInput(result?.after?.name || result?.after?.title || nextName);
          if (result?.ok && resultName) {
            currentName = resultName;
            currentItem = { ...currentItem, name: resultName, title: resultName };
          }
          syncSubmit();
          if (result?.ok && result.applied === true) {
            W.setTimeout(() => closeRowMenu(), 750);
          }
        })
        .catch((e) => {
          pendingRename = false;
          err('folderRename.panel', e);
          setStatus(`Blocked: ${String(e?.message || e || 'rename-failed')}`, 'blocked');
          syncSubmit();
        });
    };
    input.addEventListener('input', syncSubmit);
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') {
        ev.preventDefault();
        if (pendingRename) return;
        panel.style.display = 'none';
        action.setAttribute('aria-expanded', 'false');
        return;
      }
      if (ev.key === 'Enter') {
        ev.preventDefault();
        if (!submit.disabled) submitRename();
      }
    });
    cancel.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      if (pendingRename) return;
      panel.style.display = 'none';
      action.setAttribute('aria-expanded', 'false');
    });
    submit.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      if (!submit.disabled) submitRename();
    });

    const action = makeMenuAction('Rename folder', SIDEBAR_MENU_ACTION_SVGS.rename, showPanel, {
      keepOpen: true,
      title: 'Rename canonical folder through Native owner',
    });
    action.setAttribute('aria-haspopup', 'true');
    action.setAttribute('aria-expanded', 'false');
    syncSubmit();
    return [action, panel];
  }

  function makeCanonicalFolderDeletePreviewPanel(item, pop, anchorEl) {
    const panel = el('div', {
      class: 'wbSidebarNativePickerSection',
      style: 'display:none;flex-direction:column;gap:7px;min-width:240px;max-width:320px',
      'data-menu-item': 'canonical-folder-delete-preview-panel',
    });
    panel.appendChild(el('div', { class: 'wbSidebarNativePickerLabel' }, 'Delete preview'));
    const body = el('div', {
      style: 'display:flex;flex-direction:column;gap:5px;font-size:11px;line-height:1.35;color:rgba(255,255,255,.72)',
    });
    const status = el('div', {
      class: 'wbSidebarNativePickerStatus',
      role: 'status',
      'aria-live': 'polite',
      style: 'display:none;font-size:10.5px;line-height:1.35;color:rgba(255,255,255,.62)',
    });
    const setStatus = (message, kind = '') => {
      const text = String(message || '');
      status.textContent = text;
      status.dataset.kind = String(kind || '');
      status.style.display = text ? 'block' : 'none';
    };
    const confirmWrap = el('div', {
      style: 'display:flex;flex-direction:column;gap:6px;margin-top:2px',
      'data-menu-item': 'canonical-folder-delete-apply-controls',
    });
    const confirmHint = el('div', {
      style: 'font-size:10.5px;line-height:1.35;color:rgba(255,255,255,.62)',
    }, `Type ${FOLDER_METADATA_DELETE_CONFIRMATION_TEXT} to enable delete.`);
    const confirmInput = el('input', {
      type: 'text',
      autocomplete: 'off',
      spellcheck: 'false',
      placeholder: FOLDER_METADATA_DELETE_CONFIRMATION_TEXT,
      'aria-label': `Type ${FOLDER_METADATA_DELETE_CONFIRMATION_TEXT} to confirm folder delete`,
      style: 'width:100%;box-sizing:border-box;border:1px solid rgba(255,255,255,.12);border-radius:8px;background:rgba(0,0,0,.22);color:rgba(255,255,255,.92);padding:7px 8px;font-size:11px;line-height:1.3;outline:none',
    });
    const buttonRow = el('div', { style: 'display:flex;justify-content:flex-end;gap:6px' });
    const cancelDelete = el('button', {
      type: 'button',
      class: 'wbSidebarNativeAction',
      style: 'padding:6px 8px;font-size:11px;min-height:28px',
    }, 'Cancel');
    const submitDelete = el('button', {
      type: 'button',
      class: 'wbSidebarNativeAction wbSidebarNativeAction--danger',
      style: 'padding:6px 8px;font-size:11px;min-height:28px',
    }, 'Delete');
    buttonRow.appendChild(cancelDelete);
    buttonRow.appendChild(submitDelete);
    confirmWrap.appendChild(confirmHint);
    confirmWrap.appendChild(confirmInput);
    confirmWrap.appendChild(buttonRow);

    let latestPreview = null;
    let latestPreviewAt = 0;
    let pendingPreview = false;
    let pendingApply = false;
    let action = null;
    const confirmationMatches = () => confirmInput.value.trim() === FOLDER_METADATA_DELETE_CONFIRMATION_TEXT;
    const syncDeleteControls = () => {
      const eligible = canRequestCanonicalFolderDeleteApply(item) && canApplyDeletePreview(latestPreview, item);
      const busy = pendingPreview || pendingApply;
      const canSubmit = eligible && !busy && confirmationMatches();
      confirmInput.disabled = busy || !eligible;
      submitDelete.disabled = !canSubmit;
      submitDelete.setAttribute('aria-disabled', canSubmit ? 'false' : 'true');
      if (!latestPreview) {
        confirmHint.textContent = 'Preview the folder before delete.';
      } else if (!eligible) {
        const blocker = deletePreviewHardBlockers(latestPreview)[0]
          || (deletePreviewMembershipCount(latestPreview, item) > 0 ? 'delete-non-empty-folder-blocked' : 'delete-preview-not-applyable');
        confirmHint.textContent = `Blocked: ${blocker}`;
      } else if (!confirmationMatches()) {
        confirmHint.textContent = `Type ${FOLDER_METADATA_DELETE_CONFIRMATION_TEXT} to enable delete.`;
      } else {
        confirmHint.textContent = 'Ready to delete this empty folder through Native owner.';
      }
    };
    const renderLine = (label, value, opts = {}) => {
      const row = el('div', { style: 'display:flex;gap:8px;justify-content:space-between;align-items:flex-start' });
      row.appendChild(el('span', { style: 'color:rgba(255,255,255,.52)' }, label));
      row.appendChild(el('span', {
        style: `${opts.mono ? 'font-family:ui-monospace,SFMono-Regular,Menlo,monospace;' : ''}text-align:right;min-width:0;overflow-wrap:anywhere`,
      }, value));
      return row;
    };
    const renderCodes = (label, codes) => {
      const values = Array.isArray(codes) ? codes.filter(Boolean) : [];
      const box = el('div', { style: 'display:flex;flex-direction:column;gap:3px' });
      box.appendChild(el('div', { style: 'color:rgba(255,255,255,.52)' }, label));
      if (!values.length) {
        box.appendChild(el('div', { style: 'color:rgba(255,255,255,.78)' }, 'none'));
        return box;
      }
      values.forEach((code) => {
        box.appendChild(el('code', {
          style: 'display:block;padding:2px 5px;border-radius:5px;background:rgba(255,255,255,.06);font-size:10.5px;white-space:normal;overflow-wrap:anywhere',
        }, code));
      });
      return box;
    };
    const renderPreview = (preview = null) => {
      body.innerHTML = '';
      const before = preview?.before && typeof preview.before === 'object' ? preview.before : {};
      const deps = preview?.dependencySummary && typeof preview.dependencySummary === 'object' ? preview.dependencySummary : {};
      const folderId = String(preview?.folderId || item?.folderId || item?.id || '').trim();
      const folderName = String(before.name || deps.folderName || item?.name || item?.title || folderId || 'Folder');
      const membershipCount = deletePreviewMembershipCount(preview, item);
      const itemBucketEmpty = deletePreviewItemBucketEmpty(preview);
      const confirmation = String(preview?.requiredConfirmation || preview?.confirmation?.text || FOLDER_METADATA_DELETE_CONFIRMATION_TEXT);
      const blockers = resultCodes(preview, 'blockers');
      const warnings = resultCodes(preview, 'warnings');
      body.appendChild(renderLine('Folder', folderName));
      body.appendChild(renderLine('Folder ID', shortFolderId(folderId), { mono: true }));
      body.appendChild(renderLine('Native members', String(membershipCount)));
      body.appendChild(renderLine('Item bucket', itemBucketEmpty ? 'empty' : 'not empty'));
      body.appendChild(renderLine('Required confirmation', confirmation, { mono: true }));
      body.appendChild(renderCodes('Blockers', blockers));
      body.appendChild(renderCodes('Warnings', warnings));
      body.appendChild(el('div', {
        style: 'margin-top:2px;color:rgba(255,255,255,.62)',
      }, membershipCount > 0
        ? 'Delete is blocked because the canonical folder is not empty.'
        : 'Empty folder delete can apply only after exact confirmation.'));
      syncDeleteControls();
    };
    renderPreview(null);
    panel.appendChild(body);
    panel.appendChild(confirmWrap);
    panel.appendChild(status);

    const rememberPreview = (preview) => {
      latestPreview = preview && typeof preview === 'object' ? preview : null;
      latestPreviewAt = latestPreview ? Date.now() : 0;
      renderPreview(latestPreview);
      syncDeleteControls();
    };
    const runPreview = () => {
      if (pendingPreview) return;
      pendingPreview = true;
      syncDeleteControls();
      renderPreview(null);
      Promise.resolve(requestCanonicalFolderDeletePreview(item, { setStatus }))
        .then((preview) => {
          pendingPreview = false;
          rememberPreview(preview);
          try { positionRowMenu(pop, anchorEl); } catch {}
        })
        .catch((e) => {
          pendingPreview = false;
          err('folderDelete.previewPanel', e);
          setStatus(`Blocked: ${String(e?.message || e || 'delete-preview-failed')}`, 'blocked');
          syncDeleteControls();
          try { positionRowMenu(pop, anchorEl); } catch {}
        });
    };
    const submitDeleteRequest = () => {
      if (pendingApply || submitDelete.disabled) return;
      pendingApply = true;
      syncDeleteControls();
      Promise.resolve(requestCanonicalFolderDeleteApply(item, latestPreview, confirmInput.value.trim(), {
        setStatus,
        previewAt: latestPreviewAt,
        onPreview: rememberPreview,
      }))
        .then((result) => {
          pendingApply = false;
          if (result?.ok && result.applied === true) {
            confirmInput.value = '';
            syncDeleteControls();
            W.setTimeout(() => {
              try { positionRowMenu(pop, anchorEl); } catch {}
            }, 0);
            return;
          }
          syncDeleteControls();
          try { positionRowMenu(pop, anchorEl); } catch {}
        })
        .catch((e) => {
          pendingApply = false;
          err('folderDelete.applyPanel', e);
          setStatus(`Blocked: ${String(e?.message || e || 'delete-apply-failed')}`, 'blocked');
          syncDeleteControls();
          try { positionRowMenu(pop, anchorEl); } catch {}
        });
    };
    confirmInput.addEventListener('input', syncDeleteControls);
    confirmInput.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') {
        ev.preventDefault();
        if (pendingPreview || pendingApply) return;
        panel.style.display = 'none';
        action?.setAttribute('aria-expanded', 'false');
        return;
      }
      if (ev.key === 'Enter') {
        ev.preventDefault();
        submitDeleteRequest();
      }
    });
    cancelDelete.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      if (pendingPreview || pendingApply) return;
      panel.style.display = 'none';
      action?.setAttribute('aria-expanded', 'false');
    });
    submitDelete.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      submitDeleteRequest();
    });
    const showPanel = () => {
      panel.style.display = panel.style.display === 'none' ? 'flex' : 'none';
      action.setAttribute('aria-expanded', panel.style.display === 'none' ? 'false' : 'true');
      if (panel.style.display !== 'none') {
        setStatus('', '');
        confirmInput.value = '';
        latestPreview = null;
        latestPreviewAt = 0;
        syncDeleteControls();
        runPreview();
        W.requestAnimationFrame(() => {
          try { positionRowMenu(pop, anchorEl); } catch {}
          try { confirmInput.focus(); } catch {}
        });
      }
    };
    action = makeMenuAction('Delete folder', SIDEBAR_MENU_ACTION_SVGS.delete, showPanel, {
      keepOpen: true,
      danger: true,
      title: 'Delete an empty canonical folder through Native owner',
    });
    action.setAttribute('aria-haspopup', 'true');
    action.setAttribute('aria-expanded', 'false');
    syncDeleteControls();
    return [action, panel];
  }

  function makeDesktopFolderSoftDeletePanel(item, pop, anchorEl) {
    const blocker = desktopFolderSoftDeleteBlocker(item);
    if (blocker) {
      return [makeMenuAction('Move to Recently Deleted', SIDEBAR_MENU_ACTION_SVGS.delete, null, {
        danger: true,
        disabled: true,
        title: `Blocked: ${blocker}`,
      })];
    }
    let pendingApply = false;
    let action = null;
    const panel = el('div', {
      class: 'wbSidebarNativePickerSection',
      'data-menu-item': 'desktop-folder-soft-delete-panel',
      style: 'display:none;flex-direction:column;gap:6px;',
    });
    panel.appendChild(el('div', { class: 'wbSidebarNativePickerLabel' }, 'Move folder to Recently Deleted'));
    const affectedChatCount = Math.max(
      numericFolderMenuValue(item, ['knownCount', 'knownStudioCount']),
      numericFolderMenuValue(item, ['localBindingCount', 'bindingCount']),
      numericFolderMenuValue(item, ['canonicalCount', 'nativeMembershipCount', 'count']),
      numericFolderMenuValue(item, ['savedCount', 'linkedCount'])
    );
    panel.appendChild(el('div', {
      style: 'font-size:10.5px;line-height:1.35;color:rgba(255,255,255,.62);margin-bottom:4px;',
    }, affectedChatCount > 0
      ? `${affectedChatCount} ${affectedChatCount === 1 ? 'chat moves' : 'chats move'} to Unfiled. No chats are deleted. Restore can reattach eligible chats.`
      : 'Empty folders can be restored from the tombstone recovery snapshot. No chats are deleted.'));
    const buttonRow = el('div', {
      style: 'display:flex;gap:6px;align-items:center;justify-content:flex-end;margin-top:2px;',
    });
    const cancel = el('button', {
      class: 'wbSidebarNativeAction',
      type: 'button',
      style: 'font-size:11px;padding:5px 8px;',
    }, 'Cancel');
    const submit = el('button', {
      class: 'wbSidebarNativeAction wbSidebarNativeAction--danger',
      type: 'button',
      style: 'font-size:11px;padding:5px 8px;',
    }, 'Move');
    buttonRow.appendChild(cancel);
    buttonRow.appendChild(submit);
    const status = el('div', {
      class: 'wbSidebarNativePickerStatus',
      role: 'status',
      'aria-live': 'polite',
      style: 'display:none;margin-top:2px;font-size:10.5px;line-height:1.35;color:rgba(255,255,255,.62)',
    });
    panel.appendChild(buttonRow);
    panel.appendChild(status);
    const setStatus = (message, kind = '') => {
      const text = String(message || '');
      status.textContent = text;
      status.dataset.kind = String(kind || '');
      status.style.display = text ? 'block' : 'none';
    };
    const syncControls = () => {
      submit.disabled = pendingApply;
      submit.setAttribute('aria-disabled', pendingApply ? 'true' : 'false');
      cancel.disabled = pendingApply;
      cancel.setAttribute('aria-disabled', pendingApply ? 'true' : 'false');
      submit.style.opacity = pendingApply ? '.55' : '1';
      submit.style.cursor = pendingApply ? 'not-allowed' : 'pointer';
    };
    const applyDelete = () => {
      if (pendingApply || submit.disabled) return;
      pendingApply = true;
      syncControls();
      Promise.resolve(requestDesktopFolderSoftDelete(item, { setStatus }))
        .finally(() => {
          pendingApply = false;
          syncControls();
        });
    };
    cancel.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      if (pendingApply) return;
      panel.style.display = 'none';
      action?.setAttribute('aria-expanded', 'false');
      setStatus('');
      W.requestAnimationFrame(() => {
        try { positionRowMenu(pop, anchorEl); } catch {}
      });
    });
    submit.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      applyDelete();
    });
    action = makeMenuAction('Move to Recently Deleted', SIDEBAR_MENU_ACTION_SVGS.delete, () => {
      panel.style.display = panel.style.display === 'none' ? 'flex' : 'none';
      action.setAttribute('aria-expanded', panel.style.display === 'none' ? 'false' : 'true');
      if (panel.style.display !== 'none') {
        setStatus('');
        W.requestAnimationFrame(() => {
          try { positionRowMenu(pop, anchorEl); } catch {}
          try { submit.focus?.(); } catch {}
        });
      }
    }, {
      keepOpen: true,
      danger: true,
      title: 'Soft-delete this empty folder locally; restore remains available.',
    });
    action.setAttribute('aria-haspopup', 'true');
    action.setAttribute('aria-expanded', 'false');
    syncControls();
    return [action, panel];
  }

  function makeChromeFolderDeleteRequestPanel(item, pop, anchorEl) {
    const blocker = chromeFolderDeleteRequestBlocker(item);
    const label = 'Delete';
    if (blocker) {
      return [makeMenuAction(label, SIDEBAR_MENU_ACTION_SVGS.delete, null, {
        danger: true,
        disabled: true,
        title: 'Cannot delete this folder.',
      })];
    }
    let pending = false;
    const action = makeMenuAction(label, SIDEBAR_MENU_ACTION_SVGS.delete, () => {
      if (pending) return;
      pending = true;
      Promise.resolve(requestChromeFolderDelete(item, { setStatus: () => {} }))
        .finally(() => {
          pending = false;
          W.requestAnimationFrame(() => {
            try { positionRowMenu(pop, anchorEl); } catch {}
          });
        });
    }, {
      keepOpen: true,
      danger: true,
      title: 'Move to Recently Deleted through Desktop review',
    });
    return [action];
  }

  function folderHrefForId(folderId) {
    const id = String(folderId || '').trim();
    if (!id) return '';
    return getRouteSvc()?.buildLibraryHash?.('folder', id) || `#/library/folder/${encodeURIComponent(id)}`;
  }

  function openFolderRoute(folderId) {
    const href = folderHrefForId(folderId);
    if (!href) return false;
    W.location.hash = href.startsWith('#') ? href : `#${href}`;
    return true;
  }

  function countKnownUnfiledRows() {
    try {
      const rows = getIndex()?.getAll?.();
      if (!Array.isArray(rows)) return 0;
      return rows.filter((row) => {
        const folderId = String(row?.folderId || row?.folder || '').trim();
        const folderIds = Array.isArray(row?.folderIds) ? row.folderIds.filter((id) => String(id || '').trim()) : [];
        return !folderId && folderIds.length === 0;
      }).length;
    } catch (e) {
      err('countKnownUnfiledRows', e);
      return 0;
    }
  }

  function buildUnfiledSidebarItem() {
    const knownCount = countKnownUnfiledRows();
    const href = folderHrefForId(FOLDER_FILTER_NONE) || `#/library/folder/${encodeURIComponent(FOLDER_FILTER_NONE)}`;
    return {
      id: FOLDER_FILTER_NONE,
      folderId: FOLDER_FILTER_NONE,
      name: 'Unfiled',
      count: knownCount,
      displayCountLabel: `${formatNumber(knownCount)} known here`,
      knownCount,
      knownStudioCount: knownCount,
      badges: [],
      isCanonical: false,
      isSystem: true,
      isUnfiled: true,
      disableMenu: true,
      href,
      iconKey: 'unfiled',
      iconSvg: SIDEBAR_UNFILED_ICON_SVG,
    };
  }

  function copyTextValue(value) {
    const text = String(value || '').trim();
    if (!text) return false;
    if (W.navigator?.clipboard?.writeText) {
      W.navigator.clipboard.writeText(text).catch((e) => err('copyTextValue', e));
      return true;
    }
    try { W.prompt?.('Folder ID', text); return true; }
    catch (e) { err('copyTextFallback', e); return false; }
  }

  function makeMenuIconPicker(item, currentIcon = 'hash') {
    const current = normalizeCategoryIcon(currentIcon || 'hash');
    const section = el('div', { class: 'wbSidebarNativePickerSection' }, [
      el('div', { class: 'wbSidebarNativePickerLabel' }, 'Icon'),
    ]);
    const grid = el('div', { class: 'wbSidebarNativeIconGrid' });
    SIDEBAR_MENU_ICON_KEYS.forEach((key) => {
      const btn = el('button', {
        class: 'wbSidebarNativeIconChoice',
        type: 'button',
        title: key,
        'aria-label': key,
        'aria-pressed': key === current ? 'true' : 'false',
      });
      btn.innerHTML = SIDEBAR_ICON_SVGS[key] || SIDEBAR_ICON_SVGS.hash;
      btn.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        closeRowMenu();
        applyMenuIcon(item, key);
      });
      grid.appendChild(btn);
    });
    section.appendChild(grid);
    return section;
  }

  function makeCategoryTagsPicker(item) {
    const categoryId = String(item.id || '').trim();
    const section = el('div', { class: 'wbSidebarNativeTags' });
    section.appendChild(el('div', { class: 'wbSidebarNativePickerLabel' }, 'Tags'));
    const row = el('div', { class: 'wbSidebarNativeTagAdd' });
    const input = el('input', {
      class: 'wbSidebarNativeTagInput',
      type: 'text',
      placeholder: 'Tag name...',
      'aria-label': 'Tag name',
    });
    const add = el('button', {
      class: 'wbSidebarNativeTagAddButton',
      type: 'button',
      title: 'Link tag',
      'aria-label': 'Link tag',
    });
    add.innerHTML = SIDEBAR_MENU_ACTION_SVGS.plus;
    row.appendChild(input);
    row.appendChild(add);
    const summary = el('div', { class: 'wbSidebarNativeTagSummary' });
    const list = el('div', { class: 'wbSidebarNativeTagList' });

    const renderRows = () => {
      const query = String(input.value || '').trim().toLowerCase();
      const tags = collectMenuTags(categoryId)
        .filter((tag) => !query || tag.label.toLowerCase().includes(query) || tag.id.includes(query))
        .slice(0, 8);
      list.innerHTML = '';
      const linkedCount = collectMenuTags(categoryId).filter((tag) => tag.linked).length;
      summary.textContent = `${linkedCount} tag${linkedCount === 1 ? '' : 's'} linked to ${item.name || 'this category'}`;
      if (!tags.length) {
        list.appendChild(el('div', { class: 'wbSidebarNativeTagEmpty' }, query ? 'No matching tags' : 'No tags yet'));
        return;
      }
      tags.forEach((tag) => {
        const label = el('label', { class: 'wbSidebarNativeTagRow' });
        const checkbox = D.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = !!tag.linked;
        checkbox.addEventListener('change', () => {
          setTagCategoryLinked(tag, categoryId, checkbox.checked);
          renderRows();
        });
        label.appendChild(checkbox);
        const dot = el('span', { class: 'wbSidebarNativeTagDot', 'aria-hidden': 'true' });
        dot.style.setProperty('--tag-color', tag.color || tagColorFor(tag.id));
        label.appendChild(dot);
        label.appendChild(el('span', { class: 'wbSidebarNativeTagName' }, tag.label));
        label.appendChild(el('span', { class: 'wbSidebarNativeTagCount' }, formatNumber(tag.count || 0)));
        list.appendChild(label);
      });
    };

    const addTypedTag = () => {
      const label = String(input.value || '').trim();
      if (!label) return;
      const tag = { id: normalizeTagKey(label), label, color: tagColorFor(label) };
      if (!tag.id) return;
      setTagCategoryLinked(tag, categoryId, true);
      input.value = '';
      renderRows();
    };
    input.addEventListener('input', renderRows);
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        addTypedTag();
      }
    });
    add.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      addTypedTag();
    });
    section.appendChild(row);
    section.appendChild(summary);
    section.appendChild(list);
    renderRows();
    return section;
  }

  function makeMenuAction(label, iconSvg, onClick, opts = {}) {
    const btn = el('button', {
      class: `wbSidebarNativeAction${opts.danger ? ' is-danger' : ''}${opts.disabled ? ' is-disabled' : ''}`,
      type: 'button',
      role: 'menuitem',
      disabled: opts.disabled ? 'disabled' : null,
      title: opts.title || label,
    });
    const icon = el('span', { class: 'wbSidebarNativeActionIcon', 'aria-hidden': 'true' });
    icon.innerHTML = iconSvg || '';
    btn.appendChild(icon);
    btn.appendChild(el('span', {}, label));
    if (!opts.disabled) {
      btn.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        if (!opts.keepOpen) closeRowMenu();
        try { onClick?.(); } catch (e) { err(`menuAction:${label}`, e); }
      });
    }
    return btn;
  }

  function promptRenameItem(item) {
    const kind = normalizeMenuKind(item.kind || item.section);
    const current = String(item.name || '').trim();
    const next = String(W.prompt?.(`Rename ${kind === 'categories' ? 'category' : kind === 'labels' ? 'label' : 'item'}`, current) || '').trim();
    if (!next || next === current) return false;
    // R4.5.2 — Desktop routes category rename through OrganizationModals →
    // H2O.Studio.actions.categories.rename. `next` is already collected
    // above, so we pass it through and the modal won't re-prompt. MV3
    // falls through to the existing archiveBoot / ChatList ladder.
    if (kind === 'categories') {
      try {
        var modalsCR = (W.H2O && W.H2O.Studio && W.H2O.Studio.OrganizationModals) || null;
        if (modalsCR && typeof modalsCR.openCategoryEditor === 'function') {
          modalsCR.openCategoryEditor({ categoryId: item.id, mode: 'rename', name: next })
            .then((res) => {
              if (res && res.ok) {
                emitLibraryAppearanceChanged({ action: 'rename-category', categoryId: item.id });
              }
              // actions.categories.rename already dispatched the canonical
              // refresh event; renderAllSections is still useful for the
              // sidebar's local row state.
              renderAllSections();
            })
            .catch((e) => err('openCategoryEditor.rename', e));
          return true;
        }
      } catch (e) { err('openCategoryEditor.rename.guard', e); }
    }
    if (kind === 'categories' && typeof H2O.archiveBoot?.renameCategory === 'function') {
      H2O.archiveBoot.renameCategory(item.id, next);
      emitLibraryAppearanceChanged({ action: 'rename-category', categoryId: item.id });
      renderAllSections();
      return true;
    }
    if (kind === 'categories' && typeof getChatListSvc()?.renameCategory === 'function') {
      Promise.resolve(getChatListSvc().renameCategory(item.id, next)).then(() => {
        try { H2O.Library?.Categories?.refresh?.(); } catch {}
        emitLibraryAppearanceChanged({ action: 'rename-category', categoryId: item.id });
        renderAllSections();
      }).catch((e) => err('renameCategory', e));
      return true;
    }
    // R4.5.3 — Desktop routes label rename through OrganizationModals →
    // H2O.Studio.actions.labels.rename. `next` is already collected so
    // no re-prompt happens. MV3 falls through to the existing
    // H2O.Labels.renameLabel ladder UNCHANGED.
    if (kind === 'labels') {
      try {
        var modalsLR = (W.H2O && W.H2O.Studio && W.H2O.Studio.OrganizationModals) || null;
        if (modalsLR && typeof modalsLR.openLabelEditor === 'function') {
          modalsLR.openLabelEditor({ labelId: item.id, mode: 'rename', name: next })
            .then((res) => {
              if (res && res.ok) {
                emitLibraryAppearanceChanged({ action: 'rename-label', labelId: item.id });
              }
              renderAllSections();
            })
            .catch((e) => err('openLabelEditor.rename', e));
          return true;
        }
      } catch (e) { err('openLabelEditor.rename.guard', e); }
    }
    if (kind === 'labels' && typeof H2O.Labels?.renameLabel === 'function') {
      H2O.Labels.renameLabel(item.type || 'custom', item.id, next);
      emitLibraryAppearanceChanged({ action: 'rename-label', labelId: item.id });
      renderAllSections();
      return true;
    }
    if (kind === 'folders' || kind === 'labels' || kind === 'projects') {
      writeLocalRowAppearance(item, { name: next });
      return true;
    }
    return false;
  }

  function deleteMenuItem(item) {
    const kind = normalizeMenuKind(item.kind || item.section);
    const name = String(item.name || item.id || 'item');
    // R4.5.2 — Desktop routes category delete through OrganizationModals,
    // which runs its OWN enriched window.confirm (category name + bound
    // chat count from LibraryIndex.facets().byCategory). We skip the
    // S0Z1g basic confirm entirely on Desktop to avoid double-prompting.
    if (kind === 'categories') {
      try {
        var modalsCD = (W.H2O && W.H2O.Studio && W.H2O.Studio.OrganizationModals) || null;
        if (modalsCD && typeof modalsCD.openCategoryEditor === 'function') {
          modalsCD.openCategoryEditor({ categoryId: item.id, mode: 'delete' })
            .then((res) => {
              if (res && res.ok) {
                emitLibraryAppearanceChanged({ action: 'delete-category', categoryId: item.id });
                renderAllSections();
              }
            })
            .catch((e) => err('openCategoryEditor.delete', e));
          return true;
        }
      } catch (e) { err('openCategoryEditor.delete.guard', e); }
    }
    // R4.5.3 — Desktop routes label delete through OrganizationModals,
    // which runs its OWN enriched window.confirm (label name + bound
    // chat count from LibraryIndex.facets().byLabel). We skip the
    // S0Z1g basic confirm to avoid double-prompting.
    if (kind === 'labels') {
      try {
        var modalsLD = (W.H2O && W.H2O.Studio && W.H2O.Studio.OrganizationModals) || null;
        if (modalsLD && typeof modalsLD.openLabelEditor === 'function') {
          modalsLD.openLabelEditor({ labelId: item.id, mode: 'delete' })
            .then((res) => {
              if (res && res.ok) {
                emitLibraryAppearanceChanged({ action: 'delete-label', labelId: item.id });
                renderAllSections();
              }
            })
            .catch((e) => err('openLabelEditor.delete', e));
          return true;
        }
      } catch (e) { err('openLabelEditor.delete.guard', e); }
    }
    const ok = W.confirm?.(`Delete ${kind === 'categories' ? 'category' : kind === 'labels' ? 'label' : 'item'} "${name}"?`);
    if (!ok) return false;
    if (kind === 'categories' && typeof H2O.archiveBoot?.deleteCategory === 'function') {
      H2O.archiveBoot.deleteCategory(item.id);
      emitLibraryAppearanceChanged({ action: 'delete-category', categoryId: item.id });
      renderAllSections();
      return true;
    }
    if (kind === 'categories' && typeof getChatListSvc()?.deleteCategory === 'function') {
      Promise.resolve(getChatListSvc().deleteCategory(item.id)).then(() => {
        try { H2O.Library?.Categories?.refresh?.(); } catch {}
        emitLibraryAppearanceChanged({ action: 'delete-category', categoryId: item.id });
        renderAllSections();
      }).catch((e) => err('deleteCategory', e));
      return true;
    }
    if (kind === 'labels' && typeof H2O.Labels?.deleteLabel === 'function') {
      H2O.Labels.deleteLabel(item.type || 'custom', item.id);
      emitLibraryAppearanceChanged({ action: 'delete-label', labelId: item.id });
      renderAllSections();
      return true;
    }
    if (kind === 'folders' || kind === 'labels' || kind === 'projects') {
      writeLocalRowAppearance(item, { hidden: true });
      return true;
    }
    return false;
  }

  function openFolderCreatePanel(anchorEl) {
    if (!anchorEl || !canRequestCanonicalFolderCreate()) return null;
    closeRowMenu();
    anchorEl.setAttribute('aria-expanded', 'true');
    const pop = el('div', {
      class: 'wbSidebarNativeMenu wbSidebarNativeMenu--folder',
      role: 'dialog',
      'aria-label': 'Create folder',
      'data-kind': 'folders',
      'data-h2o-glass': 'panel',
      'data-h2o-skin': 'sand-glass',
      'data-h2o-skin-surface': 'sand-glass',
    });
    pop.appendChild(el('div', { class: 'wbSidebarNativeMenuTitle' }, 'Create folder'));

    const panel = el('div', {
      class: 'wbSidebarNativePickerSection',
      style: 'display:flex;flex-direction:column;gap:7px;min-width:240px;max-width:320px',
      'data-menu-item': 'canonical-folder-create-panel',
    });
    panel.appendChild(el('div', { class: 'wbSidebarNativePickerLabel' }, 'New folder'));
    const input = el('input', {
      type: 'text',
      autocomplete: 'off',
      spellcheck: 'false',
      placeholder: 'Folder name',
      'aria-label': 'Folder name',
      style: 'width:100%;box-sizing:border-box;border:1px solid rgba(255,255,255,.12);border-radius:8px;background:rgba(0,0,0,.22);color:rgba(255,255,255,.92);padding:7px 8px;font-size:11px;line-height:1.3;outline:none',
    });
    const status = el('div', {
      class: 'wbSidebarNativePickerStatus',
      role: 'status',
      'aria-live': 'polite',
      style: 'display:none;font-size:10.5px;line-height:1.35;color:rgba(255,255,255,.62)',
    });
    const setStatus = (message, kind = '') => {
      const text = String(message || '');
      status.textContent = text;
      status.dataset.kind = String(kind || '');
      status.style.display = text ? 'block' : 'none';
    };
    const buttonRow = el('div', { style: 'display:flex;justify-content:flex-end;gap:6px' });
    const cancel = el('button', {
      type: 'button',
      class: 'wbSidebarNativeAction',
      style: 'padding:6px 8px;font-size:11px;min-height:28px',
    }, 'Cancel');
    const submit = el('button', {
      type: 'button',
      class: 'wbSidebarNativeAction',
      style: 'padding:6px 8px;font-size:11px;min-height:28px',
    }, 'Create');
    buttonRow.appendChild(cancel);
    buttonRow.appendChild(submit);
    panel.appendChild(input);
    panel.appendChild(status);
    panel.appendChild(buttonRow);
    pop.appendChild(panel);

    let pending = false;
    const syncSubmit = () => {
      submit.disabled = pending || !normalizeFolderCreateInput(input.value);
    };
    const submitCreate = () => {
      if (pending || submit.disabled) return;
      pending = true;
      syncSubmit();
      Promise.resolve(requestCanonicalFolderCreate(input.value, { setStatus }))
        .then((result) => {
          pending = false;
          syncSubmit();
          if (result?.ok && result.applied === true) {
            input.value = '';
            syncSubmit();
            W.setTimeout(() => closeRowMenu(), 650);
            return;
          }
          try { positionRowMenu(pop, anchorEl); } catch {}
        })
        .catch((e) => {
          pending = false;
          err('folderCreate.panel', e);
          setStatus(`Blocked: ${String(e?.message || e || 'folder-create-failed')}`, 'blocked');
          syncSubmit();
          try { positionRowMenu(pop, anchorEl); } catch {}
        });
    };
    input.addEventListener('input', syncSubmit);
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') {
        ev.preventDefault();
        if (!pending) closeRowMenu();
        return;
      }
      if (ev.key === 'Enter') {
        ev.preventDefault();
        submitCreate();
      }
    });
    cancel.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      if (!pending) closeRowMenu();
    });
    submit.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      submitCreate();
    });
    syncSubmit();

    D.body.appendChild(pop);
    activeRowMenu = pop;
    const updatePosition = () => positionRowMenu(pop, anchorEl);
    updatePosition();
    requestAnimationFrame(updatePosition);
    W.addEventListener('resize', updatePosition, true);
    W.addEventListener('scroll', updatePosition, true);
    let ro = null;
    try {
      ro = new ResizeObserver(updatePosition);
      ro.observe(pop);
    } catch {}
    const onDoc = (ev) => {
      if (!pop.contains(ev.target) && ev.target !== anchorEl && !anchorEl.contains?.(ev.target)) closeRowMenu();
    };
    const onKey = (ev) => {
      if (ev.key === 'Escape' && !pending) closeRowMenu();
    };
    setTimeout(() => D.addEventListener('mousedown', onDoc, true), 0);
    D.addEventListener('keydown', onKey, true);
    activeRowMenuOff = () => {
      W.removeEventListener('resize', updatePosition, true);
      W.removeEventListener('scroll', updatePosition, true);
      D.removeEventListener('mousedown', onDoc, true);
      D.removeEventListener('keydown', onKey, true);
      try { ro?.disconnect?.(); } catch {}
    };
    W.setTimeout(() => {
      try { input.focus(); } catch {}
    }, 0);
    return pop;
  }

  function openRowMenu(anchorEl, rawItem = {}) {
    if (!anchorEl) return null;
    const item = {
      ...rawItem,
      id: String(rawItem.id || rawItem.folderId || rawItem.categoryId || rawItem.labelId || '').trim(),
      name: String(rawItem.name || rawItem.label || rawItem.title || '').trim(),
      kind: normalizeMenuKind(rawItem.kind || rawItem.section || rawItem.type || ''),
    };
    const isFolderMenu = item.kind === 'folders';
    const isCategoryMenu = item.kind === 'categories';
    if (!item.id || (!isFolderMenu && !isCategoryMenu)) return null;
    closeRowMenu();
    anchorEl.setAttribute('aria-expanded', 'true');
    const pop = el('div', {
      class: `wbSidebarNativeMenu${isFolderMenu ? ' wbSidebarNativeMenu--folder' : ''}`,
      role: 'menu',
      'data-kind': item.kind,
      'data-h2o-glass': 'panel',
      'data-h2o-skin': 'sand-glass',
      'data-h2o-skin-surface': 'sand-glass',
    });
    pop.appendChild(el('div', { class: 'wbSidebarNativeMenuTitle' }, menuTitleForKind(item.kind)));

    const appearance = getRowAppearance(item);
    const color = normalizeHexColor(appearance.color || item.color || item.iconColor || '') || (item.kind === 'categories' ? categoryAppearance(item).color : '');
    if (isFolderMenu) {
      const isCanonicalFolder = item.isCanonical === true;
      const deleteTitle = 'Preview canonical folder delete through Native owner.';
      const hasFolderRoute = !!folderHrefForId(item.id);
      pop.appendChild(makeMenuAction('Open folder', SIDEBAR_MENU_ACTION_SVGS.open, () => openFolderRoute(item.id), {
        disabled: !hasFolderRoute,
        title: hasFolderRoute ? 'Open folder' : 'Folder route unavailable',
      }));
      pop.appendChild(makeMenuAction('Open in Studio', SIDEBAR_MENU_ACTION_SVGS.studio, () => openFolderRoute(item.id), {
        disabled: !hasFolderRoute,
        title: hasFolderRoute ? 'Open this folder in Studio' : 'Folder route unavailable',
      }));
      pop.appendChild(el('div', { class: 'wbSidebarNativeSep', role: 'separator' }));
      if (isCanonicalFolder) {
        if (canRequestCanonicalFolderColor(item)) {
          makeCanonicalFolderColorPicker(item, color, pop, anchorEl).forEach((node) => pop.appendChild(node));
        } else {
          pop.appendChild(makeMenuAction('Change color', SIDEBAR_MENU_ACTION_SVGS.palette, null, {
            disabled: true,
            title: studioPlatformAdapter() === 'mv3' ? 'Native owner bridge unavailable.' : 'Desktop folder editor unavailable.',
          }));
        }
      } else {
        pop.appendChild(makeMenuColorPicker(item, color));
      }
      if (isCanonicalFolder && canRequestCanonicalFolderRename(item)) {
        makeCanonicalFolderRenamePanel(item, pop, anchorEl).forEach((node) => pop.appendChild(node));
      } else {
        pop.appendChild(makeMenuAction('Rename folder', SIDEBAR_MENU_ACTION_SVGS.rename, null, {
          disabled: true,
          title: isCanonicalFolder && studioPlatformAdapter() === 'mv3' ? 'Native owner bridge unavailable.' : 'Desktop folder editor unavailable.',
        }));
      }
      if (studioIsTauri()) {
        makeDesktopFolderSoftDeletePanel(item, pop, anchorEl).forEach((node) => pop.appendChild(node));
      } else if (studioPlatformAdapter() === 'mv3') {
        makeChromeFolderDeleteRequestPanel(item, pop, anchorEl).forEach((node) => pop.appendChild(node));
      } else if (folderDestructiveActionsEnabled()) {
        if (isCanonicalFolder && canRequestCanonicalFolderDeletePreview(item)) {
          makeCanonicalFolderDeletePreviewPanel(item, pop, anchorEl).forEach((node) => pop.appendChild(node));
        } else {
          pop.appendChild(makeMenuAction('Delete folder', SIDEBAR_MENU_ACTION_SVGS.delete, null, {
            danger: true,
            disabled: true,
            title: isCanonicalFolder && studioPlatformAdapter() === 'mv3' ? 'Native owner bridge unavailable.' : deleteTitle,
          }));
        }
      }
      if (folderSidebarDebugDetailsVisible()) {
        pop.appendChild(el('div', { class: 'wbSidebarNativeSep', role: 'separator' }));
        pop.appendChild(makeMenuAction('Copy folder ID', SIDEBAR_MENU_ACTION_SVGS.copy, () => copyTextValue(item.id), {
          title: 'Copy folder ID',
        }));
      }
    } else if (isCategoryMenu) {
      pop.appendChild(makeMenuColorPicker(item, color));
      pop.appendChild(makeMenuIconPicker(item, item.iconKey || appearance.icon || defaultIconForKind(item.kind)));
      pop.appendChild(el('div', { class: 'wbSidebarNativeSep', role: 'separator' }));
      pop.appendChild(makeCategoryTagsPicker(item));
    }

    const chatList = getChatListSvc();
    const canRename = item.kind === 'categories' && (typeof H2O.archiveBoot?.renameCategory === 'function' || typeof chatList?.renameCategory === 'function');
    const canDelete = item.kind === 'categories' && (typeof H2O.archiveBoot?.deleteCategory === 'function' || typeof chatList?.deleteCategory === 'function');
    if (isCategoryMenu) {
      pop.appendChild(el('div', { class: 'wbSidebarNativeSep', role: 'separator' }));
      pop.appendChild(makeMenuAction('Rename', SIDEBAR_MENU_ACTION_SVGS.rename, () => promptRenameItem(item), {
        disabled: !canRename,
        title: canRename ? 'Rename' : 'Rename is available when the native catalog API is loaded',
      }));
      pop.appendChild(makeMenuAction('Delete', SIDEBAR_MENU_ACTION_SVGS.delete, () => deleteMenuItem(item), {
        danger: true,
        disabled: !canDelete,
        title: canDelete ? 'Delete' : 'Delete is available when the native catalog API is loaded',
      }));
    }

    D.body.appendChild(pop);
    activeRowMenu = pop;
    const updatePosition = () => positionRowMenu(pop, anchorEl);
    updatePosition();
    requestAnimationFrame(updatePosition);
    W.addEventListener('resize', updatePosition, true);
    W.addEventListener('scroll', updatePosition, true);
    let ro = null;
    try {
      ro = new ResizeObserver(updatePosition);
      ro.observe(pop);
    } catch {}
    const onDoc = (ev) => {
      if (!pop.contains(ev.target) && ev.target !== anchorEl && !anchorEl.contains?.(ev.target)) closeRowMenu();
    };
    const onKey = (ev) => {
      if (ev.key === 'Escape') closeRowMenu();
    };
    setTimeout(() => D.addEventListener('mousedown', onDoc, true), 0);
    D.addEventListener('keydown', onKey, true);
    activeRowMenuOff = () => {
      W.removeEventListener('resize', updatePosition, true);
      W.removeEventListener('scroll', updatePosition, true);
      D.removeEventListener('mousedown', onDoc, true);
      D.removeEventListener('keydown', onKey, true);
      try { ro?.disconnect?.(); } catch {}
    };
    return pop;
  }

  function folderActionMenuItemFromButton(button) {
    if (!button) return null;
    const pageRow = button.closest?.('[data-h2o-folder-page-row="1"], .wbFolderPageRow');
    const sidebarRow = button.closest?.('.wbSidebarSectionItem--folders, [data-section="folders"]');
    const folderId = String(
      button.getAttribute?.('data-h2o-folder-id')
      || button.getAttribute?.('data-folder-id')
      || pageRow?.getAttribute?.('data-h2o-folder-id')
      || pageRow?.getAttribute?.('data-folder-id')
      || sidebarRow?.getAttribute?.('data-id')
      || sidebarRow?.getAttribute?.('data-h2o-folder-id')
      || ''
    ).trim();
    if (!folderId || folderId === FOLDER_FILTER_NONE) return null;
    const isFolderButton = !!button.closest?.('[data-h2o-folder-page-row="1"], .wbFolderPageRow')
      || String(sidebarRow?.getAttribute?.('data-section') || '').trim() === 'folders';
    if (!isFolderButton) return null;
    const canonicalRaw = String(
      button.getAttribute?.('data-h2o-folder-canonical')
      || pageRow?.getAttribute?.('data-canonical')
      || sidebarRow?.getAttribute?.('data-canonical')
      || (sidebarRow?.getAttribute?.('data-color-source') === 'canonical' ? 'true' : '')
      || ''
    ).trim().toLowerCase();
    if (canonicalRaw && canonicalRaw !== 'true') return null;
    const disabled = button.disabled === true
      || String(button.getAttribute?.('aria-disabled') || '').trim().toLowerCase() === 'true';
    if (disabled) return null;
    const rawName = String(
      button.getAttribute?.('data-h2o-folder-name')
      || pageRow?.getAttribute?.('data-h2o-folder-name')
      || sidebarRow?.getAttribute?.('data-h2o-folder-name')
      || button.getAttribute?.('aria-label')
      || pageRow?.getAttribute?.('title')
      || sidebarRow?.getAttribute?.('aria-label')
      || sidebarRow?.getAttribute?.('title')
      || ''
    ).trim();
    const name = rawName
      .replace(/^More options for\s+/i, '')
      .split(' — ')[0]
      .split(', ')[0]
      .trim() || folderId;
    const color = normalizeHexColor(
      button.getAttribute?.('data-h2o-folder-color')
      || pageRow?.getAttribute?.('data-color')
      || sidebarRow?.getAttribute?.('data-color')
      || ''
    );
    const attr = (key) => String(
      button.getAttribute?.(key)
      || pageRow?.getAttribute?.(key)
      || sidebarRow?.getAttribute?.(key)
      || ''
    ).trim();
    const numericAttr = (key) => {
      const raw = attr(key);
      if (!raw) return 0;
      const n = Number(raw);
      return Number.isFinite(n) ? Math.max(0, n) : 0;
    };
    const knownCount = numericAttr('data-known-count');
    const canonicalCount = numericAttr('data-canonical-count');
    const localBindingCount = numericAttr('data-local-binding-count');
    const nativeMembershipCount = numericAttr('data-native-membership-count') || canonicalCount;
    return {
      id: folderId,
      folderId,
      name,
      label: name,
      kind: 'folders',
      section: 'folders',
      color,
      iconColor: color,
      source: attr('data-h2o-folder-source'),
      stateSource: attr('data-h2o-folder-state-source'),
      sourceKind: attr('data-h2o-folder-source-kind'),
      materializedUserFolder: attr('data-h2o-folder-materialized') === 'true',
      trustedFolderDisplay: attr('data-h2o-folder-trusted') === 'true',
      protectedCanonicalFallback: attr('data-h2o-folder-protected') === 'true',
      shownInNormalMode: attr('data-h2o-folder-shown-normal') === 'true',
      count: nativeMembershipCount,
      canonicalCount,
      nativeMembershipCount,
      knownCount,
      knownStudioCount: knownCount,
      localBindingCount,
      isCanonical: true,
    };
  }

  function bindFolderActionMenuDelegation() {
    if (folderActionDelegationBound) return;
    folderActionDelegationBound = true;
    D.addEventListener('pointerdown', (ev) => {
      const button = ev.target?.closest?.('[data-h2o-folder-page-action-button="1"], .wbSidebarSectionItemMenu');
      if (!button || !folderActionMenuItemFromButton(button)) return;
      ev.preventDefault();
      ev.stopPropagation();
      try { ev.stopImmediatePropagation?.(); } catch {}
    }, true);
    D.addEventListener('click', (ev) => {
      const button = ev.target?.closest?.('[data-h2o-folder-page-action-button="1"], .wbSidebarSectionItemMenu');
      if (!button) return;
      const item = folderActionMenuItemFromButton(button);
      if (!item) return;
      ev.preventDefault();
      ev.stopPropagation();
      try { ev.stopImmediatePropagation?.(); } catch {}
      openRowMenu(button, item);
    }, true);
  }

  // ── Collapse state (persisted across sessions) ─────────────────────────────
  function loadCollapse() {
    try { return JSON.parse(W.localStorage.getItem(COLLAPSE_KEY) || '{}') || {}; }
    catch { return {}; }
  }
  function saveCollapse(state) {
    try { W.localStorage.setItem(COLLAPSE_KEY, JSON.stringify(state || {})); } catch {}
  }
  const collapseState = loadCollapse();

  function isCollapsed(key, defaultCollapsed) {
    return Object.prototype.hasOwnProperty.call(collapseState, key)
      ? !!collapseState[key]
      : !!defaultCollapsed;
  }
  function setCollapsed(key, collapsed) {
    collapseState[key] = !!collapsed;
    saveCollapse(collapseState);
  }

  // ── Section rendering ──────────────────────────────────────────────────────
  // Builds a list of `.wbSidebarSectionItem` anchors inside the given host
  // element. Each item links to a Library detail route via the route service's
  // buildLibraryHash. Caps at ITEM_LIMIT_DEFAULT visible items with a "More"
  // link to Explorer (grouped by the section's facet) when the list is longer.
  function renderSectionList(host, kind, items, opts = {}) {
    if (!host) return;
    host.innerHTML = '';
    const limit = opts.limit || ITEM_LIMIT_DEFAULT;

    if (!Array.isArray(items) || items.length === 0) {
      host.appendChild(el('div', { class: 'wbSideEmpty' }, opts.emptyText || `No ${kind} yet`));
      return;
    }

    const prepared = items.map((raw) => {
      const id = String(raw?.id || '').trim();
      const name = String(raw?.name || '').trim();
      if (!id || !name) return null;
      const appearance = kind === 'categories'
        ? getRowAppearance({ ...raw, id, name, kind, section: kind })
        : {
          name,
          color: normalizeHexColor(raw?.color || ''),
          icon: raw?.iconKey || '',
          iconSvg: raw?.iconSvg || '',
          hidden: false,
        };
      if (appearance.hidden) return null;
      return {
        ...raw,
        id,
        name: appearance.name || name,
        color: appearance.color || raw.color || '',
        iconKey: appearance.icon || raw.iconKey || '',
        iconSvg: appearance.iconSvg || raw.iconSvg || '',
        displayCountLabel: String(raw.displayCountLabel || '').trim(),
        badges: Array.isArray(raw.badges) ? raw.badges.map((badge) => String(badge || '').trim()).filter(Boolean) : [],
      };
    }).filter(Boolean);

    if (!prepared.length) {
      host.appendChild(el('div', { class: 'wbSideEmpty' }, opts.emptyText || `No ${kind} yet`));
      return;
    }

    const visible = prepared.slice(0, limit);
    const routeSvc = getRouteSvc();
    const routeKind = kind === 'labels' ? 'label'
                    : kind === 'categories' ? 'category'
                    : kind === 'projects' ? 'project'
                    : kind === 'folders' ? 'folder'
                    : kind;
    const compactSectionCounts = !opts.review && !sidebarSectionCountsVisible(kind);

    for (const item of visible) {
      const id = String(item.id || '').trim();
      const name = String(item.name || '').trim();
      if (!id || !name) continue;
      const href = String(item.href || '').trim() || routeSvc?.buildLibraryHash?.(routeKind, id) || `#/library/explorer`;
      const color = normalizeHexColor(item.color || '');
      const folderDebugDetails = kind !== 'folders' || folderSidebarDebugDetailsVisible();
      const countLabel = sidebarSectionCountValue(item);
      const hasDetailedCount = folderDebugDetails && !!String(item.displayCountLabel || '').trim();
      const countDetails = kind === 'folders' ? folderCountDetailsText(item) : countLabel;
      const showInlineCount = !!countLabel && !compactSectionCounts;
      const countPillStyle = showInlineCount
        ? 'display:block;box-sizing:border-box;min-width:0;max-width:42px;padding:0 2px;font-size:10.5px;line-height:1.2;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-align:center;align-self:center;'
        : null;
      const badges = Array.isArray(item.badges) ? item.badges.map((badge) => String(badge || '').trim()).filter(Boolean) : [];
      const deleteRequestBadge = kind === 'folders' ? folderDeleteRequestBadgeNode(item) : null;
      const title = countDetails ? `${name} — ${countDetails}` : name;
      const ariaLabel = countDetails ? `${name}, ${countDetails}` : name;
      const rowStyle = [
        color ? `--wb-sidebar-item-color:${color};` : '',
      ].filter(Boolean).join('');
      const menuButton = !opts.disableMenu && !item.disableMenu && (kind === 'categories' || kind === 'folders')
        ? el('button', {
          class: 'wbSidebarSectionItemMenu',
          type: 'button',
          title: `More options for ${name}`,
          'aria-label': `More options for ${name}`,
          'aria-haspopup': 'menu',
          'aria-expanded': 'false',
          'data-h2o-folder-id': kind === 'folders' ? id : null,
          'data-h2o-folder-name': kind === 'folders' ? name : null,
          'data-h2o-folder-canonical': kind === 'folders' && item.isCanonical === true ? 'true' : null,
          'data-h2o-folder-color': kind === 'folders' && color ? color : null,
          'data-h2o-folder-source': kind === 'folders' ? String(item.source || '').trim() : null,
          'data-h2o-folder-state-source': kind === 'folders' ? String(item.stateSource || '').trim() : null,
          'data-h2o-folder-source-kind': kind === 'folders' ? String(item.sourceKind || item.kind || '').trim() : null,
          'data-h2o-folder-materialized': kind === 'folders' && item.materializedUserFolder === true ? 'true' : null,
          'data-h2o-folder-trusted': kind === 'folders' && item.trustedFolderDisplay === true ? 'true' : null,
          'data-h2o-folder-protected': kind === 'folders' && item.protectedCanonicalFallback === true ? 'true' : null,
          'data-h2o-folder-shown-normal': kind === 'folders' && item.shownInNormalMode === true ? 'true' : null,
          'data-known-count': kind === 'folders' && item.knownCount != null ? item.knownCount : null,
          'data-canonical-count': kind === 'folders' && item.canonicalCount != null ? item.canonicalCount : null,
          'data-local-binding-count': kind === 'folders' && item.localBindingCount != null ? item.localBindingCount : null,
          'data-native-membership-count': kind === 'folders' && item.nativeMembershipCount != null ? item.nativeMembershipCount : null,
        }, '...')
        : null;
      if (menuButton) {
        menuButton.addEventListener('pointerdown', (ev) => ev.stopPropagation());
        menuButton.addEventListener('click', (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          openRowMenu(menuButton, { ...item, id, name, kind, section: kind, color });
        });
      }
      const link = el('a', {
        class: `wbSidebarSectionItem wbSidebarSectionItem--${kind}`,
        href,
        title,
        'aria-label': ariaLabel,
        'data-section': kind,
        'data-id': id,
        'data-icon': item.iconKey || '',
        'data-color': color || '',
        'data-badges': badges.length ? badges.join(',') : null,
        'data-canonical-count': item.canonicalCount != null ? item.canonicalCount : null,
        'data-known-count': item.knownCount != null ? item.knownCount : null,
        'data-local-binding-count': item.localBindingCount != null ? item.localBindingCount : null,
        'data-count-mode': compactSectionCounts ? 'compact' : (showInlineCount ? 'inline' : null),
        'data-system-row': item.isSystem === true ? 'true' : null,
        'data-color-source': item.isCanonical === true ? 'canonical' : (color ? 'local' : null),
        'data-h2o-folder-sidebar-row': kind === 'folders' ? '1' : null,
        'data-h2o-folder-id': kind === 'folders' ? id : null,
        'data-h2o-folder-name': kind === 'folders' ? name : null,
        'data-h2o-folder-canonical': kind === 'folders' && item.isCanonical === true ? 'true' : null,
        'data-h2o-folder-color': kind === 'folders' && color ? color : null,
        'data-h2o-folder-color-source': kind === 'folders' ? String(item.colorSource || '').trim() : null,
        'data-h2o-folder-source': kind === 'folders' ? String(item.source || '').trim() : null,
        'data-h2o-folder-state-source': kind === 'folders' ? String(item.stateSource || '').trim() : null,
        'data-h2o-folder-source-kind': kind === 'folders' ? String(item.sourceKind || item.kind || (item.isSystem === true ? 'system' : item.isCanonical === true ? 'canonical' : 'local')).trim() : null,
        'data-h2o-folder-materialized': kind === 'folders' && item.materializedUserFolder === true ? 'true' : null,
        'data-h2o-folder-trusted': kind === 'folders' && item.trustedFolderDisplay === true ? 'true' : null,
        'data-h2o-folder-protected': kind === 'folders' && item.protectedCanonicalFallback === true ? 'true' : null,
        'data-h2o-folder-shown-normal': kind === 'folders' && item.shownInNormalMode === true ? 'true' : null,
        'data-h2o-folder-normalized-name': kind === 'folders' ? String(item.normalizedName || name || '').trim().replace(/\s+/g, ' ').toLowerCase() : null,
        style: [
          rowStyle,
          compactSectionCounts ? 'grid-template-columns:16px minmax(0,1fr) 24px;' : '',
        ].filter(Boolean).join(''),
      }, [
        makeItemIcon(item, kind),
        opts.review ? el('span', {
          class: 'wbSidebarSectionItemLabel',
          style: 'display:flex;flex-direction:column;gap:0;min-width:0;white-space:normal;line-height:1.25',
        }, [
          el('span', { style: 'min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap' }, name),
          localReviewBadgeNodes(item),
        ]) : deleteRequestBadge ? el('span', {
          class: 'wbSidebarSectionItemLabel',
          style: 'display:flex;flex-direction:column;gap:2px;min-width:0;white-space:normal;line-height:1.25',
        }, [
          el('span', { style: 'min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap' }, name),
          deleteRequestBadge,
        ]) : el('span', { class: 'wbSidebarSectionItemLabel' }, name),
        showInlineCount ? el('span', {
          class: `wbSidebarSectionItemCount${hasDetailedCount ? ' wbSidebarSectionItemCount--folderParity' : ''}`,
          title: countDetails || (hasDetailedCount ? countLabel : null),
          'aria-label': countDetails || countLabel,
          style: countPillStyle,
        }, countLabel) : null,
        menuButton,
      ]);
      host.appendChild(link);
    }

    const forcedMoreHref = String(opts.moreHref || '').trim();
    if (forcedMoreHref || prepared.length > visible.length) {
      const moreCount = prepared.length - visible.length;
      const groupBy = kind === 'labels' ? 'label'
                    : kind === 'categories' ? 'category'
                    : kind === 'projects' ? 'project'
                    : kind === 'folders' ? 'folder'
                    : 'date';
      const moreHref = forcedMoreHref || (kind === 'folders' ? '#/library/folders' : '#/library/explorer');
      const moreText = String(opts.moreLabel || '').trim() || `More · ${formatNumber(moreCount)}`;
      const more = el('a', {
        class: 'wbSidebarSectionMore',
        href: moreHref,
        'data-groupby': groupBy,
      }, moreText);
      // Switch non-folder sections into Explorer grouping. Folders have a
      // dedicated catalog page because their native/known counts need room.
      if (kind !== 'folders') {
        more.addEventListener('click', () => {
          try {
            const prefsKey = 'h2o:prm:cgx:library-insights:studio:prefs:v2';
            const raw = W.localStorage.getItem(prefsKey);
            const prefs = raw ? JSON.parse(raw) : {};
            prefs.groupBy = groupBy;
            W.localStorage.setItem(prefsKey, JSON.stringify(prefs));
          } catch (e) { err('more.prefs', e); }
        });
      }
      host.appendChild(more);
    }
  }

  // ── Section-specific data loaders ──────────────────────────────────────────
  async function renderFolders() {
    const ws = getWorkspace();
    if (!ws) return;
    ensureFolderCreateButton();
    ensureFolderCountToggle();

    const seam = folderSidebarContribution();
    if (!seam) {
      err('renderFolders.contribution', 'h2o.studio.folder-sidebar-contribution.v1 unavailable');
      step('renderFolders.contribution', 'unavailable');
      return;
    }

    let model = null;
    try {
      model = await H2O.Library?.FolderParity?.getDisplayModel?.({ fresh: true });
    } catch (e) { err('folderParity.getDisplayModel', e); }

    const canonicalRows = Array.isArray(model?.canonicalRows) ? model.canonicalRows : [];
    const localReviewRows = Array.isArray(model?.localReviewRows) ? model.localReviewRows : [];
    const showLocalReview = folderLocalReviewUiEnabled();
    const pendingDeleteRequestIds = await loadPendingChromeFolderDeleteRequestIds();
    const chromePendingDeleteHiddenRows = await loadChromePendingDeleteHiddenRows();
    const chromePendingDeleteHiddenIds = chromePendingDeleteHiddenIdsFromRows(chromePendingDeleteHiddenRows);

    const toSidebarItem = (row, review = false) => {
      const id = String(row?.folderId || row?.id || '').trim();
      if (!id) return null;
      const name = String(row?.name || id).trim();
      const appearance = getRowAppearance({
        ...row,
        id,
        folderId: id,
        name,
        kind: 'folders',
        section: review ? 'review' : 'folders',
      });
      const nativeCount = Number(row?.nativeMembershipCount ?? row?.canonicalCount ?? 0) || 0;
      const badges = Array.isArray(row?.badges) ? row.badges.slice() : [];
      const deleteRequestPending = pendingDeleteRequestIds.has(id);
      if (deleteRequestPending && !badges.includes('delete-requested')) badges.push('delete-requested');
      return {
        ...row,
        id,
        folderId: id,
        name: appearance.name || name || id,
        label: appearance.name || name || id,
        kind: 'folders',
        section: review ? 'review' : 'folders',
        review,
        localReview: review,
        count: nativeCount,
        displayCountLabel: String(row?.displayCountLabel || '').trim(),
        canonicalCount: Number(row?.canonicalCount || 0),
        nativeMembershipCount: nativeCount,
        knownCount: Number(row?.knownCount || 0),
        knownStudioCount: Number(row?.knownStudioCount ?? row?.knownCount ?? 0),
        savedCount: Number(row?.savedCount || 0),
        linkedCount: Number(row?.linkedCount || 0),
        orphanCount: Number(row?.orphanCount || 0),
        localBindingCount: Number(row?.localBindingCount || 0),
        badges,
        deleteRequestPending,
        isCanonical: row?.isCanonical === true,
        isExtra: row?.isExtra === true,
        isTestCandidate: row?.isTestCandidate === true,
        isConflict: row?.isConflict === true,
        reviewBucket: row?.reviewBucket || null,
        source: String(row?.source || '').trim(),
        stateSource: String(row?.stateSource || '').trim(),
        sourceKind: String(row?.sourceKind || '').trim(),
        materializedUserFolder: row?.materializedUserFolder === true,
        trustedFolderDisplay: row?.trustedFolderDisplay === true,
        protectedCanonicalFallback: row?.protectedCanonicalFallback === true,
        shownInNormalMode: row?.shownInNormalMode === true,
        folderKind: String(row?.folderKind || row?.kind || '').trim(),
        href: folderHrefForId(id),
        color: row?.isCanonical === true
          ? normalizeHexColor(row?.iconColor || row?.color || '')
          : (appearance.color || normalizeHexColor(row?.color || row?.iconColor || '')),
        iconColor: row?.isCanonical === true
          ? normalizeHexColor(row?.iconColor || row?.color || '')
          : (appearance.color || normalizeHexColor(row?.color || row?.iconColor || '')),
        colorSource: String(row?.colorSource || '').trim(),
        rowColor: normalizeHexColor(row?.rowColor || ''),
        nativeColor: normalizeHexColor(row?.nativeColor || ''),
        storedColor: normalizeHexColor(row?.storedColor || ''),
        colorConflict: row?.colorConflict === true,
        normalizedName: String(row?.normalizedName || '').trim(),
        iconKey: appearance.icon || 'folder',
        iconSvg: appearance.iconSvg || SIDEBAR_ICON_SVGS.folder,
      };
    };

    const unfiled = {
      ...buildUnfiledSidebarItem(),
      kind: 'folders',
      section: 'folders',
      review: false,
      localReview: false,
    };
    const normalCanonicalRows = studioPlatformAdapter() === 'mv3'
      ? canonicalRows.filter((row) => {
        const id = String(row?.folderId || row?.id || '').trim();
        return id && !chromePendingDeleteHiddenIds.has(id) && !pendingDeleteRequestIds.has(id);
      })
      : canonicalRows;
    const canonicalItems = normalCanonicalRows
      .map((row) => toSidebarItem(row, false))
      .filter((item) => item && item.id !== FOLDER_FILTER_NONE);
    const reviewItems = showLocalReview
      ? localReviewRows.map((row) => toSidebarItem(row, true)).filter(Boolean)
      : [];
    const rows = [unfiled, ...canonicalItems, ...reviewItems];
    const actions = canonicalItems.flatMap((item) => [
      { command: 'rename', input: folderCommandPayload(item) },
      { command: 'color', input: folderCommandPayload(item) },
      { command: 'delete', input: folderCommandPayload(item) },
    ]);

    const result = seam.setContribution({ rows, actions });
    if (!result?.ok) {
      err('renderFolders.contribution', result?.status || 'contribution-rejected');
    }
    step(
      'renderFolders.contribution',
      `status=${String(result?.status || '')} canonical=${canonicalItems.length + 1} review=${reviewItems.length} actions=${actions.length} model=${model?.displayModelAvailable === true || canonicalRows.length > 0 ? 'ready' : 'fallback'}`
    );
  }

  async function renderLabels() {
    const ws = getWorkspace();
    if (!ws) return;
    const host = D.getElementById('labelList');
    if (!host) return;
    let raw = [];
    try { raw = await ws.getLabels(); } catch (e) { err('getLabels', e); }
    const idx = getIndex();
    const labelFacet = idx?.facets?.()?.byLabel || {};
    const items = (Array.isArray(raw) ? raw : []).map((lb) => {
      const id = String(lb?.id || lb?.labelId || lb?.name || '').trim();
      const name = String(lb?.name || lb?.label || lb?.labelName || id).trim();
      const facetCount = Array.isArray(labelFacet[id]) ? labelFacet[id].length : 0;
      const color = normalizeHexColor(lb?.color || lb?.labelColor || lb?.iconColor || '');
      return id ? { id, name, count: facetCount, color, iconKey: 'label', iconSvg: SIDEBAR_ICON_SVGS.label } : null;
    }).filter(Boolean);
    renderSectionList(host, 'labels', items, { emptyText: 'No labels yet' });
    // R4.5.3 — mount the Desktop label-create button. Tauri-gated; no-op on MV3.
    try { ensureLabelCreateButton(); } catch (e) { err('ensureLabelCreateButton', e); }
    try { ensureSectionCountToggle('labels'); } catch (e) { err('ensureLabelCountToggle', e); }
    // R4.5.3 — defensive: also call the tag-create-button helper.
    // It targets `.wbSidebarSection--tags`, which doesn't exist in
    // S0Z1g today (no renderTags). The helper bails on missing
    // section, so this is a no-op until a future slice adds the
    // tags sidebar section. Wiring the call here means the button
    // will auto-mount the moment a tags section appears.
    try { ensureTagCreateButton(); } catch (e) { err('ensureTagCreateButton', e); }
    step('renderLabels', String(items.length));
  }

  async function renderCategories() {
    const ws = getWorkspace();
    if (!ws) return;
    const host = D.getElementById('categoryList');
    if (!host) return;
    let raw = [];
    try { raw = await ws.getCategories(); } catch (e) { err('getCategories', e); }
    const idx = getIndex();
    const catFacet = idx?.facets?.()?.byCategory || {};
    const categoryPrefs = readNativeCategoryPrefs();
    const items = (Array.isArray(raw) ? raw : []).map((c) => {
      if (String(c?.status || '').trim().toLowerCase() === 'retired') return null;
      const id = String(c?.id || c?.categoryId || '').trim();
      const name = String(c?.name || c?.label || c?.categoryName || id).trim();
      const facetCount = Array.isArray(catFacet[id]) ? catFacet[id].length : 0;
      const appearance = categoryAppearance({ ...c, id, name }, categoryPrefs);
      return id ? { id, name, count: facetCount, color: appearance.color, iconKey: appearance.icon, iconSvg: iconSvg(appearance.icon) } : null;
    }).filter(Boolean);
    renderSectionList(host, 'categories', items, { emptyText: 'No categories yet' });
    // R4.5.2 — ensure the Desktop category-create button is mounted in
    // the categories section header. Tauri-gated through the helper —
    // returns null on MV3, leaving the section unchanged.
    try { ensureCategoryCreateButton(); } catch (e) { err('ensureCategoryCreateButton', e); }
    try { ensureSectionCountToggle('categories'); } catch (e) { err('ensureCategoryCountToggle', e); }
    step('renderCategories', String(items.length));
  }

  // R4.5.2 — small "+" button in the Categories section header that opens
  // openCategoryEditor({mode:'create'}). Mirrors ensureFolderCreateButton
  // visually but gates on Tauri presence rather than the canonical-folder-
  // create gate (Desktop categories don't need chrome.runtime).
  function ensureCategoryCreateButton() {
    const sec = D.querySelector('.wbSidebarSection--categories');
    const label = sec?.querySelector?.('.wbSideLabel');
    if (!sec || !label) return null;
    const isTauri = !!(W.__TAURI_INTERNALS__ || W.__TAURI__);
    const modalsAvail = !!(W.H2O && W.H2O.Studio && W.H2O.Studio.OrganizationModals
                           && typeof W.H2O.Studio.OrganizationModals.openCategoryEditor === 'function');
    let button = sec.querySelector('[data-h2o-category-create-button="1"]');
    if (!isTauri || !modalsAvail) {
      // Off-Desktop or modals not yet loaded: leave the section unchanged.
      try { button?.remove?.(); } catch {}
      return null;
    }
    if (button && button.parentElement !== sec) sec.insertBefore(button, label.nextSibling);
    if (!button) {
      try {
        sec.style.position = 'relative';
        label.style.paddingRight = '68px';
      } catch {}
      button = el('button', {
        class: 'wbSidebarHeaderActionButton wbSidebarCategoryCreateButton',
        type: 'button',
        title: 'Create category',
        'aria-label': 'Create category',
        'aria-haspopup': 'dialog',
        'aria-expanded': 'false',
        'data-h2o-category-create-button': '1',
        style: sidebarSectionHeaderButtonStyle(36),
      });
      button.innerHTML = SIDEBAR_MENU_ACTION_SVGS.plus;
      button.querySelectorAll('svg').forEach((svg) => {
        svg.style.width = '13px';
        svg.style.height = '13px';
      });
      button.addEventListener('pointerdown', (ev) => ev.stopPropagation());
      function openCategoryCreate() {
        try {
          var modals = (W.H2O && W.H2O.Studio && W.H2O.Studio.OrganizationModals) || null;
          if (modals && typeof modals.openCategoryEditor === 'function') {
            modals.openCategoryEditor({ mode: 'create', anchorEl: button })
              .then((res) => { if (res && res.ok) renderAllSections(); })
              .catch((e) => { try { err('openCategoryEditor.create', e); } catch (_) { /* swallow */ } });
          }
        } catch (e) { try { err('openCategoryEditor.create.guard', e); } catch (_) {} }
      }
      button.addEventListener('keydown', (ev) => {
        ev.stopPropagation();
        if (ev.key !== 'Enter' && ev.key !== ' ') return;
        ev.preventDefault();
        openCategoryCreate();
      });
      button.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        openCategoryCreate();
      });
      sec.insertBefore(button, label.nextSibling);
    }
    try {
      sec.style.position = 'relative';
      label.style.paddingRight = '68px';
      button.style.cssText = sidebarSectionHeaderButtonStyle(36);
    } catch {}
    return button;
  }

  // R4.5.3 — small "+" button in the Labels section header that opens
  // openLabelEditor({mode:'create'}). Same shape as
  // ensureCategoryCreateButton: Tauri+modals gated, no MV3 fallback.
  function ensureLabelCreateButton() {
    const sec = D.querySelector('.wbSidebarSection--labels');
    const label = sec?.querySelector?.('.wbSideLabel');
    if (!sec || !label) return null;
    const isTauri = !!(W.__TAURI_INTERNALS__ || W.__TAURI__);
    const modalsAvail = !!(W.H2O && W.H2O.Studio && W.H2O.Studio.OrganizationModals
                           && typeof W.H2O.Studio.OrganizationModals.openLabelEditor === 'function');
    let button = sec.querySelector('[data-h2o-label-create-button="1"]');
    if (!isTauri || !modalsAvail) {
      try { button?.remove?.(); } catch {}
      return null;
    }
    if (button && button.parentElement !== sec) sec.insertBefore(button, label.nextSibling);
    if (!button) {
      try {
        sec.style.position = 'relative';
        label.style.paddingRight = '68px';
      } catch {}
      button = el('button', {
        class: 'wbSidebarHeaderActionButton wbSidebarLabelCreateButton',
        type: 'button',
        title: 'Create label',
        'aria-label': 'Create label',
        'aria-haspopup': 'dialog',
        'aria-expanded': 'false',
        'data-h2o-label-create-button': '1',
        style: sidebarSectionHeaderButtonStyle(36),
      });
      button.innerHTML = SIDEBAR_MENU_ACTION_SVGS.plus;
      button.querySelectorAll('svg').forEach((svg) => {
        svg.style.width = '13px';
        svg.style.height = '13px';
      });
      button.addEventListener('pointerdown', (ev) => ev.stopPropagation());
      function openLabelCreate() {
        try {
          var modals = (W.H2O && W.H2O.Studio && W.H2O.Studio.OrganizationModals) || null;
          if (modals && typeof modals.openLabelEditor === 'function') {
            modals.openLabelEditor({ mode: 'create', anchorEl: button })
              .then((res) => { if (res && res.ok) renderAllSections(); })
              .catch((e) => { try { err('openLabelEditor.create', e); } catch (_) { /* swallow */ } });
          }
        } catch (e) { try { err('openLabelEditor.create.guard', e); } catch (_) {} }
      }
      button.addEventListener('keydown', (ev) => {
        ev.stopPropagation();
        if (ev.key !== 'Enter' && ev.key !== ' ') return;
        ev.preventDefault();
        openLabelCreate();
      });
      button.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        openLabelCreate();
      });
      sec.insertBefore(button, label.nextSibling);
    }
    try {
      sec.style.position = 'relative';
      label.style.paddingRight = '68px';
      button.style.cssText = sidebarSectionHeaderButtonStyle(36);
    } catch {}
    return button;
  }

  // R4.5.3 — small "+" button in the Tags section header that opens
  // openTagEditor({mode:'create'}). Tags have NO existing sidebar
  // section in S0Z1g today (no renderTags); this helper bails
  // gracefully when `.wbSidebarSection--tags` is absent. The moment a
  // future slice adds the tags sidebar section, this button will
  // auto-mount on the next renderAllSections() pass.
  //
  // HARD BOUNDARY: the create handler calls openTagEditor for CATALOG
  // creation only. NO turn-level tag extraction is triggered here —
  // extraction continues to flow from Native 0F5a.
  function ensureTagCreateButton() {
    const sec = D.querySelector('.wbSidebarSection--tags');
    const label = sec?.querySelector?.('.wbSideLabel');
    if (!sec || !label) return null;   // tags section not yet present
    const isTauri = !!(W.__TAURI_INTERNALS__ || W.__TAURI__);
    const modalsAvail = !!(W.H2O && W.H2O.Studio && W.H2O.Studio.OrganizationModals
                           && typeof W.H2O.Studio.OrganizationModals.openTagEditor === 'function');
    let button = sec.querySelector('[data-h2o-tag-create-button="1"]');
    if (!isTauri || !modalsAvail) {
      try { button?.remove?.(); } catch {}
      return null;
    }
    if (button && button.parentElement !== sec) sec.insertBefore(button, label.nextSibling);
    if (!button) {
      try {
        sec.style.position = 'relative';
        label.style.paddingRight = '40px';
      } catch {}
      button = el('button', {
        class: 'wbSidebarHeaderActionButton wbSidebarTagCreateButton',
        type: 'button',
        title: 'Create tag',
        'aria-label': 'Create tag',
        'aria-haspopup': 'dialog',
        'aria-expanded': 'false',
        'data-h2o-tag-create-button': '1',
        style: sidebarSectionHeaderButtonStyle(36),
      });
      button.innerHTML = SIDEBAR_MENU_ACTION_SVGS.plus;
      button.querySelectorAll('svg').forEach((svg) => {
        svg.style.width = '13px';
        svg.style.height = '13px';
      });
      button.addEventListener('pointerdown', (ev) => ev.stopPropagation());
      function openTagCreate() {
        try {
          var modals = (W.H2O && W.H2O.Studio && W.H2O.Studio.OrganizationModals) || null;
          if (modals && typeof modals.openTagEditor === 'function') {
            modals.openTagEditor({ mode: 'create', anchorEl: button })
              .then((res) => { if (res && res.ok) renderAllSections(); })
              .catch((e) => { try { err('openTagEditor.create', e); } catch (_) { /* swallow */ } });
          }
        } catch (e) { try { err('openTagEditor.create.guard', e); } catch (_) {} }
      }
      button.addEventListener('keydown', (ev) => {
        ev.stopPropagation();
        if (ev.key !== 'Enter' && ev.key !== ' ') return;
        ev.preventDefault();
        openTagCreate();
      });
      button.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        openTagCreate();
      });
      sec.insertBefore(button, label.nextSibling);
    }
    try {
      sec.style.position = 'relative';
      label.style.paddingRight = '40px';
    } catch {}
    return button;
  }

  function renderProjects() {
    const idx = getIndex();
    if (!idx) return;
    const host = D.getElementById('projectList');
    if (!host) return;
    const facet = idx.facets().byProject || {};
    const items = Object.entries(facet)
      .map(([id, ids]) => ({
        id: String(id),
        name: String(id),               // no project-name catalog in Studio today
        count: Array.isArray(ids) ? ids.length : 0,
        icon: '◧',
      }))
      .filter((p) => p.id)
      .sort((a, b) => b.count - a.count);
    renderSectionList(host, 'projects', items, { emptyText: 'No projects yet' });
    try { ensureSectionCountToggle('projects'); } catch (e) { err('ensureProjectCountToggle', e); }
    step('renderProjects', String(items.length));
  }

  // ── Collapse-toggle wiring ─────────────────────────────────────────────────
  // Click the section's label/header to toggle visibility of the body. Default
  // expanded; toggles are remembered across sessions.
  function bindCollapseToggle(sec, key, defaultCollapsed) {
    if (!sec || sec.__h2oCollapseBound) return;
    sec.__h2oCollapseBound = true;
    const label = sec.querySelector('.wbSideLabel');
    if (!label) return;

    label.style.cursor = 'pointer';
    label.setAttribute('role', 'button');
    label.setAttribute('tabindex', '0');
    label.setAttribute('aria-controls', sec.querySelector('[id$="List"]')?.id || '');

    const apply = (collapsed) => {
      sec.classList.toggle('is-collapsed', collapsed);
      label.setAttribute('aria-expanded', String(!collapsed));
    };

    apply(isCollapsed(key, defaultCollapsed));

    const toggle = () => {
      const next = !sec.classList.contains('is-collapsed');
      apply(next);
      setCollapsed(key, next);
      step('collapse-toggle', `${key}:${next}`);
    };

    label.addEventListener('click', toggle);
    label.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); toggle(); }
    });
  }

  function updateSectionCountToggleButton(button, kind = 'folders') {
    if (!button) return;
    const section = String(kind || button.dataset.h2oSectionCountToggle || 'folders').trim() || 'folders';
    const enabled = sidebarSectionCountsVisible(section);
    button.textContent = '#';
    button.title = enabled ? 'Hide counts' : 'Show counts';
    button.setAttribute('aria-pressed', String(enabled));
    button.setAttribute('aria-label', enabled ? `Hide ${section} counts` : `Show ${section} counts`);
    button.style.background = 'transparent';
    button.style.borderColor = 'transparent';
    button.style.color = enabled ? 'rgba(210,210,210,.82)' : 'rgba(145,145,145,.58)';
  }

  function ensureSectionCountToggle(kind = 'folders') {
    const section = String(kind || 'folders').trim() || 'folders';
    const sec = D.querySelector(`.wbSidebarSection--${section}`);
    const label = sec?.querySelector?.('.wbSideLabel');
    if (!sec || !label) return null;
    const hasCreateButton = !!sec.querySelector('[data-h2o-folder-create-button="1"], [data-h2o-label-create-button="1"], [data-h2o-category-create-button="1"], [data-h2o-tag-create-button="1"]');
    let button = sec.querySelector(`[data-h2o-section-count-toggle="${section}"]`);
    if (button && button.parentElement !== sec) sec.insertBefore(button, label.nextSibling);
    if (!button) {
      try {
        sec.style.position = 'relative';
        label.style.paddingRight = hasCreateButton ? '68px' : '40px';
      } catch {}
      const legacyCountClass = section === 'folders' ? ' wbSidebarFolderCountToggle' : '';
      button = el('button', {
        class: `wbSidebarHeaderActionButton wbSidebarCountToggle wbSidebar${section[0].toUpperCase()}${section.slice(1)}CountToggle${legacyCountClass}`,
        type: 'button',
        'data-h2o-section-count-toggle': section,
        style: sidebarSectionHeaderButtonStyle(8),
      });
      button.addEventListener('pointerdown', (ev) => ev.stopPropagation());
      button.addEventListener('keydown', (ev) => ev.stopPropagation());
      button.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        FOLDER_SIDEBAR_UI_STATE.showCountsBySection[section] = !sidebarSectionCountsVisible(section);
        FOLDER_SIDEBAR_UI_STATE.showFolderCountPills = sidebarSectionCountsVisible('folders');
        updateSectionCountToggleButton(button, section);
        renderAllSections();
      });
      sec.insertBefore(button, label.nextSibling);
    }
    const hasCreateButtonNow = !!sec.querySelector('[data-h2o-folder-create-button="1"], [data-h2o-label-create-button="1"], [data-h2o-category-create-button="1"], [data-h2o-tag-create-button="1"]');
    try {
      sec.style.position = 'relative';
      label.style.paddingRight = hasCreateButtonNow ? '68px' : '40px';
    } catch {}
    button.style.cssText = sidebarSectionHeaderButtonStyle(8);
    updateSectionCountToggleButton(button, section);
    return button;
  }

  function updateFolderCountToggleButton(button) {
    updateSectionCountToggleButton(button, 'folders');
  }

  function ensureFolderCountToggle() {
    return ensureSectionCountToggle('folders');
  }

  function ensureFolderCreateButton() {
    const sec = D.querySelector('.wbSidebarSection--folders');
    const label = sec?.querySelector?.('.wbSideLabel');
    if (!sec || !label) return null;
    let button = sec.querySelector('[data-h2o-folder-create-button="1"]');
    if (!canRequestCanonicalFolderCreate()) {
      try { button?.remove?.(); } catch {}
      return null;
    }
    if (button && button.parentElement !== sec) sec.insertBefore(button, label.nextSibling);
    if (!button) {
      try {
        sec.style.position = 'relative';
        label.style.paddingRight = '68px';
      } catch {}
      button = el('button', {
        class: 'wbSidebarHeaderActionButton wbSidebarFolderCreateButton',
        type: 'button',
        title: 'Create folder',
        'aria-label': 'Create folder',
        'aria-haspopup': 'dialog',
        'aria-expanded': 'false',
        'data-h2o-folder-create-button': '1',
        style: sidebarSectionHeaderButtonStyle(36),
      });
      button.innerHTML = SIDEBAR_MENU_ACTION_SVGS.plus;
      button.querySelectorAll('svg').forEach((svg) => {
        svg.style.width = '13px';
        svg.style.height = '13px';
      });
      button.addEventListener('pointerdown', (ev) => ev.stopPropagation());
      button.addEventListener('keydown', (ev) => {
        ev.stopPropagation();
        if (ev.key !== 'Enter' && ev.key !== ' ') return;
        ev.preventDefault();
        openFolderCreatePanel(button);
      });
      button.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        openFolderCreatePanel(button);
      });
      sec.insertBefore(button, label.nextSibling);
    }
    try {
      sec.style.position = 'relative';
      label.style.paddingRight = '68px';
      button.style.cssText = sidebarSectionHeaderButtonStyle(36);
    } catch {}
    return button;
  }

  // ── Re-render orchestration ────────────────────────────────────────────────
  function renderAllSections() {
    // Each loader has its own error boundary; one failure doesn't block the others.
    renderFolders().catch((e) => err('renderFolders.outer', e));
    renderLabels().catch((e) => err('renderLabels.outer', e));
    renderCategories().catch((e) => err('renderCategories.outer', e));
    try { renderProjects(); } catch (e) { err('renderProjects.outer', e); }
  }

  function bindUpdates() {
    const ws = getWorkspace();
    if (ws?.subscribe) ws.subscribe(() => { renderAllSections(); });
    // Refresh on cross-surface broadcasts so native mutations propagate here.
    W.addEventListener('evt:h2o:library:cross-surface-sync', () => renderAllSections());
    W.addEventListener('evt:h2o:folders:changed', () => renderAllSections());
    W.addEventListener('evt:h2o:labels:changed', () => renderAllSections());
    W.addEventListener('evt:h2o:studio:folder-operator-mode-changed', () => renderAllSections());
    W.addEventListener('evt:h2o:studio:appearance:changed', () => renderAllSections());
    W.addEventListener('storage', (ev) => {
      if (FOLDERS_UI_KEYS.includes(String(ev?.key || '')) || String(ev?.key || '') === FOLDER_LOCAL_REVIEW_OPERATOR_MODE_KEY) renderAllSections();
    });
    step('bindUpdates');
  }

  function diagnosticHash(value) {
    const text = String(value || '');
    if (!text) return '';
    let h = 2166136261;
    for (let i = 0; i < text.length; i += 1) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    return `h:${h.toString(16).padStart(8, '0').slice(0, 8)}`;
  }

  function normalizedDiagnosticName(value) {
    return String(value || '').trim().replace(/\s+/g, ' ').toLowerCase();
  }

  function scriptCacheBustVersion(src) {
    const value = String(src || '').trim();
    if (!value) return '';
    try {
      const url = new URL(value, W.location?.href || D.baseURI || 'http://localhost/');
      return String(url.searchParams.get('v') || '').trim();
    } catch {
      const match = value.match(/[?&]v=([^&#]+)/i);
      return match ? decodeURIComponent(match[1] || '') : '';
    }
  }

  function findStudioScriptAsset(label, containsText, expectedVersion = '') {
    const needle = String(containsText || '').trim().toLowerCase();
    const scripts = Array.from(D.querySelectorAll('script[src]') || []);
    const node = scripts.find((script) => String(script.getAttribute('src') || script.src || '').toLowerCase().includes(needle)) || null;
    const attrSrc = String(node?.getAttribute?.('src') || '').trim();
    const resolvedSrc = String(node?.src || '').trim();
    const src = resolvedSrc || attrSrc;
    const version = scriptCacheBustVersion(src || attrSrc);
    return {
      label: String(label || '').trim(),
      present: !!node,
      src: src || attrSrc,
      attrSrc,
      version,
      expectedVersion: String(expectedVersion || '').trim(),
      versionMatchesExpected: !!version && !!expectedVersion && version === String(expectedVersion),
      srcHash: diagnosticHash(src || attrSrc),
    };
  }

  function folderParityScriptAssetDiagnostics() {
    return {
      diagnosticVersion: FOLDER_SIDEBAR_ASSET_DIAGNOSTIC_VERSION,
      registeredAt: FOLDER_SIDEBAR_ASSET_DIAGNOSTIC_REGISTERED_AT,
      registrationSource: 'S0Z1g.Library Sidebar Sections',
      s0f1b: findStudioScriptAsset('S0F1b Library Workspace', 'S0F1b', '2.5.90'),
      s0z1g: findStudioScriptAsset('S0Z1g Library Sidebar Sections', 'S0Z1g', '2.5.85'),
    };
  }

  function folderParityProviderVersion(provider) {
    return String(provider?.folderParityVersion || provider?.s0f1bLoadedVersion || provider?.version || '').trim();
  }

  function folderParityProviderKeys(provider) {
    try { return Object.keys(provider || {}).map((key) => String(key || '').trim()).filter(Boolean); }
    catch { return []; }
  }

  function folderParityProviderCurrent(provider) {
    return folderParityProviderVersion(provider) === 'f19.7-folder-fallback-v2'
      && provider?.hasKnownCanonicalFallbackBuilder === true
      && typeof provider?.getDisplayModel === 'function';
  }

  function folderParityProviderStale(provider) {
    return !folderParityProviderCurrent(provider);
  }

  function candidateFolderParityProviders() {
    const out = [];
    let s0f1bProvider = null;
    try {
      s0f1bProvider = typeof H2O.Library?.getFolderParityS0F1bProvider === 'function'
        ? H2O.Library.getFolderParityS0F1bProvider()
        : null;
    } catch {}
    [
      s0f1bProvider,
      H2O.Library?.FolderParityS0F1bProvider,
      H2O.Library?.FolderParity,
      H2O.LibraryWorkspace?.folderParity,
      H2O.Library?.Workspace?.folderParity,
    ].forEach((candidate) => {
      if (!candidate || typeof candidate !== 'object' || out.includes(candidate)) return;
      out.push(candidate);
    });
    return out;
  }

  function preserveSidebarDiagnosticOnProvider(provider) {
    if (!provider || typeof provider !== 'object') return provider;
    provider.diagnoseSidebar = diagnoseFolderSidebarParity;
    provider.diagnoseSidebarVersion = FOLDER_SIDEBAR_ASSET_DIAGNOSTIC_VERSION;
    provider.diagnoseSidebarRegisteredAt = FOLDER_SIDEBAR_ASSET_DIAGNOSTIC_REGISTERED_AT;
    provider.diagnoseSidebarRegistrationSource = 'S0Z1g.Library Sidebar Sections';
    return provider;
  }

  function upgradeFolderParityProviderReference() {
    const current = H2O.Library?.FolderParity && typeof H2O.Library.FolderParity === 'object'
      ? H2O.Library.FolderParity
      : null;
    const previousProviderVersion = folderParityProviderVersion(current);
    const previousProviderKeys = folderParityProviderKeys(current);
    const providerWasStale = !!current && folderParityProviderStale(current);
    const candidate = candidateFolderParityProviders().find(folderParityProviderCurrent) || null;
    let providerUpgradeApplied = false;
    let providerReplacementApplied = false;
    let providerRegistrationError = '';
    const providerMergeDirection = 's0f1b-provider-wins-preserve-sidebar-diagnostic-only';
    const staleFieldsPreserved = false;
    let provider = current || candidate;
    try {
      if ((!current || providerWasStale) && candidate) {
        H2O.Library.FolderParity = candidate;
        provider = candidate;
        providerUpgradeApplied = true;
        providerReplacementApplied = true;
      }
      preserveSidebarDiagnosticOnProvider(provider);
    } catch (e) {
      providerRegistrationError = String(e?.message || e || 'folder parity provider sidebar upgrade failed');
    }
    return {
      provider,
      providerUpgradeApplied,
      providerReplacementApplied,
      previousProviderVersion,
      previousProviderKeys: previousProviderKeys.slice(0, 32),
      providerWasStale,
      providerRegistrationError,
      providerMergeDirection,
      staleFieldsPreserved,
    };
  }

  function folderRowSourceKind(row) {
    if (row?.isSystem === true || String(row?.id || row?.folderId || '') === FOLDER_FILTER_NONE) return 'system';
    if (row?.isCanonical === true) {
      const source = String(row?.stateSource || row?.source || '').trim().toLowerCase();
      if (source.includes('stored')) return 'canonical-stored';
      if (source.includes('native')) return 'canonical-native';
      if (source.includes('desktop') || source.includes('sqlite')) return 'canonical-desktop';
      return 'canonical';
    }
    if (row?.reviewBucket) return `review-${row.reviewBucket}`;
    const source = String(row?.source || '').trim().toLowerCase();
    if (source.includes('desktop') || source.includes('sqlite')) return 'local-desktop';
    if (source.includes('native') || source.includes('chrome')) return 'local-chrome';
    return source || 'unknown';
  }

  function folderDiagnosticToken(row, index = 0) {
    const id = String(row?.id || row?.folderId || '').trim();
    const name = String(row?.name || row?.label || row?.title || '').trim();
    const color = normalizeHexColor(row?.iconColor || row?.color || '');
    const sourceKind = folderRowSourceKind(row);
    const colorSource = String(row?.colorSource || row?.displayColorSource || '').trim() || (color ? 'unknown' : 'default');
    return {
      token: `${diagnosticHash(id)}:${normalizedDiagnosticName(name)}:${color || 'none'}:${sourceKind}:${colorSource}`,
      idHash: diagnosticHash(id),
      normalizedName: normalizedDiagnosticName(name),
      color: color || '',
      colorSource,
      rowColor: normalizeHexColor(row?.rowColor || ''),
      nativeColor: normalizeHexColor(row?.nativeColor || ''),
      storedColor: normalizeHexColor(row?.storedColor || ''),
      colorConflict: row?.colorConflict === true,
      sourceKind,
      localOnly: row?.isCanonical === true || row?.isSystem === true ? false : true,
      shownInNormalMode: !folderLocalReviewUiEnabled() ? (row?.isCanonical === true || row?.isSystem === true) : true,
      order: index,
    };
  }

  function renderedFolderSidebarTokens(modelRows = []) {
    const host = D.getElementById('folderList');
    const selector = [
      '[data-h2o-folder-sidebar-row="1"]',
      '.wbSidebarSectionItem--folders[data-section="folders"]',
      '.wbFolderItem[data-folder-id]',
    ].join(',');
    const rows = Array.from(host?.querySelectorAll?.(selector) || [])
      .filter((node, index, all) => all.indexOf(node) === index);
    const modelById = new Map((Array.isArray(modelRows) ? modelRows : []).map((row) => [
      String(row?.id || row?.folderId || '').trim(),
      row,
    ]).filter(([id]) => id));
    return rows.map((node, index) => {
      const id = String(
        node.getAttribute('data-h2o-folder-id')
        || node.getAttribute('data-id')
        || node.getAttribute('data-folder-id')
        || ''
      ).trim();
      const modelRow = modelById.get(id) || null;
      const name = String(
        node.getAttribute('data-h2o-folder-name')
        || node.querySelector('.wbSidebarSectionItemLabel')?.textContent
        || node.querySelector('.wbFolderLabel')?.textContent
        || node.getAttribute('aria-label')
        || modelRow?.name
        || ''
      ).trim();
      const color = normalizeHexColor(
        node.getAttribute('data-h2o-folder-color')
        || node.getAttribute('data-color')
        || modelRow?.iconColor
        || modelRow?.color
        || ''
      );
      const isSystem = String(node.getAttribute('data-system-row') || '') === 'true'
        || node.classList?.contains?.('wbFolderItem--unfiled')
        || id === FOLDER_FILTER_NONE;
      const isReview = node.classList?.contains?.('wbFolderItem--review') || !!node.getAttribute('data-review-bucket');
      const canonicalAttr = String(node.getAttribute('data-h2o-folder-canonical') || '').trim();
      const isCanonical = canonicalAttr
        ? canonicalAttr === 'true'
        : (!!modelRow ? modelRow.isCanonical === true : (!isSystem && !isReview));
      return folderDiagnosticToken({
        ...(modelRow || {}),
        id,
        folderId: id,
        name,
        color,
        iconColor: color,
        colorSource: node.getAttribute('data-h2o-folder-color-source') || modelRow?.colorSource || '',
        isSystem,
        isCanonical,
        reviewBucket: node.getAttribute('data-review-bucket') || modelRow?.reviewBucket || null,
      }, index);
    });
  }

  function folderActionCapabilitySummary(item = {}) {
    const canonicalItem = { ...item, isCanonical: true, kind: 'folders', section: 'folders' };
    const commandReady = !!folderCommandAuthority();
    const createDesktop = canUseDesktopFolderEditor('create');
    const renameDesktop = canUseDesktopFolderEditor('rename');
    const colorDesktop = canUseDesktopFolderEditor('color');
    const nativeRequest = !!folderMetadataOperationRequest() && studioPlatformAdapter() === 'mv3';
    return {
      create: {
        available: canRequestCanonicalFolderCreate(),
        path: nativeRequest ? 'library-folder-commands->mv3-native-owner-bridge' : (createDesktop ? 'library-folder-commands' : 'unavailable'),
        reason: canRequestCanonicalFolderCreate() ? '' : 'folder-create-handler-unavailable',
      },
      rename: {
        available: canRequestCanonicalFolderRename(canonicalItem),
        path: canRequestNativeCanonicalFolderRename(canonicalItem) ? 'library-folder-commands->mv3-native-owner-bridge' : (renameDesktop ? 'library-folder-commands' : 'unavailable'),
        reason: canRequestCanonicalFolderRename(canonicalItem) ? '' : 'folder-rename-handler-unavailable',
      },
      color: {
        available: canRequestCanonicalFolderColor(canonicalItem),
        path: canRequestNativeCanonicalFolderColor(canonicalItem) ? 'library-folder-commands->mv3-folder-mutation-resolver' : (colorDesktop ? 'library-folder-commands' : 'unavailable'),
        reason: canRequestCanonicalFolderColor(canonicalItem) ? '' : 'folder-color-handler-unavailable',
      },
      delete: {
        available: canRequestCanonicalFolderDeletePreview(canonicalItem),
        path: commandReady ? 'library-folder-commands' : 'unavailable',
        reason: folderDestructiveActionsEnabled() ? 'delete-preview-handler-unavailable' : 'folder-operator-mode-required',
      },
    };
  }

  async function diagnoseFolderSidebarParity(options = {}) {
    const opts = options && typeof options === 'object' ? options : {};
    const providerUpgrade = upgradeFolderParityProviderReference();
    const provider = providerUpgrade.provider;
    let model = null;
    try {
      model = await provider?.getDisplayModel?.({
        fresh: opts.fresh !== false,
        folderName: opts.folderName || opts.probeName || '',
      });
    } catch (e) {
      err('diagnoseFolderSidebarParity.getDisplayModel', e);
    }
    const canonicalRows = Array.isArray(model?.canonicalRows) ? model.canonicalRows : [];
    const reviewRows = Array.isArray(model?.localReviewRows) ? model.localReviewRows : [];
    const materializedUserRows = Array.isArray(model?.materializedUserFolders) ? model.materializedUserFolders : [];
    const hiddenLocalOnlyRows = Array.isArray(model?.hiddenLocalOnlyFolders) ? model.hiddenLocalOnlyFolders : [];
    const modelRows = [buildUnfiledSidebarItem(), ...canonicalRows];
    const modelTokens = modelRows.map((row, index) => folderDiagnosticToken(row, index));
    const renderedTokens = renderedFolderSidebarTokens(modelRows);
    const renderedTokenValues = renderedTokens.map((row) => row.token);
    const modelTokenValues = modelTokens.map((row) => row.token);
    const createButton = D.querySelector('[data-h2o-folder-create-button="1"]');
    const firstCanonical = canonicalRows[0] || {};
    const capabilities = folderActionCapabilitySummary(firstCanonical);
    const modelHasCanonicalFolders = canonicalRows.length > 0;
    const assetDiagnostics = folderParityScriptAssetDiagnostics();
    const finalProvider = H2O.Library?.FolderParity && typeof H2O.Library.FolderParity === 'object'
      ? H2O.Library.FolderParity
      : null;
    const finalProviderVersion = folderParityProviderVersion(finalProvider);
    const finalProviderKeys = folderParityProviderKeys(finalProvider).slice(0, 32);
    const finalProviderMarkerMissing = !folderParityProviderCurrent(finalProvider);
    const providerVersion = String(model?.folderParityVersion || finalProvider?.folderParityVersion || model?.version || finalProvider?.version || '');
    const providerMarkerMissing = !providerVersion;
    return {
      ok: modelHasCanonicalFolders
        && renderedTokenValues.join('\n') === modelTokenValues.join('\n')
        && renderedTokens.every((row) => row.localOnly !== true)
        && !folderLocalReviewUiEnabled(),
      surface: studioIsTauri() ? 'desktop-studio' : 'chrome-studio',
      operatorModeEnabled: folderOperatorModeEnabled(),
      localReviewVisible: folderLocalReviewUiEnabled(),
      folderParityVersion: providerVersion,
      s0f1bLoadedVersion: String(model?.s0f1bLoadedVersion || finalProvider?.s0f1bLoadedVersion || ''),
      diagnoseSidebarVersion: FOLDER_SIDEBAR_ASSET_DIAGNOSTIC_VERSION,
      diagnoseSidebarRegisteredAt: FOLDER_SIDEBAR_ASSET_DIAGNOSTIC_REGISTERED_AT,
      diagnoseSidebarRegistrationSource: 'S0Z1g.Library Sidebar Sections',
      folderParityScriptUrl: String(model?.scriptUrl || model?.folderParityScriptUrl || finalProvider?.folderParityScriptUrl || ''),
      folderParityProviderMarkerMissing: providerMarkerMissing,
      folderParityProviderStale: finalProviderMarkerMissing || providerMarkerMissing || (model?.hasKnownCanonicalFallbackBuilder !== true && finalProvider?.hasKnownCanonicalFallbackBuilder !== true),
      providerUpgradeApplied: providerUpgrade.providerUpgradeApplied === true || model?.providerUpgradeApplied === true,
      providerReplacementApplied: providerUpgrade.providerReplacementApplied === true || model?.providerReplacementApplied === true,
      providerMergeDirection: String(model?.providerMergeDirection || providerUpgrade.providerMergeDirection || ''),
      staleFieldsPreserved: providerUpgrade.staleFieldsPreserved === true || model?.staleFieldsPreserved === true,
      previousProviderVersion: String(model?.previousProviderVersion || providerUpgrade.previousProviderVersion || ''),
      previousProviderKeys: Array.isArray(model?.previousProviderKeys) && model.previousProviderKeys.length
        ? model.previousProviderKeys.slice(0, 32)
        : providerUpgrade.previousProviderKeys,
      providerWasStale: providerUpgrade.providerWasStale === true || model?.providerWasStale === true,
      providerRegistrationError: String(model?.providerRegistrationError || providerUpgrade.providerRegistrationError || ''),
      finalProviderVersion,
      finalProviderKeys,
      finalProviderMarkerMissing,
      folderParityProviderKeys: finalProviderKeys.slice(0, 24),
      folderParityScriptAssets: assetDiagnostics,
      s0f1bScriptTagPresent: assetDiagnostics.s0f1b.present,
      s0f1bScriptTagSrc: assetDiagnostics.s0f1b.src,
      s0f1bScriptTagVersion: assetDiagnostics.s0f1b.version,
      s0f1bScriptTagExpectedVersion: assetDiagnostics.s0f1b.expectedVersion,
      s0f1bScriptTagVersionMatchesExpected: assetDiagnostics.s0f1b.versionMatchesExpected,
      s0z1gScriptTagPresent: assetDiagnostics.s0z1g.present,
      s0z1gScriptTagSrc: assetDiagnostics.s0z1g.src,
      s0z1gScriptTagVersion: assetDiagnostics.s0z1g.version,
      s0z1gScriptTagExpectedVersion: assetDiagnostics.s0z1g.expectedVersion,
      s0z1gScriptTagVersionMatchesExpected: assetDiagnostics.s0z1g.versionMatchesExpected,
      hasKnownCanonicalFallbackBuilder: model?.hasKnownCanonicalFallbackBuilder === true || finalProvider?.hasKnownCanonicalFallbackBuilder === true,
      knownCanonicalFallbackRawCount: Number(model?.knownCanonicalFallbackRawCount || finalProvider?.knownCanonicalFallbackRawCount || 0) || 0,
      folderCatalogReady: model?.folderCatalogReady === true,
      displayModelAvailable: model?.displayModelAvailable === true || canonicalRows.length > 0,
      fallbackModelUsed: model?.fallbackModelUsed === true || model?.fallbackUsed === true,
      protectedCanonicalFallbackCount: Number(model?.protectedCanonicalFallbackCount || 0) || 0,
      protectedCanonicalFallbackSource: String(model?.protectedCanonicalFallbackSource || ''),
      fallbackBuilderError: String(model?.fallbackBuilderError || ''),
      getDisplayModelError: String(model?.getDisplayModelError || ''),
      diagnoseFolderParityThrew: model?.diagnoseFolderParityThrew === true,
      fallbackBaseBuiltBeforeAwait: model?.fallbackBaseBuiltBeforeAwait === true,
      fallbackBaseCount: Number(model?.fallbackBaseCount || 0) || 0,
      knownFallbackRawCount: Number(model?.knownFallbackRawCount || model?.knownCanonicalFallbackRawCount || 0) || 0,
      knownFallbackNormalizedCount: Number(model?.knownFallbackNormalizedCount || 0) || 0,
      knownFallbackAfterFilterCount: Number(model?.knownFallbackAfterFilterCount || 0) || 0,
      knownFallbackFinalDisplayCount: Number(model?.knownFallbackFinalDisplayCount || 0) || 0,
      knownFallbackDropReasons: Array.isArray(model?.knownFallbackDropReasons) ? model.knownFallbackDropReasons.slice(0, 12) : [],
      knownFallbackRawShapes: Array.isArray(model?.knownFallbackRawShapes) ? model.knownFallbackRawShapes.slice(0, 12) : [],
      knownFallbackRejectedRows: Array.isArray(model?.knownFallbackRejectedRows) ? model.knownFallbackRejectedRows.slice(0, 12) : [],
      knownFallbackRejectionReasons: Array.isArray(model?.knownFallbackRejectionReasons) ? model.knownFallbackRejectionReasons.slice(0, 12) : [],
      storedModelAvailable: model?.storedModelAvailable === true,
      nativeBroadcastRequired: canonicalRows.length === 0 && model?.nativeBroadcastRequired === true,
      renderBlockedReason: canonicalRows.length ? '' : String(model?.renderBlockedReason || 'folder-display-model-empty'),
      renderedSidebarFolderTokens: renderedTokens,
      canonicalFolderDisplayModelTokens: modelTokens,
      hiddenLocalReviewCount: reviewRows.length,
      userCreatedMaterializedFolderCount: Number(model?.materializedUserFolderCount || materializedUserRows.length) || 0,
      userCreatedMaterializedFolderTokens: materializedUserRows.map((row, index) => folderDiagnosticToken({ ...row, isCanonical: true }, index)),
      hiddenDynamicNativeOnlyCount: Number(model?.hiddenDynamicNativeOnlyCount || 0) || 0,
      hiddenLocalOnlyCount: Number(model?.hiddenLocalOnlyCount || hiddenLocalOnlyRows.length) || 0,
      hiddenLocalOnlyTokens: hiddenLocalOnlyRows.map((row, index) => folderDiagnosticToken(row, index)),
      folderNameProbe: model?.folderNameProbe || {},
      modelCanonicalCount: canonicalRows.length,
      renderedCanonicalCount: renderedTokens.filter((row) => row.sourceKind !== 'system').length,
      colorTokens: modelTokens.map((row) => `${row.idHash}:${row.color || 'none'}`),
      createCapabilityAvailable: capabilities.create.available,
      renameCapabilityAvailable: capabilities.rename.available,
      colorCapabilityAvailable: capabilities.color.available,
      capabilityPathUsed: {
        create: capabilities.create.path,
        rename: capabilities.rename.path,
        color: capabilities.color.path,
        delete: capabilities.delete.path,
      },
      buttonVisibilityState: {
        createButtonVisible: !!createButton && createButton.hidden !== true,
        createButtonDisabled: !!createButton && createButton.disabled === true,
      },
      menuActionState: capabilities,
      folderCreateLastResult: {
        lastEvent: FOLDER_CREATE_FLOW_STATE.lastEvent,
        lastName: FOLDER_CREATE_FLOW_STATE.lastName,
        lastStatus: FOLDER_CREATE_FLOW_STATE.lastStatus,
        lastApply: FOLDER_CREATE_FLOW_STATE.lastApply ? { ...FOLDER_CREATE_FLOW_STATE.lastApply } : null,
        lastError: FOLDER_CREATE_FLOW_STATE.lastError,
      },
      destructiveActionsOperatorOnly: !folderDestructiveActionsEnabled() && capabilities.delete.available === false,
      moreLinkHref: String(D.querySelector('#folderList .wbSidebarSectionMore')?.getAttribute('href') || ''),
      warnings: Array.isArray(model?.warnings) ? model.warnings.slice(0, 8) : [],
    };
  }

  // ── Boot ──────────────────────────────────────────────────────────────────
  function bootSections() {
    const foldersSec = D.querySelector('.wbSidebarSection--folders');
    const labelsSec  = D.querySelector('.wbSidebarSection--labels');
    const catsSec    = D.querySelector('.wbSidebarSection--categories');
    const projsSec   = D.querySelector('.wbSidebarSection--projects');

    // Folders is now collapsible too (v2.9 visual parity with Labels /
    // Categories / Projects). Folders defaults to expanded — it's the
    // most-used facet and matches the native ChatGPT sidebar default.
    // Labels and Projects collapse by default — they're often empty on a
    // fresh install. Categories defaults to expanded since users typically
    // see categories applied to their saved chats.
    if (foldersSec) bindCollapseToggle(foldersSec, 'folders',    false);
    if (labelsSec)  bindCollapseToggle(labelsSec,  'labels',     true);
    if (catsSec)    bindCollapseToggle(catsSec,    'categories', false);
    if (projsSec)   bindCollapseToggle(projsSec,   'projects',   true);
    ensureFolderCountToggle();
    ensureFolderCreateButton();
    bindFolderActionMenuDelegation();

    renderAllSections();
    bindUpdates();
    step('boot.ok');
  }

  function tryBoot(attemptsLeft = 60) {
    // Library Core + Workspace + Index are needed for full render. If they
    // aren't ready yet we retry every 100ms up to 6 seconds.
    if (getCore() && getWorkspace() && getIndex()) {
      bootSections();
      return;
    }
    if (attemptsLeft <= 0) {
      err('boot.timeout', 'gave up waiting for Library Core / Workspace / Index');
      // Still bind collapse toggles so the heading clicks at least work.
      bootSections();
      return;
    }
    W.setTimeout(() => tryBoot(attemptsLeft - 1), 100);
  }

  function registerOnCore() {
    const core = getCore();
    if (!core || typeof core.registerOwner !== 'function') return false;
    try {
      core.registerOwner('library-sidebar-sections', { surface: 'studio', version: '1.1.0' }, { replace: true });
      step('register-on-core');
      return true;
    } catch (e) { err('register-on-core', e); return false; }
  }

  if (D.readyState === 'loading') {
    D.addEventListener('DOMContentLoaded', () => { registerOnCore(); tryBoot(); }, { once: true });
  } else {
    registerOnCore();
    tryBoot();
  }

  // Public API for diagnostics
  H2O.Library.SidebarSections = {
    surface: 'studio',
    version: '1.1.0',
    refresh: renderAllSections,
    openRowMenu,
    closeRowMenu,
    renderRecentlyDeletedFoldersPanel,
    renderChromeRecentlyDeletedCompanionPanel,
    renderRecentlyDeletedFoldersSidebarEntry,
    getRowAppearance,
    setCollapsed,
    diagnose() {
      return {
        surface: 'studio',
        version: '1.1.0',
        folderCommandContract: FOLDER_COMMAND_CONTRACT,
        folderCommandOwner: FOLDER_COMMAND_OWNER,
        folderContributionContract: FOLDER_CONTRIBUTION_CONTRACT,
        folderContributionOwner: FOLDER_CONTRIBUTION_OWNER,
        contributionReady: !!folderSidebarContribution(),
        labelsRendered:    D.getElementById('labelList')?.children.length || 0,
        categoriesRendered: D.getElementById('categoryList')?.children.length || 0,
        projectsRendered:  D.getElementById('projectList')?.children.length || 0,
        collapseState: { ...collapseState },
        folderSidebarUi: { ...FOLDER_SIDEBAR_UI_STATE },
        folderOperatorMode: {
          enabled: folderOperatorModeEnabled(),
          localReviewVisible: folderLocalReviewUiEnabled(),
          storageKey: FOLDER_LOCAL_REVIEW_OPERATOR_MODE_KEY,
        },
        folderCreateFlow: {
          ...FOLDER_CREATE_FLOW_STATE,
          lastPreview: FOLDER_CREATE_FLOW_STATE.lastPreview ? { ...FOLDER_CREATE_FLOW_STATE.lastPreview } : null,
          lastApply: FOLDER_CREATE_FLOW_STATE.lastApply ? { ...FOLDER_CREATE_FLOW_STATE.lastApply } : null,
        },
        steps: diag.steps.slice(-15),
        errors: diag.errors.slice(-10),
      };
    },
    diagnoseFolderSidebarParity,
    diagnoseChromeRecentlyDeletedCompanion,
  };

  try {
    const providerUpgrade = upgradeFolderParityProviderReference();
    preserveSidebarDiagnosticOnProvider(providerUpgrade.provider);
    H2O.Studio = H2O.Studio || {};
    H2O.Studio.diagnoseFolderSidebarParity = diagnoseFolderSidebarParity;
    H2O.Studio.diagnoseChromeRecentlyDeletedCompanion = diagnoseChromeRecentlyDeletedCompanion;
  } catch {}

  step('boot', 'studio-library-sidebar-sections-ready');
})();
